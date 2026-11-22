// 앱 맥락 범위(#5100) — 저장된 매니페스트에서 범위 선언 읽기(사양 C · DB 없음). 판 고르기 · 카테고리 id 풀이 · 거절 기록은 app-context.pg-test.mjs.
//  D1 칸 없음 · 매니페스트 자체가 없음/객체 아님 = 범위 없음(null) · D2 객체 = 두 목록(중복 · 글이 아닌 값 버림)
//  D3 null · 글 · 배열(모양이 틀림) = 빈 선언(닫힘 — 넓게 열지 않는다) · D4 목록 칸이 없으면 그 목록은 빈 것
//  D5 «도구 전부» 거절(상민 2026-10-29 결정): 맥락 범위를 선언한 앱이 permissions.tools · ext_tools 에 글자 없는 꼴(* · ** · *_*)을 적으면 저장 400 ·
//     이름이 든 좁은 꼴(knowledge_* · *_get)과 정확한 이름은 된다 · 범위를 선언하지 않은 앱은 «전부» 도 그대로(무회귀) · 범위를 적었는데 카테고리가 없어도 거절
//     (이 판정은 DB 를 보기 전에 한다 — 아래 행은 DB 없이 돈다)
import { strict as assert } from "node:assert";
import test from "node:test";
import { appContextDeclOf, assertAppRepoAllowed, assertContextInstallable } from "./app-context.js";

test("D1 칸 없음 · 매니페스트가 없음/객체 아님 — 범위 없음", () => {
  assert.equal(appContextDeclOf({ id: "a" }), null);
  assert.equal(appContextDeclOf({ id: "a", context: undefined }), null);
  assert.equal(appContextDeclOf(null), null);
  assert.equal(appContextDeclOf(undefined), null);
  assert.equal(appContextDeclOf("x"), null);
});

test("D2 객체 — 두 목록 · 중복 · 글이 아닌 값은 버린다", () => {
  assert.deepEqual(appContextDeclOf({ context: { knowledge_categories: ["p", "p", 3, "", null, "q"], source_kinds: ["slack", "slack", {}] } }),
    { knowledgeCategories: ["p", "q"], sourceKinds: ["slack"], repos: [] });
});

test("D3 모양이 틀림(null · 글 · 배열) — 빈 선언(닫힘)", () => {
  for (const bad of [null, "policy", ["policy"]]) {
    assert.deepEqual(appContextDeclOf({ context: bad }), { knowledgeCategories: [], sourceKinds: [], repos: [] }, JSON.stringify(bad));
  }
});

test("D4 목록 칸이 없으면 그 목록은 빈 것", () => {
  assert.deepEqual(appContextDeclOf({ context: {} }), { knowledgeCategories: [], sourceKinds: [], repos: [] });
  assert.deepEqual(appContextDeclOf({ context: { knowledge_categories: ["p"] } }), { knowledgeCategories: ["p"], sourceKinds: [], repos: [] });
  assert.deepEqual(appContextDeclOf({ context: { knowledge_categories: "p" } }), { knowledgeCategories: [], sourceKinds: [], repos: [] });
});

//  앱 v2 #124 — context.repos(판 읽기 도구로 읽을 등록 레포). 읽기는 다른 두 목록과 같은 규칙(중복 · 글이 아닌 값 버림 · 칸이 없으면 빈 것).
test("D6 repos — 중복 · 글이 아닌 값은 버린다 · 다른 목록과 따로", () => {
  assert.deepEqual(appContextDeclOf({ context: { repos: ["card-api-server", "card-api-server", 7, "", "gowid-web"] } }),
    { knowledgeCategories: [], sourceKinds: [], repos: ["card-api-server", "gowid-web"] });
  assert.deepEqual(appContextDeclOf({ context: { knowledge_categories: ["p"], repos: "card-api-server" } }), { knowledgeCategories: ["p"], sourceKinds: [], repos: [] });
});

//  레포 관문 — 앱 토큰이 아니면(사람 · 일반 토큰) 앱 선언을 보지 않고 통과한다(code scope 가 정한다 · DB 를 읽지 않는다). 앱 토큰의 판 고르기는 pg-test 몫.
test("R1 레포 관문 — 앱 토큰이 아니면 그대로 통과(DB 없이)", async () => {
  await assertAppRepoAllowed({ userId: "alice", scopes: ["code"] }, "card-api-server");
  await assertAppRepoAllowed(null, "card-api-server");
  await assertAppRepoAllowed(undefined, "anything");
});

const rejected = async (m: unknown): Promise<{ status?: number; message?: string } | null> => {
  try { await assertContextInstallable(m); return null; } catch (e) { return e as { status?: number; message?: string }; }
};
const manifest = (perm: Record<string, unknown>, context?: unknown) => ({ id: "a", permissions: { scopes: ["memory"], ...perm }, ...(context === undefined ? {} : { context }) });

test("D5 «도구 전부» — 범위를 선언한 앱이면 저장 400 · 좁은 꼴은 된다 · 범위 없는 앱은 그대로", async () => {
  for (const all of ["*", "**", "*_*"]) {
    const e = await rejected(manifest({ tools: ["knowledge_search", all] }, { knowledge_categories: [] }));
    assert.equal(e?.status, 400, `tools ${all}`);
    assert.match(String(e?.message), /permissions\.tools/);
    const x = await rejected(manifest({ tools: ["knowledge_search"], ext_tools: [all] }, { source_kinds: ["slack"] }));
    assert.equal(x?.status, 400, `ext_tools ${all}`);
    assert.match(String(x?.message), /permissions\.ext_tools/);
    assert.equal(await rejected(manifest({ tools: [all], ext_tools: [all] })), null, `범위 없는 앱의 ${all} 는 그대로`);
  }
  assert.equal(await rejected(manifest({ tools: ["knowledge_*", "*_get", "source_get"], ext_tools: ["ext__slack__*"] }, { knowledge_categories: [] })), null);
  assert.equal(await rejected(manifest({ tools: [] }, {})), null, "도구가 없어도 된다");
});
