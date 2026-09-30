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
import { physicalTableName, columnDefs, resolveColumnType, assertIdent, appSchemaName, archiveSchemaName, archivedTableName, SHARED_APP_SCHEMA, appSqlRoleName, appIndexName, APP_INDEX_PREFIX, type StoreColumn, type StoreIndex } from "./store-ddl.js";
import { currentTenant } from "../org/tenant-context.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";

type Q = pg.Pool | pg.PoolClient | pg.Client;
// 늘 큰따옴표로 인용하므로 숫자로 시작해도 안전하다 — 숫자로 시작하는 앱 id(`3d-view` → `3d_view__x`)가 여기서 막히지 않게(#4224).
const qi = (n: string): string => { if (!/^[A-Za-z0-9_][A-Za-z0-9_$]*$/.test(n)) throw new Error(`unsafe ident: ${n}`); return `"${n}"`; };
const STRICT = "current_setting('app.tenant_id')::uuid";

export interface AppTableSpec { table: string; columns: StoreColumn[]; indexes?: StoreIndex[] }

/**
 * 소유자 커넥션으로 fn 실행 — 앱 DDL 의 자격 우선순위(#4223):
 *  ① LIVELY_APP_DDL_DATABASE_URL — 앱 스키마 생성·소유만 하는 최소 권한 role(매니지드: 공용 DB 의 lvly_appddl).
 *     중앙 게이트웨이는 런타임 role(lvly_app)로만 붙어 DDL 권한이 없다 — 이게 없으면 CREATE SCHEMA 가 권한 부족으로
 *     실패한다(실측 2026-09-22: 매니지드 공용 DB 에 app 스키마 자체가 없었다).
 *  ② LIVELY_OWNER_DATABASE_URL — registry 모드 부팅 자식 등 소유자 DSN.
 *  ③ 둘 다 없으면(단일 모드 = 풀이 소유자) itemsPool.
 */
export async function withOwnerConn<T>(fn: (db: Q) => Promise<T>): Promise<T> {
  const ddlDsn = (process.env.LIVELY_APP_DDL_DATABASE_URL || "").trim() || (process.env.LIVELY_OWNER_DATABASE_URL || "").trim();
  const same = !ddlDsn || ddlDsn === (process.env.ITEMS_DATABASE_URL || "").trim();
  if (same) return fn(itemsPool);
  const client = new pg.Client({ connectionString: ddlDsn });
  await client.connect();
  try { return await fn(client); } finally { await client.end().catch(() => { /* noop */ }); }
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
  type_mismatches: Array<{ table: string; column: string; declared: string; actual: string }>; // 타입이 달라도 바꾸지 않은 칸
  added_indexes: Array<{ table: string; columns: string[]; unique: boolean }>;  // #4226 새로 만든 선언 인덱스
  dropped_indexes: Array<{ table: string; index: string }>;                      // #4226 선언에서 빠져 지운 인덱스(라이블리가 만든 것만)
  /** #4226 자유 SQL 이 내려갈 앱 역할 — 만들었으면 ok, 못 만들었으면 그 까닭(설치는 계속된다 · store_sql 만 막힌다). */
  sql_role?: { ok: boolean; error?: string };
}
export const emptyTableReport = (): AppTableReport => ({ created: [], added_columns: [], type_mismatches: [], added_indexes: [], dropped_indexes: [] });

/** 물리 테이블 하나 생성 + RLS(멱등 — 존재하면 정책/GRANT 보강 + **빠진 컬럼만 ADD COLUMN**, #4224). 반환 = 물리 테이블명.
 *  컬럼 삭제·타입 변경은 하지 않는다 — 데이터를 지키는 쪽이 기본이다(타입이 다르면 report.type_mismatches 로 알린다).
 *  schema 기본값 `app` = 종전 동작(기본 앱·단일 테넌트). 워크스페이스가 설치한 앱은 호출부가 appSchemaFor 로 고른다. */
