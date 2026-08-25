// 노션 수집기 token_source 해소(#1881 N3) — org / org:<workspace_id> 표. 순수(주입 리더, DB 불요).
//  실행: npm run build && node dist/org/credentials/notion-token-source.test.js
import assert from "node:assert/strict";
import { resolveNotionTokenSource, type NotionVaultReader } from "./notion-token-source.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const vault = (rows: Array<{ workspace_id: string; token: string | null }>): NotionVaultReader => ({ orgTokens: async () => rows });

await t("S1 미지정('' / undefined) = null — 종전 경로(붙여넣기 토큰)", async () => {
  assert.equal(await resolveNotionTokenSource(undefined, vault([])), null);
  assert.equal(await resolveNotionTokenSource("  ", vault([])), null);
});

await t("S2 org + 슬롯 1개 → 그 토큰", async () => {
  const r = await resolveNotionTokenSource("org", vault([{ workspace_id: "ws-1", token: "ntn_a" }]));
  assert.equal(r?.token, "ntn_a");
  assert.equal(r?.warning, undefined);
});

await t("S3 org + 슬롯 0개 → 재연결 안내 warning, 토큰 없음", async () => {
  const r = await resolveNotionTokenSource("org", vault([]));
  assert.equal(r?.token, undefined);
  assert.match(String(r?.warning), /팀 자료로 모으기/);
});

await t("S4 org + 슬롯 여럿 → 지목 요구 warning(워크스페이스 나열)", async () => {
  const r = await resolveNotionTokenSource("org", vault([{ workspace_id: "ws-1", token: "a" }, { workspace_id: "ws-2", token: "b" }]));
  assert.equal(r?.token, undefined);
  assert.match(String(r?.warning), /ws-1.*ws-2/);
});

await t("S5 org:<id> 지목 → 그 워크스페이스만 · 없는 id 는 warning", async () => {
  const rows = [{ workspace_id: "ws-1", token: "a" }, { workspace_id: "ws-2", token: "b" }];
  assert.equal((await resolveNotionTokenSource("org:ws-2", vault(rows)))?.token, "b");
  assert.match(String((await resolveNotionTokenSource("org:ws-9", vault(rows)))?.warning), /ws-9/);
});

await t("S6 블롭 파싱 실패(token=null) → 재연결 warning — 옛 토큰으로 조용히 긁지 않는다", async () => {
  const r = await resolveNotionTokenSource("org", vault([{ workspace_id: "ws-1", token: null }]));
  assert.equal(r?.token, undefined);
  assert.match(String(r?.warning), /다시 연결/);
});

await t("S7 알 수 없는 형식(member: 등) → warning", async () => {
  const r = await resolveNotionTokenSource("member:yoon", vault([]));
  assert.match(String(r?.warning), /org/);
});

console.log(`\n${pass} tests passed (notion-token-source)`);
