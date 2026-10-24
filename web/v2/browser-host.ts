// v2/browser-host.ts — 데스크톱 앱 화면이 **AI 의 브라우저 명령을 받아 실행하는 자리** (#4993).
//
//  게이트웨이(src/browser/relay.ts)가 SSE 로 명령을 밀면 여기서 그 세션의 탭(browser-tabs.ts)을 골라 실행하고 결과를 POST 로
//  돌려준다. AI 쪽 툴 이름과 인자 뜻은 src/capabilities/browser.ts 가 정본이다.
//
//  ⚠ 화면이 숨어도(창을 닫아 트레이로 · 최소화 · 다른 앱이 앞) **연결을 끊지 않는다.** AI 는 사람이 안 볼 때 일한다 —
//   알림 스트림(live-sync)처럼 숨으면 끊는 규칙을 여기 쓰면 창을 닫는 순간 AI 의 브라우저가 사라진다.
//   실측: 숨은 창·최소화한 창에서도 webview 의 스크린샷·클릭·입력이 된다(2026-10-25, Electron 43.8.3).
//  ⚠ 끼워 넣은 판(?embed=1)·팝아웃(?solo=1)·브라우저에서 연 웹 UI 에서는 켜지 않는다(main.ts 가 거른다).
import { TOKEN_KEY, api, apiUrl, toast } from '../core.js';
import { currentWorkspace } from '../lib/net.js';
import { parseSse, retryDelay, stableConnection } from './sse.js';
import { normWebUrl } from './web-url.js';
import {
  type BTab, aiBusy, allTabs, answerHandoff, cancelHandoff, destroyTab, ensureCapturable, ensureTab, getTab, keyOfTab, markAi,
  onTabEvent, requestHandoff, requestReveal, sessionOfKey, storedUrls, tabNoOfKey, tabVisible, tabsOfSession,
} from './browser-tabs.js';
import { type UploadFile, callSource, evalSource, pageCaretEnd, pageFill, pageHasText, pageRead, pageRefPoint, pageScrollState, pageText, pageUpload } from '../lib/browser-page.js';

/** 게이트웨이와 맞춘 규약 판(src/browser/relay.ts BROWSER_PROTOCOL). */
const PROTOCOL = 1;
/** 스크린샷 긴 변 상한 — 모델이 줄이지 않고 그대로 보는 크기(이보다 크면 비용만 들고 모델 쪽에서 다시 줄인다). */
const SHOT_MAX = 1568;
const SESSIONLESS = 'mcp';

interface Cmd { id: string; op: string; session: string | null; args: Record<string, any> }

let started = false;
let hostId = '';
let ctl: AbortController | null = null;
let tries = 0;
let retryTimer = 0;
let dead = false;
/** 세션 → AI 가 지금 쓰는 탭 열쇠(browser_tabs select·new 가 바꾼다). */
const current = new Map<string, string>();
/** 탭 → 마지막 스크린샷 배율(스크린샷 좌표 → 페이지 좌표). */
const shotScale = new Map<string, number>();
/** 탭 → 마지막으로 셸에 «보이게 해 달라» 한 시각(계속 화면을 뺏지 않게). */
const revealedAt = new Map<string, number>();

/** 셸이 부른다 — 데스크톱 앱 안의 본 창에서 한 번. */
export function startBrowserHost(): void {
  if (started) return;
  started = true;
  hostId = 'h' + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
  void connect();
  onTabEvent((ev) => { if (ev.type === 'tabs') scheduleState(); });
  window.addEventListener('focus', () => scheduleState(true));
  window.addEventListener('blur', () => scheduleState());
  document.addEventListener('visibilitychange', () => scheduleState(document.visibilityState === 'visible'));
  let lastPoke = 0;
  const poke = (): void => { const n = Date.now(); if (n - lastPoke > 15_000) { lastPoke = n; scheduleState(true); } };
  document.addEventListener('pointerdown', poke, true);
  document.addEventListener('keydown', poke, true);
}

// ── 연결 ────────────────────────────────────────────────────────────────────

function headers(): Record<string, string> {
  const h: Record<string, string> = {};
  try { const t = localStorage.getItem(TOKEN_KEY); if (t) h.Authorization = 'Bearer ' + t; } catch { /* noop */ }
  const ws = currentWorkspace();
  if (ws && ws !== 'primary') h['x-lively-workspace'] = ws;
  return h;
}

async function connect(): Promise<void> {
  if (dead || ctl) return;
  const h = headers();
  if (!h.Authorization) { scheduleRetry(); return; }   // 아직 로그인 전 — 곧 다시 본다
  const mine = new AbortController();
  ctl = mine;
  let openedAt = 0;
  try {
    const d = (window as any).livelyDesktop || {};
    const q = '?host=' + encodeURIComponent(hostId) + '&app=' + encodeURIComponent(String(d.appVersion || '')) + '&platform=' + encodeURIComponent(String(d.platform || ''));
    // apiUrl 이 프리뷰 접두사와 워크스페이스 표(lvly_ws)를 붙인다 — 쿼리를 먼저 붙여 넘겨야 '&' 로 잇는다.
    const res = await fetch(apiUrl('/api/ui/browser/host/stream' + q), {
      headers: { ...h, Accept: 'text/event-stream' }, signal: mine.signal,
    });
    if (res.status === 401) { dead = true; return; }   // 죽은 토큰 — 로그인 게이트는 api() 가 띄운다. 다시 붙어도 같은 답이다.
    if (!res.ok || !res.body) return;                   // 구 게이트웨이(404) · 재시작 중 — 백오프로 다시 두드린다
    openedAt = Date.now();
    scheduleState(true);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const out = parseSse<any>(buf);
      buf = out.rest;
      for (const ev of out.events) {
        if (ev && typeof ev.op === 'string' && typeof ev.id === 'string') void run(ev as Cmd);
        else if (ev && ev.protocol && ev.protocol !== PROTOCOL) console.warn('[browser-host] 게이트웨이 규약 판이 다르다', ev.protocol);
      }
    }
  } catch { /* 끊김·재시작·abort — 아래에서 다시 붙는다 */ }
  finally {
    if (ctl === mine) {
      ctl = null;
      if (openedAt && stableConnection(Date.now() - openedAt)) tries = 0;
      scheduleRetry();
    }
  }
}

