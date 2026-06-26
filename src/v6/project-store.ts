// v6 project 데이터 접근 — 1급 엔티티 project▸task▸subtask(parent_id self-FK). 구 org_project + W ku 통합.
//  project = level='project'(팀원·카테고리·필요/산출지식 보유) | task/subtask = 하위 작업(구 W ku 대체).
//  itemsPool 직접 + q/one 헬퍼(domainmap/db) 재사용. 감사 org_content_audit(entity='project', entity_key=id).
import { itemsPool } from "../items/store.js";
import { q, one } from "../domainmap/db.js";
import { listProjectFields, getFieldValuesForTasks } from "./task-field-store.js";
import { getTaskTags, getTaskTime } from "./task-detail-store.js"; // 프로젝트 노드(project.id)도 같은 task_tag_link/task_time_entry 테이블 사용
import { auditOrgContent, restoreSnapshot, type WriteCtx } from "../db/write.js";

// project(=level='project') 본문 컬럼 — task/subtask 도 같은 테이블이라 level 로 구분.
const PROJECT_COLS =
  `id, level, parent_id, name, description, status, status_raw, status_category, folder, created_by,
   priority, assignee, start_date, due_date,
   external_system, external_instance, external_id, external_url,
   sort, created_at, updated_at, completed_at`;

export interface ProjectRow {
  id: number; level: string; parent_id: number | null;
  name: string; description: string | null; status: string;
  // status_raw = 소스 원문 상태명(개방 어휘, 네이티브는 NULL). status_category = 정규 카테고리(backlog|unstarted|started|done|canceled).
  status_raw: string | null; status_category: string | null;
  folder: string | null; created_by: string | null;
  // 태스크 필드(task/subtask 행만 채워짐; project 행은 NULL). 기간은 'YYYY-MM-DD' 문자열(schema.ts 참조).
  priority: string | null; assignee: string | null;
  start_date: string | null; due_date: string | null;
  external_system: string | null; external_instance: string | null;
  external_id: string | null; external_url: string | null;
  sort: number; created_at: string; updated_at: string; completed_at: string | null;
  members?: unknown[]; // listProjects 가 facepile 용으로 채움(상세 getProject 의 members 와 별개)
}

