// codex 세션의 **대화 런타임** (#2055 P2) — 세션 하나당 app-server 하나를 쥐고 산다.
//
//  ── 무엇을 대체하나 ──
//  종전 쓰기 축은 tmux send-keys(아웃박스 경유)였다. 그 경로는 세션이 로그인 화면·대화상자에 걸려 있으면
//  **글자가 조용히 사라진다**(화면에 안 들어가고 에러도 없다). 여기서는 `turn/start` 로 보내고 **실패가 값으로** 온다.
//  읽기 축은 당장 안 바꾼다 — app-server 가 턴을 돌려도 codex 는 **여전히 rollout 파일에 쓴다**(실측: 15→26줄).
//  그래서 화면의 기존 읽기 경로가 그대로 살아 있고, 이벤트 스트림(onLine)은 '지금 쓰는 중' 표시 같은 고도화에 쓴다.
//
//  ── 경계 ──
//  · 프로세스는 **그 세션의 실행 경계 안에서** 뜬다 — 매니지드면 memberSpawnArgv 로 감싸 그 멤버의 컨테이너에서 돈다.
//    게이트웨이에서 그냥 띄우면 남의 테넌트와 같은 컨테이너에서 에이전트가 명령을 실행하게 된다(격리 붕괴).
//  · ★ 스레드당 writer 는 하나다 — 우리가 쥐면 그 세션의 TUI 는 그 스레드를 못 연다. 그래서 codex 세션의
//    터미널 탭은 셸이고, 사람이 TUI 로 이어가고 싶으면 release() 로 **프로세스를 내려** 넘긴다
//    (unsubscribe 로는 안 풀린다 — 실측).
//  · 무엇이든 잘못되면 **CodexChatUnavailable 을 던진다** — 호출자가 그걸 보고 종전 경로로 폴백한다.
//    app-server 는 실험적이라(공식 문서) 폴백이 없으면 그 자체가 장애가 된다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAppServer, type AppServerTransport, type ApprovalDecision, type ApprovalRequest } from "./codex-app-server.js";
import { detachedStartSh, portAlive, sessionPort, spawnDetachedLocal, waitPort, wsTransport } from "./codex-app-server-daemon.js";
import { spawn } from "node:child_process";
import { memberSh, memberSpawnArgv } from "../terminal-member-fs.js";
import type { ChatLine } from "./chat-line.js";

/** 이 세션에서는 app-server 경로를 못 쓴다 — 호출자는 종전(send-keys) 경로로 폴백한다. */
export class CodexChatUnavailable extends Error {
  constructor(message: string, readonly cause?: unknown) { super(message); this.name = "CodexChatUnavailable"; }
}

