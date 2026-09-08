// lib/find.ts — **찾기의 잣대 한 자리**(#762). 사이드바가 쓰던 판정기를 잎 모듈로 내렸다.
//  이유는 그 판정기가 처음 만들어진 이유와 같다(#2534 원준: "검색 품질이 너무 안 좋다"): 구역마다
//  `includes(q)` 를 새로 적으면 한국어에서 사람이 실제로 치는 것이 전부 0건이 된다. 자료 칸·타임라인처럼
//  찾을 곳이 늘 때마다 잣대를 베끼지 않도록, 잣대는 여기 하나만 둔다.
const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
/** 한글 음절은 초성 한 자로, 나머지 글자(영문·숫자·호환자모)는 그대로. '프로젝트 762' → 'ㅍㄹㅈㅌ 762' */
export function chosung(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) || 0;
    out += c >= 0xac00 && c <= 0xd7a3 ? CHO[Math.floor((c - 0xac00) / 588)] : ch;
  }
  return out;
}
//  칸 사이 경계는 남기고(줄바꿈) 칸 **안의** 띄어쓰기만 지운다 — 다 지우면 '…프로젝트' + '세션…' 이
//  한 낱말로 붙어 엉뚱한 것이 걸린다(제목 끝과 다음 칸 머리를 잇는 질의가 통과한다).
export const deSpace = (s: string): string => s.replace(/[ \t ]+/g, '');
/** 질의에 자모가 섞여 있나 — 초성 축은 이때만 본다. 늘 보면 '세션'(→ㅅㅅ)이 온 목록을 통과시킨다. */
const HAS_JAMO = /[ㄱ-ㅎ]/;
/**
 * 찾기 판정기. 빈 질의는 늘 참(거르지 않는다).
 *  · 공백으로 끊은 **낱말 전부**가 들어 있어야 한다(AND) — 순서는 안 본다.
 *  · 각 낱말은 띄어쓰기를 지운 축에서 찾는다 — 「새세션」 ↔ '새 세션'.
 *  · 자모가 섞인 낱말은 **초성 축**에서도 찾는다 — 「ㅍㄹㅈㅌ」·조합 중인 「프로젝ㅌ」.
 */
export function findMatcher(raw: string): (...parts: Array<string | null | undefined>) => boolean {
  const q = String(raw || '').trim().toLowerCase();
  if (!q) return () => true;
  const toks = q.split(/\s+/).filter(Boolean);
  return (...parts): boolean => {
    const hay = parts.filter(Boolean).join('\n').toLowerCase();
    const flat = deSpace(hay);
    let cho = '';
    return toks.every((t) => {
      if (flat.includes(deSpace(t))) return true;
      if (!HAS_JAMO.test(t)) return false;
      if (!cho) cho = deSpace(chosung(hay));
      return cho.includes(deSpace(chosung(t)));
    });
  };
}