function scheduleRetry(): void {
  if (dead || retryTimer) return;
  retryTimer = window.setTimeout(() => { retryTimer = 0; void connect(); }, retryDelay(tries++));
}

let stateTimer = 0;
let lastActive = Date.now();
function scheduleState(active = false): void {
  if (active) lastActive = Date.now();
  if (stateTimer) return;
  stateTimer = window.setTimeout(() => {
    stateTimer = 0;
    if (!ctl) return;
    const sessions = [...new Set(allTabs().map((t) => sessionOfKey(t.key)))];
    void api('/api/ui/browser/host/state', {
      method: 'POST',
      body: JSON.stringify({ host: hostId, focused: document.hasFocus() && document.visibilityState === 'visible', active_at: lastActive, sessions }),
    }).catch(() => { /* 다음 보고에서 맞는다 */ });
  }, 400);
}

async function reply(id: string, ok: boolean, payload: unknown): Promise<void> {
  const body = ok ? { host: hostId, id, ok: true, result: payload } : { host: hostId, id, ok: false, error: String(payload || '실패') };
  try { await api('/api/ui/browser/host/reply', { method: 'POST', body: JSON.stringify(body) }); }
  catch (e) {
    // 결과가 너무 크거나(413) 잠깐 끊겼다 — 실패로라도 한 번 더 알린다(AI 가 시간 초과까지 기다리지 않게).
    if (ok) { try { await api('/api/ui/browser/host/reply', { method: 'POST', body: JSON.stringify({ host: hostId, id, ok: false, error: '결과를 돌려보내지 못했습니다: ' + ((e as Error)?.message || e) }) }); } catch { /* 포기 */ } }
  }
}

/** 세션마다 명령을 한 줄로 — 같은 탭에 클릭과 스크린샷이 겹치면 순서가 뒤엉킨다.
 *  사람에게 넘기기(handoff)만 줄 밖이다 — 몇 분을 기다리는 명령이 그 세션의 다른 명령(상태 보기 등)을 막으면 안 된다. */
const queues = new Map<string, Promise<unknown>>();
async function run(cmd: Cmd): Promise<void> {
  const qk = cmd.session || SESSIONLESS;
  const prev = cmd.op === 'handoff' ? Promise.resolve() : (queues.get(qk) || Promise.resolve());
  const job = prev.catch(() => null).then(() => handle(cmd));
  if (cmd.op !== 'handoff') queues.set(qk, job);
  try { await reply(cmd.id, true, await job); }
  catch (e) { await reply(cmd.id, false, (e as Error)?.message || String(e)); }
  finally { if (queues.get(qk) === job) queues.delete(qk); }
}

// ── 명령 ────────────────────────────────────────────────────────────────────

async function handle(cmd: Cmd): Promise<unknown> {
  const S = cmd.session || SESSIONLESS;
  const a = cmd.args || {};
  switch (cmd.op) {
    case 'tabs': return opTabs(S, a);
    case 'navigate': return opNavigate(S, a);
    case 'screenshot': return withTab(S, a, false, async (t) => ({ ...summary(t), ...(await shot(t, Array.isArray(a.region) ? a.region : null)) }));
    case 'act': return opAct(S, a);
    case 'read': return withTab(S, a, false, async (t) => ({ tab: tabNoOfKey(t.key), ...(await exec(t, callSource(pageRead, { filter: a.filter || 'interactive', query: a.query || '', ref: a.ref || '', max: a.max_nodes || 400 }))) }));
    case 'fill': return withTab(S, a, false, async (t) => {
      const r = await exec(t, callSource(pageFill, String(a.ref || ''), a.value));
      if (!r?.ok) throw new Error(r?.error || '값을 넣지 못했습니다');
      return { ...summary(t), ref: a.ref, value: r.value };
    });
    case 'text': return withTab(S, a, false, async (t) => ({ tab: tabNoOfKey(t.key), ...(await exec(t, callSource(pageText, a.max_chars || 40_000))) }));
    case 'upload': return withTab(S, a, false, (t) => opUpload(t, a));
    case 'eval': return withTab(S, a, false, (t) => opEval(t, String(a.code || '')));
    case 'console': return opConsole(S, a);
    case 'handoff': return opHandoff(S, a);
    default: throw new Error('모르는 명령입니다: ' + cmd.op + ' — 데스크톱 앱 화면을 새로고침해 최신으로 맞추세요.');
  }
}

