// Claude Code 입력칸의 «선택» — 범위는 웹이 글자 단위로 정하고, 지우는 순간에만 앱에 알린다 (#4406, 2026-09-28)
//
// 왜 #3778(line-edit.ts)의 합성 선택으로 부족한가 — 그 선택은 «앵커 칸 + 앱 커서» 이고, 지우기는 그 사이 글자 수만큼
//  백스페이스를 보낸다. 한 줄 안에서는 정확하지만 줄을 넘으면 셀 수가 없다: 화면만 봐서는 줄바꿈 글자(Shift+Enter)와
//  자동 줄바꿈(단어가 안 들어가 다음 줄로 간 것)을 가를 수 없어, 잘못 세면 사람 글자를 더 지운다. 그래서 한 줄로 막아
//  두었고, 원준님 신고가 그 벽이었다(«⌘↓·↑↓ 로 윗줄 아랫줄까지 선택이 안 된다 · ⌘X 가 안 된다», 2026-09-28).
//
// 이 모듈의 길 — Claude Code(2.1.283, 전체화면)는 **화면 선택을 스스로 갖고, 선택한 채 Backspace 를 받으면 그 범위를
//  자기 입력칸에서 지운다**(바이너리: useInputSelectionBridge().tryDelete — 줄 배치를 아는 앱이 칸→글자 위치를 계산).
//  그러니 «몇 글자인가» 를 우리가 셀 이유가 없다. 우리는 **어느 칸부터 어느 칸까지** 만 정하고, 지우는 순간에
//  합성 마우스 끌기로 그 범위를 앱에 선택시킨 뒤 Backspace 한 번을 보낸다(격리 tmux 실측: 두 줄 걸친 선택·줄바꿈 하나·
//  넓은 글자·끌기+⌫+글자 한 덩이 모두 정확).
//
// ★ 앱 선택의 규칙(실측) — 선택은 **칸 단위·양끝 포함**이고, 지우기는 [첫 칸의 글자 위치, 끝 칸 다음 칸의 글자 위치).
//  그래서 «캐럿 자리 두 개»(칸 사이)를 칸 범위로 바꾸는 규칙이 하나로 정리된다(rangeCells 머리말).
// ★ 앱은 0.5초 안·1칸 이내의 두 번째 누름을 **더블클릭**(단어 선택)으로 읽는다(oqt=500·eg=1) — pressWait.
// ★ 앱의 Shift+←/→ 는 **한 칸씩** 간다(한글은 두 번에 한 글자) · Shift+Home 은 앵커 칸을 선택에 넣는다 — 그래서 넓히기는
//  앱 키로 넘기지 않고 우리가 글자 단위로 계산한다.
//
// 불변식 — 순수하다(DOM·xterm·소켓을 모른다). 화면은 Screen 으로만 읽는다. 실제 읽기·칠하기·보내기는 terminal.ts.

export interface Cell {
  ch: string;     // 그 칸의 글자(빈 칸은 ' ')
  w: number;      // 0 = 넓은 글자의 뒤 칸 · 1 · 2
  bg: boolean;    // 기본이 아닌 배경(또는 반전) — 앱 선택 색을 가려내는 데만 쓴다
  dim: boolean;   // 흐린 글자 — 빈 입력의 안내 글(placeholder)·자동완성 유령 글자. 사람이 친 글자가 아니다
}
export interface Screen { cols: number; rows: number; row(r: number): Cell[] | null }
/** 입력칸 — 가로줄(─) 두 줄 사이의 행들. start 는 글자가 시작하는 칸(프롬프트 «❯ » 다음). */
export interface Box { top: number; bottom: number; start: number }
/** 캐럿 자리(칸 사이) — col 은 0..cols. row 는 화면 행. */
export interface Pos { row: number; col: number }
export type Motion = 'left' | 'right' | 'up' | 'down' | 'lineStart' | 'lineEnd' | 'inputStart' | 'inputEnd' | 'wordLeft' | 'wordRight';

