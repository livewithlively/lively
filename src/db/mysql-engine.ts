// MySQL(Aurora MySQL) db_query 엔진 (#715) — mysql2 풀 + 읽기전용 트랜잭션 + 출처(orgTable/orgName) 필드 메타.
//  pg 경로(pool.ts / tools/db.ts execReadQuery)와 병렬 — pg 무손상. 보안경계(pinHost·allowed_db_hosts·
//  allowed_db_secret_refs)는 pg 와 동일 가드(source-guard.ts)를 재사용한다.
//
//  게이트2 출처(2026-07-09 spike 실측, MySQL 8.0): 프로토콜 컬럼정의 패킷의 orgTable/orgName 이 별칭·`*`·
//   조인·백틱에서 전부 원본명을 보존(`AS x` 우회 무력화) → srcKey=`${orgTable}.${orgName}`(lower) 가 정책 키
//   (org_db_column_mask 의 table.col)와 같은 도메인이라 pg 처럼 카탈로그(oid) 조회가 필요 없다.
//   표현식은 빈값(→마스킹 비대상 — 게이트1이 마스킹 컬럼의 표현식 접촉을 이미 거부), 파생테이블은 orgName=별칭
//   (→게이트1의 비최상위 거부가 방어), 뷰는 orgTable=뷰명(→뷰를 열려면 뷰 자체에 정책/마스킹 지정).
//  스키마 일치 가드: 필드 schema(db)가 소스 database 와 다르면 srcKey=null(fail-closed 기여) — 게이트1의
//   크로스-스키마 거부(firewall)와 이중 방어.
//
//  타임아웃 2중: SET SESSION max_execution_time(서버 — SELECT 행처리 루프에서 체크, 스캔형 폭주에 유효.
//   ⚠ SLEEP() 류 논-스캔은 안 잡힘: spike 실측 → SLEEP/BENCHMARK 는 firewall 이 차단) + mysql2 query
//   timeout(클라이언트 백스톱 — 초과·오류 시 커넥션 파기로 서버측 중단 유도).
//  읽기전용 4중: START TRANSACTION READ ONLY(InnoDB 쓰기 거부 ER1792 — spike 실측) + 단일 SELECT 게이트
//   (firewall) + 계정 SELECT-only(운영 전제) + reader 엔드포인트(innodb_read_only).
import mysql from "mysql2/promise";
import { getSourceConfig, type DbSource } from "./sources.js";
import { getRuntimeConfig } from "../org/store.js";
import { inspectMysqlUrl, isSecretRefAllowed, pinHost } from "./source-guard.js";
import type { FieldMeta } from "./mask.js";

// ── 풀 레지스트리 — pool.ts(pg) 패턴 미러: 키 `name@fingerprint`, 생성 프라미스 즉시 등록(경쟁 차단). ──
const pools = new Map<string, Promise<mysql.Pool>>();
const fingerprint = (src: DbSource): string => `${src.url}|${src.authMode}|${src.secretSource ?? ""}`;

export async function getMysqlPool(source: string): Promise<mysql.Pool> {
  const cfg = getSourceConfig(source);
  if (!cfg) throw new Error(`알 수 없는 db source '${source}'`);
  if (cfg.driver !== "mysql") throw new Error(`db source '${source}' 는 mysql 드라이버가 아닙니다`);
  const key = `${source}@${fingerprint(cfg)}`;
  const existing = pools.get(key);
  if (existing) return existing;
  for (const [k, op] of pools) {
    if (k.startsWith(`${source}@`) && k !== key) {
      pools.delete(k);
      void op.then((p) => p.end()).catch(() => { /* drain 실패 무시 — 이미 detach */ });
    }
  }
  const created = (async (): Promise<mysql.Pool> => {
    const opts = await resolveMysqlPoolOptions(cfg);
    return mysql.createPool(opts);
  })();
  pools.set(key, created);
  created.catch(() => {
    if (pools.get(key) === created) pools.delete(key); // 생성 실패 시 키 제거(재시도 가능)
  });
  return created;
}

// 소스 upsert/remove 시 호출(pool.invalidatePool 이 위임) — 해당 이름의 모든 풀 detach 후 drain.
export function invalidateMysqlPool(source: string): void {
  for (const [k, p] of pools) {
    if (k === source || k.startsWith(`${source}@`)) {
      pools.delete(k);
      void p.then((pool) => pool.end()).catch(() => { /* drain 실패 무시 */ });
    }
  }
}

