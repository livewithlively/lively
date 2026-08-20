// 웹 UI 창 preload (#1541 · web-shell.mjs) — 게이트웨이의 /ui/ 를 앱 창에 실을 때 **딱 세 가지**만 한다.
//
//  ① 로그인 토큰 주입: CLI 가 받아 둔 `~/.lively/token` 을 그 출처의 localStorage[lively_ui_token] 에 넣는다.
//     웹 UI 는 그 키 하나만 본다(web/lib/net.ts) — 그래서 웹 코드는 한 줄도 바꾸지 않고 '이미 로그인된 화면' 이 된다.
//     ⚠ **출처가 게이트웨이일 때만** 넣는다. preload 는 이 창이 무엇을 싣든 돌므로(리다이렉트·외부 IdP 등)
//      출처를 안 보면 남의 사이트에 우리 토큰을 흘린다. 문서 시작 시점(페이지 스크립트보다 먼저)에 동기로 받는다 —
//      비동기면 웹의 boot() 가 토큰 없이 /api/ui/me 를 쳐서 로그인 화면이 한 번 깜빡인다.
//  ② `window.livelyDesktop` — 웹이 '데스크톱 안' 임을 알고 로그아웃을 데스크톱으로 넘기게 하는 최소 다리.
//     설치·노드를 움직이는 채널(preload.cjs 의 것)은 **여기 없다** — 원격 페이지에 CLI 실행 통로를 주지 않는다.
//  ③ 커스텀 타이틀바: 창이 frameless 라(웹셸 규약 web-shell.frameOptions) 페이지 위 36px 스트립을 **preload 가** 그린다.
//     웹(게이트웨이)이 아니라 여기가 소유하는 이유 — 타이틀바는 frameless 와 한 몸이라 **앱과 함께** 배포돼야 한다.
//     웹이 그리면 구 게이트웨이에 새 앱이 붙는 순간 '끌 수 없는 창'이 된다(드래그 영역이 없다). 색은 페이지의 실제
//     배경·글자색을 읽어 따라간다 — 웹에 다크모드가 언제 어떤 방식으로 들어와도 그대로 맞는다(관찰 기반, 토큰 결합 0).
//
// ⚠ CommonJS(.cjs): sandbox preload 는 CJS 만 로드된다. 채널 문자열은 ipc-contract.mjs 의 IPC_WEB 과 같아야 하며
//  desktop-core.test.mjs 가 두 곳을 맞춘다(마법사 preload 와 같은 방식).
const { contextBridge, ipcRenderer } = require("electron");

const TOKEN_KEY = "lively_ui_token";   // web/lib/net.ts 의 TOKEN_KEY 와 같은 값 — 웹이 보는 유일한 로그인 키
const boot = ipcRenderer.sendSync("lively-web:boot") || {};

try {
  if (boot.origin && window.location.origin === boot.origin && boot.token) {
    // 있으면 덮는다 — 다시 로그인해 토큰이 바뀌었을 때 옛 토큰이 남아 401 → 게이트로 튕기는 걸 막는다.
    if (window.localStorage.getItem(TOKEN_KEY) !== boot.token) window.localStorage.setItem(TOKEN_KEY, boot.token);
  }
} catch { /* localStorage 를 못 쓰는 문맥(about:blank 등) — 웹이 로그인 화면을 띄우고, 그건 정직한 상태다 */ }

contextBridge.exposeInMainWorld("livelyDesktop", {
  platform: boot.platform || null,
  appVersion: boot.appVersion || null,
  // 웹의 logout() 이 데스크톱 안이면 이걸 부른다(web/core.ts) — 메인이 CLI 로그아웃을 돌리고 창을 마법사로 바꾼다.
  logout: () => ipcRenderer.invoke("lively-web:logout"),
  // 브라우저 서피스(#1829) — **능력 선언**이다. 웹은 이게 있으면 `<webview>` 로 남의 사이트를 앱 안에 띄우고,
  //  없으면(=브라우저에서 연 웹 UI) '새 탭으로 열기' 폴백을 그린다(web/v2/browser-surface.ts).
  //  값은 메인이 준다 — preload 가 스스로 "된다" 고 말하면 게이트웨이 출처가 아닐 때도 능력이 새어 나간다.
  //  ⚠ 여긴 `<webview>` 를 **만드는 함수가 없다**. 태그는 페이지가 직접 만든다 — 우리는 만들 권한만 열어 두고,
  //   붙는 순간의 안전(preload 제거·node 차단·파티션 격리)은 메인의 will-attach-webview 가 강제한다.
  browserSurface: boot.browserSurface || null,
  // 확장(애드온) (#1829) — 서피스 세션에만 걸리는 확장의 목록·설치·제거.
  //  ⚠ **install 은 인자를 받지 않는다.** 경로를 페이지가 정할 수 있으면 웹 UI 의 XSS 한 방이 임의 파일을
  //   확장으로 심는다(그 확장은 서피스에서 도는 코드다). 메인이 네이티브 선택창을 띄우고 사람이 고른 것만 받는다.
  //  능력이 없으면(브라우저에서 연 웹 UI) 이 객체 자체가 null 이라 화면이 확장 UI 를 안 그린다.
  browserExtensions: boot.browserSurface ? {
    list: () => ipcRenderer.invoke("lively-web:ext-list"),
    install: () => ipcRenderer.invoke("lively-web:ext-install"),
    remove: (id) => ipcRenderer.invoke("lively-web:ext-remove", { id: String(id || "") }),
  } : null,
});

