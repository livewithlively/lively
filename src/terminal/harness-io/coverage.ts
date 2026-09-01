// 하네스 커버리지 표 (#2439) — **무엇이 되고 무엇이 안 되는지를 코드가 안다.**
//
//  ── 왜 표가 필요한가 ────────────────────────────────────────────────────────────
//  «기능 커버리지 100%» 를 느낌으로 판정하면 반드시 틀린다. 이 프로젝트가 그 실수를 이미 했다 —
//  대화창이 터미널의 무엇을 덮는지 **목록도 없이** 기본 화면을 바꿨고, 백그라운드 셸·서브에이전트·
//  아티팩트가 통째로 빠진 화면이 남의 기본이 됐다.
//
//  그래서 축을 **열거하고**, 하네스마다 그 축의 상태를 **명시**하게 한다. 계약 테스트가
//  «모든 하네스가 모든 축을 답했나» 를 강제하므로, 새 축이나 새 하네스가 오면 먼저 빨간불이 난다.
//
//  ── 상태 셋 ─────────────────────────────────────────────────────────────────────
//   "ok"        웹에서 쓸 수 있다(번역기가 옮기고 화면이 그린다).
//   "terminal"  **터미널로 가야 한다** — 웹에서 못 한다. 화면이 그 길을 명시해야 한다(막다른 길 금지).
//   "n/a"       그 하네스에 그 기능이 없다(벤더가 안 준다). «못 한다» 와 다르다.
//
//  ⚠ "terminal" 은 부끄러운 값이 아니라 **정직한 값**이다. 그 자리를 "ok" 로 적으면 사람이
//   웹에서 찾다가 못 찾고, 그게 «반쪽 UX» 의 정체다.
export type CoverageState = "ok" | "terminal" | "n/a";

/** 사람이 세션에서 실제로 하는 일 — 축의 목록이 곧 «무엇을 덮어야 하나» 의 정의다. */
export const COVERAGE_AXES = [
  "read",          // 대화를 읽는다
  "send",          // 말을 건다
  "tasks",         // 백그라운드 셸·서브에이전트가 지금 무엇을 하는지 본다
  "approve",       // 도구 승인 요청에 답한다(can_use_tool — 하네스가 «이 도구 써도 되나» 를 묻는다)
  //  ★ approve 와 **다른 축**이다(2026-09-01 신고로 알았다). 이건 에이전트가 **사람에게 묻는 것**이고
  //   (claude 의 AskUserQuestion 툴) 답은 «권한» 이 아니라 **고른 선택지**다. 하네스 TUI 는 이걸
  //   번호 목록으로 그리고 사람이 고르면 그 값을 툴 결과로 채운다.
  //   ⚠ 나는 이 축을 표에 만들지 않아 구멍이 안 보였고 «100%» 라고 보고했다. 대화창엔 질문과
  //    선택지가 다 와 있는데 **고를 수가 없어** 사람이 터미널을 열어야 했다.
  "ask",           // 에이전트가 준 선택지 중에서 고른다
  "slash",         // 슬래시 명령을 쓴다
  "usage",         // 사용량·한도를 본다
  "interrupt",     // 도는 턴을 멈춘다
  "model",         // 모델·추론강도를 바꾼다
] as const;
export type CoverageAxis = (typeof COVERAGE_AXES)[number];

export interface HarnessCoverage {
  harness: string;
  axes: Record<CoverageAxis, CoverageState>;
  /** 왜 그 상태인가 — "terminal"·"n/a" 는 이유가 있어야 한다(다음 사람이 다시 재지 않게). */
  notes: Partial<Record<CoverageAxis, string>>;
}

