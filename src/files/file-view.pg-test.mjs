// 자료 보기(#4672) PG 통합 테스트 — **실제 Postgres 필요**(CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/files/file-view.pg-test.mjs
//
// 한 프로세스에 게이트웨이를 띄운다 — 진짜 인증(구성원 토큰) · 프로젝트 자료 올리기(자료 행이 생긴다) · 홈 탐색기의 정보(browse/info) ·
//  같은 이름 후보(browse/similar). 파일은 임시 폴더. 판정은 응답과 실제 행·디스크로 한다. 사양 표(태스크 #4672 · 스크래치 spec.md):
//   E1 프로젝트 파일 — 정보 · 속한 프로젝트 · 주소 · 자료(올린 사람)        E2 그 프로젝트를 못 보는 사람 — 정보 · 후보 404
//   E3 폴더 · 자리 자신 — 폴더 · 자료 없음                                  E4 없는 경로 404
//   E5 잠긴 공유 폴더 — 대상은 locked · 아닌 사람은 404                     E6 앱 폴더 — 동의한 사람 · 그 앱 이름 · 자료 없음
//   E7 앱은 보이는데 동의 안 함 — 403 app_consent_required(없는 파일이어도 같은 답)
//   E8 안 보이는 앱 · 없는 앱 · 꺼진 앱 — 404                               E9 개인 폴더 — 주소 없음
//   E10 자료를 못 보게 잠긴 자료 — 파일 정보는 그대로 · 자료만 빠진다
//   S1 셸 mv(기록 없음) — 같은 프로젝트 안 새 자리가 후보                    S2 지금 있는 자리 — 후보 없음
//   S3 공유 폴더 — 잠긴 하위 폴더 안 같은 이름은 대상에게만                   S4 다른 프로젝트 폴더의 같은 이름은 범위 밖
//   S5 앱 폴더 — 같은 앱 안 후보 · 동의 안 한 사람 404                       S6 개인 폴더 — 그 사람 폴더 안
import pg from "pg";
import http from "node:http";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_file_view_4672";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
process.env.ITEMS_DATABASE_URL = dsnFor(DB);

const ROOT = mkdtempSync(path.join(os.tmpdir(), "lively-file-view-pg-"));
process.env.LIVELY_MEMBER_ISOLATION = "off";
process.env.TERMINAL_ROOT_SHARED = path.join(ROOT, "shared");
process.env.TERMINAL_ROOT_PERSONAL = path.join(ROOT, "box");
process.env.TERMINAL_ROOT_APPS = path.join(ROOT, "apps");
for (const d of ["shared", "box", "apps"]) mkdirSync(path.join(ROOT, d), { recursive: true });
process.env.CONNECTOR_SECRET_KEY = crypto.randomBytes(32).toString("hex");

const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const express = (await import("express")).default;
const { registerTerminalFiles } = await import(`${D}/terminal/terminal-files.js`);
const { registerProjectV6Routes } = await import(`${D}/project/project-routes.js`);
const { BearerVerifier } = await import(`${D}/auth/bearer.js`);
const { upsertMember } = await import(`${D}/org/store/members.js`);
const { mintToken } = await import(`${D}/org/store/tokens.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const { createProject, getProject, setProjectFolder } = await import(`${D}/v6/project-store.js`);
const { isProjectMember } = await import(`${D}/v6/project-session-store.js`);
const { listProjectActivities } = await import(`${D}/v6/project-activity-store.js`);
const { createProjectFolder } = await import(`${D}/project/project-fs.js`);
const { setSharedFolderAcl } = await import(`${D}/v6/shared-folder-store.js`);
const { invalidateVisibilityCache } = await import(`${D}/v6/visibility.js`);
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
const cap = (n) => appCapabilities.find((c) => c.name === n);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${typeof why === "string" ? why : JSON.stringify(why)}`); } };
const install = (id) => cap("org_app_install").handler({ source: { kind: "inline", files: [
  { path: "lively-app.json", content: JSON.stringify({ id, title: id === "crm" ? "고객 관리" : id, version: "0.1.0", permissions: { app_folder: true }, ui: { pages: [{ key: "main", title: id, entry: "ui/index.html" }] } }) },
  { path: "ui/index.html", content: "<p>x</p>" }] } },
  { userId: "pgt-admin", email: "a@x", scopes: ["admin", "items"] }, { source: "mcp" });

