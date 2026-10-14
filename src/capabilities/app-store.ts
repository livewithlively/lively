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
import { getApp, type OrgApp } from "../org/store/apps.js";
import { liveManifests, viewAppFor } from "../apps/app-view.js";
import type { Viewer } from "../apps/visibility.js";
import { qualifiedAppTable, assertIdent, isBuiltinSource, type StoreColumn, type StoreIndex, assertMatchIdent, assertMatchId } from "../apps/store-ddl.js";
import { appSchemaFor, ensureAppTables, type AppTableSpec } from "../apps/store-schema.js";
import { logger } from "../log.js";
import { requireAttachedApp, publishAppEventToSession } from "../apps/session-apps.js";
import { planAppSql, APP_SQL_MAX_LEN, APP_SQL_MAX_PARAMS, type AppSqlPlan } from "../apps/app-sql.js";
import { runAppSql, runAppSqlBatch, takeAppCall, assertAppDataQuota, appSqlTenantId, recordPlanMicros, appSqlStats, currentAppSqlLimits, type AppSqlResult, type AppSqlWireResult } from "../apps/app-sql-exec.js";
import { ensureAppSqlRole } from "../apps/store-schema.js";
import { physicalAppPrefix } from "../apps/store-ddl.js";
import { mintAppServerToken } from "../apps/app-server-auth.js";

/** 빈도 게이트 — 앱 서버가 사람 신원을 싣고 부른 호출은 사람마다 세고 앱 전체는 따로 묶는다(app-sql-exec.takeAppCall). */
const callGate = (user: LivelyUser | undefined, appId: string, n = 1): void => takeAppCall(appId, appSqlTenantId(), n, user?.appServer ? user.userId : undefined);

/** match 한 칸의 값 — `id` 는 정수만(아니면 400), 그 밖은 준 그대로(파라미터로 넘어간다). */
const matchValue = (key: string, value: unknown): unknown => (key === "id" ? assertMatchId(value) : value);
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
  return requireAttachedApp({ sessionId, member: user.userId, appId: want || null, tool, scopes: user.scopes });
}

/** 쓰기 뒤 — 그 사람의 스트림에 «이 앱의 이 테이블이 바뀌었다». 비치명(publishAppEvent 가 삼킨다). */
function announce(user: LivelyUser | undefined, appId: string, table: string, op: "insert" | "update" | "delete", ctx: CapabilityCtx | undefined): void {
  const member = user?.userId;
  if (!member) return;
  publishAppEventToSession(member, ctx?.session, { kind: "data", app_id: appId, table, op, session: ctx?.session ?? null, source: ctx?.source });   // 그 세션에 같이 있는 사람의 화면에도
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
/** 여러 매니페스트의 표 명세 합 — 같은 이름이면 앞의 것(설치된 판 — 새 칸이 더해진 쪽). */
function unionSpecs(manifests: unknown[]): AppTableSpec[] {
  const out: AppTableSpec[] = [];
  for (const m of manifests) for (const t of declaredSpecs(m)) if (!out.some((d) => d.table === t.table)) out.push(t);
  return out;
}
const viewerOf = (user: LivelyUser | undefined): Viewer => ({ userId: String(user?.userId ?? ""), scopes: user?.scopes ?? [] });
/** #4667 이 사람이 쓰는 판의 표 명세 — 공개 판을 보는 사람은 공개 판이 선언한 표, 초안을 만든 사람은 초안의 표(격리 리뷰 B3). */
async function viewSpecs(app: OrgApp, who: Viewer): Promise<AppTableSpec[]> {
  return declaredSpecs((await viewAppFor(app, who)).app.manifest);
}
async function resolveDeclaredTable(appId: string, table: string, who: Viewer): Promise<AppTableTarget> {
  const app = await getApp(appId);
  if (!app) throw new HttpError(404, `앱 없음: ${appId}`);
  //  받는 표 = 이 사람이 보는 판이 선언한 표. 지연 복구 명세는 물리 표 전부(두 판의 합) — 초안이 뺀 표도 공개 판이 쓰는 동안은 살아 있다
  //   (install-run keepTables). 같은 이름이면 설치된 판(새 칸이 더해진 쪽)의 명세가 쓰인다.
  if (!(await viewSpecs(app, who)).some((t) => t.table === table)) throw new HttpError(404, `선언되지 않은 데이터 테이블: ${table}`);
  const builtin = isBuiltinSource(app.source);
  const schema = appSchemaFor(builtin);
  return { rel: qualifiedAppTable(schema, appId, table), schema, builtin, tables: unionSpecs(await liveManifests(app)) };
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
    const target = await resolveDeclaredTable(appId, table, viewerOf(user));
    if (!target.builtin) callGate(user, appId);
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
    const target = await resolveDeclaredTable(appId, table, viewerOf(user));
    if (!target.builtin) callGate(user, appId);
    const match = (input.match ?? {}) as Record<string, unknown>;
    const keys = Object.keys(match).map((k) => assertMatchIdent(k));
    const where = keys.length ? " WHERE " + keys.map((k, i) => `${qi(k)}=$${i + 1}`).join(" AND ") : "";
    const limit = Math.max(1, Math.min(1000, Math.round(Number(input.limit) || 100)));
    const r = await withTableRepair(appId, target, () =>
      itemsPool.query(`SELECT * FROM ${target.rel}${where} ORDER BY id DESC LIMIT ${limit}`, keys.map((k) => matchValue(k, match[k]))));
    return { rows: r.rows };
  },
};

