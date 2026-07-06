// knowledge.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
//  (#592) 문서 캔버스·속성 시스템·상세 패널·칩 생성기는 knowledge-doc.ts 로 이관 — 여기서 import 해 재사용/재수출.
import { api, applyReveal, el, errorNote, lifecycleDot, pageHead, relTime, selectFilter, state, sv, toast } from './core.js';
import { overlayBox, skeleton, skeletonRows } from './learn.js';
import { field, hasScope } from './admin.js';
import { KN_REL_LABEL, KN_TYPE_LABEL, SOURCE_KIND_LABEL, SPACE_LABEL, buildKnowledgeDetail, knAuthorChip, knFetchAuthoredTree, knFetchCategoryRows, knFolderFirstSort, knInjectChip, knInvalidateTreeCaches, knProvChip, knTreeIcon, knTypeChip, openKnowledgePeek, openProjectChooser, openSourceDetail, reanchorKnowledgePeek } from './knowledge-doc.js';


// ════════════════════════════════════════════
// 카테고리 #/categories — 맥락의 분류축(Category). space ∈ {사업·제품·시스템}별 하위 카테고리 CRUD.
//  맥락 = Category(분류축) + Knowledge(기록) + Project(변화). 이 탭은 Category 트리를 관리한다.
//  제품(product) space 의 하위 카테고리는 '도메인(domain)' — 목록 아래에 도메인맵(should/is/debt) +
//  도메인↔도메인 의존 관계(category-edges) 섹션을 함께 보여준다. 사업·시스템은 카테고리 목록만.
//  데이터: GET/POST /api/ui/categories(?space=) · POST /api/ui/categories/:id(/delete) ·
//          GET/POST /api/ui/category-edges(/:id/delete) · GET /api/ui/domainmap/map(제품 도메인맵).
// ════════════════════════════════════════════
// space 하위 탭(사업·제품·시스템) — ctxSubBar 와 같은 .sub-cats 패턴. prefix 를 받아 다른 상위 탭(지식 등)이
//  재사용할 수 있게 한다(예: spaceSubBar('#/knowledge', space)). active = business|product|system.
const SPACE_SUBS = [
  { key: 'business', label: '사업', href: '#/categories/business' },
  { key: 'product', label: '제품', href: '#/categories/product' },
  { key: 'system', label: '시스템', href: '#/categories/system' },
];
function spaceSubBar(prefix, active) {
  const bar = el('div', { class: 'sub-cats', role: 'tablist', 'aria-label': '분류축' });
  for (const s of SPACE_SUBS) {
    const on = s.key === active;
    // prefix 가 주어지면 href 를 prefix/<key> 로(재사용), 없으면 SPACE_SUBS 기본 href(#/categories/...).
    const href = prefix ? (prefix.replace(/\/$/, '') + '/' + s.key) : s.href;
    bar.append(el('a', { class: 'sub-cat' + (on ? ' active' : ''), href,
      role: 'tab', 'aria-selected': on ? 'true' : 'false', text: s.label }));
  }
  return bar;
}

// 이름 → 슬러그 키(소문자 a-z0-9-). 한글 등 비-ASCII 는 제거되므로, 결과가 비면 사용자가 키를 직접 입력해야 한다.
function slugifyKey(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s_-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function openCategoryForm(space, existing, reload) {
  const editing = !!existing;
  const nameIn = el('input', { type: 'text', placeholder: '카테고리 이름', maxlength: '200',
    value: editing ? (existing.name || '') : '' });
  const keyIn = el('input', { type: 'text', placeholder: '키 (소문자 영문·숫자·-, 비우면 이름에서 자동)', maxlength: '120',
    value: editing ? (existing.key || '') : '' });
  if (editing) keyIn.disabled = true; // 키는 생성 후 불변(엔드포인트가 수정 지원 안 함)
  const shouldIn = el('textarea', { rows: '4', placeholder: '정의 · 범위 · 규칙 (should)', maxlength: '8000',
    value: editing ? (existing.should || '') : '' });
  const descIn = el('textarea', { rows: '2', placeholder: '한 줄 설명 (선택)', maxlength: '2000',
    value: editing ? (existing.description || '') : '' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: editing ? '저장' : '만들기' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox(editing ? '카테고리 수정' : ('새 카테고리 · ' + (SPACE_LABEL[space] || space)),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '키' }), keyIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '정의 · 범위 · 규칙 (should)' }), shouldIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '설명 (선택)' }), descIn),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => nameIn.focus(), 0);

  const go = async () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      if (editing) {
        await api('/api/ui/categories/' + existing.id, { method: 'POST', body: JSON.stringify({
          name, should: shouldIn.value.trim() || undefined, description: descIn.value.trim() || undefined,
        }) });
        toast('저장했습니다');
      } else {
        const key = (keyIn.value.trim() || slugifyKey(name));
        if (!key) { saveBtn.disabled = false; keyIn.focus(); toast('키를 입력하세요(이름에 영문이 없으면 자동 생성이 안 됩니다)', true); return; }
        await api('/api/ui/categories', { method: 'POST', body: JSON.stringify({
          space, key, name, should: shouldIn.value.trim() || undefined, description: descIn.value.trim() || undefined,
        }) });
        toast('카테고리를 만들었습니다');
      }
      back.remove();
      reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

// 도메인 의존 관계(category-edges) — should(사람 작성·편집/삭제 가능) + is(스캔 소유·읽기전용)를 한 섹션에.
//  domains = 제품 카테고리 목록(셀렉터 옵션). 자체 fetch → 행 렌더 + should-edge 추가 폼.
// WIKI 인덱스(#336) — 지식 사이드바 '전체' 하위의 '인덱스(핀)' 필터를 나타내는 가짜 카테고리 센티넬.
//  data-cat-val 위임에 실려 f.indexed 토글로 변환된다. 선택 시 is_wiki=true 만(전체 카테고리에서) 보여준다.
const KN_INDEXED = '__indexed__';

