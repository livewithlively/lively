// 박스 저장소 정책(#813) — 로그 보관 상한 · 디스크 임계치. **관리탭(DB)이 단일 창구, env 는 시드일 뿐이다.**
//
// 왜 DB 인가(env 전용이면 안 되는 이유): 고객 박스는 **우리가 못 들어간다.** .env 를 고치려면 SSH 가 필요한데
//  그건 고객만 할 수 있다 → 정책이 env 전용이면 사실상 **아무도 못 바꾼다.** 관리탭에서 바꿀 수 있어야 실제로 쓰인다.
//
// 우선순위(#688 임베딩과 같은 관례): **DB(관리탭 저장) > env 시드 > 코드 기본값.**
//  ⚠ '이 항목을 안 건드린 저장'은 DB 원본을 그대로 둬야 한다 — resolved 값을 되쓰면 env 시드가 DB 로 굳어버린다
//   (#688 에서 실제로 겪은 함정: 미설정이 영구화됨). store.updateRuntimeConfig 가 그 규칙을 지킨다.
//
// 관련: /readyz 가 이 임계치로 디스크를 판정(src/ops/health.ts) · 로그 재니터가 이 상한으로 회전(src/ops/log-janitor.ts) ·
//  95% 도달 시 신규 세션·클론 차단은 디스크 가드(T5)의 몫.

import { definePolicy } from "./knob.js";

export interface StoragePolicy {
  /** 로그 파일 1개의 최대 크기(MB). 넘으면 회전한다. 0 = 회전 끔. */
  log_max_mb: number;
  /** 회전본 보관 개수(.1 ~ .N). 로그 총량 상한 ≈ log_max_mb × (log_keep + 1). */
  log_keep: number;
  /** 디스크 경고 임계(%) — /readyz 가 status=degraded 로 알린다(트래픽은 유지). */
  disk_warn_pct: number;
  /** 디스크 위험 임계(%) — 신규 세션·클론 차단 대상(T5). */
  disk_critical_pct: number;
  /** #1059 — 메모리 경고 임계(사용%). 0 = 끔(경보 안 함). box-watch 가 이 이상이면 warn 경보(디스크와 대칭). */
  mem_warn_pct: number;
  /** #1059 — 메모리 위험 임계(사용%). 0 = 끔. 이 이상이면 critical 경보(OOM 임박 — 디스크풀만큼 치명적). warn 보다 커야. */
  mem_critical_pct: number;
  /** #687 후속 — PTY 슬롯 경고 임계(사용%). 0 = 끔. 고갈되면 ssh 까지 막히므로 **기본으로 켜 둔다**(디스크·메모리와 다른 점). */
  pty_warn_pct: number;
  /** #687 후속 — PTY 슬롯 위험 임계(사용%). 0 = 끔. warn 보다 커야. */
  pty_critical_pct: number;
  /** 세션 공유 빌드 캐시(#813 T3) — 다운로드/의존성 캐시를 박스 한 곳으로. 기본 켜짐(순수 캐시만 이동 = 안전). */
  shared_cache_enabled: boolean;
  /** ⚠ gradle/cargo **홈**까지 공유(기본 꺼짐) — 캐시뿐 아니라 설정·자격증명(gradle.properties·credentials.toml)도
   *  옮겨가 고객 빌드가 깨질 수 있다. 그래서 opt-in. (src/ops/build-cache.ts 의 homeRelocateEnv 참조) */
  shared_cache_relocate_home: boolean;
}

export type StoragePolicyPatch = Partial<StoragePolicy>;

// 기본값 — 작은 고객 박스(EC2 루트 EBS 는 통상 8~30GB)에서도 안전한 쪽으로. 로그 총량 상한 ≈ 50 × 4 = 200MB.
export const DEFAULT_STORAGE_POLICY: StoragePolicy = {
  log_max_mb: 50,
  log_keep: 3,
  disk_warn_pct: 85,
  disk_critical_pct: 95,
  // #1059 — 메모리 경보는 기본 끔(0). 디스크풀과 달리 메모리 사용%는 박스마다 정상범위가 달라(캐시 등) 기본 임계가 오탐이 되기 쉽다
  //  → 운영자가 박스 상황(메모리 카드의 현재 사용%)을 보고 켠다. 관리탭이 85/95 를 제안값으로 안내(디스크와 대칭).
  mem_warn_pct: 0,
  mem_critical_pct: 0,
  // #687 후속 — PTY 는 메모리와 달리 **기본 켬**. 고갈되면 웹터미널뿐 아니라 ssh 접속까지 막혀 '들어가서 고치는'
  //  경로가 함께 끊기고(2026-07-27 dev 맥미니 실제 사고), 평시 사용률이 낮아(맥미니 12%) 오탐 위험이 작다.
  //  디스크(85/95)보다 이르게 잡는 이유 = 고갈 후엔 원격 복구 자체가 불가능하기 때문.
  pty_warn_pct: 70,
  pty_critical_pct: 85,
  shared_cache_enabled: true, // 순수 캐시만 이동 — 위험 없고 빌드가 빨라진다
  shared_cache_relocate_home: false, // 자격증명이 딸려가므로 관리자가 명시적으로 켜야 한다
};

