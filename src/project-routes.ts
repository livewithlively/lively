// 프로젝트 상세 페이지 백엔드 — 공유 폴더(파일 API) + 터미널 세션 + 작업 타임라인.
//  터미널 인프라 재사용: 폴더는 project-fs(projectAbsPath), 세션은 terminal-sessions(listSessions/createSession),
//  타임라인은 org/store(listProjectActivities). terminal-files.ts 와 동형(경로 realpath 봉쇄, .. 탈출 차단).
//  게이트: 인증된 멤버(auth) — 단일 조직 신뢰모델(터미널 browse/세션과 동일 수준). express.json 이후 마운트(업로드 raw 보존).
//  prefix+deps 로 일반화 — org(/api/ui/projects, org_project) + v6(/api/ui/v6/projects, project) 양쪽 등록.
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { sessionOrBearer } from "./auth/http-auth.js";
import type { BearerVerifier } from "./auth/bearer.js";
import type { LivelyUser } from "./context.js";
import { wrap, HttpError } from "./capabilities/rest-util.js";
import { projectAbsPath } from "./project-fs.js";
import { listSessions, createSession, validateInvites, type CreateInput } from "./terminal-sessions.js";
import { ensureAgentsMd, readProjectAgentsMd } from "./v6/agents-md.js";
import { provisionProjectRepos } from "./project-provision.js";
import { provisionProjectOnNode, createProjectSessionOnNode, nodeProjectSessions } from "./node/provision-remote.js";
import { recordSessionProject } from "./v6/project-store.js";
import { receiveUpload, uploadError } from "./upload-file.js";
import { manifestFiles } from "./project-manifest.js";

const MAX_UPLOAD = 50 * 1024 * 1024; // 50MB (terminal-files 와 동일)
const MAX_PREVIEW = 25 * 1024 * 1024; // 25MB — 이미지·PDF 인라인 미리보기 허용(텍스트는 클라가 별도 크기 가드)
const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
// 신원 id — 터미널/세션로그 라우트와 동일 헬퍼(userId 우선, email 폴백). 노드 세션 소유/가시성 판정이 그 라우트들과
//  같은 값을 써야 노드에서 연 프로젝트 세션이 어느 표면에서든 일관되게 보인다(#905 C4).
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
  // 프로젝트 접근 가능자 전원(id) — 노드 프로젝트 세션의 공동입장 스냅샷(#905 C4)에 쓴다(노드 세션은 owner∪invites 로
  //  가시성 판정 → 게이트웨이가 멤버를 초대목록으로 넘겨야 다른 멤버도 입장).
  listProjectMembers: (id: number) => Promise<string[]>;
  listProjectActivities: (id: number, authorPerson?: string, limit?: number, offset?: number) => Promise<unknown[]>;
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
async function searchFiles(base: string, q: string, limit = 100): Promise<Array<{ name: string; path: string; type: "dir" | "file"; size: number; mtime: number }>> {
  const out: Array<{ name: string; path: string; type: "dir" | "file"; size: number; mtime: number }> = [];
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
        let size = 0, mtime = 0;
        try { const s = await fsp.stat(path.join(dir, e.name)); mtime = Math.floor(s.mtimeMs); if (!isDir) size = s.size; } catch { /* skip */ }
        out.push({ name: e.name, path: childRel, type: isDir ? "dir" : "file", size, mtime });
        if (out.length >= limit) return;
      }
      if (isDir) await walk(path.join(dir, e.name), childRel, depth + 1);
    }
  }
  await walk(base, "", 0);
  return out;
}

// 공유 폴더 매니페스트(재귀 walk, provision 레포/워크트리 제외 + truncated 신호)는 ./project-manifest.js 로 분리(#828).
//  순수 fs 로직이라 DB/WS 없이 단위테스트(project-manifest.test.ts). 라우트는 아래에서 manifestFiles() 를 그대로 쓴다.

// AGENTS.md 생성기·규칙 로더는 ./v6/agents-md.js 로 분리(캐퍼빌리티 계층도 생성 직후 호출). 여기선 import 만.
//  '내 컴퓨터에서 작업'은 웹 모달이 `node ~/.lively/work.mjs <id> …` 한 줄을 직접 렌더한다(web/projects.ts) —
//  work.mjs 가 공유폴더 pull(자체 HTTP API: 매니페스트 + /file, 단방향·dotfile 제외)·레포·.lively 마커·실행까지 자동.
//  (구 단계별 가이드 빌더 buildLocalWorkGuide + /local-work/guide 라우트는 그 한 줄 방식으로 대체되어 제거 — mutagen 은 미사용 placeholder 였음.)

