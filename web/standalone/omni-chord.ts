// standalone/omni-chord.ts — 통합검색(⌘K) 키 판정의 **사본**(#4530). 단독 터미널 번들은 의존 0 이라 web/lib 를 못 실는다.
//  정본은 web/lib/omni-chord.ts 다. scripts/omni-chord.test.mjs 가 두 사본을 같은 표로 돌려 어긋나면 빨간불을 낸다 —
//  한쪽만 고치지 마라.

export interface ChordLike {
  key?: string; code?: string;
  metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean;
  isComposing?: boolean;
}

/** 눌린 키가 K 인가 — 라틴 글자면 글자로, 아니면(한글 'ㅏ' · 맥 Option 의 '˚' · 입력기의 'Process') 자판 위치로. */
export function isKKey(e: ChordLike): boolean {
  const k = String(e.key || '');
  if (/^[a-z]$/i.test(k)) return k.toLowerCase() === 'k';
  return e.code === 'KeyK';
}

/** 통합검색을 여는 키인가. */
export function isOmniChordLike(e: ChordLike): boolean {
  if (!isKKey(e)) return false;
  if (e.altKey) return !e.metaKey && !e.ctrlKey && !e.shiftKey;
  return !!(e.metaKey || e.ctrlKey) && !e.shiftKey;
}

/** 터미널이 셸에 넘길 키인가 — Ctrl+K 는 readline kill-line 이라 넘기지 않는다(맥 ⌘K · Alt+K 만). */
export function isTerminalOmniChord(e: ChordLike): boolean {
  return isOmniChordLike(e) && !e.ctrlKey;
}