function knowledgeSubBar(active) {
  // WIKI 탭 하위 = 지식 / 자료 (#290·#336). 지식(정제 저작)과 자료(raw 입력)를 분리.
  //  인덱스(핀)는 별도 탭이 아니라 '지식' 좌측 사이드바의 '전체' 하위 필터로 통합(#336).
  //  카테고리(사업·제품·시스템)는 좌측 사이드바로 통합(2026-06-26).
  //  그래프는 별도 탭 대신 '지식 그래프' 버튼 → 풀스크린 새 창(graph.html, #290 아틀라스).
  const bar = el('div', { class: 'sub-cats', role: 'tablist', 'aria-label': '지식 보기' });
  const onBrowse = active !== 'sources';
  const tab = (on, href, label, title?) => bar.append(el('a', { class: 'sub-cat' + (on ? ' active' : ''), href,
    role: 'tab', 'aria-selected': on ? 'true' : 'false', ...(title ? { title } : {}), text: label }));
  tab(onBrowse, '#/knowledge', '지식', '정제된 저작 지식 — 결정·설계·개념·런북');
  tab(active === 'sources', '#/knowledge/sources', '자료', '회의 전사록·이메일·슬랙·외부 미러 — 정제 전 raw 입력(지식과 분리, 검색에 안 섞임)');
  bar.append(el('button', { class: 'sub-graph-btn', type: 'button', role: 'link',
    title: '도메인으로 묶은 지식 지도 — 풀스크린 새 창에서 팬·줌으로 탐색', onclick: openKnowledgeAtlas },
    sv('svg', { class: 'sub-graph-ic', viewBox: '0 0 24 24', width: '15', height: '15', 'aria-hidden': 'true' },
      sv('circle', { cx: '6', cy: '7', r: '2.4', fill: 'currentColor' }),
      sv('circle', { cx: '17', cy: '6', r: '2', fill: 'currentColor', opacity: '0.7' }),
      sv('circle', { cx: '13', cy: '17', r: '2.2', fill: 'currentColor', opacity: '0.85' }),
      sv('path', { d: 'M7.8 8.2 11.4 15.4M15.2 7.3 13.7 14.9', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', opacity: '0.5' })),
    '지식 그래프'));
  return bar;
}

// 지식 아틀라스 — 풀스크린 그래프를 별도 창(graph.html)으로. opener 유지(노드 클릭 시 이 창의 상세로 이동).
//  안정적 창 이름으로 재클릭 시 같은 창을 포커스(여러 개 안 뜸).
function openKnowledgeAtlas() {
  let url = 'graph.html';
  try { url = new URL('graph.html', location.href).href; } catch (_) { /* 상대경로 폴백 */ }
  const w = window.open(url, 'lively-knowledge-atlas');
  if (w) try { w.focus(); } catch (_) { /* noop */ }
}

// 라벨 사전·칩 생성기(주입/출처/작성주체/유형)·infoDot 은 knowledge-doc.ts 로 이관(#592) — 상단 import 참조.
// 유형(page-type) 셀렉터 — 생성·편집 폼 공용. 6종. value=선택값. (#290 신규 필수)
function knTypeSelect(value) {
  const sel = el('select', {}, el('option', { value: '', text: '— 유형 선택 —' }));
  for (const [v, label] of Object.entries(KN_TYPE_LABEL)) sel.append(el('option', { value: v, text: label }));
  if (value) sel.value = value;
  return sel;
}

// 지식 한 행 — 제목(상세 링크) + 작성 주체(AI/사람) 칩 + provenance 칩 + lifecycle 점 + 갱신시각.
//  (#449) 주입(injection) 칩 제거 — 지식 탭은 recalled 전용이라 매 행 '검색'으로 반복돼 무의미. 대신 작성 주체 칩 노출.
//  select={names:Set, onToggle} 가 오면 선택(체크) 모드 — 클릭=상세이동 대신 선택 토글, .row.sel 로 표시.
//  open(#592, 선택): 클릭 콜백 — 지식탭은 전체 페이지 이동 대신 피크/드릴다운으로. 미전달 시 기존 상세 이동.
function knRow(e, select?, open?) {
  const titleEl = el('div', { class: 'row-title', text: (e.is_folder ? '📁 ' : '') + (e.title || e.name) });
  const metaEl = el('div', { class: 'row-meta' },
    e.is_wiki ? el('span', { class: 'row-pin-wrap' },
      el('span', { class: 'kn-chip kn-pin', title: 'WIKI 인덱스에 핀됨 — 매 대화 첫머리에 항상 깔립니다.', text: '📌 인덱스' }), '  ') : null,
    knAuthorChip(e.confidence), ' ',
    e.provenance ? knProvChip(e.provenance) : null,   // 트리 스켈레톤 행(폴더 드릴다운, #592)엔 provenance 없음 — 빈 칩 생략
    e.type ? el('span', {}, ' ', knTypeChip(e.type)) : null,
    e.lifecycle ? el('span', {}, '  ', lifecycleDot(e.lifecycle)) : null,
    '  ', relTime(e.updated_at));
  // 의미검색/grep 결과의 매치 스니펫(있을 때만 — 목록 페치엔 없음). 한 줄로 정리.
  const snipEl = e.snippet ? el('div', { class: 'caption', style: 'margin-top:3px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: String(e.snippet).replace(/\(\+\d+ matches\)[^\n]*/g, '').replace(/L\d+:\s*/g, '').replace(/[\n⋯]+/g, ' · ').replace(/\s+/g, ' ').trim().slice(0, 200) }) : null;
  if (!select) {
    const row = el('div', { class: 'row', role: 'link', tabindex: '0' }, titleEl, metaEl, snipEl);
    const go = () => { if (open) open(e); else location.hash = '#/k/' + encodeURIComponent(e.name); };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    return row;
  }
  // 선택 모드 — 행 전체가 토글(체크박스는 pointer-events:none 표시용).
  const on0 = select.names.has(e.name);
  const cb = el('input', { type: 'checkbox', class: 'row-check', tabindex: '-1', 'aria-hidden': 'true' });
  cb.checked = on0;
  const row = el('div', { class: 'row row-pick' + (on0 ? ' sel' : ''), role: 'button', tabindex: '0', 'aria-pressed': String(on0) },
    cb, el('div', { class: 'row-pick-body' }, titleEl, metaEl, snipEl));
  const toggle = () => {
    const on = !select.names.has(e.name);
    if (on) select.names.add(e.name); else select.names.delete(e.name);
    row.classList.toggle('sel', on); cb.checked = on; row.setAttribute('aria-pressed', String(on));
    select.onToggle();
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
  return row;
}

// 지식 탭 진입 — sub ∈ {business, product, system, sources, graph, new}. space 셋이면 2분할 뷰, 그 외 통합 둘러보기.
//  (#449) 고아 라우트 stats·review 제거 — 링크 없는 죽은 화면(review 의 목적 '반려'는 v6에서 폐기, [[content-deletion-recovery-model]]).
async function renderKnowledge(view, sub, params) {
  if (sub === 'new') return renderKnowledgeForm(view, params);   // 위키 생성 — 별도 페이지(#255). params: project·relation 프리스테이징(플젝 '직접 작성')
  // 인덱스(핀)는 별도 탭에서 '지식' 사이드바의 '전체' 하위 필터로 통합(#336) — 옛 #/knowledge/pinned 링크·북마크는 리다이렉트.
  if (sub === 'pinned') { location.replace('#/knowledge?indexed=1'); return; }
  if (sub === 'sources') return renderSources(view, params);   // #290 자료층(raw 입력)
  // (그래프는 #/knowledge/graph 라우트 폐기 — '지식 그래프' 버튼 → 풀스크린 새 창 graph.html, #290)
  // 그 외(browse·구 business/product/system URL) → 카테고리 통합 둘러보기(사이드바가 3 space 노출). space 인자 무시.
  return renderKnowledgeSpace(view, sub, params);
}

// space 뷰(사업·제품·시스템) — 좌측 카테고리 사이드바(필터) + 우측 지식 목록(검색·injection·provenance 필터).
async function renderKnowledgeSpace(view, _space, params) {
  // 공간 병합(2026-06-26) — space 인자 무시(사이드바가 3 space 통합). 카테고리/필터만 상태로.
  const f = (state.knowledge = state.knowledge || { space: '', category: '', injection: '', provenance: '', type: '', q: '', semantic: true, indexed: false, folder: '' });
  if (f.type === undefined) f.type = '';
  if (f.semantic === undefined) f.semantic = true;   // 의미검색 기본 on(off=grep). 임베딩 off면 서버가 grep 폴백.
  if (f.indexed === undefined) f.indexed = false;     // 인덱스(핀) 필터(#336) — is_wiki=true 만(전체 카테고리에서). category 와 상호배타.
  if (f.folder === undefined) f.folder = '';          // 폴더 드릴다운(#592) — 카테고리 안 폴더 name. category 없으면 무의미.
  if (params) {
    // category 와 indexed 는 상호배타(인덱스 = '전체 카테고리에서 핀만'). 외부 category 링크는 indexed 를 끈다.
    if (params.has('category')) { f.category = params.get('category') || ''; f.indexed = false; f.folder = ''; }
    if (params.has('mode')) f.semantic = params.get('mode') !== 'grep';
    if (params.has('injection')) f.injection = params.get('injection') || '';
    if (params.has('provenance')) f.provenance = params.get('provenance') || '';
    if (params.has('type')) f.type = params.get('type') || '';
    if (params.has('q')) f.q = params.get('q') || '';
    if (params.has('indexed')) { f.indexed = params.get('indexed') === '1'; if (f.indexed) { f.category = ''; f.folder = ''; } }
    if (params.has('folder')) f.folder = params.get('folder') || '';   // category 절 뒤 — ?category=..&folder=.. 딥링크 지원
  }
  if (!f.category) f.folder = '';   // 폴더는 카테고리 컨텍스트에서만

  // 로딩 중엔 kn-plain 래퍼(가운데 정렬 패딩) — doc-mode(main 패딩 0)에서 스켈레톤이 가장자리에 붙지 않게(#592).
  view.replaceChildren(el('div', { class: 'kn-plain' }, knowledgeSubBar('browse'), skeleton('지식을 불러오는 중')));

  // 선택(일괄삭제) 상태 — 리페치 없이 로컬 재페인트. names = 선택된 지식 name 집합.
  const sel = { mode: false, names: new Set() };
  let lastEntries: any[] = [];
  const bulkBar = el('div', { class: 'bulk-bar', hidden: true });
  const selectBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '선택', title: '여러 지식을 골라 한 번에 삭제',
    onclick: () => { sel.mode = !sel.mode; if (!sel.mode) sel.names.clear(); paintList(); repaintBulk(); } });

  const head = pageHead('지식', '팀이 쌓아 온 지식을 한곳에 모아 둡니다. 왼쪽에서 분류로 좁히고, 위에서 검색·필터로 찾으세요.', [
    hasScope('memory') ? el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge/new',
      title: '새 지식을 작성합니다(별도 페이지)', text: '+ 추가' }) : null,
    selectBtn,
    el('a', { class: 'btn btn-ghost btn-sm', href: '#/trash', text: '🗑 휴지통' }),
  ], '식');

  // 좌측 카테고리 사이드바 — 3 space 통합(우리 팀 상단 펼침 ★ + space별 접이식). 클릭 = 필터(category_id).
  //  (#592) .kn-shell 의 고정 260px 자체 스크롤 컬럼(.kn-side) — 내용(buildSide)은 기존 그대로.
  const side = el('aside', { class: 'kn-side' });
  const nav = el('nav', { class: 'browse-tree', 'aria-label': '카테고리' });
  const myIds = myCatIdSet();
  let bySpace: any = { business: [], product: [], system: [] };
  try { bySpace = await fetchAllSpaceCats(); } catch (_) { /* graceful: 사이드바 생략(목록은 계속) */ }
  // #551 페이지 트리(외부 미러) — 카테고리 아래 별도 섹션. 비동기 로드(없으면 숨김 유지).
  const mirrorBox = el('div', { class: 'kn-mirror-tree', hidden: true });
  function buildSide() {
    // 사이드바 선택값 = 인덱스면 센티넬, 아니면 카테고리 id. opts.indexed 로 '전체' 하위에 인덱스(핀) 항목 노출(지식 탭 전용, #336).
    //  (#592) 지식탭 전용 트리 빌더 — 카테고리 ▸ 펼침(지식 인라인)·항목 클릭=피크. buildSpacesNav(프로젝트 탭 공유)는 불변.
    const selKey = f.indexed ? KN_INDEXED : f.category;
    buildKnowledgeNav(nav, bySpace, selKey, myIds,
      { indexed: true, onOpen: (name) => openKnowledgePeek(name, { onRefresh: refetch }) });
    side.replaceChildren(el('div', { class: 'eyebrow', text: '카테고리' }), nav, mirrorBox);
  }
  buildSide();
  loadMirrorTreeInto(mirrorBox);

  // ── #592 카테고리 헤더(이름·설명 + [＋ 폴더][⚙ 보기])와 본문 뷰(list|table|entry) ──
  const catBox = el('div', { class: 'kn-cathead-slot' });
  let entryListMode = false;   // entry 뷰의 '항목 N개 목록 보기' 일시 토글(저장 아님) — 카테고리 바뀌면 리셋

  // 현재 선택된 카테고리 객체 — bySpace(이미 로드됨)에서 id 로. 인덱스/전체면 null.
  function curCat() {
    if (!f.category || f.indexed) return null;
    for (const sk of ['business', 'product', 'system']) {
      const c = (bySpace[sk] || []).find((x) => String(x.id) === String(f.category));
      if (c) return c;
    }
    return null;
  }

  function paintCatHead() {
    const cat = curCat();
    if (!cat) { catBox.replaceChildren(); catBox.hidden = true; return; }
    catBox.hidden = false;
    const actions = el('div', { class: 'kn-cathead-actions' });
    if (hasScope('memory')) {
      actions.append(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 폴더',
        title: '이 카테고리에 폴더(문서를 묶는 트리 그룹)를 만듭니다',
        onclick: () => openFolderForm(cat, f.folder, () => { buildSide(); refetch(); }) }));
    }
    if (hasScope('context')) {   // category_view_set 은 context 스코프 — 권한 없으면 메뉴 자체 미노출
      const viewBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '⚙ 보기',
        title: '이 카테고리 본문을 리스트/테이블/엔트리 문서 중 무엇으로 볼지 설정합니다' });
      viewBtn.onclick = () => openCatViewMenu(actions, viewBtn, cat, () => { entryListMode = false; paintCatHead(); paintList(); });
      actions.append(viewBtn);
    }
    catBox.replaceChildren(el('div', { class: 'kn-cathead' },
      el('div', { class: 'kn-cathead-main' },
        el('h2', { class: 'kn-cathead-name', text: cat.name || cat.key }),
        cat.description ? el('p', { class: 'kn-cathead-desc', text: cat.description }) : null),
      actions));
  }

  // 행 열기(#592) — 카테고리 안 폴더는 드릴다운(브레드크럼), 그 외(문서·전체 뷰의 폴더)는 피크(폴더 피크=자식 목록).
  function openRow(e) {
    if (e.is_folder && curCat()) { f.folder = e.name; syncHash(); refetch(); return; }
    openKnowledgePeek(e.name, { onRefresh: refetch });
  }

  // 상단 필터 — 검색(q) + injection select + provenance select.
  const qInput = el('input', { type: 'search', placeholder: '제목·본문 검색', value: f.q, 'aria-label': '검색어' });
  // 검색 방식 — 의미검색(하이브리드 벡터+grep, 자연어/유사) 기본 vs 정확(grep). 검색어가 있을 때만 영향.
  const modeSel = selectFilter([['semantic', '의미검색'], ['grep', '정확(grep)']], f.semantic ? 'semantic' : 'grep');
  modeSel.setAttribute('aria-label', '검색 방식');
  // (#335 ①) 주입 필터 폐기 — 지식 탭은 recalled 전용. 항상-주입 섹션(org-defaults·가이드)은 관리탭 '세션 주입'에서 관리.
  const provSel = selectFilter([['', '전체 출처'], ['authored', '저작'], ['observed', '외부 미러']], f.provenance);
  provSel.setAttribute('aria-label', '출처');
  // page-type(#290) 필터 — 의미검색이 아닌 목록(브라우즈/grep) 경로에만 적용.
  const typeSel = selectFilter([['', '전체 유형'], ['decision', '결정'], ['concept', '개념'], ['how-to', 'How-to'], ['reference', '참조'], ['research', '리서치'], ['entity', '엔티티']], f.type);
  typeSel.setAttribute('aria-label', '유형');

  const listBox = el('div', { class: 'list-box browse-list' });
  const foot = el('div', { class: 'list-foot' });

  function syncHash() {
    const p = new URLSearchParams();
    if (f.indexed) p.set('indexed', '1');           // 인덱스(핀)는 '전체 카테고리에서 핀만' — category 와 상호배타(#336)
    else if (f.category) {
      p.set('category', f.category);
      if (f.folder) p.set('folder', f.folder);      // 폴더 드릴다운(#592) — 딥링크/새로고침 복원
    }
    if (f.provenance) p.set('provenance', f.provenance);
    if (f.type) p.set('type', f.type);
    if (f.q) p.set('q', f.q);
    if (!f.semantic) p.set('mode', 'grep');
    // #592 열린 피크는 URL 에 유지(뒤로가기=닫힘 계약) — 현 해시의 peek 파라미터를 그대로 승계.
    const curQIdx = location.hash.indexOf('?');
    const curPeek = curQIdx >= 0 ? new URLSearchParams(location.hash.slice(curQIdx + 1)).get('peek') : null;
    if (curPeek) p.set('peek', curPeek);
    const qs = p.toString();
    history.replaceState(null, '', '#/knowledge' + (qs ? '?' + qs : ''));
    reanchorKnowledgePeek();   // 필터 변경으로 non-peek 기준 해시가 바뀌었으니 열린 피크의 baseHash 재앵커(뒤로가기 판정 정확화)
  }

  // 목록 페인트(서버 페치 분리) — 선택 모드면 행을 체크 가능하게 렌더.
  //  (#592) 카테고리 뷰 분기: list(기본 knRow) | table(컬럼 테이블) | entry(엔트리 문서 인라인 + 목록 토글 바).
  //  검색 중·선택(일괄) 모드·인덱스는 항상 list. 폴더 드릴다운은 list/table 위에 브레드크럼을 얹는다.
  function paintList() {
    const cat = curCat();
    const searching = !!f.q.trim();
    let mode = (cat && !searching && !sel.mode) ? (cat.view_mode || 'list') : 'list';
    if (mode === 'entry' && (entryListMode || !cat.entry_name)) mode = 'list';
    const parts: any[] = [];
    // entry 지정 카테고리 — 상단 얇은 바(엔트리 문서 ⇄ 항목 N개 목록 토글). 검색/선택 모드에선 생략.
    if (cat && !searching && !sel.mode && (cat.view_mode || 'list') === 'entry' && cat.entry_name) {
      parts.push(el('div', { class: 'kn-entrybar' },
        el('span', { class: 'kn-entrybar-label',
          text: entryListMode ? '목록 보기 중 — 엔트리 문서로 돌아갈 수 있습니다' : '엔트리 문서 보기 중' }),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button',
          text: entryListMode ? '엔트리 문서 보기' : '항목 ' + lastEntries.length + '개 목록 보기',
          onclick: () => { entryListMode = !entryListMode; paintList(); } })));
    }
    if (mode === 'entry') {
      // 엔트리 문서를 본문 영역에 인라인 렌더(buildKnowledgeDetail 단일 소스). 삭제되면 목록으로 폴백.
      const inlineBox = el('div', { class: 'kn-entry-inline' });
      buildKnowledgeDetail(inlineBox, cat.entry_name, { mode: 'inline',
        onDeleted: () => { entryListMode = true; refetch(); } });
      parts.push(inlineBox);
      listBox.replaceChildren(...parts);
      return;
    }
    if (cat && f.folder && !searching) parts.push(knFolderCrumb(cat));   // 드릴다운 브레드크럼(카테고리 / … / 폴더)
    if (!lastEntries.length) {
      parts.push(el('div', { class: 'empty', text: f.indexed
        ? '핀된 지식이 없습니다. 지식 상세에서 ‘📌 핀’을 눌러 매 대화에 깔 항목을 고르세요.'
        : (f.folder ? '폴더가 비어 있습니다 — 문서 상세의 ‘이동’으로 담을 수 있습니다.' : '조건에 맞는 지식이 없습니다. 필터를 넓혀 보세요.') }));
      listBox.replaceChildren(...parts);
      return;
    }
    if (mode === 'table') {
      parts.push(knTable(lastEntries, openRow));
    } else {
      const select = sel.mode ? { names: sel.names, onToggle: repaintBulk } : null;
      parts.push(...lastEntries.map((e) => knRow(e, select, openRow)));
    }
    listBox.replaceChildren(...parts);
  }

  // 폴더 드릴다운 브레드크럼 — '카테고리 / (조상…) / 📁 폴더'. 조상 체인은 authored 트리 캐시로 상향 탐색(비동기 보강).
  function knFolderCrumb(cat) {
    const box = el('div', { class: 'kn-crumbbar' },
      el('a', { class: 'crumb-link', href: '#', text: cat.name || cat.key,
        onclick: (ev) => { ev.preventDefault(); f.folder = ''; syncHash(); refetch(); } }));
    (async () => {
      let chain: any[] = [{ name: f.folder, title: f.folder }];
      try {
        const byName = new Map((await knFetchAuthoredTree()).map((t) => [t.name, t]));
        const up: any[] = [];
        let cur: any = byName.get(f.folder);
        let guard = 0;
        while (cur && guard++ < 20) { up.unshift(cur); cur = cur.parent_name ? byName.get(cur.parent_name) : null; }
        if (up.length) chain = up;
      } catch (_) { /* 트리 캐시 실패 — 현재 폴더명만 */ }
      for (let i = 0; i < chain.length; i++) {
        const nd = chain[i];
        const last = i === chain.length - 1;
        box.append(el('span', { class: 'crumb-sep', text: ' / ' }), last
          ? el('span', { class: 'crumb-cur', text: '📁 ' + (nd.title || nd.name) })
          : el('a', { class: 'crumb-link', href: '#', text: nd.title || nd.name,
              onclick: (ev) => { ev.preventDefault(); f.folder = nd.name; syncHash(); refetch(); } }));
      }
    })();
    return box;
  }

  // 선택 바 — 선택 모드일 때만. 전체선택/해제 + 선택 삭제(휴지통). 선택 버튼은 선택↔취소 토글.
  function repaintBulk() {
    selectBtn.textContent = sel.mode ? '취소' : '선택';
    if (!sel.mode) { bulkBar.hidden = true; bulkBar.replaceChildren(); return; }
    const n = sel.names.size;
    const allOn = lastEntries.length > 0 && lastEntries.every((e) => sel.names.has(e.name));
    const allBtn = el('button', { class: 'btn btn-ghost btn-sm', text: allOn ? '전체 해제' : '전체 선택',
      onclick: () => { if (allOn) sel.names.clear(); else lastEntries.forEach((e) => sel.names.add(e.name)); paintList(); repaintBulk(); } });
    // 선택한 지식을 프로젝트의 필요/산출 지식으로 일괄 연결(#257). 권한자(memory)만.
    const linkBtn = hasScope('memory')
      ? el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 프로젝트 연결',
          onclick: () => openProjectChooser({
            title: n + '개 지식 → 프로젝트 연결',
            actionLabel: '＋ 연결', doneLabel: '연결됨',
            onPick: async (proj, relation) => {
              const nm = [...sel.names];
              const res = await Promise.allSettled(nm.map((name) =>
                api('/api/ui/v6/projects/' + proj.id + '/knowledge', { method: 'POST', body: JSON.stringify({ name, relation }) })));
              const ok = res.filter((r) => r.status === 'fulfilled').length;
              const fail = res.length - ok;
              toast(fail ? (ok + '개 연결 · ' + fail + '개 실패') : (ok + '개 지식을 ‘' + proj.name + '’에 연결했습니다'), fail > 0);
              return true;
            } }) })
      : null;
    if (linkBtn) (linkBtn as any).disabled = n === 0;
    const delBtn = el('button', { class: 'btn btn-sm btn-danger', text: '선택 삭제',
      onclick: () => bulkDelete(delBtn) });
    delBtn.disabled = n === 0; // el 은 setAttribute('disabled', false) 라 여전히 비활 — 프로퍼티로 설정해야 해제됨
    bulkBar.hidden = false;
    bulkBar.replaceChildren(
      el('span', { class: 'bulk-bar-count', text: n ? n + '개 선택됨' : '연결·삭제할 지식을 고르세요' }),
      el('div', { class: 'bulk-bar-actions' }, allBtn, linkBtn, delBtn));
  }

  async function bulkDelete(btn) {
    const names: any[] = [...sel.names];
    if (!names.length) return;
    if (!confirm(names.length + '개 지식을 삭제할까요?\n\n활성 목록·검색·주입에서 사라집니다. 휴지통(#/trash)에서 복원할 수 있습니다.')) return;
    btn.disabled = true;
    // 병렬 삭제 — 일부 실패해도 나머지 진행(성공/실패 건수 보고). 서버가 사람전용 403 재검증.
    const results = await Promise.allSettled(
      names.map((nm) => api('/api/ui/knowledge/' + encodeURIComponent(nm) + '/delete', { method: 'POST' })));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    toast(fail ? (ok + '개 삭제 · ' + fail + '개 실패') : (ok + '개 지식을 삭제했습니다 — 휴지통에서 복원 가능'), fail > 0);
    sel.mode = false; sel.names.clear();
    refetch();
  }

  async function refetch() {
    listBox.replaceChildren(skeletonRows(4));
    foot.replaceChildren();
    try {
      // #592 폴더 드릴다운 — 서버 목록 대신 authored 트리(parent_name)로 자식 해소 + 카테고리 rows 로 칩 보강.
      //  검색어가 있으면 드릴다운 대신 카테고리 전체 검색(아래 기존 경로).
      if (curCat() && f.folder && !f.q.trim()) {
        const [tree, catRows] = await Promise.all([
          knFetchAuthoredTree(),
          knFetchCategoryRows(f.category).catch(() => []),
        ]);
        const byName = new Map<string, any>(catRows.map((row): [string, any] => [row.name, row]));
        lastEntries = tree.filter((t) => t.parent_name === f.folder)
          .map((t) => byName.get(t.name) || t)
          .sort(knFolderFirstSort);
        const present = new Set(lastEntries.map((e) => e.name));
        sel.names.forEach((nm) => { if (!present.has(nm)) sel.names.delete(nm); });
        paintList();
        repaintBulk();
        foot.replaceChildren(el('span', { class: 'caption', text: lastEntries.length + '건 · 폴더 안' }));
        return;
      }
      let r;
      if (f.q.trim() && f.semantic) {
        // 의미검색 — 하이브리드(벡터+grep RRF). 전역 랭킹이라 카테고리 필터는 미적용(주입/출처는 적용). 임베딩 off면 서버가 grep 폴백.
        const p = new URLSearchParams({ q: f.q.trim(), limit: '200' });
        p.set('injection', 'recalled'); // (#335 ①) always 섹션 제외 — 지식 탭 = recalled 전용
        if (f.provenance) p.set('provenance', f.provenance);
        r = await api('/api/ui/knowledge/semantic?' + p.toString());
      } else {
        // 목록(빈 검색=브라우즈 / 정확검색) — 카테고리·grep 필터 적용, 최신순.
        const p = new URLSearchParams({ limit: '200', orderBy: 'updated_at' });
        if (f.indexed) p.set('is_wiki', 'true');   // 인덱스(핀)만 — 서버 필터(category 없음 = 전체 카테고리에서)(#336)
        else if (f.category) p.set('category', f.category);
        p.set('injection', 'recalled'); // (#335 ①) always 섹션 제외 — 지식 탭 = recalled 전용
        if (f.provenance) p.set('provenance', f.provenance);
        if (f.type) p.set('type', f.type);
        if (f.q.trim()) p.set('q', f.q.trim());
        r = await api('/api/ui/knowledge?' + p.toString());
      }
      let entries = (r && r.entries) || [];
      // 인덱스(핀) 한정 — 의미검색 경로는 서버에 is_wiki 필터가 없으니 여기서 거른다(목록 경로는 서버가 이미 거름)(#336).
      if (f.indexed) entries = entries.filter((e) => e.is_wiki);
      // 카테고리 브라우즈(#592) — 폴더를 위로(제목순), 문서는 최신순(서버 순서) 유지. 검색 결과는 관련도순 그대로.
      if (curCat() && !f.q.trim()) {
        const folders = entries.filter((e) => e.is_folder).sort((a, b) => String(a.title || a.name).localeCompare(String(b.title || b.name)));
        entries = [...folders, ...entries.filter((e) => !e.is_folder)];
      }
      lastEntries = entries;
      // 필터로 사라진 선택 정리(이후 화면에 없는 name 은 선택 해제).
      const present = new Set(entries.map((e) => e.name));
      sel.names.forEach((nm) => { if (!present.has(nm)) sel.names.delete(nm); });
      paintList();
      repaintBulk();
      foot.replaceChildren(el('span', { class: 'caption', text: entries.length + '건' + (f.indexed ? ' · 인덱스(핀)' : '') + (f.q.trim() && f.semantic ? ' · 의미검색(관련도순)' : '') }));
    } catch (e) {
      listBox.replaceChildren(errorNote(e, '지식을 불러오지 못했습니다'));
    }
  }

  let qTimer: any = null;
  qInput.addEventListener('input', () => { f.q = qInput.value; clearTimeout(qTimer); qTimer = setTimeout(() => { syncHash(); refetch(); }, 280); });
  provSel.addEventListener('change', () => { f.provenance = provSel.value; syncHash(); refetch(); });
  typeSel.addEventListener('change', () => { f.type = typeSel.value; syncHash(); refetch(); });
  modeSel.addEventListener('change', () => { f.semantic = modeSel.value === 'semantic'; syncHash(); refetch(); });
  // 좌측 클릭 위임(side 컨테이너 — buildSide 가 내부를 교체해도 핸들러 유지).
  side.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-cat-val]');
    if (!item) return;
    ev.preventDefault();
    // 인덱스 센티넬이면 f.indexed 토글(category 비움), 아니면 일반 카테고리(#336).
    const v = item.dataset.catVal || '';
    f.indexed = v === KN_INDEXED;
    f.category = f.indexed ? '' : v;
    f.folder = '';              // 카테고리 전환 = 드릴다운 해제(#592)
    entryListMode = false;      // entry '목록 보기' 일시 토글도 리셋
    buildSide(); paintCatHead(); syncHash(); refetch();
  });

  const filterBar = el('div', { class: 'filter-bar browse-filter' }, qInput, modeSel, provSel, typeSel);
  // (#592) .kn-shell — 사이드바(260px, border-right, 자체 스크롤) + 콘텐츠(flex1, 자체 패딩). 헤더·서브탭도 콘텐츠 컬럼 안으로.
  const layout = el('div', { class: 'kn-shell' },
    side,
    el('section', { class: 'kn-main' }, head, knowledgeSubBar('browse'), catBox, filterBar, bulkBar, listBox, foot),
  );
  view.replaceChildren(layout);
  applyReveal([layout]);
  paintCatHead();
  refetch();
  // #592 peek 파라미터 — URL 직접 진입/뒤·앞으로가기 복원 시 피크 자동 오픈(pushState 없이 현 URL 그대로).
  const peekName = params && params.get && params.get('peek');
  if (peekName) openKnowledgePeek(peekName, { fromUrl: true, onRefresh: refetch });
}

