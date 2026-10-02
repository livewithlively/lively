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

// 외부 API 요청 하나의 하드 상한(clickup/api.ts 의 fetch signal 이 이 값을 쓴다).
//  예산의 여유분을 이 값에서 도출하는 것이 핵심이다 — 예산 검사는 **행 사이**에서만 일어나므로,
//  검사를 통과한 마지막 한 행이 끝날 때까지 kill 이 오면 안 된다. 한 행은 상태셋 GET + 갱신 PUT
//  (+status 뺀 재시도 PUT) + 닫힘 코멘트 POST 로 요청 여러 번이라, 그중 둘이 상한까지 hang 해도
//  버티도록 요청 2회분을 남긴다. 여유를 손으로 적으면 이 값이 바뀔 때 조용히 부족해진다.
export const CLICKUP_REQUEST_TIMEOUT_MS = 60_000;
export const PUSH_DRAIN_BUDGET_MS = PUSH_CHILD_TIMEOUT_MS - 2 * CLICKUP_REQUEST_TIMEOUT_MS;

// 판단할 수 없는 시각(NaN·Infinity)은 '소진'으로 본다 — 모르는 채로 계속 도는 쪽이 비싸다(위 kill 경로).
export function drainBudgetExceeded(startedAtMs: number, nowMs: number, budgetMs: number = PUSH_DRAIN_BUDGET_MS): boolean {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs) || !Number.isFinite(budgetMs)) return true;
  return nowMs - startedAtMs >= budgetMs;
}

// 드레인 결과 → CLI exit 코드. **예산 소진은 실패가 아니다** — 여기에 budgetStopped 를 더하면
//  이 파일이 없애려는 서킷브레이커 트립이 그대로 돌아온다. 판정을 순수로 빼 둔 이유가 그것이다.
export function exitCodeForPush(res: { failed: number }): number {
  return res.failed > 0 ? 1 : 0;
}
