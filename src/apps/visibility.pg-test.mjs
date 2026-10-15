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
//  B22 #4724 초안 = 개인 대상 프로덕션 — 공개 판이 쓰는 칸을 깨는 표 변경(칸 지우기 · 조이기 …)은 초안 저장 때 미루고 공개할 때 적용 ·
//      새 칸은 바로 · 공개 때 데이터가 어긋나면 409 · 어느 표도 안 바뀜(한 트랜잭션) · 되돌리기도 같은 규칙 · 나만 보는 앱은 바로 ·
//      publish:true 의 이름 바꾸기 + unique(G8) · 공개 단계 409 면 «초안으로 저장했다» 안내(G9) · 풀었다가 같은 파일로 되돌린 저장은 초안으로 남고
//      공개 판 사용자의 자유 SQL 은 막히지 않는다(G10)
//  B23 #4732 공개 미리 보기 — 할 일 0(나만 보는 앱 · 초안 없음 · 기본 앱) · 남의 초안을 책임자 · 관리자가 본다(칸 지우기 · 행 수 · 꼭 채우기 · 옛 표 정리) ·
//      그 밖의 구성원 403 · 못 보는 앱 404 · 빈 앱 409 · 빈 행이면 막힘 · 다른 연결이 표를 쥐면 짧게 기다리고 «다 못 봄» · 미리 보기 == 실제 공개 ·
//      전후 카탈로그 · 데이터 · 앱 행 같음 · 판 번호(되돌려 공개) · 없는 판 · 남의 공개 전 판 404 · 전체 시간 상한(E9c) · 설치 락이 바쁘면 짧게(E17) ·
//      정리할 표 세기도 짧게(E18) · 선언에서만 뺀 칸은 «알아 둘 것» 만(E15b) · 되돌려 공개의 실제 결과 == 미리 본 것(E16)
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
  // ── B22 #4724 초안 = 개인 대상 프로덕션 — 공개 판이 쓰는 칸을 깨는 표 변경은 공개할 때 ──
  {
    const GID = "guard-app";
    const man = (tables) => JSON.stringify({ id: GID, title: "가드", version: "0.1.0",
      permissions: { scopes: [], tools: ["store_insert", "store_query"] },
      data: { tables }, ui: { pages: [{ key: "main", title: "가드", entry: "ui/index.html" }] } });
    const gfiles = (tables, html) => [{ path: "lively-app.json", content: man(tables) }, { path: "ui/index.html", content: html }];
    const colsOf = async (t) => (await q(`SELECT attname FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped ORDER BY attnum`, [`app.guard_app__${t}`])).map((r) => r.attname).join(",");
    const notNull = async (t, c) => (await q(`SELECT attnotnull AS nn FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = $2`, [`app.guard_app__${t}`, c]))[0]?.nn === true;
    const archivedOf = async (t) => (await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema LIKE '%archive%' AND table_name LIKE $1`, [`guard_app__${t}%`]))[0].n;
    const changesOf = (list) => (list ?? []).map((d) => d.change).sort().join(" | ");
    const P = [{ name: "logs", columns: [{ name: "msg", type: "text" }, { name: "lvl", type: "text" }] },
      { name: "items", columns: [{ name: "title", type: "text" }, { name: "code", type: "text" }] }];
    //  초안 D1 — logs.lvl 지우기 · items.code 지우기 · items.title 조이기(not_null) · items.note 새 칸. logs 를 먼저 선언한다(공개 때 앞 표가 먼저 돈다).
    const D1 = [{ name: "logs", columns: [{ name: "msg", type: "text" }], drop_columns: ["lvl"] },
      { name: "items", columns: [{ name: "title", type: "text", not_null: true }, { name: "note", type: "text" }], drop_columns: ["code"] }];

    // G0 나만 보는 앱(공개 판 없음) — 깨는 변경도 저장 때 바로(지킬 판이 없다)
    await call("app_save", { files: gfiles(P, "<p>g0</p>") }, alice);
    const g0 = await call("app_save", { files: gfiles([P[0], { name: "items", columns: [P[1].columns[0]], drop_columns: ["code"] }], "<p>g0b</p>") }, alice);
    const g0cols = await colsOf("items");
    chk("B22 G0 나만 보는 앱 — 칸 지우기가 저장 때 바로 된다 · 미룬 것 없음", g0.state === "me" && g0cols === "tenant_id,id,title,created_at" && !(g0.tables?.deferred ?? []).length,
      JSON.stringify({ state: g0.state, g0cols, deferred: g0.tables?.deferred }));

    // 공개 판 P(1) — bob 이 공개 판으로 쓴다
    await call("app_save", { files: gfiles(P, "<p>pub-P</p>") }, alice);
    await call("app_visibility_set", { app_id: GID, visibility: "all" }, alice);
    await call("me_app_grant", { app_id: GID }, bob);
    await call("me_app_grant", { app_id: GID }, alice);
    const appBob = { ...bob, appId: GID, scopes: [] }, appAlice = { ...alice, appId: GID, scopes: [] };
    const asApp = (n, input, who) => call(n, input, who, { source: "app-ui" });
    await asApp("store_insert", { table: "items", row: { title: "bob 1", code: "C1" } }, appBob);
    await asApp("store_insert", { table: "logs", row: { msg: "m1", lvl: "info" } }, appBob);
    const pubNo = (await row(GID)).published_version_no;

    // G1 공개 앱에 깨는 변경을 초안으로 저장 — 저장된다(409 아님) · 깨는 변경은 미룬다 · 새 칸은 바로 · 공개 판 사용자는 옛 칸으로 그대로
    const g1 = await call("app_save", { files: gfiles(D1, "<p>draft-D1</p>") }, alice);
    const r1 = await row(GID);
    const g1cols = { items: await colsOf("items"), logs: await colsOf("logs"), titleNN: await notNull("items", "title") };
    const bobIns = await status(asApp("store_insert", { table: "items", row: { code: "C2" } }, appBob));   // 제목 없이(공개 판은 title 이 비어도 된다)
    const bobRead = (await asApp("store_query", { table: "items" }, appBob)).rows ?? [];
    const bobLog = await status(asApp("store_insert", { table: "logs", row: { msg: "m2", lvl: "warn" } }, appBob));
    const aliceIns = await status(asApp("store_insert", { table: "items", row: { title: "alice 1", note: "N1" } }, appAlice));
    const aliceRead = (await asApp("store_query", { table: "items" }, appAlice)).rows ?? [];
    const wantDeferred = ["not_null 더하기 items.title", "칸 지우기 items.code", "칸 지우기 logs.lvl"].sort().join(" | ");
    chk("B22 G1 공개 앱에 깨는 변경을 초안으로 저장 — 200 · 초안 · 미룬 변경 3개(응답 · 안내) · 새 칸 note 는 바로 · 옛 칸 · 조이기 그대로",
      g1.state === "draft" && r1.draft_by === "pgt-alice" && r1.published_version_no === pubNo
        && changesOf(g1.tables?.deferred) === wantDeferred && /공개할 때 반영할 표 변경 3개/.test(g1.hint ?? "") && /drop_columns/.test(g1.hint ?? "")
        && g1cols.items === "tenant_id,id,title,created_at,code,note"   /* code 는 G0 에서 지웠다가 다시 더해 뒤에 선다 */ && g1cols.logs === "tenant_id,id,msg,lvl,created_at" && g1cols.titleNN === false,
      JSON.stringify({ state: g1.state, deferred: g1.tables?.deferred, hint: g1.hint, g1cols }));
    chk("B22 G1b 공개 판 사용자(bob)는 옛 코드 그대로 읽고 쓴다(code · lvl · 빈 title) · 초안 작성자(alice)는 새 칸 note 를 바로 쓴다 · 화면도 각자 판",
      bobIns === 200 && bobLog === 200 && bobRead.some((x) => x.code === "C1") && bobRead.some((x) => x.code === "C2" && x.title == null)
        && aliceIns === 200 && aliceRead.some((x) => x.note === "N1") && (await ui(GID, bob)).includes("pub-P") && (await ui(GID, alice)).includes("draft-D1"),
      JSON.stringify({ bobIns, bobLog, bobRead, aliceIns, aliceRead }));

    // G1c 공개 판 행을 못 읽는 순간(없는 판을 가리킴)에 표 보장이 돌아도(자유 SQL 의 역할 준비) 지금 있는 칸 전부를 지킨다 — 미룬 변경이 새지 않는다
    await q(`UPDATE org_app SET published_version_no = 99999 WHERE id = $1`, [GID]);
    const g1c = await status(asApp("store_sql", { sql: "SELECT count(*)::int AS n FROM items" }, appAlice));
    const g1cCols = { items: await colsOf("items"), logs: await colsOf("logs"), titleNN: await notNull("items", "title") };
    await q(`UPDATE org_app SET published_version_no = $2 WHERE id = $1`, [GID, pubNo]);
    chk("B22 G1c 공개 판 행을 못 읽어도 표 보장은 있는 칸을 지킨다 — code · lvl 그대로 · title 안 조임",
      g1c === 200 && g1cCols.items.includes("code") && g1cCols.logs.includes("lvl") && g1cCols.titleNN === false,
      JSON.stringify({ g1c, g1cCols }));

    // G3 공개할 때 데이터가 새 규칙에 어긋남(제목 빈 행) — 409(몇 행인지) · 공개 안 함 · 어느 표도 안 바뀜(앞 표 logs 의 칸 지우기까지 되돌림) · 초안 그대로
    const g3 = await errOf(call("app_visibility_set", { app_id: GID, visibility: "all" }, alice));
    const r3 = await row(GID);
    const g3cols = { items: await colsOf("items"), logs: await colsOf("logs"), titleNN: await notNull("items", "title"), logsArchived: await archivedOf("logs") };
    const bobAfter3 = await status(asApp("store_insert", { table: "logs", row: { msg: "m3", lvl: "debug" } }, appBob));
    chk("B22 G3 공개 때 데이터가 어긋나면 409(행 수) · 공개 판 · 초안 표식 그대로 · logs.lvl 도 안 지워짐(한 트랜잭션) · 보관 표도 안 생김 · 공개 판 쓰기 계속",
      g3?.status === 409 && /items\.title/.test(g3?.message ?? "") && /1개/.test(g3?.message ?? "") && /어느 표도 바뀌지 않았습니다/.test(g3?.message ?? "")
        && r3.published_version_no === pubNo && r3.draft_by === "pgt-alice"
        && g3cols.items.includes("code") && g3cols.logs.includes("lvl") && g3cols.titleNN === false && g3cols.logsArchived === 0
        && bobAfter3 === 200 && (await ui(GID, bob)).includes("pub-P"),
      JSON.stringify({ g3: [g3?.status, g3?.message], pub: [r3.published_version_no, pubNo], draft: r3.draft_by, g3cols, bobAfter3 }));

    // G2 빈 제목을 채우고 다시 공개 — 미룬 변경이 적용된다 · 데이터는 남는다(지운 칸의 값은 보관) · 모두가 새 판
    await q(`UPDATE app.guard_app__items SET title = '고침' WHERE title IS NULL`);
    const g2 = await call("app_visibility_set", { app_id: GID, visibility: "all" }, alice);
    const r2 = await row(GID);
    const g2cols = { items: await colsOf("items"), logs: await colsOf("logs"), titleNN: await notNull("items", "title") };
    const kept = (await q(`SELECT title, note FROM app.guard_app__items ORDER BY id`)).map((x) => x.title).join(",");
    const archCode = (await q(`SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_schema LIKE '%archive%' AND table_name LIKE 'guard_app__items%'`))[0]?.t;
    const archVals = archCode ? (await q(`SELECT value FROM ${archCode.split(".").map((x) => `"${x}"`).join(".")} ORDER BY id`)).map((x) => x.value).join(",") : null;
    const bobNow = await status(asApp("store_insert", { table: "items", row: { title: "bob 3", note: "N2" } }, appBob));
    const applied = g2.tables ?? {};
    chk("B22 G2 공개하면 미룬 변경 적용 — code · lvl 지워짐 · title not_null · 행 그대로 · 지운 칸 값 보관(C1,C2) · 응답에 한 일 · 모두가 새 판 · bob 이 note 를 쓴다",
      g2.changed === true && r2.draft_by === null && r2.published_version_no !== pubNo
        && g2cols.items === "tenant_id,id,title,created_at,note" && g2cols.logs === "tenant_id,id,msg,created_at" && g2cols.titleNN === true
        && kept === "bob 1,고침,alice 1" && archVals === "C1,C2"
        && (applied.dropped_columns ?? []).map((d) => `${d.table}.${d.column}`).sort().join(",") === "items.code,logs.lvl"
        && bobNow === 200 && (await ui(GID, bob)).includes("draft-D1"),
      JSON.stringify({ changed: g2.changed, r2: [r2.draft_by, r2.published_version_no], g2cols, kept, archCode, archVals, applied: applied.dropped_columns, bobNow }));

    // G6 되돌리기도 같은 규칙 — 공개 판(D1)이 쓰는 note 를 지우는 판 D2 로 되돌리면(공개 없이) 미룬다
    const D2 = [D1[0], { name: "items", columns: [D1[1].columns[0]], drop_columns: ["code", "note"] }];
    const s2 = await call("app_save", { files: gfiles(D2, "<p>draft-D2</p>") }, alice);
    await call("app_save", { files: gfiles(D1, "<p>draft-D1b</p>") }, alice);
    const rv = await call("app_revert", { app_id: GID, version_no: s2.version_no }, alice);
    const g6cols = await colsOf("items");
    chk("B22 G6 되돌리기(공개 없이)도 공개 판의 칸을 지킨다 — note 지우기는 미룸(응답 deferred) · 칸 그대로",
      changesOf(s2.tables?.deferred) === "칸 지우기 items.note" && rv.state === "draft" && changesOf(rv.deferred) === "칸 지우기 items.note" && g6cols.includes("note"),
      JSON.stringify({ s2: s2.tables?.deferred, rv: { state: rv.state, deferred: rv.deferred }, g6cols }));

    // G7 publish:true 로 저장 — 미룰 것 없이 바로 공개 · 적용(응답의 미룬 목록은 비고, 한 일은 보고서에)
    const g7 = await call("app_save", { files: gfiles(D2, "<p>pub-D2</p>"), publish: true }, alice);
    const g7cols = await colsOf("items");
    chk("B22 G7 publish:true 저장 — 깨는 변경도 그 자리에서 적용 · 미룬 목록 비움 · 모두가 새 판",
      g7.state === "published" && !g7cols.includes("note") && !(g7.tables?.deferred ?? []).length
        && (g7.tables?.dropped_columns ?? []).some((d) => d.table === "items" && d.column === "note") && (await ui(GID, bob)).includes("pub-D2"),
      JSON.stringify({ state: g7.state, g7cols, deferred: g7.tables?.deferred, dropped: g7.tables?.dropped_columns }));

    // G8 publish:true 로 이름 바꾸기 + unique(칸 선언을 통째로 옮겨 이름만 바꾼 꼴 — 격리 리뷰 차단 재현) — 오류 없이 바로 공개 · 이름 바뀜 · unique
    const H = [D1[0], { name: "items", columns: [{ name: "headline", type: "text", not_null: true, unique: true, renamed_from: "title" }] }];
    const g8 = await errOf(call("app_save", { files: gfiles(H, "<p>pub-H</p>"), publish: true }, alice));
    const g8cols = await colsOf("items");
    const g8dup = await status(asApp("store_insert", { table: "items", row: { headline: "bob 1" } }, appBob));
    chk("B22 G8 publish:true 이름 바꾸기 + unique — 오류 없이 공개 · title → headline · 겹치는 값은 막힌다",
      g8 === null && g8cols.includes("headline") && !g8cols.includes("title") && g8dup !== 200 && (await row(GID)).draft_by === null && (await ui(GID, bob)).includes("pub-H"),
      JSON.stringify({ g8: [g8?.status, g8?.message], g8cols, g8dup }));

    // G9 publish:true 인데 공개 단계가 데이터 때문에 409 — «초안으로는 저장됐다» 를 말한다 · 초안이 깔려 있다 · 공개 판 그대로
    const pubBefore9 = (await row(GID)).published_version_no;
    const C = [D1[0], { name: "items", columns: [{ name: "headline", type: "text", not_null: true, unique: true, check: "length(headline) > 5" }] }];
    const g9 = await errOf(call("app_save", { files: gfiles(C, "<p>draft-C</p>"), publish: true }, alice));
    const r9 = await row(GID);
    chk("B22 G9 publish:true 의 공개가 데이터로 409 — 문구가 «초안으로 저장했습니다 — 공개는 하지 못했습니다» · 초안 표식 · 공개 판 그대로 · 화면도 각자 판",
      g9?.status === 409 && /판을 초안으로 저장했습니다/.test(g9?.message ?? "") && /공개는 하지 못했습니다/.test(g9?.message ?? "") && /length\(headline\) > 5/.test(g9?.message ?? "")
        && r9.draft_by === "pgt-alice" && r9.published_version_no === pubBefore9 && (await ui(GID, alice)).includes("draft-C") && (await ui(GID, bob)).includes("pub-H"),
      JSON.stringify({ g9: [g9?.status, g9?.message], draft: r9.draft_by, pub: [r9.published_version_no, pubBefore9] }));
  }
  // G10 초안에서 not_null 을 풀고(바로) 빈 행이 생긴 뒤 공개 판과 같은 파일로 다시 저장 — 다시 조이기가 미뤄져 있으므로 초안으로 남는다 ·
  //  그사이 공개 판 사용자의 자유 SQL 은 막히지 않는다(지연 맞추기는 조이지 않는다) · 공개하면 409(빈 행) → 채우면 된다(격리 리뷰 재검토 (a))
  {
    const G2 = "guard2-app";
    const man2 = (cols) => JSON.stringify({ id: G2, title: "가드2", version: "0.1.0", permissions: { scopes: [], tools: ["store_insert", "store_query", "store_sql"] },
      data: { tables: [{ name: "items", columns: cols }] }, ui: { pages: [{ key: "main", title: "가드2", entry: "ui/index.html" }] } });
    const files2 = (cols, html) => [{ path: "lively-app.json", content: man2(cols) }, { path: "ui/index.html", content: html }];
    const PUB = [{ name: "title", type: "text", not_null: true }];
    const titleNN = async () => (await q(`SELECT attnotnull AS nn FROM pg_attribute WHERE attrelid = to_regclass('app.guard2_app__items') AND attname = 'title'`))[0]?.nn === true;
    await call("app_save", { files: files2(PUB, "<p>p</p>") }, alice);
    await call("app_visibility_set", { app_id: G2, visibility: "all" }, alice);
    await call("me_app_grant", { app_id: G2 }, bob);
    const bob2 = { ...bob, appId: G2, scopes: [] };
    await call("app_save", { files: files2([{ name: "title", type: "text" }], "<p>d</p>") }, alice);     // not_null 풀기 — 바로
    const relaxed = !(await titleNN());
    await q(`INSERT INTO app.guard2_app__items(title) VALUES (NULL)`);                                    // 누구든 빈 행을 남겼다
    const g10 = await call("app_save", { files: files2(PUB, "<p>p</p>") }, alice);                        // 공개 판과 같은 파일
    const r10 = await row(G2);
    const sql10 = await status(call("store_sql", { sql: "SELECT count(*)::int AS n FROM items" }, bob2, { source: "app-ui" }));
    const pub10 = await errOf(call("app_visibility_set", { app_id: G2, visibility: "all" }, alice));
    await q(`UPDATE app.guard2_app__items SET title = '채움' WHERE title IS NULL`);
    const pub10b = await call("app_visibility_set", { app_id: G2, visibility: "all" }, alice);
    chk("B22 G10 풀었다가 공개 판과 같은 파일로 다시 저장 — 다시 조이기가 미뤄져 초안으로 남는다 · 공개 판 사용자의 자유 SQL 은 된다 · 공개는 빈 행이면 409 → 채우면 not_null",
      relaxed && g10.state === "draft" && (g10.tables?.deferred ?? []).some((d) => d.change === "not_null 더하기 items.title") && r10.draft_by === "pgt-alice"
        && sql10 === 200 && pub10?.status === 409 && /1개/.test(pub10?.message ?? "") && pub10b.changed === true && (await titleNN()) && (await row(G2)).draft_by === null,
      JSON.stringify({ relaxed, g10: [g10.state, g10.tables?.deferred], draft: r10.draft_by, sql10, pub10: [pub10?.status, pub10?.message], pub10b: pub10b.changed }));
  }
  // ── B23 #4732 공개 미리 보기 — 「공개하기」 · 「이 판으로」 전에 표에 할 일 · 아무것도 바꾸지 않는다 · 실제 공개와 같다 · 잠금은 짧게 ──
  {
    const PV = "pv-app";
    const pman = (id, tables) => JSON.stringify({ id, title: "미리 보기", version: "0.1.0", permissions: { scopes: [], tools: ["store_insert", "store_query"] },
      data: { tables }, ui: { pages: [{ key: "main", title: "미리 보기", entry: "ui/index.html" }] } });
    const pfiles = (tables, html, id = PV) => [{ path: "lively-app.json", content: pman(id, tables) }, { path: "ui/index.html", content: html }];
    const preview = (who, input = {}, id = PV) => call("app_publish_preview", { app_id: id, ...input }, who);
    const rel = (t) => `app.pv_app__${t}`;
    const has = (lines, want) => want.every((w) => (lines ?? []).includes(w));
    //  카탈로그(칸 · 형 · not_null · 기본값 · 제약 · 인덱스 · 앱/보관 스키마의 모든 관계) · 데이터 · 앱 행 · 판 행 수 — 미리 보기 전후가 같아야 한다(E6)
    const fingerprint = async () => JSON.stringify({
      cols: await q(`SELECT c.relname AS t, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS ty, a.attnotnull AS nn, pg_get_expr(d.adbin, d.adrelid) AS def
                       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                       LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
                      WHERE n.nspname IN ('app', 'app_archive') AND c.relkind = 'r' ORDER BY 1, 2`),
      cons: await q(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                      WHERE connamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('app', 'app_archive')) ORDER BY 1, 2`),
      idx: await q(`SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes WHERE schemaname IN ('app', 'app_archive') ORDER BY 1, 2, 3`),
      rels: await q(`SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('app', 'app_archive') ORDER BY 1, 2`),
      items: await q(`SELECT * FROM ${rel("items")} ORDER BY id`).catch(() => "없음"),
      logs: await q(`SELECT * FROM ${rel("logs")} ORDER BY id`).catch(() => "없음"),
      arc: await q(`SELECT * FROM ${rel("arc")} ORDER BY id`).catch(() => "없음"),
      app: await q(`SELECT current_version_no, draft_by, published_version_no, visibility, content_hash FROM org_app WHERE id = $1`, [PV]),
      versions: await q(`SELECT count(*)::int AS n FROM org_app_version WHERE app_id = $1`, [PV]),
    });
    const P = [
      { name: "items", columns: [{ name: "title", type: "text" }, { name: "code", type: "text" }, { name: "memo", type: "text" }] },
      { name: "logs", columns: [{ name: "msg", type: "text" }, { name: "lvl", type: "text" }] },
      { name: "arc", columns: [{ name: "y", type: "text" }] },
      { name: "tmp", columns: [{ name: "x", type: "text" }] },
    ];
    //  초안 D — items: title 꼭 채우기 · code(값 2행) · memo(값 0행 — 경계) 지우기 · 새 칸 note / logs: lvl(값 1행) 지우기 / arc(1행) · tmp(빈 표) 빼기
    const D = [
      { name: "items", columns: [{ name: "title", type: "text", not_null: true }, { name: "note", type: "text" }], drop_columns: ["code", "memo"] },
      { name: "logs", columns: [{ name: "msg", type: "text" }], drop_columns: ["lvl"] },
    ];

    // E11 첫 판이 없는 빈 앱 — 공개와 같은 409
    const e11 = await call("app_build_start", { session_id: "box-carol-1", title: "빈 앱" }, carol);
    const e11p = await errOf(call("app_publish_preview", { app_id: e11.app_id }, carol));
    chk("B23 E11 첫 판이 없는 빈 앱 — 미리 보기도 공개처럼 409", e11p?.status === 409, String(e11p?.message));

    // E1 나만 보는 앱(첫 공개 전) — 할 일 0
    await call("app_save", { files: pfiles(P, "<p>pv-P</p>"), note: "P" }, alice);
    const e1 = await preview(alice);
    chk("B23 E1 나만 보는 앱(첫 공개 전) — 할 일 0 · 막힘 0", e1.kind === "publish" && e1.changes.length === 0 && e1.blocked.length === 0 && e1.incomplete === null && e1.tables === null,
      JSON.stringify(e1));
    // E8c 못 보는 앱 — 404
    chk("B23 E8c 못 보는 앱(남의 나만 보는 앱) — 404", (await status(preview(carol))) === 404);

    // 공개 — bob 이 공개 판으로 쓴다
    await call("app_visibility_set", { app_id: PV, visibility: "all" }, alice);
    await call("me_app_grant", { app_id: PV }, bob);
    const pvBob = { ...bob, appId: PV, scopes: [] };
    const ins = (t, r) => call("store_insert", { table: t, row: r }, pvBob, { source: "app-ui" });
    await ins("items", { title: "a", code: "C1" }); await ins("items", { title: "b", code: "C2" }); await ins("items", { title: "c" });
    await ins("logs", { msg: "m1", lvl: "info" }); await ins("logs", { msg: "m2" });
    await ins("arc", { y: "남길 값" });
    const pNo = (await row(PV)).published_version_no;
    // E2 공개 앱 · 초안 없음 — 할 일 0
    const e2 = await preview(alice);
    chk("B23 E2 공개 앱 · 초안 없음 — 할 일 0", e2.changes.length === 0 && e2.blocked.length === 0 && e2.published_version_no === pNo, JSON.stringify(e2));

    // bob 이 깨는 변경을 초안으로 저장 — 미뤄진다(#4724)
    const sD = await call("app_save", { files: pfiles(D, "<p>pv-D</p>"), note: "D" }, bob);
    // E8 · E8b 누가 보나 — 초안 쓴 사람 · 책임자 · 관리자는 보고, 그 밖의 구성원은 공개처럼 403
    const e8 = await errOf(preview(carol));
    const f0 = await fingerprint();
    const byOwner = await preview(alice), byAdmin = await preview(boss), byDrafter = await preview(bob);
    const f1 = await fingerprint();
    const want3 = [
      "items 표: code 칸 지우기 — 값이 있는 2행은 따로 보관(앱에서는 더 안 보임)",
      "items 표: memo 칸 지우기(값 없음)",
      "items 표: title 칸을 꼭 채워야 하게 바꿈",
      "logs 표: lvl 칸 지우기 — 값이 있는 1행은 따로 보관(앱에서는 더 안 보임)",
      "arc 표 따로 보관 — 새 판에 없음 · 1행(앱에서는 더 안 보임)",
      "tmp 표 지우기 — 새 판에 없고 비어 있음",
    ];
    chk("B23 E8 초안 쓴 사람도 책임자도 관리자도 아닌 구성원 — 403(공개와 같은 판정)", sD.state === "draft" && e8?.status === 403, JSON.stringify({ sD: sD.state, e8: [e8?.status, e8?.message] }));
    chk("B23 E3 · E8b · E13 남(bob)의 초안을 책임자 · 관리자 · 쓴 사람이 본다 — 칸 지우기(값 2행 · 값 없음) · 꼭 채우기 · 옛 판의 표 보관/지움 · 막힘 0 · 새 칸 note 는 이미 됐으니 없음",
      [byOwner, byAdmin, byDrafter].every((p) => p.kind === "publish" && has(p.changes, want3) && p.changes.length === want3.length && p.blocked.length === 0 && p.incomplete === null)
        && byOwner.published_version_no === pNo && byOwner.version_no === (await row(PV)).current_version_no
        && byOwner.gone_tables.map((g) => `${g.table}:${g.action}:${g.rows}`).sort().join() === "arc:archive:1,tmp:drop:0"
        && (byOwner.tables?.dropped_columns ?? []).length === 3 && byOwner.tables.dropped_columns.every((d) => d.archived_as === null),   // 보관 자리 이름은 공개할 때 정해진다
      JSON.stringify({ byOwner, byAdmin: byAdmin.changes, byDrafter: byDrafter.changes }));
    chk("B23 E6 미리 보기 전후 — 카탈로그(칸 · 형 · not_null · 기본값 · 제약 · 인덱스 · 앱/보관 스키마의 관계) · 데이터 · 앱 행 · 판 행 수가 같다", f0 === f1,
      f0 === f1 ? "" : `${f0.length} / ${f1.length}`);

    // E4 빈 제목 1행 — 막힘(표 · 칸 · 1개) · 그 표의 할 일은 싣지 않고 다른 표의 할 일은 싣는다 · 아무것도 안 바뀜
    await q(`INSERT INTO ${rel("items")}(title, code) VALUES (NULL, 'C3')`);
    const f4 = await fingerprint();
    const e4 = await preview(alice);
    const f4b = await fingerprint();
    chk("B23 E4 빈 제목 1행 — 막힘(items.title · 1개) · logs 의 할 일은 그대로 · items 의 할 일은 싣지 않는다 · 표 그대로",
      e4.blocked.length === 1 && /items\.title/.test(e4.blocked[0]) && /1개/.test(e4.blocked[0]) && e4.incomplete === null
        && e4.changes.includes("logs 표: lvl 칸 지우기 — 값이 있는 1행은 따로 보관(앱에서는 더 안 보임)") && !e4.changes.some((l) => l.startsWith("items 표:")) && f4 === f4b,
      JSON.stringify({ e4, same: f4 === f4b }));

    // E9 다른 연결이 items 를 읽는 트랜잭션을 쥐고 있다 — 미리 보기는 짧게(0.4초)만 기다리고 «다 못 봄» · 그사이 시작한 다른 읽기도 오래 막히지 않는다
    process.env.LIVELY_APP_PREVIEW_LOCK_MS = "400";
    const holder = new pg.Client({ connectionString: dsnFor(DB) }); await holder.connect();
    const reader = new pg.Client({ connectionString: dsnFor(DB) }); await reader.connect();
    let e9 = null, readMs = null, f9 = null, f9b = null;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT count(*) FROM ${rel("items")}`);
      f9 = await fingerprint();
      const t0 = Date.now();
      const pv9 = preview(alice).then((r) => ({ r, ms: Date.now() - t0 }), (err) => ({ err: String(err?.message ?? err), ms: Date.now() - t0 }));
      await new Promise((res) => setTimeout(res, 150));
      const t1 = Date.now();
      const rd9 = reader.query(`SELECT count(*)::int AS n FROM ${rel("items")}`).then(() => Date.now() - t1);
      [e9, readMs] = await Promise.all([pv9, rd9]);
      f9b = await fingerprint();
    } finally {
      await holder.query("COMMIT").catch(() => {}); await holder.end().catch(() => {}); await reader.end().catch(() => {});
      delete process.env.LIVELY_APP_PREVIEW_LOCK_MS;
    }
    chk("B23 E9 다른 연결이 표를 읽는 중 — 미리 보기는 0.4초 상한 + 여유(3초) 안에 «다 못 봄» · 막힘 아님 · 그사이 시작한 읽기도 3초 안 · 표 그대로",
      //  빈 제목 행(E4)은 아직 있지만 items 는 칸 지우기에서 잠금을 못 얻어 멈춘다 — 그래서 막힘이 아니라 «다 못 봄» 이다.
      !!e9?.r && e9.ms < 3000 && /다 보지 못했습니다/.test(e9.r.incomplete ?? "") && e9.r.blocked.length === 0 && readMs < 3000 && f9 === f9b,
      JSON.stringify({ e9, readMs, same: f9 === f9b }));

    // E9b 다른 설치(다른 앱의 공개 등)가 같은 스키마의 기본 권한(pg_default_acl)을 쥔 채 아직 안 끝났다 — 표마다의 저장점 밖(스키마 준비)도
    //  짧게만 기다리고 «다 못 봄» · 바깥 트랜잭션이 깨져 뒤 표가 «current transaction is aborted» 로 줄줄이 실패하지 않는다.
    //  (앱 역할이 있어야 스키마 준비가 기본 권한을 건다 — 이 시험 동안만 역할을 준다.)
    await su.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgt_pv_role') THEN CREATE ROLE pgt_pv_role; END IF; END $$`);
    process.env.LIVELY_APP_DB_ROLE = "pgt_pv_role";
    process.env.LIVELY_APP_PREVIEW_LOCK_MS = "400";
    const aclHolder = new pg.Client({ connectionString: dsnFor(DB) }); await aclHolder.connect();
    let e9b = null, f9c = null, f9d = null;
    try {
      const owner = (await q("SELECT current_user AS u"))[0].u;
      await aclHolder.query("BEGIN");
      await aclHolder.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pgt_pv_role`);
      const release = setTimeout(() => { aclHolder.query("ROLLBACK").catch(() => {}); }, 4000);   // 상한이 안 먹으면 미리 보기는 4초를 기다린다
      f9c = await fingerprint();
      const t0 = Date.now();
      e9b = await preview(alice).then((r) => ({ r, ms: Date.now() - t0 }), (err) => ({ err: String(err?.message ?? err), ms: Date.now() - t0 }));
      clearTimeout(release);
      f9d = await fingerprint();
    } finally {
      await aclHolder.query("ROLLBACK").catch(() => {}); await aclHolder.end().catch(() => {});
      delete process.env.LIVELY_APP_DB_ROLE; delete process.env.LIVELY_APP_PREVIEW_LOCK_MS;
    }
    chk("B23 E9b 다른 설치가 기본 권한을 쥔 채 — 스키마 준비도 0.4초 상한(3초 안) · «다 못 봄» 만(바깥 트랜잭션이 깨진 오류 없음) · 막힘 아님 · 표 그대로",
      !!e9b?.r && e9b.ms < 3000 && /다 보지 못했습니다/.test(e9b.r.incomplete ?? "") && !/문제가 생겼습니다|aborted/.test(e9b.r.incomplete ?? "") && e9b.r.blocked.length === 0 && f9c === f9d,
      JSON.stringify({ e9b, same: f9c === f9d }));

    // E9c 전체 시간 상한 — 앞 표(items)가 잠금을 0.4초 기다리는 사이 상한(0.1초)이 지나면 뒤 표(logs)는 걸어 보지 않는다(문장 상한 × 문장 수로 길어지지 않게)
    process.env.LIVELY_APP_PREVIEW_LOCK_MS = "400"; process.env.LIVELY_APP_PREVIEW_TOTAL_MS = "100";
    const holderC = new pg.Client({ connectionString: dsnFor(DB) }); await holderC.connect();
    let e9c = null;
    try {
      await holderC.query("BEGIN"); await holderC.query(`SELECT count(*) FROM ${rel("items")}`);
      const t0 = Date.now();
      e9c = await preview(alice).then((r) => ({ r, ms: Date.now() - t0 }), (err) => ({ err: String(err?.message ?? err), ms: Date.now() - t0 }));
    } finally {
      await holderC.query("COMMIT").catch(() => {}); await holderC.end().catch(() => {});
      delete process.env.LIVELY_APP_PREVIEW_LOCK_MS; delete process.env.LIVELY_APP_PREVIEW_TOTAL_MS;
    }
    chk("B23 E9c 전체 시간 상한(0.1초)이 지나면 남은 표(logs)는 걸어 보지 않고 «다 못 봄» · 3초 안",
      !!e9c?.r && e9c.ms < 3000 && /다 보지 못했습니다/.test(e9c.r.incomplete ?? "") && !e9c.r.changes.some((l) => l.startsWith("logs 표:")) && e9c.r.blocked.length === 0,
      JSON.stringify(e9c));

    // E17 다른 저장 · 공개가 이 앱의 설치 락을 쥐고 있다 — 미리 보기는 1분이 아니라 짧게(3초)만 기다리고 «다른 사람이 저장 · 공개 중» 으로 돌아온다
    const lockC = new pg.Client({ connectionString: dsnFor(DB) }); await lockC.connect();
    let e17 = null;
    try {
      await lockC.query("SELECT pg_advisory_lock(hashtext($1))", [`app-install:${PV}`]);
      const release = setTimeout(() => { lockC.query("SELECT pg_advisory_unlock(hashtext($1))", [`app-install:${PV}`]).catch(() => {}); }, 9000);   // 상한이 안 먹으면 9초를 기다린다
      const t0 = Date.now();
      e17 = await preview(alice).then((r) => ({ r, ms: Date.now() - t0 }), (err) => ({ err: String(err?.message ?? err), ms: Date.now() - t0 }));
      clearTimeout(release);
    } finally {
      await lockC.query("SELECT pg_advisory_unlock_all()").catch(() => {}); await lockC.end().catch(() => {});
    }
    chk("B23 E17 다른 저장 · 공개가 설치 락을 쥔 채 — 3초쯤만 기다리고 «다른 사람(또는 다른 창)이 지금 저장 · 공개» · 막힘 아님",
      !!e17?.r && e17.ms >= 2500 && e17.ms < 6000 && /저장 · 공개하고 있어 보지 못했습니다/.test(e17.r.incomplete ?? "") && e17.r.blocked.length === 0 && e17.r.changes.length === 0,
      JSON.stringify(e17));

    // E18 새 판에 없는 표(arc)를 다른 연결이 통째로 잠갔다 — 행 세기도 짧게(0.4초)만 기다리고 «다 세지 못함» · 다른 표의 할 일은 그대로
    process.env.LIVELY_APP_PREVIEW_LOCK_MS = "400";
    const arcHolder = new pg.Client({ connectionString: dsnFor(DB) }); await arcHolder.connect();
    let e18 = null;
    try {
      await arcHolder.query("BEGIN"); await arcHolder.query(`LOCK TABLE ${rel("arc")} IN ACCESS EXCLUSIVE MODE`);
      const release = setTimeout(() => { arcHolder.query("ROLLBACK").catch(() => {}); }, 4000);   // 상한이 안 먹으면 4초를 기다린다
      const t0 = Date.now();
      e18 = await preview(alice).then((r) => ({ r, ms: Date.now() - t0 }), (err) => ({ err: String(err?.message ?? err), ms: Date.now() - t0 }));
      clearTimeout(release);
    } finally {
      await arcHolder.query("ROLLBACK").catch(() => {}); await arcHolder.end().catch(() => {});
      delete process.env.LIVELY_APP_PREVIEW_LOCK_MS;
    }
    chk("B23 E18 새 판에 없는 표(arc)가 잠겨 있으면 세기도 짧게 — «arc … 다 세지 못했습니다» · 3초 안 · logs 의 할 일은 그대로",
      !!e18?.r && e18.ms < 3000 && /arc/.test(e18.r.incomplete ?? "") && /다 세지 못했습니다/.test(e18.r.incomplete ?? "")
        && e18.r.changes.includes("logs 표: lvl 칸 지우기 — 값이 있는 1행은 따로 보관(앱에서는 더 안 보임)") && !e18.r.gone_tables.some((g) => g.table === "arc"),
      JSON.stringify(e18));

    // E19 형 바꾸기의 값 확인(값을 새 형으로 바꿨다 되돌려 견주기 — 표 전체를 훑는다)이 시간 상한에 걸리면 «못 바꿈» 이 아니라 «다 못 봄».
    //  실제 공개는 상한이 길어(5분) 그 칸을 바꾸므로 «못 바꿈» 은 틀린 말이다. (잠금으로는 못 재현한다 — 칸 목록을 읽는 단계가 기본값 식을
    //  풀며 표를 먼저 잠그므로 거기서 먼저 걸린다. 그래서 훑기가 오래 걸리는 큰 값 하나로 문장 상한을 넘긴다: 5MB jsonb 글자 ≈ 0.4초 > 상한 0.1초.)
    const CV = "pv-conv";
    const cfiles = (type, html) => pfiles([{ name: "docs", columns: [{ name: "v", type }] }], html, CV);
    await call("app_save", { files: cfiles("text", "<p>c1</p>") }, alice);
    await call("app_visibility_set", { app_id: CV, visibility: "all" }, alice);
    await q(`INSERT INTO app.pv_conv__docs(v) SELECT '[' || repeat('{"a": 1}, ', 500000) || '{"a": 1}]'`);   // jsonb 가 그대로 돌려주는 꼴(왕복해도 같다)
    await call("app_save", { files: cfiles("json", "<p>c2</p>") }, alice);   // 공개 판이 쓰는 칸의 형 바꾸기 — 공개할 때로 미뤄진다
    const e19free = await preview(alice, {}, CV);
    process.env.LIVELY_APP_PREVIEW_STATEMENT_MS = "100";
    let e19 = null;
    try { e19 = await preview(alice, {}, CV); } finally { delete process.env.LIVELY_APP_PREVIEW_STATEMENT_MS; }
    chk("B23 E19 형 바꾸기 값 확인이 시간 상한에 걸리면 «다 못 봄»(«못 바꿈» 이라 하지 않는다) · 상한이 넉넉하면 «종류 바꾸기 text → jsonb»",
      e19free.changes.includes("docs 표: v 칸 종류 바꾸기 text → jsonb") && e19free.incomplete === null
        && /다 보지 못했습니다/.test(e19?.incomplete ?? "") && !(e19?.notes ?? []).some((n) => n.includes("못 바꿔")) && (e19?.blocked ?? []).length === 0,
      JSON.stringify({ e19free: [e19free.changes, e19free.notes, e19free.incomplete], e19: e19 && [e19.changes, e19.notes, e19.incomplete] }));

    // E20 옛 기본 키((tenant_id, id))를 좁히는 일이 잠금 상한에 걸리면 «다 못 봄» — 삼키면 미리 보기가 그 일을 빼고 «할 일 없음» 처럼 보인다
    const PK = "pv-pk";
    const kfiles = (cols, html) => pfiles([{ name: "t", columns: cols }], html, PK);
    await call("app_save", { files: kfiles([{ name: "x", type: "text" }], "<p>k1</p>") }, alice);
    await call("app_visibility_set", { app_id: PK, visibility: "all" }, alice);
    await call("app_save", { files: kfiles([{ name: "x", type: "text" }, { name: "y", type: "text" }], "<p>k2</p>") }, alice);   // 새 칸(바로) — 초안이 걸린다
    const pkName = (await q(`SELECT conname FROM pg_constraint WHERE conrelid = to_regclass('app.pv_pk__t') AND contype = 'p'`))[0].conname;
    await q(`ALTER TABLE app.pv_pk__t DROP CONSTRAINT "${pkName}", ADD CONSTRAINT "${pkName}" PRIMARY KEY (tenant_id, id)`);   // 옛 모양(#4483 전)
    const e20free = await preview(alice, {}, PK);
    process.env.LIVELY_APP_PREVIEW_LOCK_MS = "400";
    const pkHolder = new pg.Client({ connectionString: dsnFor(DB) }); await pkHolder.connect();
    let e20 = null;
    try {
      await pkHolder.query("BEGIN"); await pkHolder.query("SELECT count(*) FROM app.pv_pk__t");   // 읽는 중 — 키를 바꾸는 ALTER 만 기다린다
      e20 = await preview(alice, {}, PK);
    } finally {
      await pkHolder.query("COMMIT").catch(() => {}); await pkHolder.end().catch(() => {});
      delete process.env.LIVELY_APP_PREVIEW_LOCK_MS;
    }
    chk("B23 E20 옛 기본 키 좁히기가 잠금 상한에 걸리면 «다 못 봄» · 잠금 없을 땐 «t 표: 기본 키 바꾸기»",
      e20free.changes.includes("t 표: 기본 키 바꾸기") && /다 보지 못했습니다/.test(e20?.incomplete ?? "") && (e20?.blocked ?? []).length === 0,
      JSON.stringify({ e20free: e20free.changes, e20: e20 && [e20.changes, e20.incomplete] }));

    // E14 막힘 → 고침 → 다시 보면 막힘 0
    await q(`UPDATE ${rel("items")} SET title = '채움' WHERE title IS NULL`);
    const e14 = await preview(alice);
    chk("B23 E14 빈 제목을 채우고 다시 보면 막힘 0 · items 의 할 일이 돌아온다(code 값 3행)",
      e14.blocked.length === 0 && e14.incomplete === null && e14.changes.includes("items 표: code 칸 지우기 — 값이 있는 3행은 따로 보관(앱에서는 더 안 보임)"),
      JSON.stringify(e14));

    // E5 미리 보기 == 실제 공개(책임자가 bob 의 초안을 공개) — 표 보고서가 같고, 정리될 표도 미리 본 대로
    const norm = (t) => JSON.stringify({
      created: [...(t?.created ?? [])].sort(),
      added: (t?.added_columns ?? []).map((c) => `${c.table}.${c.column}:${c.type}`).sort(),
      renamed: (t?.renamed_columns ?? []).map((c) => `${c.table}.${c.from}>${c.to}`).sort(),
      converted: (t?.converted_columns ?? []).map((c) => `${c.table}.${c.column}:${c.from}>${c.to}`).sort(),
      mism: (t?.type_mismatches ?? []).map((c) => `${c.table}.${c.column}`).sort(),
      dropped: (t?.dropped_columns ?? []).map((d) => `${d.table}.${d.column}:${d.rows}`).sort(),
      undeclared: (t?.undeclared_columns ?? []).map((c) => `${c.table}.${c.column}`).sort(),
      cons: (t?.constraints ?? []).map((c) => `${c.table}.${c.column ?? ""}:${c.kind}:${c.action}`).sort(),
      addIx: (t?.added_indexes ?? []).map((i) => `${i.table}:${i.columns.join("+")}:${i.unique}`).sort(),
      dropIx: (t?.dropped_indexes ?? []).map((i) => `${i.table}:${i.index}`).sort(),
    });
    const pre = await preview(alice);
    const pub = await call("app_visibility_set", { app_id: PV, visibility: "all" }, alice);
    const arcArchived = (await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'app_archive' AND table_name LIKE 'pv_app__arc%'`))[0].n;
    const tmpGone = !(await q(`SELECT to_regclass('app.pv_app__tmp') AS r`))[0].r;
    chk("B23 E5 미리 보기 == 실제 공개 — 표 보고서(지운 칸 · 행 수 · 규칙 · …)가 같다 · 정리될 표도 미리 본 대로(arc 보관 · tmp 지움)",
      pub.changed === true && norm(pre.tables) === norm(pub.tables) && (pre.tables?.dropped_columns ?? []).length === 3
        && pre.gone_tables.map((g) => `${g.table}:${g.action}`).sort().join() === "arc:archive,tmp:drop" && arcArchived === 1 && tmpGone,
      JSON.stringify({ pre: norm(pre.tables), pub: norm(pub.tables), gone: pre.gone_tables, arcArchived, tmpGone }));

    // E10 판 번호 — 그 판으로 되돌려 공개하면: note 를 지우는 판(D2)
    const D2 = [{ name: "items", columns: [{ name: "title", type: "text", not_null: true }], drop_columns: ["note"] }, D[1]];
    const sD2 = await call("app_save", { files: pfiles(D2, "<p>pv-D2</p>"), note: "D2" }, alice);
    await call("app_save", { files: pfiles(D, "<p>pv-D</p>"), note: "D 다시" }, alice);
    await q(`UPDATE ${rel("items")} SET note = 'N' WHERE title = 'a'`);
    const f10 = await fingerprint();
    const e10 = await preview(alice, { version_no: sD2.version_no });
    const f10b = await fingerprint();
    chk("B23 E10 판 번호 — 그 판(D2)으로 되돌려 공개하면 note 칸 지우기(값 1행) · 되돌리기 종류 · 판 번호 · 아무것도 안 바뀜",
      e10.kind === "revert" && e10.version_no === sD2.version_no && e10.changes.includes("items 표: note 칸 지우기 — 값이 있는 1행은 따로 보관(앱에서는 더 안 보임)")
        && e10.blocked.length === 0 && f10 === f10b,
      JSON.stringify({ e10, same: f10 === f10b }));
    // E10b 없는 판 · 남의 공개 전 판 — 되돌리기처럼 404
    const sD3 = await call("app_save", { files: pfiles(D2, "<p>pv-D3 bob</p>"), note: "D3" }, bob);
    chk("B23 E10b 없는 판 · 남(bob)의 공개 전 판(carol 이 봄) — 404",
      (await status(preview(alice, { version_no: 99999 }))) === 404 && (await status(preview(carol, { version_no: sD3.version_no }))) === 404,
      JSON.stringify({ sD3: sD3.version_no }));

    // E15b 선언에서만 뺀 칸(note — drop_columns 없음)은 공개해도 남겨 둔다 — 바뀌는 일 0 · «알아 둘 것» 에만 · 그래서 화면은 묻지 않는다
    const D4 = [{ name: "items", columns: [{ name: "title", type: "text", not_null: true }] }, D[1]];
    await call("app_save", { files: pfiles(D4, "<p>pv-D4</p>"), note: "D4" }, alice);
    const e15b = await preview(alice);
    chk("B23 E15b 선언에서만 뺀 칸 — 바뀌는 일 0 · notes 에 «note 칸은 새 판에 없지만 값을 지키려고 남겨 둠» · 막힘 0",
      e15b.changes.length === 0 && e15b.notes.includes("items 표: note 칸은 새 판에 없지만 값을 지키려고 남겨 둠") && e15b.blocked.length === 0 && e15b.incomplete === null,
      JSON.stringify(e15b));

    // E16 되돌려 공개 — 미리 본 것(E10: note 칸 지우기 · 값 1행 보관)과 실제 app_revert {publish:true} 의 결과가 같다
    const pre16 = await preview(alice, { version_no: sD2.version_no });
    const rv16 = await call("app_revert", { app_id: PV, version_no: sD2.version_no, publish: true }, alice);
    const cols16 = (await q(`SELECT attname FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped ORDER BY attnum`, [rel("items")])).map((r) => r.attname).join(",");
    const arch16 = (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'app_archive' AND table_name LIKE 'pv_app__items__note__%'`)).map((r) => r.table_name);
    const archRows16 = arch16.length === 1 ? (await q(`SELECT count(*)::int AS n FROM app_archive."${arch16[0]}"`))[0].n : null;
    chk("B23 E16 되돌려 공개 — 미리 본 «note 칸 지우기 · 값 1행 보관» 그대로 실제로 됐다(칸 없음 · 보관 1행) · 모두의 판",
      pre16.changes.includes("items 표: note 칸 지우기 — 값이 있는 1행은 따로 보관(앱에서는 더 안 보임)") && (pre16.tables?.dropped_columns ?? []).map((d) => `${d.table}.${d.column}:${d.rows}`).join() === "items.note:1"
        && rv16.state === "published" && !cols16.split(",").includes("note") && archRows16 === 1,
      JSON.stringify({ pre16: pre16.changes, rv16: { state: rv16.state, changed: rv16.changed }, cols16, arch16, archRows16 }));

    // E12 기본 앱(공유 표) — 공개 때 표를 바꾸지 않는다 → 할 일 0. 깨는 초안(logs.msg 지우기)이 걸려 있어도 걸어 보지 않는다
    await call("app_save", { files: pfiles([D2[0], { name: "logs", columns: [{ name: "msg2", type: "text" }], drop_columns: ["msg"] }], "<p>pv-D5</p>"), note: "D5" }, alice);
    const e12before = await preview(alice);
    await q(`UPDATE org_app SET source = '{"kind":"builtin"}'::jsonb WHERE id = $1`, [PV]);
    const e12 = await preview(alice);
    chk("B23 E12 기본 앱 — 깨는 초안(logs.msg 지우기)이 걸려 있어도 할 일 0 · 막힘 0(같은 초안이 일반 앱일 땐 할 일이 있었다)",
      e12before.changes.some((l) => l.startsWith("logs 표: msg 칸 지우기")) && e12.changes.length === 0 && e12.blocked.length === 0 && e12.tables === null && (await row(PV)).draft_by === "pgt-alice",
      JSON.stringify({ e12before: e12before.changes, e12 }));
  }
} catch (e) {
  fail++; console.error("FAIL 예외 —", e?.stack ?? e);
} finally {
  await itemsPool.end().catch(() => {});
  await dbc.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.query("DROP ROLE IF EXISTS pgt_pv_role").catch(() => {});   // B23 E9b 가 만든 클러스터 역할 — DB 를 지운 뒤에야 지울 수 있다
  await su.end().catch(() => {});
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
