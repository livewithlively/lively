import { strict as assert } from "node:assert";
import test from "node:test";
import { planAppSql, wrapForCaps, forbiddenFunction } from "./app-sql.js";
import { TokenBuckets, KeyedSemaphore, shapeResult, appSqlLimits } from "./app-sql-exec.js";
import { appSqlRoleName, appIndexName } from "./store-ddl.js";

// 앱 자유 SQL(#4226) — 「입력 × 기대」 엣지 표(P·W·G·N 행). 경계는 DB 역할이지만, 역할을 되돌리는 길(set_config 등)과
//  렉싱이 Postgres 와 어긋나는 자리는 여기서만 막힌다 — P5~P8 이 이 파일의 핵심이다. DB 행(D·E)은 app-sql*.pg-test.mjs.

const opts = { appId: "crm", schema: "app_ws", tables: ["contacts", "conversations"] };
const plan = (sql: string) => planAppSql(sql, opts);
const T = (t: string) => `"app_ws"."crm__${t}"`;
const rejects = (sql: string, re: RegExp, status = 400) => {
  try { plan(sql); } catch (e) {
    const err = e as { status?: number; message?: string };
    assert.equal(err.status, status, `${sql} → ${err.message}`);
    assert.match(String(err.message), re, sql);
    return;
  }
  assert.fail(`받으면 안 되는데 받았다: ${sql}`);
};

