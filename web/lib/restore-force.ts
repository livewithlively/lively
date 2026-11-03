// 복원이 «모른다» 로 멈췄을 때 어떻게 하나 (#3870 → #5300).
//
// #5300 — 사람이 직접 되살리라고 했으면 **묻지 않고** 새로 띄운다(restoreForUser 머리말). 아래는 #3870 의 경위다.
//
// 왜 이 판정이 한 자리에 있어야 하나 — 서버의 안내 문구는 «화면의 [강제로 되살리기] 를 눌러 주세요» 라고
//  **화면의 장치를 지목**했다(#5300 에서 지목을 뺐다). 그런데 그 장치를 실제로 그리던 곳은 대화창 하나뿐이었고, 복원을 부르는 나머지
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

/** 사람 손을 거쳐 강제 복원하는 자리(자동으로 열다 멈춘 단독 터미널 배너)의 버튼 글자 — 사람 말로 «무엇이 일어나나» 를 말한다.
 *  ⚠ #5300 — 종전엔 '강제로 되살리기' 였다(서버 문구가 그 이름을 지목해서). 서버는 이제 화면의 장치를 지목하지 않는다. */
export const RESTORE_FORCE_LABEL = '새로 띄워 이어 가기';

/** 강제로 되살렸을 때 사람에게 할 한 줄 — 무엇이 일어났는지만 말한다(옛 세션의 뒷정리는 시스템 몫이다). */
export const RESTORE_FORCED_NOTE = '이전 세션이 응답하지 않아 새로 띄웠어요 — 대화는 이어집니다.';

/**
 * 사람이 **직접** 되살리라고 했을 때의 복원 (#5300, 원준님 2026-11-03: «강제로 되살리기 이거 없는데?» → «사용자 입장에선 어떻게»).
 *
 * «모름» 이면 **묻지 않고** force 로 한 번 더 부른다. 근거:
 *  · 종전(#3752 ④ · #3870)엔 «옛 세션이 살아 있을 수도 있는데 새로 띄울까요?» 를 사람에게 물었다. 그런데 사람은 그걸
 *    판단할 근거가 없다 — 원하는 건 «대화를 이어 가는 것» 하나다. 그리고 묻는 장치가 빠진 화면(대화창의 [이어서 대화하기]·
 *    말 걸어 되살리기)에선 서버 문구만 남아 **없는 버튼을 누르라는 막다른 안내**가 됐다(이번 신고).
 *  · 그 위험(옛 세션이 실은 살아 있으면 한 대화를 둘이 잡는다)은 사람이 아니라 시스템이 치운다: 강제 복원은 새 id 로 뜨고
 *    옛 id 에 이정표(superseded_by)를 적으며(routes.ts restore 박스 갈래), 세션 브로커가 장부(session-ledger.ts)의
 *    superseded_by 를 «은퇴했다» 로 읽어 옛 컨테이너를 걷는다(restore-same-id.ts ①).
 *  · force 요청도 서버가 **생사를 처음부터 다시 잰다** — 그새 살아 있다고 답하면 already, 끝났다고 답하면 보통 복원이다.
 *    즉 이 두 번째 요청이 곧 «한 번 더 확인» 이고, 그래도 모를 때만 새로 띄운다.
 *
 * ⚠ **사람의 행동**(누름·말 보내기)에서만 쓴다. 화면이 스스로 거는 자동 복원은 종전대로 확답만 믿는다(#835) —
 *  보기만 해서 세션이 둘로 서는 일은 막는다. 그 경로가 «모름» 을 받으면 사람이 다음에 누르거나 말할 때 여기로 온다.
 * ⚠ force 로 풀리지 않는 거절(노드 오프라인 등 — canForce 가 없다)은 그대로 던진다. 옛 서버(canForce 미탑재)도 그대로 던진다.
 *
 * @param call 복원 한 번(force 여부를 받는다). 끊김 재시도 같은 감싸기는 부르는 쪽이 이 안에 넣는다.
 * @param onForce 두 번째(force) 요청 직전에 — 버튼 글자 등을 바꾸게.
 */
export async function restoreForUser<T>(call: (force: boolean) => Promise<T>, onForce?: () => void): Promise<{ r: T; forced: boolean }> {
  try {
    return { r: await call(false), forced: false };
  } catch (e) {
    if (!canForceRestore(e)) throw e;
    onForce?.();
    return { r: await call(true), forced: true };
  }
}

/** 복원 엔드포인트 경로. force 는 «옛 것이 살아 있을 수도 있음을 알고 새로 만든다» 는 선언이라 기본값이 아니다. */
export function restorePath(id: string, force?: boolean): string {
  return '/api/ui/terminal/sessions/' + encodeURIComponent(id) + '/restore' + (force ? '?force=1' : '');
}
