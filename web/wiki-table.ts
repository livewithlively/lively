// wiki-table.ts — WIKI 의 **목록 표면**을 프로젝트 탭의 표 문법으로 그린다(#1841).
//  세 앱(AI 세션·프로젝트·WIKI)의 통일감은 콘텐츠를 다시 그리는 게 아니라 **같은 머리(빵부스러기·뷰 탭·툴바)·같은 표·같은 크롬**에서 온다
//  (원준 2026-08-24). 프로젝트 표(13/15/16/29 CSS 의 .pjv-*)를 그대로 쓰고, 위키에만 있는 것(민트 틱·유형·분류·작성 주체)만 열로 얹는다.
//  소비자: wiki.ts(전체·인덱스·검색·미분류 목록 · 자료 · 휴지통) · wiki-category.ts(서고 문서 목록). 문서 카드/피크/대문 빌더는 손대지 않는다.
//  import 방향: core · wiki-data · wiki-ui · projects/{icons,popover}(리프) 만 본다.
import { el, relTime, sv } from './core.js';
import { KN_TYPE_LABEL } from './wiki-data.js';
import { wkTick } from './wiki-ui.js';
import { pjvTabIcon, pjvTbIcon } from './projects/icons.js';
import { pjvPopover } from './projects/popover.js';

// ── 열 정의 — 제목 칸은 고정, 나머지는 호출부가 고른다. 트랙은 한 곳에서 계산한다(헤더·행 동일). ──
export interface WkCol { key: string; label: string; width: string; render: (e: any) => any; align?: 'left' | 'center' }
const WK_TITLE_TRACK = 'minmax(var(--pjv-name-min, 260px), 1fr)';
const WK_MORE_TRACK = '34px';
function wkTrack(cols: WkCol[]) { return [WK_TITLE_TRACK, ...cols.map((c) => c.width), WK_MORE_TRACK].join(' '); }

// 작성 주체 — 민트 틱과 같은 판정(사람 저작 / 외부 미러 / AI). 글자로 한 번 더 말한다(색만으로 뜻을 전하지 않는다).
function wkAuthorLabel(e: any): string {
  if (e.confidence === 'human') return '사람';
  if (e.provenance === 'observed') return '미러';
  return 'AI';
}
// 기본 열(지식) — 유형 · 분류 · 작성 · 갱신. 카테고리 안에서는 분류 열을 뺀다(전 행이 같은 값 = 소음).
export function wkDocCols(opts: { category?: boolean; catName?: (e: any) => string } = {}): WkCol[] {
  const cols: WkCol[] = [
    { key: 'type', label: '유형', width: '88px', render: (e) => el('span', { class: 'pjv-fval', text: e.type ? (KN_TYPE_LABEL[e.type] || e.type) : '' }) },
  ];
  if (opts.category) cols.push({ key: 'cat', label: '분류', width: '150px', align: 'left', render: (e) => el('span', { class: 'pjv-fval wk-tcat', text: (opts.catName && opts.catName(e)) || '' }) });
  cols.push(
    { key: 'who', label: '작성', width: '72px', render: (e) => el('span', { class: 'pjv-fval wk-twho' + (e.confidence === 'human' ? ' human' : ''), text: wkAuthorLabel(e) }) },
    { key: 'updated', label: '갱신', width: '92px', render: (e) => el('span', { class: 'pjv-fval', title: e.updated_at || '', text: e.updated_at ? relTime(e.updated_at) : '' }) },
  );
  return cols;
}

// 폴더 — 선 아이콘(📁 폐지). 사용자가 고른 아이콘(e.icon)은 내용이라 그대로.
function wkFolderIcon() {
  const n = sv('svg', { class: 'wk-trow-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M3.5 7.5A2 2 0 0 1 5.5 5.5h4.2l2 2h6.8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' }));
  return n;
}

// 컬럼 헤더 — 프로젝트 리스트의 pjvListColHead 와 같은 껍데기(.pjv-list-colhead). 정렬·숨김은 없다.
export function wkColHead(cols: WkCol[], titleLabel = '제목') {
  const head = el('div', { class: 'pjv-tgroup-head pjv-tgroup-head-cols pjv-list-colhead wk-colhead' },
    el('div', { class: 'pjv-trow-title-cell' }, el('span', { class: 'pjv-list-colhead-name', text: titleLabel })),
    ...cols.map((c) => el('div', { class: 'pjv-tcell pjv-colhead pjv-stdcol' + (c.align === 'left' ? ' wk-col-left' : ''), 'data-col': c.key }, el('span', { class: 'pjv-thcol-name', text: c.label, title: c.label }))),
    el('div', { class: 'pjv-tcell pjv-tcell-add' }, el('span', {})));
  head.style.gridTemplateColumns = wkTrack(cols);
  return head;
}

