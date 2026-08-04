import crypto from "node:crypto";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { LivelyUser } from "../context.js";
import { verifyDbToken } from "../org/store.js";
import { isScope, DANGEROUS_SCOPES, type Scope } from "./scopes.js";
import { isOwnResource } from "./resource-id.js";
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
  resource?: URL;   // RFC 8707 대상(SDK 규격 필드) — OAuth 발급분만 채워진다.
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

function authInfo(user: LivelyUser, token: string, over?: { expiresAt?: number | null; resource?: string | null }): AuthInfo {
  // SDK 의 requireBearerAuth 는 expiresAt 을 **필수**로 본다(없으면 'Token has no expiration time' 401).
  //  만료 없는 종전 토큰은 여기서 1년짜리 합성값을 주고, OAuth 발급분(짧은 수명)은 DB 값을 그대로 쓴다.
  const expiresAt = over?.expiresAt ?? Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  let resource: URL | undefined;
  if (over?.resource) { try { resource = new URL(over.resource); } catch { /* 형태 이상 → 미표기(검증은 이미 통과) */ } }
  return {
    token,
    clientId: user.userId,
    scopes: user.scopes,
    expiresAt,
    resource,
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
      if (dbUser) {
        // ★ audience 바인딩(#1473 T2, MCP 사양 MUST) — 남의 자원서버 앞으로 발급된 토큰은 받지 않는다(패스스루 금지).
        //  resource 가 NULL 인 종전 토큰은 제약 없음(무회귀). OAuth 발급분만 여기서 걸린다.
        if (!(await isOwnResource(dbUser.resource))) {
          logger.warn({ clientId: dbUser.clientId, resource: dbUser.resource },
            "다른 자원서버 앞으로 발급된 토큰 거부(audience 불일치)");
          throw new InvalidTokenError("token audience does not match this resource server");
        }
        const { clientId, resource, expiresAt, ...identity } = dbUser;
        return authInfo(
          {
            ...identity, tokenSource: "db", tokenHashPrefix: sha256Hex(token).slice(0, 12),
            ...(clientId ? { oauthClientId: clientId } : {}),
          } as LivelyUser,
          token,
          { expiresAt, resource },
        );
      }
    }
    throw new InvalidTokenError("invalid token"); // → 401
  }
}
