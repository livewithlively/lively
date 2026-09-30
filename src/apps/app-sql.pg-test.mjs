// 앱 자유 SQL(#4226) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖, CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-sql.pg-test.mjs
//
// 경계는 파서가 아니라 **DB 역할**이다 — 그래서 매니지드와 같은 역할 구조를 진짜로 세운다:
//  런타임 역할(로그인 · DDL 불가 · 본체 테이블 하나 읽기 가능) · 앱 DDL 역할(스키마 생성 + CREATEROLE) ·
//  CREATEROLE 없는 앱 DDL 역할(종전 매니지드 — D10). 목 풀로는 권한도 RLS 도 SET ROLE 도 안 보인다.
//
//  D1 CREATEROLE 만 가진 DDL 역할이 앱 역할을 만들고, 런타임은 SET 만 된다(권한을 물려받지 않는다)
//  D2 앱 역할로 이 앱 테이블 읽기·쓰기 — RETURNING · changed · 선언 이름 그대로
//  D3 검사기를 건너뛴 SQL 로 같은 워크스페이스 **다른 앱** 테이블 · **본체** 테이블 → DB 가 거부(403)
//  D3b 전제 — 검사기 없이는 set_config('role') 한 줄로 역할이 풀린다(그래서 P5 가 필요하다)
//  D4 다른 워크스페이스 행 설정값이면 0행(정책 — 세 번째 겹)
//  D5 행 상한 · 바이트 상한(큰 값 하나 — 0행이어도 truncated) · 쓰기 RETURNING 의 changed 는 전체
//  D6 문장 시간 초과 408 · 잠금 대기 409
//  D7 실행 뒤 풀 연결은 런타임 역할·원래 search_path 로 돌아와 있다(SET LOCAL)
//  D8 선언 인덱스 생성 · unique 로 ON CONFLICT · 선언에서 빠지면 라이블리 것만 지운다(사람이 만든 인덱스는 남는다)
//  D9 보관된 테이블은 앱 역할 권한이 없다 · 앱 제거 때 역할도 지운다
//  D10 CREATEROLE 없는 DDL → 테이블 설치는 되고 sql_role.ok=false · ensureAppSqlRole 은 503
import pg from "pg";

const SUPER = process.env.ITEMS_DATABASE_URL;
if (!SUPER) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }

const RT = "pgt4226_app", DDL = "pgt4226_appddl", DDL0 = "pgt4226_ddl_norole";
const PW = { [RT]: "rt_pw_4226", [DDL]: "ddl_pw_4226", [DDL0]: "ddl0_pw_4226" };
const TA = "6f477586-8eed-4e75-a321-3a1f0c9d2e41";
const TB = "7a588697-9ffe-4f86-b432-4b2a1dae3f52";
const TC = "8b6997a8-a00f-4097-8543-5c3b2ebf4063";
const dsnAs = (user) => { const u = new URL(SUPER); u.username = user; u.password = PW[user]; return u.toString(); };

const su = new pg.Client({ connectionString: SUPER });
await su.connect();
const dbName = (await su.query("SELECT current_database() AS d")).rows[0].d;
const hexOf = (t) => `app_${t.replace(/-/g, "")}`;

