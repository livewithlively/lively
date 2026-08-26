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
import { CodexAppServer, appServerArgv, stdioTransport, type AppServerTransport, type ApprovalDecision, type ApprovalRequest } from "./codex-app-server.js";
import { memberSpawnArgv } from "../terminal-member-fs.js";
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

async function start(o: CodexChatOpts): Promise<Entry> {
  const argv = o.osUser ? memberSpawnArgv(o.osUser, appServerArgv()) : appServerArgv();
  let server: CodexAppServer;
  try {
    const transport = o.transportFactory ? o.transportFactory(argv, o.cwd) : stdioTransport({ argv, cwd: o.cwd });
    server = new CodexAppServer({
      transport,
      onLine: o.onLine,
      onDelta: o.onDelta ? (d) => o.onDelta?.(d) : undefined,
      onApproval: o.onApproval,
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

  const entry: Entry = { server, threadId, cwd: o.cwd, osUser: o.osUser, startedAt: Date.now() };
  sessions.set(o.sessionId, entry);
  return entry;
}

/** 한 턴 보낸다. 준비가 안 됐으면 준비하고 보낸다(호출자는 ensure 를 따로 부를 필요가 없다). */
export async function sendCodexChat(o: CodexChatOpts & { text: string }): Promise<{ threadId: string }> {
  const text = String(o.text ?? "");
  if (!text.trim()) throw new CodexChatUnavailable("빈 메시지는 보내지 않습니다");
  await ensureCodexChat(o);
  const e = sessions.get(o.sessionId);
  if (!e) throw new CodexChatUnavailable("codex 대화 런타임이 사라졌습니다");
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
  const e = sessions.get(sessionId);
  if (!e) return null;
  dropSession(sessionId);
  return { threadId: e.threadId };
}

export function codexChatStatus(sessionId: string): { alive: boolean; threadId: string; startedAt: number } | null {
  const e = sessions.get(sessionId);
  return e ? { alive: !e.server.isClosed, threadId: e.threadId, startedAt: e.startedAt } : null;
}

/** 세션이 끝났다 — 런타임도 같이 내린다(고아 프로세스 방지). */
export function dropSession(sessionId: string): void {
  const e = sessions.get(sessionId);
  if (!e) return;
  sessions.delete(sessionId);
  try { e.server.close(); } catch { /* 이미 죽었다 */ }
}

/** 테스트·종료 훅용 — 전부 내린다. */
export function dropAllCodexChats(): void {
  for (const id of [...sessions.keys()]) dropSession(id);
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
