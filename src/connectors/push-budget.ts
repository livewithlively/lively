// 아웃바운드 드레인의 시간예산 — 자식 CLI 가 kill 당하기 전에 루프가 스스로 멈추게 하는 계약.
//
//  🔴 부등식 PUSH_DRAIN_BUDGET_MS < PUSH_CHILD_TIMEOUT_MS 가 이 파일의 존재 이유다. 두 값이 따로 놀면
//   드레인이 하드 타임아웃에 걸려 SIGTERM 으로 죽고, 그 exit 코드가 크론 연속실패 서킷브레이커
//   (org_cron.max_fail_streak)를 트립시켜 **파이프라인 자체가 멈춘다** — 큐가 클수록 확실히 걸리는데
//   큐가 클 때야말로 드레인이 돌아야 하는 상황이라 최악의 자리에서 터진다.
//  큐 한 배치가 예산 안에 안 끝나는 것은 실패가 아니다: 처리분은 이미 done 으로 커밋됐고 남은 행은
//   pending 그대로라 다음 틱이 이어받는다. 그래서 예산 소진은 정상 종료(exit 0)여야 한다.
//  두 상수를 호출부에 흩어 두지 말 것 — 부등식이 깨진 것을 아무도 못 본다(push-budget.test.ts 가 락).
export const PUSH_CHILD_TIMEOUT_MS = 300_000;
export const PUSH_DRAIN_BUDGET_MS = 240_000;

// 판단할 수 없는 시각(NaN·Infinity)은 '소진'으로 본다 — 모르는 채로 계속 도는 쪽이 비싸다(위 kill 경로).
export function drainBudgetExceeded(startedAtMs: number, nowMs: number, budgetMs: number = PUSH_DRAIN_BUDGET_MS): boolean {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs) || !Number.isFinite(budgetMs)) return true;
  return nowMs - startedAtMs >= budgetMs;
}