// append-only 감사(org_content_audit, entity='project') — 공유 헬퍼 위임.
const auditProject = (entityKey: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("project", entityKey, op, before, after, ctx);

// 네이티브 status → 정규 카테고리(크로스툴: backlog|unstarted|started|done|canceled).
//  외부 미러 행의 카테고리는 커넥터가 소스 상태에서 직접 정한다(여기는 네이티브 active/done/todo/in_progress 만).
export function categoryOf(status: string): string {
  switch (status) {
    case "done": return "done";
    case "in_progress": return "started";
    case "active": return "started";
    case "todo": return "unstarted";
    case "backlog": return "backlog";
    default: return "unstarted";
  }
}

// ── 조회 ──────────────────────────────────────────────────────────────────
export interface ProjectFilter { space?: string; categoryId?: number; status?: string; viewer?: string }

export async function listProjects(filter: ProjectFilter = {}): Promise<ProjectRow[]> {
  const params: unknown[] = [];
  let join = "";
  // 카테고리/스페이스 필터 = project_category 조인. categoryId 우선, 없으면 space 로 카테고리 조인.
  if (filter.categoryId != null) {
    params.push(filter.categoryId);
    join = `JOIN project_category pc ON pc.project_id=p.id AND pc.category_id=$${params.length}`;
  } else if (filter.space) {
    params.push(filter.space);
    join = `JOIN project_category pc ON pc.project_id=p.id
            JOIN category c ON c.id=pc.category_id AND c.space=$${params.length}`;
  }
  const wh: string[] = [`p.level='project'`];
  if (filter.status) { params.push(filter.status); wh.push(`p.status=$${params.length}`); }
  // viewer 지정(웹 '내 프로젝트') → 생성자이거나 팀원인 것만.
  if (filter.viewer) {
    params.push(filter.viewer);
    wh.push(`(p.created_by=$${params.length} OR EXISTS(SELECT 1 FROM project_member pmv WHERE pmv.project_id=p.id AND pmv.member_id=$${params.length}))`);
  }
  wh.push("p.folder IS DISTINCT FROM '__board_anchor__'"); // 보드 커스텀 컬럼 앵커(숨김 프로젝트) 제외
  const where = `WHERE ${wh.join(" AND ")}`;
  // DISTINCT — 다중 카테고리 매핑 시 조인 중복 제거. ORDER BY 컬럼은 SELECT DISTINCT 대상에 포함.
  //  members = facepile 용 스칼라 서브쿼리(org_member 표시명 조인, 정렬 보존).
  const cols = PROJECT_COLS.split(",").map((c) => "p." + c.trim()).join(", ");
  return q(itemsPool,
    `SELECT DISTINCT ${cols},
       COALESCE((SELECT jsonb_agg(jsonb_build_object('member_id', pm.member_id, 'display_name', m.display_name) ORDER BY pm.sort, pm.member_id)
         FROM project_member pm LEFT JOIN org_member m ON m.id=pm.member_id WHERE pm.project_id=p.id), '[]'::jsonb) AS members,
       (SELECT count(*) FROM project c WHERE c.parent_id=p.id AND c.level='task') AS task_count,
       (SELECT count(*) FROM project c WHERE c.parent_id=p.id AND c.level='task' AND c.status='done') AS task_done_count,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY lower(t.name))
         FROM task_tag_link l JOIN task_tag t ON t.id=l.tag_id WHERE l.task_id=p.id), '[]'::jsonb) AS tags
     FROM project p ${join} ${where} ORDER BY p.updated_at DESC`, params);
}

export interface ProjectDetail extends ProjectRow {
  members: unknown[];
  tasks: unknown[];
  categories: unknown[];
  knowledge: { required: unknown[]; produced: unknown[] };
  fields: unknown[]; // 커스텀 필드(클릭업형 컬럼) 정의 — 루트 프로젝트 단위. 값은 각 task 의 field_values 에.
  tags: unknown[]; // 프로젝트 자체 태그(클릭업식 메타) — task_tag_link 를 project.id 로 사용.
  time: unknown; // 프로젝트 시간추적 { entries, total_seconds, running } — task_time_entry 를 project.id 로 사용.
  repos: string[]; // 관련 레포 이름(project_repo) — AGENTS.md '관련 레포' + '내 컴퓨터에서 작업' 모달 기본값.
}

export async function getProject(id: number): Promise<ProjectDetail | undefined> {
  const project: ProjectRow | undefined = await one(itemsPool,
    `SELECT ${PROJECT_COLS} FROM project WHERE id=$1 AND level='project'`, [id]);
  if (!project) return undefined;

  // 팀원(project_member) — 표시명은 org_member, 상태메시지는 (프로젝트,사람) 단위(pm.status_message)로 읽는다.
  //  프로젝트1의 상태가 프로젝트2에 그대로 보이지 않게 — 전역(org_member.status_message)이 아니라 이 프로젝트 행의 값.
  const members = await q(itemsPool,
    `SELECT pm.member_id, pm.role, pm.sort, pm.added_at, m.display_name, pm.status_message
     FROM project_member pm LEFT JOIN org_member m ON m.id=pm.member_id
     WHERE pm.project_id=$1 ORDER BY pm.sort, pm.member_id`, [id]);

  // 작업 위계 — 2단계 페치: task(parent=project) → subtask(parent IN task ids). 중첩 배열로 조립.
  const taskRows: ProjectRow[] = await q(itemsPool,
    `SELECT ${PROJECT_COLS} FROM project WHERE parent_id=$1 AND level='task' ORDER BY sort, id`, [id]);
  const taskIds = taskRows.map((t) => t.id);
  let subtaskRows: ProjectRow[] = [];
  if (taskIds.length) {
    subtaskRows = await q(itemsPool,
      `SELECT ${PROJECT_COLS} FROM project WHERE parent_id=ANY($1) AND level='subtask' ORDER BY sort, id`, [taskIds]);
  }
  // 커스텀 필드(클릭업형 컬럼) — 정의는 루트 프로젝트 단위, 값은 (field,task) 단위. 한 번에 페치해 task 트리에 매핑(N+1 회피).
  const fields = await listProjectFields(id);
  const allTaskIds = [...taskIds, ...subtaskRows.map((s) => s.id)];
  const valueRows = fields.length && allTaskIds.length ? await getFieldValuesForTasks(allTaskIds) : [];
  const valuesByTask = new Map<number, Record<string, unknown>>();
  for (const r of valueRows) {
    let m = valuesByTask.get(r.task_id);
    if (!m) { m = {}; valuesByTask.set(r.task_id, m); }
    m[String(r.field_id)] = r.value;
  }
  // 태그 — 리스트뷰 행에 칩으로 표시(프론트가 최대 2 + "+N"). allTaskIds 한 번에 페치 후 매핑.
  const tagsByTask = new Map<number, unknown[]>();
  if (allTaskIds.length) {
    const tagRows = await q(itemsPool,
      `SELECT l.task_id, t.id, t.name, t.color FROM task_tag_link l JOIN task_tag t ON t.id=l.tag_id
       WHERE l.task_id = ANY($1) ORDER BY lower(t.name)`, [allTaskIds]);
    for (const r of tagRows as Array<{ task_id: number; id: number; name: string; color: string | null }>) {
      let a = tagsByTask.get(r.task_id); if (!a) { a = []; tagsByTask.set(r.task_id, a); }
      a.push({ id: r.id, name: r.name, color: r.color });
    }
  }
  const withValues = (row: ProjectRow) => ({ ...row, field_values: valuesByTask.get(row.id) ?? {}, tags: tagsByTask.get(row.id) ?? [] });

  const tasks = taskRows.map((t) => ({
    ...withValues(t),
    subtasks: subtaskRows.filter((s) => s.parent_id === t.id).map(withValues),
  }));

  // 카테고리(project_category JOIN category) — 사업/제품/시스템 탐색.
  const categories = await q(itemsPool,
    `SELECT pc.category_id, c.space, c.key, c.name
     FROM project_category pc JOIN category c ON c.id=pc.category_id
     WHERE pc.project_id=$1 ORDER BY c.space, c.key`, [id]);

  // 필요/산출 지식(project_knowledge JOIN knowledge) — relation 으로 분리.
  const kRows = await q(itemsPool,
    `SELECT pk.name, pk.relation, k.title, k.injection, k.provenance, k.lifecycle
     FROM project_knowledge pk JOIN knowledge k ON k.name=pk.name
     WHERE pk.project_id=$1 ORDER BY pk.relation, pk.name`, [id]);
  const knowledge = {
    required: kRows.filter((r) => r.relation === "required"),
    produced: kRows.filter((r) => r.relation === "produced"),
  };

  // 프로젝트 자체의 태그·시간추적(클릭업식 메타) — 태스크와 동일 테이블을 project.id 로 사용.
  const [tags, time] = await Promise.all([getTaskTags(id), getTaskTime(id)]);

  // 관련 레포(project_repo) — 레포 레지스트리 이름 배열(AGENTS.md '관련 레포' + 모달 기본값).
  const repoRows = await q(itemsPool, `SELECT repo FROM project_repo WHERE project_id=$1 ORDER BY sort, repo`, [id]);
  const repos = repoRows.map((r) => r.repo);

  return { ...project, members, tasks, categories, knowledge, fields, tags, time, repos };
}

// ── 프로젝트 쓰기 ─────────────────────────────────────────────────────────
export async function createProject(
  input: { name: string; description?: string; folder?: string; members?: string[] },
  ctx?: WriteCtx,
): Promise<ProjectRow> {
  // folder = 평범한 선택 컬럼값(물리 폴더 생성 없음). TODO: 필요 시 capability 계층에서 createProjectFolder 선행.
  const row: ProjectRow = await one(itemsPool,
    `INSERT INTO project(level, name, description, folder, created_by, status, status_category, created_at, updated_at)
     VALUES('project',$1,$2,$3,$4,'active','started',now(),now())
     RETURNING ${PROJECT_COLS}`,
    [input.name, input.description ?? null, input.folder ?? null, ctx?.actor ?? null]);
  // 팀원 초기 등록(project_member).
  for (const memberId of input.members ?? []) {
    await itemsPool.query(
      `INSERT INTO project_member(project_id, member_id, role, added_at)
       VALUES($1,$2,'member',now()) ON CONFLICT (project_id, member_id) DO NOTHING`,
      [row.id, memberId]);
  }
  await auditProject(String(row.id), "insert", null, row, ctx);
  return row;
}

// 프로젝트 본문 1행(자식·정션 조인 없이) — 소유권 확인 등 가벼운 조회용. 없으면 undefined.
export async function getProjectRow(id: number): Promise<ProjectRow | undefined> {
  return one(itemsPool, `SELECT ${PROJECT_COLS} FROM project WHERE id=$1 AND level='project'`, [id]);
}

// 팀원 게이트(상세/파일/세션/타임라인 접근) — 생성자이거나 project_member 인 사람만.
//  org/store.isProjectMember 와 동형이나 org_project 가 아닌 v6 project(level='project') 기준.
export async function isProjectMember(projectId: number, memberId: string): Promise<boolean> {
  if (!memberId) return false;
  const r = await itemsPool.query(
    `SELECT 1 FROM project p
      WHERE p.id=$1 AND p.level='project' AND (p.created_by=$2 OR EXISTS(
        SELECT 1 FROM project_member pm WHERE pm.project_id=p.id AND pm.member_id=$2)) LIMIT 1`,
    [projectId, memberId]);
  return (r.rowCount ?? 0) > 0;
}

// 내 상태 메시지(이 프로젝트 한정) 저장 — project_member.status_message 를 (project,member) 단위로 갱신.
//  팀원 행이 없으면(생성자라서 멤버 미등록 등) 만들어 둔다. 빈 문자열은 NULL 로 저장(상태 없음).
export async function setProjectMemberStatus(projectId: number, memberId: string, message: string | null): Promise<string | null> {
  const msg = (message ?? '').trim() || null;
  await itemsPool.query(
    `INSERT INTO project_member(project_id, member_id, status_message) VALUES($1,$2,$3)
     ON CONFLICT (project_id, member_id) DO UPDATE SET status_message=EXCLUDED.status_message`,
    [projectId, memberId, msg]);
  return msg;
}

// 세션↔프로젝트 영속 기록 — 프로젝트 터미널 세션 생성 시 호출. 타임라인이 끝난 세션의 AI 작업도 이 프로젝트로 귀속할 수 있게.
export async function recordSessionProject(sessionId: string, projectId: number): Promise<void> {
  if (!sessionId || !projectId) return;
  await itemsPool.query(
    `INSERT INTO session_project(session_id, project_id) VALUES($1,$2)
     ON CONFLICT (session_id) DO UPDATE SET project_id=EXCLUDED.project_id`,
    [sessionId, projectId]);
}

// folder(상대경로) 기준 접근 판정 — org/store.projectAccessByFolder 의 v6(project) 짝.
//  WS attach 게이트(canAttach)가 세션 dir→folder 로 프로젝트를 찾을 때, UI 프로젝트 탭은 v6 project 에
//  세션을 만들므로(org_project 아님) 반드시 이 테이블도 함께 봐야 한다. 안 그러면 생성자 본인도 입장 불가.
export async function projectAccessByFolder(folder: string, memberId: string): Promise<boolean> {
  if (!folder || !memberId) return false;
  const r = await itemsPool.query(
    `SELECT 1 FROM project p
      WHERE p.folder=$1 AND p.level='project' AND (p.created_by=$2 OR EXISTS(
        SELECT 1 FROM project_member pm WHERE pm.project_id=p.id AND pm.member_id=$2)) LIMIT 1`,
    [folder, memberId]);
  return (r.rowCount ?? 0) > 0;
}

// 공유 폴더 경로 영속 — 기존 folder 컬럼 값 갱신(스키마 불변, 데이터 쓰기). 라우트가 lazy 생성 시 호출.
export async function setProjectFolder(id: number, folder: string, ctx?: WriteCtx): Promise<void> {
  const before: ProjectRow | undefined = await one(itemsPool,
    `SELECT ${PROJECT_COLS} FROM project WHERE id=$1 AND level='project'`, [id]);
  if (!before) throw new Error(`프로젝트 #${id} 없음`);
  if (before.folder === folder) return;
  await itemsPool.query(`UPDATE project SET folder=$2, updated_at=now() WHERE id=$1`, [id, folder]);
  await auditProject(String(id), "set_folder", { folder: before.folder }, { folder }, ctx);
}

// 프로젝트 삭제 — 소유권(created_by 본인) 검증은 capability 계층에서 선행한다(여기는 순수 데이터).
//  project.parent_id ON DELETE CASCADE 가 자식 작업(task/subtask)을, project_member/category/knowledge
//  FK CASCADE 가 연결을 정리한다. activity.project_id 는 ON DELETE SET NULL — 작업 이벤트(commit 등)는
//  보존되고 프로젝트 링크만 해제된다. 감사(org_content_audit)는 FK 없는 append-only 라 삭제 후에도 보존.
export async function deleteProject(id: number, ctx?: WriteCtx): Promise<ProjectRow> {
  const before: ProjectRow | undefined = await one(itemsPool,
    `SELECT ${PROJECT_COLS} FROM project WHERE id=$1 AND level='project'`, [id]);
  if (!before) throw new Error(`프로젝트 #${id} 없음`);
  await itemsPool.query(`DELETE FROM project WHERE id=$1 AND level='project'`, [id]);
  await auditProject(String(id), "delete", before, null, ctx);
  return before;
}

// 작업(task/subtask) 삭제 — 프로젝트 삭제와 동형(삭제 + 감사 스냅샷 → content_restore/#trash 에서 본체 복원).
//  하위(subtask)는 parent_id ON DELETE CASCADE 로 함께 삭제되고, 태그·체크리스트·의존성 등 task FK 연결도 cascade 정리.
//  복원 시엔 스냅샷 본체 1행만 돌아온다(cascade 된 하위·연결은 미복원 — 프로젝트 복원과 동일 한계). 소유권 게이트는
//  task_update 와 동형(인증 사용자=가능) — capability 계층에서 처리.
export async function deleteTaskNode(id: number, ctx?: WriteCtx): Promise<ProjectRow> {
  const before: ProjectRow | undefined = await one(itemsPool,
    `SELECT ${PROJECT_COLS} FROM project WHERE id=$1 AND level IN ('task','subtask')`, [id]);
  if (!before) throw new Error(`작업 #${id} 없음`);
  await itemsPool.query(`DELETE FROM project WHERE id=$1 AND level IN ('task','subtask')`, [id]);
  await auditProject(String(id), "delete", before, null, ctx);
  return before;
}

// 복원 — 마지막 delete 의 before 스냅샷(프로젝트 본문 1행)을 원래 id 로 재적재한다. 자식 작업·팀원·
//  카테고리/지식 연결은 삭제 시 cascade 됐으므로 복원되지 않는다(프로젝트 본체만). 이미 존재하면 거부.
//  사람전용 게이트는 capability 계층(content_restore)에서 선행.
export async function restoreProject(before: Record<string, unknown>, ctx?: WriteCtx): Promise<ProjectRow> {
  const after = await restoreSnapshot<ProjectRow>("project", PROJECT_COLS, "id", before);
  await auditProject(String(after.id), "restore", null, after, ctx);
  return after;
}

export async function updateProjectStatus(id: number, status: string, ctx?: WriteCtx): Promise<ProjectRow> {
  const before: ProjectRow | undefined = await one(itemsPool,
    `SELECT ${PROJECT_COLS} FROM project WHERE id=$1 AND level='project'`, [id]);
  if (!before) throw new Error(`프로젝트 #${id} 없음`);
  // done → 완료시각 기록, active 복귀 → 완료시각 해제.
  const after: ProjectRow = await one(itemsPool,
    `UPDATE project SET status=$2, status_category=$3, completed_at=CASE WHEN $2='done' THEN now() ELSE NULL END, updated_at=now()
     WHERE id=$1 RETURNING ${PROJECT_COLS}`, [id, status, categoryOf(status)]);
  await auditProject(String(id), "set_status", before, after, ctx);
  return after;
}

// 프로젝트 이름/설명 수정(level='project'). 주어진 키만 변경(부재=무변경, description null=해제).
export async function updateProject(
  id: number,
  patch: Partial<{ name: string; description: string | null;
    priority: string | null; assignee: string | null; start_date: string | null; due_date: string | null }>,
  ctx?: WriteCtx,
): Promise<ProjectRow> {
  const before: ProjectRow | undefined = await one(itemsPool,
    `SELECT ${PROJECT_COLS} FROM project WHERE id=$1 AND level='project'`, [id]);
  if (!before) throw new Error(`프로젝트 #${id} 없음`);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.description !== undefined) set("description", patch.description);
  if (patch.priority !== undefined) set("priority", patch.priority);
  if (patch.assignee !== undefined) set("assignee", patch.assignee);
  if (patch.start_date !== undefined) set("start_date", patch.start_date);
  if (patch.due_date !== undefined) set("due_date", patch.due_date);
  if (!sets.length) return before; // 패치 비어있음 — no-op
  sets.push("updated_at=now()");
  vals.push(id);
  const after: ProjectRow = await one(itemsPool,
    `UPDATE project SET ${sets.join(", ")} WHERE id=$${vals.length} AND level='project' RETURNING ${PROJECT_COLS}`, vals);
  await auditProject(String(id), "update", before, after, ctx);
  return after;
}

