// guide/search.ts. 사용 가이드 안에서 찾기(#4179). 원고(docs-content.ts)를 글자로 풀어 문서와 절 단위로 찾는다.
//  서버를 부르지 않는다. 원고가 번들에 들어 있으므로 브라우저에서 바로 찾는다.
//  잣대: 검색어를 공백으로 나눈 낱말이 전부 들어 있어야 맞는다(대소문자 구분 없음). 제목 > 찾는 말(keys) > 절 제목 > 본문 순으로 앞에 선다.
import { DOC_PAGES, type DocPage } from '../docs-content.js';
import { splitGuideSections } from './render.js';

export interface GuideHit { slug: string; page: string; sec: string; secId: string; snippet: string; score: number }

interface SecIdx { id: string; title: string; text: string }
interface PageIdx { page: DocPage; head: string; secs: SecIdx[] }

let index: PageIdx[] | null = null;

/** 원고의 표기(칩 · 상자 · 도식 자리 · 표 구분선)를 걷어 읽는 글자만 남긴다. */
export function plainOf(md: string): string {
  return String(md || '')
    .replace(/^\{\{fig:[a-z0-9-]+\}\}\s*$/gim, ' ')
    .replace(/\{\{ic:[a-z0-9-]+\}\}/gi, ' ')
    .replace(/^:::\s*shot[^\n]*$/gim, ' ')
    .replace(/^[\d.]+\s*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|/gm, ' ')
    .replace(/^:::\s*[a-zA-Z_-]*\s*/gm, ' ')
    .replace(/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/gm, ' ')
    .replace(/\]\((?:#|https?:)[^)\s]*\)/g, ' ')
    .replace(/[#*`|[\]「」>~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function build(): PageIdx[] {
  return DOC_PAGES.map((page) => {
    const md = page.md.replace(/^#\s+[^\n]*\n/, '');
    const secs = splitGuideSections(md).map((s) => ({ id: s.id, title: plainOf(s.title || ''), text: plainOf(s.lines.join('\n')) }));
    return { page, head: (page.title + ' ' + (page.keys || '')).toLowerCase(), secs };
  });
}

function snippetOf(text: string, word: string): string {
  const at = text.toLowerCase().indexOf(word);
  if (at < 0) return text.slice(0, 80);
  const from = Math.max(0, at - 28), to = Math.min(text.length, at + word.length + 52);
  return (from > 0 ? '…' : '') + text.slice(from, to).trim() + (to < text.length ? '…' : '');
}

/** 찾는다. 결과는 점수 높은 순으로 max 개. */
export function guideSearch(q: string, max = 10): GuideHit[] {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  if (!index) index = build();
  const hits: GuideHit[] = [];
  for (const p of index) {
    const title = p.page.title.toLowerCase();
    const inHead = words.every((w) => p.head.includes(w));
    if (inHead) {
      const exact = words.every((w) => title.includes(w));
      hits.push({ slug: p.page.slug, page: p.page.title, sec: '', secId: '', snippet: p.page.lead, score: exact ? (title.startsWith(words[0]) ? 120 : 100) : 60 });
    }
    for (const s of p.secs) {
      const st = s.title.toLowerCase(), body = s.text.toLowerCase();
      if (!words.every((w) => st.includes(w) || body.includes(w))) continue;
      const inTitle = !!s.title && words.every((w) => st.includes(w));
      //  문서 제목에서 이미 맞은 문서의 도입부(절 제목 없음)는 같은 말을 되풀이하므로 뺀다.
      if (!s.title && inHead) continue;
      hits.push({ slug: p.page.slug, page: p.page.title, sec: s.title, secId: s.title ? s.id : '', snippet: snippetOf(s.text, words[0]), score: inTitle ? 50 : 10 });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, max);
}
