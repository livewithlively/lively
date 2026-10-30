// 앱 데이터 테이블(app 스키마) 생성 + RLS를 **한 몸으로** (#1780 D6, 설계 R2-2).
//  왜 자립인가: public 전용 자동화(ensureTenantColumn/ensureTenantPolicies, nspname='public')는 app 스키마를 못 잡고,
//  그 코어를 넓히면 폭발반경이 **전 테넌트 테이블**이라 위험하다. 대신 여기서 activate.ts 와 **동일 계약**을 app.* 한정으로
//  자립 적용한다: tenant_id(strict 정책 기준 컬럼) + ENABLE/FORCE RLS + tenant_isolation(TO appRole) + owner_all(TO owner)
//  + appRole GRANT. DDL 은 반드시 **소유자 커넥션**(withOwnerConn). 런타임 접근은 앱 role 풀(itemsPool)이 SET LOCAL
//  app.tenant_id 로 자동 격리(client.ts). 앱 격리(앱 X가 Y 테이블 못 건드림)는 store_* 핸들러가 물리명을
//  appId__table 로 강제해서 얻는다(store-ddl.physicalTableName) — RLS(테넌트) ⟂ 네임스페이스(앱), 둘 다 필요.
import pg from "pg";
import { itemsPool, withTx } from "../db/client.js";
import { appRoleName } from "../org/tenancy/activate.js";
import { TENANT_DEFAULT_EXPR } from "../db/tenant-column.js";
import { physicalTableName, columnDefs, parseColumnType, assertIdent, appSchemaName, archiveSchemaName, archivedTableName, columnArchiveName, SHARED_APP_SCHEMA, appSqlRoleName, appIndexName, APP_INDEX_PREFIX,
  APP_CHECK_PREFIX, APP_FK_PREFIX, APP_KEY_PREFIX, appConstraintName, defaultLiteralText, DEFAULT_EXPRS, type StoreColumn, type StoreIndex } from "./store-ddl.js";
import { ensureAppSqlParser, checkExpressionSync } from "./app-sql.js";
import { randomBytes } from "node:crypto";
import { currentTenant } from "../org/tenant-context.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { archiveComment, type ArchiveReason, type ArchiveRecord } from "./archive-meta.js";

type Q = pg.Pool | pg.PoolClient | pg.Client;
// 늘 큰따옴표로 인용하므로 숫자로 시작해도 안전하다 — 숫자로 시작하는 앱 id(`3d-view` → `3d_view__x`)가 여기서 막히지 않게(#4224).
const qi = (n: string): string => { if (!/^[A-Za-z0-9_][A-Za-z0-9_$]*$/.test(n)) throw new Error(`unsafe ident: ${n}`); return `"${n}"`; };
const STRICT = "current_setting('app.tenant_id')::uuid";

export interface AppTableSpec {
  table: string;
  columns: StoreColumn[];
  indexes?: StoreIndex[];
  /** #4483 여러 칸에 걸친 검사 식. */
  checks?: string[];
  /** #4483 지울 칸 — 데이터가 있으면 보관 스키마로 옮긴 뒤 지운다. */
  drop_columns?: string[];
}

/**
 * 소유자 커넥션으로 fn 실행 — 앱 DDL 의 자격 우선순위(#4223):
 *  ① LIVELY_APP_DDL_DATABASE_URL — 앱 스키마 생성·소유만 하는 최소 권한 role(매니지드: 공용 DB 의 lvly_appddl).
 *     중앙 게이트웨이는 런타임 role(lvly_app)로만 붙어 DDL 권한이 없다 — 이게 없으면 CREATE SCHEMA 가 권한 부족으로
 *     실패한다(실측 2026-09-22: 매니지드 공용 DB 에 app 스키마 자체가 없었다).
 *  ② LIVELY_OWNER_DATABASE_URL — registry 모드 부팅 자식 등 소유자 DSN.
 *  ③ 둘 다 없으면(단일 모드 = 풀이 소유자) itemsPool.
 */
/** DDL 이 잠금을 기다리는 상한(ms) — 기본 10초. 시험은 짧게 준다. */
const ddlLockMs = (): number => { const n = Number(process.env.LIVELY_APP_DDL_LOCK_MS); return Number.isFinite(n) && n >= 100 ? Math.floor(n) : 10_000; };
/** DDL 문장 하나의 상한(ms) — 5분(큰 표의 형 바꾸기는 표를 다시 쓴다). */
const DDL_STATEMENT_MS = 5 * 60_000;
/** 호출부가 준 상한(ms)을 SET 문에 넣을 정수로 — 없거나 이상하면 기본값. */
const msOr = (n: number | undefined, dflt: number): number => (typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : dflt);
/** 잠금 대기 초과(55P03) · 문장 시간 초과(57014) — 데이터 탓이 아니라 상한에 걸린 것. */
const isLimitError = (e: unknown): boolean => { const code = (e as { code?: unknown })?.code; return code === "55P03" || code === "57014"; };

export async function withOwnerConn<T>(fn: (db: Q) => Promise<T>): Promise<T> {
  const ddlDsn = (process.env.LIVELY_APP_DDL_DATABASE_URL || "").trim() || (process.env.LIVELY_OWNER_DATABASE_URL || "").trim();
  const same = !ddlDsn || ddlDsn === (process.env.ITEMS_DATABASE_URL || "").trim();
  if (same) return fn(itemsPool);
  const client = new pg.Client({ connectionString: ddlDsn });
  await client.connect();
  try {
    //  #4483 — DDL 이 다른 트랜잭션의 잠금을 끝없이 기다리면 그 뒤로 앱 읽기까지 줄을 선다(ACCESS EXCLUSIVE 요청이 앞을 막는다).
    //   store_sql 의 표 보장은 앱마다 한 번만 돌고(single-flight) 다른 호출이 그 약속을 기다리므로, 멎지 않게 상한을 둔다(재검토 4-3).
    await client.query(`SET lock_timeout = '${ddlLockMs()}ms'`);
    await client.query(`SET statement_timeout = '${DDL_STATEMENT_MS}ms'`);
    return await fn(client);
  } finally { await client.end().catch(() => { /* noop */ }); }
}

// 런타임에 앱 role 이 실재할 때만 그 role 대상 정책/GRANT 를 건다. 단일 모드(앱 role 없음)면 owner_all 만(격리 불요).
//  LIVELY_APP_DB_ROLE 이 있으면 그 이름을 쓴다(#4223) — 매니지드 공용 DB 의 런타임 role 은 `lvly_app` 이고, registry 모드
//  파생 이름(lvly_app_<db>)과 다르다. 파생 이름으로 찾으면 매니지드에선 없다 → 정책·GRANT 가 빠져 런타임이 테이블을 못 읽는다.
async function resolveAppRole(db: Q): Promise<string | null> {
  const explicit = (process.env.LIVELY_APP_DB_ROLE || "").trim();
  const role = explicit || appRoleName(String((await db.query("SELECT current_database() AS d")).rows[0]?.d ?? ""));
  const exists = (await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rows.length > 0;
  if (!exists && explicit) logger.warn({ role }, "LIVELY_APP_DB_ROLE 로 지정한 런타임 role 이 DB 에 없습니다 — 앱 테이블 격리 정책을 걸 수 없습니다");
  return exists ? role : null;
}

/** 이 요청(테넌트 컨텍스트)에서 그 앱의 테이블이 사는 스키마. 순수 판정은 store-ddl.appSchemaName. */
export function appSchemaFor(builtin: boolean): string {
  return appSchemaName({ builtin, tenantId: currentTenant()?.id ?? null });
}

async function ensureAppSchema(db: Q, schema: string, appRole: string | null, owner: string): Promise<void> {
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${qi(schema)}`);
  if (appRole) {
    // 스키마 USAGE 부여는 스키마 주인만 할 수 있다 — 이미 있으면 건너뛴다(공유 app 스키마가 다른 role 소유로 먼저 있는
    //  박스에서 DDL role 이 GRANT 를 시도하면 «permission denied for schema» 로 테이블 생성 전체가 죽는다. 실측 PG 통합 테스트).
    const has = (await db.query("SELECT has_schema_privilege($1, $2, 'USAGE') AS ok", [appRole, schema])).rows[0]?.ok === true;
    if (!has) await db.query(`GRANT USAGE ON SCHEMA ${qi(schema)} TO ${qi(appRole)}`);
    await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(owner)} IN SCHEMA ${qi(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${qi(appRole)}`);
  }
}

/** 설치가 테이블 구조에 한 일(#4224) — 설치 응답에 그대로 실어 세션·사람이 «무엇이 바뀌었나» 를 본다. */
export interface AppTableReport {
  created: string[];                                                        // 새로 만든 테이블(선언 이름)
  added_columns: Array<{ table: string; column: string; type: string }>;    // 매니페스트에 늘어 ADD COLUMN 한 칸
  type_mismatches: Array<{ table: string; column: string; declared: string; actual: string; reason?: string }>; // 타입이 달라도 바꾸지 못한 칸
  added_indexes: Array<{ table: string; columns: string[]; unique: boolean; where?: string }>;  // #4226 새로 만든 선언 인덱스(where — 조건부)
  dropped_indexes: Array<{ table: string; index: string }>;                      // #4226 선언에서 빠져 지운 인덱스(라이블리가 만든 것만)
  /** #4226 자유 SQL 이 내려갈 앱 역할 — 만들었으면 ok, 못 만들었으면 그 까닭(설치는 계속된다 · store_sql 만 막힌다). */
  sql_role?: { ok: boolean; error?: string };
  // ── #4483 ──
  renamed_columns: Array<{ table: string; from: string; to: string }>;                       // renamed_from 으로 이름만 바꾼 칸
  converted_columns: Array<{ table: string; column: string; from: string; to: string }>;    // 값을 잃지 않아 타입을 바꾼 칸
  dropped_columns: Array<{ table: string; column: string; rows: number; archived_as: string | null }>; // drop_columns — 값이 있으면 보관
  undeclared_columns: Array<{ table: string; column: string }>;                             // 선언에 없지만 남겨 둔 칸(제약만 풀었다)
  constraints: Array<{ table: string; column?: string; kind: "not_null" | "default" | "check" | "foreign_key" | "primary_key" | "unique"; action: "added" | "removed" | "changed" }>;
  // ── #4724 ──
  deferred: Array<{ table: string; change: string }>;                                       // 지켜야 할 칸이라 미룬 변경(공개할 때 · 공유 표는 하지 않음)
}
export const emptyTableReport = (): AppTableReport => ({
  created: [], added_columns: [], type_mismatches: [], added_indexes: [], dropped_indexes: [],
  renamed_columns: [], converted_columns: [], dropped_columns: [], undeclared_columns: [], constraints: [], deferred: [],
});

/**
 * #4724 지켜야 할 칸 — 다른 판(또는 다른 워크스페이스)의 코드가 지금 쓰고 있어, 깨는 변경을 하면 안 되는 칸.
 *  · Map(표 → 칸 이름들): 초안이 걸린 공개 앱 — 공개 판이 선언한 칸. 초안에서만 새로 생긴 칸은 지키지 않는다(공개 판이 안 쓴다).
 *  · "existing": 지금 있는 칸 전부 — 여러 워크스페이스가 나눠 쓰는 공유 표(기본 앱). 다른 워크스페이스의 코드가 무엇을 쓰는지 모른다.
 *  지키는 칸엔 «풀기»(not_null·검사·외래키 빼기)와 늘리기만 하고, 지우기·이름·형 바꾸기·조이기(not_null·unique·외래키 더하기)·unique 빼기·
 *  기본값 더하기·빼기·바꾸기(다른 판의 INSERT 가 이 칸을 빼고 넣으면 받는 값이다)는 미뤄 보고서 deferred 에 적는다 — 공개할 때
 *  (publishCurrent 가 지키지 않고 다시 맞춘다) 반영. 지키는 칸이 있는 표(= 다른 판의 코드가 쓰는 표)에서는 더해서:
 *   · 새 검사는 모두 미룬다 — 그 코드가 넣는 값(새 칸이면 빈 값 · 기본값)을 검사가 막을 수 있다
 *   · 새 칸의 «값이 꼭 있어야 하는데 기본값이 없는» 상태(기본값 없는 not_null · not_null 칸의 기본값 빼기)는 미룬다 — 그 코드의 INSERT 는 새 칸을 빼고 넣는다
 *   · 같은 값이 들어가는 기본값이 있는 새 칸의 unique · 외래키는 미룬다 — 그 코드의 INSERT 마다 같은 값이 들어간다
 *   · 미룬 이름 바꾸기의 새 이름(아직 없는 칸) · 미룬 형 바꾸기의 칸에 걸린 규칙(인덱스 · 검사 · 외래키 · 기본값)도 미룬다
 *  "existing"(공유 표)은 미룬 일이 영영 오지 않으므로 옛 검사 · 외래키를 걷지도 않는다 — 매니페스트로는 더하기만 된다(깨는 변경은 SQL 마이그레이션).
 */
