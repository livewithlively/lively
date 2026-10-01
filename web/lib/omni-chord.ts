// lib/omni-chord.ts — 통합검색(⌘K)을 여는 키인가 — 판정 한 자리(#4530). DOM 을 모르는 잎이라 시험이 그대로 부른다.
//
//  ── 왜 따로 두나 ──
//  종전 판정은 `e.key` 가 'k' 인지만 봤다. 그런데 **한글 입력기가 켜져 있으면** 같은 자리의 키가 'ㅏ' 로 온다
//   (lib/finder-keys.ts 가 «⌘C 의 e.key 가 'ㅊ' 로 오는 브라우저가 있다» 고 이미 적어 둔 사실). 한글을 치다가 ⌘K 를 누르면
//   통합검색이 안 열렸다(#4530 점검 3번). 맥의 Option+K 도 'k' 가 아니라 '˚' 로 온다.
//  그래서 **글자가 라틴 문자면 그 글자로, 아니면 자판 위치(e.code)로** 본다. 위치만 보면 드보락 같은 자판에서 K 가 적힌
//   키가 안 먹고, 글자만 보면 한글 자판에서 안 먹는다 — 둘을 이 순서로 합친 것이 양쪽 다 되는 판정이다.
//
//  ── 어느 조합인가 ──
//   · ⌘K / Ctrl+K — Shift·Alt 없이(⌘⇧K 같은 다른 단축키를 뺏지 않는다).
//   · Alt+K — 다른 수식키 없이. 터미널이 포커스면 Ctrl+K 는 셸의 kill-line 이라 터미널은 이것만 넘긴다(아래 isTerminalOmniChord).
//   · 수식키가 붙으면 입력기 조합 중이어도 연다 — 수식키가 조합을 끝낸다(조합 중 K 단독은 당연히 글자다).
//
//  ⚠ 단독 터미널 번들(web/standalone/terminal.ts)은 의존 0 이라 이 잎을 import 하지 못한다 — web/standalone/omni-chord.ts 에
//   같은 판정의 사본이 있고, scripts/omni-chord.test.mjs 가 두 사본을 **같은 표로** 돌려 어긋나면 빨간불을 낸다.

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

/** 통합검색을 여는 키인가 — 셸·액자 문서가 쓴다. */
export function isOmniChordLike(e: ChordLike): boolean {
  if (!isKKey(e)) return false;
  if (e.altKey) return !e.metaKey && !e.ctrlKey && !e.shiftKey;      // Alt+K — 터미널이 포커스여도 되는 길
  return !!(e.metaKey || e.ctrlKey) && !e.shiftKey;                   // ⌘K / Ctrl+K
}

/** 터미널 프레임이 셸에 넘길 키인가 — Ctrl+K 는 넘기지 않는다(readline kill-line · 뺏으면 셸이 불편해진다). */
export function isTerminalOmniChord(e: ChordLike): boolean {
  return isOmniChordLike(e) && !e.ctrlKey;
}

/** 화면에 적는 단축키 이름 — 사이드바 검색 단추(side.ts)와 같은 이름을 쓴다.
 *  맥이 아니면 **Alt K** 를 적는다: Ctrl+K 도 먹지만 터미널이 포커스면 안 먹는다. '거의 되는 키'를 적어 두면 안 될 때
 *  고장으로 읽히므로 화면에는 어디서나 되는 쪽을 적는다(side.ts navRow 와 같은 판단). */
export function omniKeyHint(mac: boolean): string {
  return mac ? '⌘K' : 'Alt K';
}
