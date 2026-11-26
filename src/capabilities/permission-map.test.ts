// 기능 → 새 권한 배정표가 옛 판정과 어디서 갈리는가 (#5799) — 전 기능 × 옛 scope 로 잰다.
//  실행: npm run build && node dist/capabilities/permission-map.test.js
//
//  새 권한은 아직 강제에 쓰이지 않는다. 전환하기 전에 «옛 scope 로 되던 일이 번역 뒤에도 되는가 · 안 되던 일이 새로 열리지
//   않는가» 를 실제 요청을 기다려 표본으로 재지 않고, 등록부의 기능 전부와 옛 scope 조합 전부로 여기서 잰다.
//
//  엣지 표:
//   R1 scope 가 있는 기능은 전부 표에 이름으로 있다 · 표에 남는 이름(없어진 기능 · 로그인만인 기능 · 두 번 적힌 이름)이 없다
//   R2 scope 가 null 인 기능은 새 체계에서도 요구가 없다(로그인만)
//   R3 옛 scope 하나가 열던 기능은 번역 뒤에도 열린다 — 예외는 NARROWED 에 적힌 것이 전부다
//   R4 안전한 scope 를 어떻게 모아도 옛 admin · runtime 기능은 하나도 열리지 않는다 · admin 은 runtime 기능을, runtime 은 admin 기능을 못 연다
//   R5 일곱 개를 다 가진 사람은 전부 된다(NARROWED 포함)
//   R6 넓어지는 자리는 이 표가 전부다(옛 scope 쌍마다 몇 개가 새로 열리나) · 기본 구성원에게 새로 열리는 것은 없다
//   R7 수준 — 보기만 받으면 바꾸는 기능은 막힌다
//   R8 역할 — 게스트 · 구성원 · 관리자 · 소유자가 여는 것, 그리고 구성원 역할이 지금의 기본 구성원과 달라지는 자리
//   R9 표에 없는 이름(상용 모듈의 기능)은 옛 scope 의 본줄기 권한으로 떨어진다
import test from "node:test";
import assert from "node:assert/strict";
import { registry, capMutates } from "./index.js";
import type { Capability } from "./types.js";
import { SCOPES, SAFE_SCOPES, DEFAULT_MEMBER_SCOPES, type Scope } from "../auth/scopes.js";
import { allows, legacyScopesToGrants, ROLE_GRANTS, PERMISSIONS, type Grants, type Need, type Permission } from "../auth/permissions.js";
import { CAPABILITY_PERMISSIONS, NARROWED, LEGACY_DEFAULT, needFor, permissionOf, isMapped } from "./permission-map.js";

const caps: Capability[] = [...registry.values()];
const scoped = caps.filter((c) => c.scope !== null);
const need = (c: Capability): Need | null => needFor(c.name, c.scope, capMutates(c));
const legacyAllows = (scopes: readonly string[], c: Capability): boolean => c.scope === null || scopes.includes(c.scope);
const newAllows = (scopes: readonly string[], c: Capability): boolean => allows(legacyScopesToGrants(scopes), need(c));
const cap = (name: string): Capability => {
  const c = registry.get(name);
  assert.ok(c, `등록부에 ${name} 이 있어야 한다`);
  return c;
};
const roleAllows = (g: Grants, name: string): boolean => allows(g, need(cap(name)));
const subsets = <T>(xs: readonly T[]): T[][] => xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);
const names = (cs: Capability[]): string[] => cs.map((c) => c.name).sort();
const TEAM_EDITS = ["team_create", "team_delete", "team_set_members", "team_update"];

test("R0 배선 — 등록부가 실제로 실려 있다(빈 등록부면 아래 검사가 전부 헛돈다)", () => {
  assert.ok(caps.length > 600, `등록부 기능 ${caps.length}개`);
  assert.ok(scoped.length > 400, `scope 있는 기능 ${scoped.length}개`);
  for (const s of SCOPES.filter((x) => x !== "db")) assert.ok(scoped.some((c) => c.scope === s), `scope ${s} 인 기능이 있다`);
  assert.ok(scoped.some((c) => capMutates(c)) && scoped.some((c) => !capMutates(c)), "바꾸는 기능과 조회 기능이 둘 다 있다");
});

