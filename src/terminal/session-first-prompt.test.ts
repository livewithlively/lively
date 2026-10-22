// 순수 단위 체크(node:assert) — 첫 지시 주입 판정(#1719 홈 입력창). 실행부(폴링·send-keys)는 tmux 를 띄우므로 안 잰다.
//  사양(스크래치 spec.md §A) 엣지 12행을 행마다 시나리오로. 지키는 것: **입력창이 보이기 전엔 절대 안 넣는다**(부팅 중·신뢰
//  대화상자·로그인 화면) · 신뢰 대화상자는 세션 전용 폴더에서만 대신 누른다 · 비-Claude 는 하네스가 포그라운드가 된 뒤 정착 6s ·
//  상한 초과면 포기 · 하단 14줄만 본다.
import assert from "node:assert/strict";
import {
  firstPromptStep,
  injectFirstPromptWithRuntime,
  tailOf,
  FIRST_PROMPT_BOOT_MS,
  FIRST_PROMPT_HOLD_MS,
  FIRST_PROMPT_PEEK_GRACE_MS,
  type FirstPromptRuntime,
} from "./session-first-prompt.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const CLAUDE_READY = [
  "╭──────────────────────────────╮",
  "│ ❯                            │",
  "╰──────────────────────────────╯",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ? for shortcuts",
].join("\n");
const CLAUDE_BOOT = "\n\n   Loading…\n";
const CODEX_READY = [
  "╭────────────────────────────────────────────────╮",
  "│ >_ OpenAI Codex                                │",
  "╰────────────────────────────────────────────────╯",
  "› Ask Codex to do anything",
].join("\n");
const TRUST = [
  " Do you trust the files in this folder?",
  " /home/box_yoon/box/sessions/box-yoon-1",
  "",
  " ❯ 1. Yes, proceed",
  "   2. No, exit",
  "",
  " Enter to confirm · Esc to exit",
].join("\n");
// Antigravity 신뢰 대화상자(실측 2026-08-18) — 문구·커서('>')·힌트("↑/↓ Navigate · enter Confirm")가 전부 claude 와 다르다.
const AG_TRUST = [
  " Accessing workspace: /Users/lively/box/yoon/sessions/box-yoon-ca3037ee",
  " Do you trust the contents of this project?",
  " Antigravity CLI requires permission to read, edit, and execute files here.",
  " > Yes, I trust this folder",
  "   No, exit",
  " ↑/↓ Navigate · enter Confirm",
].join("\n");
// Claude Code 2.1.245 의 **현행** 신뢰 대화상자(실측 2026-08-25, dev 노드 hammurabi/win32 pane 그대로).
//  ⚠ 문구가 바뀌었다 — 옛 정규식(`trust the files in this folder`)은 이 화면을 못 잡아 accept-trust 가 안 나고,
//   입력창도 아니므로 90초 give-up 으로 **첫 지시가 통째로 유실**됐다(프로젝트 폴더 세션에서 실제로 재현).
const TRUST_2026 = [
  "──────────────────────────────────────────────────",
  " Accessing workspace:",
  " C:\\Users\\amorite\\workspace\\project\\1950",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  " Claude Code'll be able to read, edit, and execute files here.",
  " Security guide",
  " ❯ 1. Yes, I trust this folder",
  "   2. No, exit",
  " Enter to confirm · Esc to cancel",
].join("\n");
const LOGIN = "\n Welcome to Claude Code\n\n Select login method:\n ❯ 1. Claude account with subscription\n   2. Anthropic Console account\n";
const base = { harness: "claude", paneCmd: "node", elapsedMs: 3000, maxMs: 90_000, trustOk: true };

