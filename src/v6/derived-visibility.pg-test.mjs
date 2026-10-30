// #4824 증류 지식 공개범위 — PG 통합 테스트 (**실제 Postgres 필요**, 기본 npm test 체인 밖).
//  실행: npm run build && ITEMS_DATABASE_URL=… node src/v6/derived-visibility.pg-test.mjs
//
//  왜 PG 통합인가: 이 변경의 판정은 전부 «한 트랜잭션 안에서 무엇이 함께 커밋·롤백되나» 와 SQL 술어(잠금·연결·대상 행)에 산다.
//   목으로는 «연결이 실패하면 지식 행도 없다» · «거절되면 본문도 그대로다» · «단위를 좁히면 이미 만든 지식도 같은 트랜잭션에서
//   좁혀진다» 를 볼 수 없다. 표면(knowledge_save · source_link_knowledge 핸들러)을 부르고 DB 를 되읽어 판정한다.
//
//  사양 엣지 표(행마다 단언 — 스크래치 spec.md 와 같은 번호):
//   D1 새 지식 + 잠긴 자료 → 그 자료 대상으로 태어난다 · 연결 있음 · 비대상은 못 봄
//   D2 새 지식 + 열린 자료 → 열린 채 · 연결 있음
//   D3 새 지식 + 대상이 안 겹치는 잠긴 자료 둘 → 409 · 지식·연결 없음
//   D4 없는 자료 id → 404 · 지식 없음
//   D5 빈 derived_from → 없음과 같다(일반 세션은 열린 저장 · 증류 배치는 400)
//   D6 연결 단계에서 실패 → 지식 행·대상·연결·감사 전부 없음(한 트랜잭션)
//   E1 남이 만든 열린 지식에 잠긴 자료 합치기(append+derived_from) → 409 · 본문·공개범위·연결 그대로(완료 조건 ②)
//   E2 이미 그 대상인 지식에 더 넓은 잠긴 자료 → 성공 · 대상 그대로
//   E3 열린 지식 + 열린 자료 → 성공 · 열린 채
//   L1 단독 연결(일반 세션)로 잠긴 자료를 열린 지식에 → 좁힌다(닫히는 쪽) · narrowed 알림
//   L2 단독 연결(증류 배치)이 이번 판에 안 쓴 지식에 → 409 · 연결 없음
//   L3 단독 연결(증류 배치)이 이번 판에 쓴 지식에 → 좁힌다
//   L4 되돌리기(allowNarrow)는 리스트 grant 지식도 좁힌다
//   L5 잠긴 자료로의 cites — 더 넓은 지식에서 409 · 이미 좁은 지식에서는 통과 · 열린 자료는 통과
//   G1 증류 배치 세션의 derived_from 없는 저장 → 400 · 지식 없음
//   G2 증류 배치 세션의 폴더 저장 → 허용
//   G3 일반 세션의 derived_from 없는 저장 → 종전대로
//   G5 축이 꺼진 워크스페이스의 증류 배치 → 가드 없음(종전 두 번 호출 · 켤 때 맞춘다)
//   N1 단위 «모두» → «나만» → 그 단위 자료로 만든 지식이 주인만(완료 조건 ③)
//   N2 단위 구성원이 빠지면 지식도 같은 만큼
//   N3 단위를 넓혀도 지식은 그대로
//   N5 정책을 못 읽은 판(자료가 닫힘)은 지식을 맞추지 않는다
//   P1 리스트 grant 지식에 잠긴 자료 단독 연결 → 409
//   P2 리스트 grant 지식이 이은 열린 자료가 나중에 잠김 → 리스트 grant 걷힘 · 닫힘
//   X1 축이 꺼진 채 이은 연결 → 잠그지 않음 · 축을 켜면 맞춰짐
//   M1 같은 외부 좌표의 지식 사본(수집기 both) → 자료가 잠기면 이어지고 좁혀짐
//   V1 지식 상세 — 안 보이는 인용 자료·자식 문서의 제목을 싣지 않는다
//   C1 연결과 자료 좁히기가 겹쳐도 지식이 자료보다 넓게 남지 않는다
//   C2 단위 여러 개를 함께 좁힐 때 자료를 전역 id 순으로 잡는다 — 막힌 자리보다 큰 id 를 쥐고 기다리지 않는다(연결과 교착 없음 · 격리 리뷰 차단)
//   N4 정책 소급(source_vis_policy_backfill)으로 자료가 잠기면 그 자료로 만든 지식도 같은 트랜잭션에서 · 감사에 누가
//   M2 수집기 both 미러가 잠긴 자료를 들이면 같은 원문의 지식 사본이 이어지고 좁혀진다(미러 배선)
//   E4 기존 지식 + derived_from 저장 중 판이 바뀌면 409 · 본문·연결·판 그대로
//   D7 비공개 프로젝트 세션 + 잠긴 자료로 새 지식 → 409 · 지식 없음 / 열린 자료면 프로젝트 리스트로 잠겨 태어난다
//   V2 지식 상세 — 안 보이는 조상 문서의 제목을 싣지 않는다
//   T1 프리셋 레인의 저장된 옛 문구는 글자 그대로 같을 때만 새 문구로 · 사람이 고친 줄은 그대로 · 두 번째는 0건
import crypto from "node:crypto";
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool, withTx } = await import(`${DIST}/db/client.js`);
const { knowledgeSave } = await import(`${DIST}/capabilities/knowledge/authoring.js`);
const { sourceCapabilities } = await import(`${DIST}/capabilities/source.js`);
const { visAxesCapabilities } = await import(`${DIST}/capabilities/vis-axes.js`);
const { canSeeKnowledge, invalidateVisibilityCache } = await import(`${DIST}/v6/visibility.js`);
const { invalidateVisAxes } = await import(`${DIST}/v6/visibility-axes.js`);
const { invalidateSourceVisRules } = await import(`${DIST}/v6/source-vis-policy.js`);
const { linkKnowledgeSource, getKnowledge } = await import(`${DIST}/v6/knowledge-store.js`);
const dv = await import(`${DIST}/v6/derived-visibility.js`);
const { invalidateDistillBatchCache } = await import(`${DIST}/org/distill/distill-batch.js`);
const store = await import(`${DIST}/org/collect/unit-store.js`);
const { sourceVisPolicyCapabilities } = await import(`${DIST}/ee/capabilities/source-vis-policy.js`);
const { mirrorExternalToV6 } = await import(`${DIST}/v6/connector-mirror.js`);
const { withCollector } = await import(`${DIST}/connectors/config.js`);
const { migrateDistillerPresetText, PRESET_TEXT_MIGRATIONS } = await import(`${DIST}/org/distill/preset-text-migrate.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const TAG = `dvpg${crypto.randomBytes(3).toString("hex")}`;
const A = `__${TAG}_a`, B = `__${TAG}_b`, C = `__${TAG}_c`, OUT = `__${TAG}_out`;
const MEMBERS = [A, B, C, OUT];
const CAT = `${TAG}-cat`;
const SYS = `${TAG}sys`;              // 이 시험의 자료만 쓰는 external_system
const SYS2 = `${TAG}pol`;             // 정책(잠금 규칙)이 걸린 external_system — N4·M2
const PROJ_SESSION = `box-${TAG}-9c0d1e2f`;
const APP = `${TAG}app`;              // 수집 단위 앱 키
const JOB = `${TAG}-job`;
const BATCH_SESSION = `box-${TAG}-1a2b3c4d`;
const PLAIN_SESSION = `box-${TAG}-5e6f7a8b`;
const kname = (s) => `${TAG}-${s}`;

const linkCap = sourceCapabilities.find((c) => c.name === "source_link_knowledge");
const axisCap = visAxesCapabilities.find((c) => c.name === "vis_axis_set");
const ctxOf = (actor, session) => ({ actor, source: "mcp", viewer: actor, ...(session ? { session } : {}) });
const save = (input, actor = A, session) => knowledgeSave.handler(input, { userId: actor }, ctxOf(actor, session));
const link = (name, source_id, relation = "derived_from", actor = A, session) =>
  linkCap.handler({ name, source_id, relation }, { userId: actor }, ctxOf(actor, session));
const attempt = async (fn) => { try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, status: e?.status ?? 500, msg: String(e?.message ?? e), body: e?.body }; } };

const knowRow = async (name) => (await itemsPool.query(`SELECT name, visibility, body_md, version FROM knowledge WHERE name=$1`, [name])).rows[0];
const knowAud = async (name) => (await itemsPool.query(
  `SELECT subject_kind || ':' || member_id AS s FROM knowledge_member WHERE name=$1 ORDER BY 1`, [name])).rows.map((r) => r.s);
const knowLists = async (name) => (await itemsPool.query(`SELECT list_id FROM knowledge_list_grant WHERE name=$1`, [name])).rows.map((r) => Number(r.list_id));
const linksOf = async (name) => (await itemsPool.query(
  `SELECT source_id, relation FROM knowledge_source WHERE name=$1 ORDER BY source_id`, [name])).rows.map((r) => `${r.relation}:${r.source_id}`);
const auditCount = async (name) => Number((await itemsPool.query(
  `SELECT count(*)::int n FROM org_content_audit WHERE entity='knowledge' AND entity_key=$1`, [name])).rows[0].n);
const sees = async (name, who) => { invalidateVisibilityCache(); return canSeeKnowledge(name, who); };

/** 자료 1건 — locked 면 대상(열쇠 목록)으로 잠근다. */
let extSeq = 0;
async function mkSource(locked, subjects = [], o = {}) {
  const ext = o.ext ?? `${TAG}-s${++extSeq}`;
  const r = await itemsPool.query(
    `INSERT INTO source(kind, title, body_md, fields, provenance, external_system, external_instance, external_id, visibility)
     VALUES('other', $1, $2, '{}'::jsonb, 'observed', $3, 'default', $4, $5) RETURNING id`,
    [o.title ?? `자료 ${ext}`, o.body ?? `본문 ${ext}`, o.system ?? SYS, ext, locked ? "members" : "open"]);
  const id = Number(r.rows[0].id);
  for (const s of subjects) {
    const [k, m] = s.split(":");
    await itemsPool.query(`INSERT INTO source_member(source_id, subject_kind, member_id) VALUES($1,$2,$3)`, [id, k, m]);
  }
  return id;
}
/** 지식 1건을 직접(감사 행 포함 — «다른 사람이 만든» 지식). */
async function mkKnowledge(name, author, o = {}) {
  await itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, provenance, lifecycle, visibility, type, updated_by)
     VALUES($1, $1, $2, 'authored', 'active', $3, 'reference', $4)`, [name, o.body ?? "원래 본문", o.visibility ?? "open", author]);
  await itemsPool.query(
    `INSERT INTO org_content_audit(entity, entity_key, op, before, after, actor, source, channel)
     VALUES('knowledge', $1, 'insert', NULL, '{}'::jsonb, $2, 'mcp', 'mcp')`, [name, author]);
  for (const s of o.subjects ?? []) {
    const [k, m] = s.split(":");
    await itemsPool.query(`INSERT INTO knowledge_member(name, subject_kind, member_id) VALUES($1,$2,$3)`, [name, k, m]);
  }
}
const setAxes = async (patch) => {
  await itemsPool.query(`UPDATE org_runtime_config SET visibility_axes = COALESCE(visibility_axes,'{}'::jsonb) || $1::jsonb WHERE id=1`, [JSON.stringify(patch)]);
  invalidateVisAxes();
};

