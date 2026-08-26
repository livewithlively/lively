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
//  ④ **화면은 웹 UI 그대로다**(web-shell.mjs) — 설치·로그인·키트가 갖춰지면 창에 게이트웨이의 /ui/ 를 싣는다.
//     앱에 화면 코드를 한 벌 더 두지 않는다(웹이 곧 앱). 마법사(renderer/)는 갖춰지기 전과 노드·점검 설정에만 쓴다.
import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, shell, ipcMain, dialog, screen, session, clipboard, Notification } from "electron";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync, spawn, execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { locateCli, cliMissingHelp, cliLaunchSpec } from "./cli-locate.mjs";
import { runBootstrap, bootstrapPreview } from "./bootstrap.mjs";
import { runCli, reduceProgress, cliContractVerdict } from "./cli-runner.mjs";
import { trayMenuModel } from "./tray-menu.mjs";
import { contextMenuModel, runContextMenuAction } from "./context-menu.mjs";
import { IPC, IPC_WEB, RUN_KINDS, RETRYABLE_KINDS, argvFor } from "./ipc-contract.mjs";
import { gatewayAdvice } from "./gateway-input.mjs";
import { appReady, webUiUrl, webOrigin, openTargetFor, startupWindow, startedHiddenFrom, AUTOLAUNCH_ARGS, isTokenRejection, tokenWatchFilter, webBootPayload, APP_WINDOW_DEFAULT, APP_WINDOW_MIN, frameOptions, framelessOn, titlebarOverlayPatch, nextAfterSetup } from "./web-shell.mjs";
import { BROWSER_SURFACE_VERSION, BROWSER_SURFACE_PARTITION, WEBVIEW_FORCED_PREFS, WEBVIEW_DROPPED_PREFS, surfaceNavTarget, cleanUserAgent, webviewAttachDecision, surfacePermissionAllowed } from "./browser-surface.mjs";
import { EXTENSIONS_DIRNAME, INSTALLED_FILE, RULESET_SHIM_PAGE, RULESET_SHIM_HTML, enableRulesetsScript, manifestRulesets, parseInstalled, serializeInstalled, crxZipOffset, readZipEntries, readZipEntryData, safeExtensionId } from "./browser-extensions.mjs";
import { TRAY_ICON_1X, TRAY_ICON_2X } from "./tray-icon.mjs";
import { shouldCheckForUpdates, updateFailureNote, updateStatusNote, updateReadyNote, shouldAutoApplyUpdate, downloadProgressNote, webUpdateState, AUTO_APPLY_DELAY_MS, PROGRESS_NOTE_MIN_MS, UPDATE_INTERVAL_MS, UPDATE_OPT_OUT_ENV } from "./update-policy.mjs";
import { normalizeBounds, pickBounds } from "./window-bounds.mjs";
import { LOG_VIEWS, resolveLogPath, tailText } from "./log-view.mjs";
import { STALE_QUERY_PS, parseStaleQuery, pickStaleInstalls, staleCleanupPs, staleInstallNote } from "./win-stale-install.mjs";
import { APP_ID } from "./win-stale-install.mjs";
import { NOTIFY_DEFAULTS, snapshotSessions, diffSessions, planBanners, bannerFor, sessionHash, pickPersonEvents, planPersonBanners, rememberSeen, personLink, streamEvent, parseSse, reconnectDelay, stableStream, SEEN_MAX } from "./notify.mjs";
import { enrichPathFromLoginShell } from "./login-path.mjs";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVELY_DIR = join(process.env.LIVELY_HOME || homedir(), ".lively");

const BOUNDS_FILE = join(LIVELY_DIR, "desktop-window.json");
const APP_BOUNDS_FILE = join(LIVELY_DIR, "desktop-app-window.json");   // 웹 UI 창은 마법사와 크기·자리가 다르다 — 따로 기억
const WEB_PRELOAD = join(HERE, "..", "preload", "web.cjs");

let tray = null, win = null, quitting = false;
let appWin = null;                  // 웹 UI 창(게이트웨이 /ui/) — web-shell.mjs. 마법사 창(win)과 preload·채널이 다르다
let appLoaded = { url: null, token: null };   // 웹 창에 마지막으로 실은 주소·토큰 — 달라졌으면 다시 싣는다(재로그인 뒤 옛 토큰으로 401 나는 걸 막는다)
let rejectedToken = null;           // 게이트웨이가 401 로 거부한 토큰(문자열) — 파일의 토큰이 바뀌면(재로그인) 저절로 풀린다
let webError = null;                // 웹 창을 못 실었을 때의 사유(사람용 한 줄) — 마법사의 '라이블리 열기' 카드가 보여준다
let startedHidden = false;          // 로그인 때 자동으로(숨겨) 떴나 — 그러면 갖춰져 있어도 창을 안 띄운다
let running = null;                 // { kind, handle } — 지금 도는 CLI(동시 1개)
let lastRun = null;                 // 마지막으로 시도한 { kind, opts } — '다시 시도' 가 이걸 그대로 다시 돈다
let updateNote = null;              // 업데이트 확인 결과 한 줄(사람용)
let updateReady = null;             // 받아 둔 새 버전(문자열) — 있으면 '적용(다시 시작)' 이 뜬다
let updater = null;                 // electron-updater 인스턴스 — **한 번만** 만들고 리스너도 한 번만 건다(재확인마다 걸면 누적된다)
let autoApplyTimer = null;          // 창이 안 보일 때 자동 적용 예약
let progressNoteAt = 0;             // 진행률 문구를 마지막으로 그린 시각(스로틀)
let updateVersion = "";             // 지금 받는 중인 새 버전(진행률 문구용)
let staleInstalls = [];             // Windows: 다른 자리에 남은 옛 설치본(win-stale-install.mjs) — 있으면 정리 카드가 뜬다
let staleCheckedAt = 0;
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
  const wasReady = appReady(state);
  const cliPath = locateCli(existsSync);
  const next = { ...state, cliPath, cliFound: !!cliPath };
  next.gatewayUrl = readTrim(join(LIVELY_DIR, "gateway-url"));
  next.loggedIn = existsSync(join(LIVELY_DIR, "token"));
  // 토큰이 **있다**와 **먹힌다**는 다르다 — 게이트웨이가 401 로 거부한 그 토큰이 그대로면 로그인이 필요한 상태다.
  //  파일의 토큰이 바뀌면(다시 로그인) 저절로 풀린다 — 따로 초기화할 자리가 없어 빠뜨릴 일이 없다.
  next.tokenRejected = !!(rejectedToken && readTrim(join(LIVELY_DIR, "token")) === rejectedToken);
  next.webError = webError;
  next.kitInstalled = existsSync(join(LIVELY_DIR, "kit-version"));
  next.nodeRegistered = existsSync(join(LIVELY_DIR, "node-agent.env"));
  next.appAutoLaunch = appAutoLaunchEnabled();
  // 버전 — 제보·지원에서 가장 먼저 묻는 값인데 화면 어디에도 없었다. 두 축을 따로 보여준다:
  //  앱(=이 바이너리)과 키트(=CLI 가 설치한 것). 서로 다른 주기로 갱신되므로 하나로 합치면 오해가 된다.
  next.appVersion = safeAppVersion();
  next.kitVersion = readTrim(join(LIVELY_DIR, "kit-version"));
  next.updateNote = updateNote;
  next.updateReady = updateReady;
  next.staleVersions = staleInstalls.length ? staleInstalls.map((e) => e.version).filter(Boolean).join(", ") || "이전 버전" : null;
  next.staleInstall = staleInstallNote(staleInstalls);
  // 재시도는 **실패한 게 있고 그게 안전한 작업일 때만** 제안한다(렌더러가 판단하지 않는다).
  next.retryable = !!(lastRun && RETRYABLE_KINDS.includes(lastRun.kind));
  next.logViews = LOG_VIEWS.map((v) => ({ id: v.id, label: v.label }));
  // '다 갖춰졌다' 는 **한 자리**(web-shell.appReady)에서만 판정한다 — 트레이·마법사·창 선택이 전부 이 값을 본다.
  next.ready = appReady(next);
  state = next;
  renderTray(); send(IPC.STATE, state); pushWebUpdate();
  if (deep && cliPath && !running) await refreshNodeStatus(cliPath);
  syncWindows(wasReady);
  return state;
}

/**
 * 준비 상태가 **바뀌었을 때** 창을 맞춘다 — 갖춰졌다가 무너지면(로그아웃·토큰 거부·CLI 고장) 웹 창을 내리고 마법사를,
 *  마법사에서 갖춰지면(설치·로그인 완료) 웹 창을 연다. 바뀐 게 없으면 아무 창도 건드리지 않는다(사람이 닫아 둔 창을 되살리지 않는다).
 */
function syncWindows(wasReady) {
  const ready = appReady(state);
  if (wasReady && !ready) {
    if (appWin && !appWin.isDestroyed() && appWin.isVisible()) { appWin.hide(); showWindow(); }
    return;
  }
  if (!wasReady && ready && win && !win.isDestroyed() && win.isVisible()) {
    // 마법사를 보며 로그인·설치를 마친 사람에게 결과(라이블리 화면)를 바로 준다. 마법사는 닫지 않는다 — 완료 카드(다음 할 일)가
    //  거기 있고, 창이 저절로 사라지는 건 사람을 놀라게 한다. 앞에 뜬 라이블리 창을 쓰다가 마법사는 스스로 닫는다.
    showApp();
  }
}