t("[1] 입력창이 보이면 send", () => assert.equal(firstPromptStep({ ...base, pane: CLAUDE_READY }), "send"));
t("[2] 부팅 중(아무 표식 없음)은 wait", () => assert.equal(firstPromptStep({ ...base, pane: CLAUDE_BOOT }), "wait"));
t("[3] 신뢰 대화상자 + 세션 전용 폴더 → accept-trust", () => assert.equal(firstPromptStep({ ...base, pane: TRUST }), "accept-trust"));
t("[4] 신뢰 대화상자 + 사람이 고른 폴더(trustOk=false) → wait(대신 안 누른다)", () => assert.equal(firstPromptStep({ ...base, pane: TRUST, trustOk: false }), "wait"));
// ── 현행 문구(2026-08 실측) — 하네스 문구는 바뀐다. 옛 문구만 알면 그 순간부터 첫 지시가 조용히 유실된다. ──
t("[4a] 현행 Claude 신뢰 대화상자(문구 변경) + 라이블리 workspace → accept-trust", () =>
  assert.equal(firstPromptStep({ ...base, pane: TRUST_2026 }), "accept-trust"));
t("[4b] 현행 신뢰 대화상자 + 사람이 고른 폴더 → wait(대화상자에 텍스트를 밀어 넣지 않는다)", () =>
  assert.equal(firstPromptStep({ ...base, pane: TRUST_2026, trustOk: false, elapsedMs: 30_000 }), "wait"));
t("[4c] 본문에 'trust' 라는 단어가 있을 뿐인 입력창은 신뢰 대화상자가 아니다(오탐 금지)", () =>
  assert.equal(firstPromptStep({ ...base, pane: CLAUDE_READY + "\n 이 폴더를 trust 해도 될까요?" }), "send"));
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


t("[AG1] Antigravity 신뢰 대화상자 + 세션 전용 폴더 → accept-trust(문구가 달라도)", () =>
  assert.equal(firstPromptStep({ ...base, harness: "antigravity", paneCmd: "antigravity", pane: AG_TRUST, elapsedMs: 8000 }), "accept-trust"));
t("[AG2] Antigravity 신뢰 대화상자 + 사람이 고른 폴더 → wait(6초가 지나도 대화상자에 텍스트를 밀어 넣지 않는다)", () =>
  assert.equal(firstPromptStep({ ...base, harness: "antigravity", paneCmd: "antigravity", pane: AG_TRUST, elapsedMs: 8000, trustOk: false }), "wait"));

// ── 사람을 기다린다(#3870) ─────────────────────────────────────────────────────────────────────
//  실측 2026-09-22(원준님 맥미니 노드, Claude Code 2.1.274): 새로 생긴 멤버 프로필에서 claude 는 첫 실행 안내를 띄운다.
//  사람이 그걸 넘기는 데 90초가 넘게 걸렸고, 주입기는 90초에 포기해 홈 [시키기] 의 첫 지시가 통째로 사라졌다.
//  이제 injectFirstPrompt 는 maxMs=FIRST_PROMPT_HOLD_MS · blindMaxMs=FIRST_PROMPT_BOOT_MS 로 판정한다.
const ONBOARD_THEME = [   // 빈 CLAUDE_CONFIG_DIR 로 `claude --dangerously-skip-permissions …` 를 띄운 첫 화면(실측 캡처)
  ".......█ █   █ █..........................░..........▒....",
  " Let's get started.",
  " Choose the text style that looks best with your terminal",
  " To change this later, run /theme",
  "   1. Auto (match terminal)",
  "   2. Dark mode",
  " ❯ 3. Light mode ✔",
  "   4. Dark mode (colorblind-friendly)",
  "   5. Light mode (colorblind-friendly)",
  "  1  function greet() {",
  "  2 -  console.log(\"Hello, World!\");",
  "  2 +  console.log(\"Hello, Claude!\");",
  "  3  }",
  "  Syntax theme: GitHub (ctrl+t to disable)",
].join("\n");
const hold = { ...base, maxMs: FIRST_PROMPT_HOLD_MS, blindMaxMs: FIRST_PROMPT_BOOT_MS };
t("[H1] 첫 실행 안내(글자 스타일 고르기)는 입력창이 아니다 → wait(대신 누르지도, 넣지도 않는다)", () =>
  assert.equal(firstPromptStep({ ...hold, pane: ONBOARD_THEME }), "wait"));
