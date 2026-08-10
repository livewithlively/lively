// wiki-side.ts — WIKI 좌측 카테고리 사이드바(#764 재구축의 유일한 '유지' 표면 — knowledge.ts 에서 동작 그대로 이관).
//  사용자가 명시적으로 유지하라고 한 표면이라 마크업·클래스·동작을 바꾸지 않는다(검색·★내소유·space 그룹·트리 펼침·
//  도구 섹션·폭 리사이즈(--pjv-side-w, localStorage 'pjv:sideW' — 프로젝트 탭 공유)·접기).
//  콘텐츠와의 접점은 3개뿐: ① [data-cat-val] 클릭 위임(onSelect) ② 문서 열기(onOpen) ③ rebuild().
import { api, el, loadPeopleAvatars, state, sv } from './core.js';
import { reviewNavBadge } from './review.js';   // #837 검토 대기 배지(대기 0이면 안 그려진다)
import { isCategoryHomeDoc, KN_UNCAT, knApplyCatReorder, knCatOrderClear, knCatOrderSaved, knFetchAuthoredTree, knFetchCategoryIndex, knFetchUncategorizedCount, knFolderFirstSort, knPageIcon, knSortByCatOrder, SPACE_LABEL } from './wiki-data.js';

// WIKI 인덱스(#336) — '전체' 하위 '인덱스(핀)' 필터의 가짜 카테고리 센티넬. data-cat-val 위임에 실린다.
const KN_INDEXED = '__indexed__';

// ── 데이터 ──
// 3 space 카테고리를 한 번에 — {business, product, system}. 각 항목 graceful(실패=빈 배열).
async function fetchAllSpaceCats(): Promise<any> {
  const out: any = { business: [], product: [], system: [] };
  const lists = await Promise.all(['business', 'product', 'system'].map((sk) =>
    api('/api/ui/categories?' + new URLSearchParams({ space: sk })).then((d) => (d && d.categories) || []).catch(() => [])));
  ['business', 'product', 'system'].forEach((sk, i) => { out[sk] = lists[i]; });
  return out;
}

// 내 팀 카테고리 id 집합(state.me.team_category_ids) — 문자열 Set(catVal 비교용). 미로그인/미소속이면 빈 집합.
function myCatIdSet(): Set<string> {
  const ids = (state.me && (state.me as any).team_category_ids) || [];
  return new Set((ids as any[]).map((x) => String(x)));
}

// ── 행 컴포넌트(프로젝트 탭 .pjv-side-* 재사용 — 두 탭 통일) ──
function knTeamChip() {
  return el('span', { class: 'kn-cat-star', 'aria-hidden': 'true', title: '내 소유 카테고리', text: '★' });
}

function knSideItem(label, catVal, on, opts?) {
  const star = !!(opts && opts.star);
  const glyph = (opts && opts.glyph) || (catVal ? '·' : '∗');
  return el('a', { class: 'pjv-side-navitem kn-side-item' + (on ? ' active' : '') + (opts && opts.cls ? ' ' + opts.cls : ''),
    href: '#', 'data-cat-val': catVal, role: 'button', tabindex: '0',
    ...(opts && opts.title ? { title: opts.title } : {}) },
    el('span', { class: 'kn-side-glyph', 'aria-hidden': 'true', text: glyph }),
    star ? knTeamChip() : null,
    el('span', { class: 'pjv-side-navlabel', text: label }));
}

// space 섹션 컨테이너 — 프로젝트 탭 스페이스 행(색 아바타 + 볼드 라벨 + 우측 캐럿)과 동일 마크업.
const KN_SPACE_AVA_COLOR = { business: '#f59e0b', product: '#2D6BF0', system: '#8b5cf6' };
function knSpaceGroup(sk: string, countEl?: any) {
  const caret = el('span', { class: 'pjv-side-folder-caret kn-space-caret', 'aria-hidden': 'true', text: '▾' });
  const grp = el('details', { class: 'kn-space-group', open: '' },
    el('summary', { class: 'pjv-side-navitem pjv-side-navfolder pjv-side-navspace kn-space-head' },
      el('span', { class: 'pjv-side-space-avatar', text: String(SPACE_LABEL[sk] || sk).trim()[0], style: 'background:' + (KN_SPACE_AVA_COLOR[sk] || 'var(--muted-2)') }),
      el('span', { class: 'pjv-side-navlabel', text: SPACE_LABEL[sk] || sk }),
      countEl || null, caret));
  grp.addEventListener('toggle', () => { caret.textContent = (grp as any).open ? '▾' : '▸'; });
  return grp;
}

