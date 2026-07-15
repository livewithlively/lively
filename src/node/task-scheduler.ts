// 위탁 태스크 스케줄러(P2 #869) — 컨트롤플레인 루프(§10 요구 4종 반영).
//  ① 배치: 노드가 상시 push 하는 리소스(res) vs 태스크 예상 소모량(need_*)으로 적합 노드 선정(matchNode).
//  ② 중앙 = 내장 노드(§9-8): 후보에 "central" 을 저용량(기본 1슬롯)으로 포함 — 동점 시 후순위(오프로드 취지).
//  ③ 온오프 즉각 인지: registry heartbeat(10s)+close 이벤트. 노드 사망 시 grace(90s) 내 복귀면 감시 재장전(watchTask),
//     아니면 재큐(attempt<max) 또는 실패 확정 — 어느 쪽이든 의뢰 세션에 알림(injectToSession, best-effort).
//  ④ 자격(D1 의뢰자 시트): 의뢰자의 setup-token 시크릿(member_secret kind=claude-setup-token)이 있으면 env 리스로
//     아무 노드나, 없으면 의뢰자 프로필이 실재할 노드(central·본인 소유 노드)로만 배치.
//  단일 프로세스 전제(기존 스케줄러와 동일) — LIVELY_NO_SCHEDULER=1 이면 기동 안 함.
import { logger } from "../log.js";
import { SHARED_ROOT } from "../terminal-sessions.js";
import { getMemberSecret } from "../org/member-secret-store.js";
import { injectToSession } from "../scheduler.js";
import { nodeOnline, nodeRpc, schedulableRemotes, onTaskDone } from "./registry.js";
import { getNode } from "./store.js";
import {
  queuedTasks, runningTasks, runningCountByNode, markRunning, markFinished, requeue, setNodeLost, getTask,
  matchNode, type DelegateTask, type SchedulableNode,
} from "./task-store.js";
import { spawnTaskSession, checkTask, killTaskSession, sampleResources, detectDocker, type RunTaskResult } from "./tasks.js";

export const CENTRAL_NODE_ID = "central";
const TICK_MS = 5_000;
// 절전 복귀·VPN 재연결 창 — 이 안에 돌아오면 감시만 재장전(작업 계속). env 는 e2e/운영 튜닝용.
const OFFLINE_GRACE_MS = Math.max(3_000, Number(process.env.LIVELY_TASK_OFFLINE_GRACE_MS ?? 90_000));
const CAP_CENTRAL = Math.max(0, Number(process.env.LIVELY_CENTRAL_TASK_CAP ?? 1));  // §9-8 저용량 워커
const CAP_MEMBER = Math.max(0, Number(process.env.LIVELY_MEMBER_TASK_CAP ?? 1));    // ⑶ '적당히' 기본값
const CAP_WORKER = Math.max(0, Number(process.env.LIVELY_WORKER_TASK_CAP ?? 2));
const SECRET_KIND = "claude-setup-token"; // §8-3 — me_credential_set 으로 멤버가 1회 저장

let ticking = false;
let centralDocker: boolean | null = null;

function summaryOf(t: DelegateTask): string {
  return `위탁 #${t.id}`;
}

async function notify(t: DelegateTask, text: string): Promise<void> {
  if (!t.requester_session) return;
  await injectToSession(t.requester_session, `[lively] ${text}`).catch(() => { /* 의뢰 세션 종료됨 등 — 무시 */ });
}