t("[H2] ★ 그 안내에 90초를 넘게 머물러도 포기하지 않는다 — 30분째에도 wait", () => {
  assert.equal(firstPromptStep({ ...hold, pane: ONBOARD_THEME, elapsedMs: FIRST_PROMPT_BOOT_MS + 1 }), "wait");
  assert.equal(firstPromptStep({ ...hold, pane: ONBOARD_THEME, elapsedMs: 30 * 60_000 }), "wait");
  assert.equal(firstPromptStep({ ...hold, pane: LOGIN, elapsedMs: 30 * 60_000 }), "wait");
});
t("[H3] ★ 사람이 안내를 넘겨 입력창이 뜨면 그때 넣는다(몇 분 뒤라도)", () =>
  assert.equal(firstPromptStep({ ...hold, pane: CLAUDE_READY, elapsedMs: 4 * 60_000 }), "send"));
t("[H4] 사람을 기다리는 창도 끝은 있다 — 상한을 넘기면 give-up", () =>
  assert.equal(firstPromptStep({ ...hold, pane: ONBOARD_THEME, elapsedMs: FIRST_PROMPT_HOLD_MS + 1 }), "give-up"));
t("[H5] 입력창을 못 알아보는 하네스의 추정 전송은 부팅 창 안에서만 — 넘기면 종전대로 give-up", () => {
  const blind = { ...hold, harness: "some-cli", paneCmd: "some-cli", pane: "" };
  assert.equal(firstPromptStep({ ...blind, elapsedMs: 10_000 }), "send");
  //  오래 지나 포그라운드가 셸이 아닌 것은 «하네스가 떴다» 가 아니라 사람이 셸에서 딴 프로그램을 켠 것일 수 있다.
  assert.equal(firstPromptStep({ ...blind, elapsedMs: FIRST_PROMPT_BOOT_MS + 1 }), "give-up");
});
t("[H6] 하네스가 죽어 셸로 떨어져도(런처 폴백) claude 는 입력창이 다시 뜰 때까지 wait — 셸에 글자를 넣지 않는다", () =>
  assert.equal(firstPromptStep({ ...hold, paneCmd: "zsh", pane: "────\nClaude Code — 예기치 않게 종료됐습니다.\n\n    claude\n\nlively@mac ~ %", elapsedMs: 5 * 60_000 }), "wait"));
t("[H7] 창의 크기 — 부팅 창 90초 · 사람을 기다리는 창은 아웃박스(NOT_READY_TTL_MS)와 같은 2시간", () => {
  assert.equal(FIRST_PROMPT_BOOT_MS, 90_000);
  assert.equal(FIRST_PROMPT_HOLD_MS, 2 * 60 * 60_000);
});

// ── codex 시작 «Update available» 창 (#4135 후속, 실측 2026-09-26 매니지드 라이브 pane) ─────────────
//  ★ 지키는 것: 이 창엔 **Enter 를 절대 보내지 않는다.** 커서가 «1. Update now» 에 있고, 그 항목은
//   `npm install -g @openai/codex` 를 돌린다 — 이미지의 전역 prefix 는 root 소유라 EACCES 로 실패하고
//   **codex 가 그대로 끝난다**(pane 이 셸이 된다). 실측으로 Escape 는 창만 닫고 codex 를 살려 둔다.
const CODEX_UPDATE = [   // 라이브 캡처 그대로(0.149.1 · npm 전역 설치)
  "  ✨ Update available! 0.149.1 -> 0.157.1",
  "  Release notes: https://github.com/openai/codex/releases/latest",
  "› 1. Update now (runs `npm install -g @openai/codex`)",
  "  2. Skip",
  "  3. Skip until next version",
  "  Press enter to continue",
].join("\n");
//  standalone 설치본의 **비차단 배너**(실측 0.149.1·0.157.1 로컬) — 선택지가 없고 입력칸이 살아 있다.
const CODEX_UPDATE_BANNER = [
  "╭─────────────────────────────────────────────────╮",
  "│ ✨ Update available! 0.149.1 -> 0.157.1         │",
  "│ Run npm install -g @openai/codex to update.     │",
  "╰─────────────────────────────────────────────────╯",
  "› Ask Codex to do anything",
  "  ? for shortcuts",
].join("\n");
const codexBase = { ...base, harness: "codex", paneCmd: "codex", elapsedMs: 8000 };
t("[U1] ★ 번호 선택지가 있는 업데이트 창 → dismiss-update(Escape — Enter 는 codex 를 죽인다)", () =>
  assert.equal(firstPromptStep({ ...codexBase, pane: CODEX_UPDATE }), "dismiss-update"));
