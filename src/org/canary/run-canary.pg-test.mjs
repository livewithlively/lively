// 카나리 실행 경로(runCanary) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/org/canary/run-canary.pg-test.mjs
//
// 왜 이 계층인가: 경보를 낼지는 «직전 상태 → 이번 상태» 전이로 정하고, 직전 상태는 canary_result 를 **어떻게 읽느냐**
//  (configured 행만인가 · 가장 최근 실행인가)로 갈린다. 판정 함수(judge.test)가 순수하게 맞아도 실행 경로가 다른 행을 읽으면
//  고장이다 — 설정을 걷어낸 뒤 매 회전 «복구» 경보가 다시 나간 사고(#1306)가 바로 그 모양이었다. 그래서 실제 행을 쌓으며
//  runCanary 를 돌려 전이를 본다. 상류는 로컬 HTTP 서버(http_direct)로, «설정을 걷어냄» 은 없는 org_tool(http_proxy)로 만든다.
//
//  C1 연속 3회 실패해야 회귀 경보(raise) 한 번 · C2 ★ 그 뒤 설정을 걷어내면 해제(clear)는 첫 회전 한 번뿐
//  C3 설정을 되살려 성공하면 조용하다(해제는 이미 나갔다).
//  ⓘ 되살린 뒤 첫 실패를 걷어내기 전 실패와 이어 셀지는 정책이 정해지지 않아 여기서 단언하지 않는다.
import http from "node:http";

const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { runCanary } = await import(`${DIST}/org/canary/run.js`);

let pass = 0, fail = 0;
const chk = (n, c, why) => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why ?? ""}`); } };

// 이 시험만의 프로브 키 — 같은 DB 를 쓰는 다른 시험·실제 프로브 행과 섞이지 않게.
const KEY = `__pgtest_canary_${process.pid}`;
let status = 500;
const server = http.createServer((req, res) => {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(status === 200 ? "canary-ok" : "upstream down");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/probe`;

const base = { key: KEY, label: "PG 시험 프로브", tier: "plain", args: {}, why: "pg-test", expect: { contains: ["canary-ok"] } };
const upstream = { ...base, adapter: "http_direct", target: { url } };                       // 구성된 상류
const removed = { ...base, adapter: "http_proxy", target: { tool: `${KEY}_missing_tool` } };   // org_tool 없음 → 구성 미비
const turn = async (probe) => (await runCanary({ callerId: "pgtest", probes: [probe] })).probes[0];
const seq = (rows) => rows.map((p) => p.alerted ?? "-").join(",");
const cleanup = () => itemsPool.query("DELETE FROM canary_result WHERE probe_key = $1", [KEY]);

try {
  await cleanup();

  // ── C1 연속 3회 실패해야 회귀 경보 ──
  status = 500;
  const f = [await turn(upstream), await turn(upstream), await turn(upstream)];
  chk("C1 연속 실패 3회째에 회귀 경보(raise) 한 번", seq(f) === "-,-,raise" && f[2].state === "failing",
    JSON.stringify(f.map((p) => [p.configured, p.state, p.alerted])));

  // ── C2 ★ 설정을 걷어내면 해제는 첫 회전 한 번뿐 ──
  const u = [await turn(removed), await turn(removed), await turn(removed)];
  chk("C2 ★ 설정을 걷어낸 뒤 해제(clear)는 첫 회전 한 번뿐 — 회전마다 «복구» 경보가 다시 나가지 않는다",
    u.every((p) => p.configured === false && p.state === "unconfigured") && seq(u) === "clear,-,-",
    JSON.stringify(u.map((p) => [p.configured, p.state, p.alerted])));

  // ── C3 설정을 되살려 성공하면 조용하다 ──
  status = 200;
  const r = await turn(upstream);
  chk("C3 설정을 되살려 성공하면 조용하다(해제는 이미 나갔다)", r.ok && r.state === "ok" && r.alerted === null, JSON.stringify(r));
} finally {
  await cleanup().catch(() => {});
  server.close();
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
