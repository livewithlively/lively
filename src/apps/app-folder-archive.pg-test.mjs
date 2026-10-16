// 앱 폴더 보관(#4778) PG 통합 테스트 — **실제 Postgres 필요**(CI services:postgres 스텝 — .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-folder-archive.pg-test.mjs
//
// 사양 표(태스크 #4778 + 상민님 결정 2026-10-16) E · F · G · H · I · J — 진짜 DB(initAllSchemas) · 진짜 앱 자리(임시 폴더 — 비격리 셀프호스트 모양) ·
//  진짜 게이트웨이(서명 주소 받는 곳 · 홈 탐색기 · 능력 REST). 순수 판정 · 파일 op · 배선은 app-folder-archive.test.ts.
//  E1 관리자 제거 → apps/<앱> 없음 · 보관에 같은 바이트 · 기록(remove · 누가 · 크기) · 응답 app_folder   E2 나만 보는 앱 지우기 → discard
//  E4 앱 폴더 없음 → archived null · 기록 없음   E5 옮기기 실패 → 앱은 지워지고 까닭 · 폴더 그 자리   E6 기본 앱 은퇴 회수(retire)도 옮긴다
//  F1 빈 예약 거두기 → 폴더 보관(draft-drop)   F2 내용 있는 앱엔 아무것도 안 함   F3 오래된 빈 예약만(일수)
//  G1 app_save 새 id · 남은 폴더 → 보관(create) · 새 앱 폴더 빔   G2 관리자 설치 새 id → 보관(create)   G4 갱신은 폴더 그대로
//  G5 남은 폴더를 못 옮기면 503 · 앱 행 없음   G7 지운 뒤 같은 id 로 다시 → 옛 파일 서명 주소 GET 404 · 탐색기 빈 목록
//  I1 목록(보관 · 고아 · 파일만 있던 보관은 기록으로)   I2 비우기(missing · was_missing · 감사)   I3 되돌리기(앱 없음 409 · 되돌림 · 파일 있음 409 · 보관 없음 410)
//  I4 고아 옮기기   I5 관리자 아님 403   I6 REST 모양 400   J1 탐색기로 보관 — 없는 앱 폴더의 빈 목록(#4847)   J2 서명 주소로 보관 400
//  H1 기간 지난 것만   H2 경계(정확히 기간) 남김   H3 지울 것 없음(파일을 만지지 않음)   H4 파일 없는 기록 걷기   H5 보관 일수 0 → 전부
//  H6 못 지우는 보관은 기록이 남는다(정비 · 비우기) · 다음 정비가 이어서   H7 한 번에 오래된 것부터 20개
//  H8 못 지운 보관은 뒤로(까닭 · 시각) — 안 해 본 보관이 먼저   I3b 보관 기간이 지난 보관은 되돌리지 않는다   I3c 지우다 멈춘 보관도
//  S1 앞선 모양의 표(두 칸 없이 만든 표)에 스키마 초기화 → 칸이 붙는다
import pg from "pg";
import http from "node:http";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, chmodSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_folder_4778";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
process.env.ITEMS_DATABASE_URL = dsnFor(DB);

const ROOT = mkdtempSync(path.join(os.tmpdir(), "lively-app-folder-pg-"));
const APPS = path.join(ROOT, "apps");
process.env.LIVELY_MEMBER_ISOLATION = "off";
delete process.env.LIVELY_MEMBER_EXEC;
process.env.TERMINAL_ROOT_SHARED = path.join(ROOT, "shared");
process.env.TERMINAL_ROOT_APPS = APPS;
process.env.TERMINAL_ROOT_PERSONAL = path.join(ROOT, "box");
for (const d of ["shared", "apps", "box"]) mkdirSync(path.join(ROOT, d), { recursive: true });
process.env.CONNECTOR_SECRET_KEY = crypto.randomBytes(32).toString("hex");
delete process.env.LIVELY_APP_SNAPSHOT_DAYS;   // 보관 일수 기본 7

