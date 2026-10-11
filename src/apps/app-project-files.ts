// 앱 화면이 **붙은 세션의 프로젝트 자료**에서 파일을 읽는다 (#4592) — 목록(최신순)과 내용, 읽기만.
//
//  왜 필요한가(원준 2026-10-07): 「장표 수정」을 다른 세션에서 처음 켜면 빈 화면이 «out/덱.html 을 장표 수정 앱에 올려 줘 라고 말하세요» 였다.
//   «그걸 할 수 있는 사람이 있을 거라고 보냐? 그냥 불러올 파일 목록을 최신순으로 보여줘서 클릭하게». 앱 화면은 샌드박스라 파일을 볼 길이
//   없었다 — 이 통로가 그 길이다. 앱은 목록에서 고른 파일의 내용을 받아 제 테이블에 올린다(쓰기는 여전히 store_* 뿐).
//  무엇에 닿나: 그 앱이 **지금 붙어 있는 세션**이 속한 프로젝트의 공유 폴더(사이드바 「자료」)뿐. 세션이 프로젝트에 안 붙어 있으면 빈 목록.
//   숨김 파일과 git 레포 서브트리는 저장소의 매니페스트 규칙이 이미 뺀다(project-manifest). 확장자는 앱이 **선언한 것만**.
//  경계 — chat.send(app-chat-send.ts)와 같은 다섯 겹을 매 호출 다시 본다:
//   ① 앱이 쓸 수 있는 상태 ② 앱이 permissions.project_files 를 선언(→ app_project_files 도구) ③ 그 사람의 동의 범위에 그 도구
//   ④ 그 세션의 주인 ⑤ 그 앱이 지금 그 세션에 붙어 있음. 여기에 ⑥ 그 사람이 그 프로젝트를 볼 수 있음(프로젝트 라우트와 같은 판정)을 더한다.
//  전체 자료(#4629, 원준 2026-10-11 «우리 자료 전체, 그리고 프로젝트 안의 자료 — 둘 중 하나가 거의 대부분»): scope 'all' 은 붙은 세션의
//   프로젝트 밖, **그 사람이 볼 수 있는 모든 프로젝트의 자료**를 본다. 더 넓은 능력이라 선언(permissions.workspace_files)도 동의
//   (app_workspace_files)도 따로다 — 프로젝트 자료에만 동의한 사람의 앱이 조용히 넓어지지 않는다. 목록은 자료 색인(파일마다 한 줄)에서
//   오고(프로젝트마다 폴더를 훑지 않는다), 내용은 종전과 같은 저장소 관문으로 읽는다. 세션에 붙은 화면에서만이라는 조건은 그대로다.
//  판정은 순수하게 두고(deps 주입) 살아 있는 의존은 capabilities/app-project-files.ts 가 꽂는다.
import { HttpError } from "../http-error.js";
import type { OrgApp, AppGrantRow } from "../org/store/apps.js";
import { requireSessionParticipant, requireUsableApp, type SessionAppRow } from "./session-apps.js";
import { decideAppTool } from "./principal.js";
import { needsRegrant } from "./grant.js";
import { PROJECT_FILES_TOOL, WORKSPACE_FILES_TOOL } from "./manifest.js";
import type { RateWindow } from "./app-chat-send.js";

export const PROJECT_FILES_LIST_MAX = 500;
export const PROJECT_FILES_LIST_DEFAULT = 200;
/** 내용 읽기 상한 — 저장소의 작은 문서 상한(project-storage TEXT_MAX)과 같다. 넘으면 413. */
export const PROJECT_FILE_READ_MAX = 8 * 1024 * 1024;
export const PROJECT_FILES_PER_MINUTE = 120;

