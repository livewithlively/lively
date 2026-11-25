// DB 소스 지정 · 팀 종류 (#5799 3단계) — 역할을 받은 구성원은 지정된 소스만 조회하는가. **실제 Postgres 필요**(run-tests --pg).
//    npm run build && ITEMS_DATABASE_URL=… node src/org/store/db-source-grants.pg-test.mjs
//  목으로는 못 보는 것: 지정 표의 통째 교체(지움 · 더함 · 남는 행 보존), 팀 구성원으로 푸는 판정, 보관된 팀, 팀 종류 칸.
//
//  엣지 표:
//   S1 지정 저장 — 구성원 · 팀을 함께 · 다시 읽으면 같다
//   S2 통째 교체 — 빠진 대상은 지워지고 새 대상이 더해진다 · 남는 대상의 granted_at 은 그대로 · 다른 소스는 건드리지 않는다
//   S3 빈 목록으로 저장 → 아무도 조회하지 못한다
//   S4 판정 — 역할 구성원: 자격 + 본인 지정 → 됨 · 자격만 → 안 됨 · 지정만(게스트) → 안 됨 · 다른 소스 → 안 됨
//   S5 팀으로 지정 — 팀 구성원은 됨 · 팀에서 빠지면 즉시 안 됨 · 보관된 팀은 안 됨
//   S6 옛 구성원 — 지정과 무관하게 종전 그대로(db 가 있으면 전 소스)
//   S7 좁혀 구운 토큰 — 구성원이 지정돼 있어도 토큰에 DB 자격이 없으면 안 됨
//   S7b 소스 한정 토큰(db:<source>) — 구성원이 두 소스에 지정돼 있어도 토큰에 실린 소스만 연다(검증 경로가 주체에 상한을 싣는다)
//   S8 팀이 DB 지정의 대상이 되면 «팀이 권한 주체» 로 센다(팀 편집이 관리자 전용이 된다)
//   S9 관리 기능 — 없는 소스 404 · 활성 아닌 구성원 400 · 없는 팀 400 · 배열 아님 400 · 성공하면 목록을 돌려준다 · 조회 기능이 같은 것을 준다
//   S10 소스의 지정 지우기 — 그 소스만
//   S11 팀 종류 — 만들 때 group · 목록에 kind · 고치기로 바꿈 · 모르는 종류 400 · 생략하면 team · memberTeams 에 kind
//   S12 whoami — 소속 팀과 권한 그룹이 갈려 나온다
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const store = await import(`${DIST}/org/store.js`);
const G = await import(`${DIST}/org/store/db-source-grants.js`);
const teamStore = await import(`${DIST}/v6/team-store.js`);
const { teamCapabilities } = await import(`${DIST}/capabilities/teams.js`);
const dbCaps = await import(`${DIST}/capabilities/delivery/db-sources.js`);
const { registry } = await import(`${DIST}/capabilities/index.js`);
const { verifyDbToken } = await import(`${DIST}/org/store/tokens.js`);
const { ROLE_GRANTS, memberGrants } = await import(`${DIST}/auth/permissions.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const J = (x) => JSON.stringify(x);
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const cap = (name) => { const c = registry.get(name); if (!c) throw new Error(`등록부에 ${name} 없음`); return c; };

const P = "__dbgrant_pg_test__";
const SRC = `${P}crm`, SRC2 = `${P}erp`;
const admin = { userId: `${P}root`, email: "", scopes: ["items", "context", "memory", "db", "code", "admin", "runtime"], projects: ["*"], tokenSource: "session" };
const principal = async (id) => { const m = await store.getMember(id); const g = memberGrants(m); return { userId: id, email: "", scopes: m.scopes, ...(g ? { grants: g } : {}), projects: ["*"] }; };
const grantsOf = async (src) => (await G.listDbSourceGrants(src)).map((r) => `${r.subject_kind}:${r.subject_id}`).sort();
const teamCap = (name) => teamCapabilities.find((c) => c.name === name);

async function cleanup() {
  await itemsPool.query(`DELETE FROM org_db_source_grant WHERE source LIKE $1 OR source='self' AND subject_id LIKE $1`, [`${P}%`]);
  await itemsPool.query(`DELETE FROM team WHERE key LIKE $1`, [`${P.replace(/_/g, "").toLowerCase()}%`]);
  await itemsPool.query(`DELETE FROM auth_token WHERE user_id LIKE $1 OR member_id LIKE $1`, [`${P}%`]);
  await itemsPool.query(`DELETE FROM person_identity WHERE member_id LIKE $1`, [`${P}%`]).catch(() => {});
  await itemsPool.query(`DELETE FROM org_member WHERE id LIKE $1`, [`${P}%`]);
}
const TK = P.replace(/_/g, "").toLowerCase();   // 팀 key 는 소문자 슬러그

await cleanup();
try {
  const alice = `${P}alice`, bob = `${P}bob`, guest = `${P}guest`, old = `${P}old`, gone = `${P}gone`;
  await store.upsertMember({ id: alice, display_name: "alice", role: "member" }, "pgt");
  await store.upsertMember({ id: bob, display_name: "bob", role: "member" }, "pgt");
  await store.upsertMember({ id: guest, display_name: "guest", role: "guest" }, "pgt");
  await store.upsertMember({ id: old, display_name: "old", scopes: ["memory", "db"] }, "pgt");
  await store.upsertMember({ id: gone, display_name: "gone", role: "member", state: "inactive" }, "pgt");
  const team = await teamStore.createTeam({ key: `${TK}data`, name: "데이터" });
  await teamStore.setTeamMembers(team.id, [{ member_id: bob }]);

  // ── S1 · S2 · S3 ──
  await G.setDbSourceGrants(SRC, [{ kind: "member", id: alice }, { kind: "team", id: String(team.id) }], "pgt");
  await G.setDbSourceGrants(SRC2, [{ kind: "member", id: guest }], "pgt");
  chk("S1 지정 저장 — 구성원과 팀을 함께 · 다시 읽으면 같다", J(await grantsOf(SRC)) === J([`member:${alice}`, `team:${team.id}`].sort()), J(await grantsOf(SRC)));
  const at1 = (await G.listDbSourceGrants(SRC)).find((r) => r.subject_id === alice)?.granted_at;
  await new Promise((r) => setTimeout(r, 30));
  await G.setDbSourceGrants(SRC, [{ kind: "member", id: alice }, { kind: "member", id: guest }, { kind: "member", id: alice }], "pgt2");
  const rows2 = await G.listDbSourceGrants(SRC);
  const at2 = rows2.find((r) => r.subject_id === alice);
  chk("S2a 통째 교체 — 빠진 팀은 지워지고 새 구성원이 더해진다(겹친 입력은 한 번)", J(await grantsOf(SRC)) === J([`member:${alice}`, `member:${guest}`].sort()), J(await grantsOf(SRC)));
  chk("S2b 남는 대상의 지정 시각 · 지정한 사람은 그대로", String(at2?.granted_at) === String(at1) && at2?.granted_by === "pgt", J({ at1, at2 }));
  chk("S2c 다른 소스는 건드리지 않는다", J(await grantsOf(SRC2)) === J([`member:${guest}`]), J(await grantsOf(SRC2)));
  await G.setDbSourceGrants(SRC2, [], "pgt");
  chk("S3 빈 목록으로 저장하면 아무도 남지 않는다", (await grantsOf(SRC2)).length === 0 && (await G.dbSourceAllowed(await principal(guest), SRC2)) === false, J(await grantsOf(SRC2)));

  // ── S4 판정 ──
  const pa = await principal(alice), pb = await principal(bob), pg = await principal(guest), po = await principal(old);
  chk("S4a 역할 구성원 · 자격 + 본인 지정 → 조회된다", pa.grants?.db === "read" && (await G.dbSourceAllowed(pa, SRC)) === true, J(pa.grants));
  chk("S4b 자격은 있어도 지정이 없으면 안 된다(기본 불가)", pb.grants?.db === "read" && (await G.dbSourceAllowed(pb, SRC)) === false, "");
  chk("S4c 지정돼 있어도 자격이 없으면(게스트) 안 된다", pg.grants?.db === undefined && (await G.dbSourceAllowed(pg, SRC)) === false, J(pg.grants));
  chk("S4d 다른 소스는 안 된다", (await G.dbSourceAllowed(pa, SRC2)) === false && (await G.dbSourceAllowed(pa, `${P}nope`)) === false, "");
  const e4 = await errOf(G.requireDbSourceAccess(pb, SRC));
  chk("S4e 거절은 종전 꼴의 문구로 던진다", !!e4 && /lacks db access to source/.test(e4.message), String(e4?.message));

  // ── S5 팀으로 지정 ──
  await G.setDbSourceGrants(SRC, [{ kind: "team", id: String(team.id) }], "pgt");
  chk("S5a 팀으로 지정하면 팀 구성원이 조회한다 · 팀 밖은 안 된다", (await G.dbSourceAllowed(pb, SRC)) === true && (await G.dbSourceAllowed(pa, SRC)) === false, "");
  chk("S5b memberHasDbSource — 팀 구성원 true · 아니면 false · 빈 값 false",
    (await G.memberHasDbSource(bob, SRC)) === true && (await G.memberHasDbSource(alice, SRC)) === false && (await G.memberHasDbSource("", SRC)) === false && (await G.memberHasDbSource(bob, "")) === false, "");
  await teamStore.setTeamMembers(team.id, [{ member_id: alice }]);
  chk("S5c 팀에서 빠지면 즉시 못 보고, 새로 들어온 사람이 본다", (await G.dbSourceAllowed(pb, SRC)) === false && (await G.dbSourceAllowed(pa, SRC)) === true, "");
  await teamStore.updateTeam(team.id, { state: "archived" });
  chk("S5d 보관된 팀으로는 열리지 않는다", (await G.dbSourceAllowed(pa, SRC)) === false, "");
  await teamStore.updateTeam(team.id, { state: "active" });

  // ── S6 옛 구성원 ──
  chk("S6 옛 구성원은 지정과 무관하게 종전 그대로(db 가 있으면 전 소스)", !("grants" in po) && (await G.dbSourceAllowed(po, SRC)) === true && (await G.dbSourceAllowed(po, `${P}nope`)) === true, J(po));

  // ── S7 좁혀 구운 토큰 ──
  const tNarrow = await store.mintToken({ userId: alice, memberId: alice, scopes: ["memory"] }, "pgt");
  const tWide = await store.mintToken({ userId: alice, memberId: alice, scopes: ["memory", "db"] }, "pgt");
  const vNarrow = await verifyDbToken(tNarrow.token), vWide = await verifyDbToken(tWide.token);
  chk("S7 구성원이 지정돼 있어도 토큰에 DB 자격이 없으면 안 된다 · 자격이 실린 토큰은 된다",
    vNarrow?.grants?.db === undefined && (await G.dbSourceAllowed(vNarrow, SRC)) === false && vWide?.grants?.db === "read" && (await G.dbSourceAllowed(vWide, SRC)) === true, J({ n: vNarrow?.grants, w: vWide?.grants }));
  await G.setDbSourceGrants(SRC2, [{ kind: "member", id: alice }], "pgt");
  const tSrc = await store.mintToken({ userId: alice, memberId: alice, scopes: ["memory", `db:${SRC}`] }, "pgt");
  const vSrc = await verifyDbToken(tSrc.token);
  chk("S7b 소스 한정 토큰은 구성원이 두 소스에 지정돼 있어도 토큰에 실린 소스만 연다",
    J(vSrc?.dbSourceCeiling) === J([SRC]) && (await G.dbSourceAllowed(vSrc, SRC)) === true && (await G.dbSourceAllowed(vSrc, SRC2)) === false
      && (await G.dbSourceAllowed(vWide, SRC2)) === true,
    J({ ceiling: vSrc?.dbSourceCeiling, grants: vSrc?.grants }));
  await G.setDbSourceGrants(SRC2, [], "pgt");

  // ── S8 팀이 권한 주체가 됐나 ──
  await itemsPool.query(`DELETE FROM org_db_source_grant WHERE subject_kind='team'`);
  const visTeam = (await itemsPool.query(`SELECT (EXISTS(SELECT 1 FROM project_list_team) OR EXISTS(SELECT 1 FROM project_folder_member WHERE subject_kind='team')
      OR EXISTS(SELECT 1 FROM knowledge_member WHERE subject_kind='team') OR EXISTS(SELECT 1 FROM source_member WHERE subject_kind='team')) AS v`)).rows[0].v;
  const before8 = await teamStore.anyTeamGrant();
  await G.setDbSourceGrants(SRC, [{ kind: "team", id: String(team.id) }], "pgt");
  const after8 = await teamStore.anyTeamGrant();
  chk("S8 팀이 DB 지정의 대상이 되면 «팀이 권한 주체» 로 센다", before8 === visTeam && after8 === true, J({ visTeam, before8, after8 }));

  // ── S9 관리 기능 ──
  const setCap = dbCaps.dbSourceCapabilities?.find?.((c) => c.name === "org_db_source_access_set") ?? cap("org_db_source_access_set");
  const getCap = cap("org_db_source_access");
  const e9a = await errOf(setCap.handler({ name: `${TK}nosuch`, members: [alice] }, admin, { source: "web" }));
  const e9b = await errOf(setCap.handler({ name: "self", members: [gone] }, admin, { source: "web" }));
  const e9c = await errOf(setCap.handler({ name: "self", members: [`${P}nobody`] }, admin, { source: "web" }));
  const e9d = await errOf(setCap.handler({ name: "self", teams: [987654321] }, admin, { source: "web" }));
  const e9e = await errOf(setCap.handler({ name: "self", members: alice }, admin, { source: "web" }));
  chk("S9a 없는 소스 404 · 활성 아닌/없는 구성원 400 · 없는 팀 400 · 배열 아님 400",
    e9a?.status === 404 && e9b?.status === 400 && e9c?.status === 400 && e9d?.status === 400 && e9e?.status === 400, J([e9a, e9b, e9c, e9d, e9e].map((e) => [e?.status, e?.message])));
  const out9 = await setCap.handler({ name: "self", members: [alice, alice], teams: [team.id] }, admin, { source: "web" });
  chk("S9b 성공하면 저장된 목록을 돌려준다(겹친 입력은 한 번)", out9.source === "self" && J(out9.members) === J([alice]) && J(out9.teams) === J([team.id]), J(out9));
  const got9 = await getCap.handler({ name: "self" }, admin, { source: "web" });
  const all9 = await getCap.handler({}, admin, { source: "web" });
  chk("S9c 조회 기능이 같은 것을 준다 · 이름을 생략하면 지정이 있는 소스 전부",
    J(got9.access) === J([{ source: "self", members: [alice], teams: [team.id] }]) && all9.access.some((a) => a.source === SRC) && all9.access.some((a) => a.source === "self"), J({ got9, n: all9.access.length }));
  const empty9 = await getCap.handler({ name: SRC2 }, admin, { source: "web" });
  chk("S9d 지정이 없는 소스를 물으면 빈 목록으로 답한다", J(empty9.access) === J([{ source: SRC2, members: [], teams: [] }]), J(empty9));
  await setCap.handler({ name: "self" }, admin, { source: "web" });
  chk("S9e members · teams 를 생략하면 빈 목록으로 바꾼다", (await grantsOf("self")).length === 0, J(await grantsOf("self")));

  // ── S10 ──
  await G.setDbSourceGrants(SRC2, [{ kind: "member", id: alice }], "pgt");
  await G.clearDbSourceGrants(SRC);
  chk("S10 소스의 지정 지우기는 그 소스만", (await grantsOf(SRC)).length === 0 && (await grantsOf(SRC2)).length === 1, J([await grantsOf(SRC), await grantsOf(SRC2)]));

  // ── S11 팀 종류 ──
  const made = await teamCap("team_create").handler({ key: `${TK}viewers`, name: "DB 조회자", kind: "group" }, admin, { source: "web" });
  const plain = await teamCap("team_create").handler({ key: `${TK}plain`, name: "평범" }, admin, { source: "web" });
  chk("S11a 만들 때 종류 — group 은 group · 생략하면 team", made.team.kind === "group" && plain.team.kind === "team", J([made.team.kind, plain.team.kind]));
  const listed = (await teamStore.listTeams()).filter((t) => t.key.startsWith(TK));
  chk("S11b 목록에 kind 가 실린다", listed.find((t) => t.id === made.team.id)?.kind === "group" && listed.find((t) => t.id === team.id)?.kind === "team", J(listed.map((t) => [t.key, t.kind])));
  const upd = await teamCap("team_update").handler({ id: made.team.id, name: "DB 조회자들" }, admin, { source: "web" });
  chk("S11c 종류를 안 건드리는 고치기는 종류를 지킨다", upd.team.kind === "group" && upd.team.name === "DB 조회자들", J(upd.team));
  const upd2 = await teamCap("team_update").handler({ id: made.team.id, kind: "team" }, admin, { source: "web" });
  chk("S11d 고치기로 종류를 바꾼다", upd2.team.kind === "team" && (await teamStore.getTeam(made.team.id))?.kind === "team", J(upd2.team));
  const parseErr = await errOf((async () => teamCap("team_update").expose.rest[0].parse({ params: { id: String(made.team.id) }, body: { kind: "squad" } }))());
  chk("S11e 모르는 종류는 400", parseErr?.status === 400, String(parseErr?.message));
  const e11 = await errOf(itemsPool.query(`UPDATE team SET kind='squad' WHERE id=$1`, [made.team.id]));
  chk("S11f DB 제약도 모르는 종류를 막는다", !!e11 && /team_kind_chk/.test(String(e11.message)), String(e11?.message));

  // ── S12 whoami ──
  await teamCap("team_update").handler({ id: made.team.id, kind: "group" }, admin, { source: "web" });
  await teamStore.setTeamMembers(made.team.id, [{ member_id: alice }]);
  const mt = await teamStore.memberTeams(alice);
  chk("S12a memberTeams 에 kind 가 실린다", mt.find((t) => t.id === made.team.id)?.kind === "group" && mt.find((t) => t.id === team.id)?.kind === "team", J(mt.map((t) => [t.key, t.kind])));
  const who = await cap("whoami").handler({}, pa, { source: "mcp" });
  chk("S12b whoami — 소속 팀과 권한 그룹이 갈려 나온다",
    who.teams.some((t) => t.id === team.id) && !who.teams.some((t) => t.id === made.team.id) && who.groups.some((t) => t.id === made.team.id) && !who.groups.some((t) => t.id === team.id), J({ teams: who.teams, groups: who.groups }));
} catch (e) {
  bad("예외", String(e?.stack || e));
} finally {
  await cleanup();
  await itemsPool.end().catch(() => {});
}
console.log(`\ndb-source-grants.pg-test: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