const storeUpdate: Capability = {
  name: "store_update",
  title: "앱 데이터 수정",
  description: "앱 자기 데이터 테이블의 행을 수정(app.<appId>__<table>). 앱 화면·앱 세션, 또는 그 앱이 붙은 세션(app_id)에서. match(컬럼=값 등가, 파라미터화 — 선언 칸과 시스템 칸 id·created_at)로 대상 지정, set(컬럼=새값). 한 행만 고치려면 match:{id}. match 없으면 거부(전량 수정 방지). 반환 changed(행수).",
  scope: null,
  input: { table: z.string(), match: z.record(z.unknown()), set: z.record(z.unknown()), app_id: APP_ID },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/store/:table/update"], parse: (req) => { const b = (req.body ?? {}) as Record<string, unknown>; return { table: (req.params as Record<string, string>)?.table, match: b.match, set: b.set, app_id: appIdOf(b) }; } }] },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const appId = await resolveStoreApp(user, input, ctx, "store_update");
    const table = String(input.table ?? "");
    const target = await resolveDeclaredTable(appId, table, viewerOf(user));
    if (!target.builtin) callGate(user, appId);
    await assertAppDataQuota(target.schema, target.builtin);
    const set = (input.set ?? {}) as Record<string, unknown>;
    const match = (input.match ?? {}) as Record<string, unknown>;
    const setCols = Object.keys(set).map((c) => assertIdent("column", c));
    const matchKeys = Object.keys(match).map((k) => assertMatchIdent(k));
    if (!setCols.length) throw new HttpError(400, "수정할 컬럼이 없습니다");
    if (!matchKeys.length) throw new HttpError(400, "match 가 필요합니다(전량 수정 방지)");
    const params: unknown[] = [];
    const setSql = setCols.map((c) => { params.push(set[c]); return `${qi(c)}=$${params.length}`; }).join(",");
    const whereSql = matchKeys.map((k) => { params.push(matchValue(k, match[k])); return `${qi(k)}=$${params.length}`; }).join(" AND ");
    const r = await withTableRepair(appId, target, () => itemsPool.query(`UPDATE ${target.rel} SET ${setSql} WHERE ${whereSql}`, params));
    if (r.rowCount) announce(user, appId, table, "update", ctx);
    return { changed: r.rowCount ?? 0 };
  },
};