export type ProtectColumns = ReadonlyMap<string, ReadonlySet<string>> | "existing";
/** #4724 표 하나의 판정기 — 지킬 칸이 없으면 NO_GUARD(종전 그대로 다 맞춘다). ProtectColumns 주석의 규칙을 함수들이 이것으로 묻는다. */
interface Guard {
  /** 지키는 칸(다른 판 · 다른 워크스페이스의 코드가 쓴다). */
  has(col: string): boolean;
  /** 이 표에 지키는 칸이 하나라도 있다 = 다른 판의 코드가 이 표를 쓴다(그 INSERT 는 모르는 칸을 빼고 넣는다). */
  any: boolean;
  /** 공유 표("existing") — 미룬 일이 영영 오지 않는다. */
  shared: boolean;
  /** 지금은 선언대로 둘 수 없는 칸 — 이름 바꾸기를 미룬 새 이름(아직 없다) · 형 바꾸기를 미룬 칸(옛 형). */
  pending(col: string): boolean;
  pend(col: string): void;
  defer(change: string): void;
}
const NO_GUARD: Guard = { has: () => false, any: false, shared: false, pending: () => false, pend: () => { /* 지킬 칸 없음 */ }, defer: () => { /* 지킬 칸 없음 */ } };
/** 같은 값을 거듭 넣지 않는 기본값 — unique 칸에 걸려도 다른 판의 INSERT 끼리 겹치지 않는다(pg_get_expr 이 돌려주는 꼴). */
const UNIQUE_SAFE_DEFAULTS: ReadonlySet<string> = new Set(["gen_random_uuid()"]);

/** 물리 테이블 하나 생성 + RLS(멱등 — 존재하면 정책/GRANT 보강 + 칸·제약 동기화, #4224·#4483). 반환 = 물리 테이블명.
 *  #4483 — 표 하나의 일은 **한 트랜잭션**이다: 이름 바꾸기 → 지울 칸(값은 보관) → 늘어난 칸 → 값을 잃지 않는 타입 변환 →
 *   선언에 없는 칸의 제약 풀기 → NOT NULL · 기본값 · 검사 → RLS·권한 → 인덱스. 하나라도 실패하면 그 표는 설치 전 그대로다.
 *  외래키는 다른 표가 다 생긴 뒤 ensureAppTables 가 따로 맞춘다(syncForeignKeys).
 *  schema 기본값 `app` = 종전 동작(기본 앱·단일 테넌트). 워크스페이스가 설치한 앱은 호출부가 appSchemaFor 로 고른다. */
export async function createAppTable(db: Q, appId: string, spec: AppTableSpec, schema: string = SHARED_APP_SCHEMA, report?: AppTableReport,
  opts: { tenantScopedIndexes?: boolean; protect?: ReadonlySet<string>; shared?: boolean; pending?: Set<string>; lockMs?: number; statementMs?: number; surfaceTimeouts?: boolean;
    archiveReason?: ArchiveReason } = {}): Promise<string> {
  const physical = physicalTableName(appId, spec.table);
  const cols = columnDefs(spec.columns);
  const owner = String((await db.query("SELECT current_user AS u")).rows[0]?.u ?? "");
  const appRole = await resolveAppRole(db);
  //  #4732 따로 한 트랜잭션(바깥 한 트랜잭션 안이면 저장점) — 여기서 잠금 대기 초과 같은 오류가 나도 바깥 트랜잭션이 깨져
  //   뒤 표들이 «current transaction is aborted» 로 줄줄이 실패하지 않게(공개 · 공개 미리 보기). 따로 할 때는 종전처럼 바로 끝난다.
  await inTx(db, (c) => ensureAppSchema(c, schema, appRole, owner));
  const rel = `${qi(schema)}.${qi(physical)}`;
  const rep = report ?? emptyTableReport();
  //  검사 식(check · enum)은 검사기로 먼저 본다 — 어긋나면 표를 건드리기 전에 400.
  const checks = await desiredChecks(schema, physical, spec);
  // 이 표에서 일어난 일은 끝까지 성공했을 때만 보고서에 싣는다(실패해 되돌린 일을 «했다» 로 적지 않게).
  const local = emptyTableReport();
  const guard = guardFor(spec.table, opts.protect, local, { shared: opts.shared, pending: opts.pending });
  await inTx(db, async (c) => {
    //  #4483 — 런타임(앱 SQL 실행기)과 같은 해석 조건으로 DDL 을 돈다: 검사기가 본 검사 식이 DB 에서도 같은 함수·연산자로 묶이고
    //  (소유자 연결의 기본 search_path 에 다른 스키마가 있어도), enum 값처럼 ' 만 두 번 써 넣은 글자가 그대로 읽힌다(격리 리뷰).
    //  이 트랜잭션의 문장은 전부 스키마를 붙인 이름과 pg_catalog 형·함수만 쓴다.
    await c.query("SET LOCAL standard_conforming_strings = on");
    await c.query("SET LOCAL search_path = pg_catalog, pg_temp");
    await c.query(`SET LOCAL lock_timeout = '${msOr(opts.lockMs, ddlLockMs())}ms'`);   // 공용 풀(단일 모드)에서도 — 위 withOwnerConn 주석
    await c.query(`SET LOCAL statement_timeout = '${msOr(opts.statementMs, DDL_STATEMENT_MS)}ms'`);
    const existed = await tableExists(c, schema, physical);
    await c.query(
      `CREATE TABLE IF NOT EXISTS ${rel} (
         tenant_id uuid NOT NULL DEFAULT ${TENANT_DEFAULT_EXPR},
         id bigint GENERATED ALWAYS AS IDENTITY,
         ${cols.join(",\n         ")},
         created_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (${opts.tenantScopedIndexes ? "tenant_id, id" : "id"})
       )`);
    if (!existed) local.created.push(spec.table);
    else {
      if (!opts.tenantScopedIndexes) await narrowPrimaryKey(c, schema, physical, rel, spec, local, !!opts.surfaceTimeouts);
      await syncColumns(c, schema, physical, rel, spec, local, guard, new Date(), !!opts.surfaceTimeouts, { appId, reason: opts.archiveReason ?? "install" });
    }
    await syncColumnRules(c, schema, physical, rel, spec, checks, local, guard);
    //  #4724 이미 켜져 있으면 다시 걸지 않는다 — ALTER TABLE 은 표를 통째로 잠근다(공개 때 표 전부를 한 트랜잭션으로 맞추면
    //   바뀌는 것 없는 표까지 끝까지 잠겨 그 표를 읽는 사람이 기다린다 — 격리 리뷰 실측).
    const sec = (await c.query("SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE oid = to_regclass($1)", [rel])).rows[0] as { rls?: boolean; forced?: boolean } | undefined;
    if (!sec?.rls) await c.query(`ALTER TABLE ${rel} ENABLE ROW LEVEL SECURITY`);
    if (!sec?.forced) await c.query(`ALTER TABLE ${rel} FORCE ROW LEVEL SECURITY`);
    // CREATE POLICY 는 IF NOT EXISTS 미지원 → 기존 정책 조회 후 없는 것만.
    const have = new Set((await c.query(
      `SELECT policyname FROM pg_policies WHERE schemaname=$1 AND tablename=$2`, [schema, physical])).rows.map((r) => String(r.policyname)));
    if (appRole && !have.has("tenant_isolation"))
      await c.query(`CREATE POLICY ${qi("tenant_isolation")} ON ${rel} FOR ALL TO ${qi(appRole)} USING (tenant_id = ${STRICT}) WITH CHECK (tenant_id = ${STRICT})`);
    if (!have.has("owner_all"))
      await c.query(`CREATE POLICY ${qi("owner_all")} ON ${rel} FOR ALL TO ${qi(owner)} USING (true) WITH CHECK (true)`);
    if (appRole) await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${rel} TO ${qi(appRole)}`);
    await syncDeclaredIndexes(c, schema, physical, rel, spec, !!opts.tenantScopedIndexes, local, guard);
  });
  mergeReport(rep, local);
  return physical;
}

/** 표 하나의 지킬 칸 → 판정기. 지킬 칸이 없으면(새 표 · 지키지 않는 설치) 종전 그대로 다 맞춘다.
 *  pending 은 표 보장과 그 뒤 외래키 단계가 같은 것을 나눠 쓴다(이름 바꾸기를 미룬 새 이름 칸은 외래키 단계에도 아직 없다). */
function guardFor(table: string, protect: ReadonlySet<string> | undefined, report: AppTableReport, opts: { shared?: boolean; pending?: Set<string> } = {}): Guard {
  if (!protect || !protect.size) return NO_GUARD;
  const pending = opts.pending ?? new Set<string>();
  return {
    has: (col) => protect.has(col), any: true, shared: !!opts.shared,
    pending: (col) => pending.has(col), pend: (col) => { pending.add(col); },
    defer: (change) => { report.deferred.push({ table, change }); },
  };
}

/**
 * 기본 키를 (id) 로(#4483). 예전 판이 만든 설치 앱 표는 (tenant_id, id) 였다 — PG 는 묶은 칸이 **기본 키**일 때만 같은 표의
 *  다른 칸을 고르게 해 줘서(유일 인덱스로는 안 된다), 보통 웹 코드의 `GROUP BY contacts.id` 뒤 contacts.name 이 거절됐다.
 *  설치 앱 표는 워크스페이스마다 따로라(한 표 = 한 테넌트) id 하나로 유일하다. 공유 표(기본 앱)는 부르지 않는다.
 *  이 표를 가리키던 외래키는 옛 기본 키 인덱스에 기대므로 떼어 둔다 — 같은 보장의 외래키 단계가 (tenant_id, id) 유일 제약 위로 다시 건다.
 *  id 가 겹치는 행이 있거나(한 표에 여러 테넌트 — 생기지 않아야 하는 상태) 다른 까닭으로 못 바꾸면 떼었던 외래키까지 되돌리고
 *  그대로 둔다(SAVEPOINT) — 표 보장은 계속한다.
 */
async function narrowPrimaryKey(c: Q, schema: string, physical: string, rel: string, spec: AppTableSpec, report: AppTableReport, surfaceTimeouts = false): Promise<void> {
  const pk = (await c.query(
    `SELECT con.conname, array_to_string(array_agg(a.attname::text ORDER BY k.ord), ',') AS cols
       FROM pg_constraint con
       CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      WHERE con.conrelid = to_regclass($1) AND con.contype = 'p'
      GROUP BY con.conname`, [`${qi(schema)}.${qi(physical)}`])).rows[0] as { conname: string; cols: string } | undefined;
  if (!pk || pk.cols !== "tenant_id,id") return;
  await c.query("SAVEPOINT lv_pk");
  try {
    const fks = (await c.query(
      `SELECT n.nspname, cl.relname, con.conname FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE con.confrelid = to_regclass($1) AND con.contype = 'f'`, [`${qi(schema)}.${qi(physical)}`])).rows;
    for (const fk of fks) {
      if (!String(fk.conname).startsWith(APP_FK_PREFIX)) throw new Error(`라이블리가 만들지 않은 외래키(${fk.conname})가 이 표를 가리킵니다`);
      await c.query(`ALTER TABLE ${qi(String(fk.nspname))}.${qi(String(fk.relname))} DROP CONSTRAINT ${qi(String(fk.conname))}`);
    }
    await c.query(`ALTER TABLE ${rel} DROP CONSTRAINT ${qi(pk.conname)}, ADD CONSTRAINT ${qi(pk.conname)} PRIMARY KEY (id)`);
    await c.query("RELEASE SAVEPOINT lv_pk");
    report.constraints.push({ table: spec.table, kind: "primary_key", action: "changed" });
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT lv_pk");
    //  #4732 공개 미리 보기는 상한에 걸린 것을 «다 못 봄» 으로 알린다(삼키면 실제와 다른 계획을 보여 준다). 설치 · 공개는 종전처럼 넘어간다.
    if (surfaceTimeouts && isLimitError(err)) throw err;
    logger.warn({ err, schema, physical }, "기본 키를 (id) 로 바꾸지 못했습니다 — 표는 그대로 씁니다");
  }
}

/** 외래키가 가리킬 (tenant_id, 칸) 유일 키를 보장한다(#4483) — 칸은 보통 id, references.column 이면 그 칸.
 *  기본 키 · 유일 제약이 이미 그 모양(공유 표의 기본 키 등)이면 그것을 쓴다. 만들었으면 true.
 *  id 의 키 이름은 종전 그대로(이미 깔린 앱의 제약을 다시 만들지 않게), 다른 칸은 칸 이름을 섞는다. */
async function ensureTenantIdKey(c: Q, schema: string, physical: string, column: string = "id"): Promise<boolean> {
  const has = (await c.query(
    `SELECT 1 FROM pg_constraint con
      WHERE con.conrelid = to_regclass($1) AND con.contype IN ('p', 'u')
        AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
              WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)) = $2::text[]`,
    [`${qi(schema)}.${qi(physical)}`, [column, "tenant_id"].sort()])).rowCount;
  if (has) return false;
  const name = column === "id" ? appConstraintName(APP_KEY_PREFIX, schema, physical) : appConstraintName(APP_KEY_PREFIX, schema, physical, column);
  await c.query(`ALTER TABLE ${qi(schema)}.${qi(physical)} ADD CONSTRAINT ${qi(name)} UNIQUE (tenant_id, ${qi(column)})`);
  return true;
}

/** 표 하나의 보고를 큰 보고에 붙인다. */
export function mergeReport(into: AppTableReport, from: AppTableReport): void {
  for (const k of ["created", "added_columns", "type_mismatches", "added_indexes", "dropped_indexes", "renamed_columns", "converted_columns",
    "dropped_columns", "undeclared_columns", "constraints", "deferred"] as const) {
    (into[k] as unknown[]).push(...(from[k] as unknown[]));
  }
}

/**
 * 선언 인덱스 맞추기(#4226) — 선언에 있고 없는 것은 만들고, 라이블리가 만든 것(lvix_ 접두) 중 선언에서 빠진 것은 지운다.
 *  사람·다른 경로가 만든 인덱스(PK 포함)는 건드리지 않는다. 인덱스는 데이터를 담지 않으므로 지워도 잃는 것이 없다.
 *  tenantScoped = 여러 워크스페이스가 나눠 쓰는 공유 테이블(기본 앱) — 인덱스 앞에 tenant_id 를 둔다(유일성도 워크스페이스 안에서).
 *   워크스페이스가 설치한 앱은 테이블이 워크스페이스마다 따로라 선언 그대로 만든다(`ON CONFLICT (email)` 이 그대로 맞는다).
 *  #4483 — 칸의 unique: true 는 그 칸 하나짜리 unique 인덱스, references 칸은 그 칸 인덱스(외래키 조회·지우기 때 전체 훑기 방지)를
 *   선언한 것으로 친다. unique 인덱스는 이미 겹친 값이 있으면 만들어지지 않는다 — 몇 개가 겹치는지 세어 409 로 알린다.
 */
async function syncDeclaredIndexes(db: Q, schema: string, physical: string, rel: string, spec: AppTableSpec, tenantScoped: boolean, report?: AppTableReport, guard: Guard = NO_GUARD): Promise<void> {
  const want = new Map<string, StoreIndex>();
  //  조건부 인덱스(where) — 검사 식과 같은 검사기를 지난다(그 표의 칸만 · 위험 함수 · 다른 표 · 파라미터 거부). 이름에 조건이 들어가
  //   조건을 바꾸면 옛 인덱스를 지우고 새로 만든다.
  if ((spec.indexes ?? []).some((ix) => ix.where !== undefined)) await ensureAppSqlParser();
  const tableCols = ["id", "created_at", ...spec.columns.map((c) => c.name)];
  const add = (ix: StoreIndex): void => {
    const cols = ix.columns.map((c) => (c === "id" || c === "created_at" ? c : assertIdent("column", c)));
    const norm: StoreIndex = { columns: cols, unique: !!ix.unique };
    if (ix.where !== undefined) {
      try { norm.where = checkExpressionSync(ix.where, tableCols); }
      catch (e) { throw e instanceof HttpError ? new HttpError(e.status, e.message.replace("검사 식(check)", `인덱스 조건(where — ${spec.table})`)) : e; }
    }
    want.set(appIndexName(schema, physical, norm, tenantScoped), norm);
  };
  for (const ix of spec.indexes ?? []) add(ix);
  for (const c of spec.columns) {
    if (c.unique) add({ columns: [c.name], unique: true });
    if (c.references && !(spec.indexes ?? []).some((ix) => ix.columns[0] === c.name)) add({ columns: [c.name], unique: false });
  }
  const haveRows = (await db.query(
    `SELECT i.relname AS name, x.indisunique AS uniq,
            array(SELECT a.attname::text FROM unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum ORDER BY k.ord) AS cols
       FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
      WHERE x.indrelid = to_regclass($1) AND starts_with(i.relname, $2)`,
    [`${qi(schema)}.${qi(physical)}`, APP_INDEX_PREFIX])).rows as Array<{ name: string; uniq: boolean; cols: string[] }>;
  const have = new Set(haveRows.map((r) => String(r.name)));
  for (const h of haveRows) {
    if (want.has(h.name)) continue;
    //  #4724 지키는 칸의 unique 를 빼면 다른 판의 `ON CONFLICT (칸)` 이 깨진다 — 미룬다. 일반 인덱스는 빼도 깨지지 않지만, 공개 판이 아직 쓰는
    //   칸(이 선언에 없는 지키는 칸)의 것이면 칸과 함께 공개할 때 걷는다(그 칸 조회가 초안 기간에 느려지지 않게).
    const own = (h.cols ?? []).filter((c) => c !== "tenant_id");
    if (h.uniq && own.some((c) => guard.has(c))) { guard.defer(`unique 인덱스 빼기 ${spec.table}(${own.join(",")})`); continue; }
    if (keptColumn(guard, spec, own)) continue;
    await db.query(`DROP INDEX IF EXISTS ${qi(schema)}.${qi(h.name)}`);
    report?.dropped_indexes.push({ table: spec.table, index: h.name });
  }
  //  #4724 다른 판의 코드가 빼고 넣는 새 칸에 같은 값이 들어가는 기본값이 있으면 그 INSERT 마다 같은 값이 들어간다 — 그 칸의 unique 는 공개할 때.
  const now = guard.any ? await columnsOf(db, rel) : null;
  const sameValueDefault = (col: string): boolean => { const d = now?.get(col)?.default; return d != null && !UNIQUE_SAFE_DEFAULTS.has(d); };
  for (const [name, ix] of want) {
    if (have.has(name)) continue;
    const label = `${ix.unique ? "unique " : ""}인덱스 더하기 ${spec.table}(${ix.columns.join(",")})`;
    //  미룬 이름 바꾸기의 새 이름은 아직 없다 · 미룬 형 바꾸기의 칸은 옛 형이다 — 그 칸의 인덱스는 칸과 함께 공개할 때.
    if (ix.columns.some((c) => guard.pending(c))) { guard.defer(label); continue; }
    if (ix.unique && ix.columns.some((c) => guard.has(c) || (guard.any && sameValueDefault(c)))) { guard.defer(label); continue; }
    const cols = [...(tenantScoped ? ["tenant_id"] : []), ...ix.columns].map(qi).join(", ");
    //  조건은 검사 식처럼 괄호 안에 줄바꿈을 붙여 넣는다 — 식 끝의 `-- 주석` 이 닫는 괄호를 먹지 않게.
    const cond = ix.where !== undefined ? ` WHERE (${ix.where}\n)` : "";
    if (ix.unique) {
      const dup = Number((await db.query(
        `SELECT count(*)::bigint AS n FROM (SELECT 1 FROM ${rel} WHERE ${ix.columns.map((c) => `${qi(c)} IS NOT NULL`).join(" AND ")}${ix.where !== undefined ? ` AND (${ix.where}\n)` : ""}
           GROUP BY ${cols} HAVING count(*) > 1) d`)).rows[0]?.n ?? 0);
      if (dup > 0) {
        throw new HttpError(409, `'${spec.table}' 에 ${ix.columns.join(", ")} 값이 겹치는 묶음이 ${dup}개 있어 unique 를 걸 수 없습니다${ix.where !== undefined ? `(조건 ${ix.where})` : ""} — 겹친 행을 고치거나 지운 뒤 다시 설치하세요`);
      }
    }
    await db.query(`CREATE ${ix.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${qi(name)} ON ${rel} (${cols})${cond}`);
    report?.added_indexes.push({ table: spec.table, columns: ix.columns, unique: !!ix.unique, ...(ix.where !== undefined ? { where: ix.where } : {}) });
  }
}

// ── 칸 동기화(#4224 · #4483) ─────────────────────────────────────────────────────────────
const SYSTEM_COLUMNS = new Set(["tenant_id", "id", "created_at"]);

interface ColumnState { type: string; notNull: boolean; default: string | null }
async function columnsOf(c: Q, rel: string): Promise<Map<string, ColumnState>> {
  const r = await c.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS nn, pg_get_expr(d.adbin, d.adrelid) AS def
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`, [rel]);
  return new Map(r.rows.map((x) => [String(x.name), { type: String(x.type), notNull: x.nn === true, default: x.def == null ? null : String(x.def) }]));
}

