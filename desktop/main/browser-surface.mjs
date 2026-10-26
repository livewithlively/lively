// 브라우저 서피스 (#1829) — 앱 안에서 **임의의 웹**을 띄우기 위한 판단 모음(순수).
//
// 왜 별도 파일인가: web-shell.mjs 는 "게이트웨이의 /ui/ 를 앱 창에 싣는" 규약이고, 여기는 정반대다 —
//  **남의 사이트를 일부러 들이는** 규약이다. 신뢰 등급도, 이동 규칙도, 저장소도 다르므로 섞지 않는다.
//
// 왜 필요한가: 앱 계층(#1780)의 "웹" 앱처럼 임의 웹을 앱 안에서 보려는 화면이 있는데, `<iframe>` 은 사이트가 세운
//  `X-Frame-Options` / CSP `frame-ancestors` 에 막힌다. 실측(Electron 43.4.1 / Chromium 150 — 지식
//  embed-real-browser-in-app-xfo-measured-2026-08): `X-Frame-Options: deny` 인 github.com 이
//   · `<iframe>`          → 차단 ("Framing … violates … frame-ancestors 'none'")
//   · `<webview>`         → **통과** (본문 5,796자 실제 렌더)
//   · `WebContentsView`   → **통과** (본문 5,455자)
//  통과하는 둘은 **중첩 브라우징 컨텍스트가 아니라 별도 WebContents** 라 애초에 그 검사의 대상이 아니다.
//  ⚠ Electron 문서는 `<webview>` 를 "out-of-process iframe 으로 구현" 이라 적어 막힐 것처럼 읽히지만 실측은 통과다.
//   문서 표현을 근거로 배제하지 말 것. `<webview>` 를 고른 이유는 **DOM 요소**라 레이아웃·스크롤·z-order 가 공짜이기
//   때문이다(WebContentsView 는 네이티브 레이어라 우리 팝오버가 그 밑에 깔린다). 공식 권고는 WebContentsView 이므로
//   `<webview>` 가 깨지면 그쪽으로 후퇴한다 — 둘 다 통과하므로 후퇴해도 기능은 유지된다.
//
// 그래서 이 능력은 **데스크톱만** 줄 수 있다. 웹 코드는 `window.livelyDesktop.browserSurface` 로 능력을 감지해,
//  없으면 '새 탭으로 열기' 로 접는다(web/v2/browser-surface.ts).
//
// ⚠ 여기 실리는 건 남의 사이트다 — 웹 UI(우리 게이트웨이)와 같은 신뢰 등급이 아니다. 그래서 셋을 강제한다:
//   ① **파티션을 가른다** — 우리 토큰이 든 저장소와 섞지 않는다.
//   ② **preload 를 뗀다** — 토큰 주입 preload(web.cjs)가 남의 사이트에서 돌면 그 자리에서 토큰이 샌다.
//   ③ **node·격리 설정을 페이지가 못 정하게 한다** — `<webview>` 는 태그 속성으로 nodeintegration 을 켤 수 있다.
//      웹 UI 의 XSS 한 방이 그걸 켜면 원격 페이지가 이 PC 에서 코드를 돌린다. 값은 페이지가 아니라 여기가 정한다.
//
// ⚠ 이 파일엔 Electron 이 없다 — main.mjs 가 배선하고 desktop-core.test.mjs 가 표로 못박는다(web-shell 과 같은 규율).

/** 브라우저 서피스 계약 버전 — 웹이 `browserSurface.version` 으로 능력을 감지한다(없으면 폴백). */
export const BROWSER_SURFACE_VERSION = 1;

/** 남의 사이트 전용 저장소 — 게이트웨이 세션(토큰이 든 기본 파티션)과 절대 섞지 않는다. */
export const BROWSER_SURFACE_PARTITION = "persist:lively-browser";

/**
 * `<webview>` 에 **강제로** 덮어쓸 설정. 페이지가 태그 속성으로 무엇을 적었든 이 값이 이긴다(머리말 ③).
 *  preload 는 여기 없다 — Object.assign 으로는 지울 수 없어 호출부가 `delete` 한다(WEBVIEW_DROPPED_PREFS).
 */
