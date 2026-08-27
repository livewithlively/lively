// 화면 셸 기본값 전환(#2200) — 클래식 시대를 **딱 한 번** 닫는다 (**실제 Postgres 필요**, 기본 npm test 체인 밖).
//  실행: npm run build && LIVELY_PGTEST_DSN=postgres://…/… node src/org/schema/ui-mode-default.pg-test.mjs
//   (LIVELY_PGTEST_DSN 이 없으면 ITEMS_DATABASE_URL 을 쓴다 — `node --env-file=.env …`)
//  사양·엣지 표: <스크래치패드>/spec-ui-mode-default.md 의 8·9·10 행.
//
//  왜 PG 통합인가: 이 버그는 **컬럼 기본값과 마이그레이션 재실행**에 산다. `DEFAULT 'classic'` 도,
//   "이 UPDATE 가 두 번째 부팅에도 도나"도 타입스크립트를 읽어선 안 보인다 — 같은 DDL 을 **두 번**
//   태워 봐야 드러난다. identity-global-tenant.pg-test.mjs 와 같은 계열의 테스트다.
//
//  ⚠ 실 테이블을 건드리지 않는다 — 전용 스키마를 만들고 search_path 를 그리로 돌린 뒤, 끝나면 DROP 한다.
//   (그래서 마이그레이션의 걸쇠는 information_schema 의 table_schema='public' 이 아니라
//    'org_runtime_config'::regclass 로 판정한다 — 어느 스키마에 있든 지금 보이는 그 테이블을 본다.)
import pg from "pg";

const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { initRuntimeConfigTable, initRuntimeConfigPolicyColumns } = await import(`${DIST}/org/schema/runtime-config.js`);

const dsn = (process.env.LIVELY_PGTEST_DSN || process.env.ITEMS_DATABASE_URL || "").trim();
if (!dsn) {
  console.error("LIVELY_PGTEST_DSN(또는 ITEMS_DATABASE_URL)이 없습니다 — 실 DB 가 필요한 테스트입니다");
  process.exit(2);
}

const SCHEMA = "ui_mode_pgtest";
// 이 풀의 모든 커넥션이 전용 스키마만 보게 한다 — 마이그레이션이 실 public 테이블에 닿지 않는다.
//  (connect 훅에서 SET 을 날리면 첫 쿼리와 겹쳐 pg 가 경고를 낸다 — 접속 옵션으로 심는다.)
const pool = new pg.Pool({ connectionString: dsn, max: 2, options: `-c search_path=${SCHEMA}` });

let pass = 0, fail = 0;
const chk = (n, cond, why) => {
  if (cond) { pass++; console.log(`ok  ${n}`); }
  else { fail++; console.error(`not ok  ${n} — ${why ?? ""}`); }
};

// 지금 이 스키마의 ui_mode 컬럼 기본값(문자열) — 마이그레이션의 걸쇠가 보는 바로 그 값.
const columnDefault = async () => (await pool.query(
  `SELECT pg_get_expr(d.adbin, d.adrelid) def
     FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=$1::regclass AND a.attname='ui_mode'`, [`${SCHEMA}.org_runtime_config`])).rows[0]?.def ?? null;

const modes = async () => (await pool.query(
  `SELECT id, ui_mode FROM org_runtime_config ORDER BY id`)).rows.map((r) => `${r.id}:${r.ui_mode}`);

// 마이그레이션 한 판 = 게이트웨이 부팅 한 번.
const boot = async () => { await initRuntimeConfigTable(pool); await initRuntimeConfigPolicyColumns(pool); };

try {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);

  // ── 전제: '클래식 기본' 시대의 DB 를 재현한다 — 컬럼 기본값 classic + 워크스페이스 3개 ──────
  //  (id CHECK(id=1) 은 단일행 제약이라, 여러 워크스페이스를 흉내내려면 그 제약 없이 세운다.
  //   마이그레이션이 보는 것은 컬럼 기본값과 행의 ui_mode 값뿐이다.)
  await boot();
  await pool.query(`ALTER TABLE org_runtime_config DROP CONSTRAINT IF EXISTS org_runtime_config_id_check`);
  await pool.query(`ALTER TABLE org_runtime_config ALTER COLUMN ui_mode SET DEFAULT 'classic'`);
  await pool.query(`UPDATE org_runtime_config SET ui_mode='classic' WHERE id=1`);
  await pool.query(`INSERT INTO org_runtime_config(id, ui_mode) VALUES(2,'classic'), (3,'v2')`);
  chk("전제 — 클래식 시대 DB 재현", (await columnDefault())?.includes("classic") && (await modes()).join(",") === "1:classic,2:classic,3:v2",
    `default=${await columnDefault()} rows=${(await modes()).join(",")}`);

  // ── 8·10행 — 전환 첫 부팅: 기본값으로 굳은 행은 올리고, 이미 v2 인 행은 그대로 ──────────────
  await boot();
  chk("8행 전환 첫 부팅이 클래식으로 굳은 행을 v2 로 올린다", (await modes()).join(",") === "1:v2,2:v2,3:v2",
    `rows=${(await modes()).join(",")}`);
  chk("8행 컬럼 기본값도 v2 로 바뀐다", (await columnDefault())?.includes("v2"), `default=${await columnDefault()}`);

  // 새로 만든 워크스페이스가 컬럼 기본값만으로도 v2 로 태어난다(uiModeSafe 를 안 타는 직접 INSERT).
  await pool.query(`INSERT INTO org_runtime_config(id) VALUES(4)`);
  chk("8행 이후 새 행은 기본값만으로 v2 로 태어난다",
    (await pool.query(`SELECT ui_mode FROM org_runtime_config WHERE id=4`)).rows[0].ui_mode === "v2");

  // ── 9행 — 관리자가 클래식을 **고른** 뒤의 재부팅: 코드가 그 선택을 되돌리지 않는다 ───────────
  //  이게 걸쇠(컬럼 기본값이 아직 classic 인가)의 존재 이유다. 조건 없는 UPDATE 면 여기서 빨간불.
  await pool.query(`UPDATE org_runtime_config SET ui_mode='classic' WHERE id=2`);
  await boot();
  chk("9행 고른 클래식은 재부팅에도 살아남는다(백필이 다시 돌지 않는다)",
    (await pool.query(`SELECT ui_mode FROM org_runtime_config WHERE id=2`)).rows[0].ui_mode === "classic",
    "재부팅이 관리자의 선택을 v2 로 되돌렸다 — 걸쇠가 없거나 항상 참이다");

  await boot();  // 한 번 더 — 멱등 확인
  chk("9행 여러 번 재부팅해도 그대로",
    (await pool.query(`SELECT ui_mode FROM org_runtime_config WHERE id=2`)).rows[0].ui_mode === "classic");

  // ── 6행 — 새 DB(빈 스키마)는 처음부터 v2 ────────────────────────────────────────────────
  await pool.query(`DROP TABLE org_runtime_config`);
  await boot();
  chk("6행 새 설치는 컬럼 기본값도 첫 행도 v2",
    (await columnDefault())?.includes("v2") && (await modes()).join(",") === "1:v2",
    `default=${await columnDefault()} rows=${(await modes()).join(",")}`);
} catch (err) {
  fail++;
  console.error("테스트 실행 실패:", err instanceof Error ? (err.stack ?? err.message) : err);
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