/** 이 세션의 탭을 고른다 — tab 을 주면 그 번호, 아니면 AI 가 지금 쓰는 탭 → 사람에게 보이는 탭 → 아무 탭 → 저장된 주소(dormant). */
function pickTab(S: string, tabArg: unknown, create: boolean): BTab {
  if (tabArg !== undefined && tabArg !== null && String(tabArg) !== '') {
    const key = keyOfTab(S, String(tabArg));
    const t = getTab(key) || (storedUrls()[key] ? ensureTab(key) : null);
    if (!t) throw new Error(`탭 ${tabArg} 이 없습니다 — browser_tabs 로 이 세션의 탭을 확인하세요.`);
    return t;
  }
  const cur = current.get(S);
  const ct = cur ? getTab(cur) : null;
  if (ct) return ct;
  const mine = tabsOfSession(S);
  const vis = mine.find((t) => t.mode === 'docked') || mine.sort((x, y) => Number(tabNoOfKey(x.key)) - Number(tabNoOfKey(y.key)))[0];
  if (vis) { current.set(S, vis.key); return vis; }
  const stored = Object.entries(storedUrls()).filter(([k, u]) => u && sessionOfKey(k) === S).map(([k]) => k)
    .sort((x, y) => Number(tabNoOfKey(x)) - Number(tabNoOfKey(y)))[0];
  if (stored) { const t = ensureTab(stored); current.set(S, t.key); return t; }
  if (!create) throw new Error('이 세션에 열린 브라우저 탭이 없습니다 — browser_navigate 로 주소를 먼저 여세요.');
  const t = ensureTab(S, 'about:blank');
  current.set(S, t.key);
  return t;
}

/** 탭을 골라 AI 표시를 켠 채 일을 시킨다. 사람이 [AI 멈춤]을 눌러 둔 탭이면 거절한다. */
async function withTab<T>(S: string, a: Record<string, any>, create: boolean, fn: (t: BTab) => Promise<T>): Promise<T> {
  const t = pickTab(S, a.tab, create);
  if (t.paused) throw new Error('사람이 이 탭에서 AI 조작을 멈춰 두었습니다 — 사람에게 [AI 멈춤]을 풀어 달라고 하세요.');
  markAi(t);
  revealOnce(t);
  aiBusy(t, 1);
  try {
    await within(t.ready, 15_000, '탭이 준비되지 않았습니다(15초)');
    return await fn(t);
  } finally { aiBusy(t, -1); }
}

/** 처음 쓸 때(또는 5분 만에) 셸에게 «이 세션 웹 칸을 보이게» — 사람이 AI 가 무엇을 하는지 보게. 매번 화면을 뺏지는 않는다. */
function revealOnce(t: BTab): void {
  if (t.mode === 'docked') return;
  const last = revealedAt.get(t.key) || 0;
  if (Date.now() - last < 5 * 60_000) return;
  revealedAt.set(t.key, Date.now());
  requestReveal(t);
}

function summary(t: BTab): Record<string, unknown> {
  return {
    tab: tabNoOfKey(t.key), url: t.url, title: t.title, loading: t.loading,
    visible_to_human: tabVisible(t),
    ...(t.lastError ? { error: t.lastError } : {}),
  };
}

