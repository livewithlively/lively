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
//
//  역할 저장(구성원 행 ↔ 권한):
//   Q1 저장된 값 읽기 — 모르는 권한 · 모르는 수준 · 객체가 아닌 값 · 객체 내장 이름은 버린다
//   Q2 구성원 행의 권한 — 역할이 없거나 모르는 역할이면 «옛 구성원»(undefined · 개별 권한만 있어도) · 개별 권한은 올리기만 한다
//   Q3 옛 이름 사본 — 게스트 없음 · 구성원 = 기본 다섯 · 관리자 + admin · 소유자 일곱 · 보기만 가진 영역은 비치지 않는다(코드 · DB 는 비친다)
//   Q4 주체의 권한 — 따르기 all / safe / none · 어느 경우에도 구성원을 넘지 않는다(역할 4 × scope 부분집합 128 × 방식 3)
//   Q5 앱 주체의 칸 — 옛 구성원이면 칸이 없다 · 역할 구성원이면 상한들과 교집합 · **빈 상한이면 «권한 0개» 로 실린다(칸이 빠지지 않는다)**
import test from "node:test";
import assert from "node:assert/strict";
import { SCOPES, DANGEROUS_SCOPES, SAFE_SCOPES } from "./scopes.js";
import {
  PERMISSIONS, PERMISSION_INFO, isPermission, allows, mergeGrants, legacyScopesToGrants, LEGACY_SCOPE_GRANTS,
  ROLES, ROLE_INFO, ROLE_GRANTS, isRole, intersectGrants, grantsOf, can, DANGEROUS_PERMISSIONS,
  sanitizeGrants, memberGrants, grantsToLegacyScopes, principalGrants, grantsField, cappedGrantsField,
  type Grants, type Level, type Permission,
} from "./permissions.js";
import { DEFAULT_MEMBER_SCOPES } from "./scopes.js";

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

const subsetsOf = <T>(xs: readonly T[]): T[][] => xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);

test("Q1 저장된 값 읽기 — 모르는 것은 버린다", () => {
  assert.deepEqual(sanitizeGrants({ content: "read", code: "write" }), { content: "read", code: "write" });
  assert.deepEqual(sanitizeGrants({ content: "admin", memory: "write", nope: "read", db: "READ", run: true, session: null }), {});
  for (const x of [null, undefined, "content", 7, true, ["content"], [{ content: "write" }]]) assert.deepEqual(sanitizeGrants(x), {}, String(x));
  // JSON 으로 들어온 __proto__ · constructor 는 권한 이름이 아니다
  const evil = JSON.parse('{"__proto__":{"admin":"write"},"constructor":"write","content":"read"}');
  assert.deepEqual(sanitizeGrants(evil), { content: "read" });
  assert.equal(sanitizeGrants(evil).admin, undefined);
  // 물려받은 속성은 읽지 않는다
  assert.deepEqual(sanitizeGrants(Object.create({ admin: "write" })), {});
});

test("Q2 구성원 행의 권한 — 역할이 없으면 옛 구성원이다", () => {
  for (const role of [null, undefined, "", "viewer", "MEMBER", 1, {}]) {
    assert.equal(memberGrants({ role, grants: { admin: "write" } }), undefined, `role=${String(role)}`);
  }
  assert.equal(memberGrants(null), undefined);
  assert.equal(memberGrants(undefined), undefined);
  assert.deepEqual(memberGrants({ role: "member" }), ROLE_GRANTS.member);
  assert.deepEqual(memberGrants({ role: "guest", grants: null }), { content: "read" });
  // 개별 권한은 얹는다 — 코드 보기 → 고치기, 하네스 설정 보기 → 고치기
  assert.deepEqual(memberGrants({ role: "member", grants: { code: "write", harness: "write" } }), { ...ROLE_GRANTS.member, code: "write", harness: "write" });
  // 낮추지는 못한다 — 구성원의 맥락 고치기에 «보기» 를 얹어도 고치기다
  assert.equal(memberGrants({ role: "member", grants: { content: "read" } })?.content, "write");
  // 손상된 개별 권한은 버리고 역할만 남는다
  assert.deepEqual(memberGrants({ role: "guest", grants: "admin" }), { content: "read" });
  assert.deepEqual(memberGrants({ role: "guest", grants: { admin: "everything" } }), { content: "read" });
});

test("Q3 옛 이름 사본", () => {
  const sorted = (a: readonly string[]): string[] => [...a].sort();
  assert.deepEqual(grantsToLegacyScopes(ROLE_GRANTS.guest), []);
  assert.deepEqual(sorted(grantsToLegacyScopes(ROLE_GRANTS.member)), sorted(DEFAULT_MEMBER_SCOPES), "구성원 = 기본 구성원 scope 다섯");
  assert.deepEqual(sorted(grantsToLegacyScopes(ROLE_GRANTS.admin)), sorted([...DEFAULT_MEMBER_SCOPES, "admin"]));
  assert.deepEqual(sorted(grantsToLegacyScopes(ROLE_GRANTS.owner)), sorted([...SCOPES]));
  assert.deepEqual(grantsToLegacyScopes({}), []);
  // 보기만 가진 영역은 비치지 않는다 — 옛 이름은 «고칠 수 있다» 는 뜻이었다
  assert.deepEqual(grantsToLegacyScopes({ content: "read", pipeline: "read", external: "read", admin: "read", harness: "read", secrets: "write" }), []);
  // 코드 · DB 는 원래 보기다
  assert.deepEqual(grantsToLegacyScopes({ code: "read", db: "read" }), ["db", "code"]);
  // 순서는 SCOPES 순서(저장 값이 흔들리지 않게)
  assert.deepEqual(grantsToLegacyScopes(ROLE_GRANTS.owner), [...SCOPES]);
  // 관리자 판정을 scopes 로 하는 옛 자리가 역할과 어긋나지 않는다
  for (const r of ROLES) assert.equal(grantsToLegacyScopes(ROLE_GRANTS[r]).includes("admin"), r === "admin" || r === "owner", r);
  for (const r of ROLES) assert.equal(grantsToLegacyScopes(ROLE_GRANTS[r]).includes("runtime"), r === "owner", r);
});

