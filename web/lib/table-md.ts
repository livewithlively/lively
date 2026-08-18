// lib/table-md.ts — 마크다운 표 ↔ 셀 모델(순수 · 의존 0).
//  두 소비자가 **같은 규칙**을 봐야 해서 여기 하나로 모았다(#1685):
//   · lib/markdown.ts 의 렌더러 — 표를 <table> 로 그린다.
//   · editor/table.ts 의 표 즉시 편집 — 셀을 고쳐 다시 마크다운으로 되돌린다.
//  복제하면 `\|` 이스케이프 처리가 갈라져 셀이 어긋나므로 분리 금지. DOM·네트워크를 전혀 모르는 순수 모듈이라
//  node 테스트(scripts/editor-table-md.test.mjs)가 직접 import 한다.

export type TableAlign = '' | 'l' | 'c' | 'r';
export interface TableModel {
  head: string[];        // 헤더 행(셀 마크다운). 전부 빈 문자열이면 '헤더 없는 표'(#551 노션 미러)
  align: TableAlign[];
  rows: string[][];      // 본문 행 × 열(셀 마크다운)
}

// 표 후보: | 로 시작/구분되는 2줄 이상 + 두번째 줄이 구분행(---|---).
export const isMdTableSep = (l: any): boolean =>
  /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(String(l)) && String(l).indexOf('-') >= 0;

export function mdTableSplitRow(l: any): string[] {
  let t = String(l).trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  // 이스케이프 파이프(\|) 인지 분리 — 노션 셀의 리터럴 '|' 보존(#551).
  const cells: string[] = [];
  let cur = '';
  for (let j = 0; j < t.length; j++) {
    const ch = t[j];
    if (ch === '\\' && t[j + 1] === '|') { cur += '|'; j++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// 구분행 셀(`:---:`) → 정렬.
export function alignOf(cell: string): TableAlign {
  const t = String(cell).trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'c';
  if (right) return 'r';
  if (left) return 'l';
  return '';
}
export function alignBar(a: TableAlign): string {
  if (a === 'c') return ':---:';
  if (a === 'r') return '---:';
  if (a === 'l') return ':---';
  return '---';
}

// 마크다운 → 모델. '표 하나로만 이루어진 덩어리' 일 때만 성립하고, 아니면 null(= 원문 편집으로 폴백).
export function parseTableMd(md: string): TableModel | null {
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  let s = 0, e = lines.length - 1;
  while (s <= e && lines[s].trim() === '') s++;
  while (e >= s && lines[e].trim() === '') e--;
  const body = lines.slice(s, e + 1);
  if (body.length < 2) return null;
  if (body[0].indexOf('|') < 0 || !isMdTableSep(body[1])) return null;
  // 표 뒤에 다른 내용이 붙어 있으면 손대지 않는다(원문 편집이 안전).
  for (let i = 2; i < body.length; i++) if (body[i].indexOf('|') < 0) return null;

  const head = mdTableSplitRow(body[0]);
  const align = mdTableSplitRow(body[1]).map(alignOf);
  const rows = body.slice(2).map((l) => mdTableSplitRow(l));
  const cols = Math.max(head.length, ...rows.map((r) => r.length), 1);
  const fit = (r: string[]) => Array.from({ length: cols }, (_, i) => (r[i] == null ? '' : r[i]));
  return {
    head: fit(head),
    align: Array.from({ length: cols }, (_, i) => align[i] || ''),
    rows: rows.map(fit),
  };
}

// 모델 → 마크다운. 셀 안의 '|' 는 \| 로(mdTableSplitRow 의 역), 개행은 표에 담을 수 없어 공백으로 접는다.
export function tableToMd(t: TableModel): string {
  const cell = (s: string) => String(s == null ? '' : s).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  const row = (r: string[]) => '| ' + r.map(cell).map((c) => c || ' ').join(' | ') + ' |';
  const out = [row(t.head), '| ' + t.align.map(alignBar).join(' | ') + ' |'];
  for (const r of t.rows) out.push(row(r));
  return out.join('\n');
}

export function isTableMd(md: string): boolean { return !!parseTableMd(md); }
