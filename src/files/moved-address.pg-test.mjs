// 옛 주소 따라가기 넓히기(#4822) PG 통합 테스트 — **실제 Postgres 필요**(CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/files/moved-address.pg-test.mjs
//
// 한 프로세스에 게이트웨이를 띄운다 — 진짜 인증(구성원 토큰) · 파일 주소 도구 REST(file_url · file_path) · 서명 주소 받는 곳 ·
//  프로젝트 자료 라우트(올리기 · 이름 바꾸기 · 옮기기 · 읽기). 파일은 임시 폴더. 판정은 응답 · 받은 바이트 · 디스크로 한다.
//  사양 표(스크래치패드 spec-4822.md):
//   U1 옛 주소 받기 → 새 주소 · moved_from · 새 바이트   U1b 다른 폴더로 옮기기   U2 폴더 이름 바꾸기(접두)   U3 옛 자리에 새 파일이 이긴다   U4 올리기는 안 따라감
//   U5 옛 주소를 못 보는 사람 404   U5b 잠긴 자리에서 옮겨 나간 것도 옛 자리를 못 보면 안 따라감   U6 새 자리가 잠겼으면 안 따라감(대조군: 볼 수 있는 사람은 따라감)   U7 기록 없음   U9 NFD 기록 · NFC 주소
//   U10 자료 좌표(project:<번호>/…)로 넣어도   P1 file_path 새 경로   P2 옛 자리 파일이 이긴다   P3 새 자리가 잠긴 참가자는 옛 경로   P5 옛 자리가 잠긴 참가자   P5b 잠긴 자리에서 옮겨 나간 것
//   G1 프로젝트 파일 읽기 → 새 파일 · X-File-Moved-To   G2 HEAD   G3 옛 자리 파일이 이긴다   G4 다른 프로젝트로 간 것은 404
//   G5 폴더 이름 바꾸기   G6 쓰기(PUT · DELETE)는 안 따라감(옮긴 파일은 그대로)   G7 내려받는 이름 = 새 이름   G8 기록 없음 404
import pg from "pg";
import http from "node:http";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_moved_address_4822";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
process.env.ITEMS_DATABASE_URL = dsnFor(DB);

