// 알림의 워크스페이스 실동작 검증 (#4054) — **수동 실행**(Electron 이 필요해 루트 테스트 체인엔 안 들어간다).
//   실행:  npm run build(루트) 뒤  cd desktop && npm install && node verify-notify-workspace.mjs
//
// desktop-core.test.mjs · src/v6/*.test.ts 는 판정을 표로 못박는다. 이 스크립트는 그 판정이 **실제 Electron·실제 HTTP·
//  실제 웹 화면** 위에서 그대로 성립하는지 잰다 —
//   ① 서버 라우트(dist/v6/notify-routes.js)에 앱과 같은 주소(`?all=1`)로 붙으면 자기 워크스페이스 + 계정으로 확인된
//      다른 워크스페이스 사건만 오고, **계정 없는 같은 아이디 · 목록에 없는 워크스페이스 사건은 안 온다**
//   ② 사건마다 워크스페이스 표시가 붙고, 그 표시로 만든 배너(부제 포함)가 실제 Notification 으로 뜬다
//   ③ 클릭 경로 — 지금 창의 해시 / 창이 다른 출처일 때 매인 곳 다시 싣기 / 다른 워크스페이스는 계정 서버 입장 주소 /
//      셀프호스트 다중: 실제 웹(net.js)이 주소의 `lvly_ws` 를 반영하고 지운 뒤, 다음 클릭은 해시로 끝난다
//  판정은 여기서 다시 적지 않는다 — 앱이 쓰는 모듈(notify.mjs · web-shell.mjs)을 그대로 불러 쓴다. 브라우저는 열지 않는다
//  (계정 서버 입장 주소는 만들어진 값만 확인한다). 게이트웨이는 이 프로세스가 띄운 로컬 express 다(외부 접속 0).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const DESKTOP = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(DESKTOP);
const require = createRequire(DESKTOP + "/package.json");
const electron = require("electron");
const href = (...p) => JSON.stringify(pathToFileURL(join(...p)).href);
for (const need of [join(ROOT, "dist", "v6", "notify-routes.js"), join(ROOT, "public", "app", "lib", "net.js")]) {
  if (!existsSync(need)) { console.error(`빌드 산출물이 없습니다: ${need} — 루트에서 npm run build 를 먼저 돌리세요.`); process.exit(2); }
}

