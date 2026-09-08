// wiki.ts — WIKI 탭 진입점(라우터 대면). "위키에는 페이지와, 페이지를 찾는 팝업뿐이다."
//  ⚠ 셸(#1841, 2026-08-24) — **좌측 위키 사이드바를 걷었다.** 셸 사이드바(프로젝트·세션) 옆에 같은 폭의 세로 목록이
//   하나 더 서던 이중 내비가 어색하다는 지적(원준). 카테고리 트리가 하던 일은 ① 첫 화면(최근)의 행 칩 ② 「카테고리」 탭이 맡는다.
//   콘텐츠 한 장 = 최근(wiki-front) / 카테고리 표(wiki-front) / 카테고리 서고(wiki-category) / 필터 목록(이 파일) / 휴지통 / 자료.
//   문서(#/k)·드래프트는 wiki-doc. 옛 홈(오로라 카드 격자 — wiki-home)은 이 경로에서 더 쓰지 않는다.
//  URL 계약(구 딥링크 호환): #/knowledge?cats=1&category=N&folder=&type=&q=&indexed=1&all=1&peek=<name>
//  (?tab= 은 #657 대문/문서 탭의 잔재 — 파싱 시 무시한다. 탭이라는 모드 자체를 폐지했다.)
import { api, busy, el, errorNote, relTime, state, toast } from './core.js';
import { skeleton, skeletonRows } from './learn.js';
import { KN_TYPE_LABEL, KN_UNCAT, isCategoryHomeDoc, knInvalidateTreeCaches } from './wiki-data.js';
import { KN_INDEXED } from './wiki-side.js';
import { knFindCatIn, knLoadCats, renderCatsSurface, renderRecentSurface } from './wiki-front.js';   // #1841 안 4 — 첫 화면 = 최근(시간순) + 조건부 [검토할 것] / 카테고리는 탭 하나
import { wkDayLabel, wkEmpty } from './wiki-ui.js';
import { wkBoardHeader, wkDocCols, wkSurfaceTabs, wkTableGroup, wkTbPill, wkTbPrimary, wkTbSearch } from './wiki-table.js';   // #1841 프로젝트 표 문법
import { openWikiPeek, reanchorWikiPeek, renderWikiDraft, setWikiPeekList } from './wiki-doc.js';
import { renderCategorySurface } from './wiki-category.js';
import { reviewQueuePanel } from './review.js';   // #837 검토 큐 — 관리탭에서 이관(지식의 대기열이니 집은 WIKI)
import { renderClassificationReview } from './classifications.js';   // #1102 분류 검토 대기 — 분류기 제안 확정/재분류/반려

// ── 라우터 진입 — sub ∈ { ''|new|pinned|sources|review|기타(구 URL — 무시) } ──
async function renderWiki(view, sub, params) {
  if (sub === 'new') return renderWikiDraft(view, params);
  if (sub === 'pinned') { location.replace('#/knowledge?indexed=1'); return; }   // 구 링크 보존
  if (sub === 'sources') return renderSources(view, params);
  if (sub === 'review') return renderReviewQueue(view);   // #837 검토 대기 — 구 #/system/review-queue
  if (sub === 'classifications') return renderClassificationReview(view);   // #1102 분류 검토 대기(분류기 제안 검토)
  return renderWikiSpace(view, params);
}

// ── 검토 대기(#837) — 인입 게이트에 걸린 지식·수정 제안을 승인/반려한다. 구 [관리 ▸ 검토 큐].
//  '자료'(renderSources)와 같은 셸(wk-plainpad)을 쓴다 — 둘 다 위키의 보조 표면이다.
//  권한은 memory scope(워킹레벨 개방 — #638: "카테고리 전문성 있는 워킹레벨이 오너보다 잘 검토한다").
//  없으면 패널 안에서 서버가 403 을 돌려주고 그대로 안내된다.
async function renderReviewQueue(view) {
  const host = el('div', {});
  // #1841 — 보조 표면도 같은 머리 3층(빵부스러기 · 문서/자료/검토 대기/휴지통 탭 · 툴바). 패널 자체(행·승인·diff)는 그대로.
  const header = wkBoardHeader({ crumbs: [{ label: 'WIKI', href: '#/knowledge' }, { label: '검토 대기' }], sub: '인입 게이트에 걸린 지식·수정 제안을 승인·반려합니다', tabs: wkSurfaceTabs('review'), left: [], right: [] });
  view.replaceChildren(el('div', { class: 'wk-plainpad wk-board-pad' }, el('div', { class: 'card pjv-listboard wk-board' }, header, el('div', { class: 'wk-board-body' }, host))));
  await reviewQueuePanel(host);
}

