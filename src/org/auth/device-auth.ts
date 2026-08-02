// CLI 브라우저 로그인 — 디바이스 코드 흐름 (#880). RFC 8628 을 1st-party 로 차용.
//  CLI 가 device_code(비밀) 보유 · 사람이 user_code 를 브라우저에서 승인 · CLI 가 폴링해 토큰 수령.
//  평문 토큰은 저장하지 않는다 — 폴 시점에 mintToken(트랜잭션 원자적). 설계: [[cli-browser-login-device-code-880-design]]
//
// 보안 요약(설계 R1~R3 반영):
//  · PKCE 개시자 바인딩: start 에 code_challenge=S256(verifier), poll 에 verifier → device_code 도난 상환 차단.
//  · verifier 를 **먼저** 검증(타이머 갱신 전) → device_code 만 든 제3자가 남의 타이머를 grief 못 함.
//  · 원자적 consume: UPDATE…WHERE status='approved' RETURNING + mintToken 을 한 BEGIN/COMMIT → double-mint·orphan 토큰 0.
//  · 발급 scope = member LIVE ∩ approver_scopes ∩ (control-plane? 전체 : 비위험) — token/self 와 동형(증폭 불가).
//  · GC: reaper + lazy delete-on-read(스케줄러 off 인스턴스 대비).

import crypto from "node:crypto";
import { itemsPool } from "../../db/client.js";
import { mintToken, getMember } from "../store.js";
import { DANGEROUS_SCOPES, isScope, type Scope } from "../../auth/scopes.js";
import { HttpError } from "../../http-error.js";

const EXPIRES_IN = 900;   // device_code TTL(초). RFC 권장 900~1800.
const INTERVAL = 5;       // 폴 최소 간격(초). slow_down 판정 기준.
// user_code 알파벳 — Crockford base32 에서 혼동문자(0,1,I,L,O,U) 제외한 20자(base-20). 8자 ≈ 34.6bit.
const UC_ALPHABET = "ABCDEFGHJKMNPQRSTVWX";
const START_RETRY = 6;    // user_code 충돌(23505) 재생성 상한.
const LABEL_MAX = 40;

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
// PKCE S256: base64url(sha256(verifier)). CLI 도 동일 계산해 code_challenge 로 보낸다.
const s256 = (verifier: string): string => crypto.createHash("sha256").update(verifier).digest("base64url");

function genUserCode(): string {
  const buf = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += UC_ALPHABET[buf[i] % UC_ALPHABET.length];
  return out;
}
const genDeviceCode = (): string => crypto.randomBytes(32).toString("base64url");

// 표시형(XXXX-XXXX)·소문자·공백 어떻게 들어와도 저장형(8자 대문자, 영숫자만)으로 정규화.
export function normalizeUserCode(raw: unknown): string {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}
// 표시용 그룹핑(4-4).
export const formatUserCode = (uc: string): string => uc.length === 8 ? `${uc.slice(0, 4)}-${uc.slice(4)}` : uc;

function sanitizeLabel(raw: unknown): string | null {
  const s = String(raw ?? "").replace(/[^\w .@-]/g, "").trim().slice(0, LABEL_MAX);
  return s || null;
}

export interface StartResult {
  device_code: string; user_code: string;
  verification_uri: string; verification_uri_complete: string;
  expires_in: number; interval: number;
}