// ★ '내 소유 카테고리' 그룹(#1600) — 사업·제품·시스템과 **같은 마크업**으로 만든다.
//  종전엔 작은 회색 라벨(.pjv-side-favhead)이라 세 space 헤더보다 아래 위계로 읽혔다. 실제로는 그 반대다 —
//  매일 여기서 출발하니까. 같은 형태(아바타+볼드+카운트+캐럿)를 주면 위계가 동급이 되고, 맨 위에 놓이니 첫 자리가 된다.
function knOwnedGroup(countEl?: any) {
  const caret = el('span', { class: 'pjv-side-folder-caret kn-space-caret', 'aria-hidden': 'true', text: '▾' });
  const grp = el('details', { class: 'kn-space-group kn-owned-group', open: '' },
    el('summary', { class: 'pjv-side-navitem pjv-side-navfolder pjv-side-navspace kn-space-head kn-owned-head' },
      el('span', { class: 'pjv-side-space-avatar kn-owned-ava', title: '내가 담당하는 카테고리', text: '★' }),
      el('span', { class: 'pjv-side-navlabel', text: '내 소유 카테고리' }),
      countEl || null, caret));
  grp.addEventListener('toggle', () => { caret.textContent = (grp as any).open ? '▾' : '▸'; });
  return grp;
}

// ── 드래그 정렬(#1600) — 그룹 **안에서만** 순서를 바꾼다. ──
//  경계를 넘지 못하게 하는 이유: 카테고리의 space 는 분류 사실이지 사용자 취향이 아니다(사업 카테고리를 제품 밑으로
//  끌어다 놓을 수 있으면 그건 정렬이 아니라 오분류다). ★구역은 소유 여부로 정해지므로 역시 닫힌 집합이다.
//  삽입 위치는 행 위/아래 가로선으로 보여준다(.drop-before/.drop-after — CSS 가 색선을 그린다).
let knDragId: string | null = null;
let knDragGroup: string | null = null;
function knClearDropHints(nav: any) {
  nav.querySelectorAll('.kn-nav-catwrap.drop-before, .kn-nav-catwrap.drop-after')
    .forEach((n: any) => n.classList.remove('drop-before', 'drop-after'));
}
function knWireCatDrag(wrap: any, catId: string, group: string, nav: any, onReorder: (src: string, target: string, before: boolean) => void) {
  wrap.setAttribute('draggable', 'true');
  wrap.dataset.dragGroup = group;
  wrap.addEventListener('dragstart', (ev: any) => {
    knDragId = String(catId); knDragGroup = group;
    wrap.classList.add('drag-src');
    try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(catId)); } catch (_) { /* 일부 브라우저 — setData 없이도 진행 */ }
  });
  wrap.addEventListener('dragend', () => {
    knDragId = null; knDragGroup = null;
    wrap.classList.remove('drag-src');
    knClearDropHints(nav);
  });
  wrap.addEventListener('dragover', (ev: any) => {
    if (!knDragId || knDragGroup !== group || knDragId === String(catId)) return;   // 다른 그룹·자기 자신 — 받지 않는다
    ev.preventDefault();
    const r = wrap.getBoundingClientRect();
    const before = ev.clientY < r.top + r.height / 2;   // 세로 목록이라 Y 로 가른다(홈 카드는 X)
    wrap.classList.toggle('drop-before', before);
    wrap.classList.toggle('drop-after', !before);
  });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-before', 'drop-after'));
  wrap.addEventListener('drop', (ev: any) => {
    if (!knDragId || knDragGroup !== group || knDragId === String(catId)) return;
    ev.preventDefault();
    const before = wrap.classList.contains('drop-before');
    const src = knDragId;
    knDragId = null; knDragGroup = null;
    knClearDropHints(nav);
    onReorder(src, String(catId), before);
  });
  return wrap;
}

// ⭐ '내 소유 카테고리' 별 토글 — 프로젝트 탭 즐겨찾기와 동일 컴포넌트(.pjv-side-navfav), WIKI 는 파란색(.fav-blue).
function knFavStar(isFav: boolean, onToggle: (next: boolean) => void) {
  const btn = el('button', { class: 'pjv-side-navfav fav-blue' + (isFav ? ' on' : ''), type: 'button',
    title: isFav ? '내 소유 카테고리에서 제거' : '내 소유 카테고리로 표시', 'aria-label': isFav ? '내 소유 카테고리에서 제거' : '내 소유 카테고리로 표시',
    'aria-pressed': String(isFav), text: isFav ? '★' : '☆' });
  btn.addEventListener('click', (e: any) => { e.preventDefault(); e.stopPropagation(); onToggle(!isFav); });
  return btn;
}