// #551 노션 페이지 트리 로더 — 사이드바 공용(목록·문서 페이지). 미러 없음/권한 없음이면 숨김 유지.
function loadMirrorTreeInto(mirrorBox) {
  (async () => {
    try {
      const r = await api('/api/ui/knowledge-tree?system=notion');
      const entries = (r && r.entries) || [];
      if (!entries.length) return;
      mirrorBox.replaceChildren(
        el('div', { class: 'eyebrow kn-mirror-eyebrow', text: 'Notion 페이지 트리' }),
        buildMirrorTree(entries));
      mirrorBox.hidden = false;
    } catch (_) { /* 미러 없음/권한 없음 → 섹션 숨김 유지 */ }
  })();
}

// 카테고리 사이드바 행 — tree-item 패턴. data-cat-val 로 클릭 위임(빈 문자열=전체).
//  opts(선택): { glyph } 글리프 교체(기본 ·/∗) · { cls } 추가 클래스(예: 들여쓰기) · { title } 호버 힌트.
function knSideItem(label, catVal, on, opts?) {
  const glyph = (opts && opts.glyph) || (catVal ? '·' : '∗');
  return el('a', { class: 'tree-item' + (on ? ' on' : '') + (opts && opts.cls ? ' ' + opts.cls : ''),
    href: '#', 'data-cat-val': catVal, role: 'button', tabindex: '0',
    ...(opts && opts.title ? { title: opts.title } : {}) },
    el('span', { class: 'tree-glyph all', 'aria-hidden': 'true', text: glyph }),
    el('span', { class: 'tree-label', text: label }));
}