async function finish(t: DelegateTask, ok: boolean, exit: number | null, summary?: string, error?: string): Promise<void> {
  await markFinished(t.id, ok, {
    exit, node: t.node_id, session: t.session_id, task_dir: t.task_dir,
    summary: (summary ?? "").slice(0, 8192),
  }, error ?? null);
  // 성공 = 세션 정리(워커 세션 잔존 방지) · 실패 = 세션 보존(사후 검시 — 웹터미널로 열람).
  if (ok && t.session_id && t.node_id) {
    if (t.node_id === CENTRAL_NODE_ID) await killTaskSession(t.session_id).catch(() => { /* 이미 없음 */ });
    else await nodeRpc(t.node_id, "kill", { user: { userId: t.requester }, id: t.session_id }).catch(() => { /* 노드 이탈 등 */ });
  }
  await notify(t, ok
    ? `${summaryOf(t)} 완료 (node=${t.node_id}) — delegate_status ${t.id} 로 결과 확인`
    : `${summaryOf(t)} 실패 (node=${t.node_id ?? "-"}): ${error ?? "unknown"} — 세션은 보존됨`);
  logger.info({ task: t.id, ok, node: t.node_id }, "위탁 태스크 종결");
}

// 원격 taskdone push 수신(레지스트리 훅).
function armTaskDoneHook(): void {
  onTaskDone((nodeId, m) => {
    void (async () => {
      const t = await getTask(m.taskId);
      if (!t || t.status !== "running" || t.node_id !== nodeId) return; // 재큐/취소 뒤 늦게 온 보고 — 무시
      await finish(t, m.ok, m.exit, m.summary, m.error);
    })().catch((err) => logger.warn({ err, task: m.taskId }, "taskdone 처리 실패"));
  });
}

// 자격/후보 정책(④) — 리스 시크릿이 있으면 전 노드, 없으면 central + 의뢰자 소유 노드만.
async function candidatesFor(t: DelegateTask, counts: Map<string, number>, extra: Map<string, number>): Promise<{ nodes: SchedulableNode[]; env?: Record<string, string> }> {
  let env: Record<string, string> | undefined;
  const sec = await getMemberSecret(t.requester, SECRET_KIND, "").catch(() => null);
  if (sec?.secret) env = { CLAUDE_CODE_OAUTH_TOKEN: sec.secret };
  const running = (id: string): number => (counts.get(id) ?? 0) + (extra.get(id) ?? 0);
  const nodes: SchedulableNode[] = [];
  if (CAP_CENTRAL > 0) {
    if (centralDocker === null) centralDocker = await detectDocker();
    nodes.push({
      id: CENTRAL_NODE_ID, kind: "central", central: true, hasDocker: centralDocker,
      res: await sampleResources(SHARED_ROOT.base).catch(() => null), capacity: CAP_CENTRAL, running: running(CENTRAL_NODE_ID),
    });
  }
  for (const r of schedulableRemotes()) {
    if (!env && r.owner !== t.requester) continue; // 리스 없음 → 의뢰자 프로필 실재 노드만
    nodes.push({ id: r.id, kind: r.kind, hasDocker: r.hasDocker, res: r.res, capacity: r.kind === "worker" ? CAP_WORKER : CAP_MEMBER, running: running(r.id) });
  }
  return { nodes, env };
}

async function assignQueued(): Promise<void> {
  const queued = await queuedTasks();
  if (!queued.length) return;
  const counts = await runningCountByNode();
  const extra = new Map<string, number>(); // 이번 tick 내 배정 가산(동일 노드 과배정 방지)
  for (const t of queued) {
    try {
      const { nodes, env } = await candidatesFor(t, counts, extra);
      const pick = matchNode(t, nodes);
      if (!pick) continue; // 적합 노드 없음 — 큐 유지(다음 tick). 영영 없으면 사용자가 cancel/노드 추가.
      let r: RunTaskResult;
      const runArgs = {
        user: { userId: t.requester }, taskId: t.id, rootKey: "shared", subpath: t.subpath,
        prompt: t.prompt, harness: t.harness, flags: t.flags ?? {}, env,
      };
      if (pick.id === CENTRAL_NODE_ID) {
        r = await spawnTaskSession(runArgs as never);
      } else {
        const n = await getNode(pick.id);
        if (!n || !n.enabled) continue; // 연결 후 비활성화된 노드 — 후보 제외
        r = await nodeRpc<RunTaskResult>(pick.id, "runTask", runArgs as never);
      }
      await markRunning(t.id, pick.id, r.sessionId, r.taskDir);
      extra.set(pick.id, (extra.get(pick.id) ?? 0) + 1);
      await notify(t, `${summaryOf(t)} 시작 (node=${pick.id}, session=${r.sessionId})`);
      logger.info({ task: t.id, node: pick.id, session: r.sessionId }, "위탁 태스크 배정");
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, task: t.id }, "위탁 배정 실패 — 다음 tick 재시도");
    }
  }
}