// ── 보드(프로젝트 목록) 커스텀 컬럼 ───────────────────────────────────────────
//  task_field 는 루트 프로젝트(project_id)에 매이므로, 보드 전역 컬럼은 숨김 앵커 프로젝트
//  (folder='__board_anchor__')에 정의를 달고 값은 각 프로젝트 행(task_field_value.task_id=프로젝트 id)에 둔다.
//  앵커는 listProjects 에서 제외(보드에 안 보임). level='project' 라 FK·createField(level 체크) 통과.
export async function getOrCreateBoardAnchor(): Promise<number> {
  const existing: { id: number } | undefined = await one(itemsPool,
    `SELECT id FROM project WHERE level='project' AND folder='__board_anchor__' LIMIT 1`, []);
  if (existing) return existing.id;
  const row: { id: number } = await one(itemsPool,
    `INSERT INTO project(level, name, status, folder, created_at, updated_at)
     VALUES('project', '__board__', 'active', '__board_anchor__', now(), now()) RETURNING id`, []);
  return row.id;
}

// 보드 커스텀 컬럼 = 앵커의 필드 정의 + 프로젝트별 값(프론트가 각 프로젝트에 field_values 로 머지).
export async function getBoardFields(): Promise<{ anchorId: number; fields: any[]; valuesByProject: Record<number, Record<string, unknown>> }> {
  const anchorId = await getOrCreateBoardAnchor();
  const fields = await listProjectFields(anchorId);
  const valuesByProject: Record<number, Record<string, unknown>> = {};
  if (fields.length) {
    const rows: Array<{ id: number }> = await q(itemsPool,
      `SELECT id FROM project WHERE level='project' AND folder IS DISTINCT FROM '__board_anchor__'`, []);
    const ids = rows.map((r) => r.id);
    const valueRows = ids.length ? await getFieldValuesForTasks(ids) : [];
    for (const r of valueRows as Array<{ task_id: number; field_id: number; value: unknown }>) {
      if (!valuesByProject[r.task_id]) valuesByProject[r.task_id] = {};
      valuesByProject[r.task_id][String(r.field_id)] = r.value;
    }
  }
  return { anchorId, fields, valuesByProject };
}