//  ⚠ 이 표는 **실측을 적는 자리**다. «될 것 같다» 를 적으면 그 순간 거짓말이 된다.
export const COVERAGE: readonly HarnessCoverage[] = [
  {
    harness: "claude",
    axes: { read: "ok", send: "ok", tasks: "ok", ask: "ok", approve: "ok", slash: "ok", usage: "ok", interrupt: "ok", model: "ok" },
    notes: {
      //  ★ 2026-09-01 되게 만들었다. 공식 문서 "Handle approvals and user input" 이 규약을 다 적어 뒀다:
      //   AskUserQuestion 은 canUseTool 로 오고, 답은 updatedInput={questions, answers} 로 돌려준다
      //   (키=질문 전문, 값=고른 label). 승인으로 답하면 툴이 "The user did not answer the questions"
      //   로 끝난다 — 그게 «시간만 올라가던» 그 화면이었다.
      //  ⚠ 이건 **대화 런타임이 도는 세션**의 이야기다. pane 에 TUI 가 도는 terminal 모드에서는
      //   TUI 가 그 카드를 쥐므로 여전히 터미널에서 고른다(sessionTerminalOnlyAxes 가 그 사실을 싣는다).
      //  ★ 이 축은 표에서 두 번 뒤집혔다. 그 자취를 남긴다 — 다음 사람이 같은 함정을 밟지 않게.
      //   ① "ok" 로 적었다(근거 없이 — 배선이 준비된 것을 «된다» 로 옮겨 적었다).
      //   ② "terminal" 로 되돌렸다(5가지를 시도했는데 물음이 0건이었다).
      //   ③ 다시 "ok" — **실제로 받아서 답하고 턴이 끝나는 것까지 확인했다**(2026-09-01).
      //
      //  ⚠ ②에서 헛짚은 진짜 이유: **`echo` 로 시험했다.** claude 는 안전한 명령을 default 모드에서
      //   자동 허용한다 — 그래서 물음이 안 온 것이지 기능이 없는 게 아니었다. 공식 Agent SDK 의
      //   canUseTool 도 **같은 환경에서 똑같이 0건**이었고(오라클로 확인), 프롬프트를 «파일 쓰기» 로
      //   바꾸자 SDK 도 우리 런타임도 **한 번에 물었다.**
      //   → 승인을 시험할 땐 반드시 **권한이 필요한 동작**(Write·rm·네트워크)을 시킨다.
    },
  },
  {
    harness: "codex",
    axes: { read: "ok", send: "ok", tasks: "ok", ask: "ok", approve: "ok", slash: "n/a", usage: "ok", interrupt: "ok", model: "terminal" },
    notes: {
      //  ★ 실측 2026-09-01(0.152.0, 자기 JSON 스키마 근거): `item/tool/requestUserInput`
      //   요청 {isBlocking,itemId,threadId,turnId,questions:[{id,header,question,options,isOther,isSecret}]}
      //   응답 {answers:{"<질문 id>":{answers:["<label>",…]}}} — **질문 id 로** 키잡는다.
      //   ⚠ isSecret 질문은 웹에서 안 받는다(자격증명 자리) — 그 묶음은 raw 로 흘린다.
      slash: "codex 는 슬래시가 TUI 전용이다 — app-server 프로토콜로 목록이 노출되지 않는다(벤더 미제공).",
      model: "thread/start 에서만 정해진다 — 도는 중 전환하는 RPC 가 app-server 스키마에 없고, 카탈로그에도 runtimeCmd 가 없다.",
    },
  },
  {
    harness: "grok",
    axes: { read: "ok", send: "ok", tasks: "ok", ask: "ok", approve: "ok", slash: "ok", usage: "terminal", interrupt: "ok", model: "ok" },
    notes: {
      //  ★ 실측 2026-09-01(1.0.13) — 실제로 답해 turn 이 이어지는 것까지 확인했다(tool completed).
      //   요청 `_x.ai/ask_user_question` · 응답 {outcome:"accepted", answers:{"<질문>":"<label>"}}.
      //   outcome 은 **문자열 variant** 다(map 이면 튕긴다). 유효값: accepted·chat_about_this·
      //   skip_interview·cancelled — 오류 메시지가 열거해 줬다.
      usage: "토큰 사용량을 주는 알림을 이번 실측 턴에서 못 봤다 — 안 본 것을 짐작해 «된다» 로 적지 않는다.",
    },
  },
  {
    harness: "opencode",
    axes: { read: "ok", send: "ok", tasks: "ok", ask: "ok", approve: "ok", slash: "terminal", usage: "terminal", interrupt: "ok", model: "terminal" },
    notes: {
      //  ★ 실측 2026-09-01(1.18.25, OpenAPI 근거): `GET /question` 대기 목록 ·
      //   `POST /question/{id}/reply {answers:string[][]}` · `reject`.
      //   ⚠ «질문이 왔다» 이벤트가 **없다**(question.replied·rejected 만 있다) — 그래서 목록을 읽는다.
      //   ⚠ 답이 **질문 순서대로의 배열**이다(키가 아니라 위치). 낱말도 multiple(≠multiSelect)이다.
      slash: "OpenAPI 에 /session/{id}/command 는 있으나 **쓸 수 있는 명령 목록**을 주는 이벤트를 못 찾았다.",
      usage: "이벤트 스트림에서 사용량·한도 축을 못 봤다(session.idle 만 온다).",
      model: "카탈로그에 runtimeCmd 가 없다(도는 중 모델을 바꾸는 슬래시가 확인 안 됨) — /runtime 이 409 로 «터미널에서» 라고 사실대로 답한다.",
    },
  },
  {
    harness: "antigravity",
    axes: { read: "ok", send: "ok", tasks: "ok", ask: "terminal", approve: "terminal", slash: "terminal", usage: "ok", interrupt: "ok", model: "terminal" },
    notes: {
      //  ⚠ 실측 2026-09-01(1.1.22): ask_question 은 `step_type:"unknown"` 으로 오고 **내용이 없다**
      //   ({step_index,state:"DONE",duration_seconds} 뿐 — 질문도 선택지도 안 온다). 0.34초에 자동
      //   스킵되고 에이전트는 «스킵하셨네요» 라고 말한다. 벤더가 헤드리스에 그 내용을 안 준다.
      ask: "ask_question 이 내용 없는 step_type:\"unknown\" 으로 와 자동 스킵된다(실측 1.1.22) — 그릴 재료가 없다.",
      //  ⚠ 이건 «우리가 안 했다» 가 아니라 **벤더가 헤드리스에서 막았다** 는 실측이다.
      approve: "헤드리스에서 승인을 **못 묻는다**(실측 2026-09-01, agy 1.1.22): \"a tool required the command permission that headless mode cannot prompt for, so it was auto-denied\". 즉 물음 자체가 우리에게 안 온다 — 터미널 TUI 에서만 뜬다.",
      slash: "슬래시 목록을 주는 이벤트를 못 봤다(init 은 tools 만 준다).",
      model: "--model 은 기동 인자다 — 턴마다 프로세스라 «도는 중 전환» 이라는 개념이 없다(카탈로그에 runtimeCmd 없음).",
    },
  },
];

