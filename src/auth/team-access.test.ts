// 팀이 주는 권한 (#5799) — sanitizeTeamAccess · teamGrants · memberGrants · effectiveScopes · ungivable · grantSources(순수).
//  저장 · 주체(세션 · 토큰) · 거절은 auth/team-access.pg-test.mjs 가 잰다. 여기는 «권한이 어떻게 합쳐지고 어디서 왔다고 말하는가» 의 규칙만.
//
//  엣지 표:
//   E1 옛 방식 구성원이 권한 실린 팀에 있음        → 새 권한 없음(undefined) · scopes 는 저장된 값 그대로(팀이 옛 주체를 넓히지 않는다)
//   E2 역할 구성원 · 팀 없음                       → 역할 ∪ 개별 권한(종전과 같다) · scopes = 그 사본
//   E3 게스트 + 구성원 역할을 주는 팀              → 구성원 역할과 같은 권한 · scopes 다섯
//   E4 구성원 + 팀의 개별 권한(코드 고치기)        → 코드 고치기 · 팀이 낮은 수준을 줘도 본인의 높은 수준은 그대로
//   E5 팀 여럿                                    → 합집합(권한마다 가장 높은 수준)
//   E6 손상된 팀 조각                              → 배열이 아님 · id 없음 · 모르는 역할 + 빈 권한 · 아무것도 안 주는 팀은 버린다 · 모르는 권한 · 수준은 버린다
//   E7 관리자 역할을 주는 팀                       → effectiveScopes 에 admin 이 있다(저장된 사본에는 없어도)
//   E8 ungivable                                  → 관리자 역할이 소유자를 주려 함 = 자격 · 하네스 설정 · 관리자 역할을 주려 함 = 없음 · 보기 수준은 재지 않는다 · 위험하지 않은 권한은 재지 않는다
//   E9 grantSources                               → 지금 수준을 주는 출처만(역할이 낮게 주는 것은 출처가 아니다) · 같은 수준을 여럿이 주면 전부 · 없는 권한은 없다 · 옛 구성원은 빈 것
//   E10 teamGrants                                → 역할 ∪ 개별 권한 · null · 빈 것 → {}
import test from "node:test";
import assert from "node:assert/strict";
import {
  ROLE_GRANTS, effectiveScopes, grantSources, grantsToLegacyScopes, legacyScopesToGrants, memberGrants, sanitizeTeamAccess, teamGrants, ungivable,
} from "./permissions.js";

const sorted = (a: readonly string[]): string[] => [...a].sort();
const FIVE = ["code", "context", "db", "items", "memory"];
const T = (team_id: number, role: string | null, grants: Record<string, string> = {}, name: string | null = `t${team_id}`) => ({ team_id, name, role, grants });

test("E1 옛 방식 구성원은 팀이 넓히지 않는다", () => {
  const row = { role: null, grants: null, scopes: ["items"], team_access: [T(1, "owner")] };
  assert.equal(memberGrants(row), undefined);
  assert.deepEqual(effectiveScopes(row), ["items"]);
  assert.deepEqual(grantSources(row), {});
  assert.deepEqual(effectiveScopes(null), []);
  assert.deepEqual(effectiveScopes({ scopes: ["items", 3, null] as unknown[] }), ["items"], "글이 아닌 값은 버린다");
});

test("E2 팀이 없으면 종전과 같다", () => {
  const row = { role: "member", grants: { code: "write" }, scopes: ["x"] };
  assert.deepEqual(memberGrants(row), { ...ROLE_GRANTS.member, code: "write" });
  assert.deepEqual(memberGrants({ ...row, team_access: [] }), memberGrants(row));
  assert.deepEqual(memberGrants({ ...row, team_access: null }), memberGrants(row));
  assert.deepEqual(sorted(effectiveScopes(row)), sorted(grantsToLegacyScopes({ ...ROLE_GRANTS.member, code: "write" })), "저장된 scopes 가 아니라 권한을 비춘다");
});

test("E3 게스트 + 구성원 역할을 주는 팀", () => {
  const row = { role: "guest", grants: {}, scopes: [], team_access: [T(1, "member")] };
  assert.deepEqual(memberGrants(row), ROLE_GRANTS.member);
  assert.deepEqual(sorted(effectiveScopes(row)), FIVE);
});

test("E4 팀의 개별 권한은 올리기만 한다", () => {
  assert.equal(memberGrants({ role: "member", grants: {}, team_access: [T(1, null, { code: "write" })] })?.code, "write");
  const kept = memberGrants({ role: "member", grants: { code: "write" }, team_access: [T(1, null, { code: "read", content: "read" })] });
  assert.equal(kept?.code, "write");
  assert.equal(kept?.content, "write");
});

