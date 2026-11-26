// 옛 방식 구성원을 역할로 옮기기 (#5799) — org_member_role_plan · org_member_role_apply · addDbSourceMembers(실 Postgres).
//  계획의 규칙은 auth/role-migration.test.ts(순수)가 잰다. 여기는 «실제로 무엇이 저장되나» 다.
//  ⚠ all:true 는 여기서 부르지 않는다 — 같은 DB 를 쓰는 다른 시험의 구성원까지 옮긴다(고르기 규칙은 순수 시험 T15).
//
//  엣지 표:
//   A1 계획 조회                                  → 옛 방식 구성원만(역할 구성원은 없다) · 이름 · 지금 scopes · 역할별 수
//   A2 계획 조회는 아무것도 바꾸지 않는다          → 행 · DB 지정 그대로
//   A3 ids 도 all 도 없음 · 둘 다 줌 · 모르는 id · 이미 역할인 id · ids 가 배열이 아님 → 400 · 아무것도 바뀌지 않는다
//   A4 기본 다섯 구성원을 옮김                     → role='member' · grants={} · scopes 사본 다섯 · «모든 소스»('*')에 조회 대상으로 지정(소스마다 적지 않는다)
//   A5 옮긴 뒤의 판정                              → 세션에 새 권한이 실린다 · 지정된 소스는 열리고(dbSourceAllowed) 조회가 끊기지 않는다
//   A6 db 가 없던 구성원                           → 소스에 지정되지 않는다
//   A7 권한이 없는 구성원을 ids 로 줌              → skipped · 행 그대로
//   A8 keep                                       → 구성원 + 코드 고치기(개별 권한) · scopes 사본에 변화 없음
//   A9 admin + runtime 구성원                      → 소유자 · 관리 권한 없는 사람은 계획도 적용도 못 부른다(403 판정)
//   A10 같은 구성원을 다시 옮김                    → 400(이미 역할)
//   A11 이미 있던 지정(다른 구성원 · 팀)은 그대로   → 더하기만 한다 · 다시 더하면 0건
//   A13 옮긴 뒤에 등록한 소스                      → 옛 db 가 있던 구성원은 그것도 조회한다(«모든 소스») · db 가 없던 구성원은 못 본다
//   A14 내장 self 소스                             → «모든 소스» 로 지정된 구성원은 조회한다(옛 db 가 self 도 열었다) · 지정 없는 구성원은 못 본다
//   A15 자동 이관(sweepLegacyMembers)              → 잃는 것 없이(코드 고치기를 개별 권한으로 · 이전 scopes 가 전부 사본에 남는다) · 권한 없는 구성원은 그대로 · 다시 돌리면 0명 · 끄면(LIVELY_ROLE_MIGRATION=off) 0명
//   A16 «모든 소스» 지정 API                       → name '*' 로 읽고 쓴다(등록된 소스가 아니어도 404 가 아니다) · 모르는 소스 이름은 여전히 404
//   A12 items·context 뿐인 구성원                  → 게스트 + 개별 권한(직접 고른 권한) · 세션 권한이 종전과 같다(수집 · 증류 · 세션 없음)

