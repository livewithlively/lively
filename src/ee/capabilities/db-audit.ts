// db 접근 감사 표면(P5, #746) — db_access_log 조회/체인검증 + 조회대상 식별자(subject key) 설정.
//  scope=admin(모든 구성원의 데이터 접근 내역·SQL 노출 — 게이트웨이 운영/컴플라이언스 표면).
//  MCP+REST 동시 노출: 관리자·감사 담당의 에이전트가 MCP 로 직접 조회할 수 있고(중앙박스/로컬 kit 동일),
//  관리탭 대시보드는 REST 를 소비한다. 기록 쓰기는 여기 없다 — 단일 진입점은 src/db/access-log.ts(체인 INSERT).
import { z } from "zod";
import type { Capability } from "../../capabilities/types.js";
import { itemsPool } from "../../db/client.js";
import { HttpError, qint, qiso, qstr } from "../../capabilities/rest-util.js";
import { GENESIS, computeRowHash, type HashedRowFields } from "../db/access-log.js";
import { listSubjectKeys, upsertSubjectKey, removeSubjectKey } from "../../org/store.js";

// ── 입력 정규화(어댑터 공용) — MCP(zod 통과값)·REST(qstr/qint 통과값) 둘 다 받는다. ──
function s(v: unknown, max = 200): string {
  if (v === undefined || v === null) return "";
  const t = String(v).trim();
  if (t.length > max) throw new HttpError(400, `인자가 ${max}자를 초과합니다`);
  return t;
}
function n(v: unknown, def: number, min: number, max: number): number {
  if (v === undefined || v === null || v === "") return def;
  const x = Number(v);
  if (!Number.isFinite(x)) return def;
  return Math.min(Math.max(Math.floor(x), min), max);
}
function b(v: unknown): boolean {
  return v === true || v === "true" || v === "1" || v === 1;
}
function iso(v: unknown, name: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  const t = String(v);
  if (Number.isNaN(Date.parse(t))) throw new HttpError(400, `${name} 은(는) ISO8601 형식이어야 합니다`);
  return t;
}

interface AccessRow {
  id: string; at: string; user_id: string; token_hash_prefix: string | null; harness: string | null;
  op: string; source: string; sql: string | null; tables: string[]; masked_columns: string[];
  unmasked_columns: string[]; grant_ids: unknown; subject_keys: unknown;
  row_count: number; duration_ms: number | null; ok: boolean; error: string | null;
  prev_hash: string; row_hash: string;
}

// DB 행 → 해시 본문 복원(writeAccessRow 와 동일 형태) — 검증의 핵심. at 은 timestamptz→ISO(ms) 왕복 재현.
function toHashedFields(r: AccessRow): HashedRowFields {
  return {
    at: new Date(r.at).toISOString(),
    userId: r.user_id,
    tokenHashPrefix: r.token_hash_prefix,
    harness: r.harness,
    op: r.op,
    source: r.source,
    sql: r.sql,
    tables: r.tables ?? [],
    maskedColumns: r.masked_columns ?? [],
    unmaskedColumns: r.unmasked_columns ?? [],
    grantIds: r.grant_ids ?? null,
    subjectKeys: r.subject_keys ?? null,
    rowCount: r.row_count,
    durationMs: r.duration_ms,
    ok: r.ok,
    error: r.error,
  };
}

