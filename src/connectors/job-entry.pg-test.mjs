// 수집 판(#3994 T3) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/connectors/job-entry.pg-test.mjs
//
// 왜 이 계층인가: 판 경로의 약속은 전부 **run 행의 상태 전이**다 — «판이 먼저, 행이 나중» · 판 추적기는 자기 행을 본 뒤에만
//  수집한다 · 끝 기록은 running 행에만 쓴다 · 취소는 행을 먼저 닫는다 · 기록 없이 죽은 판은 감시가 닫는다.
//  목 풀로는 조건 하나를 지워도 초록이다. 그래서 판 엔트리를 **실제 프로세스로** 띄우고(수집 자식까지 진짜 run-sync),
//  게이트웨이 경로는 가짜 op 소켓 앞에서 돌려, 부작용을 SELECT 로 되읽어 판정한다.
//
//  사양·엣지 표: 스크래치패드 spec.md — E-P(판 안 추적기) · E-W(게이트웨이).
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const DIST = `${ROOT}/dist`;
if (!process.env.ITEMS_DATABASE_URL) { console.error("ITEMS_DATABASE_URL 이 필요하다(실 Postgres)"); process.exit(2); }
//  판 안 수집 자식·자식 길 수집이 스키마 체인을 다시 돌지 않게(CI 는 바로 앞 스텝이 적용했다).
process.env.LIVELY_SKIP_SCHEMA_INIT = "1";

