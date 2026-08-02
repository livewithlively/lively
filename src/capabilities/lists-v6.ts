// v6 project_list capability — 프로젝트 묶음(리스트) CRUD·멤버·프로젝트 소속. 클릭업 List▸Task 의 List 층.
//  네이티브 전용(외부 PM 미러 없음). scope='memory'(조직 공유). 경로 prefix=/api/ui/v6/project-lists + 프로젝트 소속은 /projects/:id/list.
//  주의: project_list_v6(프로젝트 *목록* 조회)와 이름이 겹치지 않게, 리스트 엔티티 툴은 동사 접미사(create/update/delete/members/index)로 구분.
import { z } from "zod";
import { visibleListIds, canSeeProjectRow, invalidateVisibilityCache } from "../v6/visibility.js";
import { syncFolderAcls } from "../v6/folder-acl-sync.js";
import { isAdmin } from "./principal.js";
import { HttpError, parseId } from "./rest-util.js";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import {
  listProjectLists, createProjectList, updateProjectList, deleteProjectList,
  setProjectListMembers, setProjectListForProject, getProjectListRow, setProjectListSettings,
  getListClickupFields, reorderProjectLists, setProjectListTeams, getProjectListTeams,
  getProjectListMemberIds, getProjectListId,
} from "../v6/list-store.js";
import { existingTeamIds } from "../v6/team-store.js";
import { activeMemberIdsAmong } from "../org/store/members.js";
import { projectIdsInList, deleteProject } from "../v6/project-store.js";
import { ensureAgentsMd } from "../v6/agents-md.js";
// 리스트 카테고리 변경(#541 후속 F4) — 그 리스트 모든 프로젝트가 상속하므로 AGENTS.md 재생성. best-effort·비차단.
const regenAgentsForList = async (listId: number) => {
  try { for (const pid of await projectIdsInList(listId)) await ensureAgentsMd(pid).catch(() => {}); } catch (_) { /* */ }
};

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

