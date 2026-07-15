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
import { CENTRAL_NODE_ID } from "../node/task-scheduler.js";

const uid = (user: any): string => String(user?.userId || user?.email || "");
const isAdmin = (user: any): boolean => Array.isArray(user?.scopes) && user.scopes.includes("admin");

const run: Capability = {
  name: "delegate_run",
  title: "작업 위탁 실행",
  description:
    "무거운 1회성 작업을 워커 노드(또는 중앙)에 위탁한다. prompt=작업 지시(전문), need_ram_mb/need_disk_mb/need_cpu=예상 소모량(스케줄러가 노드 리소스와 대조), " +
    "needs_docker=도커 필요 여부, node=특정 노드 지정(선택), subpath=공유 워크스페이스 하위 작업 폴더(비우면 delegated/task-<id>). " +
    "반환 {task} — 진행은 delegate_logs(tail)·delegate_status 로. 셸에선 `lively delegate` CLI 가 진행 미러+결과 회수+exit 을 한 번에 한다(권장).",
  scope: "context",
  input: {
    prompt: z.string().min(1).max(20000),
    subpath: z.string().max(300).optional(),
    node: z.string().max(64).optional(),
    need_cpu: z.number().min(0).max(64).optional(),
    need_ram_mb: z.number().int().min(0).max(512000).optional(),
    need_disk_mb: z.number().int().min(0).max(1024000).optional(),
    needs_docker: z.boolean().optional(),
    flags: z.record(z.string()).optional(),
    timeout_sec: z.number().int().min(60).max(21600).optional(),
    max_attempts: z.number().int().min(1).max(5).optional(),
    notify_session: z.string().max(120).optional(), // deprecated(§11) — 무시됨. 통지는 CLI/delegate_logs pull 로.
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/delegate"], parse: (req) => (req.body ?? {}) }],
  },
  handler: async (input: any, user: any) => {
    const requester = uid(user);
    if (!requester) throw new HttpError(403, "사용자 신원이 없습니다");
    if (input.node) {
      if (input.node !== CENTRAL_NODE_ID) {
        const n = await getNode(String(input.node));
        if (!n || !n.enabled) throw new HttpError(404, `노드 없음: ${input.node}`);
      }
    }
    const task = await createTask({
      requester, requesterSession: null, prompt: String(input.prompt), // notify_session deprecated(§11) — 저장 안 함

      subpath: input.subpath, flags: input.flags,
      needCpu: input.need_cpu ?? null, needRamMb: input.need_ram_mb ?? null, needDiskMb: input.need_disk_mb ?? null,
      needsDocker: !!input.needs_docker, nodePref: input.node ?? null,
      timeoutSec: input.timeout_sec, maxAttempts: input.max_attempts,
    });
    return { task, hint: "진행 확인: delegate_status { id: " + task.id + " }" };
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
