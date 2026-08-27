// 처음 설정(#/welcome) 노출 판정(#2039) — 표로 못박는다.
//  회귀락: 종전엔 브라우저 localStorage 하나로 정해서 **쓰던 사람도 새 브라우저면 처음 설정이 떴다**.
//  그 오판정이 다시 나지 않도록, '흔적이 하나라도 있으면 홈'을 케이스로 고정한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFirstRun, isWelcomePending } from "./first-run.js";

test("아무 흔적도 없는 사람만 처음 설정을 본다", () => {
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: null, welcomeInProgress: false, everCalledMcp: false, everHadSession: false }), true);
});

test("끝냈다는 표식이 있으면 브라우저와 무관하게 홈", () => {
  assert.equal(isFirstRun({ onboardedAt: "2026-08-26T00:00:00Z", shownAt: null, welcomeInProgress: false, everCalledMcp: false, everHadSession: false }), false);
});

test("이미 쓰던 사람은 홈 — MCP 호출 이력", () => {
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: null, welcomeInProgress: false, everCalledMcp: true, everHadSession: false }), false);
});

test("이미 쓰던 사람은 홈 — 터미널 세션 이력", () => {
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: null, welcomeInProgress: false, everCalledMcp: false, everHadSession: true }), false);
});

// ── #2171 — 자동 진입은 **평생 한 번**. 완주만이 유일한 탈출구였던 것이 '시도때도없이 뜬다'의 원인이었다.
test("한 번 보냈으면 다시 자동으로 안 보낸다 — 안 끝냈어도", () => {
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: "2026-08-27T00:00:00Z", welcomeInProgress: false, everCalledMcp: false, everHadSession: false }), false);
});

test("보여줬는데 안 끝낸 사람은 홈에서 이어서 하기", () => {
  assert.equal(isWelcomePending({ onboardedAt: null, shownAt: "2026-08-27T00:00:00Z", welcomeInProgress: false, everCalledMcp: false, everHadSession: false }), true);
});

test("끝낸 사람에겐 이어서 하기도 안 뜬다", () => {
  assert.equal(isWelcomePending({ onboardedAt: "2026-08-27T01:00:00Z", shownAt: "2026-08-27T00:00:00Z", welcomeInProgress: false, everCalledMcp: false, everHadSession: false }), false);
});

test("아직 안 보낸 사람에겐 이어서 하기가 아니라 자동 진입", () => {
  const f = { onboardedAt: null, shownAt: null, welcomeInProgress: false, everCalledMcp: false, everHadSession: false };
  assert.equal(isFirstRun(f), true);
  assert.equal(isWelcomePending(f), false);
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
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: null, welcomeInProgress: true, everCalledMcp: false, everHadSession: false }), true);
});

test("P2 ★ 온보딩 도중 생긴 MCP 흔적이 그 사람을 홈으로 밀어내지 못한다", () => {
  // 「내 컴퓨터에 잇기」 장면이 데스크톱 앱을 깔게 하고, 그 앱이 붙는 순간 mcp_call_log 에 성공 호출이 남는다.
  //  그 흔적으로 '이미 쓰던 사람' 판정을 하면 **자기가 하던 설정으로 돌아갈 길이 사라진다**.
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: null, welcomeInProgress: true, everCalledMcp: true, everHadSession: false }), true);
});

test("P3 ★ 터미널 세션 흔적도 마찬가지", () => {
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: null, welcomeInProgress: true, everCalledMcp: false, everHadSession: true }), true);
});

test("P4 끝냈으면 하던 자리가 남아 있어도 홈", () => {
  assert.equal(isFirstRun({ onboardedAt: "2026-08-27T00:00:00Z", shownAt: null, welcomeInProgress: true, everCalledMcp: false, everHadSession: false }), false);
});

test("P5 하던 자리가 없으면 종전 규칙 그대로 — 흔적이 있으면 홈(회귀락)", () => {
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: null, welcomeInProgress: false, everCalledMcp: true, everHadSession: false }), false);
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: null, welcomeInProgress: false, everCalledMcp: false, everHadSession: true }), false);
});

test("P6 이 축을 안 주는 호출부는 종전 판정 그대로", () => {
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: null, welcomeInProgress: false, everCalledMcp: false, everHadSession: false }), true);
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: null, welcomeInProgress: false, everCalledMcp: true, everHadSession: false }), false);
});

// ── #2171 후속 — 원준님 재신고(2026-08-27, 데스크톱 앱에서 **워크스페이스 전환** 중):
//  전환은 location.reload() 라 이 판정을 처음부터 다시 타는데, 옮겨 간 워크스페이스엔 흔적이 0이라
//  «처음 오는 사람»이 참이 된다. 화면(main.ts wsSwitched)이 그 부팅을 걸러 내지만, 서버 규칙에서도
//  «이미 보여줬으면 끝»이 진행중보다 세다는 것을 못박는다 — 안 그러면 전환마다 다시 끌려간다.
test("★ 보여준 적 있으면 하다 만 자리가 있어도 자동 진입 안 한다 — 대신 이어서 하기", () => {
  const f = { onboardedAt: null, shownAt: "2026-08-27T00:00:00Z", welcomeInProgress: true, everCalledMcp: false, everHadSession: false };
  assert.equal(isFirstRun(f), false, "보여준 뒤에도 끌고 가면 전환·재접속마다 다시 뜬다");
  assert.equal(isWelcomePending(f), true, "끌고 가지 않는 대신 길은 남긴다");
});

test("아직 안 보여준 사람은 하다 만 자리가 흔적을 이긴다(#2207 유지)", () => {
  // 온보딩이 스스로 흔적을 만든다(「내 컴퓨터에 잇기」→ MCP 호출) — 그래도 하던 자리로 돌아가야 한다.
  assert.equal(isFirstRun({ onboardedAt: null, shownAt: null, welcomeInProgress: true, everCalledMcp: true, everHadSession: true }), true);
});
