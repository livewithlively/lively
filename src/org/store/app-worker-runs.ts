// AppInstance worker 실행 이력(#1780 Stage B). 실행 호스트가 보내는 snapshot을 DB 정본으로 접는다.
import crypto from "node:crypto";
import { itemsPool } from "../../db/client.js";
import type { WorkerRunSnapshot, WorkerRunStatus } from "../../apps/worker-host.js";

export type WorkerHostKind = "central" | "remote";
export interface AppWorkerRunRow {
  id: string; instance_id: string; app_id: string; owner_member: string; project_id: number | null;
  host_kind: WorkerHostKind; host_id: string | null; package_hash: string; status: "prepared" | WorkerRunStatus;
  pid: number | null; exit_code: number | null; reason: string | null; memory_mb: number | null;
  created_at: string; started_at: string | null; ready_at: string | null; last_active_at: string | null; stopped_at: string | null; updated_at: string;
}

function row(x: Record<string, unknown>): AppWorkerRunRow {
  return {
    id: String(x.id), instance_id: String(x.instance_id), app_id: String(x.app_id), owner_member: String(x.owner_member),
    project_id: x.project_id == null ? null : Number(x.project_id), host_kind: x.host_kind as WorkerHostKind,
    host_id: x.host_id == null ? null : String(x.host_id), package_hash: String(x.package_hash),
    status: x.status as AppWorkerRunRow["status"], pid: x.pid == null ? null : Number(x.pid),
    exit_code: x.exit_code == null ? null : Number(x.exit_code), reason: x.reason == null ? null : String(x.reason),
    memory_mb: x.memory_mb == null ? null : Number(x.memory_mb),
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

export async function getWorkerRun(id: string): Promise<AppWorkerRunRow | null> {
  const r = await itemsPool.query(`SELECT * FROM org_app_worker_run WHERE id=$1`, [id]);
  return r.rows[0] ? row(r.rows[0]) : null;
}

export async function latestWorkerRun(instanceId: string): Promise<AppWorkerRunRow | null> {
  const r = await itemsPool.query(`SELECT * FROM org_app_worker_run WHERE instance_id=$1 ORDER BY created_at DESC LIMIT 1`, [instanceId]);
  return r.rows[0] ? row(r.rows[0]) : null;
}

// ── 목록용 일괄 조회(#2234) ───────────────────────────────────────────────────
//  왜: `/api/ui/app-instances` 가 인스턴스마다 activeWorkerRun + latestWorkerRun 을 **순차로** 물었다.
//   실측 2026-08-27(dev, 인스턴스 92건): 그 목록 한 번이 **4.4초** — 나머지 다섯 축을 다 합친 것의 6배다.
//   그런데 이 축은 부팅 첫 그림의 배리어(web/v2/main.ts loadData 의 Promise.all)에 함께 묶여 있어,
//   0.3초에 도착한 세션 목록을 화면이 4.4초 동안 못 썼다 — 그동안 좌측 행은 전부 '목록에서 못 찾음'
//   (unresolved)이라 이름이 브라우저 기억으로, 소속 줄이 'AI 세션' 으로 떨어진다. 사용자가 신고한
//   "앱 로드될 때 한참 이런 화면" 이 그 창이다. 왕복 수를 행 수에 비례시키지 않는다.
const ACTIVE_STATUSES = "('prepared','starting','ready','idle','running','stopping')";

/** 인스턴스별 **가장 최근** 실행 한 줄씩 — 한 번의 조회로. */
export async function latestWorkerRuns(instanceIds: string[]): Promise<Map<string, AppWorkerRunRow>> {
  return runsByInstance(instanceIds, "");
}

/** 인스턴스별 **살아 있는** 실행 한 줄씩 — 한 번의 조회로(없으면 그 키는 맵에 없다). */
export async function activeWorkerRuns(instanceIds: string[]): Promise<Map<string, AppWorkerRunRow>> {
  return runsByInstance(instanceIds, `AND status IN ${ACTIVE_STATUSES}`);
}

async function runsByInstance(instanceIds: string[], extra: string): Promise<Map<string, AppWorkerRunRow>> {
  const ids = [...new Set(instanceIds.filter(Boolean))];
  const out = new Map<string, AppWorkerRunRow>();
  if (!ids.length) return out;
  const r = await itemsPool.query(
    `SELECT DISTINCT ON (instance_id) * FROM org_app_worker_run
      WHERE instance_id = ANY($1::text[]) ${extra}
      ORDER BY instance_id, created_at DESC`, [ids]);
  for (const x of r.rows) out.set(String(x.instance_id), row(x));
  return out;
}

export async function prepareWorkerRun(input: {
  instanceId: string; appId: string; owner: string; projectId: number | null;
  hostKind: WorkerHostKind; hostId: string | null; packageHash: string; memoryMb?: number | null;
}): Promise<AppWorkerRunRow> {
  const id = crypto.randomUUID();
  const r = await itemsPool.query(
    `INSERT INTO org_app_worker_run(id,instance_id,app_id,owner_member,project_id,host_kind,host_id,package_hash,memory_mb,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'prepared')
       ON CONFLICT (tenant_id,instance_id) WHERE status IN ('prepared','starting','ready','idle','running','stopping') DO NOTHING RETURNING *`,
    [id, input.instanceId, input.appId, input.owner, input.projectId, input.hostKind, input.hostId, input.packageHash, input.memoryMb ?? null],
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

/**
 * 조직 예산 판정을 위한 현재 사용량(#1780 Stage B).
 *
 * ⚠ `excludeInstanceId` 는 **반드시** 지금 띄우려는 인스턴스다 — 재시작·복구가 자기 자신의 기존 run 때문에
 *  상한에 걸려 못 살아나면 정책이 복구를 막는 자충수가 된다.
 * memory_mb 가 NULL 인 구 행은 0으로 본다(이 컬럼 이전에 뜬 run — 없는 값을 지어내지 않는다).
 */
export async function workerBudgetUsage(excludeInstanceId: string, owner: string): Promise<{ activeTotal: number; activeForMember: number; memoryMbTotal: number }> {
  const r = await itemsPool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE owner_member=$2)::int AS mine,
            COALESCE(SUM(COALESCE(memory_mb,0)),0)::int AS memory
       FROM org_app_worker_run
      WHERE status IN ('prepared','starting','ready','idle','running','stopping') AND instance_id <> $1`,
    [excludeInstanceId, owner],
  );
  const x = (r.rows[0] ?? {}) as Record<string, unknown>;
  return { activeTotal: Number(x.total ?? 0), activeForMember: Number(x.mine ?? 0), memoryMbTotal: Number(x.memory ?? 0) };
}
