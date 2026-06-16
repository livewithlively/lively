// 멀티 데이터소스 레지스트리 — db_query/db_schema 가 호출 시 고르는 '읽기 창'들의 설정.
// 두 출처를 병합한다: (1) env(DB_SOURCES_JSON·DATABASE_URL — 운영자 직접, origin='env', 읽기전용),
//   (2) DB(org_db_source — 웹 UI 로 관리, origin='db', 무재시작 반영). 이름 충돌 시 DB 가 env 를 덮어쓴다.
// 저장형 맥락(items/domainmap)과는 무관: 여기 소스는 전부 외부 운영 DB 로의 읽기전용 창이며 게이트웨이는
//   아무것도 저장하지 않는다(BEGIN READ ONLY → SELECT → ROLLBACK).
//
// 시크릿: env 소스의 url 은 비번을 포함할 수 있다(운영자 직접). DB 소스의 url 은 비번 없는 접속문자열이고
//   인증은 authMode(password|iam|mtls|vault) + secretSource(참조)로 — 비번은 런타임에 env 에서 해소
//   (resolveConnectionString). 1차 구현은 authMode='password' 만(iam/mtls/vault 는 자리만, 미지원 throw).
import pg from "pg";
import { parse } from "pg-connection-string";
import { listDbSources, getRuntimeConfig } from "../org/store.js";
import { isSecretRefAllowed, pinHost } from "./source-guard.js";

export type AuthMode = "password" | "iam" | "mtls" | "vault";

export interface DbSource {
  name: string;
  url: string;
  driver: "postgres"; // 1차 pg-only — firewall 파서·information_schema·RLS 주입이 전부 pg 전제
  rls: string | null; // null = 행수준 격리 없음(SET LOCAL 미주입)
  maxRows: number;
  timeoutMs: number;
  authMode: AuthMode;
  secretSource: string | null; // password: 비번 env 이름(DB 소스) | null(env 소스 — url 에 비번 포함)
  origin: "env" | "db";
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
    authMode: "password",
    secretSource: null, // env 소스 — 비번은 url 에 포함(운영자 직접)
    origin: "env",
  };
}

// env → 소스 맵. 순수: env 를 인자로 받아 단위테스트 가능.
export function loadSources(env: NodeJS.ProcessEnv = process.env): Map<string, DbSource> {
  const defMaxRows = envInt(env, "DB_MAX_ROWS", 1000);
  const defTimeout = envInt(env, "DB_STATEMENT_TIMEOUT_MS", 5000);
  const sources = new Map<string, DbSource>();

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

  if (env.DATABASE_URL && env.DATABASE_URL.trim() !== "" && !sources.has(DEFAULT_SOURCE)) {
    sources.set(DEFAULT_SOURCE, {
      name: DEFAULT_SOURCE,
      url: env.DATABASE_URL,
      driver: "postgres",
      rls: "app.current_user", // 현행 db_query 의 RLS 주입을 그대로 보존
      maxRows: defMaxRows,
      timeoutMs: defTimeout,
      authMode: "password",
      secretSource: null,
      origin: "env",
    });
  }

  return sources;
}

// 순수 — 맵에서 기본 소스 선택: 'default'(DATABASE_URL) 우선 → 소스 1개면 그것 → 그 외 null.
export function pickDefaultFrom(s: Map<string, DbSource>): string | null {
  if (s.has(DEFAULT_SOURCE)) return DEFAULT_SOURCE;
  if (s.size === 1) return [...s.keys()][0];
  return null;
}

// 순수 — D1 정책으로 source 해석.
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

// ── DB(org_db_source) 소스 로드 ── 시크릿 없는 메타만. fail-open(DB 불가 시 env 소스만으로 진행).
async function loadDbSources(): Promise<Map<string, DbSource>> {
  const m = new Map<string, DbSource>();
  if (!process.env.ITEMS_DATABASE_URL) return m;
  const defMaxRows = envInt(process.env, "DB_MAX_ROWS", 1000);
  const defTimeout = envInt(process.env, "DB_STATEMENT_TIMEOUT_MS", 5000);
  let rows: Awaited<ReturnType<typeof listDbSources>>;
  try {
    rows = await listDbSources();
  } catch {
    return m;
  }
  for (const r of rows) {
    if (!r.enabled || r.driver !== "postgres" || !r.url) continue;
    m.set(r.name, {
      name: r.name,
      url: r.url,
      driver: "postgres",
      rls: r.rls,
      maxRows: typeof r.max_rows === "number" && r.max_rows > 0 ? r.max_rows : defMaxRows,
      timeoutMs: typeof r.timeout_ms === "number" && r.timeout_ms > 0 ? r.timeout_ms : defTimeout,
      authMode: r.auth_mode,
      secretSource: r.auth_ref,
      origin: "db",
    });
  }
  return m;
}

