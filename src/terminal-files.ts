// 중앙 박스 — 세션 작업 디렉터리(@box_dir) 파일 API. 익스플로러/업로드/다운로드/미리보기용.
// 게이트: canAttach(소유자 OR 초대된 멤버) — 터미널을 열 수 있으면 셸로 어차피 그 폴더를 만질 수 있으므로 동일 권한.
// 봉쇄: 모든 경로를 @box_dir 내부로 realpath 검증(.. 탈출 차단).
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { sessionOrBearer } from "./auth/http-auth.js";
import type { BearerVerifier } from "./auth/bearer.js";
import type { LivelyUser } from "./context.js";
import { wrap, HttpError } from "./capabilities/rest-util.js";
import { canAttach, sessionDir, resolveRootPath, sessionOsUser, userOsUser } from "./terminal-sessions.js";
import { memberLs, memberStat, memberMkdir, memberMv, memberRm, memberReadTo, type LsEntry } from "./terminal-member-fs.js";
import { receiveUpload, uploadError } from "./upload-file.js";
import { nodeCanAttach, nodeRpc } from "./node/registry.js";

const MAX_UPLOAD = 50 * 1024 * 1024; // 50MB
const MAX_PREVIEW = 2 * 1024 * 1024; // 2MB
const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
const idOf = (u: LivelyUser): string => u.userId || u.email || "";

// @box_dir 기준 안전 경로 해소(+ 접근권한 확인). rel 의 .. 탈출은 거부.
async function resolveInSession(req: express.Request, requireFile: boolean): Promise<{ base: string; abs: string }> {
  const id = req.params.id;
  if (!(await canAttach(id, idOf(userOf(req))))) throw new HttpError(403, "세션 접근 권한이 없습니다");
  const base = path.resolve(await sessionDir(id));
  const rel = String((req.query.path ?? "")).replace(/^[/\\]+/, "");
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new HttpError(400, "허용 경로를 벗어났습니다");
  if (requireFile && (rel === "" || abs === base)) throw new HttpError(400, "파일 경로가 필요합니다");
  return { base, abs };
}

// 노드 세션 파일 릴레이(#875) — ?node= 면 게이트웨이가 nodeCanAttach 로 인가(정책=게이트웨이, 실행=노드 F7)하고 nodeId 반환.
//  중앙 세션이면 null(로컬 fs 경로). 거부 코드: 4410 gone→404 · 4462 offline→503 · 그 외 no-access→403.
async function nodeFor(req: express.Request): Promise<string | null> {
  const nodeId = String(req.query.node ?? "").trim();
  if (!nodeId) return null;
  const v = await nodeCanAttach(nodeId, req.params.id, idOf(userOf(req)));
  if (!v.ok) throw new HttpError(v.code === 4410 ? 404 : v.code === 4462 ? 503 : 403, v.reason);
  return nodeId;
}
const NODE_FS_CHUNK = 256 * 1024; // base64 하면 ~341KB < ws maxPayload(1MB). 파일 바이트를 이 크기로 청크.

