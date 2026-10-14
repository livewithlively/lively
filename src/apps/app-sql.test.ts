import { strict as assert } from "node:assert";
import test from "node:test";
import { planAppSql, planAppSqlSync, wrapForCaps, forbiddenFunction, APP_SQL_MAX_LEN, _walkTreeForTest, type AppSqlPlan } from "./app-sql.js";
import { TokenBuckets, FairScheduler, shapeResult, shapeWire, appSqlLimits, nextStatementTimeout, takeAppCall, resetAppSqlLimits } from "./app-sql-exec.js";
import { appSqlRoleName, appIndexName } from "./store-ddl.js";

// 앱 자유 SQL(#4226 · #4483) — 「입력 × 기대」 엣지 표(P·W·G·N 행). 경계는 DB 역할이지만, 역할을 되돌리는 길(set_config 등)과
//  카탈로그에 닿는 이름은 여기서만 막힌다 — P5~P8·P13 이 이 파일의 핵심이다. DB 행(D·E)은 app-sql*.pg-test.mjs.
//  #4483 부터 해석은 Postgres 의 실제 파서(libpg_query)다 — 검사기와 DB 가 같은 렉서로 읽으므로 주석·백슬래시·달러 인용·
//  괄호 조인은 받고, 그 안에 숨긴 함수·카탈로그 이름은 그대로 잡는다(P8·P13b). Drizzle 이 만드는 SQL 은 app-sql-drizzle.test.ts.

const opts = { appId: "crm", schema: "app_ws", tables: ["contacts", "conversations"] };
const plan = (sql: string): Promise<AppSqlPlan> => planAppSql(sql, opts);
const T = (t: string) => `"app_ws"."crm__${t}"`;
const A = (t: string) => `${T(t)} AS "${t}"`;
const rejects = async (sql: string, re: RegExp, status = 400): Promise<void> => {
  try { await plan(sql); } catch (e) {
    const err = e as { status?: number; message?: string };
    assert.equal(err.status, status, `${sql} → ${err.message}`);
    assert.match(String(err.message), re, sql);
    return;
  }
  assert.fail(`받으면 안 되는데 받았다: ${sql}`);
};

// ── G0 해석기 준비 — 이 파일의 **첫** 시험이어야 한다(한 파일 = 한 프로세스, 아직 아무도 싣지 않았다) ─────────────────
test("G0 해석기를 싣기 전에 planAppSqlSync 를 부르면 503(조용히 통과하지 않는다)", () => {
  assert.throws(() => planAppSqlSync("SELECT 1", opts), (e: { status?: number }) => e.status === 503);
});

