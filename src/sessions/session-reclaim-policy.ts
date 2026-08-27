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

import { tenantTtlCache } from "../org/tenant-ttl-cache.js";
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
  /**
   * #1675 ⑤ **스왑 압박 회수** — 스왑 **사용률(%)** 이 이 값 이상이면 압박으로 본다. 0 = 끔(기본).
   *
   * 왜 축이 하나 더 필요한가(어니스트 2026-08-12 실측): 그 박스는 `pressure_used_pct=95` 로 켜져 있었는데
   *  **한 번도 발동하지 못했다.** 사고 당시 물리 메모리는 13.0/15.8GB(≈82%)로 임계에 한참 못 미쳤지만
   *  **스왑은 8,185/8,191MB — 99.9%로 사실상 고갈**이었다. 그 상태에서 전 시스템이 스와핑에 묶여
   *  Postgres 응답이 3초를 넘겼고 "DB 연결 불가"가 떴다. 즉 **이 박스가 벼랑에 있다는 사실은 물리 메모리
   *  지표에 나타나지 않았다** — 스왑에만 나타났다.
   *
   *  같은 통찰이 host-mem.ts 의 `parseProcMeminfoSwap` 주석에 이미 적혀 있었다("MemAvailable 이 넉넉해도
   *  스왑이 바닥이면 그 박스는 이미 벼랑이다"). 지표는 있었는데 **회수 판정이 그걸 안 봤다.**
   *
   * earlyoom 과의 경합에도 이쪽이 유리하다: earlyoom 은 통상 물리 가용률로 발동하므로, 스왑 축은 그와
   *  겹치지 않는 더 이른 신호다. 물리 축만으로 earlyoom 을 앞지르려면 임계를 계속 낮춰야 하는데
   *  그건 평시 오발동을 부른다.
   *
   * 스왑이 없는 박스(SwapTotal=0)·못 재는 플랫폼에서는 이 축이 자동으로 비활성이다.
   */
  pressure_swap_pct: number;
  /**
   * #2148 **attach 전용 TTL(분)** — 탭이 붙어 있어도(attached>0) 이 시간 넘게 입출력이 없으면 회수한다.
   *  0 = 종전 동작(attach 를 무기한 존중 = 회수 안전 불변식 ②).
   *
   * 왜 필요(2026-08-27 app.lvly.io 실측): attach 는 '지금 보는 중'을 뜻하지만 **그 신호가 거짓일 수 있다.**
   *  원격 tmux(매니지드)에서 attach 는 컨테이너 안 `docker exec` 으로 뜨는데, 웹 탭이 재연결할 때마다
   *  옛 클라이언트가 안 끊겨 세션 하나에 6~7개가 쌓였다. `session_attached` 가 영구히 >0 이 되어
   *  **유휴 6~8시간 세션이 어느 회수 경로로도 안 걷혔다.** 근본 수정은 그 유령을 끊는 것이고
   *  (terminal-pty detachGhostClients), 이 값은 **그게 또 새더라도 회수가 멈추지 않게 하는 안전망**이다.
   *
   * 같은 교리가 테넌트 축에는 이미 있다(#1445 `attach_idle_ttl_min` — "탭 방치가 곧 상시 가동이면 안 된다").
   *  세션 축만 예외로 남아 있었다.
   *
   * ⚠ idle_ttl_minutes 보다 **길게** 잡아라 — attach 는 그래도 사람이 붙어 있었다는 신호다.
   *  값이 그보다 짧으면 attach 가 오히려 빨리 걷히는 역전이 생긴다.
   */
  attach_idle_minutes: number;
}

export type SessionReclaimPolicyPatch = Partial<SessionReclaimPolicy>;