// ── P1~P4 받는 것 ────────────────────────────────────────────────────────────────────────
const ACCEPT: Array<[string, { kind: string; writes: boolean; returning: boolean; tables: string[]; targets: string[]; has: string[]; not?: string[] }]> = [
  ["SELECT * FROM contacts", { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: [`FROM ${T("contacts")} AS contacts`] }],
  ["select c.name, count(*) from contacts c left join conversations v on v.contact_id = c.id group by 1 order by 2 desc limit 10",
    { kind: "select", writes: false, returning: true, tables: ["contacts", "conversations"], targets: [], has: [`from ${T("contacts")} c`, `join ${T("conversations")} v`] }],
  ["SELECT contacts.name FROM contacts, conversations WHERE conversations.contact_id = contacts.id",
    { kind: "select", writes: false, returning: true, tables: ["contacts", "conversations"], targets: [], has: [`FROM ${T("contacts")} AS contacts, ${T("conversations")} AS conversations`, "WHERE conversations.contact_id = contacts.id", "SELECT contacts.name"] }],
  ["SELECT name FROM contacts WHERE id IN (SELECT contact_id FROM conversations WHERE signal = $1)",
    { kind: "select", writes: false, returning: true, tables: ["contacts", "conversations"], targets: [], has: [`FROM ${T("conversations")} AS conversations WHERE`] }],
  ["WITH w AS (SELECT stage FROM contacts) SELECT stage, count(*) FROM w GROUP BY stage",
    { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: [`FROM ${T("contacts")} AS contacts)`, "FROM w GROUP"] }],
  ["SELECT extract(year FROM created_at) y FROM contacts WHERE name IS DISTINCT FROM 'x'",
    { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: ["extract(year FROM created_at)", `FROM ${T("contacts")} AS contacts WHERE`, "IS DISTINCT FROM 'x'"] }],
  ["SELECT data->>'a' FROM contacts WHERE data @> '{\"a\":1}'", { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: [`FROM ${T("contacts")} AS contacts WHERE`] }],
  ["INSERT INTO contacts(name, stage) VALUES ($1, $2), ('b', 'c') RETURNING id",
    { kind: "insert", writes: true, returning: true, tables: ["contacts"], targets: ["contacts"], has: [`INSERT INTO ${T("contacts")} AS contacts(name, stage)`] }],
  ["insert into conversations(contact_id) select id from contacts where stage = 'x'",
    { kind: "insert", writes: true, returning: false, tables: ["contacts", "conversations"], targets: ["conversations"], has: [`into ${T("conversations")} AS conversations(contact_id)`, `from ${T("contacts")} AS contacts where`] }],
  ["INSERT INTO contacts(email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET stage = EXCLUDED.stage",
    { kind: "insert", writes: true, returning: false, tables: ["contacts"], targets: ["contacts"], has: ["DO UPDATE SET stage"] }],
  ["UPDATE contacts SET stage = 'x' WHERE id = 3 RETURNING *",
    { kind: "update", writes: true, returning: true, tables: ["contacts"], targets: ["contacts"], has: [`UPDATE ${T("contacts")} AS contacts SET`] }],
  ["UPDATE contacts c SET stage = v.note FROM conversations v WHERE v.contact_id = c.id",
    { kind: "update", writes: true, returning: false, tables: ["contacts", "conversations"], targets: ["contacts"], has: [`UPDATE ${T("contacts")} c SET`, `FROM ${T("conversations")} v WHERE`] }],
  ["DELETE FROM contacts WHERE id = $1;", { kind: "delete", writes: true, returning: false, tables: ["contacts"], targets: ["contacts"], has: [`DELETE FROM ${T("contacts")} AS contacts WHERE`] }],
  ['SELECT * FROM "contacts"', { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: [`FROM ${T("contacts")} AS "contacts"`] }],
  // P4 — 문자열 안의 키워드·주석 기호·세미콜론은 문자열이다(값에 흔히 나온다).
  ["SELECT 'update the drop plan; -- not a comment /* x */' AS note FROM contacts",
    { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: ["'update the drop plan; -- not a comment /* x */'"] }],
  // IS DISTINCT FROM 뒤는 값 자리다 — 칸 이름이 테이블 이름과 같아도(contacts) 테이블로 바꾸지 않는다.
  ["SELECT id FROM conversations WHERE note IS DISTINCT FROM contacts",
    { kind: "select", writes: false, returning: true, tables: ["conversations"], targets: [], has: ["IS DISTINCT FROM contacts"] }],
  // 칸 이름이 테이블 이름과 같아도 칸 자리면 바꾸지 않는다.
  ["SELECT id, contacts FROM conversations", { kind: "select", writes: false, returning: true, tables: ["conversations"], targets: [], has: ["SELECT id, contacts FROM"] }],
  ["SELECT 1", { kind: "select", writes: false, returning: true, tables: [], targets: [], has: ["SELECT 1"] }],
  // FROM 자리의 함수 · LATERAL — 테이블이 아니다(함수 이름 검사는 P6 이 따로 한다).
  ["SELECT g FROM contacts c, generate_series(1, 3) g", { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: [`FROM ${T("contacts")} c, generate_series(1, 3) g`] }],
  ["SELECT * FROM contacts c CROSS JOIN LATERAL jsonb_array_elements(c.data) e", { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: ["LATERAL jsonb_array_elements(c.data) e"] }],
  ["SELECT * FROM contacts c, LATERAL (SELECT 1 AS x) l", { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: ["LATERAL (SELECT 1 AS x) l"] }],
];

test("P1~P4 받는 것 — 종류·쓰기·RETURNING·테이블·대상, 선언 이름이 물리 이름(+별칭)으로 바뀐다", () => {
  for (const [sql, want] of ACCEPT) {
    const p = plan(sql);
    assert.equal(p.kind, want.kind, sql);
    assert.equal(p.writes, want.writes, sql);
    assert.equal(p.returning, want.returning, sql);
    assert.deepEqual(p.tables, want.tables, sql);
    assert.deepEqual(p.targets, want.targets, sql);
    for (const h of want.has) assert.ok(p.sql.includes(h), `${sql}\n→ ${p.sql}\n  (기대 조각: ${h})`);
  }
});

test("P9 끝 세미콜론 하나는 받는다(흔한 습관)", () => {
  assert.equal(plan("SELECT * FROM contacts;").kind, "select");
  assert.equal(plan("  SELECT * FROM contacts ;  ").kind, "select");
});

test("P16 파라미터 수 — 가장 큰 $n", () => {
  assert.equal(plan("SELECT * FROM contacts WHERE id = $2 OR id = $1").paramCount, 2);
  assert.equal(plan("SELECT * FROM contacts").paramCount, 0);
});