const ROOT = mkdtempSync(path.join(os.tmpdir(), "lively-moved-address-pg-"));
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
const { registerWebUi } = await import(`${D}/web.js`);
const { registerTerminalFiles } = await import(`${D}/terminal/terminal-files.js`);
const { registerProjectV6Routes } = await import(`${D}/project/project-routes.js`);
const { BearerVerifier } = await import(`${D}/auth/bearer.js`);
const { fileUrlRouter } = await import(`${D}/files/signed-routes.js`);
const { liveSignedRouteDeps } = await import(`${D}/files/files-live.js`);
const { upsertMember } = await import(`${D}/org/store/members.js`);
const { mintToken } = await import(`${D}/org/store/tokens.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const { createProject, getProject, setProjectFolder, setProjectMembers } = await import(`${D}/v6/project-store.js`);
const { isProjectMember } = await import(`${D}/v6/project-session-store.js`);
const { listProjectActivities } = await import(`${D}/v6/project-activity-store.js`);
const { createProjectFolder } = await import(`${D}/project/project-fs.js`);
const { setSharedFolderAcl } = await import(`${D}/v6/shared-folder-store.js`);
const { recordFileMove, SHARED_MOVE_SCOPE } = await import(`${D}/v6/file-move-store.js`);
const st = await import(`${D}/sessions/session-state.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${typeof why === "string" ? why : JSON.stringify(why)}`); } };

let server = null;
try {
  await upsertMember({ id: "pgt-a", display_name: "가", state: "active", scopes: ["items"] }, "pgt");
  await upsertMember({ id: "pgt-b", display_name: "나", state: "active", scopes: ["items"] }, "pgt");
  const tokA = (await mintToken({ userId: "pgt-a", memberId: "pgt-a", scopes: ["items"] }, "pgt")).token;
  const tokB = (await mintToken({ userId: "pgt-b", memberId: "pgt-b", scopes: ["items"] }, "pgt")).token;

  const gw = express();
  gw.use("/api/files/s", fileUrlRouter(liveSignedRouteDeps));
  gw.use(express.json({ limit: "1mb" }));
  const verifier = new BearerVerifier();
  registerWebUi(gw, verifier);
  registerProjectV6Routes(gw, verifier, {
    getProject: async (id) => { const p = await getProject(id); return p ? { id: p.id, name: p.name, folder: p.folder } : undefined; },
    isProjectMember: (id, m) => isProjectMember(id, m),
    listProjectActivities: (id, a, l, o) => listProjectActivities(id, a, l, o),
    ensureFolder: async (project) => { const folder = await createProjectFolder(project.id); await setProjectFolder(project.id, folder, { source: "web" }); return folder; },
  });
  registerTerminalFiles(gw, verifier);
  server = http.createServer(gw);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const GW = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_URL = GW;

  const call = (tok, method, url, body, ctype = "application/json", extra = {}) => fetch(GW + url, {
    method, headers: { authorization: `Bearer ${tok}`, ...(body != null ? { "content-type": ctype } : {}), ...extra },
    body: body == null ? undefined : ctype === "application/json" ? JSON.stringify(body) : body,
  });
  const q = (o) => new URLSearchParams(o).toString();

  const proj = await createProject({ name: "옛 주소 따라가기 시험", dedupe: false }, { actor: "pgt-a" });
  const PID = proj.id;
  const P = `/api/ui/v6/projects/${PID}`;
  await setProjectMembers(PID, ["pgt-a", "pgt-b"], { actor: "pgt-a" });
  const put = async (rel, text) => {
    const r = await call(tokA, "PUT", `${P}/file?${q({ path: rel })}`, text, "application/octet-stream");
    if (r.status !== 200) throw new Error(`올리기 실패 ${rel}: ${r.status} ${await r.text()}`);
  };
  const rename = async (rel, name) => { const r = await call(tokA, "POST", `${P}/file/rename`, { path: rel, name }); if (r.status !== 200) throw new Error(`이름 바꾸기 실패 ${rel}: ${r.status} ${await r.text()}`); };
  const move = async (paths, to) => { const r = await call(tokA, "POST", `${P}/move`, { paths, to }); if (r.status !== 200) throw new Error(`옮기기 실패: ${r.status} ${await r.text()}`); };
  const mint = async (tok, body) => { const r = await call(tok, "POST", "/api/ui/files/url", body); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
  const pget = (tok, rel, extra = {}, method = "GET") => call(tok, method, `${P}/file?${q({ path: rel, ...extra })}`);
  await call(tokA, "GET", `${P}/files`);   // 프로젝트 폴더를 정한다
  const FOLDER = (await getProject(PID)).folder;
  const A = (rel) => `shared/${FOLDER}/${rel}`;          // 파일 주소
  const DISK = (rel) => path.join(ROOT, "shared", FOLDER, rel);

  // ── 준비 — 이름 바꾸기 · 옮기기로 기록을 만든다 ──
  await put("docs/a.md", "AAA");
  await rename("docs/a.md", "b.md");                      // docs/a.md → docs/b.md
  await put("img/p.md", "PPP");
  await rename("img", "그림");                            // img → 그림(폴더 · 접두)
  await put("mv/q.md", "QQQ");
  await put("archive/.keep", "");
  await move(["mv/q.md"], "archive");                     // 다른 폴더로 옮기기(프로젝트 옮기기 라우트)
  await put("docs/c.md", "C1");
  await rename("docs/c.md", "d.md");
  await put("docs/c.md", "C2");                           // 옛 자리에 새 파일
  //  잠긴 자리는 공유 루트에 둔다 — 프로젝트 폴더 안쪽은 공개범위를 따로 걸 수 없다(프로젝트 공개범위를 그대로 따른다).
  const bput = async (rel, text) => {
    const r = await call(tokA, "PUT", `/api/ui/terminal/browse/file?${q({ root: "shared", path: rel })}`, text, "application/octet-stream");
    if (r.status !== 200) throw new Error(`탐색기 올리기 실패 ${rel}: ${r.status} ${await r.text()}`);
  };
  await setSharedFolderAcl("vault", "members", ["pgt-a"], { actor: "pgt-a" });
  await bput("vault/v.md", "VVV");
  const vr = await call(tokA, "POST", `/api/ui/terminal/browse/rename?${q({ root: "shared", path: "vault/v.md", to: "v2.md" })}`);
  if (vr.status !== 200) throw new Error(`탐색기 이름 바꾸기 실패: ${vr.status}`);   // 잠긴 폴더 안의 이동(옛 자리도 잠김)
  await bput("open/m.md", "MMM");
  const preB = await mint(tokB, { address: "shared/open/m.md" });   // 배선 — 옮기기 전엔 B 도 받는다(열린 자리)
  //  열린 자리 → 잠긴 자리: 탐색기는 같은 폴더 안 이름 바꾸기만 하므로 디스크 이동 + 기록을 직접 남긴다(기록 꼴은 탐색기와 같다).
  mkdirSync(path.join(ROOT, "shared", "vault"), { recursive: true });
  renameSync(path.join(ROOT, "shared", "open", "m.md"), path.join(ROOT, "shared", "vault", "m.md"));
  await recordFileMove(SHARED_MOVE_SCOPE, "open/m.md", "vault/m.md", "pgt-a");
  //  잠긴 자리 → 열린 자리(U5b): 옛 자리를 못 보는 사람에게 새 자리를 알려 주면 «그 기록이 있다» 가 샌다.
  await bput("vault/w.md", "WWW");
  mkdirSync(path.join(ROOT, "shared", "open"), { recursive: true });
  renameSync(path.join(ROOT, "shared", "vault", "w.md"), path.join(ROOT, "shared", "open", "w.md"));
  await recordFileMove(SHARED_MOVE_SCOPE, "vault/w.md", "open/w.md", "pgt-a");
  const nfd = "회의록".normalize("NFD"), nfc = "회의록".normalize("NFC");
  mkdirSync(DISK("nfd"), { recursive: true });
  writeFileSync(DISK(`nfd/${nfd}.md`), "NNN");            // 디스크 이름이 NFD 인 파일(맥에서 올린 것)
  await rename(`nfd/${nfd}.md`, "새 이름.md");
  chk("준비 — 디스크에서 옮겨졌고 B 는 옮기기 전 열린 자리를 받을 수 있었다",
    existsSync(DISK("docs/b.md")) && existsSync(DISK("그림/p.md")) && existsSync(path.join(ROOT, "shared", "vault", "m.md")) && existsSync(DISK("nfd/새 이름.md")) && preB.status === 200,
    { preB: preB.status });

  // ── ① file_url ──
  const u1 = await mint(tokA, { address: A("docs/a.md") });
  const u1Body = u1.status === 200 ? await (await fetch(u1.url)).text() : "";
  chk("U1 옛 주소 받기 → 지금 자리 주소 · moved_from=옛 주소 · 받으면 새 파일 바이트",
    u1.status === 200 && u1.address === A("docs/b.md") && u1.moved_from === A("docs/a.md") && u1Body === "AAA", { u1, u1Body });
  const u1b = await mint(tokA, { address: A("mv/q.md") });
  const u1bBody = u1b.status === 200 ? await (await fetch(u1b.url)).text() : "";
  chk("U1b 다른 폴더로 옮긴 파일의 옛 주소 → 옮긴 자리", u1b.status === 200 && u1b.address === A("archive/q.md") && u1b.moved_from === A("mv/q.md") && u1bBody === "QQQ", { u1b, u1bBody });
  const u2 = await mint(tokA, { address: A("img/p.md") });
  chk("U2 담은 폴더 이름을 바꿨어도(접두) 지금 자리로", u2.status === 200 && u2.address === A("그림/p.md") && u2.moved_from === A("img/p.md"), u2);
  const u3 = await mint(tokA, { address: A("docs/c.md") });
  const u3Body = u3.status === 200 ? await (await fetch(u3.url)).text() : "";
  chk("U3 옛 자리에 새 파일이 있으면 그것이 이긴다(따라가지 않음 · moved_from 없음)", u3.status === 200 && u3.address === A("docs/c.md") && !("moved_from" in u3) && u3Body === "C2", { u3, u3Body });
  const u4 = await mint(tokA, { address: A("docs/a.md"), method: "PUT" });
  chk("U4 올리기 주소는 따라가지 않는다(옛 자리에 새로 쓴다)", u4.status === 200 && u4.address === A("docs/a.md") && !("moved_from" in u4), u4);
  const u5 = await mint(tokB, { address: "shared/vault/v.md" });
  chk("U5 옛 주소를 못 보는 사람은 종전과 같은 404(기록이 있는지 새지 않는다)", u5.status === 404 && !("moved_from" in u5), u5);
  const u5b = await mint(tokB, { address: "shared/vault/w.md" });
  const u5bOpen = await mint(tokB, { address: "shared/open/w.md" });
  chk("U5b 잠긴 자리에서 열린 자리로 옮긴 것 — 옛 자리를 못 보는 사람은 옛 주소로 따라가지 못한다(404) · 새 주소로는 받는다(대조군)",
    u5b.status === 404 && !JSON.stringify(u5b).includes("open/w.md") && u5bOpen.status === 200, { u5b, u5bOpen: u5bOpen.status });
  const u6b = await mint(tokB, { address: "shared/open/m.md" });
  const u6a = await mint(tokA, { address: "shared/open/m.md" });
  chk("U6 새 자리가 잠긴 사람은 따라가지 않는다(옛 주소 그대로) · 볼 수 있는 사람은 따라간다(대조군)",
    u6b.status === 200 && u6b.address === "shared/open/m.md" && !("moved_from" in u6b) && !JSON.stringify(u6b).includes("vault")
    && u6a.status === 200 && u6a.address === "shared/vault/m.md" && u6a.moved_from === "shared/open/m.md", { u6b, u6a });
  const u7 = await mint(tokA, { address: A("docs/없음.md") });
  chk("U7 기록도 파일도 없으면 종전 그대로(옛 주소 · moved_from 없음)", u7.status === 200 && u7.address === A("docs/없음.md") && !("moved_from" in u7), u7);
  const u9 = await mint(tokA, { address: A(`nfd/${nfc}.md`) });
  chk("U9 기록은 디스크 이름(NFD) · 주소는 NFC 로 적어도 따라간다", u9.status === 200 && u9.address === A("nfd/새 이름.md"), u9);
  const u10 = await mint(tokA, { address: `project:${PID}/docs/a.md` });
  chk("U10 자료 좌표(project:<번호>/옛 경로)로 넣어도 따라간다", u10.status === 200 && u10.address === A("docs/b.md") && u10.moved_from === A("docs/a.md"), u10);

  // ── ② file_path — 셀프호스트 세션(같은 파일 시스템 — 공유 자리 전체가 경로로 보인다) · B 는 초대받은 참가자 ──
  const SID = "box-pgt-moved-4822abcd";
  await st.upsertSessionState({ id: SID, owner: "pgt-a", label: "옛 주소 시험", harness: "claude", dir: DISK(""), root_key: "shared", subpath: FOLDER,
    flags: {}, auto_approve: false, invites: ["pgt-b"], project_id: PID, project_src: "v6", read_only: false, incognito: false,
    created: 1_000, last_busy: 1_100, label_source: "human", kind: "human" });
  const fpath = async (tok, address) => {
    const r = await fetch(`${GW}/api/ui/files/path?${q({ address })}`, { headers: { authorization: `Bearer ${tok}`, "x-lively-session": SID } });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const p1 = await fpath(tokA, A("docs/a.md"));
  chk("P1 이 세션에서 보이는 옛 주소 → 지금 자리 경로 · 주소 · moved_from",
    p1.status === 200 && p1.path === DISK("docs/b.md") && p1.address === A("docs/b.md") && p1.moved_from === A("docs/a.md"), p1);
  const p2 = await fpath(tokA, A("docs/c.md"));
  chk("P2 옛 자리에 파일이 있으면 그 경로(따라가지 않음)", p2.status === 200 && p2.path === DISK("docs/c.md") && !("moved_from" in p2), p2);
  const p3 = await fpath(tokB, "shared/open/m.md");
  const p3a = await fpath(tokA, "shared/open/m.md");
  chk("P3 새 자리가 잠긴 참가자는 종전 그대로(옛 경로 · 잠긴 자리 이름이 안 샌다) · 볼 수 있는 주인은 따라간다(대조군)",
    p3.status === 200 && p3.path === path.join(ROOT, "shared", "open", "m.md") && !("moved_from" in p3) && !JSON.stringify(p3).includes("vault/m.md")
    && p3a.status === 200 && p3a.path === path.join(ROOT, "shared", "vault", "m.md") && p3a.moved_from === "shared/open/m.md", { p3, p3a });
  const p5bNow = await fpath(tokB, "shared/vault/w.md");
  chk("P5b 잠긴 자리에서 옮겨 나간 것 — 옛 자리를 못 보는 참가자에겐 새 자리를 알려 주지 않는다(글자만 바꾼 옛 경로)",
    p5bNow.status === 200 && p5bNow.path === path.join(ROOT, "shared", "vault", "w.md") && !("moved_from" in p5bNow) && !JSON.stringify(p5bNow).includes("open/w.md"), p5bNow);
  const p5 = await fpath(tokB, "shared/vault/v.md");
  chk("P5 옛 자리가 잠긴 참가자는 따라가지 않는다(글자만 바꾼 옛 경로 — 종전 그대로)",
    p5.status === 200 && p5.path === path.join(ROOT, "shared", "vault", "v.md") && !("moved_from" in p5), p5);

  // ── ③ 프로젝트 파일 읽기 ──
  const g1 = await pget(tokA, "docs/a.md");
  const g1Body = await g1.text();
  chk("G1 옛 경로 읽기 → 지금 자리 파일 · X-File-Moved-To", g1.status === 200 && g1Body === "AAA" && g1.headers.get("x-file-moved-to") === encodeURIComponent("docs/b.md"),
    { s: g1.status, body: g1Body, h: g1.headers.get("x-file-moved-to") });
  const g2 = await pget(tokA, "docs/a.md", {}, "HEAD");
  chk("G2 HEAD 도 지금 자리의 도장", g2.status === 200 && g2.headers.get("x-file-size") === "3" && g2.headers.get("x-file-moved-to") === encodeURIComponent("docs/b.md"),
    { s: g2.status, size: g2.headers.get("x-file-size") });
  const g3 = await pget(tokA, "docs/c.md");
  chk("G3 옛 자리에 파일이 있으면 그것(머리 없음)", g3.status === 200 && (await g3.text()) === "C2" && g3.headers.get("x-file-moved-to") === null, g3.status);
  //  다른 프로젝트로 간 것 — 기록만 직접 남긴다(프로젝트 옮기기 라우트는 한 프로젝트 안에서만 옮긴다). 파일도 실제로 그 자리에 둔다.
  const other = await createProject({ name: "다른 프로젝트", dedupe: false }, { actor: "pgt-a" });
  const OF = await createProjectFolder(other.id); await setProjectFolder(other.id, OF, { source: "web" });
  mkdirSync(path.join(ROOT, "shared", OF), { recursive: true });
  writeFileSync(path.join(ROOT, "shared", OF, "x.md"), "XXX");
  await recordFileMove(SHARED_MOVE_SCOPE, `${FOLDER}/docs/x.md`, `${OF}/x.md`, "pgt-a");
  const g4 = await pget(tokA, "docs/x.md");
  chk("G4 다른 프로젝트 폴더로 간 것은 404(같은 프로젝트 안에서만)", g4.status === 404, g4.status);
  const g5 = await pget(tokA, "img/p.md");
  chk("G5 담은 폴더 이름을 바꿨어도 따라간다", g5.status === 200 && (await g5.text()) === "PPP" && g5.headers.get("x-file-moved-to") === encodeURIComponent("그림/p.md"), g5.status);
  const g7 = await pget(tokA, "docs/a.md", { download: "1" });
  chk("G7 내려받는 이름 = 지금 이름", g7.status === 200 && String(g7.headers.get("content-disposition")).includes(encodeURIComponent("b.md")), g7.headers.get("content-disposition"));
  const g8 = await pget(tokA, "docs/none.md");
  chk("G8 기록이 없으면 404(종전)", g8.status === 404, g8.status);
  const g6del = await call(tokA, "DELETE", `${P}/file?${q({ path: "docs/a.md" })}`);
  const g6put = await call(tokA, "PUT", `${P}/file?${q({ path: "docs/a.md" })}`, "NEW", "application/octet-stream");
  chk("G6 쓰기는 따라가지 않는다 — 옛 경로 지우기는 옮긴 파일을 건드리지 않고 · 올리기는 옛 자리에 새로 만든다",
    g6del.status < 500 && g6put.status === 200 && readFileSync(DISK("docs/a.md"), "utf8") === "NEW" && readFileSync(DISK("docs/b.md"), "utf8") === "AAA",
    { del: g6del.status, put: g6put.status });
  const g6get = await pget(tokA, "docs/a.md");
  chk("G6b 옛 자리에 새로 올린 뒤에는 그 파일이 이긴다", g6get.status === 200 && (await g6get.text()) === "NEW" && g6get.headers.get("x-file-moved-to") === null, g6get.status);
} catch (e) {
  fail++; console.error("FAIL (예외)", e);
} finally {
  if (server) server.close();
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end();
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
