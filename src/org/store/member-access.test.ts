// 구성원 저장의 역할 · 개별 권한 · scopes 풀이 (#5799) — resolveMemberAccess(순수).
//  실제 행에 적히는 값과 로그인 경로는 auth/member-role.pg-test.mjs 가 잰다. 여기는 «무엇을 저장할 것인가» 의 규칙만.
//
//  엣지 표:
//   M1 새 구성원 · 아무것도 안 줌            → 구성원 역할 · 개별 권한 빈 것 · scopes = 그 사본(기본 다섯)
//   M13 새 구성원 · scopes 만 줌(빈 배열 포함) → 옛 방식 그대로(옛 클라이언트 · 권한 없는 시스템 구성원)
//   M14 새 구성원 · 개별 권한만 줌            → 구성원 역할 + 그 개별 권한
//   M15 새 구성원 · role: null 을 명시         → 옛 방식 · 기본 scope 다섯(일부러 고른 옛 방식)
//   M16 옛 구성원 · 아무것도 안 줌            → 그대로(이름만 고친 저장이 권한을 역할로 옮기지 않는다)
//   M17 새 구성원 · scopes + 개별 권한(역할 없음) → 거절
//   M2 옛 구성원 · scopes 만 줌               → 그 scopes 그대로(역할 없음)
//   M3 역할을 줌                              → 역할 · 개별 권한 빈 것 · scopes = 그 역할의 사본
//   M4 역할 + 개별 권한                       → 사본에 개별 권한이 비친다(하네스 설정 고치기 → runtime)
//   M5 역할 구성원 · scopes 를 사본 그대로 줌(순서 달라도) → 받는다(옛 화면이 구성원을 통째로 다시 보내는 저장)
//   M6 역할 구성원 · scopes 를 다르게 줌       → 거절(역할이 조용히 사라지지 않는다)
//   M7 역할과 scopes 를 함께 줌               → 사본과 다르면 거절
//   M8 역할을 걷음(null)                      → 옛 구성원 · 개별 권한 없음 · scopes 는 준 값(없으면 지금 값)
//   M9 옛 구성원에게 개별 권한만              → 거절 · 빈 개별 권한은 무해
//   M10 역할을 바꾸며 개별 권한 생략 → 비운다 / 역할을 안 건드리며 생략 → 지킨다 / 주면 바꾼다
//   M11 게스트                                → scopes 사본이 빈 배열
//   M12 손상된 개별 권한 입력                 → 모르는 것은 버리고 저장한다
import test from "node:test";
import assert from "node:assert/strict";
import { resolveMemberAccess } from "./members.js";
import { DEFAULT_MEMBER_SCOPES } from "../../auth/scopes.js";
import type { Grants } from "../../auth/permissions.js";

const sorted = (a: readonly string[]): string[] => [...a].sort();
const FIVE = sorted(DEFAULT_MEMBER_SCOPES);
const legacy = (scopes: string[]) => ({ role: null, grants: {} as Grants, scopes });
const roleMember = (extras: Grants = {}) => ({ role: "member" as const, grants: extras, scopes: [...DEFAULT_MEMBER_SCOPES] });

test("M1 새 구성원은 구성원 역할로 시작한다", () => {
  const r = resolveMemberAccess(null, {});
  assert.equal(r.role, "member");
  assert.deepEqual(r.grants, {});
  assert.deepEqual(sorted(r.scopes), FIVE);
});

test("M13 새 구성원에게 scopes 만 주면 옛 방식 그대로 만든다", () => {
  assert.deepEqual(resolveMemberAccess(null, { scopes: ["items", "admin"] }), { role: null, grants: null, scopes: ["items", "admin"] });
  assert.deepEqual(resolveMemberAccess(null, { scopes: [] }), { role: null, grants: null, scopes: [] }, "권한 없는 시스템 구성원");
});

test("M14 새 구성원에게 개별 권한만 주면 구성원 역할 위에 얹는다", () => {
  const r = resolveMemberAccess(null, { grants: { code: "write" } });
  assert.equal(r.role, "member");
  assert.deepEqual(r.grants, { code: "write" });
});

test("M15 새 구성원에게 role: null 을 명시하면 옛 방식이다", () => {
  const r = resolveMemberAccess(null, { role: null });
  assert.equal(r.role, null);
  assert.equal(r.grants, null);
  assert.deepEqual(sorted(r.scopes), FIVE);
});

test("M16 옛 구성원은 아무것도 안 주면 그대로다", () => {
  assert.deepEqual(resolveMemberAccess(legacy(["items", "admin"]), {}), { role: null, grants: null, scopes: ["items", "admin"] });
  assert.deepEqual(resolveMemberAccess(legacy([]), {}), { role: null, grants: null, scopes: [] });
});

test("M17 새 구성원에게 scopes 와 개별 권한을 역할 없이 함께 주면 거절한다", () => {
  assert.throws(() => resolveMemberAccess(null, { scopes: ["items"], grants: { code: "write" } }), /역할이 있는 구성원/);
});

