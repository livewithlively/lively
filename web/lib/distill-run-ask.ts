// 증류를 손으로 돌리기 전에 무엇을 물을지 — 순수 규칙(#5235). 확인창은 distill-run-check.ts 가 이 답대로 그린다.
//  입력은 서버의 실행 판정 그대로다(cron_run_now dry_run 의 plan). 화면이 따로 세면 말과 실행이 갈린다.

export interface DistillRunPlan {
  lanes?: Array<{ distiller: string; sources: number; backlog: number }> | null;
  unassigned?: { sources: number; total: number } | null;
}

export type DistillRunAsk =
  /** 기본 기준으로 나갈 자료가 없다 — 묻지 않는다. 고를 것 없는 확인창은 다음 창도 안 읽게 만든다. */
  | { ask: 'none' }
  /** 나가는 것이 기본 기준 배치뿐이다 — 뺄 수 없으니 실행할지만 묻는다(빼면 아무것도 안 나간다). */
  | { ask: 'default-only'; sources: number; rest: number }
  /** 증류기 몫과 함께 나간다 — 뺄 수 있다. */
  | { ask: 'choose'; sources: number; rest: number; laneCount: number; laneSources: number };

export function distillRunAsk(plan: DistillRunPlan | null | undefined): DistillRunAsk {
  const u = plan?.unassigned;
  if (!u || !u.sources) return { ask: 'none' };
  const rest = Math.max(0, (u.total || 0) - u.sources);
  const lanes = plan?.lanes ?? [];
  if (!lanes.length) return { ask: 'default-only', sources: u.sources, rest };
  return { ask: 'choose', sources: u.sources, rest, laneCount: lanes.length, laneSources: lanes.reduce((n, l) => n + (l.sources || 0), 0) };
}
