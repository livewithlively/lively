// web/v2/app-ui.ts — 설치된 앱의 UI 페이지를 **샌드박스 iframe** 으로 연다 (#1780 PR5, MCP Apps 문법).
//  전달: 인증 API(GET /api/ui/apps/:id/ui)로 entry HTML 을 받아 <iframe sandbox="allow-scripts" srcdoc>로 싣는다.
//   → 앱 UI 는 **오리진 격리(불투명)**: 부모(라이블리 셸)의 토큰·localStorage 에 못 닿는다. 주입한 CSP 로 네트워크도 막는다
//     (default-src 'none' … connect-src 'none') — 앱 UI 는 인라인 스크립트/스타일 + postMessage 만 쓸 수 있다.
//  부작용 있는 tools/call 은 postMessage 로 **호스트가 중개**한다 — 호스트가 /api/ui/apps/:id/tool-call 로 넘기면
//   서버가 앱 grant 로 제약해 실행한다(PR5b). 브리지 핸들러는 **프레임별**이라 여러 앱 UI 가 공존할 수 있다
//   (모달 openAppUi · panes 세션화면 탭 appPart 둘 다 mountAppUiFrame 을 쓴다 — #1719 원준 panes 재편에 정합).
//  ★ SDK 주입(#1780 SDK): srcdoc 머리에 app-ui-runtime 을 끼워 넣어 앱이 `window.lively` 를 **설치·번들 없이** 쓴다.
//   (외부 스크립트가 CSP 로 막혀 있어 npm 배포가 성립하지 않는다 — 그래서 호스트 주입이 이 플랫폼의 SDK 전달 방식이다.)
//  ★ CSP 는 **앱이 선언한 만큼만**(manifest.csp — MCP Apps 채택): 기본은 네트워크·프레임 0, 선언하면 그만큼 열린다.
//  ★ #4480 v2-1 앱 주소 — 워크스페이스가 앱 주소를 켜 두었으면(me.app_domain) 앱을 **자기 주소**(<앱>-<워크스페이스>.lvly.app)로 띄운다:
//   화면이 일회용 코드를 받아(POST /api/ui/apps/:id/launch, mode=embed) iframe src 에 붙이면 그 주소의 앞단이 코드를 앱 주소 쿠키로 바꾼다.
//   다른 사이트라 allow-same-origin 을 줘도 라이블리에 못 닿는다(그 출처는 앱 주소 자신). 다리는 그대로 — 이 프레임 + 그 출처에서 온 것만 받고,
//   답도 그 출처로만 보낸다. 브라우저가 앱 주소 쿠키를 막으면(사파리 26.2 전 등) 그 자리에서 종전 srcdoc 으로 바꿔 띄우고 이 브라우저는 다음부터
//   바로 srcdoc 으로 연다 — 앱은 어느 길로 떠도 같은 SDK 로 돈다. 못 쓰는 경우(꺼짐·주소를 못 만드는 이름·권한)도 전부 종전 길로 간다.
//  ★ #4482 v2-3 iframe 완화 — 평범한 웹 방식이 그대로 돌게: 두 길 모두 폼 제출 · alert/confirm/print · 내려받기를 연다(frameSandbox).
//   앱 주소 길은 다른 사이트라 출처(allow-same-origin)와 팝업까지 — 쿠키 · localStorage · 새 창이 앱 주소의 것으로 돈다. 최상위 창 이동
//   (allow-top-navigation)은 어느 길도 주지 않는다(설계 §2 ④). 장치 권한은 앱이 선언한 것만(frameAllow — 상민님 2026-10-16 «선언한 앱만»).
import { api, el, state, toast } from '../core.js';
import { PROBE_JS } from '../lib/studio-flow.js';   // #4632 검토 중인 앱의 문서에 넣는 탐침(찍은 자리의 요소 · 테두리)
import { APP_RUNTIME_JS } from './app-ui-runtime.js';
import { addrBlockValid, appAuthSignal, embedNext, frameAllow, frameSandbox } from '../lib/app-address.js';   // #4480 앱 주소 — 순수 조각(시험: scripts/app-address-web.test.mjs)
import { ensureAppGrant } from './app-session.js';
import { putIntoSession } from './sess-input.js';   // #4594 멈춘 세션에 보내려던 글을 그 세션 화면의 입력칸에 넣어 둔다(잎 모듈)
//  #4530 앱 화면 안의 ⌘K → 셸 통합검색. omni.ts 를 직접 들이지 않는다 — 셸 화면 모듈 묶음(사이드바·자료 …)이 통째로 딸려 와
//   앱 화면 묶음이 커지고, 창이 없는 곳에서 이 모듈을 실으면 그 묶음이 터진다(scripts/session-app-pane.test.mjs 가 잡았다).
//   대신 셸이 듣는 같은 오리진 신호(OMNI_MSG, 가벼운 lib/omni-chord.ts 에 한 벌)를 이 창에 보낸다 — 셸의 bindOmniKey 가 받아 연다.
import { OMNI_MSG } from '../lib/omni-chord.js';
let lastOmniAsk = 0;   // 앱이 보낸 «통합검색 열기» 의 마지막 때(1초에 한 번)

/**
 * 다리로 앱에 넘기는 실패(#4848) — 서버가 답한 실패(e.status 가 있음)면 error.data 에 상태와 서버의 짧은 글(error · code — 문자열만)을 싣는다.
 *  앱의 SDK(app-ui-runtime.ts)가 그걸로 e.status · e.reason(body_too_large · consent_required …)을 만든다 — 맨몸(새 탭 · 폰)과 같은 규칙.
 *  서버 밖의 거절(붙은 세션 없음 · 사람이 누른 동작 아님 …)은 data 없이 종전 그대로.
 */
function rpcFailure(e: any, code: number): { code: number; message: string; data?: { status: number; error?: string; code?: string } } {
  const message = e && e.message ? String(e.message) : String(e);
  const status = typeof e?.status === 'number' ? e.status : 0;
  if (!status) return { code, message };
  const data: { status: number; error?: string; code?: string } = { status };
  if (typeof e?.body?.error === 'string') data.error = e.body.error.slice(0, 300);
  if (typeof e?.body?.code === 'string' && e.body.code.length <= 64) data.code = e.body.code;   // 긴 것은 자르지 않고 버린다(잘린 글이 코드가 되지 않게)
  return { code, message, data };
}

export interface AppCsp {
  connect_domains?: string[]; resource_domains?: string[]; frame_domains?: string[];
  /** #4673 — 앱 폴더를 선언한 앱의 서명 주소 자리(`<게이트웨이>/api/files/s/`). 서버가 채운다(src/files/app-screen-csp.ts). */
  files?: string | null;
}