export interface CodexChatOpts {
  sessionId: string;
  /** 턴이 도는 작업 폴더(세션의 cwd). */
  cwd: string;
  /** 격리 멤버 OS 계정. null 이면 이 배포는 비격리 — 게이트웨이 uid 로 그냥 띄운다. */
  osUser: string | null;
  /** 이어 열 스레드(있으면 resume, 없으면 새로 시작). */
  threadId?: string | null;
  approvalPolicy?: string;
  sandbox?: string;
  onLine?: (line: ChatLine) => void;
  onDelta?: (delta: string) => void;
  /** 승인 정책 — 주지 않으면 클라이언트 기본값(전부 decline)이 적용된다. */
  onApproval?: (req: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>;
  /** 테스트 seam — 전송을 갈아 끼운다(기본: 멤버 경계 stdio). */
  transportFactory?: (argv: string[], cwd: string) => AppServerTransport;
}

interface Entry {
  server: CodexAppServer;
  threadId: string;
  cwd: string;
  osUser: string | null;
  startedAt: number;
  /** 지금 턴이 도는 중인가 — 도는 중에 온 말은 새 턴이 아니라 **얹는다**(turn/steer). */
  running: boolean;
}

/**
 * 세션별 **실시간 통로** (#2055) — 화면이 SSE 로 구독한다.
 *  왜 필요한가: rollout 파일은 턴이 **끝나야** 답을 담는다. 그래서 파일만 보면 화면은 몇 초~몇 분을 빈 채로 기다리고,
 *  더 나쁜 건 **승인 요청**이다 — 서버가 우리에게 물어보는데 사람에게 전할 길이 없으면 전부 거부되고(fail-closed 기본)
 *  codex 는 아무 명령도 못 돌린다. 이 버스가 그 두 가지(글자 조각·승인)를 화면까지 나른다.
 */
export type ChatEvent =
  | { kind: "delta"; text: string }
  | { kind: "line"; line: ChatLine }
  | { kind: "status"; running: boolean }
  | { kind: "approval"; id: string; title: string; detail: string; kindHint: string }
  | { kind: "approval-done"; id: string; decision: string }
  | { kind: "usage"; totalTokens?: number; usedPercent?: number };

type Listener = (e: ChatEvent) => void;
const listeners = new Map<string, Set<Listener>>();

/** 대기 중 승인 — 화면이 답할 때까지 서버 턴이 그 자리에 서 있다. */
interface Pending { id: string; title: string; detail: string; kindHint: string; settle: (d: ApprovalDecision) => void; at: number }
const pendings = new Map<string, Map<string, Pending>>();

/** 승인을 사람이 안 보는 채로 영원히 세워 두지 않는다 — 이 시간이 지나면 거부로 닫는다(fail-closed). */
const APPROVAL_TTL_MS = 10 * 60_000;

export function onChatEvent(sessionId: string, fn: Listener): () => void {
  const set = listeners.get(sessionId) ?? new Set<Listener>();
  set.add(fn); listeners.set(sessionId, set);
  return () => { set.delete(fn); if (!set.size) listeners.delete(sessionId); };
}

function emit(sessionId: string, e: ChatEvent): void {
  for (const fn of listeners.get(sessionId) ?? []) { try { fn(e); } catch { /* 한 구독자의 실패가 나머지를 막지 않는다 */ } }
}

/** 아직 답을 기다리는 승인들(화면이 새로 붙었을 때 되살린다 — 새로고침에 승인이 사라지면 턴이 영영 선다). */
export function pendingApprovals(sessionId: string): Array<{ id: string; title: string; detail: string; kindHint: string }> {
  return [...(pendings.get(sessionId)?.values() ?? [])].map((p) => ({ id: p.id, title: p.title, detail: p.detail, kindHint: p.kindHint }));
}

/**
 * (테스트 seam) 서버가 올린 승인 요청을 그대로 태워 본다 — 문구 계약을 하네스 없이 잡기 위해서다.
 *  제품 경로는 CodexAppServer 의 onApproval 이 부르고, 그 인자가 바로 이 모양이다.
 */
export function askApproval(sessionId: string, method: string, params: Record<string, unknown>): Promise<ApprovalDecision> {
  return askHuman(sessionId, { method, params });
}

/** 화면이 고른 결정을 그 승인에 전달한다. 없는 id 면 false(이미 처리됐거나 만료). */
export function answerApproval(sessionId: string, id: string, decision: ApprovalDecision): boolean {
  const p = pendings.get(sessionId)?.get(id);
  if (!p) return false;
  pendings.get(sessionId)?.delete(id);
  p.settle(decision);
  emit(sessionId, { kind: "approval-done", id, decision });
  return true;
}

/**
 * 서버가 올린 승인 요청 → 사람에게 물어본다. 답이 올 때까지 기다리고, 안 오면 거부로 닫는다.
 *
 *  ★ 제목은 **codex 가 쓴 말(reason)을 그대로** 쓴다 — 실측(2026-08-26, dev 실서버):
 *    `item/commandExecution/requestApproval` 은 `reason` 에 이미 사람에게 물을 문장을 담아 온다
 *    ("요청하신 /tmp/x.txt 파일을 생성하도록 허용하시겠습니까?"). 그걸 버리고 우리 문구("명령을
 *    실행할까요?")로 덮으면, **왜 지금 묻는지**라는 유일한 단서를 잃는다(명령줄만으로는 그게 왜
 *    에스컬레이션인지 안 보인다 — 같은 echo 라도 쓰는 자리에 따라 갈린다). reason 이 없을 때만 우리 문구.
 *  본문은 실행하려는 것 **원문 그대로**다 — 요약된 명령을 허용하는 것은 허용이 아니다.
 */
function askHuman(sessionId: string, req: ApprovalRequest): Promise<ApprovalDecision> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const p = req.params as Record<string, any>;
  const command = String(p?.command ?? "");
  const reason = String(p?.reason ?? "").trim();
  const kindHint = /commandExecution|execCommand/i.test(req.method) ? "command"
    : /applyPatch|fileChange/i.test(req.method) ? "patch"
    : /permission/i.test(req.method) ? "permission" : "other";
  const title = reason || (kindHint === "command" ? "명령을 실행할까요?"
    : kindHint === "patch" ? "파일을 고칠까요?"
    : kindHint === "permission" ? "권한을 허용할까요?" : "이 작업을 허용할까요?");
  // 본문 — 명령이 있으면 명령(+ 어느 폴더에서 도는지), 없으면 그 요청이 가진 것으로.
  const cwd = String(p?.cwd ?? "").trim();
  const detail = command ? (cwd ? `${command}\n\n(작업 폴더: ${cwd})` : command)
    : (reason && reason !== title ? reason : "") || pretty(p?.changes ?? p?.fileChange ?? "") || req.method;
  return new Promise<ApprovalDecision>((resolve) => {
    const map = pendings.get(sessionId) ?? new Map<string, Pending>();
    let done = false;
    const settle = (d: ApprovalDecision): void => { if (done) return; done = true; clearTimeout(timer); resolve(d); };
    const timer = setTimeout(() => {
      map.delete(id);
      emit(sessionId, { kind: "approval-done", id, decision: "decline" });
      settle("decline");                                  // 아무도 안 봤다 = 허용하지 않는다
    }, APPROVAL_TTL_MS);
    map.set(id, { id, title, detail, kindHint, settle, at: Date.now() });
    pendings.set(sessionId, map);
    emit(sessionId, { kind: "approval", id, title, detail, kindHint });
  });
}