export async function createAppTable(db: Q, appId: string, spec: AppTableSpec, schema: string = SHARED_APP_SCHEMA, report?: AppTableReport, opts: { tenantScopedIndexes?: boolean } = {}): Promise<string> {
  const physical = physicalTableName(appId, spec.table);
  const cols = columnDefs(spec.columns);
  const owner = String((await db.query("SELECT current_user AS u")).rows[0]?.u ?? "");
  const appRole = await resolveAppRole(db);
  await ensureAppSchema(db, schema, appRole, owner);
  const rel = `${qi(schema)}.${qi(physical)}`;
  const existed = await tableExists(db, schema, physical);
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${rel} (
       tenant_id uuid NOT NULL DEFAULT ${TENANT_DEFAULT_EXPR},
       id bigint GENERATED ALWAYS AS IDENTITY,
       ${cols.join(",\n       ")},
       created_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (tenant_id, id)
     )`);
  if (!existed) report?.created.push(spec.table);
  else await addMissingColumns(db, schema, physical, rel, spec, report);
  await db.query(`ALTER TABLE ${rel} ENABLE ROW LEVEL SECURITY`);
  await db.query(`ALTER TABLE ${rel} FORCE ROW LEVEL SECURITY`);
  // CREATE POLICY 는 IF NOT EXISTS 미지원 → 기존 정책 조회 후 없는 것만.
  const have = new Set((await db.query(
    `SELECT policyname FROM pg_policies WHERE schemaname=$1 AND tablename=$2`, [schema, physical])).rows.map((r) => String(r.policyname)));
  if (appRole && !have.has("tenant_isolation"))
    await db.query(`CREATE POLICY ${qi("tenant_isolation")} ON ${rel} FOR ALL TO ${qi(appRole)} USING (tenant_id = ${STRICT}) WITH CHECK (tenant_id = ${STRICT})`);
  if (!have.has("owner_all"))
    await db.query(`CREATE POLICY ${qi("owner_all")} ON ${rel} FOR ALL TO ${qi(owner)} USING (true) WITH CHECK (true)`);
  if (appRole) await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${rel} TO ${qi(appRole)}`);
  await syncDeclaredIndexes(db, schema, physical, rel, spec, !!opts.tenantScopedIndexes, report);
  return physical;
}

/**
 * 선언 인덱스 맞추기(#4226) — 선언에 있고 없는 것은 만들고, 라이블리가 만든 것(lvix_ 접두) 중 선언에서 빠진 것은 지운다.
 *  사람·다른 경로가 만든 인덱스(PK 포함)는 건드리지 않는다. 인덱스는 데이터를 담지 않으므로 지워도 잃는 것이 없다.
 *  tenantScoped = 여러 워크스페이스가 나눠 쓰는 공유 테이블(기본 앱) — 인덱스 앞에 tenant_id 를 둔다(유일성도 워크스페이스 안에서).
 *   워크스페이스가 설치한 앱은 테이블이 워크스페이스마다 따로라 선언 그대로 만든다(`ON CONFLICT (email)` 이 그대로 맞는다).
 *  ⚠ unique 인덱스는 이미 겹친 값이 있으면 만들어지지 않는다 — 설치(strict)가 그 원인을 담아 실패한다.
 */
