// 앱 데이터 store_* (#1780 D6) — 앱이 **자기** 데이터 테이블(app.<appId>__<table>)을 읽고 쓴다.
//  이중 격리: ① 테넌트 = RLS(런타임 앱 role 풀 itemsPool 이 SET LOCAL app.tenant_id 로 자동 필터, store-schema 정책)
//   ② 앱 = 핸들러가 물리명을 **판정된 앱 id** 로 강제 → 앱 X 는 앱 Y 테이블을 이름조차 못 만든다.
//  누가 어느 앱으로 들어오나(resolveStoreApp):
//   · 앱 세션/UI(appUser.appId 있음) — 그 앱뿐. app_id 를 다른 값으로 주면 403(클라가 앱을 못 고른다).
//   · #4225 **앱이 붙은 일반 세션** — 요청이 말한 세션(x-lively-session)의 주인 × 지금 붙어 있음 × 그 사람의 동의 범위를
//     매 호출 다시 본다(apps/session-apps.ts requireAttachedApp). 떼는 순간 막힌다. 그 밖(세션 밖·안 붙음)은 거절.
//  테이블은 매니페스트 data.tables 선언분만(오타·미생성 차단).
//  값은 전부 파라미터화, 컬럼/테이블명은 charset 검증(store-ddl). LIMIT 는 클램프된 정수만 인터폴레이션.
//  쓰기가 성공하면 그 사람의 스트림으로 «데이터가 바뀌었다»를 민다 — 세션 오른쪽 앱 화면이 AI 가 쓴 것을 곧바로 그린다.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import { itemsPool } from "../db/client.js";
import { getApp } from "../org/store/apps.js";
import { qualifiedAppTable, assertIdent, isBuiltinSource, type StoreColumn, type StoreIndex } from "../apps/store-ddl.js";
import { appSchemaFor, ensureAppTables, type AppTableSpec } from "../apps/store-schema.js";
import { logger } from "../log.js";
import { requireAttachedApp, publishAppEvent } from "../apps/session-apps.js";
import { planAppSql, APP_SQL_MAX_LEN, APP_SQL_MAX_PARAMS } from "../apps/app-sql.js";
import { runAppSql, takeAppCall, assertAppDataQuota, appSqlTenantId } from "../apps/app-sql-exec.js";
import { ensureAppSqlRole } from "../apps/store-schema.js";
import { physicalAppPrefix } from "../apps/store-ddl.js";

const qi = (n: string): string => { if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(n)) throw new HttpError(400, `안전하지 않은 식별자: ${n}`); return `"${n}"`; };

/** 이 호출이 어느 앱의 데이터로 들어가나 — 머리말의 두 길. 판정은 매 호출(캐시 없음). */
async function resolveStoreApp(user: LivelyUser | undefined, input: Record<string, unknown>, ctx: CapabilityCtx | undefined, tool: string): Promise<string> {
  const want = String(input.app_id ?? "").trim();
  if (user?.appId) {
    if (want && want !== user.appId) throw new HttpError(403, `앱 '${user.appId}' 의 화면·세션은 자기 앱의 데이터만 씁니다(요청한 app_id: ${want})`);
    return user.appId;
  }
  if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
  const sessionId = String(ctx?.session ?? "").trim();
  if (!sessionId) throw new HttpError(400, "store_* 는 앱 화면·앱 세션, 또는 앱이 붙은 세션에서만 쓸 수 있습니다 — 세션 오른쪽에 앱을 붙이세요");
  return requireAttachedApp({ sessionId, member: user.userId, appId: want || null, tool });
}

/** 쓰기 뒤 — 그 사람의 스트림에 «이 앱의 이 테이블이 바뀌었다». 비치명(publishAppEvent 가 삼킨다). */
function announce(user: LivelyUser | undefined, appId: string, table: string, op: "insert" | "update" | "delete", ctx: CapabilityCtx | undefined): void {
  const member = user?.userId;
  if (!member) return;
  publishAppEvent(member, { kind: "data", app_id: appId, table, op, session: ctx?.session ?? null, source: ctx?.source });
}

