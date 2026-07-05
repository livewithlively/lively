// v6 project_list capability — 프로젝트 묶음(리스트) CRUD·멤버·프로젝트 소속. 클릭업 List▸Task 의 List 층.
//  네이티브 전용(외부 PM 미러 없음). scope='memory'(조직 공유). 경로 prefix=/api/ui/v6/project-lists + 프로젝트 소속은 /projects/:id/list.
//  주의: project_list_v6(프로젝트 *목록* 조회)와 이름이 겹치지 않게, 리스트 엔티티 툴은 동사 접미사(create/update/delete/members/index)로 구분.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import {
  listProjectLists, createProjectList, updateProjectList, deleteProjectList,
  setProjectListMembers, setProjectListForProject, getProjectListRow, setProjectListSettings,
  getListClickupFields, reorderProjectLists,
} from "../v6/list-store.js";
import { projectIdsInList } from "../v6/project-store.js";
import { ensureAgentsMd } from "../v6/agents-md.js";
// 리스트 카테고리 변경(#541 후속 F4) — 그 리스트 모든 프로젝트가 상속하므로 AGENTS.md 재생성. best-effort·비차단.
const regenAgentsForList = async (listId: number) => {
  try { for (const pid of await projectIdsInList(listId)) await ensureAgentsMd(pid).catch(() => {}); } catch (_) { /* */ }
};

function parseId(v: unknown): number {
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "id 가 올바르지 않습니다");
  return id;
}
function parseColorOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > 32) throw new HttpError(400, "color 가 너무 깁니다");
  return s;
}
// list_id 본문 파서 — null/빈값=미분류(해제), 그 외=양의 정수.
function parseListIdOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "list_id 는 양의 정수 또는 null 이어야 합니다");
  return n;
}

