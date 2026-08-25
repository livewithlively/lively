// 실행 세션 ↔ 프로젝트 현재 소속의 DB 정본.
// cwd·project.json·tmux는 실행 표면/캐시일 뿐이며, 외부 Codex thread와 관리형 box 세션을 같은 id 계약으로 다룬다.
import { itemsPool } from "../db/client.js";

const ON_NODE = !!process.env.LIVELY_NODE_TOKEN;

export interface ExecutionSessionProject {
  id: string;
  owner: string;
  harness: string;
  project_id: number | null;
  desired_revision: number;
  applied_revision: number;
  binding_epoch: number;
}

function row(r: Record<string, unknown>): ExecutionSessionProject {
  return {
    id: String(r.id), owner: String(r.owner), harness: String(r.harness || "unknown"),
    project_id: r.desired_project_id == null ? null : Number(r.desired_project_id),
    desired_revision: Number(r.desired_revision || 0), applied_revision: Number(r.applied_revision || 0),
    binding_epoch: Number(r.binding_epoch || 0),
  };
}

export function executionBindingTransition(
  current: Pick<ExecutionSessionProject, "project_id" | "desired_revision" | "applied_revision" | "binding_epoch">,
  projectId: number | null,
): { changed: boolean; project_id: number | null; desired_revision: number; applied_revision: number; binding_epoch: number } {
  if (current.project_id === projectId) return { changed: false, ...current };
  return {
    changed: true, project_id: projectId,
    desired_revision: current.desired_revision + 1,
    applied_revision: current.applied_revision,
    binding_epoch: current.binding_epoch + 1,
  };
}

