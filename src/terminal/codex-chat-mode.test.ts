// codex 대화 런타임 선택 — 값 표 (#2055 P2-B · 기본 뒤집기 #4135)
//
//  ★ 이 표가 지키는 것은 «기본값» 이 아니라 **«이미 떠 있는 세션의 판정이 안 뒤집힌다»** 이다.
//   종전 판정은 배포 기본값만 봤다 — 그래서 기본을 뒤집는 순간 살아 있는 app-server 세션(pane=셸)이 tmux 로
//   읽히고, 사람의 프롬프트가 send-keys 로 **셸에 타이핑**됐을 것이다(#3982 의 그 사고). 이제 세션이 태어날 때
//   모드를 표식(@box_runtime)에 박고, 읽는 자리는 전부 그 표식을 본다.
//  사양·엣지 표: 스크래치 spec.md. 표의 **행마다 시나리오 하나** — red 는 mutation 셋으로 눈으로 봤다(A·B·C).
import assert from "node:assert/strict";
import { codexChatMode, codexChatModeForNew, codexModeStampFor, CODEX_STAMP_APP_SERVER, CODEX_STAMP_TMUX } from "./codex-chat-mode.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const E = (v?: string): NodeJS.ProcessEnv => (v === undefined ? {} : { LIVELY_CODEX_CHAT: v });

// ── 새 세션의 기본 ────────────────────────────────────────────────────────────────
t("[N1] ★ 새 codex 세션의 기본은 tmux — 터미널에 TUI 가 뜬다(원준님 지시 2026-09-25, 클로드와 같은 상태)", () => {
  assert.equal(codexChatModeForNew(E()), "tmux");
});
t("[N2] 켜는 길은 남는다 — LIVELY_CODEX_CHAT=app-server (대소문자·공백 허용)", () => {
  assert.equal(codexChatModeForNew(E("app-server")), "app-server");
  assert.equal(codexChatModeForNew(E("  App-Server ")), "app-server");
});
t("[N3] 명시적 tmux 도 tmux", () => { assert.equal(codexChatModeForNew(E("tmux")), "tmux"); });
t("[N4] 참값 흉내·오타로는 안 켜진다 — 전부 기본(tmux)", () => {
  for (const v of ["", " ", "1", "on", "yes", "chat", "appserver", "app server"]) {
    assert.equal(codexChatModeForNew(E(v)), "tmux", `'${v}' 로는 켜지면 안 된다`);
  }
});

// ── 이미 떠 있는 세션 읽기 — 표식이 정본 ────────────────────────────────────────────
t("[R1] ★★ 표식이 없는 codex 세션(= 이 변경 전에 태어난 세션)은 app-server 로 읽는다 — 그 pane 은 셸이다", () => {
  assert.equal(codexChatMode({ harness: "codex" }, E()), "app-server");
});
t("[R2] 표식 app-server → app-server", () => {
  assert.equal(codexChatMode({ harness: "codex", stamp: CODEX_STAMP_APP_SERVER }, E()), "app-server");
});
t("[R3] 표식 terminal → tmux", () => {
  assert.equal(codexChatMode({ harness: "codex", stamp: CODEX_STAMP_TMUX }, E()), "tmux");
});
t("[R4] ★★ 표식이 배포 기본을 **이긴다** — app-server 로 켠 배포에서도 terminal 표식이면 tmux", () => {
  assert.equal(codexChatMode({ harness: "codex", stamp: CODEX_STAMP_TMUX }, E("app-server")), "tmux");
});
t("[R5] ★★ 반대 방향도 이긴다 — tmux 로 끈 배포에서도 app-server 표식이면 app-server", () => {
  assert.equal(codexChatMode({ harness: "codex", stamp: CODEX_STAMP_APP_SERVER }, E("tmux")), "app-server");
});
t("[R6] 표식이 없고 그 배포가 tmux 로 꺼 두고 있었다면 tmux — 그 세션들은 그렇게 떴다", () => {
  assert.equal(codexChatMode({ harness: "codex" }, E("tmux")), "tmux");
});
t("[R7] 남의 축 값('chat', #2439 하네스 무관 런타임)은 표식 없음과 같이 읽는다", () => {
  assert.equal(codexChatMode({ harness: "codex", stamp: "chat" }, E()), "app-server");
});
t("[R8] ★ 빈 값·null·공백은 **부재**다(경계) — 살아 있는 세션을 tmux 로 오인하지 않는다", () => {
  for (const stamp of ["", "   ", null, undefined]) {
    assert.equal(codexChatMode({ harness: "codex", stamp }, E()), "app-server", JSON.stringify(stamp));
  }
});
t("[R9] 로그인 전용 세션은 표식보다 세다 — 언제나 tmux(`codex login` 을 칠 자리가 있어야 한다)", () => {
  assert.equal(codexChatMode({ harness: "codex", loginFor: "codex", stamp: CODEX_STAMP_APP_SERVER }, E()), "tmux");
  assert.equal(codexChatMode({ harness: "codex", loginFor: null, stamp: CODEX_STAMP_APP_SERVER }, E()), "app-server");
});
t("[R10] codex 가 아니면 언제나 tmux — 표식이 있어도 이 축을 안 탄다", () => {
  for (const h of ["claude", "opencode", "antigravity", "grok", "shell", ""]) {
    assert.equal(codexChatMode({ harness: h, stamp: CODEX_STAMP_APP_SERVER }, E()), "tmux", h);
    assert.equal(codexChatMode({ harness: h }, E("app-server")), "tmux", `${h} (켠 배포에서도)`);
  }
});
t("[R11] 표식의 대소문자·앞뒤 공백은 같은 값으로 읽는다(경계)", () => {
  assert.equal(codexChatMode({ harness: "codex", stamp: " APP-SERVER " }, E()), "app-server");
  assert.equal(codexChatMode({ harness: "codex", stamp: " Terminal " }, E()), "tmux");
});

// ── 표식에 적는 값 ────────────────────────────────────────────────────────────────
t("[S1] codex 세션은 자기 모드를 표식에 적는다", () => {
  assert.equal(codexModeStampFor("codex", "app-server"), CODEX_STAMP_APP_SERVER);
  assert.equal(codexModeStampFor("codex", "tmux"), CODEX_STAMP_TMUX);
});
t("[S2] ★ 그 밖의 하네스엔 이 표식을 **안 박는다** — 그 자리는 #2439 의 'chat' 이 쓴다", () => {
  for (const h of ["claude", "opencode", "antigravity", "grok", "shell", ""]) {
    assert.equal(codexModeStampFor(h, "app-server"), undefined, h);
    assert.equal(codexModeStampFor(h, "tmux"), undefined, h);
  }
});
t("[S3] 왕복 — 적은 값을 그대로 읽으면 같은 모드가 나온다(표식이 뜻을 잃지 않는다)", () => {
  for (const mode of ["tmux", "app-server"] as const) {
    assert.equal(codexChatMode({ harness: "codex", stamp: codexModeStampFor("codex", mode) }, E()), mode);
  }
});

console.log(`codex-chat-mode: ${pass} passed`);