// ── P5~P8 역할을 되돌리는 길 — 이 행들이 뚫리면 경계가 없다 ────────────────────────────────
test("P5 역할·설정을 바꾸는 set_config 는 어떤 모양으로 써도 거부", () => {
  for (const sql of [
    "SELECT set_config('role', 'none', true)",
    "SELECT SET_CONFIG ('role','none',true)",
    'SELECT "set_config"(\'role\',\'none\',true)',
    "SELECT pg_catalog.set_config('role','none',true)",
    "SELECT * FROM contacts WHERE name = (SELECT set_config('role','none',true))",
    "UPDATE contacts SET stage = set_config('role','none',true) WHERE id = 1",
    "SELECT set_config FROM contacts",
  ]) rejects(sql, /set_config/);
});

test("P6 설정 읽기·문자열을 SQL 로 실행하는 함수·카탈로그·시퀀스·외부 접속·연산자 수식은 거부", () => {
  for (const [sql, re] of [
    ["SELECT current_setting('app.tenant_id')", /current_setting/],
    ["SELECT query_to_xml('select 1', true, true, '')", /query_to_xml/],
    ["SELECT table_to_xml('x', true, true, '')", /table_to_xml/],
    ["SELECT ts_stat('select 1')", /ts_stat/],
    ["SELECT ts_rewrite('a'::tsquery, 'select 1')", /ts_rewrite/],
    ["SELECT pg_sleep(10)", /pg_sleep/],
    ["SELECT pg_advisory_lock(1)", /pg_advisory_lock/],
    ["SELECT pg_read_file('/etc/passwd')", /pg_read_file/],
    ["SELECT has_table_privilege('x','select')", /has_table_privilege/],
    ["SELECT to_regclass('x')", /to_regclass/],
    ["SELECT nextval('s')", /nextval/],
    ["SELECT dblink('x','y')", /dblink/],
    ["SELECT lo_import('/x')", /lo_import/],
    ["SELECT 1 OPERATOR(pg_catalog.+) 1", /operator/],
  ] as Array<[string, RegExp]>) rejects(sql, re);
});

test("P7 스키마 붙인 함수·형 변환, ::reg* 는 거부", () => {
  rejects("SELECT public.anything(1)", /스키마를 붙인 함수/);
  rejects("SELECT 'x'::public.mytype", /스키마를 붙인 형 변환/);
  rejects("SELECT 'x'::regclass", /reg\*/);
  rejects("SELECT 'x'::REGPROC", /reg\*/);
  rejects("SELECT CAST('pg_roles' AS regclass)", /reg\*/);
  rejects("SELECT regclass('pg_roles')", /reg\*/);
  rejects("SELECT CAST('x' AS regnamespace)", /reg\*/);
  assert.equal(plan("SELECT region, registered FROM contacts").kind, "select");   // reg 로 시작하는 칸 이름은 된다
});

test("P6b 한 문장에 큰 메모리를 잡는 함수는 거부(repeat·lpad·rpad·array_fill)", () => {
  for (const f of ["repeat('x', 900000000)", "lpad('x', 900000000)", "rpad('x', 900000000)", "array_fill(1, ARRAY[900000000])"]) rejects(`SELECT ${f}`, /쓸 수 없습니다/);
});

test("P8 렉싱이 Postgres 와 어긋날 수 있는 자리는 통째로 거부", () => {
  for (const [sql, re] of [
    ["SELECT 1 -- x", /주석/],
    ["SELECT /* x */ 1", /주석/],
    ["SELECT 1 +/* x */ 1", /주석/],
    ["SELECT 'a\\' , set_config('role','none',true), 'b' FROM contacts", /백슬래시/],
    ["SELECT E'\\x' FROM contacts", /백슬래시/],
    ["SELECT 'plain \\ inside' FROM contacts", /백슬래시/],
    ['SELECT 1 AS "a\\b"', /백슬래시/],
    ["SELECT $$x$$", /달러 인용/],
    ["SELECT $a$x$a$", /달러 인용/],
    ["SELECT U&\"x\"", /U&/],
    ["SELECT 1; SELECT 2", /세미콜론/],
    ["SELECT 1;;", /세미콜론/],
    ["SELECT `x`", /쓸 수 없는 문자/],
    ["SELECT 'open", /닫히지/],
    ["", /비어/],
    ["   ;  ", /비어/],
  ] as Array<[string, RegExp]>) rejects(sql, re);
});

