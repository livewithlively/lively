// 팀이 주는 권한 (#5799) — 저장 · 구성원 읽기 · 웹 세션 · 토큰 · 거절(실 Postgres).
//  합치는 규칙은 auth/team-access.test.ts(순수)가 잰다. 여기는 «팀에 실은 권한이 실제 주체에 닿는가 · 누가 실을 수 있는가» 다.
//
//  엣지 표:
//   P1 관리자가 팀에 역할을 실음                   → 팀 행에 저장 · 그 팀의 역할 구성원을 읽으면 team_access 에 실린다 · 옛 방식 팀원은 빈 배열
//   P2 게스트가 구성원 역할 팀에 있음              → 웹 세션의 권한 = 구성원 역할 · scopes 다섯 · 지식 저장이 열린다 · 저장된 scopes 사본은 그대로([])
//   P3 그 구성원의 로그인 토큰(비위험 권한 추종)    → 팀이 준 비위험 권한을 따른다 · 관리 권한 팀이어도 토큰에 admin 이 없으면 관리는 실리지 않는다
//   P4 팀을 보관함                                 → 더 주지 않는다
//   P5 팀에서 뺌                                   → 바로 잃는다
//   P6 팀을 삭제함                                 → 잃는다
//   P7 관리 권한 없는 사람이 팀에 권한을 실으려 함  → 403 · 저장되지 않는다(옛 방식 context 구성원 · 팀 편집이 아직 열려 있던 조직에서도)
//   P8 관리자 역할(하네스 설정 고치기 없음)         → 소유자 역할 · 하네스 설정 고치기는 못 싣는다(403) · 관리자 역할 · 코드 고치기는 싣는다
//   P9 소유자 권한 팀에 사람을 새로 넣기            → 하네스 설정 고치기 없는 관리자는 못 넣는다(403) · 있던 팀원 유지 · 빼기는 된다
//   P10 팀에 권한이 실리면 팀 편집은 관리자만       → 옛 방식 context 구성원의 팀원 바꾸기가 403(빼기만 하는 저장도 — 위험 권한 규칙과 따로 잰다)
//   P11 잘못된 입력                                → 모르는 역할 · 모르는 권한 · 모르는 수준 · 객체가 아님 = 400
//   P12 권한 칸을 주지 않은 저장은 권한을 지킨다 · access_grants null · access_role null 은 비운다 · 준 칸만 바꾼다
//   P13 역할을 걷으면(role:null)                   → 저장된 scopes 로 돌아간다(팀이 부풀린 값이 굳지 않는다)
//   P14 권한을 실어 팀을 만들려는 비관리자          → 403 · 팀이 생기지 않는다
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const store = await import(`${DIST}/org/store.js`);
const { teamCapabilities } = await import(`${DIST}/capabilities/teams.js`);
const { createSession, userFromSession } = await import(`${DIST}/auth/sessions.js`);
const { verifyDbToken } = await import(`${DIST}/org/store/tokens.js`);
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
const tcap = (name) => teamCapabilities.find((c) => c.name === name);

const P = "__teamacc_pg_test__";
const TK = "teamaccpgtest";
const FIVE = ["items", "context", "memory", "db", "code"];
const owner = { userId: `${P}root`, email: "", scopes: [...FIVE, "admin", "runtime"], projects: ["*"], tokenSource: "session" };
const adminRole = { userId: `${P}adm`, email: "", scopes: [...FIVE, "admin"], grants: ROLE_GRANTS.admin, projects: ["*"], tokenSource: "session" };
const legacyCtx = { userId: `${P}ctx`, email: "", scopes: ["items", "context", "memory"], projects: ["*"], tokenSource: "session" };
const create = (input, by = owner) => tcap("team_create").handler(input, by, { source: "web" });
const update = (input, by = owner) => tcap("team_update").handler(input, by, { source: "web" });
const setMembers = (id, ids, by = owner) => tcap("team_set_members").handler({ id, members: ids.map((member_id) => ({ member_id })) }, by, { source: "web" });
const del = (id, by = owner) => tcap("team_delete").handler({ id }, by, { source: "web" });
const teamRow = async (id) => (await itemsPool.query(`SELECT access_role, access_grants, state, name FROM team WHERE id=$1`, [id])).rows[0] ?? null;
const session = async (id) => userFromSession((await createSession(id, { ip: "127.0.0.1", userAgent: "pgtest" })).sessionId);