// 카테고리 노드 — 행(▸ 셰브런 + 이름 + 지식 수, data-cat-val 위임) + 인라인 자식 목록(지연 로드 + 세션 캐시).
function knNavCatNode(c, on, onOpen, isMine?: boolean, favOpts?: any) {
  const tw = el('button', { class: 'kn-nav-tw', type: 'button', 'aria-expanded': 'false',
    title: '이 카테고리의 지식 펼치기', text: '▸' });
  const cnt = Number(c.knowledge_count);
  const favCatIds: Set<string> = (favOpts && favOpts.favCatIds) || new Set();
  const isFav = favCatIds.has(String(c.id));
  const row = el('a', { class: 'pjv-side-navitem kn-side-item kn-side-item-sub kn-nav-cat' + (on ? ' active' : '') + (isFav ? ' is-fav' : ''), href: '#',
    'data-cat-val': String(c.id), role: 'button', tabindex: '0',
    ...(c.hint ? { title: c.hint } : isMine ? { title: '내 소유 카테고리 — ' + (c.name || c.key) } : {}) },
    tw,
    isMine ? knTeamChip() : null,
    el('span', { class: 'pjv-side-navlabel', text: c.name || c.key }),
    Number.isFinite(cnt) ? el('span', { class: 'pjv-side-navcount' + (cnt === 0 ? ' kn-count-zero' : ''), title: '지식 ' + cnt + '개', text: String(cnt) }) : null);
  if (favOpts && favOpts.onToggleFav) row.append(knFavStar(isFav, (next: boolean) => favOpts.onToggleFav(String(c.id), next)));
  const kids = el('div', { class: 'kn-nav-kids' });
  kids.hidden = true;
  let opened = false, loaded = false;
  tw.addEventListener('click', async (ev) => {
    ev.preventDefault(); ev.stopPropagation();   // 행 클릭(카테고리 필터 위임)과 분리
    opened = !opened;
    kids.hidden = !opened;
    tw.textContent = opened ? '▾' : '▸';
    tw.setAttribute('aria-expanded', String(opened));
    if (!opened || loaded) return;
    kids.replaceChildren(el('div', { class: 'kn-nav-note', text: '불러오는 중…' }));
    try {
      const rows = await knFetchCategoryIndex(c.id);
      const names = new Set(rows.map((r) => r.name));
      const tops = rows.filter((r) => !(r.parent_name && names.has(r.parent_name)))
        .filter((r) => !isCategoryHomeDoc(r.name))   // 대문 문서 숨김
        .slice().sort(knFolderFirstSort);
      const childN = new Map();
      for (const r of rows) if (r.parent_name) childN.set(r.parent_name, (childN.get(r.parent_name) || 0) + 1);
      loaded = true;
      if (!tops.length) { kids.replaceChildren(el('div', { class: 'kn-nav-note', text: '지식 없음' })); return; }
      kids.replaceChildren(...tops.map((r) => knNavDocNode(r, 1, onOpen, childN)));
    } catch (_) {
      kids.replaceChildren(el('div', { class: 'kn-nav-note', text: '불러오기 실패' }));
    }
  });
  return el('div', { class: 'kn-nav-catwrap' }, row, kids);
}

// 트리 안 지식 노드 — 문서는 클릭=onOpen, 폴더는 ▸/행 클릭=authored 트리 자식 펼침(재귀, 지연 로드).
function knNavDocNode(r, depth, onOpen, childN?: Map<string, number>) {
  const pad = 8 + depth * 14;
  if (!r.is_folder) {
    // #783 pending(검토 대기) — 트리엔 보이지만 검색·주입엔 없는 상태라, 배지 없이 두면 '승인된 지식'으로 오인된다.
    const pending = r.lifecycle === 'pending';
    const row = el('a', { class: 'tree-item kn-nav-doc' + (r.lifecycle === 'archived' ? ' kn-tree-archived' : '') + (pending ? ' kn-tree-pending' : ''),
      href: '#/k/' + encodeURIComponent(r.name), style: 'padding-left:' + pad + 'px',
      title: (r.title || r.name) + (pending ? ' — 검토 대기(승인 전, 검색·주입 제외)' : '') },
      el('span', { class: 'tree-glyph kn-nav-glyph', 'aria-hidden': 'true', text: knPageIcon(r) }),
      el('span', { class: 'tree-label', text: r.title || r.name }),
      pending ? el('span', { class: 'kn-nav-count kn-nav-review', title: '검토 대기 — 승인해야 검색·주입에 반영됩니다', text: '검토' }) : null);
    row.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); onOpen(r.name); });
    return row;
  }
  const tw = el('button', { class: 'kn-nav-tw', type: 'button', 'aria-expanded': 'false', title: '폴더 펼치기', text: '▸' });
  const folderCnt = childN ? (childN.get(r.name) || 0) : null;
  const row = el('div', { class: 'tree-item kn-nav-doc kn-nav-folder', role: 'button', tabindex: '0',
    style: 'padding-left:' + Math.max(4, pad - 16) + 'px', title: r.title || r.name },
    tw, el('span', { class: 'tree-glyph kn-nav-glyph', 'aria-hidden': 'true', text: knPageIcon(r) }),
    el('span', { class: 'tree-label', text: r.title || r.name }),
    folderCnt != null ? el('span', { class: 'kn-nav-count' + (folderCnt === 0 ? ' zero' : ''), title: '항목 ' + folderCnt + '개', text: String(folderCnt) }) : null);
  const kids = el('div', { class: 'kn-nav-kids' });
  kids.hidden = true;
  let opened = false, loaded = false;
  const toggle = async (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    opened = !opened;
    kids.hidden = !opened;
    tw.textContent = opened ? '▾' : '▸';
    tw.setAttribute('aria-expanded', String(opened));
    if (!opened || loaded) return;
    kids.replaceChildren(el('div', { class: 'kn-nav-note', text: '불러오는 중…' }));
    try {
      const sub = (await knFetchAuthoredTree()).filter((t) => t.parent_name === r.name).slice().sort(knFolderFirstSort);
      loaded = true;
      if (!sub.length) { kids.replaceChildren(el('div', { class: 'kn-nav-note', style: 'padding-left:' + (pad + 14) + 'px', text: '비어 있음' })); return; }
      kids.replaceChildren(...sub.map((t) => knNavDocNode(t, depth + 1, onOpen, childN)));
    } catch (_) {
      kids.replaceChildren(el('div', { class: 'kn-nav-note', text: '불러오기 실패' }));
    }
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') toggle(ev); });
  return el('div', {}, row, kids);
}