// ── 공유 사이드바(프로젝트·위키 탭 공용, 2026-06-26) — 3 space 카테고리를 한 사이드바에 통합. ──
//  공간 서브탭을 없애고, 보는 멤버의 '우리 팀' 카테고리(state.me.team_category_ids = 팀 소유/이해관계)를 상단에
//  펼쳐 노출(★), 나머지는 space별 접이식(<details>)으로 접어 하위에 둔다. data-cat-val 위임은 호출부가 유지.
//  ★오너십=우선순위, 접근제한 아님 — 모든 카테고리는 여전히 사이드바에 있고 선택·검색 가능.

// 3 space 카테고리를 한 번에 — {business, product, system}. 각 항목 graceful(실패=빈 배열).
async function fetchAllSpaceCats(): Promise<any> {
  const out: any = { business: [], product: [], system: [] };
  const lists = await Promise.all(SPACE_SUBS.map((s) =>
    api('/api/ui/categories?' + new URLSearchParams({ space: s.key })).then((d) => (d && d.categories) || []).catch(() => [])));
  SPACE_SUBS.forEach((s, i) => { out[s.key] = lists[i]; });
  return out;
}

// 내 팀 카테고리 id 집합(state.me.team_category_ids) — 문자열 Set(catVal 비교용). 미로그인/미소속이면 빈 집합.
function myCatIdSet(): Set<string> {
  const ids = (state.me && (state.me as any).team_category_ids) || [];
  return new Set((ids as any[]).map((x) => String(x)));
}

