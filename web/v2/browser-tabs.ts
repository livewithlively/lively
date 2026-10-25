// v2/browser-tabs.ts — 데스크톱 앱 안 브라우저의 **탭 대장 + 브라우저 층** (#4993).
//
// ── 왜 따로 있나 — 웹 칸 안에 `<webview>` 를 두면 AI 가 못 쓴다 ─────────────────────────
//  실측(Electron 43.8.3, 2026-10-25 — 지식 lively-browser-ai-control-design-4993):
//   · `<webview>` 는 **display:none(조상 포함)·visibility:hidden·화면 밖**이면 capturePage 가 영영 안 돌아온다
//     (메인 프로세스의 capturePage·CDP 도 같다). 클릭·입력·자바스크립트는 그 상태에서도 된다.
//   · 투명(opacity 0)이거나 축소(transform)돼 있어도 **화면 안에서 그려지면** 스크린샷이 된다(원래 해상도로).
//   · `<webview>` 를 DOM 의 다른 부모로 옮기면 페이지가 **다시 적재된다**(상태 유실).
//  셸은 안 보는 세션 탭·곁칸 탭을 display:none 으로 숨긴다. 그러니 웹 칸 안에 둔 webview 는 사람이 다른 세션을 보는
//  순간 AI 가 스크린샷을 못 찍는다 — AI 를 여럿 병렬로 돌리는 게 라이블리의 쓰임이라 이건 치명적이다.
//  그래서 webview 는 **처음부터 이 층(body 바로 아래)에서 태어나 평생 옮기지 않는다.** 웹 칸은 자리(anchor)만 내주고,
//  이 층이 그 자리 위에 webview 를 겹쳐 맞춘다(docked). 자리가 안 보이면:
//   · AI 가 최근에 썼으면 «따뜻한 대기»(warm) — 화면 안 왼쪽 위에 투명하게 세워 둔다(스크린샷·입력 다 된다)
//   · 아니면 «차가운 대기»(cold) — webview 자체를 display:none(페이지 상태는 남고 그리지 않는다)
//
// ── 탭의 열쇠 = 웹 칸의 저장 열쇠(slotKey) ──────────────────────────────────────────
//  `<세션>` 은 그 세션의 첫 웹 칸, `<세션>#2` 는 둘째 웹 칸(panes-kit slotStoreKey 와 같은 규칙). 그래서 사람이 그 세션의
//  웹 칸에서 보던 탭이 곧 AI 의 탭이다 — 둘이 같은 페이지를 같이 쓴다. 세션 밖에서 부른 AI(외부 하네스)는 'mcp'.
//
// ── 겹쳐 맞추기(docked)의 배율 ────────────────────────────────────────────────────
//  배율은 setZoomFactor 가 아니라 **배치 크기 ÷ 배율 + transform: scale** 이다(iframe 길과 같은 수법). 그래야 좁은 칸에서도
//  페이지는 넓은 화면(맞춤 기준 1280px)으로 배치되고 AI 의 스크린샷도 그 폭으로 찍힌다. 실측: transform 0.26 으로 줄인
//  webview 에도 창 수준 클릭이 제 버튼에 맞고(입력 라우팅이 transform 을 따른다) 스크린샷은 원래 해상도다.
//  ⚠ Electron 의 배율(zoom factor)은 출처마다 남을 수 있다 — 옛 웹 칸이 걸어 둔 0.26 이 살아나면 1280 배치 안에서 다시
//   줄어든다. 그래서 페이지가 열릴 때마다 1 로 되돌린다.
//
// ⚠ 이 모듈은 데스크톱 앱 안(hasBrowserSurface)에서만 쓴다. 브라우저에서 연 웹 UI 에는 webview 가 없다.
import { normWebUrl } from './web-url.js';
import { callSource, pageSameTab } from '../lib/browser-page.js';