export async function setProjectMembers(projectId: number, memberIds: string[], ctx?: WriteCtx): Promise<string[]> {
  const before = await q(itemsPool,
    `SELECT member_id FROM project_member WHERE project_id=$1 ORDER BY sort, member_id`, [projectId]);
  // 통째 교체 — 기존 삭제 후 재삽입(중복 제거).
  await itemsPool.query(`DELETE FROM project_member WHERE project_id=$1`, [projectId]);
  const seen = new Set<string>();
  const ids: string[] = [];
  let sort = 0;
  for (const memberId of memberIds) {
    if (seen.has(memberId)) continue;
    seen.add(memberId);
    await itemsPool.query(
      `INSERT INTO project_member(project_id, member_id, role, sort, added_at)
       VALUES($1,$2,'member',$3,now())`, [projectId, memberId, sort++]);
    ids.push(memberId);
  }
  await auditProject(String(projectId), "set_members", before.map((r) => r.member_id), ids, ctx);
  return ids;
}

// ── 작업(task/subtask) 쓰기 ───────────────────────────────────────────────
export async function createTask(
  input: { projectId: number; parentTaskId?: number; name: string; description?: string },
  ctx?: WriteCtx,
): Promise<ProjectRow> {
  // 부모 해석 — parentTaskId 있으면 그 작업(level='task' → 신규 subtask), 없으면 projectId(level='project' → 신규 task).
  let parentId: number;
  let level: string;
  if (input.parentTaskId != null) {
    const parent: ProjectRow | undefined = await one(itemsPool,
      `SELECT ${PROJECT_COLS} FROM project WHERE id=$1`, [input.parentTaskId]);
    if (!parent) throw new Error(`부모 작업 #${input.parentTaskId} 없음`);
    if (parent.level !== "task") throw new Error(`부모 작업 #${input.parentTaskId} 은 task 가 아니어서 하위작업을 만들 수 없습니다(level=${parent.level})`);
    parentId = parent.id;
    level = "subtask";
  } else {
    const parent: ProjectRow | undefined = await one(itemsPool,
      `SELECT ${PROJECT_COLS} FROM project WHERE id=$1`, [input.projectId]);
    if (!parent) throw new Error(`프로젝트 #${input.projectId} 없음`);
    if (parent.level !== "project") throw new Error(`#${input.projectId} 은 project 가 아니어서 작업을 만들 수 없습니다(level=${parent.level})`);
    parentId = parent.id;
    level = "task";
  }
  // 네이티브 태스크 기본 상태 = 'todo'(다단계 상태 모델). project 의 active|done 와 구분 — 리스트뷰가 상태로 그룹.
  //  (클릭업 미러 태스크는 connector-mirror 가 'active' 로 적재 — 합집합 CHECK 가 둘 다 허용, schema.ts:5b 참조.)
  const row: ProjectRow = await one(itemsPool,
    `INSERT INTO project(level, parent_id, name, description, created_by, status, status_category, created_at, updated_at)
     VALUES($1,$2,$3,$4,$5,'todo','unstarted',now(),now())
     RETURNING ${PROJECT_COLS}`,
    [level, parentId, input.name, input.description ?? null, ctx?.actor ?? null]);
  await auditProject(String(row.id), "insert", null, row, ctx);
  return row;
}

