// lib/finder-keys.ts — 파일 칸(곁칸 «자료»)의 **키 판정 한 자리**(#3870). DOM 을 모르는 잎 모듈이라 시험이 그대로 부른다.
//
//  원준 2026-09-30: «맥이랑 윈도우의 Finder나 파일탐색기 수준으로 … 구현안된 단축키 등도 모두 실현가능하게.
//   예를 들어 맥은 파일 선택하고 엔터 누르면 이름 수정이고 이런게 있음.»
//
//  ── 두 운영체제는 같은 키에 다른 뜻을 둔다 — 그래서 표가 둘이다 ──
//   · Enter      맥 파인더 = 이름 바꾸기 · 윈도 탐색기 = 열기
//   · Backspace  맥 = (⌘ 와 함께) 휴지통 · 윈도 = 뒤로(앞 폴더)
//   · ⌘D / Ctrl+D  맥 = 복제 · 윈도 = 삭제
//   · 위 폴더    맥 ⌘↑ · 윈도 Alt+↑
//   · 뒤로/앞으로 맥 ⌘[ ⌘] · 윈도 Alt+← Alt+→
//   그 밖(⌘A·⌘C·⌘X·⌘V·⇧⌘N·⌘F·⌘Z·F2·Space·방향키·Home/End)은 수식키만 ⌘ ↔ Ctrl 로 바뀐다.
//  ⚠ 글자 단축키는 **e.code(자판 위치)** 로 본다 — 한글 입력기가 켜져 있으면 ⌘C 의 e.key 가 'ㅊ' 로 오는 브라우저가 있다.
//  ⚠ 일부러 안 넣은 것: ⌘1·⌘2(보기) — 브라우저에선 탭 전환 키라 가로채면 사람이 탭을 못 옮긴다. ⌘+·⌘-(아이콘 크기) —
//   브라우저 확대·축소 키다. 둘 다 도구줄·우클릭 메뉴에 있다.

export type FinderAction =
  | 'open' | 'rename' | 'quicklook' | 'parent' | 'back' | 'forward'
  | 'delete' | 'selectAll' | 'clear' | 'newFolder'
  | 'copy' | 'cut' | 'paste' | 'pasteMove' | 'duplicate'
  | 'find' | 'undo'
  | 'up' | 'down' | 'left' | 'right' | 'first' | 'last';

export interface KeyLike {
  key: string; code?: string;
  metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean;
  isComposing?: boolean;
}
export interface FinderKey { act: FinderAction; extend?: boolean }

/** 맥인가 — 판정은 한 자리. iPad 사파리는 platform 을 MacIntel 로 준다(외장 키보드 문법도 맥이다). */
export function isMacPlatform(nav: { platform?: string; userAgent?: string } | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  return /mac|iphone|ipad|ipod/i.test(String(nav?.platform || nav?.userAgent || ''));
}

/** 글자 자판 위치('KeyC') → 'c'. code 가 없으면(합성 이벤트·옛 브라우저) key 를 소문자로. */
function letter(e: KeyLike): string {
  const m = /^Key([A-Z])$/.exec(String(e.code || ''));
  return m ? m[1].toLowerCase() : String(e.key || '').toLowerCase();
}

/**
 * 키 하나 → 파일 칸의 동작. 해당이 없으면 null(브라우저·다른 손잡이에게 넘긴다).
 *  mac = 맥 문법인가(isMacPlatform). 한글 조합 중에는 아무것도 하지 않는다.
 */