export const DEFAULT_W = 1280;
export const DEFAULT_H = 800;
/** AI 가 이 안에 쓴 탭은 안 보여도 «따뜻하게» 둔다(스크린샷이 바로 되게). */
export const AI_WARM_MS = 3 * 60_000;
/** 안 보이는 탭을 없애기까지(사람만 쓴 탭). 주소는 웹 칸 저장값에 남아 다시 보면 그 주소로 다시 연다. */
export const DESTROY_AFTER_MS = 10 * 60_000;
/** AI 가 쓴 탭은 이만큼 더 산다 — AI 가 작업 도중 잠깐 다른 일을 해도 페이지 상태(로그인 단계·입력)가 남게. */
export const AI_KEEP_MS = 30 * 60_000;
/** 웹 칸이 주소를 기억하는 열쇠(panes-parts WEB_URL_KEY 와 같은 값) — 아직 안 연 탭(dormant)의 주소를 여기서 읽는다. */
export const WEB_URL_KEY = 'pn_web_url';
/** 사람의 칸에 붙은 탭이 이만큼 안 보이면 재운다(about:blank — 다시 보이면 그 주소로). 옛 웹 칸의 규칙 그대로(#1819 — 띄워 둔 페이지가
 *  안 보이는 동안에도 타이머·폴링·영상이 돌아 화면 전체가 느려졌다). AI 가 AI_KEEP_MS 안에 쓴 탭은 재우지 않는다(이어 쓴다). */
export const SLEEP_AFTER_MS = 30_000;
const CONSOLE_MAX = 500;

export type TabMode = 'docked' | 'warm' | 'cold';

export interface ConsoleLine { level: number; message: string; source: string; line: number; at: number }

export interface BTab {
  key: string;
  view: any;                 // <webview>
  overlay: HTMLElement;      // webview 위에 같은 자리로 겹쳐 그리는 판(배율 알약·AI 표시) — 층 밖 요소는 webview 를 못 이긴다
  url: string;
  title: string;
  loading: boolean;
  isReady: boolean;
  ready: Promise<void>;
  mode: TabMode;
  anchor: HTMLElement | null;
  anchorId: number;
  scale: () => number;
  layoutW: number;
  layoutH: number;
  dockZ: number;
  createdAt: number;
  touchedAt: number;         // 사람이 보거나(docked) AI 가 쓴 마지막 시각
  aiAt: number;              // AI 가 마지막으로 쓴 시각(0 = 쓴 적 없음)
  aiBusy: number;
  paused: boolean;           // 사람이 [AI 멈춤] — 이 탭의 AI 명령을 거절한다
  console: ConsoleLine[];
  lastError: string;
  handoff: { message: string; resolve: (r: { done: boolean; declined?: boolean }) => void } | null;
  /** 마지막으로 입힌 인라인 스타일 — 매 틀 같은 값을 다시 쓰지 않게(읽은 cssText 는 브라우저가 정규화해 내 문자열과 늘 다르다). */
  lastCss: string;
  lastOverlayCss: string;
  /** 재우기 전에 보던 주소('' = 깨어 있음) — 자는 동안 webview 는 about:blank 다. */
  asleep: string;
  /** 사람의 칸에서 안 보이기 시작한 시각(0 = 보이는 중이거나 칸이 없다). */
  hiddenAt: number;
}

export type TabEvent =
  | { type: 'tabs' }
  | { type: 'nav'; key: string }
  | { type: 'ai'; key: string }
  | { type: 'handoff'; key: string }
  | { type: 'reveal'; key: string; session: string; slot: string };

const tabs = new Map<string, BTab>();
const listeners = new Set<(ev: TabEvent) => void>();
let layer: HTMLElement | null = null;
let raf = 0;
let anchorSeq = 0;
let sweeper = 0;

