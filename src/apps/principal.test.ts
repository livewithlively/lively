import { strict as assert } from "node:assert";
import test from "node:test";
import { decideAppTool, APP_TOKEN_TTL_SEC } from "./principal.js";

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

test("앱 토큰 TTL 은 유한·양수(고아 토큰 방지)", () => {
  assert.ok(APP_TOKEN_TTL_SEC > 0 && Number.isFinite(APP_TOKEN_TTL_SEC));
});
