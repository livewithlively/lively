// 앱 맥락 범위(#5100) — 저장된 매니페스트에서 범위 선언 읽기(사양 C · DB 없음). 판 고르기 · 카테고리 id 풀이 · 거절 기록은 app-context.pg-test.mjs.
//  D1 칸 없음 · 매니페스트 자체가 없음/객체 아님 = 범위 없음(null) · D2 객체 = 두 목록(중복 · 글이 아닌 값 버림)
//  D3 null · 글 · 배열(모양이 틀림) = 빈 선언(닫힘 — 넓게 열지 않는다) · D4 목록 칸이 없으면 그 목록은 빈 것
import { strict as assert } from "node:assert";
import test from "node:test";
import { appContextDeclOf } from "./app-context.js";

test("D1 칸 없음 · 매니페스트가 없음/객체 아님 — 범위 없음", () => {
  assert.equal(appContextDeclOf({ id: "a" }), null);
  assert.equal(appContextDeclOf({ id: "a", context: undefined }), null);
  assert.equal(appContextDeclOf(null), null);
  assert.equal(appContextDeclOf(undefined), null);
  assert.equal(appContextDeclOf("x"), null);
});

test("D2 객체 — 두 목록 · 중복 · 글이 아닌 값은 버린다", () => {
  assert.deepEqual(appContextDeclOf({ context: { knowledge_categories: ["p", "p", 3, "", null, "q"], source_kinds: ["slack", "slack", {}] } }),
    { knowledgeCategories: ["p", "q"], sourceKinds: ["slack"] });
});

test("D3 모양이 틀림(null · 글 · 배열) — 빈 선언(닫힘)", () => {
  for (const bad of [null, "policy", ["policy"]]) {
    assert.deepEqual(appContextDeclOf({ context: bad }), { knowledgeCategories: [], sourceKinds: [] }, JSON.stringify(bad));
  }
});

test("D4 목록 칸이 없으면 그 목록은 빈 것", () => {
  assert.deepEqual(appContextDeclOf({ context: {} }), { knowledgeCategories: [], sourceKinds: [] });
  assert.deepEqual(appContextDeclOf({ context: { knowledge_categories: ["p"] } }), { knowledgeCategories: ["p"], sourceKinds: [] });
  assert.deepEqual(appContextDeclOf({ context: { knowledge_categories: "p" } }), { knowledgeCategories: [], sourceKinds: [] });
});
