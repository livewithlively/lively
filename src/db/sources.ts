// 멀티 데이터소스 레지스트리 — db_query/db_schema 가 호출 시 고르는 '읽기 창'들의 설정.
// 저장형 맥락(items/domainmap)과는 무관하다: 여기 등록되는 소스는 전부 외부 운영 DB 로의
// 읽기전용 창이며, 게이트웨이는 이들에 아무것도 저장하지 않는다(BEGIN READ ONLY → SELECT → ROLLBACK).
//
// 후방호환: 기존 DATABASE_URL 은 'default' 소스로 자동 등록된다(단일 소스 사용자는 무변경).
// 추가 소스는 DB_SOURCES_JSON 으로 명명 등록한다:
//   DB_SOURCES_JSON='{
//     "ops":       {"url":"postgres://ro@host/lively","rls":"app.current_user"},
//     "analytics": {"url":"postgres://ro@warehouse/dw","rls":null}
//   }'
// rls: SET LOCAL <rls> = <userId> 로 주입할 GUC 이름. 키를 주지 않으면 null(행수준 격리 없음 —
//   테이블수준 격리는 읽기전용 role 책임). default 소스만 후방호환으로 'app.current_user' 가 기본.

export interface DbSource {
  name: string;
  url: string;
  driver: "postgres"; // 1차 pg-only — firewall 파서·information_schema·RLS 주입이 전부 pg 전제
  rls: string | null; // null = 행수준 격리 없음(SET LOCAL 미주입)
  maxRows: number;
  timeoutMs: number;
}

export const DEFAULT_SOURCE = "default";

interface RawSource {
  url?: unknown;
  driver?: unknown;
  rls?: unknown;
  maxRows?: unknown;
  timeoutMs?: unknown;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function posIntOr(v: unknown, fallback: number, label: string): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new Error(`${label} 는 양의 정수여야 함(받음: ${JSON.stringify(v)})`);
  }
  return v;
}

function normalizeSource(
  name: string,
  cfg: RawSource,
  defMaxRows: number,
  defTimeout: number,
): DbSource {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error(`db source '${name}' 설정이 객체가 아님`);
  }
  if (typeof cfg.url !== "string" || cfg.url.trim() === "") {
    throw new Error(`db source '${name}' 에 url(문자열) 필수`);
  }
  const driver = cfg.driver === undefined ? "postgres" : cfg.driver;
  if (driver !== "postgres") {
    throw new Error(`db source '${name}' driver '${String(driver)}' 미지원 — 1차 pg-only(이종 DB 는 별도 드라이버 작업)`);
  }
  // rls: 미지정이면 보수적으로 null(행수준 격리 없음). 단 'default' 키는 후방호환으로 app.current_user 기본
  //   (DATABASE_URL 자동등록과 동일 — 운영자가 DATABASE_URL 을 default 로 JSON 이전해도 RLS 가 유지된다).
  //   명시적으로 null 을 주면 그때만 행수준 격리를 끈다(의도적 opt-out).
  let rls: string | null;
  if (cfg.rls === undefined) {
    rls = name === DEFAULT_SOURCE ? "app.current_user" : null;
  } else if (cfg.rls === null) {
    rls = null;
  } else if (typeof cfg.rls === "string" && cfg.rls.trim() !== "") {
    rls = cfg.rls;
  } else {
    throw new Error(`db source '${name}' rls 는 비어있지 않은 문자열 또는 null`);
  }
  return {
    name,
    url: cfg.url,
    driver: "postgres",
    rls,
    maxRows: posIntOr(cfg.maxRows, defMaxRows, `db source '${name}' maxRows`),
    timeoutMs: posIntOr(cfg.timeoutMs, defTimeout, `db source '${name}' timeoutMs`),
  };
}

