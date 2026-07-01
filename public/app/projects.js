// projects.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { TOKEN_KEY, api, applyReveal, el, errorNote, lifecycleDot, pageHead, relTime, renderMarkdown, safeHref, selectFilter, state, sv, toast } from './core.js';
import { SPACE_LABEL, buildSpacesNav, fetchAllSpaceCats, knInjectChip, knProvChip, myCatIdSet } from './knowledge.js';
import { activityTimelineRow } from './dashboard.js';
import { overlayBox, skeleton, skeletonRows } from './learn.js';
import { loadAdmin } from './admin.js';
import { PJV_TAG_NONE, pjvOpenTaskModal, pjvtmComposerToolbar } from './taskmodal.js';
// ════════════════════════════════════════════
// 프로젝트(v2) #/projects2 — 맥락 = 카테고리 + 지식 + 프로젝트 중 '프로젝트'(= 맥락의 *변화*).
//  지식 탭과 대칭인 하위 탭: [대시보드 · 작업 현황 · 사업 · 제품 · 시스템].
//   · 대시보드 = 프로젝트 보드(level='project' 카드, 진행중/완료)
//   · 작업 현황 = 기존 #/dash(사람×AI 작업현황)를 하위 탭으로 흡수(renderDashboard 재사용)
//   · 사업·제품·시스템 = 카테고리(space)로 프로젝트를 훑는 2분할(지식 탭의 renderKnowledgeSpace 패턴 재사용)
//  데이터: GET /api/ui/v6/projects(보드·space목록)·/:id(상세) + POST .../status,/tasks,/members,/category,/knowledge,
//   POST /api/ui/v6/tasks/:id/status, GET /api/ui/categories(사이드바). (백엔드 projects-v6 — 이미 구현됨.)
// ════════════════════════════════════════════
const PJV_STATUS_LABEL = { active: '진행 중', done: '완료' };
// ── 인라인 편집(상태 아이콘·우선순위·담당자 등) 후 재렌더 시 스크롤 위치 보존 (#358) ──
//  상태 아이콘 클릭 등 인라인 편집은 전체 재페인트(reload)를 부른다. 기본 경로는 먼저 스켈레톤으로
//  교체하는데, 이때 문서 높이가 줄며 브라우저가 스크롤을 맨 위로 클램프 → '새로고침돼서 위로 강제이동'
//  되는 느낌을 준다. 아래 신호를 세팅해 두면 renderProjectV2Board/Detail 이 스켈레톤을 건너뛰고
//  (구 DOM 을 유지한 채 조용히 재페치) 재페인트 후 원래 스크롤 위치를 복원한다.
//  신호는 대상 렌더가 최상단에서 동기적으로 소비하며, 비대상 재로드(예: 태스크 모달 자체 재렌더)는
//  소비하지 않으므로 래퍼가 즉시 null 로 되돌려 다음 페이지 렌더로 새는 것(누수)을 막는다.
let _pjvKeepScrollY = null;
function pjvReloadKeepScroll(reload) {
    if (!reload)
        return;
    _pjvKeepScrollY = window.scrollY || window.pageYOffset || 0;
    const ret = reload(); // 대상 렌더가 최상단에서 신호를 동기 소비(스켈레톤 스킵)
    _pjvKeepScrollY = null; // 미소비(비대상 재로드)면 여기서 즉시 해제 — 누수 방지
    return ret;
}
// 재페인트 후 스크롤 복원 — 하위 비동기 섹션(폴더·터미널·타임라인)은 재페인트 직후 스켈레톤이라
//  문서가 잠깐 짧아진다. 이때 한 번만 복원하면 목표 위치가 최대 스크롤로 클램프됐다가(위로 튐) 섹션이
//  로드되며 문서가 다시 커져도 스크롤은 그대로 남는다. 따라서 즉시 + 로드 창(≈1.2s) 동안 재적용하되,
//  목표에 도달하면(문서가 충분히 커지면) 즉시 멈춘다.
function pjvRestoreScroll(y) {
    if (y == null)
        return;
    let done = false;
    const apply = () => {
        if (done)
            return;
        window.scrollTo(0, y);
        if (Math.abs((window.scrollY || window.pageYOffset || 0) - y) <= 2)
            done = true; // 도달 → 종료
    };
    requestAnimationFrame(apply);
    for (const ms of [40, 120, 260, 500, 800, 1200])
        setTimeout(apply, ms);
}
// 프로젝트 하위 탭 바 — 공간(사업·제품·시스템) 칩 제거(2026-06-26), 사이드바로 통합. [대시보드][카테고리]만.
//  지식 탭의 knowledgeSubBar 와 같은 짜임(.sub-cats/.sub-cat). active ∈ {dashboard, browse}.
function projectSubBar(active) {
    const bar = el('div', { class: 'sub-cats', role: 'tablist', 'aria-label': '프로젝트 보기' });
    const tabs = [['dashboard', '대시보드', '#/projects2/dashboard'], ['browse', '탐색', '#/projects2/browse']];
    for (const [key, label, href] of tabs) {
        const on = key === active;
        bar.append(el('a', { class: 'sub-cat' + (on ? ' active' : ''), href,
            role: 'tab', 'aria-selected': on ? 'true' : 'false', text: label }));
    }
    return bar;
}
// 프로젝트 탭 공통 페이지 헤더 — 공용 pageHead(#367). 제목 + 🗑 휴지통 진입점. 삭제 프로젝트 복원은 #/trash 공용 페이지.
function projectPageHead() {
    return pageHead('프로젝트', '우리 팀이 진행 중인 일을 한눈에 보고 관리합니다.', [
        el('a', { class: 'btn btn-ghost btn-sm', href: '#/trash', title: '삭제한 프로젝트·지식·카테고리 복원', text: '🗑 휴지통' }),
    ], '젝트');
}
// 프로젝트(v2) 진입 — browse(카테고리 통합 둘러보기) | 구 business/product/system URL 도 browse 로. 그 외=대시보드(보드).
async function renderProjectsV2(view, sub, params) {
    if (sub === 'browse' || SPACE_LABEL[sub])
        return renderProjectV2Space(view, sub, params);
    return renderProjectV2Board(view);
}
// 대시보드 — 프로젝트 보드(level='project'). 진행 중/완료 두 섹션 + [+ 새 프로젝트] + [선택→일괄삭제].
//  선택 모드: 내가 만든(created_by==나) 프로젝트만 체크 가능 — 진행 중·완료에 걸쳐 여러 개를 골라 한 번에 삭제.
// 대시보드 — 프로젝트 보드(level='project'), **리스트로 1차 그룹핑**(클릭업 List▸Task). 내가 참여한 리스트는 펼침,
//  그 외 리스트는 접힘(기본), 미분류는 '기타'로. 상태(할 일/진행 중/완료)는 각 행의 동그라미 + 헤더 Closed 토글로 표현.
//  '내 할당만' 토글 = 내가 만든/팀원인 프로젝트만(서버 mine=1 집합). 회사 전체 타임라인은 아래 그대로.
async function renderProjectV2Board(view) {
    pjvSelReset(); // 화면 진입/재렌더 시 다중선택·하단 바 초기화(이전 화면 선택 잔존 방지)
    const keepY = _pjvKeepScrollY;
    _pjvKeepScrollY = null; // 인라인 편집 재렌더면 스켈레톤 스킵 + 스크롤 복원(#358)
    if (keepY == null)
        view.replaceChildren(projectSubBar('dashboard'), skeleton('프로젝트를 불러오는 중'));
    const head = projectPageHead();
    let allProjects, mineProjects, lists;
    try {
        // 전체 프로젝트(리스트별 그룹 — 접힌 리스트도 보이게) + 내 프로젝트(세션수·'내 할당' 판정) + 리스트 목록을 병렬로.
        [allProjects, mineProjects, lists] = await Promise.all([
            api('/api/ui/v6/projects').then((d) => (d && d.projects) || []),
            api('/api/ui/v6/projects?mine=1').then((d) => (d && d.projects) || []).catch(() => []),
            api('/api/ui/v6/project-lists').then((d) => (d && d.lists) || []).catch(() => []),
        ]);
    }
    catch (e) {
        view.replaceChildren(head, projectSubBar('dashboard'), errorNote(e, '프로젝트를 불러오지 못했습니다'));
        return;
    }
    // 내 세션 수는 mine=1 응답에만 부여됨 → id 로 머지(전체 목록 행에 '내 세션' 신호 복원).
    const sessById = new Map(mineProjects.map((p) => [p.id, p.my_session_count || 0]));
    for (const p of allProjects)
        p.my_session_count = sessById.get(p.id) || 0;
    // '내가 할당된' = 서버 mine=1(생성자 OR 팀원) 집합 — '내 할당만' 토글의 기준.
    const mineIds = new Set(mineProjects.map((p) => p.id));
    // 보드 커스텀 컬럼(클릭업식 (+)) — 정의 + 프로젝트별 값. 실패해도 컬럼 없이 진행.
    let board = { anchorId: null, fields: [], valuesByProject: {} };
    try {
        board = await api('/api/ui/v6/board-fields');
    }
    catch (_) { /* graceful */ }
    for (const p of allProjects)
        p.field_values = (board.valuesByProject && board.valuesByProject[p.id]) || {};
    const reload = () => renderProjectV2Board(view);
    const meId = (state.me && (state.me.userId || state.me.email)) || '';
    // 삭제 전원 개방(#280) — 인증만 되면 누구나(서버도 인증만 요구). 삭제는 #/trash 에서 복원 가능.
    const canDelete = (_p) => !!meId;
    view.replaceChildren(head, projectSubBar('dashboard'), el('div', { class: 'card-head', style: 'margin: 6px 0 14px' }, el('div', {}, el('span', { class: 'eyebrow', text: '우리 팀' }), el('p', { class: 'sub', style: 'margin: 5px 0 0', text: '내가 참여하거나 우리 팀이 맡은 프로젝트.' }))), pjvProjectListBoard(allProjects, lists, mineIds, reload, canDelete, board.fields || [], board.anchorId, meId), el('div', { class: 'card-head', style: 'margin: 24px 0 14px' }, el('div', {}, el('span', { class: 'eyebrow', text: '회사 전체' }), el('p', { class: 'sub', style: 'margin: 5px 0 0', text: '회사에서 지금 진행 중인 모든 작업.' }))), companyTimelineSection());
    pjvRestoreScroll(keepY); // 인라인 편집 재렌더면 원래 스크롤 위치 복원(#358)
}
// 리스트 1차 그룹 보드 — 한 카드(태스크 리스트와 동일 톤). 헤더 버튼: 하위태스크 표시 · 내 할당만 · Closed · ＋새 리스트.
//  컬럼 헤더는 카드 상단에 한 번. 그 아래 리스트 그룹(접이식) 들이 쌓인다. 펼침 상태는 pjvListOpen 으로 세션 유지.
function pjvProjectListBoard(projects, lists, mineIds, reload, canDelete, fields, anchorId, meId) {
    const card = el('div', { class: 'card pjv-tasks-card pjv-proj-card pjv-listboard', style: 'margin-bottom:18px' });
    // 프로젝트별 태스크 캐시(행 펼침용) — 같은 렌더 동안 재사용(프로미스 캐싱으로 동시요청 합침).
    const taskCache = new Map();
    const fetchProjTasks = (projId) => {
        if (taskCache.has(projId))
            return taskCache.get(projId);
        const pr = api('/api/ui/v6/projects/' + projId).then((d) => {
            const pj = (d && d.project) || d || {};
            return { tasks: pj.tasks || [], members: pj.members || [], fields: pj.fields || [] };
        });
        taskCache.set(projId, pr);
        return pr;
    };
    const taskCtx = { mode: pjvProjTaskMode.mode, fetchProjTasks, invalidate: (id) => taskCache.delete(id) };
    const subtaskBtn = el('button', { class: 'pjv-subtask-btn', type: 'button', title: '태스크 표시 방식' }, pjvSubtaskIcon(), el('span', { class: 'pjv-subtask-btn-label', text: PJV_SUBTASK_BTNLABEL[pjvProjTaskMode.mode] }));
    const mineBtn = el('button', { class: 'pjv-closed-btn pjv-mine-btn', type: 'button', title: '내가 만든·참여한 프로젝트만 보기' }, pjvIcon('assignee'), el('span', { text: '내 할당만' }));
    const closedBtn = el('button', { class: 'pjv-closed-btn', type: 'button', title: '닫힌(완료) 프로젝트 표시' }, pjvCheckCircle(), el('span', { text: 'Closed' }));
    // '필터' 버튼 — 상태(할 일·진행 중·완료)로 나눌지만 토글하는 팝오버. 사이드바(폴더) 여닫기는 이제 아래 '폴더' 버튼 전담(#356).
    const viewBtn = el('button', { class: 'pjv-view-btn', type: 'button', title: '필터 — 상태로 나눠 보기' }, pjvViewIcon(), el('span', { class: 'pjv-view-btn-label', text: '필터' }), el('span', { class: 'pjv-view-btn-caret', 'aria-hidden': 'true', text: '▾' }));
    // '폴더' 사이드바 토글 — 프로젝트를 상위 폴더(사람이 만든 상위 분류)으로 모아 정리하는 좌측 목록을 여닫는다(#356).
    //  이게 사이드바 여닫기의 유일한 스위치(예전엔 '보기/상태' 버튼이 겸했음). byArea 를 켜고, 열 땐 펼친 상태로 연다.
    const sideBtn = el('button', { class: 'pjv-view-btn pjv-bundle-btn', type: 'button', title: '폴더 — 프로젝트를 상위 폴더으로 정리', 'aria-label': '폴더 사이드바 열기/닫기' }, pjvSideToggleIcon(), el('span', { class: 'pjv-view-btn-label', text: '폴더' }));
    const body = el('div', { class: 'pjv-tasks-body' });
    const syncToggles = () => {
        subtaskBtn.classList.toggle('active', pjvProjTaskMode.mode !== 'collapsed');
        const lbl = subtaskBtn.querySelector('.pjv-subtask-btn-label');
        if (lbl)
            lbl.textContent = PJV_SUBTASK_BTNLABEL[pjvProjTaskMode.mode];
        closedBtn.classList.toggle('active', pjvProjClosedView.done);
        mineBtn.classList.toggle('active', pjvBoardMineOnly.on);
        // '필터' 버튼 — 상태로 나누기가 꺼져 있으면(기본과 다름) 강조. 라벨은 '필터' 고정.
        viewBtn.classList.toggle('active', !pjvBoardView.byStatus);
        // '폴더' 사이드바 토글 — 열려 있으면(byArea) 강조.
        sideBtn.classList.toggle('active', pjvBoardView.byArea);
        sideBtn.setAttribute('aria-pressed', String(pjvBoardView.byArea));
    };
    // 상태 그룹(원래 보드) — 할 일/진행 중/완료. 컬럼 헤더 한 번 + pjvProjGroup 재사용(Closed 반영). shown=이미 '내 할당만' 필터된 목록.
    const renderStatus = (shown) => {
        const todo = shown.filter((p) => p.status === 'todo');
        const inprog = shown.filter((p) => p.status !== 'done' && p.status !== 'todo');
        const done = shown.filter((p) => p.status === 'done');
        body.replaceChildren(pjvListColHead(fields, anchorId, reload));
        body.append(pjvProjGroup('진행 중', 'in_progress', inprog, reload, null, canDelete, false, fields, anchorId, meId, taskCtx));
        body.append(pjvProjGroup('할 일', 'todo', todo, reload, null, canDelete, false, fields, anchorId, meId, taskCtx));
        if (pjvProjClosedView.done)
            body.append(pjvProjGroup('완료', 'done', done, reload, null, canDelete, false, fields, anchorId, meId, taskCtx));
    };
    // 평면 — 영역·상태 그룹 없이 한 목록. 컬럼 헤더 + 행들(진행 중→할 일→완료, 같은 상태면 최신순) + 인라인 추가행(미분류로 생성).
    const renderFlat = (shown) => {
        body.replaceChildren(pjvListColHead(fields, anchorId, reload));
        const rank = (p) => p.status === 'done' ? 2 : (p.status === 'todo' ? 1 : 0);
        const rows = shown
            .filter((p) => p.status !== 'done' || pjvProjClosedView.done)
            .slice()
            .sort((a, b) => rank(a) - rank(b) || (Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0)));
        const bodyEl = el('div', { class: 'pjv-tgroup-body pjv-flat-body' });
        for (const p of rows)
            bodyEl.append(pjvProjRow(p, reload, null, canDelete, fields, anchorId, taskCtx));
        if (!rows.length)
            bodyEl.append(el('div', { class: 'pjv-proj-empty', text: pjvBoardMineOnly.on ? '내가 할당된 프로젝트가 없습니다.' : '아직 프로젝트가 없습니다.' }));
        if (!pjvBoardMineOnly.on)
            bodyEl.append(pjvProjAddRow('in_progress', reload, bodyEl, null, fields, null, canDelete, anchorId, meId, taskCtx, null));
        body.append(bodyEl);
    };
    // 영역 목록(좌측) — 펼침: 전체/영역들/미분류 + ＋새 영역. 접힘: 얇은 레일(▶ 펼치기 + 영역 색점). 본문은 선택 영역의 프로젝트.
    //  byStatus 면 각 영역을 상태로 다시 나눔. 접어도 영역 그룹은 유지(레일의 ▶ 로 언제든 다시 펼침) — 영역 자체를 끄려면 보기→영역으로.
    const renderArea = (byStatus) => {
        const groups = pjvBuildListGroups(projects, lists, mineIds, meId);
        // 좌측 사이드바 카운트/표시는 '보이는 것'과 일치 — 완료(done)는 Closed 토글일 때만(본문 필터·그룹 헤더 visibleCount 동형).
        const visCount = (arr) => pjvProjClosedView.done ? arr.length : arr.filter((p) => p.status !== 'done').length;
        // '기타(미분류)'는 보일 게 없으면 좌측에서 숨긴다(빈 항목 노출 방지). 실제 영역은 빈 add 타깃이라 유지.
        const sideGroups = groups.filter((g) => g.list || visCount(g.projects) > 0);
        // 숨겨진 미분류가 선택돼 있었으면 '전체'로 되돌린다(본문이 빈 영역을 렌더하지 않게).
        if (pjvSidebarSel.key === '__none__' && !sideGroups.some((g) => g.key === '__none__'))
            pjvSidebarSel.key = '__all__';
        const sel = pjvSidebarSel.key;
        const selectArea = (key) => { pjvSidebarSel.key = key; render(); };
        // 본문 — 선택 영역(전체=모두)의 프로젝트를 '원래 보드 그대로' 렌더. 영역 구분은 좌측 목록이 담당하므로 본문엔
        //  영역 헤더를 넣지 않는다 → 원래의 여백·정렬·통일성 유지. byStatus 면 상태 그룹(진행 중/할 일/완료), 아니면 한 목록.
        const sg = sel === '__all__' ? null : groups.find((g) => g.key === sel);
        const shownProjects = sel === '__all__' ? groups.flatMap((g) => g.projects) : (sg ? sg.projects : []);
        const listIdForAdd = (sg && sg.list) ? sg.list.id : null; // 특정 영역 선택 시 새 프로젝트는 그 영역으로
        const mineOnly = pjvBoardMineOnly.on;
        const main = el('div', { class: 'pjv-side-main' });
        main.append(pjvListColHead(fields, anchorId, reload));
        if (byStatus) {
            const inprog = shownProjects.filter((p) => p.status !== 'done' && p.status !== 'todo');
            const todo = shownProjects.filter((p) => p.status === 'todo');
            const done = shownProjects.filter((p) => p.status === 'done');
            const sub = (label, key, arr) => main.append(pjvProjGroup(label, key, arr, reload, null, canDelete, false, fields, anchorId, meId, taskCtx, undefined, mineOnly, listIdForAdd));
            if (!mineOnly || inprog.length)
                sub('진행 중', 'in_progress', inprog);
            if (!mineOnly || todo.length)
                sub('할 일', 'todo', todo);
            if (pjvProjClosedView.done && (!mineOnly || done.length))
                sub('완료', 'done', done);
        }
        else {
            const rank = (p) => p.status === 'done' ? 2 : (p.status === 'todo' ? 1 : 0);
            const rows = shownProjects.filter((p) => p.status !== 'done' || pjvProjClosedView.done).slice()
                .sort((a, b) => rank(a) - rank(b) || (Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0)));
            const flatBody = el('div', { class: 'pjv-tgroup-body pjv-flat-body' });
            for (const p of rows)
                flatBody.append(pjvProjRow(p, reload, null, canDelete, fields, anchorId, taskCtx));
            if (!rows.length)
                flatBody.append(el('div', { class: 'pjv-proj-empty', text: mineOnly ? '내가 할당된 프로젝트가 없습니다.' : '아직 프로젝트가 없습니다.' }));
            if (!mineOnly)
                flatBody.append(pjvProjAddRow('in_progress', reload, flatBody, null, fields, null, canDelete, anchorId, meId, taskCtx, listIdForAdd));
            main.append(flatBody);
        }
        // 접힘 — 얇은 레일. ▶ 펼치기(항상 보임) + 전체/영역 색점(클릭=선택). 본문은 그대로.
        if (!pjvSidePanel.open) {
            const rail = el('div', { class: 'pjv-side-rail' });
            const railInner = el('div', { class: 'pjv-side-rail-inner' });
            const expandBtn = el('button', { class: 'pjv-side-expand', type: 'button', title: '폴더 목록 펼치기', 'aria-label': '폴더 목록 펼치기', text: '▶' });
            expandBtn.onclick = (e) => { e.stopPropagation(); pjvSidePanel.open = true; render(); };
            railInner.append(expandBtn);
            const railDot = (key, dot, title, active) => {
                const b = el('button', { class: 'pjv-side-raildot' + (active ? ' active' : ''), type: 'button', title }, dot);
                b.onclick = (e) => { e.stopPropagation(); selectArea(key); };
                return b;
            };
            railInner.append(railDot('__all__', pjvBundleIcon('#6c8cff', 'all'), '전체', sel === '__all__'));
            for (const g of sideGroups) {
                const ic = g.list ? pjvBundleIcon(g.list.color || 'var(--muted-2)') : pjvBundleIcon(null, 'none');
                railInner.append(railDot(g.key, ic, g.list ? g.list.name : '기타 (미분류)', sel === g.key));
            }
            rail.append(railInner);
            body.replaceChildren(el('div', { class: 'pjv-side-wrap pjv-side-collapsed' }, rail, main));
            return;
        }
        // 펼침 — 전체 네비. nav = 본문 높이만큼 늘어나는 레일(구분선), navInner = sticky 항목.
        const nav = el('div', { class: 'pjv-side-nav' });
        const navInner = el('div', { class: 'pjv-side-nav-inner' });
        const navItem = (key, dot, label, count, active) => {
            const it = el('button', { class: 'pjv-side-navitem' + (active ? ' active' : ''), type: 'button' }, dot, el('span', { class: 'pjv-side-navlabel', text: label }), el('span', { class: 'pjv-side-navcount', text: count == null ? '' : String(count) }));
            it.onclick = (e) => { e.stopPropagation(); selectArea(key); };
            return it;
        };
        const collapseBtn = el('button', { class: 'pjv-side-collapse', type: 'button', title: '폴더 목록 접기', 'aria-label': '폴더 목록 접기', text: '◀' });
        collapseBtn.onclick = (e) => { e.stopPropagation(); pjvSidePanel.open = false; render(); };
        navInner.append(el('div', { class: 'pjv-side-nav-head' }, el('span', { class: 'pjv-side-nav-head-label', text: '폴더' }), collapseBtn));
        // 사이드바를 열었을 때만 보이는 안내 — 프로젝트를 상위 폴더으로 직접 정리한다는 느낌을 준다(#356).
        navInner.append(el('div', { class: 'pjv-side-nav-hint', text: '프로젝트를 상위 폴더으로 모아 정리해요.' }));
        //  완료된 미분류 프로젝트가 Closed 꺼져도 사이드바에 '유령 개수'로 잡히던 것·빈 미분류 항목 노출은 visCount/sideGroups 로 처리(위).
        const totalProjs = groups.reduce((n, g) => n + visCount(g.projects), 0);
        navInner.append(navItem('__all__', pjvBundleIcon('#6c8cff', 'all'), '전체', totalProjs, sel === '__all__'));
        for (const g of sideGroups) {
            const ic = g.list ? pjvBundleIcon(g.list.color || 'var(--muted-2)') : pjvBundleIcon(null, 'none');
            navInner.append(navItem(g.key, ic, g.list ? g.list.name : '기타 (미분류)', visCount(g.projects), sel === g.key));
        }
        navInner.append(el('button', { class: 'pjv-side-newlist', type: 'button', onclick: (e) => { e.stopPropagation(); openListForm(reload); } }, el('span', { class: 'pjv-newlist-plus', text: '＋' }), el('span', { text: '새 폴더' })));
        nav.append(navInner);
        body.replaceChildren(el('div', { class: 'pjv-side-wrap' }, nav, main));
    };
    const render = () => {
        taskCtx.mode = pjvProjTaskMode.mode;
        const byArea = pjvBoardView.byArea, byStatus = pjvBoardView.byStatus;
        card.classList.toggle('pjv-has-side', byArea);
        if (byArea) {
            renderArea(byStatus);
            return;
        }
        const shown = pjvBoardMineOnly.on ? projects.filter((p) => mineIds.has(p.id)) : projects;
        if (byStatus) {
            renderStatus(shown);
            return;
        }
        renderFlat(shown);
    };
    viewBtn.onclick = (e) => { e.stopPropagation(); pjvViewMenu(viewBtn, () => { syncToggles(); render(); }); };
    // 사이드바 토글 — byArea 를 뒤집고, 열 땐 접힌 레일이 아니라 펼친 상태로 연다.
    sideBtn.onclick = (e) => { e.stopPropagation(); pjvBoardView.byArea = !pjvBoardView.byArea; if (pjvBoardView.byArea)
        pjvSidePanel.open = true; syncToggles(); render(); };
    subtaskBtn.onclick = (e) => { e.stopPropagation(); pjvProjTaskMenu(subtaskBtn, () => { syncToggles(); render(); }); };
    mineBtn.onclick = (e) => { e.stopPropagation(); pjvBoardMineOnly.on = !pjvBoardMineOnly.on; syncToggles(); render(); };
    closedBtn.onclick = (e) => { e.stopPropagation(); pjvProjClosedView.done = !pjvProjClosedView.done; syncToggles(); render(); };
    syncToggles();
    card.append(el('div', { class: 'card-head' }, el('div', { class: 'pjv-tasks-head-left' }, el('h2', { text: '프로젝트' }), sideBtn, viewBtn, subtaskBtn), el('div', { class: 'card-head-actions' }, mineBtn, closedBtn)));
    card.append(body);
    render();
    return card;
}
// 그룹 빌드 — 내 리스트(펼침) → 그 외 리스트(접힘) → 미분류('기타'). '내 할당만' 이면 내 프로젝트만 남기고 빈 그룹은 숨김.
function pjvBuildListGroups(projects, lists, mineIds, meId) {
    const byList = new Map();
    const unassigned = [];
    for (const p of projects) {
        if (p.list_id == null) {
            unassigned.push(p);
            continue;
        }
        if (!byList.has(p.list_id))
            byList.set(p.list_id, []);
        byList.get(p.list_id).push(p);
    }
    const isMyList = (l) => (l.members || []).some((m) => String(m.member_id) === String(meId));
    const sortLists = (a, b) => (a.sort - b.sort) || String(a.name).localeCompare(String(b.name));
    const my = [], other = [];
    for (const l of [...lists].sort(sortLists))
        (isMyList(l) ? my : other).push(l);
    const mineOnly = pjvBoardMineOnly.on;
    const filterProj = (arr) => mineOnly ? arr.filter((p) => mineIds.has(p.id)) : arr;
    const groups = [];
    const pushList = (l, defaultOpenWhenNotMine) => {
        const projs = filterProj(byList.get(l.id) || []);
        if (mineOnly && !projs.length)
            return; // 내 할당만: 빈 리스트 숨김
        const mine = isMyList(l);
        const key = 'L' + l.id;
        const open = pjvListOpen.has(key) ? pjvListOpen.get(key) : (mineOnly ? true : (mine || defaultOpenWhenNotMine));
        groups.push({ key, list: l, isMine: mine, projects: projs, open });
    };
    for (const l of my)
        pushList(l, true);
    for (const l of other)
        pushList(l, false);
    // 미분류('기타') — 프로젝트가 있으면 표시. 리스트가 하나도 없으면(=전부 미분류) 빈 상태라도 표시해 시작 add-row 노출.
    const unProjs = filterProj(unassigned);
    if (unProjs.length > 0 || (!mineOnly && lists.length === 0)) {
        const key = '__none__';
        const hasMine = unProjs.some((p) => mineIds.has(p.id));
        const open = pjvListOpen.has(key) ? pjvListOpen.get(key) : (mineOnly ? true : (lists.length === 0 || hasMine));
        groups.push({ key, list: null, isMine: false, projects: unProjs, open });
    }
    return groups;
}
// 리스트 한 그룹(접이식) — 헤더(캐럿·색점·이름·개수·내리스트칩 | 멤버 페이스파일·⋯) + 프로젝트 행들 + 인라인 추가행.
function pjvListGroup(g, reload, canDelete, fields, anchorId, meId, taskCtx, nested, bare) {
    const list = g.list; // null = 미분류('기타')
    const isUn = !list;
    const name = isUn ? '기타 (미분류)' : list.name;
    const color = isUn ? 'var(--line, #2a2a33)' : (list.color || avatarColor('list' + list.id));
    const members = isUn ? [] : (list.members || []);
    const listIdForAdd = isUn ? null : list.id;
    const emptyText = pjvBoardMineOnly.on ? '내가 할당된 프로젝트가 없습니다.' : '아직 프로젝트가 없습니다.';
    // 헤더 개수 — 완료는 Closed 일 때만 집계(보이는 것과 일치).
    const visibleCount = pjvProjClosedView.done ? g.projects.length : g.projects.filter((p) => p.status !== 'done').length;
    const bodyEl = el('div', { class: 'pjv-tgroup-body' });
    if (nested) {
        // 리스트 › 상태 — 상태 하위그룹으로 다시 묶되, 추가행은 **상태 그룹마다**(원래 상태 보드처럼). 각 ＋ 가 '이 리스트 + 그 상태'로 생성
        //  (할 일 그룹 ＋ → 그 리스트의 todo / 진행 중 그룹 ＋ → active). 진행 중·할 일은 비어도 항상 표시(추가 진입점). 완료는 Closed 일 때만.
        //  '내 할당만' 읽기 모드에선 추가행 숨김(noAdd) + 빈 상태 그룹 생략.
        const mineOnly = pjvBoardMineOnly.on;
        const inprog = g.projects.filter((p) => p.status !== 'done' && p.status !== 'todo');
        const todo = g.projects.filter((p) => p.status === 'todo');
        const done = g.projects.filter((p) => p.status === 'done');
        const sub = (label, key, arr) => bodyEl.append(pjvProjGroup(label, key, arr, reload, null, canDelete, false, fields, anchorId, meId, taskCtx, undefined, mineOnly, listIdForAdd));
        if (!mineOnly || inprog.length)
            sub('진행 중', 'in_progress', inprog);
        if (!mineOnly || todo.length)
            sub('할 일', 'todo', todo);
        if (pjvProjClosedView.done && (!mineOnly || done.length))
            sub('완료', 'done', done);
        if (mineOnly && !inprog.length && !todo.length && !(pjvProjClosedView.done && done.length))
            bodyEl.append(el('div', { class: 'pjv-proj-empty', text: emptyText }));
    }
    else {
        // 평면 — 완료는 Closed 토글일 때만. 정렬: 진행 중→할 일→완료, 같은 상태면 최신순.
        const rank = (p) => p.status === 'done' ? 2 : (p.status === 'todo' ? 1 : 0);
        const shown = g.projects
            .filter((p) => p.status !== 'done' || pjvProjClosedView.done)
            .slice()
            .sort((a, b) => rank(a) - rank(b) || (Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0)));
        for (const p of shown)
            bodyEl.append(pjvProjRow(p, reload, null, canDelete, fields, anchorId, taskCtx));
        if (!shown.length)
            bodyEl.append(el('div', { class: 'pjv-proj-empty', text: emptyText }));
        if (!pjvBoardMineOnly.on)
            bodyEl.append(pjvProjAddRow('in_progress', reload, bodyEl, null, fields, null, canDelete, anchorId, meId, taskCtx, listIdForAdd));
    }
    // bare — 영역 헤더 생략(단일 영역 선택 시 좌측 네비가 이미 그 영역을 강조 → 본문 헤더는 중복). 본문만 펼친 채 노출.
    if (bare) {
        bodyEl.hidden = false;
        return el('div', { class: 'pjv-tgroup pjv-list-group pjv-list-group-bare', 'data-list-id': isUn ? '' : String(list.id), style: '--list-color:' + color }, bodyEl);
    }
    let open = !!g.open;
    const gcaret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: open ? '▾' : '▸', 'aria-expanded': String(open) });
    bodyEl.hidden = !open;
    const setOpen = (o) => { open = o; pjvListOpen.set(g.key, o); gcaret.textContent = o ? '▾' : '▸'; gcaret.setAttribute('aria-expanded', String(o)); bodyEl.hidden = !o; };
    gcaret.onclick = (e) => { e.stopPropagation(); setOpen(!open); };
    const dot = el('span', { class: 'pjv-list-dot', style: 'background:' + color, 'aria-hidden': 'true' });
    const labelEl = el('span', { class: 'pjv-tgroup-label', text: name });
    const countEl = el('span', { class: 'pjv-tgroup-count', text: String(visibleCount) });
    const mineChip = g.isMine ? el('span', { class: 'pjv-list-mine-chip', title: '내가 참여한 폴더', text: '내 폴더' }) : null;
    const main = el('div', { class: 'pjv-list-head-main' }, gcaret, dot, labelEl, countEl, mineChip);
    // 실제 리스트만 멤버 페이스파일(클릭→멤버 관리, 조용히 저장) + ⋯(이름·색·삭제). 미분류는 액션 없음.
    const actions = el('div', { class: 'pjv-list-head-actions' });
    if (!isUn) {
        const memberCell = pjvProjTeamControl(members, (ids) => pjvSaveListMembers(list.id, ids));
        memberCell.classList.add('pjv-list-members');
        memberCell.title = '폴더 참여 멤버 (참여하면 이 폴더이 기본으로 펼쳐집니다)';
        actions.append(memberCell, pjvListMore(list, reload));
    }
    const headEl = el('div', { class: 'pjv-tgroup-head pjv-list-head' + (isUn ? ' pjv-list-head-un' : '') }, main, actions);
    headEl.addEventListener('click', (e) => {
        if (e.target.closest('button, .pjv-cell-btn, .pjv-menu, input'))
            return;
        setOpen(!open);
    });
    return el('div', { class: 'pjv-tgroup pjv-list-group', 'data-list-id': isUn ? '' : String(list.id), style: '--list-color:' + color }, headEl, bodyEl);
}
// 컬럼 헤더 한 줄(카드 상단) — pjvProjRow 와 같은 그리드. 첫 칸은 '프로젝트' 라벨, 나머지는 팀원/마감/우선/세션 + 커스텀 + (＋컬럼).
function pjvListColHead(fields, anchorId, reload) {
    const headEl = el('div', { class: 'pjv-tgroup-head pjv-tgroup-head-cols pjv-list-colhead' }, el('div', { class: 'pjv-trow-title-cell' }, el('span', { class: 'pjv-list-colhead-name', text: '프로젝트' })), el('div', { class: 'pjv-tcell pjv-colhead', text: '팀원' }), el('div', { class: 'pjv-tcell pjv-colhead', text: '마감일' }), el('div', { class: 'pjv-tcell pjv-colhead', text: '우선순위' }), el('div', { class: 'pjv-tcell pjv-colhead', text: '내 세션' }), ...(fields || []).map((f) => pjvColumnHead(f, anchorId, reload)), el('div', { class: 'pjv-tcell pjv-tcell-add' }, anchorId ? pjvAddColumnButton(anchorId, reload) : el('span', {})));
    headEl.style.gridTemplateColumns = pjvProjGridTemplate(fields);
    return headEl;
}
// 리스트 ⋯ 메뉴 — 이름·색 변경 / 삭제(프로젝트는 보존, 미분류로 이동).
function pjvListMore(list, reload) {
    const btn = el('button', { class: 'pjv-trow-more', type: 'button', title: '폴더 작업', 'aria-label': '폴더 작업', text: '⋯' });
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu' });
        const close = pjvPopover(btn, menu);
        const mk = (label, fn, danger) => { const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label })); b.onclick = () => { close(); fn(); }; return b; };
        menu.append(mk('이름·색 변경', () => openListForm(reload, list)));
        menu.append(mk('삭제', () => pjvDeleteList(list, reload), true));
    };
    return btn;
}
function pjvDeleteList(list, reload) {
    if (!confirm('폴더 ‘' + list.name + '’을(를) 삭제할까요?\n\n폴더만 사라지고, 속한 프로젝트는 ‘기타(미분류)’로 이동합니다(프로젝트는 보존).'))
        return;
    (async () => {
        try {
            await api('/api/ui/v6/project-lists/' + list.id + '/delete', { method: 'POST' });
            toast('폴더을 삭제했습니다');
            reload();
        }
        catch (e) {
            toast('삭제 실패 — ' + e.message, true);
        }
    })();
}
// 리스트 멤버 저장(조용히 — 팝오버 안에서 연속 토글, reload 없음). 멤버십 변화는 다음 렌더에 펼침/접힘으로 반영.
function pjvSaveListMembers(id, ids) {
    return api('/api/ui/v6/project-lists/' + id + '/members', { method: 'POST', body: JSON.stringify({ members: ids }) })
        .catch((e) => toast('폴더 멤버 저장 실패 — ' + e.message, true));
}
// 리스트 색 팔레트(생성/수정 폼). 빈값='자동'(id 해시색).
const PJV_LIST_COLORS = ['#6c8cff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#64748b'];
// 새 리스트 / 리스트 수정 폼 — 이름·색 (+ 생성 시 참여 멤버). 저장 후 reload.
//  opts.onCreated(list) — 생성(수정 아님) 성공 시 새로 만든 영역(서버 응답 { list })을 넘긴다.
//  새 프로젝트 모달의 분류(영역) 피커가 인라인으로 영역을 만들고 곧장 선택하는 데 쓴다(#337).
function openListForm(reload, list, opts) {
    const editing = !!list;
    const nameIn = el('input', { type: 'text', value: editing ? list.name : '', placeholder: '폴더 이름 (예: 컨텍스트 저장소)', maxlength: '120' });
    let color = editing ? (list.color || '') : '';
    const swatches = el('div', { class: 'pjv-color-swatches' });
    const paintSw = () => {
        const none = el('button', { class: 'pjv-sw pjv-sw-none' + (color ? '' : ' on'), type: 'button', title: '자동(이름 해시색)', text: 'A' });
        none.onclick = () => { color = ''; paintSw(); };
        swatches.replaceChildren(none, ...PJV_LIST_COLORS.map((c) => {
            const s = el('button', { class: 'pjv-sw' + (color === c ? ' on' : ''), type: 'button', style: 'background:' + c, title: c });
            s.onclick = () => { color = c; paintSw(); };
            return s;
        }));
    };
    paintSw();
    const picker = editing ? null : memberPicker([], { includeMe: true });
    const saveBtn = el('button', { class: 'btn btn-primary', text: editing ? '저장' : '만들기' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
    const rows = [
        el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
        el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '색' }), swatches),
    ];
    if (picker)
        rows.push(el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '참여 멤버 (이 폴더을 펼쳐 보는 사람)' }), picker.box));
    const back = overlayBox(editing ? '폴더 수정' : '새 폴더', ...rows, el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
    setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
    const go = async () => {
        const nm = nameIn.value.trim();
        if (!nm) {
            nameIn.focus();
            toast('이름을 입력하세요', true);
            return;
        }
        saveBtn.disabled = true;
        try {
            if (editing) {
                await api('/api/ui/v6/project-lists/' + list.id, { method: 'POST', body: JSON.stringify({ name: nm, color: color || null }) });
            }
            else {
                const res = await api('/api/ui/v6/project-lists', { method: 'POST', body: JSON.stringify({ name: nm, color: color || null, members: picker ? picker.getSelected() : [] }) });
                if (opts && opts.onCreated)
                    opts.onCreated((res && res.list) || null);
            }
            back.remove();
            toast(editing ? '폴더을 수정했습니다' : '폴더을 만들었습니다');
            if (reload)
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
    return back;
}
// 프로젝트를 다른 리스트로 이동(또는 미분류로) — 행 ⋯ 메뉴에서 호출. 리스트 목록을 그 자리에서 fetch.
function pjvMoveProjectList(anchor, p, reload) {
    const menu = el('div', { class: 'pjv-menu pjv-listmove-pop' });
    const close = pjvPopover(anchor, menu);
    const head = el('div', { class: 'pjv-menu-head', text: '폴더으로 이동' });
    menu.append(head, el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
    api('/api/ui/v6/project-lists').then((d) => {
        const lists = (d && d.lists) || [];
        menu.replaceChildren(head);
        const mkItem = (label, listId, color) => {
            const cur = (p.list_id == null ? listId == null : String(p.list_id) === String(listId));
            const item = el('button', { class: 'pjv-menu-item' + (cur ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-list-dot sm', style: 'background:' + (color || 'var(--line, #2a2a33)') }), el('span', { class: 'pjv-asg-mname', text: label }), el('span', { class: 'pjv-asg-check', text: cur ? '✓' : '' }));
            item.onclick = async (e) => {
                e.stopPropagation();
                close();
                if (cur)
                    return;
                try {
                    await api('/api/ui/v6/projects/' + p.id + '/list', { method: 'POST', body: JSON.stringify({ list_id: listId }) });
                    toast(listId == null ? '미분류로 옮겼습니다' : '폴더으로 옮겼습니다');
                    if (reload)
                        reload();
                }
                catch (err) {
                    toast('이동 실패 — ' + err.message, true);
                }
            };
            return item;
        };
        menu.append(mkItem('기타 (미분류)', null, null));
        for (const l of lists)
            menu.append(mkItem(l.name, l.id, l.color || avatarColor('list' + l.id)));
        const addNew = el('button', { class: 'pjv-menu-item pjv-sess-add', type: 'button' }, el('span', { class: 'pjv-sess-add-ico', text: '＋' }), el('span', { text: '새 폴더…' }));
        addNew.onclick = (e) => { e.stopPropagation(); close(); openListForm(reload); };
        menu.append(el('div', { class: 'pjv-bulk-sep-h' }), addNew);
    }).catch((err) => menu.replaceChildren(head, el('div', { class: 'pjv-menu-empty', text: '폴더을 불러오지 못했어요 — ' + err.message })));
}
// 보드 한 섹션(진행 중 / 완료) — 카드 + 개수 배지 + 타일 그리드. renderProjects 의 projectSection 짜임 재사용.
function pjvBoardTile(p) {
    const isDone = p.status === 'done';
    const tile = el('div', { class: 'project-tile' + (isDone ? ' done' : ''),
        role: 'link', tabindex: '0', onclick: () => { location.hash = '#/projects2/p/' + p.id; } });
    tile.addEventListener('keydown', (ev) => { if (ev.key === 'Enter')
        location.hash = '#/projects2/p/' + p.id; });
    tile.append(el('div', { class: 'project-tile-name', text: p.name }));
    if (p.description)
        tile.append(el('div', { class: 'project-tile-desc', text: p.description }));
    const mc = Number(p.member_count != null ? p.member_count : (p.members ? p.members.length : 0)) || 0;
    const when = isDone ? (p.completed_at || p.updated_at) : (p.updated_at || p.created_at);
    tile.append(el('div', { class: 'project-tile-foot' }, el('span', { class: 'project-tile-meta', text: (isDone ? '완료 ' : '갱신 ') + (when ? relTime(when) : '') }), el('span', { class: 'pjv-tile-badge' }, el('span', { class: 'pill-state' + (isDone ? '' : ' confirmed'), text: PJV_STATUS_LABEL[p.status] || p.status }), mc ? el('span', { class: 'pjv-tile-members', text: '👤 ' + mc }) : null)));
    return tile;
}
// ════════════════════════════════════════════
// 프로젝트 목록(클릭업식 리스트) — 카드 대신 태스크 리스트와 동일한 그룹/행 UI.
//  진행 중/완료 두 그룹(상태 동그라미·개수·캐럿) + 컬럼 헤더(팀원·갱신) + 프로젝트 한 줄.
//  이름 클릭=상세 이동, 상태 동그라미=진행↔완료 토글. 선택(일괄삭제) 모드면 앞에 체크박스.
// ════════════════════════════════════════════
const PJV_PROJ_GRID = 'minmax(0, 1fr) 140px 120px';
function pjvProjStatusMeta(status) {
    // 태스크 리스트와 동일한 3단계 — 할 일(점선 링)·진행 중(◐)·완료(✓ 민트).
    //  레거시·기본값 'active' 는 '진행 중'으로 흡수(표시만 — 기존 active 프로젝트가 진행 중에 그대로 보이게).
    if (status === 'done')
        return { key: 'done', label: '완료', cls: 'done', glyph: '✓' };
    if (status === 'todo')
        return { key: 'todo', label: '할 일', cls: 'todo', glyph: '' };
    return { key: 'in_progress', label: '진행 중', cls: 'inprog', glyph: '◐' };
}
async function pjvSetProjStatus(id, status, reload) {
    try {
        await api('/api/ui/v6/projects/' + id + '/status', { method: 'POST', body: JSON.stringify({ status }) });
        toast(status === 'done' ? '완료된 프로젝트로 옮겼습니다'
            : status === 'todo' ? '할 일로 옮겼습니다'
                : '진행 중으로 옮겼습니다');
        pjvReloadKeepScroll(reload); // 상태 아이콘 변경 후 위로 튀지 않게 스크롤 보존(#358)
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
// 상태 동그라미(클릭→진행 중/완료 메뉴) — 태스크 pjvStatusControl 과 같은 결.
function pjvProjStatusDot(p, reload) {
    const meta = pjvProjStatusMeta(p.status);
    const btn = el('button', { class: 'pjv-status-dot ' + meta.cls, type: 'button',
        title: '상태: ' + meta.label, 'aria-label': '상태 ' + meta.label }, meta.glyph ? el('span', { class: 'pjv-status-glyph', text: meta.glyph }) : null);
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu' });
        const close = pjvPopover(btn, menu);
        for (const st of ['todo', 'in_progress', 'done']) {
            const m = pjvProjStatusMeta(st);
            const cur = pjvProjStatusMeta(p.status).key === st;
            const item = el('button', { class: 'pjv-menu-item' + (cur ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-status-dot sm ' + m.cls }, m.glyph ? el('span', { class: 'pjv-status-glyph', text: m.glyph }) : null), el('span', { text: m.label }));
            item.onclick = () => { close(); if (!cur)
                pjvSetProjStatus(p.id, st, reload); };
            menu.append(item);
        }
    };
    return btn;
}
// 팀원 페이스파일(최대 4 + N) — 없으면 '—'.
function pjvProjFacepile(members) {
    const arr = members || [];
    if (!arr.length)
        return el('span', { class: 'pjv-proj-noface', text: '—' });
    const faces = el('div', { class: 'project-tile-faces pjv-proj-faces' });
    for (const m of arr.slice(0, 4))
        faces.append(el('span', { class: 'project-face',
            style: 'background:' + avatarColor(m.member_id), title: m.display_name || m.member_id, text: initials(m.display_name || m.member_id) }));
    if (arr.length > 4)
        faces.append(el('span', { class: 'project-face more', text: '+' + (arr.length - 4) }));
    return faces;
}
// 팀원 필드(보기 전용) — 클릭하면 팀원 목록을 쭉 보여주는 팝오버. 넣고 빼는(토글) UI 없음.
//  팀원=담당자 — 메타에선 보기만 하고, 변경은 '프로젝트 세부 설정'에서만.
function pjvProjTeamView(members) {
    const arr = members || [];
    const btn = el('button', { class: 'pjv-cell-btn' + (arr.length ? '' : ' empty'), type: 'button', title: '팀원 (보기 전용 — 변경은 프로젝트 세부 설정)' });
    if (arr.length) {
        const faces = el('span', { class: 'pjv-asg-faces' });
        for (const m of arr.slice(0, 3))
            faces.append(el('span', { class: 'pjv-ava', style: 'background:' + avatarColor(m.member_id), title: m.display_name || m.member_id, text: initials(m.display_name || m.member_id) }));
        if (arr.length > 3)
            faces.append(el('span', { class: 'pjv-ava pjv-ava-more', text: '+' + (arr.length - 3) }));
        btn.append(faces);
    }
    else {
        btn.append(pjvIcon('assignee'));
    }
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu pjv-asg-menu pjv-team-view' });
        pjvPopover(btn, menu);
        menu.append(el('div', { class: 'pjv-menu-head', text: '팀원' }));
        if (!arr.length)
            menu.append(el('div', { class: 'pjv-menu-empty', text: '아직 팀원이 없어요.' }));
        else
            for (const m of arr)
                menu.append(el('div', { class: 'pjv-team-view-row' }, el('span', { class: 'pjv-ava', style: 'background:' + avatarColor(m.member_id), text: initials(m.display_name || m.member_id) }), el('span', { class: 'pjv-asg-mname', text: m.display_name || m.member_id })));
        menu.append(el('div', { class: 'pjv-team-view-hint', text: '변경은 ‘프로젝트 세부 설정’에서' }));
    };
    return btn;
}
function projSaveQuiet(id, patch) {
    return api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify(patch) }).catch((e) => toast('수정 실패 — ' + e.message, true));
}
// 전체 사람 구성원 디렉터리(팀원 검색 후보) — /api/ui/dash/members 1회 캐시. 팀원 팝오버가 공유한다(memberPicker 와 동일 소스).
let _pjvMemDir = null;
function pjvMemberDirectory() {
    if (!_pjvMemDir)
        _pjvMemDir = api('/api/ui/dash/members').then((d) => (d && d.members) || []).catch((e) => { _pjvMemDir = null; throw e; });
    return _pjvMemDir;
}
// 프로젝트 팀원 저장 — 전체 멤버 id 목록을 통째로 보낸다(setProjectMembers = 전체 교체). 조용히(토스트만).
function pjvSaveProjMembers(id, ids) {
    return api('/api/ui/v6/projects/' + id + '/members', { method: 'POST', body: JSON.stringify({ members: ids }) })
        .catch((e) => toast('팀원 저장 실패 — ' + e.message, true));
}
// 팀원 셀 — 멤버 페이스파일(클릭→전체 구성원 검색·다중토글 팝오버). 프로젝트의 '담당자'를 대체한다.
//  currentMembers=[{member_id,display_name}](보드 listProjects 가 채움). applyIds(ids)= 저장(프로젝트 행) 또는 드래프트 갱신(추가행).
//  태스크의 pjvAssigneeControl 과 같은 결(팝오버·아바타·체크) + 검색 인풋으로 전체 구성원에서 고른다.
function pjvProjTeamControl(currentMembers, applyIds) {
    let members = (currentMembers || []).map((m) => ({ id: m.member_id, name: m.display_name || m.member_id }));
    const btn = el('button', { class: 'pjv-cell-btn', type: 'button', title: '팀원' });
    function render() {
        btn.className = 'pjv-cell-btn' + (members.length ? '' : ' empty');
        if (members.length) {
            const faces = el('span', { class: 'pjv-asg-faces' });
            for (const m of members.slice(0, 3))
                faces.append(el('span', { class: 'pjv-ava', style: 'background:' + avatarColor(m.id), title: m.name, text: initials(m.name) }));
            if (members.length > 3)
                faces.append(el('span', { class: 'pjv-ava pjv-ava-more', text: '+' + (members.length - 3) }));
            btn.replaceChildren(faces);
        }
        else {
            btn.replaceChildren(pjvIcon('assignee'));
        }
    }
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu pjv-asg-menu pjv-team-menu' });
        pjvPopover(btn, menu);
        const search = el('input', { type: 'text', class: 'pjv-team-search', placeholder: '이름으로 검색해 추가/해제…', spellcheck: 'false', autocomplete: 'off' });
        const listBox = el('div', { class: 'pjv-team-list' });
        menu.append(el('div', { class: 'pjv-team-searchwrap' }, search), listBox);
        let all = null;
        const setIds = (ids) => {
            members = ids.map((id) => { const m = all && all.find((x) => x.id === id); return { id, name: m ? (m.display_name || id) : id }; });
            render();
            applyIds(ids);
            rebuild();
        };
        function rebuild() {
            if (!all) {
                listBox.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
                return;
            }
            const selIds = new Set(members.map((m) => m.id));
            const q = search.value.trim().toLowerCase();
            const cand = all.filter((m) => !q || (m.display_name || m.id).toLowerCase().includes(q));
            if (!cand.length) {
                listBox.replaceChildren(el('div', { class: 'pjv-menu-empty', text: q ? '일치하는 사람이 없어요.' : '구성원이 없습니다.' }));
                return;
            }
            listBox.replaceChildren(...cand.map((m) => {
                const on = selIds.has(m.id);
                const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-ava', style: 'background:' + avatarColor(m.id), text: initials(m.display_name || m.id) }), el('span', { class: 'pjv-asg-mname', text: m.display_name || m.id }), el('span', { class: 'pjv-asg-check', text: on ? '✓' : '' }));
                item.onclick = (ev) => { ev.stopPropagation(); const cur = members.map((x) => x.id); setIds(on ? cur.filter((x) => x !== m.id) : [...cur, m.id]); };
                return item;
            }));
        }
        pjvMemberDirectory().then((dir) => { all = dir; rebuild(); }).catch(() => listBox.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '구성원을 불러오지 못했어요.' })));
        search.addEventListener('input', rebuild);
        setTimeout(() => search.focus(), 0);
    };
    render();
    return btn;
}
async function projPatch(id, patch, reload) {
    try {
        await api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify(patch) });
        pjvReloadKeepScroll(reload);
    }
    catch (e) {
        toast('수정 실패 — ' + e.message, true);
    }
}
// 행 끝 ⋯ 메뉴 — 이름 변경 · 상태 토글 · 삭제(작성자만, 서버 403 재검증).
function pjvProjMore(p, reload, canDelete) {
    const btn = el('button', { class: 'pjv-trow-more', type: 'button', title: '더보기', 'aria-label': '프로젝트 작업', text: '⋯' });
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu' });
        const close = pjvPopover(btn, menu);
        const mk = (label, fn, danger) => { const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label })); b.onclick = () => { close(); fn(); }; return b; };
        menu.append(mk('이름 변경', () => pjvProjRename(btn, p, reload), false));
        menu.append(mk(p.status === 'done' ? '진행 중으로' : '완료된 프로젝트로', () => pjvSetProjStatus(p.id, p.status === 'done' ? 'in_progress' : 'done', reload), false));
        menu.append(mk('폴더 이동', () => pjvMoveProjectList(btn, p, reload), false));
        if (canDelete(p))
            menu.append(mk('삭제', () => pjvProjDelete(p, reload), true));
    };
    return btn;
}
function pjvProjRename(anchor, p, reload) {
    const input = el('input', { type: 'text', class: 'pjv-rename-input', value: p.name, maxlength: '200' });
    const close = pjvPopover(anchor, el('div', { class: 'pjv-menu pjv-rename-pop' }, input));
    input.onkeydown = async (e) => {
        if (e.key !== 'Enter')
            return;
        e.preventDefault();
        const v = input.value.trim();
        close();
        if (v && v !== p.name) {
            try {
                await api('/api/ui/v6/projects/' + p.id, { method: 'POST', body: JSON.stringify({ name: v }) });
                reload();
            }
            catch (err) {
                toast('수정 실패 — ' + err.message, true);
            }
        }
    };
    setTimeout(() => { input.focus(); input.select(); }, 0);
}
function pjvProjDelete(p, reload) {
    if (!confirm('프로젝트 ‘' + p.name + '’을(를) 삭제할까요?\n\n프로젝트와 그 안의 작업(태스크·하위)이 함께 사라집니다(되돌릴 수 없음).'))
        return;
    (async () => {
        try {
            await api('/api/ui/v6/projects/' + p.id + '/delete', { method: 'POST' });
            toast('프로젝트를 삭제했습니다');
            reload();
        }
        catch (e) {
            toast('삭제 실패 — ' + e.message, true);
        }
    })();
}
// 프로젝트 한 줄(태스크 행과 동형) — [캐럿자리][상태점/체크] 이름 | 담당자 | 마감일 | 우선순위 | 커스텀… | ⋯.
// '내 세션' 셀(프로젝트 목록 전용) — 터미널 아이콘 클릭 → 이 프로젝트의 '내 세션' 목록 팝업 → 고르면 새 탭으로 입장.
function pjvProjSessionCell(p, reload) {
    // 내 세션이 있으면 활성(컬러 터미널 아이콘 + 작은 라이브 점), 없으면 옅게(비활성). my_session_count 는 보드 API 가 부여.
    const nSess = Number(p.my_session_count || 0);
    const active = nSess > 0;
    const btn = el('button', { class: 'pjv-cell-btn' + (active ? ' pjv-sess-active' : ' empty'), type: 'button',
        title: active ? ('내 세션 ' + nSess + '개 — 클릭해 입장/추가') : '내 세션 없음 — 클릭해 만들기' }, el('span', { class: 'pjv-sess-ico-wrap' }, pjvIcon('session'), active ? el('span', { class: 'pjv-sess-dot', 'aria-hidden': 'true' }) : null));
    // 그 자리에서 바로 '새 터미널 세션' 폼을 띄운다 — 프로젝트 안으로 들어가지 않음. 이름은 프로젝트명으로 프리필.
    const openCreate = () => openProjectSessionForm(p.id, reload, '/api/ui/v6/projects/', p.name, p.repos);
    btn.onclick = (e) => {
        e.stopPropagation();
        // 활성·비활성 공통으로 같은 드롭다운을 띄운다 — 비활성도 곧장 폼이 뜨지 않고 '＋ 새 세션 만들기'를 거치게(이미지 참고).
        const menu = el('div', { class: 'pjv-menu pjv-sess-menu' });
        const close = pjvPopover(btn, menu);
        // '＋ 새 세션 만들기' — 프로젝트로 안 들어가고 그 자리에서 새 세션 생성 폼. (활성·비활성 공통 항목)
        const addItem = el('button', { class: 'pjv-menu-item pjv-sess-add', type: 'button' }, el('span', { class: 'pjv-sess-ico pjv-sess-add-ico', text: '＋' }), el('span', { text: '새 세션 만들기' }));
        addItem.onclick = (ev) => { ev.stopPropagation(); close(); openCreate(); };
        if (!active) {
            // 내 세션 없음 → 빈 목록 fetch 없이 곧장 안내 + 새 세션 만들기(활성 드롭다운과 같은 모양·위치).
            menu.append(el('div', { class: 'pjv-menu-empty', text: '내 세션이 없습니다' }), addItem);
            return;
        }
        // 내 세션 있음 → 내 세션들(입장) + '＋ 새 세션 만들기'.
        menu.append(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
        api('/api/ui/v6/projects/' + p.id + '/sessions')
            .then((d) => {
            const mine = ((d && d.sessions) || []).filter((s) => s.owned); // owned = 서버가 판정한 '내 세션'
            menu.replaceChildren();
            for (const s of mine) {
                const item = el('button', { class: 'pjv-menu-item', type: 'button', title: s.id }, el('span', { class: 'pjv-sess-ico' }, pjvIcon('session')), el('span', { class: 'pjv-sess-name', text: s.label || s.id }));
                item.onclick = (ev) => {
                    ev.stopPropagation();
                    close();
                    window.open('/ui/terminal.html?session=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || ''), '_blank');
                };
                menu.append(item);
            }
            menu.append(addItem);
        })
            .catch((err) => { menu.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '불러오기 실패 — ' + err.message })); });
    };
    return btn;
}
// ════════════════════════════════════════════════════════════════════════════
// 클릭업식 다중선택 — 행 호버 시 좌측 체크박스 + 제목 우측 아이콘 3개(추가·태그·이름변경),
//  체크박스로 1개 이상 선택하면 화면 하단 일괄작업 바(상태·담당자·마감·우선순위·태그·복제·삭제).
//  선택은 종류(project|task)별로 분리(혼합 금지). 한 화면 안에서만 유효 — 재렌더/이동 시 비운다.
// ════════════════════════════════════════════════════════════════════════════
const pjvSel = { kind: null, ids: new Set(), items: new Map(), ctx: null };
let pjvSelLastEl = null; // 마지막으로 클릭한 체크박스 — Shift+클릭 범위선택의 앵커(#366)
let pjvSelSilent = false; // 드래그/범위 페인트 중엔 하단 바 재렌더를 억제하고 끝에서 1회만(#366)
function pjvSelDomClear() {
    document.querySelectorAll('.pjv-row-check.on').forEach((c) => c.classList.remove('on'));
    document.querySelectorAll('.pjv-trow-wrap.pjv-row-selected').forEach((w) => w.classList.remove('pjv-row-selected'));
}
function pjvSelReset() {
    pjvSelDomClear();
    pjvSel.kind = null;
    pjvSel.ids.clear();
    pjvSel.items.clear();
    pjvSel.ctx = null;
    pjvSelLastEl = null;
    pjvSelRenderBar();
}
function pjvSelToggle(kind, item, ctx) {
    if (pjvSel.kind && pjvSel.kind !== kind) {
        pjvSelDomClear();
        pjvSel.ids.clear();
        pjvSel.items.clear();
    } // 종류 전환 — 기존 비움
    pjvSel.kind = kind;
    pjvSel.ctx = ctx;
    if (pjvSel.ids.has(item.id)) {
        pjvSel.ids.delete(item.id);
        pjvSel.items.delete(item.id);
    }
    else {
        pjvSel.ids.add(item.id);
        pjvSel.items.set(item.id, item);
    }
    if (!pjvSel.ids.size)
        pjvSel.kind = null;
    if (!pjvSelSilent)
        pjvSelRenderBar();
}
function pjvSelReloadAfter() { const r = pjvSel.ctx && pjvSel.ctx.reload; pjvSelReset(); if (r)
    r(); }
const pjvSelIds = () => [...pjvSel.ids];
const pjvSelPatchUrl = (id) => (pjvSel.kind === 'task' ? '/api/ui/v6/tasks/' + id : '/api/ui/v6/projects/' + id);
async function pjvBulkApply(perId, okMsg) {
    const ids = pjvSelIds();
    const res = await Promise.allSettled(ids.map(perId));
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    const fail = res.length - ok;
    toast(fail ? (ok + '개 적용 · ' + fail + '개 실패') : (okMsg || (ok + '개 적용됨')), fail > 0);
    pjvSelReloadAfter();
}
// 하단 일괄작업 바 — 선택 1개 이상일 때만. document.body 에 고정.
let pjvBulkBarEl = null;
function pjvSelRenderBar() {
    if (!pjvBulkBarEl) {
        pjvBulkBarEl = el('div', { class: 'pjv-bulkbar' });
        document.body.append(pjvBulkBarEl);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pjvSel.ids.size)
            pjvSelReset(); });
    }
    const n = pjvSel.ids.size;
    if (!n) {
        pjvBulkBarEl.classList.remove('show');
        pjvBulkBarEl.replaceChildren();
        return;
    }
    pjvBulkBarEl.classList.add('show');
    const isTask = pjvSel.kind === 'task';
    const mk = (label, icon, fn, danger) => {
        const b = el('button', { class: 'pjv-bulk-btn' + (danger ? ' danger' : ''), type: 'button' }, pjvBulkIcon(icon), el('span', { text: label }));
        b.onclick = (e) => { e.stopPropagation(); fn(b); };
        return b;
    };
    pjvBulkBarEl.replaceChildren(el('div', { class: 'pjv-bulk-count' }, el('span', { class: 'pjv-bulk-n', text: String(n) }), el('span', { class: 'pjv-bulk-lbl', text: (isTask ? '태스크' : '프로젝트') + ' 선택됨' }), el('button', { class: 'pjv-bulk-x', type: 'button', title: '선택 해제 (Esc)', text: '✕', onclick: () => pjvSelReset() })), el('div', { class: 'pjv-bulk-actions' }, mk('상태', 'status', pjvBulkStatus), mk('담당자', 'assignee', pjvBulkAssignee), mk('마감일', 'due', pjvBulkDue), mk('우선순위', 'priority', pjvBulkPriority), isTask ? mk('태그', 'tag', pjvBulkTags) : null, !isTask ? mk('폴더', 'list', pjvBulkList) : null, mk('복제', 'dup', () => pjvBulkDuplicate()), mk('삭제', 'trash', () => pjvBulkDelete(), true)), isTask ? el('button', { class: 'pjv-bulk-run', type: 'button', title: '선택한 태스크로 내 새 클로드 세션을 만들고 바로 실행을 맡깁니다',
        onclick: (e) => { e.stopPropagation(); pjvBulkRunClaude(e.currentTarget); } }, pjvBulkIcon('run'), el('span', { text: '클로드로 실행' })) : null);
}
function pjvBulkIcon(kind) {
    if (kind === 'assignee')
        return pjvIcon('assignee');
    if (kind === 'due')
        return pjvIcon('due');
    if (kind === 'priority')
        return pjvIcon('priority');
    const svg = (...k) => sv('svg', { class: 'pjv-bulk-ic', viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ...k);
    if (kind === 'status')
        return svg(sv('circle', { cx: '12', cy: '12', r: '8.2' }), sv('path', { d: 'M8.5 12.2l2.4 2.4 4.6-5' }));
    if (kind === 'tag')
        return svg(sv('path', { d: 'M4 4h7l9 9-7 7-9-9z' }), sv('circle', { cx: '8.2', cy: '8.2', r: '1.3' }));
    if (kind === 'dup')
        return svg(sv('rect', { x: '8', y: '8', width: '12', height: '12', rx: '2' }), sv('path', { d: 'M4 16V5a1 1 0 0 1 1-1h11' }));
    if (kind === 'trash')
        return svg(sv('path', { d: 'M5 7h14M10 7V5.5h4V7M6.5 7l1 12.5h9l1-12.5' }));
    if (kind === 'list')
        return svg(sv('path', { d: 'M8 6h12M8 12h12M8 18h12' }), sv('circle', { cx: '4', cy: '6', r: '1.2' }), sv('circle', { cx: '4', cy: '12', r: '1.2' }), sv('circle', { cx: '4', cy: '18', r: '1.2' }));
    if (kind === 'run')
        return svg(sv('path', { d: 'M8 5.4v13.2l11-6.6z', fill: 'currentColor', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }));
    return svg();
}
// 선택한 태스크 → 내 새 클로드 세션을 만들고(내 이름·태스크 기반 라벨) 새 탭으로 열어, 그 태스크들을 클로드에게 실행 요청까지 원클릭.
//  세션은 autoApprove(=claude --dangerously-skip-permissions)로 만들어 멈춤 없이 실행. 프롬프트 주입은 terminal.js 가 부팅 후 1회(localStorage 핸드오프).
async function pjvBulkRunClaude(btn) {
    if (pjvSel.kind !== 'task' || !pjvSel.ids.size)
        return;
    const ctx = pjvSel.ctx || {};
    const pid = ctx.projectId;
    if (!pid) {
        toast('프로젝트를 찾을 수 없어요', true);
        return;
    }
    const ids = [...pjvSel.ids];
    const B = '/api/ui/v6/projects/' + pid;
    const meId = (state.me && (state.me.userId || state.me.email)) || '';
    const meName = (((ctx.members || []).find((m) => m.member_id === meId) || {}).display_name) || meId || '나';
    const labelSpan = btn ? btn.querySelector('span') : null;
    const origLabel = labelSpan ? labelSpan.textContent : '';
    if (btn)
        btn.disabled = true;
    if (labelSpan)
        labelSpan.textContent = '내용 준비 중…';
    // 팝업 전체 내용을 모은다: 상세(본문·체크리스트·댓글/주석) + 첨부 파일 경로(이미지는 클로드가 직접 열어 확인) + 하위태스크(재귀로 동일하게).
    const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i;
    const detailOf = (tid) => api('/api/ui/v6/tasks/' + tid + '/detail').catch(() => null);
    const attsOf = (tid) => api(B + '/files?path=' + encodeURIComponent('_attachments/task-' + tid))
        .then((r) => ((r && r.items) || []).filter((it) => it.type === 'file').map((it) => it.name)).catch(() => []);
    const blockOf = async (t, depth) => {
        const ind = '  '.repeat(depth);
        const out = [ind + (depth ? '◦ ' : '■ ') + (t.name || ('태스크 ' + t.id))
                + (t.status ? ' [' + t.status + ']' : '') + (t.priority ? ' (우선순위:' + t.priority + ')' : '') + (t.due_date ? ' (마감:' + t.due_date + ')' : '')];
        const desc = (t.description || '').trim();
        out.push(ind + '  본문: ' + (desc ? desc.replace(/\n/g, '\n' + ind + '  ') : '(없음)'));
        const atts = await attsOf(t.id);
        if (atts.length) {
            const hasImg = atts.some((n) => IMG_RE.test(n));
            out.push(ind + '  첨부: ' + atts.map((n) => '_attachments/task-' + t.id + '/' + n).join(', ') + (hasImg ? '  ← 이미지는 직접 열어 확인할 것' : ''));
        }
        return out.join('\n');
    };
    const extrasOf = (d, ind) => {
        const out = [];
        for (const cl of ((d && d.checklists) || [])) {
            const its = (cl.items || []);
            if (its.length)
                out.push(ind + '체크리스트' + (cl.name ? '(' + cl.name + ')' : '') + ': ' + its.map((i) => (i.done ? '[x]' : '[ ]') + (i.text || i.name || '')).join(' / '));
        }
        const cm = ((d && d.feed) || []).filter((f) => f.kind === 'comment' && f.body).map((f) => String(f.body).trim().replace(/\n/g, ' '));
        if (cm.length)
            out.push(ind + '댓글/주석: ' + cm.map((c) => '“' + c + '”').join('  '));
        return out;
    };
    let prompt = '', projName = '';
    try {
        const blocks = [];
        for (const id of ids) {
            const d = await detailOf(id);
            if (d && d.project && !projName)
                projName = d.project.name || '';
            const t = (d && d.task) || pjvSel.items.get(id) || { id, name: '태스크 ' + id };
            const parts = [await blockOf(t, 0), ...extrasOf(d, '  ')];
            const subs = (t.subtasks || []);
            if (subs.length) {
                parts.push('  하위태스크 (' + subs.length + '):');
                for (const s0 of subs) {
                    const sd = await detailOf(s0.id);
                    const s = (sd && sd.task) || s0;
                    parts.push(await blockOf(s, 1), ...extrasOf(sd, '    '));
                }
            }
            blocks.push(parts.join('\n'));
        }
        prompt = (projName ? ('프로젝트: ' + projName + '. ') : '')
            + '아래 태스크들을 진행해줘. 각 태스크의 본문·체크리스트·댓글(주석)·첨부·하위태스크를 모두 반영하고, 첨부 이미지는 경로를 직접 열어 확인해. 각 태스크를 끝내면 무엇을 했는지 보고하고, 막히면 질문해줘.\n\n' + blocks.join('\n\n');
    }
    catch (e) {
        if (btn)
            btn.disabled = false;
        if (labelSpan)
            labelSpan.textContent = origLabel || '클로드로 실행';
        toast('태스크 내용을 불러오지 못했어요 — ' + e.message, true);
        return;
    }
    const first = pjvSel.items.get(ids[0]);
    const firstName = (first && (first.name || first.title)) || ('태스크 ' + ids[0]);
    const label = meName + ' · ' + firstName + (ids.length > 1 ? (' 외 ' + (ids.length - 1) + '건') : '');
    if (labelSpan)
        labelSpan.textContent = '세션 여는 중…';
    try {
        const r = await api(B + '/sessions', { method: 'POST', body: JSON.stringify({ label, harness: 'claude', autoApprove: true }) });
        const sid = r && r.session && r.session.id;
        if (!sid)
            throw new Error('세션 생성 실패');
        try {
            localStorage.setItem('lively:autosend:' + sid, prompt);
        }
        catch (_) { /* */ }
        window.open('/ui/terminal.html?session=' + encodeURIComponent(sid) + '&label=' + encodeURIComponent((r.session && r.session.label) || label) + '&autosend=1', '_blank');
        toast(ids.length + '개 태스크(본문·하위·첨부 포함)를 클로드에게 맡겼어요 — 새 탭에서 실행됩니다');
        pjvSelReset();
    }
    catch (e) {
        if (btn)
            btn.disabled = false;
        if (labelSpan)
            labelSpan.textContent = origLabel || '클로드로 실행';
        toast('실패 — ' + e.message, true);
    }
}
// ── 일괄 액션들 ──
function pjvBulkStatus(anchor) {
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(anchor, menu);
    for (const [key, label] of [['todo', '할 일'], ['in_progress', '진행 중'], ['done', '완료']]) {
        const m = pjvSel.kind === 'task' ? PJV_TASK_STATUS[key] : pjvProjStatusMeta(key);
        const item = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { class: 'pjv-status-dot sm ' + (m && m.cls || '') }, (m && m.glyph) ? el('span', { class: 'pjv-status-glyph', text: m.glyph }) : null), el('span', { text: label }));
        item.onclick = () => {
            close();
            if (pjvSel.kind === 'task')
                pjvBulkApply((id) => api('/api/ui/v6/tasks/' + id, { method: 'POST', body: JSON.stringify({ status: key }) }), '상태 변경됨');
            else
                pjvBulkApply((id) => api('/api/ui/v6/projects/' + id + '/status', { method: 'POST', body: JSON.stringify({ status: key }) }), '상태 변경됨');
        };
        menu.append(item);
    }
}
function pjvBulkDue(anchor) {
    const input = el('input', { type: 'date', class: 'pjv-date-input' });
    const clearBtn = el('button', { class: 'pjv-menu-item danger', type: 'button', text: '마감일 지우기' });
    const wrap = el('div', { class: 'pjv-menu pjv-date-pop' }, input, clearBtn);
    const close = pjvPopover(anchor, wrap);
    setTimeout(() => { input.focus(); if (input.showPicker) {
        try {
            input.showPicker();
        }
        catch (_) { /* noop */ }
    } }, 0);
    input.onchange = () => { const v = input.value || null; close(); pjvBulkApply((id) => api(pjvSelPatchUrl(id), { method: 'POST', body: JSON.stringify({ due_date: v }) }), '마감일 적용됨'); };
    clearBtn.onclick = () => { close(); pjvBulkApply((id) => api(pjvSelPatchUrl(id), { method: 'POST', body: JSON.stringify({ due_date: null }) }), '마감일 지움'); };
}
function pjvBulkPriority(anchor) {
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(anchor, menu);
    for (const key of PJV_PRIORITY_ORDER) {
        const pm = PJV_PRIORITY[key];
        const item = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { class: 'pjv-flag ' + pm.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' })), el('span', { text: pm.label }));
        item.onclick = () => { close(); pjvBulkApply((id) => api(pjvSelPatchUrl(id), { method: 'POST', body: JSON.stringify({ priority: key }) }), '우선순위 적용됨'); };
        menu.append(item);
    }
    const none = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
    none.onclick = () => { close(); pjvBulkApply((id) => api(pjvSelPatchUrl(id), { method: 'POST', body: JSON.stringify({ priority: null }) }), '우선순위 지움'); };
    menu.append(none);
}
async function pjvBulkAssignee(anchor) {
    const menu = el('div', { class: 'pjv-menu pjv-asg-menu' });
    const close = pjvPopover(anchor, menu);
    menu.append(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
    let members = [];
    try {
        if (pjvSel.kind === 'task' && pjvSel.ctx && (pjvSel.ctx.members || []).length) {
            members = pjvSel.ctx.members.map((m) => ({ id: m.member_id, name: m.display_name || m.member_id }));
        }
        else {
            members = ((await api('/api/ui/dash/members')) || []).map((m) => ({ id: m.id || m.member_id, name: m.display_name || m.name || m.id || m.member_id }));
        }
    }
    catch (_) { /* graceful */ }
    const picked = new Set();
    const render = () => {
        menu.replaceChildren(el('div', { class: 'pjv-menu-head', text: pjvSel.kind === 'task' ? '담당자 지정' : '팀원 지정' }));
        for (const m of members) {
            const on = picked.has(m.id);
            const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-ava', style: 'background:' + avatarColor(m.id), text: initials(m.name) }), el('span', { class: 'pjv-asg-mname', text: m.name }), el('span', { class: 'pjv-asg-check', text: on ? '✓' : '' }));
            item.onclick = (e) => { e.stopPropagation(); if (on)
                picked.delete(m.id);
            else
                picked.add(m.id); render(); };
            menu.append(item);
        }
        if (!members.length)
            menu.append(el('div', { class: 'pjv-menu-empty', text: '팀원이 없습니다' }));
        const apply = el('button', { class: 'pjv-menu-item pjv-bulk-apply', type: 'button' }, el('span', { text: '선택 ' + (pjvSel.kind === 'task' ? '담당자' : '팀원') + '로 지정 (' + picked.size + ')' }));
        apply.onclick = () => {
            close();
            const ids = [...picked];
            if (pjvSel.kind === 'task')
                pjvBulkApply((id) => api('/api/ui/v6/tasks/' + id, { method: 'POST', body: JSON.stringify({ assignee: pjvAssigneeWrite(ids) }) }), '담당자 적용됨');
            else
                pjvBulkApply((id) => pjvSaveProjMembers(id, ids), '팀원 적용됨');
        };
        const clear = el('button', { class: 'pjv-menu-item danger', type: 'button' }, el('span', { text: (pjvSel.kind === 'task' ? '담당자' : '팀원') + ' 비우기' }));
        clear.onclick = () => {
            close();
            if (pjvSel.kind === 'task')
                pjvBulkApply((id) => api('/api/ui/v6/tasks/' + id, { method: 'POST', body: JSON.stringify({ assignee: null }) }), '담당자 비움');
            else
                pjvBulkApply((id) => pjvSaveProjMembers(id, []), '팀원 비움');
        };
        menu.append(el('div', { class: 'pjv-bulk-sep-h' }), apply, clear);
    };
    render();
}
async function pjvBulkTags(anchor) {
    if (pjvSel.kind !== 'task')
        return;
    const menu = el('div', { class: 'pjv-menu pjv-rowtag-pop' });
    const close = pjvPopover(anchor, menu);
    menu.append(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
    let all = [];
    try {
        all = ((await api('/api/ui/v6/tags')) || {}).tags || [];
    }
    catch (_) { /* graceful */ }
    menu.replaceChildren(el('div', { class: 'pjv-menu-head', text: '선택 태스크에 태그 추가' }));
    for (const tg of all) {
        const item = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (tg.color || PJV_TAG_NONE) }), el('span', { text: tg.name }));
        item.onclick = () => { close(); pjvBulkApply((id) => api('/api/ui/v6/tasks/' + id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tg.id }) }), '태그 추가됨'); };
        menu.append(item);
    }
    if (!all.length)
        menu.append(el('div', { class: 'pjv-menu-empty', text: '태그가 없습니다 — 행에서 ＋ 로 먼저 만드세요' }));
}
function pjvBulkDuplicate() {
    if (pjvSel.kind === 'task') {
        const pid = pjvSel.ctx && pjvSel.ctx.projectId;
        if (!pid) {
            toast('복제 대상 프로젝트를 알 수 없습니다', true);
            return;
        }
        pjvBulkApply(async (id) => {
            const t = pjvSel.items.get(id);
            const name = (t.name || t.title || '태스크') + ' (사본)';
            const created = await api('/api/ui/v6/projects/' + pid + '/tasks', { method: 'POST', body: JSON.stringify({ name }) }).then((d) => d && d.task);
            if (created) {
                if (t.status && t.status !== 'todo')
                    await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify({ status: t.status }) }).catch(() => { });
                const patch = {};
                if (t.assignee)
                    patch.assignee = t.assignee;
                if (t.due_date)
                    patch.due_date = t.due_date;
                if (t.priority)
                    patch.priority = t.priority;
                if (Object.keys(patch).length)
                    await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify(patch) }).catch(() => { });
            }
        }, '복제됨');
    }
    else {
        pjvBulkApply(async (id) => {
            const p = pjvSel.items.get(id);
            await api('/api/ui/v6/projects', { method: 'POST', body: JSON.stringify({ name: (p.name || '프로젝트') + ' (사본)' }) });
        }, '복제됨');
    }
}
function pjvBulkDelete() {
    const n = pjvSel.ids.size;
    const what = pjvSel.kind === 'task' ? '태스크' : '프로젝트';
    if (!confirm(n + '개 ' + what + '를 삭제할까요?\n\n#/trash 에서 복원할 수 있습니다.'))
        return;
    if (pjvSel.kind === 'task')
        pjvBulkApply((id) => api('/api/ui/v6/tasks/' + id + '/delete', { method: 'POST', body: JSON.stringify({}) }), '삭제됨');
    else
        pjvBulkApply((id) => api('/api/ui/v6/projects/' + id + '/delete', { method: 'POST', body: JSON.stringify({}) }), '삭제됨');
}
// 일괄 '리스트로 이동'(프로젝트 전용) — 선택한 프로젝트들을 한 리스트(또는 미분류)로. 기존 49개 정리·대량 분류용.
async function pjvBulkList(anchor) {
    if (pjvSel.kind === 'task')
        return; // 태스크는 리스트 개념 없음(프로젝트 전용)
    const menu = el('div', { class: 'pjv-menu pjv-listmove-pop' });
    const close = pjvPopover(anchor, menu);
    const headEl = el('div', { class: 'pjv-menu-head', text: '선택 프로젝트를 폴더으로 이동' });
    menu.append(headEl, el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
    let lists = [];
    try {
        lists = ((await api('/api/ui/v6/project-lists')) || {}).lists || [];
    }
    catch (_) { /* graceful */ }
    menu.replaceChildren(headEl);
    const mkItem = (label, listId, color) => {
        const item = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { class: 'pjv-list-dot sm', style: 'background:' + (color || 'var(--line, #2a2a33)') }), el('span', { class: 'pjv-asg-mname', text: label }));
        item.onclick = () => { close(); pjvBulkApply((id) => api('/api/ui/v6/projects/' + id + '/list', { method: 'POST', body: JSON.stringify({ list_id: listId }) }), '폴더으로 이동됨'); };
        return item;
    };
    menu.append(mkItem('기타 (미분류)', null, null));
    for (const l of lists)
        menu.append(mkItem(l.name, l.id, l.color || avatarColor('list' + l.id)));
    if (!lists.length)
        menu.append(el('div', { class: 'pjv-menu-empty', text: '폴더이 없습니다 — 상단 ‘폴더’ 버튼을 켜면 왼쪽에서 ‘＋ 새 폴더’으로 만들 수 있어요' }));
}
// ── 다중선택 드래그/범위 (#366) — 좌측 체크박스를 눌러 아래로 쭉 끌면 지나온 행이 한 번에 선택된다.
//  · 드래그: 앵커(누른 체크박스)~현재 포인터 아래 행까지를 '칠한다'. 되돌아오면 범위가 줄어(칠하기 전 상태로 복원).
//  · Shift+클릭: 직전 클릭 앵커~현재까지를 선택.
//  체크박스는 같은 kind(프로젝트 XOR 태스크)끼리만 이어진다 — pjvSelToggle 이 kind 혼합을 막기 때문.
const pjvDrag = { active: false, kind: null, ctx: null, mode: false, anchorEl: null, moved: false, base: null, lastOver: null, suppressClick: false, _init: false };
// 현재 화면의 같은 kind 체크박스들을 DOM(=시각) 순서로. (자식 서브태스크 체크박스도 문서 순서에 자연히 포함)
function pjvDragChecks(kind) {
    return [...document.querySelectorAll('.pjv-row-check')].filter((c) => c._pjvKind === kind);
}
// 체크박스 하나를 특정 상태로 세팅(멱등) — pjvSel 상태 + .on + 행 하이라이트를 함께 맞춘다.
function pjvSetChecked(cb, on) {
    const kind = cb._pjvKind, item = cb._pjvItem, ctx = cb._pjvCtx;
    const cur = pjvSel.kind === kind && pjvSel.ids.has(item.id);
    if (cur !== on)
        pjvSelToggle(kind, item, ctx);
    cb.classList.toggle('on', on);
    const w = cb.closest('.pjv-trow-wrap');
    if (w)
        w.classList.toggle('pjv-row-selected', on);
}
// 앵커~overCb 범위를 mode 로 칠하고, 범위 밖은 드래그 시작 시점 상태(base)로 복원. 바 재렌더는 1회만.
function pjvDragPaint(overCb) {
    const list = pjvDragChecks(pjvDrag.kind);
    const ai = list.indexOf(pjvDrag.anchorEl);
    const ci = list.indexOf(overCb);
    if (ai < 0 || ci < 0)
        return;
    const lo = Math.min(ai, ci), hi = Math.max(ai, ci);
    pjvSelSilent = true;
    list.forEach((c, i) => {
        const inRange = i >= lo && i <= hi;
        pjvSetChecked(c, inRange ? pjvDrag.mode : !!(pjvDrag.base && pjvDrag.base.get(c)));
    });
    pjvSelSilent = false;
    pjvSelRenderBar();
}
function pjvDragInit() {
    if (pjvDrag._init)
        return;
    pjvDrag._init = true;
    document.addEventListener('pointerover', (e) => {
        if (!pjvDrag.active)
            return;
        if (e.buttons === 0) {
            pjvDragEnd(null);
            return;
        } // 창 밖에서 손을 뗀 경우 등 — 끊김 방지
        const wrap = e.target && e.target.closest && e.target.closest('.pjv-trow-wrap');
        if (!wrap)
            return;
        const cb = wrap.querySelector('.pjv-row-check'); // wrap 자신의 행 체크박스(문서상 첫 .pjv-row-check)
        if (!cb || cb._pjvKind !== pjvDrag.kind || cb === pjvDrag.lastOver)
            return;
        pjvDrag.lastOver = cb;
        if (cb !== pjvDrag.anchorEl)
            pjvDrag.moved = true;
        pjvDragPaint(cb);
    });
    document.addEventListener('pointerup', (e) => { if (pjvDrag.active)
        pjvDragEnd(e); });
}
function pjvDragEnd(e) {
    // 앵커 위에서 손을 뗐고 실제로 끌었다면, 뒤이어 오는 click 이 앵커를 되돌리지 않게 삼킨다.
    const endOnAnchor = !!(e && e.target && e.target.closest && e.target.closest('.pjv-row-check') === pjvDrag.anchorEl);
    pjvDrag.suppressClick = pjvDrag.moved && endOnAnchor;
    pjvDrag.active = false;
    pjvDrag.base = null;
    pjvDrag.lastOver = null;
    document.body.classList.remove('pjv-dragging');
}
// ── 행 호버 컨트롤 — 좌측 체크박스 + 우측 아이콘 그룹(추가·태그·이름변경) ──
function pjvRowCheck(kind, item, ctx) {
    pjvDragInit();
    const cb = el('button', { class: 'pjv-row-check', type: 'button', 'aria-label': '선택' });
    cb._pjvKind = kind;
    cb._pjvItem = item;
    cb._pjvCtx = ctx;
    if (pjvSel.kind === kind && pjvSel.ids.has(item.id))
        cb.classList.add('on');
    cb.addEventListener('pointerdown', (e) => {
        if (e.button !== 0)
            return; // 좌클릭만
        pjvDrag.active = true;
        pjvDrag.kind = kind;
        pjvDrag.ctx = ctx;
        pjvDrag.anchorEl = cb;
        pjvDrag.moved = false;
        pjvDrag.lastOver = null;
        pjvDrag.suppressClick = false;
        const anchorOn = pjvSel.kind === kind && pjvSel.ids.has(item.id);
        pjvDrag.mode = !anchorOn; // 앵커가 꺼져있었으면 드래그는 '선택', 켜져있었으면 '해제'
        pjvDrag.base = new Map();
        for (const c of pjvDragChecks(kind))
            pjvDrag.base.set(c, c.classList.contains('on'));
        document.body.classList.add('pjv-dragging'); // 드래그 중 텍스트 선택 방지
        e.preventDefault(); // 포커스/드래그 선택 억제(click 은 그대로 발생 → 단순 클릭 유지)
    });
    cb.onclick = (e) => {
        e.stopPropagation();
        if (pjvDrag.suppressClick) {
            pjvDrag.suppressClick = false;
            return;
        } // 드래그 뒤 따라온 click 무시
        // Shift+클릭 — 직전 앵커~현재까지 같은 kind 를 이어 선택.
        if (e.shiftKey && pjvSel.kind === kind && pjvSelLastEl && pjvSelLastEl._pjvKind === kind) {
            const list = pjvDragChecks(kind);
            const ai = list.indexOf(pjvSelLastEl), ci = list.indexOf(cb);
            if (ai >= 0 && ci >= 0) {
                const lo = Math.min(ai, ci), hi = Math.max(ai, ci);
                pjvSelSilent = true;
                for (let i = lo; i <= hi; i++)
                    pjvSetChecked(list[i], true);
                pjvSelSilent = false;
                pjvSelRenderBar();
                pjvSelLastEl = cb;
                return;
            }
        }
        const on = !(pjvSel.kind === kind && pjvSel.ids.has(item.id));
        pjvSetChecked(cb, on);
        pjvSelLastEl = cb;
    };
    return cb;
}
// ── 드래그 재정렬(#366) — 호버 시 체크박스 왼쪽 핸들(⠿)을 잡고 위/아래로 끌어 태스크 순서를 바꾼다.
//  · 여러 개 선택(pjvSel, kind='task')한 상태에서 핸들을 잡으면 선택분 전체가 'N개' 한 덩어리로 이동(클릭업 동형).
//  · 드래그 중: 커서를 따라다니는 고스트 + 놓일 자리에 가로 삽입선(marker). 같은 컨테이너의 형제 태스크 행끼리만.
//  · 끝나면 DOM 을 재배치하고 새 순서(sort)를 서버에 저장. 저장 API 미배포 환경에선 화면 순서만 바뀐다(새로고침 시 원복).
const pjvReorder = { active: false, wraps: [], container: null, ghost: null, marker: null, reload: null, _init: false };
// 컨테이너의 직계 태스크 행(형제)만 — 서브태스크(.pjv-trow-subs 안)는 각자의 컨테이너에서 다룬다.
function pjvReorderSibs(container) {
    return [...container.children].filter((c) => c.classList && c.classList.contains('pjv-trow-wrap') && c.hasAttribute('data-task-id'));
}
function pjvReorderStart(e, wrap, reload) {
    const container = wrap.parentElement;
    if (!container)
        return;
    const sibs = pjvReorderSibs(container);
    // 이 행이 다중선택(task)에 포함돼 있으면 선택분 전체(같은 컨테이너 것만), 아니면 이 행만 이동.
    const selIds = pjvSel.kind === 'task' ? pjvSel.ids : new Set();
    let moving = sibs.filter((w) => selIds.has(Number(w.getAttribute('data-task-id'))));
    if (!moving.length || moving.indexOf(wrap) < 0)
        moving = [wrap];
    pjvReorder.active = true;
    pjvReorder.container = container;
    pjvReorder.wraps = moving;
    pjvReorder.reload = reload;
    const label = moving.length > 1 ? (moving.length + '개 태스크') : (wrap.getAttribute('data-task-name') || '태스크');
    pjvReorder.ghost = el('div', { class: 'pjv-reorder-ghost', text: label });
    pjvReorder.marker = el('div', { class: 'pjv-reorder-marker', 'aria-hidden': 'true' });
    document.body.append(pjvReorder.ghost);
    moving.forEach((w) => w.classList.add('pjv-reorder-src'));
    document.body.classList.add('pjv-dragging');
    pjvReorderMove(e);
    e.preventDefault();
}
function pjvReorderMove(e) {
    if (!pjvReorder.active)
        return;
    if (e.buttons === 0) {
        pjvReorderEnd();
        return;
    } // 창 밖에서 손을 뗀 경우 등 — 끊김 방지
    const g = pjvReorder.ghost;
    if (g) {
        g.style.left = (e.clientX + 14) + 'px';
        g.style.top = (e.clientY + 12) + 'px';
    }
    const rest = pjvReorderSibs(pjvReorder.container).filter((w) => pjvReorder.wraps.indexOf(w) < 0);
    let before = null;
    for (const w of rest) {
        const r = w.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) {
            before = w;
            break;
        }
    }
    const m = pjvReorder.marker;
    if (before)
        pjvReorder.container.insertBefore(m, before);
    else
        pjvReorder.container.append(m);
}
function pjvReorderEnd() {
    if (!pjvReorder.active)
        return;
    pjvReorder.active = false;
    const { container, wraps, marker, ghost } = pjvReorder;
    document.body.classList.remove('pjv-dragging');
    if (ghost)
        ghost.remove();
    wraps.forEach((w) => w.classList.remove('pjv-reorder-src'));
    if (marker && marker.parentElement === container) {
        for (const w of wraps)
            container.insertBefore(w, marker);
    }
    if (marker)
        marker.remove();
    const ids = pjvReorderSibs(container).map((w) => Number(w.getAttribute('data-task-id')));
    const reload = pjvReorder.reload;
    pjvReorder.wraps = [];
    pjvReorder.container = null;
    pjvReorder.ghost = null;
    pjvReorder.marker = null;
    pjvReorder.reload = null;
    if (pjvSel.kind === 'task')
        pjvSelReset(); // 이동 후 선택 해제(자리 이동이 끝났으니)
    if (ids.length > 1) {
        api('/api/ui/v6/tasks-reorder', { method: 'POST', body: JSON.stringify({ ids }) })
            .then(() => toast('순서를 저장했습니다'))
            .catch(() => toast('순서를 화면에만 반영했어요 (저장 미지원 — 새로고침 시 원복)', true));
    }
}
function pjvReorderInit() {
    if (pjvReorder._init)
        return;
    pjvReorder._init = true;
    document.addEventListener('pointermove', pjvReorderMove);
    document.addEventListener('pointerup', pjvReorderEnd);
}
// 좌측 드래그 핸들(⠿) — 태스크 행 전용. ctx.reload 로 실패 시 원복 렌더.
function pjvRowGrip(_kind, _item, ctx) {
    pjvReorderInit();
    const g = el('button', { class: 'pjv-row-grip', type: 'button', tabindex: '-1', 'aria-label': '드래그해서 순서 바꾸기', title: '드래그해서 순서 바꾸기' }, '⠿');
    g.addEventListener('pointerdown', (e) => {
        if (e.button !== 0)
            return;
        e.stopPropagation();
        const wrap = g.closest('.pjv-trow-wrap');
        if (wrap)
            pjvReorderStart(e, wrap, ctx && ctx.reload);
    });
    g.onclick = (e) => { e.stopPropagation(); e.preventDefault(); }; // 핸들 클릭이 행 이동/네비로 새지 않게
    return g;
}
function pjvActIcon(kind) {
    const svg = (...k) => sv('svg', { class: 'pjv-act-ic', viewBox: '0 0 24 24', width: '15', height: '15', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ...k);
    if (kind === 'add')
        return svg(sv('path', { d: 'M12 5v14M5 12h14' }));
    if (kind === 'tag')
        return svg(sv('path', { d: 'M4 4h7l9 9-7 7-9-9z' }), sv('circle', { cx: '8.4', cy: '8.4', r: '1.3' }));
    if (kind === 'rename')
        return svg(sv('path', { d: 'M4 20h4L18 10l-4-4L4 16z' }), sv('path', { d: 'M13.5 6.5l4 4' }));
    return svg();
}
function pjvRowActions(specs) {
    const group = el('span', { class: 'pjv-row-actions' });
    for (const s of specs) {
        if (!s)
            continue;
        const b = el('button', { class: 'pjv-row-act', type: 'button', title: s.title }, pjvActIcon(s.icon));
        b.onclick = (e) => { e.stopPropagation(); s.fn(b); };
        group.append(b);
    }
    return group;
}
// 행 인라인 태그 편집 팝오버(태스크) — 토글 추가/제거 + 새 태그 만들기. 닫힐 때 행 칩 갱신(reload).
async function pjvTagPopover(anchor, t, reload) {
    const menu = el('div', { class: 'pjv-menu pjv-rowtag-pop' });
    const close = pjvPopover(anchor, menu);
    let changed = false;
    const obs = new MutationObserver(() => { if (!menu.isConnected) {
        obs.disconnect();
        if (changed && reload)
            reload();
    } });
    obs.observe(document.body, { childList: true, subtree: true });
    const draw = (all) => {
        const cur = new Set((t.tags || []).map((x) => x.id));
        menu.replaceChildren(el('div', { class: 'pjv-menu-head', text: '태그' }));
        for (const tg of all) {
            const on = cur.has(tg.id);
            const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (tg.color || PJV_TAG_NONE) }), el('span', { text: tg.name }), el('span', { class: 'pjv-asg-check', text: on ? '✓' : '' }));
            item.onclick = async (e) => {
                e.stopPropagation();
                try {
                    if (on) {
                        t.tags = (t.tags || []).filter((x) => x.id !== tg.id);
                        await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tg.id, remove: true }) });
                    }
                    else {
                        t.tags = [...(t.tags || []), tg];
                        await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tg.id }) });
                    }
                    changed = true;
                    draw(all);
                }
                catch (err) {
                    toast('태그 적용 실패 — ' + err.message, true);
                }
            };
            menu.append(item);
        }
        const inp = el('input', { type: 'text', class: 'pjv-rowtag-input', placeholder: '새 태그 이름 후 Enter', maxlength: '40' });
        inp.onkeydown = async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const name = inp.value.trim();
                if (!name)
                    return;
                try {
                    const tags = await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ name }) }).then((r) => (r && r.tags) || []);
                    t.tags = tags;
                    changed = true;
                    const all2 = ((await api('/api/ui/v6/tags')) || {}).tags || [];
                    draw(all2);
                }
                catch (err) {
                    toast('태그 생성 실패 — ' + err.message, true);
                }
            }
        };
        menu.append(el('div', { class: 'pjv-bulk-sep-h' }), inp);
    };
    menu.append(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
    let all = [];
    try {
        all = ((await api('/api/ui/v6/tags')) || {}).tags || [];
    }
    catch (_) { /* graceful */ }
    draw(all);
}
// 행(프로젝트/태스크/서브태스크) 태그 칩 — 보이는 칩(최대 2)에 호버 ×(제거). 클릭업식. row.id 로 /tasks/:id/tags 공유(프로젝트·태스크 동일).
//  비면 null 반환. 제거는 낙관적(즉시 칩 제거) + 백그라운드 POST(실패 시 reload 로 복구).
function pjvRowTagsEl(row, reload) {
    if (!(row.tags || []).length)
        return null;
    const wrap = el('span', { class: 'pjv-trow-tags' });
    const removeTag = async (tg) => {
        row.tags = (row.tags || []).filter((x) => x.id !== tg.id);
        repaint();
        try {
            await api('/api/ui/v6/tasks/' + row.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tg.id, remove: true }) });
        }
        catch (e) {
            toast('태그 제거 실패 — ' + e.message, true);
            if (reload)
                reload();
        }
    };
    function repaint() {
        wrap.replaceChildren();
        const cur = row.tags || [];
        for (const tg of cur.slice(0, 2)) {
            const x = el('button', { class: 'pjv-trow-tag-x', type: 'button', title: '태그 제거', text: '✕' });
            x.onclick = (e) => { e.stopPropagation(); removeTag(tg); };
            wrap.append(el('span', { class: 'pjv-trow-tag', style: '--tag:' + (tg.color || PJV_TAG_NONE), title: tg.name }, el('span', { class: 'pjv-trow-tag-name', text: tg.name }), x));
        }
        if (cur.length > 2)
            wrap.append(el('span', { class: 'pjv-trow-tag-more', text: '+' + (cur.length - 2) }));
    }
    repaint();
    return wrap;
}
function pjvProjRow(p, reload, select, canDelete, fields, anchorId, taskCtx) {
    fields = fields || [];
    const isDone = p.status === 'done';
    const selectable = !!select && canDelete(p);
    const wrap = el('div', { class: 'pjv-trow-wrap pjv-proj-wrap', 'data-proj-id': p.id });
    let lead;
    if (select) {
        if (selectable) {
            const cb = el('button', { class: 'pjv-proj-check', type: 'button', 'aria-label': '선택', 'aria-checked': 'false' });
            const apply = (on) => { cb.classList.toggle('on', on); cb.textContent = on ? '✓' : ''; cb.setAttribute('aria-checked', on ? 'true' : 'false'); };
            apply(select.ids.has(p.id));
            cb.onclick = (e) => {
                e.stopPropagation();
                const on = !select.ids.has(p.id);
                if (on)
                    select.ids.add(p.id);
                else
                    select.ids.delete(p.id);
                apply(on);
                select.onToggle();
            };
            lead = cb;
        }
        else {
            lead = el('span', { class: 'pjv-proj-check disabled', title: '내 프로젝트 아님', 'aria-hidden': 'true' });
        }
    }
    else {
        lead = pjvProjStatusDot(p, reload);
    }
    const title = el('span', { class: 'pjv-trow-title clickable' + (isDone ? ' done' : ''), title: p.name, text: p.name });
    title.onclick = (e) => {
        e.stopPropagation();
        if (select && selectable) {
            lead.click();
        }
        else {
            location.hash = '#/projects2/p/' + p.id;
        }
    };
    // 펼침 캐럿 — 태스크가 있는 프로젝트만(클릭 시 그 프로젝트의 태스크를 안에 펼침). 선택모드/모드없음/0개면 빈 캐럿.
    const nTasks = Number(p.task_count || 0);
    const canExpand = !select && !!taskCtx && nTasks > 0;
    const caret = canExpand
        ? el('button', { class: 'pjv-trow-caret', type: 'button', 'aria-expanded': 'false', text: '▸', title: nTasks + '개 태스크' })
        : el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' });
    // 프로젝트 태그 칩(클릭업식) — task_tag_link 를 project.id 로 사용. 칩 호버 시 × 로 제거(pjvRowTagsEl). 최대 2 + "+N".
    const ptagsEl = pjvRowTagsEl(p, reload);
    // 하위 태스크 아이콘(이름 옆 배지) — 클릭하면 캐럿과 동일하게 펼침/접힘(클릭업식). canExpand 일 때만 표시·클릭.
    const subcountEl = canExpand ? el('span', { class: 'pjv-trow-subcount pjv-subcount-ico clickable', role: 'button', tabindex: '0', title: nTasks + '개 태스크 — 클릭하여 펼치기' }, pjvSubtaskIcon(), el('span', { text: String(nTasks) })) : null;
    const titleCell = el('div', { class: 'pjv-trow-title-cell' }, select ? null : pjvRowCheck('project', p, { reload }), caret, lead, title, subcountEl, ptagsEl, select ? null : pjvRowActions([
        { title: '태스크 추가', icon: 'add', fn: () => pjvAddTask(p.id, null, reload) },
        { title: '태그 편집', icon: 'tag', fn: (b) => pjvTagPopover(b, p, reload) },
        { title: '이름 변경', icon: 'rename', fn: (b) => pjvProjRename(b, p, reload) },
    ]));
    // 제목 셀 전체(글자 + 여백)를 클릭 영역으로 — 태스크 목록처럼. 캐럿·체크박스·상태점·행 액션·제목(자체 핸들러)은 제외(각자 처리).
    titleCell.addEventListener('click', (e) => {
        if (e.target.closest('button, input, a, .pjv-trow-caret, .pjv-row-actions, .pjv-trow-title'))
            return;
        if (select && selectable) {
            lead.click();
        }
        else {
            location.hash = '#/projects2/p/' + p.id;
        }
    });
    const row = el('div', { class: 'pjv-trow pjv-proj-row' }, titleCell, el('div', { class: 'pjv-tcell' }, pjvProjTeamControl(p.members || [], (ids) => pjvSaveProjMembers(p.id, ids))), el('div', { class: 'pjv-tcell' }, pjvDueControl(p, (patch) => projPatch(p.id, patch, reload))), el('div', { class: 'pjv-tcell' }, pjvPriorityControl(p, (patch) => projPatch(p.id, patch, reload))), el('div', { class: 'pjv-tcell pjv-sess-cell' }, pjvProjSessionCell(p, reload)), ...(fields).map((f) => el('div', { class: 'pjv-tcell pjv-fcell' }, pjvFieldControl(p, f, reload))), el('div', { class: 'pjv-tcell pjv-tcell-add' }, pjvProjMore(p, reload, canDelete)));
    row.style.gridTemplateColumns = pjvProjGridTemplate(fields);
    wrap.append(row);
    // 하위(=이 프로젝트의 태스크) 펼침 영역 — 캐럿 클릭 시 lazy 로드, expanded 모드면 자동 펼침. 태스크 박스와 동일한 행/컨트롤.
    if (canExpand) {
        const subBox = el('div', { class: 'pjv-trow-subs pjv-proj-subs' });
        subBox.hidden = true;
        let loaded = false, open = false, loading = false;
        const localReload = () => { if (taskCtx.invalidate)
            taskCtx.invalidate(p.id); loaded = false; if (open)
            doLoad(); };
        const doLoad = async () => {
            if (loading)
                return;
            loading = true;
            subBox.replaceChildren(el('div', { class: 'pjv-proj-subnote', text: '태스크 불러오는 중…' }));
            try {
                const d = await taskCtx.fetchProjTasks(p.id);
                const tasks = (d && d.tasks) || [];
                subBox.replaceChildren();
                if (!tasks.length)
                    subBox.append(el('div', { class: 'pjv-proj-subnote', text: '태스크가 없습니다.' }));
                else
                    for (const t of tasks)
                        subBox.append(pjvProjTaskRow(p.id, t, d.members, localReload, 1, fields));
                loaded = true;
            }
            catch (e) {
                subBox.replaceChildren(el('div', { class: 'pjv-proj-subnote', text: '태스크를 불러오지 못했습니다 — ' + e.message }));
            }
            loading = false;
        };
        const setOpen = (o) => {
            open = o;
            caret.textContent = o ? '▾' : '▸';
            caret.setAttribute('aria-expanded', o ? 'true' : 'false');
            subBox.hidden = !o;
            if (o && !loaded)
                doLoad();
        };
        caret.onclick = (e) => { e.stopPropagation(); setOpen(!open); };
        if (subcountEl) {
            subcountEl.onclick = (e) => { e.stopPropagation(); setOpen(!open); };
            subcountEl.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                setOpen(!open);
            } };
        }
        if (taskCtx.mode === 'expanded')
            setOpen(true);
        wrap.append(subBox);
    }
    return wrap;
}
// 보드에서 프로젝트를 펼쳤을 때 그 안의 태스크 한 행 — 프로젝트 행과 '같은 그리드(pjvProjGridTemplate)'로 그려 컬럼 정렬 일치
//  (세션·커스텀필드 칼럼 자리는 빈 칸). 상태·담당자·마감·우선순위·이름변경·삭제·하위추가 모두 동작. 하위태스크는 캐럿으로 재귀 펼침.
function pjvProjTaskRow(projectId, t, members, reload, depth, boardFields) {
    depth = depth || 0;
    boardFields = boardFields || [];
    const subs = t.subtasks || [];
    const isDone = t.status === 'done';
    const wrap = el('div', { class: 'pjv-trow-wrap', 'data-task-id': t.id, 'data-task-name': t.name || t.title || '', 'data-task-level': t.level || 'task' });
    let open = false;
    const caret = subs.length
        ? el('button', { class: 'pjv-trow-caret', type: 'button', 'aria-expanded': 'false', text: '▸' })
        : el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' });
    const tagsEl = pjvRowTagsEl(t, reload);
    const subcountEl = subs.length ? el('span', { class: 'pjv-trow-subcount pjv-subcount-ico clickable', role: 'button', tabindex: '0', title: subs.length + '개 하위 — 클릭하여 펼치기' }, pjvSubtaskIcon(), el('span', { text: String(subs.length) })) : null;
    const titleCell = el('div', { class: 'pjv-trow-title-cell' }, pjvRowGrip('task', t, { reload }), // 좌측 드래그 핸들(#366) — 잡고 끌어 순서 변경
    pjvRowCheck('task', t, { reload, projectId, members }), // 프로젝트 행과 동일한 선택 체크박스(16px) — 정렬·다중선택 모두 동일하게
    caret, pjvStatusControl(t, reload), el('span', { class: 'pjv-trow-title' + (isDone ? ' done' : ''), text: t.name || t.title || '(제목 없음)' }), subcountEl, tagsEl);
    titleCell.style.paddingLeft = (depth * 22) + 'px';
    const subBox = el('div', { class: 'pjv-trow-subs' });
    subBox.hidden = true;
    if (subs.length && depth < 4) {
        for (const s of subs)
            subBox.append(pjvProjTaskRow(projectId, s, members, reload, depth + 1, boardFields));
        const toggle = () => { open = !open; caret.textContent = open ? '▾' : '▸'; caret.setAttribute('aria-expanded', open ? 'true' : 'false'); subBox.hidden = !open; };
        caret.onclick = toggle;
        if (subcountEl) {
            subcountEl.onclick = (e) => { e.stopPropagation(); toggle(); };
            subcountEl.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                toggle();
            } };
        }
    }
    // 하위 추가 가능 여부는 '레벨'로 판단(시각 indent용 depth 와 분리) — 프로젝트 직속 태스크(level=task)는 depth 1 로 그려도 하위 추가 가능.
    const isTopTask = t.level !== 'subtask';
    const onAddSub = isTopTask ? (() => pjvAddTask(projectId, t.id, reload)) : null;
    const moreBtn = pjvRowMore(projectId, t, isTopTask ? 0 : 1, reload, onAddSub);
    const rowEl = el('div', { class: 'pjv-trow pjv-proj-taskrow' }, titleCell, el('div', { class: 'pjv-tcell' }, pjvAssigneeControl(t, members, (pa) => pjvSaveTask(t.id, pa))), el('div', { class: 'pjv-tcell' }, pjvDueControl(t, (pa) => pjvPatchTask(t.id, pa, reload))), el('div', { class: 'pjv-tcell' }, pjvPriorityControl(t, (pa) => pjvPatchTask(t.id, pa, reload))), el('div', { class: 'pjv-tcell pjv-sess-cell' }), ...(boardFields).map(() => el('div', { class: 'pjv-tcell' })), el('div', { class: 'pjv-tcell pjv-tcell-add' }, moreBtn));
    rowEl.style.gridTemplateColumns = pjvProjGridTemplate(boardFields);
    wrap.append(rowEl);
    wrap.append(subBox);
    return wrap;
}
// 상태 그룹(진행 중/완료) — 헤더(점·라벨·개수·캐럿[, withCols 면 컬럼 라벨]) + 행들. 빈 그룹은 안내.
function pjvProjGroup(label, statusKey, list, reload, select, canDelete, withCols, fields, anchorId, meId, taskCtx, sepTasks, noAdd, listId) {
    fields = fields || [];
    sepTasks = sepTasks || [];
    const meta = pjvProjStatusMeta(statusKey);
    const body = el('div', { class: 'pjv-tgroup-body' });
    const countEl = el('span', { class: 'pjv-tgroup-count', text: String(list.length + sepTasks.length) });
    if (list.length) {
        for (const p of list)
            body.append(pjvProjRow(p, reload, select, canDelete, fields, anchorId, taskCtx));
    }
    else if (statusKey === 'done' && !sepTasks.length)
        body.append(el('div', { class: 'pjv-proj-empty', text: '완료한 프로젝트가 아직 없습니다.' }));
    // 분리(separate) 모드 — 각 프로젝트의 태스크를 상태 버킷에 평면 행으로(프로젝트 행과 같은 그리드). 프로젝트 행 아래, 추가행 위.
    for (const s of sepTasks)
        body.append(pjvProjTaskRow(s.projId, s.task, s.members, reload, 1, fields));
    // 클릭업식 인라인 추가행 — 각 그룹(완료 제외) 맨 아래. 빈 그룹에선 이 행이 '시작하기' CTA. 선택(일괄삭제) 모드에선 숨김.
    if (!select && statusKey !== 'done' && !noAdd)
        body.append(pjvProjAddRow(statusKey, reload, body, countEl, fields, select, canDelete, anchorId, meId, taskCtx, listId));
    let gopen = true;
    const gcaret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: '▾', 'aria-expanded': 'true' });
    gcaret.onclick = () => {
        gopen = !gopen;
        gcaret.textContent = gopen ? '▾' : '▸';
        gcaret.setAttribute('aria-expanded', gopen ? 'true' : 'false');
        body.hidden = !gopen;
    };
    const dot = el('span', { class: 'pjv-status-dot sm ' + meta.cls }, meta.glyph ? el('span', { class: 'pjv-status-glyph', text: meta.glyph }) : null);
    const labelEl = el('span', { class: 'pjv-tgroup-label', text: label });
    let head;
    if (withCols) {
        head = el('div', { class: 'pjv-tgroup-head pjv-tgroup-head-cols ' + meta.cls }, el('div', { class: 'pjv-trow-title-cell' }, el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }), dot, labelEl, countEl, gcaret), el('div', { class: 'pjv-tcell pjv-colhead', text: '팀원' }), el('div', { class: 'pjv-tcell pjv-colhead', text: '마감일' }), el('div', { class: 'pjv-tcell pjv-colhead', text: '우선순위' }), el('div', { class: 'pjv-tcell pjv-colhead', text: '내 세션' }), ...(fields).map((f) => pjvColumnHead(f, anchorId, reload)), el('div', { class: 'pjv-tcell pjv-tcell-add' }, anchorId ? pjvAddColumnButton(anchorId, reload) : el('span', {})));
        head.style.gridTemplateColumns = pjvProjGridTemplate(fields);
    }
    else {
        head = el('div', { class: 'pjv-tgroup-head ' + meta.cls }, dot, labelEl, countEl, gcaret);
    }
    return el('div', { class: 'pjv-tgroup' }, head, body);
}
// 프로젝트 인라인 추가행(클릭업식) — 태스크 add row 와 동형. 클릭→입력칸, Enter=생성(연속 추가 위해 입력 유지·낙관적 삽입), Esc/빈 blur=접기.
//  생성: POST /v6/projects {name} → 작성자=나(actor) 자동 → 내 보드 노출·삭제권한. '할 일' 그룹이면 생성 후 status=todo 패치(기본 생성은 active=진행 중).
//  담당자/마감/우선순위는 팀원이 아직 없어 행 생성 후 각 셀에서 지정(여기선 빈 칸으로 컬럼만 정렬). 모달 없이 그 자리에서.
function pjvProjAddRow(statusKey, reload, body, countEl, fields, select, canDelete, anchorId, meId, taskCtx, listId) {
    fields = fields || [];
    const row = el('div', { class: 'pjv-addrow' });
    const trigger = el('button', { class: 'pjv-addrow-trigger', type: 'button' }, el('span', { class: 'pjv-addrow-plus', text: '＋' }), el('span', { text: '프로젝트' }));
    const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '프로젝트 이름 입력 후 Enter (Esc 취소)', maxlength: '200', spellcheck: 'false', autocomplete: 'off' });
    // 생성 전 드래프트 — 팀원·마감·우선순위를 그 자리(인라인 셀)에서 지정해 생성 직후 한 번에 반영(태스크 추가행 pjvAddRow 와 동형).
    const draft = { memberIds: [], due_date: null, priority: null };
    const cTeam = el('div', { class: 'pjv-tcell' });
    const cDue = el('div', { class: 'pjv-tcell' });
    const cPriority = el('div', { class: 'pjv-tcell' });
    const setDraft = (p) => { Object.assign(draft, p); paintDateCells(); setTimeout(() => { if (row.classList.contains('editing'))
        input.focus(); }, 0); };
    // 마감·우선순위 셀만 draft 값을 반영해 다시 그린다. 팀원 셀은 자체 선택 상태를 들고 있으므로 여기서 재생성하지 않는다
    //  (마감일·우선순위를 고를 때 setDraft 가 팀원 셀까지 빈 상태로 다시 그려 선택이 사라지던 버그 방지 — expand 에서 한 번만 생성).
    function paintDateCells() {
        cDue.replaceChildren(pjvDueControl(draft, setDraft));
        cPriority.replaceChildren(pjvPriorityControl(draft, setDraft));
    }
    // 제목 칸 — 실제 프로젝트 행과 동일 구조(체크박스 자리 spacer + 캐럿 자리 + 그룹 상태 동그라미 + 입력)로 그려 픽셀 정렬 일치.
    //  프로젝트 행엔 호버 체크박스(16px)가 자리를 차지하므로, 추가행에도 동일 폭 spacer 를 둬 말머리(상태점) 가로 위치를 맞춘다.
    const buildTitleCell = () => {
        const meta = pjvProjStatusMeta(statusKey);
        return el('div', { class: 'pjv-trow-title-cell' }, el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }), el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' }), el('span', { class: 'pjv-status-dot ' + meta.cls, 'aria-hidden': 'true' }, meta.glyph ? el('span', { class: 'pjv-status-glyph', text: meta.glyph }) : null), input);
    };
    const collapse = () => { row.classList.remove('editing'); draft.memberIds = []; draft.due_date = draft.priority = null; row.replaceChildren(trigger); };
    const expand = () => {
        row.classList.add('editing');
        row.style.gridTemplateColumns = pjvProjGridTemplate(fields);
        // 팀원 셀은 자체 선택 상태를 들고 있어 expand 시 한 번만 생성(이후 마감/우선순위 변경에 재생성하지 않아 선택 유지).
        cTeam.replaceChildren(pjvProjTeamControl([], (ids) => { draft.memberIds = ids; }));
        paintDateCells();
        row.replaceChildren(buildTitleCell(), cTeam, cDue, cPriority, el('div', { class: 'pjv-tcell pjv-sess-cell' }), ...(fields).map(() => el('div', { class: 'pjv-tcell' })), el('div', { class: 'pjv-tcell pjv-tcell-add' }));
        input.focus();
    };
    trigger.onclick = expand;
    // Enter / 바깥클릭(blur) 모두 → 바로 생성하지 않고 '프로젝트 설정 팝업'을 띄운다(이름 + 그룹 상태 + 인라인 드래프트[팀원·마감·우선순위] 프리필).
    //  팝업 뜰 때 인라인 행은 접지 않고 입력을 유지(목록에서 이름이 사라지지 않게), 팝업이 닫히면(생성 후 이동 or 취소) 정리.
    let modalOpen = false;
    const openSettingsPopup = () => {
        if (modalOpen)
            return;
        const name = input.value.trim();
        if (!name) {
            collapse();
            return;
        }
        modalOpen = true; // blur 가 떠도(팝업으로 포커스 이동) 인라인 행 유지
        const back = openProjectV2Form(reload, {
            name, status: statusKey, listId,
            memberIds: draft.memberIds, due_date: draft.due_date, priority: draft.priority,
        });
        if (back && typeof MutationObserver !== 'undefined') {
            const obs = new MutationObserver(() => { if (!back.isConnected) {
                obs.disconnect();
                modalOpen = false;
                collapse();
            } });
            obs.observe(document.body, { childList: true });
        }
        else {
            modalOpen = false;
        }
    };
    // 바깥클릭 — 셀 팝오버(.pjv-pop, 드래프트 지정 중)거나 행 내부 포커스면 보류. 이름 있으면 설정 팝업, 없으면 접기.
    input.addEventListener('blur', () => {
        setTimeout(() => {
            if (modalOpen || !row.classList.contains('editing'))
                return;
            if (document.querySelector('.pjv-pop'))
                return;
            if (row.contains(document.activeElement))
                return;
            if (input.value.trim())
                openSettingsPopup();
            else
                collapse();
        }, 130);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            input.value = '';
            collapse();
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            openSettingsPopup();
        }
    });
    collapse();
    return row;
}
// 프로젝트 목록 카드 — 진행 중/할 일/완료 세 그룹을 한 카드(태스크 리스트와 동일 톤). 컬럼 라벨은 첫(맨 위) 그룹에만.
//  진행 중·할 일은 항상 표시, 완료(Closed)는 헤더의 Closed 토글(pjvProjClosedView.done) 시에만 노출 — 태스크 리스트 동형.
function pjvProjectListCard(todo, inprog, done, reload, select, canDelete, fields, anchorId, meId) {
    const card = el('div', { class: 'card pjv-tasks-card pjv-proj-card', style: 'margin-bottom:18px' });
    // 프로젝트별 태스크 캐시(펼침용) — 같은 보드 렌더 동안 재사용(모드 전환·재펼침 시 재요청 없음). 프로미스 캐싱으로 동시 요청 합침.
    const taskCache = new Map();
    const fetchProjTasks = (projId) => {
        if (taskCache.has(projId))
            return taskCache.get(projId);
        const pr = api('/api/ui/v6/projects/' + projId).then((d) => {
            const pj = (d && d.project) || d || {}; // 상세 응답은 { project: { …, tasks } } 로 래핑됨
            return { tasks: pj.tasks || [], members: pj.members || [], fields: pj.fields || [] };
        });
        taskCache.set(projId, pr);
        return pr;
    };
    const taskCtx = { mode: pjvProjTaskMode.mode, fetchProjTasks, invalidate: (id) => taskCache.delete(id) };
    // 헤더 — [프로젝트] [하위 태스크▾] ……… [Closed]. 태스크 박스 헤더와 동일 UI/동작(제목만 '프로젝트').
    const subtaskBtn = el('button', { class: 'pjv-subtask-btn', type: 'button', title: '태스크 표시 방식' }, pjvSubtaskIcon(), el('span', { class: 'pjv-subtask-btn-label', text: PJV_SUBTASK_BTNLABEL[pjvProjTaskMode.mode] }));
    const syncSub = () => {
        subtaskBtn.classList.toggle('active', pjvProjTaskMode.mode !== 'collapsed');
        const lbl = subtaskBtn.querySelector('.pjv-subtask-btn-label');
        if (lbl)
            lbl.textContent = PJV_SUBTASK_BTNLABEL[pjvProjTaskMode.mode];
    };
    const closedBtn = el('button', { class: 'pjv-closed-btn', type: 'button', title: '닫힌(완료) 프로젝트 표시' }, pjvCheckCircle(), el('span', { text: 'Closed' }));
    const syncClosed = () => closedBtn.classList.toggle('active', pjvProjClosedView.done);
    const body = el('div', { class: 'pjv-tasks-body' });
    const renderNested = () => {
        body.replaceChildren(pjvProjGroup('진행 중', 'in_progress', inprog, reload, select, canDelete, true, fields, anchorId, meId, taskCtx), pjvProjGroup('할 일', 'todo', todo, reload, select, canDelete, false, fields, anchorId, meId, taskCtx));
        if (pjvProjClosedView.done)
            body.append(pjvProjGroup('완료', 'done', done, reload, select, canDelete, false, fields, anchorId, meId, taskCtx));
    };
    // 분리(separate) — 모든 프로젝트의 태스크를 받아 상태 버킷으로 평면 표시(프로젝트 행과 함께). 캐시라 재진입 빠름.
    const renderSeparate = async () => {
        body.replaceChildren(el('div', { class: 'pjv-proj-subnote', text: '태스크 불러오는 중…' }));
        const all = [...inprog, ...todo, ...done].filter((p) => Number(p.task_count || 0) > 0);
        const details = await Promise.all(all.map((p) => fetchProjTasks(p.id).then((d) => ({ p, d })).catch(() => ({ p, d: { tasks: [], members: [] } }))));
        if (pjvProjTaskMode.mode !== 'separate')
            return; // 모드가 바뀌었으면 폐기(레이스 가드)
        const buckets = { in_progress: [], todo: [], done: [] };
        for (const { p, d } of details)
            for (const t of (d.tasks || [])) {
                const bk = pjvStatusMeta(t.status).bucket;
                (buckets[bk] || buckets.in_progress).push({ projId: p.id, task: t, members: d.members || [] });
            }
        body.replaceChildren(pjvProjGroup('진행 중', 'in_progress', inprog, reload, select, canDelete, true, fields, anchorId, meId, taskCtx, buckets.in_progress), pjvProjGroup('할 일', 'todo', todo, reload, select, canDelete, false, fields, anchorId, meId, taskCtx, buckets.todo));
        if (pjvProjClosedView.done)
            body.append(pjvProjGroup('완료', 'done', done, reload, select, canDelete, false, fields, anchorId, meId, taskCtx, buckets.done));
    };
    const render = () => {
        taskCtx.mode = pjvProjTaskMode.mode;
        if (pjvProjTaskMode.mode === 'separate') {
            renderSeparate();
            return;
        }
        renderNested();
    };
    subtaskBtn.onclick = (e) => { e.stopPropagation(); pjvProjTaskMenu(subtaskBtn, () => { syncSub(); render(); }); };
    closedBtn.onclick = (e) => { e.stopPropagation(); pjvProjClosedView.done = !pjvProjClosedView.done; syncClosed(); render(); };
    syncSub();
    syncClosed();
    card.append(el('div', { class: 'card-head' }, el('div', { class: 'pjv-tasks-head-left' }, el('h2', { text: '프로젝트' }), subtaskBtn), el('div', { class: 'card-head-actions' }, closedBtn)));
    card.append(body);
    render();
    return card;
}
// space 뷰(사업·제품·시스템) — 좌(카테고리 사이드바)/우(프로젝트 목록) 2분할. renderKnowledgeSpace 와 같은 패턴.
async function renderProjectV2Space(view, _space, params) {
    // 공간 병합(2026-06-26) — space 인자 무시(사이드바가 3 space 통합). 카테고리/상태만 상태로.
    const f = (state.projects2 = state.projects2 || { space: '', category: '', status: '' });
    if (params && params.has('category'))
        f.category = params.get('category') || '';
    if (params && params.has('status'))
        f.status = params.get('status') || '';
    view.replaceChildren(projectSubBar('browse'), skeleton('프로젝트를 불러오는 중'));
    const head = projectPageHead();
    // 좌측 카테고리 사이드바 — 3 space 통합(우리 팀 상단 펼침 ★ + space별 접이식). 지식 탭과 공유 빌더(buildSpacesNav).
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
    // 상단 필터 — 상태 select(전체/진행 중/완료).
    const statusSel = selectFilter([['', '전체 상태'], ['active', '진행 중'], ['done', '완료']], f.status);
    statusSel.setAttribute('aria-label', '상태');
    const listBox = el('div', { class: 'list-box browse-list' });
    const foot = el('div', { class: 'list-foot' });
    function syncHash() {
        const p = new URLSearchParams();
        if (f.category)
            p.set('category', f.category);
        if (f.status)
            p.set('status', f.status);
        const qs = p.toString();
        history.replaceState(null, '', '#/projects2/browse' + (qs ? '?' + qs : ''));
    }
    async function refetch() {
        listBox.replaceChildren(skeletonRows(4));
        foot.replaceChildren();
        try {
            const p = new URLSearchParams();
            if (f.category)
                p.set('category', f.category);
            if (f.status)
                p.set('status', f.status);
            const projects = await api('/api/ui/v6/projects?' + p.toString()).then((d) => (d && d.projects) || []);
            if (!projects.length) {
                listBox.replaceChildren(el('div', { class: 'empty', text: '조건에 맞는 프로젝트가 없습니다. 필터를 넓혀 보세요.' }));
            }
            else {
                listBox.replaceChildren(...projects.map(pjvProjectRow));
            }
            foot.replaceChildren(el('span', { class: 'caption', text: projects.length + '건' }));
        }
        catch (e) {
            listBox.replaceChildren(errorNote(e, '프로젝트를 불러오지 못했습니다'));
        }
    }
    statusSel.addEventListener('change', () => { f.status = statusSel.value; syncHash(); refetch(); });
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
    const filterBar = el('div', { class: 'filter-bar browse-filter' }, statusSel);
    const layout = el('div', { class: 'browse-layout' }, side, el('section', { class: 'browse-main' }, filterBar, listBox, foot));
    view.replaceChildren(head, projectSubBar('browse'), layout);
    applyReveal([layout]);
    refetch();
}
// 프로젝트 한 행(목록) — 이름(상세 링크) + 상태 칩 + 갱신시각. 지식 탭 knRow 와 같은 .row 짜임.
function pjvProjectRow(p) {
    const isDone = p.status === 'done';
    const when = isDone ? (p.completed_at || p.updated_at) : (p.updated_at || p.created_at);
    const row = el('div', { class: 'row', role: 'link', tabindex: '0' }, el('div', { class: 'row-title', text: p.name }), el('div', { class: 'row-meta' }, el('span', { class: 'pill-state' + (isDone ? '' : ' confirmed'), text: PJV_STATUS_LABEL[p.status] || p.status }), '  ', relTime(when)));
    const go = () => { location.hash = '#/projects2/p/' + p.id; };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter')
        go(); });
    return row;
}
// 새 프로젝트(v2) 폼 — 이름(필수)·설명(선택)·팀원. 생성 후 상세로 이동. memberPicker 재사용.
function openProjectV2Form(reload, prefill) {
    prefill = prefill || {};
    const nameIn = el('input', { type: 'text', value: prefill.name || '', placeholder: '프로젝트 이름 (예: 6월 데모데이 준비)', maxlength: '200' });
    const descIn = el('textarea', { rows: '3', placeholder: '간단한 설명 (선택)', maxlength: '5000' });
    const picker = memberPicker(prefill.memberIds || [], { includeMe: true });
    const catPicker = categoryPicker(prefill.categoryIds || []);
    const repoPick = repoPicker(prefill.repos || []);
    const listPick = listPicker(prefill.listId); // 분류(영역) — 한 목록/상태 뷰에서 만들 때도 여기서 정해 미분류 방지(#337)
    const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
    const back = overlayBox('새 프로젝트', el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn), el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '분류 (폴더)' }), listPick.box), el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '설명 (선택)' }), descIn), el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '카테고리 (선택)' }), catPicker.box), el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '관련 레포 (선택)' }), repoPick.box), el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '함께하는 팀원' }), picker.box), el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
    setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0); // 프리필된 이름 전체 선택 → 바로 수정/확정 가능
    const go = async () => {
        const name = nameIn.value.trim();
        if (!name) {
            nameIn.focus();
            toast('이름을 입력하세요', true);
            return;
        }
        // 분류(영역) — 영역이 있는데 미선택이면 막는다(미분류는 '기타(미분류)'를 명시적으로 골라야 함, #337).
        await listPick.ready;
        const listChoice = listPick.getSelected();
        if (!listChoice.ok) {
            toast('폴더을 선택하세요 — 미분류로 두려면 ‘기타(미분류)’를 고르세요', true);
            return;
        }
        saveBtn.disabled = true;
        try {
            const r = await api('/api/ui/v6/projects', { method: 'POST', body: JSON.stringify({
                    name, description: descIn.value.trim() || undefined, members: picker.getSelected(),
                }) });
            const np = r && (r.project || r);
            // 인라인 '할 일' 그룹에서 연 경우 그 상태로 생성(기본 생성은 active=진행 중) — prefill.status 로 전달.
            if (np && np.id && prefill.status === 'todo') {
                await api('/api/ui/v6/projects/' + np.id + '/status', { method: 'POST', body: JSON.stringify({ status: 'todo' }) }).catch(() => { });
            }
            // 인라인 추가행에서 지정해 둔 마감·우선순위 드래프트가 있으면 생성 직후 반영.
            if (np && np.id) {
                const patch = {};
                if (prefill.due_date)
                    patch.due_date = prefill.due_date;
                if (prefill.priority)
                    patch.priority = prefill.priority;
                if (Object.keys(patch).length)
                    await api('/api/ui/v6/projects/' + np.id, { method: 'POST', body: JSON.stringify(patch) }).catch(() => { });
            }
            // 선택한 카테고리(사업/제품/시스템)·관련 레포를 생성 직후 연결.
            const catIds = catPicker.getSelected();
            if (np && np.id && catIds.length)
                await api('/api/ui/v6/projects/' + np.id + '/categories', { method: 'POST', body: JSON.stringify({ category_ids: catIds }) }).catch(() => { });
            const repoNames = repoPick.getSelected();
            if (np && np.id && repoNames.length)
                await api('/api/ui/v6/projects/' + np.id + '/repos', { method: 'POST', body: JSON.stringify({ repos: repoNames }) }).catch(() => { });
            // 모달의 분류(영역) 선택대로 소속 지정 — '기타(미분류)'면 listId=null 이라 호출 생략(기본이 미분류).
            if (np && np.id && listChoice.listId != null)
                await api('/api/ui/v6/projects/' + np.id + '/list', { method: 'POST', body: JSON.stringify({ list_id: listChoice.listId }) }).catch(() => { });
            back.remove();
            toast('프로젝트를 만들었습니다');
            if (np && np.id)
                location.hash = '#/projects2/p/' + np.id;
            else if (reload)
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
    return back; // 호출측(인라인 추가행)이 팝업 닫힘을 감지해 인라인 행을 정리할 수 있게 오버레이 엘리먼트 반환
}
// 프로젝트 상세(v2) #/projects2/p/:id — 헤더(이름·상태 토글·팀원) + 태스크▸하위 트리 + 필요/산출 지식.
//  renderProjectDetail 의 헤더 결을 따르되, 본문은 태스크 계층 + 지식 두 섹션(GET /api/ui/v6/projects/:id).
// ── 프로젝트 클릭업식 메타데이터 패널 (상세 헤더, 이름 아래) — 태스크 모달의 pjv-tm-fields 동형 ──
//  상태·담당자·기간·우선순위는 /api/ui/v6/projects/:id(updateProject) 로, 태그·시간추적은 /tasks/:id/(tags|time) 를
//  프로젝트 id 로 호출(같은 task_tag_link/task_time_entry 테이블, 레벨 제약 없음). getProject 가 p.tags·p.time 부여.
function pjvFmtClock2(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? (h + 'h ' + m + 'm') : (m ? (m + 'm ' + s + 's') : (s + 's'));
}
function pjvProjStatusPill(p, reload) {
    const meta = pjvProjStatusMeta(p.status);
    const btn = el('button', { class: 'pjv-tm-statuspill ' + meta.cls, type: 'button' }, meta.glyph ? el('span', { class: 'pjv-status-glyph', text: meta.glyph }) : null, el('span', { text: meta.label }));
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu' });
        const close = pjvPopover(btn, menu);
        for (const st of ['todo', 'in_progress', 'done']) {
            const m = pjvProjStatusMeta(st);
            const cur = pjvProjStatusMeta(p.status).key === st;
            const item = el('button', { class: 'pjv-menu-item' + (cur ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-status-dot sm ' + m.cls }, m.glyph ? el('span', { class: 'pjv-status-glyph', text: m.glyph }) : null), el('span', { text: m.label }));
            item.onclick = () => { close(); if (!cur)
                pjvSetProjStatus(p.id, st, reload); };
            menu.append(item);
        }
    };
    return btn;
}
function pjvProjDatesField(p, reload) {
    const wrap = el('div', { class: 'pjv-tm-dates' });
    const mk = (field, ph) => {
        const val = p[field];
        const overdue = field === 'due_date' && pjvIsOverdue(p);
        const b = el('button', { class: 'pjv-tm-datebtn' + (val ? '' : ' empty') + (overdue ? ' overdue' : ''), type: 'button' }, el('span', { text: val ? pjvFmtDate(val) : ph }));
        b.onclick = (e) => {
            e.stopPropagation();
            const input = el('input', { type: 'date', class: 'pjv-date-input', value: val || '' });
            const wrapPop = el('div', { class: 'pjv-menu pjv-date-pop' }, input, val ? el('button', { class: 'pjv-menu-item danger', type: 'button', text: '지우기',
                onclick: () => { close(); projPatch(p.id, { [field]: null }, reload); } }) : null);
            const close = pjvPopover(b, wrapPop);
            setTimeout(() => { input.focus(); if (input.showPicker) {
                try {
                    input.showPicker();
                }
                catch (_) { /* noop */ }
            } }, 0);
            input.onchange = () => { const v = input.value || null; close(); projPatch(p.id, { [field]: v }, reload); };
        };
        return b;
    };
    wrap.append(mk('start_date', 'Start'), el('span', { class: 'pjv-tm-datearrow', text: '→' }), mk('due_date', 'Due'));
    return wrap;
}
function pjvProjTimeField(p, reload) {
    const time = p.time || { entries: [], total_seconds: 0, running: null };
    const wrap = el('div', { class: 'pjv-tm-time' });
    const running = time.running;
    const playBtn = el('button', { class: 'pjv-tm-timebtn' + (running ? ' on' : ''), type: 'button',
        title: running ? '타이머 정지' : '타이머 시작' }, el('span', { text: running ? '⏸' : '▶' }), el('span', { text: running ? '정지' : 'Start' }));
    playBtn.onclick = async () => {
        playBtn.disabled = true;
        try {
            await api('/api/ui/v6/tasks/' + p.id + '/time', { method: 'POST', body: JSON.stringify({ action: running ? 'stop' : 'start' }) });
            pjvReloadKeepScroll(reload);
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            playBtn.disabled = false;
        }
    };
    wrap.append(playBtn);
    if (time.total_seconds > 0 || running)
        wrap.append(el('span', { class: 'pjv-tm-timer-live', text: pjvFmtClock2(time.total_seconds || 0) }));
    return wrap;
}
// 태그 팝오버 헬퍼 — 태스크 모달과 동일한 아이콘/색 팔레트(프로젝트도 같은 /tags 엔드포인트·CSS 공유).
const PJV_TAG_PALETTE = ['#8b7fd6', '#6b8fff', '#4aa3e0', '#2bb3a3', '#56b877', '#e0b341', '#e8853a', '#e98aa8', '#d96bb0', '#b07fd6', '#a98e7d', '#cfd6e0', '#98a3b5'];
function pjvTagGearIcon() {
    const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 12, r: 3 }));
    n.append(sv('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }));
    return n;
}
function pjvTagTrashIcon() {
    const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('polyline', { points: '4 7 20 7' }), sv('path', { d: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' }), sv('path', { d: 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12' }));
    return n;
}
function pjvTagNoneIcon() {
    const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 12, r: 8 }), sv('line', { x1: 6.4, y1: 6.4, x2: 17.6, y2: 17.6 }));
    return n;
}
function pjvTagBackIcon() {
    const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('polyline', { points: '14 6 8 12 14 18' }));
    return n;
}
// 프로젝트 태그 — 태스크 모달과 동일한 클릭업식 팝오버(선택칩 + 검색/생성 + 토글 + 행별 ⚙ + '모든 태그 관리').
//  프로젝트도 task_tag_link 를 p.id 로 공유 → 엔드포인트(/tasks/:id/tags · /tags/:id)·CSS 모두 태스크와 동일.
function pjvProjTagsField(p, reload) {
    const wrap = el('div', { class: 'pjv-tm-tags' });
    const save = async (body) => {
        try {
            const d = await api('/api/ui/v6/tasks/' + p.id + '/tags', { method: 'POST', body: JSON.stringify(body) });
            p.tags = d.tags || [];
            return true;
        }
        catch (e) {
            toast('태그 저장 실패 — ' + e.message, true);
            return false;
        }
    };
    const tagChip = (tg, onRemove) => {
        const chip = el('span', { class: 'pjv-tm-tag', style: '--tag:' + (tg.color || PJV_TAG_NONE) }, el('span', { class: 'pjv-tm-tag-name', text: tg.name }));
        if (onRemove) {
            const x = el('button', { class: 'pjv-tm-tag-x', type: 'button', title: '제거', text: '✕' });
            x.onclick = (e) => { e.stopPropagation(); onRemove(); };
            chip.append(x);
        }
        return chip;
    };
    const render = () => {
        wrap.replaceChildren();
        for (const tg of (p.tags || []))
            wrap.append(tagChip(tg, async () => { if (await save({ tag_id: tg.id, remove: true }))
                render(); }));
        const add = el('button', { class: 'pjv-tm-valbtn' + ((p.tags || []).length ? '' : ' empty'), type: 'button', text: (p.tags || []).length ? '＋' : 'Empty' });
        add.onclick = (e) => { e.stopPropagation(); openPop(add); };
        wrap.append(add);
    };
    async function openPop(anchor) {
        const pop = el('div', { class: 'pjv-menu pjv-tm-tagpop' });
        pjvPopover(anchor, pop);
        let all = [];
        const loadAll = async () => { try {
            all = await api('/api/ui/v6/tags').then((r) => (r && r.tags) || []);
        }
        catch (_) {
            all = [];
        } };
        const selIds = () => new Set((p.tags || []).map((x) => x.id));
        await loadAll();
        function showList(query) {
            const input = el('input', { type: 'text', class: 'pjv-tm-taginput', placeholder: '태그 검색…', maxlength: '40', value: query || '' });
            const chips = el('div', { class: 'pjv-tm-tagpop-chips' });
            const list = el('div', { class: 'pjv-tm-tagresults' });
            const manageBtn = el('button', { class: 'pjv-tm-tagmanage-btn', type: 'button' }, pjvTagGearIcon(), el('span', { text: '모든 태그 관리' }));
            manageBtn.onclick = () => showManageAll();
            pop.replaceChildren(el('div', { class: 'pjv-tm-tagpop-top' }, chips, input), el('div', { class: 'pjv-tm-tagpop-head' }, el('span', { text: 'Select an option' })), list, manageBtn);
            setTimeout(() => { input.focus(); }, 0);
            const renderChips = () => chips.replaceChildren(...(p.tags || []).map((tag) => tagChip(tag, () => persistRemove(tag.id))));
            const persistAdd = async (x) => { if (await save({ tag_id: x.id })) {
                render();
                renderChips();
                renderList();
            } };
            const persistRemove = async (tagId) => { if (await save({ tag_id: tagId, remove: true })) {
                render();
                renderChips();
                renderList();
            } };
            const renderList = () => {
                const qq = input.value.trim();
                const have = selIds();
                const cand = all.filter((x) => (!qq || x.name.toLowerCase().includes(qq.toLowerCase())));
                list.replaceChildren();
                for (const x of cand.slice(0, 40)) {
                    const on = have.has(x.id);
                    const row = el('button', { class: 'pjv-tm-tagrow' + (on ? ' sel' : ''), type: 'button' }, pjvCheckMini(on), el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (x.color || PJV_TAG_NONE) }), el('span', { class: 'pjv-tm-tagrow-name', text: x.name }));
                    row.onclick = () => (on ? persistRemove(x.id) : persistAdd(x));
                    const gear = el('button', { class: 'pjv-tm-tagrow-gear', type: 'button', title: '태그 편집' }, pjvTagGearIcon());
                    gear.onclick = (e) => { e.stopPropagation(); showColor(x, input.value); };
                    row.append(gear);
                    list.append(row);
                }
                // 새 태그 생성은 '모든 태그 관리'에서만 — 검색창은 검색·토글 전용(Create 행 없음).
                if (!list.children.length)
                    list.append(el('div', { class: 'pjv-menu-empty', text: qq ? '검색 결과가 없습니다 — 새 태그는 아래 ‘모든 태그 관리’에서 만드세요.' : '태그가 없습니다 — ‘모든 태그 관리’에서 만드세요.' }));
            };
            input.addEventListener('input', renderList);
            input.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter')
                    return;
                const v = input.value.trim();
                if (!v)
                    return;
                const exact = all.find((x) => x.name.toLowerCase() === v.toLowerCase());
                if (exact && !selIds().has(exact.id)) {
                    persistAdd(exact);
                    input.value = '';
                    renderList();
                }
                // 일치하는 기존 태그만 추가 — 새 태그 생성은 '모든 태그 관리'에서만.
            });
            renderChips();
            renderList();
        }
        function showColor(tag, backQuery, onBack) {
            const goBack = onBack || (() => showList(backQuery));
            const back = el('button', { class: 'pjv-tm-tagcolor-back', type: 'button', title: '뒤로' }, pjvTagBackIcon());
            back.onclick = goBack;
            const nameIn = el('input', { type: 'text', class: 'pjv-tm-tagcolor-name', value: tag.name, maxlength: '40' });
            const grid = el('div', { class: 'pjv-tm-tagcolor-grid' });
            const syncLocal = () => {
                all = all.map((a) => (a.id === tag.id ? { ...a, name: tag.name, color: tag.color } : a));
                p.tags = (p.tags || []).map((x) => (x.id === tag.id ? { ...x, name: tag.name, color: tag.color } : x));
            };
            const renderGrid = () => {
                grid.replaceChildren();
                for (const c of PJV_TAG_PALETTE) {
                    const sw = el('button', { class: 'pjv-tm-swatch' + (tag.color === c ? ' sel' : ''), type: 'button', style: 'background:' + c + ';color:' + c, 'aria-label': '색상' });
                    sw.onclick = () => applyColor(c);
                    grid.append(sw);
                }
                const none = el('button', { class: 'pjv-tm-swatch none' + (!tag.color ? ' sel' : ''), type: 'button', title: '색 없음' }, pjvTagNoneIcon());
                none.onclick = () => applyColor(null);
                grid.append(none);
            };
            const applyColor = async (c) => {
                tag.color = c;
                renderGrid();
                syncLocal();
                render();
                try {
                    await api('/api/ui/v6/tags/' + tag.id, { method: 'POST', body: JSON.stringify({ color: c }) });
                }
                catch (e) {
                    toast('실패 — ' + e.message, true);
                }
            };
            const rename = async () => {
                const v = nameIn.value.trim();
                if (!v || v === tag.name)
                    return;
                try {
                    const r = await api('/api/ui/v6/tags/' + tag.id, { method: 'POST', body: JSON.stringify({ name: v }) }).then((x) => x.tag);
                    tag.name = r.name;
                    syncLocal();
                    render();
                }
                catch (e) {
                    toast('이름 변경 실패 — ' + e.message, true);
                    nameIn.value = tag.name;
                }
            };
            const del = el('button', { class: 'pjv-tm-tagdelete', type: 'button' }, pjvTagTrashIcon(), el('span', { text: 'Delete' }));
            del.onclick = async () => {
                if (!confirm("'" + tag.name + "' 태그를 삭제할까요?\n모든 항목에서 제거됩니다."))
                    return;
                try {
                    await api('/api/ui/v6/tags/' + tag.id + '/delete', { method: 'POST', body: JSON.stringify({}) });
                    p.tags = (p.tags || []).filter((x) => x.id !== tag.id);
                    await loadAll();
                    render();
                    goBack();
                }
                catch (e) {
                    toast('삭제 실패 — ' + e.message, true);
                }
            };
            nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
                e.preventDefault();
                rename();
            } });
            nameIn.addEventListener('blur', rename);
            pop.replaceChildren(el('div', { class: 'pjv-tm-tagcolor-top' }, back, nameIn), grid, el('div', { class: 'pjv-tm-tagcolor-sep' }), del);
            renderGrid();
            setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
        }
        function showManageAll() {
            const back = el('button', { class: 'pjv-tm-tagcolor-back', type: 'button', title: '뒤로' }, pjvTagBackIcon());
            back.onclick = () => showList('');
            const list = el('div', { class: 'pjv-tm-tagresults' });
            // 새 태그 생성은 여기('모든 태그 관리')에서만. 정의만 만들고 이 프로젝트엔 적용하지 않는다(생성 직후 링크 해제).
            const createIn = el('input', { type: 'text', class: 'pjv-tm-taginput', placeholder: '＋ 새 태그 이름 입력 후 Enter', maxlength: '40' });
            const doCreate = async () => {
                const v = createIn.value.trim();
                if (!v)
                    return;
                if (all.some((x) => x.name.toLowerCase() === v.toLowerCase())) {
                    toast('이미 있는 태그입니다', true);
                    return;
                }
                createIn.disabled = true;
                const color = PJV_TAG_PALETTE[all.length % PJV_TAG_PALETTE.length];
                if (await save({ name: v, color })) {
                    const created = (p.tags || []).find((x) => x.name.toLowerCase() === v.toLowerCase());
                    if (created)
                        await save({ tag_id: created.id, remove: true }); // 정의만 — 현재 프로젝트엔 미적용
                    await loadAll();
                    render();
                    showManageAll();
                }
                else {
                    createIn.disabled = false;
                }
            };
            createIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
                e.preventDefault();
                doCreate();
            } });
            pop.replaceChildren(el('div', { class: 'pjv-tm-tagcolor-top' }, back, el('div', { class: 'pjv-tm-tagmanage-title', text: '모든 태그 관리' })), el('div', { class: 'pjv-tm-tagpop-top' }, createIn), el('div', { class: 'pjv-tm-tagpop-head' }, el('span', { text: all.length + '개 · 클릭해 이름·색상·삭제 (모든 항목 반영)' })), list);
            setTimeout(() => createIn.focus(), 0);
            if (!all.length) {
                list.append(el('div', { class: 'pjv-menu-empty', text: '아직 태그가 없습니다 — 위 칸에서 만들어보세요.' }));
                return;
            }
            for (const x of all) {
                const row = el('button', { class: 'pjv-tm-tagrow', type: 'button' }, el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (x.color || PJV_TAG_NONE) }), el('span', { class: 'pjv-tm-tagrow-name', text: x.name }), el('span', { class: 'pjv-tm-tagrow-gear' }, pjvTagGearIcon()));
                row.onclick = () => showColor(x, '', showManageAll);
                list.append(row);
            }
        }
        showList('');
    }
    render();
    return wrap;
}
// 패널 — 좌(상태·기간·시간추적) 우(담당자·우선순위·태그) 2열, 태스크 모달과 동일 결.
// 상세 '리스트' 필드 — 소속 리스트(색점+이름, 미분류면 안내) 표시 + 클릭해 변경(리스트 선택/미분류). getProject 가 p.list 부여.
function pjvProjListField(p, reload) {
    const cur = p.list || null; // { id, name, color } | null
    const btn = el('button', { class: 'pjv-cell-btn' + (cur ? '' : ' empty'), type: 'button', title: '소속 폴더' });
    const paint = () => {
        if (cur)
            btn.replaceChildren(el('span', { class: 'pjv-list-dot sm', style: 'background:' + (cur.color || avatarColor('list' + cur.id)) }), el('span', { class: 'pjv-asg-mname', text: cur.name }));
        else
            btn.replaceChildren(el('span', { class: 'pjv-cell-ph', text: '미분류 — 폴더 지정' }));
    };
    paint();
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu pjv-listmove-pop' });
        const close = pjvPopover(btn, menu);
        const headEl = el('div', { class: 'pjv-menu-head', text: '폴더' });
        menu.append(headEl, el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
        api('/api/ui/v6/project-lists').then((d) => {
            const lists = (d && d.lists) || [];
            menu.replaceChildren(headEl);
            const mkItem = (label, listId, color) => {
                const isCur = (p.list_id == null ? listId == null : String(p.list_id) === String(listId));
                const item = el('button', { class: 'pjv-menu-item' + (isCur ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-list-dot sm', style: 'background:' + (color || 'var(--line, #2a2a33)') }), el('span', { class: 'pjv-asg-mname', text: label }), el('span', { class: 'pjv-asg-check', text: isCur ? '✓' : '' }));
                item.onclick = async (ev) => {
                    ev.stopPropagation();
                    close();
                    if (isCur)
                        return;
                    try {
                        await api('/api/ui/v6/projects/' + p.id + '/list', { method: 'POST', body: JSON.stringify({ list_id: listId }) });
                        toast(listId == null ? '미분류로 옮겼습니다' : '폴더으로 옮겼습니다');
                        if (reload)
                            reload();
                    }
                    catch (err) {
                        toast('이동 실패 — ' + err.message, true);
                    }
                };
                return item;
            };
            menu.append(mkItem('기타 (미분류)', null, null));
            for (const l of lists)
                menu.append(mkItem(l.name, l.id, l.color || avatarColor('list' + l.id)));
            const addNew = el('button', { class: 'pjv-menu-item pjv-sess-add', type: 'button' }, el('span', { class: 'pjv-sess-add-ico', text: '＋' }), el('span', { text: '새 폴더…' }));
            addNew.onclick = (ev) => { ev.stopPropagation(); close(); openListForm(reload); };
            menu.append(el('div', { class: 'pjv-bulk-sep-h' }), addNew);
        }).catch((err) => menu.replaceChildren(headEl, el('div', { class: 'pjv-menu-empty', text: '폴더을 불러오지 못했어요 — ' + err.message })));
    };
    return btn;
}
function pjvProjMetaPanel(p, members, reload) {
    const row = (glyph, label, control) => el('div', { class: 'pjv-tm-field' }, el('span', { class: 'pjv-tm-field-ico', 'aria-hidden': 'true', text: glyph }), el('span', { class: 'pjv-tm-field-label', text: label }), el('div', { class: 'pjv-tm-field-val' }, control));
    // 선행/후속 프로젝트 — 프로퍼티 '첫 줄'(좌=선행, 우=후속). #340 의 별도 박스를 프로퍼티로 이관(#359) 후,
    //  사용자 요청으로 맨 위 첫 줄로 이동. 예전엔 풀폭 래퍼(pjv-proj-meta-edges, align-items:start)로 감쌌는데
    //  그 override 때문에 라벨 세로선이 다른 행과 어긋나 보였음 → 일반 row 로 통일(부모 2열 그리드에 그대로
    //  흘러 상태·폴더 등과 아이콘/라벨/값 세로선이 정확히 정렬됨).
    return el('div', { class: 'pjv-tm-fields pjv-proj-meta' }, row('←', '선행 프로젝트', pjvProjEdgesField(p, reload, 'out')), row('→', '후속 프로젝트', pjvProjEdgesField(p, reload, 'in')), row('◎', '상태', pjvProjStatusPill(p, reload)), 
    // 소속 리스트(클릭업 List) — 클릭해 변경. 미분류면 '리스트 지정' 안내.
    row('🗂', '폴더', pjvProjListField(p, reload)), 
    // 팀원 = 담당자 — 클릭하면 팀원 목록만 보여주는 보기전용 팝오버(토글 없음). 변경은 '프로젝트 세부 설정'에서만.
    row('👤', '팀원', pjvProjTeamView(members)), row('🗓', '기간', pjvProjDatesField(p, reload)), row('⚑', '우선순위', pjvPriorityControl(p, (patch) => projPatch(p.id, patch, reload))), row('⏱', '시간 추적', pjvProjTimeField(p, reload)), row('🏷', '태그', pjvProjTagsField(p, reload)));
}
// 선행/후속 프로젝트 필드(프로퍼티) — dir='out'=선행(이 프로젝트가 뒤따르는 앞 프로젝트, edges.outgoing),
//  dir='in'=후속(이 프로젝트를 뒤따르는 뒤 프로젝트, edges.incoming). 칩(상세 링크 + ✕ 해제) + ＋로 검색·추가.
//  방향 의미(#340): from --follow_up--> to = from 이 to 의 후속. 선행 추가=this→pick, 후속 추가=pick→this.
function pjvProjEdgesField(p, reload, dir) {
    const edges = p.edges || { outgoing: [], incoming: [] };
    const list = (dir === 'out' ? edges.outgoing : edges.incoming) || [];
    const wrap = el('div', { class: 'pjv-proj-edges' });
    for (const e of list) {
        const chip = el('span', { class: 'pjv-edge-chip' }, el('a', { class: 'pjv-edge-chip-link', href: '#/projects2/p/' + e.project_id,
            title: '#' + e.project_id + ' ' + (e.project_name || ''), text: e.project_name || ('#' + e.project_id) }));
        const x = el('button', { class: 'pjv-edge-chip-x', type: 'button', title: '관계 해제', text: '✕' });
        x.onclick = async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const fromId = dir === 'out' ? p.id : e.project_id;
            const toId = dir === 'out' ? e.project_id : p.id;
            try {
                await api('/api/ui/v6/projects/' + fromId + '/link', { method: 'POST', body: JSON.stringify({ to: toId, relation: e.relation || 'follow_up', unlink: true }) });
                toast('관계를 해제했습니다');
                pjvReloadKeepScroll(reload);
            }
            catch (err) {
                toast('해제 실패 — ' + err.message, true);
            }
        };
        chip.append(x);
        wrap.append(chip);
    }
    const addBtn = el('button', { class: 'pjv-edge-add' + (list.length ? '' : ' empty'), type: 'button',
        title: dir === 'out' ? '선행 프로젝트 추가' : '후속 프로젝트 추가',
        text: list.length ? '＋' : ('＋ ' + (dir === 'out' ? '선행' : '후속')) });
    addBtn.onclick = (e) => { e.stopPropagation(); pjvProjEdgePicker(addBtn, p, dir, reload); };
    wrap.append(addBtn);
    return wrap;
}
// 선행/후속 추가 팝오버 — 프로젝트 검색(이름/번호) → 선택 시 엣지 연결. 이미 연결된 것·자기 자신 제외.
function pjvProjEdgePicker(anchor, p, dir, reload) {
    const edges = p.edges || { outgoing: [], incoming: [] };
    const existing = new Set([...(edges.outgoing || []).map((e) => e.project_id), ...(edges.incoming || []).map((e) => e.project_id), p.id]);
    const menu = el('div', { class: 'pjv-menu pjv-edge-pick' });
    const search = el('input', { type: 'search', class: 'pjv-edge-pick-search', placeholder: '프로젝트 검색(이름/번호)' });
    const results = el('div', { class: 'pjv-edge-pick-results' });
    menu.append(el('div', { class: 'pjv-edge-pick-hint', text: dir === 'out' ? '이 프로젝트가 뒤따르는 선행 프로젝트를 고르세요' : '이 프로젝트를 뒤따르는 후속 프로젝트를 고르세요' }), search, results);
    const close = pjvPopover(anchor, menu);
    let all = [];
    const paint = () => {
        const q = search.value.trim().toLowerCase();
        const items = all.filter((pr) => !existing.has(pr.id) && (!q || (pr.name || '').toLowerCase().includes(q) || String(pr.id).includes(q))).slice(0, 30);
        results.replaceChildren(...(items.length ? items.map((pr) => {
            const b = el('button', { class: 'pjv-menu-item pjv-edge-pick-item', type: 'button' }, el('span', { class: 'pjv-edge-pick-name', text: pr.name || '제목 없음' }), el('span', { class: 'pjv-edge-pick-id', text: '#' + pr.id }));
            b.onclick = async () => {
                b.disabled = true;
                const fromId = dir === 'out' ? p.id : pr.id;
                const toId = dir === 'out' ? pr.id : p.id;
                try {
                    await api('/api/ui/v6/projects/' + fromId + '/link', { method: 'POST', body: JSON.stringify({ to: toId, relation: 'follow_up' }) });
                    toast('연결했습니다');
                    close();
                    pjvReloadKeepScroll(reload);
                }
                catch (e) {
                    b.disabled = false;
                    toast('연결 실패 — ' + e.message, true);
                }
            };
            return b;
        }) : [el('div', { class: 'pjv-menu-empty', text: q ? '결과 없음' : '연결할 다른 프로젝트가 없어요' })]));
    };
    search.addEventListener('input', paint);
    results.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
    (async () => { try {
        all = await api('/api/ui/v6/projects').then((d) => (d && d.projects) || []);
    }
    catch (_) {
        all = [];
    } paint(); })();
    setTimeout(() => { try {
        search.focus();
    }
    catch (_) { /* noop */ } }, 0);
}
async function renderProjectV2Detail(view, idStr) {
    pjvSelReset(); // 화면 진입/재렌더 시 다중선택·하단 바 초기화
    const id = Number(idStr);
    const V6_BASE = '/api/ui/v6/projects/'; // 파일/세션/타임라인/팀원 섹션이 v6 라우트로 연결되도록 base 주입
    const backLink = el('a', { class: 'btn btn-ghost btn-sm', href: '#/projects2', text: '← 프로젝트' });
    const keepY = _pjvKeepScrollY;
    _pjvKeepScrollY = null; // 인라인 편집 재렌더면 스켈레톤 스킵 + 스크롤 복원(#358)
    if (keepY == null)
        view.replaceChildren(skeleton('프로젝트를 불러오는 중'));
    let data;
    try {
        data = await api('/api/ui/v6/projects/' + id).then((d) => d && (d.project || d));
    }
    catch (e) {
        view.replaceChildren(el('div', { class: 'page-head' }, backLink), errorNote(e, '프로젝트를 불러오지 못했습니다'));
        return;
    }
    if (!data) {
        view.replaceChildren(el('div', { class: 'page-head' }, backLink), el('div', { class: 'note', text: '프로젝트를 찾을 수 없습니다.' }));
        return;
    }
    const p = data;
    const members = p.members || [];
    const isDone = p.status === 'done';
    const reload = () => renderProjectV2Detail(view, idStr);
    // 헤더 — 제목(이름+상태칩) 좌 / 액션(완료토글·삭제) 우 한 줄, 설명, 팀원 칩(아래 별도 행). 박스 높이·세로정렬 통일.
    const head = el('div', { class: 'page-head' }, el('div', { class: 'proj-detail-back' }, backLink));
    // 상태 토글(완료/재개)은 '프로젝트 세부 설정' 팝업으로 이관 — 헤더엔 상태칩만 둔다.
    // 프로젝트 세부 설정 — 우측 액션 슬롯. 상태(완료된 프로젝트로/재개)·규칙(터미널 AI 주입)·연결된 지식 팝업.
    const meId = (state.me && (state.me.userId || state.me.email)) || '';
    // 삭제·팀원 수정은 '프로젝트 세부 설정' 팝업으로 이관 — 헤더 우측 액션은 설정 버튼만(권한 경계는 백엔드 403).
    const settingsBtn = el('button', { class: 'btn btn-sm btn-ghost', text: '⚙ 프로젝트 세부 설정',
        onclick: () => openProjectSettings(id, p, reload, meId, V6_BASE) });
    // '내 컴퓨터에서 작업'은 헤더에서 빼고 터미널 세션의 '＋ 새 세션' 드롭다운으로 이관(내 컴퓨터 / 중앙 컴퓨터 선택) — projectTerminalSection.
    // (코멘트는 헤더 버튼이 아니라 본문↔태스크 사이의 '코멘트' 섹션이 진입점 — projectCommentsSection. 클릭=드로어.)
    // 제목줄 — 이름(클릭해 수정)+상태칩(좌), 세부설정(우).
    const titleEl = el('h1', { class: 'proj-detail-title proj-detail-title-edit', title: '클릭해 이름 수정', text: p.name });
    const editTitle = () => {
        const inp = el('input', { class: 'proj-detail-title-input', value: p.name, maxlength: '200' });
        titleEl.replaceWith(inp);
        inp.focus();
        inp.select();
        let fin = false;
        const done = async (save) => {
            if (fin)
                return;
            fin = true;
            const nv = inp.value.trim();
            inp.replaceWith(titleEl);
            if (save && nv && nv !== p.name) {
                try {
                    await api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify({ name: nv }) });
                    p.name = nv;
                    titleEl.textContent = nv;
                }
                catch (e) {
                    toast('이름 수정 실패 — ' + e.message, true);
                }
            }
        };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
            e.preventDefault();
            done(true);
        }
        else if (e.key === 'Escape')
            done(false); });
        inp.addEventListener('blur', () => done(true));
    };
    titleEl.onclick = editTitle;
    head.append(el('div', { class: 'proj-detail-titlebar' }, 
    // 상태 배지(타이틀 오른쪽) 제거 — 아래 메타행의 상태 필드(클릭해 변경)와 중복이라 그쪽만 남긴다.
    el('div', { class: 'proj-detail-titlebox' }, titleEl), el('div', { class: 'proj-detail-actions' }, settingsBtn)));
    // (본문은 헤더에서 빼고 태스크 위 '본문' 섹션으로 분리 — projectBodySection. 다른 섹션과 동일 위계.)
    // 팀원 칩 행(proj-team-row) 제거 — 아래 메타 패널의 '팀원' 필드와 중복이라 한 곳(메타)만 남긴다.
    // 클릭업식 메타데이터 패널 — 이름 바로 아래(태스크 박스 위). 상태·팀원·기간·우선순위·시간추적·태그.
    head.append(pjvProjMetaPanel(p, members, reload));
    // 상세 본문 — 태스크(작업 위계)를 헤더 바로 아래 맨 위에 둔다(프로젝트의 핵심). 이어 공유 폴더 ·
    //  터미널 세션 · 작업 타임라인(org #/projects 템플릿과 동형, v6 데이터·라우트). 모든 섹션 v6 API base 연결.
    //  '필요/산출 지식'은 본문 바로 아래 '지식 흐름' 섹션으로 분리(#245) — 세부 설정 팝업에서 이관.
    // 후속/선행 프로젝트는 별도 박스(projectEdgesSection)를 없애고 상단 프로퍼티(pjvProjMetaPanel)로 이관(#359).
    view.replaceChildren(head, projectBodySection(id, p, reload), projectKnowledgeSection(id, p, reload), projectCommentsSection(id, members), pjvTasksSection(id, p.tasks || [], members, reload, p.fields || []), projectFolderSection(id, V6_BASE), projectTerminalSection(id, members, meId, V6_BASE, p.name, p), projectTimelineSection(id, members, V6_BASE));
    // 인라인 편집 재렌더면 리빌 애니메이션 대신 스크롤 복원(전면 재애니메이션도 '새로고침'처럼 보임) (#358)
    if (keepY != null)
        pjvRestoreScroll(keepY);
    else
        applyReveal(Array.from(view.children).slice(1));
}
// ── 본문 섹션 — 태스크 위, 다른 섹션(공유 폴더·터미널 세션·작업 타임라인)과 동일 위계·디자인(.card + .card-head). ──
//  마크다운 렌더 + 본문 클릭/✎ 편집 버튼으로 그 자리 편집(Enter 저장·Shift+Enter 줄바꿈·Esc 취소). 길면 접힘+Expand.
// ── 본문 속 지식 링크 언펄(#317 범위 A — 감지+표시만; 필요지식 자동등록은 하지 않음) ──
//  본문에 붙여넣은 위키 링크(`#/k/<name>` 또는 게이트웨이 풀 URL `…/ui/#/k/<name>`)를 표시 렌더에서 '제목 + 링크'로 보여준다.
//  게이트웨이 주소는 하드코딩하지 않는다(고객사마다 다름) — 현재 origin + org 프로필 gateway_url(loadAdmin) 호스트만 '우리 것'으로 인정.
//  renderInline 은 생 URL 을 오토링크하지 않으므로, 렌더 전에 `[<name>](#/k/<name>)` 마크다운 링크로 치환하고 제목은 비동기로 채운다.
let _gwHostsP = null;
function gatewayHosts() {
    if (_gwHostsP)
        return _gwHostsP;
    _gwHostsP = (async () => {
        const hosts = new Set([location.host]);
        try {
            const d = await loadAdmin();
            const gw = d && d.profile && d.profile.gateway_url;
            if (gw)
                hosts.add(new URL(String(gw).replace(/\/mcp$/, '').replace(/\/$/, '')).host);
        }
        catch (_) { /* 프로필 못 받으면 현재 origin 만 */ }
        return hosts;
    })();
    return _gwHostsP;
}
const _knTitleCache = new Map(); // name → title|null (null=없음/실패, 재요청 안 함)
async function knTitle(name) {
    if (_knTitleCache.has(name))
        return _knTitleCache.get(name);
    let title = null;
    try {
        const d = await api('/api/ui/knowledge/' + encodeURIComponent(name));
        title = (d && d.knowledge && d.knowledge.title) || null;
    }
    catch (_) {
        title = null;
    }
    _knTitleCache.set(name, title);
    return title;
}
// md 안의 지식 링크를 `[<name>](#/k/<name>)` 로 치환. 풀 URL 은 host 가 우리 게이트웨이(hosts)일 때만. 이미 마크다운 링크 타깃인 건 건너뛴다.
function linkifyKnowledgeRefs(md, hosts) {
    const names = new Set();
    const out = String(md == null ? '' : md).replace(/(?:https?:\/\/[^\s)\]]+?)?#\/k\/([\w-]+)/g, (m, name, offset, str) => {
        const before = offset > 0 ? str.charAt(offset - 1) : '';
        if (before === '(' || before === ']')
            return m; // 기존 [..](..) 링크 타깃 → 안 건드림
        if (m.charAt(0) === 'h') { // 풀 URL → host 검증(우리 게이트웨이만)
            try {
                if (!hosts.has(new URL(m.split('#')[0]).host))
                    return m;
            }
            catch (_) {
                return m;
            }
        }
        names.add(name);
        return '[' + name + '](#/k/' + name + ')';
    });
    return { md: out, names };
}
// 렌더된 본문에서 지식 링크: 클릭(본문 편집 진입) 차단 + 제목으로 텍스트 교체. 게이트웨이 host 가 현재 origin 과 다르면 한 번 재치환.
async function unfurlKnowledgeLinks(body, desc, first, onBodyClick, measure) {
    let names = first.names;
    try {
        const hosts = await gatewayHosts();
        if (!(hosts.size === 1 && hosts.has(location.host))) {
            const re = linkifyKnowledgeRefs(desc, hosts);
            if (re.md !== first.md) {
                body.replaceChildren(renderMarkdown(re.md));
                body.onclick = onBodyClick;
                names = re.names;
            }
        }
    }
    catch (_) { /* noop */ }
    body.querySelectorAll('a.md-link').forEach((a) => {
        if (!(a.getAttribute('href') || '').startsWith('#/k/'))
            return;
        a.classList.add('kn-unfurl');
        a.addEventListener('click', (e) => e.stopPropagation()); // 링크 클릭 시 본문 편집 진입 방지
    });
    for (const name of names) {
        const title = await knTitle(name);
        if (!title)
            continue;
        body.querySelectorAll('a.md-link').forEach((a) => {
            if (a.getAttribute('href') === '#/k/' + name) {
                a.textContent = title;
                a.title = name;
            }
        });
    }
    if (measure)
        requestAnimationFrame(measure);
}
function projectBodySection(id, p, reload) {
    const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
    const bodyWrap = el('div', { class: 'proj-body-sec' });
    // '✎ 편집' 버튼 제거 — 본문을 클릭하면 그 자리에서 편집되고(아래 render: body.onclick=editBody / '＋ 본문 추가'), 버튼은 불필요.
    card.append(el('div', { class: 'card-head' }, el('h3', { text: '본문' })));
    card.append(bodyWrap);
    const editBody = () => {
        // 위지위그(WYSIWYG) — 렌더된 본문 '위에서 바로' 편집(contentEditable). 미리보기 따로 없음.
        //  굵게/기울임/말머리 등을 서식 바로 누르면 그 자리에서 즉시 굵게/목록으로 보인다. 저장 시 DOM→마크다운으로 직렬화.
        const ce = el('div', { class: 'proj-body-wysiwyg md-rendered', contenteditable: 'true', spellcheck: 'false' });
        if (p.description && p.description.trim()) {
            const rendered = renderMarkdown(p.description);
            while (rendered.firstChild)
                ce.append(rendered.firstChild);
        }
        else {
            ce.append(el('p', {}, el('br', {})));
        }
        bodyWrap.replaceChildren(ce);
        ce.focus();
        try {
            const r = document.createRange();
            r.selectNodeContents(ce);
            r.collapse(false);
            const sel = window.getSelection();
            if (sel) {
                sel.removeAllRanges();
                sel.addRange(r);
            }
        }
        catch (_) { /* noop */ }
        const toolbar = buildWysiwygToolbar(ce);
        let fin = false;
        const done = async (save) => {
            if (fin)
                return;
            fin = true;
            toolbar.destroy();
            const nv = save ? mdFromDom(ce) : (p.description || '');
            if (save && nv !== (p.description || '')) {
                try {
                    await api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify({ description: nv || null }) });
                    p.description = nv;
                }
                catch (e) {
                    toast('본문 수정 실패 — ' + e.message, true);
                }
            }
            render();
        };
        // 저장=⌘/Ctrl+Enter 또는 바깥클릭(blur), 취소=Esc. (Enter 는 줄바꿈/문단)
        ce.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                done(true);
            }
            else if (e.key === 'Escape') {
                e.preventDefault();
                done(false);
            }
        });
        // 지연 체크 — 서식 바 클릭·링크 prompt 로 잠깐 포커스가 떠도(다시 에디터로 돌아오면) 저장/종료하지 않음.
        ce.addEventListener('blur', () => setTimeout(() => {
            if (document.activeElement === ce)
                return;
            if (document.querySelector('.fmt-toolbar:hover'))
                return;
            done(true);
        }, 150));
    };
    const render = () => {
        bodyWrap.replaceChildren();
        if (p.description) {
            // 지식 링크 언펄(#317) — 현재 origin 으로 즉시 치환(흔한 경우), 게이트웨이 host·제목은 비동기 보강.
            const first = linkifyKnowledgeRefs(p.description, new Set([location.host]));
            const body = el('div', { class: 'proj-detail-body md-rendered', title: '클릭해 본문 수정' }, renderMarkdown(first.md));
            body.onclick = editBody;
            // 펼침 컨트롤(클릭업/노션식) — 접힘 땐 페이드 위에 작은 알약으로 가운데 떠 있고, 펼치면 본문 아래 가운데로.
            const wrap = el('div', { class: 'proj-detail-body-wrap is-collapsed' });
            const box = el('div', { class: 'proj-detail-body-box collapsed' }, body);
            const lbl = el('span', { class: 'lbl', text: '더 보기' });
            const caret = el('span', { class: 'caret', text: '⌄' });
            const exBtn = el('button', { class: 'proj-detail-body-expand', type: 'button' }, lbl, caret);
            const exRow = el('div', { class: 'proj-detail-body-expand-row' }, exBtn);
            exBtn.onclick = (e) => {
                e.stopPropagation();
                const collapsed = box.classList.toggle('collapsed');
                wrap.classList.toggle('is-collapsed', collapsed);
                caret.textContent = collapsed ? '⌄' : '⌃';
                lbl.textContent = collapsed ? '더 보기' : '접기';
            };
            wrap.append(box, exRow);
            bodyWrap.append(wrap);
            // 짧은 본문(접어도 다 보이는)이면 펼침 불필요 → 펼친 채로 두고 컨트롤 숨김. (레이아웃 후 측정)
            const measure = () => {
                if (body.scrollHeight <= box.clientHeight + 2) {
                    box.classList.remove('collapsed');
                    wrap.classList.remove('is-collapsed');
                    exRow.style.display = 'none';
                }
            };
            requestAnimationFrame(measure);
            unfurlKnowledgeLinks(body, p.description, first, editBody, measure); // 비동기: 게이트웨이 host + 제목 보강(#317)
        }
        else {
            const add = el('button', { class: 'proj-detail-desc-add', type: 'button', text: '＋ 본문 추가' });
            add.onclick = editBody;
            bodyWrap.append(add);
        }
    };
    render();
    return card;
}
// ── '연결된 지식' 섹션 — 본문 바로 아래. 「필요 지식 → 이 프로젝트 → 산출 지식」 구조를 한 화면에(#245·#317). ──
//  '막막함' 제거(#317): ① 필요 빈칸은 죽은 끝 대신 추천을 인라인으로 먼저 보여줌(openKnowledgePicker = 추천-우선 단일 픽커)
//  ② '왜 다나' 배너(→ #/learn) ③ 액션은 섹션 헤더 우상단 단일 버튼 [＋ 지식 연결](관계는 픽커 라디오, 직접 작성도 픽커 안) ④ 산출 빈칸은 '아직 비어도 정상' 안내.
//  변경 후 v6 상세 GET 으로 재조회해 재페인트.
// (후속/선행 프로젝트 박스 projectEdgesSection 제거 — 상단 프로퍼티 pjvProjMetaPanel 의 선행/후속 필드로 이관, #359.)
function projectKnowledgeSection(id, p, reload) {
    const knName = (k) => k.name || k.knowledge_name;
    let cur = { required: (p.knowledge || {}).required || [], produced: (p.knowledge || {}).produced || [] };
    let remeasure = null; // 길이 초과 시 접기 컨트롤 재측정(접힘 박스 생성 후 할당). 리스트 변경마다 호출.
    const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
    // 섹션 액션 — 칼럼별 버튼 대신 우상단 단일 버튼 하나(#317). 관계(필요/산출)는 픽커 라디오에서 고른다.
    const knAddBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 지식 연결',
        title: '관련 지식을 추천받고 검색해 연결 — 필요/산출은 픽커에서 선택(없으면 직접 작성)',
        onclick: () => openKnowledgePicker(id, 'required', cur.required.map(knName), refresh) });
    card.append(el('div', { class: 'card-head' }, el('div', { class: 'pjk-head-titles', style: 'display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; min-width:0;' }, el('h3', { text: '연결된 지식' }), el('span', { class: 'pjk-head-hint' }, '필요 지식을 연결하면 AI가 처음부터 그 맥락을 쥐고 시작해요 — ', el('a', { href: '#/learn?focus=required', style: 'color:var(--blue); text-decoration:none; white-space:nowrap;', text: '자세히' }))), knAddBtn));
    const reqList = el('div', { class: 'pjk-list' });
    const prodList = el('div', { class: 'pjk-list' });
    const reqCount = el('span', { class: 'pjk-count' });
    const prodCount = el('span', { class: 'pjk-count' });
    // '왜 필요지식을 다나'는 닫는 배너 대신 섹션 제목 옆 부제로 이동(#317) — 위 card-head 의 pjk-head-hint + [자세히](→ learn 해당 섹션).
    // 필요지식 빈칸 — 죽은 끝('아직 없습니다') 대신 추천을 인라인으로 먼저(#317). 추천은 한 번만 불러 캐시(재페인트마다 호출 방지).
    let recsCache = null;
    async function fetchRecs() {
        if (recsCache)
            return recsCache;
        try {
            recsCache = await api('/api/ui/v6/projects/' + id + '/recommend-knowledge?limit=3').then((d) => (d && d.entries) || []);
        }
        catch (_) {
            recsCache = [];
        }
        return recsCache;
    }
    function recRow(m) {
        const name = knName(m);
        const pct = Math.round((Number(m.similarity) || 0) * 100);
        const addBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '연결' });
        addBtn.onclick = async () => {
            addBtn.disabled = true;
            try {
                await api('/api/ui/v6/projects/' + id + '/knowledge', { method: 'POST', body: JSON.stringify({ name, relation: 'required' }) });
                toast('연결했습니다');
                refresh();
            }
            catch (e) {
                addBtn.disabled = false;
                toast('연결 실패 — ' + e.message, true);
            }
        };
        return el('div', { class: 'pjk-rec-row' }, el('a', { class: 'pjk-rec-title', href: '#/k/' + encodeURIComponent(name), text: m.title || name }), m.shares_category ? el('span', { class: 'kn-chip', title: '프로젝트와 같은 분류', text: '📁' }) : null, pct > 0 ? el('span', { class: 'admin-hint pjk-rec-pct', title: '의미 유사도', text: pct + '%' }) : null, addBtn);
    }
    // 필요지식 칼럼 = 연결된 항목 + 아직 연결 안 된 추천을 **함께** 그린다(#138).
    //  하나 연결해도 나머지 추천은 그대로 남아 계속 추가 연결 가능(예전엔 첫 연결 순간 추천 목록이 통째로 사라짐).
    //  recsCache 는 최초 1회(연결 전) 목록이라, 이미 연결된 건 이름으로 걸러 낸다.
    let reqPaintSeq = 0;
    async function paintRequired(boxEl) {
        const seq = ++reqPaintSeq;
        const knRows = () => cur.required.map((k) => knRow(k, 'required'));
        if (!recsCache) { // 추천 로딩 전 — 연결된 건 바로 보이고, 추천 자리엔 로딩 문구.
            boxEl.replaceChildren(...knRows(), el('div', { class: 'pjk-empty', text: cur.required.length ? '관련 지식 더 찾는 중…' : '관련 지식을 찾는 중…' }));
        }
        const recs = await fetchRecs();
        if (seq !== reqPaintSeq)
            return; // 그 사이 다시 그려졌으면 폐기(레이스).
        const connected = new Set(cur.required.map(knName));
        const fresh = recs.filter((m) => !connected.has(knName(m))); // 이미 연결된 추천은 제외.
        const children = knRows();
        if (fresh.length) {
            children.push(el('div', { class: 'pjk-rec' }, el('div', { class: 'pjk-rec-head', text: cur.required.length ? '이런 지식도 연결해 보세요' : '이런 지식이 필요해 보여요' }), ...fresh.map(recRow)));
        }
        else if (!cur.required.length) {
            children.push(el('div', { class: 'pjk-empty' }, '아직 연결된 필요지식이 없어요. ', el('b', { text: '[＋ 지식 연결]' }), ' 로 시작하세요 — 찾는 게 없으면 거기서 직접 작성도 됩니다.'));
        }
        boxEl.replaceChildren(...children);
        if (remeasure)
            requestAnimationFrame(remeasure); // 내용이 바뀌었으니 접기 재측정.
    }
    // 지식 한 줄 — 제목(상세 링크) + 메타칩 + 연결 해제(✕). relation 별로 unlink 한다.
    function knRow(k, relation) {
        const name = knName(k);
        const r = el('div', { class: 'pjk-row' }, el('a', { class: 'pjk-row-title', href: '#/k/' + encodeURIComponent(name), text: k.title || name }), el('div', { class: 'pjk-row-meta' }, 
        // 배지는 '예외만' 표시 — 기본값(검색=recalled·저작=authored·유효=active)은 매 행 똑같이 반복돼
        // 차별성 0 인 노이즈라 숨긴다. 벗어난 것만(주입·미러·폐기 등) 배지로 떠 제목 폭을 최대로 확보(#59 가독성).
        // 간격은 CSS gap — 예전 리터럴 공백(' '·'  ') span 래핑은 간격이 들쭉날쭉해 제거.
        (k.injection && k.injection !== 'recalled') ? knInjectChip(k.injection) : null, (k.provenance && k.provenance !== 'authored') ? knProvChip(k.provenance) : null, (k.lifecycle && k.lifecycle !== 'active') ? lifecycleDot(k.lifecycle) : null));
        const x = el('button', { class: 'pjk-row-x', type: 'button', title: '연결 해제', text: '✕' });
        x.onclick = async (ev) => {
            ev.preventDefault();
            try {
                await api('/api/ui/v6/projects/' + id + '/knowledge', { method: 'POST', body: JSON.stringify({ name, relation, unlink: true }) });
                toast('연결을 해제했습니다');
                refresh();
            }
            catch (e) {
                toast('해제 실패 — ' + e.message, true);
            }
        };
        r.append(x);
        return r;
    }
    function paint(boxEl, list, relation, emptyText) {
        if (!list.length) {
            boxEl.replaceChildren(el('div', { class: 'pjk-empty', text: emptyText }));
            return;
        }
        boxEl.replaceChildren(...list.map((k) => knRow(k, relation)));
    }
    function repaint() {
        reqCount.textContent = String(cur.required.length);
        prodCount.textContent = String(cur.produced.length);
        paintRequired(reqList); // 연결된 항목 + 남은 추천을 함께(#138).
        paint(prodList, cur.produced, 'produced', '작업이 진행되면 여기에 쌓입니다 — 지금 비워둬도 괜찮아요.');
        if (remeasure)
            requestAnimationFrame(remeasure); // 내용이 바뀌면 접기 필요 여부 재판정.
    }
    async function refresh() {
        try {
            const d = await api('/api/ui/v6/projects/' + id).then((r) => r && (r.project || r));
            cur = { required: (d.knowledge || {}).required || [], produced: (d.knowledge || {}).produced || [] };
        }
        catch (_) { /* keep */ }
        repaint();
    }
    // (지식 연결 액션은 칼럼별이 아니라 섹션 헤더 우상단 단일 버튼 — 위 knAddBtn. #317)
    // 가운데 노드 — '이 프로젝트' 문구만(이름·상태 제거·박스 축소 #258). 좌우 화살표로 필요→프로젝트→산출 흐름을 표현.
    const node = el('div', { class: 'pjk-node' }, el('div', { class: 'pjk-node-label', text: '이 프로젝트' }));
    const reqCol = el('div', { class: 'pjk-col pjk-col-req' }, el('div', { class: 'pjk-col-head' }, el('span', { class: 'pjk-col-title', text: '필요 지식' }), reqCount), reqList);
    const prodCol = el('div', { class: 'pjk-col pjk-col-prod' }, el('div', { class: 'pjk-col-head' }, el('span', { class: 'pjk-col-title', text: '산출 지식' }), prodCount), prodList);
    const flow = el('div', { class: 'pjk-flow' }, reqCol, el('div', { class: 'pjk-arrow', 'aria-hidden': 'true', text: '→' }), node, el('div', { class: 'pjk-arrow', 'aria-hidden': 'true', text: '→' }), prodCol);
    // 길면(특정 높이 초과) 접기 — 본문 섹션과 동일한 펼침 알약(.proj-detail-body-expand). 짧으면 컨트롤 숨기고 펼쳐 둔다.
    const collapseBox = el('div', { class: 'pjk-collapse collapsed' }, flow);
    const exLbl = el('span', { class: 'lbl', text: '더 보기' });
    const exCaret = el('span', { class: 'caret', text: '⌄' });
    const exBtn = el('button', { class: 'proj-detail-body-expand', type: 'button' }, exLbl, exCaret);
    const exRow = el('div', { class: 'proj-detail-body-expand-row pjk-expand-row' }, exBtn);
    let userExpanded = false; // 사용자가 펼쳤는지 기억 — 재측정 후에도 상태 보존.
    const applyExpanded = (expanded) => {
        collapseBox.classList.toggle('collapsed', !expanded);
        exCaret.textContent = expanded ? '⌃' : '⌄';
        exLbl.textContent = expanded ? '접기' : '더 보기';
    };
    exBtn.onclick = () => { userExpanded = collapseBox.classList.contains('collapsed'); applyExpanded(userExpanded); };
    // 캡 높이로 강제해 넘치는지 측정 → 짧으면 컨트롤 숨기고 펼침, 길면 컨트롤 노출(사용자 펼침 상태 유지).
    remeasure = () => {
        collapseBox.classList.add('collapsed');
        const tall = flow.scrollHeight > collapseBox.clientHeight + 2;
        if (!tall) {
            collapseBox.classList.remove('collapsed');
            exRow.style.display = 'none';
            return;
        }
        exRow.style.display = '';
        applyExpanded(userExpanded);
    };
    card.append(collapseBox, exRow);
    repaint();
    return card;
}
// (직접 작성은 모달이 아니라 새 작성 페이지(#/knowledge/new?project=&relation=)로 이관 — renderKnowledgeCreate 가 프로젝트 연결을 기본 채움.)
// ── 본문 에디터 서식 툴바 — 텍스트 선택 시 그 위로 떠서 선택 영역에 마크다운 서식 적용(클릭업식, 박스 없는 인라인 편집용). ──
//  렌더러가 지원하는 서식만 노출: 제목·굵게·기울임·코드·목록·인용·링크. 버튼은 mousedown preventDefault 로 textarea 포커스(=선택·편집모드)를 유지한다.
function buildFormatToolbar(ta) {
    const bar = el('div', { class: 'fmt-toolbar' });
    bar.hidden = true;
    let lastX = 0, lastY = 0;
    const fire = () => ta.dispatchEvent(new Event('input', { bubbles: true })); // 자동 높이 재계산
    const wrapSel = (mark) => {
        const s = ta.selectionStart, e = ta.selectionEnd;
        const sel = ta.value.slice(s, e);
        ta.setRangeText(mark + sel + mark, s, e, 'end');
        ta.selectionStart = s + mark.length;
        ta.selectionEnd = e + mark.length;
        ta.focus();
        fire();
        position();
    };
    const prefixLines = (prefix) => {
        const val = ta.value;
        const s = ta.selectionStart, e = ta.selectionEnd;
        const ls = val.lastIndexOf('\n', s - 1) + 1;
        let le = val.indexOf('\n', e);
        if (le === -1)
            le = val.length;
        const block = val.slice(ls, le).split('\n').map((l) => prefix + l).join('\n');
        ta.setRangeText(block, ls, le, 'end');
        ta.selectionStart = ls;
        ta.selectionEnd = ls + block.length;
        ta.focus();
        fire();
        position();
    };
    const insertLink = () => {
        const s = ta.selectionStart, e = ta.selectionEnd;
        const sel = ta.value.slice(s, e) || '링크';
        const url = window.prompt('링크 URL', 'https://');
        if (url == null)
            return;
        ta.setRangeText('[' + sel + '](' + url + ')', s, e, 'end');
        ta.focus();
        fire();
        position();
    };
    const ic = (...kids) => { const n = sv('svg', { class: 'fmt-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); for (const k of kids)
        n.append(k); return n; };
    const mkBtn = (inner, title, fn, cls) => {
        const b = el('button', { class: 'fmt-btn' + (cls ? ' ' + cls : ''), type: 'button', title });
        if (typeof inner === 'string')
            b.textContent = inner;
        else
            b.append(inner);
        b.addEventListener('mousedown', (e) => e.preventDefault()); // textarea 포커스 유지(선택·편집모드 유지)
        b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
        return b;
    };
    bar.append(mkBtn('H', '제목', () => prefixLines('## '), 'fmt-h'), mkBtn('B', '굵게', () => wrapSel('**'), 'fmt-b'), mkBtn('I', '기울임', () => wrapSel('*'), 'fmt-i'), mkBtn(ic(sv('polyline', { points: '8 8 4 12 8 16' }), sv('polyline', { points: '16 8 20 12 16 16' })), '코드', () => wrapSel('`')), mkBtn(ic(sv('line', { x1: 9, y1: 6, x2: 20, y2: 6 }), sv('line', { x1: 9, y1: 12, x2: 20, y2: 12 }), sv('line', { x1: 9, y1: 18, x2: 20, y2: 18 }), sv('circle', { cx: 4.5, cy: 6, r: 1.1 }), sv('circle', { cx: 4.5, cy: 12, r: 1.1 }), sv('circle', { cx: 4.5, cy: 18, r: 1.1 })), '목록', () => prefixLines('- ')), mkBtn(ic(sv('path', { d: 'M6 7h8M6 12h12M6 17h8' }), sv('path', { d: 'M3 6.5v11' })), '인용', () => prefixLines('> ')), mkBtn(ic(sv('path', { d: 'M10 13a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1.5 1.5' }), sv('path', { d: 'M14 11a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1.5-1.5' })), '링크', insertLink));
    document.body.append(bar);
    function position() {
        if (ta.selectionStart === ta.selectionEnd) {
            bar.hidden = true;
            return;
        }
        bar.hidden = false;
        const bw = bar.offsetWidth || 250, bh = bar.offsetHeight || 38;
        const rect = ta.getBoundingClientRect();
        let x = (lastX || (rect.left + rect.width / 2)) - bw / 2;
        let y = (lastY || rect.top) - bh - 10;
        x = Math.max(8, Math.min(x, window.innerWidth - bw - 8));
        if (y < 8)
            y = (lastY || rect.top) + 18; // 위 공간 없으면 선택 아래로
        bar.style.left = x + 'px';
        bar.style.top = y + 'px';
    }
    const onMouseUp = (e) => { lastX = e.clientX; lastY = e.clientY; setTimeout(position, 0); };
    const onKeyUp = (e) => { if (e.shiftKey || (e.key && e.key.indexOf('Arrow') === 0))
        setTimeout(position, 0); };
    const onScroll = () => { if (!bar.hidden)
        position(); };
    ta.addEventListener('mouseup', onMouseUp);
    ta.addEventListener('keyup', onKeyUp);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return { destroy: () => { bar.remove(); window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll); } };
}
// ── 위지위그 본문 직렬화 — contentEditable DOM → 마크다운(renderMarkdown 지원 서브셋의 역). 알 수 없는 요소는 자식만 재귀(텍스트 보존). ──
function mdFromDom(root) {
    // 인라인(텍스트 + 굵게/기울임/코드/링크/줄바꿈) → 마크다운 문자열.
    const inlineMd = (node) => {
        let out = '';
        node.childNodes.forEach((n) => {
            if (n.nodeType === 3) {
                out += n.textContent;
                return;
            }
            if (n.nodeType !== 1)
                return;
            const tag = n.tagName.toLowerCase();
            if (tag === 'br') {
                out += '\n';
                return;
            }
            if (tag === 'code') {
                out += '`' + n.textContent + '`';
                return;
            }
            if (tag === 'a') {
                const href = n.getAttribute('href') || '';
                const lbl = inlineMd(n) || n.textContent;
                out += href ? '[' + lbl + '](' + href + ')' : lbl;
                return;
            }
            const st = (n.getAttribute && n.getAttribute('style')) || '';
            const bold = tag === 'strong' || tag === 'b' || /font-weight\s*:\s*(bold|[6-9]00)/.test(st);
            const ital = tag === 'em' || tag === 'i' || /font-style\s*:\s*italic/.test(st);
            let inner = inlineMd(n);
            if (ital)
                inner = '*' + inner + '*';
            if (bold)
                inner = '**' + inner + '**';
            out += inner;
        });
        return out;
    };
    const blocks = [];
    const walk = (node, quote) => {
        node.childNodes.forEach((n) => {
            if (n.nodeType === 3) {
                const t = n.textContent.replace(/\s+/g, ' ').trim();
                if (t)
                    blocks.push((quote ? '> ' : '') + t);
                return;
            }
            if (n.nodeType !== 1)
                return;
            const tag = n.tagName.toLowerCase();
            const q = quote ? '> ' : '';
            if (/^h[1-6]$/.test(tag)) {
                const t = inlineMd(n).trim();
                if (t)
                    blocks.push(q + '#'.repeat(Number(tag[1])) + ' ' + t);
                return;
            }
            if (tag === 'p' || tag === 'div') {
                const t = inlineMd(n).replace(/\n+$/, '').trim();
                if (t)
                    blocks.push(quote ? t.split('\n').map((l) => '> ' + l).join('\n') : t);
                return;
            }
            if (tag === 'ul' || tag === 'ol') {
                let idx = 1;
                const items = [];
                n.childNodes.forEach((li) => { if (li.nodeType === 1 && li.tagName.toLowerCase() === 'li') {
                    const mk = tag === 'ol' ? (idx++ + '. ') : '- ';
                    const t = inlineMd(li).trim();
                    items.push(q + mk + t);
                } });
                if (items.length)
                    blocks.push(items.join('\n'));
                return;
            }
            if (tag === 'blockquote') {
                walk(n, true);
                return;
            }
            if (tag === 'pre') {
                blocks.push('```\n' + n.textContent.replace(/\n$/, '') + '\n```');
                return;
            }
            if (tag === 'hr') {
                blocks.push('---');
                return;
            }
            walk(n, quote); // 알 수 없는 래퍼 → 자식 블록 재귀
        });
    };
    walk(root, false);
    return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}
// ── 위지위그 서식 바 — contentEditable 용(execCommand). 선택 시 떠서 그 자리에서 굵게/기울임/제목/목록/인용/코드/링크 즉시 적용. ──
function buildWysiwygToolbar(ce) {
    const bar = el('div', { class: 'fmt-toolbar' });
    bar.hidden = true;
    try {
        document.execCommand('styleWithCSS', false, 'false');
    }
    catch (_) { /* 시맨틱 태그(<b>/<i>) 우선 */ }
    const exec = (cmd, val) => { ce.focus(); try {
        document.execCommand(cmd, false, val);
    }
    catch (_) { /* noop */ } setTimeout(position, 0); };
    const wrapCode = () => {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount)
            return;
        const range = sel.getRangeAt(0);
        const txt = range.toString();
        if (!txt)
            return;
        const code = el('code', { class: 'md-code', text: txt });
        range.deleteContents();
        range.insertNode(code);
        const r = document.createRange();
        r.selectNodeContents(code);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
        ce.focus();
        setTimeout(position, 0);
    };
    const insertLink = () => {
        const sel = window.getSelection();
        const txt = sel ? sel.toString() : '';
        const url = window.prompt('링크 URL', 'https://');
        if (url == null)
            return;
        ce.focus();
        if (txt) {
            try {
                document.execCommand('createLink', false, url);
            }
            catch (_) { /* noop */ }
        }
        else {
            try {
                document.execCommand('insertHTML', false, '<a href="' + url.replace(/"/g, '%22') + '">' + url + '</a>');
            }
            catch (_) { /* noop */ }
        }
        setTimeout(position, 0);
    };
    const ic = (...kids) => { const n = sv('svg', { class: 'fmt-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); for (const k of kids)
        n.append(k); return n; };
    const mkBtn = (inner, title, fn, cls) => {
        const b = el('button', { class: 'fmt-btn' + (cls ? ' ' + cls : ''), type: 'button', title });
        if (typeof inner === 'string')
            b.textContent = inner;
        else
            b.append(inner);
        b.addEventListener('mousedown', (e) => e.preventDefault()); // 에디터 포커스·선택 유지
        b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
        return b;
    };
    bar.append(mkBtn('H', '제목', () => exec('formatBlock', 'h2'), 'fmt-h'), mkBtn('B', '굵게', () => exec('bold'), 'fmt-b'), mkBtn('I', '기울임', () => exec('italic'), 'fmt-i'), mkBtn(ic(sv('polyline', { points: '8 8 4 12 8 16' }), sv('polyline', { points: '16 8 20 12 16 16' })), '코드', wrapCode), mkBtn(ic(sv('line', { x1: 9, y1: 6, x2: 20, y2: 6 }), sv('line', { x1: 9, y1: 12, x2: 20, y2: 12 }), sv('line', { x1: 9, y1: 18, x2: 20, y2: 18 }), sv('circle', { cx: 4.5, cy: 6, r: 1.1 }), sv('circle', { cx: 4.5, cy: 12, r: 1.1 }), sv('circle', { cx: 4.5, cy: 18, r: 1.1 })), '목록', () => exec('insertUnorderedList')), mkBtn(ic(sv('path', { d: 'M6 7h8M6 12h12M6 17h8' }), sv('path', { d: 'M3 6.5v11' })), '인용', () => exec('formatBlock', 'blockquote')), mkBtn(ic(sv('path', { d: 'M10 13a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1.5 1.5' }), sv('path', { d: 'M14 11a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1.5-1.5' })), '링크', insertLink));
    document.body.append(bar);
    function position() {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount || !ce.contains(sel.anchorNode)) {
            bar.hidden = true;
            return;
        }
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) {
            bar.hidden = true;
            return;
        }
        bar.hidden = false;
        const bw = bar.offsetWidth || 250, bh = bar.offsetHeight || 38;
        let x = rect.left + rect.width / 2 - bw / 2;
        let y = rect.top - bh - 10;
        x = Math.max(8, Math.min(x, window.innerWidth - bw - 8));
        if (y < 8)
            y = rect.bottom + 10;
        bar.style.left = x + 'px';
        bar.style.top = y + 'px';
    }
    const onSel = () => setTimeout(position, 0);
    document.addEventListener('selectionchange', onSel);
    ce.addEventListener('mouseup', onSel);
    ce.addEventListener('keyup', onSel);
    const onScroll = () => { if (!bar.hidden)
        position(); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return { destroy: () => { bar.remove(); document.removeEventListener('selectionchange', onSel); window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll); } };
}
// ── 코멘트 섹션 — 본문↔태스크 사이, 같은 급(.card). 얇은 가로 스트립으로 최신 코멘트(아바타+이름+요약)를 카드로 쭉.
//  세로 공간 최소(헤더 + 한 줄 카드). 섹션 어디든 클릭 → 오른쪽 드로어(openProjectComments)로 전체 보기·작성. ──
function projectCommentsSection(id, members) {
    const nameOf = (uid) => { const m = (members || []).find((x) => x.member_id === uid); return (m && m.display_name) || uid || '?'; };
    const card = el('div', { class: 'card pjv-cmt-sec', style: 'margin-bottom:18px', role: 'button', tabindex: '0', title: '코멘트 열기' });
    const countEl = el('span', { class: 'pjv-cmt-sec-count' });
    const unreadBadge = el('span', { class: 'pjv-cmt-unread', hidden: true });
    const strip = el('div', { class: 'pjv-cmt-strip' }, el('div', { class: 'pjv-cmt-loading', text: '불러오는 중…' }));
    card.append(el('div', { class: 'card-head pjv-cmt-sec-head' }, el('h3', {}, el('span', { text: '코멘트' }), countEl, unreadBadge), el('span', { class: 'pjv-cmt-sec-hint', text: '클릭해 작성 · 모두 보기 →' })), strip);
    // 안 읽은 코멘트 강조 — 기기별 마지막 읽음 id(localStorage)보다 새 코멘트(내가 쓴 것 제외)를 안읽음으로. 클릭(드로어 열기)=읽음 처리.
    const cmtMeId = (state.me && (state.me.userId || state.me.email)) || '';
    const cmtReadKey = 'pjv_cmt_read_' + id;
    const cmtLastRead = () => Number(localStorage.getItem(cmtReadKey)) || 0;
    const cmtMarkRead = (list) => { const mx = Math.max(0, ...list.map((c) => Number(c.id) || 0)); if (mx)
        localStorage.setItem(cmtReadKey, String(mx)); };
    let cmtLoaded = [];
    const open = () => {
        cmtMarkRead(cmtLoaded);
        unreadBadge.hidden = true;
        card.classList.remove('pjv-cmt-has-unread');
        strip.querySelectorAll('.pjv-cmt-mini-unread').forEach((n) => n.classList.remove('pjv-cmt-mini-unread'));
        openProjectComments(id, members);
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
    } });
    (async () => {
        let comments = [];
        try {
            const d = await api('/api/ui/v6/projects/' + id + '/comments');
            comments = ((d && d.feed) || []).filter((f) => f && f.kind === 'comment');
        }
        catch (_) {
            strip.replaceChildren(el('div', { class: 'pjv-cmt-loading', text: '코멘트를 불러오지 못했어요' }));
            return;
        }
        cmtLoaded = comments;
        countEl.textContent = comments.length ? ' ' + comments.length : '';
        const lr = cmtLastRead();
        const isUnread = (c) => (Number(c.id) || 0) > lr && c.actor !== cmtMeId;
        const unreadN = comments.filter(isUnread).length;
        if (unreadN) {
            unreadBadge.hidden = false;
            unreadBadge.textContent = unreadN + '개 안 읽음';
            card.classList.add('pjv-cmt-has-unread');
        }
        strip.replaceChildren();
        if (!comments.length) {
            strip.append(el('div', { class: 'pjv-cmt-empty-card' }, el('span', { class: 'pjv-cmt-empty-ic', text: '＋' }), el('span', { text: '첫 코멘트를 남겨보세요' })));
            return;
        }
        const recent = comments.slice().reverse().slice(0, 12); // 피드는 시간 오름차순 → 최신 먼저
        for (const c of recent) {
            const who = c.display_name || nameOf(c.actor);
            const preview = (c.body || '').replace(/\s+/g, ' ').trim();
            strip.append(el('div', { class: 'pjv-cmt-mini' + (isUnread(c) ? ' pjv-cmt-mini-unread' : '') }, el('div', { class: 'pjv-cmt-mini-top' }, el('span', { class: 'pjv-cmt-mini-ava', style: 'background:' + avatarColor(c.actor || who), text: initials(who) }), el('span', { class: 'pjv-cmt-mini-name', text: who }), el('span', { class: 'pjv-cmt-mini-time', text: c.ts ? relTime(c.ts) : '' })), el('div', { class: 'pjv-cmt-mini-text', text: preview })));
        }
    })();
    return card;
}
// ── 코멘트 드로어 — 코멘트 섹션 클릭 → 우측에서 슬라이드되는 오버레이(상시 점유 X). 프로젝트 전체 코멘트, 모든 팀원 작성. ──
//  저장: task_comment(task_id=프로젝트 id) — v6 에서 태스크=프로젝트행이라 /tasks/:id/comments·/detail 을 프로젝트 id 로 그대로 재사용.
function openProjectComments(id, members) {
    const nameOf = (uid) => { const m = (members || []).find((x) => x.member_id === uid); return (m && m.display_name) || uid || '?'; };
    const panel = el('aside', { class: 'cmt-drawer', role: 'dialog', 'aria-label': '코멘트' });
    const back = el('div', { class: 'cmt-backdrop' }, panel);
    let closed = false;
    const close = () => { if (closed)
        return; closed = true; back.classList.remove('open'); document.removeEventListener('keydown', onEsc); setTimeout(() => back.remove(), 220); };
    const onEsc = (e) => { if (e.key === 'Escape')
        close(); };
    back.addEventListener('mousedown', (e) => { if (e.target === back)
        close(); });
    document.addEventListener('keydown', onEsc);
    let feedData = [];
    let newestFirst = false; // 기본 오래된→최신(최신이 아래, 작성칸 옆) — 이미지와 동일
    let query = '';
    let threadParent = null; // null=메인 피드, 숫자=해당 최상위 댓글의 스레드 보기
    const repliesOf = (pid) => feedData.filter((f) => f && f.kind === 'comment' && f.reply_to != null && Number(f.reply_to) === Number(pid));
    // 헤더 SVG 아이콘 헬퍼
    const hico = (...kids) => sv('svg', { viewBox: '0 0 24 24', width: '17', height: '17', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ...kids);
    // 작성칸(하단) — 크고 편한 입력 + 파란 전송(이미지 참고).
    const ta = el('textarea', { class: 'cmt-input', placeholder: '댓글을 입력하세요…' });
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(Math.max(ta.scrollHeight, 56), 220) + 'px'; };
    ta.addEventListener('input', grow);
    const sendBtn = el('button', { class: 'cmt-send pjv-tm-send', type: 'button', title: '보내기 (⌘/Ctrl+Enter)' }, hico(sv('path', { d: 'M22 2L11 13' }), sv('path', { d: 'M22 2l-7 20-4-9-9-4 20-7z' })));
    // 커서 위치 삽입(멘션·이모지·첨부·체크리스트). 태스크 모달 작성기 툴바와 동일 동작.
    const insertAtCursor = (text) => {
        const s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
        const e = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
        const pos = s + text.length;
        ta.focus();
        try {
            ta.setSelectionRange(pos, pos);
        }
        catch (_) { /* noop */ }
        grow();
    };
    // 태스크 팝업 Activity 작성기 툴바 그대로 재사용 — ＋·Comment▾·📎·@·😊·✓·🎥·🎤·⋯ · ➤. 첨부는 이 프로젝트 공유 폴더.
    const composer = el('div', { class: 'cmt-composer' }, ta, pjvtmComposerToolbar({ insertAtCursor, members, sendBtn, d: { project: { id } } }));
    const feedBox = el('div', { class: 'cmt-feed' }, el('div', { class: 'cmt-empty', text: '불러오는 중…' }));
    const reactTo = async (c, emoji) => {
        try {
            const d = await api('/api/ui/v6/comments/' + c.id + '/reactions', { method: 'POST', body: JSON.stringify({ emoji }) });
            c.reactions = (d && d.reactions) || [];
            renderFeed();
        }
        catch (e) {
            toast('반응 실패 — ' + e.message, true);
        }
    };
    // 댓글 카드 1개 — 최상위/답글 공용. isReply=true 면 답글 스타일(들여쓰기).
    function commentCard(c, isReply) {
        const who = c.display_name || nameOf(c.actor);
        // 👍 좋아요(아웃라인 아이콘 + 개수) — 내가 눌렀으면 .on. 그 외 이모지 반응은 칩으로.
        const like = (c.reactions || []).filter((r) => r.emoji === '👍')[0];
        const likeBtn = el('button', { class: 'cmt-foot-btn cmt-like' + (like && like.mine ? ' on' : ''), type: 'button', title: '좋아요' }, sv('svg', { viewBox: '0 0 24 24', width: '15', height: '15', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, sv('path', { d: 'M7 10v11' }), sv('path', { d: 'M7 10l4-7a2 2 0 0 1 2.6 2.5L12.5 9H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 21H7' })));
        if (like)
            likeBtn.append(el('span', { class: 'cmt-like-n', text: String(like.count) }));
        likeBtn.onclick = () => reactTo(c, '👍');
        const reactRow = el('span', { class: 'cmt-react' }, likeBtn, ...(c.reactions || []).filter((r) => r.emoji !== '👍').map((r) => {
            const ch = el('button', { class: 'cmt-react-chip' + (r.mine ? ' mine' : ''), type: 'button', text: r.emoji + ' ' + r.count });
            ch.onclick = () => reactTo(c, r.emoji);
            return ch;
        }));
        const replyBtn = el('button', { class: 'cmt-foot-btn cmt-reply', type: 'button', text: '답글' });
        replyBtn.onclick = () => {
            if (threadParent != null) {
                ta.value = (ta.value ? ta.value.replace(/\s*$/, ' ') : '') + '@' + who + ' ';
                ta.focus();
                grow();
            }
            else
                openThread(c.id); // 메인 피드 → 스레드 열기
        };
        const bodyKids = [
            el('div', { class: 'cmt-meta' }, el('span', { class: 'cmt-name', text: who }), el('span', { class: 'cmt-time', text: c.ts ? '· ' + relTime(c.ts) : '' })),
            el('div', { class: 'cmt-text md-rendered' }, renderMarkdown(c.body || '')),
            el('div', { class: 'cmt-foot' }, reactRow, replyBtn),
        ];
        // 메인 피드의 최상위 카드에만 'N개의 답글' 칩 — 클릭 시 스레드 보기. (스레드 안에서는 표시 안 함)
        if (!isReply && threadParent == null) {
            const reps = repliesOf(c.id);
            if (reps.length) {
                const seen = {};
                const avas = [];
                for (const r of reps) {
                    const k = r.actor || r.display_name;
                    if (seen[k] || avas.length >= 3)
                        continue;
                    seen[k] = 1;
                    const rw = r.display_name || nameOf(r.actor);
                    avas.push(el('span', { class: 'cmt-thread-pill-ava', style: 'background:' + avatarColor(r.actor || rw), text: initials(rw) }));
                }
                const last = reps[reps.length - 1];
                const pill = el('button', { class: 'cmt-thread-pill', type: 'button' }, el('span', { class: 'cmt-thread-pill-avas' }, ...avas), el('span', { class: 'cmt-thread-pill-n', text: reps.length + '개의 답글' }), el('span', { class: 'cmt-thread-pill-time', text: last && last.ts ? '· 마지막 ' + relTime(last.ts) : '' }));
                pill.onclick = () => openThread(c.id);
                bodyKids.splice(bodyKids.length - 1, 0, pill); // 푸터(👍/답글) '위'에 답글 칩을 둔다(맨 아래로 빠져 어색하던 것 수정).
            }
        }
        // 카드 우상단 호버 액션(클릭업식) — 반응(이모지)·링크 복사·답글. (수정/삭제는 백엔드 엔드포인트가 없어 제외.)
        const act = (title, icon, fn) => { const b = el('button', { class: 'cmt-act', type: 'button', title }, icon); b.onclick = (e) => { e.stopPropagation(); fn(b); }; return b; };
        const emojiIco = hico(sv('circle', { cx: 12, cy: 12, r: 8.5 }), sv('path', { d: 'M8.5 14a4 4 0 0 0 7 0' }), sv('circle', { cx: 9, cy: 10, r: .9, fill: 'currentColor', stroke: 'none' }), sv('circle', { cx: 15, cy: 10, r: .9, fill: 'currentColor', stroke: 'none' }));
        const linkIco = hico(sv('path', { d: 'M10 13a4.5 4.5 0 0 0 6.4 0l2-2a4.5 4.5 0 1 0-6.4-6.4l-1.1 1.1' }), sv('path', { d: 'M14 11a4.5 4.5 0 0 0-6.4 0l-2 2a4.5 4.5 0 1 0 6.4 6.4l1.1-1.1' }));
        const replyIco = hico(sv('path', { d: 'M9 17l-5-5 5-5' }), sv('path', { d: 'M4 12h11a5 5 0 0 1 5 5v1' }));
        const REACT_EMOJIS = ['👍', '❤️', '😄', '🎉', '👀', '🙏'];
        const actions = el('div', { class: 'cmt-actions' }, act('반응', emojiIco, (b) => { const pop = el('div', { class: 'cmt-emoji-pop' }); const closePop = pjvPopover(b, pop); REACT_EMOJIS.forEach((em) => { const eb = el('button', { class: 'cmt-emoji-opt', type: 'button', text: em }); eb.onclick = () => { closePop(); reactTo(c, em); }; pop.append(eb); }); }), act('링크 복사', linkIco, () => { const url = location.origin + location.pathname + location.search + '#cmt-' + c.id; try {
            if (navigator.clipboard)
                navigator.clipboard.writeText(url).then(() => toast('링크를 복사했어요')).catch(() => toast('복사 실패', true));
            else
                toast('복사 실패', true);
        }
        catch (_) {
            toast('복사 실패', true);
        } }), act('답글', replyIco, () => replyBtn.onclick()));
        return el('div', { class: 'cmt-card' + (isReply ? ' cmt-reply-card' : '') }, el('span', { class: 'cmt-ava', style: 'background:' + avatarColor(c.actor || who), text: initials(who) }), el('div', { class: 'cmt-body' }, ...bodyKids), actions);
    }
    function openThread(pid) { threadParent = pid; query = ''; if (searchBar) {
        searchBar.hidden = true;
        searchBtn.classList.remove('on');
        searchIn.value = '';
    } renderFeed(); setTimeout(() => ta.focus(), 0); }
    // 헤더/작성칸을 현재 모드(메인 피드 vs 스레드)에 맞춰 갱신.
    function renderHead() {
        const inThread = threadParent != null;
        if (backBtn)
            backBtn.hidden = !inThread;
        if (headTitle)
            headTitle.textContent = inThread ? '스레드' : '활동';
        if (sortBtn)
            sortBtn.hidden = inThread;
        if (searchBtn)
            searchBtn.hidden = inThread;
        ta.placeholder = inThread ? '답글을 입력하세요…' : '댓글을 입력하세요…';
    }
    function renderFeed() {
        renderHead();
        feedBox.replaceChildren();
        if (threadParent != null) { // ── 스레드 보기: 부모 + 답글들 ──
            const parent = feedData.find((f) => f && f.kind === 'comment' && Number(f.id) === Number(threadParent));
            if (!parent) {
                threadParent = null;
                renderFeed();
                return;
            }
            feedBox.append(commentCard(parent, false));
            const reps = repliesOf(threadParent).slice().sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
            feedBox.append(reps.length
                ? el('div', { class: 'cmt-thread-replies' }, ...reps.map((r) => commentCard(r, true)))
                : el('div', { class: 'cmt-thread-empty', text: '첫 답글을 남겨보세요.' }));
            setTimeout(() => { feedBox.scrollTop = feedBox.scrollHeight; }, 0);
            return;
        }
        // ── 메인 피드: 최상위 댓글만(reply_to 없음) ──
        let comments = feedData.filter((f) => f && f.kind === 'comment' && f.reply_to == null);
        if (query)
            comments = comments.filter((c) => (c.body || '').toLowerCase().includes(query) || (c.display_name || nameOf(c.actor) || '').toLowerCase().includes(query));
        if (newestFirst)
            comments = comments.slice().reverse();
        if (!comments.length) {
            feedBox.append(el('div', { class: 'cmt-empty', text: query ? '검색 결과가 없어요.' : '아직 코멘트가 없어요. 아래에서 첫 코멘트를 남겨보세요.' }));
            return;
        }
        for (const c of comments)
            feedBox.append(commentCard(c, false));
        if (!newestFirst && !query)
            setTimeout(() => { feedBox.scrollTop = feedBox.scrollHeight; }, 0); // 오래된순 → 최신이 아래, 바닥으로
    }
    const send = async () => {
        const text = ta.value.trim();
        if (!text)
            return;
        sendBtn.disabled = true;
        ta.disabled = true;
        const payload = { text };
        if (threadParent != null)
            payload.parent_id = threadParent; // 스레드 답글
        try {
            const d = await api('/api/ui/v6/tasks/' + id + '/comments', { method: 'POST', body: JSON.stringify(payload) });
            ta.value = '';
            grow();
            feedData = (d && d.feed) || [];
            renderFeed();
            if (threadParent == null && newestFirst)
                feedBox.scrollTop = 0;
        }
        catch (e) {
            toast('전송 실패 — ' + e.message, true);
        }
        sendBtn.disabled = false;
        ta.disabled = false;
        ta.focus();
    };
    sendBtn.onclick = send;
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        send();
    } });
    // 헤더 — '코멘트' + 정렬·검색 토글(보이는 버튼은 기능까지) + 닫기.
    const sortBtn = el('button', { class: 'cmt-hbtn', type: 'button', title: '정렬: 오래된순' }, hico(sv('path', { d: 'M7 4v15M7 4L4 8M7 4l3 4' }), sv('path', { d: 'M17 20V5M17 20l-3-4M17 20l3-4' })));
    sortBtn.onclick = () => { newestFirst = !newestFirst; sortBtn.classList.toggle('on', newestFirst); sortBtn.title = newestFirst ? '정렬: 최신순' : '정렬: 오래된순'; renderFeed(); };
    const searchIn = el('input', { type: 'text', class: 'cmt-search-in', placeholder: '코멘트 검색…' });
    searchIn.addEventListener('input', () => { query = searchIn.value.trim().toLowerCase(); renderFeed(); });
    const searchBar = el('div', { class: 'cmt-search', hidden: true }, searchIn);
    const searchBtn = el('button', { class: 'cmt-hbtn', type: 'button', title: '검색' }, hico(sv('circle', { cx: 11, cy: 11, r: 7 }), sv('path', { d: 'M21 21l-4.3-4.3' })));
    searchBtn.onclick = () => { const willOpen = searchBar.hidden; searchBar.hidden = !willOpen; searchBtn.classList.toggle('on', willOpen); if (willOpen)
        searchIn.focus();
    else {
        query = '';
        searchIn.value = '';
        renderFeed();
    } };
    // 스레드 보기 → 메인 피드로 돌아가는 뒤로 버튼(메인에서는 숨김).
    const backBtn = el('button', { class: 'cmt-hbtn cmt-back', type: 'button', title: '뒤로', hidden: true }, hico(sv('path', { d: 'M15 18l-6-6 6-6' })));
    backBtn.onclick = () => { threadParent = null; renderFeed(); };
    const headTitle = el('h3', { text: '활동' });
    const head = el('div', { class: 'cmt-head' }, backBtn, headTitle, el('div', { class: 'cmt-head-actions' }, sortBtn, searchBtn, el('button', { class: 'cmt-close', type: 'button', title: '닫기 (Esc)', text: '✕', onclick: close })));
    panel.append(head, searchBar, feedBox, composer);
    document.body.append(back);
    requestAnimationFrame(() => { back.classList.add('open'); grow(); });
    (async () => {
        try {
            const d = await api('/api/ui/v6/projects/' + id + '/comments');
            feedData = (d && d.feed) || [];
            renderFeed();
            // 드로어를 열어 읽었으니 마지막 읽음 id 갱신(가장 최신 코멘트 id) — 섹션 안읽음 배지 해제.
            const cs = feedData.filter((f) => f && f.kind === 'comment');
            const mx = Math.max(0, ...cs.map((c) => Number(c.id) || 0));
            if (mx)
                localStorage.setItem('pjv_cmt_read_' + id, String(mx));
        }
        catch (e) {
            feedBox.replaceChildren(el('div', { class: 'cmt-empty', text: '불러오지 못했습니다 — ' + e.message }));
        }
    })();
    setTimeout(() => ta.focus(), 180);
}
// ── 프로젝트 세부 설정 팝업 — 팀원 · 분류 · 레포 · 규칙 · 삭제. 헤더 '⚙ 프로젝트 세부 설정'에서 연다. ──
//  (필요/산출 지식은 본문 아래 '지식 흐름' 섹션으로 이관 — #245.)
//  (참고 파일 블록 제거 — 본문 '공유 폴더' 브라우저와 중복이라 거기로 일원화 — #246.)
//  (상태 블록 제거 — 상세 메타 패널의 상태 필드(pjvProjStatusPill, 클릭해 3단계 변경) + 대시보드·목록·일괄바와
//   중복이고 모달 토글은 2단계뿐이라 더 약했다 — #246.)
//  (삭제·팀원 수정을 헤더에서 여기로 이관 — 헤더는 제목/상태칩/설정 버튼만.)
function openProjectSettings(id, p, reload, meId, base) {
    const B = base || '/api/ui/v6/projects/';
    const back = overlayBox('프로젝트 세부 설정', el('div', { class: 'proj-settings' }));
    const box = back.querySelector('.ov-box');
    if (box)
        box.classList.add('ov-box-wide');
    const closeAndReload = () => { back.remove(); reload(); }; // 변경하면 팝업 닫고 상세 재렌더
    back.querySelector('.proj-settings').append(projectMembersBlock(id, p, closeAndReload, B), projectCategoryBlock(id, p), projectReposBlock(id, p), projectRulesBlock(id), 
    // (필요/산출 지식 블록은 본문 아래 '지식 흐름' 섹션 projectKnowledgeSection 으로 이관 — #245.)
    // (참고 파일 블록은 본문 '공유 폴더' 섹션으로 일원화 — #246. 상태 블록은 메타 패널 상태 필드로 일원화 — #246.)
    projectDangerBlock(id, p, meId, back));
}
// ── '내 컴퓨터에서 작업' 모달 — 담당자가 본인 PC에서 이 프로젝트를 작업하도록 시작 명령을 만들어 준다. ──
//  웹은 원격 PC 터미널을 보지 않는다(스트리밍 X). 각자 자기 PC에서 터미널을 열어 쓰고, 웹은 '어떻게 시작하는지'만
//  쉽고 상세히 안내한다. 모달에서 레포·경로·워크트리·하네스를 고르면 `node ~/.lively/work.mjs <id> …` 한 줄을
//  로컬에서 만들어 준다(renderLocalWorkCommand) — work.mjs 가 공유폴더 pull·레포·.lively 마커·실행까지 자동.
function openLocalWorkModal(id, p) {
    const form = el('div', { class: 'proj-settings lw' });
    const back = overlayBox('💻 내 컴퓨터에서 작업 — ' + p.name, form);
    const box = back.querySelector('.ov-box');
    if (box)
        box.classList.add('ov-box-wide');
    const inputStyle = 'width:100%;padding:6px 8px;font:inherit;box-sizing:border-box';
    const block = (title, hint, ...controls) => el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: title }), hint ? el('p', { class: 'ps-block-hint', text: hint }) : null, ...controls);
    // 하네스
    const harnessSel = el('select', { style: inputStyle });
    harnessSel.append(el('option', { value: 'claude', text: 'Claude Code' }), el('option', { value: 'codex', text: 'Codex' }));
    // 모델 · 자동승인 — 웹 터미널 카탈로그(/api/ui/terminal/config) 재사용(하네스별 모델·autoApprove 동일 규칙).
    const modelSel = el('select', { style: inputStyle });
    const modelBlock = block('모델', '비우면 하네스 기본 모델.', modelSel);
    const autoChk = el('input', { type: 'checkbox' });
    const autoBlock = el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: '자동 승인' }), el('label', { style: 'display:flex;gap:8px;align-items:center;cursor:pointer' }, autoChk, el('span', { text: '권한 확인 건너뛰기 (claude --dangerously-skip-permissions / codex --yolo) — 내 PC에서 실행되니 주의' })));
    const harnessCat = {}; // {claude:{models:[...],hasAuto}, codex:{...}}
    const updateModels = () => {
        const cat = harnessCat[harnessSel.value] || { models: [], hasAuto: true };
        const cur = modelSel.value;
        modelSel.replaceChildren(el('option', { value: '', text: '기본' }));
        (cat.models || []).forEach((m) => { if (m)
            modelSel.append(el('option', { value: m, text: m })); });
        if ((cat.models || []).includes(cur))
            modelSel.value = cur;
        autoBlock.style.display = cat.hasAuto === false ? 'none' : '';
        regen();
    };
    harnessSel.addEventListener('change', updateModels);
    const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
    const pathKey = (repo) => 'lively:workpath:' + repo;
    const savedPath = (repo) => { try {
        return repo ? (localStorage.getItem(pathKey(repo)) || '') : '';
    }
    catch (_) {
        return '';
    } };
    modelSel.addEventListener('change', () => regen());
    autoChk.addEventListener('change', () => regen());
    // ── 레포 N개(반복 행) — 각 행: 레포 선택 + 내 PC 경로 + 워크트리/브랜치. cloneUrlByRepo 로 git 주소 채움. ──
    const cloneUrlByRepo = {};
    const reposWrap = el('div', {});
    let rows = [];
    const repoNames = () => Object.keys(cloneUrlByRepo);
    const fillSel = (sel) => {
        const cur = sel.value;
        sel.replaceChildren(el('option', { value: '', text: '— 코드 저장소 선택 —' }));
        repoNames().forEach((n) => sel.append(el('option', { value: n, text: n })));
        if (repoNames().includes(cur))
            sel.value = cur;
    };
    const addRow = (initRepo = '') => {
        const sel = el('select', { style: inputStyle });
        const pathInp = el('input', { type: 'text', style: inputStyle, placeholder: '예) ~/dev/<레포> · Windows: C:\\Users\\..\\<레포> (비우면 기본 경로에 clone)' });
        const wtChk = el('input', { type: 'checkbox' });
        wtChk.checked = true;
        const branchInp = el('input', { type: 'text', style: inputStyle, value: 'project/' + id });
        const rmBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '✕ 제거' });
        fillSel(sel);
        if (initRepo)
            sel.value = initRepo;
        pathInp.value = savedPath(sel.value);
        const branchWrap = el('div', { style: 'margin-top:6px' }, el('p', { class: 'ps-block-hint', style: 'margin:0 0 2px', text: '브랜치' }), branchInp);
        const branchVis = () => { branchWrap.style.display = wtChk.checked ? '' : 'none'; };
        const rowObj = { sel, pathInp, wtChk, branchInp };
        rows.push(rowObj);
        sel.addEventListener('change', () => { pathInp.value = savedPath(sel.value); regen(); });
        pathInp.addEventListener('input', () => regen());
        pathInp.addEventListener('change', () => { if (sel.value && pathInp.value.trim()) {
            try {
                localStorage.setItem(pathKey(sel.value), pathInp.value.trim());
            }
            catch (_) { /* */ }
        } regen(); });
        wtChk.addEventListener('change', () => { branchVis(); regen(); });
        branchInp.addEventListener('input', () => regen());
        const rowEl = el('section', { class: 'ps-block', style: 'border:1px solid rgba(127,127,127,.18);border-radius:8px;padding:10px;margin-top:8px' }, el('div', { style: 'display:flex;gap:8px;align-items:center' }, sel, rmBtn), el('div', { style: 'margin-top:6px' }, el('p', { class: 'ps-block-hint', style: 'margin:0 0 2px', text: '내 PC 경로' }), pathInp), el('label', { style: 'display:flex;gap:8px;align-items:center;cursor:pointer;margin-top:6px' }, wtChk, el('span', { text: '워크트리 생성 (전용 브랜치로 격리)' })), branchWrap);
        rowObj.el = rowEl;
        rmBtn.onclick = () => { rowEl.remove(); rows = rows.filter((r) => r !== rowObj); regen(); };
        branchVis();
        reposWrap.append(rowEl);
        regen();
    };
    const addRepoBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ 레포 추가', onclick: () => addRow() });
    // 카탈로그(모델·자동승인) 로드
    (async () => {
        try {
            const cfg = await api('/api/ui/terminal/config');
            ((cfg && cfg.harnesses) || []).forEach((h) => { const mf = (h.flags || []).find((f) => f.name === '--model'); harnessCat[h.key] = { models: (mf && mf.choices) || [], hasAuto: !!h.hasAutoApprove }; });
        }
        catch (_) { /* graceful */ }
        updateModels();
    })();
    // 레포 목록(git 주소 포함) 로드 → 행 셀렉트 채움 + 기본 1행.
    (async () => {
        try {
            const r = await api('/api/ui/repos');
            ((r && r.domainmapRepos) || []).forEach((it) => { if (it && it.name)
                cloneUrlByRepo[it.name] = it.clone_url || ''; });
        }
        catch (_) { /* graceful: 레포 없음 */ }
        rows.forEach((ro) => fillSel(ro.sel));
        if (!rows.length) {
            // 이 프로젝트에 매핑된 레포(관련 레포)를 기본 행으로 — 없으면 레포가 하나뿐일 때만 자동 선택.
            const pre = ((p && p.repos) || []).filter((n) => repoNames().includes(n));
            if (pre.length)
                pre.forEach((n) => addRow(n));
            else
                addRow(repoNames().length === 1 ? repoNames()[0] : '');
        }
        regen();
    })();
    // ── 명령 — 입력이 바뀔 때마다 자동 재생성(live). 0레포=공유폴더만 / 1=가독 플래그 / N=--repos base64. ──
    const guideWrap = el('div', { class: 'lw-guide' });
    function regen() {
        const parts = [id, '--harness ' + harnessSel.value];
        if (modelSel.value)
            parts.push('--model ' + modelSel.value);
        if (autoChk.checked)
            parts.push('--auto-approve');
        const specs = rows.map((r) => ({ name: r.sel.value, path: r.pathInp.value.trim(), worktree: r.wtChk.checked, branch: r.branchInp.value.trim(), gitUrl: r.sel.value ? (cloneUrlByRepo[r.sel.value] || '') : '' })).filter((s) => s.name);
        let hasUrl = true;
        if (specs.length === 1) {
            const s = specs[0];
            if (s.path)
                parts.push('--repo-path ' + q(s.path));
            if (s.worktree) {
                parts.push('--worktree');
                if (s.branch)
                    parts.push('--branch ' + q(s.branch));
            }
            if (s.gitUrl)
                parts.push('--git-url ' + q(s.gitUrl));
            else
                hasUrl = false;
        }
        else if (specs.length > 1) {
            const json = JSON.stringify(specs);
            parts.push('--repos ' + q(btoa(unescape(encodeURIComponent(json))))); // base64(UTF-8 JSON) — N레포 안전 인코딩
            hasUrl = specs.every((s) => !!s.gitUrl);
        }
        renderLocalWorkCommand(guideWrap, parts.join(' '), { repo: specs.length ? specs[0].name : '', hasUrl, multi: specs.length > 1 });
    }
    form.append(el('p', { class: 'ps-block-hint', text: '값을 바꾸면 아래 명령이 자동으로 갱신됩니다. 내 PC 터미널에 붙여넣어 실행하세요 — 한 번 실행하면 공유 폴더·코드 준비·실행까지 자동, 재실행해도 안전(늘 이 명령으로 접속).' }), block('AI 코딩 에이전트', '내 PC에서 사용할 하네스를 고르세요.', harnessSel), modelBlock, autoBlock, block('사용할 레포 (여러 개 가능)', '코드 레포를 선택하고 내 PC 경로를 적으세요. 비개발자는 레포 행을 모두 제거하면 공유 폴더만 받습니다.', reposWrap, el('div', { style: 'margin-top:8px' }, addRepoBtn)), guideWrap);
    regen();
}
// 클립보드 복사 — http(비보안 컨텍스트)에선 navigator.clipboard 가 막히므로 execCommand 폴백 + 수동선택 안내.
function copyText(text) {
    const fallback = () => {
        try {
            const t = document.createElement('textarea');
            t.value = text;
            t.style.position = 'fixed';
            t.style.top = '-1000px';
            t.style.opacity = '0';
            document.body.appendChild(t);
            t.focus();
            t.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(t);
            toast(ok ? '복사됨' : '복사 실패 — 명령을 직접 드래그해 복사하세요', !ok);
        }
        catch (_) {
            toast('복사 실패 — 명령을 직접 드래그해 복사하세요', true);
        }
    };
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => toast('복사됨'), fallback);
            return;
        }
    }
    catch (_) { /* */ }
    fallback();
}
// 만든 명령을 OS별(Mac/Linux · Windows)로 렌더 — work.mjs 경로의 홈 표기가 셸마다 달라서(윈도우는 ~ 미확장).
function renderLocalWorkCommand(wrap, argStr, info) {
    const cmdNix = 'node ~/.lively/work.mjs ' + argStr;
    const cmdWin = 'node "$env:USERPROFILE\\.lively\\work.mjs" ' + argStr;
    const cmdBlock = (label, cmd) => {
        const copyBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '복사' });
        copyBtn.onclick = () => copyText(cmd);
        return el('div', { style: 'margin-top:8px' }, el('p', { class: 'ps-block-hint', style: 'margin:0 0 4px', text: label }), el('div', { style: 'display:flex;gap:8px;align-items:flex-start' }, el('pre', { style: 'flex:1;margin:0;padding:8px 10px;background:rgba(127,127,127,.1);border-radius:6px;overflow:auto;font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;line-height:1.5;user-select:all' }, el('code', { text: cmd })), copyBtn));
    };
    const notes = ['내 OS에 맞는 한 줄을 터미널에 붙여넣어 실행하세요. (Node 필요)'];
    if (info && info.repo && !info.hasUrl)
        notes.push('※ 이 레포는 git 주소 미설정 — --git-url 없음. 입력 경로에 레포가 이미 있어야 함(없으면 관리탭 ▸ 레포(git) 관리에서 git 주소 연결).');
    notes.push('복사가 안 되면(보안 컨텍스트 아님) 명령을 직접 드래그해 복사하세요.');
    wrap.replaceChildren(el('div', { style: 'margin-top:14px;border-top:1px solid rgba(127,127,127,.18);padding-top:12px' }, el('h3', { class: 'ps-block-title', text: '내 PC에서 실행' }), cmdBlock('Mac / Linux', cmdNix), cmdBlock('Windows (PowerShell)', cmdWin), ...notes.map((n) => el('p', { class: 'ps-block-hint', text: n }))));
}
// 팀원 블록 — 현재 팀원 칩 + '팀원 수정'(멀티선택 오버레이). 저장 시 설정 팝업 닫고 상세 재렌더.
function projectMembersBlock(id, p, closeAndReload, base) {
    const members = p.members || [];
    const chips = el('div', { class: 'proj-team-row' });
    if (members.length) {
        for (const m of members)
            chips.append(el('span', { class: 'proj-team-chip' }, el('span', { class: 'proj-team-ava', style: 'background:' + avatarColor(m.member_id), text: initials(m.display_name || m.member_id) }), el('span', { text: m.display_name || (m.member_id + (m.role ? ' · ' + m.role : '')) })));
    }
    else {
        chips.append(el('span', { class: 'admin-hint', text: '아직 팀원이 없어요' }));
    }
    return el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: '팀원' }), el('p', { class: 'ps-block-hint', text: '이 프로젝트를 함께 보고 작업할 팀원이에요.' }), chips, el('div', { class: 'ps-rules-actions' }, el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '팀원 수정',
        onclick: () => openMembersEdit(id, members.map((m) => m.member_id), closeAndReload, base) })));
}
// 삭제 블록 — 작성자 본인만 노출(서버도 403 재검증). 확인 후 삭제 → 팝업 닫고 목록으로.
function projectDangerBlock(id, p, meId, back) {
    // 삭제 전원 개방(#280) — 인증된 누구나(서버도 인증만 요구). 삭제는 #/trash 에서 복원 가능.
    const delBtn = el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: '프로젝트 삭제' });
    delBtn.onclick = async () => {
        if (!confirm('프로젝트 ‘' + p.name + '’을(를) 삭제할까요?\n\n프로젝트와 그 작업(태스크·하위)이 함께 사라집니다(되돌릴 수 없음). 연결된 지식은 보존됩니다.'))
            return;
        delBtn.disabled = true;
        try {
            await api('/api/ui/v6/projects/' + id + '/delete', { method: 'POST' });
            toast('프로젝트를 삭제했습니다');
            back.remove();
            location.hash = '#/projects2';
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            delBtn.disabled = false;
        }
    };
    return el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: '프로젝트 삭제' }), el('p', { class: 'ps-block-hint', text: '프로젝트와 그 안의 모든 태스크가 영구 삭제됩니다(되돌릴 수 없음). 연결된 지식은 보존돼요.' }), el('div', { class: 'ps-rules-actions' }, delBtn));
}
// (상태 블록 제거 — #246. 상태 변경은 상세 메타 패널의 상태 필드(pjvProjStatusPill, 클릭→할 일/진행 중/완료 3단계)
//  + 대시보드 보드·목록 뷰·행 ⋯ 메뉴·일괄작업 바 어디서든 가능. 모달 토글은 2단계뿐이라 더 약했고 중복이었다.)
// 규칙 블록 — 프로젝트 AGENTS.md 의 '규칙' 영역만 편집(나머지 digest 는 서버가 자동 생성). /rules 엔드포인트로 로드/저장.
//  AGENTS.md 는 Codex 가 네이티브 로드, CLAUDE.md 는 `@AGENTS.md` 한 줄로 Claude Code 가 끌어옴(서버가 함께 관리).
function projectRulesBlock(id) {
    const url = '/api/ui/v6/projects/' + id + '/rules';
    const ta = el('textarea', { class: 'ps-rules-ta', rows: '8', disabled: '',
        placeholder: '이 프로젝트에서 AI가 지켰으면 하는 걸 편하게 적으세요. 예)\n· 새로 만들기 전에 비슷한 게 이미 있는지 먼저 찾아본다.\n· 큰 변경이나 삭제는 진행하기 전에 꼭 먼저 물어본다.\n· 자료를 만들 땐 근거와 출처를 같이 적는다.\n· 안 되는 건 안 된다고 솔직히 말한다.' });
    const status = el('span', { class: 'ps-save-status admin-hint', text: '불러오는 중…' });
    const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '규칙 저장', disabled: '' });
    (async () => {
        try {
            const d = await api(url);
            ta.value = (d && d.rules) || '';
        }
        catch (_) {
            ta.value = '';
        }
        ta.disabled = false;
        saveBtn.disabled = false;
        status.textContent = '';
    })();
    saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        status.textContent = '저장 중…';
        try {
            await api(url, { method: 'POST', body: JSON.stringify({ rules: ta.value }) });
            status.textContent = '저장됨 · 다음 세션부터 적용';
            toast('프로젝트 규칙을 저장했습니다');
        }
        catch (e) {
            status.textContent = '';
            toast('저장 실패 — ' + e.message, true);
        }
        saveBtn.disabled = false;
    };
    return el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: '프로젝트 규칙' }), el('p', { class: 'ps-block-hint', text: '이 프로젝트에서 터미널 세션을 열면, 여기 적은 규칙이 그 AI에게 자동으로 주입됩니다. (프로젝트 폴더의 AGENTS.md 규칙 영역으로 저장)' }), ta, el('div', { class: 'ps-rules-actions' }, saveBtn, status));
}
// 관련 레포 블록 — 이 프로젝트에 매핑할 git 레포(여러 개). AGENTS.md '관련 레포' + '내 컴퓨터에서 작업' 모달 기본값에 쓰임.
//  경로는 저장하지 않는다(머신마다 달라 — 로컬 경로는 .lively/project.json). 여기선 레포 '이름'만 매핑.
function projectReposBlock(id, p) {
    const saved = new Set((p && p.repos) || []);
    const listEl = el('div', { class: 'ps-refs-list' });
    const status = el('span', { class: 'ps-save-status admin-hint' });
    const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '관련 레포 저장', disabled: '' });
    const checks = []; // [{name, input}]
    function paint(names) {
        if (!names.length) {
            listEl.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '등록된 레포가 없어요. 관리탭 ▸ 레포(git) 관리에서 먼저 추가하세요.' }));
            return;
        }
        checks.length = 0;
        listEl.replaceChildren(...names.map((n) => {
            const cb = el('input', { type: 'checkbox' });
            if (saved.has(n))
                cb.checked = true;
            checks.push({ name: n, input: cb });
            return el('label', { class: 'ps-refs-row', style: 'cursor:pointer' }, cb, el('span', { class: 'ps-refs-nm', text: n, title: n }));
        }));
    }
    (async () => {
        let names = [];
        try {
            const r = await api('/api/ui/repos');
            names = ((r && r.domainmapRepos) || []).filter((it) => it && it.name && !it.deprecated).map((it) => it.name);
        }
        catch (_) { /* */ }
        // 저장됐지만 목록에 없는(폐기된) 레포도 노출 — 체크 해제로 정리 가능.
        for (const n of saved)
            if (!names.includes(n))
                names.push(n);
        paint(names.sort());
        saveBtn.disabled = false;
    })();
    saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        status.textContent = '저장 중…';
        try {
            const repos = checks.filter((c) => c.input.checked).map((c) => c.name);
            await api('/api/ui/v6/projects/' + id + '/repos', { method: 'POST', body: JSON.stringify({ repos }) });
            status.textContent = '저장됨';
            toast('관련 레포를 저장했습니다');
        }
        catch (e) {
            status.textContent = '';
            toast('저장 실패 — ' + e.message, true);
        }
        saveBtn.disabled = false;
    };
    return el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: '관련 레포' }), el('p', { class: 'ps-block-hint', text: '이 프로젝트가 쓰는 git 레포를 고르세요. ‘내 컴퓨터에서 작업’ 모달의 기본값이 되고, AGENTS.md 에 함께 적힙니다. (로컬 경로는 각 PC 의 .lively/project.json 에만 저장)' }), listEl, el('div', { class: 'ps-rules-actions' }, saveBtn, status));
}
// ── 카테고리 멀티선택 피커 — 사업/제품/시스템(space)별 그룹 + 체크박스. 비동기 로드. { box, getSelected() } 반환. ──
//  생성 모달·세부설정 양쪽에서 재사용. selectedIds 는 미리 체크할 카테고리 id 배열.
function categoryPicker(selectedIds) {
    const sel = new Set((selectedIds || []).map(Number));
    const box = el('div', { style: 'max-height:220px;overflow:auto;border:1px solid rgba(127,127,127,.18);border-radius:8px;padding:8px' });
    box.append(el('div', { class: 'admin-hint', text: '불러오는 중…' }));
    const checks = []; // [{id, input}]
    (async () => {
        let cats = [];
        try {
            cats = await api('/api/ui/categories').then((d) => (d && d.categories) || []);
        }
        catch (_) { /* */ }
        if (!cats.length) {
            box.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '등록된 카테고리가 없어요. 관리탭 ▸ 분류 체계 관리에서 먼저 만드세요.' }));
            return;
        }
        const bySpace = {};
        for (const c of cats)
            (bySpace[c.space] = bySpace[c.space] || []).push(c);
        const kids = [];
        for (const sp of ['business', 'product', 'system']) {
            const list = bySpace[sp];
            if (!list || !list.length)
                continue;
            kids.push(el('div', { class: 'eyebrow', style: 'margin:6px 0 2px', text: SPACE_LABEL[sp] || sp }));
            for (const c of list) {
                const cb = el('input', { type: 'checkbox' });
                if (sel.has(Number(c.id)))
                    cb.checked = true;
                checks.push({ id: Number(c.id), input: cb });
                kids.push(el('label', { style: 'display:flex;gap:8px;align-items:center;cursor:pointer;padding:2px 2px' }, cb, el('span', { text: c.name || c.key, title: (SPACE_LABEL[c.space] || c.space) + ' · ' + (c.key || '') })));
            }
        }
        box.replaceChildren(...kids);
    })();
    return { box, getSelected: () => checks.filter((c) => c.input.checked).map((c) => c.id) };
}
// ── 레포 멀티선택 피커 — 레포 레지스트리(관리탭 ▸ 레포 관리)의 비폐기 레포 체크박스. 비동기 로드. { box, getSelected() } 반환. ──
//  생성 모달에서 사용(이름만 매핑 — 경로는 각 PC 의 .lively/project.json). selectedNames 는 미리 체크할 레포 이름.
function repoPicker(selectedNames) {
    const sel = new Set(selectedNames || []);
    const box = el('div', { style: 'max-height:160px;overflow:auto;border:1px solid rgba(127,127,127,.18);border-radius:8px;padding:8px' });
    box.append(el('div', { class: 'admin-hint', text: '불러오는 중…' }));
    const checks = []; // [{name, input}]
    (async () => {
        let names = [];
        try {
            const r = await api('/api/ui/repos');
            names = ((r && r.domainmapRepos) || []).filter((it) => it && it.name && !it.deprecated).map((it) => it.name);
        }
        catch (_) { /* */ }
        for (const n of sel)
            if (!names.includes(n))
                names.push(n); // 저장됐지만 목록에 없는 것도 노출
        names.sort();
        if (!names.length) {
            box.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '등록된 레포가 없어요. 관리탭 ▸ 레포(git) 관리에서 먼저 추가하세요.' }));
            return;
        }
        box.replaceChildren(...names.map((n) => {
            const cb = el('input', { type: 'checkbox' });
            if (sel.has(n))
                cb.checked = true;
            checks.push({ name: n, input: cb });
            return el('label', { style: 'display:flex;gap:8px;align-items:center;cursor:pointer;padding:2px 2px' }, cb, el('span', { text: n, title: n }));
        }));
    })();
    return { box, getSelected: () => checks.filter((c) => c.input.checked).map((c) => c.name) };
}
// ── 분류(영역) 단일선택 피커 — 새 프로젝트 모달용. 영역(=project-list) 목록을 그 자리에서 fetch. ──
//  '한 목록'·'상태' 뷰처럼 영역 맥락이 없는 곳에서 만들 때도 모달에서 영역을 정하게 해 미분류 프로젝트가 무심코 생기지 않게 한다(#337).
//  반환 { box, ready, getSelected() }. getSelected → { ok, listId }:
//   ok=false → 영역이 있는데 아직 미선택(검증에서 막음) · listId=null → 명시적 '기타(미분류)' · 그 외 → 선택한 영역 id.
//  selectedListId 가 주어지면(특정 영역 추가행에서 연 경우) 그 영역을 미리 선택 — 기존 동작 유지.
function listPicker(selectedListId) {
    const sel = el('select', { class: 'pjv-listpick-sel', 'aria-label': '분류(폴더)' });
    sel.append(el('option', { value: '', text: '불러오는 중…' }));
    sel.disabled = true;
    const box = el('div', { class: 'pjv-listpick' }, sel);
    let loaded = []; // 로드된 영역(없으면 미분류 강제 불가 — 첫 프로젝트 부트스트랩)
    let prevValue = ''; // '＋ 새 영역' 선택 시 되돌릴 직전 값
    const sortLists = (a, b) => (a.sort - b.sort) || String(a.name).localeCompare(String(b.name));
    const rebuild = (lists, preferId) => {
        loaded = [...lists].sort(sortLists);
        const has = preferId != null && loaded.some((l) => String(l.id) === String(preferId));
        const opts = [];
        // 미리 선택할 영역이 없으면 placeholder — 영역이 있으면 '선택하세요'(검증에서 막힘), 없으면 '미분류로 생성'(허용).
        if (!has)
            opts.push(el('option', { value: '', text: loaded.length ? '폴더을 선택하세요…' : '폴더 없음 — 미분류로 생성' }));
        for (const l of loaded)
            opts.push(el('option', { value: 'L' + l.id, text: l.name }));
        opts.push(el('option', { value: '__none__', text: '기타 (미분류)' }));
        opts.push(el('option', { value: '__new__', text: '＋ 새 폴더 만들기…' }));
        sel.replaceChildren(...opts);
        sel.value = has ? ('L' + preferId) : '';
        prevValue = sel.value;
        sel.disabled = false;
    };
    const ready = api('/api/ui/v6/project-lists')
        .then((d) => (d && d.lists) || [])
        .catch(() => [])
        .then((lists) => rebuild(lists, selectedListId));
    sel.addEventListener('change', () => {
        if (sel.value === '__new__') {
            sel.value = prevValue; // 선택값 아님 — 즉시 되돌리고 영역 생성 폼을 띄운다.
            openListForm(null, undefined, { onCreated: (list) => { if (list && list.id != null)
                    rebuild([...loaded, list], list.id); } });
            return;
        }
        prevValue = sel.value;
    });
    return {
        box,
        ready,
        getSelected: () => {
            const v = sel.value;
            if (v === '__none__')
                return { ok: true, listId: null };
            if (v.charAt(0) === 'L')
                return { ok: true, listId: Number(v.slice(1)) };
            // placeholder('') — 영역이 있으면 미선택(차단), 하나도 없으면 미분류 허용(부트스트랩).
            return loaded.length ? { ok: false, listId: undefined } : { ok: true, listId: null };
        },
    };
}
// 카테고리 블록 — 이 프로젝트가 속한 카테고리(사업·제품·시스템) 멀티선택. 사업/제품/시스템 탭의 카테고리별 탐색에 쓰임.
function projectCategoryBlock(id, p) {
    const picker = categoryPicker(((p && p.categories) || []).map((c) => c.category_id));
    const status = el('span', { class: 'ps-save-status admin-hint' });
    const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '카테고리 저장' });
    saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        status.textContent = '저장 중…';
        try {
            await api('/api/ui/v6/projects/' + id + '/categories', { method: 'POST', body: JSON.stringify({ category_ids: picker.getSelected() }) });
            status.textContent = '저장됨';
            toast('카테고리를 저장했습니다');
        }
        catch (e) {
            status.textContent = '';
            toast('저장 실패 — ' + e.message, true);
        }
        saveBtn.disabled = false;
    };
    return el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: '카테고리 (사업·제품·시스템)' }), el('p', { class: 'ps-block-hint', text: '이 프로젝트가 속한 카테고리를 고르세요. 사업·제품·시스템 탭에서 카테고리별로 프로젝트를 훑을 때 쓰이고, AGENTS.md 메타데이터에도 함께 적힙니다.' }), picker.box, el('div', { class: 'ps-rules-actions' }, saveBtn, status));
}
// (참고 파일 블록 제거 — #246. 프로젝트 파일 업로드는 본문 '공유 폴더' 섹션(projectFolderSection)으로 일원화.
//  '공유 폴더'가 업로드·드래그앤드롭·붙여넣기·폴더 탐색을 모두 제공하므로 모달의 약식 업로더는 중복이었다.)
// 지식 연결(#317) — 위키검색·자동추천 두 모달을 하나로. 열면 추천(관련도순)이 먼저 뜨고, 검색하면 그 너머로 좁힌다.
//  연결 관계(필요/산출)는 칼럼에서 연 기본값을 따르되 라디오로 그 자리서 바꿀 수 있다(멘션 ≠ 항상 필요).
//  추천=project_recommend_knowledge_v6(벡터 #172), 검색=knowledge/search. 이미 연결된 건 클라이언트에서 제외.
function openKnowledgePicker(id, relation, linkedNames, onLinked) {
    const linked = new Set(linkedNames || []);
    let curRel = relation === 'produced' ? 'produced' : 'required'; // 라디오로 변경 가능.
    const searchIn = el('input', { type: 'search', class: 'proj-file-search', placeholder: '제목·내용으로 검색해 더 찾기…' });
    const recHead = el('div', { class: 'ps-kn-sec', text: '추천 · 이 프로젝트와 관련도순' });
    const results = el('div', { class: 'ps-kn-pick-results' });
    // 연결 관계 토글 — 기본은 연 칼럼. 바꾸면 이후 [연결]이 그 관계로 들어간다.
    const relName = 'pjk-rel-' + id;
    const mkRadio = (val, label) => {
        const inp = el('input', { type: 'radio', name: relName, value: val });
        if (val === curRel)
            inp.checked = true;
        inp.onchange = () => { if (inp.checked)
            curRel = val; };
        return el('label', { class: 'pjk-rel-opt' }, inp, el('span', { text: label }));
    };
    // '직접 작성'은 칼럼 버튼에서 빼 픽커 안으로 옮김(#317 정리) — 찾는 지식이 없을 때 그 관계 그대로 새 작성 페이지로.
    const createLink = el('a', { href: '#', style: 'margin-left:auto; font-size:12.5px; color:var(--blue); text-decoration:none; white-space:nowrap;', text: '＋ 직접 작성' });
    createLink.onclick = (e) => { e.preventDefault(); location.hash = '#/knowledge/new?project=' + id + '&relation=' + curRel; };
    const relRow = el('div', { class: 'pjk-rel-row' }, el('span', { class: 'admin-hint', text: '연결 관계' }), mkRadio('required', '필요'), mkRadio('produced', '산출'), createLink);
    overlayBox('지식 연결', el('div', { class: 'ps-kn-pick' }, searchIn, recHead, results, relRow));
    setTimeout(() => searchIn.focus(), 0);
    // 한 줄(추천·검색 공용). isRec 면 유사도/분류 뱃지를 제목 옆에.
    function pickRow(m, isRec) {
        const pct = Math.round((Number(m.similarity) || 0) * 100);
        const addBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 연결' });
        addBtn.onclick = async () => {
            addBtn.disabled = true;
            try {
                await api('/api/ui/v6/projects/' + id + '/knowledge', { method: 'POST', body: JSON.stringify({ name: m.name, relation: curRel }) });
                linked.add(m.name);
                addBtn.textContent = '연결됨';
                toast('연결했습니다');
                if (onLinked)
                    onLinked();
            }
            catch (e) {
                addBtn.disabled = false;
                toast('연결 실패 — ' + e.message, true);
            }
        };
        const tags = isRec ? el('span', { style: 'flex:none; display:inline-flex; gap:6px; align-items:baseline;' }, m.shares_category ? el('span', { class: 'kn-chip', title: '프로젝트와 같은 분류', text: '📁 같은 분류' }) : null, pct > 0 ? el('span', { class: 'admin-hint', title: '의미 유사도(코사인)', text: pct + '%' }) : null) : null;
        const titleEl = isRec
            ? el('div', { class: 'row-title', style: 'display:flex; justify-content:space-between; gap:8px; align-items:baseline;' }, el('span', { text: m.title || m.name }), tags)
            : el('div', { class: 'row-title', text: m.title || m.name });
        return el('div', { class: 'ps-kn-pick-row' }, el('a', { class: 'ps-kn-pick-main', href: '#/k/' + encodeURIComponent(m.name), target: '_blank', rel: 'noopener', title: '새 탭에서 지식 열기' }, titleEl, el('div', { class: 'admin-hint ps-kn-pick-snip', text: (m.snippet || '').slice(0, 90) })), addBtn);
    }
    async function loadRecs() {
        recHead.style.display = '';
        results.replaceChildren(el('span', { class: 'admin-hint', text: '추천을 불러오는 중…' }));
        let recs;
        try {
            recs = await api('/api/ui/v6/projects/' + id + '/recommend-knowledge?limit=10').then((d) => (d && d.entries) || []);
        }
        catch (e) {
            results.replaceChildren(errorNote(e, '추천을 불러오지 못했습니다'));
            return;
        }
        const cand = recs.filter((m) => !linked.has(m.name));
        if (!cand.length) {
            recHead.style.display = 'none';
            results.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '아직 추천할 지식이 없어요 — 위에서 제목·내용으로 검색하거나, 직접 작성해 보세요.' }));
            return;
        }
        results.replaceChildren(...cand.map((m) => pickRow(m, true)));
    }
    const runSearch = debounce(async () => {
        const q = searchIn.value.trim();
        if (!q) {
            loadRecs();
            return;
        } // 검색어 지우면 추천으로 복귀.
        recHead.style.display = 'none';
        results.replaceChildren(el('span', { class: 'admin-hint', text: '검색 중…' }));
        let matches;
        try {
            matches = await api('/api/ui/knowledge/search?q=' + encodeURIComponent(q) + '&limit=20').then((d) => (d && d.entries) || []);
        }
        catch (e) {
            results.replaceChildren(errorNote(e, '검색하지 못했습니다'));
            return;
        }
        const cand = matches.filter((m) => !linked.has(m.name));
        if (!cand.length) {
            results.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '결과가 없거나 모두 이미 연결됨.' }));
            return;
        }
        results.replaceChildren(...cand.map((m) => pickRow(m, false)));
    }, 300);
    searchIn.addEventListener('input', runSearch);
    loadRecs(); // 열면 추천 먼저.
}
// ════════════════════════════════════════════
// 태스크(클릭업형 리스트뷰) — 상태 그룹(할 일/진행 중/완료) + 컬럼(담당자·마감일·우선순위) + 인라인 편집.
//  상위 태스크만 상태로 그룹핑하고, 하위는 부모 아래 중첩(자기 상태는 점으로 표시하되 재그룹 안 함 — 클릭업 동형).
//  모든 필드 편집은 POST /api/ui/v6/tasks/:id(task_update_v6) 패치 — 변경 후 reload()로 재페인트(기존 토글과 동일).
// ════════════════════════════════════════════
const PJV_TASK_STATUS = {
    todo: { label: '할 일', bucket: 'todo', glyph: '', cls: 'todo' },
    in_progress: { label: '진행 중', bucket: 'in_progress', glyph: '◐', cls: 'inprog' },
    done: { label: 'Closed', bucket: 'done', glyph: '✓', cls: 'done' },
};
const PJV_STATUS_ORDER = ['todo', 'in_progress', 'done'];
// 레거시 'active'(구 토글)·클릭업 미러 적재값을 'todo' 버킷으로 흡수. 그 외 미지정도 todo.
function pjvStatusMeta(s) {
    if (s === 'done')
        return PJV_TASK_STATUS.done;
    if (s === 'in_progress')
        return PJV_TASK_STATUS.in_progress;
    return PJV_TASK_STATUS.todo;
}
const PJV_PRIORITY = {
    urgent: { label: '긴급', cls: 'urgent' },
    high: { label: '높음', cls: 'high' },
    normal: { label: '보통', cls: 'normal' },
    low: { label: '낮음', cls: 'low' },
};
const PJV_PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low'];
function pjvFmtDate(d) {
    if (!d)
        return '';
    const p = String(d).split('-');
    return p.length === 3 ? (Number(p[1]) + '/' + Number(p[2])) : String(d);
}
function pjvTodayStr() {
    const n = new Date();
    const z = (x) => String(x).padStart(2, '0');
    return n.getFullYear() + '-' + z(n.getMonth() + 1) + '-' + z(n.getDate());
}
function pjvIsOverdue(t) { return t.due_date && t.status !== 'done' && t.due_date < pjvTodayStr(); }
// 인라인 편집용 경량 팝오버 — 앵커 아래 위치, 바깥클릭/ESC 로 닫힘. body 에 1개만(기존 것 제거). 닫기함수 반환.
function pjvPopover(anchor, content) {
    document.querySelectorAll('.pjv-pop').forEach((n) => n.remove());
    const pop = el('div', { class: 'pjv-pop' }, content);
    document.body.append(pop);
    // 위치 — 기본 앵커 아래, 아래 공간 부족하고 위가 더 넓으면 위로 뒤집음(하단 일괄 바 등). 콘텐츠가 나중에
    //  (동기 append·비동기 fetch) 채워져 높이가 바뀌면 ResizeObserver 로 재배치 → 항상 화면 안.
    const place = () => {
        const r = anchor.getBoundingClientRect();
        // 앵커가 DOM 에서 떨어졌거나(재렌더로 교체) 0크기면 재배치하지 않는다 — 그대로 두지 않으면 rect=0,0 으로 좌상단에 튄다.
        if (!anchor.isConnected || (r.width === 0 && r.height === 0))
            return;
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
        const ph = pop.offsetHeight;
        const flipUp = (r.bottom + 4 + ph > vh) && (r.top > vh - r.bottom);
        pop.style.top = ((flipUp ? r.top - ph - 4 : r.bottom + 4) + window.scrollY) + 'px';
        const left = Math.min(r.left + window.scrollX, window.scrollX + vw - pop.offsetWidth - 10);
        pop.style.left = Math.max(8, left) + 'px';
    };
    place();
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(() => place()) : null;
    if (ro)
        ro.observe(pop);
    const close = () => {
        if (ro)
            ro.disconnect();
        pop.remove();
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
    };
    const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target))
        close(); };
    const onKey = (e) => { if (e.key === 'Escape') {
        e.stopPropagation();
        close();
    } };
    setTimeout(() => {
        document.addEventListener('mousedown', onDoc, true);
        document.addEventListener('keydown', onKey, true);
    }, 0);
    return close;
}
// 필드 패치 — task_update_v6 호출 후 전체 재페인트. 실패 시 토스트.
async function pjvPatchTask(taskId, patch, reload) {
    try {
        await api('/api/ui/v6/tasks/' + taskId, { method: 'POST', body: JSON.stringify(patch) });
        pjvReloadKeepScroll(reload); // 태스크/하위태스크 상태·필드 변경 후 스크롤 보존(#358)
    }
    catch (e) {
        toast('수정 실패 — ' + e.message, true);
    }
}
// 상태 점(클릭→메뉴: 할 일/진행 중/완료).
function pjvStatusControl(t, reload) {
    const meta = pjvStatusMeta(t.status);
    const btn = el('button', { class: 'pjv-status-dot ' + meta.cls, type: 'button',
        title: '상태: ' + meta.label, 'aria-label': '상태 ' + meta.label }, meta.glyph ? el('span', { class: 'pjv-status-glyph', text: meta.glyph }) : null);
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu' });
        const close = pjvPopover(btn, menu);
        for (const key of PJV_STATUS_ORDER) {
            const m = PJV_TASK_STATUS[key];
            const sel = meta.bucket === key;
            const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-status-dot sm ' + m.cls }, m.glyph ? el('span', { class: 'pjv-status-glyph', text: m.glyph }) : null), el('span', { text: m.label }));
            item.onclick = () => { close(); if (!sel)
                pjvPatchTask(t.id, { status: key }, reload); };
            menu.append(item);
        }
    };
    return btn;
}
// 담당자(아바타/이니셜, 클릭→프로젝트 팀원 선택 + '담당 없음').
// 빈 상태 회색 라인 아이콘(클릭업식) — 담당자=사람＋ · 마감일=달력＋ · 우선순위=깃발. 색은 CSS(.pjv-cell-ico).
function pjvIcon(kind) {
    const svg = (...kids) => sv('svg', { class: 'pjv-cell-ico', viewBox: '0 0 24 24', width: '17', height: '17',
        fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ...kids);
    if (kind === 'assignee') { // 사람 + (담당자 지정)
        return svg(sv('circle', { cx: '9.5', cy: '8', r: '3.4' }), sv('path', { d: 'M3.7 19a5.8 5.8 0 0 1 11.6 0' }), sv('path', { d: 'M18.8 13.6v4.6M16.5 15.9h4.6' }));
    }
    if (kind === 'due') { // 달력 + (마감일 지정)
        return svg(sv('rect', { x: '3.3', y: '5', width: '17.4', height: '15.2', rx: '2.4' }), sv('path', { d: 'M3.3 9.3h17.4' }), sv('path', { d: 'M8 2.8v3.6M16 2.8v3.6' }), sv('path', { d: 'M12 12.2v4.6M9.7 14.5h4.6' }));
    }
    if (kind === 'session') { // 터미널 바로가기(내 세션) — 창 + 프롬프트(>_)
        return svg(sv('rect', { x: '3', y: '4.5', width: '18', height: '15', rx: '2.4' }), sv('path', { d: 'M7 9.5l3 2.5-3 2.5' }), sv('path', { d: 'M13 14.5h4' }));
    }
    return svg(// 깃발 (우선순위)
    sv('path', { d: 'M6 20.5V4' }), sv('path', { d: 'M6 4.7h10.3l-2.4 3.3 2.4 3.3H6z' }));
}
// 담당자 다중 지정 — assignee 컬럼에 JSON 배열(["yoon","jang"]) 저장. 단일 문자열("yoon")은 레거시로 하위호환.
//  서버는 assignee 를 검증없이 문자열 그대로 저장하고 SQL 필터도 없어, 배열 직렬화만으로 다중이 된다(조인테이블 불요).
function pjvAssignees(t) {
    const a = t && t.assignee;
    if (a == null)
        return [];
    if (Array.isArray(a))
        return a.filter(Boolean);
    const s = String(a).trim();
    if (!s)
        return [];
    if (s[0] === '[') {
        try {
            const arr = JSON.parse(s);
            return Array.isArray(arr) ? arr.filter(Boolean) : [s];
        }
        catch (_) {
            return [s];
        }
    }
    return [s];
}
function pjvAssigneeWrite(ids) {
    const a = [...new Set((ids || []).filter(Boolean))];
    return a.length ? JSON.stringify(a) : null;
}
// 저장만(전체 reload 없이) — 다중 토글 중 메뉴를 닫지 않으려고 낙관적 갱신 + 백그라운드 저장.
function pjvSaveTask(taskId, patch) {
    return api('/api/ui/v6/tasks/' + taskId, { method: 'POST', body: JSON.stringify(patch) }).catch((e) => toast('수정 실패 — ' + e.message, true));
}
// 담당자 셀(다중) — 페이스파일 아바타(최대 3 + N) / 빈 아이콘. 메뉴=팀원 토글(체크 유지, 닫지 않음) + 담당 없음.
function pjvAssigneeControl(t, members, apply) {
    const nameOf = (id) => { const m = members.find((x) => x.member_id === id); return m ? (m.display_name || m.member_id) : id; };
    const btn = el('button', { class: 'pjv-cell-btn', type: 'button', title: '담당자' });
    function render() {
        const ids = pjvAssignees(t);
        btn.className = 'pjv-cell-btn' + (ids.length ? '' : ' empty');
        if (ids.length) {
            const faces = el('span', { class: 'pjv-asg-faces' });
            for (const id of ids.slice(0, 3))
                faces.append(el('span', { class: 'pjv-ava', style: 'background:' + avatarColor(id), title: nameOf(id), text: initials(nameOf(id)) }));
            if (ids.length > 3)
                faces.append(el('span', { class: 'pjv-ava pjv-ava-more', text: '+' + (ids.length - 3) }));
            btn.replaceChildren(faces);
        }
        else {
            btn.replaceChildren(pjvIcon('assignee'));
        }
    }
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu pjv-asg-menu' });
        pjvPopover(btn, menu);
        const setIds = (ids) => { t.assignee = pjvAssigneeWrite(ids); render(); apply({ assignee: t.assignee }); rebuild(); };
        const none = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '담당 없음' }));
        none.onclick = (ev) => { ev.stopPropagation(); setIds([]); };
        const itemsBox = el('div', {});
        menu.append(none, itemsBox);
        function rebuild() {
            const ids = pjvAssignees(t);
            none.className = 'pjv-menu-item' + (!ids.length ? ' sel' : '');
            itemsBox.replaceChildren(...members.map((m) => {
                const on = ids.includes(m.member_id);
                const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-ava', style: 'background:' + avatarColor(m.member_id), text: initials(m.display_name || m.member_id) }), el('span', { class: 'pjv-asg-mname', text: m.display_name || m.member_id }), el('span', { class: 'pjv-asg-check', text: on ? '✓' : '' }));
                item.onclick = (ev) => { ev.stopPropagation(); const c = pjvAssignees(t); setIds(c.includes(m.member_id) ? c.filter((x) => x !== m.member_id) : [...c, m.member_id]); };
                return item;
            }));
            if (!members.length)
                itemsBox.append(el('div', { class: 'pjv-menu-empty', text: '팀원을 먼저 추가하세요' }));
        }
        rebuild();
    };
    render();
    return btn;
}
// 마감일(YYYY-MM-DD, 표시는 m/d). 클릭→날짜입력 + 지우기.
function pjvDueControl(t, apply) {
    const overdue = pjvIsOverdue(t);
    const btn = el('button', { class: 'pjv-cell-btn' + (t.due_date ? '' : ' empty'), type: 'button', title: '마감일' });
    btn.append(t.due_date
        ? el('span', { class: 'pjv-due-text' + (overdue ? ' overdue' : ''), text: pjvFmtDate(t.due_date) })
        : pjvIcon('due'));
    btn.onclick = (e) => {
        e.stopPropagation();
        const input = el('input', { type: 'date', class: 'pjv-date-input', value: t.due_date || '' });
        const wrap = el('div', { class: 'pjv-menu pjv-date-pop' }, input, t.due_date ? el('button', { class: 'pjv-menu-item danger', type: 'button', text: '마감일 지우기',
            onclick: () => { close(); apply({ due_date: null }); } }) : null);
        const close = pjvPopover(btn, wrap);
        setTimeout(() => { input.focus(); if (input.showPicker) {
            try {
                input.showPicker();
            }
            catch (_) { /* noop */ }
        } }, 0);
        input.onchange = () => { const v = input.value || null; close(); apply({ due_date: v }); };
    };
    return btn;
}
// 우선순위(깃발, 색상). 클릭→긴급/높음/보통/낮음/없음.
function pjvPriorityControl(t, apply) {
    const m = t.priority ? PJV_PRIORITY[t.priority] : null;
    const btn = el('button', { class: 'pjv-cell-btn' + (m ? '' : ' empty'), type: 'button', title: '우선순위' });
    btn.append(m
        ? el('span', { class: 'pjv-flag ' + m.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' }), el('span', { class: 'pjv-flag-label', text: m.label }))
        : pjvIcon('priority'));
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu' });
        const close = pjvPopover(btn, menu);
        for (const key of PJV_PRIORITY_ORDER) {
            const pm = PJV_PRIORITY[key];
            const sel = t.priority === key;
            const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-flag ' + pm.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' })), el('span', { text: pm.label }));
            item.onclick = () => { close(); if (!sel)
                apply({ priority: key }); };
            menu.append(item);
        }
        const none = el('button', { class: 'pjv-menu-item' + (!t.priority ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
        none.onclick = () => { close(); if (t.priority)
            apply({ priority: null }); };
        menu.append(none);
    };
    return btn;
}
// 닫힌(완료=Closed) 항목 표시 상태 — 클릭업 'Closed' 토글. 세션 동안 유지(reload 무관). 기본 숨김.
const pjvClosedView = { tasks: false, subtasks: false };
// 프로젝트 보드(#/projects2 대시보드)의 완료 그룹 표시 토글 — 태스크 리스트의 Closed 와 동형. 기본 숨김.
const pjvProjClosedView = { done: false };
// '내 할당만' 토글(보드) — 내가 만든·팀원인 프로젝트만. 세션 유지(reload 무관). 기본 OFF.
const pjvBoardMineOnly = { on: false };
// 보드 보기 — 묶는 기준 두 개를 독립 토글. byArea=영역(상위 분류)으로 묶기(켜면 좌측 영역 사이드바가 보임, **기본 꺼짐**
//  — 처음 진입 시 사이드바 닫힘, 헤더의 영역 토글 또는 보기→영역으로 연다; ◀/▶ 로 접었다 펼침) /
//  byStatus=상태(할 일·진행 중·완료)로 나누기(기본 켜짐). 둘 다 끄면 한 목록. 세션 유지.
const pjvBoardView = { byArea: false, byStatus: true };
// 영역 그룹 펼침 상태 사용자 오버라이드 — key: 'L'+id | '__none__'. 없으면 기본(내 영역=펼침)을 따른다. 세션 유지.
const pjvListOpen = new Map();
// 영역 목록에서 선택된 영역 key('L'+id | '__none__' | '__all__'). 세션 유지.
const pjvSidebarSel = { key: '__all__' };
// 영역 목록 펼침/접힘(byArea 켜진 상태에서). 접으면 얇은 레일(▶)만, 영역 그룹은 유지. 기본 펼침. 세션 유지.
const pjvSidePanel = { open: true };
// 프로젝트 보드의 '하위 태스크' 버튼 모드 — 각 프로젝트를 펼쳐 그 안의 태스크를 보여주는 방식.
//  collapsed(접힘·기본, 캐럿으로 펼침) / expanded(펼침·전부 열림) / separate(분리·태스크를 상태 그룹에 평면 표시). 태스크 박스의 pjvSubtaskMode 와 독립.
const pjvProjTaskMode = { mode: 'collapsed' };
// 하위 태스크 표시 모드(클릭업 Subtasks 버튼) — collapsed(접힘·기본) / expanded(펼침) / separate(분리·하위를 최상위 행으로).
const pjvSubtaskMode = { mode: 'collapsed' };
const PJV_SUBTASK_OPTS = [
    { key: 'collapsed', label: '접힘', hint: '기본 (하위는 캐럿으로 펼침)' },
    { key: 'expanded', label: '펼침', hint: '모든 하위를 펼쳐서 표시' },
    { key: 'separate', label: '분리', hint: '하위를 별도 행으로 표시' },
];
const PJV_SUBTASK_BTNLABEL = { collapsed: '하위 태스크', expanded: '펼침', separate: '분리' };
// 하위 태스크 아이콘(클릭업식) — 좌상단 노드 → 꺾인 가지 → 우하단 노드.
function pjvSubtaskIcon() {
    const n = sv('svg', { class: 'pjv-subtask-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 7, cy: 6, r: 2.2 }), sv('circle', { cx: 17, cy: 17, r: 2.2 }), sv('path', { d: 'M7 8.2v5.6a2.6 2.6 0 0 0 2.6 2.6H14.6' }));
    return n;
}
// Subtasks 버튼 메뉴 — 접힘/펼침/분리. 선택 시 모드 변경 후 onChange(재렌더).
function pjvSubtaskMenu(anchor, onChange) {
    const pop = el('div', { class: 'pjv-menu pjv-subtask-pop' });
    const close = pjvPopover(anchor, pop);
    pop.append(el('div', { class: 'pjv-subtask-pop-head', text: '하위 태스크 표시' }));
    for (const o of PJV_SUBTASK_OPTS) {
        const sel = pjvSubtaskMode.mode === o.key;
        const item = el('button', { class: 'pjv-menu-item pjv-subtask-item' + (sel ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-subtask-item-main' }, el('span', { class: 'pjv-subtask-item-label', text: o.label }), el('span', { class: 'pjv-subtask-item-hint', text: o.hint })), sel ? el('span', { class: 'pjv-subtask-check', text: '✓' }) : null);
        item.onclick = () => { close(); if (pjvSubtaskMode.mode !== o.key) {
            pjvSubtaskMode.mode = o.key;
            onChange();
        } };
        pop.append(item);
    }
}
// 프로젝트 보드의 '하위 태스크' 버튼 메뉴 — 태스크 박스와 동일 UI. 선택 시 pjvProjTaskMode 변경 후 onChange(재렌더).
function pjvProjTaskMenu(anchor, onChange) {
    const pop = el('div', { class: 'pjv-menu pjv-subtask-pop' });
    const close = pjvPopover(anchor, pop);
    pop.append(el('div', { class: 'pjv-subtask-pop-head', text: '하위 태스크 표시' }));
    for (const o of PJV_SUBTASK_OPTS) {
        const sel = pjvProjTaskMode.mode === o.key;
        const item = el('button', { class: 'pjv-menu-item pjv-subtask-item' + (sel ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-subtask-item-main' }, el('span', { class: 'pjv-subtask-item-label', text: o.label }), el('span', { class: 'pjv-subtask-item-hint', text: o.hint })), sel ? el('span', { class: 'pjv-subtask-check', text: '✓' }) : null);
        item.onclick = () => { close(); if (pjvProjTaskMode.mode !== o.key) {
            pjvProjTaskMode.mode = o.key;
            onChange();
        } };
        pop.append(item);
    }
}
// '폴더' 버튼 아이콘 — 라인 스타일 폴더(상위 폴더으로 정리한다는 표식, #356).
function pjvSideToggleIcon() {
    const n = sv('svg', { class: 'pjv-view-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M4 7.6C4 6.8 4.7 6.1 5.5 6.1h3.1c.4 0 .8.2 1.05.5l.9 1.15h7c.85 0 1.55.7 1.55 1.55v7.55c0 .85-.7 1.55-1.55 1.55H5.5C4.7 18.9 4 18.2 4 17.35V7.6z' }));
    return n;
}
// 폴더(사이드바 항목) 아이콘 — 색을 채운 폴더. kind='all'(전체·파랑) / 'none'(미분류·점선 외곽) / 그 외=해당 폴더 색 채움.
function pjvBundleIcon(color, kind) {
    const FOLDER = 'M3 6.7C3 5.8 3.72 5.1 4.6 5.1h3.55c.46 0 .9.22 1.18.58l.86 1.1h8.2c.88 0 1.6.72 1.6 1.6v8.42c0 .88-.72 1.6-1.6 1.6H4.6C3.72 18.9 3 18.2 3 17.3V6.7z';
    const n = sv('svg', { class: 'pjv-bundle-ic' + (kind ? ' ' + kind : ''), viewBox: '0 0 24 24', width: 17, height: 17, 'aria-hidden': 'true' });
    if (kind === 'none')
        n.append(sv('path', { d: FOLDER, fill: 'none', stroke: 'var(--muted-3, #aab1bd)', 'stroke-width': 1.5, 'stroke-dasharray': '3 2.4', 'stroke-linejoin': 'round' }));
    else
        n.append(sv('path', { d: FOLDER, fill: color || 'var(--muted-2)' }));
    return n;
}
// '보기' 버튼 아이콘 — 슬라이더 2줄(설정 느낌).
function pjvViewIcon() {
    const n = sv('svg', { class: 'pjv-view-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M4 8h7M15 8h5' }), sv('circle', { cx: 13, cy: 8, r: 2.1 }), sv('path', { d: 'M4 16h5M13 16h7' }), sv('circle', { cx: 11, cy: 16, r: 2.1 }));
    return n;
}
// '필터' 팝오버 — '상태로 나누기'(할 일·진행 중·완료) 스위치. 사이드바(폴더)는 헤더 '폴더' 버튼 전담이라 여기서 안 다룬다(#356).
//  토글해도 닫지 않고 매 토글마다 onChange()로 보드 재렌더.
function pjvViewMenu(anchor, onChange) {
    const pop = el('div', { class: 'pjv-menu pjv-view-pop' });
    const close = pjvPopover(anchor, pop);
    pop.append(el('div', { class: 'pjv-view-pop-head', text: '필터' }));
    const mkSwitch = (key, label, hint) => {
        const sw = el('span', { class: 'pjv-switch', 'aria-hidden': 'true' }, el('span', { class: 'pjv-switch-knob' }));
        const item = el('button', { class: 'pjv-menu-item pjv-view-item', type: 'button', role: 'switch' }, el('span', { class: 'pjv-view-item-main' }, el('span', { class: 'pjv-view-item-label', text: label }), el('span', { class: 'pjv-view-item-hint', text: hint })), sw);
        const sync = () => { const on = !!pjvBoardView[key]; item.classList.toggle('on', on); item.setAttribute('aria-checked', String(on)); };
        item.onclick = (e) => { e.stopPropagation(); pjvBoardView[key] = !pjvBoardView[key]; sync(); onChange(); };
        sync();
        pop.append(item);
    };
    mkSwitch('byStatus', '상태로 나누기', '할 일 · 진행 중 · 완료로 나눠서 보여줘요');
}
// 체크-원 아이콘(Closed 버튼용).
function pjvCheckCircle() {
    const n = sv('svg', { class: 'pjv-closed-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 12, r: 9 }));
    n.append(sv('path', { d: 'M8.5 12.3l2.4 2.4 4.6-5' }));
    return n;
}
// 토글 스위치 행(라벨 + iOS식 스위치). after() = 상태 반영 후 재렌더.
function pjvSwitchRow(label, getOn, setOn, after) {
    const sw = el('button', { class: 'pjv-switch' + (getOn() ? ' on' : ''), type: 'button', role: 'switch', 'aria-checked': getOn() ? 'true' : 'false' }, el('span', { class: 'pjv-switch-knob' }));
    sw.onclick = (e) => { e.stopPropagation(); const nv = !getOn(); setOn(nv); sw.classList.toggle('on', nv); sw.setAttribute('aria-checked', nv ? 'true' : 'false'); after(); };
    return el('div', { class: 'pjv-closed-row' }, el('span', { class: 'pjv-closed-row-label', text: label }), sw);
}
// ════════════════════════════════════════════════════════════════════════════
// 커스텀 필드(클릭업형 "+ 컬럼 추가") — 우선순위 옆 (+) 로 형식을 지정해 컬럼을 추가하고, 각 태스크에 값을 채운다.
//  백엔드 task_field/task_field_value(루트 프로젝트 단위 정의 + 태스크별 값). FIELD_TYPES 는 store 의 것과 1:1.
//  아이콘은 우리 서비스 톤(단색 라인, currentColor, 형태로 구분 — 컬러 이모지 금지)으로 직접 제작.
// ════════════════════════════════════════════════════════════════════════════
// 옵션(드롭다운/라벨) 색 팔레트 — 차분한 톤(채도 절제). 추가 순서대로 라운드로빈.
const PJV_FIELD_PALETTE = ['#6b7cff', '#2bb3a3', '#e6913a', '#e0688e', '#9268d6', '#3f9ae0', '#56b877', '#dd6450', '#7f8aa3'];
// 통화 — 금액 필드. 기본 원화.
const PJV_CURRENCIES = {
    KRW: { symbol: '₩', label: '원 (₩)' }, USD: { symbol: '$', label: '달러 ($)' },
    EUR: { symbol: '€', label: '유로 (€)' }, JPY: { symbol: '¥', label: '엔 (¥)' },
};
// 필드 형식 정의 — key 는 백엔드 field_type 과 동일. w=컬럼 px 폭, config=설정 단계 종류(옵션/통화/별점/진행률).
const PJV_FIELD_TYPES = [
    { key: 'text', label: '텍스트', desc: '한 줄 텍스트', w: 150 },
    { key: 'textarea', label: '긴 텍스트', desc: '여러 줄 메모', w: 180 },
    { key: 'number', label: '숫자', desc: '정수·소수', w: 104 },
    { key: 'money', label: '금액', desc: '통화 단위 숫자', w: 120, config: 'money' },
    { key: 'date', label: '날짜', desc: '날짜 선택', w: 108 },
    { key: 'dropdown', label: '드롭다운', desc: '옵션 1개 선택', w: 148, config: 'options' },
    { key: 'labels', label: '라벨', desc: '옵션 여러 개 선택', w: 184, config: 'options' },
    { key: 'checkbox', label: '체크박스', desc: '예 / 아니오', w: 86 },
    { key: 'website', label: '웹사이트', desc: 'URL 링크', w: 156 },
    { key: 'email', label: '이메일', desc: '메일 주소', w: 168 },
    { key: 'phone', label: '전화', desc: '전화번호', w: 148 },
    { key: 'rating', label: '별점', desc: '별 점수', w: 128, config: 'rating' },
    { key: 'progress', label: '진행률', desc: '0–100% 막대', w: 136, config: 'progress' },
    { key: 'tshirt', label: '티셔츠 사이즈', desc: 'XS–XXL', w: 104 },
    { key: 'location', label: '위치', desc: '장소·주소', w: 156 },
    { key: 'files', label: '파일', desc: '공유 폴더에서 선택', w: 150 },
    { key: 'relationship', label: '관계', desc: '태스크 연결', w: 184 },
    { key: 'progress_auto', label: '진행률(자동)', desc: '하위 완료율 자동', w: 136 },
];
const PJV_FIELD_BY_KEY = Object.fromEntries(PJV_FIELD_TYPES.map((f) => [f.key, f]));
const PJV_TSHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
// 라인 아이콘 글리프(24x24, currentColor) — 형태만으로 형식을 구분(파일 아이콘 idiom 과 동일 톤).
const PJV_FIELD_ICON_PATHS = {
    text: [['polyline', { points: '5 7 5 4 19 4 19 7' }], ['line', { x1: 12, y1: 4, x2: 12, y2: 20 }], ['line', { x1: 9, y1: 20, x2: 15, y2: 20 }]],
    textarea: [['line', { x1: 4, y1: 6, x2: 20, y2: 6 }], ['line', { x1: 4, y1: 11, x2: 20, y2: 11 }], ['line', { x1: 4, y1: 16, x2: 13, y2: 16 }]],
    number: [['line', { x1: 9.5, y1: 4, x2: 7.5, y2: 20 }], ['line', { x1: 16.5, y1: 4, x2: 14.5, y2: 20 }], ['line', { x1: 4, y1: 9, x2: 20, y2: 9 }], ['line', { x1: 4, y1: 15, x2: 20, y2: 15 }]],
    money: [['line', { x1: 12, y1: 3, x2: 12, y2: 21 }], ['path', { d: 'M16 6.8H10.1a2.85 2.85 0 0 0 0 5.7h3.8a2.85 2.85 0 0 1 0 5.7H8' }]],
    date: [['rect', { x: 3, y: 5, width: 18, height: 16, rx: 2.5 }], ['line', { x1: 3, y1: 9.5, x2: 21, y2: 9.5 }], ['line', { x1: 8, y1: 3, x2: 8, y2: 7 }], ['line', { x1: 16, y1: 3, x2: 16, y2: 7 }]],
    dropdown: [['rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.5 }], ['polyline', { points: '8.5 10 12 13.5 15.5 10' }]],
    labels: [['path', { d: 'M3.6 12.4 11 5a2 2 0 0 1 1.42-.6H19A1.4 1.4 0 0 1 20.4 5.8v6.6a2 2 0 0 1-.6 1.42l-7.4 7.4a1.55 1.55 0 0 1-2.2 0l-6.6-6.6a1.55 1.55 0 0 1 0-2.2Z' }], ['circle', { cx: 16, cy: 8, r: 1.25 }]],
    checkbox: [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 3.5 }], ['polyline', { points: '8.4 12.4 11 15 16 9.4' }]],
    website: [['circle', { cx: 12, cy: 12, r: 9 }], ['line', { x1: 3, y1: 12, x2: 21, y2: 12 }], ['path', { d: 'M12 3c2.6 2.7 2.6 15.3 0 18' }], ['path', { d: 'M12 3c-2.6 2.7-2.6 15.3 0 18' }]],
    email: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }], ['polyline', { points: '4 7.5 12 13 20 7.5' }]],
    phone: [['path', { d: 'M6.5 3h3l1.6 4.2-2.3 1.5a11 11 0 0 0 4.9 4.9l1.5-2.3 4.2 1.6v3a2 2 0 0 1-2.1 2A15.5 15.5 0 0 1 4.5 5.1 2 2 0 0 1 6.5 3Z' }]],
    rating: [['path', { d: 'M12 4.3l2.34 4.74 5.23.76-3.78 3.69.89 5.2L12 16.9l-4.68 2.46.89-5.2-3.78-3.69 5.23-.76Z' }]],
    progress: [['rect', { x: 3, y: 9, width: 18, height: 6, rx: 3 }], ['path', { d: 'M6.2 12h6', 'stroke-width': 3.2, 'stroke-linecap': 'round' }]],
    tshirt: [['path', { d: 'M8.2 3.5 4 6.5l2.1 3.2 1.9-1.1V19a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V8.6l1.9 1.1L20 6.5l-4.2-3a2.4 2.4 0 0 1-3.8 1.4 2.4 2.4 0 0 1-3.8-1.4Z' }]],
    location: [['path', { d: 'M12 21s-6.4-5.3-6.4-10.4A6.4 6.4 0 0 1 18.4 10.6C18.4 15.7 12 21 12 21Z' }], ['circle', { cx: 12, cy: 10.4, r: 2.3 }]],
    files: [['path', { d: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48' }]],
    relationship: [['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }], ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }]],
    progress_auto: [['path', { d: 'M5.5 17.5a8 8 0 1 1 13 0' }], ['path', { d: 'M12 13l3.4-3.4' }]],
};
function pjvFieldIcon(key, cls) {
    const node = sv('svg', { class: 'pjv-ficon' + (cls ? ' ' + cls : ''), viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    for (const [t, a] of (PJV_FIELD_ICON_PATHS[key] || PJV_FIELD_ICON_PATHS.text))
        node.append(sv(t, a));
    return node;
}
function pjvPlusIcon() {
    const n = sv('svg', { class: 'pjv-addcol-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 12, r: 9 }), sv('line', { x1: 12, y1: 8, x2: 12, y2: 16 }), sv('line', { x1: 8, y1: 12, x2: 16, y2: 12 }));
    return n;
}
function pjvStarGlyph(on) {
    const n = sv('svg', { class: 'pjv-fstar-ic', viewBox: '0 0 24 24', fill: on ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M12 4.3l2.34 4.74 5.23.76-3.78 3.69.89 5.2L12 16.9l-4.68 2.46.89-5.2-3.78-3.69 5.23-.76Z' }));
    return n;
}
function pjvCheckGlyph(on) {
    const n = sv('svg', { class: 'pjv-fcheck-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('rect', { x: 4, y: 4, width: 16, height: 16, rx: 4 }));
    if (on)
        n.append(sv('polyline', { points: '8.4 12.4 11 15 16 9' }));
    return n;
}
function pjvOptChip(o) {
    return el('span', { class: 'pjv-fopt', style: '--opt:' + (o.color || PJV_FIELD_PALETTE[0]) }, el('span', { class: 'pjv-fopt-dot' }), el('span', { class: 'pjv-fopt-label', text: o.label }));
}
function pjvCheckMini(on) {
    const n = sv('svg', { class: 'pjv-check-mini' + (on ? ' on' : ''), viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('rect', { x: 4, y: 4, width: 16, height: 16, rx: 4 }));
    if (on)
        n.append(sv('polyline', { points: '8.4 12.4 11 15 16 9' }));
    return n;
}
// 그리드 템플릿 — 기본(이름·담당자·마감·우선순위) + 커스텀 필드 폭들 + 더보기. thead/행/추가행에 인라인 적용.
function pjvGridTemplate(fields) {
    // 제목 floor(180px) + 메타 minmax(0,W) — 창이 좁아지면 제목 대신 메타가 먼저 줄어든다(#339 와 같은 패턴, 태스크 리스트).
    const extra = (fields || []).map((f) => 'minmax(0, ' + ((PJV_FIELD_BY_KEY[f.field_type] && PJV_FIELD_BY_KEY[f.field_type].w) || 130) + 'px)').join(' ');
    return 'minmax(180px, 1fr) minmax(0, 96px) minmax(0, 92px) minmax(0, 112px)' + (extra ? ' ' + extra : '') + ' 34px';
}
// 프로젝트 목록 전용 — 우선순위 뒤 '내 세션'(80px) 컬럼 추가. 태스크 박스(pjvGridTemplate)엔 없음.
function pjvProjGridTemplate(fields) {
    // 제목 컬럼은 floor(200px) 로 보호 + 1fr 로 남은 폭 차지 — 창이 좁아져도 200px 밑으론 안 줄어든다(제목이 가장 잘 보이게).
    // 메타 컬럼(팀원·마감·우선·세션·커스텀)은 minmax(0, Wpx) 라, 좁아지면 '제목 대신' 이쪽이 먼저 줄어든다(#339).
    const extra = (fields || []).map((f) => 'minmax(0, ' + ((PJV_FIELD_BY_KEY[f.field_type] && PJV_FIELD_BY_KEY[f.field_type].w) || 130) + 'px)').join(' ');
    return 'minmax(200px, 1fr) minmax(0, 96px) minmax(0, 92px) minmax(0, 112px) minmax(0, 80px)' + (extra ? ' ' + extra : '') + ' 34px';
}
function pjvHasFieldValue(v) {
    return !(v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0));
}
function pjvUrlText(v) { return String(v).replace(/^https?:\/\//i, '').replace(/\/$/, ''); }
// 값 표시 노드(읽기) — 타입별. 셀 버튼 안에 들어간다.
function pjvFieldDisplay(field, value) {
    const type = field.field_type;
    const cfg = field.config || {};
    if (type === 'dropdown') {
        const o = (cfg.options || []).find((x) => x.id === value);
        return o ? pjvOptChip(o) : el('span', { class: 'pjv-fval', text: String(value) });
    }
    if (type === 'labels') {
        const opts = cfg.options || [];
        const wrap = el('span', { class: 'pjv-flabels' });
        for (const id of (Array.isArray(value) ? value : [])) {
            const o = opts.find((x) => x.id === id);
            wrap.append(o ? pjvOptChip(o) : el('span', { class: 'pjv-fval', text: String(id) }));
        }
        return wrap;
    }
    if (type === 'money') {
        const c = PJV_CURRENCIES[cfg.currency] || PJV_CURRENCIES.KRW;
        const n = Number(value);
        return el('span', { class: 'pjv-fval', text: c.symbol + (Number.isFinite(n) ? n.toLocaleString('ko-KR') : String(value)) });
    }
    if (type === 'number') {
        const n = Number(value);
        return el('span', { class: 'pjv-fval', text: Number.isFinite(n) ? n.toLocaleString('ko-KR') : String(value) });
    }
    if (type === 'date')
        return el('span', { class: 'pjv-fval', text: pjvFmtDate(value) });
    if (type === 'progress') {
        const pct = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
        return el('span', { class: 'pjv-fprog' }, el('span', { class: 'pjv-fprog-track' }, el('span', { class: 'pjv-fprog-fill', style: 'width:' + pct + '%' })), el('span', { class: 'pjv-fprog-num', text: pct + '%' }));
    }
    if (type === 'files') {
        const arr = Array.isArray(value) ? value : [];
        return el('span', { class: 'pjv-ffiles' }, pjvFieldIcon('files', 'pjv-fmini'), el('span', { class: 'pjv-fval', text: arr.length === 1 ? arr[0].name : arr.length + '개' }));
    }
    if (type === 'relationship') {
        const arr = Array.isArray(value) ? value : [];
        const w = el('span', { class: 'pjv-frel' });
        for (const r of arr.slice(0, 2))
            w.append(el('span', { class: 'pjv-rel-chip', text: r.name || ('#' + r.id), title: r.name }));
        if (arr.length > 2)
            w.append(el('span', { class: 'pjv-rel-more', text: '+' + (arr.length - 2) }));
        return w;
    }
    if (type === 'tshirt')
        return el('span', { class: 'pjv-fsize', text: String(value) });
    if (type === 'website')
        return el('span', { class: 'pjv-fval pjv-flink', text: pjvUrlText(value) });
    return el('span', { class: 'pjv-fval', text: String(value) }); // text/textarea/email/phone/location
}
// 한 셀의 컨트롤 — 낙관적 로컬 갱신 + 백그라운드 저장(전체 reload 없이 부드럽게). 옵션 추가 등 정의 변경은 reload.
function pjvFieldControl(t, field, reload) {
    let value = (t.field_values || {})[field.id];
    value = value === undefined ? null : value;
    const cell = el('span', { class: 'pjv-fcell-wrap' });
    const persist = (v) => {
        const prev = value;
        value = v;
        render();
        api('/api/ui/v6/tasks/' + t.id + '/fields/' + field.id, { method: 'POST', body: JSON.stringify({ value: v }) })
            .then(() => { (t.field_values || (t.field_values = {}))[field.id] = v; })
            .catch((e) => { value = prev; render(); toast('수정 실패 — ' + e.message, true); });
    };
    function render() { cell.replaceChildren(pjvFieldInner(t, field, value, persist, reload)); }
    render();
    return cell;
}
// 셀 내부 — 인라인 상호작용(체크박스·별점)은 셀 자체가 컨트롤, 그 외는 값 버튼(클릭→팝오버 편집기).
function pjvFieldInner(t, field, value, persist, reload) {
    const type = field.field_type;
    if (type === 'checkbox') {
        const on = value === true;
        const btn = el('button', { class: 'pjv-fcheck' + (on ? ' on' : ''), type: 'button', title: field.name, 'aria-pressed': on ? 'true' : 'false' }, pjvCheckGlyph(on));
        btn.onclick = (e) => { e.stopPropagation(); persist(!on); };
        return btn;
    }
    if (type === 'rating') {
        const max = Math.max(1, Math.min(10, Number(field.config && field.config.max) || 5));
        const cur = Number(value) || 0;
        const wrap = el('span', { class: 'pjv-frating', title: field.name });
        for (let i = 1; i <= max; i++) {
            const on = i <= cur;
            const star = el('button', { class: 'pjv-fstar' + (on ? ' on' : ''), type: 'button', 'aria-label': i + '점' }, pjvStarGlyph(on));
            star.onclick = (e) => { e.stopPropagation(); persist(i === cur ? null : i); };
            wrap.append(star);
        }
        return wrap;
    }
    if (type === 'progress_auto') {
        const pct = pjvAutoProgress(t);
        if (pct === null)
            return el('span', { class: 'pjv-cell-btn empty', title: '하위 태스크가 없어요(자동 진행률)', style: 'cursor:default' }, el('span', { class: 'pjv-cell-ph', text: '—' }));
        return el('span', { class: 'pjv-fprog', title: '하위 태스크 ' + pct + '% 완료(자동)' }, el('span', { class: 'pjv-fprog-track' }, el('span', { class: 'pjv-fprog-fill', style: 'width:' + pct + '%' })), el('span', { class: 'pjv-fprog-num', text: pct + '%' }));
    }
    const has = pjvHasFieldValue(value);
    const btn = el('button', { class: 'pjv-cell-btn' + (has ? '' : ' empty'), type: 'button', title: field.name }, has ? pjvFieldDisplay(field, value) : el('span', { class: 'pjv-cell-ph', text: '＋' }));
    btn.onclick = (e) => {
        e.stopPropagation();
        if (type === 'dropdown')
            return pjvFieldDropdownEditor(btn, t, field, value, persist, reload);
        if (type === 'labels')
            return pjvFieldLabelsEditor(btn, t, field, value, persist, reload);
        if (type === 'date')
            return pjvFieldDateEditor(btn, value, persist);
        if (type === 'progress')
            return pjvFieldProgressEditor(btn, value, persist);
        if (type === 'files')
            return pjvFieldFilesEditor(btn, t, field, value, persist);
        if (type === 'relationship')
            return pjvFieldRelEditor(btn, t, field, value, persist);
        if (type === 'tshirt')
            return pjvFieldTshirtEditor(btn, value, persist);
        if (type === 'textarea')
            return pjvFieldTextareaEditor(btn, field, value, persist);
        return pjvFieldTextEditor(btn, field, value, persist);
    };
    return btn;
}
// 텍스트류 편집기(text/number/money/website/email/phone/location) — 입력 + 저장/지우기. Enter 저장.
function pjvFieldTextEditor(anchor, field, value, persist) {
    const type = field.field_type;
    const itype = (type === 'number' || type === 'money') ? 'number' : type === 'website' ? 'url' : type === 'email' ? 'email' : type === 'phone' ? 'tel' : 'text';
    const input = el('input', { type: itype, class: 'pjv-field-input', value: value == null ? '' : String(value),
        placeholder: (PJV_FIELD_BY_KEY[type] && PJV_FIELD_BY_KEY[type].desc) || '',
        inputmode: (type === 'number' || type === 'money') ? 'decimal' : null });
    const coerce = (v) => {
        if (type === 'number' || type === 'money') {
            const n = Number(String(v).replace(/,/g, ''));
            return Number.isFinite(n) ? n : undefined;
        }
        return v;
    };
    const save = () => {
        const raw = input.value.trim();
        if (raw === '') {
            close();
            persist(null);
            return;
        }
        const out = coerce(raw);
        if (out === undefined) {
            toast('숫자를 입력하세요', true);
            return;
        }
        close();
        persist(out);
    };
    const actions = el('div', { class: 'pjv-fe-actions' }, el('button', { class: 'pjv-fe-btn primary', type: 'button', text: '저장', onclick: save }), (type === 'website' && pjvHasFieldValue(value)) ? el('a', { class: 'pjv-fe-btn', href: safeHref(String(value)) || '#', target: '_blank', rel: 'noopener', text: '열기 ↗' }) : null, pjvHasFieldValue(value) ? el('button', { class: 'pjv-fe-btn danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null);
    const close = pjvPopover(anchor, el('div', { class: 'pjv-field-editor' }, input, actions));
    setTimeout(() => { input.focus(); if (input.select)
        input.select(); }, 0);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
        e.preventDefault();
        save();
    } });
}
// 긴 텍스트 편집기 — textarea + 저장/지우기. Cmd/Ctrl+Enter 저장.
function pjvFieldTextareaEditor(anchor, field, value, persist) {
    const ta = el('textarea', { class: 'pjv-field-textarea', rows: '4', placeholder: '여러 줄 메모', maxlength: '4000' });
    ta.value = value == null ? '' : String(value);
    const save = () => { const v = ta.value.trim(); close(); persist(v === '' ? null : v); };
    const actions = el('div', { class: 'pjv-fe-actions' }, el('button', { class: 'pjv-fe-btn primary', type: 'button', text: '저장', onclick: save }), pjvHasFieldValue(value) ? el('button', { class: 'pjv-fe-btn danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null);
    const close = pjvPopover(anchor, el('div', { class: 'pjv-field-editor wide' }, ta, actions));
    setTimeout(() => { ta.focus(); }, 0);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
    } });
}
// 날짜 편집기 — 마감일과 동형(YYYY-MM-DD).
function pjvFieldDateEditor(anchor, value, persist) {
    const input = el('input', { type: 'date', class: 'pjv-date-input', value: typeof value === 'string' ? value : '' });
    const wrap = el('div', { class: 'pjv-menu pjv-date-pop' }, input, pjvHasFieldValue(value) ? el('button', { class: 'pjv-menu-item danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null);
    const close = pjvPopover(anchor, wrap);
    setTimeout(() => { input.focus(); if (input.showPicker) {
        try {
            input.showPicker();
        }
        catch (_) { /* noop */ }
    } }, 0);
    input.onchange = () => { const v = input.value || null; close(); persist(v); };
}
// 진행률 편집기 — 슬라이더 + 숫자(0–100).
function pjvFieldProgressEditor(anchor, value, persist) {
    const cur = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    const range = el('input', { type: 'range', class: 'pjv-prog-range', min: '0', max: '100', step: '5', value: String(cur) });
    const num = el('input', { type: 'number', class: 'pjv-prog-num-input', min: '0', max: '100', value: String(cur) });
    range.oninput = () => { num.value = range.value; };
    num.oninput = () => { const n = Math.max(0, Math.min(100, Number(num.value) || 0)); range.value = String(n); };
    const save = () => { const n = Math.max(0, Math.min(100, Math.round(Number(num.value) || 0))); close(); persist(n === 0 ? null : n); };
    const wrap = el('div', { class: 'pjv-field-editor pjv-prog-editor' }, el('div', { class: 'pjv-prog-row' }, range, el('span', { class: 'pjv-prog-pct' }, num, el('span', { text: '%' }))), el('div', { class: 'pjv-fe-actions' }, el('button', { class: 'pjv-fe-btn primary', type: 'button', text: '저장', onclick: save }), pjvHasFieldValue(value) ? el('button', { class: 'pjv-fe-btn danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null));
    const close = pjvPopover(anchor, wrap);
}
// 티셔츠 사이즈 — 고정 옵션(XS–XXL) 메뉴.
function pjvFieldTshirtEditor(anchor, value, persist) {
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(anchor, menu);
    for (const s of PJV_TSHIRT_SIZES) {
        const sel = value === s;
        const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-fsize', text: s }));
        item.onclick = () => { close(); persist(sel ? null : s); };
        menu.append(item);
    }
    const none = el('button', { class: 'pjv-menu-item' + (value == null ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
    none.onclick = () => { close(); if (value != null)
        persist(null); };
    menu.append(none);
}
// 하위 태스크 완료율(자동) — 진행률(자동) 필드용. 하위 없으면 null. (클릭업 Progress Auto 의 하위 기반 버전)
function pjvAutoProgress(t) {
    const subs = (t && t.subtasks) || [];
    if (!subs.length)
        return null;
    const done = subs.filter((s) => s.status === 'done').length;
    return Math.round((done / subs.length) * 100);
}
// 파일 필드 — 공유 폴더에서 선택(참조). 업로드가 아니라 프로젝트 공유폴더의 기존 파일을 골라 연결한다.
//  값=[{name, path, size}](path=공유폴더 상대경로). 연결 해제해도 실제 파일은 안 지워진다(참조만 끊음).
function pjvFieldFilesEditor(anchor, t, field, value, persist) {
    let selected = Array.isArray(value) ? value.slice() : [];
    const B = '/api/ui/v6/projects/' + field.project_id;
    const wrap = el('div', { class: 'pjv-field-editor pjv-files-editor' });
    const close = pjvPopover(anchor, wrap);
    let curPath = '';
    let curData = null;
    const chips = el('div', { class: 'pjv-files-selected' });
    const crumb = el('div', { class: 'pjv-files-crumb' });
    const rowsBox = el('div', { class: 'pjv-files-browser' });
    const renderChips = () => {
        chips.replaceChildren(el('span', { class: 'pjv-files-sel-label', text: '연결된 파일 ' + selected.length + '개' }));
        for (const s of selected) {
            chips.append(el('span', { class: 'pjv-rel-chip removable' }, el('button', { class: 'pjv-chip-dl', type: 'button', title: '다운로드', text: '↓', onclick: () => authDownload(B + '/file?download=1&path=' + encodeURIComponent(s.path), s.name) }), el('span', { class: 'pjv-files-name', text: s.name, title: s.path }), el('button', { class: 'pjv-rel-x', type: 'button', title: '연결 해제', text: '✕', onclick: () => { selected = selected.filter((x) => x.path !== s.path); persist(selected.length ? selected.slice() : null); renderChips(); refreshRows(); } })));
        }
    };
    const refreshRows = () => {
        rowsBox.replaceChildren();
        const items = (curData && curData.items) || [];
        if (!items.length) {
            rowsBox.append(el('div', { class: 'pjv-files-empty', text: '빈 폴더예요' }));
            return;
        }
        for (const it of items) {
            const childPath = curPath ? curPath + '/' + it.name : it.name;
            if (it.type === 'dir') {
                rowsBox.append(el('button', { class: 'pjv-files-row dir', type: 'button', onclick: () => { curPath = childPath; load(); } }, fileIconSvg(it.name, true), el('span', { class: 'pjv-files-name', text: it.name }), el('span', { class: 'pjv-files-chev', text: '›' })));
            }
            else {
                const on = selected.some((x) => x.path === childPath);
                const row = el('button', { class: 'pjv-files-row file' + (on ? ' on' : ''), type: 'button' }, pjvCheckMini(on), fileIconSvg(it.name, false), el('span', { class: 'pjv-files-name', text: it.name }), el('span', { class: 'pjv-files-size', text: fmtSize(it.size) }));
                row.onclick = () => {
                    if (on)
                        selected = selected.filter((x) => x.path !== childPath);
                    else
                        selected.push({ name: it.name, path: childPath, size: it.size });
                    persist(selected.length ? selected.slice() : null);
                    renderChips();
                    refreshRows();
                };
                rowsBox.append(row);
            }
        }
    };
    const renderCrumb = () => {
        crumb.replaceChildren(el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: '루트', onclick: () => { curPath = ''; load(); } }));
        let acc = '';
        for (const p of (curPath ? curPath.split('/') : [])) {
            acc = acc ? acc + '/' + p : p;
            const target = acc;
            crumb.append(el('span', { class: 'pjv-files-crumb-sep', text: '/' }), el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: p, onclick: () => { curPath = target; load(); } }));
        }
    };
    const load = async () => {
        rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '불러오는 중…' }));
        try {
            curData = await api(B + '/files?path=' + encodeURIComponent(curPath));
        }
        catch (e) {
            curData = { items: [] };
            renderCrumb();
            rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '공유 폴더를 불러오지 못했어요' }));
            return;
        }
        renderCrumb();
        refreshRows();
    };
    wrap.append(el('div', { class: 'pjv-files-head2', text: '공유 폴더에서 파일 선택' }), chips, crumb, rowsBox);
    renderChips();
    load();
}
// 관계(태스크 연결) 필드 — 같은 프로젝트의 다른 태스크를 검색해 연결. 값=[{id, name}]. (link-targets 재활용)
function pjvFieldRelEditor(anchor, t, field, value, persist) {
    let linked = Array.isArray(value) ? value.slice() : [];
    const B = '/api/ui/v6/projects/' + field.project_id;
    const chips = el('div', { class: 'pjv-rel-chips' });
    const results = el('div', { class: 'pjv-rel-results' });
    const search = el('input', { type: 'text', class: 'pjv-field-input', placeholder: '연결할 태스크 검색…' });
    let timer = null;
    const renderChips = () => {
        chips.replaceChildren();
        if (!linked.length) {
            chips.append(el('span', { class: 'pjv-files-empty', text: '연결된 태스크가 없어요' }));
            return;
        }
        for (const r of linked) {
            chips.append(el('span', { class: 'pjv-rel-chip removable' }, el('span', { text: r.name || ('#' + r.id) }), el('button', { class: 'pjv-rel-x', type: 'button', title: '연결 해제', text: '✕', onclick: () => { linked = linked.filter((x) => x.id !== r.id); persist(linked.length ? linked.slice() : null); renderChips(); doSearch(); } })));
        }
    };
    const doSearch = async () => {
        let targets = [];
        try {
            const d = await api(B + '/link-targets?exclude=' + t.id + '&q=' + encodeURIComponent(search.value.trim()));
            targets = (d && d.targets) || [];
        }
        catch (e) {
            results.replaceChildren(el('div', { class: 'pjv-files-empty', text: '검색 실패' }));
            return;
        }
        const avail = targets.filter((x) => !linked.some((l) => l.id === x.id));
        results.replaceChildren();
        if (!avail.length) {
            results.append(el('div', { class: 'pjv-files-empty', text: '결과가 없어요' }));
            return;
        }
        for (const x of avail) {
            const row = el('button', { class: 'pjv-rel-result', type: 'button' }, el('span', { class: 'pjv-rel-result-name', text: x.name }), el('span', { class: 'pjv-rel-add', text: '＋ 연결' }));
            row.onclick = () => { linked.push({ id: x.id, name: x.name }); persist(linked.slice()); renderChips(); doSearch(); };
            results.append(row);
        }
    };
    search.oninput = () => { clearTimeout(timer); timer = setTimeout(doSearch, 220); };
    const wrap = el('div', { class: 'pjv-field-editor pjv-rel-editor' }, chips, search, results);
    const close = pjvPopover(anchor, wrap);
    renderChips();
    doSearch();
    setTimeout(() => search.focus(), 0);
}
// 드롭다운 편집기 — 옵션 1개 선택 + 없음 + 즉석 옵션 추가.
function pjvFieldDropdownEditor(anchor, t, field, value, persist, reload) {
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(anchor, menu);
    for (const o of (field.config && field.config.options) || []) {
        const sel = value === o.id;
        const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' }, pjvOptChip(o));
        item.onclick = () => { close(); persist(sel ? null : o.id); };
        menu.append(item);
    }
    const none = el('button', { class: 'pjv-menu-item' + (value == null ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
    none.onclick = () => { close(); if (value != null)
        persist(null); };
    menu.append(none);
    menu.append(pjvAddOptionRow(field, async (opt) => {
        close();
        try {
            await api('/api/ui/v6/tasks/' + t.id + '/fields/' + field.id, { method: 'POST', body: JSON.stringify({ value: opt.id }) });
        }
        catch (_) { /* noop */ }
        reload();
    }));
}
// 라벨 편집기 — 옵션 여러 개(토글, 즉시 저장·셀 실시간 갱신, 팝오버 유지) + 즉석 옵션 추가.
function pjvFieldLabelsEditor(anchor, t, field, value, persist, reload) {
    const selected = Array.isArray(value) ? value.slice() : [];
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(anchor, menu);
    for (const o of (field.config && field.config.options) || []) {
        const item = el('button', { class: 'pjv-menu-item' + (selected.includes(o.id) ? ' sel' : ''), type: 'button' }, pjvCheckMini(selected.includes(o.id)), pjvOptChip(o));
        item.onclick = () => {
            const on = selected.includes(o.id);
            if (on)
                selected.splice(selected.indexOf(o.id), 1);
            else
                selected.push(o.id);
            item.classList.toggle('sel', !on);
            item.replaceChildren(pjvCheckMini(!on), pjvOptChip(o));
            persist(selected.length ? selected.slice() : null);
        };
        menu.append(item);
    }
    menu.append(pjvAddOptionRow(field, async (opt) => {
        close();
        try {
            await api('/api/ui/v6/tasks/' + t.id + '/fields/' + field.id, { method: 'POST', body: JSON.stringify({ value: [...selected, opt.id] }) });
        }
        catch (_) { /* noop */ }
        reload();
    }));
}
// 즉석 옵션 추가 행 — 입력 + Enter. 필드 config 에 옵션 추가 후 onAdded(opt) 콜백.
function pjvAddOptionRow(field, onAdded) {
    const inp = el('input', { type: 'text', class: 'pjv-opt-add-input', placeholder: '＋ 옵션 추가', maxlength: '40' });
    const row = el('div', { class: 'pjv-opt-add' }, inp);
    inp.onclick = (e) => e.stopPropagation();
    inp.addEventListener('keydown', async (e) => {
        e.stopPropagation();
        if (e.key !== 'Enter')
            return;
        const label = inp.value.trim();
        if (!label)
            return;
        inp.disabled = true;
        try {
            onAdded(await pjvAddFieldOption(field, label));
        }
        catch (err) {
            toast('옵션 추가 실패 — ' + err.message, true);
            inp.disabled = false;
        }
    });
    return row;
}
async function pjvAddFieldOption(field, label) {
    const opts = (field.config && field.config.options) || [];
    const opt = { id: 'o' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), label: label.slice(0, 40), color: PJV_FIELD_PALETTE[opts.length % PJV_FIELD_PALETTE.length] };
    const config = Object.assign({}, field.config, { options: [...opts, opt] });
    await api('/api/ui/v6/fields/' + field.id, { method: 'POST', body: JSON.stringify({ config }) });
    return opt;
}
// ── 컬럼 헤더(커스텀 필드) — 아이콘 + 이름 + ⋯ 메뉴(이름변경/옵션편집/삭제) ──
function pjvColumnHead(field, projectId, reload) {
    const cell = el('div', { class: 'pjv-tcell pjv-thcol' }, pjvFieldIcon(field.field_type, 'pjv-thcol-ic'), el('span', { class: 'pjv-thcol-name', text: field.name, title: field.name }));
    const menuBtn = el('button', { class: 'pjv-thcol-menu', type: 'button', text: '⋯', 'aria-label': field.name + ' 컬럼 설정' });
    menuBtn.onclick = (e) => { e.stopPropagation(); pjvColumnMenu(menuBtn, field, projectId, reload); };
    cell.append(menuBtn);
    return cell;
}
function pjvColumnMenu(anchor, field, projectId, reload) {
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(anchor, menu);
    const mk = (label, fn, danger) => { const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label })); b.onclick = () => { close(); fn(); }; return b; };
    menu.append(mk('이름 변경', () => pjvRenameColumn(anchor, field, reload)));
    const meta = PJV_FIELD_BY_KEY[field.field_type];
    if (meta && meta.config === 'options')
        menu.append(mk('옵션 편집', () => pjvEditColumnOptions(field, reload)));
    menu.append(mk('컬럼 삭제', () => pjvDeleteColumn(field, reload), true));
}
function pjvRenameColumn(anchor, field, reload) {
    const input = el('input', { type: 'text', class: 'pjv-rename-input', value: field.name, maxlength: '120' });
    const close = pjvPopover(anchor, el('div', { class: 'pjv-menu pjv-rename-pop' }, input));
    input.onkeydown = async (e) => {
        if (e.key !== 'Enter')
            return;
        e.preventDefault();
        const v = input.value.trim();
        close();
        if (v && v !== field.name) {
            try {
                await api('/api/ui/v6/fields/' + field.id, { method: 'POST', body: JSON.stringify({ name: v }) });
                reload();
            }
            catch (err) {
                toast('수정 실패 — ' + err.message, true);
            }
        }
    };
    setTimeout(() => { input.focus(); input.select(); }, 0);
}
function pjvEditColumnOptions(field, reload) {
    const ob = pjvOptionsBuilder((field.config && field.config.options) || []);
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const back = overlayBox('옵션 편집 · ' + field.name, el('div', { class: 'field' }, ob.el), el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
    saveBtn.onclick = async () => {
        const options = ob.get();
        if (!options.length) {
            toast('옵션을 1개 이상 두세요', true);
            return;
        }
        saveBtn.disabled = true;
        const config = Object.assign({}, field.config, { options });
        try {
            await api('/api/ui/v6/fields/' + field.id, { method: 'POST', body: JSON.stringify({ config }) });
            back.remove();
            reload();
        }
        catch (e) {
            toast('저장 실패 — ' + e.message, true);
            saveBtn.disabled = false;
        }
    };
}
function pjvDeleteColumn(field, reload) {
    if (!confirm("'" + field.name + "' 컬럼을 삭제할까요?\n\n이 컬럼의 모든 값이 함께 사라집니다."))
        return;
    (async () => {
        try {
            await api('/api/ui/v6/fields/' + field.id + '/delete', { method: 'POST', body: JSON.stringify({}) });
            toast('컬럼을 삭제했어요');
            reload();
        }
        catch (e) {
            toast('삭제 실패 — ' + e.message, true);
        }
    })();
}
// ── 옵션 빌더(생성/편집 공용) — 색 점(클릭=색 순환)·라벨·삭제 + 추가. 기존 id 보존(값 깨짐 방지). ──
function pjvOptionsBuilder(initial) {
    const rows = el('div', { class: 'pjv-optb-rows' });
    const data = [];
    const addRow = (o) => {
        o = o || {};
        const item = { id: o.id || null, label: o.label || '', color: o.color || PJV_FIELD_PALETTE[data.length % PJV_FIELD_PALETTE.length] };
        data.push(item);
        let ci = Math.max(0, PJV_FIELD_PALETTE.indexOf(item.color));
        const dot = el('button', { class: 'pjv-optb-dot', type: 'button', style: '--opt:' + item.color, title: '색상 변경' });
        dot.onclick = () => { ci = (ci + 1) % PJV_FIELD_PALETTE.length; item.color = PJV_FIELD_PALETTE[ci]; dot.style.setProperty('--opt', item.color); };
        const inp = el('input', { type: 'text', class: 'pjv-optb-input', value: item.label, placeholder: '옵션 이름', maxlength: '40' });
        inp.oninput = () => { item.label = inp.value; };
        const rm = el('button', { class: 'pjv-optb-rm', type: 'button', text: '✕', title: '삭제' });
        const rowEl = el('div', { class: 'pjv-optb-row' }, dot, inp, rm);
        rm.onclick = () => { const i = data.indexOf(item); if (i >= 0)
            data.splice(i, 1); rowEl.remove(); };
        rows.append(rowEl);
    };
    (initial && initial.length ? initial : [{}, {}]).forEach(addRow);
    const addBtn = el('button', { class: 'pjv-optb-add', type: 'button', text: '＋ 옵션 추가', onclick: () => addRow(null) });
    return {
        el: el('div', { class: 'pjv-optb' }, rows, addBtn),
        get: () => data.filter((d) => d.label.trim()).map((d) => ({
            id: d.id || ('o' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)),
            label: d.label.trim().slice(0, 40), color: d.color,
        })),
    };
}
// ── (+) 컬럼 추가 버튼 + Fields 패널(클릭업형: 검색 · 새로 만들기/기존 항목 탭 · 형식 목록 · 설정 폼) ──
function pjvAddColumnButton(projectId, reload) {
    const btn = el('button', { class: 'pjv-addcol-btn', type: 'button', title: '컬럼 추가', 'aria-label': '컬럼 추가' }, pjvPlusIcon());
    btn.onclick = (e) => { e.stopPropagation(); pjvOpenFieldsPanel(btn, projectId, reload); };
    return btn;
}
function pjvOpenFieldsPanel(anchor, projectId, reload) {
    const panel = el('div', { class: 'pjv-fields-panel' });
    const close = pjvPopover(anchor, panel);
    let catalog = null;
    const showPicker = (tab) => {
        tab = tab || 'new';
        const search = el('input', { type: 'text', class: 'pjv-fields-search', placeholder: '필드 검색…' });
        const tNew = el('button', { class: 'pjv-fields-tab' + (tab === 'new' ? ' on' : ''), type: 'button', text: '새로 만들기', onclick: () => showPicker('new') });
        const tExist = el('button', { class: 'pjv-fields-tab' + (tab === 'existing' ? ' on' : ''), type: 'button', text: '기존 항목', onclick: () => showPicker('existing') });
        const list = el('div', { class: 'pjv-fields-list' });
        panel.replaceChildren(el('div', { class: 'pjv-fields-head' }, el('span', { class: 'pjv-fields-title', text: '필드' })), search, el('div', { class: 'pjv-fields-tabs' }, tNew, tExist), list);
        const renderNew = () => {
            const qs = search.value.trim().toLowerCase();
            const matches = PJV_FIELD_TYPES.filter((f) => !qs || f.label.toLowerCase().includes(qs) || f.desc.toLowerCase().includes(qs) || f.key.includes(qs));
            list.replaceChildren();
            if (!matches.length) {
                list.append(el('div', { class: 'pjv-fields-empty', text: '일치하는 형식이 없어요' }));
                return;
            }
            list.append(el('div', { class: 'pjv-fields-sec', text: '필드 형식' }));
            for (const f of matches) {
                const row = el('button', { class: 'pjv-field-opt', type: 'button' }, el('span', { class: 'pjv-field-opt-ic' }, pjvFieldIcon(f.key)), el('span', { class: 'pjv-field-opt-tx' }, el('span', { class: 'pjv-field-opt-name', text: f.label }), el('span', { class: 'pjv-field-opt-desc', text: f.desc })));
                row.onclick = () => panel.replaceChildren(pjvFieldConfigForm(projectId, f, reload, close, () => showPicker('new')));
                list.append(row);
            }
        };
        const renderExisting = async () => {
            list.replaceChildren(el('div', { class: 'pjv-fields-empty', text: '불러오는 중…' }));
            if (catalog === null) {
                try {
                    catalog = await api('/api/ui/v6/projects/' + projectId + '/field-catalog').then((d) => d.fields || []);
                }
                catch (_) {
                    catalog = [];
                }
            }
            const qs = search.value.trim().toLowerCase();
            const matches = catalog.filter((c) => !qs || String(c.name).toLowerCase().includes(qs));
            list.replaceChildren();
            if (!matches.length) {
                list.append(el('div', { class: 'pjv-fields-empty', text: '다른 프로젝트에 만든 필드가 없어요' }));
                return;
            }
            for (const c of matches) {
                const meta = PJV_FIELD_BY_KEY[c.field_type];
                const row = el('button', { class: 'pjv-field-opt', type: 'button' }, el('span', { class: 'pjv-field-opt-ic' }, pjvFieldIcon(c.field_type)), el('span', { class: 'pjv-field-opt-tx' }, el('span', { class: 'pjv-field-opt-name', text: c.name }), el('span', { class: 'pjv-field-opt-desc', text: meta ? meta.label : c.field_type })));
                row.onclick = () => pjvCreateField(projectId, { field_type: c.field_type, name: c.name, config: c.config || {} }, reload, close);
                list.append(row);
            }
        };
        search.oninput = () => { tab === 'new' ? renderNew() : renderExisting(); };
        (tab === 'new' ? renderNew : renderExisting)();
        setTimeout(() => search.focus(), 0);
    };
    showPicker('new');
}
// 형식 선택 후 설정 폼 — 이름 + (옵션/통화/별점) 설정 → 만들기.
function pjvFieldConfigForm(projectId, f, reload, close, back) {
    const wrap = el('div', { class: 'pjv-fcfg' });
    wrap.append(el('div', { class: 'pjv-fcfg-head' }, el('button', { class: 'pjv-fcfg-back', type: 'button', text: '←', title: '뒤로', onclick: back }), el('span', { class: 'pjv-fcfg-ic' }, pjvFieldIcon(f.key)), el('span', { class: 'pjv-fcfg-title', text: f.label })));
    const nameIn = el('input', { type: 'text', class: 'pjv-fcfg-name', value: f.label, maxlength: '120', placeholder: '필드 이름' });
    wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '이름' }), nameIn);
    let getConfig = () => ({});
    if (f.config === 'options') {
        const ob = pjvOptionsBuilder([]);
        wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '옵션' }), ob.el);
        getConfig = () => ({ options: ob.get() });
    }
    else if (f.config === 'money') {
        const sel = el('select', { class: 'pjv-fcfg-sel' });
        for (const [code, c] of Object.entries(PJV_CURRENCIES))
            sel.append(el('option', { value: code, text: c.label }));
        sel.value = 'KRW';
        wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '통화' }), sel);
        getConfig = () => ({ currency: sel.value, symbol: PJV_CURRENCIES[sel.value].symbol });
    }
    else if (f.config === 'rating') {
        const sel = el('select', { class: 'pjv-fcfg-sel' });
        for (const n of [3, 5, 10])
            sel.append(el('option', { value: String(n), text: n + '점 만점' }));
        sel.value = '5';
        wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '별 개수' }), sel);
        getConfig = () => ({ max: Number(sel.value) });
    }
    const createBtn = el('button', { class: 'pjv-fcfg-create', type: 'button', text: '만들기' });
    createBtn.onclick = () => {
        const name = nameIn.value.trim() || f.label;
        const config = getConfig();
        if (f.config === 'options' && (!config.options || !config.options.length)) {
            toast('옵션을 1개 이상 추가하세요', true);
            return;
        }
        pjvCreateField(projectId, { field_type: f.key, name, config }, reload, close);
    };
    wrap.append(el('div', { class: 'pjv-fcfg-actions' }, createBtn, el('button', { class: 'pjv-fcfg-cancel', type: 'button', text: '취소', onclick: back })));
    setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
    return wrap;
}
async function pjvCreateField(projectId, payload, reload, close) {
    try {
        await api('/api/ui/v6/projects/' + projectId + '/fields', { method: 'POST', body: JSON.stringify(payload) });
        if (close)
            close();
        toast('컬럼을 추가했어요');
        reload();
    }
    catch (e) {
        toast('컬럼 추가 실패 — ' + e.message, true);
    }
}
// 더블클릭 → 하위 태스크 인라인 생성(클릭업식). 같은 행에 입력칸 1개만, Enter=생성, Esc/빈 blur=취소.
function pjvShowInlineSubtask(projectId, parentTask, subBox, reload) {
    const existing = subBox.querySelector('.pjv-subadd');
    if (existing) {
        const i = existing.querySelector('input');
        if (i)
            i.focus();
        return;
    }
    const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '하위 태스크 이름 입력 후 Enter (Esc 취소)', maxlength: '200' });
    const row = el('div', { class: 'pjv-subadd' }, input);
    subBox.append(row);
    setTimeout(() => input.focus(), 0);
    let busy = false;
    input.addEventListener('blur', () => { if (!input.value.trim())
        row.remove(); });
    input.addEventListener('keydown', async (e) => {
        if (e.key === 'Escape') {
            input.value = '';
            row.remove();
            return;
        }
        if (e.key !== 'Enter')
            return;
        const name = input.value.trim();
        if (!name || busy)
            return;
        busy = true;
        input.disabled = true;
        try {
            await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name, parent_task_id: parentTask.id }) });
            reload();
        }
        catch (err) {
            toast('추가 실패 — ' + err.message, true);
            input.disabled = false;
            busy = false;
        }
    });
}
// 태스크 섹션 — [태스크 N개][Closed 토글] 헤더 + 컬럼헤더 + 상태 그룹(할 일/진행 중/Closed). 클릭업식 리스트뷰.
//  할 일·진행 중은 비어도 항상 표시(인라인 추가행). Closed(완료) 그룹은 기본 숨김 — 헤더의 Closed 토글로만 노출.
//  fields = 커스텀 필드 정의(루트 프로젝트). 컬럼 헤더·각 행에 필드 셀을 끼우고 grid-template 을 동적으로.
function pjvTasksSection(projectId, tasks, members, reload, fields) {
    fields = fields || [];
    const card = el('div', { class: 'card pjv-tasks-card', style: 'margin-bottom:18px' });
    // Closed 토글 버튼 — 누르면 태스크/하위태스크 popover. 활성(노출 중) 시 파란 강조.
    const closedBtn = el('button', { class: 'pjv-closed-btn', type: 'button', title: '닫힌(완료) 항목 표시' }, pjvCheckCircle(), el('span', { text: 'Closed' }));
    const syncBtn = () => closedBtn.classList.toggle('active', pjvClosedView.tasks || pjvClosedView.subtasks);
    syncBtn();
    // 본문 — Closed 토글 시 서버 재요청 없이 즉시 재렌더(이미 받은 tasks 를 필터).
    const body = el('div', { class: 'pjv-tasks-body' });
    const renderGroups = () => {
        body.replaceChildren();
        if (!tasks.length) {
            body.append(el('div', { class: 'pjv-empty-hint' }, el('b', { text: '아직 태스크가 없어요.' }), ' 아래 ', el('span', { class: 'pjv-empty-chip', text: '＋ 태스크' }), ' 를 눌러 이름을 적고 Enter — 첫 할 일을 추가하세요.'));
        }
        // 별도 컬럼헤더 행 없음 — 컬럼 라벨은 첫(맨 위) 그룹 헤더에 합친다(withCols).
        const buckets = { todo: [], in_progress: [], done: [] };
        const sep = pjvSubtaskMode.mode === 'separate';
        for (const t of tasks) {
            buckets[pjvStatusMeta(t.status).bucket].push(t);
            if (sep)
                for (const s of (t.subtasks || [])) {
                    if (!pjvClosedView.subtasks && s.status === 'done')
                        continue;
                    buckets[pjvStatusMeta(s.status).bucket].push(s);
                }
        }
        let firstShown = true;
        for (const key of ['in_progress', 'todo', 'done']) { // 진행 중을 할 일 위로(기본 레이아웃)
            if (key === 'done' && !pjvClosedView.tasks)
                continue; // Closed 그룹은 토글 시에만 노출
            body.append(pjvStatusGroup(projectId, key, buckets[key], members, reload, fields, firstShown));
            firstShown = false;
        }
    };
    // Closed 버튼 = 직접 토글. 한 번 누르면 닫힌(완료) 태스크가 보이고 버튼이 활성(파란) 상태, 다시 누르면 숨김.
    //  하위 닫힘 항목도 함께 따라오게 묶는다(Closed = '닫힌 것 보기' 한 동작).
    closedBtn.onclick = (e) => {
        e.stopPropagation();
        const nv = !pjvClosedView.tasks;
        pjvClosedView.tasks = nv;
        pjvClosedView.subtasks = nv;
        syncBtn();
        renderGroups();
    };
    // 좌상단 하위 태스크(Subtasks) 버튼 — 접힘/펼침/분리. 활성(펼침·분리) 시 파란 강조. (Closed 는 우측 유지)
    const subtaskBtn = el('button', { class: 'pjv-subtask-btn', type: 'button', title: '하위 태스크 표시 방식' }, pjvSubtaskIcon(), el('span', { class: 'pjv-subtask-btn-label', text: PJV_SUBTASK_BTNLABEL[pjvSubtaskMode.mode] }));
    const syncSubBtn = () => {
        subtaskBtn.classList.toggle('active', pjvSubtaskMode.mode !== 'collapsed');
        const lbl = subtaskBtn.querySelector('.pjv-subtask-btn-label');
        if (lbl)
            lbl.textContent = PJV_SUBTASK_BTNLABEL[pjvSubtaskMode.mode];
    };
    syncSubBtn();
    subtaskBtn.onclick = (e) => { e.stopPropagation(); pjvSubtaskMenu(subtaskBtn, () => { syncSubBtn(); renderGroups(); }); };
    card.append(el('div', { class: 'card-head' }, el('div', { class: 'pjv-tasks-head-left' }, el('h2', { text: '태스크' }), subtaskBtn), el('div', { class: 'card-head-actions' }, closedBtn)));
    card.append(body);
    renderGroups();
    return card;
}
// 상태 그룹 — head(캐럿·점·라벨·개수) + body(행들 + 인라인 추가행). 완료 그룹엔 추가행 없음.
// withCols=true 면(첫 그룹) 별도 컬럼헤더 행 대신 이 그룹 헤더에 컬럼 라벨(담당자/마감일/우선순위+커스텀)을 합쳐 컬럼 위에 정렬한다.
function pjvStatusGroup(projectId, key, list, members, reload, fields, withCols) {
    const m = PJV_TASK_STATUS[key];
    const body = el('div', { class: 'pjv-tgroup-body' });
    for (const t of list)
        body.append(pjvTaskRow(projectId, t, members, reload, 0, fields));
    const countEl = el('span', { class: 'pjv-tgroup-count', text: String(list.length) });
    if (key !== 'done')
        body.append(pjvAddRow(projectId, key, members, reload, body, countEl, fields));
    let gopen = true;
    const gcaret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: '▾', 'aria-expanded': 'true' });
    gcaret.onclick = () => {
        gopen = !gopen;
        gcaret.textContent = gopen ? '▾' : '▸';
        gcaret.setAttribute('aria-expanded', gopen ? 'true' : 'false');
        body.hidden = !gopen;
    };
    const dot = el('span', { class: 'pjv-status-dot sm ' + m.cls }, m.glyph ? el('span', { class: 'pjv-status-glyph', text: m.glyph }) : null);
    const labelEl = el('span', { class: 'pjv-tgroup-label', text: m.label });
    let head;
    if (withCols) {
        // 컬럼 라벨을 행 그리드에 맞춰 헤더에 합침(별도 thead 없음). 좌측 첫 칸 = 그룹 라벨.
        head = el('div', { class: 'pjv-tgroup-head pjv-tgroup-head-cols ' + m.cls }, el('div', { class: 'pjv-trow-title-cell' }, el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }), dot, labelEl, countEl, gcaret), el('div', { class: 'pjv-tcell pjv-colhead', text: '담당자' }), el('div', { class: 'pjv-tcell pjv-colhead', text: '마감일' }), el('div', { class: 'pjv-tcell pjv-colhead', text: '우선순위' }), ...(fields || []).map((f) => pjvColumnHead(f, projectId, reload)), el('div', { class: 'pjv-tcell pjv-tcell-add' }, pjvAddColumnButton(projectId, reload)));
        head.style.gridTemplateColumns = pjvGridTemplate(fields);
    }
    else {
        // 컬럼 없는 그룹(할 일/완료)도 첫 그룹(진행 중, withCols)과 같은 제목칸 구조(체크 스페이서+점+라벨)를
        // 써서 그룹 헤더의 가로 들여쓰기·정렬이 그룹마다 동일하게 보이도록 한다(#295).
        head = el('div', { class: 'pjv-tgroup-head ' + m.cls }, el('div', { class: 'pjv-trow-title-cell' }, el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }), dot, labelEl, countEl, gcaret));
    }
    return el('div', { class: 'pjv-tgroup' }, head, body);
}
// 인라인 추가행(클릭업식) — 클릭→입력칸, Enter=생성(연속 추가 위해 입력 유지·낙관적 삽입), Esc/빈 blur=접기.
//  생성은 그 그룹 상태로(todo 외엔 생성 후 status 패치). 모달 없이 그 자리에서 바로.
function pjvAddRow(projectId, status, members, reload, body, countEl, fields) {
    const row = el('div', { class: 'pjv-addrow' });
    let indentParent = null; // Tab 들여쓰기 — 바로 위 상위태스크의 하위로 만들 때 그 부모 {id,name}. Shift+Tab 으로 해제.
    const trigger = el('button', { class: 'pjv-addrow-trigger', type: 'button' }, el('span', { class: 'pjv-addrow-plus', text: '＋' }), el('span', { text: '태스크' }));
    const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '태스크 이름 입력 후 Enter (Esc 취소)', maxlength: '200' });
    // 생성 전 드래프트 — 담당자·마감·우선순위를 미리 지정해 생성 직후 한 번에 적용(클릭업식). 셀은 행과 동일.
    const draft = { assignee: null, due_date: null, priority: null };
    const cAssignee = el('div', { class: 'pjv-tcell' });
    const cDue = el('div', { class: 'pjv-tcell' });
    const cPriority = el('div', { class: 'pjv-tcell' });
    const setDraft = (p) => { Object.assign(draft, p); paintCells(); setTimeout(() => { if (row.classList.contains('editing'))
        input.focus(); }, 0); };
    function paintCells() {
        cAssignee.replaceChildren(pjvAssigneeControl(draft, members, (p) => { Object.assign(draft, p); }));
        cDue.replaceChildren(pjvDueControl(draft, setDraft));
        cPriority.replaceChildren(pjvPriorityControl(draft, setDraft));
    }
    const collapse = () => { row.classList.remove('editing'); draft.assignee = draft.due_date = draft.priority = null; indentParent = null; row.replaceChildren(trigger); };
    // 추가행 제목 칸 — 실제 태스크 행과 동일 구조(캐럿 자리 + 상태 동그라미 + 입력)로 그린다. 들여쓰면 paddingLeft 22px(하위 위치)
    //  + 상태 동그라미는 todo(점선). 안 들여쓰면 그룹 상태 동그라미. → 입력 텍스트·동그라미가 행과 픽셀 단위로 정확히 일치.
    const statusDotPlaceholder = (st) => {
        const meta = pjvStatusMeta(st);
        return el('span', { class: 'pjv-status-dot ' + meta.cls, 'aria-hidden': 'true' }, meta.glyph ? el('span', { class: 'pjv-status-glyph', text: meta.glyph }) : null);
    };
    const buildTitleCell = () => {
        // 실제 태스크 행 제목칸 맨 앞에는 선택 체크박스(.pjv-row-check, 16px)가 있다. 추가행에도 같은 폭의
        // 스페이서를 둬서 입력 글자가 시작되는 들여쓰기 위치를 행 제목과 정확히 같게 한다(#292).
        const tc = el('div', { class: 'pjv-trow-title-cell' }, el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }), el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' }), statusDotPlaceholder(indentParent ? 'todo' : status), input);
        if (indentParent)
            tc.style.paddingLeft = '22px';
        return tc;
    };
    // 펼침: 태스크 행과 동일한 그리드 — 이름 입력 + 담당자·마감·우선순위 드래프트 셀(생성 시 적용). 커스텀 필드는 생성 후 행에서.
    const expand = () => {
        row.classList.add('editing');
        row.style.gridTemplateColumns = pjvGridTemplate(fields);
        paintCells();
        row.replaceChildren(buildTitleCell(), cAssignee, cDue, cPriority, ...(fields || []).map(() => el('div', { class: 'pjv-tcell' })), el('div', { class: 'pjv-tcell pjv-tcell-add' }));
        input.focus();
    };
    trigger.onclick = expand;
    // Tab 들여쓰기 시각화 — 제목 칸을 한 단 들이고(하위 느낌) 안내문을 부모 이름으로 바꾼다.
    const applyIndent = () => {
        const old = row.querySelector('.pjv-trow-title-cell');
        if (old)
            old.replaceWith(buildTitleCell()); // 캐럿+동그라미+들여쓰기까지 하위태스크 행과 동일하게 다시 그림
        input.placeholder = indentParent
            ? ('“' + (indentParent.name || '상위 태스크') + '” 의 하위 — 이름 입력 후 Enter (Shift+Tab 해제)')
            : '태스크 이름 입력 후 Enter (Esc 취소)';
        input.focus();
    };
    let busy = false;
    // 생성 — Enter(keepOpen=연속추가) 또는 바깥클릭. 생성 후 드래프트(담당자·마감·우선순위)를 한 번에 패치.
    const commit = async (keepOpen) => {
        if (busy)
            return;
        const name = input.value.trim();
        if (!name) {
            if (!keepOpen)
                collapse();
            return;
        }
        busy = true;
        input.disabled = true;
        if (indentParent) {
            // Tab 들여쓰기 — 위 상위태스크의 하위로 생성. 생성 후 reload 로 중첩 반영(부모 caret·하위수 갱신).
            try {
                await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name, parent_task_id: indentParent.id }) });
                reload();
            }
            catch (err) {
                toast('하위 추가 실패 — ' + err.message, true);
                input.disabled = false;
                busy = false;
            }
            return;
        }
        try {
            const created = await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name }) }).then((d) => d && d.task);
            if (created && status !== 'todo') {
                await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify({ status }) }).catch(() => { });
            }
            const patch = {};
            if (draft.assignee)
                patch.assignee = draft.assignee;
            if (draft.due_date)
                patch.due_date = draft.due_date;
            if (draft.priority)
                patch.priority = draft.priority;
            if (created && Object.keys(patch).length) {
                await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify(patch) }).catch(() => { });
            }
            const t = Object.assign({ priority: null, assignee: null, due_date: null }, created, patch, { status, subtasks: [], field_values: {} });
            body.insertBefore(pjvTaskRow(projectId, t, members, reload, 0, fields), row);
            if (countEl)
                countEl.textContent = String((parseInt(countEl.textContent, 10) || 0) + 1);
            const card = row.closest('.pjv-tasks-card');
            const hint = card && card.querySelector('.pjv-empty-hint');
            if (hint)
                hint.remove();
            input.value = '';
            input.disabled = false;
            busy = false;
            draft.assignee = draft.due_date = draft.priority = null;
            paintCells();
            if (keepOpen)
                input.focus();
            else
                collapse();
        }
        catch (err) {
            toast('추가 실패 — ' + err.message, true);
            input.disabled = false;
            busy = false;
        }
    };
    // 바깥클릭(=커밋) 가드 — 셀 팝오버 편집 중이거나 행 내부 포커스면 보류(드래프트 설정 중 조기 생성 방지).
    input.addEventListener('blur', () => {
        setTimeout(() => {
            if (busy || !row.classList.contains('editing'))
                return;
            if (document.querySelector('.pjv-pop'))
                return; // 셀 팝오버 편집 중
            if (row.contains(document.activeElement))
                return; // 행 내부 포커스(셀 버튼 등)
            commit(false);
        }, 130);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            input.value = '';
            collapse();
            return;
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            if (e.shiftKey) {
                if (indentParent) {
                    indentParent = null;
                    applyIndent();
                    input.focus();
                }
                return;
            }
            // 들여쓰기 — 바로 위 상위태스크를 부모로(클릭업식). 위에 (상위)태스크가 없으면 무시.
            const prev = row.previousElementSibling;
            const pid = prev && prev.dataset ? prev.dataset.taskId : null;
            if (pid && prev.dataset.taskLevel !== 'subtask') {
                indentParent = { id: Number(pid), name: prev.dataset.taskName || '' };
                applyIndent();
                input.focus();
            }
            return;
        }
        // 한글(IME) 조합 중 Enter 는 글자 확정용 — 그때 생성하면 마지막 글자가 중복된 이름이 만들어진다(#293 와 동일 버그).
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            commit(true);
        }
    });
    collapse();
    return row;
}
// 행 오른쪽 끝 ⋯ 더보기 메뉴(클릭업식) — 하위 태스크 추가(상위만)·이름 변경·삭제.
function pjvRowMore(projectId, t, depth, reload, onAddSub) {
    const btn = el('button', { class: 'pjv-trow-more', type: 'button', title: '더보기', 'aria-label': '태스크 작업', text: '⋯' });
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu' });
        const close = pjvPopover(btn, menu);
        const mkItem = (label, onPick, danger) => {
            const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label }));
            b.onclick = () => { close(); onPick(); };
            return b;
        };
        if (depth === 0 && onAddSub)
            menu.append(mkItem('하위 태스크 추가', onAddSub));
        menu.append(mkItem('이름 변경', () => pjvRenameTask(btn, t, reload)));
        menu.append(mkItem('삭제', () => pjvDeleteTask(t, reload), true));
    };
    return btn;
}
// 이름 변경 — 앵커 아래 인라인 입력 팝오버. Enter 저장 / Esc·바깥클릭 취소.
function pjvRenameTask(anchor, t, reload) {
    const cur = t.name || t.title || '';
    const input = el('input', { type: 'text', class: 'pjv-rename-input', value: cur, maxlength: '200' });
    const close = pjvPopover(anchor, el('div', { class: 'pjv-menu pjv-rename-pop' }, input));
    input.onkeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const v = input.value.trim();
            close();
            if (v && v !== cur)
                pjvPatchTask(t.id, { name: v }, reload);
        }
    };
    setTimeout(() => { input.focus(); input.select(); }, 0);
}
// 삭제 — 확인 후 task_delete_v6. 하위 동반 삭제 경고. #/trash 복원 가능.
function pjvDeleteTask(t, reload) {
    const nm = t.name || t.title || '이 태스크';
    const nSub = (t.subtasks || []).length;
    const msg = "'" + nm + "' 태스크를 삭제할까요?" + (nSub ? '\n\n하위 ' + nSub + '개도 함께 삭제됩니다.' : '') + '\n\n#/trash 에서 복원할 수 있습니다.';
    if (!confirm(msg))
        return;
    (async () => {
        try {
            await api('/api/ui/v6/tasks/' + t.id + '/delete', { method: 'POST', body: JSON.stringify({}) });
            toast('삭제했습니다 — #/trash 에서 복원 가능');
            reload();
        }
        catch (e) {
            toast('삭제 실패 — ' + e.message, true);
        }
    })();
}
// 태스크 한 행 — [캐럿][상태점] 제목 [하위수] | 담당자 | 마감일 | 우선순위 | [⋯]. 하위는 중첩(상위만 하위 추가 가능).
function pjvTaskRow(projectId, t, members, reload, depth, fields) {
    depth = depth || 0;
    fields = fields || [];
    // 닫힌(완료) 하위는 Closed>하위태스크 토글 시에만 노출(클릭업 동형). separate 모드면 하위는 최상위 행으로 빠져 중첩 X.
    const allSubs = t.subtasks || [];
    const subsVisible = pjvClosedView.subtasks ? allSubs : allSubs.filter((s) => s.status !== 'done');
    const subs = pjvSubtaskMode.mode === 'separate' ? [] : subsVisible;
    const isDone = t.status === 'done';
    const wrap = el('div', { class: 'pjv-trow-wrap', 'data-task-id': t.id, 'data-task-name': t.name || t.title || '', 'data-task-level': t.level || 'task' });
    let open = false;
    const caret = subs.length
        ? el('button', { class: 'pjv-trow-caret', type: 'button', 'aria-expanded': 'false', text: '▸' })
        : el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' });
    // el() 로 구성 — null 자식을 건너뛴다(네이티브 .append(null) 은 "null" 텍스트를 삽입하므로 금지).
    // 태그 칩(클릭업식) — 이름 옆에 최대 2개 + 나머지는 "+N". 색은 태그 색.
    const tagsEl = pjvRowTagsEl(t, reload);
    const subcountEl = subs.length ? el('span', { class: 'pjv-trow-subcount pjv-subcount-ico clickable', role: 'button', tabindex: '0', title: subs.length + '개 하위 — 클릭하여 펼치기' }, pjvSubtaskIcon(), el('span', { text: String(subs.length) })) : null;
    const titleCell = el('div', { class: 'pjv-trow-title-cell' }, pjvRowGrip('task', t, { reload }), // 좌측 드래그 핸들(#366) — 잡고 끌어 순서 변경
    pjvRowCheck('task', t, { reload, projectId, members }), caret, pjvStatusControl(t, reload), el('span', { class: 'pjv-trow-title' + (isDone ? ' done' : ''), text: t.name || t.title || '(제목 없음)' }), subcountEl, tagsEl);
    if (depth)
        titleCell.style.paddingLeft = (depth * 22) + 'px';
    // 하위 영역 — 하위 행도 pjvTaskRow 재귀라 담당자·마감일·우선순위·커스텀필드까지 상위와 완전 동일하게 동작.
    const subBox = el('div', { class: 'pjv-trow-subs' });
    subBox.hidden = true;
    if (subs.length && depth < 4) {
        for (const s of subs)
            subBox.append(pjvTaskRow(projectId, s, members, reload, depth + 1, fields));
        const toggle = () => {
            open = !open;
            caret.textContent = open ? '▾' : '▸';
            caret.setAttribute('aria-expanded', open ? 'true' : 'false');
            subBox.hidden = !open;
        };
        caret.onclick = toggle;
        if (subcountEl) {
            subcountEl.onclick = (e) => { e.stopPropagation(); toggle(); };
            subcountEl.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                toggle();
            } };
        }
        // 펼침 모드 — 모든 하위를 처음부터 펼쳐 보여준다(개별 caret 으로 다시 접을 수 있음).
        if (pjvSubtaskMode.mode === 'expanded') {
            open = true;
            subBox.hidden = false;
            caret.textContent = '▾';
            caret.setAttribute('aria-expanded', 'true');
        }
    }
    // ⋯메뉴 '하위 태스크 추가'(상위 depth 0 만) → 부모 아래 인라인 입력행 펼치고 포커스. 모달/박스 없음.
    let subAddRow = null;
    const startAddSub = () => {
        subBox.hidden = false;
        open = true;
        if (caret.tagName === 'BUTTON') {
            caret.textContent = '▾';
            caret.setAttribute('aria-expanded', 'true');
        }
        if (!subAddRow) {
            const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '하위 태스크 이름 입력 후 Enter (Esc 취소)', maxlength: '200' });
            const tcell = el('div', { class: 'pjv-trow-title-cell' }, input);
            tcell.style.paddingLeft = ((depth + 1) * 22) + 'px';
            subAddRow = el('div', { class: 'pjv-addrow editing pjv-subaddrow' }, tcell, el('div', { class: 'pjv-tcell' }), el('div', { class: 'pjv-tcell' }), el('div', { class: 'pjv-tcell' }), ...fields.map(() => el('div', { class: 'pjv-tcell' })), el('div', { class: 'pjv-tcell pjv-tcell-add' }));
            subAddRow.style.gridTemplateColumns = pjvGridTemplate(fields);
            let busy = false;
            const remove = () => { if (subAddRow) {
                subAddRow.remove();
                subAddRow = null;
            } };
            const commit = async () => {
                if (busy)
                    return;
                const name = input.value.trim();
                if (!name) {
                    remove();
                    return;
                }
                busy = true;
                input.disabled = true;
                try {
                    await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name, parent_task_id: t.id }) });
                    reload();
                }
                catch (err) {
                    toast('하위 추가 실패 — ' + err.message, true);
                    input.disabled = false;
                    busy = false;
                }
            };
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    input.value = '';
                    remove();
                }
                else if (e.key === 'Enter') {
                    e.preventDefault();
                    commit();
                }
            });
            subBox.append(subAddRow);
        }
        const inp = subAddRow.querySelector('input');
        if (inp)
            inp.focus();
    };
    const moreBtn = pjvRowMore(projectId, t, depth, reload, (depth === 0 && t.level !== 'subtask') ? startAddSub : null);
    // 제목 우측 호버 아이콘 3개(클릭업식) — 하위 추가(상위만)·태그 편집·이름 변경. startAddSub 정의 후 붙인다.
    titleCell.append(pjvRowActions([
        (t.level !== 'subtask') ? { title: '하위 태스크 추가', icon: 'add', fn: () => startAddSub() } : null,
        { title: '태그 편집', icon: 'tag', fn: (b) => pjvTagPopover(b, t, reload) },
        { title: '이름 변경', icon: 'rename', fn: (b) => pjvRenameTask(b, t, reload) },
    ]));
    const rowEl = el('div', { class: 'pjv-trow' }, titleCell, el('div', { class: 'pjv-tcell' }, pjvAssigneeControl(t, members, (p) => pjvSaveTask(t.id, p))), el('div', { class: 'pjv-tcell' }, pjvDueControl(t, (p) => pjvPatchTask(t.id, p, reload))), el('div', { class: 'pjv-tcell' }, pjvPriorityControl(t, (p) => pjvPatchTask(t.id, p, reload))), ...fields.map((f) => el('div', { class: 'pjv-tcell pjv-fcell' }, pjvFieldControl(t, f, reload))), el('div', { class: 'pjv-tcell pjv-tcell-add' }, moreBtn));
    rowEl.style.gridTemplateColumns = pjvGridTemplate(fields);
    wrap.append(rowEl);
    wrap.append(subBox);
    return wrap;
}
// 태스크/하위 추가 폼 — 이름(필수)·설명(선택). parentTaskId 있으면 하위로 생성(parent_task_id).
function pjvAddTask(projectId, parentTaskId, reload) {
    const nameIn = el('input', { type: 'text', placeholder: parentTaskId ? '하위 태스크 이름' : '태스크 이름', maxlength: '200' });
    const descIn = el('textarea', { rows: '2', placeholder: '설명 (선택)', maxlength: '4000' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '추가' });
    const back = overlayBox(parentTaskId ? '하위 태스크 추가' : '새 태스크', el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn), el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '설명 (선택)' }), descIn), el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
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
            await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({
                    name, description: descIn.value.trim() || undefined,
                    parent_task_id: parentTaskId != null ? parentTaskId : undefined,
                }) });
            back.remove();
            toast(parentTaskId ? '하위 태스크를 추가했습니다' : '태스크를 추가했습니다');
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
// 필요 지식 / 산출 지식 — 두 섹션. 각 행은 지식 상세(#/k/:name)로 링크.
function companyTimelineSection() {
    const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
    const body = el('div', {});
    const st = { type: '' };
    let members = [];
    let acts = [];
    let shown = 6;
    const nameOf = (pid) => { const m = members.find((x) => x.id === pid); return (m && m.display_name) || pid || '—'; };
    const TYPES = [['', '전체'], ['feature', '기능'], ['fix', '수정'], ['decision', '결정'], ['docs', '문서'], ['research', '리서치'], ['review', '검토'], ['chore', '운영'], ['other', '기타']];
    const chipsBar = el('div', { class: 'proj-tl-filter' });
    const paintChips = () => chipsBar.replaceChildren(...TYPES.map(([v, label]) => el('button', { class: 'proj-tl-chip' + (st.type === v ? ' active' : ''), text: label, onclick: () => { st.type = v; paintChips(); load(); } })));
    paintChips();
    card.append(chipsBar, body);
    api('/api/ui/dash/members').then((d) => { members = (d && d.members) || []; if (acts.length)
        render(); }).catch(() => { });
    load();
    return card;
    async function load() {
        body.replaceChildren(skeletonRows(4));
        try {
            const qs = '?limit=200' + (st.type ? '&type=' + encodeURIComponent(st.type) : '');
            acts = await api('/api/ui/activity/list' + qs).then((d) => (Array.isArray(d) ? d : (d && d.rows) || []));
        }
        catch (e) {
            body.replaceChildren(errorNote(e, '작업을 불러오지 못했습니다'));
            return;
        }
        shown = 6;
        render();
    }
    function render() {
        if (!acts.length) {
            body.replaceChildren(el('div', { class: 'empty', text: '아직 기록된 작업이 없습니다.' }));
            return;
        }
        const list = el('div', { class: 'proj-tl-list' }, ...acts.slice(0, shown).map(actRow));
        body.replaceChildren(list);
        if (acts.length > shown) {
            body.append(el('button', { class: 'btn btn-ghost btn-sm proj-tl-more',
                text: '＋ ' + (acts.length - shown) + '개 더 보기', onclick: () => { shown += 10; render(); } }));
        }
    }
    function actRow(a) { return activityTimelineRow(a, nameOf); }
}
// 한 섹션(진행 중 / 완료) — 카드 + 개수 배지 + 행 리스트(비었으면 안내).
function projectSection(label, list, emptyText, reload, done, opts) {
    const card = el('div', { class: 'card', style: 'margin-bottom:18px' }, el('div', { class: 'card-head' }, el('h3', { class: 'project-sec-title' }, label, el('span', { class: 'project-count', text: String(list.length) }))));
    if (!list.length) {
        card.append(el('div', { class: 'empty', text: emptyText }));
        return card;
    }
    card.append(el('div', { class: 'project-grid' + (done ? ' done' : '') }, ...list.map((p) => projectTile(p, reload, opts))));
    return card;
}
// 프로젝트 타일 카드 — 이름·설명·팀원 아바타(facepile)·메타 + 상태 토글. 카드 클릭=상세.
//  opts.statusBase / opts.detailBase 로 v1(/api/ui/projects, #/projects)·v6(/api/ui/v6/projects, #/projects2/p) 공용.
function projectTile(p, reload, opts) {
    const statusBase = (opts && opts.statusBase) || '/api/ui/projects/';
    const detailBase = (opts && opts.detailBase) || '#/projects/';
    const select = opts && opts.select; // 선택(일괄삭제) 모드 — 있으면 클릭=체크 토글, 상태 토글 숨김.
    const selectable = !!select && select.canSelect(p); // 내가 만든 것만 선택 가능.
    const isDone = p.status === 'done';
    const tile = el('div', { class: 'project-tile' + (isDone ? ' done' : '') + (select ? ' select-mode' : '') });
    if (select && selectable) {
        tile.classList.add('selectable');
        const cb = el('span', { class: 'project-tile-check', 'aria-hidden': 'true' });
        const apply = (on) => { tile.classList.toggle('selected', on); cb.textContent = on ? '✓' : ''; tile.setAttribute('aria-checked', on ? 'true' : 'false'); };
        apply(select.ids.has(p.id));
        tile.append(cb);
        tile.setAttribute('role', 'checkbox');
        tile.setAttribute('tabindex', '0');
        const toggle = () => { const on = !select.ids.has(p.id); if (on)
            select.ids.add(p.id);
        else
            select.ids.delete(p.id); apply(on); select.onToggle(); };
        tile.addEventListener('click', toggle);
        tile.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggle();
        } });
    }
    else if (select) {
        // 선택 모드지만 내 프로젝트 아님 — 선택 불가(흐리게), 클릭은 상세로.
        tile.classList.add('not-selectable');
        tile.addEventListener('click', () => { location.hash = detailBase + p.id; });
    }
    else {
        // 완료 카드는 비활성 느낌 — 전체클릭 대신 아래 '보기' 버튼으로 접근. 활성 카드만 전체클릭=상세.
        if (!isDone)
            tile.addEventListener('click', () => { location.hash = detailBase + p.id; });
    }
    tile.append(el('div', { class: 'project-tile-name', text: p.name }));
    if (p.description)
        tile.append(el('div', { class: 'project-tile-desc', text: p.description }));
    const members = p.members || [];
    if (members.length) {
        const faces = el('div', { class: 'project-tile-faces' });
        for (const m of members.slice(0, 5)) {
            faces.append(el('span', { class: 'project-face', style: 'background:' + avatarColor(m.member_id), title: m.display_name || m.member_id, text: initials(m.display_name || m.member_id) }));
        }
        if (members.length > 5)
            faces.append(el('span', { class: 'project-face more', text: '+' + (members.length - 5) }));
        tile.append(faces);
    }
    const when = isDone ? (p.completed_at || p.updated_at) : (p.updated_at || p.created_at);
    const meta = el('div', { class: 'project-tile-meta', text: (isDone ? '완료 ' : '갱신 ') + (when ? relTime(when) : '') });
    const foot = el('div', { class: 'project-tile-foot' }, meta);
    if (!select) {
        // 비선택 모드만 상태 토글 노출 — 선택 모드에선 카드 클릭(=체크)과 충돌 방지 위해 숨김.
        const changeStatus = async (ev, status, okMsg) => {
            ev.stopPropagation();
            const btn = ev.currentTarget;
            btn.disabled = true;
            try {
                await api(statusBase + p.id + '/status', { method: 'POST', body: JSON.stringify({ status }) });
                toast(okMsg);
                reload();
            }
            catch (e) {
                toast('실패 — ' + e.message, true);
                btn.disabled = false;
            }
        };
        if (isDone) {
            // 완료 카드 — '보기'(상세 접근) + '진행 중으로'(재개). 둘 다 ghost(파란 강조 없음, 비활성 톤 유지).
            const viewBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '보기',
                onclick: (ev) => { ev.stopPropagation(); location.hash = detailBase + p.id; } });
            const reBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '진행 중으로',
                onclick: (ev) => changeStatus(ev, 'active', '진행 중으로 옮겼습니다') });
            foot.append(el('div', { class: 'project-tile-acts' }, viewBtn, reBtn));
        }
        else {
            const toggle = el('button', { class: 'btn btn-sm btn-primary', text: '완료',
                onclick: (ev) => changeStatus(ev, 'done', '완료로 표시했습니다') });
            foot.append(toggle);
        }
    }
    else if (!selectable) {
        foot.append(el('span', { class: 'project-tile-mine-no', text: '내 프로젝트 아님' }));
    }
    tile.append(foot);
    return tile;
}
// 팀원 선택 위젯 — 이름 검색으로 하나씩 추가(클릭), 선택된 사람은 칩으로(× 제거). 생성·수정 공용.
//  동기 반환(즉시 로딩표시) + 비동기 채움. getSelected() 가 현재 선택 id 배열.
function memberPicker(preselected, opts) {
    const selected = new Set(preselected || []);
    let all = [];
    const chips = el('div', { class: 'proj-mp-chips' });
    const searchIn = el('input', { type: 'text', class: 'proj-mp-search', placeholder: '이름으로 검색해 추가…' });
    const results = el('div', { class: 'proj-mp-results' }, el('span', { class: 'admin-hint', text: '불러오는 중…' }));
    const box = el('div', { class: 'proj-mp' }, chips, searchIn, results);
    function paintChips() {
        const sel = all.filter((m) => selected.has(m.id));
        if (!sel.length) {
            chips.replaceChildren(el('span', { class: 'admin-hint', text: '아직 선택된 팀원이 없어요.' }));
            return;
        }
        chips.replaceChildren(...sel.map((m) => el('span', { class: 'proj-mp-chip' }, el('span', { class: 'proj-team-ava', style: 'background:' + avatarColor(m.id), text: initials(m.display_name || m.id) }), el('span', { text: m.display_name || m.id }), el('button', { class: 'proj-mp-chip-x', type: 'button', text: '×', onclick: () => { selected.delete(m.id); paintChips(); paintResults(); } }))));
    }
    function paintResults() {
        if (!all.length) {
            results.replaceChildren(el('span', { class: 'admin-hint', text: '등록된 사람 구성원이 없습니다.' }));
            return;
        }
        const q = searchIn.value.trim().toLowerCase();
        const cand = all.filter((m) => !selected.has(m.id) && (!q || (m.display_name || m.id).toLowerCase().includes(q)));
        if (!cand.length) {
            results.replaceChildren(el('div', { class: 'proj-mp-empty', text: q ? '일치하는 사람이 없어요.' : '추가할 수 있는 사람을 모두 골랐어요.' }));
            return;
        }
        results.replaceChildren(...cand.map((m) => el('div', { class: 'proj-mp-row', onclick: () => { selected.add(m.id); searchIn.value = ''; paintChips(); paintResults(); searchIn.focus(); } }, el('span', { class: 'proj-mp-ava', style: 'background:' + avatarColor(m.id), text: initials(m.display_name || m.id) }), el('span', { class: 'proj-mp-name', text: m.display_name || m.id }), el('span', { class: 'proj-mp-add', text: '＋ 추가' }))));
    }
    searchIn.addEventListener('input', paintResults);
    api('/api/ui/dash/members').then((d) => {
        all = (d && d.members) || [];
        // 생성 폼 기본값: 나(생성자)를 디폴트 선택 — 활성 구성원 목록에 실제 있을 때만(유령 id 방지). ×로 해제 가능.
        if (opts && opts.includeMe) {
            const meId = state.me && state.me.userId;
            if (meId && all.some((m) => m.id === meId))
                selected.add(meId);
        }
        paintChips();
        paintResults();
    })
        .catch(() => results.replaceChildren(el('span', { class: 'admin-hint', text: '팀원 목록을 불러오지 못했습니다.' })));
    return { box, getSelected: () => [...selected] };
}
// 새 프로젝트 오버레이 폼 — 이름(필수)·설명(선택)·팀원. 생성 시 폴더 자동 생성 + 새 전용 페이지로 이동.
async function authDownload(url, filename) {
    const token = localStorage.getItem(TOKEN_KEY);
    let res;
    try {
        res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    }
    catch (e) {
        toast('다운로드 실패 — ' + e.message, true);
        return;
    }
    if (!res.ok) {
        toast('다운로드 실패 (' + res.status + ')', true);
        return;
    }
    const blob = await res.blob();
    const a = el('a', { href: URL.createObjectURL(blob), download: filename || 'download' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// 인증 fetch 업로드(PUT raw 스트림). 파일 본문 그대로 — Content-Type 비워 서버가 스트림으로 받음.
async function authUpload(url, file) {
    const token = localStorage.getItem(TOKEN_KEY);
    const res = await fetch(url, { method: 'PUT', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: file });
    if (!res.ok) {
        let m = '';
        try {
            m = (await res.json()).error;
        }
        catch (_) { /* */ }
        throw new Error(m || ('업로드 실패 (' + res.status + ')'));
    }
}
// 진행률 콜백 업로드 — fetch 는 업로드 progress 가 없어 XHR 사용. onProgress(pct 0~100).
function authUploadProgress(url, file, onProgress) {
    return new Promise((resolve, reject) => {
        const token = localStorage.getItem(TOKEN_KEY);
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', url);
        if (token)
            xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && onProgress)
            onProgress((ev.loaded / ev.total) * 100); };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300)
                resolve();
            else {
                let m = '';
                try {
                    m = JSON.parse(xhr.responseText).error;
                }
                catch (_) { /* */ }
                reject(new Error(m || ('업로드 실패 (' + xhr.status + ')')));
            }
        };
        xhr.onerror = () => reject(new Error('네트워크 오류'));
        xhr.send(file);
    });
}
function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024)
        return n + ' B';
    if (n < 1024 * 1024)
        return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024)
        return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}
function fileExt(name) { const i = String(name || '').lastIndexOf('.'); return i >= 0 ? name.slice(i + 1).toLowerCase() : ''; }
// 클립보드 붙여넣기 이미지 → 업로드용 File(고유 이름). File.name 은 read-only 라 새 File 로 감싼다.
//  같은 시각 다중 붙여넣기 충돌 방지로 날짜-시각(+ms 2자리, 다중이면 순번). 공유폴더는 유니코드 보존이라 한글 이름 OK.
function pastedImageFile(blob, seq) {
    const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tiff' };
    const ext = extMap[blob.type] || (String(blob.type).split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const ts = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + p(d.getMilliseconds()).slice(0, 2);
    const name = '붙여넣기-' + ts + (seq ? '-' + (seq + 1) : '') + '.' + ext;
    try {
        return new File([blob], name, { type: blob.type });
    }
    catch (_) {
        try {
            blob.name = name;
        }
        catch (_2) { /* File.name read-only */ }
        return blob;
    }
}
// 붙여넣기 전 이름 지정 + 동작 안내 팝업 — 클립보드 이미지를 공유 폴더로 올리기 전에 띄운다.
//  단일: [이름][.확장자(고정 태그)]. 다중: 공통 베이스명 + 각 파일에 -1,-2…와 원래 확장자. 확인 시 onConfirm(files).
//  확장자를 입력칸 밖 고정 태그로 둬, 타이핑 중 확장자가 지워지는 것을 구조적으로 막는다.
function openPasteDialog(imgs, destLabel, onConfirm) {
    const multi = imgs.length > 1;
    const defName = pastedImageFile(imgs[0], 0).name; // 기존 자동이름 규칙 재사용
    const ext0 = fileExt(defName);
    const stem0 = ext0 ? defName.slice(0, defName.length - ext0.length - 1) : defName;
    const nameIn = el('input', { type: 'text', value: stem0, maxlength: '120', placeholder: '파일 이름' });
    const action = el('p', { class: 'paste-action' }, '클립보드의 ', el('b', { text: '이미지 ' + imgs.length + '개' }), ' 를 ', el('b', { text: destLabel }), ' 에 업로드합니다.');
    const nameRow = el('div', { class: 'paste-name-row' }, nameIn, multi ? null : el('span', { class: 'paste-ext', text: '.' + (ext0 || 'png') }));
    const hint = multi
        ? el('p', { class: 'admin-hint', text: '각 파일 이름 뒤에 -1, -2 … 와 원래 확장자가 붙습니다.' })
        : null;
    const saveBtn = el('button', { class: 'btn btn-primary', text: multi ? (imgs.length + '개 올리기') : '올리기' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
    const back = overlayBox('붙여넣기', action, el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameRow, hint), el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
    setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0); // 확장자는 입력칸 밖이라 전체선택해도 안전
    const go = () => {
        let stem = nameIn.value.trim().replace(/[/\\]/g, '-').replace(/^\.+/, '').replace(/\s+/g, ' ').trim();
        if (!stem)
            stem = stem0;
        const files = imgs.map((b, i) => {
            const ext = fileExt(pastedImageFile(b, 0).name) || 'png';
            const nm = (multi ? stem + '-' + (i + 1) : stem) + '.' + ext;
            try {
                return new File([b], nm, { type: b.type });
            }
            catch (_) {
                try {
                    b.name = nm;
                }
                catch (_2) { /* read-only */ }
                return b;
            }
        });
        back.remove();
        onConfirm(files);
    };
    saveBtn.onclick = go;
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter')
        go(); });
}
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
function iconFor(name) {
    const e = fileExt(name);
    if (IMG_EXTS.includes(e))
        return '🖼️';
    if (['md', 'txt', 'rtf', 'csv'].includes(e))
        return '📝';
    if (e === 'pdf')
        return '📕';
    if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(e))
        return '🗜️';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(e))
        return '🎬';
    if (['mp3', 'wav', 'flac', 'm4a'].includes(e))
        return '🎵';
    if (['js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'json', 'html', 'css', 'java', 'go', 'rs', 'c', 'cpp', 'rb', 'php', 'yml', 'yaml', 'toml'].includes(e))
        return '📄';
    return '📄';
}
// 공유 폴더 단색 라인 아이콘 — 컬러 이모지 대신(calm 예산: 색이 아니라 형태로 구분).
//  currentColor 를 상속하므로 색·획굵기는 CSS(.fic)에서 통제. 확장자→형태만 매핑(타입은 파일명 확장자가 이미 말해줌).
function fileKind(name) {
    const e = fileExt(name);
    if (IMG_EXTS.includes(e))
        return 'image';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(e))
        return 'video';
    if (['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'].includes(e))
        return 'audio';
    if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(e))
        return 'archive';
    if (['js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'json', 'html', 'css', 'java', 'go', 'rs', 'c', 'cpp', 'rb', 'php', 'yml', 'yaml', 'toml'].includes(e))
        return 'code';
    return 'file';
}
const FILE_ICON_GLYPHS = {
    dir: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
    file: [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14 3 14 8 19 8' }], ['line', { x1: 9, y1: 13, x2: 15, y2: 13 }], ['line', { x1: 9, y1: 16.5, x2: 15, y2: 16.5 }]],
    image: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['circle', { cx: 8.5, cy: 9.5, r: 1.5 }], ['polyline', { points: '21 16 15.5 11 5 20' }]],
    video: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['polygon', { points: '10 8.5 16 12 10 15.5 10 8.5' }]],
    audio: [['path', { d: 'M9 17V5l10-2v12' }], ['circle', { cx: 6, cy: 17, r: 3 }], ['circle', { cx: 16, cy: 15, r: 3 }]],
    archive: [['rect', { x: 4, y: 4, width: 16, height: 4, rx: 1 }], ['path', { d: 'M5.5 8v10a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8' }], ['line', { x1: 10.5, y1: 12, x2: 13.5, y2: 12 }]],
    code: [['polyline', { points: '15 7 20 12 15 17' }], ['polyline', { points: '9 7 4 12 9 17' }]],
};
// 파일/폴더 단색 라인 아이콘 — 동시 리팩터가 이 함수 정의를 지우고 호출처(공유폴더 참조목록·파일 필드·설정 참고파일)는
//  남겨 ReferenceError(fileIconSvg is not defined)가 났다. fileKind·FILE_ICON_GLYPHS(둘 다 생존)에 기반해 복구.
function fileIconSvg(name, isDir) {
    const kind = isDir ? 'dir' : fileKind(name);
    const node = sv('svg', { class: 'fic fic-' + kind, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    for (const [t, a] of (FILE_ICON_GLYPHS[kind] || FILE_ICON_GLYPHS.file))
        node.append(sv(t, a));
    return node;
}
function fileThumb(id, it, rel, base) {
    if (it.type === 'dir')
        return folderThumb();
    const ext = fileExt(it.name);
    if (IMG_EXTS.includes(ext))
        return imageThumb(id, rel, base, it.name);
    return docIcon(ext);
}
// 폴더 — 맥 느낌 소프트 블루(두 톤).
function folderThumb() {
    const n = sv('svg', { class: 'ft ft-folder', viewBox: '0 0 48 40', fill: 'none', 'aria-hidden': 'true' });
    n.append(sv('path', { class: 'ft-folder-tab', d: 'M4 9a3 3 0 0 1 3-3h10.5l4 4H4z' }));
    n.append(sv('path', { class: 'ft-folder-body', d: 'M4 12a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z' }));
    return n;
}
// 타입별 파일 라벨/색 — 동시 리팩터가 이 const 정의를 지우고 docIcon 의 사용처만 남겨 공유 폴더 파일 아이콘이
//  ReferenceError(FILE_TYPE_META is not defined)로 깨졌다(→ '폴더를 불러오지 못했습니다'). 사용처 바로 위에 복구.
const FILE_TYPE_META = {
    pdf: { label: 'PDF', cls: 'ft-pdf' },
    doc: { label: 'DOC', cls: 'ft-word' }, docx: { label: 'DOC', cls: 'ft-word' }, hwp: { label: 'HWP', cls: 'ft-word' }, hwpx: { label: 'HWP', cls: 'ft-word' },
    ppt: { label: 'PPT', cls: 'ft-ppt' }, pptx: { label: 'PPT', cls: 'ft-ppt' }, key: { label: 'KEY', cls: 'ft-ppt' },
    xls: { label: 'XLS', cls: 'ft-xls' }, xlsx: { label: 'XLS', cls: 'ft-xls' }, csv: { label: 'CSV', cls: 'ft-xls' },
    zip: { label: 'ZIP', cls: 'ft-zip' }, tar: { label: 'TAR', cls: 'ft-zip' }, gz: { label: 'GZ', cls: 'ft-zip' }, rar: { label: 'RAR', cls: 'ft-zip' }, '7z': { label: '7Z', cls: 'ft-zip' },
    mp3: { label: 'MP3', cls: 'ft-av' }, wav: { label: 'WAV', cls: 'ft-av' }, m4a: { label: 'M4A', cls: 'ft-av' }, flac: { label: 'FLAC', cls: 'ft-av' },
    mp4: { label: 'MP4', cls: 'ft-av' }, mov: { label: 'MOV', cls: 'ft-av' }, webm: { label: 'WEBM', cls: 'ft-av' }, mkv: { label: 'MKV', cls: 'ft-av' },
    md: { label: 'MD', cls: 'ft-txt' }, txt: { label: 'TXT', cls: 'ft-txt' }, rtf: { label: 'RTF', cls: 'ft-txt' },
};
// 타입별 색 문서 아이콘 — 흰 페이지 + 접힌 모서리 + 색 띠 + 라벨(PDF/DOC/PPT/XLS …).
function docIcon(ext) {
    const meta = FILE_TYPE_META[ext] || { label: (String(ext || '').toUpperCase().slice(0, 4) || 'FILE'), cls: 'ft-generic' };
    const n = sv('svg', { class: 'ft ft-file ' + meta.cls, viewBox: '0 0 40 48', fill: 'none', 'aria-hidden': 'true' });
    n.append(sv('path', { class: 'ft-page', d: 'M6 2.5h17.5L34 13v30.5a2.5 2.5 0 0 1-2.5 2.5h-25A2.5 2.5 0 0 1 4 43.5V5A2.5 2.5 0 0 1 6 2.5z' }));
    n.append(sv('path', { class: 'ft-fold', d: 'M23.5 2.5V11a2 2 0 0 0 2 2H34z' }));
    n.append(sv('rect', { class: 'ft-band', x: 4, y: 29, width: 30, height: 12, rx: 2.5 }));
    const t = sv('text', { class: 'ft-label', x: 19, y: 37.8, 'text-anchor': 'middle' });
    t.textContent = meta.label;
    n.append(t);
    return n;
}
// 이미지 — 실제 썸네일. 파일 API 가 Bearer 인증이라 <img src> 직접 불가 → blob fetch 후 objectURL. 보일 때 지연 로드.
function imageThumb(id, rel, base, name) {
    const wrap = el('div', { class: 'ft ft-img' });
    const img = el('img', { alt: name });
    wrap.append(img);
    wrap._loadThumb = async () => {
        const token = localStorage.getItem(TOKEN_KEY);
        const url = (base || '/api/ui/projects/') + id + '/file?path=' + encodeURIComponent(rel);
        try {
            const res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
            if (!res.ok) {
                wrap.classList.add('ft-img-err');
                return;
            }
            img.src = URL.createObjectURL(await res.blob());
            wrap.classList.add('loaded');
        }
        catch (_) {
            wrap.classList.add('ft-img-err');
        }
    };
    thumbObserve(wrap);
    return wrap;
}
// 지연 로드 — 화면(+여유 200px)에 들어올 때 _loadThumb() 1회. IntersectionObserver 없으면 즉시.
let _thumbObserver = null;
function thumbObserve(wrap) {
    if (typeof IntersectionObserver === 'undefined') {
        if (wrap._loadThumb)
            wrap._loadThumb();
        return;
    }
    if (!_thumbObserver) {
        _thumbObserver = new IntersectionObserver((entries) => {
            for (const e of entries)
                if (e.isIntersecting) {
                    _thumbObserver.unobserve(e.target);
                    if (e.target._loadThumb)
                        e.target._loadThumb();
                }
        }, { rootMargin: '200px' });
    }
    _thumbObserver.observe(wrap);
}
// 텍스트로 열어 편집 가능한 확장자(화이트리스트). 그 외 바이너리(docx/xlsx/zip 등)는 textarea 로 열면 깨지므로 다운로드.
const TEXT_EXTS = ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs',
    'py', 'sh', 'bash', 'zsh', 'rb', 'go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'java', 'kt', 'swift', 'php',
    'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml', 'svg', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env',
    'sql', 'vue', 'svelte', 'r', 'lua', 'pl', 'dart', 'gradle', 'properties', 'gitignore', 'dockerfile'];
// 파일 뷰어 — 이미지=미리보기, PDF=내장 뷰어(iframe), 텍스트=편집·저장, 그 외 바이너리=다운로드 안내.
async function openFileViewer(id, rel, name, reload, base) {
    const B = base || '/api/ui/projects/';
    const token = localStorage.getItem(TOKEN_KEY);
    const url = B + id + '/file?path=' + encodeURIComponent(rel);
    const ext = fileExt(name);
    const isImg = IMG_EXTS.includes(ext);
    const isPdf = ext === 'pdf';
    const isText = TEXT_EXTS.includes(ext);
    const footer = (back, extra) => el('div', { class: 'ov-actions' }, ...(extra || []), el('button', { class: 'btn btn-ghost', text: '다운로드', onclick: () => authDownload(url + '&download=1', name) }), el('button', { class: 'btn btn-ghost', text: '닫기', onclick: () => back.remove() }));
    // 미리보기 미지원 바이너리 — 다운로드만(fetch 생략).
    if (!isImg && !isPdf && !isText) {
        const back = overlayBox(name, el('p', { class: 'admin-hint', text: '미리보기를 지원하지 않는 형식이에요. 다운로드해서 확인하세요.' }));
        back.querySelector('.ov-box').append(footer(back));
        return;
    }
    let res;
    try {
        res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    }
    catch (_) {
        toast('파일을 열지 못했습니다', true);
        return;
    }
    if (res.status === 413) {
        const back = overlayBox(name, el('p', { class: 'admin-hint', text: '미리보기엔 너무 큰 파일이에요. 다운로드해서 확인하세요.' }));
        back.querySelector('.ov-box').append(footer(back));
        return;
    }
    if (!res.ok) {
        toast('파일을 열지 못했습니다 (' + res.status + ')', true);
        return;
    }
    const blob = await res.blob();
    if (isImg) {
        const back = overlayBox(name, el('img', { class: 'proj-file-img', src: URL.createObjectURL(blob), alt: name }));
        back.querySelector('.ov-box').append(footer(back));
        return;
    }
    if (isPdf) {
        // blob 에 MIME 이 없으면 iframe 이 PDF 를 텍스트로 표시(원시 %PDF 바이트 노출) — application/pdf 로 강제 후 네이티브 뷰어 렌더.
        const pdfBlob = blob.type === 'application/pdf' ? blob : new Blob([await blob.arrayBuffer()], { type: 'application/pdf' });
        const back = overlayBox(name, el('iframe', { class: 'proj-file-pdf', src: URL.createObjectURL(pdfBlob) }));
        const box = back.querySelector('.ov-box');
        box.classList.add('ov-box-wide');
        box.append(footer(back));
        return;
    }
    // 텍스트 — 편집/저장
    const ta = el('textarea', { class: 'proj-file-edit' });
    ta.value = await blob.text();
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const back = overlayBox(name, ta);
    back.querySelector('.ov-box').append(footer(back, [saveBtn]));
    saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        try {
            await authUpload(url, new Blob([ta.value]));
            toast('저장했습니다');
            back.remove();
            if (reload)
                reload();
        }
        catch (e) {
            toast(e.message, true);
            saveBtn.disabled = false;
        }
    };
}
// 공유 폴더 아이콘 카드(맥 데스크탑 느낌) — 폴더는 onDir(rel), 파일은 뷰어 팝업. 섹션·전체보기 팝업 공용.
function projFileCardEl(id, it, rel, onDir, reload, base, select) {
    const isDir = it.type === 'dir';
    const c = el('div', { class: 'proj-file-card' + (select ? ' select-mode' : ''), title: it.name }, el('div', { class: 'proj-file-card-ic' }, fileThumb(id, it, rel, base)), el('div', { class: 'proj-file-card-nm', text: it.name }), el('div', { class: 'proj-file-card-sz', text: isDir ? '폴더' : fmtSize(it.size) }));
    if (select) {
        // 선택 모드 — 카드 클릭 = 체크 토글(열기/진입 대신). 파일·폴더 모두 골라 일괄 삭제 가능.
        const ids = select.ids;
        const on0 = ids.has(rel);
        if (on0)
            c.classList.add('selected');
        const cb = el('span', { class: 'proj-file-check', 'aria-hidden': 'true', text: on0 ? '✓' : '' });
        c.append(cb);
        c.setAttribute('role', 'checkbox');
        c.setAttribute('tabindex', '0');
        c.setAttribute('aria-checked', on0 ? 'true' : 'false');
        const toggle = () => { const v = !ids.has(rel); if (v)
            ids.add(rel);
        else
            ids.delete(rel); c.classList.toggle('selected', v); cb.textContent = v ? '✓' : ''; c.setAttribute('aria-checked', v ? 'true' : 'false'); select.onToggle(); };
        c.onclick = toggle;
        c.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggle();
        } });
    }
    else {
        c.onclick = isDir ? () => onDir(rel) : () => openFileViewer(id, rel, it.name, reload, base);
    }
    return c;
}
function projUpCardEl(onClick) {
    return el('div', { class: 'proj-file-card', onclick: onClick }, el('div', { class: 'proj-file-card-ic', text: '↩' }), el('div', { class: 'proj-file-card-nm', text: '상위 폴더' }));
}
// 전체 보기 목록의 한 행 — [아이콘][이름][크기][호버 시 액션 아이콘]. 폴더는 진입, 파일은 뷰어.
function projFileRowEl(id, it, rel, onDir, reload, base) {
    const B = base || '/api/ui/projects/';
    const isDir = it.type === 'dir';
    const acts = el('div', { class: 'proj-file-lacts' }, fileIconBtn('✎', '이름변경', (ev) => { ev.stopPropagation(); renameEntry(id, rel, it.name, isDir, reload, B); }), isDir ? null : fileIconBtn('↓', '다운로드', (ev) => { ev.stopPropagation(); authDownload(B + id + '/file?download=1&path=' + encodeURIComponent(rel), it.name); }), fileIconBtn('✕', '삭제', (ev) => { ev.stopPropagation(); deleteEntry(id, rel, it.name, isDir, reload, B); }, true));
    const row = el('div', { class: 'proj-file-lrow' }, el('span', { class: 'proj-file-lic' }, fileThumb(id, it, rel, B)), el('span', { class: 'proj-file-lnm' + (isDir ? ' is-dir' : ''), text: it.name, title: it.name }), el('span', { class: 'proj-file-lsz', text: isDir ? '' : fmtSize(it.size) }), acts);
    row.onclick = isDir ? () => onDir(rel) : () => openFileViewer(id, rel, it.name, reload, B);
    return row;
}
function fileIconBtn(glyph, title, onclick, danger) {
    return el('button', { class: 'proj-file-iconbtn' + (danger ? ' danger' : ''), title, type: 'button', text: glyph, onclick });
}
// 파일/폴더 이름 변경(같은 폴더 안).
function renameEntry(id, rel, name, isDir, reload, base) {
    const B = base || '/api/ui/projects/';
    const nameIn = el('input', { type: 'text', value: name, maxlength: '120' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const back = overlayBox('이름 변경', el('div', { class: 'field' }, el('label', { class: 'field-label', text: '새 이름' }), nameIn), el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
    setTimeout(() => {
        nameIn.focus();
        // 파일은 확장자(.png 등)를 뺀 본문만 선택 — 타이핑 시 확장자가 통째로 지워지는 것 방지(Finder/VS Code 동작).
        const dot = name.lastIndexOf('.');
        if (!isDir && dot > 0)
            nameIn.setSelectionRange(0, dot);
        else
            nameIn.select();
    }, 0);
    const go = async () => {
        const nm = nameIn.value.trim();
        if (!nm || nm === name) {
            back.remove();
            return;
        }
        saveBtn.disabled = true;
        try {
            await api(B + id + '/rename', { method: 'POST', body: JSON.stringify({ path: rel, name: nm }) });
            back.remove();
            toast('이름을 변경했습니다');
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
// 파일/폴더 삭제(폴더는 내용까지). 확인 후.
async function deleteEntry(id, rel, name, isDir, reload, base) {
    const B = base || '/api/ui/projects/';
    if (!confirm((isDir ? '폴더' : '파일') + ' ‘' + name + '’을(를) 삭제할까요?' + (isDir ? '\n\n폴더 안 내용도 함께 삭제됩니다(되돌릴 수 없음).' : '\n\n되돌릴 수 없습니다.')))
        return;
    try {
        await api(B + id + '/file?path=' + encodeURIComponent(rel), { method: 'DELETE' });
        toast('삭제했습니다');
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
// 공유 폴더 '전체 보기' — 넓은 팝업에 일반 파일 목록(행 단위)으로 전부 표시. 폴더 탐색·파일 열기 가능.
function openFolderGrid(id, startPath, base) {
    const B = base || '/api/ui/projects/';
    const st = { path: startPath || '', q: '' };
    const searchIn = el('input', { type: 'search', class: 'proj-file-search', placeholder: '파일 검색…' });
    searchIn.addEventListener('input', debounce(() => { st.q = searchIn.value.trim(); load(); }, 300));
    const fileInput = el('input', { type: 'file', multiple: '', style: 'display:none' });
    fileInput.addEventListener('change', async () => { await uploadHere(fileInput.files); fileInput.value = ''; });
    const mkdirBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 폴더', onclick: () => mkdirHere() });
    const uploadBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 업로드', onclick: () => fileInput.click() });
    const crumb = el('div', { class: 'proj-file-crumb' });
    const listBox = el('div', { class: 'proj-file-llist' });
    const back = overlayBox('공유 폴더 — 전체 보기', el('div', { class: 'proj-fg-head' }, searchIn, el('div', { class: 'proj-fg-actions' }, mkdirBtn, uploadBtn, fileInput)), crumb, listBox);
    const box = back.querySelector('.ov-box');
    if (box)
        box.classList.add('ov-box-wide');
    const join = (a, b) => (a ? a + '/' + b : b);
    load();
    async function uploadHere(files) {
        const arr = Array.from(files || []);
        if (!arr.length)
            return;
        if (arr.length > 1)
            toast(arr.length + '개 업로드 중…');
        let ok = 0;
        for (const f of arr) {
            try {
                await authUpload(B + id + '/file?path=' + encodeURIComponent((st.path ? st.path + '/' : '') + f.name), f);
                ok += 1;
            }
            catch (e) {
                toast(f.name + ' 실패 — ' + e.message, true);
            }
        }
        if (ok)
            toast(ok + '개 업로드 완료');
        st.q = '';
        searchIn.value = '';
        load();
    }
    function mkdirHere() {
        const nameIn = el('input', { type: 'text', placeholder: '폴더 이름', maxlength: '80' });
        const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기' });
        const b2 = overlayBox('새 폴더', el('p', { class: 'admin-hint', text: (st.path ? '“' + st.path + '” 안에' : '루트에') + ' 새 폴더를 만듭니다.' }), el('div', { class: 'field' }, el('label', { class: 'field-label', text: '폴더 이름' }), nameIn), el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => b2.remove() })));
        setTimeout(() => nameIn.focus(), 0);
        const go = async () => {
            const nm = nameIn.value.trim();
            if (!nm) {
                nameIn.focus();
                return;
            }
            saveBtn.disabled = true;
            try {
                await api(B + id + '/folder?path=' + encodeURIComponent((st.path ? st.path + '/' : '') + nm), { method: 'POST' });
                b2.remove();
                toast('폴더를 만들었습니다');
                load();
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
    async function load() {
        listBox.replaceChildren(skeletonRows(5));
        const qs = st.q ? ('?q=' + encodeURIComponent(st.q)) : ('?path=' + encodeURIComponent(st.path));
        let data;
        try {
            data = await api(B + id + '/files' + qs);
        }
        catch (e) {
            listBox.replaceChildren(errorNote(e, '폴더를 불러오지 못했습니다'));
            return;
        }
        if (data.search !== undefined) {
            crumb.replaceChildren(el('span', { text: '“' + data.search + '” 검색 — ' + data.items.length + '건' }));
            const rows = (data.items || []).map((it) => projFileRowEl(id, it, it.path, (t) => { st.q = ''; searchIn.value = ''; st.path = t; load(); }, load, B));
            listBox.replaceChildren(...(rows.length ? rows : [el('div', { class: 'empty', text: '일치하는 파일이 없어요.' })]));
            return;
        }
        crumb.replaceChildren(el('span', { class: 'proj-crumb-link', text: '⌂ 루트', onclick: () => { st.path = ''; load(); } }), data.path ? el('span', { text: ' / ' + data.path }) : null);
        const rows = [];
        if (data.path)
            rows.push(el('div', { class: 'proj-file-lrow', onclick: () => { st.path = data.parent || ''; load(); } }, el('span', { class: 'proj-file-lic', text: '↩' }), el('span', { class: 'proj-file-lnm', text: '상위 폴더' }), el('span', { class: 'proj-file-lsz' }), el('span', { class: 'proj-file-lacts' })));
        for (const it of (data.items || []))
            rows.push(projFileRowEl(id, it, join(st.path, it.name), (t) => { st.path = t; load(); }, load, B));
        listBox.replaceChildren(...(rows.length ? rows : [el('div', { class: 'empty', text: '빈 폴더입니다.' })]));
    }
}
function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
// 타임라인용 날짜시간 — '몇 시간 전' 대신 절대 날짜·시각(연도는 올해가 아니면만 표기).
function fmtDateTime(iso) {
    if (!iso)
        return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return '';
    const p = (n) => String(n).padStart(2, '0');
    const yr = d.getFullYear() !== new Date().getFullYear() ? (d.getFullYear() + '. ') : '';
    return yr + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
// ── 상세 ① 공유 폴더 — 프로젝트 폴더 탐색 + 업로드/다운로드 + 검색. ──
function projectFolderSection(id, base) {
    const B = base || '/api/ui/projects/';
    const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
    const body = el('div', {});
    const st = { path: '', q: '' };
    let lastData = null; // 마지막 서버 응답(업로드 중 그리드 즉시 재구성용)
    const uploading = []; // 업로드 중 파일 [{ name, pct, pctEl, fill }]
    const searchIn = el('input', { type: 'search', placeholder: '파일 검색…', class: 'proj-file-search' });
    searchIn.addEventListener('input', debounce(() => { st.q = searchIn.value.trim(); load(); }, 300));
    const fileInput = el('input', { type: 'file', multiple: '', style: 'display:none' });
    fileInput.addEventListener('change', () => { uploadFiles(fileInput.files); fileInput.value = ''; });
    const uploadBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 업로드', onclick: () => fileInput.click() });
    const allBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '전체 보기', onclick: () => openFolderGrid(id, st.path, B) });
    const mkdirBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 폴더', onclick: () => openMkdir() });
    // 선택(일괄삭제) 모드 — 카드 뷰에서 여러 항목을 골라 한 번에 삭제. ids = 선택된 rel(상대경로) 집합.
    const sel = { mode: false, ids: new Set() };
    let lastPairs = [];
    const selectBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '선택', title: '여러 항목을 골라 한 번에 삭제', onclick: () => toggleSelMode() });
    const selBar = el('div', { class: 'bulk-bar', hidden: true });
    card.append(el('div', { class: 'card-head' }, el('h3', { text: '공유 폴더' }), el('div', { class: 'card-head-actions' }, searchIn, allBtn, mkdirBtn, uploadBtn, selectBtn, fileInput)));
    card.append(selBar);
    card.append(body);
    // 드래그앤드롭 업로드 — 카드 위로 파일을 끌어다 놓으면 현재 폴더에 올림(여러 개 동시 가능).
    let dragDepth = 0;
    const hasFiles = (ev) => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
    card.addEventListener('dragenter', (ev) => { if (hasFiles(ev)) {
        ev.preventDefault();
        dragDepth++;
        card.classList.add('drop-active');
    } });
    card.addEventListener('dragover', (ev) => { if (hasFiles(ev)) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
    } });
    card.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth)
        card.classList.remove('drop-active'); });
    card.addEventListener('drop', (ev) => { ev.preventDefault(); dragDepth = 0; card.classList.remove('drop-active'); if (ev.dataTransfer.files && ev.dataTransfer.files.length)
        uploadFiles(ev.dataTransfer.files); });
    // 클립보드 이미지 붙여넣기 — 프로젝트 상세에서 (텍스트 입력칸이 아닌 곳에) 붙여넣으면 현재 공유 폴더로 업로드.
    //  card 가 DOM 에서 사라지면(다른 화면 이동) 다음 paste 때 스스로 해제(언마운트 훅이 없어 누수 방지용 self-clean).
    const onPaste = (ev) => {
        if (!document.body.contains(card)) {
            document.removeEventListener('paste', onPaste);
            return;
        }
        const t = ev.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))
            return; // 텍스트 편집 중 붙여넣기는 방해 않음
        const items = (ev.clipboardData && ev.clipboardData.items) || [];
        const imgs = [];
        for (const it of items) {
            if (it.kind === 'file' && String(it.type || '').startsWith('image/')) {
                const b = it.getAsFile();
                if (b)
                    imgs.push(b);
            }
        }
        if (!imgs.length)
            return; // 이미지가 없으면 평소 붙여넣기 동작 유지
        ev.preventDefault();
        const dest = '공유 폴더' + (st.path ? ' / ' + st.path : '');
        openPasteDialog(imgs, dest, (files) => uploadFiles(files));
    };
    document.addEventListener('paste', onPaste);
    load();
    return card;
    // 선택 모드 토글 — 켜면 카드가 체크박스로, 끄면 선택 해제 + 헤드 버튼 라벨 전환.
    function toggleSelMode(on) {
        sel.mode = on != null ? on : !sel.mode;
        if (!sel.mode)
            sel.ids.clear();
        selectBtn.classList.toggle('active', sel.mode);
        selectBtn.textContent = sel.mode ? '선택 취소' : '선택';
        paintSelBar();
        if (lastData)
            render(lastData);
    }
    function paintSelBar() {
        if (!sel.mode) {
            selBar.hidden = true;
            selBar.replaceChildren();
            return;
        }
        const n = sel.ids.size, total = lastPairs.length;
        const allOn = total > 0 && n >= total;
        const allBtn2 = el('button', { class: 'btn btn-ghost btn-sm', text: allOn ? '전체 해제' : '전체 선택',
            onclick: () => { if (allOn)
                sel.ids.clear();
            else
                lastPairs.forEach((p) => sel.ids.add(p.rel)); paintSelBar(); if (lastData)
                render(lastData); } });
        const delB = el('button', { class: 'btn btn-sm btn-danger', text: '선택 삭제', disabled: n === 0, onclick: () => bulkDeleteSel() });
        selBar.hidden = false;
        selBar.replaceChildren(el('span', { class: 'bulk-bar-count', text: n ? n + '개 선택됨' : '삭제할 항목을 고르세요' }), el('div', { class: 'bulk-bar-actions' }, allBtn2, delB));
    }
    async function bulkDeleteSel() {
        const rels = [...sel.ids];
        if (!rels.length)
            return;
        if (!confirm(rels.length + '개 항목을 삭제할까요?\n\n폴더는 안의 내용까지 함께 삭제됩니다(되돌릴 수 없음).'))
            return;
        // 병렬 삭제 — 일부 실패해도 나머지 진행(성공/실패 집계).
        const results = await Promise.allSettled(rels.map((rel) => api(B + id + '/file?path=' + encodeURIComponent(rel), { method: 'DELETE' })));
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const fail = results.length - ok;
        toast(fail ? (ok + '개 삭제 · ' + fail + '개 실패') : (ok + '개 삭제했습니다'), fail > 0);
        toggleSelMode(false);
        load();
    }
    // 여러 파일 업로드 — 그리드에 '업로드 중 카드'(비활성 아이콘 + 실시간 %) 띄우고 순차 전송.
    async function uploadFiles(files) {
        const arr = Array.from(files || []);
        if (!arr.length)
            return;
        const items = arr.map((f) => ({ name: f.name, pct: 0 }));
        uploading.push(...items);
        if (lastData)
            render(lastData); // 업로드 카드 즉시 표시(load 기다리지 않음)
        let ok = 0, fail = 0;
        for (let i = 0; i < arr.length; i++) {
            const f = arr[i], u = items[i];
            const target = (st.path ? st.path + '/' : '') + f.name;
            try {
                await authUploadProgress(B + id + '/file?path=' + encodeURIComponent(target), f, (pct) => { u.pct = pct; updateUpCard(u); });
                u.pct = 100;
                updateUpCard(u);
                ok += 1;
            }
            catch (e) {
                fail += 1;
                toast(f.name + ' 실패 — ' + e.message, true);
            }
        }
        uploading.length = 0;
        if (ok)
            toast(ok + '개 업로드 완료' + (fail ? (' · ' + fail + '개 실패') : ''));
        st.q = '';
        searchIn.value = '';
        load();
    }
    function uploadingCard(u) {
        const pctEl = el('div', { class: 'proj-up-pct', text: Math.round(u.pct) + '%' });
        const fill = el('div', { class: 'proj-up-bar-fill', style: 'width:' + u.pct + '%' });
        u.pctEl = pctEl;
        u.fill = fill;
        return el('div', { class: 'proj-file-card uploading', title: u.name }, el('div', { class: 'proj-up-icwrap' }, el('div', { class: 'proj-file-card-ic', text: iconFor(u.name) }), el('div', { class: 'proj-up-overlay' }, pctEl)), el('div', { class: 'proj-file-card-nm', text: u.name }), el('div', { class: 'proj-up-bar' }, fill));
    }
    function updateUpCard(u) {
        if (u.pctEl)
            u.pctEl.textContent = Math.round(u.pct) + '%';
        if (u.fill)
            u.fill.style.width = u.pct + '%';
    }
    // 현재 폴더 안에 하위 폴더 생성.
    function openMkdir() {
        const nameIn = el('input', { type: 'text', placeholder: '폴더 이름', maxlength: '80' });
        const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기' });
        const back = overlayBox('새 폴더', el('p', { class: 'admin-hint', text: (st.path ? '“' + st.path + '” 안에' : '루트에') + ' 새 폴더를 만듭니다.' }), el('div', { class: 'field' }, el('label', { class: 'field-label', text: '폴더 이름' }), nameIn), el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
        setTimeout(() => nameIn.focus(), 0);
        const go = async () => {
            const nm = nameIn.value.trim();
            if (!nm) {
                nameIn.focus();
                toast('폴더 이름을 입력하세요', true);
                return;
            }
            const target = (st.path ? st.path + '/' : '') + nm;
            saveBtn.disabled = true;
            try {
                await api(B + id + '/folder?path=' + encodeURIComponent(target), { method: 'POST' });
                back.remove();
                toast('폴더를 만들었습니다');
                st.q = '';
                searchIn.value = '';
                load();
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
    async function load() {
        body.replaceChildren(skeletonRows(3));
        try {
            const qs = st.q ? ('?q=' + encodeURIComponent(st.q)) : ('?path=' + encodeURIComponent(st.path));
            render(await api(B + id + '/files' + qs));
        }
        catch (e) {
            body.replaceChildren(errorNote(e, '폴더를 불러오지 못했습니다'));
        }
    }
    function render(data) {
        lastData = data;
        const frag = [];
        let pairs; // { it, rel }
        if (data.search !== undefined) {
            frag.push(el('div', { class: 'proj-file-crumb', text: '“' + data.search + '” 검색 — ' + data.items.length + '건' }));
            pairs = data.items.map((it) => ({ it, rel: it.path }));
            if (!data.items.length)
                frag.push(el('div', { class: 'empty', text: '일치하는 파일이 없습니다.' }));
        }
        else {
            const crumb = el('div', { class: 'proj-file-crumb' }, el('span', { class: 'proj-crumb-link', text: '⌂ 루트', onclick: () => { st.path = ''; load(); } }));
            if (data.path)
                crumb.append(el('span', { text: ' / ' + data.path }));
            frag.push(crumb);
            pairs = data.items.map((it) => ({ it, rel: join(st.path, it.name) }));
            if (!data.items.length && !data.path)
                frag.push(el('div', { class: 'empty', text: '빈 폴더입니다. ‘＋ 업로드’로 파일을 올려 보세요.' }));
        }
        const cards = [];
        for (const u of uploading)
            cards.push(uploadingCard(u)); // 업로드 중 카드 먼저(비활성 + 실시간 %)
        lastPairs = pairs;
        const enterDir = (t) => { sel.ids.clear(); st.q = ''; searchIn.value = ''; st.path = t; load(); };
        if (data.search === undefined && data.path)
            cards.push(projUpCardEl(() => enterDir(data.parent || '')));
        const selCtl = sel.mode ? { ids: sel.ids, onToggle: paintSelBar } : null;
        for (const { it, rel } of pairs)
            cards.push(projFileCardEl(id, it, rel, enterDir, load, B, selCtl));
        if (cards.length)
            frag.push(el('div', { class: 'proj-file-grid' }, ...cards));
        body.replaceChildren(...frag);
        if (sel.mode)
            paintSelBar();
    }
    function join(a, b) { return a ? a + '/' + b : b; }
}
// 이니셜 아바타 — 이름 첫 글자(한글 1자 / 영문 1~2자). 이름 기반 파스텔 배경.
function initials(name) {
    const s = String(name || '').trim();
    if (!s)
        return '?';
    if (/[가-힣]/.test(s[0]))
        return s.slice(0, 1);
    const parts = s.split(/\s+/);
    if (parts.length >= 2 && parts[1][0])
        return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
}
function avatarColor(seed) {
    const s = String(seed || '');
    let h = 0;
    for (let i = 0; i < s.length; i++)
        h = (h * 31 + s.charCodeAt(i)) % 360;
    return 'hsl(' + h + ', 50%, 60%)';
}
// ── 상세 ② 터미널 세션 — 팀원 프로필(아바타) 그리드 → 클릭 시 그 사람 세션 펼침(페이지 내). 본인은 상태메시지 공유. ──
function projectTerminalSection(id, members, meId, base, projectName, project) {
    const B = base || '/api/ui/projects/';
    const projectRepos = (project && project.repos) || [];
    const card = el('div', { class: 'card proj-term-card', style: 'margin-bottom:18px' });
    const body = el('div', {});
    // '＋ 새 세션' — 곧장 폼이 아니라 드롭다운으로 '어디서 작업할지' 먼저 고른다.
    //  · 내 컴퓨터에서 작업 — 내 PC 터미널 실행 명령을 안내(openLocalWorkModal). 웹은 원격 PC를 스트리밍하지 않음.
    //  · 중앙 컴퓨터에서 작업 — 중앙(박스)에서 공동 세션을 바로 생성(openProjectSessionForm). 관련 레포가 기본값.
    const newBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 세션' });
    newBtn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu pjv-sess-menu' });
        const close = pjvPopover(newBtn, menu);
        const mkItem = (icon, label, desc, fn) => {
            const item = el('button', { class: 'pjv-menu-item', type: 'button' }, icon ? el('span', { class: 'pjv-sess-ico', text: icon }) : null, el('span', { style: 'display:flex;flex-direction:column;gap:1px;min-width:0' }, el('span', { text: label }), desc ? el('span', { class: 'caption', text: desc }) : null));
            item.onclick = (ev) => { ev.stopPropagation(); close(); fn(); };
            return item;
        };
        menu.append(mkItem('', '내 컴퓨터에서 (for Developers)', '', () => openLocalWorkModal(id, project || { id, name: projectName, repos: projectRepos })), mkItem('', '중앙 컴퓨터에서', '', () => openProjectSessionForm(id, load, B, projectName, projectRepos)));
    };
    card.append(el('div', { class: 'card-head' }, el('h3', { text: '터미널 세션' }), el('div', { class: 'card-head-actions' }, newBtn)));
    card.append(body);
    let sessions = [];
    let selected = null;
    let dragId = null;
    const ppl = () => (members && members.length ? members : []);
    const ownerName = (oid) => { const m = ppl().find((x) => x.member_id === oid); return (m && m.display_name) || oid; };
    load();
    return card;
    async function load() {
        body.replaceChildren(skeletonRows(2));
        try {
            sessions = await api(B + id + '/sessions').then((d) => (d && d.sessions) || []);
        }
        catch (e) {
            body.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다'));
            return;
        }
        render();
    }
    function render() {
        if (!ppl().length) {
            body.replaceChildren(el('div', { class: 'empty', text: '팀원이 없습니다. 위 ‘팀원 수정’으로 추가하면 여기에 프로필이 생깁니다.' }));
            return;
        }
        const grid = el('div', { class: 'proj-people-grid' }, ...ppl().map(personCircle));
        const panel = el('div', { class: 'proj-people-panel' });
        if (selected)
            renderPanel(panel);
        body.replaceChildren(grid, panel);
    }
    function personCircle(m) {
        const isMe = m.member_id === meId;
        const cnt = sessions.filter((s) => s.owner === m.member_id).length;
        const avatar = el('div', { class: 'proj-avatar', style: 'background:' + avatarColor(m.member_id) }, el('span', { text: initials(m.display_name || m.member_id) }));
        if (cnt)
            avatar.append(el('span', { class: 'proj-avatar-badge', text: String(cnt) }));
        const hasStatus = !!m.status_message;
        const status = el('div', { class: 'proj-person-status' + (isMe ? ' me' : '') + (hasStatus ? ' filled' : ' empty'),
            text: hasStatus ? m.status_message : (isMe ? '✎ 상태 남기기' : '') });
        if (isMe && hasStatus)
            status.append(el('span', { class: 'proj-status-pen', text: ' ✎' }));
        if (isMe) {
            status.title = '클릭해서 상태 메시지 수정';
            status.onclick = (ev) => { ev.stopPropagation(); editStatus(m); };
        }
        const wrap = el('div', { class: 'proj-person' + (selected === m.member_id ? ' active' : '') }, avatar, el('div', { class: 'proj-person-name', text: m.display_name || m.member_id }), status);
        wrap.onclick = () => { selected = (selected === m.member_id ? null : m.member_id); render(); };
        // 드래그앤드롭으로 진열 순서 조절(짧게 누르면 선택, 끌면 재배치).
        wrap.draggable = true;
        wrap.addEventListener('dragstart', (ev) => { dragId = m.member_id; wrap.classList.add('dragging'); ev.dataTransfer.effectAllowed = 'move'; try {
            ev.dataTransfer.setData('text/plain', m.member_id);
        }
        catch (_) { /* */ } });
        wrap.addEventListener('dragend', () => { dragId = null; wrap.classList.remove('dragging'); });
        wrap.addEventListener('dragover', (ev) => { if (dragId && dragId !== m.member_id) {
            ev.preventDefault();
            wrap.classList.add('drop-target');
        } });
        wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-target'));
        wrap.addEventListener('drop', (ev) => { ev.preventDefault(); wrap.classList.remove('drop-target'); if (dragId && dragId !== m.member_id)
            reorder(dragId, m.member_id); });
        return wrap;
    }
    function reorder(fromId, toId) {
        const list = ppl();
        const fromIdx = list.findIndex((x) => x.member_id === fromId);
        const toIdx = list.findIndex((x) => x.member_id === toId);
        if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx)
            return;
        const [moved] = list.splice(fromIdx, 1);
        list.splice(toIdx, 0, moved);
        render();
        api(B + id + '/members', { method: 'POST', body: JSON.stringify({ members: list.map((x) => x.member_id) }) })
            .then(() => toast('순서를 저장했습니다'))
            .catch((e) => toast('순서 저장 실패 — ' + e.message, true));
    }
    function renderPanel(panel) {
        const m = ppl().find((x) => x.member_id === selected);
        const mine = sessions.filter((s) => s.owner === selected);
        const head = el('div', { class: 'proj-panel-head' }, el('b', { text: (m && m.display_name) || selected }), ' 의 세션 ', el('span', { class: 'proj-panel-cnt', text: String(mine.length) }));
        // ＋ 새 세션 버튼은 카드 헤더 우상단에 항상 있으므로 패널에선 중복 제거(같은 동작).
        panel.append(head);
        if (!mine.length) {
            panel.append(el('div', { class: 'empty', text: selected === meId ? '아직 만든 세션이 없어요. ‘＋ 새 세션’으로 시작하세요.' : '아직 만든 세션이 없습니다.' }));
            return;
        }
        panel.append(el('div', { class: 'proj-sess-list' }, ...mine.map(sessRow)));
    }
    function sessRow(s) {
        const acts = [];
        if (s.owned)
            acts.push(el('button', { class: 'btn btn-ghost btn-sm', text: '이름변경', onclick: () => openSessionRename(s, load) }), el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: () => removeSession(s, load) }));
        acts.push(el('button', { class: 'btn btn-primary btn-sm', text: '입장', onclick: () => window.open('/ui/terminal.html?session=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || ''), '_blank') }));
        return el('div', { class: 'proj-sess-row' }, el('div', { class: 'proj-sess-main' }, el('div', { class: 'proj-sess-name' }, (s.label || s.id), s.attached ? el('span', { class: 'proj-sess-live', text: '● 사용 중' }) : null), el('div', { class: 'proj-sess-meta', text: (s.harness || 'shell') + ' · 만든이 ' + ownerName(s.owner) })), el('div', { class: 'proj-sess-acts' }, ...acts));
    }
    function editStatus(m) {
        const input = el('input', { type: 'text', value: m.status_message || '', placeholder: '현재 상태 (예: 결제 모듈 작업 중)', maxlength: '200' });
        const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
        const back = overlayBox('내 상태 메시지', el('p', { class: 'admin-hint', text: '이 프로젝트에서의 ‘현재 상태’예요 — 이 프로젝트 팀원에게만 보이고, 다른 프로젝트엔 영향을 주지 않아요.' }), el('div', { class: 'field' }, input), el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
        setTimeout(() => input.focus(), 0);
        const go = async () => {
            saveBtn.disabled = true;
            try {
                const r = await api(base + id + '/my-status', { method: 'POST', body: JSON.stringify({ message: input.value.trim() }) });
                m.status_message = r.status_message;
                back.remove();
                toast('상태를 저장했습니다');
                render();
            }
            catch (e) {
                toast('실패 — ' + e.message, true);
                saveBtn.disabled = false;
            }
        };
        saveBtn.onclick = go;
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter')
            go(); });
    }
}
// 새 프로젝트 세션 오버레이 — 터미널 탭과 같은 정보(실행기·모델 등 플래그·자동승인). 폴더는 프로젝트 폴더 고정,
//  공개범위는 '팀원 공동'(별도 입력 없음). 생성 후 새 탭 입장.
async function openProjectSessionForm(id, reload, base, projectName, projectRepos) {
    const B = base || '/api/ui/projects/';
    let cfg;
    try {
        cfg = await api('/api/ui/terminal/config');
    }
    catch (e) {
        toast('세션 설정을 불러오지 못했습니다 — ' + e.message, true);
        return;
    }
    const harnesses = cfg.harnesses || [];
    const nameIn = el('input', { type: 'text', value: projectName || '', placeholder: '세션 이름 (예: 개발, 빌드)', maxlength: '80' });
    const harnessSel = el('select', {}, ...harnesses.map((h) => el('option', { value: h.key, text: h.label })));
    const flagsBox = el('div', {});
    const autoCb = el('input', { type: 'checkbox' });
    const autoRow = el('label', { class: 'proj-sess-auto' }, autoCb, el('span', { text: ' 자동 승인 — 매번 권한 확인 없이 실행' }));
    function renderFlags() {
        const h = harnesses.find((x) => x.key === harnessSel.value) || {};
        flagsBox.replaceChildren();
        for (const f of (h.flags || [])) {
            let ctrl;
            if (f.type === 'select')
                ctrl = el('select', { 'data-flag': f.name }, ...(f.choices || []).map((c) => el('option', { value: c, text: c || '(기본)' })));
            else if (f.type === 'bool')
                ctrl = el('input', { type: 'checkbox', 'data-flag': f.name });
            else
                ctrl = el('input', { type: 'text', 'data-flag': f.name });
            flagsBox.append(el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: f.label }), ctrl, f.desc ? el('div', { class: 'caption', text: f.desc }) : null));
        }
        autoRow.style.display = h.hasAutoApprove ? '' : 'none';
    }
    harnessSel.addEventListener('change', renderFlags);
    renderFlags();
    // ── 레포에서 작업 (선택, 여러 개) — '내 컴퓨터에서 작업'(work.mjs)과 동일 수준: 박스가 각 레포를 준비(입력 경로에
    //  없으면 레지스트리 clone_url 로 clone)한다. 워크트리면 project/<id>/<repo> 격리 폴더(브랜치 project/<id>). 세션은
    //  프로젝트 폴더에서 열리고 — 워크트리는 그 하위라 접근됨, 비워크트리 클론은 add-dir(.claude/settings.local.json)로 접근. ──
    const boxPathKey = (repo) => 'lively:boxpath:' + repo; // 박스 경로 기억(로컬PC 경로와 별개 키)
    const savedBoxPath = (repo) => { try {
        return repo ? (localStorage.getItem(boxPathKey(repo)) || '') : '';
    }
    catch (_) {
        return '';
    } };
    const cloneRepoNames = [];
    const reposWrap = el('div', {});
    let rrows = [];
    const fillRepoSel = (sel) => {
        const cur = sel.value;
        sel.replaceChildren(el('option', { value: '', text: '— 코드 저장소 선택 —' }));
        cloneRepoNames.forEach((n) => sel.append(el('option', { value: n, text: n })));
        if (cloneRepoNames.includes(cur))
            sel.value = cur;
    };
    const addRepoRow = (initRepo = '') => {
        const sel = el('select', {});
        const pathInp = el('input', { type: 'text', placeholder: '코드를 둘 위치 (비워두면 자동 — 보통 안 건드려도 돼요)' });
        const wtChk = el('input', { type: 'checkbox' });
        wtChk.checked = true;
        const branchInp = el('input', { type: 'text', value: 'project/' + id });
        const rmBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '✕' });
        fillRepoSel(sel);
        if (initRepo)
            sel.value = initRepo;
        pathInp.value = savedBoxPath(sel.value);
        const branchWrap = el('div', { class: 'field', style: 'margin-top:6px' }, el('label', { class: 'field-label', text: '작업 공간 이름 (자동 · 보통 그대로 두세요)' }), branchInp);
        const pathField = el('div', { class: 'field' }, el('label', { class: 'field-label', text: '코드 저장 위치 (선택)' }), pathInp);
        // 워크트리(격리) 체크 — 기본 화면에선 숨기고 '고급 설정' 안으로 넣는다. 기본값은 체크(권장)라 안 열어도 워크트리로 준비됨.
        const wtRow = el('label', { class: 'proj-sess-auto', style: 'margin-top:2px' }, wtChk, el('span', { text: ' 워크트리 — 다른 작업과 안 섞임 (권장)' }));
        // 고급 설정 — 워크트리·경로·작업공간 이름을 하나의 토글로 접어둔다(기본 닫힘, 중첩 없음). 기본 화면엔 저장소 선택만.
        const advBox = el('div', { style: 'display:none;margin-top:8px' }, wtRow, pathField, branchWrap);
        const advToggle = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '▸ 고급 설정' });
        let advOpen = false;
        advToggle.onclick = () => { advOpen = !advOpen; advBox.style.display = advOpen ? '' : 'none'; advToggle.textContent = (advOpen ? '▾' : '▸') + ' 고급 설정'; };
        const branchVis = () => { branchWrap.style.display = wtChk.checked ? '' : 'none'; };
        const ro = { sel, pathInp, wtChk, branchInp };
        rrows.push(ro);
        sel.addEventListener('change', () => { pathInp.value = savedBoxPath(sel.value); }); // 레포 바꾸면 그 레포의 마지막 경로로
        pathInp.addEventListener('change', () => { if (sel.value && pathInp.value.trim()) {
            try {
                localStorage.setItem(boxPathKey(sel.value), pathInp.value.trim());
            }
            catch (_) { /* */ }
        } });
        wtChk.addEventListener('change', branchVis);
        const rowEl = el('section', { class: 'ps-block', style: 'border:1px solid rgba(127,127,127,.18);border-radius:8px;padding:10px;margin-top:8px' }, el('div', { style: 'display:flex;gap:8px;align-items:center' }, sel, rmBtn), el('div', { style: 'margin-top:8px' }, advToggle), advBox);
        ro.el = rowEl;
        rmBtn.onclick = () => { rowEl.remove(); rrows = rrows.filter((r) => r !== ro); };
        branchVis();
        reposWrap.append(rowEl);
    };
    const addRepoBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ 레포 추가', onclick: () => addRepoRow() });
    try {
        const rr = await api('/api/ui/repos');
        ((rr && rr.domainmapRepos) || []).forEach((it) => { if (it && it.name)
            cloneRepoNames.push(it.name); });
    }
    catch (_) { /* graceful: 레포 없음 */ }
    // 이 프로젝트의 관련 레포를 기본 행으로(있으면) — 없으면 빈 채로 '+ 레포 추가' 안내.
    (projectRepos || []).filter((n) => cloneRepoNames.includes(n)).forEach((n) => addRepoRow(n));
    const saveBtn = el('button', { class: 'btn btn-primary', text: '만들고 입장' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
    const back = overlayBox('새 터미널 세션', el('p', { class: 'admin-hint', text: '이 프로젝트 폴더에서 시작하는 공동 세션입니다 — 프로젝트 팀원만 보고 입장할 수 있어요.' }), el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn), el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '실행' }), harnessSel), flagsBox, el('div', { style: 'margin-top:10px' }, autoRow), el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '코드 저장소에서 작업 (선택)' }), el('div', { class: 'caption', text: '코드를 다루는 작업이면 작업할 저장소를 고르세요 — 그 코드를 자동으로 가져와, 에이전트가 바로 작업할 수 있게 준비해 둡니다. 코드 작업이 아니라면 그냥 비워두고 넘어가도 돼요.' }), reposWrap, el('div', { style: 'margin-top:8px' }, addRepoBtn)), el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
    setTimeout(() => nameIn.focus(), 0);
    saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        const flags = {};
        for (const ctrl of flagsBox.querySelectorAll('[data-flag]')) {
            const k = ctrl.getAttribute('data-flag');
            const v = ctrl.type === 'checkbox' ? (ctrl.checked ? 'true' : '') : ctrl.value;
            if (v)
                flags[k] = v;
        }
        try {
            // 선택한 레포(들)를 먼저 박스에 provision(clone/worktree + 비워크트리 add-dir). 세션은 프로젝트 폴더에서 연다.
            const specs = rrows.map((r) => ({ name: r.sel.value, path: r.pathInp.value.trim(), worktree: r.wtChk.checked, branch: r.branchInp.value.trim() })).filter((s) => s.name);
            if (specs.length) {
                saveBtn.textContent = '레포 준비 중… (clone 시 잠시)';
                await api(B + id + '/provision', { method: 'POST', body: JSON.stringify({ repos: specs }) });
            }
            saveBtn.textContent = '세션 여는 중…';
            const r = await api(B + id + '/sessions', { method: 'POST', body: JSON.stringify({
                    label: nameIn.value.trim(), harness: harnessSel.value, flags, autoApprove: autoCb.checked,
                }) });
            back.remove();
            toast(specs.length ? ('레포 ' + specs.length + '개 준비 완료 · 세션을 만들었습니다') : '세션을 만들었습니다');
            if (r && r.session && r.session.id)
                window.open('/ui/terminal.html?session=' + encodeURIComponent(r.session.id) + '&label=' + encodeURIComponent(r.session.label || ''), '_blank');
            reload();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            saveBtn.disabled = false;
            saveBtn.textContent = '만들고 입장';
        }
    };
}
// 세션 이름 변경 오버레이 — 기존 터미널 세션 API 재사용(소유자만, 서버가 강제).
function openSessionRename(s, reload) {
    const nameIn = el('input', { type: 'text', value: s.label || '', placeholder: '세션 이름', maxlength: '80' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
    const back = overlayBox('세션 이름 변경', el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn), el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
    setTimeout(() => nameIn.focus(), 0);
    const go = async () => {
        const label = nameIn.value.trim();
        if (!label) {
            nameIn.focus();
            toast('이름을 입력하세요', true);
            return;
        }
        saveBtn.disabled = true;
        try {
            await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label }) });
            back.remove();
            toast('이름을 변경했습니다');
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
// 세션 삭제 — 확인 후 tmux 세션 종료(소유자만). 실행 중 작업도 종료됨.
async function removeSession(s, reload) {
    if (!confirm('세션 ‘' + (s.label || s.id) + '’을(를) 삭제할까요?\n\n실행 중인 작업이 함께 종료됩니다(되돌릴 수 없음).'))
        return;
    try {
        await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' });
        toast('세션을 삭제했습니다');
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
// ── 상세 ③ 작업 타임라인 — 팀원 activity + 사람별 필터(전체/팀원 칩). ──
function projectTimelineSection(id, members, base) {
    const B = base || '/api/ui/projects/';
    const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
    const body = el('div', {});
    const st = { person: '' };
    const nameOf = (pid) => { const m = (members || []).find((x) => x.member_id === pid); return (m && m.display_name) || pid || '—'; };
    const chipsBar = el('div', { class: 'proj-tl-filter' });
    function paintChips() {
        const mk = (label, person) => el('button', { class: 'proj-tl-chip' + (st.person === person ? ' active' : ''), text: label,
            onclick: () => { st.person = person; paintChips(); load(); } });
        chipsBar.replaceChildren(mk('전체', ''), ...(members || []).map((m) => mk(m.display_name || m.member_id, m.member_id)));
    }
    paintChips();
    card.append(el('div', { class: 'card-head' }, el('h3', { text: '작업 타임라인' })), el('p', { class: 'proj-tl-note' }, el('span', { class: 'proj-tl-note-ic', text: 'ⓘ' }), el('span', {}, '여기엔 ', el('b', { text: '이 프로젝트에 연결된 작업' }), '이 모여요 — 이 프로젝트의 터미널 세션에서 AI와 함께 진행했거나, 이 프로젝트로 직접 기록된 작업입니다(다른 프로젝트의 작업은 섞이지 않아요). ', el('b', { text: '확실하게 진행이 된 일을 위주로' }), ' 프로젝트 진행의 큰 맥락을 확인하는 용도로 사용해주세요.')), chipsBar, body);
    load();
    return card;
    async function load() {
        body.replaceChildren(skeletonRows(3));
        try {
            const qs = st.person ? ('?author_person=' + encodeURIComponent(st.person)) : '';
            const acts = await api(B + id + '/activity' + qs).then((d) => (d && d.activities) || []);
            if (!acts.length) {
                body.replaceChildren(el('div', { class: 'empty', text: st.person ? '이 팀원의 작업 기록이 없습니다.' : '아직 이 프로젝트 팀원의 작업 기록이 없습니다.' }));
                return;
            }
            renderActs(acts);
        }
        catch (e) {
            body.replaceChildren(errorNote(e, '타임라인을 불러오지 못했습니다'));
        }
    }
    // 5개까지 보이고 나머지는 '더 보기'로 펼침(끝없이 길어지지 않게).
    function renderActs(acts) {
        const LIMIT = 5;
        const list = el('div', { class: 'proj-tl-list' });
        for (const a of acts.slice(0, LIMIT))
            list.append(actRow(a));
        body.replaceChildren(list);
        if (acts.length > LIMIT) {
            const rest = acts.slice(LIMIT);
            const moreBtn = el('button', { class: 'btn btn-ghost btn-sm proj-tl-more', text: '＋ ' + rest.length + '개 더 보기' });
            moreBtn.onclick = () => { for (const a of rest)
                list.append(actRow(a)); moreBtn.remove(); };
            body.append(moreBtn);
        }
    }
    function actRow(a) { return activityTimelineRow(a, nameOf); }
}
// 팀원 수정 오버레이 — 현재 팀원 미리 체크된 멀티선택 → 통째 교체 저장.
function openMembersEdit(projectId, current, reload, base) {
    const B = base || '/api/ui/projects/';
    const picker = memberPicker(current || []);
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
    const back = overlayBox('팀원 수정', el('div', { class: 'field' }, el('label', { class: 'field-label', text: '함께하는 팀원' }), picker.box), el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
    saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        try {
            await api(B + projectId + '/members', { method: 'POST', body: JSON.stringify({ members: picker.getSelected() }) });
            back.remove();
            toast('팀원을 저장했습니다');
            reload();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            saveBtn.disabled = false;
        }
    };
}
// ── 태스크 행 제목 클릭 → 상세 모달 배선(몽키패치) ──
//  동시 리팩터되는 pjvTaskRow 를 인플레이스 편집하지 않고 감싼다(append-only, 그쪽 작업 무손상).
//  pjvTaskRow(projectId, t, members, reload, depth, fields[, …]) 의 인자 위치만 의존(t=1, reload=3) — 가변인자 보존.
(function () {
    if (typeof pjvTaskRow !== 'function' || pjvTaskRow.__tmWrapped)
        return;
    const _origPjvTaskRow = pjvTaskRow;
    // @ts-ignore 의도적 몽키패치 — function 선언을 런타임에서 재할당(JS 합법·동작 보존). TS 만 막아서 무시.
    pjvTaskRow = function (...args) {
        const node = _origPjvTaskRow.apply(this, args);
        try {
            const t = args[1], reload = args[3];
            const titleEl = node && node.querySelector ? node.querySelector('.pjv-trow-title') : null;
            if (titleEl && t && t.id != null && !titleEl.dataset.tmWired) {
                titleEl.dataset.tmWired = '1';
                titleEl.classList.add('clickable');
                titleEl.title = '상세 열기';
                titleEl.addEventListener('click', function (e) { e.stopPropagation(); pjvOpenTaskModal(t.id, reload); });
            }
        }
        catch (_) { /* 구조 달라도 무해 */ }
        return node;
    };
    pjvTaskRow.__tmWrapped = true;
})();
// ── 태스크 제목: 클릭=상세 모달 / 더블클릭=하위 태스크 추가(클릭업식). 위 모달 배선과 공존하도록 감싼다(append-only). ──
//  같은 click 을 행의 캡처 단계에서 가로채 단일/더블 구분 — 위 래퍼의 제목 click(모달)을 stopImmediatePropagation 으로
//  눌러두고: 1회=240ms 뒤 모달, 2회=하위 태스크 인라인 추가. depth 0(태스크)만. 셀/컨트롤 클릭은 그대로 통과.
(function () {
    if (typeof pjvTaskRow !== 'function' || pjvTaskRow.__cfDblWrapped)
        return;
    const _inner = pjvTaskRow;
    // @ts-ignore 의도적 몽키패치 — function 선언을 런타임에서 재할당(JS 합법·동작 보존). TS 만 막아서 무시.
    pjvTaskRow = function (...args) {
        const node = _inner.apply(this, args);
        try {
            const projectId = args[0], t = args[1], reload = args[3], depth = args[4] || 0;
            if (depth === 0 && node && node.querySelector) {
                const rowEl = node.querySelector('.pjv-trow');
                const titleEl = node.querySelector('.pjv-trow-title');
                const subBox = node.querySelector('.pjv-trow-subs');
                if (rowEl && titleEl && subBox && t && t.id != null && !rowEl.dataset.cfDbl) {
                    rowEl.dataset.cfDbl = '1';
                    titleEl.title = '클릭: 상세 열기 · 더블클릭: 하위 태스크 추가';
                    let clicks = 0, timer = null;
                    rowEl.addEventListener('click', function (e) {
                        // 제목 셀 전체(여백 포함)를 클릭 타깃으로 — 단, 캐럿·상태점은 각자 동작하도록 통과시킨다. 다른 컬럼 셀도 통과.
                        if (!e.target.closest('.pjv-trow-title-cell'))
                            return;
                        if (e.target.closest('.pjv-trow-caret') || e.target.closest('.pjv-status-dot') || e.target.closest('.pjv-subcount-ico'))
                            return; // 하위 태스크 아이콘 클릭은 펼침(모달/더블클릭 가로채기 제외)
                        if (e.target.closest('.pjv-row-check') || e.target.closest('.pjv-row-actions'))
                            return; // 다중선택 체크박스·호버 액션은 각자 동작(모달 가로채지 않음)
                        e.stopImmediatePropagation();
                        e.preventDefault();
                        clicks++;
                        if (clicks === 1) {
                            timer = setTimeout(function () { clicks = 0; if (typeof pjvOpenTaskModal === 'function')
                                pjvOpenTaskModal(t.id, reload); }, 240);
                        }
                        else {
                            clearTimeout(timer);
                            clicks = 0;
                            subBox.hidden = false;
                            const car = rowEl.querySelector('.pjv-trow-caret');
                            if (car && car.tagName === 'BUTTON') {
                                car.textContent = '▾';
                                car.setAttribute('aria-expanded', 'true');
                            }
                            pjvShowInlineSubtask(projectId, t, subBox, reload);
                        }
                    }, true); // 캡처 — 제목 자체 click(모달) 리스너보다 먼저
                }
            }
        }
        catch (_) { /* 구조 달라도 무해 */ }
        return node;
    };
    pjvTaskRow.__cfDblWrapped = true;
})();
export { PJV_PRIORITY, PJV_PRIORITY_ORDER, PJV_STATUS_ORDER, PJV_TASK_STATUS, authDownload, authUpload, avatarColor, buildWysiwygToolbar, debounce, fileIconSvg, fmtDateTime, fmtSize, initials, mdFromDom, openFileViewer, pjvAssigneeControl, pjvAssignees, pjvAssigneeWrite, pjvCheckMini, pjvDueControl, pjvFmtDate, pjvGridTemplate, pjvIsOverdue, pjvPatchTask, pjvPopover, pjvPriorityControl, pjvSaveTask, pjvStatusMeta, pjvTaskRow, renderProjectV2Detail, renderProjectsV2, };