// ── P10~P15 문장 종류·모양·테이블 ──────────────────────────────────────────────────────────
test("P10·P11 DDL·TRUNCATE·SET/RESET ROLE·SELECT INTO 는 거부", () => {
  for (const sql of ["CREATE TABLE x(a int)", "DROP TABLE contacts", "TRUNCATE contacts", "SET ROLE none", "RESET ROLE", "ALTER TABLE contacts ADD COLUMN x int"]) {
    rejects(sql, /받지 않습니다|해석하지 못했습니다/);
  }
  rejects("SELECT * INTO newt FROM contacts", /INTO/);
});

test("P12 조건 없는 UPDATE·DELETE, 칸 없는(늘 참인) 조건은 거부", () => {
  rejects("UPDATE contacts SET stage = 'x'", /조건\(WHERE\) 없는 UPDATE/);
  rejects("DELETE FROM contacts", /조건\(WHERE\) 없는 DELETE/);
  rejects("DELETE FROM contacts WHERE true", /칸이 없습니다/);
  rejects("UPDATE contacts SET stage = 'x' WHERE 1 = 1", /칸이 없습니다/);
});

test("P13 스키마 붙인 테이블은 400, 선언 밖 테이블은 403", () => {
  rejects("SELECT * FROM app_ws.crm__contacts", /스키마를 붙인 이름/);
  rejects("SELECT * FROM public.auth_token", /스키마를 붙인 이름/);
  rejects("SELECT * FROM auth_token", /선언하지 않은 테이블입니다: auth_token/, 403);
  rejects("SELECT * FROM pg_class", /선언하지 않은 테이블입니다: pg_class/, 403);
  rejects("UPDATE pg_settings SET setting = 'none' WHERE name = 'role'", /선언하지 않은 테이블입니다: pg_settings/, 403);
  rejects("SELECT * FROM contacts JOIN crm__conversations x ON x.id = contacts.id", /선언하지 않은 테이블입니다: crm__conversations/, 403);
});

// 격리 리뷰(2026-09-30) 실측: 파서는 괄호로 묶은 조인 안의 테이블을 목록에 올리지 않는다 — 파서 목록만 믿으면 그 안에
//  카탈로그를 넣어 테이블 검사를 통째로 빠져나갔다(다른 워크스페이스 스키마 이름·정책 식이 보였다). 토큰 검사가 정본이다.
test("P13b 괄호로 묶은 조인은 어디에 있든 거부(파서가 못 보는 자리)", () => {
  for (const sql of [
    "SELECT * FROM (pg_roles r JOIN pg_database d ON true)",
    "SELECT * FROM contacts JOIN (pg_roles a JOIN pg_database b ON true) ON true",
    "SELECT 1 FROM contacts WHERE EXISTS (SELECT 1 FROM (pg_namespace n JOIN pg_database d ON true))",
    "DELETE FROM contacts WHERE id IN (SELECT id FROM (pg_roles JOIN pg_database ON true))",
    "UPDATE contacts SET stage = 'x' FROM (pg_roles JOIN pg_database ON true) WHERE contacts.id = 1",
    "SELECT * FROM (app_ws.foo JOIN contacts ON true)",
    "SELECT * FROM contacts, (pg_roles JOIN pg_database ON true)",
    "SELECT * FROM contacts c, LATERAL (pg_roles JOIN pg_database ON true)",
    "SELECT * FROM (contacts c JOIN conversations v ON v.contact_id = c.id)",
  ]) rejects(sql, /괄호로 묶은 조인/);
});

