// 웹 UI 창 preload (#1541 · web-shell.mjs) — 게이트웨이의 /ui/ 를 앱 창에 실을 때 **딱 두 가지**만 한다.
//
//  ① 로그인 토큰 주입: CLI 가 받아 둔 `~/.lively/token` 을 그 출처의 localStorage[lively_ui_token] 에 넣는다.
//     웹 UI 는 그 키 하나만 본다(web/lib/net.ts) — 그래서 웹 코드는 한 줄도 바꾸지 않고 '이미 로그인된 화면' 이 된다.
//     ⚠ **출처가 게이트웨이일 때만** 넣는다. preload 는 이 창이 무엇을 싣든 돌므로(리다이렉트·외부 IdP 등)
//      출처를 안 보면 남의 사이트에 우리 토큰을 흘린다. 문서 시작 시점(페이지 스크립트보다 먼저)에 동기로 받는다 —
//      비동기면 웹의 boot() 가 토큰 없이 /api/ui/me 를 쳐서 로그인 화면이 한 번 깜빡인다.
//  ② `window.livelyDesktop` — 웹이 '데스크톱 안' 임을 알고 로그아웃을 데스크톱으로 넘기게 하는 최소 다리.
//     설치·노드를 움직이는 채널(preload.cjs 의 것)은 **여기 없다** — 원격 페이지에 CLI 실행 통로를 주지 않는다.
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
});
