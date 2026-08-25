// v6 project 데이터 접근 — 1급 엔티티 project▸task▸subtask(parent_id self-FK). 구 org_project + W ku 통합.
//  project = level='project'(팀원·카테고리·필요/산출지식 보유) | task/subtask = 하위 작업(구 W ku 대체).
//  itemsPool 직접 + q/one 헬퍼(domainmap/db) 재사용. 감사 org_content_audit(entity='project', entity_key=id).
import { itemsPool } from "../db/client.js";
import { q, one, withTx } from "../db/client.js";
import { listProjectFields, getFieldValuesForTasks } from "./task-field-store.js";
import { getTaskTags, getTaskTime, getTaskAttachments } from "./task-detail-store.js"; // 프로젝트 노드(project.id)도 같은 task_tag_link/task_time_entry/task_attachment 테이블 사용
import { auditOrgContent, restoreSnapshot, type WriteCtx } from "./content-audit.js";
// 필요지식 추천(벡터검색 #172) — 카테고리 인지 유사 지식 회수. knowledge-store 는 project-store 를 import 안 함(무순환).
import { findRecommendedKnowledge, type KnowledgeRecommendRow } from "./knowledge-store.js";
// 아웃바운드 write-through(#177) — 로컬 편집을 외부 PM(ClickUp) 푸시 아웃박스에 적재. 커넥터는 project-store 우회라 루프 없음.
import { enqueueExternalPush } from "./external-outbox.js";
// 프로젝트 검색(#631) — knowledge 와 동일 seam. 검색 경로의 쿼리 벡터 리터럴만 toVectorLiteral 로 만든다.
import { toVectorLiteral } from "./embedding-provider.js";
import { visibleListIds, listIdPredicate, type Viewer } from "./visibility.js";
// 쓰기 경로 임베딩 비동기화(#1053) — 저장/수정 시 인라인 임베딩 대신 pending 마킹 후 백그라운드 스윕에 위임(knowledge 와 동형).
import { markEmbeddingPending, PROJECT_TARGET } from "./embedding-backfill.js";
import {
  type GrepPlan, parseGrep, grepWhere, grepExec, grepSnippet, previewBody, RRF_K, HYBRID_CANDIDATES, activeEmbeddingProvider,
} from "./search-util.js";

// 세션·폴더 바인딩(#1313 R21) — 구현은 project-session-store.ts 로 분리(터미널 척추가 PM 스토어 전체를 안 끌게).
//  기존 호출부 호환을 위해 여기서 **재수출**한다. 세션 경로(terminal/·sessions/·index.ts)는 그 모듈을 직결 import.
export {
  isProjectMember, sessionBoundToMemberProject, recordSessionProject, latestProjectForSession,
  SHARED_BINDING_MEMBER, upsertProjectFolderBinding, listProjectFolderBindings, removeProjectFolderBinding,
  findProjectsByOriginKey, projectAccessByFolder,
} from "./project-session-store.js";
export type { FolderSyncMode, ProjectFolderBinding, OriginProjectCandidate } from "./project-session-store.js";

// project(=level='project') 본문 컬럼 — task/subtask 도 같은 테이블이라 level 로 구분.
const PROJECT_COLS =
  `id, level, parent_id, name, description, status, status_raw, status_category, folder, created_by,
   list_id,
   priority, assignee, start_date, due_date,
   external_system, external_instance, external_id, external_url,
   sort, created_at, updated_at, completed_at, archived_at, trashed_at`;

export interface ProjectRow {
  id: number; level: string; parent_id: number | null;
  name: string; description: string | null; status: string;
  // status_raw = 소스 원문 상태명(개방 어휘, 네이티브는 NULL). status_category = 정규 카테고리(backlog|unstarted|started|done|canceled).
  status_raw: string | null; status_category: string | null;
  folder: string | null; created_by: string | null;
  // 리스트 묶음(level='project' 행만 의미; task/subtask 는 NULL). 0~1개 리스트에 소속. project_list.id 또는 NULL(미분류).
  list_id: number | null;
  // 태스크 필드(task/subtask 행만 채워짐; project 행은 NULL). 기간은 'YYYY-MM-DD' 문자열(schema.ts 참조).
  priority: string | null; assignee: string | null;
  start_date: string | null; due_date: string | null;
  external_system: string | null; external_instance: string | null;
  external_id: string | null; external_url: string | null;
  sort: number; created_at: string; updated_at: string; completed_at: string | null;
  // #1851 — 아카이브 표식(보관 시각). NULL=평소 화면. 목록은 기본으로 이 행을 뺀다(ProjectFilter.archived).
  archived_at: string | null;
  // #1851 — 휴지통 표식(버린 시각). NULL=평소. 목록은 기본으로 이 행을 뺀다(ProjectFilter.trashed). 하드 삭제 전 단계.
  trashed_at: string | null;
  members?: unknown[]; // listProjects 가 facepile 용으로 채움(상세 getProject 의 members 와 별개)
}