const dbAuditList: Capability = {
  name: "db_audit_list",
  title: "DB 접근 감사 조회",
  description:
    "db_query/db_schema 데이터 접근 감사(db_access_log)를 조회한다 — 누가·언제·어느 소스의 어떤 테이블을 조회했고 무엇이 마스킹됐는지, 조회 대상 식별자(subject_keys)까지. 차단·실패 시도(ok=false)도 남는다. 필터: user·source·table·op(query|schema)·errors(실패만)·since/until(ISO). 위변조 검증은 db_audit_verify.",
  scope: "admin",
  input: {
    user: z.string().optional().describe("조회자(user_id) 필터"),
    source: z.string().optional().describe("데이터소스 이름 필터"),
    table: z.string().optional().describe("접촉 테이블 필터(정확 일치, lower)"),
    op: z.enum(["query", "schema"]).optional(),
    errors: z.boolean().optional().describe("true=실패/차단만"),
    since: z.string().optional().describe("ISO8601 하한"),
    until: z.string().optional().describe("ISO8601 상한"),
    limit: z.number().int().optional().describe("기본 50, 최대 500"),
    offset: z.number().int().optional(),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "GET",
      paths: ["/api/ui/db-audit"],
      parse: (req) => ({
        user: qstr(req.query?.user, "user"),
        source: qstr(req.query?.source, "source"),
        table: qstr(req.query?.table, "table"),
        op: qstr(req.query?.op, "op", 16),
        errors: req.query?.errors,
        since: qiso(req.query?.since),
        until: req.query?.until === undefined ? undefined : String(req.query?.until),
        limit: qint(req.query?.limit, "limit", 50, 1, 500),
        offset: qint(req.query?.offset, "offset", 0, 0, 1_000_000),
      }),
    }],
  },
  handler: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const user = s(i.user);
    const source = s(i.source);
    const table = s(i.table).toLowerCase();
    const op = s(i.op, 16);
    if (op && op !== "query" && op !== "schema") throw new HttpError(400, "op 은 query|schema 만 허용됩니다");
    const errorsOnly = b(i.errors);
    const since = iso(i.since, "since");
    const until = iso(i.until, "until");
    const limit = n(i.limit, 50, 1, 500);
    const offset = n(i.offset, 0, 0, 1_000_000);

    // ⚠ 이 필터는 CSV 내보내기(audit-export-routes.ts, kind=db)가 같은 의미로 복제한다 — 화면과 CSV 가 다르면
    //  감사 자료로 못 쓴다. 여기를 고치면 거기도 같이 고칠 것.
    const where = `WHERE ($1 = '' OR user_id = $1)
                     AND ($2 = '' OR source = $2)
                     AND ($3 = '' OR tables ? $3)
                     AND ($4 = '' OR op = $4)
                     AND (NOT $5::bool OR ok = false)
                     AND ($6::timestamptz IS NULL OR at >= $6)
                     AND ($7::timestamptz IS NULL OR at <= $7)`;
    const params: unknown[] = [user, source, table, op, errorsOnly, since, until];
    const [rows, total] = await Promise.all([
      itemsPool.query(
        `SELECT id, at, user_id, token_hash_prefix, harness, op, source, sql, tables, masked_columns,
                unmasked_columns, grant_ids, subject_keys, row_count, duration_ms, ok, error, row_hash
           FROM db_access_log ${where}
          ORDER BY id DESC LIMIT $8 OFFSET $9`,
        [...params, limit, offset],
      ),
      itemsPool.query(`SELECT count(*)::int8 AS c FROM db_access_log ${where}`, params),
    ]);
    return {
      rows: rows.rows,
      total: Number(total.rows[0]?.c ?? 0),
      limit, offset,
      filters: { user: user || null, source: source || null, table: table || null, op: op || null, errorsOnly, since, until },
    };
  },
};

