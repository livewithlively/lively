// 프로젝트 상세 페이지 백엔드 — 공유 폴더(파일 API) + 터미널 세션 + 작업 타임라인.
//  터미널 인프라 재사용: 폴더는 project-fs(projectAbsPath), 세션은 terminal-sessions(listSessions/createSession),
//  타임라인은 org/store(listProjectActivities). terminal-files.ts 와 동형(경로 realpath 봉쇄, .. 탈출 차단).
//  게이트: 인증된 멤버(auth) — 단일 조직 신뢰모델(터미널 browse/세션과 동일 수준). express.json 이후 마운트(업로드 raw 보존).
//  prefix+deps 로 일반화 — org(/api/ui/projects, org_project) + v6(/api/ui/v6/projects, project) 양쪽 등록.
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { BearerVerifier } from "./auth/bearer.js";
import type { LivelyUser } from "./context.js";
import { wrap, HttpError } from "./capabilities/rest-util.js";
import { getProject, listProjectActivities, isProjectMember } from "./org/store.js";
import { projectAbsPath } from "./project-fs.js";
import { listSessions, createSession } from "./terminal-sessions.js";

const MAX_UPLOAD = 50 * 1024 * 1024; // 50MB (terminal-files 와 동일)
const MAX_PREVIEW = 25 * 1024 * 1024; // 25MB — 이미지·PDF 인라인 미리보기 허용(텍스트는 클라가 별도 크기 가드)
const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
const idOf = (u: LivelyUser): string => u.userId || u.email || "";

// 확장자→Content-Type. **PDF/이미지 인라인 미리보기의 핵심** — 이 헤더가 없으면 브라우저가 blob 을 text 로
//  취급해 iframe 에 PDF 원시바이트(%PDF-1.3…)가 그대로 노출된다. 미지정 확장자는 octet-stream(다운로드 유도).
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8", json: "application/json; charset=utf-8", log: "text/plain; charset=utf-8",
};
function contentTypeFor(name: string): string {
  const i = name.lastIndexOf(".");
  const ext = i >= 0 ? name.slice(i + 1).toLowerCase() : "";
  return MIME[ext] || "application/octet-stream";
}

// 프로젝트 소스 의존성 — org / v6 가 같은 라우트 로직을 공유하되 데이터 접근만 갈아끼운다.
interface ProjectDeps {
  prefix: string;
  getProject: (id: number) => Promise<{ id: number; name: string; folder: string | null } | undefined | null>;
  isProjectMember: (id: number, memberId: string) => Promise<boolean>;
  listProjectActivities: (id: number, authorPerson?: string, limit?: number) => Promise<unknown[]>;
  // folder 가 비었을 때 물리 폴더를 생성하고 DB 에 반영 후 상대경로 반환(v6 보강용). 없으면 폴더 없음 400.
  ensureFolder?: (project: { id: number; name: string }) => Promise<string>;
}

// base 기준 안전 경로 해소(.. 탈출 차단). requireFile=true 면 루트 자신 거부(파일 경로 필요).
function resolveIn(base: string, rel: unknown, requireFile: boolean): string {
  const r = String(rel ?? "").replace(/^[/\\]+/, "");
  const abs = path.resolve(base, r);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new HttpError(400, "허용 경로를 벗어났습니다");
  if (requireFile && (r === "" || abs === base)) throw new HttpError(400, "파일 경로가 필요합니다");
  return abs;
}

// 이름에 q 가 든 파일/폴더 재귀 검색(숨김 제외, 깊이·결과 상한).
async function searchFiles(base: string, q: string, limit = 100): Promise<Array<{ name: string; path: string; type: "dir" | "file"; size: number }>> {
  const out: Array<{ name: string; path: string; type: "dir" | "file"; size: number }> = [];
  const needle = q.toLowerCase();
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (out.length >= limit || depth > 8) return;
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const childRel = rel ? rel + "/" + e.name : e.name;
      const isDir = e.isDirectory();
      if (e.name.toLowerCase().includes(needle)) {
        let size = 0;
        if (!isDir) { try { size = (await fsp.stat(path.join(dir, e.name))).size; } catch { /* skip */ } }
        out.push({ name: e.name, path: childRel, type: isDir ? "dir" : "file", size });
        if (out.length >= limit) return;
      }
      if (isDir) await walk(path.join(dir, e.name), childRel, depth + 1);
    }
  }
  await walk(base, "", 0);
  return out;
}

