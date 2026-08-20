// 앱 데이터 store_* (#1780 D6) — 앱이 **자기** 데이터 테이블(app.<appId>__<table>)을 읽고 쓴다.
//  이중 격리: ① 테넌트 = RLS(런타임 앱 role 풀 itemsPool 이 SET LOCAL app.tenant_id 로 자동 필터, store-schema 정책)
//   ② 앱 = 핸들러가 물리명을 **appUser.appId** 로 강제(클라가 app_id 를 못 고른다) → 앱 X 는 앱 Y 테이블을 이름조차 못 만든다.
//  전제: 앱 세션/UI(appUser.appId 있음)만. 일반 세션은 400. 테이블은 매니페스트 data.tables 선언분만(오타·미생성 차단).
//  값은 전부 파라미터화, 컬럼/테이블명은 charset 검증(store-ddl). LIMIT 는 클램프된 정수만 인터폴레이션.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { itemsPool } from "../db/client.js";
import { getApp } from "../org/store/apps.js";
import { physicalTableName, assertIdent } from "../apps/store-ddl.js";

const qi = (n: string): string => { if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(n)) throw new HttpError(400, `안전하지 않은 식별자: ${n}`); return `"${n}"`; };

function requireAppPrincipal(user: LivelyUser | undefined): string {
  const appId = user?.appId;
  if (!appId) throw new HttpError(400, "store_* 는 앱 세션/UI 에서만 쓸 수 있습니다(앱 principal 필요)");
  return appId;
}

// 선언된 테이블만 — 매니페스트 data.tables 에 있는 이름이어야(오타·미생성 테이블 접근 차단).
async function assertDeclaredTable(appId: string, table: string): Promise<void> {
  const app = await getApp(appId);
  if (!app) throw new HttpError(404, `앱 없음: ${appId}`);
  const tables = ((app.manifest as { data?: { tables?: Array<{ name?: string }> } })?.data?.tables ?? []).map((t) => String(t.name));
  if (!tables.includes(table)) throw new HttpError(404, `선언되지 않은 데이터 테이블: ${table}`);
}

const storeInsert: Capability = {
  name: "store_insert",
  title: "앱 데이터 삽입",
  description: "앱 자기 데이터 테이블에 행 1개 삽입(app.<appId>__<table>). 앱 세션/UI 전용. table 은 매니페스트 data.tables 선언분만. row 값은 파라미터화. 반환 id.",
  scope: null,
  input: { table: z.string(), row: z.record(z.unknown()) },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/store/:table/insert"], parse: (req) => ({ table: (req.params as Record<string, string>)?.table, row: (req.body as Record<string, unknown>)?.row }) }] },
  handler: async (input: Record<string, unknown>, user) => {
    const appId = requireAppPrincipal(user);
    const table = String(input.table ?? "");
    await assertDeclaredTable(appId, table);
    const row = (input.row ?? {}) as Record<string, unknown>;
    const cols = Object.keys(row).map((c) => assertIdent("column", c));
    if (!cols.length) throw new HttpError(400, "삽입할 컬럼이 없습니다");
    const phys = physicalTableName(appId, table);
    const params = cols.map((_, i) => `$${i + 1}`);
    const r = await itemsPool.query(
      `INSERT INTO app.${qi(phys)}(${cols.map(qi).join(",")}) VALUES(${params.join(",")}) RETURNING id`,
      cols.map((c) => row[c]),
    );
    return { id: r.rows[0]?.id ?? null };
  },
};

