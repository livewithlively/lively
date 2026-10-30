// lib/side-card-live.ts: 세션 카드가 또렷한가 · 비치는가 (#3870 후속, 원준 2026-09-30). 순수 함수만 둔다. DOM 없음.
//
//  곁칸을 끝까지 키워 세션이 카드가 되면, 카드는 쉬는 동안 비친다(v2/side-card.ts · 45-v2-side-swap.css).
//  또렷해지는 것은 사람이 카드를 골랐을 때(누름 · 터미널 초점)와 막 떠오른 잠깐뿐이다. 마우스 올림은 CSS(:hover)가 따로 본다.
//  세션이 답을 기다리는지는 보지 않는다 — 무엇을 보고 있는지는 사람이 고른 칸이 정한다.

/** 사람이 누르거나 초점을 옮긴 곳. card = 카드 안 · side = 사이드바 안 · other = 그 밖(카드에서 연 창 · 왼쪽 목록 · 레일). */
export type PickWhere = 'card' | 'side' | 'other';

/** 누름·초점이 옮겨 간 곳에 따라 «카드를 골랐나» 를 다시 정한다. 그 밖(other)은 고름을 그대로 둔다 —
 *  카드에서 연 이름 바꾸기 창으로 초점이 가도 카드가 제 창 뒤에서 비치면 안 된다. */
export function nextPicked(prev: boolean, where: PickWhere): boolean {
  if (where === 'card') return true;
  if (where === 'side') return false;
  return prev;
}

/** 카드가 또렷한가. 카드가 안 보이면(사이드바 접힘 · 좁은 폭 · 카드 아님) 언제나 거짓이다. */
export function isLive(s: { shown: boolean; entering: boolean; picked: boolean }): boolean {
  return s.shown && (s.entering || s.picked);
}