export interface ProjectRef { id: number; folder: string }
export interface ProjectFileEntry { path: string; mtime: number; size: number }
/** 전체 자료의 한 줄 — 어느 프로젝트의 어느 경로인가. */
export interface WorkspaceFileEntry extends ProjectFileEntry { project_id: number; project_name: string; session?: string }
export interface ProjectFilesDeps {
  getApp: (appId: string) => Promise<OrgApp | null>;
  getGrant: (appId: string, memberId: string) => Promise<AppGrantRow | null>;
  sessionOwner: (sessionId: string) => Promise<string | null>;
  canEnter?: (sessionId: string, member: string) => Promise<boolean>;
  listAttached: (sessionId: string) => Promise<SessionAppRow[]>;
  /** 그 세션이 지금 속한 프로젝트(없으면 null — 프로젝트 없는 세션). */
  projectOfSession: (sessionId: string) => Promise<ProjectRef | null>;
  /** 그 사람이 그 프로젝트를 볼 수 있나(공개 범위). */
  canSeeProject: (projectId: number, memberId: string) => Promise<boolean>;
  /** 프로젝트 공유 폴더의 재귀 목록(파일만 · 숨김 제외). */
  manifest: (project: ProjectRef, memberId: string) => Promise<{ files: ProjectFileEntry[]; truncated: boolean }>;
  /** 한 파일의 글 내용. 없으면 null, 상한을 넘으면 { tooBig: 크기 }. 경로는 이미 다듬은 상대경로. */
  readText: (project: ProjectRef, memberId: string, relPath: string) => Promise<{ content: string; size: number; mtime: number } | { tooBig: number } | null>;
  /** (전체 자료) 그 사람에게 보이는 프로젝트 자료 파일의 색인 — 그 확장자만, 최신순, limit+1 까지(넘침 판정용). q 는 이름 · 경로에서 찾는 말. */
  workspaceIndex?: (memberId: string, exts: string[], opts: { q: string; limit: number }) => Promise<WorkspaceFileEntry[]>;
  /** 그 프로젝트의 파일 가운데 **그 세션이 만든 것**의 경로(자료 색인의 entry_session). 없으면 표시 없이 간다. */
  sessionMade?: (project: ProjectRef, sessionId: string, memberId: string, exts: string[]) => Promise<string[]>;
  /** (전체 자료) 프로젝트 id → 폴더. 없거나 지워졌으면 null. */
  projectById?: (projectId: number) => Promise<ProjectRef | null>;
  now?: () => number;
  tenant?: () => string;
}

export interface ProjectFilesGateInput { appId: string; sessionId: string; member: string }

function extsOf(app: OrgApp, key: "project_files" | "workspace_files"): string[] {
  const p = (app.manifest as { permissions?: Record<string, unknown> } | null)?.permissions?.[key];
  return (Array.isArray(p) ? p : []).map((x) => String(x).toLowerCase().replace(/^\./, "")).filter((x) => /^[a-z0-9]{1,8}$/.test(x));
}
/** 매니페스트가 선언한 확장자(소문자 · 점 없이). */
export function declaredExts(app: OrgApp): string[] { return extsOf(app, "project_files"); }
/** 매니페스트가 **전체 자료**에서 읽겠다고 선언한 확장자(소문자 · 점 없이). */
export function declaredWorkspaceExts(app: OrgApp): string[] { return extsOf(app, "workspace_files"); }
function declaredTools(app: OrgApp): string[] {
  const p = (app.manifest as { permissions?: { tools?: unknown; ext_tools?: unknown } } | null)?.permissions;
  return [...(Array.isArray(p?.tools) ? p.tools : []), ...(Array.isArray(p?.ext_tools) ? p.ext_tools : [])].map(String);
}
/** 경로의 확장자(소문자 · 점 없이). 없으면 빈 문자열. */
export function extOf(p: string): string {
  const base = String(p).split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}
/**
 * 앱이 준 상대경로를 다듬는다 — 앞의 `/` 를 떼고, 빈 마디 · `.` · `..` · 역슬래시 · NUL 이 있으면 400. 숨김 마디(점으로 시작)도 400
 *  (목록에 안 나오는 것을 경로를 지어내 읽지 못하게). 순수.
 */