test("R1 scope 가 있는 기능은 전부 표에 있고, 표에 남는 이름이 없다", () => {
  const missing = scoped.filter((c) => !isMapped(c.name)).map((c) => `${c.name} (scope ${c.scope})`);
  assert.deepEqual(missing, [],
    "새 기능을 capabilities/permission-map.ts 의 CAPABILITY_PERMISSIONS 에 한 줄 더해 주세요 — 어느 권한인지는 그 파일 머리말에 있습니다");
  const all: string[] = Object.values(CAPABILITY_PERMISSIONS).flatMap((ns) => [...ns]);
  assert.equal(new Set(all).size, all.length, `두 번 적힌 이름: ${all.filter((n, i) => all.indexOf(n) !== i).join(", ")}`);
  assert.deepEqual(all.filter((n) => !registry.has(n)), [], "등록부에 없는 이름 — 지워졌거나 이름이 바뀐 기능");
  assert.deepEqual(all.filter((n) => registry.get(n)?.scope === null), [], "scope 가 null 인 기능은 표에 적지 않는다");
  assert.deepEqual(Object.keys(CAPABILITY_PERMISSIONS).sort(), [...PERMISSIONS].sort());
  assert.deepEqual(CAPABILITY_PERMISSIONS.db, [], "DB 조회 3종은 등록부 밖이다(tools/db.ts)");
});

test("R2 scope 가 null 인 기능은 새 체계에서도 로그인만이다", () => {
  const loginOnly = caps.filter((c) => c.scope === null);
  assert.ok(loginOnly.length > 100, "로그인만인 기능이 등록부에 있다");
  for (const c of loginOnly) {
    assert.equal(need(c), null, `${c.name}`);
    assert.equal(newAllows([], c), true, `${c.name} — 권한이 하나도 없어도 된다`);
  }
});

test("R3 옛 scope 하나가 열던 기능은 번역 뒤에도 열린다 — 예외는 NARROWED 가 전부다", () => {
  const narrowed = scoped.filter((c) => !newAllows([c.scope as Scope], c));
  assert.deepEqual(names(narrowed), Object.keys(NARROWED).sort());
  for (const [name, why] of Object.entries(NARROWED)) {
    assert.ok(registry.has(name), `NARROWED 의 ${name} 이 등록부에 없다`);
    assert.ok(why.length > 0, `${name} — 왜 좁히는지 적는다`);
  }
  // 좁아진 기능도 옛 scope 를 다 모으면 열린다 — 아무도 못 쓰는 기능이 생기지 않는다
  for (const name of Object.keys(NARROWED)) assert.equal(newAllows(SCOPES, cap(name)), true, name);
});

test("R4 안전한 scope 를 어떻게 모아도 옛 admin · runtime 기능은 열리지 않는다", () => {
  const dangerous = scoped.filter((c) => c.scope === "admin" || c.scope === "runtime");
  assert.ok(dangerous.length > 80);
  const sets = subsets(SAFE_SCOPES);
  assert.equal(sets.length, 32, "안전한 scope 5개의 부분집합 전부");
  for (const set of sets) {
    assert.deepEqual(names(dangerous.filter((c) => newAllows(set, c))), [], `[${set.join(" ")}] 로 위험 기능이 열렸다`);
  }
  const adminCaps = scoped.filter((c) => c.scope === "admin");
  const runtimeCaps = scoped.filter((c) => c.scope === "runtime");
  assert.deepEqual(names(runtimeCaps.filter((c) => newAllows(SCOPES.filter((s) => s !== "runtime"), c))), [], "admin 을 가져도 runtime 기능은 안 열린다");
  assert.deepEqual(names(adminCaps.filter((c) => newAllows(SCOPES.filter((s) => s !== "admin"), c))), [], "runtime 을 가져도 admin 기능은 안 열린다");
  // 반대 방향 — 표가 안전한 scope 의 기능을 위험 권한으로 옮긴 자리는 없다(팀 편집을 «관리» 로 올렸던 것은 2026-11-26 에 되돌렸다 — 조건부 관리자 검사는 핸들러에 있다)
  const movedUp = scoped.filter((c) => c.scope !== "admin" && c.scope !== "runtime"
    && ["admin", "secrets", "harness"].includes(permissionOf(c.name, c.scope) as Permission));
  assert.deepEqual(names(movedUp), []);
  // 위험 scope 의 기능이 안전한 권한으로 내려간 자리는 없다
  const movedDown = dangerous.filter((c) => !["admin", "secrets", "harness"].includes(permissionOf(c.name, c.scope) as Permission));
  assert.deepEqual(names(movedDown), []);
});

