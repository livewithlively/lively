// AppInstance worker 실행 이력(#1780 Stage B). 실행 호스트가 보내는 snapshot을 DB 정본으로 접는다.
import crypto from "node:crypto";
import { itemsPool } from "../../db/client.js";
import type { WorkerRunSnapshot, WorkerRunStatus } from "../../apps/worker-host.js";

export type WorkerHostKind = "central" | "remote";
export interface AppWorkerRunRow {
  id: string; instance_id: string; app_id: string; owner_member: string; project_id: number | null;
  host_kind: WorkerHostKind; host_id: string | null; package_hash: string; status: "prepared" | WorkerRunStatus;
  pid: number | null; exit_code: number | null; reason: string | null;
  created_at: string; started_at: string | null; ready_at: string | null; last_active_at: string | null; stopped_at: string | null; updated_at: string;
}

function row(x: Record<string, unknown>): AppWorkerRunRow {
  return {
    id: String(x.id), instance_id: String(x.instance_id), app_id: String(x.app_id), owner_member: String(x.owner_member),
    project_id: x.project_id == null ? null : Number(x.project_id), host_kind: x.host_kind as WorkerHostKind,
    host_id: x.host_id == null ? null : String(x.host_id), package_hash: String(x.package_hash),
    status: x.status as AppWorkerRunRow["status"], pid: x.pid == null ? null : Number(x.pid),
    exit_code: x.exit_code == null ? null : Number(x.exit_code), reason: x.reason == null ? null : String(x.reason),
    created_at: String(x.created_at), started_at: x.started_at == null ? null : String(x.started_at),
    ready_at: x.ready_at == null ? null : String(x.ready_at), last_active_at: x.last_active_at == null ? null : String(x.last_active_at),
    stopped_at: x.stopped_at == null ? null : String(x.stopped_at), updated_at: String(x.updated_at),
  };
}

export async function activeWorkerRun(instanceId: string): Promise<AppWorkerRunRow | null> {
  const r = await itemsPool.query(`SELECT * FROM org_app_worker_run WHERE instance_id=$1
    AND status IN ('prepared','starting','ready','idle','running','stopping') ORDER BY created_at DESC LIMIT 1`, [instanceId]);
  return r.rows[0] ? row(r.rows[0]) : null;
}

export async function prepareWorkerRun(input: {
  instanceId: string; appId: string; owner: string; projectId: number | null;
  hostKind: WorkerHostKind; hostId: string | null; packageHash: string;
}): Promise<AppWorkerRunRow> {
  const id = crypto.randomUUID();
  const r = await itemsPool.query(
    `INSERT INTO org_app_worker_run(id,instance_id,app_id,owner_member,project_id,host_kind,host_id,package_hash,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'prepared')
       ON CONFLICT (tenant_id,instance_id) WHERE status IN ('prepared','starting','ready','idle','running','stopping') DO NOTHING RETURNING *`,
    [id, input.instanceId, input.appId, input.owner, input.projectId, input.hostKind, input.hostId, input.packageHash],
  );
  if (r.rows[0]) return row(r.rows[0]);
  const existing = await activeWorkerRun(input.instanceId);
  if (!existing) throw new Error("worker-run-concurrent-create-lost");
  return existing;
}

export async function applyWorkerSnapshot(snapshot: WorkerRunSnapshot): Promise<void> {
  await itemsPool.query(
    `UPDATE org_app_worker_run SET status=$2,pid=$3,exit_code=$4,reason=$5,started_at=$6::timestamptz,
       ready_at=$7::timestamptz,last_active_at=$8::timestamptz,stopped_at=$9::timestamptz,updated_at=now() WHERE id=$1`,
    [snapshot.runId, snapshot.status, snapshot.pid, snapshot.exitCode, snapshot.reason, snapshot.startedAt,
     snapshot.readyAt, snapshot.lastActiveAt, snapshot.stoppedAt],
  );
}

export async function failPreparedWorkerRun(id: string, reason: string): Promise<void> {
  await itemsPool.query(`UPDATE org_app_worker_run SET status='failed',reason=$2,stopped_at=now(),updated_at=now()
    WHERE id=$1 AND status IN ('prepared','starting')`, [id, reason.slice(0, 500)]);
}

export async function failActiveWorkerRun(id: string, reason: string): Promise<void> {
  await itemsPool.query(`UPDATE org_app_worker_run SET status='failed',reason=$2,stopped_at=now(),updated_at=now()
    WHERE id=$1 AND status IN ('prepared','starting','ready','idle','running','stopping')`, [id, reason.slice(0, 500)]);
}

export async function listActiveWorkerRuns(filters: { appId?: string; owner?: string } = {}): Promise<AppWorkerRunRow[]> {
  const args: string[] = [];
  const where = ["status IN ('prepared','starting','ready','idle','running','stopping')"];
  if (filters.appId) { args.push(filters.appId); where.push(`app_id=$${args.length}`); }
  if (filters.owner) { args.push(filters.owner); where.push(`owner_member=$${args.length}`); }
  const r = await itemsPool.query(`SELECT * FROM org_app_worker_run WHERE ${where.join(" AND ")}`, args);
  return r.rows.map(row);
}
