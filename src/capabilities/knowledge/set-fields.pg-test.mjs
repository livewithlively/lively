// knowledge_set_fields — fields(메타데이터)만 고치는 경로가 본문·제목을 건드리지 않고, 동시성·공개범위·미러 규칙을 지키는가.
//  실제 Postgres 필요(기본 유닛 체인 밖). CI 의 pg-test 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=... node src/capabilities/knowledge/set-fields.pg-test.mjs
//
//  왜 이 계층인가: 병합은 잠근 행(FOR UPDATE) 위에서 하고 버전 대조도 그 행으로 한다 — 목으로는 «jsonb 가 돌려준 값 위에
//   병합했나 · 같은 트랜잭션에서 version 을 올렸나 · 감사 행이 남았나» 가 안 보인다. 핸들러를 부르고 DB 를 read-back 한다.
//
//  사양 엣지 표(행마다 단언):
//   F1 중첩 키 하나를 바꾸면 형제 키·무관 최상위 키가 그대로 · 본문·제목·provenance 불변 · version+1 · 감사 set_fields(+change_note)
//   F2 null 은 키를 지운다(중첩·최상위)
//   F3 expected_version 이 지금 판과 다르면 409(current_version) · fields 그대로 / 같으면 반영
//   F4 안 보이는 지식(구성원 전용 · 비대상)은 404 · fields 그대로 / 대상은 고친다 · scope 는 knowledge_save 와 같다(memory 없는 토큰 거절)
//   F5 없는 지식은 404 · 스토어는 잠글 행이 없으면 found:false 를 돌려준다(메시지 문구로 판정하지 않는다)
//   F6 외부 미러(observed)는 400 · fields 그대로
//   F7 바뀌는 게 없는 패치는 저장하지 않는다(changed:false · version 그대로)
//   F8 patch 검증 — 객체 아님·빈 객체·밑줄 예약 키·__proto__(중첩 포함)는 400(MCP 핸들러와 REST 파서 모두) · REST 의 숫자 아닌 expected_version 400
//   F9 외부 원본 좌표가 남은 저작 지식이면 resync_warning 이 온다(좌표 없으면 없다)
//   F10 크기 상한 — 16KiB 넘는 patch 400 · 60KiB fields 에 8KiB 를 더해 64KiB 를 넘기면 400(그대로) · 이미 70KiB 인 fields 의 작은 수정은 통과
//   F11 동시성 — 서로 다른 키 패치 셋을 동시에 보내도 키가 하나도 사라지지 않는다(잠근 행 위 병합 · FOR UPDATE 를 빼면 red)
//   F12 인입 허용선 — update 가 drop·stage·review 면 403 · fields 그대로 / auto 면 반영(검토 큐가 fields 를 못 담는다)
//   F13 휴지통 — set_fields 로 고친 값이 삭제 → 복원 뒤에도 남는다(삭제 스냅샷에 fields 를 싣는다)
//   F14 응답 knowledge 에 본문(body_md)이 없다 — 메타데이터만 돌려준다
import assert from "node:assert/strict";
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { knowledgeSetFields, knowledgeSave } = await import(`${DIST}/capabilities/knowledge/authoring.js`);
const { requireScope } = await import(`${DIST}/context.js`);
const { patchKnowledgeFields, deleteKnowledge, restoreKnowledge } = await import(`${DIST}/v6/knowledge-store.js`);
const { registerEnterprise, _resetEnterpriseForTest } = await import(`${DIST}/enterprise/registry.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n}. ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const P = "ksf-pg-test-";
const DOC = `${P}doc`;          // 전원 공개 · 외부 좌표 없음
const MIRRORED = `${P}mirrored`; // 저작이지만 domain-wiki 좌표가 남은 지식(미러로 들어왔다가 저작으로 바뀐 문서의 모양)
const SECRET = `${P}secret`;    // 구성원 전용
const OBSERVED = `${P}observed`;
const BIG60 = `${P}big60`;      // fields 약 60KiB
const BIG70 = `${P}big70`;      // fields 약 70KiB(상한 64KiB 를 이미 넘음)
const INSIDER = "__ksf_pg_test__in";
const OUTSIDER = "__ksf_pg_test__out";
const BODY = "본문 그대로\n\n두 번째 문단";
const FIELDS = { _item_type: "doc", domain_wiki: { relpath: "knowledge/a.md", code_sot: "old" }, other: { keep: 1 } };

const call = (input, viewer = INSIDER) =>
  knowledgeSetFields.handler(input, { userId: viewer }, { actor: viewer, source: "mcp", viewer });
const attempt = async (input, viewer) => {
  try { return { threw: false, res: await call(input, viewer) }; }
  catch (e) { return { threw: true, status: e?.status, body: e?.body, msg: String(e?.message ?? e) }; }
};
const parse = (name, body) => knowledgeSetFields.expose.rest[0].parse({ params: { name }, body });
const tryParse = (name, body) => {
  try { parse(name, body); return { threw: false }; } catch (e) { return { threw: true, status: e?.status, msg: String(e?.message ?? e) }; }
};
const row = async (name) => (await itemsPool.query(
  `SELECT title, body_md, provenance, version, fields FROM knowledge WHERE name=$1`, [name])).rows[0];

async function cleanup() {
  await itemsPool.query(`DELETE FROM org_content_audit WHERE entity='knowledge' AND entity_key LIKE $1`, [`${P}%`]);
  await itemsPool.query(`DELETE FROM knowledge WHERE name LIKE $1`, [`${P}%`]);   // grant 는 FK CASCADE
}
async function seed() {
  const mk = (name, { visibility = "open", provenance = "authored", ext = null } = {}) => itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, provenance, lifecycle, visibility, fields, external_system, external_instance, external_id)
     VALUES($1, $1, $2, $3, 'active', $4, $5::jsonb, $6, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE $1 END)`,
    [name, BODY, provenance, visibility, JSON.stringify(FIELDS), ext]);
  await mk(DOC);
  await mk(MIRRORED, { ext: "domain-wiki" });
  await mk(SECRET, { visibility: "members" });
  await mk(OBSERVED, { provenance: "observed", ext: "notion" });
  for (const [name, kib] of [[BIG60, 60], [BIG70, 70]]) {
    await mk(name);
    await itemsPool.query(`UPDATE knowledge SET fields=$2::jsonb WHERE name=$1`, [name, JSON.stringify({ blob: "x".repeat(kib * 1024) })]);
  }
  await itemsPool.query(`INSERT INTO knowledge_member(name, subject_kind, member_id) VALUES($1, 'member', $2)`, [SECRET, INSIDER]);
}

