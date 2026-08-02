// firewall 단위 체크 — RLS GUC 덮어쓰기/위험함수 차단 회귀(보안 핵심).
// 실행: npm run build && node dist/db/firewall.test.js
import assert from "node:assert/strict";
import { assertSafeSelect, isSystemDeniedTable, type SourcePolicy } from "./firewall.js";
import { selfBaseTableMode, ITEMS_CONTENT_TABLES } from "./self-source.js";

let pass = 0;
const ok = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};
const rejects = (name: string, sql: string, re?: RegExp): void => {
  assert.throws(() => assertSafeSelect(sql), re ?? /./, name);
  pass++;
  console.log(`ok  ${name}`);
};

// ── 정상 SELECT 통과 ──
ok("정상 단일 SELECT 통과", () => assertSafeSelect("SELECT id, name FROM users WHERE id = 1"));
ok("조인/서브쿼리 정상 통과", () =>
  assertSafeSelect("SELECT u.id FROM users u WHERE u.id IN (SELECT user_id FROM orders)"));
ok("CTE 정상 통과(금지함수 없음)", () =>
  assertSafeSelect("WITH recent AS (SELECT id FROM orders WHERE id > 100) SELECT * FROM recent"));

// ── RLS GUC 덮어쓰기 차단 — 평문/CTE/서브쿼리/스키마수식 전부 거부(권한상승 방지) ──
rejects("set_config 평문 타깃리스트 거부", "SELECT set_config('app.current_user','admin',true), t.* FROM s t");
rejects(
  "set_config CTE 거부(실측 PoC)",
  "WITH x AS (SELECT set_config('app.current_user','admin',true)) SELECT t.* FROM s t, x",
);
rejects(
  "set_config WHERE 서브쿼리 거부",
  "SELECT * FROM s WHERE id = (SELECT 1 WHERE set_config('app.current_user','admin',true) IS NOT NULL)",
);
rejects("current_setting 거부", "SELECT current_setting('app.current_user'), t.* FROM s t");

// ── 기존 가드 유지 ──
rejects("쓰기(INSERT) 거부", "INSERT INTO t(a) VALUES(1)");
rejects("다중 문 거부", "SELECT 1; SELECT 2");
rejects("DDL(DROP) 거부", "DROP TABLE t");
rejects("pg_sleep 거부", "SELECT pg_sleep(10)");
rejects("pg_read_file 거부", "SELECT pg_read_file('/etc/passwd')");

// ══════════ 소스 정책(#186) — 테이블 게이트 + 게이트1(마스킹-파생 차단) ══════════
const policy = (over: Partial<SourcePolicy> = {}): SourcePolicy => ({
  tableDefault: "allow", tableMode: new Map(), maskedCols: new Set(), maskedColNames: new Set(), hasMasks: false, ...over,
});
const withMask = (...cols: string[]): SourcePolicy => policy({
  hasMasks: true, maskedCols: new Set(cols.map((c) => c.toLowerCase())),
  maskedColNames: new Set(cols.map((c) => c.split(".")[1].toLowerCase())),
});
const okP = (name: string, sql: string, pol: SourcePolicy, check?: (p: ReturnType<typeof assertSafeSelect>) => void): void => {
  const p = assertSafeSelect(sql, pol); if (check) check(p); pass++; console.log(`ok  ${name}`);
};
const rejectsP = (name: string, sql: string, pol: SourcePolicy, re?: RegExp): void => {
  assert.throws(() => assertSafeSelect(sql, pol), re ?? /./, name); pass++; console.log(`ok  ${name}`);
};