t("[U2] 비차단 배너는 그 창이 아니다 — 입력칸이 살아 있으므로 종전 판정(send)", () =>
  assert.equal(firstPromptStep({ ...codexBase, pane: CODEX_UPDATE_BANNER }), "send"));
t("[U3] 업데이트 창이 신뢰 대화상자보다 먼저다(실측 순서) — 둘이 같이 보이면 업데이트를 먼저 닫는다", () =>
  assert.equal(firstPromptStep({ ...codexBase, pane: `${CODEX_UPDATE}\n${TRUST}` }), "dismiss-update"));
t("[U4] 본문에 «Update available» 만 있을 뿐인 화면엔 아무 키도 안 보낸다(TRUST_DIALOG 와 같은 교리)", () =>
  assert.equal(firstPromptStep({ ...codexBase, pane: "  Update available! 0.149.1 -> 0.157.1\n› Ask Codex to do anything\n  ? for shortcuts" }), "send"));
t("[U5] 사람이 고른 폴더에서도 닫는다 — 이 창은 보안 결정이 아니라 «업데이트 안 함»(보수적 답)이다", () =>
  assert.equal(firstPromptStep({ ...codexBase, pane: CODEX_UPDATE, trustOk: false }), "dismiss-update"));

// ── 시작 직후 pane 조회 실패(#4135) ────────────────────────────────────────────────────────────────
//  실제 장애는 세션 생성 직후 첫 capture-pane/display-message 실패를 «세션이 사라짐»으로 단정해 첫 지시가 버려진 것이다.
//  가짜 시계·화면으로 재시도 경계와 정확히 한 번 전송을 실행부 수준에서 잠근다.
type PeekResult = { pane: string; paneCmd: string } | "missing";
async function runInjection(results: PeekResult[], over?: { pollMs?: number; peekGraceMs?: number }) {
  let now = 0;
  let reads = 0;
  const sent: Array<{ id: string; text: string }> = [];
  const keys: string[] = [];   // #4135 후속 — **어떤 키**가 갔는지 본다(업데이트 창에 Enter 가 가면 codex 가 죽는다)
  const runtime: FirstPromptRuntime = {
    peek: async () => {
      const result = results[Math.min(reads++, results.length - 1)];
      if (result === "missing") throw new Error("pane not ready");
      return result;
    },
    sleep: async (ms) => { now += ms; },
    now: () => now,
    send: async (id, text) => { sent.push({ id, text }); },
    trustKeys: {
      down: async () => { keys.push("down"); },
      enter: async () => { keys.push("enter"); },
      esc: async () => { keys.push("esc"); },
    },
  };
  const ok = await injectFirstPromptWithRuntime(
    "box-test",
    "codex",
    "원래 첫 지시",
    { maxMs: 100_000, pollMs: over?.pollMs ?? 5, peekGraceMs: over?.peekGraceMs ?? 15 },
    runtime,
  );
  return { ok, reads, sent, now, keys };
}

let asyncPass = 0;
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); asyncPass++; console.log(`ok  ${name}`); };

