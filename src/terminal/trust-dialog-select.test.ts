// 신뢰 대화상자에서 무엇을 누를지 — **화면을 읽어 정한다** (#3626).
//
// 배경(실측 2026-09-07, hammurabi · Claude Code 2.1.263): 이 화면의 기본 선택은 «No, exit» 이다.
//  종전 코드는 «기본은 Yes» 를 전제로 맨 Enter 를 보냈고, 그래서 하네스를 종료시켰다 — 윈도우 노드는
//  런처 폴백이 없어 pane 이 통째로 사라지고, 화면 부팅 게이트가 그 죽음을 보고 복원으로 가
//  인자 없는 `claude --resume`(후보 0건 피커)가 떴다.
//
// #3949(2026-09-14) — 그 고침이 **첫 지시 경로에만** 들어가 있었다. 게이트웨이에서 만든 세션의 첫 지시는 아웃박스로
//  들어가고, 아웃박스의 준비 판정은 계속 맹목 Enter 를 눌렀다. E8~E12 는 «읽고 누르는 한 함수» 와 그 배선을 못박는다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { acceptTrustDialog, trustAcceptDowns, tailOf, type TrustKeys } from "./session-first-prompt.js";

// 실제 캡처(2.1.263) — 커서가 «No, exit» 에 있다.
const V263 = [
  "Accessing workspace:",
  "C:\\Users\\amorite\\box\\sangmin-yoon\\lively-repro-listgate",
  "Quick safety check: Is this a project you created or one you trust?",
  "Claude Code'll be able to read, edit, and execute files here.",
  "Security guide",
  "❯ No, exit",
  "  Yes, I trust this folder",
  "Enter to confirm · Esc to cancel",
];
// 구판(2.1.245) — 번호가 붙고 커서가 Yes 에 있다.
const V245 = [
  "Do you trust the files in this folder?",
  "❯ 1. Yes, I trust this folder",
  "  2. No, exit",
];

test("★ E1 현행 화면 — Yes 는 한 칸 아래다(맨 Enter 면 «No, exit» 를 눌러 하네스가 죽는다)", () => {
  assert.equal(trustAcceptDowns(V263), 1);
});

test("E2 구판 화면 — 커서가 이미 Yes 라 그대로 Enter", () => {
  assert.equal(trustAcceptDowns(V245), 0);
});

// codex 0.153.4 실측(2026-09-24, tmux 100x30 — 새 폴더에서 `codex` 를 직접 띄웠다). 커서 글자가 `›` 다.
const CODEX = [
  "> You are in /private/tmp/.../scratchpad/probe",
  "Do you trust the contents of this directory? Working with untrusted contents comes with higher",
  "risk of prompt injection. Trusting the directory allows project-local config, hooks, and exec",
  "policies to load.",
  "› 1. Yes, continue",
  "  2. No, quit",
  "Press enter to continue",
];

test("★ E2b codex 화면 — 커서(`›`)가 이미 Yes 라 그대로 Enter. 이 글자를 모르면 «커서를 못 찾았다»로 아무것도 안 눌렀다", () => {
  assert.equal(trustAcceptDowns(CODEX), 0);
});

test("E2c codex — 커서가 «No, quit» 에 있으면 한 칸 내려가 Yes 를 고른다(판이 기본을 뒤집어도 안전)", () => {
  assert.equal(trustAcceptDowns(["  1. Yes, continue", "› 2. No, quit"]), null, "Yes 가 커서보다 위면 모른다고 답한다");
  assert.equal(trustAcceptDowns(["› 1. No, quit", "  2. Yes, continue"]), 1);
});

test("E3 선택지를 못 읽으면 null — 아무것도 누르지 않는다(잘못 누르는 것보다 안 누르는 게 낫다)", () => {
  assert.equal(trustAcceptDowns(["Quick safety check: Is this a project you created or one you trust?"]), null);
  assert.equal(trustAcceptDowns([]), null);
});

test("E4 커서 표식이 없으면 null — 색으로만 강조하는 판을 추측하지 않는다", () => {
  assert.equal(trustAcceptDowns(["  No, exit", "  Yes, I trust this folder"]), null);
});

test("E5 Yes 가 커서보다 **위**면 null — 랩어라운드를 보장하는 규약이 없다", () => {
  assert.equal(trustAcceptDowns(["  Yes, I trust this folder", "❯ No, exit"]), null);
});

