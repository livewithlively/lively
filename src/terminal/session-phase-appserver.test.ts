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
import { readFileSync } from "node:fs";
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

// ⚠ 2026-08-27 부터 **기본이 app-server** 다(codex-chat-mode.ts). 그래서 대조군은 «env 없음» 이 아니라
//  «끄는 값을 명시» 여야 한다 — 빈 env 로 두면 두 군이 같은 모드가 돼 이 표가 아무것도 안 지킨다.
const ON = {} as NodeJS.ProcessEnv;                              // 기본 = app-server
const OFF = { LIVELY_CODEX_CHAT: "tmux" } as NodeJS.ProcessEnv;  // 끈 배포(종전 판정)
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

// ── B. 열리는 화면 (2026-08-28 상민님 신고) ────────────────────────────────────────────────
//  「코덱스 열면 터미널 보이다가 몇 초 뒤에 대화창으로 넘어감」. 원인은 두 겹이었다:
//   ① 생성 응답에 chatMode 가 없었다(목록에만 실렸다) → 방금 만든 세션은 행이 얇다.
//   ② 화면이 «모르면 터미널» 로 추정했다 → 터미널로 열렸다가 목록 갱신이 오면 대화로 되돌렸다.
//  둘 다 «한 곳에서 만들고, 모르면 안전한 쪽으로» 로 고쳤다. 빈 셸을 먼저 보여주는 쪽이 사람에게 더 나쁘다.
const readSrc = (rel: string): string =>
  readFileSync(new URL("../../" + rel, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");

t("★ B1 생성 응답도 목록과 **같은 곳**에서 대화 필드를 만든다 — 갈리면 방금 만든 세션만 잘못 열린다", () => {
  const src = readSrc("src/terminal/routes.ts");
  assert.match(src, /const chatFieldsOf =/, "공용 헬퍼가 있다");
  assert.match(src, /res\.json\(\{ session: withChatFields\(session\) \}\)/, "로컬 생성 응답이 대화 필드를 싣는다");
  assert.match(src, /withChatFields\(session\), node:/, "노드 생성 응답도 싣는다");
  assert.ok(!/s\.chatMode = codexChatMode/.test(src), "목록이 헬퍼를 안 쓰고 따로 만들지 않는다");
});

t("★ B2 화면은 모를 때 터미널로 추정하지 않는다 — codex 는 이 배포의 기본이 app-server 다", () => {
  const src = readSrc("web/session-chat.ts");
  const fn = src.slice(src.indexOf("const chatFirst ="), src.indexOf("const chatFirst =") + 900);
  assert.match(fn, /harness \|\| ''\) === 'codex'/, "chatMode 가 없으면 하네스로 판단한다");
  assert.ok(!/^\s*const chatFirst = \(\): boolean => String\(target\.raw\?\.chatMode/m.test(src),
    "종전의 «모르면 터미널» 한 줄이 남아 있지 않다");
});

t("B3 추정이 틀린 배포(tmux)에서는 행이 오는 즉시 터미널로 되돌린다 — 한 방향만 마감하면 반쪽이다", () => {
  const src = readSrc("web/session-chat.ts");
  assert.match(src, /chatMode \|\| ''\) === 'tmux' && opts\.terminalSrc && isBox\) setMode\('term'\)/);
});