// ── 시스템 내부 테이블 절대 deny(B18) — 정책·소스 무관, 항상 차단 ──
ok("isSystemDeniedTable: 내부 테이블 true / 일반 false", () => {
  assert.equal(isSystemDeniedTable("Auth_Token"), true);
  assert.equal(isSystemDeniedTable("org_hook"), true);
  assert.equal(isSystemDeniedTable("org_harness_asset"), true);
  assert.equal(isSystemDeniedTable("org_asset_pref"), true); // #699 멤버 오버라이드(내부 테이블)
  assert.equal(isSystemDeniedTable("activity"), false);
});
rejects("시스템 테이블은 정책 없어도 차단", "SELECT * FROM auth_token", /Blocked table/);
// #604 백스톱 확대 — 시크릿/자격증명/세션/콜로그 (items DB self 소스 도입에 따른 노출면 확대 대응)
ok("isSystemDeniedTable: #604 확장 + #746 감사/자격 테이블 true", () => {
  for (const t of ["member_credential", "web_session", "git_credential", "org_connector", "mcp_call_log",
    "db_access_log", "org_db_subject_key", "member_secret"]) {
    assert.equal(isSystemDeniedTable(t), true, t);
  }
});
rejects("member_credential 정책 없어도 차단", "SELECT * FROM member_credential", /Blocked table/);
rejects("git_credential 정책 없어도 차단", "SELECT https_token_enc FROM git_credential", /Blocked table/);
rejects("org_connector 정책 없어도 차단", "SELECT secrets FROM org_connector", /Blocked table/);
rejects("web_session 정책 없어도 차단", "SELECT session_hash FROM web_session", /Blocked table/);
rejects("member_secret(P1 자격 vault) 정책 없어도 차단", "SELECT secret_enc FROM member_secret", /Blocked table/);
rejects("db_access_log(P5 감사) 정책 없어도 차단", "SELECT * FROM db_access_log", /Blocked table/);

// ── #604 내장 self 소스 정책(default-deny + 콘텐츠 allow-list) 집행 ──
const selfPolicy = (): SourcePolicy => policy({ tableDefault: "deny", tableMode: selfBaseTableMode() });
okP("self: 콘텐츠 테이블(knowledge) 통과", "SELECT name, title FROM knowledge", selfPolicy());
okP("self: 콘텐츠 조인(project↔task) 통과", "SELECT p.id FROM project p JOIN task t ON t.project_id=p.id", selfPolicy());
rejectsP("self: PII(person) 차단(allow-list 미포함)", "SELECT * FROM person", selfPolicy(), /Blocked table/);
rejectsP("self: org_member 차단", "SELECT email FROM org_member", selfPolicy(), /Blocked table/);
rejectsP("self: 시크릿 auth_token 차단(백스톱)", "SELECT * FROM auth_token", selfPolicy(), /Blocked table/);
ok("self allow-list: 시크릿/PII 미포함 회귀 가드", () => {
  const banned = ["auth_token", "member_credential", "git_credential", "org_connector", "web_session",
    "org_mcp_server", "org_hook", "org_tool", "org_harness_asset", "org_asset_pref", "org_db_source", "person", "person_identity", "org_member",
    "mcp_call_log", "org_content_audit"];
  for (const b of banned) assert.equal(ITEMS_CONTENT_TABLES.includes(b), false, `allow-list 에 ${b} 있으면 안 됨`);
});

