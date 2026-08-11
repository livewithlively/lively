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
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog, screen } from "electron";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { locateCli, cliMissingHelp } from "./cli-locate.mjs";
import { runBootstrap, bootstrapPreview } from "./bootstrap.mjs";
import { runCli, reduceProgress, cliContractVerdict } from "./cli-runner.mjs";
import { trayMenuModel } from "./tray-menu.mjs";
import { IPC, RUN_KINDS, RETRYABLE_KINDS, argvFor } from "./ipc-contract.mjs";
import { TRAY_ICON_1X, TRAY_ICON_2X } from "./tray-icon.mjs";
import { shouldCheckForUpdates, updateFailureNote, updateStatusNote, UPDATE_INTERVAL_MS, UPDATE_OPT_OUT_ENV } from "./update-policy.mjs";
import { normalizeBounds, pickBounds } from "./window-bounds.mjs";
import { LOG_VIEWS, resolveLogPath, tailText } from "./log-view.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVELY_DIR = join(process.env.LIVELY_HOME || homedir(), ".lively");

const BOUNDS_FILE = join(LIVELY_DIR, "desktop-window.json");

let tray = null, win = null, quitting = false;
let running = null;                 // { kind, handle } — 지금 도는 CLI(동시 1개)
let lastRun = null;                 // 마지막으로 시도한 { kind, opts } — '다시 시도' 가 이걸 그대로 다시 돈다
let updateNote = null;              // 업데이트 확인 결과 한 줄(사람용)
let state = {                       // 트레이·렌더러가 함께 보는 스냅샷
  cliPath: null, cliFound: false, gatewayUrl: null, loggedIn: false, kitInstalled: false,
  nodeRegistered: false, nodeDaemon: false, nodeRunning: false, busy: false,
};
let progress = null;
const pendingPrompts = new Map();   // prompt id → resolve (렌더러의 답을 기다린다)

// ── 상태 ────────────────────────────────────────────────────────────────────
// 파일 존재는 **싸고 즉시** 알 수 있는 축이라 먼저 채운다(창을 여는 판단이 여기 달렸다).
//  노드의 실행 여부는 프로세스를 재야 알 수 있어 `lively status --json` 으로 따로 가져온다(#1541 T4).
//  ⚠ 못 잰 축은 null 로 남긴다 — 모르는 걸 false 로 눕히면 화면이 "정지됨" 이라고 거짓말한다.
async function refreshState({ deep = false } = {}) {
  const cliPath = locateCli(existsSync);
  const next = { ...state, cliPath, cliFound: !!cliPath };
  next.gatewayUrl = readTrim(join(LIVELY_DIR, "gateway-url"));
  next.loggedIn = existsSync(join(LIVELY_DIR, "token"));
  next.kitInstalled = existsSync(join(LIVELY_DIR, "kit-version"));
  next.nodeRegistered = existsSync(join(LIVELY_DIR, "node-agent.env"));
  next.appAutoLaunch = appAutoLaunchEnabled();
  // 버전 — 제보·지원에서 가장 먼저 묻는 값인데 화면 어디에도 없었다. 두 축을 따로 보여준다:
  //  앱(=이 바이너리)과 키트(=CLI 가 설치한 것). 서로 다른 주기로 갱신되므로 하나로 합치면 오해가 된다.
  next.appVersion = safeAppVersion();
  next.kitVersion = readTrim(join(LIVELY_DIR, "kit-version"));
  next.updateNote = updateNote;
  // 재시도는 **실패한 게 있고 그게 안전한 작업일 때만** 제안한다(렌더러가 판단하지 않는다).
  next.retryable = !!(lastRun && RETRYABLE_KINDS.includes(lastRun.kind));
  next.logViews = LOG_VIEWS.map((v) => ({ id: v.id, label: v.label }));
  state = next;
  renderTray(); send(IPC.STATE, state);
  if (deep && cliPath && !running) await refreshNodeStatus(cliPath);
  return state;
}

