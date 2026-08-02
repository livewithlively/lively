// db_query/db_schema 실행 파이프라인 — MCP 배선(tools/db.ts)에서 분리한 게이트 실행층 (#1313 R24).
//  · 읽기전용 트랜잭션 실행(execReadQuery) — 게이트2(마스킹)가 쓰는 출처 메타까지 반환
//  · 스키마 발견 실패 보강(sourceCatalog / unknownTableMessage / enrichSchemaError, #1259)
//  · self 소스 열람 가드(requireSelfSourceAllowed)는 **db/self/ 로 내려갔다**(#1313 R48) — 여기선 재수출만.
//    이 파이프라인 자체는 self 를 특별취급하지 않고, 따라서 v6(온톨로지)를 직접 import 하지 않는다.
//  tools/db.ts 는 MCP registerTool 배선만 담고 여기를 호출한다(방화벽 스택은 src/db/ 에 모인다).
import type pg from "pg";
import { listTableNames, listColumnsMeta } from "./catalog.js";
import { isSystemDeniedTable } from "./firewall.js";
import { getSourcePolicy } from "./policy.js";
import { suggestSimilarNames, formatUnknownTable, extractUnknownColumn, annotateUnknownColumn } from "./schema-hint.js";

// self 특화 가드(#1291)의 배럴 — 소비자(tools/db.ts)의 import 경로를 그대로 두기 위한 재수출(#1313 R48).
export { requireSelfSourceAllowed } from "./self/index.js";

// pg 결과 필드 출처 메타(oid:attnum) — execReadQuery 반환 전용. 게이트2 진입 시 엔진 중립 srcKey 로 변환된다(#715).
export interface PgFieldMeta {
  name: string;
  tableID: number;
  columnID: number;
}

export interface DbQueryResult {
  columns: string[];
  rows: unknown[];
  rowCount: number;
  truncated: boolean;
  fields: PgFieldMeta[]; // 마스킹(게이트2)용 출처 메타(name/tableID/columnID) — 응답엔 미노출
}

// 읽기 전용 트랜잭션 한 사이클: BEGIN READ ONLY → statement_timeout → (소스가 RLS 면) set_config 주입
//  → 사용자 SELECT → ROLLBACK. pg.PoolClient.query 만 의존하므로 목 클라이언트로 호출 순서·바인딩을
//  단위테스트할 수 있다(src/tools/db.test.ts).
export async function execReadQuery(
  client: Pick<pg.PoolClient, "query">,
  cfg: { rls: string | null; timeoutMs: number; maxRows: number; asRole?: string | null },
  userId: string,
  sql: string,
): Promise<DbQueryResult> {
  await client.query("BEGIN READ ONLY");
  await client.query(`SET LOCAL statement_timeout = ${cfg.timeoutMs}`);
  if (cfg.rls) {
    await client.query("SELECT set_config($1, $2, true)", [cfg.rls, userId]);
  }
  // #1291 v3 — self 는 여기서 **비특권 롤로 내려간다.** 소유자 롤은 RLS 를 통과해 버리므로 이게 없으면
  //  정책이 있어도 아무 소용이 없다. SET LOCAL 이라 ROLLBACK 과 함께 원복돼 풀 재사용이 안전하다(실측).
  //  ⚠ 사용자 SQL 보다 **먼저** 내려가야 한다 — 순서가 뒤집히면 그 SQL 이 소유자 권한으로 돈다.
  if (cfg.asRole) await client.query(`SET LOCAL ROLE ${cfg.asRole}`);
  const result = await client.query({ text: sql, rowMode: "array" });
  const allRows = result.rows;
  const rows = allRows.slice(0, cfg.maxRows);
  const truncated = allRows.length > cfg.maxRows;
  await client.query("ROLLBACK"); // 읽기 전용 → 항상 롤백
  return {
    columns: result.fields.map((f) => f.name),
    rows,
    rowCount: rows.length,
    truncated,
    fields: result.fields.map((f) => ({ name: f.name, tableID: f.tableID, columnID: f.columnID })),
  };
}

