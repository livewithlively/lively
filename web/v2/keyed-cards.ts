// v2/keyed-cards.ts — **제자리 되그리기**의 순수 부품(#4135). 목록을 다시 그릴 때 열쇠가 같은 카드는 노드째 다시 쓰고,
//  달라진 것만 새로 만들며, 사라진 것은 잊는다. DOM 을 모른다(노드는 아무 값) — scripts/keyed-cards.test.mjs 가 그대로 돌린다.
//  왜: 자료 칸(panes-files)이 8초마다 격자를 통째로 새로 만들어 미리보기가 전부 다시 받아졌다(원준 2026-09-25 "계속 깜빡거려").
//   바뀐 카드만 바뀌어야 한다 — «무엇이 바뀌었나» 는 열쇠(keyOf)가 말하고, 노드 재사용 규칙은 여기 한 자리다.
export interface KeyedCard<N> { key: string; node: N }

/**
 * 이전 카드(cards)를 이번 항목(ordered)에 맞춘다 — cards 는 제자리에서 갱신되고, 돌려주는 배열은 ordered 와 같은 순서다.
 *  · id 가 같고 열쇠가 같으면 이전 노드 그대로(make 안 부름)  · 열쇠가 다르면 make 로 새로 만들어 갈아 끼움
 *  · 이번에 없는 id 는 cards 에서 지움
 *  ⚠ idOf 는 고유해야 한다(같은 id 가 두 번 오면 같은 노드가 두 번 돌아간다 — DOM 이면 뒤에 붙인 자리로 옮겨진다).
 */
export function reuseKeyed<T, N>(
  cards: Map<string, KeyedCard<N>>, ordered: readonly T[],
  idOf: (t: T) => string, keyOf: (t: T) => string, make: (t: T) => N,
): N[] {
  const keep = new Set<string>();
  const out = ordered.map((t) => {
    const id = idOf(t), key = keyOf(t);
    keep.add(id);
    const had = cards.get(id);
    if (had && had.key === key) return had.node;
    const node = make(t);
    cards.set(id, { key, node });
    return node;
  });
  for (const id of cards.keys()) if (!keep.has(id)) cards.delete(id);
  return out;
}

/** placeChildren 이 보는 DOM 의 최소 모양 — 테스트가 가짜로 흉내 낸다. */
export interface ChildHost<N> {
  childNodes: ArrayLike<N>;
  insertBefore(node: N, before: N | null): unknown;
  removeChild(node: N): unknown;
}

/**
 * 자식을 `nodes` 순서로 맞추되 **제자리인 노드는 건드리지 않는다** — replaceChildren 은 재사용 노드까지 떼었다 붙여서
 *  시안 미리보기(iframe)가 다시 실리고 이름 고치는 입력칸이 포커스를 잃는다.
 *  ★ 순서: ① 이번에 없는 노드를 **먼저** 뗀다 ② 그 다음 자리가 다른 것만 옮긴다. 종전엔 옛 노드를 둔 채 앞에서부터
 *   insertBefore 를 했는데, 맨 앞 카드 하나가 새 노드로 갈리면(AGENTS.md — 8초마다 도장이 바뀌던 파일) 옛 노드가
 *   그 자리에 남아 **그 뒤 카드 전부**가 한 칸씩 «자리가 다르다» 가 되어 떼었다 붙여졌다 — 그래서 시안 미리보기가
 *   전부 다시 실렸다(#4135, 원준 2026-09-25 "hub-widgets-review.html 도 깜빡거려"). 뗀 뒤에 견주면 옮길 것이 없다.
 */
export function placeChildren<N>(host: ChildHost<N>, nodes: readonly N[]): void {
  const keep = new Set<N>(nodes);
  for (const c of Array.from(host.childNodes)) if (!keep.has(c)) host.removeChild(c);
  nodes.forEach((n, i) => { if (host.childNodes[i] !== n) host.insertBefore(n, host.childNodes[i] ?? null); });
}
