// 분산 노드 에이전트(#869) — 멤버 PC/워커에서 도는 단일 프로세스. DB·웹 UI 없이 부팅한다.
// 연결은 항상 아웃바운드(노드 → 게이트웨이 WSS /node/ws, Bearer 노드토큰) — 포트를 열지 않는다(F1).
// 역할: 게이트웨이의 타입드 ops(list/create/kill/edit/gone/label — 임의 셸 없음)를 로컬 tmux 에 실행하고,
//  3s 주기로 세션 상태 스냅샷을 push 하며, attach 채널을 로컬 tmux -CC(node-pty)로 브리지한다.
// 실행(설치 스크립트가 데몬으로 등록):
//   LIVELY_GATEWAY_URL=https://gw LIVELY_NODE_TOKEN=lvk_... node dist/node/agent.js
import WebSocket from "ws";
import os from "node:os";
import {
  listSessionsRaw, createSession, killSession, editSession, applyValidatedInvites,
  sessionGone, getSessionLabel, killEmptyTmuxServer, SHARED_ROOT, type CreateInput,
} from "../terminal-sessions.js";
import { attachSession, killAttachedPtys, type AttachSocket } from "../terminal-pty.js";
import type { LivelyUser } from "../context.js";
import {
  NODE_WS_PATH, PROTO_VER, encodeChanFrame, decodeChanFrame, parseMsg,
  type GwToNodeMsg, type NodeToGwMsg, type ReqMsg,
} from "./protocol.js";
// 위탁 태스크(P2) — 러너/리소스 샘플러는 중앙(게이트웨이 내장 노드)과 공유(node/tasks.ts).
import { sampleResources, detectDocker, spawnTaskSession, checkTask, tailTask, type TaskWatch, type RunTaskInput } from "./tasks.js";
import { logger } from "../log.js";

const GW_URL = process.env.LIVELY_GATEWAY_URL || "";
const TOKEN = process.env.LIVELY_NODE_TOKEN || "";
const NODE_ID = process.env.LIVELY_NODE_ID || ""; // 표시용 — 신원은 서버가 토큰으로 특정한다
if (!GW_URL || !TOKEN) {
  console.error("LIVELY_GATEWAY_URL / LIVELY_NODE_TOKEN 이 필요합니다");
  process.exit(2);
}

const STATE_PUSH_MS = 3_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

function wsUrl(base: string): string {
  const u = new URL(base);
  u.protocol = u.protocol === "http:" ? "ws:" : u.protocol === "https:" ? "wss:" : u.protocol;
  u.pathname = NODE_WS_PATH;
  u.search = "";
  return u.toString();
}

// ── attach 채널 어댑터 — 게이트웨이행 단일 WSS 위의 가상 채널을 AttachSocket 으로 위장해
//    terminal-pty.attachSession(tmux -CC · 큐잉 · 정리)을 그대로 재사용한다. ──
class ChanSocket implements AttachSocket {
  private listeners = new Map<string, Array<(...args: any[]) => void>>();
  private closed = false;
  constructor(private readonly ws: WebSocket, private readonly chan: number, private readonly onGone: (chan: number) => void) {}
  send(data: Buffer | string): void {
    if (this.closed) return;
    // attachSession 은 raw Buffer(pty 출력)만 send 한다 — 채널 프레임으로 감싸 무디코드 릴레이.
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    try { this.ws.send(encodeChanFrame(this.chan, buf)); } catch { /* 게이트웨이 끊김 — close 에서 정리 */ }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.send(JSON.stringify({ t: "close", chan: this.chan } satisfies NodeToGwMsg)); } catch { /* noop */ }
    this.emit("close");
    this.onGone(this.chan);
  }
  on(event: string, listener: (...args: any[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(event) ?? []) { try { fn(...args); } catch { /* listener 오류는 채널만 */ } }
  }
  // 게이트웨이발 제어(ctl)/종료(close) 주입.
  feedControl(m: Record<string, unknown>): void { this.emit("message", JSON.stringify(m)); }
  feedClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close"); // attachSession cleanup(term.kill) 경로
    this.onGone(this.chan);
  }
}

