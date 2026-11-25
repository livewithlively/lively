// lib/chat-links.ts — 대화 화면(chat-view)의 AI 답 글에 **파일 경로**와 **지식 이름**을 링크로 단다(#5650).
//
//  원준 2026-11-24 «그 문제도 고쳐야 하고» — 세션이 회수·오류로 끝나면 세션 화면은 터미널 액자를 걷고 대화 화면으로 내려앉는다
//   (session-chat dropTermFrame). 대화 화면은 맨 URL 만 링크로 만들어, 터미널에선 누르면 곁칸 뷰어로 열리던 경로·지식 이름이
//   끝난 세션에선 그냥 글자였다. 판정은 터미널과 **같은 규칙**(lib/path-link.ts — standalone/path-link.ts 의 사본)이다.
//
//  · 경로 → `<a class="md-link md-path" data-path=…>`. 누르면 chat-view 가 곁칸에 PANE_LINK_EVENT(kind 'path')를 띄우고,
//    곁칸(v2/panes.ts onPaneLink)이 터미널 경로와 같은 길(planPathOpen — [자료] + 뷰어)로 연다.
//    프로젝트 경로는 href 에 자료 보기(#/f)를 실어 둔다 — 곁칸이 없는 화면·⌘클릭(새 탭)에서도 열린다.
//    세션 폴더 기준 경로(`docs/a.md`)는 그 세션을 아는 화면(sid)에서만 단다 — 남의 화면에선 열 자리가 없다.
//  · 지식 이름 → 서버에 있다고 확인된 이름만 `<a class="md-link" href="#/k/<이름>">`(터미널과 같은 확인 — 슬러그는 흔한 낱말과 생김새가 같다).
//    확인은 비동기라 글이 그려진 뒤에 감싼다. 그 사이 글이 다시 그려졌으면(스트리밍) 다음 그리기가 다시 한다.
//  · 보이는 글(원준 2026-11-24 «실제 경로를 그냥 파일 이름으로 감싸서 picture.png 이렇게 · 우클릭하면 링크»): 경로는 **파일 이름만**,
//    우리 화면의 지식 주소(`…/ui/#/k/<이름>`)는 **지식 이름만**, 자료 주소(`…/ui/#/f?…project/N/…`)는 파일 이름만 보인다. 실제 경로·주소는
//    마우스를 올리면(title) 보이고, 우클릭 메뉴(data-ctx="chat-link")가 복사해 준다.
//  · 건드리지 않는 곳: 이미 링크인 것(a) · 단추 · 코드 블록(pre)의 문법 색 조각 사이(한 글 마디 안에서만 찾는다).

import { pathMatches, pathLinkTarget, knowledgeCandidates } from './path-link.js';
import { apiUrl, TOKEN_KEY } from './net.js';
import { uiPaneLink } from './ui-link.js';
import { knNameOfHref } from './kn-links.js';

export type PathLinkData = {
  path: string;
  target: { kind: 'project'; id: number; rel: string } | { kind: 'session'; rel: string };
  cands: Array<{ path: string; target: unknown }>;
};

/** 프로젝트 경로의 자료 보기 주소(곁칸이 없을 때·⌘클릭의 길). 세션 경로는 주소가 없다. */
export function pathHref(t: PathLinkData['target']): string | null {
  return t.kind === 'project' ? '#/f?root=shared&path=' + encodeURIComponent('project/' + t.id + '/' + t.rel) : null;
}

/** 링크 요소에 실린 경로 → 곁칸이 받을 모양. 깨졌으면 null. */
export function pathLinkOf(a: Element): PathLinkData | null {
  const path = a.getAttribute('data-path') || '';
  const target = pathLinkTarget(path);
  if (!target) return null;
  let alts: string[] = [];
  try { const v = JSON.parse(a.getAttribute('data-alts') || '[]'); if (Array.isArray(v)) alts = v.filter((x) => typeof x === 'string'); } catch (_) { /* 없음 */ }
  const cands = [...alts, path].map((p) => ({ path: p, target: pathLinkTarget(p) })).filter((c) => c.target);
  return { path, target, cands };
}

