import { strict as assert } from "node:assert";
import test from "node:test";
import { decideAppTool, APP_TOKEN_TTL_SEC, APP_TOOL_EXEMPT } from "./principal.js";

// 순수 판정 — appId·grant.tools·도구이름만으로 (design D3 경계 로직).
test("일반 세션(appId 없음) → 항상 허용", () => {
  assert.equal(decideAppTool(undefined, null, "knowledge_search"), true);
  assert.equal(decideAppTool(undefined, [], "anything"), true);
});

test("앱 세션 + grant 사라짐(tools null) → fail-closed(전부 차단)", () => {
  assert.equal(decideAppTool("hello", null, "knowledge_search"), false);
});

test("앱 세션 + 빈 allowlist → 아무 도구도 안 됨", () => {
  assert.equal(decideAppTool("hello", [], "knowledge_search"), false);
});

test("앱 세션 + 리터럴 allowlist", () => {
  assert.equal(decideAppTool("hello", ["knowledge_search", "knowledge_get"], "knowledge_search"), true);
  assert.equal(decideAppTool("hello", ["knowledge_search"], "project_create_v6"), false);
});

test("앱 세션 + 글롭 allowlist(ext__slack__*)", () => {
  assert.equal(decideAppTool("hello", ["ext__slack__*"], "ext__slack__send"), true);
  assert.equal(decideAppTool("hello", ["ext__slack__*"], "ext__notion__read"), false);
});

// ── EXEMPT(#1780 PR3c) — 인프라/훅 세션-플럼빙 능력은 grant 무관 통과, 콘텐츠 쓰기는 계속 게이트 ──

test("EXEMPT 인프라 능력 → grant.tools 가 null 이어도 통과(세션 배관은 안 끊긴다)", () => {
  // grant 사라짐(null)이면 콘텐츠 도구는 막히지만(위 fail-closed 테스트) 인프라 배관은 살아 있어야 한다.
  assert.equal(decideAppTool("hello", null, "whoami"), true);
  assert.equal(decideAppTool("hello", null, "org_preview"), true);
  assert.equal(decideAppTool("hello", null, "org_runtime_config"), true);
  assert.equal(decideAppTool("hello", null, "org_runner_assets"), true);
  assert.equal(decideAppTool("hello", null, "org_runner_hooks"), true);
  assert.equal(decideAppTool("hello", null, "org_runner_hook_report"), true);
  assert.equal(decideAppTool("hello", null, "me_harness_report"), true);
  assert.equal(decideAppTool("hello", null, "me_harness_local_pref_plan"), true);
});

test("EXEMPT 인프라 능력 → 빈 allowlist(grant 는 있으나 아무 도구도 안 준) 여도 통과", () => {
  assert.equal(decideAppTool("hello", [], "whoami"), true);
  assert.equal(decideAppTool("hello", [], "org_runner_assets"), true);
});

test("콘텐츠 쓰기 능력은 EXEMPT 아님 — grant 밖이면 계속 차단(회귀 가드)", () => {
  // 이 목록에 콘텐츠 쓰기가 새어 들어오면(EXEMPT 오염) 이 단언이 깨진다.
  for (const write of ["knowledge_save", "source_save", "db_query", "project_create_v6", "org_runtime_update"]) {
    assert.equal(decideAppTool("hello", [], write), false, `${write} 는 grant 밖에서 차단돼야 한다`);
    assert.equal(decideAppTool("hello", null, write), false, `${write} 는 grant null 에서 차단돼야 한다`);
    assert.equal(APP_TOOL_EXEMPT.has(write), false, `${write} 는 EXEMPT 에 없어야 한다`);
  }
});

test("EXEMPT 는 읽기/보고/인프라만(콘텐츠 쓰기 이름 0건) — 목록 오염 가드", () => {
  // 쓰기를 시사하는 이름이 EXEMPT 에 없음을 정적 검사. save/create/update/delete/query 접미·접두 금지.
  for (const name of APP_TOOL_EXEMPT) {
    assert.ok(
      !/(save|create|update|delete|remove|set|query|upsert|mint|revoke|_v6)$/.test(name) && !/^db_/.test(name),
      `EXEMPT 에 쓰기성 이름이 있음: ${name}`,
    );
  }
});

test("앱 토큰 TTL 은 유한·양수(고아 토큰 방지)", () => {
  assert.ok(APP_TOKEN_TTL_SEC > 0 && Number.isFinite(APP_TOKEN_TTL_SEC));
});
