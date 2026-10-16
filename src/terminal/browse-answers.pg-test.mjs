// 홈 탐색기 — 볼 수 없는 자리와 없는 자리의 같은 답(#4847) PG 통합 테스트 — **실제 Postgres 필요**(CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/terminal/browse-answers.pg-test.mjs
//
// 한 프로세스에 게이트웨이를 띄운다 — 진짜 인증(구성원 토큰) · 프로젝트 공개범위(리스트 대상) · 공유 폴더 공개범위(ACL) · 홈 탐색기 라우트.
//  파일은 임시 폴더. 답은 상태 · 몸 · 머리(Cache-Control · Content-Type)를 통째로 견준다. 사양 표(태스크 #4847):
//   B1 목록 — 숨은 프로젝트 · 잠긴 폴더 · 없는 폴더 · 파일 밑 경로 = 없는 폴더의 빈 목록(그 경로 그대로)
//   B2 미리보기 · 내려받기 — 넷 다 같은 404 몸(code file_not_found)
//   B3 옛 링크 풀기 — 숨음 · 잠김 · 기록 없음 · 공유/개인 밖 자리 = 같은 404 몸 · 같은 머리
//   B4 정보 · B5 같은 이름 후보 — 넷 다 같은 답(종전 그대로)
//   B6 이상한 이름(NUL · 제어 문자 · 255바이트 넘는 이름 · 너무 긴 경로) × 라우트 10개 — 숨은 자리 · 보이는 자리가 같은 400(code path_name_invalid)
//   B7 경계 — 이름 255(ASCII)는 없는 자리의 답 · 256 은 400
//   B8 순서 — 보이는 자리의 링크가 루트 밖이면 400 · 같은 링크가 숨은 자리에 있으면 없는 자리의 답
//   B9 이름 바꾸기 · 지우기 — 없는 대상은 숨은 대상과 같은 404 · 숨은 파일은 그대로 남는다
//   B10 폴더 만들기 · 올리기 — 숨은 자리 · 잠긴 자리는 같은 404 · 아무것도 생기지 않는다(없는 자리에는 만들어진다 — 만들기의 본성)
//   B11 이름 바꾸기의 새 이름 — 제어 문자 · 256바이트는 대상이 보이든 말든 같은 400
//   B12 휴지통 되살리기 · 완전 삭제 — 원래 자리를 못 봄 = 휴지통에 없음(같은 404)
//   B13 볼 수 있고 있는 것은 그대로(목록 항목 · 미리보기 바이트 · 정보 · moved:false · 루트 목록)
//   B14 이미 있는 이름에 제어 문자(셸이 만든 `Icon\r` 등) — 지우기 · 이름 바꾸기는 된다(열기 · 만들기는 B6 의 400)
//   B15 새 이름이 들어갈 경로 전체가 상한을 넘음 — 대상이 보이든 말든 · 있든 없든 같은 400
//   B16 앱 폴더 — 동의 안 한 앱 · 없는 앱 = 동의한 앱의 없는 파일(목록 · 미리보기 · 내려받기 · 후보)
//   B17 개인 폴더 파일 밑 경로 = 개인 폴더 없는 자리 · 루트 밖 파일 링크 뒤 경로 = 없는 자리(링크 자체는 400)
import pg from "pg";
import http from "node:http";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_browse_answers_4847";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
process.env.ITEMS_DATABASE_URL = dsnFor(DB);

const ROOT = mkdtempSync(path.join(os.tmpdir(), "lively-browse-answers-pg-"));
process.env.LIVELY_MEMBER_ISOLATION = "off";
process.env.TERMINAL_ROOT_SHARED = path.join(ROOT, "shared");
process.env.TERMINAL_ROOT_PERSONAL = path.join(ROOT, "box");
process.env.TERMINAL_ROOT_APPS = path.join(ROOT, "apps");
for (const d of ["shared", "box", "apps", "outside"]) mkdirSync(path.join(ROOT, d), { recursive: true });
writeFileSync(path.join(ROOT, "outside", "x"), "outside");
process.env.CONNECTOR_SECRET_KEY = crypto.randomBytes(32).toString("hex");