const FILES_SRC_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/api\/files\/s\/$/;
/** 지시문 값 뒤에 서명 주소 자리를 붙인다('none' 이면 그 자리로 바꾼다) — src/apps/app-front-page.ts withFiles 와 같은 규칙. */
function withFiles(list: string, files: string | null | undefined): string {
  if (!files || !FILES_SRC_RE.test(files)) return list;
  return list === "'none'" ? files : list + ' ' + files;
}

/** 선언 도메인 목록 → CSP 소스 표현. 빈 목록이면 'none', `*` 이 있으면 https: (스킴 전체 — http 는 안 준다). */
function srcList(domains: string[] | undefined, extra?: string): string {
  const list = (domains ?? []).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  const base = extra ? [extra] : [];
  if (!list.length) return base.length ? base.join(' ') : "'none'";
  if (list.includes('*')) return [...base, 'https:'].join(' ');
  return [...base, ...list.map((d) => 'https://' + d)].join(' ');
}

/**
 * 이 앱에 허용할 CSP — **기본은 아무것도 없음**(default-src 'none'), 앱이 매니페스트에 적은 만큼만 열린다.
 *  script-src 는 어떤 선언으로도 넓어지지 않는다(외부 스크립트 금지 = 앱 UI 안에서 도는 코드는 그 앱의 것뿐).
 */
function buildCsp(csp?: AppCsp): string {
  const parts = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",         // ⚠ 외부 스크립트는 어떤 선언으로도 열지 않는다
    "style-src 'unsafe-inline'",
    'img-src ' + withFiles(srcList(csp?.resource_domains, 'data:'), csp?.files),
    'font-src ' + srcList(csp?.resource_domains, 'data:'),
    'media-src ' + withFiles(srcList(csp?.resource_domains), csp?.files),
    'connect-src ' + withFiles(srcList(csp?.connect_domains), csp?.files),
    'frame-src ' + srcList(csp?.frame_domains),
    "form-action 'none'",
    "base-uri 'none'",
  ];
  return '<meta http-equiv="Content-Security-Policy" content="' + parts.join('; ') + '">';
}

/** CSP meta + SDK 런타임을 문서 머리에 끼운다(doctype 뒤 · 없으면 맨 앞). srcdoc 은 HTTP 헤더가 없어 CSP 는 meta 로만. */
function wrapAppHtml(html: string, csp?: AppCsp, extra?: string): string {
  const head = buildCsp(csp) + '<script>' + APP_RUNTIME_JS + '</script>' + (extra ? '<script>' + extra + '</script>' : '');
  const m = /<!doctype[^>]*>/i.exec(html);
  if (m) { const i = m.index + m[0].length; return html.slice(0, i) + head + html.slice(i); }
  return head + html;
}

// ── 앱 주소(#4480 v2-1) ──────────────────────────────────────────────────────────────────────────────────
//  이 브라우저가 앱 주소 쿠키를 막았던 기록 — 같은 브라우저(UA)면 7일 동안 앱 주소를 시도하지 않고 바로 srcdoc 으로 연다(매번 한 바퀴 돌지 않게).
const ADDR_BLOCK_KEY = 'lively.appAddr.blocked';
function addrBlockedHere(): boolean { try { return addrBlockValid(localStorage.getItem(ADDR_BLOCK_KEY), navigator.userAgent, Date.now()); } catch (_) { return false; } }
function markAddrBlocked(): void { try { localStorage.setItem(ADDR_BLOCK_KEY, JSON.stringify({ ua: navigator.userAgent, at: Date.now() })); } catch (_) { /* 저장소가 막혀도 이번 화면은 srcdoc 으로 바뀐다 */ } }
/** 이 워크스페이스·이 브라우저에서 앱을 앱 주소로 띄우나. */
export function appAddressOn(): boolean { return !!(state.me && state.me.app_domain) && !addrBlockedHere(); }
interface AppLaunch { url: string; origin: string; page_key?: string | null; title?: string; variant?: 'pub' | 'draft'; devices?: string[];
  /** #4485 후속 — 인사가 없을 때 바꿔 띄울 종전 화면(화면 파일)이 있나. false = 서버가 화면을 만드는 앱(화면 파일 없음) · 없으면(옛 게이트웨이) 있다고 본다. */
  fallback?: boolean }

function launchEmbed(appId: string, next: string): Promise<AppLaunch> {
  return api('/api/ui/apps/' + encodeURIComponent(appId) + '/launch', { method: 'POST', body: JSON.stringify({ mode: 'embed', next }) }) as Promise<AppLaunch>;
}

interface AppUiData { html: string; title?: string; page_key?: string; app_id?: string; pages?: Array<{ key: string; title: string }>; csp?: AppCsp;
  /** #4482 이 사람이 보는 판의 앱 주소(새 탭에서 열기) — 앱 주소가 꺼졌거나 못 만드는 이름이면 없다. */
  app_url?: string | null }
export interface AppUiFrame {
  root: HTMLElement;
  destroy(): void;
  /** 호스트 → 앱 알림(JSON-RPC notification, id 없음). 앱 SDK 가 method 로 가른다(#4225 ui/notifications/data-changed). */
  notify(method: string, params?: Record<string, unknown>): void;
  /** 앱이 그 주제를 구독했나(SDK lively.store.onChange → ui/subscribe {topic:'data'}). 다시 불러오면 새 문서가 다시 구독한다. */
  subscribed(topic: string): boolean;
  /** 같은 HTML 로 앱 화면을 처음부터 다시 띄운다 — 구독하지 않은 앱에 «최신을 보여 주는» 가장 단순한 길. */
  reload(): void;
  /** 이 프레임의 가장자리를 호스트가 가리는 폭(px)을 앱에 알린다(#4592 — 곁칸의 독). 다시 불러온 새 문서에도 처음에 한 번 다시 알린다. */
  setInsets(i: AppInsets): void;
  /** #4482 이 앱을 새 탭(맨 앱 주소)으로 열 주소 — 앱 주소가 꺼진 워크스페이스면 null(그 자리에선 «새 탭에서 열기» 를 그리지 않는다). */
  addressUrl(): string | null;
}
export interface AppInsets { top: number; right: number; bottom: number; left: number }

/**
 * 앱 UI 를 샌드박스 iframe 으로 만들어 **프레임 + 정리 함수**를 돌려준다(호출부가 원하는 자리에 붙인다).
 *  브리지(postMessage)는 이 프레임에만 반응하는 핸들러로 걸리고 destroy() 가 떼어 낸다 — 여러 앱 UI 공존 안전.
 */