/** DB 가 붙인 따옴표 — 글자를 SQL 리터럴로(백슬래시가 있으면 E'…'). 우리 손으로 이스케이프하지 않는다. */
async function quoteLiteral(c: Q, text: string): Promise<string> {
  return String((await c.query("SELECT quote_literal($1::text) AS q", [text])).rows[0]?.q);
}

/** 칸의 기본값 식(DDL 조각) — default_expr 은 목록의 식, default 는 형에 맞게 캐스트한 리터럴. 없으면 null. */
async function defaultSql(c: Q, col: StoreColumn): Promise<string | null> {
  if (col.default_expr !== undefined) {
    const k = col.default_expr.toLowerCase();
    const e = Object.hasOwn(DEFAULT_EXPRS, k) ? DEFAULT_EXPRS[k] : undefined;
    if (typeof e !== "string") throw new HttpError(400, `default_expr '${col.default_expr}' 는 받지 않습니다(${Object.keys(DEFAULT_EXPRS).join(" · ")})`);
    return e;
  }
  const ty = parseColumnType(col.type);
  const text = defaultLiteralText(col.default, ty);
  if (text === null) return null;
  const sql = `${await quoteLiteral(c, text)}::${ty.sql}`;
  try { await c.query("SAVEPOINT lv_def"); await c.query(`SELECT ${sql}`); await c.query("RELEASE SAVEPOINT lv_def"); }
  catch (e) {
    await c.query("ROLLBACK TO SAVEPOINT lv_def");
    throw new HttpError(400, `칸 '${col.name}' 의 default ${JSON.stringify(col.default)} 가 ${col.type} 형이 아닙니다 — ${(e as Error)?.message ?? e}`);
  }
  return sql;
}


/** #4733 보관 표에 주인을 적는다(표 설명) — 앱 지우기 · 관리자 비우기가 이름이 아니라 이 기록으로 가린다(archive-meta.ts).
 *  COMMENT 는 자리표시자를 못 받아 글자를 직접 넣는다(escapeLiteral — 따옴표 · 역슬래시를 겹친다). */
async function commentArchive(c: Q, archive: string, name: string, r: ArchiveRecord): Promise<void> {
  await c.query(`COMMENT ON TABLE ${qi(archive)}.${qi(name)} IS ${pg.escapeLiteral(archiveComment(r))}`);
}

/**
 * 있던 표의 칸을 선언에 맞춘다(#4224 칸 추가 · #4483 이름·변환·지우기). 규칙:
 *   · renamed_from — 옛 이름의 칸이 있고 새 이름이 없으면 이름만 바꾼다(값·인덱스·제약이 따라간다)
 *   · drop_columns — 값이 하나라도 있으면 (tenant_id, id, 값)을 보관 스키마의 새 표로 옮긴 뒤 지운다(사람이 쓴 값을 말없이 지우지 않는다)
 *   · 선언에 있고 표에 없는 칸 → ADD COLUMN(기본값이 있으면 함께 — 있던 행이 그 값을 받는다)
 *   · 타입이 다르면 → 값을 하나도 잃지 않을 때만 바꾼다: 새 형으로 바꿨다 되돌린 값이 원래와 다른 행이 0개여야 한다
 *     (텍스트 '01' → 정수는 '1' 로 돌아와 잃는다 · 0.123 → numeric(10,2) 는 0.12 로 잃는다 · 바꿀 수 없는 값은 바꾸지 않는다)
 *   · 표에만 있고 선언에도 지울 목록에도 없는 칸 → 그대로 둔다(데이터 보존) — 대신 NOT NULL·기본값을 푼다(선언을 따라 쓰는
 *     INSERT 가 그 칸 때문에 깨지지 않게). 보고서 undeclared_columns 로 알린다 — 지우려면 drop_columns 에 적는다.
 */
