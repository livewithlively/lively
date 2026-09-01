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
import { antigravityCommandsFromHelp, antigravityEvent } from "./antigravity-stream.js";
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

t("[1-b] ★ **실측 봉투 그대로**(2.1.251, Write 한 번을 실제로 받아 뜬 것)", () => {
  //  ⚠ 이 봉투를 얻기까지 헛짚었다: `echo` 로 시험하면 claude 가 **안전한 명령이라 자동 허용**해
  //   물음이 안 온다(공식 SDK 의 canUseTool 도 같은 환경에서 0건이었다 — 오라클로 확인).
  //   승인을 시험할 땐 **권한이 필요한 동작**(Write·rm·네트워크)을 시켜야 한다.
  const ask = askOf(claudeStreamEvent({
    type: "control_request", request_id: "a5386ace-0145-4ac9-8f61-8ce9ebb28227",
    request: {
      subtype: "can_use_tool", tool_name: "Write", display_name: "Write",
      input: { file_path: "/tmp/ours2.txt", content: "HELLO\n" },
      description: "ours2.txt",
      permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      tool_use_id: "toolu_01UvcEp5NrFmzCNoizhwsdR4",
    },
  }));
  assert.equal(ask.id, "a5386ace-0145-4ac9-8f61-8ce9ebb28227");
  assert.equal(ask.toolName, "Write");
  assert.equal(ask.displayName, "Write");
  //  ⚠ 필드 이름은 `description` 이다 — 종전엔 `reason` 만 읽어 카드의 «왜» 가 늘 비었다.
  assert.equal(ask.description, "ours2.txt");
  assert.equal(ask.title, "/tmp/ours2.txt", "제목은 «무엇을 하려는가» — 파일 경로");
  assert.ok(Array.isArray(ask.suggestions) && ask.suggestions.length === 1, "«항상 허용» 근거가 실려 온다");

  //  응답은 SDK 타입 PermissionResult 와 **같은 자리**여야 한다: allow → updatedInput·updatedPermissions.
  const out = JSON.parse(chatAdapter("claude")!.respond!({ ask, value: { allow: true, scope: "always" }, convId: "c" })!) as any;
  assert.equal(out.response.request_id, ask.id);
  assert.equal(out.response.response.behavior, "allow");
  assert.deepEqual(out.response.response.updatedPermissions, ask.suggestions);
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

t("[11] ★★ 선택지(AskUserQuestion) — 질문으로 알아보고 **고른 값**으로 답한다", () => {
  //  ⚠ 이것이 상민님이 계속 신고한 그 «선택지» 다. 도구 승인이 아니라 **질문**인데, claude 는 둘 다
  //   can_use_tool 로 보낸다(공식 문서 "Handle approvals and user input"). 승인으로 그리면
  //   [허용] 을 눌러도 답이 안 채워져 툴이 "The user did not answer the questions" 로 끝난다.
  const ask = askOf(claudeStreamEvent({
    type: "control_request", request_id: "q-1",
    request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [
      { question: "딸기랑 사과 중에 뭐가 더 좋으세요?", header: "과일 선택", multiSelect: false,
        options: [{ label: "딸기", description: "달고 향이 강합니다" }, { label: "사과", description: "아삭합니다" }] },
    ] } },
  }));
  assert.equal(ask.toolName, "AskUserQuestion");
  assert.ok(ask.questions && ask.questions.length === 1, "질문으로 알아본다");
  assert.equal(ask.questions![0].options.length, 2);
  assert.equal(ask.title, "딸기랑 사과 중에 뭐가 더 좋으세요?");

  //  ★ 답은 «허용» 이 아니라 answers 다 — 키는 **질문 전문**, 값은 고른 label(문서 규약).
  const line = chatAdapter("claude")!.respond!({
    ask, convId: "c",
    value: { allow: true, scope: "once", answers: { "딸기랑 사과 중에 뭐가 더 좋으세요?": "사과" } },
  })!;
  const out = JSON.parse(line) as any;
  assert.equal(out.response.request_id, "q-1");
  assert.equal(out.response.response.behavior, "allow");
  //  ⚠ questions 를 안 실으면 툴이 처리하지 못한다(문서: "required for tool processing").
  assert.deepEqual(out.response.response.updatedInput.questions, ask.questions);
  assert.deepEqual(out.response.response.updatedInput.answers, { "딸기랑 사과 중에 뭐가 더 좋으세요?": "사과" });

  //  건너뛰기 = 거부로 보낸다 — 에이전트가 «답 안 함» 을 알고 다음 수를 정한다.
  const skip = JSON.parse(chatAdapter("claude")!.respond!({ ask, value: { allow: false }, convId: "c" })!) as any;
  assert.equal(skip.response.response.behavior, "deny");
});

t("[12] 옵션 없는 질문은 **질문으로 안 본다** — 고를 것이 없는 카드는 막다른 길이다", () => {
  const ev = claudeStreamEvent({
    type: "control_request", request_id: "q-2",
    request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "음?", options: [] }] } },
  });
  const ask = askOf(ev);
  assert.equal(ask.questions, undefined, "평범한 승인으로 되돌아간다(있는 척하지 않는다)");
});

