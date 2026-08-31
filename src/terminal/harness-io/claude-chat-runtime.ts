// 대화 런타임 (#2439) — 세션 하나당 하네스 프로세스/연결 하나를 쥐고 산다. **하네스 무관**.
//
//  ⚠ 이름이 `claude-*` 인 것은 처음 claude 로 세운 자취다. 지금은 전송(chat-transport)과 어댑터 표
//   (chat-adapters)를 받아 **어느 하네스든** 연다 — 그래서 두 번째 런타임을 만들 이유가 없다.
//   두 벌이 되면 「모든 요청은 반드시 한 번 답한다」 같은 불변식이 갈리고, 반드시 한쪽이 빠진다.
//
//  ── 무엇을 대체하나 ──────────────────────────────────────────────────────────────
//  terminal 모드에서 쓰기 축은 tmux send-keys(아웃박스 경유)였고, 읽기 축은 대화 파일 tail 이었다.
//  그 조합으로는 **작업(백그라운드 셸·서브에이전트)·승인·슬래시가 아예 안 보인다** — 그 정보가 대화
//  파일에 없기 때문이다(실측: transcript 26줄에 task 이벤트 0건). 여기서는 그것들이 이벤트로 온다.
//
//  ── 경계 ────────────────────────────────────────────────────────────────────────
//  · 프로세스는 **그 세션의 실행 경계 안에서** 뜬다 — 매니지드면 세션 컨테이너(sessionSpawnArgv).
//    게이트웨이에서 그냥 띄우면 남의 테넌트와 같은 컨테이너에서 에이전트가 명령을 실행한다(격리 붕괴).
//    codex 와 **같은 함수**를 쓴다 — 경계 계산이 두 벌이 되면 한쪽만 고쳐져 조용히 게이트웨이 권한으로 돈다.
//  · 승인·이벤트는 [[runtime-bus.ts]] 를 쓴다. 「모든 요청은 반드시 한 번 답한다」는 거기서 지킨다.
//  · 무엇이든 잘못되면 **ClaudeChatUnavailable** 을 던진다 — 호출자가 종전 경로로 폴백한다.
//
//  ── 왜 stdin 을 열어 두나 ────────────────────────────────────────────────────────
//  `--input-format stream-json` 은 stdin 이 닫히면 프로세스가 끝난다. 세션이 사는 동안 계속 말을 걸어야
//  하므로 파이프를 잡고 있는다. 그래서 **종료 경로가 중요하다** — 안 닫으면 컨테이너에 프로세스가 쌓인다.
import type { ChildProcess } from "node:child_process";
import { logger } from "../../log.js";
import { sessionSpawnArgv } from "../session-exec.js";
import { memberSpawnArgv } from "../terminal-member-fs.js";
import { chatAdapter } from "./chat-adapters.js";
import type { PermissionAnswer, PermissionAsk } from "./session-event.js";
import { grokPromptLine } from "./grok-stream.js";
import { perTurnTransport, stdioTransport, type ChatTransportConn } from "./chat-transport.js";
import { ask, clearSessionTasks, emitSessionEvent, settleAll } from "./runtime-bus.js";
import type { SessionEvent } from "./session-event.js";

/** 이 세션에서는 대화 런타임을 못 쓴다 — 호출자는 종전(send-keys) 경로로 폴백한다. */
export class ClaudeChatUnavailable extends Error {
  /**
   * **한 글자도 안 갔나.** 기본 true — 이 오류는 대부분 프로세스를 못 띄운 자리에서 난다.
   *  큐(아웃박스)를 쥔 호출자에겐 «되돌려도 되는 실패» 와 «이미 갔을 수 있는 실패» 의 결말이 정반대다.
   *  (codex 의 CodexChatUnavailable 과 같은 축 — 두 런타임이 같은 규약을 쓴다.)
   */
  constructor(message: string, readonly cause?: unknown, readonly notStarted = true) {
    super(message); this.name = "ClaudeChatUnavailable";
  }
}