// 공유 사이드바 nav 채우기 — 우리 팀(상단 펼침 ★) + space별 접이식(나머지). nav 내부만 교체(클릭 위임은 호출부 side 에).
//  myIds 비면(미소속) 우리 팀 그룹 생략하고 3 space 를 모두 펼쳐 노출(기존 동작에 근접). selected = 현재 선택 catVal(문자열).
//  opts.indexed(지식 탭 전용, #336): '전체' 바로 아래에 '인덱스(핀)' 필터 항목(센티넬 KN_INDEXED)을 끼운다. 프로젝트 탭은 미전달 → 미노출.
function buildSpacesNav(nav, bySpace, selected, myIds: Set<string>, opts?) {
  nav.replaceChildren();
  nav.append(knSideItem('전체', '', !selected || selected === ''));
  // WIKI 인덱스(#336) — '전체' 하위 한 단 들여쓴 '인덱스' 항목. 클릭 시 전체 카테고리에서 is_wiki(핀)만 필터.
  if (opts && opts.indexed) {
    nav.append(knSideItem('인덱스', KN_INDEXED, selected === KN_INDEXED,
      { glyph: '📌', cls: 'tree-item-sub', title: '인덱스(핀)된 지식만 — 전체 카테고리에서 매 대화 첫머리에 깔리는 항목' }));
  }
  // 우리 팀 — 내 카테고리를 사업/제품/시스템 대분류로 하위 그룹핑(#338). 항상 펼침. 나머지 그룹과 같은 space 순서.
  const mineBySpace: any = { business: [], product: [], system: [] };
  for (const sk of ['business', 'product', 'system']) for (const c of (bySpace[sk] || [])) if (myIds.has(String(c.id))) mineBySpace[sk].push(c);
  const mineTotal = mineBySpace.business.length + mineBySpace.product.length + mineBySpace.system.length;
  const hasMine = mineTotal > 0;
  if (hasMine) {
    const grp = el('details', { class: 'tree-group tree-group-mine', open: '' },
      el('summary', { class: 'tree-grouphead' },
        el('span', { class: 'tree-groupstar', 'aria-hidden': 'true', text: '★' }),
        el('span', { class: 'tree-grouptitle', text: '우리 팀' }),
        el('span', { class: 'tree-groupcount', text: String(mineTotal) })));
    // 사업·제품·시스템 순으로 가벼운 하위 헤더 + 항목(빈 space 는 생략).
    for (const sk of ['business', 'product', 'system']) {
      const inSpace = mineBySpace[sk];
      if (!inSpace.length) continue;
      grp.append(el('div', { class: 'tree-subhead' },
        el('span', { class: 'tree-subtitle', text: SPACE_LABEL[sk] }),
        el('span', { class: 'tree-subcount', text: String(inSpace.length) })));
      for (const c of inSpace) grp.append(knSideItem(c.name || c.key, String(c.id), String(selected) === String(c.id)));
    }
    nav.append(grp);
  }
  // 나머지 — space별(사업·제품·시스템). 우리 팀이 있으면 접힘 기본(무관=하위), 없으면 펼침. 선택된 카테고리가 든 그룹은 펼침.
  for (const sk of ['business', 'product', 'system']) {
    const rest = (bySpace[sk] || []).filter((c) => !myIds.has(String(c.id)));
    if (!rest.length) continue;
    const selectedHere = rest.some((c) => String(c.id) === String(selected));
    const open = !hasMine || selectedHere;
    const grp = el('details', { class: 'tree-group' + (hasMine ? ' tree-group-rest' : ''), ...(open ? { open: '' } : {}) },
      el('summary', { class: 'tree-grouphead' },
        el('span', { class: 'tree-grouptitle', text: SPACE_LABEL[sk] }),
        el('span', { class: 'tree-groupcount', text: String(rest.length) })));
    for (const c of rest) grp.append(knSideItem(c.name || c.key, String(c.id), String(selected) === String(c.id)));
    nav.append(grp);
  }
}

// ════════════════════════════════════════════
// #592 지식탭 전용 사이드바 트리 — buildSpacesNav(프로젝트 탭 공유·불변)와 같은 골격(전체/인덱스/우리 팀/space 그룹)에
//  카테고리 노드 ▸ 펼침을 더한다: 펼치면 그 카테고리 지식 인라인(폴더 우선→sort→제목순, 지연 로드+세션 캐시 —
//  knFetchCategoryRows), 폴더 노드는 다시 ▸ 로 authored 트리(knFetchAuthoredTree, parent_name)를 펼친다.
//  카테고리명 클릭=본문 필터(data-cat-val 위임 유지), 문서 클릭=피크(opts.onOpen).
// ════════════════════════════════════════════
function buildKnowledgeNav(nav, bySpace, selected, myIds: Set<string>, opts) {
  const onOpen = (opts && opts.onOpen) || ((name) => { location.hash = '#/k/' + encodeURIComponent(name); });
  nav.replaceChildren();
  nav.append(knSideItem('전체', '', !selected || selected === ''));
  if (opts && opts.indexed) {
    nav.append(knSideItem('인덱스', KN_INDEXED, selected === KN_INDEXED,
      { glyph: '📌', cls: 'tree-item-sub', title: '인덱스(핀)된 지식만 — 전체 카테고리에서 매 대화 첫머리에 깔리는 항목' }));
  }
  const catNode = (c) => knNavCatNode(c, String(selected) === String(c.id), onOpen);
  // 우리 팀(★ 상단 펼침) — buildSpacesNav 와 동일 그룹핑(#338), 항목만 펼침형 노드로.
  const mineBySpace: any = { business: [], product: [], system: [] };
  for (const sk of ['business', 'product', 'system']) for (const c of (bySpace[sk] || [])) if (myIds.has(String(c.id))) mineBySpace[sk].push(c);
  const mineTotal = mineBySpace.business.length + mineBySpace.product.length + mineBySpace.system.length;
  const hasMine = mineTotal > 0;
  if (hasMine) {
    const grp = el('details', { class: 'tree-group tree-group-mine', open: '' },
      el('summary', { class: 'tree-grouphead' },
        el('span', { class: 'tree-groupstar', 'aria-hidden': 'true', text: '★' }),
        el('span', { class: 'tree-grouptitle', text: '우리 팀' }),
        el('span', { class: 'tree-groupcount', text: String(mineTotal) })));
    for (const sk of ['business', 'product', 'system']) {
      const inSpace = mineBySpace[sk];
      if (!inSpace.length) continue;
      grp.append(el('div', { class: 'tree-subhead' },
        el('span', { class: 'tree-subtitle', text: SPACE_LABEL[sk] }),
        el('span', { class: 'tree-subcount', text: String(inSpace.length) })));
      for (const c of inSpace) grp.append(catNode(c));
    }
    nav.append(grp);
  }
  // 나머지 — space별 접이식(우리 팀 있으면 접힘 기본, 선택 카테고리가 든 그룹은 펼침).
  for (const sk of ['business', 'product', 'system']) {
    const rest = (bySpace[sk] || []).filter((c) => !myIds.has(String(c.id)));
    if (!rest.length) continue;
    const selectedHere = rest.some((c) => String(c.id) === String(selected));
    const open = !hasMine || selectedHere;
    const grp = el('details', { class: 'tree-group' + (hasMine ? ' tree-group-rest' : ''), ...(open ? { open: '' } : {}) },
      el('summary', { class: 'tree-grouphead' },
        el('span', { class: 'tree-grouptitle', text: SPACE_LABEL[sk] }),
        el('span', { class: 'tree-groupcount', text: String(rest.length) })));
    for (const c of rest) grp.append(catNode(c));
    nav.append(grp);
  }
}

// 카테고리 노드 — 행(▸ 셰브런 + 이름, data-cat-val 로 필터 위임 유지) + 인라인 자식 목록(지연 로드).
//  레벨1 = 카테고리 지식 중 트리 최상위(부모가 같은 카테고리 안에 없는 행)만 — 폴더 자식은 폴더 노드에서 펼친다.
function knNavCatNode(c, on, onOpen) {
  const tw = el('button', { class: 'kn-nav-tw', type: 'button', 'aria-expanded': 'false',
    title: '이 카테고리의 지식 펼치기', text: '▸' });
  const row = el('a', { class: 'tree-item kn-nav-cat' + (on ? ' on' : ''), href: '#',
    'data-cat-val': String(c.id), role: 'button', tabindex: '0' },
    tw, el('span', { class: 'tree-label', text: c.name || c.key }));
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
      const rows = await knFetchCategoryRows(c.id);
      const names = new Set(rows.map((r) => r.name));
      const tops = rows.filter((r) => !(r.parent_name && names.has(r.parent_name))).slice().sort(knFolderFirstSort);
      loaded = true;
      if (!tops.length) { kids.replaceChildren(el('div', { class: 'kn-nav-note', text: '지식 없음' })); return; }
      kids.replaceChildren(...tops.map((r) => knNavDocNode(r, 1, onOpen)));
    } catch (_) {
      kids.replaceChildren(el('div', { class: 'kn-nav-note', text: '불러오기 실패' }));
    }
  });
  return el('div', { class: 'kn-nav-catwrap' }, row, kids);
}

// 트리 안 지식 노드 — 문서는 클릭=피크(onOpen), 폴더는 ▸/행 클릭=authored 트리 자식 펼침(재귀, 지연 로드).
function knNavDocNode(r, depth, onOpen) {
  const pad = 8 + depth * 14;
  if (!r.is_folder) {
    const row = el('a', { class: 'tree-item kn-nav-doc' + (r.lifecycle === 'archived' ? ' kn-tree-archived' : ''),
      href: '#/k/' + encodeURIComponent(r.name), style: 'padding-left:' + pad + 'px', title: r.title || r.name },
      el('span', { class: 'tree-glyph kn-nav-glyph', 'aria-hidden': 'true', text: '📄' }),
      el('span', { class: 'tree-label', text: r.title || r.name }));
    row.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); onOpen(r.name); });
    return row;
  }
  const tw = el('button', { class: 'kn-nav-tw', type: 'button', 'aria-expanded': 'false', title: '폴더 펼치기', text: '▸' });
  const row = el('div', { class: 'tree-item kn-nav-doc kn-nav-folder', role: 'button', tabindex: '0',
    style: 'padding-left:' + Math.max(4, pad - 16) + 'px', title: r.title || r.name },
    tw, el('span', { class: 'tree-glyph kn-nav-glyph', 'aria-hidden': 'true', text: '📁' }),
    el('span', { class: 'tree-label', text: r.title || r.name }));
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
      kids.replaceChildren(...sub.map((t) => knNavDocNode(t, depth + 1, onOpen)));
    } catch (_) {
      kids.replaceChildren(el('div', { class: 'kn-nav-note', text: '불러오기 실패' }));
    }
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') toggle(ev); });
  return el('div', {}, row, kids);
}