async function watchRunning(): Promise<void> {
  const running = await runningTasks();
  const now = Date.now();
  for (const t of running) {
    try {
      // 타임아웃(모든 노드 공통) — 세션 kill 후 실패 확정.
      if (t.started_at && now - new Date(t.started_at).getTime() > t.timeout_sec * 1000) {
        if (t.session_id) {
          if (t.node_id === CENTRAL_NODE_ID) await killTaskSession(t.session_id).catch(() => { /* noop */ });
          else if (t.node_id && nodeOnline(t.node_id)) await nodeRpc(t.node_id, "kill", { user: { userId: t.requester }, id: t.session_id }).catch(() => { /* noop */ });
        }
        await finish(t, false, null, undefined, `timeout(${t.timeout_sec}s)`);
        continue;
      }
      if (t.node_id === CENTRAL_NODE_ID) {
        // 중앙(내장 노드)은 스케줄러가 직접 감시 — 원격은 에이전트가 taskdone 을 push.
        const out = await checkTask({ taskId: t.id, sessionId: t.session_id ?? "", taskDir: t.task_dir ?? "" });
        if (out) await finish(t, out.ok, out.exit, out.summary, out.error);
        continue;
      }
      // 원격 노드 생존 처리(③) — 오프라인이면 grace, 복귀면 감시 재장전.
      const online = t.node_id ? nodeOnline(t.node_id) : false;
      if (!online) {
        if (!t.node_lost_at) { await setNodeLost(t.id, true); await notify(t, `${summaryOf(t)} 노드(${t.node_id}) 연결 끊김 — ${OFFLINE_GRACE_MS / 1000}s 복귀 대기`); continue; }
        if (now - new Date(t.node_lost_at).getTime() > OFFLINE_GRACE_MS) {
          if (t.attempt < t.max_attempts) {
            await requeue(t.id);
            await notify(t, `${summaryOf(t)} 노드 유실 — 다른 노드로 재스케줄(시도 ${t.attempt}/${t.max_attempts})`);
            logger.warn({ task: t.id, node: t.node_id }, "노드 유실 — 재큐");
          } else {
            await finish(t, false, null, undefined, `node-lost(${t.node_id})`);
          }
        }
        continue;
      }
      if (t.node_lost_at) {
        // 복귀 — 에이전트 재시작으로 감시 목록이 비었을 수 있어 재장전(멱등).
        await nodeRpc(t.node_id!, "watchTask", { taskId: t.id, sessionId: t.session_id, taskDir: t.task_dir }).catch(() => { /* 다음 tick */ });
        await setNodeLost(t.id, false);
        await notify(t, `${summaryOf(t)} 노드(${t.node_id}) 복귀 — 작업 계속`);
      }
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, task: t.id }, "위탁 감시 오류(비치명)");
    }
  }
}

export function startTaskScheduler(): void {
  armTaskDoneHook();
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    void (async () => {
      try { await watchRunning(); await assignQueued(); }
      catch (err) { logger.warn({ err }, "위탁 스케줄러 tick 오류"); }
      finally { ticking = false; }
    })();
  }, TICK_MS).unref();
  logger.info({ capCentral: CAP_CENTRAL, capMember: CAP_MEMBER, capWorker: CAP_WORKER }, "위탁 태스크 스케줄러 시작(P2)");
}
