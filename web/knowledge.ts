// knowledge.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
//  (#592) 문서 캔버스·속성 시스템·상세 패널·칩 생성기는 knowledge-doc.ts 로 이관 — 여기서 import 해 재사용/재수출.
import { api, applyReveal, el, errorNote, lifecycleDot, pageHead, relTime, selectFilter, state, sv, toast } from './core.js';
import { overlayBox, skeleton, skeletonRows } from './learn.js';
import { hasScope } from './admin.js';
import { KN_TYPE_LABEL, SOURCE_KIND_LABEL, SPACE_LABEL, buildKnowledgeDetail, knAuthorChip, knFetchAuthoredTree, knFetchCategoryRows, knFolderFirstSort, knInjectChip, knInvalidateTreeCaches, knPageIcon, knProvChip, knTreeIcon, knTypeChip, openKnowledgePeek, openProjectChooser, openQuickSearch, openSourceDetail, reanchorKnowledgePeek } from './knowledge-doc.js';
import { renderKnowledgeForm } from './knowledge-edit.js';   // #657 노션형 작성/편집 페이지(이관)
import { buildCategoryHome, isCategoryHomeDoc } from './category-home.js';   // #657 카테고리 대문(#658·#659)
import { applyCoverBg, defaultCoverFor } from './page-decor.js';             // #657 갤러리 카드 커버


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

