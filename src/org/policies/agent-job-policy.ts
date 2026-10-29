// 작업 컨테이너(에이전트 작업) 정책 — 워크스페이스 동시 상한 · 대기열 · 시간 상한 (#4490 앱 v2-11 · #3994 1단계 공동)
//
// 왜 있나: 작업 1건 = 세션 노드의 gVisor 컨테이너 1개다(사람 세션과 같은 브로커·번들, 예약 메모리도 같은 자를 쓴다).
//  크기를 우리가 못 정하는 일(앱이 시킨 에이전트 작업)이라 워크스페이스마다 동시에 몇 개까지 띄울지 · 몇 건까지 기다리게
//  할지 · 얼마나 돌게 둘지를 정해 두지 않으면 한 워크스페이스가 노드 자리를 다 먹는다(오토스케일엔 대기열 입력이 없다 — #3994 §5-3).
//
// 숫자(상민님 2026-10-16 결정 — 추천안): 동시 2 · 대기 20건 · 대기 30분 넘으면 실패 · 실행 기본 15분 / 최대 60분 ·
//  판이 90초 말이 없으면 끊긴 것. «관리 설정으로 바꿀 수 있게» 가 같은 결정의 조건이다.
// 보존(#4828 · 상민님 2026-10-19 결정 — 추천안): 끝난 작업 기록(지시 · 답 · 진행 꼬리)은 90일 뒤 행째 지운다 · 0 = 무기한.
//  «누가 언제 보냈나» 는 도구 호출 기록(mcp_call_log)에 따로 남고, 앱 AI 실행(#4488)은 결과를 실행 기록에 옮겨 두므로 행째 지운다.
//
// 왜 DB 인가(delegate-policy 와 같은 교리): 배포 없이 바꾼다 — 관리 설정(org_runtime_update)이 단일 창구, env 는 시드.
//  우선순위: **DB > env 시드 > 코드 기본값.**
import { tenantTtlCache } from "../tenant-ttl-cache.js";
import { definePolicy } from "./knob.js";

export interface AgentJobPolicy {
  /** 이 워크스페이스에서 동시에 도는(띄우는 중 포함) 작업 컨테이너 수. 넘는 작업은 대기열에서 기다린다. */
  max_running: number;
  /**
   * 같은 실행 계정(구독 주인 멤버 · API 키면 보낸 사람)으로 동시에 도는 작업 수. 워크스페이스 상한보다 클 수 없다(불변식).
   *  한 사람 구독의 한도(분당 토큰)를 작업 여럿이 한꺼번에 먹지 않게 — 설계 §12 ④ «사람당 동시».
   *  #5081 공용 시트의 작업은 **보낸 사람**으로 센다(시트 전체는 max_running_per_service_seat — agent-jobs/plan.claimAxes).
   */
  max_running_per_member: number;
  /**
   * #5081 공용 시트 하나로 동시에 도는 작업 수 — 공용 시트의 작업은 사람당 상한을 **보낸 사람**으로 세므로(구성원마다 따로), 시트 전체는 이 칸이 막는다.
   *  워크스페이스 상한보다 클 수 없다(불변식). 시트 하나의 구독 한도(5시간 사용량)를 여럿이 한꺼번에 먹지 않게.
   */
  max_running_per_service_seat: number;
  /** 기다리는 작업 수 상한. 넘으면 접수를 거절한다(429). 0 = 대기열 없음(자리가 없으면 바로 거절). */
  max_queued: number;
  /** 이만큼(분) 기다려도 자리가 안 나면 실패로 끝낸다 — 앱이 영원히 «대기 중» 을 보지 않게. */
  queue_wait_min: number;
  /** 요청이 시간을 정하지 않았을 때의 실행 시간 상한(분). */
  default_timeout_min: number;
  /** 요청이 정할 수 있는 실행 시간의 최댓값(분). 더 큰 값을 달라고 하면 이 값으로 접는다. */
  max_timeout_min: number;
  /**
   * 판(컨테이너 안 실행기)이 이만큼(초) 아무 말이 없으면 끊긴 것으로 본다. 판은 몇 초마다 박동한다 —
   *  이 값은 «노드가 사라짐 · 컨테이너가 회수됨» 을 알아채는 시간이다.
   */
  silent_sec: number;
  /** 자리를 받은 뒤 이 안(초)에 판이 첫 말(boot)을 못 하면 실패 — 컨테이너 확보·이미지·하네스 준비가 막힌 것이다. */
  start_timeout_sec: number;
  /**
   * 끝난 작업 기록을 며칠 두나(#4828) — 끝났고 걷은 작업이 끝난 지 이만큼 지나면 정비(job-record-prune)가 행째 지운다.
   *  0 = 무기한(지우지 않는다). 지운 작업은 목록 · 조회 · 이어받기에서 사라진다.
   */
  keep_days: number;
  /**
   * #5101 API 키 작업의 대화 기록(이어받기용 · 게이트웨이가 공용 DB 에 보관)을 며칠 두나 — 끝난 지 이만큼 지나면 정비(job-record-prune)가 기록만 비운다
   *  (행은 keep_days 까지). 기록에는 그 작업 AI 가 읽은 것(보낸 사람의 권한으로 도구 · 파일에서 읽은 글)이 다 들어 있다.
   *  0 = 보관 안 함 — 판이 올리지 않고 남은 기록도 다음 정리에서 비운다(그러면 API 키 작업의 이어받기 · «형식에 맞게 다시» 가 꺼진다).
   *  비운 작업의 대화는 이어받을 수 없다(앱의 이어받기 409). 구독 작업의 대화는 그 사람(시트)의 홈에 남아 이 값과 무관하다 — 단 #5082 도커 실행면은
   *  구독 작업의 기록 자리(projects/)를 작업마다 덮어 대화가 홈에 남지 않으니 API 키 작업과 같이 이 값을 따른다.
   */
  transcript_keep_days: number;
  /**
   * 작업 하나의 메모리 상한(MB) — 브로커 없는 박스(셀프호스트 · 박스 위 실행면 #5082)에서 그 판의 cgroup MemoryMax 로 건다. 0 = 상한 없음.
   *  넘으면 그 판 안에서 하네스가 먼저 끊긴다(박스 전체가 메모리 압박에 들기 전에 — 게이트웨이 · 저장소를 지킨다).
   *  ⚠ 매니지드는 이 값을 쓰지 않는다 — 작업 컨테이너도 사람 세션과 같은 세션 메모리 정책으로 잡힌다(launch.ts · 종전 그대로).
   */
  memory_max_mb: number;
}

