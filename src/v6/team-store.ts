// v6 team 데이터 접근 — 조직 내 팀(스쿼드/사일로)과 팀원.
//  ⚠ #4233(원준 2026-09-25): 분류를 팀에 할당하는 개념(team_category · 담당/이해관계)은 폐기했다 — 표도 부팅 때 지운다.
//   권한은 scopes[]/projects[] 와 team_member 로 따로 정해진다(처음부터 분류 담당과 무관했다).
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

export interface TeamDetail extends TeamRow {
  members: TeamMemberRow[];
}

// append-only 감사(org_content_audit, entity='team') — 공유 헬퍼 위임(category/project 동형).
const auditTeam = (entityKey: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("team", entityKey, op, before, after, ctx);

// ── 조회 ──────────────────────────────────────────────────────────────────
// 목록 — 어드민 팀 패널용. member_count 를 서브쿼리로 동봉(facepile/요약).
export interface TeamListRow extends TeamRow { member_count: number }
export async function listTeams(opts?: { includeArchived?: boolean }): Promise<TeamListRow[]> {
  const where = opts?.includeArchived ? "" : `WHERE state <> 'archived'`;
  return q(itemsPool, `
    SELECT ${TEAM_COLS.split(",").map((c) => "t." + c.trim()).join(", ")},
      (SELECT COUNT(*) FROM team_member tm WHERE tm.team_id=t.id)::int AS member_count
    FROM team t ${where} ORDER BY t.sort, t.name NULLS LAST, t.key`);
}

export async function getTeam(id: number): Promise<TeamDetail | undefined> {
  const team: TeamRow | undefined = await one(itemsPool, `SELECT ${TEAM_COLS} FROM team WHERE id=$1`, [id]);
  if (!team) return undefined;
  const members: TeamMemberRow[] = await q(itemsPool, `
    SELECT tm.member_id, tm.role, tm.sort, m.display_name
    FROM team_member tm LEFT JOIN org_member m ON m.id=tm.member_id
    WHERE tm.team_id=$1 ORDER BY tm.sort, m.display_name NULLS LAST, tm.member_id`, [id]);
  return { ...team, members };
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

// 삭제 — team_member 는 FK CASCADE 동반 삭제. 감사 스냅샷으로 본체 복원 가능. 사람전용 게이트는 capability 계층.
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

// ── 해석(resolution) — 표면화·주입의 단일 소스 ───────────────────────────────
// 멤버 소속 팀(active) — 겸직이면 여럿.
export async function memberTeams(memberId: string): Promise<TeamRow[]> {
  if (!memberId) return [];
  return q(itemsPool, `
    SELECT ${TEAM_COLS.split(",").map((c) => "t." + c.trim()).join(", ")}
    FROM team_member tm JOIN team t ON t.id=tm.team_id
    WHERE tm.member_id=$1 AND t.state='active' ORDER BY t.sort, t.key`, [memberId]);
}
