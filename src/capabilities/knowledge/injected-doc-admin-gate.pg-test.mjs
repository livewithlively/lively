// 세션 주입 문구(injection='always' 행)는 관리자만 바꾼다 (#5801, 상민 2026-11-25). 실제 Postgres 필요(기본 유닛 체인 밖).
//  CI 의 PG 통합 잡이 `run-tests --pg` 로 자동 수집한다. 로컬 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=... node src/capabilities/knowledge/injected-doc-admin-gate.pg-test.mjs
//
//  왜 이 계층인가: 주입 문구의 실체는 지식 행이다. 섹션 저장 op(org_update_section)의 scope 만 admin 으로 올리면
//   지식 표면으로 돌아 들어온다 — knowledge_save 에 주입 문구 이름을 주면 upsert 가 injection 을 보존한 채 본문을 덮는다.
//   «막혔나» 는 scope 표(surface-snapshot)로는 안 보이고, 핸들러를 부른 뒤 DB 를 read-back 해야 보인다.
//
//  사양 엣지 표(행마다 단언) — 구성원 = memory 는 있고 admin 은 없는 사람:
//   G1  구성원 knowledge_save(전문 교체) → 403 · 본문 그대로 · injection='always' 그대로
//   G2  구성원 knowledge_save mode=append → 403 · 본문 그대로
//   G3  구성원 knowledge_save mode=edit → 403 · 본문 그대로
//   G4  구성원이 대소문자만 바꾼 이름으로 knowledge_save → 403 · 본문 그대로(저장 경로가 고칠 이름을 본다)
//   G5  구성원 knowledge_delete(웹) → 403 · 행 남음
//   G6  구성원 knowledge_set_lifecycle(archived) → 403 · lifecycle 그대로(보관하면 주입에서 빠진다)
//   G7  구성원 knowledge_move(sort) → 403 · sort 그대로(sort = 주입 순서)
//   G8  구성원 content_restore(지운 주입 문구) → 403 · 행 없음 그대로(되살리면 다시 주입된다)
//   G9  관리자 knowledge_save → 통과 · 본문 바뀜 · injection='always' 그대로
//   G10 관리자 content_restore → 통과 · 행이 injection='always' 로 돌아옴
//   G11 구성원이 일반 지식을 knowledge_save → 통과 · 본문 바뀜(막는 것은 주입 문구뿐)
//   G12 구성원 org_injection_update{writeback_notice: 새 글} → 403 · 값 그대로
//   G13 구성원 org_injection_update{writeback_notice: 지금 값, hooks} → 통과(화면이 지금 값을 함께 보내는 저장) · 스위치는 바뀜
//   G14 관리자 org_injection_update{writeback_notice: 새 글} → 통과 · 값 바뀜
//  스냅샷을 다시 쓰는 길(지금 행이 아니라 **옛 판**이 주입 문구인 경우 — 격리 리뷰가 찾은 것):
//   G15 지운 주입 문구와 같은 이름으로 만든 일반 지식을, 구성원이 knowledge_revert 로 옛 삭제 기록(지식 축)으로 되돌림 → 403 · injection='recalled' 그대로
//   G16 같은 상황에서 섹션 축 기록(org_section)으로 되돌림 → 403 · injection='recalled' 그대로
//   G17 구성원의 예전 웹 편집 기록이 주입 문구를 가리킬 때 content_undo → 그 기록은 건너뛰고 그다음 옛 작업을 되돌림 · 주입 문구 본문 그대로
//   G18 구성원 content_undo{reapply: 그 기록} → 403 · 본문 그대로
//   G19 구성원 content_purge(지운 주입 문구) → 403 · 삭제 스냅샷 본문 남음
//   G20 구성원이 주입 문구에 댓글 → 통과(댓글은 주입되는 글을 바꾸지 않는다)
import assert from "node:assert/strict";
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { knowledgeSave, knowledgeDelete, knowledgeSetLifecycle, knowledgeMove } = await import(`${DIST}/capabilities/knowledge/authoring.js`);
const { trashCapabilities } = await import(`${DIST}/capabilities/trash.js`);
const { runtimeConfigCapabilities } = await import(`${DIST}/capabilities/delivery/runtime-config.js`);
const { updateSection, deleteSection } = await import(`${DIST}/org/store/sections.js`);
const { knowledgeRevert } = await import(`${DIST}/capabilities/knowledge/history.js`);
const { knowledgeCommentPost } = await import(`${DIST}/capabilities/knowledge/wiki-ui.js`);
const { undoCapabilities } = await import(`${DIST}/capabilities/undo.js`);
const { upsertKnowledge } = await import(`${DIST}/v6/knowledge-store.js`);
const { getRuntimeConfig } = await import(`${DIST}/org/store.js`);

