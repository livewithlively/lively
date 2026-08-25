// Codex 세션 I/O 어댑터 (#1746 #1759) — rollout jsonl → 공통 ChatLine.
//
//  ── 실측(codex 0.146.0, 2026-08-18, ~/.codex/sessions 실파일 box-yoon-355e7d10) ──
//  · 파일: ~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<session_id>.jsonl — 이름에 시각이 들어 규약(pathFor)으로 못 만든다.
//    경로는 훅 보고(transcript_path → work-flag → POST …/claude-uuid)로만 온다. append-only ndjson.
//  · 줄: {timestamp(ISO), type, payload}. 화면에 뜻이 있는 것(실측):
//      event_msg/user_message{message}                       → user (사람 말의 **정본 채널** — response_item 의 role=user 는
//                                                              AGENTS.md·컨텍스트 주입도 섞여 와서 못 믿는다)
//      response_item/message{role:"assistant", content:[{type:"output_text",text}]} → assistant text
//      response_item/custom_tool_call{call_id,name,input}    → assistant tool_use
//      response_item/custom_tool_call_output{call_id,output:[{text}]} → user tool_result
//      event_msg/task_started · task_complete                → 턴 경계 — system turn_duration(시각차). 시작은 state 에만.
//  · 버리는 것: response_item/message role=developer·user(주입·중복) · event_msg/agent_message(assistant 와 중복 채널) ·
//    reasoning(encrypted_content 뿐 — 생각 원문이 없다) · session_meta · token_count · turn_context · world_state 등.
//  · 승인 UI 는 관리 세션(auto-approve)에서 안 떠 미실측 → answer=null. 화면 판정(screen)은 adapter 에서 이관.
import path from "node:path";
import type { HarnessSessionAdapter } from "./adapter.js";
import { isoOf, parseJsonLines, type ChatBlock, type ChatLine, type ParseState } from "./chat-line.js";

const asObj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, any> : null;

export function parseCodex(text: string, state: ParseState): { lines: ChatLine[]; state: ParseState } {
  const st: ParseState = { ...state };
  const lines: ChatLine[] = [];
  for (const raw of parseJsonLines(text)) {
    const o = asObj(raw); if (!o) continue;
    const p = asObj(o.payload); if (!p) continue;
    const ts = isoOf(o.timestamp);
    const top = String(o.type || "");
    if (top === "event_msg") {
      const k = String(p.type || "");
      if (k === "user_message") {
        const t = String(p.message ?? ""); if (!t.trim()) continue;
        lines.push({ type: "user", timestamp: ts, message: { role: "user", content: t } });
      } else if (k === "task_started") {
        const ms = Date.parse(String(o.timestamp || ""));
        if (Number.isFinite(ms)) st.turnStartMs = ms;
      } else if (k === "task_complete") {
        const endMs = Date.parse(String(o.timestamp || ""));
        const startMs = typeof st.turnStartMs === "number" ? st.turnStartMs : 0;
        const durationMs = Number.isFinite(endMs) && startMs && endMs >= startMs ? endMs - startMs : undefined;
        lines.push({ type: "system", subtype: "turn_duration", timestamp: ts, ...(durationMs !== undefined ? { durationMs } : {}) });
        delete st.turnStartMs;
      } else if (k === "thread_settings_applied") {
        const m = asObj(p.thread_settings)?.model;
        if (typeof m === "string" && m) st.model = m;
      }
      // agent_message(중복) · token_count 등 → 버린다
    } else if (top === "response_item") {
      const k = String(p.type || "");
      if (k === "message") {
        if (String(p.role || "") !== "assistant") continue;   // developer·user 채널은 주입·중복(user_message 가 정본)
        const blocks: ChatBlock[] = [];
        for (const c of Array.isArray(p.content) ? p.content : []) {
          const co = asObj(c); if (!co) continue;
          const t = String(co.text ?? "");
          if (co.type === "output_text" && t.trim()) blocks.push({ type: "text", text: t });
        }
        if (blocks.length) lines.push({ type: "assistant", timestamp: ts, message: { role: "assistant", content: blocks, model: st.model as string | undefined } });
      } else if (k === "custom_tool_call") {
        const id = String(p.call_id || p.id || ""); if (!id) continue;
        lines.push({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id, name: String(p.name || "tool"), input: p.input ?? {} }], model: st.model as string | undefined } });
      } else if (k === "custom_tool_call_output") {
        const id = String(p.call_id || ""); if (!id) continue;
        const parts: string[] = [];
        for (const c of Array.isArray(p.output) ? p.output : []) {
          const co = asObj(c); if (co && typeof co.text === "string") parts.push(co.text);
        }
        lines.push({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: parts.join("") }] } });
      }
      // reasoning(암호화) 등 → 버린다
    }
    // session_meta · turn_context · world_state 등 → 버린다
  }
  return { lines, state: st };
}

export const codexIo: HarnessSessionAdapter = {
  key: "codex", label: "Codex",
  roots: (homes) => homes.map((h) => path.join(h, ".codex", "sessions")),
  filePattern: /^rollout-.*\.jsonl$/,
  pathFor: null,   // 파일 이름에 시각이 들어 규약으로 못 만든다 — 훅 보고 경로만
  convIdOk: null,  // 대화 id 규약 미확정 — 판단 보류(보고를 종전대로 받는다)
  parse: parseCodex,
  answer: null,    // 승인 UI 미실측(관리 세션은 auto-approve) — 있는 척하지 않는다
  // 실측 2026-08-18(box-yoon-355e7d10): 업데이트·신뢰 대화상자는 메뉴 꼬리가 공통("Press enter to continue"),
  // 작업 중엔 "• Working (2s • esc to interrupt)", 준비되면 컴포저 캐럿(›)이 placeholder 와 함께 뜬다.
  // ⚠ busy 중에도 컴포저(›)가 그려져 있다 — 판정 순서(dialog→busy→ready)가 곧 안전장치다.
  screen: (tail) => {
    const s = tail.join("\n");
    if (/press enter to continue/i.test(s)) return "dialog";
    if (/esc to interrupt/i.test(s)) return "busy";
    if (/^\s*›/m.test(s)) return "ready";
    return null;   // 부팅·로그인 등 미실측 화면 — 보수적으로 기다린다
  },
};