// #592 테이블 뷰 — 컬럼 제목/유형/작성 주체/갱신. 행 클릭=피크(폴더=드릴다운 — open 콜백이 분기). 폴더 행은 📁+이름만.
function knTable(entries, open) {
  const tr = (e) => {
    const rowEl = el('tr', { class: 'kn-table-row', tabindex: '0', role: 'link' });
    if (e.is_folder) {
      rowEl.append(
        el('td', { class: 'kn-table-title', text: '📁 ' + (e.title || e.name) }),
        el('td', { colspan: '3' }));
    } else {
      rowEl.append(
        el('td', { class: 'kn-table-title', text: e.title || e.name }),
        el('td', { class: 'kn-table-dim', text: e.type ? (KN_TYPE_LABEL[e.type] || e.type) : '' }),
        el('td', {}, knAuthorChip(e.confidence) || (e.provenance === 'observed' ? knProvChip(e.provenance) : null)),
        el('td', { class: 'kn-table-dim' }, e.updated_at ? relTime(e.updated_at) : ''));
    }
    rowEl.addEventListener('click', () => open(e));
    rowEl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(e); });
    return rowEl;
  };
  return el('div', { class: 'kn-table-wrap' },
    el('table', { class: 'kn-table' },
      el('thead', {}, el('tr', {},
        el('th', { text: '제목' }), el('th', { text: '유형' }), el('th', { text: '작성 주체' }), el('th', { text: '갱신' }))),
      el('tbody', {}, ...entries.map(tr))));
}

// #592 폴더 생성 — 이름 입력 오버레이 → knowledge_save {is_folder, category:key, type:'reference', body_md:''}.
//  parentFolder(드릴다운 중이면 현재 폴더 name)가 있으면 그 안에 만든다. onDone = 사이드바/목록 새로고침.
function openFolderForm(cat, parentFolder, onDone) {
  const nameIn = el('input', { type: 'text', placeholder: '폴더 이름', maxlength: '200' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기' });
  const back = overlayBox('새 폴더 · ' + (cat.name || cat.key),
    el('p', { class: 'admin-hint', text: parentFolder
      ? '현재 폴더 안에 만듭니다. 폴더는 이 카테고리의 문서를 묶는 트리 그룹입니다.'
      : '카테고리 최상위에 만듭니다. 폴더는 이 카테고리의 문서를 묶는 트리 그룹입니다.' }),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'ov-actions' }, saveBtn,
      el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
  setTimeout(() => nameIn.focus(), 0);
  const go = async () => {
    const title = nameIn.value.trim();
    if (!title) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      const payload: any = { is_folder: true, title, category: cat.key, type: 'reference', body_md: '' };
      if (parentFolder) payload.parent_name = parentFolder;
      await api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify(payload) });
      knInvalidateTreeCaches();
      toast('폴더를 만들었습니다');
      back.remove();
      onDone();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

// #592 카테고리 뷰 설정 저장 — POST /api/ui/categories/:id/view. 응답 category 를 로컬 cat 객체에 반영(즉시 반영).
async function saveCatView(cat, patch) {
  const r = await api('/api/ui/categories/' + cat.id + '/view', { method: 'POST', body: JSON.stringify(patch) });
  const u = r && r.category;
  if (u && u.id) { cat.view_mode = u.view_mode; cat.entry_name = u.entry_name; }
  else Object.assign(cat, patch);
}

// #592 [⚙ 보기] 메뉴 — 리스트|테이블|엔트리 문서 + '엔트리 문서 지정…'. 선택 즉시 저장·반영(onChanged).
function openCatViewMenu(anchorBox, btn, cat, onChanged) {
  const old = anchorBox.querySelector('.kn-viewpop');
  if (old) { old.remove(); return; }
  const close = () => { pop.remove(); document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey); };
  const modeRow = (v, label, hint) => {
    const on = (cat.view_mode || 'list') === v;
    const rowEl = el('button', { class: 'kn-viewopt' + (on ? ' on' : ''), type: 'button', title: hint },
      el('span', { class: 'kn-viewopt-check', 'aria-hidden': 'true', text: on ? '✓' : '' }),
      el('span', { text: label }));
    rowEl.onclick = async () => {
      try {
        if (v === 'entry' && !cat.entry_name) { close(); openEntryDocPicker(cat, onChanged); return; }   // 지정 문서부터
        await saveCatView(cat, { view_mode: v });
        toast('보기 설정을 저장했습니다');
        close();
        onChanged();
      } catch (e) { toast('저장 실패 — ' + e.message, true); }
    };
    return rowEl;
  };
  const entrySet = el('button', { class: 'kn-viewopt kn-viewopt-sub', type: 'button',
    title: '엔트리 뷰에서 본문 영역에 보여줄 문서를 고릅니다',
    text: cat.entry_name ? '엔트리 문서 변경…' : '엔트리 문서 지정…' });
  entrySet.onclick = () => { close(); openEntryDocPicker(cat, onChanged); };
  const pop = el('div', { class: 'kn-viewpop' },
    el('div', { class: 'kn-viewpop-head', text: '카테고리 보기' }),
    modeRow('list', '리스트', '기존 행 목록(폴더는 📁 드릴다운)'),
    modeRow('table', '테이블', '제목·유형·작성 주체·갱신 컬럼 테이블'),
    modeRow('entry', '엔트리 문서', '지정한 문서를 본문 영역에 렌더(상단 바로 목록 전환)'),
    cat.entry_name ? el('div', { class: 'kn-viewpop-cur', text: '엔트리: ' + cat.entry_name }) : null,
    el('div', { class: 'kn-viewpop-hr' }),
    entrySet);
  anchorBox.append(pop);
  const onDoc = (ev) => { if (pop.contains(ev.target) || btn.contains(ev.target)) return; close(); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  setTimeout(() => { document.addEventListener('click', onDoc, true); document.addEventListener('keydown', onKey); }, 0);
}

// #592 엔트리 문서 피커 — 지식 검색 오버레이(openKnowledgeLinkPicker 패턴). 빈 검색 = 이 카테고리의 문서 목록.
//  선택 시 {entry_name, view_mode:'entry'} 저장. 기존 지정이 있으면 '지정 해제'(entry_name null + list 복귀)도 제공.
function openEntryDocPicker(cat, onChanged) {
  const qIn = el('input', { type: 'search', placeholder: '엔트리로 쓸 지식 검색(제목·본문)' });
  const results = el('div', { class: 'list-box', style: 'max-height:320px; overflow:auto; margin-top:10px;' });
  const back = overlayBox('엔트리 문서 지정 · ' + (cat.name || cat.key),
    el('p', { class: 'admin-hint', text: '카테고리를 열면 목록 대신 이 문서가 본문 영역에 보입니다(상단 바에서 목록 전환 가능).' }),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '문서 검색' }), qIn),
    results,
    cat.entry_name ? el('div', { class: 'ov-actions' },
      el('button', { class: 'btn btn-ghost btn-sm', text: '지정 해제(리스트로)',
        onclick: async () => {
          try { await saveCatView(cat, { entry_name: null, view_mode: 'list' }); toast('엔트리 지정을 해제했습니다'); back.remove(); onChanged(); }
          catch (e) { toast('해제 실패 — ' + e.message, true); }
        } })) : null);
  const pickRow = (e) => el('div', { class: 'row', role: 'button', tabindex: '0', style: 'cursor:pointer',
    onclick: async () => {
      try {
        await saveCatView(cat, { entry_name: e.name, view_mode: 'entry' });
        toast("'" + (e.title || e.name) + "' 을(를) 엔트리 문서로 지정했습니다");
        back.remove();
        onChanged();
      } catch (err) { toast('지정 실패 — ' + err.message, true); }
    } },
    el('div', { class: 'row-title', text: e.title || e.name }),
    el('div', { class: 'row-meta' }, el('span', { class: 'mono', text: e.name })));
  let t: any = null;
  async function search() {
    const q = qIn.value.trim();
    results.replaceChildren(skeletonRows(2));
    try {
      let entries: any[];
      if (q) {
        const r = await api('/api/ui/knowledge/search?' + new URLSearchParams({ q, limit: '15' }));
        entries = (r && r.entries) || [];
      } else {
        entries = (await knFetchCategoryRows(cat.id)).filter((e) => !e.is_folder).slice(0, 30);
      }
      entries = entries.filter((e) => !e.is_folder);
      if (!entries.length) { results.replaceChildren(el('div', { class: 'empty', text: '결과 없음' })); return; }
      results.replaceChildren(...entries.map(pickRow));
    } catch (err) { results.replaceChildren(errorNote(err, '검색 실패')); }
  }
  qIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 250); });
  setTimeout(() => { qIn.focus(); search(); }, 0);
}

// 지식 상세 #/k/<name> — (#592) 문서 페이지 셸: 좌 사이드바(트리 컨텍스트, ⟨ 접기·localStorage 기억) + 문서 캔버스(.kn-doc).
//  카드 렌더 본체는 knowledge-doc.ts buildKnowledgeDetail 로 이관(단일 소스 — 다음 단계의 피크/인라인도 같은 함수).
const KN_SIDE_COLLAPSE_KEY = 'kn-doc-side-collapsed';
async function renderKnowledgeDetail(view, name) {
  const side = el('aside', { class: 'kn-side' });
  const canvas = el('article', { class: 'kn-doc' });
  const collapseBtn = el('button', { class: 'kn-side-collapse', type: 'button',
    title: '사이드바 접기', 'aria-label': '사이드바 접기', text: '⟨' });
  const reopenBtn = el('button', { class: 'kn-side-reopen', type: 'button',
    title: '사이드바 펼치기', 'aria-label': '사이드바 펼치기', text: '⟩' });
  let collapsed = false;
  try { collapsed = localStorage.getItem(KN_SIDE_COLLAPSE_KEY) === '1'; } catch (_) { /* 프라이빗 모드 등 — 기본 펼침 */ }
  const shell = el('div', { class: 'kn-shell' + (collapsed ? ' side-off' : '') }, side, reopenBtn, canvas);
  const setSide = (off) => {
    shell.classList.toggle('side-off', off);
    try { localStorage.setItem(KN_SIDE_COLLAPSE_KEY, off ? '1' : '0'); } catch (_) { /* noop */ }
  };
  collapseBtn.onclick = () => setSide(true);
  reopenBtn.onclick = () => setSide(false);

  // 사이드바 내용 — 목록 뷰와 같은 구성(카테고리 트리 + Notion 페이지 트리). 클릭 = 목록으로 이동(필터).
  const nav = el('nav', { class: 'browse-tree', 'aria-label': '카테고리' });
  const mirrorBox = el('div', { class: 'kn-mirror-tree', hidden: true });
  side.append(el('div', { class: 'kn-side-head' }, el('div', { class: 'eyebrow', text: '카테고리' }), collapseBtn), nav, mirrorBox);
  side.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-cat-val]');
    if (!item) return;
    ev.preventDefault();
    const v = item.dataset.catVal || '';
    location.hash = v === KN_INDEXED ? '#/knowledge?indexed=1' : (v ? '#/knowledge?category=' + encodeURIComponent(v) : '#/knowledge');
  });

  view.replaceChildren(shell);
  buildKnowledgeDetail(canvas, name, { mode: 'page' });
  (async () => {
    try { buildSpacesNav(nav, await fetchAllSpaceCats(), '', myCatIdSet(), { indexed: true }); }
    catch (_) { /* graceful: 사이드바 트리 생략(문서는 계속) */ }
  })();
  loadMirrorTreeInto(mirrorBox);
}

