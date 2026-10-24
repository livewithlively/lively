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
  assert.ok(SLACK_USER_SCOPES.includes("search:read.public") && SLACK_USER_SCOPES.includes("chat:write"));
  assert.ok(!(SLACK_USER_SCOPES as readonly string[]).includes("search:read"), "legacy search:read 는 새 앱 authorize 가 invalid_permissions 로 거부한다");
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
  assert.equal(m.features.bot_user.display_name, "lively", "봇 이름은 슬랙 규칙(a-z0-9-_.)대로 소문자");
  assert.equal(m.settings.token_rotation_enabled, false);
  assert.ok(!("is_mcp_enabled" in m.settings));
  const u = new URL(slackAppCreateUrl(m));
  assert.equal(u.hostname, "api.slack.com");
  assert.equal(u.searchParams.get("new_app"), "1");
  assert.deepEqual(JSON.parse(u.searchParams.get("manifest_json") ?? "{}"), m, "링크 안의 매니페스트가 원본과 같다(인코딩 왕복)");
});

await t("C13 출고 매니페스트는 손대지 않고도 슬랙 규칙을 통과한다 — 길이는 UTF-8 바이트(#4940: 링크를 화면에서 고치면 생성이 막힌다)", async () => {
  const { buildSlackAppManifest, slackManifestProblems } = await import("./slack-oauth.js");
  const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
  // E1 — 검사기와 따로, 출고값을 직접 잰다(검사기가 틀려도 이 줄이 잡는다)
  const m = buildSlackAppManifest(["https://lively.snipit.im/oauth/callback"]) as {
    display_information: { name: string; description: string }; features: { bot_user: { display_name: string } };
  };
  assert.ok(m.display_information.name && bytes(m.display_information.name) <= 35, `이름 ${bytes(m.display_information.name)}바이트`);
  assert.ok(bytes(m.display_information.description) <= 140, `설명 ${bytes(m.display_information.description)}바이트`);
  assert.match(m.features.bot_user.display_name, /^[a-z0-9._-]{1,80}$/);
  assert.deepEqual(slackManifestProblems(m), [], "검사기도 출고값을 통과로 본다");

  const mk = (name: unknown, description: unknown, bot?: unknown): Record<string, unknown> => ({
    display_information: { name, description }, ...(bot === undefined ? {} : { features: { bot_user: { display_name: bot } } }),
  });
  const bad = (x: Record<string, unknown>): boolean => slackManifestProblems(x).length > 0;
  const ko46 = "가".repeat(46);                       // 138바이트
  // E2·E3 — 140 경계(바이트)
  assert.equal(bytes(ko46 + "ab"), 140);
  assert.equal(bad(mk("Lively", ko46 + "ab")), false, "정확히 140바이트는 통과");
  assert.equal(bad(mk("Lively", ko46 + "abc")), true, "141바이트는 위반");
  // E4 — 옛 설명: 67자라 글자로 재면 통과하지만 158바이트라 위반(위시스트 대표님이 막힌 값)
  const old = "내 일을 아는 AI — 슬랙 대화를 라이블리 워크스페이스의 맥락으로 모으고, AI가 내 계정으로 슬랙을 검색·발송합니다.";
  assert.ok(old.length <= 140 && bytes(old) > 140);
  assert.equal(bad(mk("Lively", old)), true, "글자 수가 아니라 바이트로 잰다");
  // E5·E6 — 이름 35 경계 · 빈 이름
  assert.equal(bad(mk("a".repeat(35), "")), false, "이름 35바이트 통과");
  assert.equal(bad(mk("a".repeat(36), "")), true, "이름 36바이트 위반");
  assert.equal(bytes("Lively (위시스트 주식회사 본사)"), 41);
  assert.equal(bad(mk("Lively (위시스트 주식회사 본사)", "")), true, "한글 이름은 19자여도 41바이트라 위반");
  assert.equal(bad(mk("", "")), true, "빈 이름 위반");
  // E7·E8·E9 — 봇 이름 글자·길이
  for (const b of ["Lively", "Lively (위시스트)", "my bot", ""]) assert.equal(bad(mk("Lively", "", b)), true, `봇 이름 «${b}» 은 위반`);
  for (const b of ["lively", "a.b-c_9"]) assert.equal(bad(mk("Lively", "", b)), false, `봇 이름 «${b}» 은 통과`);
  assert.equal(bad(mk("Lively", "", "a".repeat(80))), false, "봇 이름 80자 통과");
  assert.equal(bad(mk("Lively", "", "a".repeat(81))), true, "봇 이름 81자 위반");
  // E10 — 칸이 통째로 없어도 예외 없이 «이름 없음» 으로 말한다
  assert.doesNotThrow(() => slackManifestProblems({}));
  assert.equal(slackManifestProblems({}).length, 1);
});

await t("C12 릴레이 시작 URL — state·gw 가 쿼리로 실리고 기존 쿼리는 보존된다", async () => {
  const { relayStartUrl } = await import("./slack-oauth.js");
  const u = new URL(relayStartUrl("https://app.lvly.io/oauth/slack/start?v=1", "st.sig", "https://acme.app.lvly.io"));
  assert.equal(u.origin + u.pathname, "https://app.lvly.io/oauth/slack/start");
  assert.equal(u.searchParams.get("state"), "st.sig");
  assert.equal(u.searchParams.get("gw"), "https://acme.app.lvly.io");
  assert.equal(u.searchParams.get("v"), "1");
});

console.log(`\nslack-oauth tests: ${pass} passed`);
