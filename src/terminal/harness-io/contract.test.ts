// 하네스 계약 테스트(#1719 상민님 지시: "인터페이스에 대한 테스트케이스를 만들고 모든 하네스에 대해 돌려라") —
//  세션 대화창이 기대는 축들을 HARNESS_IO 전 어댑터에 대해 한 표로 검증한다. 사양·엣지 표: 스크래치 spec.md(8행).
//
//  원칙:
//  · 축은 **명시적으로** 선언돼야 한다(함수 또는 null — 있는 척 금지). 인터페이스가 필수 필드라 컴파일이 1차로 막고,
//    여기서는 런타임 값·의미를 다시 못박는다.
//  · 실측 fixture 가 있는 하네스(claude·antigravity·codex·grok·opencode)는 화면 표를 검증하고, 미실측(screen=null)은 그 사실 자체를 검증한다 —
//    null 이면 호출자(session-first-prompt·outbox)가 보수적 폴백(정착 대기 + 공용 대화상자 감지)을 탄다.
//  · 교차 불변식: 어떤 하네스도 대화상자·인증 화면을 'ready' 로 판정하면 안 된다 — 그 순간 프롬프트가 삼켜진다(실측 사고 2건:
//    antigravity 신뢰 대화상자에 첫 지시 주입 · 인증 검증 중 프롬프트 거부 유실).
import assert from "node:assert/strict";
import { HARNESS_IO, harnessIo, chatIoCaps, CHAT_ACTIONS } from "./adapter.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 실측 화면 fixture — 하네스가 늘면 여기에 그 하네스의 화면을 추가한다(전부 실측 원문, 지어내지 않는다) ──
const tails = (s: string): string[] => s.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "").slice(-14);
const FIXTURES: Record<string, Partial<Record<"ready" | "busy" | "dialog" | "auth", string | string[]>>> = {
  claude: {
    ready: "╭───╮\n│ ❯ │\n╰───╯\n  ⏵⏵ auto mode on (shift+tab to cycle) · ? for shortcuts",
    dialog: " Do you trust the files in this folder?\n ❯ 1. Yes, proceed\n   2. No, exit\n Enter to confirm · Esc to exit",
    auth: " Welcome to Claude Code\n\n Select login method:\n ❯ 1. Claude account with subscription",
  },
  antigravity: {   // 실측 2026-08-18 (box-yoon-8719c6fa 재현 캡처 — 부팅→인증→신뢰→생성→준비)
    ready: "> \n────\n? for shortcuts                     Gemini 3.7 Flash · high",
    busy: "> 지금 몇시야\n⣯  Generating...\n────\n>\n────\nesc to cancel                       Gemini 3.7 Flash · high",
    dialog: "Do you trust the contents of this project?\nAntigravity CLI requires permission to read, edit, and execute files here.\n> Yes, I trust this folder\n  No, exit\n↑/↓ Navigate · enter Confirm",
    auth: " Welcome to the Antigravity CLI. You are currently not signed in.\n ⡿  Signing in...",
  },
  codex: {   // 실측 2026-08-18 (box-yoon-355e7d10 — 부팅 대화상자 2종→준비→실행)
    ready: "│ model:     gpt-5.6-terra medium   /model to change │\n│ directory: ~/box/yoon                              │\n╰────╯\n  Tip: New Build faster with the Desktop app.\n› Explain this codebase\n  gpt-5.6-terra medium · ~/box/yoon",
    busy: "› 현재 폴더에서 ls -la 를 실행해서 보여줘\n• Working (2s • esc to interrupt)\n› Explain this codebase\n  gpt-5.6-terra medium · ~/box/yoon",
    dialog: [
      "✨ Update available! 0.146.0 -> 0.147.0\n  Release notes: https://github.com/openai/codex/releases/latest\n› 1. Update now (runs `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh |\n     CODEX_NON_INTERACTIVE=1 sh'`)\n  2. Skip\n  3. Skip until next version\n  Press enter to continue",
      "Do you trust the contents of this directory? Working with untrusted contents\n  comes with higher risk of prompt injection.\n› 1. Yes, continue\n  2. No, quit\n  Press enter to continue",
    ],
  },
  grok: {   // 실측 2026-08-18 (box-yoon-bf4872dd — busy 중에도 입력박스·푸터가 그려진다)
    ready: "   Worked for 18s                                         stop  [hooks: 5]\n╭──────────╮\n│ ❯        │\n╰───────── Grok 4.6 (high) ─╯\nShift+Tab:mode  │  Ctrl+.:shortcuts",
    busy: "#1 쉘 명령 mkdir grok-approval-test 실행해줘\n⠹ Responding… 6.5s                                       26s ⇣23.5k [stop]\n╭──────────╮\n│ ❯        │\n╰───────── Grok 4.6 (high) ─╯\nEnter:send now  │  Shift+Tab:mode  │  Esc:cancel  │  Ctrl+;:queue  │  Ctrl+.",
  },
  opencode: {   // 실측 2026-08-18 (box-yoon-3e231912 — busy·ready 모두 상태바에 ctrl+p commands)
    ready: "▣  Build · Big Pickle · interrupted\n┃\n┃  Build · Big Pickle OpenCode Zen\n╹▀▀▀▀▀▀▀▀\n /Users/lively/box/yoon                           1.1K (1%)  ctrl+p commands",
    busy: "▣  Compaction · Big Pickle · 9.4s\n▣  Build · Big Pickle\n┃  Build · Big Pickle OpenCode Zen\n╹▀▀▀▀▀▀▀▀\n ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt                          1.3K (1%)  ctrl+p commands",
  },
};
// fixture 값을 배열로 편다(상태당 실측 화면 여러 장 허용).
const panes = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// [표 1] 축의 명시적 선언 — undefined(있는 척)를 금지한다.
t("[1] 전 어댑터가 parse·answer·screen·pathFor 를 함수 또는 null 로 명시 선언한다", () => {
  assert.ok(HARNESS_IO.length >= 6, "레지스트리가 비어 있으면 이 표 전체가 헛돈다(배선 단언)");
  for (const a of HARNESS_IO) {
    for (const axis of ["parse", "answer", "screen", "pathFor"] as const) {
      assert.ok(axis in a, `${a.key}.${axis} 미선언`);
      assert.ok(a[axis] === null || typeof a[axis] === "function", `${a.key}.${axis} 는 함수|null 이어야 한다`);
    }
    assert.ok(a.filePattern instanceof RegExp, `${a.key}.filePattern`);
    assert.ok(typeof a.roots === "function", `${a.key}.roots`);
  }
});

