// 앱 화면 → 붙은 세션의 프로젝트 자료 읽기 capability (#4592) — REST 전용(앱 화면 다리가 부른다 · 하네스 세션은 제 파일 도구가 있다).
//  판정은 apps/app-project-files.ts(순수, deps 주입)에 있고 여기는 입력과 표면, 살아 있는 의존뿐이다.
//  파일은 프로젝트 라우트(/api/ui/v6/projects/:id/shared/manifest · /file)와 **같은 저장소 객체**로 읽는다 — 저장소가 붙은 배포는
//  게이트웨이 디스크, 분리된 배포(매니지드)는 그 사람의 멤버 저장소(project-storage.projectStorage).
import path from "node:path";
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import { getApp, getActiveGrant } from "../org/store/apps.js";
import { viewAppFor } from "../apps/app-view.js";
import { listAttachedApps, sessionCanEnter, sessionOwnerOf } from "../apps/session-apps.js";
import { RateWindow } from "../apps/app-chat-send.js";
import { PROJECT_FILES_PER_MINUTE, PROJECT_FILE_READ_MAX, listProjectFiles, readProjectFile, type ProjectFilesDeps, type ProjectRef } from "../apps/app-project-files.js";
import { appSqlTenantId } from "../apps/app-sql-exec.js";
import { outsideReadScope } from "../v6/read-scope.js";   // #5100 — 파일 권한은 맥락 범위 1판 밖

const rate = new RateWindow(PROJECT_FILES_PER_MINUTE);
const madeCache = new Map<string, { at: number; paths: string[] }>();

async function storeOf(project: ProjectRef, memberId: string) {
  const { projectStorage } = await import("../project/project-storage.js");
  return projectStorage(project.folder, { memberId }, null);
}

const liveDeps: ProjectFilesDeps = {
  getApp: (id) => getApp(id),
  viewFor: async (app, member) => (await viewAppFor(app, { userId: member })).app,   // #4667 보는 사람의 판
  getGrant: getActiveGrant,
  sessionOwner: sessionOwnerOf,
  canEnter: sessionCanEnter,
  listAttached: listAttachedApps,
  projectOfSession: async (sid) => {
    const { latestProjectForSession } = await import("../v6/project-session-store.js");
    return latestProjectForSession(sid);
  },
  canSeeProject: async (projectId, memberId) => {
    const { canSeeProjectRow, effectiveViewer } = await import("../v6/visibility.js");
    const viewer = await effectiveViewer(memberId);
    return viewer === null || canSeeProjectRow(projectId, viewer);
  },
  manifest: async (project, memberId) => (await storeOf(project, memberId)).manifest(),
  readText: async (project, memberId, rel) => {
    const store = await storeOf(project, memberId);
    const abs = path.resolve(store.base, rel);
    if (abs === store.base || !abs.startsWith(store.base + path.sep)) throw new HttpError(400, "허용 경로를 벗어났습니다");
    if (!(await store.confined(abs))) throw new HttpError(400, "허용 경로를 벗어났습니다");   // 심링크로 폴더 밖을 가리키면 거부(프로젝트 라우트와 같은 관문)
    const st = await store.stat(abs);
    if (!st || !st.file) return null;
    if (st.size > PROJECT_FILE_READ_MAX) return { tooBig: st.size };
    const content = await store.readText(abs);
    if (content == null) return null;
    return { content, size: st.size, mtime: st.mtime };
  },
  //  전체 자료(#4629) — 목록은 자료 색인에서(자료 공개범위는 그 조회가 건다), 프로젝트는 id 로 다시 찾는다(지워진 것은 없다).
  //  #5100 — 파일 권한(project_files · workspace_files)은 앱 맥락 범위 1판이 다루지 않는다(그 권한이 경계 · 폴더 범위는 다음 판 — 결정 ②).
  //   색인이 자료 표(local_file)에 있어 범위의 자료 종류에 걸리지 않게 범위 밖에서 읽는다(read-scope.ts outsideReadScope 의 쓰임 ⓑ).
  workspaceIndex: async (memberId, exts, opts) => {
    const { listProjectFileIndex } = await import("../v6/source-store.js");
    return outsideReadScope(() => listProjectFileIndex({ exts, q: opts.q, limit: opts.limit }, memberId));
  },
  //  앱은 열려 있는 동안 목록을 주기적으로 다시 읽는다 — 표시용 조회라 30초 묵혀 쓴다(색인이 파일보다 늦는 폭보다 짧다).
  sessionMade: async (project, sessionId, memberId, exts) => {
    const key = [appSqlTenantId(), memberId, project.id, sessionId, exts.join(",")].join("\0");
    const hit = madeCache.get(key), now = Date.now();
    if (hit && now - hit.at < 30_000) return hit.paths;
    const { listProjectFileIndex } = await import("../v6/source-store.js");
    //  범위 밖에서 읽는다(위 workspaceIndex 와 같은 까닭) — 이 기억은 범위를 키에 넣지 않으니 결과가 범위에 따라 달라지면 안 된다.
    const paths = (await outsideReadScope(() => listProjectFileIndex({ exts, limit: 500, projectId: project.id, session: sessionId }, memberId))).map((r) => r.path);
    if (madeCache.size > 500) madeCache.clear();
    madeCache.set(key, { at: now, paths });
    return paths;
  },
  projectById: async (projectId) => {
    const { itemsPool } = await import("../db/client.js");
    const r = await itemsPool.query(`SELECT id, COALESCE(folder,'') AS folder FROM project WHERE id=$1 AND level='project' AND trashed_at IS NULL`, [projectId]);
    const row = r.rows[0] as { id: number; folder: string } | undefined;
    return row ? { id: Number(row.id), folder: String(row.folder) } : null;
  },
  tenant: appSqlTenantId,
};

