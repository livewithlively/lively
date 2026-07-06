// v6 커스텀 필드(클릭업형 컬럼) 데이터 접근 — 프로젝트(루트)에 필드를 정의하고, 그 아래 모든 task/subtask 가
//  필드별 값을 갖는다. 클릭업의 "+ 컬럼 추가 → 형식 지정"(Text·Number·Money·Date·Dropdown·Labels·Checkbox·
//  Website·Email·Phone·Rating·Progress·T-shirt·Location)을 우리 프로젝트 탭 <태스크> 박스에 그대로 옮긴 것.
//  field.config = 타입별 설정 JSONB(dropdown/labels=options[], money=currency, rating=max …),
//  value = 타입별 형태 JSONB(text=string, number=number, checkbox=bool, dropdown=optionId, labels=optionId[] …).
import { itemsPool } from "../items/store.js";
import { q, one } from "../domainmap/db.js";
import { type WriteCtx } from "../db/write.js";

// 지원 필드 타입 — 프론트 FIELD_TYPES 와 1:1(값 형태를 둘이 공유). 새 타입 추가 시 양쪽을 함께 늘린다.
export const FIELD_TYPES = [
  "text", "textarea", "number", "money", "date", "dropdown", "labels",
  "checkbox", "website", "email", "phone", "rating", "progress", "tshirt", "location",
  // 2차 확장: files(공유폴더 파일 참조 목록) · relationship(연결 태스크 목록) · progress_auto(하위 완료율 자동, 값 미저장).
  "files", "relationship", "progress_auto",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const FIELD_COLS = `id, project_id, field_type, name, config, sort, created_by, created_at, list_id`; // list_id(#607/D): 필드가 속한 리스트(NULL=전역)

// ── 조회 ──────────────────────────────────────────────────────────────────────
// 프로젝트(루트)의 필드 정의 — 정렬 순(추가 순). 값은 task 쪽에서 별도 페치.
export async function listProjectFields(projectId: number): Promise<any[]> {
  return q(itemsPool, `SELECT ${FIELD_COLS} FROM task_field WHERE project_id=$1 ORDER BY sort, id`, [projectId]);
}

// 여러 task/subtask 의 필드값 한 번에 — getProject 가 task 트리에 매핑(N+1 회피).
export async function getFieldValuesForTasks(taskIds: number[]): Promise<any[]> {
  if (!taskIds.length) return [];
  return q(itemsPool,
    `SELECT field_id, task_id, value FROM task_field_value WHERE task_id = ANY($1)`, [taskIds]);
}

// "기존 항목" 탭용 — 다른 프로젝트들에 이미 만든 필드 정의(이름·타입·설정)를 템플릿으로 가져오기. 중복 제거(이름+타입).
export async function listFieldCatalog(excludeProjectId: number): Promise<any[]> {
  return q(itemsPool,
    `SELECT DISTINCT ON (lower(name), field_type) id, name, field_type, config
     FROM task_field WHERE project_id <> $1
     ORDER BY lower(name), field_type, id DESC`, [excludeProjectId]);
}

// ── 필드 정의 쓰기 ──────────────────────────────────────────────────────────────
// 루트 프로젝트(level='project')에만 필드를 단다. sort = 기존 최대+1(맨 끝에 컬럼 추가).
export async function createField(
  projectId: number,
  input: { field_type: string; name: string; config?: unknown; list_id?: number | null },
  _ctx?: WriteCtx,
): Promise<any> {
  const ft = String(input.field_type);
  if (!(FIELD_TYPES as readonly string[]).includes(ft)) throw new Error(`알 수 없는 필드 타입: ${ft}`);
  const proj = await one(itemsPool, `SELECT id FROM project WHERE id=$1 AND level='project'`, [projectId]);
  if (!proj) throw new Error(`프로젝트 #${projectId} 없음`);
  const name = String(input.name ?? "").trim() || ft;
  // #607/D 리스트별 필드 — list_id 있으면 그 리스트 전용, 없으면 전역(NULL). sort 는 같은 스코프(전역 or 그 리스트) 안에서 최댓값+1.
  const listId = input.list_id != null ? Number(input.list_id) : null;
  if (listId != null) {
    const l = await one(itemsPool, `SELECT id FROM project_list WHERE id=$1`, [listId]);
    if (!l) throw new Error(`리스트 #${listId} 없음`);
  }
  const sortRow = await one(itemsPool,
    `SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM task_field WHERE project_id=$1 AND list_id IS NOT DISTINCT FROM $2`, [projectId, listId]);
  return one(itemsPool,
    `INSERT INTO task_field(project_id, field_type, name, config, sort, created_by, list_id)
     VALUES($1, $2, $3, $4::jsonb, $5, $6, $7)
     RETURNING ${FIELD_COLS}`,
    [projectId, ft, name.slice(0, 120), JSON.stringify(input.config ?? {}), sortRow.s, _ctx?.actor ?? null, listId]);
}

// 필드 정의 수정 — 이름/설정만(타입은 불변: 값 형태가 바뀌면 기존 값이 깨지므로). 주어진 키만 변경.
export async function updateField(
  fieldId: number,
  patch: { name?: string; config?: unknown },
  _ctx?: WriteCtx,
): Promise<any> {
  const before = await one(itemsPool, `SELECT ${FIELD_COLS} FROM task_field WHERE id=$1`, [fieldId]);
  if (!before) throw new Error(`필드 #${fieldId} 없음`);
  const sets: string[] = [];
  const params: unknown[] = [fieldId];
  if (patch.name != null) {
    const nm = String(patch.name).trim();
    if (!nm) throw new Error("이름은 비울 수 없습니다");
    params.push(nm.slice(0, 120)); sets.push(`name=$${params.length}`);
  }
  if (patch.config !== undefined) {
    params.push(JSON.stringify(patch.config ?? {})); sets.push(`config=$${params.length}::jsonb`);
  }
  if (!sets.length) return before;
  return one(itemsPool, `UPDATE task_field SET ${sets.join(", ")} WHERE id=$1 RETURNING ${FIELD_COLS}`, params);
}

// 필드 삭제 — 값(task_field_value)은 FK CASCADE 로 함께 제거(컬럼 통째 삭제).
export async function deleteField(fieldId: number, _ctx?: WriteCtx): Promise<{ id: number }> {
  const before = await one(itemsPool, `SELECT id FROM task_field WHERE id=$1`, [fieldId]);
  if (!before) throw new Error(`필드 #${fieldId} 없음`);
  await itemsPool.query(`DELETE FROM task_field WHERE id=$1`, [fieldId]);
  return { id: fieldId };
}

// ── 값 쓰기 ────────────────────────────────────────────────────────────────────
// 한 (task, field) 값 upsert. 빈값(null/''/[])=해제(행 삭제). false·0 은 유효값이라 보존.
//  안전: 필드의 소속 루트 프로젝트가 task 의 루트 프로젝트와 일치할 때만 허용(타 프로젝트 필드 오염 차단).
export async function setFieldValue(
  taskId: number,
  fieldId: number,
  value: unknown,
  _ctx?: WriteCtx,
): Promise<any> {
  const ok = await one(itemsPool,
    `SELECT 1 AS ok FROM task_field tf WHERE tf.id=$1 AND (
       tf.project_id = (
         WITH RECURSIVE up AS (
           SELECT id, parent_id, level FROM project WHERE id=$2
           UNION ALL SELECT p.id, p.parent_id, p.level FROM project p JOIN up ON p.id = up.parent_id)
         SELECT id FROM up WHERE level='project' LIMIT 1)
       OR (
         EXISTS(SELECT 1 FROM project a WHERE a.id=tf.project_id AND a.folder='__board_anchor__')
         AND EXISTS(SELECT 1 FROM project pr WHERE pr.id=$2 AND pr.level='project')))`, [fieldId, taskId]);
  if (!ok) throw new Error("이 태스크에 속하지 않은 필드입니다");

  const empty = value === null || value === undefined
    || (typeof value === "string" && value.trim() === "")
    || (Array.isArray(value) && value.length === 0);
  if (empty) {
    await itemsPool.query(`DELETE FROM task_field_value WHERE field_id=$1 AND task_id=$2`, [fieldId, taskId]);
    return { field_id: fieldId, task_id: taskId, value: null };
  }
  return one(itemsPool,
    `INSERT INTO task_field_value(field_id, task_id, value, updated_at)
     VALUES($1, $2, $3::jsonb, now())
     ON CONFLICT(field_id, task_id) DO UPDATE SET value=EXCLUDED.value, updated_at=now()
     RETURNING field_id, task_id, value`,
    [fieldId, taskId, JSON.stringify(value)]);
}
