// lib/liv-mark.ts — «리브가 세팅한 것» 표시의 셈과 문구. 순수 함수(#4135 코멘트 4 · 리브 표시 1안).
//
//  원준 2026-09-27 «리브가 자동으로 세팅해준 모든건 … 우리 서비스의 언어 … 모든 곳에서 다 공통으로 통용 … 뱃지는 너무 약함» ·
//   2026-09-28 «리브 표시는 1안으로 구현하자»(바탕색 + 왼쪽 띠 + 채운 이름표 + 머리 요약).
//  화면(web/liv-mark.ts)은 이 값을 그리기만 한다. 시험: scripts/liv-mark.test.mjs.

/** 이름표의 글자 — 어디서나 같다. */
export const LIV_MARK_TEXT = '리브가 세팅';

/** none 요약 없음 · some 일부 · all 전부(둘 이상) · one 하나뿐인데 그것이 리브 것. */
export interface LivSummary { kind: 'none' | 'some' | 'all' | 'one'; total: number; liv: number }

/** 셀 수 없는 값(NaN · 음수 · null)은 0, 소수는 내림. */
const count = (v: unknown): number => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };

/** 몇 개 중 몇 개가 리브 것인가. 리브 수가 전체보다 크면 전체로 본다. */
export function livSummary(total: unknown, liv: unknown): LivSummary {
  const t = count(total), l = Math.min(count(liv), t);
  if (!t || !l) return { kind: 'none', total: t, liv: 0 };
  if (l < t) return { kind: 'some', total: t, liv: l };
  return { kind: t === 1 ? 'one' : 'all', total: t, liv: l };
}

/** 요약 문구의 세 토막 — 가운데(strong)만 굵게 선다. 요약이 없으면 null. */
export function livSummaryParts(s: LivSummary): { pre: string; strong: string; post: string } | null {
  if (s.kind === 'none') return null;
  if (s.kind === 'some') return { pre: s.total + '개 중 ', strong: s.liv + '개', post: '를 리브가 세팅했어요' };
  if (s.kind === 'one') return { pre: '', strong: '1개', post: '를 리브가 세팅했어요' };
  return { pre: '', strong: s.total + '개 모두', post: ' 리브가 세팅했어요' };
}

/** 한 줄 글자(읽어 주는 이름 · 시험용). */
export function livSummaryText(s: LivSummary): string {
  const p = livSummaryParts(s);
  return p ? p.pre + p.strong + p.post : '';
}

/** 목록에서 리브 것을 센다. 목록이 없으면 0, 판정이 던지는 항목은 리브 것이 아닌 것으로 센다. */
export function countLiv<T>(items: readonly T[] | null | undefined, isLiv: (x: T) => boolean): number {
  let n = 0;
  for (const x of items || []) { try { if (isLiv(x)) n++; } catch { /* 판정 못 한 것은 세지 않는다 */ } }
  return n;
}
