// App Server 이벤트 → ChatLine 계약 (#2055). 줄 원문은 전부 **실측**에서 딴 것(필드 축약만) —
//  codex-cli 0.149.1 로 initialize→thread/start→turn/start 를 돌려 받은 알림이다(지식 codex-app-server-spike-2055 §2).
//  ⚠ 이 파일은 하네스 바이너리 없이 돈다 — 형식 회귀는 여기서 잡고, 실바이너리 왕복은 별도(codex-app-server.e2e).
import assert from "node:assert/strict";
import { appServerLines } from "./codex-app-server-events.js";
import type { ChatAssistantLine, ChatSystemLine, ChatUserLine, ParseState } from "./chat-line.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const N = (method: string, params: unknown) => ({ jsonrpc: "2.0", method, params });
const done = (item: unknown, atMs = 1787717882905) => N("item/completed", { threadId: "th1", turnId: "tu1", completedAtMs: atMs, item });

t("A1 userMessage → user 줄(사람 말)", () => {
  const { lines } = appServerLines(done({ type: "userMessage", id: "u1", content: [{ type: "text", text: "정확히 '패리티 확인'이라고만 답해라" }] }), {});
  assert.equal(lines.length, 1);
  const u = lines[0] as ChatUserLine;
  assert.equal(u.type, "user");
  assert.equal(u.message.content, "정확히 '패리티 확인'이라고만 답해라");
  assert.equal(u.timestamp, new Date(1787717882905).toISOString());
});

t("A2 agentMessage → assistant text", () => {
  const { lines } = appServerLines(done({ type: "agentMessage", id: "msg_0ac4", text: "패리티 확인", phase: "final_answer" }), {});
  const a = lines[0] as ChatAssistantLine;
  assert.equal(a.type, "assistant");
  assert.deepEqual(a.message.content, [{ type: "text", text: "패리티 확인" }]);
  assert.equal(a.message.id, "msg_0ac4");
});

t("A3 ★ item/started 는 줄을 만들지 않는다 — 같은 id 로 completed 가 다시 온다(중복 방지)", () => {
  const started = N("item/started", { threadId: "th1", item: { type: "agentMessage", id: "m1", text: "" } });
  assert.deepEqual(appServerLines(started, {}).lines, []);
});

t("A4 ★ 델타는 줄이 아니다(타이핑) — 번역기는 무시하고 클라이언트가 onDelta 로 따로 다룬다", () => {
  assert.deepEqual(appServerLines(N("item/agentMessage/delta", { threadId: "th1", delta: "패리" }), {}).lines, []);
});

t("B1 reasoning content → thinking(생각 원문). rollout 파서와 달리 여기선 실제로 온다", () => {
  const { lines } = appServerLines(done({ type: "reasoning", id: "r1", content: ["먼저 파일을 읽는다"], summary: ["요약"] }), {});
  const a = lines[0] as ChatAssistantLine;
  assert.deepEqual(a.message.content, [{ type: "thinking", thinking: "먼저 파일을 읽는다" }]);
});

t("B2 reasoning 이 content 없이 summary 만 → summary 로 접는다", () => {
  const { lines } = appServerLines(done({ type: "reasoning", id: "r2", content: [], summary: ["계획을 세웠다"] }), {});
  assert.deepEqual((lines[0] as ChatAssistantLine).message.content, [{ type: "thinking", thinking: "계획을 세웠다" }]);
});

t("C1 commandExecution → tool_use(Bash) + tool_result 한 쌍", () => {
  const { lines } = appServerLines(done({
    type: "commandExecution", id: "exec-bf12", command: "/bin/zsh -lc 'ls -la'", cwd: "/tmp",
    aggregatedOutput: "total 0\n", exitCode: 0, status: "completed",
  }), {});
  assert.equal(lines.length, 2);
  const use = (lines[0] as ChatAssistantLine).message.content[0] as any;
  assert.equal(use.type, "tool_use");
  assert.equal(use.name, "Bash");
  assert.equal(use.input.command, "/bin/zsh -lc 'ls -la'");
  const res = (lines[1] as ChatUserLine).message.content as any[];
  assert.equal(res[0].type, "tool_result");
  assert.equal(res[0].tool_use_id, "exec-bf12");
  assert.equal(res[0].content, "total 0\n");
  assert.equal(res[0].is_error, undefined);
});