export const WEBVIEW_FORCED_PREFS = Object.freeze({
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false, // 서피스 안에서 또 서피스를 열지 못하게(중첩으로 이 격리를 우회하는 길 차단)
  // 새 창은 페이지(webview 의 allowpopups 속성)가 아니라 **메인의 setWindowOpenHandler** 가 정한다(#5025).
  //  속성이 없으면 Electron 이 window.open 을 처리기에 넘기기도 전에 null 로 끝낸다(v43.3.0 electron_browser_client.cc
  //  CanCreateWindow — disablePopups). 구글 «팝업 로그인» 이 눌러도 반응 없던 원인이다. 열지 말지는 surfaceWindowOpenTarget.
  disablePopups: false,
});

/** assign 이 아니라 **지워야** 하는 것들 — 값이 undefined 여도 키가 있으면 Electron 이 그걸 쓴다. */
export const WEBVIEW_DROPPED_PREFS = Object.freeze(["preload", "preloadURL"]);

/**
 * 앱이 준비되기 **전에** 거는 Chromium 스위치 — 창이 가려지거나 다른 데스크톱 공간에 있어도 «숨김»으로 치지 않는다(#4993).
 *  왜: AI 가 쓰는 웹 칸은 사람이 다른 공간에서 일할 때(전체 화면 게임 등) 돈다. 그 사이 새로 연 페이지는 창이 숨김으로 쳐져
 *  한 번도 그려지지 않아 화면 찍기가 끝나지 않았다(실측 2026-10-25 상민님 앱). 같은 조건 13차 실측(Electron 43.3.0):
 *  스위치 없이는 렌더러 capturePage · 메인 capturePage(stayHidden 포함) · CDP · 창/게스트 backgroundThrottling 끄기 **8가지 모두 실패**,
 *  스위치를 걸면 8가지 모두 새 페이지가 22~461ms 에 찍혔다.
 *  ⚠ 대가: 가려진 창도 «보임»이라 그동안 웹 UI 의 숨김 절전(document.hidden)이 안 걸린다. 트레이로 닫거나 최소화한 창은 그대로 숨김이다.
 */
export const OCCLUDED_WINDOW_SWITCH = "disable-backgrounding-occluded-windows";

/**
 * 앱 안에서 열지 않고 **시스템 브라우저로 넘길** 서비스 — Widevine DRM 이 필요한 유료 스트리밍.
 *  실측: 순정 Electron 은 `com.widevine.alpha` 만 NotSupportedError 다(EME 자체와 H.264 는 멀쩡하고 CDM 만 없다).
 *  유튜브는 EME 를 아예 안 쓰므로 여기 없다 — 실측으로 그냥 재생된다(readyState 4, 재생 진행 확인).
 *  넘기지 않으면 사용자는 검은 화면만 보고 이유를 모른다. 밖으로 넘기는 편이 정직하다.
 */
export const DRM_HANDOFF_HOSTS = Object.freeze([
  "netflix.com",
  "disneyplus.com",
  "primevideo.com",
  "max.com",
  "hbomax.com",
  "wavve.com",
  "tving.com",
  "watcha.com",
  "coupangplay.com",
  "open.spotify.com",
  "music.apple.com",
  "tv.apple.com",
]);

/** host 가 목록의 도메인이거나 그 하위 도메인인가 — `a.b.com` 은 `b.com` 에 걸리고 `xb.com` 은 안 걸린다. */
export function hostMatches(host, list) {
  let h = String(host || "").toLowerCase();
  while (h.endsWith(".")) h = h.slice(0, -1); // 루트 표기(`a.com.`)를 정규화
  if (!h) return false;
  return (list || []).some((d) => h === d || h.endsWith("." + d));
}

/**
 * 브라우저 서피스 **안에서의** 이동 판정. web-shell 의 openTargetFor 와 규칙이 정반대다 —
 *  거긴 "남의 사이트를 앱에 들이지 않는다" 이고, 여긴 **남의 사이트를 보는 게 목적**이다.
 *   - "allow"    http(s) → 서피스 안에서 그대로 (이게 이 기능의 존재 이유다)
 *   - "external" DRM 서비스 · `mailto:`·`tel:` 처럼 OS 가 다룰 스킴 → 시스템에 넘긴다
 *   - "deny"     그 외(`javascript:`·`file:`·`data:` 등) → 열지 않는다
 */
