// 도구 상한의 경계 판정(도구 허용 목록 사양 T24 · T25 · T27 · T29 — 격리 리뷰가 DB 없는 시험 사슬에도 두라고 짚었다).
//  상한 밖 판정은 앱 동의(DB)를 읽기 전에 끝난다 — 그래서 DB 없이 진짜 판정 함수로 잰다. 상한 안 → 앱 동의까지 가는 길은
//  실 PG(org/store/token-revoke.pg-test TC9–TC19)가 본다.
//  이게 틀리면: 작업 AI 가 상한 밖 도구(store_sql · db_query · 배관 whoami)를 부르거나, 거절 글이 앱 동의 밖과 같아 앱 제작자가 고칠 곳(ai.tools)을 모른다.
import assert from "node:assert/strict";
import type { LivelyUser } from "../context.js";
import { confinedToAppTools } from "../context.js";
import { appToolAllowed, requireAppTool, APP_TOOL_EXEMPT } from "./principal.js";
import { requireDbToolForAppServer } from "../tools/db.js";
import { appPrincipalGate } from "../auth/http-auth.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};
const user = (o: Partial<LivelyUser>): LivelyUser => ({ userId: "m1", email: "", scopes: ["items", "memory", "db"], projects: ["*"], appId: "crm", ...o });
const status403 = (re: RegExp) => (e: unknown) => (e as { status?: number }).status === 403 && re.test(String((e as Error).message));

await t("T24 상한 밖 도구는 거절 — 앱 동의를 읽기 전에(DB 없이) 끝나고, 거절 글은 상한(ai.tools)을 가리킨다", async () => {
  const u = user({ toolCeiling: ["knowledge_search"] });
  assert.equal(await appToolAllowed(u, "store_sql"), false);
  assert.equal(await appToolAllowed(u, "knowledge_get"), false);
  await assert.rejects(requireAppTool(u, "store_sql"), status403(/앱이 이 작업에 허용한 도구 밖 — 매니페스트 ai\.tools/));
});

await t("T24 · T25 빈 상한([])은 아무것도 — 세션 배관 면제(whoami 등)도 상한을 넘지 못한다", async () => {
  const u = user({ toolCeiling: [] });
  assert.ok(APP_TOOL_EXEMPT.has("whoami"), "관측 장치 — whoami 는 배관 면제다");
  for (const name of ["whoami", "knowledge_search", "store_sql"]) assert.equal(await appToolAllowed(u, name), false, name);
});

await t("T26 상한이 없는 일반 세션은 종전대로 통과(DB 없이)", async () => {
  assert.equal(await appToolAllowed({ userId: "m1", email: "", scopes: [], projects: ["*"] }, "store_sql"), true);
});

await t("T27 상한이 있으면 제품 DB 도구도 앱 도구 게이트를 탄다 — 상한 밖 db_query 는 403", async () => {
  await assert.rejects(requireDbToolForAppServer(user({ toolCeiling: ["knowledge_search"] }), "db_query"), status403(/ai\.tools/));
  await assert.rejects(requireDbToolForAppServer(user({ toolCeiling: [] }), "db_schema"), status403(/ai\.tools/));
});

await t("T29 상한이 실린 주체는 앱 도구의 문(cap · mcp)에서만 — 빈 상한도 상한이다 · 상한 없는 앱 토큰은 종전대로", () => {
  for (const ceiling of [["knowledge_search"], []]) {
    const u = user({ toolCeiling: ceiling });
    assert.equal(confinedToAppTools(u), true);
    assert.deepEqual((["cap", "mcp", "deny"] as const).map((m) => appPrincipalGate(u, m)), ["next", "next", "deny"], JSON.stringify(ceiling));
  }
  const plain = user({});
  assert.equal(confinedToAppTools(plain), false);
  assert.deepEqual((["cap", "mcp", "deny"] as const).map((m) => appPrincipalGate(plain, m)), ["next", "next", "next"]);
});

console.log(`# ${pass} pass`);
