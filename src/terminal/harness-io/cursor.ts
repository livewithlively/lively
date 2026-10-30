// Cursor 세션 I/O 어댑터 (#4927) — agent-transcripts/<id>/<id>.jsonl → 공통 ChatLine.
//
//  ── 근거: 번들 작성기(cursor-agent 2026.10.19-6bbf2c4, 모듈 ../agent-transcript) — 실파일 실측 전 ──
//  · CLI 는 대화 기록 저장소를 writeText:false · writeJsonl:true · appendFile 로 만든다(턴마다 이어 쓴다).
//  · 파일: <HOME>/.cursor/projects/<slug(cwd)>/agent-transcripts/<id>/<id>.jsonl — slug 는 영숫자 밖을 "-" 로, 이어진 "-" 는 하나로,
//    앞뒤 "-" 는 뗀다. 서브에이전트는 <부모 id>/subagents/<id>.jsonl 이다(이 파서는 주 대화만 연다).
//  · 줄: {role:"user"|"assistant", message:{content:[{type:"text",text} | {type:"tool_use",name,input}]}}
//        {type:"turn_ended", status:"success"|"aborted"|"error", error?}   ← 턴이 끝날 때마다
//        {type:"metadata", metadata:{overview}}                          ← 요약을 만든 경우 맨 앞(버린다)
//  · 작성기가 **쓰지 않는 것**: 시각 · 모델 · 도구 호출 id · 도구 결과(tool 메시지는 줄이 없다) · system 메시지.
//    그래서 timestamp 는 "" 이고(화면은 '시각 미상'으로 다룬다 — 지어내지 않는다), tool_use id 는 우리가 순번으로 붙이며
//    tool_result 줄은 없다(턴이 끝나면 화면이 결과 없는 도구를 «도는 중»에서 내린다). 생각(reasoning)은 작성기가 본문 text 뒤에
//    "\n\n" 으로 붙여 써서 따로 가를 수 없다 — 본문으로 보인다.
//  · 사람 말은 작성기가 이미 맥락 태그(user_info·rules·system_reminder …)를 걷어낸 뒤다.
import path from "node:path";
import type { HarnessSessionAdapter } from "./adapter.js";
import { TERM_UI_UNKNOWN } from "./term-ui.js";
import { parseJsonLines, type ChatBlock, type ChatLine, type ParseState } from "./chat-line.js";

const asObj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, any> : null;
//  turn_ended.error 는 작성기가 문자열로 쓰지만(번들) 객체가 와도 «[object Object]» 가 아니라 내용이 보이게.
const errText = (e: unknown): string => {
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
};

export function parseCursor(text: string, state: ParseState): { lines: ChatLine[]; state: ParseState } {
  const st: ParseState = { ...state };
  const lines: ChatLine[] = [];
  //  도구 id 순번 — 창(window)을 나눠 읽어도 id 가 겹치지 않게 state 로 잇는다. 부재·잡값이면 0 부터.
  let seq = typeof st.toolSeq === "number" && Number.isFinite(st.toolSeq) ? st.toolSeq : 0;
  for (const raw of parseJsonLines(text)) {
    const o = asObj(raw); if (!o) continue;
    if (o.type === "turn_ended") {
      const status = String(o.status || "");
      if (status === "aborted") lines.push({ type: "system", subtype: "interrupted", timestamp: "" });
      else if (status === "error") lines.push({ type: "system", subtype: "error", timestamp: "", text: `Cursor 턴이 오류로 끝났습니다${o.error ? `: ${errText(o.error)}` : ""}` });
      else lines.push({ type: "system", subtype: "turn_duration", timestamp: "" });
      st.turnOpen = false;
      continue;
    }
    const role = o.role;
    if (role !== "user" && role !== "assistant") continue;   // metadata · 모르는 type
    const content = asObj(o.message)?.content;
    const texts: string[] = [];
    const uses: ChatBlock[] = [];
    if (typeof content === "string") { if (content.trim()) texts.push(content); }
    else if (Array.isArray(content)) {
      for (const b of content) {
        const blk = asObj(b); if (!blk) continue;
        if (blk.type === "text" && typeof blk.text === "string" && blk.text.trim()) texts.push(blk.text);
        else if (blk.type === "tool_use" && role === "assistant") {
          uses.push({ type: "tool_use", id: `cursor-tool-${++seq}`, name: String(blk.name || "tool"), input: blk.input ?? {} });
        }
      }
    }
    if (role === "user") {
      if (!texts.length) continue;
      lines.push({ type: "user", timestamp: "", message: { role: "user", content: texts.join("\n") } });
      st.turnOpen = true;
    } else {
      const blocks: ChatBlock[] = [...texts.map((t): ChatBlock => ({ type: "text", text: t })), ...uses];
      if (!blocks.length) continue;
      lines.push({ type: "assistant", timestamp: "", message: { role: "assistant", content: blocks } });
    }
  }
  st.toolSeq = seq;
  return { lines, state: st };
}

/** 작업 폴더 → Cursor 프로젝트 폴더 이름(번들 workspace-paths 의 slug 그대로). */
export const cursorProjectSlug = (cwd: string): string =>
  cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");

//  대화 id 는 UUID 다. 경로 조각이 될 수 있는 값(/ · .. · 공백)은 받지 않는다 — 작성기의 이스케이프(encodeURIComponent·% → _)는
//  이 문자집합에선 그대로라 따로 흉내 내지 않는다.
const CONV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function cursorPathFor(root: string, { cwd, convId }: { cwd: string; convId: string }): string | null {
  const slug = cursorProjectSlug(String(cwd || ""));
  if (!slug || !CONV_ID_RE.test(convId)) return null;
  return path.join(root, slug, "agent-transcripts", convId, `${convId}.jsonl`);
}

//  키트(멤버 PC 의 Cursor IDE·CLI 배선)만 지원한다 — 웹 세션 카탈로그에 없어 이 판이 Cursor 세션을 띄우지 않는다.
//  parse 는 세션 로그 수집(Stop 훅이 올린 원본)을 화면으로 읽는 데 쓴다. 화면(screen·run)·승인 키는 띄운 적이 없어
//  미실측 null 이다(있는 척 금지).
export const cursorIo: HarnessSessionAdapter = {
  key: "cursor", label: "Cursor",
  roots: (homes) => homes.map((h) => path.join(h, ".cursor", "projects")),
  filePattern: /\.jsonl$/,
  pathFor: cursorPathFor,
  convIdOk: null,   // 대화 id 는 UUID 로 보이나 훅 보고로 확인하지 않았다 — 판단 보류(보고를 종전대로 받는다)
  parse: parseCursor,
  answer: null,
  screen: null,
  run: null,
  term: TERM_UI_UNKNOWN,
};
