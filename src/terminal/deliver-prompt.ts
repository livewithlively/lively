// 떠 있는 세션에 글자(프롬프트)를 넣는 **한 통로** — POST /api/ui/terminal/sessions/:id/prompt 의 본체(#1664)이자,
// 서버가 스스로 세션에 지시를 넣을 때(리브 2턴 #1631)도 여길 탄다. 통로를 늘리지 않는다.
//
//  판정 순서(실측 근거는 각 분기 주석):
//   ① codex app-server 모드 — 글자를 화면에 '넣는' 대신 프로토콜로 보낸다(#2055). 실패하면 아웃박스로 폴백.
//   ② 이 박스의 세션 — 아웃박스(#1753): 로그인·대화상자에 멈춘 세션이면 글자가 조용히 사라지므로 곧바로 send-keys 하지 않는다.
//   ③ 노드(멤버 PC) 세션 — 파일·tmux 가 그 컴퓨터에 있어 아웃박스 배달자가 닿지 않는다. 릴레이(injectPrompt).
//  접근 판정(canAttach·nodeCanAttach)은 **여기 없다** — 라우트(사람 요청)가 한다. 서버 내부 호출은 이미 그 세션의 주인을 안다.
import { HttpError } from "../http/rest-util.js";
import { logger } from "../log.js";
import { codexChatMode } from "./codex-chat-mode.js";
import { sessionRuntimeMode } from "./session-runtime-mode.js";   // #2439 — chat 런타임 세션 분기
import { rememberCodexThread } from "./codex-chat-thread.js";
import { sessionDir, sessionGone, sessionOsUser } from "./terminal-sessions.js";
import { getSessionState } from "../sessions/session-state.js";

/** #1683 후속2 — 그 세션이 어느 하네스로 떴나(tmux 세션 옵션 @box_harness). 모르면 빈 문자열. */
export async function sessionHarnessKey(id: string): Promise<string> {
  try { const { getOpt } = await import("./tmux-exec.js"); return String((await getOpt(id, "@box_harness")) || ""); }
  catch { return ""; }
}

export type DeliverResult =
  | { ok: true; delivered: true; transport: "app-server" | "chat-runtime"; thread_id: string; steered: boolean }
  | { ok: true; queued: true; outbox_id: number; seq: number; transport?: "outbox"; fallback?: string }
  | { ok: true };

