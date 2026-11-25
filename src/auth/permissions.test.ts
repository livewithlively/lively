// 새 권한 체계의 순수 값 (#5799) — 권한 10개 · 수준 · 옛 이름 번역 · 역할 4개.
//  등록부와 맞물린 검사(전 기능 × 옛 scope)는 capabilities/permission-map.test.ts 가 한다. 여기는 값 자체만.
//
//  엣지 표:
//   P1 권한은 10개이고 이름 · 정의가 전부 있다
//   P2 고치기는 보기를 포함한다 · 없는 권한은 보기도 안 된다 · 요구가 null 이면 통과
//   P3 합치면 권한마다 높은 수준이 남는다(합집합 — 낮추는 규칙이 없다)
//   P4 옛 이름 번역: 모르는 이름은 버린다 · `db:<소스>` 는 DB 조회 자격 · 빈 `db:` 는 버린다 · 입력 순서와 무관
//   P5 옛 위험 scope(admin · runtime)만 관리 · 자격 · 하네스 설정을 준다
//   P6 역할은 게스트 ⊆ 구성원 ⊆ 관리자 ⊆ 소유자 로 넓어진다
//   P7 합의한 역할 표 그대로다(게스트 = 맥락 보기만 · 관리자는 자격 · 하네스 설정이 보기 · DB 는 누구도 고치기가 없다)
//   P8 교집합: 권한마다 낮은 수준 · 한쪽에 없으면 없다 · 순서와 무관 · 빈 쪽과는 빈 것
//   P9 주체의 권한: 새 값이 실려 있으면 그것만 본다(옛 scope 사본과 합치지 않는다) · 없으면 옛 scope 번역 · 주체가 없으면 빈 것
//   P10 can: 수준을 안 주면 고치기를 묻는다 · 보기만 가진 사람에게 보기는 통하고 고치기는 안 통한다
//   P11 위험 권한은 관리 · 자격 · 하네스 설정이고, 옛 위험 scope 가 주는 것과 정확히 같다
import test from "node:test";
import assert from "node:assert/strict";
import { SCOPES, DANGEROUS_SCOPES, SAFE_SCOPES } from "./scopes.js";
import {
  PERMISSIONS, PERMISSION_INFO, isPermission, allows, mergeGrants, legacyScopesToGrants, LEGACY_SCOPE_GRANTS,
  ROLES, ROLE_INFO, ROLE_GRANTS, isRole, intersectGrants, grantsOf, can, DANGEROUS_PERMISSIONS,
  type Grants, type Level, type Permission,
} from "./permissions.js";

const RANK: Record<Level, number> = { read: 1, write: 2 };
const rank = (g: Grants, p: Permission): number => { const lv = g[p]; return lv ? RANK[lv] : 0; };

test("P1 권한은 10개이고 이름 · 정의가 전부 있다", () => {
  assert.deepEqual([...PERMISSIONS], ["content", "pipeline", "external", "code", "session", "run", "db", "admin", "secrets", "harness"]);
  assert.equal(new Set(PERMISSIONS).size, 10);
  for (const p of PERMISSIONS) {
    assert.ok(PERMISSION_INFO[p].label.length > 0, `${p} 이름`);
    assert.ok(PERMISSION_INFO[p].definition.length > 0, `${p} 정의`);
  }
  assert.deepEqual(Object.keys(PERMISSION_INFO).sort(), [...PERMISSIONS].sort(), "정의에 남는 이름이 없다");
  assert.equal(new Set(PERMISSIONS.map((p) => PERMISSION_INFO[p].label)).size, 10, "화면 이름이 겹치지 않는다");
  assert.equal(PERMISSION_INFO.db.levels, "read-only");
  assert.ok(isPermission("content") && !isPermission("memory") && !isPermission(null));
});

test("P2 고치기는 보기를 포함하고, 없는 권한은 보기도 안 된다", () => {
  assert.equal(allows({ content: "write" }, { perm: "content", level: "read" }), true);
  assert.equal(allows({ content: "write" }, { perm: "content", level: "write" }), true);
  assert.equal(allows({ content: "read" }, { perm: "content", level: "read" }), true);
  assert.equal(allows({ content: "read" }, { perm: "content", level: "write" }), false);
  assert.equal(allows({ content: "write" }, { perm: "pipeline", level: "read" }), false);
  assert.equal(allows({}, { perm: "session", level: "read" }), false);
  assert.equal(allows({}, null), true, "요구가 없으면(로그인만) 통과");
});

test("P3 합치면 권한마다 높은 수준이 남는다", () => {
  assert.deepEqual(mergeGrants({ content: "read", code: "write" }, { content: "write", db: "read" }), { content: "write", code: "write", db: "read" });
  assert.deepEqual(mergeGrants({ content: "write" }, { content: "read" }), { content: "write" }, "뒤에 온 낮은 수준이 낮추지 못한다");
  assert.deepEqual(mergeGrants(), {});
  assert.deepEqual(mergeGrants({}, {}), {});
});

