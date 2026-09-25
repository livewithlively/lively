// codex 대화 런타임 선택 계약 (#2055) — **codex 는 터미널(TUI)이 기본**이고, app-server는 명시 opt-in이다.
//
//  ⚠ 이 표는 2026-08-27 에 방향이 뒤집혔다. 처음엔 opt-in 이었다(App Server 가 experimental 이고, 켜는 순간
//   pane 이 TUI 대신 셸로 바뀌는 눈에 띄는 변화라 조용한 전환을 피했다). 뒤집은 근거는 제품 쪽에 있다:
//   매니지드 프로덕션에서 로컬·원격 노드 양쪽으로 왕복이 실측됐고, 마지막까지 경계가 비어 있던 격리
//   리눅스도 포트를 버리고 0600 유닉스 소켓으로 닫았다(codex-as-supervisor.ts). 그전까지 그 자리를
//   막고 있던 것은 «켤 때 동의를 받는 노브» 였는데, 그건 결함을 노브로 덮은 것이지 고친 게 아니었다.
//   그래서 **노브가 아니라 경계를 고치고** 기본을 뒤집었다. 이후 홈의 첫 지시가 셸에 남는 문제가 확인되어,
//   기본은 다시 TUI로 두고 app-server만 LIVELY_CODEX_CHAT=app-server로 명시 선택하게 한다.
import assert from "node:assert/strict";
import { codexChatMode, codexChatModeDefault } from "./codex-chat-mode.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const E = (v?: string): NodeJS.ProcessEnv => (v === undefined ? {} : { LIVELY_CODEX_CHAT: v });

t("★ R1 기본은 TUI — env 가 없으면 codex가 먼저 떠 첫 지시를 받는다", () => {
  assert.equal(codexChatModeDefault(E()), "tmux", "기본 세션은 Codex TUI를 열어 첫 지시를 받을 수 있어야 한다");
  assert.equal(codexChatMode({ harness: "codex" }, E()), "tmux");
});

t("★ R2 app-server는 정확한 명시값으로만 켜진다(대소문자·공백은 허용)", () => {
  assert.equal(codexChatModeDefault(E("app-server")), "app-server");
  assert.equal(codexChatModeDefault(E("  APP-SERVER ")), "app-server");
  assert.equal(codexChatMode({ harness: "codex" }, E("app-server")), "app-server");
});

t("★ R3 오타로는 app-server가 켜지지 않는다 — 기본 TUI를 지킨다", () => {
  for (const v of ["tmix", "tmux2", "0", "false", "off", "no", ""]) {
    assert.equal(codexChatModeDefault(E(v)), "tmux", `'${v}' 로는 app-server 가 켜지면 안 된다`);
  }
});

t("R4 tmux를 명시해도 기본 TUI를 유지한다(무회귀)", () => {
  assert.equal(codexChatModeDefault(E("tmux")), "tmux");
  assert.equal(codexChatModeDefault(E("  Tmux ")), "tmux");
});

t("★ R5 격리 동의 노브는 **없다** — 경계를 0600 소켓이 서므로 물어볼 것이 없다", () => {
  const legacy = { LIVELY_CODEX_CHAT_ISOLATED: "1" } as NodeJS.ProcessEnv;
  assert.equal(codexChatModeDefault(legacy), "tmux", "그 값이 있든 없든 기본은 같다");
  assert.equal(codexChatModeDefault({ ...legacy, LIVELY_CODEX_CHAT: "app-server" }), "app-server", "명시 설정만 app-server 를 켠다");
});

t("★ S1 codex 가 아닌 하네스는 언제나 tmux(다른 하네스는 이 경로를 안 탄다)", () => {
  for (const h of ["claude", "opencode", "antigravity", "grok", "shell", ""]) {
    assert.equal(codexChatMode({ harness: h }, E()), "tmux", h);
  }
});

t("★ S2 로그인 전용 세션은 언제나 tmux — 그 세션의 일은 대화가 아니라 codex login 이다", () => {
  assert.equal(codexChatMode({ harness: "codex", loginFor: "codex" }, E()), "tmux");
  assert.equal(codexChatMode({ harness: "codex", loginFor: null }, E()), "tmux");
});

console.log(`\n${pass} passed`);
