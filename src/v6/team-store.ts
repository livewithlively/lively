// v6 team 데이터 접근 — 조직 내 팀(스쿼드/사일로)과 카테고리 오너십.
//  ★원칙: 오너십 ≠ 접근권한. 팀↔카테고리(team_category)는 '소프트 렌즈'다 — 표면화(프로젝트/위키 탭)와
//   컨텍스트 주입에서 '우리 팀' 맥락을 먼저 보여줄 뿐, 권한 차단이 아니다(권한은 scopes[]/projects[]가 따로).
//  지식/프로젝트/도메인맵이 이미 category 에 매달려 있어, 팀↔카테고리 한 경첩이 팀의 맥락 귀속 전체를 끌어온다.
//  itemsPool 직접 + q/one 헬퍼(domainmap/db) 재사용. 감사 org_content_audit(entity='team', entity_key=id) — category-store 동형.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { auditOrgContent, restoreSnapshot, type WriteCtx } from "./content-audit.js";

const TEAM_COLS =
  `id, key, name, description, body_md, lead_member_id, state, sort, created_at, updated_at`;

export interface TeamRow {
  id: number; key: string; name: string | null; description: string | null;
  body_md: string | null; lead_member_id: string | null;
  state: string; sort: number; created_at: string; updated_at: string;
}

export interface TeamMemberRow {
  member_id: string; role: string; sort: number;
  display_name?: string | null; // org_member 조인(표시용)
}

export interface TeamCategoryRow {
  category_id: number; relation: string;
  space?: string; key?: string; name?: string | null; // category 조인(표시용)
}

export interface TeamDetail extends TeamRow {
  members: TeamMemberRow[];
  categories: TeamCategoryRow[]; // owner + stakeholder (relation 으로 구분)
}