// [표 2a·2b] 실측 화면 표 — fixture 가 있는 하네스는 상태를 정확히 가른다.
t("[2] 실측 fixture 하네스의 화면 판정 표(claude·antigravity·codex·grok·opencode)", () => {
  let checked = 0;
  for (const [key, fx] of Object.entries(FIXTURES)) {
    const a = harnessIo(key);
    assert.ok(a?.screen, `${key}.screen 은 실측 fixture 가 있으므로 구현돼야 한다`);
    for (const [state, v] of Object.entries(fx)) {
      for (const pane of panes(v)) {
        assert.equal(a!.screen!(tails(pane)), state, `${key}: ${state} 화면 판정`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 15, `화면 표가 비어 있다(배선 단언) — 검사 ${checked}건`);
});

// [표 3] 교차 불변식 — 남의 하네스 화면이라도 dialog·auth 를 ready 로 판정하면 안 된다(오배선 대비).
t("[3] 어떤 screen 구현도 대화상자·인증 화면을 'ready' 로 오판하지 않는다(교차 포함)", () => {
  for (const a of HARNESS_IO) {
    if (!a.screen) continue;
    for (const [fkey, fx] of Object.entries(FIXTURES)) {
      for (const state of ["dialog", "auth"] as const) {
        for (const pane of panes(fx[state])) {
          assert.notEqual(a.screen(tails(pane)), "ready", `${a.key} 가 ${fkey} 의 ${state} 화면을 ready 로 오판`);
        }
      }
    }
  }
});

// [표 4] 미실측은 명시적 null — 이 목록이 늘거나 줄면 표(fixture)와 함께 갱신해야 한다.
t("[4] screen=null 하네스는 정확히 {shell} — AI 하네스는 전부 실측 화면 판정을 가진다", () => {
  const noScreen = HARNESS_IO.filter((a) => !a.screen).map((a) => a.key).sort();
  assert.deepEqual(noScreen, ["shell"]);
});

// [표 5] answer 축과 caps 정합 — 화면은 caps 를 보고 버튼을 숨긴다(있는 척 금지의 화면 짝).
t("[5] answer 선언 하네스는 모든 행동에 키를 답하고, caps.read/answer 는 parse/answer 유무와 일치한다", () => {
  for (const a of HARNESS_IO) {
    if (a.answer) for (const act of CHAT_ACTIONS) assert.ok(a.answer(act), `${a.key}.answer(${act})`);
    assert.equal(chatIoCaps(a.key).answer, !!a.answer, `${a.key} caps.answer`);
    assert.equal(chatIoCaps(a.key).read, !!a.parse, `${a.key} caps.read`);
    //  #2439 — chatFirst(정책)는 read(능력)에서 파생된다. 대화를 못 읽는 하네스를 대화창 기본으로 두면
    //   그 세션은 **빈 화면으로 열린다**(opencode 가 정확히 그 경우다). 값이 갈리는 날이 오면 여기서 터진다.
    assert.equal(chatIoCaps(a.key).chatFirst, !!a.parse, `${a.key} caps.chatFirst`);
  }
});

// [표 6] pathFor 인젝션 방어 — convId 가 경로 조각이 될 수 있으면 만들지 않는다.
t("[6] pathFor 는 인젝션형·빈 convId 에 null", () => {
  for (const a of HARNESS_IO) {
    if (!a.pathFor) continue;
    for (const bad of ["../../etc/passwd", "a/b", "", "a b"]) {
      assert.equal(a.pathFor("/root", { cwd: "/w", convId: bad }), null, `${a.key}.pathFor(${JSON.stringify(bad)})`);
    }
  }
});

// [표 7] 새 축의 부재 입력 — 빈 화면(capture 실패·부팅 직전)을 ready 로 판정하면 거기 넣은 프롬프트가 유실된다.
t("[7] screen([]) — 빈 tail 은 어떤 하네스에서도 'ready' 가 아니다", () => {
  for (const a of HARNESS_IO) {
    if (!a.screen) continue;
    assert.notEqual(a.screen([]), "ready", `${a.key} 가 빈 화면을 ready 로 판정`);
  }
});

console.log(`harness-io/contract: ${pass} passed`);