/** 값 하나를 사람이 읽을 글로 — 승인 본문에 명령이 없을 때(파일 변경 등) 쓴다. */
function pretty(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

const sessions = new Map<string, Entry>();
/** 같은 세션에 대한 ensure 가 겹쳐도 서버를 두 개 띄우지 않는다(둘째가 첫째의 writer 락에 걸린다). */
const starting = new Map<string, Promise<Entry>>();

/** 세션의 app-server 를 준비한다(이미 있으면 그대로 쓴다). 실패는 CodexChatUnavailable. */
export async function ensureCodexChat(o: CodexChatOpts): Promise<{ threadId: string; reused: boolean }> {
  const live = sessions.get(o.sessionId);
  if (live && !live.server.isClosed) return { threadId: live.threadId, reused: true };
  if (live) sessions.delete(o.sessionId);                     // 죽은 것은 지우고 새로 띄운다

  const inflight = starting.get(o.sessionId);
  if (inflight) return { threadId: (await inflight).threadId, reused: true };

  const p = start(o);
  starting.set(o.sessionId, p);
  try {
    const e = await p;
    return { threadId: e.threadId, reused: false };
  } finally {
    starting.delete(o.sessionId);
  }
}

/**
 * 그 세션의 app-server 를 **띄워 두고**(이미 있으면 그대로) 붙을 수 있는 전송을 돌려준다.
 *  ★ 프로세스는 게이트웨이의 자식이 아니다 — 게이트웨이가 재기동돼도 살아서 턴을 마치고 rollout 에 답을 쓴다.
 *   1차 구현(stdio 자식)은 재기동 때마다 돌던 턴이 통째로 유실됐다(실측 2026-08-26 dev).
 */
async function connect(o: CodexChatOpts): Promise<AppServerTransport> {
  const port = sessionPort(o.sessionId);
  if (o.osUser) {
    // ── 격리·매니지드: 서버는 **그 멤버의 실행 환경(세션 컨테이너)** 안에서 detached 로 돈다. ──
    //  게이트웨이는 그 컨테이너의 loopback 에 직접 못 닿으므로, 중계로 stdio 다리를 하나 놓아 붙는다.
    //  다리는 게이트웨이가 죽으면 같이 죽지만 **서버는 남는다** — 그게 이 구조의 요점이다.
    const log = `$HOME/.codex/lively-app-server-${o.sessionId}.log`;
    const out = await memberSh(o.osUser, detachedStartSh(port, log, sessionEnv(o.sessionId))).catch((e: unknown) => {
      throw new CodexChatUnavailable(`세션 컨테이너에서 codex app-server 를 띄우지 못했습니다 — ${msg(e)}`, e);
    });
    if (!/started|already/.test(String(out ?? ""))) throw new CodexChatUnavailable(`codex app-server 기동 신호가 없습니다 — ${String(out ?? "").slice(0, 120)}`);
    return bridgeTransport(o.osUser, port);
  }
  // ── 로컬(비격리·dev): detached + 로그파일. 이미 그 포트에 살아 있으면 그대로 붙는다. ──
  if (!(await portAlive(port))) {
    const logPath = path.join(os.tmpdir(), `lively-codex-as-${o.sessionId}.log`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(logPath, "a");
      spawnDetachedLocal({ port, cwd: o.cwd, logFd: fd, env: { ...process.env, ...sessionEnv(o.sessionId) } });
    } catch (e) {
      throw new CodexChatUnavailable(`codex app-server 를 띄우지 못했습니다 — ${msg(e)}`, e);
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* */ } }
    }
    if (!(await waitPort(port))) throw new CodexChatUnavailable("codex app-server 가 포트를 열지 않았습니다(기동 실패)");
  }
  return wsTransport(`ws://127.0.0.1:${port}`);
}

