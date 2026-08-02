// P5(#746) db_access_log 통합 검증 — "실제 Postgres" 위에서만 확인 가능한 것들을 검증한다:
//  DDL 멱등(전체 initOrgSchema) · 해시체인 jsonb/timestamptz 왕복 재현 · append-only 트리거 3종 ·
//  변조 시뮬 검출 · tables ? GIN 필터 · advisory-lock 병렬 체인 무결 · error 스크럽 저장.
//
// 실행(스크래치 DB 필수 — 운영 items DB 에 절대 돌리지 말 것. 테이블은 새로 만들지만 initOrgSchema 가 전 스키마를 만든다):
//   1) npm run build
//   2) 빈 Postgres 준비(도커 불가 박스는 유저스페이스 추출 패턴 — #715 mysqld·#746 pg14 선례:
//        apt-get download postgresql-14 postgresql-client-14 libpq5 && dpkg -x … && initdb && pg_ctl start
//        ⚠ unix socket 경로 107자 제한 — 짧은 -k 디렉터리 사용)
//   3) ITEMS_DATABASE_URL='postgresql://postgres@localhost/audit_test?host=/tmp/pgXXX&port=54329' node scripts/integration/db-access-log-pg.mjs
import { fileURLToPath } from "node:url";
import path from "node:path";

if (!process.env.ITEMS_DATABASE_URL) {
  console.error("ITEMS_DATABASE_URL 미설정 — 스크래치 pg 를 가리키게 하고 다시 실행하세요(운영 DB 금지)");
  process.exit(2);
}
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
const { initOrgSchema } = await import(path.join(DIST, "org/schema.js"));
const { itemsPool } = await import(path.join(DIST, "items/store.js"));
const { recordDbAccess, computeRowHash, GENESIS } = await import(path.join(DIST, "db/access-log.js"));

const toFields = (row, prevIgnored) => ({
  at: new Date(row.at).toISOString(), userId: row.user_id, tokenHashPrefix: row.token_hash_prefix,
  harness: row.harness, op: row.op, source: row.source, sql: row.sql,
  tables: row.tables ?? [], maskedColumns: row.masked_columns ?? [], unmaskedColumns: row.unmasked_columns ?? [],
  grantIds: row.grant_ids ?? null, subjectKeys: row.subject_keys ?? null,
  rowCount: row.row_count, durationMs: row.duration_ms, ok: row.ok, error: row.error,
});
const verifyChain = (rows) => {
  let prev = GENESIS;
  for (const row of rows) {
    if (row.prev_hash !== prev) return { ok: false, id: row.id, reason: "prev_hash" };
    if (computeRowHash(prev, toFields(row)) !== row.row_hash) return { ok: false, id: row.id, reason: "row_hash" };
    prev = row.row_hash;
  }
  return { ok: true };
};

