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

t("★ B2 화면은 모를 때 터미널로 추정하지 않는다 — 기본은 서버 capability, 구 서버 행이면 하네스로 폴백", () => {
  const src = readSrc("web/session-chat.ts");
  //  #2439 — 기본 보기의 정본이 **서버**(행의 chat.chatFirst)로 올라갔다. 화면이 하네스를 하드코딩하면
  //   또 갈린다(살아 있는 claude=터미널 / 멈춘 claude=대화창 이 정확히 그 사고였다).
  assert.match(src, /const chatFirst = \(\): boolean => caps\(\)\.chatFirst;/, "기본 보기는 서버 capability 가 정한다");
  //  구 서버 행엔 그 축이 없다 — **그때만** 종전 판정으로 내려간다. 이 폴백이 사라지면 옛 배포에서 화면이 뒤집힌다.
  const fb = src.slice(src.indexOf("const legacyChatFirst ="), src.indexOf("const legacyChatFirst =") + 400);
  assert.match(fb, /harness \|\| ''\) === 'codex'/, "구 서버 폴백은 chatMode 가 없으면 하네스로 판단한다");
  assert.ok(!/^\s*const chatFirst = \(\): boolean => String\(target\.raw\?\.chatMode/m.test(src),
    "종전의 «모르면 터미널» 한 줄이 남아 있지 않다");
});

//  ⚠ #2439 에서 이 계약이 **뒤집혔다.** 종전 B3 는 «chatMode 가 tmux 면 행이 오는 즉시 터미널로 되돌린다» 를
//   지켰다 — 기본 보기를 chatMode 로 추정하던 시절의 마감이었다. 이제 기본 보기는 하네스 **능력**(서버
//   capability)에서 나오므로 추정 자체가 없고, 그 되돌림은 **claude 를 터미널로 도로 보내 화면 통일을 깬다**
//   (claude 는 chatMode 가 tmux 인데 대화창이 기본이다). 그래서 «있어야 한다» 를 «없어야 한다» 로 바꾼다.
t("B3 기본 보기는 행이 와도 뒤집히지 않는다 — tmux 되돌림이 되살아나면 화면이 다시 갈린다 (#2439)", () => {
  const src = readSrc("web/session-chat.ts");
  assert.ok(!/chatMode \|\| ''\) === 'tmux' && opts\.terminalSrc && isBox\) setMode\('term'\)/.test(src),
    "tmux 되돌림이 남아 있지 않다");
  //  다만 **반대 방향 마감은 남아 있어야 한다** — 실시간 층이 뒤늦게 붙은 세션은 대화로 올려 준다.
  assert.match(src, /if \(!hadLive && live && !modeChosen && mode === 'term'\) setMode\('chat'\);/,
    "실시간 층이 붙으면 대화로 올리는 마감은 유지된다");
});
