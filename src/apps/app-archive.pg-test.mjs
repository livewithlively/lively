// 앱 보관 표 정리(#4733 앱 v2-19) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖, CI services:postgres 스텝 — .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-archive.pg-test.mjs
//
// 보관 표(앱 데이터를 말없이 잃지 않으려고 옮겨 둔 표)의 주인 기록 · 관리자 목록 · 비우기 · 앱 지우기 때 함께 지우기 · 되살리기에서 건너뛰기 ·
//  표 개수 한도 안내를 **새 DB** 위에서 끝까지 돈다(initAllSchemas 를 적용한 DB · 단일 테넌트 = 스키마 app · 보관 자리 app_archive).
//  이름 짐작 규칙(잘린 이름 · 해시꼴)은 archive-meta.test.ts 가 잡는다 — 여기는 그 규칙이 실제 표 · 백업 · 도구 응답에 어떻게 착지하는지다.
//
//  A1 설치 갱신으로 빠진 표(데이터 있음) — 주인 기록(install)  A2 drop_columns 로 지운 칸 — 기록(칸 · 값 있는 행 수)
//  A3 공개하며 미룬 칸 지우기 적용 — 기록 reason=publish  A4 공개로 옛 공개 판에만 있던 표 보관 — 기록 reason=publish
//  L  관리자 목록 — recorded · guessed(기록 없는 옛 보관 표) · unknown · 행 수 · 크기 · 한도 셈
//  R1 앱 지우기 — 그 앱 보관 표(기록 둘 + 이름 짐작 하나)를 같은 묶음에 백업 뒤 지움  R2 이름이 비슷한 다른 앱(crm-x) 그대로
//  R3 이름은 이 앱인데 기록은 다른 앱 — 그대로  R4 주인 모름 그대로  R5 백업 상한 초과 — 남기고 까닭 · 앱은 지워짐  R7 기본 앱 — 손대지 않음
//  C1 비우기(이름) — before-clear 백업 뒤 지움 · 한도 셈이 준다  C2 없는 이름 · 지금 쓰는 표 이름 — 아무것도 안 지움  C3 관리자만
//  C4 비우기(app_id) — 그 앱 것만  S1 되살리기 — 앱 표만 · 보관 표는 건너뜀  S2 보관 표만 고르면 400  S3 보관 표만 담긴 묶음 409
//  F1 표 개수 한도 안내 — 보관 표를 관리자가 비울 수 있다
import pg from "pg";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_archive_4733";
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
delete process.env.LIVELY_APP_SNAPSHOT_MAX_BYTES;
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
const { appStoreCapabilities } = await import(`${D}/capabilities/app-store.js`);
const { removeInstalledApp } = await import(`${D}/apps/remove-run.js`);
const { requireScope } = await import(`${D}/context.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const all = [...appCapabilities, ...appStoreCapabilities];
const cap = (n) => { const c = all.find((x) => x.name === n); if (!c) throw new Error(`능력 없음: ${n}`); return c; };
const call = (n, input, user, ctx = { source: "mcp" }) => cap(n).handler(input, user, ctx);
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const alice = { userId: "pgt-alice", email: "a@x", scopes: ["memory"], projects: ["*"] };
const bob = { userId: "pgt-bob", email: "b@x", scopes: ["memory"], projects: ["*"] };
const boss = { userId: "pgt-boss", email: "boss@x", scopes: ["memory", "admin"], projects: ["*"] };
let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
for (const [id, scopes] of [["pgt-alice", ["memory"]], ["pgt-bob", ["memory"]], ["pgt-boss", ["memory", "admin"]]]) {
  await q(`INSERT INTO org_member(id, kind, display_name, state, scopes) VALUES($1,'human',$1,'active',$2::jsonb)`, [id, JSON.stringify(scopes)]);
}
const man = (id, tables, title = id) => JSON.stringify({ id, title, version: "0.1.0",
  permissions: { scopes: [], tools: ["store_insert", "store_query"] }, data: { tables }, ui: { pages: [{ key: "main", title, entry: "ui/index.html" }] } });
const files = (id, tables, html = "<p>v</p>") => [{ path: "lively-app.json", content: man(id, tables) }, { path: "ui/index.html", content: html }];
const save = (id, tables, who = alice, html) => call("app_save", { files: files(id, tables, html) }, who);
const asApp = (n, input, who, id) => call(n, input, { ...who, appId: id, scopes: [] }, { source: "app-ui" });
const exists = async (schema, name) => (await q(`SELECT to_regclass($1) AS r`, [`"${schema}"."${name}"`]))[0].r != null;
const commentOf = async (name) => (await q(`SELECT obj_description(to_regclass($1), 'pg_class') AS c`, [`"app_archive"."${name}"`]))[0]?.c ?? null;
const archiveNames = async (prefix) => (await q(`SELECT tablename FROM pg_tables WHERE schemaname = 'app_archive' AND tablename LIKE $1 ORDER BY 1`, [`${prefix}%`])).map((r) => r.tablename);
const recordOf = async (name) => { const c = await commentOf(name); return c?.startsWith("lively-archive:") ? JSON.parse(c.slice("lively-archive:".length)) : null; };
const archivedCount = async () => (await q(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app_archive' AND c.relkind IN ('r','p')`))[0].n;
const snapRows = async (appId, reason) => q(`SELECT taken_at, table_name, sum(row_count)::int AS rows FROM org_app_snapshot WHERE app_id = $1 AND reason = $2 GROUP BY taken_at, table_name ORDER BY table_name`, [appId, reason]);
//  기록 없는 옛 보관 표(#4733 전에 생긴 것)를 손으로 만든다 — 통째 보관 꼴(앱 표 칸) + 행 하나.
const legacy = async (name, comment = null) => {
  await q(`CREATE SCHEMA IF NOT EXISTS app_archive`);
  await q(`CREATE TABLE app_archive."${name}" (tenant_id uuid, id bigint, title text, created_at timestamptz DEFAULT now())`);
  await q(`INSERT INTO app_archive."${name}"(tenant_id, id, title) VALUES ('00000000-0000-0000-0000-000000000000', 1, '옛 값')`);
  if (comment) await q(`COMMENT ON TABLE app_archive."${name}" IS ${pg.escapeLiteral(comment)}`);
};