const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const express = (await import("express")).default;
const { registerTerminalFiles } = await import(`${D}/terminal/terminal-files.js`);
const { BearerVerifier } = await import(`${D}/auth/bearer.js`);
const { upsertMember } = await import(`${D}/org/store/members.js`);
const { mintToken } = await import(`${D}/org/store/tokens.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const { createProject, setProjectFolder } = await import(`${D}/v6/project-store.js`);
const { createProjectFolder } = await import(`${D}/project/project-fs.js`);
const { setSharedFolderAcl } = await import(`${D}/v6/shared-folder-store.js`);
const { invalidateVisibilityCache } = await import(`${D}/v6/visibility.js`);
const { pathFormLimits } = await import(`${D}/terminal/path-form.js`);   // 이 서버 파일 시스템의 상한(B15 — 사양의 매개변수)
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
const cap = (n) => appCapabilities.find((c) => c.name === n);
const install = (id) => cap("org_app_install").handler({ source: { kind: "inline", files: [
  { path: "lively-app.json", content: JSON.stringify({ id, title: id, version: "0.1.0", permissions: { app_folder: true }, ui: { pages: [{ key: "main", title: id, entry: "ui/index.html" }] } }) },
  { path: "ui/index.html", content: "<p>x</p>" }] } },
  { userId: "pgt-admin", email: "a@x", scopes: ["admin", "items"] }, { source: "mcp" });

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${typeof why === "string" ? why : JSON.stringify(why)}`); } };

