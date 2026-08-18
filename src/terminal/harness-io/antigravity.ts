// Antigravity CLI(agy) 세션 I/O 어댑터 (#1746) — transcript_full.jsonl(스텝 로그) → 공통 ChatLine.
//
//  ── 실측(agy 1.1.13, 2026-08-18, ~/.gemini/antigravity-cli/brain 실파일 12건) ──
//  · 파일: ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl — 훅 페이로드 transcriptPath 로도
//    온다([[antigravity-harness-spec-1689]]). append-only 이되 **스텝이 DONE 되는 순서**로 적혀 step_index 가 가끔 앞뒤로 논다.
//  · 줄: {step_index, source: USER_EXPLICIT|MODEL|SYSTEM, type, status: DONE|RUNNING, created_at(ISO), content?, thinking?, tool_calls?, exit_code?, error?}
//      USER_INPUT(USER_EXPLICIT)  content = "<USER_REQUEST>\n…\n</USER_REQUEST>\n<ADDITIONAL_METADATA>…"   → user(태그 안 본문만)
//      PLANNER_RESPONSE(MODEL)    thinking? · content?(사람에게 하는 말) · tool_calls?[{name,args}]        → assistant(thinking·text·tool_use)
//                                 tool_calls 가 없으면 그 턴의 **마지막 말**이다 → system turn_duration 을 뒤에 붙인다(agy 엔 턴 종료 줄이 없다)
//      RUN_COMMAND·VIEW_FILE·LIST_DIRECTORY·GREP_SEARCH·MCP_TOOL·CODE_ACTION·GENERIC(MODEL) content = 도구 결과   → user tool_result
//      ERROR_MESSAGE(MODEL: 툴콜 파싱 오류 / SYSTEM: 시스템 오류) error·content                            → 짝이 있으면 오류 결과, 없으면 assistant text ⚠
//      CHECKPOINT(SYSTEM) content = 맥락 압축 요약                                                          → system compact
//      CONVERSATION_HISTORY(SYSTEM)                                                                       → 버린다
//  · 결과 줄엔 어느 tool_call 의 것인지 id 가 없다 → **짝짓기**: PLANNER 의 tool_calls 를 대기열에 넣고(id=agy-<step>-<i>), 결과 줄이 오면
//    같은 종류(run_command↔RUN_COMMAND …)이면서 그 PLANNER 보다 뒤 스텝인 가장 오래된 대기를 짝으로 준다. 종류가 안 맞으면 가장 오래된
//    대기. 대기가 없으면(창의 첫머리 — 앞 창의 호출) 그 결과는 붙일 데가 없어 버린다(원문은 터미널·중앙기록에 그대로 있다).
//    이 대기열이 파서 상태(ParseState)다 — 창 사이를 잇는다(harness-io/parse-cache).
//  · 승인 UI 미실측 → answer=null.
import path from "node:path";
import type { HarnessSessionAdapter } from "./adapter.js";
import { isoOf, parseJsonLines, type ChatBlock, type ChatLine, type ParseState } from "./chat-line.js";

const asObj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, any> : null;

// 툴 이름 → 결과 줄 type(종류). 모르면 GENERIC(무엇이든 짝이 된다).
function kindOfTool(name: string): string {
  const n = name.toLowerCase();
  if (n === "run_command" || n === "command_status") return "RUN_COMMAND";
  if (n.startsWith("view_file") || n === "view_code_item") return "VIEW_FILE";
  if (n === "list_dir" || n === "find_by_name") return "LIST_DIRECTORY";
  if (n === "grep_search") return "GREP_SEARCH";
  if (n.startsWith("call_mcp") || n.startsWith("mcp")) return "MCP_TOOL";
  if (n === "write_to_file" || n.includes("replace") || n.includes("edit")) return "CODE_ACTION";
  return "GENERIC";
}
const RESULT_TYPES = new Set(["RUN_COMMAND", "VIEW_FILE", "LIST_DIRECTORY", "GREP_SEARCH", "MCP_TOOL", "CODE_ACTION", "GENERIC"]);

interface Pending { id: string; step: number; kind: string }

/** USER_INPUT 본문에서 사람 말만 — <USER_REQUEST>…</USER_REQUEST>. 태그가 없으면 전문. */
export function userRequestOf(content: string): string {
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
  return (m ? m[1] : content).trim();
}

