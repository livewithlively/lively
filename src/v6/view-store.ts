// v6 project_view 데이터 접근 — 리스트/폴더 스코프 저장 뷰(#541). ClickUp View 이관(external_*) + 향후 로컬 뷰.
//  config JSONB = { columns, grouping, sorting, filters, settings, ... } — ClickUp View shape 원형 보존(schema §6f).
//  현재 읽기 전용(이관 뷰 노출·보드 '뷰' 피커) — 로컬 뷰 CRUD 는 후속.
import { itemsPool } from "../items/store.js";
import { q } from "../domainmap/db.js";

export interface ProjectViewRow {
  id: number;
  list_id: number | null;
  folder_id: number | null;
  name: string;
  type: string; // list|board|calendar|gantt|table|... (ClickUp view type 그대로)
  config: Record<string, unknown>;
  sort: number;
  created_by: string | null;
  external_system: string | null;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

// 뷰 목록 — list_id/folder_id 스코프 필터(둘 다 없으면 전체). 정렬: sort, 이름.
export async function listProjectViews(opts?: { listId?: number; folderId?: number }): Promise<ProjectViewRow[]> {
  const conds: string[] = [];
  const vals: unknown[] = [];
  if (opts?.listId != null) { vals.push(opts.listId); conds.push(`pv.list_id=$${vals.length}`); }
  if (opts?.folderId != null) { vals.push(opts.folderId); conds.push(`pv.folder_id=$${vals.length}`); }
  const where = conds.length ? `WHERE ${conds.join(" OR ")}` : "";
  return q(itemsPool,
    `SELECT pv.id, pv.list_id, pv.folder_id, pv.name, pv.type, pv.config, pv.sort, pv.created_by,
            pv.external_system, pv.external_id, pv.created_at, pv.updated_at
       FROM project_view pv ${where}
      ORDER BY pv.sort, lower(pv.name)`, vals);
}
