// 워크스페이스 간 옮기기(#5458) — 실제 Postgres 위에서 내보내기 → 다른 워크스페이스로 가져오기 → 다시 가져오기 → 되돌리기.
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=... node src/transfer/transfer.pg-test.mjs
//
//  «다른 워크스페이스» 를 한 DB 에서 만드는 법: 묶음의 출처는 워크스페이스 고유 id(org_transfer_identity)다.
//   내보낸 뒤 그 id 를 바꾸고 일부 문서를 지우면, 이 DB 는 «그 문서가 없는 다른 워크스페이스» 가 된다.
//   (코어는 RLS 를 걸지 않으므로 테넌트 GUC 로는 두 워크스페이스를 가를 수 없다 — db/tenant-column.ts 머리말.)
//
//  사양 엣지 표(행마다 단언 — scratchpad spec 표 I):
//   I1 분류 둘 내보내기 → 그 분류 지식 + 위 폴더, 대상자 제한 수가 안내에    I2 같은 워크스페이스로 → 거절
//   I3 미리보기 — new · name_taken(새 이름) · 같은 key 맞춤 · 없는 분류 만들기 · 같은 외부 원본 자료는 이미 있음
//   I4 기본값 적용 — 새 문서 · 겹친 이름은 새 이름으로 · 기존 같은 이름 문서는 그대로
//   I5 본문 [[…]] 와 본문 밖 연결이 새 이름 쪽으로     I6 폴더 아래 문서는 폴더 아래로     I7 대상자 제한 → 공개
//   I8 같은 외부 원본 자료는 새로 만들지 않고 연결만     I9 다시 가져오기 — 바뀐 것 없음 · 여기서 고친 것은 «여기서 고침»
//   I10 되돌리기 — 만든 문서 지움(휴지통 기록) · 만든 빈 분류 지움 · 기존 같은 이름 문서는 그대로
//   I11 잠긴 파일 — 비밀번호 없이 password_required · 맞는 비밀번호면 미리보기     I12 두 번 적용 → 409
//   I13 감사 — export · import_plan · import_apply · import_undo 가 org_transfer 로 남는다
//   I14 덮어쓰기 → 되돌리기 = 원래 본문
//   I15 문서를 쓴 뒤 뒤 단계(가져온 기록)가 실패 → 결과에 «만듦·경고», 되돌리기가 치우고 덮어쓴 문서는 전 판으로(리뷰 반영)
//   I16 대상자 제한 자료 → 내보내기 안내, 받는 쪽에서 공개로(리뷰 반영)
//   I17 «들이는 중» 으로 오래 멈춘 배치 → 정리하면 «일부만 들임», 되돌리기를 받는다(리뷰 반영)
//   I18 받는 쪽에 카테고리 묶음이 있다 → 새 분류가 묶음에 들어가 적용이 성공한다(2026-11-18 GOWIKI 가져오기 실패의 재현)
//       사람이 고른 묶음(화면 → 적용 API 의 categories[].group)이 실제로 쓰인다
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { upsertKnowledge, deleteKnowledge } = await import(`${DIST}/v6/knowledge-store.js`);
const { linkKnowledge } = await import(`${DIST}/v6/knowledge-links.js`);
const { createCategory, getCategoryByKey, deleteCategory } = await import(`${DIST}/v6/category-store.js`);
const { upsertSource } = await import(`${DIST}/v6/source-store.js`);
const { exportBundle } = await import(`${DIST}/transfer/export.js`);
const { stageImport, applyImport, undoImport, transferHousekeeping } = await import(`${DIST}/transfer/apply.js`);
const { getWorkspaceUid } = await import(`${DIST}/transfer/store.js`);
const { PlanError } = await import(`${DIST}/transfer/plan.js`);
const { BundlePasswordRequiredError } = await import(`${DIST}/transfer/bundle.js`);
const { transferCapabilities } = await import(`${DIST}/capabilities/transfer.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n}. ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const T = "xferpg";
const ctx = { actor: `${T}-admin`, source: "web" };
const q1 = async (sql, params = []) => (await itemsPool.query(sql, params)).rows[0];
const exists = async (name) => !!(await q1(`SELECT 1 AS x FROM knowledge WHERE name=$1`, [name]));
const bodyOf = async (name) => (await q1(`SELECT body_md FROM knowledge WHERE name=$1`, [name]))?.body_md;
const setUid = (uid) => itemsPool.query(`UPDATE org_transfer_identity SET workspace_uid=$1 WHERE id=1`, [uid]);

async function cleanup() {
  //  I18 이 심은 묶음 — 남아 있으면 다음 판의 준비 단계(createCategory, 묶음 없이)가 «묶음 하나에 반드시» 로 막힌다.
  await itemsPool.query(`DELETE FROM category_group WHERE origin = '${T}'`).catch(() => {});
  await itemsPool.query(`DROP TRIGGER IF EXISTS ${T}_boom ON org_transfer_origin`).catch(() => {});
  await itemsPool.query(`DROP FUNCTION IF EXISTS ${T}_boom_fn()`).catch(() => {});
  await itemsPool.query(`DELETE FROM knowledge WHERE name LIKE '${T}-%'`);
  await itemsPool.query(`DELETE FROM category WHERE key LIKE '${T}-%'`);
  await itemsPool.query(`DELETE FROM source WHERE external_system = '${T}'`);
  await itemsPool.query(`DELETE FROM org_transfer_origin WHERE origin_ref LIKE '${T}%' OR local_ref LIKE '${T}%'`);
  await itemsPool.query(`DELETE FROM org_transfer_batch WHERE file_name LIKE '${T}%'`);
}

const originalUid = await getWorkspaceUid();
const startedAt = new Date();
await cleanup();
try {
  // ── 보내는 워크스페이스 꾸리기 ─────────────────────────────────────────────
  await createCategory({ key: `${T}-eng`, name: "XFER 엔지니어링", should: "엔지니어링 정의" }, ctx);
  await createCategory({ key: `${T}-ops`, name: "XFER 운영" }, ctx);
  const save = (name, over = {}) => upsertKnowledge({ name, title: `제목 ${name}`, body_md: `본문 ${name}`, type: "reference", category: `${T}-eng`, ...over }, ctx);
  await save(`${T}-b`);
  await save(`${T}-a`, { body_md: `A 는 [[${T}-b]] 를 다듬는다.` });
  await save(`${T}-folder`, { title: "폴더", body_md: "", is_folder: true });
  await save(`${T}-child`, { parent_name: `${T}-folder` });
  await save(`${T}-r`);
  await itemsPool.query(`UPDATE knowledge SET visibility='members' WHERE name=$1`, [`${T}-r`]);
  await save(`${T}-ops1`, { category: `${T}-ops` });
  await linkKnowledge(`${T}-a`, `${T}-b`, "refines", ctx);
  const src = await upsertSource({ kind: "slack", title: "스레드", body_md: "원문", external_system: T, external_instance: "W1", external_id: "ts-1" }, ctx);
  await itemsPool.query(`INSERT INTO knowledge_source(name, source_id, relation) VALUES($1,$2,'cites')`, [`${T}-a`, src.id]);
  const src2 = await upsertSource({ kind: "slack", title: "비공개 스레드", body_md: "제한 원문", external_system: T, external_instance: "W1", external_id: "ts-2" }, ctx);
  await itemsPool.query(`UPDATE source SET visibility='members' WHERE id=$1`, [src2.id]);
  await itemsPool.query(`INSERT INTO knowledge_source(name, source_id, relation) VALUES($1,$2,'cites')`, [`${T}-a`, src2.id]);
  await createCategory({ key: `${T}-x`, name: "XFER 실패 주입" }, ctx);
  await save(`${T}-boom`, { category: `${T}-x` });
  await save(`${T}-ov`, { category: `${T}-x`, body_md: "보낸 쪽 ov 본문" });

  // ── I1 내보내기 ────────────────────────────────────────────────────────
  const out = await exportBundle({ categories: [`${T}-eng`, `${T}-ops`], include_sources: true }, { actor: ctx.actor, source: "web" });
  chk("I1 분류 둘 → 지식 6건(폴더 포함)", out.manifest.counts.knowledge === 6, JSON.stringify(out.manifest.counts));
  chk("I1 자료 2건이 함께 담긴다", out.manifest.counts.sources === 2, JSON.stringify(out.manifest.counts));
  chk("I1 대상자 제한 1건이 안내에 나온다", out.preview.restricted === 1 && out.preview.notes.some((n) => n.includes("지식") && n.includes("공개로")), JSON.stringify(out.preview));
  chk("I16 대상자 제한 자료 1건도 내보내기 안내에 나온다", out.preview.restricted_sources === 1 && out.preview.notes.some((n) => n.includes("자료") && n.includes("공개로")), JSON.stringify(out.preview));
  const outX = await exportBundle({ categories: [`${T}-x`] }, { actor: ctx.actor, source: "web" });

  // ── I2 같은 워크스페이스로 → 거절 ──────────────────────────────────────────
  {
    let threw = null;
    try { await stageImport(out.file, { fileName: `${T}-self.zip`, ctx }); } catch (e) { threw = e; }
    chk("I2 같은 워크스페이스로 가져오기는 거절", threw instanceof PlanError, String(threw));
  }

  // ── 받는 워크스페이스로 바꾸기 — 고유 id 를 바꾸고, 일부 문서를 지우고, 같은 이름의 «다른» 문서를 남긴다 ──
  await setUid(randomUUID());
  for (const n of ["a", "folder", "child", "r", "ops1"]) await deleteKnowledge(`${T}-${n}`, ctx);
  await save(`${T}-b`, { body_md: "받는 쪽에 원래 있던 다른 문서" });
  const opsCat = await getCategoryByKey(`${T}-ops`);
  await deleteCategory(opsCat.id, ctx);
  await itemsPool.query(`DELETE FROM source WHERE external_system=$1 AND external_id='ts-2'`, [T]);

  // ── I3 미리보기 ────────────────────────────────────────────────────────
  const { batch, plan } = await stageImport(out.file, { fileName: `${T}-1.zip`, ctx });
  const st = Object.fromEntries(plan.knowledge.map((k) => [k.ref, k]));
  chk("I3 지운 문서는 new", ["a", "folder", "child", "r", "ops1"].every((n) => st[`${T}-${n}`]?.status === "new"), JSON.stringify(plan.knowledge.map((k) => [k.ref, k.status])));
  chk("I3 같은 이름 다른 문서는 name_taken + 새 이름", st[`${T}-b`]?.status === "name_taken" && st[`${T}-b`]?.new_name === `${T}-b-2`, JSON.stringify(st[`${T}-b`]));
  const cs = Object.fromEntries(plan.categories.map((c) => [c.ref, c.suggestion]));
  chk("I3 같은 key 분류는 맞춤", cs[`${T}-eng`]?.action === "map" && cs[`${T}-eng`]?.to === `${T}-eng`, JSON.stringify(cs));
  chk("I3 없는 분류는 만들기", cs[`${T}-ops`]?.action === "create" && cs[`${T}-ops`]?.key === `${T}-ops`, JSON.stringify(cs));
  chk("I3 같은 외부 원본 자료는 이미 있음 · 없는 자료는 새것", plan.sources.count === 2 && plan.sources.existing === 1 && plan.sources.fresh === 1, JSON.stringify(plan.sources));
  chk("I16 가져오기 미리보기에도 제한 자료 안내", plan.notes.some((n) => n.includes("자료") && n.includes("공개로")), JSON.stringify(plan.notes));

  // ── I4~I8 기본값으로 적용 ───────────────────────────────────────────────
  const applied = await applyImport(batch.id, {}, ctx);
  const c = applied.result.counts;
  chk("I4 새 문서 6건(겹친 이름은 새 이름으로)", c.created === 6 && c.updated === 0 && c.failed === 0, JSON.stringify(c));
  chk("I4 겹친 이름 문서는 b-2 로 들어왔다", await exists(`${T}-b-2`));
  chk("I4 기존 같은 이름 문서는 그대로", (await bodyOf(`${T}-b`)) === "받는 쪽에 원래 있던 다른 문서");
  chk("I4 배치는 applied 이고 파일 바이트를 비웠다", applied.batch.state === "applied"
    && (await q1(`SELECT payload IS NULL AS gone FROM org_transfer_batch WHERE id=$1`, [batch.id])).gone === true);
  chk("I5 본문 [[…]] 가 새 이름으로", (await bodyOf(`${T}-a`))?.includes(`[[${T}-b-2]]`), await bodyOf(`${T}-a`));
  chk("I5 본문 밖 연결(refines)이 새 이름 쪽으로", !!(await q1(`SELECT 1 AS x FROM knowledge_link WHERE from_name=$1 AND to_name=$2 AND relation='refines'`, [`${T}-a`, `${T}-b-2`])));
  chk("I6 폴더 아래 문서는 폴더 아래로", (await q1(`SELECT parent_name FROM knowledge WHERE name=$1`, [`${T}-child`]))?.parent_name === `${T}-folder`);
  chk("I7 대상자 제한 지식은 공개로", (await q1(`SELECT visibility FROM knowledge WHERE name=$1`, [`${T}-r`]))?.visibility === "open");
  chk("I8 같은 원본이 있던 자료는 새로 만들지 않았다(없던 1건만 새로)", Number((await q1(`SELECT count(*) AS n FROM source WHERE external_system=$1`, [T])).n) === 2 && applied.result.sources_created.length === 1, JSON.stringify(applied.result.sources_created));
  chk("I16 제한 자료는 받는 쪽에서 공개로 들어왔다", (await q1(`SELECT visibility FROM source WHERE external_system=$1 AND external_id='ts-2'`, [T]))?.visibility === "open");
  chk("I8 이미 있던 자료에 연결만 했다", !!(await q1(`SELECT 1 AS x FROM knowledge_source WHERE name=$1 AND source_id=$2`, [`${T}-a`, src.id])));
  chk("I4 만든 분류에 들어갔다", (await q1(`SELECT c.key FROM knowledge_category kc JOIN category c ON c.id=kc.category_id WHERE kc.name=$1`, [`${T}-ops1`]))?.key === `${T}-ops`);

  // ── I12 같은 미리보기를 두 번 적용 → 409 ──────────────────────────────────
  {
    let threw = null;
    try { await applyImport(batch.id, {}, ctx); } catch (e) { threw = e; }
    chk("I12 두 번째 적용은 409", threw && threw.status === 409, String(threw && threw.message));
  }

  // ── I9 다시 가져오기 ────────────────────────────────────────────────────
  {
    const again = await stageImport(out.file, { fileName: `${T}-2.zip`, ctx });
    chk("I9 바꾼 것 없으면 전부 «바뀐 것 없음»", again.plan.knowledge.every((k) => k.status === "reimport_unchanged"), JSON.stringify(again.plan.knowledge.map((k) => [k.ref, k.status])));
    await upsertKnowledge({ name: `${T}-a`, body_md: "여기서 고친 본문" }, ctx);
    const third = await stageImport(out.file, { fileName: `${T}-3.zip`, ctx });
    const a3 = third.plan.knowledge.find((k) => k.ref === `${T}-a`);
    chk("I9 여기서 고친 문서는 «여기서 고침» · 기본 건너뛰기", a3?.status === "reimport_local_changed" && a3?.action === "skip", JSON.stringify(a3));
  }

  // ── I10 되돌리기 ───────────────────────────────────────────────────────
  {
    const { report } = await undoImport(batch.id, ctx);
    chk("I10 만든 문서 6건이 지워졌다", report.deleted === 6 && !(await exists(`${T}-a`)) && !(await exists(`${T}-b-2`)), JSON.stringify(report));
    chk("I10 휴지통 기록(감사 delete)이 남았다", !!(await q1(`SELECT 1 AS x FROM org_content_audit WHERE entity='knowledge' AND entity_key=$1 AND op='delete' AND at >= $2`, [`${T}-b-2`, startedAt])));
    chk("I10 만든 빈 분류는 지워졌다", report.categories_deleted === 1 && !(await getCategoryByKey(`${T}-ops`)), JSON.stringify(report));
    chk("I10 기존 같은 이름 문서는 그대로", (await bodyOf(`${T}-b`)) === "받는 쪽에 원래 있던 다른 문서");
    chk("I10 가져온 기록도 걷혔다", Number((await q1(`SELECT count(*) AS n FROM org_transfer_origin WHERE kind='knowledge' AND local_ref LIKE '${T}-%'`)).n) === 0);
  }

  // ── I14 덮어쓰기 → 되돌리기 = 원래 본문 ──────────────────────────────────
  {
    const st2 = await stageImport(out.file, { fileName: `${T}-4.zip`, ctx });
    const b2 = st2.plan.knowledge.find((k) => k.ref === `${T}-b`);
    chk("I14 되돌린 뒤 같은 이름 문서는 다시 name_taken", b2?.status === "name_taken" && b2?.actions.includes("overwrite"), JSON.stringify(b2));
    const ap2 = await applyImport(st2.batch.id, { knowledge: { [`${T}-b`]: "overwrite" } }, ctx);
    chk("I14 덮어쓰기로 고르면 받는 쪽 문서 본문이 묶음 본문이 된다", (await bodyOf(`${T}-b`)) === `본문 ${T}-b` && ap2.result.counts.updated === 1, `${await bodyOf(`${T}-b`)} ${JSON.stringify(ap2.result.counts)}`);
    const un2 = await undoImport(st2.batch.id, ctx);
    chk("I14 되돌리면 덮어쓴 문서가 가져오기 전 본문으로 돌아온다", (await bodyOf(`${T}-b`)) === "받는 쪽에 원래 있던 다른 문서" && un2.report.restored === 1, `${await bodyOf(`${T}-b`)} ${JSON.stringify(un2.report)}`);
  }

  // ── I15 쓴 뒤 실패 → 결과가 남고 되돌리기가 치운다 ─────────────────────────
  {
    await deleteKnowledge(`${T}-boom`, ctx);                                  // 받는 쪽엔 없다 → 새로 만들기
    await save(`${T}-ov`, { category: `${T}-x`, body_md: "받는 쪽 ov 본문" });  // 같은 이름 다른 문서 → 덮어쓰기로 고른다
    await itemsPool.query(`CREATE OR REPLACE FUNCTION ${T}_boom_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind = 'knowledge' AND NEW.origin_ref IN ('${T}-boom', '${T}-ov') THEN RAISE EXCEPTION '${T} 주입 실패'; END IF; RETURN NEW; END $$`);
    await itemsPool.query(`CREATE TRIGGER ${T}_boom BEFORE INSERT OR UPDATE ON org_transfer_origin FOR EACH ROW EXECUTE FUNCTION ${T}_boom_fn()`);
    const stX = await stageImport(outX.file, { fileName: `${T}-x.zip`, ctx });
    const apX = await applyImport(stX.batch.id, { knowledge: { [`${T}-ov`]: "overwrite" } }, ctx);
    await itemsPool.query(`DROP TRIGGER IF EXISTS ${T}_boom ON org_transfer_origin`);
    const boom = apX.result.knowledge.find((r) => r.ref === `${T}-boom`);
    const ov = apX.result.knowledge.find((r) => r.ref === `${T}-ov`);
    chk("I15 쓴 뒤 기록이 실패해도 «만듦·경고» 로 남는다", boom?.ok === true && boom?.created === true && boom?.warning === true && (await exists(`${T}-boom`)), JSON.stringify(boom));
    chk("I15 덮어쓴 문서는 전 판이 결과에 남는다", ov?.ok === true && ov?.created === false && ov?.warning === true && ov?.before?.body_md === "받는 쪽 ov 본문", JSON.stringify(ov && { ...ov, before: ov.before && { body_md: ov.before.body_md } }));
    chk("I15 실패 수가 아니라 만듦·갱신으로 센다", apX.result.counts.created === 1 && apX.result.counts.updated === 1 && apX.result.counts.failed === 0, JSON.stringify(apX.result.counts));
    const unX = await undoImport(stX.batch.id, ctx);
    chk("I15 되돌리기가 그 문서를 치운다", !(await exists(`${T}-boom`)) && unX.report.deleted === 1, JSON.stringify(unX.report));
    chk("I15 되돌리기가 덮어쓴 문서를 전 판으로 돌린다", (await bodyOf(`${T}-ov`)) === "받는 쪽 ov 본문" && unX.report.restored === 1, await bodyOf(`${T}-ov`));
  }

  // ── I17 멈춘 배치 정리 ────────────────────────────────────────────────
  {
    const stS = await stageImport(outX.file, { fileName: `${T}-stuck.zip`, ctx });
    await itemsPool.query(`UPDATE org_transfer_batch SET state='applying', state_at = now() - interval '2 hours' WHERE id=$1`, [stS.batch.id]);
    await transferHousekeeping();
    const row = await q1(`SELECT state, payload IS NULL AS gone, error FROM org_transfer_batch WHERE id=$1`, [stS.batch.id]);
    chk("I17 오래 멈춘 «들이는 중» 은 «일부만 들임» 으로 내려간다", row?.state === "partial" && row?.gone === true && /멈췄습니다/.test(row?.error ?? ""), JSON.stringify(row));
    const unS = await undoImport(stS.batch.id, ctx);
    chk("I17 내려간 배치는 되돌리기를 받는다", unS.batch.state === "undone", JSON.stringify(unS.batch.state));
    const fresh = await stageImport(outX.file, { fileName: `${T}-fresh.zip`, ctx });
    await itemsPool.query(`UPDATE org_transfer_batch SET state='applying', state_at = now() WHERE id=$1`, [fresh.batch.id]);
    await transferHousekeeping();
    chk("I17 방금 시작한 «들이는 중» 은 건드리지 않는다", (await q1(`SELECT state FROM org_transfer_batch WHERE id=$1`, [fresh.batch.id]))?.state === "applying");
    await itemsPool.query(`UPDATE org_transfer_batch SET state='failed' WHERE id=$1`, [fresh.batch.id]);
  }

  // ── I11 잠긴 파일 ──────────────────────────────────────────────────────
  {
    await setUid(originalUid);
    const sealed = await exportBundle({ categories: [`${T}-eng`] }, { actor: ctx.actor, source: "web", password: "xfer-비밀번호-1" });
    await setUid(randomUUID());
    let threw = null;
    try { await stageImport(sealed.file, { fileName: `${T}-sealed.lively`, ctx }); } catch (e) { threw = e; }
    chk("I11 비밀번호 없이 → password_required", threw instanceof BundlePasswordRequiredError && threw.code === "password_required", String(threw));
    const okSealed = await stageImport(sealed.file, { fileName: `${T}-sealed.lively`, password: "xfer-비밀번호-1", ctx });
    chk("I11 맞는 비밀번호 → 미리보기", okSealed.batch.sealed === true && okSealed.plan.knowledge.length > 0, JSON.stringify(okSealed.plan.summary));
  }

  // ── I13 감사 ──────────────────────────────────────────────────────────
  {
    const ops = (await itemsPool.query(`SELECT DISTINCT op FROM org_content_audit WHERE entity='org_transfer' AND at >= $1`, [startedAt])).rows.map((r) => r.op);
    chk("I13 export · import_plan · import_apply · import_undo 감사", ["export", "import_plan", "import_apply", "import_undo"].every((o) => ops.includes(o)), JSON.stringify(ops));
  }
  // ── I18 묶음이 있는 워크스페이스로 들이기 ─────────────────────────────────
  //  2026-11-18 실측: 묶음(g1·g2·g3)이 있는 워크스페이스에 들이다 «카테고리는 묶음 하나에 반드시 들어갑니다» 로 첫 단계에서 실패했다.
  //  ⚠ 맨 끝에 둔다 — 묶음이 생기면 이 뒤의 «묶음 없이 분류 만들기» 가 막힌다(정리에서 지운다).
  {
    await setUid(originalUid);
    await createCategory({ key: `${T}-cs`, name: "XFER 고객 응대" }, ctx);
    await upsertKnowledge({ name: `${T}-cs1`, title: "응대 문서", body_md: "응대 본문", type: "reference", category: `${T}-cs` }, ctx);
    const outG = await exportBundle({ categories: [`${T}-cs`] }, { actor: ctx.actor, source: "web" });
    // 받는 쪽: 그 분류·문서가 없고 묶음이 있다
    await setUid(randomUUID());
    await deleteKnowledge(`${T}-cs1`, ctx);
    await deleteCategory((await getCategoryByKey(`${T}-cs`)).id, ctx);
    const had = Number((await q1(`SELECT count(*)::int AS n FROM category_group WHERE state='active'`)).n);
    if (!had) {
      for (const [key, name, sort] of [["g1", "XFER 사업", 1], ["g2", "XFER 제품", 2], ["g3", "XFER 시스템", 3]]) {
        await itemsPool.query(`INSERT INTO category_group(key, name, sort, state, origin) VALUES($1,$2,$3,'active',$4)`, [key, name, sort, T]);
      }
    }
    const activeKeys = (await itemsPool.query(`SELECT key FROM category_group WHERE state='active' ORDER BY sort, key`)).rows.map((r) => r.key);
    const stG = await stageImport(outG.file, { fileName: `${T}-groups.zip`, ctx });
    const pc = stG.plan.categories.find((c) => c.ref === `${T}-cs`);
    chk("I18 미리보기에 새 분류의 묶음 기본값과 받는 쪽 묶음 목록이 있다",
      pc?.suggestion.action === "create" && activeKeys.includes(pc.group) && (stG.plan.groups ?? []).length === activeKeys.length, JSON.stringify({ pc, groups: stG.plan.groups }));
    let apG = null, errG = null;
    try { apG = await applyImport(stG.batch.id, {}, ctx); } catch (e) { errG = e; }
    chk("I18 묶음이 있어도 적용이 성공한다", !errG && apG?.batch.state === "applied" && apG.result.counts.created === 1,
      errG ? String(errG.message ?? errG) : JSON.stringify({ state: apG?.batch.state, counts: apG?.result.counts }));
    const newKey = apG?.result.categories_created?.[0]?.key;
    const row = newKey ? await q1(`SELECT group_key FROM category WHERE key=$1`, [newKey]) : null;
    chk("I18 새 분류가 묶음에 들어갔다(규약: «고객·응대» → g2)", !!row && activeKeys.includes(row.group_key) && (had > 0 || row.group_key === "g2"), JSON.stringify({ newKey, row }));
    chk("I18 결과 안내 — 기본값으로 넣은 묶음은 «(이름 규칙)» 으로 밝힌다", (apG?.result.notes ?? []).some((n) => n.includes("묶음") && n.includes("(이름 규칙)")), JSON.stringify(apG?.result.notes));
    if (apG) {
      const unG = await undoImport(stG.batch.id, ctx);
      chk("I18 되돌리기가 새 분류까지 치운다", unG.batch.state === "undone" && !(await q1(`SELECT 1 AS x FROM category WHERE key=$1`, [newKey])), JSON.stringify(unG.report));
    }
    //  사람이 고른 묶음 — 화면과 같은 길(적용 API 의 핸들러 · 결정 읽기)로 기본값(g2)이 아닌 묶음을 고른다.
    const pick = activeKeys.find((key) => key !== (pc?.group ?? null)) ?? activeKeys[0];
    const stP = await stageImport(outG.file, { fileName: `${T}-groups-pick.zip`, ctx });
    const applyCap = transferCapabilities.find((c) => c.name === "transfer_import_apply");
    let apP = null, errP = null;
    try {
      apP = await applyCap.handler({ id: stP.batch.id, categories: { [`${T}-cs`]: { action: "create", group: pick } } },
        { userId: `${T}-admin`, scopes: ["admin"] }, { actor: `${T}-admin`, source: "web" });
    } catch (e) { errP = e; }
    const pickKey = apP?.batch?.result?.categories_created?.[0]?.key;
    const pickRow = pickKey ? await q1(`SELECT group_key FROM category WHERE key=$1`, [pickKey]) : null;
    chk("I18 적용 API 로 고른 묶음이 쓰인다(기본값이 아니라)", !errP && pickRow?.group_key === pick && pick !== pc?.group,
      errP ? String(errP.message ?? errP) : JSON.stringify({ pick, default: pc?.group, pickKey, pickRow }));
    const pickName = (await q1(`SELECT name FROM category_group WHERE key=$1`, [pick]))?.name;
    const pickNotes = apP?.batch?.result?.notes ?? [];
    chk("I18 결과 안내 — 고른 묶음은 그 이름으로, «(이름 규칙)» 이라고 하지 않는다(2026-11-18 «이름에 따라» 실측 문구)",
      pickNotes.some((n) => n.includes(`→ ${pickName}`) && !n.includes("(이름 규칙)") && !n.includes("이름에 따라")), JSON.stringify({ pickName, pickNotes }));
    if (apP) await undoImport(stP.batch.id, ctx);
    await itemsPool.query(`DELETE FROM category_group WHERE origin = $1`, [T]);
  }
} catch (e) {
  bad("예외", e && e.stack || String(e));
} finally {
  await setUid(originalUid).catch(() => {});
  await cleanup().catch((e) => console.error("cleanup 실패", e));
  await itemsPool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