async function dropAll() {
  for (const t of [TA, TB, TC]) for (const suf of ["", "_archive"]) await su.query(`DROP SCHEMA IF EXISTS "${hexOf(t)}${suf}" CASCADE`);
  await su.query(`DROP TABLE IF EXISTS public.pgt4226_secret`);
  const appRoles = (await su.query(
    `SELECT r.rolname FROM pg_roles r JOIN pg_auth_members am ON am.roleid = r.oid JOIN pg_roles m ON m.oid = am.member
      WHERE m.rolname = ANY($1) AND r.rolname LIKE 'lvly\\_appsql\\_%'`, [[RT, DDL, DDL0]])).rows.map((r) => r.rolname);
  for (const r of [...new Set(appRoles)]) { await su.query(`DROP OWNED BY "${r}" CASCADE`).catch(() => {}); await su.query(`DROP ROLE IF EXISTS "${r}"`); }
  for (const r of [RT, DDL, DDL0]) {
    if ((await su.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [r])).rowCount) { await su.query(`DROP OWNED BY "${r}" CASCADE`); await su.query(`DROP ROLE "${r}"`); }
  }
}
await dropAll();
await su.query(`CREATE ROLE "${RT}" LOGIN PASSWORD '${PW[RT]}'`);
await su.query(`CREATE ROLE "${DDL}" LOGIN CREATEROLE PASSWORD '${PW[DDL]}'`);
await su.query(`CREATE ROLE "${DDL0}" LOGIN PASSWORD '${PW[DDL0]}'`);
await su.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${RT}", "${DDL}", "${DDL0}"`);
await su.query(`GRANT CREATE ON DATABASE "${dbName}" TO "${DDL}", "${DDL0}"`);
// 라이블리 본체 테이블 흉내 — 런타임 역할은 읽을 수 있다(앱 역할로 내려가면 못 읽어야 한다).
await su.query(`CREATE TABLE public.pgt4226_secret(token text)`);
await su.query(`INSERT INTO public.pgt4226_secret VALUES ('비밀')`);
await su.query(`GRANT SELECT ON public.pgt4226_secret TO "${RT}"`);