export async function updateTaskStatus(id: number, status: string, ctx?: WriteCtx): Promise<ProjectRow> {
  const before: ProjectRow | undefined = await one(itemsPool,
    `SELECT ${PROJECT_COLS} FROM project WHERE id=$1 AND level IN ('task','subtask')`, [id]);
  if (!before) throw new Error(`작업 #${id} 없음`);
  const after: ProjectRow = await one(itemsPool,
    `UPDATE project SET status=$2, status_category=$3, completed_at=CASE WHEN $2='done' THEN now() ELSE NULL END, updated_at=now()
     WHERE id=$1 RETURNING ${PROJECT_COLS}`, [id, status, categoryOf(status)]);
  await auditProject(String(id), "set_status", before, after, ctx);
  return after;
}

// 작업 필드 패치 — name/description/status/priority/assignee/start_date/due_date 중 **주어진 키만** 갱신.
//  undefined=변경 없음, null=값 비우기(예: 담당자/마감일 해제). status 갱신 시 completed_at 동기(done→now, 그 외→NULL).
//  리스트뷰 인라인 편집의 단일 진입점(상태칩·담당자·마감일·우선순위). status 전용 updateTaskStatus 와 병존(토글은 그쪽).
export async function updateTask(
  id: number,
  patch: Partial<{
    name: string; description: string | null; status: string;
    priority: string | null; assignee: string | null; start_date: string | null; due_date: string | null;
  }>,
  ctx?: WriteCtx,
): Promise<ProjectRow> {
  const before: ProjectRow | undefined = await one(itemsPool,
    `SELECT ${PROJECT_COLS} FROM project WHERE id=$1 AND level IN ('task','subtask')`, [id]);
  if (!before) throw new Error(`작업 #${id} 없음`);

  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.description !== undefined) set("description", patch.description);
  if (patch.priority !== undefined) set("priority", patch.priority);
  if (patch.assignee !== undefined) set("assignee", patch.assignee);
  if (patch.start_date !== undefined) set("start_date", patch.start_date);
  if (patch.due_date !== undefined) set("due_date", patch.due_date);
  if (patch.status !== undefined) {
    vals.push(patch.status);
    const si = vals.length;
    sets.push(`status=$${si}`);
    sets.push(`completed_at=CASE WHEN $${si}='done' THEN now() ELSE NULL END`);
    vals.push(categoryOf(patch.status));
    sets.push(`status_category=$${vals.length}`);
  }
  if (!sets.length) return before; // 패치 비어있음 — no-op

  sets.push("updated_at=now()");
  vals.push(id);
  const after: ProjectRow = await one(itemsPool,
    `UPDATE project SET ${sets.join(", ")} WHERE id=$${vals.length} RETURNING ${PROJECT_COLS}`, vals);
  await auditProject(String(id), "update", before, after, ctx);
  return after;
}

