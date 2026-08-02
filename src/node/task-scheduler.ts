// 위탁 태스크 스케줄러(P2 #869) — 컨트롤플레인 루프(§10 요구 4종 반영).
//  ① 배치: 노드가 상시 push 하는 리소스(res) vs 태스크 예상 소모량(need_*)으로 적합 노드 선정(matchNode).
//  ② 중앙 = 내장 노드(§9-8): 후보에 "central" 을 저용량(기본 1슬롯)으로 포함 — 동점 시 후순위(오프로드 취지).
//  ③ 온오프 즉각 인지: registry heartbeat(10s)+close 이벤트. 노드 사망 시 grace(90s) 내 복귀면 감시 재장전(watchTask),
//     아니면 재큐(attempt<max) 또는 실패 확정. 진행/결과 통지는 CLI 프로세스가 pull(§11) — 스케줄러는 상태 전이만.
//  ④ 자격(D1 의뢰자 시트): 의뢰자의 setup-token 시크릿(member_secret kind=claude_setup_token)이 있으면 env 리스로
//     아무 노드나, 없으면 의뢰자 프로필이 실재할 노드(central·본인 소유 노드)로만 배치.
//  단일 프로세스 전제(기존 스케줄러와 동일) — LIVELY_NO_SCHEDULER=1 이면 기동 안 함.
import { logger } from "../log.js";
import { SHARED_ROOT } from "../terminal/terminal-sessions.js";
import { effectiveDelegatePolicy, type DelegatePolicy } from "../org/policies/delegate-policy.js";
import { getMemberSecret, memberOwner } from "../org/credentials/member-secret-store.js";
import { getRuntimeConfig } from "../org/store.js";
import { resolveRepoInject } from "../project/project-provision.js";
import { nodeOnline, nodeRpc, schedulableRemotes, onTaskDone } from "./registry.js";
import { getNode } from "./store.js";
import {
  queuedTasks, runningTasks, runningCountByNode, markRunning, markFinished, requeue, setNodeLost, getTask,
  matchNode, type DelegateTask, type SchedulableNode,
} from "./task-store.js";
import { spawnTaskSession, checkTask, killTaskSession, sampleResources, detectDocker, tailTask, type RunTaskResult, type TailResult } from "./tasks.js";

export const CENTRAL_NODE_ID = "central";
const TICK_MS = 5_000;
// 절전 복귀·VPN 재연결 창 — 이 안에 돌아오면 감시만 재장전(작업 계속). env 는 e2e/운영 튜닝용.
const OFFLINE_GRACE_MS = Math.max(3_000, Number(process.env.LIVELY_TASK_OFFLINE_GRACE_MS ?? 90_000));
const CAP_CENTRAL = Math.max(0, Number(process.env.LIVELY_CENTRAL_TASK_CAP ?? 1));  // §9-8 저용량 워커
const CAP_MEMBER = Math.max(0, Number(process.env.LIVELY_MEMBER_TASK_CAP ?? 1));    // ⑶ '적당히' 기본값
const CAP_WORKER = Math.max(0, Number(process.env.LIVELY_WORKER_TASK_CAP ?? 2));
// §8-3 — me_credential_set 또는 '내 로그인' UI 로 멤버가 1회 저장.
//  ⚠ 이름은 반드시 member-secret-store 의 KIND_RE(/^[a-z0-9_]{1,40}$/) 를 지킬 것 — 하이픈(claude-setup-token)은
//  setMemberSecret 이 거부해 애초에 저장이 불가능한데(#1299 등록 UI 가 이 오류로 막혔었다), 조회(getMemberSecret)는
//  정규화를 안 타 조용히 null 을 주므로 "저장도 안 되고 리스도 영영 안 붙는" 무증상 결함이 된다(#1101 의 32분 무출력 hang).
//  export 는 테스트용 — alerts.ts 의 ALERT_KIND 와 같은 좌표상수 취급(task-scheduler-kind.test.ts 가 정규식을 못박는다).
export const SECRET_KIND = "claude_setup_token";

