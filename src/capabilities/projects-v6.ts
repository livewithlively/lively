// v6 project capability — 프로젝트(1급 엔티티) + 작업(task/subtask) CRUD·상태·팀원·카테고리/지식 연결.
//  레거시 org_project capability(projects.ts)와 병행(REST-only 로 시작 — 웹 v6 프로젝트 탭이 소비). MCP 노출은 컷오버에서 일괄.
//  scope='memory'(조직 공유 작업/지식 평면 — 레거시 project_* 와 동일). 경로 prefix=/api/ui/v6/projects. 감사는 store(project-store)가 처리.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import {
  listProjects, getProject, getProjectRow, createProject, deleteProject, updateProjectStatus,
  createTask, updateTaskStatus, updateTask, setProjectMembers, isProjectMember,
  linkProjectCategory, unlinkProjectCategory,
  linkProjectKnowledge, unlinkProjectKnowledge,
} from "../v6/project-store.js";

const STATUSES = ["active", "done"] as const;
const RELATIONS = ["required", "produced"] as const;
// 태스크 전용 다단계 상태(프로젝트의 active|done 와 별개) — 리스트뷰 그룹핑 축. 우선순위 4단계(클릭업 동형).
const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
const PRIORITIES = ["urgent", "high", "normal", "low"] as const;

function parseId(v: unknown): number {
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "id 가 올바르지 않습니다");
  return id;
}
function parseStatus(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!(STATUSES as readonly string[]).includes(s)) throw new HttpError(400, "status 는 active|done 중 하나여야 합니다");
  return s;
}
function parseRelation(v: unknown): string {
  const r = String(v ?? "").trim();
  if (!(RELATIONS as readonly string[]).includes(r)) throw new HttpError(400, "relation 은 required|produced 중 하나여야 합니다");
  return r;
}
// 태스크 필드 파서 — 패치 시맨틱: 키 부재=변경 없음(undefined), 키 존재+빈값/null=해제(null). 따라서 null 반환 가능.
function parseTaskStatus(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!(TASK_STATUSES as readonly string[]).includes(s)) throw new HttpError(400, "status 는 todo|in_progress|done 중 하나여야 합니다");
  return s;
}
function parsePriorityOrNull(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!s) return null;
  if (!(PRIORITIES as readonly string[]).includes(s)) throw new HttpError(400, "priority 는 urgent|high|normal|low 또는 빈값이어야 합니다");
  return s;
}
function parseDateOrNull(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, "날짜는 YYYY-MM-DD 형식이어야 합니다");
  return s;
}
function parseAssigneeOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

const projectListV6: Capability = {
  name: "project_list_v6",
  title: "프로젝트 목록(v6)",
  description: "프로젝트(level=project)를 space/카테고리/status 로 최신순 조회. 웹 v6 프로젝트 탭 전용.",
  scope: "memory",
  // 핸들러가 읽는 이름(REST 는 query 'category'→categoryId 매핑).
  input: {
    space: z.string().optional(),
    categoryId: z.number().int().positive().optional(),
    status: z.enum(STATUSES).optional(),
    mine: z.boolean().optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/projects"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        return {
          space: query.space ? String(query.space) : undefined,
          categoryId: query.category ? Number(query.category) : undefined,
          status: query.status ? String(query.status) : undefined,
          mine: query.mine === "1" || query.mine === "true",
        };
      } }],
  },
  // mine=1 이면 viewer(토큰 신원) 기준 '내 프로젝트'만(생성자·팀원). MCP 호출은 mine 미지정 → 전체.
  handler: async (input: any, user: any, ctx: any) => ({
    projects: await listProjects({
      space: input.space, categoryId: input.categoryId, status: input.status,
      viewer: input.mine ? (ctx?.actor ?? user?.userId ?? null) : undefined,
    }),
  }),
};

const projectGetV6: Capability = {
  name: "project_get_v6",
  title: "프로젝트 상세(v6)",
  description: "프로젝트 1건 + 팀원·작업위계(task▸subtask)·카테고리·필요/산출지식. 상세 페이지 전용.",
  scope: "memory",
  input: { id: z.number().int().positive() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/projects/:id"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const project = await getProject(input.id);
    if (!project) throw new HttpError(404, `프로젝트 #${input.id} 없음`);
    // 웹(상세 페이지)은 org #/projects 와 동일하게 팀원만 — 비초대자는 403. MCP(에이전트 조직 조회)는 무게이트.
    if (ctx?.source === "web" && !(await isProjectMember(input.id, ctx?.actor ?? user?.userId ?? null))) {
      throw new HttpError(403, "초대받은 팀원만 볼 수 있습니다");
    }
    return { project };
  },
};

