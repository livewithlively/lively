// db_query 읽기 실행 행동 체크 — 목 client 로 호출 순서·RLS 주입·truncate 검증(DB 불필요).
// 실행: npm run build && node dist/tools/db.test.js
import assert from "node:assert/strict";
import type pg from "pg";
import { execReadQuery } from "./db.js";

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

console.log(`\n${pass} checks passed`);