// 지식 그래프 버튼 — 도메인으로 묶은 지식 지도(풀스크린 새 창 graph.html, #290 아틀라스). 지식 페이지 헤더 액션에서 사용.
//  (#614) 구 knowledgeSubBar(지식/자료 동급 탭 바)를 폐지 — 지식이 WIKI 화면의 유일한 주(主) 뷰가 되고,
//  자료는 동급 탭이 아니라 헤더의 보조 버튼(→ #/knowledge/sources)으로 강등. 그래프도 동일하게 헤더 버튼으로 이동.
function knGraphBtn() {
  return el('button', { class: 'btn btn-ghost btn-sm kn-graph-btn', type: 'button', role: 'link',
    title: '도메인으로 묶은 지식 지도 — 풀스크린 새 창에서 팬·줌으로 탐색', onclick: openKnowledgeAtlas },
    sv('svg', { class: 'sub-graph-ic', viewBox: '0 0 24 24', width: '14', height: '14', 'aria-hidden': 'true' },
      sv('circle', { cx: '6', cy: '7', r: '2.4', fill: 'currentColor' }),
      sv('circle', { cx: '17', cy: '6', r: '2', fill: 'currentColor', opacity: '0.7' }),
      sv('circle', { cx: '13', cy: '17', r: '2.2', fill: 'currentColor', opacity: '0.85' }),
      sv('path', { d: 'M7.8 8.2 11.4 15.4M15.2 7.3 13.7 14.9', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', opacity: '0.5' })),
    ' 지식 그래프');
}

// 자료(보조 입력층) 진입 버튼 — 지식과 동급이 아니라 '덜 중요한 보조'(#614). 헤더에서 작은 고스트 버튼으로.
function knSourcesBtn() {
  return el('a', { class: 'btn btn-ghost btn-sm kn-sources-link', href: '#/knowledge/sources',
    title: '회의록·이메일·슬랙 등 정제 전 원본 자료 — 지식과 분리된 보조 입력', text: '🗂 자료' });
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
// (#657) 지식 작성/편집 폼은 knowledge-edit.ts(노션형 페이지 에디터)로 이관 — 아래에서 재수출.

// 지식 한 행 — 제목(상세 링크) + 작성 주체(AI/사람) 칩 + provenance 칩 + lifecycle 점 + 갱신시각.
//  (#449) 주입(injection) 칩 제거 — 지식 탭은 recalled 전용이라 매 행 '검색'으로 반복돼 무의미. 대신 작성 주체 칩 노출.
//  select={names:Set, onToggle} 가 오면 선택(체크) 모드 — 클릭=상세이동 대신 선택 토글, .row.sel 로 표시.
//  open(#592, 선택): 클릭 콜백 — 지식탭은 전체 페이지 이동 대신 피크/드릴다운으로. 미전달 시 기존 상세 이동.
function knRow(e, select?, open?) {
  // #657r 카탈로그 엔트리 — 좌측 프로벤넌스 스파인(사람 저작=리빙그린 rail, data-author) + 제목 + 조용한 mono 메타.
  //  칩 더미(작성주체·출처·유형·상태 반복 pill)를 걷어내 제목이 위계를 갖게 한다. 상세 메타는 문서 페이지에.
  //  아이콘은 커스텀(props_ui.icon)·폴더만 노출 — 기본 문서 📄 는 생략(잉여 장식).
  const ic = e.icon || (e.is_folder ? '📁' : '');
  const titleEl = el('div', { class: 'row-title' },
    ic ? el('span', { class: 'row-ic', 'aria-hidden': 'true', text: ic }) : null,
    el('span', { class: 'row-titletext', text: e.title || e.name }));
  const metaEl = el('div', { class: 'row-meta' },
    e.is_wiki ? el('span', { class: 'row-m row-m-pin', title: 'WIKI 인덱스에 핀됨 — 매 대화 첫머리에 항상 깔립니다.', text: '인덱스' }) : null,
    e.type ? el('span', { class: 'row-m row-m-type', text: KN_TYPE_LABEL[e.type] || e.type }) : null,
    e.confidence === 'human' ? el('span', { class: 'row-m row-m-human', title: '사람이 직접 작성', text: '사람' }) : null,
    e.provenance === 'observed' ? el('span', { class: 'row-m row-m-mirror', title: '외부 시스템 미러', text: '미러' }) : null,
    el('span', { class: 'row-m row-m-time', text: relTime(e.updated_at) }));
  // 의미검색/grep 결과의 매치 스니펫(있을 때만 — 목록 페치엔 없음). 한 줄로 정리.
  const snipEl = e.snippet ? el('div', { class: 'row-snip', text: String(e.snippet).replace(/\(\+\d+ matches\)[^\n]*/g, '').replace(/L\d+:\s*/g, '').replace(/[\n⋯]+/g, ' · ').replace(/\s+/g, ' ').trim().slice(0, 200) }) : null;
  // data-author = 프로벤넌스 스파인 색(human=리빙그린). data-folder = 폴더 행 표식.
  const dataset = { 'data-author': e.confidence || '', 'data-prov': e.provenance || '', ...(e.is_folder ? { 'data-folder': '1' } : {}) };
  if (!select) {
    const row = el('div', { class: 'row', role: 'link', tabindex: '0', ...dataset }, titleEl, metaEl, snipEl);
    const go = () => { if (open) open(e); else location.hash = '#/k/' + encodeURIComponent(e.name); };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    return row;
  }
  // 선택 모드 — 행 전체가 토글(체크박스는 pointer-events:none 표시용).
  const on0 = select.names.has(e.name);
  const cb = el('input', { type: 'checkbox', class: 'row-check', tabindex: '-1', 'aria-hidden': 'true' });
  cb.checked = on0;
  const row = el('div', { class: 'row row-pick' + (on0 ? ' sel' : ''), role: 'button', tabindex: '0', 'aria-pressed': String(on0), ...dataset },
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
  if (f.catTab === undefined) f.catTab = 'auto';      // #657w 카테고리 탭 — 대문(home)|문서(docs). auto=대문 내용 있으면 대문
  // 파라미터 없는 진입(#req) = 상단 WIKI 탭 클릭 등 '맨 진입' — 전체(위키 홈 카드)로 리셋. f 는 세션 전역(state.knowledge)이라
  //  안 그러면 이전에 고른 카테고리·검색이 그대로 복원돼, WIKI 탭을 눌렀는데 그 카테고리 대문이 나온다(놀람).
  //  카테고리·검색 딥링크(?category=·?q= 등)만 상태를 이어받는다 — 카테고리 보던 중 새로고침·피크 뒤로가기는
  //  syncHash(replaceState)가 쿼리를 유지하므로 리셋되지 않고 그대로 복원된다.
  if (!params || Array.from(params.keys()).length === 0) {
    f.category = ''; f.folder = ''; f.indexed = false; f.q = ''; f.injection = ''; f.provenance = ''; f.type = ''; f.catTab = 'auto';
  }
  if (params) {
    // category 와 indexed 는 상호배타(인덱스 = '전체 카테고리에서 핀만'). 외부 category 링크는 indexed 를 끈다.
    if (params.has('category')) { f.category = params.get('category') || ''; f.indexed = false; f.folder = ''; f.catTab = 'auto'; }
    if (params.has('tab')) f.catTab = params.get('tab') === 'docs' ? 'docs' : 'home';   // #657w 딥링크 복원
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
  view.replaceChildren(el('div', { class: 'kn-plain' }, skeleton('지식을 불러오는 중')));

  // 선택(일괄삭제) 상태 — 리페치 없이 로컬 재페인트. names = 선택된 지식 name 집합.
  const sel = { mode: false, names: new Set() };
  let lastEntries: any[] = [];
  const bulkBar = el('div', { class: 'bulk-bar', hidden: true });
  const selectBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '선택', title: '여러 지식을 골라 한 번에 삭제',
    onclick: () => {
      sel.mode = !sel.mode;
      if (!sel.mode) sel.names.clear();
      if (sel.mode && curCat() && f.catTab !== 'docs') setCatTab('docs');   // #657w 선택은 목록 작업 — 문서 탭으로
      refetch();   // 홈(#657h)에서도 전체 목록으로 전환되게 refetch
    } });

  // (#req) 상단 큰 제목·부제 제거 — WIKI 탭 자체가 정체성이라 군더더기. 액션(＋새 페이지·선택·그래프·자료·휴지통)만 남긴다.
  const head = pageHead('', null, [
    hasScope('memory') ? el('a', { class: 'btn btn-primary btn-sm', href: '#/knowledge/new',
      title: '새 페이지를 작성합니다 — 노션처럼 바로 타이핑', text: '＋ 새 페이지' }) : null,
    selectBtn,
    knGraphBtn(),
    knSourcesBtn(),
    el('a', { class: 'btn btn-ghost btn-sm', href: '#/trash', text: '🗑 휴지통' }),
  ]);

  // 좌측 카테고리 사이드바 — 3 space 통합(우리 팀 상단 펼침 ★ + space별 접이식). 클릭 = 필터(category_id).
  //  (#592) .kn-shell 의 고정 260px 자체 스크롤 컬럼(.kn-side) — 내용(buildSide)은 기존 그대로.
  const side = el('aside', { class: 'kn-side' });
  const nav = el('nav', { class: 'browse-tree', 'aria-label': '카테고리' });
  const myIds = myCatIdSet();
  let bySpace: any = { business: [], product: [], system: [] };
  try { bySpace = await fetchAllSpaceCats(); } catch (_) { /* graceful: 사이드바 생략(목록은 계속) */ }
  // #551 페이지 트리(외부 미러) — 카테고리 아래 별도 섹션. 비동기 로드(없으면 숨김 유지).
  const mirrorBox = el('div', { class: 'kn-mirror-tree', hidden: true });
  // (#req) 사이드바 분류 검색 — 프로젝트 탭(폴더·리스트 검색) 동형. '카테고리' 헤더 맨 위 → 그 아래 검색창 → 트리.
  //  트리를 즉시 필터(분류 이름 부분일치, 대소문자 무시) — 매칭 없는 space 섹션은 숨김. 전문 지식검색은 ⌘K/상단 필터.
  const knSideState = { q: '' };   // 사이드바 분류 검색어(재빌드 사이 유지) — 모듈 헬퍼(knMakeSideSearch/knSideFilterNav) 공용.
  function buildSide() {
    // 사이드바 선택값 = 인덱스면 센티넬, 아니면 카테고리 id. opts.indexed 로 '전체' 하위에 인덱스(핀) 항목 노출(지식 탭 전용, #336).
    const selKey = f.indexed ? KN_INDEXED : f.category;
    buildKnowledgeNav(nav, bySpace, selKey, myIds,
      { indexed: true, onOpen: (name) => openKnowledgePeek(name, { onRefresh: refetch }) });
    // 헤더('지식 카테고리') 맨 위 → 검색창 → 트리 — 프로젝트 탭 사이드바(.pjv-side-nav-head/.pjv-side-search)와 동일 컴포넌트(#req).
    side.replaceChildren(
      el('div', { class: 'pjv-side-nav-head' }, el('span', { class: 'pjv-side-nav-head-label', text: '지식 카테고리' })),
      knMakeSideSearch(nav, knSideState), nav, mirrorBox);
    knSideFilterNav(nav, knSideState.q);   // 재빌드 후에도 필터 유지
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

  // #657 카테고리 대문 — 구 kn-cathead(이름·설명 한 줄)를 노션형 대문(커버·아이콘·제목·설명·꾸밈 본문)으로 교체.
  function paintCatHead() {
    const cat = curCat();
    if (!cat) { catBox.replaceChildren(); catBox.hidden = true; applyTabVisibility(); return; }
    catBox.hidden = false;
    const actions = el('div', { class: 'kn-cathead-actions' });
    if (hasScope('memory')) {
      // 대문 액션은 전부 조용한 고스트 — 화면당 하나의 채운 primary 는 상단 헤더의 '＋ 새 페이지'(#657r).
      actions.append(el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge/new?category=' + encodeURIComponent(cat.key),
        title: '이 카테고리에 새 페이지를 작성합니다', text: '＋ 새 페이지' }));
      actions.append(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 폴더',
        title: '이 카테고리에 폴더(문서를 묶는 트리 그룹)를 만듭니다',
        onclick: () => openFolderForm(cat, f.folder, () => { buildSide(); refetch(); }) }));
    }
    if (hasScope('context')) {   // category_view_set 은 context 스코프 — 권한 없으면 메뉴 자체 미노출
      const viewBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '⚙ 보기',
        title: '이 카테고리 본문 보기 방식(리스트/테이블/갤러리/엔트리)' });
      viewBtn.onclick = () => openCatViewMenu(actions, viewBtn, cat, () => { entryListMode = false; paintList(); });
      actions.append(viewBtn);
    }
    catBox.replaceChildren();
    buildCategoryHome(catBox, cat, {
      actions: [actions],
      onCatChanged: () => buildSide(),
      tab: f.catTab,                       // 'auto'|'home'|'docs' — 대문이 내용 기준으로 해석 후 onTab 콜백
      onTab: (t) => setCatTab(t),
      docsCount: lastEntries.length || null,
    });
  }

  // 행 열기(#592) — 카테고리 안 폴더는 드릴다운(브레드크럼), 그 외(문서·전체 뷰의 폴더)는 피크(폴더 피크=자식 목록).
  function openRow(e) {
    if (e.is_folder && curCat()) { f.folder = e.name; syncHash(); refetch(); return; }
    openKnowledgePeek(e.name, { onRefresh: refetch });
  }

  // ── #657h 위키 홈 — '전체'(무필터) 진입 시: 카테고리 카드(클릭=대문) + 우리 팀 최근 지식(캡 8건). ──
  //  '전체 지식 보기'를 누르면 browseAll 로 기존 전체 목록. 검색어/출처/유형 필터·선택 모드는 자동으로 목록 전환.
  let browseAll = false;
  const HOME_RECENT_CAP = 8;
  function isHome() {
    return !browseAll && !f.category && !f.indexed && !f.folder && !f.q.trim() && !f.provenance && !f.type && !sel.mode;
  }
  // 사이드바/카드 공용 카테고리 선택 — 카드 클릭 = 대문 진입(paintCatHead 가 대문을 그린다).
  function selectCategory(v) {
    browseAll = false;
    f.indexed = v === KN_INDEXED;
    f.category = f.indexed ? '' : v;
    f.folder = '';              // 카테고리 전환 = 드릴다운 해제(#592)
    f.catTab = 'auto';          // #657w 새 진입 = 대문 우선(내용 없으면 문서로 자동)
    entryListMode = false;      // entry '목록 보기' 일시 토글도 리셋
    buildSide(); paintCatHead(); syncHash(); refetch();
  }

  // ── #657w 카테고리 탭 — 대문(home) ⇄ 문서(docs). 탭 상태·가시성은 여기(단일 소유), 스트립 DOM 은 대문이 렌더. ──
  function applyTabVisibility() {
    const inCat = !!curCat();
    const homeTab = inCat && f.catTab !== 'docs';
    listBox.hidden = homeTab;
    foot.hidden = homeTab;
    if (homeTab) bulkBar.hidden = true; else repaintBulk();
  }
  function setCatTab(t) {
    f.catTab = t;
    const wrap = catBox.querySelector('.cath');
    if (wrap) wrap.classList.toggle('cath-mode-docs', t === 'docs');
    catBox.querySelectorAll('.cath-tab-btn').forEach((b: any) => b.classList.toggle('on', b.dataset.tab === t));
    applyTabVisibility();
    syncHash();
  }
  async function paintHome(quiet = false) {
    if (!quiet) listBox.replaceChildren(skeletonRows(3));   // 재정렬 등 캐시 재렌더(quiet)는 스켈레톤 깜빡임 생략
    foot.replaceChildren();
    // 카테고리 나열 — 우리 팀 먼저, 나머지 뒤. 각 그룹 안 순서는 사용자 드래그(#657h3, 기기별)를 반영, 미지정은 space 순서.
    const all: any[] = [];
    for (const sk of ['business', 'product', 'system']) for (const c of (bySpace[sk] || [])) all.push(c);
    const savedOrder = knHomeOrderSaved();
    const mine = knHomeSortByOrder(all.filter((c) => myIds.has(String(c.id))), savedOrder);
    const rest = knHomeSortByOrder(all.filter((c) => !myIds.has(String(c.id))), savedOrder);
    const ordered = [...mine, ...rest];
    // 카테고리별 rows(세션 캐시 공유 — 사이드바 펼침과 동일 소스). 대문 문서(icon/cover)·문서 수·최근 지식이 전부 여기서 나온다.
    const rowsPer = await Promise.all(ordered.map((c) => knFetchCategoryRows(c.id).catch(() => [])));
    // #657h3 카드 드래그 정렬 — 대시보드 개요 카드와 같은 UX. 그룹(우리 팀 / 그 외) '안'에서만 재정렬(그룹 경계=오너십).
    const curOrderIds = ordered.map((c) => String(c.id));
    const onReorder = (dragId: string, targetId: string, after: boolean) => {
      knHomeSaveOrder(knHomeReorder(curOrderIds, dragId, targetId, after));
      paintHome(true);
    };
    // 정렬 컨트롤 — 커스텀 순서가 있으면 '초기화', 없으면 드래그 안내(발견성). 첫 그룹 라벨 우측에만.
    const orderControl = () => (savedOrder.length
      ? el('button', { class: 'kn-home-orderreset', type: 'button', title: '카드 순서를 기본값으로 되돌립니다',
          text: '정렬 초기화', onclick: () => { knHomeClearOrder(); paintHome(true); } })
      : el('span', { class: 'kn-home-orderhint', 'aria-hidden': 'true', text: '드래그해서 순서 변경' }));
    // #657h2 우리 팀 우선을 '보이게' — 사이드바와 같은 ★ 그룹 어휘로 카드 그리드를 이분(팀 미소속이면 단일 그리드).
    //  ★오너십=우선순위 표시일 뿐 접근제한 아님(사이드바 불변식 동일).
    const cardAt = (c: any, i: number, group: string) => {
      const rows = rowsPer[i];
      const home = rows.find((r) => isCategoryHomeDoc(r.name));
      const docs = rows.filter((r) => !isCategoryHomeDoc(r.name) && !r.is_folder);
      return knHomeCatCard(c, home, docs.length, myIds.has(String(c.id)), () => selectCategory(String(c.id)), { group, onReorder });
    };
    // (#req) 우리 팀/그 외 구분을 '확실하게' — 작은 별·작은 글씨 폐기. 큰 섹션 헤더 + 팀 카드엔 '우리 팀' 라벨(카드 위).
    const secHead = (cls: string, title: string, sub: string | null, count: number, ctrl?: any) =>
      el('div', { class: 'kn-home-sechead2 ' + cls },
        el('div', { class: 'kn-home-sechead2-main' },
          el('span', { class: 'kn-home-sechead2-title', text: title }),
          el('span', { class: 'kn-home-sechead2-count', text: String(count) + '개 분류' }),
          sub ? el('span', { class: 'kn-home-sechead2-sub', text: sub }) : null),
        ctrl || null);
    const cardParts: any[] = [];
    if (mine.length) {
      cardParts.push(secHead('is-mine', '우리 팀 담당', '우리 팀이 소유·관리하는 분류', mine.length, orderControl()));
      const gm = el('div', { class: 'kn-home-cats' });
      mine.forEach((c, i) => gm.append(cardAt(c, i, 'mine')));
      cardParts.push(gm);
      if (rest.length) {
        // (#req) 기본은 우리 팀 카드만. '그 외'는 접어두고 '모든 카테고리 다 보기 →'로 펼친다.
        const gr = el('div', { class: 'kn-home-cats' });
        rest.forEach((c, j) => gr.append(cardAt(c, mine.length + j, 'rest')));
        const restWrap = el('div', { class: 'kn-home-restwrap', hidden: true },
          secHead('is-rest', '그 외 카테고리', null, rest.length), gr);
        const moreBtn = el('button', { class: 'kn-home-morecats', type: 'button', title: '숨긴 그 외 카테고리를 펼칩니다' },
          el('span', { text: '모든 카테고리 다 보기 (' + rest.length + ')' }),
          el('span', { class: 'kn-home-morecats-arrow', 'aria-hidden': 'true', text: '→' }));
        const moreRow = el('div', { class: 'kn-home-morerow' }, moreBtn);
        moreBtn.onclick = () => { restWrap.hidden = false; moreRow.hidden = true; };
        cardParts.push(moreRow, restWrap);
      }
    } else {
      cardParts.push(secHead('is-rest', '카테고리', null, ordered.length, orderControl()));
      const grid = el('div', { class: 'kn-home-cats' });
      ordered.forEach((c, i) => grid.append(cardAt(c, i, 'all')));
      cardParts.push(grid);
    }
    // 우리 팀 최근 지식(팀 미소속이면 전체) — 최신순 캡. 폴더·대문 제외.
    const poolRows = mine.length ? rowsPer.slice(0, mine.length) : rowsPer;
    const pool: any[] = [];
    for (const rows of poolRows) for (const r of rows) if (!isCategoryHomeDoc(r.name) && !r.is_folder) pool.push(r);
    pool.sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime());
    const recent = pool.slice(0, HOME_RECENT_CAP);
    lastEntries = recent;
    const sechead = el('div', { class: 'kn-home-sechead' },
      el('span', { class: 'kn-home-sectitle', text: mine.length ? '우리 팀 최근 지식' : '최근 지식' }),
      el('button', { class: 'kn-home-all', type: 'button', title: '카테고리 구분 없이 전체 지식을 최신순으로 봅니다',
        text: '전체 지식 보기 →', onclick: () => { browseAll = true; refetch(); } }));
    const recentBox = el('div', { class: 'list-box browse-list kn-home-list' },
      ...(recent.length ? recent.map((e) => knRow(e, null, openRow))
        : [el('div', { class: 'empty', text: '아직 지식이 없습니다 — 위의 ＋ 새 페이지로 시작해 보세요.' })]));
    listBox.replaceChildren(...cardParts, sechead, recentBox);
    repaintBulk();
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
      if (f.catTab === 'docs') p.set('tab', 'docs'); // #657w 문서 탭 딥링크(대문=기본이라 생략)
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
    // #657 갤러리 — 브라우저 로컬 보기 오버라이드(서버 view_mode 는 list|table|entry 그대로).
    let mode = (cat && !searching && !sel.mode) ? (knCatGalleryOn(cat) ? 'gallery' : (cat.view_mode || 'list')) : 'list';
    if (mode === 'entry' && (entryListMode || !cat.entry_name)) mode = 'list';
    const parts: any[] = [];
    // entry 지정 카테고리 — 상단 얇은 바(엔트리 문서 ⇄ 항목 N개 목록 토글). 검색/선택/갤러리 모드에선 생략.
    if (cat && !searching && !sel.mode && !knCatGalleryOn(cat) && (cat.view_mode || 'list') === 'entry' && cat.entry_name) {
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
    } else if (mode === 'gallery') {
      parts.push(knGallery(lastEntries, openRow));
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
          .filter((e) => !isCategoryHomeDoc(e.name))   // #657 대문 문서는 목록에서 숨김
          .sort(knFolderFirstSort);
        const present = new Set(lastEntries.map((e) => e.name));
        sel.names.forEach((nm) => { if (!present.has(nm)) sel.names.delete(nm); });
        paintList();
        repaintBulk();
        foot.replaceChildren(el('span', { class: 'caption', text: lastEntries.length + '건 · 폴더 안' }));
        return;
      }
      // #657h 위키 홈 — 무필터 '전체' 진입은 카테고리 카드 + 우리 팀 최근으로.
      if (isHome()) { await paintHome(); return; }
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
      entries = entries.filter((e) => !isCategoryHomeDoc(e.name));   // #657 카테고리 대문 문서는 항상 숨김(대문 영역이 표면)
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
      // #657w 대문 탭 스트립의 문서 수 배지 갱신 + 탭 가시성 재적용.
      const cnt = catBox.querySelector('.cath-tab-count');
      if (cnt) cnt.textContent = String(entries.length);
      applyTabVisibility();
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
    // 인덱스 센티넬이면 f.indexed 토글(category 비움), 아니면 일반 카테고리(#336). 홈 카드와 동일 경로(selectCategory).
    selectCategory(item.dataset.catVal || '');
  });

  // 검색 + 검색방식을 한 캡슐로(#req 가독성) — '의미검색' 셀렉트가 검색창 옆에 따로 떠 별개 버튼처럼 보이던 것을
  //  검색창 오른쪽에 도킹(구분선)해 '검색의 방식'임이 읽히게 한다.
  const searchGroup = el('div', { class: 'kn-search-group' }, qInput, modeSel);
  const filterBar = el('div', { class: 'filter-bar browse-filter' }, searchGroup, provSel, typeSel);
  // (#592) .kn-shell — 사이드바(260px, border-right, 자체 스크롤) + 콘텐츠(flex1, 자체 패딩). 헤더·서브탭도 콘텐츠 컬럼 안으로.
  const layout = el('div', { class: 'kn-shell' },
    side,
    el('section', { class: 'kn-main' }, head, catBox, bulkBar, listBox, foot),   // (#req) 상단 제목·본문 검색 필터바 제거 — 사이드바 검색 + ⌘K 로 대체
  );
  knApplySideW(layout); layout.append(knSideResizeHandle(layout)); // (#670) 프로젝트 탭과 동일 폭 조절 핸들(같은 --pjv-side-w / localStorage 'pjv:sideW')
  view.replaceChildren(layout);
  applyReveal([layout]);
  paintCatHead();
  refetch();
  // #592 peek 파라미터 — URL 직접 진입/뒤·앞으로가기 복원 시 피크 자동 오픈(pushState 없이 현 URL 그대로).
  const peekName = params && params.get && params.get('peek');
  if (peekName) openKnowledgePeek(peekName, { fromUrl: true, onRefresh: refetch });
}