export async function deliverPrompt(sessionId: string, text: string, opts?: { owner?: string | null; nodeId?: string | null }): Promise<DeliverResult> {
  if (!text.trim()) throw new HttpError(400, "보낼 내용이 없습니다");
  const owner = opts?.owner ?? null;
  const nodeId = opts?.nodeId !== undefined
    ? (opts.nodeId || "")
    : await import("../node/registry.js").then(({ nodeOfSession }) => nodeOfSession(sessionId) || "");
  // ── claude 대화 런타임(#2439) — chat 모드 세션은 stream-json 프로세스가 대화를 쥔다. ──
  //  왜 codex 분기보다 먼저 보나: 두 분기는 배타적이고(하네스가 다르다) 순서에 의미는 없지만,
  //  **판정 조건이 같은 모양**(모드 + 살아있음)이라 나란히 두면 다음 하네스를 얹을 자리가 분명해진다.
  //  ⚠ codex 와 같은 이유로 «이 박스의 tmux 에 그 세션이 실제로 있나» 로 가른다 — 노드 등록 여부로
  //   가르면 게이트웨이 박스가 노드로도 등록된 배포에서 이 분기가 통째로 무시된다(#2055 실측 함정).
  const harnessKey = await sessionHarnessKey(sessionId);
  if (sessionRuntimeMode({ harness: harnessKey }) === "chat"
      && !(await sessionGone(sessionId))) {
    const { sendClaudeChat, ClaudeChatUnavailable } = await import("./harness-io/claude-chat-runtime.js");
    try {
      const dir = await sessionDir(sessionId);
      const osUser = await sessionOsUser(sessionId);
      const st = await getSessionState(sessionId);
      //  ⚠ 하네스를 **넘긴다** — 런타임은 하네스 무관이고 표에서 argv·번역·인코딩을 꺼낸다.
      //   안 넘기면 claude 로 폴백해 «codex 세션에 claude 를 띄우는» 사고가 난다.
      //  ⚠ opencode 는 **비동기 준비**가 필요한 유일한 하네스다(서버 기동 → 세션 생성 → SSE).
      //   그래서 문이 따로다 — 여기서 갈라야 그 세 단계가 실제로 돈다.
      let r: { convId: string };
      if (harnessKey === "opencode") {
        const { ensureOpencodeChat } = await import("./harness-io/claude-chat-runtime.js");
        const e = await ensureOpencodeChat({ sessionId, harness: harnessKey, cwd: dir, osUser, convId: st?.claude_session_id || null });
        //  전송이 «줄» 을 REST 로 옮긴다(opencode 는 쓰기 주소가 따로다 — chat-transport 머리말).
        if (!e.conn.send(text)) throw new ClaudeChatUnavailable("opencode 에 말을 걸지 못했습니다");
        r = { convId: e.convId };
      } else {
        r = sendClaudeChat({ sessionId, harness: harnessKey, text, cwd: dir, osUser, convId: st?.claude_session_id || null });
      }
      return { ok: true, delivered: true, transport: "chat-runtime", thread_id: r.convId, steered: false };
    } catch (e) {
      if (!(e instanceof ClaudeChatUnavailable)) throw e;
      //  ★ 실패하면 **반드시 종전 경로로 폴백**한다(codex 와 같은 규약). 대화 런타임은 새 경로라
      //   폴백이 없으면 그 자체가 장애가 된다. 폴백했다는 사실은 응답에 실어 화면이 이유를 말하게 한다.
      logger.warn({ id: sessionId, err: (e as Error).message }, "claude 대화 런타임 전송 실패 — 종전 경로로 폴백");
    }
  }

  // ── codex app-server 모드(#2055) — 글자를 화면에 '넣는' 대신 **프로토콜로 보낸다**. ──
  //  ⚠ **노드 판정보다 먼저** 본다(실측 2026-08-26, dev): 게이트웨이 박스가 노드로도 등록돼 있으면
  //   그 박스의 **로컬 세션까지 노드 스냅샷에 잡혀**(applyLiveTheme 주석과 같은 함정) 아래 노드 릴레이로
  //   빠져 이 분기가 통째로 무시됐다 — 응답이 `{ok:true}` 한 줄로 와서 겉으론 성공처럼 보인다.
  //   그래서 '노드에 등록됐나'가 아니라 **'이 박스의 tmux 에 그 세션이 실제로 있나'** 로 가른다.
  if (codexChatMode({ harness: await sessionHarnessKey(sessionId) }) === "app-server"
      && !(await sessionGone(sessionId))) {
    //  아웃박스+send-keys 는 pane 화면을 읽어 타이밍을 맞추는 경로라, 로그인·대화상자에 걸리면 배달이 지연되거나
    //  조용히 사라진다. app-server 는 turn/start 의 **응답으로 성공/실패가 온다** — 애매함이 없다.
    //  ⚠ 실패하면 반드시 종전 경로로 폴백한다(app-server 는 공식 문서상 experimental). 폴백했다는 사실은
    //   응답에 실어 화면·게이트가 볼 수 있게 한다 — 조용히 접으면 "왜 느리지"의 원인을 아무도 모른다.
    const { sendCodexChat, CodexChatUnavailable } = await import("./harness-io/codex-chat-runtime.js");
    try {
      const dir = await sessionDir(sessionId);
      const osUser = await sessionOsUser(sessionId);
      const st = await getSessionState(sessionId);
      const r = await sendCodexChat({ sessionId, text, cwd: dir, osUser, threadId: st?.claude_session_id || null });
      // 스레드 id **와 대화 파일 경로**를 세션 상태에 남긴다 — 게이트웨이가 재시작해도 같은 대화로 이어 붙고,
      //  화면이 대화를 읽는 유일한 단서가 남는다(app-server 턴에서는 세션 안 훅이 돌지 않는다, 실측 2026-08-26).
      await rememberCodexThread({
        sessionId, threadId: r.threadId, owner: owner ?? "", osUser,
        knownThreadId: st?.claude_session_id, knownPath: st?.transcript_path,
      });
      // steered = 새 턴이 아니라 **도는 턴에 얹었다**. 화면이 그 말풍선을 다르게 말할 수 있게 사실대로 싣는다.
      return { ok: true, delivered: true, transport: "app-server", thread_id: r.threadId, steered: !!r.steered };
    } catch (e) {
      if (!(e instanceof CodexChatUnavailable)) throw e;
      logger.warn({ id: sessionId, err: (e as Error).message }, "codex app-server 전송 실패 — 종전 경로로 폴백");
      const { enqueuePrompt } = await import("../sessions/session-outbox.js");
      const q = await enqueuePrompt(sessionId, text);
      return { ok: true, queued: true, outbox_id: q.id, seq: q.seq, transport: "outbox", fallback: (e as Error).message };
    }
  }
  if (!nodeId) {
    // 이 박스 세션 — 아웃박스(#1753)로. 곧바로 send-keys 하지 않는다: 로그인·대화상자에 멈춘 세션이면 글자가 조용히
    //  사라진다(실측). 배달자가 입력창을 확인하고 넣고, 트랜스크립트 에코로 delivered 를 확정한다. 화면은 seq 로 상태를 따라간다.
    const { enqueuePrompt } = await import("../sessions/session-outbox.js");
    const q = await enqueuePrompt(sessionId, text);
    return { ok: true, queued: true, outbox_id: q.id, seq: q.seq };
  }
  // 노드(멤버 PC) 세션 — 파일·tmux 가 그 컴퓨터에 있어 아웃박스 배달자가 닿지 않는다. 종전 릴레이 그대로(후속 #1753 P2).
  const { injectPrompt } = await import("../node/session-inject.js");
  try { await injectPrompt(sessionId, text); }
  catch (e) {
    // 노드가 꺼졌거나 구버전이면 nodeRpc 가 고정 문자열로 던진다 — 사람 말로 옮긴다(그냥 500 이면 원인을 모른다).
    const msg = (e as Error)?.message ?? String(e);
    if (msg === "node-offline") throw new HttpError(503, "그 컴퓨터가 지금 연결돼 있지 않습니다.");
    if (msg.startsWith("node-unsupported-op:")) throw new HttpError(409, "그 컴퓨터의 라이블리가 오래돼 프롬프트를 받지 못합니다. 업데이트가 필요합니다.");
    if (msg === "node-rpc-timeout") throw new HttpError(504, "그 컴퓨터가 응답하지 않습니다.");
    throw e;
  }
  return { ok: true };
}
