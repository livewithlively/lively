// 앱 설치 끝단(#4224) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖, CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-install-inline.pg-test.mjs
//
// 설치 능력(org_app_install) 핸들러를 inline 소스로 부르고 store_* 로 읽고 쓴다 — 목이 아니라 initAllSchemas 를 적용한
//  **새 DB** 위에서(주어진 DSN 의 서버에 전용 DB 를 만들고 끝나면 지운다). 단일 테넌트(스키마 app)·DDL 전용 자격 없음 =
//  자가호스팅 모양이라, 앱 DDL 이 itemsPool(풀이 소유자) 분기로 돈다 — 워크스페이스별 스키마·role 분리는
//  store-schema.pg-test.mjs 가 따로 본다(그쪽은 전용 DDL 연결 분기만 탄다).
//
//  E1 inline 첫 설치(하이픈 id) → 물리 테이블 · store 쓰기 · 화면 HTML · 출처엔 모양만
//  E2 갱신 — 칸 추가 · 빠진 테이블(데이터 있음) 보관 · 선언 밖 테이블 store 거부 · 설치한 사람에게 알림
//  E3 빠진 빈 테이블은 삭제(알림 없음) · E4 타입 불일치는 바꾸지 않고 알림 · E5 퓨즈 409 + 알림 + 무변경
//  E6 연속 하이픈 id + 테이블은 400 · E7 제거하면 하이픈 id 앱 테이블도 사라진다
import pg from "pg";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_install_4224";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
await dbc.query("CREATE EXTENSION IF NOT EXISTS vector").catch(() => { /* pgvector 없는 로컬 PG — 렉시컬 폴백 */ });
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
delete process.env.LIVELY_APP_DDL_DATABASE_URL;
delete process.env.LIVELY_OWNER_DATABASE_URL;
delete process.env.LIVELY_APP_DB_ROLE;
delete process.env.LIVELY_APP_TABLE_FUSE;
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
const { appStoreCapabilities } = await import(`${D}/capabilities/app-store.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const cap = (n) => [...appCapabilities, ...appStoreCapabilities].find((c) => c.name === n);
const admin = { userId: "pgt-installer", email: "pgt@x", scopes: ["admin"] };
const ctx = { source: "mcp" };
let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const manifest = (tables, extra = {}) => JSON.stringify({ id: "probe-app", title: "시험 앱", version: "0.1.0",
  permissions: { tools: ["store_insert", "store_query"] }, data: { tables }, ui: { pages: [{ key: "main", title: "시험", entry: "ui/index.html" }] }, ...extra });
const files = (tables) => [{ path: "lively-app.json", content: manifest(tables) }, { path: "ui/index.html", content: "<!doctype html><p>시험</p>" }];
const install = (tables) => cap("org_app_install").handler({ source: { kind: "inline", files: files(tables) } }, admin, ctx);
const appUser = { userId: "pgt-installer", appId: "probe-app" };
const notes = (extra = []) => ({ name: "notes", columns: [{ name: "body", type: "text" }, ...extra] });
const logs = { name: "logs", columns: [{ name: "line", type: "text" }] };
const tags = { name: "tags", columns: [{ name: "label", type: "text" }] };
const notifs = async () => (await itemsPool.query(`SELECT app_id, title, body FROM org_app_notification WHERE member_id='pgt-installer' ORDER BY created_at`)).rows;
try {
  // 1) 첫 설치 — 하이픈 id · inline
  const r1 = await install([notes(), logs]);
  chk("E1 inline 첫 설치 — created=true · 테이블 둘 생성 · 출처는 모양만", r1.created === true && r1.tables.created.join() === "notes,logs"
    && r1.app.source.kind === "inline" && r1.app.source.files === 2 && !("content" in r1.app.source), JSON.stringify({ t: r1.tables, s: r1.app.source }));
  const phys = (await itemsPool.query(`SELECT tablename FROM pg_tables WHERE schemaname='app' ORDER BY 1`)).rows.map((r) => r.tablename);
  chk("E1b 하이픈 id 의 물리 테이블(probe_app__*)", phys.includes("probe_app__notes") && phys.includes("probe_app__logs"), JSON.stringify(phys));
  await cap("store_insert").handler({ table: "logs", row: { line: "남길 기록" } }, appUser, ctx);
  await cap("store_insert").handler({ table: "notes", row: { body: "메모" } }, appUser, ctx);
  chk("E1c 앱 principal 로 store_insert/query(하이픈 id)", (await cap("store_query").handler({ table: "logs" }, appUser, ctx)).rows[0]?.line === "남길 기록");
  const ui = await cap("org_app_ui").handler({ app_id: "probe-app" }, admin, ctx);
  chk("E1d 화면 HTML 이 inline 에서 온 그대로", ui.html === "<!doctype html><p>시험</p>");

  // 2) 갱신 — notes 에 칸 추가, logs 빠짐(데이터 있음), tags 새로
  const r2 = await install([notes([{ name: "done", type: "bool" }]), tags]);
  chk("E2 같은 id 재설치 = 갱신(created=false)", r2.created === false);
  chk("E2b 늘어난 칸 ADD COLUMN(notes.done) · 새 테이블 tags", r2.tables.added_columns.map((c) => `${c.table}.${c.column}`).join() === "notes.done" && r2.tables.created.join() === "tags", JSON.stringify(r2.tables));
  chk("E2c 빠진 logs(1행)는 보관", r2.tables.archived.length === 1 && r2.tables.archived[0].table === "logs" && r2.tables.archived[0].rows === 1 && /^app_archive\.probe_app__logs__\d{14}$/.test(r2.tables.archived[0].archived_as), JSON.stringify(r2.tables.archived));
  const kept = (await cap("store_query").handler({ table: "notes" }, appUser, ctx)).rows;
  chk("E2d 기존 행 보존 + 새 칸에 쓴다", kept[0]?.body === "메모" && kept[0]?.done === null
    && (await cap("store_insert").handler({ table: "notes", row: { body: "둘", done: true } }, appUser, ctx)).id != null, JSON.stringify(kept));
  let gone = null; try { await cap("store_query").handler({ table: "logs" }, appUser, ctx); } catch (e) { gone = e; }
  chk("E2e 매니페스트에서 빠진 테이블은 store 가 거부(선언 밖)", gone && gone.status === 404, String(gone?.message));
  const n2 = await notifs();
  chk("E2f 보관 알림이 설치한 사람에게 간다", n2.length === 1 && n2[0].app_id === "probe-app" && /보관/.test(n2[0].title) && /logs/.test(n2[0].body ?? ""), JSON.stringify(n2));

  // 3) tags 가 빠짐(비어 있음) → 삭제 · 알림 없음
  const r3 = await install([notes([{ name: "done", type: "bool" }])]);
  chk("E3 빈 테이블(tags)은 지운다 · 알림은 늘지 않는다", r3.tables.dropped.join() === "tags" && r3.tables.archived.length === 0 && (await notifs()).length === 1, JSON.stringify(r3.tables));

  // 4) 타입 변경 선언 → 안 바꾸고 알림(응답)
  const r4 = await install([{ name: "notes", columns: [{ name: "body", type: "int" }, { name: "done", type: "bool" }] }]);
  chk("E4 타입이 다르면 바꾸지 않고 type_mismatches 로 알린다", r4.tables.type_mismatches.length === 1 && r4.tables.type_mismatches[0].column === "body", JSON.stringify(r4.tables));

  // 5) 퓨즈 — 상한을 지금 수에 맞춰 두고 새 테이블 하나를 더하면 409 + 알림, 아무것도 안 바뀐다
  const now = Number((await itemsPool.query(`SELECT count(*)::int n FROM pg_tables WHERE schemaname IN ('app','app_archive')`)).rows[0].n);
  process.env.LIVELY_APP_TABLE_FUSE = String(now);
  let fuseErr = null; try { await install([notes([{ name: "done", type: "bool" }]), { name: "extra", columns: [{ name: "x", type: "text" }] }]); } catch (e) { fuseErr = e; }
  chk("E5 퓨즈를 넘기는 설치는 409", fuseErr && fuseErr.status === 409 && /상한/.test(fuseErr.message), String(fuseErr?.message));
  chk("E5b 거절한 설치는 테이블을 만들지 않았다", (await itemsPool.query(`SELECT to_regclass('app.probe_app__extra') r`)).rows[0].r === null);
  const n5 = await notifs();
  chk("E5c 거절 알림", n5.length === 2 && /거절/.test(n5[1].title), JSON.stringify(n5));
  delete process.env.LIVELY_APP_TABLE_FUSE;

  // 6) 이름 검사는 400 으로(503 에 뭉개지지 않게)
  const bad = JSON.parse(manifest([notes()])); bad.id = "probe--app";
  let e6 = null; try { await cap("org_app_install").handler({ source: { kind: "inline", files: [{ path: "lively-app.json", content: JSON.stringify(bad) }, { path: "ui/index.html", content: "x" }] } }, admin, ctx); } catch (e) { e6 = e; }
  chk("E6 연속 하이픈 id + 테이블은 400", e6 && e6.status === 400 && /데이터 테이블을 가질 수 없습니다/.test(e6.message), String(e6?.message));

  // 7) 제거 — 하이픈 id 앱의 테이블도 지운다
  await cap("org_app_remove").handler({ app_id: "probe-app" }, admin, ctx);
  chk("E7 제거하면 하이픈 id 앱 테이블도 사라진다", (await itemsPool.query(`SELECT to_regclass('app.probe_app__notes') r`)).rows[0].r === null);
} catch (e) { fail++; console.error("FAIL 예외 —", e); }
finally {
  await itemsPool.end().catch(() => {});
  await dbc.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch((e) => console.error("정리 실패", e));
  await su.end();
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