// nav 채우기(#1600 순서) — ★내 소유 → 가로구분선 → 전체·인덱스 → space별 접이식 → 미분류.
//  ★가 맨 위인 이유: 사람이 매일 출발하는 자리이기 때문이다. '전체'는 훑을 때만 쓰는 도구라 그 아래가 맞다.
//  각 그룹 안에서는 사용자가 끌어서 순서를 정할 수 있고(knWireCatDrag), 그 순서는 홈 카드와 공유된다.
function buildKnowledgeNav(nav, bySpace, selected, myIds: Set<string>, opts) {
  const onOpen = (opts && opts.onOpen) || ((name) => { location.hash = '#/k/' + encodeURIComponent(name); });
  const favCatIds: Set<string> = (opts && opts.favCatIds) || new Set();
  const onToggleFav = (opts && opts.onToggleFav) || (() => {});
  const onReorder = (opts && opts.onReorder) || (() => {});
  (nav as any)._knOnOpen = onOpen;   // 사이드바 검색(knSideFilterNav)의 문서 결과 행이 같은 열기 경로를 쓰도록
  nav.replaceChildren();
  nav.classList.add('kn-tree2');
  const ownedIds = new Set<string>([...favCatIds, ...Array.from(myIds)]);
  const favOpts = { favCatIds: ownedIds, onToggleFav };
  const allCats = ['business', 'product', 'system'].flatMap((sk) => bySpace[sk] || []);
  //  드래그로 순서가 바뀌면 전역 순서를 저장하고 호출부가 사이드바를 다시 그린다(홈 카드도 같은 키를 읽는다).
  const reorder = (src: string, target: string, before: boolean) => {
    if (knApplyCatReorder(allCats, src, target, before)) onReorder();
  };
  const catNode = (c: any, group: string) => knWireCatDrag(
    knNavCatNode(c, String(selected) === String(c.id), onOpen, false, favOpts),
    String(c.id), group, nav, reorder);

  // ① ★ 내 소유 카테고리 — 첫 자리, space 와 동급 위계.
  const favCats = knSortByCatOrder(allCats.filter((c) => ownedIds.has(String(c.id))));
  if (favCats.length) {
    const ownedTotal = favCats.reduce((n, c) => n + (Number(c.knowledge_count) || 0), 0);
    const grp = knOwnedGroup(el('span', { class: 'pjv-side-navcount', title: '내 소유 카테고리의 지식 수', text: String(ownedTotal) }));
    //  되돌리기 — 직접 정렬한 사람만 본다(순서를 바꾼 적 없으면 버튼 자체가 없다).
    //  summary 안이라 클릭이 접힘 토글로 새지 않게 막는다.
    if (knCatOrderSaved().length) {
      const undo = el('button', { class: 'kn-order-reset', type: 'button', title: '드래그로 바꾼 카테고리 순서를 기본으로 되돌립니다', 'aria-label': '카테고리 순서 초기화', text: '↺' });
      undo.addEventListener('click', (ev: any) => { ev.preventDefault(); ev.stopPropagation(); knCatOrderClear(); onReorder(); });
      (grp.firstChild as any).insertBefore(undo, (grp.firstChild as any).lastChild);
    }
    for (const c of favCats) grp.append(catNode(c, 'mine'));
    nav.append(grp);
    nav.append(el('div', { class: 'pjv-side-favsep kn-owned-sep', 'aria-hidden': 'true' }));
  }

  // ② 전체 · 인덱스 — 카테고리 축을 벗어나 훑는 두 도구.
  nav.append(knSideItem('전체', '', !selected || selected === ''));
  if (opts && opts.indexed) {
    nav.append(knSideItem('인덱스', KN_INDEXED, selected === KN_INDEXED,
      { glyph: '📌', cls: 'kn-side-item-sub', title: '인덱스(핀)된 지식만 — 전체 카테고리에서 매 대화 첫머리에 깔리는 항목' }));
  }

  // ③ 사업 · 제품 · 시스템
  for (const sk of ['business', 'product', 'system']) {
    const cats = knSortByCatOrder(bySpace[sk] || []);
    if (!cats.length) continue;
    const hasCounts = cats.some((c) => Number.isFinite(Number(c.knowledge_count)));
    const total = cats.reduce((n, c) => n + (Number(c.knowledge_count) || 0), 0);
    const grp = knSpaceGroup(sk, hasCounts ? el('span', { class: 'pjv-side-navcount', title: '이 스페이스의 지식 수', text: String(total) }) : null);
    for (const c of cats) grp.append(catNode(c, sk));
    nav.append(grp);
  }
  // 미분류(#1091) — 어느 카테고리에도 안 걸린 지식. 트리 맨 아래(프로젝트 탭 '기타 (미분류)'와 같은 자리).
  //  카테고리 노드와 **같은 모양**(.kn-nav-catwrap + [data-cat-val])이라 사이드바 검색(knSideFilterNav)이
  //  분기 없이 그대로 훑는다 — 예전엔 이 노드가 없어서 미분류 지식이 검색에 영영 안 잡혔다.
  //  0건이면 안 그린다(= '분류가 다 됐다'는 뜻이라 빈 줄을 낭비하지 않는다).
  const uncat = Number(opts && opts.uncatCount) || 0;
  if (uncat > 0) {
    nav.append(knNavCatNode({ id: KN_UNCAT, name: '미분류', knowledge_count: uncat,
      hint: '카테고리가 없는 지식 — 소환(recall)에 안 잡히니 문서를 열어 분류해 주세요' },
    String(selected) === KN_UNCAT, onOpen));
  }
}