test("E5 팀 여럿은 합집합이다", () => {
  const g = memberGrants({ role: "guest", grants: {}, team_access: [T(1, null, { code: "read", db: "read" }), T(2, null, { code: "write" }), T(3, null, { session: "write" })] });
  assert.deepEqual(g, { content: "read", code: "write", db: "read", session: "write" });
});

test("E6 손상된 팀 조각은 버린다", () => {
  for (const junk of [null, undefined, "x", 3, {}, { team_id: 1 }]) assert.deepEqual(sanitizeTeamAccess(junk), []);
  const got = sanitizeTeamAccess([
    null, "x", { role: "member" }, { team_id: 0, role: "member" }, { team_id: "abc", role: "member" },
    { team_id: 1, role: "nope", grants: {} }, { team_id: 2, role: null, grants: null }, { team_id: 3, role: null, grants: { zzz: "write", code: "admin" } },
    { team_id: "4", name: 9, role: "nope", grants: { code: "write", zzz: "read" } }, { team_id: 5, name: "ok", role: "admin", grants: "x" },
  ]);
  assert.deepEqual(got, [{ team_id: 4, name: null, role: null, grants: { code: "write" } }, { team_id: 5, name: "ok", role: "admin", grants: {} }]);
  assert.deepEqual(memberGrants({ role: "guest", grants: {}, team_access: "junk" }), ROLE_GRANTS.guest);
});

test("E7 팀이 준 관리 권한이 scopes 에도 비친다", () => {
  const row = { role: "member", grants: {}, scopes: FIVE, team_access: [T(1, "admin")] };
  assert.ok(effectiveScopes(row).includes("admin"));
  assert.ok(!effectiveScopes(row).includes("runtime"));
  assert.ok(effectiveScopes({ ...row, team_access: [T(1, "owner")] }).includes("runtime"));
  assert.ok(!effectiveScopes({ ...row, team_access: [] }).includes("admin"));
});

test("E8 ungivable — 내가 갖지 않은 위험 권한의 고치기", () => {
  assert.deepEqual(ungivable(ROLE_GRANTS.admin, ROLE_GRANTS.owner), ["secrets", "harness"]);
  assert.deepEqual(ungivable(ROLE_GRANTS.admin, ROLE_GRANTS.admin), []);
  assert.deepEqual(ungivable(ROLE_GRANTS.owner, ROLE_GRANTS.owner), []);
  assert.deepEqual(ungivable(ROLE_GRANTS.member, { admin: "write" }), ["admin"]);
  assert.deepEqual(ungivable(ROLE_GRANTS.member, { admin: "read", secrets: "read", harness: "read" }), [], "보기 수준은 재지 않는다");
  assert.deepEqual(ungivable({}, { content: "write", code: "write", db: "read", session: "write" }), [], "위험하지 않은 권한은 재지 않는다");
  assert.deepEqual(ungivable(legacyScopesToGrants(["admin", "runtime"]), ROLE_GRANTS.owner), [], "옛 방식 주는 사람은 번역해서 잰다");
  assert.deepEqual(ungivable(legacyScopesToGrants(["admin"]), ROLE_GRANTS.owner), ["harness"]);
});

test("E9 grantSources — 지금 수준을 주는 출처만", () => {
  const row = { role: "member", grants: { code: "write" }, team_access: [T(1, null, { code: "write", admin: "read" }, "개발"), T(2, null, { code: "read" }, "읽기"), T(3, "member", {}, "전체")] };
  const s = grantSources(row);
  assert.deepEqual(s.code, [{ from: "own", level: "write" }, { from: "team", level: "write", team_id: 1, name: "개발" }], "역할(보기) · 읽기 팀은 출처가 아니다");
  assert.deepEqual(s.admin, [{ from: "team", level: "read", team_id: 1, name: "개발" }]);
  assert.deepEqual(s.content, [{ from: "role", level: "write" }, { from: "team", level: "write", team_id: 3, name: "전체" }]);
  assert.equal(s.secrets, undefined);
  assert.deepEqual(grantSources({ role: null, grants: { code: "write" } }), {});
  assert.deepEqual(grantSources(null), {});
});

test("E10 teamGrants — 역할 ∪ 개별 권한", () => {
  assert.deepEqual(teamGrants({ role: "guest", grants: { code: "write" } }), { content: "read", code: "write" });
  assert.deepEqual(teamGrants({ role: "nope", grants: { code: "read" } }), { code: "read" });
  assert.deepEqual(teamGrants(null), {});
  assert.deepEqual(teamGrants({}), {});
});