const dbAuditVerify: Capability = {
  name: "db_audit_verify",
  title: "DB 접근 감사 체인 검증",
  description:
    "db_access_log 해시체인을 재계산해 위변조 여부를 검증한다(after_id 이후 구간, 기본 5000행씩). broken 이 나오면 그 행 이후의 기록 무결성을 신뢰할 수 없다는 뜻 — 즉시 운영자 확인. 전 구간 검증은 after_id 를 이어가며 반복 호출.",
  scope: "admin",
  input: {
    after_id: z.number().int().optional().describe("이 id 이후부터 검증(기본 0=처음부터)"),
    limit: z.number().int().optional().describe("검증할 행 수(기본 5000, 최대 50000)"),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "GET",
      paths: ["/api/ui/db-audit/verify"],
      parse: (req) => ({
        after_id: qint(req.query?.after_id, "after_id", 0, 0, Number.MAX_SAFE_INTEGER),
        limit: qint(req.query?.limit, "limit", 5000, 1, 50_000),
      }),
    }],
  },
  handler: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const afterId = n(i.after_id, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = n(i.limit, 5000, 1, 50_000);

    // 앵커 — after_id 이하 마지막 행의 row_hash(없으면 GENESIS). id 순서 = 체인 순서(advisory lock 직렬화).
    const anchor = afterId > 0
      ? await itemsPool.query(`SELECT row_hash FROM db_access_log WHERE id <= $1 ORDER BY id DESC LIMIT 1`, [afterId])
      : { rows: [] as Array<{ row_hash: string }> };
    let expectedPrev: string = (anchor.rows[0]?.row_hash as string | undefined) ?? GENESIS;

    const r = await itemsPool.query(
      `SELECT id, at, user_id, token_hash_prefix, harness, op, source, sql, tables, masked_columns,
              unmasked_columns, grant_ids, subject_keys, row_count, duration_ms, ok, error, prev_hash, row_hash
         FROM db_access_log WHERE id > $1 ORDER BY id ASC LIMIT $2`,
      [afterId, limit],
    );
    let broken: { id: string; reason: string } | null = null;
    let lastId = afterId;
    for (const raw of r.rows as AccessRow[]) {
      lastId = Number(raw.id);
      if (raw.prev_hash !== expectedPrev) { broken = { id: String(raw.id), reason: "prev_hash 불일치(체인 절단)" }; break; }
      const recomputed = computeRowHash(expectedPrev, toHashedFields(raw));
      if (recomputed !== raw.row_hash) { broken = { id: String(raw.id), reason: "row_hash 불일치(본문 변조)" }; break; }
      expectedPrev = raw.row_hash;
    }
    return {
      ok: broken === null,
      checked: r.rows.length,
      from_id: afterId,
      to_id: lastId,
      has_more: r.rows.length === limit && broken === null,
      ...(broken ? { broken } : {}),
    };
  },
};

const subjectKeysList: Capability = {
  name: "org_db_subject_keys",
  title: "감사 대상 식별자 컬럼 목록",
  description:
    "db 접근 감사(P5)가 '조회 대상 식별자'로 수집하는 컬럼 지정 목록(org_db_subject_key). source 로 필터.",
  scope: "admin",
  input: { source: z.string().optional() },
  expose: {
    mcp: true,
    rest: [{
      method: "GET",
      paths: ["/api/ui/org/db-source/subject-keys"],
      parse: (req) => ({ source: qstr(req.query?.source, "source") }),
    }],
  },
  handler: async (input) => {
    const src = s((input as Record<string, unknown> | undefined)?.source);
    return { keys: await listSubjectKeys(src || undefined) };
  },
};

const subjectKeySet: Capability = {
  name: "org_db_subject_key_set",
  title: "감사 대상 식별자 컬럼 지정/해제",
  description:
    "db 접근 감사(P5)가 수집할 '조회 대상 식별자' 컬럼을 지정한다(remove=true 면 해제). ⚠ 서로게이트 키(고객ID 등)만 지정 — 민감 원값 컬럼(주민번호·계좌 등)을 지정하면 감사로그가 PII 저장소가 된다(금지).",
  scope: "admin",
  input: {
    source: z.string().describe("데이터소스 이름"),
    table: z.string().describe("테이블명"),
    column: z.string().describe("컬럼명"),
    note: z.string().optional(),
    remove: z.boolean().optional().describe("true=지정 해제"),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "POST",
      paths: ["/api/ui/org/db-source/subject-key"],
      parse: (req) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        return { source: body.source, table: body.table, column: body.column, note: body.note, remove: body.remove };
      },
    }],
  },
  handler: async (input, user) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const source = s(i.source, 128);
    const table = s(i.table, 128).toLowerCase();
    const column = s(i.column, 128).toLowerCase();
    const note = s(i.note, 500);
    if (!source || !table || !column) throw new HttpError(400, "source·table·column 은 필수입니다");
    if (b(i.remove)) {
      await removeSubjectKey(source, table, column, user.userId);
      return { ok: true, removed: true, source, table, column };
    }
    await upsertSubjectKey({ source, table_name: table, column_name: column, note: note || null }, user.userId);
    return { ok: true, source, table, column };
  },
};

export const dbAuditCapabilities: Capability[] = [dbAuditList, dbAuditVerify, subjectKeysList, subjectKeySet];
