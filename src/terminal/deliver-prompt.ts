// 떠 있는 세션에 글자(프롬프트)를 넣는 **한 통로** — POST /api/ui/terminal/sessions/:id/prompt 의 본체(#1664)이자,
// 서버가 스스로 세션에 지시를 넣을 때(리브 2턴 #1631)도 여길 탄다. 통로를 늘리지 않는다.
//
//  판정 순서(실측 근거는 각 분기 주석):
//   ① codex app-server 모드 — 글자를 화면에 '넣는' 대신 프로토콜로 보낸다(#2055). 실패는 사람에게 돌려준다.
//   ② 이 박스의 세션 — 아웃박스(#1753): 로그인·대화상자에 멈춘 세션이면 글자가 조용히 사라지므로 곧바로 send-keys 하지 않는다.
//   ③ 노드(멤버 PC) 세션 — 파일·tmux 가 그 컴퓨터에 있어 아웃박스 배달자가 닿지 않는다. 릴레이(injectPrompt).
//  접근 판정(canAttach·nodeCanAttach)은 **여기 없다** — 라우트(사람 요청)가 한다. 서버 내부 호출은 이미 그 세션의 주인을 안다.
import { HttpError } from "../http/rest-util.js";
import { logger } from "../log.js";
import { codexChatMode } from "./codex-chat-mode.js";
import { sessionRuntimeMode } from "./session-runtime-mode.js";

/**
 * 노드 세션의 대화 런타임을 **켜나** — `LIVELY_NODE_CHAT=1` (#2439).
 *
 *  ⚠ 기본은 **꺼짐**이다. 두 번이나 «화면으로 확인 안 하고 기본을 바꿔» 세션을 죽였다
 *   (2026-09-01). 이 경로는 노드에서 프로세스를 띄우는 새 길이라, 실제 세션에 말을 걸어
 *   답이 오는 것까지 눈으로 본 뒤에 기본으로 만든다.
 *  ⚠ 켜도 **실패하면 종전 릴레이로 내려간다** — 폴백이 없으면 새 경로가 곧 장애다.
 */
function chatOnNodeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.LIVELY_NODE_CHAT || "").trim() === "1";
}   // #2439 — chat 런타임 세션 분기
import { rememberCodexThread } from "./codex-chat-thread.js";
import { sessionDir, sessionGone, sessionOsUser } from "./terminal-sessions.js";
import { getSessionState } from "../sessions/session-state.js";

/**
 * 그 세션이 **어느 모드로 떴나**(tmux 옵션 `@box_runtime`) — #2439.
 *  ⚠ 모르면 undefined 다(«terminal» 이 아니다). 그래야 배포 기본이 그대로 적용된다 —
 *   여기서 임의로 접으면 기본을 켜 둔 배포에서 그 세션만 조용히 다르게 돈다.
 */
async function sessionRuntimeChoice(id: string): Promise<"chat" | "terminal" | undefined> {
  try {
    const { getOpt } = await import("./tmux-exec.js");
    const v = String((await getOpt(id, "@box_runtime")) || "").trim();
    return v === "chat" ? "chat" : v === "terminal" ? "terminal" : undefined;
  } catch { return undefined; }
}

/** #1683 후속2 — 그 세션이 어느 하네스로 떴나(tmux 세션 옵션 @box_harness). 모르면 빈 문자열. */
export async function sessionHarnessKey(id: string): Promise<string> {
  try { const { getOpt } = await import("./tmux-exec.js"); return String((await getOpt(id, "@box_harness")) || ""); }
  catch { return ""; }
}

export type DeliverResult =
  | { ok: true; delivered: true; transport: "app-server" | "chat-runtime"; thread_id: string; steered: boolean }
  | { ok: true; queued: true; outbox_id: number; seq: number; transport?: "outbox"; fallback?: string }
  | { ok: true };

export interface NodePromptDeps {
  chatSend: () => Promise<{ ok?: boolean; convId?: string; steered?: boolean; error?: string }>;
  inject: () => Promise<void>;
  remember?: (convId: string) => Promise<void>;
  warn?: (message: string) => void;
}