export interface ClaudeChatOpts {
  sessionId: string;
  /** 어느 하네스인가. 없으면 claude(이 파일이 claude 로 시작한 자취 — 호출부가 점차 명시로 옮긴다). */
  harness?: string;
  /** 턴이 도는 작업 폴더. */
  cwd: string;
  /** 격리 멤버 OS 계정. null 이면 비격리 배포 — 게이트웨이 uid 로 띄운다. */
  osUser: string | null;
  /** 이어 열 대화(있으면 --resume). 없으면 새 대화. */
  convId?: string | null;
  model?: string | null;
  /** 테스트 seam — 프로세스를 갈아 끼운다(기본: 실제 spawn). */
  spawnFn?: (argv: string[], cwd: string) => ChildProcess;
}

export interface Entry {
  conn: ChatTransportConn;
  /** 이 세션이 어느 하네스로 도나 — 번역기·인코딩을 그 표에서 꺼낸다. */
  harness: string;
  sessionId: string;
  /** 하네스가 알려준 이 대화의 id(init 에서 온다) — 재개·대화 파일 찾기의 단서. */
  convId: string;
  startedAt: number;
  closing: boolean;
  /**
   * 승인 답을 **하네스에 돌려보내는 길**. 기본은 표의 `respond` → 파이프로 한 줄.
   *  ⚠ opencode 는 REST 라 줄이 아니다 — 그 ensure* 가 여기에 HTTP 호출을 꽂는다.
   *   이 훅이 비어 있으면 카드는 떠도 답이 안 가고, 그 턴은 TTL 까지 선다.
   */
  respond?: (ask: PermissionAsk, value: PermissionAnswer) => void;
  /**
   * 도는 턴을 멈추는 길. 표의 `interrupt`(한 줄) 로 표현 안 되는 하네스가 여기에 자기 길을 꽂는다
   *  — opencode 는 REST(POST /session/{id}/abort), antigravity 는 **프로세스 kill**(턴마다 프로세스라
   *  보낼 파이프가 없다). 없으면 «못 멈춘다» 로 사실대로 답한다(멈춘 척하지 않는다).
   */
  interrupt?: () => boolean;
  /**
   * 이 프로세스가 **살아서 말을 시작했나**(첫 줄을 냈나).
   *
   *  ⚠ 왜 필요한가: `spawn` 은 비동기다. 인자를 모르는 빌드는 즉시 죽지만 그 `exit` 은 **다음 틱**에
   *   온다 — 그 사이 `send()` 는 멀쩡한 파이프에 써서 **true 를 준다**. 그러면 상위는 «전달됨» 을
   *   반환하고 폴백이 안 걸리고, 사람은 보낸 줄 알고 답을 영영 기다린다(가장 나쁜 결말).
   *   그래서 **첫 전송만** 이 값이 설 때까지 잠깐 확인한다(둘째 턴부터는 비용이 없다).
   */
  spoke?: boolean;
}

const live = new Map<string, Entry>();

/**
 * (순수 — 테스트 seam) 이 하네스를 대화 런타임으로 띄울 argv. **표가 정본**이다(chat-adapters).
 *  여기 손으로 적으면 표와 갈리고, 갈리는 순간 «표엔 열린다는데 실제로는 다른 명령» 이 된다.
 */
export function claudeChatArgv(o: { harness?: string; convId?: string | null; model?: string | null }): string[] {
  const a = chatAdapter(o.harness ?? "claude");
  return a?.argv ? a.argv(o) : [];
}

/**
 * (순수 — 테스트 seam) 실행 경계까지 감싼 **전체 명령**.
 *  세션 경계(매니지드) → 멤버 경계(격리 박스) → 로컬 순으로 내려간다. codex 와 같은 사다리다.
 */
export function claudeChatSpawnArgv(sessionId: string, osUser: string | null, argv: string[]): string[] {
  const bySession = sessionSpawnArgv(sessionId, argv);
  if (bySession.length) return bySession;
  if (osUser) return memberSpawnArgv(osUser, argv);
  return argv;
}

