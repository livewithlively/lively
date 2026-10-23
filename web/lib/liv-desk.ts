// lib/liv-desk.ts — 리브(워크스페이스 담당자) 화면의 순수 규칙 한 자리(#4970 «리브 = 세션 하나»). 잎 모듈이다(import 0).
//
//  리브는 그 사람의 리브 세션 하나다(src/org/liv/session.ts). 화면은 둘이다:
//   · 리브 세션 화면(#/s/<id>) — 보통 세션 화면에 오른쪽 «리브» 칸(지금 손볼 것 · 외부 앱 연결 상태)이 맨 앞에 선다.
//   · 리브 화면(#/liv) — 리브 세션이 없는 사람(로그인한 AI 가 없거나 커서 같은 로컬 AI 를 쓰는 사람)과 그 링크를 받은 사람의 단독 화면.
//  어느 쪽으로 가는지 · 어떤 세션이 리브 세션인지 · 외부 앱 상태를 무슨 말로 쓰는지를 여기 한 곳에서 정한다.

/**
 * 이 주소가 리브 주소(#/liv)인가 — 첫 경로 조각(물음표 앞)이 `liv` 이다.
 *  ⚠ 셸의 routeKey 로 가르지 마라 — 리브 주소는 따로 접는 화면이 아니라 `raw:liv`(물음표까지 붙은 `raw:liv?board=1`)로 접힌다.
 *   `routeKey(hash) === 'liv'` 로 갈랐다가 한 번도 참이 안 돼, 레일 [리브]를 누를 때마다 같은 리브 세션 탭이 하나씩 더 섰다(격리 리뷰).
 */
export function isLivRoute(hash: string | null | undefined): boolean {
  const h = String(hash ?? '').replace(/^#\/?/, '');
  const q = h.indexOf('?');
  return ((q >= 0 ? h.slice(0, q) : h).split('/').filter(Boolean)[0] || '') === 'liv';
}

/** 리브 화면을 늘 띄우라는 주소(`?board=1`)인가 — 로컬 AI 가 주는 링크. */
export function isLivBoard(hash: string | null | undefined): boolean {
  const h = String(hash ?? '');
  const q = h.indexOf('?');
  return q >= 0 && new URLSearchParams(h.slice(q + 1)).get('board') === '1';
}

/** `#/liv` 가 갈 곳 — board=1 이면 늘 리브 화면, 아니면 리브 세션이 있으면 그 세션, 없으면 리브 화면. */
export function livRoute(o: { board: boolean; sessionId: string | null | undefined }): 'board' | 'session' {
  if (o.board) return 'board';
  return String(o.sessionId ?? '').trim() ? 'session' : 'board';
}

/** 이 세션이 리브 세션인가 — 셸이 아는 리브 세션 id 가 그 세션의 이름들(id · 기록 id · 대화 id) 가운데 하나와 같다. 모르면 아니다. */
export function isLivSessionId(names: ReadonlyArray<string | null | undefined>, livId: string | null | undefined): boolean {
  const want = String(livId ?? '').trim();
  if (!want) return false;
  return names.some((n) => String(n ?? '').trim() === want);
}

/** 외부 앱 하나의 «다음 할 일»(서버 org_connect_status 의 next) → 사람 말. 모르는 값은 «확인하지 못했어요». */
export function connectNextText(next: unknown): string {
  switch (next) {
    case 'register_app': return '앱 등록이 필요해요';
    case 'ask_admin': return '관리자에게 요청해야 해요';
    case 'preparing': return '준비 중이에요';
    case 'connect': return '연결할 수 있어요';
    case 'set_scope': return '모을 범위를 정하면 돼요';
    case 'collecting': return '모으고 있어요';
    default: return '확인하지 못했어요';
  }
}

/** 리브 화면의 단독 주소 — 커서 같은 로컬 AI 에게 줄 링크. 리브 세션이 있어도 세션으로 넘기지 않는다. */
export const LIV_BOARD_HASH = '#/liv?board=1';