// app_id — 앱 세션/UI 는 생략(자기 앱), 앱이 붙은 세션은 그 앱(붙은 앱이 하나면 생략 가능). #4225
const APP_ID = z.string().max(128).optional().describe("앱 id — 앱 화면·앱 세션에서는 생략. 앱이 붙은 세션에서는 그 앱(붙은 앱이 하나면 생략 가능)");
const appIdOf = (b: Record<string, unknown>): string | undefined => (b.app_id == null || b.app_id === "" ? undefined : String(b.app_id));

// 선언된 테이블만 — 매니페스트 data.tables 에 있는 이름이어야(오타·미생성 테이블 접근 차단).
//  반환 = 이 요청(테넌트)에서 그 테이블의 인용 relation + 지연 복구에 쓸 선언 목록(#4223).
interface AppTableTarget { rel: string; schema: string; builtin: boolean; tables: AppTableSpec[] }
/** 매니페스트 data.tables → 테이블 명세(모양이 어긋나도 던지지 않는다 — 저장된 매니페스트를 읽는 자리). */
function declaredSpecs(manifest: unknown): AppTableSpec[] {
  return ((manifest as { data?: { tables?: Array<{ name?: string; columns?: StoreColumn[]; indexes?: StoreIndex[] }> } })?.data?.tables ?? [])
    .map((t) => ({ table: String(t.name), columns: (t.columns ?? []) as StoreColumn[], indexes: (t.indexes ?? []) as StoreIndex[] }));
}
async function resolveDeclaredTable(appId: string, table: string): Promise<AppTableTarget> {
  const app = await getApp(appId);
  if (!app) throw new HttpError(404, `앱 없음: ${appId}`);
  const declared = declaredSpecs(app.manifest);
  if (!declared.some((t) => t.table === table)) throw new HttpError(404, `선언되지 않은 데이터 테이블: ${table}`);
  const builtin = isBuiltinSource(app.source);
  const schema = appSchemaFor(builtin);
  return { rel: qualifiedAppTable(schema, appId, table), schema, builtin, tables: declared };
}

// 지연 복구(#4223) — 선언은 있는데 물리 테이블·스키마가 없으면(42P01 undefined_table · 3F000 invalid_schema_name)
//  그 자리에서 만들고 한 번 재시도한다. 설치 때 DDL 이 실패했던 앱(매니지드의 기본 앱 전부가 그랬다)이 첫 사용에서 스스로 낫는다.
//  만들기까지 실패하면 ensureAppTables(strict)가 원인을 담은 503 을 던진다 — 종전의 말없는 500 대신.
async function withTableRepair<T>(appId: string, target: AppTableTarget, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code !== "42P01" && code !== "3F000") throw e;
    logger.warn({ appId, schema: target.schema, code }, "앱 데이터 테이블이 없어 만든 뒤 재시도합니다");
    await ensureAppTables(appId, target.tables, { schema: target.schema, strict: true, tenantScopedIndexes: target.builtin, sqlRole: !target.builtin });
    return run();
  }
}

const storeInsert: Capability = {
  name: "store_insert",
  title: "앱 데이터 삽입",
  description: "앱 자기 데이터 테이블에 행 1개 삽입(app.<appId>__<table>). 앱 화면·앱 세션, 또는 그 앱이 붙은 세션(app_id)에서. table 은 매니페스트 data.tables 선언분만. row 값은 파라미터화. 반환 id.",
  scope: null,
  input: { table: z.string(), row: z.record(z.unknown()), app_id: APP_ID },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/store/:table/insert"], parse: (req) => { const b = (req.body ?? {}) as Record<string, unknown>; return { table: (req.params as Record<string, string>)?.table, row: b.row, app_id: appIdOf(b) }; } }] },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const appId = await resolveStoreApp(user, input, ctx, "store_insert");
    const table = String(input.table ?? "");
    const target = await resolveDeclaredTable(appId, table);
    if (!target.builtin) takeAppCall(appId);
    await assertAppDataQuota(target.schema, target.builtin);
    const row = (input.row ?? {}) as Record<string, unknown>;
    const cols = Object.keys(row).map((c) => assertIdent("column", c));
    if (!cols.length) throw new HttpError(400, "삽입할 컬럼이 없습니다");
    const params = cols.map((_, i) => `$${i + 1}`);
    const r = await withTableRepair(appId, target, () => itemsPool.query(
      `INSERT INTO ${target.rel}(${cols.map(qi).join(",")}) VALUES(${params.join(",")}) RETURNING id`,
      cols.map((c) => row[c]),
    ));
    announce(user, appId, table, "insert", ctx);
    return { id: r.rows[0]?.id ?? null };
  },
};