export function parseAntigravity(text: string, state: ParseState): { lines: ChatLine[]; state: ParseState } {
  const pending: Pending[] = Array.isArray(state.pending) ? [...(state.pending as Pending[])] : [];
  let turnStart = typeof state.turnStart === "string" ? state.turnStart : "";
  const lines: ChatLine[] = [];
  const closeTurn = (ts: string): void => {
    const s = Date.parse(turnStart), e = Date.parse(ts);
    const durationMs = Number.isFinite(s) && Number.isFinite(e) && e >= s ? e - s : undefined;
    lines.push({ type: "system", subtype: "turn_duration", timestamp: ts, ...(durationMs !== undefined ? { durationMs } : {}) });
    turnStart = "";
  };
  const takePending = (step: number, kind: string): Pending | null => {
    let i = pending.findIndex((p) => p.step < step && p.kind === kind);
    if (i < 0) i = pending.findIndex((p) => p.step < step);
    if (i < 0) return null;
    return pending.splice(i, 1)[0];
  };
  for (const raw of parseJsonLines(text)) {
    const o = asObj(raw); if (!o) continue;
    const step = Number(o.step_index) || 0;
    const source = String(o.source || ""), type = String(o.type || "");
    const ts = isoOf(o.created_at);
    const content = typeof o.content === "string" ? o.content : "";
    if (type === "USER_INPUT") {
      if (turnStart) closeTurn(ts);           // 앞 턴이 안 닫혔으면(마지막 말 없이 끝남) 여기서 닫는다
      lines.push({ type: "user", timestamp: ts, message: { role: "user", content: userRequestOf(content) } });
      turnStart = ts || turnStart;
      pending.length = 0;
    } else if (type === "PLANNER_RESPONSE") {
      const blocks: ChatBlock[] = [];
      if (typeof o.thinking === "string" && o.thinking.trim()) blocks.push({ type: "thinking", thinking: o.thinking });
      if (content.trim()) blocks.push({ type: "text", text: content });
      const calls = Array.isArray(o.tool_calls) ? o.tool_calls : [];
      calls.forEach((tc: unknown, i: number) => {
        const c = asObj(tc); if (!c) return;
        const name = String(c.name || "tool"); const id = `agy-${step}-${i}`;
        blocks.push({ type: "tool_use", id, name, input: c.args ?? {} });
        pending.push({ id, step, kind: kindOfTool(name) });
      });
      if (blocks.length) lines.push({ type: "assistant", timestamp: ts, message: { role: "assistant", content: blocks } });
      if (!calls.length && content.trim()) closeTurn(ts);   // 도구 없이 말만 = 턴의 마지막 말
    } else if (type === "CHECKPOINT") {
      lines.push({ type: "system", subtype: "compact", timestamp: ts, text: content });
    } else if (type === "ERROR_MESSAGE") {
      const msg = String(o.error || content || "").trim();
      const p = source === "MODEL" ? takePending(step, "GENERIC") : null;
      if (p) lines.push({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: p.id, content: msg, is_error: true }] } });
      else if (msg) lines.push({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "⚠ " + msg }] } });
    } else if (source === "MODEL" && RESULT_TYPES.has(type)) {
      const p = takePending(step, type);
      if (!p) continue;                        // 붙일 호출이 없다(앞 창의 것) — 원문은 그대로 파일에 있다
      const isErr = typeof o.exit_code === "number" && o.exit_code !== 0;
      lines.push({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: p.id, content, is_error: isErr }] } });
    }
    // CONVERSATION_HISTORY 등 → 버린다
  }
  return { lines, state: { pending: pending.slice(-64), turnStart } };
}

const CONV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const antigravityIo: HarnessSessionAdapter = {
  key: "antigravity", label: "Antigravity",
  roots: (homes) => homes.map((h) => path.join(h, ".gemini", "antigravity-cli", "brain")),
  filePattern: /^transcript(_full)?\.jsonl$/,
  pathFor: (root, { convId }) => (CONV_ID_RE.test(convId) ? path.join(root, convId, ".system_generated", "logs", "transcript_full.jsonl") : null),
  latest: null,
  parse: parseAntigravity,
  answer: null,
};
