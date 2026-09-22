// 앱 데이터 테이블 DDL 경로(#4223) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행(슈퍼유저 DSN 을 ITEMS_DATABASE_URL 로 준다):
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/store-schema.pg-test.mjs
//
// 왜 이 계층인가: 매니지드에서 앱 데이터 층이 한 번도 동작하지 않았다(2026-09-22 실측 — 공용 DB 에 app 스키마가 없었다).
//  원인은 SQL 이 아니라 **자격**이었다: 게이트웨이는 런타임 role(lvly_app)로만 붙어 CREATE SCHEMA 권한이 없는데,
//  생성 실패를 경고로만 삼키고 설치를 성공 처리했다. 목 풀로는 권한도 RLS 도 안 보인다. 그래서 매니지드와 같은
//  role 구조(런타임 role 은 DDL 불가 · 앱 DDL 전용 role 만 스키마 생성)를 **진짜로** 만들고, 부작용을 되읽어 판정한다.
//
//  S1 DDL 전용 자격이면 워크스페이스별 스키마에 테이블이 생기고 주인은 DDL role 이다
//  S2 런타임 role 은 자기 테넌트 행만 본다(RLS) — 다른 테넌트로는 0행
//  S3 같은 앱 id 를 다른 워크스페이스가 다른 컬럼으로 설치해도 물리 테이블이 섞이지 않는다
//  S4 한 워크스페이스의 제거가 다른 워크스페이스 테이블·행을 안 지운다
//  S5 DDL 자격이 없으면(종전 매니지드) strict 는 원인을 담아 던지고, 비-strict 는 종전처럼 조용하다(fail-first 근거)
//  S6 기본 앱은 공유 app 스키마 + 행 격리
//  S7 전제 확인 — 런타임 role 은 스키마를 못 만든다(이 시험이 매니지드를 흉내 내고 있다는 증거)
import pg from "pg";

const SUPER = process.env.ITEMS_DATABASE_URL;
if (!SUPER) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }

const RT = "pgt4223_app", DDL = "pgt4223_appddl";
const PW_RT = "rt_pw_4223", PW_DDL = "ddl_pw_4223";
const TA = "4d255364-7dbb-4c53-b210-1588ebde1820";
const TB = "5e366475-8ecc-4d64-c321-2699fcef2931";
const dsnAs = (user, pw) => { const u = new URL(SUPER); u.username = user; u.password = pw; return u.toString(); };

let APP_PREEXISTED = null; // 아래에서 잰다 — dropAll 이 먼저 불려도(TDZ 없이) «모름» 이면 app 스키마를 건드리지 않는다
const su = new pg.Client({ connectionString: SUPER });
await su.connect();
const dbName = (await su.query("SELECT current_database() AS d")).rows[0].d;

async function dropAll() {
  for (const s of [`app_${TA.replace(/-/g, "")}`, `app_${TB.replace(/-/g, "")}`]) await su.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await su.query(`DROP TABLE IF EXISTS app."pgtbuiltin__marks" CASCADE`);
  // 이 시험이 만든 app 스키마면(매니지드 경로) 걷는다 — 먼저 있던 것은 건드리지 않는다.
  if (APP_PREEXISTED === false) await su.query(`DROP SCHEMA IF EXISTS app CASCADE`);
  for (const r of [RT, DDL]) {
    const ex = (await su.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [r])).rowCount;
    if (ex) { await su.query(`DROP OWNED BY "${r}" CASCADE`); await su.query(`DROP ROLE "${r}"`); }
  }
}
await dropAll();
// 매니지드와 같은 모양: 런타임 role = 로그인·DDL 불가 / 앱 DDL role = 로그인 + DB 에 CREATE(스키마 생성)만.
await su.query(`CREATE ROLE "${RT}" LOGIN PASSWORD '${PW_RT}'`);
await su.query(`CREATE ROLE "${DDL}" LOGIN PASSWORD '${PW_DDL}'`);
await su.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${RT}", "${DDL}"`);
await su.query(`GRANT CREATE ON DATABASE "${dbName}" TO "${DDL}"`);
// 기본 앱 공유 스키마(app): 매니지드엔 **없다**(실측) → 없으면 그대로 두어 DDL role 이 만들게 한다(매니지드 경로).
//  이미 있으면(다른 테스트·자가호스팅처럼 다른 role 소유) 그 모양 그대로 — 런타임 USAGE 는 있고 DDL role 은 CREATE 만 받는다.
//  두 경우 모두 ensureAppSchema 가 GRANT 를 못 하는 자리(주인 아님)를 넘어가야 한다.
APP_PREEXISTED = (await su.query("SELECT to_regnamespace('app') AS n")).rows[0].n !== null;
if (APP_PREEXISTED) {
  await su.query(`GRANT CREATE, USAGE ON SCHEMA app TO "${DDL}"`);
  await su.query(`GRANT USAGE ON SCHEMA app TO "${RT}"`);
}