export type AgentJobPolicyPatch = Partial<AgentJobPolicy>;

export const DEFAULT_AGENT_JOB_POLICY: AgentJobPolicy = {
  max_running: 2,
  max_running_per_member: 2,
  max_running_per_service_seat: 2,
  max_queued: 20,
  queue_wait_min: 30,
  default_timeout_min: 15,
  max_timeout_min: 60,
  silent_sec: 90,
  start_timeout_sec: 180,
  keep_days: 90,
  //  #5101 — 이어받기는 보통 답을 검사한 직후다(몇 초 ~ 몇 분). 다음 날 이어 묻는 앱을 위해 두 주 둔다(대화 기록은 작업 행보다 커 공용 DB 를 아낀다).
  transcript_keep_days: 14,
  //  상민 2026-10-28 결정(#5082) — 램 16GB 박스 · 동시 2 기준 작업당 약 3GiB, 관리자가 바꾼다.
  memory_max_mb: 3072,
};

// 관리 설정·검증에 쓰는 범위 — capability(zod·patch 블록)와 같은 상수를 쓴다(드리프트 금지).
export const AGENT_JOB_POLICY_RANGE: { readonly [K in keyof AgentJobPolicy]: readonly [min: number, max: number] } = {
  max_running: [1, 20],
  max_running_per_member: [1, 20],
  max_running_per_service_seat: [1, 20],
  max_queued: [0, 500],
  queue_wait_min: [1, 1440],
  default_timeout_min: [1, 240],
  max_timeout_min: [1, 480],
  silent_sec: [30, 900],
  start_timeout_sec: [30, 900],
  keep_days: [0, 3650],
  transcript_keep_days: [0, 3650],
  memory_max_mb: [0, 65536],
};

const R = AGENT_JOB_POLICY_RANGE;
const policy = definePolicy<AgentJobPolicy>({
  defaults: DEFAULT_AGENT_JOB_POLICY,
  fields: {
    max_running: { env: "LIVELY_AGENT_JOB_MAX_RUNNING", min: R.max_running[0], max: R.max_running[1] },
    max_running_per_member: { env: "LIVELY_AGENT_JOB_MAX_RUNNING_PER_MEMBER", min: R.max_running_per_member[0], max: R.max_running_per_member[1] },
    max_running_per_service_seat: { env: "LIVELY_AGENT_JOB_MAX_RUNNING_PER_SERVICE_SEAT", min: R.max_running_per_service_seat[0], max: R.max_running_per_service_seat[1] },
    max_queued: { env: "LIVELY_AGENT_JOB_MAX_QUEUED", min: R.max_queued[0], max: R.max_queued[1] },
    queue_wait_min: { env: "LIVELY_AGENT_JOB_QUEUE_WAIT_MIN", min: R.queue_wait_min[0], max: R.queue_wait_min[1] },
    default_timeout_min: { env: "LIVELY_AGENT_JOB_DEFAULT_TIMEOUT_MIN", min: R.default_timeout_min[0], max: R.default_timeout_min[1] },
    max_timeout_min: { env: "LIVELY_AGENT_JOB_MAX_TIMEOUT_MIN", min: R.max_timeout_min[0], max: R.max_timeout_min[1] },
    silent_sec: { env: "LIVELY_AGENT_JOB_SILENT_SEC", min: R.silent_sec[0], max: R.silent_sec[1] },
    start_timeout_sec: { env: "LIVELY_AGENT_JOB_START_TIMEOUT_SEC", min: R.start_timeout_sec[0], max: R.start_timeout_sec[1] },
    keep_days: { env: "LIVELY_AGENT_JOB_KEEP_DAYS", min: R.keep_days[0], max: R.keep_days[1] },
    transcript_keep_days: { env: "LIVELY_AGENT_JOB_TRANSCRIPT_KEEP_DAYS", min: R.transcript_keep_days[0], max: R.transcript_keep_days[1] },
    memory_max_mb: { env: "LIVELY_AGENT_JOB_MEMORY_MAX_MB", min: R.memory_max_mb[0], max: R.memory_max_mb[1] },
  },
  //  축 사이 관계 셋 — 사람당 · 공용 시트 상한이 워크스페이스 상한보다 크면 의미가 없고, 기본 시간이 최대 시간보다 길면 기본값이 최대를 뚫는다.
  invariant: (o) => {
    if (o.max_running_per_member > o.max_running) o.max_running_per_member = o.max_running;
    if (o.max_running_per_service_seat > o.max_running) o.max_running_per_service_seat = o.max_running;
    if (o.default_timeout_min > o.max_timeout_min) o.default_timeout_min = o.max_timeout_min;
  },
});