async function syncDeclaredIndexes(db: Q, schema: string, physical: string, rel: string, spec: AppTableSpec, tenantScoped: boolean, report?: AppTableReport): Promise<void> {
  const want = new Map<string, StoreIndex>();
  for (const ix of spec.indexes ?? []) {
    const cols = ix.columns.map((c) => (c === "id" || c === "created_at" ? c : assertIdent("column", c)));
    const norm = { columns: cols, unique: !!ix.unique };
    want.set(appIndexName(schema, physical, norm, tenantScoped), norm);
  }
  const have = new Set((await db.query(
    `SELECT i.relname AS name FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
      WHERE x.indrelid = to_regclass($1) AND starts_with(i.relname, $2)`,
    [`${qi(schema)}.${qi(physical)}`, APP_INDEX_PREFIX])).rows.map((r) => String(r.name)));
  for (const [name, ix] of want) {
    if (have.has(name)) continue;
    const cols = [...(tenantScoped ? ["tenant_id"] : []), ...ix.columns].map(qi).join(", ");
    await db.query(`CREATE ${ix.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${qi(name)} ON ${rel} (${cols})`);
    report?.added_indexes.push({ table: spec.table, columns: ix.columns, unique: !!ix.unique });
  }
  for (const name of have) {
    if (want.has(name)) continue;
    await db.query(`DROP INDEX IF EXISTS ${qi(schema)}.${qi(name)}`);
    report?.dropped_indexes.push({ table: spec.table, index: name });
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
  const archive = archiveSchemaName(schema);
  if ((await db.query("SELECT to_regnamespace($1) AS n", [archive])).rows[0]?.n) {
    await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${qi(archive)} FROM ${qi(role)}`).catch(() => undefined);
  }
  await db.query(`REVOKE ALL ON SCHEMA ${qi(schema)} FROM ${qi(role)}`).catch(() => undefined);
  await db.query(`DROP ROLE IF EXISTS ${qi(role)}`);
}

async function tableExists(db: Q, schema: string, physical: string): Promise<boolean> {
  const r = await db.query("SELECT to_regclass($1) AS r", [`${qi(schema)}.${qi(physical)}`]);
  return r.rows[0]?.r != null;
}

/**
 * 이미 있는 테이블에 매니페스트가 늘린 칸을 더한다(#4224). 종전엔 `CREATE TABLE IF NOT EXISTS` 뿐이라 빌더가 칸 하나를
 *  더해도 반영되지 않았다 — 반복 수정의 전제가 깨진 자리. 규칙:
 *   · 선언에 있고 테이블에 없는 칸 → ADD COLUMN(NULL 허용 · 기본값 없음 — 기존 행은 NULL 로 남는다)
 *   · 둘 다 있는데 타입이 다르면 → **바꾸지 않는다**(형변환이 값을 잃을 수 있다) · report 로만 알린다
 *   · 테이블에만 있는 칸 → 그대로 둔다(데이터 보존). 선언에서 뺀 칸이 다시 돌아와도 값이 살아 있다.
 */
async function addMissingColumns(db: Q, schema: string, physical: string, rel: string, spec: AppTableSpec, report?: AppTableReport): Promise<void> {
  const have = new Map<string, string>((await db.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
      WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
    [`${qi(schema)}.${qi(physical)}`])).rows.map((r) => [String(r.name), String(r.type)]));
  for (const c of spec.columns) {
    const name = assertIdent("column", c.name);
    const pgType = resolveColumnType(c.type);
    const actual = have.get(name);
    if (actual === undefined) {
      await db.query(`ALTER TABLE ${rel} ADD COLUMN IF NOT EXISTS ${qi(name)} ${pgType}`);
      report?.added_columns.push({ table: spec.table, column: name, type: c.type });
      continue;
    }
    // 선언 타입을 Postgres 가 부르는 이름으로 맞춰 비교한다(timestamptz ↔ timestamp with time zone).
    const canonical = String((await db.query("SELECT format_type($1::regtype, NULL) AS t", [pgType])).rows[0]?.t ?? pgType);
    if (canonical !== actual) report?.type_mismatches.push({ table: spec.table, column: name, declared: c.type, actual });
  }
}

export interface EnsureAppTablesOpts {
  /** 테이블이 사는 스키마(기본 `app`). 호출부가 appSchemaFor(builtin) 로 고른다. */
  schema?: string;
  /** true 면 하나라도 실패하면 던진다(설치 verb·지연 복구). false(기본)는 종전처럼 경고만 — 기본 앱 시딩이 쓴다. */
  strict?: boolean;
  /** 넘기면 만든 테이블·더한 칸·타입 불일치를 채운다(#4224 — 설치 응답용). */
  report?: AppTableReport;
  /** #4226 공유 테이블(기본 앱)이면 참 — 선언 인덱스 앞에 tenant_id 를 둔다. */
  tenantScopedIndexes?: boolean;
  /** #4226 자유 SQL 역할도 보장한다(워크스페이스가 설치한 앱). 실패해도 던지지 않고 report.sql_role 에 적는다 —
   *  역할을 못 만드는 DB(CREATEROLE 없음)에서도 설치와 store_* 는 그대로 돈다. store_sql 만 503 으로 막힌다. */
  sqlRole?: boolean;
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
  const out = await withOwnerConn(async (db) => {
    const done: string[] = [];
    for (const t of tables) {
      try { done.push(await createAppTable(db, appId, t, schema, opts.report, { tenantScopedIndexes: opts.tenantScopedIndexes })); }
      catch (err) {
        logger.warn({ err, appId, schema, table: t.table }, opts.strict ? "앱 데이터 테이블 생성 실패" : "앱 데이터 테이블 생성 실패(비치명)");
        failures.push(`${t.table}: ${(err as Error)?.message ?? err}`);
      }
    }
    if (opts.sqlRole && !failures.length) {
      try {
        await ensureAppSqlRoleOn(db, schema, appId, tables.map((t) => t.table));
        if (opts.report) opts.report.sql_role = { ok: true };
      } catch (err) {
        logger.warn({ err, appId, schema }, "앱 SQL 역할 준비 실패(비치명 — store_sql 만 막힌다)");
        if (opts.report) opts.report.sql_role = { ok: false, error: (err as Error)?.message ?? String(err) };
      }
    }
    return done;
  });
  if (opts.strict && failures.length) {
    throw new HttpError(503, `앱 '${appId}' 의 데이터 테이블을 만들지 못했습니다 — ${failures.join(" / ")}`);
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

/** 소유자 연결 위에서 트랜잭션 하나(단일 모드의 itemsPool 이면 체크아웃해서). */
export async function inTx<T>(db: Q, fn: (c: Q) => Promise<T>): Promise<T> {
  if (db === itemsPool) return withTx((c) => fn(c));
  await db.query("BEGIN");
  try { const out = await fn(db); await db.query("COMMIT"); return out; }
  catch (e) { await db.query("ROLLBACK").catch(() => { /* noop */ }); throw e; }
}

/**
 * 매니페스트에서 빠진 테이블을 정리한다. 테이블마다 한 트랜잭션 — 하나가 실패해도 나머지는 계속하고 failed 로 알린다.
 *  · 물리 테이블이 없으면 할 일 없음(설치 때 생성이 실패했던 앱 등).
 *  · 모든 행을 볼 수 있고 0행 → DROP.
 *  · 행이 있거나 다 볼 수 있는지 모르면 → `<스키마>_archive` 로 옮긴다(이름에 시각을 붙여 겹치지 않게). 런타임 role 권한은 걷는다 —
 *    보관된 테이블은 앱이 더는 못 읽고 쓰지만 관리자(DB)는 되살릴 수 있다.
 */
export async function cleanupDroppedTables(appId: string, tables: string[], schema: string = SHARED_APP_SCHEMA, now: Date = new Date()): Promise<DroppedTablesReport> {
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
          const rows = Number((await c.query(`SELECT count(*)::bigint AS n FROM ${rel}`)).rows[0]?.n ?? 0);
          if (rows === 0 && (await seesAllRows(c, schema, physical))) {
            await c.query(`DROP TABLE ${rel}`);
            return { kind: "dropped" as const };
          }
          const target = archivedTableName(physical, now);
          await c.query(`CREATE SCHEMA IF NOT EXISTS ${qi(archive)}`);
          await c.query(`ALTER TABLE ${rel} RENAME TO ${qi(target)}`);
          await renameCompanions(c, schema, target, physical, now);
          await c.query(`ALTER TABLE ${qi(schema)}.${qi(target)} SET SCHEMA ${qi(archive)}`);
          if (appRole) await c.query(`REVOKE ALL ON ${qi(archive)}.${qi(target)} FROM ${qi(appRole)}`);
          if (hasSqlRole) {
            await c.query(`REVOKE ALL ON ${qi(archive)}.${qi(target)} FROM ${qi(sqlRole)}`);
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

/**
 * 이 설치 뒤 워크스페이스의 앱 테이블 수(상한 추정)가 퓨즈를 넘나. 셈 = 지금 워크스페이스 스키마 + 보관 스키마의 테이블 +
 *  이번에 **새로** 생길 테이블. 빠진 테이블 정리로 줄어들 몫은 빼지 않는다(보관은 그대로 세어지고, 넉넉한 쪽으로 판정한다).
 *  pg_class 는 누구나 읽는 카탈로그라 런타임 풀로 센다(DDL 자격 불요).
 */
export async function checkAppTableFuse(appId: string, tables: string[], schema: string = SHARED_APP_SCHEMA, limit: number = appTableFuse()): Promise<FuseCheck> {
  const archive = archiveSchemaName(schema);
  const count = async (s: string): Promise<number> => Number((await itemsPool.query(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p')`, [s])).rows[0]?.n ?? 0);
  const current = await count(schema);
  const archived = await count(archive);
  let adding = 0;
  for (const t of tables) {
    const r = await itemsPool.query("SELECT to_regclass($1) AS r", [`${qi(schema)}.${qi(physicalTableName(appId, t))}`]);
    if (r.rows[0]?.r == null) adding++;
  }
  return { limit, current, archived, adding, ok: current + archived + adding <= limit };
}
