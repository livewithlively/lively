// 슬랙 OAuth v2 직결(#1881) — 라이블리(또는 셀프호스팅 고객)가 소유한 Slack 앱으로 구성원이 [Slack 연결] 한 번에 붙는다.
//
//  왜 MCP SDK 의 auth() 를 안 쓰나: 슬랙 공식 MCP(mcp.slack.com)의 OAuth 는 **유저 토큰만** 준다(oauth.v2.user.access)
//  — 그런데 우리는 한 번의 동의로 **유저 토큰(개인 AI 도구·공개채널 검색 수집) + 봇 토큰(비공개 채널 수집)** 둘을
//  받아야 "버튼 하나" 가 성립한다. 그건 슬랙 표준 설치 플로우 `oauth/v2/authorize`(scope=봇 + user_scope=유저) →
//  `oauth.v2.access` 만 준다(응답의 access_token=봇, authed_user.access_token=유저 — docs.slack.dev/authentication/installing-with-oauth).
//  이 엔드포인트는 RFC 토큰 엔드포인트 모양이 아니라(유저 토큰이 authed_user 안에 있다) SDK 가 못 읽는다.
//
//  이 파일은 **순수 + fetch** 만 — 금고 읽기/쓰기는 oauth-broker 가 한다(순환 import 회피 + 테스트가 DB 없이 돈다).
//  PKCE 는 안 쓴다(슬랙 v2 는 미지원). CSRF 는 브로커의 서명 state(HMAC·만료·멤버 귀속)가 막는다.
//
//  토큰 회전(xoxe.)은 v1 에서 끈다(앱 설정 opt-in·비가역·갱신에 client_secret 필요 → 매니지드에선 CP 왕복). 그래서
//  블롭엔 expires_in 이 없고 oauth-proxy-auth 의 만료 판정은 '만료 아님' 으로 떨어져 갱신을 시도하지 않는다.

export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
export const SLACK_ACCESS_URL = "https://slack.com/api/oauth.v2.access";

/** 개인 AI 도구·검색 수집이 쓰는 유저 토큰 스코프 — 슬랙 MCP 프리셋(#746 L2 컨펌 read/search+send)을 클래식 스코프로 옮긴 것.
 *  users:read.email(PII)은 유저 토큰에서 뺀다 — 구성원 매핑은 조직 기능이라 봇 토큰이 맡는다. */
export const SLACK_USER_SCOPES = [
  "search:read", "channels:read", "groups:read", "im:read", "mpim:read",
  "channels:history", "groups:history", "im:history", "mpim:history",
  "users:read", "files:read", "reactions:read", "emoji:read", "chat:write",
] as const;
/** 비공개 채널 수집(봇 초대 채널) + 구성원 매핑 — #1531 봇 모드 + files:read(#1556 첨부). */
export const SLACK_BOT_SCOPES = [
  "channels:history", "groups:history", "channels:read", "groups:read",
  "users:read", "users:read.email", "files:read",
] as const;

/** 봇 토큰이 들어가는 조직 금고 슬롯 kind. scope_key = 슬랙 team_id(워크스페이스) — 한 조직이 워크스페이스 둘을 붙여도 안 섞인다. */
export const SLACK_BOT_KIND = "slack_bot";

/** 이 auth_kind 가 슬랙 직결 플로우를 타는가 — 프록시 MCP 서버 행(auth_kind=slack_oauth)·B 프리셋 그룹이 같은 값을 쓴다. */
export function isSlackOAuthKind(authKind: string | null | undefined): boolean {
  return String(authKind ?? "").toLowerCase() === "slack_oauth";
}

export function buildSlackAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL(SLACK_AUTHORIZE_URL);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));       // 봇 스코프 → 응답 access_token(xoxb)
  u.searchParams.set("user_scope", SLACK_USER_SCOPES.join(",")); // 유저 스코프 → 응답 authed_user.access_token(xoxp)
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("state", p.state);
  return u.toString();
}

/** oauth.v2.access 응답에서 우리가 쓰는 것만. */
export interface SlackInstall {
  user: { access_token: string; scope: string; token_type: string; slack_user_id: string | null };
  /** 봇 토큰 — 앱에 봇 스코프가 없거나 팀 정보가 없으면 null(유저 토큰만으로도 연결은 성립한다). */
  bot: { access_token: string; scope: string; bot_user_id: string | null } | null;
  team: { id: string; name: string | null } | null;
}

interface AccessResp {
  ok?: unknown; error?: unknown;
  access_token?: unknown; scope?: unknown; token_type?: unknown; bot_user_id?: unknown;
  team?: { id?: unknown; name?: unknown } | null;
  authed_user?: { id?: unknown; access_token?: unknown; scope?: unknown; token_type?: unknown } | null;
}
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * 교환 응답 파싱 — 실패는 던진다(슬랙은 실패도 HTTP 200 + ok:false). **유저 토큰이 없으면 연결이 아니다**: 개인 도구가
 *  그 토큰으로 돌고, 봇 토큰만으론 "내 계정으로" 가 성립하지 않는다(유저 스코프를 거부한 동의 = 미연결).
 *  봇 토큰은 선택 — 앱에 봇 스코프가 없거나(셀프호스팅 최소 앱) team 이 없으면 봇 슬롯을 만들지 않는다(team_id 가 슬롯 키다).
 */