// env → 소스 맵. 순수: env 를 인자로 받아 단위테스트 가능.
export function loadSources(env: NodeJS.ProcessEnv = process.env): Map<string, DbSource> {
  const defMaxRows = envInt(env, "DB_MAX_ROWS", 1000);
  const defTimeout = envInt(env, "DB_STATEMENT_TIMEOUT_MS", 5000);
  const sources = new Map<string, DbSource>();

  // 1) DB_SOURCES_JSON 명명 소스(있으면)
  const raw = env.DB_SOURCES_JSON;
  if (raw && raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`DB_SOURCES_JSON 파싱 실패: ${(e as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("DB_SOURCES_JSON 은 {name: {url,...}} 객체여야 함");
    }
    for (const [name, cfg] of Object.entries(parsed as Record<string, RawSource>)) {
      if (name.trim() === "") throw new Error("db source 이름은 비어있을 수 없음");
      sources.set(name, normalizeSource(name, cfg, defMaxRows, defTimeout));
    }
  }

  // 2) DATABASE_URL → 'default' 소스(명시 default 가 없을 때만). 후방호환: 현행 db_query 동작 보존.
  if (env.DATABASE_URL && env.DATABASE_URL.trim() !== "" && !sources.has(DEFAULT_SOURCE)) {
    sources.set(DEFAULT_SOURCE, {
      name: DEFAULT_SOURCE,
      url: env.DATABASE_URL,
      driver: "postgres",
      rls: "app.current_user", // 현행 db_query 의 RLS 주입을 그대로 보존
      maxRows: defMaxRows,
      timeoutMs: defTimeout,
    });
  }

  return sources;
}

// ── 모듈 캐시 — env 는 프로세스 수명 동안 고정이므로 1회 로드 ──
let _cache: Map<string, DbSource> | null = null;
function sources(): Map<string, DbSource> {
  if (!_cache) _cache = loadSources();
  return _cache;
}

export function getSourceConfig(name: string): DbSource | undefined {
  return sources().get(name);
}

export function listSourceConfigs(): DbSource[] {
  return [...sources().values()];
}

// 순수 — 맵에서 기본 소스 선택: 'default'(DATABASE_URL) 우선 → 소스 1개면 그것 → 그 외 null.
export function pickDefaultFrom(s: Map<string, DbSource>): string | null {
  if (s.has(DEFAULT_SOURCE)) return DEFAULT_SOURCE;
  if (s.size === 1) return [...s.keys()][0];
  return null;
}

// 순수 — D1 정책으로 source 해석:
//  · 명시되면 그대로(존재 검증, 없으면 에러)
//  · 미지정이면 pickDefaultFrom — default/단일이면 그것, 다중이고 default 없으면 에러(명시 강제)
export function pickSourceFrom(s: Map<string, DbSource>, given?: string): string {
  if (s.size === 0) {
    throw new Error("등록된 DB 소스 없음 — DATABASE_URL 또는 DB_SOURCES_JSON 설정 필요");
  }
  if (given !== undefined && given !== "") {
    if (!s.has(given)) {
      throw new Error(`알 수 없는 db source '${given}'. 가능: ${[...s.keys()].join(", ")}`);
    }
    return given;
  }
  const def = pickDefaultFrom(s);
  if (def) return def;
  throw new Error(
    `db source 명시 필요(등록 소스 ${s.size}개, 기본값 없음) — db_sources 로 확인 후 source 지정. 가능: ${[...s.keys()].join(", ")}`,
  );
}

// 미지정 호출의 기본 소스(런타임 캐시 기반).
export function defaultSourceName(): string | null {
  return pickDefaultFrom(sources());
}

// 호출에서 source 해석(런타임 캐시 기반).
export function resolveSourceName(given?: string): string {
  return pickSourceFrom(sources(), given);
}

// 테스트 전용 — 모듈 캐시 무효화(런타임 경로에서는 호출하지 않는다).
export function _resetSourcesCacheForTest(): void {
  _cache = null;
}