// 위탁 태스크 감시 목록(P2) — 상태 push 주기에 exit 파일을 확인해 taskdone 을 보고한다.
//  에이전트 재시작 시 비워지지만, 게이트웨이가 재연결 때 watchTask 로 재장전한다(복구 경로).
const trackedTasks = new Map<number, TaskWatch>();

// ── ops 디스패치 — 게이트웨이가 이미 정책(소유·초대 검증)을 끝냈다는 전제의 기계적 실행. ──
//  user 는 게이트웨이가 넘긴 신원 그대로 tmux 메타(@box_owner)·소유자 확인(assertManage)에 쓰인다.
async function runOp(op: string, args: Record<string, unknown>): Promise<unknown> {
  const user = (args.user ?? {}) as LivelyUser;
  switch (op) {
    case "runTask": {
      const input = args as unknown as RunTaskInput;
      const r = await spawnTaskSession(input);
      trackedTasks.set(input.taskId, { taskId: input.taskId, sessionId: r.sessionId, taskDir: r.taskDir });
      return r;
    }
    case "watchTask": {
      const w = { taskId: Number(args.taskId), sessionId: String(args.sessionId), taskDir: String(args.taskDir) };
      if (w.taskId && w.taskDir) trackedTasks.set(w.taskId, w);
      return { ok: true };
    }
    case "tailTask": return tailTask(String(args.taskDir), Number(args.from) || 0);
    case "list": return listSessionsRaw();
    case "create": {
      const session = await createSession(user, args.input as CreateInput);
      // 초대는 게이트웨이가 구성원 디렉터리로 검증해 넘긴다 — 노드엔 DB 가 없어 createSession 내부 검증이 빈 배열이 됨.
      const invites = Array.isArray(args.invites) ? (args.invites as string[]) : [];
      if (invites.length) { await applyValidatedInvites(user, session.id, invites); session.invites = invites; }
      return session;
    }
    case "kill": await killSession(user, String(args.id)); return { ok: true };
    case "edit": {
      const patch = (args.patch ?? {}) as { label?: string };
      if (patch.label !== undefined) await editSession(user, String(args.id), { label: patch.label });
      if (args.invites !== undefined) await applyValidatedInvites(user, String(args.id), args.invites);
      return { ok: true };
    }
    case "gone": return sessionGone(String(args.id));
    case "label": return getSessionLabel(String(args.id));
    default: throw new Error(`unknown op: ${op}`);
  }
}

