// 로컬 계정(이메일+비번) — authn provider 의 'local' 구현(P4). 비번은 Node 내장 scrypt(메모리-하드 KDF,
//  네이티브 빌드 불요)로 해시만 저장. 외부 의존 0. OIDC 도입 후에도 IdP 없는/에어갭 고객의 영구 폴백 tier.
import crypto from "node:crypto";
import { promisify } from "node:util";
import { itemsPool } from "../db/client.js";

const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike, salt: crypto.BinaryLike, keylen: number, options: crypto.ScryptOptions,
) => Promise<Buffer>;

// scrypt 파라미터 — N=2^14(16384)·r=8·p=1. N*r*128=16MB < 기본 maxmem(32MB). OWASP 권장 범위.
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEYLEN = 64;
// 계정 미존재 시에도 동일 비용을 태워 이메일 열거(timing) 완화.
const BURN_SALT = crypto.randomBytes(16);

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const dk = await scryptAsync(plain, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${dk.toString("base64")}`;
}

export async function verifyPassword(plain: string, encoded: string): Promise<boolean> {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = encoded.split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const dk = await scryptAsync(plain, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

async function burn(plain: string): Promise<void> {
  try { await scryptAsync(plain, BURN_SALT, KEYLEN, SCRYPT); } catch { /* noop */ }
}

// 관리자/본인이 비번 설정 — upsert. mustChange=true 면 초기 비번(첫 로그인 후 변경 권장).
export async function setMemberPassword(
  memberId: string, plain: string, opts?: { mustChange?: boolean; actor?: string | null },
): Promise<void> {
  const hash = await hashPassword(plain);
  await itemsPool.query(
    `INSERT INTO member_credential(member_id, password_hash, must_change, failed_attempts, locked_until, updated_at, updated_by)
       VALUES($1,$2,$3,0,NULL,now(),$4)
     ON CONFLICT (tenant_id, member_id) DO UPDATE SET
       password_hash=EXCLUDED.password_hash, must_change=EXCLUDED.must_change,
       failed_attempts=0, locked_until=NULL, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [memberId, hash, opts?.mustChange ?? false, opts?.actor ?? null],
  );
}

export async function hasCredential(memberId: string): Promise<boolean> {
  const r = await itemsPool.query(`SELECT 1 FROM member_credential WHERE member_id=$1`, [memberId]);
  return (r.rowCount ?? 0) > 0;
}

// 계정 보유 멤버 집합(웹 '구성원' 상태칩용).
export async function membersWithCredentials(): Promise<Set<string>> {
  try {
    const r = await itemsPool.query(`SELECT member_id FROM member_credential`);
    return new Set(r.rows.map((x) => (x as { member_id: string }).member_id));
  } catch {
    return new Set();
  }
}

// 초기/임시 비번 — 사람이 한 번 전달할 읽기 쉬운 12자(영숫자).
export function generateInitialPassword(): string {
  return crypto.randomBytes(12).toString("base64url").replace(/[-_]/g, "").slice(0, 12);
}

export type LoginResult =
  | { ok: true; memberId: string; mustChange: boolean }
  | { ok: false; reason: "invalid" | "no_account" };

// 로그인 검증 — 이메일(대소문자 무시) → 활성 멤버 → credential 확인. 성공 시 memberId 반환.
//  (실패 횟수 락아웃은 제거 — 윤상민 2026-06-24. timing-burn 은 이메일 열거 완화로 유지.)
export async function verifyLogin(email: string, plain: string): Promise<LoginResult> {
  const e = (email ?? "").trim().toLowerCase();
  if (!e || !plain) { await burn(plain || "x"); return { ok: false, reason: "invalid" }; }
  const mr = await itemsPool.query(
    `SELECT id FROM org_member WHERE lower(email)=$1 AND state='active' LIMIT 1`, [e]);
  const member = mr.rows[0] as { id: string } | undefined;
  if (!member) { await burn(plain); return { ok: false, reason: "no_account" }; }
  const cr = await itemsPool.query(
    `SELECT password_hash, must_change FROM member_credential WHERE member_id=$1`, [member.id]);
  const cred = cr.rows[0] as { password_hash: string; must_change: boolean } | undefined;
  if (!cred) { await burn(plain); return { ok: false, reason: "no_account" }; }
  const good = await verifyPassword(plain, cred.password_hash);
  if (!good) return { ok: false, reason: "invalid" };
  return { ok: true, memberId: member.id, mustChange: !!cred.must_change };
}

// 본인 비번 확인(비번 변경 시 현재 비번 검증).
export async function verifyOwnPassword(memberId: string, plain: string): Promise<boolean> {
  const r = await itemsPool.query(`SELECT password_hash FROM member_credential WHERE member_id=$1`, [memberId]);
  const cred = r.rows[0] as { password_hash: string } | undefined;
  if (!cred) { await burn(plain); return false; }
  return verifyPassword(plain, cred.password_hash);
}