let server = null;
try {
  await upsertMember({ id: "pgt-a", display_name: "가", state: "active", scopes: ["items"] }, "pgt");
  await upsertMember({ id: "pgt-b", display_name: "나", state: "active", scopes: ["items"] }, "pgt");
  await upsertMember({ id: "pgt-admin", display_name: "관리자", state: "active", scopes: ["admin", "items"] }, "pgt");
  const tok = {};
  for (const m of ["pgt-a", "pgt-b"]) tok[m] = (await mintToken({ userId: m, memberId: m, scopes: ["items"] }, "pgt")).token;

  const gw = express();
  gw.use(express.json({ limit: "1mb" }));
  registerTerminalFiles(gw, new BearerVerifier());
  server = http.createServer(gw);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const GW = `http://127.0.0.1:${server.address().port}`;
  const q = (o) => new URLSearchParams(o).toString();
  const call = (who, method, url, body) => fetch(GW + url, {
    method, headers: { authorization: `Bearer ${tok[who]}`, ...(body != null ? { "content-type": typeof body === "string" ? "application/octet-stream" : "application/json" } : {}) },
    body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  //  답 하나 — 상태 · 몸(글자 그대로) · 머리 둘. 날짜 · 길이 같은 머리는 몸이 같으면 같거나 견줄 값이 아니다.
  const answer = async (r) => ({ status: r.status, cache: r.headers.get("cache-control"), type: r.headers.get("content-type"), body: await r.text() });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const json = (a) => { try { return JSON.parse(a.body); } catch { return null; } };
  const disk = (...p) => path.join(ROOT, ...p);
  const putDisk = (rel, body = "x") => { const abs = disk(rel); mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, body); };

  //  라우트 — 경로 하나를 받아 답을 낸다(쓰기는 B 가 하는 것).
  const R = {
    list: (who, p) => call(who, "GET", `/api/ui/terminal/browse?${q({ root: "shared", path: p })}`),
    file: (who, p) => call(who, "GET", `/api/ui/terminal/browse/file?${q({ root: "shared", path: p })}`),
    download: (who, p) => call(who, "GET", `/api/ui/terminal/browse/file?${q({ root: "shared", path: p, download: "1" })}`),
    moved: (who, p) => call(who, "GET", `/api/ui/terminal/browse/moved?${q({ root: "shared", path: p })}`),
    info: (who, p) => call(who, "GET", `/api/ui/terminal/browse/info?${q({ root: "shared", path: p })}`),
    similar: (who, p) => call(who, "GET", `/api/ui/terminal/browse/similar?${q({ root: "shared", path: p })}`),
    mkdir: (who, p) => call(who, "POST", `/api/ui/terminal/browse/mkdir?${q({ root: "shared", path: p })}`),
    upload: (who, p) => call(who, "PUT", `/api/ui/terminal/browse/file?${q({ root: "shared", path: p })}`, "올림"),
    rename: (who, p, to = "새이름-4847.md") => call(who, "POST", `/api/ui/terminal/browse/rename?${q({ root: "shared", path: p, to })}`),
    remove: (who, p) => call(who, "DELETE", `/api/ui/terminal/browse?${q({ root: "shared", path: p })}`),
  };

  // ── 준비: 열린 프로젝트(둘 다 본다) · 숨은 프로젝트(가만 본다) · 잠긴 공유 폴더(가만 본다) ──
  const open = await createProject({ name: "같은 답 시험", dedupe: false }, { actor: "pgt-a" });
  const OF = await createProjectFolder(open.id); await setProjectFolder(open.id, OF, { source: "web" });
  putDisk(path.join("shared", OF, "docs", "설계.md"), "# 설계");
  mkdirSync(disk("shared", OF, "docs", "sub"), { recursive: true });
  const L = Number((await itemsPool.query(`INSERT INTO project_list(name, visibility) VALUES('pgt 숨은 리스트', 'members') RETURNING id`)).rows[0].id);
  await itemsPool.query(`INSERT INTO project_list_member(list_id, member_id) VALUES($1, 'pgt-a')`, [L]);
  const hidden = await createProject({ name: "숨은 프로젝트", dedupe: false, list_id: L }, { actor: "pgt-a" });
  const HF = await createProjectFolder(hidden.id); await setProjectFolder(hidden.id, HF, { source: "web" });
  putDisk(path.join("shared", HF, "숨은.md"), "숨은 본문");
  mkdirSync(disk("shared", HF, "폴더"), { recursive: true });
  putDisk("shared/hr/급여.md", "급여");
  mkdirSync(disk("shared", "hr", "sub"), { recursive: true });
  await setSharedFolderAcl("hr", "members", ["pgt-a"], { actor: "pgt-a" });
  //  루트 밖을 가리키는 링크 — 보이는 자리 하나 · 숨은 자리 하나(B8)
  symlinkSync(disk("outside"), disk("shared", OF, "밖"));
  symlinkSync(disk("outside"), disk("shared", HF, "밖"));
  invalidateVisibilityCache();

  //  배선 — 숨은 자리 · 잠긴 자리가 정말 «있고, 가에게는 보이고, 나에게는 안 보이는» 자리인가(없는 자리를 숨은 자리로 잘못 재지 않게)
  const wA = await answer(await R.file("pgt-a", `${HF}/숨은.md`));
  const wA2 = await answer(await R.file("pgt-a", "hr/급여.md"));
  const wB = json(await answer(await R.list("pgt-b", OF)));
  chk("배선 — 숨은 파일 · 잠긴 파일은 있고 가에게는 열린다 · 나에게 열린 프로젝트는 보인다",
    wA.status === 200 && wA.body === "숨은 본문" && wA2.status === 200 && wA2.body === "급여" && (wB?.items || []).some((i) => i.name === "docs"),
    { wA: wA.status, wA2: wA2.status, wB });

  //  자리 이름 — H 숨은 프로젝트 · A 잠긴 폴더 · N 볼 수 있는데 없음 · N2 파일 밑(있을 수 없는 자리)
  const NOPROJ = "project/999999";   // 없는 프로젝트 폴더 — 숨은 프로젝트 폴더 자체(Hroot)와 견준다
  const FILES = { H: `${HF}/숨은.md`, Hn: `${HF}/없는.md`, Hroot: HF, A: "hr/급여.md", N: `${OF}/없는-4847.md`, Ntop: "없는-맨위-4847/x.md", Nproj: NOPROJ, N2: `${OF}/docs/설계.md/x` };
  const DIRS = { H: `${HF}/폴더`, Hroot: HF, A: "hr/sub", N: `${OF}/없는폴더-4847`, Ntop: "없는-맨위-4847", Nproj: NOPROJ, N2: `${OF}/docs/설계.md/y` };

  // ── B1 목록 ──
  for (const [k, p] of Object.entries(DIRS)) {
    const a = await answer(await R.list("pgt-b", p));
    const b = json(a);
    const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    chk(`B1 목록 ${k} — 없는 폴더의 빈 목록(200 · 그 경로 · 빈 dirs/items · no-store)`,
      a.status === 200 && a.cache === "no-store" && b && b.root === "shared" && b.path === p && b.parent === parent
      && Array.isArray(b.dirs) && b.dirs.length === 0 && Array.isArray(b.items) && b.items.length === 0
      && JSON.stringify(Object.keys(b)) === JSON.stringify(["root", "path", "parent", "dirs", "items"]), a);
  }

  // ── B2 · B3 · B4 · B5 — 404 라우트는 «볼 수 있는데 없음(N)» 의 답과 통째로 같다 ──
  for (const route of ["file", "download", "moved", "info", "similar"]) {
    const ref = await answer(await R[route]("pgt-b", FILES.N));
    for (const [k, p] of Object.entries(FILES)) {
      if (k === "N") continue;
      const a = await answer(await R[route]("pgt-b", p));
      chk(`B${{ file: 2, download: 2, moved: 3, info: 4, similar: 5 }[route]} ${route} ${k} = 없음(N) — 상태 · 몸 · 머리 같음`, same(a, ref), { got: a, want: ref });
    }
    const want = route === "similar" ? { status: 200, body: { items: [] } } : { status: 404, body: { code: "file_not_found", error: "경로를 찾을 수 없습니다" } };
    const rb = json(ref);
    chk(`B${{ file: 2, download: 2, moved: 3, info: 4, similar: 5 }[route]} ${route} 없음의 답 — ${want.status} ${JSON.stringify(want.body)}`,
      ref.status === want.status && rb && JSON.stringify(rb) === JSON.stringify(want.body), ref);
  }
  const movedApps = await answer(await call("pgt-b", "GET", `/api/ui/terminal/browse/moved?${q({ root: "apps", path: "crm/x.md" })}`));
  chk("B3 옛 링크 풀기 — 공유 · 개인 밖 자리(apps)도 같은 404 몸 · 같은 머리", same(movedApps, await answer(await R.moved("pgt-b", FILES.N))), movedApps);

  // ── B6 이상한 이름 × 라우트 — 숨은 자리 · 보이는 자리의 답이 같은 400 ──
  const longName = "n".repeat(300);
  const longPath = Array.from({ length: 25 }, () => "p".repeat(200)).join("/");   // 5000바이트 넘게(리눅스 4095 · 맥 1023 를 다 넘는다)
  const WEIRD = { NUL: "a\u0000b.md", SOH: "a\u0001b.md", LF: "a\nb.md", DEL: "a\u007fb.md", "이름300B": longName, "경로5000B": longPath };
  const EXISTING_NAME_ROUTES = new Set(["rename", "remove"]);   // 이미 있는 이름을 다루는 라우트 — 제어 문자는 NUL 만 거른다
  for (const [w, name] of Object.entries(WEIRD)) {
    for (const route of Object.keys(R)) {
      const atHidden = await answer(await R[route]("pgt-b", `${HF}/${name}`));
      const atVisible = await answer(await R[route]("pgt-b", `${OF}/${name}`));
      const b = json(atVisible);
      const asName = EXISTING_NAME_ROUTES.has(route) && ["SOH", "LF", "DEL"].includes(w);
      chk(`B6 ${w} · ${route} — 숨은 자리 = 보이는 자리 = ${asName ? "404(없는 대상 — 이미 있는 이름의 글자)" : "400(code path_name_invalid)"}`,
        same(atHidden, atVisible) && (asName
          ? atVisible.status === 404 && b?.code === "file_not_found"
          : atVisible.status === 400 && b?.code === "path_name_invalid" && typeof b?.error === "string"),
        { atHidden, atVisible });
    }
  }
  //  폴더 안을 통째로 견준다 — 만들고 · 옮기고 · 지우는 라우트가 한 줄 안에 같이 돌아서, 만들어졌다가 다른 이름으로 옮겨진 것도 잡는다.
  const lsSorted = (...p) => readdirSync(disk(...p)).sort();
  chk("B6 배선 — 이상한 이름으로 아무것도 만들어지지도 · 옮겨지지도 않았다(두 폴더가 준비한 그대로)",
    JSON.stringify(lsSorted("shared", OF)) === JSON.stringify(["docs", "밖"].sort()) && JSON.stringify(lsSorted("shared", HF)) === JSON.stringify(["밖", "숨은.md", "폴더"].sort())
    && JSON.stringify(lsSorted("shared", OF, "docs")) === JSON.stringify(["sub", "설계.md"].sort()),
    { open: lsSorted("shared", OF), hidden: lsSorted("shared", HF), docs: lsSorted("shared", OF, "docs") });

  // ── B7 경계 — 이름 255(ASCII) 는 없는 자리의 답 · 256 은 400 ──
  for (const route of ["list", "file", "moved", "info", "similar"]) {
    const n255 = await answer(await R[route]("pgt-b", `${OF}/${"m".repeat(255)}`));
    const n256 = await answer(await R[route]("pgt-b", `${OF}/${"m".repeat(256)}`));
    const none = await answer(await R[route]("pgt-b", route === "list" ? DIRS.N : FILES.N));
    const strip = (a) => { const b = json(a); if (b && "path" in b) { delete b.path; delete b.parent; } return { ...a, body: JSON.stringify(b) }; };
    chk(`B7 ${route} — 255 는 없는 자리와 같은 답 · 256 은 400`,
      same(strip(n255), strip(none)) && n256.status === 400 && json(n256)?.code === "path_name_invalid", { n255, n256, none });
  }

  // ── B8 순서 — 링크가 루트 밖: 보이는 자리는 400 · 숨은 자리는 없는 자리의 답 ──
  const outFileV = await answer(await R.file("pgt-b", `${OF}/밖/x`));
  const outListV = await answer(await R.list("pgt-b", `${OF}/밖`));
  chk("B8 보이는 자리의 링크가 루트 밖 — 400 «허용 경로를 벗어났습니다»(파일 · 목록)",
    outFileV.status === 400 && json(outFileV)?.error === "허용 경로를 벗어났습니다" && outListV.status === 400 && json(outListV)?.error === "허용 경로를 벗어났습니다", { outFileV, outListV });
  const outFileH = await answer(await R.file("pgt-b", `${HF}/밖/x`));
  const outListH = json(await answer(await R.list("pgt-b", `${HF}/밖`)));
  chk("B8 같은 링크가 숨은 자리에 — 판정이 먼저라 없는 자리의 답(파일 404 같은 몸 · 목록 빈 목록)",
    same(outFileH, await answer(await R.file("pgt-b", FILES.N))) && outListH?.items?.length === 0 && outListH?.path === `${HF}/밖`, { outFileH, outListH });
  const outFileA = await answer(await R.file("pgt-a", `${HF}/밖/x`));
  chk("B8 배선 — 숨은 자리의 링크도 볼 수 있는 사람에겐 400(링크가 정말 루트 밖이다)", outFileA.status === 400, outFileA);

  // ── B9 이름 바꾸기 · 지우기 — 없는 대상 = 숨은 대상 = 잠긴 대상 ──
  for (const route of ["rename", "remove"]) {
    const ref = await answer(await R[route]("pgt-b", FILES.N));
    for (const k of ["H", "Hroot", "A", "Nproj", "N2"]) {
      const a = await answer(await R[route]("pgt-b", FILES[k]));
      chk(`B9 ${route} ${k} = 없음 — 같은 404 몸`, same(a, ref) && a.status === 404 && json(a)?.code === "file_not_found", { got: a, want: ref });
    }
  }
  chk("B9 숨은 파일 · 잠긴 파일은 그대로 남았다", existsSync(disk("shared", HF, "숨은.md")) && existsSync(disk("shared", "hr", "급여.md")));

  // ── B10 폴더 만들기 · 올리기 — 숨은 자리 · 잠긴 자리는 같은 404 · 아무것도 안 생긴다 ──
  for (const route of ["mkdir", "upload"]) {
    const h = await answer(await R[route]("pgt-b", `${HF}/새-4847.md`));
    const l = await answer(await R[route]("pgt-b", "hr/새-4847.md"));
    chk(`B10 ${route} 숨은 자리 = 잠긴 자리 = 404(code file_not_found)`, same(h, l) && h.status === 404 && json(h)?.code === "file_not_found", { h, l });
  }
  chk("B10 숨은 자리 · 잠긴 자리에 아무것도 안 생겼다", !existsSync(disk("shared", HF, "새-4847.md")) && !existsSync(disk("shared", "hr", "새-4847.md")));
  const made = await answer(await R.mkdir("pgt-b", `${OF}/새폴더-4847`));
  chk("B10 없는 자리(볼 수 있는)에는 만들어진다 — 만들기의 본성", made.status === 200 && existsSync(disk("shared", OF, "새폴더-4847")), made);

  // ── B11 이름 바꾸기의 새 이름 — 대상이 보이든 말든 같은 400 ──
  for (const [w, to] of Object.entries({ SOH: "a\u0001b.md", "이름256B": "t".repeat(256), "빈 이름": "" })) {
    const h = await answer(await R.rename("pgt-b", FILES.H, to));
    const n = await answer(await R.rename("pgt-b", FILES.N, to));
    const v = await answer(await R.rename("pgt-b", `${OF}/docs/설계.md`, to));
    chk(`B11 새 이름 ${w} — 숨은 대상 = 없는 대상 = 보이는 대상 = 400`, same(h, n) && same(n, v) && n.status === 400, { h, n, v });
  }
  chk("B11 보이는 파일은 이름이 안 바뀌었다", existsSync(disk("shared", OF, "docs", "설계.md")));

  // ── B12 휴지통 — 원래 자리를 못 보면 휴지통에 없는 것과 같은 답 ──
  const up = await call("pgt-a", "PUT", `/api/ui/terminal/browse/file?${q({ root: "shared", path: "vault/비밀-4847.md" })}`, "비밀");
  const upj = await up.json().catch(() => ({}));
  const del = await (await R.remove("pgt-a", "vault/비밀-4847.md")).json().catch(() => ({}));
  const SID = Number(upj.source_id);
  chk("B12 준비 — 공유 폴더에 올린 자료를 지우면 휴지통(자료 1)", up.status === 200 && SID > 0 && del.trashed === 1, { upj, del });
  await setSharedFolderAcl("vault", "members", ["pgt-a"], { actor: "pgt-a" });
  invalidateVisibilityCache();
  for (const op of ["restore", "purge"]) {
    const hiddenPlace = await answer(await call("pgt-b", "POST", `/api/ui/terminal/browse/trash/${op}`, { source_id: SID }));
    const noSuch = await answer(await call("pgt-b", "POST", `/api/ui/terminal/browse/trash/${op}`, { source_id: 2147483000 }));
    chk(`B12 ${op} — 원래 자리를 못 봄 = 휴지통에 없음(같은 404)`, same(hiddenPlace, noSuch) && noSuch.status === 404, { hiddenPlace, noSuch });
  }
  const back = await call("pgt-a", "POST", "/api/ui/terminal/browse/trash/restore", { source_id: SID });
  chk("B12 배선 — 그 자리를 보는 사람은 되살린다(자료는 정말 휴지통에 있었다)", back.status === 200 && existsSync(disk("shared", "vault", "비밀-4847.md")), back.status);

  // ── B14 이미 있는 이름에 제어 문자 — 지우기 · 이름 바꾸기는 되고, 열기는 400 ──
  putDisk(path.join("shared", OF, "ctl", "Icon\r"), "icon");
  putDisk(path.join("shared", OF, "ctl", "a\u0001b.md"), "ctl");
  const openCtl = await answer(await R.file("pgt-b", `${OF}/ctl/a\u0001b.md`));
  const renCtl = await answer(await R.rename("pgt-b", `${OF}/ctl/a\u0001b.md`, "고친이름-4847.md"));
  const delCtl = await answer(await R.remove("pgt-b", `${OF}/ctl/Icon\r`));
  chk("B14 이미 있는 제어 문자 이름 — 열기 400 · 이름 바꾸기 200(새 이름으로 옮겨짐) · 지우기 200(사라짐)",
    openCtl.status === 400 && json(openCtl)?.code === "path_name_invalid"
    && renCtl.status === 200 && existsSync(disk("shared", OF, "ctl", "고친이름-4847.md")) && !existsSync(disk("shared", OF, "ctl", "a\u0001b.md"))
    && delCtl.status === 200 && !existsSync(disk("shared", OF, "ctl", "Icon\r")),
    { openCtl, renCtl, delCtl });
  const renNul = await answer(await R.rename("pgt-b", `${OF}/ctl/a\u0000b.md`, "x.md"));
  chk("B14 이미 있는 이름이어도 NUL 은 400", renNul.status === 400 && json(renNul)?.code === "path_name_invalid", renNul);

  // ── B15 새 이름이 들어갈 경로 전체가 상한을 넘음 — 대상이 보이든 말든 · 있든 없든 같은 400 ──
  const lim = pathFormLimits();
  const sharedBase = disk("shared");
  const deepRel = (top, total) => {   // sharedBase/<top>/<채움>/f 의 절대경로 길이가 total 이 되게(채움은 200바이트 이하 마디)
    let need = total - Buffer.byteLength(sharedBase) - 1 - Buffer.byteLength(top) - 1 - 2;   // 끝의 "/f"
    const segs = []; while (need > 0) { const n = Math.min(200, need); segs.push("q".repeat(n)); need -= n + 1; }
    return `${top}/${segs.join("/")}/f`;
  };
  const srcV = deepRel(OF, lim.pathMax - 20), srcH = deepRel(HF, lim.pathMax - 20);
  putDisk(path.join("shared", srcV), "깊은 파일");
  const longTo = "t".repeat(40);   // 이름 하나로는 맞지만 새 경로 전체는 상한 + 19
  const b15v = await answer(await R.rename("pgt-b", srcV, longTo));
  const b15h = await answer(await R.rename("pgt-b", srcH, longTo));
  const b15n = await answer(await R.rename("pgt-b", srcV.replace(/\/f$/, "/없는"), longTo));
  chk("B15 새 경로 전체가 상한을 넘음 — 보이는 대상 = 숨은 대상 = 없는 대상 = 400(code path_name_invalid) · 원래 파일 그대로",
    Buffer.byteLength(path.join(sharedBase, srcV)) === lim.pathMax - 20 && same(b15v, b15h) && same(b15v, b15n)
    && b15v.status === 400 && json(b15v)?.code === "path_name_invalid" && existsSync(disk("shared", srcV)),
    { b15v, b15h, b15n, len: Buffer.byteLength(path.join(sharedBase, srcV)), pathMax: lim.pathMax });

  // ── B16 앱 폴더 — 동의 안 한 앱 · 없는 앱 = 동의한 앱의 없는 파일 ──
  await install("pgt-app-yes"); await install("pgt-app-no");
  await cap("me_app_grant").handler({ app_id: "pgt-app-yes" }, { userId: "pgt-b", scopes: ["items"] }, { source: "mcp" });
  putDisk("apps/pgt-app-yes/있음.md", "앱 파일");
  putDisk("apps/pgt-app-no/숨김.md", "남의 앱 파일");
  const A = (route, p) => call("pgt-b", "GET", route === "list" ? `/api/ui/terminal/browse?${q({ root: "apps", path: p })}`
    : route === "similar" ? `/api/ui/terminal/browse/similar?${q({ root: "apps", path: p })}`
    : `/api/ui/terminal/browse/file?${q({ root: "apps", path: p, ...(route === "download" ? { download: "1" } : {}) })}`);
  const yesFile = await answer(await A("file", "pgt-app-yes/있음.md"));
  chk("B16 배선 — 동의한 앱의 있는 파일은 열린다", yesFile.status === 200 && yesFile.body === "앱 파일", yesFile);
  for (const route of ["file", "download", "similar"]) {
    const ref = await answer(await A(route, "pgt-app-yes/없는-4847.md"));
    const no = await answer(await A(route, "pgt-app-no/숨김.md"));
    const none = await answer(await A(route, "pgt-app-none-4847/x.md"));
    chk(`B16 ${route} — 동의 안 한 앱의 있는 파일 = 없는 앱 = 동의한 앱의 없는 파일`, same(no, ref) && same(none, ref), { ref, no, none });
  }
  const strip2 = (a) => { const b = json(a); if (b) { delete b.path; delete b.parent; } return JSON.stringify({ ...a, body: b }); };
  const lsRef = await answer(await A("list", "pgt-app-yes/없는폴더-4847"));
  const lsNo = await answer(await A("list", "pgt-app-no"));
  const lsNone = await answer(await A("list", "pgt-app-none-4847"));
  chk("B16 list — 동의 안 한 앱 폴더 = 없는 앱 폴더 = 동의한 앱의 없는 폴더(빈 목록)",
    strip2(lsNo) === strip2(lsRef) && strip2(lsNone) === strip2(lsRef) && json(lsNo)?.items?.length === 0, { lsRef, lsNo, lsNone });

  // ── B17 개인 폴더 파일 밑 경로 · 루트 밖 파일 링크 뒤 경로 ──
  putDisk("box/pgt-b/uploads/a.txt", "개인");
  const P = (route, p) => call("pgt-b", "GET", route === "list" ? `/api/ui/terminal/browse?${q({ root: "personal", path: p })}` : `/api/ui/terminal/browse/file?${q({ root: "personal", path: p })}`);
  const pFileUnder = await answer(await P("file", "uploads/a.txt/x"));
  const pFileNone = await answer(await P("file", "uploads/없는.txt"));
  const pListUnder = json(await answer(await P("list", "uploads/a.txt/y")));
  chk("B17 개인 폴더 — 파일 밑 경로 = 없는 자리(미리보기 같은 404 · 목록 빈 목록)",
    same(pFileUnder, pFileNone) && pFileUnder.status === 404 && pListUnder?.items?.length === 0 && pListUnder?.path === "uploads/a.txt/y", { pFileUnder, pFileNone, pListUnder });
  symlinkSync(disk("outside", "x"), disk("shared", OF, "밖파일"));
  const outFileLink = await answer(await R.file("pgt-b", `${OF}/밖파일`));
  const outFileUnder = await answer(await R.file("pgt-b", `${OF}/밖파일/x`));
  chk("B17 루트 밖 파일 링크 — 링크 자체는 400 · 그 뒤 경로는 있을 수 없는 자리라 없는 자리와 같은 404",
    outFileLink.status === 400 && same(outFileUnder, await answer(await R.file("pgt-b", FILES.N))), { outFileLink, outFileUnder });

  // ── B13 볼 수 있고 있는 것은 그대로 ──
  const f = await answer(await R.file("pgt-b", `${OF}/docs/설계.md`));
  const dl = await R.download("pgt-b", `${OF}/docs/설계.md`);
  const inf = json(await answer(await R.info("pgt-b", `${OF}/docs/설계.md`)));
  const ls = json(await answer(await R.list("pgt-b", `${OF}/docs`)));
  const mv = json(await answer(await R.moved("pgt-b", `${OF}/docs/설계.md`)));
  const top = json(await answer(await R.list("pgt-b", "")));
  chk("B13 보이는 파일 · 폴더 · 루트 — 미리보기 바이트 · 내려받기 · 정보 · 목록 항목 · moved:false · 루트 목록(잠긴 hr 은 안 보임)",
    f.status === 200 && f.body === "# 설계" && dl.status === 200 && /attachment/.test(dl.headers.get("content-disposition") || "")
    && inf?.type === "file" && inf?.place?.kind === "project"
    && JSON.stringify((ls?.items || []).map((i) => i.name)) === JSON.stringify(["sub", "설계.md"]) && JSON.stringify(ls?.dirs) === JSON.stringify(["sub"])
    && mv?.moved === false && top?.path === "" && top?.parent === null && (top?.dirs || []).includes("project") && !(top?.dirs || []).includes("hr"),
    { f: f.status, dl: dl.status, inf: inf?.type, ls, mv, top });
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
