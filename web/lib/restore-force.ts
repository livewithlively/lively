// 복원이 «모른다» 로 멈췄을 때 사람에게 줄 선택지가 있나 (순수, #3870).
//
// 왜 이 판정이 한 자리에 있어야 하나 — 서버의 안내 문구는 «화면의 [강제로 되살리기] 를 눌러 주세요» 라고
//  **화면의 장치를 지목**한다. 그런데 그 장치를 실제로 그리던 곳은 대화창 하나뿐이었고, 복원을 부르는 나머지
//  다섯 자리(단독 터미널 부팅 게이트·판 목록·세션 목록·대시보드 카드·일괄)는 그 문장을 그대로 토스트했다 —
//  **없는 버튼을 누르라는 막다른 안내**다(실측 2026-09-12, 원준님 신고: 서버 원문이 그대로 화면에 떴다).
//
// ⚠ 상태코드로 가르면 안 된다. 복원 라우트의 409 는 성격이 **둘**이다:
//   · force 로 풀리는 «모름» — 컨테이너 상태 확인 못함 · 이어 도는 세션 확인 못함 · 그 세션 상태 확인 못함
//   · force 로 **안** 풀리는 거절 — 노드 오프라인 · 노드 무응답 · 노드 직접생성이라 되살릴 좌표 없음
//  그래서 서버가 전자에만 `canForce` 를 싣고(src/terminal/routes.ts stateUnknownRestore), 화면은 그것만 본다.
//  종전 대화창의 `e.status === 409` 검사는 후자에도 버튼을 내밀었다 — 눌러도 같은 거절이 돌아오는 헛 선택지다.
//
// ⚠ 롤 순서에 안전하다: 옛 서버(canForce 를 안 싣는 판)에는 false 를 내므로 화면이 없는 길을 약속하지 않는다.
//  그 경우 사람은 종전대로 안내 문구를 보고 잠시 뒤 다시 시도한다(무회귀).
//
// ⚠ 같은 규칙이 단독 터미널 번들에도 있다(web/standalone/terminal.ts — 그 번들은 SPA 와 분리된 tsconfig 라
//  여기를 import 할 수 없다). 두 사본이 같은 답을 내는지는 scripts/restore-force.test.mjs 가 표로 지킨다.

/** 서버가 «이건 강제로 되살릴 수 있다» 고 말했나. 근거가 없으면(옛 서버·다른 오류) false. */
export function canForceRestore(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  if (Number((e as { status?: unknown }).status) !== 409) return false;
  const body = (e as { body?: unknown }).body;
  if (!body || typeof body !== 'object') return false;
  // 참값 흉내(문자열 'true'·1)는 승격하지 않는다 — 서버가 참으로 말한 것만 참이다.
  return (body as { canForce?: unknown }).canForce === true;
}

/** 강제 복원을 고른 사람에게 보일 버튼 글자 — 서버 안내 문구가 지목하는 그 이름과 같아야 한다. */
export const RESTORE_FORCE_LABEL = '강제로 되살리기';

/** 복원 엔드포인트 경로. force 는 «옛 것이 살아 있을 수도 있음을 알고 새로 만든다» 는 선언이라 기본값이 아니다. */
export function restorePath(id: string, force?: boolean): string {
  return '/api/ui/terminal/sessions/' + encodeURIComponent(id) + '/restore' + (force ? '?force=1' : '');
}