// ── 병합 스냅샷(env 1회 메모 + DB 짧은 TTL) ──
let _envCache: Map<string, DbSource> | null = null;
let _snapshot: Map<string, DbSource> | null = null;
let _dbLoadedAt = 0;
const DB_TTL_MS = 5000;

// 동기 스냅샷 — tools/db.ts 진입부에서 refreshSources() 가 먼저 await 된 전제. 미초기화면 env 만.
function sources(): Map<string, DbSource> {
  if (_snapshot) return _snapshot;
  if (!_envCache) _envCache = loadSources();
  return _envCache;
}

// env(불변, 1회) + DB(org_db_source, TTL 만료 시 재쿼리)를 병합해 스냅샷 교체. DB 소스가 이름 충돌 시 우선.
export async function refreshSources(force = false): Promise<void> {
  if (!_envCache) _envCache = loadSources();
  const now = Date.now();
  if (!force && _snapshot && now - _dbLoadedAt < DB_TTL_MS) return;
  const db = await loadDbSources();
  const merged = new Map<string, DbSource>(_envCache);
  for (const [k, v] of db) merged.set(k, v); // DB 우선(env 와 이름 충돌 시)
  _snapshot = merged;
  _dbLoadedAt = now;
}

export function getSourceConfig(name: string): DbSource | undefined {
  return sources().get(name);
}

export function listSourceConfigs(): DbSource[] {
  return [...sources().values()];
}

export function defaultSourceName(): string | null {
  return pickDefaultFrom(sources());
}

export function resolveSourceName(given?: string): string {
  return pickSourceFrom(sources(), given);
}

// ── auth_mode 별 pg 접속 설정 조립 ── DB 엔 비번 미저장: password 면 secretSource(env)에서 런타임 해소.
export async function resolveConnectionString(src: DbSource): Promise<pg.PoolConfig> {
  if (src.authMode !== "password") {
    throw new Error(`db source '${src.name}' auth_mode '${src.authMode}' 미지원 — 1차 password 만(iam/mtls/vault 후속)`);
  }
  if (!src.url) throw new Error(`db source '${src.name}' url 미설정`);

  // 비번 해소(공통) — DB 엔 비번 미저장: secretSource(env) 화이트리스트 통과 시 런타임 주입.
  let password: string | undefined;
  if (src.secretSource) {
    const rc = await getRuntimeConfig();
    if (!isSecretRefAllowed(src.secretSource, rc.allowed_db_secret_refs)) {
      throw new Error(`db source '${src.name}' auth_ref '${src.secretSource}' 가 허용목록(allowed_db_secret_refs)에 없습니다`);
    }
    password = process.env[src.secretSource] || undefined;
  }

  // env 소스(운영자 직접 설정, 내부 host 정상): connectionString 그대로.
  if (src.origin !== "db") {
    const out: pg.PoolConfig = { connectionString: src.url };
    if (password) out.password = password;
    return out;
  }

  // DB 소스(웹 등록): IP-pin — 검증된 공인 IP 로 connect 고정(DNS 리바인딩·멀티앤서 우회 완전 차단).
  //  같은 pg 파서로 분해(검증=접속 일치), host 만 IP 로 치환하고 TLS 는 원래 호스트명을 servername 으로 검증한다.
  const p = parse(src.url) as unknown as {
    host?: string | null; port?: string | null; user?: string | null; database?: string | null;
    hostaddr?: string | null; ssl?: boolean | Record<string, unknown>;
  };
  if (typeof p.hostaddr === "string" && p.hostaddr.trim() !== "") {
    throw new Error(`db source '${src.name}' url 에 hostaddr 파라미터 금지`);
  }
  const host = typeof p.host === "string" && p.host.trim() !== "" ? p.host.replace(/^\[|\]$/g, "") : null;
  if (!host) throw new Error(`db source '${src.name}' url 에 host 가 없습니다`);
  const ip = await pinHost(host); // 검증 + 공인 IP 핀(사설/메타데이터/리바인딩 차단)

  const out: pg.PoolConfig = {
    host: ip,
    port: p.port ? Number(p.port) : undefined,
    user: p.user ?? undefined,
    database: p.database ?? undefined,
  };
  // TLS: IP 로 치환했으므로 인증서/SNI 검증은 원래 호스트명(servername)으로. p.ssl: {}(require)|false(disable)|undefined.
  if (p.ssl && typeof p.ssl === "object") {
    out.ssl = { ...(p.ssl as Record<string, unknown>), servername: host } as pg.PoolConfig["ssl"];
  } else if (p.ssl === true) {
    out.ssl = { servername: host } as pg.PoolConfig["ssl"];
  }
  if (password) out.password = password;
  return out;
}

// 테스트 전용 — 모듈 캐시 무효화.
export function _resetSourcesCacheForTest(): void {
  _envCache = null;
  _snapshot = null;
  _dbLoadedAt = 0;
}
