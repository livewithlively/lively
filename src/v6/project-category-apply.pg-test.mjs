// 프로젝트↔카테고리 연결의 **정직성** PG 통합 테스트 — 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/v6/project-category-apply.pg-test.mjs
//
//  왜 이 계층인가: 이 버그는 **반환값이 거짓말한 것**이었다. project_link_category_v6 가 리스트 없는
//   프로젝트에 {linked:true} 를 돌려주고 실제로는 아무것도 안 붙였다(2026-08-28 실측 #3720·#3739).
//   스토어는 applied=false 로 정직했는데 핸들러가 그 값을 버렸다. 그래서 스토어만 검증하면 이 회귀를
//   못 잡는다 — **핸들러를 호출하고 DB 를 read-back** 해야 한다. 목으로는 no-op 여부 자체가 안 보인다.
import assert from "node:assert/strict";

const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const { projectV6Capabilities } = await import(`${DIST}/capabilities/projects-v6.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const cap = (name) => {
  const c = projectV6Capabilities.find((x) => x.name === name);
  assert.ok(c, `capability '${name}' 이 등록돼야 함`);
  return c;
};
// viewer 를 안 넘긴다(=admin 시야) — assertProjectVisible 이 통과하는 조건에서도 가드가 살아 있어야 한다.
const call = (name, input) => cap(name).handler(input, { userId: MID }, { actor: MID, source: "test" });

const MID = "__cat_apply_pg_test__";
const TAG = "__cat_apply_pg_test__";

// 카테고리 실제 반영값 — 프로젝트가 아니라 **소속 리스트**가 소유한다(#541 후속).
const categoryOf = async (projectId) => {
  const r = await itemsPool.query(
    `SELECT pl.category_id FROM project p LEFT JOIN project_list pl ON pl.id=p.list_id WHERE p.id=$1`, [projectId]);
  return r.rows[0]?.category_id ?? null;
};

async function cleanup() {
  await itemsPool.query(`DELETE FROM project WHERE created_by=$1`, [MID]);
  await itemsPool.query(`DELETE FROM project_list WHERE created_by=$1`, [MID]);
  await itemsPool.query(`DELETE FROM category WHERE key IN ($1, $2)`, [TAG, TAG + "_g"]);
}

const status = (e) => e?.status ?? e?.statusCode ?? null;
async function throwsWith(fn, expectStatus, msgRe) {
  try { await fn(); return { threw: false }; }
  catch (e) { return { threw: true, status: status(e), msg: String(e?.message ?? e), okStatus: status(e) === expectStatus, okMsg: !msgRe || msgRe.test(String(e?.message ?? e)) }; }
}

try {
  await cleanup();

  const catId = (await itemsPool.query(
    `INSERT INTO category(key, name, origin) VALUES($1,'카테고리정직성테스트','agent') RETURNING id`, [TAG])).rows[0].id;
  const mkProject = async (listId) => (await itemsPool.query(
    `INSERT INTO project(level, name, status, created_by, list_id) VALUES('project','정직성테스트','active',$1,$2) RETURNING id`,
    [MID, listId ?? null])).rows[0].id;

  // ① 🔴 회귀 락 — 리스트 없는(미분류) 프로젝트: 성공을 가장하지 말고 409 로 끊어야 한다.
  {
    const pid = await mkProject(null);
    const r = await throwsWith(() => call("project_link_category_v6", { id: pid, categoryId: catId }), 409, /리스트/);
    chk("① 미분류 프로젝트 link → 409(조용한 no-op 금지)", r.threw && r.okStatus && r.okMsg,
      r.threw ? `status=${r.status} msg=${r.msg}` : "🔴 안 던졌다 — {linked:true} 를 돌려주던 그 버그다");
    chk("① read-back — 실제로 안 붙었음", (await categoryOf(pid)) === null, "카테고리가 붙어 있다(테스트 전제 붕괴)");
  }

  // ② 리스트 없는 프로젝트에 set_categories(비어있지 않은 입력) — upstream #1631 이 여기서 **자리를
  //    만들어 준다**(그 축의 리스트를 찾거나 새로 만들고 프로젝트를 넣는다). 그래서 이 경로는 409 가
  //    아니라 성공이 옳다. 락의 요점은 status 가 아니라 **응답이 read-back 과 일치하는가** 다 —
  //    성공을 돌려줬으면 카테고리가 실제로 붙어 있어야 한다.
  {
    const pid = await mkProject(null);
    const res = await call("project_set_categories_v6", { id: pid, categoryIds: [catId] });
    chk("② 미분류 프로젝트 set_categories([id]) → 자리를 만들어 반영(#1631)",
      Array.isArray(res.categoryIds) && Number(res.categoryIds[0]) === Number(catId), JSON.stringify(res));
    chk("② read-back — 응답과 DB 가 일치(성공을 가장하지 않았다)",
      Number(await categoryOf(pid)) === Number(catId), `category=${await categoryOf(pid)} expected=${catId}`);
  }

  // ②-b 없는 카테고리 id → 404. #1631 의 자리 만들기는 없는 축에 null 을 돌려주므로, 사유를 안 갈라
  //    두면 «리스트가 없다»는 엉뚱한 409 로 나간다(store 가 리스트 확인보다 먼저 축을 본다).
  {
    const pid = await mkProject(null);
    const r = await throwsWith(() => call("project_set_categories_v6", { id: pid, categoryIds: [987654321] }), 404, /카테고리/);
    chk("②-b 없는 카테고리 set_categories → 404(409 아님)", r.threw && r.okStatus && r.okMsg,
      r.threw ? `status=${r.status} msg=${r.msg}` : "🔴 안 던졌다");
    chk("②-b read-back — 부분 반영도 없음", (await categoryOf(pid)) === null, `category=${await categoryOf(pid)}`);
  }

  // ③ 미분류 프로젝트의 해제(빈 배열 / unlink) — 원하는 상태(카테고리 없음)가 이미 참이라 에러 아님.
  {
    const pid = await mkProject(null);
    const res = await call("project_set_categories_v6", { id: pid, categoryIds: [] });
    chk("③ 미분류 프로젝트 set_categories([]) → 에러 없이 []", Array.isArray(res.categoryIds) && res.categoryIds.length === 0, JSON.stringify(res));
    const u = await call("project_link_category_v6", { id: pid, categoryId: catId, unlink: true });
    chk("③ 미분류 프로젝트 unlink → 에러 없이 unlinked", u.unlinked === true, JSON.stringify(u));
  }

  // ④ 정상 경로 — 리스트에 속하면 붙고, read-back 으로 실제 반영 확인.
  {
    const listId = (await itemsPool.query(
      `INSERT INTO project_list(name, created_by) VALUES('정직성테스트리스트',$1) RETURNING id`, [MID])).rows[0].id;
    const pid = await mkProject(listId);
    const res = await call("project_link_category_v6", { id: pid, categoryId: catId });
    chk("④ 리스트 있는 프로젝트 link → linked:true", res.linked === true, JSON.stringify(res));
    chk("④ read-back — 리스트에 실제로 반영됨", Number(await categoryOf(pid)) === Number(catId), `category=${await categoryOf(pid)} expected=${catId}`);

    // 해제 후에도 read-back 으로 확인(성공 응답만 믿지 않는다).
    const un = await call("project_link_category_v6", { id: pid, categoryId: catId, unlink: true });
    chk("④ unlink → unlinked:true", un.unlinked === true, JSON.stringify(un));
    chk("④ read-back — 실제로 해제됨", (await categoryOf(pid)) === null, `category=${await categoryOf(pid)}`);
  }

  // ⑤ 없는 프로젝트 id — 종전엔 이것도 {linked:true} 였다(리스트 없음과 구분이 안 돼서). 404 로 갈라야 한다.
  {
    // 넣었다 지운 id — 고정 상수는 장수한 로컬 DB 에서 실재할 수 있어 부재가 보장되지 않는다.
    const ghost = await mkProject(null);
    await itemsPool.query(`DELETE FROM project WHERE id=$1`, [ghost]);
    const r = await throwsWith(() => call("project_link_category_v6", { id: ghost, categoryId: catId }), 404, /없음/);
    chk("⑤ 없는 프로젝트 link → 404(409 아님 — 사유를 갈라 알려준다)", r.threw && r.okStatus && r.okMsg,
      r.threw ? `status=${r.status} msg=${r.msg}` : "🔴 안 던졌다");

    // 해제 경로는 '리스트 없음'엔 관대하지만 **없는 id 엔 관대하면 안 된다** — 오타 난 id 가 조용히 성공한다.
    const u = await throwsWith(() => call("project_link_category_v6", { id: ghost, categoryId: catId, unlink: true }), 404, /없음/);
    chk("⑤ 없는 프로젝트 unlink → 404(관대함이 없는 id 까지 덮지 않음)", u.threw && u.okStatus && u.okMsg,
      u.threw ? `status=${u.status} msg=${u.msg}` : "🔴 안 던졌다");
    const e = await throwsWith(() => call("project_set_categories_v6", { id: ghost, categoryIds: [] }), 404, /없음/);
    chk("⑤ 없는 프로젝트 set_categories([]) → 404", e.threw && e.okStatus && e.okMsg,
      e.threw ? `status=${e.status} msg=${e.msg}` : "🔴 안 던졌다");
  }

  // ⑥ 없는 **카테고리** id — 안 막으면 FK 위반이 status 없는 DatabaseError 로 새어 500 + 제약조건 이름이 나간다.
  {
    const listId = (await itemsPool.query(
      `INSERT INTO project_list(name, created_by) VALUES('정직성테스트리스트2',$1) RETURNING id`, [MID])).rows[0].id;
    const pid = await mkProject(listId);
    const ghostCat = (await itemsPool.query(
      `INSERT INTO category(key, name, origin) VALUES($1,'삭제될카테고리','agent') RETURNING id`, [TAG + "_g"])).rows[0].id;
    await itemsPool.query(`DELETE FROM category WHERE id=$1`, [ghostCat]);
    const r = await throwsWith(() => call("project_link_category_v6", { id: pid, categoryId: ghostCat }), 404, new RegExp(`카테고리 #${ghostCat} 없음`));
    chk("⑥ 없는 카테고리 link → 404 + 어느 id 가 틀렸는지 에코(FK 위반 500 누출 아님)", r.threw && r.okStatus && r.okMsg,
      r.threw ? `status=${r.status} msg=${r.msg}` : "🔴 안 던졌다");
    chk("⑥ read-back — 리스트가 오염되지 않음", (await categoryOf(pid)) === null, `category=${await categoryOf(pid)}`);
  }
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