const SKIP = 'a, button, textarea, input, select, .livc-said-copy';

function textNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n.parentElement && n.parentElement.closest(SKIP)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) if ((n as Text).data.trim()) out.push(n as Text);
  return out;
}

/** 한 글 마디의 [start,end) 범위들을 링크 요소로 감싼다(범위는 겹치지 않고 앞에서 뒤로). */
function wrapRanges(node: Text, ranges: Array<{ start: number; end: number; make: (text: string) => HTMLElement }>): void {
  if (!ranges.length || !node.parentNode) return;
  const s = node.data;
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const r of ranges) {
    if (r.start < at) continue;
    if (r.start > at) frag.append(s.slice(at, r.start));
    frag.append(r.make(s.slice(r.start, r.end)));
    at = r.end;
  }
  if (at < s.length) frag.append(s.slice(at));
  node.parentNode.replaceChild(frag, node);
}

/** 경로 링크를 단다. hasSession = 세션 폴더 기준 경로를 열 수 있는 화면인가(그 세션을 아는 세션 화면). */
export function linkifyPaths(root: HTMLElement, hasSession: boolean): void {
  for (const node of textNodes(root)) {
    const ms = pathMatches(node.data).filter((m) => {
      const t = pathLinkTarget(m.url);
      return !!t && (t.kind === 'project' || hasSession);
    });
    wrapRanges(node, ms.map((m) => ({
      start: m.start, end: m.end,
      make: (text: string): HTMLElement => {
        const a = document.createElement('a');
        a.className = 'md-link md-path';
        a.textContent = fileNameOf(text);
        a.setAttribute('data-path', m.url);
        a.setAttribute('data-ctx', 'chat-link');
        if (m.alts && m.alts.length) a.setAttribute('data-alts', JSON.stringify(m.alts));
        const href = pathHref(pathLinkTarget(m.url)!);
        if (href) a.setAttribute('href', href); else { a.setAttribute('role', 'link'); a.tabIndex = 0; }
        a.title = m.url;
        return a;
      },
    })));
  }
}

// ── 지식 이름 ─────────────────────────────────────────────────────────────────────────
//  이름 → 있나. 묻는 중이면 Promise. 못 물었으면(망·5xx·1.5초 초과) 기억하지 않는다. «없다» 는 60초만 믿는다(터미널과 같은 규칙).
const known = new Map<string, boolean | Promise<boolean>>();
const noAt = new Map<string, number>();
const NO_TTL = 60_000, ASK_MS = 1500;

function ask(n: string): Promise<boolean> {
  const had = known.get(n);
  if (had instanceof Promise) return had;
  if (had === true) return Promise.resolve(true);
  if (had === false && Date.now() - (noAt.get(n) || 0) <= NO_TTL) return Promise.resolve(false);
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const headers: Record<string, string> = {};
  try { const tok = localStorage.getItem(TOKEN_KEY); if (tok) headers.Authorization = 'Bearer ' + tok; } catch (_) { /* 저장소 없음 */ }
  const req = fetch(apiUrl('/api/ui/knowledge/' + encodeURIComponent(n) + '?limit=1'), { headers, credentials: 'same-origin', cache: 'no-store', signal: ctrl?.signal })
    .then((r): boolean | null => (r.ok ? true : r.status === 404 ? false : null))
    .catch((): null => null);
  const late = new Promise<null>((res) => window.setTimeout(() => { try { ctrl?.abort(); } catch (_) { /* noop */ } res(null); }, ASK_MS));
  const p = Promise.race([req, late]).then((v) => {
    if (v === null) { known.delete(n); return false; }
    known.set(n, v);
    if (!v) noAt.set(n, Date.now()); else noAt.delete(n);
    return v;
  });
  known.set(n, p);
  return p;
}