let server = null;
try {
  await upsertMember({ id: "pgt-admin", display_name: "관리자", state: "active", scopes: ["admin", "items"] }, "pgt");
  await upsertMember({ id: "pgt-a", display_name: "가", state: "active", scopes: ["items"] }, "pgt");
  await upsertMember({ id: "pgt-b", display_name: "나", state: "active", scopes: ["items"] }, "pgt");
  const tok = {};
  for (const m of ["pgt-a", "pgt-b"]) tok[m] = (await mintToken({ userId: m, memberId: m, scopes: ["items"] }, "pgt")).token;

  const gw = express();
  gw.use(express.json({ limit: "1mb" }));
  const verifier = new BearerVerifier();
  registerTerminalFiles(gw, verifier);
  registerProjectV6Routes(gw, verifier, {
    getProject: async (id) => { const p = await getProject(id); return p ? { id: p.id, name: p.name, folder: p.folder } : undefined; },
    isProjectMember: (id, m) => isProjectMember(id, m),
    listProjectActivities: (id, a, l, o) => listProjectActivities(id, a, l, o),
    ensureFolder: async (project) => { const folder = await createProjectFolder(project.id); await setProjectFolder(project.id, folder, { source: "web" }); return folder; },
  });
  server = http.createServer(gw);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const GW = `http://127.0.0.1:${server.address().port}`;
  const call = (who, method, url, body, ctype = "application/json") => fetch(GW + url, {
    method, headers: { authorization: `Bearer ${tok[who]}`, ...(body != null ? { "content-type": ctype } : {}) },
    body: body == null ? undefined : ctype === "application/json" ? JSON.stringify(body) : body,
  });
  const q = (o) => new URLSearchParams(o).toString();
  const info = async (who, root, p) => { const r = await call(who, "GET", `/api/ui/terminal/browse/info?${q({ root, path: p })}`); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
  const similar = async (who, root, p) => { const r = await call(who, "GET", `/api/ui/terminal/browse/similar?${q({ root, path: p })}`); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
  const disk = (...p) => path.join(ROOT, ...p);
  const putDisk = (rel, body = "x") => { const abs = disk(rel); mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, body); };

  // ── 준비: 열린 프로젝트(가 · 나 다 본다) · 숨은 프로젝트(가만 본다) ──
  const open = await createProject({ name: "자료 보기 시험", dedupe: false }, { actor: "pgt-a" });
  const P = `/api/ui/v6/projects/${open.id}`;
  await call("pgt-a", "GET", `${P}/files`);                                  // 폴더 만들기(ensureFolder)
  const FOLDER = (await getProject(open.id)).folder;
  const up = await call("pgt-a", "PUT", `${P}/file?${q({ path: "docs/설계.md" })}`, "# 설계\n본문", "application/octet-stream");
  const upj = await up.json();
  chk("준비 — 프로젝트 파일 올리기 → 자료", up.status === 200 && Number(upj.source_id) > 0, upj);
  const SRC = Number(upj.source_id);
  await itemsPool.query(`INSERT INTO knowledge(name, title, body_md) VALUES('pgt-k-4672', '설계 정리', '본문')`);
  await itemsPool.query(`INSERT INTO knowledge_source(name, source_id, relation) VALUES('pgt-k-4672', $1, 'derived_from'), ('pgt-k-4672', $1, 'cites')`, [SRC]);

  const L = Number((await itemsPool.query(`INSERT INTO project_list(name, visibility) VALUES('pgt 숨은 리스트', 'members') RETURNING id`)).rows[0].id);
  await itemsPool.query(`INSERT INTO project_list_member(list_id, member_id) VALUES($1, 'pgt-a')`, [L]);
  const hidden = await createProject({ name: "숨은 프로젝트", dedupe: false, list_id: L }, { actor: "pgt-a" });
  const HF = await createProjectFolder(hidden.id); await setProjectFolder(hidden.id, HF, { source: "web" });
  putDisk(path.join("shared", HF, "숨은.md"));
  invalidateVisibilityCache();

  // ── E1 ──
  const e1 = await info("pgt-b", "shared", `${FOLDER}/docs/설계.md`);
  chk("E1a 다른 구성원이 열면 정보 — 파일 · 크기 · 고친 때", e1.status === 200 && e1.type === "file" && e1.size === Buffer.byteLength("# 설계\n본문") && e1.mtime > 0 && e1.name === "설계.md", e1);
  chk("E1b 속한 프로젝트(이름 · 폴더) · 주소 · 잠김 아님",
    e1.place?.kind === "project" && e1.place.id === open.id && e1.place.name === "자료 보기 시험" && e1.place.folder === FOLDER
    && e1.address === `shared/${FOLDER}/docs/설계.md` && e1.locked === false, e1);
  chk("E1c 자료 — 번호 · 올린 사람 · 올린 때 · 여기서 나온 지식(관계 둘이어도 한 줄)",
    e1.source?.id === SRC && e1.source.uploaderId === "pgt-a" && !!e1.source.createdAt
    && e1.source.knowledge.length === 1 && e1.source.knowledge[0].name === "pgt-k-4672" && e1.source.knowledge[0].title === "설계 정리", e1.source);

  // ── E2 ──
  const e2a = await info("pgt-a", "shared", `${HF}/숨은.md`);
  const e2b = await info("pgt-b", "shared", `${HF}/숨은.md`);
  const e2c = await similar("pgt-b", "shared", `${HF}/없는.md`);
  chk("E2 숨은 프로젝트 — 볼 수 있는 사람은 정보 · 못 보는 사람은 정보 404 · 후보 404(근처에 무엇이 있는지도 말하지 않는다)",
    e2a.status === 200 && e2a.place?.kind === "project" && e2a.locked === true && e2b.status === 404 && e2c.status === 404, { e2a: e2a.status, e2b: e2b.status, e2c: e2c.status, locked: e2a.locked });

  // ── E3 · E4 ──
  const e3a = await info("pgt-b", "shared", `${FOLDER}/docs`);
  const e3b = await info("pgt-b", "shared", "");
  chk("E3 폴더 · 자리 자신 — 폴더 · 크기 0 · 자료 없음", e3a.status === 200 && e3a.type === "dir" && e3a.size === 0 && e3a.source === null && e3a.place?.kind === "project"
    && e3b.status === 200 && e3b.type === "dir" && e3b.path === "" && e3b.address === "shared" && e3b.place?.kind === "folder", { e3a, e3b });
  const e4 = await info("pgt-b", "shared", `${FOLDER}/docs/없는.md`);
  chk("E4 없는 경로 404", e4.status === 404, e4);

  // ── E5 ──
  putDisk("shared/hr/급여.md");
  putDisk("shared/hr/sub/급여.md");
  await setSharedFolderAcl("hr", "members", ["pgt-a"], { actor: "pgt-a" });
  invalidateVisibilityCache();
  const e5a = await info("pgt-a", "shared", "hr/급여.md");
  const e5b = await info("pgt-b", "shared", "hr/급여.md");
  chk("E5 잠긴 공유 폴더 — 대상은 locked · 아닌 사람은 404", e5a.status === 200 && e5a.locked === true && e5a.place?.kind === "folder" && e5a.place.folder === "hr" && e5b.status === 404, { e5a, e5b: e5b.status });

  // ── E6 · E7 · E8 ──
  await install("crm"); await install("secret-app"); await install("off-app");
  await cap("me_app_grant").handler({ app_id: "crm" }, { userId: "pgt-a", scopes: ["items"] }, { source: "mcp" });
  await cap("me_app_grant").handler({ app_id: "off-app" }, { userId: "pgt-a", scopes: ["items"] }, { source: "mcp" });
  await itemsPool.query(`UPDATE org_app SET visibility='me', owner_member='pgt-a' WHERE id='secret-app'`);
  await itemsPool.query(`UPDATE org_app SET enabled=false WHERE id='off-app'`);
  putDisk("apps/crm/out/보고.png", "png");
  putDisk("apps/crm/old/보고.png", "png2");
  putDisk("apps/secret-app/a.txt");
  putDisk("apps/off-app/a.txt");
  const e6 = await info("pgt-a", "apps", "crm/out/보고.png");
  chk("E6 앱 폴더 — 동의한 사람 · 그 앱 이름 · 주소 · 자료 없음",
    e6.status === 200 && e6.place?.kind === "app" && e6.place.id === "crm" && e6.place.name === "고객 관리" && e6.address === "apps/crm/out/보고.png" && e6.source === null, e6);
  const e7a = await info("pgt-b", "apps", "crm/out/보고.png");
  const e7b = await info("pgt-b", "apps", "crm/없는.png");
  chk("E7 앱은 보이는데 동의 안 함 — 403 app_consent_required + 그 앱(id · 이름) · 없는 파일이어도 같은 답",
    e7a.status === 403 && e7a.code === "app_consent_required" && e7a.app?.id === "crm" && e7a.app.title === "고객 관리"
    && e7b.status === 403 && e7b.code === "app_consent_required", { e7a, e7b });
  const e8a = await info("pgt-b", "apps", "secret-app/a.txt");
  const e8b = await info("pgt-b", "apps", "no-such-app/a.txt");
  const e8c = await info("pgt-a", "apps", "off-app/a.txt");
  const e8d = await info("pgt-b", "apps", "off-app/a.txt");
  chk("E8 안 보이는 앱(남의 «나만» 앱) · 없는 앱 · 꺼진 앱(동의가 있어도 · 없어도) — 404(동의 안내도 아니다)",
    e8a.status === 404 && e8b.status === 404 && e8c.status === 404 && e8d.status === 404 && !e8a.code && !e8c.code && !e8d.code,
    { e8a: e8a.status, e8b: e8b.status, e8c: e8c.status, e8d: e8d.status });

  // ── E9 ──
  putDisk("box/pgt-b/uploads/메모.txt", "개인");
  const e9 = await info("pgt-b", "personal", "uploads/메모.txt");
  chk("E9 개인 폴더 — 내 폴더 · 주소 없음 · 잠김 아님", e9.status === 200 && e9.place?.kind === "personal" && e9.address === null && e9.locked === false, e9);

  // ── E10 ──
  await itemsPool.query(`UPDATE source SET visibility='members' WHERE id=$1`, [SRC]);
  invalidateVisibilityCache();
  const e10 = await info("pgt-b", "shared", `${FOLDER}/docs/설계.md`);
  chk("E10 자료만 잠기면 — 파일 정보는 그대로 · 자료는 빠진다", e10.status === 200 && e10.type === "file" && e10.source === null, e10.source);
  await itemsPool.query(`UPDATE source SET visibility='open' WHERE id=$1`, [SRC]);

  // ── S1 · S2 · S4 ──
  renameSync(disk("shared", FOLDER, "docs", "설계.md"), (mkdirSync(disk("shared", FOLDER, "archive", "2026"), { recursive: true }), disk("shared", FOLDER, "archive", "2026", "설계.md")));
  const other = await createProject({ name: "다른 프로젝트", dedupe: false }, { actor: "pgt-a" });
  const OF = await createProjectFolder(other.id); await setProjectFolder(other.id, OF, { source: "web" });
  putDisk(path.join("shared", OF, "설계.md"));
  const s1 = await similar("pgt-b", "shared", `${FOLDER}/docs/설계.md`);
  chk("S1 셸 mv(기록 없음) — 같은 프로젝트 안 새 자리가 후보 · 범위는 그 프로젝트 폴더",
    s1.status === 200 && s1.items?.length === 1 && s1.items[0].path === `${FOLDER}/archive/2026/설계.md` && s1.items[0].type === "file" && s1.scope === FOLDER, s1);
  chk("S4 다른 프로젝트 폴더의 같은 이름은 범위 밖", !(s1.items || []).some((h) => h.path.startsWith(OF + "/")), s1.items);
  const s2 = await similar("pgt-b", "shared", `${FOLDER}/archive/2026/설계.md`);
  chk("S2 지금 있는 자리 — 후보 없음", s2.status === 200 && Array.isArray(s2.items) && s2.items.length === 0, s2);
  const e4b = await info("pgt-b", "shared", `${FOLDER}/docs/설계.md`);
  chk("S1b 옮긴 옛 자리의 정보는 404(화면은 그때 후보를 묻는다)", e4b.status === 404, e4b.status);

  // ── S3 ── 공유 폴더(프로젝트 밖): 맨 위 폴더 team 안 — 잠긴 하위 폴더(team/secret)의 같은 이름은 대상에게만
  putDisk("shared/team/pub/회의록.md");
  putDisk("shared/team/secret/회의록.md");
  await setSharedFolderAcl("team/secret", "members", ["pgt-a"], { actor: "pgt-a" });
  invalidateVisibilityCache();
  const s3a = await similar("pgt-a", "shared", "team/옛/회의록.md");
  const s3b = await similar("pgt-b", "shared", "team/옛/회의록.md");
  const pathsOf = (r) => (r.items || []).map((h) => h.path).sort();
  chk("S3 잠긴 하위 폴더 안 같은 이름은 대상에게만 — 대상은 둘 · 아닌 사람은 하나",
    JSON.stringify(pathsOf(s3a)) === JSON.stringify(["team/pub/회의록.md", "team/secret/회의록.md"]) && JSON.stringify(pathsOf(s3b)) === JSON.stringify(["team/pub/회의록.md"]),
    { a: pathsOf(s3a), b: pathsOf(s3b) });

  // ── S5 · S6 ──
  const s5a = await similar("pgt-a", "apps", "crm/new/보고.png");
  const s5b = await similar("pgt-b", "apps", "crm/new/보고.png");
  chk("S5 앱 폴더 — 같은 앱 안 후보(다른 앱 폴더는 범위 밖) · 동의 안 한 사람 404",
    s5a.status === 200 && JSON.stringify(pathsOf(s5a)) === JSON.stringify(["crm/old/보고.png", "crm/out/보고.png"]) && s5a.scope === "crm" && s5b.status === 404, { s5a, s5b: s5b.status });
  putDisk("box/pgt-b/2026/메모.txt", "개인2");
  const s6 = await similar("pgt-b", "personal", "uploads/옛/메모.txt");
  chk("S6 개인 폴더 — 그 사람 폴더 안(맨 위 폴더 uploads)", s6.status === 200 && JSON.stringify(pathsOf(s6)) === JSON.stringify(["uploads/메모.txt"]) && s6.scope === "uploads", s6);
  const s6b = await similar("pgt-b", "personal", "메모.txt");
  chk("S6b 개인 폴더 맨 위 파일 — 자리 전체에서", s6b.status === 200 && JSON.stringify(pathsOf(s6b)) === JSON.stringify(["2026/메모.txt", "uploads/메모.txt"]) && s6b.scope === "", s6b);

  chk("배선 — 시험이 실제 디스크를 썼다", existsSync(disk("shared", FOLDER, "archive", "2026", "설계.md")) && existsSync(disk("apps", "crm", "out", "보고.png")));
} catch (e) {
  fail++; console.error("FAIL 예외 —", e && e.stack ? e.stack : e);
} finally {
  if (server) await new Promise((r) => server.close(r));
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end().catch(() => {});
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