/** 이 하네스의 커버리지. 모르는 하네스는 null — claude 로 추측하지 않는다. */
export function coverageOf(harness: string): HarnessCoverage | null {
  return COVERAGE.find((c) => c.harness === harness) ?? null;
}

/** 웹에서 못 하는 축들 — 화면이 «터미널로 가세요» 를 **정확히** 말하기 위한 재료. */
export function terminalOnlyAxes(harness: string): CoverageAxis[] {
  const c = coverageOf(harness);
  return c ? COVERAGE_AXES.filter((a) => c.axes[a] === "terminal") : [];
}

/** 100% 인가 — "terminal" 이 하나도 없으면 참("n/a" 는 벤더가 안 주는 것이라 세지 않는다). */
export function isFullyCovered(harness: string): boolean {
  return terminalOnlyAxes(harness).length === 0;
}

/**
 * **그 세션이 도는 자리** 때문에 웹에서 못 하는 축들 (#2439, 2026-09-01).
 *
 *  ── 왜 하네스 축만으론 부족한가 ────────────────────────────────────────────────
 *  위 표는 «이 하네스가 프로토콜로 무엇을 주나» 를 잰다. 그런데 그 프로토콜을 **누가 듣고 있나**
 *  는 다른 질문이다: 대화 런타임은 **게이트웨이가 프로세스를 띄울 수 있는 세션**에서만 돈다
 *  (deliver-prompt 의 분기 조건이 «이 박스의 tmux 에 그 세션이 있나» 다).
 *
 *  ⚠ **노드 세션**(사람 노트북에서 도는 세션)은 그 tmux 가 다른 기계에 있어 분기가 통째로
 *   건너뛰어진다 — 프롬프트는 노드 릴레이로 그 기계의 TUI 에 들어간다. 그래서 승인 물음도,
 *   작업 이벤트도 **서버에 올 길이 없다.** 기록은 훅이 **턴이 끝날 때** 중앙에 올린다.
 *
 *  ⚠ 이걸 안 세면 화면이 «웹에서 다 됩니다» 라고 **거짓말**을 한다 — 실제로 그랬고
 *   (2026-09-01 상민님 신고: "새 세션 만들었는데도 아직도 선택지 안떠"), 이 표를 만든 이유가
 *   정확히 그 «막다른 길» 을 막는 것이었다.
 */
export const NODE_BLOCKED_AXES: readonly CoverageAxis[] = ["tasks", "approve", "slash", "usage"];

/**
 * 이 **세션**이 웹에서 못 하는 축 — 하네스 축 ∪ 자리 축.
 *  ⚠ interrupt·model 은 노드에서도 된다(키 주입·슬래시 릴레이) — 안 되는 것만 센다.
 */
export function sessionTerminalOnlyAxes(harness: string, onNode: boolean): CoverageAxis[] {
  const base = terminalOnlyAxes(harness);
  if (!onNode) return base;
  const seen = new Set(base);
  return [...base, ...NODE_BLOCKED_AXES.filter((a) => !seen.has(a))];
}