process.env.ITEMS_DATABASE_URL = dsnAs(RT);
process.env.LIVELY_APP_DB_ROLE = RT;
process.env.LIVELY_APP_DDL_DATABASE_URL = dsnAs(DDL);
delete process.env.LIVELY_OWNER_DATABASE_URL;
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { ensureAppTables, dropAppTables, cleanupDroppedTables, emptyTableReport, ensureAppSqlRole } = await import(`${DIST}/apps/store-schema.js`);
const { appSchemaName, appSqlRoleName } = await import(`${DIST}/apps/store-ddl.js`);
const { planAppSql } = await import(`${DIST}/apps/app-sql.js`);
const X = await import(`${DIST}/apps/app-sql-exec.js`);
const { itemsPool } = await import(`${DIST}/db/client.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const status = async (p) => { try { await p; return "ok"; } catch (e) { return e?.status ?? e?.code ?? String(e); } };

const SA = appSchemaName({ builtin: false, tenantId: TA });
const SC = appSchemaName({ builtin: false, tenantId: TC });
const CRM = [
  { table: "contacts", columns: [{ name: "name", type: "text" }, { name: "email", type: "text" }, { name: "stage", type: "text" }, { name: "big", type: "text" }],
    indexes: [{ columns: ["email"], unique: true }, { columns: ["stage", "created_at"] }] },
  { table: "conversations", columns: [{ name: "contact_id", type: "int" }, { name: "note", type: "text" }] },
];
const MEMO = [{ table: "notes", columns: [{ name: "body", type: "text" }] }];
const roleOf = (schema, app) => appSqlRoleName(dbName, schema, app);
const env0 = { ...process.env };
const limits = (over = {}) => X.resetAppSqlLimits({ ...env0, ...over });

/** 검사기 → 실행기(가게 핸들러와 같은 순서, 빈도·용량 게이트 없이). */
const run = (sql, params = [], o = {}) => {
  const app = o.app ?? "crm", tables = o.tables ?? CRM.map((t) => t.table);
  const plan = o.plan ?? planAppSql(sql, { appId: app, schema: SA, tables });
  return X.runAppSql({ plan, params, role: roleOf(SA, app), appId: app, schema: SA, physicalPrefix: `${app}__`, tenantId: o.tenant ?? TA });
};
/** 검사기를 건너뛴 계획 — DB 경계만 남았을 때를 잰다. */
const raw = (sql, writes = false) => ({ kind: writes ? "insert" : "select", writes, returning: !writes, tables: [], targets: [], sql, paramCount: 0 });

try {
  limits();
  // ── D1 ──
  {
    const rep = emptyTableReport();
    await ensureAppTables("crm", CRM, { schema: SA, strict: true, sqlRole: true, report: rep });
    const rep2 = emptyTableReport();
    await ensureAppTables("memo", MEMO, { schema: SA, strict: true, sqlRole: true, report: rep2 });
    const role = roleOf(SA, "crm");
    const m = (await su.query(
      `SELECT m.rolname AS member, am.set_option, am.inherit_option, am.admin_option FROM pg_auth_members am
         JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member WHERE r.rolname = $1 ORDER BY 1`, [role])).rows;
    const rt = m.find((x) => x.member === RT), ddl = m.find((x) => x.member === DDL);
    const login = (await su.query("SELECT rolcanlogin FROM pg_roles WHERE rolname=$1", [role])).rows[0]?.rolcanlogin;
    chk("D1 앱 역할 생성(로그인 불가) · 런타임은 SET 만(INHERIT 없음) · 만든 DDL 역할이 ADMIN",
      rep.sql_role?.ok === true && rep2.sql_role?.ok === true && login === false && rt?.set_option === true && rt?.inherit_option === false && ddl?.admin_option === true,
      JSON.stringify({ rep: rep.sql_role, m, login }));
  }

  // ── D2 ──
  {
    const ins = await run("INSERT INTO contacts(name, email, stage) VALUES ($1, $2, 'a'), ('나', 'b@x', 'a'), ('다', 'c@x', 'b') RETURNING id, name", ["가", "a@x"]);
    const sel = await run("SELECT stage, count(*)::int AS n FROM contacts GROUP BY stage ORDER BY stage");
    const upd = await run("UPDATE contacts SET stage = 'c' WHERE stage = $1", ["b"]);
    const join = await run("INSERT INTO conversations(contact_id, note) SELECT id, 'first' FROM contacts WHERE email = 'a@x'");
    const j2 = await run("SELECT c.name, v.note FROM contacts c JOIN conversations v ON v.contact_id = c.id");
    chk("D2 앱 역할로 읽기·쓰기 — RETURNING 행 · 집계 · changed · 조인",
      ins.changed === 3 && ins.rows.length === 3 && ins.rows[0].name === "가"
      && JSON.stringify(sel.rows) === JSON.stringify([{ stage: "a", n: 2 }, { stage: "b", n: 1 }])
      && upd.changed === 1 && join.changed === 1 && j2.rows[0]?.note === "first",
      JSON.stringify({ ins, sel: sel.rows, upd, join, j2: j2.rows }));
    const who = await run("", [], { plan: raw("SELECT current_user AS u") });
    chk("D2b 문장은 앱 역할로 돈다(current_user)", who.rows[0]?.u === roleOf(SA, "crm"), JSON.stringify(who.rows));
  }

  // ── D3 ──
  {
    await run("INSERT INTO notes(body) VALUES ('메모')", [], { app: "memo", tables: ["notes"] });
    const otherApp = await status(run("", [], { plan: raw(`SELECT * FROM "${SA}"."memo__notes"`) }));
    const otherAppW = await status(run("", [], { plan: raw(`INSERT INTO "${SA}"."memo__notes"(body) VALUES ('x')`, true) }));
    const body = await status(run("", [], { plan: raw("SELECT * FROM public.pgt4226_secret") }));
    const snap = await status(run("", [], { plan: raw("SELECT * FROM public.org_app") }));
    chk("D3 검사기를 건너뛰어도 같은 워크스페이스 다른 앱(읽기·쓰기)·본체 테이블은 DB 가 거부(403)",
      otherApp === 403 && otherAppW === 403 && body === 403 && (snap === 403 || snap === 400), JSON.stringify({ otherApp, otherAppW, body, snap }));
    const rtCan = (await itemsPool.query("SELECT token FROM public.pgt4226_secret")).rows[0]?.token;
    chk("D3 전제 — 런타임 역할 자신은 그 본체 테이블을 읽는다(앱 역할로 내려가서 막힌 것이다)", rtCan === "비밀", String(rtCan));
  }

  // ── D3b ──
  {
    const r = await run("", [], { plan: raw("SELECT set_config('role', 'none', true) AS s, current_user AS u") });
    chk("D3b 전제 — 검사기 없이는 set_config('role') 한 줄로 런타임 역할로 돌아간다(그래서 검사기가 그 길을 막는다)", r.rows[0]?.u === RT, JSON.stringify(r.rows));
    let refused = null;
    try { planAppSql("SELECT set_config('role', 'none', true)", { appId: "crm", schema: SA, tables: ["contacts"] }); } catch (e) { refused = e.status; }
    chk("D3b 같은 문장을 검사기는 거부한다", refused === 400, String(refused));
    //  격리 리뷰 실측: 괄호로 묶은 조인은 파서가 테이블을 못 본다 — 앱 역할로도 카탈로그(다른 워크스페이스 스키마 이름)가 읽힌다.
    const cat = await run("", [], { plan: raw("SELECT nspname FROM (pg_namespace n JOIN pg_roles r ON true) WHERE nspname LIKE 'app\\_%' LIMIT 1") });
    let refused2 = null;
    try { planAppSql("SELECT nspname FROM (pg_namespace n JOIN pg_roles r ON true)", { appId: "crm", schema: SA, tables: ["contacts"] }); } catch (e) { refused2 = e.status; }
    chk("D3c 전제 — 앱 역할로도 카탈로그는 읽힌다(데이터 아닌 이름) · 괄호 조인 우회를 검사기가 거부한다", cat.row_count === 1 && refused2 === 400, JSON.stringify({ cat: cat.rows, refused2 }));
  }

  // ── D4 ──
  {
    const other = await run("SELECT count(*)::int AS n FROM contacts", [], { tenant: TB });
    chk("D4 다른 워크스페이스 설정값이면 0행(행 격리)", other.rows[0]?.n === 0, JSON.stringify(other.rows));
  }

  // ── D5 ──
  {
    limits({ LIVELY_APP_SQL_MAX_ROWS: "2", LIVELY_APP_SQL_MAX_BYTES: "4000" });
    const rows = await run("SELECT id, name FROM contacts ORDER BY id");
    await run("UPDATE contacts SET big = $1 WHERE email = 'a@x'", ["x".repeat(10_000)]);
    const big = await run("SELECT big FROM contacts WHERE email = 'a@x'");
    const upd = await run("UPDATE contacts SET stage = 'z' WHERE id > 0 RETURNING id");
    chk("D5 행 상한(2) — 2행 · truncated", rows.row_count === 2 && rows.truncated === true && rows.rows[0].name === "가", JSON.stringify(rows));
    chk("D5 바이트 상한 — 큰 값 하나면 0행이어도 truncated", big.row_count === 0 && big.truncated === true, JSON.stringify({ ...big, rows: big.rows.length }));
    chk("D5 쓰기 RETURNING — 돌려주는 건 2행, changed 는 바뀐 3행 전부", upd.row_count === 2 && upd.changed === 3 && upd.truncated === true, JSON.stringify(upd));
    limits();
  }

  // ── D6 ──
  {
    limits({ LIVELY_APP_SQL_STATEMENT_MS: "300", LIVELY_APP_SQL_LOCK_MS: "200" });
    const t0 = Date.now();
    const slow = await status(run("SELECT count(*) FROM generate_series(1, 500000000) g"));
    const tookSlow = Date.now() - t0;
    const holder = new pg.Client({ connectionString: SUPER }); await holder.connect();
    await holder.query("BEGIN");
    await holder.query(`SELECT * FROM "${SA}"."crm__contacts" WHERE email = 'b@x' FOR UPDATE`);
    const t1 = Date.now();
    const locked = await status(run("UPDATE contacts SET stage = 'q' WHERE email = 'b@x'"));
    const tookLock = Date.now() - t1;
    await holder.query("ROLLBACK"); await holder.end();
    chk("D6 문장 시간 초과 → 408(상한 근처에서 끊김)", slow === 408 && tookSlow < 3000, JSON.stringify({ slow, tookSlow }));
    chk("D6 잠금 대기 → 409(상한 근처에서 끊김)", locked === 409 && tookLock < 3000, JSON.stringify({ locked, tookLock }));
    limits();
  }

  // ── D7 ──
  {
    limits({ LIVELY_APP_SQL_POOL: "1" });
    await run("SELECT count(*) FROM contacts");
    const c = await X._appSqlPoolForTest().connect();
    try {
      const s = (await c.query("SELECT current_user AS u, current_setting('search_path') AS p, current_setting('statement_timeout') AS t, current_setting('app.tenant_id', true) AS g")).rows[0];
      chk("D7 풀로 돌아간 연결은 런타임 역할·원래 search_path·시간 상한 없음·행 격리 값 없음", s.u === RT && !/pg_catalog, pg_temp/.test(s.p) && s.t === "0" && !s.g, JSON.stringify(s));
    } finally { c.release(); }
    limits();
  }

  // ── D8 ──
  {
    const ix = async () => (await su.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename='crm__contacts' ORDER BY 1`, [SA])).rows;
    const before = await ix();
    const uniq = before.find((r) => /^lvix_/.test(r.indexname) && /UNIQUE/.test(r.indexdef) && /\(email\)/.test(r.indexdef));
    const multi = before.find((r) => /^lvix_/.test(r.indexname) && /\(stage, created_at\)/.test(r.indexdef));
    const up = await run("INSERT INTO contacts(name, email) VALUES ('가2', 'a@x') ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id, name");
    const dup = await status(run("INSERT INTO contacts(name, email) VALUES ('또', 'c@x')"));
    chk("D8 선언 인덱스 생성(unique email · stage+created_at) · ON CONFLICT (email) 이 맞는다 · 중복은 409",
      !!uniq && !!multi && up.rows[0]?.name === "가2" && dup === 409, JSON.stringify({ before, up: up.rows, dup }));
    await su.query(`CREATE INDEX pgt_manual_ix ON "${SA}"."crm__contacts"(name)`);
    const rep = emptyTableReport();
    await ensureAppTables("crm", [{ ...CRM[0], indexes: [{ columns: ["email"], unique: true }] }, CRM[1]], { schema: SA, strict: true, sqlRole: true, report: rep });
    const after = (await ix()).map((r) => r.indexname);
    chk("D8 선언에서 빠진 인덱스만 지운다(사람이 만든 인덱스·PK 는 남는다)",
      !after.includes(multi?.indexname) && after.includes(uniq?.indexname) && after.includes("pgt_manual_ix") && rep.dropped_indexes.length === 1 && rep.added_indexes.length === 0,
      JSON.stringify({ after, rep }));
  }

  // ── D9 ──
  {
    const role = roleOf(SA, "crm");
    const cleaned = await cleanupDroppedTables("crm", ["conversations"], SA);
    const archivedAs = cleaned.archived[0]?.archived_as ?? "";
    const can = archivedAs ? (await su.query("SELECT has_table_privilege($1, $2, 'SELECT') AS ok", [role, archivedAs.split(".").map((x) => `"${x}"`).join(".")])).rows[0].ok : null;
    chk("D9 보관된 테이블은 앱 역할이 못 읽는다", !!archivedAs && can === false, JSON.stringify({ cleaned, can }));
    await dropAppTables("crm", ["contacts"], SA);
    const gone = (await su.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount === 0;
    const memoRole = (await su.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [roleOf(SA, "memo")])).rowCount === 1;
    chk("D9 앱 제거(테이블 DROP) 때 그 앱 역할만 지운다", gone && memoRole, JSON.stringify({ gone, memoRole }));
  }

  // ── D10 ──
  {
    process.env.LIVELY_APP_DDL_DATABASE_URL = dsnAs(DDL0);
    const rep = emptyTableReport();
    await ensureAppTables("memo", MEMO, { schema: SC, strict: true, sqlRole: true, report: rep });
    const table = (await su.query("SELECT to_regclass($1) AS r", [`"${SC}"."memo__notes"`])).rows[0].r;
    let st = null;
    try { await ensureAppSqlRole("memo", ["notes"], SC); } catch (e) { st = e.status; }
    chk("D10 CREATEROLE 없는 DDL — 테이블은 생기고 sql_role.ok=false, 역할 보장은 503",
      table !== null && rep.sql_role?.ok === false && /permission denied/i.test(rep.sql_role?.error ?? "") && st === 503, JSON.stringify({ table, rep: rep.sql_role, st }));
    process.env.LIVELY_APP_DDL_DATABASE_URL = dsnAs(DDL);
  }
} catch (e) {
  fail++; console.error("FAIL (예외)", e);
} finally {
  await X.resetAppSqlLimits(env0);
  await itemsPool.end().catch(() => {});
  await dropAll().catch((e) => console.error("정리 실패", e));
  await su.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
