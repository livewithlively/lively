// 앱 공개 범위 · 만든 사람 · 책임자(#4632 「나만」 · #4667 앱 v2-15) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖, CI services:postgres 스텝 — .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/visibility.pg-test.mjs
//
// 앱 만들기 「만들기 시작」 의 예약부터 공개 · 초안 · 되돌리기 · 사본 · 공개 거두기 · 떠난 사람의 책임자 이관까지 **새 DB** 위에서 끝까지 돈다
//  (initAllSchemas 를 적용한 DB · 주어진 DSN 의 서버에 전용 DB 를 만들고 끝나면 지운다). 순수 판정은 visibility.test.ts 가 잡는다 —
//  여기는 그 판정이 **실제 행·표·화면·도구 응답**에 어떻게 착지하는지다.
//
//  B1 남의 세션으로 예약 403 · B2 예약 → 나만 보는 빈 앱(멱등 · 목록·역조회) · B3 예약한 세션에서 다른 id 로 저장 409
//  B4 예약 id 로 저장 → 1판 · 서버 기록(매니페스트 studio.made_by 위조 무시) · 남에겐 404 일곱 길  B5 남이 같은 id 로 덮어쓰기 403
//  B6 공개하기(남 404 · 만든 사람 OK) → 모두에게  B7 공개 뒤 고치면 초안 — 고친 사람만 새 판, 나머지는 공개 판(목록·화면·판 이력·내려받기)
//  B8 초안이 새로 선언한 표 · 공개 판의 표에 쓰기  B9 초안이 뺀 표는 공개 판이 쓰는 동안 남고, 공개하면 보관된다
//  B10 남(고치기 전원)이 고친 초안 — 그 사람만 보고 책임자가 공개  B11 되돌리기 + publish  B12 사본 — 원본 기록 · 못 보는 원본 404
//  B13 공개 거두기 — 남은 다시 404 · 붙여 둔 세션에서도 막힘  B14 오래된 빈 예약은 새 시작 때 거둔다
//  B15 떠난 사람 — 책임자만 관리자로(만든 사람 그대로) · 관리자에게 알림  B16 관리자가 책임자를 바꿈 → 새 책임자가 보고 지운다
//  B17 관리자 설치 앱(공개) — 만든 사람 = 설치한 관리자 · 구성원이 고치면 공개 판(저장 전 상태)이 못 박힌다
//  B18 #4632 시절 'me' 앱 — 채우기가 처음 설치한 사람을 책임자로(매니페스트 studio.made_by 는 판정에 쓰지 않는다 · 이미 떠난 사람이면 책임자 비움)
//  B19 초안이 걸린 공개 앱에 관리자 설치 — 표식 · 포인터 걷고 옛 공개 판 전용 표 보관 · 밀려난 초안 주인 알림(격리 리뷰 B2)
//  B20 남의 공개 전 판은 판 이력 · 되돌리기에서 없는 판 · 못 박은 판의 저장한 사람(격리 리뷰 NB-6 · NB-8)
//  B21 관리자 설치가 남의 나만 보는 앱을 못 덮음 · 초안이 걸린 공개 앱은 「나만」 불가(격리 리뷰 2-1 · 2-3)
//  B22 #4483 공개 판을 깨는 표 변경(칸 지우기 · 형 바꾸기)은 초안으로만 저장하면 409 · 아무것도 안 바뀐다 · publish:true 면 된다 ·
//      나만 보는 앱(공개 판 없음)엔 가드가 없다
import pg from "pg";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_visibility_4667";
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
const { sessionAppsCapabilities } = await import(`${D}/capabilities/session-apps.js`);
const { appStoreCapabilities } = await import(`${D}/capabilities/app-store.js`);
const { appToolCallCapabilities } = await import(`${D}/capabilities/app-tool-call.js`);
const { reclaimMemberAppFootprint, defaultReclaimDeps } = await import(`${D}/apps/member-deactivation.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const all = [...appCapabilities, ...sessionAppsCapabilities, ...appStoreCapabilities, ...appToolCallCapabilities];
const cap = (n) => { const c = all.find((x) => x.name === n); if (!c) throw new Error(`능력 없음: ${n}`); return c; };
const call = (n, input, user, ctx = { source: "mcp" }) => cap(n).handler(input, user, ctx);
const status = async (p) => { try { await p; return 200; } catch (e) { return e?.status ?? String(e?.message ?? e); } };
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const alice = { userId: "pgt-alice", email: "a@x", scopes: ["memory"], projects: ["*"] };
const bob = { userId: "pgt-bob", email: "b@x", scopes: ["memory"], projects: ["*"] };
const carol = { userId: "pgt-carol", email: "c@x", scopes: ["memory"], projects: ["*"] };
const boss = { userId: "pgt-boss", email: "boss@x", scopes: ["memory", "admin"], projects: ["*"] };
const inSession = (sid) => ({ source: "mcp", session: sid });
let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const row = async (id) => (await q(`SELECT * FROM org_app WHERE id=$1`, [id]))[0];

//  사람 · 세션 — 세션 주인은 desired-state 행(org_session_state)이 정본이다(apps/session-apps.ts sessionOwnerOf).
for (const [id, scopes] of [["pgt-alice", ["memory"]], ["pgt-bob", ["memory"]], ["pgt-carol", ["memory"]], ["pgt-boss", ["memory", "admin"]]]) {
  await q(`INSERT INTO org_member(id, kind, display_name, state, scopes) VALUES($1,'human',$1,'active',$2::jsonb)`, [id, JSON.stringify(scopes)]);
}
await q(`INSERT INTO org_member(id, kind, display_name, state, scopes) VALUES('pgt-gone','human','pgt-gone','inactive','["memory"]'::jsonb)`);   // B18 — 이미 떠난 사람
for (const [sid, owner] of [["box-alice-1", "pgt-alice"], ["box-alice-2", "pgt-alice"], ["box-bob-1", "pgt-bob"], ["box-carol-1", "pgt-carol"]]) {
  await q(`INSERT INTO org_session_state(id, owner, label) VALUES($1,$2,$1)`, [sid, owner]);
}
const manifest = (id, o = {}) => JSON.stringify({
  id, title: o.title ?? "회의 안건", version: o.version ?? "0.1.0",
  permissions: { scopes: [], tools: ["store_insert", "store_query"] },
  data: { tables: (o.tables ?? ["notes"]).map((name) => ({ name, columns: [{ name: "text", type: "text" }] })) },
  ui: { pages: [{ key: "main", title: o.title ?? "회의 안건", entry: "ui/index.html" }] },
  ...(o.studio ? { studio: o.studio } : {}),
}, null, 2);
const files = (id, html, o = {}) => [{ path: "lively-app.json", content: manifest(id, o) }, { path: "ui/index.html", content: html }];
const ui = async (id, user) => (await call("org_app_ui", { app_id: id }, user)).html;
const listed = async (user, input = {}) => (await call("org_apps", input, user)).apps;

try {
  // B1
  chk("B1 남의 세션으로는 만들기를 예약할 수 없다(403)", (await status(call("app_build_start", { session_id: "box-bob-1", title: "회의 안건" }, alice))) === 403);

  // B2
  const b2 = await call("app_build_start", { session_id: "box-alice-1", title: "회의 안건" }, alice);
  const ID = b2.app_id;
  const b2again = await call("app_build_start", { session_id: "box-alice-1", title: "딴 이름" }, alice);
  let r = await row(ID);
  const aliceEmpty = await listed(alice, { include_empty: true });
  const bySession = await listed(alice, { session: "box-alice-1" });
  chk("B2 예약 — 나만 보는 빈 앱 · 만든 사람/책임자/만들기 세션 · 같은 세션은 같은 앱(멱등) · 기본 목록엔 없고 앱빌더 목록·역조회엔 있다 · 남은 404",
    b2.created === true && /^app-[a-z0-9]{6}$/.test(ID) && b2again.app_id === ID && b2again.created === false
      && r.visibility === "me" && r.made_by === "pgt-alice" && r.owner_member === "pgt-alice" && r.build_session === "box-alice-1" && r.content_hash === null
      && !(await listed(alice)).some((a) => a.id === ID)
      && aliceEmpty.some((a) => a.id === ID && a.empty === true && a.visibility === "me")
      && bySession.length === 1 && bySession[0].id === ID && bySession[0].build_session === "box-alice-1"
      && !(await listed(bob, { include_empty: true })).some((a) => a.id === ID)
      && (await status(call("org_app_get", { app_id: ID }, bob))) === 404 && (await status(call("org_app_get", { app_id: ID }, alice))) === 200
      && (await listed(bob, { session: "box-alice-1" })).length === 0,
    JSON.stringify({ b2, b2again, r }));

  // B3
  const e3 = await errOf(call("app_save", { files: files("weekly-agenda", "<p>v1</p>") }, alice, inSession("box-alice-1")));
  chk("B3 예약한 세션에서 다른 id 로 저장하면 409 — 예약한 id 를 알려 준다 · 다른 앱이 생기지 않는다",
    e3?.status === 409 && String(e3?.message).includes(ID) && !(await row("weekly-agenda")), String(e3?.message));

  // B4
  const s4 = await call("app_save", { files: files(ID, "<p>v1</p>", { studio: { made_by: "pgt-bob", build_session: "box-bob-1" } }), note: "처음" }, alice, inSession("box-alice-1"));
  r = await row(ID);
  const bobBlocked = await Promise.all([
    status(call("org_app_ui", { app_id: ID }, bob)), status(call("me_app_grant", { app_id: ID }, bob)), status(call("app_pull", { app_id: ID }, bob)),
    status(call("app_versions", { app_id: ID }, bob)), status(call("session_app_attach", { app_id: ID, session_id: "box-bob-1" }, bob)),
    status(call("app_visibility_set", { app_id: ID, visibility: "all" }, bob)), status(call("org_app_tool_call", { app_id: ID, name: "store_query", arguments: { table: "notes" } }, bob)),
  ]);
  chk("B4 첫 저장 — 1판 · 나만 보는 앱 · 매니페스트 studio.made_by 를 남으로 적어도 서버 기록은 만든 사람 그대로 · 남에겐 일곱 길이 전부 404",
    s4.created === true && s4.version_no === 1 && s4.state === "me" && r.visibility === "me" && r.made_by === "pgt-alice" && r.owner_member === "pgt-alice"
      && r.build_session === "box-alice-1" && r.content_hash !== null && (await ui(ID, alice)).includes("v1")
      && !(await listed(bob)).some((a) => a.id === ID) && (await listed(alice)).some((a) => a.id === ID && a.made_by === "pgt-alice" && a.visibility === "me")
      && bobBlocked.every((x) => x === 404),
    JSON.stringify({ s4: { created: s4.created, v: s4.version_no, state: s4.state }, r: { vis: r.visibility, made: r.made_by }, bobBlocked }));

  // B5
  const e5 = await errOf(call("app_save", { files: files(ID, "<p>bob 덮어쓰기</p>") }, bob, inSession("box-bob-1")));
  chk("B5 남이 같은 id 로 저장하면 403 — 남이 만들고 있는 앱을 덮어쓰지 못한다", e5?.status === 403 && (await ui(ID, alice)).includes("v1"), String(e5?.message));

  // B6
  const p6 = await call("app_visibility_set", { app_id: ID, visibility: "all" }, alice);
  r = await row(ID);
  chk("B6 만든 사람이 공개 — 모두의 목록·화면에 선다 · 공개 판 = 1판",
    p6.changed === true && r.visibility === "all" && r.published_version_no === 1 && r.published_by === "pgt-alice" && r.draft_by === null
      && (await listed(bob)).some((a) => a.id === ID && a.view === "installed") && (await ui(ID, bob)).includes("v1"),
    JSON.stringify({ p6, vis: r.visibility, pub: r.published_version_no }));

  // B7
  const s7 = await call("app_save", { files: files(ID, "<p>v2 초안</p>", { title: "회의 안건 2", tables: ["notes", "extra"] }), note: "제목 바꿈" }, alice, inSession("box-alice-1"));
  r = await row(ID);
  const bobRow = (await listed(bob)).find((a) => a.id === ID);
  const aliceRow = (await listed(alice)).find((a) => a.id === ID);
  const vBob = await call("app_versions", { app_id: ID }, bob);
  const vAlice = await call("app_versions", { app_id: ID }, alice);
  const pullBob = await call("app_pull", { app_id: ID }, bob);
  const pullAlice = await call("app_pull", { app_id: ID }, alice);
  chk("B7 공개 뒤 고치면 초안 — 고친 사람만 2판(화면·제목·판 이력·내려받기), 나머지는 공개 판 1판",
    s7.state === "draft" && s7.version_no === 2 && r.draft_by === "pgt-alice" && r.published_version_no === 1 && r.current_version_no === 2
      && (await ui(ID, alice)).includes("v2") && (await ui(ID, bob)).includes("v1")
      && bobRow?.title === "회의 안건" && bobRow?.view === "published" && bobRow?.draft === null && bobRow?.current_version_no === 1
      && aliceRow?.title === "회의 안건 2" && aliceRow?.view === "installed" && aliceRow?.draft?.version_no === 2
      && vBob.versions.find((v) => v.is_current)?.version_no === 1 && vAlice.versions.find((v) => v.is_current)?.version_no === 2
      && vBob.versions.find((v) => v.is_published)?.version_no === 1
      && pullBob.files.find((f) => f.path === "ui/index.html")?.content.includes("v1") && pullBob.view === "published"
      && pullAlice.files.find((f) => f.path === "ui/index.html")?.content.includes("v2"),
    JSON.stringify({ s7: s7.state, draft: r.draft_by, bobRow: bobRow && { t: bobRow.title, v: bobRow.view }, aliceRow: aliceRow && { t: aliceRow.title, d: aliceRow.draft } }));

  // B8 — bob 이 동의하고 공개 판 화면(앱 principal)으로 notes 에 쓴다 · 초안이 새로 선언한 표도 물리로 생겨 있다
  await call("me_app_grant", { app_id: ID }, bob);
  const appBob = { ...bob, appId: ID, scopes: [] };
  const ins = await call("store_insert", { table: "notes", row: { text: "bob 의 메모" } }, appBob, { source: "app-ui" });
  const extraExists = (await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE $1`, [`%__extra`]))[0].n;
  chk("B8 공개 판의 표에 쓰기(남 · 앱 화면) · 초안이 새로 선언한 표도 만들어져 있다", ins.id != null && extraExists >= 1, JSON.stringify({ ins, extraExists }));

  // B9 — 초안이 notes 를 뺀다 → 공개 판(1판)이 아직 쓰므로 남는다 → 공개하면 데이터가 있어 보관된다
  const s9 = await call("app_save", { files: files(ID, "<p>v3 초안</p>", { title: "회의 안건 3", tables: ["extra"] }), note: "notes 뺌" }, alice, inSession("box-alice-1"));
  const qBob = await call("store_query", { table: "notes" }, appBob, { source: "app-ui" });
  //  격리 리뷰 B3 — 공개 판을 보는 사람의 자유 SQL · 표 목록도 공개 판 기준(초안이 뺀 notes 를 쓰고, 초안에만 있는 extra 는 그 사람 판에 없다)
  const sqlBob = await call("store_sql", { sql: "SELECT count(*)::int AS n FROM notes" }, appBob, { source: "app-ui" });
  const sqlBobExtra = await status(call("store_sql", { sql: "SELECT count(*)::int AS n FROM extra" }, appBob, { source: "app-ui" }));
  const tablesBob = (await call("store_tables", {}, appBob, { source: "app-ui" })).tables.map((t) => t.name);
  await call("me_app_grant", { app_id: ID }, alice);
  const tablesAlice = (await call("store_tables", {}, { ...alice, appId: ID, scopes: [] }, { source: "app-ui" })).tables.map((t) => t.name);
  const notesBefore = (await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE '%__notes' AND table_schema NOT LIKE '%archive%'`))[0].n;
  const p9 = await call("app_visibility_set", { app_id: ID, visibility: "all" }, alice);
  const notesAfter = (await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE '%__notes' AND table_schema NOT LIKE '%archive%'`))[0].n;
  //  보관 표 이름은 «물리 이름__시각» 이다(store-schema archivedTableName) — 꼬리까지 받는다.
  const archived = (await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE '%__notes%' AND table_schema LIKE '%archive%'`))[0].n;
  const notified = (await q(`SELECT count(*)::int AS n FROM org_app_notification WHERE app_id=$1 AND member_id='pgt-alice'`, [ID]))[0].n;
  r = await row(ID);
  chk("B9 초안이 뺀 표 — 공개 판이 쓰는 동안 남아 읽히고, 공개하면 데이터가 있어 보관 + 공개한 사람에게 알림",
    s9.state === "draft" && qBob.rows?.length === 1 && notesBefore === 1 && p9.changed === true && notesAfter === 0 && archived === 1 && notified >= 1
      && sqlBob.rows?.[0]?.n === 1 && sqlBobExtra !== 200 && tablesBob.join() === "notes" && tablesAlice.join() === "extra"
      && r.published_version_no === 3 && r.draft_by === null && (await ui(ID, bob)).includes("v3"),
    JSON.stringify({ s9: s9.state, qBob: qBob.rows?.length, notesBefore, notesAfter, archived, notified, pub: r.published_version_no, sqlBob: sqlBob.rows, sqlBobExtra, tablesBob, tablesAlice }));

  // B10 — 남(고치기 전원)이 고친 초안: 그 사람만 보고, 책임자는 공개 판을 보다가 공개한다
  const s10 = await call("app_save", { files: files(ID, "<p>v4 bob 초안</p>", { title: "회의 안건 3", tables: ["extra"] }), note: "bob 고침" }, bob, inSession("box-bob-1"));
  r = await row(ID);
  const v10 = [await ui(ID, bob), await ui(ID, alice), await ui(ID, carol)];
  const carolDeny = await status(call("app_visibility_set", { app_id: ID, visibility: "all" }, carol));
  const p10 = await call("app_visibility_set", { app_id: ID, visibility: "all" }, alice);
  chk("B10 남이 고친 초안 — 그 사람만 4판, 책임자·다른 사람은 3판 · 다른 구성원은 공개 못 함(403) · 책임자는 공개",
    s10.state === "draft" && r.draft_by === "pgt-bob" && r.build_session === "box-alice-1" && v10[0].includes("v4") && v10[1].includes("v3") && v10[2].includes("v3")
      && carolDeny === 403 && p10.changed === true && (await ui(ID, carol)).includes("v4"),
    JSON.stringify({ s10: s10.state, draft: r.draft_by, v10, carolDeny }));

  // B11 — 되돌리기 + 공개
  const rv = await call("app_revert", { app_id: ID, version_no: 1, publish: true }, alice);
  r = await row(ID);
  chk("B11 1판으로 되돌리며 공개 — 모두가 1판 · 초안 없음", rv.changed === true && rv.state === "published" && r.draft_by === null && (await ui(ID, carol)).includes("v1"),
    JSON.stringify({ rv: { changed: rv.changed, state: rv.state }, r: { draft: r.draft_by, pub: r.published_version_no } }));

  // B12 — 사본
  const PRIV = (await call("app_build_start", { session_id: "box-alice-2", title: "비밀 앱" }, alice)).app_id;
  await call("app_save", { files: files(PRIV, "<p>alice 비밀</p>") }, alice, inSession("box-alice-2"));
  const c12 = await call("app_save", { files: files("memo-copy", "<p>사본</p>"), origin_app_id: ID, note: "사본" }, bob);
  const c12row = (await listed(bob)).find((a) => a.id === "memo-copy");
  const c12bad = await status(call("app_save", { files: files("memo-copy2", "<p>사본2</p>"), origin_app_id: PRIV }, bob));
  chk("B12 사본 — 원본 앱을 서버가 기록(목록의 origin) · 만든 사람 = 사본 뜬 사람 · 나만 보는 앱으로 시작 · 못 보는 앱을 원본으로 주면 404",
    c12.created === true && (await row("memo-copy")).origin_app_id === ID && (await row("memo-copy")).made_by === "pgt-bob" && (await row("memo-copy")).visibility === "me"
      && c12row?.origin?.id === ID && c12row?.origin?.made_by === "pgt-alice" && c12bad === 404 && !(await row("memo-copy2")),
    JSON.stringify({ c12: c12.created, origin: c12row?.origin, c12bad }));

  // B13 — 공개 거두기: 붙여 둔 세션에서도 막힌다
  await call("session_app_attach", { app_id: ID, session_id: "box-bob-1" }, bob);
  //  (B9 에서 notes 는 보관됐고 B11 의 1판 되돌리기가 빈 notes 를 다시 만들었다 — 행 수가 아니라 «읽힌다» 를 본다)
  const before13 = Array.isArray((await call("store_query", { table: "notes", app_id: ID }, bob, inSession("box-bob-1"))).rows) ? "read" : "no";
  const bobUnpub = await status(call("app_visibility_set", { app_id: ID, visibility: "me" }, bob));
  const u13 = await call("app_visibility_set", { app_id: ID, visibility: "me" }, alice);
  const after13 = await status(call("store_query", { table: "notes", app_id: ID }, bob, inSession("box-bob-1")));
  chk("B13 공개 거두기 — 남은 못 거둠(403) · 책임자가 거두면 남에겐 다시 404(목록·화면·붙인 세션의 데이터까지)",
    before13 === "read" && bobUnpub === 403 && u13.changed === true && (await row(ID)).visibility === "me"
      && !(await listed(bob)).some((a) => a.id === ID) && (await status(call("org_app_ui", { app_id: ID }, bob))) === 404 && after13 === 404,
    JSON.stringify({ before13, bobUnpub, u13, after13 }));

  // B14 — 오래된 빈 예약은 새로 시작할 때 거둔다(남의 것·최근 것·내용 있는 것은 그대로)
  await q(`INSERT INTO org_app(id,title,version,manifest,source,status,enabled,installed_by,installed_at,visibility,made_by,owner_member,build_session)
             VALUES('old-empty','빈','0.0.0','{"id":"old-empty","title":"빈","version":"0.0.0"}','{"kind":"inline"}','active',true,'pgt-carol',now()-interval '4 days','me','pgt-carol','pgt-carol','box-carol-0')`);
  await q(`INSERT INTO org_app(id,title,version,manifest,source,status,enabled,installed_by,installed_at,visibility,made_by,owner_member,build_session)
             VALUES('new-empty','빈2','0.0.0','{"id":"new-empty","title":"빈2","version":"0.0.0"}','{"kind":"inline"}','active',true,'pgt-carol',now(),'me','pgt-carol','pgt-carol','box-carol-9')`);
  await call("app_build_start", { session_id: "box-carol-1", title: "새 것" }, carol);
  chk("B14 오래된 빈 예약(사흘 지남)만 거둔다 — 최근 빈 예약 · 남의 앱은 그대로", !(await row("old-empty")) && !!(await row("new-empty")) && !!(await row(ID)), "");

  // B15 — 떠난 사람
  const stub = { ...defaultReclaimDeps(), listSessions: async () => [], killCentral: async () => {}, killNode: async () => {}, deleteState: async () => {}, stopWorkers: async () => 0 };
  const rc = await reclaimMemberAppFootprint("pgt-alice", stub);
  r = await row(ID);
  const bossNote = (await q(`SELECT count(*)::int AS n FROM org_app_notification WHERE member_id='pgt-boss' AND app_id=$1`, [ID]))[0].n;
  const bobNote = (await q(`SELECT count(*)::int AS n FROM org_app_notification WHERE member_id='pgt-bob' AND title LIKE '%책임자%'`))[0].n;
  chk("B15 떠난 사람 — 그 사람이 책임지던 앱의 책임자만 관리자로(만든 사람 기록 그대로) · 관리자에게 알림 · 나만 보는 앱은 이제 관리자가 연다",
    (rc.apps_transferred ?? []).includes(ID) && (rc.apps_transferred ?? []).includes(PRIV) && r.owner_member === null && r.made_by === "pgt-alice"
      && bossNote >= 1 && bobNote === 0 && (await status(call("org_app_get", { app_id: PRIV }, boss))) === 200 && (await status(call("org_app_get", { app_id: PRIV }, bob))) === 404,
    JSON.stringify({ rc, owner: r.owner_member, made: r.made_by, bossNote, bobNote }));

  // B16 — 관리자가 책임자를 bob 으로 → bob 이 보고 지운다
  //  관리자 관문은 핸들러 밖(능력 표면의 scope — requireScope)이다. 여기선 그 선언을 본다.
  const notAdmin = cap("app_owner_set").scope === "admin" ? 403 : 200;
  await call("app_owner_set", { app_id: PRIV, member_id: "pgt-bob" }, boss);
  const seen16 = await status(call("org_app_get", { app_id: PRIV }, bob));
  const d16 = await call("app_draft_remove", { app_id: PRIV }, bob);
  const pubDel = await status(call("app_draft_remove", { app_id: "memo-copy" }, carol));
  chk("B16 관리자가 책임자를 바꾸면 새 책임자가 보고 지운다(나만 보는 앱) · 관리자 아닌 사람은 못 바꿈 · 남의 앱은 못 지움",
    notAdmin === 403 && seen16 === 200 && d16.removed === PRIV && !(await row(PRIV)) && (await row(PRIV + "")) === undefined && pubDel === 404,
    JSON.stringify({ notAdmin, seen16, d16, pubDel }));

  // B17 — 관리자 설치 앱(공개)
  const inst = await call("org_app_install", { source: { kind: "inline", files: files("crm-board", "<p>관리자 판</p>", { title: "CRM 보드" }) } }, boss);
  let c = await row("crm-board");
  const s17 = await call("app_save", { files: files("crm-board", "<p>bob 초안</p>", { title: "CRM 보드" }), note: "bob 고침" }, bob, inSession("box-bob-1"));
  c = await row("crm-board");
  const v17 = await call("app_versions", { app_id: "crm-board" }, boss);
  chk("B17 관리자 설치 앱은 공개 · 만든 사람 = 설치한 관리자 · 구성원이 고치면 그때의 공개 상태가 판(저장 전 상태)으로 못 박히고 관리자는 그 판을 본다",
    inst.created === true && c.visibility === "all" && c.made_by === "pgt-boss" && s17.state === "draft" && c.draft_by === "pgt-bob" && c.published_version_no === 1
      && v17.versions.find((v) => v.version_no === 1)?.note === "저장 전 상태" && (await ui("crm-board", boss)).includes("관리자 판") && (await ui("crm-board", bob)).includes("bob 초안"),
    JSON.stringify({ created: inst.created, vis: c.visibility, made: c.made_by, draft: c.draft_by, pub: c.published_version_no }));

  // B18 — #4632 시절에 생긴 'me' 앱(made_by · owner_member 가 빈 행 — 매니지드에 이미 있다): 다음 부팅의 채우기가 처음 설치한 사람을
  //  만든 사람 · 책임자로 잡는다. 매니페스트 studio.made_by(위조 가능)는 판정에 쓰지 않는다 — 그 칸에 적힌 사람도 남이면 404.
  await q(`INSERT INTO org_app(id,title,version,manifest,source,content_hash,status,enabled,installed_by,installed_at,visibility)
             VALUES('old-me','옛 나만','0.1.0','{"id":"old-me","title":"옛 나만","version":"0.1.0","studio":{"made_by":"pgt-carol"}}','{"kind":"inline"}','h-old','active',true,'pgt-alice',now(),'me')`);
  await q(`INSERT INTO org_app(id,title,version,manifest,source,content_hash,status,enabled,installed_by,installed_at,visibility)
             VALUES('old-gone','떠난 사람 앱','0.1.0','{"id":"old-gone","title":"떠난 사람 앱","version":"0.1.0"}','{"kind":"inline"}','h-gone','active',true,'pgt-gone',now(),'me')`);
  //  관리자가 «지정한 사람만» 으로 좁히며 만든 사람을 뺀 옛 앱 — 채우기가 책임자로 세우면 책임자 규칙으로 고치기가 다시 열린다(격리 리뷰 2-8b)
  await q(`INSERT INTO org_app(id,title,version,manifest,source,content_hash,status,enabled,installed_by,installed_at,visibility,edit_mode,edit_members)
             VALUES('old-locked','잠근 앱','0.1.0','{"id":"old-locked","title":"잠근 앱","version":"0.1.0"}','{"kind":"inline"}','h-locked','active',true,'pgt-alice',now(),'all','members','["pgt-bob"]')`);
  const { initAppRegistry } = await import(`${D}/org/schema/apps.js`);
  await initAppRegistry(itemsPool);
  const o18 = await row("old-me");
  const g18 = await row("old-gone");
  const l18 = await row("old-locked");
  const aliceLocked = await status(call("app_save", { files: files("old-locked", "<p>alice 고침</p>", { title: "잠근 앱" }) }, alice));
  const seen18 = { alice: await status(call("org_app_get", { app_id: "old-me" }, alice)), carol: await status(call("org_app_get", { app_id: "old-me" }, carol)), bob: await status(call("org_app_get", { app_id: "old-me" }, bob)) };
  const carolCanPub = await status(call("app_visibility_set", { app_id: "old-me", visibility: "all" }, carol));
  const pub18 = await call("app_visibility_set", { app_id: "old-me", visibility: "all" }, alice);
  chk("B18 #4632 시절 'me' 앱 — 채우기가 처음 설치한 사람을 책임자로 · 매니페스트 made_by 의 사람은 남(404) · 책임자가 공개하면 모두에게",
    o18.made_by === "pgt-alice" && o18.owner_member === "pgt-alice" && seen18.alice === 200 && seen18.carol === 404 && seen18.bob === 404
      && carolCanPub === 404 && pub18.changed === true && (await row("old-me")).visibility === "all" && (await status(call("org_app_get", { app_id: "old-me" }, bob))) === 200
      //  이미 떠난 사람이 설치한 앱 — 만든 사람은 남기고 책임자는 비운다(= 관리자) · 관리자 목록에 선다
      && g18.made_by === "pgt-gone" && g18.owner_member === null && (await listed(boss)).some((a) => a.id === "old-gone") && (await status(call("org_app_get", { app_id: "old-gone" }, bob))) === 404
      && l18.made_by === "pgt-alice" && l18.owner_member === null && aliceLocked === 403,
    JSON.stringify({ made: o18.made_by, owner: o18.owner_member, seen18, carolCanPub, pub18, gone: { made: g18.made_by, owner: g18.owner_member }, locked: { made: l18.made_by, owner: l18.owner_member, aliceLocked } }));

  // B19 — 격리 리뷰 B2: 초안이 걸린 공개 앱에 관리자가 새로 설치하면 — 초안 표식 · 공개 판 포인터를 걷고, 옛 공개 판에만 있던 표(데이터 있음)를
  //  보관하고, 밀려난 초안의 주인에게 알린다
  await call("org_app_install", { source: { kind: "inline", files: files("b19-app", "<p>관리자 1</p>", { title: "B19", tables: ["notes", "extra"] }) } }, boss);
  await call("me_app_grant", { app_id: "b19-app" }, carol);
  await call("store_insert", { table: "extra", row: { text: "carol 의 데이터" } }, { ...carol, appId: "b19-app", scopes: [] }, { source: "app-ui" });
  const s19 = await call("app_save", { files: files("b19-app", "<p>bob 초안</p>", { title: "B19", tables: ["notes"] }), note: "extra 뺌" }, bob);
  const extraKept = (await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'b19_app__extra' AND table_schema NOT LIKE '%archive%'`))[0].n;
  const bobNotesBefore = (await q(`SELECT count(*)::int AS n FROM org_app_notification WHERE app_id='b19-app' AND member_id='pgt-bob'`))[0].n;
  await call("org_app_install", { source: { kind: "inline", files: files("b19-app", "<p>관리자 2</p>", { title: "B19", tables: ["notes"] }) } }, boss);
  const r19 = await row("b19-app");
  const extraLive = (await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'b19_app__extra' AND table_schema NOT LIKE '%archive%'`))[0].n;
  const extraArchived = (await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE 'b19_app__extra%' AND table_schema LIKE '%archive%'`))[0].n;
  const bobNotesAfter = (await q(`SELECT count(*)::int AS n FROM org_app_notification WHERE app_id='b19-app' AND member_id='pgt-bob'`))[0].n;
  chk("B19 초안이 걸린 공개 앱에 관리자 설치 — 표식 · 포인터 걷힘 · 옛 공개 판에만 있던 표(데이터 있음)는 보관 · 밀려난 초안 주인에게 알림 · 모두 새 판",
    s19.state === "draft" && extraKept === 1 && r19.draft_by === null && r19.published_version_no === null && extraLive === 0 && extraArchived === 1
      && bobNotesAfter > bobNotesBefore && (await ui("b19-app", carol)).includes("관리자 2") && (await ui("b19-app", bob)).includes("관리자 2"),
    JSON.stringify({ s19: s19.state, extraKept, draft: r19.draft_by, pub: r19.published_version_no, extraLive, extraArchived, bobNotesBefore, bobNotesAfter }));

  // B20 — 격리 리뷰 NB-6 · NB-8: 남의 공개 전 판은 판 이력에 안 서고 되돌리기 대상도 아니다(책임자 · 관리자 · 그 사람은 본다) ·
  //  못 박는 «저장 전 상태» 판의 저장한 사람은 고치러 온 사람이 아니라 그 내용을 깐 사람
  const s20 = await call("app_save", { files: files("b19-app", "<p>carol 초안</p>", { title: "B19", tables: ["notes"] }), note: "carol 고침" }, carol);
  const r20 = await row("b19-app");
  const pin20 = (await call("app_versions", { app_id: "b19-app" }, boss)).versions.find((v) => v.version_no === r20.published_version_no);
  const seen20 = async (u) => (await call("app_versions", { app_id: "b19-app" }, u)).versions.map((v) => v.version_no);
  const [vb, vc, vboss] = [await seen20(bob), await seen20(carol), await seen20(boss)];
  const bobRevert = await status(call("app_revert", { app_id: "b19-app", version_no: s20.version_no, publish: true }, bob));
  const r20b = await row("b19-app");
  chk("B20 남의 공개 전 판 — 판 이력에서 남에겐 안 보이고(그 사람 · 관리자는 봄) 되돌려 공개할 수 없다(404) · 못 박은 판의 저장한 사람은 관리자",
    s20.state === "draft" && r20.draft_by === "pgt-carol" && pin20?.saved_by === "pgt-boss" && !vb.includes(s20.version_no) && vc.includes(s20.version_no) && vboss.includes(s20.version_no)
      && bobRevert === 404 && r20b.draft_by === "pgt-carol" && (await ui("b19-app", bob)).includes("관리자 2"),
    JSON.stringify({ s20: s20.state, draft: r20.draft_by, pinBy: pin20?.saved_by, vb, vc, vboss, bobRevert, after: r20b.draft_by }));

  // B21 — 격리 리뷰 2-1 · 2-3: 관리자 설치가 같은 id 의 남의 나만 보는 앱을 덮지 않는다(409) · 초안이 걸린 공개 앱은 「나만」 으로 못 내린다(409 — 남의 초안이
  //  책임자의 유일한 판이 되지 않게) · 공개 판으로 되돌린 뒤엔 내린다
  await call("app_save", { files: files("bob-own", "<p>bob 의 앱</p>", { title: "bob 앱" }) }, bob);
  const overInstall = await status(call("org_app_install", { source: { kind: "inline", files: files("bob-own", "<p>관리자 덮기</p>", { title: "덮기" }) } }, boss));
  const bobOwn = await row("bob-own");
  const meWhileDraft = await status(call("app_visibility_set", { app_id: "b19-app", visibility: "me" }, boss));
  const pubNo21 = (await row("b19-app")).published_version_no;
  await call("app_revert", { app_id: "b19-app", version_no: pubNo21 }, boss);
  const r21 = await row("b19-app");
  const meAfter = await call("app_visibility_set", { app_id: "b19-app", visibility: "me" }, boss);
  chk("B21 관리자 설치는 남의 나만 보는 앱을 못 덮는다(409 · 내용 그대로) · 초안이 걸린 공개 앱은 「나만」 불가(409) → 공개 판으로 되돌리면 초안이 걷히고 내려진다",
    overInstall === 409 && bobOwn.visibility === "me" && (await ui("bob-own", bob)).includes("bob 의 앱") && meWhileDraft === 409
      && r21.draft_by === null && meAfter.changed === true && (await row("b19-app")).visibility === "me",
    JSON.stringify({ overInstall, bobOwnVis: bobOwn.visibility, meWhileDraft, pubNo21, draftAfterRevert: r21.draft_by, meAfter }));
  // ── B22 공개 판을 깨는 초안 저장 ──
  {
    const GID = "guard-app";
    const gfiles = (cols, extra = {}) => [{ path: "lively-app.json", content: JSON.stringify({ id: GID, title: "가드", version: "0.1.0",
      permissions: { scopes: [], tools: ["store_insert", "store_query"] },
      data: { tables: [{ name: "items", columns: cols, ...extra }] }, ui: { pages: [{ key: "main", title: "가드", entry: "ui/index.html" }] } }) },
      { path: "ui/index.html", content: "<p>g</p>" }];
    const base = [{ name: "title", type: "text" }, { name: "code", type: "text" }];
    const colsNow = async () => (await q(`SELECT attname FROM pg_attribute WHERE attrelid = to_regclass('app.guard_app__items') AND attnum > 0 AND NOT attisdropped ORDER BY attnum`)).map((r) => r.attname).join(",");
    await call("app_save", { files: gfiles(base) }, alice);
    const g3 = await status(call("app_save", { files: gfiles([base[0]], { drop_columns: ["code"] }) }, alice));
    const afterG3 = await colsNow();
    chk("B22 G3 나만 보는 앱(공개 판 없음) — 칸 지우기 저장이 된다(가드 없음)", g3 === 200 && afterG3 === "tenant_id,id,title,created_at", JSON.stringify({ g3, afterG3 }));
    await call("app_save", { files: gfiles(base) }, alice);
    await call("app_visibility_set", { app_id: GID, visibility: "all" }, alice);
    const before = await row(GID), colsBefore = await colsNow();
    const g1 = await errOf(call("app_save", { files: gfiles([base[0]], { drop_columns: ["code"] }) }, alice));
    const g1b = await errOf(call("app_save", { files: gfiles([base[0], { name: "code", type: "bigint" }]) }, alice));
    const after = await row(GID), colsAfter = await colsNow();
    chk("B22 G1 공개 앱에 칸 지우기 · 형 바꾸기를 초안으로만 저장 — 409(무엇이 깨지는지 · publish:true 안내) · 초안 표식·판·표 그대로",
      g1?.status === 409 && /칸 지우기 items\.code/.test(g1?.message ?? "") && /publish:true/.test(g1?.message ?? "")
        && g1b?.status === 409 && /형 바꾸기 items\.code \(text → bigint\)/.test(g1b?.message ?? "")
        && after.draft_by === before.draft_by && after.current_version_no === before.current_version_no && colsAfter === colsBefore && colsAfter.includes("code"),
      JSON.stringify({ g1: [g1?.status, g1?.message], g1b: [g1b?.status, g1b?.message], before: [before.draft_by, before.current_version_no], after: [after.draft_by, after.current_version_no], colsAfter }));
    const g2 = await status(call("app_save", { files: gfiles([base[0]], { drop_columns: ["code"] }), publish: true }, alice));
    const pub = await row(GID), colsPub = await colsNow();
    chk("B22 G2 같은 변경을 publish:true 로 — 된다 · 칸이 지워지고 초안 없이 공개 판이 된다", g2 === 200 && !colsPub.includes("code") && pub.draft_by === null && pub.visibility === "all",
      JSON.stringify({ g2, colsPub, draft_by: pub.draft_by, visibility: pub.visibility }));
  }
} catch (e) {
  fail++; console.error("FAIL 예외 —", e?.stack ?? e);
} finally {
  await itemsPool.end().catch(() => {});
  await dbc.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end().catch(() => {});
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