const storeDelete: Capability = {
  name: "store_delete",
  title: "앱 데이터 삭제",
  description: "앱 자기 데이터 테이블의 행을 삭제(app.<appId>__<table>). 앱 화면·앱 세션, 또는 그 앱이 붙은 세션(app_id)에서. match(컬럼=값 등가, 파라미터화 — 선언 칸과 시스템 칸 id·created_at)로 대상 지정 — 한 행만 지우려면 match:{id}. match 없으면 거부(전량 삭제 방지). 반환 deleted(행수).",
  scope: null,
  input: { table: z.string(), match: z.record(z.unknown()), app_id: APP_ID },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/store/:table/delete"], parse: (req) => { const b = (req.body ?? {}) as Record<string, unknown>; return { table: (req.params as Record<string, string>)?.table, match: b.match, app_id: appIdOf(b) }; } }] },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const appId = await resolveStoreApp(user, input, ctx, "store_delete");
    const table = String(input.table ?? "");
    const target = await resolveDeclaredTable(appId, table, viewerOf(user));
    if (!target.builtin) callGate(user, appId);
    const match = (input.match ?? {}) as Record<string, unknown>;
    const keys = Object.keys(match).map((k) => assertMatchIdent(k));
    if (!keys.length) throw new HttpError(400, "match 가 필요합니다(전량 삭제 방지)");
    const where = keys.map((k, i) => `${qi(k)}=$${i + 1}`).join(" AND ");
    const r = await withTableRepair(appId, target, () => itemsPool.query(`DELETE FROM ${target.rel} WHERE ${where}`, keys.map((k) => matchValue(k, match[k]))));
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
async function sqlRoleFor(appId: string, app: { content_hash?: string | null; updated_at?: unknown; draft_by?: string | null; published_version_no?: number | null }, specs: AppTableSpec[], schema: string): Promise<string> {
  //  #4667 역할이 받는 표는 물리 표 전부(설치된 판 ∪ 공개 판) — 초안 표식 · 공개 판 포인터가 바뀌면 그 합도 바뀌므로 열쇠에 넣는다.
  const key = `${appSqlTenantId()}\0${appId}\0${app.content_hash ?? ""}\0${String(app.updated_at ?? "")}\0${app.draft_by ?? ""}\0${app.published_version_no ?? ""}\0${schema}`;
  const hit = sqlRoleCache.get(key);
  if (hit) return hit;
  await ensureAppTables(appId, specs, { schema, strict: true });          // 테이블이 없던 앱(설치 때 실패)도 여기서 낫는다
  const role = await ensureAppSqlRole(appId, specs.map((t) => t.table), schema);
  if (sqlRoleCache.size > 5000) sqlRoleCache.clear();
  sqlRoleCache.set(key, role);
  return role;
}

// 결과 모양 · 엄격 — SDK(Drizzle 드라이버)는 wire + strict 로 부른다(#4483). 사람·AI 는 기본(objects, 잘리면 truncated 로 알림).
const FORMAT = z.enum(["objects", "wire"]).optional()
  .describe("objects(기본) = 칸 이름 → 값 · wire = 값은 DB 글자 그대로 + 칸 형 OID(SDK 드라이버가 node-postgres 와 같게 해석)");
const STRICT = z.boolean().optional().describe("true 면 결과가 상한(5,000행·5MB)에 잘릴 때 413 으로 되돌린다(쓰기도 취소) — 잘린 결과를 전부로 믿는 ORM 용");

interface SqlTarget {
  appId: string;
  app: { content_hash?: string | null; updated_at?: unknown; title?: string | null; draft_by?: string | null; published_version_no?: number | null };
  /** 문장이 쓸 수 있는 표 — 이 사람이 보는 판이 선언한 표(#4667). */
  specs: AppTableSpec[];
  /** 앱 역할이 받는 표 — 물리 표 전부(설치된 판 ∪ 공개 판, #4667). */
  roleSpecs: AppTableSpec[];
  schema: string;
}
/** store_sql·store_sql_batch 공통 — 어느 앱인가 · 기본 앱 거부 · 선언 표 · 스키마. */
async function sqlTarget(user: LivelyUser | undefined, input: Record<string, unknown>, ctx: CapabilityCtx | undefined, tool: string): Promise<SqlTarget> {
  const appId = await resolveStoreApp(user, input, ctx, tool);
  const app = await getApp(appId);
  if (!app) throw new HttpError(404, `앱 없음: ${appId}`);
  if (isBuiltinSource(app.source)) {
    throw new HttpError(400, `「${app.title || appId}」 은(는) 라이블리가 함께 싣는 기본 앱이라 자유 SQL 을 열지 않습니다 — store_query·store_insert·store_update·store_delete 를 쓰세요`);
  }
  //  #4667 문장이 쓸 수 있는 표 = 이 사람이 보는 판이 선언한 표(공개 판을 보는 사람은 공개 판의 표 · 격리 리뷰 B3).
  const specs = await viewSpecs(app, viewerOf(user));
  if (!specs.length) throw new HttpError(400, `앱 '${appId}' 은(는) 데이터 테이블을 선언하지 않았습니다 — 매니페스트 data.tables 에 먼저 선언하세요`);
  return { appId, app, specs, roleSpecs: unionSpecs(await liveManifests(app)), schema: appSchemaFor(false) };
}

/** 문장 하나 — 검사(검사기 시간을 지표에 남긴다) · params 개수 맞춤. where = 오류 문구 앞머리(묶음이면 «n번째 문장»). */
async function planStatement(t: SqlTarget, sql: unknown, rawParams: unknown, where: string): Promise<{ plan: AppSqlPlan; params: unknown[] }> {
  const t0 = process.hrtime.bigint();
  let plan: AppSqlPlan;
  try { plan = await planAppSql(String(sql ?? ""), { appId: t.appId, schema: t.schema, tables: t.specs.map((x) => x.table) }); }
  catch (e) {
    if (where && e instanceof HttpError) throw new HttpError(e.status, `${where}: ${e.message}`, { cause: e, body: e.body });
    throw e;
  }
  finally { recordPlanMicros(Number(process.hrtime.bigint() - t0) / 1000); }
  const params = Array.isArray(rawParams) ? rawParams.map((v) => (v === undefined ? null : v)) : [];
  if (params.length !== plan.paramCount) {
    throw new HttpError(400, `${where ? `${where}: ` : ""}params 개수(${params.length})가 SQL 의 자리($1…$${plan.paramCount}, ${plan.paramCount}개)와 다릅니다`);
  }
  return { plan, params };
}

type SqlOut = { kind: string } & (AppSqlResult | AppSqlWireResult);
/** 게이트(빈도 · 용량 · 역할) → 실행 → 쓰기 알림. */
async function runPlanned(t: SqlTarget, items: Array<{ plan: AppSqlPlan; params: unknown[] }>, input: Record<string, unknown>, user: LivelyUser | undefined, ctx: CapabilityCtx | undefined, batch: boolean): Promise<{ results: SqlOut[]; ms: number }> {
  callGate(user, t.appId, items.length);
  if (items.some((it) => it.plan.kind === "insert" || it.plan.kind === "update")) await assertAppDataQuota(t.schema, false);
  const role = await sqlRoleFor(t.appId, t.app, t.roleSpecs, t.schema);
  const base = { role, appId: t.appId, schema: t.schema, physicalPrefix: `${physicalAppPrefix(t.appId)}__`, format: input.format === "wire" ? "wire" as const : "objects" as const, strict: input.strict === true };
  const out = batch
    ? await runAppSqlBatch({ ...base, items })
    : await runAppSql({ ...base, plan: items[0].plan, params: items[0].params }).then((r) => ({ results: [r], ms: r.ms }));
  const results = out.results.map((r, i) => ({ kind: items[i].plan.kind, ...r }));
  const touched = new Map<string, "insert" | "update" | "delete">();
  results.forEach((r, i) => {
    const p = items[i].plan;
    if (p.writes && (r.changed ?? 0) > 0) for (const tb of p.targets) touched.set(tb, p.kind as "insert" | "update" | "delete");
  });
  for (const [tb, op] of touched) announce(user, t.appId, tb, op, ctx);
  return { results, ms: out.ms };
}

const storeSql: Capability = {
  name: "store_sql",
  title: "앱 데이터 SQL",
  description: "앱 자기 데이터 테이블에 SQL 한 문장(SELECT·INSERT·UPDATE·DELETE)을 실행한다. 앱 화면·앱 세션, 또는 그 앱이 붙은 세션(app_id)에서. "
    + "테이블은 매니페스트에 선언한 이름 그대로 쓴다(FROM contacts). 값은 $1·$2 … 와 params 로 넘긴다. 테이블·칸 만들기는 매니페스트로만(DDL 불가). "
    + "Postgres 문법 그대로(조인·서브쿼리·WITH·집계·ON CONFLICT·RETURNING·FOR UPDATE SKIP LOCKED). 조건 없는 UPDATE·DELETE 는 거부. "
    + "스키마 붙인 이름·카탈로그·설정 함수는 받지 않는다. 결과는 최대 5,000행·5MB(넘으면 truncated, strict 면 413), 문장 5초. "
    + "여러 문장을 전부-되거나-전부-취소로 하려면 store_sql_batch. 워크스페이스가 설치한 앱에서만(기본 앱은 store_query 등을 쓴다). 반환 {kind, columns, rows, row_count, truncated, changed, ms}.",
  scope: null,
  input: {
    sql: z.string().max(APP_SQL_MAX_LEN),
    params: z.array(z.unknown()).max(APP_SQL_MAX_PARAMS).optional().describe("$1·$2 … 자리에 들어갈 값(순서대로)"),
    app_id: APP_ID,
    format: FORMAT,
    strict: STRICT,
  },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/store/sql"], parse: (req) => { const b = (req.body ?? {}) as Record<string, unknown>; return { sql: b.sql, params: b.params, app_id: appIdOf(b), format: b.format, strict: b.strict }; } }] },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const t = await sqlTarget(user, input, ctx, "store_sql");
    const item = await planStatement(t, input.sql, input.params, "");
    const { results } = await runPlanned(t, [item], input, user, ctx, false);
    return results[0];
  },
};

