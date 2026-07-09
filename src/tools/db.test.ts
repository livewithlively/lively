// db_query 읽기 실행 행동 체크 — 목 client 로 호출 순서·RLS 주입·truncate 검증(DB 불필요).
//  mysql 엔진(#715)도 동일 패턴: SET max_execution_time→RO tx→SELECT(rowsAsArray)→ROLLBACK 순서 +
//  srcKey(orgTable.orgName) 매핑 + 오류 시 destroy(풀 반환 금지).
// 실행: npm run build && node dist/tools/db.test.js
import assert from "node:assert/strict";
import type pg from "pg";
import { execReadQuery } from "./db.js";
import { execReadQueryMysql, type MysqlConnLike, type MysqlPoolLike } from "../db/mysql-engine.js";

interface Call {
  text: unknown;
  values: unknown;
}
function mockClient(selectRows: unknown[], fields: { name: string }[] = [{ name: "id" }]) {
  const calls: Call[] = [];
  const query = async (arg1: unknown, arg2?: unknown) => {
    calls.push({ text: arg1, values: arg2 });
    // SELECT 는 항상 { text, rowMode } 객체로 들어온다 — 그때만 rows/fields 를 돌려준다.
    if (arg1 !== null && typeof arg1 === "object") return { rows: selectRows, fields };
    return { rows: [], fields: [] };
  };
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, calls };
}

const sqlText = (t: unknown): string => (typeof t === "string" ? t : ((t as { text?: string })?.text ?? ""));

let pass = 0;
const t = (name: string, fn: () => Promise<void>): Promise<void> =>
  fn().then(() => {
    pass++;
    console.log(`ok  ${name}`);
  });

await t("rls 소스: BEGIN→timeout→set_config→SELECT→ROLLBACK 순서 + 바인딩", async () => {
  const { client, calls } = mockClient([[1], [2]]);
  const out = await execReadQuery(
    client,
    { rls: "app.current_user", timeoutMs: 5000, maxRows: 10 },
    "yoon",
    "SELECT id FROM t",
  );
  assert.deepEqual(calls.map((c) => sqlText(c.text)), [
    "BEGIN READ ONLY",
    "SET LOCAL statement_timeout = 5000",
    "SELECT set_config($1, $2, true)",
    "SELECT id FROM t",
    "ROLLBACK",
  ]);
  assert.deepEqual(calls[2].values, ["app.current_user", "yoon"]); // GUC 이름·userId 바인딩
  assert.equal(out.rowCount, 2);
  assert.equal(out.truncated, false);
  assert.deepEqual(out.columns, ["id"]);
});

await t("rls=null 소스: set_config 주입 0회", async () => {
  const { client, calls } = mockClient([[1]]);
  await execReadQuery(client, { rls: null, timeoutMs: 1000, maxRows: 10 }, "yoon", "SELECT 1");
  assert.equal(calls.some((c) => sqlText(c.text).includes("set_config")), false);
  assert.deepEqual(calls.map((c) => sqlText(c.text)), [
    "BEGIN READ ONLY",
    "SET LOCAL statement_timeout = 1000",
    "SELECT 1",
    "ROLLBACK",
  ]);
});

await t("maxRows 초과 → truncated=true, rows 잘림", async () => {
  const { client } = mockClient([[1], [2], [3]]);
  const out = await execReadQuery(client, { rls: null, timeoutMs: 1000, maxRows: 2 }, "yoon", "SELECT id FROM t");
  assert.equal(out.rowCount, 2);
  assert.equal(out.truncated, true);
});

// ══════════ mysql 엔진(#715) — execReadQueryMysql ══════════
interface MyCall { opts: unknown }
function mockMysqlPool(rows: unknown[][], fields: Array<Record<string, unknown>>, opt?: { failOnSelect?: boolean }) {
  const calls: MyCall[] = [];
  let released = false;
  let destroyed = false;
  const conn: MysqlConnLike = {
    query: async (opts) => {
      calls.push({ opts });
      if (typeof opts === "object") {
        if (opt?.failOnSelect) throw new Error("boom");
        return [rows, fields];
      }
      return [[], []];
    },
    release: () => { released = true; },
    destroy: () => { destroyed = true; },
  };
  const pool: MysqlPoolLike = { getConnection: async () => conn };
  return { pool, calls, state: () => ({ released, destroyed }) };
}
const myText = (o: unknown): string => (typeof o === "string" ? o : ((o as { sql?: string })?.sql ?? ""));

await t("mysql: SET max_execution_time→RO tx→SELECT(rowsAsArray·timeout)→ROLLBACK 순서 + release", async () => {
  const { pool, calls, state } = mockMysqlPool([[1], [2]], [{ name: "id", orgTable: "t", orgName: "id", schema: "hf" }]);
  const out = await execReadQueryMysql(pool, { timeoutMs: 5000, maxRows: 10, database: "hf" }, "SELECT id FROM t");
  assert.deepEqual(calls.map((c) => myText(c.opts)), [
    "SET SESSION max_execution_time=5000",
    "START TRANSACTION READ ONLY",
    "SELECT id FROM t",
    "ROLLBACK",
  ]);
  const sel = calls[2].opts as { rowsAsArray?: boolean; timeout?: number };
  assert.equal(sel.rowsAsArray, true);
  assert.equal(sel.timeout, 6000); // 클라 백스톱 = 서버 타임아웃 + 1000ms
  assert.equal(out.rowCount, 2);
  assert.deepEqual(out.columns, ["id"]);
  assert.deepEqual(state(), { released: true, destroyed: false });
});

await t("mysql: srcKey 매핑 — 원본(orgTable.orgName) lower / 표현식 null / 스키마 불일치 null", async () => {
  const { pool } = mockMysqlPool([[1, "x", "y", "z"]], [
    { name: "x", orgTable: "Tb_Cr_Error", orgName: "SSN", schema: "hf" }, // 별칭이어도 원본 — lower 매핑
    { name: "s", orgTable: "", orgName: "", schema: "" }, // 표현식 — 무출처
    { name: "sec", orgTable: "tb_other", orgName: "secret", schema: "otherdb" }, // 스키마 불일치 — fail-closed
    { name: "id", orgTable: "tb_cr_error", orgName: "id", db: "hf" }, // schema 대신 db 프로퍼티 폴백
  ]);
  const out = await execReadQueryMysql(pool, { timeoutMs: 1000, maxRows: 10, database: "hf" }, "SELECT 1");
  assert.deepEqual(out.fields.map((f) => f.srcKey), ["tb_cr_error.ssn", null, null, "tb_cr_error.id"]);
});

await t("mysql: maxRows 초과 → truncated + 잘림", async () => {
  const { pool } = mockMysqlPool([[1], [2], [3]], [{ name: "id", orgTable: "t", orgName: "id" }]);
  const out = await execReadQueryMysql(pool, { timeoutMs: 1000, maxRows: 2, database: null }, "SELECT id FROM t");
  assert.equal(out.rowCount, 2);
  assert.equal(out.truncated, true);
});

await t("mysql: 쿼리 오류 → destroy(풀 반환 금지), release 안 함", async () => {
  const { pool, state } = mockMysqlPool([], [], { failOnSelect: true });
  await assert.rejects(() => execReadQueryMysql(pool, { timeoutMs: 1000, maxRows: 10, database: null }, "SELECT 1"), /boom/);
  assert.deepEqual(state(), { released: false, destroyed: true });
});

console.log(`\n${pass} checks passed`);