const isBlank = (c: Cell | undefined): boolean => !c || c.w === 0 || c.ch === ' ' || c.ch === ' ' || c.ch === '';

/** 가로줄 행인가 — 입력칸 위·아래 테두리. 글자는 ─ 뿐이고 충분히 길다(대화 속 짧은 ─ 장식과 가른다). */
export function isRule(cells: Cell[] | null, cols: number): boolean {
  if (!cells) return false;
  let n = 0;
  for (const c of cells) {
    if (c.ch === '─') { n++; continue; }
    if (isBlank(c)) continue;
    return false;
  }
  return n >= Math.min(20, Math.floor(cols / 2));
}

/**
 * 커서가 든 입력칸을 찾는다. 못 찾으면 null — 그러면 이 모듈은 아무것도 하지 않는다(종전 동작).
 *  조건 셋이 모두 맞아야 입력칸이다: ① 커서 행 위·아래로 가장 가까운 가로줄 두 줄 사이 ② 아래 가로줄 밑은 발치(footer)
 *  몇 줄뿐 — 화면 바닥에 붙은 상자다(대화 중간의 표·구분선을 입력칸으로 읽지 않게) ③ 첫 행이 «프롬프트 글자 + 빈칸» 으로
 *  시작한다(«❯ » · 모드마다 글자는 달라도 두 칸). 목록·대화상자가 떠서 커서가 그 안에 있으면 ②·③ 에서 떨어진다.
 */
export function findBox(s: Screen, caret: Pos, maxScan = 60, maxFooter = 6): Box | null {
  if (caret.row < 1 || caret.row >= s.rows - 1) return null;
  let up = -1, down = -1;
  for (let r = caret.row - 1; r >= 0 && r >= caret.row - maxScan; r--) if (isRule(s.row(r), s.cols)) { up = r; break; }
  for (let r = caret.row + 1; r < s.rows && r <= caret.row + maxScan; r++) if (isRule(s.row(r), s.cols)) { down = r; break; }
  if (up < 0 || down < 0) return null;
  if (s.rows - 1 - down > maxFooter) return null;
  const first = s.row(up + 1);
  if (!first || isBlank(first[0]) || !first[1] || !(first[1].ch === ' ' || first[1].ch === ' ')) return null;
  const start = 2;
  if (caret.col < start) return null;
  return { top: up + 1, bottom: down - 1, start };
}

/** 그 행 글자의 끝 캐럿 자리 — 흐린 글자(안내·유령)와 뒤쪽 빈칸은 글자가 아니다. 캐럿이 그 행에서 더 뒤면 캐럿까지. */
export function lineEnd(s: Screen, b: Box, r: number, caret?: Pos): number {
  const cells = s.row(r) || [];
  let end = b.start;
  for (let x = cells.length - 1; x >= b.start; x--) {
    const c = cells[x];
    if (isBlank(c) || c.dim) continue;
    end = x + Math.max(1, c.w);
    break;
  }
  if (caret && caret.row === r && caret.col > end) end = caret.col;
  return end;
}

/** col 이 넓은 글자의 뒤 칸이면 그 글자 앞으로 — 캐럿 자리는 늘 글자 경계다. */
export function snapCol(cells: Cell[], col: number, start: number, end: number): number {
  let x = Math.max(start, Math.min(col, end));
  while (x > start && cells[x] && cells[x].w === 0) x--;
  return x;
}
function nextCol(cells: Cell[], col: number, end: number): number {
  const c = cells[col];
  return Math.min(end, col + Math.max(1, c ? c.w : 1));
}
function prevCol(cells: Cell[], col: number, start: number): number {
  let x = col - 1;
  while (x > start && cells[x] && cells[x].w === 0) x--;
  return Math.max(start, x);
}

export function cmpPos(a: Pos, b: Pos): number { return a.row - b.row || a.col - b.col; }

