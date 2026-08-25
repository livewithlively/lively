// 슬랙 OAuth v2 직결(#1881) — 인가 URL·교환 응답 파싱·금고 슬롯 모양. 사양 = scratch spec.md §C. 순수(네트워크 불요).
//  실행: npm run build && node dist/org/credentials/slack-oauth.test.js
import assert from "node:assert/strict";
import {
  buildSlackAuthorizeUrl, parseSlackAccessResponse, slackInstallToSlots, exchangeSlackCode, isSlackOAuthKind,
  SLACK_BOT_SCOPES, SLACK_USER_SCOPES, SLACK_BOT_KIND,
} from "./slack-oauth.js";
import { decodeTokenBlob } from "./oauth-broker.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const FULL = {
  ok: true, access_token: "xoxb-1-bot", token_type: "bot", scope: "channels:history,groups:history", bot_user_id: "U0BOT00001",
  team: { id: "T0TEAM0001", name: "lively" },
  authed_user: { id: "U0YOON0001", scope: "search:read,chat:write", access_token: "xoxp-1-user", token_type: "user" },
};

await t("C10 isSlackOAuthKind — slack_oauth 만(대소문자 무시), 다른 OAuth 는 아님", () => {
  assert.equal(isSlackOAuthKind("slack_oauth"), true);
  assert.equal(isSlackOAuthKind("Slack_OAuth"), true);
  assert.equal(isSlackOAuthKind("google_drive_oauth"), false);
  assert.equal(isSlackOAuthKind(null), false);
});

await t("C1 인가 URL — slack.com/oauth/v2/authorize + client_id·redirect_uri·state + scope(봇)·user_scope(유저) 분리", () => {
  const u = new URL(buildSlackAuthorizeUrl({ clientId: "123.456", redirectUri: "https://gw.example/oauth/callback", state: "st.sig" }));
  assert.equal(u.hostname, "slack.com");
  assert.equal(u.pathname, "/oauth/v2/authorize");
  assert.equal(u.searchParams.get("client_id"), "123.456");
  assert.equal(u.searchParams.get("redirect_uri"), "https://gw.example/oauth/callback");
  assert.equal(u.searchParams.get("state"), "st.sig");
  assert.equal(u.searchParams.get("scope"), SLACK_BOT_SCOPES.join(","));
  assert.equal(u.searchParams.get("user_scope"), SLACK_USER_SCOPES.join(","));
  // 유저 스코프엔 검색·발송이, 봇 스코프엔 이메일(구성원 매핑)이 — 유저 토큰에 PII 스코프가 새지 않는다
  assert.ok(SLACK_USER_SCOPES.includes("search:read") && SLACK_USER_SCOPES.includes("chat:write"));
  assert.ok(SLACK_BOT_SCOPES.includes("users:read.email"));
  assert.ok(!(SLACK_USER_SCOPES as readonly string[]).includes("users:read.email"));
});

await t("C2 정상 응답 — 유저 토큰·봇 토큰·팀·bot_user_id 를 전부 뽑는다", () => {
  const i = parseSlackAccessResponse(FULL);
  assert.equal(i.user.access_token, "xoxp-1-user");
  assert.equal(i.user.slack_user_id, "U0YOON0001");
  assert.equal(i.bot?.access_token, "xoxb-1-bot");
  assert.equal(i.bot?.bot_user_id, "U0BOT00001");
  assert.equal(i.team?.id, "T0TEAM0001");
});

await t("C3 ok:false 는 예외이고 슬랙 error 코드가 메시지에 실린다", () => {
  assert.throws(() => parseSlackAccessResponse({ ok: false, error: "invalid_code" }), /invalid_code/);
});

await t("C4 authed_user(유저 토큰)가 없으면 연결이 아니다 — 예외", () => {
  const { authed_user: _drop, ...noUser } = FULL;
  void _drop;
  assert.throws(() => parseSlackAccessResponse(noUser), /사용자 토큰/);
});

await t("C5 봇 access_token 이 없으면(봇 스코프 없는 앱) 유저 토큰만 — 예외 아님, bot=null", () => {
  const { access_token: _drop, ...noBot } = FULL;
  void _drop;
  const i = parseSlackAccessResponse(noBot);
  assert.equal(i.user.access_token, "xoxp-1-user");
  assert.equal(i.bot, null);
  assert.equal(slackInstallToSlots(i).bot, null);
});