export function normalizeRelPath(raw: unknown): string {
  const s = String(raw ?? "").replace(/^\/+/, "");
  if (!s || s.length > 1024 || /[\\\0]/.test(s)) throw new HttpError(400, "파일 경로가 올바르지 않습니다");
  const parts = s.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || p.startsWith("."))) throw new HttpError(400, "파일 경로가 올바르지 않습니다");
  return parts.join("/");
}

/** 공통 관문 — 앱(404/409) → 선언(403) → 동의(403) → 도구 동의(403 재동의) → 주인(404/403) → 붙음(403) → 빈도(429) → 프로젝트 · 가시성. */
async function gate(q: ProjectFilesGateInput, deps: ProjectFilesDeps, rate: RateWindow, wide = false): Promise<{ app: OrgApp; exts: string[]; project: ProjectRef | null }> {
  const sessionId = String(q.sessionId ?? "").trim();
  if (!sessionId) throw new HttpError(400, "session_id 가 필요합니다 — 세션에 붙은 앱 화면에서만 파일을 볼 수 있습니다");
  const app = requireUsableApp(await deps.getApp(q.appId), q.appId);
  const declared = declaredTools(app);
  //  전체 자료(wide)는 제 선언 · 제 도구로 본다 — 프로젝트 자료의 선언 · 동의로는 열리지 않는다.
  const tool = wide ? WORKSPACE_FILES_TOOL : PROJECT_FILES_TOOL;
  const label = wide ? "전체 자료" : "프로젝트 자료";
  const exts = wide ? declaredWorkspaceExts(app) : declaredExts(app);
  if (!exts.length || !decideAppTool(q.appId, declared, tool)) {
    throw new HttpError(403, `앱 '${q.appId}' 은(는) ${label} 읽기(permissions.${wide ? "workspace_files" : "project_files"})를 선언하지 않았습니다 — 매니페스트에 확장자를 선언하고 다시 저장하세요`);
  }
  const grant = await deps.getGrant(q.appId, q.member);
  if (!grant) throw new HttpError(403, `앱 '${q.appId}' 사용 동의(grant)가 없습니다`);
  if (needsRegrant(grant.tools, declared, tool) || !decideAppTool(q.appId, grant.tools, tool)) {
    throw new HttpError(403, `앱 '${q.appId}' 의 사용 동의가 예전 범위라 '${label}에서 파일 읽기' 를 쓸 수 없습니다 — 다시 동의(grant)하면 됩니다`);
  }
  await requireSessionParticipant(sessionId, q.member, { sessionOwner: deps.sessionOwner, canEnter: deps.canEnter });
  const attached = await deps.listAttached(sessionId);
  if (!attached.some((a) => a.app_id === q.appId)) {
    throw new HttpError(403, `앱 '${q.appId}' 이 이 세션에 붙어 있지 않습니다 — 붙은 앱 화면에서만 파일을 볼 수 있습니다`);
  }
  const now = deps.now ? deps.now() : Date.now();
  const tenant = deps.tenant ? deps.tenant() : "";
  if (!rate.take(`${tenant}\0${q.member}\0${q.appId}\0files`, now)) {
    throw new HttpError(429, `이 앱이 파일을 너무 자주 읽고 있습니다(분당 ${PROJECT_FILES_PER_MINUTE}회)`);
  }
  if (wide) return { app, exts, project: null };   // 어느 프로젝트인지는 호출부가 고른다(목록 = 색인 · 읽기 = 지목한 프로젝트)
  const project = await deps.projectOfSession(sessionId);
  if (!project || !project.folder) return { app, exts, project: null };
  //  세션에 들어갈 수 있는 사람이어도 그 프로젝트가 가려져 있으면(공개 범위) 없는 것으로 본다 — 프로젝트 라우트와 같은 답.
  if (!(await deps.canSeeProject(project.id, q.member))) return { app, exts, project: null };
  return { app, exts, project };
}

