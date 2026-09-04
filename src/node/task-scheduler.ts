// 위탁 태스크 스케줄러(P2 #869) — 컨트롤플레인 루프(§10 요구 4종 반영).
//  ① 배치: 노드가 상시 push 하는 리소스(res) vs 태스크 예상 소모량(need_*)으로 적합 노드 선정(matchNode).
//  ② 중앙 = 내장 노드(§9-8): 후보에 "central" 을 저용량(기본 1슬롯)으로 포함 — 동점 시 후순위(오프로드 취지).
//  ③ 온오프 즉각 인지: registry heartbeat(10s)+close 이벤트. 노드 사망 시 grace(90s) 내 복귀면 감시 재장전(watchTask),
//     아니면 재큐(attempt<max) 또는 실패 확정. 진행/결과 통지는 CLI 프로세스가 pull(§11) — 스케줄러는 상태 전이만.
//  ④ 후보 자격(D1 의뢰자 시트 + #1540): 배치 후보는 **central · 의뢰자가 등록한 노드 · 관리자가 공유로 지정한 노드**
//     뿐이다. 공유 노드는 그 박스에 의뢰자 프로필이 없으므로 setup-token 시크릿(member_secret
//     kind=claude_setup_token — claude 위탁만, LEASE_SECRET)을 env 리스로 실을 수 있을 때만 후보다. 본인 노드는 본인 로그인이 그 머신에 있어 리스 불요.
//  ⑤ 하네스(#1884): 후보는 **그 하네스를 실제로 띄울 수 있는 노드**뿐이다(원격=hello 의 agent_harnesses · 중앙=detectHarnesses).
//     ⚠ 종전 규칙은 `리스 있으면 아무 노드나` 였다 — 리스 하나로 남의 노트북이 열렸다(#1540 이 닫은 구멍).
//  단일 프로세스 전제(기존 스케줄러와 동일) — LIVELY_NO_SCHEDULER=1 이면 기동 안 함.
//  ★ 그 전제를 **리더선출로 바꿨다**(#2664 3단계, scheduler/leader.ts) — 매니지드 무중단 롤이
//   게이트웨이를 겹쳐 띄우므로 env 플래그로는 못 가른다(두 프로세스가 같은 이미지·같은 env 다).
import { logger } from "../log.js";
import { withTenant } from "../org/tenant-context.js";
import { schedulerTargets } from "../scheduler/tenant-fanout.js";
import { isSchedulerLeader, startSchedulerLeadership } from "../scheduler/leader.js";
import { sharedRoot } from "../terminal/terminal-sessions.js";
import { effectiveDelegatePolicy, type DelegatePolicy } from "../org/policies/delegate-policy.js";
import { getMemberSecret, memberOwner } from "../org/credentials/member-secret-store.js";
import { getRuntimeConfig } from "../org/store.js";
import { getMember } from "../org/store/members.js";
import { resolveRepoInject } from "../project/project-provision.js";
import { nodeOnline, nodeRpc, nodeSessionGone, schedulableRemotes, onTaskDone } from "./registry.js";
import { getNode, listNodes } from "./store.js";
import { remoteDelegateAllowed } from "./node-access.js";
import {
  queuedTasks, runningTasks, runningCountByNode, markRunning, markFinished, requeue, setNodeLost, getTask,
  matchNode, type DelegateTask, type SchedulableNode,
} from "./task-store.js";
import { spawnTaskSession, checkTask, killTaskSession, sampleResources, detectDocker, detectHarnesses, tailTask, type RunTaskResult, type TailResult } from "./tasks.js";
import { nodeHarnesses } from "./protocol.js";
import { detectAuthFailure, cronJobIdFromMarker } from "./task-failure.js";
import { handleAuthFailure } from "./auth-failure-response.js";
import { reapFailedTaskSessions, decideReap, type FailedTaskRow, type ReapAttempt } from "./failed-session-reaper.js";

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
// 자격 리스 표(#1884) — **하네스별** env 리스. 지금은 claude 셋업토큰뿐이다: codex 등은 실측된 env 리스 수단이 없어
//  워커 로컬 로그인에만 의존한다(= 공유 노드 후보에서 빠진다 — remoteDelegateAllowed 의 hasLease=false 경로, 종전과 같다).
//  표에 더할 땐 env 키가 tasks.ts 의 env 필터(/^[A-Z][A-Z0-9_]{0,63}$/)를 지켜야 세션에 실린다(kind 테스트가 잰다).
export const LEASE_SECRET: Readonly<Record<string, { kind: string; env: string }>> = {
  claude: { kind: "claude_setup_token", env: "CLAUDE_CODE_OAUTH_TOKEN" },
};
export const SECRET_KIND = LEASE_SECRET.claude.kind;

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
let centralHarnesses: string[] | null = null;   // #1884 — 프로세스당 1회(detectHarnesses 는 하네스마다 `--version` 을 띄운다)

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
//  ⚠ 세션 좌표(node_id·session_id·requester)만 쓴다 — 실패 세션 회수기도 같은 함수를 쓰기 위해
//   DelegateTask 전체가 아니라 그 세 칸만 요구한다(회수기는 DB 에서 그 칸만 읽어온다).
type SessionCoords = Pick<DelegateTask, "node_id" | "session_id" | "requester">;
/**
 * 반환값 `gone` = **그 세션이 지금 확실히 없어졌나**(회수기가 '걷었다'고 기록해도 되는가).
 *
 * ⚠ 이 구분이 없으면 회수기가 거짓 성공을 기록한다(#1675 리뷰에서 잡힌 결함): 종전 구현은 오프라인 노드에서
 *  **아무 일도 안 하고 정상 반환**했고, 호출부는 그걸 성공으로 보고 `session_reaped` 를 찍었다. 그러면 그 세션은
 *  다음 조회에서 영구 제외되는데 노드가 돌아오면 멀쩡히 살아 있다 — ① 이 없애려던 바로 그 영구 누수다.
 *
 *  · 중앙(로컬 tmux): kill 이 실패해도 **true**. 로컬에서 실패하는 사유는 사실상 '이미 없음'이고,
 *    그걸 미완으로 두면 존재하지도 않는 세션에 영원히 재시도한다.
 *  · 원격: 노드에 **닿았을 때만** true. 오프라인·RPC 실패는 false → 호출부가 다시 판단한다.
 *
 * ⚠ `why`(실패 사유)를 **버리지 마라**(#2622). 종전엔 `catch { return false; }` 로 노드가 준 원문을 삼키고
 *  호출부가 「노드에 닿지 못함」이라는 합성 문구만 남겼다 — 그래서 이틀치 로그를 다 읽어도 진짜 이유
 *  (403 「본인 세션이 아닙니다」 = 그 세션은 이미 없다)를 알 수 없었다. 진단은 원문에서 나온다.
 */
