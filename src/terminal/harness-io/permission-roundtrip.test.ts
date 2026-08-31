// 승인 왕복 계약 (#2439 ④) — **묻고 답하는 한 바퀴가 하네스마다 실제로 닫히나.**
//
//  ── 왜 이 테스트가 있나 ────────────────────────────────────────────────────────
//  이 프로젝트의 «반쪽 UX» 는 두 얼굴이었다: ① 기능이 없다 ② 있는 척하는데 안 닿는다.
//  ②가 여기서 나온다 — 카드는 뜨는데 누르면 아무 데도 안 가고, 그 턴은 TTL(10분)까지 선다.
//  그래서 «번역기가 permission.asked 를 낸다» 로는 부족하고, **그 답이 하네스가 알아듣는 모양으로
//  돌아가는지**까지 값으로 지킨다.
import assert from "node:assert/strict";
import { chatAdapter } from "./chat-adapters.js";
import { claudeStreamEvent } from "./claude-stream.js";
import { grokAcpEvent } from "./grok-stream.js";
import { opencodeEvent } from "./opencode-stream.js";
import { antigravityEvent } from "./antigravity-stream.js";
import type { PermissionAnswer, PermissionAsk, SessionEvent } from "./session-event.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const askOf = (ev: SessionEvent | null): PermissionAsk => {
  assert.ok(ev && ev.t === "permission.asked", `승인으로 번역돼야 한다 (실제: ${ev?.t})`);
  return (ev as Extract<SessionEvent, { t: "permission.asked" }>).ask;
};
const ALLOW: PermissionAnswer = { allow: true, scope: "once" };
const DENY: PermissionAnswer = { allow: false, scope: "once" };

t("[1] ★ claude — control_request{can_use_tool} → 카드 → **request_id 가 그대로 돌아간다**", () => {
  //  실측 모양(2.1.251).
  const ask = askOf(claudeStreamEvent({
    type: "control_request", request_id: "req_42",
    request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm test" } },
  }));
  assert.equal(ask.id, "req_42");
  assert.equal(ask.toolName, "Bash");
  assert.equal(ask.title, "npm test", "제목은 «무엇을 하려는가» 다");

  const line = chatAdapter("claude")!.respond!({ ask, value: ALLOW, convId: "c" })!;
  const out = JSON.parse(line) as any;
  assert.equal(out.type, "control_response");
  //  ⚠ 짝이 안 맞는 답은 «답이 없는 것» 과 같다 — 그 턴은 영영 선다.
  assert.equal(out.response.request_id, "req_42");
  assert.equal(out.response.response.behavior, "allow");

  const denied = JSON.parse(chatAdapter("claude")!.respond!({ ask, value: DENY, convId: "c" })!) as any;
  assert.equal(denied.response.response.behavior, "deny");
  assert.ok(denied.response.response.message, "거부에는 이유가 실려야 에이전트가 같은 것을 다시 안 시도한다");
});

t("[2] claude — «항상» 은 **하네스가 준 제안이 있을 때만** 실린다(규칙을 우리가 짓지 않는다)", () => {
  const bare = askOf(claudeStreamEvent({
    type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} },
  }));
  const a = JSON.parse(chatAdapter("claude")!.respond!({ ask: bare, value: { allow: true, scope: "always" }, convId: "c" })!) as any;
  assert.equal(a.response.response.updatedPermissions, undefined, "근거 없이 넓게 열지 않는다");

  const withSug = askOf(claudeStreamEvent({
    type: "control_request", request_id: "r2",
    request: { subtype: "can_use_tool", tool_name: "Bash", input: {}, permission_suggestions: [{ type: "addRules", rules: [] }] },
  }));
  const b = JSON.parse(chatAdapter("claude")!.respond!({ ask: withSug, value: { allow: true, scope: "always" }, convId: "c" })!) as any;
  assert.ok(Array.isArray(b.response.response.updatedPermissions), "제안이 있으면 그대로 돌려준다");
});

t("[3] ★ claude — 모르는 제어요청도 **카드가 된다**(삼키면 그 턴이 영영 선다)", () => {
  const ask = askOf(claudeStreamEvent({
    type: "control_request", request_id: "e1", request: { subtype: "elicitation", message: "계속할까요?" },
  }));
  assert.equal(ask.id, "e1");
  assert.equal(ask.title, "계속할까요?");
  assert.ok(chatAdapter("claude")!.respond!({ ask, value: DENY, convId: "c" }), "답할 길이 있다");
});

t("[4] ★ grok(ACP) — 요청의 id 에 **result 로** 답하고, optionId 는 하네스가 준 것 중 하나다", () => {
  const ask = askOf(grokAcpEvent({
    jsonrpc: "2.0", id: 7, method: "session/request_permission",
    params: {
      sessionId: "s1",
      toolCall: { title: "echo hi", kind: "execute", rawInput: { command: "echo hi" } },
      options: [
        { optionId: "o-allow", name: "허용", kind: "allow_once" },
        { optionId: "o-always", name: "항상", kind: "allow_always" },
        { optionId: "o-no", name: "거부", kind: "reject_once" },
      ],
    },
  }));
  assert.equal(ask.id, "7");
  assert.equal(ask.title, "echo hi");

  const ok = JSON.parse(chatAdapter("grok")!.respond!({ ask, value: ALLOW, convId: "s1" })!) as any;
  assert.equal(ok.id, 7, "JSON-RPC 는 **숫자 id** 로 짝짓는다 — 문자열로 답하면 안 닿는다");
  assert.equal(ok.result.outcome.outcome, "selected");
  assert.equal(ok.result.outcome.optionId, "o-allow");

  const always = JSON.parse(chatAdapter("grok")!.respond!({ ask, value: { allow: true, scope: "always" }, convId: "s1" })!) as any;
  assert.equal(always.result.outcome.optionId, "o-always");
  const no = JSON.parse(chatAdapter("grok")!.respond!({ ask, value: DENY, convId: "s1" })!) as any;
  assert.equal(no.result.outcome.optionId, "o-no");
});

