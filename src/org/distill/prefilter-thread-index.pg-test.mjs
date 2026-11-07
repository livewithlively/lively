// 증류 사전필터(prefilterSql)의 스레드 판정과, 그 판정이 앱 역할(RLS)에서 source 를 스레드마다 다시 읽지 않는지 — 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 pg-test 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=... node src/org/distill/prefilter-thread-index.pg-test.mjs
//
//  왜 이 계층인가: 유닛(distiller.test.ts F·TK 절)은 SQL 문자열의 모양만 본다. 스레드 목록과 source 의 조인 + HAVING 이 실제로
//   «같은 스레드의 활성 자료 집계» 로 판정하는지, 그리고 게이트웨이와 같은 조건(행 수준 보안이 걸린 앱 역할)에서 source 를
//   스레드마다 다시 읽지 않는지는 실 DB 로만 보인다.
//
//  사양 엣지 표(행마다 단언):
//   P1 match=all(메시지 ≥2 AND 키워드 ≥1) — 통과 스레드의 자료만 인박스·잔량에 잡힌다
//      · 같은 ts 라도 채널이 다르면 다른 스레드다(채널 빠진 키면 D 가 A 에 합쳐져 통과한다)
//      · 채널 없는 스레드도 스레드 키로 묶인다(G)
//      · superseded 자료는 스레드 집계에 안 센다(H — 세면 2건이 돼 통과한다)
//   P2 match=any — thread_ts·ts 가 모두 없는 자료는 자기 id 로 1건짜리 스레드다('src:' 폴백, E 통과·F 탈락)
//   P3 계획 — RLS 가 걸린 비소유자 역할로 인박스·잔량을 EXPLAIN ANALYZE 하면, 사전필터(source x)가 읽은 행의 합이
//      source 행 수를 넘지 않는다(스레드마다 source 를 다시 읽지 않는다)
import assert from "node:assert/strict";
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
await (await import(`${DIST}/boot/schemas.js`)).initAllSchemas();
const { buildInboxQuery, buildBacklogQuery } = await import(`${DIST}/org/distill/distiller.js`);

let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const q = async (sql, v = []) => (await itemsPool.query(sql, v)).rows;

const SYS = "pfidx-pg-test";             // 이 시험의 자료만 레인 스코프(match_system)에 든다
const CH = "pfidx-ch", CH2 = "pfidx-other";

// 증류기 행 — DB 에 저장하지 않는다. 빌더는 순수 함수라 행 모양만 맞추면 된다(distiller.test.ts 의 mk 와 같은 필드).
const lane = (rules) => ({
  id: 987650, key: "pfidx-lane", label: null, enabled: true, priority: 0,
  match_kinds: null, match_system: SYS,
  include_channels: null, exclude_channels: null, include_authors: null, exclude_authors: null,
  exclude_bots: false, min_chars: 0, lookback_days: null,
  criteria_md: null, format_md: null, target_category: null, default_type: null,
  name_prefix: null, thread_aware: false,
  prefilter_level: 0, prefilter_rules: rules, prompt_sections: null,
  batch_size: 200, batch_max_msgs: 2000, mode: "headless", session_ref: null, harness: null, model: null, effort: null, requester: null,
  last_run_at: null, last_status: null, last_summary: null, note: null, updated_at: null,
});

// ── 준비 ──
await q(`DELETE FROM source WHERE external_system=$1`, [SYS]);
const ids = {};
const add = async (label, fields, body, lifecycle = "active") => {
  const [r] = await q(
    `INSERT INTO source(kind, title, body_md, external_system, fields, lifecycle, occurred_at)
     VALUES ('slack', $1, $2, $3, $4::jsonb, $5, now() - interval '1 hour') RETURNING id`,
    [`pfidx ${label}`, body, SYS, JSON.stringify(fields), lifecycle]);
  (ids[label[0]] ??= []).push(Number(r.id));
};
// A: 3건·키워드 1 → all 통과
await add("A1", { container_name: CH, thread_ts: "pfidx.1", ts: "pfidx.1" }, "이걸로 결정했다");
await add("A2", { container_name: CH, thread_ts: "pfidx.1", ts: "pfidx.1a" }, "좋다");
await add("A3", { container_name: CH, thread_ts: "pfidx.1", ts: "pfidx.1b" }, "확인");
// B: 3건·키워드 없음 → all 탈락, any 통과
for (const k of ["1", "2", "3"]) await add(`B${k}`, { container_name: CH, thread_ts: "pfidx.2", ts: `pfidx.2${k}` }, "잡담");
// C: 1건·키워드 → all 탈락(메시지 수), any 통과
await add("C1", { container_name: CH, ts: "pfidx.3" }, "결정");
// D: A 와 같은 ts, 다른 채널, 1건·키워드 → all 탈락(채널이 키에 들어야 A 와 안 섞인다)
await add("D1", { container_name: CH2, thread_ts: "pfidx.1", ts: "pfidx.1z" }, "결정");
// E: 채널·ts 전부 없음 → 'src:' 폴백 1건 스레드, 키워드 → all 탈락, any 통과
await add("E1", {}, "결정");
// F: 채널 없음·ts 만, 키워드 없음 → 둘 다 탈락
await add("F1", { ts: "pfidx.5" }, "잡담");
// G: 채널 없음·thread_ts 로 2건, 키워드 1 → all 통과
await add("G1", { thread_ts: "pfidx.6", ts: "pfidx.6" }, "결정");
await add("G2", { thread_ts: "pfidx.6", ts: "pfidx.6a" }, "응");
// H: 활성 1건(키워드) + superseded 1건 → all 탈락(superseded 는 안 센다), any 통과
await add("H1", { container_name: CH, thread_ts: "pfidx.7", ts: "pfidx.7" }, "결정");
await add("H2", { container_name: CH, thread_ts: "pfidx.7", ts: "pfidx.7a" }, "옛 판", "superseded");
const activeOf = (labels) => labels.flatMap((l) => (l === "H" ? ids.H.slice(0, 1) : ids[l])).sort((a, b) => a - b);

