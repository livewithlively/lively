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
import { listAttachedApps, sessionOwnerOf } from "../apps/session-apps.js";
import { RateWindow } from "../apps/app-chat-send.js";
import { PROJECT_FILES_PER_MINUTE, PROJECT_FILE_READ_MAX, listProjectFiles, readProjectFile, type ProjectFilesDeps, type ProjectRef } from "../apps/app-project-files.js";
import { appSqlTenantId } from "../apps/app-sql-exec.js";

const rate = new RateWindow(PROJECT_FILES_PER_MINUTE);

async function storeOf(project: ProjectRef, memberId: string) {
  const { projectStorage } = await import("../project/project-storage.js");
  return projectStorage(project.folder, { memberId }, null);
}

const liveDeps: ProjectFilesDeps = {
  getApp: (id) => getApp(id),
  getGrant: getActiveGrant,
  sessionOwner: sessionOwnerOf,
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
    + "그 앱에 동의한 세션 주인이, 그 앱이 지금 붙어 있고, 그 프로젝트를 볼 수 있을 때만. 세션에 프로젝트가 없으면 빈 목록. 읽기뿐. REST 전용.",
  scope: null,
  input: { app_id: z.string(), session_id: z.string(), ext: z.string().optional().describe("쉼표로 이은 확장자(선언한 것 가운데 고르기 · 생략하면 선언 전부)"), limit: z.number().optional() },
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/apps/:id/files"], parse: (req) => {
      const q = (req.query ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, session_id: q.session_id, ext: typeof q.ext === "string" ? q.ext : undefined, limit: q.limit != null ? Number(q.limit) : undefined };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser | undefined) =>
    listProjectFiles({ appId: appIdOf(input), member: who(user), sessionId: String(input.session_id ?? ""), ext: input.ext, limit: input.limit }, liveDeps, rate),
};

const appProjectFile: Capability = {
  name: "org_app_project_file",
  title: "앱 화면이 붙은 세션의 프로젝트 자료 한 파일 읽기",
  description: "세션에 붙은 앱 화면이 그 세션 프로젝트의 공유 폴더(자료)에서 한 파일의 글 내용을 읽는다(SDK lively.files.read). 선언한 확장자의 파일만 · 8MB 까지. "
    + "판정은 목록과 같다. 반환 { path, content, size, mtime }. 읽기뿐. REST 전용.",
  scope: null,
  input: { app_id: z.string(), session_id: z.string(), path: z.string() },
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/apps/:id/file"], parse: (req) => {
      const q = (req.query ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, session_id: q.session_id, path: q.path };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser | undefined) =>
    readProjectFile({ appId: appIdOf(input), member: who(user), sessionId: String(input.session_id ?? ""), path: input.path }, liveDeps, rate),
};

export const appProjectFilesCapabilities: Capability[] = [appProjectFiles, appProjectFile];
