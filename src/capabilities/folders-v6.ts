// v6 project_folder capability — 폴더(클릭업 Folder) CRUD + 리스트 소속. '리스트'(project_list) 위의 정리용 상위 층(#475).
//  3단계 = 폴더 › 리스트 › 프로젝트. 폴더는 멤버·권한 없이 정리용만(멤버·visibility·목록 UI 는 리스트).
//  네이티브 전용(외부 PM 미러 없음). scope='memory'(조직 공유). 경로 prefix=/api/ui/v6/project-folders + 리스트 소속은 /project-lists/:id/folder.
import { z } from "zod";
import { HttpError, parseId } from "./rest-util.js";
import type { Capability } from "./types.js";
import {
  listProjectFolders, createProjectFolder, updateProjectFolder, deleteProjectFolder,
  setFolderForList, getProjectFolderRow, reorderProjectFolders, setProjectFolderMembers, getProjectFolderMembers,
} from "../v6/folder-store.js";
import { invalidateVisibilityCache } from "../v6/visibility.js";
import { syncFolderAclsUnderFolder } from "../v6/folder-acl-sync.js";
import { getProjectListRow } from "../v6/list-store.js";

function parseColorOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > 32) throw new HttpError(400, "color 가 너무 깁니다");
  return s;
}
// folder_id 본문 파서 — null/빈값=미분류(해제), 그 외=양의 정수.
function parseFolderIdOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "folder_id 는 양의 정수 또는 null 이어야 합니다");
  return n;
}

