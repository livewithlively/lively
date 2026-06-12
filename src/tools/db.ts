import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pool } from "../db/pool.js";
import { assertSafeSelect } from "../db/firewall.js";
import { auditQuery } from "../db/audit.js";
import { resolveUser, requireScope } from "../context.js";

const MAX_ROWS = Number(process.env.DB_MAX_ROWS ?? 1000);
const TIMEOUT_MS = Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 5000);

export function registerDbTools(server: McpServer): void {
  // 안전한 메타데이터 조회 (RLS 무관). 여기부터 시작하는 걸 권장.
  server.registerTool(
    "db_schema",
    {
      title: "DB 스키마 조회",
      description: "테이블/컬럼 메타데이터를 반환합니다. table 을 주면 그 컬럼만, 없으면 테이블 목록.",
      inputSchema: { table: z.string().optional() },
    },
    async ({ table }, extra) => {
      const user = resolveUser(extra);
      requireScope(user, "db");
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
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
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
        "단일 SELECT 문만 실행합니다. 결과는 사용자 권한(RLS)에 따라 자동 필터됩니다. 쓰기/DDL 불가, 결과 행수·실행시간 제한이 적용됩니다.",
      inputSchema: { sql: z.string().describe("실행할 단일 SELECT 문") },
    },
    async ({ sql }, extra) => {
      const user = resolveUser(extra);
      requireScope(user, "db");
      assertSafeSelect(sql); // 방어선 1·2: 쿼리 방화벽

      const started = Date.now();
      const client = await pool.connect();
      try {
        // 읽기 전용 트랜잭션 + 문 타임아웃 + 사용자 주입(RLS 가 참조)
        await client.query("BEGIN READ ONLY");
        await client.query(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
        await client.query("SELECT set_config('app.current_user', $1, true)", [user.userId]);

        const result = await client.query({ text: sql, rowMode: "array" });
        const rows = result.rows.slice(0, MAX_ROWS);
        const truncated = result.rows.length > MAX_ROWS;

        await client.query("ROLLBACK"); // 읽기 전용 → 항상 롤백

        const ms = Date.now() - started;
        auditQuery({ userId: user.userId, sql, rowCount: rows.length, ms, ok: true });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { columns: result.fields.map((f) => f.name), rows, rowCount: rows.length, truncated },
                null,
                2,
              ),
            },
          ],
        };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        auditQuery({
          userId: user.userId,
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
