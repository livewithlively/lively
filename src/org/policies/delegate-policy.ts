// 위탁(delegate) 태스크 정책 — 무출력 stall 상한. **관리탭(DB)이 단일 창구, env 는 시드.**
//
// 왜 필요(#1101): 위탁 워커가 자격 부재로 auth/init 에서 막히면 `claude -p` 는 fast-fail 이 아니라 hang 한다.
//  liveness 가드가 "시작 후 N 동안 stream.jsonl 이 0바이트면 끊는다"로 이걸 잡는데, 그 N 이 코드 상수였다.
//
// 왜 DB 인가(storage-policy·session-reclaim-policy 와 동일 교리): 고객 박스는 우리가 SSH 로 못 들어간다 →
//  env 전용이면 사실상 아무도 못 바꾼다. 정작 이 노브가 필요한 곳이 그 박스다(레포 준비가 느린 박스는 늘려야 하고,
//  분류 드레인처럼 배치가 많은 운영은 줄여서 빨리 실패를 보고 싶다). 우선순위: **DB(관리탭) > env 시드 > 코드 기본값.**
//  ⚠ '이 항목을 안 건드린 저장'은 DB 원본을 그대로 둔다 — resolved 값을 되쓰면 env 시드가 DB 로 굳는다(#688 함정).
//
// 관련: src/node/task-scheduler.ts(이 정책으로 stall 판정) · src/sessions/session-reclaim-policy.ts(같은 seam 원형).

import { definePolicy } from "./knob.js";

export interface DelegatePolicy {
  /**
   * 위탁 태스크 시작 후 워커가 **한 바이트도** 내지 않은 채 이 ms 를 넘기면 조기 종결. 0 = 가드 끔.
   *
   * 기본 300000(5분): `claude -p --output-format stream-json` 은 정상이면 init 이벤트를 즉시 뱉으므로
   *  5분 무출력은 사실상 '막혔다'는 뜻이다. 가드가 없으면 timeout_sec(기본 1h)까지 매달렸다가
   *  error=null 로 죽어 단서가 남지 않는다(#1101 고객사 A 실측: 32분 무진척).
   */
  stall_ms: number;
  /**
   * **실패로 종결된 위탁의 tmux 세션을 몇 건까지 남길지**(#1675 ①). 0 = 즉시 전량 회수.
   *
   * 왜 남기나: 실패 세션은 사후 검시용이다 — 워커 세션이 셸로 남아 있어 웹터미널로 열어 그 자리에서
   *  재현·탐색할 수 있다(`tasks.ts` 의 `exec $SHELL` 이 그 목적). 이건 의도된 설계였고 실제로 쓰인다.
   *
   * 왜 상한이 필요한가(어니스트 2026-08-12): 그 보존에 **상한이 없었다.** 토큰이 폐기되자 위탁이 10분마다
   *  9건씩 전량 실패했고, 실패 세션이 24시간 동안 2,300여 개 쌓였다. 세션 1건당 프로세스 3개(sudo 2 + bash 1)
   *  라 프로세스 4,771개·메모리 요구 21GB(물리 15.7GB)가 되어 스왑 8GB 를 완전히 고갈시켰고, Postgres 응답이
   *  3초를 넘겨 박스 전체가 무너졌다. **검시는 최근 몇 건이면 충분하다** — 같은 실패 2,300건을 다 열어보는
   *  사람은 없고, 원문(stream.jsonl·stderr.log)은 세션과 무관하게 taskDir 에 그대로 남는다.
   *
   * 기본 5: 한 배치(증류 9레인)의 절반 정도 — 무엇이 실패했는지 보기엔 충분하고, 쌓여도 프로세스 15개다.
   */
  keep_failed_sessions: number;
  /**
   * 남겨둔 실패 세션도 **이 분(minute)을 넘기면 회수**(#1675 ①). 0 = 무기한(개수 상한만 적용).
   *
   * 개수 상한만으로는 '실패가 드문드문 나는 박스'에서 오래된 세션이 영원히 남는다 — 검시는 사고 직후에
   *  하지, 이틀 뒤에 하지 않는다. 기본 120(2시간).
   */
  failed_session_ttl_min: number;
  /**
   * 자격(인증) 실패를 감지하면 **그 위탁을 낸 크론을 자동으로 정지**할지(#1675 ③). 기본 켬.
   *
   * 끄면 알림만 가고 크론은 계속 돈다(= 어니스트 당시 동작). 오탐이 걱정되는 운영에서 끌 수 있게 두되,
   *  기본은 켬이다 — 이번 사고의 24시간은 "아무도 안 멈췄다"가 만든 시간이다.
   */
  auth_fail_stop_cron: boolean;
}

export type DelegatePolicyPatch = Partial<DelegatePolicy>;

export const DEFAULT_DELEGATE_POLICY: DelegatePolicy = {
  stall_ms: 300_000,
  keep_failed_sessions: 5,
  failed_session_ttl_min: 120,
  auth_fail_stop_cron: true,
};