export function finderKey(e: KeyLike, mac: boolean): FinderKey | null {
  if (e.isComposing) return null;
  const mod = mac ? !!e.metaKey : !!e.ctrlKey;          // 주 수식키(⌘ / Ctrl)
  const other = mac ? !!e.ctrlKey : !!e.metaKey;        // 반대쪽 수식키 — 섞이면 이 칸의 단축키가 아니다
  const alt = !!e.altKey, shift = !!e.shiftKey;
  const k = e.key;
  if (other) return null;

  // ── 방향·처음·끝 — 수식키 없이(⇧ 는 범위 넓히기) ──
  if (!mod && !alt) {
    if (k === 'ArrowUp') return { act: 'up', extend: shift };
    if (k === 'ArrowDown') return { act: 'down', extend: shift };
    if (k === 'ArrowLeft') return { act: 'left', extend: shift };
    if (k === 'ArrowRight') return { act: 'right', extend: shift };
    if (k === 'Home') return { act: 'first', extend: shift };
    if (k === 'End') return { act: 'last', extend: shift };
  }

  if (mac) {
    if (!mod && !alt && !shift) {
      if (k === 'Enter') return { act: 'rename' };
      if (k === 'F2') return { act: 'rename' };
      if (k === ' ') return { act: 'quicklook' };
      if (k === 'Escape') return { act: 'clear' };
      if (k === 'Backspace' || k === 'Delete') return { act: 'delete' };   // 파인더는 ⌘⌫ 만 — 종전 이 칸의 ⌫ 도 그대로 둔다(확인창이 받친다)
    }
    if (alt && !mod && !shift) {
      if (k === 'ArrowUp') return { act: 'first' };        // 파인더 ⌥↑ = 맨 처음
      if (k === 'ArrowDown') return { act: 'last' };       // ⌥↓ = 맨 끝
    }
    if (mod && !alt) {
      if (k === 'ArrowUp' && !shift) return { act: 'parent' };
      if (k === 'ArrowDown' && !shift) return { act: 'open' };
      if (k === 'Backspace' && !shift) return { act: 'delete' };
      if (k === '[' || e.code === 'BracketLeft') return shift ? null : { act: 'back' };
      if (k === ']' || e.code === 'BracketRight') return shift ? null : { act: 'forward' };
      const c = letter(e);
      if (shift) return c === 'n' ? { act: 'newFolder' } : null;
      if (c === 'a') return { act: 'selectAll' };
      if (c === 'o') return { act: 'open' };
      if (c === 'c') return { act: 'copy' };
      if (c === 'x') return { act: 'cut' };
      if (c === 'v') return { act: 'paste' };
      if (c === 'd') return { act: 'duplicate' };
      if (c === 'f') return { act: 'find' };
      if (c === 'z') return { act: 'undo' };
    }
    if (mod && alt && !shift && letter(e) === 'v') return { act: 'pasteMove' };   // ⌥⌘V = 옮기기(파인더)
    return null;
  }

  // ── 윈도 탐색기 ──
  if (!mod && !alt && !shift) {
    if (k === 'Enter') return { act: 'open' };
    if (k === 'F2') return { act: 'rename' };
    if (k === ' ') return { act: 'quicklook' };
    if (k === 'Escape') return { act: 'clear' };
    if (k === 'Delete') return { act: 'delete' };
    if (k === 'Backspace') return { act: 'back' };
  }
  if (alt && !mod && !shift) {
    if (k === 'ArrowUp') return { act: 'parent' };
    if (k === 'ArrowLeft') return { act: 'back' };
    if (k === 'ArrowRight') return { act: 'forward' };
  }
  if (mod && !alt) {
    const c = letter(e);
    if (shift) return c === 'n' ? { act: 'newFolder' } : null;
    if (c === 'a') return { act: 'selectAll' };
    if (c === 'c') return { act: 'copy' };
    if (c === 'x') return { act: 'cut' };
    if (c === 'v') return { act: 'paste' };
    if (c === 'd') return { act: 'delete' };
    if (c === 'f' || c === 'e') return { act: 'find' };
    if (c === 'z') return { act: 'undo' };
  }
  return null;
}

/**
 * 방향키로 옮길 다음 칸. n = 칸 수 · cols = 한 줄에 선 칸 수(목록 보기는 1) · cur = 지금 칸(-1 = 아무것도 안 골랐다).
 *  · 아무것도 안 골랐을 때 ↓·→·처음은 첫 칸, ↑·←·끝은 마지막 칸(파인더와 같다).
 *  · 목록 보기(cols 1)에서 ←→ 는 움직이지 않는다 — 파인더 목록의 ←→ 는 폴더 펼치기이고, 이 목록엔 펼칠 나무가 없다.
 *  · 아이콘 보기의 ↓ 는 바로 아래 칸, 아래가 비었으면(마지막 줄이 짧다) 다음 줄의 마지막 칸, 이미 마지막 줄이면 그대로.
 */
export function navIndex(n: number, cols: number, cur: number, act: 'up' | 'down' | 'left' | 'right' | 'first' | 'last'): number {
  if (n <= 0) return -1;
  const c = Math.max(1, Math.floor(cols) || 1);
  if (act === 'first') return 0;
  if (act === 'last') return n - 1;
  if (cur < 0 || cur >= n) return act === 'down' || act === 'right' ? 0 : n - 1;
  if (act === 'left') return c === 1 ? cur : Math.max(0, cur - 1);
  if (act === 'right') return c === 1 ? cur : Math.min(n - 1, cur + 1);
  if (act === 'up') return cur - c >= 0 ? cur - c : cur;
  // down
  if (cur + c < n) return cur + c;
  return Math.floor(cur / c) < Math.floor((n - 1) / c) ? n - 1 : cur;
}