// ── 사이드바 분류 검색 — 카테고리 이름 즉시 필터 + 문서 제목 매칭 결과 행(카테고리당 캡 8). ──
let knSideFilterSeq = 0;
async function knSideFilterNav(nav: any, q: string) {
  const query = String(q || '').trim().toLowerCase();
  const seq = ++knSideFilterSeq;
  const wraps = Array.from(nav.querySelectorAll('.kn-nav-catwrap')) as any[];
  nav.querySelectorAll('.kn-side-hits').forEach((n: any) => n.remove());
  const applyGroups = () => {
    nav.querySelectorAll('.kn-space-group').forEach((g: any) => {
      g.hidden = !!query && !Array.from(g.querySelectorAll('.kn-nav-catwrap')).some((w: any) => !w.hidden);
    });
    const anyVis = !query || wraps.some((w) => !w.hidden);
    const note = nav.querySelector('.kn-side-noresult');
    if (query && !anyVis) { if (!note) nav.append(el('div', { class: 'kn-side-noresult kn-nav-note', text: '일치하는 카테고리·지식이 없습니다' })); }
    else if (note) note.remove();
  };
  if (!query) { wraps.forEach((w) => { w.hidden = false; }); applyGroups(); return; }
  wraps.forEach((w) => {
    const nm = (w.querySelector('.pjv-side-navlabel')?.textContent || '').toLowerCase();
    w.hidden = !nm.includes(query);
  });
  applyGroups();
  const onOpen = (nav as any)._knOnOpen || ((name) => { location.hash = '#/k/' + encodeURIComponent(name); });
  await Promise.all(wraps.map(async (w) => {
    const catId = (w.querySelector('[data-cat-val]') as any)?.dataset?.catVal;
    if (!catId) return;
    let rows: any[] = [];
    try { rows = await knFetchCategoryIndex(catId); } catch { return; }
    if (seq !== knSideFilterSeq) return;   // 그 사이 검색어가 바뀜 — 이 결과는 폐기
    const hits = rows.filter((r) => !r.is_folder && !isCategoryHomeDoc(r.name)
      && (String(r.title || '').toLowerCase().includes(query) || String(r.name || '').toLowerCase().includes(query)));
    if (!hits.length) return;
    w.hidden = false;
    const box = el('div', { class: 'kn-side-hits' });
    const CAP = 8;
    for (const r of hits.slice(0, CAP)) {
      const it = el('a', { class: 'pjv-side-navitem kn-side-hitdoc' + (r.lifecycle === 'archived' ? ' kn-tree-archived' : ''),
        href: '#/k/' + encodeURIComponent(r.name), title: r.title || r.name },
        el('span', { class: 'kn-side-glyph', 'aria-hidden': 'true', text: '📄' }),
        el('span', { class: 'pjv-side-navlabel', text: r.title || r.name }));
      it.addEventListener('click', (ev: any) => { ev.preventDefault(); ev.stopPropagation(); onOpen(r.name); });
      box.append(it);
    }
    if (hits.length > CAP) box.append(el('div', { class: 'kn-side-hitmore', text: '＋' + (hits.length - CAP) + '개 더 — 카테고리를 눌러 보기' }));
    w.append(box);
    applyGroups();
  }));
}

