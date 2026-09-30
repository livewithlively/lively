// guide/render.ts. 사용 가이드 본문 렌더러(#4179, 2026-09-27 전면 개편).
//  원고(docs-content.ts 의 md) 한 장을 절(## 제목) 단위로 나눠 그린다. 절마다 닻(id)을 달아 오른쪽 「이 문서에서」 목록과
//   주소(?h=<id>)가 그 절을 가리킬 수 있게 한다.
//  원고 문법은 web/lib/markdown.ts 그대로이고(칩 [버튼] · 「이름」, :::steps · :::callout · :::tabs · :::shot …), 여기서 더하는 것은 셋이다.
//   · `## 제목 {#id}`   절의 닻 이름을 원고가 정한다. 없으면 순번(s1, s2 …)을 쓴다.
//   · `{{fig:이름}}`     한 줄을 통째로 차지하면 그 자리에 도식(guide/figures.ts)이 선다.
//   · `{{ic:이름}}`      글 안에 선 아이콘 하나(lib/icon-paths.ts 의 이름). 화면의 그림과 같은 그림이다.
//   · `{{origin}}`       지금 워크스페이스의 주소(설치 명령에 쓴다).
//  ⚠ 모든 글은 renderMarkdown 을 거친다(textContent 만 쓴다). 이 파일은 innerHTML 을 쓰지 않는다.
import { el, renderMarkdown } from '../core.js';
import { copyButton } from '../ui-primitives.js';
import { guideFigure } from './figures.js';
import { guideIcon } from './icon.js';

export interface GuideSec { id: string; title: string }
export interface GuideDoc { body: HTMLElement; secs: GuideSec[] }
export interface GuideRenderOpts {
  /** 새 셸 안인가. 아니면(클래식 화면) 새 셸에만 있는 화면으로 가는 링크를 글자로만 둔다. */
  shell: boolean;
}

const FIG_LINE = /^\{\{fig:([a-z0-9-]+)\}\}\s*$/;
const IC_TOKEN = /\{\{ic:([a-z0-9-]+)\}\}/gi;
const HEAD_ID = /\s*\{#([a-z0-9-]+)\}\s*$/i;

interface RawSec { title: string | null; id: string; lines: string[] }

/** 원고를 절로 나눈다. 코드 울타리와 ::: 상자 안의 `## ` 은 제목이 아니다. */
export function splitGuideSections(md: string): RawSec[] {
  const secs: RawSec[] = [{ title: null, id: '', lines: [] }];
  let fence = false, depth = 0, n = 0;
  for (const line of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && /^:::\s*[a-zA-Z_-]/.test(line)) depth++;
    else if (!fence && line.trim() === ':::') depth = Math.max(0, depth - 1);
    const h2 = !fence && !depth ? /^##\s+(.+)$/.exec(line) : null;
    if (h2) {
      n++;
      let title = h2[1].trim();
      const m = HEAD_ID.exec(title);
      const id = m ? m[1] : 's' + n;
      if (m) title = title.replace(HEAD_ID, '').trim();
      secs.push({ title, id, lines: [] });
      continue;
    }
    secs[secs.length - 1].lines.push(line);
  }
  return secs;
}