const writeCtxOf = (user: any, ctx: any) => ({ actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" });

// ── 리스트 목록 ──
const projectListIndexV6: Capability = {
  name: "project_list_index_v6",
  title: "프로젝트 리스트 목록(v6)",
  description: "프로젝트 묶음(리스트) 전체 + 각 리스트의 멤버·프로젝트 수를 돌려준다. (프로젝트 *목록*은 project_list_v6.) 웹 보드 그룹핑 전용.",
  scope: "memory",
  input: {},
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/project-lists"], parse: () => ({}) }],
  },
  // 공개범위 시행(#475): REST(웹)는 viewer 신원으로 members-only 리스트를 비멤버에게서 숨긴다. MCP 는 전체.
  handler: async (_input: any, user: any, ctx: any) => {
    const viewerVis = (ctx?.source === "web" || user?.userId) ? (ctx?.actor ?? user?.userId ?? "") : undefined;
    return { lists: await listProjectLists(viewerVis) };
  },
};

// ── 리스트 생성 ──
const projectListCreateV6: Capability = {
  name: "project_list_create_v6",
  title: "프로젝트 리스트 생성(v6)",
  description: "프로젝트 묶음(리스트)을 만든다 + 멤버 초기 등록. 멤버는 보드 기본 펼침/접힘을 가르는 참여자(프로젝트 팀원과 별개).",
  scope: "memory",
  input: {
    name: z.string().min(1).max(120),
    color: z.string().max(32).nullable().optional(),
    members: z.array(z.string()).optional(),
    category_id: z.number().int().positive().nullable().optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/project-lists"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? "").trim();
        if (!name) throw new HttpError(400, "name 이 필요합니다");
        if (name.length > 120) throw new HttpError(400, "name 이 너무 깁니다(최대 120자)");
        return {
          name,
          color: parseColorOrNull(b.color),
          members: Array.isArray(b.members) ? b.members.map((x: unknown) => String(x)) : undefined,
          category_id: b.category_id == null || b.category_id === "" ? null : Number(b.category_id),
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const list = await createProjectList(input, writeCtxOf(user, ctx));
    return { list };
  },
};

// ── 리스트 수정(이름·색) ──
const projectListUpdateV6: Capability = {
  name: "project_list_update_v6",
  title: "프로젝트 리스트 수정(v6)",
  description: "리스트의 이름·색을 수정한다(주어진 키만 변경).",
  scope: "memory",
  input: {
    id: z.number().int().positive(),
    name: z.string().min(1).max(120).optional(),
    color: z.string().max(32).nullable().optional(),
    sort: z.number().int().optional(),
    visibility: z.enum(["open", "members"]).optional(),
    category_id: z.number().int().positive().nullable().optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/project-lists/:id"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = { id: parseId(req.params?.id) };
        if ("name" in b) {
          const name = String(b.name ?? "").trim();
          if (!name) throw new HttpError(400, "이름은 비울 수 없습니다");
          if (name.length > 120) throw new HttpError(400, "name 이 너무 깁니다(최대 120자)");
          patch.name = name;
        }
        if ("color" in b) patch.color = parseColorOrNull(b.color);
        if ("sort" in b) patch.sort = Number(b.sort) || 0;
        // 공개범위(#475): 'members'=리스트 멤버만 열람, 그 외 값은 'open'(전원).
        if ("visibility" in b) patch.visibility = String(b.visibility) === "members" ? "members" : "open";
        // 카테고리(도메인) 소유(#541 후속): null/빈값=미분류(해제), 양의 정수=설정. 소속 프로젝트가 상속.
        if ("category_id" in b) patch.category_id = b.category_id == null || b.category_id === "" ? null : Number(b.category_id);
        return patch;
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const { id, ...patch } = input;
    const list = await updateProjectList(id, patch, writeCtxOf(user, ctx));
    // 카테고리(도메인) 변경 시 이 리스트 모든 프로젝트의 AGENTS.md 재생성(상속 도메인 줄 갱신, F4).
    if ("category_id" in patch) await regenAgentsForList(id);
    return { list };
  },
};

// ── 리스트 삭제 — 소속 프로젝트는 보존(list_id SET NULL → 미분류). ──
const projectListDeleteV6: Capability = {
  name: "project_list_delete_v6",
  title: "프로젝트 리스트 삭제(v6)",
  description: "리스트를 삭제한다. 소속 프로젝트는 사라지지 않고 '미분류'로 이동(list_id 해제), 리스트 멤버 연결만 정리된다.",
  scope: "memory",
  input: { id: z.number().int().positive() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/project-lists/:id/delete"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const before = await getProjectListRow(input.id);
    if (!before) throw new HttpError(404, `리스트 #${input.id} 없음`);
    const list = await deleteProjectList(input.id, writeCtxOf(user, ctx));
    return { deleted: true, id: input.id, list };
  },
};

// ── 리스트 멤버 통째 교체 ──
const projectListSetMembersV6: Capability = {
  name: "project_list_set_members_v6",
  title: "프로젝트 리스트 멤버 변경(v6)",
  description: "리스트의 참여 멤버(project_list_member)를 member_id 배열로 통째 교체. 참여 멤버는 보드에서 그 리스트를 기본 펼침으로 본다.",
  scope: "memory",
  input: { id: z.number().int().positive(), members: z.array(z.string()).default([]) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/project-lists/:id/members"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return {
          id: parseId(req.params?.id),
          members: Array.isArray(b.members) ? b.members.map((x: unknown) => String(x)) : [],
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    if (!(await getProjectListRow(input.id))) throw new HttpError(404, `리스트 #${input.id} 없음`);
    const member_ids = await setProjectListMembers(input.id, input.members, writeCtxOf(user, ctx));
    return { member_ids };
  },
};

// ── 프로젝트의 리스트 소속 설정 — list_id=null 이면 미분류로. ──
const projectSetListV6: Capability = {
  name: "project_set_list_v6",
  title: "프로젝트 리스트 소속 설정(v6)",
  description: "프로젝트(level=project)를 특정 리스트에 넣거나(list_id) 미분류로 뺀다(list_id=null).",
  scope: "memory",
  input: { id: z.number().int().positive(), list_id: z.number().int().positive().nullable() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/list"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { id: parseId(req.params?.id), list_id: parseListIdOrNull(b.list_id) };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    try {
      const list_id = await setProjectListForProject(input.id, input.list_id ?? null, writeCtxOf(user, ctx));
      return { id: input.id, list_id };
    } catch (e: any) {
      if (/없음/.test(String(e?.message ?? ""))) throw new HttpError(404, e.message);
      throw e;
    }
  },
};

// ── 리스트 목록 UI 커스텀(settings JSONB 얕은 병합) — 기본 보기·표시필드 등 프리퍼런스(#475). ──
const projectListSetSettingsV6: Capability = {
  name: "project_list_set_settings_v6",
  title: "리스트 목록 UI 설정(v6)",
  description: "리스트의 목록 UI 커스텀 설정(settings)을 얕은 병합으로 갱신한다. 준 키만 덮어쓰고 나머지는 보존, null 값은 키 삭제.",
  scope: "memory",
  input: { id: z.number().int().positive(), settings: z.record(z.unknown()) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/project-lists/:id/settings"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const settings = (b.settings && typeof b.settings === "object" && !Array.isArray(b.settings))
          ? b.settings as Record<string, unknown> : {};
        return { id: parseId(req.params?.id), settings };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    if (!(await getProjectListRow(input.id))) throw new HttpError(404, `리스트 #${input.id} 없음`);
    const list = await setProjectListSettings(input.id, input.settings, writeCtxOf(user, ctx));
    return { list };
  },
};

// ── 리스트 스코프 ClickUp 커스텀필드 컬럼(#541) — 이관 정의를 리스트 뷰 컬럼으로(값·프로젝트별 내부 id 맵 동봉). ──
const projectListClickupFieldsV6: Capability = {
  name: "project_list_clickup_fields_v6",
  title: "리스트 ClickUp 필드 컬럼(v6)",
  description: "리스트에 이관된 ClickUp 커스텀필드 정의(external dedup)·프로젝트별 값·편집용 내부 field id 맵을 돌려준다. 보드 리스트 뷰 컬럼 전용.",
  scope: "memory",
  input: { id: z.number().int().positive() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/project-lists/:id/clickup-fields"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: any) => {
    if (!(await getProjectListRow(input.id))) throw new HttpError(404, `리스트 #${input.id} 없음`);
    return await getListClickupFields(input.id);
  },
};

// ── 리스트 재정렬(#541 사이드바) — 같은 폴더의 형제 리스트 id 배열 순서대로 sort 재부여. 웹 드래그 전용. ──
const projectListReorderV6: Capability = {
  name: "project_list_reorder_v6",
  title: "리스트 순서 변경(v6)",
  description: "리스트의 사이드바 표시 순서를 주어진 id 배열 순서대로 저장한다(sort 를 1,2,… 로 재부여). 사이드바 드래그 재정렬용.",
  scope: "memory",
  input: { ids: z.array(z.number().int().positive()).min(2).max(500) },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/project-lists-reorder"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const ids = Array.isArray(b.ids) ? b.ids.map((x) => parseId(x)) : [];
        if (ids.length < 2) throw new HttpError(400, "ids 는 2개 이상이어야 합니다");
        return { ids };
      } }],
  },
  handler: async (input: any) => await reorderProjectLists(input.ids),
};

export const listV6Capabilities: Capability[] = [
  projectListIndexV6, projectListCreateV6, projectListUpdateV6, projectListDeleteV6,
  projectListSetMembersV6, projectSetListV6, projectListSetSettingsV6, projectListClickupFieldsV6, projectListReorderV6,
];