export interface ListInput extends ProjectFilesGateInput { ext?: unknown; limit?: unknown; scope?: unknown; q?: unknown }
/** from_session — 이 화면이 붙은 **그 세션이 만든** 파일(원준 2026-10-11 «이 세션이 방금 만든 HTML 이 가장 열기 어렵다»). 맞을 때만 실린다. */
export interface ListedFile { path: string; name: string; size: number; mtime: string; project_id?: number; project_name?: string; from_session?: true }
export interface ListResult { project_id: number | null; files: ListedFile[]; truncated: boolean; scope?: "all" }

/**
 * 목록 — 선언한 확장자 가운데 요청한 것만(요청이 없으면 선언 전부), 최신순, limit(기본 200 · 최대 500).
 *  프로젝트가 없거나 안 보이면 빈 목록(project_id null) — 오류가 아니다(앱이 «아직 없어요» 를 그린다).
 */
export async function listProjectFiles(q: ListInput, deps: ProjectFilesDeps, rate: RateWindow): Promise<ListResult> {
  if (q.scope != null && q.scope !== "" && q.scope !== "project" && q.scope !== "all") throw new HttpError(400, "scope 는 'project' 또는 'all' 입니다");
  if (q.scope === "all") return listWorkspaceFiles(q, deps, rate);
  const { exts, project } = await gate(q, deps, rate);
  if (!project) return { project_id: null, files: [], truncated: false };
  const want = wantedExts(q.ext, exts);
  const limit = Math.max(1, Math.min(PROJECT_FILES_LIST_MAX, Math.round(Number(q.limit)) || PROJECT_FILES_LIST_DEFAULT));
  if (!want.size) return { project_id: project.id, files: [], truncated: false };
  const m = await deps.manifest(project, q.member);
  const hits = m.files.filter((f) => want.has(extOf(f.path))).sort((a, b) => b.mtime - a.mtime);
  //  이 세션이 만든 것 — 색인이 아는 만큼만(못 읽어도 목록은 선다).
  const made = new Set(deps.sessionMade ? await deps.sessionMade(project, String(q.sessionId).trim(), q.member, [...want]).catch(() => [] as string[]) : []);
  return {
    project_id: project.id,
    files: hits.slice(0, limit).map((f) => ({ path: f.path, name: f.path.split("/").pop() || f.path, size: f.size, mtime: new Date(f.mtime).toISOString(), ...(made.has(f.path) ? { from_session: true as const } : {}) })),
    truncated: m.truncated || hits.length > limit,
  };
}

function wantedExts(raw: unknown, exts: string[]): Set<string> {
  const asked = (Array.isArray(raw) ? raw : (typeof raw === "string" && raw ? raw.split(",") : []))
    .map((x) => String(x).trim().toLowerCase().replace(/^\./, "")).filter(Boolean);
  return new Set(asked.length ? asked.filter((x) => exts.includes(x)) : exts);
}

/**
 * 전체 자료 목록(#4629) — 그 사람이 볼 수 있는 모든 프로젝트의 자료에서, workspace_files 로 선언한 확장자만, 최신순.
 *  줄마다 어느 프로젝트의 파일인지(project_id · project_name)가 실린다 — 읽을 때 그 project_id 를 함께 준다.
 *  프로젝트 공개 범위는 색인 조회가 건다(가려진 프로젝트의 줄이 limit 자리를 차지하지 않게). 여기서도 줄마다 한 번 더 본다(겹 방어 —
 *  자료의 공개 범위와 프로젝트의 공개 범위는 다른 축이다).
 */