const storeQuery: Capability = {
  name: "store_query",
  title: "앱 데이터 조회",
  description: "앱 자기 데이터 테이블 조회(app.<appId>__<table>). 앱 화면·앱 세션, 또는 그 앱이 붙은 세션(app_id)에서. match 는 컬럼=값 등가필터(파라미터화), limit(1~1000, 기본 100), 최신 id 순. table 은 선언분만.",
  scope: null,
  input: { table: z.string(), match: z.record(z.unknown()).optional(), limit: z.number().optional(), app_id: APP_ID },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/store/:table/query"], parse: (req) => { const b = (req.body ?? {}) as Record<string, unknown>; return { table: (req.params as Record<string, string>)?.table, match: b.match, limit: b.limit, app_id: appIdOf(b) }; } }] },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const appId = await resolveStoreApp(user, input, ctx, "store_query");
    const table = String(input.table ?? "");
    const target = await resolveDeclaredTable(appId, table);
    if (!target.builtin) takeAppCall(appId);
    const match = (input.match ?? {}) as Record<string, unknown>;
    const keys = Object.keys(match).map((k) => assertIdent("column", k));
    const where = keys.length ? " WHERE " + keys.map((k, i) => `${qi(k)}=$${i + 1}`).join(" AND ") : "";
    const limit = Math.max(1, Math.min(1000, Math.round(Number(input.limit) || 100)));
    const r = await withTableRepair(appId, target, () =>
      itemsPool.query(`SELECT * FROM ${target.rel}${where} ORDER BY id DESC LIMIT ${limit}`, keys.map((k) => match[k])));
    return { rows: r.rows };
  },
};

const storeUpdate: Capability = {
  name: "store_update",
  title: "앱 데이터 수정",
  description: "앱 자기 데이터 테이블의 행을 수정(app.<appId>__<table>). 앱 화면·앱 세션, 또는 그 앱이 붙은 세션(app_id)에서. match(컬럼=값 등가, 파라미터화)로 대상 지정, set(컬럼=새값). match 없으면 거부(전량 수정 방지). 반환 changed(행수).",
  scope: null,
  input: { table: z.string(), match: z.record(z.unknown()), set: z.record(z.unknown()), app_id: APP_ID },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/store/:table/update"], parse: (req) => { const b = (req.body ?? {}) as Record<string, unknown>; return { table: (req.params as Record<string, string>)?.table, match: b.match, set: b.set, app_id: appIdOf(b) }; } }] },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const appId = await resolveStoreApp(user, input, ctx, "store_update");
    const table = String(input.table ?? "");
    const target = await resolveDeclaredTable(appId, table);
    if (!target.builtin) takeAppCall(appId);
    await assertAppDataQuota(target.schema, target.builtin);
    const set = (input.set ?? {}) as Record<string, unknown>;
    const match = (input.match ?? {}) as Record<string, unknown>;
    const setCols = Object.keys(set).map((c) => assertIdent("column", c));
    const matchKeys = Object.keys(match).map((k) => assertIdent("column", k));
    if (!setCols.length) throw new HttpError(400, "수정할 컬럼이 없습니다");
    if (!matchKeys.length) throw new HttpError(400, "match 가 필요합니다(전량 수정 방지)");
    const params: unknown[] = [];
    const setSql = setCols.map((c) => { params.push(set[c]); return `${qi(c)}=$${params.length}`; }).join(",");
    const whereSql = matchKeys.map((k) => { params.push(match[k]); return `${qi(k)}=$${params.length}`; }).join(" AND ");
    const r = await withTableRepair(appId, target, () => itemsPool.query(`UPDATE ${target.rel} SET ${setSql} WHERE ${whereSql}`, params));
    if (r.rowCount) announce(user, appId, table, "update", ctx);
    return { changed: r.rowCount ?? 0 };
  },
};

