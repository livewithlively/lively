// db_query 읽기 실행 행동 체크 — 목 client 로 호출 순서·RLS 주입·truncate 검증(DB 불필요).
//  mysql 엔진(#715)도 동일 패턴: SET max_execution_time→RO tx→SELECT(rowsAsArray)→ROLLBACK 순서 +
//  srcKey(orgTable.orgName) 매핑 + 오류 시 destroy(풀 반환 금지).
// 실행: npm run build && node dist/tools/db.test.js
import assert from "node:assert/strict";
import type pg from "pg";
import { execReadQuery, enrichSchemaError, unknownTableMessage, MAX_ENRICH_TABLE_LOOKUPS } from "../db/query-exec.js";
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

// #1291 v3 — self 행 단위 RLS. **순서가 곧 보안이다**: 사용자 SQL 보다 먼저 비특권 롤로 내려가지 않으면
//  그 SQL 이 소유자 권한으로 돌아 정책을 통째로 통과한다(소유자는 RLS 를 안 탄다). 여기서 순서를 못박는다.
await t("#1291 self: SET LOCAL ROLE 이 사용자 SQL **앞에** 온다", async () => {
  const { client, calls } = mockClient([[1]]);
  await execReadQuery(client, { rls: null, timeoutMs: 5000, maxRows: 10, asRole: "lively_reader" },
    "yoon", "SELECT id FROM project");
  const texts = calls.map((c) => sqlText(c.text));
  const roleAt = texts.findIndex((x) => x.includes("SET LOCAL ROLE"));
  const sqlAt = texts.findIndex((x) => x.includes("FROM project"));
  assert.ok(roleAt >= 0, "롤 전환이 아예 없다");
  assert.ok(roleAt < sqlAt, `롤 전환이 사용자 SQL 뒤에 있다(${roleAt} > ${sqlAt})`);
  assert.equal(texts[texts.length - 1], "ROLLBACK");
});