t("C2 exitCode 0 이 아니면 tool_result 가 오류로 표시된다", () => {
  const { lines } = appServerLines(done({ type: "commandExecution", id: "e2", command: "false", aggregatedOutput: "", exitCode: 1, status: "completed" }), {});
  const res = (lines[1] as ChatUserLine).message.content as any[];
  assert.equal(res[0].is_error, true);
});

t("C3 출력이 없고 실패도 아니면 결과 줄을 만들지 않는다(빈 말풍선 금지)", () => {
  const { lines } = appServerLines(done({ type: "commandExecution", id: "e3", command: "true", aggregatedOutput: "", exitCode: 0, status: "completed" }), {});
  assert.equal(lines.length, 1);
});

t("C4 긴 출력은 잘라 붙이되 잘렸다고 알린다(창을 통째로 먹지 않게)", () => {
  const big = "x".repeat(20_000);
  const { lines } = appServerLines(done({ type: "commandExecution", id: "e4", command: "cat big", aggregatedOutput: big, exitCode: 0, status: "completed" }), {});
  const res = (lines[1] as ChatUserLine).message.content as any[];
  assert.ok(res[0].content.length < big.length);
  assert.match(res[0].content, /\+4000자/);
});

t("D1 fileChange → tool_use(Edit) + diff 결과. 화면 분류기가 읽는 file_path 를 채운다", () => {
  const { lines } = appServerLines(done({
    type: "fileChange", id: "fc1", status: "completed",
    changes: [{ path: "/work/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" }],
  }), {});
  const use = (lines[0] as ChatAssistantLine).message.content[0] as any;
  assert.equal(use.name, "Edit");
  assert.equal(use.input.file_path, "/work/a.ts");
  const res = (lines[1] as ChatUserLine).message.content as any[];
  assert.match(res[0].content, /\+b/);
});

t("E1 mcpToolCall → mcp__<서버>__<도구> 이름으로 접는다", () => {
  const { lines } = appServerLines(done({
    type: "mcpToolCall", id: "mc1", server: "lively", tool: "knowledge_get",
    arguments: { name: "x" }, result: { ok: true }, status: "completed",
  }), {});
  const use = (lines[0] as ChatAssistantLine).message.content[0] as any;
  assert.equal(use.name, "mcp__lively__knowledge_get");
  assert.deepEqual(use.input, { name: "x" });
});

t("F1 turn/started → 줄 없음, 상태에만 시각을 남긴다", () => {
  const { lines, state } = appServerLines(N("turn/started", { threadId: "th1", startedAtMs: 1000 }), {});
  assert.deepEqual(lines, []);
  assert.equal(state.turnStartMs, 1000);
});

t("F2 turn/completed → system turn_duration(시각차)", () => {
  const st: ParseState = { turnStartMs: 1000 };
  const { lines, state } = appServerLines(N("turn/completed", { threadId: "th1", completedAtMs: 7100 }), st);
  const s = lines[0] as ChatSystemLine;
  assert.equal(s.subtype, "turn_duration");
  assert.equal(s.durationMs, 6100);
  assert.equal(state.turnStartMs, undefined, "다음 턴을 위해 상태를 비운다");
});

t("F3 시작을 못 본 채 turn/completed 만 오면 줄을 만들지 않는다(창 경계)", () => {
  assert.deepEqual(appServerLines(N("turn/completed", { threadId: "th1", completedAtMs: 7100 }), {}).lines, []);
});

t("G1 모르는 method·item.type 은 조용히 무시한다(codex 가 항목을 늘려도 화면이 안 깨진다)", () => {
  assert.deepEqual(appServerLines(N("thread/tokenUsage/updated", { threadId: "th1" }), {}).lines, []);
  assert.deepEqual(appServerLines(done({ type: "webSearch", id: "w1", query: "x" }), {}).lines, []);
  assert.deepEqual(appServerLines(done({ type: "sleep", id: "s1", durationMs: 5 }), {}).lines, []);
});

t("G2 깨진 입력(문자열·null·params 없음)에도 안 터진다", () => {
  assert.deepEqual(appServerLines("not json", {}).lines, []);
  assert.deepEqual(appServerLines(null, {}).lines, []);
  assert.deepEqual(appServerLines({ jsonrpc: "2.0", method: "item/completed" }, {}).lines, []);
  assert.deepEqual(appServerLines(done({ type: "userMessage", id: "u", content: [] }), {}).lines, []);
});

console.log(`\n${pass} passed`);