// ── 타이핑으로 고르기(type-select) — 파인더·탐색기 둘 다: 이름 첫머리를 치면 그 항목으로 간다 ──
//  한국어 이름이 많다: 「세션」을 찾으려고 ㅅ·세 를 치든, 한글 입력기가 꺼진 채 t 를 치든 닿아야 한다.
//  그래서 세 축을 본다 — ① 친 글자 그대로의 첫머리 ② 초성 첫머리(ㅅㅅ → 세션) ③ 자판 위치를 두벌식 자음으로 읽은 초성(t → ㅅ).
const QWERTY_CHO: Record<string, string> = {
  KeyR: 'ㄱ', KeyS: 'ㄴ', KeyE: 'ㄷ', KeyF: 'ㄹ', KeyA: 'ㅁ', KeyQ: 'ㅂ', KeyT: 'ㅅ', KeyD: 'ㅇ',
  KeyW: 'ㅈ', KeyC: 'ㅊ', KeyZ: 'ㅋ', KeyX: 'ㅌ', KeyV: 'ㅍ', KeyG: 'ㅎ',
};
/** 타이핑 고르기에 쓸 한 글자 — 수식키 없는 인쇄 가능한 글자만. 공백은 버퍼가 이어질 때만(아니면 빠른 보기) 부르는 쪽이 정한다. */
export function typeChar(e: KeyLike): { ch: string; cho: string } | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return null;
  const k = String(e.key || '');
  if ([...k].length !== 1) return null;
  return { ch: k, cho: QWERTY_CHO[String(e.code || '')] || k };
}
const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
function choOf(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) || 0;
    out += c >= 0xac00 && c <= 0xd7a3 ? CHO[Math.floor((c - 0xac00) / 588)] : ch;
  }
  return out;
}
/**
 * 친 버퍼로 고를 항목의 자리. names 는 **화면 순서**. 없으면 -1.
 *  typed = 친 글자 그대로 · choTyped = 같은 키들을 자판 위치로 읽은 두벌식 자음열.
 *  첫머리가 글자 그대로 맞는 것이 먼저, 그다음 초성.
 */
export function typeSelect(names: string[], typed: string, choTyped: string = typed): number {
  const t = typed.toLowerCase();
  if (!t) return -1;
  const byText = names.findIndex((n) => n.toLowerCase().startsWith(t));
  if (byText >= 0) return byText;
  for (const q of [typed, choTyped]) {
    if (!q || !/[ㄱ-ㅎ가-힣]/.test(q)) continue;
    const qc = choOf(q);
    const i = names.findIndex((n) => choOf(n).startsWith(qc));
    if (i >= 0) return i;
  }
  return -1;
}

// ── 복사본 이름 — 파인더는 «이름 복사본.확장자», 탐색기는 «이름 - 복사본.확장자». 겹치면 번호를 올린다 ──
export function copyName(name: string, taken: Set<string>, mac: boolean, isDir: boolean): string {
  const dot = isDir ? -1 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const base = mac ? `${stem} 복사본` : `${stem} - 복사본`;
  if (!taken.has(base + ext)) return base + ext;
  for (let i = 2; i < 1000; i++) {
    const c = mac ? `${base} ${i}${ext}` : `${base} (${i})${ext}`;
    if (!taken.has(c)) return c;
  }
  return `${base} ${Date.now()}${ext}`;
}

/** 단축키 표시(메뉴 오른쪽 흐린 글) — 같은 표에서 뽑아 메뉴와 실제 키가 어긋나지 않게. */
export function keyHint(act: FinderAction, mac: boolean): string {
  const M = mac ? '⌘' : 'Ctrl+';
  switch (act) {
    case 'open': return mac ? '⌘O' : 'Enter';
    case 'rename': return mac ? '↩' : 'F2';
    case 'quicklook': return 'Space';
    case 'parent': return mac ? '⌘↑' : 'Alt+↑';
    case 'back': return mac ? '⌘[' : 'Alt+←';
    case 'forward': return mac ? '⌘]' : 'Alt+→';
    case 'delete': return mac ? '⌘⌫' : 'Delete';
    case 'selectAll': return M + 'A';
    case 'newFolder': return mac ? '⇧⌘N' : 'Ctrl+Shift+N';
    case 'copy': return M + 'C';
    case 'cut': return M + 'X';
    case 'paste': return M + 'V';
    case 'pasteMove': return mac ? '⌥⌘V' : '';
    case 'duplicate': return mac ? '⌘D' : '';
    case 'find': return M + 'F';
    case 'undo': return M + 'Z';
    default: return '';
  }
}