// liveness 가드(#1101 이월) — 시작 후 이 시간 동안 워커가 **한 바이트도** 못 뱉으면 조기 종결한다.
//  `claude -p --output-format stream-json` 은 정상이면 init 이벤트를 즉시 뱉으므로, 0바이트는 프로세스가
//  auth/init 에서 막혔다는 뜻이다. 가장 흔한 원인이 의뢰자의 claude_setup_token 부재/만료 —
//  격리 박스엔 공유 ~/.claude 로그인 폴백이 없어(#1014) 자격이 없으면 fast-fail 이 아니라 **hang** 한다.
//  이 가드가 없으면 timeout_sec(기본 1h)까지 무출력으로 매달렸다가 error=null·result=null 로 죽어
//  단서가 하나도 안 남는다(#1101 고객사 A 실측: 32분 무진척, 스트림 0바이트, exit 없음).
//  0 이면 비활성. 레포 준비가 오래 걸리는 박스는 늘려 잡는다.
//  ⚠ 값의 출처는 **관리탭(DB) > env 시드 > 기본 5분**(src/org/policies/delegate-policy.ts) — 고객 박스는 SSH 로 못 들어가
//  .env 를 못 고치므로 env 전용이면 정작 이 노브가 필요한 곳에서 못 바꾼다(storage/session-reclaim 과 동일 교리).
const loadDelegatePolicy = (): Promise<DelegatePolicy> => getRuntimeConfig().then((c) => c.delegate_policy);
//  진행이 한 번 확인된 태스크는 다시 재지 않는다(매 tick RPC/파일읽기 낭비 방지).
//  ⚠ 값이 '확인된 시도 회차(attempt)' 인 게 핵심 — 노드 유실 재큐는 finish 를 안 거치고 attempt 만 올린다.
//  taskId 만으로 기억하면 재배정된 작업이 새 노드에서 무출력이어도 "이미 진행 확인됨"으로 스킵돼 가드가 죽는다.
const liveSeen = new Map<number, number>();

let ticking = false;
let centralDocker: boolean | null = null;

// 무출력 stall 판정(순수) — '언제 죽일지'를 시간·바이트만으로 정한다(테스트 가능하게 분리).
//  bytes 는 워커가 지금까지 뱉은 stream.jsonl 바이트. **경과가 상한을 넘고 그때까지 0바이트**일 때만 stall.
//  stallMs=0(비활성)·startedAt 부재·아직 상한 전·1바이트라도 나온 경우는 전부 아니다.
export function isStalled(o: { startedAt: string | null; now: number; bytes: number; stallMs: number }): boolean {
  if (o.stallMs <= 0 || !o.startedAt) return false;
  const started = new Date(o.startedAt).getTime();
  if (!Number.isFinite(started)) return false;      // 파싱 불가 → 판단 보류(죽이지 않는다)
  return o.now - started > o.stallMs && o.bytes <= 0;
}

// 워커가 지금까지 뱉은 바이트. 중앙은 로컬 파일, 원격은 tailTask RPC(같은 함수의 릴레이).
//  ⚠ 알 수 없으면 **1(진행 있음)** 을 돌려준다 — 조회 실패로 멀쩡한 작업을 죽이지 않기 위한 fail-safe.
async function progressBytes(t: DelegateTask): Promise<number> {
  const dir = t.task_dir ?? "";
  if (!dir) return 1;
  if (t.node_id === CENTRAL_NODE_ID) return (await tailTask(dir, 0)).next;
  if (!t.node_id || !nodeOnline(t.node_id)) return 1;   // 오프라인은 노드 유실 경로가 따로 처리한다
  const r = await nodeRpc<TailResult>(t.node_id, "tailTask", { taskDir: dir, from: 0 });
  return r?.next ?? 1;
}

// 워커 세션 강제 종료(중앙=로컬 tmux, 원격=노드 RPC). 이미 없거나 노드가 이탈했으면 조용히 넘어간다.
async function killTaskAnywhere(t: DelegateTask): Promise<void> {
  if (!t.session_id) return;
  if (t.node_id === CENTRAL_NODE_ID) await killTaskSession(t.session_id).catch(() => { /* noop */ });
  else if (t.node_id && nodeOnline(t.node_id)) {
    await nodeRpc(t.node_id, "kill", { user: { userId: t.requester }, id: t.session_id }).catch(() => { /* noop */ });
  }
}