const storeDelete: Capability = {
  name: "store_delete",
  title: "앱 데이터 삭제",
  description: "앱 자기 데이터 테이블의 행을 삭제(app.<appId>__<table>). 앱 화면·앱 세션, 또는 그 앱이 붙은 세션(app_id)에서. match(컬럼=값 등가, 파라미터화)로 대상 지정 — match 없으면 거부(전량 삭제 방지). 반환 deleted(행수).",
  scope: null,
  input: { table: z.string(), match: z.record(z.unknown()), app_id: APP_ID },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/store/:table/delete"], parse: (req) => { const b = (req.body ?? {}) as Record<string, unknown>; return { table: (req.params as Record<string, string>)?.table, match: b.match, app_id: appIdOf(b) }; } }] },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const appId = await resolveStoreApp(user, input, ctx, "store_delete");
    const table = String(input.table ?? "");
    const target = await resolveDeclaredTable(appId, table);
    if (!target.builtin) takeAppCall(appId);
    const match = (input.match ?? {}) as Record<string, unknown>;
    const keys = Object.keys(match).map((k) => assertIdent("column", k));
    if (!keys.length) throw new HttpError(400, "match 가 필요합니다(전량 삭제 방지)");
    const where = keys.map((k, i) => `${qi(k)}=$${i + 1}`).join(" AND ");
    const r = await withTableRepair(appId, target, () => itemsPool.query(`DELETE FROM ${target.rel} WHERE ${where}`, keys.map((k) => match[k])));
    if (r.rowCount) announce(user, appId, table, "delete", ctx);
    return { deleted: r.rowCount ?? 0 };
  },
};

// ── 자유 SQL(#4226) ─────────────────────────────────────────────────────────────────────
//  워크스페이스가 설치한 앱의 테이블엔 SELECT·INSERT·UPDATE·DELETE 한 문장을 그대로 받는다(표·칸은 매니페스트로만).
//  문장 검사·이름 바꿔 쓰기는 apps/app-sql, 앱 역할·격벽 풀·상한은 apps/app-sql-exec. 기본 앱(여러 워크스페이스가 테이블을
//  나눠 쓰는 앱)은 열지 않는다 — 거기선 행 격리가 설정값 하나에 기대기 때문이다(계획 §7-1).
//  앱 역할은 처음 쓸 때 보장하고 (워크스페이스, 앱, 앱 판) 마다 기억한다 — 앱을 다시 설치하면 판이 바뀌어 다시 맞춘다.
const sqlRoleCache = new Map<string, string>();
async function sqlRoleFor(appId: string, app: { content_hash?: string | null; updated_at?: unknown }, specs: AppTableSpec[], schema: string): Promise<string> {
  const key = `${appSqlTenantId()}\0${appId}\0${app.content_hash ?? ""}\0${String(app.updated_at ?? "")}\0${schema}`;
  const hit = sqlRoleCache.get(key);
  if (hit) return hit;
  await ensureAppTables(appId, specs, { schema, strict: true });          // 테이블이 없던 앱(설치 때 실패)도 여기서 낫는다
  const role = await ensureAppSqlRole(appId, specs.map((t) => t.table), schema);
  if (sqlRoleCache.size > 5000) sqlRoleCache.clear();
  sqlRoleCache.set(key, role);
  return role;
}