// ── 스키마 발견 실패 보강(#1259) — '없는 이름'을 '권한 없음'으로 오진하지 않게 한다. ──
//  firewall(순수·라이브스키마 불요)은 그대로 두고, 카탈로그가 필요한 판별만 이 배선층에서 한다.
//  차단·실패 경로에서만 도는 코드라 왕복 비용이 사용자에게 보이지 않지만, 같은 이름을 연달아
//  더듬는 흐름이 흔하므로 짧은 TTL 로 캐시한다.
const CATALOG_TTL_MS = 60_000;
const catalogCache = new Map<string, { at: number; all: Set<string>; allowed: string[] }>();

/** 소스 카탈로그 — all=존재 판별용 전체 이름(소문자), allowed=후보 제안에 쓸 '조회 허용' 이름. */
async function sourceCatalog(source: string): Promise<{ all: Set<string>; allowed: string[] }> {
  const hit = catalogCache.get(source);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit;
  const names = await listTableNames(source);
  const policy = getSourcePolicy(source);
  const all = new Set(names.map((n) => n.toLowerCase()));
  // ⚠ 후보는 allow 만 — deny 테이블을 후보로 흘리면 그 존재를 새로 노출한다(통제 합의사항, #1259).
  const allowed = names.filter((n) => {
    const tn = n.toLowerCase();
    return !isSystemDeniedTable(tn) && (policy.tableMode.get(tn) ?? policy.tableDefault) === "allow";
  });
  const entry = { at: Date.now(), all, allowed };
  catalogCache.set(source, entry);
  return entry;
}

/** 이 이름이 카탈로그에 없으면 '없다'고 답할 문구를, 있으면(=진짜 정책 deny) null 을 돌려준다. */
export async function unknownTableMessage(
  source: string,
  table: string,
  catalog: (s: string) => Promise<{ all: Set<string>; allowed: string[] }> = sourceCatalog,
): Promise<string | null> {
  const { all, allowed } = await catalog(source);
  if (all.has(table.toLowerCase())) return null;
  return formatUnknownTable(source, table, suggestSimilarNames(table, allowed));
}

export const MAX_ENRICH_TABLE_LOOKUPS = 5; // 조인이 많아도 카탈로그 왕복 상한

// 보강에 필요한 카탈로그 접근만 seam 으로 뺀다 — execReadQuery 가 목 클라이언트를 받는 것과 같은 idiom
//  (실제 DB 없이 '어느 에러가 어떤 보강을 타는가'를 단위테스트한다).
export interface EnrichDeps {
  catalog?: (source: string) => Promise<{ all: Set<string>; allowed: string[] }>;
  columns?: (source: string, table: string) => Promise<string[]>;
}

/**
 * 사용자에게 던질 에러를 보강한다 — 감사에는 원문을 남긴 뒤(분류 안정성) 여기서만 바꾼다.
 *  ① 정책 deny 로 보이지만 실은 없는 테이블 → '없음' + 유사 후보
 *  ② 없는 컬럼 → 그 쿼리가 참조한 테이블의 실제 컬럼
 *  보강 자체가 실패하면 원문을 그대로 돌려준다(보강이 원인을 삼키지 않는다).
 */
export async function enrichSchemaError(
  err: Error,
  source: string,
  refTables: readonly string[],
  deps: EnrichDeps = {},
): Promise<Error> {
  const catalog = deps.catalog ?? sourceCatalog;
  const columns = deps.columns ?? (async (s: string, t: string) => (await listColumnsMeta(s, t)).map((c) => c.column_name));
  try {
    const blocked = (err as Error & { blockedTable?: string }).blockedTable;
    if (blocked !== undefined) {
      const msg = await unknownTableMessage(source, blocked, catalog);
      return msg === null ? err : Object.assign(new Error(msg), { tables: refTables });
    }
    const column = extractUnknownColumn(err.message);
    if (column !== null && refTables.length > 0) {
      const byTable = new Map<string, string[]>();
      for (const t of refTables.slice(0, MAX_ENRICH_TABLE_LOOKUPS)) byTable.set(t, await columns(source, t));
      const msg = annotateUnknownColumn(err.message, column, byTable);
      return msg === err.message ? err : Object.assign(new Error(msg), { tables: refTables });
    }
  } catch { /* 보강 실패 — 원문이 더 정직하다 */ }
  return err;
}
