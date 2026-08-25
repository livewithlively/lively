// 프로젝트 상세 페이지 백엔드 — 공유 폴더(파일 API) + 터미널 세션 + 작업 타임라인.
//  터미널 인프라 재사용: 폴더는 project-fs(projectAbsPath), 세션은 terminal-sessions(listSessions/createSession),
//  타임라인은 v6/project-activity-store(listProjectActivities). terminal-files.ts 와 동형(경로 realpath 봉쇄, .. 탈출 차단).
//  게이트: 인증된 멤버(auth) — 단일 조직 신뢰모델(터미널 browse/세션과 동일 수준). express.json 이후 마운트(업로드 raw 보존).
//  prefix+deps 로 일반화 — org(/api/ui/projects, org_project) + v6(/api/ui/v6/projects, project) 양쪽 등록.
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { sessionOrBearer } from "../auth/http-auth.js";
import type { BearerVerifier } from "../auth/bearer.js";
import type { LivelyUser } from "../context.js";
import { wrap, HttpError } from "../http/rest-util.js";
import { projectAbsPath, grantSharedGroupWrite } from "./project-fs.js";
import { canSeeProjectRow, effectiveViewer } from "../v6/visibility.js";
import { viewerOf } from "../capabilities/principal.js";
import { listSessions, listRestorableSessions, createSession, validateInvites, type CreateInput, normalizeCap } from "../terminal/terminal-sessions.js";
import { mergeSessionViews } from "../sessions/session-merge.js"; // #1716 — 출처가 겹쳐도 세션 카드는 1장
import { ensureAgentsMd, readProjectAgentsMd } from "../v6/agents-md.js";
import { provisionProjectRepos } from "./project-provision.js";
import { startProjectProvision, projectProvisionStatus } from "./project-provision-jobs.js";
import { provisionProjectOnNode, provisionStatusOnNode, createProjectSessionOnNode, nodeProjectSessions } from "../node/provision-remote.js";
import { mirrorNodeSession, decorateNodeRows } from "../terminal/node-session-state.js";   // #1791 — 노드 세션 desired-state(정본 = DB)
import { recordSessionProject } from "../v6/project-store.js";
import { receiveUpload, uploadError, nfcPath } from "../terminal/upload-file.js";
import { manifestFiles } from "./project-manifest.js";
import { ingestLocalUpload, supersedeLocalPath } from "../ingest/local-file.js";   // #1881 올린 파일 = 자료 1건

