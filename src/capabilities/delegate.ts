// 위탁(delegate) capability(P2 #869) — 세션(하네스)이 무거운 1회성 작업을 컨트롤플레인에 위탁한다.
//  delegate_run: 예상 소모량(need_*)을 함께 신고 → 스케줄러가 노드 상시 리소스와 대조해 배치(§10).
//  결과 회수: delegate_status(요약 + 세션/디렉터리 참조) — 전문은 워크스페이스 .lively-task/<id>/ 에.
//  알림: notify_session(tmux 세션 id, 보통 $TMUX 의 자기 세션)을 주면 시작/종결이 그 세션에 주입된다.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import { createTask, getTask, listTasks, markCanceled, type DelegateStatus } from "../node/task-store.js";
import { getNode } from "../node/store.js";
import { nodeOnline, nodeRpc } from "../node/registry.js";
import { killTaskSession, tailTask, type TailResult } from "../node/tasks.js";
import { CENTRAL_NODE_ID, tryAssignNow } from "../node/task-scheduler.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const DEFAULT_WAIT_SEC = 120; // wait 모드 기본 — 대부분의 위탁이 이 안에 끝난다. 초과분은 백그라운드 계속 + 폴백 안내.

const uid = (user: any): string => String(user?.userId || user?.email || "");
const isAdmin = (user: any): boolean => Array.isArray(user?.scopes) && user.scopes.includes("admin");

