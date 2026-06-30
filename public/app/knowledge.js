// knowledge.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { LIFECYCLE_LABEL, absTime, api, applyReveal, confidenceDot, el, errorNote, fmtNum, lifecycleDot, reducedMotion, relTime, renderMarkdown, selectFilter, stat, state, sv, toast } from './core.js';
import { overlayBox, skeleton, skeletonRows } from './learn.js';
import { field, hasScope } from './admin.js';
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
const SPACE_LABEL = { business: '사업', product: '제품', system: '시스템' };
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
    if (editing)
        keyIn.disabled = true; // 키는 생성 후 불변(엔드포인트가 수정 지원 안 함)
    const shouldIn = el('textarea', { rows: '4', placeholder: '정의 · 범위 · 규칙 (should)', maxlength: '8000',
        value: editing ? (existing.should || '') : '' });
    const descIn = el('textarea', { rows: '2', placeholder: '한 줄 설명 (선택)', maxlength: '2000',
        value: editing ? (existing.description || '') : '' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: editing ? '저장' : '만들기' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
    const back = overlayBox(editing ? '카테고리 수정' : ('새 카테고리 · ' + (SPACE_LABEL[space] || space)), el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn), el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '키' }), keyIn), el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '정의 · 범위 · 규칙 (should)' }), shouldIn), el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '설명 (선택)' }), descIn), el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
    setTimeout(() => nameIn.focus(), 0);
    const go = async () => {
        const name = nameIn.value.trim();
        if (!name) {
            nameIn.focus();
            toast('이름을 입력하세요', true);
            return;
        }
        saveBtn.disabled = true;
        try {
            if (editing) {
                await api('/api/ui/categories/' + existing.id, { method: 'POST', body: JSON.stringify({
                        name, should: shouldIn.value.trim() || undefined, description: descIn.value.trim() || undefined,
                    }) });
                toast('저장했습니다');
            }
            else {
                const key = (keyIn.value.trim() || slugifyKey(name));
                if (!key) {
                    saveBtn.disabled = false;
                    keyIn.focus();
                    toast('키를 입력하세요(이름에 영문이 없으면 자동 생성이 안 됩니다)', true);
                    return;
                }
                await api('/api/ui/categories', { method: 'POST', body: JSON.stringify({
                        space, key, name, should: shouldIn.value.trim() || undefined, description: descIn.value.trim() || undefined,
                    }) });
                toast('카테고리를 만들었습니다');
            }
            back.remove();
            reload();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            saveBtn.disabled = false;
        }
    };
    saveBtn.onclick = go;
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter')
        go(); });
}
// 도메인 의존 관계(category-edges) — should(사람 작성·편집/삭제 가능) + is(스캔 소유·읽기전용)를 한 섹션에.
//  domains = 제품 카테고리 목록(셀렉터 옵션). 자체 fetch → 행 렌더 + should-edge 추가 폼.
function knowledgeSubBar(active) {
    // WIKI 탭 하위 = 지식 / 자료 / 📌 인덱스 (#290). 지식(정제 저작)과 자료(raw 입력)를 분리.
    //  카테고리(사업·제품·시스템)는 좌측 사이드바로 통합(2026-06-26).
    //  그래프는 별도 탭 대신 '지식 그래프' 버튼 → 풀스크린 새 창(graph.html, #290 아틀라스).
    const bar = el('div', { class: 'sub-cats', role: 'tablist', 'aria-label': '지식 보기' });
    const onBrowse = active !== 'pinned' && active !== 'stats' && active !== 'review' && active !== 'sources';
    const tab = (on, href, label, title) => bar.append(el('a', { class: 'sub-cat' + (on ? ' active' : ''), href,
        role: 'tab', 'aria-selected': on ? 'true' : 'false', ...(title ? { title } : {}), text: label }));
    tab(onBrowse, '#/knowledge', '지식', '정제된 저작 지식 — 결정·설계·개념·런북');
    tab(active === 'sources', '#/knowledge/sources', '자료', '회의 전사록·이메일·슬랙·외부 미러 — 정제 전 raw 입력(지식과 분리, 검색에 안 섞임)');
    tab(active === 'pinned', '#/knowledge/pinned', '📌 인덱스', '핀된 지식만 — 매 대화 첫머리에 깔리는 WIKI 인덱스');
    bar.append(el('button', { class: 'sub-graph-btn', type: 'button', role: 'link',
        title: '도메인으로 묶은 지식 지도 — 풀스크린 새 창에서 팬·줌으로 탐색', onclick: openKnowledgeAtlas }, sv('svg', { class: 'sub-graph-ic', viewBox: '0 0 24 24', width: '15', height: '15', 'aria-hidden': 'true' }, sv('circle', { cx: '6', cy: '7', r: '2.4', fill: 'currentColor' }), sv('circle', { cx: '17', cy: '6', r: '2', fill: 'currentColor', opacity: '0.7' }), sv('circle', { cx: '13', cy: '17', r: '2.2', fill: 'currentColor', opacity: '0.85' }), sv('path', { d: 'M7.8 8.2 11.4 15.4M15.2 7.3 13.7 14.9', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', opacity: '0.5' })), '지식 그래프'));
    return bar;
}
// 지식 아틀라스 — 풀스크린 그래프를 별도 창(graph.html)으로. opener 유지(노드 클릭 시 이 창의 상세로 이동).
//  안정적 창 이름으로 재클릭 시 같은 창을 포커스(여러 개 안 뜸).
function openKnowledgeAtlas() {
    let url = 'graph.html';
    try {
        url = new URL('graph.html', location.href).href;
    }
    catch (_) { /* 상대경로 폴백 */ }
    const w = window.open(url, 'lively-knowledge-atlas');
    if (w)
        try {
            w.focus();
        }
        catch (_) { /* noop */ }
}
// injection(주입축) 한글 라벨 — 칩 표기는 짧게(항상 주입 / 검색). 힌트는 비개발자 친화 한 줄 설명.
const KN_INJECTION_LABEL = { always: '항상 주입', recalled: '검색' };
const KN_INJECTION_HINT = {
    always: '규칙·페르소나처럼 모든 세션에 항상 주입됩니다.',
    recalled: '평소엔 주입 안 됨 — AI가 관련될 때 키워드로 검색해 직접 찾아봅니다(자동·시맨틱 아님).',
};
// provenance(출처축) 한글 라벨 — authored=직접 저작, observed=외부 시스템의 살아있는 미러.
const KN_PROVENANCE_LABEL = { authored: '저작', observed: '외부 미러' };
const KN_PROVENANCE_HINT = {
    authored: '이 시스템에 직접 저작한 지식입니다.',
    observed: '외부 시스템에서 가져온 살아있는 미러입니다(진실·편집은 외부에).',
};
// page-type(#290) 한글 라벨 + 칩 — 엔터프라이즈 표준(DITA/Diátaxis/ADR/LLM위키) 6종. NULL=미분류(칩 생략).
const KN_TYPE_LABEL = { decision: '결정', concept: '개념', 'how-to': 'How-to', reference: '참조', research: '리서치', entity: '엔티티' };
function knTypeChip(type) {
    if (!type)
        return null;
    return el('span', { class: 'kn-chip kn-type kn-type-' + type, title: 'page-type · ' + type, text: KN_TYPE_LABEL[type] || type });
}
// 유형(page-type) 셀렉터 — 생성·편집 폼 공용. 6종. value=선택값. (#290 신규 필수)
function knTypeSelect(value) {
    const sel = el('select', {}, el('option', { value: '', text: '— 유형 선택 —' }));
    for (const [v, label] of Object.entries(KN_TYPE_LABEL))
        sel.append(el('option', { value: v, text: label }));
    if (value)
        sel.value = value;
    return sel;
}
// injection/provenance 칩 — 종류 뱃지(kindBadge)와 같은 작은 인라인 표식. title 로 한 줄 설명 노출.
function knInjectChip(injection) {
    return el('span', { class: 'kn-chip kn-inject kn-inject-' + (injection || 'na'),
        title: KN_INJECTION_HINT[injection] || '', text: KN_INJECTION_LABEL[injection] || injection || '—' });
}
function knProvChip(provenance) {
    return el('span', { class: 'kn-chip kn-prov kn-prov-' + (provenance || 'na'),
        title: KN_PROVENANCE_HINT[provenance] || '', text: KN_PROVENANCE_LABEL[provenance] || provenance || '—' });
}
// ⓘ 설명 점 — 라벨/값 옆 작은 정보 버튼. 긴 설명을 인라인에서 빼 호버(CSS)·포커스·클릭(고정 토글, 터치/유지용)으로 팝.
//  바깥 클릭 시 닫힘. hint 없으면 null.
function infoDot(hint) {
    if (!hint)
        return null;
    const dot = el('button', { type: 'button', class: 'info-dot', 'aria-label': hint }, 'ⓘ', el('span', { class: 'info-pop', role: 'tooltip', text: hint }));
    dot.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const open = dot.classList.toggle('open');
        if (open) {
            const onDoc = (ev) => { if (!dot.contains(ev.target)) {
                dot.classList.remove('open');
                document.removeEventListener('click', onDoc, true);
            } };
            setTimeout(() => document.addEventListener('click', onDoc, true), 0);
        }
    };
    return dot;
}
// 지식 한 행 — 제목(상세 링크) + injection 칩 + provenance 칩 + lifecycle 점 + 갱신시각.
//  select={names:Set, onToggle} 가 오면 선택(체크) 모드 — 클릭=상세이동 대신 선택 토글, .row.sel 로 표시.
function knRow(e, select) {
    const titleEl = el('div', { class: 'row-title', text: e.title || e.name });
    const metaEl = el('div', { class: 'row-meta' }, e.is_wiki ? el('span', { class: 'row-pin-wrap' }, el('span', { class: 'kn-chip kn-pin', title: 'WIKI 인덱스에 핀됨 — 매 대화 첫머리에 항상 깔립니다.', text: '📌 인덱스' }), '  ') : null, knInjectChip(e.injection), ' ', knProvChip(e.provenance), e.type ? el('span', {}, ' ', knTypeChip(e.type)) : null, e.lifecycle ? el('span', {}, '  ', lifecycleDot(e.lifecycle)) : null, '  ', relTime(e.updated_at));
    // 의미검색/grep 결과의 매치 스니펫(있을 때만 — 목록 페치엔 없음). 한 줄로 정리.
    const snipEl = e.snippet ? el('div', { class: 'caption', style: 'margin-top:3px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: String(e.snippet).replace(/\(\+\d+ matches\)[^\n]*/g, '').replace(/L\d+:\s*/g, '').replace(/[\n⋯]+/g, ' · ').replace(/\s+/g, ' ').trim().slice(0, 200) }) : null;
    if (!select) {
        const row = el('div', { class: 'row', role: 'link', tabindex: '0' }, titleEl, metaEl, snipEl);
        const go = () => { location.hash = '#/k/' + encodeURIComponent(e.name); };
        row.addEventListener('click', go);
        row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter')
            go(); });
        return row;
    }
    // 선택 모드 — 행 전체가 토글(체크박스는 pointer-events:none 표시용).
    const on0 = select.names.has(e.name);
    const cb = el('input', { type: 'checkbox', class: 'row-check', tabindex: '-1', 'aria-hidden': 'true' });
    cb.checked = on0;
    const row = el('div', { class: 'row row-pick' + (on0 ? ' sel' : ''), role: 'button', tabindex: '0', 'aria-pressed': String(on0) }, cb, el('div', { class: 'row-pick-body' }, titleEl, metaEl, snipEl));
    const toggle = () => {
        const on = !select.names.has(e.name);
        if (on)
            select.names.add(e.name);
        else
            select.names.delete(e.name);
        row.classList.toggle('sel', on);
        cb.checked = on;
        row.setAttribute('aria-pressed', String(on));
        select.onToggle();
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        toggle();
    } });
    return row;
}
// 비슷한 지식 한 항목(벡터 #172, 자동) — [유사도 % pill][제목 한 줄 전체폭]. knowledge_similar 결과.
//  '연결된 지식' 리스트와 동일 컴팩트 행. 좌측 pill은 관계가 아니라 코사인 유사도(자동 판정)라서 색을 따로 둠.
function knSimilarItem(e) {
    const pct = Math.round((Number(e.similarity) || 0) * 100);
    return el('a', { class: 'kn-linkrow', href: '#/k/' + encodeURIComponent(e.name), title: '의미 유사도(코사인) ' + pct + '%' }, el('span', { class: 'kn-link-rel kn-link-sim', text: pct + '%' }), el('span', { class: 'kn-linkrow-title', text: e.title || e.name }));
}
// 지식 탭 진입 — sub ∈ {business, product, system, stats, review, pinned}. space 셋이면 2분할 뷰, 그 외 통계/검토/핀.
async function renderKnowledge(view, sub, params) {
    if (sub === 'new')
        return renderKnowledgeForm(view, params); // 위키 생성 — 별도 페이지(#255). params: project·relation 프리스테이징(플젝 '직접 작성')
    if (sub === 'stats')
        return renderKnowledgeStats(view);
    if (sub === 'review')
        return renderKnowledgeReview(view);
    if (sub === 'pinned')
        return renderKnowledgePinned(view);
    if (sub === 'sources')
        return renderSources(view, params); // #290 자료층(raw 입력)
    // (그래프는 #/knowledge/graph 라우트 폐기 — '지식 그래프' 버튼 → 풀스크린 새 창 graph.html, #290)
    // 그 외(browse·구 business/product/system URL) → 카테고리 통합 둘러보기(사이드바가 3 space 노출). space 인자 무시.
    return renderKnowledgeSpace(view, sub, params);
}
// 📌 인덱스(핀 전용 뷰) — is_wiki=true 지식만. 핀된 지식의 제목·분류가 매 세션 첫머리(가이드 ${wiki})에 항상 주입된다(본문 제외).
//  핀/해제는 각 지식 상세(#/k/<name>)에서. 여기는 '무엇이 깔리는지' 한눈에 보는 읽기 뷰.
async function renderKnowledgePinned(view) {
    const head = el('div', { class: 'page-head' }, el('h1', {}, '📌 ', el('span', { class: 'accent', text: '인덱스' })), el('p', { class: 'sub', text: '핀한 지식 — 제목·분류가 매 대화 첫머리(가이드의 WIKI 인덱스)에 항상 깔립니다. 본문은 제외(필요할 때 AI가 찾아봄). 핀/해제는 각 지식 상세에서 합니다.' }));
    const listBox = el('div', { class: 'list-box' });
    const foot = el('div', { class: 'list-foot' });
    view.replaceChildren(head, knowledgeSubBar('pinned'), listBox, foot);
    listBox.replaceChildren(skeletonRows(4));
    try {
        const r = await api('/api/ui/knowledge?' + new URLSearchParams({ limit: '500', orderBy: 'updated_at' }));
        const pinned = ((r && r.entries) || []).filter((e) => e.is_wiki);
        if (!pinned.length) {
            listBox.replaceChildren(el('div', { class: 'empty', text: '핀된 지식이 없습니다. 지식 상세에서 ‘📌 핀’을 눌러 매 대화에 깔 항목을 고르세요.' }));
            return;
        }
        listBox.replaceChildren(...pinned.map((e) => knRow(e)));
        foot.replaceChildren(el('span', { class: 'caption', text: pinned.length + '건 핀됨' }));
    }
    catch (e) {
        listBox.replaceChildren(errorNote(e, '핀된 지식을 불러오지 못했습니다'));
    }
}
// space 뷰(사업·제품·시스템) — 좌측 카테고리 사이드바(필터) + 우측 지식 목록(검색·injection·provenance 필터).
async function renderKnowledgeSpace(view, _space, params) {
    // 공간 병합(2026-06-26) — space 인자 무시(사이드바가 3 space 통합). 카테고리/필터만 상태로.
    const f = (state.knowledge = state.knowledge || { space: '', category: '', injection: '', provenance: '', type: '', q: '', semantic: true });
    if (f.type === undefined)
        f.type = '';
    if (f.semantic === undefined)
        f.semantic = true; // 의미검색 기본 on(off=grep). 임베딩 off면 서버가 grep 폴백.
    if (params) {
        if (params.has('category'))
            f.category = params.get('category') || '';
        if (params.has('mode'))
            f.semantic = params.get('mode') !== 'grep';
        if (params.has('injection'))
            f.injection = params.get('injection') || '';
        if (params.has('provenance'))
            f.provenance = params.get('provenance') || '';
        if (params.has('type'))
            f.type = params.get('type') || '';
        if (params.has('q'))
            f.q = params.get('q') || '';
    }
    view.replaceChildren(knowledgeSubBar('browse'), skeleton('지식을 불러오는 중'));
    // 선택(일괄삭제) 상태 — 리페치 없이 로컬 재페인트. names = 선택된 지식 name 집합.
    const sel = { mode: false, names: new Set() };
    let lastEntries = [];
    const bulkBar = el('div', { class: 'bulk-bar', hidden: true });
    const selectBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '선택', title: '여러 지식을 골라 한 번에 삭제',
        onclick: () => { sel.mode = !sel.mode; if (!sel.mode)
            sel.names.clear(); paintList(); repaintBulk(); } });
    const head = el('div', { class: 'page-head' }, el('div', { class: 'page-head-row' }, el('h1', {}, '지', el('span', { class: 'accent', text: '식' })), el('div', { style: 'display:flex; gap:8px; align-items:center;' }, hasScope('memory') ? el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge/new',
        title: '새 지식을 작성합니다(별도 페이지)', text: '+ 추가' }) : null, selectBtn, el('a', { class: 'btn btn-ghost btn-sm', href: '#/trash', text: '🗑 휴지통' }))), el('p', { class: 'sub', text: '맥락의 기록 — 왼쪽 사이드바에서 카테고리(우리 팀 먼저)로 좁히고, 위에서 검색·주입·출처로 거릅니다. 주입(항상/검색)과 출처(저작/외부 미러)는 직교 두 축입니다.' }));
    // 좌측 카테고리 사이드바 — 3 space 통합(우리 팀 상단 펼침 ★ + space별 접이식). 클릭 = 필터(category_id).
    const side = el('aside', { class: 'browse-side' });
    const nav = el('nav', { class: 'browse-tree', 'aria-label': '카테고리' });
    const myIds = myCatIdSet();
    let bySpace = { business: [], product: [], system: [] };
    try {
        bySpace = await fetchAllSpaceCats();
    }
    catch (_) { /* graceful: 사이드바 생략(목록은 계속) */ }
    function buildSide() {
        buildSpacesNav(nav, bySpace, f.category, myIds);
        side.replaceChildren(el('div', { class: 'eyebrow', text: '카테고리' }), nav);
    }
    buildSide();
    // 상단 필터 — 검색(q) + injection select + provenance select.
    const qInput = el('input', { type: 'search', placeholder: '제목·본문 검색', value: f.q, 'aria-label': '검색어' });
    // 검색 방식 — 의미검색(하이브리드 벡터+grep, 자연어/유사) 기본 vs 정확(grep). 검색어가 있을 때만 영향.
    const modeSel = selectFilter([['semantic', '의미검색'], ['grep', '정확(grep)']], f.semantic ? 'semantic' : 'grep');
    modeSel.setAttribute('aria-label', '검색 방식');
    const injSel = selectFilter([['', '전체 주입'], ['always', '항상 주입'], ['recalled', '검색']], f.injection);
    injSel.setAttribute('aria-label', '주입');
    const provSel = selectFilter([['', '전체 출처'], ['authored', '저작'], ['observed', '외부 미러']], f.provenance);
    provSel.setAttribute('aria-label', '출처');
    // page-type(#290) 필터 — 의미검색이 아닌 목록(브라우즈/grep) 경로에만 적용.
    const typeSel = selectFilter([['', '전체 유형'], ['decision', '결정'], ['concept', '개념'], ['how-to', 'How-to'], ['reference', '참조'], ['research', '리서치'], ['entity', '엔티티']], f.type);
    typeSel.setAttribute('aria-label', '유형');
    const listBox = el('div', { class: 'list-box browse-list' });
    const foot = el('div', { class: 'list-foot' });
    function syncHash() {
        const p = new URLSearchParams();
        if (f.category)
            p.set('category', f.category);
        if (f.injection)
            p.set('injection', f.injection);
        if (f.provenance)
            p.set('provenance', f.provenance);
        if (f.type)
            p.set('type', f.type);
        if (f.q)
            p.set('q', f.q);
        if (!f.semantic)
            p.set('mode', 'grep');
        const qs = p.toString();
        history.replaceState(null, '', '#/knowledge' + (qs ? '?' + qs : ''));
    }
    // 목록 페인트(서버 페치 분리) — 선택 모드면 행을 체크 가능하게 렌더.
    function paintList() {
        if (!lastEntries.length) {
            listBox.replaceChildren(el('div', { class: 'empty', text: '조건에 맞는 지식이 없습니다. 필터를 넓혀 보세요.' }));
            return;
        }
        const select = sel.mode ? { names: sel.names, onToggle: repaintBulk } : null;
        listBox.replaceChildren(...lastEntries.map((e) => knRow(e, select)));
    }
    // 선택 바 — 선택 모드일 때만. 전체선택/해제 + 선택 삭제(휴지통). 선택 버튼은 선택↔취소 토글.
    function repaintBulk() {
        selectBtn.textContent = sel.mode ? '취소' : '선택';
        if (!sel.mode) {
            bulkBar.hidden = true;
            bulkBar.replaceChildren();
            return;
        }
        const n = sel.names.size;
        const allOn = lastEntries.length > 0 && lastEntries.every((e) => sel.names.has(e.name));
        const allBtn = el('button', { class: 'btn btn-ghost btn-sm', text: allOn ? '전체 해제' : '전체 선택',
            onclick: () => { if (allOn)
                sel.names.clear();
            else
                lastEntries.forEach((e) => sel.names.add(e.name)); paintList(); repaintBulk(); } });
        // 선택한 지식을 프로젝트의 필요/산출 지식으로 일괄 연결(#257). 권한자(memory)만.
        const linkBtn = hasScope('memory')
            ? el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 프로젝트 연결',
                onclick: () => openProjectChooser({
                    title: n + '개 지식 → 프로젝트 연결',
                    actionLabel: '＋ 연결', doneLabel: '연결됨',
                    onPick: async (proj, relation) => {
                        const nm = [...sel.names];
                        const res = await Promise.allSettled(nm.map((name) => api('/api/ui/v6/projects/' + proj.id + '/knowledge', { method: 'POST', body: JSON.stringify({ name, relation }) })));
                        const ok = res.filter((r) => r.status === 'fulfilled').length;
                        const fail = res.length - ok;
                        toast(fail ? (ok + '개 연결 · ' + fail + '개 실패') : (ok + '개 지식을 ‘' + proj.name + '’에 연결했습니다'), fail > 0);
                        return true;
                    }
                }) })
            : null;
        if (linkBtn)
            linkBtn.disabled = n === 0;
        const delBtn = el('button', { class: 'btn btn-sm btn-danger', text: '선택 삭제',
            onclick: () => bulkDelete(delBtn) });
        delBtn.disabled = n === 0; // el 은 setAttribute('disabled', false) 라 여전히 비활 — 프로퍼티로 설정해야 해제됨
        bulkBar.hidden = false;
        bulkBar.replaceChildren(el('span', { class: 'bulk-bar-count', text: n ? n + '개 선택됨' : '연결·삭제할 지식을 고르세요' }), el('div', { class: 'bulk-bar-actions' }, allBtn, linkBtn, delBtn));
    }
    async function bulkDelete(btn) {
        const names = [...sel.names];
        if (!names.length)
            return;
        if (!confirm(names.length + '개 지식을 삭제할까요?\n\n활성 목록·검색·주입에서 사라집니다. 휴지통(#/trash)에서 복원할 수 있습니다.'))
            return;
        btn.disabled = true;
        // 병렬 삭제 — 일부 실패해도 나머지 진행(성공/실패 건수 보고). 서버가 사람전용 403 재검증.
        const results = await Promise.allSettled(names.map((nm) => api('/api/ui/knowledge/' + encodeURIComponent(nm) + '/delete', { method: 'POST' })));
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const fail = results.length - ok;
        toast(fail ? (ok + '개 삭제 · ' + fail + '개 실패') : (ok + '개 지식을 삭제했습니다 — 휴지통에서 복원 가능'), fail > 0);
        sel.mode = false;
        sel.names.clear();
        refetch();
    }
    async function refetch() {
        listBox.replaceChildren(skeletonRows(4));
        foot.replaceChildren();
        try {
            let r;
            if (f.q.trim() && f.semantic) {
                // 의미검색 — 하이브리드(벡터+grep RRF). 전역 랭킹이라 카테고리 필터는 미적용(주입/출처는 적용). 임베딩 off면 서버가 grep 폴백.
                const p = new URLSearchParams({ q: f.q.trim(), limit: '200' });
                if (f.injection)
                    p.set('injection', f.injection);
                if (f.provenance)
                    p.set('provenance', f.provenance);
                r = await api('/api/ui/knowledge/semantic?' + p.toString());
            }
            else {
                // 목록(빈 검색=브라우즈 / 정확검색) — 카테고리·grep 필터 적용, 최신순.
                const p = new URLSearchParams({ limit: '200', orderBy: 'updated_at' });
                if (f.category)
                    p.set('category', f.category);
                if (f.injection)
                    p.set('injection', f.injection);
                if (f.provenance)
                    p.set('provenance', f.provenance);
                if (f.type)
                    p.set('type', f.type);
                if (f.q.trim())
                    p.set('q', f.q.trim());
                r = await api('/api/ui/knowledge?' + p.toString());
            }
            const entries = (r && r.entries) || [];
            lastEntries = entries;
            // 필터로 사라진 선택 정리(이후 화면에 없는 name 은 선택 해제).
            const present = new Set(entries.map((e) => e.name));
            sel.names.forEach((nm) => { if (!present.has(nm))
                sel.names.delete(nm); });
            paintList();
            repaintBulk();
            foot.replaceChildren(el('span', { class: 'caption', text: entries.length + '건' + (f.q.trim() && f.semantic ? ' · 의미검색(관련도순)' : '') }));
        }
        catch (e) {
            listBox.replaceChildren(errorNote(e, '지식을 불러오지 못했습니다'));
        }
    }
    let qTimer = null;
    qInput.addEventListener('input', () => { f.q = qInput.value; clearTimeout(qTimer); qTimer = setTimeout(() => { syncHash(); refetch(); }, 280); });
    injSel.addEventListener('change', () => { f.injection = injSel.value; syncHash(); refetch(); });
    provSel.addEventListener('change', () => { f.provenance = provSel.value; syncHash(); refetch(); });
    typeSel.addEventListener('change', () => { f.type = typeSel.value; syncHash(); refetch(); });
    modeSel.addEventListener('change', () => { f.semantic = modeSel.value === 'semantic'; syncHash(); refetch(); });
    // 좌측 클릭 위임(side 컨테이너 — buildSide 가 내부를 교체해도 핸들러 유지).
    side.addEventListener('click', (ev) => {
        const item = ev.target.closest('[data-cat-val]');
        if (!item)
            return;
        ev.preventDefault();
        f.category = item.dataset.catVal || '';
        buildSide();
        syncHash();
        refetch();
    });
    const filterBar = el('div', { class: 'filter-bar browse-filter' }, qInput, modeSel, injSel, provSel, typeSel);
    const layout = el('div', { class: 'browse-layout' }, side, el('section', { class: 'browse-main' }, filterBar, bulkBar, listBox, foot));
    view.replaceChildren(head, knowledgeSubBar('browse'), layout);
    applyReveal([layout]);
    refetch();
}
// 카테고리 사이드바 행 — tree-item 패턴. data-cat-val 로 클릭 위임(빈 문자열=전체).
function knSideItem(label, catVal, on) {
    return el('a', { class: 'tree-item' + (on ? ' on' : ''), href: '#', 'data-cat-val': catVal, role: 'button', tabindex: '0' }, el('span', { class: 'tree-glyph all', 'aria-hidden': 'true', text: catVal ? '·' : '∗' }), el('span', { class: 'tree-label', text: label }));
}
// ── 공유 사이드바(프로젝트·위키 탭 공용, 2026-06-26) — 3 space 카테고리를 한 사이드바에 통합. ──
//  공간 서브탭을 없애고, 보는 멤버의 '우리 팀' 카테고리(state.me.team_category_ids = 팀 소유/이해관계)를 상단에
//  펼쳐 노출(★), 나머지는 space별 접이식(<details>)으로 접어 하위에 둔다. data-cat-val 위임은 호출부가 유지.
//  ★오너십=우선순위, 접근제한 아님 — 모든 카테고리는 여전히 사이드바에 있고 선택·검색 가능.
// 3 space 카테고리를 한 번에 — {business, product, system}. 각 항목 graceful(실패=빈 배열).
async function fetchAllSpaceCats() {
    const out = { business: [], product: [], system: [] };
    const lists = await Promise.all(SPACE_SUBS.map((s) => api('/api/ui/categories?' + new URLSearchParams({ space: s.key })).then((d) => (d && d.categories) || []).catch(() => [])));
    SPACE_SUBS.forEach((s, i) => { out[s.key] = lists[i]; });
    return out;
}
// 내 팀 카테고리 id 집합(state.me.team_category_ids) — 문자열 Set(catVal 비교용). 미로그인/미소속이면 빈 집합.
function myCatIdSet() {
    const ids = (state.me && state.me.team_category_ids) || [];
    return new Set(ids.map((x) => String(x)));
}
// 공유 사이드바 nav 채우기 — 우리 팀(상단 펼침 ★) + space별 접이식(나머지). nav 내부만 교체(클릭 위임은 호출부 side 에).
//  myIds 비면(미소속) 우리 팀 그룹 생략하고 3 space 를 모두 펼쳐 노출(기존 동작에 근접). selected = 현재 선택 catVal(문자열).
function buildSpacesNav(nav, bySpace, selected, myIds) {
    nav.replaceChildren();
    nav.append(knSideItem('전체', '', !selected || selected === ''));
    // 우리 팀 — 전 space 에서 내 카테고리(제품→사업→시스템 순). 항상 펼침.
    const mine = [];
    for (const sk of ['product', 'business', 'system'])
        for (const c of (bySpace[sk] || []))
            if (myIds.has(String(c.id)))
                mine.push(c);
    const hasMine = mine.length > 0;
    if (hasMine) {
        const grp = el('details', { class: 'tree-group tree-group-mine', open: '' }, el('summary', { class: 'tree-grouphead' }, el('span', { class: 'tree-groupstar', 'aria-hidden': 'true', text: '★' }), el('span', { class: 'tree-grouptitle', text: '우리 팀' }), el('span', { class: 'tree-groupcount', text: String(mine.length) })));
        for (const c of mine)
            grp.append(knSideItem(c.name || c.key, String(c.id), String(selected) === String(c.id)));
        nav.append(grp);
    }
    // 나머지 — space별(사업·제품·시스템). 우리 팀이 있으면 접힘 기본(무관=하위), 없으면 펼침. 선택된 카테고리가 든 그룹은 펼침.
    for (const sk of ['business', 'product', 'system']) {
        const rest = (bySpace[sk] || []).filter((c) => !myIds.has(String(c.id)));
        if (!rest.length)
            continue;
        const selectedHere = rest.some((c) => String(c.id) === String(selected));
        const open = !hasMine || selectedHere;
        const grp = el('details', { class: 'tree-group' + (hasMine ? ' tree-group-rest' : ''), ...(open ? { open: '' } : {}) }, el('summary', { class: 'tree-grouphead' }, el('span', { class: 'tree-grouptitle', text: SPACE_LABEL[sk] }), el('span', { class: 'tree-groupcount', text: String(rest.length) })));
        for (const c of rest)
            grp.append(knSideItem(c.name || c.key, String(c.id), String(selected) === String(c.id)));
        nav.append(grp);
    }
}
// 통계 뷰 — 전 지식을 한 번 가져와 injection/provenance/space 별 집계 카드로.
async function renderKnowledgeStats(view) {
    view.replaceChildren(knowledgeSubBar('stats'), skeleton('통계를 집계하는 중'));
    const head = el('div', { class: 'page-head' }, el('h1', {}, '지식 ', el('span', { class: 'accent', text: '통계' })), el('p', { class: 'sub', text: '맥락 기록의 두 직교축(주입·출처)과 영역(space)별 분포. 전체 활성 지식 기준.' }));
    let entries;
    try {
        entries = await api('/api/ui/knowledge?' + new URLSearchParams({ limit: '500', orderBy: 'updated_at' })).then((d) => (d && d.entries) || []);
    }
    catch (e) {
        view.replaceChildren(head, knowledgeSubBar('stats'), errorNote(e, '통계를 불러오지 못했습니다'));
        return;
    }
    const byInj = { always: 0, recalled: 0 };
    const byProv = { authored: 0, observed: 0 };
    for (const e of entries) {
        if (e.injection in byInj)
            byInj[e.injection]++;
        if (e.provenance in byProv)
            byProv[e.provenance]++;
    }
    const injCard = el('div', { class: 'card' }, el('h2', { text: '주입축 (injection)' }), el('div', { class: 'stat-row' }, stat(fmtNum(byInj.always), '항상 주입', '건'), stat(fmtNum(byInj.recalled), '검색 소환', '건')));
    const provCard = el('div', { class: 'card' }, el('h2', { text: '출처축 (provenance)' }), el('div', { class: 'stat-row' }, stat(fmtNum(byProv.authored), '저작', '건'), stat(fmtNum(byProv.observed), '외부 미러', '건')));
    const totalCard = el('div', { class: 'card' }, el('h2', { text: '전체' }), el('div', { class: 'stat-row' }, stat(fmtNum(entries.length), '활성 지식', '건')));
    view.replaceChildren(head, knowledgeSubBar('stats'), totalCard, injCard, provCard);
    applyReveal([totalCard, injCard, provCard]);
}
// 검토 뷰 — 외부 미러(provenance=observed) 또는 AI 산출(confidence=ai) 지식을 사후 검토. 반려(lifecycle=rejected).
async function renderKnowledgeReview(view) {
    view.replaceChildren(knowledgeSubBar('review'), skeleton('검토 대상을 불러오는 중'));
    const head = el('div', { class: 'page-head' }, el('h1', {}, '지식 ', el('span', { class: 'accent', text: '검토' })), el('p', { class: 'sub', text: 'AI 가 생성했거나(출처=AI) 외부에서 미러된(출처=외부 미러) 지식을 사후 검토합니다. 보고 내려둘지(반려) 결정하세요.' }));
    const listBox = el('div', { class: 'list-box' });
    view.replaceChildren(head, knowledgeSubBar('review'), listBox);
    async function load() {
        listBox.replaceChildren(skeletonRows(4));
        let entries;
        try {
            entries = await api('/api/ui/knowledge?' + new URLSearchParams({ lifecycle: 'active', limit: '500', orderBy: 'updated_at' })).then((d) => (d && d.entries) || []);
        }
        catch (e) {
            listBox.replaceChildren(errorNote(e, '검토 목록을 불러오지 못했습니다'));
            return;
        }
        // 검토 대상 = 외부 미러(observed) 또는 AI 산출(confidence=ai). 사람 저작은 무게이트 신뢰.
        const targets = entries.filter((e) => e.provenance === 'observed' || e.confidence === 'ai');
        if (!targets.length) {
            listBox.replaceChildren(el('div', { class: 'empty', text: '검토 대기 중인 지식이 없습니다. 모두 확인되었습니다.' }));
            return;
        }
        listBox.replaceChildren();
        for (const e of targets) {
            const row = el('div', { class: 'review-row' }, el('div', { class: 'review-main' }, el('a', { class: 'review-title', href: '#/k/' + encodeURIComponent(e.name), text: e.title || e.name }), el('div', { class: 'row-meta' }, knInjectChip(e.injection), ' ', knProvChip(e.provenance), e.confidence === 'ai' ? el('span', {}, '  ', confidenceDot(e.confidence)) : null, '  ', relTime(e.updated_at))), el('div', { class: 'review-acts' }, el('a', { class: 'btn btn-ghost btn-sm', href: '#/k/' + encodeURIComponent(e.name), text: '보기' }), el('button', { class: 'btn btn-ghost btn-sm btn-danger', text: '삭제', onclick: async (ev) => {
                    ev.preventDefault();
                    if (!confirm("'" + (e.title || e.name) + "' 지식을 삭제할까요? 휴지통(#/trash)에서 복원할 수 있습니다."))
                        return;
                    try {
                        await api('/api/ui/knowledge/' + encodeURIComponent(e.name) + '/delete', { method: 'POST' });
                        row.classList.add('flash');
                        setTimeout(() => { row.remove(); if (!listBox.querySelector('.review-row'))
                            listBox.replaceChildren(el('div', { class: 'empty', text: '검토 대기 중인 지식이 없습니다.' })); }, reducedMotion() ? 0 : 350);
                        toast('삭제했습니다 — 휴지통에서 복원 가능');
                    }
                    catch (err) {
                        toast('삭제 실패 — ' + err.message, true);
                    }
                } })));
            listBox.append(row);
        }
    }
    load();
}
// 지식 상세 #/k/<name> — 전문(body_md, 마크다운) + 메타(injection/provenance/lifecycle/source) + 연결 카테고리.
async function renderKnowledgeDetail(view, name) {
    view.replaceChildren(skeleton('지식을 불러오는 중'));
    let k;
    try {
        k = await api('/api/ui/knowledge/' + encodeURIComponent(name)).then((d) => (d && d.knowledge) || d);
    }
    catch (e) {
        if (e.status === 404) {
            view.replaceChildren(el('div', { class: 'page-head' }, el('h1', { text: '없는 지식' })), el('div', { class: 'note', text: "'" + name + "' 을(를) 찾을 수 없습니다." }), el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge', text: '← 지식으로' }));
            return;
        }
        view.replaceChildren(errorNote(e, '지식을 불러오지 못했습니다'));
        return;
    }
    if (!k) {
        view.replaceChildren(el('div', { class: 'note', text: '지식을 찾을 수 없습니다.' }));
        return;
    }
    const backRow = el('div', { class: 'crumbs' }, el('a', { class: 'crumb-link', href: '#/knowledge', text: '지식' }), el('span', { class: 'crumb-sep', text: ' / ' }), el('span', { class: 'mono', text: k.name }));
    // 본문(전문) — body_md 안전 마크다운 렌더(renderMarkdown: createElement+textContent, HTML 주입 불가) + 원문 토글.
    const rawText = k.body_md || '';
    const rendered = rawText
        ? el('div', { class: 'unit-body md-rendered' }, renderMarkdown(rawText))
        : el('div', { class: 'body-text unit-body', text: '(본문 없음)' });
    const rawView = el('pre', { class: 'body-text unit-body unit-body-raw', text: rawText });
    rawView.hidden = true;
    let showingRaw = false;
    const rawToggle = rawText
        ? el('button', { class: 'btn btn-ghost btn-sm md-raw-toggle', text: '원문 보기',
            onclick: () => {
                showingRaw = !showingRaw;
                rendered.hidden = showingRaw;
                rawView.hidden = !showingRaw;
                rawToggle.textContent = showingRaw ? '서식 보기' : '원문 보기';
            } })
        : null;
    // 메타 — v6 핵심 축(주입·출처)·상태·버전·갱신만 항상 노출. 외부 미러(provenance=observed)일 때만 외부 출처 상세를 펼친다.
    //  정리(2026-06-24): 구 '출처 채널(source)' 행 제거(쓰기 채널이라 provenance 와 중복) · '신뢰(confidence)'는 v6 축이 아닌
    //  파생 신호(AI/사람 작성)라 'AI 생성'일 때만 '작성 주체'로 압축 · source_ref 라벨을 '참조'로(출처 3중복 해소).
    //  recalled = '검색 소환'(AI가 관련될 때 키워드 검색으로 직접 찾는 것 — 자동·시맨틱 아님, query 가 아니라 recall).
    const isMirror = k.provenance === 'observed' || k.external_system || k.external_id || k.external_url;
    const metaRows = [
        ['주입(injection)', KN_INJECTION_LABEL[k.injection] || k.injection || '—', k.injection ? KN_INJECTION_HINT[k.injection] : ''],
        ['출처(provenance)', KN_PROVENANCE_LABEL[k.provenance] || k.provenance || '—', k.provenance ? KN_PROVENANCE_HINT[k.provenance] : ''],
        ['상태(lifecycle)', LIFECYCLE_LABEL[k.lifecycle] || k.lifecycle || '—'],
        k.type ? ['유형(type)', KN_TYPE_LABEL[k.type] || k.type] : null,
        k.confidence === 'ai' ? ['작성 주체', 'AI 생성'] : null,
        k.author ? ['작성자', k.author] : null,
        k.supersedes ? ['대체함(supersedes)', k.supersedes] : null,
        isMirror && k.external_system ? ['외부 출처', k.external_system + (k.external_instance ? ' · ' + k.external_instance : '')] : null,
        isMirror && k.external_id ? ['외부 ID', k.external_id] : null,
        isMirror && k.external_url ? ['외부 링크', k.external_url] : null,
        isMirror && k.occurred_at ? ['발생 시각', absTime(k.occurred_at)] : null,
        isMirror && k.last_synced_at ? ['마지막 동기화', absTime(k.last_synced_at)] : null,
        k.source_ref ? ['참조(source_ref)', k.source_ref] : null,
        ['버전', 'v' + (k.version != null ? k.version : '—')],
        k.created_at ? ['최초 작성', absTime(k.created_at)] : null,
        ['마지막 갱신', (k.updated_at ? absTime(k.updated_at) : '—') + (k.updated_by ? ' · ' + k.updated_by : '')],
    ].filter(Boolean);
    const metaBar = el('div', { class: 'unit-metabar' });
    for (const [kk, vv, hint] of metaRows) {
        const vEl = hint
            ? el('span', { class: 'umeta-v umeta-v-info' }, el('span', { text: vv }), infoDot(hint))
            : el('span', { class: 'umeta-v', text: vv });
        metaBar.append(el('div', { class: 'umeta' }, el('span', { class: 'umeta-k', text: kk }), vEl));
    }
    // 연결 카테고리(단일, #290) — rejected 제외. 단독 섹션 폐지 → 메타데이터 첫 항목으로 편입(pill 유지).
    const cats = (Array.isArray(k.categories) ? k.categories : []).filter((c) => c.state !== 'rejected');
    metaBar.prepend(el('div', { class: 'umeta umeta-cat' }, el('span', { class: 'umeta-k', text: '카테고리' }), cats.length
        ? el('div', { class: 'umeta-v kn-cat-list kn-cat-inmeta' }, ...cats.map((c) => el('span', { class: 'kn-chip kn-cat-chip',
            title: (SPACE_LABEL[c.space] || c.space || '') + ' · ' + (c.key || ''), text: c.name || c.key })))
        : el('span', { class: 'umeta-v umeta-empty', text: '연결 없음' })));
    // 상태 액션 — 편집·핀(memory 권한자)·삭제(휴지통), 우측 정렬. 편집/핀은 지식 자신에서 직접(관리탭 WIKI 인덱스 흡수, 2026-06-24).
    //  핀: is_wiki 토글 → 제목·분류가 매 대화 첫머리(가이드 ${wiki})에 항상 주입(본문 제외). 삭제는 사람 전용(서버 403 재검증).
    const actions = el('div', { class: 'unit-actions unit-actions-end' });
    if (hasScope('memory')) {
        actions.append(el('button', { class: 'btn btn-ghost btn-sm', text: '편집',
            onclick: () => { location.hash = '#/k-edit/' + encodeURIComponent(k.name); } })); // 모달 아닌 별도 편집 페이지(#290)
        const pinBtn = el('button', { class: 'btn btn-ghost btn-sm',
            text: k.is_wiki ? '📌 핀 해제' : '📍 인덱스에 핀',
            title: '핀하면 제목·분류가 매 대화 첫머리(WIKI 인덱스)에 항상 깔립니다(본문 제외, 필요할 때 AI가 찾아봄).',
            onclick: async () => {
                pinBtn.disabled = true;
                try {
                    await api('/api/ui/knowledge/' + encodeURIComponent(k.name) + '/wiki', { method: 'POST', body: JSON.stringify({ is_wiki: !k.is_wiki }) });
                    toast(k.is_wiki ? '핀을 해제했습니다' : '인덱스에 핀했습니다');
                    renderKnowledgeDetail(view, k.name);
                }
                catch (e) {
                    toast('핀 변경 실패 — ' + e.message, true);
                    pinBtn.disabled = false;
                }
            } });
        actions.append(pinBtn);
    }
    actions.append(el('button', { class: 'btn btn-ghost btn-sm btn-danger', text: '삭제',
        onclick: () => knDelete(k.name, view) }));
    const metaWrap = el('details', { class: 'unit-meta-details', open: '' }, el('summary', { class: 'unit-meta-summary' }, '메타데이터'), metaBar);
    // 비슷한 지식(벡터 #172) — 이 지식과 의미적으로 가까운 다른 지식(코사인 유사도, 자동). 비동기 채움(임베딩 off/유사 없음=숨김).
    const relatedBox = el('div', { class: 'kn-related', hidden: true, style: 'margin-top:16px' });
    const main = el('div', { class: 'detail-card unit-card' }, el('div', { class: 'unit-title-row' }, el('h1', { class: 'detail-title', text: k.title || k.name }), lifecycleDot(k.lifecycle)), el('div', { class: 'detail-meta' }, el('span', { class: 'mono', text: k.name }), knInjectChip(k.injection), knProvChip(k.provenance), knTypeChip(k.type), k.is_wiki ? el('span', { class: 'kn-chip kn-pin', title: 'WIKI 인덱스에 핀됨 — 제목·분류가 매 대화 첫머리에 항상 깔립니다(본문 제외).', text: '📌 인덱스' }) : null), actions.childNodes.length ? actions : null, metaWrap, // 카테고리는 메타데이터 첫 항목으로 편입됨(단독 섹션 폐지)
    knLinksPanel(k, view), // #290 연결된 지식 — 연결된 프로젝트와 같은 관계 섹션으로 묶음(같은 패턴)
    knProjectLinks(k.name), el('div', { class: 'sec-label sec-label-row' }, el('span', { text: '본문' }), rawToggle), el('div', { class: 'unit-body-wrap' }, rendered, rawView), relatedBox);
    view.replaceChildren(el('div', { class: 'page-head unit-head' }, backRow), main);
    applyReveal([main]);
    // 비슷한 지식 비동기 로드(주 렌더를 막지 않음). graceful — 임베딩 off/유사 없음/실패면 섹션 숨김 유지.
    (async () => {
        try {
            const r = await api('/api/ui/knowledge/similar?' + new URLSearchParams({ name: k.name, limit: '6', min_score: '0.45' }));
            const rel = (r && r.entries) || [];
            if (!rel.length)
                return;
            relatedBox.replaceChildren(el('div', { class: 'sec-label sec-label-row' }, el('span', { text: '비슷한 지식' }), el('span', { class: 'kn-sim-hint', title: '벡터 임베딩 코사인 유사도로 자동 추천 — 직접 맺은 ‘연결된 지식’과는 다릅니다', text: '자동 · 의미 유사도' })), el('div', { class: 'kn-linkrows' }, ...rel.map(knSimilarItem)));
            relatedBox.hidden = false;
        }
        catch (_) { /* 임베딩 off 등 → 숨김 유지 */ }
    })();
}
async function knChangeLifecycle(name, lifecycle, view) {
    try {
        await api('/api/ui/knowledge/' + encodeURIComponent(name) + '/lifecycle', { method: 'POST', body: JSON.stringify({ lifecycle }) });
        toast(lifecycle === 'rejected' ? '반려했습니다' : (lifecycle === 'active' ? '복원했습니다' : '상태를 바꿨습니다'));
        renderKnowledgeDetail(view, name);
    }
    catch (e) {
        toast('상태 변경 실패 — ' + e.message, true);
    }
}
// 지식 삭제(휴지통) — 활성 목록·검색·주입에서 제거하되 감사 스냅샷으로 보존(#/trash 에서 복원). 연결은 cascade 정리.
async function knDelete(name, view) {
    if (!confirm("'" + name + "' 지식을 삭제할까요?\n\n활성 목록·검색·주입에서 사라집니다. 연결된 카테고리·프로젝트·활동 링크는 함께 정리됩니다.\n휴지통(#/trash)에서 본체를 복원할 수 있습니다."))
        return;
    try {
        await api('/api/ui/knowledge/' + encodeURIComponent(name) + '/delete', { method: 'POST' });
        toast('삭제했습니다 — 휴지통에서 복원할 수 있습니다');
        location.hash = '#/knowledge';
    }
    catch (e) {
        toast('삭제 실패 — ' + e.message, true);
    }
}
// 지식 생성·편집 — WIKI 탭의 단일 편집 표면(관리탭 'WIKI 인덱스' 흡수, 2026-06-24). 비파괴 upsert(POST /api/ui/knowledge):
//  주입·출처·핀·요약·기존 카테고리는 미전송 시 서버가 보존 → 편집이 다른 축을 망치지 않는다.
//  (org/memory 는 injection 을 recalled 로 강제 덮어써서 규칙·미러를 손상 → 쓰지 않음.)
// ════════════════════════════════════════════
// 위키 ↔ 프로젝트 연결 — 생성 페이지(#255)·상세(#256)·목록 일괄(#257) 공용.
//  지식을 프로젝트의 필요(required)/산출(produced) 지식으로 연결한다. API: POST /api/ui/v6/projects/:id/knowledge {name, relation, unlink?}.
// ════════════════════════════════════════════
const KN_REL_LABEL = { required: '필요', produced: '산출' };
// 연결 가능한 프로젝트 목록(보드 앵커 제외, 최신순) — 피커 공용. graceful(실패 시 빈 배열).
async function fetchLinkableProjects() {
    try {
        const d = await api('/api/ui/v6/projects');
        return (d && d.projects) || [];
    }
    catch (_) {
        return [];
    }
}
function knProjStatusText(p) {
    const done = p.status === 'done' || p.status_category === 'done';
    const tc = Number(p.task_count) || 0, dc = Number(p.task_done_count) || 0;
    return (done ? '완료' : '진행 중') + (tc ? ' · 작업 ' + dc + '/' + tc : '');
}
// 프로젝트 선택 피커(오버레이) — 관계(필요/산출) 토글 + 프로젝트 검색 목록. 행 버튼 클릭 = onPick(project, relation).
//  onPick 이 false 를 반환하면 미처리. 이미 처리한 (id:relation) 은 picked 로 '완료' 표시. 오버레이는 열린 채 여러 건 처리 가능.
//  opts: { title, actionLabel='＋ 연결', doneLabel='연결됨', initialPicked?:Iterable<string>, onPick:(p,relation)=>Promise<boolean|void> }
function openProjectChooser(opts) {
    const relSel = el('select', { class: 'kn-projpick-rel' }, el('option', { value: 'required', text: '필요 지식으로' }), el('option', { value: 'produced', text: '산출 지식으로' }));
    const searchIn = el('input', { type: 'search', class: 'proj-file-search', placeholder: '프로젝트 이름으로 검색…' });
    const results = el('div', { class: 'ps-kn-pick-results' }, el('span', { class: 'admin-hint', text: '프로젝트를 불러오는 중…' }));
    overlayBox(opts.title || '프로젝트 선택', el('div', { class: 'ps-kn-pick' }, el('div', { class: 'kn-projpick-bar' }, el('span', { class: 'admin-hint', text: '연결 관계' }), relSel), searchIn, results));
    setTimeout(() => searchIn.focus(), 0);
    let all = [];
    const picked = new Set(opts.initialPicked || []);
    function paint() {
        if (!all.length) {
            results.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '연결할 프로젝트가 없습니다.' }));
            return;
        }
        const q = searchIn.value.trim().toLowerCase();
        const cand = all.filter((p) => !q || (p.name || '').toLowerCase().includes(q));
        if (!cand.length) {
            results.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '검색 결과가 없습니다.' }));
            return;
        }
        const rel = relSel.value;
        results.replaceChildren(...cand.map((p) => {
            const done = picked.has(p.id + ':' + rel);
            const btn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: done ? (opts.doneLabel || '연결됨') : (opts.actionLabel || '＋ 연결') });
            btn.disabled = done;
            btn.onclick = async () => {
                const relation = relSel.value;
                btn.disabled = true;
                try {
                    const ok = await opts.onPick(p, relation);
                    if (ok === false) {
                        btn.disabled = false;
                        return;
                    }
                    picked.add(p.id + ':' + relation);
                    btn.textContent = opts.doneLabel || '연결됨';
                }
                catch (e) {
                    btn.disabled = false;
                    toast('실패 — ' + e.message, true);
                }
            };
            return el('div', { class: 'ps-kn-pick-row' }, el('div', { class: 'ps-kn-pick-main' }, el('div', { class: 'row-title', text: p.name }), el('div', { class: 'admin-hint', text: knProjStatusText(p) })), btn);
        }));
    }
    relSel.addEventListener('change', paint);
    searchIn.addEventListener('input', paint);
    (async () => { all = await fetchLinkableProjects(); paint(); })();
}
// 위키 상세 '연결된 프로젝트' 섹션(#256) — 역방향 조회(GET /api/ui/knowledge/:name/projects) + 필요/산출 칩(해제 ✕) + 연결 버튼.
function knProjectLinks(knowledgeName) {
    const canEdit = hasScope('memory');
    const list = el('div', { class: 'kn-projlink-list' });
    let cur = [];
    function linkedKeys() { return cur.map((p) => p.project_id + ':' + p.relation); }
    function projChip(p) {
        const link = el('a', { class: 'kn-projchip-link', href: '#/projects2/p/' + p.project_id, text: p.project_name || ('#' + p.project_id) });
        const x = el('button', { class: 'kn-projchip-x', type: 'button', title: '연결 해제', text: '✕' });
        x.onclick = async (ev) => {
            ev.preventDefault();
            try {
                await api('/api/ui/v6/projects/' + p.project_id + '/knowledge', { method: 'POST', body: JSON.stringify({ name: knowledgeName, relation: p.relation, unlink: true }) });
                toast('연결을 해제했습니다');
                refresh();
            }
            catch (e) {
                toast('해제 실패 — ' + e.message, true);
            }
        };
        return el('span', { class: 'kn-chip kn-projchip' }, link, canEdit ? x : null);
    }
    function paint() {
        if (!cur.length) {
            list.replaceChildren(el('div', { class: 'kn-cat-empty', text: '연결된 프로젝트가 없습니다.' }));
            return;
        }
        const groups = [];
        for (const rel of ['required', 'produced']) {
            const items = cur.filter((p) => p.relation === rel);
            if (!items.length)
                continue;
            groups.push(el('div', { class: 'kn-projlink-group' }, el('span', { class: 'kn-projlink-rel kn-projlink-rel-' + rel, text: KN_REL_LABEL[rel] }), ...items.map(projChip)));
        }
        list.replaceChildren(...groups);
    }
    async function refresh() {
        try {
            const d = await api('/api/ui/knowledge/' + encodeURIComponent(knowledgeName) + '/projects');
            cur = (d && d.projects) || [];
        }
        catch (_) {
            cur = [];
        }
        paint();
    }
    const addBtn = canEdit
        ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 프로젝트 연결',
            onclick: () => openProjectChooser({
                title: '프로젝트에 연결', actionLabel: '＋ 연결', doneLabel: '연결됨', initialPicked: linkedKeys(),
                onPick: async (proj, relation) => {
                    await api('/api/ui/v6/projects/' + proj.id + '/knowledge', { method: 'POST', body: JSON.stringify({ name: knowledgeName, relation }) });
                    toast('연결했습니다');
                    refresh();
                    return true;
                }
            }) })
        : null;
    const box = el('div', { class: 'kn-projlinks' }, el('div', { class: 'sec-label sec-label-row' }, el('span', { text: '연결된 프로젝트' }), addBtn), list);
    refresh();
    return box;
}
// ── 위키 생성 페이지(#255) — 모달이 아닌 별도 페이지. 폼 + 프로젝트 연결(복수, 필요/산출) 스테이징 후 저장 시 일괄 연결. ──
// 지식 작성/편집 — 별도 페이지(모달 아님, #290). editName 있으면 편집(기존 로드·프리필·파일명 고정·프로젝트 스테이징 생략),
//  없으면 신규(분류·유형 필수 + 프로젝트 연결 스테이징). 저장 후 상세(#/k/<name>)로 이동. 작성 페이지와 동일 UX.
export async function renderKnowledgeForm(view, params, editName) {
    if (!hasScope('memory')) {
        location.hash = '#/knowledge';
        return;
    } // 읽기전용 사용자는 목록으로
    const isEdit = !!editName;
    let k = {};
    if (isEdit) {
        try {
            k = await api('/api/ui/knowledge/' + encodeURIComponent(editName)).then((r) => r && (r.knowledge || r));
        }
        catch (e) {
            toast('지식을 불러오지 못했습니다 — ' + e.message, true);
            location.hash = '#/k/' + encodeURIComponent(editName);
            return;
        }
        if (!k || !k.name) {
            toast('지식을 찾을 수 없습니다', true);
            location.hash = '#/knowledge';
            return;
        }
    }
    const nameIn = el('input', { type: 'text', value: k.name || '', placeholder: '파일명 (소문자 영문·숫자·-, 비우면 제목에서 자동)' });
    if (isEdit)
        nameIn.disabled = true; // 이름=식별자, 생성 후 불변
    const titleIn = el('input', { type: 'text', value: k.title || '', placeholder: '제목' });
    // (#335) injection 선택 폐기 — 지식은 항상 recalled. 항상-주입은 관리탭 '세션 주입' 섹션 문서로만(편집 시 미전송 → 서버 보존).
    const provSel = el('select', {}, el('option', { value: 'authored', text: '저작 (기본)' }), el('option', { value: 'observed', text: '외부 미러' }));
    provSel.value = k.provenance || 'authored';
    // 분류(단일 필수) — value=key. 편집 시 현재 분류 key 프리셀렉트.
    const curCatKey = (Array.isArray(k.categories) ? k.categories.filter((c) => c.state !== 'rejected') : []).map((c) => c.key).filter(Boolean)[0] || '';
    const catSel = el('select', {}, el('option', { value: '', text: '— 분류 선택 —' }));
    loadCategoryKeysForSelect(catSel, curCatKey);
    const typeSel = knTypeSelect(k.type || ''); // #290 type 필수
    const bodyTa = el('textarea', { class: 'mem-edit-ta', rows: '16', placeholder: 'markdown 본문' });
    bodyTa.value = k.body_md || '';
    // 프로젝트 연결 스테이징 — 신규에서만(편집은 상세의 '연결된 프로젝트'에서 관리). 저장 전엔 모았다가 저장 후 일괄 link.
    const staged = [];
    const stagedList = el('div', { class: 'kn-staged-list' });
    const stagedKeys = () => staged.map((s) => s.id + ':' + s.relation);
    function paintStaged() {
        if (!staged.length) {
            stagedList.replaceChildren(el('div', { class: 'kn-cat-empty', text: '연결된 프로젝트가 없습니다 — 선택 사항입니다.' }));
            return;
        }
        stagedList.replaceChildren(...staged.map((s, i) => {
            const x = el('button', { class: 'kn-projchip-x', type: 'button', title: '제거', text: '✕' });
            x.onclick = () => { staged.splice(i, 1); paintStaged(); };
            return el('span', { class: 'kn-chip kn-projchip' }, el('span', { class: 'kn-projlink-rel kn-projlink-rel-' + s.relation, text: KN_REL_LABEL[s.relation] }), el('span', { class: 'kn-projchip-link', text: s.name }), x);
        }));
    }
    const addProjBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 프로젝트 추가',
        onclick: () => openProjectChooser({
            title: '프로젝트 연결', actionLabel: '＋ 추가', doneLabel: '추가됨', initialPicked: stagedKeys(),
            onPick: async (proj, relation) => {
                if (staged.some((s) => s.id === proj.id && s.relation === relation))
                    return false;
                staged.push({ id: proj.id, name: proj.name, relation });
                paintStaged();
                return true;
            }
        }) });
    if (!isEdit) {
        paintStaged();
        // 플젝 페이지 '직접 작성'에서 넘어온 경우(?project=&relation=) — 그 프로젝트의 필요/산출 연결을 기본 채움.
        const preProj = params && params.get && params.get('project');
        const preRel = params && params.get && params.get('relation');
        if (preProj && (preRel === 'required' || preRel === 'produced')) {
            (async () => {
                try {
                    const d = await api('/api/ui/v6/projects/' + encodeURIComponent(preProj)).then((r) => r && (r.project || r));
                    if (d && d.id) {
                        staged.push({ id: d.id, name: d.name, relation: preRel });
                        paintStaged();
                    }
                }
                catch (_) { /* graceful — 프로젝트를 못 찾으면 프리스테이징 생략 */ }
            })();
        }
    }
    const status = el('span', { class: 'admin-status' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: isEdit ? '저장' : '추가' });
    saveBtn.onclick = async () => {
        const body = bodyTa.value.trim();
        if (!body) {
            toast('본문을 입력하세요', true);
            return;
        }
        if (!catSel.value) {
            toast('분류를 선택하세요 (분류 1개 필수)', true);
            return;
        }
        if (!typeSel.value) {
            toast('유형(type)을 선택하세요 (type 필수)', true);
            return;
        }
        saveBtn.disabled = true;
        status.textContent = '저장 중…';
        try {
            const payload = { title: titleIn.value.trim() || undefined, body_md: body, provenance: provSel.value, category: catSel.value, type: typeSel.value };
            if (isEdit)
                payload.name = k.name;
            else if (nameIn.value.trim())
                payload.name = nameIn.value.trim();
            const r = await api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify(payload) });
            const savedName = (r && r.knowledge && r.knowledge.name) || payload.name;
            if (!savedName)
                throw new Error('저장 응답에 이름이 없습니다');
            // 프로젝트 연결(신규·복수) — 부분 실패해도 나머지 진행.
            if (!isEdit && staged.length) {
                const res = await Promise.allSettled(staged.map((s) => api('/api/ui/v6/projects/' + s.id + '/knowledge', { method: 'POST', body: JSON.stringify({ name: savedName, relation: s.relation }) })));
                const fail = res.filter((x) => x.status === 'rejected').length;
                if (fail)
                    toast('지식은 저장됨 — 프로젝트 연결 ' + fail + '건 실패', true);
            }
            toast(isEdit ? '저장했습니다' : '지식을 추가했습니다');
            location.hash = '#/k/' + encodeURIComponent(savedName); // 저장한 지식 상세로 이동
        }
        catch (e) {
            toast('저장 실패 — ' + e.message, true);
            saveBtn.disabled = false;
            status.textContent = '';
        }
    };
    const head = el('div', { class: 'page-head' }, el('div', { class: 'page-head-row' }, el('h1', {}, '지식 ', el('span', { class: 'accent', text: isEdit ? '편집' : '작성' })), el('a', { class: 'btn btn-ghost btn-sm', href: isEdit ? ('#/k/' + encodeURIComponent(k.name)) : '#/knowledge', text: isEdit ? '← 상세로' : '← 목록으로' })), el('p', { class: 'sub', text: isEdit ? '이 지식의 내용을 수정합니다. 프로젝트 연결은 상세 페이지에서 관리합니다.' : '새 지식을 작성하고, 원하면 프로젝트의 필요/산출 지식으로 연결합니다(복수 프로젝트 가능).' }));
    const card = el('div', { class: 'card kn-create-card' }, field('파일명', nameIn), field('제목', titleIn), field('출처(provenance)', provSel), field('카테고리 (필수)', catSel), field('유형/type (필수)', typeSel), field('본문', bodyTa), isEdit ? null : el('div', { class: 'field' }, el('div', { class: 'field-label-row kn-create-projhead' }, el('label', { class: 'field-label', text: '프로젝트 연결 (선택)' }), addProjBtn), stagedList), el('div', { class: 'admin-actions' }, saveBtn, status));
    view.replaceChildren(head, knowledgeSubBar('browse'), card);
    applyReveal([card]);
    setTimeout(() => (isEdit ? bodyTa : titleIn).focus(), 0);
}
// 카테고리 셀렉터(value=key) — 저장 payload 의 category 파라미터가 key 라 id 가 아닌 key 를 값으로. 작성·편집 페이지(#255·#290) 공용.
//  preselectKey 주면 옵션 채운 뒤 그 분류를 선택(편집 시 현재 분류 복원).
async function loadCategoryKeysForSelect(sel, preselectKey) {
    const spaces = [['business', '사업'], ['product', '제품'], ['system', '시스템']];
    await Promise.all(spaces.map(async ([sp, label]) => {
        try {
            const d = await api('/api/ui/categories?' + new URLSearchParams({ space: sp }));
            const cats = (d && d.categories) || [];
            if (!cats.length)
                return;
            const og = el('optgroup', { label });
            for (const c of cats)
                og.append(el('option', { value: c.key, text: c.name || c.key }));
            sel.append(og);
        }
        catch (_) { /* graceful */ }
    }));
    if (preselectKey)
        sel.value = preselectKey;
}
// ════════════════════════════════════════════
// 휴지통 #/trash — 삭제된 지식·프로젝트·카테고리를 한곳에서 보고 복원(공통 경로). 감사로그(deleted_list) 기반.
//  복원은 본체만 — 삭제 시 cascade 된 연결(카테고리/프로젝트/활동 링크)은 돌아오지 않는다. 사람 전용(서버 403 재검증).
// ════════════════════════════════════════════
const TRASH_ENTITY_LABEL = { knowledge: '지식', project: '프로젝트', category: '카테고리' };
async function renderTrash(view) {
    view.replaceChildren(skeleton('삭제된 항목을 불러오는 중'));
    let entries = [];
    try {
        entries = await api('/api/ui/deleted').then((d) => (d && d.entries) || []);
    }
    catch (e) {
        view.replaceChildren(errorNote(e, '휴지통을 불러오지 못했습니다'));
        return;
    }
    const head = el('div', { class: 'page-head' }, el('h1', {}, '휴지', el('span', { class: 'accent', text: '통' })), el('p', { class: 'sub', text: '삭제된 지식·프로젝트·카테고리입니다. 감사 스냅샷으로 보존되어 복원할 수 있습니다(본체만 — 삭제 시 정리된 연결은 복원되지 않습니다).' }));
    const list = el('div', { class: 'list' });
    if (!entries.length) {
        list.append(el('div', { class: 'note', text: '삭제된 항목이 없습니다.' }));
    }
    else {
        for (const e of entries)
            list.append(trashRow(e, view));
    }
    view.replaceChildren(head, list);
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
            }
            catch (err) {
                restoreBtn.disabled = false;
                toast('복원 실패 — ' + err.message, true);
            }
        } });
    const who = (e.actor ? '  · ' + e.actor : '') + (e.actor_kind ? ' (' + (e.actor_kind === 'ai' ? 'AI' : '사람') + ')' : '');
    const left = el('div', {}, el('div', { class: 'row-title' }, el('span', { class: 'kn-chip', text: TRASH_ENTITY_LABEL[e.entity] || e.entity }), '  ', el('span', { text: e.label || e.key })), el('div', { class: 'row-meta' }, el('span', { class: 'mono', text: e.key }), '  삭제: ', relTime(e.at), who));
    return el('div', { class: 'row', style: 'display:flex; align-items:center; justify-content:space-between; gap:12px;' }, left, restoreBtn);
}
// ════════════════════════════════════════════
// #290 지식↔지식 링크 패널 + 자료(source)층 + 그래프뷰.
// ════════════════════════════════════════════
const KN_LINK_REL_LABEL = { related: '관련', refines: '구체화', contradicts: '모순', depends_on: '의존' };
const KN_SOURCE_REL_LABEL = { derived_from: '증류', cites: '참조' };
const SOURCE_KIND_LABEL = { transcript: '전사록', minutes: '회의록', email: '이메일', slack: '슬랙', notion_doc: '노션', clickup_doc: '클릭업', other: '기타' };
// 연결된 지식 한 줄(리스트, 옵시디언식) — [관계 pill][제목 전체폭·한 줄][✕ hover]. 행 전체 클릭=상세 이동.
//  incoming=true 면 백링크(해제 방향 반전: from=상대, to=이 지식).
function knLinkRow(e, k, view, incoming) {
    const row = el('a', { class: 'kn-linkrow', href: '#/k/' + encodeURIComponent(e.name) }, el('span', { class: 'kn-link-rel kn-link-' + e.relation, text: KN_LINK_REL_LABEL[e.relation] || e.relation }), el('span', { class: 'kn-linkrow-title', text: e.title || e.name }));
    if (hasScope('memory')) {
        const x = el('button', { class: 'kn-linkrow-x', type: 'button', title: '연결 해제', text: '✕' });
        x.onclick = async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const from = incoming ? e.name : k.name, to = incoming ? k.name : e.name;
            try {
                await api('/api/ui/knowledge/' + encodeURIComponent(from) + '/link', { method: 'POST', body: JSON.stringify({ to, relation: e.relation, unlink: true }) });
                toast('연결을 해제했습니다');
                renderKnowledgeDetail(view, k.name);
            }
            catch (err) {
                toast('해제 실패 — ' + err.message, true);
            }
        };
        row.append(x);
    }
    return row;
}
// 상세 '연결된 지식' — 방향(→ 포워드 / ← 백링크) 두 그룹 + 컴팩트 리스트(제목 한 줄 전체폭, 옵시디언식). 관계 pill.
//  방향 헤더가 주어를 정한다: "이 지식에서 연결 →"=이 지식이 주어, "← …연결(백링크)"=상대가 주어. 관계 키워드는 그대로.
function knLinksPanel(k, view) {
    const links = k.links || { outgoing: [], incoming: [] };
    const out = links.outgoing || [], inc = links.incoming || [], sources = k.sources || [];
    const head = el('div', { class: 'sec-label sec-label-row' }, el('span', { text: '연결된 지식' }), hasScope('memory') ? el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 지식 연결',
        title: '교차주제는 카테고리 복수태깅 대신 지식끼리 연결로 잇습니다', onclick: () => openKnowledgeLinkPicker(k, view) }) : null);
    const bodyEl = el('div', { class: 'kn-links-body' });
    const dirGroup = (label, arr, incoming) => el('div', { class: 'kn-linkdir' }, el('span', { class: 'kn-linkdir-head', text: label }), el('div', { class: 'kn-linkrows' }, ...arr.map((e) => knLinkRow(e, k, view, incoming))));
    if (!out.length && !inc.length) {
        bodyEl.append(el('div', { class: 'kn-cat-empty', text: '아직 연결된 지식이 없어요. ＋지식 연결로 관련된 지식을 이어보세요.' }));
    }
    else {
        if (out.length)
            bodyEl.append(dirGroup('이 지식에서 연결한 글  →', out, false));
        if (inc.length)
            bodyEl.append(dirGroup('←  이 지식을 연결한 글 (백링크)', inc, true));
    }
    const box = el('div', { class: 'kn-links' }, head, bodyEl);
    if (sources.length) {
        const srcRows = sources.map((s) => {
            const row = el('div', { class: 'kn-linkrow', role: 'button', tabindex: '0', style: 'cursor:pointer' }, el('span', { class: 'kn-link-rel kn-link-source', title: SOURCE_KIND_LABEL[s.kind] || s.kind, text: KN_SOURCE_REL_LABEL[s.relation] || s.relation }), el('span', { class: 'kn-linkrow-title', text: s.title || ('자료 #' + s.source_id) }));
            row.onclick = () => openSourceDetail(s.source_id);
            return row;
        });
        box.append(el('div', { class: 'sec-label', text: '출처 자료' }), el('div', { class: 'kn-linkrows' }, ...srcRows));
    }
    return box;
}
// 지식 링크 추가 — 관계 선택 + 대상 검색(grep) → 클릭 연결.
function openKnowledgeLinkPicker(k, view) {
    const relSel = selectFilter([['related', '관련'], ['refines', '구체화'], ['contradicts', '모순'], ['depends_on', '의존']], 'related');
    const qIn = el('input', { type: 'search', placeholder: '연결할 지식 검색(제목·본문)' });
    const results = el('div', { class: 'list-box', style: 'max-height:320px; overflow:auto; margin-top:10px;' });
    const back = overlayBox('지식 링크 추가 · ' + (k.title || k.name), el('div', { class: 'field' }, el('label', { class: 'field-label', text: '관계' }), relSel), el('div', { class: 'field', style: 'margin-top:10px' }, el('label', { class: 'field-label', text: '대상 지식' }), qIn), results);
    let t = null;
    async function search() {
        const q = qIn.value.trim();
        results.replaceChildren(skeletonRows(2));
        try {
            const url = q ? ('/api/ui/knowledge/search?' + new URLSearchParams({ q, limit: '15' }))
                : ('/api/ui/knowledge?' + new URLSearchParams({ limit: '15', orderBy: 'updated_at' }));
            const r = await api(url);
            const entries = ((r && r.entries) || []).filter((e) => e.name !== k.name);
            if (!entries.length) {
                results.replaceChildren(el('div', { class: 'empty', text: '결과 없음' }));
                return;
            }
            results.replaceChildren(...entries.map((e) => el('div', { class: 'row', role: 'button', tabindex: '0', style: 'cursor:pointer',
                onclick: async () => {
                    try {
                        await api('/api/ui/knowledge/' + encodeURIComponent(k.name) + '/link', { method: 'POST', body: JSON.stringify({ to: e.name, relation: relSel.value }) });
                        toast('링크를 추가했습니다');
                        back.remove();
                        renderKnowledgeDetail(view, k.name);
                    }
                    catch (err) {
                        toast('실패 — ' + err.message, true);
                    }
                } }, el('div', { class: 'row-title', text: e.title || e.name }), el('div', { class: 'row-meta' }, el('span', { class: 'mono', text: e.name })))));
        }
        catch (err) {
            results.replaceChildren(errorNote(err, '검색 실패'));
        }
    }
    qIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 250); });
    setTimeout(() => { qIn.focus(); search(); }, 0);
}
// 자료(source) 탭 — raw 입력 인박스. kind/provenance/q 필터. 클릭 = 상세 오버레이.
async function renderSources(view, _params) {
    const head = el('div', { class: 'page-head' }, el('h1', {}, '자', el('span', { class: 'accent', text: '료' })), el('p', { class: 'sub', text: '맥락의 raw 입력 — 회의 전사록·이메일·슬랙·외부 미러. 정제하면 지식이 됩니다(지식과 분리 — 검색·인덱스에 안 섞임).' }));
    const kindSel = selectFilter([['', '전체 종류'], ...Object.entries(SOURCE_KIND_LABEL)], '');
    kindSel.setAttribute('aria-label', '종류');
    const provSel = selectFilter([['', '전체 출처'], ['authored', '캡처'], ['observed', '외부 미러']], '');
    provSel.setAttribute('aria-label', '출처');
    const qIn = el('input', { type: 'search', placeholder: '제목·본문 검색', 'aria-label': '검색' });
    const listBox = el('div', { class: 'list-box' });
    const foot = el('div', { class: 'list-foot' });
    view.replaceChildren(head, knowledgeSubBar('sources'), el('div', { class: 'filter-bar' }, qIn, kindSel, provSel), listBox, foot);
    async function refetch() {
        listBox.replaceChildren(skeletonRows(4));
        foot.replaceChildren();
        try {
            const p = new URLSearchParams();
            if (kindSel.value)
                p.set('kind', kindSel.value);
            if (provSel.value)
                p.set('provenance', provSel.value);
            if (qIn.value.trim())
                p.set('q', qIn.value.trim());
            const r = await api('/api/ui/sources' + (p.toString() ? '?' + p.toString() : ''));
            const entries = (r && r.entries) || [];
            if (!entries.length) {
                listBox.replaceChildren(el('div', { class: 'empty', text: '자료가 없습니다. 커넥터(이메일·슬랙)나 회의록이 여기로 들어옵니다.' }));
                return;
            }
            listBox.replaceChildren(...entries.map(srcRow));
            foot.replaceChildren(el('span', { class: 'caption', text: entries.length + '건' }));
        }
        catch (e) {
            listBox.replaceChildren(errorNote(e, '자료를 불러오지 못했습니다'));
        }
    }
    let t = null;
    qIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(refetch, 250); });
    kindSel.addEventListener('change', refetch);
    provSel.addEventListener('change', refetch);
    refetch();
}
function srcRow(s) {
    const row = el('div', { class: 'row', role: 'button', tabindex: '0', style: 'cursor:pointer' }, el('div', { class: 'row-title', text: s.title || ('자료 #' + s.id) }), el('div', { class: 'row-meta' }, el('span', { class: 'kn-chip kn-source-kind', text: SOURCE_KIND_LABEL[s.kind] || s.kind }), ' ', knProvChip(s.provenance), '  ', relTime(s.occurred_at || s.updated_at)));
    const open = () => openSourceDetail(s.id);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter')
        open(); });
    return row;
}
async function openSourceDetail(id) {
    let s;
    try {
        const r = await api('/api/ui/sources/' + id);
        s = (r && r.source) || r;
    }
    catch (e) {
        toast('자료를 불러오지 못했습니다 — ' + e.message, true);
        return;
    }
    const derived = s.knowledge || [];
    overlayBox(s.title || ('자료 #' + id), el('div', { class: 'detail-meta', style: 'margin-bottom:10px' }, el('span', { class: 'kn-chip kn-source-kind', text: SOURCE_KIND_LABEL[s.kind] || s.kind }), knProvChip(s.provenance), s.occurred_at ? el('span', { class: 'caption', text: '  ' + absTime(s.occurred_at) }) : null), derived.length ? el('div', {}, el('div', { class: 'sec-label', text: '여기서 파생된 지식' }), el('div', { class: 'list-box' }, ...derived.map((d) => el('a', { class: 'row', href: '#/k/' + encodeURIComponent(d.name),
        style: 'text-decoration:none; display:block', text: (KN_SOURCE_REL_LABEL[d.relation] || d.relation) + ' · ' + (d.title || d.name) })))) : null, el('div', { class: 'sec-label', text: '본문' }), el('div', { class: 'unit-body md-rendered', style: 'max-height:50vh; overflow:auto' }, renderMarkdown(s.body_md || '(본문 없음)')));
}
export { SPACE_LABEL, SPACE_SUBS, buildSpacesNav, fetchAllSpaceCats, knInjectChip, knProvChip, knRow, knSideItem, knowledgeSubBar, myCatIdSet, openCategoryForm, renderKnowledge, renderKnowledgeDetail, renderKnowledgeSpace, renderTrash, spaceSubBar, };
