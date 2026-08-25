// 수집기 슬랙 토큰 출처 해소(#1881) — token_source → 금고. 사양 = scratch spec.md §D. 금고는 주입(DB 불요).
//  실행: npm run build && node dist/org/credentials/slack-token-source.test.js
import assert from "node:assert/strict";
import { resolveSlackTokenSource, type SlackVaultReader } from "./slack-token-source.js";
import { isSlackUserToken, isSlackBotToken } from "../../connectors/slack.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const vault = (o: { users?: Record<string, string>; bots?: Array<{ team_id: string; token: string | null }> }): SlackVaultReader & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    async memberUserToken(id) { asked.push(`user:${id}`); return o.users?.[id] ?? null; },
    async botTokens() { asked.push("bots"); return o.bots ?? []; },
  };
};

await t("D7 token_source 비움 → null(종전 경로, 금고를 건드리지 않는다)", async () => {
  const v = vault({ users: { yoon: "xoxp-a" } });
  assert.equal(await resolveSlackTokenSource(undefined, v), null);
  assert.equal(await resolveSlackTokenSource("   ", v), null);
  assert.deepEqual(v.asked, []);
});

await t("D1 member:<id> → 그 멤버 유저 토큰, 봇 토큰은 비움(검색 모드)", async () => {
  const v = vault({ users: { yoon: "xoxp-yoon" }, bots: [{ team_id: "T1", token: "xoxb-1" }] });
  const r = await resolveSlackTokenSource("member:yoon", v);
  assert.deepEqual(r, { user_token: "xoxp-yoon" });
  assert.deepEqual(v.asked, ["user:yoon"], "봇 슬롯은 보지도 않는다");
});

await t("D2 member:<id> 인데 연결이 없으면 둘 다 비움 + 경고(붙여넣기 값으로 조용히 떨어지지 않는다)", async () => {
  const r = await resolveSlackTokenSource("member:gone", vault({ users: { yoon: "xoxp-yoon" } }));
  assert.equal(r?.user_token, undefined);
  assert.equal(r?.bot_token, undefined);
  assert.match(r?.warning ?? "", /gone/);
});

await t("D3 bot + 봇 슬롯 1개 → 그 봇 토큰, 유저 토큰 비움(봇 모드)", async () => {
  const r = await resolveSlackTokenSource("bot", vault({ users: { yoon: "xoxp-yoon" }, bots: [{ team_id: "T1", token: "xoxb-1" }] }));
  assert.deepEqual(r, { bot_token: "xoxb-1" });
});

await t("D4 bot + 봇 슬롯 0개 → 비움 + 경고", async () => {
  const r = await resolveSlackTokenSource("bot", vault({ bots: [] }));
  assert.equal(r?.bot_token, undefined);
  assert.ok(r?.warning);
});

await t("D5 bot:<team> 은 그 워크스페이스의 봇만", async () => {
  const r = await resolveSlackTokenSource("bot:T2", vault({ bots: [{ team_id: "T1", token: "xoxb-1" }, { team_id: "T2", token: "xoxb-2" }] }));
  assert.deepEqual(r, { bot_token: "xoxb-2" });
  const miss = await resolveSlackTokenSource("bot:T9", vault({ bots: [{ team_id: "T1", token: "xoxb-1" }] }));
  assert.equal(miss?.bot_token, undefined);
  assert.match(miss?.warning ?? "", /T9/);
});

await t("D6 bot 인데 워크스페이스가 둘이면 모호 → 비움 + 경고에 후보 team_id 나열", async () => {
  const r = await resolveSlackTokenSource("bot", vault({ bots: [{ team_id: "T1", token: "xoxb-1" }, { team_id: "T2", token: "xoxb-2" }] }));
  assert.equal(r?.bot_token, undefined);
  assert.match(r?.warning ?? "", /T1.*T2|T2.*T1/);
});

await t("D6' 비어 있는(복호 실패) 봇 슬롯은 후보에서 뺀다", async () => {
  const r = await resolveSlackTokenSource("bot", vault({ bots: [{ team_id: "T1", token: null }, { team_id: "T2", token: "xoxb-2" }] }));
  assert.deepEqual(r, { bot_token: "xoxb-2" });
});

await t("D8 알 수 없는 값 → 비움 + 경고", async () => {
  const r = await resolveSlackTokenSource("foo", vault({}));
  assert.equal(r?.user_token, undefined);
  assert.equal(r?.bot_token, undefined);
  assert.match(r?.warning ?? "", /foo/);
});

await t("D9 토큰 접두 — 회전형(xoxe.) 도 종류를 맞게 판별하고, 칸을 바꿔 넣으면 거부된다", () => {
  assert.equal(isSlackUserToken("xoxp-1-abc"), true);
  assert.equal(isSlackUserToken("xoxe.xoxp-1-abc"), true);
  assert.equal(isSlackUserToken("xoxb-1-abc"), false);
  assert.equal(isSlackBotToken("xoxb-1-abc"), true);
  assert.equal(isSlackBotToken("xoxe.xoxb-1-abc"), true);
  assert.equal(isSlackBotToken("xoxp-1-abc"), false);
  assert.equal(isSlackUserToken("xoxe-1-refresh"), false, "리프레시 토큰은 둘 다 아니다");
});

console.log(`\nslack-token-source tests: ${pass} passed`);