// ── ③ 커스텀 타이틀바 — frameless 창에서만(리눅스는 네이티브 프레임 그대로 → boot.frameless=false) ──────────
if (boot.frameless) (() => {
  const H = 36;                        // web-shell.TITLEBAR_HEIGHT 와 같은 값 — 계약 테스트가 맞춘다
  const BAR_ID = "lively-desktop-titlebar";

  /** computed color("rgb(a)…") → "#rrggbb". 투명·못 읽음 = null(호출부가 폴백). */
  const hexOf = (css) => {
    const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(String(css || ""));
    if (!m) return null;
    if (m[4] !== undefined && parseFloat(m[4]) < 0.5) return null;   // 반투명/투명은 '배경' 이 아니다
    const h = (n) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, "0");
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
  };
  /** 페이지의 실제 배경·글자색 — body 가 투명하면 html 로, 그래도 없으면 밝은 기본값. */
  const pageColors = () => {
    let bg = null, fg = null;
    try {
      const b = getComputedStyle(document.body), r = getComputedStyle(document.documentElement);
      bg = hexOf(b.backgroundColor) || hexOf(r.backgroundColor);
      fg = hexOf(b.color) || hexOf(r.color);
    } catch { /* 문서가 아직 없다 */ }
    return { bg: bg || "#ffffff", fg: fg || "#16181d" };
  };

  let raf = 0;
  const apply = () => {
    raf = 0;
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    const { bg, fg } = pageColors();
    bar.style.background = bg;
    // 경계는 글자색의 아주 옅은 판 — 다크/라이트 어느 쪽에서도 '한 장' 처럼 보이되 면이 갈라져 보이게.
    bar.style.borderBottom = `1px solid color-mix(in srgb, ${fg} 14%, transparent)`;
    // Windows 네이티브 창 버튼(WCO) 색은 메인만 바꿀 수 있다 — 관찰값을 보고한다(맥·비frameless 에선 메인이 무시).
    ipcRenderer.invoke("lively-web:titlebar", { color: bg, symbol: fg }).catch(() => { /* 비치명 */ });
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };

  const mount = () => {
    if (document.getElementById(BAR_ID) || !document.body) return;
    const style = document.createElement("style");
    style.textContent = [
      // 스트립 자체 — 전면 드래그. 위 몇 px 은 리사이즈 히트존으로 남긴다(no-drag 가 아니라 상단 여백 없이도 OS 가 처리).
      `#${BAR_ID}{position:fixed;top:0;left:0;right:0;height:${H}px;z-index:2147483000;-webkit-app-region:drag;-webkit-user-select:none;user-select:none;box-sizing:border-box}`,
      // 본문을 스트립만큼 내린다. 100vh 로 화면을 채우는 정적 컨테이너(우리 코드 — v2 셸·독립 터미널)는 명시적으로 줄인다.
      `body{margin-top:${H}px !important}`,
      `body[data-ui="v2"],body[data-ui="v2"] #app,#v2-root{height:calc(100vh - ${H}px) !important}`,
      `#ws{height:calc(100vh - ${H}px) !important}`,
      // 클래식 셸의 sticky 상단바는 뷰포트 0 에 붙는다 — 스트립 아래로 내려 겹침을 없앤다.
      `.topbar{top:${H}px !important}`,
    ].join("\n");
    document.head ? document.head.appendChild(style) : document.documentElement.appendChild(style);
    const bar = document.createElement("div");
    bar.id = BAR_ID;
    document.body.prepend(bar);
    apply();
    // 테마 전환을 관찰한다 — OS 다크모드 · 클래스/속성 토글(다크모드 세션이 무엇을 쓰든 배경색 변화로 잡힌다).
    try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", schedule); } catch { /* 구형 */ }
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-ui"] });
    mo.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-ui"] });
    // 스타일시트가 늦게 오면 첫 계산이 기본색이다 — 로드 완료 뒤 한 번 더.
    window.addEventListener("load", schedule);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