// ── WIKI 셸 — 사이드바 + 콘텐츠 한 장. 상태 f 는 세션 전역(state.wiki). ──
async function renderWikiSpace(view, params) {
  const f = (state as any).wiki = (state as any).wiki || { category: '', folder: '', type: '', q: '', indexed: false, all: false, cats: false };
  // 파라미터 없는 진입 = 상단 WIKI 탭 클릭 등 '맨 진입' — 홈으로 리셋(이전 카테고리가 복원되면 놀란다).
  if (!params || Array.from(params.keys()).length === 0) {
    f.category = ''; f.folder = ''; f.type = ''; f.q = ''; f.indexed = false; f.all = false; f.cats = false;
  }
  if (params) {
    // category 딥링크는 폴더 드릴다운을 리셋 — 세션 잔존 f.folder 가 다른 카테고리로 새면
    //  '폴더가 비어 있어요' 빈 화면이 뜬다. ?category=..&folder=.. 조합은 아래 folder 절이 다시 채운다.
    if (params.has('cats')) { f.cats = params.get('cats') === '1'; if (f.cats) { f.category = ''; f.folder = ''; f.indexed = false; f.all = false; f.q = ''; } }
    if (params.has('category')) { f.category = params.get('category') || ''; f.indexed = false; f.all = false; f.folder = ''; f.cats = false; }
    if (params.has('folder')) f.folder = params.get('folder') || '';
    if (params.has('type')) f.type = params.get('type') || '';
    if (params.has('q')) f.q = params.get('q') || '';
    if (params.has('indexed')) { f.indexed = params.get('indexed') === '1'; if (f.indexed) { f.category = ''; f.folder = ''; f.all = false; } }
    if (params.has('all')) { f.all = params.get('all') === '1'; if (f.all) { f.category = ''; f.folder = ''; f.indexed = false; } }
  }
  if (!f.category) f.folder = '';   // 폴더는 카테고리 컨텍스트에서만

  view.replaceChildren(el('div', { class: 'wk-plainpad' }, skeleton('위키를 여는 중')));

  // URL 동기화 — replaceState(피크 파라미터는 승계). 피크 기준 해시 재앵커.
  function syncHash() {
    const p = new URLSearchParams();
    if (f.cats) p.set('cats', '1');
    else if (f.indexed) p.set('indexed', '1');
    else if (f.all) p.set('all', '1');
    else if (f.category) p.set('category', f.category);
    if (f.folder) p.set('folder', f.folder);
    if (f.type) p.set('type', f.type);
    if (f.q) p.set('q', f.q);
    const curQ = location.hash.indexOf('?');
    const peek = curQ >= 0 ? new URLSearchParams(location.hash.slice(curQ + 1)).get('peek') : null;
    if (peek) p.set('peek', peek);
    const qs = p.toString();
    history.replaceState(null, '', '#/knowledge' + (qs ? '?' + qs : ''));
    reanchorWikiPeek();
  }

  const main = el('section', { class: 'wk-main' });
  // 카테고리 목록은 화면이 직접 읽는다(사이드바가 없어졌다) — 세션 캐시 1콜, 카테고리 서고·행 칩이 같은 벌을 본다.
  let cats: any[] = [];
  const ctx = {
    f,
    syncHash,
    repaint,
    selectCategory,
    onCatChanged: () => { void knLoadCats(true).then((b) => { cats = b; }); },
    cats: () => cats,
    findCat: (v: string) => knFindCatIn(cats, v),
  };

  function selectCategory(v: string) {
    if (v === KN_INDEXED) { f.indexed = true; f.category = ''; }
    else { f.indexed = false; f.category = v || ''; }
    f.folder = ''; f.type = ''; f.q = ''; f.all = false; f.cats = false;
    syncHash();
    repaint();
  }

  // repaint 는 매번 새 surface 박스를 깐다 — 연타로 비동기 렌더가 겹쳐도 늦게 끝난 이전 렌더는
  //  자기(분리된) 박스에 그릴 뿐 최신 화면을 덮지 못한다.
  function repaint() {
    const box = el('div', { class: 'wk-surface' });
    main.replaceChildren(box);
    if (f.cats) return renderCatsSurface(box, ctx);
    // type 이 category 와 함께면 카테고리 페이지의 인라인 필터가 처리 — 단독 딥링크만 목록으로.
    //  미분류(#1091)는 대문·폴더가 있을 수 없는 '남은 것' 묶음이라 카테고리 페이지가 아니라 평면 목록으로 간다.
    if (f.q || f.all || f.indexed || f.category === KN_UNCAT || (f.type && !f.category)) return renderFilterList(box, ctx);
    if (f.category) {
      const cat = knFindCatIn(cats, f.category);
      if (cat) return renderCategorySurface(box, cat, ctx);
      // 카테고리를 못 찾음(삭제/딥링크 오류) — 첫 화면으로 조용히 폴백.
      f.category = ''; f.folder = '';
      syncHash();
    }
    return renderRecentSurface(box, ctx);   // #1841 첫 화면 = 최근(시간순) + 조건부 [검토할 것]
  }

  const shell = el('div', { class: 'kn-shell kn-shell-flat' }, main);
  cats = await knLoadCats();   // 카테고리 해석(findCat)·행 칩에 필요
  // 로딩 중 사용자가 다른 탭으로 떠났으면 여기서 멈춘다 — 늦은 mount 가 남의 화면을 덮고
  //  replaceState 로 주소까지 되돌리는 경합 방지(라우터가 dataset.route 를 즉시 세팅).
  if (document.body.dataset.route !== 'knowledge') return;
  view.replaceChildren(shell);
  syncHash();
  repaint();
  // &peek= 딥링크/뒤·앞으로가기 복원 — pushState 없이 현 URL 그대로 자동 오픈.
  const peekName = params && params.get && params.get('peek');
  if (peekName) openWikiPeek(peekName, { fromUrl: true, onRefresh: repaint });
}

