// 앱 알림 실동작 검증 (#1842) — **수동 실행**(Electron 이 필요해 루트 테스트 체인엔 안 들어간다).
//   실행:  cd desktop && npm install && node verify-notify.mjs
//
// 왜 필요한가: desktop-core.test.mjs 는 "어떤 사건에 무슨 문구가 나가나" 까지만 본다. 그게 **실제 OS 배너로
//  뜨는지**는 Electron 을 띄워야만 알 수 있고, 여기서 조용히 실패하는 길이 셋 있다 —
//   ① Notification.isSupported() 가 false (리눅스에 알림 데몬 없음)
//   ② macOS: 서명·번들이 없는 개발 실행은 'Electron' 이름으로 뜬다(패키지 앱과 권한이 갈린다)
//   ③ Windows: setAppUserModelId 를 안 하면 배너가 아예 안 뜬다
//  이 스크립트는 우리 판정(notify.mjs)이 만든 문구를 **그대로** 실제 Notification 으로 태워 그 셋을 가른다.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const DESKTOP = dirname(fileURLToPath(import.meta.url));
const require = createRequire(DESKTOP + "/package.json");
const electron = require("electron");

// Electron 안에서 돌 코드 — 우리 판정 모듈을 실제로 불러 배너를 띄운다(문구를 여기서 다시 적지 않는다).
const PROBE = `
const { app, Notification } = require("electron");
(async () => {
  const out = (o) => { process.stdout.write("PROBE " + JSON.stringify(o) + "\\n"); };
  try {
    const notify = await import(${JSON.stringify("file://" + join(DESKTOP, "main", "notify.mjs"))});
    const { APP_ID } = await import(${JSON.stringify("file://" + join(DESKTOP, "main", "win-stale-install.mjs"))});
    app.setAppUserModelId(APP_ID);
    await app.whenReady();
    // 콜드스타트 → 대기 진입 → 완료 로, **판정을 통해** 사건을 만든다(문구를 손으로 적지 않는다).
    const s = (o) => [{ id: "box-verify-1", label: "알림 검증 세션", harness: "claude", owned: true, agentState: "offline", awaiting: false, working: false, ...o }];
    const base = notify.snapshotSessions(s({ working: true }));
    const waiting = notify.snapshotSessions(s({ working: true, awaiting: true }));
    const cold = notify.diffSessions(null, base);
    const events = notify.diffSessions(base, waiting);
    const plan = notify.planBanners(events);
    const supported = Notification.isSupported();
    let shown = 0, err = null;
    for (const b of plan) {
      try { const n = new Notification({ title: b.title, body: b.body }); n.show(); shown++; }
      catch (e) { err = String(e && e.message || e); }
    }
    out({ ok: true, supported, appId: APP_ID, coldStart: cold.length, events: events.map((e) => e.kind), plan: plan.map((b) => ({ title: b.title, body: b.body })), shown, err,
          bundleId: (process.platform === "darwin" ? (app.getName() || "") : ""), packaged: app.isPackaged });
    setTimeout(() => app.exit(0), 4000);   // 배너가 화면에 남을 시간을 준다(사람이 눈으로도 볼 수 있게)
  } catch (e) { out({ ok: false, error: String(e && e.stack || e) }); setTimeout(() => app.exit(1), 200); }
})();
`;

const dir = mkdtempSync(join(tmpdir(), "lively-notify-verify-"));
writeFileSync(join(dir, "probe.cjs"), PROBE);
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "lively-notify-verify", main: "probe.cjs", version: "0.0.0" }));

const child = spawn(electron, [dir, "--user-data-dir=" + join(dir, "udata")], { stdio: ["ignore", "pipe", "pipe"] });
let buf = "", stderr = "";
child.stdout.on("data", (d) => { buf += d; });
child.stderr.on("data", (d) => { stderr += d; });
child.on("exit", (code) => {
  const line = buf.split("\n").find((l) => l.startsWith("PROBE "));
  const r = line ? JSON.parse(line.slice(6)) : null;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  if (!r || !r.ok) {
    console.error("실패 — 앱이 알림 경로를 태우지 못했다.", r ? r.error : `exit=${code}\n${stderr.slice(-2000)}`);
    process.exit(1);
  }
  const fail = [];
  if (!r.supported) fail.push("Notification.isSupported() = false — 이 환경엔 알림 데몬이 없다");
  if (r.coldStart !== 0) fail.push(`콜드스타트가 ${r.coldStart}건을 만들었다 — 첫 폴은 기준선만 잡아야 한다`);
  if (String(r.events) !== "session_waiting") fail.push(`전이 판정이 다르다: ${r.events}`);
  if (r.shown !== r.plan.length) fail.push(`배너 ${r.plan.length}장 중 ${r.shown}장만 떴다 — ${r.err || "사유 미상"}`);
  console.log(`앱 식별자   : ${r.appId}${r.packaged ? " (패키지)" : " (개발 실행 — macOS 는 'Electron' 이름으로 뜬다)"}`);
  console.log(`알림 지원   : ${r.supported}`);
  console.log(`콜드스타트  : ${r.coldStart}건 (0이어야 정상)`);
  console.log(`전이 판정   : ${r.events.join(", ")}`);
  for (const b of r.plan) console.log(`배너        : [${b.title}] ${b.body}`);
  console.log(`실제 표시   : ${r.shown}/${r.plan.length}장`);
  if (fail.length) { console.error("\n실패:\n - " + fail.join("\n - ")); process.exit(1); }
  console.log("\nPASS — 판정이 만든 문구가 실제 OS 배너로 떴다.");
});