function who(user: LivelyUser | undefined): string {
  const member = user?.userId || "";
  if (!member) throw new HttpError(401, "인증이 필요합니다");
  return member;
}
function appIdOf(input: Record<string, unknown>): string {
  const appId = String(input.app_id ?? "").trim();
  if (!appId) throw new HttpError(400, "app_id 가 필요합니다");
  return appId;
}

const appProjectFiles: Capability = {
  name: "org_app_project_files",
  title: "앱 화면이 붙은 세션의 프로젝트 자료 목록",
  description: "세션에 붙은 앱 화면이 그 세션 프로젝트의 공유 폴더(자료)에서 파일 목록을 본다(SDK lively.files.list). 앱이 permissions.project_files 로 선언한 확장자만, 최신순. "
    + "그 앱에 동의했고 그 세션에 들어갈 수 있는 사람이, 그 앱이 지금 붙어 있고, 그 프로젝트를 볼 수 있을 때만. 세션에 프로젝트가 없으면 빈 목록. 읽기뿐. REST 전용.",
  scope: null,
  input: { app_id: z.string(), session_id: z.string(), ext: z.string().optional().describe("쉼표로 이은 확장자(선언한 것 가운데 고르기 · 생략하면 선언 전부)"), limit: z.number().optional(),
    scope: z.string().optional().describe("'all' = 볼 수 있는 모든 프로젝트의 자료(permissions.workspace_files 선언 · 동의가 따로 필요 · 줄마다 project_id). 생략 = 붙은 세션의 프로젝트"),
    q: z.string().optional().describe("scope 'all' 에서 파일 이름 · 경로로 찾는 말") },
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/apps/:id/files"], parse: (req) => {
      const q = (req.query ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, session_id: q.session_id, ext: typeof q.ext === "string" ? q.ext : undefined, limit: q.limit != null ? Number(q.limit) : undefined,
        scope: typeof q.scope === "string" ? q.scope : undefined, q: typeof q.q === "string" ? q.q : undefined };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser | undefined) =>
    listProjectFiles({ appId: appIdOf(input), member: who(user), scopes: user?.scopes, sessionId: String(input.session_id ?? ""), ext: input.ext, limit: input.limit, scope: input.scope, q: input.q }, liveDeps, rate),
};

const appProjectFile: Capability = {
  name: "org_app_project_file",
  title: "앱 화면이 붙은 세션의 프로젝트 자료 한 파일 읽기",
  description: "세션에 붙은 앱 화면이 그 세션 프로젝트의 공유 폴더(자료)에서 한 파일의 글 내용을 읽는다(SDK lively.files.read). 선언한 확장자의 파일만 · 8MB 까지. "
    + "판정은 목록과 같다. 반환 { path, content, size, mtime }. 읽기뿐. REST 전용.",
  scope: null,
  input: { app_id: z.string(), session_id: z.string(), path: z.string(),
    project_id: z.number().optional().describe("전체 자료 목록(scope 'all')의 줄이 준 project_id — 주면 그 프로젝트의 자료에서 읽는다(workspace_files 선언 · 동의 필요)") },
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/apps/:id/file"], parse: (req) => {
      const q = (req.query ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, session_id: q.session_id, path: q.path, project_id: q.project_id != null && q.project_id !== "" ? Number(q.project_id) : undefined };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser | undefined) =>
    readProjectFile({ appId: appIdOf(input), member: who(user), scopes: user?.scopes, sessionId: String(input.session_id ?? ""), path: input.path, projectId: input.project_id }, liveDeps, rate),
};

export const appProjectFilesCapabilities: Capability[] = [appProjectFiles, appProjectFile];