/** 탭 열쇠의 세션 부분 — `<세션>#2` → `<세션>`. */
export function sessionOfKey(key: string): string {
  const i = key.lastIndexOf('#');
  return i > 0 && /^\d+$/.test(key.slice(i + 1)) ? key.slice(0, i) : key;
}
/** 탭 열쇠의 번호(AI 에게 보이는 tab) — `<세션>` → '1', `<세션>#3` → '3'. */
export function tabNoOfKey(key: string): string {
  const i = key.lastIndexOf('#');
  return i > 0 && /^\d+$/.test(key.slice(i + 1)) ? key.slice(i + 1) : '1';
}
/** 세션 + 번호 → 탭 열쇠. 번호가 1(또는 빈 값)이면 세션 그대로. */
export function keyOfTab(session: string, tabNo: string | number | null | undefined): string {
  const n = Math.max(1, Math.floor(Number(tabNo) || 1));
  return n >= 2 ? session + '#' + n : session;
}
/** 탭 열쇠 → 곁칸 탭 열쇠(panes 의 TabKey) — 첫 웹 칸은 'web', 둘째부터 'web#N'. */
export function slotOfKey(key: string): string {
  const n = tabNoOfKey(key);
  return n === '1' ? 'web' : 'web#' + n;
}

export function onTabEvent(fn: (ev: TabEvent) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function emit(ev: TabEvent): void {
  for (const fn of [...listeners]) { try { fn(ev); } catch { /* 한 구독자의 오류가 나머지를 막지 않는다 */ } }
}

function ensureLayer(): HTMLElement {
  if (layer && layer.isConnected) return layer;
  // display:contents — 층 자체는 상자를 만들지 않는다(쌓임 맥락도 만들지 않는다). 그래야 탭마다 제 자리(anchor)의
  //  쌓임 높이에 맞춘 z-index 로 뿌리 맥락에서 겨룬다. 층에 position·z-index 를 주면 모든 탭이 그 높이에 갇힌다.
  layer = document.createElement('div');
  layer.className = 'bt-layer';
  document.body.appendChild(layer);
  // 끌기 보호 — 셸에서 시작한 끌기(경계·탭·글 선택)가 webview 위를 지나가면 webview 가 마우스를 삼켜 끌기가 끊긴다.
  //  webview 안에서 시작한 누름은 문서로 오지 않으므로(그건 게스트 몫) 여기 오는 pointerdown 은 전부 «바깥에서 시작한 것»이다.
  document.addEventListener('pointerdown', () => { layer?.classList.add('bt-passive'); }, true);
  const off = (): void => { layer?.classList.remove('bt-passive'); };
  document.addEventListener('pointerup', off, true);
  document.addEventListener('pointercancel', off, true);
  window.addEventListener('blur', off);
  if (!sweeper) sweeper = window.setInterval(sweep, 5_000);
  return layer;
}

/** 저장된 웹 칸 주소들 — 아직 webview 를 안 만든 탭(dormant)도 AI 에게 보이게. */
export function storedUrls(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(WEB_URL_KEY) || '{}') || {}; } catch { return {}; }
}
export function rememberUrl(key: string, url: string): void {
  try {
    const m = storedUrls();
    if (m[key] === url) return;
    m[key] = url;
    localStorage.setItem(WEB_URL_KEY, JSON.stringify(m));
  } catch { /* 저장소가 막혀도 탭은 산다 */ }
}

export function getTab(key: string): BTab | null { return tabs.get(key) || null; }
export function allTabs(): BTab[] { return [...tabs.values()]; }
export function tabsOfSession(session: string): BTab[] { return allTabs().filter((t) => sessionOfKey(t.key) === session); }

/** 탭이 지금 사람에게 보이나 — 자리에 겹쳐 있고 그 자리가 보이며 창도 보일 때. */
export function tabVisible(t: BTab): boolean {
  return t.mode === 'docked' && document.visibilityState === 'visible';
}

/**
 * 탭을 만든다(이미 있으면 그대로). 처음엔 «차가운 대기» — 자리가 생기면 겹쳐 맞추고, AI 가 쓰면 따뜻하게 세운다.
 *  url 을 안 주면 웹 칸 저장값(그 열쇠로 사람이 마지막에 본 주소)으로 연다.
 */
