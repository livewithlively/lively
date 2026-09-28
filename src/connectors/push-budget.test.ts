// 드레인 시간예산 — 예산과 하드 타임아웃의 부등식, 그리고 그 예산이 실제 루프에 배선돼 있는가.
//
//  왜 이 표가 필요한가(실측 2026-09-28): 프로젝트 1,447건을 일괄 done 처리하자 그 전부가 아웃박스에
//   들어왔고, 각 행이 상태 PUT + 닫힘 코멘트 POST 2콜이라 건당 약 3초였다. 배치는 200건 고정이라
//   한 배치가 10분 — 자식 CLI 의 5분 하드 타임아웃에 매번 kill 됐다. kill 은 exit!=0 이라 2분 주기로
//   5회 연속 실패, 서킷브레이커가 push-clickup 크론을 자동정지시켰다(잔여 981건이 그대로 멈췄다).
//  드레인은 부분 진전이 안전한 작업이다(처리분은 done 커밋, 남은 행은 pending). 그러니 "다 못 했다"는
//   실패가 아니라 정상 종료여야 하고, 그러려면 kill 보다 **먼저** 스스로 멈춰야 한다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { drainBudgetExceeded, PUSH_DRAIN_BUDGET_MS, PUSH_CHILD_TIMEOUT_MS } from "./push-budget.js";

const r = (p: string): string => readFileSync(new URL(p, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const DRAIN = r("./clickup-push.ts");
const CRON = r("../scheduler/actions/connector.ts");

test("계약 — 자발 종료가 하드 kill 보다 먼저 온다", () => {
  assert.ok(PUSH_DRAIN_BUDGET_MS < PUSH_CHILD_TIMEOUT_MS,
    "예산이 자식 타임아웃 이상이다 — 루프가 멈추기 전에 SIGTERM 이 와서 크론이 연속실패로 자동정지한다");
  //  여유가 한 건의 처리시간보다 커야 마지막 한 건이 경계를 넘어가며 kill 을 부르지 않는다.
  //  실측 건당 약 3초 기준으로 한 자릿수 초는 너무 얇다 — 최소 30초를 요구한다.
  assert.ok(PUSH_CHILD_TIMEOUT_MS - PUSH_DRAIN_BUDGET_MS >= 30_000,
    "예산과 타임아웃의 간격이 너무 얇다 — 마지막 한 건이 경계를 넘으면 그대로 kill 이다");
});

test("표 — 경과가 예산에 닿으면 멈춘다", () => {
  assert.equal(drainBudgetExceeded(1_000, 1_000 + 9_999, 10_000), false, "예산 미달인데 멈췄다");
  assert.equal(drainBudgetExceeded(1_000, 1_000 + 10_000, 10_000), true, "정확히 예산에 닿았는데 계속 돈다(경계)");
  assert.equal(drainBudgetExceeded(1_000, 1_000 + 10_001, 10_000), true, "예산 초과인데 계속 돈다");
  assert.equal(drainBudgetExceeded(1_000, 1_000, 10_000), false, "방금 시작했는데 멈췄다");
});

test("판단할 수 없는 시각은 소진으로 본다 — 모르는 채 계속 도는 쪽이 비싸다", () => {
  assert.equal(drainBudgetExceeded(Number.NaN, 1_000, 10_000), true);
  assert.equal(drainBudgetExceeded(1_000, Number.NaN, 10_000), true);
  assert.equal(drainBudgetExceeded(1_000, 2_000, Number.NaN), true);
  assert.equal(drainBudgetExceeded(1_000, Number.POSITIVE_INFINITY, 10_000), true);
});

test("배선 — 드레인 루프가 예산을 실제로 본다", () => {
  assert.match(DRAIN, /drainBudgetExceeded\(/, "clickup-push 가 예산을 보지 않는다 — 상수만 있고 배선이 없으면 kill 은 그대로다");
  //  markErr 로 닫지 않고 break 해야 남은 행이 attempts 를 축내지 않고 다음 틱에 그대로 이어진다.
  assert.match(DRAIN, /drainBudgetExceeded\([\s\S]{0,200}?\)\)\s*\{[\s\S]{0,400}?break;/,
    "예산 초과에서 루프를 빠져나오지 않는다");
});

test("배선 — 자식 타임아웃이 상수를 쓴다(하드코딩 300_000 금지)", () => {
  assert.match(CRON, /PUSH_CHILD_TIMEOUT_MS/, "자식 실행이 공용 상수를 쓰지 않는다 — 부등식이 조용히 깨진다");
  assert.ok(!/timeout:\s*300_000/.test(CRON), "하드코딩된 300_000 이 남아 있다 — 예산과 따로 움직인다");
});
