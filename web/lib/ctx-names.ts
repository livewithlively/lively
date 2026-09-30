// lib/ctx-names.ts — 「수집 · 증류」 앱과 그 탭의 화면 이름(#4233). 리프 모듈(import 0): 클래식 번들 · 새 셸 · 시험이 함께 읽는다.
//  원준 2026-09-27: 앱 「맥락 관리」 → 「수집 · 증류」, 첫 탭 「현황」 → 「실시간 현황」, 나머지 탭은 「… 설정」.
//  이 이름을 적는 화면 글이 스무 곳이 넘는다. 글마다 따로 적으면 다음에 이름을 바꿀 때 한두 곳이 옛 이름으로 남는다.
//  주소(#/context/…) · 키(home · sources · …) · 식별자는 그대로다. 바뀐 것은 화면 글뿐이다.

/** 앱 이름. 레일 · 앱 화면 · 화면 머리 · 도움말이 이 값을 쓴다. */
export const CTX_APP_NAME = '수집 · 증류';

/** 옛 이름. 화면의 앱 이름으로 쓰지 않는다. 앱 찾기 · 통합검색이 옛 이름으로도 이 앱을 찾는 검색어이고, 도움말이 옛 이름을 한 번 알려 준다. */
export const CTX_OLD_NAMES: readonly string[] = ['맥락 관리', '맥락관리'];

/** 탭 이름. 키는 주소의 둘째 칸(#/context/<키>)과 같다. */
export const CTX_TAB = {
  home: '실시간 현황',
  runs: '자동 실행 기록',
  inbox: '확인할 것',
  sources: '수집기 설정',
  distill: '증류기 설정',
  checks: '점검 설정',
  deliver: 'AI 주입 설정',
} as const;
export type CtxTabKey = keyof typeof CTX_TAB;

/** 글 안에서 자리를 가리키는 표기. ctxPath('sources') = «[수집 · 증류 ▸ 수집기 설정]», ctxPath() = «[수집 · 증류]». */
export function ctxPath(tab?: CtxTabKey, ...more: string[]): string {
  return '[' + [CTX_APP_NAME, ...(tab ? [CTX_TAB[tab]] : []), ...more].join(' ▸ ') + ']';
}

/** 꺾쇠 없는 표기(빵부스러기 · 짧은 표지). ctxTrail('distill') = «수집 · 증류 ▸ 증류기 설정». */
export function ctxTrail(tab?: CtxTabKey, ...more: string[]): string {
  return [CTX_APP_NAME, ...(tab ? [CTX_TAB[tab]] : []), ...more].join(' ▸ ');
}