/** 앱이 호스트에 메뉴를 열어 달라고 했다 — items 는 앱의 항목(맨 위에 선다), x · y 는 **이 창** 기준 자리. 고른 앱 항목의 id 또는 null. */
export interface AppMenuRequest { items: Array<{ id: string; label: string }>; x: number; y: number }
export interface AppUiMountOpts {
  page?: string; title?: string; instanceId?: string; sessionId?: string;
  /** #4769 인스턴스 state — 앱이 lively.state 로 읽는다(#/open/<앱>?… 로 온 값: 알림을 누르면 그 채널 · 그 글로). 없으면 null. */
  state?: Record<string, unknown> | null;
  /** 앱이 호스트의 머리줄을 접거나 펴 달라고 했다(lively.ui.chrome). init = 새 문서가 막 인사했다(아직 아무것도 청하지 않았다). 없으면 그 능력이 없는 자리다. */
  onChrome?: (c: { head: boolean; init?: boolean }) => void;
  /** 앱이 호스트 메뉴를 열어 달라고 했다(lively.ui.openMenu). 없으면 못 여는 자리(인사의 capabilities.menu = false · 부르면 -32601). */
  onMenu?: (req: AppMenuRequest) => Promise<string | null>;
  /** 앱이 저를 화면 가득 띄워 달라고 했다(lively.ui.expand — #4629 «단추 하나로 그것만»). 없으면 못 하는 자리(capabilities.expand = false · 부르면 -32601). */
  onExpand?: () => void;
  /** #4443 앱 화면 안 글 상자에 초점이 들었다(true) · 났다(false). SDK 런타임이 바뀔 때만 알린다(ui/typing). 새 문서 · 다시 불러오기 ·
   *  내려가기에선 호스트가 false 를 한 번 부른다(옛 문서는 «났다» 를 못 보낸다). 없으면 버린다. */
  onTyping?: (on: boolean) => void;
  /** #4592 앱 만들기 — 띄우는 쪽이 앱 문서에 함께 넣는 스크립트(찍어서 의견의 탐침). 셸 코드만 넘긴다(앱이 주는 것이 아니다). */
  extraScript?: string;
}
// ── #4632 앱빌더 「③ 시안 확인 · 고치기」 가 **진짜 화면**(세션 곁칸 · 앱 화면) 위에 코멘트 층을 띄운다(app-review.ts) — 그 층이 이 프레임을 찾고(data-app-id),
//   찍은 자리의 요소를 묻고(탐침 PROBE_JS — 검토 중인 앱의 문서에만 넣는다), 새 판이 오면 다시 띄운다(reloadAppFrames). 셸 코드만 넘긴다(앱이 주는 것이 아니다).
const reviewProbe = new Set<string>();
const liveFrames = new Map<string, Set<AppUiFrame>>();
/** 이 앱의 화면을 띄울 때 탐침을 함께 넣는다(검토 중). 이미 떠 있는 프레임엔 들어가지 않는다 — 다시 띄우면(reload) 들어간다. */
export function markReviewProbe(appId: string, on: boolean): void { if (on) reviewProbe.add(appId); else reviewProbe.delete(appId); }
/** 지금 떠 있는 이 앱의 프레임을 전부 다시 띄운다(새 판). 세션 곁칸은 제 사건으로 스스로 다시 띄우니 뺀다(두 번 깜빡이지 않게). */
/** #4769 살아 있는 앱 화면에 새 state 를 민다 — 알림(#/open/<앱>?…)을 눌렀는데 그 앱이 이미 떠 있으면 다시 띄우지 않고 그 자리에서 옮겨 가게. 앱 SDK 는 lively.ui.onState 로 받는다. */
export function pushAppState(appId: string, state: Record<string, unknown>): number {
  let n = 0;
  liveFrames.get(appId)?.forEach((f) => { if (f.root.isConnected) { f.notify('ui/notifications/state', { state }); n++; } });
  return n;
}
/** 검토를 시작한다(markReviewProbe(…, true) 뒤) — 떠 있는 이 앱의 프레임 중 탐침 없이 뜬 것만 다시 띄운다(점검 3-1).
 *  검토하지 않는 동안(막대를 닫고 앱빌더로 돌아온 사이) 새 판이 와 다시 띄운 프레임은 탐침이 빠져 있다 — 그 화면을 그대로 쓰면
 *  「선택」 이 아무 답도 못 받아 위치 없는 핀만 꽂혔다. 표시(data-probe)는 띄울 때마다(reload 포함) 그때의 검토 상태로 다시 적는다. 세션 곁칸도 포함한다. */
