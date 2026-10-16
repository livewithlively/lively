// 이름 바꾸기·옮기기 기록 + 자료 좌표 이동(#4688) PG 통합 테스트 — **실제 Postgres 필요**(CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/v6/file-move.pg-test.mjs
//
// 한 프로세스에 게이트웨이를 띄운다 — 진짜 인증(구성원 토큰) · 프로젝트 자료 라우트(올리기 · 이름 바꾸기 · 옮기기 · 지우기 · 휴지통 되살리기) ·
//  홈 탐색기(올리기 · 이름 바꾸기 · 옛 링크 풀기). 파일은 임시 폴더. 판정은 응답과 실제 행(source · file_move)·디스크로 한다.
//  사양 표(D1~D20)는 태스크 #4688 · 지식 rename-move-redirect-source-rekey-4688 §8 설계안 그대로:
//   D1 프로젝트 파일 이름 바꾸기 — 같은 자료 번호 · 새 좌표/경로/링크/제목 · updated_at 그대로 · 지식 근거 유지 · 옛 좌표 행 없음
//   D2 옛 링크 풀기 → 새 경로      D20 새 자리에 다시 올리면 같은 자료 번호(옮긴 행을 이어 쓴다)
//   D3 프로젝트 옮기기(폴더 포함) — 하위 자료 전부 · 앞서 그 안으로 들어온 기록이 접힌다(한 단계)
//   D4 연쇄 A→B→C 접기 · D5 되돌리기 A→B→A · D6 가장 긴 접두 · D7 옛 자리에 새 파일이 생기면 그것이 이긴다
//   D8 도착 좌표의 휴지통 기록은 비켜 둔다 · D9 되살리면 원래 좌표를 되찾는다 · D10 닫힌 기록 · 파일 없이 남은 행도 비켜 둔다
//   D11 휴지통 자료는 폴더 이름 바꾸기에 안 따라간다
//   D12 홈 탐색기(공유 루트) — 자료 · 기록 · 공개범위가 함께 · D13 홈 탐색기(project/<id>/…) — 프로젝트 좌표로
//   D14 잠긴 폴더 — 대상 아닌 사람은 옛 링크로도 못 연다 · D15 옛 경로를 못 보는 사람은 404
//   D16 개인 폴더 기록은 주인별 · D17 프로젝트 폴더 자리 자체는 이름 못 바꿈 · D18 앱 폴더 404 · D19 기록 없음 404
//   D6c 폴더 → 안 파일 → 다시 폴더(접기가 중간 걸음을 건너뛰지 않는다) · D6d 같은 이름 폴더 재사용(앞선 것의 기록이 끼지 않는다)
//   D6e 접지 못한 줄을 따라갈 때도 도착 뒤의 기록만 · D6f 같은 이름 두 번 재사용(접을 때도 도착 뒤의 기록만)
//   D21 뒷일이 실패해도 이름 바꾸기는 끝난다 · D22 이모지 이름 · D23 DB 에 적힌 프로젝트 폴더 막기 · D24·D25 본문 머리 줄 · 꼬리(SQL)
import pg from "pg";
import http from "node:http";
import { mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_file_move_4688";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
process.env.ITEMS_DATABASE_URL = dsnFor(DB);

const ROOT = mkdtempSync(path.join(os.tmpdir(), "lively-file-move-pg-"));
process.env.LIVELY_MEMBER_ISOLATION = "off";
process.env.TERMINAL_ROOT_SHARED = path.join(ROOT, "shared");
process.env.TERMINAL_ROOT_PERSONAL = path.join(ROOT, "box");
process.env.TERMINAL_ROOT_APPS = path.join(ROOT, "apps");
for (const d of ["shared", "box", "apps"]) mkdirSync(path.join(ROOT, d), { recursive: true });

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
const { setSharedFolderAcl, getSharedFolderAcl } = await import(`${D}/v6/shared-folder-store.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${typeof why === "string" ? why : JSON.stringify(why)}`); } };
const rowAt = async (eid) => (await itemsPool.query(`SELECT * FROM source WHERE external_system='local' AND external_id=$1`, [eid])).rows[0];
const rowById = async (id) => (await itemsPool.query(`SELECT * FROM source WHERE id=$1`, [id])).rows[0];
const moves = async (scope) => (await itemsPool.query(`SELECT from_path, to_path FROM file_move WHERE scope=$1 ORDER BY from_path`, [scope])).rows.map((r) => `${r.from_path}→${r.to_path}`);

