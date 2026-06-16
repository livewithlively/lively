// firewall 단위 체크 — RLS GUC 덮어쓰기/위험함수 차단 회귀(보안 핵심).
// 실행: npm run build && node dist/db/firewall.test.js
import assert from "node:assert/strict";
import { assertSafeSelect } from "./firewall.js";

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

console.log(`\n${pass} checks passed`);
