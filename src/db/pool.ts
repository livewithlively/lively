import pg from "pg";

// 반드시 읽기 전용 리플리카 + 읽기 전용 role 로 접속할 것 (.env DATABASE_URL).
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});
