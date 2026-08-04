// pending_oidc_auth — 외부 IdP 로그인(OIDC, #1520)의 진행 중 인가요청 저장 계층.
//  개시(createOidcAuthRequest)는 GET /api/ui/auth/oidc/start 가, 소비(consumeOidcAuthRequest)는
//  콜백 GET /api/ui/auth/oidc/callback 이 부른다(web.ts). 둘 다 **무인증** 표면이다 — 로그인 전이니까.
//  관례는 형제 session-mint.ts 와 동형: 평문 비밀은 저장하지 않고 sha256 만, 소비는 원자적 UPDATE 1회용,
//  lazy GC 로 표를 bound 시키고, 실패 사유는 구분해 노출하지 않는다.
//  db 인자(기본 itemsPool)는 session-mint 와 같은 주입 seam — 단위 테스트가 가짜 풀로 계약을 검증한다.
import crypto from "node:crypto";
import { itemsPool, type Db } from "../../db/client.js";
import { sha256 } from "./audit.js";

// TTL 10분 — 사람이 IdP 화면에서 계정을 고르고 동의하는 시간. 60초(session-mint)로는 짧고,
//  더 길면 유출된 state 가 살아 있는 창만 넓어진다.
export const OIDC_AUTH_TTL_MS = 10 * 60 * 1000;

const rnd = (): string => crypto.randomBytes(32).toString("base64url");

export interface OidcAuthRequest { state: string; nonce: string; codeVerifier: string }

// 개시 — state/nonce/PKCE verifier 를 만들어 저장하고 평문을 1회 반환(호출부가 인가 URL 에 심는다).
//  returnTo 는 **경로만** 받는다: 오픈 리다이렉트(로그인 후 외부 사이트로 튕기는 피싱)를 원천 차단하려면
//  저장 시점에 거르는 게 맞다 — 소비 시점 검증은 잊기 쉽고, 여기 들어온 값은 이미 안전하다는 계약이 된다.
export async function createOidcAuthRequest(
  opts?: { returnTo?: string | null },
  db: Db = itemsPool,
): Promise<OidcAuthRequest> {
  const state = rnd(), nonce = rnd(), codeVerifier = rnd();
  await db.query(
    `INSERT INTO pending_oidc_auth(state_hash, nonce_hash, code_verifier, return_to, expires_at)
       VALUES($1,$2,$3,$4,$5)`,
    [sha256(state), sha256(nonce), codeVerifier, safeReturnTo(opts?.returnTo),
     new Date(Date.now() + OIDC_AUTH_TTL_MS).toISOString()],
  );
  return { state, nonce, codeVerifier };
}

// 로그인 후 돌아갈 경로 — same-origin 경로만 허용. '//evil.com'(스킴 상대 URL)과 '/\evil.com' 은
//  브라우저가 외부 호스트로 해석하므로 '/' 로 시작하되 두 번째 글자가 '/' 나 '\' 면 거절한다.
export function safeReturnTo(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\")) return null;
  return s.slice(0, 500);
}

// 소비 — 1회용. used_at 마킹과 유효성(미사용·미만료) 판정을 UPDATE 한 문장으로 묶어 동시 소비를 DB 가 막는다.
//  반환값의 nonceHash 는 호출부가 id_token 의 nonce 를 해시해 대조하는 데 쓴다(원본은 저장하지 않았다).
export async function consumeOidcAuthRequest(
  state: string,
  db: Db = itemsPool,
): Promise<{ nonceHash: string; codeVerifier: string; returnTo: string | null } | null> {
  const s = String(state ?? "");
  if (!s || s.length > 200) return null; // 형태만 훑고 DB 왕복을 아낀다(무인증 표면 — 스캐너 노이즈 차단)
  // lazy GC — session-mint 와 같은 관례. 스케줄러 없이도 표가 무한정 자라지 않게.
  try { await db.query(`DELETE FROM pending_oidc_auth WHERE expires_at < now() - interval '1 hour'`); } catch { /* GC 실패는 로그인과 무관 */ }
  const r = await db.query(
    `UPDATE pending_oidc_auth SET used_at=now()
      WHERE state_hash=$1 AND used_at IS NULL AND expires_at > now()
      RETURNING nonce_hash, code_verifier, return_to`,
    [sha256(s)],
  );
  const row = r.rows[0] as { nonce_hash: string; code_verifier: string; return_to: string | null } | undefined;
  if (!row) return null;
  return { nonceHash: row.nonce_hash, codeVerifier: row.code_verifier, returnTo: row.return_to };
}
