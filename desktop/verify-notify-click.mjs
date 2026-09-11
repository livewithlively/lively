// 알림 클릭 실동작 검증 (#3896) — **수동 실행**(Electron 이 필요해 루트 테스트 체인엔 안 들어간다).
//   실행:  cd desktop && npm install && node verify-notify-click.mjs
//
// 왜 필요한가: desktop-core.test.mjs 는 keepBanner·createHashNav 의 판정을 가짜 객체로 표에 못박는다. 그런데 이 수정이
//  기대는 두 사실은 **Electron 이 실제로 그렇게 동작해야만** 참이다 —
//   ① 쥐지 않은 Notification JS 객체는 GC 된다(그러면 네이티브 delegate 가 끊겨 클릭이 버려진다) · 쥐면 산다
//   ② 액자만 싣는 중이면 isLoading()=참 · isLoadingMainFrame()=거짓이고, did-finish-load 는 다시 오지 않는다
//  이 스크립트는 둘을 **대조군과 함께** 실제 Electron 에서 잰다 — 대조군이 옛 증상을 못 만들면 측정이 무력한 것이라 실패로 본다.
//  네트워크·게이트웨이는 쓰지 않는다: 시험 페이지는 probe:// 스킴으로 이 프로세스가 직접 서빙한다.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const DESKTOP = dirname(fileURLToPath(import.meta.url));
const require = createRequire(DESKTOP + "/package.json");
const electron = require("electron");
const mod = (f) => JSON.stringify(pathToFileURL(join(DESKTOP, "main", f)).href);

// Electron 안에서 돌 코드 — 앱이 쓰는 모듈(notify.mjs · web-shell.mjs)을 그대로 불러 잰다(판정을 여기서 다시 적지 않는다).
const PROBE = `
const { app, BrowserWindow, Notification, protocol } = require("electron");
protocol.registerSchemesAsPrivileged([{ scheme: "probe", privileges: { standard: true, secure: true } }]);
const out = (o) => process.stdout.write("PROBE " + JSON.stringify(o) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(20); } return pred(); };
const settle = async () => { for (let i = 0; i < 4; i++) { await sleep(50); global.gc(); } };
(async () => {
  try {
    const { keepBanner } = await import(${mod("notify.mjs")});
    const { createHashNav } = await import(${mod("web-shell.mjs")});
    await app.whenReady();
    protocol.handle("probe", async (req) => {
      const { pathname } = new URL(req.url);
      const html = (s) => new Response("<!doctype html><meta charset=utf-8><body>" + s + "</body>", { headers: { "content-type": "text/html" } });
      if (pathname === "/hang") return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/html" } });
      if (pathname === "/slow") { await sleep(800); return html("slow"); }
      return html("page");
    });

    // ── ① 배너 객체의 수명 ──
    const banner = () => { const n = new Notification({ title: "verify", body: "gc", silent: true }); n.on("click", () => {}); try { n.show(); } catch {} return n; };
    const loose = new WeakRef(banner());
    const kept = new Set();
    const held = new WeakRef((() => { const n = banner(); keepBanner(kept, n); return n; })());
    await settle();
    const gc = { looseCollected: !loose.deref(), keptAlive: !!held.deref() };
    kept.clear();                                        // main.mjs 와 같이 close() 없이 놓는다
    await settle();
    gc.releasedCollected = !held.deref();
    //  참고 측정 — close() 한 배너는 놓아도 GC 되지 않았다(2026-09-11, 43.3.0). 그래서 상한으로 놓을 때 close 하지 않는다.
    const closedKept = new Set();
    const closed = new WeakRef((() => { const n = banner(); keepBanner(closedKept, n); return n; })());
    await settle();
    for (const n of closedKept) { try { n.close(); } catch {} }
    closedKept.clear();
    await settle();
    gc.closedStillAlive = !!closed.deref();

    // ── ② 액자만 싣는 중에 누른다 ──
    const nav = {};
    const hashOf = (wc) => wc.executeJavaScript("location.hash");
    const w1 = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    const wc1 = w1.webContents;
    await w1.loadURL("probe://t/page#/s/a");
    await wc1.executeJavaScript("{ const f = document.createElement('iframe'); f.src = 'probe://t/hang'; document.body.append(f); }");
    nav.subframeLoading = await until(() => wc1.isLoading() && !wc1.isLoadingMainFrame(), 3000);
    //  대조군 — 종전 openHashInApp 의 대기 그대로
    let oldRan = false;
    const oldGo = () => { oldRan = true; void wc1.executeJavaScript('location.hash = "#/s/old"').catch(() => {}); };
    if (wc1.isLoading()) wc1.once("did-finish-load", oldGo); else oldGo();
    await sleep(1500);
    wc1.removeListener("did-finish-load", oldGo);
    nav.oldParked = !oldRan;
    nav.oldHash = await hashOf(wc1);
    nav.subframeResult = createHashNav().open(wc1, "#/s/b");
    await sleep(400);
    nav.subframeHash = await hashOf(wc1);

    // ── ③ 새 창을 싣는 도중에 누른다 · ④ 다시 싣는 도중에 누른다 ──
    const w2 = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    const wc2 = w2.webContents;
    const nav2 = createHashNav();
    wc2.on("did-finish-load", () => nav2.loaded(wc2));   // main.mjs 가 거는 자리와 같다
    const loading = w2.loadURL("probe://t/slow");
    nav.coldResult = nav2.open(wc2, "#/s/c");
    await loading; await sleep(400);
    nav.coldHash = await hashOf(wc2);
    const reloaded = new Promise((r) => wc2.once("did-finish-load", r));
    wc2.reload();
    nav.reloadResult = nav2.open(wc2, "#/s/d");
    await reloaded; await sleep(400);
    nav.reloadHash = await hashOf(wc2);

    out({ ok: true, electron: process.versions.electron, gc, nav });
    setTimeout(() => app.exit(0), 100);
  } catch (e) { out({ ok: false, error: String(e && e.stack || e) }); setTimeout(() => app.exit(1), 100); }
})();
`;

