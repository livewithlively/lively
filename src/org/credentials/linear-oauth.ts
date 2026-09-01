// Linear 직결 OAuth(#2247) — **라이블리 소유 Linear OAuth 앱**으로 [Linear 모아 두기]가 곧 계정 연결이 되게 한다.
//
//  왜 MCP(DCR) 토큰을 안 쓰나: 구성원 개인 도구는 mcp.linear.app(DCR, kind linear_oauth) 그대로다 — 그 토큰이
//  api.linear.app/graphql 에 통한다는 근거가 없고(GitLab 이 같은 자리에서 막힌 실측이 있다), 무엇보다 **연결자가 나가면
//  수집이 멈춰야 하는 축**과 도구 축을 한 슬롯에 섞으면 한쪽 재연결이 다른 쪽을 지운다. 그래서 kind 를 가른다:
//   · linear_oauth — MCP 도구용(DCR, 상류가 발급)                                   ← 건드리지 않는다
//   · linear_app   — 라이블리 앱 토큰(수집기가 token_source=member:<id> 로 읽는다) ← 이 파일
//  client_id/secret 은 gateway 슬롯(kind linear_app, scope_key oauth:client)에 산다(슬랙·노션·구글과 같은 규약).
//  매니지드는 CP 가 client 를 쥐고 콜백을 받아 /api/ui/org/linear/oauth-complete 로 넣어 준다(LINEAR_OAUTH_RELAY_URL).
//
//  이 파일은 **순수 + fetch** 만 — 금고 읽기/쓰기는 oauth-broker 가 한다. PKCE 는 안 쓴다(confidential client, secret 교환).
//  Linear 토큰: access_token 은 사실상 만료가 없고(expires_in 이 오면 meta 에 남긴다) refresh_token 은 주지 않는다 —
//  만료가 오면 재연결이 유일 경로다(그때는 토글이 needs_connect 로 다시 안내한다).
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "./slack-oauth.js";

export const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/** 라이블리 앱 토큰 슬롯 kind(member, scope_key ""). MCP 의 linear_oauth 와 **다르다**. */
export const LINEAR_APP_KIND = "linear_app";
/** state.s 에 실리는 예약 서버명 — org_mcp_server 행 'linear'(MCP) 와 **다르다**. */
export const LINEAR_APP_SERVER = "linear-app";
/** 수집에 필요한 최소 범위 — read 하나(이슈·댓글·문서 읽기). */
export const LINEAR_SCOPE = "read";

export function isLinearAppServer(name: string | null | undefined): boolean {
  return String(name ?? "").toLowerCase() === LINEAR_APP_SERVER;
}

/** 인가 URL — actor=user: 이 앱이 하는 일이 **그 사람 이름으로** 보이게(수집은 읽기뿐이지만 정직하게). prompt=consent: 재연결도 동의 화면. */
export function buildLinearAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string; scope?: string }): string {
  const u = new URL(LINEAR_AUTHORIZE_URL);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", p.scope ?? LINEAR_SCOPE);
  u.searchParams.set("state", p.state);
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("actor", "user");
  return u.toString();
}

interface TokenResp { error?: unknown; error_description?: unknown; access_token?: unknown; token_type?: unknown; expires_in?: unknown; scope?: unknown; refresh_token?: unknown }
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** 토큰 응답 → 금고 묶음(OAuthTokens). 실패는 던진다(Linear 는 400 + {error, error_description}). 순수. */
export function parseLinearTokenResponse(j: unknown): OAuthTokens {
  const r = (j ?? {}) as TokenResp;
  const errCode = str(r.error);
  if (errCode) throw new Error(`Linear 토큰 교환 실패: ${errCode}${str(r.error_description) ? ` — ${str(r.error_description)}` : ""}`);
  const tok = str(r.access_token);
  if (!tok) throw new Error("Linear 가 access_token 을 주지 않았습니다 — 동의가 완료되지 않았습니다.");
  const out: OAuthTokens = { access_token: tok, token_type: str(r.token_type) ?? "Bearer" };
  if (typeof r.expires_in === "number" && Number.isFinite(r.expires_in)) out.expires_in = r.expires_in;
  const rt = str(r.refresh_token); if (rt) out.refresh_token = rt;
  const sc = str(r.scope); if (sc) out.scope = sc;
  return out;
}

/** code → token 교환(form 인코딩, client_secret 동봉). */
export async function exchangeLinearCode(p: {
  clientId: string; clientSecret: string; code: string; redirectUri: string; fetchFn: FetchLike;
}): Promise<OAuthTokens> {
  const form = new URLSearchParams({
    grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, client_id: p.clientId, client_secret: p.clientSecret,
  });
  const res = await p.fetchFn(LINEAR_TOKEN_URL, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString(),
  });
  const text = await res.text().catch(() => "");
  let j: unknown = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* 아래에서 상태로 판정 */ }
  if (!res.ok && !(j && typeof j === "object" && "error" in (j as object))) {
    throw new Error(`Linear 토큰 교환 실패(${res.status})`); // 본문은 싣지 않는다(자격이 되비칠 수 있다)
  }
  return parseLinearTokenResponse(j);
}
