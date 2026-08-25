// 실시간 알림 종단 측정 (#1842 3차) — **수동 실행**.
//   실행:  cd desktop && node verify-stream.mjs
//
// 무엇을 재나: 게이트웨이가 사건을 발행한 순간부터 **앱이 OS 배너를 띄우기까지** 몇 ms 인가.
//  "AI 를 여러 개 병렬로 돌리다 끝나는 것마다 바로 받는다"가 이 프로젝트의 요구라, 그 '바로'를 숫자로 못박는다.
//
// 태우는 것은 **실제 코드 그대로**다 —
//   서버: dist/v6/notify-routes.js(SSE 라우트) + dist/v6/notify-bus.js(발행)
//   앱  : desktop/main/notify.mjs 의 parseSse·streamEvent·phaseEventKind·bannerFor
//  둘을 한 Electron 프로세스에 함께 띄워 실제 HTTP 로 잇는다.
//
// ⚠ 이 하네스가 **덮지 못하는 한 조각**: 하네스 훅 보고 라우트(`POST …/sessions/:id/active`)가 전이를 만들면
//  publishNotify 를 부르는 그 배선. 그건 tmux 세션이 실제로 필요해 격리 스택에서만 확인되고,
//  여기서는 publishNotify 를 직접 불러 그 아래 전 구간을 잰다.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const DESKTOP = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(DESKTOP);
const require = createRequire(DESKTOP + "/package.json");
const electron = require("electron");

const PROBE = `
const { app, Notification } = require("electron");
const express = require(${JSON.stringify(join(ROOT, "node_modules", "express"))});
(async () => {
  const out = (o) => { process.stdout.write("PROBE " + JSON.stringify(o) + "\\n"); };
  try {
    const bus = await import(${JSON.stringify("file://" + join(ROOT, "dist", "v6", "notify-bus.js"))});
    const routes = await import(${JSON.stringify("file://" + join(ROOT, "dist", "v6", "notify-routes.js"))});
    const notify = await import(${JSON.stringify("file://" + join(DESKTOP, "main", "notify.mjs"))});
    await app.whenReady();

    // ── 서버: 실제 SSE 라우트를 그대로 마운트(인증 미들웨어는 고정 신원으로 대체) ──
    const srv = express();
    routes.registerNotifyRoutes(srv, [(req, _res, next) => next()], () => "alice");
    const listener = await new Promise((res) => { const l = srv.listen(0, "127.0.0.1", () => res(l)); });
    const port = listener.address().port;

    // ── 앱: 실제 클라이언트 경로(fetch → parseSse → streamEvent → bannerFor → Notification) ──
    const seen = new Set();
    const results = [];
    let resolveAll; const allDone = new Promise((r) => { resolveAll = r; });
    const EXPECT = 5;                                   // 병렬 세션 5개가 동시에 끝나는 상황
    const res = await fetch("http://127.0.0.1:" + port + "/api/ui/notify/stream", { headers: { Accept: "text/event-stream" } });
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
          if (!hit) continue;
          seen.add(hit.key);
          const b = notify.bannerFor(hit);
          let shown = false;
          try { new Notification({ title: b.title, body: b.body }).show(); shown = true; } catch { /* 아래에서 센다 */ }
          results.push({ ms: Date.now() - ev.ts, kind: hit.kind, name: hit.name, title: b.title, shown });
          if (results.length >= EXPECT) resolveAll();
        }
      }
    })();

    await new Promise((r) => setTimeout(r, 300));       // 구독이 붙을 틈
    const streams = bus.notifyStreamCount("alice");

    // ── 병렬 세션 5개가 잇달아 끝나는 순간을 그대로 발행 ──
    const t0 = Date.now();
    for (let i = 1; i <= EXPECT; i++) {
      bus.publishNotify("alice", { type: "session", id: "box-jang-p" + i, name: "병렬 작업 " + i,
        prev: "busy", phase: "idle", key: bus.sessionEventKey("box-jang-p" + i, "idle", 1000 + i), ts: Date.now() });
    }
    // 중복 발행(재시도·중복 보고) 이 배너를 두 번 만들지 않는지도 함께 본다
    bus.publishNotify("alice", { type: "session", id: "box-jang-p1", name: "병렬 작업 1",
      prev: "busy", phase: "idle", key: bus.sessionEventKey("box-jang-p1", "idle", 1001), ts: Date.now() });

    const timeout = new Promise((r) => setTimeout(() => r("timeout"), 5000));
    const who = await Promise.race([allDone.then(() => "ok"), timeout]);
    const total = Date.now() - t0;

    // 해지 확인 — 스트림을 끊으면 구독이 정리되는가(안 되면 앱을 껐다 켤 때마다 샌다)
    listener.closeAllConnections?.();
    await new Promise((r) => setTimeout(r, 300));
    const after = bus.notifyStreamCount("alice");

    out({ ok: true, who, streams, after, total, count: results.length,
          ms: results.map((r) => r.ms), shown: results.filter((r) => r.shown).length,
          sample: results.slice(0, 3).map((r) => r.title + " | " + r.name) });
    setTimeout(() => app.exit(0), 3500);                // 배너가 화면에 남을 시간
  } catch (e) { out({ ok: false, error: String(e && e.stack || e) }); setTimeout(() => app.exit(1), 200); }
})();
`;

const dir = mkdtempSync(join(tmpdir(), "lively-stream-verify-"));
writeFileSync(join(dir, "probe.cjs"), PROBE);
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "lively-stream-verify", main: "probe.cjs", version: "0.0.0" }));

const child = spawn(electron, [dir, "--user-data-dir=" + join(dir, "udata")], { stdio: ["ignore", "pipe", "pipe"] });
let buf = "", stderr = "";
child.stdout.on("data", (d) => { buf += d; });
child.stderr.on("data", (d) => { stderr += d; });
child.on("exit", (code) => {
  const line = buf.split("\n").find((l) => l.startsWith("PROBE "));
  const r = line ? JSON.parse(line.slice(6)) : null;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  if (!r || !r.ok) { console.error("실패:", r ? r.error : `exit=${code}\n${stderr.slice(-1500)}`); process.exit(1); }
  const fail = [];
  if (r.who !== "ok") fail.push("5건이 5초 안에 도착하지 않았다");
  if (r.streams !== 1) fail.push(`구독이 ${r.streams}개다(1이어야 한다)`);
  if (r.after !== 0) fail.push(`스트림을 끊었는데 구독이 ${r.after}개 남았다 — 앱을 껐다 켤 때마다 샌다`);
  if (r.count !== 5) fail.push(`배너 사건이 ${r.count}건이다 — 중복 발행이 배너를 늘렸거나 사건을 잃었다`);
  if (r.shown !== r.count) fail.push(`${r.count}건 중 ${r.shown}건만 실제로 떴다`);
  const max = Math.max(...r.ms), avg = Math.round(r.ms.reduce((a, b) => a + b, 0) / r.ms.length);
  console.log(`구독        : ${r.streams}개 · 끊은 뒤 ${r.after}개(0이어야 정상)`);
  console.log(`병렬 5건    : ${r.count}건 도착 · ${r.shown}건 실제 배너 (중복 발행 1건은 걸러져야 정상)`);
  console.log(`지연        : 평균 ${avg}ms · 최대 ${max}ms · 5건 전부 ${r.total}ms 안에`);
  for (const s of r.sample) console.log(`배너        : ${s}`);
  if (fail.length) { console.error("\n실패:\n - " + fail.join("\n - ")); process.exit(1); }
  console.log(`\nPASS — 발행에서 OS 배너까지 최대 ${max}ms (폴링 30,000ms 대비).`);
});