const projectCreateV6: Capability = {
  name: "project_create_v6",
  title: "프로젝트 생성(v6)",
  description: "새 프로젝트를 만든다(진행중으로 시작) + 팀원 초기 등록. 웹 전용.",
  scope: "memory",
  input: {
    name: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    folder: z.string().max(256).optional(),
    members: z.array(z.string()).optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? "").trim();
        if (!name) throw new HttpError(400, "name 이 필요합니다");
        return {
          name,
          description: b.description ? String(b.description) : undefined,
          folder: b.folder ? String(b.folder) : undefined,
          members: Array.isArray(b.members) ? b.members.map((x: unknown) => String(x)) : undefined,
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { project: await createProject(input, writeCtx) };
  },
};

const projectSetStatusV6: Capability = {
  name: "project_set_status_v6",
  title: "프로젝트 상태 변경(v6)",
  description: "프로젝트를 진행중(active)↔완료(done)로 토글. 완료 시 완료시각 기록. 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive(), status: z.enum(STATUSES) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/status"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { id: parseId(req.params?.id), status: parseStatus(b.status) };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { project: await updateProjectStatus(input.id, input.status, writeCtx) };
  },
};

const projectDeleteV6: Capability = {
  name: "project_delete_v6",
  title: "프로젝트 삭제(v6)",
  description: "프로젝트를 삭제한다(작성자 본인만). 자식 작업·팀원·카테고리/지식 연결은 FK CASCADE 로 정리되고, 작업 이벤트(activity)는 링크만 해제(SET NULL)된다. 진행중/완료 상태 무관. 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/delete"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const actor = ctx?.actor ?? user?.userId ?? null;
    const before = await getProjectRow(input.id);
    if (!before) throw new HttpError(404, `프로젝트 #${input.id} 없음`);
    // 소유자 본인만 삭제 — created_by(생성 시 actor=userId||email)와 요청자 일치를 강제한다.
    //  프론트의 버튼 숨김에 의존하지 않는 서버측 게이트(채널·토큰 무관 동일 적용 — fail-closed).
    if (!actor || before.created_by !== actor) {
      throw new HttpError(403, "본인이 만든 프로젝트만 삭제할 수 있습니다");
    }
    await deleteProject(input.id, { actor, source: ctx?.source ?? "web" });
    return { deleted: true, id: input.id };
  },
};

const projectSetMembersV6: Capability = {
  name: "project_set_members_v6",
  title: "프로젝트 팀원 변경(v6)",
  description: "프로젝트 팀원(project_member)을 member_id 배열로 통째 교체. 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive(), members: z.array(z.string()).default([]) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/members"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return {
          id: parseId(req.params?.id),
          members: Array.isArray(b.members) ? b.members.map((x: unknown) => String(x)) : [],
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { member_ids: await setProjectMembers(input.id, input.members, writeCtx) };
  },
};

const projectLinkCategoryV6: Capability = {
  name: "project_link_category_v6",
  title: "프로젝트↔카테고리(v6)",
  description: "프로젝트를 카테고리에 연결(또는 unlink=true 로 해제). 웹 전용.",
  scope: "memory",
  // 핸들러가 읽는 이름(REST 는 :id 경로 + body 'category_id'→categoryId 매핑).
  input: {
    id: z.number().int().positive(),
    categoryId: z.number().int().positive(),
    unlink: z.boolean().optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/category"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const categoryId = Number(b.category_id);
        if (!Number.isInteger(categoryId) || categoryId <= 0) throw new HttpError(400, "category_id 가 필요합니다");
        return { id: parseId(req.params?.id), categoryId, unlink: b.unlink === true };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    if (input.unlink) { await unlinkProjectCategory(input.id, input.categoryId, writeCtx); return { unlinked: true }; }
    await linkProjectCategory(input.id, input.categoryId, writeCtx);
    return { linked: true };
  },
};

