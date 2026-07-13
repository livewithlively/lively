// 박스 저장소 정책(#813) — 로그 보관 상한 · 디스크 임계치. **관리탭(DB)이 단일 창구, env 는 시드일 뿐이다.**
//
// 왜 DB 인가(env 전용이면 안 되는 이유): 고객 박스는 **우리가 못 들어간다.** .env 를 고치려면 SSH 가 필요한데
//  그건 고객만 할 수 있다 → 정책이 env 전용이면 사실상 **아무도 못 바꾼다.** 관리탭에서 바꿀 수 있어야 실제로 쓰인다.
//
// 우선순위(#688 임베딩과 같은 관례): **DB(관리탭 저장) > env 시드 > 코드 기본값.**
//  ⚠ '이 항목을 안 건드린 저장'은 DB 원본을 그대로 둬야 한다 — resolved 값을 되쓰면 env 시드가 DB 로 굳어버린다
//   (#688 에서 실제로 겪은 함정: 미설정이 영구화됨). store.updateRuntimeConfig 가 그 규칙을 지킨다.
//
// 관련: /readyz 가 이 임계치로 디스크를 판정(src/health.ts) · 로그 재니터가 이 상한으로 회전(src/log-janitor.ts) ·
//  95% 도달 시 신규 세션·클론 차단은 디스크 가드(T5)의 몫.

export interface StoragePolicy {
  /** 로그 파일 1개의 최대 크기(MB). 넘으면 회전한다. 0 = 회전 끔. */
  log_max_mb: number;
  /** 회전본 보관 개수(.1 ~ .N). 로그 총량 상한 ≈ log_max_mb × (log_keep + 1). */
  log_keep: number;
  /** 디스크 경고 임계(%) — /readyz 가 status=degraded 로 알린다(트래픽은 유지). */
  disk_warn_pct: number;
  /** 디스크 위험 임계(%) — 신규 세션·클론 차단 대상(T5). */
  disk_critical_pct: number;
  /** 세션 공유 빌드 캐시(#813 T3) — 다운로드/의존성 캐시를 박스 한 곳으로. 기본 켜짐(순수 캐시만 이동 = 안전). */
  shared_cache_enabled: boolean;
  /** ⚠ gradle/cargo **홈**까지 공유(기본 꺼짐) — 캐시뿐 아니라 설정·자격증명(gradle.properties·credentials.toml)도
   *  옮겨가 고객 빌드가 깨질 수 있다. 그래서 opt-in. (src/session-cache.ts 의 homeRelocateEnv 참조) */
  shared_cache_relocate_home: boolean;
}

export type StoragePolicyPatch = Partial<StoragePolicy>;

// 기본값 — 작은 고객 박스(EC2 루트 EBS 는 통상 8~30GB)에서도 안전한 쪽으로. 로그 총량 상한 ≈ 50 × 4 = 200MB.
export const DEFAULT_STORAGE_POLICY: StoragePolicy = {
  log_max_mb: 50,
  log_keep: 3,
  disk_warn_pct: 85,
  disk_critical_pct: 95,
  shared_cache_enabled: true, // 순수 캐시만 이동 — 위험 없고 빌드가 빨라진다
  shared_cache_relocate_home: false, // 자격증명이 딸려가므로 관리자가 명시적으로 켜야 한다
};

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// env 시드(.env) — 최초 부팅·구박스 호환용 초기값. 관리탭에서 한 번 저장하면 그 뒤론 DB 가 이긴다.
const envBool = (v: string | undefined): boolean | undefined =>
  v === undefined || v === "" ? undefined : !/^(0|false|off|no)$/i.test(v);