async function killTaskAnywhere(t: SessionCoords): Promise<{ gone: boolean; reached: boolean; why?: string }> {
  if (!t.session_id) return { gone: true, reached: true };   // 걷을 세션이 애초에 없다 = 완료
  if (t.node_id === CENTRAL_NODE_ID) {
    await killTaskSession(t.session_id).catch(() => { /* 이미 없음 */ });
    return { gone: true, reached: true };
  }
  if (!t.node_id) return { gone: false, reached: false, why: "노드 좌표 없음" };
  if (!nodeOnline(t.node_id)) return { gone: false, reached: false, why: "node-offline" };   // 못 닿았다 — 아직 안 걷혔다
  try {
    await nodeRpc(t.node_id, "kill", { user: { userId: t.requester }, id: t.session_id });
    return { gone: true, reached: true };
  } catch (e) {
    const why = (e as Error)?.message ?? String(e);
    // ⚠ **답이 없는 것과 답이 거절인 것은 다르다**(회수기의 포기 판정이 이 축을 쓴다).
    //  오프라인·타임아웃은 «못 닿았다» — 잠든 노트북·먹통 노드를 포기하면 그 세션은 영구 누수다.
    //  그 외(노드가 준 오류·미지원 op)는 노드가 답을 한 것이고, 스스로 회복될 길이 없으니 끝을 낼 수 있다.
    return { gone: false, reached: why !== "node-offline" && why !== "node-rpc-timeout", why };
  }
}