export function ensureReviewProbe(appId: string): number {
  let n = 0;
  liveFrames.get(appId)?.forEach((f) => { if (f.root.isConnected && f.root.getAttribute('data-probe') !== '1') { f.reload(); n++; } });
  return n;
}
export function reloadAppFrames(appId: string): number {
  let n = 0;
  liveFrames.get(appId)?.forEach((f) => { if (f.root.isConnected && !f.root.closest('.pn-sessapp')) { f.reload(); n++; } });
  return n;
}
export async function mountAppUiFrame(appId: string, opts?: AppUiMountOpts): Promise<AppUiFrame> {
  //  탐침(PROBE_JS)은 앱 주소로도 넣을 수 있다(앱 주소 쿼리 → 서버가 같은 원본을 넣는다). 그 밖의 덧붙임 스크립트는 srcdoc 으로만 넣을 수 있다.
  const wantProbe = (): boolean => reviewProbe.has(appId) || opts?.extraScript === PROBE_JS;
  const extraOther = !!opts?.extraScript && opts.extraScript !== PROBE_JS;
  let launch: AppLaunch | null = null;
  if (appAddressOn() && !extraOther) {
    //  실패(꺼짐 · 주소를 못 만드는 이름 · 권한 · 앱 없음)는 전부 종전 길로 — 그 길이 같은 판정을 다시 하고 알맞은 오류를 낸다.
    try { launch = await launchEmbed(appId, embedNext(opts?.page, wantProbe())); } catch (_) { launch = null; }
  }
  let data: AppUiData | null = null;
  const loadData = async (): Promise<AppUiData> => {
    if (data) return data;
    const q = opts?.page ? '/' + encodeURIComponent(opts.page) : '';
    const d = await api('/api/ui/apps/' + encodeURIComponent(appId) + '/ui' + q) as AppUiData;
    if (!d || typeof d.html !== 'string') throw new Error('UI 를 받지 못했습니다');
    data = d;
    return d;
  };
  const first = launch ? null : await loadData();
  const meta = { title: launch?.title || first?.title, page_key: launch?.page_key ?? first?.page_key ?? null };
  //  #4482 새 탭으로 열 맨 앱 주소 — 앱 주소로 띄웠으면 그 출처, srcdoc 이면 서버가 알려 준 주소(쿠키가 막힌 브라우저도 새 탭은 된다).
  const pagePath = embedNext(opts?.page, false);
  const addrUrl: string | null = launch ? launch.origin + pagePath : (first?.app_url ? String(first.app_url) : null);
  const appVariant: 'pub' | 'draft' | null = launch?.variant ?? null;
  const docFor = (d: AppUiData): string => wrapAppHtml(d.html, d.csp, [opts?.extraScript || '', reviewProbe.has(appId) ? PROBE_JS : ''].filter(Boolean).join('\n') || undefined);
  let doc = first ? docFor(first) : '';
  const srcdocFrame = (d: string): HTMLIFrameElement => el('iframe', {
    class: 'v2-appui-frame', title: opts?.title || meta.title || appId, 'data-app-id': appId, ...(wantProbe() ? { 'data-probe': '1' } : {}),
    sandbox: frameSandbox('srcdoc'),   // ⚠ allow-same-origin 없음 = 불투명 오리진(부모 토큰·스토리지 격리). 폼 · 대화창 · 내려받기만(#4482), 팝업 · top 이동 불허.
    srcdoc: d,
  }) as HTMLIFrameElement;
  //  앱 주소 프레임 — 다른 사이트(lvly.app)라 allow-same-origin 을 줘도 라이블리에 못 닿는다(그 출처는 앱 주소 자신).
  //   #4482 폼 · 팝업 · 내려받기 · 대화창 + 장치 권한(선언한 것만). allow 는 src 보다 먼저 서야 첫 문서부터 걸린다(붙이기 전이라 순서는 무관).
  const addrFrame = (url: string): HTMLIFrameElement => el('iframe', {
    class: 'v2-appui-frame', title: opts?.title || meta.title || appId, 'data-app-id': appId, ...(wantProbe() ? { 'data-probe': '1' } : {}),
    sandbox: frameSandbox('address'),
    allow: frameAllow(launch?.devices),
    src: url,
  }) as HTMLIFrameElement;
  //  appOrigin — 앱 주소로 떠 있을 때 그 출처(다리가 받고 보내는 상대). null = srcdoc(불투명 오리진 — '*' 로만 보낼 수 있다).
  let appOrigin: string | null = launch ? launch.origin : null;

  //  인사 감시(#4480) — 앱 주소로 띄운 문서가 정해진 시간 안에 `ui/initialize` 로 인사하지 않으면 그 자리에서 종전 srcdoc 으로 바꾼다.
  //   앱 주소의 앞단·코어가 서빙하는 앱 문서는 SDK 런타임을 머리에 달고 있고 런타임은 실리자마자 인사한다(app-ui-runtime.ts api.ready).
  //   앱 서버가 만든 문서도 게이트웨이가 런타임을 넣는다(#4485 후속 · src/apps/app-server-page.ts). 바꿔 띄울 화면 파일이 없는 앱
  //   (launch.fallback === false — 서버가 화면을 만드는 앱)은 바꾸지 않고 그 자리에 둔다(앞단 · 서버의 오류 화면이 그대로 보인다).
  //   그러니 «떴는데 말이 없다» 는 그 길이 막혔다는 뜻이다 — 앞단의 오류 화면(404·503), DNS·인증서 문제, 게이트웨이 장애 같은 것.
  //   그런 실패는 postMessage 신호를 내지 못해(오류 화면·브라우저 오류 화면) 감시가 없으면 깨진 칸이 그대로 남는다.
  //   이 브라우저를 «막힘» 으로 적지는 않는다 — 쿠키 문제가 아니라 그 순간의 장애일 수 있다(다음에 열면 다시 앱 주소로 시도한다).
  const HELLO_AFTER_LOAD_MS = 8_000;   // iframe 의 load 뒤 인사까지 — 교환 화면 → 앱 문서로 넘어가는 load 마다 다시 잰다
  const HELLO_OVERALL_MS = 20_000;     // 띄운 뒤 인사까지 — load 이벤트조차 안 오는 경우의 받침
  let greeted = false;
  let helloAfterLoad: number | null = null;
  let helloOverall: number | null = null;
  const clearHello = (): void => {
    if (helloAfterLoad !== null) window.clearTimeout(helloAfterLoad);
    if (helloOverall !== null) window.clearTimeout(helloOverall);
    helloAfterLoad = helloOverall = null;
  };
  let onSilent: () => void = () => { /* toSrcdoc 이 정해진 뒤 채운다 */ };
  const armHello = (): void => {
    clearHello(); greeted = false;
    helloOverall = window.setTimeout(() => onSilent(), HELLO_OVERALL_MS);
  };
  const onAddrLoad = (): void => {
    if (!appOrigin || greeted) return;
    if (helloAfterLoad !== null) window.clearTimeout(helloAfterLoad);
    helloAfterLoad = window.setTimeout(() => onSilent(), HELLO_AFTER_LOAD_MS);
  };

  let frame = launch ? addrFrame(launch.url) : srcdocFrame(doc);
  if (launch) { frame.addEventListener('load', onAddrLoad); armHello(); }
  const target = (): string => appOrigin || '*';
  const topics = new Set<string>();   // 앱이 구독한 주제(ui/subscribe) — 다시 불러오면 비운다(새 문서가 다시 구독한다)
  let insets: AppInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  const sendInsets = (): void => { frame.contentWindow?.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/insets', params: insets }, target()); };
  let loads = 0;

  //  앱 주소 → 종전 srcdoc 으로 그 자리에서 바꾼다(쿠키가 막힌 브라우저 · 다시 받아도 로그인이 안 됨). **새 프레임**을 만들어 갈아 끼운다 —
  //   같은 프레임의 sandbox 만 바꿔 srcdoc 을 실으면 브라우저에 따라 allow-same-origin 이 남은 채 라이블리 출처로 뜰 수 있다(토큰이 앱에 열린다).
  let switching: Promise<void> | null = null;
  const toSrcdoc = (): Promise<void> => {
    clearHello();
    if (switching) return switching;
    switching = (async () => {
      try {
        doc = docFor(await loadData());
        const next = srcdocFrame(doc);
        const old = frame;
        appOrigin = null; frame = next; topics.clear(); opts?.onTyping?.(false);
        old.replaceWith(next);
      } catch (e: any) {
        toast('앱 화면을 열지 못했어요 — ' + (e && e.message ? e.message : e), true);
      } finally { switching = null; }
    })();
    return switching;
  };
  let relaunches = 0;   // 로그인이 안 됐다는 신호에 새 코드로 다시 띄운 횟수 — 앱이 제대로 인사하면(ui/initialize) 0 으로
  const relaunch = (): void => {
    void launchEmbed(appId, embedNext(opts?.page, wantProbe()))
      .then((l) => { if (!appOrigin) return; appOrigin = l.origin; armHello(); frame.src = l.url; })
      .catch(() => { void toSrcdoc(); });
  };
  const noFallback = launch?.fallback === false;
  onSilent = (): void => {
    if (!appOrigin || greeted) return;
    if (noFallback) {
      clearHello();
      console.warn('[app-ui] 앱 주소 문서가 인사하지 않았지만 바꿔 띄울 종전 화면이 없어 그대로 둡니다 —', appId);
      return;
    }
    console.warn('[app-ui] 앱 주소 문서가 인사하지 않아 종전 화면(srcdoc)으로 바꿉니다 —', appId);
    void toSrcdoc();
  };

  // 브리지 — 이 프레임에서 온 메시지만(앱 주소면 그 출처까지). 응답 target 은 앱 주소의 출처, srcdoc 이면 '*'(불투명 오리진이라 특정 못 함 — 이 프레임만 받는다).
  const onMsg = (ev: MessageEvent): void => {
    if (ev.source !== frame.contentWindow) return;
    if (appOrigin && ev.origin !== appOrigin) return;
    //  #4480 앞단의 로그인 신호 — 쿠키가 막혔으면 이 브라우저는 srcdoc 으로, 코드가 죽었으면 새 코드로 한 번만 다시.
    const auth = appOrigin ? appAuthSignal(ev.data) : null;
    if (auth) {
      if (auth === 'cookie-blocked') { markAddrBlocked(); void toSrcdoc(); }
      else if (relaunches < 1) { relaunches++; relaunch(); }
      else void toSrcdoc();
      return;
    }
    const msg = ev.data as { method?: string; id?: unknown; params?: { name?: string; arguments?: unknown } } | null;
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return;
    const reply = (payload: unknown): void => frame.contentWindow?.postMessage(payload, target());
    if (msg.method === 'ui/subscribe') {
      // 알림(id 없음) — 답하지 않는다. 앱이 «바깥에서 바뀐 것을 스스로 다시 읽겠다»고 알린 것(#4225).
      const topic = String((msg.params as { topic?: unknown } | undefined)?.topic ?? '');
      if (topic) topics.add(topic);
      return;
    }
    if (msg.method === 'ui/typing') {
      // 알림(id 없음)이라 답하지 않는다. 앱 화면 안 글 상자에 초점이 들고 났다(#4443 폰: 쓰는 동안 셸이 아래 탭 바를 걷는다).
      opts?.onTyping?.((msg.params as { on?: unknown } | undefined)?.on === true);
      return;
    }
    if (msg.method === 'ui/omniOpen') {
      // 알림(id 없음) — 앱 화면 안에서 통합검색 키를 눌렀다(#4530). 셸이 연다. 답하지 않는다.
      //  사람의 키가 보내는 신호라 1초에 한 번이면 충분하다 — 앱이 연달아 보내 입력칸 초점을 빼앗지 못하게(격리 리뷰).
      const now = Date.now();
      if (now - lastOmniAsk > 1000) { lastOmniAsk = now; window.postMessage({ type: OMNI_MSG, open: true }, location.origin); }
      return;
    }
    if (msg.method === 'ui/initialize') {
      relaunches = 0;   // 앱 문서가 제대로 떴다 — 다음에 쿠키가 만료돼 로그인 신호가 오면 다시 한 번 새 코드로 띄울 수 있다
      greeted = true; clearHello();   // 인사 감시 끝 — 이 문서는 살아 있다
      reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { host: 'lively', app: appId, instance: opts?.instanceId ?? null, state: opts?.state ?? null, page: meta.page_key ?? null, session: opts?.sessionId ?? null, capabilities: { tools: true, menu: !!opts?.onMenu, chrome: !!opts?.onChrome, expand: !!opts?.onExpand, files_all: !!opts?.sessionId, chat: !!opts?.sessionId, me: true, grant: true, standalone: false } } });
      opts?.onChrome?.({ head: true, init: true });   // 새 문서 — 머리줄을 접어 달라는 말은 이 문서가 다시 해야 한다
      opts?.onTyping?.(false);                        // 새 문서엔 초점 든 글 상자가 없다(옛 문서가 쓰던 중이었어도)
      //  새 문서(처음 · 다시 불러옴)는 가려진 폭을 모른다 — 인사 뒤에 한 번 알린다(가리는 것이 없으면 보내지 않는다).
      if (insets.top || insets.right || insets.bottom || insets.left) sendInsets();
    } else if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (!name) { reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32602, message: 'params.name 이 필요합니다' } }); return; }
      //  세션 id 는 띄운 쪽(opts)의 것 — 앱이 arguments 에 적은 session_id 는 서버가 보지 않는다(chat/send 와 같은 규칙). 구독 AI 실행의 «초대받은 사람» 판정에 쓴다(#4488).
      const send = (): Promise<any> => api('/api/ui/apps/' + encodeURIComponent(appId) + '/tool-call', { method: 'POST', body: JSON.stringify({ name, arguments: args, ...(opts?.sessionId ? { session_id: opts.sessionId } : {}) }) });
      // 첫 호출이 '동의 없음'(403)이면 **그 자리에서 동의 창**을 띄우고 한 번 재시도한다 —
      //  UI 앱은 열 때 동의를 묻지 않으므로(그냥 화면만 보는 앱도 있다), 능력이 실제로 필요해진 순간이 물어볼 자리다.
      void send()
        .catch(async (e: any) => {
          if (e?.status !== 403 || !/동의|grant/i.test(String(e?.message || ''))) throw e;
          if (!(await ensureAppGrant(appId, opts?.title || meta.title))) throw e;
          return send();
        })
        .then((out: any) => reply({ jsonrpc: '2.0', id: msg.id ?? null, result: out?.result ?? out }))
        .catch((e: any) => reply({ jsonrpc: '2.0', id: msg.id ?? null, error: rpcFailure(e, e?.status === 403 ? -32001 : -32000) }));
    } else if (msg.method === 'chat/send') {
      // #4594 — 앱 화면이 **붙은 세션**에 글을 바로 보낸다(원준: 채우기가 아니라 보내기). 세션에 붙어 열린 화면에만 세션이 있다.
      //  서버가 세 겹(동의·주인·붙음)을 다시 보고 표식 한 줄을 붙여 /prompt 와 같은 통로로 넣는다. 멈춘 세션(409 draft)은 실패로
      //  끝내지 않고 그 세션 화면의 입력칸에 글을 넣어 둔다 — 사람이 보내면 그 말이 세션을 깨운다(#2439 되살리기 규칙).
      //  ★ 세션은 **이 프레임을 띄운 쪽(opts)** 이 안다 — 앱이 params 로 세션 id 를 말해도 믿지 않는다(남의 세션에 보내는 통로가 된다).
      //  ★ 사람이 누른 동작에서만 보낸다(격리 리뷰 차단 2b): iframe 안의 클릭은 부모 창의 transient activation 으로 전파되므로
      //   `navigator.userActivation.isActive` 가 거짓이면 앱 코드가 저 혼자(타이머·데이터 변경 콜백) 보내는 것이다 → 거부.
      //   그 API 가 없는 옛 브라우저는 막지 않는다(막으면 기능이 통째로 죽는다 — 서버의 빈도 상한이 남는다).
      const sid = opts?.sessionId ?? '';
      const text = String((msg.params as { text?: unknown } | undefined)?.text ?? '');
      if (!sid) { reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32602, message: '붙은 세션이 없습니다 — 세션에 붙은 앱 화면에서만 보낼 수 있습니다' } }); return; }
      const ua = (navigator as Navigator & { userActivation?: { isActive?: boolean } }).userActivation;
      if (ua && !ua.isActive) { reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32001, message: '사람이 누른 동작에서만 보낼 수 있습니다' } }); return; }
      const send = (): Promise<any> => api('/api/ui/apps/' + encodeURIComponent(appId) + '/chat-send', { method: 'POST', body: JSON.stringify({ session_id: sid, text }) });
      void send()
        .catch(async (e: any) => {
          if (e?.status !== 403 || !/동의|grant/i.test(String(e?.message || ''))) throw e;   // tools/call 과 같은 «그 자리에서 동의» 규칙(예전 범위 동의 포함)
          if (!(await ensureAppGrant(appId, opts?.title || meta.title))) throw e;
          return send();
        })
        .then((out: any) => reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { sent: true, session: sid, transport: out?.transport ?? null } }))
        .catch((e: any) => {
          if (e?.status === 409 && e?.body?.draft) {
            //  멈춘 세션 — 서버가 표식을 붙인 글(draft_text)을 그 세션 화면의 입력칸에 넣어 둔다(sess-input 잎 모듈 — 화면이 떠 있어야 넣힌다).
            const draft = String(e.body.draft_text || text);
            const put = putIntoSession([sid], draft);
            toast(put ? '세션이 멈춰 있어 입력칸에 넣어 두었어요 — 보내면 세션이 깨어납니다.' : '세션이 멈춰 있어요 — 세션 화면을 열고 다시 보내 주세요.');
            reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { sent: false, session: sid, draft: put } });
            return;
          }
          reply({ jsonrpc: '2.0', id: msg.id ?? null, error: rpcFailure(e, e?.status === 403 ? -32001 : -32000) });
        });
    } else if (msg.method === 'ui/chrome') {
      // #4592 — 제 머리줄이 있는 앱이 호스트의 앱 머리줄(이름 · 판 · ⋯)을 접어 달라고 한다. 그 줄을 그리는 쪽(세션의 앱 칸)만 받는다.
      const headOn = (msg.params as { head?: unknown } | undefined)?.head !== false;
      if (opts?.onChrome) opts.onChrome({ head: headOn });
      reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { ok: !!opts?.onChrome } });
    } else if (msg.method === 'ui/expand') {
      // #4629 — 앱의 단추 하나가 그 앱을 화면 가득(사이드바 없이) 띄운다. 띄울 수 있는 쪽(세션의 앱 칸)만 받는다.
      if (!opts?.onExpand) { reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: '이 화면에서는 화면 가득 띄울 수 없습니다' } }); return; }
      opts.onExpand();
      reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { ok: true } });
    } else if (msg.method === 'ui/menu') {
      // #4592 — 앱의 ⋯ 가 호스트의 앱 메뉴를 연다(앱의 항목이 맨 위). 자리는 프레임 안의 좌표로 오고, 여기서 이 창의 좌표로 옮긴다.
      //  항목은 글자뿐이다(라벨 60자 · 12개까지) — 앱이 호스트 메뉴에 그림 · 마크업을 넣을 길이 없다. 고른 것은 id 만 돌려준다.
      if (!opts?.onMenu) { reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: '이 화면에서는 호스트 메뉴를 열 수 없습니다' } }); return; }
      const mp = (msg.params ?? {}) as { items?: unknown; x?: unknown; y?: unknown };
      const items = (Array.isArray(mp.items) ? mp.items : []).slice(0, 12)
        .map((it) => ({ id: String((it as { id?: unknown })?.id ?? '').slice(0, 40), label: String((it as { label?: unknown })?.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) }))
        .filter((it) => it.id && it.label);
      const r = frame.getBoundingClientRect();
      const num = (v: unknown, max: number): number => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0; };
      void opts.onMenu({ items, x: r.left + num(mp.x, r.width), y: r.top + num(mp.y, r.height) })
        .then((picked) => reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { picked: picked && items.some((it) => it.id === picked) ? picked : null } }))
        .catch(() => reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { picked: null } }));
    } else if (msg.method === 'files/list' || msg.method === 'files/read') {
      // #4592 — 앱 화면이 **붙은 세션의 프로젝트 자료**에서 파일 목록 · 내용을 읽는다(읽기만). 서버가 선언 · 동의 · 주인 · 붙음 · 프로젝트 가시성을 다시 본다.
      //  ★ 세션은 이 프레임을 띄운 쪽(opts)이 안다 — chat/send 와 같은 까닭(앱이 말한 세션 id 를 믿으면 남의 세션 프로젝트를 읽는 통로가 된다).
      const sid = opts?.sessionId ?? '';
      if (!sid) { reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32602, message: '붙은 세션이 없습니다 — 세션에 붙은 앱 화면에서만 파일을 볼 수 있습니다' } }); return; }
      const p = (msg.params ?? {}) as { ext?: unknown; limit?: unknown; path?: unknown; scope?: unknown; q?: unknown; project?: unknown };
      const qs = new URLSearchParams({ session_id: sid });
      const list = msg.method === 'files/list';
      if (list) {
        const ext = (Array.isArray(p.ext) ? p.ext : (p.ext == null ? [] : [p.ext])).map((x) => String(x)).filter(Boolean);
        if (ext.length) qs.set('ext', ext.join(','));
        if (p.limit != null && Number.isFinite(Number(p.limit))) qs.set('limit', String(Math.round(Number(p.limit))));
        // #4629 — 전체 자료(볼 수 있는 모든 프로젝트). 넓은 능력이라 서버가 제 선언 · 제 동의(app_workspace_files)로 따로 본다.
        if (p.scope === 'all') { qs.set('scope', 'all'); if (typeof p.q === 'string' && p.q.trim()) qs.set('q', p.q.trim().slice(0, 100)); }
      } else {
        qs.set('path', String(p.path ?? ''));
        //  프로젝트를 지목했는데 값이 이상하면 붙은 프로젝트로 조용히 돌리지 않는다(같은 이름의 다른 파일이 읽힌다).
        if (p.project != null) {
          if (typeof p.project !== 'number' || !Number.isInteger(p.project) || p.project <= 0) { reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32602, message: 'project 는 전체 자료 목록이 준 project_id(양의 정수)여야 합니다' } }); return; }
          qs.set('project_id', String(p.project));
        }
      }
      const read = (): Promise<any> => api('/api/ui/apps/' + encodeURIComponent(appId) + (list ? '/files?' : '/file?') + qs.toString());
      void read()
        .catch(async (e: any) => {
          if (e?.status !== 403 || !/동의|grant/i.test(String(e?.message || ''))) throw e;   // «그 자리에서 동의» — 앱이 갱신돼 이 권한을 새로 얻었을 때도
          if (!(await ensureAppGrant(appId, opts?.title || meta.title))) throw e;
          return read();
        })
        .then((out: any) => reply({ jsonrpc: '2.0', id: msg.id ?? null, result: out }))
        .catch((e: any) => reply({ jsonrpc: '2.0', id: msg.id ?? null, error: rpcFailure(e, e?.status === 403 ? -32001 : -32000) }));
    } else if (msg.method === 'prefs/get' || msg.method === 'prefs/set') {
      // #4601 — 앱 × 보는 사람의 개인 설정. 샌드박스 화면은 localStorage 가 없고(불투명 오리진) SDK 에 신원이 없어 서버가 든다.
      //  동의와 무관하다(설정은 라이블리 데이터가 아니라 그 사람이 앱을 보는 방식) — 그래서 tools/call 이 아니라 별도 경로.
      const path = '/api/ui/apps/' + encodeURIComponent(appId) + '/prefs';
      const req = msg.method === 'prefs/get'
        ? api(path)
        : api(path, { method: 'POST', body: JSON.stringify({ patch: (msg.params as { patch?: unknown } | undefined)?.patch ?? {} }) });
      void req
        .then((out: any) => reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { prefs: (out && out.prefs) || {} } }))
        .catch((e: any) => reply({ jsonrpc: '2.0', id: msg.id ?? null, error: rpcFailure(e, e?.status === 413 ? -32602 : -32000) }));
    } else if (msg.method === 'ui/me') {
      // #4482 — 보는 사람 · 워크스페이스 · 이 앱 · 붙은 세션(lively.me). 앱 주소의 /_lively/me 와 같은 꼴 — srcdoc 길에는 같은 주소 API 가 없어
      //  호스트가 답한다. 세션은 이 프레임을 띄운 쪽이 안다(앱 주소의 /_lively/me 는 쿠키가 여러 프레임에 같아 세션을 모른다).
      const me = (state.me || {}) as { userId?: string; email?: string; display_name?: string; workspace_registry?: { current?: string } };
      reply({ jsonrpc: '2.0', id: msg.id ?? null, result: {
        member: { id: me.userId || '', name: me.display_name || me.userId || '', email: me.email || null },
        workspace: { slug: me.workspace_registry?.current || null },
        app: { id: appId, variant: appVariant },
        session: opts?.sessionId ?? null,
      } });
    } else if (msg.method === 'ui/grant') {
      // #4482 — 앱이 동의를 청한다(lively.requestConsent — 앱이 /_lively/* 를 fetch 로 직접 부르다 403 consent_required 를 받았을 때).
      //  사람이 누른 동작 안에서만 창을 띄운다(앱 혼자 창을 거듭 띄워 사람을 괴롭히지 못하게 — chat/send 와 같은 판정).
      const ua = (navigator as Navigator & { userActivation?: { isActive?: boolean } }).userActivation;
      if (ua && !ua.isActive) { reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32001, message: '사람이 누른 동작에서만 동의를 청할 수 있습니다' } }); return; }
      void ensureAppGrant(appId, opts?.title || meta.title)
        .then((granted) => reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { granted } }))
        .catch((e: any) => reply({ jsonrpc: '2.0', id: msg.id ?? null, error: rpcFailure(e, -32000) }));
    } else if (msg.method === 'ui/openExternal') {
      // srcdoc(allow-popups 없음)에선 앱이 새 탭을 못 연다 — 호스트가 대신 연다(앱 주소 iframe 은 팝업이 되지만 열린 창도 같은 제한을 받아 이 길이 낫다). http(s)만, noopener.
      const raw = String((msg.params as { url?: unknown } | undefined)?.url ?? '');
      let ok = false;
      try { const u = new URL(raw); ok = u.protocol === 'https:' || u.protocol === 'http:'; } catch { ok = false; }
      if (!ok) { reply({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32602, message: 'http(s) 주소가 아닙니다' } }); return; }
      const w = window.open(raw, '_blank', 'noopener');
      if (!w) toast('새 탭이 팝업 차단으로 막혔어요 — 주소창 옆의 차단 아이콘에서 허용해 주세요.', true);
      reply({ jsonrpc: '2.0', id: msg.id ?? null, result: { opened: !!w } });
    }
    // 그 밖(ui/message 등)은 v1 에선 무시.
  };
  window.addEventListener('message', onMsg);
  const handle: AppUiFrame = {
    //  root 는 **지금의** 프레임이다 — 앱 주소에서 srcdoc 으로 갈아 끼우면 바뀐다(같은 자리에 들어가므로 붙인 쪽은 따로 할 일이 없다).
    get root(): HTMLElement { return frame; },
    destroy: () => { clearHello(); window.removeEventListener('message', onMsg); frame.remove(); opts?.onTyping?.(false); liveFrames.get(appId)?.delete(handle); },
    notify: (method, params) => { frame.contentWindow?.postMessage({ jsonrpc: '2.0', method, params: params ?? {} }, target()); },
    subscribed: (topic) => topics.has(topic),
    // 같은 값을 다시 넣으면 브라우저가 다시 띄우지 않을 수 있어 매번 끝에 주석 한 줄을 바꿔 단다(문서 밖 — 앱은 모른다).
    //  WindowProxy 는 같은 프레임이면 그대로라 브리지(ev.source 비교)는 새 문서에도 그대로 맞는다.
    //  탐침은 다시 띄울 때의 검토 상태로 다시 정한다(markReviewProbe 뒤 reloadAppFrames 가 부른다). 앱 주소면 새 코드로 다시 연다.
    reload: () => {
      topics.clear(); opts?.onTyping?.(false);
      if (wantProbe()) frame.setAttribute('data-probe', '1'); else frame.removeAttribute('data-probe');   // 이번에 띄우는 문서에 탐침이 드나(ensureReviewProbe 가 읽는다)
      if (appOrigin) { relaunch(); return; }
      const d = data as AppUiData | null;   // srcdoc 으로 떠 있으면 이미 읽어 두었다(loadData)
      if (d) doc = docFor(d);
      frame.srcdoc = doc + '<!-- lively:reload ' + (++loads) + ' -->';
    },
    addressUrl: () => addrUrl,
    setInsets: (i) => {
      const n = (v: number): number => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
      const next = { top: n(i.top), right: n(i.right), bottom: n(i.bottom), left: n(i.left) };
      if (next.top === insets.top && next.right === insets.right && next.bottom === insets.bottom && next.left === insets.left) return;
      insets = next; sendInsets();
    },
  };
  if (!liveFrames.has(appId)) liveFrames.set(appId, new Set());
  liveFrames.get(appId)!.add(handle);
  return handle;
}