// ── 필터 목록 — 검색(q)·인덱스(핀)·전체. 한 장의 평면 목록 + 정직한 헤더(무엇으로 좁혀졌나). ──
async function renderFilterList(box: HTMLElement, ctx: any) {
  const f = ctx.f;
  busy(box, el('div', { class: 'wk-home' }, skeletonRows(4)));
  const p = new URLSearchParams({ limit: '200', orderBy: 'updated_at', injection: 'recalled' });
  if (f.indexed) p.set('is_wiki', 'true');
  if (f.category && !f.indexed) p.set('category', f.category);
  if (f.type) p.set('type', f.type);
  if (f.q) p.set('q', f.q);
  let entries: any[] = [];
  try {
    entries = await api('/api/ui/knowledge?' + p).then((r) => ((r && r.entries) || []).filter((e) => !isCategoryHomeDoc(e.name)));
  } catch (e) { box.replaceChildren(errorNote(e, '목록을 불러오지 못했습니다')); return; }

  const uncat = f.category === KN_UNCAT && !f.indexed;
  const title = f.indexed ? '인덱스' : (f.q ? '검색' : uncat ? '미분류' : '전체 지식');
  const hint = f.indexed ? '매 대화 첫머리에 항상 깔리는 핀 문서'
    : (f.q ? '제목·본문 일치(정확 검색) — 의미로 찾으려면 ⌘K'
      : uncat ? '카테고리가 없어 소환(recall)에 안 잡히는 지식 — 문서를 열어 분류를 지정하세요' : '');
  const cat = f.category ? ctx.findCat(f.category) : null;
  const names = entries.map((e) => e.name);
  const openDoc = (x, rowEl) => { setWikiPeekList(names); openWikiPeek(x.name, { onRefresh: ctx.repaint, originEl: rowEl }); };

  // #1841 머리 3층 — 빵부스러기(WIKI › 전체 지식) · 뷰 탭(문서·자료·검토 대기·휴지통) · 툴바(좌: 유형 알약 + 걸린 필터 / 우: 검색 · ＋ 새 페이지).
  const typePills = [['', '전체'], ...Object.entries(KN_TYPE_LABEL)].map(([k, label]) =>
    wkTbPill(label as string, { active: (f.type || '') === k, title: k ? (label + ' 유형만') : '모든 유형', onClick: () => { f.type = k; ctx.syncHash(); ctx.repaint(); } }));
  const left: any[] = [...typePills];
  if (uncat) left.push(el('button', { class: 'wk-filter-chip', type: 'button', title: '미분류 필터 지우기', text: '미분류 ×', onclick: () => { f.category = ''; f.folder = ''; ctx.syncHash(); ctx.repaint(); } }));
  if (cat) left.push(el('button', { class: 'wk-filter-chip', type: 'button', title: '카테고리 필터 지우기', text: (cat.name || cat.key) + ' ×', onclick: () => { f.category = ''; f.folder = ''; ctx.syncHash(); ctx.repaint(); } }));
  const right: any[] = [
    wkTbSearch(f.q || '', '제목·본문 검색…', (q) => { if (q === (f.q || '')) return; f.q = q; ctx.syncHash(); ctx.repaint(); }),
    el('span', { class: 'pjv-tb-sep', 'aria-hidden': 'true' }),
    wkTbPrimary('새 페이지', () => { location.hash = '#/knowledge/new' + (f.category && !uncat ? '?category=' + encodeURIComponent(f.category) : ''); }),
  ];
  const header = wkBoardHeader({ crumbs: [{ label: 'WIKI', href: '#/knowledge' }, { label: title }], sub: hint, tabs: wkSurfaceTabs('docs'), left, right });

  const body = el('div', { class: 'wk-board-body' });
  const cols = wkDocCols({ category: !cat || uncat, catName: (e) => e.category_name || '' });
  if (!entries.length) {
    body.append(wkEmpty(f.q ? '일치하는 문서가 없어요 — ⌘K 의미검색으로 시도해 보세요.' : '문서가 없습니다.'));
  } else if (f.q) {
    body.append(wkTableGroup('검색 결과', entries, { cols, open: openDoc, count: entries.length }));
  } else {
    // 날짜 묶음 = 표의 그룹(프로젝트 표의 상태 그룹 자리). 접을 수 있고 건수는 남는다.
    const byDay: Array<[string, any[]]> = [];
    for (const e of entries) { const day = wkDayLabel(e.updated_at); const last = byDay[byDay.length - 1]; if (last && last[0] === day) last[1].push(e); else byDay.push([day, [e]]); }
    for (const [day, list] of byDay) body.append(wkTableGroup(day, list, { cols, open: openDoc }));
  }
  box.replaceChildren(el('div', { class: 'wk-home wk-board-pad' }, el('div', { class: 'card pjv-listboard wk-board' }, header, body)));
}

