// Codex 세션 I/O 어댑터 (#1746 #1759) — rollout jsonl → 공통 ChatLine.
//
//  ── 실측(codex 0.146.0, 2026-08-18, ~/.codex/sessions 실파일 box-yoon-355e7d10) ──
//  · 파일: ~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<session_id>.jsonl — 이름에 시각이 들어 규약(pathFor)으로 못 만든다.
//    경로는 훅 보고(transcript_path → work-flag → POST …/claude-uuid)로만 온다. append-only ndjson.
//  ★ 갱신(0.153.4, 2026-09-24 — #4135): **사람 말의 채널이 바뀌었다.**
//    0.149.1 까지는 `event_msg/user_message` 와 `response_item(role=user)` 에 같은 말이 둘 다 실렸고, 그래서 이 파서는
//    앞의 것만 정본으로 삼고 뒤의 것(주입이 섞인다)을 통째로 버렸다. 0.153.4 에는 **user_message 가 아예 없다**
//    (실측: 최근 rollout 16벌 중 9월 파일 전부에 0건) — 그 결과 현행 codex 세션은 대화창·질문 목록·아웃박스 에코에서
//    **사람이 친 말이 통째로 안 보였다**. 이제 둘 다 읽고, RI 쪽은 주입 모양(isInjectedUserText)을 걸러내며,
//    옛 판의 이중 기록은 «같은 글이 연달아 오면 한 번만» 으로 접는다.
//  · 줄: {timestamp(ISO), type, payload}. 화면에 뜻이 있는 것(실측):
//      response_item/message{role:"user"}                    → user (현행 정본 — 주입문은 걸러낸다)
//      event_msg/user_message{message}                       → user (옛 판 채널 — RI 와 겹치면 접는다)
//      response_item/message{role:"assistant", content:[{type:"output_text",text}]} → assistant text
//      response_item/custom_tool_call{call_id,name,input}    → assistant tool_use
//      response_item/custom_tool_call_output{call_id,output:[{text}]} → user tool_result
//      event_msg/task_started · task_complete                → 턴 경계 — system turn_duration(시각차). 시작은 state 에만.
//  · 버리는 것: response_item/message role=developer(주입) · event_msg/agent_message(assistant 와 중복 채널) ·
//    reasoning(encrypted_content 뿐 — 생각 원문이 없다) · session_meta · token_count · turn_context · world_state 등.
//  · 승인 UI 는 2026-09-24 에 실측했다(answer 주석) — 종전엔 미실측이라 answer=null 이었다.
import path from "node:path";
import type { HarnessSessionAdapter } from "./adapter.js";
import { isoOf, parseJsonLines, type ChatBlock, type ChatLine, type ParseState } from "./chat-line.js";

const asObj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, any> : null;


/** `response_item/message` 의 글자 — content 블록(input_text·output_text)을 잇는다. */
function userTextOf(p: Record<string, any>): string {
  const out: string[] = [];
  for (const c of Array.isArray(p.content) ? p.content : []) {
    const co = asObj(c); if (!co) continue;
    const t = String(co.text ?? "");
    if (t) out.push(t);
  }
  return out.join("\n").trim();
}

/**
 * 이 «사람 채널» 글이 사실은 **주입**인가 (실측 2026-09-24 — 최근 rollout 16벌에서 나온 모양 전부):
 *  · `# AGENTS.md instructions …<INSTRUCTIONS>…`  — 조직·프로젝트 지침 주입
 *  · `<environment_context>…`                     — 날짜·환경 주입
 *  · `<recommended_plugins>…`                     — 플러그인 안내 주입
 * 일반화는 **여는 태그로 시작하는 글**까지만 한다(`<소문자_이름>`) — 주입 래퍼가 전부 그 모양이고, 사람이 친 말이
 * 그렇게 시작하는 일은 드물다(코드를 붙여넣을 땐 백틱이 앞에 온다). 더 넓히면 사람의 말을 삼킨다.
 */
