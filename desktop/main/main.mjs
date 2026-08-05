// 라이블리 데스크톱 — Electron 메인 프로세스 (#1541 T2).
//
// ⚠ **이 파일에만 Electron API 를 쓴다.** 판단이 있는 코드(CLI 탐색·구동·진행 리듀스·메뉴 모델·argv 조립)는
//  전부 옆 순수 모듈에 있고 desktop-core.test.mjs 가 덮는다. Electron 을 띄우는 검증은 CI 에서 못 하니,
//  여기 로직이 늘어나면 그만큼 검증 사각지대가 늘어난다 — 여긴 **배선만** 한다.
//
// 설계 축 셋:
//  ① 앱은 CLI 의 리모컨이다 — 설치·로그인·노드 로직을 재구현하지 않는다(#864 설치 로직 단일화).
//  ② **상시성의 주체는 앱이 아니라 OS 데몬**이다(launchd·systemd·작업 스케줄러). 앱을 꺼도 노드는 산다.
//     그래서 창을 닫아도 앱이 안 죽고(트레이 상주), 앱을 종료해도 노드는 그대로다.
//  ③ 렌더러는 신뢰하지 않는다 — contextIsolation·sandbox 켜고, argv 는 메인이 만든다(ipc-contract).
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { locateCli, cliMissingHelp } from "./cli-locate.mjs";
import { runCli, reduceProgress } from "./cli-runner.mjs";
import { trayMenuModel } from "./tray-menu.mjs";
import { IPC, RUN_KINDS, argvFor } from "./ipc-contract.mjs";
import { TRAY_ICON_1X, TRAY_ICON_2X } from "./tray-icon.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVELY_DIR = join(process.env.LIVELY_HOME || homedir(), ".lively");

let tray = null, win = null, quitting = false;
let running = null;                 // { kind, handle } — 지금 도는 CLI(동시 1개)
let state = {                       // 트레이·렌더러가 함께 보는 스냅샷
  cliPath: null, cliFound: false, gatewayUrl: null, loggedIn: false, kitInstalled: false,
  nodeRegistered: false, nodeDaemon: false, nodeRunning: false, busy: false,
};
let progress = null;
const pendingPrompts = new Map();   // prompt id → resolve (렌더러의 답을 기다린다)

// ── 상태 ────────────────────────────────────────────────────────────────────
// 노드 축(등록·데몬·실행)은 아직 CLI 가 안 알려준다 — T4 에서 `status --json` 에 붙인다.
//  그때까지 파일 존재로만 **추정**하고, 추정이라는 걸 이름(Registered)으로 드러낸다.
async function refreshState() {
  const cliPath = locateCli(existsSync);
  const next = { ...state, cliPath, cliFound: !!cliPath };
  next.gatewayUrl = readTrim(join(LIVELY_DIR, "gateway-url"));
  next.loggedIn = existsSync(join(LIVELY_DIR, "token"));
  next.kitInstalled = existsSync(join(LIVELY_DIR, "kit-version"));
  next.nodeRegistered = existsSync(join(LIVELY_DIR, "node-agent.env"));
  state = next;
  renderTray();
  send(IPC.STATE, state);
  return state;
}
function readTrim(p) { try { return readFileSync(p, "utf8").trim() || null; } catch { return null; } }

// ── 트레이 ──────────────────────────────────────────────────────────────────
function trayImage() {
  const img = nativeImage.createFromDataURL(TRAY_ICON_1X);
  img.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_2X });
  img.setTemplateImage(true);   // macOS 메뉴바 다크/라이트 자동 반전
  return img;
}
function renderTray() {
  if (!tray) return;
  const model = trayMenuModel(state);
  tray.setToolTip(`라이블리 — ${model[0]?.label ?? ""}`);
  tray.setContextMenu(Menu.buildFromTemplate(model.map((m) => (m.type === "separator"
    ? { type: "separator" }
    : { label: m.label, type: m.type, checked: m.checked, enabled: m.enabled !== false, click: () => onMenu(m.id) }))));
}
function onMenu(id) {
  if (id === "open") return showWindow();
  if (id === "quit") { quitting = true; return app.quit(); }
  if (id === "logs") return shell.openPath(join(LIVELY_DIR, "logs"));
  if (id === "open-web") return state.gatewayUrl && shell.openExternal(state.gatewayUrl);
  if (id === "setup") { showWindow(); return start("setup", {}); }
  if (id === "node-start") return start("node-start", {});
  if (id === "node-stop") return start("node-stop", {});
  if (id === "node-autostart") { showWindow(); return start(state.nodeDaemon ? "node-stop" : "node-start", {}); }
}

