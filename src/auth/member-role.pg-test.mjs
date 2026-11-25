// 역할 저장과 로그인 경로 (#5799) — 역할을 받은 구성원만 새 권한으로 판정받는가. **실제 Postgres 필요**(run-tests --pg).
//    npm run build && ITEMS_DATABASE_URL=… node src/auth/member-role.pg-test.mjs
//  목으로는 못 보는 것을 본다: 행에 실제로 적히는 값(role · grants · scopes 사본), 웹 세션 · 토큰이 싣는 권한, 그 권한으로 관문이 여닫히는 것.
//
//  엣지 표:
//   G1 옛 구성원(역할 없음)                       → 행의 role NULL · 세션/토큰 주체에 grants 칸이 없다 · 판정은 종전 scope 그대로
//   G2 org_member_upsert 로 역할(guest)을 줌       → role='guest' · grants={} · scopes 사본 [] · 다시 읽어도 같다
//   G3 게스트의 웹 세션                            → grants={content:read} · 지식 조회는 열리고 저장은 닫힌다 · 세션(브라우저 도구)은 없다
//   G4 구성원 역할 + 개별 권한(code write)         → scopes 사본에 다섯 개 · 레포 등록이 열린다 · 구성원 관리는 닫힌다
//   G5 로그인 토큰(비위험 권한 추종)               → 구성원 역할을 따른다(하네스 설정 보기 포함) · 관리 권한은 실리지 않는다
//   G6 관리자가 scope 를 골라 구운 토큰([memory])  → 구성원 ∩ 그 상한(맥락 · 수집 · 증류 · 세션만) · 코드 조회는 닫힌다
//   G7 구성원을 게스트로 내리면                    → 이미 발급된 토큰이 즉시 따라 내려간다
//   G8 역할을 걷으면(null)                         → role NULL · 주체에 grants 칸이 없다 · scopes 가 다시 판정한다
//   G9 역할 구성원에게 scopes 를 다르게 저장        → 400 · 행은 그대로
//   G10 모르는 역할 · 모르는 권한 · 모르는 수준     → 400(저장 전에 막는다) · DB 제약도 모르는 역할을 막는다
//   G11 관리자(admin scope · runtime 없음)가 소유자를 주려 함 → 403(내가 갖지 않은 하네스 설정 고치기) · 관리자 역할은 줄 수 있다
//   G12 역할을 건드리지 않는 저장(이름만)           → 역할 · 개별 권한이 그대로다
//   G13 역할 구성원에게 DB 소스는 기본 불가         → 조회 자격이 있어도 소스는 닫혀 있다 · 옛 구성원은 종전 그대로
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const store = await import(`${DIST}/org/store.js`);
const memberCaps = await import(`${DIST}/capabilities/delivery/members.js`);
const { createSession, userFromSession } = await import(`${DIST}/auth/sessions.js`);
const { verifyDbToken } = await import(`${DIST}/org/store/tokens.js`);
const { registry, capAllowed } = await import(`${DIST}/capabilities/index.js`);
const { canAccessDbSource, hasAnyDbAccess } = await import(`${DIST}/context.js`);
const { ROLE_GRANTS } = await import(`${DIST}/auth/permissions.js`);
const upsertCap = memberCaps.membersCapabilities.find((c) => c.name === "org_member_upsert");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const J = (x) => JSON.stringify(x);
const sameSet = (a, b) => J([...(a ?? [])].sort()) === J([...b].sort());
const sameObj = (a, b) => J(Object.entries(a ?? {}).sort()) === J(Object.entries(b ?? {}).sort());
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

const P = "__role_pg_test__";
const FIVE = ["items", "context", "memory", "db", "code"];
const admin = { userId: `${P}root`, email: "", scopes: [...FIVE, "admin", "runtime"], projects: ["*"], tokenSource: "session" };
const adminNoRuntime = { ...admin, userId: `${P}adm`, scopes: [...FIVE, "admin"] };
const upsert = (input, by = admin) => upsertCap.handler(input, by, { source: "web" });
const row = async (id) => (await itemsPool.query(`SELECT role, grants, scopes, display_name FROM org_member WHERE id=$1`, [id])).rows[0] ?? null;
const cap = (name) => { const c = registry.get(name); if (!c) throw new Error(`등록부에 ${name} 없음`); return c; };
const can = (u, name) => capAllowed(u, cap(name));
const session = async (id) => userFromSession((await createSession(id, { ip: "127.0.0.1", userAgent: "pgtest" })).sessionId);