// append-only 감사(org_content_audit, entity='team') — 공유 헬퍼 위임(category/project 동형).
const auditTeam = (entityKey: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("team", entityKey, op, before, after, ctx);

// ── 조회 ──────────────────────────────────────────────────────────────────
// 목록 — 어드민 팀 패널용. member_count/category_count 를 서브쿼리로 동봉(facepile/요약).
export interface TeamListRow extends TeamRow { member_count: number; category_count: number }
export async function listTeams(opts?: { includeArchived?: boolean }): Promise<TeamListRow[]> {
  const where = opts?.includeArchived ? "" : `WHERE state <> 'archived'`;
  return q(itemsPool, `
    SELECT ${TEAM_COLS.split(",").map((c) => "t." + c.trim()).join(", ")},
      (SELECT COUNT(*) FROM team_member tm WHERE tm.team_id=t.id)::int AS member_count,
      (SELECT COUNT(*) FROM team_category tc WHERE tc.team_id=t.id)::int AS category_count
    FROM team t ${where} ORDER BY t.sort, t.name NULLS LAST, t.key`);
}

export async function getTeam(id: number): Promise<TeamDetail | undefined> {
  const team: TeamRow | undefined = await one(itemsPool, `SELECT ${TEAM_COLS} FROM team WHERE id=$1`, [id]);
  if (!team) return undefined;
  const members: TeamMemberRow[] = await q(itemsPool, `
    SELECT tm.member_id, tm.role, tm.sort, m.display_name
    FROM team_member tm LEFT JOIN org_member m ON m.id=tm.member_id
    WHERE tm.team_id=$1 ORDER BY tm.sort, m.display_name NULLS LAST, tm.member_id`, [id]);
  const categories: TeamCategoryRow[] = await q(itemsPool, `
    SELECT tc.category_id, tc.relation, c.space, c.key, c.name
    FROM team_category tc JOIN category c ON c.id=tc.category_id
    WHERE tc.team_id=$1 ORDER BY (tc.relation='owner') DESC, c.space, c.name NULLS LAST, c.key`, [id]);
  return { ...team, members, categories };
}

export async function getTeamByKey(key: string): Promise<TeamRow | undefined> {
  return one(itemsPool, `SELECT ${TEAM_COLS} FROM team WHERE key=$1 AND state<>'archived'`, [key]);
}

// 주어진 id 중 **실재하는 팀**만(#1313 R45) — grant 대상(공개범위) 검증 공용. 오타 id 로 잠그면 아무도 못 여는
//  리스트가 되므로, 잠그기 전에 대상 팀이 실재하는지 확인한다(archived 도 실재로 친다 — 존재 확인이지 상태 판정이 아니다).
export async function existingTeamIds(ids: number[]): Promise<number[]> {
  const rows = await q(itemsPool, `SELECT id FROM team WHERE id = ANY($1::int[])`, [ids]);
  return rows.map((r: { id: number }) => Number(r.id));
}

// 팀이 실제로 접근권한의 주체가 됐나(#1291 v2) — 팀을 대상(subject)으로 지정한 grant 가 하나라도 있으면
//  팀 편집 = 권한 편집이다. 리스트·폴더·지식·소스 네 축을 한 번에 본다(어느 하나라도 있으면 true).
export async function anyTeamGrant(): Promise<boolean> {
  const r = await itemsPool.query(
    `SELECT 1 WHERE EXISTS(SELECT 1 FROM project_list_team)
               OR EXISTS(SELECT 1 FROM project_folder_member WHERE subject_kind='team')
               OR EXISTS(SELECT 1 FROM knowledge_member WHERE subject_kind='team')
               OR EXISTS(SELECT 1 FROM source_member WHERE subject_kind='team') LIMIT 1`);
  return (r.rowCount ?? 0) > 0;
}

// ── 쓰기 ──────────────────────────────────────────────────────────────────
export async function createTeam(
  input: { key: string; name?: string; description?: string; body_md?: string; lead_member_id?: string },
  ctx?: WriteCtx,
): Promise<TeamRow> {
  const row: TeamRow = await one(itemsPool, `
    INSERT INTO team(key, name, description, body_md, lead_member_id, state, created_at, updated_at)
    VALUES($1,$2,$3,$4,$5,'active',now(),now()) RETURNING ${TEAM_COLS}`,
    [input.key, input.name ?? null, input.description ?? null, input.body_md ?? null, input.lead_member_id ?? null]);
  await auditTeam(String(row.id), "insert", null, row, ctx);
  return row;
}

export async function updateTeam(
  id: number,
  patch: { key?: string; name?: string; description?: string; body_md?: string; lead_member_id?: string | null; state?: string },
  ctx?: WriteCtx,
): Promise<TeamRow> {
  const before: TeamRow | undefined = await one(itemsPool, `SELECT ${TEAM_COLS} FROM team WHERE id=$1`, [id]);
  if (!before) throw new Error(`팀 #${id} 없음`);
  // COALESCE($n, col): undefined→null→기존값 보존(부분 수정). lead_member_id 만 명시적 null 해제 허용($6 분기).
  const row: TeamRow = await one(itemsPool, `
    UPDATE team SET
      key=COALESCE($2,key), name=COALESCE($3,name), description=COALESCE($4,description),
      body_md=COALESCE($5,body_md),
      lead_member_id=CASE WHEN $7::bool THEN $6 ELSE COALESCE($6,lead_member_id) END,
      state=COALESCE($8,state), updated_at=now()
    WHERE id=$1 RETURNING ${TEAM_COLS}`,
    [id, patch.key ?? null, patch.name ?? null, patch.description ?? null, patch.body_md ?? null,
     patch.lead_member_id ?? null, patch.lead_member_id === null, patch.state ?? null]);
  await auditTeam(String(id), "update", before, row, ctx);
  return row;
}

// 삭제 — team_member/team_category 는 FK CASCADE 동반 삭제(오너십 해제). 감사 스냅샷으로 본체 복원 가능. 사람전용 게이트는 capability 계층.
export async function deleteTeam(id: number, ctx?: WriteCtx): Promise<{ deleted: boolean; id: number }> {
  const before: TeamRow | undefined = await one(itemsPool, `SELECT ${TEAM_COLS} FROM team WHERE id=$1`, [id]);
  if (!before) throw new Error(`팀 #${id} 없음`);
  await itemsPool.query(`DELETE FROM team WHERE id=$1`, [id]);
  await auditTeam(String(id), "delete", before, null, ctx);
  return { deleted: true, id };
}

export async function restoreTeam(before: Record<string, unknown>, ctx?: WriteCtx): Promise<TeamRow> {
  const after = await restoreSnapshot<TeamRow>("team", TEAM_COLS, "id", before);
  await auditTeam(String(after.id), "restore", null, after, ctx);
  return after;
}

// 팀원 전체 교체(셋) — project_member 패턴 동형. members=[{member_id, role}]. role 기본 'member'.
export async function setTeamMembers(
  teamId: number, members: Array<{ member_id: string; role?: string }>, ctx?: WriteCtx,
): Promise<TeamMemberRow[]> {
  const clean = members
    .map((m) => ({ member_id: String(m.member_id ?? "").trim(), role: String(m.role ?? "member").trim() || "member" }))
    .filter((m) => m.member_id);
  // 중복 member_id 제거(마지막 role 우선)
  const dedup = new Map<string, string>();
  for (const m of clean) dedup.set(m.member_id, m.role);
  const before = await q(itemsPool, `SELECT member_id, role FROM team_member WHERE team_id=$1`, [teamId]);
  await itemsPool.query(`DELETE FROM team_member WHERE team_id=$1`, [teamId]);
  let i = 0;
  for (const [member_id, role] of dedup) {
    await itemsPool.query(
      `INSERT INTO team_member(team_id, member_id, role, sort) VALUES($1,$2,$3,$4)`, [teamId, member_id, role, i++]);
  }
  await auditTeam(String(teamId), "set_members", { members: before }, { members: [...dedup].map(([member_id, role]) => ({ member_id, role })) }, ctx);
  const detail = await getTeam(teamId);
  return detail?.members ?? [];
}

// ── 카테고리 오너십 ──────────────────────────────────────────────────────
// 카테고리-중심 오너 배정(어드민 분류체계관리 드롭다운) — teamId=null 이면 오너 해제. 부분유니크라 기존 오너는 먼저 제거(이양).
export async function setCategoryOwner(categoryId: number, teamId: number | null, ctx?: WriteCtx): Promise<void> {
  const before = await one(itemsPool,
    `SELECT team_id FROM team_category WHERE category_id=$1 AND relation='owner'`, [categoryId]) as { team_id: number } | undefined;
  await itemsPool.query(`DELETE FROM team_category WHERE category_id=$1 AND relation='owner'`, [categoryId]);
  if (teamId != null) {
    // 같은 팀이 그 카테고리에 stakeholder 로 있었다면 owner 로 승격(PK 충돌 회피).
    await itemsPool.query(`DELETE FROM team_category WHERE category_id=$1 AND team_id=$2`, [categoryId, teamId]);
    await itemsPool.query(
      `INSERT INTO team_category(team_id, category_id, relation) VALUES($1,$2,'owner')`, [teamId, categoryId]);
  }
  await auditTeam(teamId != null ? String(teamId) : "-", "set_category_owner",
    { category_id: categoryId, owner_team_id: before?.team_id ?? null }, { category_id: categoryId, owner_team_id: teamId }, ctx);
}

// 팀-중심 카테고리 연결(셋/해제) — stakeholder 추가 등 팀 패널에서. relation='owner' 면 부분유니크 위반 가능 → setCategoryOwner 사용 권장.
export async function setTeamCategory(teamId: number, categoryId: number, relation: string, ctx?: WriteCtx): Promise<void> {
  const rel = relation === "owner" ? "owner" : "stakeholder";
  if (rel === "owner") { await setCategoryOwner(categoryId, teamId, ctx); return; }
  await itemsPool.query(`
    INSERT INTO team_category(team_id, category_id, relation) VALUES($1,$2,$3)
    ON CONFLICT (team_id, category_id) DO UPDATE SET relation=EXCLUDED.relation`, [teamId, categoryId, rel]);
  await auditTeam(String(teamId), "set_category", null, { category_id: categoryId, relation: rel }, ctx);
}

export async function removeTeamCategory(teamId: number, categoryId: number, ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(`DELETE FROM team_category WHERE team_id=$1 AND category_id=$2`, [teamId, categoryId]);
  await auditTeam(String(teamId), "remove_category", { category_id: categoryId }, null, ctx);
}

// ── 해석(resolution) — 표면화·주입의 단일 소스 ───────────────────────────────
// 멤버 소속 팀(active) — 겸직이면 여럿.
export async function memberTeams(memberId: string): Promise<TeamRow[]> {
  if (!memberId) return [];
  return q(itemsPool, `
    SELECT ${TEAM_COLS.split(",").map((c) => "t." + c.trim()).join(", ")}
    FROM team_member tm JOIN team t ON t.id=tm.team_id
    WHERE tm.member_id=$1 AND t.state='active' ORDER BY t.sort, t.key`, [memberId]);
}

// 멤버의 '우리 팀' 카테고리 — 소속 팀들이 소유(owner)하거나 이해관계(stakeholder)인 카테고리(이름·공간 동봉).
//  표면화(사이드바 '우리 팀' 우선) + 주입(카테고리 블록 재정렬·팀 프리앰블)이 공유하는 단일 진실원천. owner 먼저 정렬.
export interface MemberCategory { category_id: number; space: string; key: string; name: string | null; owner: boolean }
export async function memberCategories(memberId: string): Promise<MemberCategory[]> {
  if (!memberId) return [];
  return q(itemsPool, `
    SELECT tc.category_id, c.space, c.key, c.name, bool_or(tc.relation='owner') AS owner
    FROM team_member tm
    JOIN team t ON t.id=tm.team_id AND t.state='active'
    JOIN team_category tc ON tc.team_id=tm.team_id
    JOIN category c ON c.id=tc.category_id AND c.state<>'merged'
    WHERE tm.member_id=$1
    GROUP BY tc.category_id, c.space, c.key, c.name
    ORDER BY owner DESC, c.space, c.name NULLS LAST, c.key`, [memberId]);
}

// id 집합 형태(표면화/주입의 Set 멤버십 판정용) — memberCategories 파생(단일 쿼리 소스).
export async function memberCategoryIds(memberId: string): Promise<{ all: number[]; owner: number[] }> {
  const rows = await memberCategories(memberId);
  return {
    all: rows.map((r) => Number(r.category_id)),
    owner: rows.filter((r) => r.owner).map((r) => Number(r.category_id)),
  };
}
