// 스키마 카탈로그 조회(엔진 공통, #715) — db_schema 툴(tools/db.ts) + 관리 스키마 오버레이(delivery.ts) 공용.
//  pg: information_schema(table_schema='public') / mysql: information_schema(table_schema=DATABASE() —
//  커넥션이 소스 url 의 스키마로 고정돼 있어 소스 스키마만 보인다). 메타(이름·타입)만 — 행 데이터 아님.
//  mysql 은 information_schema 컬럼명을 대문자로 돌려줄 수 있어 AS 별칭으로 필드명을 고정한다.
import { getPool } from "./pool.js";
import { getMysqlPool } from "./mysql-engine.js";
import { getSourceConfig } from "./sources.js";

export interface ColumnMeta {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

export async function listTableNames(source: string): Promise<string[]> {
  const cfg = getSourceConfig(source);
  if (!cfg) throw new Error(`알 수 없는 db source '${source}'`);
  if (cfg.driver === "mysql") {
    const pool = await getMysqlPool(source);
    const [rows] = await pool.query(
      `SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name`,
    );
    return (rows as Array<{ table_name: unknown }>).map((r) => String(r.table_name));
  }
  const pool = await getPool(source);
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    return r.rows.map((row) => String((row as { table_name: unknown }).table_name));
  } finally {
    client.release();
  }
}

export async function listColumnsMeta(source: string, table: string): Promise<ColumnMeta[]> {
  const cfg = getSourceConfig(source);
  if (!cfg) throw new Error(`알 수 없는 db source '${source}'`);
  if (cfg.driver === "mysql") {
    const pool = await getMysqlPool(source);
    const [rows] = await pool.query(
      `SELECT column_name AS column_name, data_type AS data_type, is_nullable AS is_nullable
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ?
        ORDER BY ordinal_position`,
      [table],
    );
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      column_name: String(r.column_name),
      data_type: String(r.data_type),
      is_nullable: String(r.is_nullable),
    }));
  }
  const pool = await getPool(source);
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [table],
    );
    return r.rows.map((row) => {
      const o = row as Record<string, unknown>;
      return { column_name: String(o.column_name), data_type: String(o.data_type), is_nullable: String(o.is_nullable) };
    });
  } finally {
    client.release();
  }
}