/** 컨테이너 안 ws 포트에 붙는 stdio 다리 — 중계(docker exec) 한 겹 위에 줄 단위 전송을 얹는다. */
function bridgeTransport(osUser: string, port: number): AppServerTransport {
  const BRIDGE = `const n=require("net");const s=n.connect(${port},"127.0.0.1");` +
    `s.on("error",e=>{process.stderr.write(String(e.message));process.exit(1)});` +
    `process.stdin.pipe(s);s.pipe(process.stdout);s.on("close",()=>process.exit(0));`;
  const argv = memberSpawnArgv(osUser, ["node", "-e", BRIDGE]);
  const p = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let onLineCb: ((l: string) => void) | null = null;
  let onCloseCb: ((r: string) => void) | null = null;
  let errTail = "";
  p.stdout?.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) onLineCb?.(line); }
  });
  p.stderr?.on("data", (c: Buffer) => { errTail = (errTail + c.toString("utf8")).slice(-500); });
  p.on("exit", (code) => onCloseCb?.(`app-server 다리 종료(code=${code ?? "-"})${errTail ? ` — ${errTail.trim().slice(-200)}` : ""}`));
  p.on("error", (e) => onCloseCb?.(`app-server 다리 실행 실패 — ${e.message}`));
  return {
    send: (line) => { if (!p.killed) p.stdin?.write(line + "\n"); },
    onLine: (cb) => { onLineCb = cb; },
    onClose: (cb) => { onCloseCb = cb; },
    close: () => { try { p.kill(); } catch { /* */ } },   // 다리만 끊는다 — 서버는 남는다
  };
}

