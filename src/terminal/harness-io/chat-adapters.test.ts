// 대화 어댑터 표 계약 (#2439) — **5 하네스가 모든 축을 답한다. null 도 답이다.**
//
//  이 레포의 규율 그대로다(catalog.ts · harness-registry.mjs · harness-io/adapter.ts):
//  축을 늘리면 모든 하네스가 그 축을 채워야 «빠진 자리» 가 조용히 생기지 않는다.
//  여섯 번째 하네스가 오면 여기서 먼저 빨간불이 난다.
import assert from "node:assert/strict";
import { CHAT_ADAPTERS, canOpenChatRuntime, chatAdapter } from "./chat-adapters.js";
import { HARNESS_IO } from "./adapter.js";
import { harnessSupportsChat } from "../session-runtime-mode.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("[1] 우리가 지원한다고 말한 하네스가 **전부** 이 표에 있다(shell 제외 — AI 가 아니다)", () => {
  const io = HARNESS_IO.map((a) => a.key).filter((k) => k !== "shell");
  for (const k of io) assert.ok(chatAdapter(k), `${k} 가 대화 어댑터 표에 있다`);
  assert.equal(CHAT_ADAPTERS.length, io.length, "표에 유령 항목이 없다");
});

t("[2] 모든 하네스가 모든 축을 **명시**한다 — 미실측은 null 로 답한다", () => {
  for (const a of CHAT_ADAPTERS) {
    assert.ok(a.key && a.label, `${a.key} 신원`);
    assert.ok(a.transport === null || ["stdio-jsonl", "jsonrpc-stdio", "http-sse"].includes(a.transport), `${a.key} transport`);
    //  ★ 왜 이 상태인가를 반드시 적는다 — 다음 사람이 «안 했다» 와 «못 한다» 를 구분해야 한다.
    assert.ok(a.note && a.note.length > 20, `${a.key} note 가 이유를 말한다`);
    //  전송이 없으면 나머지도 없어야 한다(반쪽 선언 금지).
    if (a.transport === null) {
      assert.equal(a.argv, null, `${a.key}: 전송이 없는데 argv 가 있다`);
      assert.equal(a.translate, null, `${a.key}: 전송이 없는데 translate 가 있다`);
    }
    //  ★ 전용 런타임이 쥔 하네스는 argv 를 갖지 않는다 — 두 자리가 같은 프로세스를 띄우면 대화가 둘로 갈린다.
    if (a.runsVia) assert.equal(a.argv, null, `${a.key}: ${a.runsVia} 가 쥐는데 표에도 argv 가 있다`);
  }
});

t("[3] ★ 번역기 없는 하네스는 chat 모드가 **안 열린다** — 빈 화면을 만들지 않는다", () => {
  for (const a of CHAT_ADAPTERS) {
    const open = canOpenChatRuntime(a.key);
    //  여는 길은 둘이다: 이 표가 직접 띄우거나(stdio-jsonl+argv+encode), 전용 런타임이 쥐거나(runsVia).
    if (open) assert.ok(a.translate && (a.runsVia || (a.argv && a.encode)), `${a.key}: 연다면 번역 + (런타임|argv) 가 있어야 한다`);
    else assert.ok(!a.translate || !(a.runsVia || (a.argv && a.encode)),
      `${a.key}: 못 여는 이유가 있다(번역기 부재 또는 전송 왕복 미실측)`);
  }
});

t("[4] ★ 모드 판정이 이 표에서 **파생**된다 — 두 곳에 적으면 반드시 갈린다", () => {
  for (const a of CHAT_ADAPTERS) {
    assert.equal(harnessSupportsChat(a.key), canOpenChatRuntime(a.key), `${a.key} 모드↔표 일치`);
  }
  assert.equal(harnessSupportsChat("모르는하네스"), false, "모르는 key 는 claude 로 추측하지 않는다");
});

