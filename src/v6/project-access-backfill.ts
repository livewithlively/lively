// 기존 프로젝트를 한꺼번에 초대제로 바꾸기(#5598 후속, 상민 2026-11-18 «단추로 가»).
//
// ── 왜 단추인가 ─────────────────────────────────────────────────────────────
//  초대제(#5598)는 **새 프로젝트의 기본값**이고 이미 있는 프로젝트는 그대로 둔다(project-access.ts 머리말). 그래서 워크스페이스가
//  초대제여도 그 전에 만든 프로젝트는 계속 전원에게 보인다. 배포 때 저절로 전부 닫으면, 설정을 고르지 않은 모든 워크스페이스에서
//  서로 보던 프로젝트 수백 건이 한꺼번에 사라진다 — 그래서 **관리자가 누른 워크스페이스에서만, 누른 그때 한 번** 돈다.
//  누르기 전에 몇 건이 닫히는지(만든 사람별)를 보여 준다.
//
// ── 무엇을 닫나 ─────────────────────────────────────────────────────────────
//  아직 초대제가 아닌 프로젝트 중 **만든 사람이 지금 구성원인 것**. 휴지통 · 보관에 있는 것도 닫는다(거기서도 제목이 보인다).
//  닫지 않는 것(«제외»):
//   · 만든 사람이 비어 있는 행(커넥터 미러 · 옛 행) — 닫으면 팀원 말고는 아무도 못 보고, 팀원이 없으면 영영 아무도 못 본다.
//   · 만든 사람이 더는 구성원이 아닌 행(나갔거나 꺼진 계정) — 같은 까닭. 공개 범위를 다시 열 사람이 없다.
//   · 보드 커스텀 칸의 앵커 행(숨은 프로젝트).
//  초안은 초안인 채 닫는다(초안이 풀려도 저절로 공개되지 않게 된다 — 초대제의 뜻 그대로).
//
// ── 닫으면서 남기는 사람 ────────────────────────────────────────────────────
//  이미 그 프로젝트에서 일하던 사람이 밀려나지 않게 팀원으로 넣는다 — 프로젝트 하나를 닫을 때(project-store.setProjectAccess)와
//  같은 규칙이다: 그 프로젝트 세션에 초대돼 있던 사람 · 그 프로젝트에서 세션을 돌리던 사람 · 프로젝트/태스크/서브태스크 담당자
//  (구성원만). 기존 팀원은 그대로 남는다.
//
//  되돌리는 단추는 없다 — 닫힌 프로젝트는 만든 사람이 프로젝트 화면의 [공유]에서 하나씩 «전체 공개» 로 바꾼다. 그래서 확인을 받는다.
//  ⚠ updated_at 을 건드리지 않는다(목록의 «최근 수정» 순서를 뒤섞지 않는다).
import { itemsPool, q, withTx } from "../db/client.js";
import { actorKindOf, normalizeAuditChannel, type WriteCtx } from "./content-audit.js";
import { invalidateVisibilityCache } from "./visibility.js";
import { axisOn } from "./visibility-axes.js";
import { ensureInviteOnlyColumn } from "./project-invite-column.js";

/** 프로젝트 공개범위 축이 꺼져 있다 — 닫아도 아무것도 가려지지 않고, 나중에 축을 켜는 순간 한꺼번에 닫힌다. 부른 쪽이 409 로 바꾼다. */
export class ProjectAccessAxisOffError extends Error {
  constructor() { super("프로젝트 공개범위가 꺼져 있어 초대제로 바꿔도 가려지지 않습니다 — 먼저 «프로젝트» 공개범위를 켜세요"); this.name = "ProjectAccessAxisOffError"; }
}
/** 초대제 칸이 이 DB 에 아직 없다(배포가 스키마를 맞추는 몇 분). 부른 쪽이 503 으로 바꾼다. */
export class ProjectAccessBackfillUnavailableError extends Error {
  constructor() { super("배포 중이라 아직 바꿀 수 없습니다 — 잠시 뒤 다시 시도하세요"); this.name = "ProjectAccessBackfillUnavailableError"; }
}

//  닫을 수 있는 «아직 열린» 프로젝트 — p 는 project 의 별칭. 이 조건의 SQL 은 여기 한 벌이다(미리보기와 실행이 함께 쓴다).
const OPEN_ROW = `p.level = 'project' AND NOT p.invite_only AND p.folder IS DISTINCT FROM '__board_anchor__'`;
//  만든 사람이 **지금 구성원인 사람**이다 — 꺼진 계정 · 사람이 아닌 계정(에이전트 · 시스템 신원)이 만든 행은 닫지 않는다.
//   닫으면 아무도 로그인하지 않는 계정에게만 보이고, 공개 범위를 다시 열 사람이 없다.
const OWNER_ACTIVE = `p.created_by IS NOT NULL AND EXISTS (SELECT 1 FROM org_member om WHERE om.id = p.created_by AND om.state = 'active' AND om.kind = 'human')`;

export interface ExistingOpenSummary {
  /** 닫을 수 있는 프로젝트 수(만든 사람이 지금 구성원). */
  open: number;
  /** 열려 있지만 닫지 않는 것(만든 사람이 없거나 더는 구성원이 아니다). */
  excluded: number;
  /** 만든 사람별 건수(많은 순) — 내용이 아니라 규모다. */
  by_creator: Array<{ member_id: string; display_name: string | null; count: number }>;
}

