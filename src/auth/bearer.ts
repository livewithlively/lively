import crypto from "node:crypto";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { LivelyUser } from "../context.js";
import { verifyDbToken } from "../org/store.js";
import { isScope, DANGEROUS_SCOPES, type Scope } from "../capabilities/scopes.js";
import { logger } from "../log.js";

const sha256Hex = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

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

// P2: 정적 토큰(AUTH_TOKENS_JSON)은 회수 불가 → 사람·특권용으로 부적합. 로드 시 위험 scope(admin/runtime)를
//  떨궈 정적 토큰이 절대 특권을 띠지 못하게 한다(B5 가 쓰기를 막는 것의 읽기측 보강 — canEdit 도 false 로 일관).
//  사람형 principal 이 남아 있으면 회수가능 DB 토큰/로그인으로 이전하라고 경고한다.
function sanitizeStaticTokens(table: TokenTable): TokenTable {
  const principals: string[] = [];
  for (const user of Object.values(table)) {
    const scopes = Array.isArray(user.scopes) ? user.scopes.filter(isScope) : [];
    const dangerous = scopes.filter((s) => DANGEROUS_SCOPES.has(s as Scope));
    if (dangerous.length) {
      logger.warn({ userId: user.userId, dropped: dangerous },
        "정적 토큰에서 위험 scope 제거 — 정적 토큰은 admin/runtime 불가(회수 가능한 DB 토큰을 쓰세요)");
    }
    user.scopes = scopes.filter((s) => !DANGEROUS_SCOPES.has(s as Scope));
    principals.push(user.userId);
  }
  if (principals.length) {
    logger.warn({ principals },
      "AUTH_TOKENS_JSON 정적 토큰 사용 중(회수 불가) — 사람 로그인/회수가능 DB 토큰으로 이전 권장(P2)");
  }
  return table;
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
    this.tokens = sanitizeStaticTokens(loadTokens());
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // 1) 정적 테이블(AUTH_TOKENS_JSON) — 회수 불가 토큰. tokenSource:'static' 으로 표시해
    //    admin/runtime 행위를 거부한다(B5: revoke 안 되는 토큰으로 fleet 코드/정책 변경 금지).
    const staticUser = this.tokens[token];
    if (staticUser) return authInfo({ ...staticUser, tokenSource: "static" }, token);
    // 2) DB 토큰(auth_token) — 'lvk_' prefix 만 조회(정적 토큰은 DB hit 회피). revoke 시 즉시 무효.
    //    tokenHashPrefix 는 감사 상관추적용(회수 대상 즉시 특정 — 비밀 아님).
    if (token.startsWith("lvk_")) {
      const dbUser = await verifyDbToken(token);
      if (dbUser) return authInfo(
        { ...dbUser, tokenSource: "db", tokenHashPrefix: sha256Hex(token).slice(0, 12) } as LivelyUser,
        token,
      );
    }
    throw new InvalidTokenError("invalid token"); // → 401
  }
}