test("E6 본문이 trust 를 언급하는 것만으로는 선택지가 아니다(줄머리 앵커)", () => {
  assert.equal(trustAcceptDowns([
    "We only trust folders you created.",
    "❯ No, exit",
    "  Yes, I trust this folder",
  ]), 1);
});

test("E7 tailOf 로 자른 실제 화면에서도 같은 답", () => {
  assert.equal(trustAcceptDowns(tailOf(V263.join("\n"))), 1);
});

// ── #3949 — 읽고 누르는 한 함수(acceptTrustDialog) ──────────────────────────────────────────
//  키는 호출 기록으로 잰다 — «무엇을 눌렀나» 가 이 결함의 전부다(값만 보면 Enter 한 번도 통과한다).
function recorder(o: { downThrows?: boolean; enterThrows?: boolean } = {}): { sent: string[]; keys: TrustKeys } {
  const sent: string[] = [];
  return {
    sent,
    keys: {
      down: async (id, times) => { sent.push(`down:${id}:${times}`); if (o.downThrows) throw new Error("tmux gone"); },
      enter: async (id) => { sent.push(`enter:${id}`); if (o.enterThrows) throw new Error("tmux gone"); },
    },
  };
}

test("★ E8 현행 화면(커서 «No, exit») — 한 칸 내린 **뒤** Enter 를 누른다", async () => {
  const r = recorder();
  assert.equal(await acceptTrustDialog("box-a", V263.join("\n"), r.keys), "accepted");
  assert.deepEqual(r.sent, ["down:box-a:1", "enter:box-a"], "내리지 않고 Enter 를 누르면 «No, exit» 가 눌려 하네스가 꺼진다");
});

test("E9 구판 화면(커서 Yes) — 내리지 않고 Enter 만", async () => {
  const r = recorder();
  assert.equal(await acceptTrustDialog("box-a", V245.join("\n"), r.keys), "accepted");
  assert.deepEqual(r.sent, ["enter:box-a"]);
});

test("★ E10 선택지를 못 읽으면 **아무 키도** 안 누른다", async () => {
  const r = recorder();
  const pane = "Quick safety check: Is this a project you created or one you trust?\n(options rendered with colour only)";
  assert.equal(await acceptTrustDialog("box-a", pane, r.keys), "unreadable");
  assert.deepEqual(r.sent, [], "못 읽은 화면에 키를 보냈다 — 커서가 «No, exit» 면 하네스가 꺼진다");
});

test("E11 키 보내기가 실패해도 던지지 않는다(다음 폴에서 화면을 다시 본다)", async () => {
  const r = recorder({ downThrows: true, enterThrows: true });
  assert.equal(await acceptTrustDialog("box-a", V263.join("\n"), r.keys), "accepted");
  assert.deepEqual(r.sent, ["down:box-a:1", "enter:box-a"]);
});

test("★ E12 [배선] 아웃박스와 첫 지시가 같은 수락 함수를 부르고, 아웃박스의 수락 갈래에 맹목 Enter 가 없다", () => {
  const codeLines = (rel: string): string[] =>
    readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const outbox = codeLines("sessions/session-outbox.ts");
  const at = outbox.findIndex((l) => /step === "accept-trust"/.test(l));
  assert.ok(at >= 0, "아웃박스 준비 판정의 accept-trust 갈래를 못 찾았다 — 이 가드가 아무것도 안 보고 있다");
  const branch = outbox.slice(at, at + 4).join("\n");
  assert.match(branch, /acceptTrustDialog\s*\(/, "아웃박스가 신뢰 대화상자를 읽지 않고 누른다");
  assert.doesNotMatch(branch, /sendKeyToSession\s*\([^)]*"Enter"/,
    "아웃박스의 수락 갈래에 맹목 Enter 가 남아 있다 — 기본 선택이 «No, exit» 면 하네스가 꺼진다");
  const first = codeLines("terminal/session-first-prompt.ts");
  const fn = first.slice(first.findIndex((l) => /export async function injectFirstPrompt/.test(l)));
  assert.ok(fn.length > 5, "injectFirstPrompt 본문을 못 찾았다");
  assert.ok(fn.some((l) => /acceptTrustDialog\s*\(/.test(l)), "첫 지시 경로가 공용 수락 함수를 안 부른다 — 판단이 두 벌이 된다");
});
