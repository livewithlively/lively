// liv-mark.ts — «리브가 세팅한 것» 표시. 서비스 공통 부품(#4135 코멘트 4 · 리브 표시 1안).
//
//  규칙 하나: 사람이 손대지 않았는데 리브가 만들어 둔 것에는 어디서나 같은 표시를 쓴다.
//   ① 행 · 카드 — 옅은 초록 바탕 + 왼쪽 초록 띠(`liv-row` · `liv-card`)  ② 이름표 — 채운 초록 «리브가 세팅»(`liv-mark`)
//   ③ 목록 머리 — «4개 중 3개를 리브가 세팅했어요»(`liv-sum`).
//  종전엔 화면마다 흐린 배지 «리브가 만듦»을 따로 그렸다(수집기 행 · 증류기 카드 · 꺼 둔 증류기 행, 셋 다 제 코드).
//   원준 2026-09-27 «뱃지는 너무 약함 … 모든 곳에서 다 공통으로 통용되는 언어» · 2026-09-28 «1안으로 구현하자».
//  ⚠ 채운 이름표는 디자인 가이드의 «채운 컬러 필 금지»의 예외다 — 리브 표시에만 쓴다(결정: 원준 2026-09-28).
//  무엇이 리브 것인지의 판정은 부르는 쪽이 한다(수집기 isLivMade · 증류기 isLivMadeDistiller). 셈과 문구는 lib/liv-mark.ts.
import { el, sv } from './core.js';
import { LIV_MARK_TEXT, livSummary, livSummaryParts, livSummaryText } from './lib/liv-mark.js';

/** 리브가 세팅한 행 · 카드에 붙는 클래스. */
export const LIV_ROW = 'liv-row';
export const LIV_CARD = 'liv-card';

/** 리브 앱 아이콘과 같은 형태(v2/icons liv). */
export function livIcon(cls = 'liv-ic'): SVGElement {
  const n = sv('svg', { class: cls, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 12, cy: 12, r: 9 }), sv('circle', { cx: 12, cy: 12, r: 2.5 }));
  return n;
}

/** 이름표 — 채운 초록 «리브가 세팅». title 은 그것이 어떻게 생겼는지 한 줄. */
export function livMark(title = '리브가 자동으로 세팅했습니다'): HTMLElement {
  return el('span', { class: 'liv-mark', title }, livIcon(), el('span', { text: LIV_MARK_TEXT }));
}

/** 누가 만들었나 — 리브 것이면 이름표, 아니면 종전의 «직접 만듦». */
export function madeBy(liv: boolean, title?: string): HTMLElement {
  return liv ? livMark(title) : el('span', { class: 'cxc-who', text: '직접 만듦' });
}

/** 목록 머리의 요약 — 리브 것이 하나도 없으면 null(부르는 쪽이 붙이지 않는다). */
export function livSum(total: number, liv: number): HTMLElement | null {
  const s = livSummary(total, liv), p = livSummaryParts(s);
  if (!p) return null;
  return el('span', { class: 'liv-sum', 'aria-label': livSummaryText(s) }, livIcon(),
    el('span', {}, p.pre, el('b', { class: 'num', text: p.strong }), p.post));
}