test("M2 옛 구성원의 scopes 저장은 종전 그대로", () => {
  assert.deepEqual(resolveMemberAccess(legacy(["items"]), { scopes: ["memory", "admin"] }), { role: null, grants: null, scopes: ["memory", "admin"] });
  assert.deepEqual(resolveMemberAccess(legacy(["items"]), {}), { role: null, grants: null, scopes: ["items"] });
  assert.deepEqual(resolveMemberAccess(legacy(["items"]), { scopes: [] }), { role: null, grants: null, scopes: [] });
});

test("M3 · M4 · M11 역할을 주면 scopes 는 그 사본이다", () => {
  const m = resolveMemberAccess(legacy(["items"]), { role: "member" });
  assert.equal(m.role, "member");
  assert.deepEqual(m.grants, {});
  assert.deepEqual(sorted(m.scopes), FIVE);
  const withHarness = resolveMemberAccess(null, { role: "member", grants: { harness: "write" } });
  assert.deepEqual(withHarness.grants, { harness: "write" });
  assert.deepEqual(sorted(withHarness.scopes), sorted([...DEFAULT_MEMBER_SCOPES, "runtime"]));
  assert.deepEqual(resolveMemberAccess(null, { role: "guest" }), { role: "guest", grants: {}, scopes: [] });
  assert.deepEqual(sorted(resolveMemberAccess(null, { role: "admin" }).scopes), sorted([...DEFAULT_MEMBER_SCOPES, "admin"]));
});

test("M5 · M6 역할 구성원의 scopes 저장 — 사본과 같을 때만 받는다", () => {
  const before = roleMember();
  const same = resolveMemberAccess(before, { scopes: [...DEFAULT_MEMBER_SCOPES].reverse() });
  assert.equal(same.role, "member");
  assert.deepEqual(sorted(same.scopes), FIVE);
  assert.throws(() => resolveMemberAccess(before, { scopes: [...DEFAULT_MEMBER_SCOPES, "admin"] }), /역할로 권한을 받습니다/);
  assert.throws(() => resolveMemberAccess(before, { scopes: [] }), /역할로 권한을 받습니다/);
  assert.throws(() => resolveMemberAccess(before, { scopes: ["items", "items", "context", "memory", "db"] }), /역할로 권한을 받습니다/, "개수만 같고 내용이 다르면 거절");
});

test("M7 역할과 scopes 를 함께 주면 사본과 같아야 한다", () => {
  assert.throws(() => resolveMemberAccess(null, { role: "guest", scopes: ["memory"] }), /함께 줄 수 없습니다/);
  assert.doesNotThrow(() => resolveMemberAccess(null, { role: "guest", scopes: [] }));
});

test("M8 역할을 걷으면 옛 구성원으로 돌아간다", () => {
  const before = roleMember({ harness: "write" });
  assert.deepEqual(resolveMemberAccess(before, { role: null }), { role: null, grants: null, scopes: before.scopes });
  assert.deepEqual(resolveMemberAccess(before, { role: null, scopes: ["items"] }), { role: null, grants: null, scopes: ["items"] });
});

test("M9 옛 구성원에게 개별 권한만 줄 수는 없다", () => {
  assert.throws(() => resolveMemberAccess(legacy(["memory"]), { grants: { code: "write" } }), /역할이 있는 구성원에게만/);
  assert.throws(() => resolveMemberAccess(roleMember(), { role: null, grants: { code: "write" } }), /역할이 있는 구성원에게만/);
  assert.deepEqual(resolveMemberAccess(legacy(["memory"]), { grants: {} }), { role: null, grants: null, scopes: ["memory"] });
});

test("M10 개별 권한 — 역할을 바꾸면 비우고, 안 건드리면 지킨다", () => {
  const before = roleMember({ code: "write" });
  assert.deepEqual(resolveMemberAccess(before, {}).grants, { code: "write" }, "아무것도 안 주면 지킨다");
  assert.deepEqual(resolveMemberAccess(before, { role: "admin" }).grants, {}, "역할을 바꾸며 생략하면 비운다");
  assert.deepEqual(resolveMemberAccess(before, { role: "member" }).grants, {}, "같은 역할을 다시 줘도 «역할을 준 저장» 이다");
  assert.deepEqual(resolveMemberAccess(before, { grants: { harness: "read" } }).grants, { harness: "read" }, "주면 통째로 바꾼다");
  assert.deepEqual(resolveMemberAccess(before, { grants: {} }).grants, {}, "빈 것을 주면 비운다");
});

test("M12 손상된 개별 권한은 모르는 것을 버리고 저장한다", () => {
  const r = resolveMemberAccess(null, { role: "guest", grants: { content: "write", nope: "read", admin: "all" } as unknown as Grants });
  assert.deepEqual(r.grants, { content: "write" });
  assert.deepEqual(sorted(r.scopes), ["context", "memory"]);
});