const writeCtxOf = (user: LivelyUser, ctx?: CapabilityCtx) => ({ actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" });

// ── 리스트 목록 ──
// 공개범위 게이트(#1291) — 안 보이는 리스트는 고칠 수도, 지울 수도, 대상을 바꿀 수도 없다.
//  특히 '대상 바꾸기'가 중요하다: 이게 열려 있으면 비대상자가 잠긴 리스트를 다시 open 으로 돌리거나
//  자기만 남기고 남을 밀어낼 수 있다(잠금 탈취). 거부는 404 — 존재를 숨긴다.
// 대상(audience) 검증 — 공개범위가 걸린 리스트에서만 발동한다(open 리스트의 '참여 멤버'는 예전처럼 표시용이다).
//  ①실재하지 않는 id(오타)로 잠그면 아무도 못 보는 리스트가 된다 ②빈 대상도 마찬가지 ③잠그는 사람이 스스로
//  빠지면 자기가 만든 걸 자기가 못 여는 상태가 되고, 되돌릴 사람은 admin 뿐이다.
async function assertGrantSubjectsValid(members: string[], visibility: string, ctx?: CapabilityCtx): Promise<void> {
  if (visibility !== "members") return;
  const ids = [...new Set((members || []).map((m) => String(m).trim()).filter(Boolean))];
  if (!ids.length) throw new HttpError(400, "공개 대상을 한 명 이상 지정하세요 — 비우면 관리자 외에는 아무도 볼 수 없습니다");
  const found = await activeMemberIdsAmong(ids);
  const missing = ids.filter((m) => !found.includes(m));
  if (missing.length) throw new HttpError(400, `구성원이 아닌 대상입니다: ${missing.join(", ")}`);
  const me = ctx?.viewer ?? null;
  if (me !== null && !ids.includes(String(me))) {
    throw new HttpError(400, "본인을 대상에서 빼면 이 리스트를 다시 열 수 없습니다 — 본인을 포함해 주세요(관리자는 예외)");
  }
}

async function assertProjectVisibleForMove(id: number, ctx?: CapabilityCtx): Promise<void> {
  const viewer = ctx?.viewer ?? null;
  if (viewer === null) return;
  if (!(await canSeeProjectRow(Number(id), viewer))) throw new HttpError(404, `프로젝트 #${id} 없음`);
}

async function assertListVisible(id: number, ctx?: CapabilityCtx): Promise<void> {
  const viewer = ctx?.viewer ?? null;
  if (viewer === null) return;
  const ids = await visibleListIds(viewer);
  if (ids && !ids.has(Number(id))) throw new HttpError(404, `리스트 #${id} 없음`);
}

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
  // 공개범위 시행(#475·#1291): viewer 신원으로 members-only 리스트를 비대상에게서 숨긴다 — REST(웹)·MCP(AI) 동일.
  handler: async (_input: unknown, user: LivelyUser, ctx?: CapabilityCtx) => {
    // 어댑터가 채운 열람 신원(#1291). v2: admin 도 정규화되지 않는다 — 아래에서 메타데이터만 따로 얹는다.
    const lists = await listProjectLists(ctx?.viewer ?? null);
    // 관리자에게는 **잠긴 리스트의 존재·이름·대상·개수**를 함께 준다(내용은 아니다) — v2 에서 admin 우회를 없앴지만
    //  그렇다고 눈까지 감기면 회수·용량·감사 같은 운영이 불가능해진다. Notion 도 비공개 팀스페이스의 이름·멤버는 보인다.
    //  프론트는 이 행을 🔒 '내용 비공개'로 그리고, 내용을 봐야 하면 긴급 열람으로 유도한다.
    if (isAdmin(user)) {
      const seen = new Set(lists.map((l) => Number(l.id)));
      const all = await listProjectLists(null);
      for (const l of all) {
        if (seen.has(Number(l.id))) continue;
        lists.push({ ...l, locked: true, projects_hidden: true } as typeof l);
      }
    }
    // 잠긴 리스트만 팀 grant 를 동봉한다(open 이면 조회 자체가 낭비) — 설정 폼이 현재 값을 그려야 한다.
    for (const l of lists) {
      if ((l as any).visibility === "members") (l as any).teams = await getProjectListTeams(Number(l.id));
    }
    return { lists };
  },
};

// ── 리스트 생성 ──
const projectListCreateV6Input = {
  name: z.string().min(1).max(120),
  color: z.string().max(32).nullable().optional(),
  members: z.array(z.string()).optional(),
  category_id: z.number().int().positive().nullable().optional(),
};
type ProjectListCreateV6Input = z.infer<z.ZodObject<typeof projectListCreateV6Input>>;
const projectListCreateV6: Capability = {
  name: "project_list_create_v6",
  title: "프로젝트 리스트 생성(v6)",
  description: "프로젝트 묶음(리스트)을 만든다 + 멤버 초기 등록. 멤버는 보드 기본 펼침/접힘을 가르는 참여자(프로젝트 팀원과 별개).",
  scope: "memory",
  input: projectListCreateV6Input,
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
  handler: async (input: ProjectListCreateV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    const list = await createProjectList(input, writeCtxOf(user, ctx));
    return { list };
  },
};

// ── 리스트 수정(이름·색) ──
const projectListUpdateV6Input = {
  id: z.number().int().positive(),
  name: z.string().min(1).max(120).optional(),
  color: z.string().max(32).nullable().optional(),
  sort: z.number().int().optional(),
  visibility: z.enum(["open", "members"]).optional(),
  category_id: z.number().int().positive().nullable().optional(),
};
type ProjectListUpdateV6Input = z.infer<z.ZodObject<typeof projectListUpdateV6Input>>;
const projectListUpdateV6: Capability = {
  name: "project_list_update_v6",
  title: "프로젝트 리스트 수정(v6)",
  description: "리스트의 이름·색을 수정한다(주어진 키만 변경).",
  scope: "memory",
  input: projectListUpdateV6Input,
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
  handler: async (input: ProjectListUpdateV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertListVisible(input.id, ctx);
    const { id, ...patch } = input;
    // 잠그는 전환(open→members)이면 그 시점의 대상 목록으로 검증한다 — 대상이 비어 있거나 본인이 빠져 있으면
    //  잠그는 순간 아무도(혹은 본인이) 못 여는 리스트가 된다.
    if (patch.visibility === "members") {
      await assertGrantSubjectsValid(await getProjectListMemberIds(id), "members", ctx);
    }
    const list = await updateProjectList(id, patch, writeCtxOf(user, ctx));
    if ("visibility" in patch) { invalidateVisibilityCache(); await syncFolderAcls(id); }   // 회수·개방이 세션 목록·셸 양쪽에 반영되도록
    // 카테고리(도메인) 변경 시 이 리스트 모든 프로젝트의 AGENTS.md 재생성(상속 도메인 줄 갱신, F4).
    if ("category_id" in patch) await regenAgentsForList(id);
    return { list };
  },
};

// ── 리스트 삭제 — 기본은 소속 프로젝트 보존(list_id SET NULL → 미분류). cascade_projects=true 면 소속 프로젝트도 함께 삭제. ──
const projectListDeleteV6Input = { id: z.number().int().positive(), cascade_projects: z.boolean().optional() };
type ProjectListDeleteV6Input = z.infer<z.ZodObject<typeof projectListDeleteV6Input>>;
const projectListDeleteV6: Capability = {
  name: "project_list_delete_v6",
  title: "프로젝트 리스트 삭제(v6)",
  description: "리스트를 삭제한다. 기본은 소속 프로젝트를 보존해 '미분류'로 이동(list_id 해제)하고 리스트 멤버 연결만 정리한다. cascade_projects=true 면 소속 프로젝트(그 하위 태스크·서브태스크 포함)도 함께 삭제한다(각각 감사 스냅샷 → 휴지통에서 복원 가능).",
  scope: "memory",
  input: projectListDeleteV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/project-lists/:id/delete"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        // cascade_projects — true/'true'/1 만 참(그 외 전부 거짓). 미지정=기존 동작(프로젝트 보존).
        const cascade = b.cascade_projects === true || b.cascade_projects === "true" || b.cascade_projects === 1;
        return { id: parseId(req.params?.id), cascade_projects: cascade };
      } }],
  },
  handler: async (input: ProjectListDeleteV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertListVisible(input.id, ctx);
    const before = await getProjectListRow(input.id);
    if (!before) throw new HttpError(404, `리스트 #${input.id} 없음`);
    const wctx = writeCtxOf(user, ctx);
    // cascade — 리스트 삭제(list_id SET NULL)로 프로젝트가 미분류로 새기 전에, 소속 프로젝트를 먼저 삭제.
    //  deleteProject 는 하위 태스크(parent_id CASCADE)까지 지우고 각 프로젝트마다 감사 스냅샷을 남겨 휴지통 복원이 된다.
    let deletedProjects = 0;
    if (input.cascade_projects) {
      const pids = await projectIdsInList(input.id); // 보드 앵커(list_id NULL)는 애초에 제외됨.
      for (const pid of pids) { await deleteProject(pid, wctx); deletedProjects++; }
    }
    const list = await deleteProjectList(input.id, wctx);
    return { deleted: true, id: input.id, list, deleted_projects: deletedProjects, cascade: !!input.cascade_projects };
  },
};