const projectLinkKnowledgeV6: Capability = {
  name: "project_link_knowledge_v6",
  title: "프로젝트↔지식(v6)",
  description: "프로젝트의 필요(required)/산출(produced) 지식을 연결(또는 unlink=true 로 해제). 웹 전용.",
  scope: "memory",
  input: {
    id: z.number().int().positive(),
    name: z.string().min(1).max(64),
    relation: z.enum(RELATIONS),
    unlink: z.boolean().optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/knowledge"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? "").trim();
        if (!name) throw new HttpError(400, "name 이 필요합니다");
        return { id: parseId(req.params?.id), name, relation: parseRelation(b.relation), unlink: b.unlink === true };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    if (input.unlink) { await unlinkProjectKnowledge(input.id, input.name, input.relation, writeCtx); return { unlinked: true }; }
    await linkProjectKnowledge(input.id, input.name, input.relation, writeCtx);
    return { linked: true };
  },
};

// ── 작업(task/subtask) — :id 는 프로젝트. parent_task_id 주면 하위작업(subtask). ──
const taskCreateV6: Capability = {
  name: "task_create_v6",
  title: "작업 생성(v6)",
  description: "프로젝트에 작업(task)을 만든다. parentTaskId 를 주면 하위작업(subtask). 웹 전용.",
  scope: "memory",
  // 핸들러가 읽는 이름(REST 는 :id→projectId, body 'parent_task_id'→parentTaskId 매핑).
  input: {
    projectId: z.number().int().positive(),
    name: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    parentTaskId: z.number().int().positive().optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/tasks"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? "").trim();
        if (!name) throw new HttpError(400, "name 이 필요합니다");
        return {
          projectId: parseId(req.params?.id),
          name,
          description: b.description ? String(b.description) : undefined,
          parentTaskId: b.parent_task_id != null && b.parent_task_id !== "" ? parseId(b.parent_task_id) : undefined,
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { task: await createTask(input, writeCtx) };
  },
};

const taskSetStatusV6: Capability = {
  name: "task_set_status_v6",
  title: "작업 상태 변경(v6)",
  description: "작업(task/subtask)을 진행중(active)↔완료(done)로 토글. 완료 시 완료시각 기록. 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive(), status: z.enum(STATUSES) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tasks/:id/status"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { id: parseId(req.params?.id), status: parseStatus(b.status) };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { task: await updateTaskStatus(input.id, input.status, writeCtx) };
  },
};

// ── 작업 필드 패치 — 상태(다단계)·우선순위·담당자·기간·이름·설명. 리스트뷰 인라인 편집의 단일 엔드포인트. ──
//  패치 시맨틱: body 에 있는 키만 변경(부재=무변경, null/빈값=해제). status 전용 /tasks/:id/status(active|done,
//  MCP·미러용)와 병존 — 새 웹 UI 는 상태도 이 엔드포인트(todo|in_progress|done)로 보낸다. REST-only(mcp:false).
const taskUpdateV6: Capability = {
  name: "task_update_v6",
  title: "작업 필드 수정(v6)",
  description: "작업(task/subtask)의 상태·우선순위·담당자·기간·이름·설명을 패치. 주어진 키만 변경. 웹 프로젝트 탭 전용.",
  scope: "memory",
  input: {
    id: z.number().int().positive(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(PRIORITIES).nullable().optional(),
    assignee: z.string().nullable().optional(),
    start_date: z.string().nullable().optional(),
    due_date: z.string().nullable().optional(),
  },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tasks/:id"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = { id: parseId(req.params?.id) };
        if ("name" in b) {
          const name = String(b.name ?? "").trim();
          if (!name) throw new HttpError(400, "name 은 비울 수 없습니다");
          patch.name = name;
        }
        if ("description" in b) patch.description = b.description == null ? null : String(b.description);
        if ("status" in b) patch.status = parseTaskStatus(b.status);
        if ("priority" in b) patch.priority = parsePriorityOrNull(b.priority);
        if ("assignee" in b) patch.assignee = parseAssigneeOrNull(b.assignee);
        if ("start_date" in b) patch.start_date = parseDateOrNull(b.start_date);
        if ("due_date" in b) patch.due_date = parseDateOrNull(b.due_date);
        return patch;
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const { id, ...patch } = input;
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { task: await updateTask(id, patch, writeCtx) };
  },
};

export const projectV6Capabilities: Capability[] = [
  projectListV6, projectGetV6, projectCreateV6, projectDeleteV6, projectSetStatusV6, projectSetMembersV6,
  projectLinkCategoryV6, projectLinkKnowledgeV6, taskCreateV6, taskSetStatusV6, taskUpdateV6,
];