function envSeed(): StoragePolicyPatch {
  const p: StoragePolicyPatch = {};
  if (process.env.LOG_MAX_MB) p.log_max_mb = clampInt(process.env.LOG_MAX_MB, 0, 10_000, DEFAULT_STORAGE_POLICY.log_max_mb);
  if (process.env.LOG_KEEP) p.log_keep = clampInt(process.env.LOG_KEEP, 0, 50, DEFAULT_STORAGE_POLICY.log_keep);
  if (process.env.DISK_WARN_PCT) p.disk_warn_pct = clampInt(process.env.DISK_WARN_PCT, 1, 99, DEFAULT_STORAGE_POLICY.disk_warn_pct);
  if (process.env.DISK_CRITICAL_PCT) p.disk_critical_pct = clampInt(process.env.DISK_CRITICAL_PCT, 1, 100, DEFAULT_STORAGE_POLICY.disk_critical_pct);
  const sc = envBool(process.env.SHARED_CACHE);
  if (sc !== undefined) p.shared_cache_enabled = sc;
  const rh = envBool(process.env.SHARED_CACHE_RELOCATE_HOME);
  if (rh !== undefined) p.shared_cache_relocate_home = rh;
  return p;
}

// 잡값 방어 — 관리탭 입력이든 env 든 범위를 벗어나면 시드/기본값으로. '경고 < 위험' 불변식도 여기서 강제한다.
export function normalizeStoragePolicy(raw: unknown): StoragePolicy {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const base = { ...DEFAULT_STORAGE_POLICY, ...envSeed() }; // DB 값이 없는 항목은 env 시드 → 기본값 순으로 채운다
  const out: StoragePolicy = {
    log_max_mb: r.log_max_mb !== undefined ? clampInt(r.log_max_mb, 0, 10_000, base.log_max_mb) : base.log_max_mb,
    log_keep: r.log_keep !== undefined ? clampInt(r.log_keep, 0, 50, base.log_keep) : base.log_keep,
    disk_warn_pct: r.disk_warn_pct !== undefined ? clampInt(r.disk_warn_pct, 1, 99, base.disk_warn_pct) : base.disk_warn_pct,
    disk_critical_pct: r.disk_critical_pct !== undefined ? clampInt(r.disk_critical_pct, 1, 100, base.disk_critical_pct) : base.disk_critical_pct,
    shared_cache_enabled: r.shared_cache_enabled !== undefined ? Boolean(r.shared_cache_enabled) : base.shared_cache_enabled,
    shared_cache_relocate_home: r.shared_cache_relocate_home !== undefined ? Boolean(r.shared_cache_relocate_home) : base.shared_cache_relocate_home,
  };
  // 경고 ≥ 위험이면 뒤집힌 설정 — 경고를 위험 바로 아래로 끌어내린다(경고 없이 위험만 뜨는 사고 방지).
  if (out.disk_warn_pct >= out.disk_critical_pct) out.disk_warn_pct = Math.max(1, out.disk_critical_pct - 1);
  return out;
}

/** DB 원본(JSONB) → 유효 정책. DB 우선, 비면 env 시드, 그 다음 기본값. */
export function resolveStoragePolicy(dbRaw: unknown): StoragePolicy {
  return normalizeStoragePolicy(dbRaw);
}

/** 유효 정책의 출처(관리 UI 안내) — 관리탭 저장값인지, .env 시드인지, 코드 기본값인지. */
export function storagePolicySource(dbRaw: unknown): "db" | "env" | "default" {
  if (dbRaw && typeof dbRaw === "object" && Object.keys(dbRaw as object).length > 0) return "db";
  if (Object.keys(envSeed()).length > 0) return "env";
  return "default";
}

// ── 캐시 ──
// /readyz 는 모니터가 자주 폴링한다 → 매번 DB 를 때리지 않게 짧게 캐시한다.
// ⚠ **DB 가 죽어도 정책을 낼 수 있어야 한다** — /readyz 가 가장 필요한 순간이 바로 DB 다운이다.
//   그래서 load 실패 시 마지막 값 → 기본값으로 폴백하고, 절대 throw 하지 않는다.
let cache: { at: number; policy: StoragePolicy } | null = null;

export async function effectiveStoragePolicy(
  load: () => Promise<StoragePolicy>,
  ttlMs = 30_000,
  now: () => number = Date.now,
): Promise<StoragePolicy> {
  if (cache && now() - cache.at < ttlMs) return cache.policy;
  try {
    const policy = await load();
    cache = { at: now(), policy };
    return policy;
  } catch {
    return cache?.policy ?? normalizeStoragePolicy(null);
  }
}

/** 관리탭에서 정책을 저장한 직후 호출 — 다음 조회가 즉시 새 값을 보게. */
export function invalidateStoragePolicyCache(): void {
  cache = null;
}
