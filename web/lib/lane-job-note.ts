// 증류기를 켠 뒤 무엇이 그것을 돌리는지 말한다 (#5235) — 순수 규칙.
//
//  레인을 켜면 그 레인을 맡을 잡이 없을 때 제품이 자동 실행을 저절로 만든다. 저장 응답에도 화면에도 안 나와서, 고객사 첫 세팅에서
//   사람이 그걸 모른 채 레인별 잡을 또 만들었고 첫 틱에 같은 자료가 두 번 나갔다. 반대로 사람이 자동 실행을 꺼 둔 채면 켠 레인이 돌지 않는데
//   화면은 «켰습니다» 라고만 했다. 평소처럼 맡은 잡이 있으면 아무 말도 하지 않는다.

export interface LaneJobPlan { action?: string; uncovered?: boolean; interval_sec?: number }
export interface LaneJobNote { text: string; warn: boolean }

export function laneJobNote(plan: LaneJobPlan | null | undefined): LaneJobNote | null {
  if (!plan) return null;   // 옛 게이트웨이 · 꺼진 채 저장
  if (plan.uncovered) return { text: '이 증류기를 돌릴 자동 실행이 없습니다. 자동 실행을 켜기 전에는 자료를 읽지 않습니다', warn: true };
  const rest = '맡은 증류기가 없는 자료도 기본 기준으로 함께 나갑니다';
  if (plan.action === 'create') {
    const min = Math.round((Number(plan.interval_sec) || 600) / 60);
    return { text: `${min}분마다 켜진 증류기를 전부 돌리는 자동 실행을 새로 만들었습니다. ${rest}`, warn: false };
  }
  if (plan.action === 'widen') return { text: `자동 실행이 켜진 증류기를 전부 돌리도록 넓혔습니다. ${rest}`, warn: false };
  return null;
}