async function syncColumns(c: Q, schema: string, physical: string, rel: string, spec: AppTableSpec, report: AppTableReport, guard: Guard, now: Date,
  surfaceTimeouts: boolean, owner: { appId: string; reason: ArchiveReason }): Promise<void> {
  let have = await columnsOf(c, rel);
  // 이름 바꾸기
  for (const col of spec.columns) {
    const from = col.renamed_from;
    if (!from || have.has(col.name) || !have.has(from)) continue;
    //  #4724 미룬 이름 바꾸기의 새 이름은 «대기 칸» — 지금 새로 만들면 공개 때 이름 바꾸기가 «새 이름이 이미 있다» 로 건너뛰어 값이 옛 칸에 남는다.
    if (guard.has(from)) { guard.defer(`이름 바꾸기 ${spec.table}.${from} → ${col.name}`); guard.pend(col.name); continue; }
    await c.query(`ALTER TABLE ${rel} RENAME COLUMN ${qi(from)} TO ${qi(col.name)}`);
    report.renamed_columns.push({ table: spec.table, from, to: col.name });
  }
  have = await columnsOf(c, rel);
  // 지울 칸 — 값은 보관
  const declared = new Set(spec.columns.map((x) => x.name));
  for (const d of spec.drop_columns ?? []) {
    if (!have.has(d) || SYSTEM_COLUMNS.has(d) || declared.has(d)) continue;
    if (guard.has(d)) { guard.defer(`칸 지우기 ${spec.table}.${d}`); continue; }
    const rows = Number((await c.query(`SELECT count(*)::bigint AS n FROM ${rel} WHERE ${qi(d)} IS NOT NULL`)).rows[0]?.n ?? 0);
    let archivedAs: string | null = null;
    if (rows > 0) {
      const archive = archiveSchemaName(schema);
      const name = columnArchiveName(physical, d, now);
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${qi(archive)}`);
      await c.query(`CREATE TABLE ${qi(archive)}.${qi(name)} AS SELECT tenant_id, id, ${qi(d)} AS value FROM ${rel} WHERE ${qi(d)} IS NOT NULL`);
      //  #4733 주인 기록 — 이름은 잘리고 해시가 붙어 어느 앱 것인지 못 가릴 수 있다(앱 지우기 · 관리자 비우기가 이 기록으로 가린다).
      await commentArchive(c, archive, name, { app_id: owner.appId, table: spec.table, column: d, rows, at: now.toISOString(), reason: owner.reason });
      archivedAs = `${archive}.${name}`;
    }
    //  references.column 으로 이 칸을 가리키던 외래키(다른 표 · lvfk_)는 칸의 유일 키에 기대므로 먼저 뗀다 — 아직 선언돼 있으면
    //   외래키 단계가 다시 건다(그때 가리킬 칸이 없으면 선언 검사가 이미 400 으로 막았다). 사람이 만든 외래키면 지우기가 실패해 알린다.
    const deps = (await c.query(
      `SELECT n.nspname, cl.relname, con.conname FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE con.confrelid = to_regclass($1) AND con.contype = 'f' AND starts_with(con.conname, $2)
          AND (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname = $3) = ANY (con.confkey)`,
      [rel, APP_FK_PREFIX, d])).rows;
    for (const fk of deps) await c.query(`ALTER TABLE ${qi(String(fk.nspname))}.${qi(String(fk.relname))} DROP CONSTRAINT ${qi(String(fk.conname))}`);
    await c.query(`ALTER TABLE ${rel} DROP COLUMN ${qi(d)}`);
    report.dropped_columns.push({ table: spec.table, column: d, rows, archived_as: archivedAs });
  }
  have = await columnsOf(c, rel);
  // 늘어난 칸 — 기본값·NOT NULL 을 함께 걸어 있던 행이 그 값을 받는다(NOT NULL 은 기본값이 있을 때만 여기서)
  for (const col of spec.columns) {
    if (have.has(col.name) || guard.pending(col.name)) continue;
    const ty = parseColumnType(col.type);
    const def = await defaultSql(c, col);
    await c.query(`ALTER TABLE ${rel} ADD COLUMN IF NOT EXISTS ${qi(col.name)} ${ty.sql}${def ? ` DEFAULT ${def}` : ""}${def && col.not_null ? " NOT NULL" : ""}`);
    report.added_columns.push({ table: spec.table, column: col.name, type: col.type });
  }
  have = await columnsOf(c, rel);
  // 타입 — 값을 잃지 않을 때만
  for (const col of spec.columns) {
    const ty = parseColumnType(col.type);
    const cur = have.get(col.name);
    if (!cur || cur.type === ty.canonical) continue;
    if (guard.has(col.name)) { guard.defer(`형 바꾸기 ${spec.table}.${col.name} (${cur.type} → ${ty.canonical})`); guard.pend(col.name); continue; }
    const lossy = await lossyRows(c, rel, col.name, cur.type, ty.sql, surfaceTimeouts);
    if (lossy !== 0) {
      report.type_mismatches.push({
        table: spec.table, column: col.name, declared: col.type, actual: cur.type,
        reason: lossy === null ? `${ty.sql} 로 바꿀 수 없는 값이 있습니다` : `바꾸면 값 ${lossy}개가 달라집니다`,
      });
      continue;
    }
    //  기본값과 그 칸을 쓰는 라이블리 검사(lvck_)는 잠시 뗐다가 규칙 동기화가 새 형으로 다시 건다 — 옛 형을 전제로 한 것(기본값
    //  리터럴 · length(code) > 0 같은 식)이 새 형에서 안 돌아 변환이 실패하지 않게(격리 리뷰 재현: text → bigint 에서 42883).
    if (cur.default !== null) await c.query(`ALTER TABLE ${rel} ALTER COLUMN ${qi(col.name)} DROP DEFAULT`);
    const deps = (await c.query(
      `SELECT DISTINCT con.conname FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
        WHERE con.conrelid = to_regclass($1) AND con.contype = 'c' AND starts_with(con.conname, $2) AND a.attname = $3`,
      [rel, APP_CHECK_PREFIX, col.name])).rows;
    for (const d of deps) await c.query(`ALTER TABLE ${rel} DROP CONSTRAINT ${qi(String(d.conname))}`);
    await c.query(`ALTER TABLE ${rel} ALTER COLUMN ${qi(col.name)} TYPE ${ty.sql} USING ${qi(col.name)}::${ty.sql}`);
    report.converted_columns.push({ table: spec.table, column: col.name, from: cur.type, to: ty.canonical });
  }
  // 선언에 없는 칸 — 지우지 않고 제약만 푼다
  have = await columnsOf(c, rel);
  for (const [name, st] of have) {
    if (SYSTEM_COLUMNS.has(name) || declared.has(name)) continue;
    if (st.notNull) await c.query(`ALTER TABLE ${rel} ALTER COLUMN ${qi(name)} DROP NOT NULL`);
    //  #4724 지키는 칸의 기본값은 남긴다 — 다른 판의 INSERT 가 그 칸을 빼고 쓰며 기본값에 기댄다.
    if (st.default !== null && !guard.has(name)) await c.query(`ALTER TABLE ${rel} ALTER COLUMN ${qi(name)} DROP DEFAULT`);
    report.undeclared_columns.push({ table: spec.table, column: name });
  }
}

/** 새 형으로 바꿨다 되돌렸을 때 값이 달라지는 행 수. 바꿀 수 없는 값이 있으면(캐스트 오류) null. 트랜잭션은 SAVEPOINT 로 지킨다. */
async function lossyRows(c: Q, rel: string, column: string, from: string, to: string, surfaceTimeouts = false): Promise<number | null> {
  await c.query("SAVEPOINT lv_conv");
  try {
    const r = await c.query(
      `SELECT count(*)::bigint AS n FROM ${rel} WHERE ${qi(column)} IS NOT NULL
          AND ((${qi(column)}::${to})::${from}) IS DISTINCT FROM ${qi(column)}`);
    await c.query("RELEASE SAVEPOINT lv_conv");
    return Number(r.rows[0]?.n ?? 0);
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT lv_conv");
    //  #4732 상한에 걸려 다 못 센 것을 «못 바꾸는 값이 있다» 로 말하지 않는다(공개 미리 보기 — 짧은 상한). 설치 · 공개는 종전처럼.
    if (surfaceTimeouts && isLimitError(err)) throw err;
    return null;
  }
}

/** 이 표에 걸릴 검사(라이블리 이름 → 식) — 칸 check · enum 값 목록 · 표 checks. 식은 검사기를 지난 것만. */
async function desiredChecks(schema: string, physical: string, spec: AppTableSpec): Promise<Map<string, { expr: string; column?: string }>> {
  const out = new Map<string, { expr: string; column?: string }>();
  const plain = [...spec.columns.map((c) => c.check), ...(spec.checks ?? [])].filter((x): x is string => typeof x === "string");
  const enums = spec.columns.filter((c) => Array.isArray(c.values) && c.values.length);
  if (!plain.length && !enums.length) return out;
  await ensureAppSqlParser();
  const cols = ["id", "created_at", ...spec.columns.map((c) => c.name)];
  for (const col of spec.columns) {
    if (col.check !== undefined) {
      const expr = checkExpressionSync(col.check, cols);
      out.set(appConstraintName(APP_CHECK_PREFIX, schema, physical, "c", col.name, expr), { expr, column: col.name });
    }
  }
  for (const ck of spec.checks ?? []) {
    const expr = checkExpressionSync(ck, cols);
    out.set(appConstraintName(APP_CHECK_PREFIX, schema, physical, "t", expr), { expr });
  }
  for (const col of enums) {
    //  값 목록은 따옴표를 붙여 넣는다 — 표준 문자열(standard_conforming_strings=on)에서 ' 만 두 번 쓰면 된다. 검사기를 한 번 더 지난다.
    const list = col.values!.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
    const expr = checkExpressionSync(`${col.name} IN (${list})`, cols);
    out.set(appConstraintName(APP_CHECK_PREFIX, schema, physical, "e", col.name, expr), { expr, column: col.name });
  }
  return out;
}

/** NOT NULL · 기본값 · 검사(라이블리가 만든 lvck_ 만)를 선언에 맞춘다. 있던 행이 새 규칙에 어긋나면 몇 행인지 세어 409. */
async function syncColumnRules(c: Q, schema: string, physical: string, rel: string, spec: AppTableSpec, checks: Map<string, { expr: string; column?: string }>, report: AppTableReport, guard: Guard = NO_GUARD): Promise<void> {
  const t = spec.table;
  // 검사 — 빠진 것부터 지운다(뒤의 기본값·NOT NULL 이 옛 검사에 걸리지 않게)
  const haveRows = (await c.query(
    `SELECT con.conname, array(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)) AS cols
       FROM pg_constraint con WHERE con.conrelid = to_regclass($1) AND con.contype = 'c' AND starts_with(con.conname, $2)`,
    [rel, APP_CHECK_PREFIX])).rows as Array<{ conname: string; cols: string[] | null }>;
  const haveChecks = new Set(haveRows.map((r) => String(r.conname)));
  for (const h of haveRows) {
    if (checks.has(h.conname)) continue;
    //  #4724 공유 표는 옛 검사를 걷지 않는다 — 새 검사는 아래에서 미뤄지고 영영 오지 않으므로, 걷으면 검사 없는 표가 된다.
    //   공개 판이 아직 쓰는 칸인데 이 선언에 없는 칸(이름 바꾸기 · 지우기를 미뤘거나 선언에서 뺀 칸)의 검사도 칸과 함께 공개할 때 걷는다.
    if (guard.shared || keptColumn(guard, spec, h.cols ?? [])) continue;
    await c.query(`ALTER TABLE ${rel} DROP CONSTRAINT ${qi(h.conname)}`);
    report.constraints.push({ table: t, kind: "check", action: "removed" });
  }
  let have = await columnsOf(c, rel);
  for (const col of spec.columns) {
    const cur = have.get(col.name);
    if (!cur) continue;
    if (guard.has(col.name)) { await guardedColumnRules(c, schema, rel, t, col, cur, report, guard); continue; }
    //  #4724 공개 판이 쓰는 표(guard.any)의 새 칸 — 공개 판의 코드는 이 칸을 몰라 빼고 넣는다. 그 INSERT 가 깨지지 않게
    //   «값이 꼭 있어야 하는데 기본값이 없는» 상태로 만드는 일(기본값 없는 not_null 더하기 · not_null 칸의 기본값 빼기)은 공개할 때로 미룬다.
    const omitted = guard.any;
    // 기본값 — 같으면 걸지 않는다(sameDefault — 진짜 표는 잠그지 않고 견준다). effDefault = 이번 맞추기 뒤의 기본값(미루면 그대로).
    const def = await defaultSql(c, col);
    let effDefault = cur.default;
    if (def !== null) {
      if (await sameDefault(c, schema, cur.type, def, cur.default)) {
        // 그대로
      } else if (omitted && (await defaultBreaksRules(c, rel, col.name, def))) {
        //  #4724 다른 판의 코드가 빼고 넣는 칸에 이미 unique · 외래키 · 검사가 걸려 있으면, 기본값을 걸면 그 코드의 INSERT 가 같은 값을 넣어
        //   겹치거나 · 가리킬 행이 없거나 · 검사에 걸린다 — 공개할 때(격리 리뷰: 규칙을 먼저 걸고 기본값을 다음 저장에서 더하는 순서).
        guard.defer(`기본값 ${cur.default === null ? "더하기" : "바꾸기"} ${t}.${col.name}`);
      } else {
        await c.query(`ALTER TABLE ${rel} ALTER COLUMN ${qi(col.name)} SET DEFAULT ${def}`);
        report.constraints.push({ table: t, column: col.name, kind: "default", action: cur.default === null ? "added" : "changed" });
        effDefault = def;
      }
    } else if (cur.default !== null && omitted && (cur.notNull || col.not_null)) {
      guard.defer(`기본값 빼기 ${t}.${col.name}`);
    } else if (cur.default !== null) {
      await c.query(`ALTER TABLE ${rel} ALTER COLUMN ${qi(col.name)} DROP DEFAULT`);
      report.constraints.push({ table: t, column: col.name, kind: "default", action: "removed" });
      effDefault = null;
    }
    // NOT NULL
    if (col.not_null && !cur.notNull && omitted && effDefault === null) {
      guard.defer(`not_null 더하기 ${t}.${col.name}`);
    } else if (col.not_null && !cur.notNull) {
      const nulls = Number((await c.query(`SELECT count(*)::bigint AS n FROM ${rel} WHERE ${qi(col.name)} IS NULL`)).rows[0]?.n ?? 0);
      if (nulls > 0) {
        throw new HttpError(409, `'${t}.${col.name}' 에 값이 없는(NULL) 행이 ${nulls}개 있어 not_null 을 걸 수 없습니다 — 그 행을 채우거나(UPDATE ${t} SET ${col.name} = … WHERE ${col.name} IS NULL) default 를 함께 선언하세요`);
      }
      await c.query(`ALTER TABLE ${rel} ALTER COLUMN ${qi(col.name)} SET NOT NULL`);
      report.constraints.push({ table: t, column: col.name, kind: "not_null", action: "added" });
    } else if (!col.not_null && cur.notNull) {
      await c.query(`ALTER TABLE ${rel} ALTER COLUMN ${qi(col.name)} DROP NOT NULL`);
      report.constraints.push({ table: t, column: col.name, kind: "not_null", action: "removed" });
    }
  }
  // 검사 — 새로 걸 것. 있던 행이 어긋나면 몇 행인지 센다(NULL 은 검사를 통과한다 — Postgres 규칙과 같게 셈).
  have = await columnsOf(c, rel);
  for (const [name, ck] of checks) {
    if (haveChecks.has(name)) continue;
    //  #4724 다른 판의 코드가 쓰는 표엔 새 검사를 걸지 않는다(공개할 때) — 그 코드가 넣는 값(새 칸이면 빈 값 · 기본값)을 검사가 막을 수 있고,
    //   미룬 칸(이름 바꾸기의 새 이름 · 형 바꾸기를 미룬 칸)을 쓰는 식은 지금 표에서 돌지도 않는다.
    if (guard.any) { guard.defer(`검사 더하기 ${t}${ck.column ? `.${ck.column}` : ""}: ${ck.expr}`); continue; }
    let bad: number;
    try { bad = Number((await c.query(`SELECT count(*)::bigint AS n FROM ${rel} WHERE NOT (${ck.expr}\n)`)).rows[0]?.n ?? 0); }
    catch (e) {
      //  식이 이 표의 칸 형과 맞지 않는다(형을 바꾸며 검사는 그대로 둔 경우 — length(code) 인데 code 가 bigint). 고칠 사람이 할 일이라 400.
      const code = String((e as { code?: string })?.code ?? "");
      if (code.startsWith("42") || code.startsWith("22")) {
        throw new HttpError(400, `'${t}' 의 검사 «${ck.expr}» 를 이 표에서 실행할 수 없습니다(${(e as Error).message}) — 칸의 형에 맞게 검사 식을 고치세요`, { cause: e });
      }
      throw e;
    }
    if (bad > 0) {
      throw new HttpError(409, `'${t}' 에 검사 «${ck.expr}» 에 맞지 않는 행이 ${bad}개 있습니다 — 그 행을 고치거나 검사를 바꾼 뒤 다시 설치하세요`);
    }
    await c.query(`ALTER TABLE ${rel} ADD CONSTRAINT ${qi(name)} CHECK (${ck.expr}\n)`);
    report.constraints.push({ table: t, ...(ck.column ? { column: ck.column } : {}), kind: "check", action: "added" });
  }
}

/**
 * #4724 지키는 칸의 기본값·NOT NULL — 풀기(not_null 빼기)만 한다. 기본값은 더하기·바꾸기·빼기 모두 미룬다(다른 판의 INSERT 가 이 칸을
 *  빼고 넣으면 받는 값이라 그 코드가 남기는 데이터가 바뀐다). 기본값이 «바뀌는지» 는 DB 가 정규화한 식으로 견줘야 해서 걸어 보고 되돌린다.
 *  형 바꾸기를 미룬 칸은 새 형의 기본값을 옛 형 칸에 걸 수도 견줄 수도 없다 — 형과 함께 공개할 때 맞춘다.
 */
async function guardedColumnRules(c: Q, schema: string, rel: string, t: string, col: StoreColumn, cur: ColumnState, report: AppTableReport, guard: Guard): Promise<void> {
  const def = await defaultSql(c, col);                       // 미룬 칸이라도 선언한 기본값이 그 형에 맞는지는 지금 본다(400)
  if (guard.pending(col.name)) {
    if (def !== null || cur.default !== null) guard.defer(`기본값 맞추기 ${t}.${col.name}(형 바꾸기와 함께)`);
  } else if (def !== null && cur.default === null) {
    guard.defer(`기본값 더하기 ${t}.${col.name}`);
  } else if (def === null && cur.default !== null) {
    guard.defer(`기본값 빼기 ${t}.${col.name}`);
  } else if (def !== null && cur.default !== null && !(await sameDefault(c, schema, cur.type, def, cur.default))) {
    guard.defer(`기본값 바꾸기 ${t}.${col.name}`);
  }
  if (col.not_null && !cur.notNull) guard.defer(`not_null 더하기 ${t}.${col.name}`);
  else if (!col.not_null && cur.notNull) {
    await c.query(`ALTER TABLE ${rel} ALTER COLUMN ${qi(col.name)} DROP NOT NULL`);
    report.constraints.push({ table: t, column: col.name, kind: "not_null", action: "removed" });
  }
}

/** #4724 지키는 칸인데 이 선언에 없는 칸(이름 바꾸기 · 지우기를 미뤘거나 선언에서만 뺀 칸)이 끼었나 — 공개 판의 코드가 아직 쓰므로 그 칸에
 *  걸린 검사 · 외래키 · 인덱스는 칸과 함께 공개할 때 걷는다(격리 리뷰 — 초안 기간에 무결성 · 조회 속도가 약해졌다). 시스템 칸은 보지 않는다. */
function keptColumn(guard: Guard, spec: AppTableSpec, cols: readonly string[]): boolean {
  return cols.some((x) => !SYSTEM_COLUMNS.has(x) && guard.has(x) && !spec.columns.some((col) => col.name === x));
}

/** 이 칸에 기본값 def 를 걸면 칸을 빼고 넣는 INSERT 가 지금 걸린 규칙에 걸릴 수 있나 — 외래키 · 검사가 있거나, unique 인데 같은 값을 거듭 넣는 기본값. */
async function defaultBreaksRules(c: Q, rel: string, col: string, def: string): Promise<boolean> {
  const r = (await c.query(
    `SELECT EXISTS (SELECT 1 FROM pg_index x JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY (x.indkey)
                     WHERE x.indrelid = to_regclass($1) AND x.indisunique AND NOT x.indisprimary AND a.attname = $2) AS uniq,
            EXISTS (SELECT 1 FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
                     WHERE con.conrelid = to_regclass($1) AND con.contype IN ('f', 'c') AND a.attname = $2) AS other`, [rel, col])).rows[0];
  return r?.other === true || (r?.uniq === true && !UNIQUE_SAFE_DEFAULTS.has(def));
}

/**
 * 이 기본값 식(def)을 지금 칸(형 type · 기본값 cur)에 걸면 지금과 같은가 — DB 가 정규화한 꼴로 견준다('5'::integer 는 5 로 저장된다).
 *  #4724 진짜 표에 걸어 보면(되돌려도) 거는 순간 표를 통째로 잠그려고 그 표를 읽는 사람 뒤에 줄을 선다 — 같은 스키마에 칸 하나짜리
 *  시험 표를 만들어 읽고 되돌린다(진짜 표는 건드리지 않는다). 글자가 같으면 시험 표도 만들지 않는다.
 */
async function sameDefault(c: Q, schema: string, type: string, def: string, cur: string | null): Promise<boolean> {
  if (cur === null) return false;
  if (def === cur) return true;
  const probe = `lv_defprobe_${randomBytes(6).toString("hex")}`;
  await c.query("SAVEPOINT lv_defprobe");
  try {
    await c.query(`CREATE TABLE ${qi(schema)}.${qi(probe)} (v ${type} DEFAULT ${def})`);
    const r = await c.query("SELECT pg_get_expr(d.adbin, d.adrelid) AS e FROM pg_attrdef d WHERE d.adrelid = to_regclass($1)", [`${qi(schema)}.${qi(probe)}`]);
    return (r.rows[0]?.e ?? null) === cur;
  } finally {
    await c.query("ROLLBACK TO SAVEPOINT lv_defprobe");
  }
}

/**
 * 외래키(#4483) — 같은 앱 표의 id 를 가리킨다. 표가 워크스페이스·테넌트를 가로지르지 않게 **(tenant_id, 칸) → (tenant_id, id)**
 *  복합 키로 건다(외래키 확인은 행 격리 정책을 건너뛰므로 tenant_id 를 키에 넣어야 다른 테넌트 행을 가리킬 수 없다).
 *  on_delete 'set null' 은 그 칸만 NULL 로(PG 15+ `SET NULL (칸)` — tenant_id 는 NOT NULL 이라 통째로 NULL 이 될 수 없다).
 *  라이블리가 만든 것(lvfk_)만 맞추고 지운다. 이미 가리킬 곳이 없는 행이 있으면 몇 행인지 세어 409.
 */
async function syncForeignKeys(c: Q, appId: string, schema: string, spec: AppTableSpec, report: AppTableReport, guard: Guard = NO_GUARD): Promise<void> {
  const physical = physicalTableName(appId, spec.table);
  const rel = `${qi(schema)}.${qi(physical)}`;
  const want = new Map<string, { col: string; target: string; onDelete: string; tcol: string }>();
  for (const col of spec.columns) {
    if (!col.references) continue;
    const target = physicalTableName(appId, col.references.table);
    const onDelete = col.references.on_delete ?? "no action";
    //  가리킬 칸(references.column) — 없으면 id. id 면 이름이 종전 그대로(이미 깔린 앱의 외래키를 다시 만들지 않게).
    const tcol = col.references.column === undefined || col.references.column === "id" ? "id" : assertIdent("column", col.references.column);
    want.set(appConstraintName(APP_FK_PREFIX, schema, physical, col.name, target, onDelete, ...(tcol === "id" ? [] : [tcol])), { col: col.name, target, onDelete, tcol });
  }
  const haveRows = (await c.query(
    `SELECT con.conname, array(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)) AS cols
       FROM pg_constraint con WHERE con.conrelid = to_regclass($1) AND con.contype = 'f' AND starts_with(con.conname, $2)`,
    [rel, APP_FK_PREFIX])).rows as Array<{ conname: string; cols: string[] | null }>;
  const have = new Set(haveRows.map((r) => String(r.conname)));
  for (const h of haveRows) {
    const name = h.conname;
    if (want.has(name)) continue;
    //  #4724 공유 표는 옛 외래키를 걷지 않는다 — 새 외래키는 미뤄지고 영영 오지 않으므로. 공개 판이 아직 쓰는 칸(이 선언에 없는 지키는 칸)의
    //   외래키도 칸과 함께 공개할 때 걷는다.
    if (guard.shared || keptColumn(guard, spec, h.cols ?? [])) continue;
    await c.query(`ALTER TABLE ${rel} DROP CONSTRAINT ${qi(name)}`);
    report.constraints.push({ table: spec.table, kind: "foreign_key", action: "removed" });
  }
  if ([...want.values()].some((w) => w.onDelete === "set null") && (await serverVersionNum(c)) < 150000) {
    throw new HttpError(400, "이 DB(Postgres 15 미만)는 on_delete 'set null' 을 지원하지 않습니다 — cascade · restrict · no action 을 쓰세요");
  }
  //  #4724 다른 판의 코드가 빼고 넣는 새 칸에 기본값이 있으면 그 값이 가리킬 행이 없을 수 있다 — 그 칸의 외래키는 공개할 때.
  const cols = guard.any ? await columnsOf(c, rel) : null;
  for (const [name, w] of want) {
    if (have.has(name)) continue;
    //  #4724 지키는 칸에 외래키를 새로 걸면 다른 판의 쓰기(가리킬 행이 없는 값)가 깨질 수 있다 — 미룬다(떼기는 위에서 그대로 한다).
    //   미룬 칸(이름 바꾸기의 새 이름 — 아직 없다 · 형 바꾸기를 미룬 칸)의 외래키도 칸과 함께 공개할 때.
    if (guard.has(w.col) || guard.pending(w.col) || (cols?.get(w.col)?.default ?? null) !== null) { guard.defer(`외래키 더하기 ${spec.table}.${w.col}`); continue; }
    const trel = `${qi(schema)}.${qi(w.target)}`;
    if (await ensureTenantIdKey(c, schema, w.target, w.tcol)) {
      report.constraints.push({ table: spec.columns.find((x) => x.name === w.col)?.references?.table ?? w.target, kind: "unique", action: "added" });
    }
    const orphans = Number((await c.query(
      `SELECT count(*)::bigint AS n FROM ${rel} r WHERE r.${qi(w.col)} IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${trel} t WHERE t.tenant_id = r.tenant_id AND t.${qi(w.tcol)} = r.${qi(w.col)})`)).rows[0]?.n ?? 0);
    if (orphans > 0) {
      const tTable = spec.columns.find((x) => x.name === w.col)?.references?.table;
      throw new HttpError(409, `'${spec.table}.${w.col}' 에 '${tTable}' 에 없는 ${w.tcol} 를 가리키는 행이 ${orphans}개 있어 외래키를 걸 수 없습니다 — 그 행을 고치거나 지운 뒤 다시 설치하세요`);
    }
    const action = w.onDelete === "set null" ? `SET NULL (${qi(w.col)})` : w.onDelete.toUpperCase();
    await c.query(`ALTER TABLE ${rel} ADD CONSTRAINT ${qi(name)} FOREIGN KEY (tenant_id, ${qi(w.col)}) REFERENCES ${trel} (tenant_id, ${qi(w.tcol)}) ON DELETE ${action}`);
    report.constraints.push({ table: spec.table, column: w.col, kind: "foreign_key", action: "added" });
  }
}

// ── 앱 자유 SQL 역할(#4226) ─────────────────────────────────────────────────────────────
//  자유 SQL 의 진짜 경계. (DB, 스키마, 앱)마다 로그인하지 않는 역할 하나를 두고, 그 앱의 테이블에만 권한을 준다.
//  런타임 연결(매니지드 lvly_app · 단일 모드는 풀 주인)이 트랜잭션 안에서 `SET LOCAL ROLE` 로 내려가 SQL 을 돌린다 —
//  그 SQL 은 같은 워크스페이스의 다른 앱 테이블도, 라이블리 본체 테이블도 권한 거부를 받는다(파서가 뚫려도).
//  만드는 자격: DDL 연결에 CREATEROLE 이 있어야 한다(매니지드 lvly_appddl — lvly-cloud control/src/appddl.ts).
//   PG16+ 에서 CREATEROLE 은 **자기가 만든 역할만** 고치고 지울 수 있다 — 넓어지는 권한은 «앱 역할을 만든다» 하나다.
//  런타임 연결은 그 역할로 SET 만 할 수 있고 권한을 물려받지 않는다(INHERIT FALSE) — 런타임 권한이 늘지 않는다.

/** 이 역할이 쓰는 행 격리 정책 이름 — 런타임 역할의 tenant_isolation 과 같은 식을 이 역할에 건다. */
const APP_SQL_POLICY = "app_sql";

async function serverVersionNum(db: Q): Promise<number> {
  return Number((await db.query("SELECT current_setting('server_version_num')::int AS v")).rows[0]?.v ?? 0);
}

const isDup = (e: unknown): boolean => (e as { code?: unknown })?.code === "42710"; // duplicate_object — 동시 설치 경합

/** 표의 id 시퀀스(#5172) — PG 가 인용해 돌려준 이름 그대로(없으면 null). rel = 인용한 «스키마.표». */
async function idSequenceOf(db: Q, rel: string): Promise<string | null> {
  return ((await db.query("SELECT pg_get_serial_sequence($1, 'id') AS s", [rel])).rows[0]?.s as string | null | undefined) ?? null;
}

/**
 * DDL 연결 위에서 앱 역할을 보장한다(멱등). tables = 선언 이름. 반환 = 역할 이름. 실패는 던진다(호출부가 비치명/503 을 고른다).
 */
export async function ensureAppSqlRoleOn(db: Q, schema: string, appId: string, tables: string[]): Promise<string> {
  const dbName = String((await db.query("SELECT current_database() AS d")).rows[0]?.d ?? "");
  const role = appSqlRoleName(dbName, schema, appId);
  if (!(await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rows.length) {
    try { await db.query(`CREATE ROLE ${qi(role)} NOLOGIN NOINHERIT`); }
    catch (e) { if (!isDup(e)) throw e; }
  }
  // 런타임 연결이 이 역할로 내려갈 수 있게. 슈퍼유저는 멤버십 없이도 된다.
  const runtime = (await resolveAppRole(db)) ?? String((await db.query("SELECT current_user AS u")).rows[0]?.u ?? "");
  const sup = (await db.query("SELECT rolsuper FROM pg_roles WHERE rolname=$1", [runtime])).rows[0]?.rolsuper === true;
  if (!sup) {
    const v16 = (await serverVersionNum(db)) >= 160000;
    const member = (await db.query(
      `SELECT 1 FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
        WHERE r.rolname = $1 AND m.rolname = $2${v16 ? " AND am.set_option" : ""}`, [role, runtime])).rows.length > 0;
    if (!member) await db.query(`GRANT ${qi(role)} TO ${qi(runtime)}${v16 ? " WITH INHERIT FALSE, SET TRUE" : ""}`);
  }
  const usage = (await db.query("SELECT has_schema_privilege($1, $2, 'USAGE') AS ok", [role, schema])).rows[0]?.ok === true;
  if (!usage) await db.query(`GRANT USAGE ON SCHEMA ${qi(schema)} TO ${qi(role)}`);
  for (const t of tables) {
    const physical = physicalTableName(appId, t);
    const rel = `${qi(schema)}.${qi(physical)}`;
    await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${rel} TO ${qi(role)}`);
    //  #5172 원래 id 로 넣은 문장 뒤 실행기가 이 역할로 그 표의 id 시퀀스를 앞으로만 맞춘다(app-sql-exec idResyncSql) —
    //   자기 표 시퀀스의 SELECT(위치 읽기)·UPDATE(옮기기)만. UPDATE 는 DB 에서 nextval·setval 을 허락한다 — 앱 SQL 이 그 함수를
    //   부르는 것은 검사기가 막는다(자기 표 시퀀스뿐이라 다른 앱·워크스페이스로는 닿지 않는다). USAGE 는 주지 않는다.
    //   못 주면 원래 id 로 넣기만 403 으로 막히게 두고(맞춤이 권한 거부로 문장을 취소한다) 이 앱의 다른 SQL 은 살린다.
    const seq = await idSequenceOf(db, rel);
    if (seq) {
      try { await db.query(`GRANT SELECT, UPDATE ON SEQUENCE ${seq} TO ${qi(role)}`); }
      catch (err) { logger.warn({ err, appId, schema, table: t }, "앱 역할에 id 시퀀스 권한을 주지 못했습니다 — 원래 id 로 넣기만 403 이 됩니다"); }
    }
    const has = (await db.query(
      `SELECT 1 FROM pg_policies WHERE schemaname=$1 AND tablename=$2 AND policyname=$3`, [schema, physical, APP_SQL_POLICY])).rows.length > 0;
    if (!has) {
      try {
        await db.query(`CREATE POLICY ${qi(APP_SQL_POLICY)} ON ${rel} FOR ALL TO ${qi(role)} USING (tenant_id = ${STRICT}) WITH CHECK (tenant_id = ${STRICT})`);
      } catch (e) { if (!isDup(e)) throw e; }
    }
  }
  return role;
}