// ── 테이블 게이트 ──
okP("정책 없음(hasMasks=false)=무변경 통과", "SELECT id FROM users", policy());
rejectsP("allow-list(default deny): 미등록 테이블 거부", "SELECT id FROM secret", policy({ tableDefault: "deny" }), /Blocked table/);
okP("allow-list(default deny): 명시 allow 통과", "SELECT id FROM users", policy({ tableDefault: "deny", tableMode: new Map([["users", "allow"]]) }));
rejectsP("deny-list(default allow): 명시 deny 거부", "SELECT id FROM audit_log", policy({ tableMode: new Map([["audit_log", "deny"]]) }), /Blocked table/);
rejectsP("게이트: 조인 중 한 테이블만 deny 여도 거부", "SELECT a.id FROM users a JOIN secret s ON s.id=a.id", policy({ tableDefault: "deny", tableMode: new Map([["users", "allow"]]) }), /Blocked table/);
// 정책 deny 에러는 막힌 테이블 이름을 구조화해 실어야 한다 — tools/db.ts 가 이걸로 '정책 deny 인가 실은
//  없는 이름인가'를 카탈로그로 갈라 답한다(#1259). 문구가 아니라 이 필드가 그 배선의 계약이다.
ok("정책 deny 에러에 blockedTable 이 실린다(문구 아닌 구조로 배선)", () => {
  assert.throws(
    () => assertSafeSelect("SELECT id FROM d_deal_seq", policy({ tableDefault: "deny" })),
    (e: Error & { blockedTable?: string; tables?: string[] }) =>
      e.blockedTable === "d_deal_seq" && Array.isArray(e.tables) && e.tables.includes("d_deal_seq"),
  );
});
// 시스템 내부 테이블 차단은 '없는 이름' 후보 안내 대상이 아니다 → blockedTable 을 달지 않는다.
ok("시스템 차단(B18)에는 blockedTable 이 없다", () => {
  assert.throws(
    () => assertSafeSelect("SELECT id FROM auth_token", policy()),
    (e: Error & { blockedTable?: string }) => e.blockedTable === undefined && /민감 테이블/.test(e.message),
  );
});
// mysql: 카탈로그 스키마를 SELECT 로 더듬으면 올바른 경로(db_schema)를 알려준다(#1259 — 실패 33건).
ok("mysql information_schema 차단에 db_schema 안내가 붙는다", () => {
  assert.throws(
    () => assertSafeSelect("SELECT table_name FROM information_schema.tables", policy(), { dialect: "mysql", schema: "example" }),
    /db_schema/,
  );
});
ok("일반 타 스키마 참조엔 db_schema 안내를 붙이지 않는다", () => {
  assert.throws(
    () => assertSafeSelect("SELECT id FROM otherdb.users", policy(), { dialect: "mysql", schema: "example" }),
    (e: Error) => /다른 스키마/.test(e.message) && !/db_schema/.test(e.message),
  );
});

// ── 게이트1: 마스킹 컬럼은 최상위 투영에 그대로/스타로만 ──
okP("ssn 최상위 투영 통과", "SELECT ssn FROM users", withMask("users.ssn"), (p) => assert.equal(p.minMaskedOutputs, 1));
okP("ssn AS x 통과(이름바꿔도)", "SELECT ssn AS x FROM users", withMask("users.ssn"), (p) => assert.equal(p.minMaskedOutputs, 1));
okP("id, ssn 혼합 통과", "SELECT id, ssn FROM users", withMask("users.ssn"), (p) => assert.equal(p.minMaskedOutputs, 1));
okP("u.ssn 수식 통과", "SELECT u.ssn FROM users u", withMask("users.ssn"), (p) => assert.equal(p.minMaskedOutputs, 1));
okP("* 통과 + hasTopStar", "SELECT * FROM users", withMask("users.ssn"), (p) => assert.equal(p.hasTopStarOverMaskedTable, true));
okP("마스킹 컬럼 미참조 통과(minMasked=0)", "SELECT id, name FROM users", withMask("users.ssn"), (p) => assert.equal(p.minMaskedOutputs, 0));
okP("마스킹 테이블 미참조면 동명 컬럼도 안전", "SELECT ssn FROM other", withMask("users.ssn"), (p) => assert.equal(p.minMaskedOutputs, 0));

rejectsP("표현식 감싸기 거부 substring(ssn)", "SELECT substring(ssn,1,3) FROM users", withMask("users.ssn"), /최상위 SELECT 투영/);
rejectsP("WHERE 필터 거부", "SELECT id FROM users WHERE ssn = '1'", withMask("users.ssn"), /최상위 SELECT 투영/);
rejectsP("ORDER BY 거부(정렬 추론)", "SELECT id FROM users ORDER BY ssn", withMask("users.ssn"), /최상위 SELECT 투영/);
rejectsP("집계 max(ssn) 거부", "SELECT max(ssn) FROM users", withMask("users.ssn"), /최상위 SELECT 투영/);
rejectsP("서브쿼리 반출 거부", "SELECT s FROM (SELECT ssn AS s FROM users) t", withMask("users.ssn"), /최상위 SELECT 투영/);
rejectsP("수식 WHERE(u.ssn) 거부", "SELECT u.id FROM users u WHERE u.ssn='1'", withMask("users.ssn"), /최상위 SELECT 투영/);
rejectsP("UNION 관여 거부", "SELECT ssn FROM users UNION SELECT ssn FROM u2", withMask("users.ssn"), /집합연산/);
rejectsP("서브쿼리 * 반출 거부", "SELECT x.id FROM (SELECT * FROM users) x", withMask("users.ssn"), /비최상위/);
rejectsP("CTE 반출 거부", "WITH c AS (SELECT ssn FROM users) SELECT * FROM c", withMask("users.ssn"), /최상위 SELECT 투영/);

