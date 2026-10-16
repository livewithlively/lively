// 앱 서버 상한(#4484 앱 v2-5) — 함수 사양 · 빌드 시간·메모리 · 자동 멈춤 기준. 값과 판정만(순수).
//
//  결정(상민 2026-10-15): 함수 기본 512MB · 30초(앱 주소 앞단이 30초에 끊는다) · 자동 멈춤 = 앱별 5분 호출 3만 회 또는 실행 시간 합 3,000초
//   (평균 동시 10개를 5분 내내) → 그 함수 동시 실행 0 + 책임자·관리자 알림, 관리자가 다시 켠다. 상한은 배포 없이 고친다.
//  읽는 순서(앱 판 묶음 상한 #4481 과 같다): org_runtime_config.app_server_policy(관리자 app_server_limits_set) → env LIVELY_APP_SERVER_POLICY → 코드 기본값.
//  빌드 메모리 바닥: 운영 세션은 상한(2,560MB)에 닿는 순간 세션이 통째로 죽는다(지식 session-swap-memory-high-node-test-3825).
//   세션 안에서 보이는 «남은 메모리»(/proc/meminfo)에는 gVisor 자체 몫(약 200~330MB)이 안 보이므로 바닥은 그 몫 + 여유로 잡는다.
//  워크스페이스 상한(#4792 · 결정 상민 2026-10-16): 모든 워크스페이스가 AWS 계정 하나를 나눠 쓴다 — Lambda 코드 저장 300GiB(문서상 늘릴 수 없음) ·
//   동시 실행 1,000. 함수 수(기본 20 · 천장 200)와 코드 저장(기본 5GB · 천장 20GB)을 새 함수 · 새 코드를 올릴 때 본다.
//   코드 저장은 AWS 가 세는 그대로 함수 판마다의 CodeSize(zip 크기) 합이다 — 2026-10-16 계정 측정: TotalCodeSize 36,599,256 = 판 없이 $LATEST 만
//   있던 옛 함수 셋의 CodeSize 합(zip 크기로 센다는 것까지 확인). 고정 판을 $LATEST 와 따로 세는지는 재지 않았다 — 따로 더해 넉넉히(많게) 센다.
//   동시 실행 몫은 Lambda 예약으로 걸지 않는다(예약 합 ≤ 1,000 − 100) — v2-6(#4485) 앞단이 요청을 센다.

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
  workspace_functions_max: number;  // #4792 이 워크스페이스의 서버 함수 수(앱마다 하나) — 새 함수를 만들 때만 본다(있는 함수는 늘 고친다)
  workspace_code_mb: number;        // #4792 이 워크스페이스 함수들의 코드 저장 합(MiB · AWS 가 세는 판마다의 zip 크기) — 새 코드를 올릴 때 본다
  unused_retire_days: number;       // #4791 지금 판 · 공개 판 둘 다 서버 선언이 없는 채로 이 날수가 지나면 그 함수를 걷는다
}
export type AppServerPolicyPatch = Partial<AppServerPolicy>;

export const APP_SERVER_POLICY_DEFAULT: AppServerPolicy = {
  memory_mb: 512, timeout_s: 30, build_timeout_s: 600, build_mem_floor_mb: 500, build_heap_mb: 1024,
  stop_invocations_5m: 30_000, stop_duration_s_5m: 3_000, log_retention_days: 14, keep_versions: 3,
  workspace_functions_max: 20, workspace_code_mb: 5 * 1024, unused_retire_days: 7,
};

/** 바닥 — 설정이 이 밑으로 못 간다(0 · 음수 · 잡값은 바닥이 아니라 «그 값 없음» = 기본값으로 읽는다). */
export const APP_SERVER_POLICY_MIN: AppServerPolicy = {
  memory_mb: 128, timeout_s: 3, build_timeout_s: 60, build_mem_floor_mb: 300, build_heap_mb: 0,
  stop_invocations_5m: 100, stop_duration_s_5m: 60, log_retention_days: 1, keep_versions: 1,
  workspace_functions_max: 1, workspace_code_mb: 100, unused_retire_days: 1,
};
/**
 * 천장 — 설정·env 가 넘지 못한다. 시간 60초는 앞단(CloudFront 최대 60초)·라우터 시한 너머가 의미 없어서 · 빌드 30분 · 메모리 4GB.
 *  함수 수 200 · 코드 저장 20GB — 워크스페이스 관리자가 스스로 올릴 수 있는 끝이다. 모든 워크스페이스가 AWS 계정 하나(동시 실행 · 코드 저장 300GiB)를
 *  나눠 쓰므로 그 너머는 플랫폼이 코드로 정한다(#4792).
 */
