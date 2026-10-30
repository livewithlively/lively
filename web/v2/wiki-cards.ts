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

// ── 첫 화면 줄 나누기(#4233, 원준 2026-09-25) ─────────────────────────────────────
//  위키 사이드바는 처음 들어왔을 때 **스크롤 없이 한 화면**이어야 하고, 묶음 셋은 늘 다 보이며 안쪽도 일부씩 보여야 한다
//   (검토판 project/4233/wiki-sidebar-v3-review.html). 그래서 펼친 묶음마다 보일 분류 줄 수를 **높이에 맞춰** 나눈다.
//  높이를 줄 수로 바꾸는 것(DOM 측정)은 호출자(side.ts)가 하고, 나누는 규칙은 여기 한 벌 — 화면 없이 시험한다.
//  ① 묶음마다 최소 min(2)줄(분류가 그보다 적으면 전부). forced(지금 보는 분류까지)가 더 크면 그만큼.
//  ② 남은 예산은 가장 많이 남은 묶음부터 한 줄씩(같으면 앞 묶음).
//  ③ completeMax(3)개 이하만 숨은 작은 묶음은, 가장 큰 묶음이 bigKeep(5)줄 이상 남는 한 큰 묶음 줄을 넘겨받아 끝까지 보인다
//     — 「3개 더」 같은 자투리 줄을 줄이되, 작은 화면에서 큰 묶음이 2줄로 쪼그라들지는 않게.
//  ④ 예산이 최소치보다 작으면 최소치를 그대로 준다(묶음이 아예 안 보이는 것보다 넘쳐 스크롤되는 게 낫다).
export function allocWikiRows(input: {
  sizes: Record<string, number>;
  order: string[];
  budget: number;
  forced?: Record<string, number>;
  min?: number;
  completeMax?: number;
  bigKeep?: number;
}): Record<string, number> {
  const { sizes, order } = input;
  const forced = input.forced || {};
  const min = input.min ?? 2;
  const completeMax = input.completeMax ?? 3;
  const bigKeep = input.bigKeep ?? 5;
  const size = (k: string): number => Math.max(0, Math.floor(Number(sizes[k]) || 0));
  const must = (k: string): number => Math.max(0, Math.floor(Number(forced[k]) || 0));
  const alloc: Record<string, number> = {};
  for (const k of order) alloc[k] = Math.min(size(k), Math.max(min, must(k)));
  let left = Math.floor(Number(input.budget) || 0) - order.reduce((a, k) => a + alloc[k], 0);
  while (left > 0) {
    let pick: string | null = null;
    let best = 0;
    for (const k of order) { const r = size(k) - alloc[k]; if (r > best) { best = r; pick = k; } }
    if (pick == null) break;
    alloc[pick]++;
    left--;
  }
  let big: string | null = null;
  for (const k of order) if (big == null || size(k) > size(big)) big = k;
  if (big != null) {
    const smalls = order.filter((k) => k !== big).sort((a, b) => (size(a) - alloc[a]) - (size(b) - alloc[b]));
    for (const k of smalls) {
      const hidden = size(k) - alloc[k];
      if (hidden <= 0 || hidden > completeMax) continue;
      const bigAfter = alloc[big] - hidden;
      if (bigAfter < bigKeep || bigAfter < must(big)) continue;
      alloc[big] = bigAfter;
      alloc[k] += hidden;
    }
  }
  return alloc;
}
