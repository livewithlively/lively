// claude 대화 런타임 (#2439 ②) — 세션 하나당 `claude --input-format stream-json` 프로세스 하나를 쥐고 산다.
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
import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "../../log.js";
import { sessionSpawnArgv } from "../session-exec.js";
import { memberSpawnArgv } from "../terminal-member-fs.js";
import { claudeStreamEvent } from "./claude-stream.js";
import { clearSessionTasks, emitSessionEvent, settleAll } from "./runtime-bus.js";
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

interface Entry {
  child: ChildProcess;
  sessionId: string;
  /** 하네스가 알려준 이 대화의 id(init 에서 온다) — 재개·대화 파일 찾기의 단서. */
  convId: string;
  /** 줄 경계가 안 맞는 꼬리(청크가 줄 가운데서 끊긴다). */
  carry: string;
  startedAt: number;
  closing: boolean;
}

const live = new Map<string, Entry>();

/** (순수 — 테스트 seam) 이 세션의 claude 를 대화 런타임으로 띄울 argv. */
export function claudeChatArgv(o: { convId?: string | null; model?: string | null }): string[] {
  const argv = [
    "claude", "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    //  우리가 보낸 말을 되돌려 받아 **배달 확인**에 쓴다(에코를 화면에서 찾지 않아도 된다).
    "--replay-user-messages",
    //  서브에이전트 발화를 parent_tool_use_id 를 달아 흘려 준다 — 작업 표면이 그걸로 귀속한다.
    "--forward-subagent-text",
  ];
  if (o.model) argv.push("--model", String(o.model));
  //  ⚠ 대화 이어받기는 **있을 때만**. 없는 id 로 --resume 하면 프로세스가 즉시 죽는다.
  if (o.convId) argv.push("--resume", String(o.convId));
  return argv;
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
  try { e.child.stdin?.end(); } catch { /* 이미 닫혔다 */ }
  try { e.child.kill("SIGTERM"); } catch { /* 이미 죽었다 */ }
  logger.info({ sessionId, reason, aliveMs: Date.now() - e.startedAt }, "claude 대화 런타임 종료");
  return true;
}

/** 줄 단위로 잘라 번역기에 먹인다 — 청크는 줄 가운데서 끊긴다(carry). */
function feed(e: Entry, chunk: string): void {
  const text = e.carry + chunk;
  const lines = text.split("\n");
  e.carry = lines.pop() ?? "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] !== "{") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { continue; }   // 사람이 읽을 로그가 섞여 나올 수 있다 — 조용히 건너뛴다
    //  대화 id 는 첫 init 에서 온다. 재개·대화 파일 찾기의 단서라 잡아 둔다.
    const sid = (parsed as { session_id?: unknown })?.session_id;
    if (!e.convId && typeof sid === "string" && sid) e.convId = sid;
    const ev: SessionEvent | null = claudeStreamEvent(parsed);
    if (ev) emitSessionEvent(e.sessionId, ev);
  }
}

/**
 * 이 세션의 런타임을 **보장**한다(없으면 띄운다). 이미 있으면 그대로 쓴다.
 *  ⚠ 띄우기만 한다 — 말을 거는 것은 sendClaudeChat 이다(수명과 전송을 섞지 않는다).
 */
export function ensureClaudeChat(o: ClaudeChatOpts): Entry {
  const found = live.get(o.sessionId);
  if (found) return found;

  const argv = claudeChatSpawnArgv(o.sessionId, o.osUser, claudeChatArgv(o));
  if (!argv.length) throw new ClaudeChatUnavailable("실행 경계를 만들지 못했습니다");

  let child: ChildProcess;
  try {
    child = o.spawnFn
      ? o.spawnFn(argv, o.cwd)
      : spawn(argv[0], argv.slice(1), { cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    throw new ClaudeChatUnavailable("대화 런타임을 띄우지 못했습니다", err);
  }

  const e: Entry = { child, sessionId: o.sessionId, convId: String(o.convId || ""), carry: "", startedAt: Date.now(), closing: false };
  live.set(o.sessionId, e);

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => { try { feed(e, c); } catch (err) { logger.warn({ sessionId: o.sessionId, err: (err as Error)?.message }, "대화 이벤트 처리 실패 — 그 줄만 버린다"); } });
  //  stderr 는 사람이 읽을 진단이다. 이벤트로 올리지 않되 버리지도 않는다.
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (c: string) => { const s = String(c).trim(); if (s) logger.warn({ sessionId: o.sessionId, stderr: s.slice(0, 500) }, "claude 대화 런타임 stderr"); });

  //  ★ 죽으면 **반드시** 마감한다 — 걸려 있던 승인이 있으면 그 턴은 영영 안 끝난다.
  const onGone = (why: string) => () => {
    if (e.closing) return;
    live.delete(o.sessionId);
    settleAll(o.sessionId, why);
    clearSessionTasks(o.sessionId);
    logger.warn({ sessionId: o.sessionId, why, aliveMs: Date.now() - e.startedAt }, "claude 대화 런타임이 끝났다");
  };
  child.on("exit", onGone("exit"));
  child.on("error", onGone("error"));

  logger.info({ sessionId: o.sessionId, resumed: !!o.convId }, "claude 대화 런타임 시작");
  return e;
}

/**
 * 말을 건다 — stream-json 한 줄로 넣는다.
 *  ⚠ 여기서 «답이 왔나» 를 기다리지 않는다. 답은 이벤트로 흐르고(버스), 화면이 그것을 그린다.
 *   기다리면 이 호출이 턴 전체만큼 길어져 HTTP 요청이 타임아웃 난다.
 */
export function sendClaudeChat(o: ClaudeChatOpts & { text: string }): { convId: string } {
  const text = String(o.text || "");
  if (!text.trim()) throw new ClaudeChatUnavailable("보낼 내용이 없습니다");
  const e = ensureClaudeChat(o);
  const line = JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  }) + "\n";
  const ok = e.child.stdin?.write(line);
  if (ok === false) logger.warn({ sessionId: o.sessionId }, "대화 런타임 stdin 이 밀렸다 — 버퍼가 비면 나간다");
  if (!e.child.stdin || e.child.stdin.destroyed) {
    stopClaudeChat(o.sessionId, "stdin 닫힘");
    throw new ClaudeChatUnavailable("대화 런타임에 말을 걸 수 없습니다(stdin 닫힘)");
  }
  return { convId: e.convId };
}
