// idle 세션 자동 회수(reaper) 정책(#1059 F) — idle TTL. **관리탭(DB)이 단일 창구, env 는 시드.**
//
// 왜 필요(#1059): 고객사 A 박스 다운의 만성 축은 claude 세션 누적 baseline(~8GB, 33개×242MB)이었다. admission
//  control(동시 세션 하드 상한)은 정당한 새 세션까지 막아 기각됐고(윤상민), 대신 **오래 idle 인 세션을 주기적으로
//  회수하되 desired-state 를 보존해 열 때 lazy resume**(E) 하는 게 근본 대책으로 채택됐다. 이 정책이 그 '오래'의 기준.
//
// 왜 DB 인가(storage-policy·session-memory-policy 와 동일 교리): 고객 박스는 우리가 SSH 로 못 들어간다 → env 전용이면
//  사실상 아무도 못 바꾼다. 관리탭에서 바꿀 수 있어야 실제로 쓰인다. 우선순위: **DB(관리탭) > env 시드 > 코드 기본값.**
//  ⚠ '이 항목을 안 건드린 저장'은 DB 원본을 그대로 둔다 — resolved 값을 되쓰면 env 시드가 DB 로 굳는다(#688 함정).
//
// 기본값 0 = **회수 끔**(무회귀·놀람 방지): 아무 세션도 자동으로 죽지 않는다. 운영자가 넉넉한 TTL(예: 고객사 A
//  16GB → 180~1440분)을 관리탭에서 걸어야 그때부터 그 시간 넘게 idle 인 세션이 회수된다. 회수돼도 desired-state
//  (org_session_state)는 보존되어 restorable 로 남고, 열면 lazy resume(E). **회수 불변식(정책 아님, reaper 하드코딩)**:
//  managed(상시)·attached>0(누가 보는 중)·busy(작업 중)·waiting(승인 대기)는 절대 회수 안 함(#687 오kill 교훈).
//
// 관련: src/sessions/session-reaper.ts(이 정책으로 통합목록을 순회·회수) · src/sessions/session-memory-policy.ts(같은 seam 원형) ·
//  src/sessions/session-state.ts(회수해도 보존되는 desired-state).

import { definePolicy } from "../org/policies/knob.js";

export interface SessionReclaimPolicy {
  /** idle(비작업·미접속) 지속이 이 분(minute)을 넘은 세션을 회수. 0 = 자동 회수 끔(기본, 무회귀). */
  idle_ttl_minutes: number;
  /**
   * #1220 압박 회수 — 메모리 **사용률(%)** 이 이 값 이상이면 평시 TTL 을 기다리지 않고 회수한다. 0 = 끔(기본).
   *
   * 왜 필요: 종전엔 압박이 임계에 닿으면 **earlyoom 이 먼저 개입**했는데, 그건 예고도 desired-state 보존 신호도
   *  없는 SIGTERM 이라 사용자 눈엔 세션이 그냥 사라진다(고객사 A 실측 2026-07-28: 마이크가 '주기적으로 회수된다'고
   *  신고했지만 F 는 꺼져 있었고 범인은 earlyoom 이었다). 게이트웨이가 **그 앞에서** 같은 일을 하면 회수는
   *  desired-state 를 보존해 restorable 로 남고(E), 링크를 열면 그 자리에서 복원된다 — 같은 메모리 확보를
   *  '복구 가능한 정상 경로'로 하는 것이다.
   *
   * idle_ttl_minutes 와 **독립**이다: 평시 회수는 끄고(0) 압박 때만 켜는 운영이 성립한다.
   */
  pressure_used_pct: number;
  /**
   * 압박 회수가 쓰는 **완화 idle 기준(분)**. 압박 상황에서도 "방금까지 쓰던 세션"은 건드리지 않기 위한 하한선.
   * 평시 TTL(idle_ttl_minutes)보다 짧게 잡는다(예: 평시 1440 · 압박 60).
   * ⚠ 이 값이 0 이어도 회수 안전 불변식(managed·접속중·작업중·복원가능)은 그대로 적용된다 — 정책이 못 푸는 하드락이다.
   */
  pressure_idle_minutes: number;
}

export type SessionReclaimPolicyPatch = Partial<SessionReclaimPolicy>;

// 기본값 — 0 = 끔(무회귀). 운영자가 관리탭/env 로 박스 상황에 맞춰 켠다.
export const DEFAULT_SESSION_RECLAIM_POLICY: SessionReclaimPolicy = {
  idle_ttl_minutes: 0,
  pressure_used_pct: 0,      // 0 = 압박 회수 끔(무회귀)
  pressure_idle_minutes: 60, // 켰을 때의 기본 하한 — '한 시간 넘게 손 안 댄 세션'
};

// 관리탭·검증 노출 상수 — 0(끔) ~ 43200분(30일; 그 이상은 사실상 안 켠 것).
export const RECLAIM_TTL_MIN_MIN = 0;
export const RECLAIM_TTL_MIN_MAX = 43_200;
// 압박 임계(%) — 0(끔) ~ 99. 100 은 '절대 발동 안 함'이라 0(끔)과 뜻이 겹쳐 막는다(설정 실수 방지).
export const RECLAIM_PRESSURE_PCT_MIN = 0;
export const RECLAIM_PRESSURE_PCT_MAX = 99;

// 노브 선언(#1313 R47) — 범위·env 시드는 이 표가 전부. 클램프/시드/우선순위 골격은 knob.ts 가 맡는다.
//  loose: R47 이전 이 모듈의 숫자 해석(Number(v) 직행)을 그대로 보존(byte-compat). 새 정책은 쓰지 마라 — knob.ts 참조.
const policy = definePolicy<SessionReclaimPolicy>({
  defaults: DEFAULT_SESSION_RECLAIM_POLICY,
  fields: {
    idle_ttl_minutes: { env: "LIVELY_SESSION_IDLE_TTL_MIN", min: RECLAIM_TTL_MIN_MIN, max: RECLAIM_TTL_MIN_MAX, loose: true },
    pressure_used_pct: { env: "LIVELY_SESSION_PRESSURE_PCT", min: RECLAIM_PRESSURE_PCT_MIN, max: RECLAIM_PRESSURE_PCT_MAX, loose: true },
    pressure_idle_minutes: { env: "LIVELY_SESSION_PRESSURE_IDLE_MIN", min: RECLAIM_TTL_MIN_MIN, max: RECLAIM_TTL_MIN_MAX, loose: true },
  },
});

/** 잡값 방어 — 관리탭 입력이든 env 든 범위를 벗어나면 시드/기본값으로. */
export function normalizeSessionReclaimPolicy(raw: unknown): SessionReclaimPolicy {
  return policy.normalize(raw);
}

/** DB 원본(JSONB) → 유효 정책. DB 우선, 비면 env 시드, 그 다음 기본값. */
export function resolveSessionReclaimPolicy(dbRaw: unknown): SessionReclaimPolicy {
  return policy.resolve(dbRaw);
}

/** 유효 정책의 출처(관리 UI 안내) — 관리탭 저장값인지, .env 시드인지, 코드 기본값인지. */
export function sessionReclaimPolicySource(dbRaw: unknown): "db" | "env" | "default" {
  return policy.source(dbRaw);
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
