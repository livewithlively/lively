import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pg from "pg";
import { getPool } from "../db/pool.js";
import { assertSafeSelect, isSystemDeniedTable } from "../db/firewall.js";
import { auditQuery } from "../db/audit.js";
import { getSourceConfig, listSourceConfigs, resolveSourceName, refreshSources } from "../db/sources.js";
import { refreshPolicy, getSourcePolicy, resolveMaskedAttrs, getMaskStyleMap } from "../db/policy.js";
import { planMaskTargets, applyRowMasking, type FieldMeta } from "../db/mask.js";
import { resolveUser, requireDbSource, canAccessDbSource, hasAnyDbAccess } from "../context.js";

export interface DbQueryResult {
  columns: string[];
  rows: unknown[];
  rowCount: number;
  truncated: boolean;
  fields: FieldMeta[]; // 마스킹(게이트2)용 출처 메타(name/tableID/columnID) — 응답엔 미노출
}

// 읽기 전용 트랜잭션 한 사이클: BEGIN READ ONLY → statement_timeout → (소스가 RLS 면) set_config 주입
//  → 사용자 SELECT → ROLLBACK. pg.PoolClient.query 만 의존하므로 목 클라이언트로 호출 순서·바인딩을
//  단위테스트할 수 있다(src/tools/db.test.ts).
export async function execReadQuery(
  client: Pick<pg.PoolClient, "query">,
  cfg: { rls: string | null; timeoutMs: number; maxRows: number },
  userId: string,
  sql: string,
): Promise<DbQueryResult> {
  await client.query("BEGIN READ ONLY");
  await client.query(`SET LOCAL statement_timeout = ${cfg.timeoutMs}`);
  if (cfg.rls) {
    await client.query("SELECT set_config($1, $2, true)", [cfg.rls, userId]);
  }
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

// db 직접등록 툴(capability 레지스트리 밖) — 웹 도구 토글 후보·http_proxy 섀도잉 차단에 쓰인다.
// registerDbTools 본문의 server.registerTool 이름·title 과 동기 유지.
export const DB_TOOLS = [
  { name: "db_sources", title: "DB 소스 목록",
    description: "이 게이트웨이에 등록된 읽기 데이터소스 목록. db_query/db_schema 의 source 인자에 쓸 이름을 확인한다(접속 URL·자격증명 비노출). admin 은 내장 'self' 소스(게이트웨이 자기 items DB — 지식·프로젝트·도메인맵)가 항상 보인다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "db_schema", title: "DB 스키마 조회",
    description: "테이블/컬럼 메타데이터를 반환한다. table 을 주면 그 컬럼만, 없으면 테이블 목록. source 로 데이터소스를 고른다.",
    inputSchema: { type: "object", properties: { table: { type: "string" }, source: { type: "string" } } } },
  { name: "db_query", title: "읽기 전용 SQL 실행",
    description: "단일 SELECT 문만 실행한다. 결과는 사용자 권한(RLS)에 따라 자동 필터된다. 쓰기/DDL 불가, 행수·실행시간 제한. admin 은 내장 'self' 소스로 이 게이트웨이 자기 콘텐츠(지식·프로젝트·태스크·카테고리·도메인맵)를 별도 등록 없이 SQL 조회 가능(콘텐츠 테이블만 — 시크릿·PII 차단).",
    inputSchema: { type: "object", required: ["sql"], properties: { sql: { type: "string", description: "실행할 단일 SELECT 문" }, source: { type: "string", description: "데이터소스 이름(db_sources 로 확인)" } } } },
] as const;

export function registerDbTools(server: McpServer): void {
  // 등록된 읽기 데이터소스 디스커버리 — 자유 SQL 전에 여기서 소스 이름을 확인한다(접속 URL·자격증명 미노출).
  server.registerTool(
    "db_sources",
    {
      title: "DB 소스 목록",
      description:
        "이 게이트웨이에 등록된 읽기 데이터소스 목록. db_query/db_schema 의 source 인자에 쓸 이름을 여기서 확인한다. 접속 URL·자격증명은 노출하지 않는다. allowed=현재 토큰으로 접근 가능 여부, rls=행수준 격리 적용 여부, origin=env(운영자 직접)|db(웹 관리)|builtin(내장 self — admin 전용, 게이트웨이 자기 items DB: 지식·프로젝트·도메인맵). 등록 소스가 없는 고객 박스에서도 admin 은 self 로 자기 콘텐츠를 조회할 수 있다.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const user = resolveUser(extra);
      if (!hasAnyDbAccess(user)) {
        throw new Error(`Forbidden: user '${user.userId}' lacks any 'db' scope`);
      }
      await refreshSources(); // env∪DB 병합 스냅샷 최신화(웹에서 추가한 소스 즉시 반영)
      const sources = listSourceConfigs().map((s) => ({
        name: s.name,
        driver: s.driver,
        authMode: s.authMode,
        origin: s.origin,
        rls: s.rls !== null, // GUC 이름 자체는 비노출 — 행수준 격리 적용 여부만
        maxRows: s.maxRows,
        timeoutMs: s.timeoutMs,
        allowed: canAccessDbSource(user, s.name),
      }));
      return { content: [{ type: "text", text: JSON.stringify({ sources }, null, 2) }] };
    },
  );

  // 안전한 메타데이터 조회 (RLS 무관). 여기부터 시작하는 걸 권장.
  server.registerTool(
    "db_schema",
    {
      title: "DB 스키마 조회",
      description:
        "테이블/컬럼 메타데이터를 반환합니다. table 을 주면 그 컬럼만, 없으면 테이블 목록. source 로 데이터소스를 고른다(미지정 시 기본 소스 — 다중 등록 시 명시 필요, db_sources 참조).",
      inputSchema: { table: z.string().optional(), source: z.string().optional() },
    },
    async ({ table, source }, extra) => {
      const user = resolveUser(extra);
      await refreshSources();
      await refreshPolicy();
      const src = resolveSourceName(source);
      requireDbSource(user, src);
      const policy = getSourcePolicy(src); // 테이블 정책 오버레이(라이브 스키마 위)
      const masks = getMaskStyleMap(src);
      const pool = await getPool(src);
      const client = await pool.connect();
      try {
        if (table) {
          const tl = table.toLowerCase();
          if (isSystemDeniedTable(tl)) throw new Error(`Blocked table: ${tl} — 게이트웨이 내부 테이블은 조회할 수 없습니다(시스템 차단)`);
          const mode = policy.tableMode.get(tl) ?? policy.tableDefault;
          if (mode === "deny") throw new Error(`Blocked table: ${tl} — 이 소스에서 조회가 허용되지 않은 테이블입니다(웹 관리)`);
          const result = await client.query(
            `SELECT column_name, data_type, is_nullable
               FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1
              ORDER BY ordinal_position`, [table]);
          const rows = result.rows.map((r) => {
            const style = masks.get(`${tl}.${String((r as { column_name: unknown }).column_name).toLowerCase()}`);
            return style ? { ...r, masked: style } : r; // 마스킹 컬럼 표시(에이전트가 파생/필터 회피하도록)
          });
          return { content: [{ type: "text", text: JSON.stringify({ source: src, table, rows }, null, 2) }] };
        }
        const result = await client.query(
          `SELECT table_name
             FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name`);
        // effective-allow 테이블만 노출(시스템 내부 테이블 제외) — allow-list(table_default='deny') 모드면 허용된 것만 보인다.
        const rows = result.rows.filter((r) => {
          const tn = String((r as { table_name: unknown }).table_name).toLowerCase();
          if (isSystemDeniedTable(tn)) return false;
          return (policy.tableMode.get(tn) ?? policy.tableDefault) === "allow";
        });
        return { content: [{ type: "text", text: JSON.stringify({ source: src, rows }, null, 2) }] };
      } finally {
        client.release();
      }
    },
  );

  // 자유 SQL — 여러 겹의 가드 위에서만 동작한다.
  server.registerTool(
    "db_query",
    {
      title: "읽기 전용 SQL 실행",
      description:
        "단일 SELECT 문만 실행합니다. 결과는 사용자 권한(RLS)에 따라 자동 필터됩니다. 쓰기/DDL 불가, 결과 행수·실행시간 제한이 적용됩니다. source 로 데이터소스를 고른다(미지정 시 기본 소스 — 다중 등록 시 명시 필요, db_sources 참조). admin 은 내장 'self' 소스로 이 게이트웨이 자기 콘텐츠(지식·프로젝트·태스크·카테고리·도메인맵)를 별도 등록 없이 SQL 조회할 수 있습니다(콘텐츠 테이블만 — 시크릿·개인정보 차단). 예: db_query({source:'self', sql:'select count(*) from knowledge'}).",
      inputSchema: {
        sql: z.string().describe("실행할 단일 SELECT 문"),
        source: z.string().optional().describe("데이터소스 이름(db_sources 로 확인)"),
      },
    },
    async ({ sql, source }, extra) => {
      const user = resolveUser(extra);
      await refreshSources();
      await refreshPolicy();
      const src = resolveSourceName(source);
      requireDbSource(user, src); // 방어선 0: 소스별 권한
      const policy = getSourcePolicy(src);
      const plan = assertSafeSelect(sql, policy); // 방어선 1·2 + 게이트1(테이블 allow/deny · 마스킹-파생 차단)
      const cfg = getSourceConfig(src);
      if (!cfg) throw new Error(`db source '${src}' 설정을 찾을 수 없습니다`); // 리프레시-삭제 경합 방어

      const started = Date.now();
      const pool = await getPool(src);
      const client = await pool.connect();
      try {
        let out = await execReadQuery(client, cfg, user.userId, sql);
        let masked = 0;
        if (policy.hasMasks) {
          // 게이트2 — DB 가 알려주는 출처(oid:attnum)로 마스킹 대상 식별해 게이트웨이에서 값 마스킹(고객 DB 무수정).
          const attr = await resolveMaskedAttrs(src, pool);
          const targets = planMaskTargets(out.fields, attr);
          // fail-closed — 게이트1 기대 마스킹 출력에 미달(뷰/무출처 등)하면 유출 대신 거부.
          if (targets.length < plan.minMaskedOutputs || (plan.hasTopStarOverMaskedTable && targets.length === 0)) {
            throw new Error("마스킹 검증 실패 — 개인정보 컬럼의 출처를 확인할 수 없어 쿼리를 거부합니다(컬럼을 명시하거나 관리자에게 문의)");
          }
          if (targets.length > 0) out = { ...out, rows: applyRowMasking(out.rows as unknown[][], targets) };
          masked = targets.length;
        }
        auditQuery({ userId: user.userId, source: src, sql, rowCount: out.rowCount, ms: Date.now() - started, ok: true, masked });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              { source: src, columns: out.columns, rows: out.rows, rowCount: out.rowCount, truncated: out.truncated, ...(masked ? { masked } : {}) },
              null, 2),
          }],
        };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        auditQuery({
          userId: user.userId,
          source: src,
          sql,
          rowCount: 0,
          ms: Date.now() - started,
          ok: false,
          error: (e as Error).message,
        });
        throw e;
      } finally {
        client.release();
      }
    },
  );
}
