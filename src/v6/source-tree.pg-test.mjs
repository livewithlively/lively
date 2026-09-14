// 출처 나무(listSourceTree) 집계의 **의미** PG 통합 테스트 — 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/v6/source-tree.pg-test.mjs
//
//  왜 이 계층인가: 이 쿼리는 2026-09-14 에 **성능 때문에** 상관 서브쿼리(THREAD_KN·FOLD_REPLY)에서
//   사전집계 CTE 로 통째 재작성됐다(전건에 곱해져 수백 초 → itemsPool 고갈 → 게이트웨이 전 API 장애).
//   재작성의 위험은 속도가 아니라 **의미가 조용히 바뀌는 것**이다 — 접기 단위나 linked 롤업이 틀려도
//   화면엔 그냥 다른 숫자가 뜰 뿐 아무도 안 죽는다. 그래서 SQL 을 실 DB 에 태워 행 단위로 못박는다
//   (목으로는 SQL 자체가 검증 대상에서 빠진다).

const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const { listSourceTree } = await import(`${DIST}/v6/source-store.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const SYS = "__srctree_pg_test__";          // 이 테스트만의 external_system — 남의 자료와 절대 안 섞인다
const CH = "__srctree_channel__";
const CH2 = "__srctree_channel2__";
const CH3 = "__srctree_channel3__";
const KN = "__srctree_knowledge__";
const KN2 = "__srctree_knowledge2__";

const mkSource = async (externalId, parentExternalId, opts = {}) => (await itemsPool.query(
  `INSERT INTO source(name, kind, title, external_system, external_id, parent_external_id, fields, lifecycle, occurred_at)
   VALUES($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) RETURNING id`,
  [`${SYS}:${externalId}`, opts.kind ?? "slack", externalId, opts.system === null ? null : SYS,
   opts.system === null ? null : externalId, parentExternalId,
   JSON.stringify(opts.fields ?? (opts.system === null ? {} : { container_name: CH })),
   opts.lifecycle ?? "active", opts.occurredAt ?? new Date().toISOString()])).rows[0].id;

// 지식은 여럿일 수 있다 — 한 대화에 여러 건이 붙어도 linked 가 1 을 넘지 않아야 한다(DISTINCT 가 지키는 성질).
const linkKnowledge = async (sourceId, knowledgeName = KN) =>
  itemsPool.query(`INSERT INTO knowledge_source(name, source_id, relation) VALUES($1,$2,'derived_from')
                   ON CONFLICT DO NOTHING`, [knowledgeName, sourceId]);

async function cleanup() {
  // LIKE 의 '_' 는 와일드카드라 SYS 접두를 그대로 쓰면 패턴이 의도보다 넓어진다 — 접두 일치는 문자열 함수로.
  await itemsPool.query(`DELETE FROM source WHERE left(name, $2) = $1`, [`${SYS}:`, SYS.length + 1]);
  await itemsPool.query(`DELETE FROM knowledge WHERE name IN ($1,$2)`, [KN, KN2]);
}

// 이 테스트가 만든 가지만 집어낸다 — 나무는 조직 전체를 세므로 전역 결과에서 우리 행만 고른다.
const branch = (nodes, container = CH) => nodes.find((x) => x.system === SYS && x.container === container);

try {
  await cleanup();
  for (const k of [KN, KN2])
    await itemsPool.query(
      `INSERT INTO knowledge(name, title, body_md) VALUES($1,'출처나무 테스트 지식','본문')
       ON CONFLICT DO NOTHING`, [k]);

  // ── 케이스 A: 스레드는 대화 1건이다 — 부모 1 + 답글 2 를 넣어도 나무는 1 로 센다(#2423 v3.1 접기). ──
  const rootA = await mkSource("A_root", null);
  await mkSource("A_reply1", "A_root");
  await mkSource("A_reply2", "A_root");

  let tree = await listSourceTree();
  let b = branch(tree);
  chk("A. 부모+답글2 = 대화 1건으로 접힌다", b?.n === 1, `n=${b?.n} (기대 1)`);
  chk("A. 지식이 없으면 linked=0", b?.linked === 0, `linked=${b?.linked}`);

  // ── 케이스 B: 답글에 붙은 지식은 머리 행으로 올라온다(접기가 정보를 잃지 않는다). ──
  const replyId = (await itemsPool.query(
    `SELECT id FROM source WHERE name=$1`, [`${SYS}:A_reply1`])).rows[0].id;
  await linkKnowledge(replyId);

  tree = await listSourceTree();
  b = branch(tree);
  chk("B. 답글의 지식이 루트의 linked 로 롤업된다", b?.linked === 1, `linked=${b?.linked} (기대 1)`);
  chk("B. 롤업이 건수를 부풀리지 않는다", b?.n === 1, `n=${b?.n} (기대 1)`);

  // ── 케이스 C: 루트 자신에 붙은 지식도 센다(THREAD_KN 의 «자신» 갈래). ──
  await itemsPool.query(`DELETE FROM knowledge_source WHERE name=$1`, [KN]);
  await linkKnowledge(rootA);
  tree = await listSourceTree();
  chk("C. 루트 자신의 지식도 linked=1", branch(tree)?.linked === 1, `linked=${branch(tree)?.linked}`);

  // ── 케이스 D: 부모가 수집 안 된 답글은 접지 않는다(fail-open — 접으면 영영 안 보인다). ──
  await mkSource("D_orphan", "D_missing_parent");
  tree = await listSourceTree();
  b = branch(tree);
  chk("D. 부모 미수집 답글은 제 행으로 선다", b?.n === 2, `n=${b?.n} (기대 2 = A루트 + D고아)`);

  // ── 케이스 E: superseded 는 세지 않는다. ──
  await mkSource("E_dead", null, { lifecycle: "superseded" });
  tree = await listSourceTree();
  chk("E. superseded 자료는 나무에 안 잡힌다", branch(tree)?.n === 2, `n=${branch(tree)?.n} (기대 2)`);

  // ── 케이스 F: '적어 둔 것'(external_system NULL)은 kind 가 채널 자리에 온다 — 그 갈래도 가지를 갖는다. ──
  await mkSource("F_authored", null, { system: null, kind: `${SYS}_kind` });
  tree = await listSourceTree();
  const authored = tree.find((x) => x.system === "authored" && x.container === `${SYS}_kind`);
  chk("F. external_system 없는 자료는 kind 를 가지 이름으로 쓴다", authored?.n === 1, `n=${authored?.n} (기대 1)`);

  // ── 케이스 H: 한 대화에 지식이 여럿 붙어도 linked 는 1 이다 ──
  //  이 쿼리에서 건수를 부풀릴 수 있는 유일한 자리가 linked_roots 의 DISTINCT 다. 루트·답글 양쪽에
  //  서로 다른 지식을 붙여 그 DISTINCT 가 실제로 일을 하는지 못박는다(없으면 linked 가 3 으로 샌다).
  await itemsPool.query(`DELETE FROM knowledge_source WHERE name IN ($1,$2)`, [KN, KN2]);
  const a1 = (await itemsPool.query(`SELECT id FROM source WHERE name=$1`, [`${SYS}:A_reply1`])).rows[0].id;
  const a2 = (await itemsPool.query(`SELECT id FROM source WHERE name=$1`, [`${SYS}:A_reply2`])).rows[0].id;
  await linkKnowledge(rootA, KN); await linkKnowledge(a1, KN); await linkKnowledge(a1, KN2); await linkKnowledge(a2, KN2);
  tree = await listSourceTree();
  b = branch(tree);
  chk("H. 지식 여러 건이 한 대화에 붙어도 linked=1", b?.linked === 1, `linked=${b?.linked} (기대 1)`);
  chk("H. 그래도 건수는 안 부풀린다", b?.n === 2, `n=${b?.n} (기대 2)`);

  // ── 케이스 I: 부모가 superseded 면 답글이 제 행으로 승격한다(부모가 '수집돼 있지 않음'과 같은 취급). ──
  await mkSource("I_dead_parent", null, { lifecycle: "superseded", fields: { container_name: CH2 } });
  const iReply = await mkSource("I_reply", "I_dead_parent", { fields: { container_name: CH2 } });
  await linkKnowledge(iReply, KN);
  tree = await listSourceTree();
  const bi = branch(tree, CH2);
  chk("I. superseded 부모의 답글은 루트로 선다", bi?.n === 1, `n=${bi?.n} (기대 1)`);
  chk("I. 그 답글 자신의 지식이 linked 로 잡힌다", bi?.linked === 1, `linked=${bi?.linked} (기대 1)`);

  // ── 케이스 G: newest 는 그 가지의 **최신** 시각이다(존재 여부가 아니라 max 를 검증). ──
  const NEWEST = "2030-06-01T00:00:00.000Z";
  await mkSource("G_new", null, { fields: { container_name: CH3 }, occurredAt: NEWEST });
  await mkSource("G_old", null, { fields: { container_name: CH3 }, occurredAt: "2020-01-01T00:00:00.000Z" });
  tree = await listSourceTree();
  const bg = branch(tree, CH3);
  chk("G. newest 가 그 가지의 최댓값이다",
      bg?.newest && new Date(bg.newest).toISOString() === NEWEST, `newest=${bg?.newest} (기대 ${NEWEST})`);
} catch (e) {
  bad("예외", String(e?.stack ?? e));
} finally {
  await cleanup();
  await itemsPool.end?.();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