function knSideSearchIcon() {
  const n = sv('svg', { class: 'pjv-side-search-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 11, cy: 11, r: 6.5 }), sv('path', { d: 'M20 20l-3.6-3.6' }));
  return n;
}
function knMakeSideSearch(nav: any, st: any) {
  const input = el('input', { class: 'pjv-side-search-input', type: 'text', placeholder: '카테고리·지식 검색', 'aria-label': '카테고리·지식 검색', value: st.q || '' }) as HTMLInputElement;
  const clear = el('button', { class: 'pjv-side-search-clear', type: 'button', title: '지우기', 'aria-label': '검색어 지우기', text: '×' });
  const box = el('div', { class: 'pjv-side-search' + (st.q ? ' has-q' : '') }, knSideSearchIcon(), input, clear);
  input.addEventListener('input', () => { st.q = input.value; box.classList.toggle('has-q', !!String(st.q).trim()); knSideFilterNav(nav, st.q); });
  input.addEventListener('keydown', (e: any) => { if (e.key === 'Escape') { st.q = ''; input.value = ''; box.classList.remove('has-q'); knSideFilterNav(nav, ''); } });
  clear.addEventListener('click', () => { st.q = ''; input.value = ''; box.classList.remove('has-q'); knSideFilterNav(nav, ''); input.focus(); });
  return box;
}

// ── 도구 섹션(목록 셸 전용) — 지식 그래프·자료·휴지통 ──
function openKnowledgeAtlas() {
  let url = 'graph.html';
  try { url = new URL('graph.html', location.href).href; } catch (_) { /* 상대경로 폴백 */ }
  const w = window.open(url, 'lively-knowledge-atlas');
  if (w) try { w.focus(); } catch (_) { /* noop */ }
}
function knSideTools() {
  const graphBtn = el('button', { class: 'btn btn-ghost btn-sm kn-graph-btn kn-side-toolitem', type: 'button', role: 'link',
    title: '도메인으로 묶은 지식 지도 — 풀스크린 새 창에서 팬·줌으로 탐색', onclick: openKnowledgeAtlas },
    sv('svg', { class: 'sub-graph-ic', viewBox: '0 0 24 24', width: '14', height: '14', 'aria-hidden': 'true' },
      sv('circle', { cx: '6', cy: '7', r: '2.4', fill: 'currentColor' }),
      sv('circle', { cx: '17', cy: '6', r: '2', fill: 'currentColor', opacity: '0.7' }),
      sv('circle', { cx: '13', cy: '17', r: '2.2', fill: 'currentColor', opacity: '0.85' }),
      sv('path', { d: 'M7.8 8.2 11.4 15.4M15.2 7.3 13.7 14.9', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', opacity: '0.5' })),
    ' 지식 그래프');
  const sourcesBtn = el('a', { class: 'btn btn-ghost btn-sm kn-sources-link kn-side-toolitem', href: '#/knowledge/sources',
    title: '회의록·이메일·슬랙 등 정제 전 원본 자료 — 지식과 분리된 보조 입력', text: '🗂 자료' });
  // 검토 대기(#837) — 인입 게이트에 걸린 지식·수정 제안. 구 [관리 ▸ 검토 큐]가 여기로 왔다: 승인 권한이
  //  워킹레벨(memory)인데 관리탭에 있어 정작 검토할 사람이 못 보고 방치됐다. 배지는 대기가 0보다 클 때만 뜬다.
  const reviewBtn = el('a', { class: 'kn-side-toolitem', href: '#/knowledge/review',
    title: '자동 인입 게이트에 걸린 지식·수정 제안 — 승인하거나 반려합니다', text: '📥 검토 대기' }, reviewNavBadge());
  const trashBtn = el('a', { class: 'kn-side-toolitem', href: '#/trash', title: '삭제한 지식·카테고리 복원', text: '🗑 휴지통' });
  return el('div', { class: 'kn-side-tools' },
    el('div', { class: 'eyebrow kn-side-tools-eyebrow', text: '도구' }),
    graphBtn, sourcesBtn, reviewBtn, trashBtn);
}

// ── 폭 조절(프로젝트 탭과 동일 UX·같은 localStorage 'pjv:sideW' 공유) ──
function knSideResizeHandle(shell: HTMLElement) {
  const h = el('div', { class: 'kn-side-resize', title: '드래그하여 사이드바 너비 조절 (더블클릭: 기본값)', 'aria-hidden': 'true' });
  h.addEventListener('mousedown', (e: any) => {
    e.preventDefault(); e.stopPropagation();
    const side = shell.querySelector('.kn-side') as HTMLElement | null;
    const startX = e.clientX;
    const startW = (side && side.getBoundingClientRect().width) || 240;
    document.body.classList.add('pjv-side-resizing');
    const onUp = () => {
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); window.removeEventListener('blur', onUp);
      document.body.classList.remove('pjv-side-resizing');
      const cur = shell.style.getPropertyValue('--pjv-side-w');
      if (cur) { try { localStorage.setItem('pjv:sideW', cur.trim()); } catch (_) { /* noop */ } }
    };
    const onMove = (ev: any) => {
      if (ev.buttons === 0) { onUp(); return; }
      let w = startW + (ev.clientX - startX); w = Math.max(150, Math.min(440, w)); shell.style.setProperty('--pjv-side-w', Math.round(w) + 'px');
    };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); window.addEventListener('blur', onUp);
  });
  h.addEventListener('dblclick', (e: any) => {
    e.preventDefault(); e.stopPropagation();
    shell.style.removeProperty('--pjv-side-w');
    try { localStorage.removeItem('pjv:sideW'); } catch (_) { /* noop */ }
  });
  return h;
}
function knApplySideW(shell: HTMLElement) {
  try { const sw = localStorage.getItem('pjv:sideW'); if (sw) shell.style.setProperty('--pjv-side-w', sw.indexOf('px') >= 0 ? sw : sw + 'px'); } catch (_) { /* noop */ }
}

// ════════════════════════════════════════════
// createWikiSide — 사이드바 팩토리(콘텐츠 접점 3개를 opts 로 주입).
//  opts: { selected: () => string      현재 선택 catVal(''=전체, KN_INDEXED, KN_UNCAT, 카테고리 id)
//          onSelect: (catVal) => void  카테고리/전체/인덱스/미분류 클릭
//          onOpen: (name) => void      트리·검색결과의 문서 클릭(미전달 = #/k 이동)
//          tools?: boolean             도구 섹션(그래프·자료·휴지통 — 목록 셸 전용)
//          uncategorized?: boolean     '미분류' 노드(#1091) — 카테고리 축으로 지식을 훑는 셸(WIKI 목록·문서)만 켠다.
//                                       카테고리 축이 아닌 화면(검증 보드 등)에서는 끈다.
//          collapsible?: boolean       접기 버튼(문서 셸 전용 — localStorage 'kn-doc-side-collapsed') }
//  반환: { side, reopenBtn, ready, rebuild, findCat, bySpace }
// ════════════════════════════════════════════
const KN_SIDE_COLLAPSE_KEY = 'kn-doc-side-collapsed';
function createWikiSide(opts: any) {
  const side = el('aside', { class: 'kn-side' });
  const nav = el('nav', { class: 'browse-tree', 'aria-label': '카테고리' });
  const sideState = { q: '' };
  const myIds = myCatIdSet();
  let bySpace: any = { business: [], product: [], system: [] };
  let uncatCount = 0;   // 미분류 지식 수(#1091) — 0 이면 '미분류' 노드를 안 그린다
  const favCatIds = new Set<string>();

  const toggleCatFav = async (id: string, next: boolean) => {
    if (next) favCatIds.add(String(id)); else favCatIds.delete(String(id));
    buildSide();
    try { await api('/api/ui/v6/favorites', { method: 'POST', body: JSON.stringify({ kind: 'category', id: Number(id), on: next }) }); }
    catch (_) { if (next) favCatIds.delete(String(id)); else favCatIds.add(String(id)); buildSide(); }
  };

  // 접기(문서 셸) — 목록 셸은 버튼 미노출(현행 동작 유지).
  let collapseBtn: any = null;
  const reopenBtn = opts.collapsible ? el('button', { class: 'kn-side-reopen', type: 'button',
    title: '사이드바 펼치기', 'aria-label': '사이드바 펼치기', text: '⟩' }) : null;
  if (opts.collapsible) {
    collapseBtn = el('button', { class: 'kn-side-collapse', type: 'button',
      title: '사이드바 접기', 'aria-label': '사이드바 접기', text: '⟨' });
  }

  function buildSide() {
    buildKnowledgeNav(nav, bySpace, opts.selected ? opts.selected() : '', myIds,
      { indexed: true, onOpen: opts.onOpen, favCatIds, onToggleFav: toggleCatFav, uncatCount, onReorder: buildSide });
    side.replaceChildren(...[
      el('div', { class: 'pjv-side-nav-head' }, el('span', { class: 'pjv-side-nav-head-label', text: '지식 카테고리' }), collapseBtn),
      knMakeSideSearch(nav, sideState), nav,
      opts.tools ? knSideTools() : null,
    ].filter(Boolean));   // replaceChildren 은 null 을 'null' 텍스트로 찍는다 — 필터 필수
    knSideFilterNav(nav, sideState.q);   // 재빌드 후에도 필터 유지
  }

  // 클릭 위임 — buildSide 가 내부를 교체해도 side 의 핸들러는 유지.
  side.addEventListener('click', (ev: any) => {
    const item = ev.target.closest('[data-cat-val]');
    if (!item) return;
    ev.preventDefault();
    opts.onSelect(item.dataset.catVal || '');
  });

  const ready = (async () => {
    // 사람 맵(#1600) — 목록 메타의 '누가 만들었나'를 첫 렌더부터 이름으로 쓰려면 먼저 와 있어야 한다
    //  (personName 은 동기 조회라 self-heal 하지 않는다). 실패해도 id 로 폴백되니 화면은 계속 그린다.
    const peopleP = loadPeopleAvatars().catch(() => null);
    try { bySpace = await fetchAllSpaceCats(); } catch (_) { /* graceful: 사이드바 생략(콘텐츠는 계속) */ }
    await peopleP;
    if (opts.uncategorized) {
      try { uncatCount = await knFetchUncategorizedCount(); } catch (_) { /* graceful: '미분류' 노드만 생략 */ }
    }
    try { const fd = await api('/api/ui/v6/favorites'); for (const id of ((fd && fd.categories) || [])) favCatIds.add(String(id)); } catch (_) { /* 비로그인/실패 */ }
    buildSide();
  })();

  function findCat(id: any) {
    if (!id) return null;
    for (const sk of ['business', 'product', 'system']) {
      const c = (bySpace[sk] || []).find((x) => String(x.id) === String(id));
      if (c) return c;
    }
    return null;
  }

  // ★내 소유 중 맨 위 카테고리 id(#1600) — 위키 첫 진입의 기본 화면. 소유가 없으면 '' (홈으로 폴백).
  //  사용자가 사이드바에서 끌어 정한 순서를 그대로 따른다 — '맨 위'는 그 사람이 정한 맨 위여야 한다.
  function ownedFirst(): string {
    const allCats = ['business', 'product', 'system'].flatMap((sk) => bySpace[sk] || []);
    const owned = new Set<string>([...favCatIds, ...Array.from(myIds)]);
    const list = knSortByCatOrder(allCats.filter((c: any) => owned.has(String(c.id))));
    return list.length ? String(list[0].id) : '';
  }

  return { side, reopenBtn, collapseBtn, ready, rebuild: buildSide, findCat, ownedFirst, bySpace: () => bySpace };
}

// 문서 셸의 접기 상태 배선 — shell(.kn-shell)에 side-off 클래스 + localStorage. 기본: 저장값 없으면 ≤820px 접힘.
function wireSideCollapse(shell: HTMLElement, sideCtl: any) {
  if (!sideCtl.collapseBtn || !sideCtl.reopenBtn) return;
  let collapsed = false;
  try {
    const stored = localStorage.getItem(KN_SIDE_COLLAPSE_KEY);
    collapsed = stored != null ? stored === '1' : matchMedia('(max-width: 820px)').matches;
  } catch (_) { /* 프라이빗 모드 등 — 기본 펼침 */ }
  shell.classList.toggle('side-off', collapsed);
  const setSide = (off) => {
    shell.classList.toggle('side-off', off);
    try { localStorage.setItem(KN_SIDE_COLLAPSE_KEY, off ? '1' : '0'); } catch (_) { /* noop */ }
  };
  sideCtl.collapseBtn.onclick = () => setSide(true);
  sideCtl.reopenBtn.onclick = () => setSide(false);
}

export {
  KN_INDEXED,
  createWikiSide,
  fetchAllSpaceCats,
  knApplySideW,
  knSideResizeHandle,
  myCatIdSet,
  wireSideCollapse,
};