async function cleanup() {
  await itemsPool.query(`DELETE FROM web_session WHERE member_id LIKE $1`, [`${P}%`]).catch(() => {});
  await itemsPool.query(`DELETE FROM auth_token WHERE user_id LIKE $1 OR member_id LIKE $1`, [`${P}%`]);
  await itemsPool.query(`DELETE FROM member_credential WHERE member_id LIKE $1`, [`${P}%`]).catch(() => {});
  await itemsPool.query(`DELETE FROM person_identity WHERE member_id LIKE $1`, [`${P}%`]).catch(() => {});
  await itemsPool.query(`DELETE FROM org_member WHERE id LIKE $1`, [`${P}%`]);
}

await cleanup();
try {
  // ── G1 옛 구성원 ──
  const old = `${P}old`;
  await upsert({ id: old, display_name: "old", scopes: ["memory", "items"] });
  const r1 = await row(old);
  chk("G1a 옛 구성원의 행 — role NULL · grants NULL", r1?.role === null && r1?.grants === null && sameSet(r1.scopes, ["memory", "items"]), J(r1));
  const s1 = await session(old);
  chk("G1b 옛 구성원의 웹 세션 — grants 칸이 없다", !!s1 && !("grants" in s1) && sameSet(s1.scopes, ["memory", "items"]), J(s1));
  chk("G1c 옛 구성원의 판정은 종전 scope 그대로(memory 로 지식 저장은 되고 분류체계 조회는 안 된다)",
    can(s1, "knowledge_save") === true && can(s1, "category_list") === false && can(s1, "org_member_upsert") === false, "");
  const t1 = await store.mintToken({ userId: old, memberId: old, scopes: ["memory"] }, "pgt");
  const v1 = await verifyDbToken(t1.token);
  chk("G1d 옛 구성원의 토큰 — grants 칸이 없다 · scopes 는 토큰 ∩ 구성원", !!v1 && !("grants" in v1) && sameSet(v1.scopes, ["memory"]), J(v1));

  // ── G2 · G3 게스트 ──
  const g = `${P}guest`;
  await upsert({ id: g, display_name: "guest", role: "guest" });
  const r2 = await row(g);
  chk("G2a 역할을 주면 role · grants · scopes 사본이 적힌다", r2?.role === "guest" && sameObj(r2.grants, {}) && sameSet(r2.scopes, []), J(r2));
  const m2 = await store.getMember(g);
  chk("G2b 다시 읽어도 같다", m2?.role === "guest" && sameObj(m2.grants, {}) && sameSet(m2.scopes, []), J({ role: m2?.role, grants: m2?.grants, scopes: m2?.scopes }));
  const s3 = await session(g);
  chk("G3a 게스트의 웹 세션 — 맥락 보기만 실린다", !!s3 && sameObj(s3.grants, { content: "read" }) && sameSet(s3.scopes, []), J(s3));
  chk("G3b 게스트 — 조회는 열리고(지식 · 분류체계) 변경 · 세션 · 코드 · 수집 · 증류는 닫힌다",
    can(s3, "knowledge_get") && can(s3, "category_list") && !can(s3, "knowledge_save") && !can(s3, "browser_status") && !can(s3, "repo_file") && !can(s3, "org_distiller_list"),
    J(["knowledge_get", "category_list", "knowledge_save", "browser_status", "repo_file", "org_distiller_list"].map((n) => [n, can(s3, n)])));

  // ── G4 구성원 역할 + 개별 권한 ──
  const m = `${P}member`;
  await upsert({ id: m, display_name: "member", role: "member", grants: { code: "write" } });
  const r4 = await row(m);
  chk("G4a 구성원 역할 — scopes 사본은 기본 다섯 · 개별 권한이 적힌다", r4?.role === "member" && sameObj(r4.grants, { code: "write" }) && sameSet(r4.scopes, FIVE), J(r4));
  const s4 = await session(m);
  chk("G4b 구성원 + 코드 고치기 — 레포 등록이 열리고 구성원 관리 · 훅 편집은 닫힌다 · 훅 조회는 열린다",
    can(s4, "repo_create") && !can(s4, "org_member_upsert") && !can(s4, "org_hook_upsert") && can(s4, "org_hooks") && can(s4, "knowledge_save") && !can(s4, "team_create"),
    J(s4?.grants));

  // ── G5 로그인 토큰(비위험 권한 추종) ──
  const t5 = await store.mintToken({ userId: m, memberId: m, scopes: FIVE, followSafeScopes: true }, "pgt");
  const v5 = await verifyDbToken(t5.token);
  chk("G5 로그인 토큰 — 구성원 역할을 따른다(하네스 설정 보기 포함 · 관리 없음)",
    !!v5 && sameObj(v5.grants, { ...ROLE_GRANTS.member, code: "write" }) && can(v5, "org_hooks") && !can(v5, "org_member_upsert"), J(v5?.grants));

  // ── G6 scope 를 골라 구운 토큰 ──
  const t6 = await store.mintToken({ userId: m, memberId: m, scopes: ["memory"] }, "pgt");
  const v6 = await verifyDbToken(t6.token);
  chk("G6 [memory] 로 구운 토큰 — 구성원 ∩ 그 상한(맥락 · 수집 · 증류 · 세션만)",
    !!v6 && sameObj(v6.grants, { content: "write", pipeline: "write", session: "write" }) && can(v6, "knowledge_save") && !can(v6, "repo_file") && !can(v6, "org_hooks"), J(v6?.grants));

  // ── G7 내리면 토큰이 즉시 따라 내려간다 ──
  await upsert({ id: m, role: "guest" });
  const v7a = await verifyDbToken(t5.token), v7b = await verifyDbToken(t6.token);
  chk("G7 구성원을 게스트로 내리면 발급된 토큰이 즉시 따라 내려간다",
    sameObj(v7a?.grants, { content: "read" }) && sameObj(v7b?.grants, { content: "read" }) && !can(v7a, "knowledge_save") && can(v7b, "knowledge_get"),
    J({ a: v7a?.grants, b: v7b?.grants }));
  const r7 = await row(m);
  chk("G7b 역할을 바꾸며 개별 권한을 생략하면 비운다 · scopes 사본도 따라 바뀐다", r7?.role === "guest" && sameObj(r7.grants, {}) && sameSet(r7.scopes, []), J(r7));

  // ── G8 역할을 걷는다 ──
  await upsert({ id: m, role: null, scopes: ["memory", "context"] });
  const r8 = await row(m);
  const s8 = await session(m);
  chk("G8 역할을 걷으면 옛 구성원으로 — role NULL · grants NULL · scopes 가 다시 판정한다",
    r8?.role === null && r8?.grants === null && sameSet(r8.scopes, ["memory", "context"]) && !!s8 && !("grants" in s8) && can(s8, "category_list") && can(s8, "knowledge_save"), J({ r8, s8 }));

  // ── G9 역할 구성원에게 scopes 를 다르게 저장 ──
  const e9 = await errOf(upsert({ id: g, scopes: ["memory", "admin"] }));
  const r9 = await row(g);
  chk("G9 역할 구성원의 scopes 를 다르게 저장 → 400 · 행은 그대로", e9?.status === 400 && /역할로 권한을 받습니다/.test(e9.message) && r9?.role === "guest" && sameSet(r9.scopes, []), J({ m: e9?.message, r9 }));
  const e9b = await errOf(upsert({ id: g, display_name: "guest2", scopes: [] }));
  chk("G9b 사본과 같은 scopes 를 실은 저장(옛 화면이 통째로 다시 보내는 꼴)은 받는다 — 역할이 남는다", e9b === null && (await row(g))?.role === "guest" && (await row(g))?.display_name === "guest2", String(e9b?.message));

  // ── G10 모르는 값 ──
  const e10a = await errOf(upsert({ id: g, role: "superuser" }));
  const e10b = await errOf(upsert({ id: g, role: "guest", grants: { memory: "write" } }));
  const e10c = await errOf(upsert({ id: g, role: "guest", grants: { content: "all" } }));
  const e10d = await errOf(upsert({ id: g, role: "guest", grants: ["content"] }));
  chk("G10a 모르는 역할 · 권한 · 수준 · 꼴 → 400", [e10a, e10b, e10c, e10d].every((e) => e?.status === 400), J([e10a, e10b, e10c, e10d].map((e) => e?.message)));
  const e10e = await errOf(itemsPool.query(`UPDATE org_member SET role='superuser' WHERE id=$1`, [g]));
  chk("G10b DB 제약도 모르는 역할을 막는다", !!e10e && /org_member_role_chk/.test(String(e10e.message)), String(e10e?.message));

  // ── G11 내가 갖지 않은 위험 권한은 못 준다 ──
  const e11a = await errOf(upsert({ id: g, role: "owner" }, adminNoRuntime));
  const e11b = await errOf(upsert({ id: g, role: "member", grants: { harness: "write" } }, adminNoRuntime));
  chk("G11a runtime 없는 관리자가 소유자 · 하네스 설정 고치기를 주려 하면 403 · 행은 그대로",
    e11a?.status === 403 && e11b?.status === 403 && /하네스 설정/.test(e11a.message) && (await row(g))?.role === "guest", J([e11a?.message, e11b?.message]));
  const e11c = await errOf(upsert({ id: g, role: "admin" }, adminNoRuntime));
  chk("G11b 같은 관리자가 관리자 역할은 줄 수 있다(관리 고치기 · 자격 보기 · 하네스 설정 보기)", e11c === null && (await row(g))?.role === "admin", String(e11c?.message));
  const roleAdmin = await session(g);
  const e11d = await errOf(upsert({ id: `${P}x`, display_name: "x", role: "owner" }, roleAdmin));
  const e11e = await errOf(upsert({ id: `${P}x`, display_name: "x", role: "member" }, roleAdmin));
  chk("G11c 관리자 역할을 받은 사람(새 권한)도 소유자는 못 주고 구성원은 준다", e11d?.status === 403 && e11e === null && (await row(`${P}x`))?.role === "member", J([e11d?.message, e11e?.message]));
  const e11f = await errOf(upsert({ id: g, role: "owner" }, admin));
  chk("G11d 전부 가진 사람은 소유자를 줄 수 있다", e11f === null && (await row(g))?.role === "owner", String(e11f?.message));

  // ── G12 역할을 건드리지 않는 저장 ──
  await upsert({ id: g, role: "member", grants: { harness: "write" } });
  await upsert({ id: g, display_name: "renamed" });
  const r12 = await row(g);
  chk("G12 이름만 바꾸는 저장은 역할 · 개별 권한을 지킨다", r12?.role === "member" && sameObj(r12.grants, { harness: "write" }) && r12.display_name === "renamed" && sameSet(r12.scopes, [...FIVE, "runtime"]), J(r12));

  // ── G13 DB 소스 ──
  const s13 = await session(g);
  chk("G13a 역할 구성원 — DB 조회 자격은 있어도 소스는 기본 불가",
    s13?.grants?.db === "read" && hasAnyDbAccess(s13) === true && canAccessDbSource(s13, "crm") === false && canAccessDbSource(s13, "self") === false, J(s13?.grants));
  chk("G13b 옛 구성원은 종전 그대로(db 가 있으면 전 소스)",
    canAccessDbSource({ userId: "u", email: "", scopes: ["db"], projects: [] }, "crm") === true && canAccessDbSource(s1, "crm") === false, "");
  const ownerSession = { ...s13, grants: ROLE_GRANTS.owner };
  chk("G13c 관리 고치기가 있으면 내장 self 소스만 열린다", canAccessDbSource(ownerSession, "self") === true && canAccessDbSource(ownerSession, "crm") === false, "");
} catch (e) {
  bad("예외", String(e?.stack || e));
} finally {
  await cleanup();
  await itemsPool.end().catch(() => {});
}
console.log(`\nmember-role.pg-test: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