export function ensureTab(key: string, url?: string): BTab {
  const had = tabs.get(key);
  if (had) return had;
  const host = ensureLayer();
  //  'about:blank' 은 «빈 탭으로» 라는 뜻이다 — 주소 정규화에 넣으면 검색어로 읽혀 구글 검색이 열린다.
  const start = url === 'about:blank' ? '' : url ? (normWebUrl(url) || url) : (storedUrls()[key] || '');
  const view = document.createElement('webview') as any;
  view.className = 'bt-view';
  view.dataset.btKey = key;
  if (start) view.setAttribute('src', start); else view.setAttribute('src', 'about:blank');
  const overlay = document.createElement('div');
  overlay.className = 'bt-overlay';
  let markReady: () => void = () => {};
  const t: BTab = {
    key, view, overlay, url: start, title: '', loading: !!start, isReady: false,
    ready: new Promise<void>((r) => { markReady = r; }),
    mode: 'cold', anchor: null, anchorId: 0, scale: () => 1,
    layoutW: DEFAULT_W, layoutH: DEFAULT_H, dockZ: 6,
    createdAt: Date.now(), touchedAt: Date.now(), aiAt: 0, aiBusy: 0, paused: false,
    console: [], lastError: '', handoff: null, lastCss: '', lastOverlayCss: '', asleep: '', hiddenAt: 0,
  };
  const syncUrl = (): void => {
    try {
      const u = view.getURL();
      if (u && u !== 'about:blank' && u !== t.url) { t.url = u; rememberUrl(key, u); }
    } catch { /* 아직 안 붙었다 */ }
    try { t.title = view.getTitle() || t.title; } catch { /* noop */ }
    emit({ type: 'nav', key });
  };
  const zoomOne = (): void => { try { if (view.getZoomFactor && view.getZoomFactor() !== 1) view.setZoomFactor(1); } catch { /* 아직 안 붙었다 */ } };
  view.addEventListener('dom-ready', () => {
    zoomOne();
    if (!t.isReady) { t.isReady = true; markReady(); }
    //  «새 창 → 같은 탭» 고리는 AI 가 최근(AI_WARM_MS)에 쓴 탭의 새 페이지에만 — 사람만 둘러보는 페이지는 사이트 그대로 둔다.
    if (t.aiAt && Date.now() - t.aiAt < AI_WARM_MS) void sameTab(t);
    syncUrl();
  });
  view.addEventListener('did-start-loading', () => { t.loading = true; t.lastError = ''; emit({ type: 'nav', key }); });
  view.addEventListener('did-stop-loading', () => { t.loading = false; syncUrl(); });
  view.addEventListener('did-navigate', () => { zoomOne(); syncUrl(); });
  view.addEventListener('did-navigate-in-page', (e: any) => { if (!e || e.isMainFrame !== false) syncUrl(); });
  view.addEventListener('page-title-updated', (e: any) => { t.title = String(e?.title || t.title); emit({ type: 'nav', key }); });
  view.addEventListener('did-fail-load', (e: any) => {
    // -3(ERR_ABORTED) 는 리다이렉트·중복 적재의 부수 신호라 오류가 아니다(데스크톱 main.mjs 와 같은 판정).
    if (!e || e.isMainFrame === false || e.errorCode === -3) return;
    t.lastError = `${e.errorDescription || '알 수 없는 오류'}(${e.errorCode}) — ${e.validatedURL || ''}`;
    emit({ type: 'nav', key });
  });
  view.addEventListener('console-message', (e: any) => {
    //  Electron 이 게스트에 끼워 넣는 자기 경고(개발판의 «Electron Security Warning» 등 — 출처 node:electron/…)는 페이지의 말이 아니다.
    if (String(e?.sourceId || '').startsWith('node:electron')) return;
    t.console.push({ level: Number(e?.level) || 0, message: String(e?.message ?? '').slice(0, 4_000), source: String(e?.sourceId || ''), line: Number(e?.line) || 0, at: Date.now() });
    if (t.console.length > CONSOLE_MAX) t.console.splice(0, t.console.length - CONSOLE_MAX);
  });
  view.addEventListener('render-process-gone', () => { t.lastError = '페이지 프로세스가 죽었습니다 — 다시 열어야 합니다'; t.isReady = false; emit({ type: 'nav', key }); });
  //  처음엔 «따뜻한 대기»로 붙인다 — display:none 으로 태어난 webview 가 붙기(attach)를 미루는 경우를 피한다.
  //   AI 도 자리도 안 쓰면 다음 청소(5초)에 차가운 대기로 식는다.
  applyMode(t, 'warm');
  host.appendChild(view);
  host.appendChild(overlay);
  tabs.set(key, t);
  emit({ type: 'tabs' });
  return t;
}