// ── 묶음 트랜잭션(#4483) ─────────────────────────────────────────────────────────────────
//  여러 문장을 한 트랜잭션으로 — 하나라도 실패하면 전부 취소(어느 문장인지 body.index). 대화형 트랜잭션은 없다:
//  앞 문장의 결과를 뒤 문장에 넣을 수 없다(필요하면 한 문장 안에서 서브쿼리·RETURNING·ON CONFLICT 로).
//  모든 문장을 먼저 검사한다 — 하나라도 거부면 아무것도 실행하지 않는다. 빈도는 문장 수만큼 쓴다.
const storeSqlBatch: Capability = {
  name: "store_sql_batch",
  title: "앱 데이터 SQL 묶음",
  description: "여러 SQL 문장을 한 트랜잭션으로 실행한다 — 전부 되거나 전부 취소(실패하면 몇 번째 문장인지 body.index). 문장마다 store_sql 과 같은 규칙. "
    + "앞 문장 결과를 뒤 문장에 넣는 대화형 트랜잭션은 아니다(값이 필요하면 한 문장 안에서 서브쿼리·RETURNING). 한 번에 20문장·10초, 결과 5MB 를 문장 전체가 나눠 쓴다. "
    + "반환 {results:[{kind, columns, rows, row_count, truncated, changed, ms}], ms}.",
  scope: null,
  input: {
    statements: z.array(z.object({
      sql: z.string().max(APP_SQL_MAX_LEN),
      params: z.array(z.unknown()).max(APP_SQL_MAX_PARAMS).optional(),
    })).min(1).max(100).describe("차례로 실행할 문장들 — [{sql, params}]"),
    app_id: APP_ID,
    format: FORMAT,
    strict: STRICT,
  },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/store/sql/batch"], parse: (req) => { const b = (req.body ?? {}) as Record<string, unknown>; return { statements: b.statements, app_id: appIdOf(b), format: b.format, strict: b.strict }; } }] },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const list = Array.isArray(input.statements) ? input.statements as Array<{ sql?: unknown; params?: unknown }> : [];
    if (!list.length) throw new HttpError(400, "statements 가 비었습니다 — [{sql, params}] 로 보내세요");
    const max = currentAppSqlLimits().batchMax;
    if (list.length > max) throw new HttpError(400, `묶음은 한 번에 ${max}문장까지입니다(${list.length}문장) — 나눠 보내거나, 여러 행은 INSERT … VALUES (…),(…) 한 문장으로 쓰세요`);
    const t = await sqlTarget(user, input, ctx, "store_sql_batch");
    const items = [];
    for (let i = 0; i < list.length; i++) {
      try { items.push(await planStatement(t, list[i]?.sql, list[i]?.params, `${i + 1}번째 문장`)); }
      catch (e) { if (e instanceof HttpError) throw new HttpError(e.status, e.message, { cause: e, body: { ...(e.body ?? {}), index: i } }); throw e; }
    }
    return runPlanned(t, items, input, user, ctx, true);
  },
};