const { itemsPool } = await import(`${DIST}/db/client.js`);
const tracker = await import(`${DIST}/connectors/run-tracker.js`);
const { installTenantSlugResolver } = await import(`${DIST}/terminal/catalog.js`);
const { runConnectorSync } = await import(`${DIST}/scheduler/actions/connector.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYS = "local";                         // 수집할 것이 없는 커넥터 — 외부 호출 없이 run-sync 가 성공으로 끝난다
const TAG = "__runjob_pg__";                 // 이 테스트가 만든 행의 started_by — 남의 행과 안 섞인다
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "runjob-pg-"));
const ENTRY = `${DIST}/connectors/job-entry.js`;
//  수집 자식을 60초 붙잡는 선적재 — NODE_OPTIONS 는 공백으로 인자를 가르므로 코드에 공백이 없어야 한다.
const HOLD = "--import=data:text/javascript,await(new(Promise)((r)=>setTimeout(r,60000)))";

async function cleanup() {
  await itemsPool.query(`DELETE FROM connector_run WHERE started_by=$1 OR system LIKE '__runjob_%'`, [TAG]);
}
async function insertRun(o = {}) {
  const r = await itemsPool.query(
    `INSERT INTO connector_run(system, trigger, started_by, status, heartbeat_at, pid)
     VALUES($1,'cron',$2,$3, now() - make_interval(secs => $4), $5) RETURNING id`,
    [o.system ?? SYS, TAG, o.status ?? "running", o.quietSec ?? 0, o.pid ?? null]);
  return Number(r.rows[0].id);
}
async function nextRunId() {
  return Number((await itemsPool.query(`SELECT nextval(pg_get_serial_sequence('connector_run','id')) AS id`)).rows[0].id);
}
const rowOf = async (id) => (await itemsPool.query(
  `SELECT id, status, exit_code, pid, stats, log, log_total, heartbeat_at, finished_at, started_by FROM connector_run WHERE id=$1`, [id])).rows[0];

/** 판 엔트리를 실제 프로세스로. env 문서 = 이 프로세스의 DB 주소 + 스키마 건너뛰기(+ extra). */
function runEntry(args, o = {}) {
  const cred = fs.mkdtempSync(path.join(TMP, "cred-"));
  fs.writeFileSync(path.join(cred, "env"), JSON.stringify({
    ITEMS_DATABASE_URL: process.env.ITEMS_DATABASE_URL, LIVELY_SKIP_SCHEMA_INIT: "1", ...(o.doc ?? {}),
  }));
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  const child = spawn(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, HOME: home, CREDENTIALS_DIRECTORY: cred,
      //  판의 쓰기 자리 대신 임시 폴더 — applyJobEnv 가 /task/work 를 가리키므로 그 자리를 못 만들어도 수집은 돈다(판 밖 시험)
      ...(o.env ?? {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const done = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, out, err })));
  return { child, done };
}

// ── 가짜 op ──────────────────────────────────────────────────────────────────
function fakeOp(handler) {
  const sock = path.join(TMP, `op-${Math.random().toString(16).slice(2, 8)}.sock`);
  const reqs = [];
  const srv = net.createServer({ allowHalfOpen: true }, (c) => {
    const chunks = [];
    c.on("data", (d) => chunks.push(d));
    c.on("end", async () => {
      const all = Buffer.concat(chunks);
      const nl = all.indexOf(0x0a);
      const req = { head: JSON.parse(all.subarray(0, nl).toString("utf8")), body: all.subarray(nl + 1), at: Date.now() };
      reqs.push(req);
      const r = await handler(req);
      c.end(JSON.stringify(r) + "\n");
    });
  });
  return new Promise((resolve) => srv.listen(sock, () => resolve({ sock, reqs, close: () => new Promise((r) => srv.close(() => r())) })));
}
let opReply = async () => ({ ok: true });
const op = await fakeOp((req) => opReply(req));
const opsOf = (kind) => op.reqs.filter((r) => r.head.op === kind);

try {
  await tracker.listConnectorRuns();   // 표 보장(ensureRunSchema)
  await cleanup();

  // ════ E-P 판 안 추적기 — 실제 프로세스 ════════════════════════════════════
  {
    const id = await insertRun({ quietSec: 3600 });
    const before = await rowOf(id);
    const r = await runEntry(["connector-sync", SYS, "--run", String(id)]).done;
    const row = await rowOf(id);
    chk("P-a 행이 running 이면 수집하고 ok·exit 0 을 적는다", r.code === 0 && row.status === "ok" && row.exit_code === 0 && !!row.finished_at,
      JSON.stringify({ code: r.code, err: r.err.slice(-400), row: { ...row, log: row?.log?.slice(-300) } }));
    chk("P-a 박동이 갱신됐다(판 추적기가 자기 행에 찍었다)", row.heartbeat_at > before.heartbeat_at, `${before.heartbeat_at} → ${row.heartbeat_at}`);
    chk("P-a 수집 자식의 출력이 행 로그에 스트리밍되고 요약(stats)이 추출됐다", Number(row.log_total) > 0 && row.stats !== null, JSON.stringify({ log_total: row.log_total, stats: row.stats }));
    chk("P-a 출력 사본이 판 stdout 에도 남는다", r.out.length > 0, `stdout ${r.out.length}B`);
  }
  {
    const id = await nextRunId();
    const p = runEntry(["connector-sync", SYS, "--run", String(id)], { doc: { LIVELY_JOB_ROW_WAIT_MS: "15000" } });
    await sleep(1500);
    await itemsPool.query(`INSERT INTO connector_run(id, system, trigger, started_by) VALUES($1,$2,'cron',$3)`, [id, SYS, TAG]);
    const r = await p.done;
    const row = await rowOf(id);
    chk("P-b 행이 대기 한도 안에 늦게 생기면 기다렸다 수집한다(판 먼저·행 나중)", r.code === 0 && row.status === "ok", JSON.stringify({ code: r.code, err: r.err.slice(-300), status: row.status }));
  }
  {
    const id = await nextRunId();
    const t0 = Date.now();
    const r = await runEntry(["connector-sync", SYS, "--run", String(id)], { doc: { LIVELY_JOB_ROW_WAIT_MS: "1500" } }).done;
    const row = await rowOf(id);
    chk("P-c 행이 끝내 없으면 수집하지 않고 75 로 끝난다(행도 안 만든다)", r.code === 75 && row === undefined && Date.now() - t0 < 10_000,
      JSON.stringify({ code: r.code, row, ms: Date.now() - t0 }));
  }
  {
    const id = await insertRun({ status: "canceled" });
    const before = await rowOf(id);
    const r = await runEntry(["connector-sync", SYS, "--run", String(id)]).done;
    const row = await rowOf(id);
    chk("P-d 행이 이미 끝났으면 수집하지 않고 0 · 행은 그대로", r.code === 0 && row.status === "canceled" && row.log_total === before.log_total && row.exit_code === null,
      JSON.stringify({ code: r.code, row: { status: row.status, log_total: row.log_total } }));
  }
  {
    const id = await insertRun({ system: "runjob-nosuch" });
    const r = await runEntry(["connector-sync", "runjob-nosuch", "--run", String(id)]).done;
    const row = await rowOf(id);
    chk("P-e 수집이 실패하면 error·exit_code≠0 을 적고 판도 ≠0 으로 끝난다", r.code !== 0 && row.status === "error" && row.exit_code !== 0 && row.exit_code !== null && Number(row.log_total) > 0,
      JSON.stringify({ code: r.code, row: { status: row.status, exit_code: row.exit_code, log_total: row.log_total } }));
  }
  {
    //  수집 자식을 60초 붙잡아 둔다(NODE_OPTIONS 는 판 엔트리가 띄우는 **자식**에만 걸린다 — 엔트리는 이미 떴다).
    //   붙잡기가 실제로 걸렸는지 먼저 본다 — 안 걸리면 자식이 즉시 끝나 아래 단언이 헛돈다.
    const hold = { NODE_OPTIONS: HOLD };
    const id = await insertRun();
    const p = runEntry(["connector-sync", SYS, "--run", String(id)], { doc: hold });
    await sleep(2500);
    const held = await rowOf(id);
    chk("P-f 전제: 수집 자식이 붙잡혀 아직 running", held.status === "running" && held.exit_code === null, JSON.stringify({ status: held.status, exit_code: held.exit_code }));
    await itemsPool.query(`UPDATE connector_run SET status='canceled', finished_at=now() WHERE id=$1 AND status='running'`, [id]);
    p.child.kill("SIGTERM");
    const t0 = Date.now();
    const r = await p.done;
    const row = await rowOf(id);
    chk("P-f 수집 중 행이 canceled 로 닫히면(사용자 중지) 판의 끝 기록이 덮지 않는다", row.status === "canceled" && row.exit_code === null,
      JSON.stringify({ code: r.code, row: { status: row.status, exit_code: row.exit_code } }));
    chk("P-f 정지 신호에 수집 자식을 멈추고 곧 끝난다(60초를 기다리지 않는다)", Date.now() - t0 < 15_000 && r.code !== 0, `${Date.now() - t0}ms code=${r.code}`);
  }
  {
    const hold = { NODE_OPTIONS: HOLD };
    const id = await insertRun();
    const p = runEntry(["connector-sync", SYS, "--run", String(id)], { doc: hold });
    await sleep(2500);
    const mid = await rowOf(id);
    chk("P-g 전제: 수집 자식이 붙잡혀 아직 running", mid.status === "running", mid.status);
    p.child.kill("SIGTERM");
    const r = await p.done;
    const row = await rowOf(id);
    chk("P-g 시간 상한·운영 정지(행은 running) → error 로 닫고 정지 사유 줄을 남긴다", row.status === "error" && !!row.finished_at && Number(row.log_total) > Number(mid.log_total),
      JSON.stringify({ code: r.code, row: { status: row.status, log_total: row.log_total }, mid: mid.log_total }));
    chk("P-g 수집 중에도 박동이 찍혔다(부모 없이)", mid.heartbeat_at > (await itemsPool.query(`SELECT started_at FROM connector_run WHERE id=$1`, [id])).rows[0].started_at, "");
  }

  // ════ E-W 게이트웨이 — 가짜 op 앞의 startConnectorRun·감시·취소·입양 ═══════
  process.env.LIVELY_TASK_OP_SOCK = op.sock;
  process.env.LIVELY_CODE_ROOT = "/var/lib/lvly/images/flat-core-pg/rootfs";
  process.env.LIVELY_TASK_DATA_ROOT = path.join(TMP, "tasks");
  installTenantSlugResolver(() => "pgtest");
  //  판 경로는 레지스트리 커넥터여야 선다(모르는 커넥터는 자식 길 — 사양 E-R). 수집할 것이 없는 local 을 쓰고,
  //   같은 범위(system=local)를 공유하므로 사례 사이에 남은 running 행을 닫는다.
  const W = SYS;
  const settle = () => itemsPool.query(`UPDATE connector_run SET status='ok', finished_at=now() WHERE system=$1 AND status='running'`, [SYS]);
  await settle();

  {
    op.reqs.length = 0;
    opReply = async () => ({ ok: true, unit: "u", state: "active" });
    const run = await tracker.startConnectorRun(W, { trigger: "manual", startedBy: TAG });
    const row = await rowOf(run.runId);
    const launch = opsOf("launch")[0];
    chk("W-a 판 경로 — pid 없는 running 행 · 첫 로그 줄에 판 이름", row?.status === "running" && row.pid === null && row.log.startsWith(`[tracker] 판 lvly-task-pgtest-${run.runId}-j1`),
      JSON.stringify({ row: row && { status: row.status, pid: row.pid, log: row.log.slice(0, 120) } }));
    chk("W-a op 에 gateway-job · task_id = 행 id · 코드 자리 · 인자", !!launch && launch.head.profile === "gateway-job" && launch.head.task_id === run.runId
      && launch.head.code_root === process.env.LIVELY_CODE_ROOT
      && JSON.stringify(launch.head.args) === JSON.stringify(["connector-sync", W, "--run", String(run.runId)]),
      JSON.stringify(launch?.head));
    const doc = launch ? JSON.parse(launch.body.toString("utf8")) : {};
    chk("W-a 판 env 문서에 DB 주소가 있고 호스트 자리는 없다", doc.ITEMS_DATABASE_URL === process.env.ITEMS_DATABASE_URL && !("PATH" in doc) && !("HOME" in doc) && !("LIVELY_CODE_ROOT" in doc),
      Object.keys(doc).join(","));
    //  두 번째 시작 — 이미 도는 중
    op.reqs.length = 0;
    const again = await tracker.startConnectorRun(W, { trigger: "cron", startedBy: TAG });
    chk("W-b 이미 도는 수집 → alreadyRunning · op 무호출", again.alreadyRunning === true && again.runId === run.runId && opsOf("launch").length === 0,
      JSON.stringify({ again: { ...again, done: undefined }, launches: opsOf("launch").length }));
    //  판 추적기 흉내 — 행을 ok 로 닫으면 감시가 끝나고 판을 치운다
    await itemsPool.query(`UPDATE connector_run SET status='ok', exit_code=0, finished_at=now() WHERE id=$1`, [run.runId]);
    const d = await Promise.race([run.done, sleep(15_000).then(() => "timeout")]);
    await sleep(300);
    chk("W-a 감시 — 행이 ok 가 되면 ok 로 끝나고 판을 치운다", d !== "timeout" && d.ok === true && opsOf("reap").some((q) => q.head.unit === `lvly-task-pgtest-${run.runId}-j1`),
      JSON.stringify({ d, reaps: opsOf("reap").map((q) => q.head.unit) }));
  }
  {
    const n0 = Number((await itemsPool.query(`SELECT count(*) FROM connector_run`)).rows[0].count);
    opReply = async (req) => (req.head.op === "launch" ? { ok: false, code: "busy", error: "gateway-job 판이 가득 찼다(2/2)" } : { ok: true });
    let err = null;
    await settle();
    try { await tracker.startConnectorRun(SYS, { trigger: "cron", startedBy: TAG }); } catch (e) { err = e; }
    const n1 = Number((await itemsPool.query(`SELECT count(*) FROM connector_run`)).rows[0].count);
    chk("W-c busy → RunCapacityError(503) · 행을 만들지 않는다", err instanceof tracker.RunCapacityError && err.status === 503 && n1 === n0,
      JSON.stringify({ err: String(err), status: err?.status, n0, n1 }));
    //  크론 — 같은 사유를 배압(ok)으로
    const cron = await runConnectorSync({ system: SYS });
    const item = cron.summary.systems[0];
    chk("W-k 크론은 판 자리 없음을 skipped capacity · ok 로 적는다", cron.status === "ok" && item?.ok === true && item?.skipped === "capacity",
      JSON.stringify(cron));
  }
  {
    await settle();
    opReply = async (req) => (req.head.op === "launch" ? { ok: false, code: "bad_code", error: "지금 도는 게이트웨이의 코드 뿌리가 아니다" } : { ok: true });
    const run = await tracker.startConnectorRun(SYS, { trigger: "manual", startedBy: TAG });
    const row = await rowOf(run.runId);
    const d = await Promise.race([run.done, sleep(60_000).then(() => "timeout")]);
    const after = await rowOf(run.runId);
    chk("W-d 판 경로가 안 서면(bad_code) 자식 길 — pid 있는 행 · 사유 줄 · 수집 완주", row.pid !== null && row.log.startsWith("[tracker] 게이트웨이 자식으로 실행 — 판을 세우지 못했다(bad_code")
      && d !== "timeout" && d.ok === true && after.status === "ok",
      JSON.stringify({ pid: row.pid, log: row.log.slice(0, 120), d, status: after.status }));
  }
  {
    await settle();
    op.reqs.length = 0;
    opReply = async (req) => (req.head.op === "launch" ? { ok: false, code: "start_timeout", error: "판이 10000ms 안에 서지 않았다" } : { ok: true });
    const run = await tracker.startConnectorRun(SYS, { trigger: "manual", startedBy: TAG });
    const row = await rowOf(run.runId);
    const d = await run.done;
    const stop = opsOf("stop").find((q) => q.head.unit === `lvly-task-pgtest-${run.runId}-j1`);
    chk("W-e 섰을 수 있는 실패 → 정지 전달 · 실패 행(사유)", row.status === "error" && row.pid === null && row.log.includes("start_timeout") && d.ok === false && !!stop,
      JSON.stringify({ row: { status: row.status, log: row.log.slice(0, 120) }, d, stops: opsOf("stop").map((q) => q.head.unit) }));
    //  섰을 리 없는 실패(spawn_failed)는 정지를 보내지 않는다
    op.reqs.length = 0;
    opReply = async (req) => (req.head.op === "launch" ? { ok: false, code: "spawn_failed", error: "boom" } : { ok: true });
    const run2 = await tracker.startConnectorRun(SYS, { trigger: "manual", startedBy: TAG });
    const row2 = await rowOf(run2.runId);
    chk("W-e2 op 가 거절한 실패 → 실패 행 · 정지 없음", row2.status === "error" && opsOf("stop").length === 0, JSON.stringify({ status: row2.status, stops: opsOf("stop").length }));
  }
  {
    await settle();
    op.reqs.length = 0;
    opReply = async () => ({ ok: true });
    const ghost = await insertRun({ system: SYS, quietSec: 600 });
    const run = await tracker.startConnectorRun(SYS, { trigger: "cron", startedBy: TAG });
    const g = await rowOf(ghost);
    const stops = opsOf("stop").map((q) => q.head.unit);
    const launched = opsOf("launch").map((q) => q.head.task_id);
    chk("W-f 유령(pid 없음·박동 끊김) → error 로 닫고 그 판에 정지를 전한 뒤 새 판", g.status === "error" && stops.includes(`lvly-task-pgtest-${ghost}-j1`)
      && run.runId !== ghost && !run.alreadyRunning && launched.includes(run.runId) && op.reqs.findIndex((q) => q.head.op === "stop") < op.reqs.findIndex((q) => q.head.op === "launch"),
      JSON.stringify({ g: g.status, stops, launched, run: { ...run, done: undefined } }));
    await itemsPool.query(`UPDATE connector_run SET status='ok' WHERE id=$1`, [run.runId]);
  }
  {
    op.reqs.length = 0;
    const seen = [];
    opReply = async (req) => {
      if (req.head.op === "stop") seen.push((await itemsPool.query(`SELECT status FROM connector_run WHERE id=$1`, [Number(String(req.head.unit).split("-").at(-2))])).rows[0]?.status);
      return { ok: true };
    };
    const id = await insertRun({ system: "__runjob_w5" });
    const res = await tracker.cancelConnectorRun(id, "tester");
    const row = await rowOf(id);
    chk("W-g 취소(pid 없음) → 행을 **먼저** canceled 로 닫고 그다음 판 정지", res.ok && row.status === "canceled" && seen.length === 1 && seen[0] === "canceled",
      JSON.stringify({ res, status: row.status, seenAtStop: seen }));
    opReply = async () => ({ ok: false, code: "op_unreachable", error: "ENOENT" });
    const id2 = await insertRun({ system: "__runjob_w5b" });
    const res2 = await tracker.cancelConnectorRun(id2, "tester");
    chk("W-g2 정지를 못 전하면 그렇다고 말한다(행은 canceled)", res2.ok && /정지를 전하지 못했습니다/.test(res2.message) && (await rowOf(id2)).status === "canceled",
      JSON.stringify(res2));
    //  되돌림 스위치를 켠 뒤에도 — 켜기 전에 뜬 판은 취소가 멈춘다. 새 판은 안 띄운다(자식 길).
    op.reqs.length = 0;
    opReply = async () => ({ ok: true });
    process.env.LIVELY_TASK_SANDBOX = "off";
    try {
      const id3 = await insertRun({ system: "__runjob_w5c" });
      const res3 = await tracker.cancelConnectorRun(id3, "tester");
      chk("W-g3 스위치 off 여도 이미 뜬 판의 취소는 판에 정지를 전한다", res3.ok && opsOf("stop").some((q) => q.head.unit === `lvly-task-pgtest-${id3}-j1`),
        JSON.stringify({ res3, stops: opsOf("stop").map((q) => q.head.unit) }));
      await settle();
      const run = await tracker.startConnectorRun(SYS, { trigger: "manual", startedBy: TAG });
      const r = await rowOf(run.runId);
      chk("W-g3 스위치 off 면 새 수집은 판을 안 띄운다(자식 길 · op launch 0)", r.pid !== null && opsOf("launch").length === 0,
        JSON.stringify({ pid: r.pid, launches: opsOf("launch").length }));
      await run.done;
    } finally { delete process.env.LIVELY_TASK_SANDBOX; }
  }
  {
    //  감시 — 박동 끊김 + 판 failed(oom) → 사유를 붙여 닫고 치운다
    op.reqs.length = 0;
    opReply = async (req) => (req.head.op === "status"
      ? { ok: true, load: "loaded", active: "failed", result: "oom-kill", exec_code: "2", exec_status: "9" } : { ok: true });
    const id = await insertRun({ system: "__runjob_w6", quietSec: 600 });
    const d = await Promise.race([tracker.watchRunUnit(id, "pgtest", { everyMs: 200 }), sleep(10_000).then(() => "timeout")]);
    const row = await rowOf(id);
    chk("W-h 감시: 박동 끊김 + 판 죽음 → error(사유) · 치움", d !== "timeout" && d.ok === false && row.status === "error" && row.log.includes("oom-kill")
      && opsOf("reap").some((q) => q.head.unit === `lvly-task-pgtest-${id}-j1`),
      JSON.stringify({ d, status: row.status, log: row.log.slice(-200) }));
    //  감시 — 박동 끊김 + 판 active → 닫지 않는다
    opReply = async (req) => (req.head.op === "status" ? { ok: true, load: "loaded", active: "active", result: "success", exec_code: "0", exec_status: "0" } : { ok: true });
    const id2 = await insertRun({ system: "__runjob_w6b", quietSec: 600 });
    const w = tracker.watchRunUnit(id2, "pgtest", { everyMs: 200 });
    await sleep(1500);
    const mid = await rowOf(id2);
    await itemsPool.query(`UPDATE connector_run SET status='ok', exit_code=0 WHERE id=$1`, [id2]);
    const d2 = await Promise.race([w, sleep(10_000).then(() => "timeout")]);
    chk("W-i 감시: 박동이 끊겨도 판이 살아 있으면 닫지 않는다 · 끝나면 그 결과", mid.status === "running" && d2 !== "timeout" && d2.ok === true,
      JSON.stringify({ mid: mid.status, d2 }));
  }
  {
    //  부팅 입양 — 박동 신선(묻지 않음) · 끊김+판 active(유지) · 끊김+판 없음(닫음)
    op.reqs.length = 0;
    const fresh = await insertRun({ system: "__runjob_w7a", quietSec: 0 });
    const liveStale = await insertRun({ system: "__runjob_w7b", quietSec: 600 });
    const deadStale = await insertRun({ system: "__runjob_w7c", quietSec: 600 });
    opReply = async (req) => {
      if (req.head.op !== "status") return { ok: true };
      return req.head.unit === `lvly-task-pgtest-${liveStale}-j1`
        ? { ok: true, load: "loaded", active: "active", result: "success", exec_code: "0", exec_status: "0" }
        : { ok: true, load: "not-found", active: "inactive", result: "success", exec_code: "0", exec_status: "0" };
    };
    await tracker.recoverOrphanConnectorRuns();
    const [a, b, c] = await Promise.all([rowOf(fresh), rowOf(liveStale), rowOf(deadStale)]);
    const asked = opsOf("status").map((q) => q.head.unit);
    chk("W-j 부팅 입양: 박동 신선 → 유지 · op 에 안 묻는다", a.status === "running" && !asked.includes(`lvly-task-pgtest-${fresh}-j1`), JSON.stringify({ a: a.status, asked }));
    chk("W-j 부팅 입양: 끊김 + 판 active → 유지", b.status === "running", b.status);
    chk("W-j 부팅 입양: 끊김 + 판 없음 → 닫음", c.status === "error" && !!c.finished_at, c.status);
  }
} catch (e) {
  bad("예외", e?.stack ?? String(e));
} finally {
  delete process.env.LIVELY_TASK_OP_SOCK;
  await cleanup().catch(() => {});
  await op.close();
  await itemsPool.end?.().catch?.(() => {});
}

console.log(`\n${pass} passed, ${fail} failed (run-unit PG)`);
process.exit(fail ? 1 : 0);