await t("C6 team 이 없으면 봇 토큰이 있어도 봇 슬롯을 만들지 않는다(team_id 가 슬롯 키)", () => {
  const i = parseSlackAccessResponse({ ...FULL, team: null });
  assert.equal(i.bot, null);
  assert.equal(i.team, null);
  assert.equal(slackInstallToSlots(i).bot, null);
});

await t("C7 유저 슬롯 — OAuthTokens 블롭이라 브로커 코덱으로 복원되고 access_token 이 그대로, meta 에 team·slack_user_id", () => {
  const s = slackInstallToSlots(parseSlackAccessResponse(FULL));
  const tk = decodeTokenBlob(s.user.secret);
  assert.equal(tk?.access_token, "xoxp-1-user");
  assert.equal(s.user.meta.team_id, "T0TEAM0001");
  assert.equal(s.user.meta.slack_user_id, "U0YOON0001");
  assert.ok(!("expires_at" in s.user.meta), "회전 OFF — 만료 메타가 없어야 B 경로가 갱신을 시도하지 않는다");
  assert.ok(!s.user.secret.includes("xoxb-"), "유저 블롭에 봇 토큰이 섞이지 않는다");
});

await t("C8 봇 슬롯 — kind=slack_bot · scope_key=team_id · 평문 xoxb · meta 에 bot_user_id", () => {
  const s = slackInstallToSlots(parseSlackAccessResponse(FULL));
  assert.equal(SLACK_BOT_KIND, "slack_bot");
  assert.equal(s.bot?.scopeKey, "T0TEAM0001");
  assert.equal(s.bot?.secret, "xoxb-1-bot");
  assert.equal(s.bot?.meta.bot_user_id, "U0BOT00001");
});

await t("C2' 교환 호출 — oauth.v2.access 에 form-urlencoded POST, client_secret 은 본문에만(URL 에 없음)", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(FULL), { status: 200, headers: { "content-type": "application/json" } });
  };
  const i = await exchangeSlackCode({ clientId: "123", clientSecret: "shh", code: "c0de", redirectUri: "https://gw/oauth/callback", fetchFn });
  assert.equal(i.user.access_token, "xoxp-1-user");
  assert.equal(calls.length, 1, "배선: 실제로 한 번 나갔다");
  assert.equal(calls[0].url, "https://slack.com/api/oauth.v2.access");
  assert.equal(calls[0].init?.method, "POST");
  const body = String(calls[0].init?.body);
  assert.ok(body.includes("client_secret=shh") && body.includes("code=c0de") && body.includes("redirect_uri="), body);
  assert.ok(!calls[0].url.includes("shh"));
});

await t("C11 매니페스트 — redirect·스코프가 인가 URL 과 같은 상수에서 나오고, 봇 유저가 있고, MCP·회전은 꺼져 있다", async () => {
  const { buildSlackAppManifest, slackAppCreateUrl } = await import("./slack-oauth.js");
  const m = buildSlackAppManifest(["https://gw.example/oauth/callback", "https://gw.example/oauth/callback"]) as {
    oauth_config: { redirect_urls: string[]; scopes: { bot: string[]; user: string[] } };
    features: { bot_user: { display_name: string } };
    settings: Record<string, unknown>;
  };
  assert.deepEqual(m.oauth_config.redirect_urls, ["https://gw.example/oauth/callback"], "중복 redirect 는 접힌다");
  assert.deepEqual(m.oauth_config.scopes.bot, [...SLACK_BOT_SCOPES]);
  assert.deepEqual(m.oauth_config.scopes.user, [...SLACK_USER_SCOPES]);
  assert.equal(m.features.bot_user.display_name, "Lively");
  assert.equal(m.settings.token_rotation_enabled, false);
  assert.ok(!("is_mcp_enabled" in m.settings));
  const u = new URL(slackAppCreateUrl(m));
  assert.equal(u.hostname, "api.slack.com");
  assert.equal(u.searchParams.get("new_app"), "1");
  assert.deepEqual(JSON.parse(u.searchParams.get("manifest_json") ?? "{}"), m, "링크 안의 매니페스트가 원본과 같다(인코딩 왕복)");
});

console.log(`\nslack-oauth tests: ${pass} passed`);