await t("#1291 self: asRole 이 없으면 롤을 안 바꾼다(등록 소스 회귀 방지)", async () => {
  const { client, calls } = mockClient([[1]]);
  await execReadQuery(client, { rls: null, timeoutMs: 5000, maxRows: 10 }, "yoon", "SELECT 1");
  assert.ok(!calls.some((c) => sqlText(c.text).includes("SET LOCAL ROLE")));
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

// ══════════ 조회 실패 에러 보강(#1259) — enrichSchemaError 배선 ══════════
//  '어느 에러가 어떤 보강을 타는가'가 계약이다. 카탈로그 접근만 주입해 DB 없이 검증한다.
//  실측 배경: 없는 테이블명을 '권한 없음'으로 답해 CTO 권한확대 요청까지 에스컬레이션됐다.
const HF = ["d_seq", "d_realization", "d_charge", "p_deal", "d_received_borrower_fee"];
const catalogOf = (allowed: string[], extraExisting: string[] = []) =>
  async () => ({ all: new Set([...allowed, ...extraExisting].map((n) => n.toLowerCase())), allowed });
const denyErr = (table: string): Error =>
  Object.assign(new Error(`Blocked table: ${table} — 이 소스에서 조회가 허용되지 않은 테이블입니다(웹에서 허용 설정 필요)`), { blockedTable: table });

await t("보강①: 카탈로그에 없는 테이블 → '없음'+유사후보(권한 문구 제거)", async () => {
  const out = await enrichSchemaError(denyErr("d_deal_seq"), "example-ro", ["d_deal_seq"], { catalog: catalogOf(HF) });
  assert.match(out.message, /Unknown table: d_deal_seq/);
  assert.match(out.message, /권한 문제가 아닙니다/);
  assert.match(out.message, /d_seq/);
  assert.doesNotMatch(out.message, /허용 설정 필요/);
});

await t("보강①: 카탈로그에 있으면(진짜 정책 deny) 원문 그대로 — 같은 객체", async () => {
  const err = denyErr("fsb_invest_send_queue");
  const out = await enrichSchemaError(err, "example-ro", ["fsb_invest_send_queue"], {
    catalog: catalogOf(HF, ["fsb_invest_send_queue"]), // 존재하지만 allow 아님
  });
  assert.equal(out, err, "정책 deny 는 문구를 바꾸지 않는다");
  assert.match(out.message, /허용 설정 필요/);
});

await t("보강①: 후보는 allow 목록에서만 — deny 테이블 이름을 흘리지 않는다(통제 합의사항)", async () => {
  // 'd_realization_view' 는 존재하지만 allow 가 아니다. 질의와 토큰이 하나 더 겹쳐 allow 후보
  //  (d_realization)보다 점수가 높으므로, 후보 출처가 allow 목록이 아니면 반드시 1순위로 새어나온다.
  const out = await enrichSchemaError(denyErr("d_realization_view_x"), "example-ro", [], {
    catalog: catalogOf(HF, ["d_realization_view"]),
  });
  const seg = out.message.split("이름이 비슷한 테이블: ")[1]?.split(". ")[0] ?? "";
  const suggested = seg.split(", ").filter((s) => s.length > 0);
  assert.ok(suggested.length > 0, "후보가 하나는 나와야 시험이 성립한다");
  for (const s of suggested) assert.ok(HF.includes(s), `allow 아닌 이름이 후보로 노출됨: ${s}`);
});

await t("보강②: 없는 컬럼 → 참조 테이블의 실제 컬럼 동봉", async () => {
  const out = await enrichSchemaError(
    new Error("Unknown column 'deal_uid' in 'where clause'"), "example-ro",
    ["d_realized_accruing_borrower_fee"],
    { columns: async () => ["deal_realization_uid", "amount"] },
  );
  assert.match(out.message, /deal_realization_uid/);
  assert.match(out.message, /amount/);
});

await t("보강②: 참조 테이블이 없으면 원문 그대로(카탈로그 조회 0회)", async () => {
  const err = new Error("Unknown column 'deal_uid' in 'where clause'");
  let hits = 0;
  const out = await enrichSchemaError(err, "example-ro", [], { columns: async () => { hits++; return []; } });
  assert.equal(out, err);
  assert.equal(hits, 0, "참조 테이블이 없으면 카탈로그를 건드리지 않는다");
});

await t(`보강②: 참조 테이블이 많아도 카탈로그 왕복은 ${MAX_ENRICH_TABLE_LOOKUPS}회 상한`, async () => {
  let hits = 0;
  const many = Array.from({ length: 12 }, (_, i) => `t${i}`);
  await enrichSchemaError(new Error("Unknown column 'zz' in 'where clause'"), "s", many,
    { columns: async () => { hits++; return ["a"]; } });
  assert.equal(hits, MAX_ENRICH_TABLE_LOOKUPS);
});

await t("보강 실패(카탈로그 오류)는 원인을 삼키지 않는다 — 원문 그대로", async () => {
  const err = denyErr("d_deal_seq");
  const out = await enrichSchemaError(err, "example-ro", [], {
    catalog: async () => { throw new Error("카탈로그 조회 실패"); },
  });
  assert.equal(out, err);
});

await t("무관한 에러는 손대지 않는다(타임아웃 등) — 카탈로그 조회 0회", async () => {
  const err = new Error("Query execution was interrupted, maximum statement execution time exceeded");
  let hits = 0;
  const out = await enrichSchemaError(err, "example-ro", ["rclips_css_history"], {
    catalog: async () => { hits++; return { all: new Set<string>(), allowed: [] }; },
    columns: async () => { hits++; return []; },
  });
  assert.equal(out, err);
  assert.equal(hits, 0);
});

await t("보강된 에러도 감사용 tables 를 유지한다(차단 테이블 추적 유지)", async () => {
  const out = await enrichSchemaError(denyErr("d_deal_seq"), "example-ro", ["d_deal_seq", "p_deal"], { catalog: catalogOf(HF) });
  assert.deepEqual((out as Error & { tables?: string[] }).tables, ["d_deal_seq", "p_deal"]);
});

await t("unknownTableMessage: 대소문자 무시로 존재 판별", async () => {
  assert.equal(await unknownTableMessage("s", "D_SEQ", catalogOf(HF)), null);
});

console.log(`\n${pass} checks passed`);