/**
 * opencode 를 연다 (#2439) — **비동기 준비**가 필요한 유일한 하네스다.
 *  서버 기동 → 세션 생성 → SSE 전송. 다른 하네스는 spawn 한 번이면 파이프가 열리지만
 *  여기는 세 단계라 `ensureClaudeChat`(동기)에 못 넣는다. 그래서 별도 문으로 둔다.
 *
 *  ⚠ 실패는 **null 이 아니라 throw** 다 — 호출자(deliverPrompt)가 이미 ClaudeChatUnavailable 을
 *   잡아 종전 경로로 폴백한다. 여기서 null 을 주면 그 폴백을 못 탄다.
 */
export async function ensureOpencodeChat(o: ClaudeChatOpts): Promise<Entry> {
  const found = live.get(o.sessionId);
  if (found) return found;

  const { ensureOpencodeServe, opencodeNewSession, opencodePost, opencodeUrls } = await import("./opencode-serve.js");
  const served = await ensureOpencodeServe({ sessionId: o.sessionId, cwd: o.cwd, osUser: o.osUser });
  if (!served) throw new ClaudeChatUnavailable("opencode 서버를 띄우지 못했습니다");
  const { base, event } = opencodeUrls(served.port);

  //  opencode 쪽 세션 id 는 **우리 것과 다르다** — 잃으면 새 대화가 열린다(대화를 잇는 단서).
  const convId = String(o.convId || "") || (await opencodeNewSession({ base, cwd: o.cwd }) ?? "");
  if (!convId) throw new ClaudeChatUnavailable("opencode 세션을 만들지 못했습니다");

  const { sseTransport } = await import("./chat-transport.js");
  const conn = sseTransport({
    eventUrl: event,
    //  ⚠ 쓰기는 «줄» 이 아니라 REST 호출이다(읽기와 주소가 다르다 — chat-transport 머리말).
    postLine: (line) => opencodePost({ base, opencodeSessionId: convId, text: line }),
  });

  const e: Entry = { conn, harness: "opencode", sessionId: o.sessionId, convId, startedAt: Date.now(), closing: false };
  //  ★ opencode 의 승인 응답은 **줄이 아니라 REST** 다(POST /permission/{id}/reply) — 읽기와 쓰기의
  //   주소가 다른 하네스이므로 표의 `respond`(한 줄) 로는 표현되지 않는다. 그 지식을 여기 꽂는다.
  const { opencodeReplyPermission, opencodeAbort } = await import("./opencode-serve.js");
  e.respond = (askInfo, value) => {
    void opencodeReplyPermission({ base, requestId: askInfo.id, allow: value.allow, always: value.scope === "always" })
      .catch((err) => logger.warn({ sessionId: o.sessionId, err: (err as Error)?.message }, "opencode 승인 응답 실패"));
  };
  //  멈춤도 REST 다(읽기 SSE·쓰기 POST 인 하네스라 파이프로 보낼 줄이 없다).
  e.interrupt = () => { void opencodeAbort({ base, opencodeSessionId: convId }); return true; };
  live.set(o.sessionId, e);
  conn.onLine((line) => {
    try { feedLine(e, line); }
    catch (err) { logger.warn({ sessionId: o.sessionId, err: (err as Error)?.message }, "대화 이벤트 처리 실패 — 그 줄만 버린다"); }
  });
  logger.info({ sessionId: o.sessionId, port: served.port, convId }, "opencode 대화 런타임 시작");
  return e;
}

/**
 * antigravity 를 연다 (#2439) — **턴마다 프로세스**가 나고 죽는다(perTurnTransport 머리말).
 *  다른 하네스는 파이프 하나가 계속 사는데 여기는 `--conversation=<id>` 로 잇는다.
 */
