// Cursor ACP → 공통 세션 이벤트. 표준 ACP 이벤트는 기존 번역기를 재사용하고,
// Cursor 전용 차단 요청은 반드시 웹 승인 버스로 올려 답을 돌려준다.
import { grokAcpEvent } from "./grok-stream.js";
import type { PermissionAnswer, PermissionAsk, SessionEvent } from "./session-event.js";

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown): string => typeof v === "string" ? v : "";
const rpcId = (id: string): string | number => /^\d+$/.test(id) ? Number(id) : id;

export function cursorAcpEvent(value: unknown): SessionEvent | null {
  const m = record(value);
  const method = str(m.method);
  const p = record(m.params);
  const id = m.id === undefined || m.id === null ? "" : String(m.id);
  if (method === "cursor/ask_question" && id) {
    const questions = (Array.isArray(p.questions) ? p.questions : []).map((v) => {
      const q = record(v);
      return {
        id: str(q.id), question: str(q.prompt), multiSelect: q.allowMultiple === true,
        options: (Array.isArray(q.options) ? q.options : []).map((x) => ({ label: str(record(x).label) })).filter((x) => x.label),
      };
    }).filter((q) => q.id && q.question && q.options.length);
    if (questions.length) return { t: "permission.asked", ask: {
      id, toolName: "AskUserQuestion", title: str(p.title) || questions[0]!.question,
      input: p, questions,
    } };
  }
  if (method === "cursor/create_plan" && id) return { t: "permission.asked", ask: {
    id, toolName: "PlanApproval", title: str(p.name) || "계획을 승인하시겠습니까?",
    description: [str(p.overview), str(p.plan)].filter(Boolean).join("\n\n") || undefined, input: p,
  } };
  if (method === "cursor/task" && str(p.toolCallId)) return { t: "task.started", task: {
    id: str(p.toolCallId), kind: "agent", title: str(p.description) || "서브에이전트",
    status: "completed", summary: str(p.prompt), toolUseId: str(p.toolCallId),
  } };
  const event = grokAcpEvent(value);
  if (event?.t === "raw") return { ...event, source: "cursor" };
  // authMethods 는 로그인 가능한 수단의 목록이다. Cursor 는 initialize 뒤 authenticate 를
  // 별도로 수행하므로, 목록이 있다는 이유만으로 로그인 실패로 표시하지 않는다.
  if (event?.t === "facts" && record(m.result).agentCapabilities && event.facts.permissionMode === "needs-auth") {
    return { ...event, facts: { ...event.facts, permissionMode: undefined } };
  }
  return event;
}

export function cursorAcpResponse(ask: PermissionAsk, value: PermissionAnswer): string {
  let outcome: unknown;
  if (ask.toolName === "AskUserQuestion") {
    const raw = record(ask.input);
    const qs = Array.isArray(raw.questions) ? raw.questions : [];
    const answers = qs.map((x) => {
      const q = record(x);
      const labels = value.answers?.[str(q.prompt)];
      const selected = Array.isArray(labels) ? labels : labels ? [labels] : [];
      const ids = (Array.isArray(q.options) ? q.options : [])
        .map((o) => record(o)).filter((o) => selected.includes(str(o.label))).map((o) => str(o.id));
      return { questionId: str(q.id), selectedOptionIds: ids };
    });
    outcome = value.allow ? { outcome: "answered", answers } : { outcome: "skipped" };
  } else if (ask.toolName === "PlanApproval") {
    outcome = value.allow ? { outcome: "accepted" } : { outcome: "rejected" };
  } else {
    const options = (Array.isArray(ask.suggestions) ? ask.suggestions : []).map((o) => record(o));
    const desired = value.allow
      ? (value.scope === "always" ? ["allow-always", "allow_always", "allow-once", "allow_once"] : ["allow-once", "allow_once"])
      : ["reject-once", "reject_once"];
    const chosen = value.optionId || desired.map((d) => options.find((o) => o.optionId === d || o.kind === d)).find(Boolean)?.optionId;
    outcome = chosen ? { outcome: "selected", optionId: chosen } : { outcome: "cancelled" };
  }
  return JSON.stringify({ jsonrpc: "2.0", id: rpcId(ask.id), result: { outcome } }) + "\n";
}