export interface WkRowOpts {
  cols: WkCol[];
  open?: (e: any, rowEl: HTMLElement) => void;          // 제목 클릭(없으면 #/k/<name> 이동)
  deck?: string;                                         // 제목 옆 발췌(본문 첫 줄·검색 스니펫)
  select?: { names: Set<string>; onToggle: () => void } | null;   // 선택 모드 — 행 앞 체크박스
  menu?: (e: any) => Array<{ label: string; fn: () => void; danger?: boolean }>;   // ⋯ 메뉴 항목(없으면 열기·새 탭만)
}
// 한 행 — 프로젝트 행(.pjv-trow.pjv-proj-row)과 같은 높이·hover·제목 셀 문법. 제목 셀 = [체크] 틱 · 아이콘 · 제목 · 발췌.
export function wkTableRow(e: any, opts: WkRowOpts) {
  const isFolder = !!e.is_folder;
  const go = () => { if (opts.open) opts.open(e, row); else location.hash = '#/k/' + encodeURIComponent(e.name); };
  const title = el('span', { class: 'pjv-trow-title clickable wk-ttitle', title: e.title || e.name, text: e.title || e.name });
  title.onclick = (ev) => { ev.stopPropagation(); if (opts.select && !isFolder) { check && check.click(); return; } go(); };
  const snip = opts.deck || (e.snippet
    ? String(e.snippet).replace(/\(\+\d+ matches\)[^\n]*/g, '').replace(/L\d+:\s*/g, '').replace(/[\n⋯]+/g, ' · ').replace(/\s+/g, ' ').trim().slice(0, 180)
    : '');
  const ic = e.icon ? el('span', { class: 'wk-trow-emoji', 'aria-hidden': 'true', text: e.icon }) : (isFolder ? wkFolderIcon() : null);
  let check: any = null;
  if (opts.select && !isFolder) {
    check = el('input', { type: 'checkbox', class: 'wk-tcheck', 'aria-label': (e.title || e.name) + ' 선택' });
    check.checked = opts.select.names.has(e.name);
  }
  const titleCell = el('div', { class: 'pjv-trow-title-cell' },
    check ? el('label', { class: 'wk-tcheckwrap' }, check) : el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }),
    wkTick(e), ic, title,
    snip ? el('span', { class: 'wk-tsnip', title: snip, text: snip }) : null);
  titleCell.addEventListener('click', (ev) => {
    if ((ev.target as Element).closest('button, input, label, a, .pjv-trow-title')) return;
    if (check) { check.click(); return; }
    go();
  });
  const cells = opts.cols.map((c) => el('div', { class: 'pjv-tcell wk-tcell' + (c.align === 'left' ? ' wk-col-left' : ''), 'data-col': c.key }, c.render(e)));
  const more = el('button', { class: 'pjv-trow-more', type: 'button', title: '더보기', 'aria-label': '문서 작업', text: '⋯' });
  more.onclick = (ev) => {
    ev.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(more, menu, { align: 'right' });
    const mk = (label, fn, danger?) => { const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label })); b.onclick = () => { close(); fn(); }; return b; };
    menu.append(mk('열기', () => go()));
    if (!isFolder) menu.append(mk('새 탭에서 열기', () => window.open(location.pathname + '?ui=classic#/k/' + encodeURIComponent(e.name), '_blank')));
    for (const it of (opts.menu ? opts.menu(e) : [])) menu.append(mk(it.label, it.fn, it.danger));
  };
  const row = el('div', { class: 'pjv-trow pjv-proj-row wk-trow' + (isFolder ? ' folder' : '') + (e.lifecycle === 'archived' ? ' archived' : '') + (check && check.checked ? ' sel' : ''), 'data-author': e.confidence || '', 'data-prov': e.provenance || '' },
    titleCell, ...cells, el('div', { class: 'pjv-tcell pjv-tcell-add' }, more));
  row.style.gridTemplateColumns = wkTrack(opts.cols);
  if (check) {
    check.addEventListener('change', () => {
      if (check.checked) opts.select!.names.add(e.name); else opts.select!.names.delete(e.name);
      row.classList.toggle('sel', check.checked);
      opts.select!.onToggle();
    });
    check.parentElement.addEventListener('click', (ev) => ev.stopPropagation());
  }
  return el('div', { class: 'pjv-trow-wrap wk-trow-wrap', 'data-name': e.name }, row);
}

