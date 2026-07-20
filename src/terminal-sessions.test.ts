// 단위 체크(node:assert) — '확인 필요'(waiting) pane 판정. 픽스처는 tmux capture-pane 실측(#853).
// 실행: npm run build && node dist/terminal-sessions.test.js
import assert from "node:assert/strict";
import { detectAwaiting, modeEnvArgs } from "./terminal-sessions.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// 입력창(모드 푸터 포함) — 다이얼로그가 없을 때 pane 하단에 늘 있는 것.
const INPUT_BOX = [
  "─".repeat(120),
  "❯ ",
  "─".repeat(120),
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

t("끝난 대화 + 하단 입력창 → 대기 아님", () => {
  assert.equal(detectAwaiting(["⏺ 답변입니다.", "", INPUT_BOX].join("\n")), false);
});

// #853 회귀: Claude Code 는 과거 사용자 메시지도 '❯ ' 로 그린다 → 번호목록을 보낸 세션의 전사에
// "❯ 1. …" 이 남아 승인 커서로 오인됐다(끝난 대화가 영구 '확인 필요' 빨강).
t("전사에 남은 사용자의 번호목록 메시지 → 대기 아님(#853 오탐)", () => {
  const pane = [
    "❯ 1. 최근에 위키를 열어보셨던 때에는 무엇을 하려고 들어가셨나요?",
    "",
    "  2. 노션에서는 늘 하는데 라이블리 위키에서는 안 되거나 훨씬 번거로운 것 2~3개만 꼽아주신다면?",
    "",
    "⏺ 비나용 2차 질문 세트입니다 — 확정하신 1차 5문항과 겹치지 않는 각도로 6문항입니다.",
    "",
    "✻ Baked for 2m 17s",
    INPUT_BOX,
  ].join("\n");
  assert.equal(detectAwaiting(pane), false);
});

t("사용자가 입력창에 번호목록을 타이핑 중 → 대기 아님", () => {
  const pane = ["⏺ 네.", "─".repeat(120), "❯ 1. 첫째 2. 둘째", "─".repeat(120), "  ⏸ manual mode on · ? for shortcuts"].join("\n");
  assert.equal(detectAwaiting(pane), false);
});

// 실측: Write 툴 승인 다이얼로그. 문구가 "Do you want to proceed?" 가 아니라 툴별로 다르다.
t("승인 다이얼로그(파일 생성) → 대기", () => {
  const pane = [
    "❯ Create a file named hello.txt containing the word hi, in the current directory.",
    "",
    "⏺ Write(hello.txt)",
    "─".repeat(120),
    " Create file",
    " hello.txt",
    "╌".repeat(120),
    "  1 hi",
    "╌".repeat(120),
    " Do you want to create hello.txt?",
    " ❯ 1. Yes",
    "   2. Yes, allow all edits during this session (shift+tab)",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend",
  ].join("\n");
  assert.equal(detectAwaiting(pane), true);
});

// 실측: AskUserQuestion 선택 메뉴.
t("질문 선택 메뉴 → 대기", () => {
  const pane = [
    "❯ Ask me which color I prefer.",
    " ☐ Color",
    "Which color do you prefer, red or blue?",
    "",
    "❯ 1. Red",
    "     Warm, bold, high-energy.",
    "  2. Blue",
    "     Cool, calm, steady.",
    "  3. Type something.",
    "  4. Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  assert.equal(detectAwaiting(pane), true);
});

t("Bash 승인 다이얼로그(Do you want to proceed?) → 대기", () => {
  const pane = [
    "⏺ Bash(rm -rf build)",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No, and tell Claude what to do differently (esc)",
    "",
    " Esc to cancel",
  ].join("\n");
  assert.equal(detectAwaiting(pane), true);
});

t("빈 pane → 대기 아님", () => {
  assert.equal(detectAwaiting(""), false);
});

// ── 실행 모드(#1007+) 격리 pane env 인자 — 전이기 dual-env 계약(x-lively-mode 미전파 박스 안전, #1007 리뷰 지적) ──
t("modeEnvArgs: normal(플래그 없음) → env 인자 없음", () => {
  assert.deepEqual(modeEnvArgs({}), []);
  assert.deepEqual(modeEnvArgs({ readOnly: false, incognito: false }), []);
});
t("modeEnvArgs: readonly → LIVELY_MODE=readonly + 전이기 구 LIVELY_READONLY=1", () => {
  assert.deepEqual(modeEnvArgs({ readOnly: true }), ["-e", "LIVELY_MODE=readonly", "-e", "LIVELY_READONLY=1"]);
});
t("modeEnvArgs: incognito → LIVELY_MODE=incognito + 구 LIVELY_INCOGNITO=1 + LIVELY_OFF=1(훅 off)", () => {
  assert.deepEqual(modeEnvArgs({ incognito: true }), ["-e", "LIVELY_MODE=incognito", "-e", "LIVELY_INCOGNITO=1", "-e", "LIVELY_OFF=1"]);
});
t("modeEnvArgs: 둘 다면 incognito 가 이긴다(더 강한 격리)", () => {
  assert.deepEqual(modeEnvArgs({ readOnly: true, incognito: true }), ["-e", "LIVELY_MODE=incognito", "-e", "LIVELY_INCOGNITO=1", "-e", "LIVELY_OFF=1"]);
});

console.log(`\n${pass} passed`);