/** 소유자가 같은 실행 세션만 등록/갱신한다. false는 이미 다른 소유자가 선점한 id다. */
export async function claimExecutionSession(id: string, owner: string, harness?: string | null, nodeId?: string | null): Promise<boolean> {
  if (ON_NODE || !id || !owner) return false;
  const r = await itemsPool.query(
    `INSERT INTO execution_session(id, owner, harness, managed_node_id)
       VALUES($1,$2,COALESCE(NULLIF($3,''),'unknown'),$4)
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       harness=CASE WHEN EXCLUDED.harness='unknown' THEN execution_session.harness ELSE EXCLUDED.harness END,
       managed_node_id=COALESCE(EXCLUDED.managed_node_id, execution_session.managed_node_id), last_seen=now(), updated_at=now()
     WHERE execution_session.owner=EXCLUDED.owner
     RETURNING id`,
    [id, owner, harness ?? null, nodeId ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

/** 현재 상태 조회. owner가 다르면 존재 여부도 노출하지 않는다. */
export async function executionSessionProject(id: string, owner: string): Promise<ExecutionSessionProject | null> {
  if (ON_NODE || !id || !owner) return null;
  const r = await itemsPool.query(
    `SELECT id, owner, harness, desired_project_id, desired_revision, applied_revision, binding_epoch
       FROM execution_session WHERE id=$1 AND owner=$2`, [id, owner]);
  return r.rows[0] ? row(r.rows[0]) : null;
}

/** desired 소속과 시간구간을 원자적으로 갱신한다. 같은 값 재지정은 revision/epoch를 늘리지 않는다. */
export async function setExecutionSessionProject(input: {
  id: string; owner: string; harness?: string | null; nodeId?: string | null; projectId: number | null;
}): Promise<ExecutionSessionProject | null> {
  if (ON_NODE || !input.id || !input.owner) return null;
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(
      `INSERT INTO execution_session(id, owner, harness, managed_node_id)
         VALUES($1,$2,COALESCE(NULLIF($3,''),'unknown'),$4)
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         harness=CASE WHEN EXCLUDED.harness='unknown' THEN execution_session.harness ELSE EXCLUDED.harness END,
         managed_node_id=COALESCE(EXCLUDED.managed_node_id, execution_session.managed_node_id), last_seen=now(), updated_at=now()
       WHERE execution_session.owner=EXCLUDED.owner
       RETURNING id`, [input.id, input.owner, input.harness ?? null, input.nodeId ?? null]);
    if (!(claimed.rowCount ?? 0)) { await client.query("ROLLBACK"); return null; }

    const locked = await client.query(
      `SELECT id, owner, harness, desired_project_id, desired_revision, applied_revision, binding_epoch
         FROM execution_session WHERE id=$1 AND owner=$2 FOR UPDATE`, [input.id, input.owner]);
    const cur = locked.rows[0] ? row(locked.rows[0]) : null;
    if (!cur) { await client.query("ROLLBACK"); return null; }
    const next = executionBindingTransition(cur, input.projectId);
    if (next.changed) {
      await client.query(
        `UPDATE execution_session SET desired_project_id=$3, desired_revision=$4, binding_epoch=$5,
           last_seen=now(), updated_at=now() WHERE id=$1 AND owner=$2`,
        [input.id, input.owner, next.project_id, next.desired_revision, next.binding_epoch]);
      await client.query(
        `INSERT INTO session_project(session_id, project_id, binding_epoch) VALUES($1,$2,$3)
         ON CONFLICT (tenant_id, session_id, valid_from) DO NOTHING`,
        [input.id, next.project_id, next.binding_epoch]);
      await client.query("COMMIT");
      return { ...cur, project_id: next.project_id, desired_revision: next.desired_revision, binding_epoch: next.binding_epoch };
    }
    await client.query("COMMIT");
    return cur;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/**
 * 구 배포에서 넘어온 세션 구제 — `session_project` 에만 바인딩이 있는 **살아 있는** 세션의 current 를 세운다.
 *
 *  왜 필요한가(실측 2026-08-25, dev): 이 표가 생기기 전에 프로젝트에 붙은 세션이 794개다. 그 세션이 업그레이드 뒤
 *   다음 프롬프트를 보내면 훅이 DB 를 보고 **미연결로 판정**해 새 프로젝트를 만들어 붙인다 — 사람이 이미 고른
 *   소속이 조용히 갈리고 빈 껍데기가 는다. 그래서 조회 시점에 한 번 구제한다(마이그레이션은 owner 를 모르는
 *   구 세션 575개를 못 옮긴다 — 소유권은 요청자가 증명할 때만 확정할 수 있다).
 *
 *  이력(`session_project`)은 이미 그 바인딩을 말하고 있으므로 **새 이력 행을 만들지 않는다**(중복 구간 방지).
 *  applied_revision 은 0 으로 둔다 — 도는 세션은 아직 그 프로젝트 규칙을 못 받았을 수 있으니 다음 턴에 한 번 주입된다.
 *  이미 행이 있으면 아무것도 하지 않는다(DO NOTHING) — 정상 경로가 언제나 이긴다.
 */
export async function adoptLegacyExecutionSession(input: {
  id: string; owner: string; harness?: string | null; nodeId?: string | null; projectId: number;
}): Promise<ExecutionSessionProject | null> {
  if (ON_NODE || !input.id || !input.owner || !(Number(input.projectId) > 0)) return null;
  await itemsPool.query(
    `INSERT INTO execution_session(id, owner, harness, managed_node_id, desired_project_id, desired_revision, applied_revision, binding_epoch)
       VALUES($1,$2,COALESCE(NULLIF($3,''),'unknown'),$4,$5,1,0,1)
     ON CONFLICT (tenant_id, id) DO NOTHING`,
    [input.id, input.owner, input.harness ?? null, input.nodeId ?? null, input.projectId]);
  return await executionSessionProject(input.id, input.owner);
}

/** 프로젝트 문맥을 실행 세션에 전달한 revision을 단조 증가로 확인한다. */
export async function markExecutionSessionApplied(id: string, owner: string, revision: number): Promise<void> {
  if (ON_NODE || !id || !owner || !Number.isSafeInteger(revision) || revision < 0) return;
  await itemsPool.query(
    `UPDATE execution_session SET applied_revision=GREATEST(applied_revision,$3), last_seen=now(), updated_at=now()
      WHERE id=$1 AND owner=$2 AND desired_revision >= $3`, [id, owner, revision]);
}