/** 앱 역할 보장(연결 포함) — 자유 SQL 실행 직전 지연 보장에 쓴다. 실패는 원인을 담은 503. */
export async function ensureAppSqlRole(appId: string, tables: string[], schema: string): Promise<string> {
  try { return await withOwnerConn((db) => ensureAppSqlRoleOn(db, schema, appId, tables)); }
  catch (e) {
    throw new HttpError(503, `앱 '${appId}' 의 SQL 전용 DB 역할을 준비하지 못했습니다 — ${(e as Error)?.message ?? e}. `
      + "store_query·store_insert 같은 정해진 도구는 그대로 쓸 수 있습니다", { cause: e });
  }
}

/** 앱 제거 때 — 역할을 지운다(테이블은 이미 지워졌다). 비치명. */
async function dropAppSqlRoleOn(db: Q, schema: string, appId: string): Promise<void> {
  const dbName = String((await db.query("SELECT current_database() AS d")).rows[0]?.d ?? "");
  const role = appSqlRoleName(dbName, schema, appId);
  if (!(await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rows.length) return;
  //  역할을 가리키는 것이 하나라도 남으면 DROP ROLE 이 «objects depend on it» 으로 실패한다 — 정책·권한을 먼저 걷는다.
  const pols = (await db.query(
    `SELECT schemaname, tablename, policyname FROM pg_policies WHERE $1::name = ANY(roles)`, [role])).rows;
  for (const p of pols) {
    await db.query(`DROP POLICY IF EXISTS ${qi(String(p.policyname))} ON ${qi(String(p.schemaname))}.${qi(String(p.tablename))}`);
  }
  await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${qi(schema)} FROM ${qi(role)}`).catch(() => undefined);
  await db.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${qi(schema)} FROM ${qi(role)}`).catch(() => undefined);   // #5172 id 시퀀스 권한
  const archive = archiveSchemaName(schema);
  if ((await db.query("SELECT to_regnamespace($1) AS n", [archive])).rows[0]?.n) {
    await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${qi(archive)} FROM ${qi(role)}`).catch(() => undefined);
    await db.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${qi(archive)} FROM ${qi(role)}`).catch(() => undefined);
  }
  await db.query(`REVOKE ALL ON SCHEMA ${qi(schema)} FROM ${qi(role)}`).catch(() => undefined);
  await db.query(`DROP ROLE IF EXISTS ${qi(role)}`);
}

