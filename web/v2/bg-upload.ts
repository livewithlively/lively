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
//   · 일시 오류(네트워크·5xx·시간 초과)는 두 번까지 스스로 다시 보낸다. 그래도 안 되면 따로 쥐고 [다시 시도]로 다시 줄 세운다.
//  ── «다 올렸다» 의 뜻 ──
//   대기열이 빈 것(running=false)은 «다 올렸다» 가 아니다 — 실패만 남아도 빈다. 처음 설정이 서버에 «올리기 끝» 을 알릴 때는
//   uploadVerdict 로 «실패 0 · 고른 것이 전부 올라갔다(또는 이미 올린 것)» 를 잰다(격리 리뷰 2026-10-27).
import { TOKEN_KEY, apiUrl, wsKey } from '../lib/net.js';
import { state } from '../lib/state.js';

export interface BgUploadItem { file: File; rel: string }
export interface BgUploadState {
  /** 이번 페이지에서 줄 세운 것 전부(건너뛴 것 제외). */
  total: number;
  done: number;
  failed: number;
  /** 이미 올린 것이라 건너뛴 수(다시 고른 경우). */
  skipped: number;
  /** 올라갔지만 자료로 만들지 않은 수(#5167 — 음악·영상·압축·숨김 파일 등. 서버 응답의 skipped). 파일은 폴더에 그대로 있다. */
  notSource: number;
  running: boolean;
}

/** 동시에 보내는 수. 하나씩이면 작은 파일 수천 개가 왕복 시간에 묶이고, 많이 열면 큰 파일끼리 회선을 나눠 서로 늦어진다. */
const CONCURRENCY = 3;
/** 올린 파일 표지를 남기는 자리 — 워크스페이스·사람마다 따로(다른 워크스페이스나 같은 브라우저의 다른 계정이 올린 것을 «이미 올렸다» 로 읽지 않게).
 *  사람은 부를 때 읽는다 — 모듈이 뜰 때는 아직 로그인 전일 수 있다. */
const doneKeyName = (): string => wsKey('lively-bgup-done') + ':' + String((state.me && state.me.userId) || '');
/** 일시 오류를 스스로 다시 보내는 횟수 · 한 요청의 시간 제한(걸린 연결 하나가 세 칸 중 하나를 영영 쥐지 않게). */
const AUTO_RETRY = 2;
const SEND_TIMEOUT_MS = 15 * 60_000;
/** 표지 상한 — 넘으면 오래된 것부터 버린다(다시 올려도 해가 없다 — 위 머리말). */
const DONE_CAP = 20_000;
/** 다 끝난 띠를 걷는 시간. 실패가 있으면 걷지 않는다(사람이 봐야 한다). */
const HIDE_MS = 8_000;

type Job = { file: File; rel: string; key: string; tries: number };
const queue: Job[] = [];
const failedJobs: Job[] = [];
/** waiting — 다시 보내려고 잠깐 쉬는 중인 수(그동안도 «도는 중» 이다). */
let total = 0, done = 0, skipped = 0, notSource = 0, active = 0, waiting = 0;
const listeners = new Set<(s: BgUploadState) => void>();
let idleWaiters: Array<() => void> = [];
let doneKeys: string[] | null = null;
let doneSet: Set<string> | null = null;
let doneFor = '';

const jobKey = (f: File, rel: string): string => `${rel}|${f.size}|${f.lastModified}`;

function loadDone(): Set<string> {
  const name = doneKeyName();
  if (doneSet && doneFor === name) return doneSet;
  doneFor = name;
  try { const v = JSON.parse(localStorage.getItem(name) || '[]'); doneKeys = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; }
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
  if (!saveT) saveT = setTimeout(() => { saveT = null; try { localStorage.setItem(doneFor, JSON.stringify(doneKeys)); } catch (_) { /* 꽉 참·프라이빗 */ } }, 1500);
}

export function bgUploadState(): BgUploadState {
  return { total, done, failed: failedJobs.length, skipped, notSource, running: active > 0 || queue.length > 0 || waiting > 0 };
}
/**
 * (순수) «고른 것이 다 올라갔나» — expected 는 부르는 쪽이 고른 수(새로 줄 선 것 + 이미 올려 건너뛴 것).
 *  done: 실패 0 · 더 보낼 것 없음 · 이번 페이지에서 그만큼 올라갔다(건너뜀 포함). running: 그 밖 전부 — 아직 도는 중, 실패가 남았다,
 *  또는 새로고침으로 대기열이 사라져 고른 수만큼 이 페이지가 모른다(서버는 상한 뒤 있는 것으로 시작한다).
 */