export function ensureAntigravityChat(o: ClaudeChatOpts): Entry {
  const found = live.get(o.sessionId);
  if (found) return found;

  const e: Entry = {
    conn: null as unknown as ChatTransportConn, harness: "antigravity",
    sessionId: o.sessionId, convId: String(o.convId || ""), startedAt: Date.now(), closing: false,
  };
  const conn = perTurnTransport({
    cwd: o.cwd,
    //  ⚠ 실행 경계는 **다른 하네스와 같은 사다리**를 탄다 — 여기만 빠뜨리면 게이트웨이 권한으로 돈다.
    argvFor: (text, convId) => {
      const inner = ["agy", `--print=${text}`, "--output-format=stream-json"];
      if (convId) inner.push(`--conversation=${convId}`);
      const bySession = sessionSpawnArgv(o.sessionId, inner);
      return bySession.length ? bySession : (o.osUser ? memberSpawnArgv(o.osUser, inner) : inner);
    },
    //  대화 id 를 잃으면 다음 턴이 **새 대화**를 연다(사람은 기억을 잃은 것처럼 본다).
    onConvId: (id) => { e.convId = id; },
  });
  if (e.convId) conn.setConvId(e.convId);
  e.conn = conn;
  //  멈춤은 **프로세스 kill** 이다 — 이 하네스는 stdin 스트림이 벤더 미구현이라 보낼 줄이 없다.
  e.interrupt = () => conn.abort();
  live.set(o.sessionId, e);
  conn.onLine((line) => {
    try { feedLine(e, line); }
    catch (err) { logger.warn({ sessionId: o.sessionId, err: (err as Error)?.message }, "대화 이벤트 처리 실패 — 그 줄만 버린다"); }
  });
  logger.info({ sessionId: o.sessionId, resumed: !!e.convId }, "antigravity 대화 런타임 시작(턴마다 프로세스)");
  return e;
}

/**
 * grok 을 연다 (#2439) — ACP 는 **핸드셰이크가 먼저**다(initialize → session/new → 그 id 로 prompt).
 *  claude 처럼 «띄우면 곧 말할 수 있다» 가 아니라서 전용 문이 필요하다.
 *
 *  ⚠ 세션 id 를 못 받으면 **열지 않는다** — 그 상태로 말을 걸면 `-32602 unknown session id` 가
 *   돌아오고 사람은 답을 영영 기다린다(실측으로 확인한 바로 그 오류다).
 */
export async function ensureGrokChat(o: ClaudeChatOpts): Promise<Entry> {
  const found = live.get(o.sessionId);
  if (found) return found;

  const inner = ["grok", "agent", "stdio"];
  const bySession = sessionSpawnArgv(o.sessionId, inner);
  const argv = bySession.length ? bySession : (o.osUser ? memberSpawnArgv(o.osUser, inner) : inner);

  const conn = stdioTransport(argv, o.cwd, {
    spawnFn: o.spawnFn,
    onStderr: (text) => logger.warn({ sessionId: o.sessionId, stderr: text.slice(0, 500) }, "grok stderr"),
  });
  const e: Entry = { conn, harness: "grok", sessionId: o.sessionId, convId: String(o.convId || ""), startedAt: Date.now(), closing: false };

  //  ★ ACP 응답은 **id 로 짝짓는다**(알림과 응답이 같은 스트림에 섞인다).
  const waitFor = (id: number, ms: number): Promise<Record<string, unknown> | null> => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    pendingRpc.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  });
  const pendingRpc = new Map<number, (m: Record<string, unknown>) => void>();

  conn.onLine((line) => {
    if (line[0] !== "{") return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const id = typeof msg.id === "number" ? msg.id : null;
    if (id !== null && pendingRpc.has(id)) { pendingRpc.get(id)!(msg); pendingRpc.delete(id); return; }
    try { feedLine(e, line); }
    catch (err) { logger.warn({ sessionId: o.sessionId, err: (err as Error)?.message }, "대화 이벤트 처리 실패 — 그 줄만 버린다"); }
  });

  conn.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } } }));
  const init = await waitFor(1, 15_000);
  if (!init) { conn.close(); throw new ClaudeChatUnavailable("grok 핸드셰이크가 응답하지 않습니다"); }

  //  대화를 이어 열 수 있으면 그렇게(session/load), 아니면 새로.
  conn.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new",
    params: { cwd: o.cwd, mcpServers: [] } }));
  const created = await waitFor(2, 30_000);
  const sid = (created?.result as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof sid !== "string" || !sid) {
    conn.close();
    //  인증 전이면 `-32000 Authentication required` 가 온다 — 그 사실을 그대로 말한다(빈 화면 금지).
    const err = (created?.error as { message?: unknown } | undefined)?.message;
    throw new ClaudeChatUnavailable(`grok 세션을 열지 못했습니다${err ? ` — ${String(err)}` : ""}`);
  }
  e.convId = sid;
  live.set(o.sessionId, e);
  logger.info({ sessionId: o.sessionId, convId: sid }, "grok 대화 런타임 시작(ACP)");
  return e;
}

