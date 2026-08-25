// 조직 단위 worker 예산 정책(#1780 Stage B). 설계 §10 "CPU·wall time·동시 worker 수는 조직 정책 상한과 작은 쪽".
//
// ⚠ 이 파일은 **정책 값과 판정만** 갖는다(순수). 실제 집행은 두 곳으로 갈린다.
//   · 시작 관문(수·메모리 합) — worker-service.startWorkerForInstanceCore 가 prepare 직전에 fail-closed 로 막는다.
//   · 실행 중 감시(CPU·수명) — worker-host 가 표본을 떠서 초과하면 그 run 만 종료한다.
//
// 기본값의 원칙: **지금까지 무제한이었으므로 기본이 실사용을 막으면 그 자체가 회귀다.**
//  수·메모리는 폭주만 잡을 만큼 넉넉한 상한을 두고(있는 것이 없는 것보다 안전), CPU·수명은 기본 0(끔)으로 둔다.
//  정상 worker도 순간 100%를 쓸 수 있어, 켜지 않은 조직에서 우리가 멀쩡한 앱을 죽이는 일이 없어야 한다.

export interface WorkerPolicy {
  max_concurrent: number;   // 조직 전체 동시 활성 worker 수. 0 = 무제한
  max_per_member: number;   // 멤버 1인당 동시 활성 worker 수. 0 = 무제한
  max_memory_mb: number;    // 조직 전체 동시 worker 선언 메모리 합(MiB). 0 = 무제한
  cpu_percent_max: number;  // worker 1개의 CPU 사용률 상한(%, 코어 1개 = 100). 0 = 감시 끔
  max_wall_sec: number;     // worker 1개의 최대 수명(초). 0 = 무제한
}

export type WorkerPolicyPatch = Partial<WorkerPolicy>;

export const WORKER_POLICY_DEFAULT: WorkerPolicy = {
  max_concurrent: 32,
  max_per_member: 8,
  max_memory_mb: 4096,
  cpu_percent_max: 0,
  max_wall_sec: 0,
};

/** 항목별 상한 — 오타 하나가 사실상 무제한이 되지 않게 접는 지점.
 *  ⚠ 이 값은 **표면 검증(capabilities/delivery/runtime-config)과 공유**한다. 두 곳에 숫자를 따로 적으면
 *   한쪽만 바뀌어 "400 은 안 나는데 조용히 접히는" 구간이 생긴다. 반드시 여기서 import 해 쓸 것. */
export const WORKER_POLICY_MAX = { max_concurrent: 4096, max_per_member: 4096, max_memory_mb: 1_048_576, cpu_percent_max: 6400, max_wall_sec: 2_592_000 } as const;
const MAX = WORKER_POLICY_MAX;

/** 음수·소수·NaN·범위초과를 기본값 쪽으로 접는다(관리 입력은 신뢰하지 않는다). */
function clamp(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function normalizeWorkerPolicy(patch: unknown): WorkerPolicy {
  const p = (patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}) as Record<string, unknown>;
  return {
    max_concurrent: clamp(p.max_concurrent, WORKER_POLICY_DEFAULT.max_concurrent, MAX.max_concurrent),
    max_per_member: clamp(p.max_per_member, WORKER_POLICY_DEFAULT.max_per_member, MAX.max_per_member),
    max_memory_mb: clamp(p.max_memory_mb, WORKER_POLICY_DEFAULT.max_memory_mb, MAX.max_memory_mb),
    cpu_percent_max: clamp(p.cpu_percent_max, WORKER_POLICY_DEFAULT.cpu_percent_max, MAX.cpu_percent_max),
    max_wall_sec: clamp(p.max_wall_sec, WORKER_POLICY_DEFAULT.max_wall_sec, MAX.max_wall_sec),
  };
}

/** DB 행에 값이 없으면 기본값. env 시드는 두지 않는다(이 정책은 관리 화면·API 로만 바뀐다). */
export function resolveWorkerPolicy(row: unknown): WorkerPolicy {
  return row == null ? { ...WORKER_POLICY_DEFAULT } : normalizeWorkerPolicy(row);
}

export interface WorkerBudgetUsage {
  activeTotal: number;      // 지금 살아 있는 조직 전체 worker run 수(요청자 자신 제외)
  activeForMember: number;  // 그중 이 멤버 소유(요청자 자신 제외)
  memoryMbTotal: number;    // 그 run 들이 선언한 memory_mb 합(요청자 자신 제외)
}

export type WorkerBudgetDenial = "worker-budget-org-concurrency" | "worker-budget-member-concurrency" | "worker-budget-org-memory";

/**
 * 새 worker 하나를 더 띄워도 되는가. 허용이면 null, 아니면 거부 사유.
 *
 * ⚠ usage 는 **이 인스턴스의 기존 run 을 뺀** 값이어야 한다 — 재시작·복구 경로에서 자기 자신을 세면
 *  상한에 걸려 되살아나지 못한다(정책이 복구를 막는 자충수).
 */
export function decideWorkerBudget(policy: WorkerPolicy, usage: WorkerBudgetUsage, requestMemoryMb: number): WorkerBudgetDenial | null {
  if (policy.max_concurrent > 0 && usage.activeTotal + 1 > policy.max_concurrent) return "worker-budget-org-concurrency";
  if (policy.max_per_member > 0 && usage.activeForMember + 1 > policy.max_per_member) return "worker-budget-member-concurrency";
  if (policy.max_memory_mb > 0 && usage.memoryMbTotal + Math.max(0, requestMemoryMb) > policy.max_memory_mb) return "worker-budget-org-memory";
  return null;
}

/**
 * CPU 표본 두 점으로 사용률(%)을 낸다. 순간값(ps %cpu)은 프로세스 수명 평균이라 폭주를 늦게 잡으므로,
 *  누적 CPU 시간의 증분을 실제 경과로 나눈다. 경과가 0 이하면 판정하지 않는다(null).
 */
export function cpuPercentBetween(prev: { cpuSec: number; atMs: number }, next: { cpuSec: number; atMs: number }): number | null {
  const elapsedMs = next.atMs - prev.atMs;
  if (elapsedMs <= 0) return null;
  const usedSec = next.cpuSec - prev.cpuSec;
  if (usedSec < 0) return null; // 표본 유실·pid 재사용
  return (usedSec * 1000 / elapsedMs) * 100;
}

// `ps -o time=` 의 [[dd-]hh:]mm:ss. 자릿수까지 정규식으로 못박는다.
//  ⚠ split + Number 로 느슨하게 읽으면 `Number("") === 0` 때문에 "-1:00"(빈 일 부분)이 60초로 읽힌다.
//   음수 표기를 양수로 받아들이는 파서는 감시를 끄는 게 아니라 **틀린 값으로 감시**하게 만든다.
const PS_TIME_RE = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/;

/** `ps -o time=` 의 [[dd-]hh:]mm:ss 를 초로. 형식이 아니면 null(감시를 끄되 worker 는 살린다). */
export function parsePsCpuSeconds(raw: string): number | null {
  const m = PS_TIME_RE.exec(raw.trim());
  if (!m) return null;
  const [days, hours, minutes, seconds] = [m[1] ?? "0", m[2] ?? "0", m[3], m[4]].map(Number);
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}
