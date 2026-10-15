// 앱 판 묶음 상한(#4481 앱 v2-2) — 판 하나 · 파일 하나 · 파일 수 · 워크스페이스 전체. 값과 판정만(순수).
//
//  결정(상민 2026-10-15): 상한은 «크게»(판 250MB · 파일 50MB · 워크스페이스 10GB) 잡고, **배포 없이 고칠 수 있게** 한다.
//   → 워크스페이스 값은 org_runtime_config.app_bundle_policy(관리자 도구 app_bundle_limits)에, 플랫폼 전체 기본은 env
//     LIVELY_APP_BUNDLE_POLICY(JSON) 에 둔다. 읽는 순서 = DB(그 워크스페이스) → env(플랫폼) → 코드 기본값.
//  천장(APP_BUNDLE_POLICY_MAX)은 공용 게이트웨이를 지키는 값이라 설정으로 넘지 못한다 — 파일 하나는 메모리에 한 벌 올려 S3 로
//   보내고(s3-lite PUT), 세션 폴더에서 읽을 때는 base64 로 한 번 더 부푼다(app-bundle-source.ts). 판 하나는 임시 폴더에 풀린다.
//  0 = 무제한은 두지 않는다(worker_policy 와 다르다) — 파일 하나 무제한은 곧 게이트웨이 메모리 무제한이다.

export interface AppBundlePolicy {
  version_max_mb: number;    // 판 하나(파일 묶음 전체)의 합 — MiB
  file_max_mb: number;       // 파일 하나 — MiB
  files_max: number;         // 판 하나의 파일 수
  workspace_max_mb: number;  // 워크스페이스 전체 — 판이 가리키는 파일을 지문마다 한 벌씩 센 합(MiB)
}
export type AppBundlePolicyPatch = Partial<AppBundlePolicy>;

export const APP_BUNDLE_POLICY_DEFAULT: AppBundlePolicy = { version_max_mb: 250, file_max_mb: 50, files_max: 5000, workspace_max_mb: 10 * 1024 };

/** 천장 — 설정·env 가 넘지 못한다. ⚠ 표면 검증(capabilities/app-bundles.ts)이 같은 상수를 쓴다(드리프트 금지). */
export const APP_BUNDLE_POLICY_MAX: AppBundlePolicy = { version_max_mb: 2048, file_max_mb: 200, files_max: 20000, workspace_max_mb: 1024 * 1024 };

const KEYS = ["version_max_mb", "file_max_mb", "files_max", "workspace_max_mb"] as const;

/** 한 값 — 숫자가 아니거나 1 미만이면 바닥값(fallback), 천장을 넘으면 천장. */
function clamp(v: unknown, fallback: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

/** 바닥(base) 위에 patch 를 얹어 정규화한다 — 모르는 키는 버리고, 잡값은 바닥값으로, 넘치는 값은 천장으로. */
export function normalizeAppBundlePolicy(patch: unknown, base: AppBundlePolicy = APP_BUNDLE_POLICY_DEFAULT): AppBundlePolicy {
  const p = (patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}) as Record<string, unknown>;
  const out = { ...base };
  for (const k of KEYS) out[k] = clamp(p[k], base[k], APP_BUNDLE_POLICY_MAX[k]);
  return out;
}

/** env LIVELY_APP_BUNDLE_POLICY(JSON) — 플랫폼 기본. 못 읽으면 코드 기본값(부팅을 막지 않는다). */
export function envAppBundlePolicy(env: NodeJS.ProcessEnv = process.env): AppBundlePolicy {
  const raw = String(env.LIVELY_APP_BUNDLE_POLICY ?? "").trim();
  if (!raw) return { ...APP_BUNDLE_POLICY_DEFAULT };
  try { return normalizeAppBundlePolicy(JSON.parse(raw)); } catch { return { ...APP_BUNDLE_POLICY_DEFAULT }; }
}

/** 이 워크스페이스에서 쓰는 값 = DB 행(비었으면 없음) 위에 env 기본. */
export function resolveAppBundlePolicy(row: unknown, env: NodeJS.ProcessEnv = process.env): AppBundlePolicy {
  return normalizeAppBundlePolicy(row, envAppBundlePolicy(env));
}

export const MIB = 1024 * 1024;
export const policyBytes = (p: AppBundlePolicy): { version: number; file: number; files: number; workspace: number } =>
  ({ version: p.version_max_mb * MIB, file: p.file_max_mb * MIB, files: p.files_max, workspace: p.workspace_max_mb * MIB });

/** 판 하나가 상한 안인가 — 넘으면 사람에게 보일 까닭(처음 걸린 것 하나), 안이면 null. */
export function bundleLimitDenial(p: AppBundlePolicy, files: ReadonlyArray<{ path: string; size: number }>): string | null {
  const b = policyBytes(p);
  if (files.length > b.files) return `파일이 너무 많습니다(${files.length}개 > ${b.files}개) — 판 하나의 파일 수 상한(app_bundle_limits files_max)`;
  let total = 0;
  for (const f of files) {
    if (f.size > b.file) return `파일이 너무 큽니다(${f.path}, ${mb(f.size)} > ${p.file_max_mb}MB) — 파일 하나 상한(app_bundle_limits file_max_mb)`;
    total += f.size;
  }
  if (total > b.version) return `판 하나가 너무 큽니다(${mb(total)} > ${p.version_max_mb}MB) — 판 상한(app_bundle_limits version_max_mb)`;
  return null;
}

/** 워크스페이스 전체 — 지금 쓰는 양(used) 에 이번에 새로 쓰는 양(adding)을 더해도 되나. */
export function workspaceLimitDenial(p: AppBundlePolicy, used: number, adding: number): string | null {
  const cap = policyBytes(p).workspace;
  if (adding > 0 && used + adding > cap) {
    return `워크스페이스의 앱 파일 저장 공간이 모자랍니다(쓰는 중 ${mb(used)} + 새 파일 ${mb(adding)} > ${p.workspace_max_mb}MB) — 오래된 앱·판을 지우거나 관리자가 상한을 올리세요(app_bundle_limits workspace_max_mb)`;
  }
  return null;
}

const mb = (n: number): string => `${(n / MIB).toFixed(n < 10 * MIB ? 2 : 0)}MB`;
