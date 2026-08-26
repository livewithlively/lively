// 처음 설정(#/welcome) 노출 판정(#2039) — 표로 못박는다.
//  회귀락: 종전엔 브라우저 localStorage 하나로 정해서 **쓰던 사람도 새 브라우저면 처음 설정이 떴다**.
//  그 오판정이 다시 나지 않도록, '흔적이 하나라도 있으면 홈'을 케이스로 고정한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFirstRun } from "./first-run.js";

test("아무 흔적도 없는 사람만 처음 설정을 본다", () => {
  assert.equal(isFirstRun({ onboardedAt: null, everCalledMcp: false, everHadSession: false }), true);
});

test("끝냈다는 표식이 있으면 브라우저와 무관하게 홈", () => {
  assert.equal(isFirstRun({ onboardedAt: "2026-08-26T00:00:00Z", everCalledMcp: false, everHadSession: false }), false);
});

test("이미 쓰던 사람은 홈 — MCP 호출 이력", () => {
  assert.equal(isFirstRun({ onboardedAt: null, everCalledMcp: true, everHadSession: false }), false);
});

test("이미 쓰던 사람은 홈 — 터미널 세션 이력", () => {
  assert.equal(isFirstRun({ onboardedAt: null, everCalledMcp: false, everHadSession: true }), false);
});