// 한 소스(org 또는 v6)에 대해 파일/세션/타임라인 라우트를 prefix 아래 등록한다.
function mountProjectRoutes(app: express.Express, auth: express.RequestHandler, deps: ProjectDeps): void {
  const { prefix } = deps;

  // 프로젝트 + 폴더 절대경로(검증됨). 팀원 게이트. v6 는 folder 비면 ensureFolder 로 생성.
  const projBase = async (id: number, viewerId?: string): Promise<{ project: { id: number; name: string; folder: string }; base: string }> => {
    const project = await deps.getProject(id);
    if (!project) throw new HttpError(404, "프로젝트를 찾을 수 없습니다");
    if (viewerId !== undefined && !(await deps.isProjectMember(id, viewerId))) throw new HttpError(403, "초대받은 팀원만 접근할 수 있습니다");
    let folder = project.folder;
    if (!folder && deps.ensureFolder) folder = await deps.ensureFolder({ id: project.id, name: project.name });
    if (!folder) throw new HttpError(400, "프로젝트 폴더가 없습니다");
    return { project: { id: project.id, name: project.name, folder }, base: projectAbsPath(folder) };
  };

  // ── ① 공유 폴더 — 목록 / 검색(q) ──
  app.get(`${prefix}/:id/files`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id), idOf(userOf(req)));
    res.setHeader("Cache-Control", "no-store");
    const q = String(req.query.q ?? "").trim();
    if (q) { res.json({ search: q, items: await searchFiles(base, q) }); return; }
    const abs = resolveIn(base, req.query.path, false);
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
    res.json({ path: rel, parent: rel ? (path.dirname(rel) === "." ? "" : path.dirname(rel)) : null, items });
  }));

  // 다운로드 / 미리보기
  app.get(`${prefix}/:id/file`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id), idOf(userOf(req)));
    const abs = resolveIn(base, req.query.path, true);
    let st: fs.Stats;
    try { st = await fsp.stat(abs); } catch { throw new HttpError(404, "파일 없음"); }
    if (!st.isFile()) throw new HttpError(400, "파일이 아닙니다");
    const download = req.query.download === "1";
    if (!download && st.size > MAX_PREVIEW) throw new HttpError(413, "미리보기엔 너무 큽니다 — 다운로드하세요");
    res.setHeader("Cache-Control", "no-store");
    // 미리보기는 실제 MIME 으로(PDF=application/pdf → iframe 네이티브 뷰어 렌더). 다운로드는 octet-stream +
    //  Content-Disposition: attachment 로 강제 저장(브라우저가 인라인 표시하지 않게).
    if (download) {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
    } else {
      res.setHeader("Content-Type", contentTypeFor(abs));
    }
    fs.createReadStream(abs).pipe(res);
  }));

  // 업로드(raw 스트림)
  app.put(`${prefix}/:id/file`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id), idOf(userOf(req)));
    const abs = resolveIn(base, req.query.path, true);
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

  // 새 폴더 생성
  app.post(`${prefix}/:id/folder`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id), idOf(userOf(req)));
    const abs = resolveIn(base, req.query.path, true);
    await fsp.mkdir(abs, { recursive: true });
    res.json({ ok: true });
  }));

  // 이름 변경 — 같은 폴더 안에서 이름만(파일·폴더 공통). body: { path, name }.
  app.post(`${prefix}/:id/rename`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id), idOf(userOf(req)));
    const b = (req.body ?? {}) as Record<string, unknown>;
    const fromAbs = resolveIn(base, b.path, true);
    const newName = String(b.name ?? "").trim();
    if (!newName || /[/\\]/.test(newName) || newName === "." || newName === ".." || newName.startsWith(".")) {
      throw new HttpError(400, "올바른 이름이 필요합니다(/ \\ · 숨김 불가)");
    }
    const toAbs = path.join(path.dirname(fromAbs), newName);
    if (toAbs !== base && !toAbs.startsWith(base + path.sep)) throw new HttpError(400, "허용 경로를 벗어났습니다");
    try { await fsp.access(fromAbs); } catch { throw new HttpError(404, "대상이 없습니다"); }
    try { await fsp.access(toAbs); throw new HttpError(409, "같은 이름이 이미 있습니다"); } catch (e: any) { if (e instanceof HttpError) throw e; }
    await fsp.rename(fromAbs, toAbs);
    res.json({ ok: true });
  }));

  // 삭제 — 파일/폴더(폴더는 내용까지 재귀). 루트 자신은 거부(requireFile). path 필수.
  app.delete(`${prefix}/:id/file`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id), idOf(userOf(req)));
    const abs = resolveIn(base, req.query.path, true);
    await fsp.rm(abs, { recursive: true, force: true });
    res.json({ ok: true });
  }));

  // ── ② 터미널 세션(공동 — 프로젝트 팀원 전용) — 목록 / 생성. 비팀원은 게이트 403. ──
  app.get(`${prefix}/:id/sessions`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id), idOf(userOf(req)));
    res.setHeader("Cache-Control", "no-store");
    const all = await listSessions(userOf(req));
    const sessions = all.filter((s) => s.dir && (s.dir === base || s.dir.startsWith(base + path.sep)));
    res.json({ sessions });
  }));
  app.post(`${prefix}/:id/sessions`, auth, wrap(async (req, res) => {
    const { project } = await projBase(Number(req.params.id), idOf(userOf(req)));
    const b = (req.body ?? {}) as Record<string, unknown>;
    const session = await createSession(userOf(req), {
      label: String(b.label ?? ""), rootKey: "shared", subpath: project.folder,
      harness: String(b.harness ?? "shell"),
      flags: (b.flags && typeof b.flags === "object") ? b.flags as Record<string, unknown> : {},
      autoApprove: !!b.autoApprove, visibility: String(b.visibility ?? "public"),
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ session });
  }));

  // ── ③ 작업 타임라인 — 팀원 activity(author_person 지정 시 그 사람만) ──
  app.get(`${prefix}/:id/activity`, auth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    await projBase(id, idOf(userOf(req))); // 존재·폴더·팀원 게이트
    const authorPerson = req.query.author_person ? String(req.query.author_person) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    res.setHeader("Cache-Control", "no-store");
    res.json({ activities: await deps.listProjectActivities(id, authorPerson, limit) });
  }));
}

// org(org_project) 라우트 등록. 기본 export — index.ts 가 호출.
export function registerProjectRoutes(app: express.Express, verifier: BearerVerifier): void {
  const auth = requireBearerAuth({ verifier });
  mountProjectRoutes(app, auth, {
    prefix: "/api/ui/projects",
    getProject: (id) => getProject(id),
    isProjectMember: (id, m) => isProjectMember(id, m),
    listProjectActivities: (id, a, l) => listProjectActivities(id, a, l),
  });
}

// v6(project) 라우트 등록 — 같은 파일/세션/타임라인 로직, 데이터만 v6. ensureFolder 로 폴더 lazy 생성.
export function registerProjectV6Routes(
  app: express.Express,
  verifier: BearerVerifier,
  deps: {
    getProject: ProjectDeps["getProject"];
    isProjectMember: ProjectDeps["isProjectMember"];
    listProjectActivities: ProjectDeps["listProjectActivities"];
    ensureFolder: NonNullable<ProjectDeps["ensureFolder"]>;
  },
): void {
  const auth = requireBearerAuth({ verifier });
  mountProjectRoutes(app, auth, { prefix: "/api/ui/v6/projects", ...deps });
}