t("[5] 지금 실제로 열리는 것 — claude·codex(나머지는 왜 아닌지 note 가 말한다)", () => {
  const open = CHAT_ADAPTERS.filter((a) => canOpenChatRuntime(a.key)).map((a) => a.key);
  assert.deepEqual(open, ["claude", "codex"]);
  //  ⚠ 이 단언은 **진도를 재는 자리**다. codex·grok·opencode 가 열리면 여기서 빨간불이 나고,
  //   그때 이 목록을 늘리면서 «무엇이 실측됐나» 를 함께 갱신하게 된다.
  assert.equal(chatAdapter("codex")!.runsVia, "codex-chat-runtime", "codex 기동은 전용 런타임이 쥔다");
  assert.equal(chatAdapter("grok")!.transport, "jsonrpc-stdio", "grok 은 ACP");
  //  ★ grok 은 **번역기가 있는데도 안 열린다** — encode(사람 말 → session/prompt 왕복)가 미실측이라서다.
  //   «번역만 있으면 열린다» 로 뭉뚱그리면 말을 걸 수 없는 세션이 열린다.
  assert.ok(chatAdapter("grok")!.translate, "grok facts 축은 실측으로 채워졌다");
  assert.equal(chatAdapter("grok")!.encode, null, "grok 은 보내는 쪽 왕복이 아직 미실측");
  assert.equal(chatAdapter("opencode")!.transport, "http-sse", "opencode 는 serve 경로");
  //  ⭐ opencode 만은 서버화가 **기능을 새로 연다** — 지금까지 대화 읽기가 구조적으로 없었다(#1884 §2 #35).
  assert.ok(chatAdapter("opencode")!.translate, "opencode 승인·명령 축은 OpenAPI 실측으로 채워졌다");
  assert.equal(chatAdapter("opencode")!.argv, null, "서버를 띄우고 포트로 붙는 방식이라 argv 축이 다르다");
  //  ⚠ 「전송 미확정」은 **내 호출 형식 실수**였다(--print "x" 가 아니라 --print=x). 1.1.22 로 재측정해 정정.
  assert.equal(chatAdapter("antigravity")!.transport, "stdio-jsonl", "agy stream-json 은 실제로 동작한다");
  assert.ok(chatAdapter("antigravity")!.translate, "init·step_update·result 를 옮긴다");
  assert.equal(chatAdapter("antigravity")!.encode, null, "다중 턴 왕복 미실측 — 한 번에 한 프롬프트 형태다");
});

t("[6b] grok 번역기 — 핸드셰이크 실측분을 옮긴다(못 잰 것은 raw 로 관측한다)", () => {
  const tr = chatAdapter("grok")!.translate!;
  //  실측 원문(grok 1.0.13, 2026-08-31 핸드셰이크): initialize 응답
  const init = tr({ jsonrpc: "2.0", id: 1, result: {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {} } },
    authMethods: [{ id: "grok.com", name: "Grok" }],
    _meta: { modelState: { currentModelId: "grok-4.6" }, agentVersion: "1.0.13" },
  } });
  assert.equal(init?.t, "facts");
  assert.equal((init as any).facts.model, "grok-4.6");
  //  ⚠ authMethods 가 남아 있다 = 아직 로그인 안 됐다. 화면이 그 사실을 말할 근거다(빈 화면 금지).
  assert.equal((init as any).facts.permissionMode, "needs-auth");
  //  실측 원문: MCP 목록 알림
  const mcp = tr({ jsonrpc: "2.0", method: "_x.ai/mcp/servers_updated", params: { mcpServers: [] } });
  assert.equal(mcp?.t, "facts");
  assert.deepEqual((mcp as any).facts.mcpServers, []);
  //  실측 원문: 인증 필요 오류 — 조용히 삼키지 않는다(사람이 왜 답이 없는지 알아야 한다)
  const err = tr({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "Authentication required" } });
  assert.equal((err as any).facts.permissionMode, "needs-auth");
  //  ★ 못 잰 것(턴 이벤트)은 raw 로 올려 관측한다 — 짐작해서 채우지 않는다.
  assert.equal(tr({ jsonrpc: "2.0", method: "session/update", params: { x: 1 } })?.t, "raw");
});