test("P13c 테이블 자리의 이름은 토큰 검사가 직접 판정 — 선언 밖·스키마 붙인 이름", () => {
  rejects("SELECT * FROM contacts JOIN pg_roles r ON true", /선언하지 않은 테이블입니다: pg_roles/, 403);
  rejects("SELECT * FROM generate_series(1,2) g, pg_database d", /선언하지 않은 테이블입니다: pg_database/, 403);
  //  파서 목록에 pg_roles 가 아예 없는 모양(LATERAL 서브쿼리 뒤 쉼표) — 토큰 검사만 잡는다.
  rejects("SELECT * FROM contacts c LEFT JOIN LATERAL (SELECT 1) x ON true, pg_roles", /선언하지 않은 테이블입니다: pg_roles/, 403);
  rejects("SELECT * FROM contacts c LEFT JOIN LATERAL (SELECT 1) x ON true, app_ws.memo__notes", /스키마를 붙인 이름/);
});

test("P14·P15 WITH 이름 충돌·pg_ 이름, __lively 이름은 거부", () => {
  rejects("WITH contacts AS (SELECT 1) SELECT * FROM contacts", /WITH 이름 'contacts'/);
  rejects("WITH pg_class AS (SELECT 1) SELECT * FROM pg_class", /WITH 이름 'pg_class'/);
  rejects("SELECT 1 AS __lively_rn", /라이블리가 쓰는 이름/);
  rejects('SELECT 1 AS "__lively_acc"', /라이블리가 쓰는 이름/);
});

test("forbiddenFunction — 막는 것과 흔한 함수는 통과", () => {
  for (const f of ["pg_sleep", "PG_TERMINATE_BACKEND", "set_config", "query_to_xmlschema", "cursor_to_xml", "has_schema_privilege", "to_regnamespace", "lo_unlink", "dblink_exec", "setval"]) assert.ok(forbiddenFunction(f), f);
  for (const f of ["count", "coalesce", "date_trunc", "jsonb_build_object", "string_agg", "now", "lower", "to_char", "generate_series"]) assert.ok(!forbiddenFunction(f), f);
});

// ── W 결과 상한 감싸기 ──────────────────────────────────────────────────────────────────
test("W1~W3 wrapForCaps — 결과 없는 쓰기는 그대로, SELECT 는 잘린 묶음 안에서, 쓰기+RETURNING 은 전체를 센다", () => {
  const w = plan("DELETE FROM contacts WHERE id = 1");
  assert.equal(wrapForCaps(w, { maxRows: 10, maxBytes: 100 }), w.sql);
  const s = wrapForCaps(plan("SELECT * FROM contacts"), { maxRows: 10, maxBytes: 100 });
  assert.match(s, /LIMIT 11\b/);
  assert.match(s, /__lively_rn <= 10 AND __lively_s\.__lively_acc <= 100/);
  assert.match(s, /FROM __lively_m LEFT JOIN __lively_s/);
  assert.match(s, /count\(\*\) AS n FROM __lively_l\b/);
  const d = wrapForCaps(plan("UPDATE contacts SET stage = 'x' WHERE id > 0 RETURNING id"), { maxRows: 10, maxBytes: 100 });
  assert.match(d, /count\(\*\) AS n FROM __lively_q\b/);
});

test("W4·W5 shapeResult — 끝 세 칸을 떼고, NULL 표지 행은 버리고, 겹친 칸 이름엔 _2", () => {
  const fields = ["id", "name", "id", "__lively_rn", "__lively_acc", "__lively_total"].map((name) => ({ name }));
  const r = shapeResult({ returning: true, writes: false }, { fields, rows: [[1, "a", 9, 1, 10, 3], [2, "b", 8, 2, 20, 3]], rowCount: 2 }, 5);
  assert.deepEqual(r.columns, ["id", "name", "id_2"]);
  assert.deepEqual(r.rows, [{ id: 1, name: "a", id_2: 9 }, { id: 2, name: "b", id_2: 8 }]);
  assert.equal(r.truncated, true);
  assert.equal(r.changed, null);
  const none = shapeResult({ returning: true, writes: true }, { fields, rows: [[null, null, null, null, null, 7]], rowCount: 1 }, 5);
  assert.equal(none.row_count, 0);
  assert.equal(none.changed, 7);
  assert.equal(none.truncated, true);
  const empty = shapeResult({ returning: true, writes: false }, { fields, rows: [[null, null, null, null, null, 0]], rowCount: 1 }, 5);
  assert.equal(empty.truncated, false);
  const nr = shapeResult({ returning: false, writes: true }, { fields: [], rows: [], rowCount: 4 }, 1);
  assert.equal(nr.changed, 4);
  assert.throws(() => shapeResult({ returning: true, writes: false }, { fields: [{ name: "x" }], rows: [], rowCount: 0 }, 1), /모양/);
});