const storeQuery: Capability = {
  name: "store_query",
  title: "앱 데이터 조회",
  description: "앱 자기 데이터 테이블 조회(app.<appId>__<table>). 앱 세션/UI 전용. match 는 컬럼=값 등가필터(파라미터화), limit(1~1000, 기본 100), 최신 id 순. table 은 선언분만.",
  scope: null,
  input: { table: z.string(), match: z.record(z.unknown()).optional(), limit: z.number().optional() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/store/:table/query"], parse: (req) => { const b = (req.body ?? {}) as Record<string, unknown>; return { table: (req.params as Record<string, string>)?.table, match: b.match, limit: b.limit }; } }] },
  handler: async (input: Record<string, unknown>, user) => {
    const appId = requireAppPrincipal(user);
    const table = String(input.table ?? "");
    await assertDeclaredTable(appId, table);
    const phys = physicalTableName(appId, table);
    const match = (input.match ?? {}) as Record<string, unknown>;
    const keys = Object.keys(match).map((k) => assertIdent("column", k));
    const where = keys.length ? " WHERE " + keys.map((k, i) => `${qi(k)}=$${i + 1}`).join(" AND ") : "";
    const limit = Math.max(1, Math.min(1000, Math.round(Number(input.limit) || 100)));
    const r = await itemsPool.query(`SELECT * FROM app.${qi(phys)}${where} ORDER BY id DESC LIMIT ${limit}`, keys.map((k) => match[k]));
    return { rows: r.rows };
  },
};

const storeUpdate: Capability = {
  name: "store_update",
  title: "앱 데이터 수정",
  description: "앱 자기 데이터 테이블의 행을 수정(app.<appId>__<table>). 앱 세션/UI 전용. match(컬럼=값 등가, 파라미터화)로 대상 지정, set(컬럼=새값). match 없으면 거부(전량 수정 방지). 반환 changed(행수).",
  scope: null,
  input: { table: z.string(), match: z.record(z.unknown()), set: z.record(z.unknown()) },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/store/:table/update"], parse: (req) => { const b = (req.body ?? {}) as Record<string, unknown>; return { table: (req.params as Record<string, string>)?.table, match: b.match, set: b.set }; } }] },
  handler: async (input: Record<string, unknown>, user) => {
    const appId = requireAppPrincipal(user);
    const table = String(input.table ?? "");
    await assertDeclaredTable(appId, table);
    const set = (input.set ?? {}) as Record<string, unknown>;
    const match = (input.match ?? {}) as Record<string, unknown>;
    const setCols = Object.keys(set).map((c) => assertIdent("column", c));
    const matchKeys = Object.keys(match).map((k) => assertIdent("column", k));
    if (!setCols.length) throw new HttpError(400, "수정할 컬럼이 없습니다");
    if (!matchKeys.length) throw new HttpError(400, "match 가 필요합니다(전량 수정 방지)");
    const phys = physicalTableName(appId, table);
    const params: unknown[] = [];
    const setSql = setCols.map((c) => { params.push(set[c]); return `${qi(c)}=$${params.length}`; }).join(",");
    const whereSql = matchKeys.map((k) => { params.push(match[k]); return `${qi(k)}=$${params.length}`; }).join(" AND ");
    const r = await itemsPool.query(`UPDATE app.${qi(phys)} SET ${setSql} WHERE ${whereSql}`, params);
    return { changed: r.rowCount ?? 0 };
  },
};

const storeDelete: Capability = {
  name: "store_delete",
  title: "앱 데이터 삭제",
  description: "앱 자기 데이터 테이블의 행을 삭제(app.<appId>__<table>). 앱 세션/UI 전용. match(컬럼=값 등가, 파라미터화)로 대상 지정 — match 없으면 거부(전량 삭제 방지). 반환 deleted(행수).",
  scope: null,
  input: { table: z.string(), match: z.record(z.unknown()) },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/store/:table/delete"], parse: (req) => { const b = (req.body ?? {}) as Record<string, unknown>; return { table: (req.params as Record<string, string>)?.table, match: b.match }; } }] },
  handler: async (input: Record<string, unknown>, user) => {
    const appId = requireAppPrincipal(user);
    const table = String(input.table ?? "");
    await assertDeclaredTable(appId, table);
    const match = (input.match ?? {}) as Record<string, unknown>;
    const keys = Object.keys(match).map((k) => assertIdent("column", k));
    if (!keys.length) throw new HttpError(400, "match 가 필요합니다(전량 삭제 방지)");
    const phys = physicalTableName(appId, table);
    const where = keys.map((k, i) => `${qi(k)}=$${i + 1}`).join(" AND ");
    const r = await itemsPool.query(`DELETE FROM app.${qi(phys)} WHERE ${where}`, keys.map((k) => match[k]));
    return { deleted: r.rowCount ?? 0 };
  },
};

const storeTables: Capability = {
  name: "store_tables",
  title: "앱 데이터 테이블 목록",
  description: "이 앱이 선언한 데이터 테이블(name·columns) 목록. 앱 세션/UI 전용(자기 앱 스키마 introspection).",
  scope: null,
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/store/tables"], parse: () => ({}) }] },
  handler: async (_input: Record<string, unknown>, user) => {
    const appId = requireAppPrincipal(user);
    const app = await getApp(appId);
    const tables = ((app?.manifest as { data?: { tables?: unknown[] } })?.data?.tables ?? []);
    return { tables };
  },
};

export const appStoreCapabilities: Capability[] = [storeInsert, storeQuery, storeUpdate, storeDelete, storeTables];
