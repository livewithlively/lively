// v6 project_list 데이터 접근 — 프로젝트 묶음(클릭업 List▸Task 의 List). level='project' 행을 0~1개 리스트로 그룹핑.
//  네이티브 전용 — 외부 PM(ClickUp) 미러 없음(우리 매핑은 단일 컨테이너 List 유지). 따라서 enqueueExternalPush 호출 없음.
//  리스트 멤버(project_list_member)는 웹 보드의 기본 펼침/접힘을 가르는 '참여자' — 프로젝트 팀원(project_member)과 직교.
//  감사 org_content_audit(entity='project_list', entity_key=id) — 프로젝트의 list_id 변경은 entity='project', op='set_list'.
import { itemsPool } from "../items/store.js";
import { q, one } from "../domainmap/db.js";
import { auditOrgContent, type WriteCtx } from "../db/write.js";

export interface ListMember { member_id: string; display_name: string | null }
export interface ProjectListRow {
  id: number;
  name: string;
  color: string | null;
  sort: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  members: ListMember[];     // 리스트 참여자(표시명 조인) — 보드 페이스파일·내 리스트 판정.
  project_count: number;     // 이 리스트에 속한 프로젝트(level='project') 수.
}

const auditList = (key: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("project_list", key, op, before, after, ctx);

// ── 조회 ──────────────────────────────────────────────────────────────────
// 모든 리스트 + 멤버(표시명) + 프로젝트 수. 보드/사이드바가 소비. 정렬: sort, 이름.
export async function listProjectLists(): Promise<ProjectListRow[]> {
  return q(itemsPool,
    `SELECT pl.id, pl.name, pl.color, pl.sort, pl.created_by, pl.created_at, pl.updated_at,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('member_id', plm.member_id, 'display_name', om.display_name) ORDER BY plm.sort, plm.member_id)
         FROM project_list_member plm LEFT JOIN org_member om ON om.id=plm.member_id WHERE plm.list_id=pl.id), '[]'::jsonb) AS members,
       (SELECT count(*)::int FROM project p WHERE p.list_id=pl.id AND p.level='project'
          AND p.folder IS DISTINCT FROM '__board_anchor__') AS project_count
     FROM project_list pl ORDER BY pl.sort, lower(pl.name)`, []);
}

// 리스트 1건(멤버 조인 없이) — 존재 확인·소유권 조회용. 없으면 undefined.
export async function getProjectListRow(id: number): Promise<{ id: number; name: string; color: string | null; sort: number; created_by: string | null } | undefined> {
  return one(itemsPool, `SELECT id, name, color, sort, created_by FROM project_list WHERE id=$1`, [id]);
}

// ── 쓰기 ──────────────────────────────────────────────────────────────────
export async function createProjectList(
  input: { name: string; color?: string | null; members?: string[] },
  ctx?: WriteCtx,
): Promise<ProjectListRow> {
  // 신규 리스트는 맨 뒤로(기존 최대 sort + 1) — 생성 순서 보존, 사용자가 추후 재정렬 가능.
  const row: { id: number } = await one(itemsPool,
    `INSERT INTO project_list(name, color, sort, created_by, created_at, updated_at)
     VALUES($1,$2,(SELECT COALESCE(MAX(sort),0)+1 FROM project_list),$3,now(),now()) RETURNING id`,
    [input.name, input.color ?? null, ctx?.actor ?? null]);
  // 멤버 초기 등록(중복 제거, 정렬 보존).
  const seen = new Set<string>();
  let sort = 0;
  for (const memberId of input.members ?? []) {
    const m = String(memberId).trim();
    if (!m || seen.has(m)) continue;
    seen.add(m);
    await itemsPool.query(
      `INSERT INTO project_list_member(list_id, member_id, role, sort, added_at)
       VALUES($1,$2,'member',$3,now()) ON CONFLICT (list_id, member_id) DO NOTHING`,
      [row.id, m, sort++]);
  }
  const created = await getListWithMembers(row.id);
  await auditList(String(row.id), "insert", null, created, ctx);
  return created!;
}

// 이름·색·정렬 수정 — 주어진 키만 변경(부재=무변경).
export async function updateProjectList(
  id: number,
  patch: Partial<{ name: string; color: string | null; sort: number }>,
  ctx?: WriteCtx,
): Promise<ProjectListRow> {
  const before = await getProjectListRow(id);
  if (!before) throw new Error(`리스트 #${id} 없음`);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.color !== undefined) set("color", patch.color);
  if (patch.sort !== undefined) set("sort", patch.sort);
  if (sets.length) {
    sets.push("updated_at=now()");
    vals.push(id);
    await itemsPool.query(`UPDATE project_list SET ${sets.join(", ")} WHERE id=$${vals.length}`, vals);
  }
  const after = await getListWithMembers(id);
  await auditList(String(id), "update", before, after, ctx);
  return after!;
}

