// App Server 이벤트 → ChatLine 계약 (#2055). 줄 원문은 전부 **실측**에서 딴 것(필드 축약만) —
//  codex-cli 0.149.1 로 initialize→thread/start→turn/start 를 돌려 받은 알림이다(지식 codex-app-server-spike-2055 §2).
//  ⚠ 이 파일은 하네스 바이너리 없이 돈다 — 형식 회귀는 여기서 잡고, 실바이너리 왕복은 별도(codex-app-server.e2e).
import assert from "node:assert/strict";
import { appServerLines, codexErrorText } from "./codex-app-server-events.js";
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

// ── 나머지 항목들(#2055 후속) — 실측 스키마의 ThreadItem 18종 중 사람이 읽을 것이 있는 것만 ────────
//  왜 표로 못박나: 안 옮기면 **아무 자국도 안 남는다**(빈 화면은 버그로 안 읽힌다). codex 는 계획을 세우고
//  웹을 뒤지고 맥락을 압축하는데, 그 사실이 화면에 하나도 없으면 사람은 "가만히 있는다"로 읽는다.

t("★ H1 plan → '할 일' 카드 — 글로 흘리지 않는다(한 말이 아니라 '지금 무엇을 하려는가'다)", () => {
  const { lines } = appServerLines(done({ type: "plan", id: "p1", text: "1. 파일 읽기\n2. 고치기" }), {});
  const use = (lines[0] as ChatAssistantLine).message.content[0] as any;
  assert.equal(use.type, "tool_use");
  assert.equal(use.name, "TodoWrite", "화면의 도구 분류기가 이미 아는 이름이어야 claude 세션과 같은 자리에 선다");
  const res = (lines[1] as ChatUserLine).message.content as any[];
  assert.equal(res[0].content, "1. 파일 읽기\n2. 고치기");
});

t("H2 빈 plan 은 줄을 만들지 않는다(빈 카드 금지)", () => {
  assert.deepEqual(appServerLines(done({ type: "plan", id: "p1", text: "  " }), {}).lines, []);
});

t("H3 webSearch → '웹 검색' 카드 · 결과는 제목 — 주소 한 줄씩", () => {
  const { lines } = appServerLines(done({ type: "webSearch", id: "w1", query: "codex app server", results: [{ title: "문서", url: "https://x/y" }] }), {});
  const use = (lines[0] as ChatAssistantLine).message.content[0] as any;
  assert.equal(use.name, "WebSearch");
  assert.deepEqual(use.input, { query: "codex app server" });
  assert.equal(((lines[1] as ChatUserLine).message.content as any[])[0].content, "문서 — https://x/y");
});

t("H4 dynamicToolCall 은 namespace 가 있으면 mcp__ 이름으로 — 화면이 MCP 도구로 알아본다", () => {
  const { lines } = appServerLines(done({ type: "dynamicToolCall", id: "d1", namespace: "lively", tool: "project_get", contentItems: [{ text: "결과" }], status: "completed" }), {});
  assert.equal(((lines[0] as ChatAssistantLine).message.content[0] as any).name, "mcp__lively__project_get");
});

t("H5 dynamicToolCall 실패는 실패로 — success:false 도 status 와 같은 뜻이다", () => {
  const { lines } = appServerLines(done({ type: "dynamicToolCall", id: "d1", tool: "t", contentItems: [{ text: "터짐" }], success: false }), {});
  assert.equal(((lines[1] as ChatUserLine).message.content as any[])[0].is_error, true);
});

t("★ H6 contextCompaction → system/compact — 화면의 '맥락 압축' 구분선이 읽는 바로 그 줄", () => {
  const { lines } = appServerLines(done({ type: "contextCompaction", id: "c1" }), {});
  const sys = lines[0] as ChatSystemLine;
  assert.equal(sys.type, "system");
  assert.equal(sys.subtype, "compact", "대화가 왜 갑자기 짧아졌는지의 유일한 설명이다");
});

t("H7 imageView → '읽기' 카드(경로) — 결과가 없으니 결과 줄도 없다(빈 말풍선 금지)", () => {
  const { lines } = appServerLines(done({ type: "imageView", id: "i1", path: "/a/b.png" }), {});
  assert.equal(lines.length, 1);
  assert.deepEqual(((lines[0] as ChatAssistantLine).message.content[0] as any).input, { file_path: "/a/b.png" });
});

