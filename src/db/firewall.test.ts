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
ok("isSystemDeniedTable: #604 확장 테이블 true", () => {
  for (const t of ["member_credential", "web_session", "git_credential", "org_connector", "mcp_call_log"]) {
    assert.equal(isSystemDeniedTable(t), true, t);
  }
});
rejects("member_credential 정책 없어도 차단", "SELECT * FROM member_credential", /Blocked table/);
rejects("git_credential 정책 없어도 차단", "SELECT https_token_enc FROM git_credential", /Blocked table/);
rejects("org_connector 정책 없어도 차단", "SELECT secrets FROM org_connector", /Blocked table/);
rejects("web_session 정책 없어도 차단", "SELECT session_hash FROM web_session", /Blocked table/);

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

console.log(`\n${pass} checks passed`);