function within<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer = 0;
  return Promise.race([p, new Promise<T>((_, rej) => { timer = window.setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(timer));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * 잠깐 기다리기 — 창이 보이면 타이머, **숨어 있으면 게스트와의 빈 왕복**으로 잰다.
 *  ⚠ 숨은 화면(트레이로 닫은 창·최소화)의 타이머는 Chromium 이 1초 단위로 묶고, 숨은 지 5분이 지나면 연달아 거는 타이머를
 *   **1분에 한 번**으로 묶는다(intensive throttling). 실측(2026-10-25): 숨긴 창에서 16ms 쉬기가 0.9초 → 끌기 한 번 11초.
 *   IPC 왕복(executeJavaScript)은 묶이지 않는다. 데스크톱 앱이 backgroundThrottling 을 끄는 판(desktop/main)부터는 이 길을 안 탄다.
 */
async function nap(t: BTab, ms: number): Promise<void> {
  if (ms <= 0) return;
  if (!document.hidden) { await sleep(ms); return; }
  const end = performance.now() + ms;
  while (performance.now() < end) {
    try { await t.view.executeJavaScript('0'); } catch { return; }
  }
}

async function exec(t: BTab, src: string, ms = 20_000): Promise<any> {
  return within(t.view.executeJavaScript(src, false), ms, `페이지가 ${Math.round(ms / 1000)}초 안에 답하지 않았습니다`);
}

/** 이동을 걸고 다 열릴 때까지(또는 한도까지) 기다린다. 한도를 넘으면 오류가 아니라 loading:true 로 돌아간다(느린 사이트). */
function loadAndWait(t: BTab, kick: () => unknown, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const v = t.view;
    let fin = false;
    let failed = '';
    let started = false;
    const done = (err?: Error): void => {
      if (fin) return;
      fin = true;
      clearTimeout(timer);
      v.removeEventListener('did-start-loading', onStart);
      v.removeEventListener('did-stop-loading', onStop);
      v.removeEventListener('did-fail-load', onFail);
      v.removeEventListener('did-navigate-in-page', onInPage);
      if (err) reject(err); else resolve();
    };
    const onStart = (): void => { started = true; };
    //  멈춘 뒤 곧바로 끝낸다 — 실패(did-fail-load)는 멈춤보다 먼저 온다. 여기 타이머를 두면 숨은 창에서 1초가 된다.
    const onStop = (): void => { queueMicrotask(() => done(failed ? new Error(failed) : undefined)); };
    const onInPage = (): void => { if (!started) setTimeout(() => { if (!started) done(); }, 400); };
    const onFail = (e: any): void => {
      if (!e || e.isMainFrame === false || e.errorCode === -3) return;
      failed = `페이지를 열지 못했습니다 — ${e.errorDescription || '오류'}(${e.errorCode}) ${e.validatedURL || ''}`;
    };
    v.addEventListener('did-start-loading', onStart);
    v.addEventListener('did-stop-loading', onStop);
    v.addEventListener('did-fail-load', onFail);
    v.addEventListener('did-navigate-in-page', onInPage);
    const timer = window.setTimeout(() => done(), ms);
    try {
      const r: any = kick();
      if (r && typeof r.catch === 'function') r.catch((e: any) => {
        const m = String(e?.message || e);
        if (/ERR_ABORTED|\(-3\)/.test(m)) return;            // 리다이렉트·덮어쓴 적재 — 오류가 아니다
        failed = failed || ('페이지를 열지 못했습니다 — ' + m);
        if (!started) done(new Error(failed));
      });
    } catch (e) { done(e as Error); }
  });
}

async function opTabs(S: string, a: Record<string, any>): Promise<unknown> {
  const action = String(a.action || 'list');
  if (action === 'new') {
    const nos = new Set<number>([...tabsOfSession(S).map((t) => Number(tabNoOfKey(t.key))),
      ...Object.keys(storedUrls()).filter((k) => sessionOfKey(k) === S).map((k) => Number(tabNoOfKey(k)))]);
    let n = 1;
    while (nos.has(n)) n++;
    const key = keyOfTab(S, n);
    const t = ensureTab(key, 'about:blank');
    current.set(S, key);
    markAi(t);
    requestReveal(t);
    revealedAt.set(key, Date.now());
    if (a.url) {
      await within(t.ready, 15_000, '새 탭이 준비되지 않았습니다(15초)');
      const u = normWebUrl(String(a.url));
      await loadAndWait(t, () => t.view.loadURL(u), 30_000);
    }
  } else if (action === 'close') {
    const key = a.tab ? keyOfTab(S, String(a.tab)) : current.get(S);
    if (!key || (!getTab(key) && !storedUrls()[key])) throw new Error('닫을 탭이 없습니다 — browser_tabs 로 탭 번호를 확인하세요.');
    destroyTab(key, true);
    if (current.get(S) === key) current.delete(S);
  } else if (action === 'select') {
    if (!a.tab) throw new Error('select 에는 tab 이 필요합니다');
    const t = pickTab(S, a.tab, false);
    current.set(S, t.key);
    markAi(t);
  }
  return listTabs(S);
}

function listTabs(S: string): Record<string, unknown> {
  const live = tabsOfSession(S);
  const keys = new Set(live.map((t) => t.key));
  const stored = storedUrls();
  const dormant = Object.keys(stored).filter((k) => stored[k] && sessionOfKey(k) === S && !keys.has(k));
  const cur = current.get(S) || '';
  const rows = [
    ...live.map((t) => ({ tab: tabNoOfKey(t.key), url: t.url, title: t.title, current: t.key === cur, open: true, visible_to_human: tabVisible(t), loading: t.loading, ...(t.paused ? { paused: true } : {}) })),
    ...dormant.map((k) => ({ tab: tabNoOfKey(k), url: stored[k], title: '', current: k === cur, open: false, visible_to_human: false, loading: false })),
  ].sort((x, y) => Number(x.tab) - Number(y.tab));
  return {
    tabs: rows,
    session_visible: live.some((t) => tabVisible(t)),
    note: rows.length ? undefined : '이 세션엔 아직 탭이 없습니다 — browser_navigate 로 열면 사람의 화면(세션 우측 사이드바 [웹])에도 뜹니다.',
  };
}

async function opNavigate(S: string, a: Record<string, any>): Promise<unknown> {
  return withTab(S, a, true, async (t) => {
    const ms = Math.max(1_000, Math.min(120_000, Number(a.timeout_ms) || 30_000));
    if (a.url) {
      const u = normWebUrl(String(a.url));
      if (!/^https?:\/\//i.test(u)) throw new Error('http(s) 주소만 열 수 있습니다: ' + a.url);
      await loadAndWait(t, () => t.view.loadURL(u), ms);
    } else if (a.action === 'back') {
      if (!t.view.canGoBack()) throw new Error('뒤로 갈 곳이 없습니다');
      await loadAndWait(t, () => t.view.goBack(), ms);
    } else if (a.action === 'forward') {
      if (!t.view.canGoForward()) throw new Error('앞으로 갈 곳이 없습니다');
      await loadAndWait(t, () => t.view.goForward(), ms);
    } else if (a.action === 'reload') {
      await loadAndWait(t, () => t.view.reload(), ms);
    }
    return summary(t);
  });
}

/**
 * 보이는 영역을 찍어 긴 변 SHOT_MAX 이하 JPEG 로. 좌표 배율을 기억해 다음 클릭 좌표를 페이지 좌표로 되돌린다.
 *  region([x0,y0,x1,y1], 직전 스크린샷 좌표)이면 그 부분만 **화면 화소 그대로** 찍는다(확대해 보기) — 좌표 배율은 바꾸지 않는다.
 */
async function shot(t: BTab, region?: unknown[] | null): Promise<{ image: { mime: string; data: string }; width: number; height: number; scale: number; region?: number[] }> {
  await ensureCapturable(t);
  const s0 = shotScale.get(t.key) || 1;
  let rect: { x: number; y: number; width: number; height: number } | null = null;
  if (region) {
    const [x0, y0, x1, y1] = region.map((n) => Number(n));
    if (![x0, y0, x1, y1].every(Number.isFinite)) throw new Error('region 은 [x0, y0, x1, y1] 숫자 넷입니다');
    rect = {
      x: Math.max(0, Math.round(Math.min(x0, x1) / s0)), y: Math.max(0, Math.round(Math.min(y0, y1) / s0)),
      width: Math.max(1, Math.round(Math.abs(x1 - x0) / s0)), height: Math.max(1, Math.round(Math.abs(y1 - y0) / s0)),
    };
  }
  const once = (): Promise<any> => within<any>(rect ? t.view.capturePage(rect) : t.view.capturePage(), 10_000, '화면을 찍지 못했습니다(10초) — 탭이 가려져 있으면 browser_read 로 읽으세요');
  if (document.hidden) {
    // 숨은 창(트레이·최소화)에선 첫 캡처가 **마지막으로 그린 프레임(옛 화면)** 을 준다 — 그 캡처가 새 프레임을 그리게 하므로
    //  한 번 버리고 다시 찍는다. 실측(2026-10-25): 숨긴 창에서 끌기 뒤 첫 캡처는 옛 자리, 둘째는 새 자리에 상자.
    try { await once(); } catch { /* 아직 그린 적 없는 탭 — 아래에서 다시 */ }
    try { await t.view.executeJavaScript('0'); } catch { /* noop */ }
  }
  let img: any;
  try { img = await once(); }
  catch {
    // UnknownVizError — 숨은 창에서 막 다시 실린 탭처럼 그린 프레임이 아직 없다. 방금의 시도가 프레임을 청했으니 한 번만 다시.
    await nap(t, 250);
    img = await once();
  }
  const size = img.getSize();
  if (!size.width || !size.height) throw new Error('찍힌 화면이 비었습니다 — region 이 화면 밖이면 고치세요');
  const dpr = window.devicePixelRatio || 1;
  //  전체: CSS 화소 기준(좌표 = 페이지 px × s) · 확대: 화면 화소 기준(레티나면 두 배 선명)
  const baseW = rect ? size.width : Math.max(1, Math.round(size.width / dpr));
  const baseH = rect ? size.height : Math.max(1, Math.round(size.height / dpr));
  const s = Math.min(1, SHOT_MAX / Math.max(baseW, baseH));
  const w = Math.max(1, Math.round(baseW * s));
  const h = Math.max(1, Math.round(baseH * s));
  const pic = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('스크린샷을 읽지 못했습니다'));
    im.src = img.toDataURL();
  });
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('스크린샷을 줄이지 못했습니다');
  // 바탕을 흰색으로 먼저 — webview 캡처는 페이지가 칠하지 않은 자리가 **투명**으로 온다(배경색 없는 페이지).
  //  브라우저는 그 자리를 흰 바탕으로 보여 주는데, 그대로 JPEG 로 바꾸면 검정이 되어 글자가 안 보인다(실측 2026-10-25).
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.drawImage(pic, 0, 0, w, h);
  const url = c.toDataURL('image/jpeg', 0.72);
  const image = { mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
  if (rect) return { image, width: w, height: h, scale: Math.round(s0 * 1000) / 1000, region: (region as unknown[]).map((n) => Number(n)) };
  shotScale.set(t.key, s);
  return { image, width: w, height: h, scale: Math.round(s * 1000) / 1000 };
}

