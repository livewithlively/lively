// v2/bg-upload.ts — 화면 어디서든 이어지는 **백그라운드 파일 올리기**(#5060).
//
//  왜 따로 있나: 처음 설정에서 파일을 고른 사람은 다 올라갈 때까지 기다리지 않고 AI 연결·외부 앱 연결로 넘어간다
//   (원준님 2026-10-27 «업로드 다 될 때까지 사용자가 기다리게 하지는 말자 — 병렬적으로 계속 업로드되고 있게»).
//   종전 올리기 루프(projects/files-upload upSend · sources.ts uploadFiles)는 그 화면 칸에 묶여 있다 — 칸이 걷히면 진행 표시도 사라진다.
//   그래서 대기열을 **모듈(페이지 수명)** 에 두고, 진행은 화면 구석의 작은 띠 하나가 보여 준다. 셸 라우터는 해시만 바꾸므로
//   처음 설정 → AI 연결 → 리브 세션으로 옮겨 가도 이 모듈은 살아 있다.
//
//  ── 어디로 올리나 ──
//   개인 폴더 uploads/ 아래(자료 화면의 [올리기]와 같은 자리 — sources.ts). PUT 한 번이면 자료(local_file)로도 등록되고(#1881),
//   첫 업로드가 꺼진 «내 컴퓨터 자료» 증류기를 만든다. 그 증류기는 리브 2턴(second-turn.ts)이 켠다.
//
//  ── 끊김 ──
//   · 탭을 닫으면 브라우저가 묻는다(beforeunload — 도는 동안만).
//   · 끊긴 뒤 같은 파일·폴더를 다시 고르면 **이미 올린 것은 건너뛴다** — 올린 파일의 표지(경로·크기·수정 시각)를 이 브라우저에 남긴다.
//     서버도 같은 경로를 덮어쓰고 자료는 좌표로 갱신하므로(mirrorSourceV6) 다시 올려도 중복은 안 생긴다 — 표지는 시간을 아끼는 것뿐이다.
//   · 실패한 것은 따로 쥐고 [다시 시도]로 다시 줄 세운다.
import { TOKEN_KEY, apiUrl, wsKey } from '../lib/net.js';

export interface BgUploadItem { file: File; rel: string }
export interface BgUploadState {
  /** 이번 페이지에서 줄 세운 것 전부(건너뛴 것 제외). */
  total: number;
  done: number;
  failed: number;
  /** 이미 올린 것이라 건너뛴 수(다시 고른 경우). */
  skipped: number;
  running: boolean;
}

/** 동시에 보내는 수. 하나씩이면 작은 파일 수천 개가 왕복 시간에 묶이고, 많이 열면 큰 파일끼리 회선을 나눠 서로 늦어진다. */
const CONCURRENCY = 3;
/** 올린 파일 표지를 남기는 자리 — 워크스페이스마다 따로(다른 워크스페이스에 올린 것을 «이미 올렸다» 로 읽지 않게). */
const DONE_KEY = wsKey('lively-bgup-done');
/** 표지 상한 — 넘으면 오래된 것부터 버린다(다시 올려도 해가 없다 — 위 머리말). */
const DONE_CAP = 20_000;
/** 다 끝난 띠를 걷는 시간. 실패가 있으면 걷지 않는다(사람이 봐야 한다). */
const HIDE_MS = 8_000;

type Job = { file: File; rel: string; key: string };
const queue: Job[] = [];
const failedJobs: Job[] = [];
let total = 0, done = 0, skipped = 0, active = 0;
const listeners = new Set<(s: BgUploadState) => void>();
let idleWaiters: Array<() => void> = [];
let doneKeys: string[] | null = null;
let doneSet: Set<string> | null = null;

const jobKey = (f: File, rel: string): string => `${rel}|${f.size}|${f.lastModified}`;

function loadDone(): Set<string> {
  if (doneSet) return doneSet;
  try { const v = JSON.parse(localStorage.getItem(DONE_KEY) || '[]'); doneKeys = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; }
  catch (_) { doneKeys = []; }
  doneSet = new Set(doneKeys);
  return doneSet;
}
let saveT: ReturnType<typeof setTimeout> | null = null;
function markDone(key: string): void {
  const set = loadDone();
  if (set.has(key)) return;
  set.add(key); doneKeys!.push(key);
  if (doneKeys!.length > DONE_CAP) { for (const k of doneKeys!.splice(0, doneKeys!.length - DONE_CAP)) set.delete(k); }
  //  파일마다 쓰면 수천 번 직렬화한다 — 잠깐 모았다가 한 번에 쓴다(창을 닫는 순간의 몇 건은 잃어도 다시 올리면 그만이다).
  if (!saveT) saveT = setTimeout(() => { saveT = null; try { localStorage.setItem(DONE_KEY, JSON.stringify(doneKeys)); } catch (_) { /* 꽉 참·프라이빗 */ } }, 1500);
}