let attempt = 0;
function connect(): void {
  const url = wsUrl(GW_URL);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${TOKEN}` }, handshakeTimeout: 10_000 });
  const chans = new Map<number, ChanSocket>();
  let pusher: NodeJS.Timeout | null = null;
  let lastPushed = "";

  const pushState = async (force = false): Promise<void> => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      // 리소스 상시 노출(§10) + 세션 스냅샷. res 는 매 push 변하므로 dedup 은 세션 부분만 본다.
      const [sessions, res] = await Promise.all([listSessionsRaw(), sampleResources(SHARED_ROOT.base)]);
      const sesKey = JSON.stringify(sessions);
      const skip = !force && sesKey === lastPushed && trackedTasks.size === 0;
      lastPushed = sesKey;
      if (!skip) ws.send(JSON.stringify({ t: "state", sessions, res } satisfies NodeToGwMsg));
      // 위탁 태스크 완료 감지(P2) — exit 파일 등장 시 1회 보고 후 감시 해제(세션 정리는 게이트웨이 지시).
      for (const w of [...trackedTasks.values()]) {
        const out = await checkTask(w).catch(() => null);
        if (!out) continue;
        trackedTasks.delete(w.taskId);
        ws.send(JSON.stringify({ t: "taskdone", taskId: out.taskId, ok: out.ok, exit: out.exit, summary: out.summary, error: out.error } satisfies NodeToGwMsg));
      }
    } catch (err) {
      // 다음 주기에 재시도 — 조용히 삼키면 배치 불가 원인을 못 찾는다(e2e 교훈: freemem 과소보고 진단 지연).
      logger.warn({ err: (err as Error)?.message }, "상태 push 실패(비치명)");
    }
  };

  ws.on("open", () => {
    attempt = 0;
    logger.info({ url }, "게이트웨이 연결됨");
    void (async () => {
      const hasDocker = await detectDocker();
      ws.send(JSON.stringify({ t: "hello", ver: PROTO_VER, node: NODE_ID, platform: process.platform, host: os.hostname(), hasDocker } satisfies NodeToGwMsg));
      await pushState(true);
      pusher = setInterval(() => { void pushState(); }, STATE_PUSH_MS);
    })();
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) { decodeChanFrame(raw as Buffer); return; } // 현재 게이트웨이→노드 바이너리는 없음(제어는 ctl)
    const m = parseMsg<GwToNodeMsg>(raw);
    if (!m) return;
    if (m.t === "req") {
      const req = m as ReqMsg;
      void runOp(req.op, req.args ?? {})
        .then((data) => { ws.send(JSON.stringify({ t: "res", id: req.id, ok: true, data } satisfies NodeToGwMsg)); void pushState(true); })
        .catch((e) => { try { ws.send(JSON.stringify({ t: "res", id: req.id, ok: false, error: (e as Error)?.message ?? String(e) } satisfies NodeToGwMsg)); } catch { /* noop */ } });
      return;
    }
    if (m.t === "open") {
      const sock = new ChanSocket(ws, m.chan, (chan) => chans.delete(chan));
      chans.set(m.chan, sock);
      try {
        attachSession(sock, m.session);
        ws.send(JSON.stringify({ t: "opened", chan: m.chan } satisfies NodeToGwMsg));
      } catch (e) {
        chans.delete(m.chan);
        ws.send(JSON.stringify({ t: "openfail", chan: m.chan, code: 4403, reason: (e as Error)?.message ?? "attach-failed" } satisfies NodeToGwMsg));
      }
      return;
    }
    if (m.t === "ctl") { chans.get(m.chan)?.feedControl(m.m); return; }
    if (m.t === "close") { chans.get(m.chan)?.feedClose(); return; }
  });

  const teardown = (): void => {
    if (pusher) { clearInterval(pusher); pusher = null; }
    for (const sock of chans.values()) sock.feedClose(); // attach pty 정리(#687 — 고아 방지)
    chans.clear();
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempt++, 5));
    logger.warn({ delay }, "게이트웨이 연결 끊김 — 재연결 예약");
    setTimeout(connect, delay).unref();
  };
  ws.once("close", teardown);
  ws.once("error", (err) => { logger.warn({ err: (err as Error)?.message }, "노드 WSS 오류"); try { ws.terminate(); } catch { /* noop */ } });
}

// 종료 시 attach pty 일괄 회수(#687 — 게이트웨이와 동일 불변식: 자식이 init 로 재부모화돼 PTY 점유하지 않게).
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => { try { killAttachedPtys(); } catch { /* noop */ } process.exit(0); });
}

logger.info({ gw: GW_URL, node: NODE_ID || "(token-derived)" }, "노드 에이전트 시작");
// 부팅 자가치유(#869) — 과거 최소 PATH 로 뜬 stale tmux 서버가 빈 채 남아 있으면 죽인다(세션 0개일 때만 = 무손실).
//  이래야 첫 new-session 이 이 데몬의 PATH(env 파일에 baked 된 사용자 로그인 PATH)로 새 서버를 띄워 pane 이 claude 등을 찾는다.
await killEmptyTmuxServer();
connect();