// append-only 감사(org_content_audit, entity='project') — 공유 헬퍼 위임.
const auditProject = (entityKey: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("project", entityKey, op, before, after, ctx);

// 쓰기 경로 임베딩 비동기화(#1053, 검색 #631) — 저장/수정 시 인라인 임베딩(HTTP, 느린 CPU 백엔드는 건당 수십 초)을
//  하지 않고, 행의 벡터를 비워 pending 으로 되돌린 뒤 백그라운드 스윕(runAutoBackfillSweep)이 배치로 채운다. 저장은
//  즉시 반환. 신규 행은 이미 NULL(=pending)이라 리셋은 no-op + nudge 만. off/실패는 no-op(스윕이 스키마 보장·수렴).
//  connector-mirror(ClickUp 미러)도 이 함수를 재사용한다(#624 트리거) — 그래서 export. 미러는 서브프로세스라
//  nudge=false(리셋만; 게이트웨이 post-sync 스윕이 드레인 — 서브프로세스에서 스윕을 돌리지 않기 위함).
export async function markProjectEmbeddingPending(id: number, opts?: { nudge?: boolean }): Promise<void> {
  await markEmbeddingPending(PROJECT_TARGET, id, opts?.nudge ?? true);
}

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

// 단일 assignee 컬럼 ↔ task_assignee n:n 동기(전환기: 컬럼=primary, n:n=가산 섀도). 멀티담당자/소비자 이행 전까지 0~1명.
//  통째 교체 의미론(준 목록이 최종 담당자 집합). 커넥터(다중)도 이 헬퍼로 task_assignee 를 채운다.
export async function syncTaskAssignees(taskId: number, assignees: string[]): Promise<void> {
  await itemsPool.query(`DELETE FROM task_assignee WHERE task_id=$1`, [taskId]);
  let sort = 0;
  for (const m of [...new Set(assignees.map((a) => String(a).trim()).filter(Boolean))]) {
    await itemsPool.query(
      `INSERT INTO task_assignee(task_id, member_id, sort) VALUES($1,$2,$3) ON CONFLICT (task_id, member_id) DO NOTHING`,
      [taskId, m, sort++]);
  }
}

// ── 조회 ──────────────────────────────────────────────────────────────────
// viewerVis = 공개범위 시행 기준 신원(#475→#1291). 지정 시 이 신원에게 안 보이는 리스트의 프로젝트를 숨긴다.
//  viewer('내 프로젝트' 필터)와 직교 — viewerVis 는 mine 여부와 무관하게 항상 적용된다.
//  ⚠ #1291 이후 규약: `null`=특권(admin·내부 경로, 필터 없음) / 문자열=그 멤버로 필터.
//   구 주석의 "MCP 는 신원 없이 전체 열람"은 사실이 아니었다 — MCP 도 bearer 신원이 항상 있어 이미 필터되고 있었다.
//   판정은 v6/visibility.ts 로 일원화한다(리스트 자기 설정 ∩ 상위 스페이스 — 상속을 한 곳에서만 계산).
// archived(#1851): exclude(기본 — 보관한 프로젝트는 평소 목록에서 빠진다) · include(전부) · only(아카이브 화면).
export type ArchivedFilter = "exclude" | "include" | "only";
export interface ProjectFilter { space?: string; categoryId?: number; status?: string; viewer?: string; viewerVis?: Viewer; archived?: ArchivedFilter; trashed?: ArchivedFilter }

// ── 내 할 일(#1232) — 사람 축으로 뒤집은 태스크 조회. ─────────────────────
//  listProjects 는 `level='project'` 고정이라 "내가 맡은 태스크"를 프로젝트 가로질러 볼 방법이 없었다(프로젝트를
//  하나씩 열어야만 보였다). 대시보드 '내 할 일' 위젯이 쓰는 유일한 경로.
//  담당자 판정은 두 축의 합집합 — 단일 assignee 컬럼(primary)과 task_assignee n:n(섀도). 전환기라 둘 다 봐야
//   한쪽만 채워진 행(커넥터 미러 등)이 빠지지 않는다(syncTaskAssignees 주석 참조).
//  ⚠ 공개범위 — #1291 에서 방침을 뒤집었다. 예전엔 "배정됐는데 안 보인다"를 피하려 일부러 안 걸었는데,
//   가시성이 하드 경계가 된 이상 그 예외가 곧 우회로가 된다(잠긴 리스트의 태스크 제목이 여기로 샌다).
//   배정 자체가 열람 근거가 되지는 않는다 — 배정했는데 안 보인다면 그 사람을 리스트 대상에 넣는 게 올바른 해법이다.
//   (잠긴 리스트가 없으면 결과는 종전과 100% 동일 — 잠그기 전까지 아무 변화가 없다.)
//   남의 담당 태스크는 어떤 경우에도 이 쿼리에 들어오지 않는다.
export interface MyTaskRow extends ProjectRow { project_id: number | null; project_name: string | null; project_list_id: number | null }
export async function listMyTasks(memberId: string, limit = 200, viewer?: Viewer): Promise<MyTaskRow[]> {
  const me = String(memberId || "").trim();
  if (!me) return [];
  // 이 쿼리는 이미 조상 프로젝트(pr)를 조인해 두었으므로 그 list_id 로 바로 판정한다(별도 서브쿼리 불요).
  const visWhere = viewer === undefined ? "TRUE" : listIdPredicate("pr.list_id", await visibleListIds(viewer));
  const cols = PROJECT_COLS.split(",").map((c) => "p." + c.trim()).join(", ");
  const { rows } = await itemsPool.query(`
    SELECT ${cols},
           pr.id AS project_id, pr.name AS project_name, pr.list_id AS project_list_id
      FROM project p
      -- 부모 1단(subtask 면 task, task 면 project) → 거기서 프로젝트 행을 확정.
      LEFT JOIN project par ON par.id = p.parent_id
      LEFT JOIN project pr ON pr.id = CASE WHEN p.level = 'subtask' THEN par.parent_id ELSE par.id END
     WHERE p.level IN ('task','subtask')
       AND ${visWhere}
       AND (p.assignee = $1 OR EXISTS(SELECT 1 FROM task_assignee ta WHERE ta.task_id = p.id AND ta.member_id = $1))
       AND p.status <> 'done'
       AND COALESCE(p.status_category, '') NOT IN ('done','canceled')
     -- 기한 있는 것 먼저(임박 순), 그다음 기한 없는 것 최신 갱신 순. due_date 는 TEXT 'YYYY-MM-DD' 라 사전식=시간순.
     ORDER BY (p.due_date IS NULL), p.due_date, p.updated_at DESC
     LIMIT $2`, [me, Math.max(1, Math.min(500, limit))]);
  return rows as MyTaskRow[];
}

// ── 엣지 끝점의 가시성(#1308) ─────────────────────────────────────────────
//  `project_edge` 의 끝점은 **태스크일 수도 있다** — 의존(depends_on)은 태스크 간에도 걸리고, FK 가
//  `project(id)` 를 가리키는데 그 테이블엔 task/subtask 가 함께 산다. 그런데 태스크의 list_id 는 항상
//  NULL 이라 그대로 판정하면 "미분류 = 전원 열람" 규칙에 빠져 **잠긴 프로젝트의 태스크 이름이 엣지를
//  통해 샌다.** visibility.projectRowListId 와 같은 규칙으로 루트 프로젝트를 타고 올라가 판정한다.
const EDGE_ROOT_JOIN = `
       LEFT JOIN project epar ON epar.id = p.parent_id
       LEFT JOIN project eroot ON eroot.id = CASE WHEN p.level='subtask' THEN epar.parent_id
                                                  WHEN p.level='task'    THEN epar.id
                                                  ELSE p.id END`;
const EDGE_ROOT_LIST = "COALESCE(eroot.list_id, p.list_id)";

// ── 타임라인(간트)용 하위 작업 벌크 조회(#1305) ───────────────────────────
//  타임라인은 스코프 안 프로젝트 **전부**의 하위 작업을 한 화면에 계층(project▸task▸subtask)으로 그린다.
//  프로젝트마다 getProject 를 부르면 N+1 이 되고 — 그 함수는 팀원·카테고리·지식·엣지·필드·첨부까지 전부 읽는다 —
//  화면 하나에 수백 요청이 나간다. 여기서는 간트가 실제로 쓰는 컬럼만 한 쿼리로 훑는다.
//  루트 판정·공개범위는 listMyTasks 와 같은 규칙(부모 1단 조인 → 루트 프로젝트의 list_id 로 가시성 판정).
export interface ProjectTaskRow extends ProjectRow { project_id: number }
export async function listTasksForProjects(projectIds: number[], viewerVis?: Viewer): Promise<ProjectTaskRow[]> {
  const ids = [...new Set(projectIds.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];
  const visIds = viewerVis === undefined ? null : await visibleListIds(viewerVis);
  const cols = PROJECT_COLS.split(",").map((c) => "p." + c.trim()).join(", ");
  // ⚠ 요청 id 는 이미 목록에서 걸러진 것들이지만, 여기서도 가시성을 다시 건다 — 주소창에 남의 프로젝트 id 를
  //  적어 넣으면 잠긴 리스트의 태스크 제목이 그대로 새는 우회로가 되기 때문(#1291 과 같은 이유).
  return q(itemsPool, `
    SELECT ${cols}, root.id AS project_id
      FROM project p
      LEFT JOIN project par ON par.id = p.parent_id
      JOIN project root ON root.id = CASE WHEN p.level='subtask' THEN par.parent_id ELSE p.parent_id END
                       AND root.level='project'
     WHERE p.level IN ('task','subtask')
       AND root.id = ANY($1)
       AND ${listIdPredicate("root.list_id", visIds)}
     ORDER BY p.sort, p.id`, [ids]) as Promise<ProjectTaskRow[]>;
}

// ── 의존 엣지(#1308) ──────────────────────────────────────────────────────
/** level 을 가리지 않는 노드 1행. getProjectRow 는 level='project' 고정이라 태스크 끝점을 거부한다. */
export async function getNodeRow(id: number): Promise<ProjectRow | undefined> {
  return one(itemsPool, `SELECT ${PROJECT_COLS} FROM project WHERE id=$1`, [id]);
}

/** 주어진 노드들 사이에 걸린 엣지(기본 depends_on). 타임라인이 의존선을 그릴 때 쓰는 벌크 경로.
 *  **양쪽 끝이 모두 요청 집합 안에 있는 것만** 돌려준다 — 화면 밖 노드로 가는 선은 그릴 자리가 없다.
 *  가시성은 두 끝 모두에 건다(EDGE_ROOT_JOIN 주석 참조). */
export async function listEdgesForNodes(nodeIds: number[], viewerVis?: Viewer, relation = "depends_on"): Promise<Array<{ from_id: number; to_id: number; relation: string }>> {
  const ids = [...new Set(nodeIds.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];
  const visIds = viewerVis === undefined ? null : await visibleListIds(viewerVis);
  const vis = (alias: string) => listIdPredicate(`COALESCE(${alias}root.list_id, ${alias}.list_id)`, visIds);
  const rootJoin = (alias: string) => `
       LEFT JOIN project ${alias}par ON ${alias}par.id = ${alias}.parent_id
       LEFT JOIN project ${alias}root ON ${alias}root.id = CASE WHEN ${alias}.level='subtask' THEN ${alias}par.parent_id
                                                                WHEN ${alias}.level='task'    THEN ${alias}par.id
                                                                ELSE ${alias}.id END`;
  const rows = await q(itemsPool, `
    SELECT pe.from_project_id AS from_id, pe.to_project_id AS to_id, pe.relation
      FROM project_edge pe
      JOIN project pf ON pf.id = pe.from_project_id ${rootJoin("pf")}
      JOIN project pt ON pt.id = pe.to_project_id   ${rootJoin("pt")}
     WHERE pe.relation = $2
       AND pe.from_project_id = ANY($1) AND pe.to_project_id = ANY($1)
       AND ${vis("pf")} AND ${vis("pt")}`, [ids, relation]);
  return rows.map((r) => ({ from_id: Number(r.from_id), to_id: Number(r.to_id), relation: String(r.relation) }));
}

/** 자동 재스케줄(#1308) — 선행이 Δ일 움직였을 때 후행 체인을 같은 Δ 로 민다.
 *  방향 규약: `from --depends_on--> to` = from 이 to 에 의존 → **to 가 선행(blocking), from 이 후행(blocked)**.
 *  명세(clickup-gantt-view-spec-1067 §11)를 따르되 그쪽 함정은 빼고 규칙을 하나로 고정한다:
 *   · 이동량은 **델타 시프트**(gap 보존)다 — 선행 종료에 붙이는 스냅이 아니다.
 *   · 전제조건 — 후행에 start_date 가 없으면 밀 자리가 없으므로 그 가지는 건너뛴다(전파도 멈춘다).
 *   · 순환은 visited 로 끊는다. 클릭업은 순환 방지를 문서화하지 않았지만 우리는 명시적으로 막는다.
 *   · '화면에 보이는 것만 민다'는 클릭업의 경로별 이원성은 재현하지 않는다 — 항상 체인 전체.
 *  날짜 산술은 SQL 의 date + int 로 한다(컬럼이 'YYYY-MM-DD' TEXT 라 JS 파싱을 거치면 TZ 함정이 생긴다). */
export async function rescheduleDependents(anchorId: number, deltaDays: number, ctx?: WriteCtx): Promise<ProjectRow[]> {
  const delta = Math.trunc(Number(deltaDays));
  if (!Number.isFinite(delta) || delta === 0) return [];
  const moved: ProjectRow[] = [];
  const visited = new Set<number>([Number(anchorId)]);
  let frontier: number[] = [Number(anchorId)];
  // 층 단위 BFS — 한 층이 통째로 밀린 뒤 그 층을 선행으로 삼아 다음 층으로 간다.
  while (frontier.length) {
    const rows = await q(itemsPool,
      `SELECT pe.from_project_id AS id FROM project_edge pe
        WHERE pe.relation='depends_on' AND pe.to_project_id = ANY($1)`, [frontier]);
    const next: number[] = [];
    for (const r of rows) {
      const id = Number(r.id);
      if (visited.has(id)) continue;   // 순환·중복 방지
      visited.add(id);
      const after: ProjectRow | undefined = await one(itemsPool, `
        UPDATE project
           SET start_date = to_char(start_date::date + $2::int, 'YYYY-MM-DD'),
               due_date   = CASE WHEN due_date IS NULL THEN NULL
                                 ELSE to_char(due_date::date + $2::int, 'YYYY-MM-DD') END,
               updated_at = now()
         WHERE id = $1 AND start_date IS NOT NULL
       RETURNING ${PROJECT_COLS}`, [id, delta]);
      if (!after) continue;            // start 가 없어 못 민 가지 — 여기서 전파도 멈춘다
      await auditProject(String(id), "reschedule", { anchor: anchorId, deltaDays: delta }, { start_date: after.start_date, due_date: after.due_date }, ctx);
      moved.push(after);
      // 자기 due 가 있어야 다음 후행을 밀 근거가 된다(선행 조건).
      if (after.due_date) next.push(id);
    }
    frontier = next;
  }
  return moved;
}

export async function listProjects(filter: ProjectFilter = {}): Promise<ProjectRow[]> {
  const params: unknown[] = [];
  let join = "";
  // 가시 리스트 집합을 **한 번** 계산해 세미조인으로 붙인다(#1291). 행마다 서브쿼리를 평가하는 대신
  //  수십 행짜리 리스트 테이블을 1회 훑는다 — 보드는 프로젝트 수백 행을 한 번에 그리므로 이 차이가 크다.
  const visIds = filter.viewerVis === undefined ? null : await visibleListIds(filter.viewerVis);
  // 카테고리/스페이스 필터 = 소속 리스트의 카테고리 상속(#541 후속 — project_category 대체). 프로젝트→리스트→카테고리.
  //  categoryId 우선, 없으면 space 로 카테고리 조인. list_id NULL(미분류) 프로젝트는 카테고리가 없어 자연히 제외.
  if (filter.categoryId != null) {
    params.push(filter.categoryId);
    join = `JOIN project_list plc ON plc.id=p.list_id AND plc.category_id=$${params.length}`;
  } else if (filter.space) {
    params.push(filter.space);
    join = `JOIN project_list plc ON plc.id=p.list_id
            JOIN category c ON c.id=plc.category_id AND c.space=$${params.length}`;
  }
  const wh: string[] = [`p.level='project'`];
  if (filter.status) { params.push(filter.status); wh.push(`p.status=$${params.length}`); }
  // viewer 지정(웹 '내 프로젝트') → 생성자이거나 팀원인 것만.
  if (filter.viewer) {
    params.push(filter.viewer);
    wh.push(`(p.created_by=$${params.length} OR EXISTS(SELECT 1 FROM project_member pmv WHERE pmv.project_id=p.id AND pmv.member_id=$${params.length}))`);
  }
  wh.push("p.folder IS DISTINCT FROM '__board_anchor__'"); // 보드 커스텀 컬럼 앵커(숨김 프로젝트) 제외
  // 아카이브(#1851) — 기본은 **뺀다**. 보관은 '평소 화면에서 치운다'는 뜻이라 보드·사이드바·자동 스코프 어디에도
  //  안 보이는 게 맞고, 보려면 호출자가 archived=include|only 로 명시한다(새 셸 사이드바는 include 로 받아 스스로 가른다).
  const arch: ArchivedFilter = filter.archived || "exclude";
  if (arch === "exclude") wh.push("p.archived_at IS NULL");
  else if (arch === "only") wh.push("p.archived_at IS NOT NULL");
  // 휴지통(#1851) — 같은 규칙. 버린 프로젝트는 어디에도 안 보이고 휴지통 화면(trashed=include 로 받아 화면이 가른다)에만.
  const tr: ArchivedFilter = filter.trashed || "exclude";
  if (tr === "exclude") wh.push("p.trashed_at IS NULL");
  else if (tr === "only") wh.push("p.trashed_at IS NOT NULL");
  // 공개범위 시행(#475→#1291) — 안 보이는 리스트의 프로젝트는 뺀다. 미분류(list_id NULL)는 잠글 상위가 없어 전원 열람.
  wh.push(listIdPredicate("p.list_id", visIds));
  const where = `WHERE ${wh.join(" AND ")}`;
  // DISTINCT — 다중 카테고리 매핑 시 조인 중복 제거. ORDER BY 컬럼은 SELECT DISTINCT 대상에 포함.
  //  members = facepile 용 스칼라 서브쿼리(org_member 표시명 조인, 정렬 보존).
  const cols = PROJECT_COLS.split(",").map((c) => "p." + c.trim()).join(", ");
  return q(itemsPool,
    `SELECT DISTINCT ${cols},
       CASE WHEN p.raw->>'orderindex' ~ '^-?[0-9.]+$' THEN (p.raw->>'orderindex')::float8 END AS ext_orderindex,
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
  edges: { outgoing: unknown[]; incoming: unknown[] }; // 프로젝트↔프로젝트(project_edge) — outgoing=선행(이 프로젝트가 follow_up 하는 대상), incoming=후속(이 프로젝트를 follow_up 하는 것).
  fields: unknown[]; // 커스텀 필드(클릭업형 컬럼) 정의 — 루트 프로젝트 단위. 값은 각 task 의 field_values 에.
  tags: unknown[]; // 프로젝트 자체 태그(클릭업식 메타) — task_tag_link 를 project.id 로 사용.
  time: unknown; // 프로젝트 시간추적 { entries, total_seconds, running } — task_time_entry 를 project.id 로 사용.
  repos: string[]; // 관련 레포 이름(project_repo) — AGENTS.md '관련 레포' + '내 컴퓨터에서 작업' 모달 기본값.
  list: { id: number; name: string; color: string | null } | null; // 소속 리스트(미분류면 null) — 상세 '리스트' 필드 표시용.
  field_values: Record<string, unknown>; // #541: 프로젝트 행 자신의 커스텀필드 값(ClickUp 최상위 태스크 값 — 메타패널 표시).
  attachments: unknown[]; // #541: 이 프로젝트 행의 task_attachment(ClickUp 첨부/인라인 이미지 이관).
}

// viewer(#1291) — 이 신원에게 안 보이는 프로젝트면 **없는 것처럼** undefined 를 돌려준다(호출부가 404 로 바꾼다).
//  403 이 아니라 404 인 이유: "권한이 없다"는 응답 자체가 '그 id 의 프로젝트가 존재한다'는 사실을 알려준다.
export async function getProject(id: number, viewer?: Viewer): Promise<ProjectDetail | undefined> {
  const project: ProjectRow | undefined = await one(itemsPool,
    `SELECT ${PROJECT_COLS} FROM project WHERE id=$1 AND level='project'`, [id]);
  if (!project) return undefined;
  const visIds = viewer === undefined ? null : await visibleListIds(viewer);
  if (visIds && project.list_id != null && !visIds.has(Number(project.list_id))) return undefined;

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
  //  #541: 프로젝트 행 자신의 값도 함께(ClickUp 최상위 태스크=우리 project 행 — 표시 표면은 상세 메타패널).
  const fields = await listProjectFields(id);
  const allTaskIds = [id, ...taskIds, ...subtaskRows.map((s) => s.id)];
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

  // 카테고리(도메인) — 소속 리스트에서 상속(#541 후속 — 프로젝트 단위 project_category 대체). 리스트 미지정/미분류면 0건.
  //  AGENTS.md 도메인 줄·지식추천·상세 표시가 이 필드를 소비 → 리스트 카테고리만 바꾸면 자동 반영.
  const categories = await q(itemsPool,
    `SELECT pl.category_id, c.space, c.key, c.name
     FROM project p JOIN project_list pl ON pl.id=p.list_id JOIN category c ON c.id=pl.category_id
     WHERE p.id=$1`, [id]);

  // 필요/산출 지식(project_knowledge JOIN knowledge) — relation 으로 분리.
  const kRows = await q(itemsPool,
    `SELECT pk.name, pk.relation, k.title, k.injection, k.provenance, k.lifecycle
     FROM project_knowledge pk JOIN knowledge k ON k.name=pk.name
     WHERE pk.project_id=$1 ORDER BY pk.relation, pk.name`, [id]);
  const knowledge = {
    required: kRows.filter((r) => r.relation === "required"),
    produced: kRows.filter((r) => r.relation === "produced"),
  };

  // 프로젝트↔프로젝트 엣지(project_edge) — 양방향. outgoing: 이 프로젝트(from) → 대상(to=선행). incoming: 다른(from) → 이 프로젝트(to=후속).
  const [outRows, inRows] = await Promise.all([
    // ⚠ 이웃 프로젝트의 이름·상태가 그대로 실려 나가므로 여기에도 공개범위를 건다(#1291) —
    //  안 그러면 내 프로젝트에서 잠긴 프로젝트로 엣지를 걸어 이름을 읽는 우회로가 된다.
    q(itemsPool,
      `SELECT pe.relation, pe.to_project_id AS project_id, p.name AS project_name, p.status, p.level
       FROM project_edge pe JOIN project p ON p.id=pe.to_project_id ${EDGE_ROOT_JOIN}
       WHERE pe.from_project_id=$1 AND p.folder IS DISTINCT FROM '__board_anchor__'
         AND ${listIdPredicate(EDGE_ROOT_LIST, visIds)}
       ORDER BY pe.relation, lower(p.name)`, [id]),
    q(itemsPool,
      `SELECT pe.relation, pe.from_project_id AS project_id, p.name AS project_name, p.status, p.level
       FROM project_edge pe JOIN project p ON p.id=pe.from_project_id ${EDGE_ROOT_JOIN}
       WHERE pe.to_project_id=$1 AND p.folder IS DISTINCT FROM '__board_anchor__'
         AND ${listIdPredicate(EDGE_ROOT_LIST, visIds)}
       ORDER BY pe.relation, lower(p.name)`, [id]),
  ]);
  const edgeMap = (r: Record<string, unknown>) => ({ project_id: Number(r.project_id), project_name: r.project_name, status: r.status, level: r.level, relation: r.relation });
  const edges = { outgoing: outRows.map(edgeMap), incoming: inRows.map(edgeMap) };

  // 프로젝트 자체의 태그·시간추적·첨부(클릭업식 메타) — 태스크와 동일 테이블을 project.id 로 사용.
  //  첨부(#541): ClickUp 최상위 태스크의 attachments[] 가 이 project 행의 task_attachment 로 이관됨.
  const [tags, time, attachments] = await Promise.all([getTaskTags(id), getTaskTime(id), getTaskAttachments(id)]);

  // 관련 레포(project_repo) — 레포 레지스트리 이름 배열(AGENTS.md '관련 레포' + 모달 기본값).
  const repoRows = await q(itemsPool, `SELECT repo FROM project_repo WHERE project_id=$1 ORDER BY sort, repo`, [id]);
  const repos = repoRows.map((r) => r.repo);

  // 소속 리스트(있으면 표시명·색) — 상세 페이지 '리스트' 필드용. 미분류면 null.
  const list = project.list_id != null
    ? ((await one(itemsPool, `SELECT id, name, color FROM project_list WHERE id=$1`, [project.list_id])) ?? null)
    : null;

  return {
    ...project, list, members, tasks, categories, knowledge, edges, fields, tags, time, repos,
    // #541: 프로젝트 행 자신의 커스텀필드 값 + 이관 첨부(상세 메타패널·첨부 섹션 소비).
    field_values: valuesByTask.get(id) ?? {}, attachments,
  };
}

// ── 프로젝트 쓰기 ─────────────────────────────────────────────────────────
/** 같은 사람이 같은 이름으로 이 시간 안에 또 만들면 '사고'로 보고 먼저 만든 것을 돌려준다(#1819). */
export const CREATE_DEDUPE_SEC = 30;

export async function createProject(
  input: { name: string; description?: string; folder?: string; members?: string[]; list_id?: number | null },
  ctx?: WriteCtx,
): Promise<ProjectRow> {
  // folder = 평범한 선택 컬럼값(물리 폴더 생성 없음). TODO: 필요 시 capability 계층에서 createProjectFolder 선행.
  //  list_id = 소속 리스트(영역). nullable(웹은 미지정 허용, MCP 는 capability 에서 필수). FK 는 project_list(ON DELETE SET NULL).
  //
  // ── 중복 생성 차단(#1819) ────────────────────────────────────────────────
  //  같은 사람이 **같은 이름**을 몇 초 안에 두 번 만들면 그건 의도가 아니라 사고다 — 이미 만들어진 것을 돌려준다.
  //  실측(2026-08-20): 한글 이름을 치고 Enter 를 누르면 IME 조합 확정 Enter 와 진짜 Enter 가 잇달아 들어와
  //   같은 밀리초에 프로젝트가 두 개 생겼다(#1818/#1819 · #1806/#1807 · #1812/#1813). 그 입구(웹 사이드바)는
  //   따로 고쳤지만, 입구는 넷이고 앞으로도 는다(웹 모달·인라인 행·MCP·REST) — 그래서 **여기**서 구조로 막는다.
  //   에이전트 재시도(응답을 못 받고 다시 호출)도 같은 사고이므로 창을 초 단위로 넉넉히 잡는다.
  //  창 밖의 동명 프로젝트는 그대로 만들어진다(같은 이름을 일부러 여럿 두는 것은 사람의 자유다).
  //
  //  ⚠ **사전 조회만으로는 못 막는다** — 사고의 실제 모습이 '같은 밀리초에 도착한 두 요청'이라(위 실측 세 쌍의
  //   created_at 간격은 0.15~0.2ms) 둘 다 조회에서 아무것도 못 보고 둘 다 INSERT 한다. 그래서 조회와 삽입을
  //   한 트랜잭션에 넣고 (테넌트·만든이·이름) 키로 **직렬화**한다. 자문 락은 클러스터 전역이므로 키에 테넌트를
  //   반드시 섞는다(안 섞으면 남의 워크스페이스가 같은 이름을 만들 때 서로 기다린다).
  const made = await withTx(async (c): Promise<{ row: ProjectRow; deduped: boolean }> => {
    await c.query(
      `SELECT pg_advisory_xact_lock(hashtext(coalesce(current_setting('app.tenant_id', true),'') || '|' || $1))`,
      [`${ctx?.actor ?? ""}|${input.name}`]);
    const dup: ProjectRow | undefined = await one(c,
      `SELECT ${PROJECT_COLS} FROM project
        WHERE level='project' AND name=$1 AND created_by IS NOT DISTINCT FROM $2
          AND created_at > now() - ($3 || ' seconds')::interval
        ORDER BY id DESC LIMIT 1`,
      [input.name, ctx?.actor ?? null, String(CREATE_DEDUPE_SEC)]);
    if (dup) return { row: dup, deduped: true };
    const fresh: ProjectRow = await one(c,
      `INSERT INTO project(level, name, description, folder, list_id, created_by, status, status_category, created_at, updated_at)
       VALUES('project',$1,$2,$3,$4,$5,'active','started',now(),now())
       RETURNING ${PROJECT_COLS}`,
      [input.name, input.description ?? null, input.folder ?? null, input.list_id ?? null, ctx?.actor ?? null]);
    return { row: fresh, deduped: false };
  });
  // 이미 있던 것을 돌려주는 길에서는 뒷일(팀원 등록·감사·외부 푸시·임베딩)을 다시 하지 않는다 — 첫 생성이 이미 했다.
  if (made.deduped) return made.row;
  const row = made.row;
  // 팀원 초기 등록(project_member).
  for (const memberId of input.members ?? []) {
    await itemsPool.query(
      `INSERT INTO project_member(project_id, member_id, role, added_at)
       VALUES($1,$2,'member',now()) ON CONFLICT (tenant_id, project_id, member_id) DO NOTHING`,
      [row.id, memberId]);
  }
  await auditProject(String(row.id), "insert", null, row, ctx);
  await enqueueExternalPush(row.id, "upsert", ctx); // 외부 푸시(create) — 드레인이 컨테이너/부모 해소 후 ClickUp 생성+링크백.
  await markProjectEmbeddingPending(row.id); // #631/#1053 검색 임베딩 — pending 마킹(백그라운드 스윕이 채움)
  return row;
}

// 프로젝트 본문 1행(자식·정션 조인 없이) — 소유권 확인 등 가벼운 조회용. 없으면 undefined.
export async function getProjectRow(id: number): Promise<ProjectRow | undefined> {
  return one(itemsPool, `SELECT ${PROJECT_COLS} FROM project WHERE id=$1 AND level='project'`, [id]);
}

// 리스트(영역) 1행 — 생성 시 list_id 유효성 확인용(없으면 undefined → capability 가 400).
export async function getProjectListRow(id: number): Promise<{ id: number; name: string } | undefined> {
  return one(itemsPool, `SELECT id, name FROM project_list WHERE id=$1`, [id]);
}

// 내 상태 메시지(이 프로젝트 한정) 저장 — project_member.status_message 를 (project,member) 단위로 갱신.
//  팀원 행이 없으면(생성자라서 멤버 미등록 등) 만들어 둔다. 빈 문자열은 NULL 로 저장(상태 없음).
export async function setProjectMemberStatus(projectId: number, memberId: string, message: string | null): Promise<string | null> {
  const msg = (message ?? '').trim() || null;
  await itemsPool.query(
    `INSERT INTO project_member(project_id, member_id, status_message) VALUES($1,$2,$3)
     ON CONFLICT (tenant_id, project_id, member_id) DO UPDATE SET status_message=EXCLUDED.status_message`,
    [projectId, memberId, msg]);
  return msg;
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
  if (before.external_id) await enqueueExternalPush(id, "delete", ctx, before.external_id); // 외부 푸시(delete) — 미러된 것만.
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
  if (before.external_id) await enqueueExternalPush(id, "delete", ctx, before.external_id); // 외부 푸시(delete) — 미러된 것만.
  return before;
}

// 복원 — 마지막 delete 의 before 스냅샷(프로젝트 본문 1행)을 원래 id 로 재적재한다. 자식 작업·팀원·
//  카테고리/지식 연결은 삭제 시 cascade 됐으므로 복원되지 않는다(프로젝트 본체만). 이미 존재하면 거부.
//  사람전용 게이트는 capability 계층(content_restore)에서 선행.
export async function restoreProject(before: Record<string, unknown>, ctx?: WriteCtx): Promise<ProjectRow> {
  const after = await restoreSnapshot<ProjectRow>("project", PROJECT_COLS, "id", before);
  await auditProject(String(after.id), "restore", null, after, ctx);
  await markProjectEmbeddingPending(after.id); // #631/#1053 복원 행 재임베딩 — pending 마킹(백그라운드 스윕이 채움)
  return after;
}

export async function updateProjectStatus(id: number, status: string, ctx?: WriteCtx, statusRaw?: string | null): Promise<ProjectRow> {
  const before: ProjectRow | undefined = await one(itemsPool,
    `SELECT ${PROJECT_COLS} FROM project WHERE id=$1 AND level='project'`, [id]);
  if (!before) throw new Error(`프로젝트 #${id} 없음`);
  // done → 완료시각 기록, active 복귀 → 완료시각 해제.
  // status_raw = 리스트 커스텀 상태명(개방 어휘, #475). undefined=무변경(기존 보존), null=해제, 그 외=설정.
  const rawGiven = statusRaw !== undefined;
  const after: ProjectRow = await one(itemsPool,
    `UPDATE project SET status=$2, status_category=$3,
       status_raw = CASE WHEN $5::bool THEN $4 ELSE status_raw END,
       completed_at=CASE WHEN $2='done' THEN now() ELSE NULL END, updated_at=now()
     WHERE id=$1 RETURNING ${PROJECT_COLS}`, [id, status, categoryOf(status), statusRaw ?? null, rawGiven]);
  await auditProject(String(id), "set_status", before, after, ctx);
  await enqueueExternalPush(id, "upsert", ctx); // 외부 푸시(status) — 드레인이 ClickUp 상태 PUT.
  return after;
}

// 아카이브(#1851) — 프로젝트를 통째로 보관(archived_at=now())하거나 되돌린다(NULL). 삭제가 아니다: 태스크·팀원·지식 연결·
//  세션 전부 그대로고, 목록(listProjects 기본 exclude)과 새 셸 사이드바에서만 빠진다. 감사는 op='archive'|'unarchive'.
export async function setProjectArchived(id: number, archived: boolean, ctx?: WriteCtx): Promise<ProjectRow> {
  const before: ProjectRow | undefined = await one(itemsPool,
    `SELECT ${PROJECT_COLS} FROM project WHERE id=$1 AND level='project'`, [id]);
  if (!before) throw new Error(`프로젝트 #${id} 없음`);
  if (!!before.archived_at === archived) return before;   // 이미 그 상태 — 멱등(감사도 남기지 않는다)
  const after: ProjectRow = await one(itemsPool,
    `UPDATE project SET archived_at = CASE WHEN $2::bool THEN now() ELSE NULL END, updated_at=now()
     WHERE id=$1 AND level='project' RETURNING ${PROJECT_COLS}`, [id, archived]);
  await auditProject(String(id), archived ? "archive" : "unarchive", before, after, ctx);
  return after;
}

// 휴지통(#1851) — 프로젝트를 통째로 버리거나(trashed_at=now()) 되돌린다(NULL). 행은 남는다 — 하드 삭제는 완전 삭제(deleteProject)에서.
//  세션 묶음은 capability 가 함께 처리한다(sessions/session-trash-ops). 감사 op='trash'|'untrash'.
export async function setProjectTrashed(id: number, trashed: boolean, ctx?: WriteCtx): Promise<ProjectRow> {
  const before: ProjectRow | undefined = await one(itemsPool,
    `SELECT ${PROJECT_COLS} FROM project WHERE id=$1 AND level='project'`, [id]);
  if (!before) throw new Error(`프로젝트 #${id} 없음`);
  if (!!before.trashed_at === trashed) return before;
  const after: ProjectRow = await one(itemsPool,
    `UPDATE project SET trashed_at = CASE WHEN $2::bool THEN now() ELSE NULL END, updated_at=now()
     WHERE id=$1 AND level='project' RETURNING ${PROJECT_COLS}`, [id, trashed]);
  await auditProject(String(id), trashed ? "trash" : "untrash", before, after, ctx);
  return after;
}

// 프로젝트 이름/설명 수정(level='project'). 주어진 키만 변경(부재=무변경, description null=해제).
//  append_description: 전체 교체 대신 기존 본문 끝에 이어쓰기(원문 보존·보강). description 과 상호배타(capability 가 게이트).
export async function updateProject(
  id: number,
  patch: Partial<{ name: string; description: string | null; append_description: string;
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
  // append 모드 — 기존 본문 보존 후 끝에 이어붙인다. 읽고-쓰기 경합을 피하려 SQL 에서 원자적 concat:
  //  빈/NULL 본문이면 구분자 없이 그대로, 아니면 빈 줄(newline×2)로 문단 분리. description(교체)과는 상호배타(capability 게이트).
  else if (patch.append_description !== undefined) {
    vals.push(patch.append_description);
    const p = `$${vals.length}`;
    sets.push(`description = CASE WHEN description IS NULL OR description = '' THEN ${p} ELSE description || chr(10) || chr(10) || ${p} END`);
  }
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
  await enqueueExternalPush(id, "upsert", ctx); // 외부 푸시(name/desc/필드) — 드레인이 ClickUp PUT.
  // 이름/설명이 '실제로 바뀐' 경우에만 재임베딩 — 필드 존재(patch)가 아니라 before↔after 값 비교. no-op·미변경 저장,
  //  잦은 웹 인라인편집·MCP·ClickUp writeback 이 텍스트를 그대로 실어보내도 헛임베딩 방지(임베딩 부하 = 실제 텍스트 변경 수). #624/#631
  if (after.name !== before.name || (after.description ?? null) !== (before.description ?? null))
    await markProjectEmbeddingPending(id);
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

// 프로젝트 접근 가능자 전원(id) — 생성자(created_by) ∪ 팀원(project_member). 게이트웨이 프로젝트 세션 attach 게이트
//  (isProjectMember)와 **같은 집합**을 뽑아, 노드 프로젝트 세션의 공동입장 스냅샷(#905 C4)으로 넘긴다: 노드 세션
//  가시성은 owner∪invites 라, 이 집합을 초대목록으로 노드에 넘겨야 생성자 외 다른 멤버도 입장할 수 있다.
export async function listProjectMemberIds(projectId: number): Promise<string[]> {
  const rows = await q(itemsPool,
    // level='project' 로 자기방어 — task/subtask id 를 넘겨도 그 created_by 를 '멤버'로 오인하지 않는다(sibling isProjectMember 와 정합).
    `SELECT created_by AS member_id FROM project WHERE id=$1 AND level='project' AND created_by IS NOT NULL
     UNION
     SELECT member_id FROM project_member WHERE project_id=$1`, [projectId]);
  return rows.map((r) => r.member_id).filter((x: unknown): x is string => typeof x === "string" && x.length > 0);
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
  await enqueueExternalPush(row.id, "upsert", ctx); // 외부 푸시(create) — 드레인이 컨테이너/부모 해소 후 ClickUp 생성+링크백.
  await markProjectEmbeddingPending(row.id); // #631/#1053 검색 임베딩 — pending 마킹(백그라운드 스윕이 채움)
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
  await enqueueExternalPush(id, "upsert", ctx); // 외부 푸시(status) — 드레인이 ClickUp 상태 PUT.
  return after;
}

// 작업 재정렬(#366) — 주어진 순서(ids)대로 sort 를 0,1,2… 로 다시 매긴다. 형제 작업 목록의 순서 저장 전용.
//  프론트가 항상 '실제 형제 전체'를 화면 순서대로 넘기므로 parent 검증 없이 sort 만 재부여한다(태스크 SELECT 는 ORDER BY sort,id).
//  level 가드로 프로젝트(level='project') 행은 절대 건드리지 않는다. id 는 파라미터 바인딩, sort 는 배열 인덱스(정수 리터럴, 안전).
export async function reorderTasks(ids: number[], _ctx?: WriteCtx): Promise<{ updated: number }> {
  const clean = (ids || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
  if (clean.length < 2) return { updated: 0 };
  const tuples = clean.map((_id, i) => `($${i + 1}::int, ${i}::int)`).join(", ");
  const res = await itemsPool.query(
    `UPDATE project AS p SET sort = v.sort, updated_at = now()
       FROM (VALUES ${tuples}) AS v(id, sort)
      WHERE p.id = v.id AND p.level IN ('task','subtask')`, clean);
  return { updated: res.rowCount || 0 };
}

// 프로젝트 행 재정렬(#541 수동 정렬) — reorderTasks 동형, level='project' 전용. 그룹 내 드래그가 화면 순서
//  전체(그 그룹의 형제 프로젝트 id들)를 넘기면 sort=0,1,2… 재부여. 표시 우선순위는 프론트 비교자(sort → ClickUp
//  ext_orderindex → 최신순)가 담당 — sort 는 로컬 전용(커넥터 불간섭)이라 재정렬이 싱크에 덮이지 않는다.
export async function reorderProjects(ids: number[], _ctx?: WriteCtx): Promise<{ updated: number }> {
  const clean = (ids || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
  if (clean.length < 2) return { updated: 0 };
  const tuples = clean.map((_id, i) => `($${i + 1}::int, ${i + 1}::int)`).join(", "); // sort 1부터 — 0(미지정 기본값)과 구분
  // updated_at 은 건드리지 않는다 — 순서는 내용 변경이 아니고, 갱신일 컬럼(#541 원본시각 보존)을 오염시키면 안 된다.
  const res = await itemsPool.query(
    `UPDATE project AS p SET sort = v.sort
       FROM (VALUES ${tuples}) AS v(id, sort)
      WHERE p.id = v.id AND p.level = 'project'`, clean);
  return { updated: res.rowCount || 0 };
}

// 작업 필드 패치 — name/description/status/priority/assignee/start_date/due_date 중 **주어진 키만** 갱신.
//  undefined=변경 없음, null=값 비우기(예: 담당자/마감일 해제). status 갱신 시 completed_at 동기(done→now, 그 외→NULL).
//  리스트뷰 인라인 편집의 단일 진입점(상태칩·담당자·마감일·우선순위). status 전용 updateTaskStatus 와 병존(토글은 그쪽).
export async function updateTask(
  id: number,
  patch: Partial<{
    name: string; description: string | null; append_description: string; status: string; status_raw: string | null;
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
  // append 모드 — 기존 본문 보존 후 끝에 이어붙인다(전체 교체 아님). SQL 원자적 concat: 빈/NULL 본문이면 구분자 없이,
  //  아니면 빈 줄(newline×2)로 문단 분리. description(교체)과는 상호배타(capability 게이트). project 본문과 동형(#357).
  else if (patch.append_description !== undefined) {
    vals.push(patch.append_description);
    const p = `$${vals.length}`;
    sets.push(`description = CASE WHEN description IS NULL OR description = '' THEN ${p} ELSE description || chr(10) || chr(10) || ${p} END`);
  }
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
  // #731 리스트 커스텀 상태 키(개방 어휘). status 와 함께(또는 단독) 지정 — 태스크도 프로젝트처럼 status_raw 로 커스텀 상태 보존.
  //  주어졌을 때만 갱신(부재=무변경, null=해제). 커스텀 리스트 태스크는 항상 status_raw 를 함께 보낸다.
  if (patch.status_raw !== undefined) set("status_raw", patch.status_raw);
  if (!sets.length) return before; // 패치 비어있음 — no-op

  sets.push("updated_at=now()");
  vals.push(id);
  const after: ProjectRow = await one(itemsPool,
    `UPDATE project SET ${sets.join(", ")} WHERE id=$${vals.length} RETURNING ${PROJECT_COLS}`, vals);
  // 단일 assignee 변경 시 task_assignee n:n 동기(전환기 가산 섀도 일관성).
  if (patch.assignee !== undefined) await syncTaskAssignees(id, patch.assignee ? [patch.assignee] : []);
  await auditProject(String(id), "update", before, after, ctx);
  await enqueueExternalPush(id, "upsert", ctx); // 외부 푸시(name/desc/필드) — 드레인이 ClickUp PUT.
  // 이름/설명이 '실제로 바뀐' 경우에만 재임베딩 — before↔after 값 비교(필드 존재가 아니라). 상태·담당자·기간 인라인
  //  편집이 잦아도(웹 blur 저장 등) 텍스트가 안 바뀌면 스킵 → 임베딩 부하 = 실제 텍스트 변경 수로 상한. #624/#631
  if (after.name !== before.name || (after.description ?? null) !== (before.description ?? null))
    await markProjectEmbeddingPending(id);
  return after;
}

// 작업(task/subtask) 노드의 루트 프로젝트(level='project') id 해석 — AGENTS.md 태스크 인덱스 재생성 대상.
//  task 면 parent_id 가 곧 프로젝트, subtask 면 부모 task 를 한 단계 더 거슬러 올라간다. 해석 실패 시 undefined.
export async function rootProjectIdOfTaskNode(node: { level: string; parent_id: number | null }): Promise<number | undefined> {
  if (node.level === "task") return node.parent_id ?? undefined;
  if (node.level === "subtask") {
    if (node.parent_id == null) return undefined;
    const parent: ProjectRow | undefined = await one(itemsPool,
      `SELECT ${PROJECT_COLS} FROM project WHERE id=$1`, [node.parent_id]);
    return parent?.parent_id ?? undefined;
  }
  return undefined;
}

// ── 정션: 카테고리/지식 연결 ──────────────────────────────────────────────
//  카테고리(도메인)는 이제 **소속 리스트가 소유**(#541 후속) — 프로젝트 단위 매핑을 리스트 category_id 로 대체.
//  아래 project 카테고리 툴들은 하위호환을 위해 **프로젝트가 속한 리스트의 카테고리**를 설정한다(형제 프로젝트 공유).
//  프로젝트가 리스트에 없으면(미분류) no-op — 먼저 리스트에 넣어야 카테고리를 이을 수 있다.
//  반환: { applied, listId, changed } — applied=리스트가 있어 반영 가능했는지(호출자 응답 정직성),
//   changed=실제 값이 바뀌었는지(형제 AGENTS.md 재생성 트리거 판단), listId=영향받은 리스트(형제 열거용).
export async function setListCategoryForProject(projectId: number, categoryId: number | null, ctx?: WriteCtx): Promise<{ applied: boolean; listId: number | null; changed: boolean }> {
  const row: { list_id: number | null; category_id: number | null } | undefined = await one(itemsPool,
    `SELECT p.list_id, pl.category_id FROM project p LEFT JOIN project_list pl ON pl.id=p.list_id WHERE p.id=$1`, [projectId]);
  const listId = row?.list_id ?? null;
  if (listId == null) return { applied: false, listId: null, changed: false }; // 미분류 프로젝트 — 소유할 리스트가 없어 no-op
  const before = row?.category_id ?? null;
  const next = categoryId != null && Number(categoryId) > 0 ? Number(categoryId) : null;
  if (before === next) return { applied: true, listId, changed: false }; // 무변경 — 허위 audit 방지
  await itemsPool.query(`UPDATE project_list SET category_id=$2, updated_at=now() WHERE id=$1`, [listId, next]);
  await auditOrgContent("project_list", String(listId), "set_category", { category_id: before }, { category_id: next }, ctx);
  return { applied: true, listId, changed: true };
}
export async function linkProjectCategory(projectId: number, categoryId: number, ctx?: WriteCtx): Promise<{ applied: boolean; listId: number | null; changed: boolean }> {
  return setListCategoryForProject(projectId, categoryId, ctx);
}

export async function unlinkProjectCategory(projectId: number, categoryId: number, ctx?: WriteCtx): Promise<{ applied: boolean; listId: number | null; changed: boolean }> {
  // 해제 — 현재 리스트 카테고리가 그 값일 때만 NULL 로(다른 값이면 무시, 오삭제·허위 audit 방지).
  const row: { list_id: number | null; category_id: number | null } | undefined = await one(itemsPool,
    `SELECT p.list_id, pl.category_id FROM project p LEFT JOIN project_list pl ON pl.id=p.list_id WHERE p.id=$1`, [projectId]);
  const listId = row?.list_id ?? null;
  if (listId == null || row?.category_id == null || Number(row.category_id) !== Number(categoryId)) return { applied: listId != null, listId, changed: false };
  return setListCategoryForProject(projectId, null, ctx);
}

// 리스트에 속한 프로젝트(level='project') id — 리스트 카테고리 변경 시 형제 전부의 AGENTS.md 재생성 대상 열거(#541 후속 F4).
export async function projectIdsInList(listId: number): Promise<number[]> {
  if (!Number.isInteger(Number(listId)) || Number(listId) <= 0) return [];
  const rows = await q(itemsPool, `SELECT id FROM project WHERE list_id=$1 AND level='project'`, [listId]);
  return rows.map((r) => Number(r.id)).filter((n) => Number.isInteger(n) && n > 0);
}
// 프로젝트의 소속 리스트 id(미분류면 null) — 카테고리 변경 후 형제 AGENTS.md 재생성 스코프 해소용.
export async function listIdOfProject(projectId: number): Promise<number | null> {
  const row: { list_id: number | null } | undefined = await one(itemsPool, `SELECT list_id FROM project WHERE id=$1`, [projectId]);
  return row?.list_id ?? null;
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

// ── 카테고리 설정 — 이제 **소속 리스트의 카테고리**를 정한다(#541 후속). 카테고리는 리스트 소유·프로젝트 상속(단일). ──
//  하위호환: categoryIds 배열을 받지만 첫 항목만 사용(리스트는 0~1개 카테고리). 빈 배열=해제. 반환=적용된 카테고리 배열(0~1).
export async function setProjectCategories(projectId: number, categoryIds: number[], ctx?: WriteCtx): Promise<number[]> {
  const clean = [...new Set((categoryIds || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
  const catId = clean.length ? clean[0] : null;
  const res = await setListCategoryForProject(projectId, catId, ctx);
  // 리스트 없는(미분류) 프로젝트엔 반영 못 함 → 빈 배열로 정직하게 응답(catId 를 되돌려 성공을 가장하지 않음).
  return res.applied && catId != null ? [catId] : [];
}

export async function unlinkProjectKnowledge(projectId: number, name: string, relation: string, ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(
    `DELETE FROM project_knowledge WHERE project_id=$1 AND name=$2 AND relation=$3`, [projectId, name, relation]);
  await auditProject(String(projectId), "unlink_knowledge", { name, relation }, null, ctx);
}

// ── 프로젝트↔프로젝트 엣지(project_edge) — from --relation--> to. follow_up: from 이 to 의 후속(from=후속, to=선행). ──
export async function linkProjectEdge(fromId: number, toId: number, relation: string, ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(
    `INSERT INTO project_edge(from_project_id, to_project_id, relation, created_by)
     VALUES($1,$2,$3,$4) ON CONFLICT (from_project_id, to_project_id, relation) DO NOTHING`,
    [fromId, toId, relation, ctx?.actor ?? null]);
  await auditProject(String(fromId), "link_project", null, { to: toId, relation }, ctx);
}
export async function unlinkProjectEdge(fromId: number, toId: number, relation: string, ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(
    `DELETE FROM project_edge WHERE from_project_id=$1 AND to_project_id=$2 AND relation=$3`, [fromId, toId, relation]);
  await auditProject(String(fromId), "unlink_project", { to: toId, relation }, null, ctx);
}

// 역방향 조회 — 이 지식을 필요(required)/산출(produced)로 연결한 프로젝트 목록(위키 상세 '연결된 프로젝트').
//  보드 앵커(__board_anchor__) 숨김 프로젝트는 제외. relation·이름 순.
export async function projectsForKnowledge(name: string): Promise<{ project_id: number; project_name: string; status: string; relation: string }[]> {
  const rows = await q(itemsPool,
    `SELECT pk.project_id, pk.relation, p.name AS project_name, p.status
     FROM project_knowledge pk JOIN project p ON p.id=pk.project_id
     WHERE pk.name=$1 AND p.folder IS DISTINCT FROM '__board_anchor__'
     ORDER BY pk.relation, lower(p.name)`, [name]);
  return rows.map((r) => ({ project_id: Number(r.project_id), project_name: r.project_name, status: r.status, relation: r.relation }));
}

// 필요지식 추천(벡터검색 #172) — 노드(프로젝트·작업) 이름+설명(의미) + **소속 카테고리 공유(가산점·구제)** 로 지식 추천.
//  이미 연결된(required/produced) 지식은 제외. 임베딩 off 여도 카테고리만으로 추천 가능(graceful). 설명·카테고리 둘 다 없으면 빈 배열.
//  '✨ 자동으로 고르기'(웹) + project_recommend_knowledge_v6(MCP) + 생성 시 prior-art 표면화(#639)의 데이터. 카테고리 인지 랭킹은 findRecommendedKnowledge.
//  nodeId 는 프로젝트뿐 아니라 task/subtask 도 받는다(같은 project 테이블) — task 는 자기 이름+설명으로 검색하되 카테고리는 부모 프로젝트에서 상속.
export async function recommendKnowledgeForProject(
  nodeId: number, opts: { limit?: number; minScore?: number; viewer?: Viewer } = {},
): Promise<KnowledgeRecommendRow[]> {
  const node = await getProjectRow(nodeId);
  if (!node) throw new Error(`프로젝트/작업 #${nodeId} 없음`);
  const text = [node.name, node.description].map((s) => (s ?? "").trim()).filter(Boolean).join("\n\n");
  // 카테고리 신호 = 소속 리스트에서 상속(#541 후속 — project_category 대체). 리스트 미지정/미분류면 카테고리 신호 없음.
  //  task/subtask 는 createTask 가 list_id 를 넣지 않아 생성 직후엔 비어 있다(나중에 채워짐) → 생성 시 prior-art 호출
  //  시점엔 자기 list_id 로 카테고리를 못 잡으므로, 부모를 타고 올라가 소속 프로젝트의 리스트 카테고리를 잇는다(#639 — project/task 공용).
  const catRows = await q(itemsPool,
    `WITH RECURSIVE anc(id, parent_id, list_id) AS (
       SELECT id, parent_id, list_id FROM project WHERE id=$1
       UNION ALL
       SELECT p.id, p.parent_id, p.list_id FROM project p JOIN anc ON p.id=anc.parent_id
     )
     SELECT pl.category_id FROM anc JOIN project_list pl ON pl.id=anc.list_id
      WHERE pl.category_id IS NOT NULL LIMIT 1`, [nodeId]);
  const categoryIds = catRows.map((r) => Number(r.category_id)).filter((n) => Number.isInteger(n) && n > 0);
  const linkedRows = await q(itemsPool, `SELECT name FROM project_knowledge WHERE project_id=$1`, [nodeId]);
  const exclude = linkedRows.map((r) => r.name);
  if (!text && !categoryIds.length) return [];   // 의미·카테고리 신호 둘 다 없음 → 추천 불가
  // 추천도 그 사람이 볼 수 있는 지식만 — 안 보이는 지식을 "이거 참고하세요"로 들이밀면 제목이 그대로 새어나간다(#1291).
  return findRecommendedKnowledge({
    text, categoryIds, exclude, limit: opts.limit ?? 10, minScore: opts.minScore,
  }, opts.viewer);
}

// ── 프로젝트 검색(#631) — grep(name/description) + 벡터(임베딩) RRF 하이브리드. knowledge 검색과 동형(search-util 공유). ──
//  아직 UI 미정 → 백엔드 API 만. project_grep(정확 토큰/정규식) + project_search(의미·하이브리드) 두 표면.
//  대상 = project·task·subtask 전부(level 필터로 좁힘). 내부 보드 앵커(__board_anchor__)는 항상 제외.
//  결과는 knowledge 와 동일하게 전문(description) 미포함 — 매치 줄 스니펫만, 전문은 project_get_v6/task_detail_v6.
export interface ProjectSearchRow {
  id: number; level: string; parent_id: number | null;
  name: string; status: string; status_category: string | null;
  list_id: number | null; updated_at: string;
  snippet?: string;   // names 모드 생략
  score?: number;     // 하이브리드(project_search) RRF 점수 — grep(searchProjects)은 미설정
}
export type ProjectGrepMode = "snippets" | "names" | "count";
// viewer(#1291) — 검색도 목록과 같은 공개범위를 탄다. 목록은 막히는데 검색으로 이름·본문 스니펫이 새면
//  "가려졌다"는 약속이 표면마다 달라진다(가장 흔한 우회로).
export interface ProjectSearchOpts { level?: string; listId?: number; status?: string; limit?: number; mode?: ProjectGrepMode; context?: number; viewer?: Viewer }

// grep 결과 SELECT — 전문(description)은 스니펫 계산용으로만, 응답에선 뺀다(전문 누출·토큰폭주 방지).
const P_GREP_SEL = ["id", "level", "parent_id", "name", "description", "status", "status_category", "list_id", "updated_at"]
  .map((c) => "p." + c).join(", ");
const P_GREP_NAMES_SEL = ["id", "level", "parent_id", "name", "status", "status_category", "list_id", "updated_at"]
  .map((c) => "p." + c).join(", ");
// 내부 보드 앵커(__board__)는 검색 대상 아님(listProjects 도 제외) — task/subtask 는 folder NULL 이라 통과.
const P_SEARCH_BASE = "p.folder IS DISTINCT FROM '__board_anchor__'";

// 공통 WHERE(grep 매처 + 앵커 제외 + level/list_id/status 필터). params 에 push 하고 절 문자열 반환.
function projectGrepWhere(plan: GrepPlan, opts: ProjectSearchOpts, params: unknown[], visIds?: Set<number> | null): string {
  const wh: string[] = [grepWhere(["p.name", "p.description"], plan, params), P_SEARCH_BASE];
  if (opts.level) { params.push(opts.level); wh.push(`p.level=$${params.length}`); }
  if (opts.listId != null) { params.push(opts.listId); wh.push(`p.list_id=$${params.length}`); }
  if (opts.status) { params.push(opts.status); wh.push(`p.status=$${params.length}`); }
  // 공개범위(#1291) — 태스크/서브태스크는 자기 list_id 가 비어 있으므로 **조상 프로젝트**의 list_id 로 판정한다.
  //  (자기 행 기준으로 걸면 잠긴 프로젝트의 태스크가 'NULL=전원'으로 전부 새어나간다.)
  if (visIds !== undefined) wh.push(listIdPredicate(PROJECT_ROW_LIST_ID_SQL, visIds));
  return wh.join(" AND ");
}

// 행이 속한 **프로젝트의** list_id — 프로젝트 행은 자기 값, task/subtask 는 부모(→조부모)를 타고 올라간다.
//  ⚠ 프로젝트 행(parent_id NULL)에서 서브쿼리만 쓰면 결과가 NULL 이 되어 '미분류=전원'으로 오판한다 → COALESCE 순서가 중요.
const PROJECT_ROW_LIST_ID_SQL = `COALESCE(p.list_id, (
  SELECT pr2.list_id FROM project par2
    LEFT JOIN project pr2 ON pr2.id = CASE WHEN p.level='subtask' THEN par2.parent_id ELSE par2.id END
   WHERE par2.id = p.parent_id))`;

function toProjectRow(r: Record<string, unknown>): ProjectSearchRow {
  return {
    id: Number(r.id), level: r.level as string, parent_id: r.parent_id == null ? null : Number(r.parent_id),
    name: r.name as string, status: r.status as string, status_category: (r.status_category as string | null) ?? null,
    list_id: r.list_id == null ? null : Number(r.list_id), updated_at: r.updated_at as string,
  };
}

// mode='count' — 매치 총건수만(페이징·존재확인용).
export async function countProjectGrep(qstr: string, opts: ProjectSearchOpts = {}): Promise<number> {
  const visIds = opts.viewer === undefined ? undefined : await visibleListIds(opts.viewer);
  const { result } = await grepExec(qstr, async (plan) => {
    const params: unknown[] = [];
    const where = projectGrepWhere(plan, opts, params, visIds);
    const rows = await q(itemsPool, `SELECT count(*)::int AS n FROM project p WHERE ${where}`, params);
    return Number(rows[0]?.n ?? 0);
  });
  return result;
}

// grep — name/description 매칭(정규식 또는 토큰 AND) → 매치 줄 스니펫. 의미검색 아님(그건 hybridSearchProjects). 최신순.
export async function searchProjects(qstr: string, opts: ProjectSearchOpts = {}): Promise<ProjectSearchRow[]> {
  const withBody = opts.mode !== "names";
  const sel = withBody ? P_GREP_SEL : P_GREP_NAMES_SEL;
  const visIds = opts.viewer === undefined ? undefined : await visibleListIds(opts.viewer);
  const { result: rows, plan } = await grepExec(qstr, async (p) => {
    const params: unknown[] = [];
    const where = projectGrepWhere(p, opts, params, visIds);
    params.push(Math.min(opts.limit ?? 20, 100));
    return q(itemsPool, `SELECT ${sel} FROM project p WHERE ${where} ORDER BY p.updated_at DESC LIMIT $${params.length}`, params);
  });
  return rows.map((r) => {
    const base = toProjectRow(r);
    if (withBody) base.snippet = grepSnippet((r.description as string | null) ?? "", plan, opts.context, "project_get_v6");
    return base;
  });
}

// ── 하이브리드 검색(project_search) — 벡터(cosine) ∪ 렉시컬(grep) RRF 융합. knowledge hybridSearchKnowledge 와 동형. ──
//  임베딩 off / 쿼리 임베딩 실패 / SQL 실패 → 전부 searchProjects(렉시컬)로 폴백(하위호환·safe-by-construction).
export async function hybridSearchProjects(qstr: string, opts: ProjectSearchOpts = {}): Promise<ProjectSearchRow[]> {
  const provider = await activeEmbeddingProvider();
  if (!provider) return searchProjects(qstr, opts);          // off → grep 그대로
  let qvec: number[] | null = null;
  try { const [v] = await provider.embed([qstr]); qvec = v && v.length ? v : null; } catch { qvec = null; }
  if (!qvec) return searchProjects(qstr, opts);               // 쿼리 임베딩 실패 → 폴백
  try {
    const visIds = opts.viewer === undefined ? undefined : await visibleListIds(opts.viewer);
    return await rrfSearchProjects(qstr, qvec, opts, visIds);
  } catch (e) {
    console.warn(`[embeddings] 프로젝트 하이브리드 검색 실패 — 렉시컬 폴백: ${(e as Error)?.message}`);
    return searchProjects(qstr, opts);                        // pgvector 컬럼 부재 등 → 폴백
  }
}

// RRF 융합 = SQL 한 방(쿼리 임베딩은 JS 에서 계산해 $n::vector 로 주입). lex/vec CTE 각 후보 → row_number rank → RRF 점수.
//  knowledge rrfSearch 와 동일 골격(테이블·키·컬럼만 project). lex 채널은 최신순 랭크(knowledge 와 동일 — 렉시컬 상대순위 없음).
async function rrfSearchProjects(qstr: string, qvec: number[], opts: ProjectSearchOpts, visIds?: Set<number> | null): Promise<ProjectSearchRow[]> {
  const withBody = opts.mode !== "names";
  const sel = withBody ? P_GREP_SEL : P_GREP_NAMES_SEL;
  const limit = Math.min(opts.limit ?? 20, 100);
  const plan = parseGrep(qstr);
  const params: unknown[] = [];
  // 렉시컬 채널 WHERE — grep 매처 + 앵커 제외 + level/list/status(searchProjects 와 동일).
  //  ⚠ 공개범위 술어는 여기(후보 CTE)가 아니라 **최종 SELECT** 에 건다(아래) — 벡터 채널이 HNSW 근사탐색이라
  //   후보 단계에서 걸러내면 이웃 상위 N 개가 비가시 문서로 채워졌을 때 결과가 통째로 비는 리콜 붕괴가 난다.
  //   이름이 DB 밖으로 나가지 않으므로 최종 필터로도 누출은 없다.
  const lexWhere = projectGrepWhere(plan, opts, params);
  // 벡터 채널 WHERE — 같은 필터(+ 임베딩 보유 행만). params 공유.
  const vecWh: string[] = [P_SEARCH_BASE, `p.embedding_vector IS NOT NULL`];
  if (opts.level) { params.push(opts.level); vecWh.push(`p.level=$${params.length}`); }
  if (opts.listId != null) { params.push(opts.listId); vecWh.push(`p.list_id=$${params.length}`); }
  if (opts.status) { params.push(opts.status); vecWh.push(`p.status=$${params.length}`); }
  const vecWhere = vecWh.join(" AND ");
  params.push(toVectorLiteral(qvec)); const qp = `$${params.length}::vector`;
  params.push(HYBRID_CANDIDATES); const candP = `$${params.length}`;
  params.push(RRF_K); const kP = `$${params.length}`;
  params.push(limit); const limP = `$${params.length}`;
  const sql = `
    WITH lex AS (
      SELECT p.id, row_number() OVER (ORDER BY p.updated_at DESC) AS rank
      FROM project p WHERE ${lexWhere} ORDER BY p.updated_at DESC LIMIT ${candP}
    ),
    vec AS (
      SELECT p.id, row_number() OVER (ORDER BY p.embedding_vector <=> ${qp}) AS rank
      FROM project p WHERE ${vecWhere} ORDER BY p.embedding_vector <=> ${qp} LIMIT ${candP}
    ),
    fused AS (
      SELECT id, SUM(1.0/(${kP} + rank)) AS score
      FROM (SELECT id, rank FROM lex UNION ALL SELECT id, rank FROM vec) u
      GROUP BY id
    )
    SELECT ${sel}, f.score::float8 AS score
    FROM fused f JOIN project p ON p.id=f.id
    WHERE ${listIdPredicate(PROJECT_ROW_LIST_ID_SQL, visIds ?? null)}
    ORDER BY f.score DESC LIMIT ${limP}`;
  const rows = await q(itemsPool, sql, params);
  return rows.map((r) => {
    const base = toProjectRow(r);
    base.score = Number(r.score);
    if (withBody) base.snippet = grepSnippet((r.description as string | null) ?? "", plan, opts.context, "project_get_v6");
    return base;
  });
}

// ── 유사 프로젝트(절대 코사인, #1762) — knowledge findSimilarKnowledge 와 동형. ──
//  hybridSearchProjects(RRF) 와 직교: RRF 점수는 **순위 역수**(Σ 1/(k+rank))라 절대 의미가 없다 —
//  무관한 질의에도 상위 N 이 늘 나오므로 "관련 있으면 보여주고 없으면 아무것도 안 한다"는 게이팅에 쓸 수 없다.
//  (실측 2026-08-18: 무관 질의 top5 가 0.0164·0.0161·0.0159… 로 촘촘 — 임계를 그을 자리가 없다.)
//  이건 코사인 유사도(0~1)를 그대로 돌려주므로 minScore 로 임계 비교가 된다. 용도: 세션↔프로젝트 연결 후보
//  회수(훅), 신규 프로젝트 생성 전 중복 확인. 임베딩 off / 대상 미임베딩이면 **빈 결과**(폴백 없음 — 벡터 전용).
export interface ProjectSimilarRow extends ProjectSearchRow { similarity: number }
export interface ProjectSimilarOpts {
  text?: string;          // 기준 텍스트(즉시 임베딩) — id 와 택일
  id?: number;            // 기준 프로젝트(저장된 임베딩 재사용, 자기 제외) — text 와 택일
  limit?: number; minScore?: number;
  level?: string; listId?: number; status?: string;
  includeDone?: boolean;  // 기본 false — done·canceled 는 제외(연결 후보로 죽은 프로젝트를 권하지 않는다)
  viewer?: Viewer;
}
export async function findSimilarProjects(opts: ProjectSimilarOpts = {}): Promise<ProjectSimilarRow[]> {
  // 1) 쿼리 벡터 리터럴 — id(저장된 벡터 재사용, 재임베딩 불요) 또는 text(즉시 임베딩).
  const visIds = opts.viewer === undefined ? undefined : await visibleListIds(opts.viewer);
  let vecLiteral: string | null = null;
  if (opts.id != null) {
    // 기준 프로젝트도 볼 수 있어야 한다 — 안 보이는 프로젝트의 임베딩으로 이웃을 훑는 건 그 프로젝트를
    //  지렛대 삼아 "무엇에 대한 일인가"를 역추적하는 우회로다(knowledge similar 의 assertKnowledgeVisible 과 같은 이유).
    const vis = visIds === undefined ? "TRUE" : listIdPredicate(PROJECT_ROW_LIST_ID_SQL, visIds);
    const r = await one(itemsPool, `SELECT p.embedding_vector::text AS v FROM project p WHERE p.id=$1 AND ${vis}`, [opts.id]);
    vecLiteral = (r as { v?: string | null } | undefined)?.v ?? null;   // 미임베딩·비가시 → null → []
  } else if (opts.text && opts.text.trim()) {
    const provider = await activeEmbeddingProvider();
    if (!provider) return [];                                          // 임베딩 off → 유사 없음
    try {
      const [v] = await provider.embed([opts.text.slice(0, 8000)]);
      vecLiteral = v && v.length ? toVectorLiteral(v) : null;
    } catch { return []; }                                             // 쿼리 임베딩 실패 → 빈 결과(폴백 아님)
  }
  if (!vecLiteral) return [];
  // 2) 최근접 — 코사인 거리 오름차순. 미임베딩·앵커·(기본)완료 제외, minScore 이상만.
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
  const minScore = typeof opts.minScore === "number" ? opts.minScore : 0;
  try {
    const params: unknown[] = [vecLiteral]; const qp = `$1::vector`;    // $1 = 쿼리 벡터(거리·유사도·정렬에 공유)
    const wh: string[] = [P_SEARCH_BASE, `p.embedding_vector IS NOT NULL`];
    if (opts.id != null) { params.push(opts.id); wh.push(`p.id <> $${params.length}`); }
    if (opts.level) { params.push(opts.level); wh.push(`p.level=$${params.length}`); }
    if (opts.listId != null) { params.push(opts.listId); wh.push(`p.list_id=$${params.length}`); }
    if (opts.status) { params.push(opts.status); wh.push(`p.status=$${params.length}`); }
    if (!opts.includeDone) wh.push(`COALESCE(p.status_category,'') NOT IN ('done','canceled')`);
    params.push(minScore); const minP = `$${params.length}`;
    params.push(Math.min(limit * 10, 500)); const candP = `$${params.length}`;   // 후보는 넓게(공개범위 필터 여유분)
    params.push(limit); const limP = `$${params.length}`;
    // ⚠ 공개범위 술어를 **후보 스캔(cand)에 넣지 않는다** — 이 스캔이 곧 HNSW 근사탐색(ORDER BY <=> … LIMIT)이라
    //  거기에 술어를 얹으면 탐색목록 안에서만 사후 필터돼 결과가 통째로 비는 리콜 붕괴가 난다(#1291 R2-#6, knowledge 와 동일).
    //  cand 가 level·parent_id·list_id 를 실어야 바깥 술어(PROJECT_ROW_LIST_ID_SQL, 별칭 p)가 그대로 붙는다.
    const vis = visIds === undefined ? "TRUE" : listIdPredicate(PROJECT_ROW_LIST_ID_SQL, visIds);
    const sql = `
      WITH cand AS (
        SELECT ${P_GREP_SEL}, (1 - (p.embedding_vector <=> ${qp}))::float8 AS similarity
        FROM project p
        WHERE ${wh.join(" AND ")} AND (1 - (p.embedding_vector <=> ${qp})) >= ${minP}
        ORDER BY p.embedding_vector <=> ${qp}
        LIMIT ${candP}
      )
      SELECT * FROM cand p
      WHERE ${vis}
      ORDER BY p.similarity DESC
      LIMIT ${limP}`;
    const rows = await q(itemsPool, sql, params);
    return rows.map((r) => {
      const base = toProjectRow(r) as ProjectSimilarRow;
      base.similarity = Number(r.similarity);
      base.snippet = previewBody((r.description as string | null) ?? "");   // 식별용 앞부분(전문은 project_get_v6)
      return base;
    });
  } catch (e) {
    console.warn(`[embeddings] 유사 프로젝트 조회 실패: ${(e as Error)?.message}`);
    return [];                                                          // pgvector 부재 등 → 빈 결과(검색·저장 무손상)
  }
}
