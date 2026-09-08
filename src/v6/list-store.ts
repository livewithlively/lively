// v6 project_list 데이터 접근 — 프로젝트 묶음(클릭업 List▸Task 의 List). level='project' 행을 0~1개 리스트로 그룹핑.
//  네이티브 전용 — 외부 PM(ClickUp) 미러 없음(우리 매핑은 단일 컨테이너 List 유지). 따라서 enqueueExternalPush 호출 없음.
//  리스트 멤버(project_list_member)는 웹 보드의 기본 펼침/접힘을 가르는 '참여자' — 프로젝트 팀원(project_member)과 직교.
//  감사 org_content_audit(entity='project_list', entity_key=id) — 프로젝트의 list_id 변경은 entity='project', op='set_list'.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { auditOrgContent, type WriteCtx } from "./content-audit.js";
import { visibleListIds, listIdPredicate, type Viewer } from "./visibility.js";

export interface ListMember { member_id: string; display_name: string | null }
export interface ProjectListRow {
  id: number;
  name: string;
  color: string | null;
  sort: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  folder_id: number | null;  // 소속 폴더(project_folder). null=미분류 폴더. #475 3단계(폴더›리스트›프로젝트).
  visibility: string;        // 'open'=전원 열람(#280 정합) / 'members'=리스트 멤버만 목록·프로젝트 열람. #475.
  settings: Record<string, unknown>;  // 리스트 단위 목록 UI 커스텀 백(기본 보기·표시필드 등). #475.
  members: ListMember[];     // 리스트 참여자(표시명 조인) — 보드 페이스파일·내 리스트 판정.
  project_count: number;     // 이 리스트에 속한 프로젝트(level='project') 수.
  external_system: string | null; // 커넥터 이관 좌표(#541 — clickup 등). NULL=네이티브. 프론트 CU 컬럼 게이트.
  external_id: string | null;
  category_id: number | null;     // 소유 카테고리(도메인, N:1). NULL=미분류. 소속 프로젝트가 상속.
  category: { id: number; key: string; name: string | null } | null; // 표시용(사이드바 배지·상속 소스).
}