function isInjectedUserText(t: string): boolean {
  return /^\s*(#\s*AGENTS\.md instructions\b|<[a-z][a-z0-9_]*>)/i.test(t);
}

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
        //  옛 판(0.149.1)은 같은 말을 RI 와 여기 **둘 다** 적는다(RI 가 먼저). 그대로 두면 사람의 말이 두 번 보인다.
        if (st.lastUser === t.trim()) { delete st.lastUser; continue; }
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
        //  ★ 사람 발화의 채널이 판마다 다르다 (실측 2026-09-24, #4135):
        //   · 0.149.1 — `response_item(role=user)` 와 `event_msg/user_message` 에 **둘 다** 실린다(RI 가 먼저).
        //   · 0.153.4 — `event_msg/user_message` 가 **아예 없다**. RI 만 남는다.
        //   종전엔 user_message 만 정본으로 보고 RI 를 통째로 버렸다 — 그래서 현행 codex 에서는 **사람이 친 말이
        //   화면에서 통째로 사라졌다**(대화창·질문 목록·아웃박스 에코 확인이 같은 자리를 본다).
        //   그래서 RI 를 읽되, **주입문을 걸러낸다**(그것이 종전에 RI 를 못 믿은 이유다):
        //   실측된 주입 모양은 `# AGENTS.md instructions …`, `<environment_context>…`, `<recommended_plugins>…` 이다.
        const role = String(p.role || "");
        if (role === "user") {
          const t = userTextOf(p);
          if (!t || isInjectedUserText(t)) continue;
          st.lastUser = t;                                    // 옛 판의 중복(user_message)을 아래에서 가려내는 표식
          lines.push({ type: "user", timestamp: ts, message: { role: "user", content: t } });
          continue;
        }
        if (role !== "assistant") continue;                   // developer 채널은 주입(사람이 친 말이 아니다)
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
  //  승인 키 — 실측 2026-09-24(codex 0.153.4, `--ask-for-approval on-request` 로 직접 띄워 재었다):
  //   화면은 "Would you like to run the following command?" + "› 1. Yes, proceed (y) / 2. …(p) / 3. No, …(esc)" +
  //   "Press enter to confirm or esc to cancel". 커서(›)가 **1번(승인)에 놓인 채로** 뜨므로 Enter=승인, Esc=거부다.
  //   중단도 Esc("esc to interrupt" — busy 판정과 같은 문구).
  //  ⚠ 한 글자 단축키(y/p)도 실제로 먹지만 쓰지 않는다 — 화면이 보낼 수 있는 키를 Enter·Esc 둘로 묶어 둔 것이
  //   이 통로의 계약이고(send-keys.ts CHAT_KEYS), 'p'(= 앞으로 안 물어봄)는 사람이 직접 고를 일이지 화면이 대신 누를 것이 아니다.
  answer: (action) => (action === "approve" ? "Enter" : "Escape"),
  // 실측 2026-08-18(box-yoon-355e7d10): 업데이트·신뢰 대화상자는 메뉴 꼬리가 공통("Press enter to continue"),
  // 작업 중엔 "• Working (2s • esc to interrupt)", 준비되면 컴포저 캐럿(›)이 placeholder 와 함께 뜬다.
  // ⚠ busy 중에도 컴포저(›)가 그려져 있다 — 판정 순서(dialog→busy→ready)가 곧 안전장치다.
  //  ⚠ **훅 검토 대화상자는 우리가 대신 눌러 줄 수 없다** (2026-09-24 조사): codex 는 훅 신뢰를
  //   `config.toml` 의 `[hooks.state."<source>:<event>:<i>:<j>"] trusted_hash` 에 적는데, **그 해시 규격이 공개돼
  //   있지 않고 TUI 말고는 쓰는 경로가 없다**(업스트림 openai/codex #47283 «only the terminal TUI writes
  //   trusted_hash» · #21615 «설치기가 신뢰를 요청할 supported 한 길을 달라» · #46210). 그래서 킷이 훅을 심을 때
  //   신뢰까지 같이 적어 둘 수가 없다. 화면에서 «Trust all» 을 대신 누르는 것도 안 한다 — 그 한 번이 **레포에
  //   딸려온 훅**(<repo>/.codex/hooks.json)까지 함께 신뢰하고, 그게 이 대화상자가 막으려는 바로 그 일이다.
  //   지금 할 수 있는 것은 이 화면을 **대화상자로 정확히 알아보는 것**뿐이다(사람이 답할 때까지 글자를 안 넣는다).
  //  ★ 실측 보강 2026-09-24(codex 0.153.4, tmux 100x30 — 부팅부터 승인까지 직접 띄워 재었다):
  //   · 승인 대화상자 = "Would you like to run the following command?" + 번호 메뉴 + "Press enter to confirm or esc to cancel"
  //   · 훅 검토 대화상자 = "Hooks need review"(+ "Press t to trust all; enter to review hooks; esc to close")
  //   그래서 대화상자 꼬리를 "continue" 하나로 보지 않고 confirm·cancel·close 까지 본다 — 종전 정규식은 승인 화면을
  //   dialog 로 못 봐서, 답을 기다리는 화면에 아웃박스가 글자를 넣을 수 있었다.
  screen: (tail) => {
    const s = tail.join("\n");
    if (/press (enter|t) to (continue|confirm|review|trust)|esc to (cancel|close)|Would you like to run/i.test(s)) return "dialog";
    if (/esc to interrupt/i.test(s)) return "busy";
    if (/^\s*›/m.test(s)) return "ready";
    return null;   // 부팅·로그인 등 미실측 화면 — 보수적으로 기다린다
  },
  //  #4135 — 웹 터미널이 쓰는 화면 사실. **claude 와 셋 다 다르다**(실측 2026-09-24):
  //   · appMouse=false — codex TUI 는 alt 화면도 마우스 리포트도 안 쓴다(tmux `alternate_on=0 mouse_any_flag=0`).
  //     그래서 드래그·휠·복사가 **브라우저 기본으로 그냥 된다** — ⌘C 다리(#972)도, ⌥드래그 안내도 이 세션엔 필요 없다.
  //   · choiceNeedsEnter=true — 선택지 위에서 '1' 만 보내면 커서조차 안 움직인다. Enter 까지 가야 골라진다
  //     (claude 와 반대다 — 폰 키 줄이 이 값을 보고 Enter 를 붙인다).
  //   · pastePlaceholder=false — 여러 줄 붙여넣기는 접히지 않고 입력칸에 그대로 펼쳐진다(«+N lines» 표식이 없다).
  //   · startDialogRe — 부팅 길목에 대화상자가 **셋**이다: 폴더 신뢰 · 훅 검토 · 업데이트 알림. 셋 다 "Press enter to …"
  //     꼬리를 달고 번호 메뉴('› 1. …')를 쓴다. 이 위에서 Enter 를 치면 그 Enter 를 대화상자가 먹는다.
  term: {
    appMouse: false, choiceNeedsEnter: true, pastePlaceholder: false,
    startDialogRe: /Do you trust the contents|Hooks need review|Update available|Press enter to (continue|confirm)|›\s*1\.\s/i,
  },
};