// 상태 전이만 DB 에 기록한다 — 의뢰 세션 통지는 하지 않는다(§11: 흐름은 CLI 프로세스가 pull/스트림).
async function finish(t: DelegateTask, ok: boolean, exit: number | null, summary?: string, error?: string): Promise<void> {
  liveSeen.delete(t.id);
  await markFinished(t.id, ok, {
    exit, node: t.node_id, session: t.session_id, task_dir: t.task_dir,
    summary: (summary ?? "").slice(0, 8192),
  }, error ?? null);
  // 성공 = 세션 정리(워커 세션 잔존 방지) · 실패 = 세션 보존(사후 검시 — 웹터미널로 열람).
  if (ok && t.session_id && t.node_id) {
    if (t.node_id === CENTRAL_NODE_ID) await killTaskSession(t.session_id).catch(() => { /* 이미 없음 */ });
    else await nodeRpc(t.node_id, "kill", { user: { userId: t.requester }, id: t.session_id }).catch(() => { /* 노드 이탈 등 */ });
  }
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

// 큐 대기 상한(⑤) — queue:true 로 등록한 태스크가 적합 노드를 이 시간 안에 못 얻으면 no_capacity 로 실패.
//  무한 대기(사용자 지적) 방지. 기본 10분, env 로 조정.
const QUEUE_MAX_MS = Math.max(0, Number(process.env.LIVELY_TASK_QUEUE_MAX_MS ?? 600_000));

// 배치 불가 사유(하네스에게 '왜 안 되는지'를 즉답 — 로컬 폴백 판단 재료). 각 후보 노드의 탈락 이유를 모은다.
function capacityReason(t: Pick<DelegateTask, "need_cpu" | "need_ram_mb" | "need_disk_mb" | "needs_docker">, nodes: SchedulableNode[]): string {
  if (!nodes.length) return "가용 노드 없음(등록된 노드가 없거나, 의뢰자 자격으로 쓸 수 있는 노드가 없음 — setup-token 미등록 시 중앙·본인 노드만)";
  const bits = nodes.map((n) => {
    if (n.running >= n.capacity) return `${n.id}: 슬롯 만석(${n.running}/${n.capacity})`;
    if (t.needs_docker && !n.hasDocker) return `${n.id}: docker 없음`;
    if (!n.res) return `${n.id}: 리소스 미보고(오프라인?)`;
    if (t.need_ram_mb != null && n.res.mem_free_mb < t.need_ram_mb + 512) return `${n.id}: RAM 여유 ${n.res.mem_free_mb}MB < 요구 ${t.need_ram_mb + 512}MB`;
    if (t.need_disk_mb != null && n.res.disk_free_mb < t.need_disk_mb + 1024) return `${n.id}: 디스크 여유 ${n.res.disk_free_mb}MB 부족`;
    if (t.need_cpu != null && Math.max(0, n.res.cpus - n.res.load1) < t.need_cpu) return `${n.id}: 유휴코어 ${Math.max(0, n.res.cpus - n.res.load1).toFixed(1)} < 요구 ${t.need_cpu}`;
    return `${n.id}: 부적합`;
  });
  return "가용 노드 없음 — " + bits.join(" · ");
}

// 자격 리스(④) — 의뢰자가 등록한 셋업토큰을 env 로 싣는다.
//  ⚠ 조회 키는 **owner 문자열**이다(`member:<id>`) — 멤버 id 를 그대로 넘기면 저장 키와 안 맞아 **항상 null** 이고
//  아무 오류도 안 난다(자격 없음으로 강등될 뿐). 실제로 그렇게 새고 있었다: 등록해도 리스가 영영 안 붙어
//  워커 디스크의 로그인 자격이 대신 쓰였고, 후보도 central 로 좁혀졌다(#1289 실측 — last_used_at 이 계속 null).
//  lookup 주입은 테스트용(저장소 없이 owner 키·강등 경로를 못박는다).
export async function leaseEnvFor(
  requester: string,
  lookup: (owner: string, kind: string, scope: string) => Promise<{ secret: string | null } | null> = getMemberSecret,
): Promise<Record<string, string> | undefined> {
  const sec = await lookup(memberOwner(requester), SECRET_KIND, "").catch(() => null);
  return sec?.secret ? { CLAUDE_CODE_OAUTH_TOKEN: sec.secret } : undefined;
}

// 원격 후보 정책(④) — 리스가 있으면 아무 노드, 없으면 의뢰자 프로필이 실재하는 노드(본인 소유)만.
export function remoteAllowed(hasLease: boolean, nodeOwner: string | null | undefined, requester: string): boolean {
  return hasLease || nodeOwner === requester;
}

// 자격/후보 정책(④) — 리스 시크릿이 있으면 전 노드, 없으면 central + 의뢰자 소유 노드만.
async function candidatesFor(t: DelegateTask, counts: Map<string, number>, extra: Map<string, number>): Promise<{ nodes: SchedulableNode[]; env?: Record<string, string> }> {
  const env = await leaseEnvFor(t.requester);
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
    if (!remoteAllowed(Boolean(env), r.owner, t.requester)) continue; // 리스 없음 → 의뢰자 프로필 실재 노드만
    nodes.push({ id: r.id, kind: r.kind, hasDocker: r.hasDocker, res: r.res, capacity: r.kind === "worker" ? CAP_WORKER : CAP_MEMBER, running: running(r.id) });
  }
  return { nodes, env };
}

