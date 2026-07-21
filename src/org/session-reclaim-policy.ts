// idle 세션 자동 회수(reaper) 정책(#1059 F) — idle TTL. **관리탭(DB)이 단일 창구, env 는 시드.**
//
// 왜 필요(#1059): 어니스트 박스 다운의 만성 축은 claude 세션 누적 baseline(~8GB, 33개×242MB)이었다. admission
//  control(동시 세션 하드 상한)은 정당한 새 세션까지 막아 기각됐고(윤상민), 대신 **오래 idle 인 세션을 주기적으로
//  회수하되 desired-state 를 보존해 열 때 lazy resume**(E) 하는 게 근본 대책으로 채택됐다. 이 정책이 그 '오래'의 기준.
//
// 왜 DB 인가(storage-policy·session-memory-policy 와 동일 교리): 고객 박스는 우리가 SSH 로 못 들어간다 → env 전용이면
//  사실상 아무도 못 바꾼다. 관리탭에서 바꿀 수 있어야 실제로 쓰인다. 우선순위: **DB(관리탭) > env 시드 > 코드 기본값.**
//  ⚠ '이 항목을 안 건드린 저장'은 DB 원본을 그대로 둔다 — resolved 값을 되쓰면 env 시드가 DB 로 굳는다(#688 함정).
//
// 기본값 0 = **회수 끔**(무회귀·놀람 방지): 아무 세션도 자동으로 죽지 않는다. 운영자가 넉넉한 TTL(예: 어니스트
//  16GB → 180~1440분)을 관리탭에서 걸어야 그때부터 그 시간 넘게 idle 인 세션이 회수된다. 회수돼도 desired-state
//  (org_session_state)는 보존되어 restorable 로 남고, 열면 lazy resume(E). **회수 불변식(정책 아님, reaper 하드코딩)**:
//  managed(상시)·attached>0(누가 보는 중)·busy(작업 중)·waiting(승인 대기)는 절대 회수 안 함(#687 오kill 교훈).
//
// 관련: src/session-reaper.ts(이 정책으로 통합목록을 순회·회수) · src/org/session-memory-policy.ts(같은 seam 원형) ·
//  src/org/session-state.ts(회수해도 보존되는 desired-state).

export interface SessionReclaimPolicy {
  /** idle(비작업·미접속) 지속이 이 분(minute)을 넘은 세션을 회수. 0 = 자동 회수 끔(기본, 무회귀). */
  idle_ttl_minutes: number;
}

export type SessionReclaimPolicyPatch = Partial<SessionReclaimPolicy>;

// 기본값 — 0 = 끔(무회귀). 운영자가 관리탭/env 로 박스 상황에 맞춰 켠다.
export const DEFAULT_SESSION_RECLAIM_POLICY: SessionReclaimPolicy = {
  idle_ttl_minutes: 0,
};

// 관리탭·검증 노출 상수 — 0(끔) ~ 43200분(30일; 그 이상은 사실상 안 켠 것).
export const RECLAIM_TTL_MIN_MIN = 0;
export const RECLAIM_TTL_MIN_MAX = 43_200;

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// env 시드(.env) — 최초 부팅·구박스 호환용 초기값. 관리탭에서 한 번 저장하면 그 뒤론 DB 가 이긴다.
function envSeed(): SessionReclaimPolicyPatch {
  const p: SessionReclaimPolicyPatch = {};
  if (process.env.LIVELY_SESSION_IDLE_TTL_MIN) p.idle_ttl_minutes = clampInt(process.env.LIVELY_SESSION_IDLE_TTL_MIN, RECLAIM_TTL_MIN_MIN, RECLAIM_TTL_MIN_MAX, DEFAULT_SESSION_RECLAIM_POLICY.idle_ttl_minutes);
  return p;
}

// 잡값 방어 — 관리탭 입력이든 env 든 범위를 벗어나면 시드/기본값으로.
export function normalizeSessionReclaimPolicy(raw: unknown): SessionReclaimPolicy {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const base = { ...DEFAULT_SESSION_RECLAIM_POLICY, ...envSeed() }; // DB 값이 없는 항목은 env 시드 → 기본값 순
  return {
    idle_ttl_minutes: r.idle_ttl_minutes !== undefined ? clampInt(r.idle_ttl_minutes, RECLAIM_TTL_MIN_MIN, RECLAIM_TTL_MIN_MAX, base.idle_ttl_minutes) : base.idle_ttl_minutes,
  };
}

/** DB 원본(JSONB) → 유효 정책. DB 우선, 비면 env 시드, 그 다음 기본값. */
export function resolveSessionReclaimPolicy(dbRaw: unknown): SessionReclaimPolicy {
  return normalizeSessionReclaimPolicy(dbRaw);
}

/** 유효 정책의 출처(관리 UI 안내) — 관리탭 저장값인지, .env 시드인지, 코드 기본값인지. */
export function sessionReclaimPolicySource(dbRaw: unknown): "db" | "env" | "default" {
  if (dbRaw && typeof dbRaw === "object" && Object.keys(dbRaw as object).length > 0) return "db";
  if (Object.keys(envSeed()).length > 0) return "env";
  return "default";
}

// ── 캐시 ──
// reaper 는 주기(수 분)로만 조회하나, storage/session-memory 와 동형으로 짧은 캐시 + DB 실패 시 폴백(회수 판정이
//  정책 조회로 막히지 않게 — 못 읽으면 마지막 값→기본값(0=끔)으로, 절대 throw 하지 않는다).
let cache: { at: number; policy: SessionReclaimPolicy } | null = null;

export async function effectiveSessionReclaimPolicy(
  load: () => Promise<SessionReclaimPolicy>,
  ttlMs = 30_000,
  now: () => number = Date.now,
): Promise<SessionReclaimPolicy> {
  if (cache && now() - cache.at < ttlMs) return cache.policy;
  try {
    const policy = await load();
    cache = { at: now(), policy };
    return policy;
  } catch {
    return cache?.policy ?? normalizeSessionReclaimPolicy(null);
  }
}

/** 관리탭에서 정책을 저장한 직후 호출 — 다음 회수 tick 이 즉시 새 값을 보게. */
export function invalidateSessionReclaimPolicyCache(): void {
  cache = null;
}
