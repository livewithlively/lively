// 세션↔프로젝트 **마이그레이션** 통합검증(#905 C1) — 옛 단일키 테이블 → 시간구간 복합키로 안전 이관.
//  ⚠ 수동 실행(docker). 라이브 DB 무접촉. 실행:  node scripts/session-project-migration.itest.mjs
//  이 아래 SQL 블록은 src/v6/schema.ts 의 session_project await pool.query(...) 내용을 그대로 미러(이관 로직 검증).
//  검증: 기존 데이터 위에서 ① valid_from 백필(=created_at) ② PK 단일→복합 교체 ③ 재실행 멱등 ④ 이관 후 구간 삽입 가능.
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59439;
const CNAME = "co-c1-sp-mig-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
function sh(cmd) { return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString(); }

// src/v6/schema.ts 미러 — 신규설치는 CREATE 로 이미 복합키(아래 ALTER/DO 는 no-op), 기존설치는 ALTER/DO 로 이관.
const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS session_project(
    session_id TEXT NOT NULL,
    project_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, valid_from));
  CREATE INDEX IF NOT EXISTS session_project_project_idx ON session_project(project_id);
  ALTER TABLE session_project ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
  UPDATE session_project SET valid_from = created_at WHERE valid_from IS NULL;
  ALTER TABLE session_project ALTER COLUMN valid_from SET NOT NULL;
  ALTER TABLE session_project ALTER COLUMN valid_from SET DEFAULT now();
  DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint con JOIN pg_index i ON i.indexrelid = con.conindid
      WHERE con.conrelid = 'session_project'::regclass AND con.contype = 'p'
        AND array_length(i.indkey, 1) = 1) THEN
      ALTER TABLE session_project DROP CONSTRAINT session_project_pkey;
      ALTER TABLE session_project ADD CONSTRAINT session_project_pkey PRIMARY KEY (session_id, valid_from);
    END IF;
  END $$;
`;

// PK 가 몇 컬럼인지(1=단일키 옛모델, 2=복합키 신모델).
async function pkArity(pool) {
  const r = await pool.query(`
    SELECT array_length(i.indkey, 1) AS n
      FROM pg_constraint con JOIN pg_index i ON i.indexrelid = con.conindid
     WHERE con.conrelid = 'session_project'::regclass AND con.contype = 'p'`);
  return r.rows[0]?.n ?? null;
}

try { sh(`docker rm -f -v ${CNAME} 2>/dev/null`); } catch { /* */ }
console.log("· pg 컨테이너 기동…");
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw",
  "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });

try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ }
    execSync("sleep 0.5");
  }
  assert.ok(ready, "pg 준비 실패");
  execSync("sleep 0.5");

  process.env.ITEMS_DATABASE_URL = url;
  const { itemsPool } = await import("../dist/items/store.js");

  // ── 기존 배포 재현: 옛 단일키 session_project + 데이터 ──
  await itemsPool.query(`CREATE TABLE project(id SERIAL PRIMARY KEY, name TEXT);`);
  await itemsPool.query(`INSERT INTO project(id, name) VALUES (1,'A'),(2,'B');`);
  await itemsPool.query(`SELECT setval('project_id_seq', 2, true);`);
  await itemsPool.query(`
    CREATE TABLE session_project(
      session_id TEXT PRIMARY KEY,
      project_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  // 서로 다른 created_at 을 가진 옛 바인딩 두 개(백필이 created_at 을 정확히 따르는지 보려고).
  await itemsPool.query(
    `INSERT INTO session_project(session_id, project_id, created_at)
       VALUES ('sX', 1, '2025-01-01T00:00:00Z'), ('sY', 2, '2025-06-15T12:00:00Z');`);

  assert.equal(await pkArity(itemsPool), 1, "사전조건: 옛 테이블 PK 는 단일키(session_id)");

  // ── 이관 실행 ──
  await itemsPool.query(MIGRATION_SQL);

  // ① 백필: valid_from = 각 행의 created_at ──
  {
    const r = await itemsPool.query(
      `SELECT session_id, valid_from, created_at, (valid_from = created_at) AS eq
         FROM session_project ORDER BY session_id`);
    assert.equal(r.rows.length, 2, "기존 두 행 보존");
    for (const row of r.rows) assert.equal(row.eq, true, `${row.session_id}: valid_from 이 created_at 으로 백필돼야`);
    ok("① 이관 — valid_from 을 기존 created_at 으로 정확히 백필");
  }

  // ② PK 교체: 단일 → 복합(session_id, valid_from) ──
  {
    assert.equal(await pkArity(itemsPool), 2, "PK 가 복합키로 교체돼야");
    // NOT NULL 확정
    const nn = await itemsPool.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name='session_project' AND column_name='valid_from'`);
    assert.equal(nn.rows[0].is_nullable, "NO", "valid_from 은 NOT NULL");
    ok("② 이관 — PK 단일키→복합키 교체 + valid_from NOT NULL");
  }

  // ③ 재실행 멱등: 이관 SQL 을 또 돌려도 무해(PK 재구축 없이 그대로) ──
  {
    await itemsPool.query(MIGRATION_SQL);
    await itemsPool.query(MIGRATION_SQL);
    assert.equal(await pkArity(itemsPool), 2, "재실행해도 복합키 유지");
    const r = await itemsPool.query(`SELECT count(*)::int c FROM session_project`);
    assert.equal(r.rows[0].c, 2, "재실행이 행을 늘리거나 지우지 않음");
    ok("③ 이관 SQL 재실행 멱등(복합키 유지·데이터 불변)");
  }

  // ④ 이관 후 시간구간 삽입 가능: 같은 세션에 다른 valid_from 구간을 덧붙일 수 있다(옛 모델선 PK 충돌로 불가) ──
  {
    await itemsPool.query(
      `INSERT INTO session_project(session_id, project_id, valid_from) VALUES ('sX', 2, '2025-09-01T00:00:00Z')`);
    const r = await itemsPool.query(
      `SELECT project_id FROM session_project WHERE session_id='sX' ORDER BY valid_from`);
    assert.deepEqual(r.rows.map((x) => x.project_id), [1, 2], "sX 가 A(1)→B(2) 두 구간을 가진다");
    // 같은 (session_id, valid_from) 재삽입은 PK 충돌(복합키가 유일성 보장)
    await assert.rejects(
      itemsPool.query(`INSERT INTO session_project(session_id, project_id, valid_from) VALUES ('sX', 1, '2025-09-01T00:00:00Z')`),
      "같은 (session,valid_from) 중복은 거부돼야(복합 PK)");
    ok("④ 이관 후 — 한 세션에 여러 구간 공존 + 복합키 유일성 유지");
  }

  await itemsPool.end();
  console.log(`\n${pass} passed`);
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