// ══════════ mysql dialect(#715) — Aurora MySQL 소스용 파서·차단목록·크로스-스키마 ══════════
const MY = { dialect: "mysql" as const, schema: "hf" };
const okMy = (name: string, sql: string, pol?: SourcePolicy, check?: (p: ReturnType<typeof assertSafeSelect>) => void): void => {
  const p = assertSafeSelect(sql, pol, MY); if (check) check(p); pass++; console.log(`ok  ${name}`);
};
const rejMy = (name: string, sql: string, re?: RegExp, pol?: SourcePolicy): void => {
  assert.throws(() => assertSafeSelect(sql, pol, MY), re ?? /./, name); pass++; console.log(`ok  ${name}`);
};

okMy("mysql: 기본 SELECT(백틱) 통과", "SELECT `id`, `name` FROM `tb_lo_apply` WHERE `id` = 1");
okMy("mysql: 같은 스키마 수식 통과", "SELECT id FROM hf.tb_lo_apply");
okMy("mysql: 조인/서브쿼리 통과", "SELECT u.id FROM users u WHERE u.id IN (SELECT user_id FROM orders)");
rejMy("mysql: 크로스 스키마(db-수식) 거부", "SELECT secret FROM otherdb.tb_secret", /다른 스키마/);
rejMy("mysql: information_schema 수식 거부", "SELECT table_name FROM information_schema.tables", /다른 스키마/);
rejMy("mysql: mysql 시스템 스키마 거부", "SELECT user FROM mysql.user", /다른 스키마/);
rejMy("mysql: 조인에 낀 크로스 스키마도 거부", "SELECT a.id FROM users a JOIN otherdb.t b ON b.id=a.id", /다른 스키마/);
rejMy("mysql: INTO OUTFILE 거부", "SELECT * FROM t INTO OUTFILE '/tmp/x'", /Blocked SQL/);
rejMy("mysql: LOAD_FILE 거부", "SELECT LOAD_FILE('/etc/passwd')", /Blocked/);
rejMy("mysql: SLEEP 거부", "SELECT SLEEP(10)", /Blocked/);
rejMy("mysql: BENCHMARK 거부", "SELECT BENCHMARK(100000000, SHA1('x'))", /Blocked/);
rejMy("mysql: GET_LOCK 거부", "SELECT GET_LOCK('a', 10)", /Blocked/);
rejMy("mysql: SET SESSION(주입 타임아웃 무력화) 거부", "SET SESSION max_execution_time=0", /Blocked/);
rejMy("mysql: SET @@ 거부", "SET @@max_execution_time=0", /Blocked/);
rejMy("mysql: REPLACE INTO(쓰기) 거부", "REPLACE INTO t VALUES (1)", /Blocked/);
rejMy("mysql: LOAD DATA 거부", "LOAD DATA INFILE 'x' INTO TABLE t", /Blocked/);
rejMy("mysql: INSERT 거부", "INSERT INTO t(a) VALUES(1)", /Blocked/);
rejMy("mysql: 다중 문 거부", "SELECT 1; SELECT 2");

// mysql 게이트1(마스킹-파생 차단) — pg 와 동일 AST 규칙이 mysql dialect 에서도 동작
okMy("mysql 게이트1: 별칭 최상위 투영 통과 + minMasked=1", "SELECT ssn AS x FROM users", withMask("users.ssn"),
  (p) => assert.equal(p.minMaskedOutputs, 1));