// ── 지표(#4483) — 측정 ②·«앱 SQL 을 따로 뗄 기준» 판정용. 관리자 전용 ───────────────────────────
const appSqlStatsCap: Capability = {
  name: "app_sql_stats",
  title: "앱 SQL 지표",
  description: "앱 자유 SQL 실행기의 최근 지표 — 문장 지연(p50·p95)·자리 대기(다른 고객 대기)·검사기 시간·거절 수·지금 쓰는 자리·게이트웨이 프로세스 CPU·이벤트 루프 사용률. "
    + "관리자 전용. reset=true 면 읽은 뒤 비운다(측정 구간을 끊을 때).",
  scope: "admin",
  mutates: false,
  input: { reset: z.boolean().optional().describe("읽은 뒤 표본·셈을 비운다") },
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/app-sql/stats"], parse: (req) => { const r = String((req.query as Record<string, unknown>)?.reset ?? ""); return { reset: r === "1" || r === "true" }; } }] },
  handler: async (input: Record<string, unknown>) => appSqlStats(input.reset === true),
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
    //  #4667 이 사람이 보는 판의 구조 — 공개 판을 보는 사람에게 남의 초안 구조를 주지 않는다(격리 리뷰 B3).
    const shown = app ? (await viewAppFor(app, viewerOf(user))).app : null;
    const tables = ((shown?.manifest as { data?: { tables?: unknown[] } })?.data?.tables ?? []);
    return { tables, sql: !!app && !isBuiltinSource(app.source) };
  },
};

