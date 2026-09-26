// 분류 지우기는 비었을 때만(#4233 분류체계 앱 · 격리 리뷰 지적). 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=... node src/v6/category-delete-guard.pg-test.mjs
//
//  왜 이 계층인가: 화면은 «지식과 프로젝트 목록이 없을 때만» 지우기를 연다. 그런데 화면의 수는 **보는 사람의 공개범위로 센 수**라
//   못 보는 지식 · 구성원 전용 목록은 0 으로 보인다. 그래서 약속은 서버가 지켜야 하고, 그 서버 검사는 공개범위와 상관없이 세야 한다.
//   핸들러(category_delete)를 부르고 DB 를 read-back 한다. 목으로는 «정말 안 지웠나» 가 안 보인다.
//
//  사양 엣지 표(행마다 단언):
//   G1 활성 지식 확정 매핑 → 409 · 남음          G2 프로젝트 목록만 → 409 · 남음
//   G3 못 보는 지식(구성원 전용) → 그 뷰어 목록엔 0 인데 409   G3b 못 보는 목록(구성원 전용) → 409
//   G4 보관 지식 매핑 → 409     G5 제안(proposed) 매핑만 → 409
//   G6 경계: rejected 매핑만 → 지워진다(rejected 는 «이 분류가 아니다» 판정)     G7 빈 분류 → 지워진다
//   G8 거절 문구에 수가 없다(못 보는 문서 수가 드러나면 안 된다)     G9 에이전트(mcp)는 여전히 403
//   R1 경쟁: 다른 트랜잭션이 매핑을 넣고 아직 커밋 전일 때 지우기가 시작되고, 그 뒤 커밋된다 → 409 · 분류와 매핑이 남는다
//      (검사와 지우기를 따로 돌리면 검사는 커밋 전이라 0 을 보고, 지우기는 커밋을 기다렸다가 CASCADE 로 그 매핑을 지운다)
//   R2 경쟁: 같은 순서로 프로젝트 목록이 이 분류를 달고 커밋된다 → 409 · 목록의 분류가 남는다(SET NULL 로 조용히 풀리면 안 된다)
import assert from "node:assert/strict";
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { categoryCapabilities } = await import(`${DIST}/capabilities/categories.js`);
const { listCategories } = await import(`${DIST}/v6/category-store.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n}. ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const TAG = "__cat_delete_guard_pg__";
const OUTSIDER = TAG + "outsider";   // 조직 멤버가 아닌 뷰어: 구성원 전용 지식 · 목록을 못 본다
const cap = categoryCapabilities.find((x) => x.name === "category_delete");
assert.ok(cap, "category_delete 가 등록돼야 한다");
const del = (id, source = "web") => cap.handler({ id }, { userId: TAG }, { actor: TAG, source, viewer: OUTSIDER });
const tryDel = async (id, source) => {
  try { await del(id, source); return { threw: false }; }
  catch (e) { return { threw: true, status: e && e.status, msg: String((e && e.message) || e) }; }
};
const exists = async (id) => (await itemsPool.query(`SELECT 1 FROM category WHERE id=$1`, [id])).rowCount === 1;
let seq = 0;
const mkCat = async () => (await itemsPool.query(
  `INSERT INTO category(key, name, origin) VALUES($1, $1, 'human') RETURNING id`, [TAG + "c" + (++seq)])).rows[0].id;
const mkKnow = async (lifecycle = "active", visibility = "open") => {
  const name = TAG + "k" + (++seq);
  await itemsPool.query(`INSERT INTO knowledge(name, title, body_md, provenance, lifecycle, visibility) VALUES($1, $1, '본문', 'authored', $2, $3)`,
    [name, lifecycle, visibility]);
  return name;
};
const map = (name, cid, state = "confirmed") => itemsPool.query(
  `INSERT INTO knowledge_category(name, category_id, mapped_by, state) VALUES($1, $2, 'manual', $3)`, [name, cid, state]);
const mkList = async (cid, visibility = "open") => (await itemsPool.query(
  `INSERT INTO project_list(name, created_by, category_id, visibility) VALUES($1, $2, $3, $4) RETURNING id`, [TAG + "l" + (++seq), TAG, cid, visibility])).rows[0].id;

async function cleanup() {
  await itemsPool.query(`DELETE FROM project_list WHERE created_by=$1`, [TAG]);
  await itemsPool.query(`DELETE FROM knowledge WHERE name LIKE $1`, [TAG + "%"]);
  await itemsPool.query(`DELETE FROM category WHERE key LIKE $1`, [TAG + "%"]);
}

//  경쟁 재현: 다른 커넥션(tx)이 쓰기를 넣고 커밋 전에 멈춘다 → 지우기를 시작한다 → 지우기가 잠금을 기다리는 것을 보고 커밋한다.
//   잠금 대기가 안 보이면(= 지우기가 이미 끝났다) 그대로 커밋한다. 어느 쪽이든 결과로 판정한다.
const waitingOnLock = async () => (await itemsPool.query(
  `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`)).rows[0].n > 0;
async function raceDelete(cid, write) {
  const tx = await itemsPool.connect();
  try {
    await tx.query("BEGIN");
    await write(tx);
    let settled = false;
    const p = tryDel(cid).finally(() => { settled = true; });
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

const refused = (n, r, re) => chk(n, r.threw && r.status === 409 && re.test(r.msg), r.threw ? `status=${r.status} msg=${r.msg}` : "안 던졌다(지워졌다)");
try {
  await cleanup();
  { const c = await mkCat(); await map(await mkKnow(), c);
    refused("G1 활성 지식 확정 매핑 → 409 · 지식", await tryDel(c), /지식/);
    chk("G1 read-back. 분류가 남았다", await exists(c)); }
  { const c = await mkCat(); await mkList(c);
    refused("G2 프로젝트 목록만 → 409 · 프로젝트 목록", await tryDel(c), /프로젝트 목록/);
    chk("G2 read-back. 분류가 남았다", await exists(c)); }
  { const c = await mkCat(); await map(await mkKnow("active", "members"), c);
    const seen = (await listCategories(OUTSIDER)).find((x) => Number(x.id) === Number(c));
    chk("G3 전제. 그 뷰어의 목록에는 지식 0 으로 보인다(화면의 수는 공개범위로 센다)", seen && Number(seen.knowledge_count) === 0, `knowledge_count=${seen && seen.knowledge_count}`);
    refused("G3 못 보는 지식이 붙어 있어도 → 409", await tryDel(c), /지식/);
    chk("G3 read-back. 분류가 남았다", await exists(c)); }
  { const c = await mkCat(); await mkList(c, "members");
    refused("G3b 못 보는 목록(구성원 전용)만 → 409", await tryDel(c), /프로젝트 목록/);
    chk("G3b read-back. 분류가 남았다", await exists(c)); }
  { const c = await mkCat(); await map(await mkKnow("archived"), c);
    refused("G4 보관 지식 매핑 → 409", await tryDel(c), /지식/); }
  { const c = await mkCat(); await map(await mkKnow(), c, "proposed");
    refused("G5 제안(proposed) 매핑만 → 409", await tryDel(c), /지식/); }
  { const c = await mkCat(); const k = await mkKnow(); await map(k, c, "rejected");
    const r = await tryDel(c);
    chk("G6 경계: rejected 매핑만 → 지워진다", !r.threw && !(await exists(c)), r.threw ? `status=${r.status} msg=${r.msg}` : "분류가 남았다"); }
  { const c = await mkCat();
    const r = await tryDel(c);
    chk("G7 빈 분류 → 지워진다", !r.threw && !(await exists(c)), r.threw ? `status=${r.status} msg=${r.msg}` : "분류가 남았다"); }
  { const c = await mkCat(); const k1 = await mkKnow(), k2 = await mkKnow("active", "members");
    await map(k1, c); await map(k2, c); await mkList(c); await mkList(c, "members");
    const r = await tryDel(c);
    refused("G8 둘 다 남으면 둘 다 말한다", r, /지식과 프로젝트 목록/);
    //  따옴표 안은 분류 이름이다(이름의 숫자는 수가 아니다).
    chk("G8 거절 문구에 수가 없다(못 보는 것의 수를 드러내지 않는다)", r.threw && !/\d/.test(r.msg.replace(/'[^']*'/, "")), r.msg); }
  { const c = await mkCat(); const k = await mkKnow();
    const r = await raceDelete(c, (tx) => tx.query(
      `INSERT INTO knowledge_category(name, category_id, mapped_by, state) VALUES($1, $2, 'manual', 'confirmed')`, [k, c]));
    refused("R1 경쟁: 커밋 전 매핑이 지우기 도중 커밋되면 → 409", r, /지식/);
    const kept = (await itemsPool.query(`SELECT 1 FROM knowledge_category WHERE name=$1 AND category_id=$2`, [k, c])).rowCount === 1;
    chk("R1 read-back. 분류와 매핑이 남았다", (await exists(c)) && kept, `분류=${await exists(c)} 매핑=${kept} 잠금대기=${r.blocked}`); }
  { const c = await mkCat(); let lid = 0;
    const r = await raceDelete(c, async (tx) => { lid = (await tx.query(
      `INSERT INTO project_list(name, created_by, category_id) VALUES($1, $2, $3) RETURNING id`, [TAG + "l" + (++seq), TAG, c])).rows[0].id; });
    refused("R2 경쟁: 커밋 전 목록이 지우기 도중 커밋되면 → 409", r, /프로젝트 목록/);
    const cat = (await itemsPool.query(`SELECT category_id FROM project_list WHERE id=$1`, [lid])).rows[0]?.category_id;
    chk("R2 read-back. 목록의 분류가 남았다", (await exists(c)) && Number(cat) === Number(c), `분류=${await exists(c)} 목록 category_id=${cat} 잠금대기=${r.blocked}`); }
  { const c = await mkCat();
    const r = await tryDel(c, "mcp");
    chk("G9 에이전트(mcp)는 여전히 403", r.threw && r.status === 403 && (await exists(c)), r.threw ? `status=${r.status}` : "안 던졌다"); }
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}
console.log(`\n#4233 분류 지우기는 비었을 때만: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