/**
 * 회수기용 kill 한 번(#2622 ⓐ) — **멱등 회수**.
 *
 * kill 이 실패해도 그것만으로 「아직 살아 있다」가 아니다. 실측된 이 사고의 실제 모양은 정반대였다:
 *  세션이 **이미 없어서** 노드의 소유 확인(assertManage → ownerMeta)이 403 을 냈고, 회수기는 그걸
 *  「닿지 못함」으로 읽어 이틀을 재시도했다. 그래서 실패하면 **그 세션이 없는지 노드에 확답을 구한다.**
 *
 * ⚠ `nodeSessionGone` 은 #835 의 「확답 only」 계약이다 — `true`(없다) · `false`(살아있다) · `null`(판정 불가).
 *  `true` 일 때만 회수 성공으로 접는다. `null` 을 성공으로 접으면 그게 바로 #1675 리뷰의 거짓 성공이다.
 */
async function reapKill(t: FailedTaskRow): Promise<ReapAttempt> {
  const r = await killTaskAnywhere(t);
  // 확답을 구하는 건 **kill 이 실패했을 때뿐**이다 — 성공했으면 RPC 를 한 번 더 쏠 이유가 없다.
  const gone = r.gone || !t.node_id || t.node_id === CENTRAL_NODE_ID || !t.session_id
    ? null
    : await nodeSessionGone(t.node_id, t.session_id).catch(() => null);
  return decideReap(r.gone, gone, r.why, r.reached);
}

// 실패 세션 회수 tick(#1675 ①) — 보존 상한(개수·TTL) 밖의 실패 세션을 걷는다.
//  ⚠ 실패해도 조용히 넘어간다: 회수가 스케줄러 tick 을 깨면 정작 위탁 감시가 멈춘다.
async function reapFailedSessions(): Promise<void> {
  try {
    const p = await effectiveDelegatePolicy(loadDelegatePolicy);
    await reapFailedTaskSessions(
      reapKill,
      { keep: p.keep_failed_sessions, ttlMin: p.failed_session_ttl_min },
    );
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "실패 위탁 세션 회수 tick 오류(비치명)");
  }
}

