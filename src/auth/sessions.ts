// 사람 웹 로그인 세션(P4) — provider 무관 공통 레이어. authn(누구인가)은 providers(local/oidc)가 입증하고,
//  여기는 '세션 발급/검증/회수' + 세션→LivelyUser 매핑만 담당한다. scope 는 매 요청 org_member.scopes 를
//  LIVE 로 읽어 desync 를 원천 차단한다(토큰과 달리 세션은 사람이 본인으로 행위 → 멤버 권한 그대로).
import crypto from "node:crypto";
import { itemsPool } from "../db/client.js";
import { isScope } from "./scopes.js";
import { workspaceAccessAllowed } from "../org/tenancy/gate.js";
import type { LivelyUser } from "../context.js";

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const COOKIE = "lively_sess";

// 발급 — 평문 세션ID 를 1회 반환(저장은 sha256). prefix 'lvs_' 는 식별용.
//  authMethod·ssoIdTokenEnc 는 로그아웃이 IdP 세션까지 끝낼지 판단하는 재료다(SSO 로그아웃).
//  ssoIdTokenEnc 는 호출자가 이미 암호화한 값만 받는다 — 이 레이어는 IdP 를 모르고 평문 토큰을 만지지 않는다.
export async function createSession(
  memberId: string,
  meta?: { ip?: string | null; userAgent?: string | null; authMethod?: string | null; ssoIdTokenEnc?: string | null },
): Promise<{ sessionId: string; expiresAt: Date }> {
  const sessionId = "lvs_" + crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await itemsPool.query(
    `INSERT INTO web_session(session_hash, member_id, expires_at, ip, user_agent, auth_method, sso_id_token_enc)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [sha256(sessionId), memberId, expiresAt.toISOString(), meta?.ip ?? null, meta?.userAgent ?? null,
      meta?.authMethod ?? null, meta?.ssoIdTokenEnc ?? null],
  );
  return { sessionId, expiresAt };
}

/** 회수한 세션이 어떻게 로그인했는가 — 로그아웃이 IdP 로그아웃 문을 거칠지 정한다. */
export interface RevokedSession { authMethod: string | null; ssoIdTokenEnc: string | null }

// 회수 — 이번 호출이 실제로 끊은 세션이면 그 로그인 방식을 돌려주고, 이미 끊겼거나 없으면 null.
//  보관했던 id_token 은 회수와 같은 문장에서 지운다 — 끝난 세션에 IdP 토큰을 남길 이유가 없다.
//  옛 값은 CTE 로 읽는다: UPDATE 의 RETURNING 은 지운 뒤의 값(NULL)을 돌려준다.
export async function revokeSession(sessionId: string): Promise<RevokedSession | null> {
  const r = await itemsPool.query(
    `WITH old AS (
       SELECT session_hash, auth_method, sso_id_token_enc FROM web_session
        WHERE session_hash=$1 AND revoked_at IS NULL FOR UPDATE)
     UPDATE web_session w SET revoked_at=now(), sso_id_token_enc=NULL
       FROM old WHERE w.session_hash = old.session_hash
     RETURNING old.auth_method, old.sso_id_token_enc`, [sha256(sessionId)]);
  const row = r.rows[0] as { auth_method: string | null; sso_id_token_enc: string | null } | undefined;
  return row ? { authMethod: row.auth_method, ssoIdTokenEnc: row.sso_id_token_enc } : null;
}

// 끝난 세션의 보관 토큰 정리(정비 스윕) — 로그아웃 없이 창을 닫은 세션은 회수되지 않고 만료만 된다.
//  만료·회수된 행은 다시 쓰이지 않으므로 IdP 토큰을 지운다. 삭제·비활성 구성원의 세션도 30일 안에 만료돼 여기서 정리된다.
export async function reapEndedSessionTokens(): Promise<number> {
  const r = await itemsPool.query(
    `UPDATE web_session SET sso_id_token_enc=NULL
      WHERE sso_id_token_enc IS NOT NULL AND (revoked_at IS NOT NULL OR expires_at < now())`);
  return r.rowCount ?? 0;
}

// (#1631) 사람만 — 사람이 아닌 구성원(운영 계정 등)의 세션은 종류가 바뀐 시점과 무관하게 통과하지 못한다(nonhuman-login.test).
// 세션 → LivelyUser. scope = 멤버에서 LIVE(세션은 사람 본인 행위 → 최소권한 캡 없음). 멤버 비활성/만료/회수면 null.
export async function userFromSession(sessionId: string): Promise<LivelyUser | null> {
  if (!process.env.ITEMS_DATABASE_URL) return null;
  try {
    const r = await itemsPool.query(
      `SELECT s.member_id, m.email, m.state, m.scopes
         FROM web_session s JOIN org_member m ON m.id = s.member_id
        WHERE s.session_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND m.kind='human'`,
      [sha256(sessionId)],
    );
    const row = r.rows[0] as { member_id: string; email: string | null; state: string; scopes: unknown } | undefined;
    if (!row) return null;
    if (row.state !== "active") return null; // 비활성 멤버 → 세션 무효(즉시 차단)
    // 워크스페이스 게이트(#1750) — secondary 컨텍스트면 명부에 있어야 한다. 세션 자체는 박스 전역이라
    //  유효하지만, "이 워크스페이스에서의" 인증으로는 실패시킨다(=401, 남의 개인 ws 는 존재도 안 보인다).
    if (!(await workspaceAccessAllowed(row.member_id))) return null;
    const scopes = Array.isArray(row.scopes)
      ? (row.scopes as unknown[]).filter((x): x is string => typeof x === "string").filter(isScope)
      : [];
    itemsPool.query(`UPDATE web_session SET last_used_at=now() WHERE session_hash=$1`, [sha256(sessionId)]).catch(() => {});
    return { userId: row.member_id, email: row.email ?? "", scopes, projects: ["*"], tokenSource: "session" };
  } catch {
    return null;
  }
}

// 쿠키 헤더에서 세션ID 추출(express 기본 쿠키 파서 없음 — 터미널 ticket 과 동일 수동 파싱).
export function parseSessionCookie(cookieHeader?: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== COOKIE) continue;
    const v = part.slice(eq + 1).trim();
    if (v) return v;
  }
  return null;
}

// Set-Cookie 값 — HttpOnly + SameSite=Lax(크로스사이트 POST 차단 = CSRF 완화) + Secure(PUBLIC_URL 이 https 일 때).
//  Caddy 가 TLS 를 종단해 게이트웨이는 http 로 받지만, PUBLIC_URL 로 '공개 스킴'을 판정해 Secure 를 붙인다. Path=/ 로 전 UI 커버.
function cookieSecure(): string {
  return (process.env.PUBLIC_URL || "").startsWith("https") ? "; Secure" : "";
}
export function sessionCookie(sessionId: string, expiresAt: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${COOKIE}=${sessionId}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${cookieSecure()}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${cookieSecure()}`;
}