async function start(o: CodexChatOpts): Promise<Entry> {
  let server: CodexAppServer;
  try {
    const transport = o.transportFactory ? o.transportFactory([], o.cwd) : await connect(o);
    server = new CodexAppServer({
      transport,
      onLine: (l) => { o.onLine?.(l); emit(o.sessionId, { kind: "line", line: l }); },
      onDelta: (d) => { o.onDelta?.(d); emit(o.sessionId, { kind: "delta", text: d }); },
      // 승인은 **사람에게 물어본다**. 정책을 명시로 준 호출자(리브 같은 자동 경로)는 그쪽이 이긴다.
      onApproval: o.onApproval ?? ((req) => askHuman(o.sessionId, req)),
      onNotify: (method, params) => {
        if (method === "turn/started") { mark(o.sessionId, true); emit(o.sessionId, { kind: "status", running: true }); }
        else if (method === "turn/completed") { mark(o.sessionId, false); emit(o.sessionId, { kind: "status", running: false }); }
        else if (method === "thread/tokenUsage/updated") {
          const t = (params as any)?.tokenUsage?.total?.totalTokens;
          if (Number.isFinite(t)) emit(o.sessionId, { kind: "usage", totalTokens: Number(t) });
        } else if (method === "account/rateLimits/updated") {
          const u = (params as any)?.rateLimits?.primary?.usedPercent;
          if (Number.isFinite(u)) emit(o.sessionId, { kind: "usage", usedPercent: Number(u) });
        }
      },
    });
    await server.initialize();
  } catch (e) {
    throw new CodexChatUnavailable(`codex app-server 를 열지 못했습니다 — ${msg(e)}`, e);
  }

  let threadId = "";
  try {
    // 이어 열기를 먼저 시도한다. 실패해도 **새 스레드로 폴백하지 않는다** — 그 실패의 대부분은
    //  'TUI 가 그 스레드를 쥐고 있다'이고, 그때 새 스레드를 파면 사람이 보던 대화와 다른 대화가 열린다.
    threadId = o.threadId
      ? (await server.resumeThread(o.threadId)).threadId
      : (await server.startThread({ cwd: o.cwd, approvalPolicy: o.approvalPolicy, sandbox: o.sandbox })).threadId;
    if (!threadId) throw new Error("thread id 를 받지 못했습니다");
  } catch (e) {
    server.close();
    throw new CodexChatUnavailable(`codex 대화를 열지 못했습니다 — ${msg(e)}`, e);
  }

  const entry: Entry = { server, threadId, cwd: o.cwd, osUser: o.osUser, startedAt: Date.now(), running: false };
  sessions.set(o.sessionId, entry);
  return entry;
}

/** 턴 상태를 적어 둔다 — 다음 말을 새 턴으로 열지, 도는 턴에 얹을지의 근거다. */
function mark(sessionId: string, running: boolean): void {
  const e = sessions.get(sessionId);
  if (e) e.running = running;
}

/**
 * 한 턴 보낸다. 준비가 안 됐으면 준비하고 보낸다(호출자는 ensure 를 따로 부를 필요가 없다).
 *
 *  ★ **도는 중에 온 말은 새 턴이 아니라 얹는다**(turn/steer). 대화창은 도는 동안에도 보낼 수 있는데
 *   (claude 세션이 큐로 받아 주므로 그렇게 만들었다), codex 에 그걸 turn/start 로 보내면 그 턴이 이미
 *   있다며 거부되거나 두 턴이 겹친다. steer 는 끊지 않고 방향만 바꾼다 — 사람이 기대하는 것이 그쪽이다
 *   ("아, 그거 말고 이거요"). steer 가 안 되는 판이면 그 실패를 삼키지 않고 새 턴으로 한 번 더 시도한다.
 */