t("[5] ★ grok — 고를 것이 없으면 **취소로 답한다**(지어낸 optionId 는 튕겨서 턴이 선다)", () => {
  const ask: PermissionAsk = { id: "9", toolName: "execute", suggestions: [] };
  const out = JSON.parse(chatAdapter("grok")!.respond!({ ask, value: ALLOW, convId: "s" })!) as any;
  assert.equal(out.result.outcome.outcome, "cancelled", "답을 안 하는 것보다 취소가 낫다");
});

t("[6] opencode — 승인은 **REST** 라 표에는 줄이 없다(런타임이 Entry.respond 를 꽂는다)", () => {
  const ev = opencodeEvent({ type: "permission.asked", properties: {
    id: "p1", sessionID: "ses_1", permission: { type: "bash", pattern: "npm *" },
  } });
  const ask = askOf(ev);
  assert.equal(ask.id, "p1");
  //  ⚠ 표에 respond 가 없다 ≠ 답할 길이 없다. 그 사실을 계약으로 못 박는다.
  assert.equal(chatAdapter("opencode")!.respond ?? null, null);
});

t("[7] ★ antigravity — 도구 실행 step 이 **작업**이 된다(실측 1.1.22)", () => {
  const started = antigravityEvent({ event: "step_update", step_update: {
    conversation_id: "c9", step_index: 2, state: "ACTIVE", step_type: "tool",
    tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo HELLO" } },
  } });
  assert.ok(started && started.t === "task.started", `작업 시작이어야 한다 (${started?.t})`);
  const task = (started as Extract<SessionEvent, { t: "task.started" }>).task;
  assert.equal(task.id, "c9#2", "대화 id 를 앞에 붙인다 — step_index 는 대화마다 0부터 다시 시작한다");
  assert.equal(task.kind, "shell");
  assert.equal(task.title, "echo HELLO");
  assert.equal(task.status, "running");

  const done = antigravityEvent({ event: "step_update", step_update: {
    conversation_id: "c9", step_index: 2, state: "DONE", step_type: "tool", duration_seconds: 1.6,
    tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo HELLO" }, output: "HELLO\n" },
  } });
  assert.ok(done && done.t === "task.updated", `작업 갱신이어야 한다 (${done?.t})`);
  const up = done as Extract<SessionEvent, { t: "task.updated" }>;
  assert.equal(up.id, "c9#2", "★ 시작과 **같은 id** 여야 짝이 맞는다(다르면 유령 행이 생긴다)");
  assert.equal(up.patch.status, "completed");
});

t("[8] ★ 카드를 그리는 하네스는 **전부 답할 길이 있다** — 없으면 그 턴이 TTL 까지 선다", () => {
  //  파이프로 답하는 하네스(표의 respond)와, 런타임이 직접 쥐는 하네스(REST·전용 런타임)로 갈린다.
  //  후자는 그 사실을 note 에 적었는지까지 본다(다음 사람이 «빠뜨렸나» 를 의심하지 않게).
  const byRuntime = new Set(["opencode", "codex", "antigravity"]);
  for (const key of ["claude", "grok", "opencode", "codex", "antigravity"]) {
    const a = chatAdapter(key)!;
    if (byRuntime.has(key)) {
      assert.ok(a.note.length > 20, `${key} 는 왜 표에 respond 가 없는지 note 가 있어야 한다`);
      continue;
    }
    assert.ok(a.respond, `${key} 는 표에서 답할 길이 있어야 한다`);
  }
});

t("[9] 멈춤 — 파이프로 멈추는 하네스는 그 줄이 규약을 지킨다", () => {
  const c = JSON.parse(chatAdapter("claude")!.interrupt!({ convId: "x" })!) as any;
  assert.equal(c.type, "control_request");
  assert.equal(c.request.subtype, "interrupt");
  const g = JSON.parse(chatAdapter("grok")!.interrupt!({ convId: "s1" })!) as any;
  assert.equal(g.method, "session/cancel");
  assert.equal(g.id, undefined, "★ 알림이다(id 가 있으면 상대가 응답을 기다린다)");
  //  세션 id 를 모르면 **안 보낸다** — 엉뚱한 세션을 멈추지 않는다.
  assert.equal(chatAdapter("grok")!.interrupt!({ convId: "" }), null);
});

t("[10] ★ claude argv 에 --permission-prompt-tool stdio 가 있다 — 없으면 물음이 **한 번도 안 온다**", () => {
  //  근거는 바이너리 자신의 설명이다(2.1.251):
  //   "--permission-prompt-tool (permission prompts reach the host over stdio; an MCP tool cannot answer them here)"
  //  이 플래그가 빠지면 승인 카드는 영영 안 뜬다 — 코드 어디에도 오류가 안 나므로 눈으로는 못 잡는다.
  const argv = chatAdapter("claude")!.argv!({});
  const i = argv.indexOf("--permission-prompt-tool");
  assert.ok(i >= 0, "플래그가 있다");
  assert.equal(argv[i + 1], "stdio", "값은 stdio — MCP 도구 이름을 주면 CLI 가 거부한다");
});

console.log(`\n${pass}건 통과`);
