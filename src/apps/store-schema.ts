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
import { physicalTableName, columnDefs, type StoreColumn } from "./store-ddl.js";
import { logger } from "../log.js";

type Q = pg.Pool | pg.PoolClient | pg.Client;
const qi = (n: string): string => { if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(n)) throw new Error(`unsafe ident: ${n}`); return `"${n}"`; };
const STRICT = "current_setting('app.tenant_id')::uuid";

export interface AppTableSpec { table: string; columns: StoreColumn[] }

/** 소유자 커넥션으로 fn 실행. 별도 owner DSN(LIVELY_OWNER_DATABASE_URL)이 있으면 그 Client, 없으면(단일 모드=풀이 소유자) itemsPool. */
export async function withOwnerConn<T>(fn: (db: Q) => Promise<T>): Promise<T> {
  const ownerDsn = (process.env.LIVELY_OWNER_DATABASE_URL || "").trim();
  const same = !ownerDsn || ownerDsn === (process.env.ITEMS_DATABASE_URL || "").trim();
  if (same) return fn(itemsPool);
  const client = new pg.Client({ connectionString: ownerDsn });
  await client.connect();
  try { return await fn(client); } finally { await client.end().catch(() => { /* noop */ }); }
}

// 런타임에 앱 role 이 실재할 때만 그 role 대상 정책/GRANT 를 건다. 단일 모드(앱 role 없음)면 owner_all 만(격리 불요).
async function resolveAppRole(db: Q): Promise<string | null> {
  const dbName = String((await db.query("SELECT current_database() AS d")).rows[0]?.d ?? "");
  const role = appRoleName(dbName);
  const exists = (await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rows.length > 0;
  return exists ? role : null;
}

async function ensureAppSchema(db: Q, appRole: string | null, owner: string): Promise<void> {
  await db.query(`CREATE SCHEMA IF NOT EXISTS app`);
  if (appRole) {
    await db.query(`GRANT USAGE ON SCHEMA app TO ${qi(appRole)}`);
    await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(owner)} IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${qi(appRole)}`);
  }
}

/** 물리 테이블 하나 생성 + RLS(멱등 — 존재하면 정책/GRANT 만 보강, 컬럼 변경은 v1 범위 밖). 반환 = 물리 테이블명. */
export async function createAppTable(db: Q, appId: string, spec: AppTableSpec): Promise<string> {
  const physical = physicalTableName(appId, spec.table);
  const cols = columnDefs(spec.columns);
  const owner = String((await db.query("SELECT current_user AS u")).rows[0]?.u ?? "");
  const appRole = await resolveAppRole(db);
  await ensureAppSchema(db, appRole, owner);
  const rel = `app.${qi(physical)}`;
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
    `SELECT policyname FROM pg_policies WHERE schemaname='app' AND tablename=$1`, [physical])).rows.map((r) => String(r.policyname)));
  if (appRole && !have.has("tenant_isolation"))
    await db.query(`CREATE POLICY ${qi("tenant_isolation")} ON ${rel} FOR ALL TO ${qi(appRole)} USING (tenant_id = ${STRICT}) WITH CHECK (tenant_id = ${STRICT})`);
  if (!have.has("owner_all"))
    await db.query(`CREATE POLICY ${qi("owner_all")} ON ${rel} FOR ALL TO ${qi(owner)} USING (true) WITH CHECK (true)`);
  if (appRole) await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${rel} TO ${qi(appRole)}`);
  return physical;
}

/** 앱의 선언 테이블 전부 생성(설치·부팅 리컨사일러). best-effort per-table. 반환 = 보장된 물리명들. */
export async function ensureAppTables(appId: string, tables: AppTableSpec[]): Promise<string[]> {
  if (!tables.length) return [];
  return withOwnerConn(async (db) => {
    const out: string[] = [];
    for (const t of tables) {
      try { out.push(await createAppTable(db, appId, t)); }
      catch (err) { logger.warn({ err, appId, table: t.table }, "앱 데이터 테이블 생성 실패(비치명)"); }
    }
    return out;
  });
}

/** 앱 제거 시 그 앱의 데이터 테이블 전부 DROP(소유자). */
export async function dropAppTables(appId: string, tables: string[]): Promise<void> {
  if (!tables.length) return;
  await withOwnerConn(async (db) => {
    for (const t of tables) {
      try { await db.query(`DROP TABLE IF EXISTS app.${qi(physicalTableName(appId, t))} CASCADE`); }
      catch (err) { logger.warn({ err, appId, table: t }, "앱 데이터 테이블 DROP 실패(비치명)"); }
    }
  });
}
