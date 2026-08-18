// 웹 UI 셸 (#1541) — 데스크톱 창에 **게이트웨이가 서빙하는 웹 UI(/ui/)를 그대로** 싣기 위한 판단 모음(순수).
//
// 왜 이렇게 하나: 화면 코드를 앱에 한 벌 더 두지 않는다. 웹이 곧 앱이다 — 게이트웨이가 갱신되면 앱도 같은 화면을
//  본다(#1719 결정 5 "데스크톱 재사용 규약": 새 셸은 정적 자산 + 해시 라우트 + 상대경로 API + bearer/쿠키뿐이라
//  `BrowserWindow.loadURL(<gateway>/ui/)` 로 충분하다). 앱이 더하는 건 넷뿐이다 —
//   ① 로그인 토큰 주입: CLI 가 받아 둔 `~/.lively/token` 을 그 출처의 localStorage[lively_ui_token] 에 넣는다(웹은 그 키만 본다).
//   ② 창 열기 규칙: 웹이 `window.open`·`target=_blank` 로 여는 것 중 **같은 출처**(터미널 새 창 등)는 앱 안의 새 창으로,
//      바깥(노션·IdP·문서)은 시스템 브라우저로 — 앱 안에 남의 사이트가 뜨지 않게.
//   ③ 준비 판정: CLI·로그인·키트가 다 갖춰졌을 때만 웹 창을 연다(아니면 설치 마법사).
//   ④ 401 감지: 게이트웨이가 우리 토큰을 거부하면(회수·만료) 마법사로 돌아가 다시 로그인하게 한다.
//
// ⚠ 이 파일엔 Electron 이 없다 — main.mjs 가 이 판정을 그대로 배선하고, desktop-core.test.mjs 가 표로 못박는다.

/**
 * 앱이 '다 갖춰졌다' 고 보는 조건 — **한 자리**. 트레이·마법사·창 선택이 전부 이걸 본다.
 *  종전엔 main.mjs·tray-menu.mjs·renderer/app.js 세 곳이 같은 식을 각자 적고 있었다(한 곳이 빠지면 "구 CLI 인데 완료" 같은
 *  거짓 초록불이 났다 — 실측 있었음). 이제 렌더러도 `state.ready` 를 받는다.
 * @param {object} s 상태 스냅샷
 */
export function appReady(s) {
  const st = s || {};
  return !!(st.cliFound && !st.cliOutdated && !st.cliBroken && st.loggedIn && st.kitInstalled && !st.tokenRejected);
}

