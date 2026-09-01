// 노드에서 대화 런타임을 돌린다 (#2439).
//
//  ── 왜 이 파일이 있나 ───────────────────────────────────────────────────────────
//  대화 런타임은 여태 **게이트웨이가 프로세스를 띄울 수 있는 세션**에서만 돌았다
//  (deliver-prompt 의 분기 조건이 «이 박스의 tmux 에 그 세션이 있나» 다). 노드 세션의 tmux 는
//  그 PC 에 있으니 배달이 노드 릴레이로 갔고, 그래서 **승인·선택지·작업 목록이 웹에 올 길이
//  없었다**(실측 2026-09-01 — 사람이 그걸 신고했다).
//
//  그 세션이 사는 자리에서 런타임도 돌면 사건이 생긴다. 그것을 게이트웨이로 올리는 것이
//  `chatEvent` 이고, 이 파일은 «여기서 런타임을 띄우고 말을 건다» 만 한다.
//
//  ⚠ 게이트웨이와 **같은 코드**를 쓴다(harness-io/claude-chat-runtime). 두 벌이 되면
//   «답 없이 매달린 요청은 없다» 같은 불변식이 갈리고, 그중 하나는 반드시 빠진다.
import { logger } from "../log.js";

export interface ChatOnNodeResult { ok: boolean; convId?: string; error?: string }

/**
 * 이 노드의 세션에 **대화 런타임으로** 말을 건다.
 *
 *  ⚠ 실패를 «보냈다» 로 접지 않는다 — 게이트웨이가 그 사실을 보고 종전 경로(sendKeys)로 내려간다.
 *   여기서 조용히 성공을 반환하면 사람은 답을 영영 기다린다.
 */
export async function deliverChatOnNode(sessionId: string, text: string, harness: string): Promise<ChatOnNodeResult> {
  try {
    const { sessionDir } = await import("../terminal/terminal-sessions.js");
    const dir = await sessionDir(sessionId);
    const key = harness || "claude";
    const { sendClaudeChat, ensureGrokChat, sendGrokChat, ensureAntigravityChat, ensureOpencodeChat, ClaudeChatUnavailable } =
      await import("../terminal/harness-io/claude-chat-runtime.js");
    try {
      //  ⚠ 하네스마다 **여는 문이 다르다**(게이트웨이 deliver-prompt 와 같은 갈래) — 여기서 갈라야
      //   grok 의 핸드셰이크·opencode 의 서버 기동 세 단계가 실제로 돈다.
      //  ⚠ osUser 는 null 이다: 노드에서는 이미 그 사람의 계정으로 돌고 있다(격리 사다리가 없다).
      if (key === "grok") {
        const e = await ensureGrokChat({ sessionId, harness: key, cwd: dir, osUser: null });
        if (!sendGrokChat(e, text)) throw new ClaudeChatUnavailable("grok 에 말을 걸지 못했습니다");
        return { ok: true, convId: e.convId };
      }
      if (key === "antigravity") {
        const e = ensureAntigravityChat({ sessionId, harness: key, cwd: dir, osUser: null });
        if (!e.conn.send(text)) throw new ClaudeChatUnavailable("antigravity 턴을 시작하지 못했습니다");
        return { ok: true, convId: e.convId };
      }
      if (key === "opencode") {
        const e = await ensureOpencodeChat({ sessionId, harness: key, cwd: dir, osUser: null });
        if (!e.conn.send(text)) throw new ClaudeChatUnavailable("opencode 에 말을 걸지 못했습니다");
        return { ok: true, convId: e.convId };
      }
      const r = await sendClaudeChat({ sessionId, harness: key, text, cwd: dir, osUser: null });
      return { ok: true, convId: r.convId };
    } catch (e) {
      if (!(e instanceof ClaudeChatUnavailable)) throw e;
      logger.warn({ id: sessionId, err: (e as Error).message }, "노드 대화 런타임 전송 실패 — 게이트웨이가 종전 경로로 내려간다");
      return { ok: false, error: (e as Error).message };
    }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}