// ── P1~P4 받는 것 ────────────────────────────────────────────────────────────────────────
type Want = { kind: string; writes: boolean; returning: boolean; tables: string[]; targets: string[]; has: string[]; locks?: boolean };
const ACCEPT: Array<[string, Want]> = [
  ["SELECT * FROM contacts", { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: [`FROM ${A("contacts")}`] }],
  ["select c.name, count(*) from contacts c left join conversations v on v.contact_id = c.id group by 1 order by 2 desc limit 10",
    { kind: "select", writes: false, returning: true, tables: ["contacts", "conversations"], targets: [], has: [`from ${T("contacts")} c`, `join ${T("conversations")} v`] }],
  ["SELECT contacts.name FROM contacts, conversations WHERE conversations.contact_id = contacts.id",
    { kind: "select", writes: false, returning: true, tables: ["contacts", "conversations"], targets: [], has: [`FROM ${A("contacts")}, ${A("conversations")}`, "WHERE conversations.contact_id = contacts.id", "SELECT contacts.name"] }],
  ["SELECT name FROM contacts WHERE id IN (SELECT contact_id FROM conversations WHERE signal = $1)",
    { kind: "select", writes: false, returning: true, tables: ["contacts", "conversations"], targets: [], has: [`FROM ${A("conversations")} WHERE`] }],
  ["WITH w AS (SELECT stage FROM contacts) SELECT stage, count(*) FROM w GROUP BY stage",
    { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: [`FROM ${A("contacts")})`, "FROM w GROUP"] }],
  ["SELECT extract(year FROM created_at) y FROM contacts WHERE name IS DISTINCT FROM 'x'",
    { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: ["extract(year FROM created_at)", `FROM ${A("contacts")} WHERE`, "IS DISTINCT FROM 'x'"] }],
  ["SELECT data->>'a' FROM contacts WHERE data @> '{\"a\":1}'", { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: [`FROM ${A("contacts")} WHERE`] }],
  ["INSERT INTO contacts(name, stage) VALUES ($1, $2), ('b', 'c') RETURNING id",
    { kind: "insert", writes: true, returning: true, tables: ["contacts"], targets: ["contacts"], has: [`INSERT INTO ${A("contacts")}(name, stage)`] }],
  ["insert into conversations(contact_id) select id from contacts where stage = 'x'",
    { kind: "insert", writes: true, returning: false, tables: ["contacts", "conversations"], targets: ["conversations"], has: [`into ${A("conversations")}(contact_id)`, `from ${A("contacts")} where`] }],
  ["INSERT INTO contacts(email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET stage = EXCLUDED.stage",
    { kind: "insert", writes: true, returning: false, tables: ["contacts"], targets: ["contacts"], has: ["DO UPDATE SET stage"] }],
  ["UPDATE contacts SET stage = 'x' WHERE id = 3 RETURNING *",
    { kind: "update", writes: true, returning: true, tables: ["contacts"], targets: ["contacts"], has: [`UPDATE ${A("contacts")} SET`] }],
  ["UPDATE contacts c SET stage = v.note FROM conversations v WHERE v.contact_id = c.id",
    { kind: "update", writes: true, returning: false, tables: ["contacts", "conversations"], targets: ["contacts"], has: [`UPDATE ${T("contacts")} c SET`, `FROM ${T("conversations")} v WHERE`] }],
  ["DELETE FROM contacts WHERE id = $1;", { kind: "delete", writes: true, returning: false, tables: ["contacts"], targets: ["contacts"], has: [`DELETE FROM ${A("contacts")} WHERE id = $1`] }],
  ['SELECT * FROM "contacts"', { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: [`FROM ${A("contacts")}`] }],
  // 인용 안 한 이름은 소문자로 접힌다(Postgres 와 같다) — CONTACTS 도 선언 테이블이다.
  ["SELECT x FROM CONTACTS", { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: [`FROM ${A("contacts")}`] }],
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
  // #4483 — 종전 파서(node-sql-parser)가 못 읽던 모양: 괄호 조인 · 집계 안 ORDER BY · $n::형 · DELETE USING · INSERT … AS 별칭 ·
  //  substring(… FROM …) · FROM ONLY · 재귀 WITH · USING 조인 — 전부 Postgres 문법 그대로 받는다.
  ["SELECT * FROM (contacts c JOIN conversations v ON v.contact_id = c.id)",
    { kind: "select", writes: false, returning: true, tables: ["contacts", "conversations"], targets: [], has: [`FROM (${T("contacts")} c JOIN ${T("conversations")} v ON`] }],
  ["SELECT json_agg(name ORDER BY created_at DESC) FROM contacts", { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: ["json_agg(name ORDER BY created_at DESC)"] }],
  ["UPDATE contacts SET data = data || $1::jsonb WHERE id = $2", { kind: "update", writes: true, returning: false, tables: ["contacts"], targets: ["contacts"], has: ["data || $1::jsonb"] }],
  ["DELETE FROM conversations v USING contacts c WHERE c.id = v.contact_id AND c.stage = 'lost'",
    { kind: "delete", writes: true, returning: false, tables: ["contacts", "conversations"], targets: ["conversations"], has: [`DELETE FROM ${T("conversations")} v USING ${T("contacts")} c WHERE`] }],
  ["INSERT INTO contacts AS c (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET stage = c.stage || '!'",
    { kind: "insert", writes: true, returning: false, tables: ["contacts"], targets: ["contacts"], has: [`INSERT INTO ${T("contacts")} AS c (email)`] }],
  ["SELECT substring(name FROM 1 FOR 2) FROM ONLY contacts", { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: [`FROM ONLY ${A("contacts")}`] }],
  ["WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r",
    { kind: "select", writes: false, returning: true, tables: [], targets: [], has: ["FROM r WHERE n < 3"] }],
  ["select * from contacts c join conversations v using (id)", { kind: "select", writes: false, returning: true, tables: ["contacts", "conversations"], targets: [], has: [`join ${T("conversations")} v using (id)`] }],
  // 행 잠금 — 한 문장 원자 갱신(작업 꺼내 가기)에 쓴다. OF 뒤는 FROM 자리의 이름이라 바꾸지 않는다.
  ["SELECT * FROM contacts WHERE id = $1 FOR UPDATE OF contacts SKIP LOCKED",
    { kind: "select", writes: false, returning: true, tables: ["contacts"], targets: [], has: [`FROM ${A("contacts")} WHERE`, "FOR UPDATE OF contacts SKIP LOCKED"], locks: true }],
  ["UPDATE contacts SET stage = 'taken' WHERE id = (SELECT id FROM contacts WHERE stage = 'open' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id",
    { kind: "update", writes: true, returning: true, tables: ["contacts"], targets: ["contacts"], has: ["FOR UPDATE SKIP LOCKED"], locks: true }],
  // 한글 값 — 위치는 바이트다. 바꿔 쓰기가 글자 위치로 어긋나면 이 행이 깨진다.
  ["SELECT '김' AS k, name FROM contacts WHERE name = '가나다' AND stage IN (SELECT note FROM conversations)",
    { kind: "select", writes: false, returning: true, tables: ["contacts", "conversations"], targets: [], has: [`SELECT '김' AS k, name FROM ${A("contacts")} WHERE name = '가나다' AND stage IN (SELECT note FROM ${A("conversations")})`] }],
];

test("P1~P4 받는 것 — 종류·쓰기·RETURNING·잠금·테이블·대상, 선언 이름이 물리 이름(+별칭)으로 바뀐다", async () => {
  for (const [sql, want] of ACCEPT) {
    const p = await plan(sql);
    assert.equal(p.kind, want.kind, sql);
    assert.equal(p.writes, want.writes, sql);
    assert.equal(p.returning, want.returning, sql);
    assert.equal(p.locks, !!want.locks, sql);
    assert.deepEqual(p.tables, want.tables, sql);
    assert.deepEqual(p.targets, want.targets, sql);
    for (const h of want.has) assert.ok(p.sql.includes(h), `${sql}\n→ ${p.sql}\n  (기대 조각: ${h})`);
  }
});

test("P9 끝 세미콜론·꼬리 주석은 떼어 낸다(실행기가 문장을 괄호로 감싼다), 빈 문장은 비었다고 말한다", async () => {
  assert.equal((await plan("SELECT * FROM contacts;")).sql, `SELECT * FROM ${A("contacts")}`);
  assert.equal((await plan("  SELECT * FROM contacts ;  ")).sql, `SELECT * FROM ${A("contacts")}`);
  assert.equal((await plan("SELECT * FROM contacts; -- 끝")).sql, `SELECT * FROM ${A("contacts")}`);
  assert.equal((await plan("-- 머리\nSELECT * FROM contacts;")).sql, `SELECT * FROM ${A("contacts")}`);
  assert.equal((await plan("SELECT 1;;")).sql, "SELECT 1");
  for (const sql of ["", "   ;  ", ";", "-- 주석만"]) await rejects(sql, /비어/);
});