/** 탭을 없앤다 — webview 를 내리고 대장에서 뺀다. 주소는 웹 칸 저장값에 남는다(다시 보면 그 주소로 연다). */
export function destroyTab(key: string, forget = false): void {
  const t = tabs.get(key);
  if (!t) return;
  tabs.delete(key);
  if (t.handoff) { const h = t.handoff; t.handoff = null; h.resolve({ done: false, declined: true }); }
  try { t.view.remove(); } catch { /* noop */ }
  try { t.overlay.remove(); } catch { /* noop */ }
  if (forget) { try { const m = storedUrls(); delete m[key]; localStorage.setItem(WEB_URL_KEY, JSON.stringify(m)); } catch { /* noop */ } }
  emit({ type: 'tabs' });
}

/**
 * 탭을 비운다(빈 페이지 · 주소 잊기) — AI 가 «닫은» 탭을 사람의 칸이 쥐고 있을 때 없애지 않고 이렇게 남긴다. 없애면 칸에는 빈 자리만
 *  남고 같은 번호로 다시 연 탭이 칸에 안 붙어 사람에게 안 보인다(#4993 격리 리뷰). 걸려 있던 부탁은 거절로 끝낸다.
 */
export function blankTab(t: BTab): void {
  if (t.handoff) { const h = t.handoff; t.handoff = null; h.resolve({ done: false, declined: true }); }
  try { const m = storedUrls(); delete m[t.key]; localStorage.setItem(WEB_URL_KEY, JSON.stringify(m)); } catch { /* noop */ }
  t.url = '';
  t.title = '';
  t.asleep = '';
  t.lastError = '';
  t.console.length = 0;
  try { if (t.isReady) void t.view.loadURL('about:blank').catch(() => { /* noop */ }); else t.view.setAttribute('src', 'about:blank'); }
  catch { /* noop */ }
  emit({ type: 'nav', key: t.key });
}

/**
 * 탭을 자리(anchor)에 겹쳐 맞춘다. 같은 탭을 다른 자리가 이미 쥐고 있으면 **나중 자리가 이긴다**(앞 자리는 release 가 noop 이 된다).
 * @param scale 지금 배율(맞춤·고정) — 매 틀마다 읽는다(칸 폭이 바뀌면 맞춤 배율도 바뀐다)
 * @returns 자리를 놓는 함수(웹 칸이 세션을 갈아 끼우거나 사라질 때)
 */
export function dockTab(key: string, anchor: HTMLElement, scale: () => number): () => void {
  const t = ensureTab(key);
  const id = ++anchorSeq;
  t.anchor = anchor;
  t.anchorId = id;
  t.scale = scale;
  t.touchedAt = Date.now();
  kick();
  return () => {
    if (t.anchorId !== id) return;
    t.anchor = null;
    t.anchorId = 0;
    park(t);
  };
}

/** AI 가 이 탭을 쓴다 — 시각을 적고, 안 보이는 탭이면 따뜻하게 세운다(스크린샷이 되게). 같은 탭 고리의 «AI 쓰는 중» 시한도 늘린다. */
export function markAi(t: BTab): void {
  t.aiAt = Date.now();
  t.touchedAt = t.aiAt;
  if (t.mode === 'cold') applyMode(t, 'warm');
  if (t.isReady) void sameTab(t);
  emit({ type: 'ai', key: t.key });
}

/** 재운 탭을 깨운다(재우기 전 주소를 다시 싣는다) — 깨웠으면 true. 부른 쪽이 다 실릴 때까지 기다린다. */
export function wakeTab(t: BTab): boolean {
  const u = t.asleep;
  if (!u) return false;
  t.asleep = '';
  try { if (t.isReady) void t.view.loadURL(u).catch(() => { /* 실패는 did-fail-load 가 적는다 */ }); else t.view.setAttribute('src', u); }
  catch { t.view.setAttribute('src', u); }
  return true;
}

