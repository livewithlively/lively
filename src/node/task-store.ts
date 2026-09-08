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
  // 실행 하네스(#1884) — 헤드리스 규약을 아는 키(tasks.ts HEADLESS). 비우면 **DB 기본('claude')** — 구 호출자 무회귀.
  //  값 검증은 호출자(headless-harness.resolveHeadlessHarness · delegate_run 의 400)와 실행 직전 spawnTaskSession 이 한다.
  harness?: string | null;
  repo?: string | null; gitRef?: string | null;
  flags?: Record<string, string>; needCpu?: number | null; needRamMb?: number | null; needDiskMb?: number | null;
  needsDocker?: boolean; nodePref?: string | null; timeoutSec?: number; maxAttempts?: number;
}): Promise<DelegateTask> {
  const harness = (input.harness ?? "").trim();   // 빈 값은 컬럼을 아예 안 써서 DB DEFAULT 가 살아 있게 한다
  const r = await itemsPool.query(
    `INSERT INTO org_task(requester, requester_session, prompt, subpath, repo, git_ref, flags, need_cpu, need_ram_mb, need_disk_mb,
                          needs_docker, node_pref, timeout_sec, max_attempts${harness ? ", harness" : ""})
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14${harness ? ",$15" : ""}) RETURNING *`,
    [input.requester, input.requesterSession ?? null, input.prompt, input.subpath ?? "", input.repo ?? null, input.gitRef ?? null,
     JSON.stringify(input.flags ?? {}), input.needCpu ?? null, input.needRamMb ?? null, input.needDiskMb ?? null,
     !!input.needsDocker, input.nodePref ?? null,
     Math.min(Math.max(60, input.timeoutSec ?? 3600), 6 * 3600), Math.min(Math.max(1, input.maxAttempts ?? 2), 5),
     ...(harness ? [harness] : [])],
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
  const r = await itemsPool.query(
    `UPDATE org_task SET status='running', node_id=$2, session_id=$3, task_dir=$4,
        attempt=attempt+1, started_at=now(), node_lost_at=NULL, updated_at=now() WHERE id=$1
      RETURNING tenant_id`,
    [id, nodeId, sessionId, taskDir]);
  // #1631 — 위탁 세션을 **그 태스크의 워크스페이스에 묶는다.** 사람 세션은 라우트(recordSessionTenant)가 묶지만 위탁은
  //  노드가 띄우고 여기서 처음 세션 id 를 알게 된다. 안 묶으면 그 세션의 MCP 호출(x-lively-session → gw_session_map)이
  //  primary 로 떨어져, 증류 배치가 **다른 워크스페이스의 자료 id·분류 key 를 보고 저장을 거부**한다
  //  (실측 2026-08-30 dev: 페르소나 워크스페이스의 distill 잡 #78 — 지식 본문은 뽑았는데 "원래 대상 워크스페이스에서 돌려 달라"로 차단).
  //  primary 는 묶지 않는다(행 없음 = primary 가 이미 규약). 실패는 로그만 — 태스크는 이미 돌고 있다.
  const tenantId = String((r.rows[0] as { tenant_id?: string } | undefined)?.tenant_id ?? "");
  if (tenantId) {
    const { PRIMARY_TENANT_ID, setSessionWorkspace } = await import("../org/tenancy/registry.js");
    if (tenantId !== PRIMARY_TENANT_ID) {
      await setSessionWorkspace(sessionId, tenantId)
        .catch((e) => console.warn(`[task-store] 위탁 세션 워크스페이스 바인딩 실패(task ${id}, ${sessionId}): ${(e as Error)?.message ?? e}`));
    }
  }
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
    //  방치 배치의 기록도 같은 이유로 되돌린다 — 레인이 없어 별 테이블에 남기므로 위 DELETE 가 못 지운다.
    try { await itemsPool.query(`DELETE FROM org_stranded_seen WHERE task_id=$1`, [id]); }
    catch { /* 테이블 없음 등 — 무해 */ }
  }
}
/**
 * 재큐 — 노드 유실 등으로 다른 노드에 다시 배정한다.
 *
 * ⚠ `session_id` 를 비우므로 **직전 시도의 세션 좌표가 사라진다.** 그 노드가 돌아왔을 때 세션이 살아 있으면
 *  아무도 그것을 그 태스크와 잇지 못한다(영구 고아). 중앙은 오프라인 노드의 세션을 지울 수단이 없으므로
 *  최소한 **좌표를 결과에 남겨** 나중에 추적할 수 있게 한다(#1675 리뷰 후속).
 */
export async function requeue(id: number, orphan?: { node: string | null; session: string | null }): Promise<void> {
  const mark = orphan?.session ? JSON.stringify({ orphan_session: { node: orphan.node, session: orphan.session } }) : null;
  await itemsPool.query(
    `UPDATE org_task SET status='queued', node_id=NULL, session_id=NULL, task_dir=NULL, node_lost_at=NULL,
        result = CASE WHEN $2::text IS NULL THEN result ELSE COALESCE(result,'{}'::jsonb) || $2::jsonb END,
        updated_at=now() WHERE id=$1`, [id, mark]);
}
export async function markCanceled(id: number): Promise<void> {
  await itemsPool.query(`UPDATE org_task SET status='canceled', finished_at=now(), updated_at=now() WHERE id=$1`, [id]);
}
export async function setNodeLost(id: number, lost: boolean): Promise<void> {
  await itemsPool.query(`UPDATE org_task SET node_lost_at=${lost ? "now()" : "NULL"}, updated_at=now() WHERE id=$1`, [id]);
}

// ── 리소스-적합 매칭(§10, 순수 함수) ──
//  후보 = online·enabled + (node_pref 일치) + **하네스 지원**(#1884) + (needs_docker→hasDocker) + 용량 슬롯 여유 + 리소스 적합.
//  적합: mem_free ≥ need_ram(+여유 512MB) · disk_free ≥ need_disk(+1GB) · 유휴코어(cpus−load1) ≥ need_cpu(soft).
//  점수 = 남는 메모리 큰 순(단순 최빈 자원) — central 은 저용량 워커(⑶·§9-8)라 동점 시 후순위.
export interface SchedulableNode {
  id: string; kind: string; central?: boolean; hasDocker: boolean;
  res: NodeResources | null; capacity: number; running: number;
  /** 이 노드가 실제로 띄울 수 있는 하네스(#1884) — 원격=hello 가 보고한 agent_harnesses(미보고면 기준선) · 중앙=detectHarnesses.
   *  종전엔 이 축이 없어 codex 위탁이 claude 만 깔린 노드에 배정돼 즉사했다(리소스는 남아도 바이너리가 없다). */
  harnesses: readonly string[];
}
export function matchNode(task: Pick<DelegateTask, "need_cpu" | "need_ram_mb" | "need_disk_mb" | "needs_docker" | "node_pref" | "harness">,
  nodes: SchedulableNode[]): SchedulableNode | null {
  const fit = nodes.filter((n) => {
    if (task.node_pref && n.id !== task.node_pref) return false;
    if (!n.harnesses.includes(task.harness)) return false;   // 그 하네스가 없는 노드 — "모르면 못 한다고 본다"(protocol.nodeHarnesses)
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