// ① start — 무인증. code_challenge(필수)·label(선택)·verificationBase(서버가 selfUrl 로 산출) 받아 pending 행 생성.
export async function startDeviceAuth(codeChallenge: string, label: unknown, verificationBase: string): Promise<StartResult> {
  const challenge = String(codeChallenge || "").trim();
  if (!/^[A-Za-z0-9_-]{16,}$/.test(challenge)) throw new HttpError(400, "code_challenge 가 올바르지 않습니다");
  const cleanLabel = sanitizeLabel(label);
  const base = verificationBase.replace(/\/+$/, "");
  for (let attempt = 0; attempt < START_RETRY; attempt++) {
    const deviceCode = genDeviceCode();
    const userCode = genUserCode();
    try {
      await itemsPool.query(
        `INSERT INTO pending_device_auth(device_code_hash, user_code, code_challenge, client_label, expires_at)
           VALUES($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)`,
        [sha256(deviceCode), userCode, challenge, cleanLabel, String(EXPIRES_IN)],
      );
      return {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${base}/ui/#/activate`,
        verification_uri_complete: `${base}/ui/#/activate?code=${formatUserCode(userCode)}`,
        expires_in: EXPIRES_IN,
        interval: INTERVAL,
      };
    } catch (e) {
      // 23505 = user_code 부분 유니크 충돌(동시 pending) → 재생성. device_code_hash PK 충돌은 사실상 불가(256bit).
      if ((e as { code?: string })?.code === "23505" && attempt < START_RETRY - 1) continue;
      throw e;
    }
  }
  throw new Error("user_code 생성 실패(충돌 과다)");
}

export type PollResult =
  | { ok: true; token: string; scopes: string[] }
  | { ok: false; error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_verifier"; interval?: number };

// ② poll — 무인증(device_code+verifier 가 비밀). 순서: verifier 먼저 → 만료·거부·consumed → 타이머 → pending → approved.
export async function pollDeviceAuth(deviceCode: string, codeVerifier: string): Promise<PollResult> {
  const hash = sha256(String(deviceCode || ""));
  const sel = await itemsPool.query(
    `SELECT code_challenge, status, member_id, include_control_plane, approver_scopes,
            (expires_at <= now()) AS expired,
            EXTRACT(EPOCH FROM (now() - last_polled_at)) AS since_poll
       FROM pending_device_auth WHERE device_code_hash=$1`,
    [hash],
  );
  // 행 없음(GC 됨·애초에 없음) → invalid_verifier(404 아님 — 존재 여부조차 노출 안 함). CLI 는 terminal 취급.
  if (sel.rowCount === 0) return { ok: false, error: "invalid_verifier" };
  const row = sel.rows[0] as {
    code_challenge: string; status: string; member_id: string | null;
    include_control_plane: boolean; approver_scopes: unknown; expired: boolean; since_poll: string | null;
  };
  // verifier 먼저 — 불일치면 타이머도 안 건드리고 종료(남의 흐름 보호).
  if (s256(String(codeVerifier || "")) !== row.code_challenge) return { ok: false, error: "invalid_verifier" };
  if (row.expired) return { ok: false, error: "expired_token" };
  if (row.status === "denied") return { ok: false, error: "access_denied" };
  if (row.status === "consumed") return { ok: false, error: "expired_token" };

  if (row.status === "pending") {
    const since = row.since_poll == null ? Infinity : Number(row.since_poll);
    if (since < INTERVAL) return { ok: false, error: "slow_down", interval: INTERVAL };
    await itemsPool.query(`UPDATE pending_device_auth SET last_polled_at=now() WHERE device_code_hash=$1 AND status='pending'`, [hash]);
    return { ok: false, error: "authorization_pending", interval: INTERVAL };
  }

  // status === 'approved' → 원자적 consume + 발급(한 트랜잭션).
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `UPDATE pending_device_auth SET status='consumed'
         WHERE device_code_hash=$1 AND status='approved' AND expires_at > now() AND code_challenge=$2
       RETURNING member_id, include_control_plane, approver_scopes`,
      [hash, row.code_challenge],
    );
    if (claim.rowCount !== 1) {
      // 동시 폴이 먼저 consume 했거나 만료 — 롤백 후 소비됨으로 취급.
      await client.query("ROLLBACK");
      return { ok: false, error: "expired_token" };
    }
    const c = claim.rows[0] as { member_id: string; include_control_plane: boolean; approver_scopes: unknown };
    const mem = await getMember(c.member_id);            // 멤버 LIVE scope(발급 시점 권위)
    if (!mem || mem.state !== "active") {                // 승인↔폴 사이 비활성화 → 발급 자체 생략(inert 토큰 누수 방지)
      await client.query("COMMIT");                      // 행은 consumed 로 소진(재시도 무의미)
      return { ok: false, error: "access_denied" };
    }
    const live: string[] = Array.isArray(mem.scopes) ? mem.scopes.filter(isScope) : [];
    const approver = new Set(Array.isArray(c.approver_scopes) ? (c.approver_scopes as unknown[]).filter((x): x is string => typeof x === "string") : []);
    const scopes = live.filter((s) => approver.has(s) && (c.include_control_plane || !DANGEROUS_SCOPES.has(s as Scope)));
    const { token } = await mintToken(
      { userId: c.member_id, scopes, label: "device-cli", memberId: c.member_id },
      c.member_id, "device-login", client,
    );
    await client.query("COMMIT");
    return { ok: true, token, scopes };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => { /* */ });
    throw e;
  } finally {
    client.release();
  }
}