async function cleanup() {
  await itemsPool.query(`DROP TRIGGER IF EXISTS ${TAG}_fail ON knowledge_source`).catch(() => {});
  await itemsPool.query(`DROP TRIGGER IF EXISTS ${TAG}_bump ON knowledge_source`).catch(() => {});
  await itemsPool.query(`DELETE FROM knowledge WHERE external_system = ANY($1::text[])`, [[SYS, SYS2]]);
  await itemsPool.query(`DELETE FROM org_source_vis_policy WHERE note LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM session_project WHERE session_id=$1`, [PROJ_SESSION]);
  await itemsPool.query(`DELETE FROM project WHERE name LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM org_distiller WHERE key LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM knowledge WHERE name LIKE $1`, [`${TAG}-%`]);
  await itemsPool.query(`DELETE FROM org_content_audit WHERE entity='knowledge' AND entity_key LIKE $1`, [`${TAG}-%`]);
  await itemsPool.query(`DELETE FROM collect_unit WHERE app=$1`, [APP]);
  await itemsPool.query(`DELETE FROM source WHERE external_system = ANY($1::text[])`, [[SYS, APP, SYS2]]);
  await itemsPool.query(`DELETE FROM org_task WHERE requester_session LIKE $1`, [`cron:${JOB}%`]);
  await itemsPool.query(`DELETE FROM org_cron WHERE id=$1`, [JOB]);
  await itemsPool.query(`DELETE FROM project_list WHERE name LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM category WHERE key=$1`, [CAT]);
  await itemsPool.query(`DELETE FROM team WHERE key=$1`, [`${TAG}-team`]);
  await itemsPool.query(`DELETE FROM org_member WHERE id = ANY($1::text[])`, [MEMBERS]);
  await setAxes({ source: true, knowledge: true });
  invalidateSourceVisRules(); invalidateDistillBatchCache();
}