await ta("[P1] 첫 화면 조회만 실패하고 입력창이 뜨면 첫 지시를 정확히 한 번 보낸다", async () => {
  const got = await runInjection(["missing", { pane: CODEX_READY, paneCmd: "codex" }]);
  assert.equal(got.ok, true);
  assert.deepEqual(got.sent, [{ id: "box-test", text: "원래 첫 지시" }]);
});
await ta("[P2] 유예 시간 안에서 여러 번 조회가 실패해도 계속 들고 있다", async () => {
  const got = await runInjection(["missing", "missing", "missing", { pane: CODEX_READY, paneCmd: "codex" }]);
  assert.equal(got.ok, true);
  assert.equal(got.reads, 4);
  assert.equal(got.sent.length, 1);
});
await ta("[P3] 정확히 유예 경계인 실패에서도 한 번 더 읽어 전송한다", async () => {
  const got = await runInjection([
    "missing", "missing", "missing", "missing",
    { pane: CODEX_READY, paneCmd: "codex" },
  ]);
  assert.equal(got.now, 20);
  assert.equal(got.ok, true);
  assert.equal(got.sent.length, 1);
});
await ta("[P4] 유예 시간을 넘도록 연속 실패하면 전송하지 않고 실패를 돌려준다", async () => {
  const got = await runInjection(["missing"]);
  assert.equal(got.ok, false);
  assert.equal(got.now, 20);
  assert.equal(got.sent.length, 0);
});
await ta("[P5] 화면이 즉시 준비됐으면 종전처럼 한 번만 전송한다", async () => {
  const got = await runInjection([{ pane: CODEX_READY, paneCmd: "codex" }]);
  assert.equal(got.ok, true);
  assert.equal(got.reads, 1);
  assert.equal(got.sent.length, 1);
});
await ta("[P6] 화면은 읽히지만 아직 준비되지 않았으면 기존 판정대로 기다린다", async () => {
  const got = await runInjection([
    { pane: CLAUDE_BOOT, paneCmd: "codex" },
    { pane: CODEX_READY, paneCmd: "codex" },
  ]);
  assert.equal(got.ok, true);
  assert.equal(got.reads, 2);
  assert.equal(got.sent.length, 1);
});
await ta("[U6] ★ 실행부 — 업데이트 창엔 **Escape 만** 가고(Enter 금지), 창이 닫히면 첫 지시가 한 번 간다", async () => {
  const got = await runInjection([
    { pane: CODEX_UPDATE, paneCmd: "codex" },
    { pane: CODEX_READY, paneCmd: "codex" },
  ]);
  assert.equal(got.ok, true);
  assert.deepEqual(got.keys, ["esc"], "Escape 하나뿐 — enter 가 섞이면 npm 설치가 돌아 codex 가 죽는다");
  assert.equal(got.sent.length, 1);
});
await ta("[U7] 창이 안 닫히면 Escape 를 상한(2)까지만 보낸다 — 폴마다 쏘지 않는다", async () => {
  const got = await runInjection([{ pane: CODEX_UPDATE, paneCmd: "codex" }], { pollMs: 5, peekGraceMs: 15 });
  assert.equal(got.ok, false);                       // 끝내 입력칸이 안 떴다 → 사람에게 남긴다
  assert.deepEqual(got.keys, ["esc", "esc"]);
});
t("[P7] 운영 기본 조회 유예는 15초다", () => assert.equal(FIRST_PROMPT_PEEK_GRACE_MS, 15_000));