test("Q4 주체의 권한 — 구성원 ∩ 발급된 상한", () => {
  const { guest, member, admin, owner } = ROLE_GRANTS;
  assert.deepEqual(principalGrants(member, { follow: "all" }), member);
  // 옛 이름으로 적힌 상한 안에서만
  assert.deepEqual(principalGrants(member, { follow: "none", scopes: ["memory"] }), { content: "write", pipeline: "write", session: "write" });
  assert.deepEqual(principalGrants(member, { follow: "none", scopes: [] }), {});
  assert.deepEqual(principalGrants(member, { follow: "none", scopes: null }), {});
  assert.deepEqual(principalGrants(guest, { follow: "none", scopes: ["memory", "admin"] }), { content: "read" }, "게스트의 토큰은 게스트를 넘지 못한다");
  assert.deepEqual(principalGrants(owner, { follow: "none", scopes: ["db"] }), { db: "read" });
  // 로그인 토큰 — 위험 권한은 토큰에 실린 만큼만
  assert.deepEqual(principalGrants(member, { follow: "safe", scopes: [] }), member, "구성원은 위험 권한이 없다 — 하네스 설정 보기는 따른다");
  assert.deepEqual(principalGrants(admin, { follow: "safe", scopes: [] }), { ...member, code: "write" },
    "관리자 기능을 허용하지 않은 연결 — 관리 · 자격이 빠진다(코드 고치기는 위험 권한이 아니라 따른다)");
  assert.deepEqual(principalGrants(admin, { follow: "safe", scopes: ["admin"] }), admin, "허용한 연결은 관리자 역할 그대로(자격은 구성원이 가진 보기까지)");
  assert.deepEqual(principalGrants(owner, { follow: "safe", scopes: ["admin"] }), { ...owner, harness: "read" }, "runtime 을 싣지 않은 연결은 하네스 설정을 고치지 못한다");
  assert.deepEqual(principalGrants(owner, { follow: "safe", scopes: ["admin", "runtime"] }), owner);
  assert.deepEqual(principalGrants(guest, { follow: "safe", scopes: ["admin", "runtime"] }), guest, "게스트는 토큰에 무엇이 실려도 게스트다");
  // 어느 경우에도 구성원을 넘지 않는다
  let checked = 0;
  for (const r of ROLES) {
    for (const set of subsetsOf(SCOPES)) {
      for (const follow of ["safe", "none"] as const) {
        const g = principalGrants(ROLE_GRANTS[r], { follow, scopes: set });
        for (const p of PERMISSIONS) assert.ok(rank(g, p) <= rank(ROLE_GRANTS[r], p), `${r} ${follow} [${set.join(" ")}] ${p}`);
        // 위험 권한의 고치기는 그 옛 scope 가 실렸을 때만
        if (!set.includes("admin")) assert.ok(rank(g, "admin") === 0 && rank(g, "secrets") === 0, `${r} ${follow} admin 없이 관리 · 자격`);
        if (!set.includes("runtime")) assert.ok(rank(g, "harness") <= 1, `${r} ${follow} runtime 없이 하네스 설정 고치기`);
        checked++;
      }
    }
  }
  assert.equal(checked, 4 * 128 * 2);
});

test("Q5 주체에 펼쳐 넣는 칸", () => {
  assert.deepEqual(grantsField({ role: null, grants: { admin: "write" } }), {}, "옛 구성원이면 칸이 없다");
  assert.deepEqual(grantsField(null), {});
  assert.deepEqual(grantsField({ role: "guest" }), { grants: { content: "read" } });
  assert.equal("grants" in grantsField({ role: null }), false);
  // 앱 주체
  assert.deepEqual(cappedGrantsField(undefined, ["memory"]), {}, "옛 구성원이면 칸이 없다");
  assert.deepEqual(cappedGrantsField(null, ["memory"]), {});
  assert.deepEqual(cappedGrantsField(ROLE_GRANTS.member, ["memory", "context"]), { grants: { content: "write", pipeline: "write", session: "write", code: "read", run: "write" } });
  assert.deepEqual(cappedGrantsField(ROLE_GRANTS.owner, ["memory", "admin"], ["memory"]), { grants: { content: "write", pipeline: "write", session: "write" } }, "상한을 차례로 좁힌다");
  // 빈 상한 — 칸이 빠지면 scopes 사본이 판정하게 된다. 반드시 «권한 0개» 로 실려야 한다.
  const empty = cappedGrantsField(ROLE_GRANTS.owner, []);
  assert.deepEqual(empty, { grants: {} });
  assert.equal("grants" in empty, true);
  assert.equal(permitsLike(empty.grants, ["admin", "memory"]), false);
  assert.deepEqual(cappedGrantsField(ROLE_GRANTS.owner, ["memory"], null), { grants: {} }, "상한 하나가 비면 전부 닫힌다");
  // 상한이 하나도 없으면 구성원 그대로(사람 본인)
  assert.deepEqual(cappedGrantsField(ROLE_GRANTS.guest), { grants: { content: "read" } });
});

/** 권한 0개로 실린 주체는 사본 scopes 가 무엇이든 관리 고치기를 얻지 못한다(Q5 의 뜻을 판정으로 확인). */
function permitsLike(grants: Grants | undefined, scopes: string[]): boolean {
  return can({ scopes, grants }, "admin");
}
