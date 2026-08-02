// 위탁 태스크 스토어(P2 #869) — org_task CRUD + 리소스-적합 노드 매칭(순수 함수, 테스트 대상).
import { itemsPool } from "../db/client.js";
import type { NodeResources } from "./protocol.js";

export type DelegateStatus = "queued" | "running" | "done" | "failed" | "canceled";

export interface DelegateTask {
  id: number; requester: string; requester_session: string | null;
  prompt: string; harness: string; subpath: string; repo: string | null; git_ref: string | null; flags: Record<string, string>;
  need_cpu: number | null; need_ram_mb: number | null; need_disk_mb: number | null;
  needs_docker: boolean; node_pref: string | null; env_lease: boolean;
  status: DelegateStatus; node_id: string | null; session_id: string | null; task_dir: string | null;
  attempt: number; max_attempts: number; timeout_sec: number;
  node_lost_at: string | null; result: Record<string, unknown> | null; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null; updated_at: string;
}

export async function createTask(input: {
  requester: string; requesterSession?: string | null; prompt: string; subpath?: string;
  repo?: string | null; gitRef?: string | null;
  flags?: Record<string, string>; needCpu?: number | null; needRamMb?: number | null; needDiskMb?: number | null;
  needsDocker?: boolean; nodePref?: string | null; timeoutSec?: number; maxAttempts?: number;
}): Promise<DelegateTask> {
  const r = await itemsPool.query(
    `INSERT INTO org_task(requester, requester_session, prompt, subpath, repo, git_ref, flags, need_cpu, need_ram_mb, need_disk_mb,
                          needs_docker, node_pref, timeout_sec, max_attempts)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [input.requester, input.requesterSession ?? null, input.prompt, input.subpath ?? "", input.repo ?? null, input.gitRef ?? null,
     JSON.stringify(input.flags ?? {}), input.needCpu ?? null, input.needRamMb ?? null, input.needDiskMb ?? null,
     !!input.needsDocker, input.nodePref ?? null,
     Math.min(Math.max(60, input.timeoutSec ?? 3600), 6 * 3600), Math.min(Math.max(1, input.maxAttempts ?? 2), 5)],
  );
  return r.rows[0] as DelegateTask;
}

export async function getTask(id: number): Promise<DelegateTask | undefined> {
  const r = await itemsPool.query(`SELECT * FROM org_task WHERE id=$1`, [id]);
  return r.rows[0] as DelegateTask | undefined;
}

export async function listTasks(opts: { requester?: string; status?: DelegateStatus; limit?: number }): Promise<DelegateTask[]> {
  const cond: string[] = []; const args: unknown[] = [];
  if (opts.requester) { args.push(opts.requester); cond.push(`requester=$${args.length}`); }
  if (opts.status) { args.push(opts.status); cond.push(`status=$${args.length}`); }
  args.push(Math.min(opts.limit ?? 50, 200));
  const r = await itemsPool.query(
    `SELECT * FROM org_task ${cond.length ? "WHERE " + cond.join(" AND ") : ""} ORDER BY id DESC LIMIT $${args.length}`, args);
  return r.rows as DelegateTask[];
}

export async function queuedTasks(): Promise<DelegateTask[]> {
  const r = await itemsPool.query(`SELECT * FROM org_task WHERE status='queued' ORDER BY id LIMIT 20`);
  return r.rows as DelegateTask[];
}
export async function runningTasks(): Promise<DelegateTask[]> {
  const r = await itemsPool.query(`SELECT * FROM org_task WHERE status='running' ORDER BY id`);
  return r.rows as DelegateTask[];
}
// 노드별 점유 슬롯(스케줄 시 용량 계산) — running + 이번 tick 에 막 배정된 것 포함(호출부 인메모리 가산).
export async function runningCountByNode(): Promise<Map<string, number>> {
  const r = await itemsPool.query(`SELECT node_id, count(*)::int AS n FROM org_task WHERE status='running' GROUP BY node_id`);
  return new Map((r.rows as Array<{ node_id: string; n: number }>).map((x) => [x.node_id, x.n]));
}

export async function markRunning(id: number, nodeId: string, sessionId: string, taskDir: string): Promise<void> {
  await itemsPool.query(
    `UPDATE org_task SET status='running', node_id=$2, session_id=$3, task_dir=$4,
        attempt=attempt+1, started_at=now(), node_lost_at=NULL, updated_at=now() WHERE id=$1`,
    [id, nodeId, sessionId, taskDir]);
}
export async function markFinished(id: number, ok: boolean, result: Record<string, unknown>, error?: string | null): Promise<void> {
  await itemsPool.query(
    `UPDATE org_task SET status=$2, result=$3::jsonb, error=$4, finished_at=now(), updated_at=now() WHERE id=$1`,
    [id, ok ? "done" : "failed", JSON.stringify(result), error ?? null]);
  // #1289 증류 배치가 실패하면 '판정함' 기록을 되돌린다 — 안 그러면 그 자료들이 아무도 안 본 채로 인박스에서
  //  영구히 빠진다(유실). 배치를 낸 시점에 기록하는 대가로 여기서 되돌려 균형을 맞춘다.
  //  증류와 무관한 위탁이면 지울 행이 없어 no-op. 테이블 부재(구버전 스키마)는 삼킨다.
  if (!ok) {
    try { await itemsPool.query(`DELETE FROM org_distiller_seen WHERE task_id=$1`, [id]); }
    catch { /* 테이블 없음 등 — 무해 */ }
  }
}
export async function requeue(id: number): Promise<void> {
  await itemsPool.query(
    `UPDATE org_task SET status='queued', node_id=NULL, session_id=NULL, task_dir=NULL, node_lost_at=NULL, updated_at=now() WHERE id=$1`, [id]);
}
export async function markCanceled(id: number): Promise<void> {
  await itemsPool.query(`UPDATE org_task SET status='canceled', finished_at=now(), updated_at=now() WHERE id=$1`, [id]);
}
export async function setNodeLost(id: number, lost: boolean): Promise<void> {
  await itemsPool.query(`UPDATE org_task SET node_lost_at=${lost ? "now()" : "NULL"}, updated_at=now() WHERE id=$1`, [id]);
}

// ── 리소스-적합 매칭(§10, 순수 함수) ──
//  후보 = online·enabled + (node_pref 일치) + (needs_docker→hasDocker) + 용량 슬롯 여유 + 리소스 적합.
//  적합: mem_free ≥ need_ram(+여유 512MB) · disk_free ≥ need_disk(+1GB) · 유휴코어(cpus−load1) ≥ need_cpu(soft).
//  점수 = 남는 메모리 큰 순(단순 최빈 자원) — central 은 저용량 워커(⑶·§9-8)라 동점 시 후순위.
export interface SchedulableNode {
  id: string; kind: string; central?: boolean; hasDocker: boolean;
  res: NodeResources | null; capacity: number; running: number;
}
export function matchNode(task: Pick<DelegateTask, "need_cpu" | "need_ram_mb" | "need_disk_mb" | "needs_docker" | "node_pref">,
  nodes: SchedulableNode[]): SchedulableNode | null {
  const fit = nodes.filter((n) => {
    if (task.node_pref && n.id !== task.node_pref) return false;
    if (task.needs_docker && !n.hasDocker) return false;
    if (n.running >= n.capacity) return false;
    if (!n.res) return task.need_ram_mb == null && task.need_disk_mb == null && task.need_cpu == null;
    if (task.need_ram_mb != null && n.res.mem_free_mb < task.need_ram_mb + 512) return false;
    if (task.need_disk_mb != null && n.res.disk_free_mb < task.need_disk_mb + 1024) return false;
    if (task.need_cpu != null && Math.max(0, n.res.cpus - n.res.load1) < task.need_cpu) return false;
    return true;
  });
  if (!fit.length) return null;
  fit.sort((a, b) => {
    const am = a.res?.mem_free_mb ?? 0, bm = b.res?.mem_free_mb ?? 0;
    if (bm !== am) return bm - am;
    return (a.central ? 1 : 0) - (b.central ? 1 : 0); // 동점이면 central 후순위(오프로드 취지)
  });
  return fit[0];
}