const MAX_UPLOAD = 1024 * 1024 * 1024; // 1GB (#1870 — terminal-files 와 동일해야 한다. receiveUpload 스트리밍이라 RAM 무관)
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
  //  #452: 프로젝트 리소스(파일·세션·규칙·provision·타임라인)는 어사이니/멤버십 무관 **로그인 전원** 접근.
  //  #1291: 그 전원 개방은 '공개된 리스트'에 한한다. 공개범위가 걸린 리스트의 프로젝트라면 그 대상만 — 그리고
  //   여기 한 곳이 파일 목록·다운로드·업로드·rename·삭제·매니페스트·rules·세션 생성·provision·타임라인을 전부 덮는다.
  //   메타(project_get_v6)만 막고 파일·세션을 열어두면 세션에 들어가 폴더를 그대로 읽을 수 있어 잠금이 무의미해진다.
  //   거부는 404 — 존재를 숨긴다.
  const projBase = async (id: number, req?: express.Request): Promise<{ project: { id: number; name: string; folder: string }; base: string }> => {
    const project = await deps.getProject(id);
    if (!project) throw new HttpError(404, "프로젝트를 찾을 수 없습니다");
    if (req) {
      // ⚠ v2: **admin 도 우회하지 않는다.** 이 라우트는 capability 어댑터를 안 지나 자체 판정하므로,
      //  어댑터의 viewerOf 와 같은 규칙을 여기서도 지켜야 한다(v1 의 admin→null 정규화가 여기 남아
      //  잠긴 프로젝트의 **파일 목록이 admin 에게 그대로 열려 있었다** — e2e 가 잡았다).
      //  우회는 긴급 열람으로만 — effectiveViewer 가 그걸 반영한다.
      //  ⚠ 신원 규칙도 어댑터 것을 그대로 쓴다 — `u?.userId ?? null` 은 빈 문자열을 살려 보내 viewerOf 와 갈린다.
      const viewer = await effectiveViewer(viewerOf(userOf(req)));
      if (viewer !== null && !(await canSeeProjectRow(id, viewer))) throw new HttpError(404, "프로젝트를 찾을 수 없습니다");
    }
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
    const { base } = await projBase(Number(req.params.id), req);
    res.setHeader("Cache-Control", "no-store");
    const q = String(req.query.q ?? "").trim();
    if (q) { res.json({ search: q, items: await searchFiles(base, q) }); return; }
    const abs = resolveIn(base, req.query.path, false);
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { throw new HttpError(404, "디렉터리 없음"); }
    const items: Array<{ name: string; type: "dir" | "file"; size: number; mtime: number; repo?: boolean }> = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const isDir = e.isDirectory();
      let size = 0, mtime = 0;
      try { const s = await fsp.stat(path.join(abs, e.name)); mtime = Math.floor(s.mtimeMs); if (!isDir) size = s.size; } catch { /* skip */ }
      // repo — provision 된 레포/워크트리(.git 보유)임을 표시한다. 매니페스트가 이미 서브트리째 빼는 것과 같은
      //  대상이다(project-manifest.ts): 코드는 git 이 소유하므로 '자료'가 아니다. 지우지는 않고 **표시만** 한다 —
      //  파일 탐색기(v2/files.ts)는 코드를 보러 들어가는 화면이라 그대로 보여야 하고, 자료 칸만 이 표시로 가린다.
      let repo = false;
      if (isDir) { try { await fsp.stat(path.join(abs, e.name, ".git")); repo = true; } catch { /* 레포 아님 */ } }
      items.push({ name: e.name, type: isDir ? "dir" : "file", size, mtime, ...(repo ? { repo: true } : {}) });
    }
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    const rel = path.relative(base, abs);
    res.json({ path: rel, parent: rel ? (path.dirname(rel) === "." ? "" : path.dirname(rel)) : null, items });
  }));

  // 다운로드 / 미리보기
  app.get(`${prefix}/:id/file`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id), req);
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
    const { project, base } = await projBase(Number(req.params.id), req);
    const abs = resolveIn(base, nfcPath(req.query.path), true);   // 저장 이름은 NFC 정본(#1278b)
    try { await receiveUpload(req, abs, MAX_UPLOAD, null); }
    catch (e) { const he = uploadError(e, MAX_UPLOAD); if (!he) return; throw he; } // he=null → 업로드 취소, 응답할 상대가 없다
    // 게이트웨이(lively)가 쓴 파일(644)·폴더 업로드가 만든 중간 폴더(755)에 그룹 rw — 격리 박스의 box_ 세션이
    //  lively-shared 그룹으로 이 폴더를 쓰므로, 이게 없으면 세션 클로드가 업로드 파일을 못 고친다(#1246).
    await grantSharedGroupWrite(abs, base, "file");
    // 올린 파일 = 자료 1건(#1881 L1) — 다른 수집기와 같은 길(자료 → 증류기 → 지식·근거 칩). 실패해도 업로드는 성공이다.
    const u = userOf(req);
    const ing = await ingestLocalUpload({ root: { kind: "project", id: project.id }, folder: project.folder, base, abs, osUser: null,
      uploader: { id: viewerOf(u), name: u?.email ?? null }, channelFallback: project.name })
      .catch((e) => { console.warn(`[local-ingest] 자료 등록 실패 ${abs}: ${(e as Error)?.message ?? e}`); return null; });
    const st = await fsp.stat(abs).catch(() => null);
    // path(절대경로) — 올린 것을 **그 자리에서 AI 에게 넘기는** 화면이 쓴다(새 세션 창의 붙여넣기 첨부, #1819).
    //  세션 cwd 는 프로젝트 폴더가 아니라 세션 전용 폴더라 상대경로로는 못 찾는다. 터미널 업로드 라우트가 이미
    //  같은 계약을 갖고 있다(web/standalone/terminal.ts dropFileToAgent 가 j.path 를 그대로 입력창에 꽂는다).
    // source_id — 이 파일이 자료로 등록됐으면 그 id(#1881). 화면이 "자료함에 담김"을 폴링 없이 알린다. 구 클라이언트는 무시.
    res.json({ ok: true, path: abs, ...(st ? { mtime: Math.floor(st.mtimeMs), size: st.size } : {}), ...(ing?.ingested ? { source_id: ing.source_id } : {}) });
  }));

  // 새 폴더 생성
  app.post(`${prefix}/:id/folder`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id), req);
    const abs = resolveIn(base, nfcPath(req.query.path), true);   // 폴더 이름도 NFC 정본(#1278b)
    await fsp.mkdir(abs, { recursive: true });
    // 게이트웨이 소유(lively)·umask(755)로 생긴 폴더는 box_ 격리 세션(lively-shared 그룹)이 못 쓴다 —
    //  프로젝트 폴더 자체(2770)와 같은 계약을 하위에도(#1246 신고 증상: 웹에서 만든 폴더에 클로드 쓰기 불가).
    await grantSharedGroupWrite(abs, base, "dir");
    res.json({ ok: true });
  }));

  // 이름 변경 — 같은 폴더 안에서 이름만(파일·폴더 공통). body: { path, name }.
  app.post(`${prefix}/:id/rename`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id), req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const fromAbs = resolveIn(base, b.path, true);
    const newName = nfcPath(b.name).trim();   // 새 이름도 NFC 정본(#1278b)
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

  // 이동 — 다른 폴더로 옮긴다(자료 앱의 '폴더로 정리', #1819). body: { paths: string[], to: string }.
  //  to = 목적지 **폴더**의 상대경로(""=루트). 이름은 그대로 두고 자리만 옮긴다 — 이름 변경은 /rename 이 맡는다.
  //  왜 여러 개를 한 번에 받나: 사각형 선택으로 고른 여러 자료를 한 번에 끌어다 놓는 게 이 기능의 본래 쓰임이라,
  //  건별 왕복이면 중간에 실패했을 때 사용자가 '어디까지 갔는지' 알 길이 없다. 건별 결과를 모아 돌려준다.
  app.post(`${prefix}/:id/move`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id), req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const list = Array.isArray(b.paths) ? b.paths : (b.path != null ? [b.path] : []);
    if (!list.length) throw new HttpError(400, "옮길 대상이 필요합니다");
    const destDir = resolveIn(base, nfcPath(b.to ?? ""), false);
    const dstat = await fsp.stat(destDir).catch(() => null);
    if (!dstat || !dstat.isDirectory()) throw new HttpError(400, "목적지가 폴더가 아닙니다");
    const moved: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    for (const raw of list) {
      const fromAbs = resolveIn(base, raw, true);
      const name = path.basename(fromAbs);
      const toAbs = path.join(destDir, name);
      try {
        if (toAbs === fromAbs) { moved.push(path.relative(base, toAbs)); continue; }   // 제자리 — 성공으로 친다
        // 폴더를 자기 안으로 넣으면 트리가 사라진다(rename 이 EINVAL 을 주기도, 조용히 먹기도 한다) — 먼저 막는다.
        if (toAbs.startsWith(fromAbs + path.sep)) throw new HttpError(400, "폴더를 자기 안으로 옮길 수 없습니다");
        try { await fsp.access(toAbs); throw new HttpError(409, "같은 이름이 이미 있습니다"); }
        catch (e) { if (e instanceof HttpError) throw e; }
        await fsp.rename(fromAbs, toAbs);
        await grantSharedGroupWrite(toAbs, base, dstat.isDirectory() && (await fsp.stat(toAbs)).isDirectory() ? "dir" : "file");
        moved.push(path.relative(base, toAbs));
      } catch (e) {
        failed.push({ path: String(raw), error: e instanceof HttpError ? e.message : String((e as Error)?.message || e) });
      }
    }
    res.json({ ok: failed.length === 0, moved, failed });
  }));

  // 삭제 — 파일/폴더(폴더는 내용까지 재귀). 루트 자신은 거부(requireFile). path 필수.
  app.delete(`${prefix}/:id/file`, auth, wrap(async (req, res) => {
    const { project, base } = await projBase(Number(req.params.id), req);
    const abs = resolveIn(base, req.query.path, true);
    await fsp.rm(abs, { recursive: true, force: true });
    // 자료 전파(#1881) — 그 경로(폴더면 하위 전부)의 자료를 superseded 로. 파생 지식은 그대로(지식은 사람 결정).
    await supersedeLocalPath({ kind: "project", id: project.id }, path.relative(base, abs))
      .catch((e) => console.warn(`[local-ingest] 삭제 전파 실패 ${abs}: ${(e as Error)?.message ?? e}`));
    res.json({ ok: true });
  }));

  // ── ①-b 공유 폴더 매니페스트 — 로컬 작업 PC 의 pull 동기화 기준(재귀 [{path,mtime,size}] + newest). 전원 접근(#452). ──
  //  v6: 매니페스트 전 AGENTS.md 를 현재 프로젝트 상태로 재생성(write-if-changed) → pull 마다 최신 digest 가 따라감.
  app.get(`${prefix}/:id/shared/manifest`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id), req);
    if (isV6) await ensureAgentsMd(Number(req.params.id), base).catch(() => { /* 비치명 */ });
    res.setHeader("Cache-Control", "no-store");
    const { files, truncated } = await manifestFiles(base);
    const newest = files.reduce((m, f) => (f.mtime > m ? f.mtime : m), 0);
    res.json({ files, newest, count: files.length, truncated });
  }));

  // ── ①-c 프로젝트 규칙(AGENTS.md 의 '규칙' 영역) — 로드/저장. digest 는 자동, 규칙만 사람이 편집. v6 전용. ──
  if (isV6) {
    app.get(`${prefix}/:id/rules`, auth, wrap(async (req, res) => {
      const { base } = await projBase(Number(req.params.id), req);
      res.setHeader("Cache-Control", "no-store");
      res.json(await readProjectAgentsMd(base));
    }));
    app.post(`${prefix}/:id/rules`, auth, wrap(async (req, res) => {
      const { project, base } = await projBase(Number(req.params.id), req);
      const rules = String(((req.body ?? {}) as Record<string, unknown>).rules ?? "");
      await ensureAgentsMd(project.id, base, rules);
      res.json({ ok: true });
    }));

    // ── ①-d AGENTS.md 전문(#1856 B) — **실행 중** 세션에 프로젝트 규칙을 주입하는 훅이 읽는다. ──
    //  왜 /file?path=AGENTS.md 로 안 쓰나: 그 라우트는 ensureAgentsMd 를 부르지 않아 **stale digest**
    //   (태스크 인덱스·필요지식이 낡은 판)가 갈 수 있다. 여기선 먼저 최신화한 뒤 읽는다.
    //  왜 매니페스트로 안 쓰나: 매니페스트는 폴더 전체를 순회한다 — 훅은 파일 하나만 필요하다.
    //  규칙(rules)만 주는 /rules 와도 다르다 — 주입에는 digest(레포·태스크·필요지식)까지 있어야 쓸모가 있다.
    app.get(`${prefix}/:id/agents`, auth, wrap(async (req, res) => {
      const { project, base } = await projBase(Number(req.params.id), req);
      await ensureAgentsMd(project.id, base).catch(() => { /* 비치명 — 기존 파일이라도 준다 */ });
      res.setHeader("Cache-Control", "no-store");
      let content = "";
      try { content = await fsp.readFile(path.join(base, "AGENTS.md"), "utf8"); } catch { /* 아직 없음 → 빈 문자열 */ }
      res.json({ project_id: project.id, name: project.name, content, bytes: Buffer.byteLength(content) });
    }));
  }

  // ── ② 터미널 세션(공동) — 목록·생성 모두 어사이니/멤버십 무관 전원(#452). projBase 가 게이트 안 함. ──
  //  (프로젝트 상세 페이지는 #280 이후 전원 공개, 입장 게이트 canAttach 도 프로젝트 세션 전원 개방.)
  app.get(`${prefix}/:id/sessions`, auth, wrap(async (req, res) => {
    const { base } = await projBase(Number(req.params.id), req);
    res.setHeader("Cache-Control", "no-store");
    const all = await listSessions(userOf(req));
    const underBase = (s: { dir?: string }): boolean => !!s.dir && (s.dir === base || s.dir.startsWith(base + path.sep));
    const local = all.filter(underBase);
    // 복원 가능(#1059 E) — 재부팅·회수로 죽었으나 desired-state 가 남은 이 프로젝트 폴더의 세션(라이브 우선, 이중표기 방지).
    // 노드 프로젝트 세션(#905 C4) 병합 — 노드에서 연 이 프로젝트 세션도 목록에 보이게(가시성=invites 스냅샷 판정).
    //  각 항목의 .node 로 프론트가 &node= 입장/삭제를 릴레이한다. 로컬은 dir 로, 노드는 projectId 로 좁힌다.
    const remote = nodeProjectSessions(idOf(userOf(req)), Number(req.params.id));
    // #1791 — 복원 가능 행에 노드 세션(node_id)도 온다: 노드 경로는 이 박스의 base 아래가 아니므로 projectId 로 좁힌다.
    //  노드 스냅샷에 살아 있는 id 는 라이브가 SoT(local ∪ remote 제외).
    const pid = Number(req.params.id);
    const restorable = (await listRestorableSessions(userOf(req), new Set([...all, ...remote].map((s) => s.id))))
      .filter((s) => (s.node ? s.projectId === pid : underBase(s)));
    await decorateNodeRows(restorable);
    // AI 세션 탭과 같은 규칙으로 이중표기를 접는다(#1716) — 게이트웨이와 노드가 같은 박스면 같은 tmux 세션이
    //  local·remote 양쪽에 잡힌다. 인자 순서 = 우선순위(로컬 라이브 > 노드 스냅샷 > 복원 가능).
    res.json({ sessions: mergeSessionViews(local, remote, restorable) });
  }));
  app.post(`${prefix}/:id/sessions`, auth, wrap(async (req, res) => {
    const { project } = await projBase(Number(req.params.id), req);
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
      // #1291 v2 — 기록 범위·read 축소. 미지정이면 프로젝트 폴더에서 파생한다(= 프로젝트 공개범위).
      writeVis: normalizeCap(b.writeVis as string) ?? undefined,
      restrictRead: !!b.restrictRead,
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
      // #1791 — desired-state 정본(node_id) — 죽어도 '복원 가능(그 노드)'로 남는 근거. 노드엔 DB 가 없어 게이트웨이가 쓴다.
      await mirrorNodeSession({ ...session, invites }, nodeId, input, requester);
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
    const { project } = await projBase(Number(req.params.id), req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const specs = Array.isArray(b.repos) ? b.repos as { name: string; path?: string; worktree?: boolean; branch?: string }[] : [];
    if (!specs.length) throw new HttpError(400, "provision 할 레포가 없습니다");
    const nodeId = String(b.node ?? "").trim();
    const requester = idOf(userOf(req));
    // 비동기 모드(#1180) — `async:true` 면 **시작만 하고 즉답**한다(clone 은 분 단위라 브라우저를 붙들 이유가 없다).
    //  세션 cwd 는 레포가 아니라 프로젝트 폴더라(#918) 워크트리가 뒤늦게 생겨도 안전하고, 그 사이 세션엔
    //  마커(repos_pending)→프리로드가 "받는 중"을 알린다. 완료 확인은 아래 /provision/status 폴링.
    if (b.async === true) {
      // 시작 자체의 실패(노드 오프라인·권한·폴더 없음)는 여기서 4xx/5xx 로 그대로 나간다 — 그건 '준비 중'이 아니라
      //  아예 시작을 못 한 것이라 화면이 즉시 알아야 한다. 시작 이후의 레포별 실패만 비동기로 흘러간다.
      if (nodeId) await provisionProjectOnNode(nodeId, project.id, project.folder, specs, requester, { waitForCompletion: false });
      else await startProjectProvision(project.id, project.folder, specs, { clone: b.clone !== false, memberId: requester || null });
      res.setHeader("Cache-Control", "no-store");
      res.status(202).json({ async: true, started: true });
      return;
    }
    // #1155 — 준비 실패는 4xx/5xx 로 요청을 죽이지 않는다(이 경로 뒤에 사람이 세션을 연다). 실패한 레포만 건너뛰고
    //  나머지를 준비한 뒤 failed 를 함께 돌려준다. 화면은 그걸 경고로 보여주고, 세션엔 마커→프리로드로 주입된다.
    //  (레포명·브랜치 형식 오류 같은 입력 검증은 그대로 4xx — 세션 안에서 고칠 수 있는 종류가 아니다.)
    const { provisioned, failed } = nodeId
      ? await provisionProjectOnNode(nodeId, project.id, project.folder, specs, requester)
      : await provisionProjectRepos(project.id, project.folder, specs, { clone: b.clone !== false, memberId: requester || null, failOpen: true });
    res.setHeader("Cache-Control", "no-store");
    res.json({ provisioned, failed });
  }));

  // ── ②-b-2 provision 진행 상태(#1180) — 비동기 시작 뒤 화면이 폴링한다. 노드면 그 노드의 상태를 릴레이.
  //  known:false = 실행 주체가 재시작돼 작업 기억을 잃음 → 화면이 '다시 준비' 를 권한다(여기서 몰래 재시작하지 않는다).
  app.get(`${prefix}/:id/provision/status`, auth, wrap(async (req, res) => {
    const { project } = await projBase(Number(req.params.id), req);
    const nodeId = String(req.query.node ?? "").trim();
    const st = nodeId ? await provisionStatusOnNode(nodeId, project.id) : projectProvisionStatus(project.id);
    res.setHeader("Cache-Control", "no-store");
    res.json(st);
  }));

  // ── ②-c '내 컴퓨터에서 작업'은 웹 모달이 work.mjs 한 줄을 직접 렌더(web/projects.ts) — 서버측 가이드 라우트 불필요(제거). ──

  // ── ③ 작업 타임라인 — 팀원 activity(author_person 지정 시 그 사람만) ──
  app.get(`${prefix}/:id/activity`, auth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    await projBase(id, req); // 존재·폴더 확인(멤버십 게이트 없음 — #452)
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