/** 탭을 재운다 — 안쪽 페이지를 통째로 내린다(타이머·폴링·소켓·영상이 함께 멈춘다). 주소(t.url)·웹 칸 저장값은 그대로 남는다. */
function sleepTab(t: BTab): void {
  const u = t.url;
  if (!u || t.asleep) return;
  t.asleep = u;
  try { if (t.isReady) void t.view.loadURL('about:blank').catch(() => { /* noop */ }); else t.view.setAttribute('src', 'about:blank'); }
  catch { /* 이미 내려간 webview */ }
}
export function aiBusy(t: BTab, d: 1 | -1): void {
  t.aiBusy = Math.max(0, t.aiBusy + d);
  t.overlay.classList.toggle('bt-ai-on', t.aiBusy > 0);
  emit({ type: 'ai', key: t.key });
}
export function setPaused(t: BTab, on: boolean): void { t.paused = on; emit({ type: 'ai', key: t.key }); }

/** 사람에게 넘기기 — 탭에 부탁 글을 걸고 [완료]·[못 해요]를 기다린다. 새 부탁이 오면 앞 부탁은 거절로 끝낸다. */
export function requestHandoff(t: BTab, message: string): Promise<{ done: boolean; declined?: boolean }> {
  if (t.handoff) { const prev = t.handoff; t.handoff = null; prev.resolve({ done: false, declined: true }); }
  return new Promise((resolve) => {
    t.handoff = { message, resolve };
    emit({ type: 'handoff', key: t.key });
  });
}
export function answerHandoff(t: BTab, done: boolean): void {
  const h = t.handoff;
  if (!h) return;
  t.handoff = null;
  h.resolve(done ? { done: true } : { done: false, declined: true });
  emit({ type: 'handoff', key: t.key });
}
export function cancelHandoff(t: BTab): void {
  if (!t.handoff) return;
  t.handoff = null;
  emit({ type: 'handoff', key: t.key });
}
/** 셸에게 «이 세션의 웹 칸을 보이게 해 달라» — 세션 화면이 떠 있는 곳(panes)이 듣는다. */
export function requestReveal(t: BTab): void {
  emit({ type: 'reveal', key: t.key, session: sessionOfKey(t.key), slot: slotOfKey(t.key) });
}

/** 스크린샷이 되는 상태로 — 차가운 대기면 따뜻하게 세우고 한 박자 기다린다(합성기가 그 webview 를 다시 그리게). */
export async function ensureCapturable(t: BTab): Promise<void> {
  if (t.mode !== 'cold') return;
  applyMode(t, 'warm');
  // 한 박자 — 숨은 창에선 타이머가 1초로 묶이므로 게스트와의 빈 왕복으로 잰다(browser-host nap 과 같은 이유).
  if (!document.hidden) { await new Promise((r) => setTimeout(r, 350)); return; }
  const end = performance.now() + 350;
  //  왕복 한 번에 한도(2초)를 둔다 — 페이지가 바쁜 고리에 빠져 있으면 executeJavaScript 가 끝나지 않아 그 세션의 명령 줄 전체가 멈춘다.
  while (performance.now() < end) {
    const r = await Promise.race([t.view.executeJavaScript('0').then(() => 'ok', () => 'err'), new Promise((res) => setTimeout(() => res('slow'), 2_000))]);
    if (r !== 'ok') return;
  }
}

// ── 자리 맞추기 ─────────────────────────────────────────────────────────────

function anchorShown(a: HTMLElement): boolean {
  if (!a.isConnected) return false;
  const r = a.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) return false;
  const cv = (a as any).checkVisibility;
  if (typeof cv === 'function') { try { return !!cv.call(a, { checkVisibilityCSS: true, checkOpacity: false }); } catch { /* 구형 */ } }
  return a.getClientRects().length > 0;
}

