import assert from "node:assert/strict";
import { cursorAcpEvent, cursorAcpResponse } from "./cursor-stream.js";
import type { PermissionAsk } from "./session-event.js";

const question = {
  jsonrpc: "2.0", id: 41, method: "cursor/ask_question",
  params: { title: "선택해 주세요", questions: [
    { id: "q1", prompt: "모드?", options: [{ id: "agent", label: "실행" }, { id: "plan", label: "계획" }] },
    { id: "q2", prompt: "범위?", options: [{ id: "web", label: "웹" }, { id: "api", label: "API" }], allowMultiple: true },
  ] },
};
const askOf = (message: unknown): PermissionAsk => {
  const event = cursorAcpEvent(message);
  assert.equal(event?.t, "permission.asked");
  return (event as Extract<typeof event, { t: "permission.asked" }>).ask;
};
const resultOf = (line: string): Record<string, unknown> => JSON.parse(line).result;

const ask = askOf(question);
assert.equal(ask.id, "41");
assert.equal(ask.questions?.length, 2);
assert.equal(ask.questions?.[1]?.multiSelect, true);
assert.deepEqual(resultOf(cursorAcpResponse(ask, { allow: true, answers: { "모드?": "계획", "범위?": ["웹", "API"] } })), {
  outcome: { outcome: "answered", answers: [
    { questionId: "q1", selectedOptionIds: ["plan"] },
    { questionId: "q2", selectedOptionIds: ["web", "api"] },
  ] },
});
assert.deepEqual(resultOf(cursorAcpResponse(ask, { allow: false })), { outcome: { outcome: "skipped" } });
assert.notEqual(cursorAcpEvent({ id: 42, method: "cursor/ask_question", params: { questions: [] } })?.t, "permission.asked");

const plan = askOf({ id: 43, method: "cursor/create_plan", params: { name: "배포 계획", plan: "검증 후 반영" } });
assert.equal(plan.toolName, "PlanApproval");
assert.deepEqual(resultOf(cursorAcpResponse(plan, { allow: true })), { outcome: { outcome: "accepted" } });
assert.deepEqual(resultOf(cursorAcpResponse(plan, { allow: false })), { outcome: { outcome: "rejected" } });

const permission = askOf({ id: 44, method: "session/request_permission", params: {
  toolCall: { title: "write file", kind: "write" }, options: [
    { optionId: "allow-once", kind: "allow_once", name: "이번만 허용" },
    { optionId: "reject-once", kind: "reject_once", name: "거부" },
  ],
} });
assert.deepEqual(resultOf(cursorAcpResponse(permission, { allow: true })), { outcome: { outcome: "selected", optionId: "allow-once" } });
assert.deepEqual(resultOf(cursorAcpResponse(permission, { allow: false })), { outcome: { outcome: "selected", optionId: "reject-once" } });
assert.deepEqual(resultOf(cursorAcpResponse({ ...permission, suggestions: [] }, { allow: true })), { outcome: { outcome: "cancelled" } });

const standard = cursorAcpEvent({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "help", description: "도움말" }] } } });
assert.equal(standard?.t, "facts", "표준 슬래시 목록을 웹에 전달해야 한다");
console.log("cursor-stream: 질문·계획·도구 승인·슬래시 목록 통과");