const PROBE = `
const { app, BrowserWindow, Notification } = require("electron");
const express = require(${JSON.stringify(join(ROOT, "node_modules", "express"))});
const out = (o) => process.stdout.write("PROBE " + JSON.stringify(o) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(20); } return pred(); };
(async () => {
  try {
    const bus = await import(${href(ROOT, "dist", "v6", "notify-bus.js")});
    const routes = await import(${href(ROOT, "dist", "v6", "notify-routes.js")});
    const notify = await import(${href(DESKTOP, "main", "notify.mjs")});
    const shell = await import(${href(DESKTOP, "main", "web-shell.mjs")});
    await app.whenReady();

    const CP = "https://app.lvly.io";
    const WSID = "244ae282-255c-4cdb-843c-26c250e366a8";
    const OWN = { slug: "primary", name: "Lively", current: true, via: "same" };
    const OTHER = { slug: "soltimal-adce", name: "NCEO", current: false, via: "enter", enter: CP + "/ws/" + WSID + "/enter" };

    // ── 게이트웨이: 실제 스트림 라우트 + 실제 웹 화면(public) — 판정(resolver)만 대본 ──
    const srv = express();
    srv.use("/ui", express.static(${JSON.stringify(join(ROOT, "public"))}));
    const resolverCalls = [];
    routes.registerNotifyRoutes(srv, [(_q, _r, n) => n()], () => "alice", async (_req, me, all) => {
      resolverCalls.push(all);
      return { routes: [{ ws: "primary", member: me, label: OWN }, ...(all ? [{ ws: OTHER.slug, account: "acct-1", label: OTHER }] : [])], transient: false };
    });
    srv.use("/api", (_q, r) => r.status(404).json({ error: "not found" }));
    const listener = await new Promise((res) => { const l = srv.listen(0, "127.0.0.1", () => res(l)); });
    const port = listener.address().port;
    const GW = "http://127.0.0.1:" + port;
    const ELSEWHERE = "http://localhost:" + port;     // 같은 서버, 다른 출처(창이 다른 곳을 싣고 있는 경우)

    // ── ① 앱과 같은 주소로 스트림에 붙는다 ──
    const got = [], seen = new Set();
    const res = await fetch(notify.streamUrl(GW), { headers: { Accept: "text/event-stream" } });
    if (!res.ok || !res.body) throw new Error("스트림 연결 실패 " + res.status);
    (async () => {
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const p = notify.parseSse(buf); buf = p.rest;
        for (const ev of p.events) {
          const hit = notify.streamEvent(ev, seen, undefined);
          if (hit) { seen.add(hit.key); got.push(hit); }
        }
      }
    })().catch(() => {});
    const widened = await until(() => bus.accountRoutesActive("acct-1"), 3000);
    const E = (id) => ({ type: "session", id, name: "세션 " + id.slice(-5), prev: "busy", phase: "idle", key: "k-" + id, ts: Date.now() });
    const delivered = [
      bus.publishNotify({ ws: "primary", member: "alice" }, E("box-alice-own01")),
      bus.publishNotify({ ws: "soltimal-adce", member: "alice-9", account: "acct-1" }, E("box-alice-oth01")),
      bus.publishNotify({ ws: "soltimal-adce", member: "alice" }, E("box-alice-leak1")),
      bus.publishNotify({ ws: "wonjoon-jang-074e", member: "alice", account: "acct-1" }, E("box-alice-unls1")),
    ];
    await until(() => got.length >= 2, 3000); await sleep(300);

    // ── ② 배너 — 실제 Notification(부제는 macOS 만) ──
    const banners = got.map((hit) => {
      const b = notify.bannerFor(hit, process.platform);
      let shown = false;
      try { const n = new Notification({ title: b.title, body: b.body, ...(b.subtitle ? { subtitle: b.subtitle } : {}) }); n.show(); shown = true; } catch { /* 아래에서 판정 */ }
      return { id: hit.id, title: b.title, subtitle: b.subtitle ?? null, body: b.body, shown };
    });

    // ── ③ 클릭 — 실제 창 ──
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    const wc = win.webContents;
    const nav = shell.createHashNav();
    wc.on("did-finish-load", () => nav.loaded(wc));   // main.mjs 가 거는 두 자리와 같다(#3896 · #4054)
    wc.on("did-stop-loading", () => nav.loaded(wc));
    const loadWait = (url) => new Promise((r) => { wc.once("did-finish-load", r); wc.loadURL(url).catch(() => {}); });
    const js = (code) => wc.executeJavaScript(code);
    const cp = [CP];
    const own = got.find((h) => h.id === "box-alice-own01");
    const other = got.find((h) => h.id === "box-alice-oth01");

    await loadWait(GW + "/ui/#/home");
    const tOwn = own ? notify.clickTarget(own, { gatewayUrl: GW, windowUrl: wc.getURL(), cpOrigins: cp }) : null;
    const ownDiag = { loadingMain: wc.isLoadingMainFrame(), loading: wc.isLoading(), url: wc.getURL() };
    ownDiag.open = tOwn && tOwn.how === "hash" ? nav.open(wc, tOwn.hash) : null;
    ownDiag.h50 = await (sleep(50).then(() => js("location.hash")));
    await sleep(250);
    const ownHash = await js("location.hash");
    ownDiag.h300 = ownHash;
    const tOther = other ? notify.clickTarget(other, { gatewayUrl: GW, windowUrl: wc.getURL(), cpOrigins: cp }) : null;

    await loadWait(ELSEWHERE + "/ui/#/home");
    const beforeDrift = wc.getURL();
    const tDrift = own ? notify.clickTarget(own, { gatewayUrl: GW, windowUrl: beforeDrift, cpOrigins: cp }) : null;
    if (tDrift && tDrift.how === "load") await loadWait(tDrift.url);
    const drift = { before: beforeDrift, after: wc.getURL(), hash: await js("location.hash") };

    await js("localStorage.removeItem('lively.workspace'); true");
    const regEv = { kind: "session_done", id: "box-alice-reg01", name: "r", ws: { slug: "haru", name: "하루", current: false, via: "header" } };
    const sel0 = await js(notify.READ_WEB_WORKSPACE_JS);
    const tReg = notify.clickTarget(regEv, { gatewayUrl: GW, windowUrl: wc.getURL(), windowWs: sel0, cpOrigins: cp });
    if (tReg.how === "load") await loadWait(tReg.url);
    await sleep(400);
    const reg = { url: wc.getURL(), search: await js("location.search"), hash: await js("location.hash"), sel: await js(notify.READ_WEB_WORKSPACE_JS) };
    const tReg2 = notify.clickTarget(regEv, { gatewayUrl: GW, windowUrl: wc.getURL(), windowWs: reg.sel, cpOrigins: cp });

    listener.closeAllConnections?.();
    out({ ok: true, platform: process.platform, resolverCalls, widened, delivered, got: got.map((h) => ({ id: h.id, ws: h.ws })),
          banners, tOwn, ownHash, ownDiag, tOther, tDrift, drift, sel0, tReg, reg, tReg2, GW });
    setTimeout(() => app.exit(0), 2500);
  } catch (e) { out({ ok: false, error: String(e && e.stack || e) }); setTimeout(() => app.exit(1), 200); }
})();
`;