function nodeDeliveryError(error: unknown): HttpError {
  const msg = (error as Error)?.message ?? String(error);
  if (msg === "node-offline") return new HttpError(503, "그 컴퓨터가 지금 연결돼 있지 않습니다.");
  if (msg.startsWith("node-unsupported-op:")) return new HttpError(409, "그 컴퓨터의 라이블리가 오래돼 대화 입력을 받지 못합니다. 업데이트가 필요합니다.");
  if (msg === "node-rpc-timeout") return new HttpError(504, "그 컴퓨터가 응답하지 않습니다.");
  return new HttpError(503, `그 컴퓨터의 Codex 대화 통로로 보내지 못했습니다 — ${msg}`);
}

/**
 * 노드 세션에 말을 보내는 마지막 갈래. Codex app-server 의 pane 은 **셸**이므로 프로토콜 실패를 PTY 입력으로
 * 폴백하면 사람의 프롬프트가 zsh/PowerShell 명령이 된다(#3982). 이 갈래만은 실패를 그대로 돌려주고,
 * 실제 TUI 가 pane 을 쥔 하네스만 종전 send-keys 폴백을 허용한다.
 */
export async function deliverPromptToNode(
  o: { harness: string; env?: NodeJS.ProcessEnv }, deps: NodePromptDeps,
): Promise<DeliverResult> {
  const codexAppServer = codexChatMode({ harness: o.harness }, o.env) === "app-server";
  const useChat = codexAppServer || chatOnNodeEnabled(o.env);
  if (useChat) {
    let failed: unknown = null;
    try {
      const r = await deps.chatSend();
      if (r?.ok) {
        const convId = r.convId ?? "";
        if (convId && deps.remember) await deps.remember(convId);
        return {
          ok: true, delivered: true, transport: codexAppServer ? "app-server" : "chat-runtime",
          thread_id: convId, steered: !!r.steered,
        };
      }
      failed = new Error(r?.error || "노드 대화 런타임이 입력을 받지 못했습니다");
    } catch (e) { failed = e; }
    if (codexAppServer) throw nodeDeliveryError(failed);
    deps.warn?.((failed as Error)?.message ?? String(failed));
  }
  await deps.inject();
  return { ok: true };
}