export function parseSlackAccessResponse(j: unknown): SlackInstall {
  const r = (j ?? {}) as AccessResp;
  if (r.ok !== true) throw new Error(`슬랙 토큰 교환 실패: ${str(r.error) ?? "unknown_error"}`);
  const au = r.authed_user ?? null;
  const userTok = str(au?.access_token);
  if (!userTok) throw new Error("슬랙이 사용자 토큰을 주지 않았습니다 — 동의 화면에서 사용자 권한을 허용해야 연결됩니다(authed_user.access_token 없음).");
  const teamId = str(r.team?.id);
  const botTok = str(r.access_token);
  return {
    user: { access_token: userTok, scope: str(au?.scope) ?? "", token_type: str(au?.token_type) ?? "user", slack_user_id: str(au?.id) },
    bot: botTok && teamId ? { access_token: botTok, scope: str(r.scope) ?? "", bot_user_id: str(r.bot_user_id) } : null,
    team: teamId ? { id: teamId, name: str(r.team?.name) } : null,
  };
}

/** SSRF-가드 fetch(makeSsrfFetch)와 전역 fetch 둘 다 받는 최소 시그니처. */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** code → 토큰 교환. client_secret 은 이 호출 안에서만 산다(응답·로그에 실리지 않는다). */
export async function exchangeSlackCode(p: {
  clientId: string; clientSecret: string; code: string; redirectUri: string;
  fetchFn?: FetchLike;
}): Promise<SlackInstall> {
  const form = new URLSearchParams({ client_id: p.clientId, client_secret: p.clientSecret, code: p.code, redirect_uri: p.redirectUri });
  const f = p.fetchFn ?? fetch;
  const res = await f(SLACK_ACCESS_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
  let j: unknown;
  try { j = await res.json(); } catch { throw new Error(`슬랙 토큰 교환 응답을 읽지 못했습니다(HTTP ${res.status})`); }
  return parseSlackAccessResponse(j);
}

/**
 * Slack 앱 매니페스트(#1881 §5) — 이 게이트웨이(또는 라이블리 CP)가 콜백을 받는 앱을 **한 클릭**에 만들게 한다.
 *  `https://api.slack.com/apps?new_app=1&manifest_json=<urlencoded>` 로 열면 이름·봇 유저·스코프·redirect 가 채워진 생성 화면이
 *  뜬다(docs.slack.dev/app-manifests). 셀프호스팅 관리자가 하는 일은 [Create] 와 Client ID/Secret 복사뿐이다.
 *  `is_mcp_enabled` 는 넣지 않는다 — 도구 면은 Web API(B)라 슬랙 MCP 서버를 안 쓰고, 마켓플레이스 미등록 앱은 어차피 거부된다.
 *  토큰 회전은 끈다(비가역·갱신에 client_secret 필요 → 매니지드에선 CP 왕복).
 */
export function buildSlackAppManifest(redirectUrls: string[], opts: { name?: string; description?: string } = {}): Record<string, unknown> {
  return {
    display_information: {
      name: opts.name ?? "Lively",
      description: opts.description ?? "내 일을 아는 AI — 슬랙 대화를 라이블리 워크스페이스의 맥락으로 모으고, AI가 내 계정으로 슬랙을 검색·발송합니다.",
      background_color: "#1f2937",
    },
    features: { bot_user: { display_name: opts.name ?? "Lively", always_online: false } },
    oauth_config: {
      redirect_urls: [...new Set(redirectUrls)],
      scopes: { bot: [...SLACK_BOT_SCOPES], user: [...SLACK_USER_SCOPES] },
    },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
}
export function slackAppCreateUrl(manifest: Record<string, unknown>): string {
  return "https://api.slack.com/apps?new_app=1&manifest_json=" + encodeURIComponent(JSON.stringify(manifest));
}

/** 매니지드 릴레이 시작 URL(#1881 T5) — CP `/oauth/slack/start` 에 서명 state 와 이 게이트웨이 주소(테넌트 식별)를 실어 보낸다. */
export function relayStartUrl(relayBase: string, state: string, gatewayUrl: string): string {
  const u = new URL(relayBase);
  u.searchParams.set("state", state);
  u.searchParams.set("gw", gatewayUrl);
  return u.toString();
}

/** 금고에 넣을 모양 — 브로커가 그대로 setMemberSecret 에 넘긴다. 유저 블롭은 OAuthTokens 형식(oauth-proxy-auth 가 access_token 만 뽑아 싣는다). */
export function slackInstallToSlots(i: SlackInstall): {
  user: { secret: string; meta: Record<string, unknown> };
  bot: { scopeKey: string; secret: string; meta: Record<string, unknown> } | null;
} {
  const teamMeta = i.team ? { team_id: i.team.id, team_name: i.team.name } : {};
  return {
    user: {
      secret: JSON.stringify({ access_token: i.user.access_token, token_type: "bearer", scope: i.user.scope }),
      meta: { ...teamMeta, scope: i.user.scope, token_type: "bearer", slack_user_id: i.user.slack_user_id, via: "slack_oauth_v2" },
    },
    bot: i.bot && i.team ? {
      scopeKey: i.team.id,
      secret: i.bot.access_token,
      meta: { ...teamMeta, scope: i.bot.scope, bot_user_id: i.bot.bot_user_id, via: "slack_oauth_v2" },
    } : null,
  };
}