const dir = mkdtempSync(join(tmpdir(), "lively-notify-click-verify-"));
writeFileSync(join(dir, "probe.cjs"), PROBE);
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "lively-notify-click-verify", main: "probe.cjs", version: "0.0.0" }));

const child = spawn(electron, [dir, "--js-flags=--expose-gc", "--user-data-dir=" + join(dir, "udata")], { stdio: ["ignore", "pipe", "pipe"] });
let buf = "", stderr = "";
child.stdout.on("data", (d) => { buf += d; });
child.stderr.on("data", (d) => { stderr += d; });
child.on("close", (code) => {
  const line = buf.split("\n").find((l) => l.startsWith("PROBE "));
  const r = line ? JSON.parse(line.slice(6)) : null;
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* 임시 폴더가 남아도 판정과 무관하다 */ }
  if (!r || !r.ok) {
    console.error("실패 — 검증 프로브가 끝까지 돌지 못했다.", r ? r.error : `exit=${code}\n${stderr.slice(-2000)}`);
    process.exit(1);
  }
  const { gc, nav } = r;
  const rows = [
    ["R1 대조군: 안 쥔 배너는 GC 된다", gc.looseCollected],
    ["R2 쥔 배너는 GC 뒤에도 산다", gc.keptAlive],
    ["R2 놓은 배너는 GC 된다", gc.releasedCollected],
    ["R3 전제: 액자만 싣는 중(isLoading 참 · isLoadingMainFrame 거짓)", nav.subframeLoading],
    ["R3 대조군: 종전 대기로는 이동하지 못한다", nav.oldParked && nav.oldHash === "#/s/a"],
    ["R3 createHashNav 는 지금 이동한다", nav.subframeResult === "now" && nav.subframeHash === "#/s/b"],
    ["R4 새 창을 싣는 도중 누르면 다 실린 뒤 그 화면", nav.coldResult === "pending" && nav.coldHash === "#/s/c"],
    ["R5 다시 싣는 도중 누르면 다 실린 뒤 그 화면", nav.reloadResult === "pending" && nav.reloadHash === "#/s/d"],
  ];
  console.log(`Electron ${r.electron}`);
  for (const [name, ok] of rows) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  console.log(JSON.stringify({ gc, nav }));
  if (rows.some(([, ok]) => !ok)) process.exit(1);
  console.log("\nPASS — 배너는 GC 를 넘어 살고, 액자가 싣는 중에도 클릭이 그 화면으로 간다.");
});