// 한 태스크를 후보와 매칭해 실제 배정(spawn)한다. counts/extra 는 같은 tick 과배정 방지(단발 호출은 빈 extra).
//  반환: assigned 되면 nodeId, 아니면 사람이 읽을 reason(하네스 로컬 폴백 판단용).
export interface AssignResult { assigned: boolean; nodeId?: string; reason?: string }
async function assignOne(t: DelegateTask, counts: Map<string, number>, extra: Map<string, number>): Promise<AssignResult> {
  const { nodes, env } = await candidatesFor(t, counts, extra);
  const pick = matchNode(t, nodes);
  if (!pick) return { assigned: false, reason: capacityReason(t, nodes) };
  const runArgs: Record<string, unknown> = {
    user: { userId: t.requester }, taskId: t.id, rootKey: "shared", subpath: t.subpath,
    prompt: t.prompt, harness: t.harness, repo: t.repo, gitRef: t.git_ref, flags: t.flags ?? {}, env,
  };
  let r: RunTaskResult;
  if (pick.id === CENTRAL_NODE_ID) {
    r = await spawnTaskSession(runArgs as never);   // 중앙 = 게이트웨이 프로세스 → DB 를 직접 읽는다(주입 불필요)
  } else {
    const n = await getNode(pick.id);
    if (!n || !n.enabled) return { assigned: false, reason: `선정 노드 ${pick.id} 비활성` };
    // 🔴 원격 노드엔 **DB 가 없다**(#905 C4) — 레포 정보를 여기서 해소해 실어 보내지 않으면, 노드의
    //  ensureBaseClone 이 getRepo() 로 localhost:5432 에 붙으려다 실패하고 409 "레포의 git 주소가 레지스트리에
    //  없습니다" 라는 **오진**을 낸다(레포는 멀쩡한데 사용자를 헛다리 짚게 한다 — 오늘 라이브 버그).
    if (t.repo) runArgs.repoAuth = await resolveRepoInject(String(t.repo), t.requester, n.kind);
    r = await nodeRpc<RunTaskResult>(pick.id, "runTask", runArgs as never);
  }
  await markRunning(t.id, pick.id, r.sessionId, r.taskDir);
  extra.set(pick.id, (extra.get(pick.id) ?? 0) + 1);
  logger.info({ task: t.id, node: pick.id, session: r.sessionId }, "위탁 태스크 배정");
  return { assigned: true, nodeId: pick.id };
}

// delegate_run 이 생성 직후 즉시 호출 — 배치 판정+실행을 그 자리에서(스케줄러 tick 을 안 기다림).
//  이게 "요청→즉답" 계약의 핵심: 배치되면 running, 안 되면 reason 을 하네스에게 바로 준다(무한 큐 방지).
export async function tryAssignNow(t: DelegateTask): Promise<AssignResult> {
  const counts = await runningCountByNode();
  try { return await assignOne(t, counts, new Map()); }
  catch (err) { return { assigned: false, reason: `배치 오류: ${(err as Error)?.message ?? err}` }; }
}

