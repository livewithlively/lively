// app-server 세션의 **살아있음** 판정 (#2055) — 순수 표만 본다(tmux·프로세스 없음).
//
//  ── 왜 이 표가 필요한가 (실측 2026-08-26, 사용자 신고) ──
//  app-server 세션의 pane 은 **셸**이다(설계: 대화는 app-server 가 돈다). 그런데 살아있음 판정은
//  "pane 에 하네스 프로세스가 도나"였다 — 그래서 멀쩡히 도는 codex 세션이 전부 `exited` 로 잡혔고,
//  화면은 그 값을 보고 **'셸'** 이라 부르며 상태를 영영 idle 로 뒀다. 사용자에게는 이렇게 보였다:
//  "멈춤 버튼도 없고 · 큐된 상태도 안 보이고 · 코덱스인데 클로드 대기화면".
//  즉 **한 줄의 판정이 대화창 전체를 못 쓰게 만들었다.** 그래서 그 갈래를 표로 못박는다.
//
//  판정의 정본은 두 곳이다:
//   ① sessions.ts 목록 — 여기서 검증하는 조합 규칙
//   ② codexChatPhase — 런타임이 들고 있는 사실(도는 턴 · 대기 중 승인)
import assert from "node:assert/strict";
import { codexChatMode } from "./codex-chat-mode.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

/**
 * sessions.ts 의 상태 결정을 그대로 옮긴 것(같은 순서·같은 조건).
 *  ⚠ 제품 코드와 **문자열까지** 같아야 의미가 있다 — 여기가 갈라지면 이 표는 아무것도 안 지킨다.
 */
function agentState(i: {
  harness: string; offline: boolean; attached: number;
  phase: "busy" | "waiting" | "idle";
  asPhase: "busy" | "waiting" | "idle" | null;
  reported?: "busy" | "waiting" | null;
}, env: NodeJS.ProcessEnv): string {
  const shellHarness = !i.harness || i.harness === "shell";
  const appServer = codexChatMode({ harness: i.harness }, env) === "app-server";
  return shellHarness ? "shell"
    : appServer ? (i.asPhase ?? (i.reported === "waiting" ? "waiting" : "idle"))
    : i.offline ? "exited"
    : i.attached <= 0 ? "offline"
    : i.phase;
}

const ON = { LIVELY_CODEX_CHAT: "app-server" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;
const base = { harness: "codex", offline: true, attached: 0, phase: "idle" as const, asPhase: null };

t("★ A1 pane 이 셸이어도 '종료됨'이 아니다 — app-server 세션에선 그게 정상이다", () => {
  assert.equal(agentState({ ...base, asPhase: "idle" }, ON), "idle");
  // 대조군: 스위치가 꺼진 배포에서는 종전 판정 그대로여야 한다(회귀 방지).
  assert.equal(agentState({ ...base }, OFF), "exited");
});

t("★ A2 탭을 안 보고 있어도 'offline' 이 아니다 — 이 세션의 기본 화면은 터미널이 아니다", () => {
  assert.equal(agentState({ ...base, offline: false, attached: 0, asPhase: "idle" }, ON), "idle");
  assert.equal(agentState({ ...base, offline: false, attached: 0 }, OFF), "offline");
});

t("★ A3 턴이 돌면 busy — pane 스피너가 아니라 런타임이 사실이다(셸엔 스피너가 없다)", () => {
  assert.equal(agentState({ ...base, asPhase: "busy" }, ON), "busy");
});

t("★ A4 승인 대기는 무엇보다 먼저 — 사람이 답해야 진행된다", () => {
  assert.equal(agentState({ ...base, asPhase: "waiting" }, ON), "waiting");
});

t("A5 런타임이 아직 안 열렸으면(첫 지시 전) idle — '종료됨'으로 부르지 않는다", () => {
  assert.equal(agentState({ ...base, asPhase: null }, ON), "idle");
});

t("A6 런타임이 없어도 훅이 '확인 대기'를 보고했으면 그 말을 쓴다(신뢰 대화상자 등)", () => {
  assert.equal(agentState({ ...base, asPhase: null, reported: "waiting" }, ON), "waiting");
});

t("A7 셸 하네스는 그대로 shell — app-server 갈래에 끌려들어오지 않는다", () => {
  assert.equal(agentState({ ...base, harness: "shell", asPhase: "busy" }, ON), "shell");
});

t("A8 claude 세션은 스위치가 켜져 있어도 종전 판정 그대로다(이 갈래는 codex 전용)", () => {
  assert.equal(agentState({ ...base, harness: "claude" }, ON), "exited");
  assert.equal(agentState({ ...base, harness: "claude", offline: false, attached: 1, phase: "busy" }, ON), "busy");
});

console.log(`\n${pass} passed`);