export function uploadVerdict(s: BgUploadState, expected: number): 'done' | 'running' {
  return !s.running && s.failed === 0 && expected > 0 && s.done + s.skipped >= expected ? 'done' : 'running';
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
    queue.push({ file: it.file, rel: it.rel, key, tries: 0 }); added++;
  }
  total += added; skipped += skip;
  if (added) { uploadDismissed = false; guardUnload(true); pump(); }
  emit();
  return { added, skipped: skip };
}

/** 실패한 것을 다시 줄 세운다. */
export function bgUploadRetry(): void {
  if (!failedJobs.length) return;
  for (const j of failedJobs.splice(0)) { j.tries = 0; queue.push(j); }
  uploadDismissed = false;
  guardUnload(true); pump(); emit();
}

function pump(): void {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    active++;
    void send(job).then(
      (r) => { done++; if (r.notSource) notSource++; markDone(job.key); },
      (e: SendError) => {
        //  일시 오류면 잠깐 쉬었다 뒤에 다시 세운다(두 번까지). 4xx(권한·크기·경로)는 다시 보내도 같다 — 곧바로 실패로 쥔다.
        if (e && e.transient && job.tries < AUTO_RETRY) {
          job.tries++; waiting++;
          setTimeout(() => { waiting--; queue.push(job); pump(); emit(); }, 1500 * job.tries);
        } else failedJobs.push(job);
      },
    ).finally(() => {
      active--;
      if (!bgUploadState().running) guardUnload(false);
      pump(); emit();
    });
  }
}

/** PUT 한 번. 워크스페이스는 apiUrl 이 주소에 싣는다(lvly_ws — 셀프호스트 다중 워크스페이스). */
type SendError = Error & { transient?: boolean };
const sendErr = (msg: string, transient: boolean): SendError => Object.assign(new Error(msg), { transient });
/** 한 건의 결과 — 서버가 «자료로 만들지 않았다»(skipped)고 했나(#5167). 응답을 못 읽으면 모른다(false — 세지 않는다). */
type SendResult = { notSource: boolean };
const notSourceOf = (text: string): boolean => {
  try { const j = JSON.parse(text) as { skipped?: unknown }; return typeof j?.skipped === 'string' && !!j.skipped; } catch (_) { return false; }
};
function send(job: Job): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', apiUrl('/api/ui/terminal/browse/file?root=personal&path=' + encodeURIComponent('uploads/' + job.rel)));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.timeout = SEND_TIMEOUT_MS;
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve({ notSource: notSourceOf(xhr.responseText) }) : reject(sendErr(String(xhr.status), xhr.status >= 500 || xhr.status === 429)));
    xhr.onerror = () => reject(sendErr('네트워크 오류', true));
    xhr.ontimeout = () => reject(sendErr('시간 초과', true));
    xhr.onabort = () => reject(sendErr('취소', false));
    xhr.send(job.file);
  });
}

/* ── 탭 닫기 경고 — 도는 동안만 · 브라우저에서만 ── */
let guarded = false;
const onBeforeUnload = (e: BeforeUnloadEvent): void => { e.preventDefault(); e.returnValue = ''; };
/** 데스크톱 앱 안인가(preload 의 livelyDesktop). 앱에서는 경고를 걸지 않는다 — Electron 은 beforeunload 를 물어보지 않고 **조용히** 닫기를
 *  취소해서, 트레이 [종료]·업데이트 재시작이 아무 말 없이 안 먹는 앱이 된다(#5060). 앱 창은 닫아도 숨겨질 뿐이라 올리기가 이어진다. */
const inDesktopApp = (): boolean => { try { return !!(window as unknown as { livelyDesktop?: unknown }).livelyDesktop; } catch (_) { return false; } };
function guardUnload(on: boolean): void {
  if (on && inDesktopApp()) return;
  if (on === guarded) return;
  guarded = on;
  if (on) addEventListener('beforeunload', onBeforeUnload); else removeEventListener('beforeunload', onBeforeUnload);
}

/* ── 진행 띠 — 화면 구석에 하나. 어느 화면에 있든 같은 자리다. ── */
//  (#5167) 띠는 올리기에서 끝나지 않는다 — 다 올린 뒤 «리브가 곧 시작 · 정리 중 · 승인 필요» 를 둘째 줄(setup)이 잇는다(setup-watch.ts).
//   종전엔 «다 올렸어요» 를 8초 보이고 사라져, 사람은 리브가 언제 오는지·되고 있는지 볼 길이 없었다(2026-10-30 실측).
/** 둘째 줄. key 는 단계 이름 — 사람이 [닫기]로 걷은 단계는 다시 띄우지 않고, 단계가 바뀌면(예: 정리 중 → 승인 필요) 다시 띄운다. */
export interface BgSetupLine { text: string; href?: string; label?: string; keep: boolean; key?: string }
let bar: HTMLElement | null = null;
let hideT: ReturnType<typeof setTimeout> | null = null;
let setup: BgSetupLine | null = null;
let dismissed: string | null = null;
/** 사람이 [닫기]로 걷은 «다 올렸어요» 줄 — 새로 올리기 전까지 다시 안 띄운다(둘째 줄의 숫자가 바뀔 때마다 띠가 되살아나지 않게). */
let uploadDismissed = false;
const fmt = (n: number): string => n.toLocaleString('ko-KR');
const sameLine = (a: BgSetupLine | null, b: BgSetupLine | null): boolean =>
  a === b || (!!a && !!b && a.text === b.text && a.href === b.href && a.label === b.label && a.keep === b.keep && a.key === b.key);
