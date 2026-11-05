// 수집 직후의 «이어달리기»(connector.ts nudgeDistillNow)가 이 증류 잡을 깨워도 되는가.
//
//  주기형(interval_sec) 잡은 «얼마 만에 한 번» 만 약속한다 — 수집 직후로 앞당겨도 그 약속을 어기지 않는다.
//  시각형(cron_expr) 잡은 «이 벽시계에만» 을 약속한다. 실행 계정의 구독 한도를 근무시간에 쓰지 않으려고
//   야간에만 돌게 둔 증류 잡이 그 예다. 이어달리기가 이 잡을 깨우면 수집기가 돌 때마다(1~2분) 시각과
//   무관하게 실행돼 그 약속이 통째로 무너진다. 그래서 시각형 잡은 자기 시각(cron-due)에만 돌게 둔다.
//  ⚠ 시각형 판정은 엔진 isDue(engine.ts `if (job.cron_expr)`)와 같은 규칙이어야 한다 — 갈리면 한 잡을
//   이어달리기는 주기형으로, 정기 실행은 시각형으로 보게 된다.
export function isNudgeableDistillJob(job: { cron_expr?: string | null }): boolean {
  return !job.cron_expr;
}
