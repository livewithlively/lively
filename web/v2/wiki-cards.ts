// 위키 사이드바(서가) 카드 계획 — 순수(#1631, 2026-09-14). DOM 을 모른다: 분류·묶음·찾기·보는 분류·접은 카드 → 카드 목록.
//  renderWiki(web/v2/side.ts)는 이 결과를 그대로 그리기만 한다 — 판정이 여기 한 벌이라 시험이 화면 없이 규칙을 잡는다.
//
//  ── 왜 따로 뺐나 ──
//  실측(lively-agent-2-6a84 DB): 묶음 세 칸이 있고 리브가 만든 분류 4개가 그 안에 있었는데, 이 사이드바가 묶음을 안 불러
//   사람 눈엔 «상위 카테고리가 아예 없다» 로 보였다. 서버·클래식 화면은 시험이 있었지만 **사람이 실제로 보는 새 셸 사이드바엔
//   묶음 규칙이 한 줄도 없었다** — 그 빈자리를 다시 만들지 않으려고 규칙을 시험 가능한 자리에 둔다.
//
//  ── 규칙 ──
//  · 묶음이 없으면(옛 판·조회 실패) 종전 한 카드(머리 없음). 찾는 분류가 없으면 카드도 없다.
//  · 묶음이 있으면 묶음마다 카드 한 장 — 서버가 준 묶음 순서 그대로. 카드 안은 rank(우리 팀 먼저 → 문서 많은 순).
//  · 빈 묶음도 카드로 선다(세 칸이 «있다» 는 것이 이 층이 보여 줄 구조다). 단 찾는 중엔 맞는 분류가 없는 카드를 뺀다.
//  · 어느 묶음에도 안 든 분류(비었거나 없는 묶음을 가리킴)는 맨 아래 «묶음을 정해 주세요» 한 장.
//  · 접은 카드라도 찾는 중이거나 지금 보는 분류가 들었으면 편다.

export interface WikiCardCat { id: number; name: string; key: string; description?: string | null; knowledge_count?: number; group?: string | null }
export interface WikiCardGroup { key: string; name: string; hint?: string | null }
export interface WikiCardPlan {
  /** 더 보기·접기 상태의 키. 묶음 카드는 `g:<묶음 key>`, 묶음 밖 카드는 WIKI_LOOSE_KEY, 묶음 없는 판의 한 카드는 WIKI_SINGLE_KEY. */
  key: string;
  /** null = 머리 없는 종전 한 카드. */
  head: { name: string; hint: string | null; fix: boolean } | null;
  cats: WikiCardCat[];
  open: boolean;
}

export const WIKI_SINGLE_KEY = 'cats';
export const WIKI_LOOSE_KEY = 'g:*none';
export const WIKI_LOOSE_NAME = '묶음을 정해 주세요';
export const WIKI_LOOSE_HINT = '아직 묶음이 없는 분류입니다 — 리브가 자료를 읽고 넣거나, 분류체계 화면에서 정할 수 있습니다.';

export function planWikiCards(input: {
  cats: WikiCardCat[];
  groups: WikiCardGroup[];
  searching: boolean;
  hit: (c: WikiCardCat) => boolean;
  rank: (a: WikiCardCat, b: WikiCardCat) => number;
  activeCat: number;
  closed: ReadonlySet<string>;
}): WikiCardPlan[] {
  const { cats, groups, searching, hit, rank, activeCat, closed } = input;
  if (!cats.length) return [];
  if (!groups.length) {
    const shown = cats.filter(hit).sort(rank);
    return shown.length ? [{ key: WIKI_SINGLE_KEY, head: null, cats: shown, open: true }] : [];
  }
  const openOf = (key: string, list: WikiCardCat[]): boolean =>
    searching || list.some((c) => c.id === activeCat) || !closed.has(key);
  const keys = new Set(groups.map((g) => g.key));
  const out: WikiCardPlan[] = [];
  for (const g of groups) {
    const list = cats.filter((c) => c.group === g.key && hit(c)).sort(rank);
    if (searching && !list.length) continue;
    const key = 'g:' + g.key;
    out.push({ key, head: { name: g.name, hint: g.hint ?? null, fix: false }, cats: list, open: openOf(key, list) });
  }
  const loose = cats.filter((c) => !(c.group && keys.has(c.group)) && hit(c)).sort(rank);
  if (loose.length) {
    out.push({ key: WIKI_LOOSE_KEY, head: { name: WIKI_LOOSE_NAME, hint: WIKI_LOOSE_HINT, fix: true }, cats: loose, open: openOf(WIKI_LOOSE_KEY, loose) });
  }
  return out;
}
