// 앱 서버 상한(#4484 앱 v2-5) — 함수 사양 · 빌드 시간·메모리 · 자동 멈춤 기준. 값과 판정만(순수).
//
//  결정(상민 2026-10-15): 함수 기본 512MB · 30초(앱 주소 앞단이 30초에 끊는다) · 자동 멈춤 = 앱별 5분 호출 3만 회 또는 실행 시간 합 3,000초
//   (평균 동시 10개를 5분 내내) → 그 함수 동시 실행 0 + 책임자·관리자 알림, 관리자가 다시 켠다. 상한은 배포 없이 고친다.
//  읽는 순서(앱 판 묶음 상한 #4481 과 같다): org_runtime_config.app_server_policy(관리자 app_server_limits_set) → env LIVELY_APP_SERVER_POLICY → 코드 기본값.
//  빌드 메모리 바닥: 운영 세션은 상한(2,560MB)에 닿는 순간 세션이 통째로 죽는다(지식 session-swap-memory-high-node-test-3825).
//   세션 안에서 보이는 «남은 메모리»(/proc/meminfo)에는 gVisor 자체 몫(약 200~330MB)이 안 보이므로 바닥은 그 몫 + 여유로 잡는다.

export interface AppServerPolicy {
  memory_mb: number;            // 함수 메모리(MB) — CPU 도 이에 비례한다
  timeout_s: number;            // 요청 하나의 시간(초)
  build_timeout_s: number;      // 빌드 전체 시간(초)
  build_mem_floor_mb: number;   // 세션 안 남은 메모리가 이 밑이면 빌드를 멈춘다(MB)
  build_heap_mb: number;        // 빌드 자식 node 힙 상한(MB) — 0 이면 걸지 않는다
  stop_invocations_5m: number;  // 5분 호출 수가 이걸 넘으면 멈춘다
  stop_duration_s_5m: number;   // 5분 실행 시간 합(초)이 이걸 넘으면 멈춘다
  log_retention_days: number;   // 함수 로그 보관(일) — CloudWatch 가 받는 값으로 내린다
  keep_versions: number;        // 별칭이 가리키지 않는 옛 함수 판을 몇 개 남기나
}
export type AppServerPolicyPatch = Partial<AppServerPolicy>;

export const APP_SERVER_POLICY_DEFAULT: AppServerPolicy = {
  memory_mb: 512, timeout_s: 30, build_timeout_s: 600, build_mem_floor_mb: 500, build_heap_mb: 1024,
  stop_invocations_5m: 30_000, stop_duration_s_5m: 3_000, log_retention_days: 14, keep_versions: 3,
};

/** 바닥 — 설정이 이 밑으로 못 간다(0 · 음수 · 잡값은 바닥이 아니라 «그 값 없음» = 기본값으로 읽는다). */
export const APP_SERVER_POLICY_MIN: AppServerPolicy = {
  memory_mb: 128, timeout_s: 3, build_timeout_s: 60, build_mem_floor_mb: 300, build_heap_mb: 0,
  stop_invocations_5m: 100, stop_duration_s_5m: 60, log_retention_days: 1, keep_versions: 1,
};
/** 천장 — 설정·env 가 넘지 못한다. 시간 60초는 앞단(CloudFront 최대 60초)·라우터 시한 너머가 의미 없어서 · 빌드 30분 · 메모리 4GB. */
export const APP_SERVER_POLICY_MAX: AppServerPolicy = {
  memory_mb: 4096, timeout_s: 60, build_timeout_s: 1800, build_mem_floor_mb: 1500, build_heap_mb: 4096,
  stop_invocations_5m: 3_000_000, stop_duration_s_5m: 300_000, log_retention_days: 365, keep_versions: 20,
};

export const APP_SERVER_POLICY_KEYS = Object.keys(APP_SERVER_POLICY_DEFAULT) as Array<keyof AppServerPolicy>;

/** CloudWatch Logs 가 받는 보관 일수 — 이 밖의 값은 거절된다(PutRetentionPolicy). 365 까지만 쓴다. */
const RETENTION_DAYS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365];
export const retentionDaysFor = (n: number): number => RETENTION_DAYS.filter((d) => d <= n).pop() ?? 1;

function clamp(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || (n === 0 && min > 0)) return fallback;
  return Math.max(min, Math.min(Math.floor(n), max));
}

/** 바닥(base) 위에 patch 를 얹어 정규화한다 — 모르는 키는 버리고, 잡값은 base 값으로, 넘치는 값은 천장 · 모자란 값은 바닥으로. */
export function normalizeAppServerPolicy(patch: unknown, base: AppServerPolicy = APP_SERVER_POLICY_DEFAULT): AppServerPolicy {
  const p = (patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}) as Record<string, unknown>;
  const out = { ...base };
  for (const k of APP_SERVER_POLICY_KEYS) out[k] = clamp(p[k], base[k], APP_SERVER_POLICY_MIN[k], APP_SERVER_POLICY_MAX[k]);
  out.log_retention_days = retentionDaysFor(out.log_retention_days);
  return out;
}

/** env LIVELY_APP_SERVER_POLICY(JSON) — 플랫폼 기본. 못 읽으면 코드 기본값(부팅을 막지 않는다). */
export function envAppServerPolicy(env: NodeJS.ProcessEnv = process.env): AppServerPolicy {
  const raw = String(env.LIVELY_APP_SERVER_POLICY ?? "").trim();
  if (!raw) return { ...APP_SERVER_POLICY_DEFAULT };
  try { return normalizeAppServerPolicy(JSON.parse(raw)); } catch { return { ...APP_SERVER_POLICY_DEFAULT }; }
}

/** 이 워크스페이스에서 쓰는 값 = DB 행(비었으면 없음) 위에 env 기본. */
export function resolveAppServerPolicy(row: unknown, env: NodeJS.ProcessEnv = process.env): AppServerPolicy {
  return normalizeAppServerPolicy(row, envAppServerPolicy(env));
}

/** 5분 지표 → 멈출까. null = 아니다 · 문자열 = 멈추는 까닭(알림·기록에 그대로). 값이 없으면(지표 없음) 멈추지 않는다. */
export function autoStopReason(p: AppServerPolicy, m: { invocations5m: number | null; durationSec5m: number | null }): string | null {
  if (m.invocations5m != null && m.invocations5m > p.stop_invocations_5m) {
    return `5분 호출 ${Math.round(m.invocations5m).toLocaleString("ko-KR")}회 > 상한 ${p.stop_invocations_5m.toLocaleString("ko-KR")}회`;
  }
  if (m.durationSec5m != null && m.durationSec5m > p.stop_duration_s_5m) {
    return `5분 실행 시간 합 ${Math.round(m.durationSec5m).toLocaleString("ko-KR")}초 > 상한 ${p.stop_duration_s_5m.toLocaleString("ko-KR")}초`;
  }
  return null;
}