export function surfaceNavTarget(url) {
  let u;
  try {
    u = new URL(String(url || ""));
  } catch {
    return "deny";
  }
  if (u.protocol === "mailto:" || u.protocol === "tel:") return "external";
  if (u.protocol !== "http:" && u.protocol !== "https:") return "deny";
  return hostMatches(u.hostname, DRM_HANDOFF_HOSTS) ? "external" : "allow";
}

/**
 * 웹 칸이 동시에 띄울 수 있는 팝업 창 수. Electron 엔 크롬의 팝업 차단기(사람이 누르지 않은 팝업 거르기)가 없어서,
 *  상한이 없으면 광고 페이지가 창을 끝없이 쏟을 수 있다. 로그인 팝업은 한 번에 하나라 넉넉하다.
 */
export const SURFACE_POPUP_LIMIT = 4;

/**
 * 웹 칸 안에서 **새 창**(window.open · target=_blank)을 어디서 열지 (#5025).
 *   - "popup"    앱 안의 작은 창으로 연다 — **opener 관계가 산다**. 구글·애플·마이크로소프트의 «팝업 로그인» 은 그 창이
 *                로그인 결과를 opener 로 돌려준다(postMessage). 시스템 브라우저로 넘기면 결과가 돌아올 길이 없다.
 *   - "external" 시스템 브라우저로 넘긴다
 *   - "deny"     열지 않는다
 *
 * 앱 안으로 들이는 건 **스크립트가 창 기능을 주고 연 팝업**뿐이다 — disposition "new-window" 에 기능 문자열이 있을 때.
 *  Shift+클릭도 "new-window" 지만 기능이 비어 있고 opener 도 없어서(OpenURLFromTab) 앱 안에 열면 주소줄 없는 창만 남는다.
 *  탭 성격(target=_blank 링크 · 기능 없는 window.open = "foreground-tab"/"background-tab")과 함께 시스템 브라우저로 보낸다
 *  (웹 칸엔 탭 줄이 없다 — 웹 칸의 새 탭으로 받는 건 별건, #4993). 열지 말지의 빈도·포커스 판정은 surfaceOpenGate.
 *  disposition 문자열은 Electron 이 준다(v43.3.0 electron_api_web_contents.cc — NEW_POPUP·NEW_WINDOW → "new-window").
 *  빈 주소(about:blank)는 «창을 먼저 열고 주소는 나중에 넣는» 흔한 모양이라 팝업으로는 받고, 시스템 브라우저로는 안 보낸다.
 */