const run: Capability = {
  name: "delegate_run",
  title: "작업 위탁 실행",
  description:
    "무거운 1회성 작업(풀빌드·대량 테스트·장기 스크립트 등)을 워커 노드나 중앙에 위탁한다. " +
    "⚠ 위탁은 이 MCP 툴이 아니라 `lively delegate` CLI 를 Bash(run_in_background) 로 실행하라(이 툴은 기본 비활성). " +
    "MCP 동기 호출은 하네스에서 인라인 블로킹이라, 긴 wait 는 게이트웨이 long-poll 이 transport keepalive 를 넘겨 응답을 잃는다 — 서버측 작업은 완주하지만 결과를 받아오지 못한다. " +
    "CLI 는 wait=false 로 접수 후 진행을 미러링해 그 함정이 없다(런북 delegate-background-cli-not-mcp-wait). " +
    "가용 노드 없으면 {no_capacity:true, reason} 즉시 반환(무한 대기 안 함), queue:true=적합 노드 날 때까지 대기 등록(장기 잡). " +
    "repo=대상 레포명(주면 게이트웨이가 공유 base clone→worktree 자동 준비해 워커 cwd 로 — 프롬프트 클론 지시 불필요), ref=기준 브랜치(예 main), " +
    "prompt=작업 지시(전문), need_ram_mb/need_disk_mb/need_cpu=예상 소모량(노드 리소스 대조), needs_docker·node(지정)·subpath, wait_sec=완료 대기 상한(기본 120s).",
  scope: "context",
  input: {
    prompt: z.string().min(1).max(20000),
    subpath: z.string().max(300).optional(),
    repo: z.string().max(100).optional(),   // 지정 시 게이트웨이가 공유 base clone→worktree 자동 준비, 워커 cwd=worktree
    ref: z.string().max(100).optional(),    // worktree 분기 기준 브랜치(origin/<ref>, 예 main) — 없으면 base HEAD
    node: z.string().max(64).optional(),
    need_cpu: z.number().min(0).max(64).optional(),
    need_ram_mb: z.number().int().min(0).max(512000).optional(),
    need_disk_mb: z.number().int().min(0).max(1024000).optional(),
    needs_docker: z.boolean().optional(),
    flags: z.record(z.string()).optional(),
    timeout_sec: z.number().int().min(60).max(21600).optional(),
    max_attempts: z.number().int().min(1).max(5).optional(),
    wait: z.boolean().optional(),       // 기본 true — 완료까지 대기 후 결과 반환(서브에이전트 동형). false=즉시 task 반환.
    wait_sec: z.number().int().min(5).max(1800).optional(), // wait 상한(기본 120s)
    queue: z.boolean().optional(),      // 배치 불가 시 즉시 no_capacity(기본) 대신 대기 등록(장기 잡)
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/delegate"], parse: (req) => (req.body ?? {}) }],
  },
  handler: async (input: any, user: any) => {
    const requester = uid(user);
    if (!requester) throw new HttpError(403, "사용자 신원이 없습니다");
    if (input.node && input.node !== CENTRAL_NODE_ID) {
      const n = await getNode(String(input.node));
      if (!n || !n.enabled) throw new HttpError(404, `노드 없음: ${input.node}`);
    }
    const task = await createTask({
      requester, requesterSession: null, prompt: String(input.prompt),
      subpath: input.subpath, repo: input.repo ?? null, gitRef: input.ref ?? null, flags: input.flags,
      needCpu: input.need_cpu ?? null, needRamMb: input.need_ram_mb ?? null, needDiskMb: input.need_disk_mb ?? null,
      needsDocker: !!input.needs_docker, nodePref: input.node ?? null,
      timeoutSec: input.timeout_sec, maxAttempts: input.max_attempts,
    });
    // 요청→즉답 계약: 지금 배치 가능한지 그 자리에서 판정한다(스케줄러 tick 안 기다림).
    const r = await tryAssignNow(task);
    if (!r.assigned) {
      if (!input.queue) {
        // 큐잉 안 함(기본) — 가용 노드 없음을 즉시 알린다. 하네스는 로컬에서 직접 실행하면 된다.
        await markCanceled(task.id);
        return { no_capacity: true, reason: r.reason, hint: "지금 위탁 가능한 노드가 없습니다 — 로컬에서 직접 실행하거나, queue:true 로 대기 등록하세요." };
      }
      return { task: await getTask(task.id), queued: true, reason: r.reason, hint: `대기 등록됨 — 적합 노드가 나면 자동 시작(상한 초과 시 no_capacity 실패). delegate_status ${task.id}` };
    }
    // 배치됨. wait=false 면 즉시 반환, 기본은 완료까지 대기(상한 내).
    if (input.wait === false) return { task: await getTask(task.id), hint: `실행 시작(node=${r.nodeId}). 진행: delegate_status ${task.id}` };
    const deadline = Date.now() + (input.wait_sec ?? DEFAULT_WAIT_SEC) * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const cur = await getTask(task.id);
      if (cur && ["done", "failed", "canceled"].includes(cur.status)) return { task: cur, done: true };
    }
    return { task: await getTask(task.id), still_running: true, hint: `아직 실행 중 — 백그라운드로 계속됩니다. delegate_status ${task.id} 로 확인하세요(또는 wait_sec 를 늘리세요).` };
  },
};

const status: Capability = {
  name: "delegate_status",
  title: "위탁 작업 상태/결과",
  description: "위탁 작업 1건의 상태·배치 노드·세션·결과 요약. 결과 전문은 task_dir(.lively-task/<id>/result.json)에 있다.",
  scope: "context",
  input: { id: z.number().int().positive() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/delegate/:id"], parse: (req) => ({ id: Number(req.params?.id) }) }],
  },
  handler: async (input: any, user: any) => {
    const t = await getTask(Number(input.id));
    if (!t) throw new HttpError(404, "위탁 작업 없음");
    if (t.requester !== uid(user) && !isAdmin(user)) throw new HttpError(403, "본인 위탁만 조회할 수 있습니다");
    return { task: t };
  },
};

const list: Capability = {
  name: "delegate_list",
  title: "위탁 작업 목록",
  description: "내 위탁 작업 목록(최신순, admin 은 all=true 로 전체). status 필터(queued|running|done|failed|canceled) 선택.",
  scope: "context",
  input: {
    status: z.enum(["queued", "running", "done", "failed", "canceled"]).optional(),
    all: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/delegate"], parse: (req) => ({
      status: req.query?.status || undefined, all: req.query?.all === "1", limit: req.query?.limit ? Number(req.query.limit) : undefined,
    }) }],
  },
  handler: async (input: any, user: any) => {
    const mineOnly = !(input.all && isAdmin(user));
    return { tasks: await listTasks({ requester: mineOnly ? uid(user) : undefined, status: input.status as DelegateStatus | undefined, limit: input.limit }) };
  },
};