/** grok 에 말을 건다 — ACP `session/prompt`(봉투는 grok-stream 이 만든다). */
export function sendGrokChat(e: Entry, text: string, id = Date.now() % 100000): boolean {
  return e.conn.send(grokPromptLine(e.convId, text, id).trimEnd());
}

/** 이 세션의 런타임이 지금 떠 있나. */
export function isClaudeChatLive(sessionId: string): boolean {
  return live.has(sessionId);
}

/**
 * 런타임을 내린다 — **남은 승인 요청을 반드시 마감**하고(안 하면 그 턴이 영영 안 끝난다) 프로세스를 닫는다.
 *  같은 세션에 두 번 불러도 안전하다.
 */
export function stopClaudeChat(sessionId: string, reason: string): boolean {
  const e = live.get(sessionId);
  if (!e) { settleAll(sessionId, reason); return false; }
  e.closing = true;
  live.delete(sessionId);
  settleAll(sessionId, reason);
  clearSessionTasks(sessionId);   // 죽은 세션의 «도는 중» 이 화면에 남지 않게
  e.conn.close();
  logger.info({ sessionId, reason, aliveMs: Date.now() - e.startedAt }, "claude 대화 런타임 종료");
  return true;
}

/** 한 줄 → 번역기 → 버스. 줄 자르기는 전송이 이미 했다(chat-transport.lineSplitter). */
function feedLine(e: Entry, line: string): void {
  //  ★ 무슨 줄이든 «이 프로세스가 살아서 말을 시작했다» 는 증거다(JSON 이 아니어도 된다).
  e.spoke = true;
  if (line[0] !== "{") return;                 // 사람이 읽을 로그가 섞여 나온다 — 조용히 건너뛴다
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return; }
  //  대화 id 는 첫 init 에서 온다. 재개·대화 파일 찾기의 단서라 잡아 둔다.
  const sid = (parsed as { session_id?: unknown })?.session_id;
  if (!e.convId && typeof sid === "string" && sid) e.convId = sid;
  const translate = chatAdapter(e.harness)?.translate;
  const ev: SessionEvent | null = translate ? translate(parsed) : null;
  if (!ev) return;

  //  ★ 승인은 **그냥 흘리지 않는다.** 이건 알림이 아니라 «답을 기다리는 물음» 이다 —
  //   버스의 ask() 에 걸어 두고(화면이 카드를 그린다), 사람이 답하면 하네스로 돌려보낸다.
  //   ⚠ 그냥 emit 만 하면 화면엔 카드가 뜨는데 눌러도 아무 데도 안 가고 그 턴은 영영 선다.
  //    이 프로젝트가 «반쪽 UX» 라 불린 상태가 정확히 그 모양이었다.
  if (ev.t === "permission.asked") {
    const askInfo = ev.ask;
    void ask<PermissionAnswer>(e.sessionId, askInfo.id, askInfo, DENY).then((value) => {
      try { respondTo(e, askInfo, value); }
      catch (err) { logger.warn({ sessionId: e.sessionId, id: askInfo.id, err: (err as Error)?.message }, "승인 응답 전송 실패"); }
    });
    return;
  }
  emitSessionEvent(e.sessionId, ev);
}