/** 자리의 쌓임 높이 + 1 — 자리를 품은 서랍(z 40) 같은 조상이 있으면 그 위로, 없으면 칸 장식(z ≤ 5) 위로. 팝오버(30+)는 그 위에 남는다. */
function dockZOf(a: HTMLElement): number {
  let z = 0;
  for (let n: HTMLElement | null = a; n && n !== document.body; n = n.parentElement) {
    try {
      const cs = getComputedStyle(n);
      if (cs.position !== 'static' && cs.zIndex !== 'auto') z = Math.max(z, parseInt(cs.zIndex, 10) || 0);
    } catch { /* noop */ }
  }
  return Math.max(6, z + 1);
}

function applyMode(t: BTab, mode: TabMode): void {
  t.mode = mode;
  t.lastCss = '';
  t.lastOverlayCss = '';
  const v = t.view as HTMLElement;
  const o = t.overlay;
  if (mode === 'cold') {
    v.style.cssText = `position:fixed;left:0;top:0;width:${t.layoutW}px;height:${t.layoutH}px;display:none;`;
    v.setAttribute('aria-hidden', 'true');
    o.style.display = 'none';
    try { if (document.activeElement === v) v.blur(); } catch { /* noop */ }
    return;
  }
  if (mode === 'warm') {
    // 화면 안(왼쪽 위)에 거의 투명하게 — 그려지므로 스크린샷이 되고, 눌리지 않으며(pointer-events) 맨 뒤에 깔린다.
    //  ⚠ opacity 를 **0 으로 두지 않는다** — 실측(2026-10-25): opacity:0 이면 Chromium 이 그 게스트의 그리기 박자(rAF)를
    //   초당 1번으로 낮춰(두 번째 박자 993ms) 박자에 맞춰 도는 입력·화면 갱신(리액트 등)이 1초씩 밀린다.
    //   0.01 은 사람 눈엔 안 보이고(게다가 셸 뒤에 깔린다) 박자는 정상(16ms)이다.
    v.style.cssText = `position:fixed;left:0;top:0;width:${t.layoutW}px;height:${t.layoutH}px;opacity:0.01;pointer-events:none;z-index:-1;transform:none;`;
    v.setAttribute('aria-hidden', 'true');
    o.style.display = 'none';
    try { if (document.activeElement === v) v.blur(); } catch { /* noop */ }
  }
}

/** 칸이 준 배율을 겹쳐 맞추기에 쓸 값으로 — 0.1~4 로 자르고, 못 읽으면 1. */
export function clampScale(v: unknown): number {
  return Math.max(0.1, Math.min(4, Number(v) || 1));
}

/**
 * 지금 이 탭에 걸린 배율 — 사람 칸에 겹쳐 있으면(docked) 칸 배율, 아니면 1(대기는 transform 이 없다).
 *  휠 거리는 이 배율의 역수만큼 커져 들어간다(실측 2026-10-25 상민님 앱: 칸 배율 ≈0.755 에서 1200→1590 · 600→795) —
 *  browser-host 가 휠에 이 값을 곱해 보낸다(browser-host-kit scrollPlan).
 */
export function dockScale(t: Pick<BTab, 'mode' | 'scale'>): number {
  return t.mode === 'docked' ? clampScale(t.scale()) : 1;
}

function place(t: BTab): void {
  const a = t.anchor!;
  const r = a.getBoundingClientRect();
  const z = clampScale(t.scale());
  const lw = Math.max(50, Math.round(r.width / z));
  const lh = Math.max(50, Math.round(r.height / z));
  if (t.mode !== 'docked') t.dockZ = dockZOf(a);
  t.layoutW = lw;
  t.layoutH = lh;
  const v = t.view as HTMLElement;
  const css = `position:fixed;left:${Math.round(r.left)}px;top:${Math.round(r.top)}px;width:${lw}px;height:${lh}px;` +
    `transform:scale(${z});transform-origin:0 0;z-index:${t.dockZ};`;
  if (t.lastCss !== css) { v.style.cssText = css; t.lastCss = css; }
  v.removeAttribute('aria-hidden');
  const o = t.overlay;
  const ocss = `position:fixed;left:${Math.round(r.left)}px;top:${Math.round(r.top)}px;width:${Math.round(r.width)}px;height:${Math.round(r.height)}px;z-index:${t.dockZ + 1};`;
  if (t.lastOverlayCss !== ocss) { o.style.cssText = ocss; t.lastOverlayCss = ocss; }
  t.mode = 'docked';
  t.touchedAt = Date.now();
}

