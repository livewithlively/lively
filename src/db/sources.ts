// 멀티 데이터소스 레지스트리 — db_query/db_schema 가 호출 시 고르는 '읽기 창'들의 설정.
// 단일 출처(SoT): DB(org_db_source — 웹 UI 로 admin 이 관리, origin='db', 무재시작 반영). env(DATABASE_URL/
//   DB_SOURCES_JSON) 자동등록은 폐기됨(2026-06-23) — ambient 환경변수가 db_query 소스를 좌우하던 혼란 제거.
//   부트스트랩 ITEMS_DATABASE_URL(엔진이 org_db_source 를 읽는 연결)은 db_query 소스와 별개로 유지.
// 저장형 맥락(items/domainmap)과는 무관: 여기 소스는 전부 등록 DB 로의 읽기전용 창이며 게이트웨이는
//   아무것도 저장하지 않는다(BEGIN READ ONLY → SELECT → ROLLBACK).
//
// 시크릿: DB 소스의 url 은 비번 없는 접속문자열이고 인증은 authMode(password|iam|mtls|vault) + secretSource
//   (참조)로 — 비번은 런타임에 env 에서 해소(resolveConnectionString, allowed_db_secret_refs 화이트리스트).
//   사설/localhost host 는 allowed_db_hosts 화이트리스트로만 허용. 1차 구현은 authMode='password' 만.
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
  tableDefault: "allow" | "deny"; // 테이블 기본자세 — allow=deny-list(후방호환) / deny=allow-list(컴플라이언스) (#186)
}

export const DEFAULT_SOURCE = "default";

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// 순수 — 맵에서 기본 소스 선택: 'default' 우선 → 소스 1개면 그것 → 그 외 null.
export function pickDefaultFrom(s: Map<string, DbSource>): string | null {
  if (s.has(DEFAULT_SOURCE)) return DEFAULT_SOURCE;
  if (s.size === 1) return [...s.keys()][0];
  return null;
}

// 순수 — D1 정책으로 source 해석.
export function pickSourceFrom(s: Map<string, DbSource>, given?: string): string {
  if (s.size === 0) {
    throw new Error("등록된 DB 소스 없음 — 웹 UI(시스템›DB 소스)에서 데이터소스를 등록하세요");
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

// ── DB(org_db_source) 소스 로드 ── 등록 소스의 유일 출처(웹 SoT). 시크릿 없는 메타만. fail-open(DB 불가 시 빈 맵).
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
      tableDefault: r.table_default === "deny" ? "deny" : "allow",
    });
  }
  return m;
}

// ── 스냅샷(org_db_source, 짧은 TTL 재쿼리) ──
let _snapshot: Map<string, DbSource> | null = null;
let _dbLoadedAt = 0;
const DB_TTL_MS = 5000;

// 동기 스냅샷 — tools/db.ts 진입부에서 refreshSources() 가 먼저 await 된 전제. 미초기화면 빈 맵.
function sources(): Map<string, DbSource> {
  return _snapshot ?? new Map<string, DbSource>();
}

// org_db_source(웹 SoT)를 TTL 만료 시 재쿼리해 스냅샷 교체 — 등록 소스의 유일 출처(env 자동등록 폐기).
export async function refreshSources(force = false): Promise<void> {
  const now = Date.now();
  if (!force && _snapshot && now - _dbLoadedAt < DB_TTL_MS) return;
  _snapshot = await loadDbSources();
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
  const rc = await getRuntimeConfig(); // 시크릿참조(allowed_db_secret_refs)·host(allowed_db_hosts) 화이트리스트 공용
  if (src.secretSource) {
    if (!isSecretRefAllowed(src.secretSource, rc.allowed_db_secret_refs)) {
      throw new Error(`db source '${src.name}' auth_ref '${src.secretSource}' 가 허용목록(allowed_db_secret_refs)에 없습니다`);
    }
    password = process.env[src.secretSource] || undefined;
  }

  // 모든 db_query 소스는 웹 등록(org_db_source) — IP-pin 으로 검증된 IP 에 connect 고정(DNS 리바인딩·멀티앤서 우회 차단).
  //  allowed_db_hosts 화이트리스트면 사설/localhost 도 핀 허용. 같은 pg 파서로 분해(검증=접속 일치), host 만 IP 로
  //  치환하고 TLS 는 원래 호스트명을 servername 으로 검증한다.
  const p = parse(src.url) as unknown as {
    host?: string | null; port?: string | null; user?: string | null; database?: string | null;
    hostaddr?: string | null; ssl?: boolean | Record<string, unknown>;
  };
  if (typeof p.hostaddr === "string" && p.hostaddr.trim() !== "") {
    throw new Error(`db source '${src.name}' url 에 hostaddr 파라미터 금지`);
  }
  const host = typeof p.host === "string" && p.host.trim() !== "" ? p.host.replace(/^\[|\]$/g, "") : null;
  if (!host) throw new Error(`db source '${src.name}' url 에 host 가 없습니다`);
  const ip = await pinHost(host, rc.allowed_db_hosts); // 검증 + IP 핀(allowed_db_hosts 면 사설/localhost 도 허용)

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
  _snapshot = null;
  _dbLoadedAt = 0;
}