// ── 창 ──────────────────────────────────────────────────────────────────────
function showWindow() {
  if (win) { win.show(); win.focus(); return win; }
  win = new BrowserWindow({
    width: 720, height: 560, minWidth: 560, minHeight: 420, title: "라이블리", show: false,
    webPreferences: {
      preload: join(HERE, "..", "preload", "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,   // 렌더러는 신뢰하지 않는다
    },
  });
  win.once("ready-to-show", () => win.show());
  // 창을 닫아도 앱은 트레이에 남는다 — 노드 리모컨이 사라지면 안 된다.
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on("closed", () => { win = null; });
  win.loadFile(join(HERE, "..", "renderer", "index.html"));
  return win;
}
const send = (ch, payload) => { try { win?.webContents.send(ch, payload); } catch { /* 창 없음 */ } };

// ── CLI 구동 ────────────────────────────────────────────────────────────────
async function start(kind, opts) {
  if (running) return { ok: false, error: "이미 실행 중인 작업이 있습니다." };
  if (!RUN_KINDS.includes(kind)) return { ok: false, error: `알 수 없는 작업: ${kind}` };
  const cli = state.cliPath || locateCli(existsSync);
  if (!cli) return { ok: false, error: cliMissingHelp(state.gatewayUrl) };
  let args;
  try { args = argvFor(kind, opts); } catch (e) { return { ok: false, error: e.message }; }

  state = { ...state, busy: true }; renderTray(); send(IPC.STATE, state);
  progress = null;
  running = { kind, handle: null };
  const r = await runCli({
    cli, args,
    env: { ...process.env },
    onHandle: (h) => { if (running) running.handle = h; },
    onEvent: (e) => { progress = reduceProgress(progress, e); send(IPC.PROGRESS, progress); },
    onStderr: (line) => send(IPC.LOG, { stream: "stderr", line }),
    // 프롬프트는 **사람에게** 넘긴다. 창이 없으면 띄운다 — 답할 사람이 없으면 CLI 가 매달린다.
    onPrompt: (p) => askUser(p),
  });
  running = null;
  await refreshState();
  state = { ...state, busy: false }; renderTray(); send(IPC.STATE, state);
  send(IPC.PROGRESS, progress);
  return { ok: r.ok, error: r.error, result: r.result };
}

/** prompt → 렌더러로 넘기고 답을 기다린다. device-code 는 통지형이라 답하지 않는다(undefined). */
function askUser(p) {
  if (p.kind === "device-code") {
    showWindow();
    if (p.verification_uri_complete || p.verification_uri) shell.openExternal(p.verification_uri_complete || p.verification_uri);
    return undefined;
  }
  showWindow();
  return new Promise((resolve) => { pendingPrompts.set(p.id, resolve); });
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.handle(IPC.GET_STATE, async () => ({ state: await refreshState(), progress }));
ipcMain.handle(IPC.RUN, (_e, { kind, opts }) => start(kind, opts || {}));
ipcMain.handle(IPC.CANCEL, () => { running?.handle?.cancel(); return { ok: true }; });
ipcMain.handle(IPC.ANSWER, (_e, { id, value }) => {
  const r = pendingPrompts.get(id);
  if (!r) return { ok: false };
  pendingPrompts.delete(id); r(value);
  return { ok: true };
});
ipcMain.handle(IPC.SET_GATEWAY, async (_e, { url }) => {
  // 저장은 CLI 가 한다(형식 검사·정규화가 거기 있다) — 앱이 ~/.lively 를 직접 쓰기 시작하면 규약이 둘로 갈린다.
  try { argvFor("login", { gateway: url }); } catch (e) { return { ok: false, error: e.message }; }
  return start("login", { gateway: url });
});
// 외부 링크는 메인만 연다 — 렌더러에 shell 을 노출하면 임의 URL·파일 열기가 된다.
ipcMain.handle(IPC.OPEN_EXTERNAL, (_e, { url }) => {
  if (!/^https?:\/\//i.test(String(url || ""))) return { ok: false };
  shell.openExternal(url); return { ok: true };
});

// ── 수명 ────────────────────────────────────────────────────────────────────
// 두 번째 인스턴스는 창만 띄우고 죽는다 — 트레이 아이콘이 둘, CLI 가 동시에 둘 도는 걸 막는다.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(async () => {
    tray = new Tray(trayImage());
    tray.on("click", () => showWindow());          // Windows·Linux 는 좌클릭이 자연스럽다
    await refreshState();
    if (!state.cliFound || !state.loggedIn || !state.kitInstalled) showWindow();   // 할 일이 있으면 먼저 보여준다
  });
  // ★ 창을 다 닫아도 종료하지 않는다(트레이 상주). 기본 동작(win/linux 종료)을 반드시 덮어야 한다.
  app.on("window-all-closed", () => { /* noop — 트레이로 산다 */ });
  app.on("before-quit", () => { quitting = true; });
  app.on("activate", () => showWindow());          // macOS dock 클릭
  process.on("uncaughtException", (e) => {
    try { dialog.showErrorBox("라이블리", String(e?.stack || e)); } catch { /* 다이얼로그도 못 뜨는 상황 */ }
  });
}