t("[6d] antigravity 번역기 — 재측정으로 정정한 축(내 호출 형식이 틀렸었다)", () => {
  const tr = chatAdapter("antigravity")!.translate!;
  //  실측 원문(agy 1.1.22, --print=… --output-format=stream-json)
  const init = tr({ event: "init", conversation_id: "c1", init: { cwd: "/x", tools: ["ask_permission", "bash"], permission_mode: "default" } });
  assert.equal(init?.t, "facts");
  assert.equal((init as any).facts.permissionMode, "default");
  //  tools 는 57개까지 온다 — 여기서 자르면 «몇 개인지» 를 잃는다. 접는 일은 화면 몫.
  assert.equal((init as any).facts.skills.length, 2);
  //  사용량이 실린 step 은 usage 로
  const u = tr({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", usage: { input_tokens: 36985, output_tokens: 13 } } });
  assert.equal(u?.t, "usage");
  assert.equal((u as any).usage.inputTokens, 36985);
  //  대화 본문은 ChatLine 축
  assert.equal(tr({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "OK" } }), null);
  //  ★ 미실측 step_type(툴 실행·승인)은 짐작해 작업으로 만들지 않고 raw 로 관측한다
  assert.equal(tr({ event: "step_update", step_update: { step_type: "tool_call" } })?.t, "raw");
  assert.equal(tr({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 1, output_tokens: 2 } } })?.t, "usage");
});

t("[6c] opencode 번역기 — OpenAPI 실측분(승인·명령)을 옮긴다", () => {
  const tr = chatAdapter("opencode")!.translate!;
  //  실측 스키마(1.18.25): EventPermissionAsked{ id, type, properties:{id,sessionID,permission,patterns,metadata,always} }
  const ask = tr({ type: "permission.asked", properties: {
    id: "p1", sessionID: "s1", permission: { type: "bash", title: "rm -rf x" }, patterns: ["rm *"],
  } });
  assert.equal(ask?.t, "permission.asked");
  assert.equal((ask as any).ask.id, "p1");
  assert.equal((ask as any).ask.toolName, "bash");
  //  «항상 허용» 재료를 그대로 싣는다(내용을 해석하지 않는다).
  assert.deepEqual((ask as any).ask.suggestions, ["rm *"]);
  assert.equal(tr({ type: "permission.replied", properties: { id: "p1" } })?.t, "permission.resolved");
  //  실측 스키마: EventCommandExecuted{ properties:{name,sessionID,arguments,messageID} }
  const cmd = tr({ type: "command.executed", properties: { name: "npm", arguments: ["test"], messageID: "m1" } });
  assert.equal(cmd?.t, "task.started");
  assert.equal((cmd as any).task.kind, "shell");
  assert.equal((cmd as any).task.title, "npm test");
  //  대화 본문은 ChatLine 축 · 모르는 것은 raw
  assert.equal(tr({ type: "message.part.updated", properties: {} }), null);
  assert.equal(tr({ type: "future.thing", properties: {} })?.t, "raw");
});

t("[6] codex 번역기는 실제로 무언가를 옮긴다(표에 달아 놓고 빈 함수를 두지 않는다)", () => {
  const tr = chatAdapter("codex")!.translate!;
  const started = tr({ method: "item/started", params: { item: { type: "commandExecution", id: "c1", command: ["npm", "test"], status: "inProgress" } } });
  assert.equal(started?.t, "task.started");
  assert.equal((started as any).task.kind, "shell");
  assert.equal((started as any).task.title, "npm test");
  const ask = tr({ method: "item/commandExecution/requestApproval", params: { approvalId: "a1", command: ["rm", "-rf", "x"], reason: "위험" } });
  assert.equal(ask?.t, "permission.asked");
  assert.equal((ask as any).ask.id, "a1");
  //  모르는 것은 버리지 않는다(★2).
  assert.equal(tr({ method: "some/future/thing" })?.t, "raw");
  //  대화 축은 null(그건 ChatLine 이 그린다).
  assert.equal(tr({ method: "item/agentMessage/delta", params: { delta: "hi" } }), null);
});

console.log(`\n${pass}건 통과`);