okMy("mysql 게이트1: * 통과 + hasTopStar", "SELECT * FROM users", withMask("users.ssn"),
  (p) => assert.equal(p.hasTopStarOverMaskedTable, true));
rejMy("mysql 게이트1: WHERE 필터 거부", "SELECT id FROM users WHERE ssn = '1'", /최상위 SELECT 투영/, withMask("users.ssn"));
rejMy("mysql 게이트1: substring 파생 거부", "SELECT substring(ssn,1,3) FROM users", /최상위 SELECT 투영/, withMask("users.ssn"));
rejMy("mysql 게이트1: 파생테이블 반출 거부", "SELECT s FROM (SELECT ssn AS s FROM users) d", /최상위 SELECT 투영/, withMask("users.ssn"));
rejMy("mysql 게이트1: 비최상위 * 거부", "SELECT x.id FROM (SELECT * FROM users) x", /비최상위/, withMask("users.ssn"));
rejMy("mysql 게이트1: UNION 관여 거부", "SELECT ssn FROM users UNION SELECT ssn FROM u2", /집합연산/, withMask("users.ssn"));
rejMy("mysql 테이블 게이트: allow-list 미등록 거부", "SELECT id FROM secret",
  /Blocked table/, policy({ tableDefault: "deny", tableMode: new Map([["users", "allow"]]) }));
okMy("mysql 테이블 게이트: 명시 allow 통과", "SELECT id FROM users", policy({ tableDefault: "deny", tableMode: new Map([["users", "allow"]]) }));

// ══════════ #1181 ① CTE(WITH) 는 테이블이 아니다 — 별칭을 실제 테이블로 오인해 차단하던 버그 ══════════
//  게이트는 '실제 테이블 참조'에만 걸린다. CTE 가시범위는 pg 규칙(앞서 정의된 것만 · RECURSIVE 는 자기 자신 ·
//  스코프 밖 불가)을 따르고, 같은 이름이 어디선가 실제 테이블로도 쓰였으면 게이트를 적용한다(fail-closed).
okP("CTE 1-1: 단순 WITH 통과(원 버그 재현)", "with c as (select 1 as x) select * from c", selfPolicy());
okP("CTE 1-2: 집계 CTE→조인 통과",
  "with cent as (select project_id, count(*) as n from activity group by project_id) select p.id, cent.n from project p join cent on cent.project_id = p.id",
  selfPolicy());
okP("CTE 1-3: 뒤 CTE 가 앞 CTE 참조(경계: N→N-1)", "with a as (select id from knowledge), b as (select id from a) select * from b", selfPolicy());
okP("CTE 1-4: WITH RECURSIVE 자기참조(경계: 자기 자신)",
  "with recursive t as (select 1 as n union all select n + 1 from t where n < 5) select n from t", selfPolicy());
okP("CTE 1-5: 서브쿼리 안의 WITH", "select t.a from (with inner_c as (select 1 as a) select a from inner_c) t", selfPolicy());
okP("CTE 1-6: 대문자 CTE 이름·다른 대소문자 참조(인용식별자 없음 → 폴딩)", "WITH Cent AS (select 1 as x) SELECT * FROM CENT", selfPolicy());
rejectsP("CTE 1-7: CTE + 미허용 실제 테이블 조인은 차단", "with c as (select 1 as x) select c.x from c, person", selfPolicy(), /Blocked table: person/);
rejectsP("CTE 1-8: CTE 본문의 미허용 테이블 차단", "with c as (select id from person) select * from c", selfPolicy(), /Blocked table: person/);
rejectsP("CTE 1-9: 앞 CTE 가 뒤에 정의된 이름 참조 = 실제 테이블(경계: N→N+1 불가)",
  "with a as (select id from person), person as (select 1 as id) select * from a", selfPolicy(), /Blocked table: person/);
rejectsP("CTE 1-10: 다른 스코프의 CTE 이름으로 바깥 테이블 shadow 불가",
  "select (select count(*) from person) as n from (with person as (select 1 as a) select a from person) t", selfPolicy(), /Blocked table: person/);
