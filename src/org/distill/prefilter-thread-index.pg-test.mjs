// 증류 사전필터(prefilterSql)의 스레드 판정과, 그 판정이 source_thread_key_idx 를 탈 수 있는지 — 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 pg-test 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=... node src/org/distill/prefilter-thread-index.pg-test.mjs
//
//  왜 이 계층인가: 유닛(distiller.test.ts F·TK 절)은 SQL 문자열의 모양만 본다. 상관 EXISTS + HAVING 이 실제로 «같은 스레드의
//   활성 자료 집계» 로 판정하는지, 그리고 그 서브쿼리가 인덱스를 탈 수 있는지는 실 DB 로만 보인다.
//   인덱스는 스키마(src/v6/schema/graph-source.ts)에 리터럴로 적혀 있고 서브쿼리는 threadIdSql 로 조립되므로, 둘이 어긋나도
//   타입체커·유닛은 초록이다 — 어긋나면 플래너가 인덱스를 못 쓰고 자료마다 source 전체를 다시 읽어 statement_timeout 이 난다
//   (distiller.ts prefilterSql 주석의 2026-11-07 사고). P3 가 그 일치의 기계 가드다.
//
//  사양 엣지 표(행마다 단언):
//   P1 match=all(메시지 ≥2 AND 키워드 ≥1) — 통과 스레드의 자료만 인박스·잔량에 잡힌다
//      · 같은 ts 라도 채널이 다르면 다른 스레드다(채널 빠진 키면 D 가 A 에 합쳐져 통과한다)
//      · 채널 없는 스레드도 스레드 키로 묶인다(G)
//      · superseded 자료는 스레드 집계에 안 센다(H — 세면 2건이 돼 통과한다)
//   P2 match=any — thread_ts·ts 가 모두 없는 자료는 자기 id 로 1건짜리 스레드다('src:' 폴백, E 통과·F 탈락)
//   P3 계획 — seqscan 을 끄면 인박스·잔량 쿼리 계획에 source_thread_key_idx 가 나온다(표현식·부분조건 일치)
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
// P3 — 작은 테이블이면 플래너가 seqscan 을 고르므로, seqscan 을 꺼서 인덱스를 «쓸 수 있는지»(표현식·부분조건 일치)만 본다.
//  인덱스 이름이 계획에 나오는 것만으로는 부족하다 — 첫 열(채널)만 맞아도 이름은 나오고, 스레드 키는 필터로 밀려 채널 전체를
//  행마다 다시 읽는다. 그래서 그 인덱스 노드의 Index Cond 에 **두 열이 다** 걸렸는지 본다(스레드 열은 'src:' 폴백까지).
const indexConds = (node, out = []) => {
  if (node && typeof node === "object") {
    if (node["Index Name"] === "source_thread_key_idx") out.push(String(node["Index Cond"] ?? ""));
    for (const v of Object.values(node)) if (v && typeof v === "object") indexConds(v, out);
  }
  return out;
};
{
  const c = await itemsPool.connect();
  try {
    for (const [name, qy] of [["인박스", buildInboxQuery(lane(ALL), [], 200, null)], ["잔량", buildBacklogQuery(lane(ALL), [])]]) {
      await c.query("ANALYZE source");   // 통계 없는 플래너 선택에 기대지 않게(CI 환경 차이로 인한 거짓 실패 방지)
      await c.query("BEGIN");
      await c.query("SET LOCAL enable_seqscan = off");
      const plan = (await c.query(`EXPLAIN (FORMAT JSON) ${qy.sql}`, qy.values)).rows[0]["QUERY PLAN"];
      await c.query("ROLLBACK");
      const conds = indexConds(plan);
      assert.ok(conds.some((k) => k.includes("container_name") && k.includes("thread_ts") && k.includes("src:")),
        `P3 ${name} — source_thread_key_idx 를 두 열(채널·스레드 키)로 타는 노드가 없다. 스키마의 인덱스 표현식과 `
        + `prefilterSql·threadIdSql 이 어긋났다(자료마다 source 를 다시 읽는다). 찾은 Index Cond: ${JSON.stringify(conds)}`);
    }
  } finally { c.release(); }
  ok("P3 계획 — 사전필터 서브쿼리가 source_thread_key_idx 를 두 열 다 걸고 탈 수 있다");
}

// ── 정리 ──
await q(`DELETE FROM source WHERE external_system=$1`, [SYS]);
console.log(`\nprefilter-thread-index.pg-test: ${pass} passed`);
await itemsPool.end().catch(() => {});
process.exit(0);