// ── 리스트 멤버 통째 교체 ──
const projectListSetMembersV6Input = { id: z.number().int().positive(), members: z.array(z.string()).default([]) };
type ProjectListSetMembersV6Input = z.infer<z.ZodObject<typeof projectListSetMembersV6Input>>;
const projectListSetMembersV6: Capability = {
  name: "project_list_set_members_v6",
  title: "프로젝트 리스트 멤버 변경(v6)",
  description: "리스트의 참여 멤버(project_list_member)를 member_id 배열로 통째 교체. 참여 멤버는 보드에서 그 리스트를 기본 펼침으로 본다.",
  scope: "memory",
  input: projectListSetMembersV6Input,
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
  handler: async (input: ProjectListSetMembersV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertListVisible(input.id, ctx);
    const row = await getProjectListRow(input.id);
    if (!row) throw new HttpError(404, `리스트 #${input.id} 없음`);
    await assertGrantSubjectsValid(input.members, row.visibility, ctx);
    const member_ids = await setProjectListMembers(input.id, input.members, writeCtxOf(user, ctx));
    invalidateVisibilityCache();   // 대상에서 빠진 사람의 세션 목록이 즉시 좁아지도록
    await syncFolderAcls(input.id);  // 셸 경로(OS ACL)도 같은 대상으로
    return { member_ids };
  },
};