test("P16 파라미터 수 — 가장 큰 $n, $0 은 거부", async () => {
  assert.equal((await plan("SELECT * FROM contacts WHERE id = $2 OR id = $1")).paramCount, 2);
  assert.equal((await plan("SELECT * FROM contacts")).paramCount, 0);
  await rejects("SELECT * FROM contacts WHERE id = $101", /파라미터가 너무 많습니다/);
});

// ── P5~P8 역할을 되돌리는 길 — 이 행들이 뚫리면 경계가 없다 ────────────────────────────────
test("P5 역할·설정을 바꾸는 set_config 는 어떤 모양으로 써도 거부", async () => {
  for (const sql of [
    "SELECT set_config('role', 'none', true)",
    "SELECT SET_CONFIG ('role','none',true)",
    'SELECT "set_config"(\'role\',\'none\',true)',
    'SELECT "SET_CONFIG"(\'role\',\'none\',true)',
    "SELECT pg_catalog.set_config('role','none',true)",
    "SELECT * FROM contacts WHERE name = (SELECT set_config('role','none',true))",
    "UPDATE contacts SET stage = set_config('role','none',true) WHERE id = 1",
    "SELECT * FROM set_config('role','none',true)",
    "SELECT * FROM ROWS FROM (set_config('role','none',true))",
    "SELECT count(*) FILTER (WHERE set_config('role','none',true) = 'x') FROM contacts",
    "SELECT 1 FROM contacts ORDER BY set_config('role','none',true)",
    "INSERT INTO contacts(name) VALUES (set_config('role','none',true))",
    "INSERT INTO contacts(email) VALUES ('a') ON CONFLICT (email) DO UPDATE SET name = set_config('role','none',true)",
    "WITH x AS (SELECT set_config('role','none',true)) SELECT 1",
    "SELECT json_agg(set_config('role','none',true) ORDER BY 1)",
  ]) await rejects(sql, /set_config/);
});

test("P6 설정 읽기·문자열을 SQL 로 실행하는 함수·카탈로그·시퀀스·외부 접속·스키마 붙인 연산자는 거부", async () => {
  for (const [sql, re] of [
    ["SELECT current_setting('app.tenant_id')", /current_setting/],
    ["SELECT query_to_xml('select 1', true, true, '')", /query_to_xml/],
    ["SELECT table_to_xml('x', true, true, '')", /table_to_xml/],
    ["SELECT database_to_xmlschema(true, true, '')", /database_to_xmlschema/],
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
    ["SELECT row_security_active('app_x.crm__contacts')", /row_security_active/],
    ["SELECT brin_summarize_new_values('x')", /brin_summarize_new_values/],
    ["SELECT inet_server_addr()", /inet_server_addr/],
    ["SELECT 1 OPERATOR(pg_catalog.+) 1", /OPERATOR/],
    ["SELECT 1 OPERATOR(public.+) 1", /OPERATOR/],
    ["SELECT name FROM contacts ORDER BY name USING OPERATOR(public.<)", /OPERATOR|연산자/],
    ["SELECT name COLLATE public.x FROM contacts", /콜레이션/],
  ] as Array<[string, RegExp]>) await rejects(sql, re);
});

test("P7 스키마 붙인 함수·형, reg* 형과 그 입출력 함수는 거부 — 파서가 SQL 구문을 바꿔 쓴 pg_catalog. 은 받는다", async () => {
  await rejects("SELECT public.anything(1)", /스키마를 붙인 함수/);
  await rejects("SELECT 'x'::public.mytype", /스키마를 붙인 형/);
  await rejects("SELECT 'x'::app_other.crm__contacts", /스키마를 붙인 형/);
  await rejects("SELECT 'x'::regclass", /reg\*/);
  await rejects("SELECT 'x'::REGPROC", /reg\*/);
  await rejects("SELECT CAST('pg_roles' AS regclass)", /reg\*/);
  await rejects("SELECT regclass('pg_roles')", /regclass/);
  await rejects("SELECT regclassout('app_x.crm__contacts')", /regclassout/);
  await rejects("SELECT CAST('x' AS regnamespace)", /reg\*/);
  await rejects("SELECT 'x'::regrole[]", /reg\*/);
  assert.equal((await plan("SELECT region, registered FROM contacts")).kind, "select");   // reg 로 시작하는 칸 이름은 된다
  assert.equal((await plan("SELECT regexp_replace(name, 'a', 'b') FROM contacts")).kind, "select");
  // extract · AT TIME ZONE · trim · substring · cast(… as integer) → 파서가 pg_catalog.<…> 로 바꾼다. 받아야 한다.
  assert.equal((await plan("SELECT extract(epoch FROM created_at), created_at AT TIME ZONE 'Asia/Seoul', trim(both from name), cast(id AS integer), 1.5::numeric(10,2) FROM contacts")).kind, "select");
});

test("P6b 한 번에 큰 메모리를 잡는 함수는 거부(repeat·lpad·rpad·array_fill·format) — 대신 쓸 길을 말한다", async () => {
  for (const f of ["repeat('x', 900000000)", "lpad('x', 900000000)", "rpad('x', 900000000)", "array_fill(1, ARRAY[900000000])", "format('%1000000000s', 'x')"]) {
    await rejects(`SELECT ${f}`, /큰 메모리.*concat/);
  }
});