test("P4 옛 이름 번역 — 모르는 이름은 버리고 db:<소스> 는 DB 조회 자격이다", () => {
  assert.deepEqual(legacyScopesToGrants([]), {});
  assert.deepEqual(legacyScopesToGrants(null), {});
  assert.deepEqual(legacyScopesToGrants(undefined), {});
  assert.deepEqual(legacyScopesToGrants(["nope", "content", "ADMIN", ""]), {}, "새 이름 · 대문자 · 빈 값은 옛 이름이 아니다");
  assert.deepEqual(legacyScopesToGrants(["db:crm"]), { db: "read" });
  assert.deepEqual(legacyScopesToGrants(["db:"]), {}, "소스 이름이 빈 db: 는 버린다");
  assert.deepEqual(legacyScopesToGrants(["db"]), { db: "read" });
  assert.deepEqual(legacyScopesToGrants(["constructor", "toString", "__proto__"]), {}, "객체 내장 이름에 속지 않는다");
  assert.equal(Object.getPrototypeOf(legacyScopesToGrants(["__proto__"])), Object.prototype, "결과 객체가 오염되지 않는다");
  assert.deepEqual(legacyScopesToGrants(["code", "context"]), legacyScopesToGrants(["context", "code"]), "순서와 무관");
  assert.deepEqual(legacyScopesToGrants(["code", "context"]), { content: "write", code: "write", run: "write" }, "context 의 코드 고치기가 code 의 코드 보기를 이긴다");
  assert.deepEqual(legacyScopesToGrants(["items", "context", "memory", "db", "code"]),
    { external: "write", content: "write", code: "write", run: "write", pipeline: "write", session: "write", db: "read" }, "기본 구성원");
  assert.deepEqual(Object.keys(LEGACY_SCOPE_GRANTS).sort(), [...SCOPES].sort(), "옛 scope 7개를 전부 번역한다");
});

test("P5 옛 위험 scope 만 관리 · 자격 · 하네스 설정을 준다", () => {
  const dangerousPerms = ["admin", "secrets", "harness"] as const;
  for (const s of SAFE_SCOPES) {
    for (const p of dangerousPerms) assert.equal(LEGACY_SCOPE_GRANTS[s][p], undefined, `${s} 가 ${p} 를 주면 안 된다`);
  }
  assert.equal(legacyScopesToGrants([...SAFE_SCOPES, "db:crm"]).admin, undefined);
  for (const s of DANGEROUS_SCOPES) {
    const g = LEGACY_SCOPE_GRANTS[s];
    assert.ok(Object.keys(g).length > 0, `${s} 가 주는 것이 있다`);
    assert.ok(Object.keys(g).every((p) => (dangerousPerms as readonly string[]).includes(p)), `${s} 는 위험 권한만 준다`);
  }
  // admin ⊉ runtime 을 잇는다 — admin 은 하네스 설정을, runtime 은 관리 · 자격을 주지 않는다
  assert.equal(LEGACY_SCOPE_GRANTS.admin.harness, undefined);
  assert.equal(LEGACY_SCOPE_GRANTS.runtime.admin, undefined);
  assert.equal(LEGACY_SCOPE_GRANTS.runtime.secrets, undefined);
});

test("P6 역할은 게스트 ⊆ 구성원 ⊆ 관리자 ⊆ 소유자 로 넓어진다", () => {
  assert.deepEqual([...ROLES], ["guest", "member", "admin", "owner"]);
  for (const r of ROLES) assert.ok(ROLE_INFO[r].label && ROLE_INFO[r].definition, `${r} 이름 · 정의`);
  assert.ok(isRole("guest") && !isRole("viewer") && !isRole(undefined));
  for (let i = 1; i < ROLES.length; i++) {
    const lo = ROLE_GRANTS[ROLES[i - 1]], hi = ROLE_GRANTS[ROLES[i]];
    for (const p of PERMISSIONS) assert.ok(rank(hi, p) >= rank(lo, p), `${ROLES[i]} 의 ${p} 가 ${ROLES[i - 1]} 보다 낮다`);
  }
});

test("P7 합의한 역할 표 그대로다", () => {
  assert.deepEqual(ROLE_GRANTS.guest, { content: "read" }, "게스트는 맥락 보기만 — 세션 · 코드 · 맥락 관리 없음");
  assert.deepEqual(ROLE_GRANTS.member, {
    session: "write", content: "write", pipeline: "write", external: "write", code: "read", run: "write", db: "read", harness: "read",
  });
  assert.deepEqual(ROLE_GRANTS.admin, {
    session: "write", content: "write", pipeline: "write", external: "write", code: "write", run: "write", db: "read",
    admin: "write", secrets: "read", harness: "read",
  });
  for (const p of PERMISSIONS) assert.ok(ROLE_GRANTS.owner[p] !== undefined, `소유자에게 ${p} 가 있다`);
  for (const r of ROLES) assert.notEqual(ROLE_GRANTS[r].db, "write", `${r} — DB 는 조회 전용이다`);
  assert.equal(ROLE_GRANTS.owner.secrets, "write");
  assert.equal(ROLE_GRANTS.owner.harness, "write");
});

