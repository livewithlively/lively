// lib/omni-rank.ts — 통합검색(⌘K)의 순수 규칙(#4530, 원준 2026-10-01). DOM 무접촉이라 시험이 그대로 부른다.
//  원준: «관련도가 적당히 있는 걸 시간순으로 보여 줘야지. 지금 완전 관련도만 갖고 보여 주니까 문제 좀 있는 듯. 슬랙도 좀 참고하고.»
//
//  ── 순서(슬랙 Recent + Top Results) ──
//   ① 맨 위 «가장 맞는 결과» 최대 셋 — 번호·key 로 부른 것 > 이름이 검색어와 같은 것 > 이름에 낱말이 모두 든 것 >
//      서버가 «가장 맞는 대화» 로 표시한 세션 > key 의 일부를 친 것.
//   ② 그 아래 **낱말이 모두 글자로 맞은 것**(관련도의 문턱)을 최근 것부터, 날짜 묶음으로.
//   ③ 뜻만 비슷한 지식은 섞지 않는다 — 맨 아래 «뜻이 비슷한 지식» 묶음에만(점검 실측: 뜻 점수 0.48 문턱이 무관한 것을
//      0.49~0.66 으로 통과시켜 관련도순 10줄 중 8~9줄을 채웠다).
//
//  ── 낱말 ──
//   서버 src/v6/query-terms.ts 와 같은 규칙의 화면 사본이다(웹 묶음은 서버 소스를 들이지 않는다). 둘이 어긋나면 «화면은 맞다는데
//   서버는 안 맞다» 가 생긴다 — 바꿀 때는 둘을 함께 바꾼다(시험 scripts/omni-rank.test.mjs 가 같은 표로 둘을 잰다).

export const KO_JOSA: readonly string[] = [
  '으로부터', '에서부터', '에서는', '에서도', '에게서', '이라고', '라고는', '이라는', '으로는', '으로도',
  '에서', '으로', '까지', '부터', '에게', '한테', '처럼', '보다', '이랑', '하고', '이나', '이며', '이고', '에는', '에도', '라는', '라고',
  '은', '는', '이', '가', '을', '를', '에', '의', '로', '와', '과', '도', '만', '랑', '나', '요',
];
export function stemKo(word: string): string {
  const w = String(word || '');
  if (!/[가-힣]$/.test(w)) return w;
  for (const j of KO_JOSA) if (w.length >= j.length + 2 && w.endsWith(j)) return w.slice(0, -j.length);
  return w;
}
export interface Term { t: string; stem: string; quoted: boolean }
export function parseTerms(q: string, max = 8): Term[] {
  const out: Term[] = [];
  const s = String(q ?? '').toLowerCase();
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) && out.length < max) {
    const quoted = m[1] !== undefined;
    const t = (quoted ? m[1] : m[2]).trim().replace(/\s+/g, ' ');
    if (!t || out.some((x) => x.t === t)) continue;
    out.push({ t, stem: quoted ? t : stemKo(t), quoted });
  }
  return out;
}
/** 1 = 친 그대로 · 0.8 = 조사 뗀 꼴만 · 0 = 없음. */
export function termStrength(textLower: string, term: Term): number {
  if (!term.t) return 0;
  if (textLower.includes(term.t)) return 1;
  if (term.stem !== term.t && term.stem.length >= 2 && textLower.includes(term.stem)) return 0.8;
  return 0;
}
/** 모든 낱말이 (그대로 또는 조사 뗀 꼴로) 들어 있나. 낱말이 없으면 false. */
export function matchAll(text: string, terms: Term[]): boolean {
  if (!terms.length) return false;
  const low = String(text || '').toLowerCase();
  return terms.every((t) => termStrength(low, t) > 0);
}
/** 여러 자리 중 어디에든 낱말마다 있으면 true(세션 이름·하는 일·프로젝트 이름처럼 나뉜 자리). */
export function matchAllAcross(texts: Array<string | null | undefined>, terms: Term[]): boolean {
  if (!terms.length) return false;
  const lows = texts.map((x) => String(x || '').toLowerCase());
  return terms.every((t) => lows.some((l) => termStrength(l, t) > 0));
}
/** 색칠할 낱말 — 친 그대로와 조사 뗀 꼴. 한 글자 낱말은 색칠하지 않는다(«창» 이 «대화창» 속에서 칠해지는 잡음). */
export function highlightWords(terms: Term[]): string[] {
  const out: string[] = [];
  for (const t of terms) {
    for (const w of [t.t, t.stem]) if (w && [...w].length >= 2 && !out.includes(w)) out.push(w);
  }
  return out.sort((a, b) => b.length - a.length);
}