test("P8 주석·백슬래시·달러 인용·U& 는 Postgres 와 같은 렉서로 읽는다 — 그 안에 숨긴 함수도 잡힌다", async () => {
  // 렉서가 같으므로 주석은 주석, 문자열은 문자열이다(종전엔 렉싱이 어긋날까 봐 통째로 거부했다).
  for (const sql of ["SELECT 1 -- x", "SELECT /* set_config('role','none',true) */ 1", "SELECT $$x$$", "SELECT $a$x$a$", "SELECT E'a\\nb'", "SELECT 'plain \\ inside'"]) {
    assert.equal((await plan(sql)).kind, "select", sql);
  }
  // 문자열이 끝났다고 보는 자리가 검사기와 DB 가 같다 — 그 뒤의 함수 호출은 함수 호출로 잡힌다.
  for (const sql of [
    "SELECT 'a\\' , set_config('role','none',true), 'b' FROM contacts",
    "SELECT E'\\'' || set_config('role','none',true)",
    "SELECT $a$ ' $a$, set_config('role','none',true)",
    "SELECT U&\"\\0073et_config\"('role','none',true)",
  ]) await rejects(sql, /set_config/);
  await rejects("SELECT * FROM U&\"\\0070g_roles\"", /pg_roles/, 403);
  for (const [sql, re] of [
    ["SELECT 1; SELECT 2", /한 번에 한 문장/],
    ["SELECT 1; SET ROLE none", /한 번에 한 문장/],
    ["SELECT `x`", /문법 오류/],
    ["SELECT 'open", /문법 오류/],
    ["SELECT 1 FROM contacts WHERE", /문법 오류.*근처/],
  ] as Array<[string, RegExp]>) await rejects(sql, re);
});

// ── P10~P15 문장 종류·모양·테이블 ──────────────────────────────────────────────────────────
test("P10·P11 DDL·TRUNCATE·SET/RESET ROLE·트랜잭션·MERGE·SELECT INTO 는 거부 — 대신 쓸 길을 말한다", async () => {
  for (const sql of ["CREATE TABLE x(a int)", "DROP TABLE contacts", "TRUNCATE contacts", "ALTER TABLE contacts ADD COLUMN x int", "CREATE INDEX ON contacts(name)"]) {
    await rejects(sql, /매니페스트/);
  }
  for (const sql of ["SET ROLE none", "RESET ROLE", "BEGIN", "COMMIT", "SET search_path = public"]) await rejects(sql, /묶음/);
  await rejects("MERGE INTO contacts c USING conversations v ON v.contact_id = c.id WHEN MATCHED THEN DO NOTHING", /ON CONFLICT/);
  await rejects("SELECT * INTO newt FROM contacts", /INTO/);
  await rejects("COPY contacts TO STDOUT", /받지 않습니다/);
  await rejects("CALL anything()", /받지 않습니다/);
  await rejects("DO $$ BEGIN END $$", /받지 않습니다/);
});

