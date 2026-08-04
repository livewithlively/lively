// OAuth 2.1 인가서버 본체 (#1473 T2) — SDK 의 mcpAuthRouter 가 요구하는 OAuthServerProvider 구현.
//  SDK 가 /authorize·/token·/register·/revoke·메타데이터 라우팅과 rate limit 을 이미 준다. 우리가 채우는 건
//  "무엇이 유효한 인가인가"뿐이다. 실제 DB 원자성은 store/oauth.ts 가, 클라이언트 신원은 oauth-clients.ts 가 소유.
//
//  흐름(인가코드 + PKCE S256):
//   1. 클라이언트 → GET /authorize          … SDK 가 client·redirect_uri 검증 후 authorize() 호출
//   2. authorize() → 미결 요청 저장 후 /oauth/consent 로 302  … 사람이 로그인하고 동의
//   3. 동의 승인 → 인가코드 발급 → redirect_uri 로 302(code+state)
//   4. 클라이언트 → POST /token             … SDK 가 PKCE 검증 후 exchangeAuthorizationCode() 호출
//
//  ⚠ 이 경로로는 위험 scope(admin/runtime)가 **절대** 나가지 않는다 — store/oauth.ts 의 grantableScopes 가
//   allowDangerous 를 주지 않는다. 여기 클라이언트는 외부 챗 표면이고, 거기에 fleet 제어권을 주는 것은
//   프롬프트 인젝션 한 방과 같다(판정문 §6-3).
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidTargetError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { LivelyClientsStore } from "./oauth-clients.js";
import { OAUTH_CONSENT_PATH } from "./oauth-consent.js";
import {
  createAuthRequest, challengeForCode, redeemAuthCode, redeemRefreshToken, revokeGrantToken,
} from "../store/oauth.js";
import { isOwnResource, normalizeResource, resourceIds } from "../../auth/resource-id.js";
import { isScope } from "../../auth/scopes.js";
import { BearerVerifier } from "../../auth/bearer.js";
import { logger } from "../../log.js";

// 요청된 resource(RFC 8707)를 확정한다. 우리 앞이 아니면 invalid_target 으로 거절 —
//  "자기 앞으로 발급된 토큰만 수락한다"(MCP 사양 MUST)는 발급 시점부터 지켜야 성립한다.
//  미지정이면 우리 정본(<base>/mcp)으로 **기본 바인딩** 한다 — 대상 없는 토큰을 만들지 않기 위해서다.
async function resolveResource(requested: URL | undefined): Promise<string | null> {
  if (requested) {
    const got = normalizeResource(requested.href);
    if (!(await isOwnResource(got))) throw new InvalidTargetError(`이 서버의 자원이 아닙니다: ${got}`);
    return got;
  }
  return (await resourceIds())?.mcp ?? null;
}

export class LivelyOAuthProvider implements OAuthServerProvider {
  private readonly _clients = new LivelyClientsStore();
  private readonly _verifier = new BearerVerifier();

  get clientsStore(): LivelyClientsStore { return this._clients; }

  // ① 인가 개시 — 아직 아무것도 발급하지 않는다. 파라미터를 미결 요청으로 남기고 사람에게 넘긴다.
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const resource = await resolveResource(params.resource);
    // 모르는 scope 는 **무시**한다(RFC 6749 §3.3 이 허용) — 챗 클라이언트가 openid/profile 같은 값을 섞어 보내는
    //  일이 흔하고, 그걸로 흐름을 끊으면 붙지 않는다. 결과 scope 는 동의 화면이 사람에게 그대로 보여주고
    //  토큰 응답의 scope 로도 회신되므로, 관용이 곧 은밀한 확대가 되지는 않는다.
    const requested = (params.scopes ?? []).filter(isScope);
    const rid = await createAuthRequest({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: requested,
      state: params.state ?? null,
      resource,
    });
    logger.info({ clientId: client.client_id, scopes: requested, resource }, "OAuth 인가요청 개시 — 동의 화면으로");
    res.redirect(302, `${OAUTH_CONSENT_PATH}?rid=${encodeURIComponent(rid)}`);
  }

  // ② SDK 의 PKCE 검증용 조회. 소비하지 않는다(소비는 ③의 원자 트랜잭션).
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const challenge = await challengeForCode(client.client_id, authorizationCode);
    if (!challenge) throw new InvalidGrantError("인가코드가 유효하지 않습니다");
    return challenge;
  }

  // ③ 인가코드 → 토큰. PKCE 는 SDK 가 이미 검증했다(skipLocalPkceValidation 미설정 = 로컬 검증).
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull, authorizationCode: string,
    _codeVerifier?: string, redirectUri?: string, resource?: URL,
  ): Promise<OAuthTokens> {
    const grant = await redeemAuthCode({
      clientId: client.client_id,
      code: authorizationCode,
      redirectUri,
      resource: resource ? normalizeResource(resource.href) : null,
    });
    if (!grant) throw new InvalidGrantError("인가코드가 유효하지 않거나 이미 사용되었습니다");
    return toTokens(grant);
  }

  // ④ 리프레시 → 토큰. 회전 필수 — 옛 리프레시는 죽고 새 것이 나온다.
  async exchangeRefreshToken(
    client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL,
  ): Promise<OAuthTokens> {
    const grant = await redeemRefreshToken({
      clientId: client.client_id,
      refreshToken,
      requestedScopes: scopes?.filter(isScope),
      resource: resource ? normalizeResource(resource.href) : null,
    });
    if (!grant) throw new InvalidGrantError("리프레시 토큰이 유효하지 않습니다");
    return toTokens(grant);
  }

  // ⑤ 액세스 토큰 검증 — 기존 Bearer 검증기를 그대로 쓴다. OAuth 발급분도 auth_token 한 테이블에 있으므로
  //  검증·회수·감사 경로가 하나로 유지된다(schema/oauth.ts 머리주석의 설계 이유 ①②③).
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return this._verifier.verifyAccessToken(token) as unknown as Promise<AuthInfo>;
  }

  // ⑥ RFC 7009 취소 — 자기 클라이언트의 토큰만.
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await revokeGrantToken(client.client_id, request.token);
  }
}

function toTokens(grant: { accessToken: string; expiresIn: number; refreshToken: string; scopes: string[] }): OAuthTokens {
  return {
    access_token: grant.accessToken,
    token_type: "Bearer",
    expires_in: grant.expiresIn,
    refresh_token: grant.refreshToken,
    // 실제 발급된 scope 를 회신한다(요청과 다를 수 있다 — 멤버 상한·위험 scope 제외로 좁아진다).
    scope: grant.scopes.join(" "),
  };
}
