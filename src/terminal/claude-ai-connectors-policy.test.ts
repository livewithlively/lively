// claude.ai 커넥터를 막나 — 판·대화 런타임이 같이 쓰는 판정 (#4213 T6 #4427). 게이트웨이 능력을 갈아 끼워 표를 돈다.
//
//  엣지 표 — B1 claude 아닌 하네스 → 안 막음(정책이 막음이어도) · B2 능력 없음(노드) → 안 막음 · B3 allowed → 안 막음
//   B4 blocked → 막음 · B5 unknown(못 읽음) → 막음(fail-closed) · B6 능력이 던짐 → 막음(fail-closed) · B7 빈 하네스 키 → 안 막음
import assert from "node:assert/strict";
import { registerGatewayCapabilities } from "../sessions/gateway-capabilities.js";
import { claudeAiConnectorsBlocked } from "./claude-ai-connectors-policy.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const policy = (v: "allowed" | "blocked" | "unknown" | Error | undefined): void => registerGatewayCapabilities({
  memberAiConnectorsPolicy: v === undefined ? undefined : async () => { if (v instanceof Error) throw v; return v; },
});

await t("B1 claude 가 아닌 하네스는 정책이 막음이어도 안 막는다", async () => {
  policy("blocked");
  for (const h of ["codex", "grok", "antigravity", "opencode", "shell"]) assert.equal(await claudeAiConnectorsBlocked(h), false, h);
});
await t("B2 능력이 없으면(노드 에이전트) 안 막는다 — 그 사람 컴퓨터의 Claude 는 안내문만", async () => {
  policy(undefined);
  assert.equal(await claudeAiConnectorsBlocked("claude"), false);
});
await t("B3 allowed → 안 막는다", async () => {
  policy("allowed");
  assert.equal(await claudeAiConnectorsBlocked("claude"), false);
});
await t("B4 blocked → 막는다", async () => {
  policy("blocked");
  assert.equal(await claudeAiConnectorsBlocked("claude"), true);
});
await t("B5 unknown(정책을 못 읽음) → 막는다(fail-closed)", async () => {
  policy("unknown");
  assert.equal(await claudeAiConnectorsBlocked("claude"), true);
});
await t("B6 능력이 던지면 → 막는다(fail-closed)", async () => {
  policy(new Error("pool timeout"));
  assert.equal(await claudeAiConnectorsBlocked("claude"), true);
});
await t("B7 빈 하네스 키는 claude 로 추측하지 않는다", async () => {
  policy("blocked");
  assert.equal(await claudeAiConnectorsBlocked(""), false);
});

console.log(`\n${pass} passed`);