const ALL = { min_msgs: 2, min_decisive: 1, keywords: ["결정"], match: "all" };
const ANY = { min_msgs: 2, min_decisive: 1, keywords: ["결정"], match: "any" };

const inboxIds = async (rules) => {
  const { sql, values } = buildInboxQuery(lane(rules), [], 200, null);
  return (await q(sql, values)).map((r) => Number(r.id)).sort((a, b) => a - b);
};
const backlog = async (rules, withPrefilter = true) => {
  const { sql, values } = buildBacklogQuery(lane(rules), [], withPrefilter);
  return Number((await q(sql, values))[0].n);
};

// P1
{
  const want = activeOf(["A", "G"]);
  assert.deepEqual(await inboxIds(ALL), want,
    "P1 all — 통과 스레드는 A(채널·3건)와 G(채널 없음·2건)뿐이다. D 가 끼면 채널이 키에서 빠졌고, H 가 끼면 superseded 를 셌다");
  assert.equal(await backlog(ALL), want.length, "P1 잔량이 인박스와 같은 기준이어야 한다");
  assert.equal(await backlog(ALL, false), activeOf(["A", "B", "C", "D", "E", "F", "G", "H"]).length, "P1 필터를 끄면 이 레인의 활성 자료 전부");
  ok("P1 match=all — 스레드 키(채널·스레드)의 활성 자료 집계로 거른다");
}
// P2
{
  const want = activeOf(["A", "B", "C", "D", "E", "G", "H"]);
  assert.deepEqual(await inboxIds(ANY), want, "P2 any — F 만 탈락한다. E 가 빠지면 'src:' 폴백 키가 상관 조건에서 어긋났다");
  assert.equal(await backlog(ANY), want.length, "P2 잔량이 인박스와 같은 기준이어야 한다");
  ok("P2 match=any — thread_ts·ts 없는 자료는 자기 id 로 1건짜리 스레드");
}
// P3 — 사전필터가 source 를 스레드마다 다시 읽지 않는가(2026-11-07 운영 사례: 스레드 195개 × source 전체, 21초).
//  ⚠ **반드시 RLS 가 걸린 비소유자 역할로 잰다 — 소유자·슈퍼유저로 돌리면 못 잡는다.** 슈퍼유저는 RLS 를 건너뛰고, 소유자는
//   owner_all(true) 정책뿐이라 스레드 키 비교가 표현식 인덱스가 있으면 Index Cond 로 들어간다(이 PR 의 이전 커밋이 그렇게 숨었다). 그러면 스레드마다
//   도는 상관 서브쿼리도 스레드 행만 읽어 이 단언을 통과한다. 앱 역할에는 tenant_isolation 이 걸리고, leakproof 가 아닌
//   jsonb `->>` 비교는 보안 조건보다 먼저 평가될 수 없어 인덱스 조건이 못 되므로, 같은 쿼리가 스레드마다 source 전체를 읽는다.
//  역할·정책은 prod(org/tenancy/activate.ts ensureTenantPolicies)와 같은 모양으로 이 트랜잭션 안에서만 만들고 ROLLBACK 한다 —
//   CREATE ROLE·ALTER TABLE·CREATE POLICY 는 트랜잭션에 묶이므로 공유 시험 DB 에 아무것도 남지 않는다. ensureTenantPolicies 를
//   그대로 부르지 않는 까닭: 공유 DB 의 모든 표에 FORCE RLS 를 영구로 남겨 뒤에 도는 시험의 전제를 바꾼다.
//  enable_seqscan=off 는 인덱스 경로를 쓸 수 있으면 쓰게 해, 다시 읽기가 남는 이유를 RLS 하나로 좁힌다(작은 표에서 플래너가
//   seqscan 을 골라 소유자 경로까지 다시 읽는 거짓 실패를 막는다).
//  판정은 «x 스캔 노드들이 실제로 읽은 행(Actual Rows + 필터로 버린 행, × Actual Loops)의 합 ≤ source 전체 행 수» 다. 노드 모양이
//   아니라 읽은 양을 본다 — 작은 데이터에서도 loops·행 수는 결정적이고, 상관 서브쿼리는 스레드 수만큼 곱해져 넘친다.
const P3_ROLE = "pfidx_pg_test_app";
const P3_TABLES = ["source", "knowledge_source", "org_distiller_seen"];   // 증류 쿼리가 읽는, prod 에서 tenant_isolation 이 걸린 표
const STRICT = "current_setting('app.tenant_id')::uuid";                  // activate.ts STRICT_EXPR 와 같은 식
const scansOfX = (node, out = []) => {
  if (Array.isArray(node)) { for (const v of node) scansOfX(v, out); return out; }
  if (node && typeof node === "object") {
    if (node["Relation Name"] === "source" && node.Alias === "x") out.push(node);
    if (node.Plans) scansOfX(node.Plans, out);
    if (node.Plan) scansOfX(node.Plan, out);
  }
  return out;
};
const rowsRead = (n) => (Number(n["Actual Rows"] ?? 0) + Number(n["Rows Removed by Filter"] ?? 0)
  + Number(n["Rows Removed by Index Recheck"] ?? 0)) * Number(n["Actual Loops"] ?? 1);
{
  const [{ total }] = await q(`SELECT count(*)::int AS total FROM source`);
  const [{ tid }] = await q(`SELECT DISTINCT tenant_id::text AS tid FROM source WHERE external_system=$1`, [SYS]);
  const c = await itemsPool.connect();
  try {
    await c.query("ANALYZE source");   // 통계 없는 플래너 선택에 기대지 않게(CI 환경 차이로 인한 거짓 실패 방지)
    for (const [name, qy] of [["인박스", buildInboxQuery(lane(ALL), [], 200, null)], ["잔량", buildBacklogQuery(lane(ALL), [])]]) {
      await c.query("BEGIN");
      try {
        await c.query(`CREATE ROLE ${P3_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
        await c.query(`GRANT USAGE ON SCHEMA public TO ${P3_ROLE}`);
        await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${P3_ROLE}`);
        for (const t of P3_TABLES) {
          await c.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
          await c.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
          await c.query(`CREATE POLICY pfidx_tenant_isolation ON ${t} FOR ALL TO ${P3_ROLE} USING (tenant_id = ${STRICT})`);
        }
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tid]);
        await c.query(`SET LOCAL ROLE ${P3_ROLE}`);
        await c.query("SET LOCAL enable_seqscan = off");
        const plan = (await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${qy.sql}`, qy.values)).rows[0]["QUERY PLAN"];
        const xs = scansOfX(plan);
        const read = xs.reduce((a, n) => a + rowsRead(n), 0);
        const shape = xs.map((n) => ({ type: n["Node Type"], parent: n["Parent Relationship"], loops: n["Actual Loops"], rows: n["Actual Rows"], removed: n["Rows Removed by Filter"] ?? 0 }));
        assert.ok(xs.length > 0, `P3 ${name} — 계획에 사전필터의 source x 스캔이 없다(별칭이 바뀌었나?): ${JSON.stringify(plan).slice(0, 400)}`);
        assert.ok(read <= total,
          `P3 ${name} — 앱 역할(RLS)에서 사전필터가 source 를 ${read}행 읽었다(전체 ${total}행) — 스레드마다 다시 읽는다. `
          + `스레드마다 도는 상관 서브쿼리로 돌아갔는지 prefilterSql 을 보라. x 스캔: ${JSON.stringify(shape)}`);
      } finally { await c.query("ROLLBACK"); }
    }
  } finally { c.release(); }
  ok("P3 계획 — RLS 앱 역할에서 사전필터가 source 를 스레드마다 다시 읽지 않는다");
}

// ── 정리 ──
await q(`DELETE FROM source WHERE external_system=$1`, [SYS]);
console.log(`\nprefilter-thread-index.pg-test: ${pass} passed`);
await itemsPool.end().catch(() => {});
process.exit(0);
