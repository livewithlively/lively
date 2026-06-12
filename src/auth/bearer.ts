import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { LivelyUser } from "../context.js";

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
  if (!raw) throw new Error("AUTH_TOKENS_JSON not set (.env 참고)");
  return JSON.parse(raw) as TokenTable;
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
    const user = this.tokens[token];
    if (!user) throw new InvalidTokenError("invalid token"); // → 401
    return {
      token,
      clientId: user.userId,
      scopes: user.scopes,
      expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
      extra: user as unknown as Record<string, unknown>, // → resolveUser() 가 꺼냄
    };
  }
}