// 그룹 하나(프로젝트 표의 .pjv-tgroup) — 머리(캐럿·라벨·건수) + 컬럼 헤더 + 행들. 라벨이 없으면 머리 없이 표만.
export function wkTableGroup(label: string | null, entries: any[], opts: WkRowOpts & { count?: number; titleLabel?: string }) {
  const body = el('div', { class: 'pjv-tgroup-body wk-tbody' }, wkColHead(opts.cols, opts.titleLabel));
  for (const e of entries) body.append(wkTableRow(e, opts));
  if (!label) return el('div', { class: 'pjv-tgroup wk-tgroup' }, body);
  const caret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: '▾', 'aria-expanded': 'true', title: '접기' });
  const head = el('div', { class: 'pjv-tgroup-head wk-tgroup-head' },
    el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }), caret,
    el('span', { class: 'pjv-tgroup-label', text: label }),
    el('span', { class: 'pjv-tgroup-count', text: String(opts.count ?? entries.length) }));
  let open = true;
  const toggle = () => { open = !open; body.hidden = !open; caret.textContent = open ? '▾' : '▸'; caret.setAttribute('aria-expanded', String(open)); caret.title = open ? '접기' : '펼치기'; };
  caret.onclick = (ev) => { ev.stopPropagation(); toggle(); };
  head.onclick = () => toggle();
  return el('div', { class: 'pjv-tgroup wk-tgroup' }, head, body);
}