/**
 * 캐럿을 한 걸음 옮긴다. goal 은 ↑/↓ 가 기억하는 «목표 열»(텍스트 편집기 관례 — 짧은 줄을 지나도 원래 열로 돌아온다).
 *  경계: 첫 줄에서 ↑ 는 입력 맨 앞, 마지막 줄에서 ↓ 는 입력 맨 끝(가로줄 밖으로 나가지 않는다).
 */
export function move(s: Screen, b: Box, p: Pos, m: Motion, goal: number | null, caret?: Pos): { pos: Pos; goal: number | null } {
  const cells = (r: number): Cell[] => s.row(r) || [];
  const end = (r: number): number => lineEnd(s, b, r, caret);
  const at = (row: number, col: number): Pos => ({ row, col });
  switch (m) {
    case 'right':
      if (p.col < end(p.row)) return { pos: at(p.row, nextCol(cells(p.row), p.col, end(p.row))), goal: null };
      return { pos: p.row < b.bottom ? at(p.row + 1, b.start) : p, goal: null };
    case 'left':
      if (p.col > b.start) return { pos: at(p.row, prevCol(cells(p.row), p.col, b.start)), goal: null };
      return { pos: p.row > b.top ? at(p.row - 1, end(p.row - 1)) : p, goal: null };
    case 'up': {
      const g = goal ?? p.col;
      if (p.row <= b.top) return { pos: at(b.top, b.start), goal: g };
      return { pos: at(p.row - 1, snapCol(cells(p.row - 1), g, b.start, end(p.row - 1))), goal: g };
    }
    case 'down': {
      const g = goal ?? p.col;
      if (p.row >= b.bottom) return { pos: at(b.bottom, end(b.bottom)), goal: g };
      return { pos: at(p.row + 1, snapCol(cells(p.row + 1), g, b.start, end(p.row + 1))), goal: g };
    }
    case 'lineStart': return { pos: at(p.row, b.start), goal: null };
    case 'lineEnd': return { pos: at(p.row, end(p.row)), goal: null };
    case 'inputStart': return { pos: at(b.top, b.start), goal: null };
    case 'inputEnd': return { pos: at(b.bottom, end(b.bottom)), goal: null };
    case 'wordLeft': {
      // 줄 맨 앞이면 윗줄 끝으로 한 걸음 — 그다음은 그 줄에서 다시 단어를 찾는다(편집기와 같다).
      if (p.col <= b.start) return move(s, b, p, 'left', null, caret);
      const c = cells(p.row);
      let x = p.col;
      while (x > b.start && isBlank(c[prevCol(c, x, b.start)])) x = prevCol(c, x, b.start);
      while (x > b.start && !isBlank(c[prevCol(c, x, b.start)])) x = prevCol(c, x, b.start);
      return { pos: at(p.row, x), goal: null };
    }
    case 'wordRight': {
      const e = end(p.row);
      if (p.col >= e) return move(s, b, p, 'right', null, caret);
      const c = cells(p.row);
      let x = p.col;
      while (x < e && isBlank(c[x])) x = nextCol(c, x, e);
      while (x < e && !isBlank(c[x])) x = nextCol(c, x, e);
      return { pos: at(p.row, x), goal: null };
    }
  }
  return { pos: p, goal };
}

/**
 * 캐럿 자리 두 개 → 앱에 선택시킬 칸 범위(양끝 포함). 길이 0 이면 null.
 *  첫 칸 = 앞 자리의 칸 그대로(그 글자부터 · 줄 끝 자리면 글자 뒤 빈칸 = «그 줄 끝부터»).
 *  끝 칸 = 뒤 자리의 **바로 앞 칸**. 앱은 [첫 칸, 끝 칸+1) 을 글자 위치로 바꿔 지우므로 이 한 규칙으로
 *   · 넓은 글자는 뒤 칸이 끝 칸 → 그 글자까지 포함 · 줄 처음 자리는 앞 칸이 들여쓰기 칸 → 줄바꿈까지만 포함(다음 줄 첫 글자는 안 지운다)
 *  가 저절로 맞는다(격리 tmux 실측: 줄 끝 빈칸 → 다음 줄 들여쓰기 칸 = 줄바꿈 하나만 지워졌다).
 */