// 기본값 — 0 = 끔(무회귀). 운영자가 관리탭/env 로 박스 상황에 맞춰 켠다.
export const DEFAULT_SESSION_RECLAIM_POLICY: SessionReclaimPolicy = {
  idle_ttl_minutes: 0,
  pressure_used_pct: 0,      // 0 = 압박 회수 끔(무회귀)
  pressure_idle_minutes: 60, // 켰을 때의 기본 하한 — '한 시간 넘게 손 안 댄 세션'
  pressure_swap_pct: 0,      // #1675 ⑤ — 0 = 끔(무회귀). 켜는 값은 90 안팎을 권한다(그 아래는 평시에도 닿는 박스가 있다)
  attach_idle_minutes: 0,    // #2148 — 0 = 끔(무회귀). 셀프호스트 동작은 종전 그대로다.
};

// 관리탭·검증 노출 상수 — 0(끔) ~ 43200분(30일; 그 이상은 사실상 안 켠 것).
export const RECLAIM_TTL_MIN_MIN = 0;
export const RECLAIM_TTL_MIN_MAX = 43_200;
/**
 * #1675 ⑤ — **earlyoom 발동선**(사용률 %). `deploy/lib/common.sh` 의 `EARLYOOM_ARGS="-m 6 …"` 와 짝이다:
 *  earlyoom 은 `MemAvailable ≤ 6%` 에서 발동하므로 사용률로는 **94%** 다.
 *  (짝이 어긋나지 않게 `session-reclaim-earlyoom.test.ts` 가 두 파일의 값을 함께 못박는다.)
 */
export const EARLYOOM_TRIGGER_USED_PCT = 94;

// 압박 임계(%) — 0(끔) ~ 90.
//
// ⚠ 상한이 99 가 아니라 **90** 인 이유(어니스트 2026-08-12): 그 박스는 `pressure_used_pct=95` 로 켜져 있었는데
//  **한 번도 발동하지 못했다.** earlyoom 이 94% 에서 먼저 프로세스를 죽여버리기 때문이다 — 95 는 94 보다
//  늦으므로 그 설정은 처음부터 무의미했다. 슬랙 알림은 "메모리 압박 회수를 켜면 이 지경에 이르기 전에
//  게이트웨이가 먼저 정리합니다"라고 안내하는데 **그 약속이 지켜질 수 없는 값을 고를 수 있었다.**
//  그래서 '고를 수 없게' 만든다 — 관리탭이든 REST 든 94 이상은 들어올 수 없다.
//
// 왜 하필 90(= earlyoom −4%p)인가: 회수 tick 이 **5분 주기**(boot/housekeeping)라, 임계를 넘은 뒤 우리가
//  손을 쓰기까지 최대 5분이 뜬다. 그 사이 4%p(16GB 박스 기준 640MB)를 더 먹으면 earlyoom 이 이긴다.
//  만성 누적(이 기능이 겨냥하는 것)은 그 속도가 아니고, 그보다 빠른 급성 스파이크는 애초에 earlyoom 몫이다.
//  더 앞서고 싶으면 85 안팎으로 **낮추면** 된다 — 이 상한은 '늦게 잡는 것'만 막는다.
export const RECLAIM_PRESSURE_PCT_MIN = 0;
export const RECLAIM_PRESSURE_PCT_MAX = EARLYOOM_TRIGGER_USED_PCT - 4;

/**
 * 스왑 축 임계 상한(%) — 물리 축과 달리 **99 까지 허용한다.**
 *
 * 왜 여기엔 earlyoom 여유가 필요 없나: 우리 earlyoom 은 `-s 100,100` 으로 깔린다(= **스왑 조건을 끈다**).
 *  earlyoom 의 발동식은 `MemAvailable% ≤ -m` **AND** `SwapFree% ≤ -s` 인데, `-s 100` 이면 그 항이 항상 참이라
 *  실질 발동축은 물리 메모리 하나뿐이다(#1220 이 `-s 6` → `-s 100,100` 으로 바꾼 이유가 그것이다:
 *  스왑 8G 를 깐 뒤로 스왑이 다 찰 때까지 방어가 잠들어 있었다).
 *
 * → **스왑 축은 earlyoom 과 아예 경합하지 않는다.** 어니스트 사고 시점의 값(물리 82% / 스왑 99.9%)이 정확히
 *  그 사각지대였다: 물리 축으로는 어떤 임계를 골라도 안 걸렸고, earlyoom 도 스왑을 안 봤다. 이 축만이 그 상태를
 *  '벼랑'으로 읽는다. 그래서 늦게 잡을 걱정 없이 원하는 값을 그대로 쓸 수 있다(권장 90 안팎).
 */