// ── 리스트 공개 대상: 팀(#1291 v2) ── 멤버 열거와 나란한 두 번째 주체 축.
const projectListSetTeamsV6Input = { id: z.number().int().positive(), teams: z.array(z.number().int().positive()).max(200) };
type ProjectListSetTeamsV6Input = z.infer<z.ZodObject<typeof projectListSetTeamsV6Input>>;
const projectListSetTeamsV6: Capability = {
  name: "project_list_set_teams_v6",
  title: "리스트 공개 대상 팀 설정(v6)",
  description: "이 리스트를 볼 수 있는 **팀**을 지정한다(전체 교체). 공개범위가 'members' 일 때만 의미가 있다. "
    + "팀은 라이브 그룹핑이라 팀원이 바뀌면 대상도 자동으로 따라간다 — 부서 단위로 잠글 때 멤버를 일일이 관리하지 않아도 된다.",
  scope: "memory",
  input: projectListSetTeamsV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/project-lists/:id/teams"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { id: parseId(req.params?.id), teams: Array.isArray(b.teams) ? b.teams.map((x) => Number(x)) : [] };
      } }],
  },
  handler: async (input: ProjectListSetTeamsV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertListVisible(input.id, ctx);
    const row = await getProjectListRow(input.id);
    if (!row) throw new HttpError(404, `리스트 #${input.id} 없음`);
    // 실재하는 팀만 — 오타 id 로 잠그면 아무도 못 여는 리스트가 된다(멤버 검증과 같은 이유).
    if (input.teams.length) {
      const found = await existingTeamIds(input.teams);
      const missing = input.teams.filter((t: number) => !found.includes(Number(t)));
      if (missing.length) throw new HttpError(400, `없는 팀입니다: ${missing.join(", ")}`);
    }
    const team_ids = await setProjectListTeams(input.id, input.teams, writeCtxOf(user, ctx));
    invalidateVisibilityCache();
    await syncFolderAcls(input.id);
    return { team_ids };
  },
};

// ── 프로젝트의 리스트 소속 설정 — list_id=null 이면 미분류로. ──
const projectSetListV6Input = { id: z.number().int().positive(), list_id: z.number().int().positive().nullable() };
type ProjectSetListV6Input = z.infer<z.ZodObject<typeof projectSetListV6Input>>;
const projectSetListV6: Capability = {
  name: "project_set_list_v6",
  title: "프로젝트 리스트 소속 설정(v6)",
  description: "프로젝트(level=project)를 특정 리스트에 넣거나(list_id) 미분류로 뺀다(list_id=null).",
  scope: "memory",
  input: projectSetListV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/list"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { id: parseId(req.params?.id), list_id: parseListIdOrNull(b.list_id) };
      } }],
  },
  handler: async (input: ProjectSetListV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    // 이동은 **양쪽**을 본다(#1291) — 원 프로젝트가 보여야 하고, 넣으려는 리스트도 보여야 한다.
    //  대상 검사가 없으면 잠긴 리스트로 밀어 넣어 남에게서 감추거나, 반대로 미분류(list_id=null)로 빼내
    //  잠긴 프로젝트를 한 번에 전원 공개로 만들 수 있다.
    await assertProjectVisibleForMove(input.id, ctx);
    if (input.list_id != null) await assertListVisible(input.list_id, ctx);
    const prevListId = await getProjectListId(input.id).catch(() => null);
    try {
      const list_id = await setProjectListForProject(input.id, input.list_id ?? null, writeCtxOf(user, ctx));
      // 셸 경로(OS ACL)는 폴더에 붙어 있으므로 **이동하면 따라가야 한다** — 잠긴 리스트에서 빼내면 ACL 을 풀고,
      //  잠긴 리스트로 넣으면 걸어야 한다. 안 하면 잠금이 이동 한 번으로 무력화되거나(전자) 대상자가 못 읽는다(후자).
      invalidateVisibilityCache();
      if (prevListId != null) await syncFolderAcls(prevListId);
      if (list_id != null && list_id !== prevListId) await syncFolderAcls(Number(list_id));
      return { id: input.id, list_id };
    } catch (e: any) {
      if (/없음/.test(String(e?.message ?? ""))) throw new HttpError(404, e.message);
      throw e;
    }
  },
};