/** `lively status --json` 의 node 축을 읽어 실제 상태로 덮는다(폴링·작업 직후). */
async function refreshNodeStatus(cli) {
  const r = await runCli({ cli, args: argvFor("status"), env: { ...process.env }, timeoutMs: 30_000 });
  // ★ 같은 호출로 '이 CLI 가 우리 말을 아는가' 도 같이 안다 — 앱보다 먼저 CLI 를 깔아 둔 PC 는 구 CLI 가
  //  `--json-events` 를 조용히 무시하고 exit 0 으로 끝낸다(이벤트 0개). 그걸 모르면 앱은 아무 설명 없이 멈춘다.
  const verdict = cliContractVerdict(r);
  if (verdict !== "failed") state = { ...state, cliOutdated: verdict === "too-old" };
  const n = r.result?.node;
  if (!r.ok || !n) { renderTray(); send(IPC.STATE, state); return; }   // 못 읽었으면 **건드리지 않는다**(옛 값이 추측보다 낫다)
  state = { ...state, nodeRegistered: !!n.registered, nodeDaemon: !!n.daemon, nodeRunning: n.running, nodeId: n.id || null };
  renderTray(); send(IPC.STATE, state);
}
function readTrim(p) { try { return readFileSync(p, "utf8").trim() || null; } catch { return null; } }
/** 개발 실행(electron .)에서는 Electron 자신의 버전이 나온다 — 그래도 없는 척하지 않고 그대로 보여준다. */
function safeAppVersion() { try { return app.getVersion(); } catch { return null; } }

// ── 창 배치 기억 ────────────────────────────────────────────────────────────
// 판단(화면 밖 좌표 버리기·최소 크기)은 window-bounds.mjs 가 하고 여기선 읽고 쓰기만 한다.
function loadBounds() {
  try { return normalizeBounds(JSON.parse(readFileSync(BOUNDS_FILE, "utf8")), workAreas()); }
  catch { return normalizeBounds(null, workAreas()); }
}
function workAreas() {
  try { return screen.getAllDisplays().map((d) => d.workArea); } catch { return []; }
}
function saveBounds() {
  // 최소화·전체화면 상태의 좌표를 저장하면 다음 실행이 그 이상한 자리에서 뜬다 — 정상 상태일 때만 남긴다.
  try {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const b = pickBounds(win.getNormalBounds ? win.getNormalBounds() : win.getBounds());
    if (!b) return;
    mkdirSync(LIVELY_DIR, { recursive: true });
    writeFileSync(BOUNDS_FILE, JSON.stringify(b));
  } catch { /* 저장 실패는 치명이 아니다 — 다음에 기본 위치로 뜰 뿐 */ }
}

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
  // 노드의 자동 시작 = OS 데몬 등록. `node --daemon` 이 켜고 `node stop` 이 끈다(등록·번들은 남는다).
  if (id === "node-autostart") return start(state.nodeDaemon ? "node-stop" : "node-start", {});
  if (id === "app-autolaunch") return setAppAutoLaunch(!state.appAutoLaunch);
}

// ── 앱 자동 시작 (#1541 T4) ─────────────────────────────────────────────────
// ⚠ **노드의 자동 시작과 다른 축이다.** 노드는 OS 데몬이 살리므로 앱이 없어도 돈다 — 이건 순전히
//  '리모컨을 로그인할 때 띄울까' 다. 그래서 기본은 꺼짐이고, 사람이 켤 때만 켠다.
//  Electron 의 loginItem 은 macOS(로그인 항목)·Windows(Run 키)를 한 API 로 덮는다. Linux 는 미지원이라
//  false 를 그대로 돌려준다(있는 척하지 않는다).
function appAutoLaunchEnabled() {
  try { return process.platform === "linux" ? null : !!app.getLoginItemSettings().openAtLogin; } catch { return null; }
}
function setAppAutoLaunch(on) {
  try {
    // openAsHidden: 로그인 때 창을 띄우지 않는다 — 트레이 앱이 매 부팅마다 창을 열면 그건 방해다.
    app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true });
  } catch { /* 미지원 플랫폼 */ }
  void refreshState();
}