const dir = mkdtempSync(join(tmpdir(), "lively-notify-ws-verify-"));
writeFileSync(join(dir, "probe.cjs"), PROBE);
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "lively-notify-ws-verify", main: "probe.cjs", version: "0.0.0" }));
const child = spawn(electron, [dir, "--user-data-dir=" + join(dir, "udata")], { stdio: ["ignore", "pipe", "pipe"] });
let buf = "", stderr = "";
child.stdout.on("data", (d) => { buf += d; });
child.stderr.on("data", (d) => { stderr += d; });
const timer = setTimeout(() => { child.kill(); }, 60_000);
child.on("exit", (code) => {
  clearTimeout(timer);
  const line = buf.split("\n").find((l) => l.startsWith("PROBE "));
  rmSync(dir, { recursive: true, force: true });
  if (!line) { console.error("결과 없음(exit " + code + ")\n" + stderr.slice(-2000)); process.exit(1); }
  const r = JSON.parse(line.slice(6));
  if (!r.ok) { console.error(r.error); process.exit(1); }
  const checks = [];
  const check = (name, cond, detail) => { checks.push([name, !!cond]); console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? "  — " + detail : ""}`); };
  const byId = Object.fromEntries(r.got.map((g) => [g.id, g]));
  check("스트림이 다른 워크스페이스를 청했다(all=1 → 판정에 전달)", r.resolverCalls[0] === true, JSON.stringify(r.resolverCalls));
  check("계정 확인 뒤 넓어졌다", r.widened);
  check("전달 수: 자기 1 · 다른 1 · 계정 없는 같은 아이디 0 · 목록 밖 0", JSON.stringify(r.delivered) === "[1,1,0,0]", JSON.stringify(r.delivered));
  check("받은 사건이 정확히 둘", r.got.length === 2, r.got.map((g) => g.id).join(","));
  check("자기 사건 표시 = Lively(지금 여기)", byId["box-alice-own01"]?.ws?.name === "Lively" && byId["box-alice-own01"]?.ws?.current === true);
  check("다른 사건 표시 = NCEO(enter · 입장 주소)", byId["box-alice-oth01"]?.ws?.name === "NCEO" && byId["box-alice-oth01"]?.ws?.via === "enter" && !!byId["box-alice-oth01"]?.ws?.enter);
  for (const b of r.banners) {
    const mac = r.platform === "darwin";
    const want = b.id === "box-alice-own01" ? "Lively" : "NCEO";
    check(`배너 윗줄 = ${want} (${b.id})`, b.title === want, `${b.title} / ${b.subtitle ?? "-"} / ${b.body}`);
    check(`배너 무슨 일 = 작업을 마쳤어요 (${mac ? "부제" : "본문 앞"})`, mac ? b.subtitle === "작업을 마쳤어요" : String(b.body).startsWith("작업을 마쳤어요 — "));
    check(`실제 Notification 표시 (${b.id})`, b.shown);
  }
  check("자기 사건 클릭 → 지금 창의 해시", r.tOwn?.how === "hash" && r.ownHash === "#/s/box-alice-own01", JSON.stringify(r.tOwn) + " → " + r.ownHash + " " + JSON.stringify(r.ownDiag));
  check("다른 워크스페이스 클릭 → 계정 서버 입장 주소 + 착지 해시", r.tOther?.how === "external"
    && r.tOther.url === "https://app.lvly.io/ws/244ae282-255c-4cdb-843c-26c250e366a8/enter?to=%23%2Fs%2Fbox-alice-oth01", JSON.stringify(r.tOther));
  check("창이 다른 출처일 때 자기 사건 클릭 → 매인 곳을 다시 싣고 그 세션 해시", r.tDrift?.how === "load"
    && new URL(r.drift.after).origin === r.GW && r.drift.hash === "#/s/box-alice-own01", `${r.drift.before} → ${r.drift.after}`);
  check("셀프호스트 다중: 선택 없음(\"\") 을 읽었다", r.sel0 === "", JSON.stringify(r.sel0));
  check("셀프호스트 다중: 선택이 달라 ?lvly_ws= 로 다시 싣는다", r.tReg?.how === "load" && /\?lvly_ws=haru#\/s\/box-alice-reg01$/.test(r.tReg.url), JSON.stringify(r.tReg));
  check("실제 웹(net.js)이 선택을 반영했다", r.reg.sel === "haru", JSON.stringify(r.reg));
  check("실제 웹이 주소에서 lvly_ws 를 지우고 해시는 남겼다", r.reg.search === "" && r.reg.hash === "#/s/box-alice-reg01" && !/lvly_ws/.test(r.reg.url), r.reg.url);
  check("같은 워크스페이스로 다시 누르면 해시로 끝난다(다시 싣지 않는다)", r.tReg2?.how === "hash", JSON.stringify(r.tReg2));
  const bad = checks.filter(([, ok]) => !ok);
  console.log(`\n${bad.length ? "FAIL" : "PASS"} — ${checks.length - bad.length}/${checks.length} (${r.platform})`);
  process.exit(bad.length ? 1 : 0);
});