// ── 리스트 목록 UI 커스텀(settings JSONB 얕은 병합) — 기본 보기·표시필드 등 프리퍼런스(#475). ──
const projectListSetSettingsV6Input = { id: z.number().int().positive(), settings: z.record(z.unknown()) };
type ProjectListSetSettingsV6Input = z.infer<z.ZodObject<typeof projectListSetSettingsV6Input>>;
const projectListSetSettingsV6: Capability = {
  name: "project_list_set_settings_v6",
  title: "리스트 목록 UI 설정(v6)",
  description: "리스트의 목록 UI 커스텀 설정(settings)을 얕은 병합으로 갱신한다. 준 키만 덮어쓰고 나머지는 보존, null 값은 키 삭제.",
  scope: "memory",
  input: projectListSetSettingsV6Input,
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
  handler: async (input: ProjectListSetSettingsV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertListVisible(input.id, ctx);
    if (!(await getProjectListRow(input.id))) throw new HttpError(404, `리스트 #${input.id} 없음`);
    const list = await setProjectListSettings(input.id, input.settings, writeCtxOf(user, ctx));
    return { list };
  },
};

// ── 리스트 스코프 ClickUp 커스텀필드 컬럼(#541) — 이관 정의를 리스트 뷰 컬럼으로(값·프로젝트별 내부 id 맵 동봉). ──
const projectListClickupFieldsV6Input = { id: z.number().int().positive() };
type ProjectListClickupFieldsV6Input = z.infer<z.ZodObject<typeof projectListClickupFieldsV6Input>>;
const projectListClickupFieldsV6: Capability = {
  name: "project_list_clickup_fields_v6",
  title: "리스트 ClickUp 필드 컬럼(v6)",
  description: "리스트에 이관된 ClickUp 커스텀필드 정의(external dedup)·프로젝트별 값·편집용 내부 field id 맵을 돌려준다. 보드 리스트 뷰 컬럼 전용.",
  scope: "memory",
  input: projectListClickupFieldsV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/project-lists/:id/clickup-fields"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: ProjectListClickupFieldsV6Input, _user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertListVisible(input.id, ctx);
    if (!(await getProjectListRow(input.id))) throw new HttpError(404, `리스트 #${input.id} 없음`);
    return await getListClickupFields(input.id);
  },
};

// ── 리스트 재정렬(#541 사이드바) — 같은 폴더의 형제 리스트 id 배열 순서대로 sort 재부여. 웹 드래그 전용. ──
const projectListReorderV6Input = { ids: z.array(z.number().int().positive()).min(2).max(500) };
type ProjectListReorderV6Input = z.infer<z.ZodObject<typeof projectListReorderV6Input>>;
const projectListReorderV6: Capability = {
  name: "project_list_reorder_v6",
  title: "리스트 순서 변경(v6)",
  description: "리스트의 사이드바 표시 순서를 주어진 id 배열 순서대로 저장한다(sort 를 1,2,… 로 재부여). 사이드바 드래그 재정렬용.",
  scope: "memory",
  input: projectListReorderV6Input,
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
  handler: async (input: ProjectListReorderV6Input) => await reorderProjectLists(input.ids),
};

export const listV6Capabilities: Capability[] = [
  projectListSetTeamsV6,
  projectListIndexV6, projectListCreateV6, projectListUpdateV6, projectListDeleteV6,
  projectListSetMembersV6, projectSetListV6, projectListSetSettingsV6, projectListClickupFieldsV6, projectListReorderV6,
];
