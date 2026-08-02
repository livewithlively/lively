// v6 project_view capability — 저장 뷰 조회(#541). ClickUp 이관 뷰(external_*) 노출 — 보드 '뷰' 피커가 소비.
//  로컬 뷰 생성/수정은 후속(현재 커넥터 미러가 유일한 쓰기 경로).
import { z } from "zod";
import { parseId } from "./rest-util.js";
import type { Capability } from "./types.js";
import { listProjectViews } from "../v6/view-store.js";

// 선택 id(미지정=undefined) — 정수 판정·문구는 rest-util 의 parseId 로 수렴(#1313 R46. 문구 `${label} 가 올바르지 않습니다` 동일).
function parseOptionalId(v: unknown, label: string): number | undefined {
  if (v == null || v === "") return undefined;
  return parseId(v, label);
}

const projectViewIndexV6: Capability = {
  name: "project_view_index_v6",
  title: "프로젝트 뷰 목록(v6)",
  description: "리스트/폴더 스코프의 저장 뷰(ClickUp 이관 포함)를 돌려준다. list_id/folder_id 필터(둘 다 없으면 전체).",
  scope: "memory",
  input: {
    list_id: z.number().int().positive().optional(),
    folder_id: z.number().int().positive().optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/project-views"],
      parse: (req) => ({
        list_id: parseOptionalId((req.query as Record<string, unknown>)?.list_id, "list_id"),
        folder_id: parseOptionalId((req.query as Record<string, unknown>)?.folder_id, "folder_id"),
      }) }],
  },
  handler: async (input: any, _user: any, ctx: any) => ({
    views: await listProjectViews({ viewer: ctx?.viewer ?? null, listId: input.list_id, folderId: input.folder_id }),
  }),
};

export const viewV6Capabilities: Capability[] = [projectViewIndexV6];