rejects("CTE 1-11: 시스템 차단 테이블명은 CTE 이름으로 불가", "with auth_token as (select 1 as x) select * from auth_token", /CTE 이름/);
rejectsP("CTE 1-12: 마스킹 컬럼 CTE 반출은 계속 차단", "WITH c AS (SELECT ssn FROM users) SELECT * FROM c", withMask("users.ssn"), /최상위 SELECT 투영/);
rejectsP("CTE 1-13: 인용식별자에 대문자 있으면 보수 판정(fail-closed)",
  'with "Person" as (select 1 as id) select * from person', selfPolicy(), /Blocked table: person/);
okP("CTE 1-14: CTE 없는 쿼리는 기존과 동일", "select name from knowledge where name = 'x'", selfPolicy(),
  (p) => assert.deepEqual(p.tables, ["knowledge"]));
ok("CTE 1-15: FROM 없는 쿼리(빈 입력)", () => assertSafeSelect("select 1"));
okP("CTE 1-16: 감사 tables 에 CTE 이름은 안 들어간다(실제 테이블만)",
  "with cent as (select project_id from activity) select p.id from project p join cent on cent.project_id = p.id", selfPolicy(),
  (p) => assert.deepEqual([...(p.tables ?? [])].sort(), ["activity", "project"]));

// ══════════ #1181 ② pgvector 거리연산자(<=> <-> <#> <+>) 를 읽는다 ══════════
//  파싱만 열어주는 것 — 테이블·마스킹·금지함수 게이트는 그대로다. 실행 SQL 은 사용자 원본.
okP("vec 2-1: <=> (코사인)", "select id, embedding_vector <=> embedding_vector as d from knowledge limit 1", selfPolicy());
okP("vec 2-2: <-> (L2)", "select embedding_vector <-> embedding_vector as d from knowledge", selfPolicy());
okP("vec 2-3: <#> (내적)", "select embedding_vector <#> embedding_vector as d from knowledge", selfPolicy());
okP("vec 2-4: <+> (L1)", "select embedding_vector <+> embedding_vector as d from knowledge", selfPolicy());
okP("vec 2-5: ORDER BY 거리 + CTE 조합(두 수정의 상호작용)",
  "with q as (select embedding_vector as v from knowledge where name = 'x') select k.name, k.embedding_vector <=> q.v as d from knowledge k, q order by d limit 5",
  selfPolicy(), (p) => assert.deepEqual(p.tables, ["knowledge"]));
ok("vec 2-6: <= · <> · < 는 무변경(경계: 앞 2글자가 같은 연산자)", () =>
  assertSafeSelect("select id from users where id <= 10 and id <> 3 and id < 99"));
okP("vec 2-7: 문자열 리터럴 안의 <=> 는 값", "select name from knowledge where name = 'a <=> b'", selfPolicy());
okP("vec 2-8: 줄주석 안의 <=>", "select name from knowledge -- a <=> b\n", selfPolicy());
okP("vec 2-9: 블록주석 안의 <=>", "select /* a <=> b */ name from knowledge", selfPolicy());
rejectsP("vec 2-10: 미허용 테이블은 벡터연산과 무관하게 차단",
  "select embedding_vector <=> embedding_vector as d from person", selfPolicy(), /Blocked table: person/);
rejectsP("vec 2-11: 마스킹 컬럼의 벡터연산 파생 차단", "SELECT ssn <=> ssn FROM users", withMask("users.ssn"), /최상위 SELECT 투영/);
rejects("vec 2-12: 중화해도 금지함수는 차단", "select pg_read_file('/etc/passwd') <=> x as d from t", /Blocked/);
rejMy("vec 2-13: mysql dialect 는 대상 아님(기존대로 거부)", "select a <=> b from t", /Unparseable/);
okP("vec 2-14: 벡터연산자 없는 평범한 쿼리 무변경", "select id from project", selfPolicy(), (p) => assert.deepEqual(p.tables, ["project"]));
okP("vec 2-15: 벡터연산 쿼리도 감사 tables 가 실제로 채워진다(관측 배선)",
  "select embedding_vector <=> embedding_vector as d from knowledge", selfPolicy(),
  (p) => assert.deepEqual(p.tables, ["knowledge"]));