const auditList = (key: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("project_list", key, op, before, after, ctx);

// ── 조회 ──────────────────────────────────────────────────────────────────
// 모든 리스트 + 멤버(표시명) + 프로젝트 수. 보드/사이드바가 소비. 정렬: sort, 이름.
//  viewerVis(#475→#1291): 문자열=그 신원에게 보이는 리스트만 / null=특권(전체). 판정은 v6/visibility.ts 로 일원화 —
//  예전엔 여기서 리스트 자기 visibility 만 봐서, 잠긴 스페이스 안의 리스트가 껍데기로 노출됐다(상속 미적용).
export async function listProjectLists(viewerVis?: Viewer): Promise<ProjectListRow[]> {
  const params: unknown[] = [];
  let visWhere = "";
  if (viewerVis !== undefined && viewerVis !== null) {
    const ids = await visibleListIds(viewerVis);
    visWhere = `WHERE ${listIdPredicate("pl.id", ids)} AND pl.id IS NOT NULL`;
  }
  return q(itemsPool,
    `SELECT pl.id, pl.name, pl.color, pl.sort, pl.created_by, pl.created_at, pl.updated_at,
       pl.folder_id, COALESCE(pl.visibility, 'open') AS visibility, COALESCE(pl.settings, '{}'::jsonb) AS settings,
       pl.external_system, pl.external_id, pl.category_id,
       (SELECT jsonb_build_object('id', c.id, 'key', c.key, 'name', c.name) FROM category c WHERE c.id=pl.category_id) AS category,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('member_id', plm.member_id, 'display_name', om.display_name) ORDER BY plm.sort, plm.member_id)
         FROM project_list_member plm LEFT JOIN org_member om ON om.id=plm.member_id WHERE plm.list_id=pl.id), '[]'::jsonb) AS members,
       (SELECT count(*)::int FROM project p WHERE p.list_id=pl.id AND p.level='project'
          AND p.folder IS DISTINCT FROM '__board_anchor__') AS project_count
     FROM project_list pl ${visWhere}
     ORDER BY pl.sort,
       CASE WHEN pl.settings->'clickup'->>'orderindex' ~ '^-?[0-9.]+$' THEN (pl.settings->'clickup'->>'orderindex')::float8 END NULLS LAST,
       lower(pl.name)`, params);
}

// 리스트 재정렬(#541 사이드바) — 주어진 순서대로 sort=1,2,… 재부여(0=미지정 기본과 구분 → ClickUp orderindex 폴백 유지).
//  같은 폴더의 형제만 넘기는 게 프론트 규약이나, 전역 sort 라 검증 없이도 안전(그룹핑은 folder_id 가 결정).
export async function reorderProjectLists(ids: number[]): Promise<{ updated: number }> {
  const clean = (ids || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
  if (clean.length < 2) return { updated: 0 };
  const tuples = clean.map((_id, i) => `($${i + 1}::int, ${i + 1}::int)`).join(", ");
  const res = await itemsPool.query(
    `UPDATE project_list AS pl SET sort = v.sort FROM (VALUES ${tuples}) AS v(id, sort) WHERE pl.id = v.id`, clean);
  return { updated: res.rowCount || 0 };
}

// 리스트 1건(멤버 조인 없이) — 존재 확인·소유권 조회용. 없으면 undefined.
export async function getProjectListRow(id: number): Promise<{ id: number; name: string; color: string | null; sort: number; created_by: string | null; visibility: string } | undefined> {
  // visibility 동봉(#1291) — 대상 검증이 "지금 잠겨 있나"를 알아야 open 리스트의 참여 멤버까지 막지 않는다.
  return one(itemsPool, `SELECT id, name, color, sort, created_by, COALESCE(visibility,'open') AS visibility FROM project_list WHERE id=$1`, [id]);
}

// ── 쓰기 ──────────────────────────────────────────────────────────────────
export async function createProjectList(
  input: { name: string; color?: string | null; members?: string[]; category_id?: number | null },
  ctx?: WriteCtx,
): Promise<ProjectListRow> {
  // 신규 리스트는 맨 뒤로(기존 최대 sort + 1) — 생성 순서 보존, 사용자가 추후 재정렬 가능. category_id=소유 도메인(상속 소스).
  const catId = input.category_id != null && Number.isInteger(Number(input.category_id)) && Number(input.category_id) > 0 ? Number(input.category_id) : null;
  const row: { id: number } = await one(itemsPool,
    `INSERT INTO project_list(name, color, sort, created_by, category_id, created_at, updated_at)
     VALUES($1,$2,(SELECT COALESCE(MAX(sort),0)+1 FROM project_list),$3,$4,now(),now()) RETURNING id`,
    [input.name, input.color ?? null, ctx?.actor ?? null, catId]);
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
  patch: Partial<{ name: string; color: string | null; sort: number; visibility: string; category_id: number | null }>,
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
  if (patch.visibility !== undefined) set("visibility", patch.visibility === "members" ? "members" : "open");
  // category_id: null=미분류(해제), 양의 정수=소유 도메인 설정. (undefined=무변경)
  if (patch.category_id !== undefined) set("category_id", patch.category_id != null && Number(patch.category_id) > 0 ? Number(patch.category_id) : null);
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
// 팀 grant 교체(#1291 v2) — 멤버 열거와 나란한 두 번째 주체 축. 팀은 라이브 그룹핑이라
//  팀원이 바뀌면 대상도 자동으로 따라간다(66명 조직에서 부서 단위로 잠글 때 멤버를 일일이 관리하지 않아도 된다).
export async function setProjectListTeams(listId: number, teamIds: number[], ctx?: WriteCtx): Promise<number[]> {
  const existing = await getProjectListRow(listId);
  if (!existing) throw new Error(`리스트 #${listId} 없음`);
  const ids: number[] = [];
  const seen = new Set<number>();
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM project_list_team WHERE list_id=$1`, [listId]);
    for (const raw of teamIds || []) {
      const t = Number(raw);
      if (!Number.isInteger(t) || t <= 0 || seen.has(t)) continue;
      seen.add(t);
      await client.query(`INSERT INTO project_list_team(list_id, team_id) VALUES($1,$2)`, [listId, t]);
      ids.push(t);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
  await auditList(String(listId), "set_teams", null, { teams: ids }, ctx);
  return ids;
}

/** 이 리스트에 grant 된 팀(표시명 포함) — 설정 폼이 현재 값을 그리는 데 쓴다. */
export async function getProjectListTeams(listId: number): Promise<{ team_id: number; key: string | null; name: string | null }[]> {
  return q(itemsPool,
    `SELECT plt.team_id, t.key, t.name FROM project_list_team plt
       LEFT JOIN team t ON t.id = plt.team_id
      WHERE plt.list_id=$1 ORDER BY t.name NULLS LAST, plt.team_id`, [listId]);
}

/** 이 리스트의 현재 참여 멤버 id — 잠금 전환(open→members) 검증이 '그 시점의 대상'을 읽는 데 쓴다(#1291). */
export async function getProjectListMemberIds(listId: number): Promise<string[]> {
  const rows = await q(itemsPool, `SELECT member_id FROM project_list_member WHERE list_id=$1`, [listId]);
  return rows.map((r: { member_id: string }) => String(r.member_id));
}

export async function setProjectListMembers(listId: number, memberIds: string[], ctx?: WriteCtx): Promise<string[]> {
  const existing = await getProjectListRow(listId);
  if (!existing) throw new Error(`리스트 #${listId} 없음`);
  const before = await q(itemsPool,
    `SELECT member_id FROM project_list_member WHERE list_id=$1 ORDER BY sort, member_id`, [listId]);
  // ⚠ 한 트랜잭션으로 묶는다(#1291) — 이 목록이 '보드 펼침 참여자'가 아니라 **접근 대상(audience)** 이 된 이상,
  //  DELETE 직후 죽으면 그 리스트를 아무도 못 보는 상태로 남고(admin 만 복구 가능), 교체가 진행되는 사이 들어온
  //  조회가 '대상 없음'으로 오판한다.
  const seen = new Set<string>();
  const ids: string[] = [];
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM project_list_member WHERE list_id=$1`, [listId]);
    let sort = 0;
    for (const memberId of memberIds) {
      const m = String(memberId).trim();
      if (!m || seen.has(m)) continue;
      seen.add(m);
      await client.query(
        `INSERT INTO project_list_member(list_id, member_id, role, sort, added_at) VALUES($1,$2,'member',$3,now())`,
        [listId, m, sort++]);
      ids.push(m);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await auditList(String(listId), "set_members", (before as Array<{ member_id: string }>).map((r) => r.member_id), ids, ctx);
  return ids;
}

/** 프로젝트의 현재 리스트 소속(미분류=null) — 이동 전 '떠나는 리스트'를 알아야 폴더 ACL 을 되돌릴 수 있다(#1291).
 *  level 필터 없이 id 로만 본다: 이동 대상 검증은 호출부(가시성 게이트)가 이미 했고, 여기선 직전 값만 필요하다. */
export async function getProjectListId(projectId: number): Promise<number | null> {
  const row: { list_id: number | null } | undefined = await one(itemsPool,
    `SELECT list_id FROM project WHERE id=$1`, [projectId]);
  return row?.list_id == null ? null : Number(row.list_id);
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

// 리스트 목록 UI 커스텀(settings JSONB) 얕은 병합 — 주어진 키만 덮어쓰고 나머지 보존(#475). null 값은 키 삭제.
export async function setProjectListSettings(id: number, patch: Record<string, unknown>, ctx?: WriteCtx): Promise<ProjectListRow> {
  const before = await getListWithMembers(id);
  if (!before) throw new Error(`리스트 #${id} 없음`);
  const merged: Record<string, unknown> = { ...(before.settings || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete merged[k];
    else merged[k] = v;
  }
  await itemsPool.query(`UPDATE project_list SET settings=$2::jsonb, updated_at=now() WHERE id=$1`, [id, JSON.stringify(merged)]);
  const after = await getListWithMembers(id);
  await auditList(String(id), "set_settings", before.settings, after!.settings, ctx);
  return after!;
}

// 리스트 1건 + 멤버(표시명) — 생성/수정 응답용(listProjectLists 와 동일 형상의 단건).
async function getListWithMembers(id: number): Promise<ProjectListRow | undefined> {
  return one(itemsPool,
    `SELECT pl.id, pl.name, pl.color, pl.sort, pl.created_by, pl.created_at, pl.updated_at,
       pl.folder_id, COALESCE(pl.visibility, 'open') AS visibility, COALESCE(pl.settings, '{}'::jsonb) AS settings,
       pl.external_system, pl.external_id, pl.category_id,
       (SELECT jsonb_build_object('id', c.id, 'key', c.key, 'name', c.name) FROM category c WHERE c.id=pl.category_id) AS category,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('member_id', plm.member_id, 'display_name', om.display_name) ORDER BY plm.sort, plm.member_id)
         FROM project_list_member plm LEFT JOIN org_member om ON om.id=plm.member_id WHERE plm.list_id=pl.id), '[]'::jsonb) AS members,
       (SELECT count(*)::int FROM project p WHERE p.list_id=pl.id AND p.level='project'
          AND p.folder IS DISTINCT FROM '__board_anchor__') AS project_count
     FROM project_list pl WHERE pl.id=$1`, [id]);
}

// ── 리스트 스코프 ClickUp 커스텀필드 컬럼(#541) — 리스트 뷰 컬럼 카탈로그 + 값 + 편집용 내부 id 맵. ──
//  컬럼 카탈로그의 1차 원천 = **settings.clickup.field_defs**(계층 싱크가 매 run 완전 수집 — 방금 ClickUp 에서
//  추가한 컬럼도 다음 싱크에 즉시 포함, 값 유무 무관). 태스크별 복제 정의(task_field)는 값·편집 id 용이며,
//  field_defs 에 없는 잔여(레거시)만 카탈로그에 union. 순서 = ClickUp field_defs 순서.
export interface ListClickupFields {
  fields: Array<{ key: string; name: string; field_type: string; config: Record<string, unknown> }>;
  values: Record<string, Record<string, unknown>>;   // projectId → { externalId → value }
  fieldIds: Record<string, Record<string, number>>;  // projectId → { externalId → task_field.id }
  view_columns: Array<{ idx?: number; field?: string; hidden?: boolean; width?: number | null }>; // ClickUp 리스트 뷰 컬럼 구성(빌트인+cf — 프론트가 컬럼 자동 표시/정렬에 사용)
  view_grouping: { field?: string; dir?: number; collapsed?: unknown[] } | null; // ClickUp 뷰 group by(#541 — status/assignee/priority/dueDate/tag + dir 1=asc·-1=desc)
  view_sorting: Array<{ field?: string; dir?: number }>; // ClickUp 뷰 정렬(그룹 내 태스크 정렬 — 프론트 기본값)
}
export async function getListClickupFields(listId: number): Promise<ListClickupFields> {
  // 지연 import 회피 — 커넥터 원본 정의(type/type_config)→우리 필드 타입/config 매핑은 미러와 단일 원천 공유.
  const { mapClickUpFieldType, mapClickUpFieldConfig } = await import("./connector-mirror.js");

  const listRow: { settings: Record<string, unknown> | null } | undefined = await one(itemsPool,
    `SELECT settings FROM project_list WHERE id=$1`, [listId]);
  const rawDefs = ((listRow?.settings ?? null)?.clickup as Record<string, unknown> | undefined)
    ?.field_defs as Array<{ id?: unknown; name?: unknown; type?: unknown; type_config?: unknown }> | undefined;

  const fields: ListClickupFields["fields"] = [];
  const seen = new Set<string>();
  for (const d of Array.isArray(rawDefs) ? rawDefs : []) {
    const key = d?.id != null ? String(d.id) : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fields.push({
      key,
      name: String(d?.name ?? key),
      field_type: mapClickUpFieldType(d?.type as string | null | undefined),
      config: mapClickUpFieldConfig(d?.type as string | null | undefined, (d?.type_config ?? null) as Record<string, unknown> | null),
    });
  }
  // 레거시 union — field_defs 에 없는 태스크별 복제 정의(구 이관분·field_defs 미수집 리스트).
  const replicas = await q(itemsPool,
    `SELECT DISTINCT ON (tf.external_id) tf.external_id AS key, tf.name, tf.field_type, tf.config
       FROM task_field tf JOIN project p ON p.id = tf.project_id
      WHERE p.list_id = $1 AND tf.external_id IS NOT NULL
      ORDER BY tf.external_id, tf.id`, [listId]);
  for (const r of replicas as ListClickupFields["fields"]) if (!seen.has(r.key)) { seen.add(r.key); fields.push(r); }

  const rows = await q(itemsPool,
    `SELECT p.id AS project_id, tf.external_id, tf.id AS field_id, tfv.value
       FROM project p
       JOIN task_field tf ON tf.project_id = p.id AND tf.external_id IS NOT NULL
       LEFT JOIN task_field_value tfv ON tfv.field_id = tf.id AND tfv.task_id = p.id
      WHERE p.list_id = $1`, [listId]);
  const values: Record<string, Record<string, unknown>> = {};
  const fieldIds: Record<string, Record<string, number>> = {};
  for (const r of rows as Array<{ project_id: number; external_id: string; field_id: number; value: unknown }>) {
    const pid = String(r.project_id);
    (fieldIds[pid] ??= {})[r.external_id] = r.field_id;
    if (r.value !== null && r.value !== undefined) (values[pid] ??= {})[r.external_id] = r.value;
  }
  // ClickUp 리스트 뷰의 컬럼 구성(#541) — 그 리스트의 external 'list' 뷰 config.columns.fields.
  //  빌트인('assignee'|'dueDate'|'dateCreated'…)과 커스텀필드 id 가 섞여 옴 — 프론트가 표시/정렬에 사용.
  //  스코프 상속 폴백: 리스트 뷰 → 직속 폴더 뷰 → 스페이스(부모 폴더) 뷰 — ClickUp required 뷰는 상위 스코프로
  //  이관되는 경우가 많다(예: 스페이스 List 뷰). 컬럼 구성이 있는 뷰만 후보.
  const view: { config: Record<string, unknown> | null } | undefined = await one(itemsPool,
    `SELECT pv.config FROM project_view pv
      WHERE pv.type='list' AND pv.external_id IS NOT NULL
        AND jsonb_array_length(COALESCE(pv.config->'columns'->'fields','[]'::jsonb)) > 0
        AND (pv.list_id = $1
          OR pv.folder_id = (SELECT folder_id FROM project_list WHERE id=$1)
          OR pv.folder_id = (SELECT pf.parent_id FROM project_list pl JOIN project_folder pf ON pf.id = pl.folder_id WHERE pl.id=$1))
      ORDER BY (pv.list_id IS NOT NULL) DESC,
               (pv.folder_id = (SELECT folder_id FROM project_list WHERE id=$1)) DESC,
               pv.sort, pv.id
      LIMIT 1`,
    [listId]);
  const colsRaw = ((view?.config as Record<string, unknown> | null)?.columns as Record<string, unknown> | undefined)?.fields;
  const view_columns = Array.isArray(colsRaw) ? colsRaw as ListClickupFields["view_columns"] : [];

  // grouping/sorting(#541 그룹바이 파리티) — 컬럼 있는 뷰가 없어도 grouping 은 가질 수 있어 폴백 조회.
  let gsView = view;
  if (!gsView) {
    gsView = await one(itemsPool,
      `SELECT pv.config FROM project_view pv
        WHERE pv.type='list' AND pv.external_id IS NOT NULL
          AND (pv.list_id = $1
            OR pv.folder_id = (SELECT folder_id FROM project_list WHERE id=$1)
            OR pv.folder_id = (SELECT pf.parent_id FROM project_list pl JOIN project_folder pf ON pf.id = pl.folder_id WHERE pl.id=$1))
        ORDER BY (pv.list_id IS NOT NULL) DESC,
                 (pv.folder_id = (SELECT folder_id FROM project_list WHERE id=$1)) DESC,
                 pv.sort, pv.id
        LIMIT 1`,
      [listId]);
  }
  const gsConfig = (gsView?.config ?? null) as Record<string, unknown> | null;
  const groupingRaw = gsConfig?.grouping as Record<string, unknown> | undefined;
  const view_grouping = groupingRaw && typeof groupingRaw === "object"
    ? { field: typeof groupingRaw.field === "string" ? groupingRaw.field : undefined,
        dir: typeof groupingRaw.dir === "number" ? groupingRaw.dir : undefined,
        collapsed: Array.isArray(groupingRaw.collapsed) ? groupingRaw.collapsed : undefined }
    : null;
  const sortingRaw = (gsConfig?.sorting as Record<string, unknown> | undefined)?.fields;
  const view_sorting = Array.isArray(sortingRaw) ? sortingRaw as ListClickupFields["view_sorting"] : [];

  return { fields, values, fieldIds, view_columns, view_grouping, view_sorting };
}