// 상태 전이만 DB 에 기록한다 — 의뢰 세션 통지는 하지 않는다(§11: 흐름은 CLI 프로세스가 pull/스트림).
async function finish(t: DelegateTask, ok: boolean, exit: number | null, summary?: string, error?: string): Promise<void> {
  liveSeen.delete(t.id);
  // 자격 실패 판정(#1675 ②③) — markFinished **전에** 해서 결과에 함께 남긴다(사후 조회로 원인이 보이게).
  const auth = ok ? null : detectAuthFailure({ error, summary });
  await markFinished(t.id, ok, {
    exit, node: t.node_id, session: t.session_id, task_dir: t.task_dir,
    summary: (summary ?? "").slice(0, 8192),
    ...(auth ? { auth_failure: { label: auth.label, from: auth.from } } : {}),
  }, error ?? null);
  // 성공 = 세션 즉시 정리 · 실패 = 세션 보존(사후 검시 — 웹터미널로 열람)하되 **상한 안에서만**(#1675 ①).
  //  종전엔 실패 세션이 무기한 남았고, 그게 어니스트 2026-08-12 에 2,300개까지 쌓여 박스를 무너뜨렸다.
  if (ok && t.session_id && t.node_id) {
    if (t.node_id === CENTRAL_NODE_ID) await killTaskSession(t.session_id).catch(() => { /* 이미 없음 */ });
    else await nodeRpc(t.node_id, "kill", { user: { userId: t.requester }, id: t.session_id }).catch(() => { /* 노드 이탈 등 */ });
  }
  logger.info({ task: t.id, ok, node: t.node_id, auth: auth?.label ?? null }, "위탁 태스크 종결");

  // 자격 실패 대응 — 크론 정지 + 대기분 취소 + 알림. 실패해도 종결 자체는 이미 끝났다.
  if (auth) {
    const policy = await effectiveDelegatePolicy(loadDelegatePolicy).catch(() => null);
    await handleAuthFailure(
      { taskId: t.id, requester: t.requester, cronJobId: cronJobIdFromMarker(t.requester_session), auth },
      { stopCron: policy?.auth_fail_stop_cron ?? true },
    ).catch((err) => logger.warn({ err, task: t.id }, "자격 실패 대응 오류(비치명)"));
  }
  // 실패 세션이 하나 늘었으니 그 자리에서 상한을 다시 적용한다 — tick 을 기다리면 그 사이 또 쌓인다
  //  (사고 당시 한 주기에 9건이 동시에 죽었다).
  if (!ok) await reapFailedSessions();
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
function capacityReason(t: Pick<DelegateTask, "need_cpu" | "need_ram_mb" | "need_disk_mb" | "needs_docker" | "harness">, nodes: SchedulableNode[]): string {
  if (!nodes.length) return "가용 노드 없음(쓸 수 있는 노드가 없음 — 위탁은 중앙 + 본인이 등록한 노드 + 관리자가 공유 노드로 지정한 노드에만 갑니다. 공유 노드를 쓰려면 내 셋업토큰 등록이 필요합니다)";
  // #1884 — 하네스를 못 띄우는 건 용량 문제가 아니다. 후보 전부가 그 사유면 그렇게 말한다(셋업토큰 안내로 헛다리 짚지 않게).
  if (!nodes.some((n) => n.harnesses.includes(t.harness))) {
    // ⚠ #2128 — "지원하는 노드 없음"이라고 **단정하지 않는다.** 이 목록은 노드가 hello 로 스스로 보고한 것이고,
    //  낡은 인스턴스가 좁은 PATH 로 굳으면 **그 CLI 가 잘 도는 PC 도 없다고 보고한다**(실측 2026-08-26 hammurabi:
    //  claude 세션 8/8 이 정상 실행되는데 검출은 [shell] 하나였다). 그 상태에서 "없다"고 못 박으면 사람은 설치·
    //  셋업토큰을 의심하며 헛다리를 짚는다. 사실(보고된 목록)만 대고, 보고가 틀릴 수 있다는 것과 조치를 함께 말한다.
    return `하네스 ${t.harness} 를 보고한 노드 없음 — ` + nodes.map((n) => `${n.id}: [${n.harnesses.join(",")}]`).join(" · ")
      + `. 이 목록은 각 노드가 스스로 보고한 것입니다 — 그 CLI 가 깔려 있는데도 안 보이면 그 PC 에서`
      + ` \`lively node --daemon\` 을 다시 실행해 주세요(낡은 인스턴스가 좁은 PATH 로 굳으면 못 찾습니다).`
      + ` 정말 없다면 그 CLI 가 깔린 노드를 등록하거나 잡/위탁의 하네스를 바꾸세요.`;
  }
  const bits = nodes.map((n) => {
    if (!n.harnesses.includes(t.harness)) return `${n.id}: 하네스 ${t.harness} 미지원`;
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
//  #1780 v2 §7-1(설계 R2-O8) — **의뢰자가 active 멤버일 때만** 리스한다. 토큰은 verifyDbToken 이 비활성 즉시
//  401 로 막지만, 이 리스는 토큰이 아니라 그 사람의 **벤더 구독 자격**이라 별도 축이다 — 안 보면 퇴사자의
//  setup-token 으로 새 런이 계속 배치된다(앱 무인 실행이 생기면 그 구멍이 곧 앱 통로가 된다). 조회 실패·삭제·
//  비활성 전부 "자격 없음"(undefined) 으로 접는다 — 종전 '시크릿 없음' 과 같은 강등 경로(fail-closed).
//  #1884 — 리스는 **태스크의 하네스**로 찾는다(LEASE_SECRET). 리스 수단이 없는 하네스(codex 등)는 저장소를 보지도 않고
//  undefined — claude 토큰을 codex 워커에 싣는 건 무의미하고, 그걸로 공유 노드가 열리면 안 된다.
export async function leaseEnvFor(
  t: Pick<DelegateTask, "requester" | "harness">,
  lookup: (owner: string, kind: string, scope: string) => Promise<{ secret: string | null } | null> = getMemberSecret,
  stateOf: (memberId: string) => Promise<string | null> = (id) => getMember(id).then((m) => m?.state ?? null),
): Promise<Record<string, string> | undefined> {
  const lease = LEASE_SECRET[t.harness];
  if (!lease) return undefined;
  const state = await stateOf(t.requester).catch(() => null);
  if (state !== "active") return undefined;
  const sec = await lookup(memberOwner(t.requester), lease.kind, "").catch(() => null);
  return sec?.secret ? { [lease.env]: sec.secret } : undefined;
}

// 후보/자격 정책(④ + #1540) — central 은 항상, 원격은 **본인이 등록한 노드 + 관리자가 공유로 지정한 노드**만.
//  판정은 node-access.remoteDelegateAllowed 단일 술어(접근 게이트와 같은 축 + 자격 리스 조건).
//  ⚠ 소유·공유·활성은 **매 tick DB 에서 다시 읽는다**(listNodes 1회). registry 의 conns 에 들린 노드 행은
//   **연결 시점 스냅샷**이라, 관리자가 공유를 끈 뒤에도 그 노드가 재연결하기 전까지 계속 열려 보인다 —
//   정책 변경이 즉시 듣지 않는 건 접근통제에서 결함이다. 쿼리 1회(노드 수는 수십 규모)로 그걸 없앤다.
async function candidatesFor(t: DelegateTask, counts: Map<string, number>, extra: Map<string, number>): Promise<{ nodes: SchedulableNode[]; env?: Record<string, string> }> {
  const env = await leaseEnvFor(t);
  const running = (id: string): number => (counts.get(id) ?? 0) + (extra.get(id) ?? 0);
  const nodes: SchedulableNode[] = [];
  if (CAP_CENTRAL > 0) {
    if (centralDocker === null) centralDocker = await detectDocker();
    // #1884 — 중앙 박스에 실제로 깔린 CLI ∪ 기준선(claude·codex·shell). 기준선을 합치는 이유: 게이트웨이 프로세스의 PATH 는
    //  launchd/systemd 것이라 사람 셸의 ~/.local/bin 이 빠져 `--version` 프로브가 못 찾을 수 있는데(스폰은 로그인 셸을 타서 된다),
    //  그때 중앙이 '아무 하네스도 못 띄움'이 되면 종전엔 돌던 claude 위탁까지 전부 배치 불가가 된다(회귀). 기준선 밖(antigravity·grok)만
    //  프로브 결과를 믿는다 — 종전 동작(중앙은 항상 후보)을 claude·codex 에 대해 그대로 보존한다.
    if (centralHarnesses === null) centralHarnesses = [...new Set([...await detectHarnesses(), ...nodeHarnesses(null)])];
    nodes.push({
      id: CENTRAL_NODE_ID, kind: "central", central: true, hasDocker: centralDocker, harnesses: centralHarnesses,
      res: await sampleResources(sharedRoot().base).catch(() => null), capacity: CAP_CENTRAL, running: running(CENTRAL_NODE_ID),
    });
  }
  const rows = new Map((await listNodes().catch(() => [])).map((n) => [n.id, n]));
  for (const r of schedulableRemotes()) {
    const row = rows.get(r.id);
    if (!row || !row.enabled) continue;                                          // 삭제·비활성(스냅샷은 모를 수 있다)
    if (!remoteDelegateAllowed(row, t.requester, Boolean(env))) continue;         // 남의 비공유 노드 · 자격 없는 공유 노드
    nodes.push({
      id: r.id, kind: row.kind, hasDocker: r.hasDocker, res: r.res, capacity: row.kind === "worker" ? CAP_WORKER : CAP_MEMBER, running: running(r.id),
      harnesses: nodeHarnesses(row.agent_harnesses),   // #1884 — hello 가 보고한 것(DB 미러) · 미보고(구 번들)면 기준선
    });
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

/**
 * 큐 배정. `counts`(노드별 실행 중 수)·`extra`(이번 tick 배정 가산)를 **밖에서 받는다** — 워크스페이스를
 *  순회할 때 이 둘은 **전역**이어야 하기 때문이다(#2418). 테넌트마다 새로 세면 각 워크스페이스가
 *  "노드가 비어 있다"고 판단해 같은 노드에 몰아넣는다.
 */
async function assignQueuedWith(counts: Map<string, number>, extra: Map<string, number>): Promise<void> {
  const queued = await queuedTasks();
  if (!queued.length) return;
  const now = Date.now();
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

/** 단일 테넌트 경로(종전) — 용량 맵을 스스로 만든다. */
async function assignQueued(): Promise<void> {
  await assignQueuedWith(await runningCountByNode(), new Map());
}

// 워크스페이스 순회 (#2418) — org_task 도 테넌트별로 갈리는 표라, 컨텍스트 밖에서 읽으면 primary 것만 보인다.
//  ⚠ 용량(counts)만은 **전 워크스페이스 합**이어야 한다 → 먼저 한 바퀴 돌아 합산하고, 그 맵을 순회 전체가 공유한다.
/** 한 번의 배차 tick — 대상 테넌트를 스스로 열거해 각각을 `withTenant` 로 감싼다.
 *  ⚠ **테넌트 단위로 쪼갤 수 없다**: 노드 용량을 테넌트 가로질러 집계한 뒤 배차하므로,
 *   한 테넌트만 보고 배정하면 남의 부하를 못 봐 노드를 초과 배정한다.
 *  ⓘ 밖으로 연 이유(#2246): 매니지드에서는 `startTaskScheduler` 가 `gate:"scheduler"` 에 막혀 안 돈다.
 *   요청에 얹은 정비가 이 tick 을 **전역 스코프**로 부른다 — 대상 열거는 여기가 하므로 안전하다. */
export async function tickTasksAllTenants(): Promise<void> {
  const targets = await schedulerTargets();
  if (targets === null) {   // 단일 테넌트 배포 — 종전 경로
    await watchRunning(); await assignQueued(); await reapFailedSessions();
    return;
  }
  const counts = new Map<string, number>();
  for (const t of targets) {
    try {
      for (const [node, n] of await withTenant(t, () => runningCountByNode())) {
        counts.set(node, (counts.get(node) ?? 0) + n);
      }
    } catch (err) { logger.warn({ err, workspace: t.slug }, "위탁 용량 집계 실패(그 워크스페이스만 건너뜀)"); }
  }
  const extra = new Map<string, number>();
  for (const t of targets) {
    try {
      await withTenant(t, async () => {
        await watchRunning();
        await assignQueuedWith(counts, extra);
        await reapFailedSessions();
      });
    } catch (err) { logger.warn({ err, workspace: t.slug }, "위탁 스케줄러 tick 오류(워크스페이스)"); }
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
          // 사유는 **그 하네스** 기준으로(#1884) — 리스 시크릿이 있는 하네스만 그 등록을 말한다(codex 잡에 셋업토큰 안내는 헛다리다).
          const lease = LEASE_SECRET[t.harness];
          await finish(t, false, null, undefined,
            `무출력 stall(${Math.round(STALL_MS / 1000)}s) — 워커(${t.harness})가 한 바이트도 내지 않았습니다. `
            + (lease
              ? `의뢰자(${t.requester})의 ${lease.kind} 미등록/만료로 인증이 안 됐을 수 있습니다(격리 박스엔 공유 로그인 폴백이 없습니다). `
              : `의뢰자(${t.requester})가 그 박스(${t.node_id ?? "?"})에서 ${t.harness} 에 로그인돼 있지 않을 수 있습니다(이 하네스는 env 리스가 없어 워커 로컬 로그인에만 의존합니다). `)
            + `레포 준비가 오래 걸리는 박스면 LIVELY_TASK_STALL_MS 를 늘리세요.`);
          logger.warn({ task: t.id, node: t.node_id, requester: t.requester, stallMs: STALL_MS }, "위탁 태스크 무출력 stall — 조기 종결");
          continue;
        }
        liveSeen.set(t.id, t.attempt);
      }
      if (t.node_id === CENTRAL_NODE_ID) {
        // 중앙(내장 노드)은 스케줄러가 직접 감시 — 원격은 에이전트가 taskdone 을 push.
        const out = await checkTask({ taskId: t.id, sessionId: t.session_id ?? "", taskDir: t.task_dir ?? "", harness: t.harness ?? undefined });   // #1710 — 하네스별 결과 스키마
        if (out) await finish(t, out.ok, out.exit, out.summary, out.error);
        continue;
      }
      // 원격 노드 생존 처리(③) — 오프라인이면 grace, 복귀면 감시 재장전.
      const online = t.node_id ? nodeOnline(t.node_id) : false;
      if (!online) {
        if (!t.node_lost_at) { await setNodeLost(t.id, true); logger.info({ task: t.id, node: t.node_id }, "노드 연결 끊김 — 복귀 대기"); continue; }
        if (now - new Date(t.node_lost_at).getTime() > OFFLINE_GRACE_MS) {
          if (t.attempt < t.max_attempts) {
            // ⚠ 여기서 kill 을 시도해도 소용없다 — 이 분기는 `!online` 이라 원격 kill 이 구조적으로 닿지 않는다.
            //  (최초 구현이 그 자리에 kill 을 넣었다가 리뷰에서 no-op 임이 드러났다.)
            //  재큐하면 session_id 가 NULL 이 되어 **그 세션을 다시는 못 찾는다** — 노드가 돌아왔을 때 남아 있으면
            //  영구 고아다. 그래서 좌표를 결과에 남겨 노드 복귀 후 추적할 수 있게 한다(회수는 노드 자체의
            //  부팅 스윕/사람 정리 몫 — 중앙이 닿지 못하는 남의 머신을 장부만으로 지웠다고 할 수는 없다).
            await requeue(t.id, { node: t.node_id, session: t.session_id });
            logger.warn({ task: t.id, node: t.node_id, attempt: t.attempt }, "노드 유실 — 재큐");
          } else {
            await finish(t, false, null, undefined, `node-lost(${t.node_id})`);
          }
        }
        continue;
      }
      if (t.node_lost_at) {
        // 복귀 — 에이전트 재시작으로 감시 목록이 비었을 수 있어 재장전(멱등).
        await nodeRpc(t.node_id!, "watchTask", { taskId: t.id, sessionId: t.session_id, taskDir: t.task_dir, harness: t.harness }).catch(() => { /* 다음 tick */ });
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
  //  ★ 크론 스케줄러와 **같은 리더**를 쓴다 (#2664 3단계). 멱등이라 둘 다 불러도 한 번만 선다.
  startSchedulerLeadership();
  setInterval(() => {
    //  ★ 리더만 배치한다. 무중단 롤은 옛·새 게이트웨이를 수십 초 겹쳐 띄우는데, 그동안 둘이
    //   같은 `org_task` 큐를 보면 **같은 위탁이 두 노드에 배치된다** — 그건 멱등이 아니다.
    if (!isSchedulerLeader()) return;
    if (ticking) return;
    ticking = true;
    void (async () => {
      // 회수는 tick 에도 둔다(#1675 ①) — finish 훅만으로는 **TTL 이 영원히 안 걸린다**: 실패가 멎으면
      //  훅이 안 불리고, 마지막 남은 세션들이 TTL 을 한참 넘겨도 아무도 안 걷는다.
      try { await tickTasksAllTenants(); }
      catch (err) { logger.warn({ err }, "위탁 스케줄러 tick 오류"); }
      finally { ticking = false; }
    })();
  }, TICK_MS).unref();
  logger.info({ capCentral: CAP_CENTRAL, capMember: CAP_MEMBER, capWorker: CAP_WORKER }, "위탁 태스크 스케줄러 시작(P2)");
}