// ════════════════════════════════════════════
// 휴지통 #/trash — 죽은 문서는 바랜다(전 행 dim). 복원은 본체만(cascade 링크는 안 돌아옴).
// ════════════════════════════════════════════
const TRASH_ENTITY_LABEL = { knowledge: '지식', project: '프로젝트', category: '카테고리' };

async function renderWikiTrash(view) {
  view.replaceChildren(el('div', { class: 'wk-plainpad' }, skeleton('삭제된 항목을 불러오는 중')));
  let entries: any[] = [];
  try {
    entries = await api('/api/ui/deleted').then((d) => (d && d.entries) || []);
  } catch (e) {
    view.replaceChildren(el('div', { class: 'wk-plainpad' }, errorNote(e, '휴지통을 불러오지 못했습니다')));
    return;
  }
  if (document.body.dataset.route !== 'trash') return;   // 로딩 중 라우트 이탈 — 늦은 mount 방지
  const header = wkBoardHeader({ crumbs: [{ label: 'WIKI', href: '#/knowledge' }, { label: '휴지통' }], sub: '삭제된 지식·프로젝트·카테고리 — 본체만 복원됩니다(삭제 시 정리된 연결은 제외)', tabs: wkSurfaceTabs('trash'), left: [], right: [] });
  const body = el('div', { class: 'wk-board-body' });
  if (!entries.length) {
    body.append(wkEmpty('휴지통이 비어 있습니다.'));
  } else {
    const restoreCell = (e) => {
      const restoreBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '복원' });
      restoreBtn.onclick = async (ev) => {
        ev.stopPropagation();
        (restoreBtn as any).disabled = true;
        try {
          await api('/api/ui/deleted/restore', { method: 'POST', body: JSON.stringify({ entity: e.entity, key: e.key }) });
          if (e.entity === 'knowledge') knInvalidateTreeCaches();   // 복원 문서가 목록/트리에 바로 보이게
          toast('복원했습니다');
          renderWikiTrash(view);
        } catch (err) {
          (restoreBtn as any).disabled = false;
          toast('복원 실패 — ' + err.message, true);
        }
      };
      return restoreBtn;
    };
    const cols = [
      { key: 'kind', label: '종류', width: '88px', render: (e) => el('span', { class: 'pjv-fval', text: TRASH_ENTITY_LABEL[e.entity] || e.entity }) },
      { key: 'who', label: '삭제한 사람', width: '140px', render: (e) => el('span', { class: 'pjv-fval', text: (e.actor ? e.actor : '') + (e.actor_kind ? ' (' + (e.actor_kind === 'ai' ? 'AI' : '사람') + ')' : '') }) },
      { key: 'at', label: '삭제', width: '92px', render: (e) => el('span', { class: 'pjv-fval', title: e.at || '', text: relTime(e.at) }) },
      { key: 'restore', label: '', width: '84px', render: (e) => restoreCell(e) },
    ];
    const rows = entries.map((e) => ({ ...e, name: e.key, title: e.label || e.key, lifecycle: 'archived' }));
    body.append(wkTableGroup(null, rows, { cols, open: () => { /* 삭제된 문서는 열 수 없다 — 복원이 먼저 */ }, menu: () => [] }));
  }
  view.replaceChildren(el('div', { class: 'wk-plainpad wk-trash wk-board-pad' }, el('div', { class: 'card pjv-listboard wk-board' }, header, body)));
}