// ── 자동 업데이트 (#1541 T6) ─────────────────────────────────────────────────
// ⚠ **앱 자신의 갱신**이다 — 키트 자동 업데이트(#858)와 다른 축이다(그건 CLI 가 자기 키트를 갱신한다).
// 실패는 치명이 아니다(앱은 그대로 쓴다) → 오류 팝업을 띄우지 않고 로그·상태로만 남기고, 한 번 실패하면
//  이 세션엔 다시 묻지 않는다(같은 팝업이 6시간마다 반복되는 것보다 낫다).
let updateFailed = false;
async function checkUpdates() {
  const verdict = shouldCheckForUpdates({
    packaged: app.isPackaged, platform: process.platform,
    // 빌드에 배포처가 **실제로** 박혔나. ⚠ 상수 true 로 두면 안 된다 — 설치기 없이 만든 빌드(`--dir`,
    //  포터블, 개발자가 손으로 푼 것)엔 `app-update.yml` 이 없어 electron-updater 가 ENOENT 로 죽는다.
    //  Windows 실기기에서 실제로 그랬다: "Checking for update" → ENOENT app-update.yml.
    //  그 파일이 곧 "이 빌드는 어디서 갱신을 받는다"의 증거이므로, 있는지를 직접 본다.
    hasPublishConfig: existsSync(join(process.resourcesPath || "", "app-update.yml")),
    // mac 서명 여부는 런타임에 확실히 알기 어렵다 — 서명된 앱만 통과하는 게이트키퍼 판정을 대신 쓴다.
    macSigned: process.platform !== "darwin" || app.isPackaged && !!process.mas === false && isMacSigned(),
    optOut: process.env[UPDATE_OPT_OUT_ENV], failedBefore: updateFailed,
  });
  // 왜 안 하는지도 **화면에** 남긴다 — 로그에만 적으면 사용자는 '업데이트가 되는 앱인지'조차 모른다.
  updateNote = updateStatusNote(verdict.reason);
  if (!verdict.ok) { send(IPC.LOG, { stream: "raw", line: updateNote }); void refreshState(); return; }
  try {
    const { autoUpdater } = (await import("electron-updater")).default;
    autoUpdater.autoDownload = true;
    autoUpdater.on("error", (e) => { updateFailed = true; updateNote = updateFailureNote(e); send(IPC.LOG, { stream: "raw", line: updateNote }); void refreshState(); });
    autoUpdater.on("update-not-available", () => { updateNote = "최신 버전입니다."; void refreshState(); });
    autoUpdater.on("update-downloaded", (i) => { updateNote = `새 버전 ${i?.version || ""} 을 받았습니다 — 앱을 다시 켜면 적용됩니다.`; void refreshState(); });
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (e) { updateFailed = true; updateNote = updateFailureNote(e); send(IPC.LOG, { stream: "raw", line: updateNote }); }
  void refreshState();
}
/** mac 서명 여부 — 서명되지 않은 번들은 codesign 검증에 실패한다. 못 재면 '서명 안 됨' 으로 본다(안전측). */
function isMacSigned() {
  try {
    return spawnSync("codesign", ["-dv", app.getAppPath().replace(/\/Contents\/Resources\/app(\.asar)?$/, "")], { stdio: "ignore" }).status === 0;
  } catch { return false; }
}

// ── 창 ──────────────────────────────────────────────────────────────────────
function showWindow() {
  if (win) { win.show(); win.focus(); return win; }
  // 지난번 자리·크기로 연다. 모니터를 뺐거나 해상도가 바뀌었으면 좌표를 버린다(window-bounds.mjs) —
  //  안 그러면 창이 보이지 않는 곳에 떠서 사용자에겐 "앱이 안 열린다" 로 보인다.
  const b = loadBounds();
  win = new BrowserWindow({
    ...b, minWidth: 560, minHeight: 420, title: "라이블리", show: false,
    webPreferences: {
      preload: join(HERE, "..", "preload", "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,   // 렌더러는 신뢰하지 않는다
    },
  });
  win.once("ready-to-show", () => win.show());
  // 창을 닫아도 앱은 트레이에 남는다 — 노드 리모컨이 사라지면 안 된다.
  //  ⚠ 자리는 **숨기기 직전에** 저장한다. 'closed' 는 트레이 상주라 앱 종료 때까지 안 올 수도 있다.
  win.on("close", (e) => { saveBounds(); if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on("closed", () => { win = null; });
  win.on("moved", saveBounds);
  win.on("resized", saveBounds);
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

  lastRun = { kind, opts: opts || {} };   // '다시 시도' 가 쓸 값 — 렌더러가 argv 를 다시 만들지 않게 메인이 기억한다
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
  state = { ...state, busy: false };
  await refreshState({ deep: true });          // 방금 바꾼 상태를 **실측으로** 되읽는다(추측으로 그리지 않는다)
  renderTray(); send(IPC.STATE, state);
  send(IPC.PROGRESS, progress);
  return { ok: r.ok, error: r.error, result: r.result };
}

/**
 * 온보딩 (#1541 T3) — 주소 입력 한 번으로 **끝까지** 간다: (없으면) CLI 부트스트랩 → `lively setup`.
 *
 * `setup` 은 CLI 안에서 로그인 + 설치를 순서대로 한다. 앱이 login·install 을 따로 부르지 않는 이유가 그거다 —
 *  그 순서·조건(이미 로그인돼 있으면 설치만 등)은 CLI 가 이미 알고 있고, 앱이 다시 판단하면 규약이 둘로 갈린다.
 */
async function onboard(url) {
  if (running) return { ok: false, error: "이미 실행 중인 작업이 있습니다." };
  try { argvFor("login", { gateway: url }); } catch (e) { return { ok: false, error: e.message }; }  // 형식 검사(한 자)
  const gw = String(url || "").trim();

  // ★ 부트스트랩 조건은 '**CLI 가 없다**' 가 아니라 '**쓸 수 있는 CLI 가 없다**' 다.
  //  앱보다 먼저 CLI 를 깔아 둔 PC 가 흔한데(=지금까지 CLI 로 쓰던 모든 사람), 그 구 CLI 는 `--json-events` 를
  //  조용히 무시하고 exit 0 으로 끝낸다 → 앱은 이벤트를 하나도 못 받고 아무 설명 없이 멈춘다.
  //  종전엔 '있으면 그대로 몬다' 라서 이 상태가 **영원히 안 풀렸다**(사람이 손으로 부트스트랩 한 줄을 쳐야 했다).
  const existing = locateCli(existsSync);
  if (existing && state.cliOutdated === undefined) await refreshNodeStatus(existing);   // 아직 안 재봤으면 지금 잰다
  if (!existing || state.cliOutdated) {
    // 새 PC(또는 계약을 모르는 구 CLI) — 게이트웨이가 서빙하는 부트스트랩으로 Node·CLI·PATH 를 확보한다.
    // 문구가 사실과 맞아야 한다 — 이미 있는 걸 갈아끼우는 중에 "설치 중" 이라고 하면 사람은 뭘 하는지 모른다.
    const label = existing ? "라이블리 CLI 업데이트 중(설치된 버전이 오래됐습니다)" : "라이블리 CLI 설치 중";
    state = { ...state, busy: true }; renderTray(); send(IPC.STATE, state);
    progress = reduceProgress(null, { t: "start", cmd: "bootstrap" });
    progress = reduceProgress(progress, { t: "step", id: "bootstrap", label, status: "start", i: 1, n: 2 });
    send(IPC.PROGRESS, progress);
    send(IPC.LOG, { stream: "raw", line: `$ ${bootstrapPreview(gw) || ""}` });   // 무엇을 실행하는지 숨기지 않는다
    const b = await runBootstrap({ gatewayUrl: gw, onLine: (line) => send(IPC.LOG, { stream: "stderr", line }), timeoutMs: 15 * 60_000 });
    // ★ 종료코드가 아니라 **CLI 가 실제로 생겼는지**로 판정한다 — `curl | sh` 는 curl 이 404 를 받아도 0 으로 끝난다.
    const cli = locateCli(existsSync);
    // ★ 업그레이드였다면 **실제로 말이 통하게 됐는지 다시 잰다.** 파일이 있다는 것만으로 넘어가면,
    //  부트스트랩이 옛 키트를 그대로 남긴 경우(주소 오타로 404 등) 똑같은 침묵이 한 번 더 반복된다.
    if (cli && existing) { state = { ...state, cliOutdated: undefined }; await refreshNodeStatus(cli); }
    const stillBad = !cli || (existing && state.cliOutdated);
    if (stillBad) {
      progress = reduceProgress(progress, { t: "step", id: "bootstrap", label, status: "fail", i: 1, n: 2 });
      progress = reduceProgress(progress, { t: "end", ok: false, code: 1 });
      state = { ...state, busy: false }; renderTray(); send(IPC.STATE, state); send(IPC.PROGRESS, progress);
      return {
        ok: false,
        error: b.error || (cli
          ? `CLI 를 업데이트했는데도 여전히 옛 버전입니다. 그 주소가 최신 키트를 서빙하는지 확인해 주세요: ${gw}`
          : `CLI 설치가 끝났는데 실행파일이 없습니다. 주소가 맞는지 확인하세요: ${gw}`),
      };
    }
    progress = reduceProgress(progress, { t: "step", id: "bootstrap", label, status: "done", i: 1, n: 2 });
    send(IPC.PROGRESS, progress);
    state = { ...state, busy: false, cliPath: cli, cliFound: true };
    await refreshState();
  }
  // 로그인 + 키트 설치는 CLI 의 setup 이 통째로 한다(순서·조건은 거기가 정본).
  return start("setup", { gateway: gw });
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
  // ★ 답한 프롬프트는 진행 상태에서도 지운다. 안 지우면 다음 step 이벤트가 올 때 리듀서의 옛 prompt 로
  //  **카드가 다시 뜬다** — 사용자는 방금 누른 확인을 또 보게 되고, 어느 게 유효한지 알 수 없다
  //  (실측: 맥 풀 플로우에서 '예' 를 세 번 누르게 됐다).
  progress = progress ? { ...progress, prompt: null } : progress;
  send(IPC.PROGRESS, progress);
  return { ok: true };
});
ipcMain.handle(IPC.SET_GATEWAY, (_e, { url }) => onboard(url));
// 다시 시도 — **렌더러가 무엇을 재시도할지 정하지 않는다.** 메인이 기억한 마지막 작업을 그대로 돌린다
//  (렌더러가 kind 를 보내면 '실패한 것'과 '보내고 싶은 것'이 갈라져 임의 작업 실행 통로가 된다).
ipcMain.handle(IPC.RETRY, () => {
  if (!lastRun) return { ok: false, error: "다시 시도할 작업이 없습니다." };
  if (!RETRYABLE_KINDS.includes(lastRun.kind)) return { ok: false, error: "이 작업은 자동으로 다시 시도하지 않습니다." };
  return start(lastRun.kind, lastRun.opts);
});
// 로그 꼬리 — id 는 화이트리스트(log-view.mjs). 경로를 렌더러가 정할 수 없다.
ipcMain.handle(IPC.READ_LOG, (_e, { id }) => {
  const p = resolveLogPath(join, LIVELY_DIR, id);
  if (!p) return { ok: false, error: "알 수 없는 로그입니다." };
  if (!existsSync(p)) return { ok: true, text: "", missing: true, path: p };
  try { return { ok: true, ...tailText(readFileSync(p, "utf8")), path: p }; }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle(IPC.CHECK_UPDATE, async () => { updateFailed = false; await checkUpdates(); return { ok: true, note: updateNote }; });
ipcMain.handle(IPC.SET_APP_AUTOLAUNCH, (_e, { on }) => { setAppAutoLaunch(!!on); return { ok: true, on: appAutoLaunchEnabled() }; });
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
    await refreshState({ deep: true });
    // 할 일이 있으면 먼저 보여준다. ⚠ `cliOutdated` 를 빼먹으면 **가장 나쁜 조합**이 된다 — 구 CLI 인 PC 는
    //  파일이 다 있어 '완료' 로 판정되니 창이 아예 안 뜨고, 트레이 앱은 조용히 앉아 아무것도 안 한다.
    //  사용자에게는 '앱이 안 켜진다' 로 보인다(실측: 이 검증 하네스가 그 상태를 그대로 잡았다).
    if (!state.cliFound || state.cliOutdated || !state.loggedIn || !state.kitInstalled) showWindow();
    // 노드는 앱 밖에서도 죽고 살아난다(OS 데몬·사용자의 `lively node stop`). 주기적으로 되읽지 않으면
    //  트레이가 옛 상태를 계속 보여준다. 30초 — 사람이 느끼기엔 실시간이고 `status` 호출은 가볍다.
    const poll = setInterval(() => { if (!running) void refreshState({ deep: true }); }, 30_000);
    if (poll.unref) poll.unref();
    void checkUpdates();
    const up = setInterval(() => void checkUpdates(), UPDATE_INTERVAL_MS);
    if (up.unref) up.unref();
  });
  // ★ 창을 다 닫아도 종료하지 않는다(트레이 상주). 기본 동작(win/linux 종료)을 반드시 덮어야 한다.
  app.on("window-all-closed", () => { /* noop — 트레이로 산다 */ });
  app.on("before-quit", () => { quitting = true; });
  app.on("activate", () => showWindow());          // macOS dock 클릭
  process.on("uncaughtException", (e) => {
    try { dialog.showErrorBox("라이블리", String(e?.stack || e)); } catch { /* 다이얼로그도 못 뜨는 상황 */ }
  });
}