export async function sendCodexChat(o: CodexChatOpts & { text: string }): Promise<{ threadId: string; steered?: boolean }> {
  const text = String(o.text ?? "");
  if (!text.trim()) throw new CodexChatUnavailable("빈 메시지는 보내지 않습니다");
  await ensureCodexChat(o);
  const e = sessions.get(o.sessionId);
  if (!e) throw new CodexChatUnavailable("codex 대화 런타임이 사라졌습니다");
  if (e.running) {
    try {
      await e.server.steer(e.threadId, text);
      return { threadId: e.threadId, steered: true };
    } catch { /* 이 판에서는 steer 를 못 쓴다 — 아래 새 턴으로 간다(그 실패는 값으로 온다) */ }
  }
  try {
    await e.server.startTurn(e.threadId, text);
    return { threadId: e.threadId };
  } catch (err) {
    // 보내기가 실패하면 그 서버는 못 믿는다 — 지우고 폴백시킨다(다음 호출이 새로 띄운다).
    dropSession(o.sessionId);
    throw new CodexChatUnavailable(`codex 에 말을 전하지 못했습니다 — ${msg(err)}`, err);
  }
}

/** 돌고 있는 턴을 끊는다. 런타임이 없으면 조용히 false(호출자가 종전 경로로 Esc 를 보낸다). */
export async function interruptCodexChat(sessionId: string): Promise<boolean> {
  const e = sessions.get(sessionId);
  if (!e || e.server.isClosed) return false;
  try { await e.server.interrupt(e.threadId); return true; } catch { return false; }
}

/**
 * 스레드를 **놓아 준다** — 사람이 터미널에서 TUI 로 이어가고 싶을 때.
 *  프로세스를 내리는 것이 유일한 반납 수단이다(thread/unsubscribe 로는 writer 락이 안 풀린다 — 실측).
 *  돌려주는 threadId 로 `codex resume <id>` 를 안내하면 대화가 안 끊긴다.
 */
export function releaseCodexChat(sessionId: string): { threadId: string } | null {
  closePendings(sessionId);           // 터미널로 넘기는 마당에 대화창에 승인이 서 있으면 안 된다
  const e = sessions.get(sessionId);
  if (!e) return null;
  sessions.delete(sessionId);
  try { e.server.close(); } catch { /* 이미 닫혔다 */ }
  // ★ 서버 **프로세스**까지 내린다 — 연결만 끊으면 writer 락이 안 풀려 TUI 가 그 대화를 못 연다(실측).
  //  이제 서버는 게이트웨이 자식이 아니라 별도 프로세스라, 종료를 명시적으로 시켜야 한다.
  void stopServer(sessionId, e.osUser);
  return { threadId: e.threadId };
}

/** 그 세션의 app-server 프로세스를 내린다(터미널 인계용). 실패는 삼킨다 — 인계 안내는 이미 나갔다. */
async function stopServer(sessionId: string, osUser: string | null): Promise<void> {
  const port = sessionPort(sessionId);
  const sh = `pids=$(pgrep -f "app-server --listen ws://127.0.0.1:${port}" 2>/dev/null || true); [ -n "$pids" ] && kill $pids 2>/dev/null; echo stopped`;
  try {
    if (osUser) await memberSh(osUser, sh);
    else await new Promise<void>((resolve) => {
      const p = spawn("sh", ["-c", sh], { stdio: "ignore" });
      p.on("exit", () => resolve()); p.on("error", () => resolve());
    });
  } catch { /* 이미 없다 */ }
}

export function codexChatStatus(sessionId: string): { alive: boolean; threadId: string; startedAt: number } | null {
  const e = sessions.get(sessionId);
  return e ? { alive: !e.server.isClosed, threadId: e.threadId, startedAt: e.startedAt } : null;
}

/** 세션이 끝났다 — 런타임도 같이 내린다(고아 프로세스 방지). */
export function dropSession(sessionId: string): void {
  closePendings(sessionId);                                   // 런타임이 없어지면 그 승인들도 갈 곳이 없다
  const e = sessions.get(sessionId);
  if (!e) return;
  sessions.delete(sessionId);
  try { e.server.close(); } catch { /* 이미 죽었다 */ }
}