export function registerTerminalFiles(app: express.Express, verifier: BearerVerifier): void {
  const auth = sessionOrBearer(verifier); // 세션 쿠키(웹 로그인) OR bearer(에이전트) — 둘 다 수용

  // 루트 브라우즈용 경로 해소(+접근 osUser). requireSub=true 면 루트 자체(base)는 거부(대상 경로 필요).
  //  경로 봉쇄(루트 내부, .. 탈출 거부)는 resolveRootPath 가 이미 건다.
  async function resolveBrowse(req: express.Request, requireSub: boolean): Promise<{ base: string; abs: string; osUser: string | null }> {
    const u = userOf(req);
    const { base, abs } = await resolveRootPath(u, String(req.query.root ?? ""), String(req.query.path ?? ""));
    if (requireSub && abs === base) throw new HttpError(400, "대상 경로가 필요합니다");
    const osUser = await userOsUser(u);
    return { base, abs, osUser };
  }

  // 생성폼 폴더 탐색 + 공유 폴더 브라우저(세션 무관) — 허용 루트 내부 목록. 격리 멤버면 그 uid 로(개인 루트=멤버 홈 700).
  //  dirs = 폴더명(하위호환: 생성폼 폴더 피커·대시보드 박스). items = 폴더+파일(type·size, 대시보드 폴더 브라우저 #672).
  app.get("/api/ui/terminal/browse", auth, wrap(async (req, res) => {
    const u = userOf(req);
    const { base, abs } = await resolveRootPath(u, String(req.query.root ?? ""), String(req.query.path ?? ""));
    const osUser = await userOsUser(u);
    const items: Array<{ name: string; type: "dir" | "file"; size: number; mtime: number }> = [];
    if (osUser) {
      await memberMkdir(osUser, base).catch(() => { /* 루트 없으면 생성 */ });
      let entries: LsEntry[] = [];
      try { entries = await memberLs(osUser, abs); } catch { entries = []; }
      for (const e of entries) if (!e.name.startsWith(".")) items.push({ name: e.name, type: e.type, size: e.size, mtime: e.mtime });
    } else {
      await fsp.mkdir(base, { recursive: true }).catch(() => { /* 개인 루트 없으면 생성 */ });
      let entries: fs.Dirent[] = [];
      try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { entries = []; }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const isDir = e.isDirectory();
        let size = 0, mtime = 0;
        try { const st = await fsp.stat(path.join(abs, e.name)); mtime = Math.floor(st.mtimeMs); if (!isDir) size = st.size; } catch { /* skip */ }
        items.push({ name: e.name, type: isDir ? "dir" : "file", size, mtime });
      }
    }
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    const dirs = items.filter((i) => i.type === "dir").map((i) => i.name);
    const rel = path.relative(base, abs);
    res.setHeader("Cache-Control", "no-store");
    res.json({ root: req.query.root, path: rel, parent: rel ? (path.dirname(rel) === "." ? "" : path.dirname(rel)) : null, dirs, items });
  }));
  // 생성폼·브라우저에서 새 폴더 만들기(세션 무관). 격리 멤버면 그 uid 로(생성 폴더 소유자=멤버).
  app.post("/api/ui/terminal/browse/mkdir", auth, wrap(async (req, res) => {
    const u = userOf(req);
    const { abs } = await resolveRootPath(u, String(req.query.root ?? ""), String(req.query.path ?? ""));
    const osUser = await userOsUser(u);
    if (osUser) await memberMkdir(osUser, abs);
    else await fsp.mkdir(abs, { recursive: true, mode: 0o700 });
    res.json({ ok: true });
  }));
  // ── 공유 폴더 브라우저 CRUD(#672) — 루트 내부 파일/폴더 이름변경·삭제·다운로드·업로드. ──
  //  게이트: browse/mkdir 과 동일(auth 만) — 이 루트는 셸(터미널)로 이미 rw 가능하므로 UI CRUD 가 새 권한경계를 열지 않는다.
  //  이름변경 — 같은 폴더 안에서만(to 는 파일명 1개, 경로 구분자 금지). 대상 존재 시 409(덮어쓰기 방지).
  app.post("/api/ui/terminal/browse/rename", auth, wrap(async (req, res) => {
    const { base, abs, osUser } = await resolveBrowse(req, true);
    const toName = String(req.query.to ?? "").trim();
    if (!toName || toName.includes("/") || toName.includes("\\") || toName === "." || toName === "..") throw new HttpError(400, "새 이름이 올바르지 않습니다");
    const toAbs = path.resolve(path.dirname(abs), toName);
    if (toAbs !== base && !toAbs.startsWith(base + path.sep)) throw new HttpError(400, "허용 경로를 벗어났습니다");
    if (osUser) {
      if (await memberStat(osUser, toAbs)) throw new HttpError(409, "같은 이름이 이미 있습니다");
      await memberMv(osUser, abs, toAbs);
    } else {
      if (fs.existsSync(toAbs)) throw new HttpError(409, "같은 이름이 이미 있습니다");
      await fsp.rename(abs, toAbs);
    }
    res.json({ ok: true });
  }));
  // 삭제(파일/폴더 재귀). 루트 자체는 거부.
  app.delete("/api/ui/terminal/browse", auth, wrap(async (req, res) => {
    const { abs, osUser } = await resolveBrowse(req, true);
    if (osUser) await memberRm(osUser, abs);
    else await fsp.rm(abs, { recursive: true, force: true });
    res.json({ ok: true });
  }));
  // 미리보기/다운로드(?download=1). 격리 멤버면 그 uid 로 stat+cat.
  app.get("/api/ui/terminal/browse/file", auth, wrap(async (req, res) => {
    const { abs, osUser } = await resolveBrowse(req, true);
    const download = req.query.download === "1";
    const setDl = (): void => {
      res.setHeader("Cache-Control", "no-store");
      if (download) res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
    };
    if (osUser) {
      const st = await memberStat(osUser, abs);
      if (!st) throw new HttpError(404, "파일 없음");
      if (!st.file) throw new HttpError(400, "파일이 아닙니다");
      if (!download && st.size > MAX_PREVIEW) throw new HttpError(413, "미리보기엔 너무 큽니다 — 다운로드하세요");
      setDl();
      await memberReadTo(osUser, abs, res).catch((e) => { if (!res.headersSent) throw new HttpError(500, "읽기 실패"); res.destroy(e as Error); });
      return;
    }
    let st: fs.Stats;
    try { st = await fsp.stat(abs); } catch { throw new HttpError(404, "파일 없음"); }
    if (!st.isFile()) throw new HttpError(400, "파일이 아닙니다");
    if (!download && st.size > MAX_PREVIEW) throw new HttpError(413, "미리보기엔 너무 큽니다 — 다운로드하세요");
    setDl();
    fs.createReadStream(abs).pipe(res);
  }));
  // 업로드(raw 스트림 → 임시파일 → rename). 격리 멤버면 그 uid 로 써서 파일 소유자=멤버(세션 셸이 이후 편집 가능).
  //  취소·끊김이면 목적지는 손대지 않는다 — 덮어쓰기 업로드를 끊어도 원본이 살아있다(#797 — upload-file.ts).
  app.put("/api/ui/terminal/browse/file", auth, wrap(async (req, res) => {
    const { abs, osUser } = await resolveBrowse(req, true);
    try { await receiveUpload(req, abs, MAX_UPLOAD, osUser); }
    catch (e) { const he = uploadError(e); if (!he) return; throw he; } // he=null → 업로드 취소, 응답할 상대가 없다
    res.json({ ok: true });
  }));

  // 디렉터리 목록(숨김 제외). 격리 세션(#524)은 멤버 uid 로(게이트웨이가 700 홈 못 읽으므로).
  app.get("/api/ui/terminal/sessions/:id/ls", auth, wrap(async (req, res) => {
    const nodeId = await nodeFor(req);
    if (nodeId) { // 노드 세션 — 노드 로컬 fs 목록 릴레이(#875)
      const d = await nodeRpc(nodeId, "fsLs", { id: req.params.id, sub: String(req.query.path ?? ""), user: { userId: idOf(userOf(req)) } });
      res.setHeader("Cache-Control", "no-store"); res.json(d); return;
    }
    const { base, abs } = await resolveInSession(req, false);
    const osUser = await sessionOsUser(req.params.id);
    const items: Array<{ name: string; type: "dir" | "file"; size: number; mtime: number }> = [];
    if (osUser) {
      let entries;
      try { entries = await memberLs(osUser, abs); } catch { throw new HttpError(404, "디렉터리 없음"); }
      for (const e of entries) { if (!e.name.startsWith(".")) items.push({ name: e.name, type: e.type, size: e.size, mtime: e.mtime }); }
    } else {
      let entries: fs.Dirent[];
      try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { throw new HttpError(404, "디렉터리 없음"); }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const isDir = e.isDirectory();
        let size = 0, mtime = 0;
        try { const st = await fsp.stat(path.join(abs, e.name)); mtime = Math.floor(st.mtimeMs); if (!isDir) size = st.size; } catch { /* skip */ }
        items.push({ name: e.name, type: isDir ? "dir" : "file", size, mtime });
      }
    }
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    const rel = path.relative(base, abs);
    res.setHeader("Cache-Control", "no-store");
    res.json({ path: rel, parent: rel ? (path.dirname(rel) === "." ? "" : path.dirname(rel)) : null, items });
  }));

  // 미리보기/다운로드. 격리 세션(#524)은 멤버 uid 로 stat+cat.
  app.get("/api/ui/terminal/sessions/:id/file", auth, wrap(async (req, res) => {
    const nodeId = await nodeFor(req);
    if (nodeId) { // 노드 세션 — 청크 base64 read 릴레이(#875). len=0 로 크기 프리체크 후 스트리밍.
      const rel = String(req.query.path ?? ""); const download = req.query.download === "1";
      const u = { userId: idOf(userOf(req)) };
      const head = await nodeRpc<{ size: number }>(nodeId, "fsRead", { id: req.params.id, path: rel, offset: 0, len: 0, user: u });
      if (head.size == null) throw new HttpError(404, "파일 없음");
      if (!download && head.size > MAX_PREVIEW) throw new HttpError(413, "미리보기엔 너무 큽니다 — 다운로드하세요");
      res.setHeader("Cache-Control", "no-store");
      if (download) res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(rel))}`);
      for (let offset = 0; offset < head.size;) {
        const r = await nodeRpc<{ data?: string; eof?: boolean }>(nodeId, "fsRead", { id: req.params.id, path: rel, offset, len: NODE_FS_CHUNK, user: u });
        if (r.data) res.write(Buffer.from(r.data, "base64"));
        offset += NODE_FS_CHUNK;
        if (r.eof) break;
      }
      res.end(); return;
    }
    const { abs } = await resolveInSession(req, true);
    const osUser = await sessionOsUser(req.params.id);
    const download = req.query.download === "1";
    const setDl = (): void => {
      res.setHeader("Cache-Control", "no-store");
      if (download) res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
    };
    if (osUser) {
      const st = await memberStat(osUser, abs);
      if (!st) throw new HttpError(404, "파일 없음");
      if (!st.file) throw new HttpError(400, "파일이 아닙니다");
      if (!download && st.size > MAX_PREVIEW) throw new HttpError(413, "미리보기엔 너무 큽니다 — 다운로드하세요");
      setDl();
      await memberReadTo(osUser, abs, res).catch((e) => { if (!res.headersSent) throw new HttpError(500, "읽기 실패"); res.destroy(e as Error); });
      return;
    }
    let st: fs.Stats;
    try { st = await fsp.stat(abs); } catch { throw new HttpError(404, "파일 없음"); }
    if (!st.isFile()) throw new HttpError(400, "파일이 아닙니다");
    if (!download && st.size > MAX_PREVIEW) throw new HttpError(413, "미리보기엔 너무 큽니다 — 다운로드하세요");
    setDl();
    fs.createReadStream(abs).pipe(res);
  }));

  // 새 폴더 생성. 격리 세션은 멤버 uid 로(생성 파일 소유자=멤버).
  app.post("/api/ui/terminal/sessions/:id/mkdir", auth, wrap(async (req, res) => {
    const nodeId = await nodeFor(req);
    if (nodeId) { await nodeRpc(nodeId, "fsMkdir", { id: req.params.id, sub: String(req.query.path ?? ""), user: { userId: idOf(userOf(req)) } }); res.json({ ok: true }); return; }
    const { abs } = await resolveInSession(req, true);
    const osUser = await sessionOsUser(req.params.id);
    if (osUser) await memberMkdir(osUser, abs);
    else await fsp.mkdir(abs, { recursive: true });
    res.json({ ok: true });
  }));

  // 업로드(raw 스트림 → 임시파일 → rename). content-type 무관(express.json 은 json 만 소비하므로 스트림 보존).
  //  격리 세션은 멤버 uid 로 써서 파일 소유자가 멤버가 되게 한다(그래야 세션 셸이 이후 편집 가능).
  app.put("/api/ui/terminal/sessions/:id/file", auth, wrap(async (req, res) => {
    const nodeId = await nodeFor(req);
    if (nodeId) { // 노드 세션 — 본문을 모아 청크 base64 write 릴레이(#875). 순차 청크(offset 0=truncate, 이후 append).
      const rel = String(req.query.path ?? ""); if (!rel) throw new HttpError(400, "파일 경로가 필요합니다");
      const u = { userId: idOf(userOf(req)) };
      const bufs: Buffer[] = []; let total = 0; let over = false;
      await new Promise<void>((resolve, reject) => {
        req.on("data", (c: Buffer) => { total += c.length; if (total > MAX_UPLOAD) { over = true; req.destroy(); return; } bufs.push(c); });
        req.on("end", () => resolve()); req.on("error", reject);
      });
      if (over) throw new HttpError(413, "파일이 너무 큽니다");
      const bodyBuf = Buffer.concat(bufs);
      let offset = 0;
      do {
        const slice = bodyBuf.subarray(offset, offset + NODE_FS_CHUNK);
        await nodeRpc(nodeId, "fsWrite", { id: req.params.id, path: rel, offset, data: slice.toString("base64"), user: u });
        offset += NODE_FS_CHUNK;
      } while (offset < bodyBuf.length);
      res.json({ ok: true, path: rel }); return;
    }
    const { abs } = await resolveInSession(req, true);
    const osUser = await sessionOsUser(req.params.id);
    try { await receiveUpload(req, abs, MAX_UPLOAD, osUser); }
    catch (e) { const he = uploadError(e); if (!he) return; throw he; } // he=null → 업로드 취소, 응답할 상대가 없다
    res.json({ ok: true, path: abs }); // abs = 세션 작업폴더 기준 절대경로(드롭 업로드가 입력창에 꽂아 cwd 무관하게 찾게)
  }));
}