const MOD: Record<string, string> = { cmd: 'meta', command: 'meta', meta: 'meta', super: 'meta', win: 'meta', ctrl: 'control', control: 'control', shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt' };
const KEY: Record<string, string> = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  arrowup: 'Up', up: 'Up', arrowdown: 'Down', down: 'Down', arrowleft: 'Left', left: 'Left', arrowright: 'Right', right: 'Right',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', space: 'Space', ' ': 'Space', insert: 'Insert',
};

async function opAct(S: string, a: Record<string, any>): Promise<unknown> {
  return withTab(S, a, false, async (t) => {
    const v = t.view;
    // ⚠ sendInputEvent 는 메인 프로세스를 거치는 비동기 호출이다 — 결과를 안 기다리면 뒤이은 캡처(다른 통로)가 입력보다 먼저
    //  처리돼 «누르기 전/끌기 도중» 화면을 찍는다(실측 2026-10-25: 끌기 직후 스크린샷이 12단계 중 9단계 화면). 하나씩 기다린다.
    const send = (ev: Record<string, unknown>): Promise<void> => Promise.resolve(v.sendInputEvent(ev)).catch(() => { /* 탭이 바뀌는 중 */ });
    const act = String(a.action);
    const s = shotScale.get(t.key) || 1;
    const out: Record<string, unknown> = { action: act };
    // 단계별 소요(ms) — 느릴 때 어디서 느린지 결과만 보고 안다(입력 · 박자 · 안정 · 적재 대기).
    const T0 = performance.now();
    const timing: Record<string, number> = {};
    const lap = (k: string): void => { timing[k] = Math.round(performance.now() - T0); };
    /** 대상 좌표(페이지 px). ref 면 화면 안으로 굴려 가운데를, 좌표면 스크린샷 배율을 되돌려. */
    const point = async (ref: unknown, x: unknown, y: unknown): Promise<{ x: number; y: number }> => {
      if (ref) {
        const p = await exec(t, callSource(pageRefPoint, String(ref)));
        if (p?.error) throw new Error(p.error);
        if (p?.covered) out.warning = `그 자리를 다른 요소(${p.covered})가 덮고 있었습니다 — 누른 결과를 확인하세요.`;
        out.target = { tag: p.tag, name: p.name };
        await nap(t, 60);   // 굴린 뒤 한 박자 — 그림이 따라오기 전에 누르면 옛 자리를 누른다
        return { x: p.x, y: p.y };
      }
      return { x: Math.round(Number(x) / s), y: Math.round(Number(y) / s) };
    };
    const click = async (p: { x: number; y: number }, button: 'left' | 'right', count: number): Promise<void> => {
      await send({ type: 'mouseMove', x: p.x, y: p.y });
      for (let i = 1; i <= count; i++) {
        await send({ type: 'mouseDown', x: p.x, y: p.y, button, clickCount: i });
        await send({ type: 'mouseUp', x: p.x, y: p.y, button, clickCount: i });
      }
    };
    let settle = 300;
    if (act === 'click' || act === 'double_click') {
      const p = await point(a.ref, a.x, a.y);
      await click(p, 'left', act === 'double_click' ? 2 : 1);
      out.x = Math.round(p.x * s); out.y = Math.round(p.y * s);
    } else if (act === 'right_click') {
      // ⚠ 진짜 오른쪽 버튼을 보내지 않는다 — 데스크톱 앱이 그걸 받아 **네이티브 우클릭 메뉴**를 사람의 화면(마우스 자리)에 띄우고,
      //  맥은 그 메뉴가 닫힐 때까지 앱의 메인 프로세스가 멈춘다(desktop/main context-menu). 마우스만 옮기고 페이지에는
      //  contextmenu 이벤트를 그 자리 요소에 직접 일으킨다 — 사이트가 만든 우클릭 메뉴는 이걸로 뜬다.
      const p = await point(a.ref, a.x, a.y);
      await send({ type: 'mouseMove', x: p.x, y: p.y });
      out.menu = await exec(t, `(() => { const el = document.elementFromPoint(${p.x}, ${p.y}); if (!el) return 'none';
        const o = { bubbles: true, cancelable: true, composed: true, clientX: ${p.x}, clientY: ${p.y}, button: 2, buttons: 2, view: window };
        el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o));
        el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 })); el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }));
        const shown = !el.dispatchEvent(new MouseEvent('contextmenu', o));
        return shown ? 'page-menu' : 'no-page-menu'; })()`);
      out.x = Math.round(p.x * s); out.y = Math.round(p.y * s);
      if (out.menu === 'no-page-menu') out.note = '이 페이지는 자체 우클릭 메뉴가 없습니다(브라우저 기본 메뉴는 열지 않습니다).';
    } else if (act === 'hover') {
      const p = await point(a.ref, a.x, a.y);
      await send({ type: 'mouseMove', x: p.x, y: p.y });
    } else if (act === 'drag') {
      const p = await point(a.ref, a.x, a.y);
      const q = { x: Math.round(Number(a.to_x) / s), y: Math.round(Number(a.to_y) / s) };
      await send({ type: 'mouseMove', x: p.x, y: p.y });
      await send({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        await send({ type: 'mouseMove', x: Math.round(p.x + ((q.x - p.x) * i) / steps), y: Math.round(p.y + ((q.y - p.y) * i) / steps), modifiers: ['leftButtonDown'] });
        await nap(t, 16);
      }
      await send({ type: 'mouseUp', x: q.x, y: q.y, button: 'left', clickCount: 1 });
    } else if (act === 'type') {
      if (a.ref) {
        const p = await point(a.ref, 0, 0);
        await click(p, 'left', 1);
        await nap(t, 80);
        await exec(t, callSource(pageCaretEnd, String(a.ref)));
      }
      await v.insertText(String(a.text ?? ''));
      settle = 150;
    } else if (act === 'key') {
      for (const combo of String(a.keys || '').trim().split(/\s+/).filter(Boolean)) {
        const parts = combo.split('+').filter((x, i, arr) => x !== '' || i === arr.length - 1);
        const raw = parts.pop() || '';
        const mods = [...new Set(parts.map((m) => MOD[m.toLowerCase()]).filter(Boolean))];
        const k = raw.toLowerCase();
        const cmdLike = mods.includes('meta') || mods.includes('control');
        // 편집 단축키는 webview 의 편집 명령으로 — 맥에서는 ⌘A·⌘C 같은 키가 앱 메뉴를 거쳐야 먹는데, 합성 키는 메뉴를 안 지난다.
        if (cmdLike && !mods.includes('alt')) {
          if (k === 'a') { v.selectAll(); continue; }
          if (k === 'c') { v.copy(); continue; }
          if (k === 'v') { v.paste(); continue; }
          if (k === 'x') { v.cut(); continue; }
          if (k === 'z') { if (mods.includes('shift')) v.redo(); else v.undo(); continue; }
        }
        const code = KEY[k] || (raw.length === 1 ? raw.toUpperCase() : raw);
        await send({ type: 'keyDown', keyCode: code, modifiers: mods });
        if (!cmdLike) {
          const ch = code === 'Enter' ? '\r' : code === 'Space' ? ' ' : raw.length === 1 ? raw : '';
          if (ch) await send({ type: 'char', keyCode: ch, modifiers: mods });
        }
        await send({ type: 'keyUp', keyCode: code, modifiers: mods });
        await nap(t, 40);
      }
    } else if (act === 'scroll') {
      const p = a.ref ? await point(a.ref, 0, 0)
        : (a.x !== undefined && a.y !== undefined ? { x: Math.round(Number(a.x) / s), y: Math.round(Number(a.y) / s) } : { x: Math.round(t.layoutW / 2), y: Math.round(t.layoutH / 2) });
      const n = Math.max(1, Number(a.amount) || 600);
      const dir = String(a.direction || 'down');
      // Electron 의 휠 부호: deltaY 가 음수면 내용이 위로 올라간다(= 아래로 굴림). 실측(2026-10-25): -500 → scrollY 500.
      //  한 번에 크게 보내면 부드러운 스크롤이 도는 중에 재서 덜 간 것으로 보인다(실측: 1500 을 보내고 450ms 뒤 436).
      //  그래서 300px 씩 나눠 보내고, 위치가 멈출 때까지(최대 2초) 기다린 뒤 잰다.
      const sign = dir === 'down' || dir === 'right' ? -1 : 1;
      const vertical = dir === 'down' || dir === 'up';
      let before = '';
      try { before = JSON.stringify(await exec(t, callSource(pageScrollState, p.x, p.y), 3_000)); } catch { /* noop */ }
      for (let left = n; left > 0; left -= 300) {
        const d = sign * Math.min(300, left);
        await send({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: vertical ? 0 : d, deltaY: vertical ? d : 0, canScroll: true });
        await nap(t, 16);
      }
      //  «멈췄다» = 두 번 연달아 같고, 시작 위치에서 이미 움직였거나(굴렀다) 0.45초가 지났다(끝에 닿아 못 구른다).
      //   시작 전 두 번이 같다고 멈춘 것으로 보면 덜 간 값을 보고한다(실측: 위로 500 이 그대로 1500).
      let last = '';
      const t0 = Date.now();
      while (Date.now() - t0 < 2_000) {
        await nap(t, 100);
        let cur = '';
        try { cur = JSON.stringify(await exec(t, callSource(pageScrollState, p.x, p.y), 3_000)); } catch { break; }
        if (cur === last && (cur !== before || Date.now() - t0 > 450)) break;
        last = cur;
      }
      try { out.scroll = last ? JSON.parse(last) : undefined; } catch { /* noop */ }
      settle = 0;
    } else if (act === 'wait') {
      const ms = Math.max(0, Math.min(30_000, Number(a.ms) || (a.text ? 10_000 : 1_000)));
      if (a.text) {
        const end = Date.now() + ms;
        let seen = false;
        while (Date.now() < end) {
          try { if (await exec(t, callSource(pageHasText, String(a.text)), 5_000)) { seen = true; break; } } catch { /* 이동 중 — 다시 */ }
          await nap(t, 300);
        }
        out.found = seen;
        if (!seen) out.warning = `${Math.round(ms / 1000)}초 안에 «${String(a.text).slice(0, 40)}» 가 나타나지 않았습니다.`;
      } else await nap(t, ms);
      settle = 0;
    } else {
      throw new Error('모르는 action 입니다: ' + act);
    }
    // 게스트에서 그리기 두 박자 — 박자에 맞춰 처리되는 입력(mousemove 등)이 다 처리되고 한 번 그려진 뒤에 결과를 낸다.
    //  박자가 멈춘 문서(가려진 탭)면 시간으로 끝낸다.
    lap('input');
    if (act !== 'wait') {
      try {
        //  숨은 창엔 박자가 없다 — 박자를 기다리면 시간 한도까지 간다. 빈 왕복 한 번이면 앞서 보낸 입력 작업이 처리된 뒤다.
        if (document.hidden) await exec(t, '0', 2_000);
        else await exec(t, 'new Promise(r=>{requestAnimationFrame(()=>requestAnimationFrame(()=>r(1)));setTimeout(()=>r(0),700)})', 2_000);
      } catch { /* 이동 중 */ }
    }
    lap('frames');
    if (settle) await nap(t, settle);
    lap('settle');
    // 누른 결과로 페이지가 바뀌는 중이면 끝날 때까지 조금 기다린다(최대 8초) — 바로 스크린샷을 찍으면 반쯤 그린 화면이다.
    if (t.loading) {
      const end = Date.now() + 8_000;
      while (t.loading && Date.now() < end) await nap(t, 150);
      lap('load');
    }
    const pic = a.screenshot ? await shot(t) : {};
    if (a.screenshot) lap('shot');
    return { ...summary(t), ...out, timing, ...pic };
  });
}

/** 올리기 상한(전부 합쳐) — 파일 바이트가 base64 로 페이지 원문에 실린다. 이보다 크면 사이트의 다른 길(드라이브 링크 등)을 쓴다. */
const UPLOAD_MAX = 15 * 1024 * 1024;

/**
 * 파일 올리기 — file_url 이 준 받기 주소(같은 게이트웨이의 /api/files/s/…)만 받는다. 이 화면이 사람 PC 에서 아무 주소나 받아
 *  남의 페이지에 넣는 통로가 되지 않게(사람 PC 의 localhost·사내망 주소를 AI 가 시켜 가져오는 길을 막는다).
 */
async function opUpload(t: BTab, a: Record<string, any>): Promise<unknown> {
  const urls: string[] = Array.isArray(a.urls) ? a.urls.map((u: unknown) => String(u)) : [];
  const names: string[] = Array.isArray(a.names) ? a.names.map((n: unknown) => String(n)) : [];
  if (!urls.length) throw new Error('urls 가 필요합니다 — file_url(method GET)이 준 받기 주소');
  const files: UploadFile[] = [];
  let total = 0;
  for (let i = 0; i < urls.length; i++) {
    let u: URL;
    try { u = new URL(urls[i], location.href); } catch { throw new Error('주소가 올바르지 않습니다: ' + urls[i]); }
    if (!/^(\/preview\/[^/]+)?\/api\/files\/s\/[^/]+$/.test(u.pathname)) {
      throw new Error('file_url 이 준 받기 주소(/api/files/s/…)만 올릴 수 있습니다: ' + urls[i]);
    }
    // 주소의 호스트는 믿지 않는다 — 같은 길(경로·쿼리)을 **이 화면이 붙은 게이트웨이**에서 받는다. 공개 주소와 앱이 연 주소가
    //  다를 수 있고(dev.lvly.io → 테넌트 주소 308 실측), 다른 호스트를 받아 주면 사람 PC 에서 아무 곳이나 긁어 오는 통로가 된다.
    const src = new URL(u.pathname + u.search, location.origin);
    const res = await within(fetch(src.href), 30_000, '파일을 받는 데 30초가 넘었습니다');
    if (!res.ok) throw new Error(`파일을 받지 못했습니다(${res.status}) — 주소가 만료됐으면 file_url 로 다시 받으세요.`);
    const blob = await res.blob();
    total += blob.size;
    if (total > UPLOAD_MAX) throw new Error(`파일이 너무 큽니다(합 ${Math.round(total / 1024 / 1024)}MB > ${UPLOAD_MAX / 1024 / 1024}MB).`);
    const cd = res.headers.get('content-disposition') || '';
    const m = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(cd);
    const fromHeader = m ? decodeURIComponent(m[1] || m[2] || '') : '';
    const name = (names[i] || fromHeader || 'file').replace(/[\\/]/g, '_').slice(0, 200);
    const b64 = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => { const s = String(fr.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = () => reject(new Error('파일을 읽지 못했습니다'));
      fr.readAsDataURL(blob);
    });
    files.push({ name, type: blob.type || 'application/octet-stream', b64 });
  }
  //  과녁 — ref(입력칸·단추·라벨·자리) 또는 끌어 놓을 자리의 좌표(스크린샷 좌표 → 페이지 px)
  const s = shotScale.get(t.key) || 1;
  const target = a.ref ? { ref: String(a.ref) } : { x: Math.round(Number(a.x) / s), y: Math.round(Number(a.y) / s) };
  const r = await exec(t, callSource(pageUpload, target, files), 60_000);
  if (!r?.ok) throw new Error(r?.error || '파일을 넣지 못했습니다');
  return { ...summary(t), ...(a.ref ? { ref: a.ref } : { x: a.x, y: a.y }), via: r.via, ...(r.target ? { target: r.target } : {}), files: r.files };
}

async function opEval(t: BTab, code: string): Promise<unknown> {
  let r: any;
  const mark = t.console.length;
  try { r = await exec(t, evalSource(code, true), 30_000); }
  catch {
    // 식으로 감싼 원문이 문법 오류다(문장 여러 개·return 등) — 본문으로 다시. 원문의 문법 오류는 Electron 이 사유 없이
    //  거절하므로(«Script failed to execute») 그 사유는 페이지 콘솔에 남은 줄에서 읽는다.
    try { r = await exec(t, evalSource(code, false), 30_000); }
    catch {
      const why = t.console.slice(mark).reverse().find((l) => l.level >= 3)?.message || '';
      throw new Error('코드를 실행하지 못했습니다' + (why ? ' — ' + why : ' — 문법을 확인하세요(마지막 값을 돌려받으려면 식 하나로, 문장이 여럿이면 return 으로)'));
    }
  }
  if (!r || r.ok !== true) throw new Error(String(r?.error || '코드가 오류를 냈습니다'));
  return { ...summary(t), value: r.value };
}

function opConsole(S: string, a: Record<string, any>): Record<string, unknown> {
  const t = pickTab(S, a.tab, false);
  const min = a.level === 'error' ? 3 : a.level === 'warning' ? 2 : 0;
  let re: RegExp | null = null;
  if (a.pattern) { try { re = new RegExp(String(a.pattern), 'i'); } catch { throw new Error('pattern 이 올바른 정규식이 아닙니다'); } }
  const name = (l: number) => (l >= 3 ? 'error' : l === 2 ? 'warning' : l === 1 ? 'info' : 'log');
  const lines = t.console.filter((l) => l.level >= min && (!re || re.test(l.message)));
  const limit = Math.max(1, Math.min(500, Number(a.limit) || 100));
  const out = lines.slice(-limit).map((l) => ({ level: name(l.level), message: l.message, at: new Date(l.at).toISOString(), ...(l.source ? { source: l.source.slice(0, 200) + (l.line ? ':' + l.line : '') } : {}) }));
  if (a.clear) t.console.length = 0;
  return { tab: tabNoOfKey(t.key), url: t.url, total: lines.length, lines: out };
}

async function opHandoff(S: string, a: Record<string, any>): Promise<unknown> {
  const t = pickTab(S, a.tab, true);
  markAi(t);
  requestReveal(t);
  revealedAt.set(t.key, Date.now());
  const msg = String(a.message || '').slice(0, 500);
  notifyHuman(S, msg);
  const wait = Math.max(0, Math.min(900, Number(a.wait_seconds) || 0));
  const p = requestHandoff(t, msg);
  if (!wait) return { ...summary(t), done: false, waiting: true, note: '사람에게 알렸습니다 — 그 탭에 부탁 글과 [완료] 단추가 떠 있습니다.' };
  let timer = 0;
  const r = await Promise.race([p, new Promise<{ timeout: true }>((res) => { timer = window.setTimeout(() => res({ timeout: true }), wait * 1000); })]);
  clearTimeout(timer);
  if ('timeout' in r) { cancelHandoff(t); return { ...summary(t), done: false, timeout: true, note: `${wait}초 동안 사람이 [완료]를 누르지 않았습니다.` }; }
  return { ...summary(t), done: r.done, ...(r.declined ? { declined: true } : {}) };
}

/** 사람에게 알린다 — OS 알림(누르면 그 세션으로) + 셸 토스트. */
function notifyHuman(S: string, msg: string): void {
  toast('AI 가 브라우저에서 도움을 요청합니다 — ' + msg);
  try {
    if (typeof Notification === 'function') {
      const n = new Notification('AI 가 브라우저에서 도움을 요청합니다', { body: msg, silent: false });
      n.onclick = () => {
        try { window.focus(); } catch { /* noop */ }
        if (S !== SESSIONLESS) location.hash = '#/s/' + encodeURIComponent(S);
      };
    }
  } catch { /* 알림 권한 없음 — 토스트는 이미 떴다 */ }
}

/** 시험·진단 — 이 화면의 호스트 id(없으면 ''). */
export function browserHostId(): string { return hostId; }
/** 사람이 [완료]·[못 해요]를 누르는 자리(웹 칸)가 부른다. */
export function answerHandoffFor(key: string, done: boolean): void { const t = getTab(key); if (t) answerHandoff(t, done); }
