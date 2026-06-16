import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pg from "pg";
import { getPool } from "../db/pool.js";
import { assertSafeSelect } from "../db/firewall.js";
import { auditQuery } from "../db/audit.js";
import { getSourceConfig, listSourceConfigs, resolveSourceName, refreshSources } from "../db/sources.js";
import { resolveUser, requireDbSource, canAccessDbSource, hasAnyDbAccess } from "../context.js";

export interface DbQueryResult {
  columns: string[];
  rows: unknown[];
  rowCount: number;
  truncated: boolean;
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
  return { columns: result.fields.map((f) => f.name), rows, rowCount: rows.length, truncated };
}

export function registerDbTools(server: McpServer): void {
  // 등록된 읽기 데이터소스 디스커버리 — 자유 SQL 전에 여기서 소스 이름을 확인한다(접속 URL·자격증명 미노출).
  server.registerTool(
    "db_sources",
    {
      title: "DB 소스 목록",
      description:
        "이 게이트웨이에 등록된 읽기 데이터소스 목록. db_query/db_schema 의 source 인자에 쓸 이름을 여기서 확인한다. 접속 URL·자격증명은 노출하지 않는다. allowed=현재 토큰으로 접근 가능 여부, rls=행수준 격리 적용 여부, origin=env(운영자 직접)|db(웹 관리).",
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
      const src = resolveSourceName(source);
      requireDbSource(user, src);
      const pool = await getPool(src);
      const client = await pool.connect();
      try {
        const sql = table
          ? `SELECT column_name, data_type, is_nullable
               FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1
              ORDER BY ordinal_position`
          : `SELECT table_name
               FROM information_schema.tables
              WHERE table_schema = 'public'
              ORDER BY table_name`;
        const result = await client.query(sql, table ? [table] : []);
        return { content: [{ type: "text", text: JSON.stringify({ source: src, rows: result.rows }, null, 2) }] };
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
        "단일 SELECT 문만 실행합니다. 결과는 사용자 권한(RLS)에 따라 자동 필터됩니다. 쓰기/DDL 불가, 결과 행수·실행시간 제한이 적용됩니다. source 로 데이터소스를 고른다(미지정 시 기본 소스 — 다중 등록 시 명시 필요, db_sources 참조).",
      inputSchema: {
        sql: z.string().describe("실행할 단일 SELECT 문"),
        source: z.string().optional().describe("데이터소스 이름(db_sources 로 확인)"),
      },
    },
    async ({ sql, source }, extra) => {
      const user = resolveUser(extra);
      await refreshSources();
      const src = resolveSourceName(source);
      requireDbSource(user, src); // 방어선 0: 소스별 권한
      assertSafeSelect(sql); // 방어선 1·2: 쿼리 방화벽
      const cfg = getSourceConfig(src);
      if (!cfg) throw new Error(`db source '${src}' 설정을 찾을 수 없습니다`); // 리프레시-삭제 경합 방어

      const started = Date.now();
      const pool = await getPool(src);
      const client = await pool.connect();
      try {
        const out = await execReadQuery(client, cfg, user.userId, sql);
        auditQuery({ userId: user.userId, source: src, sql, rowCount: out.rowCount, ms: Date.now() - started, ok: true });
        return { content: [{ type: "text", text: JSON.stringify({ source: src, ...out }, null, 2) }] };
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
