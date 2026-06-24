// 사람 웹 로그인 세션(P4) — provider 무관 공통 레이어. authn(누구인가)은 providers(local/oidc)가 입증하고,
//  여기는 '세션 발급/검증/회수' + 세션→LivelyUser 매핑만 담당한다. scope 는 매 요청 org_member.scopes 를
//  LIVE 로 읽어 desync 를 원천 차단한다(토큰과 달리 세션은 사람이 본인으로 행위 → 멤버 권한 그대로).
import crypto from "node:crypto";
import { itemsPool } from "../items/store.js";
import { isScope } from "../capabilities/scopes.js";
import type { LivelyUser } from "../context.js";

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const COOKIE = "lively_sess";

// 발급 — 평문 세션ID 를 1회 반환(저장은 sha256). prefix 'lvs_' 는 식별용.
export async function createSession(
  memberId: string,
  meta?: { ip?: string | null; userAgent?: string | null },
): Promise<{ sessionId: string; expiresAt: Date }> {
  const sessionId = "lvs_" + crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await itemsPool.query(
    `INSERT INTO web_session(session_hash, member_id, expires_at, ip, user_agent) VALUES($1,$2,$3,$4,$5)`,
    [sha256(sessionId), memberId, expiresAt.toISOString(), meta?.ip ?? null, meta?.userAgent ?? null],
  );
  return { sessionId, expiresAt };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await itemsPool.query(
    `UPDATE web_session SET revoked_at=now() WHERE session_hash=$1 AND revoked_at IS NULL`, [sha256(sessionId)]);
}

// 세션 → LivelyUser. scope = 멤버에서 LIVE(세션은 사람 본인 행위 → 최소권한 캡 없음). 멤버 비활성/만료/회수면 null.
export async function userFromSession(sessionId: string): Promise<LivelyUser | null> {
  if (!process.env.ITEMS_DATABASE_URL) return null;
  try {
    const r = await itemsPool.query(
      `SELECT s.member_id, m.email, m.state, m.scopes
         FROM web_session s JOIN org_member m ON m.id = s.member_id
        WHERE s.session_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sha256(sessionId)],
    );
    const row = r.rows[0] as { member_id: string; email: string | null; state: string; scopes: unknown } | undefined;
    if (!row) return null;
    if (row.state !== "active") return null; // 비활성 멤버 → 세션 무효(즉시 차단)
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

// Set-Cookie 값 — HttpOnly + SameSite=Lax(크로스사이트 POST 차단 = CSRF 완화). 파일럿 http 허용 위해 Secure 생략
//  (https 배포 시 Secure 추가 권장). Path=/ 로 전 UI 표면 커버.
export function sessionCookie(sessionId: string, expiresAt: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${COOKIE}=${sessionId}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}
