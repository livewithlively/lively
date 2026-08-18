// 순수 단위 체크(node:assert) — 첫 지시 주입 판정(#1719 홈 입력창). 실행부(폴링·send-keys)는 tmux 를 띄우므로 안 잰다.
//  사양(스크래치 spec.md §A) 엣지 12행을 행마다 시나리오로. 지키는 것: **입력창이 보이기 전엔 절대 안 넣는다**(부팅 중·신뢰
//  대화상자·로그인 화면) · 신뢰 대화상자는 세션 전용 폴더에서만 대신 누른다 · 비-Claude 는 하네스가 포그라운드가 된 뒤 정착 6s ·
//  상한 초과면 포기 · 하단 14줄만 본다.
import assert from "node:assert/strict";
import { firstPromptStep, tailOf } from "./session-first-prompt.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const CLAUDE_READY = [
  "╭──────────────────────────────╮",
  "│ ❯                            │",
  "╰──────────────────────────────╯",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ? for shortcuts",
].join("\n");
const CLAUDE_BOOT = "\n\n   Loading…\n";
const TRUST = [
  " Do you trust the files in this folder?",
  " /home/box_yoon/box/sessions/box-yoon-1",
  "",
  " ❯ 1. Yes, proceed",
  "   2. No, exit",
  "",
  " Enter to confirm · Esc to exit",
].join("\n");
const LOGIN = "\n Welcome to Claude Code\n\n Select login method:\n ❯ 1. Claude account with subscription\n   2. Anthropic Console account\n";
const base = { harness: "claude", paneCmd: "node", elapsedMs: 3000, maxMs: 90_000, trustOk: true };

t("[1] 입력창이 보이면 send", () => assert.equal(firstPromptStep({ ...base, pane: CLAUDE_READY }), "send"));
t("[2] 부팅 중(아무 표식 없음)은 wait", () => assert.equal(firstPromptStep({ ...base, pane: CLAUDE_BOOT }), "wait"));
t("[3] 신뢰 대화상자 + 세션 전용 폴더 → accept-trust", () => assert.equal(firstPromptStep({ ...base, pane: TRUST }), "accept-trust"));
t("[4] 신뢰 대화상자 + 사람이 고른 폴더(trustOk=false) → wait(대신 안 누른다)", () => assert.equal(firstPromptStep({ ...base, pane: TRUST, trustOk: false }), "wait"));
t("[5] 로그인 화면은 wait(입력창이 아니다) → 결국 시간 초과로 give-up", () => {
  assert.equal(firstPromptStep({ ...base, pane: LOGIN }), "wait");
  assert.equal(firstPromptStep({ ...base, pane: LOGIN, elapsedMs: 90_001 }), "give-up");
});
t("[6] 시간 초과는 화면과 무관하게 give-up(입력창이 보여도)", () => assert.equal(firstPromptStep({ ...base, pane: CLAUDE_READY, elapsedMs: 100_000 }), "give-up"));
t("[6b] 경계 — 경과 == 상한은 초과가 아니다(send) · 상한+1 은 give-up", () => {
  assert.equal(firstPromptStep({ ...base, pane: CLAUDE_READY, elapsedMs: 90_000 }), "send");
  assert.equal(firstPromptStep({ ...base, pane: CLAUDE_READY, elapsedMs: 90_001 }), "give-up");
});
t("[7] 전사(옛 대화)에 표식이 있어도 하단 14줄만 본다", () => {
  const pane = ["? for shortcuts", ...Array.from({ length: 20 }, (_, i) => `line ${i}`)].join("\n");
  assert.equal(firstPromptStep({ ...base, pane }), "wait");
  assert.equal(tailOf(pane).length, 14);
  assert.ok(!tailOf(pane).includes("? for shortcuts"));
});
t("[8] 비-Claude 하네스 — 포그라운드가 셸이면 경과와 무관하게 wait", () => {
  assert.equal(firstPromptStep({ ...base, harness: "codex", paneCmd: "bash", pane: "", elapsedMs: 10_000 }), "wait");
  assert.equal(firstPromptStep({ ...base, harness: "codex", paneCmd: "-zsh", pane: "", elapsedMs: 60_000 }), "wait");
});
t("[9] 비-Claude 하네스 — 하네스가 떴어도 정착 6s 전엔 wait(5999) · 정확히 6000 이면 send(경계)", () => {
  assert.equal(firstPromptStep({ ...base, harness: "codex", paneCmd: "codex", pane: "", elapsedMs: 5999 }), "wait");
  assert.equal(firstPromptStep({ ...base, harness: "codex", paneCmd: "codex", pane: "", elapsedMs: 6000 }), "send");
});
t("[10] 비-Claude 하네스도 신뢰 대화상자가 보이면 하네스 규칙보다 먼저 그걸 처리한다", () => assert.equal(firstPromptStep({ ...base, harness: "codex", paneCmd: "codex", pane: TRUST, elapsedMs: 8000 }), "accept-trust"));
t("[11] 새 입력 부재 — claude · pane=\"\" · paneCmd=\"\" 은 wait(넣지 않는다)", () => assert.equal(firstPromptStep({ ...base, pane: "", paneCmd: "" }), "wait"));
t("[12] 비-Claude · paneCmd=\"\"(포그라운드 모름)는 wait", () => assert.equal(firstPromptStep({ ...base, harness: "opencode", paneCmd: "", pane: "", elapsedMs: 30_000 }), "wait"));

console.log(`session-first-prompt: ${pass} passed`);
