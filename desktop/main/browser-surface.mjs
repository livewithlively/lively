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
});

/** assign 이 아니라 **지워야** 하는 것들 — 값이 undefined 여도 키가 있으면 Electron 이 그걸 쓴다. */
export const WEBVIEW_DROPPED_PREFS = Object.freeze(["preload", "preloadURL"]);

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