const storeSql: Capability = {
  name: "store_sql",
  title: "앱 데이터 SQL",
  description: "앱 자기 데이터 테이블에 SQL 한 문장(SELECT·INSERT·UPDATE·DELETE)을 실행한다. 앱 화면·앱 세션, 또는 그 앱이 붙은 세션(app_id)에서. "
    + "테이블은 매니페스트에 선언한 이름 그대로 쓴다(FROM contacts). 값은 $1·$2 … 와 params 로 넘긴다. 테이블·칸 만들기는 매니페스트로만(DDL 불가). "
    + "조건 없는 UPDATE·DELETE 는 거부. 주석·세미콜론·백슬래시·스키마 붙인 이름은 받지 않는다. 결과는 최대 5,000행·5MB(넘으면 truncated), 문장 5초. "
    + "여러 행을 쓸 땐 INSERT … VALUES (…),(…) 한 문장으로. 워크스페이스가 설치한 앱에서만(기본 앱은 store_query 등을 쓴다). 반환 {kind, columns, rows, row_count, truncated, changed}.",
  scope: null,
  input: {
    sql: z.string().max(APP_SQL_MAX_LEN),
    params: z.array(z.unknown()).max(APP_SQL_MAX_PARAMS).optional().describe("$1·$2 … 자리에 들어갈 값(순서대로)"),
    app_id: APP_ID,
  },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/store/sql"], parse: (req) => { const b = (req.body ?? {}) as Record<string, unknown>; return { sql: b.sql, params: b.params, app_id: appIdOf(b) }; } }] },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const appId = await resolveStoreApp(user, input, ctx, "store_sql");
    const app = await getApp(appId);
    if (!app) throw new HttpError(404, `앱 없음: ${appId}`);
    if (isBuiltinSource(app.source)) {
      throw new HttpError(400, `「${app.title || appId}」 은(는) 라이블리가 함께 싣는 기본 앱이라 자유 SQL 을 열지 않습니다 — store_query·store_insert·store_update·store_delete 를 쓰세요`);
    }
    const specs = declaredSpecs(app.manifest);
    if (!specs.length) throw new HttpError(400, `앱 '${appId}' 은(는) 데이터 테이블을 선언하지 않았습니다 — 매니페스트 data.tables 에 먼저 선언하세요`);
    const schema = appSchemaFor(false);
    const plan = planAppSql(String(input.sql ?? ""), { appId, schema, tables: specs.map((t) => t.table) });
    const params = Array.isArray(input.params) ? input.params.map((v) => (v === undefined ? null : v)) : [];
    if (params.length !== plan.paramCount) {
      throw new HttpError(400, `params 개수(${params.length})가 SQL 의 자리($1…$${plan.paramCount}, ${plan.paramCount}개)와 다릅니다`);
    }
    takeAppCall(appId);
    if (plan.kind === "insert" || plan.kind === "update") await assertAppDataQuota(schema, false);
    const role = await sqlRoleFor(appId, app, specs, schema);
    const out = await runAppSql({ plan, params, role, appId, schema, physicalPrefix: `${physicalAppPrefix(appId)}__` });
    if (plan.writes && (out.changed ?? 0) > 0) {
      for (const t of plan.targets) announce(user, appId, t, plan.kind as "insert" | "update" | "delete", ctx);
    }
    return { kind: plan.kind, ...out };
  },
};

const storeTables: Capability = {
  name: "store_tables",
  title: "앱 데이터 테이블 목록",
  description: "이 앱이 선언한 데이터 테이블(name·columns·indexes) 목록과 자유 SQL(store_sql) 을 쓸 수 있는지(sql). 앱 화면·앱 세션, 또는 그 앱이 붙은 세션(app_id)에서(자기 앱 스키마 introspection). 모든 테이블엔 id·created_at 칸이 저절로 있다.",
  scope: null,
  input: { app_id: APP_ID },
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/store/tables"], parse: (req) => ({ app_id: appIdOf((req.query ?? {}) as Record<string, unknown>) }) }] },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const appId = await resolveStoreApp(user, input, ctx, "store_tables");
    const app = await getApp(appId);
    const tables = ((app?.manifest as { data?: { tables?: unknown[] } })?.data?.tables ?? []);
    return { tables, sql: !!app && !isBuiltinSource(app.source) };
  },
};

export const appStoreCapabilities: Capability[] = [storeInsert, storeQuery, storeUpdate, storeDelete, storeSql, storeTables];