// 진행 로그 tail(§11) — CLI(lively delegate)가 from 오프셋으로 폴링해 워커 진행을 stdout 미러.
//  아직 배정 전이면 대기 신호(pending), 종결이면 done+exit. 결과 전문은 delegate_status.
const logs: Capability = {
  name: "delegate_logs",
  title: "위탁 진행 로그(tail)",
  description: "위탁 작업의 진행 로그(claude stream-json)를 from 바이트 오프셋부터 tail 한다. 반환 {chunk,next,done,exit,pending}. CLI 미러링·자동화용.",
  scope: "context",
  input: { id: z.number().int().positive(), from: z.number().int().min(0).optional() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/delegate/:id/logs"], parse: (req) => ({ id: Number(req.params?.id), from: req.query?.from ? Number(req.query.from) : 0 }) }],
  },
  handler: async (input: any, user: any) => {
    const t = await getTask(Number(input.id));
    if (!t) throw new HttpError(404, "위탁 작업 없음");
    if (t.requester !== uid(user) && !isAdmin(user)) throw new HttpError(403, "본인 위탁만 조회할 수 있습니다");
    const from = Number(input.from) || 0;
    // 아직 배정 전(queued) — 로그 파일이 없다. CLI 가 '대기 중'을 알 수 있게 상태를 실어 준다.
    if (t.status === "queued" || !t.task_dir || !t.node_id) {
      return { status: t.status, pending: t.status === "queued", chunk: "", next: from, done: false, exit: null };
    }
    let tail: TailResult;
    if (t.node_id === CENTRAL_NODE_ID) tail = await tailTask(t.task_dir, from);
    else if (nodeOnline(t.node_id)) tail = await nodeRpc<TailResult>(t.node_id, "tailTask", { taskDir: t.task_dir, from });
    else tail = { chunk: "", next: from, done: false, exit: null }; // 노드 오프라인 — 스케줄러 grace 가 처리, CLI 는 계속 폴링
    // DB 상 종결(스케줄러가 이미 수집)이면 tail 이 놓쳐도 done 을 확정한다(경합 방지).
    const doneByDb = t.status === "done" || t.status === "failed" || t.status === "canceled";
    return { status: t.status, pending: false, ...tail, done: tail.done || doneByDb };
  },
};

const cancel: Capability = {
  name: "delegate_cancel",
  title: "위탁 작업 취소",
  description: "대기/실행 중 위탁을 취소한다(실행 중이면 워커 세션 종료 시도). 종결된 작업은 취소 불가.",
  scope: "context",
  input: { id: z.number().int().positive() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/delegate/:id/cancel"], parse: (req) => ({ id: Number(req.params?.id) }) }],
  },
  handler: async (input: any, user: any) => {
    const t = await getTask(Number(input.id));
    if (!t) throw new HttpError(404, "위탁 작업 없음");
    if (t.requester !== uid(user) && !isAdmin(user)) throw new HttpError(403, "본인 위탁만 취소할 수 있습니다");
    if (t.status === "done" || t.status === "failed" || t.status === "canceled") throw new HttpError(409, `이미 종결됨(${t.status})`);
    if (t.status === "running" && t.session_id && t.node_id) {
      if (t.node_id === CENTRAL_NODE_ID) await killTaskSession(t.session_id).catch(() => { /* noop */ });
      else if (nodeOnline(t.node_id)) await nodeRpc(t.node_id, "kill", { user: { userId: t.requester }, id: t.session_id }).catch(() => { /* noop */ });
    }
    await markCanceled(t.id);
    return { ok: true, id: t.id };
  },
};

export const delegateCapabilities: Capability[] = [run, status, list, logs, cancel];