// ── 머리 3층 — 프로젝트 탭 .pjv-board-header 동형: ① 빵부스러기 ② 뷰 탭 ③ 툴바(좌: 거르기 / 우: 찾기·만들기). ──
export interface WkHeaderOpts {
  crumbs: Array<{ label: string; href?: string; icon?: any }>;   // 마지막이 잎(is-leaf)
  sub?: string;                                                   // 잎 옆 한 줄 설명
  tabs: Array<{ key: string; label: string; icon?: 'list' | 'table' | 'board' | 'timeline'; iconNode?: any; href?: string; active?: boolean; onClick?: () => void }>;
  left?: any[];
  right?: any[];
}
export function wkBoardHeader(o: WkHeaderOpts) {
  const nav = el('nav', { class: 'pjv-crumbs', 'aria-label': '현재 위치' });
  o.crumbs.forEach((c, i) => {
    if (i) nav.append(el('span', { class: 'pjv-crumb-sep', 'aria-hidden': 'true', text: '/' }));
    const leaf = i === o.crumbs.length - 1;
    const node = c.href && !leaf
      ? el('a', { class: 'pjv-crumb', href: c.href, title: c.label }, c.icon || null, el('span', { class: 'pjv-crumb-label', text: c.label }))
      : el('span', { class: 'pjv-crumb' + (leaf ? ' is-leaf wk-crumb-leaf' : ''), title: c.label }, c.icon || null, el('span', { class: 'pjv-crumb-label', text: c.label }));
    nav.append(node);
  });
  if (o.sub) nav.append(el('span', { class: 'wk-crumb-sub', text: o.sub }));
  const crumbBar = el('div', { class: 'pjv-crumbbar' }, nav);
  const tabs = el('div', { class: 'pjv-vtabs', role: 'tablist', 'aria-label': '뷰' });
  for (const t of o.tabs) {
    const b = el(t.href ? 'a' : 'button', { class: 'pjv-vtab' + (t.active ? ' active' : ''), role: 'tab', 'aria-selected': String(!!t.active), ...(t.href ? { href: t.href } : { type: 'button' }) },
      t.iconNode || pjvTabIcon(t.icon || 'list'), el('span', { text: t.label }));
    if (t.onClick) b.onclick = (ev) => { ev.preventDefault(); t.onClick!(); };
    tabs.append(b);
  }
  const hasTb = (o.left && o.left.length) || (o.right && o.right.length);
  const toolbar = hasTb ? el('div', { class: 'card-head pjv-board-toolbar' },
    el('div', { class: 'pjv-tasks-head-left' }, ...(o.left || [])),
    el('div', { class: 'card-head-actions' }, ...(o.right || []))) : null;   // 툴바에 실을 게 없으면 빈 줄을 남기지 않는다
  return el('div', { class: 'pjv-board-header wk-board-header' }, crumbBar, tabs, toolbar);
}
// 툴바 부품 — 아이콘 버튼(30px) · 알약(글자) · 분할 primary. 프로젝트 툴바와 같은 클래스.
export function wkTbIcon(cls: string, label: string, icon: any, fn: (b: HTMLElement) => void) {
  const b = el('button', { class: 'pjv-tb-btn ' + cls, type: 'button', title: label, 'aria-label': label }, icon);
  b.onclick = (ev) => { ev.stopPropagation(); fn(b); };
  return b;
}
export function wkTbPill(label: string, opts: { active?: boolean; title?: string; onClick?: (b: HTMLElement) => void; icon?: any } = {}) {
  const b = el('button', { class: 'pjv-tb-btn pjv-tb-pill wk-tb-pill' + (opts.active ? ' active' : ''), type: 'button', title: opts.title || label },
    opts.icon || null, el('span', { class: 'pjv-view-btn-label', text: label }));
  if (opts.onClick) b.onclick = (ev) => { ev.stopPropagation(); opts.onClick!(b); };
  return b;
}
export function wkTbPrimary(label: string, fn: () => void, more?: Array<{ label: string; fn: () => void }>) {
  const main = el('button', { class: 'pjv-tb-primary', type: 'button', title: label }, pjvTbIcon('plus', 'sm'), el('span', { text: label }));
  main.onclick = () => fn();
  const group = el('div', { class: 'pjv-tb-primary-group' }, main);
  if (more && more.length) {
    const mb = el('button', { class: 'pjv-tb-primary-more', type: 'button', title: '더 만들기', 'aria-label': '더보기' }, pjvTbIcon('caret', 'sm'));
    mb.onclick = (ev) => {
      ev.stopPropagation();
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(mb, menu, { align: 'right' });
      for (const it of more) { const b = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { text: it.label })); b.onclick = (e2) => { e2.stopPropagation(); close(); it.fn(); }; menu.append(b); }
    };
    group.append(mb);
  }
  return group;
}
// 툴바 검색 — 프로젝트 툴바의 돋보기 + 펼쳐지는 입력칸과 같은 껍데기.
export function wkTbSearch(value: string, placeholder: string, onCommit: (q: string) => void) {
  const input = el('input', { type: 'text', class: 'pjv-tb-search-input', placeholder, 'aria-label': placeholder, value }) as HTMLInputElement;
  const box = el('div', { class: 'pjv-tb-search' + (value ? ' open' : '') });
  const btn = wkTbIcon('pjv-search-btn' + (value ? ' active' : ''), '검색 — 제목·본문으로 좁혀 보기', pjvTbIcon('search'), () => { box.classList.toggle('open'); if (box.classList.contains('open')) input.focus(); else if (input.value) { input.value = ''; onCommit(''); } });
  let t: any = null;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => onCommit(input.value.trim()), 300); });
  input.addEventListener('keydown', (ev: any) => { if (ev.key === 'Enter') { clearTimeout(t); onCommit(input.value.trim()); } if (ev.key === 'Escape') { input.value = ''; box.classList.remove('open'); onCommit(''); } });
  box.append(btn, input);
  return box;
}
// 위키 표면 탭(#1841 안 4) — **최근**이 첫 화면이고 카테고리는 그 옆 한 탭이다.
//  왜 순서가 이런가: 위키를 여는 이유의 대부분은 "방금 뭐가 남았나"이고, "어디에 무엇이 있나"는 그 다음이다
//  (원준 2026-08-24 결정 — 최상단 분류를 카테고리에서 시간으로). 자리는 어느 목록 위에서도 바뀌지 않는다.
export function wkSurfaceTabs(active: 'recent' | 'cats' | 'docs' | 'sources' | 'review' | 'trash', reviewCount?: number) {
  const cur = active === 'docs' ? 'recent' : active;   // 'docs'(옛 호출부) = 최근
  return [
    { key: 'recent', label: '최근', icon: 'list' as const, href: '#/knowledge', active: cur === 'recent' },
    { key: 'cats', label: '카테고리', iconNode: pjvTbIcon('group', 'pjv-vtab-ic wk-vtab-ic'), href: '#/knowledge?cats=1', active: cur === 'cats' },
    { key: 'sources', label: '자료', icon: 'table' as const, href: '#/knowledge/sources', active: cur === 'sources' },
    { key: 'review', label: reviewCount ? '검토 대기 ' + reviewCount : '검토 대기', iconNode: pjvTbIcon('check', 'pjv-vtab-ic wk-vtab-ic'), href: '#/knowledge/review', active: cur === 'review' },
    { key: 'trash', label: '휴지통', iconNode: pjvTbIcon('trash', 'pjv-vtab-ic wk-vtab-ic'), href: '#/trash', active: cur === 'trash' },
  ];
}