async function tableExists(db: Q, schema: string, physical: string): Promise<boolean> {
  const r = await db.query("SELECT to_regclass($1) AS r", [`${qi(schema)}.${qi(physical)}`]);
  return r.rows[0]?.r != null;
}

/** 매니페스트(저장된 것 포함)의 data.tables → 표 명세. 모양이 어긋나도 던지지 않는다(#4724 — 공개하기 · 가게 · 설치가 같이 쓴다). */
export function tableSpecsOf(manifest: unknown): AppTableSpec[] {
  const t = (manifest as { data?: { tables?: unknown } } | null)?.data?.tables;
  if (!Array.isArray(t)) return [];
  return t.filter((x): x is Record<string, unknown> => !!x && typeof x === "object").map((x) => ({
    table: String(x.name ?? ""),
    columns: (Array.isArray(x.columns) ? x.columns : []) as StoreColumn[],
    indexes: (Array.isArray(x.indexes) ? x.indexes : []) as StoreIndex[],
    checks: Array.isArray(x.checks) ? (x.checks as unknown[]).map(String) : [],
    drop_columns: Array.isArray(x.drop_columns) ? (x.drop_columns as unknown[]).map(String) : [],
  })).filter((x) => x.table);
}

/** 공개 판(또는 다른 판)이 선언한 칸 — 표 → 칸 이름들(#4724 지켜야 할 칸). 시스템 칸(id · created_at · tenant_id)도 넣는다. */
export function declaredColumnsOf(manifest: unknown): Map<string, Set<string>> {
  return new Map(tableSpecsOf(manifest).map((t) => [t.table, new Set(["tenant_id", "id", "created_at", ...t.columns.map((c) => String(c.name))])]));
}

export interface EnsureAppTablesOpts {
  /** 테이블이 사는 스키마(기본 `app`). 호출부가 appSchemaFor(builtin) 로 고른다. */
  schema?: string;
  /** true 면 하나라도 실패하면 던진다(설치 verb·지연 복구). false(기본)는 종전처럼 경고만 — 기본 앱 시딩이 쓴다. */
  strict?: boolean;
  /** 넘기면 만든 테이블·더한 칸·타입 불일치를 채운다(#4224 — 설치 응답용). */
  report?: AppTableReport;
  /** #4226 공유 테이블(기본 앱)이면 참 — 선언 인덱스 앞에 tenant_id 를 두고 기본 키도 (tenant_id, id).
   *  거짓(설치 앱 — 워크스페이스마다 따로인 표)이면 기본 키 (id)(#4483 — `GROUP BY id` 뒤 다른 칸 고르기가 되게). */
  tenantScopedIndexes?: boolean;
  /** #4226 자유 SQL 역할도 보장한다(워크스페이스가 설치한 앱). 실패해도 던지지 않고 report.sql_role 에 적는다 —
   *  역할을 못 만드는 DB(CREATEROLE 없음)에서도 설치와 store_* 는 그대로 돈다. store_sql 만 503 으로 막힌다. */
  sqlRole?: boolean;
  /** #4724 지켜야 할 칸(ProtectColumns 주석). 공유 표(tenantScopedIndexes)는 무엇을 주든 "existing" — 지금 있는 칸 전부를 지킨다. */
  protect?: ProtectColumns;
  /** #4724 표 전부를 한 트랜잭션으로 — 하나라도 실패하면 어느 표도 바뀌지 않는다. 공개할 때 미뤄 둔 변경을 적용하는 쪽이 쓴다
   *  (표마다 따로 커밋하면 앞 표만 바뀐 채 공개가 멈춰, 아직 공개 판인 옛 코드가 그 표에서 깨진다). 표를 새로 만드는 설치는 쓰지 않는다. */
  atomic?: boolean;
  /** #4724 걸어 보기만 하고 늘 되돌린다(atomic 과 같은 한 트랜잭션) — report 에 «했을 일» 이 남는다. 기본 앱 저장의 공유 표 판정과
   *  #4732 공개 미리 보기가 쓴다. 아래 #4732 옵션(상한 · 실패 모으기)은 공개 미리 보기용이다 — 상한은 한 트랜잭션에서 맞춘 표의 잠금을
   *  끝까지 쥐는 시간을 줄이려는 것이다. */
  dryRun?: boolean;
  /** #4732 잠금을 기다리는 상한(ms) — 기본 ddlLockMs(). DDL 이 잠금을 기다리는 동안 그 표를 쓰려는 사람이 뒤에 줄을 선다. */
  lockMs?: number;
  /** #4732 문장 하나의 상한(ms) — 기본 5분. 큰 표를 다시 쓰는 동안 그 표가 잠긴다. */
  statementMs?: number;
  /** #4732 이 시각(epoch ms)이 지나면 남은 표는 맞추지 않고 «시간 초과»(57014)로 실패에 싣는다 — 문장 상한 × 문장 수로 길어지지 않게. */
  deadlineAt?: number;
  /** #4732 잠금 · 시간 상한에 걸린 것을 삼키지 않고 실패로 올린다(형 바꾸기의 값 확인 · 옛 기본 키 좁히기) — 삼키면 «못 바꿈» 처럼 실제와 다른 계획이 된다. */
  surfaceTimeouts?: boolean;
  /** #4732 넘기면 표마다 실패를 모은다 — 공개 미리 보기가 «데이터가 새 규칙에 어긋남»(막힘)과 «잠금 · 시간 초과»(다 못 봄)를 가른다. */
  failures?: AppTableFailure[];
  /** #4733 이번 설치가 보관 표를 만들면 그 표 설명에 적을 까닭 — 공개하며 미룬 칸 지우기를 적용하면 "publish"(기본 "install"). */
  archiveReason?: ArchiveReason;
}

