// codex 대화 런타임 선택 계약 (#2055 P2-B) — **기본은 종전(tmux)** 이라는 것이 이 표의 요점이다.
//  App Server 는 공식 문서가 experimental 로 못박은 표면이라, 켜는 것은 배포의 명시적 선택이어야 하고
//  오타·부분일치로 조용히 켜지면 안 된다(그 순간 pane 이 TUI 대신 셸로 바뀐다 — 눈에 띄는 회귀다).
import assert from "node:assert/strict";
import { codexChatMode, codexChatModeDefault } from "./codex-chat-mode.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const E = (v?: string): NodeJS.ProcessEnv => (v === undefined ? {} : { LIVELY_CODEX_CHAT: v });

t("R1 기본은 tmux — env 가 없으면 종전 동작 그대로", () => {
  assert.equal(codexChatModeDefault(E()), "tmux");
  assert.equal(codexChatMode({ harness: "codex" }, E()), "tmux");
});

t("R2 정확히 app-server 일 때만 켠다(대소문자·공백은 허용)", () => {
  assert.equal(codexChatModeDefault(E("app-server")), "app-server");
  assert.equal(codexChatModeDefault(E("  App-Server ")), "app-server");
});

t("★ R3 오타·부분일치로는 안 켜진다 — 조용한 전환 금지", () => {
  for (const v of ["appserver", "app_server", "app-server2", "1", "true", "on", "yes", ""]) {
    assert.equal(codexChatModeDefault(E(v)), "tmux", `'${v}' 로는 켜지면 안 된다`);
  }
});

t("★ S1 codex 가 아닌 하네스는 언제나 tmux(다른 하네스는 이 경로를 안 탄다)", () => {
  for (const h of ["claude", "opencode", "antigravity", "grok", "shell", ""]) {
    assert.equal(codexChatMode({ harness: h }, E("app-server")), "tmux", h);
  }
});

t("★ S2 로그인 전용 세션은 언제나 tmux — 그 세션의 일은 대화가 아니라 codex login 이다", () => {
  assert.equal(codexChatMode({ harness: "codex", loginFor: "codex" }, E("app-server")), "tmux");
  assert.equal(codexChatMode({ harness: "codex", loginFor: null }, E("app-server")), "app-server");
});

console.log(`\n${pass} passed`);
