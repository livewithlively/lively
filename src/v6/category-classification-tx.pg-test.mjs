// 분류 저장의 원자성 — 비활성 전환 · 저장의 분류 조회 · 분류 교체. 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 services:postgres 잡에서(run-tests --pg 가 자동 수집), 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=... node src/v6/category-classification-tx.pg-test.mjs
//
//  왜 이 계층인가: 여기 행은 전부 «두 문장 사이에 다른 트랜잭션이 끼면» · «뒤 문장이 실패하면» 이다. 목으로는 잠금 대기도,
//   자동커밋된 앞 문장이 남는 것도 안 보인다. 스토어 함수를 부르고 DB 를 read-back 한다.
//
//  사양 엣지 표(행마다 단언):
//   D1 경쟁: 다른 트랜잭션이 활성 지식을 이 분류에 넣고 아직 커밋 전일 때 비활성 전환이 시작되고, 그 뒤 커밋된다
//      → 400 · 분류는 active · 매핑이 남는다(검사와 UPDATE 를 따로 돌리면 검사는 0 을 보고 UPDATE 는 기다리지 않는다)
//   D2 경계: 빈 분류의 비활성 전환은 된다
//   U1 새 지식을 비활성 분류로 저장 → 400 · 문구가 «비활성» 과 고를 곳(category_list)을 말한다 · 지식이 생기지 않는다
//   U2 이미 그 비활성 분류에 든 지식을 같은 분류로 다시 저장 → 된다(옮김이 아니다) · 매핑 그대로
//   U3 다른 분류의 지식을 비활성 분류로 옮기는 저장 → 400 · 본문도 매핑도 그대로
//   L1 교체의 INSERT 가 실패하면(없는 분류) → 옛 분류가 남는다(DELETE 만 커밋되면 지식이 미분류가 된다)
//   L2 경쟁: 같은 지식의 교체 둘이 겹친다(앞 교체가 커밋 전) → 뒤 교체가 기다렸다가 이긴다 · 매핑 1행(종전엔 23505)
//   L3 경쟁: 비활성 전환이 커밋 전일 때 그 분류로 교체가 시작되고, 그 뒤 전환이 커밋된다 → 400 · 옛 분류가 남는다
//      (잠그지 않고 state 를 읽으면 전환 전 값을 보고, 매핑 INSERT 의 FK 는 기다렸다가 비활성 분류에 넣는다)
//   L4 직접 연결도 비활성 분류는 400 · 옛 분류가 남는다
//   L5 rejected 매핑은 «이미 든 지식» 이 아니다: rejected 로 걸린 활성 지식이 있는 채 분류가 비활성이 되면(전환 검사는 rejected 를
//      세지 않는다) 그 지식을 같은 분류에 confirmed 로 다시 거는 연결은 400 · 매핑은 rejected 그대로
//   L6 같은 상태에서 rejected 를 rejected 로 다시 거는 연결(무변경 · 되돌리기)은 막지 않는다
//   P1 분류기 제안도 비활성 분류에는 넣지 않는다(비활성 전환 검사는 proposed 도 센다) → applied=false · 매핑 없음
//   M1 관리기 분류 보정(move_category)도 비활성 분류로는 옮기지 않는다 → false · 옛 분류가 남는다
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { updateCategory } = await import(`${DIST}/v6/category-store.js`);
const { upsertKnowledge, linkKnowledgeCategory, proposeKnowledgeCategory } = await import(`${DIST}/v6/knowledge-store.js`);
const { applyAction } = await import(`${DIST}/org/manage/run-manager.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n}. ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
//  지식 이름은 slugify 를 거친다 — 밑줄로 시작하면 다른 이름이 돼 «기존 지식 수정» 행이 신규로 읽힌다.
const TAG = "zz-cat-cls-tx-pg-";

let seq = 0;
const mkCat = async (state = "active") => {
  const key = TAG + "c" + (++seq);
  const id = (await itemsPool.query(
    `INSERT INTO category(key, name, origin, state) VALUES($1, $1, 'human', $2) RETURNING id`, [key, state])).rows[0].id;
  return { id: Number(id), key };
};
const mkKnow = async (lifecycle = "active") => {
  const name = TAG + "k" + (++seq);
  await itemsPool.query(`INSERT INTO knowledge(name, title, body_md, provenance, lifecycle, type) VALUES($1, $1, '본문', 'authored', $2, 'reference')`,
    [name, lifecycle]);
  return name;
};
const map = (name, cid) => itemsPool.query(
  `INSERT INTO knowledge_category(name, category_id, mapped_by, state) VALUES($1, $2, 'manual', 'confirmed')`, [name, cid]);
const mappings = async (name) => (await itemsPool.query(
  `SELECT category_id FROM knowledge_category WHERE name=$1 ORDER BY category_id`, [name])).rows.map((r) => Number(r.category_id));
const catState = async (id) => (await itemsPool.query(`SELECT state FROM category WHERE id=$1`, [id])).rows[0]?.state;
const attempt = async (fn) => {
  try { await fn(); return { threw: false }; }
  catch (e) { return { threw: true, status: e && e.status, code: e && e.code, msg: String((e && e.message) || e) }; }
};
const why = (r) => (r.threw ? `status=${r.status} code=${r.code} msg=${r.msg}` : "안 던졌다");

//  경쟁 재현: 다른 커넥션(tx)이 쓰기를 넣고 커밋 전에 멈춘다 → 대상 호출을 시작한다 → 그 호출이 잠금을 기다리는 것을 보고 커밋한다.
//   잠금 대기가 안 보이면(= 호출이 이미 끝났다) 그대로 커밋한다. 어느 쪽이든 결과로 판정한다(category-delete-guard 와 같은 틀).
const waitingOnLock = async () => (await itemsPool.query(
  `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`)).rows[0].n > 0;
async function race(write, call) {
  const tx = await itemsPool.connect();
  try {
    await tx.query("BEGIN");
    await write(tx);
    let settled = false;
    const p = attempt(call).finally(() => { settled = true; });
    for (let i = 0; i < 100 && !settled && !(await waitingOnLock()); i++) await new Promise((r) => setTimeout(r, 50));
    const blocked = !settled;
    await tx.query("COMMIT");
    return { ...(await p), blocked };
  } catch (e) {
    await tx.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}

async function cleanup() {
  await itemsPool.query(`DELETE FROM org_content_audit WHERE entity IN ('knowledge','category') AND entity_key LIKE $1`, [TAG + "%"]);
  await itemsPool.query(`DELETE FROM knowledge WHERE name LIKE $1`, [TAG + "%"]);
  await itemsPool.query(`DELETE FROM category WHERE key LIKE $1`, [TAG + "%"]);
}

try {
  await cleanup();

  { const c = await mkCat(); const k = await mkKnow();
    const r = await race(
      (tx) => tx.query(`INSERT INTO knowledge_category(name, category_id, mapped_by, state) VALUES($1, $2, 'manual', 'confirmed')`, [k, c.id]),
      () => updateCategory(c.id, { state: "deprecated" }, { actor: TAG, source: "web" }));
    chk("D1 경쟁: 커밋 전 매핑이 전환 도중 커밋되면 → 400", r.threw && r.status === 400 && /비활성으로 바꿀 수 없습니다/.test(r.msg), `${why(r)} 잠금대기=${r.blocked}`);
    const kept = (await mappings(k)).includes(c.id);
    chk("D1 read-back. 분류는 active · 매핑이 남았다", (await catState(c.id)) === "active" && kept, `state=${await catState(c.id)} 매핑=${kept} 잠금대기=${r.blocked}`); }

  { const c = await mkCat();
    const r = await attempt(() => updateCategory(c.id, { state: "deprecated" }, { actor: TAG, source: "web" }));
    chk("D2 경계: 빈 분류는 비활성으로 바뀐다", !r.threw && (await catState(c.id)) === "deprecated", why(r)); }

  { const c = await mkCat("deprecated"); const name = TAG + "k" + (++seq);
    const r = await attempt(() => upsertKnowledge({ name, title: "t", body_md: "본문", type: "reference", category: c.key }, { actor: TAG, source: "mcp" }));
    chk("U1 새 지식을 비활성 분류로 → 400 · 비활성 · category_list", r.threw && r.status === 400 && /비활성/.test(r.msg) && /category_list/.test(r.msg), why(r));
    const made = (await itemsPool.query(`SELECT 1 FROM knowledge WHERE name=$1`, [name])).rowCount;
    chk("U1 read-back. 지식이 생기지 않았다", made === 0, `rows=${made}`); }

  { const c = await mkCat(); const k = await mkKnow("archived"); await map(k, c.id);
    await itemsPool.query(`UPDATE category SET state='deprecated' WHERE id=$1`, [c.id]);
    const r = await attempt(() => upsertKnowledge({ name: k, body_md: "고친 본문", category: c.key }, { actor: TAG, source: "web" }));
    chk("U2 이미 그 비활성 분류에 든 지식을 같은 분류로 다시 저장 → 된다", !r.threw, why(r));
    chk("U2 read-back. 매핑 그대로", JSON.stringify(await mappings(k)) === JSON.stringify([c.id]), JSON.stringify(await mappings(k))); }

  { const a = await mkCat(); const dep = await mkCat("deprecated"); const k = await mkKnow(); await map(k, a.id);
    const r = await attempt(() => upsertKnowledge({ name: k, body_md: "옮기려는 본문", category: dep.key }, { actor: TAG, source: "web" }));
    chk("U3 다른 분류의 지식을 비활성 분류로 옮기는 저장 → 400", r.threw && r.status === 400 && /비활성/.test(r.msg), why(r));
    const body = (await itemsPool.query(`SELECT body_md FROM knowledge WHERE name=$1`, [k])).rows[0]?.body_md;
    chk("U3 read-back. 본문도 매핑도 그대로", body === "본문" && JSON.stringify(await mappings(k)) === JSON.stringify([a.id]), `body=${body} 매핑=${JSON.stringify(await mappings(k))}`); }

  { const a = await mkCat(); const k = await mkKnow(); await map(k, a.id);
    const missing = (await itemsPool.query(`SELECT COALESCE(max(id), 0) + 100000 AS id FROM category`)).rows[0].id;
    const r = await attempt(() => linkKnowledgeCategory(k, Number(missing), "confirmed", { actor: TAG, source: "web" }));
    chk("L1 전제. 없는 분류로의 교체는 404 로 실패한다", r.threw && r.status === 404, why(r));
    chk("L1 read-back. 옛 분류가 남았다(미분류가 되지 않는다)", JSON.stringify(await mappings(k)) === JSON.stringify([a.id]), JSON.stringify(await mappings(k))); }

  { const a = await mkCat(), b = await mkCat(), c = await mkCat(); const k = await mkKnow(); await map(k, a.id);
    const r = await race(
      (tx) => linkKnowledgeCategory(k, b.id, "confirmed", { actor: TAG, source: "web" }, tx),
      () => linkKnowledgeCategory(k, c.id, "confirmed", { actor: TAG, source: "web" }));
    chk("L2 경쟁: 겹친 교체의 뒤쪽이 실패하지 않는다", !r.threw, `${why(r)} 잠금대기=${r.blocked}`);
    chk("L2 read-back. 매핑은 뒤 교체의 분류 1행", JSON.stringify(await mappings(k)) === JSON.stringify([c.id]), `${JSON.stringify(await mappings(k))} 잠금대기=${r.blocked}`); }

  { const a = await mkCat(), c = await mkCat(); const k = await mkKnow(); await map(k, a.id);
    const r = await race(
      async (tx) => { await tx.query(`SELECT id FROM category WHERE id=$1 FOR UPDATE`, [c.id]); await tx.query(`UPDATE category SET state='deprecated' WHERE id=$1`, [c.id]); },
      () => linkKnowledgeCategory(k, c.id, "confirmed", { actor: TAG, source: "web" }));
    chk("L3 경쟁: 커밋 전 비활성 전환과 겹친 교체 → 400", r.threw && r.status === 400 && /비활성/.test(r.msg), `${why(r)} 잠금대기=${r.blocked}`);
    chk("L3 read-back. 옛 분류가 남았다", JSON.stringify(await mappings(k)) === JSON.stringify([a.id]), `${JSON.stringify(await mappings(k))} 잠금대기=${r.blocked}`); }

  { const a = await mkCat(), dep = await mkCat("deprecated"); const k = await mkKnow(); await map(k, a.id);
    const r = await attempt(() => linkKnowledgeCategory(k, dep.id, "confirmed", { actor: TAG, source: "web" }));
    chk("L4 직접 연결도 비활성 분류는 400", r.threw && r.status === 400, why(r));
    chk("L4 read-back. 옛 분류가 남았다", JSON.stringify(await mappings(k)) === JSON.stringify([a.id]), JSON.stringify(await mappings(k))); }

  { const c = await mkCat(); const k = await mkKnow();
    await itemsPool.query(`INSERT INTO knowledge_category(name, category_id, mapped_by, state) VALUES($1, $2, 'manual', 'rejected')`, [k, c.id]);
    const d = await attempt(() => updateCategory(c.id, { state: "deprecated" }, { actor: TAG, source: "web" }));
    chk("L5 전제. rejected 매핑만 있는 분류는 비활성이 된다", !d.threw && (await catState(c.id)) === "deprecated", why(d));
    const r = await attempt(() => linkKnowledgeCategory(k, c.id, "confirmed", { actor: TAG, source: "web" }));
    chk("L5 rejected 매핑을 confirmed 로 다시 거는 연결도 비활성 분류는 400", r.threw && r.status === 400 && /비활성/.test(r.msg), why(r));
    const st = (await itemsPool.query(`SELECT state FROM knowledge_category WHERE name=$1 AND category_id=$2`, [k, c.id])).rows[0]?.state;
    chk("L5 read-back. 매핑은 rejected 그대로", st === "rejected", `state=${st}`); }

  { const c = await mkCat(); const k = await mkKnow();
    await itemsPool.query(`INSERT INTO knowledge_category(name, category_id, mapped_by, state) VALUES($1, $2, 'manual', 'rejected')`, [k, c.id]);
    await itemsPool.query(`UPDATE category SET state='deprecated' WHERE id=$1`, [c.id]);
    const r = await attempt(() => linkKnowledgeCategory(k, c.id, "rejected", { actor: TAG, source: "web" }));
    chk("L6 비활성 분류의 rejected 를 rejected 로 다시 거는 연결 → 된다", !r.threw, why(r));
    const st = (await itemsPool.query(`SELECT state FROM knowledge_category WHERE name=$1 AND category_id=$2`, [k, c.id])).rows[0]?.state;
    chk("L6 read-back. 매핑은 rejected 그대로", st === "rejected", `state=${st}`); }

  { const dep = await mkCat("deprecated"); const k = await mkKnow();
    let res; const r = await attempt(async () => { res = await proposeKnowledgeCategory(k, dep.id, { evidence: "pg-test", confidence: 0.99, state: "confirmed" }, { actor: TAG, source: "mcp" }); });
    chk("P1 비활성 분류로의 분류기 제안 → applied=false", !r.threw && res?.applied === false, r.threw ? why(r) : JSON.stringify(res));
    chk("P1 read-back. 매핑이 생기지 않았다", JSON.stringify(await mappings(k)) === "[]", JSON.stringify(await mappings(k))); }

  { const a = await mkCat(), dep = await mkCat("deprecated"); const k = await mkKnow(); await map(k, a.id);
    const moved = await applyAction({ op: "move_category", name: k, from_category_id: a.id, to_category_id: dep.id }, TAG);
    chk("M1 비활성 분류로의 관리기 분류 보정 → false", moved === false, `applyAction=${moved}`);
    chk("M1 read-back. 옛 분류가 남았다", JSON.stringify(await mappings(k)) === JSON.stringify([a.id]), JSON.stringify(await mappings(k))); }
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}
console.log(`\n분류 저장의 원자성: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