// 리스트 삭제 — project_list_member 는 FK CASCADE, 소속 프로젝트의 list_id 는 FK SET NULL(프로젝트 보존, 미분류로 이동).
export async function deleteProjectList(id: number, ctx?: WriteCtx): Promise<ProjectListRow> {
  const before = await getListWithMembers(id);
  if (!before) throw new Error(`리스트 #${id} 없음`);
  await itemsPool.query(`DELETE FROM project_list WHERE id=$1`, [id]);
  await auditList(String(id), "delete", before, null, ctx);
  return before;
}

// 리스트 멤버 통째 교체(setProjectMembers 동형) — 준 목록이 최종 참여자 집합. 중복 제거·정렬 보존.
export async function setProjectListMembers(listId: number, memberIds: string[], ctx?: WriteCtx): Promise<string[]> {
  const existing = await getProjectListRow(listId);
  if (!existing) throw new Error(`리스트 #${listId} 없음`);
  const before = await q(itemsPool,
    `SELECT member_id FROM project_list_member WHERE list_id=$1 ORDER BY sort, member_id`, [listId]);
  await itemsPool.query(`DELETE FROM project_list_member WHERE list_id=$1`, [listId]);
  const seen = new Set<string>();
  const ids: string[] = [];
  let sort = 0;
  for (const memberId of memberIds) {
    const m = String(memberId).trim();
    if (!m || seen.has(m)) continue;
    seen.add(m);
    await itemsPool.query(
      `INSERT INTO project_list_member(list_id, member_id, role, sort, added_at) VALUES($1,$2,'member',$3,now())`,
      [listId, m, sort++]);
    ids.push(m);
  }
  await auditList(String(listId), "set_members", (before as Array<{ member_id: string }>).map((r) => r.member_id), ids, ctx);
  return ids;
}

// 프로젝트(level='project')의 리스트 소속 설정 — listId=null 이면 미분류로. 감사는 entity='project'(프로젝트 변경).
export async function setProjectListForProject(projectId: number, listId: number | null, ctx?: WriteCtx): Promise<number | null> {
  if (listId != null) {
    const exists = await getProjectListRow(listId);
    if (!exists) throw new Error(`리스트 #${listId} 없음`);
  }
  const before: { list_id: number | null } | undefined = await one(itemsPool,
    `SELECT list_id FROM project WHERE id=$1 AND level='project'`, [projectId]);
  if (!before) throw new Error(`프로젝트 #${projectId} 없음`);
  const after: { list_id: number | null } = await one(itemsPool,
    `UPDATE project SET list_id=$2, updated_at=now() WHERE id=$1 AND level='project' RETURNING list_id`,
    [projectId, listId]);
  await auditOrgContent("project", String(projectId), "set_list", { list_id: before.list_id }, { list_id: after.list_id }, ctx);
  return after.list_id;
}

// 리스트 1건 + 멤버(표시명) — 생성/수정 응답용(listProjectLists 와 동일 형상의 단건).
async function getListWithMembers(id: number): Promise<ProjectListRow | undefined> {
  return one(itemsPool,
    `SELECT pl.id, pl.name, pl.color, pl.sort, pl.created_by, pl.created_at, pl.updated_at,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('member_id', plm.member_id, 'display_name', om.display_name) ORDER BY plm.sort, plm.member_id)
         FROM project_list_member plm LEFT JOIN org_member om ON om.id=plm.member_id WHERE plm.list_id=pl.id), '[]'::jsonb) AS members,
       (SELECT count(*)::int FROM project p WHERE p.list_id=pl.id AND p.level='project'
          AND p.folder IS DISTINCT FROM '__board_anchor__') AS project_count
     FROM project_list pl WHERE pl.id=$1`, [id]);
}
