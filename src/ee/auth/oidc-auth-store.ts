// ⚠ Lively Enterprise Edition — 이 디렉터리(src/ee)는 상용 라이센스다. src/ee/LICENSE 참조.
//   유효한 구독 없이 프로덕션에서 사용할 수 없다(열람·개발·테스트는 허용).
//
// pending_oidc_auth — 외부 IdP 로그인(OIDC, #1520)의 진행 중 인가요청 저장 계층.
//  개시(createOidcAuthRequest)는 GET /api/ui/auth/oidc/start 가, 소비(consumeOidcAuthRequest)는
//  콜백 GET /api/ui/auth/oidc/callback 이 부른다(web.ts). 둘 다 **무인증** 표면이다 — 로그인 전이니까.
//  관례는 형제 session-mint.ts 와 동형: 평문 비밀은 저장하지 않고 sha256 만, 소비는 원자적 UPDATE 1회용,
//  lazy GC 로 표를 bound 시키고, 실패 사유는 구분해 노출하지 않는다.
//  db 인자(기본 itemsPool)는 session-mint 와 같은 주입 seam — 단위 테스트가 가짜 풀로 계약을 검증한다.
import crypto from "node:crypto";
import { itemsPool, type Db } from "../../db/client.js";
import { sha256 } from "../../org/store/audit.js";

// TTL 10분 — 사람이 IdP 화면에서 계정을 고르고 동의하는 시간. 60초(session-mint)로는 짧고,
//  더 길면 유출된 state 가 살아 있는 창만 넓어진다.
export const OIDC_AUTH_TTL_MS = 10 * 60 * 1000;

const rnd = (): string => crypto.randomBytes(32).toString("base64url");

export interface OidcAuthRequest { state: string; nonce: string; codeVerifier: string }

// 개시 — state/nonce/PKCE verifier 를 만들어 저장하고 평문을 1회 반환(호출부가 인가 URL 에 심는다).
//  returnTo 는 **경로만** 받는다: 오픈 리다이렉트(로그인 후 외부 사이트로 튕기는 피싱)를 원천 차단하려면
//  저장 시점에 거르는 게 맞다 — 소비 시점 검증은 잊기 쉽고, 여기 들어온 값은 이미 안전하다는 계약이 된다.
//  linkMember: '로그인'이 아니라 '이미 로그인한 그 사람의 계정에 IdP 를 붙이는' 요청(#1520 A). 모드를
//   개시 시점에 못박아야 콜백이 쿼리스트링에 속지 않는다.
export async function createOidcAuthRequest(
  opts?: { returnTo?: string | null; linkMember?: string | null },
  db: Db = itemsPool,
): Promise<OidcAuthRequest> {
  const state = rnd(), nonce = rnd(), codeVerifier = rnd();
  await db.query(
    `INSERT INTO pending_oidc_auth(state_hash, nonce_hash, code_verifier, return_to, expires_at, link_member)
       VALUES($1,$2,$3,$4,$5,$6)`,
    [sha256(state), sha256(nonce), codeVerifier, safeReturnTo(opts?.returnTo),
     new Date(Date.now() + OIDC_AUTH_TTL_MS).toISOString(), opts?.linkMember ?? null],
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
): Promise<{ nonceHash: string; codeVerifier: string; returnTo: string | null; linkMember: string | null } | null> {
  const s = String(state ?? "");
  if (!s || s.length > 200) return null; // 형태만 훑고 DB 왕복을 아낀다(무인증 표면 — 스캐너 노이즈 차단)
  // lazy GC — session-mint 와 같은 관례. 스케줄러 없이도 표가 무한정 자라지 않게.
  try { await db.query(`DELETE FROM pending_oidc_auth WHERE expires_at < now() - interval '1 hour'`); } catch { /* GC 실패는 로그인과 무관 */ }
  const r = await db.query(
    `UPDATE pending_oidc_auth SET used_at=now()
      WHERE state_hash=$1 AND used_at IS NULL AND expires_at > now()
      RETURNING nonce_hash, code_verifier, return_to, link_member`,
    [sha256(s)],
  );
  const row = r.rows[0] as
    { nonce_hash: string; code_verifier: string; return_to: string | null; link_member: string | null } | undefined;
  if (!row) return null;
  return {
    nonceHash: row.nonce_hash, codeVerifier: row.code_verifier,
    returnTo: row.return_to, linkMember: row.link_member,
  };
}

// ── 계정 연결 갈림길(#1520 B) — 신원은 검증됐는데 어느 구성원인지 못 정한 상태를 잠깐 보관한다. ──
export const OIDC_LINK_TTL_MS = 10 * 60 * 1000;

export interface PendingOidcLink { sub: string; email: string; displayName: string | null; canProvision: boolean }

// 발급 — 평문 코드를 1회 반환(저장은 sha256). 이 코드를 쥔 사람 = 그 IdP 계정 인증을 마친 사람이다.
export async function createOidcLink(v: PendingOidcLink, db: Db = itemsPool): Promise<string> {
  const code = rnd();
  await db.query(
    `INSERT INTO pending_oidc_link(code_hash, sub, email, display_name, can_provision, expires_at)
       VALUES($1,$2,$3,$4,$5,$6)`,
    [sha256(code), v.sub, v.email, v.displayName, v.canProvision,
     new Date(Date.now() + OIDC_LINK_TTL_MS).toISOString()],
  );
  return code;
}

// 조회(소비 아님) — 선택 화면을 그릴 때 쓴다. 잘못된 비밀번호로 다시 그려야 할 수 있어 여기서 태우지 않는다.
export async function readOidcLink(code: string, db: Db = itemsPool): Promise<PendingOidcLink | null> {
  const c = String(code ?? "");
  if (!c || c.length > 200) return null;
  const r = await db.query(
    `SELECT sub, email, display_name, can_provision FROM pending_oidc_link
      WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now()`, [sha256(c)]);
  const row = r.rows[0] as
    { sub: string; email: string; display_name: string | null; can_provision: boolean } | undefined;
  if (!row) return null;
  return { sub: row.sub, email: row.email, displayName: row.display_name, canProvision: row.can_provision };
}

// 소비 — 결정(새로 시작/기존 계정 연결)이 확정될 때 1회용으로 태운다. 원자적 UPDATE 라 동시 소비가 막힌다.
export async function consumeOidcLink(code: string, db: Db = itemsPool): Promise<PendingOidcLink | null> {
  const c = String(code ?? "");
  if (!c || c.length > 200) return null;
  try { await db.query(`DELETE FROM pending_oidc_link WHERE expires_at < now() - interval '1 hour'`); } catch { /* GC 실패 무시 */ }
  const r = await db.query(
    `UPDATE pending_oidc_link SET used_at=now()
      WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now()
      RETURNING sub, email, display_name, can_provision`, [sha256(c)]);
  const row = r.rows[0] as
    { sub: string; email: string; display_name: string | null; can_provision: boolean } | undefined;
  if (!row) return null;
  return { sub: row.sub, email: row.email, displayName: row.display_name, canProvision: row.can_provision };
}