/** `lively status --json` 의 node 축을 읽어 실제 상태로 덮는다(폴링·작업 직후). */
async function refreshNodeStatus(cli) {
  const r = await runCli({ cli, launch: launchSpecFor(cli, argvFor("status")), env: { ...process.env }, timeoutMs: 30_000 });
  // ★ 같은 호출로 '이 CLI 가 우리 말을 아는가' 도 같이 안다 — 앱보다 먼저 CLI 를 깔아 둔 PC 는 구 CLI 가
  //  `--json-events` 를 조용히 무시하고 exit 0 으로 끝낸다(이벤트 0개). 그걸 모르면 앱은 아무 설명 없이 멈춘다.
  const verdict = cliContractVerdict(r);
  // ⚠ 'unusable'(= 아예 못 띄웠다)을 '멀쩡함' 으로 접으면 안 된다 — 실기기에서 그래서 창조차 안 떴다:
  //  `spawn EINVAL` 로 매번 죽는데 cliOutdated=false 라 '설치 완료' 로 판정돼 앱이 조용히 트레이에 앉았다.
  //  못 띄우는 CLI 는 없는 것보다 나쁘다(있는 줄 알고 화면이 아무 말도 안 한다). 별도 축으로 드러낸다.
  if (verdict !== "failed") {
    patchState({ cliOutdated: verdict === "too-old", cliBroken: verdict === "unusable" ? (r.error || "CLI 를 실행하지 못했습니다.") : null });
  }
  const n = r.result?.node;
  if (!r.ok || !n) { renderTray(); send(IPC.STATE, state); return; }   // 못 읽었으면 **건드리지 않는다**(옛 값이 추측보다 낫다)
  // nodeConnected: 게이트웨이가 보는 연결 여부(true/false/null=모름). running 과 다른 축 — 프로세스가 돌아도 안 붙어 있을 수 있다.
  // nodeSleepNote(#1849): 게이트웨이가 연결 이력으로 판정한 "왜 안 붙어 있나"(잠자기 추정). 없으면 null(모름).
  //  ⚠ 문구는 서버가 만든다 — 앱이 지으면 웹·CLI 와 다른 말을 하게 된다.
  patchState({ nodeRegistered: !!n.registered, nodeDaemon: !!n.daemon, nodeRunning: n.running, nodeId: n.id || null,
    nodeConnected: typeof n.connected === "boolean" ? n.connected : null,
    nodeSleepNote: (n.sleep && typeof n.sleep.note === "string" && n.sleep.note) ? n.sleep.note : null });
  renderTray(); send(IPC.STATE, state);
}
/** 상태 일부를 바꾸면 `ready` 도 같이 다시 잰다 — 이걸 빼먹은 자리가 하나라도 있으면 트레이·창이 옛 판정으로 움직인다. */
function patchState(patch) { state = { ...state, ...patch }; state.ready = appReady(state); }
function readTrim(p) { try { return readFileSync(p, "utf8").trim() || null; } catch { return null; } }
/** CLI 를 '어떻게' 띄울지 — Windows 의 `.cmd` EINVAL 을 피하는 유일한 자리(cli-locate 주석 참조). */
function launchSpecFor(cli, args) {
  return cliLaunchSpec({
    cliPath: cli, livelyDir: LIVELY_DIR, args,
    exists: existsSync,
    readdir: (d) => { try { return readdirSync(d); } catch { return []; } },
  });
}
/** 개발 실행(electron .)에서는 Electron 자신의 버전이 나온다 — 그래도 없는 척하지 않고 그대로 보여준다. */
function safeAppVersion() { try { return app.getVersion(); } catch { return null; } }
/** OS 다크모드 — frameless 창의 초기 타이틀바 색(마법사는 이 값이 전부, 웹 창은 페이지 보고가 곧 덮는다). */
function osTheme() { try { return nativeTheme.shouldUseDarkColors ? "dark" : "light"; } catch { return "light"; } }
// ── 창 배경색(#1683 다크모드) ────────────────────────────────────────────────
// 왜 필요한가: 창은 첫 그림보다 **먼저** 뜬다. 배경색을 안 주면 Electron 기본이 흰색이라, 다크로 보는 사람은
//  창을 열 때마다 흰 판이 번쩍인다(웹이 다 그려질 때까지). 그래서 '그릴 내용' 과 같은 색을 창에 미리 깔아 둔다.
// 무엇을 깔 것인가: 웹 창의 진짜 배경은 **웹의 테마 선택**(localStorage lv:theme)이지 OS 설정이 아니다 —
//  그 값은 게이트웨이 출처의 스토리지에 있어 창을 만들 때는 읽을 수 없다. 대신 preload ③ 이 페이지의 실제
//  배경색을 이미 보고하고 있으므로(IPC_WEB.TITLEBAR), 그 마지막 관측값을 적어 두었다가 다음에 깐다.
//  한 번도 연 적 없으면 OS 설정으로 시작한다(그게 '시스템 따름' 기본값과 같은 판단이다).
const THEME_BG = { dark: "#111726", light: "#FFFFFF" };   // public/styles/90-dark.css --bg / 01-base.css --bg
const WEBBG_FILE = join(LIVELY_DIR, "desktop-web-bg.json");
function osThemeBg() { return THEME_BG[osTheme()] || THEME_BG.light; }
function loadWebBg() {
  try {
    const v = JSON.parse(readFileSync(WEBBG_FILE, "utf8"));
    return /^#[0-9a-fA-F]{6}$/.test(v && v.bg) ? v.bg : osThemeBg();
  } catch { return osThemeBg(); }
}
function saveWebBg(bg) {
  if (!/^#[0-9a-fA-F]{6}$/.test(String(bg || ""))) return;
  try { mkdirSync(LIVELY_DIR, { recursive: true }); writeFileSync(WEBBG_FILE, JSON.stringify({ bg })); }
  catch { /* 저장 실패는 치명이 아니다 — 다음 실행이 OS 설정으로 시작할 뿐 */ }
}
// OS 테마가 바뀌면(라이트↔다크) 마법사 창의 Windows 창 버튼 색을 따라 바꾼다 — 마법사 CSS 는 prefers-color-scheme 로
//  이미 스스로 바뀌므로, 안 맞추면 버튼 자리만 옛 색으로 남는다. 웹 창은 페이지가 관찰·보고하므로 여기서 안 건드린다.
try {
  nativeTheme.on("updated", () => {
    if (process.platform !== "win32") return;
    const o = frameOptions("win32", osTheme()).titleBarOverlay;
    try { if (win && !win.isDestroyed()) win.setTitleBarOverlay(o); } catch { /* 비치명 */ }
  });
} catch { /* 테스트 스텁 등 nativeTheme 없음 */ }

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
  // 서브메뉴(알림 #1842)를 위해 재귀로 그린다 — 항목이 submenu 를 가지면 클릭이 아니라 펼침이다.
  const toTemplate = (m) => (m.type === "separator"
    ? { type: "separator" }
    : m.submenu
      ? { label: m.label, enabled: m.enabled !== false, submenu: m.submenu.map(toTemplate) }
      : { label: m.label, type: m.type, checked: m.checked, enabled: m.enabled !== false, click: () => onMenu(m.id) });
  tray.setContextMenu(Menu.buildFromTemplate(model.map(toTemplate)));
}
function onMenu(id) {
  if (id === "open") return showMain();          // 갖춰졌으면 라이블리 화면, 아니면 마법사
  if (id === "settings") return showWindow();    // 마법사(설치·노드·점검) — 갖춰진 뒤에도 트레이에서 언제든
  if (id === "quit") { quitting = true; return app.quit(); }
  if (id === "apply-update") return applyUpdate();
  if (id === "cleanup-stale") return cleanupStaleInstall();
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
//  ⚠ Windows 는 등록할 때 넣은 인자(`--hidden`)를 **조회할 때도 같이 줘야** openAtLogin 을 제대로 읽는다(Electron 규약).
function appAutoLaunchEnabled() {
  try { return process.platform === "linux" ? null : !!app.getLoginItemSettings({ args: AUTOLAUNCH_ARGS }).openAtLogin; } catch { return null; }
}
function setAppAutoLaunch(on) {
  try {
    // openAsHidden(macOS)·--hidden(Windows): 로그인 때 창을 띄우지 않는다 — 앱이 매 부팅마다 창을 열면 그건 방해다.
    //  이제 앱 창 = 라이블리 화면이라 더 그렇다(startupWindow 가 이 신호를 보고 트레이만 남긴다).
    app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true, args: AUTOLAUNCH_ARGS });
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
    const u = await getUpdater();
    // ⚠ checkForUpdatesAndNotify 가 아니다 — 그건 OS 알림으로 "종료하면 설치됩니다" 를 띄우는데, 이제 적용은
    //  앱이 스스로 한다(applyUpdate). 그 문구가 사람을 종전의 함정(손으로 껐다 켜기)으로 다시 부른다.
    await u.checkForUpdates();
  } catch (e) { updateFailed = true; updateNote = updateFailureNote(e); send(IPC.LOG, { stream: "raw", line: updateNote }); }
  void refreshState();
}
/** electron-updater — 한 번만 만들고 리스너도 한 번만. (종전엔 확인할 때마다 on() 을 다시 걸어 누적됐다.) */
async function getUpdater() {
  if (updater) return updater;
  const { autoUpdater } = (await import("electron-updater")).default;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;   // 사람이 먼저 끄면 그때라도 설치한다(폴백) — 주 경로는 applyUpdate
  autoUpdater.on("error", (e) => { updateFailed = true; updateNote = updateFailureNote(e); send(IPC.LOG, { stream: "raw", line: updateNote }); void refreshState(); });
  autoUpdater.on("update-not-available", () => { updateNote = "최신 버전입니다."; void refreshState(); });
  autoUpdater.on("checking-for-update", () => { updateNote = "업데이트 확인 중…"; void refreshState(); });
  autoUpdater.on("update-available", (i) => {
    // 확인은 여기서 끝난다 — 이 뒤는 **받는 중**이다. 그 사실과 크기를 화면·로그에 남긴다(종전엔 이 구간이 침묵이라
    //  사람이 "확인이 3분째"라고 읽었다). 크기는 files[0].size(바이트) — 없으면 생략.
    const size = i?.files?.[0]?.size;
    updateVersion = String(i?.version || "");
    updateNote = downloadProgressNote(i?.version, { percent: 0, transferred: 0, total: size });
    send(IPC.LOG, { stream: "raw", line: `새 버전 ${i?.version || ""} 발견 — 받는 중${size ? ` (${(size / 1048576).toFixed(0)}MB)` : ""}` });
    progressNoteAt = 0; void refreshState();
  });
  autoUpdater.on("download-progress", (p) => {
    const now = Date.now();
    if (now - progressNoteAt < PROGRESS_NOTE_MIN_MS) return;   // 초당 수십 번 온다 — 트레이·렌더러를 그 속도로 그리지 않는다
    progressNoteAt = now;
    updateNote = downloadProgressNote(updateVersion, p);
    void refreshState();
  });
  autoUpdater.on("update-downloaded", (i) => {
    updateReady = String(i?.version || "") || "새 버전";
    updateNote = updateReadyNote(i?.version);
    send(IPC.LOG, { stream: "raw", line: updateNote });
    void refreshState();
    scheduleAutoApply();
  });
  updater = autoUpdater;
  return updater;
}
/**
 * 받아 둔 업데이트를 지금 적용 — 설치기가 앱을 닫고·설치하고·**다시 띄운다**(isSilent + isForceRunAfter).
 *  종전 "앱을 다시 켜면 적용" 안내는 사람과 설치기를 경쟁시켰다(update-policy 머리말). 이제 사람은 아무것도 안 켠다.
 */