// 한 소스(org 또는 v6)에 대해 파일/세션/타임라인 라우트를 prefix 아래 등록한다.
function mountProjectRoutes(app: express.Express, auth: express.RequestHandler, deps: ProjectDeps): void {
  const { prefix } = deps;
  const isV6 = prefix.includes("/v6/");  // AGENTS.md 생성·규칙 엔드포인트는 v6 전용(getProject 가 v6).

  // 프로젝트 + 폴더 절대경로(검증됨). v6 는 folder 비면 ensureFolder 로 생성.
  //  #452: 프로젝트 리소스(파일·세션·규칙·provision·타임라인)는 어사이니/멤버십 무관 로그인 전원 접근 — 멤버십 게이트 없음.
  const projBase = async (id: number): Promise<{ project: { id: number; name: string; folder: string }; base: string }> => {
    const project = await deps.getProject(id);
    if (!project) throw new HttpError(404, "프로젝트를 찾을 수 없습니다");
    let folder = project.folder;
    // ⚠ 읽기전용(#1007) 예외: folder 미설정이면 여기서 project.folder 를 지연 persist 한다(capabilities 게이트 밖의 유일한
    //  project 테이블 쓰기). 이건 **결정적 폴더 경로 배정**이라 기밀 콘텐츠가 아니고, 이 파일 브라우징 라우트는 웹 UI 표면이라
    //  x-lively-mode 헤더가 실리는 AI MCP 세션에선 사실상 안 탄다 → 게이트하지 않는다(막으면 폴더 없는 프로젝트 브라우징이 깨짐).
    if (!folder && deps.ensureFolder) folder = await deps.ensureFolder({ id: project.id, name: project.name });
    if (!folder) throw new HttpError(400, "프로젝트 폴더가 없습니다");
    return { project: { id: project.id, name: project.name, folder }, base: projectAbsPath(folder) };
  };

  // ── ① 공유 폴더 — 목록 / 검색(q) ──
  app.get(`${prefix}/:id/files`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id));
    res.setHeader("Cache-Control", "no-store");
    const q = String(req.query.q ?? "").trim();
    if (q) { res.json({ search: q, items: await searchFiles(base, q) }); return; }
    const abs = resolveIn(base, req.query.path, false);
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { throw new HttpError(404, "디렉터리 없음"); }
    const items: Array<{ name: string; type: "dir" | "file"; size: number; mtime: number }> = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const isDir = e.isDirectory();
      let size = 0, mtime = 0;
      try { const s = await fsp.stat(path.join(abs, e.name)); mtime = Math.floor(s.mtimeMs); if (!isDir) size = s.size; } catch { /* skip */ }
      items.push({ name: e.name, type: isDir ? "dir" : "file", size, mtime });
    }
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    const rel = path.relative(base, abs);
    res.json({ path: rel, parent: rel ? (path.dirname(rel) === "." ? "" : path.dirname(rel)) : null, items });
  }));

  // 다운로드 / 미리보기
  app.get(`${prefix}/:id/file`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id));
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

  // 업로드(raw 스트림 → 임시파일 → rename). 취소·끊김이면 목적지는 손대지 않는다(#797 — upload-file.ts).
  //  응답에 결과 mtime/size 를 싣는다(#905 C3): up-sync 훅은 올린 뒤 **로컬 mtime 을 이 값으로 맞추고 원장에
  //  기준선으로 적어야** 다음 pull 이 "내가 올린 것"과 "남이 고친 것"을 구별한다. 이게 없으면 자기 push 를 남의
  //  변경으로 오인해 영구 거짓충돌이 나거나(수렴 불가), 크기·시각 추측으로 동일성을 때려맞히다 **남의 최신본을
  //  덮는다**(같은 바이트 크기 · 다른 내용은 흔하다). 기존 클라이언트는 이 필드를 무시하므로 하위호환.
  app.put(`${prefix}/:id/file`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id));
    const abs = resolveIn(base, req.query.path, true);
    try { await receiveUpload(req, abs, MAX_UPLOAD, null); }
    catch (e) { const he = uploadError(e); if (!he) return; throw he; } // he=null → 업로드 취소, 응답할 상대가 없다
    const st = await fsp.stat(abs).catch(() => null);
    res.json({ ok: true, ...(st ? { mtime: Math.floor(st.mtimeMs), size: st.size } : {}) });
  }));

  // 새 폴더 생성
  app.post(`${prefix}/:id/folder`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id));
    const abs = resolveIn(base, req.query.path, true);
    await fsp.mkdir(abs, { recursive: true });
    res.json({ ok: true });
  }));

  // 이름 변경 — 같은 폴더 안에서 이름만(파일·폴더 공통). body: { path, name }.
  app.post(`${prefix}/:id/rename`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id));
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
    const { base } = await projBase(Number(req.params.id));
    const abs = resolveIn(base, req.query.path, true);
    await fsp.rm(abs, { recursive: true, force: true });
    res.json({ ok: true });
  }));

  // ── ①-b 공유 폴더 매니페스트 — 로컬 작업 PC 의 pull 동기화 기준(재귀 [{path,mtime,size}] + newest). 전원 접근(#452). ──
  //  v6: 매니페스트 전 AGENTS.md 를 현재 프로젝트 상태로 재생성(write-if-changed) → pull 마다 최신 digest 가 따라감.
  app.get(`${prefix}/:id/shared/manifest`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id));
    if (isV6) await ensureAgentsMd(Number(req.params.id), base).catch(() => { /* 비치명 */ });
    res.setHeader("Cache-Control", "no-store");
    const { files, truncated } = await manifestFiles(base);
    const newest = files.reduce((m, f) => (f.mtime > m ? f.mtime : m), 0);
    res.json({ files, newest, count: files.length, truncated });
  }));

  // ── ①-c 프로젝트 규칙(AGENTS.md 의 '규칙' 영역) — 로드/저장. digest 는 자동, 규칙만 사람이 편집. v6 전용. ──
  if (isV6) {
    app.get(`${prefix}/:id/rules`, auth, wrap(async (req, res) => {
      const { base } = await projBase(Number(req.params.id));
      res.setHeader("Cache-Control", "no-store");
      res.json(await readProjectAgentsMd(base));
    }));
    app.post(`${prefix}/:id/rules`, auth, wrap(async (req, res) => {
      const { project, base } = await projBase(Number(req.params.id));
      const rules = String(((req.body ?? {}) as Record<string, unknown>).rules ?? "");
      await ensureAgentsMd(project.id, base, rules);
      res.json({ ok: true });
    }));
  }

  // ── ② 터미널 세션(공동) — 목록·생성 모두 어사이니/멤버십 무관 전원(#452). projBase 가 게이트 안 함. ──
  //  (프로젝트 상세 페이지는 #280 이후 전원 공개, 입장 게이트 canAttach 도 프로젝트 세션 전원 개방.)
  app.get(`${prefix}/:id/sessions`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id));
    res.setHeader("Cache-Control", "no-store");
    const all = await listSessions(userOf(req));
    const local = all.filter((s) => s.dir && (s.dir === base || s.dir.startsWith(base + path.sep)));
    // 노드 프로젝트 세션(#905 C4) 병합 — 노드에서 연 이 프로젝트 세션도 목록에 보이게(가시성=invites 스냅샷 판정).
    //  각 항목의 .node 로 프론트가 &node= 입장/삭제를 릴레이한다. 로컬은 dir 로, 노드는 projectId 로 좁힌다.
    const remote = nodeProjectSessions(idOf(userOf(req)), Number(req.params.id));
    res.json({ sessions: [...local, ...remote] });
  }));
  app.post(`${prefix}/:id/sessions`, auth, wrap(async (req, res) => {
    const { project } = await projBase(Number(req.params.id));
    const b = (req.body ?? {}) as Record<string, unknown>;
    // cwd(subpath) 는 기본 프로젝트 폴더 — provision 된 레포 워크트리에서 열려면 그 하위경로를 받되 프로젝트 폴더 안으로 봉쇄
    //  (타 프로젝트 폴더로 열어 이 프로젝트 멤버십을 도용하는 걸 차단). resolveRootPath 가 .. 탈출은 별도 차단.
    let subpath = project.folder;
    const want = String(b.subpath ?? "").trim().replace(/^[/\\]+|[/\\]+$/g, "");
    if (want && (want === project.folder || want.startsWith(project.folder + "/"))) subpath = want;
    else if (want) throw new HttpError(400, "세션 작업 경로가 프로젝트 폴더 밖입니다");
    // rootKey="shared" 는 노드·게이트웨이 모두 PROJECT_SHARED_BASE 로 해소된다 — 그래서 로컬·노드 분기가 같은 입력을 쓴다.
    const input: CreateInput = {
      label: String(b.label ?? ""), rootKey: "shared", subpath,
      harness: String(b.harness ?? "shell"),
      flags: (b.flags && typeof b.flags === "object") ? b.flags as Record<string, unknown> : {},
      autoApprove: !!b.autoApprove,
      readOnly: !!b.readOnly, // #1007 — 이 프로젝트 세션만 읽기전용(컨텍스트 스토어 쓰기 소거).
      incognito: !!b.incognito, // #1007+ — 이 프로젝트 세션만 인코그니토(lively 전체 차단 + 훅 off).
      // 세션에 프로젝트 id 를 박아 입장 게이트가 폴더가 아닌 멤버십(id)으로 판정하게 한다(폴더 드리프트 면역).
      projectId: project.id, projectSrc: prefix.includes("/v6/") ? "v6" : "org",
    };
    res.setHeader("Cache-Control", "no-store");
    // 노드 프로젝트 세션(#905 C4) — body.node 면 그 원격 노드에서 연다(provision 과 같은 게이트). 중앙 프로젝트 세션은
    //  초대 목록 없이 멤버십으로 게이트하지만, 노드는 프로젝트 무지(DB 없음)라 owner∪invites 로만 가시성을 판정한다
    //  → 게이트웨이가 현재 프로젝트 멤버(생성자∪팀원)를 검증해 invites 스냅샷으로 넘겨 다른 멤버의 공동입장을 성립시킨다.
    //  (멤버십 변경은 세션 재생성 전까지 미반영 — 중앙 세션은 동적. 알려진 한계.)
    const nodeId = String(b.node ?? "").trim();
    if (nodeId) {
      const requester = idOf(userOf(req));
      const memberIds = await deps.listProjectMembers(project.id);
      const invites = await validateInvites(memberIds, requester); // 실제 org 멤버만·요청자(owner) 제외·중복 제거
      const session = await createProjectSessionOnNode(nodeId, requester, input, invites);
      // 노드측은 DB 무접속이라 createSession 내부 recordSessionProject 가 no-op → 게이트웨이가 대신 세션↔프로젝트
      //  매핑을 남긴다(멱등). 이게 있어야 활동 타임라인 귀속·경로무관 resume(latestProjectForSession)이 노드 세션도 인지.
      await recordSessionProject(session.id, project.id).catch(() => { /* 비치명 */ });
      res.json({ session: { ...session, node: { id: nodeId, online: true } } });
      return;
    }
    const session = await createSession(userOf(req), input);
    res.json({ session });
  }));

  // ── ②-b 레포 provision — 입력 경로 확보(없으면 레지스트리 clone_url 로 clone) + 옵션 worktree(project/<id>/<repo>).
  //  기본은 게이트웨이(박스)가 직접 실행(work.mjs 의 서버측 대응). body.node 를 주면 **그 원격 노드에서** provision 한다
  //  (#905 C4 — 노드엔 DB 가 없어 게이트웨이가 git_url·자격을 실어 보낸다). 결과 경로는 그 실행 호스트의
  //  .lively/project.json(provisioned)에 기록된다. 전원 접근(#452). ──
  app.post(`${prefix}/:id/provision`, auth, wrap(async (req, res) => {
    const { project } = await projBase(Number(req.params.id));
    const b = (req.body ?? {}) as Record<string, unknown>;
    const specs = Array.isArray(b.repos) ? b.repos as { name: string; path?: string; worktree?: boolean; branch?: string }[] : [];
    if (!specs.length) throw new HttpError(400, "provision 할 레포가 없습니다");
    const nodeId = String(b.node ?? "").trim();
    const requester = idOf(userOf(req));
    const provisioned = nodeId
      ? await provisionProjectOnNode(nodeId, project.id, project.folder, specs, requester)
      : await provisionProjectRepos(project.id, project.folder, specs, { clone: b.clone !== false, memberId: requester || null });
    res.setHeader("Cache-Control", "no-store");
    res.json({ provisioned });
  }));

  // ── ②-c '내 컴퓨터에서 작업'은 웹 모달이 work.mjs 한 줄을 직접 렌더(web/projects.ts) — 서버측 가이드 라우트 불필요(제거). ──

  // ── ③ 작업 타임라인 — 팀원 activity(author_person 지정 시 그 사람만) ──
  app.get(`${prefix}/:id/activity`, auth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    await projBase(id); // 존재·폴더 확인(멤버십 게이트 없음 — #452)
    const authorPerson = req.query.author_person ? String(req.query.author_person) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const offset = req.query.offset ? Number(req.query.offset) : 0;   // #709 페이지네이션 — 과거 타임라인 도달
    res.setHeader("Cache-Control", "no-store");
    res.json({ activities: await deps.listProjectActivities(id, authorPerson, limit, offset) });
  }));
}

// v6(project) 라우트 등록 — 같은 파일/세션/타임라인 로직, 데이터만 v6. ensureFolder 로 폴더 lazy 생성.
export function registerProjectV6Routes(
  app: express.Express,
  verifier: BearerVerifier,
  deps: {
    getProject: ProjectDeps["getProject"];
    isProjectMember: ProjectDeps["isProjectMember"];
    listProjectMembers: ProjectDeps["listProjectMembers"];
    listProjectActivities: ProjectDeps["listProjectActivities"];
    ensureFolder: NonNullable<ProjectDeps["ensureFolder"]>;
  },
): void {
  const auth = sessionOrBearer(verifier); // 세션 쿠키(웹 로그인) OR bearer(에이전트) — 둘 다 수용
  mountProjectRoutes(app, auth, { prefix: "/api/ui/v6/projects", ...deps });
}
