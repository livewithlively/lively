// 앱 자유 SQL 끝단(#4226) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖, CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-sql-e2e.pg-test.mjs
//
// 설치·store_sql·떠 두기·되돌리기 능력 핸들러를 initAllSchemas 를 적용한 **새 DB** 위에서 부른다(자가호스팅 모양 —
//  단일 테넌트·스키마 app·풀이 소유자). 역할 경계 자체는 app-sql.pg-test.mjs(매니지드 모양 역할)가 따로 본다.
//
//  E1 inline 설치(하이픈 id · 인덱스 선언 · store_sql 권한) → sql_role.ok · 선언 이름 SQL 로 쓰고 읽기 · params 개수 400
//     · 기본 앱은 store_sql 400 · 매니페스트 인덱스 칸 검사 400
//  E2 빈도 429(순간 한도 다음) · 용량 507(쓰기만 — SELECT·DELETE 는 된다, store_insert 도 507)
//  E3 떠 두기 — 1,000행 묶음 · 20시간 안 다시 부르면 건너뜀 · 7일 지난 것 정리
//  E4 되돌리기 — 지운 행이 원래 id 로 돌아온다 · 직전 상태를 먼저 떠 둔다 · id 시퀀스가 맞춰져 다음 삽입이 겹치지 않는다
//     · 떠 둔 뒤 늘어난 칸은 NULL
//  E5 제거 전 떠 두기 → 같은 id 로 다시 설치 → 되돌리기로 데이터가 돌아온다 · 제거 때 앱 역할도 지운다
import pg from "pg";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_sql_4226";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE"]) delete process.env[k];
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
const { appStoreCapabilities } = await import(`${D}/capabilities/app-store.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const { appSqlRoleName } = await import(`${D}/apps/store-ddl.js`);
const X = await import(`${D}/apps/app-sql-exec.js`);
const S = await import(`${D}/apps/app-snapshot.js`);
const cap = (n) => [...appCapabilities, ...appStoreCapabilities].find((c) => c.name === n);
const admin = { userId: "pgt-admin", email: "pgt@x", scopes: ["admin"] };
const ctx = { source: "mcp" };
const appUser = { userId: "pgt-admin", appId: "crm-dash" };
let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const status = async (p) => { try { await p; return "ok"; } catch (e) { return e?.status ?? String(e); } };
const env0 = { ...process.env };
const limits = (over = {}) => X.resetAppSqlLimits({ ...env0, ...over });

const contacts = (extra = []) => ({ name: "contacts", columns: [{ name: "name", type: "text" }, { name: "email", type: "text" }, { name: "stage", type: "text" }, ...extra], indexes: [{ columns: ["email"], unique: true }] });
const conversations = { name: "conversations", columns: [{ name: "contact_id", type: "int" }, { name: "note", type: "text" }] };
const manifest = (tables) => JSON.stringify({ id: "crm-dash", title: "컨택", version: "0.1.0",
  permissions: { tools: ["store_insert", "store_query", "store_sql", "store_tables"] }, data: { tables }, ui: { pages: [{ key: "main", title: "컨택", entry: "ui/index.html" }] } });
const install = (tables) => cap("org_app_install").handler({ source: { kind: "inline", files: [{ path: "lively-app.json", content: manifest(tables) }, { path: "ui/index.html", content: "<p>x</p>" }] } }, admin, ctx);
const sql = (text, params) => cap("store_sql").handler({ sql: text, params }, appUser, ctx);
const ROLE = appSqlRoleName(DB, "app", "crm-dash");

try {
  limits();
  // ── E1 ──
  const r1 = await install([contacts(), conversations]);
  chk("E1 설치 — 테이블·인덱스·앱 역할(sql_role.ok)", r1.tables.created.join() === "contacts,conversations" && r1.tables.added_indexes.length === 1 && r1.tables.sql_role?.ok === true, JSON.stringify(r1.tables));
  const ins = await sql("INSERT INTO contacts(name, email, stage) VALUES ($1, $2, '연락 전'), ('나', 'b@x', '약속') RETURNING id, name", ["가", "a@x"]);
  const conv = await sql("INSERT INTO conversations(contact_id, note) SELECT id, '첫 대화' FROM contacts WHERE email = $1", ["a@x"]);
  const q = await sql("SELECT c.name, count(v.id)::int AS n FROM contacts c LEFT JOIN conversations v ON v.contact_id = c.id GROUP BY c.name ORDER BY c.name");
  chk("E1b 선언 이름 SQL — RETURNING · INSERT…SELECT · 조인 집계", ins.changed === 2 && ins.rows.length === 2 && conv.changed === 1
    && JSON.stringify(q.rows) === JSON.stringify([{ name: "가", n: 1 }, { name: "나", n: 0 }]) && q.kind === "select", JSON.stringify({ ins, conv, q }));
  chk("E1c params 개수가 자리와 다르면 400", (await status(sql("SELECT * FROM contacts WHERE email = $1", []))) === 400);
  await itemsPool.query(`INSERT INTO org_app(id, title, version, manifest, source, status)
    VALUES ('pgt-builtin', '기본', '0.0.1', '{"data":{"tables":[{"name":"marks","columns":[{"name":"a","type":"text"}]}]}}', '{"kind":"builtin"}', 'active')`);
  chk("E1d 기본 앱은 store_sql 400", (await status(cap("store_sql").handler({ sql: "SELECT 1" }, { userId: "pgt-admin", appId: "pgt-builtin" }, ctx))) === 400);
  const badIx = JSON.parse(manifest([{ ...contacts(), indexes: [{ columns: ["nope"] }] }]));
  chk("E1e 매니페스트 인덱스 칸이 없는 칸이면 400", (await status(cap("org_app_install").handler({ source: { kind: "inline", files: [{ path: "lively-app.json", content: JSON.stringify(badIx) }, { path: "ui/index.html", content: "x" }] } }, admin, ctx))) === 400);
  const tbl = await cap("store_tables").handler({}, appUser, ctx);
  chk("E1f store_tables 가 인덱스와 sql 가능 여부를 알린다", tbl.sql === true && tbl.tables[0]?.indexes?.[0]?.unique === true, JSON.stringify(tbl));

  // ── E2 ──
  limits({ LIVELY_APP_SQL_RATE: "0.001", LIVELY_APP_SQL_BURST: "2" });
  const a = await status(sql("SELECT 1")), b = await status(sql("SELECT 1")), c = await status(sql("SELECT 1"));
  const cq = await status(cap("store_query").handler({ table: "contacts" }, appUser, ctx));
  chk("E2 빈도 — 순간 2 다음은 429 · store_* 도 같은 버킷", a === "ok" && b === "ok" && c === 429 && cq === 429, JSON.stringify({ a, b, c, cq }));
  limits({ LIVELY_APP_DATA_QUOTA_BYTES: "1" });
  const w = await status(sql("INSERT INTO contacts(name) VALUES ('초과')"));
  const u = await status(sql("UPDATE contacts SET stage = 'x' WHERE id > 0"));
  const r = await status(sql("SELECT count(*) FROM contacts"));
  const dl = await status(sql("DELETE FROM contacts WHERE name = '없음'"));
  const si = await status(cap("store_insert").handler({ table: "contacts", row: { name: "초과" } }, appUser, ctx));
  chk("E2b 용량 — INSERT·UPDATE·store_insert 507, SELECT·DELETE 는 된다", w === 507 && u === 507 && si === 507 && r === "ok" && dl === "ok", JSON.stringify({ w, u, r, dl, si }));
  limits();

  // ── E3 ──
  await sql("INSERT INTO contacts(name, email) SELECT 'p' || g, 'p' || g || '@x' FROM generate_series(1, 2500) g");
  const t0 = new Date();
  const d1 = await S.runDailyAppSnapshots(t0);
  const chunks = (await itemsPool.query(`SELECT table_name, count(*)::int AS chunks, sum(row_count)::int AS rows FROM org_app_snapshot WHERE app_id='crm-dash' GROUP BY 1 ORDER BY 1`)).rows;
  const d2 = await S.runDailyAppSnapshots(new Date(t0.getTime() + 60_000));
  chk("E3 떠 두기 — 1,000행 묶음(2,502행 = 3묶음) · 빈 테이블도 기록 · 20시간 안엔 건너뜀",
    d1.taken.includes("crm-dash") && JSON.stringify(chunks) === JSON.stringify([{ table_name: "contacts", chunks: 3, rows: 2502 }, { table_name: "conversations", chunks: 1, rows: 1 }])
    && d2.taken.length === 0 && d2.skipped >= 1, JSON.stringify({ d1, chunks, d2 }));
  await itemsPool.query(`INSERT INTO org_app_snapshot(app_id, taken_at, table_name, chunk, reason, row_count, rows) VALUES ('crm-dash', now() - interval '8 days', 'contacts', 0, 'daily', 0, '[]')`);
  const pruned = await S.pruneAppSnapshots();
  chk("E3b 7일 지난 묶음은 정리", pruned === 1, String(pruned));
  //  격리 리뷰 실측: 묶음마다 따로 커밋하면 중간 실패 뒤 앞 묶음만 남아 «정상 떠 두기» 로 보였다 → 한 트랜잭션이어야 한다.
  //   두 번째 묶음(chunk 1)에서 실패하게 해 본다(트리거로 고장 주입).
  await su.query(`SELECT 1`);
  const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
  await dbc.query(`CREATE FUNCTION pgt_fail_chunk1() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.chunk = 1 THEN RAISE EXCEPTION 'pgt 고장 주입'; END IF; RETURN NEW; END $f$`);
  await dbc.query(`CREATE TRIGGER pgt_fail BEFORE INSERT ON org_app_snapshot FOR EACH ROW EXECUTE FUNCTION pgt_fail_chunk1()`);
  const tFail = new Date(t0.getTime() + 21 * 3600_000);
  const dF = await S.runDailyAppSnapshots(tFail);
  const leftover = Number((await itemsPool.query(`SELECT count(*)::int AS n FROM org_app_snapshot WHERE app_id='crm-dash' AND taken_at=$1`, [tFail])).rows[0].n);
  await dbc.query(`DROP TRIGGER pgt_fail ON org_app_snapshot`); await dbc.query(`DROP FUNCTION pgt_fail_chunk1()`); await dbc.end();
  const dR = await S.runDailyAppSnapshots(new Date(tFail.getTime() + 60_000));
  chk("E3c 떠 두기가 중간에 실패하면 아무것도 남지 않고, 다음 틱이 다시 뜬다(20시간 억제에 걸리지 않는다)",
    dF.failed.includes("crm-dash") && leftover === 0 && dR.taken.includes("crm-dash"), JSON.stringify({ dF, leftover, dR }));
  process.env.LIVELY_APP_SNAPSHOT_MAX_BYTES = "1";
  const dB = await S.runDailyAppSnapshots(new Date(tFail.getTime() + 22 * 3600_000));
  delete process.env.LIVELY_APP_SNAPSHOT_MAX_BYTES;
  chk("E3d 너무 커서 건너뛴 앱은 틱 결과(too_big)에 드러난다", dB.too_big.includes("crm-dash"), JSON.stringify(dB));

  // ── E4 ──
  const snaps = (await cap("app_data_snapshots").handler({ app_id: "crm-dash" }, admin, ctx)).snapshots;
  const at = snaps[0]?.taken_at;
  const before = (await sql("SELECT id, name FROM contacts WHERE email IN ('a@x','b@x') ORDER BY id")).rows;
  await sql("DELETE FROM contacts WHERE stage IS NOT NULL");
  await install([contacts([{ name: "memo", type: "text" }]), conversations]);                       // 떠 둔 뒤 칸이 늘었다
  const rs = await cap("app_data_restore").handler({ app_id: "crm-dash", taken_at: at, table: "contacts" }, admin, ctx);
  const after = (await sql("SELECT id, name, memo FROM contacts WHERE email IN ('a@x','b@x') ORDER BY id")).rows;
  const count = (await sql("SELECT count(*)::int AS n FROM contacts")).rows[0].n;
  const next = (await sql("INSERT INTO contacts(name) VALUES ('새로') RETURNING id")).rows[0].id;
  const maxBefore = Math.max(...(await sql("SELECT max(id) AS m FROM contacts WHERE name <> '새로'")).rows.map((x) => Number(x.m)));
  const kinds = (await cap("app_data_snapshots").handler({ app_id: "crm-dash" }, admin, ctx)).snapshots.map((x) => x.reason);
  chk("E4 되돌리기 — 지운 행이 원래 id 로 · 늘어난 칸은 NULL · 전체 2,502행",
    rs.restored[0]?.rows === 2502 && JSON.stringify(after.map((x) => [x.id, x.name])) === JSON.stringify(before.map((x) => [x.id, x.name])) && after.every((x) => x.memo === null) && count === 2502,
    JSON.stringify({ rs, before, after, count }));
  chk("E4b 직전 상태를 먼저 떠 둔다(before-restore) · id 시퀀스가 맞춰져 다음 id 가 겹치지 않는다", kinds.includes("before-restore") && Number(next) > maxBefore, JSON.stringify({ kinds, next, maxBefore }));
  chk("E4c 없는 시점은 404", (await status(cap("app_data_restore").handler({ app_id: "crm-dash", taken_at: "2020-01-01T00:00:00Z" }, admin, ctx))) === 404);
  //  격리 리뷰 실측: 직전 상태를 못 떠 두면(너무 큰 앱) 그대로 되돌려 이후 쓴 행을 되돌릴 길 없이 지웠다 → force 없이는 멈춘다.
  const beforeN = (await sql("SELECT count(*)::int AS n FROM contacts")).rows[0].n;
  process.env.LIVELY_APP_SNAPSHOT_MAX_BYTES = "1";
  const noSafety = await status(cap("app_data_restore").handler({ app_id: "crm-dash", taken_at: at, table: "contacts" }, admin, ctx));
  const afterNoSafety = (await sql("SELECT count(*)::int AS n FROM contacts")).rows[0].n;
  delete process.env.LIVELY_APP_SNAPSHOT_MAX_BYTES;
  chk("E4d 직전 상태를 못 떠 두면 409 · 데이터는 그대로", noSafety === 409 && afterNoSafety === beforeN, JSON.stringify({ noSafety, beforeN, afterNoSafety }));
  //  떠 둔 행 수와 넣은 행 수가 다르면(묶음이 손상됐다) 전부 취소한다.
  await itemsPool.query(`UPDATE org_app_snapshot SET row_count = row_count + 1 WHERE app_id='crm-dash' AND taken_at=$1 AND table_name='contacts' AND chunk=0`, [new Date(at)]);
  const tampered = await status(cap("app_data_restore").handler({ app_id: "crm-dash", taken_at: at, table: "contacts" }, admin, ctx));
  const afterTamper = (await sql("SELECT count(*)::int AS n FROM contacts")).rows[0].n;
  await itemsPool.query(`UPDATE org_app_snapshot SET row_count = row_count - 1 WHERE app_id='crm-dash' AND taken_at=$1 AND table_name='contacts' AND chunk=0`, [new Date(at)]);
  chk("E4e 넣은 행 수가 떠 둔 수와 다르면 전부 취소(500) · 데이터는 그대로", tampered === 500 && afterTamper === beforeN, JSON.stringify({ tampered, beforeN, afterTamper }));

  // ── E5 ──
  const rm = await cap("org_app_remove").handler({ app_id: "crm-dash" }, admin, ctx);
  const tableGone = (await itemsPool.query(`SELECT to_regclass('app.crm_dash__contacts') r`)).rows[0].r === null;
  const roleGone = (await su.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [ROLE])).rowCount === 0;
  await install([contacts(), conversations]);
  const back = await cap("app_data_restore").handler({ app_id: "crm-dash", taken_at: rm.snapshot.taken_at }, admin, ctx);
  const n = (await sql("SELECT count(*)::int AS n FROM contacts")).rows[0].n;
  chk("E5 제거 전 떠 두기 → 테이블·역할 삭제 → 다시 설치 → 되돌리기로 돌아온다",
    !!rm.snapshot?.taken_at && tableGone && roleGone && back.restored.length === 2 && n === 2503, JSON.stringify({ rm: rm.snapshot, tableGone, roleGone, back, n }));
  //  새 테이블의 id 시퀀스는 1 부터다 — 되돌린 id(최대 2,503)에 맞춰 두지 않으면 다음 삽입이 id 1 과 부딪힌다.
  const after5 = await status(sql("INSERT INTO contacts(name) VALUES ('되돌린 뒤') RETURNING id"));
  const top = (await sql("SELECT max(id)::int AS m FROM contacts")).rows[0].m;
  chk("E5b 새 테이블에 되돌린 뒤에도 다음 삽입이 겹치지 않는다(id 시퀀스 맞춤)", after5 === "ok" && top > 2503, JSON.stringify({ after5, top }));
} catch (e) { fail++; console.error("FAIL 예외 —", e); }
finally {
  X.resetAppSqlLimits(env0);
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch((e) => console.error("정리 실패", e));
  await su.query(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => {});
  await su.end();
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
