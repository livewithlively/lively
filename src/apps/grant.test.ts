import { strict as assert } from "node:assert";
import test from "node:test";
import { toolMatchesGlob, toolAllowed, resolveGrant } from "./grant.js";
import { parseAppManifest } from "./manifest.js";

function mani(perms: Record<string, unknown>): ReturnType<typeof parseAppManifest> {
  return parseAppManifest({ id: "app1", title: "T", version: "1.0.0", permissions: perms });
}

// ── 글롭 매칭 ─────────────────────────────────────────────────────────────────
test("리터럴 매치", () => {
  assert.ok(toolMatchesGlob("knowledge_search", "knowledge_search"));
  assert.ok(!toolMatchesGlob("knowledge_search", "knowledge_get"));
});

test("접미 글롭 ext__slack__*", () => {
  assert.ok(toolMatchesGlob("ext__slack__*", "ext__slack__send"));
  assert.ok(toolMatchesGlob("ext__slack__*", "ext__slack__")); // * 는 빈 문자열도 매치
  assert.ok(!toolMatchesGlob("ext__slack__*", "ext__notion__read"));
});

test("중간 글롭 + 대소문자 무시", () => {
  assert.ok(toolMatchesGlob("ext__*__send", "ext__slack__send"));
  assert.ok(toolMatchesGlob("KNOWLEDGE_*", "knowledge_search"));
});

test("글롭 특수문자 이스케이프(정규식 인젝션 방지) — * 포함 글롭에서 '.' 는 리터럴", () => {
  // escapeRe 가 없으면 '.' 가 정규식 임의문자가 돼 'a.*' 가 'axb' 에 잘못 매치된다.
  //  escapeRe 가 있으면 'a\..*' 라 '.' 로 시작하는 것만 매치.
  assert.ok(!toolMatchesGlob("a.*", "axb"), "'.' 가 리터럴이면 'axb' 는 'a.*' 에 매치 안 됨");
  assert.ok(toolMatchesGlob("a.*", "a.xyz"));
  // 리터럴(무 글롭) 경로도 확인.
  assert.ok(!toolMatchesGlob("a.b", "axb"));
  assert.ok(toolMatchesGlob("a.b", "a.b"));
});

test("toolAllowed: 여러 글롭 중 하나라도 매치", () => {
  assert.ok(toolAllowed(["knowledge_get", "ext__slack__*"], "ext__slack__send"));
  assert.ok(!toolAllowed(["knowledge_get", "ext__slack__*"], "project_create_v6"));
});

// ── resolveGrant ──────────────────────────────────────────────────────────────
test("요청 미지정 → 매니페스트 전체(상한) 부여", () => {
  const m = mani({ scopes: ["context"], tools: ["knowledge_search"], ext_tools: ["ext__slack__*"] });
  const g = resolveGrant(m);
  assert.deepEqual(g.scopes, ["context"]);
  assert.deepEqual(g.tools, ["knowledge_search", "ext__slack__*"]);
});

test("요청 부분집합 → 좁혀서 부여", () => {
  const m = mani({ scopes: ["context", "memory"], tools: ["knowledge_search", "knowledge_get"] });
  const g = resolveGrant(m, { scopes: ["context"], tools: ["knowledge_get"] });
  assert.deepEqual(g.scopes, ["context"]);
  assert.deepEqual(g.tools, ["knowledge_get"]);
});

test("요청 scope 가 선언 밖 → 거부(넓힘 방지)", () => {
  const m = mani({ scopes: ["context"] });
  assert.throws(() => resolveGrant(m, { scopes: ["memory"] }), /scope 'memory' 는 앱 선언/);
});

test("요청 tool 이 선언 밖 → 거부", () => {
  const m = mani({ tools: ["knowledge_get"] });
  assert.throws(() => resolveGrant(m, { tools: ["project_create_v6"] }), /tool 'project_create_v6' 는 앱 선언 밖/);
});

test("요청 리터럴 tool 이 선언 글롭에 매치 → 허용", () => {
  const m = mani({ ext_tools: ["ext__slack__*"] });
  const g = resolveGrant(m, { tools: ["ext__slack__send"] });
  assert.deepEqual(g.tools, ["ext__slack__send"]);
});

test("요청 글롭 tool 은 선언에 정확히 그 글롭이 있어야(넓힘 보수)", () => {
  const m = mani({ ext_tools: ["ext__slack__*"] });
  assert.doesNotThrow(() => resolveGrant(m, { tools: ["ext__slack__*"] }));
  // 더 넓은 글롭 요청은 거부
  assert.throws(() => resolveGrant(m, { tools: ["ext__*"] }), /글롭 tool 'ext__\*' 는 앱 선언에 없/);
});

test("선언 빈 앱에 tool 요청 → 거부", () => {
  const m = mani({});
  assert.throws(() => resolveGrant(m, { tools: ["knowledge_get"] }), /앱 선언/);
});