const writeCtxOf = (user: any, ctx: any) => ({ actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" });

// ── 폴더 목록 ──
const projectFolderIndexV6: Capability = {
  name: "project_folder_index_v6",
  title: "프로젝트 폴더 목록(v6)",
  description: "폴더(정리용 상위 층) 전체 + 각 폴더의 리스트 수를 돌려준다. 사이드바 폴더›리스트 그룹핑 전용(#475).",
  scope: "memory",
  input: {},
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/project-folders"], parse: () => ({}) }],
  },
  handler: async (_input: any, _user: any, ctx: any) => {
    const folders = await listProjectFolders(ctx?.viewer ?? null);
    // 공개범위가 걸린 폴더만 대상 목록을 동봉한다(설정 폼이 현재 값을 그려야 한다). open 이면 조회 자체를 생략.
    const withMembers = await Promise.all(folders.map(async (f) =>
      f.visibility === "members" ? { ...f, members: await getProjectFolderMembers(f.id) } : f));
    return { folders: withMembers };
  },
};

// ── 폴더 생성 ──
const projectFolderCreateV6: Capability = {
  name: "project_folder_create_v6",
  title: "프로젝트 폴더 생성(v6)",
  description: "폴더(정리용 상위 층)를 만든다. 폴더는 멤버·권한 없이 리스트를 담아 정리만 한다. "
    + "kind='space' 면 최상위 스페이스로 생성(#766). kind='archive' 면 사이드바 고정 '아카이브' 폴더로 생성(#1067 — 지난 리스트·폴더·프로젝트를 치워두는 곳, 조직당 하나). "
    + "parent_id 를 주면 그 스페이스/폴더 하위에 중첩 생성(스페이스·아카이브는 최상위 전용이라 parent_id 무시).",
  scope: "memory",
  input: {
    name: z.string().min(1).max(120),
    color: z.string().max(32).nullable().optional(),
    parent_id: z.number().int().positive().nullable().optional(),
    kind: z.enum(["space", "folder", "archive"]).optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/project-folders"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? "").trim();
        if (!name) throw new HttpError(400, "name 이 필요합니다");
        if (name.length > 120) throw new HttpError(400, "name 이 너무 깁니다(최대 120자)");
        let parentId: number | null = null;
        if (b.parent_id != null) parentId = parseId(b.parent_id, "parent_id"); // 문구 동일("parent_id 가 올바르지 않습니다")
        const kind = b.kind === "space" ? "space" : (b.kind === "archive" ? "archive" : undefined);
        return { name, color: parseColorOrNull(b.color), parent_id: parentId, kind };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const folder = await createProjectFolder(input, writeCtxOf(user, ctx));
    return { folder };
  },
};

// ── 폴더 수정(이름·색·정렬) ──
const projectFolderUpdateV6: Capability = {
  name: "project_folder_update_v6",
  title: "프로젝트 폴더 수정(v6)",
  description: "폴더의 이름·색·정렬·상위(parent_id)를 수정한다(주어진 키만 변경). "
    + "parent_id=<스페이스/폴더 id> 로 이동(중첩), null 로 최상위 이동(#766). 스페이스는 최상위 전용, 순환 금지.",
  scope: "memory",
  input: {
    id: z.number().int().positive(),
    name: z.string().min(1).max(120).optional(),
    color: z.string().max(32).nullable().optional(),
    sort: z.number().int().optional(),
    parent_id: z.number().int().positive().nullable().optional(),
    // #1291 스페이스 공개범위 — 'members' 면 아래 members 대상만 보고, 하위 리스트도 그 범위를 상속한다.
    visibility: z.enum(["open", "members"]).optional(),
    members: z.array(z.string()).max(500).optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/project-folders/:id"],
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
        if ("visibility" in b) patch.visibility = String(b.visibility) === "members" ? "members" : "open";
        if ("members" in b) patch.members = Array.isArray(b.members) ? b.members.map((x) => String(x)) : [];
        if ("parent_id" in b) {
          if (b.parent_id == null) patch.parent_id = null;
          else patch.parent_id = parseId(b.parent_id, "parent_id");
        }
        return patch;
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const { id, members, ...patch } = input;
    // 공개범위를 걸거나 대상을 바꾸는 건 그 스페이스가 보이는 사람만(#1291) — 아니면 남의 스페이스를 잠가 뺏을 수 있다.
    if ((patch.visibility !== undefined || members !== undefined) && ctx?.viewer != null) {
      const visible = await listProjectFolders(ctx.viewer);
      if (!visible.some((f) => Number(f.id) === Number(id))) throw new HttpError(404, `폴더 #${id} 없음`);
    }
    const folder = await updateProjectFolder(id, patch, writeCtxOf(user, ctx));
    if (members !== undefined) await setProjectFolderMembers(id, members, writeCtxOf(user, ctx));
    // 공개범위·대상이 바뀌면 세션 목록 등이 쓰는 판정 캐시를 즉시 버린다(회수가 늦게 반영되지 않게).
    //  셸 경로(OS ACL)도 같이 따라가야 한다 — 스페이스를 잠그면 그 아래 리스트의 프로젝트 폴더가 전부 영향받는데,
    //  API 만 막고 ACL 을 안 건드리면 세션 안에서 `cat` 한 줄로 그대로 읽힌다(리스트 잠금은 이미 그렇게 한다).
    if (patch.visibility !== undefined || members !== undefined) {
      invalidateVisibilityCache();
      await syncFolderAclsUnderFolder(Number(id));
    }
    return { folder };
  },
};

// ── 폴더 삭제 — 소속 리스트는 보존(folder_id SET NULL → 미분류 폴더). ──
const projectFolderDeleteV6: Capability = {
  name: "project_folder_delete_v6",
  title: "프로젝트 폴더 삭제(v6)",
  description: "폴더를 삭제한다. 소속 리스트는 사라지지 않고 '미분류 폴더'로 이동(folder_id 해제).",
  scope: "memory",
  input: { id: z.number().int().positive() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/project-folders/:id/delete"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const before = await getProjectFolderRow(input.id);
    if (!before) throw new HttpError(404, `폴더 #${input.id} 없음`);
    const folder = await deleteProjectFolder(input.id, writeCtxOf(user, ctx));
    return { deleted: true, id: input.id, folder };
  },
};

// ── 리스트의 폴더 소속 설정 — folder_id=null 이면 미분류 폴더로. ──
const projectListSetFolderV6: Capability = {
  name: "project_list_set_folder_v6",
  title: "리스트 폴더 소속 설정(v6)",
  description: "리스트(project_list)를 특정 폴더에 넣거나(folder_id) 미분류 폴더로 뺀다(folder_id=null).",
  scope: "memory",
  input: { id: z.number().int().positive(), folder_id: z.number().int().positive().nullable() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/project-lists/:id/folder"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { id: parseId(req.params?.id), folder_id: parseFolderIdOrNull(b.folder_id) };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    try {
      if (!(await getProjectListRow(input.id))) throw new HttpError(404, `리스트 #${input.id} 없음`);
      const folder_id = await setFolderForList(input.id, input.folder_id ?? null, writeCtxOf(user, ctx));
      return { id: input.id, folder_id };
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      if (/없음/.test(String(e?.message ?? ""))) throw new HttpError(404, e.message);
      throw e;
    }
  },
};

// ── 폴더/스페이스 재정렬(#541 사이드바) — 형제(같은 parent) id 배열 순서대로 sort 재부여. 웹 드래그 전용. ──
const projectFolderReorderV6: Capability = {
  name: "project_folder_reorder_v6",
  title: "폴더 순서 변경(v6)",
  description: "폴더/스페이스의 사이드바 표시 순서를 주어진 id 배열 순서대로 저장한다(sort 를 1,2,… 로 재부여). 사이드바 드래그 재정렬용.",
  scope: "memory",
  input: { ids: z.array(z.number().int().positive()).min(2).max(500) },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/project-folders-reorder"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const ids = Array.isArray(b.ids) ? b.ids.map((x) => parseId(x)) : [];
        if (ids.length < 2) throw new HttpError(400, "ids 는 2개 이상이어야 합니다");
        return { ids };
      } }],
  },
  handler: async (input: any) => await reorderProjectFolders(input.ids),
};

export const folderV6Capabilities: Capability[] = [
  projectFolderIndexV6, projectFolderCreateV6, projectFolderUpdateV6, projectFolderDeleteV6,
  projectListSetFolderV6, projectFolderReorderV6,
];
