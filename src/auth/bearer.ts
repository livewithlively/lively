import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { LivelyUser } from "../context.js";
import { verifyDbToken } from "../org/store.js";

// 1단계 정적 토큰의 만료(초 단위 Unix). SDK 가 expiresAt 를 필수로 요구한다.
const TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

// @modelcontextprotocol/sdk 의 requireBearerAuth 가 기대하는 AuthInfo 형태.
export interface AuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  extra?: Record<string, unknown>;
}

type TokenTable = Record<string, LivelyUser>;

function loadTokens(): TokenTable {
  const raw = process.env.AUTH_TOKENS_JSON;
  // DB 토큰(auth_token)도 지원하므로 정적 테이블은 선택 — 미설정이면 빈 테이블(DB 만으로 인증).
  if (!raw) return {};
  return JSON.parse(raw) as TokenTable;
}

function authInfo(user: LivelyUser, token: string): AuthInfo {
  return {
    token,
    clientId: user.userId,
    scopes: user.scopes,
    expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    extra: user as unknown as Record<string, unknown>,
  };
}

/**
 * 1단계: 정적 토큰 테이블 검증.
 * 2단계(OAuth 2.1)로 갈 때는 이 클래스만 jose 기반 JWT 검증으로 교체하면 된다.
 * (RFC 9728 메타데이터는 mcpAuthRouter 로 추가)
 */
export class BearerVerifier {
  private tokens: TokenTable;

  constructor() {
    this.tokens = loadTokens();
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // 1) 정적 테이블(AUTH_TOKENS_JSON) — 기존 경로, 무변경.
    const staticUser = this.tokens[token];
    if (staticUser) return authInfo(staticUser, token);
    // 2) DB 토큰(auth_token) — 'lvk_' prefix 만 조회(정적 토큰은 DB hit 회피). revoke 시 즉시 무효.
    if (token.startsWith("lvk_")) {
      const dbUser = await verifyDbToken(token);
      if (dbUser) return authInfo({ ...dbUser } as LivelyUser, token);
    }
    throw new InvalidTokenError("invalid token"); // → 401
  }
}