export function surfaceWindowOpenTarget({ url, disposition, features, openPopups = 0 } = {}) {
  const raw = String(url || "").trim();
  const blank = !raw || /^about:blank(?:[?#]|$)/i.test(raw);
  if (disposition === "new-window" && String(features || "").trim()) {
    const t = blank ? "allow" : surfaceNavTarget(raw);
    if (t !== "allow") return t;
    return openPopups >= SURFACE_POPUP_LIMIT ? "deny" : "popup";
  }
  return surfaceNavTarget(raw) === "deny" ? "deny" : "external";
}

/** 팝업 창의 최소 크기 — 이보다 작으면 사람이 못 보고 못 닫는다(1×1 창 같은 속임수). */
export const SURFACE_POPUP_MIN_SIZE = Object.freeze({ width: 320, height: 240 });

/**
 * 팝업 창의 BrowserWindow 설정을 **우리가** 짓는다 (#5025). Electron 은 window.open 의 기능 문자열에서 frame·modal·show·
 *  alwaysOnTop·skipTaskbar·closable·focusable·transparent·opacity·x·y·width·height·titleBarStyle 등을 읽어 창 설정에 섞는다
 *  (v43.3.0 parse-features-string.ts allowedWindowOptions → guest-window-manager.ts). 그대로 쓰면 남의 페이지가 «닫기 없는
 *  모달 창(주인 창이 막힌다)» · «보이지 않는 창» · «화면 밖·화면보다 큰 창» 을 만든다.
 *  그래서 **기본 거부**다 — 받는 건 크기뿐이고 그것도 작업 영역 안으로 줄인다. 위치는 작업 영역 가운데. 나머지는 전부 고정값.
 * @param {object} requested Electron 이 섞은 설정(페이지의 기능 문자열 포함)
 * @param {{x:number,y:number,width:number,height:number}} area 주인 창이 있는 화면의 작업 영역
 */
export function surfacePopupWindowSpec(requested, area) {
  const r = requested || {};
  const a = area && area.width > 0 && area.height > 0 ? area : { x: 0, y: 0, width: 1280, height: 800 };
  const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const width = Math.round(Math.min(Math.max(num(r.width, 800), SURFACE_POPUP_MIN_SIZE.width), a.width));
  const height = Math.round(Math.min(Math.max(num(r.height, 600), SURFACE_POPUP_MIN_SIZE.height), a.height));
  return {
    width,
    height,
    x: Math.round(a.x + (a.width - width) / 2),
    y: Math.round(a.y + (a.height - height) / 2),
    show: true,
    frame: true,          // 남의 사이트는 우리 타이틀바를 그리지 않는다 — 테두리를 걷으면 닫을 자리가 없다
    thickFrame: true,
    modal: false,         // parent 와 같이 오면 주인(라이블리) 창이 막힌다
    alwaysOnTop: false,
    skipTaskbar: false,
    closable: true,
    movable: true,
    resizable: true,
    focusable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    transparent: false,
    opacity: 1,
    hasShadow: true,
    enableLargerThanScreen: false,
    hiddenInMissionControl: false,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
  };
}

/**
 * 팝업 창 webContents 의 격리 — 웹 칸과 같다. 부를 때마다 **새 객체**다(Electron 이 넘겨받은 값에 써 넣을 수 있다).
 *  · setWindowOpenHandler 의 overrideBrowserWindowOptions.webPreferences 는 페이지가 못 바꾸는 쪽이다(기능 문자열 < 부모 < 이것).
 *  · 파티션도 웹 칸 것 — window.open 으로 연 창은 opener 저장소에서 태어나지만, opener 없이 새로 만드는 창은 이 값이 없으면
 *    **기본 파티션(우리 토큰이 든 저장소)** 에 남의 사이트가 뜬다.
 *  · preload 키는 아예 두지 않는다 — 값이 undefined 여도 키가 있으면 Electron 이 그걸 쓴다(WEBVIEW_DROPPED_PREFS).
 */
export function surfacePopupWebPreferences() {
  return { ...WEBVIEW_FORCED_PREFS, partition: BROWSER_SURFACE_PARTITION };
}

/** 한 탭(opener)에서 새 창을 여는 최소 간격과 1분 상한 — surfaceOpenGate. */
export const SURFACE_OPEN_MIN_GAP_MS = 1000;
export const SURFACE_OPEN_PER_MINUTE = 6;

/**
 * 새 창(앱 안 팝업이든 시스템 브라우저든)을 지금 열어도 되는가 (#5025).
 *  Electron 엔 크롬의 팝업 차단기가 없고, 처리기엔 «사람이 눌렀나» 가 오지 않는다(HandlerDetails 에 없다 · input-event 는
 *  주 프레임만 봐서 구글 버튼 같은 다른 출처 iframe 클릭을 못 센다). 그래서 그 대신 둘을 본다 —
 *   ① 사람이 그 앱 창을 쓰고 있다(주인 창 포커스): 뒤에 깔린 창·AI 혼자 도는 탭이 사람 화면에 창을 띄우지 않는다.
 *   ② 빈도: 그 탭에서 1초에 한 번, 1분에 6번까지 — 막 열어 대는 페이지가 시스템 브라우저에 탭을 쏟지 못한다.
 * @param {{hostFocused: boolean, recent?: number[], now: number}} p recent = 그 탭이 최근 연 시각들(앞 판정의 반환값)
 * @returns {{ok: boolean, recent: number[]}} recent 는 1분 안의 기록만 남기고, 열었으면 now 를 더한다
 */
export function surfaceOpenGate({ hostFocused, recent, now } = {}) {
  const t = Number(now);
  const kept = (Array.isArray(recent) ? recent : []).filter((v) => typeof v === "number" && Number.isFinite(v) && v <= t && t - v < 60_000);
  if (!hostFocused || !Number.isFinite(t)) return { ok: false, recent: kept };
  const last = kept.length ? Math.max(...kept) : -Infinity;
  if (t - last < SURFACE_OPEN_MIN_GAP_MS || kept.length >= SURFACE_OPEN_PER_MINUTE) return { ok: false, recent: kept };
  return { ok: true, recent: [...kept, t] };
}

/**
 * 팝업 창 제목 — 앞에 **실제 호스트**를 붙인다. 팝업엔 주소줄이 없어서, 남의 페이지가 그럴듯한 로그인 화면을 띄워도
 *  어디인지 보이게 한다(크롬도 팝업엔 출처를 보인다). http(s) 가 아니면 페이지 제목 그대로.
 */
export function surfacePopupTitle(url, title) {
  let host = "";
  try {
    const u = new URL(String(url || ""));
    if (u.protocol === "http:" || u.protocol === "https:") host = u.host;
  } catch { /* 깨진 주소 — 호스트 없음 */ }
  const t = String(title || "").trim();
  if (!host) return t;
  return t && t !== host ? `${host} — ${t}` : host;
}

/**
 * UA 에서 **임베디드 표식**을 뗀다 — `Electron/43.4.1` 과 앱 이름 토큰(`Lively/0.1.0`). 남는 건 순정 Chrome UA 다.
 *  서피스 세션에만 건다(게이트웨이 세션은 그대로 — 우리 서버는 UA 로 판정하지 않는다).
 *
 *  ⚠ 이건 **보험이지 지금 고장난 것을 고치는 게 아니다.** 실측상 구글 로그인은 기본 UA(Electron 토큰 포함) 그대로도
 *   막히지 않았다 — accounts.google.com 정상 렌더, 실제 OAuth 동의 플로우도 통과, `disallowed_useragent` 는 한 번도
 *   안 나왔다. 그래도 떼는 이유: 판정은 구글 쪽 사정이라 언제든 바뀔 수 있고 떼는 비용이 0 이다.
 *   토큰 단위로만 지운다(정규식으로 문자열을 훑지 않는다 — UA 는 공백으로 갈리는 토큰열이라 이게 더 정확하다).
 */
export function cleanUserAgent(ua, appName) {
  const name = String(appName || "").trim().toLowerCase();
  const drop = (tok) => {
    const low = tok.toLowerCase();
    if (low.startsWith("electron/")) return true;
    if (name && low.startsWith(name + "/")) return true;
    return false;
  };
  return String(ua || "")
    .split(" ")
    .filter((tok) => tok && !drop(tok))
    .join(" ");
}

/**
 * `<webview>` 를 붙여도 되는가 (will-attach-webview). src 가 열 수 없는 스킴이면 **붙이지 않는다** —
 *  붙인 뒤 will-navigate 로 막으면 빈 서피스가 남아 '왜 안 되는지 모르는 화면' 이 된다.
 *  빈 src 는 허용한다(서피스를 먼저 띄우고 주소는 나중에 넣는 흐름).
 * @returns {{allow: boolean, external: boolean}} external = 앱이 아니라 시스템 브라우저로 보내야 함
 */
export function webviewAttachDecision(params) {
  const src = String((params && params.src) || "").trim();
  if (!src || src === "about:blank") return { allow: true, external: false };
  const t = surfaceNavTarget(src);
  return { allow: t === "allow", external: t === "external" };
}

/**
 * 서피스가 요구할 수 있는 권한 — 기본은 **전부 거부**다. 남의 사이트가 이 PC 의 카메라·마이크·위치를 조용히
 *  얻어가면 안 된다. 사람이 명시적으로 허용하는 흐름이 생기기 전까지는 목록이 비어 있는 게 맞다
 *  (`clipboard-read` 처럼 무해해 보이는 것도 여기 넣지 않는다 — 넣는 순간 근거가 필요해진다).
 */
export const SURFACE_ALLOWED_PERMISSIONS = Object.freeze([]);

/** 서피스 안에서 그 권한을 줄 것인가. 목록에 없으면 거부. */
export function surfacePermissionAllowed(permission) {
  return SURFACE_ALLOWED_PERMISSIONS.includes(String(permission || ""));
}
