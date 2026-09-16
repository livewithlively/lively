// 출처 나무(listSourceTree)·접힌 목록/총계(listSources·countSources fold)의 **의미** PG 통합 테스트
//  — 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/v6/source-tree.pg-test.mjs
//
//  왜 이 계층인가: 접기·지식 판정 술어(THREAD_KN·FOLD_REPLY)는 2026-09-14 에 **성능 때문에** 상관 서브쿼리에서
//   anti-join·비상관 IN 모양으로 재작성됐다(전건에 곱해져 수백 초 → itemsPool 고갈 → 게이트웨이 전 API 장애).
//   재작성의 위험은 둘이다:
//   ① **의미가 조용히 바뀌는 것** — 접기 단위나 linked 롤업이 틀려도 화면엔 다른 숫자가 뜰 뿐 아무도 안 죽는다.
//      그래서 SQL 을 실 DB 에 태워 행 단위로 못박는다(목으로는 SQL 자체가 검증 대상에서 빠진다).
//   ② **모양이 조용히 되돌아가는 것** — 되돌려도 결과는 같아서 ①로는 안 잡힌다. 그래서 P 가 실제로 나가는 SQL 의
//      실행 계획에 «행마다 도는(해시가 아닌) SubPlan» 이 없는지 본다.

const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const { listSourceTree, listSources, countSources } = await import(`${DIST}/v6/source-store.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const SYS = "__srctree_pg_test__";          // 이 테스트만의 external_system — 남의 자료와 절대 안 섞인다
const CH = "__srctree_channel__";
const CH2 = "__srctree_channel2__";
const CH3 = "__srctree_channel3__";
const CH4 = "__srctree_channel4__";
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

  // ── 케이스 J: 접힌 목록·총계는 나무와 **같은 정의**로 센다 — 가지를 눌렀을 때의 숫자가 나무와 맞아야 한다. ──
  //  (2026-09-16 리뷰: 나무만 고치고 목록·총계엔 종전 상관 서브쿼리가 남아 있었다 — 6만 건에서 «지식이 된 것»
  //   총계 120초+·기본 목록 총계 14.8초.) 이 시점 CH: A_root(지식) + 답글 둘(지식) + D_orphan(지식 없음) + E_dead.
  const sel = { system: SYS, container: CH, fold: true };
  const [nAll, nLinked, nUnlinked] = await Promise.all([
    countSources(sel), countSources({ ...sel, linked: true }), countSources({ ...sel, linked: false })]);
  b = branch(await listSourceTree());
  chk("J. fold 총계 = 나무 n", nAll === b?.n && nAll === 2, `총계=${nAll} 나무=${b?.n} (기대 2)`);
  chk("J. fold+linked 총계 = 나무 linked", nLinked === b?.linked && nLinked === 1, `총계=${nLinked} 나무=${b?.linked} (기대 1)`);
  chk("J. linked 참+거짓 = 전체(NOT IN 이 행을 삼키지 않는다)", nLinked + nUnlinked === nAll, `${nLinked}+${nUnlinked} vs ${nAll}`);
  const linkedRows = await listSources({ ...sel, linked: true });
  chk("J. fold+linked 목록 = 지식이 붙은 대화 머리 하나(답글은 접힌다)",
      linkedRows.length === 1 && linkedRows[0].id === rootA && linkedRows[0].has_knowledge === true && linkedRows[0].reply_n === 2,
      `rows=${JSON.stringify(linkedRows.map((r) => [r.id, r.has_knowledge, r.reply_n]))} (기대 [[${rootA},true,2]])`);
  const unlinkedRows = await listSources({ ...sel, linked: false });
  chk("J. fold+unlinked 목록 = 지식 없는 머리(부모 미수집 답글) 하나",
      unlinkedRows.length === 1 && unlinkedRows[0].title === "D_orphan" && unlinkedRows[0].has_knowledge === false,
      `rows=${JSON.stringify(unlinkedRows.map((r) => [r.title, r.has_knowledge]))} (기대 [["D_orphan",false]])`);

  // ── 케이스 K: 지식이 **답글에만** 붙은 대화도 목록의 머리 행이 «지식 있음» 으로 선다(민트 점 롤업). ──
  //  목록은 has_knowledge 식을 문자열 치환으로 스레드 판정으로 바꾸므로, 그 배선이 끊기면 여기서만 드러난다.
  const kRoot = await mkSource("K_root", null, { fields: { container_name: CH4 } });
  const kReply = await mkSource("K_reply", "K_root", { fields: { container_name: CH4 } });
  await linkKnowledge(kReply, KN2);
  const kRows = await listSources({ system: SYS, container: CH4, fold: true });
  chk("K. 답글에만 붙은 지식 → 머리 행 has_knowledge=true",
      kRows.length === 1 && kRows[0].id === kRoot && kRows[0].has_knowledge === true,
      `rows=${JSON.stringify(kRows.map((r) => [r.id, r.has_knowledge]))} (기대 [[${kRoot},true]])`);
  chk("K. 그 대화는 «지식이 된 것» 총계에 잡힌다", await countSources({ system: SYS, container: CH4, fold: true, linked: true }) === 1);

  // ── 케이스 P: 모양 가드 — 실제로 나가는 SQL 의 실행 계획에 «행마다 도는 SubPlan» 이 없다. ──
  //  종전 모양(`NOT (x IS NOT NULL AND EXISTS …)` · `EXISTS (… OR ks.source_id IN (상관 …))`)은 결과가 같아서 위 케이스로는
  //  안 잡히고, 계획에만 드러난다(해시가 아닌 SubPlan = 바깥 행마다 다시 실행). 해시 SubPlan·anti/semi join 은 괜찮다.
  //  ⚠ 목록(listSources)은 WHERE 를 총계와 같은 빌더(sourceListFilter)로 만들므로 총계 쪽으로 판정한다 — 목록의
  //   reply_n 은 LIMIT 뒤 페이지 행에만 도는 상관 서브쿼리라 의도적으로 남아 있다(listSources 주석).
  const realQuery = itemsPool.query;
  const captured = [];
  //  자료 조회만 고른다 — 뷰어 술어 판정(visAxes) 같은 곁가지 조회가 캐시 만료로 섞여 들어와도 판정 대상이 흔들리지 않게.
  itemsPool.query = (sqlIn, params) => {
    if (/\bFROM source s\b/.test(String(sqlIn))) captured.push({ sql: String(sqlIn), params });
    return realQuery(sqlIn, params);
  };
  try {
    await listSourceTree();
    await countSources({ fold: true });
    await countSources({ fold: true, linked: true });
    await countSources({ fold: true, linked: false });
  } finally { delete itemsPool.query; }
  chk("P. 가드가 SQL 네 개를 실제로 잡았다", captured.length === 4, `잡힌 수=${captured.length}`);
  for (const [i, { sql, params }] of captured.entries()) {
    //  VERBOSE 라야 집계 FILTER·출력 식이 계획에 찍힌다 — 없으면 «hashed SubPlan» 표기가 안 보여 해시도 행마다로 오판한다.
    const plan = JSON.stringify((await realQuery(`EXPLAIN (FORMAT JSON, VERBOSE) ${sql}`, params)).rows[0]);
    const subplans = [...new Set([...plan.matchAll(/"Subplan Name":\s*"([^"]+)"/g)].map((m) => m[1].replace(/^hashed\s+/, "")))];
    const perRow = subplans.filter((n) => !plan.includes(`hashed ${n}`));
    chk(`P${i + 1}. 행마다 도는 SubPlan 없음 — ${["나무", "총계 fold", "총계 fold+linked", "총계 fold+unlinked"][i]}`,
        perRow.length === 0, `해시가 아닌 SubPlan: ${perRow.join(", ")} — 술어가 상관 서브쿼리 모양으로 되돌아갔다`);
  }
} catch (e) {
  bad("예외", String(e?.stack ?? e));
} finally {
  await cleanup();
  await itemsPool.end?.();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