// ── G 빈도·동시 실행·기본값 ─────────────────────────────────────────────────────────────
test("G1 TokenBuckets — 순간 N 번까지 되고 N+1 에 막히며, 시간이 지나면 초당 rate 만큼 돌아온다, 키마다 따로", () => {
  let now = 0;
  const b = new TokenBuckets(10, 3, () => now);
  assert.equal(b.take("k"), 0); assert.equal(b.take("k"), 0); assert.equal(b.take("k"), 0);
  const wait = b.take("k");
  assert.ok(wait > 0 && wait <= 100, String(wait));
  assert.equal(b.take("other"), 0);
  now += 100;
  assert.equal(b.take("k"), 0);
  assert.ok(b.take("k") > 0);
});

test("G2 KeyedSemaphore — 키당 한도, 대기는 풀리면 넘겨받고, 시간이 지나면 null, 두 번 풀어도 셈이 음수가 되지 않는다", async () => {
  const s = new KeyedSemaphore(2);
  const a = await s.acquire("w", 50), b = await s.acquire("w", 50);
  assert.ok(a && b);
  assert.equal(await s.acquire("w", 20), null);
  assert.ok(await s.acquire("other", 20));
  const waiting = s.acquire("w", 500);
  a!();
  const c = await waiting;
  assert.ok(c);
  assert.equal(s.inUse("w"), 2);
  b!(); c!();
  assert.equal(s.inUse("w"), 0);
  c!();
  assert.equal(s.inUse("w"), 0);
  assert.ok(await s.acquire("w", 10) && await s.acquire("w", 10));
  assert.equal(await s.acquire("w", 10), null);
});

test("G3 상한 기본값 — 계획 §7-3 의 값, 잘못된 env 는 기본값", () => {
  const l = appSqlLimits({});
  assert.deepEqual(
    [l.poolMax, l.perWorkspace, l.statementMs, l.lockMs, l.maxRows, l.maxBytes, l.ratePerSec, l.burst, l.quotaBytes],
    [4, 2, 5000, 1000, 5000, 5 * 1024 * 1024, 10, 30, 1024 * 1024 * 1024]);
  assert.equal(appSqlLimits({ LIVELY_APP_SQL_POOL: "8" }).poolMax, 8);
  assert.equal(appSqlLimits({ LIVELY_APP_SQL_RATE: "x" }).ratePerSec, 10);
  assert.equal(appSqlLimits({ LIVELY_APP_SQL_RATE: "-3" }).ratePerSec, 10);
});

test("N1 역할·인덱스 이름 — 결정적, DB·스키마·앱(유일·테넌트 축)마다 다르고, 63자 안", () => {
  const r = appSqlRoleName("lvly_shared", "app_abc", "crm");
  assert.equal(r, appSqlRoleName("lvly_shared", "app_abc", "crm"));
  assert.notEqual(r, appSqlRoleName("lvly_stage", "app_abc", "crm"));
  assert.notEqual(r, appSqlRoleName("lvly_shared", "app_abd", "crm"));
  assert.notEqual(r, appSqlRoleName("lvly_shared", "app_abc", "crm2"));
  assert.match(r, /^lvly_appsql_[0-9a-f]{24}$/);
  const i1 = appIndexName("s", "crm__contacts", { columns: ["email"], unique: true }, false);
  assert.match(i1, /^lvix_[0-9a-f]{16}$/);
  assert.notEqual(i1, appIndexName("s", "crm__contacts", { columns: ["email"], unique: false }, false));
  assert.notEqual(i1, appIndexName("s", "crm__contacts", { columns: ["email"], unique: true }, true));
  assert.notEqual(i1, appIndexName("s", "crm__contacts", { columns: ["email", "name"], unique: true }, false));
});