try {
  // ── A1 · A2 설치(저장) 때 — 나만 보는 앱은 깨는 변경도 바로 된다 ──
  await save("crm", [{ name: "deals", columns: [{ name: "title", type: "text" }, { name: "note", type: "text" }] }, { name: "logs", columns: [{ name: "line", type: "text" }] }]);
  await call("me_app_grant", { app_id: "crm" }, alice);
  await asApp("store_insert", { table: "deals", row: { title: "d1", note: "n1" } }, alice, "crm");
  await asApp("store_insert", { table: "deals", row: { title: "d2", note: "n2" } }, alice, "crm");
  await asApp("store_insert", { table: "deals", row: { title: "d3" } }, alice, "crm");
  await asApp("store_insert", { table: "logs", row: { line: "l1" } }, alice, "crm");
  const t0 = Date.now();
  await save("crm", [{ name: "deals", columns: [{ name: "title", type: "text" }], drop_columns: ["note"] }]);
  const crmArch = await archiveNames("crm__");
  const logsName = crmArch.find((n) => /^crm__logs__\d{14}$/.test(n));
  const noteName = crmArch.find((n) => /^crm__deals__note__\d{14}$/.test(n));
  const logsRec = logsName && await recordOf(logsName), noteRec = noteName && await recordOf(noteName);
  chk("A1 빠진 표(데이터 있음)를 보관하며 주인을 적는다 — 앱 · 표 · 칸 없음 · 행 수 · 시각 · 까닭 install",
    !!logsRec && logsRec.app_id === "crm" && logsRec.table === "logs" && logsRec.column === null && logsRec.rows === 1 && logsRec.reason === "install"
      && Math.abs(Date.parse(logsRec.at) - t0) < 60_000, JSON.stringify({ crmArch, logsRec }));
  chk("A2 drop_columns 로 지운 칸 — 칸 · 값이 있던 행 수(2)를 적는다", !!noteRec && noteRec.app_id === "crm" && noteRec.table === "deals" && noteRec.column === "note"
    && noteRec.rows === 2 && noteRec.reason === "install", JSON.stringify({ noteRec }));

  // ── A3 · A4 공개 때 — 공개 앱의 초안이 미룬 칸 지우기 · 옛 공개 판에만 있던 표 ──
  await save("pub-app", [{ name: "items", columns: [{ name: "title", type: "text" }, { name: "code", type: "text" }] }, { name: "extra", columns: [{ name: "x", type: "text" }] }]);
  await call("app_visibility_set", { app_id: "pub-app", visibility: "all" }, alice);
  await call("me_app_grant", { app_id: "pub-app" }, bob);
  await asApp("store_insert", { table: "items", row: { title: "i1", code: "C1" } }, bob, "pub-app");
  await asApp("store_insert", { table: "extra", row: { x: "e1" } }, bob, "pub-app");
  const draft = await save("pub-app", [{ name: "items", columns: [{ name: "title", type: "text" }], drop_columns: ["code"] }]);
  const beforePub = await archiveNames("pub_app__");
  await call("app_visibility_set", { app_id: "pub-app", visibility: "all" }, alice);
  const pubArch = await archiveNames("pub_app__");
  const codeName = pubArch.find((n) => /^pub_app__items__code__\d{14}$/.test(n));
  const extraName = pubArch.find((n) => /^pub_app__extra__\d{14}$/.test(n));
  const codeRec = codeName && await recordOf(codeName), extraRec = extraName && await recordOf(extraName);
  chk("A3 공개하며 미룬 칸 지우기를 적용 — 기록 reason=publish(초안 저장 때는 보관 표가 없었다)",
    draft.state === "draft" && beforePub.length === 0 && !!codeRec && codeRec.app_id === "pub-app" && codeRec.column === "code" && codeRec.rows === 1 && codeRec.reason === "publish",
    JSON.stringify({ state: draft.state, beforePub, pubArch, codeRec }));
  chk("A4 공개로 옛 공개 판에만 있던 표(데이터 있음)를 보관 — 기록 reason=publish", !!extraRec && extraRec.app_id === "pub-app" && extraRec.table === "extra"
    && extraRec.column === null && extraRec.rows === 1 && extraRec.reason === "publish", JSON.stringify({ extraRec }));

  // ── 기록 없는 옛 보관 표 · 이름이 비슷한 다른 앱 · 기록이 다른 앱 · 주인 모름 ──
  await legacy("crm__old__20250101000000");                                                   // 이름 짐작 = crm
  await legacy("crm_x__deals__20250101000000");                                               // 이름 짐작 = crm-x (R2)
  await legacy("crm__stolen__20250101000000", 'lively-archive:{"v":1,"app_id":"other-app","table":"stolen","column":null,"rows":1,"at":"2025-01-01T00:00:00.000Z","reason":"install"}'); // R3
  const unknownName = `${"a".repeat(47)}__20250101000000`;                                     // 앱 부분이 잘린 꼴 → 주인 모름(R4)
  await legacy(unknownName);

  // ── L 관리자 목록 ──
  const L = await call("app_archives", {}, boss);
  const by = new Map(L.archives.map((a) => [a.name, a]));
  const lv = (n) => { const a = by.get(n); return a ? [a.app_id, a.owner, a.kind, a.table, a.column, a.rows] : null; };
  chk("L 관리자 목록 — 기록(recorded) · 이름 짐작(guessed) · 주인 모름(unknown) · 종류 · 행 수 · 크기 · 한도 셈",
    L.schema === "app_archive" && L.count === 8
      && JSON.stringify(lv(logsName)) === JSON.stringify(["crm", "recorded", "table", "logs", null, 1])
      && JSON.stringify(lv(noteName)) === JSON.stringify(["crm", "recorded", "column", "deals", "note", 2])
      && JSON.stringify(lv("crm__old__20250101000000")) === JSON.stringify(["crm", "guessed", "table", "old", null, 1])
      && JSON.stringify(lv("crm_x__deals__20250101000000")) === JSON.stringify(["crm-x", "guessed", "table", "deals", null, 1])
      && JSON.stringify(lv("crm__stolen__20250101000000")) === JSON.stringify(["other-app", "recorded", "table", "stolen", null, 1])
      && JSON.stringify(lv(unknownName)) === JSON.stringify([null, "unknown", "table", null, null, 1])
      && L.archives.every((a) => a.bytes > 0) && L.table_limit.archived === 8 && L.table_limit.limit === 500,
    JSON.stringify({ schema: L.schema, count: L.count, rows: L.archives.map((a) => [a.name, a.app_id, a.owner, a.kind, a.table, a.column, a.rows, a.bytes]), limit: L.table_limit }));
  const Lcrm = await call("app_archives", { app_id: "crm" }, boss);
  chk("L2 app_id 로 거르면 그 앱 것만(기록 · 짐작) — 기록이 다른 앱인 것은 빠진다", Lcrm.archives.map((a) => a.name).sort().join() === [logsName, noteName, "crm__old__20250101000000"].sort().join(),
    JSON.stringify(Lcrm.archives.map((a) => a.name)));

  // ── C3 관리자만 ──
  const c3 = [errOf(Promise.resolve().then(() => requireScope(alice, cap("app_archive_clear").scope))), errOf(Promise.resolve().then(() => requireScope(alice, cap("app_archives").scope)))];
  const [c3a, c3b] = await Promise.all(c3);
  chk("C3 목록 · 비우기는 관리자만(관문 requireScope 가 admin 없는 사람을 막는다)", /lacks scope 'admin'/.test(c3a?.message ?? "") && /lacks scope 'admin'/.test(c3b?.message ?? "")
    && (await errOf(Promise.resolve().then(() => requireScope(boss, cap("app_archive_clear").scope)))) === null, JSON.stringify([c3a?.message, c3b?.message]));

  // ── R1~R4 앱 지우기 ──
  const r1 = await call("org_app_remove", { app_id: "crm" }, boss);
  const crmSnaps = await snapRows("crm", "before-remove");
  const at = r1.snapshot?.taken_at;
  const snapOf = (n) => crmSnaps.find((s) => s.table_name === `archive:${n}`);
  chk("R1 앱 지우기 — 그 앱 보관 표(기록 둘 + 이름 짐작 하나)를 지움 · 응답 cleared 셋 · 남긴 것 없음",
    !(await exists("app_archive", logsName)) && !(await exists("app_archive", noteName)) && !(await exists("app_archive", "crm__old__20250101000000"))
      && r1.archives?.cleared?.map((c) => c.name).sort().join() === [logsName, noteName, "crm__old__20250101000000"].sort().join() && r1.archives?.kept?.length === 0,
    JSON.stringify(r1.archives));
  chk("R1b 지우기 직전 백업 — 앱 표와 같은 시각 · 같은 묶음 · 보관 표마다 archive:<이름> · 행 수 그대로",
    !!at && snapOf(logsName)?.rows === 1 && snapOf(noteName)?.rows === 2 && snapOf("crm__old__20250101000000")?.rows === 1
      && crmSnaps.every((s) => new Date(s.taken_at).toISOString() === at) && crmSnaps.some((s) => s.table_name === "deals") && r1.archives?.taken_at === at,
    JSON.stringify({ at, crmSnaps }));
  chk("R2 이름이 비슷한 다른 앱(crm-x)의 보관 표는 그대로", await exists("app_archive", "crm_x__deals__20250101000000"));
  chk("R3 이름은 이 앱(crm)인데 기록은 다른 앱 — 그대로(기록이 이긴다)", await exists("app_archive", "crm__stolen__20250101000000"));
  chk("R4 주인 모름 — 그대로", await exists("app_archive", unknownName));
  const backup = (await q(`SELECT rows FROM org_app_snapshot WHERE app_id='crm' AND table_name=$1 AND chunk=0`, [`archive:${noteName}`]))[0]?.rows ?? [];
  chk("R1c 백업 내용 — 지운 칸의 값(id · value)이 그대로 담겼다", backup.map((r) => r.value).sort().join() === "n1,n2" && backup.every((r) => r.id != null), JSON.stringify(backup));

  // ── S1~S3 되살리기 — 같은 id 로 다시 만든 앱 ──
  await save("crm", [{ name: "deals", columns: [{ name: "title", type: "text" }] }]);
  const s1 = await call("app_data_restore", { app_id: "crm", taken_at: at }, boss);
  const back = (await q(`SELECT title FROM app.crm__deals ORDER BY id`)).map((r) => r.title).join();
  chk("S1 되살리기 — 앱 표(deals)만 되살리고 보관 표 셋은 건너뛴다(보관 표가 다시 생기지 않는다)",
    s1.restored.map((r) => r.table).join() === "deals" && back === "d1,d2,d3" && s1.archives_skipped.slice().sort().join() === [logsName, noteName, "crm__old__20250101000000"].sort().join()
      && !(await exists("app_archive", logsName)), JSON.stringify({ s1, back }));
  const s2 = await errOf(call("app_data_restore", { app_id: "crm", taken_at: at, table: `archive:${noteName}` }, boss));
  chk("S2 보관 표만 고르면 400 — 되살리지 않는다", s2?.status === 400 && /보관 표/.test(s2?.message ?? ""), JSON.stringify([s2?.status, s2?.message]));

  // ── R7 기본 앱(시더의 은퇴 회수) — 보관 자리를 건드리지 않는다 ──
  await save("crm-y", [{ name: "t", columns: [{ name: "v", type: "text" }] }]);
  await legacy("crm_y__gone__20250101000000");
  await q(`UPDATE org_app SET source = '{"kind":"builtin"}'::jsonb WHERE id = 'crm-y'`);
  const appY = (await q(`SELECT * FROM org_app WHERE id = 'crm-y'`))[0];
  const r7 = await removeInstalledApp(appY, { actor: "pgt-boss", source: "seed" });
  chk("R7 기본 앱 지우기 — 보관 표 그대로 · 응답에 archives 없음", await exists("app_archive", "crm_y__gone__20250101000000") && r7.archives === undefined, JSON.stringify(r7));

  // ── R5 백업 상한 초과 — 지우지 않고 남긴다 · 앱은 지워진다 ──
  process.env.LIVELY_APP_SNAPSHOT_MAX_BYTES = "1";
  const r5 = await call("org_app_remove", { app_id: "pub-app" }, boss);
  delete process.env.LIVELY_APP_SNAPSHOT_MAX_BYTES;
  chk("R5 백업 상한 초과 — 보관 표 둘 남김 · kept 에 까닭(너무 큼) · 앱은 지워짐",
    r5.ok === true && (await exists("app_archive", codeName)) && (await exists("app_archive", extraName)) && r5.archives?.cleared?.length === 0
      && r5.archives?.kept?.length === 2 && r5.archives.kept.every((k) => /너무 큽니다/.test(k.why)) && (await q(`SELECT 1 FROM org_app WHERE id='pub-app'`)).length === 0,
    JSON.stringify(r5.archives));

  // ── C1 비우기(이름) — 백업 뒤 지움 · 한도 셈이 준다 ──
  const beforeC1 = await archivedCount();
  const c1 = await call("app_archive_clear", { names: [codeName, extraName] }, boss);
  const c1Snaps = await snapRows("pub-app", "before-clear");
  chk("C1 비우기 — 둘 다 지움 · before-clear 백업(archive:<이름> · 행 수) · 한도 셈(archived)이 2 줄었다",
    !(await exists("app_archive", codeName)) && !(await exists("app_archive", extraName)) && c1.cleared.length === 2 && c1.kept.length === 0 && c1.missing.length === 0
      && c1Snaps.length === 2 && c1Snaps.every((s) => s.rows === 1) && c1.table_limit.archived === beforeC1 - 2 && (await archivedCount()) === beforeC1 - 2 && !!c1.taken_at,
    JSON.stringify({ c1, c1Snaps, beforeC1 }));

  // ── C2 없는 이름 · 지금 쓰는 표 이름 — 아무것도 안 지운다 ──
  await save("keep", [{ name: "items", columns: [{ name: "v", type: "text" }] }]);
  const c2 = await call("app_archive_clear", { names: ["keep__items", "no_such__x__20250101000000"] }, boss);
  chk("C2 보관 자리에 없는 이름(지금 쓰는 표 포함)은 missing — 쓰는 표 그대로 · 아무것도 안 지움",
    c2.cleared.length === 0 && c2.missing.slice().sort().join() === "keep__items,no_such__x__20250101000000" && (await exists("app", "keep__items")) && c2.taken_at === null,
    JSON.stringify(c2));
  const c2b = await errOf(call("app_archive_clear", {}, boss));
  chk("C2b names · app_id 둘 다 없으면 400", c2b?.status === 400, String(c2b?.message));

  // ── C4 · S3 비우기(app_id) — 그 앱 것만 · 그 백업만 담긴 묶음은 되살릴 표가 없다 ──
  await legacy("keep__old__20250101000000");
  const c4 = await call("app_archive_clear", { app_id: "keep" }, boss);
  chk("C4 비우기(app_id) — 그 앱 것만 지움(crm-x · 기록 다른 앱 · 주인 모름 · 기본 앱 그대로)",
    c4.cleared.map((c) => c.name).join() === "keep__old__20250101000000" && !(await exists("app_archive", "keep__old__20250101000000"))
      && (await exists("app_archive", "crm_x__deals__20250101000000")) && (await exists("app_archive", "crm__stolen__20250101000000")) && (await exists("app_archive", unknownName))
      && (await exists("app_archive", "crm_y__gone__20250101000000")), JSON.stringify(c4));
  const s3 = await errOf(call("app_data_restore", { app_id: "keep", taken_at: c4.taken_at }, boss));
  chk("S3 보관 표만 담긴 묶음(비우기 백업)은 되살릴 앱 표가 없다 — 409 · 아무것도 안 바뀜", s3?.status === 409 && /보관 표만/.test(s3?.message ?? "") && (await exists("app", "keep__items")),
    JSON.stringify([s3?.status, s3?.message]));

  // ── F1 표 개수 한도 안내 ──
  const counted = await q(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind IN ('r','p'))::int AS cur`);
  process.env.LIVELY_APP_TABLE_FUSE = String(counted[0].cur + (await archivedCount()));
  const f1 = await errOf(save("fuse-app", [{ name: "t", columns: [{ name: "v", type: "text" }] }]));
  delete process.env.LIVELY_APP_TABLE_FUSE;
  chk("F1 표 개수 한도에 걸리면 «보관 표 N개는 관리자가 비울 수 있다» 를 덧붙인다", f1?.status === 409 && /보관 표 \d+개는 관리자가 비울 수 있습니다/.test(f1?.message ?? "") && /app_archive_clear/.test(f1?.message ?? ""),
    JSON.stringify([f1?.status, f1?.message]));
} catch (e) {
  fail++;
  console.error("FAIL 예외 —", e?.stack ?? e);
} finally {
  await itemsPool.end().catch(() => undefined);
  await dbc.end().catch(() => undefined);
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  await su.end().catch(() => undefined);
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