async function applyUpdate() {
  if (!updateReady) return { ok: false, error: "받아 둔 업데이트가 없습니다." };
  if (running) return { ok: false, error: "작업이 끝난 뒤에 적용합니다." };
  try {
    const u = await getUpdater();
    // 창을 보고 있던 사람이 적용을 눌렀으면 재시작 뒤 **그 창을 다시 연다**(#1541 실측: 트레이에만 떠서 손으로 열었다).
    //  마커 내용 = 어느 창이었나("app" 라이블리 화면 / "setup" 마법사). 자동 적용(창 숨김)은 마커를 안 쓴다 — 안 보는데 창이 튀면 안 된다.
    try {
      const which = appWinVisible() ? "app" : (win && win.isVisible()) ? "setup" : null;
      if (which) writeFileSync(join(LIVELY_DIR, "desktop-reopen"), which);
    } catch { /* 마커 실패는 비치명 */ }
    quitting = true;                                   // 창 close 핸들러가 숨기기 대신 닫게
    send(IPC.LOG, { stream: "raw", line: `업데이트 적용 — 앱을 다시 시작합니다 (${updateReady})…` });
    u.quitAndInstall(true, true);                      // Windows: 설치기 /S --force-run · Linux AppImage: 교체 후 재실행
    return { ok: true };
  } catch (e) {
    quitting = false;
    const line = `업데이트 적용 실패: ${String(e?.message || e).slice(0, 200)}`;
    send(IPC.LOG, { stream: "raw", line }); updateNote = line; void refreshState();
    return { ok: false, error: line };
  }
}
/** 창이 안 보이면(트레이 상주) 잠시 뒤 자동 적용 — 판단은 shouldAutoApplyUpdate(순수·표로 못박음). 창을 열면 취소. */
function scheduleAutoApply() {
  if (autoApplyTimer) { clearTimeout(autoApplyTimer); autoApplyTimer = null; }
  // '보고 있나' 는 두 창 다 본다 — 라이블리 화면을 보는 중에 앱이 스스로 재시작하면 안 된다.
  const ok = shouldAutoApplyUpdate({ ready: !!updateReady, busy: !!running, windowVisible: anyWindowVisible(), promptsPending: pendingPrompts.size });
  if (!ok) return;
  autoApplyTimer = setTimeout(() => {
    autoApplyTimer = null;
    // 예약 뒤 상황이 바뀌었을 수 있다(창을 열었다·작업을 시작했다) — 다시 판정한다.
    if (shouldAutoApplyUpdate({ ready: !!updateReady, busy: !!running, windowVisible: anyWindowVisible(), promptsPending: pendingPrompts.size })) void applyUpdate();
  }, AUTO_APPLY_DELAY_MS);
}
const appWinVisible = () => !!(appWin && !appWin.isDestroyed() && appWin.isVisible());
const anyWindowVisible = () => !!(win && !win.isDestroyed() && win.isVisible()) || appWinVisible();
// ── Windows: 다른 자리에 남은 옛 설치본 (#1541 · win-stale-install.mjs 머리말) ────────────────
/** 감지 — 패키지된 Windows 앱에서만. 실패는 '없음' 으로(감지 못 한다고 앱을 막지 않는다). 5분에 한 번이면 충분하다. */
async function detectStaleInstall({ force = false } = {}) {
  if (process.platform !== "win32" || !app.isPackaged) return;
  if (!force && Date.now() - staleCheckedAt < 5 * 60_000) return;
  staleCheckedAt = Date.now();
  const out = await new Promise((resolve) => {
    try {
      execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", STALE_QUERY_PS],
        { windowsHide: true, timeout: 20_000, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? "" : String(stdout || "")));
    } catch { resolve(""); }
  });
  staleInstalls = pickStaleInstalls(parseStaleQuery(out), process.execPath);
  if (staleInstalls.length) send(IPC.LOG, { stream: "raw", line: staleInstallNote(staleInstalls) });
  void refreshState();
}
/** 우리 exe 로 바탕화면 바로가기·로그인 자동시작을 잇는다 — 옛 설치본을 지우면 그쪽 바로가기는 사라진다. */
function repointToSelf() {
  const notes = [];
  try {
    const lnk = join(app.getPath("desktop"), "Lively.lnk");
    if (shell.writeShortcutLink(lnk, "create", { target: process.execPath, description: "라이블리" })) notes.push("바탕화면 바로가기를 이 버전으로 만들었습니다.");
  } catch (e) { notes.push(`바탕화면 바로가기 생성 실패: ${String(e?.message || e).slice(0, 120)}`); }
  try {
    // 로그인 자동시작(Run 키)이 **다른 exe** 를 가리키면 우리 exe 로 덮는다(같은 값 이름이라 setLoginItemSettings 가 덮어쓴다).
    const st = app.getLoginItemSettings({ args: AUTOLAUNCH_ARGS });
    const items = Array.isArray(st.launchItems) ? st.launchItems : [];
    const other = items.find((i) => /lively/i.test(String(i.name || "") + String(i.path || "")) && String(i.path || "").toLowerCase() !== process.execPath.toLowerCase());
    if (other || st.openAtLogin) { app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: AUTOLAUNCH_ARGS }); if (other) notes.push("로그인 자동 시작을 이 버전으로 바꿨습니다."); }
  } catch (e) { notes.push(`자동 시작 갱신 실패: ${String(e?.message || e).slice(0, 120)}`); }
  return notes;
}
/**
 * 정리 — 사람이 눌렀을 때만(UAC 가 뜬다). 옛 언인스톨러를 권한상승·조용히 돌리고 우리를 다시 띄우는 스크립트를
 *  **앱 밖(PowerShell)** 에서 돌린다: 옛 언인스톨러의 CHECK_APP_RUNNING 이 같은 이름의 우리 프로세스도 죽이기 때문이다.
 *  -EncodedCommand(UTF-16LE base64) — 인용부호를 argv 에 싣지 않는다(값은 psQuote 로 스크립트 안에서만 리터럴이 된다).
 */
async function cleanupStaleInstall() {
  if (process.platform !== "win32") return { ok: false, error: "Windows 에서만 필요한 작업입니다." };
  if (!staleInstalls.length) return { ok: false, error: "정리할 옛 설치본이 없습니다." };
  if (running) return { ok: false, error: "작업이 끝난 뒤에 정리합니다." };
  const notes = repointToSelf();
  for (const n of notes) send(IPC.LOG, { stream: "raw", line: n });
  const script = staleCleanupPs({ stale: staleInstalls, ownExe: process.execPath });
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  try {
    send(IPC.LOG, { stream: "raw", line: `이전 버전(${staleInstalls.map((e) => e.version).join(", ")}) 제거 — 화면이 어두워지며 관리자 확인 창이 뜹니다(안 보이면 작업 표시줄의 방패 아이콘). 끝나면 앱이 다시 열립니다.` });
    quitting = true;   // 언인스톨러가 우리를 닫는다 — 창 close 가 숨기기로 가로채지 않게
    // ⚠ 숨김(-WindowStyle Hidden·windowsHide·detached)으로 띄우지 않는다 — 백그라운드 프로세스의 승격 요청은
    //  작업 표시줄에 최소화돼 사람이 못 본다(실기기: UAC 를 5분 뒤에야 발견). 보이는 콘솔이 포그라운드를 가져야
    //  관리자 확인 창이 즉시 화면을 덮는다. 콘솔엔 스크립트가 안내 문구를 찍는다(win-stale-install.mjs).
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64], { stdio: "ignore" });
    child.unref();
    return { ok: true };
  } catch (e) {
    quitting = false;
    const line = `정리 실패: ${String(e?.message || e).slice(0, 200)}`;
    send(IPC.LOG, { stream: "raw", line });
    return { ok: false, error: line };
  }
}
/** mac 서명 여부 — 서명되지 않은 번들은 codesign 검증에 실패한다. 못 재면 '서명 안 됨' 으로 본다(안전측). */
function isMacSigned() {
  try {
    return spawnSync("codesign", ["-dv", app.getAppPath().replace(/\/Contents\/Resources\/app(\.asar)?$/, "")], { stdio: "ignore" }).status === 0;
  } catch { return false; }
}

// ── 창 ──────────────────────────────────────────────────────────────────────
function showWindow() {
  void detectStaleInstall();   // 5분 스로틀 — 정리 뒤 다시 열렸을 때 카드가 사라지게(강제 아님)
  if (win) { win.show(); win.focus(); return win; }
  // 지난번 자리·크기로 연다. 모니터를 뺐거나 해상도가 바뀌었으면 좌표를 버린다(window-bounds.mjs) —
  //  안 그러면 창이 보이지 않는 곳에 떠서 사용자에겐 "앱이 안 열린다" 로 보인다.
  const b = loadBounds();
  win = new BrowserWindow({
    ...b, ...frameOptions(process.platform, osTheme()), minWidth: 560, minHeight: 420, title: "라이블리", show: false,
    backgroundColor: osThemeBg(),   // #1683 — 첫 그림 전 흰 번쩍임 방지(마법사는 OS 설정을 따른다)
    autoHideMenuBar: true,   // frameless 에서 메뉴 막대가 남으면 그게 곧 '이상한 바' 다 — Alt 로는 나온다
    webPreferences: {
      preload: join(HERE, "..", "preload", "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,   // 렌더러는 신뢰하지 않는다
    },
  });
  win.once("ready-to-show", () => win.show());
  // 창을 닫아도 앱은 트레이에 남는다 — 노드 리모컨이 사라지면 안 된다.
  //  ⚠ 자리는 **숨기기 직전에** 저장한다. 'closed' 는 트레이 상주라 앱 종료 때까지 안 올 수도 있다.
  win.on("close", (e) => { saveBounds(); if (!quitting) { e.preventDefault(); win.hide(); } });
  // 업데이트 자동 적용은 '사람이 안 보고 있을 때'만 — 창을 숨기면 예약하고, 다시 보이면 취소한다.
  win.on("hide", () => scheduleAutoApply());
  win.on("show", () => { if (autoApplyTimer) { clearTimeout(autoApplyTimer); autoApplyTimer = null; } });
  win.on("closed", () => { win = null; });
  win.on("moved", saveBounds);
  win.on("resized", saveBounds);
  win.loadFile(join(HERE, "..", "renderer", "index.html"));
  return win;
}
const send = (ch, payload) => { try { win?.webContents.send(ch, payload); } catch { /* 창 없음 */ } };

// ── 웹 UI 창들에 밀기 (#1838) ───────────────────────────────────────────────
// 마법사(send)와 달리 창이 여럿이다 — 라이블리 화면 + 거기서 연 자식 창(터미널 새 창 등). **게이트웨이 출처를
//  실은 창에만** 보낸다: 창이 잠깐 다른 사이트(IdP·외부 문서)를 싣고 있을 수 있고, 그 페이지에 우리 신호를 줄
//  이유가 없다. 창 목록을 따로 들고 다니지 않는 이유 — 자식 창은 setWindowOpenHandler 가 만들어 우리가 참조를
//  못 받고, 들고 다니면 닫힌 창을 지우는 자리가 또 생긴다(그게 실제 누수의 흔한 자리다).
function sendWeb(ch, payload) {
  const origin = webOrigin(state.gatewayUrl);
  if (!origin) return;
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (w.isDestroyed()) continue;
      const u = w.webContents.getURL();
      if (!u || new URL(u).origin !== origin) continue;
      w.webContents.send(ch, payload);
    } catch { /* 그 사이 사라진 창 — 다음 창으로 */ }
  }
}
/** 지금의 업데이트 상태(웹용). 트레이·마법사가 보는 것과 **같은 사실**을 세 값으로 줄인 것이다. */
const webUpdate = () => webUpdateState({ ready: !!updateReady, version: updateReady, busy: !!running });
/** 바뀌었을 때만 민다 — refreshState 는 30초 폴링·CLI 이벤트마다 돌지만 이 값은 거의 안 바뀐다. */
let webUpdateSent = "";
function pushWebUpdate() {
  const payload = webUpdate();
  const key = JSON.stringify(payload);
  if (key === webUpdateSent) return;
  webUpdateSent = key;
  sendWeb(IPC_WEB.UPDATE, payload);
}

