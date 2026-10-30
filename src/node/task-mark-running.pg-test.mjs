// 위탁 running 기록(markRunning) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/node/task-mark-running.pg-test.mjs
//
// 왜 이 계층인가: 약속이 UPDATE 한 문장의 조건이다 — «queued 행에만 쓴다» · «못 썼으면 false». 목 풀로는 조건을 지워도 초록이다.
//  조건이 없으면 두 게이트웨이가 같은 태스크를 띄웠을 때 늦은 쪽 기록이 첫 판의 좌표를 덮어 그 판이 고아가 되고,
//  spawn 도중 취소된 행이 running 으로 뒤집힌다. 그래서 행을 되읽어 판정한다.
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
if (!process.env.ITEMS_DATABASE_URL) { console.error("ITEMS_DATABASE_URL 이 필요하다(실 Postgres)"); process.exit(2); }
const { itemsPool } = await import(`${DIST}/db/client.js`);
const st = await import(`${DIST}/node/task-store.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const REQ = "__markrunning_pg__";
const row = async (id) => (await itemsPool.query(`SELECT status, node_id, session_id, task_dir, attempt FROM org_task WHERE id=$1`, [id])).rows[0];
const mk = async () => (await st.createTask({ requester: REQ, prompt: "pg-test" })).id;
const cleanup = () => itemsPool.query(`DELETE FROM org_task WHERE requester=$1`, [REQ]);

try {
  await cleanup();

  // M1 — queued 행에는 쓴다.
  const a = await mk();
  const w1 = await st.markRunning(a, "central", "box-first", "/tmp/a");
  const r1 = await row(a);
  chk("M1 queued 행은 running 으로 기록하고 true", w1 === true && r1.status === "running" && r1.session_id === "box-first" && r1.attempt === 1,
    JSON.stringify({ w1, r1 }));

  // M2 — 이미 running 이면 쓰지 않는다(두 번째 게이트웨이의 늦은 기록).
  const w2 = await st.markRunning(a, "node-x", "box-second", "/tmp/b");
  const r2 = await row(a);
  chk("M2 running 행에 늦게 온 기록은 false", w2 === false, String(w2));
  chk("M2 첫 판의 좌표가 그대로다(고아 판이 생기지 않는다)", r2.session_id === "box-first" && r2.node_id === "central" && r2.task_dir === "/tmp/a" && r2.attempt === 1,
    JSON.stringify(r2));

  // M3 — spawn 도중 취소된 행은 running 으로 뒤집히지 않는다.
  const b = await mk();
  await st.markCanceled(b);
  const w3 = await st.markRunning(b, "central", "box-late", "/tmp/c");
  const r3 = await row(b);
  chk("M3 취소된 행은 false 이고 canceled 로 남는다", w3 === false && r3.status === "canceled" && r3.session_id === null, JSON.stringify({ w3, r3 }));

  // M4 — 재큐된 행(노드 이탈 재배정)은 다시 기록된다.
  await st.requeue(a);
  const w4 = await st.markRunning(a, "central", "box-retry", "/tmp/d");
  const r4 = await row(a);
  chk("M4 재큐된 행은 다시 running 으로 기록되고 회차가 오른다", w4 === true && r4.status === "running" && r4.session_id === "box-retry" && r4.attempt === 2,
    JSON.stringify({ w4, r4 }));
} catch (e) {
  bad("예외", String(e && e.stack || e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`task-mark-running.pg-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
