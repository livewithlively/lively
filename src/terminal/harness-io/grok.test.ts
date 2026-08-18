// grok 파서(grok.ts) — 사양 §D 표 전수 (#1746). 픽스처는 실측 updates.jsonl(2026-08-18) 줄 모양 그대로(개인정보만 치환).
import assert from "node:assert/strict";
import { parseGrok } from "./grok.js";
import type { ChatLine } from "./chat-line.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const SID = "019fffdf-83da-7be3-abfc-16d887d55419";
const line = (method: string, update: Record<string, unknown>, meta: Record<string, unknown> = {}, ts = 1786704270): string =>
  JSON.stringify({ timestamp: ts, method, params: { sessionId: SID, update, _meta: { eventId: `${SID}-1`, agentTimestampMs: ts * 1000 + 500, ...meta } } });
const F = {
  hook: line("_x.ai/session/update", { sessionUpdate: "hook_execution", event_name: "session_start", runs: [] }),
  user: line("session/update", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "whoami 를 호출해 내 id 만 답해." }, _meta: { modelId: "grok-4.6", promptIndex: 0 } }),
  thought: line("session/update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The user wants whoami." } }, { promptId: "p1", turnStartMs: 1786704268744 }),
  msg: line("session/update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "확인한 뒤 호출하겠습니다." } }, { promptId: "p1", turnStartMs: 1786704268744 }),
  empty: line("session/update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "   " } }),
  call1: line("session/update", { sessionUpdate: "tool_call", toolCallId: "call-1", title: "search_tool", rawInput: { query: "whoami" }, _meta: { "x.ai/tool": { name: "search_tool", kind: "search_tool" } } }),
  upd1a: line("session/update", { sessionUpdate: "tool_call_update", toolCallId: "call-1", kind: "other", title: 'Search tools: "whoami"', rawInput: { variant: "SearchTool", query: "whoami" } }),
  upd1b: line("session/update", { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", content: [{ type: "content", content: { type: "text", text: '{"results":[1]}' } }, { type: "content", content: { type: "text", text: "tail" } }] }),
  call2: line("session/update", { sessionUpdate: "tool_call", toolCallId: "call-2", title: "use_tool", rawInput: { tool_name: "lively__whoami", tool_input: {} }, _meta: { "x.ai/tool": { name: "use_tool" } } }),
  upd2: line("session/update", { sessionUpdate: "tool_call_update", toolCallId: "call-2", status: "completed", rawOutput: { type: "MCP", tool_name: "whoami", server_name: "lively", output: { OkayOutput: '{\n  "member_id": "someone"\n}' } } }),
  call3: line("session/update", { sessionUpdate: "tool_call", toolCallId: "call-3", title: "read_file", rawInput: { path: "/x" }, _meta: { "x.ai/tool": { name: "read_file" } } }),
  upd3: line("session/update", { sessionUpdate: "tool_call_update", toolCallId: "call-3", status: "failed", content: [{ type: "content", content: { type: "text", text: "ENOENT" } }] }),
  done: line("_x.ai/session/update", { sessionUpdate: "turn_completed", prompt_id: "p1", stop_reason: "end_turn", usage: {} }, {}, 1786704279),
  cancel: line("_x.ai/session/update", { sessionUpdate: "turn_completed", prompt_id: "p2", stop_reason: "cancelled" }, {}, 1786704290),
  recap: line("_x.ai/session/update", { sessionUpdate: "session_recap", summary: "요약", auto: true }),
};
const run = (ls: string[], state = {}) => parseGrok(ls.join("\n") + "\n", state);
const blocks = (l: ChatLine): any[] => (l.type === "system" ? [] : (Array.isArray(l.message.content) ? l.message.content : [{ type: "text", text: l.message.content }]));

t("[D1] user_message_chunk → user 줄(text) · hook_execution/session_recap 은 버림", () => {
  const { lines } = run([F.hook, F.user, F.recap]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "user"); assert.equal(blocks(lines[0])[0].text, "whoami 를 호출해 내 id 만 답해.");
});
t("[D2] agent_thought_chunk → thinking · agent_message_chunk → text · model 은 마지막 user modelId · 빈 텍스트 chunk 는 버림", () => {
  const { lines } = run([F.user, F.thought, F.msg, F.empty]);
  assert.equal(lines.length, 3);
  assert.deepEqual(blocks(lines[1]), [{ type: "thinking", thinking: "The user wants whoami." }]);
  assert.deepEqual(blocks(lines[2]), [{ type: "text", text: "확인한 뒤 호출하겠습니다." }]);
  assert.equal((lines[2] as any).message.model, "grok-4.6");
});
t("[D3] tool_call → tool_use{id,name,input} · MCP(use_tool)는 rawInput.tool_name 이 name", () => {
  const { lines } = run([F.call1, F.call2]);
  assert.deepEqual(blocks(lines[0]), [{ type: "tool_use", id: "call-1", name: "search_tool", input: { query: "whoami" } }]);
  assert.equal(blocks(lines[1])[0].name, "lively__whoami");
});
t("[D4] tool_call_update — status 없는 갱신은 버림 · completed content[] → tool_result 텍스트 join · rawOutput.OkayOutput → 그 문자열 · failed → is_error", () => {
  const { lines } = run([F.upd1a, F.upd1b, F.upd2, F.upd3]);
  assert.equal(lines.length, 3);
  assert.deepEqual(blocks(lines[0]), [{ type: "tool_result", tool_use_id: "call-1", content: '{"results":[1]}\ntail', is_error: false }]);
  assert.deepEqual(blocks(lines[1]), [{ type: "tool_result", tool_use_id: "call-2", content: '{\n  "member_id": "someone"\n}', is_error: false }]);
  assert.deepEqual(blocks(lines[2]), [{ type: "tool_result", tool_use_id: "call-3", content: "ENOENT", is_error: true }]);
});
t("[D5] turn_completed end_turn → system turn_duration, durationMs = agentTimestampMs − 앞 청크의 turnStartMs", () => {
  const { lines } = run([F.user, F.thought, F.done]);
  const sys = lines[lines.length - 1];
  assert.equal(sys.type, "system"); assert.equal((sys as any).subtype, "turn_duration");
  assert.equal((sys as any).durationMs, 1786704279 * 1000 + 500 - 1786704268744);
});
t("[D6] turn_completed cancelled → system interrupted(durationMs 없음)", () => {
  const { lines } = run([F.cancel]);
  assert.deepEqual([lines[0].type, (lines[0] as any).subtype, "durationMs" in lines[0]], ["system", "interrupted", false]);
});
t("[D7] 상태 이어달리기 — 창1 의 turnStartMs 가 창2 의 turn_completed 에 쓰인다 · 이어주지 않으면 durationMs 없음", () => {
  const w1 = run([F.user, F.thought]);
  const w2 = run([F.done], w1.state);
  assert.equal((w2.lines[0] as any).durationMs, 1786704279 * 1000 + 500 - 1786704268744);
  const cold = run([F.done]);
  assert.equal("durationMs" in cold.lines[0], false);
});
t("[D8] timestamp — params._meta.agentTimestampMs(밀리초) 우선, 없으면 timestamp(초) → ISO · 깨진 줄은 건너뜀", () => {
  const withMeta = run([F.user]).lines[0];
  assert.equal(withMeta.timestamp, new Date(1786704270 * 1000 + 500).toISOString());
  const noMeta = JSON.stringify({ timestamp: 1786704270, method: "session/update", params: { sessionId: SID, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "x" } } } });
  const r = run(["{broken", noMeta, "", "not json"]);
  assert.equal(r.lines.length, 1); assert.equal(r.lines[0].timestamp, new Date(1786704270 * 1000).toISOString());
});
t("[D9] 한 턴 전체(실측 순서) — user → thinking → text → tool_use → tool_result → tool_use → tool_result → text → turn_duration", () => {
  const { lines } = run([F.hook, F.user, F.thought, F.msg, F.call1, F.upd1a, F.upd1b, F.call2, F.upd2, F.msg, F.done]);
  assert.deepEqual(lines.map((l) => l.type === "system" ? `system:${l.subtype}` : `${l.type}:${blocks(l)[0].type}`),
    ["user:text", "assistant:thinking", "assistant:text", "assistant:tool_use", "user:tool_result", "assistant:tool_use", "user:tool_result", "assistant:text", "system:turn_duration"]);
});

console.log(`harness-io/grok: ${pass} passed`);