// ── 모달로 열기(전역 런치패드용) — 세션 화면 밖에서 앱 UI 를 띄울 때. panes 탭은 mountAppUiFrame 을 직접 쓴다. ──
let uiEl: HTMLElement | null = null;
let openFrame: AppUiFrame | null = null;
let onCloseFn: (() => void) | null = null;   // 새 탭(#/full/…)으로 연 것이면 닫을 때 그 탭을 닫는다

//  #4600 sessionId — 붙은 앱 탭의 「크게 보기」가 같은 세션에 붙은 채로 크게 띄운다(앱 안의 lively.session 이 그대로 선다).
//  크게 보기는 **늘 화면 가득**이다(원준 2026-10-12 «모달로 띄우는데 개짝아 · 완전 전체화면으로») — 사이드바도 여백도 없이 그 앱만, 머리줄 한 줄(이름 · 닫기).
//   창 크기 ⇄ 화면 가득 토글(#4592 2026-10-09)은 걷었다: 모드가 둘이면 «크게» 를 눌렀는데 작게 뜨는 일이 생긴다. full 옵션은 호환으로만 남는다(늘 가득).
/** 「크게 보기」 가 새 탭으로 여는 주소 — #/full/<앱>?s=<세션>&page=<화면>&t=<제목>. 그 탭은 사이드바 없이 그 앱만 띄운다(main.ts 의 full 갈래). */
export function appFullHref(appId: string, opts?: { page?: string; title?: string; sessionId?: string }): string {
  const q = new URLSearchParams();
  if (opts?.sessionId) q.set('s', opts.sessionId);
  if (opts?.page) q.set('page', opts.page);
  if (opts?.title) q.set('t', opts.title);
  const qs = q.toString();
  return location.pathname + location.search + '#/full/' + encodeURIComponent(appId) + (qs ? '?' + qs : '');
}
/** 폰(세웠거나 눕힌) — mobile.ts 의 isPhone 과 같은 문턱(폭 ≤640 · 또는 ≤900 에 높이 ≤500). 폰은 새 탭으로 보내지 않는다(되돌아오기 어렵다). */
function phoneNow(): boolean { try { return window.matchMedia('(max-width: 640px), ((max-width: 900px) and (max-height: 500px))').matches; } catch (_) { return false; } }
/** 「크게 보기」 — **새 탭**에서 그 앱만 화면 가득(원준 2026-10-12 «크게보기를 누르면 바로 거기로 보내 · 모달 띄우지 말고»).
 *  사람이 누른 자리에서 곧바로 부른다(window.open 은 그 동작 안에서만 열린다). 팝업이 막혔거나 폰이면 이 탭 위에 가득 띄운다(#4443). */
