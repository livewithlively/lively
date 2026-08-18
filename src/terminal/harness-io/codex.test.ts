// codex rollout 파서 계약 (#1759) — 사양·엣지 표: 스크래치 spec.md "codex read 축"(실측 box-yoon-355e7d10 파일).
//  줄 원문은 전부 실측 rollout 에서 딴 것(필드 축약만) — 지어내지 않는다.
import assert from "node:assert/strict";
import { parseCodex } from "./codex.js";
import type { ChatAssistantLine, ChatSystemLine, ChatUserLine } from "./chat-line.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const L = (o: unknown): string => JSON.stringify(o);

t("E1 user_message → user 줄(사람 말의 정본 채널)", () => {
  const { lines } = parseCodex(L({ timestamp: "2026-08-18T11:11:07.007Z", type: "event_msg", payload: { type: "user_message", message: "현재 폴더에서 ls -la 를 실행해서 보여줘", images: [] } }) + "\n", {});
  assert.equal(lines.length, 1);
  const u = lines[0] as ChatUserLine;
  assert.equal(u.type, "user");
  assert.equal(u.message.content, "현재 폴더에서 ls -la 를 실행해서 보여줘");
  assert.equal(u.timestamp, "2026-08-18T11:11:07.007Z");
});

t("E2 response_item message role=assistant output_text → assistant text", () => {
  const { lines } = parseCodex(L({ timestamp: "2026-08-18T11:11:23.000Z", type: "response_item", payload: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "배달확인" }] } }) + "\n", {});
  assert.equal(lines.length, 1);
  const a = lines[0] as ChatAssistantLine;
  assert.equal(a.type, "assistant");
  assert.deepEqual(a.message.content, [{ type: "text", text: "배달확인" }]);
});

t("E3 role=developer·user 의 response_item message 는 버린다(주입·중복 채널)", () => {
  const text = [
    L({ timestamp: "t", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>..." }] } }),
    L({ timestamp: "t", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions ..." }] } }),
  ].join("\n") + "\n";
  assert.equal(parseCodex(text, {}).lines.length, 0);
});

t("E4 event_msg agent_message 는 버린다(assistant response_item 과 중복)", () => {
  const { lines } = parseCodex(L({ timestamp: "t", type: "event_msg", payload: { type: "agent_message", message: "현재 작업 폴더의 숨김 파일까지 확인하겠습니다.", phase: "commentary" } }) + "\n", {});
  assert.equal(lines.length, 0);
});

t("E5 custom_tool_call → assistant tool_use(id=call_id·name·input 보존)", () => {
  const { lines } = parseCodex(L({ timestamp: "t", type: "response_item", payload: { type: "custom_tool_call", id: "ctc_1", call_id: "call_gzfG", name: "exec", input: "const r = await tools.exec_command({\"cmd\":\"ls -la\"});" } }) + "\n", {});
  const a = lines[0] as ChatAssistantLine;
  assert.equal(a.type, "assistant");
  const b = a.message.content[0] as { type: string; id: string; name: string; input: unknown };
  assert.equal(b.type, "tool_use");
  assert.equal(b.id, "call_gzfG");
  assert.equal(b.name, "exec");
  assert.match(String(b.input), /ls -la/);
});

t("E6 custom_tool_call_output → user tool_result(output[].text 이어붙임)", () => {
  const { lines } = parseCodex(L({ timestamp: "t", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_gzfG", output: [{ type: "input_text", text: "Script completed\n" }, { type: "input_text", text: "total 48\n" }] } }) + "\n", {});
  const u = lines[0] as ChatUserLine;
  assert.equal(u.type, "user");
  const b = (u.message.content as Array<{ type: string; tool_use_id: string; content: string }>)[0];
  assert.equal(b.type, "tool_result");
  assert.equal(b.tool_use_id, "call_gzfG");
  assert.equal(b.content, "Script completed\ntotal 48\n");
});

t("E7 task_started→task_complete → turn_duration(durationMs=시각차) · 시작 줄 자체는 화면에 안 낸다", () => {
  const text = [
    L({ timestamp: "2026-08-18T11:10:58.598Z", type: "event_msg", payload: { type: "task_started", turn_id: "01a01491" } }),
    L({ timestamp: "2026-08-18T11:11:23.470Z", type: "event_msg", payload: { type: "task_complete", turn_id: "01a01491", last_agent_message: "..." } }),
  ].join("\n") + "\n";
  const { lines } = parseCodex(text, {});
  assert.equal(lines.length, 1);
  const s = lines[0] as ChatSystemLine;
  assert.equal(s.subtype, "turn_duration");
  assert.equal(s.durationMs, Date.parse("2026-08-18T11:11:23.470Z") - Date.parse("2026-08-18T11:10:58.598Z"));
});

t("E8 task_complete 만(창 경계로 짝 잃음) → durationMs 없이 turn_duration", () => {
  const { lines } = parseCodex(L({ timestamp: "2026-08-18T11:11:23.470Z", type: "event_msg", payload: { type: "task_complete", turn_id: "x" } }) + "\n", {});
  const s = lines[0] as ChatSystemLine;
  assert.equal(s.subtype, "turn_duration");
  assert.equal(s.durationMs, undefined);
});

t("E9 미지 줄(session_meta·token_count·reasoning)·깨진 JSON 은 무시하고 죽지 않는다", () => {
  const text = [
    L({ timestamp: "t", type: "session_meta", payload: { session_id: "01a01491", cwd: "/w" } }),
    L({ timestamp: "t", type: "event_msg", payload: { type: "token_count", info: {} } }),
    L({ timestamp: "t", type: "response_item", payload: { type: "reasoning", encrypted_content: "gAAAA" } }),
    "{깨진 json",
    L({ timestamp: "t", type: "event_msg", payload: { type: "user_message", message: "살아있나" } }),
  ].join("\n") + "\n";
  const { lines } = parseCodex(text, {});
  assert.equal(lines.length, 1);
  assert.equal((lines[0] as ChatUserLine).message.content, "살아있나");
});

t("E10 빈 message·공백 output_text 는 줄을 만들지 않는다", () => {
  const text = [
    L({ timestamp: "t", type: "event_msg", payload: { type: "user_message", message: "  " } }),
    L({ timestamp: "t", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: " " }] } }),
  ].join("\n") + "\n";
  assert.equal(parseCodex(text, {}).lines.length, 0);
});

t("E11 thread_settings_applied.model → 이후 assistant 줄의 model 칩", () => {
  const text = [
    L({ timestamp: "t", type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-5.6-terra" } } }),
    L({ timestamp: "t", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "안녕" }] } }),
  ].join("\n") + "\n";
  const { lines } = parseCodex(text, {});
  assert.equal((lines[0] as ChatAssistantLine).message.model, "gpt-5.6-terra");
});

t("E12 창 이어 읽기 — task_started 가 앞 창에 있어도 state 로 durationMs 가 이어진다", () => {
  const w1 = parseCodex(L({ timestamp: "2026-08-18T11:10:58.598Z", type: "event_msg", payload: { type: "task_started" } }) + "\n", {});
  assert.equal(w1.lines.length, 0);
  const w2 = parseCodex(L({ timestamp: "2026-08-18T11:11:23.470Z", type: "event_msg", payload: { type: "task_complete" } }) + "\n", w1.state);
  assert.equal((w2.lines[0] as ChatSystemLine).durationMs, Date.parse("2026-08-18T11:11:23.470Z") - Date.parse("2026-08-18T11:10:58.598Z"));
});

console.log(`harness-io/codex: ${pass} passed`);