try {
  await (await import(`${DIST}/boot/schemas.js`)).initAllSchemas();
  await cleanup();
  await seed();

  {
    const before = await row(DOC);
    const r = await attempt({ name: DOC, patch: { domain_wiki: { code_sot: "new" } }, change_note: "code_sot 정정" });
    chk("F1 성공", !r.threw && r.res.changed === true, JSON.stringify(r));
    const after = await row(DOC);
    chk("F1 형제·무관 키 보존", after.fields.domain_wiki.relpath === "knowledge/a.md" && after.fields.domain_wiki.code_sot === "new"
      && after.fields._item_type === "doc" && after.fields.other.keep === 1 && Object.keys(after.fields).length === 3, JSON.stringify(after.fields));
    chk("F1 본문·제목·provenance 불변", after.body_md === BODY && after.title === DOC && after.provenance === "authored", JSON.stringify(after));
    chk("F1 version+1", Number(after.version) === Number(before.version) + 1, `${before.version} → ${after.version}`);
    chk("F1 응답 knowledge.fields 가 저장값", r.res?.knowledge?.fields?.domain_wiki?.code_sot === "new", JSON.stringify(r.res?.knowledge?.fields));
    chk("F14 응답 knowledge 에 본문이 없다(메타만)", r.res?.knowledge && !("body_md" in r.res.knowledge)
      && Number(r.res.knowledge.version) === Number(after.version) && r.res.knowledge.name === DOC, JSON.stringify(Object.keys(r.res?.knowledge ?? {})));
    const audit = (await itemsPool.query(
      `SELECT before, after FROM org_content_audit WHERE entity='knowledge' AND entity_key=$1 AND op='set_fields' ORDER BY id DESC LIMIT 1`, [DOC])).rows[0];
    chk("F1 감사 set_fields(before·after·change_note)", audit && audit.before.fields.domain_wiki.code_sot === "old"
      && audit.after.fields.domain_wiki.code_sot === "new" && audit.after.change_note === "code_sot 정정", JSON.stringify(audit));
  }
  {
    const r = await attempt({ name: DOC, patch: { domain_wiki: { code_sot: null }, other: null } });
    const f = (await row(DOC)).fields;
    chk("F2 null 은 중첩·최상위 키를 지운다", !r.threw && !("code_sot" in f.domain_wiki) && f.domain_wiki.relpath === "knowledge/a.md"
      && !("other" in f) && f._item_type === "doc", JSON.stringify({ r, f }));
  }
  {
    const cur = Number((await row(DOC)).version);
    const r = await attempt({ name: DOC, patch: { x: 1 }, expected_version: cur - 1 });
    chk("F3 판이 어긋나면 409 · current_version", r.threw && r.status === 409 && r.body?.current_version === cur, JSON.stringify(r));
    chk("F3 fields 그대로", !("x" in (await row(DOC)).fields));
    const r2 = await attempt({ name: DOC, patch: { x: 1 }, expected_version: cur });
    chk("F3 판이 맞으면 반영", !r2.threw && (await row(DOC)).fields.x === 1, JSON.stringify(r2));
  }
  {
    const r = await attempt({ name: SECRET, patch: { domain_wiki: { code_sot: "탈취" } } }, OUTSIDER);
    chk("F4 비대상은 404", r.threw && r.status === 404, JSON.stringify(r));
    chk("F4 fields 그대로", (await row(SECRET)).fields.domain_wiki.code_sot === "old");
    const r2 = await attempt({ name: SECRET, patch: { domain_wiki: { code_sot: "대상" } } }, INSIDER);
    chk("F4 대상은 고친다", !r2.threw && (await row(SECRET)).fields.domain_wiki.code_sot === "대상", JSON.stringify(r2));
    chk("F4 scope 는 knowledge_save 와 같다", knowledgeSetFields.scope === knowledgeSave.scope && knowledgeSetFields.scope === "memory");
    let denied = false;
    try { requireScope({ userId: "x", scopes: ["items", "context"] }, knowledgeSetFields.scope); } catch { denied = true; }
    chk("F4 memory scope 없는 토큰은 거절", denied);
  }
  {
    const r = await attempt({ name: `${P}nope`, patch: { a: 1 } });
    chk("F5 없는 지식은 404", r.threw && r.status === 404, JSON.stringify(r));
    const s = await patchKnowledgeFields(`${P}nope`, { a: 1 }, {}, {});
    chk("F5 스토어는 found:false", s && s.found === false, JSON.stringify(s));
  }
  {
    const r = await attempt({ name: OBSERVED, patch: { a: 1 } });
    chk("F6 observed 는 400", r.threw && r.status === 400, JSON.stringify(r));
    chk("F6 fields 그대로", !("a" in (await row(OBSERVED)).fields));
  }
  {
    const v = Number((await row(DOC)).version);
    const r = await attempt({ name: DOC, patch: { x: 1, nope: null } });
    chk("F7 변화 없는 패치는 changed:false · version 그대로", !r.threw && r.res.changed === false && Number((await row(DOC)).version) === v, JSON.stringify(r));
  }
  {
    const proto = JSON.parse('{"__proto__": {"polluted": 1}}');
    const nestedProto = JSON.parse('{"domain_wiki": {"__proto__": {"x": 1}}}');
    let deep = { leaf: 1 };
    for (let i = 0; i < 40; i++) deep = { d: deep };
    let veryDeep = { leaf: 1 };
    for (let i = 0; i < 5000; i++) veryDeep = { d: veryDeep };
    for (const [label, patch] of [["배열", [1]], ["문자열", "x"], ["null", null], ["빈 객체", {}], ["예약 키", { _item_type: "x" }],
      ["__proto__", proto], ["중첩 __proto__", nestedProto],
      ["커넥터가 읽는 notion 키", { notion: { children_order: ["b", "a"] } }],
      ["값 속 NUL", { a: "x\u0000y" }], ["키 속 짝 없는 서로게이트", { ["k\uD800"]: 1 }], ["유한하지 않은 수", { a: Infinity }],
      ["40단 중첩", deep], ["5000단 중첩(스택 초과 대신 400)", veryDeep]]) {
      const h = await attempt({ name: DOC, patch });
      const p = tryParse(DOC, { patch });
      chk(`F8 ${label} patch → 400(핸들러·REST)`, h.threw && h.status === 400 && p.threw && p.status === 400,
        JSON.stringify({ h: { ...h, msg: h.msg?.slice(0, 120) }, p: { ...p, msg: p.msg?.slice(0, 120) } }));
    }
    chk("F8 거절된 patch 는 fields 를 건드리지 않는다", !("notion" in (await row(DOC)).fields) && !("a" in (await row(DOC)).fields));
    for (const ev of ["abc", true, "0x10", [5], "1e1", 0, -1, 1.5]) {
      const p = tryParse(DOC, { patch: { a: 1 }, expected_version: ev });
      chk(`F8 REST expected_version ${JSON.stringify(ev)} → 400`, p.threw && p.status === 400, JSON.stringify(p));
    }
    chk("F8 REST expected_version 숫자도 받는다", parse(DOC, { patch: { a: 1 }, expected_version: 4 }).expected_version === 4);
    const good = parse(DOC, { patch: { a: 1 }, expected_version: "3", change_note: "n" });
    chk("F8 REST 정상 입력은 그대로 넘긴다", good.name === DOC && good.patch.a === 1 && good.expected_version === 3 && good.change_note === "n", JSON.stringify(good));
  }
  {
    const r = await attempt({ name: MIRRORED, patch: { domain_wiki: { code_sot: "new" } } });
    chk("F9 외부 좌표가 남은 지식은 resync_warning", !r.threw && typeof r.res.resync_warning === "string" && r.res.resync_warning.includes("domain-wiki"), JSON.stringify(r));
    const r2 = await attempt({ name: DOC, patch: { y: 1 } });
    chk("F9 좌표 없으면 resync_warning 없음", !r2.threw && !("resync_warning" in r2.res), JSON.stringify(r2));
  }
  {
    const big = await attempt({ name: DOC, patch: { blob: "y".repeat(16 * 1024 + 1) } });
    chk("F10 16KiB 넘는 patch → 400", big.threw && big.status === 400, JSON.stringify({ ...big, msg: big.msg?.slice(0, 120) }));
    const v60 = Number((await row(BIG60)).version);
    const grow = await attempt({ name: BIG60, patch: { more: "z".repeat(8 * 1024) } });
    chk("F10 60KiB + 8KiB(64KiB 초과) → 400", grow.threw && grow.status === 400, JSON.stringify({ ...grow, msg: grow.msg?.slice(0, 120) }));
    const after60 = await row(BIG60);
    chk("F10 그때 fields·version 그대로", !("more" in after60.fields) && Number(after60.version) === v60);
    const small = await attempt({ name: BIG70, patch: { note: "작은 수정" } });
    chk("F10 이미 70KiB 인 fields 의 작은 수정은 통과", !small.threw && small.res.changed === true && (await row(BIG70)).fields.note === "작은 수정",
      JSON.stringify({ ...small, res: undefined, msg: small.msg?.slice(0, 120) }));
  }
  {
    // 잠금이 없으면 셋이 같은 옛 fields 위에 병합해 마지막 커밋이 나머지 둘의 키를 지운다(순차 호출로는 안 보인다).
    let lost = 0;
    for (let round = 0; round < 5; round++) {
      const keys = ["k0", "k1", "k2"].map((k) => `${k}_${round}`);
      const rs = await Promise.all(keys.map((k) => attempt({ name: DOC, patch: { [k]: round } })));
      const f = (await row(DOC)).fields;
      if (rs.some((r) => r.threw)) bad("F11 동시 패치 실패", JSON.stringify(rs));
      lost += keys.filter((k) => f[k] !== round).length;
    }
    chk("F11 서로 다른 키 동시 패치 3×5 — 사라진 키 0", lost === 0, `사라진 키 ${lost}`);
  }
  {
    const policy = (update) => {
      _resetEnterpriseForTest();
      registerEnterprise({ ingestPolicy: {
        resolveIngestPolicy: () => ({ create: "auto", update, create_rule_id: null, update_rule_id: update === "auto" ? null : 7 }),
        getIngestPolicyRules: async () => [], invalidateIngestPolicyCache() {},
      } });
    };
    try {
      for (const update of ["drop", "stage", "review"]) {
        policy(update);
        const v = Number((await row(DOC)).version);
        const r = await attempt({ name: DOC, patch: { gated: update } });
        const after = await row(DOC);
        chk(`F12 update=${update} → 403 · fields·version 그대로`, r.threw && r.status === 403 && !("gated" in after.fields) && Number(after.version) === v,
          JSON.stringify({ ...r, msg: r.msg?.slice(0, 120) }));
      }
      policy("auto");
      const ok = await attempt({ name: DOC, patch: { gated: "auto" } });
      chk("F12 update=auto → 반영", !ok.threw && (await row(DOC)).fields.gated === "auto", JSON.stringify(ok));
    } finally {
      _resetEnterpriseForTest();
    }
  }
  {
    const TRASHED = `${P}trashed`;
    await itemsPool.query(
      `INSERT INTO knowledge(name, title, body_md, provenance, lifecycle, visibility, fields) VALUES($1, $1, $2, 'authored', 'active', 'open', $3::jsonb)`,
      [TRASHED, BODY, JSON.stringify(FIELDS)]);
    const r = await attempt({ name: TRASHED, patch: { domain_wiki: { code_sot: "사람이 고친 값" } } });
    await deleteKnowledge(TRASHED, { actor: INSIDER, source: "web" });
    // 휴지통 복원은 마지막 delete 감사의 before 스냅샷을 되살린다(capabilities/trash.ts 와 같은 재료).
    const snap = (await itemsPool.query(
      `SELECT before FROM org_content_audit WHERE entity='knowledge' AND entity_key=$1 AND op='delete' ORDER BY id DESC LIMIT 1`, [TRASHED])).rows[0]?.before;
    await restoreKnowledge(snap, { actor: INSIDER, source: "web" });
    const back = await row(TRASHED);
    chk("F13 삭제 → 복원 뒤에도 set_fields 값이 남는다", !r.threw && back?.fields?.domain_wiki?.code_sot === "사람이 고친 값"
      && back.fields.domain_wiki.relpath === "knowledge/a.md" && back.body_md === BODY, JSON.stringify(back?.fields));
    // fields 를 싣기 전에 쌓인 옛 삭제 스냅샷(fields 키 없음)도 복원된다 — 그 경우 fields 는 기본값.
    const { fields: _f, ...legacy } = snap;
    await itemsPool.query(`DELETE FROM knowledge WHERE name=$1`, [TRASHED]);
    await restoreKnowledge(legacy, { actor: INSIDER, source: "web" });
    const legacyBack = await row(TRASHED);
    chk("F13 fields 없는 옛 스냅샷도 복원된다(fields 는 기본값)", legacyBack?.body_md === BODY && JSON.stringify(legacyBack.fields) === "{}",
      JSON.stringify(legacyBack?.fields));
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