// 모듈이 읽는 env — import 전에 고정한다(client.js 가 import 때 풀을 만든다).
process.env.ITEMS_DATABASE_URL = dsnAs(RT, PW_RT);
process.env.LIVELY_APP_DB_ROLE = RT;
delete process.env.LIVELY_OWNER_DATABASE_URL;
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { ensureAppTables, dropAppTables } = await import(`${DIST}/apps/store-schema.js`);
const { appSchemaName } = await import(`${DIST}/apps/store-ddl.js`);
const { itemsPool } = await import(`${DIST}/db/client.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };

// 런타임 role 로 한 테넌트 트랜잭션 — 게이트웨이의 itemsPool 바인딩과 같은 문장(set_config 로컬).
async function asTenant(tenant, sql, params = []) {
  const c = new pg.Client({ connectionString: dsnAs(RT, PW_RT) });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { await c.end(); }
}

const SA = appSchemaName({ builtin: false, tenantId: TA });
const SB = appSchemaName({ builtin: false, tenantId: TB });
const CONTACTS_A = [{ table: "contacts", columns: [{ name: "name", type: "text" }, { name: "segment", type: "text" }] }];
const CONTACTS_B = [{ table: "contacts", columns: [{ name: "full_name", type: "text" }, { name: "stage", type: "int" }] }];

try {
  // ── S7 전제: 런타임 role 은 DDL 을 못 한다 ──
  {
    let denied = false;
    try { await asTenant(TA, `CREATE SCHEMA pgt4223_should_fail`); } catch (e) { denied = e.code === "42501"; }
    chk("S7 런타임 role 은 스키마를 못 만든다(매니지드와 같은 전제)", denied);
  }

  // ── S5 DDL 자격이 없으면: 비-strict 는 조용히 [] (종전 동작), strict 는 원인을 담아 던진다 ──
  {
    delete process.env.LIVELY_APP_DDL_DATABASE_URL;           // withOwnerConn → itemsPool(런타임 role) — 종전 매니지드
    const quiet = await ensureAppTables("crm", CONTACTS_A, { schema: SA });
    chk("S5a DDL 자격이 없으면 비-strict 는 던지지 않고 빈 결과(종전의 «조용한 성공»)", Array.isArray(quiet) && quiet.length === 0, JSON.stringify(quiet));
    let thrown = null;
    try { await ensureAppTables("crm", CONTACTS_A, { schema: SA, strict: true }); } catch (e) { thrown = e; }
    chk("S5b strict 는 503 으로 던지고 원인(권한)을 담는다", thrown && thrown.status === 503 && /permission denied/i.test(String(thrown.message)), String(thrown && thrown.message));
    const exists = (await su.query("SELECT to_regnamespace($1) AS n", [SA])).rows[0].n;
    chk("S5c 그때 스키마는 생기지 않았다", exists === null, String(exists));
  }

  process.env.LIVELY_APP_DDL_DATABASE_URL = dsnAs(DDL, PW_DDL);

  // ── S1 DDL 전용 자격 → 워크스페이스별 스키마에 생성, 주인은 DDL role ──
  {
    const made = await ensureAppTables("crm", CONTACTS_A, { schema: SA, strict: true });
    const owner = (await su.query(`SELECT tableowner FROM pg_tables WHERE schemaname=$1 AND tablename='crm__contacts'`, [SA])).rows[0]?.tableowner;
    chk("S1 워크스페이스 A 스키마에 crm__contacts 생성, 주인은 DDL role", made.includes("crm__contacts") && owner === DDL, JSON.stringify({ made, owner }));
    const again = await ensureAppTables("crm", CONTACTS_A, { schema: SA, strict: true });
    chk("S1b 다시 불러도 멱등(같은 결과, 오류 없음)", again.includes("crm__contacts"));
  }

  // ── S2 런타임 role: 자기 테넌트 행만 ──
  {
    await asTenant(TA, `INSERT INTO "${SA}"."crm__contacts"(name, segment) VALUES ($1, $2)`, ["알파컷", "가"]);
    const mine = (await asTenant(TA, `SELECT name FROM "${SA}"."crm__contacts"`)).rows;
    const other = (await asTenant(TB, `SELECT name FROM "${SA}"."crm__contacts"`)).rows;
    chk("S2 런타임 role 이 자기 테넌트로 쓰고 읽는다", mine.length === 1 && mine[0].name === "알파컷", JSON.stringify(mine));
    chk("S2b 다른 테넌트 컨텍스트로는 0행(행 격리 한 겹 더)", other.length === 0, JSON.stringify(other));
  }

  // ── S3 같은 앱 id, 다른 워크스페이스, 다른 컬럼 ──
  {
    await ensureAppTables("crm", CONTACTS_B, { schema: SB, strict: true });
    const colsA = (await su.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='crm__contacts'`, [SA])).rows.map((r) => r.column_name);
    const colsB = (await su.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='crm__contacts'`, [SB])).rows.map((r) => r.column_name);
    chk("S3 같은 앱 id 라도 워크스페이스마다 자기 컬럼(섞이지 않는다)",
      colsA.includes("segment") && !colsA.includes("stage") && colsB.includes("stage") && !colsB.includes("segment"), JSON.stringify({ colsA, colsB }));
    await asTenant(TB, `INSERT INTO "${SB}"."crm__contacts"(full_name, stage) VALUES ($1, $2)`, ["매장", 1]);
    chk("S3b 워크스페이스 B 도 자기 테이블에 쓴다", (await asTenant(TB, `SELECT 1 FROM "${SB}"."crm__contacts"`)).rowCount === 1);
  }

  // ── S4 B 의 제거가 A 를 안 건드린다 ──
  {
    await dropAppTables("crm", ["contacts"], SB);
    const bGone = (await su.query("SELECT to_regclass($1) AS r", [`"${SB}"."crm__contacts"`])).rows[0].r === null;
    const aRows = (await asTenant(TA, `SELECT name FROM "${SA}"."crm__contacts"`)).rows;
    chk("S4 B 제거 → B 테이블만 사라지고 A 의 행은 그대로", bGone && aRows.length === 1, JSON.stringify({ bGone, aRows }));
  }

  // ── S6 기본 앱: 공유 app 스키마 + 행 격리 ──
  {
    const shared = appSchemaName({ builtin: true, tenantId: TA });
    await ensureAppTables("pgtbuiltin", [{ table: "marks", columns: [{ name: "url", type: "text" }] }], { schema: shared, strict: true });
    await asTenant(TA, `INSERT INTO app."pgtbuiltin__marks"(url) VALUES ('https://a')`);
    await asTenant(TB, `INSERT INTO app."pgtbuiltin__marks"(url) VALUES ('https://b')`);
    const a = (await asTenant(TA, `SELECT url FROM app."pgtbuiltin__marks"`)).rows.map((r) => r.url);
    const b = (await asTenant(TB, `SELECT url FROM app."pgtbuiltin__marks"`)).rows.map((r) => r.url);
    chk("S6 기본 앱은 공유 app 스키마 한 테이블, 테넌트마다 자기 행만", shared === "app" && a.join() === "https://a" && b.join() === "https://b", JSON.stringify({ shared, a, b }));
  }
} catch (e) {
  fail++; console.error("FAIL 예외 —", e);
} finally {
  await itemsPool.end().catch(() => {});
  await dropAll().catch((e) => console.error("정리 실패", e));
  await su.end();
}

console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