export async function deliverPrompt(sessionId: string, text: string, opts?: {
  owner?: string | null; nodeId?: string | null; firstPromptTrustOk?: boolean;
}): Promise<DeliverResult> {
  if (!text.trim()) throw new HttpError(400, "보낼 내용이 없습니다");
  const owner = opts?.owner ?? null;
  const nodeId = opts?.nodeId !== undefined
    ? (opts.nodeId || "")
    : await import("../node/registry.js").then(({ nodeOfSession }) => nodeOfSession(sessionId) || "");
  let stateLoaded = false;
  let st: Awaited<ReturnType<typeof getSessionState>> | undefined;
  const loadState = async (): Promise<Awaited<ReturnType<typeof getSessionState>>> => {
    if (!stateLoaded) { st = await getSessionState(sessionId); stateLoaded = true; }
    return st;
  };
  // 로컬은 살아 있는 tmux 옵션이 정본이고, 원격 노드는 노드 스냅샷이 정본이다. 종전에는 원격 세션에도 로컬
  // tmux 옵션만 물어 빈 하네스를 얻었고, Codex app-server 분기를 건너뛰어 아래 send-keys 가 셸에 프롬프트를 쳤다.
  // 노드 스냅샷에 값이 있으면 DB를 읽지 않는다 — 원격 전달은 DB 장애 때도 기존처럼 동작해야 한다.
  const observedHarness = nodeId
    ? (await import("../node/registry.js")).nodeSessionHarness(nodeId, sessionId)
    : await sessionHarnessKey(sessionId);
  const harnessKey = observedHarness || (await loadState())?.harness || "";
  const localState = nodeId ? undefined : await loadState();
  // ── claude 대화 런타임(#2439) — chat 모드 세션은 stream-json 프로세스가 대화를 쥔다. ──
  //  왜 codex 분기보다 먼저 보나: 두 분기는 배타적이고(하네스가 다르다) 순서에 의미는 없지만,
  //  **판정 조건이 같은 모양**(모드 + 살아있음)이라 나란히 두면 다음 하네스를 얹을 자리가 분명해진다.
  //  ⚠ codex 와 같은 이유로 «이 박스의 tmux 에 그 세션이 실제로 있나» 로 가른다 — 노드 등록 여부로
  //   가르면 게이트웨이 박스가 노드로도 등록된 배포에서 이 분기가 통째로 무시된다(#2055 실측 함정).
  //  ★ #2439 — 그 세션이 **어느 모드로 떴는지**를 본다(@box_runtime). 배포 기본만 보면 생성 당시의
  //   결정과 갈리고, 갈리면 pane 은 셸인데 대화는 아무도 안 받는 세션이 된다(2026-09-01 실측).
  const runtimeChoice = await sessionRuntimeChoice(sessionId);
  if (sessionRuntimeMode({ harness: harnessKey, choice: runtimeChoice }) === "chat"
      && !(await sessionGone(sessionId))) {
    const { sendClaudeChat, ClaudeChatUnavailable } = await import("./harness-io/claude-chat-runtime.js");
    try {
      const dir = await sessionDir(sessionId);
      const osUser = await sessionOsUser(sessionId);
      //  ⚠ 하네스를 **넘긴다** — 런타임은 하네스 무관이고 표에서 argv·번역·인코딩을 꺼낸다.
      //   안 넘기면 claude 로 폴백해 «codex 세션에 claude 를 띄우는» 사고가 난다.
      //  ⚠ opencode 는 **비동기 준비**가 필요한 유일한 하네스다(서버 기동 → 세션 생성 → SSE).
      //   그래서 문이 따로다 — 여기서 갈라야 그 세 단계가 실제로 돈다.
      let r: { convId: string };
      if (harnessKey === "grok") {
        //  ACP — 핸드셰이크(initialize→session/new)가 먼저다. 세션 id 없이 보내면 -32602 가 돌아온다.
        const { ensureGrokChat, sendGrokChat } = await import("./harness-io/claude-chat-runtime.js");
        const e = await ensureGrokChat({ sessionId, harness: harnessKey, cwd: dir, osUser, convId: localState?.claude_session_id || null });
        if (!sendGrokChat(e, text)) throw new ClaudeChatUnavailable("grok 에 말을 걸지 못했습니다");
        r = { convId: e.convId };
      } else if (harnessKey === "antigravity") {
        //  턴마다 프로세스 — 파이프가 계속 사는 게 아니라 이 호출이 한 턴을 돌린다.
        const { ensureAntigravityChat } = await import("./harness-io/claude-chat-runtime.js");
        const e = ensureAntigravityChat({ sessionId, harness: harnessKey, cwd: dir, osUser, convId: localState?.claude_session_id || null });
        if (!e.conn.send(text)) throw new ClaudeChatUnavailable("antigravity 턴을 시작하지 못했습니다");
        r = { convId: e.convId };
      } else if (harnessKey === "opencode") {
        const { ensureOpencodeChat } = await import("./harness-io/claude-chat-runtime.js");
        const e = await ensureOpencodeChat({ sessionId, harness: harnessKey, cwd: dir, osUser, convId: localState?.claude_session_id || null });
        //  전송이 «줄» 을 REST 로 옮긴다(opencode 는 쓰기 주소가 따로다 — chat-transport 머리말).
        if (!e.conn.send(text)) throw new ClaudeChatUnavailable("opencode 에 말을 걸지 못했습니다");
        r = { convId: e.convId };
      } else {
        r = await sendClaudeChat({ sessionId, harness: harnessKey, text, cwd: dir, osUser, convId: localState?.claude_session_id || null });
      }
      //  ★ **대화 id 를 적는다.** 화면이 대화 파일을 찾는 유일한 단서가 이 매핑이다(chat-routes:
      //   «매핑이 없으면 404 가 정답이다 — 폴더의 최신 파일을 집지 않는다»). 종전엔 세션 **안에서** 도는
      //   훅(work-flag)만 이 값을 보고했는데, 대화 런타임은 우리가 띄운 프로세스라 그 훅이 보고하기 전까지
      //   화면이 파일을 못 찾는다 — 보통 툴을 한 번 쓴 뒤에야 보고되므로 **그 사이의 중간 응답이 통째로
      //   안 보이고 최종 답만 뜬다**(2026-09-01 상민님 신고). 우리는 첫 줄에서 이미 그 id 를 안다.
      //  ⚠ best-effort 다 — 실패해도 배달은 성공이다(훅이 뒤늦게 같은 값을 보고한다).
      if (r.convId && r.convId !== localState?.claude_session_id && localState?.owner) {
        const { setClaudeSessionId } = await import("../sessions/session-state.js");
        void setClaudeSessionId(sessionId, r.convId, localState.owner).catch((err) =>
          logger.warn({ id: sessionId, err: (err as Error)?.message }, "대화 id 매핑 기록 실패 — 훅 보고를 기다린다"));
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
  if (!nodeId && codexChatMode({ harness: harnessKey }) === "app-server"
      && !(await sessionGone(sessionId))) {
    //  아웃박스+send-keys 는 pane 화면을 읽어 타이밍을 맞추는 경로라, 로그인·대화상자에 걸리면 배달이 지연되거나
    //  조용히 사라진다. app-server 는 turn/start 의 **응답으로 성공/실패가 온다** — 애매함이 없다.
    //  ⚠ 실패해도 아웃박스로 폴백하지 않는다. 이 모드의 pane 은 zsh/PowerShell 셸이라, 아웃박스의 send-keys는
    //   사람의 프롬프트를 셸 명령으로 실행한다(#3982). 실패를 응답으로 드러내야 재시도할 수 있다.
    const { sendCodexChat, CodexChatUnavailable } = await import("./harness-io/codex-chat-runtime.js");
    try {
      const dir = await sessionDir(sessionId);
      const osUser = await sessionOsUser(sessionId);
      const r = await sendCodexChat({ sessionId, text, cwd: dir, osUser, threadId: localState?.claude_session_id || null });
      // 스레드 id **와 대화 파일 경로**를 세션 상태에 남긴다 — 게이트웨이가 재시작해도 같은 대화로 이어 붙고,
      //  화면이 대화를 읽는 유일한 단서가 남는다(app-server 턴에서는 세션 안 훅이 돌지 않는다, 실측 2026-08-26).
      await rememberCodexThread({
        sessionId, threadId: r.threadId, owner: owner ?? "", osUser,
        knownThreadId: localState?.claude_session_id, knownPath: localState?.transcript_path,
      });
      // steered = 새 턴이 아니라 **도는 턴에 얹었다**. 화면이 그 말풍선을 다르게 말할 수 있게 사실대로 싣는다.
      return { ok: true, delivered: true, transport: "app-server", thread_id: r.threadId, steered: !!r.steered };
    } catch (e) {
      if (!(e instanceof CodexChatUnavailable)) throw e;
      throw new HttpError(503, `Codex 대화 통로로 보내지 못했습니다 — ${(e as Error).message}`);
    }
  }
  if (!nodeId) {
    // 이 박스 세션 — 아웃박스(#1753)로. 곧바로 send-keys 하지 않는다: 로그인·대화상자에 멈춘 세션이면 글자가 조용히
    //  사라진다(실측). 배달자가 입력창을 확인하고 넣고, 트랜스크립트 에코로 delivered 를 확정한다. 화면은 seq 로 상태를 따라간다.
    const { enqueuePrompt } = await import("../sessions/session-outbox.js");
    const q = await enqueuePrompt(sessionId, text);
    return { ok: true, queued: true, outbox_id: q.id, seq: q.seq };
  }
  // 노드(멤버 PC) 세션 — 대화 런타임과 PTY 중 어느 쪽인지 위 헬퍼 한 곳에서 가른다.
  const { nodeRpc } = await import("../node/registry.js");
  const { injectPrompt } = await import("../node/session-inject.js");
  return deliverPromptToNode({ harness: harnessKey }, {
    chatSend: () => nodeRpc(nodeId, "chatSend", { id: sessionId, text, harness: harnessKey }),
    inject: opts?.firstPromptTrustOk === undefined
      ? () => injectPrompt(sessionId, text)
      : async () => {
        await nodeRpc(nodeId, "injectFirstPrompt", {
          id: sessionId, harness: harnessKey, text, trustOk: opts.firstPromptTrustOk,
        });
      },
    remember: async (convId) => {
      if (!owner) return;
      const { setNodeSessionMap } = await import("../sessions/session-state.js");
      await setNodeSessionMap(sessionId, nodeId, convId, owner).catch(() => false);
    },
    warn: (error) => logger.warn({ id: sessionId, err: error }, "노드 대화 런타임 전송 실패 — 종전 릴레이로"),
  });
}
