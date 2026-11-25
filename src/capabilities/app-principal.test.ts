// 앱이 사람 이름으로 도는 주체의 권한 (#5799) — 앱 동의가 상한이다.
//  역할을 받은 구성원의 주체에는 새 권한(grants)이 실려 있다. 앱 주체를 만들며 그 주체를 통째로 펼치면 그 사람의 권한이 앱으로 샌다.
//
//  엣지 표:
//   A1 옛 구성원 → 종전 그대로: scopes = 구성원 ∩ 앱 동의 · grants 는 비어 있다(scopes 가 판정)
//   A2 역할 구성원(소유자) · 앱 동의 [memory] → grants = 맥락 · 맥락 관리 · 세션만 — 관리 · 자격 · 하네스 설정 · 코드 · DB 가 새지 않는다
//   A3 역할 구성원(게스트) · 앱 동의 [memory, admin] → 게스트를 넘지 못한다(맥락 보기만)
//   A4 역할 구성원 · 앱 동의가 빈 배열 → grants 가 «권한 0개» 로 실린다(칸이 비면 scopes 사본이 판정하게 된다)
//   A5 판정으로 확인 — 소유자 + 앱 동의 [memory] 의 앱 주체는 지식 저장은 되고 구성원 관리 · 코드 조회는 안 된다
//   A6 appId · 판(address)이 실리고, 사람 주체의 다른 칸(userId 등)은 그대로다 · 원본 주체는 바뀌지 않는다
//   A7 배선 — 앱 주체를 만드는 네 자리와, 구성원 행에서 주체를 만드는 내부 다섯 자리가 그 헬퍼를 쓴다
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { appPrincipalOf } from "./app-tool-call.js";
import { registry, capAllowed } from "./index.js";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { ROLE_GRANTS } from "../auth/permissions.js";
import { SCOPES } from "../auth/scopes.js";

const SRC_ROOT = new URL("../", import.meta.url).pathname.replace("/dist/", "/src/");
const code = (rel: string): string => readFileSync(path.join(SRC_ROOT, rel), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const cap = (name: string): Capability => { const c = registry.get(name); assert.ok(c, name); return c; };
const person = (over: Partial<LivelyUser>): LivelyUser => ({ userId: "alice", email: "a@x", scopes: [], projects: ["*"], tokenSource: "session", ...over });

test("A1 옛 구성원은 종전 그대로다", () => {
  const u = appPrincipalOf(person({ scopes: ["memory", "context", "admin"] }), "deck", ["memory", "db"]);
  assert.deepEqual(u.scopes, ["memory"]);
  assert.equal(u.grants, undefined);
  assert.equal(capAllowed(u, cap("knowledge_save")), true);
  assert.equal(capAllowed(u, cap("category_list")), false, "동의하지 않은 context 는 종전처럼 닫힌다");
  assert.equal(capAllowed(u, cap("org_member_upsert")), false);
});

test("A2 · A5 소유자의 권한이 앱으로 새지 않는다", () => {
  const owner = person({ scopes: [...SCOPES], grants: ROLE_GRANTS.owner });
  const u = appPrincipalOf(owner, "deck", ["memory"]);
  assert.deepEqual(u.grants, { content: "write", pipeline: "write", session: "write" });
  assert.deepEqual(u.scopes, ["memory"]);
  for (const [name, ok] of [
    ["knowledge_save", true], ["knowledge_get", true], ["org_distiller_list", true],
    ["org_member_upsert", false], ["org_credentials", false], ["org_hook_upsert", false], ["repo_file", false], ["delegate_run", false],
  ] as const) assert.equal(capAllowed(u, cap(name)), ok, name);
  // 원본 주체는 바뀌지 않는다
  assert.deepEqual(owner.grants, ROLE_GRANTS.owner);
  assert.deepEqual(owner.scopes, [...SCOPES]);
});

test("A3 앱 동의가 넓어도 구성원을 넘지 못한다", () => {
  const u = appPrincipalOf(person({ scopes: [], grants: ROLE_GRANTS.guest }), "deck", ["memory", "admin", "runtime"]);
  assert.deepEqual(u.grants, { content: "read" });
  assert.equal(capAllowed(u, cap("knowledge_get")), true);
  assert.equal(capAllowed(u, cap("knowledge_save")), false);
});

test("A4 앱 동의가 비면 권한 0개로 실린다", () => {
  const u = appPrincipalOf(person({ scopes: [...SCOPES], grants: ROLE_GRANTS.owner }), "deck", []);
  assert.deepEqual(u.grants, {});
  assert.deepEqual(u.scopes, []);
  assert.equal(capAllowed(u, cap("knowledge_get")), false);
  assert.equal(capAllowed(u, cap("whoami")), true, "로그인만인 기능은 된다");
  // 사본 scopes 가 남아 있었다면 권한 0개가 그것을 이긴다는 것까지
  assert.equal(capAllowed({ ...u, scopes: [...SCOPES] }, cap("org_member_upsert")), false);
});

test("A6 appId · 판이 실리고 나머지 칸은 그대로다", () => {
  const base = person({ scopes: ["memory"], tokenHashPrefix: "abc" });
  const u = appPrincipalOf(base, "deck", ["memory"], "draft");
  assert.equal(u.appId, "deck");
  assert.equal(u.appAddress, "draft");
  assert.equal(u.userId, "alice");
  assert.equal(u.tokenHashPrefix, "abc");
  assert.equal(appPrincipalOf(base, "deck", ["memory"]).appAddress, undefined);
  assert.equal(base.appId, undefined, "원본에 appId 가 생기지 않는다");
});

test("A7 배선 — 주체를 만드는 자리들이 권한 칸 헬퍼를 쓴다", () => {
  // 앱 주체 네 자리 — 앱 동의(와 있으면 다른 상한)로 덮는다
  for (const f of ["capabilities/app-tool-call.ts", "apps/app-server-auth.ts", "apps/app-jobs.ts", "apps/app-server-call.ts"]) {
    assert.match(code(f), /cappedGrantsField\(/, `${f} — 앱 주체에 cappedGrantsField 가 없다`);
  }
  assert.match(code("apps/app-jobs.ts"), /cappedGrantsField\(memberGrants\(member\), grant\.scopes, \.\.\.\(ceiling \? \[\[\.\.\.ceiling\]\] : \[\]\)\)/, "앱 작업은 작업 상한까지 좁힌다");
  assert.match(code("apps/app-server-call.ts"), /cappedGrantsField\(memberGrants\(member\), row\.scopes, grant\.scopes\)/, "앱 선언 도구 부르기는 부른 연결의 상한까지 좁힌다");
  // 구성원 행에서 «사람 본인» 주체를 만드는 자리 — 역할을 받은 구성원이면 새 권한을 싣는다
  for (const f of ["apps/app-front-api.ts", "agent-jobs/launch.ts", "scheduler/actions/app-server-job.ts", "org/slack-bridge/manager.ts", "files/signed-routes.ts", "ai-runs/live.ts"]) {
    assert.match(code(f), /\.\.\.grantsField\(/, `${f} — 구성원 행에서 만든 주체에 grantsField 가 없다`);
  }
  // 로그인 경로 둘
  assert.match(code("auth/sessions.ts"), /memberGrants\(row\)/);
  assert.match(code("org/store/tokens.ts"), /principalGrants\(mg,/);
});