// url(mysql://user@host:port/db[?ssl=require]) → mysql2 풀 옵션. 비번은 auth_ref(env) 화이트리스트 해소,
//  host 는 pinHost 로 IP 핀(DNS 리바인딩 차단 — allowed_db_hosts 면 사설도 허용). pg resolveConnectionString 미러.
async function resolveMysqlPoolOptions(src: DbSource): Promise<mysql.PoolOptions> {
  if (src.authMode !== "password") {
    throw new Error(`db source '${src.name}' auth_mode '${src.authMode}' 미지원 — 1차 password 만(iam/mtls/vault 후속)`);
  }
  if (!src.url) throw new Error(`db source '${src.name}' url 미설정`);
  const mi = inspectMysqlUrl(src.url);
  if (!mi.ok || !mi.host) throw new Error(`db source '${src.name}' url 불량: ${mi.error ?? "host 없음"}`);

  const rc = await getRuntimeConfig(); // 시크릿참조·host 화이트리스트 — pg 와 공용 경계
  let password: string | undefined;
  if (src.secretSource) {
    if (!isSecretRefAllowed(src.secretSource, rc.allowed_db_secret_refs)) {
      throw new Error(`db source '${src.name}' auth_ref '${src.secretSource}' 가 허용목록(allowed_db_secret_refs)에 없습니다`);
    }
    password = process.env[src.secretSource] || undefined;
  }
  const ip = await pinHost(mi.host, rc.allowed_db_hosts); // 검증 + IP 핀

  const opts: mysql.PoolOptions = {
    host: ip,
    port: mi.port,
    user: mi.user,
    database: mi.database, // 커넥션을 소스 스키마로 고정 — 미수식 테이블이 이 스키마로 해석(firewall 전제)
    password,
    connectionLimit: 10,
    multipleStatements: false, // 기본값이지만 명시(다중문 차단 — firewall 과 이중)
  };
  // ssl=require: 전송 암호화 전용 — 서버 인증서 검증은 후속(RDS CA 번들 + verifyIdentity). 검증을 안 하므로
  //  SNI(servername)도 불요(mysql2 SslOptions 에 없음). IP 핀 + 서브넷 제한 경로 전제.
  if (mi.ssl) opts.ssl = { rejectUnauthorized: false };
  return opts;
}

// ── 읽기 실행 — 목 주입 가능한 최소 표면(tools/db.test.ts 가 pg execReadQuery 와 동일 패턴으로 검증) ──
export interface MysqlConnLike {
  query(opts: string | { sql: string; rowsAsArray?: boolean; timeout?: number }): Promise<[unknown, unknown]>;
  release(): void;
  destroy(): void;
}
export interface MysqlPoolLike {
  getConnection(): Promise<MysqlConnLike>;
}

export interface MysqlReadResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  fields: FieldMeta[]; // srcKey = `${orgTable}.${orgName}`(lower) | null(표현식·무출처·스키마 불일치)
}

interface RawField {
  name?: unknown;
  orgName?: unknown;
  orgTable?: unknown;
  schema?: unknown;
  db?: unknown;
}

// 읽기 전용 트랜잭션 한 사이클: SET SESSION max_execution_time → START TRANSACTION READ ONLY → 사용자 SELECT
//  (rowsAsArray + 클라 timeout) → ROLLBACK. 오류(타임아웃 포함) 시 커넥션 destroy — tx 상태 불명 커넥션을 풀로
//  되돌리지 않고, 소켓 종료로 서버측 실행 중단을 유도한다.
export async function execReadQueryMysql(
  pool: MysqlPoolLike,
  cfg: { timeoutMs: number; maxRows: number; database: string | null },
  sql: string,
): Promise<MysqlReadResult> {
  const conn = await pool.getConnection();
  let ok = false;
  try {
    const ms = Math.max(1, Math.floor(cfg.timeoutMs));
    await conn.query(`SET SESSION max_execution_time=${ms}`);
    await conn.query("START TRANSACTION READ ONLY");
    const [raw, rawFields] = await conn.query({ sql, rowsAsArray: true, timeout: ms + 1000 });
    await conn.query("ROLLBACK"); // 읽기 전용 → 항상 롤백
    ok = true;

    const allRows = Array.isArray(raw) ? (raw as unknown[][]) : [];
    const rows = allRows.slice(0, cfg.maxRows);
    const dbLower = (cfg.database ?? "").toLowerCase();
    const fields: FieldMeta[] = (Array.isArray(rawFields) ? (rawFields as RawField[]) : []).map((f) => {
      const name = typeof f.name === "string" ? f.name : "";
      const orgTable = typeof f.orgTable === "string" ? f.orgTable : "";
      const orgName = typeof f.orgName === "string" ? f.orgName : "";
      const schema = typeof f.schema === "string" && f.schema !== "" ? f.schema : typeof f.db === "string" ? f.db : "";
      let srcKey: string | null = orgTable && orgName ? `${orgTable.toLowerCase()}.${orgName.toLowerCase()}` : null;
      if (srcKey && dbLower && schema && schema.toLowerCase() !== dbLower) srcKey = null; // 스키마 불일치 — fail-closed
      return { name, srcKey };
    });
    return { columns: fields.map((f) => f.name), rows, rowCount: rows.length, truncated: allRows.length > cfg.maxRows, fields };
  } finally {
    if (ok) conn.release();
    else conn.destroy();
  }
}
