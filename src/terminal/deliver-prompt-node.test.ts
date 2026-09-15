import assert from "node:assert/strict";
import test from "node:test";
import { deliverPromptToNode, type NodePromptDeps } from "./deliver-prompt.js";
import { deliverChatOnNode } from "../node/chat-on-node.js";

function stub(o?: {
  chat?: { ok?: boolean; convId?: string; steered?: boolean; error?: string } | Error;
  injectError?: Error;
}): { deps: NodePromptDeps; calls: string[]; remembered: string[] } {
  const calls: string[] = [];
  const remembered: string[] = [];
  return {
    calls,
    remembered,
    deps: {
      chatSend: async () => {
        calls.push("chat");
        if (o?.chat instanceof Error) throw o.chat;
        return o?.chat ?? { ok: true, convId: "conv-1" };
      },
      inject: async () => {
        calls.push("inject");
        if (o?.injectError) throw o.injectError;
      },
      remember: async (id) => { remembered.push(id); },
    },
  };
}

test("노드 Codex App Server 입력은 chatSend만 쓰고 대화 좌표를 남긴다", async () => {
  const h = stub({ chat: { ok: true, convId: "codex-thread", steered: true } });
  const r = await deliverPromptToNode({ harness: "codex", env: {} }, h.deps);
  assert.deepEqual(h.calls, ["chat"]);
  assert.deepEqual(h.remembered, ["codex-thread"]);
  assert.deepEqual(r, {
    ok: true, delivered: true, transport: "app-server", thread_id: "codex-thread", steered: true,
  });
});

test("노드 Codex App Server 대화 전송 실패는 PTY 셸 입력으로 폴백하지 않는다", async () => {
  const h = stub({ chat: { ok: false, error: "app-server 시작 실패" } });
  await assert.rejects(
    () => deliverPromptToNode({ harness: "codex", env: {} }, h.deps),
    (e: unknown) => !!e && typeof e === "object" && (e as { status?: number }).status === 503,
  );
  assert.deepEqual(h.calls, ["chat"]);
});

test("노드 Codex가 명시적 tmux 모드면 기존 PTY 입력을 쓴다", async () => {
  const h = stub();
  assert.deepEqual(await deliverPromptToNode({ harness: "codex", env: { LIVELY_CODEX_CHAT: "tmux" } }, h.deps), { ok: true });
  assert.deepEqual(h.calls, ["inject"]);
});

test("노드 대화 기능을 켜지 않은 다른 하네스는 기존 PTY 입력을 쓴다", async () => {
  const h = stub();
  await deliverPromptToNode({ harness: "claude", env: {} }, h.deps);
  assert.deepEqual(h.calls, ["inject"]);
});

test("노드 대화 기능을 켠 다른 하네스는 chatSend를 쓴다", async () => {
  const h = stub({ chat: { ok: true, convId: "claude-conv" } });
  const r = await deliverPromptToNode({ harness: "claude", env: { LIVELY_NODE_CHAT: "1" } }, h.deps);
  assert.deepEqual(h.calls, ["chat"]);
  assert.equal("delivered" in r && r.delivered, true);
  assert.equal("transport" in r ? r.transport : null, "chat-runtime");
});

test("다른 하네스의 노드 대화 전송 실패는 기존 PTY 입력으로 폴백한다", async () => {
  const h = stub({ chat: { ok: false, error: "런타임 실패" } });
  await deliverPromptToNode({ harness: "claude", env: { LIVELY_NODE_CHAT: "1" } }, h.deps);
  assert.deepEqual(h.calls, ["chat", "inject"]);
});

test("하네스를 모르면 Codex로 추측하지 않고 기존 PTY 입력을 쓴다", async () => {
  const h = stub();
  await deliverPromptToNode({ harness: "", env: {} }, h.deps);
  assert.deepEqual(h.calls, ["inject"]);
});

test("노드의 Codex chatSend 구현은 범용 JSONL이 아니라 App Server 런타임을 부른다", async () => {
  const seen: unknown[] = [];
  const r = await deliverChatOnNode("box-win", "안녕하세요", "codex", {
    sessionDir: async () => "C:\\work\\project",
    sendCodexChat: async (o) => { seen.push(o); return { threadId: "thread-win", steered: false }; },
  });
  assert.deepEqual(seen, [{ sessionId: "box-win", text: "안녕하세요", cwd: "C:\\work\\project", osUser: null }]);
  assert.deepEqual(r, { ok: true, convId: "thread-win", steered: false });
});