/** 답을 못 받았을 때의 기본값 — **거부**다(모르면 넓게 열지 않는다). */
const DENY: PermissionAnswer = { allow: false, scope: "once" };

/** 승인 답을 하네스로 돌려보낸다 — Entry 의 훅이 있으면 그것, 없으면 표의 `respond` 로 한 줄. */
function respondTo(e: Entry, askInfo: PermissionAsk, value: PermissionAnswer): void {
  if (e.respond) { e.respond(askInfo, value); return; }
  const respond = chatAdapter(e.harness)?.respond;
  const line = respond ? respond({ ask: askInfo, value, convId: e.convId }) : null;
  //  ⚠ 답할 길이 없으면 **로그로 남긴다** — 조용히 삼키면 «왜 안 되지» 를 아무도 못 찾는다.
  if (!line) { logger.warn({ sessionId: e.sessionId, harness: e.harness }, "이 하네스는 승인 응답 경로가 없다 — 턴이 설 수 있다"); return; }
  e.conn.send(line.trimEnd());
}

/**
 * 도는 턴을 멈춘다 — 터미널의 Esc 한 번에 해당한다.
 *  ⚠ 못 멈추는 하네스는 **false 를 준다**(있는 척하지 않는다). 화면이 그 사실로 안내를 가른다.
 */
export function interruptChat(sessionId: string): boolean {
  const e = live.get(sessionId);
  if (!e) return false;
  if (e.interrupt) return e.interrupt();
  const make = chatAdapter(e.harness)?.interrupt;
  const line = make ? make({ convId: e.convId }) : null;
  if (!line) return false;
  return e.conn.send(line.trimEnd());
}

/**
 * 이 세션의 런타임을 **보장**한다(없으면 띄운다). 이미 있으면 그대로 쓴다.
 *  ⚠ 띄우기만 한다 — 말을 거는 것은 sendClaudeChat 이다(수명과 전송을 섞지 않는다).
 */
export function ensureClaudeChat(o: ClaudeChatOpts): Entry {
  const found = live.get(o.sessionId);
  if (found) return found;

  const harness = o.harness ?? "claude";
  const argv = claudeChatSpawnArgv(o.sessionId, o.osUser, claudeChatArgv({ ...o, harness }));
  if (!argv.length) throw new ClaudeChatUnavailable(`이 하네스는 대화 런타임을 못 엽니다(${harness})`);

  let conn: ChatTransportConn;
  try {
    //  ⚠ 지금은 stdio 만 연다. http-sse(opencode)는 «서버를 띄우고 포트를 잡는» 선행 단계가 있어
    //   여기서 바로 못 만든다 — 그 단계가 생기면 sseTransport 로 갈아 끼우면 되고, 아래는 안 바뀐다.
    conn = stdioTransport(argv, o.cwd, {
      spawnFn: o.spawnFn,
      onStderr: (text) => logger.warn({ sessionId: o.sessionId, harness, stderr: text.slice(0, 500) }, "대화 런타임 stderr"),
    });
  } catch (err) {
    throw new ClaudeChatUnavailable("대화 런타임을 띄우지 못했습니다", err);
  }

  const e: Entry = { conn, harness, sessionId: o.sessionId, convId: String(o.convId || ""), startedAt: Date.now(), closing: false };
  live.set(o.sessionId, e);

  conn.onLine((line) => {
    try { feedLine(e, line); }
    catch (err) { logger.warn({ sessionId: o.sessionId, err: (err as Error)?.message }, "대화 이벤트 처리 실패 — 그 줄만 버린다"); }
  });

  //  ★ 죽으면 **반드시** 마감한다 — 걸려 있던 승인이 있으면 그 턴은 영영 안 끝난다.
  //   전송이 alive=false 가 되는 순간을 폴링으로 잡는다(전송마다 종료 이벤트 모양이 다르므로 한 규약으로).
  const watch = setInterval(() => {
    if (e.closing || conn.alive()) return;
    clearInterval(watch);
    if (live.get(o.sessionId) === e) live.delete(o.sessionId);
    settleAll(o.sessionId, "런타임 종료");
    clearSessionTasks(o.sessionId);
    logger.warn({ sessionId: o.sessionId, harness, aliveMs: Date.now() - e.startedAt }, "대화 런타임이 끝났다");
  }, 1000);
  if (typeof watch.unref === "function") watch.unref();   // 이 감시가 프로세스를 붙잡지 않게

  logger.info({ sessionId: o.sessionId, harness, resumed: !!o.convId }, "대화 런타임 시작");
  return e;
}