t("[13] ★★ grok 선택지 — 실측 봉투 그대로(1.0.13, 2026-09-01 실제로 답해 성공)", () => {
  //  요청 원문:
  //   {"jsonrpc":"2.0","id":0,"method":"_x.ai/ask_user_question","params":{sessionId,toolCallId,
  //     questions:[{question,options:[{label,description}],multiSelect:null}],mode:"default"}}
  const ask = askOf(grokAcpEvent({
    jsonrpc: "2.0", id: 0, method: "_x.ai/ask_user_question",
    params: { sessionId: "s1", toolCallId: "call-1", mode: "default", questions: [
      { question: "딸기와 사과 중 어느 것이 더 좋습니까?", multiSelect: null,
        options: [{ label: "딸기", description: "딸기가 더 좋다고 선택합니다." },
                  { label: "사과", description: "사과가 더 좋다고 선택합니다." }] },
    ] },
  }));
  assert.equal(ask.id, "0");
  assert.ok(ask.questions && ask.questions.length === 1, "선택지로 알아본다");
  assert.equal(ask.questions![0].options.length, 2);
  //  ⚠ grok 은 multiSelect 를 **null** 로 보낸다 — 참으로 접으면 안 된다.
  assert.equal(ask.questions![0].multiSelect, false);

  const out = JSON.parse(chatAdapter("grok")!.respond!({
    ask, convId: "s1",
    value: { allow: true, answers: { "딸기와 사과 중 어느 것이 더 좋습니까?": "사과" } },
  })!) as any;
  assert.equal(out.id, 0, "JSON-RPC 는 숫자 id 로 짝짓는다");
  //  ⚠ outcome 은 **문자열** 이어야 한다 — map 이면 "expected variant identifier" 로 튕긴다(실측).
  assert.equal(out.result.outcome, "accepted");
  assert.deepEqual(out.result.answers, { "딸기와 사과 중 어느 것이 더 좋습니까?": "사과" });

  const skip = JSON.parse(chatAdapter("grok")!.respond!({ ask, value: { allow: false }, convId: "s1" })!) as any;
  assert.equal(skip.result.outcome, "skip_interview", "건너뛰기는 그 하네스의 낱말로");
});

t("[14] ★ id 0 이 문자열로 새지 않는다 — grok 의 첫 요청 id 가 실제로 0 이었다", () => {
  //  ⚠ `Number(x) || x` 로 쓰면 0 이 falsy 라 문자열로 샌다. 그러면 짝이 안 맞아 그 요청은
  //   영영 답을 못 받고, 사람은 «선택지를 눌렀는데 아무 일도 안 난다» 를 겪는다.
  const ask: PermissionAsk = { id: "0", toolName: "AskUserQuestion",
    questions: [{ question: "Q", options: [{ label: "A" }] }] };
  const out = JSON.parse(chatAdapter("grok")!.respond!({ ask, value: { allow: true, answers: { Q: "A" } }, convId: "s" })!) as any;
  assert.strictEqual(out.id, 0, "숫자 0 그대로");
  //  숫자가 아닌 id 는 문자열 그대로 둔다(하네스가 uuid 를 쓸 수도 있다).
  const uuid: PermissionAsk = { ...ask, id: "a5386ace-0145" };
  const out2 = JSON.parse(chatAdapter("grok")!.respond!({ ask: uuid, value: { allow: true }, convId: "s" })!) as any;
  assert.strictEqual(out2.id, "a5386ace-0145");
});

t("[15] grok 사용량 — 턴 응답의 _meta 와 한도 오류(실측 1.0.13)", () => {
  const u = grokAcpEvent({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn",
    _meta: { sessionId: "s", modelId: "grok-4.6", totalTokens: 24730, inputTokens: 24488, outputTokens: 242 } } });
  assert.ok(u && u.t === "usage", `사용량이어야 한다 (${u?.t})`);
  const usage = (u as Extract<SessionEvent, { t: "usage" }>).usage;
  assert.equal(usage.inputTokens, 24488);
  assert.equal(usage.outputTokens, 242);

  //  ⚠ 한도는 **오류로** 온다 — 버리면 화면이 «왜 답이 안 오나» 를 영영 못 말한다.
  const lim = grokAcpEvent({ jsonrpc: "2.0", id: 3, error: { code: -32003, message: "Rate limited",
    data: { message: "subscription:free-usage-exhausted: … tokens (actual/limit): 502001/500000. Upgrade" } } });
  assert.ok(lim && lim.t === "usage", `한도도 사용량 축이다 (${lim?.t})`);
  const util = (lim as Extract<SessionEvent, { t: "usage" }>).usage.utilization ?? {};
  assert.ok((util.limit ?? 0) > 1, "다 썼다는 사실이 값으로 온다");

  //  ★ 초기화 응답이 사용량으로 **잘못 읽히지 않는다**(같은 result 자리라 순서가 중요하다).
  const init = grokAcpEvent({ jsonrpc: "2.0", id: 1, result: { agentCapabilities: {}, authMethods: [],
    _meta: { modelState: { currentModelId: "grok-4.6" } } } });
  assert.ok(init && init.t === "facts", `초기화는 facts 다 (${init?.t})`);
});

t("[16] antigravity 슬래시 목록 — /help 출력 그대로 파싱(실측 1.1.22)", () => {
  //  실측 원문(탭 구분):
  const help = [
    "/agents\tList available custom agents",
    "/changelog\tShow release notes and changes",
    "/config (settings)\tOpen settings panel",
    "/credits\tShow remaining G1 credits and purchase link",
    "/model\tSet a model",
  ].join("\n");
  const cs = antigravityCommandsFromHelp(help);
  assert.equal(cs.length, 5);
  assert.deepEqual(cs.map((c) => c.name), ["agents", "changelog", "config", "credits", "model"]);
  assert.equal(cs[4].description, "Set a model");
  //  ⚠ 별칭 괄호가 이름에 섞이지 않는다("/config (settings)" → "config").
  assert.equal(cs[2].name, "config");
  //  형식이 바뀌면 **빈 배열** — 있는 척하지 않는다(화면은 목록 없이 그대로 산다).
  assert.deepEqual(antigravityCommandsFromHelp("도움말을 찾을 수 없습니다"), []);
  assert.deepEqual(antigravityCommandsFromHelp(""), []);
});

console.log(`\n${pass}건 통과`);