/** #4732 표 하나의 실패 — status 는 HttpError 의 상태(데이터가 어긋나면 4xx), code 는 Postgres 오류 코드(잠금 대기 초과 55P03 · 시간 초과 57014). */
export interface AppTableFailure {
  table: string;
  status: number | null;
  code: string | null;
  error: string;
  /** 외래키가 가리키는 표가 먼저 실패해서 이 표도 못 한 경우 — 그 표들. */
  after?: string[];
}

/**
 * 앱의 선언 테이블 전부 생성(설치·지연 복구). 반환 = 보장된 물리명들.
 *  ⚠ strict 가 아니면 실패를 **경고로만** 남긴다 — 종전 동작이고, 이 조용함이 매니지드에서 앱 데이터 층이 한 번도
 *   동작하지 않은 채 «설치 성공» 으로 남은 원인이었다(#4223). 사람이 요청한 설치는 strict 로 부른다.
 */
export async function ensureAppTables(appId: string, tables: AppTableSpec[], opts: EnsureAppTablesOpts = {}): Promise<string[]> {
  if (!tables.length) return [];
  const schema = opts.schema ?? SHARED_APP_SCHEMA;
  const failures: string[] = [];
  //  #4483 — 실패한 까닭이 «있던 데이터가 새 선언에 어긋난다»(4xx — 고칠 사람이 할 일)뿐이면 그 상태로 돌려준다. 그 밖은 503.
  let clientStatus: number | null = null;
  const fail = (table: string, err: unknown, after?: string[]): void => {
    //  실패를 모아 가는 걸어 보기(공개 미리 보기)의 실패는 판정 결과다 — 경고로 남기지 않는다(«막힘» 을 찾을 때마다 경고가 쌓이지 않게).
    //   모으지 않는 걸어 보기(기본 앱 판정)는 경고가 유일한 흔적이라 그대로 둔다.
    if (opts.dryRun && opts.failures) logger.debug({ err, appId, schema, table }, "앱 데이터 테이블 걸어 보기 실패");
    else logger.warn({ err, appId, schema, table }, opts.strict ? "앱 데이터 테이블 생성 실패" : "앱 데이터 테이블 생성 실패(비치명)");
    failures.push(`${table}: ${(err as Error)?.message ?? err}`);
    const st = (err as { status?: number })?.status;
    clientStatus = typeof st === "number" && st >= 400 && st < 500 && (clientStatus === null || clientStatus === st) ? st : -1;
    const code = (err as { code?: unknown })?.code;
    opts.failures?.push({ table, status: typeof st === "number" ? st : null, code: typeof code === "string" ? code : null,
      error: (err as Error)?.message ?? String(err), ...(after?.length ? { after } : {}) });
  };
  //  공유 표는 늘 "existing" — 초안이 걸린 기본 앱의 지연 복구가 공개 판의 칸(Map)을 줘도 다른 워크스페이스의 칸까지 지킨다(격리 리뷰).
  const protect: ProtectColumns | undefined = opts.tenantScopedIndexes ? "existing" : opts.protect;
  const shared = protect === "existing";
  const oneTx = !!(opts.atomic || opts.dryRun);
  //  한 트랜잭션이면 끝까지 성공했을 때만 보고서에 싣는다(되돌린 일을 «했다» 로 적지 않게) — 걸어 보기(dryRun)는 «했을 일» 을 싣는다.
  const report = oneTx && opts.report ? emptyTableReport() : opts.report;
  const out = await withOwnerConn(async (db0) => {
    const body = async (db: Q): Promise<string[]> => {
      //  #4732 한 트랜잭션이면 표마다의 저장점 밖 문장(스키마 준비 · 기본 권한)도 같은 상한으로 — 첫 표의 SET LOCAL 전에 오래 줄을 서지 않게.
      if (oneTx && (opts.lockMs != null || opts.statementMs != null)) {
        await db.query(`SET LOCAL lock_timeout = '${msOr(opts.lockMs, ddlLockMs())}ms'`);
        await db.query(`SET LOCAL statement_timeout = '${msOr(opts.statementMs, DDL_STATEMENT_MS)}ms'`);
      }
      const done: string[] = [];
      const ok = new Set<string>();
      //  표마다 지킬 칸 — "existing" 이면 손대기 **전에** 있던 칸(이번에 늘린 칸은 아무 코드도 아직 안 쓴다 · 그 칸의 외래키는 건다).
      const guarded = new Map<string, ReadonlySet<string>>();
      for (const t of tables) {
        const set = shared ? new Set((await columnsOf(db, `${qi(schema)}.${qi(physicalTableName(appId, t.table))}`)).keys()) : protect?.get(t.table);
        if (set?.size) guarded.set(t.table, set);
      }
      //  표마다 «대기 칸»(미룬 이름 바꾸기의 새 이름 · 미룬 형 바꾸기의 칸) — 표 보장과 그 뒤 외래키 단계가 나눠 쓴다.
      const pendingOf = new Map<string, Set<string>>(tables.map((t) => [t.table, new Set<string>()]));
      //  #4732 전체 시간 상한 — 지나면 남은 표는 맞추지 않는다(이미 맞춘 표의 잠금은 트랜잭션 끝까지 쥐므로 더 늘리지 않는다).
      const late = (): boolean => opts.deadlineAt != null && Date.now() > opts.deadlineAt;
      const lateErr = (): Error => Object.assign(new Error("시간 상한을 넘어 이 표는 보지 못했습니다"), { code: "57014" });
      for (const t of tables) {
        if (late()) { fail(t.table, lateErr()); continue; }
        try {
          done.push(await createAppTable(db, appId, t, schema, report, { tenantScopedIndexes: opts.tenantScopedIndexes, protect: guarded.get(t.table), shared, pending: pendingOf.get(t.table),
            lockMs: opts.lockMs, statementMs: opts.statementMs, surfaceTimeouts: opts.surfaceTimeouts, archiveReason: opts.archiveReason }));
          ok.add(t.table);
        } catch (err) { fail(t.table, err); }
      }
      // 외래키 — 가리키는 표까지 다 생긴 뒤에. 가리키는 표가 실패했으면 그 표의 외래키도 건너뛴다(실패로 남는다).
      for (const t of tables) {
        if (!ok.has(t.table) || !t.columns.some((c) => c.references)) continue;
        if (late()) { fail(t.table, lateErr()); continue; }
        const missing = [...new Set(t.columns.filter((c) => c.references && !ok.has(c.references.table)).map((c) => c.references!.table))];
        if (missing.length) { fail(t.table, new Error(`외래키가 가리키는 표(${missing.join(", ")})를 만들지 못했습니다`), missing); continue; }
        const local = emptyTableReport();
        try {
          await inTx(db, async (c) => {
            await c.query(`SET LOCAL lock_timeout = '${msOr(opts.lockMs, ddlLockMs())}ms'`);
            await c.query(`SET LOCAL statement_timeout = '${msOr(opts.statementMs, DDL_STATEMENT_MS)}ms'`);
            await syncForeignKeys(c, appId, schema, t, local, guardFor(t.table, guarded.get(t.table), local, { shared, pending: pendingOf.get(t.table) }));
          });
          if (report) { report.constraints.push(...local.constraints); report.deferred.push(...local.deferred); }
        } catch (err) { fail(t.table, err); }
      }
      return done;
    };
    const done = oneTx ? await inOneTx(db0, body, () => !opts.dryRun && !failures.length) : await body(db0);
    if (oneTx && opts.report && report && (opts.dryRun || !failures.length)) mergeReport(opts.report, report);
    if (opts.sqlRole && !opts.dryRun && !failures.length) {
      try {
        await ensureAppSqlRoleOn(db0, schema, appId, tables.map((t) => t.table));
        if (opts.report) opts.report.sql_role = { ok: true };
      } catch (err) {
        logger.warn({ err, appId, schema }, "앱 SQL 역할 준비 실패(비치명 — store_sql 만 막힌다)");
        if (opts.report) opts.report.sql_role = { ok: false, error: (err as Error)?.message ?? String(err) };
      }
    }
    return done;
  });
  if (opts.strict && failures.length) {
    const st = clientStatus !== null && clientStatus > 0 ? clientStatus : 503;
    const kept = oneTx ? "어느 표도 바뀌지 않았습니다" : "그 표는 바뀌지 않았습니다";
    throw new HttpError(st, `앱 '${appId}' 의 데이터 테이블을 ${st === 503 ? "만들지 못했습니다" : `새 선언으로 바꾸지 못했습니다(${kept})`} — ${failures.join(" / ")}`);
  }
  return out;
}

/** 앱 제거 시 그 앱의 데이터 테이블 전부 DROP(소유자). 워크스페이스별 스키마면 그 워크스페이스 것만 지워진다.
 *  #4226 — 자유 SQL 역할도 함께 지운다(테이블이 없어지면 그 역할이 할 일이 없다). */
export async function dropAppTables(appId: string, tables: string[], schema: string = SHARED_APP_SCHEMA): Promise<void> {
  if (!tables.length) return;
  await withOwnerConn(async (db) => {
    for (const t of tables) {
      try { await db.query(`DROP TABLE IF EXISTS ${qi(schema)}.${qi(physicalTableName(appId, t))} CASCADE`); }
      catch (err) { logger.warn({ err, appId, schema, table: t }, "앱 데이터 테이블 DROP 실패(비치명)"); }
    }
    try { await dropAppSqlRoleOn(db, schema, appId); }
    catch (err) { logger.warn({ err, appId, schema }, "앱 SQL 역할 삭제 실패(비치명)"); }
  });
}

// ── 매니페스트에서 빠진 테이블 정리(#4224) ────────────────────────────────────────────
//  종전엔 빠진 테이블을 그대로 두었다(deploy.ts data_table = 저널만). 빌더가 이름을 바꿔 가며 고칠 때마다 옛 테이블이
//  쌓인다. 규칙: **비었으면 지우고, 데이터가 있으면 보관 스키마로 옮긴 뒤 알린다** — 사람이 쓴 기록을 말없이 지우지 않는다.

export interface DroppedTablesReport {
  dropped: string[];                                                          // 비어 있어 지운 테이블(선언 이름)
  archived: Array<{ table: string; rows: number; archived_as: string }>;     // 데이터가 있어 보관한 테이블(«스키마.이름»)
  failed: Array<{ table: string; error: string }>;                            // 정리하지 못해 그 자리에 남은 테이블
}

/**
 * 이 연결이 그 테이블의 **모든 행**을 볼 수 있나 — 비었는지 판정의 전제. FORCE RLS 라 소유자도 정책을 탄다.
 *  owner_all 정책이 지금 role 에 걸려 있거나(설치 때 만든 role 그대로) 슈퍼유저·BYPASSRLS 면 참.
 *  아니면 «0행» 이 «비었다» 가 아니라 «못 본다» 일 수 있다 → 호출부는 지우지 않고 보관한다(데이터를 지키는 쪽으로 기운다).
 */
async function seesAllRows(db: Q, schema: string, physical: string): Promise<boolean> {
  const bypass = (await db.query("SELECT rolsuper OR rolbypassrls AS b FROM pg_roles WHERE rolname = current_user")).rows[0]?.b === true;
  if (bypass) return true;
  const r = await db.query(
    `SELECT 1 FROM pg_policies
      WHERE schemaname = $1 AND tablename = $2 AND policyname = 'owner_all'
        AND (current_user::name = ANY(roles) OR 'public'::name = ANY(roles))`, [schema, physical]);
  return r.rows.length > 0;
}

/**
 * 테이블과 함께 스키마를 옮겨 가는 인덱스(PK 포함)·소유 시퀀스(identity)의 이름을 보관 이름으로 바꾼다.
 *  안 바꾸면 같은 테이블을 두 번째 보관할 때 보관 스키마에서 `<물리명>_pkey`·`<물리명>_id_seq` 가 겹쳐 실패한다(PG 실측).
 */