// ── #4818 노드 첫 지시 — claude 면 붙여넣기로 넣고, 넣은 뒤 입력칸을 지켜 우리 글이 남으면 Enter 를 더 누른다(spec.md F1~F3) ────────
//  실측(2.1.301): 글과 Enter 가 한 덩어리로 읽히면 Enter 가 글자 CR 로 박혀(빈 줄) 제출되지 않는다. 노드 첫 지시엔 에코 확인이 없어
//   종전엔 그대로 멈췄다.
const NBSP = "\u{A0}";
const FIRST = "새 세션의 첫 지시 — 화면을 보고 넣고, 들어갔는지 화면으로 확인한다. 길게 써서 한 번에 읽히면 64자를 넘는다.";
const RULE_4818 = "─".repeat(80);
const claudeBox = (box: string[]): string => [RULE_4818, ...box, RULE_4818, "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
/** claude 첫 지시를 가짜 시계·화면으로 돌린다 — 넣기 전엔 빈 입력창, 넣은 뒤엔 after(누른 Enter 수) 화면. */
async function runClaudeFirst(after: (entersAfterSend: number) => string, harness = "claude") {
  let now = 0;
  let sentAt = -1;
  const sends: Array<{ text: string; opts: unknown }> = [];
  const keys: string[] = [];
  let entersAfterSend = 0;
  let readsAfterSend = 0;
  const ready = harness === "claude" ? claudeBox([`❯${NBSP}`]) : CODEX_READY;
  const runtime = {
    peek: async () => {
      if (sentAt < 0) return { pane: ready, paneCmd: harness };
      readsAfterSend++;
      return { pane: after(entersAfterSend), paneCmd: harness };
    },
    sleep: async (ms: number) => { now += ms; },
    now: () => now,
    send: async (_id: string, text: string, opts?: unknown) => { sends.push({ text, opts }); sentAt = now; },
    trustKeys: {
      down: async () => { keys.push("down"); },
      enter: async () => { keys.push("enter"); if (sentAt >= 0) entersAfterSend++; },
      esc: async () => { keys.push("esc"); },
    },
  } as unknown as FirstPromptRuntime;
  const ok = await injectFirstPromptWithRuntime("box-test", harness, FIRST, { maxMs: 100_000, pollMs: 5, peekGraceMs: 15 }, runtime);
  return { ok, sends, keys, readsAfterSend, elapsedAfterSend: now - sentAt };
}

await ta("[F1] claude — 붙여넣기로 넣고(opts.paste), 넣은 뒤 우리 글이 남아 있으면 Enter 를 더 누른다 · 사라지면 멈춘다", async () => {
  const stuck = claudeBox([`❯${NBSP}${FIRST}`, ""]);
  const got = await runClaudeFirst((n) => (n >= 2 ? claudeBox([`❯${NBSP}`]) : stuck));
  assert.equal(got.ok, true);
  assert.deepEqual(got.sends, [{ text: FIRST, opts: { paste: true } }]);
  assert.deepEqual(got.keys, ["enter", "enter"], "남아 있는데 안 눌렀거나, 제출된 뒤에도 눌렀다");
  assert.ok(got.readsAfterSend > 2, "배선 — 넣은 뒤 화면을 안 봤다");
});

await ta("[F2] claude — 넣은 뒤 입력칸이 비면(제출됨) Enter 0", async () => {
  const got = await runClaudeFirst(() => claudeBox([`❯${NBSP}`]));
  assert.equal(got.ok, true);
  assert.deepEqual(got.keys, [], "빈 입력칸에 Enter");
  assert.ok(got.readsAfterSend > 0, "배선 — 넣은 뒤 화면을 안 봤다");
});

await ta("[F3] codex — 종전 그대로: 붙여넣기 안 함(opts 없음) · 넣은 뒤 지키지 않음(화면 0번)", async () => {
  const got = await runClaudeFirst(() => CODEX_READY, "codex");
  assert.equal(got.ok, true);
  assert.deepEqual(got.sends, [{ text: FIRST, opts: undefined }]);
  assert.equal(got.readsAfterSend, 0);
  assert.deepEqual(got.keys, []);
});

// ── #4852 첫 지시가 아닌 지시도 넣은 뒤 지킨다(노드 sendKeys · 로컬 주입) — spec2.md F4 ─────────────────────────────
//  이름은 네임스페이스로 받는다 — 옛 판에 대고 돌리면 이 행만 빨간불이다(파일 링크 오류 대신).
const sfp = await import("./session-first-prompt.js") as Record<string, any>;
async function runAfterSend(after: (enters: number, reads: number) => string, text = FIRST, pasted = true) {
  let now = 0;
  const keys: string[] = [];
  let enters = 0;
  let reads = 0;
  const runtime = {
    peek: async () => { reads++; return { pane: after(enters, reads), paneCmd: "claude" }; },
    sleep: async (ms: number) => { now += ms; },
    now: () => now,
    trustKeys: { down: async () => { keys.push("down"); }, enter: async () => { keys.push("enter"); enters++; } },
  };
  const p = sfp.guardAfterSend("box-test", text, pasted, runtime);
  if (p) await p;
  return { keys, reads, elapsed: now, guarded: p !== null && p !== undefined };
}
await ta("[F4·#4852] guardAfterSend — 입력칸에 우리 글이 남으면 Enter(사라지면 멈춤) · 비어 있으면 0번 · 15초 지키고 끝난다", async () => {
  assert.equal(typeof sfp.guardAfterSend, "function", "guardAfterSend 가 없다");
  const stuck = claudeBox([`❯${NBSP}${FIRST}`]);
  const a = await runAfterSend((n) => (n >= 1 ? claudeBox([`❯${NBSP}`]) : stuck));
  assert.deepEqual(a.keys, ["enter"], "남았는데 안 눌렀거나, 제출된 뒤에도 눌렀다");
  const b = await runAfterSend(() => claudeBox([`❯${NBSP}`]));
  assert.deepEqual(b.keys, [], "빈 입력칸에 Enter");
  assert.ok(b.reads > 5, "배선 — 넣은 뒤 화면을 안 봤다");
  const watchMs = Number(sfp.FIRST_SUBMIT_WATCH_MS);
  assert.ok(b.elapsed >= watchMs && b.elapsed <= watchMs + 2_000, `지킨 시간 ${b.elapsed}ms`);
});
await ta("[F5·#4852] guardAfterSend — 붙여넣지 않은 글·키로 시작하는 글(설정 명령)은 지키지 않는다(화면도 안 본다) · 지킴이가 던져도 부른 쪽에 안 던진다", async () => {
  const stuck = claudeBox([`❯${NBSP}${FIRST}`]);
  const a = await runAfterSend(() => stuck, FIRST, false);
  assert.ok(!a.guarded && a.reads === 0 && a.keys.length === 0, `붙여넣지 않은 글을 지켰다 ${JSON.stringify(a)}`);
  const b = await runAfterSend(() => stuck, "\x13/model opus", true);
  assert.ok(!b.guarded && b.reads === 0 && b.keys.length === 0, `설정 명령을 지켰다 ${JSON.stringify(b)}`);
  const warn = console.warn; const said: string[] = []; console.warn = (...x: unknown[]) => { said.push(x.join(" ")); };
  try {
    const p = sfp.guardAfterSend("box-test", FIRST, true, {
      peek: async () => ({ pane: stuck, paneCmd: "claude" }), sleep: async () => { throw new Error("박자 실패"); }, now: () => 0,
      trustKeys: { down: async () => {}, enter: async () => {} },
    });
    await p;   // 던지면 이 시험이 실패한다
  } finally { console.warn = warn; }
  assert.ok(said.some((x) => x.includes("박자 실패")), "지킴이가 멈춘 것을 남기지 않았다");
});
await ta("[F6·#4852] 뒤에서 지킬 때는 누르기 직전에 한 번 더 본다 — 그새 사람이 제 글을 치기 시작했으면 그 글을 제출하지 않는다", async () => {
  const stuck = claudeBox([`❯${NBSP}${FIRST}`]);
  const human = claudeBox([`❯${NBSP}사람이 새로 치는 다른 글`]);
  const a = await runAfterSend((_e, reads) => (reads <= 2 ? stuck : human));
  assert.deepEqual(a.keys, [], "본 뒤 바뀐 입력칸(사람의 글)에 Enter 를 눌렀다");
  assert.ok(a.reads >= 3, "누르기 전에 다시 보지 않았다");
  const b = await runAfterSend((n) => (n >= 1 ? claudeBox([`❯${NBSP}`]) : stuck));
  assert.deepEqual(b.keys, ["enter"], "다시 봐도 우리 글이면 누른다");
});

console.log(`session-first-prompt: ${pass + asyncPass} passed`);
