// 신뢰 대화상자에서 무엇을 누를지 — **화면을 읽어 정한다** (#3626).
//
// 배경(실측 2026-09-07, hammurabi · Claude Code 2.1.263): 이 화면의 기본 선택은 «No, exit» 이다.
//  종전 코드는 «기본은 Yes» 를 전제로 맨 Enter 를 보냈고, 그래서 하네스를 종료시켰다 — 윈도우 노드는
//  런처 폴백이 없어 pane 이 통째로 사라지고, 화면 부팅 게이트가 그 죽음을 보고 복원으로 가
//  인자 없는 `claude --resume`(후보 0건 피커)가 떴다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { trustAcceptDowns, tailOf } from "./session-first-prompt.js";

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
