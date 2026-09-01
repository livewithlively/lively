// 세션 런타임 모드 판정 표 (#2439). 「입력 조합 × 기대」 — 행마다 단언 1개.
//
//  이 표가 지키는 것: **미실측 하네스를 chat 으로 열지 않는다.** 그러면 pane 은 셸인데 대화창은
//  아무것도 못 받아 «말 걸 곳이 없는 빈 화면» 이 된다 — 가장 나쁜 조합이다.
import assert from "node:assert/strict";
import { harnessSupportsChat, paneIsShell, sessionRuntimeDefault, sessionRuntimeMode } from "./session-runtime-mode.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const CHAT = { LIVELY_SESSION_RUNTIME: "chat" } as NodeJS.ProcessEnv;
const TERM = { LIVELY_SESSION_RUNTIME: "terminal" } as NodeJS.ProcessEnv;
const NONE = {} as NodeJS.ProcessEnv;

t("[1] 기본은 chat — 전제(pane 이 셸)를 채운 뒤에 뒤집었다(2026-09-01 ④)", () => {
  //  ⚠ 이 값은 하루에 세 번 바뀌었다: terminal → chat(사고) → terminal(되돌림) → chat(전제 채움).
  //   ②가 사고였던 이유는 세션 생성이 그대로 TUI 를 띄워 **한 대화에 하네스가 둘** 붙었기 때문이다.
  //   지금은 catalog.chatRuntimePaneArgv 가 pane 을 셸로 연다(catalog.test 가 그 계약을 지킨다).
  assert.equal(sessionRuntimeDefault(NONE), "chat");
  assert.equal(sessionRuntimeMode({ harness: "claude" }, NONE), "chat");
});

t("[2] ★ 되돌리는 길은 env 하나 — 배포에서 문제가 보이면 코드를 안 고치고 끈다", () => {
  assert.equal(sessionRuntimeDefault(TERM), "terminal");
  assert.equal(sessionRuntimeMode({ harness: "claude" }, TERM), "terminal");
  //  대소문자·공백은 관대하게 — 끄려던 사람이 오타 하나로 못 끄면 안 된다.
  assert.equal(sessionRuntimeDefault({ LIVELY_SESSION_RUNTIME: " Terminal " } as NodeJS.ProcessEnv), "terminal");
  //  ⚠ 모르는 값은 chat 이다(기본으로 접는다) — **끄기는 명시적이어야** 한다.
  assert.equal(sessionRuntimeDefault({ LIVELY_SESSION_RUNTIME: "TERMINALL" } as NodeJS.ProcessEnv), "chat");
  assert.equal(sessionRuntimeMode({ harness: "claude" }, CHAT), "chat");
});

t("[3] ★ 아직 못 여는 하네스는 켜도 terminal — 빈 화면을 만들지 않는다", () => {
  for (const h of ["shell", "", "wat"]) {
    assert.equal(sessionRuntimeMode({ harness: h }, CHAT), "terminal", h);
  }
  assert.equal(harnessSupportsChat("claude"), true);
  //  codex 는 전용 런타임(codex-chat-runtime)이 기동을 쥐고 버스로 흘린다 — 표의 runsVia 가 그 사실이다.
  assert.equal(harnessSupportsChat("codex"), true);
  //  ★ 2026-09-01 로그인 후 실측으로 전 왕복이 확인돼 열렸다(initialize→session/new→session/prompt).
  assert.equal(harnessSupportsChat("grok"), true);
  //  opencode 는 **전용 기동 문**(서버→세션→SSE)이 생겨 열렸다 — 로그인 없이 세션까지 만들어진다(실측).
  assert.equal(harnessSupportsChat("opencode"), true);
  //  antigravity 도 전용 문(턴마다 프로세스 + --conversation)으로 열렸다.
  assert.equal(harnessSupportsChat("antigravity"), true);
});

t("[4] ★ 로그인 전용 세션은 언제나 terminal — 그 세션의 일은 대화가 아니라 로그인이다", () => {
  assert.equal(sessionRuntimeMode({ harness: "claude", loginFor: "claude" }, CHAT), "terminal");
  assert.equal(sessionRuntimeMode({ harness: "claude", loginFor: "claude", choice: "chat" }, CHAT), "terminal",
    "사람이 골랐어도 로그인 세션은 예외다");
});

t("[5] 사람이 고른 값이 배포 기본을 이긴다 — 양방향", () => {
  assert.equal(sessionRuntimeMode({ harness: "claude", choice: "chat" }, NONE), "chat");
  assert.equal(sessionRuntimeMode({ harness: "claude", choice: "terminal" }, CHAT), "terminal");
  //  안 고른 것(null·undefined)은 «terminal 을 골랐다» 가 아니다 — 기본으로 내려간다.
  assert.equal(sessionRuntimeMode({ harness: "claude", choice: null }, CHAT), "chat");
  assert.equal(sessionRuntimeMode({ harness: "claude", choice: undefined }, CHAT), "chat");
  //  배포가 terminal 로 못박아도 사람이 고른 chat 이 이긴다(양방향이라는 말의 나머지 절반).
  assert.equal(sessionRuntimeMode({ harness: "claude", choice: "chat" },
    { LIVELY_SESSION_RUNTIME: "terminal" } as NodeJS.ProcessEnv), "chat");
});

t("[6] paneIsShell 은 모드와 **다른 질문**이다 — 한 함수가 두 뜻을 겸하면 거짓 안내가 나간다", () => {
  assert.equal(paneIsShell("chat"), true);
  assert.equal(paneIsShell("terminal"), false, "terminal 모드의 claude pane 은 진짜 TUI 다(승인·로그인이 거기서 뜬다)");
});

t("[7] env 를 안 주면 process.env — 호출부가 매번 넘기지 않아도 된다", () => {
  const saved = process.env.LIVELY_SESSION_RUNTIME;
  try {
    process.env.LIVELY_SESSION_RUNTIME = "terminal";
    assert.equal(sessionRuntimeMode({ harness: "claude" }), "terminal");
    delete process.env.LIVELY_SESSION_RUNTIME;
    assert.equal(sessionRuntimeMode({ harness: "claude" }), "chat");   // 안 세우면 기본(chat)
  } finally {
    if (saved === undefined) delete process.env.LIVELY_SESSION_RUNTIME;
    else process.env.LIVELY_SESSION_RUNTIME = saved;
  }
});

console.log(`\n${pass}건 통과`);