export function rangeCells(a: Pos, f: Pos): { first: Pos; last: Pos } | null {
  const c = cmpPos(a, f);
  if (c === 0) return null;
  const s = c < 0 ? a : f, e = c < 0 ? f : a;
  return { first: { row: s.row, col: s.col }, last: { row: e.row, col: e.col - 1 } };
}

/** 칸 범위 → 캐럿 자리 두 개(rangeCells 의 역). 끝 칸이 넓은 글자의 앞 칸이면 그 글자 뒤까지. */
export function cellsToRange(s: Screen, first: Pos, last: Pos): { from: Pos; to: Pos } {
  const lc = (s.row(last.row) || [])[last.col];
  let endCol = last.col + 1;
  if (lc && lc.w === 2) endCol = last.col + 2;
  return { from: { row: first.row, col: first.col }, to: { row: last.row, col: endCol } };
}

/**
 * 클립보드에 넣을 글자. 앱 복사(화면 그대로)는 둘째 줄부터 들여쓰기 «  » 가 섞이고 자동 줄바꿈 자리의 띄어쓰기가
 *  «줄바꿈+들여쓰기» 로 바뀐다(격리 tmux 실측) — 붙여 넣으면 글이 달라진다. 그래서 여기서 만든다:
 *  줄 사이 이음새는 «윗줄 뒤에 아랫줄 첫 단어가 들어갈 자리가 있었나» 로 가른다. 자리가 있었는데 내려갔으면 사람이 친
 *  줄바꿈(\n) · 없었으면 자동 줄바꿈(띄어쓰기 하나) · 윗줄이 폭을 꽉 채우고 단어가 이어지면 긴 단어가 잘린 것(이음 없음).
 *  입력칸 글자 폭은 «화면 너비 − 3»(바이너리 `ts-iG`, iG=3).
 */
export function selText(s: Screen, b: Box, from: Pos, to: Pos, caret?: Pos): string {
  const width = s.cols - 3;
  const rowStr = (r: number, x0: number, x1: number): string => {
    const cells = s.row(r) || [];
    let out = '';
    for (let x = x0; x < x1; x++) { const c = cells[x]; if (!c || c.w === 0) continue; out += c.ch === ' ' ? ' ' : (c.ch || ' '); }
    return out;
  };
  const firstWordWidth = (r: number): number => {
    const cells = s.row(r) || [];
    const e = lineEnd(s, b, r, caret);
    let x = b.start, w = 0;
    while (x < e && !isBlank(cells[x])) { w += Math.max(1, cells[x].w); x += Math.max(1, cells[x].w); }
    return w;
  };
  let out = '';
  for (let r = from.row; r <= to.row; r++) {
    const e = lineEnd(s, b, r, caret);
    const x0 = r === from.row ? from.col : b.start;
    const x1 = r === to.row ? Math.min(to.col, e) : e;
    out += x1 > x0 ? rowStr(r, x0, x1) : '';
    if (r < to.row) {
      const used = e - b.start;
      const next = s.row(r + 1) || [];
      const lastCh = (s.row(r) || [])[e - 1];
      if (used >= width && !isBlank(lastCh) && !isBlank(next[b.start])) out += '';
      else if (used + 1 + firstWordWidth(r + 1) > width) out += ' ';
      else out += '\n';
    }
  }
  return out;
}

/** SGR 마우스 보고(1-기준). */
const sgr = (b: number, p: Pos, up: boolean): string => '\x1b[<' + b + ';' + (p.col + 1) + ';' + (p.row + 1) + (up ? 'm' : 'M');

/**
 * 앱에 «first~last 를 선택» 시키는 합성 끌기. press 쪽에서 누르고 반대쪽에서 뗀다(앱 선택은 방향과 무관 — 실측).
 *  한 칸짜리는 누른 자리에서 옆 칸으로 갔다가 돌아와 뗀다 — 제자리 누름·뗌은 «클릭»(캐럿 이동)이지 선택이 아니다(실측).
 */