try {
  await cleanup();
  for (const m of MEMBERS) await itemsPool.query(`INSERT INTO org_member(id, email, display_name) VALUES($1,$2,$1) ON CONFLICT DO NOTHING`, [m, `${m}@dvpg.test`]);
  await itemsPool.query(`INSERT INTO category(key, name, origin) VALUES($1,$1,'human')`, [CAT]);
  const NEW = (name, extra = {}) => ({ name, title: name, body_md: `본문 ${name}`, type: "reference", category: CAT, ...extra });

  // ── D 새 지식 + derived_from ──
  const sA = await mkSource(true, [`member:${A}`]);
  const sB = await mkSource(true, [`member:${B}`]);
  const sAB = await mkSource(true, [`member:${A}`, `member:${B}`]);
  const sOpen = await mkSource(false);
  {
    const r = await attempt(() => save(NEW(kname("d1"), { derived_from: [sA] })));
    chk("D1 새 지식 + 잠긴 자료 → 저장 성공", r.ok, JSON.stringify(r));
    const k = await knowRow(kname("d1"));
    chk("D1 그 자료 대상으로 태어난다(members · A 만)", k?.visibility === "members" && JSON.stringify(await knowAud(kname("d1"))) === JSON.stringify([`member:${A}`]),
      JSON.stringify({ k, aud: await knowAud(kname("d1")) }));
    chk("D1 연결 있음", JSON.stringify(await linksOf(kname("d1"))) === JSON.stringify([`derived_from:${sA}`]), JSON.stringify(await linksOf(kname("d1"))));
    chk("D1 A 는 보고 비대상(OUT·B)은 못 본다", (await sees(kname("d1"), A)) && !(await sees(kname("d1"), OUT)) && !(await sees(kname("d1"), B)));
    chk("D1 응답이 잠긴 자료를 알린다", r.ok && r.v?.derived?.visibility === "members" && Array.isArray(r.v?.derived?.locked_sources), JSON.stringify(r.v?.derived));
  }
  {
    const r = await attempt(() => save(NEW(kname("d2"), { derived_from: [sOpen] })));
    const k = await knowRow(kname("d2"));
    chk("D2 새 지식 + 열린 자료 → 열린 채 · 연결 있음", r.ok && k?.visibility === "open" && (await linksOf(kname("d2"))).length === 1, JSON.stringify({ r, k }));
  }
  {
    //  A 가 둘 다 보는데(팀 T 의 팀원 · 자기 이름) 열쇠가 달라 겹치는 대상이 없다 — 팀 ∩ 사람은 남기지 않는다(사본이 낡으므로).
    const T = (await itemsPool.query(`INSERT INTO team(key, name) VALUES($1,$1) RETURNING id`, [`${TAG}-team`])).rows[0].id;
    await itemsPool.query(`INSERT INTO team_member(team_id, member_id) VALUES($1,$2)`, [T, A]);
    const sTeam = await mkSource(true, [`team:${T}`]);
    const r = await attempt(() => save(NEW(kname("d3"), { derived_from: [sTeam, sA] })));
    chk("D3 대상이 안 겹치는 잠긴 자료 둘 → 409", !r.ok && r.status === 409 && r.body?.code === "derived_empty_audience", JSON.stringify(r));
    chk("D3 지식 행·연결 없음", !(await knowRow(kname("d3"))) && (await linksOf(kname("d3"))).length === 0);
  }
  {
    const r = await attempt(() => save(NEW(kname("d4"), { derived_from: [2_000_000_000] })));
    chk("D4 없는 자료 id → 404 · 지식 없음", !r.ok && r.status === 404 && !(await knowRow(kname("d4"))), JSON.stringify(r));
  }
  {
    const r = await attempt(() => save(NEW(kname("d4b"), { derived_from: [sB] }), A));
    chk("D4b 부르는 사람에게 안 보이는 자료 → 404(존재 은닉) · 지식 없음", !r.ok && r.status === 404 && !(await knowRow(kname("d4b"))), JSON.stringify(r));
  }
  {
    const r = await attempt(() => save(NEW(kname("d5"), { derived_from: [] })));
    chk("D5 빈 derived_from(일반 세션) → 종전처럼 열린 저장 · 연결 없음", r.ok && (await knowRow(kname("d5")))?.visibility === "open" && (await linksOf(kname("d5"))).length === 0, JSON.stringify(r));
  }
  {
    // 연결 단계에서 실패를 심는다 — 그 이름의 knowledge_source INSERT 가 예외를 던지게.
    await itemsPool.query(`CREATE OR REPLACE FUNCTION ${TAG}_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name = '${kname("d6")}' THEN RAISE EXCEPTION 'injected link failure'; END IF; RETURN NEW; END $$`);
    await itemsPool.query(`CREATE TRIGGER ${TAG}_fail BEFORE INSERT ON knowledge_source FOR EACH ROW EXECUTE FUNCTION ${TAG}_fail_fn()`);
    const r = await attempt(() => save(NEW(kname("d6"), { derived_from: [sA] })));
    await itemsPool.query(`DROP TRIGGER IF EXISTS ${TAG}_fail ON knowledge_source`);
    await itemsPool.query(`DROP FUNCTION IF EXISTS ${TAG}_fail_fn()`);
    chk("D6 연결 실패 주입 → 저장 실패로 돌아온다", !r.ok, JSON.stringify(r));
    chk("D6 ★지식 행·대상·연결·감사가 하나도 남지 않는다(공개로 남는 지식 없음)",
      !(await knowRow(kname("d6"))) && (await knowAud(kname("d6"))).length === 0 && (await linksOf(kname("d6"))).length === 0 && (await auditCount(kname("d6"))) === 0,
      JSON.stringify({ row: await knowRow(kname("d6")), audit: await auditCount(kname("d6")) }));
  }

  // ── E 기존 지식에 합치기 ──
  {
    await mkKnowledge(kname("e1"), C);   // 남(C)이 만든 열린 지식
    const before = await knowRow(kname("e1"));
    const r = await attempt(() => save({ name: kname("e1"), mode: "append", body_md: "잠긴 자료의 내용", derived_from: [sA] }));
    const after = await knowRow(kname("e1"));
    chk("E1 ★잠긴 자료를 남이 만든 열린 지식에 합치기 → 409", !r.ok && r.status === 409 && r.body?.code === "derived_merge_refused", JSON.stringify(r));
    chk("E1 본문·판·공개범위 그대로", after?.body_md === before?.body_md && after?.version === before?.version && after?.visibility === "open", JSON.stringify({ before, after }));
    chk("E1 연결도 안 생겼다 · 다른 사람이 계속 본다", (await linksOf(kname("e1"))).length === 0 && (await sees(kname("e1"), OUT)));
    const r2 = await attempt(() => save(NEW(kname("e1-new"), { derived_from: [sA] })));
    chk("E1b 같은 자료로 새 지식을 쓰면 잠긴 새 지식이 된다", r2.ok && (await knowRow(kname("e1-new")))?.visibility === "members" && !(await sees(kname("e1-new"), OUT)), JSON.stringify(r2));
  }
  {
    await mkKnowledge(kname("e2"), C, { visibility: "members", subjects: [`member:${A}`] });
    const r = await attempt(() => save({ name: kname("e2"), mode: "append", body_md: "더 보탠다", derived_from: [sAB] }));
    const after = await knowRow(kname("e2"));
    chk("E2 이미 A 만 보는 지식 + A·B 자료 → 성공 · 본문 덧붙음 · 대상 그대로", r.ok && after?.body_md.includes("더 보탠다") && JSON.stringify(await knowAud(kname("e2"))) === JSON.stringify([`member:${A}`]) && (await linksOf(kname("e2"))).length === 1,
      JSON.stringify({ r, aud: await knowAud(kname("e2")) }));
  }
  {
    await mkKnowledge(kname("e3"), C);
    const r = await attempt(() => save({ name: kname("e3"), mode: "append", body_md: "열린 자료에서", derived_from: [sOpen] }));
    chk("E3 열린 지식 + 열린 자료 → 성공 · 열린 채", r.ok && (await knowRow(kname("e3")))?.visibility === "open" && (await linksOf(kname("e3"))).length === 1, JSON.stringify(r));
  }

  // ── G 증류 배치 가드 ──
  await itemsPool.query(`INSERT INTO org_cron(id, label, action, params, interval_sec, enabled) VALUES($1,$1,'distill_sources_headless','{}'::jsonb,600,true)`, [JOB]);
  await itemsPool.query(
    `INSERT INTO org_task(requester, requester_session, prompt, status, session_id, started_at, exec_profile)
     VALUES($1, $2, '대상 자료 id: …', 'running', $3, now() - interval '5 minutes', 'context')`, [A, `cron:${JOB}#lane`, BATCH_SESSION]);
  invalidateDistillBatchCache();
  {
    const r = await attempt(() => save(NEW(kname("g1")), A, BATCH_SESSION));
    chk("G1 ★증류 배치의 derived_from 없는 저장 → 400 · 지식 없음", !r.ok && r.status === 400 && !(await knowRow(kname("g1"))), JSON.stringify(r));
    const r5 = await attempt(() => save(NEW(kname("g1b"), { derived_from: [] }), A, BATCH_SESSION));
    chk("D5b 빈 derived_from 도 증류 배치에서는 400", !r5.ok && r5.status === 400, JSON.stringify(r5));
    const rf = await attempt(() => save({ name: kname("g2"), title: "폴더", body_md: "", is_folder: true, type: "reference", category: CAT }, A, BATCH_SESSION));
    chk("G2 증류 배치의 폴더 저장은 허용", rf.ok && !!(await knowRow(kname("g2"))), JSON.stringify(rf));
    const rf2 = await attempt(() => save({ name: kname("g2b"), title: "폴더", body_md: "", is_folder: true, type: "reference", category: CAT, derived_from: [sA] }, A, PLAIN_SESSION));
    chk("G2b derived_from 을 실은 폴더도 잠긴 자료면 그 대상으로 태어난다", rf2.ok && (await knowRow(kname("g2b")))?.visibility === "members" && !(await sees(kname("g2b"), OUT)),
      JSON.stringify({ rf2, k: await knowRow(kname("g2b")) }));
    const rp = await attempt(() => save(NEW(kname("g3")), A, PLAIN_SESSION));
    chk("G3 일반 세션의 derived_from 없는 저장은 종전대로", rp.ok && (await knowRow(kname("g3")))?.visibility === "open", JSON.stringify(rp));
    const rd = await attempt(() => save(NEW(kname("g4"), { derived_from: [sA] }), A, BATCH_SESSION));
    chk("G4 증류 배치도 derived_from 을 실으면 저장된다(잠긴 채)", rd.ok && (await knowRow(kname("g4")))?.visibility === "members", JSON.stringify(rd));
    //  G5 — 축이 꺼진 워크스페이스는 공개범위를 강제하지 않으므로 가드도 걸지 않는다(종전 두 번 호출 · 켤 때 맞춘다 — 격리 리뷰).
    await setAxes({ knowledge: false });
    const rg = await attempt(() => save(NEW(kname("g5")), A, BATCH_SESSION));
    await setAxes({ knowledge: true });
    chk("G5 축이 꺼진 워크스페이스의 증류 배치는 derived_from 없이도 저장된다", rg.ok && !!(await knowRow(kname("g5"))), JSON.stringify(rg));
  }

  // ── L 단독 연결 ──
  {
    await mkKnowledge(kname("l1"), C);
    const r = await attempt(() => link(kname("l1"), sA, "derived_from", A, PLAIN_SESSION));
    chk("L1 단독 연결(일반 세션)로 잠긴 자료를 열린 지식에 → 닫히는 쪽으로 좁힌다", r.ok && (await knowRow(kname("l1")))?.visibility === "members"
      && JSON.stringify(await knowAud(kname("l1"))) === JSON.stringify([`member:${A}`]) && !(await sees(kname("l1"), OUT)), JSON.stringify(r));
    chk("L1 응답이 좁혔다고 알린다", r.ok && r.v?.visibility?.narrowed === true, JSON.stringify(r.v));
  }
  {
    await mkKnowledge(kname("l2"), C);
    const r = await attempt(() => link(kname("l2"), sA, "derived_from", A, BATCH_SESSION));
    chk("L2 증류 배치가 이번 판에 안 쓴 지식에 잠긴 자료 단독 연결 → 409", !r.ok && r.status === 409 && r.body?.reason === "batch_untouched", JSON.stringify(r));
    chk("L2 연결 없음 · 열린 채", (await linksOf(kname("l2"))).length === 0 && (await knowRow(kname("l2")))?.visibility === "open");
  }
  {
    await mkKnowledge(kname("l3"), C);
    //  배치(A)가 이번 판에 그 지식을 고친다(열린 자료로 — 통과) → 그 뒤 잠긴 자료 단독 연결은 좁힌다(내용이 들어갔을 수 있다).
    const w = await attempt(() => save({ name: kname("l3"), mode: "append", body_md: "배치가 덧붙임", derived_from: [sOpen] }, A, BATCH_SESSION));
    const r = await attempt(() => link(kname("l3"), sA, "derived_from", A, BATCH_SESSION));
    chk("L3 증류 배치가 이번 판에 쓴 지식에는 단독 연결이 좁힌다", w.ok && r.ok && (await knowRow(kname("l3")))?.visibility === "members", JSON.stringify({ w, r }));
  }
  {
    const L = (await itemsPool.query(`INSERT INTO project_list(name, visibility) VALUES($1,'members') RETURNING id`, [`${TAG}-list`])).rows[0].id;
    await itemsPool.query(`INSERT INTO project_list_member(list_id, member_id) VALUES($1,$2)`, [L, A]);   // A 는 그 프로젝트를 본다
    await mkKnowledge(kname("p1"), C, { visibility: "members" });
    await itemsPool.query(`INSERT INTO knowledge_list_grant(name, list_id) VALUES($1,$2)`, [kname("p1"), L]);
    const r = await attempt(() => link(kname("p1"), sA, "derived_from", A, PLAIN_SESSION));
    chk("P1 리스트 grant 지식에 잠긴 자료 단독 연결 → 409(프로젝트 공개범위와 함께 못 지킴)", !r.ok && r.status === 409 && r.body?.reason === "project_list", JSON.stringify(r));
    chk("P1 연결 없음 · 리스트 grant 그대로", (await linksOf(kname("p1"))).length === 0 && JSON.stringify(await knowLists(kname("p1"))) === JSON.stringify([L]));
    //  L4 — 되돌리기(allowNarrow)는 같은 연결을 좁혀서 잇는다(리스트를 걷는다).
    const u = await attempt(() => linkKnowledgeSource(kname("p1"), sA, "derived_from", { actor: A, source: "web" }, { allowNarrow: true, viewer: undefined }));
    chk("L4 되돌리기의 다시 잇기는 거절 없이 좁힌다 · 리스트 grant 걷힘", u.ok && (await knowLists(kname("p1"))).length === 0
      && JSON.stringify(await knowAud(kname("p1"))) === JSON.stringify([]) && (await linksOf(kname("p1"))).length === 1, JSON.stringify(u));
    //  P2 — 리스트 grant 지식이 이은 **열린** 자료가 나중에 잠기면(정책 소급 같은 좁히기) 리스트가 걷히고 닫힌다.
    const sLater = await mkSource(false);
    await mkKnowledge(kname("p2"), C, { visibility: "members" });
    await itemsPool.query(`INSERT INTO knowledge_list_grant(name, list_id) VALUES($1,$2)`, [kname("p2"), L]);
    const lk = await attempt(() => link(kname("p2"), sLater, "derived_from", A, PLAIN_SESSION));
    chk("P2-0 열린 자료는 리스트 grant 지식에도 이어진다(바뀜 없음)", lk.ok && JSON.stringify(await knowLists(kname("p2"))) === JSON.stringify([L]), JSON.stringify(lk));
    await withTx(async (c) => {
      await c.query(`UPDATE source SET visibility='members' WHERE id=$1`, [sLater]);
      await c.query(`INSERT INTO source_member(source_id, subject_kind, member_id) VALUES($1,'member',$2)`, [sLater, A]);
      await dv.reconcileDerivedVisibility(c, { sourceIds: [sLater] });
    });
    chk("P2 그 자료가 잠기면 리스트 grant 를 걷고 닫는다(프로젝트 구성원이 잠긴 자료 내용을 계속 보지 않게)",
      (await knowLists(kname("p2"))).length === 0 && (await knowRow(kname("p2")))?.visibility === "members" && !(await sees(kname("p2"), A)),
      JSON.stringify({ lists: await knowLists(kname("p2")), aud: await knowAud(kname("p2")) }));
  }
  {
    await mkKnowledge(kname("l5"), C);
    const r1 = await attempt(() => link(kname("l5"), sA, "cites", A, PLAIN_SESSION));
    chk("L5 잠긴 자료를 더 넓은 지식에서 cites → 409(relation 만 바꿔 빠져나가지 못한다)", !r1.ok && r1.status === 409 && r1.body?.reason === "cites_wider", JSON.stringify(r1));
    const r2 = await attempt(() => link(kname("l5"), sOpen, "cites", A, PLAIN_SESSION));
    chk("L5b 열린 자료 cites 는 통과 · 공개범위 그대로", r2.ok && (await knowRow(kname("l5")))?.visibility === "open", JSON.stringify(r2));
    const r3 = await attempt(() => link(kname("e2"), sAB, "cites", A, PLAIN_SESSION));
    chk("L5c 이미 자료보다 좁은 지식의 잠긴 자료 cites 는 통과", r3.ok, JSON.stringify(r3));
  }

  // ── N 수집 단위를 좁히면 지식도 ──
  {
    const listing = (member, refs, o = {}) => store.recordUnitListing({
      member, app: APP, connector: "Dvpg", instance: "", items: refs.map((r) => ({ ref: r, kind: o.kind ?? "channel", name: `#${r}` })),
      complete: o.complete, verified: true });
    const unitBy = async (ref) => (await itemsPool.query(`SELECT * FROM collect_unit WHERE app=$1 AND instance='' AND ref=$2`, [APP, ref])).rows[0];
    const item = (ext, body) => ({ type: "message", provenance: { category: "messenger", system: APP, instance: "", external_id: ext },
      title: null, body, occurred_at: "2026-10-16T01:00:00Z", fields: {} });
    // N1 — 공개 채널 단위(첫 제안 «모두»)에서 모은 자료로 열린 지식 → 단위를 «나만»(A) 으로 좁힌다.
    await listing(A, ["pub"]); await listing(B, ["pub"]);
    let u = await unitBy("pub");
    await itemsPool.query(`UPDATE collect_unit SET state='active' WHERE id=$1`, [u.id]);
    await store.storeUnitItems(u.id, [item(`${TAG}-n1`, "공개 채널 글")], { member: A });
    const sN1 = Number((await itemsPool.query(`SELECT id FROM source WHERE external_system=$1 AND external_id=$2`, [APP, `${TAG}-n1`])).rows[0].id);
    const r = await attempt(() => save(NEW(kname("n1"), { derived_from: [sN1] })));
    chk("N1-0 «모두» 단위 자료로 만든 지식은 열려 있다", r.ok && u.visibility === "all" && (await knowRow(kname("n1")))?.visibility === "open", JSON.stringify({ r, vis: u.visibility }));
    await store.updateUnit(u.id, { visibility: "me" }, { member: A, isAdmin: false });
    chk("N1 ★단위를 «나만» 으로 좁히면 그 단위 자료로 만든 지식도 주인(A)만 본다(완료 조건 ③)",
      (await knowRow(kname("n1")))?.visibility === "members" && JSON.stringify(await knowAud(kname("n1"))) === JSON.stringify([`member:${A}`])
      && (await sees(kname("n1"), A)) && !(await sees(kname("n1"), B)) && !(await sees(kname("n1"), OUT)),
      JSON.stringify({ k: await knowRow(kname("n1")), aud: await knowAud(kname("n1")) }));
    // N3 — 다시 넓혀도(«모두», confirm) 지식은 그대로.
    await store.updateUnit(u.id, { visibility: "all", confirm: true }, { member: A, isAdmin: false });
    chk("N3 단위를 넓혀도 지식은 넓어지지 않는다", (await knowRow(kname("n1")))?.visibility === "members" && !(await sees(kname("n1"), OUT)));

    // N2 — 비공개 채널(«볼 수 있는 사람만»)에 A·B → 자료 {A,B} → 지식 {A,B} → B 가 빠지면 지식도 {A}.
    await listing(A, ["priv"], { kind: "private_channel" }); await listing(B, ["priv", "other"], { kind: "private_channel" });
    u = await unitBy("priv");
    await itemsPool.query(`UPDATE collect_unit SET state='active' WHERE id=$1`, [u.id]);
    await store.storeUnitItems(u.id, [item(`${TAG}-n2`, "비공개 채널 글")], { member: A });
    const sN2 = Number((await itemsPool.query(`SELECT id FROM source WHERE external_system=$1 AND external_id=$2`, [APP, `${TAG}-n2`])).rows[0].id);
    const r2 = await attempt(() => save(NEW(kname("n2"), { derived_from: [sN2] })));
    chk("N2-0 자료 {A,B} 로 만든 지식은 A·B 가 본다", r2.ok && (await sees(kname("n2"), A)) && (await sees(kname("n2"), B)) && !(await sees(kname("n2"), OUT)), JSON.stringify(r2));
    await listing(B, ["other"], { kind: "private_channel", complete: true });   // B 는 이제 priv 를 못 본다
    chk("N2 단위에서 B 가 빠지면 지식도 B 가 못 본다", (await sees(kname("n2"), A)) && !(await sees(kname("n2"), B)), JSON.stringify(await knowAud(kname("n2"))));
  }

  // ── N5 정책을 못 읽은 판 ──
  {
    //  직접 판정 함수로: 정책 캐시를 비우고 정책 표 조회를 실패시키면 applySourceAudience 가 닫는 쪽으로 맞춘다.
    //   그 판은 지식을 맞추지 않는다(순간 장애가 지식을 영구히 닫지 않게). 표 이름을 잠시 바꿔 조회를 실패시킨다.
    const unit = (await itemsPool.query(`SELECT id FROM collect_unit WHERE app=$1 AND ref='priv'`, [APP])).rows[0];
    const sid = Number((await itemsPool.query(`SELECT id FROM source WHERE external_system=$1 AND external_id=$2`, [APP, `${TAG}-n2`])).rows[0].id);
    const audBefore = JSON.stringify(await knowAud(kname("n2")));
    invalidateSourceVisRules();
    await itemsPool.query(`ALTER TABLE org_source_vis_policy RENAME TO org_source_vis_policy_${TAG}`);
    try {
      await withTx(async (c) => { await store.syncUnitAudience(c, [unit.id]); });
    } finally {
      await itemsPool.query(`ALTER TABLE org_source_vis_policy_${TAG} RENAME TO org_source_vis_policy`);
      invalidateSourceVisRules();
    }
    const srcAud = (await itemsPool.query(`SELECT count(*)::int n FROM source_member WHERE source_id=$1`, [sid])).rows[0].n;
    chk("N5 정책을 못 읽은 판: 자료는 닫히고(대상 0) 지식은 그대로", srcAud === 0 && JSON.stringify(await knowAud(kname("n2"))) === audBefore,
      JSON.stringify({ srcAud, kn: await knowAud(kname("n2")), audBefore }));
    await withTx(async (c) => { await store.syncUnitAudience(c, [unit.id]); });   // 정책이 돌아온 판 — 자료가 제 대상으로
  }

  // ── X 축이 꺼진 채 이은 연결 ──
  {
    await setAxes({ source: false });
    await mkKnowledge(kname("x1"), C);
    const r = await attempt(() => link(kname("x1"), sA, "derived_from", A, PLAIN_SESSION));
    chk("X1-0 자료 축이 꺼진 채 이으면 잠그지 않는다(종전)", r.ok && (await knowRow(kname("x1")))?.visibility === "open", JSON.stringify(r));
    const on = await attempt(() => axisCap.handler({ axis: "source", on: true }, { userId: A }, { actor: A, source: "web" }));
    chk("X1 축을 켜면 그 지식이 맞춰진다(A 만)", on.ok && (await knowRow(kname("x1")))?.visibility === "members" && !(await sees(kname("x1"), OUT)), JSON.stringify(on));
    const again = await attempt(() => axisCap.handler({ axis: "source", on: true }, { userId: A }, { actor: A, source: "web" }));
    chk("X1b 이미 켜진 축을 다시 켜면 맞추기만 다시 돈다(멱등 · 0건)", again.ok && again.v?.changed === false && again.v?.derived_narrowed === 0, JSON.stringify(again.v));
  }

  // ── M 같은 외부 좌표의 지식 사본(수집기 both) ──
  {
    const ext = `${TAG}-m1`;
    const sid = await mkSource(false, [], { ext });
    await itemsPool.query(
      `INSERT INTO knowledge(name, title, body_md, provenance, lifecycle, visibility, external_system, external_instance, external_id)
       VALUES($1,$1,'원문 사본','observed','active','open',$2,'default',$3)`, [kname("m1"), SYS, ext]);
    await withTx(async (c) => {
      await c.query(`UPDATE source SET visibility='members' WHERE id=$1`, [sid]);
      await c.query(`INSERT INTO source_member(source_id, subject_kind, member_id) VALUES($1,'member',$2)`, [sid, A]);
      await dv.reconcileDerivedVisibility(c, { sourceIds: [sid] }, undefined, "mirror_copy");
    });
    chk("M1 원문이 잠기면 같은 외부 좌표의 지식 사본이 이어지고 좁혀진다",
      JSON.stringify(await linksOf(kname("m1"))) === JSON.stringify([`derived_from:${sid}`]) && (await knowRow(kname("m1")))?.visibility === "members" && !(await sees(kname("m1"), OUT)),
      JSON.stringify({ links: await linksOf(kname("m1")), k: await knowRow(kname("m1")) }));
  }

  // ── V 지식 상세의 제목 ──
  {
    await mkKnowledge(kname("v1"), C);
    await itemsPool.query(`INSERT INTO knowledge_source(name, source_id, relation) VALUES($1,$2,'cites')`, [kname("v1"), sA]);
    await itemsPool.query(
      `INSERT INTO knowledge(name, title, body_md, provenance, lifecycle, visibility, type, parent_name) VALUES($1,'잠긴 자식 제목','x','authored','active','members','reference',$2)`,
      [kname("v1-child"), kname("v1")]);
    invalidateVisibilityCache();
    const forOut = await getKnowledge(kname("v1"), OUT);
    const forA = await getKnowledge(kname("v1"), A);
    chk("V1 안 보이는 인용 자료·자식 문서의 제목을 싣지 않는다", (forOut?.sources ?? []).length === 0 && (forOut?.children ?? []).length === 0,
      JSON.stringify({ sources: forOut?.sources, children: forOut?.children }));
    chk("V1b 볼 수 있는 사람에게는 그대로", (forA?.sources ?? []).length === 1, JSON.stringify(forA?.sources));
  }

  // ── C 연결과 좁히기가 겹칠 때 ──
  {
    let worst = null;
    for (let i = 0; i < 12; i++) {
      const sid = await mkSource(true, [`member:${A}`, `member:${B}`]);
      await mkKnowledge(kname(`c${i}`), A);
      const narrow = withTx(async (c) => {
        await c.query(`SELECT id FROM source WHERE id=$1 FOR NO KEY UPDATE`, [sid]);
        await c.query(`DELETE FROM source_member WHERE source_id=$1 AND member_id=$2`, [sid, B]);
        await dv.reconcileDerivedVisibility(c, { sourceIds: [sid] });
      });
      const linked = linkKnowledgeSource(kname(`c${i}`), sid, "derived_from", { actor: A, source: "web" }, { viewer: undefined });
      await Promise.all([narrow, linked]);
      const aud = await knowAud(kname(`c${i}`));
      if (aud.includes(`member:${B}`) || (await knowRow(kname(`c${i}`)))?.visibility !== "members") worst = { i, aud };
    }
    chk("C1 ★연결과 자료 좁히기가 겹쳐도 지식이 자료보다 넓게 남지 않는다(12회)", worst === null, JSON.stringify(worst));
  }

  // ── C2 단위 여러 개를 함께 좁힐 때 자료 잠금 순서(격리 리뷰 차단 — 교착) ──
  {
    //  단위 두 개에 자료가 번갈아 들어간다(id a<b<c<d · lo1={a,c} · lo2={b,d}). 다른 트랜잭션 X 가 자료 하나를 FOR SHARE 로
    //   쥔 채(연결이 자료를 잡는 모양), 두 단위를 한 번에 좁히는 Y 가 그 자료에서 막히게 한다. 전역 id 순으로 잡으면 Y 는 막힌 자리보다
    //   **작은** id 만 쥐고 있다 — 그보다 큰 id 는 X 가 NOWAIT 로 잡을 수 있어야 한다(쥐고 있으면 연결과 서로 기다린다 = 교착).
    //   묶음(단위 조합)마다 따로 잡던 종전 모양은 묶음 순서에 따라 둘 중 한 판에서 큰 id 를 쥔 채 막힌다 — 그래서 두 판을 본다.
    const listing = (member, refs) => store.recordUnitListing({
      member, app: APP, connector: "Dvpg", instance: "", items: refs.map((r) => ({ ref: r, kind: "private_channel", name: `#${r}` })), verified: true });
    const unitBy = async (ref) => (await itemsPool.query(`SELECT * FROM collect_unit WHERE app=$1 AND instance='' AND ref=$2`, [APP, ref])).rows[0];
    const item = (ext) => ({ type: "message", provenance: { category: "messenger", system: APP, instance: "", external_id: ext },
      title: null, body: `글 ${ext}`, occurred_at: "2026-10-16T02:00:00Z", fields: {} });
    await listing(A, ["lo1", "lo2"]);
    const u1 = await unitBy("lo1"), u2 = await unitBy("lo2");
    await itemsPool.query(`UPDATE collect_unit SET state='active' WHERE id = ANY($1::int[])`, [[u1.id, u2.id]]);
    const ids = [];
    for (const [u, e] of [[u1, "c2a"], [u2, "c2b"], [u1, "c2c"], [u2, "c2d"]]) {
      await store.storeUnitItems(u.id, [item(`${TAG}-${e}`)], { member: A });
      ids.push(Number((await itemsPool.query(`SELECT id FROM source WHERE external_system=$1 AND external_id=$2`, [APP, `${TAG}-${e}`])).rows[0].id));
    }
    const [ia, ib, ic, id] = ids;
    const addViewer = async (m) => {
      for (const u of [u1, u2]) {
        await itemsPool.query(
          `INSERT INTO collect_unit_member(unit_id, member_id, priority, via, verified_at) VALUES($1,$2,100,'listing',now()) ON CONFLICT (unit_id, member_id) DO UPDATE SET verified_at=now()`,
          [u.id, m]);
      }
    };
    const blockedOnSource = async () => Number((await itemsPool.query(
      `SELECT count(*)::int n FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'
          AND query ILIKE '%FROM source%' AND query ILIKE '%FOR NO KEY UPDATE%'`)).rows[0].n);
    const round = async (label, held, newViewer) => {
      await addViewer(newViewer);
      const x = await itemsPool.connect();
      const out = { label, held, blocked: false, probes: {}, y: null };
      try {
        await x.query("BEGIN");
        await x.query(`SELECT id FROM source WHERE id=$1 FOR SHARE`, [held]);
        const y = withTx((c) => store.syncUnitAudience(c, [u1.id, u2.id])).then(() => "ok", (e) => `err:${e?.code ?? e?.message}`);
        for (let i = 0; i < 200 && !out.blocked; i++) { if (await blockedOnSource()) out.blocked = true; else await new Promise((r) => setTimeout(r, 25)); }
        for (const big of [ia, ib, ic, id].filter((v) => v > held)) {
          await x.query("SAVEPOINT p");
          try { await x.query(`SELECT id FROM source WHERE id=$1 FOR SHARE NOWAIT`, [big]); out.probes[big] = "free"; await x.query("RELEASE SAVEPOINT p"); }
          catch (e) { out.probes[big] = e?.code ?? "error"; await x.query("ROLLBACK TO SAVEPOINT p"); }
        }
        await x.query("ROLLBACK");
        out.y = await y;
      } finally { x.release(); }
      return out;
    };
    const r1 = await round("X 가 b 를 쥠", ib, B);
    const r2 = await round("X 가 c 를 쥠", ic, C);
    chk("C2-0 배선 — 두 판 모두 Y 가 실제로 그 자료에서 막혔다", r1.blocked && r2.blocked, JSON.stringify({ r1, r2 }));
    chk("C2 ★막힌 자리보다 큰 id 는 하나도 쥐고 있지 않다(전역 id 순 — 연결과 서로 기다리지 않는다)",
      [r1, r2].every((r) => Object.values(r.probes).every((v) => v === "free")) && Object.keys(r1.probes).length === 2 && Object.keys(r2.probes).length === 1,
      JSON.stringify({ r1, r2 }));
    const aud = async (sid) => (await itemsPool.query(`SELECT member_id FROM source_member WHERE source_id=$1 ORDER BY 1`, [sid])).rows.map((r) => r.member_id);
    chk("C2b 막혔던 좁히기는 X 가 놓은 뒤 끝까지 간다 · 자료 넷 다 새 대상", r1.y === "ok" && r2.y === "ok"
      && (await Promise.all(ids.map(aud))).every((a) => JSON.stringify(a) === JSON.stringify([A, B, C].sort())),
      JSON.stringify({ y1: r1.y, y2: r2.y, aud: await Promise.all(ids.map(aud)) }));
  }

  // ── N4 정책 소급 + M2 수집기 both 미러 — 잠금 규칙이 걸린 커넥터(SYS2) ──
  {
    const pol = (await itemsPool.query(
      `INSERT INTO org_source_vis_policy(match_system, match_channel, visibility, priority, enabled, note) VALUES($1, NULL, 'members', 0, true, $2) RETURNING id`,
      [SYS2, `${TAG}-policy`])).rows[0].id;
    await itemsPool.query(`INSERT INTO org_source_vis_policy_member(policy_id, subject_kind, member_id) VALUES($1,'member',$2)`, [pol, A]);
    //  N4 — 규칙보다 먼저 들어와 열려 있던 자료(정책 도장 전) + 그 자료로 만든 열린 지식 → 소급하면 둘 다 A 만.
    const sPol = await mkSource(false, [], { system: SYS2, ext: `${TAG}-n4` });
    invalidateSourceVisRules();
    const r0 = await attempt(() => save(NEW(kname("n4"), { derived_from: [sPol] })));
    chk("N4-0 소급 전 — 열린 자료로 만든 지식은 열려 있다", r0.ok && (await knowRow(kname("n4")))?.visibility === "open", JSON.stringify(r0));
    const backfill = sourceVisPolicyCapabilities.find((c) => c.name === "source_vis_policy_backfill");
    const bf = await attempt(() => backfill.handler({ system: SYS2, dry_run: false }, { userId: C }, { actor: C, source: "web" }));
    chk("N4 ★정책 소급으로 자료가 잠기면 그 자료로 만든 지식도 A 만 본다(같은 트랜잭션)",
      bf.ok && bf.v?.knowledge_narrowed >= 1 && (await knowRow(kname("n4")))?.visibility === "members"
      && JSON.stringify(await knowAud(kname("n4"))) === JSON.stringify([`member:${A}`]) && !(await sees(kname("n4"), OUT)),
      JSON.stringify({ bf, aud: await knowAud(kname("n4")) }));
    const who = (await itemsPool.query(
      `SELECT actor FROM org_content_audit WHERE entity='knowledge' AND entity_key=$1 AND op='set_visibility' ORDER BY id DESC LIMIT 1`, [kname("n4")])).rows[0]?.actor;
    chk("N4b 좁힌 감사에 누가(소급을 부른 사람)가 남는다", who === C, JSON.stringify({ who }));

    //  M2 — 수집기 «자료+지식(both)» 이 이 커넥터의 항목을 들이면: 자료는 정책으로 잠겨 태어나고, 같은 원문의 지식 사본은 그 자료에
    //   이어져 A 만 본다(미러 배선 — 맞추기 호출이 빠지면 사본이 연결 없이 공개로 남는다).
    const ext = `${TAG}-m2`;
    const c = await itemsPool.connect();
    let mOk;
    try {
      mOk = await attempt(() => withCollector({ id: 990001, presetKey: "dvpg", instanceKey: "_", outputMode: "both" }, () => mirrorExternalToV6(c,
        { type: "message", provenance: { category: "messenger", system: SYS2, instance: "default", external_id: ext },
          title: "both 사본", body: "잠긴 채널의 글", occurred_at: "2026-10-16T03:00:00Z", fields: {} })));
    } finally { c.release(); }
    const srcRow = (await itemsPool.query(`SELECT id, visibility FROM source WHERE external_system=$1 AND external_id=$2`, [SYS2, ext])).rows[0];
    const copy = (await itemsPool.query(`SELECT name, visibility FROM knowledge WHERE external_system=$1 AND external_id=$2`, [SYS2, ext])).rows[0];
    chk("M2-0 배선 — 미러가 자료(잠김)와 지식 사본을 둘 다 만들었다", mOk.ok && srcRow?.visibility === "members" && !!copy, JSON.stringify({ mOk, srcRow, copy }));
    chk("M2 ★같은 원문의 지식 사본이 그 자료에 이어지고 A 만 본다",
      !!copy && JSON.stringify(await linksOf(copy.name)) === JSON.stringify([`derived_from:${srcRow?.id}`]) && copy.visibility === "members"
      && (await sees(copy.name, A)) && !(await sees(copy.name, OUT)),
      JSON.stringify({ copy, links: copy ? await linksOf(copy.name) : null }));
  }

  // ── E4 저장 중 판이 바뀜 ──
  {
    await mkKnowledge(kname("e4"), C);
    const sOpen4 = await mkSource(false);
    const before = await knowRow(kname("e4"));
    //  연결 행이 들어가는 순간 그 지식의 판을 올린다 — «게이트가 읽은 판» 과 «트랜잭션 안의 판» 사이에 다른 저장이 끼인 장면.
    await itemsPool.query(`CREATE OR REPLACE FUNCTION ${TAG}_bump_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name = '${kname("e4")}' THEN UPDATE knowledge SET version = version + 1 WHERE name = NEW.name; END IF; RETURN NEW; END $$`);
    await itemsPool.query(`CREATE TRIGGER ${TAG}_bump AFTER INSERT ON knowledge_source FOR EACH ROW EXECUTE FUNCTION ${TAG}_bump_fn()`);
    const r = await attempt(() => save({ name: kname("e4"), mode: "append", body_md: "덧붙임", derived_from: [sOpen4] }));
    await itemsPool.query(`DROP TRIGGER IF EXISTS ${TAG}_bump ON knowledge_source`);
    await itemsPool.query(`DROP FUNCTION IF EXISTS ${TAG}_bump_fn()`);
    const after = await knowRow(kname("e4"));
    chk("E4 ★저장 중 판이 바뀌면 409 · 본문·판·연결 그대로(남의 저장을 덮지 않는다)",
      !r.ok && r.status === 409 && after?.body_md === before?.body_md && after?.version === before?.version && (await linksOf(kname("e4"))).length === 0,
      JSON.stringify({ r, before, after }));
  }

  // ── D7 비공개 프로젝트 세션 ──
  {
    const L2 = (await itemsPool.query(`INSERT INTO project_list(name, visibility) VALUES($1,'members') RETURNING id`, [`${TAG}-list2`])).rows[0].id;
    await itemsPool.query(`INSERT INTO project_list_member(list_id, member_id) VALUES($1,$2)`, [L2, A]);
    const P = (await itemsPool.query(`INSERT INTO project(name, list_id) VALUES($1,$2) RETURNING id`, [`${TAG}-proj`, L2])).rows[0].id;
    await itemsPool.query(`INSERT INTO session_project(session_id, project_id) VALUES($1,$2)`, [PROJ_SESSION, P]);
    const r = await attempt(() => save(NEW(kname("d7"), { derived_from: [sA] }), A, PROJ_SESSION));
    chk("D7 ★비공개 프로젝트 세션 + 잠긴 자료로 새 지식 → 409 · 지식 없음", !r.ok && r.status === 409 && r.body?.reason === "project_list" && !(await knowRow(kname("d7"))),
      JSON.stringify(r));
    const sOpen7 = await mkSource(false);
    const r2 = await attempt(() => save(NEW(kname("d7b"), { derived_from: [sOpen7] }), A, PROJ_SESSION));
    chk("D7b 같은 세션 + 열린 자료 → 그 프로젝트 리스트로 잠겨 태어난다", r2.ok && (await knowRow(kname("d7b")))?.visibility === "members"
      && JSON.stringify(await knowLists(kname("d7b"))) === JSON.stringify([Number(L2)]) && (await sees(kname("d7b"), A)) && !(await sees(kname("d7b"), OUT)),
      JSON.stringify({ r2, lists: await knowLists(kname("d7b")) }));
  }

  // ── V2 지식 상세의 조상 제목 ──
  {
    await itemsPool.query(
      `INSERT INTO knowledge(name, title, body_md, provenance, lifecycle, visibility, type) VALUES($1,'잠긴 조상 제목','x','authored','active','members','reference')`,
      [kname("v2-parent")]);
    await itemsPool.query(`INSERT INTO knowledge_member(name, subject_kind, member_id) VALUES($1,'member',$2)`, [kname("v2-parent"), B]);
    await itemsPool.query(
      `INSERT INTO knowledge(name, title, body_md, provenance, lifecycle, visibility, type, parent_name) VALUES($1,$1,'x','authored','active','open','reference',$2)`,
      [kname("v2"), kname("v2-parent")]);
    invalidateVisibilityCache();
    const forOut = await getKnowledge(kname("v2"), OUT);
    const forB = await getKnowledge(kname("v2"), B);
    chk("V2 안 보이는 조상 문서의 제목을 싣지 않는다", (forOut?.ancestors ?? []).length === 0, JSON.stringify(forOut?.ancestors));
    chk("V2b 볼 수 있는 사람에게는 그대로", (forB?.ancestors ?? []).length === 1, JSON.stringify(forB?.ancestors));
  }

  // ── T1 프리셋 레인 문구 이관 ──
  {
    const [mA, mB] = PRESET_TEXT_MIGRATIONS;
    const crit = `## 머리\n${mA.from}\n## 꼬리`;
    const edited = `## 머리\n${mA.from.replace("마라", "말 것")}\n## 꼬리`;
    await itemsPool.query(`INSERT INTO org_distiller(key, criteria_md, format_md) VALUES($1,$2,$3)`, [`${TAG}-old`, crit, `- 출처 ${mB.from}`]);
    await itemsPool.query(`INSERT INTO org_distiller(key, criteria_md, format_md) VALUES($1,$2,NULL)`, [`${TAG}-edited`, edited]);
    const row = async (k) => (await itemsPool.query(`SELECT criteria_md, format_md, version FROM org_distiller WHERE key=$1`, [k])).rows[0];
    const v0 = await row(`${TAG}-old`), e0 = await row(`${TAG}-edited`);
    const m1 = await migrateDistillerPresetText();
    const v1 = await row(`${TAG}-old`), e1 = await row(`${TAG}-edited`);
    chk("T1 글자 그대로 같은 옛 문구는 새 문구로(기준·형식 두 칸) · 판이 오른다",
      v1.criteria_md === `## 머리\n${mA.to}\n## 꼬리` && v1.format_md === `- 출처 ${mB.to}` && Number(v1.version) === Number(v0.version) + 2 && m1.keys.includes(`${TAG}-old`),
      JSON.stringify({ v1, m1 }));
    chk("T1b 사람이 고친 줄은 그대로", e1.criteria_md === e0.criteria_md && Number(e1.version) === Number(e0.version) && !m1.keys.includes(`${TAG}-edited`), JSON.stringify(e1));
    const m2 = await migrateDistillerPresetText();
    chk("T1c 두 번째 실행은 이 레인들을 건드리지 않는다(멱등)", !m2.keys.includes(`${TAG}-old`) && Number((await row(`${TAG}-old`)).version) === Number(v1.version), JSON.stringify(m2));
  }
} catch (e) {
  bad("예외", e?.stack ?? String(e));
} finally {
  await cleanup().catch((e) => console.error("cleanup", e?.message));
  await itemsPool.end().catch(() => {});
}

console.log(`\n${fail ? "✗" : "✓"} derived-visibility: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