const contentRestore = trashCapabilities.find((c) => c.name === "content_restore");
const injectionUpdate = runtimeConfigCapabilities.find((c) => c.name === "org_injection_update");
const contentPurge = trashCapabilities.find((c) => c.name === "content_purge");
const contentUndo = undoCapabilities.find((c) => c.name === "content_undo");
assert.ok(contentRestore && injectionUpdate && contentPurge && contentUndo && knowledgeCommentPost,
  "content_restore · content_purge · content_undo · org_injection_update · knowledge_comment_post 가 표면에 있어야 한다");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n}. ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const P = "idg-pg-test-";
const SEC = `${P}rules`;          // 주입 문구(살아 있음)
const GONE = `${P}gone`;          // 주입 문구(지워져 휴지통에 있음)
const PLAIN = `${P}plain`;        // 일반 지식
const REUSED = `${P}reused`;      // 주입 문구였다가 지워진 이름 — 구성원이 같은 이름으로 일반 지식을 만든다
const PURGE = `${P}purge`;        // 주입 문구(지워져 휴지통에 있음) — 파기 시도 대상
const MEMBER = { userId: "__idg_pg_test__member", scopes: ["items", "context", "db", "memory", "code"] };
const ADMIN = { userId: "__idg_pg_test__admin", scopes: ["items", "context", "db", "memory", "code", "admin"] };
const ctxOf = (u) => ({ actor: u.userId, source: "web", viewer: u.userId });
const call = async (cap, input, u) => {
  try { await cap.handler(input, u, ctxOf(u)); return { threw: false }; }
  catch (e) { return { threw: true, status: e && e.status, msg: String((e && e.message) || e) }; }
};
const denied = (r) => r.threw && r.status === 403;
const row = async (name) => (await itemsPool.query(
  `SELECT body_md, injection, lifecycle, sort FROM knowledge WHERE name=$1`, [name])).rows[0];

const ORIGINAL = "원래 주입 문구";
let noticeBefore, hooksBefore;
const auditId = async (entity, key, op) => Number((await itemsPool.query(
  `SELECT id FROM org_content_audit WHERE entity=$1 AND entity_key=$2 AND op=$3 ORDER BY id DESC LIMIT 1`, [entity, key, op])).rows[0]?.id);

async function cleanup() {
  await itemsPool.query(`DELETE FROM knowledge WHERE name LIKE $1`, [`${P}%`]);
  await itemsPool.query(`DELETE FROM org_content_audit WHERE entity_key LIKE $1`, [`${P}%`]);
  await itemsPool.query(`DELETE FROM org_content_audit WHERE actor = ANY($1)`, [[MEMBER.userId, ADMIN.userId]]);
}

