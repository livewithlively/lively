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

/** 프로젝트 문맥을 실행 세션에 전달한 revision을 단조 증가로 확인한다. */
export async function markExecutionSessionApplied(id: string, owner: string, revision: number): Promise<void> {
  if (ON_NODE || !id || !owner || !Number.isSafeInteger(revision) || revision < 0) return;
  await itemsPool.query(
    `UPDATE execution_session SET applied_revision=GREATEST(applied_revision,$3), last_seen=now(), updated_at=now()
      WHERE id=$1 AND owner=$2 AND desired_revision >= $3`, [id, owner, revision]);
}
