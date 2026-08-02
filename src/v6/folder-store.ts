// v6 project_folder 데이터 접근 — 폴더(클릭업 Folder). '리스트'(project_list) 위의 순수 정리용 상위 층(#475).
//  3단계 = 폴더 › 리스트 › 프로젝트. 폴더는 멤버·권한 없이 정리용만 — 멤버·visibility·목록 UI 는 리스트가 담당.
//  네이티브 전용(외부 PM 미러 없음). 감사 org_content_audit(entity='project_folder'). 리스트의 folder_id 변경은 entity='project_list', op='set_folder'.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { auditOrgContent, type WriteCtx } from "./content-audit.js";
import { visibleListIds, visibleFolderIds, listIdPredicate, type Viewer } from "./visibility.js";

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
  visibility?: string;  // #1291 'open'(기본)|'members'. 스페이스 단위 공개범위 — 하위 리스트가 상속(AND).
}

const auditFolder = (key: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("project_folder", key, op, before, after, ctx);

// 스페이스 판정 — 네이티브(settings.kind='space', #766) 또는 커넥터 미러(external_id='space:…', #541).
//  프론트 isSpace 헬퍼와 동형: 최상위 컨테이너 전용(스페이스는 부모를 갖지 않는다).
export function folderIsSpace(row: Pick<ProjectFolderRow, "external_id" | "settings">): boolean {
  return (typeof row.external_id === "string" && row.external_id.startsWith("space:"))
    || (!!row.settings && (row.settings as Record<string, unknown>).kind === "space");
}

// 아카이브 폴더 판정(#1067) — 사이드바 맨 아래 고정 폴더(settings.kind='archive'). 조직당 하나만 쓰되(프론트가 최소 id 채택),
//  스키마는 그대로 — 스페이스 표식(kind='space')과 같은 자리에 다른 값을 넣는 방식. 아카이브는 최상위 전용이고,
//  '지난 것을 치워두는 곳'이라 예외적으로 스페이스도 하위로 받는다(복원 = parent_id=null 로 다시 최상위 스페이스).
export function folderIsArchive(row: Pick<ProjectFolderRow, "settings">): boolean {
  return !!row.settings && (row.settings as Record<string, unknown>).kind === "archive";
}

// candidate 가 ancestorId 자신이거나 그 자손인지 — parent_id 부모 체인을 위로 훑어 확인(사이클 방지, #766).
async function folderIsSelfOrDescendant(ancestorId: number, candidateId: number): Promise<boolean> {
  let cur: number | null = candidateId;
  const seen = new Set<number>();
  while (cur != null) {
    if (cur === ancestorId) return true;
    if (seen.has(cur)) break; // 방어 — 기존 데이터에 사이클이 있어도 무한루프 금지
    seen.add(cur);
    const row: { parent_id: number | null } | undefined = await one(itemsPool,
      `SELECT parent_id FROM project_folder WHERE id=$1`, [cur]);
    cur = row?.parent_id ?? null;
  }
  return false;
}

// ── 조회 ──────────────────────────────────────────────────────────────────
// 모든 폴더 + 리스트 수. 사이드바가 소비. 정렬: sort → ClickUp orderindex(커넥터 미러 — 스페이스는 나열 위치) → 이름.
//  viewer(#1291): 폴더 자체가 대상 제한이면 비대상에게 숨기고, **list_count 도 보이는 리스트만 센다** —
//  숨긴 리스트까지 세면 "이 폴더 안에 뭔가 3개 있다"는 사실이 그대로 새어나간다(껍데기 노출의 실체).
//  또한 리스트가 있는데 하나도 안 보이는 폴더는 빈 껍데기로 남기지 않고 목록에서 뺀다.
export async function listProjectFolders(viewer?: Viewer): Promise<ProjectFolderRow[]> {
  const visIds = viewer === undefined || viewer === null ? null : await visibleListIds(viewer);
  const countSql = visIds === null
    ? `(SELECT count(*)::int FROM project_list pl WHERE pl.folder_id=pf.id)`
    : `(SELECT count(*)::int FROM project_list pl WHERE pl.folder_id=pf.id AND ${listIdPredicate("pl.id", visIds)})`;
  const rows = await q(itemsPool,
    `SELECT pf.id, pf.name, pf.color, pf.sort, pf.created_by, pf.created_at, pf.updated_at,
       pf.parent_id, pf.settings, pf.external_id, COALESCE(pf.visibility, 'open') AS visibility,
       ${countSql} AS list_count,
       (SELECT count(*)::int FROM project_list pl WHERE pl.folder_id=pf.id) AS list_total
     FROM project_folder pf
     ORDER BY pf.sort,
       CASE WHEN pf.settings->'clickup'->>'orderindex' ~ '^-?[0-9.]+$' THEN (pf.settings->'clickup'->>'orderindex')::float8 END NULLS LAST,
       lower(pf.name)`, []);
  if (visIds === null) return rows as ProjectFolderRow[];
  // 폴더 자체가 대상 제한이면 그 대상만 본다. 하위가 전부 가려진 폴더도 함께 숨긴다 —
  //  "리스트만 비공개면 폴더가 껍데기로 보인다"는 원래 문제를 여기서 닫는다(하위가 애초에 없던 빈 폴더는 그대로 둔다).
  const allowed = await visibleFolderIds(viewer as string);   // 자기 자신 + 조상 체인 판정(visibility.ts)
  return (rows as (ProjectFolderRow & { list_total?: number })[])
    .filter((f) => !allowed || allowed.has(Number(f.id)))
    .filter((f) => !(Number(f.list_total ?? 0) > 0 && Number(f.list_count ?? 0) === 0))
    .map(({ list_total: _t, ...rest }) => rest as ProjectFolderRow);
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
       pf.parent_id, pf.settings, pf.external_id, COALESCE(pf.visibility, 'open') AS visibility,
       (SELECT count(*)::int FROM project_list pl WHERE pl.folder_id=pf.id) AS list_count
     FROM project_folder pf WHERE pf.id=$1`, [id]);
}

// 폴더(스페이스) 대상 교체 — 리스트 멤버와 같은 계약(전체 교체·한 트랜잭션).
//  교체 도중 죽으면 그 스페이스를 아무도 못 보는 상태로 남으므로 원자적으로 처리한다.
export async function setProjectFolderMembers(folderId: number, memberIds: string[], ctx?: WriteCtx): Promise<string[]> {
  const before = await getProjectFolderRow(folderId);
  if (!before) throw new Error(`폴더 #${folderId} 없음`);
  const ids: string[] = [];
  const seen = new Set<string>();
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM project_folder_member WHERE folder_id=$1 AND subject_kind='member'`, [folderId]);
    for (const raw of memberIds) {
      const m = String(raw).trim();
      if (!m || seen.has(m)) continue;
      seen.add(m);
      await client.query(
        `INSERT INTO project_folder_member(folder_id, subject_kind, member_id) VALUES($1,'member',$2)`, [folderId, m]);
      ids.push(m);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
  await auditFolder(String(folderId), "set_members", null, { members: ids }, ctx);
  return ids;
}

// 폴더 대상 목록(표시명 포함) — 설정 폼이 소비.
export async function getProjectFolderMembers(folderId: number): Promise<{ member_id: string; display_name: string | null }[]> {
  return q(itemsPool,
    `SELECT pfm.member_id, m.display_name FROM project_folder_member pfm
       LEFT JOIN org_member m ON m.id=pfm.member_id
      WHERE pfm.folder_id=$1 AND pfm.subject_kind='member' ORDER BY pfm.member_id`, [folderId]);
}

// ── 쓰기 ──────────────────────────────────────────────────────────────────
export async function createProjectFolder(
  input: { name: string; color?: string | null; parent_id?: number | null; kind?: string | null },
  ctx?: WriteCtx,
): Promise<ProjectFolderRow> {
  // #766 네이티브 스페이스/중첩: kind='space' 면 settings.kind='space' 로 표식(스키마 무변). 스페이스는 최상위 전용(부모 무시).
  //  #1067 kind='archive' 도 같은 자리 표식 — 사이드바 고정 아카이브 폴더. 스페이스와 마찬가지로 최상위 전용.
  //  일반 폴더는 parent_id(스페이스/폴더) 하위로 둘 수 있다. 부모는 실재해야 한다.
  const isSpace = input.kind === "space";
  const isArchive = input.kind === "archive";
  const parentId = (isSpace || isArchive) ? null : (input.parent_id ?? null);
  if (parentId != null && !(await getProjectFolderRow(parentId))) throw new Error(`상위 폴더 #${parentId} 없음`);
  const settings = isSpace ? '{"kind":"space"}' : (isArchive ? '{"kind":"archive"}' : "{}");
  // 신규 폴더는 맨 뒤로(기존 최대 sort + 1) — 생성 순서 보존, 추후 재정렬 가능.
  const row: { id: number } = await one(itemsPool,
    `INSERT INTO project_folder(name, color, sort, parent_id, settings, created_by, created_at, updated_at)
     VALUES($1,$2,(SELECT COALESCE(MAX(sort),0)+1 FROM project_folder),$3,$4::jsonb,$5,now(),now()) RETURNING id`,
    [input.name, input.color ?? null, parentId, settings, ctx?.actor ?? null]);
  const created = await getProjectFolderRow(row.id);
  await auditFolder(String(row.id), "insert", null, created, ctx);
  return created!;
}

// 이름·색·정렬·상위(parent_id) 수정 — 주어진 키만 변경(부재=무변경).
export async function updateProjectFolder(
  id: number,
  patch: Partial<{ name: string; color: string | null; sort: number; parent_id: number | null; visibility: string; members: string[] }>,
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
  // 공개범위(#1291) — 스페이스에 걸면 하위 리스트가 모두 상속한다(단조 축소: 하위가 더 넓어질 수는 없다).
  //  'members' 외 값은 전부 'open' 으로 정규화 — 두 술어가 비정규 값에 서로 다르게 반응하는 걸 막는다.
  if (patch.visibility !== undefined) set("visibility", patch.visibility === "members" ? "members" : "open");
  // #766 이동(중첩): 스페이스로 끌어넣기/빼기. 스페이스 자신은 최상위 유지, 자기·자손을 부모로 삼는 순환 금지.
  if (patch.parent_id !== undefined) {
    const target = patch.parent_id;
    if (target != null) {
      // 메시지에 wrap() 인식 토큰(허용/없음)을 포함해야 사용자에게 400 으로 노출된다(rest-util.ts) — 아니면 internal_error.
      if (folderIsArchive(before)) throw new Error("아카이브 폴더는 최상위 고정입니다 (다른 폴더 하위로 이동 불가)");
      const targetRow = await getProjectFolderRow(target);
      if (!targetRow) throw new Error(`상위 폴더 #${target} 없음`);
      // #1067 스페이스는 여전히 최상위 전용 — 단 '아카이브에 치워두기'만 예외로 허용(복원 = parent_id=null).
      if (folderIsSpace(before) && !folderIsArchive(targetRow)) throw new Error("스페이스는 최상위만 허용됩니다 (아카이브 폴더 외의 폴더/스페이스 하위로 이동 불가)");
      if (await folderIsSelfOrDescendant(id, target)) throw new Error("자기 자신·하위 폴더를 상위로 두는 순환은 허용되지 않습니다");
    }
    set("parent_id", target);
  }
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