// 노브 선언(#1313 R47) — 범위·env 시드는 여기 표 하나가 전부다. 클램프/시드/우선순위 골격은 knob.ts 가 맡는다.
//  loose: R47 이전 이 모듈의 숫자 해석(Number(v) 직행)을 그대로 보존(byte-compat). 새 정책은 쓰지 마라 — knob.ts 참조.
const policy = definePolicy<StoragePolicy>({
  defaults: DEFAULT_STORAGE_POLICY,
  fields: {
    log_max_mb: { env: "LOG_MAX_MB", min: 0, max: 10_000, loose: true },
    log_keep: { env: "LOG_KEEP", min: 0, max: 50, loose: true },
    disk_warn_pct: { env: "DISK_WARN_PCT", min: 1, max: 99, loose: true },
    disk_critical_pct: { env: "DISK_CRITICAL_PCT", min: 1, max: 100, loose: true },
    mem_warn_pct: { env: "MEM_WARN_PCT", min: 0, max: 99, loose: true },
    mem_critical_pct: { env: "MEM_CRITICAL_PCT", min: 0, max: 100, loose: true },
    pty_warn_pct: { env: "PTY_WARN_PCT", min: 0, max: 99, loose: true },
    pty_critical_pct: { env: "PTY_CRITICAL_PCT", min: 0, max: 100, loose: true },
    shared_cache_enabled: { kind: "bool", env: "SHARED_CACHE" },
    shared_cache_relocate_home: { kind: "bool", env: "SHARED_CACHE_RELOCATE_HOME" },
  },
  // 축 사이 불변식 — 한 칸짜리 범위(min/max)로는 표현이 안 되는 것만 남긴다.
  invariant(out) {
    // 경고 ≥ 위험이면 뒤집힌 설정 — 경고를 위험 바로 아래로 끌어내린다(경고 없이 위험만 뜨는 사고 방지).
    if (out.disk_warn_pct >= out.disk_critical_pct) out.disk_warn_pct = Math.max(1, out.disk_critical_pct - 1);
    // #1059 메모리도 동일 불변식 — 단 0=끔이므로 **둘 다 켜졌을 때만** 강제(한쪽만 켜면 그 한 단계만 동작).
    if (out.mem_warn_pct > 0 && out.mem_critical_pct > 0 && out.mem_warn_pct >= out.mem_critical_pct) {
      out.mem_warn_pct = Math.max(1, out.mem_critical_pct - 1);
    }
    // #687 후속 PTY 도 동일 불변식(0=끔이므로 둘 다 켜졌을 때만 강제).
    if (out.pty_warn_pct > 0 && out.pty_critical_pct > 0 && out.pty_warn_pct >= out.pty_critical_pct) {
      out.pty_warn_pct = Math.max(1, out.pty_critical_pct - 1);
    }
  },
});

/** 잡값 방어 — 관리탭 입력이든 env 든 범위를 벗어나면 시드/기본값으로. '경고 < 위험' 불변식도 여기서 강제한다. */
export function normalizeStoragePolicy(raw: unknown): StoragePolicy {
  return policy.normalize(raw);
}

/** DB 원본(JSONB) → 유효 정책. DB 우선, 비면 env 시드, 그 다음 기본값. */
export function resolveStoragePolicy(dbRaw: unknown): StoragePolicy {
  return policy.resolve(dbRaw);
}

/** 유효 정책의 출처(관리 UI 안내) — 관리탭 저장값인지, .env 시드인지, 코드 기본값인지. */
export function storagePolicySource(dbRaw: unknown): "db" | "env" | "default" {
  return policy.source(dbRaw);
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