/** 절 목록만(검색 · 목차가 읽는다). 그리지 않는다. */
export function guideSectionsOf(md: string): GuideSec[] {
  return splitGuideSections(md).filter((s) => s.title).map((s) => ({ id: s.id, title: plainTitle(s.title as string) }));
}
function plainTitle(t: string): string { return t.replace(/[「」[\]*`]/g, '').replace(IC_TOKEN, '').trim(); }

/** 원고 한 장을 그린다. 첫 `# 제목` 줄은 앱이 따로 그리므로 여기 오기 전에 떼어 낸다. */
export function renderGuideDoc(md: string, opts: GuideRenderOpts): GuideDoc {
  //  {{origin}} 은 지금 워크스페이스의 주소다. 설치 명령처럼 주소가 들어가는 글이 워크스페이스마다 맞게 나온다.
  md = String(md || '').replace(/\{\{origin\}\}/g, guideOrigin());
  const body = el('div', { class: 'gd-doc' });
  const secs: GuideSec[] = [];
  for (const s of splitGuideSections(md)) {
    const chunks = renderChunks(s.lines, opts);
    if (!s.title) {
      if (chunks.length) body.append(el('div', { class: 'gd-intro' }, ...chunks));
      continue;
    }
    const title = plainTitle(s.title);
    secs.push({ id: s.id, title });
    const h = el('h2', { class: 'gd-h2', id: 'gd-' + s.id }, ...inlineOf(s.title));
    body.append(el('section', { class: 'gd-sec', 'data-sec': s.id }, h, ...chunks));
  }
  return { body, secs };
}

// 제목 안의 칩 · 굵은 글도 같은 렌더러로 그린다(문단 하나로 그린 뒤 그 안의 노드만 꺼낸다).
function inlineOf(text: string): Node[] {
  const p = renderMarkdown(text, { uiChips: true }).querySelector('.md-p');
  const out: Node[] = [];
  if (p) while (p.firstChild) out.push(p.removeChild(p.firstChild));
  else out.push(document.createTextNode(text));
  return out;
}

// 절 하나의 줄들을 글 덩어리와 도식으로 나눠 그린다.
function renderChunks(lines: string[], opts: GuideRenderOpts): HTMLElement[] {
  const out: HTMLElement[] = [];
  let buf: string[] = [];
  let fence = false, depth = 0;
  const flush = (): void => {
    const text = buf.join('\n').trim();
    buf = [];
    if (!text) return;
    out.push(decorate(renderMarkdown(text, { uiChips: true }), opts));
  };
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && /^:::\s*[a-zA-Z_-]/.test(line)) depth++;
    else if (!fence && line.trim() === ':::') depth = Math.max(0, depth - 1);
    const fig = !fence && !depth ? FIG_LINE.exec(line.trim()) : null;
    if (fig) {
      flush();
      const node = guideFigure(fig[1]);
      if (node) out.push(node);
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

// 렌더된 글을 가이드의 조판으로 다듬는다. 문장은 그대로 두고 모양만 바꾼다.
function decorate(root: HTMLElement, opts: GuideRenderOpts): HTMLElement {
  root.classList.add('gd-md');

  // 코드 상자에 [복사]. 이 문서의 코드 상자는 그대로 가져가 쓰는 명령이다.
  for (const pre of Array.from(root.querySelectorAll<HTMLElement>('pre.md-pre'))) {
    const text = String(pre.textContent || '');
    if (!text.trim() || !pre.parentNode) continue;
    const wrap = el('div', { class: 'gd-code' });
    pre.parentNode.insertBefore(wrap, pre);
    wrap.append(pre, copyButton(() => text, '복사'));
  }

  // 표는 가로로 넘칠 때 표만 옆으로 민다(본문을 밀지 않는다).
  for (const t of Array.from(root.querySelectorAll<HTMLElement>('table.md-table'))) {
    if (t.closest('.gd-table')) continue;
    const wrap = el('div', { class: 'gd-table' });
    t.replaceWith(wrap);
    wrap.append(t);
  }

  // «**이름**: 설명» 으로만 이뤄진 목록은 이름 열과 설명 열로 세운다.
  for (const ul of Array.from(root.querySelectorAll<HTMLElement>('ul'))) {
    const lis = Array.from(ul.children) as HTMLElement[];
    if (!lis.length || ul.closest('.gd-defs')) continue;
    const startsBold = (li: HTMLElement): boolean => !!li.firstElementChild && li.firstElementChild === li.firstChild && li.firstElementChild.tagName === 'STRONG';
    if (!lis.every(startsBold)) continue;
    const box = el('div', { class: 'gd-defs' });
    for (const li of lis) {
      const strong = li.firstElementChild as HTMLElement;
      const t = el('div', { class: 'gd-def-t' });
      while (strong.firstChild) t.append(strong.firstChild);
      strong.remove();
      const d = el('div', { class: 'gd-def-d' });
      while (li.firstChild) d.append(li.firstChild);
      const first = d.firstChild;
      //  쌍점과 줄표를 구분자로 걷는다(«**제목**: 설명»).
      if (first && first.nodeType === 3) first.textContent = String(first.textContent).replace(/^\s*[—–:-]\s*/, '');
      box.append(el('div', { class: 'gd-def' }, t, d));
    }
    ul.replaceWith(box);
  }

  // 링크. 가이드 안의 링크는 그대로 두고, 앱 화면으로 가는 링크는 「화면 열기」 모양으로 그린다.
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); a.classList.add('gd-ext'); continue; }
    if (!href.startsWith('#/') || href.startsWith('#/learn')) continue;
    if (!opts.shell) { a.replaceWith(document.createTextNode(a.textContent || '')); continue; }
    a.classList.add('gd-jump');
    a.append(guideIcon('open', 'gd-jump-ic'));
  }

  inlineIcons(root);
  return root;
}

// 글 안의 {{ic:이름}} 을 선 아이콘으로 바꾼다. 코드 안의 것은 그대로 둔다.
function inlineIcons(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.data.indexOf('{{ic:') < 0) continue;
    if (t.parentElement && t.parentElement.closest('code, pre')) continue;
    hits.push(t);
  }
  for (const t of hits) {
    const frag = document.createDocumentFragment();
    let last = 0;
    IC_TOKEN.lastIndex = 0;
    for (let m = IC_TOKEN.exec(t.data); m; m = IC_TOKEN.exec(t.data)) {
      if (m.index > last) frag.append(t.data.slice(last, m.index));
      frag.append(guideIcon(m[1], 'gd-ic'));
      last = m.index + m[0].length;
    }
    if (last < t.data.length) frag.append(t.data.slice(last));
    t.replaceWith(frag);
  }
}

function guideOrigin(): string {
  try { return location.origin; } catch { return ''; }
}