// ── 정션: 카테고리/지식 연결 ──────────────────────────────────────────────
export async function linkProjectCategory(projectId: number, categoryId: number, ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(
    `INSERT INTO project_category(project_id, category_id, added_at)
     VALUES($1,$2,now()) ON CONFLICT (project_id, category_id) DO NOTHING`,
    [projectId, categoryId]);
  await auditProject(String(projectId), "link_category", null, { category_id: categoryId }, ctx);
}

export async function unlinkProjectCategory(projectId: number, categoryId: number, ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(`DELETE FROM project_category WHERE project_id=$1 AND category_id=$2`, [projectId, categoryId]);
  await auditProject(String(projectId), "unlink_category", { category_id: categoryId }, null, ctx);
}

export async function linkProjectKnowledge(projectId: number, name: string, relation: string, ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(
    `INSERT INTO project_knowledge(project_id, name, relation, added_at)
     VALUES($1,$2,$3,now()) ON CONFLICT (project_id, name, relation) DO NOTHING`,
    [projectId, name, relation]);
  await auditProject(String(projectId), "link_knowledge", null, { name, relation }, ctx);
}

// ── 관련 레포(project_repo, n:n) — 전체 교체 셋(웹 세부설정 멀티선택). repo 레지스트리 이름 참조. ──
export async function getProjectRepos(projectId: number): Promise<string[]> {
  const rows = await q(itemsPool, `SELECT repo FROM project_repo WHERE project_id=$1 ORDER BY sort, repo`, [projectId]);
  return rows.map((r) => r.repo);
}
export async function setProjectRepos(projectId: number, repos: string[], ctx?: WriteCtx): Promise<string[]> {
  const clean = [...new Set(repos.map((r) => String(r).trim()).filter(Boolean))].slice(0, 50);
  const before = await getProjectRepos(projectId);
  await itemsPool.query(`DELETE FROM project_repo WHERE project_id=$1`, [projectId]);
  for (let i = 0; i < clean.length; i++) {
    await itemsPool.query(`INSERT INTO project_repo(project_id, repo, sort) VALUES($1,$2,$3)`, [projectId, clean[i], i]);
  }
  await auditProject(String(projectId), "set_repos", { repos: before }, { repos: clean }, ctx);
  return clean;
}