async function knChangeLifecycle(name, lifecycle, view) {
  try {
    await api('/api/ui/knowledge/' + encodeURIComponent(name) + '/lifecycle', { method: 'POST', body: JSON.stringify({ lifecycle }) });
    toast(lifecycle === 'rejected' ? '반려했습니다' : (lifecycle === 'active' ? '복원했습니다' : '상태를 바꿨습니다'));
    renderKnowledgeDetail(view, name);
  } catch (e) {
    toast('상태 변경 실패 — ' + e.message, true);
  }
}

// (지식 삭제 knDelete 는 knowledge-doc.ts 로 이관 — 문서 캔버스 액션에서 사용, #592)

// 지식 생성·편집 — WIKI 탭의 단일 편집 표면(관리탭 'WIKI 인덱스' 흡수, 2026-06-24). 비파괴 upsert(POST /api/ui/knowledge):
//  주입·출처·핀·요약·기존 카테고리는 미전송 시 서버가 보존 → 편집이 다른 축을 망치지 않는다.
//  (org/memory 는 injection 을 recalled 로 강제 덮어써서 규칙·미러를 손상 → 쓰지 않음.)
// ════════════════════════════════════════════
// 위키 ↔ 프로젝트 연결 — 피커(openProjectChooser)·상세 섹션(knProjectLinks)은 knowledge-doc.ts 로 이관(#592).
//  여기(목록 일괄연결·생성 폼 스테이징)서는 import 해 재사용한다.
// ════════════════════════════════════════════

// ── 위키 생성 페이지(#255) — 모달이 아닌 별도 페이지. 폼 + 프로젝트 연결(복수, 필요/산출) 스테이징 후 저장 시 일괄 연결. ──
// 지식 작성/편집 — 별도 페이지(모달 아님, #290). editName 있으면 편집(기존 로드·프리필·파일명 고정·프로젝트 스테이징 생략),
//  없으면 신규(분류·유형 필수 + 프로젝트 연결 스테이징). 저장 후 상세(#/k/<name>)로 이동. 작성 페이지와 동일 UX.
export async function renderKnowledgeForm(view, params?, editName?) {
  if (!hasScope('memory')) { location.hash = '#/knowledge'; return; }   // 읽기전용 사용자는 목록으로
  const isEdit = !!editName;
  let k: any = {};
  if (isEdit) {
    try { k = await api('/api/ui/knowledge/' + encodeURIComponent(editName)).then((r) => r && (r.knowledge || r)); }
    catch (e) { toast('지식을 불러오지 못했습니다 — ' + e.message, true); location.hash = '#/k/' + encodeURIComponent(editName); return; }
    if (!k || !k.name) { toast('지식을 찾을 수 없습니다', true); location.hash = '#/knowledge'; return; }
    // (#335 ①) 항상-주입 섹션은 지식 편집페이지에서 못 고친다 — 관리탭 '세션 주입'이 단일 편집 홈.
    if (k.injection === 'always') { toast('항상-주입 섹션은 관리 ▸ 세션 주입에서 편집합니다'); location.hash = '#/system/injection-map'; return; }
  }

  const nameIn = el('input', { type: 'text', value: k.name || '', placeholder: '파일명 (소문자 영문·숫자·-, 비우면 제목에서 자동)' });
  if (isEdit) nameIn.disabled = true;   // 이름=식별자, 생성 후 불변
  const titleIn = el('input', { type: 'text', value: k.title || '', placeholder: '제목' });
  // (#335) injection 선택 폐기 — 지식은 항상 recalled. 항상-주입은 관리탭 '세션 주입' 섹션 문서로만(편집 시 미전송 → 서버 보존).
  const provSel = el('select', {},
    el('option', { value: 'authored', text: '저작 (기본)' }),
    el('option', { value: 'observed', text: '외부 미러' }));
  provSel.value = k.provenance || 'authored';
  // 분류(단일 필수) — value=key. 편집 시 현재 분류 key 프리셀렉트.
  const curCatKey = (Array.isArray(k.categories) ? k.categories.filter((c) => c.state !== 'rejected') : []).map((c) => c.key).filter(Boolean)[0] || '';
  const catSel = el('select', {}, el('option', { value: '', text: '— 분류 선택 —' }));
  loadCategoryKeysForSelect(catSel, curCatKey);
  const typeSel = knTypeSelect(k.type || '');   // #290 type 필수
  const bodyTa = el('textarea', { class: 'mem-edit-ta', rows: '16', placeholder: 'markdown 본문' });
  bodyTa.value = k.body_md || '';

  // 프로젝트 연결 스테이징 — 신규에서만(편집은 상세의 '연결된 프로젝트'에서 관리). 저장 전엔 모았다가 저장 후 일괄 link.
  const staged: any[] = [];
  const stagedList = el('div', { class: 'kn-staged-list' });
  const stagedKeys = () => staged.map((s) => s.id + ':' + s.relation);
  function paintStaged() {
    if (!staged.length) { stagedList.replaceChildren(el('div', { class: 'kn-cat-empty', text: '연결된 프로젝트가 없습니다 — 선택 사항입니다.' })); return; }
    stagedList.replaceChildren(...staged.map((s, i) => {
      const x = el('button', { class: 'kn-projchip-x', type: 'button', title: '제거', text: '✕' });
      x.onclick = () => { staged.splice(i, 1); paintStaged(); };
      return el('span', { class: 'kn-chip kn-projchip' },
        el('span', { class: 'kn-projlink-rel kn-projlink-rel-' + s.relation, text: KN_REL_LABEL[s.relation] }),
        el('span', { class: 'kn-projchip-link', text: s.name }), x);
    }));
  }
  const addProjBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 프로젝트 추가',
    onclick: () => openProjectChooser({
      title: '프로젝트 연결', actionLabel: '＋ 추가', doneLabel: '추가됨', initialPicked: stagedKeys(),
      onPick: async (proj, relation) => {
        if (staged.some((s) => s.id === proj.id && s.relation === relation)) return false;
        staged.push({ id: proj.id, name: proj.name, relation }); paintStaged(); return true;
      } }) });
  if (!isEdit) {
    paintStaged();
    // 플젝 페이지 '직접 작성'에서 넘어온 경우(?project=&relation=) — 그 프로젝트의 필요/산출 연결을 기본 채움.
    const preProj = params && params.get && params.get('project');
    const preRel = params && params.get && params.get('relation');
    if (preProj && (preRel === 'required' || preRel === 'produced')) {
      (async () => {
        try {
          const d = await api('/api/ui/v6/projects/' + encodeURIComponent(preProj)).then((r) => r && (r.project || r));
          if (d && d.id) { staged.push({ id: d.id, name: d.name, relation: preRel }); paintStaged(); }
        } catch (_) { /* graceful — 프로젝트를 못 찾으면 프리스테이징 생략 */ }
      })();
    }
  }

  const status = el('span', { class: 'admin-status' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: isEdit ? '저장' : '추가' });
  saveBtn.onclick = async () => {
    const body = bodyTa.value.trim();
    if (!body) { toast('본문을 입력하세요', true); return; }
    if (!catSel.value) { toast('분류를 선택하세요 (분류 1개 필수)', true); return; }
    if (!typeSel.value) { toast('유형(type)을 선택하세요 (type 필수)', true); return; }
    saveBtn.disabled = true; status.textContent = '저장 중…';
    try {
      const payload: any = { title: titleIn.value.trim() || undefined, body_md: body, provenance: provSel.value, category: catSel.value, type: typeSel.value };
      if (isEdit) payload.name = k.name;
      else if (nameIn.value.trim()) payload.name = nameIn.value.trim();
      const r = await api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify(payload) });
      const savedName = (r && r.knowledge && r.knowledge.name) || payload.name;
      if (!savedName) throw new Error('저장 응답에 이름이 없습니다');
      // 프로젝트 연결(신규·복수) — 부분 실패해도 나머지 진행.
      if (!isEdit && staged.length) {
        const res = await Promise.allSettled(staged.map((s) =>
          api('/api/ui/v6/projects/' + s.id + '/knowledge', { method: 'POST', body: JSON.stringify({ name: savedName, relation: s.relation }) })));
        const fail = res.filter((x) => x.status === 'rejected').length;
        if (fail) toast('지식은 저장됨 — 프로젝트 연결 ' + fail + '건 실패', true);
      }
      toast(isEdit ? '저장했습니다' : '지식을 추가했습니다');
      location.hash = '#/k/' + encodeURIComponent(savedName);   // 저장한 지식 상세로 이동
    } catch (e) { toast('저장 실패 — ' + e.message, true); saveBtn.disabled = false; status.textContent = ''; }
  };

  const head = el('div', { class: 'page-head' },
    el('div', { class: 'page-head-row' },
      el('h1', {}, '지식 ', el('span', { class: 'accent', text: isEdit ? '편집' : '작성' })),
      el('a', { class: 'btn btn-ghost btn-sm', href: isEdit ? ('#/k/' + encodeURIComponent(k.name)) : '#/knowledge', text: isEdit ? '← 상세로' : '← 목록으로' })),
    el('p', { class: 'sub', text: isEdit ? '이 지식의 내용을 수정합니다. 프로젝트 연결은 상세 페이지에서 관리합니다.' : '새 지식을 작성하고, 원하면 프로젝트의 필요/산출 지식으로 연결합니다(복수 프로젝트 가능).' }));
  const card = el('div', { class: 'card kn-create-card' },
    field('파일명', nameIn),
    field('제목', titleIn),
    field('출처(provenance)', provSel),
    field('카테고리 (필수)', catSel),
    field('유형/type (필수)', typeSel),
    field('본문', bodyTa),
    isEdit ? null : el('div', { class: 'field' },
      el('div', { class: 'field-label-row kn-create-projhead' },
        el('label', { class: 'field-label', text: '프로젝트 연결 (선택)' }), addProjBtn),
      stagedList),
    el('div', { class: 'admin-actions' }, saveBtn, status));
  view.replaceChildren(el('div', { class: 'kn-plain' }, head, knowledgeSubBar('browse'), card));   // doc-mode 자체 패딩(#592)
  applyReveal([card]);
  setTimeout(() => (isEdit ? bodyTa : titleIn).focus(), 0);
}