// ══════════ #1181 ③ pg 연산자 일반 — 파서가 모르는 연산자에 SQL 이 막히지 않는다 ══════════
//  ②의 pgvector 특례를 일반 규칙으로: 연산자 문자 런을 pg 렉싱 규칙대로 읽어 '파서가 아는 연산자면
//  그대로, 모르면 중화'. 게이트(테이블·마스킹·금지함수)는 그대로다.
okP("op 3-1: 전문검색 @@", "select name from knowledge where search_vector @@ to_tsquery('x')", selfPolicy());
okP("op 3-2: 거듭제곱 ^", "select id ^ 2 as p from project", selfPolicy());
okP("op 3-3: starts-with ^@", "select name from knowledge where name ^@ 'run'", selfPolicy());
okP("op 3-4: jsonpath @?", "select name from knowledge where fields @? '$.x'", selfPolicy());
okP("op 3-5: 시프트·범위 << >> <<= -|-", "select id << 2 as a, id >> 1 as b from project where id <<= 5 and id -|- 3", selfPolicy());
okP("op 3-6: 비트 & | #", "select id & 1 as a, id | 2 as b, id # 3 as c from project", selfPolicy());
// 회귀 — 파서가 이미 아는 연산자는 건드리면 안 된다. 런 매칭이 부정확해 다중문자 연산자를 잘라먹으면
//  (`#>>`→`#>`, `?|`→`?`) 남은 글자가 그대로 남아 파싱이 깨진다 = 이 케이스의 red 신호.
okP("op 3-7: JSONB -> ->> #> #>> @> <@ ? ?| #- (이미 지원 — 무변경)",
  "select fields -> 'a' as x, fields ->> 'b' as y, fields #> '{c}' as z, fields #>> '{d}' as w from knowledge where fields @> '{}' and fields <@ '{}' and fields ? 'k' and fields ?| array['k'] and (fields #- '{e}') is not null",
  selfPolicy());
okP("op 3-8: 배열 && · concat ||", "select name || '!' as n from knowledge where fields && fields", selfPolicy());
okP("op 3-9: 정규식 ~ ~* !~ !~*", "select name from knowledge where name ~ '^a' and name ~* 'b' and name !~ 'c' and name !~* 'd'", selfPolicy());
rejectsP("op 3-10: 미지원 연산자여도 테이블 게이트 유지", "select id ^ 2 as p from person", selfPolicy(), /Blocked table: person/);
rejectsP("op 3-11: 미지원 연산자여도 마스킹 파생 차단", "SELECT ssn ^ 2 AS p FROM users", withMask("users.ssn"), /최상위 SELECT 투영/);
rejects("op 3-12: 미지원 연산자여도 금지함수 차단", "select current_setting('app.current_user') @@ x as r from t", /Blocked/);
okP("op 3-13: 문자열 리터럴 안의 @@ 는 값", "select name from knowledge where name = 'a @@ b'", selfPolicy());
ok("op 3-14: 경계 — 지원 연산자 <= <> >= 는 런 매칭에서 그대로", () =>
  assertSafeSelect("select id from users where id <= 10 and id <> 3 and id >= 1"));
okP("op 3-15: 런 경계 — a<=>-1 은 pg 렉싱대로 <=> 만 중화",
  "select id from knowledge where embedding_vector <=>-embedding_vector < 1", selfPolicy());
// 알려진 한계(문서화) — 단항 위치의 미지원 연산자는 중화해도 파싱이 안 돼 거부된다(fail-closed).
rejects("op 3-16: 한계 — 단항 |/ (제곱근) 는 여전히 거부", "select |/ 16 as r from t", /Unparseable/);
// mysql dialect 는 중화 대상이 아니다 — 원래 파싱되던 건 그대로 되고(아래), 원래 안 되던 <=> 는 그대로 거부(vec 2-13).
okMy("op 3-17: mysql dialect 무변경 — 원래 되던 비트연산 & 는 그대로 통과", "select a & b from t");

console.log(`\n${pass} checks passed`);
