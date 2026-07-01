// firewall 단위 체크 — RLS GUC 덮어쓰기/위험함수 차단 회귀(보안 핵심).
// 실행: npm run build && node dist/db/firewall.test.js
import assert from "node:assert/strict";
import { assertSafeSelect, type SourcePolicy } from "./firewall.js";

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

console.log(`\n${pass} checks passed`);
