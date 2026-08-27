// 처음 설정(#/welcome) 노출 판정(#2039) — 표로 못박는다.
//  회귀락: 종전엔 브라우저 localStorage 하나로 정해서 **쓰던 사람도 새 브라우저면 처음 설정이 떴다**.
//  그 오판정이 다시 나지 않도록, '흔적이 하나라도 있으면 홈'을 케이스로 고정한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFirstRun, isWelcomePending } from "./first-run.js";

test("아무 흔적도 없는 사람만 처음 설정을 본다", () => {
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: null, everCalledMcp: false, everHadSession: false }), true);
});

test("끝냈다는 표식이 있으면 브라우저와 무관하게 홈", () => {
  assert.equal(isFirstRun({ onboardedAt: "2026-08-26T00:00:00Z", shownAt: null, everCalledMcp: false, everHadSession: false }), false);
});

test("이미 쓰던 사람은 홈 — MCP 호출 이력", () => {
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: null, everCalledMcp: true, everHadSession: false }), false);
});

test("이미 쓰던 사람은 홈 — 터미널 세션 이력", () => {
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: null, everCalledMcp: false, everHadSession: true }), false);
});

// ── #2171 — 자동 진입은 **평생 한 번**. 완주만이 유일한 탈출구였던 것이 '시도때도없이 뜬다'의 원인이었다.
test("한 번 보냈으면 다시 자동으로 안 보낸다 — 안 끝냈어도", () => {
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: "2026-08-27T00:00:00Z", everCalledMcp: false, everHadSession: false }), false);
});

test("보여줬는데 안 끝낸 사람은 홈에서 이어서 하기", () => {
  assert.equal(isWelcomePending({ onboardedAt: null, shownAt: "2026-08-27T00:00:00Z", everCalledMcp: false, everHadSession: false }), true);
});

test("끝낸 사람에겐 이어서 하기도 안 뜬다", () => {
  assert.equal(isWelcomePending({ onboardedAt: "2026-08-27T01:00:00Z", shownAt: "2026-08-27T00:00:00Z", everCalledMcp: false, everHadSession: false }), false);
});

test("아직 안 보낸 사람에겐 이어서 하기가 아니라 자동 진입", () => {
  const f = { onboardedAt: null, shownAt: null, everCalledMcp: false, everHadSession: false };
  assert.equal(isFirstRun(f), true);
  assert.equal(isWelcomePending(f), false);
});