// 관리탭·검증 노출 상수.
export const STALL_MS_MIN = 0;              // 0 = 끔
export const STALL_MS_MAX = 3_600_000;      // 1시간 — 그 이상은 timeout_sec 기본(1h)에 먹혀 사실상 '안 켠 것'
/**
 * **켰다면 최소 1분.** 0 초과인데 이보다 짧으면 이 값으로 올린다.
 *
 * 왜 하한이 필요한가: 이 노브를 너무 짧게 잡으면 가드가 **멀쩡한 작업을 죽인다**(워커 기동·레포 준비가
 *  몇십 초 걸리는 박스가 있다). 관리탭은 셀렉트라 애초에 못 고르지만, REST/MCP 로는 임의 정수가 들어온다 —
 *  정책이 사고를 내지 못하게 여기서 막는다. 끄고 싶으면 0(명시적)이지, '30초'가 아니다.
 */
export const STALL_MS_FLOOR = 60_000;

// #1675 ① — 실패 세션 보존 상한. 0(즉시 전량 회수) ~ 200.
//  상한 200 은 '사실상 안 건 것'을 막는 선이다: 세션 1건 = 프로세스 3개 + claude 프로세스 메모리이므로
//  200 이면 이미 어니스트 사고의 1/10 규모다. 검시가 그만큼 필요한 운영은 없다.
export const KEEP_FAILED_MIN = 0;
export const KEEP_FAILED_MAX = 200;
// 남긴 실패 세션의 TTL(분). 0 = 무기한(개수 상한만) ~ 7일.
export const FAILED_TTL_MIN_MIN = 0;
export const FAILED_TTL_MIN_MAX = 10_080;

// 노브 선언(#1313 R47) — 범위·하한·env 시드는 이 표가 전부. 클램프/시드/우선순위 골격은 knob.ts 가 맡는다.
//  floor 는 knob.ts 의 '켰다면 최소 이만큼' 규칙: MIN 이하면 끔(MIN), 그 위면 [FLOOR, MAX] 로 접는다.
//  env 이름은 liveness 가드 최초 릴리스(v0.1.272)의 것을 그대로 승계한다.
//  loose: R47 이전 이 모듈의 숫자 해석(Number(v) 직행)을 그대로 보존(byte-compat). 새 정책은 쓰지 마라 — knob.ts 참조.
const policy = definePolicy<DelegatePolicy>({
  defaults: DEFAULT_DELEGATE_POLICY,
  fields: {
    stall_ms: { env: "LIVELY_TASK_STALL_MS", min: STALL_MS_MIN, max: STALL_MS_MAX, floor: STALL_MS_FLOOR, loose: true },
    // #1675 ① — 신규 노브라 loose 를 쓰지 않는다(knob.ts 의 방어적 숫자 해석 = 정본). null/""/false 가 0 으로
    //  뒤집히면 안 되는 자리다: 여기서 0 은 '즉시 전량 회수'라는 **의미 있는 선택**이지 잡값의 착지점이 아니다.
    keep_failed_sessions: { env: "LIVELY_KEEP_FAILED_SESSIONS", min: KEEP_FAILED_MIN, max: KEEP_FAILED_MAX },
    failed_session_ttl_min: { env: "LIVELY_FAILED_SESSION_TTL_MIN", min: FAILED_TTL_MIN_MIN, max: FAILED_TTL_MIN_MAX },
    auth_fail_stop_cron: { kind: "bool", env: "LIVELY_AUTH_FAIL_STOP_CRON" },
  },
});

/** 잡값 방어 — 관리탭 입력이든 env 든 범위를 벗어나면 시드/기본값으로. */
export function normalizeDelegatePolicy(raw: unknown): DelegatePolicy {
  return policy.normalize(raw);
}

/** DB 원본(JSONB) → 유효 정책. DB 우선, 비면 env 시드, 그 다음 기본값. */
export function resolveDelegatePolicy(dbRaw: unknown): DelegatePolicy {
  return policy.resolve(dbRaw);
}

/** 유효 정책의 출처(관리 UI 안내) — 관리탭 저장값인지, .env 시드인지, 코드 기본값인지. */
export function delegatePolicySource(dbRaw: unknown): "db" | "env" | "default" {
  return policy.source(dbRaw);
}

// ── 캐시 ──
// 스케줄러는 5초마다 도는 루프라 매 tick DB 를 치면 안 된다. 짧은 캐시 + DB 실패 시 폴백
//  (stall 판정이 정책 조회로 막히지 않게 — 못 읽으면 마지막 값→기본값으로, 절대 throw 하지 않는다).
let cache: { at: number; policy: DelegatePolicy } | null = null;

export async function effectiveDelegatePolicy(
  load: () => Promise<DelegatePolicy>,
  ttlMs = 30_000,
  now: () => number = Date.now,
): Promise<DelegatePolicy> {
  if (cache && now() - cache.at < ttlMs) return cache.policy;
  try {
    const policy = await load();
    cache = { at: now(), policy };
    return policy;
  } catch {
    return cache?.policy ?? normalizeDelegatePolicy(null);
  }
}

/** 관리탭에서 정책을 저장한 직후 호출 — 다음 스케줄러 tick 이 즉시 새 값을 보게. */
export function invalidateDelegatePolicyCache(): void {
  cache = null;
}