// ── 앱 알림 (#1842) ─────────────────────────────────────────────────────────
// 트레이 상주 앱만이 **창 없이도** 살아 있다(window-all-closed = noop). 그래서 "화면을 안 보고 있을 때 부르는"
//  알림은 여기서만 만들 수 있다 — 웹 화면이 하면 창을 닫는 순간 눈이 먼다. 판정은 전부 notify.mjs(순수·표로 검증).
const NOTIFY_POLL_MS = 30_000;      // 세션 상태 조회는 tmux 를 훑는다 — 상태 폴링(refreshState)과 같은 리듬으로 둔다
// 설정은 **서버가 정본**이다(#1842) — 사람 단위. 기기별 파일에 두면 사무실 맥에서 끈 것이 노트북에선
//  그대로 떠 "껐는데 뜬다"가 된다. 끄고 켜는 자리는 웹 [내 정보 ▸ 알림] 한 곳이고, 앱은 읽기만 한다.
//  이 캐시는 폴링이 갱신한다 — 서버를 못 읽는 동안에도 마지막으로 받은 값으로 계속 동작한다.
let notifySnapshot = null;          // 직전 세션 스냅샷. null = 콜드스타트(첫 폴은 기준선만 잡고 아무것도 안 띄운다)
let notifyPolling = false;
let personSince = null;             // 사람 알림 커서 — 서버가 준 `now`. null 이면 아직 한 번도 안 받았다
let personSeen = null;              // 이미 띄운 사람 알림 key. null = 콜드스타트(첫 폴은 기준선만)
// 실시간 스트림(#1842 3차) — 이게 붙어 있으면 세션 배너는 **스트림만** 만든다(폴링은 기준선만 갱신).
let streamCtl = null;               // 현재 연결의 AbortController
let streamAlive = false;            // 붙어 있나 — 폴링 배너 게이팅의 유일한 근거
let streamTries = 0;                // 연속 실패 횟수(백오프)
let streamTimer = null;             // 재연결 예약
const streamSeen = new Set();       // 이미 띄운 스트림 사건 key(재연결 직후 중복 방지)

let notifyPrefsCache = { ...NOTIFY_DEFAULTS };   // 서버에서 마지막으로 받은 값. 받기 전엔 전부 켜짐.

/** 유형별 켜짐 — 서버 값. 아직 못 받았으면 기본값(전부 켜짐): 설정을 못 읽었다고 알림이 멎으면 안 된다. */
function notifyPrefs() { return notifyPrefsCache; }

/** 배너 한 장. 클릭하면 그 세션 화면으로 간다(묶음 배너는 갈 곳이 하나가 아니므로 앱만 띄운다). */
function showBanner({ title, body, event }) {
  try {
    if (!Notification.isSupported()) return;          // 리눅스 등 알림 데몬이 없는 환경 — 조용히 넘긴다
    const n = new Notification({ title, body });
    n.on("click", () => {
      if (event && event.id) return openSessionInApp(event.id);        // 세션 알림 → 그 세션 화면
      if (event && event.link) return openHashInApp(event.link);       // 사람 알림 → 그 프로젝트 화면
      showMain();                                                      // 묶음 배너 — 갈 곳이 하나가 아니다
    });
    n.show();
  } catch { /* OS 가 알림을 막았어도 앱은 계속 돈다 */ }
}

/** 알림 클릭 → 앱 창을 띄우고 그 화면으로. 이미 실려 있으면 해시만 바꾼다(전체 리로드는 보던 화면을 날린다). */
function openHashInApp(hash) {
  const r = showApp();
  if (!r || !r.ok || !hash || !appWin || appWin.isDestroyed()) return;
  const wc = appWin.webContents;
  const go = () => { try { void wc.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {}); } catch { /* 창이 사라졌다 */ } };
  if (wc.isLoading()) wc.once("did-finish-load", go); else go();
}
/** 세션 알림 클릭 — id 형식을 먼저 본다(응답을 그대로 주소로 쓰지 않는다). */
function openSessionInApp(id) { openHashInApp(sessionHash(id)); }

/**
 * 실시간 스트림에 붙는다 (#1842). 게이트웨이가 하네스 훅 보고를 받는 **그 순간** 사건을 밀어 주므로,
 *  "AI 를 여러 개 병렬로 돌리다 끝나는 것마다 바로 받는다"가 여기서 성립한다(폴링은 폴백으로 남는다).
 *
 * ⚠ 이 함수는 연결이 끊길 때까지 돌아온다 — 호출자는 await 하지 않고 재연결만 예약한다.
 */
async function connectNotifyStream() {
  const gw = String(state.gatewayUrl || "").replace(/\/+$/, "");
  const token = state.ready && gw ? readTrim(join(LIVELY_DIR, "token")) : "";
  if (!token) { scheduleStreamRetry(); return; }
  const ctl = new AbortController();
  streamCtl = ctl;
  let openedAt = 0;
  try {
    const res = await fetch(`${gw}/api/ui/notify/stream`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      signal: ctl.signal,
    });
    // 구 게이트웨이엔 이 표면이 없다(404) — 조용히 폴링만 쓴다(그래서 폴링을 없애지 않았다).
    if (!res.ok || !res.body) { scheduleStreamRetry(); return; }
    streamAlive = true;
    openedAt = Date.now();   // #2041 — 되돌리기는 '붙었나'가 아니라 '붙어서 살았나'로(아래 finally)
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const { events, rest } = parseSse(buf);
      buf = rest;
      const prefs = notifyPrefs();
      for (const ev of events) {
        const hit = streamEvent(ev, streamSeen, prefs);
        if (!hit) continue;
        streamSeen.add(hit.key);
        while (streamSeen.size > SEEN_MAX) streamSeen.delete(streamSeen.values().next().value);
        showBanner({ ...bannerFor(hit), event: hit });
      }
    }
  } catch { /* 끊김·타임아웃·게이트웨이 재시작 — 아래에서 다시 붙는다 */ }
  finally {
    streamAlive = false;
    if (streamCtl === ctl) streamCtl = null;
    // ⚠ #2041 — 붙었다는 사실이 아니라 **버틴 시간**으로 백오프를 되돌린다. 붙자마자 끊는 서버에
    //  성공으로 되돌리면 초당 한 번씩 재접속한다(웹 셸에서 20초에 19번 실측).
    if (stableStream(openedAt ? Date.now() - openedAt : 0)) streamTries = 0;
    scheduleStreamRetry();
  }
}

/** 재연결 예약 — 지수 백오프. 게이트웨이가 재시작 중일 때 초당 재접속으로 때리지 않는다. */
function scheduleStreamRetry() {
  if (quitting || streamTimer) return;
  const wait = reconnectDelay(streamTries++);
  streamTimer = setTimeout(() => { streamTimer = null; void connectNotifyStream(); }, wait);
  if (streamTimer.unref) streamTimer.unref();
}

/**
 * 한 번의 폴 — 세션 목록을 받아 직전 스냅샷과 견주고, 생긴 사건만 배너로 띄운다.
 *  ⚠ 준비 안 됐거나(설치·로그인 전) 토큰이 없으면 **기준선을 버린다** — 다시 로그인했을 때 그 사이 사건이
 *   한꺼번에 되살아나지 않게(콜드스타트로 되돌린다). 반대로 네트워크 실패는 기준선을 **유지**한다(다음 폴에서 이어 본다).
 */