export interface LookupResult {
  user_code: string; client_label: string | null;
  created_at: string; expires_at: string; status: string;
}
// ③ lookup — 세션(비-정적) 전용. 승인 화면 표시용(pending·미만료만). client_ip 는 반환 안 함(trust proxy 미설정, F4).
export async function lookupDeviceAuth(userCode: string): Promise<LookupResult | null> {
  const uc = normalizeUserCode(userCode);
  if (uc.length !== 8) return null;
  const r = await itemsPool.query(
    `SELECT user_code, client_label, created_at, expires_at, status
       FROM pending_device_auth WHERE user_code=$1 AND status='pending' AND expires_at > now()`,
    [uc],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return {
    user_code: formatUserCode(row.user_code),
    client_label: row.client_label ?? null,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    status: row.status,
  };
}

// ④ approve — 세션(비-정적) 전용. 승인자 scope 스냅샷 기록 + control-plane opt-in(멤버가 보유 시만 유효).
export async function approveDeviceAuth(userCode: string, memberId: string, approverScopes: string[], includeControlPlane: boolean): Promise<boolean> {
  const uc = normalizeUserCode(userCode);
  if (uc.length !== 8) return false;
  const r = await itemsPool.query(
    `UPDATE pending_device_auth
        SET member_id=$2, approver_scopes=$3::jsonb, include_control_plane=$4, status='approved', approved_at=now()
      WHERE user_code=$1 AND status='pending' AND expires_at > now()`,
    [uc, memberId, JSON.stringify(approverScopes.filter(isScope)), includeControlPlane],
  );
  return (r.rowCount ?? 0) === 1;
}

// ⑤ deny — 세션(비-정적) 전용. pending 만(재사용 user_code 의 terminal 행 오염 방지).
export async function denyDeviceAuth(userCode: string): Promise<boolean> {
  const uc = normalizeUserCode(userCode);
  if (uc.length !== 8) return false;
  const r = await itemsPool.query(
    `UPDATE pending_device_auth SET status='denied' WHERE user_code=$1 AND status='pending'`,
    [uc],
  );
  return (r.rowCount ?? 0) === 1;
}

// reaper — 만료 1시간 경과 행 삭제(테이블·user_code 회수). index.ts 스케줄러가 주기 호출 + start/poll 이 lazy 백업.
export async function reapDeviceAuth(): Promise<number> {
  const r = await itemsPool.query(`DELETE FROM pending_device_auth WHERE expires_at < now() - interval '1 hour'`);
  return r.rowCount ?? 0;
}

// ── rate-limit(인증축) — approve/deny/lookup 의 세션당 분당 시도 상한. in-memory 슬라이딩윈도우(최소 프리미티브).
//  start/poll(무인증)엔 하드캡 없음 — TTL+GC 가 테이블을 bound(설계 F6: 낮은 전역캡이 곧 로그인 DoS 라 폐기).
const RATE_MAX = 60;          // 멤버당 60회/분
const RATE_WINDOW_MS = 60_000;
const rateHits = new Map<string, number[]>();
export function checkDeviceRate(memberId: string): boolean {
  const now = Date.now();
  const arr = (rateHits.get(memberId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { rateHits.set(memberId, arr); return false; }
  arr.push(now);
  rateHits.set(memberId, arr);
  return true;
}