// ════════════════════════════════════════════
// 자료 #/knowledge/sources — 정제 전 원본(회의록·이메일·슬랙). 지식의 보조 입력층.
// ════════════════════════════════════════════
//  ?q=<검색어>&src=<id> — 통합검색(web/v2/omni.ts)이 자료 결과를 여는 자리. 자료엔 단독 주소가 없어(상세는 오버레이)
//  '그 검색어로 연 목록 + 그 자료를 펴 둔 상태'가 곧 자료 하나의 딥링크다. 사람이 뒤로 가면 목록이 그대로 남는다.
async function renderSources(view, params?: URLSearchParams) {
  // #2423 — 자료는 이제 독립 앱(#/sources)이다. 이 주소는 북마크·화면 안 링크로 계속 들어오므로 넘겨준다.
  //  ⚠ 이 화면은 새 셸 안에서 iframe(?embed=1)으로 실릴 수 있다 — 프레임 안 주소만 바꾸면 액자만 비고
  //   사람은 빈 화면을 본다. 그래서 **맨 위 창**을 움직인다(admin-shell 의 #/connect 이관과 같은 규율).
  const p = new URLSearchParams();
  const q = params && params.get('q'); if (q) p.set('q', q);
  const src = params && params.get('src');
  const hash = src ? '#/sources/' + encodeURIComponent(src) : '#/sources' + (p.toString() ? '?' + p.toString() : '');
  try { (window.top || window).location.hash = hash; } catch (_) { location.hash = hash; }
  view.replaceChildren(el('div', { class: 'wk-plainpad' },
    el('p', { class: 'empty', text: '자료는 「자료」 앱으로 옮겼습니다. 그리로 보내 드릴게요.' })));
}

export { renderWiki, renderWikiTrash };