async function pollNotifications() {
  if (notifyPolling) return;
  const gw = String(state.gatewayUrl || "").replace(/\/+$/, "");
  const token = state.ready && gw ? readTrim(join(LIVELY_DIR, "token")) : "";
  if (!token) { notifySnapshot = null; personSeen = null; personSince = null; streamSeen.clear(); notifyPrefsCache = { ...NOTIFY_DEFAULTS }; return; }
  notifyPolling = true;
  try {
    const res = await fetch(`${gw}/api/ui/terminal/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return;                               // 401 은 watchTokenRejection 이 따로 처리한다
    const data = await res.json();
    const next = snapshotSessions(data && data.sessions);
    await pollPersonFeed(gw, token);                     // 설정·사람 알림을 함께 받아 온다(설정이 아래 판정에 바로 쓰인다)
    const prefs = notifyPrefs();
    const events = diffSessions(notifySnapshot, next, prefs);
    notifySnapshot = next;                               // ★ 기준선은 스트림 유무와 무관하게 늘 갱신한다 —
    //  연결이 끊기는 순간 폴링이 그 자리에서 이어받아야 하는데, 기준선이 낡아 있으면 그 사이 전이를 통째로
    //  놓치거나(오래된 스냅샷과 비교) 과거를 한꺼번에 다시 띄운다.
    if (!streamAlive) for (const b of planBanners(events)) showBanner(b);   // 스트림이 살아 있으면 배너는 그쪽이 만든다
  } catch { /* 게이트웨이가 꺼졌거나 네트워크가 끊겼다 — 기준선을 남기고 다음 폴에서 이어 본다 */ }
  finally { notifyPolling = false; }
}

/**
 * 사람이 나를 부른 것(멘션·댓글·담당) — 판정은 서버가 한다(/api/ui/notify/feed). 앱은 커서를 들고 다니며
 *  새로 온 것만 띄운다. **커서 전진은 성공했을 때만** 한다 — 실패했는데 전진시키면 그 사이 알림이 영영 사라진다.
 */
async function pollPersonFeed(gw, token) {
  const url = `${gw}/api/ui/notify/feed` + (personSince ? `?since=${encodeURIComponent(personSince)}` : "");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return;                                 // 구 게이트웨이엔 이 엔드포인트가 없다(404) — 조용히 넘긴다
  const data = await res.json();
  // 서버가 실어 보낸 알림 설정을 캐시에 반영한다(왕복을 하나 더 만들지 않는다).
  if (data && data.prefs && typeof data.prefs === "object") notifyPrefsCache = { ...NOTIFY_DEFAULTS, ...data.prefs };
  const events = pickPersonEvents(data && data.items, personSeen, notifyPrefs());
  if (!personSeen) personSeen = new Set();             // 첫 폴 = 기준선(위 pickPersonEvents 가 이미 빈 배열을 줬다)
  rememberSeen(personSeen, events);
  personSince = (data && data.now) || personSince;     // 서버 시계를 쓴다 — 앱 시계와 어긋나도 사건을 건너뛰지 않게
  for (const b of planPersonBanners(events)) showBanner(b);
}

// ── 라이블리 화면 = 웹 UI 창 (web-shell.mjs) ────────────────────────────────
// 게이트웨이가 서빙하는 /ui/ 를 **그대로** 싣는다 — 화면 코드를 앱에 두지 않는다. 앱이 보태는 건 토큰 주입(preload/web.cjs)·
//  창 열기 규칙(같은 출처=앱 안 새 창, 바깥=브라우저)·401 감지(토큰 거부→마법사) 셋뿐이다.
/** 사람이 '창 열기' 를 눌렀을 때 — 갖춰졌으면 라이블리 화면, 아니면 마법사(할 일이 있다). */
function showMain() { return state.ready ? (showApp().ok ? appWin : showWindow()) : showWindow(); }
function showApp() {
  if (!state.ready) return { ok: false, error: "아직 설치·로그인이 끝나지 않았습니다." };
  const url = webUiUrl(state.gatewayUrl);
  if (!url) return { ok: false, error: "게이트웨이 주소가 없습니다." };
  const token = readTrim(join(LIVELY_DIR, "token"));
  watchTokenRejection(state.gatewayUrl);
  if (!appWin || appWin.isDestroyed()) {
    const b = loadAppBounds();
    appWin = new BrowserWindow({
      ...b, ...frameOptions(process.platform, osTheme()), minWidth: APP_WINDOW_MIN.width, minHeight: APP_WINDOW_MIN.height, title: "라이블리", show: false,
      backgroundColor: loadWebBg(),   // #1683 — 지난번 웹 화면의 실제 배경색(테마 선택 반영)으로 시작한다
      autoHideMenuBar: true,   // Windows·Linux: 메뉴 막대를 숨긴다(Alt 로 나온다) — 웹 화면 위에 File/Edit 줄이 얹히면 웹이 아니다
      webPreferences: {
        preload: WEB_PRELOAD,
        contextIsolation: true, nodeIntegration: false, sandbox: true,   // 원격 페이지다 — 마법사보다 더 믿지 않는다
        // 브라우저 서피스(#1829) — 웹 UI 가 `<webview>` 로 남의 사이트를 앱 안에 띄울 수 있게 한다(iframe 은 XFO 에 막힌다).
        //  ⚠ 켠다고 페이지가 마음대로 하는 게 아니다 — 붙는 순간 will-attach-webview 가 preload 를 떼고 node·격리·파티션을
        //   강제한다(browser-surface.mjs). 그 훅이 없으면 이 한 줄은 XSS→RCE 승격 통로가 된다.
        webviewTag: true,
      },
    });
    // 첫 그림이 준비되면 보인다. 게이트웨이가 느리면 1.5초 뒤엔 빈 창이라도 띄운다(아무것도 안 뜨면 "안 열린다" 로 보인다).
    const fallback = setTimeout(() => { if (appWin && !appWin.isDestroyed() && !appWin.isVisible()) appWin.show(); }, 1500);
    appWin.once("ready-to-show", () => { clearTimeout(fallback); if (appWin && !appWin.isDestroyed()) appWin.show(); });
    // 마법사 창과 같은 수명 규약 — 닫아도 앱은 트레이에 남는다(노드 리모컨이 사라지면 안 된다).
    appWin.on("close", (e) => { saveAppBounds(); if (!quitting) { e.preventDefault(); appWin.hide(); } });
    appWin.on("hide", () => scheduleAutoApply());
    appWin.on("show", () => {
      if (autoApplyTimer) { clearTimeout(autoApplyTimer); autoApplyTimer = null; }
      void reloadIfStale();   // #1841 — 창은 닫아도 안 죽는다. 다시 보일 때 낡았으면 스스로 다시 싣는다.
    });
    appWin.on("closed", () => { appWin = null; appLoaded = { url: null, token: null }; });
    appWin.on("moved", saveAppBounds);
    appWin.on("resized", saveAppBounds);
    // 못 실었으면(게이트웨이 다운·주소 오류·오프라인) 빈 창을 두지 않는다 — 마법사의 '라이블리 열기' 카드에 사유를 적고 거기서 다시 시도한다.
    //  -3(ERR_ABORTED)은 리다이렉트·중복 로드의 부수 신호라 오류가 아니다.
    appWin.webContents.on("did-fail-load", (_e, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      webError = `라이블리 화면을 열지 못했습니다 — ${desc || code} (${failedUrl || url})`;
      appLoaded = { url: null, token: null };
      send(IPC.LOG, { stream: "raw", line: webError });
      if (appWin && !appWin.isDestroyed()) appWin.hide();
      showWindow(); void refreshState();
    });
    appWin.webContents.on("did-finish-load", () => { if (webError) { webError = null; void refreshState(); } });
  }
  // 주소나 토큰이 바뀌었으면(다른 게이트웨이·다시 로그인) 다시 싣는다 — preload 가 문서 시작 때 새 토큰을 넣는다.
  //  ⚠ loadURL 의 거절을 받아 둔다 — 안 받으면 게이트웨이가 꺼져 있을 때 unhandled rejection 이 uncaughtException 으로 올라가
  //   오류 대화상자가 뜬다. 실패의 처리는 위 did-fail-load 한 곳이 한다(마법사 카드에 사유 + 다시 시도).
  if (appLoaded.url !== url || appLoaded.token !== token) { appLoaded = { url, token }; appWin.loadURL(url).catch(() => { /* did-fail-load 가 처리 */ }); }
  appWin.show(); appWin.focus();
  return { ok: true };
}
/**
 * 낡은 화면 자가복구 (#1841) — 창이 다시 보일 때 게이트웨이 자산 세대가 바뀌었으면 다시 싣는다.
 *
 *  ⚠ 이게 없으면 앱은 **처음 뜬 판을 영영 들고 있다**. 창을 닫아도 죽지 않고(위 close 훅이 hide 만 한다),
 *   다시 열 때 showApp() 이 주소·토큰이 같으면 loadURL 을 건너뛰기 때문이다. 실측(2026-08-21):
 *   앱이 든 세대 7964959ed50d, 서버 882a0a3d262e — 그 사이 dev 에 올라간 변경이 앱에는 하나도 안 보였다.
 *
 *  웹에도 같은 자가복구가 있다(web/gen-watch.ts, visibilitychange). 둘 다 두는 이유:
 *   웹 쪽은 **이미 낡은 판에는 그 코드가 없어서** 한 번은 사람이 새로고침해야 한다. 여기(메인 프로세스)는
 *   페이지 내용과 무관하게 돌아서 그 첫 한 번까지 메꾼다.
 *
 *  실패는 조용히 넘긴다 — 게이트웨이가 꺼져 있거나 오프라인이면 그냥 지금 화면을 그대로 둔다.
 */
let lastGen = null;
async function reloadIfStale() {
  if (!appWin || appWin.isDestroyed() || !state.gatewayUrl) return;
  const base = String(state.gatewayUrl).replace(/\/+$/, "");
  let v = null;
  try {
    const r = await fetch(`${base}/ui/__gen`, { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    v = typeof j?.v === "string" ? j.v : null;
  } catch { return; }
  if (!v) return;
  if (lastGen && lastGen !== v) { try { appWin.webContents.reload(); } catch { /* 창이 사라졌으면 그만 */ } }
  lastGen = v;
}

function loadAppBounds() {
  const opts = { defaultSize: APP_WINDOW_DEFAULT, minSize: APP_WINDOW_MIN };
  try { return normalizeBounds(JSON.parse(readFileSync(APP_BOUNDS_FILE, "utf8")), workAreas(), opts); }
  catch { return normalizeBounds(null, workAreas(), opts); }
}
function saveAppBounds() {
  try {
    if (!appWin || appWin.isDestroyed() || appWin.isMinimized() || appWin.isFullScreen()) return;
    const b = pickBounds(appWin.getNormalBounds ? appWin.getNormalBounds() : appWin.getBounds());
    if (!b) return;
    mkdirSync(LIVELY_DIR, { recursive: true });
    writeFileSync(APP_BOUNDS_FILE, JSON.stringify(b));
  } catch { /* 저장 실패는 치명이 아니다 */ }
}
/**
 * 게이트웨이가 우리 토큰을 거부하면(회수·만료 — `/api/ui/*` 401) 마법사로 돌아가 다시 로그인하게 한다.
 *  응답을 바꾸지 않고 **보기만** 한다. 게이트웨이 주소마다 한 번 건다(같은 세션에 다시 걸면 교체된다).
 */
let watchingGateway = null;
function watchTokenRejection(gatewayUrl) {
  if (watchingGateway === gatewayUrl) return;
  const filter = tokenWatchFilter(gatewayUrl);
  if (!filter) return;
  watchingGateway = gatewayUrl;
  session.defaultSession.webRequest.onHeadersReceived(filter, (details, cb) => {
    cb({});
    if (!isTokenRejection(details, gatewayUrl)) return;
    // ⚠ 401 을 그대로 믿지 않는다(#1541 실측: 원준님 맥 — 유효한 토큰인데 어떤 웹 요청 하나의 401 로 '만료' 오판
    //  → 재로그인은 CLI 가 "이미 로그인됨"으로 즉시 끝나 파일이 안 바뀌고 → 오판 플래그가 영영 안 풀리는 루프).
    //  onHeadersReceived 는 그 요청이 bearer 를 실었는지도 모른다(무인증 요청의 401 일 수 있다). 그래서 감지는
    //  후보일 뿐이고, **메인이 파일 토큰으로 /api/ui/me 를 직접 쳐서** 진짜 거부일 때만 마법사로 보낸다.
    void verifyTokenAfter401(gatewayUrl);
  });
}
let verifyingToken = false;
async function verifyTokenAfter401(gatewayUrl) {
  const tok = readTrim(join(LIVELY_DIR, "token"));
  if (!tok || rejectedToken === tok || verifyingToken) return;   // 부재(로그아웃 직후)·이미 판정·검증 중이면 무시
  verifyingToken = true;
  try {
    const res = await fetch(`${String(gatewayUrl).replace(/\/+$/, "")}/api/ui/me`, {
      headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(8000),
    });
    if (res.status !== 401) return;   // 우리 토큰은 멀쩡하다 — 그 401 은 다른 요청의 사정(무인증·전용 게이트 등)
    rejectedToken = tok;
    send(IPC.LOG, { stream: "raw", line: "게이트웨이가 로그인 토큰을 거부했습니다(만료 또는 회수) — 다시 로그인이 필요합니다." });
    void refreshState();   // → ready=false → syncWindows 가 웹 창을 내리고 마법사를 띄운다
  } catch { /* 네트워크 실패 = 판정 불가 — 거짓 '만료'가 판정 불가보다 나쁘다. 다음 401 에서 다시 검증한다. */ }
  finally { verifyingToken = false; }
}
// 브라우저 서피스(#1829)의 세션 — 남의 사이트 전용 저장소. 한 번만 채비한다(파티션이 하나라 세션도 하나).
//  ① UA 에서 임베디드 표식을 뗀다(보험 — 실측상 지금 막히는 건 없다) ② 권한은 전부 거부(카메라·마이크·위치…).
//  ⚠ app ready 전에 부르면 안 된다(session.fromPartition 이 죽는다) — 그래서 부착 훅에서 지연 생성한다.
let surfaceSessionReady = false;
function browserSurfaceSession() {
  const s = session.fromPartition(BROWSER_SURFACE_PARTITION);
  if (!surfaceSessionReady) {
    surfaceSessionReady = true;
    try { s.setUserAgent(cleanUserAgent(s.getUserAgent(), app.getName())); } catch { /* 비치명 — 표식이 남을 뿐이다 */ }
    // 요구를 조용히 삼키지 않고 거부한다. 사람이 허용하는 흐름이 생기면 surfacePermissionAllowed 를 그때 넓힌다.
    try { s.setPermissionRequestHandler((_wc, permission, cb) => cb(surfacePermissionAllowed(permission))); } catch { /* 비치명 */ }
    try { s.setPermissionCheckHandler((_wc, permission) => surfacePermissionAllowed(permission)); } catch { /* 비치명 */ }
    void reloadInstalledExtensions(s);   // ③ 저장해 둔 확장을 다시 건다 — Electron 은 확장을 기억하지 않는다
  }
  return s;
}

// ── 브라우저 확장(애드온) (#1829) ────────────────────────────────────────────
// 확장은 **서피스 세션에만** 건다. 게이트웨이 UI 세션(우리 토큰이 있는 곳)에 걸면 남의 확장 코드가 그 문맥에서 돈다.
//  실측: 순정 loadExtension 으로 MV3 content script·service worker·declarativeNetRequest 차단이 다 된다.
//  우리가 메우는 건 셋뿐 — 정적 룰셋 활성화 · .crx 해제 · 재시작 후 재로드(browser-extensions.mjs 머리말).
const EXT_DIR = join(LIVELY_DIR, EXTENSIONS_DIRNAME);
const EXT_LIST_FILE = join(EXT_DIR, INSTALLED_FILE);

function readInstalledExtensions() {
  try { return parseInstalled(readFileSync(EXT_LIST_FILE, "utf8")); } catch { return []; }
}
function writeInstalledExtensions(list) {
  try { mkdirSync(EXT_DIR, { recursive: true }); writeFileSync(EXT_LIST_FILE, serializeInstalled(list)); return true; }
  catch { return false; }
}

/**
 * 확장 하나를 세션에 건다 — 그리고 **정적 룰셋을 켠다**.
 *  ⚠ 이 두 번째 줄이 이 함수의 존재 이유다. Electron 은 매니페스트의 `"enabled": true` 를 반영하지 않아
 *   `getEnabledRulesets()` 가 빈 채로 남는다 → 광고차단 확장이 "설치는 됐는데 아무것도 안 막는" 상태가 된다.
 *   실측으로 확인: updateEnabledRulesets 를 부른 뒤에야 실제 차단이 시작된다.
 */
async function loadExtensionInto(sess, dir) {
  // 룰셋 shim 페이지를 먼저 심는다(멱등) — 로드 뒤에 쓰면 확장 오리진에서 못 읽는다.
  try { writeFileSync(join(dir, RULESET_SHIM_PAGE), RULESET_SHIM_HTML); } catch { /* 못 심으면 아래에서 로그만 남는다 */ }
  const ext = await sess.loadExtension(dir, { allowFileAccess: false });
  const ids = manifestRulesets(ext && ext.manifest);
  if (ids.length) {
    try {
      const on = await enableRulesetsFor(sess, ext, ids);
      if (!on.length) throw new Error("활성화 후에도 켜진 룰셋이 없습니다");
    } catch (e) {
      // ⚠ 조용히 넘기면 안 된다 — 사용자 눈엔 "설치됨" 인데 아무것도 안 막히는 상태가 된다.
      send(IPC.LOG, { stream: "raw", line: `확장 '${ext.name}' 의 차단 규칙을 켜지 못했습니다 — ${e && e.message ? e.message : e}` });
    }
  }
  return ext;
}

/**
 * 정적 룰셋을 켠다 — **확장 오리진의 숨은 창**에서 `chrome.declarativeNetRequest` 를 부른다.
 *  ⚠ 다른 길은 없다(실측 43.4.1): `session.serviceWorkers` 엔 실행 API 가 없고 `ServiceWorkerMain` 도
 *   `send`/`ipc`/`startTask` 뿐이라 남의 확장 워커에 코드를 넣을 수 없다. 그래서 우리가 심은 페이지를 띄운다.
 *  창은 서피스 파티션으로 띄운다 — 확장이 걸린 세션이 거기이기 때문이다.
 * @returns {Promise<string[]>} 실제로 켜진 룰셋 id 목록(빈 배열이면 안 켜진 것이다)
 */
async function enableRulesetsFor(sess, ext, ids) {
  const w = new BrowserWindow({
    show: false,
    webPreferences: { partition: BROWSER_SURFACE_PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await w.loadURL(`chrome-extension://${ext.id}/${RULESET_SHIM_PAGE}`);
    const out = await w.webContents.executeJavaScript(enableRulesetsScript(ids));
    return Array.isArray(out) ? out : [];
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
}

/**
 * `.crx`·`.zip` 을 설치 폴더에 푼다. **경로는 전부 safeEntryPath 를 통과한 것만** 쓴다 —
 *  남의 압축이라 `../` 로 설치 폴더 밖을 노릴 수 있다(zip slip). 통과 못 한 엔트리는 세고 버린다.
 * @returns {{written: number, dropped: number, skipped: number}}
 */
function unpackExtension(buf, destDir) {
  const zip = buf.subarray(crxZipOffset(buf));
  const { entries, dropped } = readZipEntries(zip);
  let written = 0, skipped = 0;
  for (const e of entries) {
    const target = join(destDir, e.path);
    if (e.dir) { mkdirSync(target, { recursive: true }); continue; }
    const data = readZipEntryData(zip, e);
    if (data == null) { skipped++; continue; }        // 모르는 압축 방식 — 억지로 풀지 않는다
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    written++;
  }
  return { written, dropped, skipped };
}

/**
 * 사람이 고른 확장 파일을 설치한다. **경로를 페이지가 정하지 못한다** — 여기서 네이티브 선택창을 띄운다.
 *  풀고 → 세션에 걸고 → 룰셋을 켜고 → 목록에 남긴다. 어디서 실패하든 푼 폴더를 지워 반쯤 설치된 상태를 남기지 않는다.
 */
async function installExtensionInteractive() {
  const sess = browserSurfaceSession();
  const r = await dialog.showOpenDialog({
    title: "확장 파일 고르기",
    properties: ["openFile"],
    filters: [{ name: "브라우저 확장", extensions: ["crx", "zip"] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const file = r.filePaths[0];

  // 폴더 이름은 파일 이름에서 만든다(확장 id 는 로드해 봐야 안다) — 형태를 좁게 강제한다.
  const base = safeExtensionId(String(file.split(/[\\/]/).pop() || "").replace(/\.(crx|zip)$/i, "")) || "ext";
  const dir = join(EXT_DIR, `${base}-${Date.now().toString(36)}`);
  try {
    mkdirSync(dir, { recursive: true });
    const stats = unpackExtension(readFileSync(file), dir);
    if (!stats.written) throw new Error("압축 안에 파일이 없습니다");
    if (stats.dropped) send(IPC.LOG, { stream: "raw", line: `확장 압축에서 안전하지 않은 경로 ${stats.dropped}건을 버렸습니다.` });
    const ext = await loadExtensionInto(sess, dir);
    const list = readInstalledExtensions().filter((it) => it.id !== ext.id);
    list.push({ id: ext.id, dir, name: ext.name, version: ext.version || "" });
    writeInstalledExtensions(list);
    return { ok: true, id: ext.id, name: ext.name, version: ext.version || "" };
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 지우기 실패는 비치명 */ }
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** 확장 제거 — **우리 목록에 있는 id 만.** 페이지가 임의 경로를 지우게 하지 않는다. */
function removeExtension(id) {
  const wanted = safeExtensionId(id);
  if (!wanted) return { ok: false, error: "확장 id 형식이 올바르지 않습니다." };
  const list = readInstalledExtensions();
  const hit = list.find((it) => it.id === wanted);
  if (!hit) return { ok: false, error: "설치 목록에 없습니다." };
  try { browserSurfaceSession().removeExtension(wanted); } catch { /* 안 걸려 있었을 수 있다 — 목록에서 빼는 게 본질 */ }
  try { rmSync(hit.dir, { recursive: true, force: true }); } catch { /* 폴더가 이미 없을 수 있다 */ }
  writeInstalledExtensions(list.filter((it) => it.id !== wanted));
  return { ok: true };
}

async function reloadInstalledExtensions(sess) {
  const list = readInstalledExtensions();
  const alive = [];
  for (const it of list) {
    if (!existsSync(it.dir)) continue;                     // 지워진 건 조용히 뺀다 — 죽은 항목이 부팅을 막으면 안 된다
    try { await loadExtensionInto(sess, it.dir); alive.push(it); }
    catch (e) { send(IPC.LOG, { stream: "raw", line: `확장 '${it.name || it.id}' 을 불러오지 못했습니다 — ${e && e.message ? e.message : e}` }); }
  }
  if (alive.length !== list.length) writeInstalledExtensions(alive);
  return alive;
}

// 웹이 새 창을 열려 할 때(`window.open`·`target=_blank`)와 최상위 이동 — **두 규칙이 산다**:
//  · 웹 UI(우리 페이지·자식 창): web-shell.openTargetFor — 같은 출처는 앱 안의 새 창으로(토큰이 같은 localStorage 라
//    그대로 로그인 상태), 바깥은 시스템 브라우저로, 그 외(javascript: 등)는 열지 않는다. 자식 창에도 같은 preload·격리를 준다.
//  · 브라우저 서피스 게스트(#1829): browser-surface.surfaceNavTarget — **정반대다**(남의 사이트를 보는 게 목적).
//  그래서 게스트를 **먼저** 가르고 빠져나간다. 순서가 뒤집히면 서피스가 죽는다(browser-surface.test.mjs F1).
app.on("web-contents-created", (_e, wc) => {
  // ── 우클릭 메뉴(#1870) — 모든 webContents 공통(웹 UI·자식 창·서피스 게스트). 앱은 브라우저와 달리
  //  기본 우클릭 메뉴가 없어 링크 주소를 복사할 길이 없었다. 항목 판정은 context-menu.mjs(순수 모델)가 한다.
  wc.on("context-menu", (_ev, params) => {
    const model = contextMenuModel(params);
    if (!model.length) return;
    Menu.buildFromTemplate(model.map((m) => (m.type === "separator"
      ? { type: "separator" }
      : { label: m.label, click: () => runContextMenuAction(m.id, params, wc, clipboard) }))).popup();
  });

  // ── 브라우저 서피스 안(=`<webview>` 게스트)은 규칙이 정반대다 ───────────────────────────────────────
  //  아래 웹 UI 규칙(openTargetFor)은 "남의 사이트를 앱에 들이지 않는다" 라 **게이트웨이 밖 이동을 전부 밖으로 던진다**.
  //  그걸 서피스에도 걸면 남의 사이트를 보려고 만든 화면이 첫 이동에서 통째로 시스템 브라우저로 튄다 — 기능이 죽는다.
  //  게스트는 `getType() === "webview"` 로 갈린다(Electron 이 주는 신호라 우리가 표시를 붙일 필요가 없다).
  if (wc.getType() === "webview") {
    wc.setWindowOpenHandler(({ url }) => {
      // 서피스 안에서 새 창(`target=_blank`·window.open)은 띄우지 않는다 — 서피스는 창이 아니라 화면 한 칸이라
      //  떠도 사람이 닫을 크롬이 없다. 볼 수 있는 주소면 시스템 브라우저로 넘긴다(눌렀는데 아무 일도 없는 것보다 낫다).
      if (surfaceNavTarget(url) !== "deny") shell.openExternal(url);
      return { action: "deny" };
    });
    wc.on("will-navigate", (e, url) => {
      const t = surfaceNavTarget(url);
      if (t === "allow") return;
      e.preventDefault();
      if (t === "external") shell.openExternal(url);
    });
    return;
  }

  // ── 웹 UI(우리 페이지)가 `<webview>` 를 붙이려 할 때 — 설정은 **페이지가 아니라 여기가** 정한다 ────────
  wc.on("will-attach-webview", (e, webPreferences, params) => {
    const d = webviewAttachDecision(params);
    if (!d.allow) {
      e.preventDefault();
      if (d.external && params && params.src) shell.openExternal(params.src);
      return;
    }
    for (const k of WEBVIEW_DROPPED_PREFS) delete webPreferences[k];   // 토큰 주입 preload 를 남의 사이트에서 돌리지 않는다
    Object.assign(webPreferences, WEBVIEW_FORCED_PREFS);
    browserSurfaceSession();                                           // UA·권한 정책이 붙은 세션을 준비해 두고
    // ⚠ **`webPreferences.partition` 이어야 한다. `params.partition` 은 Electron 이 무시한다.**
    //  실측(43.4.1): `params.partition` 에 넣으면 값은 바뀌는데 게스트는 페이지가 적은 파티션에 그대로 붙는다
    //  (게스트 session !== 우리 세션, UA·권한 핸들러 전부 미적용 = **격리가 통째로 무력**). `webPreferences` 로
    //  넣어야 붙는다. 값이 반영된 것처럼 보여서 코드만 읽으면 절대 안 보이는 함정이다 — 바꾸기 전에 실기기로 재라.
    webPreferences.partition = BROWSER_SURFACE_PARTITION;
    params.allowpopups = false;   // 팝업의 실질 차단은 게스트의 setWindowOpenHandler 다(이건 겹겹이)
  });

  wc.setWindowOpenHandler(({ url }) => {
    const t = openTargetFor(url, state.gatewayUrl);
    if (t === "external") { shell.openExternal(url); return { action: "deny" }; }
    if (t !== "child") return { action: "deny" };
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 1100, height: 760, autoHideMenuBar: true, title: "라이블리",
        ...frameOptions(process.platform, osTheme()),   // 자식 창(터미널 새 창)도 같은 타이틀바 규약 — 섞이면 그게 버그로 보인다
        webPreferences: { preload: WEB_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true },
      },
    };
  });
  wc.on("will-navigate", (e, url) => {
    // 마법사(file://)는 어디로도 안 간다. 웹 창은 같은 출처 안에서만 움직인다 — 바깥 링크는 브라우저로.
    const t = openTargetFor(url, state.gatewayUrl);
    if (t === "child" && !wc.getURL().startsWith("file:")) return;
    e.preventDefault();
    if (t === "external") shell.openExternal(url);
  });
});

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
  pushWebUpdate();   // '작업 중' 은 웹의 [다시 시작하여 반영하기] 도 잠근다 — 눌러 놓고 거절당하지 않게(#1838)
  const r = await runCli({
    cli, launch: launchSpecFor(cli, args),
    env: { ...process.env },
    onHandle: (h) => { if (running) running.handle = h; },
    onEvent: (e) => { progress = reduceProgress(progress, e); send(IPC.PROGRESS, progress); },
    onStderr: (line) => send(IPC.LOG, { stream: "stderr", line }),
    // 프롬프트는 **사람에게** 넘긴다. 창이 없으면 띄운다 — 답할 사람이 없으면 CLI 가 매달린다.
    onPrompt: (p) => askUser(p),
  });
  running = null;
  scheduleAutoApply();   // 작업 중엔 미뤄 둔 업데이트 적용을 다시 판정한다
  // 재로그인(setup·login)이 성공했으면 '거부된 토큰' 판정을 푼다 — CLI 는 기존 토큰이 **먹히면** 재발급 없이
  //  "이미 로그인됨"으로 끝내므로(파일 불변), 파일 비교만으로는 오판이 영영 안 풀린다(#1541 원준님 맥 루프).
  if (r.ok && (kind === "setup" || kind === "login")) rejectedToken = null;
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
  // 입력 해석 + 진행을 막아야 하는 사유(라이블리 클라우드 로그인 주소를 넣은 경우 등)를 **먼저** 본다 —
  //  그냥 진행하면 부트스트랩이 404 를 받고 "CLI 설치가 끝났는데 실행파일이 없습니다" 라는 엉뚱한 진단이 남는다(#2044).
  const advice = gatewayAdvice(url);
  if (advice.error) return { ok: false, error: advice.error };
  try { argvFor("login", { gateway: advice.url }); } catch (e) { return { ok: false, error: e.message }; }  // 형식 검사(한 자)
  const gw = advice.url;

  // ★ 부트스트랩 조건은 '**CLI 가 없다**' 가 아니라 '**쓸 수 있는 CLI 가 없다**' 다.
  //  앱보다 먼저 CLI 를 깔아 둔 PC 가 흔한데(=지금까지 CLI 로 쓰던 모든 사람), 그 구 CLI 는 `--json-events` 를
  //  조용히 무시하고 exit 0 으로 끝낸다 → 앱은 이벤트를 하나도 못 받고 아무 설명 없이 멈춘다.
  //  종전엔 '있으면 그대로 몬다' 라서 이 상태가 **영원히 안 풀렸다**(사람이 손으로 부트스트랩 한 줄을 쳐야 했다).
  const existing = locateCli(existsSync);
  if (existing && state.cliOutdated === undefined) await refreshNodeStatus(existing);   // 아직 안 재봤으면 지금 잰다
  if (!existing || state.cliOutdated || state.cliBroken) {
    // 새 PC(또는 계약을 모르는 구 CLI) — 게이트웨이가 서빙하는 부트스트랩으로 Node·CLI·PATH 를 확보한다.
    // 문구가 사실과 맞아야 한다 — 이미 있는 걸 갈아끼우는 중에 "설치 중" 이라고 하면 사람은 뭘 하는지 모른다.
    const label = !existing ? "라이블리 CLI 설치 중"
      : state.cliBroken ? "라이블리 CLI 다시 설치 중(설치된 CLI 를 실행할 수 없습니다)"
        : "라이블리 CLI 업데이트 중(설치된 버전이 오래됐습니다)";
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
    if (cli && existing) { state = { ...state, cliOutdated: undefined, cliBroken: null }; await refreshNodeStatus(cli); }
    const stillBad = !cli || (existing && (state.cliOutdated || state.cliBroken));
    if (stillBad) {
      progress = reduceProgress(progress, { t: "step", id: "bootstrap", label, status: "fail", i: 1, n: 2 });
      progress = reduceProgress(progress, { t: "end", ok: false, code: 1 });
      state = { ...state, busy: false }; renderTray(); send(IPC.STATE, state); send(IPC.PROGRESS, progress);
      return {
        ok: false,
        error: b.error || (cli
          ? (state.cliBroken
            ? `CLI 를 다시 설치했는데도 실행할 수 없습니다(${state.cliBroken}).`
            : `CLI 를 업데이트했는데도 여전히 옛 버전입니다. 그 주소가 최신 키트를 서빙하는지 확인해 주세요: ${gw}`)
          // ★ 여기서 "주소가 맞는지 확인하세요" 로 끝내면 사람은 **맞는 주소를 어디서 보는지**를 모른다(#2044).
          //  매니지드에서 가장 흔한 원인이 그것이라(로그인 주소를 넣음) 다음 행동을 같이 준다.
          : `이 주소에서 라이블리 CLI 를 받지 못했습니다: ${gw}\n`
            + "라이블리 클라우드라면 app.lvly.io 홈의 «데스크톱 앱·CLI 로 연결» 에 있는 워크스페이스 주소를, "
            + "회사에 직접 설치했다면 관리자에게 받은 주소를 넣으세요."),
      };
    }
    progress = reduceProgress(progress, { t: "step", id: "bootstrap", label, status: "done", i: 1, n: 2 });
    send(IPC.PROGRESS, progress);
    state = { ...state, busy: false, cliPath: cli, cliFound: true };
    await refreshState();
  }
  // 로그인 + 키트 설치는 CLI 의 setup 이 통째로 한다(순서·조건은 거기가 정본).
  const r = await start("setup", { gateway: gw });
  if (!r.ok) return r;
  // 설치의 끝은 노드까지(web-shell.nextAfterSetup) — start() 끝의 deep refresh 가 nodeRunning 을 실측으로
  //  되읽은 뒤라 이 판정은 현재 상태 기준이다. 노드 시작이 실패하면 그 실패를 흐름의 결과로 돌려준다 —
  //  진행 UI 가 실패(예: tmux 안내)를 보여주고 '다시 시도'는 node-start 를 재시도한다(lastRun).
  if (nextAfterSetup(state)) return start("node-start", {});
  return r;
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
// 타이핑 중 되비추기(#2044) — 아무것도 실행하지 않는다(문자열 → 문자열). 정규화·판정의 정본은 여기다.
ipcMain.handle(IPC.GATEWAY_ADVICE, (_e, { url }) => gatewayAdvice(url));
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
ipcMain.handle(IPC.APPLY_UPDATE, async () => applyUpdate());
ipcMain.handle(IPC.CLEANUP_STALE, async () => cleanupStaleInstall());
ipcMain.handle(IPC.OPEN_APP, () => showApp());
ipcMain.handle(IPC.SET_APP_AUTOLAUNCH, (_e, { on }) => { setAppAutoLaunch(!!on); return { ok: true, on: appAutoLaunchEnabled() }; });
// ── 웹 UI 창 채널(IPC_WEB) — 원격 페이지 쪽 다리. 보내는 프레임이 **게이트웨이 출처**일 때만 답한다(다른 사이트가 이 창에
//  실렸다면 토큰도, 로그아웃도 주지 않는다). preload/web.cjs 도 출처를 한 번 더 본다(양쪽 방어).
const fromGateway = (e) => { const o = webOrigin(state.gatewayUrl); try { return !!o && new URL(e.senderFrame?.url || e.sender.getURL()).origin === o; } catch { return false; } };
ipcMain.on(IPC_WEB.BOOT, (e) => {
  const ok = fromGateway(e);
  // frameless 는 출처와 무관하다 — 이 창이 frameless 로 떠 있다는 사실이므로, 어떤 페이지가 실렸든 타이틀바는 있어야 창을 끈다.
  e.returnValue = {
    ...webBootPayload({ gatewayUrl: state.gatewayUrl, token: ok ? readTrim(join(LIVELY_DIR, "token")) : null, appVersion: safeAppVersion(), platform: process.platform }),
    frameless: framelessOn(process.platform),
    // 브라우저 서피스 능력(#1829) — 웹은 이 값의 **존재 여부로** `<webview>` 를 쓸지 폴백을 그릴지 정한다.
    //  게이트웨이 출처일 때만 준다: 남의 사이트가 이 창에 실렸다면 우리 능력을 알려 줄 이유가 없다.
    browserSurface: ok ? { version: BROWSER_SURFACE_VERSION } : null,
  };
});
// 타이틀바 색 보고(preload ③) — Windows 에서만 뜻이 있다(WCO 버튼 색). 값은 titlebarOverlayPatch 가 #RRGGBB 로 강제한다.
ipcMain.handle(IPC_WEB.TITLEBAR, (e, t) => {
  // 페이지의 실제 배경색 관측(#1683) — 창 배경을 같은 색으로 맞추고(리사이즈·재로드 중 흰 틈 방지) 다음 실행을 위해 적어 둔다.
  //  ⚠ Windows 전용 조기 반환보다 **앞**이어야 한다 — 흰 번쩍임은 모든 OS 에서 나므로.
  const pageBg = t && typeof t.color === "string" && /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : null;
  if (pageBg) {
    try { BrowserWindow.fromWebContents(e.sender)?.setBackgroundColor(pageBg); } catch { /* 창이 이미 닫혔다 */ }
    if (fromGateway(e)) saveWebBg(pageBg);   // 게이트웨이 화면일 때만 — 남의 페이지 색을 기억하지 않는다
  }
  if (process.platform !== "win32") return { ok: false };
  const patch = titlebarOverlayPatch(t);
  if (!patch) return { ok: false };
  try { BrowserWindow.fromWebContents(e.sender)?.setTitleBarOverlay(patch); return { ok: true }; }
  catch { return { ok: false }; }
});
// 브라우저 서피스 확장(#1829) — 게이트웨이 출처에서 온 요청만. 설치는 **경로 인자를 받지 않는다**(메인이 선택창을 띄운다).
ipcMain.handle(IPC_WEB.EXT_LIST, (e) => {
  if (!fromGateway(e)) return { ok: false, error: "허용되지 않은 출처입니다." };
  return { ok: true, items: readInstalledExtensions().map((it) => ({ id: it.id, name: it.name, version: it.version })) };
});
ipcMain.handle(IPC_WEB.EXT_INSTALL, async (e) => {
  if (!fromGateway(e)) return { ok: false, error: "허용되지 않은 출처입니다." };
  return installExtensionInteractive();
});
ipcMain.handle(IPC_WEB.EXT_REMOVE, (e, arg) => {
  if (!fromGateway(e)) return { ok: false, error: "허용되지 않은 출처입니다." };
  return removeExtension(arg && arg.id);
});
// 앱 업데이트(#1838) — 메인 화면(웹 UI)이 '받아 둔 게 있다' 를 보고 그 자리에서 적용하게. 게이트웨이 출처만.
//  ⚠ 적용은 **인자 없는 단일 동작**이다(이 앱을 닫고·설치하고·다시 띄운다) — 트레이 항목이 부르는 함수와 같다.
ipcMain.handle(IPC_WEB.UPDATE_STATE, (e) => (fromGateway(e) ? webUpdate() : webUpdateState({})));
ipcMain.handle(IPC_WEB.UPDATE_APPLY, async (e) => {
  if (!fromGateway(e)) return { ok: false, error: "허용되지 않은 출처입니다." };
  return applyUpdate();
});
ipcMain.handle(IPC_WEB.LOGOUT, async (e) => {
  if (!fromGateway(e)) return { ok: false, error: "허용되지 않은 출처입니다." };
  // 웹의 '로그아웃' 은 데스크톱 로그인(CLI 토큰)까지 끝낸다 — 안 그러면 다음 창 열기에서 토큰이 다시 들어가 '로그아웃이 안 된다'.
  return start("logout", {});
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
  app.on("second-instance", () => showMain());
  app.whenReady().then(async () => {
    // ★ 로그인 셸 PATH 보강(#1541, login-path.mjs 머리말) — 이 아래의 **모든** CLI 실행(status·setup·node)이
    //  이 PATH 를 물려받는다. 실측: GUI 최소 PATH 로 노드를 재시작해 pane 이 claude 를 못 찾았다(#216은 kit 쪽 방어,
    //  이건 호출자 쪽 근본 방어 — 둘이 겹쳐야 setup·tmux 탐색까지 안전하다). 실패는 무해(현재 PATH 유지).
    enrichPathFromLoginShell(process.env, process.platform, (sh, argv) =>
      execFileSync(sh, argv, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }));
    // Windows: 이게 없으면 배너가 아예 안 뜨거나 'electron.app.Electron' 이름으로 뜬다(알림 센터가 앱을 못 묶는다).
    //  설치본의 appId(package.json build.appId)와 **같은 문자열**이어야 한다 — 다르면 알림 설정이 두 앱으로 갈린다.
    try { app.setAppUserModelId(APP_ID); } catch { /* 비치명 */ }
    tray = new Tray(trayImage());
    tray.on("click", () => showMain());            // Windows·Linux 는 좌클릭이 자연스럽다
    try { startedHidden = startedHiddenFrom({ platform: process.platform, argv: process.argv, loginItem: app.getLoginItemSettings({ args: AUTOLAUNCH_ARGS }) }); } catch { startedHidden = false; }
    await refreshState({ deep: true });
    // 어느 창을 띄울지는 web-shell.startupWindow 하나가 정한다:
    //  · 할 일이 있으면(CLI 없음·구 CLI·로그인·키트) 마법사 — 로그인 자동시작으로 숨겨 떴어도. ⚠ `cliOutdated` 를 빼먹으면
    //    **가장 나쁜 조합**이 된다 — 구 CLI 인 PC 는 파일이 다 있어 '완료' 로 판정되니 창이 아예 안 뜨고, 트레이 앱은 조용히
    //    앉아 아무것도 안 한다(실측: 이 검증 하네스가 그 상태를 그대로 잡았다). 그래서 판정은 appReady 한 자리다.
    //  · 갖춰졌고 사람이 켰으면 라이블리 화면(웹 UI). 로그인 때 자동으로 숨겨 떴으면 트레이만.
    const first = startupWindow({ ready: state.ready, startedHidden });
    if (first === "setup") showWindow(); else if (first === "app") showApp();
    // 업데이트 적용 재시작 — 창에서 적용을 눌렀던 사람에게 **그 창**을 되돌려준다(마커는 applyUpdate 가 창이 보일 때만 남긴다).
    try { const m = join(LIVELY_DIR, "desktop-reopen"); if (existsSync(m)) { const which = readTrim(m); rmSync(m, { force: true }); if (which === "app") showApp(); else showWindow(); } } catch { /* noop */ }
    // 노드는 앱 밖에서도 죽고 살아난다(OS 데몬·사용자의 `lively node stop`). 주기적으로 되읽지 않으면
    //  트레이가 옛 상태를 계속 보여준다. 30초 — 사람이 느끼기엔 실시간이고 `status` 호출은 가볍다.
    const poll = setInterval(() => { if (!running) void refreshState({ deep: true }); }, 30_000);
    if (poll.unref) poll.unref();
    void checkUpdates();
    // Windows: 다른 자리에 옛 설치본이 남아 있나 — 있으면 정리 카드·트레이 항목이 뜬다(옛 바로가기가 옛 버전을 여는 것의 뿌리).
    void detectStaleInstall({ force: true });
    const up = setInterval(() => void checkUpdates(), UPDATE_INTERVAL_MS);
    if (up.unref) up.unref();
    // 앱 알림(#1842) — 첫 폴은 기준선만 잡는다(콜드스타트). 이후 30초마다 '지금 사람을 불러야 할 사건'만 배너로.
    void pollNotifications();
    const ntf = setInterval(() => void pollNotifications(), NOTIFY_POLL_MS);
    if (ntf.unref) ntf.unref();
    // 실시간 스트림 — 이게 주 경로다(위 폴링은 연결이 끊긴 동안의 폴백).
    void connectNotifyStream();
  });
  // ★ 창을 다 닫아도 종료하지 않는다(트레이 상주). 기본 동작(win/linux 종료)을 반드시 덮어야 한다.
  app.on("window-all-closed", () => { /* noop — 트레이로 산다 */ });
  app.on("before-quit", () => { quitting = true; });
  app.on("activate", () => showMain());            // macOS dock 클릭 — 갖춰졌으면 라이블리 화면
  process.on("uncaughtException", (e) => {
    try { dialog.showErrorBox("라이블리", String(e?.stack || e)); } catch { /* 다이얼로그도 못 뜨는 상황 */ }
  });
}