test("P10b WITH 안의 쓰기 · ON CONFLICT ON CONSTRAINT · OVERRIDING SYSTEM VALUE · CURRENT OF 는 거부", async () => {
  await rejects("WITH d AS (DELETE FROM contacts WHERE id = 1 RETURNING *) SELECT * FROM d", /WITH 안의.*묶음/);
  await rejects("WITH d AS (UPDATE contacts SET stage = 'x' WHERE id = 1 RETURNING *) SELECT 1", /WITH 안의/);
  await rejects("INSERT INTO contacts(email) VALUES ('a') ON CONFLICT ON CONSTRAINT contacts_email_key DO NOTHING", /ON CONFLICT \(칸/);
  await rejects("INSERT INTO contacts OVERRIDING SYSTEM VALUE VALUES (1)", /OVERRIDING/);
  await rejects("UPDATE contacts SET stage = 'x' WHERE CURRENT OF c", /CURRENT OF|칸이 없습니다/);
});

test("P12 조건 없는 UPDATE·DELETE, 칸 없는(늘 참인) 조건은 거부", async () => {
  await rejects("UPDATE contacts SET stage = 'x'", /조건\(WHERE\) 없는 UPDATE/);
  await rejects("DELETE FROM contacts", /조건\(WHERE\) 없는 DELETE/);
  await rejects("DELETE FROM contacts WHERE true", /칸이 없습니다/);
  await rejects("UPDATE contacts SET stage = 'x' WHERE 1 = 1", /칸이 없습니다/);
});

test("P13 스키마 붙인 테이블은 400, 선언 밖 테이블은 403 — 어느 자리에 있든", async () => {
  await rejects("SELECT * FROM app_ws.crm__contacts", /스키마를 붙인 이름/);
  await rejects("SELECT * FROM public.auth_token", /스키마를 붙인 이름/);
  await rejects("SELECT * FROM lvly_shared.public.auth_token", /스키마를 붙인 이름/);
  await rejects("SELECT * FROM auth_token", /선언하지 않은 테이블입니다: auth_token/, 403);
  await rejects("SELECT * FROM pg_class", /선언하지 않은 테이블입니다: pg_class/, 403);
  await rejects("UPDATE pg_settings SET setting = 'none' WHERE name = 'role'", /선언하지 않은 테이블입니다: pg_settings/, 403);
  await rejects("SELECT * FROM contacts JOIN crm__conversations x ON x.id = contacts.id", /선언하지 않은 테이블입니다: crm__conversations/, 403);
  await rejects('SELECT * FROM "Contacts"', /선언하지 않은 테이블입니다: Contacts/, 403);
  await rejects("INSERT INTO pg_authid(rolname) VALUES ('x')", /선언하지 않은 테이블입니다: pg_authid/, 403);
  await rejects("DELETE FROM contacts USING pg_roles r WHERE contacts.name = r.rolname", /pg_roles/, 403);
  await rejects("SELECT 1 FROM contacts TABLESAMPLE system(10), pg_database", /pg_database/, 403);
});

// 격리 리뷰(2026-09-30) 실측: 종전 파서는 괄호로 묶은 조인 안의 테이블을 목록에 올리지 않아 그 안에 카탈로그를 넣으면 테이블
//  검사를 빠져나갔다. 실제 파서는 그 자리의 테이블을 그대로 보인다 — 괄호 조인은 받고, 그 안의 카탈로그는 403 이다.
test("P13b 괄호로 묶은 조인 · LATERAL 뒤 쉼표 · 집합 연산 — 그 안의 카탈로그도 403", async () => {
  for (const sql of [
    "SELECT * FROM (pg_roles r JOIN pg_database d ON true)",
    "SELECT * FROM contacts JOIN (pg_roles a JOIN pg_database b ON true) ON true",
    "SELECT 1 FROM contacts WHERE EXISTS (SELECT 1 FROM (pg_namespace n JOIN pg_database d ON true))",
    "DELETE FROM contacts WHERE id IN (SELECT id FROM (pg_roles JOIN pg_database ON true))",
    "UPDATE contacts SET stage = 'x' FROM (pg_roles JOIN pg_database ON true) WHERE contacts.id = 1",
    "SELECT * FROM contacts, (pg_roles JOIN pg_database ON true)",
    "SELECT * FROM contacts c LEFT JOIN LATERAL (SELECT 1) x ON true, pg_roles",
    "SELECT * FROM generate_series(1,2) g, pg_database d",
    "(SELECT name FROM contacts) UNION (SELECT rolname FROM pg_roles)",
    "SELECT name FROM contacts UNION ALL SELECT rolname FROM pg_roles",
  ]) await rejects(sql, /선언하지 않은 테이블입니다: pg_/, 403);
  await rejects("SELECT * FROM (app_ws.foo JOIN contacts ON true)", /스키마를 붙인 이름/);
  await rejects("SELECT * FROM contacts c LEFT JOIN LATERAL (SELECT 1) x ON true, app_ws.memo__notes", /스키마를 붙인 이름/);
});

test("P13c WITH 이름의 범위는 Postgres 규칙 그대로 — 범위 밖에서 쓰면 선언 밖 테이블이다", async () => {
  await rejects("SELECT * FROM (WITH x AS (SELECT 1) SELECT * FROM x) a, x", /선언하지 않은 테이블입니다: x/, 403);
  await rejects("WITH r AS (SELECT * FROM r) SELECT 1", /선언하지 않은 테이블입니다: r/, 403);
  await rejects("WITH a AS (SELECT * FROM b), b AS (SELECT 1) SELECT * FROM a", /선언하지 않은 테이블입니다: b/, 403);
  assert.deepEqual((await plan("WITH a AS (SELECT 1), b AS (SELECT * FROM a) SELECT * FROM b")).tables, []);
  assert.deepEqual((await plan("WITH RECURSIVE a AS (SELECT 1 AS n UNION ALL SELECT n FROM a) SELECT * FROM a, contacts")).tables, ["contacts"]);
});

test("P14·P15 WITH 이름 충돌·pg_ 이름, __lively 이름, 세 마디 칸 이름, TABLESAMPLE 방법은 거부", async () => {
  await rejects("WITH contacts AS (SELECT 1) SELECT * FROM contacts", /WITH 이름 'contacts'/);
  await rejects("WITH pg_class AS (SELECT 1) SELECT * FROM pg_class", /WITH 이름 'pg_class'/);
  await rejects("SELECT 1 AS __lively_rn", /라이블리가 쓰는 이름/);
  await rejects('SELECT 1 AS "__lively_acc"', /라이블리가 쓰는 이름/);
  await rejects("SELECT x.__lively_total FROM contacts x", /라이블리가 쓰는 이름/);
  await rejects("SELECT * FROM contacts __lively_q", /라이블리가 쓰는 이름/);
  await rejects("SELECT a.b.c FROM contacts a", /테이블\.칸/);
  await rejects("SELECT * FROM contacts TABLESAMPLE system_rows(3)", /system · bernoulli/);
  assert.equal((await plan("SELECT * FROM contacts TABLESAMPLE bernoulli(10)")).kind, "select");
});

test("P17 수천 겹 중첩·메모리 소진 문장도 400 으로 끝나고, 그 뒤 해석기는 그대로 돈다", async () => {
  const nest = (n: number) => "SELECT " + "(SELECT ".repeat(n) + "1" + ")".repeat(n);
  await rejects(nest(1000), /복잡|깊게/);
  await rejects(nest(5000), /문법 오류|복잡|깊게/);
  await rejects("SELECT " + "1+(".repeat(3000) + "1" + ")".repeat(3000), /깊게|복잡/);
  assert.equal((await plan("SELECT * FROM contacts WHERE id = $1")).sql, `SELECT * FROM ${A("contacts")} WHERE id = $1`);
  assert.equal((await plan("SELECT " + Array.from({ length: 800 }, () => "name").join(" || ") + " FROM contacts")).kind, "select");
});

test("F1·F2 길이 경계 100,000자는 받고 100,001자는 거부, NUL 은 거부", async () => {
  const pad = (n: number) => { const head = "SELECT 1 AS x FROM contacts WHERE name = '"; return head + "x".repeat(n - head.length - 1) + "'"; };
  assert.equal(pad(APP_SQL_MAX_LEN).length, APP_SQL_MAX_LEN);
  assert.equal((await plan(pad(APP_SQL_MAX_LEN))).kind, "select");
  await rejects(pad(APP_SQL_MAX_LEN + 1), /너무 깁니다/);
  await rejects("SELECT 'a\u0000b'", /NUL/);
});

test("F3 파라미터 경계 — $100 은 받고 paramCount 100", async () => {
  assert.equal((await plan("SELECT * FROM contacts WHERE id = $100")).paramCount, 100);
});

test("G2 선언 표가 하나도 없는 앱 — 표 참조는 403 «(없음)», 표 없는 문장은 받는다", async () => {
  const none = { appId: "crm", schema: "app_ws", tables: [] as string[] };
  await assert.rejects(planAppSql("SELECT * FROM contacts", none), (e: { status?: number; message?: string }) => e.status === 403 && /\(없음\)/.test(String(e.message)));
  assert.equal((await planAppSql("SELECT 1 + 1", none)).kind, "select");
});

test("G3 허용 목록 — 모르는 노드는 그 이름을 대며 거부(Postgres 판이 올라 새 문법이 생겨도 받는 쪽으로 새지 않는다)", () => {
  const tree = (val: unknown) => ({ SelectStmt: { targetList: [{ ResTarget: { val } }], op: "SETOP_NONE", limitOption: "LIMIT_OPTION_DEFAULT" } });
  assert.throws(() => _walkTreeForTest(tree({ FutureNode: { x: 1 } }), []), (e: { status?: number; message?: string }) => e.status === 400 && /FutureNode/.test(String(e.message)));
  assert.throws(() => _walkTreeForTest(tree({ CurrentOfExpr: { cursor_name: "c" } }), []), /CURRENT OF/);
  assert.throws(() => _walkTreeForTest(tree({ MergeSupportFunc: {} }), []), /MergeSupportFunc/);
  _walkTreeForTest(tree({ A_Const: { ival: { ival: 1 } } }), []);   // 아는 노드는 통과
});

test("G4 표 이름을 렉서 규칙 밖 모양으로 쓰면(U&\"…\") 바꿔 쓰지 않고 거부", async () => {
  await rejects('SELECT * FROM U&"contacts"', /확실히 읽지 못했습니다/);
  assert.equal((await plan('SELECT * FROM "contacts" c')).sql, `SELECT * FROM ${T("contacts")} c`);
});

test("forbiddenFunction — 막는 것과 흔한 함수는 통과", () => {
  for (const f of ["pg_sleep", "PG_TERMINATE_BACKEND", "set_config", "query_to_xmlschema", "cursor_to_xml", "has_schema_privilege", "to_regnamespace",
    "lo_unlink", "dblink_exec", "setval", "regclassout", "regtypein", "row_security_active", "brin_summarize_range", "inet_client_addr", "format"]) assert.ok(forbiddenFunction(f), f);
  for (const f of ["count", "coalesce", "date_trunc", "jsonb_build_object", "string_agg", "now", "lower", "to_char", "generate_series", "regexp_replace",
    "regexp_split_to_table", "to_tsvector", "concat", "json_agg", "gen_random_uuid"]) assert.ok(!forbiddenFunction(f), f);
});

// ── W 결과 상한 감싸기 ──────────────────────────────────────────────────────────────────
test("W1~W3 wrapForCaps — 결과 없는 쓰기는 그대로, SELECT 는 잘린 묶음 안에서, 쓰기+RETURNING 은 전체를 센다", async () => {
  const w = await plan("DELETE FROM contacts WHERE id = 1");
  assert.equal(wrapForCaps(w, { maxRows: 10, maxBytes: 100 }), w.sql);
  const s = wrapForCaps(await plan("SELECT * FROM contacts"), { maxRows: 10, maxBytes: 100 });
  assert.match(s, /LIMIT 11\b/);
  assert.match(s, /__lively_rn <= 10 AND __lively_s\.__lively_acc <= 100/);
  assert.match(s, /FROM __lively_m LEFT JOIN __lively_s/);
  assert.match(s, /count\(\*\) AS n FROM __lively_l\b/);
  const d = wrapForCaps(await plan("UPDATE contacts SET stage = 'x' WHERE id > 0 RETURNING id"), { maxRows: 10, maxBytes: 100 });
  assert.match(d, /count\(\*\) AS n FROM __lively_q\b/);
});

test("W4·W5 shapeResult — 끝 세 칸을 떼고, NULL 표지 행은 버리고, 겹친 칸 이름엔 _2, bytes 는 마지막 행 누적", () => {
  const fields = ["id", "name", "id", "__lively_rn", "__lively_acc", "__lively_total"].map((name) => ({ name }));
  const { result: r, bytes } = shapeResult({ returning: true, writes: false }, { fields, rows: [[1, "a", 9, 1, 10, 3], [2, "b", 8, 2, 20, 3]], rowCount: 2 }, 5);
  assert.deepEqual(r.columns, ["id", "name", "id_2"]);
  assert.deepEqual(r.rows, [{ id: 1, name: "a", id_2: 9 }, { id: 2, name: "b", id_2: 8 }]);
  assert.equal(r.truncated, true);
  assert.equal(r.changed, null);
  assert.equal(bytes, 20);
  const none = shapeResult({ returning: true, writes: true }, { fields, rows: [[null, null, null, null, null, 7]], rowCount: 1 }, 5);
  assert.equal(none.result.row_count, 0);
  assert.equal(none.result.changed, 7);
  assert.equal(none.result.truncated, true);
  assert.equal(none.bytes, 0);
  const empty = shapeResult({ returning: true, writes: false }, { fields, rows: [[null, null, null, null, null, 0]], rowCount: 1 }, 5);
  assert.equal(empty.result.truncated, false);
  const nr = shapeResult({ returning: false, writes: true }, { fields: [], rows: [], rowCount: 4 }, 1);
  assert.deepEqual([nr.result.changed, nr.bytes], [4, 0]);
  assert.throws(() => shapeResult({ returning: true, writes: false }, { fields: [{ name: "x" }], rows: [], rowCount: 0 }, 1), /모양/);
});

test("W6·W7 shapeWire — 이름은 겹쳐도 그대로(드라이버는 위치로 읽는다) · 형 OID · 값은 글자 그대로 · 표지 행 · RETURNING 없는 쓰기", () => {
  const fields = [["id", 20], ["amount", 1700], ["id", 23], ["__lively_rn", 20], ["__lively_acc", 1700], ["__lively_total", 20]].map(([name, dataTypeID]) => ({ name: String(name), dataTypeID: Number(dataTypeID) }));
  const { result: r, bytes } = shapeWire({ returning: true, writes: false }, { fields, rows: [["1", "10.50", "7", "1", "12", "1"]], rowCount: 1 }, 3);
  assert.deepEqual(r.fields, [{ name: "id", type: 20 }, { name: "amount", type: 1700 }, { name: "id", type: 23 }]);
  assert.deepEqual(r.rows, [["1", "10.50", "7"]]);
  assert.deepEqual([r.row_count, r.truncated, r.changed, bytes], [1, false, null, 12]);
  const cut = shapeWire({ returning: true, writes: true }, { fields, rows: [["1", "1.00", "1", "1", "9", "5"]], rowCount: 1 }, 3);
  assert.deepEqual([cut.result.row_count, cut.result.truncated, cut.result.changed], [1, true, 5]);
  const none = shapeWire({ returning: true, writes: false }, { fields, rows: [[null, null, null, null, null, "4"]], rowCount: 1 }, 3);
  assert.deepEqual([none.result.row_count, none.result.truncated], [0, true]);
  const nr = shapeWire({ returning: false, writes: true }, { fields: [], rows: [], rowCount: 2 }, 1);
  assert.deepEqual([nr.result.changed, nr.result.rows.length, nr.bytes], [2, 0, 0]);
});

// ── G 빈도·공평 분배·기본값 ─────────────────────────────────────────────────────────────
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

test("G1b TokenBuckets n개 — 남은 ≥ n 이면 n 만큼 쓰고, 모자라면 아무것도 쓰지 않는다(경계: 정확히 n)", () => {
  let now = 0;
  const b = new TokenBuckets(10, 5, () => now);
  assert.equal(b.take("k", 3), 0);                 // 5 → 2
  const w = b.take("k", 3);                         // 2 < 3 — 막히고 줄지 않는다
  assert.ok(w > 0 && w <= 100, String(w));
  assert.equal(b.take("k", 2), 0);                  // 정확히 2 남음 → 된다
  assert.ok(b.take("k", 1) > 0);
  now += 1000;                                      // 10 돌아오지만 순간 5 까지만
  assert.equal(b.take("k", 5), 0);
  assert.ok(b.take("big", 6) > 0, "순간보다 큰 n 은 늘 막힌다");
});

test("G6 FairScheduler — 전체·키 상한, 빈 자리는 가장 적게 쓰는 키부터(같으면 먼저 온 쪽), 시간 초과는 줄에서 빠진다, 두 번 풀어도 안전", async () => {
  // S1 · S6 — 키 상한에 걸린 대기자는 전체 자리가 비어도 기다리고, 다른 키는 곧바로 받는다.
  const s1 = new FairScheduler(3, 2);
  const a1 = await s1.acquire("A", 50), a2 = await s1.acquire("A", 50);
  assert.ok(a1 && a2);
  const a3p = s1.acquire("A", 500);
  const b1 = await s1.acquire("B", 50);
  assert.ok(b1, "B 는 곧바로");
  assert.equal(s1.inUse("A"), 2);
  assert.equal(s1.snapshot().used, 3);
  b1!();                                                  // 다른 키가 풀어 전체 자리가 나도, A 는 키 상한(2)이라 A3 는 그대로 기다린다
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([s1.inUse("A"), s1.snapshot().used, s1.snapshot().waiting], [2, 2, 1]);
  a1!();
  const a3 = await a3p;
  assert.ok(a3, "A 가 하나 풀면 A3");
  a2!(); a3!();
  assert.deepEqual(s1.snapshot(), { used: 0, waiting: 0, keys: 0 });

  // S2 — 먼저 줄 선 A3 보다, 지금 0 자리인 B 가 먼저 받는다.
  const s2 = new FairScheduler(2, 2);
  const x1 = await s2.acquire("A", 50), x2 = await s2.acquire("A", 50);
  const order: string[] = [];
  const pa = s2.acquire("A", 1000).then((r) => { order.push("A3"); return r; });
  const pb = s2.acquire("B", 1000).then((r) => { order.push("B1"); return r; });
  x1!();
  const gb = await pb;
  assert.deepEqual(order, ["B1"]);
  x2!();
  const ga = await pa;
  assert.deepEqual(order, ["B1", "A3"]);
  gb!(); ga!();

  // S3 — 둘 다 0 자리면 먼저 온 쪽.
  const s3 = new FairScheduler(1, 1);
  const h = await s3.acquire("X", 50);
  const got: string[] = [];
  const py = s3.acquire("Y", 1000).then((r) => { got.push("Y"); r?.(); });
  const pz = s3.acquire("Z", 1000).then((r) => { got.push("Z"); r?.(); });
  h!();
  await py; await pz;
  assert.deepEqual(got, ["Y", "Z"]);

  // S4 · S7 — 시간 초과는 null, 그 대기자는 나중에 자리를 받지 않는다.
  const s4 = new FairScheduler(1, 1);
  const k = await s4.acquire("K", 50);
  assert.equal(await s4.acquire("L", 0), null);
  assert.equal(await s4.acquire("K", 20), null);
  assert.equal(s4.snapshot().waiting, 0);
  k!();
  assert.deepEqual(s4.snapshot(), { used: 0, waiting: 0, keys: 0 });

  // S5 — 두 번 풀어도 셈이 음수가 되지 않고, 자리를 두 번 넘기지 않는다.
  const s5 = new FairScheduler(1, 1);
  const r1 = await s5.acquire("P", 50);
  const pq = s5.acquire("Q", 500);
  r1!(); r1!();
  const q1 = await pq;
  assert.ok(q1);
  assert.equal(s5.snapshot().used, 1);
  assert.equal(await s5.acquire("R", 20), null, "자리는 하나뿐이다");
  q1!();
  assert.equal(s5.snapshot().used, 0);
});

test("G7 묶음의 다음 문장 시간 상한 — 다 썼으면 abort, 남은 시간이 짧으면 줄이고, 0(=Postgres 의 «상한 없음»)은 절대 아니다", () => {
  assert.equal(nextStatementTimeout(0, 5000, 5000), "abort");
  assert.equal(nextStatementTimeout(-3, 5000, 5000), "abort");
  assert.equal(nextStatementTimeout(Number.NaN, 5000, 5000), "abort");
  assert.equal(nextStatementTimeout(0.2, 5000, 5000), 1);            // 0 으로 내려가지 않는다
  assert.equal(nextStatementTimeout(300, 5000, 5000), 300);
  assert.equal(nextStatementTimeout(300, 5000, 300), null);          // 이미 그 값
  assert.equal(nextStatementTimeout(6000, 5000, 5000), null);        // 문장 상한이 더 짧다
  assert.equal(nextStatementTimeout(250, 5000, 300), 250);
});

test("G8 앱 서버 빈도 — 사람마다 따로 · 앱 전체 상한 · 앱 전체에 막히면 그 사람 몫은 돌려준다 · 사람 없는 호출은 종전 그대로", async () => {
  const T = "6f477586-8eed-4e75-a321-3a1f0c9d2e41";
  //  사람 버킷은 사실상 다시 차지 않게(초당 0.001), 앱 전체는 빨리 차게(초당 1000) — 시계를 기다리지 않고 «돌려줌» 을 본다.
  resetAppSqlLimits({ LIVELY_APP_SQL_RATE: "0.001", LIVELY_APP_SQL_BURST: "2", LIVELY_APP_SQL_SERVER_RATE: "1000", LIVELY_APP_SQL_SERVER_BURST: "3" });
  try {
    takeAppCall("app", T, 1, "a"); takeAppCall("app", T, 1, "a");
    assert.throws(() => takeAppCall("app", T, 1, "a"), (e: { status?: number; message?: string }) => e.status === 429 && /이 사람/.test(String(e.message)));
    takeAppCall("app", T, 1, "b");                                        // 앱 전체 3번째
    assert.throws(() => takeAppCall("app", T, 1, "c"), (e: { status?: number; message?: string }) => e.status === 429 && /전체/.test(String(e.message)));
    await new Promise((r) => setTimeout(r, 20));                          // 앱 전체만 다시 찬다
    takeAppCall("app", T, 1, "c"); takeAppCall("app", T, 1, "c");         // c 는 막혔던 1번을 돌려받아 순간 2 를 그대로 쓴다
    assert.throws(() => takeAppCall("app", T, 1, "c"), /이 사람/);
    takeAppCall("other", T, 1, "a");                                      // 다른 앱은 따로 센다
    // 사람 없는 호출(앱 화면·세션) — (워크스페이스, 앱) 한 버킷, 종전과 같다.
    takeAppCall("solo", T); takeAppCall("solo", T);
    assert.throws(() => takeAppCall("solo", T), (e: { message?: string }) => /호출이 너무 잦습니다/.test(String(e.message)) && !/이 사람/.test(String(e.message)));
  } finally { resetAppSqlLimits({}); }
});

test("G1c TokenBuckets.refund — 돌려준 만큼 다시 쓸 수 있고, 순간 상한을 넘겨 쌓이지 않는다", () => {
  const b = new TokenBuckets(0.001, 2, () => 0);
  assert.equal(b.take("k", 2), 0);
  b.refund("k", 1);
  assert.equal(b.take("k"), 0);
  assert.ok(b.take("k") > 0);
  b.refund("k", 10);
  assert.equal(b.take("k", 2), 0);
  assert.ok(b.take("k") > 0, "순간 2 를 넘겨 쌓이지 않는다");
  b.refund("none", 1);                                                   // 모르는 키는 아무 일도 없다
  assert.equal(b.take("none", 2), 0);
});

test("G3 상한 기본값 — 계획 §7-3 의 값 + 묶음(20문장·10초) + 앱 서버(초당 50·순간 150), 잘못된 env 는 기본값", () => {
  const l = appSqlLimits({});
  assert.deepEqual(
    [l.poolMax, l.perWorkspace, l.statementMs, l.lockMs, l.maxRows, l.maxBytes, l.ratePerSec, l.burst, l.quotaBytes, l.batchMax, l.batchMs, l.serverRatePerSec, l.serverBurst],
    [4, 2, 5000, 1000, 5000, 5 * 1024 * 1024, 10, 30, 1024 * 1024 * 1024, 20, 10_000, 50, 150]);
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
