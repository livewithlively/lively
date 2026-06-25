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
import { canAttach, sessionDir, resolveRootPath } from "./terminal-sessions.js";

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

export function registerTerminalFiles(app: express.Express, verifier: BearerVerifier): void {
  const auth = sessionOrBearer(verifier); // 세션 쿠키(웹 로그인) OR bearer(에이전트) — 둘 다 수용

  // 생성폼 폴더 탐색(세션 무관) — 허용 루트 내부 디렉터리 목록. 인증된 멤버면 OK(개인 루트는 per-user 격리).
  app.get("/api/ui/terminal/browse", auth, wrap(async (req, res) => {
    const { base, abs } = resolveRootPath(userOf(req), String(req.query.root ?? ""), String(req.query.path ?? ""));
    await fsp.mkdir(base, { recursive: true }).catch(() => { /* 개인 루트 없으면 생성 */ });
    let entries: fs.Dirent[] = [];
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { entries = []; }
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort((a, b) => a.localeCompare(b));
    const rel = path.relative(base, abs);
    res.setHeader("Cache-Control", "no-store");
    res.json({ root: req.query.root, path: rel, parent: rel ? (path.dirname(rel) === "." ? "" : path.dirname(rel)) : null, dirs });
  }));
  // 생성폼에서 새 폴더 만들기(세션 무관).
  app.post("/api/ui/terminal/browse/mkdir", auth, wrap(async (req, res) => {
    const { abs } = resolveRootPath(userOf(req), String(req.query.root ?? ""), String(req.query.path ?? ""));
    await fsp.mkdir(abs, { recursive: true, mode: 0o700 });
    res.json({ ok: true });
  }));

  // 디렉터리 목록(숨김 제외).
  app.get("/api/ui/terminal/sessions/:id/ls", auth, wrap(async (req, res) => {
    const { base, abs } = await resolveInSession(req, false);
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { throw new HttpError(404, "디렉터리 없음"); }
    const items: Array<{ name: string; type: "dir" | "file"; size: number }> = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const isDir = e.isDirectory();
      let size = 0;
      if (!isDir) { try { size = (await fsp.stat(path.join(abs, e.name))).size; } catch { /* skip */ } }
      items.push({ name: e.name, type: isDir ? "dir" : "file", size });
    }
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    const rel = path.relative(base, abs);
    res.setHeader("Cache-Control", "no-store");
    res.json({ path: rel, parent: rel ? (path.dirname(rel) === "." ? "" : path.dirname(rel)) : null, items });
  }));

  // 미리보기/다운로드.
  app.get("/api/ui/terminal/sessions/:id/file", auth, wrap(async (req, res) => {
    const { abs } = await resolveInSession(req, true);
    let st: fs.Stats;
    try { st = await fsp.stat(abs); } catch { throw new HttpError(404, "파일 없음"); }
    if (!st.isFile()) throw new HttpError(400, "파일이 아닙니다");
    const download = req.query.download === "1";
    if (!download && st.size > MAX_PREVIEW) throw new HttpError(413, "미리보기엔 너무 큽니다 — 다운로드하세요");
    res.setHeader("Cache-Control", "no-store");
    if (download) res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
    fs.createReadStream(abs).pipe(res);
  }));

  // 새 폴더 생성.
  app.post("/api/ui/terminal/sessions/:id/mkdir", auth, wrap(async (req, res) => {
    const { abs } = await resolveInSession(req, true);
    await fsp.mkdir(abs, { recursive: true });
    res.json({ ok: true });
  }));

  // 업로드(raw 스트림 → 파일). content-type 무관(express.json 은 json 만 소비하므로 스트림 보존).
  app.put("/api/ui/terminal/sessions/:id/file", auth, wrap(async (req, res) => {
    const { abs } = await resolveInSession(req, true);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(abs);
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_UPLOAD) { ws.destroy(); req.destroy(); reject(new HttpError(413, "파일이 너무 큽니다(50MB 초과)")); }
      });
      req.on("error", reject);
      ws.on("error", reject);
      ws.on("finish", () => resolve());
      req.pipe(ws);
    });
    res.json({ ok: true });
  }));
}