// (#670) WIKI 사이드바 폭 조절 — 프로젝트 탭(.pjv-side-resize)과 동일 UX·같은 localStorage('pjv:sideW') 공유 → 두 탭이 항상 같은 폭.
//  .kn-side 는 자체 스크롤(overflow)이라 그 안 절대배치는 클립됨 → 비스크롤 셸(.kn-shell) 자식으로 두고 사이드바 우측 경계에 얹는다.
function knSideResizeHandle(shell: HTMLElement) {
  const h = el('div', { class: 'kn-side-resize', title: '드래그하여 사이드바 너비 조절 (더블클릭: 기본값)', 'aria-hidden': 'true' });
  h.addEventListener('mousedown', (e: any) => {
    e.preventDefault(); e.stopPropagation();
    const side = shell.querySelector('.kn-side') as HTMLElement | null;
    const startX = e.clientX;
    const startW = (side && side.getBoundingClientRect().width) || 240;
    document.body.classList.add('pjv-side-resizing'); // 프로젝트 탭과 같은 리사이즈 하이라이트 훅
    const onUp = () => {
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); window.removeEventListener('blur', onUp);
      document.body.classList.remove('pjv-side-resizing');
      const cur = shell.style.getPropertyValue('--pjv-side-w');
      if (cur) { try { localStorage.setItem('pjv:sideW', cur.trim()); } catch (_) { /* noop */ } }
    };
    const onMove = (ev: any) => {
      if (ev.buttons === 0) { onUp(); return; } // 창 밖 mouseup 유실 방지
      let w = startW + (ev.clientX - startX); w = Math.max(150, Math.min(440, w)); shell.style.setProperty('--pjv-side-w', Math.round(w) + 'px');
    };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); window.addEventListener('blur', onUp);
  });
  h.addEventListener('dblclick', (e: any) => { // 더블클릭 = 기본 폭 복귀
    e.preventDefault(); e.stopPropagation();
    shell.style.removeProperty('--pjv-side-w');
    try { localStorage.removeItem('pjv:sideW'); } catch (_) { /* noop */ }
  });
  return h;
}
// 저장된 사이드바 폭 적용(프로젝트 탭과 공유). 셸에 --pjv-side-w 를 얹으면 .kn-side flex-basis 와 핸들 위치가 함께 따라감.
function knApplySideW(shell: HTMLElement) {
  try { const sw = localStorage.getItem('pjv:sideW'); if (sw) shell.style.setProperty('--pjv-side-w', sw.indexOf('px') >= 0 ? sw : sw + 'px'); } catch (_) { /* noop */ }
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

// #657 사이드바 빠른 검색 버튼 — ⌘K 퀵파인드(노션 'Search'). 목록·문서 페이지 사이드바 공용.
function knSideSearchBtn() {
  return el('button', { class: 'kn-side-search', type: 'button', title: '전체 지식 빠른 검색 (⌘K)',
    onclick: () => openQuickSearch() },
    el('span', { class: 'kn-side-search-ic', 'aria-hidden': 'true', text: '🔍' }),
    el('span', { text: '검색' }),
    el('span', { class: 'kn-side-kbd', text: '⌘K' }));
}

// 카테고리 사이드바 행 — tree-item 패턴. data-cat-val 로 클릭 위임(빈 문자열=전체).
//  opts(선택): { glyph } 글리프 교체(기본 ·/∗) · { cls } 추가 클래스(예: 들여쓰기) · { title } 호버 힌트.
// (#req) 사이드바 분류 검색 — 목록 뷰·문서 뷰 사이드바 공용. nav(kn-space-group 트리)를 분류 이름으로 즉시 필터.
//  프로젝트 탭 '폴더·리스트·프로젝트 검색'과 동형(#req 파리티) — 카테고리 이름 + 그 안의 '지식 문서'까지 매칭.
//  문서 매칭은 카테고리 rows(knFetchCategoryRows — 세션 캐시)를 검색어 입력 시점에 로드(카테고리 수 수준·가벼움).
//  매칭 문서는 소속 카테고리 아래 들여쓴 결과 행(상한 8 + 'N개 더'), 클릭 = 열기(onOpen — 목록 뷰 피크/문서 뷰 이동).
let knSideFilterSeq = 0;
async function knSideFilterNav(nav: any, q: string) {
  const query = String(q || '').trim().toLowerCase();
  const seq = ++knSideFilterSeq;
  const wraps = Array.from(nav.querySelectorAll('.kn-nav-catwrap')) as any[];
  nav.querySelectorAll('.kn-side-hits').forEach((n: any) => n.remove());  // 이전 검색 결과 행 제거
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
  // 1차 — 카테고리 이름 매칭 즉시 반영(문서 로드를 기다리지 않는 반응성).
  wraps.forEach((w) => {
    const nm = (w.querySelector('.pjv-side-navlabel')?.textContent || '').toLowerCase();
    w.hidden = !nm.includes(query);
  });
  applyGroups();
  // 2차 — 문서(지식) 매칭: 카테고리별 rows 에서 제목/이름 부분일치 → 결과 행 삽입(#665 프로젝트 검색과 동형).
  const onOpen = (nav as any)._knOnOpen || ((name) => { location.hash = '#/k/' + encodeURIComponent(name); });
  await Promise.all(wraps.map(async (w) => {
    const catId = (w.querySelector('[data-cat-val]') as any)?.dataset?.catVal;
    if (!catId) return;
    let rows: any[] = [];
    try { rows = await knFetchCategoryRows(catId); } catch { return; }
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
// 검색창 — 프로젝트 탭 .pjv-side-search(돋보기 svg + input + ×)와 동일 컴포넌트(#req).
function knSideSearchIcon() {
  const n = sv('svg', { class: 'pjv-side-search-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 11, cy: 11, r: 6.5 }), sv('path', { d: 'M20 20l-3.6-3.6' }));
  return n;
}
function knMakeSideSearch(nav: any, state: any) {
  const input = el('input', { class: 'pjv-side-search-input', type: 'text', placeholder: '카테고리·지식 검색', 'aria-label': '카테고리·지식 검색', value: state.q || '' }) as HTMLInputElement;
  const clear = el('button', { class: 'pjv-side-search-clear', type: 'button', title: '지우기', 'aria-label': '검색어 지우기', text: '×' });
  const box = el('div', { class: 'pjv-side-search' + (state.q ? ' has-q' : '') }, knSideSearchIcon(), input, clear);
  input.addEventListener('input', () => { state.q = input.value; box.classList.toggle('has-q', !!String(state.q).trim()); knSideFilterNav(nav, state.q); });
  input.addEventListener('keydown', (e: any) => { if (e.key === 'Escape') { state.q = ''; input.value = ''; box.classList.remove('has-q'); knSideFilterNav(nav, ''); } });
  clear.addEventListener('click', () => { state.q = ''; input.value = ''; box.classList.remove('has-q'); knSideFilterNav(nav, ''); input.focus(); });
  return box;
}

// 우리 팀 표시(#req) — 208px(프로젝트 폭) 사이드바에선 '우리 팀' 글자칩이 이름을 잘라먹어 컴팩트 ★(이름 앞)로.
//  의미는 하단 범례(knStarLegend)가 설명. 프로젝트 탭도 좁을 땐 카테고리 칩을 숨김(container query) — 동일 취지.
function knTeamChip() {
  return el('span', { class: 'kn-cat-star', 'aria-hidden': 'true', title: '우리 팀이 담당하는 카테고리', text: '★' });
}

function knSideItem(label, catVal, on, opts?) {
  // 프로젝트 탭 사이드바 행(.pjv-side-navitem)과 동일 마크업(#req). opts.star = 우리 팀 → '우리 팀' 칩.
  const star = !!(opts && opts.star);
  const glyph = (opts && opts.glyph) || (catVal ? '·' : '∗');
  return el('a', { class: 'pjv-side-navitem kn-side-item' + (on ? ' active' : '') + (opts && opts.cls ? ' ' + opts.cls : ''),
    href: '#', 'data-cat-val': catVal, role: 'button', tabindex: '0',
    ...(opts && opts.title ? { title: opts.title } : {}) },
    el('span', { class: 'kn-side-glyph', 'aria-hidden': 'true', text: glyph }),
    star ? knTeamChip() : null,
    el('span', { class: 'pjv-side-navlabel', text: label }));
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
// space 섹션 컨테이너 — 프로젝트 탭 스페이스 행(색 아바타 + 볼드 라벨 + 우측 캐럿)과 동일 마크업(#req).
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
function buildSpacesNav(nav, bySpace, selected, myIds: Set<string>, opts?) {
  // (#req 통일) 위키 사이드바(buildKnowledgeNav)와 같은 단일 space 위계 + 프로젝트 탭 컴포넌트.
  //  각 space 안에서 우리 팀 소유 카테고리를 맨 위 + '우리 팀' 칩. ▸ 펼침/개수는 위키 전용(여긴 생략).
  nav.replaceChildren();
  nav.classList.add('kn-tree2');
  nav.append(knSideItem('전체', '', !selected || selected === ''));
  if (opts && opts.indexed) {
    nav.append(knSideItem('인덱스', KN_INDEXED, selected === KN_INDEXED,
      { glyph: '📌', cls: 'kn-side-item-sub', title: '인덱스(핀)된 지식만 — 전체 카테고리에서 매 대화 첫머리에 깔리는 항목' }));
  }
  for (const sk of ['business', 'product', 'system']) {
    const cats = (bySpace[sk] || []);
    if (!cats.length) continue;
    const mine = cats.filter((c) => myIds.has(String(c.id)));
    const rest = cats.filter((c) => !myIds.has(String(c.id)));
    const ordered = [...mine, ...rest];
    const grp = knSpaceGroup(sk);
    for (const c of ordered) grp.append(knSideItem(c.name || c.key, String(c.id), String(selected) === String(c.id), { star: myIds.has(String(c.id)), cls: 'kn-side-item-sub' }));
    nav.append(grp);
  }
}

// ════════════════════════════════════════════
// #592 지식탭 전용 사이드바 트리 — 카테고리 노드 ▸ 펼침: 펼치면 그 카테고리 지식 인라인(폴더 우선→sort→제목순,
//  지연 로드+세션 캐시 — knFetchCategoryRows), 폴더 노드는 다시 ▸ 로 authored 트리(knFetchAuthoredTree)를 펼친다.
//  카테고리명 클릭=본문 필터(data-cat-val 위임 유지), 문서 클릭=피크(opts.onOpen).
// (#req 사이드바 재디자인) 위계를 space 단일 축(사업→제품→시스템)으로 통일 — 옛 '우리 팀' 상단 그룹이 그 안에
//  사업/제품 소그룹을 또 갖고, 같은 레벨에 나머지 space 그룹이 겹쳐 위계가 이중이던 것을 폐기. 우리 팀 소유
//  카테고리는 각 space 안에서 맨 위 + ★·좌측 파란 레일로 강조(오너십=우선순위, 접근제한 아님). 모든 카테고리
//  행 오른쪽에 지식 수(knowledge_count — categories API) 뱃지, space 헤더엔 합계.
// ════════════════════════════════════════════
function buildKnowledgeNav(nav, bySpace, selected, myIds: Set<string>, opts) {
  const onOpen = (opts && opts.onOpen) || ((name) => { location.hash = '#/k/' + encodeURIComponent(name); });
  (nav as any)._knOnOpen = onOpen;   // 사이드바 검색(knSideFilterNav)의 문서 결과 행이 같은 열기 경로를 쓰도록
  nav.replaceChildren();
  nav.classList.add('kn-tree2');
  nav.append(knSideItem('전체', '', !selected || selected === ''));
  if (opts && opts.indexed) {
    nav.append(knSideItem('인덱스', KN_INDEXED, selected === KN_INDEXED,
      { glyph: '📌', cls: 'kn-side-item-sub', title: '인덱스(핀)된 지식만 — 전체 카테고리에서 매 대화 첫머리에 깔리는 항목' }));
  }
  for (const sk of ['business', 'product', 'system']) {
    const cats = (bySpace[sk] || []);
    if (!cats.length) continue;
    // 우리 팀 카테고리 먼저(그 안에선 기존 이름순 유지), 나머지는 뒤에.
    const mine = cats.filter((c) => myIds.has(String(c.id)));
    const rest = cats.filter((c) => !myIds.has(String(c.id)));
    const ordered = [...mine, ...rest];
    // 합계는 개수 데이터가 실제로 있을 때만(구 백엔드 폴백 — knowledge_count 미지원이면 '0' 거짓 표시 대신 생략).
    const hasCounts = ordered.some((c) => Number.isFinite(Number(c.knowledge_count)));
    const total = ordered.reduce((n, c) => n + (Number(c.knowledge_count) || 0), 0);
    const grp = knSpaceGroup(sk, hasCounts ? el('span', { class: 'pjv-side-navcount', title: '이 스페이스의 지식 수', text: String(total) }) : null);
    for (const c of ordered) grp.append(knNavCatNode(c, String(selected) === String(c.id), onOpen, myIds.has(String(c.id))));
    nav.append(grp);
  }
  // ★ 범례(#req) — 별표가 왜 붙는지(우리 팀 소유) 한 줄 설명. 팀 소유가 하나라도 있을 때만.
  if (myIds && myIds.size) nav.append(el('div', { class: 'kn-star-legend' },
    el('span', { class: 'kn-cat-star', 'aria-hidden': 'true', text: '★' }),
    el('span', { text: '우리 팀이 담당하는 분류' })));
}

// 카테고리 노드 — 행(▸ 셰브런 + 이름 + ['우리 팀' 칩] + 지식 수, data-cat-val 로 필터 위임 유지) + 인라인 자식 목록(지연 로드).
//  마크업은 프로젝트 탭 리스트 행(.pjv-side-navitem — 라벨·칩·우측 개수 .pjv-side-navcount)과 동일(#req).
//  레벨1 = 카테고리 지식 중 트리 최상위(부모가 같은 카테고리 안에 없는 행)만 — 폴더 자식은 폴더 노드에서 펼친다.
function knNavCatNode(c, on, onOpen, isMine?: boolean) {
  const tw = el('button', { class: 'kn-nav-tw', type: 'button', 'aria-expanded': 'false',
    title: '이 카테고리의 지식 펼치기', text: '▸' });
  const cnt = Number(c.knowledge_count);
  const row = el('a', { class: 'pjv-side-navitem kn-side-item kn-side-item-sub kn-nav-cat' + (on ? ' active' : ''), href: '#',
    'data-cat-val': String(c.id), role: 'button', tabindex: '0',
    ...(isMine ? { title: '우리 팀이 담당하는 카테고리 — ' + (c.name || c.key) } : {}) },
    tw,
    isMine ? knTeamChip() : null,
    el('span', { class: 'pjv-side-navlabel', text: c.name || c.key }),
    Number.isFinite(cnt) ? el('span', { class: 'pjv-side-navcount' + (cnt === 0 ? ' kn-count-zero' : ''), title: '지식 ' + cnt + '개', text: String(cnt) }) : null);
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
      const tops = rows.filter((r) => !(r.parent_name && names.has(r.parent_name)))
        .filter((r) => !isCategoryHomeDoc(r.name))   // #657 대문 문서 숨김
        .slice().sort(knFolderFirstSort);
      // 폴더별 직속 자식 수(#req 개수 뱃지 — 중분류 아래 폴더까지) — 이 카테고리 rows 기준(카테고리 스코프 개수).
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

// 트리 안 지식 노드 — 문서는 클릭=피크(onOpen), 폴더는 ▸/행 클릭=authored 트리 자식 펼침(재귀, 지연 로드).
//  childN(#req 개수 뱃지): 카테고리 rows 로 만든 '부모 name → 직속 자식 수' 맵 — 폴더 행 오른쪽에 개수 표시(전 깊이).
function knNavDocNode(r, depth, onOpen, childN?: Map<string, number>) {
  const pad = 8 + depth * 14;
  if (!r.is_folder) {
    const row = el('a', { class: 'tree-item kn-nav-doc' + (r.lifecycle === 'archived' ? ' kn-tree-archived' : ''),
      href: '#/k/' + encodeURIComponent(r.name), style: 'padding-left:' + pad + 'px', title: r.title || r.name },
      el('span', { class: 'tree-glyph kn-nav-glyph', 'aria-hidden': 'true', text: knPageIcon(r) }),
      el('span', { class: 'tree-label', text: r.title || r.name }));
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

// #592 테이블 뷰 — 컬럼 제목/유형/작성 주체/갱신. 행 클릭=피크(폴더=드릴다운 — open 콜백이 분기). (#657) 아이콘 열 포함.
function knTable(entries, open) {
  const titleCell = (e) => el('td', { class: 'kn-table-title' },
    el('span', { class: 'row-ic', 'aria-hidden': 'true', text: knPageIcon(e) }), (e.title || e.name));
  const tr = (e) => {
    const rowEl = el('tr', { class: 'kn-table-row', tabindex: '0', role: 'link' });
    if (e.is_folder) {
      rowEl.append(titleCell(e), el('td', { colspan: '3' }));
    } else {
      rowEl.append(
        titleCell(e),
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

// ── #657 갤러리 뷰 — 노션 갤러리 카드(커버 스트립 + 아이콘 + 제목 + 본문 미리보기 + 메타). ──
//  커버 = props_ui.cover(있으면), 없으면 이름 해시 그라디언트를 옅게. 클릭 = 피크/드릴다운(open 콜백).
function knGallery(entries, open) {
  const grid = el('div', { class: 'kn-gallery' });
  for (const e of entries) {
    const cover = el('div', { class: 'kn-gcard-cover' });
    if (!applyCoverBg(cover, e.cover)) { applyCoverBg(cover, defaultCoverFor(e.name)); cover.classList.add('kn-gcard-cover-dim'); }
    cover.append(el('span', { class: 'kn-gcard-ic', 'aria-hidden': 'true', text: knPageIcon(e) }));
    const preview = e.is_folder ? '폴더' : String(e.body_md || '')
      .replace(/```[\s\S]*?```/g, ' ').replace(/:::[a-z_-]*|:::/g, ' ')
      .replace(/[#>*`~=+|[\]()!-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
    const card = el('div', { class: 'kn-gcard', role: 'link', tabindex: '0' },
      cover,
      el('div', { class: 'kn-gcard-body' },
        el('div', { class: 'kn-gcard-title', text: e.title || e.name }),
        preview ? el('div', { class: 'kn-gcard-prev', text: preview }) : null,
        el('div', { class: 'kn-gcard-meta' },
          e.type ? knTypeChip(e.type) : null,
          el('span', { class: 'kn-gcard-time', text: relTime(e.updated_at) }))));
    card.addEventListener('click', () => open(e));
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(e); });
    grid.append(card);
  }
  if (!entries.length) grid.append(el('div', { class: 'empty', text: '표시할 페이지가 없습니다.' }));
  return grid;
}

// ── #657h 위키 홈 카테고리 카드 — 커버 스트립(대문 커버 미리보기) + 아이콘 타일 + 이름/설명 + space·문서 수. ──
// ── #657h3 위키 홈 카드 순서(드래그) — 기기별 localStorage. 서버 카테고리 순서와 독립(대시보드 dash_list_order_v1 과 동형). ──
//  팀 우선 그룹은 유지 — 재정렬은 그룹(우리 팀 / 그 외) '안'에서만(그룹 경계=오너십, 사용자가 넘길 수 없음).
const KN_HOME_ORDER_KEY = 'kn_home_cat_order_v1';
function knHomeOrderSaved(): string[] {
  try { const a = JSON.parse(localStorage.getItem(KN_HOME_ORDER_KEY) || '[]'); return Array.isArray(a) ? a.map((x) => String(x)) : []; }
  catch { return []; }
}
function knHomeSaveOrder(order: string[]) { try { localStorage.setItem(KN_HOME_ORDER_KEY, JSON.stringify(order)); } catch { /* 저장 실패 무시 */ } }
function knHomeClearOrder() { try { localStorage.removeItem(KN_HOME_ORDER_KEY); } catch { /* 무시 */ } }
// 저장 순서로 목록을 안정 정렬 — 저장에 없는 항목은 원래 순서 유지하며 뒤로(카테고리 신설 시 graceful).
function knHomeSortByOrder(list: any[], order: string[]): any[] {
  const idx = new Map(order.map((id, i) => [String(id), i] as [string, number]));
  return list
    .map((c, i) => ({ c, i, o: idx.has(String(c.id)) ? (idx.get(String(c.id)) as number) : Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => (a.o - b.o) || (a.i - b.i))
    .map((x) => x.c);
}
// dragId 를 targetId 앞(after=false)/뒤(after=true)로 옮긴 새 순서(화면 밖 순서도 병합 보존).
function knHomeReorder(order: string[], dragId: string, targetId: string, after: boolean): string[] {
  const arr = order.filter((id) => id !== dragId);
  let at = arr.indexOf(targetId);
  if (at < 0) at = arr.length; else if (after) at += 1;
  arr.splice(at, 0, dragId);
  return arr;
}
// 드래그 진행 상태(모듈 전역 — knHomeCatCard 가 모듈 함수라 클로저 대신). group 으로 그룹 간 드롭을 차단.
let knHomeDragId: string | null = null;
let knHomeDragGroup: string | null = null;

//  클릭 = 그 카테고리 대문으로(onOpen → selectCategory). 대문 문서(home)의 icon/cover 를 그대로 이어받아
//  카드가 대문의 축소판이 되게 한다(설정 0이면 결정적 톤 그라디언트 + 첫 글자 타일 — 대문 기본과 동일).
function knHomeCatCard(c, home, count, isMine, onOpen, dragCtx?) {
  const cover = el('div', { class: 'kn-hcard-cover' });
  if (!applyCoverBg(cover, home && home.cover)) applyCoverBg(cover, defaultCoverFor(c.key || String(c.id)));
  const ic = (home && home.icon) || '';
  cover.append(el('span', { class: 'kn-hcard-ic' + (ic ? '' : ' kn-hcard-ic-letter'),
    text: ic || String(c.name || c.key || '?').trim().charAt(0).toUpperCase() }));
  // (#req) 우리 팀 = 카드 위 뚜렷한 라벨(흰 글자·파란 필). 작은 별은 감이 안 온다는 피드백.
  if (isMine) cover.append(el('span', { class: 'kn-hcard-teambadge', text: '우리 팀' }));
  const spaceEl = el('span', { class: 'kn-hcard-space', text: SPACE_LABEL[c.space] || c.space || '' });
  const card = el('div', { class: 'kn-hcard' + (isMine ? ' kn-hcard-mine' : ''), role: 'link', tabindex: '0',
    title: (c.name || c.key) + ' 대문 열기' + (isMine ? ' · 우리 팀 카테고리' : '') },
    cover,
    el('div', { class: 'kn-hcard-body' },
      el('div', { class: 'kn-hcard-name', text: c.name || c.key }),
      c.description ? el('div', { class: 'kn-hcard-desc', text: c.description }) : null,
      el('div', { class: 'kn-hcard-meta' },
        spaceEl,
        el('span', { class: 'kn-hcard-count', text: String(count) }))));
  card.addEventListener('click', onOpen);
  card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') onOpen(); });
  if (!dragCtx) return card;

  // 드래그 정렬(#657h3) — 카드를 슬롯으로 감싼다(카드 overflow:hidden 이 그룹 간격의 세로 디바이더를 자르지 않게).
  //  대시보드 개요 카드와 동일 패턴: 커서 좌/우 절반으로 앞·뒤 삽입, 삽입 지점에 세로 디바이더. 그룹 밖 드롭은 무시.
  const slot = el('div', { class: 'kn-hcard-slot', draggable: 'true' }, card);
  const cid = String(c.id);
  const clearDrop = () => slot.classList.remove('kn-hcard-drop-before', 'kn-hcard-drop-after');
  const inScope = () => knHomeDragId != null && knHomeDragId !== cid && knHomeDragGroup === dragCtx.group;
  slot.addEventListener('dragstart', (e: any) => {
    knHomeDragId = cid; knHomeDragGroup = dragCtx.group;
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', cid); } catch { /* */ }
    slot.classList.add('kn-hcard-drag-src');
  });
  slot.addEventListener('dragend', () => {
    knHomeDragId = null; knHomeDragGroup = null; slot.classList.remove('kn-hcard-drag-src');
    document.querySelectorAll('.kn-hcard-drop-before, .kn-hcard-drop-after').forEach((n) => n.classList.remove('kn-hcard-drop-before', 'kn-hcard-drop-after'));
  });
  slot.addEventListener('dragover', (e: any) => {
    if (!inScope()) return;
    e.preventDefault();
    const r = slot.getBoundingClientRect();
    const after = (e.clientX - r.left) > r.width / 2;   // 오른쪽 절반이면 이 카드 '뒤'로
    slot.classList.toggle('kn-hcard-drop-after', after);
    slot.classList.toggle('kn-hcard-drop-before', !after);
  });
  slot.addEventListener('dragleave', clearDrop);
  slot.addEventListener('drop', (e: any) => {
    e.preventDefault();
    const after = slot.classList.contains('kn-hcard-drop-after');
    clearDrop();
    if (!inScope()) return;
    dragCtx.onReorder(knHomeDragId, cid, after);
  });
  return slot;
}

// #657 갤러리 로컬 오버라이드 — 서버 view_mode(list|table|entry 그대로) 위에 얹는 브라우저 보기 설정.
function knCatGalleryOn(cat) {
  try { return localStorage.getItem('kn-cat-gallery-' + cat.id) === '1'; } catch (_) { return false; }
}
function knCatGallerySet(cat, on) {
  try { if (on) localStorage.setItem('kn-cat-gallery-' + cat.id, '1'); else localStorage.removeItem('kn-cat-gallery-' + cat.id); } catch (_) { /* noop */ }
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

// #592 [⚙ 보기] 메뉴 — 리스트|테이블|갤러리(#657, 브라우저 저장)|엔트리 문서 + '엔트리 문서 지정…'. 선택 즉시 저장·반영.
function openCatViewMenu(anchorBox, btn, cat, onChanged) {
  const old = anchorBox.querySelector('.kn-viewpop');
  if (old) { old.remove(); return; }
  const close = () => { pop.remove(); document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey); };
  const modeRow = (v, label, hint) => {
    const on = knCatGalleryOn(cat) ? v === 'gallery' : (cat.view_mode || 'list') === v;
    const rowEl = el('button', { class: 'kn-viewopt' + (on ? ' on' : ''), type: 'button', title: hint },
      el('span', { class: 'kn-viewopt-check', 'aria-hidden': 'true', text: on ? '✓' : '' }),
      el('span', { text: label }));
    rowEl.onclick = async () => {
      try {
        if (v === 'gallery') {   // 갤러리는 로컬(이 브라우저) 보기 — 서버 view_mode 계약(list|table|entry)은 불변
          knCatGallerySet(cat, true);
          toast('갤러리로 표시합니다 (이 브라우저에서만)');
          close();
          onChanged();
          return;
        }
        knCatGallerySet(cat, false);
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
    modeRow('gallery', '갤러리', '커버·아이콘 카드 그리드 — 이 브라우저에서만 저장'),
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
      entries = entries.filter((e) => !e.is_folder && !isCategoryHomeDoc(e.name));
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
  knApplySideW(shell); shell.append(knSideResizeHandle(shell)); // (#670) 프로젝트 탭과 동일 폭 조절 핸들
  const setSide = (off) => {
    shell.classList.toggle('side-off', off);
    try { localStorage.setItem(KN_SIDE_COLLAPSE_KEY, off ? '1' : '0'); } catch (_) { /* noop */ }
  };
  collapseBtn.onclick = () => setSide(true);
  reopenBtn.onclick = () => setSide(false);

  // 사이드바 내용 — 목록 뷰와 같은 구성(카테고리 트리 + Notion 페이지 트리). 클릭 = 목록으로 이동(필터).
  const nav = el('nav', { class: 'browse-tree', 'aria-label': '카테고리' });
  const mirrorBox = el('div', { class: 'kn-mirror-tree', hidden: true });
  // (#req) 목록 뷰와 동일 레이아웃 — 헤더('지식 카테고리', 프로젝트 탭 head 컴포넌트)+접기 → 검색창 → 트리.
  const knSideState = { q: '' };
  side.append(el('div', { class: 'pjv-side-nav-head' }, el('span', { class: 'pjv-side-nav-head-label', text: '지식 카테고리' }), collapseBtn),
    knMakeSideSearch(nav, knSideState), nav, mirrorBox);
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
    // 목록 뷰와 동일한 재디자인 트리(#req) — space 단일 위계 + ★우리팀 강조 + 개수 뱃지. 문서 클릭=이동(기본 onOpen).
    try { buildKnowledgeNav(nav, await fetchAllSpaceCats(), '', myCatIdSet(), { indexed: true }); }
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

// ── 위키 생성/편집 페이지 — #657 노션형 페이지 에디터(knowledge-edit.ts)로 이관. 라우터 호환을 위해 재수출. ──
export { renderKnowledgeForm };

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
  // (#614) 자료는 지식과 동급이 아니라 그 아래 보조 입력층 — 동급 탭 대신 '← 지식' 돌아가기가 달린 하위 페이지.
  const head = el('div', { class: 'page-head' },
    el('div', { class: 'page-head-row' },
      el('h1', { class: 'page-title' }, '자', el('span', { class: 'accent', text: '료' })),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge', text: '← 지식' })),
    el('p', { class: 'sub', text: '회의록·이메일·슬랙처럼 아직 정리하기 전의 원본입니다. 지식 화면의 보조 입력층이며, 여기서 다듬으면 지식이 됩니다.' }));
  const kindSel = selectFilter([['', '전체 종류'], ...Object.entries(SOURCE_KIND_LABEL)], '');
  kindSel.setAttribute('aria-label', '종류');
  const provSel = selectFilter([['', '전체 출처'], ['authored', '캡처'], ['observed', '외부 미러']], '');
  provSel.setAttribute('aria-label', '출처');
  const qIn = el('input', { type: 'search', placeholder: '제목·본문 검색', 'aria-label': '검색' });
  const listBox = el('div', { class: 'list-box' });
  const foot = el('div', { class: 'list-foot' });
  view.replaceChildren(el('div', { class: 'kn-plain' },   // doc-mode 자체 패딩(#592)
    head, el('div', { class: 'filter-bar' }, qIn, kindSel, provSel), listBox, foot));
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
  myCatIdSet,
  openCategoryForm,
  renderKnowledge,
  renderKnowledgeDetail,
  renderKnowledgeSpace,
  renderTrash,
  spaceSubBar,
  srcRow,
};