async function renameCompanions(c: Q, schema: string, table: string, physical: string, now: Date): Promise<void> {
  const rel = `${qi(schema)}.${qi(table)}`;
  const idx = (await c.query(
    `SELECT i.relname AS name, x.indisprimary AS pk FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
      WHERE x.indrelid = to_regclass($1) ORDER BY i.relname`, [rel])).rows;
  let n = 0;
  for (const r of idx) {
    const to = archivedTableName(physical, now, r.pk ? "_pkey" : `_idx${++n}`);
    await c.query(`ALTER INDEX ${qi(schema)}.${qi(String(r.name))} RENAME TO ${qi(to)}`);
  }
  const seqs = (await c.query(
    `SELECT s.relname AS name FROM pg_depend d JOIN pg_class s ON s.oid = d.objid
      WHERE d.refobjid = to_regclass($1) AND d.classid = 'pg_class'::regclass AND s.relkind = 'S' ORDER BY s.relname`, [rel])).rows;
  let m = 0;
  for (const r of seqs) {
    const to = archivedTableName(physical, now, `_seq${++m}`);
    await c.query(`ALTER SEQUENCE ${qi(schema)}.${qi(String(r.name))} RENAME TO ${qi(to)}`);
  }
}

/** #4724 지금 바깥 한 트랜잭션을 돌고 있는 연결 — 그 위의 inTx 는 BEGIN 대신 저장점을 쓴다. */
const outerTx = new WeakSet<object>();

/** 소유자 연결 위에서 트랜잭션 하나(단일 모드의 itemsPool 이면 체크아웃해서). */
export async function inTx<T>(db: Q, fn: (c: Q) => Promise<T>): Promise<T> {
  //  #4724 바깥 한 트랜잭션(inOneTx) 안이면 저장점으로 — 이 표의 일만 되돌리고, 커밋은 바깥이 한다.
  if (outerTx.has(db)) {
    await db.query("SAVEPOINT lv_tx");
    try { const out = await fn(db); await db.query("RELEASE SAVEPOINT lv_tx"); return out; }
    catch (e) { await db.query("ROLLBACK TO SAVEPOINT lv_tx").catch(() => { /* noop */ }); throw e; }
  }
  if (db === itemsPool) return withTx((c) => fn(c));
  await db.query("BEGIN");
  try { const out = await fn(db); await db.query("COMMIT"); return out; }
  catch (e) { await db.query("ROLLBACK").catch(() => { /* noop */ }); throw e; }
}

/**
 * #4724 fn 의 일을 한 트랜잭션으로 — fn 안의 inTx 는 저장점이 된다. 끝에 commit() 이 참이면 커밋, 아니면 전부 되돌린다
 *  (fn 이 표마다 실패를 모아 계속 가도, 하나라도 실패했으면 어느 표도 바뀌지 않게). 공용 풀이면 연결 하나를 빌려 쓴다.
 */
async function inOneTx<T>(db: Q, fn: (c: Q) => Promise<T>, commit: () => boolean): Promise<T> {
  //  풀이면(공용 풀이든 아니든) 연결 하나를 빌린다 — 풀에 바로 BEGIN 을 보내면 BEGIN 과 뒤 문장이 다른 연결로 갈 수 있다.
  const client: pg.PoolClient | pg.Client = db instanceof pg.Pool ? await db.connect() : db;
  try {
    await client.query("BEGIN");
    outerTx.add(client);
    try {
      const out = await fn(client);
      await client.query(commit() ? "COMMIT" : "ROLLBACK");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => { /* noop */ });
      throw e;
    } finally {
      outerTx.delete(client);
    }
  } finally {
    if (client !== db) (client as pg.PoolClient).release();
  }
}

/** 빠진 표 하나를 어떻게 하나 — 모든 행을 볼 수 있고 0행이면 지우고(drop), 아니면 보관한다. 정리(잠근 뒤)와 공개 미리 보기(잠그지 않고)가 같이 쓴다. */
async function droppedTableFate(c: Q, schema: string, physical: string): Promise<{ rows: number; drop: boolean }> {
  const rows = Number((await c.query(`SELECT count(*)::bigint AS n FROM ${qi(schema)}.${qi(physical)}`)).rows[0]?.n ?? 0);
  return { rows, drop: rows === 0 && (await seesAllRows(c, schema, physical)) };
}

/** #4732 공개 뒤 정리될 표 하나 — 새로 공개하는 판에 없는 옛 표(비었으면 지움 · 행이 있으면 보관). */
export interface GoneTablePlan { table: string; rows: number; action: "drop" | "archive" }

/**
 * #4732 정리하면 어떻게 될지만 본다(cleanupDroppedTables 와 같은 판단 · 표를 잠그지 않고 아무것도 바꾸지 않는다) — 공개 미리 보기가 쓴다.
 *  물리 표가 없으면 할 일이 없어 싣지 않는다. 센 뒤 정리 전에 행이 늘 수 있다(그때는 정리가 보관 쪽으로 간다 — 데이터를 지키는 쪽).
 *  limits — 세는 동안의 잠금 대기 · 문장 상한(미리 보기는 짧게). 넘으면 그 오류를 던진다(호출부가 «다 못 봄» 으로 접는다).
 */
export async function planDroppedTables(appId: string, tables: string[], schema: string = SHARED_APP_SCHEMA,
  limits: { lockMs?: number; statementMs?: number } = {}): Promise<GoneTablePlan[]> {
  if (!tables.length) return [];
  return withOwnerConn((db) => inTx(db, async (c) => {
    await c.query(`SET LOCAL lock_timeout = '${msOr(limits.lockMs, ddlLockMs())}ms'`);
    await c.query(`SET LOCAL statement_timeout = '${msOr(limits.statementMs, DDL_STATEMENT_MS)}ms'`);
    const out: GoneTablePlan[] = [];
    for (const table of tables) {
      const physical = physicalTableName(appId, table);
      if (!(await tableExists(c, schema, physical))) continue;
      const { rows, drop } = await droppedTableFate(c, schema, physical);
      out.push({ table, rows, action: drop ? "drop" : "archive" });
    }
    return out;
  }));
}

/**
 * 매니페스트에서 빠진 테이블을 정리한다. 테이블마다 한 트랜잭션 — 하나가 실패해도 나머지는 계속하고 failed 로 알린다.
 *  · 물리 테이블이 없으면 할 일 없음(설치 때 생성이 실패했던 앱 등).
 *  · 모든 행을 볼 수 있고 0행 → DROP.
 *  · 행이 있거나 다 볼 수 있는지 모르면 → `<스키마>_archive` 로 옮긴다(이름에 시각을 붙여 겹치지 않게). 런타임 role 권한은 걷는다 —
 *    보관된 테이블은 앱이 더는 못 읽고 쓰지만 관리자(DB)는 되살릴 수 있다. #4733 표 설명에 주인(앱 · 표 · 행 수 · 시각 · 까닭)을 적는다 —
 *    관리자 목록 · 비우기(app_archives · app_archive_clear)와 앱 제거가 이 기록으로 그 앱의 보관 표를 가린다.
 */
export async function cleanupDroppedTables(appId: string, tables: string[], schema: string = SHARED_APP_SCHEMA, now: Date = new Date(),
  reason: ArchiveReason = "install"): Promise<DroppedTablesReport> {
  const out: DroppedTablesReport = { dropped: [], archived: [], failed: [] };
  if (!tables.length) return out;
  const archive = archiveSchemaName(schema);
  await withOwnerConn(async (db) => {
    const appRole = await resolveAppRole(db);
    // #4226 — 자유 SQL 역할도 보관된 테이블을 못 읽어야 한다(있을 때만).
    const dbName = String((await db.query("SELECT current_database() AS d")).rows[0]?.d ?? "");
    const sqlRole = appSqlRoleName(dbName, schema, appId);
    const hasSqlRole = (await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [sqlRole])).rows.length > 0;
    for (const table of tables) {
      try {
        const physical = physicalTableName(appId, table);
        if (!(await tableExists(db, schema, physical))) continue;
        const rel = `${qi(schema)}.${qi(physical)}`;
        const done = await inTx(db, async (c) => {
          // 세기 전에 잠근다 — 센 뒤 DROP 전에 누가 한 행을 커밋하면 그 행이 «빈 테이블» 과 함께 사라진다.
          //  잠금 뒤의 쓰기는 이 트랜잭션이 끝날 때까지 기다리고, 그때 테이블이 없으면 오류로 드러난다(조용히 잃지 않는다).
          await c.query(`LOCK TABLE ${rel} IN ACCESS EXCLUSIVE MODE`);
          const { rows, drop } = await droppedTableFate(c, schema, physical);
          if (drop) {
            await c.query(`DROP TABLE ${rel}`);
            return { kind: "dropped" as const };
          }
          const target = archivedTableName(physical, now);
          await c.query(`CREATE SCHEMA IF NOT EXISTS ${qi(archive)}`);
          await c.query(`ALTER TABLE ${rel} RENAME TO ${qi(target)}`);
          await renameCompanions(c, schema, target, physical, now);
          await c.query(`ALTER TABLE ${qi(schema)}.${qi(target)} SET SCHEMA ${qi(archive)}`);
          await commentArchive(c, archive, target, { app_id: appId, table, column: null, rows, at: now.toISOString(), reason });   // #4733 주인 기록
          if (appRole) await c.query(`REVOKE ALL ON ${qi(archive)}.${qi(target)} FROM ${qi(appRole)}`);
          if (hasSqlRole) {
            await c.query(`REVOKE ALL ON ${qi(archive)}.${qi(target)} FROM ${qi(sqlRole)}`);
            //  #5172 id 시퀀스 권한도 걷는다(표와 함께 보관 스키마로 옮겨 왔다) — 남아 있으면 앱을 지울 때 역할을 DROP 할 수 없다(PG 실측).
            const seq = await idSequenceOf(c, `${qi(archive)}.${qi(target)}`);
            if (seq) await c.query(`REVOKE ALL ON SEQUENCE ${seq} FROM ${qi(sqlRole)}`);
            //  정책도 걷는다 — 정책이 역할을 가리키고 있으면 앱을 지울 때 그 역할을 DROP 할 수 없다(PG 실측).
            await c.query(`DROP POLICY IF EXISTS ${qi(APP_SQL_POLICY)} ON ${qi(archive)}.${qi(target)}`);
          }
          return { kind: "archived" as const, rows, archived_as: `${archive}.${target}` };
        });
        if (done.kind === "dropped") out.dropped.push(table);
        else out.archived.push({ table, rows: done.rows, archived_as: done.archived_as });
      } catch (err) {
        logger.warn({ err, appId, schema, table }, "매니페스트에서 빠진 앱 테이블 정리 실패 — 그 자리에 둔다");
        out.failed.push({ table, error: (err as Error)?.message ?? String(err) });
      }
    }
  });
  return out;
}

// ── 워크스페이스 퓨즈(#4224) ─────────────────────────────────────────────────────────
//  앱당 테이블 상한은 두지 않는다(계획 §7-6). 막으려는 건 규모가 아니라 **폭주**다 — 빌더가 고칠 때마다 테이블이 쌓이는
//  고장. 워크스페이스 스키마(+보관 스키마)의 테이블 수가 이 값을 넘게 되는 설치는 거절한다.
export const DEFAULT_APP_TABLE_FUSE = 500;
export function appTableFuse(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(String(env.LIVELY_APP_TABLE_FUSE ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_APP_TABLE_FUSE;
}

export interface FuseCheck { limit: number; current: number; archived: number; adding: number; ok: boolean }

/** 워크스페이스 스키마 · 보관 스키마의 표 수(퓨즈의 셈 — #4733 관리자 화면 · 비우기 응답도 이것을 보여 준다). */
export async function appTableCounts(schema: string = SHARED_APP_SCHEMA, limit: number = appTableFuse()): Promise<{ limit: number; current: number; archived: number }> {
  const count = async (s: string): Promise<number> => Number((await itemsPool.query(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p')`, [s])).rows[0]?.n ?? 0);
  return { limit, current: await count(schema), archived: await count(archiveSchemaName(schema)) };
}

/**
 * 이 설치 뒤 워크스페이스의 앱 테이블 수(상한 추정)가 퓨즈를 넘나. 셈 = 지금 워크스페이스 스키마 + 보관 스키마의 테이블 +
 *  이번에 **새로** 생길 테이블. 빠진 테이블 정리로 줄어들 몫은 빼지 않는다(보관은 그대로 세어지고, 넉넉한 쪽으로 판정한다).
 *  pg_class 는 누구나 읽는 카탈로그라 런타임 풀로 센다(DDL 자격 불요).
 */
export async function checkAppTableFuse(appId: string, tables: string[], schema: string = SHARED_APP_SCHEMA, limit: number = appTableFuse()): Promise<FuseCheck> {
  const { current, archived } = await appTableCounts(schema, limit);
  let adding = 0;
  for (const t of tables) {
    const r = await itemsPool.query("SELECT to_regclass($1) AS r", [`${qi(schema)}.${qi(physicalTableName(appId, t))}`]);
    if (r.rows[0]?.r == null) adding++;
  }
  return { limit, current, archived, adding, ok: current + archived + adding <= limit };
}

/** #4733 표 개수 한도 안내의 꼬리 — 보관 표도 한도에 세지만 앱을 고쳐서는 줄지 않는다. 관리자가 비울 수 있고, 앱을 지우면 그 앱 것은 함께 지워진다. */
export function archivedFuseHint(archived: number): string {
  return archived > 0
    ? ` 보관 표 ${archived}개는 관리자가 비울 수 있습니다(관리탭 ▸ 앱 보관 · app_archive_clear) — 앱을 지우면 그 앱의 보관 표도 함께 지워집니다.`
    : "";
}
