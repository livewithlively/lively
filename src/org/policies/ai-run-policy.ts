// 앱 AI 실행(/_lively/ai/runs) 상한 — 사람당 동시 · 앱당 빈도 · 워크스페이스 동시 · 단발 시간 · 출력 토큰 · 앱당 하루 토큰 (#4488 앱 v2-9)
//
// 왜 있나(설계 §12 ④ «제한: 사람당 동시(약관·한도) · 앱당 빈도(남용) · 워크스페이스당 동시(비용·노드) — 숫자를 v2-9 에서 정한다»):
//  앱 코드는 구성원 누구나 고친다(app_save). 앱이 돌면서 LLM 을 끝없이 부르면 워크스페이스 API 키의 돈이 새고, 구독이면 그 사람의 한도가 다른 일에
//  남지 않는다. 숫자(이 태스크가 정한 시작값): 사람당 동시 2 · 앱당 분당 30 · 워크스페이스 단발 동시 4 · 단발 120초 · 출력 8,192 토큰 ·
//  앱당 하루 500만 토큰(0 = 끔). 에이전트 작업(작업 컨테이너)의 동시·대기열은 agent-job-policy 가 따로 센다.
//  #5101 한 질문당 이어받기 3번(0 = 끔) — 앱 서버가 답을 검사하고 되돌리는 횟수의 끝.
//
// 왜 DB 인가(agent-job-policy 와 같은 교리): 배포 없이 바꾼다 — 관리 도구(app_ai_limits_set)가 단일 창구, env 는 시드. DB > env 시드 > 코드 기본값.
import { tenantTtlCache } from "../tenant-ttl-cache.js";
import { definePolicy } from "./knob.js";

export interface AiRunPolicy {
  /** 같은 사람(요청자)이 동시에 돌리는 실행 수 — 단발·에이전트를 합쳐 센다(열린 실행 행). */
  max_running_per_member: number;
  /** 한 앱이 1분에 보낼 수 있는 실행 요청 수(워크스페이스 전체 · 사람 무관) — 앱 코드가 돌면서 LLM 을 메우지 못하게. */
  app_per_minute: number;
  /** 이 워크스페이스에서 동시에 열어 두는 LLM 프록시 호출 수(단발 실행 + 고급 길 SDK 호출). 넘으면 429. */
  max_inflight: number;
  /** 단발(프록시) 실행 하나의 시간 상한(초). 넘으면 끊고 실패. */
  single_timeout_sec: number;
  /** 단발 실행의 출력 토큰 상한(max_tokens). 앱이 더 달라고 해도 이 값으로 접는다. */
  max_output_tokens: number;
  /** 한 앱이 하루(UTC)에 쓸 수 있는 토큰(입력+출력 · 프록시 경로만 센다). 0 = 끔. */
  daily_tokens_per_app: number;
  /**
   * #5101 한 질문(처음 실행)을 이어받을 수 있는 횟수 — 앱 서버가 답을 검사하고 사유를 붙여 다시 시키는 것(resume_run_id)의 게이트웨이 상한.
   *  몇 번 다시 시킬지는 앱이 정하고, 이 값이 끝을 막는다(검사가 늘 실패하는 앱이 끝없이 돌지 않게). 0 = 이어받기 끔.
   */
  max_resumes: number;
}

export const DEFAULT_AI_RUN_POLICY: AiRunPolicy = {
  max_running_per_member: 2,
  app_per_minute: 30,
  max_inflight: 4,
  single_timeout_sec: 120,
  max_output_tokens: 8_192,
  daily_tokens_per_app: 5_000_000,
  max_resumes: 3,
};

export const AI_RUN_POLICY_RANGE: { readonly [K in keyof AiRunPolicy]: readonly [min: number, max: number] } = {
  max_running_per_member: [1, 20],
  app_per_minute: [1, 600],
  max_inflight: [1, 50],
  single_timeout_sec: [10, 600],
  max_output_tokens: [256, 64_000],
  daily_tokens_per_app: [0, 1_000_000_000],
  max_resumes: [0, 20],
};

const R = AI_RUN_POLICY_RANGE;
const policy = definePolicy<AiRunPolicy>({
  defaults: DEFAULT_AI_RUN_POLICY,
  fields: {
    max_running_per_member: { env: "LIVELY_AI_RUN_MAX_RUNNING_PER_MEMBER", min: R.max_running_per_member[0], max: R.max_running_per_member[1] },
    app_per_minute: { env: "LIVELY_AI_RUN_APP_PER_MINUTE", min: R.app_per_minute[0], max: R.app_per_minute[1] },
    max_inflight: { env: "LIVELY_AI_RUN_MAX_INFLIGHT", min: R.max_inflight[0], max: R.max_inflight[1] },
    single_timeout_sec: { env: "LIVELY_AI_RUN_SINGLE_TIMEOUT_SEC", min: R.single_timeout_sec[0], max: R.single_timeout_sec[1] },
    max_output_tokens: { env: "LIVELY_AI_RUN_MAX_OUTPUT_TOKENS", min: R.max_output_tokens[0], max: R.max_output_tokens[1] },
    daily_tokens_per_app: { env: "LIVELY_AI_RUN_DAILY_TOKENS_PER_APP", min: R.daily_tokens_per_app[0], max: R.daily_tokens_per_app[1] },
    max_resumes: { env: "LIVELY_AI_RUN_MAX_RESUMES", min: R.max_resumes[0], max: R.max_resumes[1] },
  },
});

export function normalizeAiRunPolicy(raw: unknown): AiRunPolicy { return policy.normalize(raw); }
export function resolveAiRunPolicy(dbRaw: unknown): AiRunPolicy { return policy.resolve(dbRaw); }
export function aiRunPolicySource(dbRaw: unknown): "db" | "env" | "default" { return policy.source(dbRaw); }

//  테넌트별 캐시(agent-job-policy 와 같은 자리) — 요청마다 DB 를 읽지 않고, DB 가 잠깐 막혀도 마지막 값으로 버틴다.
const cache = tenantTtlCache<AiRunPolicy>(30_000, () => normalizeAiRunPolicy(null));
export async function effectiveAiRunPolicy(load: () => Promise<AiRunPolicy>, ttlMs = 30_000, now: () => number = Date.now): Promise<AiRunPolicy> {
  return cache.get(load, ttlMs, now);
}
export function invalidateAiRunPolicyCache(): void { cache.invalidate(); }