/** 잡값 방어 — 관리 설정 입력이든 env 든 범위를 벗어나면 경계로 접고, 숫자가 아니면 시드/기본값으로(노브 clampInt). */
export function normalizeAgentJobPolicy(raw: unknown): AgentJobPolicy {
  return policy.normalize(raw);
}

/** DB 원본(JSONB) → 유효 정책. DB 우선, 비면 env 시드, 그 다음 기본값. */
export function resolveAgentJobPolicy(dbRaw: unknown): AgentJobPolicy {
  return policy.resolve(dbRaw);
}

/**
 * (순수) 관리자가 적으려는 값이 축 사이 관계를 지키나 — 어기면 거절 문장, 지키면 null.
 *  next = 이번에 적을 값(이미 저장된 값 + 이번 입력). 안 적은 칸은 지금 쓰는 값(env 시드 · 기본값)으로 견준다.
 *  ⚠ 조용히 접지 않는다 — 접으면(사람당 5 → 2) 그 값이 저장돼, 나중에 동시 상한을 올려도 되살아나지 않는다(격리 리뷰).
 *   읽을 때의 불변식(invariant)은 env 시드가 바뀌는 경우의 안전망으로 남는다.
 *  공용 시트 상한(#5081)은 **적었을 때만** 견준다 — 이 칸이 생기기 전에 동시 상한을 1 로 적어 둔 워크스페이스가 다른 칸(보존 일수 등)을
 *   고칠 때마다 «기본값 2 > 1» 로 거절되지 않게. 안 적었으면 읽을 때 불변식이 동시 상한으로 접는다(저장하지 않으니 되살아남 문제가 없다).
 */
export function agentJobPolicyPatchError(next: Partial<AgentJobPolicy>): string | null {
  const want = { ...resolveAgentJobPolicy({}), ...next };
  if (want.max_running_per_member > want.max_running) {
    return `max_running_per_member(${want.max_running_per_member})는 max_running(${want.max_running}) 이하여야 합니다 — 둘을 함께 주세요`;
  }
  if (next.max_running_per_service_seat !== undefined && want.max_running_per_service_seat > want.max_running) {
    return `max_running_per_service_seat(${want.max_running_per_service_seat})는 max_running(${want.max_running}) 이하여야 합니다 — 둘을 함께 주세요`;
  }
  if (want.default_timeout_min > want.max_timeout_min) {
    return `default_timeout_min(${want.default_timeout_min})은 max_timeout_min(${want.max_timeout_min}) 이하여야 합니다 — 둘을 함께 주세요`;
  }
  return null;
}

/** 유효 정책의 출처 — 관리 설정 저장값인지, .env 시드인지, 코드 기본값인지. */
export function agentJobPolicySource(dbRaw: unknown): "db" | "env" | "default" {
  return policy.source(dbRaw);
}

// ── 캐시 ──
//  배차·감시가 요청마다 정책을 읽는다 — 짧게 캐시하고 DB 가 실패해도 던지지 않는다(마지막 값 → 기본값).
//  ★ 테넌트별 캐시다(org/tenant-ttl-cache.ts 머리말 — 전역 한 칸이면 먼저 읽은 워크스페이스의 값이 남에게 샌다).
const cache = tenantTtlCache<AgentJobPolicy>(30_000, () => normalizeAgentJobPolicy(null));

export async function effectiveAgentJobPolicy(load: () => Promise<AgentJobPolicy>, ttlMs = 30_000, now: () => number = Date.now): Promise<AgentJobPolicy> {
  return cache.get(load, ttlMs, now);
}

/** 관리 설정을 저장한 직후 — 다음 배차가 곧바로 새 값을 보게. */
export function invalidateAgentJobPolicyCache(): void {
  cache.invalidate();
}