export function openAppBig(appId: string, opts?: { page?: string; title?: string; sessionId?: string }): void {
  if (!phoneNow()) {
    let w: Window | null = null;
    try { w = window.open(appFullHref(appId, opts), '_blank'); } catch (_) { w = null; }
    if (w) return;
  }
  void openAppUi(appId, opts);
}

export async function openAppUi(appId: string, opts?: { page?: string; title?: string; sessionId?: string; full?: boolean; onClose?: () => void }): Promise<boolean> {
  try {
    const f = await mountAppUiFrame(appId, opts);
    //  앞의 덮개는 조용히 걷는다 — 그 덮개의 닫기 뒷일(onClose: 창 닫기·되돌아가기)을 새 덮개를 여는 자리에서 돌리지 않는다(#4480).
    dismissAppUi();
    openFrame = f;
    onCloseFn = opts?.onClose || null;
    uiEl = el('div', { class: 'v2-appui-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': (opts?.title || appId) + ' 앱' },
      el('div', { class: 'v2-appui' },
        el('div', { class: 'v2-appui-h' },
          el('b', { class: 'v2-appui-t', text: opts?.title || appId }),
          el('span', { class: 'v2-appui-badge', text: '앱 UI' }),
          el('span', { class: 'v2-appui-spacer' }),
          //  #4482 맨 앱 주소를 새 탭으로(라이블리 밖 · 폰 홈 화면) — 앱 주소가 켜진 워크스페이스에서만.
          ...(f.addressUrl() ? [el('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: '앱 주소를 새 탭에서 엽니다 — 라이블리 밖에서도 표 · 설정 · 앱 폴더가 그대로 돕니다',
            onclick: () => { const u = f.addressUrl(); if (u) window.open(u, '_blank', 'noopener'); } }, el('span', { text: '새 탭에서 열기' }))] : []),
          //  «(Esc)» 안내는 걷었다(2026-10-16 상민님) — 앱 화면을 한 번 누르면 Esc 는 앱 문서로 가서 셸이 못 받는다. 키(uiKey)는 셸에 초점이
          //   있을 때만 먹으니 남기되 늘 되는 것처럼 적지 않는다.
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => closeAppUi() }, el('span', { text: '닫기' }))),
        f.root));
    document.body.append(uiEl as HTMLElement);
    document.addEventListener('keydown', uiKey);
    //  #4480 초점을 덮개로 옮긴다 — 세션 터미널(iframe)에 초점이 있던 채 열면(터미널 안의 셸 링크로 연 크게 보기) 키가 덮개 뒤에 숨은
    //   터미널 문서로 가서 Esc 로 닫히지 않았다(2026-10-16 운영 실측). 머리줄을 누르거나 Esc 를 치면 셸이 받는다 — 앱 화면을 누르면
    //   초점은 앱 문서로 간다(그때 Esc 는 앱의 것). 시험: scripts/app-ui-focus-runtime.test.mjs
    (uiEl as HTMLElement).tabIndex = -1;
    (uiEl as HTMLElement).focus({ preventScroll: true });
    return true;
  } catch (e: any) {
    toast('앱 UI 를 열지 못했어요 — ' + (e && e.message ? e.message : e), true);
    return false;
  }
}

function uiKey(e: KeyboardEvent): void { if (e.key === 'Escape') closeAppUi(); }
/**
 * 덮개를 조용히 걷는다 — 닫기의 뒷일(onClose)은 하지 않는다(#4480). 화면을 옮길 때(알림 클릭 · 다른 화면으로 이동) 셸이 부른다.
 *  왜: 덮개는 셸 위에 따로 붙은 층이라 주소(해시)가 바뀌어도 남는다. 데스크톱 앱 본 창에서 크게 보기 주소(#/full/…)를 열면
 *  알림을 눌러 다른 화면으로 가도 덮개가 그대로 덮고 있었다(2026-10-14 상민님 실측).
 */
export function dismissAppUi(): void { onCloseFn = null; closeAppUi(); }
export function closeAppUi(): void {
  const was = !!uiEl, fn = onCloseFn; onCloseFn = null;
  if (openFrame) { openFrame.destroy(); openFrame = null; }
  if (uiEl) { uiEl.remove(); uiEl = null; }
  document.removeEventListener('keydown', uiKey);
  if (was && fn) fn();
}