export function dragSeq(first: Pos, last: Pos, press: 'first' | 'last', cols: number): string {
  if (first.row === last.row && first.col === last.col) {
    const side = { row: first.row, col: first.col + 1 < cols ? first.col + 1 : first.col - 1 };
    return sgr(0, first, false) + sgr(32, side, false) + sgr(32, first, false) + sgr(0, first, true);
  }
  const p = press === 'first' ? first : last, q = press === 'first' ? last : first;
  return sgr(0, p, false) + sgr(32, q, false) + sgr(0, q, true);
}
/** 그 칸 클릭 — 앱은 입력칸 클릭을 «그 글자 앞으로 캐럿»(글자 폭 인지)으로 받고, 떠 있던 선택을 거둔다. */
export function clickSeq(p: Pos): string { return sgr(0, p, false) + sgr(0, p, true); }

/** 앱의 더블클릭 판정(0.5초 안 · 행·열 모두 1칸 이내)에 걸리는가. 여유를 둔다(보낸 시각 ≠ 앱이 읽은 시각). */
export const MULTI_CLICK_MS = 600;
export function nearPress(last: { row: number; col: number; at: number } | null, p: Pos, now: number): boolean {
  if (!last) return false;
  return now - last.at < MULTI_CLICK_MS && Math.abs(last.row - p.row) <= 1 && Math.abs(last.col - p.col) <= 1;
}
/**
 * 합성 누름을 어디서·언제 할지. 두 끝 중 직전 누름에서 먼 쪽을 고르고, 둘 다 가까우면 그 판정 창이 지날 때까지 기다린다.
 *  반환 wait(ms) 만큼 기다린 뒤 press 쪽에서 누르면 더블클릭으로 읽히지 않는다.
 */
export function pressPlan(last: { row: number; col: number; at: number } | null, first: Pos, lastCell: Pos, now: number): { press: 'first' | 'last'; wait: number } {
  if (!nearPress(last, first, now)) return { press: 'first', wait: 0 };
  if (!(first.row === lastCell.row && first.col === lastCell.col) && !nearPress(last, lastCell, now)) return { press: 'last', wait: 0 };
  return { press: 'first', wait: Math.max(0, MULTI_CLICK_MS - (now - (last as { at: number }).at)) };
}

/**
 * 앱이 정확히 first~last 를 칠했나 — 그 범위의 칸은 **빈칸까지 전부** 선택 색이고, 바로 앞 칸·바로 뒤 칸은 아니다.
 *  앱은 선택 안의 빈칸(줄 끝 뒤 공백·다음 줄 들여쓰기)도 칠한다(격리 tmux 실측, capture-pane -N -e) — 그래서
 *  줄바꿈만 고른 선택(글자 칸이 하나도 없다)도 이 한 규칙으로 가려진다. 한 칸이라도 어긋나면 false = 지우지 않는다.
 */
export function highlightMatches(s: Screen, b: Box, first: Pos, last: Pos): boolean {
  let seen = 0;
  for (let r = b.top; r <= b.bottom; r++) {
    const cells = s.row(r) || [];
    for (let x = 0; x < cells.length; x++) {
      const p = { row: r, col: x };
      const lit = !!(cells[x] && cells[x].bg);
      if (cmpPos(p, first) >= 0 && cmpPos(p, last) <= 0) { if (!lit) return false; seen++; }
      else if (lit) return false;   // 범위 밖이 칠해져 있다 — 앱의 선택이 우리 것과 다르다
    }
  }
  return seen > 0;
}

/**
 * 앱이 입력칸 안에 칠해 둔 선택(마우스 끌기·더블클릭)을 읽는다 — ⌘X·Shift+화살표가 그 선택을 이어받는다.
 *  입력칸 테두리 가로줄까지 칠해져 있으면 선택이 입력칸 밖(대화)에서 이어진 것 → null(자를 수 없다).
 *  칠해진 칸이 중간에 끊겨 있으면(두 덩이) 선택이 아닌 무언가다 → null. 빈칸도 칠해지므로(highlightMatches 머리말) 끊김은 곧 이상이다.
 */