export const APP_SERVER_POLICY_MAX: AppServerPolicy = {
  memory_mb: 4096, timeout_s: 60, build_timeout_s: 1800, build_mem_floor_mb: 1500, build_heap_mb: 4096,
  stop_invocations_5m: 3_000_000, stop_duration_s_5m: 300_000, log_retention_days: 365, keep_versions: 20,
  workspace_functions_max: 200, workspace_code_mb: 20 * 1024, unused_retire_days: 365,
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

/**
 * 새 서버 함수를 만들어도 되나(#4792) — have = 이 워크스페이스에 이미 있는 함수 줄 수(이 앱 것은 없다). 상한 밑이면 null · 닿았으면 사람에게 보일 까닭.
 *  이미 함수가 있는 앱은 이 판정을 거치지 않는다 — 관리자가 상한을 내려도 있는 앱의 배포 · 공개 · 되돌리기는 그대로 된다.
 */
export function functionsCapDenial(p: AppServerPolicy, have: number): string | null {
  if (have < p.workspace_functions_max) return null;
  return `이 워크스페이스의 앱 서버 수가 상한에 닿았습니다(서버 함수 ${have}개 · 상한 ${p.workspace_functions_max}개) — ` +
    "쓰지 않는 서버 앱을 지우거나(org_app_remove), 관리자가 상한을 올리세요(app_server_limits_set workspace_functions_max)";
}

const MIB = 1024 * 1024;
//  1MB 밑은 KB 로 — 작은 서버의 zip(수 KB)이 «0.0MB» 로 보이면 «합이 왜 넘었나» 를 읽을 수 없다(시험 출력에서 본 것).
const mbText = (n: number): string => (n < MIB ? `${Math.ceil(n / 1024)}KB` : `${(n / MIB).toFixed(n < 10 * MIB ? 1 : 0)}MB`);
export const mbOf = (bytes: number): number => Math.round((bytes / MIB) * 10) / 10;

/** 함수 판들의 코드 크기 합(바이트) — ListVersionsByFunction 의 CodeSize($LATEST 포함). AWS 계정 사용량(TotalCodeSize)이 이 값들의 합이다. */
export const codeBytesOf = (versions: ReadonlyArray<{ CodeSize?: number }>): number => versions.reduce((s, v) => s + (Number(v.CodeSize) || 0), 0);

/**
 * 이번 배포 뒤 이 함수가 차지할 코드 저장(바이트, #4792) — 옛 판 정리(app-server-deploy pruneVersions)와 같은 규칙으로 센다:
 *  $LATEST(새 zip) + 새 판(새 zip) + 남길 옛 판(최근 keep−1 개 + 이번에 옮기지 않는 별칭이 가리키는 판). AWS 가 $LATEST 와 같은 코드의 판을
 *  따로 세는지는 재지 않았다 — 따로 더해 넉넉히(많게) 센다. versions = ListVersionsByFunction 그대로($LATEST 포함 · 함수가 없으면 빈 목록).
 */
export function codeBytesAfterDeploy(
  versions: ReadonlyArray<{ Version?: string; CodeSize?: number }>, zipBytes: number, keep: number, keepPinned: ReadonlyArray<string | null | undefined>,
): number {
  const nums = versions.filter((v) => !!v.Version && /^\d+$/.test(v.Version)).sort((a, b) => Number(b.Version) - Number(a.Version));
  const pinned = new Set(keepPinned.filter((v): v is string => !!v));
  const kept = nums.filter((v, idx) => idx < Math.max(0, keep - 1) || pinned.has(v.Version!));
  return zipBytes * 2 + kept.reduce((s, v) => s + (Number(v.CodeSize) || 0), 0);
}

/**
 * 새 코드를 올려도 되나(#4792) — others = 이 워크스페이스의 다른 함수들 코드 합 · now · after = 이 함수의 지금 · 배포 뒤(codeBytesAfterDeploy).
 *  배포 뒤 합이 상한 밑이면 null. 넘어도 이 함수가 줄거나 그대로면 막지 않는다(관리자가 상한을 내린 뒤에도 있는 앱을 고칠 수 있게 — 함수 수와 같은 원칙).
 */
export function codeCapDenial(p: AppServerPolicy, others: number, now: number, after: number): string | null {
  const cap = p.workspace_code_mb * MIB;
  if (after <= now || others + after <= cap) return null;
  //  넘는 양을 함께 적는다 — 합이 상한 근처면 반올림 탓에 «100MB + 3KB > 100MB» 처럼 앞뒤가 안 맞아 보인다(격리 리뷰).
  return `이 워크스페이스의 앱 서버 코드 저장이 상한 ${p.workspace_code_mb}MB 를 ${mbText(others + after - cap)} 넘습니다(다른 서버 ${mbText(others)} + 이 서버 배포 뒤 ${mbText(after)}) — ` +
    "쓰지 않는 서버 앱을 지우거나(org_app_remove), 관리자가 상한을 올리세요(app_server_limits_set workspace_code_mb)";
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
