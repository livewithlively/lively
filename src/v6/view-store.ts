// v6 project_view 데이터 접근 — 리스트/폴더 스코프 저장 뷰(#541). ClickUp View 이관(external_*) + 향후 로컬 뷰.
//  config JSONB = { columns, grouping, sorting, filters, settings, ... } — ClickUp View shape 원형 보존(schema §6f).
//  현재 읽기 전용(이관 뷰 노출·보드 '뷰' 피커) — 로컬 뷰 CRUD 는 후속.
//  ⚠ 이름 주의: '뷰'를 다루는 store 가 둘이다. 지식(WIKI) 속성 노출 설정은 knowledge-view-config-store.ts —
//   무관한 테이블(knowledge_view_config)·무관한 표면이다. 여기는 프로젝트 뷰 전용.
import { itemsPool } from "../db/client.js";
import { q } from "../db/client.js";
import { visibleListIds, visibleFolderIds, listIdPredicate, type Viewer } from "./visibility.js";

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
export async function listProjectViews(opts?: { listId?: number; folderId?: number; viewer?: Viewer }): Promise<ProjectViewRow[]> {
  const conds: string[] = [];
  const vals: unknown[] = [];
  // ⚠ 두 스코프를 함께 주면 **교집합**이어야 한다 — 예전엔 OR 라 "리스트 A 의 뷰"를 물으면 폴더 B 의 뷰까지 섞여 나왔다.
  if (opts?.listId != null) { vals.push(opts.listId); conds.push(`pv.list_id=$${vals.length}`); }
  if (opts?.folderId != null) { vals.push(opts.folderId); conds.push(`pv.folder_id=$${vals.length}`); }
  // 공개범위(#1291) — 뷰의 config 에는 필터·표시필드가 담기고 이름 자체도 조직 맥락이다. 리스트 스코프 뷰는 그 리스트를,
  //  어느 컨테이너에도 매달리지 않은 고아 뷰(둘 다 NULL)는 **비특권에게 숨긴다**(판정 근거가 없으면 닫는 쪽이 안전).
  if (opts?.viewer !== undefined && opts.viewer !== null) {
    const [ids, folderIds] = await Promise.all([visibleListIds(opts.viewer), visibleFolderIds(opts.viewer)]);
    const folderOk = folderIds === null ? "TRUE"
      : (folderIds.size ? `pv.folder_id IN (${[...folderIds].join(",")})` : "FALSE");
    conds.push(`(pv.list_id IS NOT NULL AND ${listIdPredicate("pv.list_id", ids)})
      OR (pv.list_id IS NULL AND pv.folder_id IS NOT NULL AND ${folderOk})`);
  }
  const where = conds.length ? `WHERE ${conds.map((c) => `(${c})`).join(" AND ")}` : "";
  return q(itemsPool,
    `SELECT pv.id, pv.list_id, pv.folder_id, pv.name, pv.type, pv.config, pv.sort, pv.created_by,
            pv.external_system, pv.external_id, pv.created_at, pv.updated_at
       FROM project_view pv ${where}
      ORDER BY pv.sort, lower(pv.name)`, vals);
}