export function scanHighlight(s: Screen, b: Box): { first: Pos; last: Pos } | null {
  const ruleLit = (r: number): boolean => (s.row(r) || []).some((c) => c && c.bg);
  if (ruleLit(b.top - 1) || ruleLit(b.bottom + 1)) return null;
  let first: Pos | null = null, last: Pos | null = null, gap = false;
  for (let r = b.top; r <= b.bottom; r++) {
    const cells = s.row(r) || [];
    for (let x = 0; x < cells.length; x++) {
      const c = cells[x];
      if (c && c.bg) {
        if (gap) return null;
        if (!first) first = { row: r, col: x };
        last = { row: r, col: x + (c.w === 2 ? 1 : 0) };
      } else if (first) gap = true;
    }
  }
  return first && last ? { first, last } : null;
}

// ── 키 판정 ─────────────────────────────────────────────────────────────────────
//  맥은 ⌘ 계열, 그 밖은 Ctrl 계열(텍스트 편집기 관례). #3778 의 교훈 그대로 — **선택을 거둘 키만 열거**하고
//  모르는 키는 선택을 건드리지 않는다(Shift·⌘ 를 누르는 것 자체가 keydown 이다).
export interface KeyLike { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; isComposing?: boolean; keyCode?: number }
export type AppSelAct =
  | { k: 'pass' }                                   // 손대지 않는다
  | { k: 'extend'; m: Motion }                      // 선택을 넓히거나 줄인다(없으면 캐럿에서 시작)
  | { k: 'caret'; m: 'inputStart' | 'inputEnd' }    // 캐럿을 입력 처음/끝으로(합성 클릭)
  | { k: 'collapse'; to: 'start' | 'end' }          // 선택 앞/뒤로 캐럿을 두고 선택을 거둔다
  | { k: 'del' } | { k: 'cut' } | { k: 'copy' }
  | { k: 'replace' }                                // 선택을 지우고 그 키(글자)는 흘린다
  | { k: 'selectInput' } | { k: 'selectTerminal' }
  | { k: 'clear' };                                 // 선택만 거두고 키는 흘린다
const isPrintable = (k: string): boolean => Array.from(k).length === 1;
const ARROWS: Record<string, Motion> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const CLEARS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Enter', 'Tab']);