// ── 앱 서버 토큰(#4483) — 앱 서버(Express · Lambda)가 게이트웨이를 부를 자격. 관리자 전용 ─────────────────
//  혼자서는 아무것도 못 한다 — 앞단이 서명한 사람 신원(X-Lively-Identity)과 함께 능력 REST 로 올 때만 그 사람 ∩ 앱 동의로 돈다
//  (apps/app-server-auth). v2-6 이 배포 때 함수 환경변수로 넣는다. 목록·회수는 기존 org_tokens · org_token_revoke.
const appServerTokenMint: Capability = {
  name: "app_server_token_mint",
  title: "앱 서버 토큰 발급",
  description: "앱 서버(Express·Lambda 등)가 라이블리 API(앱 데이터 SQL·도구)를 부를 때 쓰는 토큰을 만든다 — 멤버 없는 앱 토큰. "
    + "혼자서는 아무것도 못 하고, 앞단이 서명한 사람 신원(X-Lively-Identity)을 함께 실을 때만 그 사람 ∩ 그 사람의 앱 동의로 돈다. "
    + "워크스페이스가 설치한 활성 앱만. 평문은 이 응답에서 한 번만 보인다. 목록·회수는 org_tokens · org_token_revoke. 관리자 전용.",
  scope: "admin",
  input: { app_id: z.string().min(1).max(128).describe("앱 id") },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/apps/:id/server-token"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) }] },
  handler: async (input: Record<string, unknown>, user) => {
    const r = await mintAppServerToken(String(input.app_id ?? ""), user.userId);
    return {
      token: r.token, user_id: r.userId, expires_at: r.expiresAt,
      note: "앱 서버 환경변수 LIVELY_APP_TOKEN 으로 넣으세요. 요청마다 들어온 X-Lively-Identity 를 그대로 실어야 합니다(SDK 가 대신 합니다).",
    };
  },
};

export const appStoreCapabilities: Capability[] = [storeInsert, storeQuery, storeUpdate, storeDelete, storeSql, storeSqlBatch, storeTables, appSqlStatsCap, appServerTokenMint];
