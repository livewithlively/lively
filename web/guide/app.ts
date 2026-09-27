// guide/app.ts. 「사용 가이드」 앱(#4179, 2026-09-27 전면 개편).
//  새 셸이 직접 그리는 화면이다(자료 · 분류체계와 같은 방식). 주소가 정본이다.
//   · `#/learn`                       첫 화면: 처음 읽을 순서와 문서 묶음.
//   · `#/learn/docs/<문서>`            문서 한 장.
//   · `#/learn/docs/<문서>?h=<절>`     그 문서의 절 하나로 간다.
//  화면은 세 칸이다. 왼쪽은 문서 목록, 가운데는 본문, 오른쪽은 「이 문서에서」(절 목록). 좁은 화면에서는 본문만 남고 목록은 단추로 연다.
//  원고는 docs-content.ts(DOC_PAGES · DOC_GROUPS), 본문 그리기는 guide/render.ts, 도식은 guide/figures.ts, 찾기는 guide/search.ts.
//  클래식 화면(?ui=classic)도 같은 함수를 부른다. 그때는 env.shell=false 라 문서 흐름대로 길게 그린다.
import { el, replaceKids } from '../core.js';
import { DOC_AS_OF, DOC_GROUPS, DOC_LEGACY, DOC_PAGES, type DocGroup, type DocPage } from '../docs-content.js';
import { guideIcon } from './icon.js';
import { renderGuideDoc, type GuideSec } from './render.js';
import { guideSearch, type GuideHit } from './search.js';

export interface GuideWhere { slug: string; anchor: string; redirect?: string }
export interface GuideEnv { shell: boolean }

export const GUIDE_TITLE = '사용 가이드';

/** 문서(와 절)의 주소. */
export function guideHref(slug: string, secId?: string): string {
  if (!slug) return '#/learn';
  return '#/learn/docs/' + encodeURIComponent(slug) + (secId ? '?h=' + encodeURIComponent(secId) : '');
}

const pageOf = (slug: string): DocPage | null => DOC_PAGES.find((p) => p.slug === slug) || null;
const groupOf = (slug: string): DocGroup | null => DOC_GROUPS.find((g) => g.slugs.includes(slug)) || null;
/** 묶음 순서대로 늘어놓은 문서. 이전 · 다음이 이 순서를 따른다. */
const ordered = (): DocPage[] => DOC_GROUPS.flatMap((g) => g.slugs.map(pageOf)).filter((p): p is DocPage => !!p);

/** 주소의 뒤 칸을 풀어 어느 문서의 어느 절인지 정한다. 옛 주소는 새 문서로 보낸다. */
export function parseGuideRoute(segs: string[], params: URLSearchParams): GuideWhere {
  const sub = segs[1] || '';
  if (sub === 'tour') return { slug: '', anchor: '', redirect: '#/start/tour' };
  if (sub === 'install') return { slug: '', anchor: '', redirect: '#/start' };
  if (sub !== 'docs') return { slug: '', anchor: '' };
  let slug = '';
  try { slug = decodeURIComponent(segs[2] || ''); } catch { slug = segs[2] || ''; }
  let anchor = params.get('h') || '';
  //  프로젝트 화면의 「연결된 지식」 도움말 링크(옛 주소). 그 설명은 프로젝트 문서의 절로 옮겼다.
  if (slug === 'wiki' && params.get('focus') === 'required') { slug = 'projects'; anchor = 'knowledge'; }
  if (slug in DOC_LEGACY) slug = DOC_LEGACY[slug];
  if (!pageOf(slug)) return { slug: '', anchor: '' };
  return { slug, anchor };
}

/** 탭 이름. 문서를 보고 있으면 그 문서의 제목을 쓴다. */
export function guideTabTitle(where: GuideWhere): string {
  const p = where.slug ? pageOf(where.slug) : null;
  return p ? p.title : GUIDE_TITLE;
}

// ── 화면 하나의 상태. 호스트마다 하나(같은 호스트에 다시 그리면 목록은 두고 본문만 바꾼다) ──
interface GuideView {
  root: HTMLElement; env: GuideEnv;
  crumb: HTMLElement; nav: HTMLElement; main: HTMLElement; toc: HTMLElement; find: HTMLInputElement; panel: HTMLElement;
  slug: string | null;
  secs: GuideSec[];
  stopSpy: (() => void) | null;
}
const views = new WeakMap<HTMLElement, GuideView>();

