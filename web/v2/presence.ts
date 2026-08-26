// v2/presence.ts — "지금 이 세션을 보고 있는 사람"(#2116)의 작은 집.
//
// 왜 따로 두나: 도장을 찍는 곳(main.ts 의 8초 틱 markViewedSessionSeen)과 얼굴을 그리는 곳(panes.ts 의 문패)이
//  서로를 모른다. 둘을 직접 잇자면 mountPanes 옵션에 콜백을 하나 더 뚫어야 하는데, 그러면 화면 하나를 위해
//  셸의 계약이 넓어진다. 둘 다 이 상자만 알면 된다 — main 은 넣고, 문패는 꺼내 그린다.
//
// 서버가 얼굴을 **열람 도장의 응답에 실어** 주므로 여기엔 폴링이 없다(src/terminal/chat-routes.ts viewerFaces).
export interface Viewer { id: string; name: string }

const byS = new Map<string, Viewer[]>();
const subs = new Set<(sid: string) => void>();

const same = (a: Viewer[], b: Viewer[]): boolean => a.length === b.length && a.every((x, i) => x.id === b[i].id);

/** 서버가 준 얼굴 줄을 넣는다. **바뀐 게 없으면 아무에게도 알리지 않는다** — 15초마다 같은 얼굴을 다시 그리면 문패가 깜빡인다. */
export function setViewers(sid: string, list: Viewer[] | null | undefined): void {
  if (!sid) return;
  const next = (Array.isArray(list) ? list : [])
    .filter((v) => v && v.id)
    .map((v) => ({ id: String(v.id), name: String(v.name || v.id) }));
  if (same(byS.get(sid) || [], next)) return;
  byS.set(sid, next);
  for (const fn of [...subs]) { try { fn(sid); } catch (_) { /* 한 구독자가 넘어져도 나머지는 간다 */ } }
}

export function viewersOf(sid: string | null | undefined): Viewer[] {
  return (sid && byS.get(sid)) || [];
}

export function onViewers(fn: (sid: string) => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
