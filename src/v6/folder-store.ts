// v6 project_folder 데이터 접근 — 폴더(클릭업 Folder). '리스트'(project_list) 위의 순수 정리용 상위 층(#475).
//  3단계 = 폴더 › 리스트 › 프로젝트. 폴더는 멤버·권한 없이 정리용만 — 멤버·visibility·목록 UI 는 리스트가 담당.
//  네이티브 전용(외부 PM 미러 없음). 감사 org_content_audit(entity='project_folder'). 리스트의 folder_id 변경은 entity='project_list', op='set_folder'.
import { itemsPool } from "../items/store.js";
import { q, one } from "../domainmap/db.js";
import { auditOrgContent, type WriteCtx } from "../db/write.js";

export interface ProjectFolderRow {
  id: number;
  name: string;
  color: string | null;
  sort: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  list_count: number;   // 이 폴더에 속한 리스트(project_list) 수.
  parent_id: number | null; // 중첩(#541) — ClickUp Space=최상위(NULL)›Folder=하위. 네이티브 폴더는 NULL(평탄 하위호환).
  settings: Record<string, unknown> | null; // 원본 메타 백스톱(#541 — clickup 스페이스/폴더 메타).
  external_id: string | null; // 커넥터 좌표(#541) — 'space:<id>'|'folder:<id>'. 프론트가 Space 를 구분 스타일로 렌더.
}

const auditFolder = (key: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("project_folder", key, op, before, after, ctx);

// ── 조회 ──────────────────────────────────────────────────────────────────
// 모든 폴더 + 리스트 수. 사이드바가 소비. 정렬: sort → ClickUp orderindex(커넥터 미러 — 스페이스는 나열 위치) → 이름.
export async function listProjectFolders(): Promise<ProjectFolderRow[]> {
  return q(itemsPool,
    `SELECT pf.id, pf.name, pf.color, pf.sort, pf.created_by, pf.created_at, pf.updated_at,
       pf.parent_id, pf.settings, pf.external_id,
       (SELECT count(*)::int FROM project_list pl WHERE pl.folder_id=pf.id) AS list_count
     FROM project_folder pf
     ORDER BY pf.sort,
       CASE WHEN pf.settings->'clickup'->>'orderindex' ~ '^-?[0-9.]+$' THEN (pf.settings->'clickup'->>'orderindex')::float8 END NULLS LAST,
       lower(pf.name)`, []);
}

// 폴더/스페이스 재정렬(#541 사이드바) — 주어진 순서대로 sort=1,2,… 재부여(0=미지정 기본과 구분).
//  스페이스(parent_id NULL)와 폴더(같은 parent)는 같은 테이블 — 프론트가 형제끼리만 넘긴다.
export async function reorderProjectFolders(ids: number[]): Promise<{ updated: number }> {
  const clean = (ids || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
  if (clean.length < 2) return { updated: 0 };
  const tuples = clean.map((_id, i) => `($${i + 1}::int, ${i + 1}::int)`).join(", ");
  const res = await itemsPool.query(
    `UPDATE project_folder AS pf SET sort = v.sort FROM (VALUES ${tuples}) AS v(id, sort) WHERE pf.id = v.id`, clean);
  return { updated: res.rowCount || 0 };
}

// 폴더 1건 — 존재 확인·소유권 조회용. 없으면 undefined.
export async function getProjectFolderRow(id: number): Promise<ProjectFolderRow | undefined> {
  return one(itemsPool,
    `SELECT pf.id, pf.name, pf.color, pf.sort, pf.created_by, pf.created_at, pf.updated_at,
       pf.parent_id, pf.settings, pf.external_id,
       (SELECT count(*)::int FROM project_list pl WHERE pl.folder_id=pf.id) AS list_count
     FROM project_folder pf WHERE pf.id=$1`, [id]);
}

// ── 쓰기 ──────────────────────────────────────────────────────────────────
export async function createProjectFolder(
  input: { name: string; color?: string | null },
  ctx?: WriteCtx,
): Promise<ProjectFolderRow> {
  // 신규 폴더는 맨 뒤로(기존 최대 sort + 1) — 생성 순서 보존, 추후 재정렬 가능.
  const row: { id: number } = await one(itemsPool,
    `INSERT INTO project_folder(name, color, sort, created_by, created_at, updated_at)
     VALUES($1,$2,(SELECT COALESCE(MAX(sort),0)+1 FROM project_folder),$3,now(),now()) RETURNING id`,
    [input.name, input.color ?? null, ctx?.actor ?? null]);
  const created = await getProjectFolderRow(row.id);
  await auditFolder(String(row.id), "insert", null, created, ctx);
  return created!;
}

// 이름·색·정렬 수정 — 주어진 키만 변경(부재=무변경).
export async function updateProjectFolder(
  id: number,
  patch: Partial<{ name: string; color: string | null; sort: number }>,
  ctx?: WriteCtx,
): Promise<ProjectFolderRow> {
  const before = await getProjectFolderRow(id);
  if (!before) throw new Error(`폴더 #${id} 없음`);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.color !== undefined) set("color", patch.color);
  if (patch.sort !== undefined) set("sort", patch.sort);
  if (sets.length) {
    sets.push("updated_at=now()");
    vals.push(id);
    await itemsPool.query(`UPDATE project_folder SET ${sets.join(", ")} WHERE id=$${vals.length}`, vals);
  }
  const after = await getProjectFolderRow(id);
  await auditFolder(String(id), "update", before, after, ctx);
  return after!;
}

// 폴더 삭제 — 소속 리스트의 folder_id 는 FK SET NULL(리스트 보존, 미분류 폴더로 이동).
export async function deleteProjectFolder(id: number, ctx?: WriteCtx): Promise<ProjectFolderRow> {
  const before = await getProjectFolderRow(id);
  if (!before) throw new Error(`폴더 #${id} 없음`);
  await itemsPool.query(`DELETE FROM project_folder WHERE id=$1`, [id]);
  await auditFolder(String(id), "delete", before, null, ctx);
  return before;
}

// 리스트(project_list)의 폴더 소속 설정 — folderId=null 이면 미분류 폴더로. 감사는 entity='project_list'(리스트 변경).
export async function setFolderForList(listId: number, folderId: number | null, ctx?: WriteCtx): Promise<number | null> {
  if (folderId != null) {
    const exists = await getProjectFolderRow(folderId);
    if (!exists) throw new Error(`폴더 #${folderId} 없음`);
  }
  const before: { folder_id: number | null } | undefined = await one(itemsPool,
    `SELECT folder_id FROM project_list WHERE id=$1`, [listId]);
  if (!before) throw new Error(`리스트 #${listId} 없음`);
  const after: { folder_id: number | null } = await one(itemsPool,
    `UPDATE project_list SET folder_id=$2, updated_at=now() WHERE id=$1 RETURNING folder_id`,
    [listId, folderId]);
  await auditOrgContent("project_list", String(listId), "set_folder", { folder_id: before.folder_id }, { folder_id: after.folder_id }, ctx);
  return after.folder_id;
}