try {
  await cleanup();
  { const c = await getRuntimeConfig(); noticeBefore = c.writeback_notice ?? null; hooksBefore = c.hooks; }
  await updateSection(SEC, ORIGINAL, ADMIN.userId, "web");
  await updateSection(GONE, ORIGINAL, ADMIN.userId, "web");
  await deleteSection(GONE, ADMIN.userId, "web");
  await itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, provenance, lifecycle) VALUES($1, $1, '일반 본문', 'authored', 'active')`, [PLAIN]);
  assert.equal((await row(SEC)).injection, "always");
  assert.equal(await row(GONE), undefined);

  {
    const r = await call(knowledgeSave, { name: SEC, body_md: "구성원이 덮어쓴 글" }, MEMBER);
    chk("G1 구성원 knowledge_save → 403", denied(r), JSON.stringify(r));
    const k = await row(SEC);
    chk("G1 본문 · injection 그대로", k.body_md === ORIGINAL && k.injection === "always", JSON.stringify(k));
  }
  {
    const r = await call(knowledgeSave, { name: SEC, body_md: "덧붙인 지시", mode: "append" }, MEMBER);
    chk("G2 구성원 append → 403", denied(r), JSON.stringify(r));
    chk("G2 본문 그대로", (await row(SEC)).body_md === ORIGINAL, (await row(SEC)).body_md);
  }
  {
    const r = await call(knowledgeSave, { name: SEC, mode: "edit", edits: [{ old: "원래", new: "바뀐" }] }, MEMBER);
    chk("G3 구성원 edit → 403", denied(r), JSON.stringify(r));
    chk("G3 본문 그대로", (await row(SEC)).body_md === ORIGINAL, (await row(SEC)).body_md);
  }
  {
    const r = await call(knowledgeSave, { name: SEC.toUpperCase(), body_md: "이름을 바꿔 부른 글" }, MEMBER);
    chk("G4 대소문자만 바꾼 이름 → 403", denied(r), JSON.stringify(r));
    chk("G4 본문 그대로", (await row(SEC)).body_md === ORIGINAL, (await row(SEC)).body_md);
  }
  {
    const r = await call(knowledgeDelete, { name: SEC }, MEMBER);
    chk("G5 구성원 knowledge_delete → 403", denied(r), JSON.stringify(r));
    chk("G5 행 남음", !!(await row(SEC)), "행이 사라졌다");
  }
  {
    const r = await call(knowledgeSetLifecycle, { name: SEC, lifecycle: "archived" }, MEMBER);
    chk("G6 구성원 set_lifecycle(archived) → 403", denied(r), JSON.stringify(r));
    chk("G6 lifecycle 그대로", (await row(SEC)).lifecycle === "active", (await row(SEC)).lifecycle);
  }
  {
    const before = (await row(SEC)).sort;
    const r = await call(knowledgeMove, { name: SEC, parent_name: null, sort: Number(before) + 7 }, MEMBER);
    chk("G7 구성원 knowledge_move → 403", denied(r), JSON.stringify(r));
    chk("G7 sort 그대로", String((await row(SEC)).sort) === String(before), String((await row(SEC)).sort));
  }
  {
    const r = await call(contentRestore, { entity: "knowledge", key: GONE }, MEMBER);
    chk("G8 구성원 content_restore(지운 주입 문구) → 403", denied(r), JSON.stringify(r));
    chk("G8 행 없음 그대로", (await row(GONE)) === undefined, JSON.stringify(await row(GONE)));
  }
  {
    const r = await call(knowledgeSave, { name: SEC, body_md: "관리자가 고친 글" }, ADMIN);
    chk("G9 관리자 knowledge_save → 통과", !r.threw, JSON.stringify(r));
    const k = await row(SEC);
    chk("G9 본문 바뀜 · injection 그대로", k.body_md === "관리자가 고친 글" && k.injection === "always", JSON.stringify(k));
  }
  {
    const r = await call(contentRestore, { entity: "knowledge", key: GONE }, ADMIN);
    chk("G10 관리자 content_restore → 통과", !r.threw, JSON.stringify(r));
    const k = await row(GONE);
    chk("G10 injection='always' 로 돌아옴", !!k && k.injection === "always", JSON.stringify(k));
  }
  {
    const r = await call(knowledgeSave, { name: PLAIN, body_md: "구성원이 고친 일반 본문" }, MEMBER);
    chk("G11 구성원이 일반 지식 저장 → 통과", !r.threw, JSON.stringify(r));
    chk("G11 본문 바뀜", (await row(PLAIN)).body_md === "구성원이 고친 일반 본문", (await row(PLAIN)).body_md);
  }
  {
    const cur = (await getRuntimeConfig()).writeback_notice ?? null;
    const r = await call(injectionUpdate, { writeback_notice: "구성원이 쓴 기록 요청 문구" }, MEMBER);
    chk("G12 구성원 writeback_notice 변경 → 403", denied(r), JSON.stringify(r));
    chk("G12 값 그대로", ((await getRuntimeConfig()).writeback_notice ?? null) === cur, String((await getRuntimeConfig()).writeback_notice));
  }
  {
    const c0 = await getRuntimeConfig();
    const flip = c0.hooks?.stop_writeback_gate === false;   // 지금 값의 반대로
    const r = await call(injectionUpdate, { writeback_notice: c0.writeback_notice ?? null, hooks: { stop_writeback_gate: flip } }, MEMBER);
    chk("G13 구성원 — 지금 문구 그대로 + 스위치 → 통과", !r.threw, JSON.stringify(r));
    const c1 = await getRuntimeConfig();
    chk("G13 스위치는 바뀜 · 문구 그대로",
      (c1.hooks?.stop_writeback_gate !== false) === flip && (c1.writeback_notice ?? null) === (c0.writeback_notice ?? null),
      JSON.stringify({ hooks: c1.hooks, notice: c1.writeback_notice }));
    await call(injectionUpdate, { hooks: { stop_writeback_gate: !flip } }, ADMIN);   // 되돌려 둔다
  }
  {
    const r = await call(injectionUpdate, { writeback_notice: "관리자가 쓴 기록 요청 문구" }, ADMIN);
    chk("G14 관리자 writeback_notice 변경 → 통과", !r.threw, JSON.stringify(r));
    chk("G14 값 바뀜", (await getRuntimeConfig()).writeback_notice === "관리자가 쓴 기록 요청 문구", String((await getRuntimeConfig()).writeback_notice));
  }
  // ── 옛 판이 주입 문구인 스냅샷을 다시 쓰는 길 ──
  {
    await updateSection(REUSED, ORIGINAL, ADMIN.userId, "web");
    await deleteSection(REUSED, ADMIN.userId, "web");            // 지식 축 delete(before.injection='always') + 섹션 축 delete 기록이 남는다
    await itemsPool.query(
      `INSERT INTO knowledge(name, title, body_md, provenance, lifecycle) VALUES($1, $1, '구성원의 일반 지식', 'authored', 'active')`, [REUSED]);
    const kDel = await auditId("knowledge", REUSED, "delete");
    const sDel = await auditId("org_section", REUSED, "delete");
    assert.ok(kDel && sDel, "두 축의 삭제 기록이 있어야 시나리오가 선다");
    const r1 = await call(knowledgeRevert, { name: REUSED, audit_id: kDel, to: "before" }, MEMBER);
    chk("G15 구성원 revert(지식 축 옛 주입 문구) → 403", denied(r1), JSON.stringify(r1));
    chk("G15 injection='recalled' 그대로", (await row(REUSED)).injection === "recalled", JSON.stringify(await row(REUSED)));
    const r2 = await call(knowledgeRevert, { name: REUSED, audit_id: sDel, to: "before" }, MEMBER);
    chk("G16 구성원 revert(섹션 축 기록) → 403", denied(r2), JSON.stringify(r2));
    const k = await row(REUSED);
    chk("G16 injection='recalled' · 본문 그대로", k.injection === "recalled" && k.body_md === "구성원의 일반 지식", JSON.stringify(k));
  }
  {
    // 권한을 좁히기 전에 구성원이 웹에서 주입 문구를 고친 기록 — 스토어로 직접 남긴다(지금은 게이트가 막아 핸들러로는 못 만든다).
    const before = (await row(SEC)).body_md;
    await upsertKnowledge({ name: SEC, body_md: "구성원이 예전에 고친 글" }, { actor: MEMBER.userId, source: "web" });
    await upsertKnowledge({ name: SEC, body_md: before }, { actor: ADMIN.userId, source: "web" });   // 관리자가 바로잡아 둔 상태
    const mine = Number((await itemsPool.query(
      `SELECT id FROM org_content_audit WHERE entity='knowledge' AND entity_key=$1 AND actor=$2 AND op='update' ORDER BY id DESC LIMIT 1`,
      [SEC, MEMBER.userId])).rows[0]?.id);
    assert.ok(mine, "구성원의 옛 편집 기록이 있어야 시나리오가 선다");
    //  건너뛴 뒤에는 그다음 옛 작업(위 G11 의 일반 지식 저장)을 되돌린다 — 되돌린 대상이 주입 문구가 아니어야 한다.
    let undone = null;
    try { undone = (await contentUndo.handler({}, MEMBER, ctxOf(MEMBER)))?.undone ?? null; } catch (e) { undone = { error: String(e?.message || e) }; }
    chk("G17 content_undo 가 그 기록을 건너뜀", !!undone && undone.key !== SEC && Number(undone.id) !== mine, JSON.stringify(undone));
    chk("G17 본문 그대로", (await row(SEC)).body_md === before, (await row(SEC)).body_md);
    const r2 = await call(contentUndo, { reapply: mine }, MEMBER);
    chk("G18 구성원 reapply(그 기록) → 403", denied(r2), JSON.stringify(r2));
    chk("G18 본문 그대로", (await row(SEC)).body_md === before, (await row(SEC)).body_md);
  }
  {
    await updateSection(PURGE, ORIGINAL, ADMIN.userId, "web");
    await deleteSection(PURGE, ADMIN.userId, "web");
    const r = await call(contentPurge, { entity: "knowledge", key: PURGE }, MEMBER);
    chk("G19 구성원 content_purge(지운 주입 문구) → 403", denied(r), JSON.stringify(r));
    const snap = (await itemsPool.query(
      `SELECT before->>'body_md' AS body FROM org_content_audit WHERE entity='knowledge' AND entity_key=$1 AND op='delete' ORDER BY id DESC LIMIT 1`, [PURGE])).rows[0];
    chk("G19 삭제 스냅샷 본문 남음", snap?.body === ORIGINAL, JSON.stringify(snap));
  }
  {
    const r = await call(knowledgeCommentPost, { name: SEC, text: "구성원의 댓글", parent_id: null }, MEMBER);
    chk("G20 구성원이 주입 문구에 댓글 → 통과", !r.threw, JSON.stringify(r));
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  if (noticeBefore !== undefined) await call(injectionUpdate, { writeback_notice: noticeBefore }, ADMIN).catch(() => {});
  //  스위치는 시험 전 모양 그대로 되돌린다(키가 없었으면 없는 채로) — org_runtime_config 는 한 행이다.
  if (hooksBefore !== undefined) {
    await itemsPool.query(`UPDATE org_runtime_config SET hooks = $1::jsonb`, [JSON.stringify(hooksBefore ?? {})]).catch(() => {});
  }
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
