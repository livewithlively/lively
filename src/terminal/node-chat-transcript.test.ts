// 원격 노드 대화 읽기 계약 (#3982·#3870) — 노드 RPC는 원본 바이트만, 게이트웨이는 하네스 파서로 ChatLine을 만든다.
import assert from "node:assert/strict";
import test from "node:test";
import { readNodeTranscript } from "./node-chat-transcript.js";

const raw = [
  { timestamp: "2026-09-15T00:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: "맥에서도 같은가요?" } },
  { timestamp: "2026-09-15T00:00:01.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "MAC_CODEX_3982_FOLLOWUP" }] } },
  { timestamp: "2026-09-15T00:00:02.000Z", type: "event_msg", payload: { type: "task_complete" } },
].map((x) => JSON.stringify(x)).join("\n") + "\n";

test("원격 rollout을 여러 제한 청크로 읽어 기존 Codex ChatLine으로 돌려준다", async () => {
  const bytes = Buffer.from(raw);
  const calls: Array<{ offset: number; len: number }> = [];
  const got = await readNodeTranscript({
    nodeId: "haruui-macbookair", sessionId: "box-sangmin-yoon-1", threadId: "01a0a3f3-8e21-7b41-a203-8b58dfbca1c5",
    harness: "codex",
    query: { tail: String(bytes.length) }, chunkBytes: 37,
    rpc: async (_node, op, args) => {
      assert.equal(op, "chatTranscript");
      const offset = Number(args.offset), len = Number(args.len); calls.push({ offset, len });
      if (len === 0) return { found: true, size: bytes.length, offset: 0, data: "", eof: false };
      const part = bytes.subarray(offset, Math.min(bytes.length, offset + len));
      return { found: true, size: bytes.length, offset, data: part.toString("base64"), eof: offset + part.length >= bytes.length };
    },
  });
  assert.ok(got);
  assert.equal(got.bytes, bytes.length);
  assert.equal(got.from, 0);
  assert.equal(got.to, bytes.length);
  const lines = got.ndjson.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].message.content, "맥에서도 같은가요?");
  assert.equal(lines[1].message.content[0].text, "MAC_CODEX_3982_FOLLOWUP");
  assert.ok(calls.filter((c) => c.len > 0).length > 1, "큰 파일도 RPC 한 장으로 싣지 않는다");
  assert.ok(calls.every((c) => c.len <= 37), "요청 청크 상한을 지킨다");
});

test("rollout이 아직 없으면 빈 성공이 아니라 null로 구분한다", async () => {
  const got = await readNodeTranscript({
    nodeId: "n", sessionId: "box-1", threadId: "01a0a3f3-8e21-7b41-a203-8b58dfbca1c5", harness: "codex", query: {},
    rpc: async () => ({ found: false, size: 0, offset: 0, data: "", eof: true }),
  });
  assert.equal(got, null);
});

test("원격 Claude JSONL을 그대로 전달해 /model 결과를 화면이 관측할 수 있게 한다", async () => {
  const uuid = "4e2e9a14-34aa-45ca-b061-c8a97465ff0e";
  const bytes = Buffer.from([
    JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-25T00:00:00.000Z", message: { role: "user", content: "<local-command-stdout>Set model to fable</local-command-stdout>" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-09-25T00:00:01.000Z", message: { role: "assistant", model: "claude-fable", content: [{ type: "text", text: "반영했습니다." }] } }),
  ].join("\n") + "\n");
  const got = await readNodeTranscript({
    nodeId: "laibeulliui-macmini", sessionId: "box-wonjoon-jang-b921bf9e", threadId: uuid,
    harness: "claude", query: { tail: bytes.length }, chunkBytes: 31,
    rpc: async (_node, _op, args) => {
      const offset = Number(args.offset), len = Number(args.len);
      if (len === 0) return { found: true, size: bytes.length, offset: 0, data: "", eof: false };
      const part = bytes.subarray(offset, Math.min(bytes.length, offset + len));
      return { found: true, size: bytes.length, offset, data: part.toString("base64"), eof: offset + part.length >= bytes.length };
    },
  });
  assert.ok(got);
  assert.equal(got.harness, "claude");
  const lines = got.ndjson.trim().split("\n").map((line) => JSON.parse(line));
  assert.match(lines[0].message.content, /Set model to fable/);
  assert.equal(lines[1].message.model, "claude-fable");
});

test("Claude가 아닌 UUID나 읽기 파서가 없는 하네스는 노드 RPC 전에 거부한다", async () => {
  let calls = 0;
  for (const [harness, threadId] of [["claude", "not-a-uuid"], ["shell", "4e2e9a14-34aa-45ca-b061-c8a97465ff0e"]]) {
    const got = await readNodeTranscript({
      nodeId: "n", sessionId: "box-1", threadId, harness, query: {}, rpc: async () => { calls++; return null; },
    });
    assert.equal(got, null);
  }
  assert.equal(calls, 0);
});