test("R5 일곱 개를 다 가진 사람은 전부 된다", () => {
  assert.deepEqual(names(caps.filter((c) => !newAllows(SCOPES, c))), []);
});

test("R6 넓어지는 자리는 이 표가 전부다", () => {
  // 옛 scope A 의 기능이, A 없이 B 만 가진 사람에게 새로 열리는 수. 키 = «A←B».
  const widened: Record<string, number> = {};
  for (const c of scoped) {
    for (const other of SCOPES) {
      if (other === c.scope || !newAllows([other], c)) continue;
      const k = `${c.scope}←${other}`;
      widened[k] = (widened[k] ?? 0) + 1;
    }
  }
  // 네 쌍뿐이다:
  //  · «맥락» — context 의 분류체계 · 도메인맵 · 공유폴더 파일과 memory 의 지식 · 프로젝트가 서로 열린다
  //  · «코드» «원격 실행» — context 의 레포 등록부 조회 · 위탁과 code 의 레포 판 읽기 · 프리뷰가 서로 열린다
  assert.deepEqual(Object.keys(widened).sort(), ["code←context", "context←code", "context←memory", "memory←context"]);
  assert.deepEqual(widened, EXPECTED_WIDENED);

  // 기본 구성원(items · context · memory · db · code)에게 새로 열리는 것도 닫히는 것도 없다
  const opened = scoped.filter((c) => !legacyAllows(DEFAULT_MEMBER_SCOPES, c) && newAllows(DEFAULT_MEMBER_SCOPES, c));
  const closed = scoped.filter((c) => legacyAllows(DEFAULT_MEMBER_SCOPES, c) && !newAllows(DEFAULT_MEMBER_SCOPES, c));
  assert.deepEqual(names(opened), []);
  assert.deepEqual(names(closed), []);
});

test("R7 보기만 받으면 바꾸는 기능은 막힌다", () => {
  const read: Grants = { content: "read", pipeline: "read", code: "read", harness: "read", secrets: "read", admin: "read" };
  for (const [name, ok] of [
    ["knowledge_get", true], ["knowledge_search", true], ["knowledge_save", false], ["knowledge_delete", false],
    ["project_get_v6", true], ["task_create_v6", false],
    ["org_distiller_list", true], ["org_distiller_upsert", false], ["cron_list", true], ["cron_set", false],
    ["repo_file", true], ["repo_list", true], ["repo_delete", false],
    ["org_hooks", true], ["org_hook_upsert", false],
    ["org_credentials", true], ["org_credential_set", false],
    ["org_audit_list", true], ["org_member_upsert", false],
  ] as const) assert.equal(roleAllows(read, name), ok, name);
  // 바꾸는 기능은 전부 고치기를 요구한다 — 보기 수준만으로 열리는 쓰기가 등록부에 하나도 없다
  const allRead = Object.fromEntries(PERMISSIONS.map((p) => [p, "read"])) as Grants;
  assert.deepEqual(names(scoped.filter((c) => capMutates(c) && allows(allRead, need(c)))), []);
  // 조회 기능은 보기 수준으로 전부 열린다
  assert.deepEqual(names(scoped.filter((c) => !capMutates(c) && !allows(allRead, need(c)))), []);
});