/** 주소(#/learn…)를 풀어 어느 문서의 어느 절인지 정한다. 가이드의 주소가 아니면 null. */
export function guideWhereOfHash(hash: string): GuideWhere | null {
  const h = String(hash || '');
  if (!/^#\/learn(\/|\?|$)/.test(h)) return null;
  const q = h.indexOf('?');
  const segs = (q >= 0 ? h.slice(2, q) : h.slice(2)).split('/').filter(Boolean);
  return parseGuideRoute(segs, new URLSearchParams(q >= 0 ? h.slice(q + 1) : ''));
}

// ── 앱 안 이동 ──────────────────────────────────────────────────────────────
//  문서 사이를 오가는 것은 이 앱이 스스로 듣는다. 셸은 탭 키가 같은 주소끼리는 다시 그리지 않는다
//   (v2/main.ts onHash: routeKey 가 같으면 주소만 갱신, tabs.ts 가 #/learn… 을 한 탭 키로 접는다). 자료 · 분류체계 앱과 같은 규칙이다.
//  ★ 이 듣개가 없던 첫 판(2026-09-27)은 문서 목록을 눌러도 주소만 바뀌고 본문이 그대로였다. 주소로 직접 연 화면만 찍어 보고 내보낸 탓이다.
//  ⚠ 그 칸이 **아직 가이드의 것일 때만** 그린다. 같은 칸에 다른 화면(세션 · 프로젝트 · 다른 앱)이 선 뒤에 가이드 주소가 오면
//   그 화면을 덮지 않고 셸에 맡긴다. 셸이 새 탭을 열지 그 탭에 그릴지는 셸이 정한다.
let mounted: { host: HTMLElement; env: GuideEnv } | null = null;
let lastDrawn = '';
/** 이 칸에 지금 가이드가 서 있나. */
function ownsHost(host: HTMLElement): boolean {
  const v = views.get(host);
  return !!v && host.isConnected && host.contains(v.root);
}
/** 주소가 바뀌었을 때 가이드가 할 일을 한다. 그렸으면 true. (hashchange 가 부른다. 시험도 이 함수를 부른다) */
export function guideOnHash(hash: string): boolean {
  if (!mounted) return false;
  if (!mounted.host.isConnected) { mounted = null; return false; }
  if (hash === lastDrawn) return false;               // 셸(또는 클래식 라우터)이 이미 그린 주소다
  const where = guideWhereOfHash(hash);
  if (!where) return false;                          // 가이드를 떠나는 이동은 셸이 그린다
  if (!ownsHost(mounted.host)) return false;         // 그 칸은 이제 다른 화면의 것이다
  if (where.redirect) { location.replace(location.pathname + location.search + where.redirect); return false; }
  renderGuideApp(mounted.host, where, mounted.env);
  return true;
}
if (typeof window !== 'undefined') window.addEventListener('hashchange', () => { guideOnHash(location.hash); });

/** 가이드를 그린다. 같은 호스트에 이미 서 있으면 본문과 표시만 바꾼다. */
export function renderGuideApp(host: HTMLElement, where: GuideWhere, env: GuideEnv): void {
  mounted = { host, env };
  lastDrawn = typeof location !== 'undefined' ? location.hash : '';
  let v = views.get(host) || null;
  if (!v || !host.contains(v.root) || v.env.shell !== env.shell) {
    v = build(env);
    views.set(host, v);
    replaceKids(host, v.root);
  }
  const samePage = v.slug === where.slug;
  if (!samePage) paintPage(v, where.slug);
  paintNav(v, where.slug);
  v.root.classList.remove('nav-open');
  if (where.anchor) jumpTo(v, where.anchor, samePage);
  else if (!samePage) scrollTop(v);
}

function build(env: GuideEnv): GuideView {
  const find = el('input', { class: 'gd-find-in', type: 'search', placeholder: '가이드에서 찾기', 'aria-label': '가이드에서 찾기', autocomplete: 'off' }) as HTMLInputElement;
  const panel = el('div', { class: 'gd-find-panel', role: 'listbox', hidden: true });
  const crumb = el('nav', { class: 'gd-crumbs', 'aria-label': '현재 위치' });
  const nav = el('nav', { class: 'gd-nav', 'aria-label': '문서 목록' });
  const main = el('div', { class: 'gd-main' });
  const toc = el('aside', { class: 'gd-toc', 'aria-label': '이 문서에서' });
  const menuBtn = el('button', { class: 'gd-menu', type: 'button', 'aria-label': '문서 목록 열기', title: '문서 목록을 엽니다' },
    guideIcon('panel', 'gd-top-ic'), el('span', { text: '목록' }));
  const root = el('div', { class: 'gd' + (env.shell ? '' : ' gd-flowmode') },
    el('header', { class: 'gd-top' },
      menuBtn, crumb, el('span', { class: 'gd-sp' }),
      el('div', { class: 'gd-find' }, guideIcon('search', 'gd-top-ic'), find, panel)),
    el('div', { class: 'gd-cols' }, nav, main, toc),
    el('div', { class: 'gd-scrim', 'aria-hidden': 'true' }));
  const v: GuideView = { root, env, crumb, nav, main, toc, find, panel, slug: null, secs: [], stopSpy: null };

  menuBtn.addEventListener('click', () => root.classList.toggle('nav-open'));
  (root.querySelector('.gd-scrim') as HTMLElement).addEventListener('click', () => root.classList.remove('nav-open'));
  wireFind(v);
  // 목차는 같은 문서 안에서 움직인다. 화면을 다시 그리지 않고 그 절로 굴린다.
  toc.addEventListener('click', (ev: Event) => {
    const a = (ev.target as Element).closest?.('a[data-sec]') as HTMLAnchorElement | null;
    if (!a) return;
    const me = ev as MouseEvent;
    if (me.metaKey || me.ctrlKey || me.shiftKey || me.altKey || me.button !== 0) return;
    ev.preventDefault();
    jumpTo(v, a.dataset.sec || '', true);
    try { history.replaceState(history.state, '', guideHref(v.slug || '', a.dataset.sec || '')); } catch { /* 주소를 못 바꿔도 굴리기는 됐다 */ }
  });
  return v;
}

// ── 왼쪽 문서 목록 ──────────────────────────────────────────────────────────
function paintNav(v: GuideView, slug: string): void {
  const home = el('a', { class: 'gd-nav-home' + (slug ? '' : ' on'), href: guideHref('') , ...(slug ? {} : { 'aria-current': 'page' }) },
    guideIcon('home', 'gd-nav-ic'), el('span', { text: '가이드 첫 화면' }));
  const groups = DOC_GROUPS.map((g) => el('section', { class: 'gd-nav-g' },
    el('h3', { class: 'gd-nav-t' }, guideIcon(g.icon, 'gd-nav-ic'), el('span', { text: g.title })),
    ...g.slugs.map(pageOf).filter((p): p is DocPage => !!p).map((p) =>
      el('a', { class: 'gd-nav-a' + (p.slug === slug ? ' on' : ''), href: guideHref(p.slug), ...(p.slug === slug ? { 'aria-current': 'page' } : {}) }, p.title))));
  const keep = v.nav.scrollTop;
  replaceKids(v.nav, home, ...groups);
  v.nav.scrollTop = keep;
  const on = v.nav.querySelector('.gd-nav-a.on') as HTMLElement | null;
  if (on) {
    const top = on.offsetTop, h = v.nav.clientHeight;
    if (h && (top < v.nav.scrollTop + 40 || top > v.nav.scrollTop + h - 60)) v.nav.scrollTop = Math.max(0, top - h / 3);
  }
}

// ── 본문 ────────────────────────────────────────────────────────────────────
function paintPage(v: GuideView, slug: string): void {
  if (v.stopSpy) { v.stopSpy(); v.stopSpy = null; }
  v.slug = slug;
  const page = slug ? pageOf(slug) : null;
  const group = page ? groupOf(page.slug) : null;
  replaceKids(v.crumb,
    el('a', { class: 'gd-crumb', href: guideHref('') }, guideIcon('learn', 'gd-crumb-ic'), el('span', { text: GUIDE_TITLE })),
    group ? [el('span', { class: 'gd-sl', text: '/' }), el('span', { class: 'gd-crumb is-mid', text: group.title })] : null,
    page ? [el('span', { class: 'gd-sl', text: '/' }), el('span', { class: 'gd-now', text: page.title })] : null);
  if (!page) { v.secs = []; replaceKids(v.main, homeArticle()); replaceKids(v.toc); v.root.classList.add('is-home', 'no-toc'); return; }
  v.root.classList.remove('is-home');
  const md = page.md.replace(/^#\s+[^\n]*\n/, '');
  const doc = renderGuideDoc(md, { shell: v.env.shell });
  v.secs = doc.secs;
  const list = ordered();
  const at = list.findIndex((p) => p.slug === page.slug);
  const prev = at > 0 ? list[at - 1] : null, next = at >= 0 && at < list.length - 1 ? list[at + 1] : null;
  replaceKids(v.main, el('article', { class: 'gd-article' },
    el('p', { class: 'gd-eyebrow', text: group ? group.title : GUIDE_TITLE }),
    el('h1', { class: 'gd-h1', text: page.title }),
    el('p', { class: 'gd-lead', text: page.lead }),
    doc.body,
    el('nav', { class: 'gd-pager', 'aria-label': '이전 문서와 다음 문서' },
      prev ? el('a', { class: 'gd-pg is-prev', href: guideHref(prev.slug) }, el('span', { class: 'gd-pg-k', text: '이전' }), el('b', { text: prev.title })) : el('span'),
      next ? el('a', { class: 'gd-pg is-next', href: guideHref(next.slug) }, el('span', { class: 'gd-pg-k', text: '다음' }), el('b', { text: next.title })) : el('span')),
    asOfNote()));
  replaceKids(v.toc,
    doc.secs.length > 1 ? el('div', { class: 'gd-toc-in' },
      el('p', { class: 'gd-toc-t', text: '이 문서에서' }),
      ...doc.secs.map((s) => el('a', { class: 'gd-toc-a', href: guideHref(page.slug, s.id), 'data-sec': s.id }, s.title))) : null);
  v.root.classList.toggle('no-toc', doc.secs.length <= 1);
  v.stopSpy = spy(v);
}

function asOfNote(): HTMLElement {
  const [y, m, d] = DOC_AS_OF.split('-').map((n) => Number(n));
  return el('p', { class: 'gd-asof', text: `${y}년 ${m}월 ${d}일 화면을 기준으로 썼습니다. 화면이 이 글과 다르면 화면이 맞습니다.` });
}

// 첫 화면. 처음 읽을 순서 셋과 문서 묶음 전부.
function homeArticle(): HTMLElement {
  const first = ['overview', 'first-run', 'screen-map'].map(pageOf).filter((p): p is DocPage => !!p);
  return el('article', { class: 'gd-article gd-home' },
    el('h1', { class: 'gd-h1', text: GUIDE_TITLE }),
    el('p', { class: 'gd-lead', text: '라이블리를 처음 여는 분은 아래 세 문서를 순서대로 읽으시면 됩니다. 특정 화면의 사용법은 묶음에서 고르거나 위의 찾기 칸에 화면 이름을 적어 찾습니다.' }),
    el('div', { class: 'gd-path' }, ...first.map((p, i) =>
      el('a', { class: 'gd-path-a', href: guideHref(p.slug) },
        el('i', { class: 'gd-no', text: String(i + 1) }),
        el('span', { class: 'gd-path-b' }, el('b', { text: p.title }), el('span', { text: p.lead }))))),
    el('div', { class: 'gd-groups' }, ...DOC_GROUPS.map((g) =>
      el('section', { class: 'gd-gcard' },
        el('h2', { class: 'gd-gcard-t' }, guideIcon(g.icon, 'gd-gcard-ic'), el('span', { text: g.title })),
        el('p', { class: 'gd-gcard-h', text: g.hint }),
        el('div', { class: 'gd-gcard-l' }, ...g.slugs.map(pageOf).filter((p): p is DocPage => !!p).map((p) =>
          el('a', { href: guideHref(p.slug) }, p.title)))))),
    asOfNote());
}

// ── 굴리기 ──────────────────────────────────────────────────────────────────
function scroller(v: GuideView): HTMLElement | null { return v.env.shell ? v.main : null; }
function scrollTop(v: GuideView): void {
  const s = scroller(v);
  if (s) s.scrollTop = 0;
  else { try { v.root.scrollIntoView({ block: 'start' }); } catch { /* 옛 브라우저 */ } }
}
function jumpTo(v: GuideView, secId: string, smooth: boolean): void {
  const target = secId ? v.main.querySelector('#gd-' + cssId(secId)) as HTMLElement | null : null;
  if (!target) { if (!smooth) scrollTop(v); return; }
  const go = (): void => {
    target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    const sec = target.closest('.gd-sec') as HTMLElement | null;
    if (sec) { sec.classList.add('gd-flash'); setTimeout(() => sec.classList.remove('gd-flash'), 1400); }
  };
  if (smooth) go(); else requestAnimationFrame(go);
}
const cssId = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '');

// 지금 읽는 절을 목차에 표시한다.
function spy(v: GuideView): () => void {
  const s = scroller(v);
  const src: HTMLElement | Window = s || window;
  let raf = 0;
  const run = (): void => {
    raf = 0;
    const base = s ? s.getBoundingClientRect().top : 0;
    let cur = '';
    for (const sec of v.secs) {
      const h = v.main.querySelector('#gd-' + cssId(sec.id)) as HTMLElement | null;
      if (!h) continue;
      if (h.getBoundingClientRect().top - base <= 96) cur = sec.id; else break;
    }
    if (!cur && v.secs.length) cur = v.secs[0].id;
    for (const a of Array.from(v.toc.querySelectorAll<HTMLElement>('a[data-sec]'))) a.classList.toggle('on', a.dataset.sec === cur);
  };
  const on = (): void => { if (!raf) raf = requestAnimationFrame(run); };
  src.addEventListener('scroll', on, { passive: true });
  run();
  return () => { src.removeEventListener('scroll', on); if (raf) cancelAnimationFrame(raf); };
}

// ── 찾기 ────────────────────────────────────────────────────────────────────
function wireFind(v: GuideView): void {
  let hits: GuideHit[] = [];
  let at = -1;
  const close = (): void => { v.panel.hidden = true; at = -1; };
  const draw = (): void => {
    const q = v.find.value.trim();
    if (!q) { close(); return; }
    hits = guideSearch(q, 10);
    at = hits.length ? 0 : -1;
    replaceKids(v.panel, hits.length
      ? hits.map((h, i) => el('a', { class: 'gd-hit' + (i === at ? ' on' : ''), href: guideHref(h.slug, h.secId), role: 'option', 'data-i': String(i) },
        el('span', { class: 'gd-hit-t' }, el('b', { text: h.page }), h.sec ? el('span', { text: h.sec }) : null),
        el('span', { class: 'gd-hit-s', text: h.snippet })))
      : el('p', { class: 'gd-hit-none', text: '맞는 문서가 없습니다. 화면에 적힌 이름 그대로 적어 보세요.' }));
    v.panel.hidden = false;
  };
  const mark = (): void => { for (const a of Array.from(v.panel.querySelectorAll<HTMLElement>('.gd-hit'))) a.classList.toggle('on', Number(a.dataset.i) === at); };
  v.find.addEventListener('input', draw);
  v.find.addEventListener('focus', () => { if (v.find.value.trim()) draw(); });
  v.find.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.isComposing) return;
    if (ev.key === 'Escape') { close(); v.find.blur(); return; }
    if (v.panel.hidden || !hits.length) return;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); at = (at + 1) % hits.length; mark(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); at = (at - 1 + hits.length) % hits.length; mark(); }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      const h = hits[at];
      if (h) { v.find.value = ''; close(); location.hash = guideHref(h.slug, h.secId); }
    }
  });
  v.panel.addEventListener('click', () => { v.find.value = ''; close(); });
  document.addEventListener('mousedown', (ev: Event) => {
    if (!v.root.isConnected || v.panel.hidden) return;
    if (!(ev.target as Element).closest?.('.gd-find')) close();
  });
}