/**
 * 그 세션에 서 있던 승인들을 **거부로 닫는다**.
 *  왜 필요한가: 승인은 답이 올 때까지 서버 턴을 세워 두는 약속이다. 런타임이 사라지면 그 약속을 지킬
 *  주체가 없는데 promise 는 TTL(10분)까지 매달려 있고, 더 나쁜 건 **다음에 붙는 화면이 그 죽은 승인을
 *  되살려 보여 주는 것**이다(SSE 가 붙자마자 대기분을 재생한다) — 눌러도 아무 일도 안 일어나는 버튼이 된다.
 *  fail-closed 로 닫고 화면에도 그 사실을 알린다.
 */
function closePendings(sessionId: string): void {
  const map = pendings.get(sessionId);
  if (!map) return;
  pendings.delete(sessionId);
  for (const p of map.values()) {
    p.settle("decline");
    emit(sessionId, { kind: "approval-done", id: p.id, decision: "decline" });
  }
}

/** 테스트·종료 훅용 — 전부 내린다. */
export function dropAllCodexChats(): void {
  for (const id of [...sessions.keys()]) dropSession(id);
  for (const id of [...pendings.keys()]) closePendings(id);   // 런타임 없이 남은 승인(기동 실패 등)도 닫는다
}

/**
 * 서버 프로세스에 실을 **세션 신원** — 이게 없으면 훅이 대화 파일 경로를 게이트웨이에 보고하지 못해
 *  답이 파일에 있어도 **대화창이 비어 보인다**(실측 2026-08-26 — 사용자에겐 "답이 안 온다"로 나타났다).
 *  pane 세션이 `-e LIVELY_SESSION_ID` 로 받는 것과 **같은 값·같은 목적**이다(sessions.ts).
 */
export function sessionEnv(sessionId: string): Record<string, string> {
  return { LIVELY_SESSION_ID: sessionId, LIVELY_HARNESS: "codex" };
}

/** (순수) 스레드 id → 대화 파일을 찾는 셸 한 줄. 파일명에 **시각**이 들어가 규약으로 못 만들고, 날짜 폴더도 갈린다. */
export function findRolloutSh(threadId: string): string {
  return `ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*-${threadId}.jsonl 2>/dev/null | head -1`;
}

/**
 * 그 스레드의 rollout 파일 경로 — **화면이 대화를 읽는 유일한 단서**다.
 *
 *  ⚠ 왜 우리가 직접 찾나(실측 2026-08-26): 평소엔 세션 안에서 도는 훅(work-flag)이 `transcript_path` 를 보고해
 *   화면이 그 파일을 찾는다. 그런데 **app-server 턴에서는 그 훅이 돌지 않는다**(훅 신뢰가 이 실행에 없다 —
 *   app-server 에는 `--dangerously-bypass-hook-trust` 같은 표면도 없다). 그래서 답이 파일에 멀쩡히 쓰였는데도
 *   화면은 그 파일이 어디 있는지 몰라 **빈 채로 남았다**(사용자에게는 "답이 안 온다"로 보였다).
 *   우리는 threadId 를 알고 있으니 훅에 기대지 말고 **직접** 찾는다 — 의존이 하나 줄고 결정론적이다.
 */
export async function rolloutPath(osUser: string | null, threadId: string): Promise<string> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(threadId)) return "";
  const sh = findRolloutSh(threadId);
  try {
    if (osUser) return String(await memberSh(osUser, sh) ?? "").trim().split("\n")[0] ?? "";
    return await new Promise<string>((resolve) => {
      const p = spawn("sh", ["-c", sh], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      p.stdout?.on("data", (c: Buffer) => { out += c.toString("utf8"); });
      p.on("exit", () => resolve(out.trim().split("\n")[0] ?? ""));
      p.on("error", () => resolve(""));
    });
  } catch { return ""; }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