test("R8 역할이 여는 것", () => {
  const { guest, member, admin, owner } = ROLE_GRANTS;
  // 게스트 — 맥락의 조회만. 그 밖의 scope 있는 기능은 하나도 안 열린다.
  const guestOpen = scoped.filter((c) => allows(guest, need(c)));
  assert.ok(guestOpen.length > 40);
  assert.ok(guestOpen.every((c) => permissionOf(c.name, c.scope) === "content" && !capMutates(c)));
  for (const name of ["knowledge_save", "browser_navigate", "browser_status", "repo_file", "org_distiller_list", "delegate_run", "org_hooks"]) {
    assert.equal(roleAllows(guest, name), false, `게스트 ${name}`);
  }
  assert.equal(roleAllows(guest, "knowledge_get"), true);
  // 구성원
  for (const [name, ok] of [
    ["knowledge_save", true], ["org_distiller_upsert", true], ["org_github_connect", true], ["repo_file", true], ["browser_navigate", true],
    ["delegate_run", true], ["preview_env_ensure", true], ["org_hooks", true],
    ["repo_create", false], ["org_hook_upsert", false], ["org_member_upsert", false], ["org_credentials", false], ["org_token_mint", false],
    ["team_set_members", true],   // 표로는 열려 있다 — 팀이 권한을 받는 단위가 된 조직에서는 핸들러(teams.ts requireTeamWrite)가 관리자만 받는다
  ] as const) assert.equal(roleAllows(member, name), ok, `구성원 ${name}`);
  // 관리자 — 자격은 보기만, 하네스 설정도 보기만
  for (const [name, ok] of [
    ["org_member_upsert", true], ["team_set_members", true], ["repo_create", true], ["org_db_source_upsert", true],
    ["org_credentials", true], ["org_tokens", true], ["org_credential_set", false], ["org_token_mint", false],
    ["org_hooks", true], ["org_hook_upsert", false], ["org_harness_asset_upsert", false],
  ] as const) assert.equal(roleAllows(admin, name), ok, `관리자 ${name}`);
  // 소유자 — 전부
  assert.deepEqual(names(caps.filter((c) => !allows(owner, need(c)))), []);

  // 구성원 역할이 지금의 기본 구성원(items · context · memory · db · code)과 달라지는 자리 — 역할로 옮길 때 이만큼 바뀐다
  const lost = scoped.filter((c) => legacyAllows(DEFAULT_MEMBER_SCOPES, c) && !allows(member, need(c)));
  const gained = scoped.filter((c) => !legacyAllows(DEFAULT_MEMBER_SCOPES, c) && allows(member, need(c)));
  assert.deepEqual(names(lost), [
    "repo_create", "repo_delete", "repo_deprecate", "repo_refresh", "repo_rename", "repo_set_source",   // 코드 고치기(레포 등록부)는 관리자부터
  ]);
  assert.deepEqual(names(TEAM_EDITS.map(cap).filter((c) => !allows(member, need(c)))), [], "팀 편집은 구성원 역할에게도 표로는 열려 있다");
  assert.deepEqual(names(gained), [   // 하네스 설정 보기 — 무엇이 깔려 있는지는 구성원도 본다
    "org_asset_members", "org_asset_prefs", "org_harness_assets", "org_hooks", "org_http_tool_presets", "org_tools",
  ]);
});

test("R9 표에 없는 이름은 옛 scope 의 본줄기 권한으로 떨어진다", () => {
  assert.equal(isMapped("vis_break_glass_start"), false, "상용 모듈의 기능은 표에 없다");
  assert.equal(permissionOf("vis_break_glass_start", "admin"), "admin");
  assert.deepEqual(needFor("db_audit_list", "admin", false), { perm: "admin", level: "read" });
  assert.deepEqual(needFor("some_future_tool", "runtime", true), { perm: "harness", level: "write" });
  assert.equal(needFor("some_future_tool", null, true), null);
  assert.deepEqual(Object.keys(LEGACY_DEFAULT).sort(), [...SCOPES].sort());
  // 표에 빠진 기능이 옛 scope 로 못 쓰게 되는 일이 없다 — 조회든 변경이든 그 scope 의 번역이 기본 권한을 덮는다.
  //  (db · code 는 번역이 보기까지만 준다 — db 는 조회 전용이고, code 의 변경 기능은 표가 «원격 실행» 으로 적는다)
  for (const s of SCOPES) {
    assert.equal(newAllowsNeed([s], needFor("some_future_tool", s, false)), true, `${s} 조회`);
    if (s !== "db" && s !== "code") assert.equal(newAllowsNeed([s], needFor("some_future_tool", s, true)), true, `${s} 변경`);
  }
});

function newAllowsNeed(scopes: readonly string[], n: Need | null): boolean {
  return allows(legacyScopesToGrants(scopes), n);
}

// 넓어지는 쌍마다 새로 열리는 기능 수 — 표를 고쳐 이 수가 바뀌면 «누구에게 무엇이 더 열리는가» 가 바뀐 것이다.
const EXPECTED_WIDENED: Record<string, number> = {
  "context←memory": 39,   // context 의 맥락 34 + 수집 설정 조회 1(member_ai_connectors) + 팀 편집 4(«맥락» 고치기 — 팀이 권한 단위인 조직에서는 핸들러가 관리자만 받는다)
  "memory←context": 152,  // memory 의 맥락 전부
  "context←code": 13,     // 레포 등록부 조회 4 + 위탁 · 에이전트 작업 9
  "code←context": 12,     // code 의 기능 전부(레포 판 읽기 5 + 프리뷰 · 브로커 7)
};
