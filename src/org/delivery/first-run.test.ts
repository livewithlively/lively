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

// ── 하다 만 자리(#2207) ──────────────────────────────────────────────────────
//  엣지 표 「끝냄 × 하던 자리 × 흔적 → 처음 설정을 보여주나」:
//   P1 안 끝냄 + 하던 자리 있음 + 흔적 없음            → true (이어서 한다)
//   P2 ★ 안 끝냄 + 하던 자리 있음 + 흔적 있음(MCP)     → true (온보딩이 스스로 만든 흔적이다 — 아래 참조)
//   P3 ★ 안 끝냄 + 하던 자리 있음 + 흔적 있음(세션)     → true
//   P4 끝냄 + 하던 자리 있음                          → false (끝냈다는 사실이 하던 자리보다 세다)
//   P5 안 끝냄 + 하던 자리 없음 + 흔적 있음            → false (종전 규칙 그대로 — 회귀락)
//   P6 welcomeInProgress 를 아예 안 준 옛 호출부       → 종전 판정 그대로

test("P1 하다 만 자리가 있으면 이어서 한다", () => {
  assert.equal(isFirstRun({ onboardedAt: null, welcomeInProgress: true, everCalledMcp: false, everHadSession: false }), true);
});

test("P2 ★ 온보딩 도중 생긴 MCP 흔적이 그 사람을 홈으로 밀어내지 못한다", () => {
  // 「내 컴퓨터에 잇기」 장면이 데스크톱 앱을 깔게 하고, 그 앱이 붙는 순간 mcp_call_log 에 성공 호출이 남는다.
  //  그 흔적으로 '이미 쓰던 사람' 판정을 하면 **자기가 하던 설정으로 돌아갈 길이 사라진다**.
  assert.equal(isFirstRun({ onboardedAt: null, welcomeInProgress: true, everCalledMcp: true, everHadSession: false }), true);
});

test("P3 ★ 터미널 세션 흔적도 마찬가지", () => {
  assert.equal(isFirstRun({ onboardedAt: null, welcomeInProgress: true, everCalledMcp: false, everHadSession: true }), true);
});

test("P4 끝냈으면 하던 자리가 남아 있어도 홈", () => {
  assert.equal(isFirstRun({ onboardedAt: "2026-08-27T00:00:00Z", welcomeInProgress: true, everCalledMcp: false, everHadSession: false }), false);
});

test("P5 하던 자리가 없으면 종전 규칙 그대로 — 흔적이 있으면 홈(회귀락)", () => {
  assert.equal(isFirstRun({ onboardedAt: null, welcomeInProgress: false, everCalledMcp: true, everHadSession: false }), false);
  assert.equal(isFirstRun({ onboardedAt: null, welcomeInProgress: false, everCalledMcp: false, everHadSession: true }), false);
});

test("P6 이 축을 안 주는 호출부는 종전 판정 그대로", () => {
  assert.equal(isFirstRun({ onboardedAt: null, everCalledMcp: false, everHadSession: false }), true);
  assert.equal(isFirstRun({ onboardedAt: null, everCalledMcp: true, everHadSession: false }), false);
});