async function assignQueued(): Promise<void> {
  const queued = await queuedTasks();
  if (!queued.length) return;
  const now = Date.now();
  const counts = await runningCountByNode();
  const extra = new Map<string, number>(); // 이번 tick 내 배정 가산(동일 노드 과배정 방지)
  for (const t of queued) {
    try {
      // 큐 대기 상한(⑤) — 적합 노드를 QUEUE_MAX 안에 못 얻으면 무한 대기 대신 no_capacity 실패.
      if (QUEUE_MAX_MS > 0 && now - new Date(t.created_at).getTime() > QUEUE_MAX_MS) {
        await markFinished(t.id, false, { reason: "no_capacity_timeout" }, `대기 시간 초과(${Math.round(QUEUE_MAX_MS / 60000)}분) — 적합 노드 없음`);
        logger.info({ task: t.id }, "큐 대기 초과 — no_capacity 실패");
        continue;
      }
      await assignOne(t, counts, extra); // 실패해도 큐 유지(다음 tick 재시도, 상한까지)
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, task: t.id }, "위탁 배정 실패 — 다음 tick 재시도");
    }
  }
}

async function watchRunning(): Promise<void> {
  const running = await runningTasks();
  const now = Date.now();
  // tick 당 1회만 읽는다(30s 캐시 + DB 실패 시 마지막 값 폴백 — stall 판정이 정책 조회로 막히지 않게).
  const STALL_MS = (await effectiveDelegatePolicy(loadDelegatePolicy)).stall_ms;
  for (const t of running) {
    try {
      // 타임아웃(모든 노드 공통) — 세션 kill 후 실패 확정.
      if (t.started_at && now - new Date(t.started_at).getTime() > t.timeout_sec * 1000) {
        await killTaskAnywhere(t);
        await finish(t, false, null, undefined, `timeout(${t.timeout_sec}s)`);
        continue;
      }
      // liveness 가드(#1101) — 무출력으로 매달린 작업을 timeout_sec 까지 기다리지 않고 조기 종결한다.
      //  진행이 한 번이라도 확인되면 이후 tick 에선 재지 않는다(liveSeen).
      if (STALL_MS > 0 && liveSeen.get(t.id) !== t.attempt && t.started_at && now - new Date(t.started_at).getTime() > STALL_MS) {
        const bytes = await progressBytes(t).catch(() => 1);   // 조회 실패 = 진행 있음으로 간주(오탐 방지)
        if (isStalled({ startedAt: t.started_at, now, bytes, stallMs: STALL_MS })) {
          await killTaskAnywhere(t);
          // 재큐하지 않는다 — 자격 부재·init 실패는 재시도해도 같은 결과다(타임아웃 경로와 같은 판단).
          await finish(t, false, null, undefined,
            `무출력 stall(${Math.round(STALL_MS / 1000)}s) — 워커가 한 바이트도 내지 않았습니다. `
            + `의뢰자(${t.requester})의 claude_setup_token 미등록/만료로 인증이 안 됐을 수 있습니다`
            + `(격리 박스엔 공유 로그인 폴백이 없습니다). 레포 준비가 오래 걸리는 박스면 LIVELY_TASK_STALL_MS 를 늘리세요.`);
          logger.warn({ task: t.id, node: t.node_id, requester: t.requester, stallMs: STALL_MS }, "위탁 태스크 무출력 stall — 조기 종결");
          continue;
        }
        liveSeen.set(t.id, t.attempt);
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
        if (!t.node_lost_at) { await setNodeLost(t.id, true); logger.info({ task: t.id, node: t.node_id }, "노드 연결 끊김 — 복귀 대기"); continue; }
        if (now - new Date(t.node_lost_at).getTime() > OFFLINE_GRACE_MS) {
          if (t.attempt < t.max_attempts) {
            await requeue(t.id);
            logger.warn({ task: t.id, node: t.node_id, attempt: t.attempt }, "노드 유실 — 재큐");
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
        logger.info({ task: t.id, node: t.node_id }, "노드 복귀 — 작업 계속");
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