export function decideAppSelKey(e: KeyLike, c: { mac: boolean; hasSel: boolean }): AppSelAct {
  const shift = !!e.shiftKey, ctrl = !!e.ctrlKey, alt = !!e.altKey, meta = !!e.metaKey, key = e.key || '';
  const primary = c.mac ? meta && !ctrl : ctrl && !meta;
  // ── 선택 넓히기 ──
  if (shift && !alt && !ctrl && !meta && ARROWS[key]) return { k: 'extend', m: ARROWS[key] };
  if (shift && !alt && !ctrl && !meta && (key === 'Home' || key === 'End')) return { k: 'extend', m: key === 'Home' ? 'lineStart' : 'lineEnd' };
  if (c.mac && shift && meta && !alt && !ctrl) {
    if (key === 'ArrowLeft') return { k: 'extend', m: 'lineStart' };
    if (key === 'ArrowRight') return { k: 'extend', m: 'lineEnd' };
    if (key === 'ArrowUp' || key === 'Home') return { k: 'extend', m: 'inputStart' };
    if (key === 'ArrowDown' || key === 'End') return { k: 'extend', m: 'inputEnd' };
  }
  if (c.mac && shift && alt && !meta && !ctrl && (key === 'ArrowLeft' || key === 'ArrowRight')) return { k: 'extend', m: key === 'ArrowLeft' ? 'wordLeft' : 'wordRight' };
  if (!c.mac && shift && ctrl && !alt && !meta) {
    if (key === 'ArrowLeft') return { k: 'extend', m: 'wordLeft' };
    if (key === 'ArrowRight') return { k: 'extend', m: 'wordRight' };
    if (key === 'Home') return { k: 'extend', m: 'inputStart' };
    if (key === 'End') return { k: 'extend', m: 'inputEnd' };
  }
  // ── 입력 처음/끝으로(여러 줄 입력의 ⌘↑/⌘↓ — 종전 #3778 은 그 줄 처음/끝(Ctrl+A/E)뿐이었다) ──
  //  맥만이다: ⌘ 는 xterm 이 앱에 안 보내 원래 앱 기능이 없는 키다. Windows 의 Ctrl+Home/End 는 Claude Code 가
  //  «대화 맨 위/아래로 스크롤»(scroll:top/bottom)로 쓰는 키라 뺏지 않는다(2.1.283 바이너리 키 표).
  if (c.mac && !shift && !alt && meta && !ctrl) {
    if (key === 'ArrowUp') return { k: 'caret', m: 'inputStart' };
    if (key === 'ArrowDown') return { k: 'caret', m: 'inputEnd' };
  }
  const lower = key.toLowerCase();
  if (primary && !alt && !shift && (lower === 'a' || e.keyCode === 65)) return c.hasSel ? { k: 'selectTerminal' } : { k: 'selectInput' };
  // 잘라내기는 선택이 없어도 판정한다 — 앱이 칠해 둔 마우스 선택을 이어받을 수 있다(없으면 쓰는 쪽이 흘린다).
  if (primary && !alt && !shift && (lower === 'x' || e.keyCode === 88)) return { k: 'cut' };
  if (!c.hasSel) return { k: 'pass' };
  // ── 선택이 선 상태 ──
  if (primary && !alt && !shift && (lower === 'c' || e.keyCode === 67)) return { k: 'copy' };
  if (e.isComposing) return { k: 'clear' };  // 조합 도중엔 지우지 않는다(음절이 깨진다 — #1117·#1300 계열)
  if (!ctrl && !meta && !alt && (key === 'Backspace' || key === 'Delete')) return { k: 'del' };
  if (!ctrl && !meta && !alt && (e.keyCode === 229 || isPrintable(key))) return { k: 'replace' };
  if (!shift && !ctrl && !meta && !alt && (key === 'ArrowLeft' || key === 'ArrowRight')) return { k: 'collapse', to: key === 'ArrowLeft' ? 'start' : 'end' };
  if (CLEARS.has(key) && !shift) return { k: 'clear' };
  if ((ctrl || meta) && (isPrintable(key) || key.startsWith('Arrow') || key === 'Backspace' || key === 'Delete')) return { k: 'clear' };
  return { k: 'pass' };
}

/** 글자를 넣는 키인가 — 선택 위에 치면 선택을 갈아치운다(편집기 관례). 조합 중(IME)은 아니다(음절이 깨진다), 조합 시작(229)은 맞다. */
export function isTypingKey(e: KeyLike): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
  return e.keyCode === 229 || isPrintable(e.key || '');
}

/** 이 기능이 기대는 앱 판 — 입력칸 선택 삭제(tryDelete)를 실측한 판. 판을 알 때(네이티브 설치 = 실행 파일 이름이 판)만 거른다. */
export const APP_SELECT_MIN = [2, 1, 283];
export function versionAtLeast(v: string, min: number[]): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || ''));
  if (!m) return false;
  for (let i = 0; i < 3; i++) { const d = Number(m[i + 1]) - min[i]; if (d !== 0) return d > 0; }
  return true;
}

/** 입력칸 글자의 지문 — 선택을 세운 뒤 앱이 입력칸을 다시 그렸으면(글자가 바뀌었으면) 낡은 좌표로 지우지 않는다. */
export function boxFingerprint(s: Screen, b: Box): string {
  const rows: string[] = [];
  for (let r = b.top; r <= b.bottom; r++) {
    const cells = s.row(r) || [];
    let t = '';
    for (const c of cells) { if (c.w === 0) continue; t += c.dim ? ' ' : c.ch; }
    rows.push(t.replace(/\s+$/, ''));
  }
  return rows.join('\n');
}