async function listWorkspaceFiles(q: ListInput, deps: ProjectFilesDeps, rate: RateWindow): Promise<ListResult> {
  const { exts } = await gate(q, deps, rate, true);
  const sid = String(q.sessionId).trim();
  const attached = await deps.projectOfSession(sid);
  const want = wantedExts(q.ext, exts);
  const limit = Math.max(1, Math.min(PROJECT_FILES_LIST_MAX, Math.round(Number(q.limit)) || PROJECT_FILES_LIST_DEFAULT));
  //  붙은 세션의 프로젝트 id 도 그 사람에게 보일 때만 알려 준다(좁은 목록과 같은 답).
  const base: ListResult = { scope: "all", project_id: attached && attached.folder && (await deps.canSeeProject(attached.id, q.member)) ? attached.id : null, files: [], truncated: false };
  if (!want.size || !deps.workspaceIndex) return base;
  const term = String(q.q ?? "").replace(/\0/g, "").trim().slice(0, 100);
  const rows = await deps.workspaceIndex(q.member, [...want], { q: term, limit: limit + 1 });
  const seen = new Map<number, boolean>();
  const hits: WorkspaceFileEntry[] = [];
  for (const f of rows) {
    if (!want.has(extOf(f.path))) continue;
    let ok = seen.get(f.project_id);
    if (ok === undefined) { ok = await deps.canSeeProject(f.project_id, q.member); seen.set(f.project_id, ok); }
    if (ok) hits.push(f);
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  return {
    ...base,
    files: hits.slice(0, limit).map((f) => ({ path: f.path, name: f.path.split("/").pop() || f.path, size: f.size, mtime: new Date(f.mtime).toISOString(), project_id: f.project_id, project_name: f.project_name, ...(f.session && f.session === sid ? { from_session: true as const } : {}) })),
    //  넘침은 **보이는 줄**로만 센다 — 색인이 가려진 프로젝트를 이미 뺐지만(라이브), 걸러진 줄 수로 가려진 파일이 있다는 것이 새지 않게.
    truncated: hits.length > limit,
  };
}

export interface ReadInput extends ProjectFilesGateInput { path: unknown; projectId?: unknown }
export interface ReadResult { path: string; content: string; size: number; mtime: string }

/** 내용 — 선언한 확장자의 파일만(403), 8MB 까지(413). 없으면 404. */
export async function readProjectFile(q: ReadInput, deps: ProjectFilesDeps, rate: RateWindow): Promise<ReadResult> {
  const rel = normalizeRelPath(q.path);
  //  project_id 를 주면 전체 자료의 그 프로젝트에서 읽는다(#4629) — 붙은 세션의 프로젝트와 같은 id 여도 전체 자료의 선언 · 동의로 본다
  //   (앱이 id 를 지어내 좁은 동의로 넓은 곳을 읽는 길을 두지 않는다).
  const wide = q.projectId != null && q.projectId !== "";
  //  숫자이거나 숫자만으로 된 글일 때만(배열 · 불리언은 Number() 가 숫자로 읽어 버린다).
  const okId = typeof q.projectId === "number" || (typeof q.projectId === "string" && /^[0-9]{1,9}$/.test(q.projectId));
  const pid = wide && okId ? Number(q.projectId) : 0;
  if (wide && !(Number.isInteger(pid) && pid > 0)) throw new HttpError(400, "project_id 가 올바르지 않습니다");
  const g = await gate(q, deps, rate, wide);
  const exts = g.exts;
  let project = g.project;
  if (wide) {
    const p = deps.projectById ? await deps.projectById(pid) : null;
    project = p && p.folder && (await deps.canSeeProject(p.id, q.member)) ? p : null;   // 없거나 가려져 있으면 같은 답(404)
  }
  if (!exts.includes(extOf(rel))) throw new HttpError(403, `이 앱은 .${extOf(rel) || "(확장자 없음)"} 파일을 읽을 수 없습니다 — 선언한 확장자: ${exts.join(", ")}`);
  if (!project) throw new HttpError(404, "파일을 찾을 수 없습니다");
  const r = await deps.readText(project, q.member, rel);
  if (!r) throw new HttpError(404, "파일을 찾을 수 없습니다");
  if ("tooBig" in r) throw new HttpError(413, `파일이 너무 큽니다(${Math.round(r.tooBig / 1024 / 1024)}MB > ${PROJECT_FILE_READ_MAX / 1024 / 1024}MB)`);
  return { path: rel, content: r.content, size: r.size, mtime: new Date(r.mtime).toISOString() };
}