/**
 * 말을 건다 — stream-json 한 줄로 넣는다.
 *  ⚠ 여기서 «답이 왔나» 를 기다리지 않는다. 답은 이벤트로 흐르고(버스), 화면이 그것을 그린다.
 *   기다리면 이 호출이 턴 전체만큼 길어져 HTTP 요청이 타임아웃 난다.
 */
export async function sendClaudeChat(o: ClaudeChatOpts & { text: string; startupMs?: number }): Promise<{ convId: string }> {
  const text = String(o.text || "");
  if (!text.trim()) throw new ClaudeChatUnavailable("보낼 내용이 없습니다");
  const harness = o.harness ?? "claude";
  const encode = chatAdapter(harness)?.encode;
  //  인코딩을 모르면 **말을 걸 수 없다** — 표가 그 사실을 안다(있는 척하지 않는다).
  if (!encode) throw new ClaudeChatUnavailable(`이 하네스는 아직 말을 걸 수 없습니다(${harness})`);
  const had = live.has(o.sessionId);
  const e = ensureClaudeChat({ ...o, harness });
  if (!e.conn.send(encode(text))) {
    stopClaudeChat(o.sessionId, "전송 실패");
    throw new ClaudeChatUnavailable("대화 런타임에 말을 걸 수 없습니다");
  }
  //  ★ **방금 띄운 프로세스**만 기동을 확인한다(이미 살아 있던 세션은 비용 0).
  //   `send()` 가 true 를 줬다고 프로세스가 산 것이 아니다 — spawn 은 비동기라, 인자를 모르는 빌드는
  //   즉시 죽지만 그 exit 은 다음 틱에 온다. 그 사이의 write 는 멀쩡한 파이프에 성공한다.
  //   여기서 안 걸러 내면 상위가 «전달됨» 을 반환해 **폴백이 안 걸리고**, 사람은 보낸 줄 알고
  //   답을 영영 기다린다. (2026-09-01 — --permission-prompt-tool 을 넣으며 이 구멍을 알았다.)
  if (!had && !(await awaitStartup(e, o.startupMs ?? 1500))) {
    stopClaudeChat(o.sessionId, "기동 실패");
    throw new ClaudeChatUnavailable("대화 런타임이 시작되지 못했습니다");
  }
  return { convId: e.convId };
}

/**
 * 이 프로세스가 **말을 시작했나**를 잠깐 기다린다.
 *  · 한 줄이라도 냈으면 true — 살아 있다.
 *  · 그 전에 죽었으면 false — 호출자가 폴백을 탄다.
 *  · 시간이 다 되도록 조용하면 **true 로 본다**(느린 기동을 죽음으로 오인하지 않는다 —
 *    거짓 폴백은 멀쩡한 세션을 종전 경로로 떨어뜨린다).
 */
async function awaitStartup(e: Entry, ms: number): Promise<boolean> {
  const until = Date.now() + Math.max(0, ms);
  for (;;) {
    if (e.spoke) return true;
    if (!e.conn.alive()) return false;
    if (Date.now() >= until) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
}