/** 게이트웨이 주소 → 웹 UI 주소. 뒤 슬래시를 정리하고 `/ui/` 를 붙인다(경로 접두가 있는 게이트웨이도 그대로 살린다). 형식이 아니면 null. */
export function webUiUrl(gatewayUrl) {
  const gw = String(gatewayUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s"'`;|&$()<>\\]+$/i.test(gw)) return null;
  return gw + "/ui/";
}

/** 게이트웨이의 **출처**(scheme://host[:port]) — 토큰을 주입할 자리·같은-출처 판정의 기준. 형식이 아니면 null. */
export function webOrigin(gatewayUrl) {
  try { return new URL(String(gatewayUrl || "")).origin; } catch { return null; }
}

/**
 * 웹이 새 창을 열려 할 때(`window.open`·`target=_blank`) 어디에 열지.
 *  - "child"    같은 출처의 http(s) → 앱 안의 새 창(터미널 새 창·그래프 등 — 토큰이 같은 localStorage 라 그대로 로그인 상태)
 *  - "external" 다른 출처의 http(s) → 시스템 브라우저(노션 링크·IdP·문서 — 앱 안에 남의 사이트를 두지 않는다)
 *  - "deny"     그 외(javascript:·file:·data: 등) → 열지 않는다
 */
export function openTargetFor(url, gatewayUrl) {
  let u;
  try { u = new URL(String(url || "")); } catch { return "deny"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "deny";
  const origin = webOrigin(gatewayUrl);
  return origin && u.origin === origin ? "child" : "external";
}

/**
 * 시작할 때 어느 창을 보여줄지.
 *  - 갖춰지지 않았으면 마법사(할 일이 있다) — 로그인 자동시작으로 숨겨 떴어도 마찬가지(안 뜨면 "앱이 안 켜진다" 로 보인다).
 *  - 갖춰졌고 사람이 직접 켰으면 앱(웹 UI). 로그인 때 자동으로 숨겨 떴으면 아무 창도 안 띄운다(트레이만 — 매 부팅마다 창이 뜨면 방해다).
 * @returns {"setup"|"app"|"none"}
 */
export function startupWindow({ ready, startedHidden }) {
  if (!ready) return "setup";
  return startedHidden ? "none" : "app";
}

/**
 * 로그인 때 자동으로(숨겨) 떴나. Electron 의 로그인 항목은 플랫폼마다 신호가 다르다 —
 *  macOS 는 getLoginItemSettings().wasOpenedAsHidden / wasOpenedAtLogin, Windows 는 우리가 등록할 때 넣은 `--hidden` 인자.
 *  못 재면 false(사람이 켰다고 본다 — 창을 하나 더 띄우는 쪽이 안 띄우는 쪽보다 낫다).
 */
export function startedHiddenFrom({ platform, argv, loginItem }) {
  if (Array.isArray(argv) && argv.includes("--hidden")) return true;
  if (platform === "darwin") { const li = loginItem || {}; return !!(li.wasOpenedAsHidden || li.wasOpenedAtLogin); }
  return false;
}
/** 로그인 항목 등록 인자 — Windows 는 `--hidden` 으로, macOS 는 openAsHidden 으로 '숨겨 시작' 을 표현한다. */
export const AUTOLAUNCH_ARGS = ["--hidden"];

/**
 * 게이트웨이 응답이 '우리 토큰을 거부했다' 인가 — 그 출처의 `/api/ui/*` 가 401 이면 그렇다.
 *  `/api/ui/login`(비밀번호 틀림)은 토큰과 무관하므로 뺀다. 다른 출처(외부 창) 응답은 우리 소관이 아니다.
 * @param {{url:string,statusCode:number}} d  onHeadersReceived 의 details
 */
export function isTokenRejection(d, gatewayUrl) {
  if (!d || d.statusCode !== 401) return false;
  const gw = String(gatewayUrl || "").trim().replace(/\/+$/, "");
  const url = String(d.url || "");
  if (!gw || !url.startsWith(gw + "/api/ui/")) return false;
  const path = url.slice(gw.length).split(/[?#]/)[0];
  return path !== "/api/ui/login";
}
/** onHeadersReceived 필터 — 그 게이트웨이의 `/api/ui/*` 만 본다(전 요청을 훑지 않는다). */
export function tokenWatchFilter(gatewayUrl) {
  const gw = String(gatewayUrl || "").trim().replace(/\/+$/, "");
  return gw ? { urls: [gw + "/api/ui/*"] } : null;
}

/**
 * 웹 preload 가 시작할 때 메인에게 받는 값 — 토큰은 **그 출처에만** 넣도록 origin 을 함께 준다
 *  (preload 는 그 창이 어디를 싣든 돌므로, 다른 사이트에 우리 토큰을 흘리면 안 된다).
 */
export function webBootPayload({ gatewayUrl, token, appVersion, platform }) {
  return {
    origin: webOrigin(gatewayUrl),
    token: typeof token === "string" && token.trim() ? token.trim() : null,
    appVersion: appVersion || null,
    platform: platform || null,
  };
}

/** 웹 창 기본 크기 — 마법사(720×560)와 다르다. 웹 UI 는 3열 셸이라 좁으면 접힌다. */
export const APP_WINDOW_DEFAULT = { width: 1280, height: 840 };
export const APP_WINDOW_MIN = { width: 900, height: 600 };