async function cleanup() {
  await itemsPool.query(`DELETE FROM team WHERE key LIKE $1`, [`${TK}%`]);
  await itemsPool.query(`DELETE FROM web_session WHERE member_id LIKE $1`, [`${P}%`]).catch(() => {});
  await itemsPool.query(`DELETE FROM auth_token WHERE user_id LIKE $1 OR member_id LIKE $1`, [`${P}%`]);
  await itemsPool.query(`DELETE FROM person_identity WHERE member_id LIKE $1`, [`${P}%`]).catch(() => {});
  await itemsPool.query(`DELETE FROM org_member WHERE id LIKE $1`, [`${P}%`]);
}

await cleanup();
try {
  const g = `${P}guest`, old = `${P}old`, mem = `${P}mem`, extra = `${P}extra`;
  await store.upsertMember({ id: g, display_name: "G", role: "guest" }, "pgt");
  await store.upsertMember({ id: old, display_name: "Old", scopes: ["items"] }, "pgt");
  await store.upsertMember({ id: mem, display_name: "M", role: "member" }, "pgt");
  await store.upsertMember({ id: extra, display_name: "X", role: "member" }, "pgt");

  // ── P14 · P7 · P11 거절 ──
  const e14 = await errOf(create({ key: `${TK}-nope`, name: "nope", access_role: "member" }, legacyCtx));
  const made14 = (await itemsPool.query(`SELECT 1 FROM team WHERE key=$1`, [`${TK}-nope`])).rowCount;
  chk("P14 비관리자는 권한을 실어 팀을 만들 수 없다 · 팀이 생기지 않는다", e14?.status === 403 && made14 === 0, J([e14?.status, made14]));
  const t1 = (await create({ key: `${TK}-all`, name: "전체" })).team;
  const e7 = await errOf(update({ id: t1.id, access_role: "member" }, legacyCtx));
  const r7 = await teamRow(t1.id);
  chk("P7 관리 권한 없는 사람은 팀에 권한을 싣지 못한다 · 저장되지 않는다", e7?.status === 403 && r7.access_role === null && r7.access_grants === null, J([e7?.status, r7]));
  const parse = (b) => tcap("team_update").expose.rest[0].parse({ params: { id: String(t1.id) }, body: b });
  const e11 = [() => parse({ access_role: "boss" }), () => parse({ access_grants: { zzz: "write" } }), () => parse({ access_grants: { code: "admin" } }), () => parse({ access_grants: ["code"] })]
    .map((f) => { try { f(); return null; } catch (e) { return e?.status; } });
  chk("P11 잘못된 입력은 400", J(e11) === J([400, 400, 400, 400]), J(e11));
  chk("P11b 권한 칸이 없는 요청은 권한을 건드리지 않는 입력이 된다", !("access_role" in parse({ name: "x" })) && !("access_grants" in parse({ name: "x" })) && parse({ access_role: "" }).access_role === null && J(parse({ access_grants: null }).access_grants) === "{}", J(parse({ name: "x" })));

  // ── P1 · P2 · P3 싣기 ──
  await update({ id: t1.id, access_role: "member" });
  await setMembers(t1.id, [g, old]);
  const r1 = await teamRow(t1.id);
  const mg = await store.getMember(g), mo = await store.getMember(old);
  chk("P1a 팀 행에 역할이 저장된다", r1.access_role === "member" && r1.access_grants === null, J(r1));
  chk("P1b 역할 구성원을 읽으면 team_access 에 실린다 · 옛 방식 팀원은 빈 배열",
    J(mg.team_access) === J([{ team_id: t1.id, name: "전체", role: "member", grants: {} }]) && J(mo.team_access) === "[]", J([mg.team_access, mo.team_access]));
  const s2 = await session(g);
  chk("P2a 게스트의 웹 세션 권한 = 구성원 역할", !!s2 && sameObj(s2.grants, ROLE_GRANTS.member), J(s2?.grants));
  chk("P2b scopes 도 다섯 · 지식 저장이 열린다 · 구성원 관리는 닫혀 있다", sameSet(s2.scopes, FIVE) && capAllowed(s2, registry.get("knowledge_save")) === true && capAllowed(s2, registry.get("org_member_upsert")) === false, J(s2.scopes));
  chk("P2c 저장된 scopes 사본은 그대로다", J(mg.scopes) === "[]", J(mg.scopes));
  const so = await session(old);
  chk("P1c 옛 방식 팀원의 세션은 종전 그대로", !!so && !("grants" in so) && sameSet(so.scopes, ["items"]), J(so));
  const tok = await store.mintToken({ userId: g, memberId: g, scopes: [], followSafeScopes: true }, "pgt");
  const v3 = await verifyDbToken(tok.token);
  chk("P3a 로그인 토큰이 팀이 준 비위험 권한을 따른다", !!v3?.grants && v3.grants.content === "write" && v3.grants.code === "read" && !v3.grants.admin, J(v3?.grants));
  await update({ id: t1.id, access_role: "admin" });
  const v3b = await verifyDbToken(tok.token);
  const s3 = await session(g);
  chk("P3b 관리자 역할 팀 — 세션은 관리를 얻고(scopes 에 admin), 관리를 굽지 않은 토큰은 얻지 못한다",
    s3.grants.admin === "write" && s3.scopes.includes("admin") && !v3b.grants.admin && !v3b.scopes.includes("admin"), J([s3.grants, v3b.grants, v3b.scopes]));

  // ── P12 준 칸만 바꾼다 ──
  await update({ id: t1.id, name: "전체2" });
  const r12a = await teamRow(t1.id);
  await update({ id: t1.id, access_grants: { code: "write" } });
  const r12b = await teamRow(t1.id);
  await update({ id: t1.id, access_role: null });
  const r12c = await teamRow(t1.id);
  await update({ id: t1.id, access_grants: {} });
  const r12d = await teamRow(t1.id);
  await update({ id: t1.id, access_grants: { db: "read" } });
  await update({ id: t1.id, access_grants: null });
  const r12e = await teamRow(t1.id);
  chk("P12b access_grants null 은 비운다", r12e.access_grants === null && r12e.access_role === null, J(r12e));
  chk("P12 권한 칸을 주지 않은 저장은 권한을 지키고, 준 칸만 바꾼다",
    r12a.access_role === "admin" && r12a.name === "전체2" && r12b.access_role === "admin" && sameObj(r12b.access_grants, { code: "write" })
    && r12c.access_role === null && sameObj(r12c.access_grants, { code: "write" }) && r12d.access_role === null && r12d.access_grants === null, J([r12a, r12b, r12c, r12d]));

  // ── P4 · P5 · P6 거두기 ──
  await update({ id: t1.id, access_role: "member" });
  await update({ id: t1.id, state: "archived" });
  const s4 = await session(g);
  chk("P4 보관한 팀은 더 주지 않는다", sameObj(s4.grants, ROLE_GRANTS.guest) && J(s4.scopes) === "[]", J(s4.grants));
  await update({ id: t1.id, state: "active" });
  chk("P4b 되살리면 다시 준다", sameObj((await session(g)).grants, ROLE_GRANTS.member), "");
  await setMembers(t1.id, [old]);
  chk("P5 팀에서 빼면 바로 잃는다", sameObj((await session(g)).grants, ROLE_GRANTS.guest), "");
  await setMembers(t1.id, [g, old]);
  await del(t1.id);
  chk("P6 팀을 삭제하면 잃는다", sameObj((await session(g)).grants, ROLE_GRANTS.guest) && J((await store.getMember(g)).team_access) === "[]", "");

  // ── P8 · P9 위험 권한 ──
  const t2 = (await create({ key: `${TK}-ops`, name: "운영" })).team;
  const e8 = [
    await errOf(update({ id: t2.id, access_role: "owner" }, adminRole)),
    await errOf(update({ id: t2.id, access_grants: { harness: "write" } }, adminRole)),
    await errOf(update({ id: t2.id, access_grants: { secrets: "write" } }, adminRole)),
  ];
  const r8 = await teamRow(t2.id);
  chk("P8a 관리자 역할은 소유자 역할 · 하네스 설정 · 자격 고치기를 팀에 싣지 못한다", e8.every((e) => e?.status === 403) && r8.access_role === null && r8.access_grants === null, J([e8.map((e) => e?.status), r8]));
  await update({ id: t2.id, access_role: "admin", access_grants: { code: "write", harness: "read" } }, adminRole);
  const r8b = await teamRow(t2.id);
  chk("P8b 관리자 역할 · 코드 고치기 · 하네스 설정 보기는 싣는다", r8b.access_role === "admin" && sameObj(r8b.access_grants, { code: "write", harness: "read" }), J(r8b));
  await update({ id: t2.id, access_role: "owner", access_grants: {} });
  await setMembers(t2.id, [mem]);
  const e9 = await errOf(setMembers(t2.id, [mem, extra], adminRole));
  const still = (await store.getMember(extra)).team_access;
  chk("P9a 하네스 설정 고치기 없는 관리자는 소유자 권한 팀에 사람을 새로 넣지 못한다", e9?.status === 403 && J(still) === "[]", J([e9?.status, still]));
  const keep9 = await errOf(setMembers(t2.id, [mem], adminRole));
  const drop9 = await errOf(setMembers(t2.id, [], adminRole));
  chk("P9b 있던 팀원을 그대로 두거나 빼는 것은 된다", keep9 === null && drop9 === null && J((await store.getMember(mem)).team_access) === "[]", J([String(keep9), String(drop9)]));
  await setMembers(t2.id, [mem, extra]);
  chk("P9c 소유자는 넣을 수 있다 · 넣으면 소유자 권한을 받는다", sameObj((await session(extra)).grants, ROLE_GRANTS.owner), "");

  // ── P10 팀 편집 게이트 ──
  //  새로 넣는 사람이 없는 저장으로 잰다(팀원 빼기) — 새로 넣으면 위험 권한 규칙(P9)이 먼저 거절해서 게이트를 재지 못한다.
  const e10 = await errOf(setMembers(t2.id, [mem], legacyCtx));
  const left10 = (await store.getMember(extra)).team_access.length;
  chk("P10 팀에 권한이 실린 조직에서 팀 편집은 관리자만(팀원 빼기도)", e10?.status === 403 && left10 === 1, J([e10?.status, left10]));

  // ── P13 역할을 걷으면 ──
  const t3 = (await create({ key: `${TK}-adm`, name: "관리", access_role: "admin" })).team;
  await setMembers(t3.id, [g]);
  chk("P13a 권한을 실어 만든 팀", (await teamRow(t3.id)).access_role === "admin" && (await session(g)).scopes.includes("admin"), "");
  await store.upsertMember({ id: g, role: null }, "pgt");
  const m13 = await store.getMember(g);
  const s13 = await session(g);
  chk("P13b 역할을 걷으면 저장된 scopes 로 돌아간다(팀이 준 admin 이 굳지 않는다)", m13.role === null && J(m13.scopes) === "[]" && !("grants" in s13) && J(s13.scopes) === "[]", J([m13.scopes, s13.scopes]));
} catch (e) {
  bad("예외", String(e?.stack || e));
} finally {
  await cleanup();
  await itemsPool.end().catch(() => {});
}
console.log(`\nteam-access.pg-test: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
