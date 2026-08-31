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
  "approve",       // 승인 요청에 답한다
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
    axes: { read: "ok", send: "ok", tasks: "ok", approve: "terminal", slash: "ok", usage: "ok", interrupt: "ok", model: "ok" },
    notes: {
      //  ⚠ 한때 "ok" 로 적었다가 **되돌린 자리**다(2026-09-01). 상민님이 "왜 대화창에 선택지 안뜨냐" 고
      //   신고했고, 다시 재 보니 나는 그 물음을 **한 번도 재현한 적이 없었다**. 짐작을 표에 적은 것이다.
      //
      //   시도한 것(전부 실패 — 다음 사람이 같은 길을 다시 걷지 않게 적는다):
      //    · `--permission-mode manual` — init 이 계속 `default` 로 온다(플래그가 안 먹는다).
      //    · `--permission-prompt-tool stdio` — tools 가 438→441 로 늘어 플래그는 먹지만 물음은 0건.
      //      그 값의 근거였던 "permission prompts reach the host over stdio" 문구는 다시 보니
      //      **클라우드 세션용 옵션 검증표**에 있는 것이라 로컬 -p 모드의 계약이 아닐 수 있다.
      //    · `--settings '{"permissions":{"defaultMode":"manual","allow":[]}}'` — init 은 여전히 default.
      //    · `--settings '{"hooks":{}}'` — 훅은 여전히 4건 뜬다(설정이 병합이라 못 지운다).
      //    · Agent SDK 식 `control_request{subtype:"initialize"}` 핸드셰이크 — CLI 가 같은 봉투로
      //      request_id 를 짝맞춰 응답한다(우리 응답 **모양**은 맞다는 증거). 그래도 물음은 0건.
      //
      //   확인된 것: 우리 쪽 왕복 배선과 control_response 봉투는 맞다(permission-roundtrip.test).
      //   모르는 것: **claude 가 -p/stream-json 에서 can_use_tool 을 내는 조건**. 그걸 모르는 채로
      //   "ok" 를 적으면 사람은 웹에서 승인을 찾다가 못 찾는다 — 그게 신고된 그 증상이다.
      approve: "claude 가 -p/stream-json 에서 승인을 묻게 하는 조건을 못 찾았다(5가지 시도 전부 0건 — 위 주석). 우리 왕복은 준비돼 있으나 물음이 안 와서 «된다» 고 적지 않는다.",
    },
  },
  {
    harness: "codex",
    axes: { read: "ok", send: "ok", tasks: "ok", approve: "ok", slash: "n/a", usage: "ok", interrupt: "ok", model: "terminal" },
    notes: {
      slash: "codex 는 슬래시가 TUI 전용이다 — app-server 프로토콜로 목록이 노출되지 않는다(벤더 미제공).",
      model: "thread/start 에서만 정해진다 — 도는 중 전환하는 RPC 가 app-server 스키마에 없고, 카탈로그에도 runtimeCmd 가 없다.",
    },
  },
  {
    harness: "grok",
    axes: { read: "ok", send: "ok", tasks: "ok", approve: "ok", slash: "ok", usage: "terminal", interrupt: "ok", model: "ok" },
    notes: {
      usage: "토큰 사용량을 주는 알림을 이번 실측 턴에서 못 봤다 — 안 본 것을 짐작해 «된다» 로 적지 않는다.",
    },
  },
  {
    harness: "opencode",
    axes: { read: "ok", send: "ok", tasks: "ok", approve: "ok", slash: "terminal", usage: "terminal", interrupt: "ok", model: "terminal" },
    notes: {
      slash: "OpenAPI 에 /session/{id}/command 는 있으나 **쓸 수 있는 명령 목록**을 주는 이벤트를 못 찾았다.",
      usage: "이벤트 스트림에서 사용량·한도 축을 못 봤다(session.idle 만 온다).",
      model: "카탈로그에 runtimeCmd 가 없다(도는 중 모델을 바꾸는 슬래시가 확인 안 됨) — /runtime 이 409 로 «터미널에서» 라고 사실대로 답한다.",
    },
  },
  {
    harness: "antigravity",
    axes: { read: "ok", send: "ok", tasks: "ok", approve: "terminal", slash: "terminal", usage: "ok", interrupt: "ok", model: "terminal" },
    notes: {
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