test("P8 교집합은 권한마다 낮은 수준이고, 한쪽에 없으면 없다", () => {
  assert.deepEqual(intersectGrants({ content: "write", code: "read", db: "read" }, { content: "read", code: "write", admin: "write" }),
    { content: "read", code: "read" });
  assert.deepEqual(intersectGrants({ content: "write" }, { content: "write" }), { content: "write" });
  assert.deepEqual(intersectGrants({ content: "write" }, {}), {});
  assert.deepEqual(intersectGrants({}, { content: "write" }), {});
  const a: Grants = { content: "read", pipeline: "write", session: "write" }, b: Grants = { content: "write", pipeline: "read", harness: "read" };
  assert.deepEqual(intersectGrants(a, b), intersectGrants(b, a), "순서와 무관");
  // 구성원이 상한이다 — 토큰이 더 많이 들고 있어도 구성원이 가진 만큼만 남는다
  assert.deepEqual(intersectGrants(legacyScopesToGrants(["admin", "memory"]), ROLE_GRANTS.guest), { content: "read" });
  // 교집합은 어느 쪽보다도 넓지 않다
  for (const p of PERMISSIONS) {
    const x = intersectGrants(ROLE_GRANTS.admin, ROLE_GRANTS.member)[p];
    assert.ok(rank({ [p]: x } as Grants, p) <= rank(ROLE_GRANTS.admin, p) && rank({ [p]: x } as Grants, p) <= rank(ROLE_GRANTS.member, p), p);
  }
});

test("P9 주체의 권한 — 새 값이 실려 있으면 그것만 본다", () => {
  assert.deepEqual(grantsOf(null), {});
  assert.deepEqual(grantsOf(undefined), {});
  assert.deepEqual(grantsOf({}), {});
  assert.deepEqual(grantsOf({ scopes: ["memory"] }), { content: "write", pipeline: "write", session: "write" }, "옛 scope 번역");
  assert.deepEqual(grantsOf({ scopes: ["memory"], grants: null }), { content: "write", pipeline: "write", session: "write" }, "grants 가 null 이면 없는 것과 같다");
  // 보기만 받은 사람의 옛 scope 사본에 memory · admin 이 남아 있어도 고치기 · 관리를 얻지 않는다
  assert.deepEqual(grantsOf({ scopes: ["memory", "admin"], grants: { content: "read" } }), { content: "read" });
  // 새 값이 «아무것도 없음» 이면 그대로 아무것도 없다(빈 객체는 «없음» 이 아니라 «권한 0개» 다)
  assert.deepEqual(grantsOf({ scopes: ["memory", "admin"], grants: {} }), {});
});

test("P10 can — 수준을 안 주면 고치기를 묻는다", () => {
  const viewer = { grants: { content: "read" } as Grants };
  assert.equal(can(viewer, "content", "read"), true);
  assert.equal(can(viewer, "content", "write"), false);
  assert.equal(can(viewer, "content"), false, "기본은 고치기");
  assert.equal(can({ scopes: ["admin"] }, "admin"), true);
  assert.equal(can({ scopes: ["admin"] }, "harness", "read"), false, "admin 은 하네스 설정을 주지 않는다");
  assert.equal(can({ scopes: ["runtime"] }, "harness"), true);
  assert.equal(can({ scopes: ["memory"] }, "pipeline"), true);
  assert.equal(can({ scopes: ["context"] }, "pipeline", "read"), false);
  assert.equal(can(null, "content", "read"), false);
  assert.equal(can({ scopes: [] }, "session", "read"), false);
});

test("P11 위험 권한은 관리 · 자격 · 하네스 설정이다", () => {
  assert.deepEqual([...DANGEROUS_PERMISSIONS].sort(), ["admin", "harness", "secrets"]);
  const fromDangerousScopes = new Set<string>([...DANGEROUS_SCOPES].flatMap((s) => Object.keys(LEGACY_SCOPE_GRANTS[s])));
  assert.deepEqual([...fromDangerousScopes].sort(), [...DANGEROUS_PERMISSIONS].sort(), "옛 위험 scope 가 주는 권한과 같은 집합");
  for (const s of SAFE_SCOPES) {
    for (const p of Object.keys(LEGACY_SCOPE_GRANTS[s])) assert.ok(!DANGEROUS_PERMISSIONS.has(p as Permission), `${s} → ${p}`);
  }
});
