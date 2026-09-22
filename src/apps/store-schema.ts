// 앱 데이터 테이블(app 스키마) 생성 + RLS를 **한 몸으로** (#1780 D6, 설계 R2-2).
//  왜 자립인가: public 전용 자동화(ensureTenantColumn/ensureTenantPolicies, nspname='public')는 app 스키마를 못 잡고,
//  그 코어를 넓히면 폭발반경이 **전 테넌트 테이블**이라 위험하다. 대신 여기서 activate.ts 와 **동일 계약**을 app.* 한정으로
//  자립 적용한다: tenant_id(strict 정책 기준 컬럼) + ENABLE/FORCE RLS + tenant_isolation(TO appRole) + owner_all(TO owner)
//  + appRole GRANT. DDL 은 반드시 **소유자 커넥션**(withOwnerConn). 런타임 접근은 앱 role 풀(itemsPool)이 SET LOCAL
//  app.tenant_id 로 자동 격리(client.ts). 앱 격리(앱 X가 Y 테이블 못 건드림)는 store_* 핸들러가 물리명을
//  appId__table 로 강제해서 얻는다(store-ddl.physicalTableName) — RLS(테넌트) ⟂ 네임스페이스(앱), 둘 다 필요.
import pg from "pg";
import { itemsPool } from "../db/client.js";
import { appRoleName } from "../org/tenancy/activate.js";
import { SINGLE_TENANT_ID } from "../db/tenant-column.js";
import { physicalTableName, columnDefs, appSchemaName, SHARED_APP_SCHEMA, type StoreColumn } from "./store-ddl.js";
import { currentTenant } from "../org/tenant-context.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";

type Q = pg.Pool | pg.PoolClient | pg.Client;
const qi = (n: string): string => { if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(n)) throw new Error(`unsafe ident: ${n}`); return `"${n}"`; };
const STRICT = "current_setting('app.tenant_id')::uuid";

export interface AppTableSpec { table: string; columns: StoreColumn[] }

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

/** 물리 테이블 하나 생성 + RLS(멱등 — 존재하면 정책/GRANT 만 보강, 컬럼 변경은 v1 범위 밖). 반환 = 물리 테이블명.
 *  schema 기본값 `app` = 종전 동작(기본 앱·단일 테넌트). 워크스페이스가 설치한 앱은 호출부가 appSchemaFor 로 고른다. */
export async function createAppTable(db: Q, appId: string, spec: AppTableSpec, schema: string = SHARED_APP_SCHEMA): Promise<string> {
  const physical = physicalTableName(appId, spec.table);
  const cols = columnDefs(spec.columns);
  const owner = String((await db.query("SELECT current_user AS u")).rows[0]?.u ?? "");
  const appRole = await resolveAppRole(db);
  await ensureAppSchema(db, schema, appRole, owner);
  const rel = `${qi(schema)}.${qi(physical)}`;
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${rel} (
       tenant_id uuid NOT NULL DEFAULT COALESCE(current_setting('app.tenant_id', true), '${SINGLE_TENANT_ID}')::uuid,
       id bigint GENERATED ALWAYS AS IDENTITY,
       ${cols.join(",\n       ")},
       created_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (tenant_id, id)
     )`);
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
  return physical;
}

export interface EnsureAppTablesOpts {
  /** 테이블이 사는 스키마(기본 `app`). 호출부가 appSchemaFor(builtin) 로 고른다. */
  schema?: string;
  /** true 면 하나라도 실패하면 던진다(설치 verb·지연 복구). false(기본)는 종전처럼 경고만 — 기본 앱 시딩이 쓴다. */
  strict?: boolean;
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
      try { done.push(await createAppTable(db, appId, t, schema)); }
      catch (err) {
        logger.warn({ err, appId, schema, table: t.table }, opts.strict ? "앱 데이터 테이블 생성 실패" : "앱 데이터 테이블 생성 실패(비치명)");
        failures.push(`${t.table}: ${(err as Error)?.message ?? err}`);
      }
    }
    return done;
  });
  if (opts.strict && failures.length) {
    throw new HttpError(503, `앱 '${appId}' 의 데이터 테이블을 만들지 못했습니다 — ${failures.join(" / ")}`);
  }
  return out;
}

/** 앱 제거 시 그 앱의 데이터 테이블 전부 DROP(소유자). 워크스페이스별 스키마면 그 워크스페이스 것만 지워진다. */
export async function dropAppTables(appId: string, tables: string[], schema: string = SHARED_APP_SCHEMA): Promise<void> {
  if (!tables.length) return;
  await withOwnerConn(async (db) => {
    for (const t of tables) {
      try { await db.query(`DROP TABLE IF EXISTS ${qi(schema)}.${qi(physicalTableName(appId, t))} CASCADE`); }
      catch (err) { logger.warn({ err, appId, schema, table: t }, "앱 데이터 테이블 DROP 실패(비치명)"); }
    }
  });
}
