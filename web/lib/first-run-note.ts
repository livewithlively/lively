// 시각을 준 1회성 잡이 언제 도는지 말한다 (#5235) — 순수 규칙.
//
//  1회성이 시각을 지키게 되면서 이미 지난 날짜를 넣으면 다음 해를 조용히 기다리게 됐다. 목록의 «다음 실행» 은 한 번 돈 뒤에야 채워져
//   저장한 사람이 언제 도는지 볼 자리가 없다. 저장 응답 first_run_at 을 그 자리에서 말한다. 값이 없으면(반복 잡·꺼진 잡) 말하지 않는다.

export interface FirstRunNote { text: string; warn: boolean }

export function firstRunNote(at: string | null | undefined, tz: string): FirstRunNote | null {
  if (at === undefined) return null;
  if (at === null) return { text: '이 cron식의 시각이 오지 않아 돌지 않습니다', warn: true };
  const d = new Date(at);
  let when: string;
  try { when = d.toLocaleString('ko-KR', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }); }
  catch { when = d.toISOString(); }   // 브라우저가 모르는 시간대
  return { text: `${when}(${tz})에 한 번 돕니다`, warn: false };
}