const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const express = (await import("express")).default;
const { registerWebUi } = await import(`${D}/web.js`);
const { registerTerminalFiles } = await import(`${D}/terminal/terminal-files.js`);
const { BearerVerifier } = await import(`${D}/auth/bearer.js`);
const { fileUrlRouter } = await import(`${D}/files/signed-routes.js`);
const { liveSignedRouteDeps } = await import(`${D}/files/files-live.js`);
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
const { upsertMember } = await import(`${D}/org/store/members.js`);
const { mintToken } = await import(`${D}/org/store/tokens.js`);
const store = await import(`${D}/org/store/apps.js`);
const { removeInstalledApp, dropEmptyDraft, dropStaleDrafts } = await import(`${D}/apps/remove-run.js`);
const AF = await import(`${D}/apps/app-folder-archive.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const cap = (n) => { const c = appCapabilities.find((x) => x.name === n); if (!c) throw new Error(`능력 없음: ${n}`); return c; };

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const DAY = 24 * 60 * 60 * 1000;
const admin = { userId: "pgt-admin", email: "a@x", scopes: ["admin", "items"] };
const maker = { userId: "pgt-maker", email: "m@x", scopes: ["items"] };
const call = (n, input, who, ctx = { source: "mcp" }) => cap(n).handler(input, who, ctx);
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const manifestOf = (id) => JSON.stringify({ id, title: id, version: "0.1.0", permissions: { app_folder: true }, ui: { pages: [{ key: "main", title: id, entry: "ui/index.html" }] } });
const filesOf = (id, html = "<p>x</p>") => [{ path: "lively-app.json", content: manifestOf(id) }, { path: "ui/index.html", content: html }];
const install = (id, html) => call("org_app_install", { source: { kind: "inline", files: filesOf(id, html) } }, admin);
const put = (rel, body) => { const f = path.join(APPS, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, body); };
const has = (rel) => { try { lstatSync(path.join(APPS, rel)); return true; } catch { return false; } };
const readOr = (rel, enc) => { try { return readFileSync(path.join(APPS, rel), enc); } catch { return null; } };   // 없으면 null(행이 빨개지게 — 예외로 멈추지 않게)
const archivesOf = (app) => q(`SELECT * FROM org_app_folder_archive WHERE app_id=$1 ORDER BY archived_at, name`, [app]);
const appRow = async (id) => (await q(`SELECT id FROM org_app WHERE id=$1`, [id]))[0] ?? null;

let server = null;
try {
  await upsertMember({ id: "pgt-admin", display_name: "관리자", state: "active", scopes: ["admin", "items"] }, "pgt");
  await upsertMember({ id: "pgt-user", display_name: "사용자", state: "active", scopes: ["items"] }, "pgt");
  await upsertMember({ id: "pgt-maker", display_name: "만드는 사람", state: "active", scopes: ["items"] }, "pgt");
  const adminTok = (await mintToken({ userId: "pgt-admin", memberId: "pgt-admin", scopes: ["admin", "items"] }, "pgt")).token;
  const userTok = (await mintToken({ userId: "pgt-user", memberId: "pgt-user", scopes: ["items"] }, "pgt")).token;

  const gw = express();
  gw.use("/api/files/s", fileUrlRouter(liveSignedRouteDeps));
  gw.use(express.json({ limit: "1mb" }));
  const verifier = new BearerVerifier();
  registerWebUi(gw, verifier);
  registerTerminalFiles(gw, verifier);
  server = http.createServer(gw);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const GW = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_URL = GW;
  const req = (method, p, tok, body) => fetch(GW + p, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const mintAs = (tok, address, method = "GET") => req("POST", "/api/ui/files/url", tok, { address, method });
  const grant = (id, who = { userId: "pgt-user", scopes: ["items"] }) => call("me_app_grant", { app_id: id }, who);

  // ── S1 앞선 모양의 표 — last_try_at · last_error 를 더하기 전에 만든 표(개발 · 시험 DB)에 스키마 초기화를 다시 돌리면 칸이 붙고 정비가 돈다 ──
  await q(`ALTER TABLE org_app_folder_archive DROP COLUMN IF EXISTS last_try_at, DROP COLUMN IF EXISTS last_error`);
  await initAllSchemas({ quiet: true });
  const s1cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'org_app_folder_archive'`)).map((r) => r.column_name);
  const s1prune = await AF.pruneAppFolderArchives(new Date(), 7).then(() => "ok", (e) => String(e?.message ?? e));
  chk("S1 앞선 모양의 표(두 칸 없이 만든 표)에 스키마 초기화를 다시 돌리면 칸이 붙고 정비가 돈다",
    s1cols.includes("last_try_at") && s1cols.includes("last_error") && s1prune === "ok", JSON.stringify({ s1cols, s1prune }));

  // ── E1 관리자 제거 ──
  await install("ef-remove");
  const bytesE1 = crypto.randomBytes(5000);
  put("ef-remove/out/data.bin", bytesE1);
  put("ef-remove/notes/n.txt", "노트");
  const e1 = await call("org_app_remove", { app_id: "ef-remove" }, admin);
  const e1rows = await archivesOf("ef-remove");
  const e1name = e1?.app_folder?.archived;
  chk("E1 관리자 제거 → apps/<앱> 없음 · 보관에 같은 바이트 · 기록(remove · 누가 · 크기) · 응답 app_folder",
    !has("ef-remove") && typeof e1name === "string" && e1name.startsWith(".archived-app.ef-remove.")
    && readFileSync(path.join(APPS, e1name, "out/data.bin")).equals(bytesE1)
    && e1rows.length === 1 && e1rows[0].name === e1name && e1rows[0].entry === "remove" && e1rows[0].archived_by === "pgt-admin"
    && Number(e1rows[0].files) === 2 && Number(e1rows[0].bytes) === 5000 + Buffer.byteLength("노트") && e1rows[0].truncated === false
    && e1.app_folder.files === 2 && !(await appRow("ef-remove")),
    JSON.stringify({ app_folder: e1?.app_folder, rows: e1rows, left: existsSync(path.join(APPS, "ef-remove")) }));

  // ── E2 나만 보는 앱 지우기 ──
  await call("app_save", { files: filesOf("ef-discard") }, maker);
  put("ef-discard/a.txt", "a");
  const e2 = await call("app_draft_remove", { app_id: "ef-discard" }, maker);
  const e2rows = await archivesOf("ef-discard");
  chk("E2 나만 보는 앱 지우기 → 보관(discard · 지운 사람)", !has("ef-discard") && e2rows.length === 1 && e2rows[0].entry === "discard"
    && e2rows[0].archived_by === "pgt-maker" && e2?.app_folder?.archived === e2rows[0].name, JSON.stringify({ e2: e2?.app_folder, e2rows }));

  // ── E4 앱 폴더 없음 ──
  await install("ef-nofolder");
  const e4 = await call("org_app_remove", { app_id: "ef-nofolder" }, admin);
  chk("E4 앱 폴더 없음 → archived null · 기록 없음 · 아무것도 안 생김", e4?.app_folder?.archived === null && !e4.app_folder.error
    && (await archivesOf("ef-nofolder")).length === 0 && !readdirSync(APPS).some((n) => n.includes("ef-nofolder")), JSON.stringify(e4?.app_folder));

  // ── E5 옮기기 실패 → 지우기는 끝나고 까닭 · 폴더 그 자리 ──
  await install("ef-stuck");
  put("ef-stuck/keep.txt", "keep");
  chmodSync(APPS, 0o555);
  let e5;
  try { e5 = await call("org_app_remove", { app_id: "ef-stuck" }, admin); }
  catch (e) { e5 = { thrown: String(e?.message ?? e) }; }   // 지우기가 던지면 이 행이 빨개지게(사양: 옮기기 실패는 지우기를 막지 않는다)
  finally { chmodSync(APPS, 0o755); }
  chk("E5 옮기기 실패 → 앱 행은 지워짐 · 응답 app_folder.error · 폴더는 그 자리(고아)", !(await appRow("ef-stuck")) && e5?.ok === true
    && e5.app_folder?.archived === null && typeof e5.app_folder?.error === "string" && e5.app_folder.error.length > 0
    && readFileSync(path.join(APPS, "ef-stuck/keep.txt"), "utf8") === "keep" && (await archivesOf("ef-stuck")).length === 0, JSON.stringify(e5?.app_folder));

  // ── E6 기본 앱(빌트인 원본)의 은퇴 회수 ──
  await store.upsertApp({ id: "ef-builtin", title: "기본", version: "1.0.0", manifest: { id: "ef-builtin", title: "기본", version: "1.0.0" }, source: { kind: "builtin" }, content_hash: "h", status: "active" }, { actor: "system", source: "migration" });
  put("ef-builtin/b.txt", "builtin");
  const e6 = await removeInstalledApp(await store.getApp("ef-builtin"), { actor: "system", source: "migration" }, "retire");
  const e6rows = await archivesOf("ef-builtin");
  chk("E6 기본 앱 은퇴 회수도 앱 폴더를 옮긴다(retire · 누가 system)", !has("ef-builtin") && e6rows.length === 1 && e6rows[0].entry === "retire"
    && e6rows[0].archived_by === "system" && e6.app_folder.archived === e6rows[0].name, JSON.stringify({ e6: e6.app_folder, e6rows }));

  // ── F1 빈 예약 거두기 ──
  await store.reserveDraftApp({ id: "ff-draft", title: "빈 예약", made_by: "pgt-maker", build_session: null, origin_app_id: null });
  put("ff-draft/leftover.txt", "x");
  const f1 = await dropEmptyDraft("ff-draft", "pgt-maker");
  const f1rows = await archivesOf("ff-draft");
  chk("F1 빈 예약 거두기 → 행 없음 · 폴더 보관(draft-drop)", f1 === true && !(await appRow("ff-draft")) && !has("ff-draft")
    && f1rows.length === 1 && f1rows[0].entry === "draft-drop" && f1rows[0].archived_by === "pgt-maker", JSON.stringify({ f1, f1rows }));

  // ── F2 내용 있는 앱엔 아무것도 안 함 ──
  await install("ff-full");
  put("ff-full/a.txt", "a");
  const f2 = await dropEmptyDraft("ff-full", "pgt-maker");
  chk("F2 내용 있는 앱 → 안 지움 · 폴더 그대로 · 기록 없음", f2 === false && !!(await appRow("ff-full")) && has("ff-full/a.txt")
    && (await archivesOf("ff-full")).length === 0, JSON.stringify({ f2 }));

  // ── F3 오래된 빈 예약만 ──
  await store.reserveDraftApp({ id: "ff-stale", title: "오래된", made_by: "pgt-maker", build_session: null, origin_app_id: null });
  await store.reserveDraftApp({ id: "ff-fresh", title: "최근", made_by: "pgt-maker", build_session: null, origin_app_id: null });
  await q(`UPDATE org_app SET installed_at = now() - interval '4 days' WHERE id='ff-stale'`);
  put("ff-stale/s.txt", "s");
  put("ff-fresh/f.txt", "f");
  const f3 = await dropStaleDrafts("pgt-maker", 3);
  chk("F3 오래된 빈 예약만 거두고 그 폴더를 보관 · 최근 것 · 내용 있는 앱은 그대로",
    JSON.stringify(f3) === JSON.stringify(["ff-stale"]) && !(await appRow("ff-stale")) && !has("ff-stale") && (await archivesOf("ff-stale"))[0]?.entry === "draft-drop"
    && !!(await appRow("ff-fresh")) && has("ff-fresh/f.txt") && !!(await appRow("ff-full")), JSON.stringify(f3));

  // ── G1 app_save 새 id · 남은 폴더 ──
  put("gg-save/old/secret.txt", "옛 앱의 파일");
  await call("app_save", { files: filesOf("gg-save") }, maker);
  const g1rows = await archivesOf("gg-save");
  chk("G1 app_save 새 id · 남은 폴더 → 보관(create · 만든 사람) · 새 앱 폴더는 빈 채로",
    !!(await appRow("gg-save")) && !has("gg-save") && g1rows.length === 1 && g1rows[0].entry === "create" && g1rows[0].archived_by === "pgt-maker"
    && readFileSync(path.join(APPS, g1rows[0].name, "old/secret.txt"), "utf8") === "옛 앱의 파일", JSON.stringify(g1rows));

  // ── G2 관리자 설치 새 id ──
  put("gg-install/old.txt", "old");
  await install("gg-install");
  const g2rows = await archivesOf("gg-install");
  chk("G2 관리자 설치 새 id · 남은 폴더 → 보관(create)", !has("gg-install") && g2rows.length === 1 && g2rows[0].entry === "create" && g2rows[0].archived_by === "pgt-admin",
    JSON.stringify(g2rows));

  // ── G4 갱신은 폴더 그대로 ──
  put("gg-install/new.txt", "새 앱이 쓴 것");
  await install("gg-install", "<p>v2</p>");
  await call("app_save", { files: filesOf("gg-save", "<p>v2</p>") }, maker);
  put("gg-save/mine.txt", "새 앱이 쓴 것");
  await call("app_save", { files: filesOf("gg-save", "<p>v3</p>") }, maker);
  chk("G4 이미 있는 앱 갱신(관리자 설치 · app_save) → 앱 폴더 그대로 · 새 보관 없음",
    has("gg-install/new.txt") && has("gg-save/mine.txt") && (await archivesOf("gg-install")).length === 1 && (await archivesOf("gg-save")).length === 1);

  // ── G5 남은 폴더를 못 옮기면 만들지 않는다 ──
  put("gg-blocked/x.txt", "x");
  chmodSync(APPS, 0o555);
  let g5;
  try { g5 = await errOf(install("gg-blocked")); } finally { chmodSync(APPS, 0o755); }
  const g5save = await (async () => { chmodSync(APPS, 0o555); try { return await errOf(call("app_save", { files: filesOf("gg-blocked") }, maker)); } finally { chmodSync(APPS, 0o755); } })();
  chk("G5 남은 폴더를 못 옮기면 503 · 앱 행 안 생김(관리자 설치 · app_save) · 폴더 그대로", g5?.status === 503 && g5save?.status === 503 && !(await appRow("gg-blocked"))
    && has("gg-blocked/x.txt"), JSON.stringify({ g5: g5?.status ?? g5?.message, g5save: g5save?.status ?? g5save?.message }));

  // ── G7 지운 뒤 같은 id 로 다시 → 옛 파일에 닿지 않는다 ──
  await install("gg-again");
  await grant("gg-again");
  put("gg-again/doc.txt", "옛 문서");
  const before = await (await mintAs(userTok, "apps/gg-again/doc.txt")).json();
  const beforeBody = before.url ? await (await fetch(before.url)).text() : null;
  await call("org_app_remove", { app_id: "gg-again" }, admin);
  await install("gg-again");
  await grant("gg-again");
  const after = await mintAs(userTok, "apps/gg-again/doc.txt");
  const afterBody = await after.json();
  const afterGet = afterBody.url ? await fetch(afterBody.url) : null;
  const oldUrlGet = before.url ? await fetch(before.url) : null;
  const list = await (await req("GET", "/api/ui/terminal/browse?root=apps&path=gg-again", userTok)).json();
  chk("G7 지운 뒤 같은 id 로 다시 만듦 → 옛 파일: 새 서명 주소 GET 404 · 옛 서명 주소 GET 404 · 탐색기 빈 목록",
    beforeBody === "옛 문서" && after.status === 200 && afterGet?.status === 404 && oldUrlGet?.status === 404
    && (list.items ?? []).length === 0 && (list.dirs ?? []).length === 0,
    JSON.stringify({ beforeBody, after: after.status, afterGet: afterGet?.status, oldUrlGet: oldUrlGet?.status, list }));

  // ── I1 목록 ──
  put("orph-one/f.txt", "orphan!");
  const fsOnly = ".archived-app.fs-only.20261001T000000Z.abcdef";
  put(`${fsOnly}/f.txt`, "fs only");
  const l1 = await call("app_folder_archives", {}, admin);
  const itemOf = (name) => l1.archives.find((a) => a.name === name);
  const e1item = itemOf(e1name);
  const fsItem = itemOf(fsOnly);
  const fsRow = (await q(`SELECT * FROM org_app_folder_archive WHERE name=$1`, [fsOnly]))[0];
  chk("I1 목록 — 보관(크기 · 입구 · 누가 · 기한 · app_exists) · 고아(크기) · 파일만 있던 보관은 unknown 으로 기록된다",
    l1.keep_days === 7 && e1item?.entry === "remove" && e1item?.files === 2 && e1item?.archived_by === "pgt-admin" && e1item?.app_exists === false
    && e1item?.expires_at === new Date(new Date(e1item.archived_at).getTime() + 7 * DAY).toISOString() && !e1item?.missing
    && itemOf(g1rows[0].name)?.app_exists === true
    && fsItem?.entry === "unknown" && fsItem?.archived_at === "2026-10-01T00:00:00.000Z" && fsItem?.files === 1 && fsRow?.entry === "unknown"
    && l1.orphans.some((o) => o.app_id === "orph-one" && o.files === 1 && o.bytes === 7) && l1.orphans.some((o) => o.app_id === "ef-stuck")
    && !l1.orphans.some((o) => ["gg-install", "gg-save", "ff-full", "ff-fresh"].includes(o.app_id)),
    JSON.stringify({ e1item, fsItem, fsRow, orphans: l1.orphans }));

  // ── J 보관은 apps 주소 · 탐색기로 닿지 않는다 ──
  await grant("gg-install");
  //  보관 자리로 들어가면 없는 앱 폴더와 같은 빈 목록이다(#4847 — 못 봄 · 없음은 같은 답) — 보관 안의 이름이 하나도 안 나온다.
  const j1 = await req("GET", `/api/ui/terminal/browse?root=apps&path=${encodeURIComponent(e1name)}`, userTok);
  const j1body = await j1.json();
  const j1none = await (await req("GET", `/api/ui/terminal/browse?root=apps&path=${encodeURIComponent("no-such-app-4847")}`, userTok)).json();
  const j1top = await (await req("GET", "/api/ui/terminal/browse?root=apps&path=", userTok)).json();
  const j2 = await mintAs(userTok, `apps/${e1name}/out/data.bin`);
  const j2admin = await mintAs(adminTok, `apps/${e1name}/out/data.bin`);
  const sansPath = (b) => JSON.stringify({ ...b, path: undefined, parent: undefined });
  chk("J1 탐색기 root=apps 로 보관 — 없는 앱 폴더와 같은 빈 목록 · 맨 위 목록에 보관 이름 없음",
    j1.status === 200 && (j1body.items ?? [null]).length === 0 && sansPath(j1body) === sansPath(j1none) && !(j1top.dirs ?? []).some((d) => d.startsWith(".")),
    JSON.stringify({ j1: j1.status, j1body, j1none, top: j1top.dirs }));
  chk("J2 서명 주소 apps/<보관 이름>/… → 400(관리자도)", j2.status === 400 && j2admin.status === 400, JSON.stringify([j2.status, j2admin.status]));

  // ── I5 · I6 관리자 아님 · 모양 ──
  const i5 = [
    await req("GET", "/api/ui/app-folder-archives", userTok),
    await req("POST", "/api/ui/app-folder-archives/clear", userTok, { names: [e1name] }),
    await req("POST", "/api/ui/app-folder-archives/restore", userTok, { name: e1name }),
    await req("POST", "/api/ui/app-folder-archives/orphans", userTok, { app_ids: ["orph-one"] }),
  ].map((r) => r.status);
  const i5admin = await req("GET", "/api/ui/app-folder-archives", adminTok);
  chk("I5 관리자 아님 → 네 도구 모두 403 · 관리자는 200", i5.every((s) => s === 403) && i5admin.status === 200 && has(e1name), JSON.stringify({ i5, admin: i5admin.status }));
  const i6 = [
    await req("POST", "/api/ui/app-folder-archives/clear", adminTok, { names: e1name }),
    await req("POST", "/api/ui/app-folder-archives/orphans", adminTok, { app_ids: "orph-one" }),
  ].map((r) => r.status);
  chk("I6 REST 모양이 틀리면(배열 아님) 400 · 아무것도 안 바뀜", i6.every((s) => s === 400) && has(e1name) && has("orph-one"), JSON.stringify(i6));

  // ── I4 고아 옮기기 ──
  const i4 = await call("app_folder_orphans_archive", { app_ids: ["orph-one", "gg-install", "BAD"] }, admin);
  const i4rows = await archivesOf("orph-one");
  chk("I4 고아 → 보관(orphan) · 살아 있는 앱 id 는 건너뜀 · 꼴 아닌 id 건너뜀 · 감사",
    i4.archived.length === 1 && i4.archived[0].app_id === "orph-one" && !has("orph-one") && i4rows[0]?.entry === "orphan"
    && i4.skipped.map((s) => s.app_id).sort().join(",") === "BAD,gg-install" && has("gg-install/new.txt")
    && (await q(`SELECT 1 FROM org_content_audit WHERE entity='app_folder_archive' AND op='archive_orphans'`)).length === 1, JSON.stringify(i4));

  // ── I3 되돌리기 ──
  const i3a = await errOf(call("app_folder_restore", { name: e1name }, admin));
  await install("ef-remove");
  const i3b = await call("app_folder_restore", { name: e1name }, admin).catch((e) => ({ thrown: e?.status ?? String(e?.message ?? e) }));
  const i3bOk = !!readOr("ef-remove/out/data.bin")?.equals(bytesE1) && !has(e1name)
    && (await q(`SELECT 1 FROM org_app_folder_archive WHERE name=$1`, [e1name])).length === 0
    && (await q(`SELECT 1 FROM org_content_audit WHERE entity='app_folder_archive' AND op='restore' AND entity_key='ef-remove'`)).length === 1;
  //  파일 든 앱 폴더 위로는 되돌리지 않는다 — 다시 지워서(보관 둘째) 새 파일을 둔 뒤
  const second = (await call("org_app_remove", { app_id: "ef-remove" }, admin)).app_folder.archived ?? ".archived-app.ef-remove.20000101T000000Z.000000";
  await install("ef-remove");
  put("ef-remove/fresh.txt", "새 앱의 파일");
  const i3c = await errOf(call("app_folder_restore", { name: second }, admin));
  const i3cSame = has(second) && readOr("ef-remove/fresh.txt", "utf8") === "새 앱의 파일" && !has("ef-remove/out/data.bin");
  //  보관이 이미 없으면 410 · 기록도 걷는다
  rmSync(path.join(APPS, second), { recursive: true, force: true });
  const i3d = await errOf(call("app_folder_restore", { name: second }, admin));
  const i3e = await errOf(call("app_folder_restore", { name: "../ef-remove" }, admin));
  chk("I3 되돌리기 — 앱 없음 409 · 앱 폴더 없음 → 되돌림(같은 바이트 · 기록 걷힘 · 감사) · 파일 있음 409(안 바뀜) · 보관 없음 410(기록 걷힘) · 꼴 아님 400",
    i3a?.status === 409 && i3b?.app_id === "ef-remove" && i3bOk && i3c?.status === 409 && i3cSame && i3d?.status === 410
    && (await q(`SELECT 1 FROM org_app_folder_archive WHERE name=$1`, [second])).length === 0 && i3e?.status === 400,
    JSON.stringify({ i3a: i3a?.status, i3b, i3bOk, i3c: i3c?.status, i3cSame, i3d: i3d?.status, i3e: i3e?.status }));

  //  I3c 지우다 멈춘 보관(기간 안)은 되돌리지 않는다 — 비우기가 권한으로 멈춘 보관은 같은 id 의 앱이 있고 그 앱 폴더가 비었어도 409 · 보관 그대로
  const halted = (await call("org_app_remove", { app_id: "ef-remove" }, admin)).app_folder.archived ?? ".archived-app.ef-remove.20000101T000000Z.000001";
  put(`${halted}/keep/k.txt`, "k");
  chmodSync(path.join(APPS, halted, "keep"), 0o555);
  let i3h;
  try { i3h = await call("app_folder_archive_clear", { names: [halted] }, admin); } finally { chmodSync(path.join(APPS, halted, "keep"), 0o755); }
  await install("ef-remove");
  const i3r = await errOf(call("app_folder_restore", { name: halted }, admin));
  chk("I3c 지우다 멈춘 보관(기간 안)은 되돌리지 않는다(409) — 같은 id 의 앱이 있고 앱 폴더가 비었어도 · 보관 그대로",
    !!i3h?.kept?.some((k) => k.name === halted) && i3r?.status === 409 && /지우다 멈춘/.test(i3r?.message ?? "") && has(`${halted}/keep/k.txt`) && !has("ef-remove/keep"),
    JSON.stringify({ kept: i3h?.kept, status: i3r?.status, msg: i3r?.message }));

  // ── I2 비우기 ──
  const clearMe = (await archivesOf("gg-install"))[0].name;
  const goneFs = (await archivesOf("ef-discard"))[0].name;
  rmSync(path.join(APPS, goneFs), { recursive: true });
  const ghost = ".archived-app.nobody.20261002T000000Z.000000";
  const clearAudits = async () => (await q(`SELECT 1 FROM org_content_audit WHERE entity='app_folder_archive' AND op='clear'`)).length;
  const audit0 = await clearAudits();   // 앞선 I3c 의 비우기 감사는 빼고 센다
  const i2 = await call("app_folder_archive_clear", { names: [clearMe, "bogus", goneFs, ghost, fsOnly] }, admin);
  chk("I2 비우기 — 지움 · 꼴 아님 missing · 파일 없는 기록 was_missing · 기록도 파일도 없음 missing · 감사",
    !has(clearMe) && !has(fsOnly) && (await q(`SELECT 1 FROM org_app_folder_archive WHERE name = ANY($1::text[])`, [[clearMe, goneFs, fsOnly]])).length === 0
    && i2.cleared.some((c) => c.name === clearMe && c.app_id === "gg-install" && !c.was_missing)
    && i2.cleared.some((c) => c.name === fsOnly && c.app_id === "fs-only")
    && i2.cleared.some((c) => c.name === goneFs && c.was_missing === true)
    && [...i2.missing].sort().join(",") === [ghost, "bogus"].sort().join(",") && i2.kept.length === 0
    && (await clearAudits()) === audit0 + 1, JSON.stringify(i2));

  // ── H 정비 ──
  const T0 = Date.now();
  put("h-old/a.txt", "a");
  put("h-new/a.txt", "a");
  put("h-edge/a.txt", "a");
  put("h-gone/a.txt", "a");
  const hOld = (await AF.archiveAppFolder("h-old", { by: null, entry: "remove", now: new Date(T0 - 8 * DAY) })).archived;
  const hNew = (await AF.archiveAppFolder("h-new", { by: null, entry: "remove", now: new Date(T0 - 6 * DAY) })).archived;
  const hEdge = (await AF.archiveAppFolder("h-edge", { by: null, entry: "remove", now: new Date(T0 - 7 * DAY) })).archived;
  const hGone = (await AF.archiveAppFolder("h-gone", { by: null, entry: "remove", now: new Date(T0 - 9 * DAY) })).archived;
  rmSync(path.join(APPS, hGone.name), { recursive: true });
  chk("M2 시킨 사람 없이 옮기면(by=null) 기록의 누가 = null", hOld.archived_by === null && (await archivesOf("h-old"))[0]?.archived_by === null,
    JSON.stringify(await archivesOf("h-old")));
  const h1 = await AF.pruneAppFolderArchives(new Date(T0), 7);
  const rowsLeft = async (names) => (await q(`SELECT name FROM org_app_folder_archive WHERE name = ANY($1::text[])`, [names])).map((r) => r.name);
  chk("H1 · H4 기간 지난 것만 지운다(파일 · 기록) · 파일 없는 기록은 기록만 걷는다",
    h1.due === 2 && [...h1.pruned].sort().join(",") === [hOld.name, hGone.name].sort().join(",") && h1.kept.length === 0
    && !has(hOld.name) && has(hNew.name) && (await rowsLeft([hOld.name, hGone.name])).length === 0 && (await rowsLeft([hNew.name])).length === 1,
    JSON.stringify(h1));
  chk("H2 경계 — 정확히 보관 기간만큼 지난 것은 남긴다", has(hEdge.name) && (await rowsLeft([hEdge.name])).length === 1);
  const h2b = await AF.pruneAppFolderArchives(new Date(T0 + 1), 7);
  chk("H2 경계 — 1ms 더 지나면 지운다", JSON.stringify(h2b.pruned) === JSON.stringify([hEdge.name]) && !has(hEdge.name), JSON.stringify(h2b));
  //  H3 — 지울 것이 없으면 파일을 만지지 않는다: apps 자리를 아무도 못 읽게(000) 해 두고 부른다. 파일 op 를 하나라도 부르면 EACCES 로 던진다.
  chmodSync(APPS, 0o000);
  const unreadable = (() => { try { readdirSync(APPS); return false; } catch { return true; } })();   // (전제) root 로 돌면 막히지 않는다
  let h3, tick;
  try {
    h3 = await AF.pruneAppFolderArchives(new Date(T0 + 1), 7).catch((e) => ({ thrown: String(e?.message ?? e) }));
    //  매니지드 틱 단계(REST)가 같은 함수를 부른다 — 결과가 단계 이름 아래 그대로 온다.
    tick = await (await req("POST", "/api/ops/housekeeping/tick", adminTok)).json();
  } finally { chmodSync(APPS, 0o755); }
  chk("H3 지울 것이 없으면 파일을 만지지 않는다(apps 자리를 못 읽게 해도 정상 · due 0) · 아무것도 안 지움",
    unreadable && h3?.due === 0 && h3.pruned.length === 0 && !h3.thrown && has(hNew.name), JSON.stringify({ unreadable, h3 }));
  chk("H 정비 틱 단계 app-folder-archive 가 돈다(지울 것 없음 · 파일 안 만짐)", tick?.steps?.["app-folder-archive"]?.due === 0 && !tick.steps["app-folder-archive"].error,
    JSON.stringify(tick?.steps?.["app-folder-archive"]));
  //  H6 — 못 지우는 보관(하위 폴더에 쓰기 권한 없음)은 기록이 남는다: 정비 · 비우기 둘 다 kept · 다음 정비가 이어서 지운다.
  put("h-stuck/locked/inner.txt", "i");
  const hStuck = (await AF.archiveAppFolder("h-stuck", { by: null, entry: "remove", now: new Date(T0 - 10 * DAY) })).archived;
  chmodSync(path.join(APPS, hStuck.name, "locked"), 0o555);
  let h6p, h6c;
  try {
    h6p = await AF.pruneAppFolderArchives(new Date(T0 + 1), 7);
    h6c = await call("app_folder_archive_clear", { names: [hStuck.name] }, admin);
  } finally { chmodSync(path.join(APPS, hStuck.name, "locked"), 0o755); }
  const stuckRow = async () => (await q(`SELECT 1 FROM org_app_folder_archive WHERE name=$1`, [hStuck.name])).length;
  chk("H6 못 지운 보관 — 정비 · 비우기 모두 kept(까닭) · 기록과 파일이 남는다", h6p.kept.some((k) => k.name === hStuck.name && k.why) && !h6p.pruned.includes(hStuck.name)
    && h6c.kept.some((k) => k.name === hStuck.name && /지우지 못했습니다/.test(k.why)) && !h6c.cleared.some((c) => c.name === hStuck.name)
    && (await stuckRow()) === 1 && has(`${hStuck.name}/locked/inner.txt`), JSON.stringify({ h6p, h6c }));
  const h6n = await AF.pruneAppFolderArchives(new Date(T0 + 1), 7);
  chk("H6 권한이 풀리면 다음 정비가 마저 지운다(기록까지)", h6n.pruned.includes(hStuck.name) && !has(hStuck.name) && (await stuckRow()) === 0, JSON.stringify(h6n));
  //  H7 — 한 번에 오래된 것부터 PRUNE_BATCH(20)개까지 · 남은 것은 다음 정비가.
  const h7 = [];
  for (let i = 0; i < 25; i++) {
    const id = `h7-${String(i).padStart(2, "0")}`;
    put(`${id}/a.txt`, "a");
    h7.push((await AF.archiveAppFolder(id, { by: null, entry: "remove", now: new Date(T0 - (30 + i) * DAY) })).archived.name);
  }
  const h7a = await AF.pruneAppFolderArchives(new Date(T0 + 1), 7);
  const h7b = await AF.pruneAppFolderArchives(new Date(T0 + 1), 7);
  const oldest20 = h7.slice(5).sort();   // i 가 클수록 오래됐다
  chk("H7 한 번에 오래된 것부터 20개 · 다음 정비가 나머지 5개", AF.PRUNE_BATCH === 20 && h7a.due === 25 && [...h7a.pruned].sort().join() === oldest20.join()
    && h7b.due === 5 && [...h7b.pruned].sort().join() === h7.slice(0, 5).sort().join() && h7.every((n) => !has(n)), JSON.stringify({ a: h7a.pruned.length, b: h7b.pruned.length, due: [h7a.due, h7b.due] }));
  //  H8 — 못 지운 보관이 차례를 막지 않는다: 둘(오래된 것)은 못 지우고 하나는 지울 수 있을 때, 한 번에 2개씩이면
  //   첫 정비는 못 지우는 둘을 해 보고(까닭 · 시각을 남김) 둘째 정비는 안 해 본 셋째를 먼저 지운다.
  const hb = [];
  for (const [i, id] of ["hb-one", "hb-two", "hb-three"].entries()) {
    put(`${id}/sub/a.txt`, "a");
    hb.push((await AF.archiveAppFolder(id, { by: null, entry: "remove", now: new Date(T0 - (20 - i) * DAY) })).archived.name);
  }
  for (const n of hb.slice(0, 2)) chmodSync(path.join(APPS, n, "sub"), 0o555);
  let h8a, h8b, h8rows;
  try {
    h8a = await AF.pruneAppFolderArchives(new Date(T0 + 1), 7, 2);
    h8b = await AF.pruneAppFolderArchives(new Date(T0 + 1), 7, 2);
    h8rows = await q(`SELECT name, last_error, last_try_at FROM org_app_folder_archive WHERE name = ANY($1::text[]) ORDER BY name`, [hb.slice(0, 2)]);
  } finally { for (const n of hb.slice(0, 2)) chmodSync(path.join(APPS, n, "sub"), 0o755); }
  chk("H8 못 지운 보관은 까닭 · 시각을 남기고 뒤로 — 다음 정비가 안 해 본 보관을 먼저 지운다(앞줄 막힘 없음)",
    h8a.kept.map((k) => k.name).sort().join() === hb.slice(0, 2).sort().join() && h8a.pruned.length === 0
    && h8b.pruned.includes(hb[2]) && !has(hb[2]) && h8rows.length === 2 && h8rows.every((r) => /지우지 못했습니다/.test(r.last_error ?? "") && r.last_try_at),
    JSON.stringify({ h8a, h8b, h8rows }));
  const l8 = await call("app_folder_archives", {}, admin);
  const it8 = l8.archives.find((a) => a.name === hb[0]);
  chk("H8 목록에 못 지운 까닭 · 기한 지남(expired) · 되돌리기 거절(기한 지남)", it8?.expired === true && /지우지 못했습니다/.test(it8?.last_error ?? ""),
    JSON.stringify(it8));
  const i3x = await errOf(call("app_folder_restore", { name: hb[0] }, admin));
  chk("I3b 보관 기간이 지난 보관은 되돌리지 않는다(409 · 지우는 중)", i3x?.status === 409 && /보관 기간이 지나/.test(i3x?.message ?? "") && has(hb[0]),
    JSON.stringify({ status: i3x?.status, msg: i3x?.message }));
  const totalBefore = (await q(`SELECT count(*)::int AS n FROM org_app_folder_archive`))[0].n;
  const h5 = { pruned: [] };
  for (let i = 0; i < 10; i++) {   // 한 번에 20개까지라 여러 번
    const r = await AF.pruneAppFolderArchives(new Date(Date.now() + 1000), 0);
    h5.pruned.push(...r.pruned);
    if (r.due <= r.pruned.length) break;
  }
  const leftDot = readdirSync(APPS).filter((n) => n.startsWith(".archived-app."));
  chk("H5 보관 일수 0 → 지금보다 앞선 보관 전부(파일 · 기록 · 여러 번에 나눠)", totalBefore > 0 && h5.pruned.length === totalBefore && leftDot.length === 0
    && (await q(`SELECT count(*)::int AS n FROM org_app_folder_archive`))[0].n === 0, JSON.stringify({ totalBefore, h5: h5.pruned.length, leftDot }));
} catch (e) {
  fail++;
  console.error("FAIL (예외)", e);
} finally {
  try { chmodSync(APPS, 0o755); } catch { /* */ }
  if (server) await new Promise((r) => server.close(r));
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end();
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
