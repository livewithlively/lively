// lib/unsaved-text.ts — **저장하지 못한 글**의 임시 보관(#4084). DOM·fetch 를 모른다 — 저장소(Storage 모양)는 받는다.
//
//  왜 필요한가(격리 리뷰 2026-09-20): 자동저장은 글칸이 닫힌 **뒤에** 실패할 수 있다 — 저장이 가는 도중에 접이를 닫거나
//   탭을 닫거나 창을 닫으면, 그 저장이 충돌(409)·네트워크 오류로 끝났을 때 글은 이미 사라진 글칸 안에만 있었다. 안내할
//   화면도 없어 **사람이 쓴 글이 조용히 없어진다**. 그래서 글칸 밖에 한 벌을 남겨, 다음에 그 칸을 열 때 되살릴 수 있게 한다
//   («사람이 쓰던 글은 그 창이 다른 화면으로 바뀌어도 살아남아야 한다» — #2037 의 규칙과 같은 뜻).
//  넘치지 않게: 열쇠는 MAX 개까지(오래된 것부터 버린다), 글 하나는 LIMIT 자까지(넘으면 보관하지 않는다 — 잘린 본문을
//   되살려 저장하면 그게 더 큰 사고다).
export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }
interface Entry { text: string; at: number }
const MAX = 8;
const LIMIT = 300_000;

function readAll(st: StorageLike, key: string): Record<string, Entry> {
  try {
    const o = JSON.parse(st.getItem(key) || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, Entry> : {};
  } catch (_) { return {}; }
}
function writeAll(st: StorageLike, key: string, all: Record<string, Entry>): void {
  try { st.setItem(key, JSON.stringify(all)); } catch (_) { /* 저장소가 찼다·막혔다 — 보관만 못 할 뿐 */ }
}

/** 글을 보관한다. 돌려주는 값은 «보관했나» — 너무 길면 false(잘라서 보관하지 않는다). */
export function stashUnsaved(st: StorageLike, key: string, id: string, text: string, now: number = Date.now()): boolean {
  if (text.length > LIMIT) return false;
  const all = readAll(st, key);
  all[id] = { text, at: now };
  const ids = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
  for (const old of ids.slice(MAX)) delete all[old];
  writeAll(st, key, all);
  return true;
}

/** 보관된 글(없으면 null). 꺼내도 지우지 않는다 — 되살린 글이 실제로 저장된 뒤에 dropUnsaved 로 지운다. */
export function peekUnsaved(st: StorageLike, key: string, id: string): string | null {
  const e = readAll(st, key)[id];
  return e && typeof e.text === 'string' ? e.text : null;
}

export function dropUnsaved(st: StorageLike, key: string, id: string): void {
  const all = readAll(st, key);
  if (!(id in all)) return;
  delete all[id];
  writeAll(st, key, all);
}
