// 대화창 글자 크기 규칙 — 회귀 가드 (web/chat-font.ts, #2055).
//
// 왜 이 테스트가 있나: 이 값은 **localStorage 에서 온다** — 사람이 손댈 수 있고, 옛 버전이 남긴 값도
//  그대로 들어온다. 범위를 안 지키면 배율이 0·NaN 이 되어 대화창이 통째로 **빈 화면**이 된다.
//  그 화면은 '버그'로 안 읽히고(그냥 안 보인다) 원인도 안 보이므로, 접는 규칙을 표로 못박는다.
import { strict as assert } from "node:assert";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const M = await import(pathToFileURL(path.join(ROOT, "public/app/chat-font.js")).href);
const { CHAT_FONT_LABELS, CHAT_FONT_SCALES, fontScale, nextFontStep, parseFontStep } = M;

test("배선 · 모듈이 실제로 값을 내보낸다", () => {
  assert.equal(typeof parseFontStep, "function");
  assert.ok(Array.isArray(CHAT_FONT_SCALES) && CHAT_FONT_SCALES.length >= 3);
});

test("1 · 저장된 값이 없으면 '보통'(1)", () => {
  assert.equal(parseFontStep(null), 1);
  assert.equal(parseFontStep(undefined), 1);
  assert.equal(parseFontStep(""), 1);
});

test("2 · 저장된 단계를 그대로 읽는다", () => {
  assert.equal(parseFontStep("0"), 0);
  assert.equal(parseFontStep("3"), 3);
});

test("★ 3 · 범위 밖·쓰레기 값은 전부 '보통' — 배율이 0/NaN 이면 대화창이 빈 화면이 된다", () => {
  for (const bad of ["-1", "99", "abc", "1.5", "null", "Infinity", " "]) {
    assert.equal(parseFontStep(bad), 1, `${bad} 이 접히지 않았다`);
  }
});

test("★ 4 · 배율은 절대 0 이 아니다 — 어떤 입력에도 글자가 사라지지 않는다", () => {
  for (const bad of [-5, 0, 1, 99, NaN, Infinity]) {
    const v = fontScale(bad);
    assert.ok(v > 0.5 && v < 3, `${bad} → ${v}`);
  }
});

test("5 · 다음 단계는 한 칸씩, 끝에서 처음으로 돈다(메뉴가 이걸로 순환한다)", () => {
  assert.equal(nextFontStep(0), 1);
  assert.equal(nextFontStep(CHAT_FONT_SCALES.length - 1), 0);
  assert.equal(nextFontStep(999), 2, "쓰레기 입력도 '보통' 다음으로 이어진다(멈추지 않는다)");
});

test("6 · 라벨은 사람 말이고 단계 수와 짝이 맞는다", () => {
  assert.equal(CHAT_FONT_LABELS.length, CHAT_FONT_SCALES.length);
  assert.ok(CHAT_FONT_LABELS.every((l) => typeof l === "string" && l.trim()));
});

test("★ 7 · 배율표는 오름차순이다 — '크게'가 더 작으면 손잡이가 거짓말을 한다", () => {
  for (let i = 1; i < CHAT_FONT_SCALES.length; i++) assert.ok(CHAT_FONT_SCALES[i] > CHAT_FONT_SCALES[i - 1]);
});