export const RECLAIM_SWAP_PCT_MAX = 99;

// 노브 선언(#1313 R47) — 범위·env 시드는 이 표가 전부. 클램프/시드/우선순위 골격은 knob.ts 가 맡는다.
//  loose: R47 이전 이 모듈의 숫자 해석(Number(v) 직행)을 그대로 보존(byte-compat). 새 정책은 쓰지 마라 — knob.ts 참조.
const policy = definePolicy<SessionReclaimPolicy>({
  defaults: DEFAULT_SESSION_RECLAIM_POLICY,
  fields: {
    idle_ttl_minutes: { env: "LIVELY_SESSION_IDLE_TTL_MIN", min: RECLAIM_TTL_MIN_MIN, max: RECLAIM_TTL_MIN_MAX, loose: true },
    pressure_used_pct: { env: "LIVELY_SESSION_PRESSURE_PCT", min: RECLAIM_PRESSURE_PCT_MIN, max: RECLAIM_PRESSURE_PCT_MAX, loose: true },
    pressure_idle_minutes: { env: "LIVELY_SESSION_PRESSURE_IDLE_MIN", min: RECLAIM_TTL_MIN_MIN, max: RECLAIM_TTL_MIN_MAX, loose: true },
    // #1675 ⑤ — 신규 노브라 loose 를 쓰지 않는다(knob.ts 의 방어적 해석이 정본). 0 은 '끔'이라는 의미 있는 선택이라
    //  null/"" 이 0 으로 뒤집히면 안 된다.
    pressure_swap_pct: { env: "LIVELY_SESSION_PRESSURE_SWAP_PCT", min: RECLAIM_PRESSURE_PCT_MIN, max: RECLAIM_SWAP_PCT_MAX },
    // #2148 — 신규 노브라 loose 를 쓰지 않는다(0='끔'이 의미 있는 선택이므로 null/"" 이 0 으로 뒤집히면 안 된다).
    attach_idle_minutes: { env: "LIVELY_SESSION_ATTACH_IDLE_MIN", min: RECLAIM_TTL_MIN_MIN, max: RECLAIM_TTL_MIN_MAX },
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
// ★ **테넌트별** 캐시다 — 전역 한 칸이면 중앙 게이트웨이에서 먼저 읽은 테넌트의 값이 TTL 동안
//  다른 테넌트에도 적용된다(실측 2026-08-27: 갓 만든 테넌트의 기본값 0/0 이 정상 테넌트 1536 을 덮어
//  세션 컨테이너 격리가 조용히 꺼졌다). 근거·전말은 org/tenant-ttl-cache.ts 머리말이 정본이다.
const cache = tenantTtlCache<SessionReclaimPolicy>(30_000, () => normalizeSessionReclaimPolicy(null));

export async function effectiveSessionReclaimPolicy(
  load: () => Promise<SessionReclaimPolicy>,
  ttlMs = 30_000,
  now: () => number = Date.now,
): Promise<SessionReclaimPolicy> {
  // ttlMs·now 는 종전 시그니처 그대로 **캐시에 넘긴다** — 새 캐시를 만들면 그게 곧 캐시를 없앤 것이다.
  return cache.get(load, ttlMs, now);
}

/** 관리탭에서 정책을 저장한 직후 호출 — 다음 회수 tick 이 즉시 새 값을 보게. */
export function invalidateSessionReclaimPolicyCache(): void {
  cache.invalidate();
}