function park(t: BTab): void {
  const warm = t.aiAt && Date.now() - t.aiAt < AI_WARM_MS;
  applyMode(t, warm ? 'warm' : 'cold');
}

/** 한 틀 — 자리를 쥔 탭을 자리에 맞추고, 자리가 안 보이는 탭은 대기로. 자리를 쥔 탭이 있는 동안만 돈다. */
function frame(): void {
  raf = 0;
  let any = false;
  for (const t of tabs.values()) {
    if (!t.anchor) continue;
    any = true;
    if (anchorShown(t.anchor)) {
      if (t.asleep) wakeTab(t);          // 다시 보인다 — 재우기 전 주소로
      t.hiddenAt = 0;
      place(t);
    } else {
      if (t.mode === 'docked') { park(t); t.dockZ = 6; }
      if (!t.hiddenAt) t.hiddenAt = Date.now();
    }
  }
  if (any) raf = requestAnimationFrame(frame);
}
function kick(): void { if (!raf) raf = requestAnimationFrame(frame); }

/**
 * 5초마다 — 따뜻한 대기의 식히기 · 오래 안 본 탭 내리기 · 사람의 칸에 붙은 채 안 보이는 탭 재우기. (창이 숨어 rAF 가 멈춰도 이건 돈다.)
 *  ⚠ 사람의 칸에 붙은 탭(anchor)도 식히고 재운다 — 셸은 안 보는 세션 화면을 숨긴 채 살려 두므로 칸이 사라지지 않는다. 종전엔
 *   붙은 탭을 통째로 건너뛰어 AI 가 쓴 직후 숨은 칸의 탭이 투명도 1% 로 영영 그려지고, 숨은 페이지가 끝없이 돌았다(#4993 격리 리뷰).
 */
function sweep(): void {
  const now = Date.now();
  for (const t of [...tabs.values()]) {
    if (t.mode === 'docked') continue;
    if (t.aiBusy > 0 || t.handoff) continue;
    if (t.mode === 'warm' && !(t.aiAt && now - t.aiAt < AI_WARM_MS)) applyMode(t, 'cold');
    if (t.anchor) {
      //  사람의 칸 — 내리지 않는다(칸이 그 탭을 쥐고 있다). 오래 안 보이면 재우고, 다시 보이면 frame() 이 깨운다.
      if (!t.hiddenAt) t.hiddenAt = now;
      const aiRecent = t.aiAt > 0 && now - t.aiAt < AI_KEEP_MS;
      if (!t.asleep && !aiRecent && !t.paused && now - t.hiddenAt >= SLEEP_AFTER_MS) sleepTab(t);
      continue;
    }
    const keep = t.aiAt ? Math.max(DESTROY_AFTER_MS, AI_KEEP_MS - (now - t.aiAt)) : DESTROY_AFTER_MS;
    if (now - t.touchedAt > keep) destroyTab(t.key);
  }
  if ([...tabs.values()].some((t) => t.anchor)) kick();
}

/** AI 가 쓰는 탭에만 거는 «새 창 → 같은 탭» 고리(browser-page pageSameTab). 데스크톱 앱은 새 창을 시스템 브라우저로 보낸다. */
async function sameTab(t: BTab): Promise<void> {
  //  시한 = AI 가 마지막으로 쓴 때 + AI_WARM_MS — 그 뒤엔 고리가 아무것도 바꾸지 않는다(사람이 둘러볼 땐 사이트 그대로).
  try { await t.view.executeJavaScript(callSource(pageSameTab, (t.aiAt || Date.now()) + AI_WARM_MS)); }
  catch { /* 페이지가 막 바뀌는 중 — 다음 dom-ready 에서 다시 건다 */ }
}
