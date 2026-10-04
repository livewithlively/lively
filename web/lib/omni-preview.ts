// lib/omni-preview.ts — 통합검색 미리보기 칸의 순수 규칙(#4530 안 A, 원준 2026-10-04).
//
//  원준: «지식, 세션, 프로젝트 뭐든 내부 안까지 어떻게 보여줘야 사용자에게 가장 만족스럽게 보여줄지 다 구현해».
//  목록 한 줄로는 «이게 내가 찾던 것인가» 를 못 가린다 — 열어 봐야 알았고, 열면 검색 창이 닫혀 다시 찾아야 했다.
//  미리보기 칸은 고른 결과의 **안**을 보여 준다. 여기는 그 재료를 뽑는 규칙(DOM 없음 — 시험이 그대로 잰다):
//   · 본문(마크다운)에서 낱말이 든 줄과 그 줄이 속한 제목 · 앞뒤 한 줄 (excerptBlocks)
//   · 낱말이 본문에 없을 때 보여 줄 앞부분 (leadLines) · 목차 (outline)
//   · 태스크 묶음의 진행 (taskSummary) · 상태 말 (statusText)
import { cleanSnippet, stripEmphasis } from './omni-rank.js';

export interface ExcerptLine { text: string; hit: boolean }
export interface ExcerptBlock { heading: string; lines: ExcerptLine[] }

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*\S)\s*$/;
const FENCE_RE = /^\s{0,3}(```|~~~)/;
//  표의 구분 줄(|---|:--:|) · 가로줄 · HTML 주석 · 자동 생성 안내문 — 읽을 글이 아니다.
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const RULE_RE = /^\s{0,3}([-*_])\s*(\1\s*){2,}$/;
const COMMENT_RE = /^\s*<!--[\s\S]*-->\s*$/;
const AUTO_RE = /(세션의 첫 지시에서\s*\**자동 생성\**된 프로젝트입니다|이름을 지으면서\s*\**자동으로 만든\**\s*태스크입니다|세션이 요청받은 일을 끝내면 «완료»로 바뀝니다)/;
const AUTO_HEAD_RE = /^첫 지시\(원문\)$/;
//  인용(>) 머리표 — 인용 안의 표·제목·글도 읽을 글이다. 떼지 않으면 «> | 1 | … |» · «> |---|» 가 날것으로 보였다(실화면).
const QUOTE_RE = /^\s{0,3}(?:>\s?)+/;

/** 줄 안의 마크다운 표시만 걷는다(굵게·코드·링크). 제목에 쓴다 — 제목의 «1. » 은 번호 목록이 아니라 절 번호라 남긴다. */
export function cleanInline(raw: string, max = 2000): string {
  const s = stripEmphasis(String(raw ?? '')).replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
}

/** 읽을 글이 아닌 줄인가(빈 줄 · 구분 줄 · 주석 · 자동 안내문). */
export function isNoiseLine(raw: string): boolean {
  const s = String(raw ?? '').replace(QUOTE_RE, '');
  if (!s.trim()) return true;
  return TABLE_SEP_RE.test(s) || RULE_RE.test(s) || COMMENT_RE.test(s) || AUTO_RE.test(s);
}
/** 한 줄을 화면 글로 — 표의 칸막이(|)는 가운뎃점으로, 마크다운 기호는 걷는다. */
export function cleanLine(raw: string, max = 240): string {
  let s = String(raw ?? '');
  if (/^\s*\|.*\|\s*$/.test(s)) s = s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()).filter(Boolean).join(' · ');
  s = s.replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+\[[ xX]\]\s+/, '');   // 체크 목록 머리
  return cleanSnippet(s, max);
}

interface Line { i: number; text: string; raw: string; heading: string }
/** 본문을 «읽을 줄» 로 편다 — 코드 블록 안은 한 줄씩 그대로(기호를 걷지 않는다), 제목 줄은 그 아래 줄들의 머리가 된다. */
function readable(body: string, lineMax: number): { lines: Line[]; heads: Array<{ level: number; text: string }> } {
  const lines: Line[] = [];
  const heads: Array<{ level: number; text: string }> = [];
  let heading = '';
  let fence = false;
  let fenceQuoted = false;   // 인용 안에서 열린 코드 블록인가(그 안의 줄도 머리표를 뗀다)
  const src = String(body ?? '').split('\n');
  for (let i = 0; i < src.length; i++) {
    const unq = src[i].replace(QUOTE_RE, '');
    const raw = fence && !fenceQuoted ? src[i] : unq;
    if (FENCE_RE.test(raw)) { fence = !fence; fenceQuoted = fence && unq !== src[i]; continue; }
    if (fence) { const t = raw.replace(/\s+/g, ' ').trim(); if (t) lines.push({ i, raw, text: t.length > lineMax ? t.slice(0, lineMax) + '…' : t, heading }); continue; }
    const h = HEADING_RE.exec(raw);
    if (h) {
      const t = cleanInline(h[2], 120);
      if (t && !AUTO_HEAD_RE.test(t)) { heads.push({ level: h[1].length, text: t }); heading = t; }
      else heading = '';
      continue;
    }
    if (isNoiseLine(raw)) continue;
    const text = cleanLine(raw, lineMax);
    if (text) lines.push({ i, raw, text, heading });
  }
  return { lines, heads };
}

const countWords = (text: string, words: string[]): number => {
  const low = text.toLowerCase();
  let n = 0;
  for (const w of words) if (w && low.includes(w.toLowerCase())) n++;
  return n;
};

/**
 * 본문에서 낱말이 든 줄을 고른다 — 낱말이 많이 든 줄부터 max 개, 화면에는 문서 순서로. 줄마다 앞뒤 ctx 줄과 그 줄이 속한 제목.
 *  가까운 줄들은 한 덩이로 합친다(같은 줄을 두 번 보이지 않는다). total = 낱말이 든 줄의 수.
 */
export function excerptBlocks(body: string, words: string[], opts: { max?: number; ctx?: number; lineMax?: number } = {}): { blocks: ExcerptBlock[]; total: number } {
  const max = opts.max ?? 3, ctx = opts.ctx ?? 1, lineMax = opts.lineMax ?? 220;
  const ws = words.filter(Boolean);
  if (!ws.length) return { blocks: [], total: 0 };
  const { lines } = readable(body, lineMax);
  const scored = lines.map((l, idx) => ({ idx, n: countWords(l.text, ws) })).filter((x) => x.n > 0);
  if (!scored.length) return { blocks: [], total: 0 };
  const picked = [...scored].sort((a, b) => b.n - a.n || a.idx - b.idx).slice(0, max).map((x) => x.idx).sort((a, b) => a - b);
  const hitSet = new Set(scored.map((x) => x.idx));
  const blocks: ExcerptBlock[] = [];
  let lastEnd = -1;
  for (const idx of picked) {
    const from = Math.max(0, idx - ctx), to = Math.min(lines.length - 1, idx + ctx);
    const start = Math.max(from, lastEnd + 1);
    if (start > to) continue;
    const span: ExcerptLine[] = [];
    for (let k = start; k <= to; k++) {
      //  이웃 줄은 같은 제목 아래의 것만 — 다른 절의 줄을 붙이면 엉뚱한 글이 이어 보인다.
      if (k !== idx && lines[k].heading !== lines[idx].heading) continue;
      span.push({ text: lines[k].text, hit: hitSet.has(k) });
    }
    const prev = blocks[blocks.length - 1];
    if (prev && start === lastEnd + 1 && prev.heading === lines[idx].heading) prev.lines.push(...span);
    else blocks.push({ heading: lines[idx].heading, lines: span });
    lastEnd = to;
  }
  return { blocks, total: scored.length };
}

/** 본문 앞부분 n 줄(읽을 줄만) — 낱말이 본문에 없을 때(제목으로만 맞았을 때) 무슨 글인지 보인다. */
export function leadLines(body: string, n = 5, lineMax = 220): string[] {
  return readable(body, lineMax).lines.slice(0, n).map((l) => l.text);
}

/** 목차 — 제목 줄(가장 얕은 두 층만). 문서가 무엇을 다루는지 한눈에. */
export function outline(body: string, max = 8): Array<{ level: number; text: string }> {
  const { heads } = readable(body, 120);
  if (!heads.length) return [];
  const top = Math.min(...heads.map((h) => h.level));
  return heads.filter((h) => h.level <= top + 1).slice(0, max).map((h) => ({ level: h.level - top, text: h.text }));
}

export interface TaskLike { name?: string | null; status?: string | null; status_category?: string | null }
/** 태스크 묶음의 진행 — 끝남 · 하는 중 · 할 일(취소는 전체에서 뺀다). */
export function taskSummary(tasks: TaskLike[]): { total: number; done: number; doing: number; todo: number } {
  let done = 0, doing = 0, todo = 0;
  for (const t of tasks || []) {
    const c = String(t.status_category || '');
    if (c === 'canceled') continue;
    if (c === 'done') done++; else if (c === 'started') doing++; else todo++;
  }
  return { total: done + doing + todo, done, doing, todo };
}
/** 상태를 사람 말로 — 보관·초안이 상태보다 먼저다(그 사실이 더 중요하다). */
export function statusText(p: { status_category?: string | null; archived_at?: unknown; archived?: unknown; draft?: unknown; trashed_at?: unknown }): { text: string; tone: 'done' | 'doing' | 'todo' | 'off' } {
  if (p.archived_at || p.archived) return { text: '보관', tone: 'off' };
  if (p.draft) return { text: '초안', tone: 'off' };
  const c = String(p.status_category || '');
  if (c === 'done') return { text: '완료', tone: 'done' };
  if (c === 'canceled') return { text: '취소', tone: 'off' };
  if (c === 'started') return { text: '진행 중', tone: 'doing' };
  return { text: '할 일', tone: 'todo' };
}

/** 태스크를 미리보기에 세울 순서 — 낱말이 이름에 든 것 → 하는 중 → 할 일 → 끝남. */
export function orderTasks<T extends TaskLike>(tasks: T[], words: string[]): T[] {
  const rank = (t: T): number => {
    if (words.length && countWords(String(t.name || ''), words) > 0) return 0;
    const c = String(t.status_category || '');
    return c === 'started' ? 1 : c === 'done' ? 3 : c === 'canceled' ? 4 : 2;
  };
  return tasks.map((t, i) => ({ t, i, r: rank(t) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.t);
}