t("G1 모르는 method·item.type 은 조용히 무시한다(codex 가 항목을 늘려도 화면이 안 깨진다)", () => {
  assert.deepEqual(appServerLines(N("thread/tokenUsage/updated", { threadId: "th1" }), {}).lines, []);
  assert.deepEqual(appServerLines(done({ type: "sleep", id: "s1", durationMs: 5 }), {}).lines, []);
  assert.deepEqual(appServerLines(done({ type: "subAgentActivity", id: "a1", kind: "x" }), {}).lines, []);
});

t("G2 깨진 입력(문자열·null·params 없음)에도 안 터진다", () => {
  assert.deepEqual(appServerLines("not json", {}).lines, []);
  assert.deepEqual(appServerLines(null, {}).lines, []);
  assert.deepEqual(appServerLines({ jsonrpc: "2.0", method: "item/completed" }, {}).lines, []);
  assert.deepEqual(appServerLines(done({ type: "userMessage", id: "u", content: [] }), {}).lines, []);
});

// ── 오류 알림 (#2055, 2026-08-27 프로덕션 실측) ──────────────────────────────────────────
//  사용자 신고: 첫 프롬프트 뒤 «10초쯤 생각중» 하다 세션이 갑자기 종료되고, 이어받기가 두 번 다 실패.
//  app-server 로그의 이유는 또렷했다 — `401 Unauthorized … wss://api.openai.com/v1/responses`
//  (그 홈에 auth.json 이 없었다 = 로그인 안 함). codex 는 정직하게 말했는데 **우리가 그 알림을 버려서**
//  화면엔 «작업 중» 만 남았다. 사람이 30초면 고칠 일을 «제품 고장» 으로 보게 만든 자리다.
t("★ E1 오류 알림은 **보이는 줄**로 남는다 — 삼키면 화면이 «작업 중» 에 갇힌다", () => {
  const { lines } = appServerLines(N("error", { message: "boom", codexErrorInfo: "other" }), {});
  assert.ok(lines.length >= 1);
  const e = lines[0] as ChatSystemLine;
  assert.equal(e.type, "system");
  assert.equal(e.subtype, "error");
  assert.match(String(e.text), /boom/);
});

t("★ E2 오류가 오면 턴도 끝난 것으로 알린다 — turn/completed 가 안 올 수 있다", () => {
  const { lines } = appServerLines(N("error", { message: "x" }), { turnStartMs: Date.now() - 1000 });
  assert.ok(lines.some((l) => (l as ChatSystemLine).subtype === "turn_duration"), "turn_duration 도 함께 낸다");
});

t("★ E3 401 은 «로그인이 필요합니다» 로 번역한다 — 그게 사용자가 다음에 할 일이다", () => {
  assert.match(codexErrorText({ codexErrorInfo: "unauthorized", message: "401" }), /로그인이 필요/);
  // 갈래를 못 받아도 상류 상태·원문으로 같은 결론에 닿아야 한다(실측 로그가 그 모양이었다).
  assert.match(codexErrorText({ message: "failed to connect: HTTP error: 401 Unauthorized" }), /로그인이 필요/);
  assert.match(codexErrorText({ codexErrorInfo: { httpStatusCode: 401 } }), /로그인이 필요/);
});

t("E4 아는 갈래는 각각의 안내로 — 한도·맥락·혼잡", () => {
  assert.match(codexErrorText({ codexErrorInfo: "usageLimitExceeded" }), /사용량 한도/);
  assert.match(codexErrorText({ codexErrorInfo: "contextWindowExceeded" }), /맥락 창/);
  assert.match(codexErrorText({ codexErrorInfo: "serverOverloaded" }), /혼잡/);
});

t("★ E5 모르는 갈래는 **원문을 그대로** 보여준다 — 지어내지 않는다", () => {
  const txt = codexErrorText({ codexErrorInfo: "somethingBrandNew", message: "unmapped detail" });
  assert.match(txt, /unmapped detail/);
});

t("E6 thread/realtime/error 도 같은 길로 온다", () => {
  const { lines } = appServerLines(N("thread/realtime/error", { threadId: "t", message: "rt down" }), {});
  assert.equal((lines[0] as ChatSystemLine).subtype, "error");
});

console.log(`\n${pass} passed`);