/** 둘째 줄을 바꾼다(null = 걷는다). keep 이면 띠를 저절로 걷지 않는다(아직 진행 중 — [닫기]는 있다). 같은 줄이면 다시 그리지 않는다(닫은 띠가 되살아나지 않게). */
export function bgSetupLine(line: BgSetupLine | null): void {
  if (sameLine(setup, line)) return;
  setup = line;
  paintBar(bgUploadState());
}
/** (순수) 올리기 줄의 문구 — 다 올렸는데 자료로 안 만든 것이 있으면 그 수와 이유를 붙인다(파일은 폴더에 그대로다). */
export function uploadLineText(s: BgUploadState): string {
  if (s.running) return `파일 올리는 중 · ${fmt(s.done)} / ${fmt(s.total)} — 이 창을 닫으면 멈춰요`;
  const head = s.failed ? `${fmt(s.done)}개를 올렸고 ${fmt(s.failed)}개는 못 올렸어요` : `파일 ${fmt(s.done)}개를 다 올렸어요`;
  return s.notSource ? `${head} · ${fmt(s.notSource)}개는 음악·영상·압축 파일 같은 것이라 자료로 만들지 않았어요(파일은 그대로 있어요)` : head;
}
function paintBar(s: BgUploadState): void {
  const hasUpload = !!(s.total || s.failed) && (s.running || !uploadDismissed);
  const showSetup = !!setup && !(setup.key && dismissed === setup.key);
  if (!hasUpload && !showSetup) { if (bar) { bar.hidden = true; bar.textContent = ''; } return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'bgup';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    document.body.append(bar);
  }
  if (hideT) { clearTimeout(hideT); hideT = null; }
  bar.hidden = false;
  bar.textContent = '';
  let lastLine: HTMLElement | null = null;
  if (hasUpload) {
    const pct = s.total ? Math.round(((s.done + s.failed) / s.total) * 100) : 100;
    const line = document.createElement('div'); line.className = 'bgup-line';
    const t = document.createElement('span'); t.className = 'bgup-text'; t.textContent = uploadLineText(s); line.append(t);
    if (!s.running && s.failed) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'bgup-btn'; b.textContent = '다시 시도';
      b.onclick = () => bgUploadRetry(); line.append(b);
    }
    bar.append(line); lastLine = line;
    if (s.running || !showSetup) {
      const track = document.createElement('div'); track.className = 'bgup-track';
      const fill = document.createElement('i'); fill.style.width = pct + '%'; track.append(fill);
      bar.append(track);
    }
  }
  if (showSetup && setup) {
    const line = document.createElement('div'); line.className = 'bgup-line bgup-setup';
    const t = document.createElement('span'); t.className = 'bgup-text'; t.textContent = setup.text; line.append(t);
    if (setup.href && setup.label) {
      const a = document.createElement('a'); a.className = 'bgup-btn'; a.href = setup.href; a.textContent = setup.label; line.append(a);
    }
    bar.append(line); lastLine = line;
  }
  //  [닫기]는 올리는 중이 아니면 늘 있다 — 정리가 몇 시간 걸려도 띠에 갇히지 않게(격리 리뷰 2026-10-30). 닫은 단계는 기억해 다시 안 띄운다.
  if (!s.running && lastLine) {
    const x = document.createElement('button'); x.type = 'button'; x.className = 'bgup-btn bgup-x'; x.textContent = '닫기';
    x.onclick = () => { if (setup && setup.key) dismissed = setup.key; uploadDismissed = true; if (bar) bar.hidden = true; };
    lastLine.append(x);
  }
  //  저절로 걷는 것은 진행 중이 아닐 때만 — 실패·자료로 안 만든 것이 있으면 사람이 읽어야 하니 걷지 않는다.
  const busy = s.running || (showSetup && !!setup && setup.keep);
  if (!busy && !s.failed && !s.notSource) {
    hideT = setTimeout(() => {
      if (bar) bar.hidden = true;
      if (setup && !setup.keep) setup = null;   // 끝난 단계의 말은 한 번만 — 나중의 다른 올리기에 따라붙지 않게
    }, HIDE_MS);
  }
}