const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const store = await import(`${DIST}/org/store.js`);
const memberCaps = await import(`${DIST}/capabilities/delivery/members.js`);
const G = await import(`${DIST}/org/store/db-source-grants.js`);
const { createSession, userFromSession } = await import(`${DIST}/auth/sessions.js`);
const { registry, capAllowed } = await import(`${DIST}/capabilities/index.js`);
const { ROLE_GRANTS } = await import(`${DIST}/auth/permissions.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const J = (x) => JSON.stringify(x);
const sameObj = (a, b) => J(Object.entries(a ?? {}).sort()) === J(Object.entries(b ?? {}).sort());
const sameSet = (a, b) => J([...(a ?? [])].sort()) === J([...b].sort());
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const capOf = (name) => memberCaps.membersCapabilities.find((c) => c.name === name);

const P = "__rolemig_pg_test__";
const SRC = `${P}crm`;
const FIVE = ["items", "context", "memory", "db", "code"];
const admin = { userId: `${P}root`, email: "", scopes: [...FIVE, "admin", "runtime"], projects: ["*"], tokenSource: "session" };
const planCap = capOf("org_member_role_plan"), applyCap = capOf("org_member_role_apply");
const plan = (input = {}) => planCap.handler(input, admin, { source: "web" });
const apply = (input) => applyCap.handler(input, admin, { source: "web" });
const row = async (id) => (await itemsPool.query(`SELECT role, grants, scopes FROM org_member WHERE id=$1`, [id])).rows[0] ?? null;
const designated = async (src) => (await G.listDbSourceGrants(src)).map((r) => `${r.subject_kind}:${r.subject_id}`).sort();
const session = async (id) => userFromSession((await createSession(id, { ip: "127.0.0.1", userAgent: "pgtest" })).sessionId);

async function cleanup() {
  await itemsPool.query(`DELETE FROM org_db_source_grant WHERE source LIKE $1 OR subject_id LIKE $1`, [`${P}%`]);
  await itemsPool.query(`DELETE FROM org_db_source WHERE name LIKE $1`, [`${P}%`]);
  await itemsPool.query(`DELETE FROM web_session WHERE member_id LIKE $1`, [`${P}%`]).catch(() => {});
  await itemsPool.query(`DELETE FROM person_identity WHERE member_id LIKE $1`, [`${P}%`]).catch(() => {});
  await itemsPool.query(`DELETE FROM org_member WHERE id LIKE $1`, [`${P}%`]);
}

await cleanup();
try {
  const five = `${P}five`, three = `${P}three`, none = `${P}none`, keep = `${P}keep`, boss = `${P}boss`, two = `${P}two`, already = `${P}already`, other = `${P}other`;
  await store.upsertMember({ id: five, display_name: "Five", scopes: FIVE }, "pgt");
  await store.upsertMember({ id: three, display_name: "Three", scopes: ["items", "context", "memory"] }, "pgt");
  await store.upsertMember({ id: none, display_name: "None", kind: "system", scopes: [] }, "pgt");
  await store.upsertMember({ id: keep, display_name: "Keep", scopes: FIVE }, "pgt");
  await store.upsertMember({ id: boss, display_name: "Boss", scopes: ["items", "context", "memory", "admin", "runtime"] }, "pgt");
  await store.upsertMember({ id: two, display_name: "Two", scopes: ["items", "context"] }, "pgt");
  await store.upsertMember({ id: already, display_name: "Already", role: "member" }, "pgt");
  await store.upsertMember({ id: other, display_name: "Other", role: "member" }, "pgt");
  await store.upsertDbSource({ name: SRC, url: "postgres://u:p@127.0.0.1:1/none" }, "pgt");
  await G.setDbSourceGrants(SRC, [{ kind: "member", id: other }, { kind: "team", id: "999999" }], "pgt");

  // ── A1 · A2 계획 ──
  const p1 = await plan();
  const mine = (v) => v.members.filter((m) => m.id.startsWith(P));
  const byId = (v) => Object.fromEntries(mine(v).map((m) => [m.id, m]));
  const b1 = byId(p1);
  chk("A1a 계획에는 옛 방식 구성원만 있다", !b1[already] && !b1[other] && !!b1[five] && !!b1[none], J(Object.keys(b1)));
  chk("A1b 구성원마다 이름 · 지금 scopes · 옮길 역할", b1[five].display_name === "Five" && sameSet(b1[five].scopes, FIVE) && b1[five].role === "member" && b1[boss].role === "owner"
    && b1[two].role === "guest" && b1[two].custom === true && b1[none].role === null && b1[none].skip === "no-permissions", J([b1[five], b1[two], b1[none]]));
  chk("A1c 기본 다섯 — 잃는 것은 코드 고치기 · «모든 소스» 로 지정 예정 · db 가 없던 구성원은 지정 없음",
    J(b1[five].losses) === J([{ perm: "code", from: "write", to: "read" }]) && J(b1[five].db_sources) === J(["*"]) && J(b1[three].db_sources) === "[]", J(b1[five]));
  chk("A1d 역할별 수가 목록과 맞다", p1.total === p1.members.length && p1.movable === p1.members.filter((m) => m.role).length
    && Object.values(p1.counts).reduce((a, b) => a + b, 0) === p1.total, J({ total: p1.total, movable: p1.movable, counts: p1.counts }));
  const r2 = await row(five);
  chk("A2 계획 조회는 아무것도 바꾸지 않는다", r2.role === null && sameSet(r2.scopes, FIVE) && sameSet(await designated(SRC), [`member:${other}`, "team:999999"]), J(r2));

  // ── A3 거절 ──
  const e3 = [
    await errOf(apply({})), await errOf(apply({ ids: [five], all: true })), await errOf(apply({ ids: [five, `${P}nope`] })),
    await errOf(apply({ ids: [already] })), await errOf(apply({ ids: five })), await errOf(apply({ ids: [] })),
  ];
  chk("A3a 잘못된 요청은 모두 400", e3.every((e) => e?.status === 400), J(e3.map((e) => e?.status ?? String(e))));
  const r3 = await row(five);
  chk("A3b 거절된 요청은 아무것도 옮기지 않는다(목록에 모르는 id 가 섞여도)", r3.role === null && sameSet(await designated(SRC), [`member:${other}`, "team:999999"]), J(r3));

  // ── A4 · A5 · A6 · A7 옮기기 ──
  const a4 = await apply({ ids: [five, three, none] });
  const r4 = await row(five);
  chk("A4a 기본 다섯 → 구성원 역할 · 개별 권한 없음 · scopes 사본 다섯", r4.role === "member" && J(r4.grants) === "{}" && sameSet(r4.scopes, FIVE), J(r4));
  chk("A4b 응답 — 옮긴 사람 · 건너뛴 사람 · 더한 지정 수", sameSet(a4.moved.map((m) => m.id), [five, three]) && J(a4.skipped) === J([{ id: none, reason: "no-permissions" }]) && a4.db_grants_added === 1, J(a4));
  const d4 = await designated("*");
  const mine4 = d4.filter((x) => x.includes(P));
  chk("A4c «모든 소스» 에 지정됐다 · 소스마다의 지정은 그대로다", sameSet(mine4, [`member:${five}`]) && sameSet(await designated(SRC), [`member:${other}`, "team:999999"]), J([mine4, await designated(SRC)]));
  chk("A4d 내장 self 는 따로 지정하지 않는다(«모든 소스» 지정이 연다 — A14)", (await designated("self")).every((x) => !x.includes(P)), J(await designated("self")));
  const s5 = await session(five);
  chk("A5a 옮긴 구성원의 세션에 새 권한이 실린다", !!s5?.grants && sameObj(s5.grants, ROLE_GRANTS.member), J(s5?.grants));
  chk("A5b 조회가 끊기지 않는다 — 소스가 열려 있다", (await G.dbSourceAllowed(s5, SRC)) === true, "");
  const r6 = await row(three);
  chk("A6 db 가 없던 구성원은 역할만 받고 소스에 지정되지 않는다", r6.role === "member" && !d4.includes(`member:${three}`) && (await G.dbSourceAllowed(await session(three), SRC)) === false, J(r6));
  const r7 = await row(none);
  chk("A7 권한이 없는 구성원은 그대로다", r7.role === null && r7.grants === null && J(r7.scopes) === "[]", J(r7));

  // ── A8 keep ──
  const pk = byId(await plan({ keep: "1" }))[keep];
  chk("A8a keep 계획 — 잃는 것이 없고 코드 고치기를 얹는다", J(pk.losses) === "[]" && J(pk.grants) === J({ code: "write" }), J(pk));
  await apply({ ids: [keep], keep: true });
  const r8 = await row(keep);
  chk("A8b keep 적용 — 구성원 + 코드 고치기", r8.role === "member" && sameObj(r8.grants, { code: "write" }) && sameSet(r8.scopes, FIVE), J(r8));

  // ── A9 소유자 · 호출 권한 ──
  await apply({ ids: [boss] });
  const r9 = await row(boss);
  chk("A9a admin + runtime → 소유자", r9.role === "owner" && J(r9.grants) === "{}" && sameSet(r9.scopes, [...FIVE, "admin", "runtime"]), J(r9));
  const regPlan = registry.get("org_member_role_plan"), regApply = registry.get("org_member_role_apply");
  chk("A9b 구성원 역할은 계획도 적용도 못 부른다 · 관리자 역할은 계획을 보고 적용한다",
    !!regPlan && !!regApply && capAllowed(s5, regPlan) === false && capAllowed(s5, regApply) === false
    && capAllowed({ ...s5, grants: ROLE_GRANTS.admin }, regPlan) === true && capAllowed({ ...s5, grants: ROLE_GRANTS.admin }, regApply) === true
    && capAllowed({ ...s5, grants: { ...ROLE_GRANTS.member, admin: "read" } }, regPlan) === true
    && capAllowed({ ...s5, grants: { ...ROLE_GRANTS.member, admin: "read" } }, regApply) === false, "");
  chk("A9c 옛 방식 주체 — admin scope 가 있어야 한다", capAllowed({ userId: "u", scopes: FIVE }, regApply) === false && capAllowed(admin, regApply) === true, "");

  // ── A10 · A11 다시 ──
  const e10 = await errOf(apply({ ids: [five] }));
  chk("A10 이미 옮긴 구성원을 다시 옮기면 400", e10?.status === 400 && /이미 역할/.test(e10.message), String(e10?.message));
  chk("A11 지정 더하기는 멱등이다", (await G.addDbSourceMembers("*", [five, five], "pgt")) === 0 && (await G.addDbSourceMembers("*", [], "pgt")) === 0
    && sameSet((await designated("*")).filter((x) => x.includes(P)), [`member:${five}`, `member:${keep}`]), J(await designated("*")));

  // ── A13 · A14 나중에 등록한 소스 · 내장 self ──
  const SRC2 = `${P}erp`;
  await store.upsertDbSource({ name: SRC2, url: "postgres://u:p@127.0.0.1:1/none" }, "pgt");
  const s13 = await session(five), s13b = await session(three);
  chk("A13 옮긴 뒤에 등록한 소스도 조회한다 · db 가 없던 구성원은 못 본다", (await G.dbSourceAllowed(s13, SRC2)) === true && (await G.dbSourceAllowed(s13b, SRC2)) === false, "");
  chk("A14 내장 self — «모든 소스» 로 지정된 구성원은 조회한다 · 지정 없는 구성원은 못 본다", (await G.dbSourceAllowed(s13, "self")) === true && (await G.dbSourceAllowed(s13b, "self")) === false, "");
  chk("A14b DB 조회 자격이 없는 주체는 지정이 있어도 못 본다(토큰으로 좁아진 경우)", (await G.dbSourceAllowed({ ...s13, grants: { ...s13.grants, db: undefined } }, SRC2)) === false
    && (await G.dbSourceAllowed({ ...s13, dbSourceCeiling: [SRC] }, SRC2)) === false && (await G.dbSourceAllowed({ ...s13, dbSourceCeiling: [SRC] }, SRC)) === true, "");

  // ── A16 «모든 소스» 지정 API ──
  const dbCaps = (await import(`${DIST}/capabilities/delivery/db-sources.js`));
  const dcap = (name) => Object.values(dbCaps).flat().find((c) => c && c.name === name);
  const setAll = await dcap("org_db_source_access_set").handler({ name: "*", members: [five, keep, three], teams: [] }, admin, { source: "web" });
  const getAll = await dcap("org_db_source_access").handler({ name: "*" }, admin, { source: "web" });
  const e16 = await errOf(dcap("org_db_source_access_set").handler({ name: `${P}nope`, members: [], teams: [] }, admin, { source: "web" }));
  chk("A16 name '*' 로 읽고 쓴다 · 모르는 소스 이름은 404", setAll.source === "*" && setAll.members.includes(three) && J(getAll.access?.[0]?.source) === J("*") && e16?.status === 404
    && (await G.dbSourceAllowed(s13b, SRC2)) === true, J([setAll, getAll.access?.[0], e16?.status]));
  await dcap("org_db_source_access_set").handler({ name: "*", members: [five, keep], teams: [] }, admin, { source: "web" });

  // ── A15 자동 이관 ──
  const { sweepLegacyMembers } = await import(`${DIST}/org/role-migration-apply.js`);
  const a1 = `${P}auto1`, a2 = `${P}auto2`, a3 = `${P}auto3`;
  await store.upsertMember({ id: a1, display_name: "Auto1", scopes: FIVE }, "pgt");
  await store.upsertMember({ id: a2, display_name: "Auto2", scopes: [...FIVE, "admin"] }, "pgt");
  await store.upsertMember({ id: a3, display_name: "Auto3", kind: "system", scopes: [] }, "pgt");
  const only = (id) => id.startsWith(`${P}auto`);
  const off = await sweepLegacyMembers({ LIVELY_ROLE_MIGRATION: "off" }, { only });
  chk("A15a 끄면 옮기지 않는다", off.moved === 0 && (await row(a1)).role === null, J(off));
  const swept = await sweepLegacyMembers({}, { only });
  const ra1 = await row(a1), ra2 = await row(a2), ra3 = await row(a3);
  chk("A15b 자동 이관 — 잃는 것 없이(구성원 + 코드 고치기 · 관리자 + 자격 고치기)", swept.moved === 2 && ra1.role === "member" && sameObj(ra1.grants, { code: "write" })
    && ra2.role === "admin" && sameObj(ra2.grants, { secrets: "write" }), J([swept, ra1, ra2]));
  chk("A15c 이전 scopes 가 전부 사본에 남는다 · 권한 없는 구성원은 그대로", FIVE.every((x) => ra1.scopes.includes(x)) && [...FIVE, "admin"].every((x) => ra2.scopes.includes(x)) && ra3.role === null && J(ra3.scopes) === "[]", J([ra1.scopes, ra2.scopes, ra3]));
  chk("A15d 옛 db 는 «모든 소스» 로 이어진다 — 나중에 등록한 소스도 본다", (await G.dbSourceAllowed(await session(a1), SRC2)) === true, "");
  chk("A15e 다시 돌리면 옮길 사람이 없다", (await sweepLegacyMembers({}, { only })).moved === 0, "");

  // ── A12 직접 고른 권한 ──
  await apply({ ids: [two] });
  const r12 = await row(two);
  const s12 = await session(two);
  chk("A12a items·context 뿐 → 게스트 + 개별 권한", r12.role === "guest" && sameObj(r12.grants, { content: "write", external: "write", code: "write", run: "write" }), J(r12));
  chk("A12b 그 세션 권한 — 수집 · 증류와 세션을 새로 얻지 않는다", !!s12?.grants && s12.grants.content === "write" && !s12.grants.pipeline && !s12.grants.session && !s12.grants.db, J(s12?.grants));
  const left = mine(await plan());
  chk("A12c 남은 옛 방식 구성원은 권한 없는 구성원뿐(옮길 사람 0명)", left.every((m) => m.role === null && m.skip === "no-permissions") && sameSet(left.map((m) => m.id), [none, `${P}auto3`]), J(left.map((m) => m.id)));
} catch (e) {
  bad("예외", String(e?.stack || e));
} finally {
  await cleanup();
  await itemsPool.end().catch(() => {});
}
console.log(`\nrole-migration.pg-test: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
