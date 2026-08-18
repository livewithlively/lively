// Grok Build 세션 I/O 어댑터 (#1746) — updates.jsonl(ACP `session/update` 통지 로그) → 공통 ChatLine.
//
//  ── 실측(grok 1.0.3, 2026-08-18, ~/.grok/sessions 실파일 5건) ──
//  · 파일: <GROK_HOME=~/.grok>/sessions/<encodeURIComponent(cwd)>/<uuidv7>/updates.jsonl — 훅 페이로드 transcriptPath 로도 온다
//    ([[grok-harness-spec-1701]]). append-only.
//  · 줄: {timestamp(초), method:"session/update"|"_x.ai/session/update", params:{sessionId, update:{sessionUpdate:…}, _meta:{agentTimestampMs,
//    promptId, turnStartMs, …}}}. update 종류(실측 8):
//      user_message_chunk{content.text, _meta.modelId}   → user
//      agent_thought_chunk{content.text}                → assistant thinking
//      agent_message_chunk{content.text}                → assistant text  (파일엔 **문단 단위로 합쳐져** 적힌다 — 토큰 조각이 아니다)
//      tool_call{toolCallId, title, rawInput, _meta["x.ai/tool"].name}   → assistant tool_use
//      tool_call_update{toolCallId, status?, content?[]|rawOutput?}      → status 가 있을 때만 user tool_result (없으면 제목 보강 — 버린다)
//      turn_completed{stop_reason, usage}(x.ai)         → system turn_duration · stop_reason=cancelled 면 interrupted
//      hook_execution · session_recap (x.ai)            → 버린다(화면에 뜻이 없다)
//  · MCP 는 `use_tool` 툴로 감싸 부른다(rawInput.tool_name="lively__whoami") — 화면 라벨이 진짜 툴을 보이도록 그 이름을 name 으로 올린다.
//  · 승인 UI 는 미실측 → answer=null(화면이 버튼을 안 그린다). 실측 후 채운다.
import path from "node:path";
import type { HarnessSessionAdapter } from "./adapter.js";
import { isoOf, parseJsonLines, type ChatBlock, type ChatLine, type ParseState } from "./chat-line.js";

const asObj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, any> : null;

/** tool_call_update 의 결과 본문 — content[] 의 텍스트 · rawOutput(MCP OkayOutput 문자열 우선) · 없으면 빈 문자열. */
function resultText(u: Record<string, any>): string {
  if (Array.isArray(u.content)) {
    const parts: string[] = [];
    for (const c of u.content) {
      const inner = asObj(asObj(c)?.content) ?? asObj(c);
      if (inner && typeof inner.text === "string") parts.push(inner.text);
      else if (c != null) parts.push(typeof c === "string" ? c : JSON.stringify(c));
    }
    if (parts.length) return parts.join("\n");
  }
  const ro = asObj(u.rawOutput);
  if (ro) {
    const out = asObj(ro.output);
    if (out && typeof out.OkayOutput === "string") return out.OkayOutput;
    if (out && typeof out.ErrorOutput === "string") return out.ErrorOutput;
    try { return JSON.stringify(ro, null, 2); } catch { return String(ro); }
  }
  return "";
}

function toolName(u: Record<string, any>): string {
  const meta = asObj(u._meta); const xt = asObj(meta?.["x.ai/tool"]);
  const base = String(xt?.name || u.title || "tool");
  const ri = asObj(u.rawInput);
  if (base === "use_tool" && ri && typeof ri.tool_name === "string" && ri.tool_name) return ri.tool_name;   // MCP 실제 툴 이름
  return base;
}

export function parseGrok(text: string, state: ParseState): { lines: ChatLine[]; state: ParseState } {
  const st: ParseState = { ...state };
  const lines: ChatLine[] = [];
  for (const raw of parseJsonLines(text)) {
    const o = asObj(raw); if (!o) continue;
    const params = asObj(o.params); const u = asObj(params?.update); if (!u) continue;
    const pmeta = asObj(params?._meta) ?? {};
    const ts = isoOf(pmeta.agentTimestampMs) || isoOf(o.timestamp);
    if (typeof pmeta.turnStartMs === "number") st.turnStartMs = pmeta.turnStartMs;
    const kind = String(u.sessionUpdate || "");
    const ctext = (): string => String(asObj(u.content)?.text ?? "");
    if (kind === "user_message_chunk") {
      const um = asObj(u._meta); if (um && typeof um.modelId === "string") st.model = um.modelId;
      lines.push({ type: "user", timestamp: ts, message: { role: "user", content: ctext() } });
      st.turnOpen = true;
    } else if (kind === "agent_thought_chunk" || kind === "agent_message_chunk") {
      const t = ctext(); if (!t.trim()) continue;
      const block: ChatBlock = kind === "agent_thought_chunk" ? { type: "thinking", thinking: t } : { type: "text", text: t };
      lines.push({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [block], model: st.model as string | undefined } });
    } else if (kind === "tool_call") {
      const id = String(u.toolCallId || ""); if (!id) continue;
      lines.push({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id, name: toolName(u), input: u.rawInput ?? {} }], model: st.model as string | undefined } });
    } else if (kind === "tool_call_update") {
      const id = String(u.toolCallId || ""); const status = String(u.status || "");
      if (!id || !status || status === "pending" || status === "in_progress") continue;   // 제목·입력 보강 갱신은 화면에 새 정보가 아니다
      lines.push({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: resultText(u), is_error: status === "failed" }] } });
    } else if (kind === "turn_completed") {
      const endMs = typeof pmeta.agentTimestampMs === "number" ? pmeta.agentTimestampMs : (typeof o.timestamp === "number" ? o.timestamp * 1000 : 0);
      const startMs = typeof st.turnStartMs === "number" ? st.turnStartMs : 0;
      const durationMs = endMs && startMs && endMs >= startMs ? endMs - startMs : undefined;
      if (String(u.stop_reason || "") === "cancelled") lines.push({ type: "system", subtype: "interrupted", timestamp: ts });
      else lines.push({ type: "system", subtype: "turn_duration", timestamp: ts, ...(durationMs !== undefined ? { durationMs } : {}) });
      st.turnOpen = false; delete st.turnStartMs;
    }
    // hook_execution · session_recap · 그 외 → 버린다
  }
  return { lines, state: st };
}

const CONV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const grokIo: HarnessSessionAdapter = {
  key: "grok", label: "Grok Build",
  roots: (homes) => homes.map((h) => path.join(h, ".grok", "sessions")),
  filePattern: /^updates\.jsonl$/,
  pathFor: (root, { cwd, convId }) => (cwd && CONV_ID_RE.test(convId) ? path.join(root, encodeURIComponent(cwd), convId, "updates.jsonl") : null),
  parse: parseGrok,
  answer: null,
  screen: null,   // 화면 판정 미실측(#1719) — 폴백 휴리스틱
};