/** 지식 이름 링크를 단다 — 후보를 서버에 물어 있다고 확인된 것만. 끝나면 resolve(시험용). */
export async function linkifyKnowledge(root: HTMLElement): Promise<void> {
  const hits: Array<{ node: Text; start: number; names: { name: string; end: number }[] }> = [];
  for (const node of textNodes(root)) for (const c of knowledgeCandidates(node.data)) hits.push({ node, ...c });
  if (!hits.length) return;
  if (known.size > 500) { known.clear(); noAt.clear(); }
  const names = [...new Set(hits.flatMap((h) => h.names.map((x) => x.name)))].slice(0, 24);
  await Promise.all(names.map((n) => ask(n).catch(() => false)));
  const byNode = new Map<Text, Array<{ start: number; end: number; make: (t: string) => HTMLElement }>>();
  for (const h of hits) {
    if (!h.node.isConnected) continue;                       // 그 사이 다시 그려졌다 — 다음 그리기가 다시 한다
    const n = h.names.find((x) => known.get(x.name) === true);
    if (!n) continue;
    const list = byNode.get(h.node) || [];
    list.push({ start: h.start, end: n.end, make: (text: string) => {
      const a = document.createElement('a');
      a.className = 'md-link md-kn';
      a.textContent = text;
      a.setAttribute('href', '#/k/' + encodeURIComponent(n.name));
      a.setAttribute('data-kn', n.name);
      a.setAttribute('data-ctx', 'chat-link');
      a.title = '지식 ' + n.name;
      return a;
    } });
    byNode.set(h.node, list);
  }
  for (const [node, list] of byNode) wrapRanges(node, list.sort((a, b) => a.start - b.start));
}

/** 경로의 파일 이름(마지막 마디) — `/`·`\\` 둘 다 가른다. 없으면 그대로. */
export function fileNameOf(p: string): string {
  const t = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i >= 0 && i < t.length - 1 ? t.slice(i + 1) : t;
}
/** 글자가 주소 그대로인가(마크다운 autolink · `[주소](주소)`) — 사람이 붙인 라벨(`[보고서](…)`)은 그대로 둔다. */
function looksLikeUrl(text: string, href: string): boolean {
  const t = String(text || '').trim();
  return !!t && (t === href || /^https?:\/\//i.test(t) || t.startsWith('#/'));
}
/** 이미 링크인 것 중 **우리 화면의 지식·자료 주소**를 이름으로 보이게 하고, 모든 링크에 우클릭 메뉴 표지를 단다. */
export function relabelLinks(root: HTMLElement): void {
  for (const a of Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
    if (a.hasAttribute('data-path') || a.hasAttribute('data-kn')) continue;
    a.setAttribute('data-ctx', 'chat-link');
    const href = a.getAttribute('href') || '';
    //  `#/…` 는 **우리 화면(같은 폴더의 첫 페이지)** 의 주소다 — 지금 문서 이름(`index.html` 등)에 붙이면 우리 화면으로 안 읽힌다.
    const base = href.startsWith('#') ? location.origin + location.pathname.replace(/[^/]*$/, '') : location.href;
    let url = href;
    try { url = new URL(href, base).href; } catch (_) { /* 그대로 */ }
    const pane = uiPaneLink(url, location.href);
    if (pane && pane.kind === 'file') {
      const t = pathLinkTarget(pane.path);
      if (t) {
        a.setAttribute('data-path', pane.path);
        a.classList.add('md-path');
        if (looksLikeUrl(a.textContent || '', href)) a.textContent = fileNameOf(pane.path);
        a.title = pane.path;
        continue;
      }
    }
    if (pane && pane.kind === 'web') {
      let name: string | null = null;
      try { name = knNameOfHref(new URL(url).hash); } catch (_) { name = null; }
      if (name) {
        a.setAttribute('data-kn', name);
        a.classList.add('md-kn');
        if (looksLikeUrl(a.textContent || '', href)) a.textContent = name;
        a.title = '지식 ' + name;
        continue;
      }
    }
    if (!a.title) a.title = url;
  }
}

/** 답 글 한 덩이에 링크를 단다(경로는 곧바로, 지식 이름은 확인 뒤). */
export function linkifyChat(root: HTMLElement, hasSession: boolean): HTMLElement {
  try { relabelLinks(root); } catch (_) { /* noop */ }
  try { linkifyPaths(root, hasSession); } catch (_) { /* 링크는 편의다 — 글은 그대로 보인다 */ }
  void linkifyKnowledge(root).catch(() => { /* noop */ });
  return root;
}