// 카테고리 셀렉터(value=key) — 저장 payload 의 category 파라미터가 key 라 id 가 아닌 key 를 값으로. 작성·편집 페이지(#255·#290) 공용.
//  preselectKey 주면 옵션 채운 뒤 그 분류를 선택(편집 시 현재 분류 복원).
async function loadCategoryKeysForSelect(sel, preselectKey?) {
  const spaces = [['business', '사업'], ['product', '제품'], ['system', '시스템']];
  await Promise.all(spaces.map(async ([sp, label]) => {
    try {
      const d = await api('/api/ui/categories?' + new URLSearchParams({ space: sp }));
      const cats = (d && d.categories) || [];
      if (!cats.length) return;
      const og = el('optgroup', { label });
      for (const c of cats) og.append(el('option', { value: c.key, text: c.name || c.key }));
      sel.append(og);
    } catch (_) { /* graceful */ }
  }));
  if (preselectKey) sel.value = preselectKey;
}

// ════════════════════════════════════════════
// 휴지통 #/trash — 삭제된 지식·프로젝트·카테고리를 한곳에서 보고 복원(공통 경로). 감사로그(deleted_list) 기반.
//  복원은 본체만 — 삭제 시 cascade 된 연결(카테고리/프로젝트/활동 링크)은 돌아오지 않는다. 사람 전용(서버 403 재검증).
// ════════════════════════════════════════════
const TRASH_ENTITY_LABEL = { knowledge: '지식', project: '프로젝트', category: '카테고리' };

async function renderTrash(view) {
  // doc-mode(main 패딩 0) 라우트라 kn-plain 래퍼로 기존 중앙 정렬 유지(#592).
  view.replaceChildren(el('div', { class: 'kn-plain' }, skeleton('삭제된 항목을 불러오는 중')));
  let entries: any[] = [];
  try {
    entries = await api('/api/ui/deleted').then((d) => (d && d.entries) || []);
  } catch (e) {
    view.replaceChildren(el('div', { class: 'kn-plain' }, errorNote(e, '휴지통을 불러오지 못했습니다')));
    return;
  }
  const head = el('div', { class: 'page-head' },
    el('h1', {}, '휴지', el('span', { class: 'accent', text: '통' })),
    el('p', { class: 'sub', text: '삭제된 지식·프로젝트·카테고리입니다. 감사 스냅샷으로 보존되어 복원할 수 있습니다(본체만 — 삭제 시 정리된 연결은 복원되지 않습니다).' }),
  );
  const list = el('div', { class: 'list' });
  if (!entries.length) {
    list.append(el('div', { class: 'note', text: '삭제된 항목이 없습니다.' }));
  } else {
    for (const e of entries) list.append(trashRow(e, view));
  }
  view.replaceChildren(el('div', { class: 'kn-plain' }, head, list));
  applyReveal([list]);
}

function trashRow(e, view) {
  const restoreBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '복원',
    onclick: async () => {
      restoreBtn.disabled = true;
      try {
        await api('/api/ui/deleted/restore', { method: 'POST', body: JSON.stringify({ entity: e.entity, key: e.key }) });
        toast('복원했습니다');
        renderTrash(view);
      } catch (err) {
        restoreBtn.disabled = false;
        toast('복원 실패 — ' + err.message, true);
      }
    } });
  const who = (e.actor ? '  · ' + e.actor : '') + (e.actor_kind ? ' (' + (e.actor_kind === 'ai' ? 'AI' : '사람') + ')' : '');
  const left = el('div', {},
    el('div', { class: 'row-title' },
      el('span', { class: 'kn-chip', text: TRASH_ENTITY_LABEL[e.entity] || e.entity }), '  ',
      el('span', { text: e.label || e.key })),
    el('div', { class: 'row-meta' }, el('span', { class: 'mono', text: e.key }), '  삭제: ', relTime(e.at), who),
  );
  return el('div', { class: 'row', style: 'display:flex; align-items:center; justify-content:space-between; gap:12px;' }, left, restoreBtn);
}

// ════════════════════════════════════════════
// #290 지식↔지식 링크 패널·자료 상세·라벨은 knowledge-doc.ts 로 이관(#592) — 여기선 미러 트리(사이드바)만.
// ════════════════════════════════════════════

// ── #551 노션 무손실 미러 — 사이드바 페이지 트리 ──
// 사이드바 '페이지 트리' — 외부 미러(knowledge-tree API) 스켈레톤을 재귀 <details> 로. 클릭=상세 이동.
//  summary 안 앵커: preventDefault 로 토글 억제 후 해시 이동(토글은 ▸ 마커/여백 클릭).
function knMirrorTreeNode(e, byParent) {
  const kids = (byParent.get(e.name) || []);
  const link = el('a', {
    class: 'tree-label kn-tree-link' + (e.lifecycle === 'archived' ? ' kn-tree-archived' : ''),
    href: '#/k/' + encodeURIComponent(e.name), title: e.title || e.name,
    text: e.title || e.name });
  link.addEventListener('click', (ev) => { ev.preventDefault(); location.hash = '#/k/' + encodeURIComponent(e.name); });
  if (!kids.length) {
    return el('div', { class: 'tree-item kn-tree-leaf' },
      el('span', { class: 'tree-glyph', 'aria-hidden': 'true', text: knTreeIcon(e.kind) }), link);
  }
  const det = el('details', { class: 'kn-tree-branch' },
    el('summary', { class: 'tree-item kn-tree-sum' },
      el('span', { class: 'tree-glyph', 'aria-hidden': 'true', text: knTreeIcon(e.kind) }), link,
      el('span', { class: 'tree-groupcount', text: String(kids.length) })));
  const kidBox = el('div', { class: 'kn-tree-kids' });
  for (const c of kids) kidBox.append(knMirrorTreeNode(c, byParent));
  det.append(kidBox);
  return det;
}

function buildMirrorTree(entries) {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const byParent = new Map();
  const roots: any[] = [];
  for (const e of entries) {
    const p = e.parent_name && byName.has(e.parent_name) ? e.parent_name : '';
    if (!p) { roots.push(e); continue; }
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(e);
  }
  const bySort = (a, b) => (a.sort - b.sort) || String(a.title || a.name).localeCompare(String(b.title || b.name));
  roots.sort(bySort);
  for (const arr of byParent.values()) arr.sort(bySort);
  const box = el('div', { class: 'kn-mirror-nodes' });
  for (const r of roots) box.append(knMirrorTreeNode(r, byParent));
  return box;
}

// 자료(source) 탭 — raw 입력 인박스. kind/provenance/q 필터. 클릭 = 상세 오버레이(knowledge-doc.openSourceDetail).
async function renderSources(view, _params?) {
  const head = pageHead('자료', '회의록·이메일·슬랙처럼 아직 정리하기 전의 원본입니다. 여기서 다듬으면 지식이 됩니다.', [], '료');
  const kindSel = selectFilter([['', '전체 종류'], ...Object.entries(SOURCE_KIND_LABEL)], '');
  kindSel.setAttribute('aria-label', '종류');
  const provSel = selectFilter([['', '전체 출처'], ['authored', '캡처'], ['observed', '외부 미러']], '');
  provSel.setAttribute('aria-label', '출처');
  const qIn = el('input', { type: 'search', placeholder: '제목·본문 검색', 'aria-label': '검색' });
  const listBox = el('div', { class: 'list-box' });
  const foot = el('div', { class: 'list-foot' });
  view.replaceChildren(el('div', { class: 'kn-plain' },   // doc-mode 자체 패딩(#592)
    head, knowledgeSubBar('sources'), el('div', { class: 'filter-bar' }, qIn, kindSel, provSel), listBox, foot));
  async function refetch() {
    listBox.replaceChildren(skeletonRows(4)); foot.replaceChildren();
    try {
      const p = new URLSearchParams();
      if (kindSel.value) p.set('kind', kindSel.value);
      if (provSel.value) p.set('provenance', provSel.value);
      if (qIn.value.trim()) p.set('q', qIn.value.trim());
      const r = await api('/api/ui/sources' + (p.toString() ? '?' + p.toString() : ''));
      const entries = (r && r.entries) || [];
      if (!entries.length) { listBox.replaceChildren(el('div', { class: 'empty', text: '자료가 없습니다. 커넥터(이메일·슬랙)나 회의록이 여기로 들어옵니다.' })); return; }
      listBox.replaceChildren(...entries.map(srcRow));
      foot.replaceChildren(el('span', { class: 'caption', text: entries.length + '건' }));
    } catch (e) { listBox.replaceChildren(errorNote(e, '자료를 불러오지 못했습니다')); }
  }
  let t: any = null;
  qIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(refetch, 250); });
  kindSel.addEventListener('change', refetch);
  provSel.addEventListener('change', refetch);
  refetch();
}

function srcRow(s) {
  const row = el('div', { class: 'row', role: 'button', tabindex: '0', style: 'cursor:pointer' },
    el('div', { class: 'row-title', text: s.title || ('자료 #' + s.id) }),
    el('div', { class: 'row-meta' },
      el('span', { class: 'kn-chip kn-source-kind', text: SOURCE_KIND_LABEL[s.kind] || s.kind }), ' ',
      knProvChip(s.provenance), '  ', relTime(s.occurred_at || s.updated_at)));
  const open = () => openSourceDetail(s.id);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
  return row;
}

export {
  SOURCE_KIND_LABEL,
  SPACE_LABEL,
  SPACE_SUBS,
  buildSpacesNav,
  fetchAllSpaceCats,
  knInjectChip,
  knProvChip,
  knRow,
  knSideItem,
  knowledgeSubBar,
  myCatIdSet,
  openCategoryForm,
  renderKnowledge,
  renderKnowledgeDetail,
  renderKnowledgeSpace,
  renderTrash,
  spaceSubBar,
  srcRow,
};
