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
//  ── #4483 ──
//  D11 실행 한 번 = DB 왕복 3번(준비 한 덩이 · 문장 · 끝) · 묶음 n 문장 = n+2
//  D12 문장 안에서 standard_conforming_strings=on · search_path=pg_catalog(검사기 렉서와 DB 렉서가 같다)
//  D13 묶음 — 전부 되거나 전부 취소(실패 문장 번호 body.index, 앞 문장 쓰기도 사라진다)
//  D14 묶음 전체 시간 상한 → 408 · 전부 취소
//  D15 묶음 결과 바이트는 문장 전체가 나눠 쓴다 — 뒤 문장이 잘린다 · strict 면 413
//  D16 wire — 값은 DB 글자 그대로(numeric·int8·timestamptz·date·jsonb·bool·배열·interval) + 형 OID
//  D17 strict — 쓰기 RETURNING 이 잘리면 413 이고 쓰기도 취소된다
//  D18 행 잠금(FOR UPDATE SKIP LOCKED)은 읽기·쓰기 트랜잭션으로 돈다 — 작업 꺼내 가기 한 문장
//  D19 공평 분배 — 자리가 비면 지금 가장 적게 쓰는 고객부터(먼저 줄 선 다른 고객의 두 번째 문장보다 먼저)
//  D20 카탈로그 전수 — OID 계열 형(oid · reg* · aclitem · oidvector)을 받거나 내는 pg_catalog 함수(pg_ 아님 · internal 인자 없음)는
//      검사기가 거부하거나 «검토한 무해 목록» 에 있다 · reg*·aclitem 계열 형은 전부 거부. PG 판이 올라 새 것이 생기면 실패한다.
//      (격리 리뷰: _regclass 배열형 · format_type · acldefault 로 다른 워크스페이스의 스키마·표·역할 이름이 읽혔다)
//  ── #5172 ── (E 번호 = 그 태스크의 엣지 표 행)
//  D21 원래 id 로 넣기(INSERT … OVERRIDING SYSTEM VALUE) — 뒤의 평범한 INSERT 가 부딪치지 않게 id 시퀀스를 앞으로만 맞춘다:
//      처음 쓰는 시퀀스(RETURNING 포함) · 작은 id · 지운 맨 끝 id 다시 안 냄 · 다음 번호 경계 · 묶음 · 묶음 취소 · 0행 ·
//      다른 앱 시퀀스 403 · 권한 범위 · 이전 판 역할 재보장 · 같은 표 맞춤 줄 세우기(기다리다 409 / 기다려서 됨) · 시퀀스 없는 표
//  D9 덧붙임 — 보관된 표의 시퀀스 권한도 걷는다(E16) · 시퀀스 권한이 남아 있어도 앱 제거는 역할을 지운다(E17)
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
const { planAppSql, forbiddenFunction } = await import(`${DIST}/apps/app-sql.js`);
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
const run = async (sql, params = [], o = {}) => {
  const app = o.app ?? "crm", tables = o.tables ?? CRM.map((t) => t.table);
  const plan = o.plan ?? await planAppSql(sql, { appId: app, schema: SA, tables });
  return X.runAppSql({ plan, params, role: roleOf(SA, app), appId: app, schema: SA, physicalPrefix: `${app}__`, tenantId: o.tenant ?? TA, format: o.format, strict: o.strict });
};
/** 묶음 — 문장마다 검사기를 거친 계획(또는 raw). */
const batch = async (stmts, o = {}) => {
  const app = o.app ?? "crm", tables = o.tables ?? CRM.map((t) => t.table);
  const items = [];
  for (const st of stmts) items.push({ plan: st.plan ?? await planAppSql(st.sql, { appId: app, schema: SA, tables }), params: st.params ?? [] });
  return X.runAppSqlBatch({ items, role: roleOf(SA, app), appId: app, schema: SA, physicalPrefix: `${app}__`, tenantId: o.tenant ?? TA, format: o.format, strict: o.strict });
};
/** 검사기를 건너뛴 계획 — DB 경계만 남았을 때를 잰다. */
const raw = (sql, writes = false) => ({ kind: writes ? "insert" : "select", writes, locks: false, returning: !writes, tables: [], targets: [], sql, paramCount: 0 });
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

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
    try { await planAppSql("SELECT set_config('role', 'none', true)", { appId: "crm", schema: SA, tables: ["contacts"] }); } catch (e) { refused = e.status; }
    chk("D3b 같은 문장을 검사기는 거부한다", refused === 400, String(refused));
    //  격리 리뷰 실측: 앱 역할로도 카탈로그(다른 워크스페이스 스키마 이름)가 읽힌다 — 그래서 검사기가 카탈로그 표를 막아야 한다.
    //  종전 파서는 괄호 조인 안의 표를 못 봐 이 길이 뚫렸다. 실제 파서는 그 안의 pg_namespace 를 그대로 보고 403 이다.
    const cat = await run("", [], { plan: raw("SELECT nspname FROM (pg_namespace n JOIN pg_roles r ON true) WHERE nspname LIKE 'app\\_%' LIMIT 1") });
    let refused2 = null;
    try { await planAppSql("SELECT nspname FROM (pg_namespace n JOIN pg_roles r ON true)", { appId: "crm", schema: SA, tables: ["contacts"] }); } catch (e) { refused2 = e.status; }
    chk("D3c 전제 — 앱 역할로도 카탈로그는 읽힌다(데이터 아닌 이름) · 괄호 조인 안의 카탈로그를 검사기가 거부한다(403)", cat.row_count === 1 && refused2 === 403, JSON.stringify({ cat: cat.rows, refused2 }));
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
    let locked = null, tookLock = 0;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT * FROM "${SA}"."crm__contacts" WHERE email = 'b@x' FOR UPDATE`);
      const t1 = Date.now();
      locked = await status(run("UPDATE contacts SET stage = 'q' WHERE email = 'b@x'"));
      tookLock = Date.now() - t1;
    } finally { await holder.query("ROLLBACK").catch(() => {}); await holder.end().catch(() => {}); }
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

  // ── D11 · D12 (#4483) ──
  {
    limits();
    const orig = pg.Client.prototype.query;
    let count = 0;
    pg.Client.prototype.query = function (...a) { if (this.connectionParameters?.application_name === "lively-app-sql") count++; return orig.apply(this, a); };
    try {
      count = 0; await run("SELECT name FROM contacts WHERE email = $1", ["a@x"]); const one = count;
      count = 0; await batch([{ sql: "SELECT 1" }, { sql: "SELECT count(*) FROM contacts" }, { sql: "SELECT name FROM contacts LIMIT 1" }]); const three = count;
      chk("D11 실행 한 번 = DB 왕복 3번 · 묶음 3문장 = 5번(종전 9번)", one === 3 && three === 5, JSON.stringify({ one, three }));
    } finally { pg.Client.prototype.query = orig; }
    //  런타임 역할의 기본값을 off 로 바꿔 둔다 — 실행기가 문장마다 on 으로 고정하지 않으면 여기서 off 가 보인다(검사기의 렉서는 on 을 가정).
    await su.query(`ALTER ROLE "${RT}" SET standard_conforming_strings = off`);
    limits();                                                          // 새 연결이 바뀐 역할 기본값을 받게 풀을 새로 만든다
    let s;
    try { s = await run("", [], { plan: raw("SELECT current_setting('standard_conforming_strings') AS scs, current_setting('search_path') AS sp, current_setting('transaction_read_only') AS ro") }); }
    finally { await su.query(`ALTER ROLE "${RT}" RESET standard_conforming_strings`); limits(); }
    chk("D12 문장 안 — standard_conforming_strings=on(역할 기본값이 off 여도) · search_path=pg_catalog · 읽기 문장은 읽기 전용", s.rows[0]?.scs === "on" && /^pg_catalog, pg_temp$/.test(s.rows[0]?.sp) && s.rows[0]?.ro === "on", JSON.stringify(s.rows));
  }

  // ── D13 · D14 · D15 ──
  {
    limits();
    const n0 = (await run("SELECT count(*)::int AS n FROM contacts")).rows[0].n;
    const ok = await batch([
      { sql: "INSERT INTO contacts(name, email) VALUES ($1, $2) RETURNING id", params: ["묶1", "batch1@x"] },
      { sql: "INSERT INTO conversations(contact_id, note) SELECT id, '묶음' FROM contacts WHERE email = 'batch1@x'" },
      { sql: "SELECT count(*)::int AS n FROM contacts" },
    ]);
    chk("D13 묶음 — 세 문장 결과 · 앞 문장 쓰기를 뒤 문장이 본다(한 트랜잭션)",
      ok.results.length === 3 && Number(ok.results[0].rows[0]?.id) > 0 && ok.results[1].changed === 1 && ok.results[2].rows[0]?.n === n0 + 1, JSON.stringify(ok));
    const e = await errOf(batch([
      { sql: "INSERT INTO contacts(name, email) VALUES ('묶2', 'batch2@x')" },
      { sql: "INSERT INTO contacts(name, email) VALUES ('중복', 'batch1@x')" },
    ]));
    const left = (await run("SELECT count(*)::int AS n FROM contacts WHERE email = 'batch2@x'")).rows[0].n;
    chk("D13 묶음 실패 — 409 · body.index=1 · «2번째» · 앞 문장 쓰기도 취소", e?.status === 409 && e?.body?.index === 1 && /2번째/.test(e?.message) && left === 0, JSON.stringify({ st: e?.status, body: e?.body, msg: e?.message, left }));

    limits({ LIVELY_APP_SQL_BATCH_MS: "300" });
    const t0 = Date.now();
    const slow = await errOf(batch([
      { plan: raw("SELECT pg_sleep(0.2)") },
      { sql: "INSERT INTO contacts(name, email) VALUES ('시간', 'batch-time@x')" },
      { plan: raw("SELECT pg_sleep(0.2)") },
    ]));
    const took = Date.now() - t0;
    const kept = (await run("SELECT count(*)::int AS n FROM contacts WHERE email = 'batch-time@x'")).rows[0].n;
    chk("D14 묶음 전체 시간 상한 — 408 · 3번째에서 멈춤 · 앞 쓰기 취소 · 상한 근처에서 끊김", slow?.status === 408 && slow?.body?.index === 2 && kept === 0 && took < 1500, JSON.stringify({ st: slow?.status, body: slow?.body, kept, took }));

    limits({ LIVELY_APP_SQL_MAX_BYTES: "3000" });
    const two = await batch([{ plan: raw("SELECT lpad('', 2000, 'x') AS s") }, { plan: raw("SELECT lpad('', 2000, 'y') AS s") }]);
    const strictE = await errOf(batch([{ plan: raw("SELECT lpad('', 2000, 'x') AS s") }, { plan: raw("SELECT lpad('', 2000, 'y') AS s") }], { strict: true }));
    chk("D15 묶음 결과 바이트는 나눠 쓴다 — 첫 문장 2,000자는 오고 둘째는 잘린다 · strict 면 413(index 1)",
      two.results[0].row_count === 1 && two.results[0].truncated === false && two.results[1].row_count === 0 && two.results[1].truncated === true
      && strictE?.status === 413 && strictE?.body?.index === 1, JSON.stringify({ r: two.results.map((r) => [r.row_count, r.truncated]), st: strictE?.status, body: strictE?.body }));
    limits();
  }

  // ── D16 · D17 · D18 ──
  {
    limits();
    const w = await run("", [], { format: "wire", plan: raw(`SELECT 12.50::numeric(12,2) AS a, 9007199254740993::int8 AS b, '2026-10-14 09:00:00+09'::timestamptz AS c,
      '2026-10-14'::date AS d, '{"k": 1}'::jsonb AS e, true AS f, ARRAY['x','y'] AS g, '1 day 02:00:00'::interval AS h, 'NaN'::float8 AS i, NULL::text AS j, 7::int4 AS id, 8::int4 AS id`) });
    const types = w.fields.map((f) => f.type), row = w.rows[0] ?? [];
    chk("D16 wire — 형 OID(numeric·int8·timestamptz·date·jsonb·bool·text[]·interval·float8·text·int4·int4) · 겹친 이름 그대로",
      JSON.stringify(types) === JSON.stringify([1700, 20, 1184, 1082, 3802, 16, 1009, 1186, 701, 25, 23, 23]) && w.fields[10].name === "id" && w.fields[11].name === "id", JSON.stringify(w.fields));
    chk("D16 wire — 값은 DB 글자 그대로(12.50 · 2^53+1 · 같은 순간 · 날짜 · NaN · NULL · {x,y} · t)",
      row[0] === "12.50" && row[1] === "9007199254740993" && new Date(row[2]).toISOString() === "2026-10-14T00:00:00.000Z" && row[3] === "2026-10-14"
      && row[4] === '{"k": 1}' && row[5] === "t" && row[6] === "{x,y}" && row[7] === "1 day 02:00:00" && row[8] === "NaN" && row[9] === null && row[10] === "7",
      JSON.stringify(row));

    limits({ LIVELY_APP_SQL_MAX_ROWS: "1" });
    const e = await errOf(run("UPDATE contacts SET stage = 'strict' WHERE id > 0 RETURNING id", [], { strict: true }));
    limits();
    const n = (await run("SELECT count(*)::int AS n FROM contacts WHERE stage = 'strict'")).rows[0].n;
    chk("D17 strict — 쓰기 RETURNING 이 잘리면 413 이고 쓰기도 취소된다", e?.status === 413 && n === 0, JSON.stringify({ st: e?.status, n }));

    const ids = (await run("SELECT id FROM contacts ORDER BY id")).rows.map((r) => Number(r.id));
    //  잠금을 쥔 연결은 무슨 일이 있어도 풀고 닫는다 — 안 그러면 아래 정리(DROP SCHEMA)가 이 프로세스 자신의 잠금을 영원히 기다린다.
    const holder = new pg.Client({ connectionString: SUPER }); await holder.connect();
    let skip = null, claim = null, took = 0, err = null;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT * FROM "${SA}"."crm__contacts" WHERE id = $1 FOR UPDATE`, [ids[0]]);
      const t0 = Date.now();
      skip = await run("SELECT id FROM contacts ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED");
      claim = await run("UPDATE contacts SET stage = 'taken' WHERE id = (SELECT id FROM contacts WHERE stage IS DISTINCT FROM 'taken' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id");
      took = Date.now() - t0;
    } catch (e) { err = e; }
    finally { await holder.query("ROLLBACK").catch(() => {}); await holder.end().catch(() => {}); }
    if (err) chk("D18 FOR UPDATE SKIP LOCKED — 예외 없이", false, String(err?.status ?? "") + " " + String(err?.message ?? err));
    chk("D18 FOR UPDATE SKIP LOCKED — 잠긴 첫 행을 건너 다음 행 · 꺼내 가기 한 문장 · 기다리지 않는다",
      Number(skip?.rows[0]?.id) === ids[1] && claim?.changed === 1 && Number(claim?.rows[0]?.id) === ids[1] && took < 1000, JSON.stringify({ ids, skip: skip?.rows, claim: claim?.rows, took }));
  }

  // ── D19 공평 분배 ──
  {
    //  풀 2 · 고객당 2. A1(0.4초)·B1(0.2초)이 자리를 채우고, A2 가 먼저 줄 서고, C1 이 나중에 줄 선다.
    //  0.2초에 B1 이 끝나 자리가 나면 — 지금 0 자리인 C 가 1 자리 쓰는 A 보다 먼저 받는다(종전 FIFO 면 A2 → C1 은 0.4초 뒤).
    limits({ LIVELY_APP_SQL_POOL: "2", LIVELY_APP_SQL_PER_WORKSPACE: "2" });
    const t0 = Date.now();
    const done = {};
    const go = (name, tenant, sec) => run("", [], { tenant, plan: raw(`SELECT pg_sleep(${sec}) AS s`) }).then(() => { done[name] = Date.now() - t0; });
    const pA1 = go("A1", TA, 0.4), pB1 = go("B1", TB, 0.2);
    await new Promise((r) => setTimeout(r, 60));
    const pA2 = go("A2", TA, 0.05);
    await new Promise((r) => setTimeout(r, 30));
    const pC1 = go("C1", TC, 0);
    await Promise.all([pA1, pB1, pA2, pC1]);
    chk("D19 빈 자리는 가장 적게 쓰는 고객(C)에게 — C1 이 A2 보다 먼저 끝나고 0.4초 전에 끝난다",
      done.C1 < done.A2 && done.C1 < 380, JSON.stringify(done));
    const st = X.appSqlStats();
    chk("D19 지표 — 대기 표본·문장 표본·CPU 가 쌓인다", st.wait_ms.n > 0 && st.statement_ms.n > 0 && st.process.cpu_user_ms >= 0 && st.scheduler.used === 0, JSON.stringify(st));
    limits();
  }

  // ── D20 카탈로그 전수 ──
  {
    //  검토한 무해 목록 — 고르는 기준: 카탈로그를 이름으로 찾아 글자로 돌려주지 않는다(오류 문구에도 이름을 싣지 않는다).
    //   받아들인 잔여 위험(재검토): 전문 검색 8개는 regconfig 인자로 «스키마.이름» 글자를 받아, 그 스키마가 있는지를 오류 문구 차이
    //   («permission denied for schema …» ↔ «… does not exist»)로 가린다. 이름을 내주지는 않고, 테넌트 스키마는 UUID 라 알아야 확인만 된다.
    const REVIEWED = new Set([
      // OID 를 숫자로만 다룬다
      "btoidcmp", "btoidvectorcmp", "hashoid", "hashoidextended", "hashoidvector", "hashoidvectorextended", "int8", "oid",
      "oideq", "oidge", "oidgt", "oidin", "oidlarger", "oidle", "oidlt", "oidne", "oidout", "oidsend", "oidsmaller",
      "oidvectoreq", "oidvectorge", "oidvectorgt", "oidvectorin", "oidvectorle", "oidvectorlt", "oidvectorne", "oidvectorout", "oidvectorsend",
      "max", "min", "nameconcatoid",
      // 전문 검색 — regconfig 인자는 문자 검색 설정(전역 객체 · 워크스페이스가 만들 수 없다)을 찾는다
      "json_to_tsvector", "jsonb_to_tsvector", "phraseto_tsquery", "plainto_tsquery", "to_tsquery", "to_tsvector", "ts_headline", "websearch_to_tsquery",
    ]);
    const OIDISH = "'^_?(oid|reg[a-z]+|aclitem|oidvector)$'";
    const fns = (await su.query(`
      SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'pg_catalog' AND p.proname !~ '^pg_'
         AND NOT ('internal'::regtype::oid = ANY (p.proargtypes::oid[]))
         AND (p.prorettype IN (SELECT oid FROM pg_type WHERE typname ~ ${OIDISH})
              OR EXISTS (SELECT 1 FROM unnest(p.proargtypes::oid[]) a WHERE a IN (SELECT oid FROM pg_type WHERE typname ~ ${OIDISH})))
       ORDER BY 1`)).rows.map((r) => r.proname);
    const unreviewed = fns.filter((f) => !forbiddenFunction(f) && !REVIEWED.has(f));
    chk(`D20 OID 계열 함수 ${fns.length}개 — 전부 거부되거나 검토한 무해 목록에 있다`, fns.length > 100 && unreviewed.length === 0,
      `검토 안 된 함수: ${unreviewed.join(", ")} — 이름이 새는지 보고 app-sql.ts 거부 목록에 넣거나, 무해하면 이 시험의 REVIEWED 에 올린다`);
    const types = (await su.query(`SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'pg_catalog' AND t.typname ~ '^_?(reg[a-z]+|aclitem)$' ORDER BY 1`)).rows.map((r) => r.typname);
    const opened = [];
    for (const t of types) if ((await status(planAppSql(`SELECT NULL::${t}`, { appId: "crm", schema: SA, tables: ["contacts"] }))) !== 400) opened.push(t);
    chk(`D20 reg*·aclitem 계열 형 ${types.length}개 — 전부 거부`, types.length >= 24 && opened.length === 0, `거부되지 않은 형: ${opened.join(", ")}`);
  }

  // ── D21 원래 id 로 넣기 — INSERT … OVERRIDING SYSTEM VALUE 뒤 id 시퀀스 맞춤(#5172, 엣지 E4~E15) ──
  {
    limits();
    const SEQ = [{ table: "items", columns: [{ name: "v", type: "text" }] }, { table: "plain", columns: [{ name: "v", type: "text" }] }];
    await ensureAppTables("seq", SEQ, { schema: SA, strict: true, sqlRole: true, report: emptyTableReport() });
    const o = { app: "seq", tables: ["items", "plain"] };
    const runS = (sql, params = [], more = {}) => run(sql, params, { ...o, ...more });
    const put = (ids) => runS(`INSERT INTO items (id, v) OVERRIDING SYSTEM VALUE VALUES ${ids.map((id) => `(${id}, 'x')`).join(", ")}`);
    const nextId = async () => Number((await runS("INSERT INTO items (v) VALUES ('n') RETURNING id")).rows[0]?.id);
    const has = async (id) => (await su.query(`SELECT 1 FROM "${SA}"."seq__items" WHERE id = $1`, [id])).rowCount === 1;

    //  RETURNING 을 붙여 결과 상한 감싸기(WITH 로 감싼 문장) 뒤에서도 맞춰지는지 함께 본다.
    const first = await runS("INSERT INTO items (id, v) OVERRIDING SYSTEM VALUE VALUES (100, 'x'), (101, 'x') RETURNING id");
    const n1 = await nextId();
    chk("D21 E4 한 번도 안 쓴 시퀀스 — id 100·101 을 넣은 뒤(RETURNING) 평범한 INSERT 는 102(부딪치지 않는다)",
      first.changed === 2 && first.rows.map((r) => Number(r.id)).join() === "100,101" && n1 === 102, JSON.stringify({ first, n1 }));
    await put([5]);
    const n2 = await nextId();
    chk("D21 E5 더 작은 id(5)를 넣어도 시퀀스는 뒤로 가지 않는다 — 103", n2 === 103 && await has(5), JSON.stringify({ n2 }));
    await runS("DELETE FROM items WHERE id = $1", [103]);
    await put([6]);
    const n3 = await nextId();
    chk("D21 E6 맨 끝(103)을 지운 뒤 작은 id(6) — 지운 103 을 다시 내주지 않는다(104)", n3 === 104 && !(await has(103)), JSON.stringify({ n3 }));
    await put([105]);
    const n4 = await nextId();
    chk("D21 E7 경계 — 시퀀스가 다음에 낼 바로 그 번호(105)를 직접 넣으면 평범한 INSERT 는 106", n4 === 106, JSON.stringify({ n4 }));

    const b = await batch([{ sql: "INSERT INTO items (id, v) OVERRIDING SYSTEM VALUE VALUES (500, 'b1')" }, { sql: "INSERT INTO items (v) VALUES ('b2') RETURNING id" }], o);
    chk("D21 E8 묶음 — 원래 id 로 넣은 바로 다음 문장부터 맞춰진 시퀀스를 쓴다(501)", Number(b.results[1]?.rows[0]?.id) === 501, JSON.stringify(b.results));
    const bad9 = await errOf(batch([{ sql: "INSERT INTO items (id, v) OVERRIDING SYSTEM VALUE VALUES (900, 'c1')" },
      { sql: "INSERT INTO items (id, v) OVERRIDING SYSTEM VALUE VALUES (100, 'dup')" }], o));
    const after9 = await nextId();
    chk("D21 E9 묶음이 실패하면 넣은 행도 없다(900 없음) · 그 뒤 평범한 INSERT 는 된다",
      bad9?.status === 409 && bad9?.body?.index === 1 && !(await has(900)) && after9 > 501 && await has(after9), JSON.stringify({ bad9: bad9?.message, after9 }));
    const zero = await runS("INSERT INTO items (id, v) OVERRIDING SYSTEM VALUE SELECT 7000, 'z' WHERE false");
    const n5 = await nextId();
    chk("D21 E10 0행 INSERT … SELECT — 오류 없음 · 시퀀스 그대로", zero.changed === 0 && n5 === after9 + 1, JSON.stringify({ zero, n5, after9 }));

    const role = roleOf(SA, "seq");
    const other = await errOf(runS("", [], { plan: raw(`SELECT setval('"${SA}"."memo__notes_id_seq"', 999)`, true) }));
    chk("D21 E11 앱 역할로 다른 앱 표의 시퀀스를 옮기면 권한 거부(403)", other?.status === 403, JSON.stringify({ st: other?.status, m: other?.message }));
    const priv = (await su.query(`SELECT has_sequence_privilege($1, $2, 'SELECT') AS s, has_sequence_privilege($1, $2, 'UPDATE') AS u, has_sequence_privilege($1, $2, 'USAGE') AS g`,
      [role, `"${SA}"."seq__items_id_seq"`])).rows[0];
    //  UPDATE 는 DB 에서 nextval·setval 도 허락한다 — 앱 SQL 이 그 함수를 부르는 것은 검사기가 막는다(app-sql.test). 여기선 최소 권한만 본다.
    chk("D21 E12 앱 역할은 자기 표 id 시퀀스에 SELECT·UPDATE 만 받는다(USAGE 는 없다)", priv.s === true && priv.u === true && priv.g === false, JSON.stringify(priv));

    await su.query(`REVOKE ALL ON SEQUENCE "${SA}"."seq__items_id_seq" FROM "${role}"`);
    const denied = await errOf(put([1000]));
    await ensureAppSqlRole("seq", ["items", "plain"], SA);
    const again = await put([1001]);
    const n6 = await nextId();
    chk("D21 E13 시퀀스 권한이 없던 역할(이전 판)도 다시 보장하면 받는다", denied?.status === 403 && !(await has(1000)) && again.changed === 1 && n6 === 1002,
      JSON.stringify({ denied: denied?.status, n6 }));

    // E14 같은 표를 맞추는 트랜잭션끼리 줄을 선다 — 앞 묶음이 맞춤을 마친 채 3초 머무는 동안 뒤 문장은 잠금 대기 상한(1초)에 걸린다.
    const plan = (sql) => planAppSql(sql, { appId: "seq", schema: SA, tables: o.tables });
    const waitHeld = async () => {                                     // 앞 묶음이 맞춤 잠금을 쥘 때까지(이름은 모른다 — 자문 잠금이 하나 잡혔나만 본다)
      for (let i = 0; i < 100; i++) {
        if ((await su.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted")).rows[0].n > 0) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    const heldP = errOf(batch([{ plan: await plan("INSERT INTO items (id, v) OVERRIDING SYSTEM VALUE VALUES (2000, 'h')") }, { plan: raw("SELECT pg_sleep(3)") }], o));
    const saw = await waitHeld();
    const waited = await errOf(put([2001]));
    const held = await heldP;
    chk("D21 E14 같은 표 맞춤은 줄을 선다 — 앞 트랜잭션이 끝나기 전엔 뒤 문장이 기다리다 409(그 까닭으로) · 그 행은 없다",
      saw && held === null && waited?.status === 409 && /원래 id 로 넣는 다른 작업/.test(waited?.message ?? "") && !(await has(2001)) && await has(2000),
      JSON.stringify({ saw, held: held?.message, waited: waited?.status, m: waited?.message }));
    //  E14b 기다릴 수 있으면 된다 — 앞 트랜잭션(3000)이 커밋한 뒤 뒤 문장(2500)이 이어서 맞추고, 시퀀스는 둘 중 큰 쪽 뒤로 간다.
    limits({ LIVELY_APP_SQL_LOCK_MS: "8000" });
    const heldP2 = errOf(batch([{ plan: await plan("INSERT INTO items (id, v) OVERRIDING SYSTEM VALUE VALUES (3000, 'h2')") }, { plan: raw("SELECT pg_sleep(1)") }], o));
    const saw2 = await waitHeld();
    const waited2 = await errOf(put([2500]));
    const held2 = await heldP2;
    const n7 = await nextId();
    limits();
    chk("D21 E14b 잠금 대기 상한 안이면 뒤 문장도 된다 — 시퀀스는 큰 쪽(3000) 뒤로(3001)",
      saw2 && held2 === null && waited2 === null && await has(2500) && await has(3000) && n7 === 3001, JSON.stringify({ saw2, held2: held2?.message, waited2: waited2?.message, n7 }));

    //  E18 숫자로 시작하는 앱 id(물리 이름 "9seq__items") — 표 이름 모양 확인이 이런 앱도 받는다.
    await ensureAppTables("9seq", [{ table: "items", columns: [{ name: "v", type: "text" }] }], { schema: SA, strict: true, sqlRole: true, report: emptyTableReport() });
    const o9 = { app: "9seq", tables: ["items"] };
    const put9 = await errOf(run("INSERT INTO items (id, v) OVERRIDING SYSTEM VALUE VALUES (70, 'a')", [], o9));
    const next9 = await errOf(run("INSERT INTO items (v) VALUES ('b') RETURNING id", [], o9).then((r) => { if (Number(r.rows[0]?.id) !== 71) throw new Error(`id ${r.rows[0]?.id}`); }));
    chk("D21 E18 숫자로 시작하는 앱 id 도 원래 id 로 넣고 맞춘다(70 → 다음 71)", put9 === null && next9 === null, JSON.stringify({ put9: put9?.message, next9: next9?.message }));

    await su.query(`ALTER TABLE "${SA}"."seq__plain" ALTER COLUMN id DROP IDENTITY`);
    const ensured = await errOf(ensureAppSqlRole("seq", ["items", "plain"], SA));
    const noSeq = await errOf(runS("INSERT INTO plain (id, v) OVERRIDING SYSTEM VALUE VALUES (42, 'p')"));
    const plainRow = (await su.query(`SELECT 1 FROM "${SA}"."seq__plain" WHERE id = 42`)).rowCount === 1;
    chk("D21 E15 id 시퀀스가 없는 표 — 역할 보장도, 원래 id 로 넣기도 오류 없이 된다", ensured === null && noSeq === null && plainRow,
      JSON.stringify({ ensured: ensured?.message, noSeq: noSeq?.message }));
  }

  // ── D9 ──
  {
    const role = roleOf(SA, "crm");
    const cleaned = await cleanupDroppedTables("crm", ["conversations"], SA);
    const archivedAs = cleaned.archived[0]?.archived_as ?? "";
    const can = archivedAs ? (await su.query("SELECT has_table_privilege($1, $2, 'SELECT') AS ok", [role, archivedAs.split(".").map((x) => `"${x}"`).join(".")])).rows[0].ok : null;
    chk("D9 보관된 테이블은 앱 역할이 못 읽는다", !!archivedAs && can === false, JSON.stringify({ cleaned, can }));
    const seqCan = archivedAs ? (await su.query("SELECT has_sequence_privilege($1, pg_get_serial_sequence($2, 'id'), 'UPDATE') AS ok",
      [role, archivedAs.split(".").map((x) => `"${x}"`).join(".")])).rows[0].ok : null;
    chk("D9 E16(#5172) 보관된 테이블의 id 시퀀스도 앱 역할이 못 옮긴다(권한을 걷는다)", seqCan === false, JSON.stringify({ seqCan }));
    //  E17(#5172) 어디선가 시퀀스 권한이 남아 있어도(보관 단계를 거치지 않은 길) 앱 제거는 역할을 지운다 — 남은 권한은 DROP ROLE 을 막는다.
    const archivedSeq = archivedAs ? (await su.query("SELECT pg_get_serial_sequence($1, 'id') AS s", [archivedAs.split(".").map((x) => `"${x}"`).join(".")])).rows[0].s : null;
    if (archivedSeq) await su.query(`GRANT UPDATE ON SEQUENCE ${archivedSeq} TO "${role}"`);
    const leftover = archivedSeq ? (await su.query("SELECT has_sequence_privilege($1, $2, 'UPDATE') AS ok", [role, archivedSeq])).rows[0].ok : null;
    await dropAppTables("crm", ["contacts"], SA);
    const gone = (await su.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount === 0;
    const memoRole = (await su.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [roleOf(SA, "memo")])).rowCount === 1;
    chk("D9 앱 제거(테이블 DROP) 때 그 앱 역할만 지운다", gone && memoRole, JSON.stringify({ gone, memoRole }));
    chk("D9 E17(#5172) 보관된 표의 시퀀스 권한이 남아 있었어도 앱 제거는 역할을 지운다", leftover === true && gone, JSON.stringify({ leftover, gone }));
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
  X.resetAppSqlLimits(env0);
  await X.closeAppSqlPool();
  await itemsPool.end().catch(() => {});
  await dropAll().catch((e) => console.error("정리 실패", e));
  await su.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
