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
//  ── 격리 리뷰 반영 ──
//  E1 서로 외래키로 묶인 보관 표(부모 · 자식을 함께 보관) — 앱 지우기가 둘 다 지운다(다시 시도)  E2 규칙 밖 이름(old-backup) 하나가 목록 · 비우기를 죽이지 않는다
//  E3 1,000행 넘는 보관 표 — 조각 셋으로 백업  E4 force — 백업 없이 지운다  E5 크기 아닌 까닭으로 백업 실패 — 하나도 안 지운다
//  E6 지금 쓰는 표가 보관 표를 가리키면 지우지 못하고 까닭과 남긴다  E7 주인 모름의 백업은 app_id '~unknown'  E8 names 가 배열이 아니면 400
//  E9 비우기는 감사에 남는다
//  ── 재검토 반영 ──
//  E10 id 가 겹치거나 빈 표(손으로 옮긴 것) — 조각으로 나누지 않고 한 묶음으로 다 담는다  E11 서로 가리키는 보관 표 둘(순환) — 함께 지운다
import "../../scripts/test-apps-root.mjs";   // #4778 앱 폴더 자리를 임시 폴더로 — 앱을 만들고 지우는 시험이 실제 ~/apps 를 옮기지 않게
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
  const r7 = await removeInstalledApp(appY, { actor: "pgt-boss", source: "seed" }, "retire");   // #4778 입구 이름(시더의 은퇴 회수)
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

  // ── E1 서로 외래키로 묶인 보관 표 — 부모(accounts) 이름이 앞서도 앱 지우기가 둘 다 지운다 ──
  await save("fk-app", [{ name: "accounts", columns: [{ name: "name", type: "text" }] },
    { name: "orders", columns: [{ name: "account_id", type: "bigint", references: { table: "accounts" } }, { name: "memo", type: "text" }] }, { name: "notes", columns: [{ name: "v", type: "text" }] }]);
  await call("me_app_grant", { app_id: "fk-app" }, alice);
  const acc = await asApp("store_insert", { table: "accounts", row: { name: "a1" } }, alice, "fk-app");
  await asApp("store_insert", { table: "orders", row: { account_id: acc.id, memo: "o1" } }, alice, "fk-app");
  await save("fk-app", [{ name: "notes", columns: [{ name: "v", type: "text" }] }]);
  const fkArch = await archiveNames("fk_app__");
  const fkLinked = (await q(`SELECT count(*)::int AS n FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace WHERE con.contype = 'f' AND n.nspname = 'app_archive'`))[0].n;
  const e1 = await call("org_app_remove", { app_id: "fk-app" }, boss);
  chk("E1 외래키로 묶인 보관 표 둘(부모 이름이 앞섬) — 앱 지우기가 둘 다 지운다 · 남긴 것 없음",
    fkArch.length === 2 && fkLinked >= 1 && e1.archives?.cleared?.length === 2 && e1.archives?.kept?.length === 0 && (await archiveNames("fk_app__")).length === 0,
    JSON.stringify({ fkArch, fkLinked, archives: e1.archives }));

  // ── E2 규칙 밖 이름 하나가 목록 · 비우기를 죽이지 않는다 ──
  await legacy("old-backup");
  const e2list = await call("app_archives", {}, boss);
  const e2row = e2list.archives.find((a) => a.name === "old-backup");
  const e2 = await call("app_archive_clear", { names: ["old-backup"] }, boss);
  chk("E2 사람이 옮겨 둔 old-backup — 목록에 주인 모름으로 보이고(행 수 셈) · 이름으로 비워진다",
    e2row?.owner === "unknown" && e2row?.rows === 1 && e2.cleared.map((c) => c.name).join() === "old-backup" && !(await exists("app_archive", "old-backup")),
    JSON.stringify({ e2row, e2 }));

  // ── E3 1,000행 넘는 보관 표 — 조각 셋 ──
  await q(`CREATE TABLE app_archive."big_app__t__20250101000000" (tenant_id uuid, id bigint, title text, created_at timestamptz DEFAULT now())`);
  await q(`INSERT INTO app_archive."big_app__t__20250101000000"(tenant_id, id, title) SELECT '00000000-0000-0000-0000-000000000000', g, 'v' || g FROM generate_series(1, 2500) g`);
  const e3 = await call("app_archive_clear", { names: ["big_app__t__20250101000000"] }, boss);
  const e3chunks = await q(`SELECT chunk, row_count, jsonb_array_length(rows) AS len FROM org_app_snapshot WHERE app_id = 'big-app' AND table_name = 'archive:big_app__t__20250101000000' ORDER BY chunk`);
  chk("E3 2,500행 — 조각 셋(1000 · 1000 · 500)으로 백업 · 행 수 그대로 · 지움",
    e3chunks.map((c) => `${c.chunk}:${c.row_count}:${c.len}`).join() === "0:1000:1000,1:1000:1000,2:500:500" && e3.cleared[0]?.rows === 2500 && !(await exists("app_archive", "big_app__t__20250101000000")),
    JSON.stringify({ e3chunks, e3 }));

  // ── E4 force — 너무 커도 백업 없이 지운다 ──
  await legacy("forced_app__t__20250101000000");
  process.env.LIVELY_APP_SNAPSHOT_MAX_BYTES = "1";
  const e4no = await call("app_archive_clear", { names: ["forced_app__t__20250101000000"] }, boss);
  const e4 = await call("app_archive_clear", { names: ["forced_app__t__20250101000000"], force: true }, boss);
  delete process.env.LIVELY_APP_SNAPSHOT_MAX_BYTES;
  chk("E4 너무 크면 force 없이는 남기고, force 면 백업 없이 지운다(백업 시각 없음 · 묶음 행 없음)",
    e4no.kept.length === 1 && e4no.cleared.length === 0 && e4.cleared.length === 1 && e4.taken_at === null && !(await exists("app_archive", "forced_app__t__20250101000000"))
      && (await q(`SELECT 1 FROM org_app_snapshot WHERE table_name = 'archive:forced_app__t__20250101000000'`)).length === 0,
    JSON.stringify({ e4no, e4 }));

  // ── E5 크기 아닌 까닭으로 백업 실패 — 한 트랜잭션이라 하나도 안 담기고 하나도 안 지운다 ──
  await legacy("blk_app__blocker__20250101000000");
  await legacy("blk_app__sibling__20250101000000");
  await q(`ALTER TABLE org_app_snapshot ADD CONSTRAINT pgt_block_4733 CHECK (table_name NOT LIKE 'archive:%blocker%')`);
  const e5 = await call("app_archive_clear", { names: ["blk_app__sibling__20250101000000", "blk_app__blocker__20250101000000"] }, boss);
  await q(`ALTER TABLE org_app_snapshot DROP CONSTRAINT pgt_block_4733`);
  chk("E5 백업이 실패하면(제약 위반) 둘 다 남기고 까닭 · 앞서 담긴 sibling 의 백업도 되돌려졌다",
    e5.cleared.length === 0 && e5.kept.length === 2 && e5.kept.every((k) => /백업하지 못했습니다/.test(k.why)) && e5.taken_at === null
      && (await exists("app_archive", "blk_app__blocker__20250101000000")) && (await exists("app_archive", "blk_app__sibling__20250101000000"))
      && (await q(`SELECT 1 FROM org_app_snapshot WHERE table_name LIKE 'archive:blk_app__%'`)).length === 0, JSON.stringify(e5));

  // ── E6 지금 쓰는 표가 보관 표를 가리키면 — CASCADE 없이 남기고 까닭 ──
  await q(`CREATE TABLE app_archive."ref_app__target__20250101000000" (tenant_id uuid, id bigint PRIMARY KEY, title text, created_at timestamptz DEFAULT now())`);
  await q(`CREATE TABLE app."ref_app__live" (x bigint REFERENCES app_archive."ref_app__target__20250101000000"(id))`);
  const e6 = await call("app_archive_clear", { names: ["ref_app__target__20250101000000"] }, boss);
  const liveFk = (await q(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = to_regclass('app."ref_app__live"') AND contype = 'f'`))[0].n;
  chk("E6 쓰는 표가 가리키는 보관 표는 지우지 못하고 kept 에 까닭 · 쓰는 표의 외래키는 그대로(CASCADE 안 함)",
    e6.cleared.length === 0 && e6.kept.length === 1 && /지우지 못했습니다/.test(e6.kept[0].why) && liveFk === 1 && (await exists("app_archive", "ref_app__target__20250101000000")),
    JSON.stringify({ e6, liveFk }));
  await q(`DROP TABLE app."ref_app__live"`);

  // ── E7 주인 모름의 백업 · E9 감사 ──
  const e7 = await call("app_archive_clear", { names: [unknownName] }, boss);
  const e7snap = await q(`SELECT app_id, reason, row_count FROM org_app_snapshot WHERE table_name = $1`, [`archive:${unknownName}`]);
  chk("E7 주인 모름 보관 표의 백업은 app_id '~unknown' 으로 골라 볼 수 있다",
    e7.cleared.length === 1 && e7snap.length === 1 && e7snap[0].app_id === "~unknown" && e7snap[0].reason === "before-clear" && e7snap[0].row_count === 1
      && (await call("app_data_snapshots", { app_id: "~unknown" }, boss)).snapshots.some((x) => x.tables.some((t) => t.table === `archive:${unknownName}` && t.archive === true)),
    JSON.stringify({ e7, e7snap }));
  const aud = (await q(`SELECT entity_key, op, before, after, actor FROM org_content_audit WHERE entity = 'app_archive' ORDER BY id`));
  chk("E9 비우기는 감사에 남는다(누가 · 무엇을 지웠고 무엇이 남았나) — 아무것도 안 한 비우기(C2)는 안 남긴다",
    aud.length >= 6 && aud.every((a) => a.op === "clear" && a.actor === "pgt-boss") && aud.some((a) => a.after?.cleared?.some((c) => c.name === unknownName))
      && aud.some((a) => a.entity_key === "keep") && !aud.some((a) => (a.before?.names ?? []).includes("keep__items")),
    JSON.stringify(aud.map((a) => [a.entity_key, a.before?.names, (a.after?.cleared ?? []).length, (a.after?.kept ?? []).length])));

  // ── E8 names 가 배열이 아니면 400(REST 는 zod 를 거치지 않는다 — app_id 와 함께 와도 그 앱 것을 다 지우지 않는다) ──
  const e8 = await errOf(call("app_archive_clear", { names: "crm_x__deals__20250101000000", app_id: "crm-x" }, boss));
  chk("E8 names 가 문자열이면 400 · 아무것도 안 지움", e8?.status === 400 && (await exists("app_archive", "crm_x__deals__20250101000000")), JSON.stringify([e8?.status, e8?.message]));

  // ── E10 id 가 겹치거나 빈 표 — 1,510행을 다 담는다(조각으로 나누면 1,000행만 담고 지웠다 — 재검토 실측) ──
  await q(`CREATE TABLE app_archive."dup_app__t__20250101000000" (tenant_id uuid, id bigint, title text, created_at timestamptz DEFAULT now())`);
  await q(`INSERT INTO app_archive."dup_app__t__20250101000000"(tenant_id, id, title) SELECT '00000000-0000-0000-0000-000000000000', 1, 'v' || g FROM generate_series(1, 1500) g`);
  await q(`INSERT INTO app_archive."dup_app__t__20250101000000"(tenant_id, id, title) SELECT '00000000-0000-0000-0000-000000000000', NULL, 'n' || g FROM generate_series(1, 10) g`);
  const e10 = await call("app_archive_clear", { names: ["dup_app__t__20250101000000"] }, boss);
  const e10snap = await q(`SELECT sum(row_count)::int AS n, sum(jsonb_array_length(rows))::int AS len FROM org_app_snapshot WHERE table_name = 'archive:dup_app__t__20250101000000'`);
  chk("E10 id 가 겹치거나 빈 표 — 1,510행을 한 묶음으로 다 담고 지운다(응답 행 수도 1,510)",
    e10.cleared[0]?.rows === 1510 && e10snap[0]?.n === 1510 && e10snap[0]?.len === 1510 && !(await exists("app_archive", "dup_app__t__20250101000000")),
    JSON.stringify({ e10, e10snap }));

  // ── E11 서로 가리키는 보관 표 둘(순환) — 한 문장으로 함께 지운다 ──
  await q(`CREATE TABLE app_archive."cyc_app__a__20250101000000" (id bigint PRIMARY KEY, b_id bigint)`);
  await q(`CREATE TABLE app_archive."cyc_app__b__20250101000000" (id bigint PRIMARY KEY, a_id bigint REFERENCES app_archive."cyc_app__a__20250101000000"(id))`);
  await q(`ALTER TABLE app_archive."cyc_app__a__20250101000000" ADD FOREIGN KEY (b_id) REFERENCES app_archive."cyc_app__b__20250101000000"(id)`);
  const e11 = await call("app_archive_clear", { app_id: "cyc-app" }, boss);
  chk("E11 서로 가리키는 보관 표 둘 — 둘 다 지운다(남긴 것 없음)",
    e11.cleared.length === 2 && e11.kept.length === 0 && (await archiveNames("cyc_app__")).length === 0, JSON.stringify(e11));

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