let step = "";
const ok = (m) => console.log("ok  " + m);
try {
  step = "① initOrgSchema(전체 마이그레이션 — 신규 DDL 포함, 멱등 2회)";
  await initOrgSchema();
  await initOrgSchema(); // 멱등 재실행
  ok(step);

  step = "② 체인 기록(성공 + 실패/에러리터럴)";
  await recordDbAccess({ userId: "u1", tokenHashPrefix: "ab", harness: "claude", op: "query", source: "prod",
    sql: "SELECT id, name FROM users WHERE name = '홍길동'", tables: ["users"], maskedColumns: ["name"],
    rowCount: 2, durationMs: 10, ok: true, subjectKeys: { "users.id": { values: ["1", "2"], distinct: 2, truncated: false } } });
  await recordDbAccess({ userId: "u2", tokenHashPrefix: null, harness: "codex", op: "query", source: "prod",
    sql: "SELECT count(*) FROM orders", tables: ["orders"], maskedColumns: [], rowCount: 0, durationMs: 5,
    ok: false, error: 'invalid input syntax for type integer: "주민801010"' });
  ok(step);

  step = "③ DB 왕복 재계산 일치(jsonb·timestamptz) + sql/error 스크럽 확인";
  const r = await itemsPool.query("SELECT * FROM db_access_log ORDER BY id ASC");
  if (r.rows.length !== 2) throw new Error("행 수 " + r.rows.length);
  const v = verifyChain(r.rows);
  if (!v.ok) throw new Error(`체인 검증 실패 id=${v.id} (${v.reason})`);
  if (r.rows[0].sql.includes("홍길동")) throw new Error("SQL 스크럽 실패");
  if (String(r.rows[1].error).includes("주민801010")) throw new Error("error 스크럽 실패");
  ok(step);

  step = "④ append-only 트리거(UPDATE/DELETE/TRUNCATE 차단) + op CHECK";
  let blocked = 0;
  for (const q of ["UPDATE db_access_log SET row_count=999 WHERE id=1", "DELETE FROM db_access_log WHERE id=1", "TRUNCATE db_access_log"]) {
    try { await itemsPool.query(q); } catch (e) { if (String(e.message).includes("append-only")) blocked++; }
  }
  if (blocked !== 3) throw new Error("차단 " + blocked + "/3");
  try {
    await itemsPool.query(`INSERT INTO db_access_log(at,user_id,op,source,tables,masked_columns,unmasked_columns,row_count,ok,prev_hash,row_hash)
      VALUES(now(),'x','bogus','s','[]','[]','[]',0,true,'p','h')`);
    throw new Error("op CHECK 미동작");
  } catch (e) { if (!String(e.message).includes("db_access_log_op_chk")) throw e; }
  ok(step);

  step = "⑤ 변조 시뮬(트리거 해제 후 UPDATE) → 체인 검증 검출";
  await itemsPool.query("ALTER TABLE db_access_log DISABLE TRIGGER db_access_log_immutable");
  await itemsPool.query("UPDATE db_access_log SET row_count=999 WHERE id=1");
  await itemsPool.query("ALTER TABLE db_access_log ENABLE TRIGGER db_access_log_immutable");
  const r2 = await itemsPool.query("SELECT * FROM db_access_log ORDER BY id ASC");
  if (verifyChain(r2.rows).ok) throw new Error("변조 미검출!");
  ok(step);

  step = "⑥ 필터(tables ? $1 — GIN)·errors-only";
  const f1 = await itemsPool.query("SELECT count(*)::int AS c FROM db_access_log WHERE tables ? $1", ["users"]);
  const f2 = await itemsPool.query("SELECT count(*)::int AS c FROM db_access_log WHERE ok=false");
  if (f1.rows[0].c !== 1 || f2.rows[0].c !== 1) throw new Error(`filter ${f1.rows[0].c}/${f2.rows[0].c}`);
  ok(step);

  step = "⑦ 동시성 — 20건 병렬 기록 후 체인 연결 무결(advisory lock)";
  await Promise.all(Array.from({ length: 20 }, (_, i) => recordDbAccess({
    userId: "u" + i, op: "query", source: "prod", sql: "SELECT 1", tables: [], maskedColumns: [],
    rowCount: 1, durationMs: 1, ok: true })));
  const r3 = await itemsPool.query("SELECT prev_hash, row_hash FROM db_access_log ORDER BY id ASC");
  let prev3 = null, chainOk = true;
  for (const row of r3.rows) { if (prev3 !== null && row.prev_hash !== prev3) { chainOk = false; break; } prev3 = row.row_hash; }
  if (!chainOk) throw new Error("병렬 기록 체인 절단");
  ok(step + ` (총 ${r3.rows.length}행)`);

  console.log("\nINTEGRATION ALL GREEN");
} catch (e) {
  console.error("FAIL @ " + step + " — " + e.message);
  process.exitCode = 1;
} finally {
  await itemsPool.end();
}