/** 지금 눌렀을 때 몇 건이 닫히는가. 칸이 아직 없으면(롤 창) 0건으로 답한다(누를 것이 없다). */
export async function existingOpenProjects(): Promise<ExistingOpenSummary> {
  if (!(await ensureInviteOnlyColumn())) return { open: 0, excluded: 0, by_creator: [] };
  const rows = await q(itemsPool, `
    SELECT p.created_by AS member_id, om.display_name, count(*)::int AS n
      FROM project p JOIN org_member om ON om.id = p.created_by AND om.state = 'active' AND om.kind = 'human'
     WHERE ${OPEN_ROW}
     GROUP BY p.created_by, om.display_name
     ORDER BY n DESC, p.created_by`, []);
  const ex = await q(itemsPool, `SELECT count(*)::int AS n FROM project p WHERE ${OPEN_ROW} AND NOT (${OWNER_ACTIVE})`, []);
  const by_creator = rows.map((r) => ({ member_id: String(r.member_id), display_name: (r.display_name as string | null) ?? null, count: Number(r.n) }));
  return { open: by_creator.reduce((a, r) => a + r.count, 0), excluded: Number(ex[0]?.n ?? 0), by_creator };
}

/**
 * 아직 열려 있는 기존 프로젝트를 전부 초대제로 바꾼다. 멱등 — 다시 불러도 그 사이 새로 열린 것만 닫는다.
 *  한 트랜잭션: 대상 잠금 → 일하던 사람을 팀원으로 → 표시 → 감사(프로젝트마다 한 줄 · op set_access · reason backfill).
 */
export async function closeExistingOpenProjects(ctx?: WriteCtx): Promise<{ converted: number; members_added: number }> {
  if (!(await ensureInviteOnlyColumn())) throw new ProjectAccessBackfillUnavailableError();
  if (!(await axisOn("project"))) throw new ProjectAccessAxisOffError();
  const out = await withTx(async (c) => {
    const ids: number[] = (await c.query(
      `SELECT p.id FROM project p WHERE ${OPEN_ROW} AND ${OWNER_ACTIVE} ORDER BY p.id FOR UPDATE OF p`)).rows.map((r) => Number(r.id));
    if (!ids.length) return { converted: 0, members_added: 0 };
    //  일하던 사람 — setProjectAccess 와 같은 규칙을 여러 프로젝트에 한 번에. node = 그 프로젝트의 태스크 · 서브태스크(뿌리 id 를 달고).
    const added = await c.query(
      `WITH node AS (
         -- 프로젝트 행 자신도 담당자를 가진다(최상위 태스크로 쓰는 워크스페이스) — 뿌리부터 훑는다.
         SELECT r.id AS root, r.id, r.assignee FROM project r WHERE r.id = ANY($1::int[])
         UNION ALL
         SELECT t.parent_id AS root, t.id, t.assignee FROM project t WHERE t.level = 'task' AND t.parent_id = ANY($1::int[])
         UNION ALL
         SELECT t.parent_id, s.id, s.assignee FROM project s JOIN project t ON t.id = s.parent_id AND t.level = 'task'
          WHERE s.level = 'subtask' AND t.parent_id = ANY($1::int[])
       ), who AS (
         SELECT s.project_id AS root, inv.member_id, false AS check_member
           FROM org_session_state s
           CROSS JOIN LATERAL jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(s.invites) = 'array' THEN s.invites ELSE '[]'::jsonb END) AS inv(member_id)
          WHERE s.project_id = ANY($1::int[])
         -- 그 프로젝트에서 세션을 돌리던 사람 — 제 세션은 계속 열리지만(주인) 프로젝트와 그 폴더의 파일이 가려진다.
         UNION ALL SELECT s.project_id, s.owner, true FROM org_session_state s WHERE s.project_id = ANY($1::int[]) AND s.owner IS NOT NULL
         UNION ALL SELECT n.root, n.assignee, true FROM node n WHERE n.assignee IS NOT NULL
         UNION ALL SELECT n.root, ta.member_id, true FROM task_assignee ta JOIN node n ON n.id = ta.task_id
       )
       INSERT INTO project_member(project_id, member_id, role, sort, added_at)
       SELECT DISTINCT w.root, w.member_id, 'member', 100, now()
         FROM who w JOIN project p ON p.id = w.root
        WHERE w.member_id <> '' AND w.member_id IS DISTINCT FROM p.created_by
          AND (NOT w.check_member OR EXISTS (SELECT 1 FROM org_member m WHERE m.id = w.member_id))
       ON CONFLICT (project_id, member_id) DO NOTHING`, [ids]);
    await c.query(`UPDATE project SET invite_only = true WHERE id = ANY($1::int[])`, [ids]);
    const source = ctx?.source ?? null;
    await c.query(
      `INSERT INTO org_content_audit(entity, entity_key, op, before, after, actor, source, channel, actor_kind)
       SELECT 'project', x.id::text, 'set_access', '{"invite_only": false}'::jsonb, '{"invite_only": true, "reason": "backfill"}'::jsonb, $2, $3, $4, $5
         FROM unnest($1::int[]) AS x(id)`,
      [ids, ctx?.actor ?? null, source, normalizeAuditChannel(source), actorKindOf(source)]);
    return { converted: ids.length, members_added: added.rowCount ?? 0 };
  });
  if (out.converted) invalidateVisibilityCache();   // 남의 «숨은 프로젝트» 보관에 곧바로 들어가게
  return out;
}