// ── 지식 제목의 머리말 ─────────────────────────────────────────────────────────────
//  지식 제목 1,692개 중 38%가 «as-built(#4135, 2026-09-28): …» · «원인규명·수정(#3891, …): …» 처럼 머리말로 시작하고 87%가 60자를
//  넘는다(2026-10-01 실측). 한 줄에 다 안 들어가 머리말만 보이고 정작 무엇인지가 잘렸다. 머리말은 따로 떼어 작게 보인다.
const TITLE_HEAD_RE = /^\s*([⚠★✅❌☆]*\s*[^\s:：()（）]{1,24}(?:\s*\([^)]{0,80}\))?)\s*[:：]\s+(\S[\s\S]*)$/u;
export function splitKnowTitle(title: string): { head: string; main: string } {
  const s = String(title || '').trim();
  const m = TITLE_HEAD_RE.exec(s);
  if (!m) return { head: '', main: s };
  const main = m[2].trim();
  if (main.length < 4) return { head: '', main: s };   // 남는 것이 너무 짧으면 떼지 않는다(«결정: 예» 같은 것)
  //  머리말은 «as-built · #4135» 처럼 줄인다 — 날짜·PR 번호는 줄 오른쪽 시각과 겹친다.
  const raw = m[1].replace(/[⚠★✅❌☆]/gu, '').trim();
  const label = raw.replace(/\(.*$/, '').trim();
  const num = (raw.match(/#\d+/) || [])[0] || '';
  return { head: [label, num].filter(Boolean).join(' · '), main };
}

// ── 둘째 줄 글 다듬기 ─────────────────────────────────────────────────────────────
//  서버 발췌문·프로젝트 설명은 마크다운 원문이다. 목록 한 줄엔 기호(#, >, **, `, ▤)와 자동 안내문이 그대로 보였다(점검 실측).
const AUTO_DESC_RE = /^\s*(?:>\s*)?(?:[⚙▤]\s*)*세션의 첫 지시에서\s*\**자동 생성\**된 프로젝트입니다[^\n]*\n?/m;
export function cleanSnippet(raw: string, max = 160): string {
  let s = String(raw || '');
  s = s.replace(AUTO_DESC_RE, ' ');
  s = s.replace(/^#{1,6}\s*첫 지시\(원문\)\s*$/gm, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/\(\+\d+ matches?\)\s*→\s*\S+/g, ' ');          // 에이전트용 안내(«(+3 matches) → knowledge_get»)
  s = s.replace(/^L\d+:\s?/gm, ' ');                             // grep 줄 번호
  s = s.replace(/^\s{0,3}(?:#{1,6}|>+|[-*+]|\d+\.)\s+/gm, '');    // 줄머리 기호
  s = s.replace(/[▤⚙]/g, ' ');
  s = s.replace(/\*\*|__|`+/g, '');                               // 굵게·코드 표시
  s = s.replace(/\[\[([^\]]+)\]\]/g, '$1');                       // 위키 링크
  s = s.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1');              // 마크다운 링크
  s = s.replace(/\s*⋯\s*/g, ' … ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
}

// ── 식별자(번호·key) ─────────────────────────────────────────────────────────────
//  번호는 정확일치만(«183» 이 1835 를 잡으면 안 된다). key 의 일부를 친 것은 **key 같은 말**일 때만 호명으로 본다 —
//  «session» 처럼 평범한 낱말까지 호명으로 치면 key 에 그 낱말이 든 지식 전부가 맨 위를 차지한다(점검 실측: 10줄 전부).
export type IdentKind = 'exact' | 'partial' | null;
export function identKind(ident: string | undefined, terms: Term[]): IdentKind {
  if (!ident || terms.length !== 1) return null;
  const q = terms[0].t.replace(/^#/, '');
  if (!q) return null;
  const id = ident.toLowerCase();
  if (id === q) return 'exact';
  if (/^[0-9]+$/.test(id)) return null;
  if (!/[-_]/.test(q) && q.length < 12) return null;   // key 같은 말(하이픈·밑줄이 있거나 긴 것)만
  return id.includes(q) ? 'partial' : null;
}

// ── 맨 위 «가장 맞는 결과» ─────────────────────────────────────────────────────────
export interface RankHit {
  key: string;
  kind: string;
  /** 비교에 쓰는 이름(지식은 머리말을 뗀 제목). */
  name: string;
  ident?: string;
  at?: number;
  /** 서버가 «가장 맞는 대화» 로 표시했나(대화 결과). */
  serverTop?: boolean;
  /** 서버가 매긴 순서(작을수록 앞) — 같은 층 안에서 쓴다. */
  order?: number;
}
/** 층(작을수록 앞). null = 맨 위 후보가 아니다. */
export function topTier(h: RankHit, terms: Term[], qNorm: string): number | null {
  const id = identKind(h.ident, terms);
  if (id === 'exact') return 0;
  const name = String(h.name || '').trim().toLowerCase();
  if (name && name === qNorm) return 1;
  if (name && matchAll(name, terms)) return 2;
  if (h.serverTop) return 3;
  if (id === 'partial') return 4;
  return null;
}
/** 이름에 질의가 놓인 자리 + 이름 길이 — 작을수록 «그 이름다운» 것. */
export function titleRank(name: string, terms: Term[]): number {
  const t = String(name || '').toLowerCase();
  const first = terms[0];
  let at = first ? t.indexOf(first.t) : -1;
  if (at < 0 && first) at = t.indexOf(first.stem);
  return (at < 0 ? 999 : at) * 10 + Math.min(99, [...t].length);
}
export const TOP_MAX = 3;
export function pickTop<T extends RankHit>(hits: T[], terms: Term[], qRaw: string, max = TOP_MAX): T[] {
  const qNorm = String(qRaw || '').trim().toLowerCase().replace(/^#/, '');
  const cands: Array<{ h: T; tier: number }> = [];
  for (const h of hits) { const tier = topTier(h, terms, qNorm); if (tier !== null) cands.push({ h, tier }); }
  cands.sort((a, b) => a.tier - b.tier
    || (a.tier === 2 ? titleRank(a.h.name, terms) - titleRank(b.h.name, terms) : 0)
    || (a.h.order ?? 0) - (b.h.order ?? 0)
    || (b.h.at ?? -Infinity) - (a.h.at ?? -Infinity));
  return cands.slice(0, max).map((x) => x.h);
}