// ── 카테고리(project_category, n:n) — 전체 교체 셋(웹 생성 모달·세부설정 멀티선택). 단건 link/unlink 와 공존. ──
export async function setProjectCategories(projectId: number, categoryIds: number[], ctx?: WriteCtx): Promise<number[]> {
  const clean = [...new Set((categoryIds || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50);
  const beforeRows = await q(itemsPool, `SELECT category_id FROM project_category WHERE project_id=$1`, [projectId]);
  const before = beforeRows.map((r) => Number(r.category_id));
  await itemsPool.query(`DELETE FROM project_category WHERE project_id=$1`, [projectId]);
  for (const cid of clean) {
    await itemsPool.query(
      `INSERT INTO project_category(project_id, category_id, added_at) VALUES($1,$2,now()) ON CONFLICT (project_id, category_id) DO NOTHING`,
      [projectId, cid]);
  }
  await auditProject(String(projectId), "set_categories", { category_ids: before }, { category_ids: clean }, ctx);
  return clean;
}

export async function unlinkProjectKnowledge(projectId: number, name: string, relation: string, ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(
    `DELETE FROM project_knowledge WHERE project_id=$1 AND name=$2 AND relation=$3`, [projectId, name, relation]);
  await auditProject(String(projectId), "unlink_knowledge", { name, relation }, null, ctx);
}