let server = null;
try {
  await upsertMember({ id: "pgt-a", display_name: "가", state: "active", scopes: ["items"] }, "pgt");
  await upsertMember({ id: "pgt-b", display_name: "나", state: "active", scopes: ["items"] }, "pgt");
  const tokA = (await mintToken({ userId: "pgt-a", memberId: "pgt-a", scopes: ["items"] }, "pgt")).token;
  const tokB = (await mintToken({ userId: "pgt-b", memberId: "pgt-b", scopes: ["items"] }, "pgt")).token;

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

  const call = (tok, method, url, body, ctype = "application/json") => fetch(GW + url, {
    method, headers: { authorization: `Bearer ${tok}`, ...(body != null ? { "content-type": ctype } : {}) },
    body: body == null ? undefined : ctype === "application/json" ? JSON.stringify(body) : body,
  });
  const q = (o) => new URLSearchParams(o).toString();

  const proj = await createProject({ name: "옮기기 시험", dedupe: false }, { actor: "pgt-a" });
  const PID = proj.id;
  const P = `/api/ui/v6/projects/${PID}`;
  const put = async (rel, text = `내용 ${rel}`) => {
    const r = await call(tokA, "PUT", `${P}/file?${q({ path: rel })}`, text, "application/octet-stream");   // text 는 글 또는 Buffer
    const j = await r.json().catch(() => ({}));
    if (r.status !== 200 || !j.source_id) throw new Error(`올리기 실패 ${rel}: ${r.status} ${JSON.stringify(j)}`);
    return Number(j.source_id);
  };
  const rename = (rel, name) => call(tokA, "POST", `${P}/file/rename`, { path: rel, name });
  const move = (paths, to) => call(tokA, "POST", `${P}/move`, { paths, to });
  const moved = (tok, root, rel) => call(tok, "GET", `/api/ui/terminal/browse/moved?${q({ root, path: rel })}`);
  const movedJson = async (tok, root, rel) => { const r = await moved(tok, root, rel); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
  const pr = await getProject(PID);
  const FOLDER = pr.folder || (await (async () => { await call(tokA, "GET", `${P}/files`); return (await getProject(PID)).folder; })());
  const LP = (rel) => `${FOLDER}/${rel}`;               // 링크 좌표(공유 루트 기준)
  const EID = (rel) => `project:${PID}/${rel}`;          // 자료 좌표
  const onDisk = (rel) => existsSync(path.join(ROOT, "shared", FOLDER, rel));

  // ── D1 · D2 · D20 ──
  const a = await put("docs/a.md");
  await itemsPool.query(`INSERT INTO knowledge(name, title, body_md) VALUES('pgt-k-4688', '근거 시험', '본문')`);
  await itemsPool.query(`INSERT INTO knowledge_source(name, source_id, relation) VALUES('pgt-k-4688', $1, 'derived_from')`, [a]);
  const before1 = await rowById(a);
  const r1 = await rename("docs/a.md", "b.md");
  const after1 = await rowById(a);
  chk("D1a 이름 바꾸기 200 · 디스크에서 옮겨짐", r1.status === 200 && onDisk("docs/b.md") && !onDisk("docs/a.md"), r1.status);
  chk("D1b 같은 자료 번호가 새 좌표로(좌표·경로·제목·링크)",
    after1?.external_id === EID("docs/b.md") && after1.fields?.path === "docs/b.md" && after1.title === "b.md"
    && after1.external_url === `#/f?root=shared&path=${encodeURIComponent(LP("docs/b.md"))}` && after1.lifecycle === "active",
    { eid: after1?.external_id, path: after1?.fields?.path, title: after1?.title, url: after1?.external_url });
  chk("D1c updated_at 그대로(다시 증류하지 않는다) · 들어온 길·올린 사람 그대로",
    after1 && +new Date(after1.updated_at) === +new Date(before1.updated_at) && after1.fields?.entry === before1.fields?.entry
    && after1.fields?.author_external_id === before1.fields?.author_external_id,
    { before: before1.updated_at, after: after1?.updated_at });
  const ks = (await itemsPool.query(`SELECT count(*)::int n FROM knowledge_source WHERE name='pgt-k-4688' AND source_id=$1`, [a])).rows[0].n;
  chk("D1d 지식 근거 연결이 그대로", ks === 1, ks);
  chk("D1e 옛 좌표에 남은 행 없음", !(await rowAt(EID("docs/a.md"))));
  const d2 = await movedJson(tokA, "shared", LP("docs/a.md"));
  chk("D2 옛 링크 풀기 → 새 경로", d2.status === 200 && d2.moved === true && d2.path === LP("docs/b.md") && d2.hops === 1, d2);
  const a2 = await put("docs/b.md", "고친 내용");
  chk("D20 새 자리에 다시 올리면 같은 자료 번호를 이어 쓴다", a2 === a, { a, a2 });

  // ── D3 · D4 ──
  const c = await put("docs/sub/c.md");
  const x = await put("x.md");
  chk("D3-준비 옮길 곳 폴더", (await call(tokA, "POST", `${P}/folder?${q({ path: "archive" })}`)).status === 200);
  const r3 = await move(["docs", "x.md"], "archive");
  const j3 = await r3.json();
  chk("D3a 옮기기 200 · 둘 다 옮김", r3.status === 200 && j3.ok === true && j3.moved?.length === 2, j3);
  chk("D3b 폴더 하위 자료 전부 새 좌표(같은 번호)",
    (await rowById(a))?.external_id === EID("archive/docs/b.md") && (await rowById(c))?.external_id === EID("archive/docs/sub/c.md")
    && (await rowById(x))?.external_id === EID("archive/x.md") && (await rowById(c))?.fields?.container_name === "archive",
    [(await rowById(a))?.external_id, (await rowById(c))?.external_id, (await rowById(x))?.external_id, (await rowById(c))?.fields?.container_name]);
  const d3 = await movedJson(tokA, "shared", LP("docs/a.md"));
  chk("D3c 앞서 그 폴더 안으로 들어온 기록이 접힌다 — 옛 링크가 한 단계로 새 자리", d3.status === 200 && d3.path === LP("archive/docs/b.md") && d3.hops === 1, d3);
  const d3d = await movedJson(tokA, "shared", LP("docs/sub/c.md"));
  chk("D3d 폴더 한 줄이 하위를 덮는다", d3d.status === 200 && d3d.path === LP("archive/docs/sub/c.md"), d3d);
  await put("e.md");
  await rename("e.md", "f.md");
  await rename("f.md", "g.md");
  const m4 = await moves("shared");
  chk("D4a 연쇄는 기록할 때 접힌다(e→g · f→g)", m4.includes(`${LP("e.md")}→${LP("g.md")}`) && m4.includes(`${LP("f.md")}→${LP("g.md")}`) && !m4.some((s) => s.endsWith(`→${LP("f.md")}`)), m4);
  const d4 = await movedJson(tokA, "shared", LP("e.md"));
  chk("D4b 맨 처음 링크도 한 단계", d4.status === 200 && d4.path === LP("g.md") && d4.hops === 1, d4);

  // ── D5 되돌리기 ──
  await put("h.md");
  await rename("h.md", "i.md");
  await rename("i.md", "h.md");
  const m5 = await moves("shared");
  chk("D5a 되돌리면 제자리 줄이 없다 · 옛 이름(i)은 원래 자리로", !m5.some((s) => s.startsWith(`${LP("h.md")}→`)) && m5.includes(`${LP("i.md")}→${LP("h.md")}`), m5);
  const d5a = await movedJson(tokA, "shared", LP("h.md"));
  const d5b = await movedJson(tokA, "shared", LP("i.md"));
  chk("D5b 원래 이름 링크는 실제 파일(따라가지 않음) · 잠깐 쓴 이름 링크는 원래 자리로",
    d5a.status === 200 && d5a.moved === false && d5b.status === 200 && d5b.path === LP("h.md"), { d5a, d5b });

  // ── D6 가장 긴 접두 ──
  await put("lib/a.md");
  await rename("lib/a.md", "z.md");
  await rename("lib", "lib2");
  const d6 = await movedJson(tokA, "shared", LP("lib/a.md"));
  chk("D6 파일 줄(lib/a.md)이 폴더 줄(lib)보다 먼저 — lib2/z.md 로 한 단계", d6.status === 200 && d6.path === LP("lib2/z.md") && d6.hops === 1, d6);
  await put("lib2/y.md");
  await rename("lib2/y.md", "w.md");
  const d6b = await movedJson(tokA, "shared", LP("lib/y.md"));
  chk("D6b 폴더 줄 뒤 그 안 파일 줄 — 두 단계로 닿는다", d6b.status === 200 && d6b.path === LP("lib2/w.md") && d6b.hops === 2, d6b);

  // ── D7 옛 자리에 새 파일 ──
  const r7a = await put("r.md");
  await rename("r.md", "s.md");
  const r7b = await put("r.md", "새 파일");
  const d7 = await movedJson(tokA, "shared", LP("r.md"));
  chk("D7 옛 자리에 새 파일이 생기면 그것이 이긴다(moved:false) · 새 파일은 새 자료", d7.status === 200 && d7.moved === false && r7b !== r7a, { d7, r7a, r7b });

  // ── D8 · D9 도착 좌표의 휴지통 기록 ──
  const t1 = await put("t1.md");
  const del = await (await call(tokA, "DELETE", `${P}/file?${q({ path: "t1.md" })}`)).json();
  chk("D8-준비 지우면 휴지통(자료 1)", del.trashed === 1, del);
  const t2 = await put("t2.md");
  const r8 = await rename("t2.md", "t1.md");
  const t1row = await rowById(t1), t2row = await rowById(t2);
  chk("D8a 이름 바꾸기 성공 · 옮긴 자료가 그 좌표", r8.status === 200 && t2row.external_id === EID("t1.md") && t2row.lifecycle === "active", { s: r8.status, t2: t2row.external_id });
  chk("D8b 휴지통 기록은 지우지 않고 비켜 둔다(번호 그대로 · 원래 좌표 기억 · 휴지통에 그대로)",
    t1row && t1row.external_id === `aside:${t1}` && t1row.fields?.aside_from === EID("t1.md") && t1row.lifecycle === "superseded" && !!t1row.fields?.trash,
    { eid: t1row?.external_id, aside: t1row?.fields?.aside_from, trash: !!t1row?.fields?.trash });
  await rename("t1.md", "t3.md");
  const r9 = await call(tokA, "POST", `${P}/file-trash/restore`, { source_id: t1 });
  const t1back = await rowById(t1);
  chk("D9 그 자리가 비면 되살릴 수 있고 원래 좌표를 되찾는다",
    r9.status === 200 && t1back.external_id === EID("t1.md") && t1back.lifecycle === "active" && !t1back.fields?.aside_from && !t1back.fields?.trash && onDisk("t1.md"),
    { status: r9.status, eid: t1back?.external_id, fields: t1back?.fields });

  // ── D10 닫힌 기록 · 파일 없이 남은 행 ──
  const u1 = await put("u1.md");
  await itemsPool.query(`UPDATE source SET lifecycle='superseded' WHERE id=$1`, [u1]);
  rmSync(path.join(ROOT, "shared", FOLDER, "u1.md"));
  const u2 = await put("u2.md");
  const r10 = await rename("u2.md", "u1.md");
  const v1 = await put("v1.md");
  rmSync(path.join(ROOT, "shared", FOLDER, "v1.md"));   // 셸 rm — 자료 행은 active 로 남는다
  const v2 = await put("v2.md");
  const r10b = await rename("v2.md", "v1.md");
  const u1row = await rowById(u1), v1row = await rowById(v1);
  chk("D10a 닫힌 기록은 비켜 두고 옮긴다", r10.status === 200 && u1row.external_id === `aside:${u1}` && (await rowById(u2)).external_id === EID("u1.md"), { s: r10.status, u1: u1row?.external_id });
  chk("D10b 파일 없이 남은 행도 닫아서 비켜 둔다", r10b.status === 200 && v1row.external_id === `aside:${v1}` && v1row.lifecycle === "superseded" && (await rowById(v2)).external_id === EID("v1.md"),
    { s: r10b.status, v1: v1row?.external_id, life: v1row?.lifecycle });

  // ── D11 휴지통 자료는 안 따라간다 ──
  const k1 = await put("keep/k1.md");
  const k2 = await put("keep/k2.md");
  await call(tokA, "DELETE", `${P}/file?${q({ path: "keep/k1.md" })}`);
  await rename("keep", "kept");
  chk("D11 폴더 이름 바꾸기 — 살아 있는 자료만 따라가고 휴지통 자료는 원래 좌표",
    (await rowById(k2)).external_id === EID("kept/k2.md") && (await rowById(k1)).external_id === EID("keep/k1.md") && !!(await rowById(k1)).fields?.trash,
    [(await rowById(k2)).external_id, (await rowById(k1)).external_id]);

  // ── D12 · D14 · D15 홈 탐색기(공유 루트) ──
  const bput = async (tok, root, rel, text = "x") => {
    const r = await call(tok, "PUT", `/api/ui/terminal/browse/file?${q({ root, path: rel })}`, text, "application/octet-stream");
    const j = await r.json().catch(() => ({}));
    if (r.status !== 200) throw new Error(`탐색기 올리기 실패 ${rel}: ${r.status} ${JSON.stringify(j)}`);
    return Number(j.source_id);
  };
  const brename = (tok, root, rel, to) => call(tok, "POST", `/api/ui/terminal/browse/rename?${q({ root, path: rel, to })}`);
  const n = await bput(tokA, "shared", "team/n.md");
  await setSharedFolderAcl("team", "members", ["pgt-a"], { actor: "pgt-a" });
  const r12 = await brename(tokA, "shared", "team", "team2");
  const nrow = await rowById(n);
  chk("D12a 홈 탐색기 폴더 이름 바꾸기 — 자료가 shared 좌표로 따라간다(같은 번호)", r12.status === 200 && nrow.external_id === "shared/team2/n.md" && nrow.fields?.container_name === "team2", { s: r12.status, eid: nrow?.external_id });
  chk("D12b 기록 · 공개범위가 함께 옮겨졌다", (await moves("shared")).includes("team→team2") && (await getSharedFolderAcl("team2")).visibility === "members", await moves("shared"));
  const d14a = await movedJson(tokA, "shared", "team/n.md");
  const d14b = await movedJson(tokB, "shared", "team/n.md");
  chk("D14 잠긴 자리로 옮겼으면 — 대상인 사람만 새 자리 · 아닌 사람은 404(새 자리 기준 재판정)", d14a.status === 200 && d14a.path === "team2/n.md" && d14b.status === 404, { d14a, d14b });
  await setSharedFolderAcl("secret", "members", ["pgt-a"], { actor: "pgt-a" });
  await bput(tokA, "shared", "secret/s.md");
  await brename(tokA, "shared", "secret/s.md", "s2.md");
  const d15a = await movedJson(tokA, "shared", "secret/s.md");
  const d15b = await movedJson(tokB, "shared", "secret/s.md");
  chk("D15 옛 경로를 못 보는 사람은 404(기록이 있는지도 말하지 않는다)", d15a.status === 200 && d15a.path === "secret/s2.md" && d15b.status === 404, { d15a, d15b });

  // ── D13 홈 탐색기(project/<id>/…) ──
  const hx = await put("hx.md");
  const r13 = await brename(tokA, "shared", LP("hx.md"), "hy.md");
  chk("D13 홈 탐색기에서 프로젝트 안 파일 — 프로젝트 좌표로 옮기고 기록은 공유 루트 경로", r13.status === 200 && (await rowById(hx)).external_id === EID("hy.md")
    && (await moves("shared")).includes(`${LP("hx.md")}→${LP("hy.md")}`), { s: r13.status, eid: (await rowById(hx))?.external_id });

  // ── D16 개인 폴더 ──
  const p1 = await bput(tokA, "personal", "uploads/p.md");
  const r16 = await brename(tokA, "personal", "uploads/p.md", "q.md");
  const d16a = await movedJson(tokA, "personal", "uploads/p.md");
  const d16b = await movedJson(tokB, "personal", "uploads/p.md");
  chk("D16 개인 폴더 — 자료는 주인 좌표로 · 주인은 새 자리 · 남은 자기 폴더 기준이라 404",
    r16.status === 200 && (await rowById(p1)).external_id === "personal:pgt-a/uploads/q.md" && d16a.status === 200 && d16a.path === "uploads/q.md" && d16b.status === 404,
    { eid: (await rowById(p1))?.external_id, d16a, d16b, scopes: (await itemsPool.query(`SELECT DISTINCT scope FROM file_move`)).rows });

  // ── D6c 폴더 → 안 파일 → 다시 폴더(리뷰 지적) · 같은 이름 새 파일이 끼어도 처음 파일로 ──
  await put("s1/y.md");
  await rename("s1", "s1b");
  await rename("s1b/y.md", "w.md");
  const d6c1 = await movedJson(tokA, "shared", LP("s1/y.md"));
  await rename("s1b", "s1c");
  const d6c2 = await movedJson(tokA, "shared", LP("s1/y.md"));
  const d6c3 = await movedJson(tokA, "shared", LP("s1b/y.md"));
  chk("D6c 폴더 이름 → 그 안 파일 이름 → 다시 폴더 이름 — 처음 링크가 계속 그 파일로(접기가 중간 걸음을 건너뛰지 않는다)",
    d6c1.path === LP("s1b/w.md") && d6c2.status === 200 && d6c2.path === LP("s1c/w.md") && d6c3.path === LP("s1c/w.md"), { d6c1, d6c2, d6c3 });
  await put("v1d/x.md");
  await rename("v1d", "v1e");
  await call(tokA, "POST", `${P}/folder?${q({ path: "v1g" })}`);
  await move(["v1e/x.md"], "v1g");
  await put("v1e/x.md", "새 파일 — 다른 것");
  await rename("v1e", "v1f");
  const d6c4 = await movedJson(tokA, "shared", LP("v1d/x.md"));
  chk("D6c' 폴더 이름 → 안 파일 옮김 → 같은 이름 새 파일 → 폴더 이름 — 처음 링크는 처음 파일로(새 파일로 가지 않는다)",
    d6c4.status === 200 && d6c4.path === LP("v1g/x.md"), d6c4);

  // ── D6d 같은 이름 폴더를 다시 쓰면 — 앞서 그 이름을 쓰던 것의 기록이 새 내용에 끼지 않는다 ──
  await put("t9/c.md", "옛 c");
  await call(tokA, "POST", `${P}/folder?${q({ path: "z9" })}`);
  await move(["t9/c.md"], "z9");          // 옛 t9 의 c.md → z9/c.md
  await rename("t9", "q9");               // 옛 t9 → q9
  await put("x9/c.md", "새 c");
  await rename("x9", "t9");               // 새 폴더가 t9 이름을 다시 쓴다
  await rename("t9", "t9b");
  const d6d1 = await movedJson(tokA, "shared", LP("x9/c.md"));
  const d6d2 = await movedJson(tokA, "shared", LP("t9/c.md"));
  chk("D6d 같은 이름 재사용 — 새 폴더의 링크는 새 c 로 · 옛 t9/c.md 링크는 옛 c 가 옮겨 간 곳으로",
    d6d1.status === 200 && d6d1.path === LP("t9b/c.md") && readFileSync(path.join(ROOT, "shared", FOLDER, "t9b", "c.md"), "utf8") === "새 c"
    && d6d2.status === 200 && d6d2.path === LP("z9/c.md"), { d6d1, d6d2 });

  // ── D6e 접지 못한 줄을 따라갈 때 — 그 자리에 도착한 뒤의 기록만 다음 걸음(앞선 것의 기록에 끌려가지 않는다) ──
  await put("t8/c.md", "옛 c");
  await call(tokA, "POST", `${P}/folder?${q({ path: "z8" })}`);
  await move(["t8/c.md"], "z8");          // 옛 t8 의 c.md → z8/c.md
  await rename("t8", "q8");
  await put("x8/c.md", "새 c");
  await put("x8/k.md", "k");
  await rename("x8", "t8");               // 새 폴더가 t8 이름을 다시 쓴다
  await rename("t8/k.md", "k2.md");       // 도착한 뒤 그 안에서 생긴 기록 — x8→t8 줄은 접히지 않는다
  await rename("t8", "t8b");
  const d6e1 = await movedJson(tokA, "shared", LP("x8/c.md"));
  const d6e2 = await movedJson(tokA, "shared", LP("x8/k.md"));
  chk("D6e 접지 못한 줄 — x8/c.md 는 새 c(t8b/c.md)로, 앞서 t8 을 쓰던 것의 기록(→z8/c.md)으로 가지 않는다 · x8/k.md 는 k2 로",
    d6e1.status === 200 && d6e1.path === LP("t8b/c.md") && d6e2.status === 200 && d6e2.path === LP("t8b/k2.md"), { d6e1, d6e2 });

  // ── D6f 같은 이름을 두 번 재사용 — 접을 때도 도착 뒤의 기록만 본다(아니면 세 번째로 그 이름을 쓴 폴더로 간다) ──
  await put("t7/c.md", "옛 c");
  await call(tokA, "POST", `${P}/folder?${q({ path: "z7" })}`);
  await move(["t7/c.md"], "z7");
  await rename("t7", "q7");
  await put("x7/c.md", "x 의 c");
  await rename("x7", "t7");
  await rename("t7", "t7b");              // x 의 내용은 t7b 로
  await put("y7/c.md", "y 의 c");
  await rename("y7", "t7");               // t7 이름을 또 쓴다
  await rename("t7", "t7c");              // t7 기록이 t7→t7c 로 바뀐다
  const d6f = await movedJson(tokA, "shared", LP("x7/c.md"));
  chk("D6f 같은 이름 두 번 재사용 — x7/c.md 는 x 의 c(t7b/c.md)로, 세 번째 폴더(t7c)로 가지 않는다",
    d6f.status === 200 && d6f.path === LP("t7b/c.md") && readFileSync(path.join(ROOT, "shared", FOLDER, "t7b", "c.md"), "utf8") === "x 의 c", d6f);

  // ── D21 뒷일이 실패해도 이름 바꾸기·옮기기는 끝난다 ──
  const ff = await put("ff.md");
  await itemsPool.query(`CREATE OR REPLACE FUNCTION pgt_fail_4688() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'pgt-fail-4688'; END $$ LANGUAGE plpgsql`);
  await itemsPool.query(`CREATE TRIGGER pgt_fail_src BEFORE UPDATE ON source FOR EACH ROW EXECUTE FUNCTION pgt_fail_4688()`);
  await itemsPool.query(`CREATE TRIGGER pgt_fail_mv BEFORE INSERT OR UPDATE OR DELETE ON file_move FOR EACH ROW EXECUTE FUNCTION pgt_fail_4688()`);
  let r21a, r21b, r21c;
  try {
    r21a = await rename("ff.md", "fg.md");
    r21b = await (await move(["fg.md"], "archive")).json();
    r21c = await brename(tokA, "shared", LP("archive/fg.md"), "fh.md");
  } finally {
    await itemsPool.query(`DROP TRIGGER IF EXISTS pgt_fail_src ON source`);
    await itemsPool.query(`DROP TRIGGER IF EXISTS pgt_fail_mv ON file_move`);
  }
  chk("D21 자료 옮기기·기록이 실패해도 이름 바꾸기 · 옮기기 · 탐색기 이름 바꾸기는 200 · 파일은 옮겨진다(자료는 그대로 · 기록 없음)",
    r21a.status === 200 && r21b.ok === true && r21c.status === 200 && onDisk("archive/fh.md") && !onDisk("ff.md")
    && (await rowById(ff)).external_id === EID("ff.md") && !(await moves("shared")).some((m) => m.startsWith(`${LP("ff.md")}→`)),
    { a: r21a.status, b: r21b, c: r21c.status });

  // ── D22 BMP 밖 글자(이모지) 이름 ──
  const em = await put("😀e/😀😀a.md");
  await rename("😀e/😀😀a.md", "😀b.md");
  await rename("😀e", "😀f");             // 접기가 이모지 든 접두를 글자 단위로 잘라야 맞는다
  const d22 = await movedJson(tokA, "shared", LP("😀e/😀😀a.md"));
  chk("D22 이모지 이름(폴더·파일) — 자료 좌표 · 기록 접기가 글자 단위로 맞다", (await rowById(em)).external_id === EID("😀f/😀b.md") && d22.status === 200 && d22.path === LP("😀f/😀b.md") && d22.hops === 1,
    { eid: (await rowById(em))?.external_id, d22, m: (await moves("shared")).filter((x) => x.includes("😀")) });

  // ── D23 DB 에 적힌 프로젝트 폴더(모양 판정 밖) ──
  await createProject({ name: "깊은 폴더", folder: "project/team-4688/alpha", dedupe: false }, { actor: "pgt-a" });
  mkdirSync(path.join(ROOT, "shared", "project", "team-4688", "alpha"), { recursive: true });
  await createProject({ name: "안쪽 프로젝트", folder: `${FOLDER}/nested-4688`, dedupe: false }, { actor: "pgt-a" });
  mkdirSync(path.join(ROOT, "shared", FOLDER, "nested-4688"), { recursive: true });
  const r23a = await brename(tokA, "shared", "project/team-4688/alpha", "beta");
  const r23b = await rename("nested-4688", "nested-x");
  const r23c = await (await move(["nested-4688"], "archive")).json();
  chk("D23 DB 에 적힌 프로젝트 폴더(더 깊은 자리 · 다른 프로젝트 폴더 안쪽)는 이름 바꾸기 · 옮기기 400 · 폴더 그대로",
    r23a.status === 400 && r23b.status === 400 && r23c.ok === false && r23c.failed?.length === 1
    && existsSync(path.join(ROOT, "shared", "project", "team-4688", "alpha")) && onDisk("nested-4688"),
    { a: r23a.status, b: r23b.status, c: r23c });

  // ── D24 · D25 본문은 SQL 이 그 자리에서 고친다(바이너리 안내문 머리 줄 · 긴 본문 꼬리) ──
  const pic = await put("pics/pic.png", Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  const pic0 = (await rowById(pic)).body_md;
  await rename("pics/pic.png", "pic.jpg");
  const pic1 = (await rowById(pic)).body_md;
  const [ph0, ...pt0] = pic0.split("\n"), [ph1, ...pt1] = pic1.split("\n");
  chk("D24 바이너리 안내문 — 머리 줄의 이름 · 종류 · 주소가 새 값, 안내 줄은 그대로",
    ph0.startsWith("[BINARY] filename=pic.png mime=image/png size=16 ") && ph1.startsWith("[BINARY] filename=pic.jpg mime=image/jpeg size=16 ")
    && ph1.includes(`url=#/f?root=shared&path=${encodeURIComponent(LP("pics/pic.jpg"))}`) && pt1.join("\n") === pt0.join("\n") && pt1.length > 0, { ph0, ph1 });
  const big = await put("long/big.txt", "가".repeat(1_000_100));
  const bg0 = (await rowById(big)).body_md;
  await rename("long/big.txt", "big2.txt");
  const bg1 = (await rowById(big)).body_md;
  chk("D25 긴 본문 — 꼬리의 주소만 새 주소, 본문 앞(파일 내용)은 그대로",
    bg0.endsWith(`— 전문은 #/f?root=shared&path=${encodeURIComponent(LP("long/big.txt"))}]`)
    && bg1.endsWith(`— 전문은 #/f?root=shared&path=${encodeURIComponent(LP("long/big2.txt"))}]`)
    && bg1.slice(0, 1_000_000) === bg0.slice(0, 1_000_000) && bg1.length === bg0.length + 1, { bg0: bg0.slice(-120), bg1: bg1.slice(-120) });

  // ── D17 · D18 · D19 ──
  const r17a = await brename(tokA, "shared", FOLDER, "999999");
  const r17b = await brename(tokA, "shared", "project", "projects");
  mkdirSync(path.join(ROOT, "shared", "misc"), { recursive: true });
  const r17c = await brename(tokA, "shared", "misc", "legacy-project");
  chk("D17 프로젝트 폴더 자리 자체(project/<id> · project)와 그 이름으로 바꾸기는 400 · 폴더 그대로",
    r17a.status === 400 && r17b.status === 400 && r17c.status === 400 && existsSync(path.join(ROOT, "shared", FOLDER)) && existsSync(path.join(ROOT, "shared", "misc")),
    [r17a.status, r17b.status, r17c.status]);
  const d18 = await moved(tokA, "apps", "some-app/x.md");
  const d19 = await moved(tokA, "shared", "nothing/here.md");
  chk("D18 앱 폴더 자리 404 · D19 기록 없는 경로(셸 mv) 404", d18.status === 404 && d19.status === 404, [d18.status, d19.status]);
  chk("배선 — 시험이 실제 디스크를 썼다", readFileSync(path.join(ROOT, "shared", FOLDER, "archive", "docs", "b.md"), "utf8") === "고친 내용");
} catch (e) {
  fail++;
  console.error("FAIL 예외 —", e?.stack || e);
} finally {
  if (server) await new Promise((r) => server.close(r));
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end().catch(() => {});
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