export function bgUploadState(): BgUploadState {
  return { total, done, failed: failedJobs.length, skipped, running: active > 0 || queue.length > 0 };
}
export function bgUploadOnChange(fn: (s: BgUploadState) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
/** 대기열이 다 비면(실패 포함 — 더 보낼 게 없으면) 한 번 부른다. 지금 비어 있으면 곧바로 부른다. */
export function bgUploadWhenIdle(fn: () => void): void {
  if (!bgUploadState().running) { fn(); return; }
  idleWaiters.push(fn);
}

function emit(): void {
  const s = bgUploadState();
  for (const fn of listeners) { try { fn(s); } catch (_) { /* 듣는 쪽 오류가 올리기를 멈추지 않게 */ } }
  paintBar(s);
  if (!s.running) {
    const ws = idleWaiters; idleWaiters = [];
    for (const fn of ws) { try { fn(); } catch (_) { /* 비치명 */ } }
  }
}

/** 올릴 것을 줄 세운다. 이미 올린 것(표지)은 건너뛴다. 돌려주는 값: 새로 줄 선 수 · 건너뛴 수. */
export function bgUploadAdd(items: BgUploadItem[]): { added: number; skipped: number } {
  const set = loadDone();
  let added = 0, skip = 0;
  for (const it of items) {
    const key = jobKey(it.file, it.rel);
    if (set.has(key)) { skip++; continue; }
    queue.push({ file: it.file, rel: it.rel, key }); added++;
  }
  total += added; skipped += skip;
  if (added) { guardUnload(true); pump(); }
  emit();
  return { added, skipped: skip };
}

/** 실패한 것을 다시 줄 세운다. */
export function bgUploadRetry(): void {
  if (!failedJobs.length) return;
  queue.push(...failedJobs.splice(0));
  guardUnload(true); pump(); emit();
}

function pump(): void {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    active++;
    void send(job).then(
      () => { done++; markDone(job.key); },
      () => { failedJobs.push(job); },
    ).finally(() => {
      active--;
      if (!queue.length && !active) guardUnload(false);
      pump(); emit();
    });
  }
}

/** PUT 한 번. 워크스페이스는 apiUrl 이 주소에 싣는다(lvly_ws — 셀프호스트 다중 워크스페이스). */
function send(job: Job): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', apiUrl('/api/ui/terminal/browse/file?root=personal&path=' + encodeURIComponent('uploads/' + job.rel)));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(String(xhr.status))));
    xhr.onerror = () => reject(new Error('네트워크 오류'));
    xhr.onabort = () => reject(new Error('취소'));
    xhr.send(job.file);
  });
}

/* ── 탭 닫기 경고 — 도는 동안만 ── */
let guarded = false;
const onBeforeUnload = (e: BeforeUnloadEvent): void => { e.preventDefault(); e.returnValue = ''; };
function guardUnload(on: boolean): void {
  if (on === guarded) return;
  guarded = on;
  if (on) addEventListener('beforeunload', onBeforeUnload); else removeEventListener('beforeunload', onBeforeUnload);
}

/* ── 진행 띠 — 화면 구석에 하나. 어느 화면에 있든 같은 자리다. ── */
let bar: HTMLElement | null = null;
let hideT: ReturnType<typeof setTimeout> | null = null;
const fmt = (n: number): string => n.toLocaleString('ko-KR');
function paintBar(s: BgUploadState): void {
  if (!s.total && !s.failed) return;
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'bgup';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    document.body.append(bar);
  }
  if (hideT) { clearTimeout(hideT); hideT = null; }
  bar.hidden = false;
  const pct = s.total ? Math.round(((s.done + s.failed) / s.total) * 100) : 100;
  const msg = s.running
    ? `파일 올리는 중 · ${fmt(s.done)} / ${fmt(s.total)}`
    : s.failed ? `${fmt(s.done)}개를 올렸고 ${fmt(s.failed)}개는 못 올렸어요` : `파일 ${fmt(s.done)}개를 다 올렸어요`;
  bar.textContent = '';
  const line = document.createElement('div'); line.className = 'bgup-line';
  const t = document.createElement('span'); t.className = 'bgup-text'; t.textContent = msg; line.append(t);
  if (!s.running && s.failed) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'bgup-btn'; b.textContent = '다시 시도';
    b.onclick = () => bgUploadRetry(); line.append(b);
  }
  if (!s.running) {
    const x = document.createElement('button'); x.type = 'button'; x.className = 'bgup-btn bgup-x'; x.textContent = '닫기';
    x.onclick = () => { if (bar) bar.hidden = true; }; line.append(x);
  }
  const track = document.createElement('div'); track.className = 'bgup-track';
  const fill = document.createElement('i'); fill.style.width = pct + '%'; track.append(fill);
  bar.append(line, track);
  if (!s.running && !s.failed) hideT = setTimeout(() => { if (bar) bar.hidden = true; }, HIDE_MS);
}
