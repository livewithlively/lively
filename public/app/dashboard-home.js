// dashboard-home.ts — '대시보드' 상위 탭(#/dashboard). 옛 '시작하기' 자리를 개편한 나만의 코크핏(#617).
//  1단계(현재): 3열 고정 프리셋 — 좌(내 프로젝트 + 팀 공유 폴더) · 중(최신 알림 + 내 AI 세션) · 우(팀 작업 로그).
//   풀스크린·페이지 스크롤 없음(body[data-route="dashboard"] 훅) — 넘치는 목록은 위젯 '안에서만' 스크롤.
//   위젯별 독립 로드·독립 실패: 한 위젯의 API 오류가 대시보드 전체를 죽이지 않는다.
//  2단계(예정): 위젯 레지스트리 + 12×12 {x,y,w,h} 편집 모드(추가/제거·드래그·리사이즈·사람별 저장) — 이 프리셋이 기본 배치가 된다.
//  §0.5 채색 예산: 채운 파란 버튼은 화면당 1개([+ 새 세션])뿐. 나머지는 무채 카드 + 작은 상태점·아웃라인 배지.
import { api, el, errorNote, relTime, state, sv } from './core.js';
import { skeleton } from './learn.js';
import { companyTimelineSection } from './projects.js'; // 작업 로그 전체 보기 팝업 — 회사 활동 피드(유형·목록·더보기)를 그대로 재사용
// 하네스 라벨 폴백(terminal config 의 harnesses 와 동일 키) — cfg 로드 실패 시에도 읽히게.
const DASH_HARNESS_LABEL = { claude: 'Claude Code', codex: 'Codex' };
// 작업 유형 → 점 톤/라벨 — 작업 현황(dashboard.ts ACT_TYPE_TONE)과 동일 매핑(성격축 8종).
const DASH_ACT_TONE = { feature: 'mint', fix: 'coral', decision: 'blue', docs: 'teal', research: 'violet', review: 'amber', chore: 'mut', other: 'mut' };
const DASH_ACT_LABEL = { feature: '기능', fix: '수정', decision: '결정', docs: '문서', research: '리서치', review: '검토', chore: '운영', other: '기타' };
// 최신 알림(⓪) — 프로젝트 필드 변경 이벤트(getTaskFeed event)의 한국어 라벨.
const DASH_FIELD_LABEL = { status: '상태', assignee: '담당', priority: '우선순위', due_date: '마감', start_date: '시작일', name: '이름', description: '내용' };
// 활동 유형 → 알림 동사(주어=사람). 팀 작업 활동을 '~했어요' 문장으로.
const DASH_ACT_VERB = { feature: '기능을 추가했어요', fix: '오류를 고쳤어요', decision: '결정을 남겼어요', docs: '문서를 정리했어요', research: '리서치를 진행했어요', review: '리뷰를 남겼어요', chore: '작업을 처리했어요', other: '작업했어요' };
// ── 최신 알림 사용자화(유형별 on/off) — 전용 알림 백엔드가 없어 대시보드-로컬(localStorage, 기기별). ──
//  카탈로그는 앱 전체 신호를 감사해 '나에 관한 알림'이 될 수 있는 것만 실배선(dead 토글 금지). 사소한 변경(상태·수정·필드)은 기본 off.
const DASH_NOTIF_PREF_KEY = 'dash_notif_prefs_v1';
const DASH_NOTIF_GROUPS = [
    { title: '나에 관한 것', items: [
            { key: 'mention', label: '멘션 (@나)', desc: '댓글에서 나를 언급할 때', on: true },
            { key: 'session_invite', label: 'AI 세션 초대', desc: '나를 초대한 터미널 세션', on: true },
        ] },
    { title: '내 프로젝트', items: [
            { key: 'comment', label: '새 댓글', desc: '내 프로젝트에 달린 댓글', on: true },
            { key: 'activity', label: '팀원 작업', desc: '기능·수정·결정·문서·리서치·리뷰', on: true },
            { key: 'created', label: '새 항목 추가', desc: '태스크·프로젝트가 새로 생김', on: true },
            { key: 'assign', label: '담당자 변경', desc: '담당자가 바뀔 때', on: true },
        ] },
    { title: '사소한 변경', items: [
            { key: 'status', label: '상태 변경', desc: '예: 할 일 → 완료', on: false },
            { key: 'edit', label: '이름·내용 수정', desc: '제목·설명 편집', on: false },
            { key: 'field', label: '기타 필드 변경', desc: '마감·우선순위·시작일 등', on: false },
        ] },
    { title: '일정', items: [
            { key: 'due', label: '마감 임박·지남', desc: '7일 이내 또는 지난 마감', on: true },
        ] },
];
const DASH_NOTIF_DEFAULTS = (() => {
    const d = {};
    for (const g of DASH_NOTIF_GROUPS)
        for (const it of g.items)
            d[it.key] = it.on;
    return d;
})();
function dashNotifPrefs() {
    try {
        return { ...DASH_NOTIF_DEFAULTS, ...(JSON.parse(localStorage.getItem(DASH_NOTIF_PREF_KEY) || '{}') || {}) };
    }
    catch {
        return { ...DASH_NOTIF_DEFAULTS };
    }
}
function dashSaveNotifPrefs(p) { try {
    localStorage.setItem(DASH_NOTIF_PREF_KEY, JSON.stringify(p));
}
catch { /* 저장 실패 무시 */ } }
// 필드 변경 이벤트 → 프리셋 유형 키.
function dashFieldPref(field) {
    if (field === 'status')
        return 'status';
    if (field === 'name' || field === 'description')
        return 'edit';
    if (field === 'assignee')
        return 'assign';
    return 'field';
}
// ── 알림 읽음 상태(인박스) — 읽은 알림 key 집합(기기별 localStorage). 피드엔 없는 '읽음/안읽음'이 알림다움의 핵심. ──
const DASH_NOTIF_READ_KEY = 'dash_notif_read_v1';
function dashNotifReadSet() { try {
    const a = JSON.parse(localStorage.getItem(DASH_NOTIF_READ_KEY) || '[]');
    return new Set(Array.isArray(a) ? a : []);
}
catch {
    return new Set();
} }
function dashSaveNotifRead(set) { try {
    localStorage.setItem(DASH_NOTIF_READ_KEY, JSON.stringify([...set].slice(-300)));
}
catch { /* 저장 실패 무시 */ } }
async function renderMyDashboard(view) {
    // ── 셸 즉시 그리기(각 존은 스켈레톤) → 위젯별 병렬 로드 ──
    const sepEl = el('span', { text: ' · ' }); // 날짜와 요약 사이 구분점(요약 없으면 숨김)
    const summaryEl = el('span', { text: '불러오는 중…' }); // 인사줄 요약(프로젝트·세션 수) — 로드 후 갱신
    const obSlot = el('span'); // 온보딩 칩 자리(완료면 빈 채로)
    const zoneNotif = dashZone('notif', '최신 알림', '#/projects2/worklog', '작업 로그 →');
    const zoneProj = dashZone('proj', '내 프로젝트', '#/projects2', '프로젝트 →');
    const zoneSess = dashZone('sess', '내 AI 세션', '#/terminal', '터미널 →');
    const zoneFold = dashZone('fold', '팀 공유 폴더', '#/terminal', '터미널 →');
    const zoneLog = dashZone('log', '팀 작업 로그', '#/projects2/worklog', '작업 로그 →');
    // mine=1(내 프로젝트)·리스트는 '내 프로젝트'와 '최신 알림' 두 위젯이 공유 — 한 번만 호출(각자 독립적으로 await·실패처리).
    const projectsP = api('/api/ui/v6/projects?mine=1').then((d) => (d && d.projects) || []);
    const listsP = api('/api/ui/v6/project-lists').then((d) => (d && d.lists) || []).catch(() => []);
    const strip = el('div', { class: 'dash-strip' }, el('div', {}, el('div', { class: 'dash-hi', text: greeting() + ', ' + myDisplayName() + '님' }), el('div', { class: 'dash-date' }, todayLabel(), sepEl, summaryEl)), el('div', { class: 'dash-acts' }, obSlot, el('a', { class: 'btn btn-ghost btn-sm', href: '#/projects2', text: '+ 새 프로젝트' }), el('a', { class: 'btn btn-primary btn-sm', href: '#/terminal', text: '+ 새 세션' })));
    view.replaceChildren(el('div', { class: 'dash' }, strip, el('div', { class: 'dash-zones' }, el('div', { class: 'dash-colleft' }, zoneProj.box, zoneFold.box), el('div', { class: 'dash-colmid' }, zoneNotif.box, zoneSess.box), zoneLog.box)));
    document.getElementById('view').focus?.();
    // ── 위젯별 독립 로드(실패는 그 존 안에만 errorNote) ──
    const counts = { projects: null, sessions: null }; // 인사줄 요약용(null=미집계 — 로드 실패 포함)
    const drawSummary = () => {
        const parts = [];
        if (counts.projects != null)
            parts.push('진행 중 프로젝트 ' + counts.projects);
        if (counts.sessions != null)
            parts.push('실행 중 세션 ' + counts.sessions);
        summaryEl.textContent = parts.join(' · ');
        sepEl.hidden = !parts.length; // 요약이 비면(양쪽 다 실패) 구분점도 숨김 — '날짜 · ' 꼬리 방지
    };
    fillNotifications(zoneNotif, projectsP);
    fillProjects(zoneProj, (n) => { counts.projects = n; drawSummary(); }, projectsP, listsP);
    fillSessions(zoneSess, (n) => { counts.sessions = n; drawSummary(); }, projectsP);
    fillFolders(zoneFold);
    fillActivity(zoneLog);
    fillOnboarding(obSlot);
}
// ── 인사 스트립 조각들 ──
function greeting() {
    const h = new Date().getHours();
    if (h < 5)
        return '늦은 밤이에요';
    if (h < 11)
        return '좋은 아침이에요';
    if (h < 17)
        return '좋은 오후예요';
    if (h < 22)
        return '좋은 저녁이에요';
    return '늦은 밤이에요';
}
function myDisplayName() {
    const me = state.me || {};
    return me.display_name || String(me.email || me.userId || '').split('@')[0] || '나';
}
function todayLabel() {
    return new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });
}
// 온보딩 진행 칩 — 미완일 때만 표시(완료·실패면 조용히 생략). 클릭 → #/onboarding.
async function fillOnboarding(slot) {
    try {
        const s = await api('/api/ui/org/onboarding');
        if (!s || s.complete)
            return;
        slot.replaceChildren(el('a', { class: 'dash-ob', href: '#/onboarding', title: '온보딩 진행상황 보기' }, el('span', { text: `온보딩 ${s.done}/${s.total}` }), el('span', { class: 'dash-ob-bar' }, el('span', { class: 'dash-ob-fill', style: 'width:' + (s.pct || 0) + '%' }))));
    }
    catch { /* 칩 없이 진행 */ }
}
// ── 존(위젯 카드) 공통 셸 — 헤더(제목·카운트·칩 슬롯·딥링크) + 내부 스크롤 목록 ──
function dashZone(key, title, moreHref, moreLabel) {
    const countEl = el('span', { class: 'dash-wh-n' });
    const chipsEl = el('span', { class: 'dash-wh-chips' });
    const body = el('div', { class: 'dash-wl' });
    body.append(skeleton('불러오는 중'));
    const box = el('section', { class: 'dash-zone dash-zone--' + key, 'aria-label': title }, el('div', { class: 'dash-wh' }, el('h4', { text: title }), countEl, chipsEl, el('a', { class: 'dash-wh-go', href: moreHref, text: moreLabel })), body);
    return { box, body, countEl, chipsEl };
}
function dashChips(chipsEl, items, activeKey, onPick) {
    chipsEl.replaceChildren(...items.map(([key, label]) => el('button', {
        class: 'dash-chip' + (key === activeKey ? ' on' : ''), type: 'button',
        'aria-pressed': key === activeKey ? 'true' : 'false', text: label,
        onclick: () => { if (key !== activeKey)
            onPick(key); },
    })));
}
function dashEmpty(text) { return el('div', { class: 'dash-empty', text }); }
// ── ① 내 프로젝트 — mine=1(생성자 OR 팀원)를 '리스트 블럭(개요 카드)'으로(#622). ──
//  프로젝트 탭 폴더 개요(pjv-overview)와 동일한 카드 UI: 리스트별 블럭에 글리프·이름 · 'N개 프로젝트' · 상태 미니바.
//  블럭을 누르면 그 리스트로 진입(#/projects2/l/<id>) — 기존 프로젝트 탭에서 그 안의 프로젝트가 그대로 보인다.
async function fillProjects(zone, onCount, projectsP, listsP) {
    let projects, lists;
    try {
        [projects, lists] = await Promise.all([projectsP, listsP]);
    }
    catch (e) {
        onCount(null);
        zone.body.replaceChildren(errorNote(e, '내 프로젝트를 불러오지 못했습니다'));
        return;
    }
    const isDone = (p) => p.status === 'done' || p.status_category === 'done' || p.status_category === 'closed';
    onCount(projects.filter((p) => !isDone(p)).length);
    const listById = new Map(lists.map((l) => [l.id, l]));
    // 상태 묶음(개요 미니바) — 프로젝트 탭 개요의 brk 와 동일 3버킷(할일·진행·완료).
    const brk = (arr) => ({ total: arr.length, done: arr.filter(isDone).length,
        prog: arr.filter((p) => !isDone(p) && p.status !== 'todo').length, todo: arr.filter((p) => p.status === 'todo').length });
    // 프로젝트 행 — 프로젝트 탭 리스트 행(pjv-trow-title-cell)과 동일 UI: 상태 아이콘(진행도 파이/체크) + 이름 + 태스크 수 + 세션 배지 + 태그.
    //  좁은 대시보드 폭이라 프로젝트 탭 표의 나머지 열(담당·마감·날짜·우선순위 등)은 생략하고 제목 셀만 그대로 차용. 클릭→프로젝트 상세.
    const dashProjRow = (p) => {
        const cell = el('div', { class: 'pjv-trow-title-cell' }, dashProjStatusIcon(p, listById), el('span', { class: 'pjv-trow-title clickable' + (isDone(p) ? ' done' : ''), title: p.name, text: p.name }));
        if (Number(p.task_count) > 0)
            cell.append(el('span', { class: 'pjv-trow-subcount pjv-subcount-ico', title: p.task_count + '개 태스크' }, dashSubtaskIcon(), el('span', { text: String(p.task_count) })));
        if (p.my_session_count)
            cell.append(el('span', { class: 'dash-badge', text: '세션 ' + p.my_session_count }));
        const tags = dashRowTags(p);
        if (tags)
            cell.append(tags);
        return el('a', { class: 'dash-projrow2', href: '#/projects2/p/' + p.id }, cell);
    };
    // 리스트 그룹 — 프로젝트 탭 리스트 헤더(pjv-list-head: 캐럿·글리프·이름·개수, 접기/펼치기) + 행들. 미분류는 색점.
    const dashProjGroup = (listId, l, arr) => {
        const isUn = !listId;
        const body = el('div', { class: 'pjv-tgroup-body' });
        for (const p of arr)
            body.append(dashProjRow(p));
        let open = true;
        const caret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: '▾', 'aria-expanded': 'true' });
        const setOpen = (o) => { open = o; caret.textContent = o ? '▾' : '▸'; caret.setAttribute('aria-expanded', String(o)); body.hidden = !o; };
        caret.onclick = (e) => { e.stopPropagation(); setOpen(!open); };
        const dot = isUn
            ? el('span', { class: 'pjv-list-dot', style: 'background:' + ((l && l.color) || 'var(--muted-3)'), 'aria-hidden': 'true' })
            : el('span', { class: 'pjv-list-headglyph', 'aria-hidden': 'true' }, dashListGlyph(l));
        const head = el('div', { class: 'pjv-tgroup-head pjv-list-head' + (isUn ? ' pjv-list-head-un' : '') }, el('div', { class: 'pjv-list-head-main' }, caret, dot, el('span', { class: 'pjv-tgroup-label', text: (l && l.name) || '미분류' }), el('span', { class: 'pjv-tgroup-count', text: String(arr.length) })));
        head.addEventListener('click', (e) => { if (e.target.closest('button'))
            return; setOpen(!open); });
        return el('div', { class: 'pjv-tgroup pjv-list-group' }, head, body);
    };
    // 리스트 블럭 카드 — pjv-overview 의 ovCard 와 동일 마크업. 클릭=이 리스트 '선택'(아래 목록을 그 리스트만으로 필터),
    //  드래그=개요 순서 변경(대시보드-로컬 저장). 선택된 카드는 강조(파란 링).
    let dragListId = null;
    const projBlock = (listId, l, arr) => {
        const b = brk(arr);
        const name = (l && l.name) || '미분류';
        const card = el('div', { class: 'pjv-ov-card dash-ov-card2' + (listId === selectedListId ? ' selected' : ''),
            role: 'button', tabindex: '0', title: name, draggable: 'true', 'data-list-id': String(listId) }, el('div', { class: 'pjv-ov-card-head' }, dashListGlyph(l), el('span', { class: 'pjv-ov-card-name', text: name })), el('div', { class: 'pjv-ov-card-count', text: b.total + '개 프로젝트' }));
        const bar = el('div', { class: 'pjv-ov-bar' });
        const seg = (n, cls) => { if (n > 0) {
            const s = el('span', { class: 'pjv-ov-bar-seg ' + cls });
            s.style.flex = String(n);
            bar.append(s);
        } };
        if (b.total) {
            seg(b.todo, 'todo');
            seg(b.prog, 'prog');
            seg(b.done, 'done');
        }
        else
            bar.append(el('span', { class: 'pjv-ov-bar-seg empty' }));
        card.append(bar);
        const pick = () => { if (selectedListId !== listId) {
            selectedListId = listId;
            draw();
        } };
        card.addEventListener('click', pick);
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
        } });
        // 드래그 순서 변경 — 대시보드-로컬(localStorage) 저장, 프로젝트 탭 리스트 순서와는 독립.
        card.addEventListener('dragstart', (e) => { dragListId = listId; try {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(listId));
        }
        catch { /* */ } card.classList.add('drag-src'); });
        card.addEventListener('dragend', () => { dragListId = null; card.classList.remove('drag-src'); document.querySelectorAll('.dash-ov-card2.drag-over').forEach((n) => n.classList.remove('drag-over')); });
        card.addEventListener('dragover', (e) => { if (dragListId == null || dragListId === listId)
            return; e.preventDefault(); card.classList.add('drag-over'); });
        card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
        card.addEventListener('drop', (e) => {
            e.preventDefault();
            card.classList.remove('drag-over');
            if (dragListId == null || dragListId === listId)
                return;
            dashReorderList(currentOrder, dragListId, listId);
            draw();
        });
        return card;
    };
    let mode = 'active'; // 진행 중 | 전체 — 완료 프로젝트 포함 여부.
    let selectedListId; // 선택된 리스트(아래 목록 필터). 기본=첫 리스트.
    let currentOrder = []; // 현재 표시 중인 리스트 순서(드래그 재정렬 기준).
    const draw = () => {
        const shown = mode === 'active' ? projects.filter((p) => !isDone(p)) : projects;
        zone.countEl.textContent = String(shown.length);
        dashChips(zone.chipsEl, [['active', '진행 중'], ['all', '전체']], mode, (k) => { mode = k; draw(); });
        if (!shown.length) {
            zone.body.replaceChildren(dashEmpty(mode === 'active' ? '진행 중인 내 프로젝트가 없어요.' : '내가 참여한 프로젝트가 없어요.'));
            return;
        }
        // 리스트별 묶음, 미분류(list_id 없음)는 맨 뒤 → 저장된 개요 순서 적용.
        const byList = new Map();
        for (const p of shown) {
            const k = p.list_id || 0;
            if (!byList.has(k))
                byList.set(k, []);
            byList.get(k).push(p);
        }
        const base = [...lists.map((l) => l.id).filter((id) => byList.has(id)), ...(byList.has(0) ? [0] : [])];
        currentOrder = dashApplyListOrder(base);
        // 기본 선택 = 첫 리스트. 선택이 사라졌으면(모드 전환 등) 첫 리스트로 폴백.
        if (selectedListId === undefined || !byList.has(selectedListId))
            selectedListId = currentOrder[0];
        const grid = el('div', { class: 'pjv-ov-grid dash-ov-grid' });
        for (const listId of currentOrder)
            grid.append(projBlock(listId, listById.get(listId), byList.get(listId)));
        // 선택된 리스트의 프로젝트만 — 프로젝트 탭과 동일한 리스트 그룹(헤더+행). 강조된 카드가 곧 선택 표시.
        const arr = (byList.get(selectedListId) || []).slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
        const listEl = el('div', { class: 'dash-projlist' }, dashProjGroup(selectedListId, listById.get(selectedListId), arr));
        zone.body.replaceChildren(grid, listEl);
    };
    draw();
}
// 리스트 글리프 — 프로젝트 탭 사이드바(pjvListGlyph)와 동일: 이모지 아이콘 or 체크리스트 라인 아이콘.
function dashListGlyph(list) {
    const emoji = list && list.settings && list.settings.icon;
    if (emoji)
        return el('span', { class: 'pjv-side-listemoji', text: String(emoji) });
    const color = (list && list.color) || 'var(--muted-2)';
    const n = sv('svg', { class: 'pjv-side-listglyph', viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M4 7l1.6 1.6L8.4 5.6' }), sv('path', { d: 'M11 7h9' }), sv('path', { d: 'M4 15l1.6 1.6L8.4 13.6' }), sv('path', { d: 'M11 15h9' }));
    return n;
}
// ── 프로젝트 상태 아이콘(프로젝트 탭과 동일) — projects.ts 를 건드리지 않고 소형 동형 함수로 인라인(#619 재사용 원칙). ──
// 리스트 커스텀 상태 정의 정규화 + Active 버킷 진행도(frac) — pjvListStatusDefs/pjvAssignFracs 동형.
function dashListStatusDefs(list) {
    const s = list && list.settings;
    let defs;
    if (s && s.statusMode === 'custom' && Array.isArray(s.statuses) && s.statuses.length) {
        defs = s.statuses.filter((x) => x && x.key).map((x) => ({
            key: String(x.key), label: String(x.label || x.key), color: x.color || '#94a3b8',
            category: (x.category === 'done' || x.category === 'closed') ? x.category : 'active',
        }));
    }
    else {
        defs = [
            { key: 'todo', label: '할 일', color: '#94a3b8', category: 'active' },
            { key: 'active', label: '진행 중', color: '#f59e0b', category: 'active' },
            { key: 'done', label: '완료', color: '#22c55e', category: 'done' },
        ];
    }
    const act = defs.filter((d) => d.category === 'active');
    act.forEach((d, i) => { d.frac = act.length > 0 ? i / act.length : 0; });
    return defs;
}
// 프로젝트 → 상태 def 해석 — status_raw 우선, 미스매치는 네이티브 status 로 흡수(pjvResolveProjStatus 동형).
function dashResolveStatus(p, defs) {
    const rawKey = p.status_raw || p.status;
    let d = defs.find((x) => x.key === rawKey);
    if (!d) {
        if (p.status === 'done')
            d = defs.find((x) => x.category === 'done') || defs.find((x) => x.category === 'closed');
        else
            d = defs.find((x) => x.category === 'active');
    }
    return d || defs[0];
}
// 상태 아이콘(SVG) — pjvStatusIcon 동형: Active=진행도 파이(frac=0→점선 빈 링='할일') · Done=색 링+체크 · Closed=꽉 찬 원+흰 체크.
function dashStatusIconSvg(category, color, frac) {
    const c = color || 'var(--muted-3)';
    const R = 9, cx = 12, cy = 12;
    const svg = sv('svg', { class: 'pjv-status-ic', viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' });
    if (category === 'done' || category === 'closed') {
        const filled = category === 'closed';
        svg.append(sv('circle', { cx, cy, r: R, 'stroke-width': 2, style: 'fill:' + (filled ? c : 'none') + ';stroke:' + c }));
        svg.append(sv('path', { d: 'M7.7 12.3l2.7 2.7 5.9-6.2', 'stroke-width': 2.1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', style: 'fill:none;stroke:' + (filled ? '#fff' : c) }));
        return svg;
    }
    const f = Math.max(0, Math.min(0.995, frac || 0));
    if (f < 0.001) {
        svg.append(sv('circle', { cx, cy, r: R, 'stroke-width': 2, 'stroke-dasharray': '2.2 2.4', style: 'fill:none;stroke:' + c }));
    }
    else {
        svg.append(sv('circle', { cx, cy, r: R, 'stroke-width': 2, opacity: 0.3, style: 'fill:none;stroke:' + c }));
        const th = f * 2 * Math.PI;
        const ex = (cx + R * Math.sin(th)).toFixed(2), ey = (cy - R * Math.cos(th)).toFixed(2);
        const large = f > 0.5 ? 1 : 0;
        svg.append(sv('path', { d: 'M' + cx + ' ' + cy + 'L' + cx + ' ' + (cy - R) + 'A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + ex + ' ' + ey + 'Z', style: 'fill:' + c }));
    }
    return svg;
}
// 프로젝트 → 상태 아이콘. 리스트 커스텀 상태(있으면) 반영, 없으면 표준 3단계(pjvStatusIconStd 동형).
function dashProjStatusIcon(p, listById) {
    const l = p.list_id != null ? listById.get(p.list_id) : null;
    const s = l && l.settings;
    if (s && s.statusMode === 'custom' && Array.isArray(s.statuses) && s.statuses.length) {
        const def = dashResolveStatus(p, dashListStatusDefs(l));
        return dashStatusIconSvg(def.category, def.color, def.frac);
    }
    if (p.status === 'done')
        return dashStatusIconSvg('done', 'var(--mint)');
    if (p.status === 'todo')
        return dashStatusIconSvg('active', 'var(--muted-3)', 0);
    return dashStatusIconSvg('active', 'var(--blue)', 0.5);
}
// 하위 태스크 아이콘 — 프로젝트 탭 pjvSubtaskIcon 동형(서브카운트 배지 안).
function dashSubtaskIcon() {
    const n = sv('svg', { class: 'pjv-subtask-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 7, cy: 6, r: 2.2 }), sv('circle', { cx: 17, cy: 17, r: 2.2 }), sv('path', { d: 'M7 8.2v5.6a2.6 2.6 0 0 0 2.6 2.6H14.6' }));
    return n;
}
// 프로젝트 태그 칩(비인터랙티브) — 프로젝트 탭 pjvRowTagsEl 와 동일 마크업, 최대 2 + "+N".
function dashRowTags(p) {
    const cur = (p.tags || []);
    if (!cur.length)
        return null;
    const wrap = el('span', { class: 'pjv-trow-tags' });
    for (const tg of cur.slice(0, 2))
        wrap.append(el('span', { class: 'pjv-trow-tag', style: '--tag:' + (tg.color || 'var(--muted)'), title: tg.name }, el('span', { class: 'pjv-trow-tag-name', text: tg.name })));
    if (cur.length > 2)
        wrap.append(el('span', { class: 'pjv-trow-tag-more', text: '+' + (cur.length - 2) }));
    return wrap;
}
// ── 개요 리스트 순서(드래그) — 대시보드-로컬(localStorage). 프로젝트 탭의 리스트 순서와는 독립. ──
const DASH_LIST_ORDER_KEY = 'dash_list_order_v1';
function dashListOrderSaved() { try {
    const a = JSON.parse(localStorage.getItem(DASH_LIST_ORDER_KEY) || '[]');
    return Array.isArray(a) ? a : [];
}
catch {
    return [];
} }
function dashSaveListOrder(order) { try {
    localStorage.setItem(DASH_LIST_ORDER_KEY, JSON.stringify(order));
}
catch { /* 저장 실패 무시 */ } }
// 저장된 순서를 현재 리스트 집합(base)에 적용 — 저장분 먼저(그 순서대로), 새 리스트는 뒤에.
function dashApplyListOrder(base) {
    const saved = dashListOrderSaved();
    const head = saved.filter((id) => base.includes(id));
    const tail = base.filter((id) => !head.includes(id));
    return [...head, ...tail];
}
// dragId 를 targetId 앞으로 이동 → 저장(현재 화면 밖 리스트 순서도 보존해 병합).
function dashReorderList(order, dragId, targetId) {
    const arr = order.filter((id) => id !== dragId);
    const ti = arr.indexOf(targetId);
    arr.splice(ti < 0 ? arr.length : ti, 0, dragId);
    const saved = dashListOrderSaved();
    dashSaveListOrder([...arr, ...saved.filter((id) => !arr.includes(id))]);
}
// ── 경량 모달(중앙 오버레이) — 배경/✕/Esc 로 닫힘. 공유 폴더 전체 보기 등. ──
function dashModal(title, content) {
    document.querySelectorAll('.dash-modal-ov').forEach((n) => n.remove());
    const closeBtn = el('button', { class: 'dash-modal-x', type: 'button', 'aria-label': '닫기', text: '✕' });
    const box = el('div', { class: 'dash-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, el('div', { class: 'dash-modal-head' }, el('strong', { text: title }), closeBtn), el('div', { class: 'dash-modal-body' }, content));
    const ov = el('div', { class: 'dash-modal-ov' }, box);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape')
        close(); };
    ov.addEventListener('mousedown', (e) => { if (e.target === ov)
        close(); });
    closeBtn.onclick = close;
    document.addEventListener('keydown', onKey, true);
    document.body.append(ov);
    return close;
}
// ── ② 내 AI 세션 — 내 것 + 초대받은 것 + '프로젝트에서 만든 세션' 통합(접속중 우선). ──
//  UI 는 터미널 탭의 세션 박스(term-row: 약간 푸른 카드)와 통일. 프로젝트 세션(@box_project)은 프로젝트 뱃지로 식별.
//  [열기] = 터미널 새 창. (세션 created 는 unix '초' → relTime 은 ms/ISO 기대라 ×1000 변환: 1970 표기 버그 수정.)
async function fillSessions(zone, onCount, projectsP) {
    let sessions, cfg, projects;
    try {
        [sessions, cfg, projects] = await Promise.all([
            api('/api/ui/terminal/sessions').then((d) => (d && d.sessions) || []),
            api('/api/ui/terminal/config').catch(() => null), // 라벨 보강용 — 실패해도 폴백으로 진행
            (projectsP || Promise.resolve([])).catch(() => []), // 프로젝트 세션의 프로젝트명 매핑용
        ]);
    }
    catch (e) {
        onCount(null);
        zone.body.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다'));
        return;
    }
    onCount(sessions.filter((s) => s.attached).length);
    const projName = new Map((projects || []).map((p) => [p.id, p.name]));
    const memberName = (id) => {
        const m = ((cfg && cfg.members) || []).find((x) => x.id === id);
        return (m && m.name) || id || '';
    };
    const harnessLabel = (key) => {
        const h = ((cfg && cfg.harnesses) || []).find((x) => x.key === key);
        return (h && h.label) || DASH_HARNESS_LABEL[key] || key || '';
    };
    const sessTime = (c) => { const n = Number(c); return n ? relTime(new Date(n * 1000).toISOString()) : ''; };
    let mode = 'all'; // 전체 | 내 것 | 초대받음
    const draw = () => {
        const shown = sessions
            .filter((s) => mode === 'mine' ? s.owned : (mode === 'invited' ? !s.owned : true))
            .sort((a, b) => (b.attached ? 1 : 0) - (a.attached ? 1 : 0) || (Number(b.created) || 0) - (Number(a.created) || 0));
        zone.countEl.textContent = String(shown.length);
        dashChips(zone.chipsEl, [['all', '전체'], ['mine', '내 것'], ['invited', '초대받음']], mode, (k) => { mode = k; draw(); });
        if (!shown.length) {
            zone.body.replaceChildren(dashEmpty(mode === 'invited' ? '초대받은 세션이 없어요.' : '세션이 없어요 — [+ 새 세션]으로 시작해 보세요.'));
            return;
        }
        const list = el('div', { class: 'dash-sess-list' });
        for (const s of shown) {
            const sub = [harnessLabel(s.harness), s.dir, sessTime(s.created)].filter(Boolean).join(' · ');
            const badges = el('span', { class: 'dash-sess-badges' });
            if (s.attached)
                badges.append(el('span', { class: 'dash-badge live', text: '접속중' }));
            // 프로젝트에서 만든 세션(@box_project) — 프로젝트명 뱃지로 식별.
            const pid = Number(s.projectId) || 0;
            if (pid)
                badges.append(el('span', { class: 'dash-badge dash-badge-proj', title: '프로젝트: ' + (projName.get(pid) || pid), text: projName.get(pid) || ('프로젝트 #' + pid) }));
            if (s.owned) {
                if ((s.invites || []).length)
                    badges.append(el('span', { class: 'dash-badge', text: '초대 ' + s.invites.length }));
            }
            else
                badges.append(el('span', { class: 'dash-badge', title: '소유: ' + memberName(s.owner), text: memberName(s.owner) + ' · 초대받음' }));
            const info = el('div', { class: 'dash-sess-info' }, el('div', { class: 'dash-sess-title' }, el('span', { class: 'dash-sess-name', title: s.label, text: s.label || '(이름 없음)' }), badges), el('div', { class: 'dash-sess-sub', title: sub, text: sub }));
            const openBtn = el('button', { class: 'dash-sess-open', type: 'button', text: '열기' });
            openBtn.onclick = () => window.open('/ui/terminal.html?session=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || ''), '_blank');
            list.append(el('div', { class: 'dash-sess-box' + (s.attached ? ' live' : '') }, info, openBtn));
        }
        zone.body.replaceChildren(list);
    };
    draw();
}
// ── ③ 팀 공유 폴더 — 공유 워크스페이스 루트의 폴더. 목록형→아이콘형(#621). ──
//  프로젝트 상세 '공유 폴더'와 동일한 아이콘 카드(proj-file-*): 맥 스타일 폴더 아이콘 + 이름 + '폴더'.
async function fillFolders(zone) {
    const goEl = zone.box.querySelector('.dash-wh-go');
    let data;
    try {
        data = await api('/api/ui/terminal/browse?root=shared&path=');
    }
    catch (e) {
        zone.body.replaceChildren(errorNote(e, '공유 폴더를 불러오지 못했습니다'));
        return;
    }
    const dirs = (data && data.dirs) || [];
    zone.countEl.textContent = String(dirs.length);
    // 헤더 '터미널 →' → '전체 보기'(공유 폴더 팝업) — 박스는 한 줄만 보이므로 전체는 팝업으로.
    if (goEl) {
        const btn = el('button', { class: 'dash-wh-go dash-wh-set', type: 'button', title: '공유 폴더 전체 보기' }, el('span', { text: '전체 보기' }));
        btn.onclick = () => dashModal('팀 공유 폴더', dirs.length ? el('div', { class: 'proj-file-grid dash-foldpop-grid' }, ...dirs.map(dashFolderCard)) : dashEmpty('공유 워크스페이스에 폴더가 없어요.'));
        goEl.replaceWith(btn);
    }
    if (!dirs.length) {
        zone.body.replaceChildren(dashEmpty('공유 워크스페이스에 폴더가 없어요.'));
        return;
    }
    const grid = el('div', { class: 'proj-file-grid dash-fold-grid' });
    for (const name of dirs)
        grid.append(dashFolderCard(name));
    zone.body.replaceChildren(grid);
}
// 공유 폴더 아이콘 카드 — 박스·팝업 공용. 프로젝트 상세 공유 폴더(proj-file-*)와 동일.
function dashFolderCard(name) {
    return el('div', { class: 'proj-file-card', title: name }, el('div', { class: 'proj-file-card-ic' }, dashFolderThumb()), el('div', { class: 'proj-file-card-nm', text: name }), el('div', { class: 'proj-file-card-sz', text: '폴더' }));
}
// 맥 스타일 폴더 아이콘 — 프로젝트 상세 공유 폴더의 folderThumb 과 동일(ft ft-folder; 색은 styles.css).
function dashFolderThumb() {
    const n = sv('svg', { class: 'ft ft-folder', viewBox: '0 0 48 40', fill: 'none', 'aria-hidden': 'true' });
    n.append(sv('path', { class: 'ft-folder-tab', d: 'M4 9a3 3 0 0 1 3-3h10.5l4 4H4z' }));
    n.append(sv('path', { class: 'ft-folder-body', d: 'M4 12a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z' }));
    return n;
}
// ── ④ 팀 작업 로그 — 회사 전체 활동 피드(유형점 + 요약 + 사람·AI·상대시간). 팀원 칩 필터. ──
//  헤더 '전체 보기'·행 클릭 = 전체 작업 로그 팝업(유형 필터·전체 목록·더보기). 별도 작업 로그 페이지는 폐지(#609 이관본도 팝업으로 통합).
function openWorklogPopup() { dashModal('작업 로그', companyTimelineSection()); }
async function fillActivity(zone) {
    const goEl = zone.box.querySelector('.dash-wh-go');
    if (goEl) {
        const btn = el('button', { class: 'dash-wh-go dash-wh-set', type: 'button', title: '전체 작업 로그 보기' }, el('span', { text: '전체 보기' }));
        btn.onclick = openWorklogPopup;
        goEl.replaceWith(btn);
    }
    let rows, people;
    try {
        [rows, people] = await Promise.all([
            api('/api/ui/activity/list?limit=60').then((d) => (Array.isArray(d) ? d : (d && d.rows) || [])),
            api('/api/ui/dash/people').then((d) => (d && d.people) || []).catch(() => []),
        ]);
    }
    catch (e) {
        zone.body.replaceChildren(errorNote(e, '작업 로그를 불러오지 못했습니다'));
        return;
    }
    const nameOf = (pid) => {
        if (!pid)
            return '';
        const m = people.find((x) => x.author_person === pid);
        return (m && m.display_name) || pid;
    };
    // 칩: 전체 + 활동 있는 팀원(요약 응답 순서, 과밀 방지 위해 최대 3명 — 그 외는 작업 로그 탭에서).
    const chipPeople = people.filter((p) => p.author_person).slice(0, 3);
    let person = ''; // '' = 전체
    const draw = () => {
        const shown = person ? rows.filter((a) => a.author_person === person) : rows;
        zone.countEl.textContent = String(shown.length);
        dashChips(zone.chipsEl, [['', '전체'], ...chipPeople.map((p) => [p.author_person, (p.display_name || p.author_person).slice(0, 4)])], person, (k) => { person = k; draw(); });
        if (!shown.length) {
            zone.body.replaceChildren(dashEmpty('아직 기록된 작업이 없어요.'));
            return;
        }
        zone.body.replaceChildren(...shown.map((a) => {
            const when = a.committed_at || a.created_at;
            const sub = [nameOf(a.author_person), a.author_agent, when ? relTime(when) : '']
                .filter(Boolean).join(' · ');
            return el('div', { class: 'dash-row dash-row--log', role: 'button', tabindex: '0', onclick: openWorklogPopup }, el('span', { class: 'dash-dot tn-' + (DASH_ACT_TONE[a.type] || 'mut'), title: DASH_ACT_LABEL[a.type] || a.type || '' }), el('span', { class: 'dash-nm' }, el('span', { class: 'dash-nm-line', title: a.summary || a.title || '', text: a.summary || a.title || '(제목 없음)' }), el('span', { class: 'dash-sub', text: sub })));
        }));
    };
    draw();
}
// ── ⓪ 최신 알림 — '나에 관한' 개인 인박스(팀 작업 로그와 별개). 전용 알림 백엔드가 없어(감사) 기존 API 합성:
//  활동(activity/list) · 댓글/멘션/필드변경(프로젝트별 getTaskFeed, 상위 K) · 다가오는 마감 · 나를 초대한 AI 세션.
//  내 행위는 빼고 '남이 한 것·내가 알아야 할 것'만 최신순. 유형별 on/off 는 헤더 '알림 설정'(dashNotifPrefs, 기기별 저장).
//  각 알림은 '누가·무엇을·언제'가 한눈에 — 행위자 아바타 + 유형 뱃지 + 동사형 문장 + 상대시간(#알림 UX).
async function fillNotifications(zone, projectsP) {
    const meId = (state.me && (state.me.userId || state.me.email)) || '';
    const myName = myDisplayName();
    // 헤더 '작업 로그 →' 자리를 '알림 설정'(사용자화 팝업) 트리거로 교체.
    const goEl = zone.box.querySelector('.dash-wh-go');
    let projects;
    try {
        projects = await projectsP;
    }
    catch (e) {
        zone.body.replaceChildren(errorNote(e, '알림을 불러오지 못했습니다'));
        return;
    }
    const people = await api('/api/ui/dash/people').then((d) => (d && d.people) || []).catch(() => []);
    const nameOf = (pid) => { if (!pid)
        return ''; const m = people.find((x) => x.author_person === pid); return (m && m.display_name) || pid; };
    const projById = new Map(projects.map((p) => [p.id, p]));
    const myIds = new Set(projects.map((p) => p.id));
    // 댓글·변경 피드는 최근 갱신 상위 K개 프로젝트만(과다 요청 방지 — 활동은 대개 최근 프로젝트에 몰림).
    const K = 12;
    const topIds = projects.slice()
        .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
        .slice(0, K).map((p) => p.id);
    const [acts, feeds, sess, scfg] = await Promise.all([
        api('/api/ui/activity/list?limit=100').then((d) => (Array.isArray(d) ? d : (d && d.rows) || [])).catch(() => []),
        Promise.all(topIds.map((id) => api('/api/ui/v6/projects/' + id + '/comments')
            .then((d) => ({ id, feed: (d && d.feed) || [] })).catch(() => ({ id, feed: [] })))),
        api('/api/ui/terminal/sessions').then((d) => (d && d.sessions) || []).catch(() => []), // 세션 초대용
        api('/api/ui/terminal/config').catch(() => null),
    ]);
    const memberName = (id) => { const m = ((scfg && scfg.members) || []).find((x) => x.id === id); return (m && m.name) || id || ''; };
    const items = [];
    // (1) 활동 — 내 프로젝트 + 내가 아닌 사람. 동사형 문장(누가 ~했어요) + 상세는 summary.
    for (const a of acts) {
        if (!myIds.has(a.project_id) || (a.author_person && a.author_person === meId))
            continue;
        items.push({ ts: a.committed_at || a.created_at, kind: 'act', pref: 'activity', tone: DASH_ACT_TONE[a.type] || 'mut',
            verb: DASH_ACT_VERB[a.type] || '작업했어요', snippet: a.summary || a.title || '',
            actorPerson: a.author_person, agent: a.author_agent, who: nameOf(a.author_person) || a.author_agent || '누군가',
            pid: a.project_id, proj: projById.get(a.project_id)?.name || '' });
    }
    // (2) 프로젝트 피드 — 댓글/멘션/새항목/필드변경. 내가 한 건 제외.
    for (const { id, feed } of feeds) {
        const pname = projById.get(id)?.name || '';
        for (const f of feed) {
            if (f.actor && f.actor === meId)
                continue;
            const who = f.display_name || nameOf(f.actor) || '누군가';
            const base = { ts: f.ts, actorPerson: f.actor, who, pid: id, proj: pname };
            if (f.kind === 'comment') {
                const body = String(f.body || '').replace(/\s+/g, ' ').trim();
                const mentioned = !!myName && (body.includes('@' + myName) || (!!meId && body.includes('@' + meId)));
                items.push({ ...base, kind: mentioned ? 'mention' : 'comment', pref: mentioned ? 'mention' : 'comment',
                    verb: mentioned ? '나를 언급했어요' : '댓글을 남겼어요', snippet: body || '(내용 없음)' });
            }
            else if (f.kind === 'event' && f.field === 'created') {
                items.push({ ...base, kind: 'created', pref: 'created', verb: '새로 만들었어요', snippet: '' });
            }
            else if (f.kind === 'event' && f.field) {
                items.push({ ...base, kind: 'update', pref: dashFieldPref(f.field), verb: eventLabel(f), snippet: '' });
            }
        }
    }
    // (3) 세션 초대 — 나를 초대한(내가 소유 아님) AI 세션. created 를 시각으로.
    for (const s of sess) {
        if (s.owned)
            continue;
        items.push({ ts: s.created ? new Date((Number(s.created) || 0) * 1000).toISOString() : '', kind: 'invite', pref: 'session_invite',
            verb: 'AI 세션에 초대했어요', snippet: s.label || '(이름 없음)', who: memberName(s.owner) || '누군가', actorPerson: s.owner,
            sid: s.id, label: s.label });
    }
    // (4) 다가오는/지난 마감 — 마감일 있는 미완 프로젝트(7일 이내 or 지남).
    const due = projects
        .map((p) => ({ p, n: dueInDays(p.due_date) }))
        .filter((x) => x.n != null && x.p.status !== 'done' && x.n <= 7)
        .sort((a, b) => a.n - b.n);
    items.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    for (const it of items)
        it.key = it.kind + '|' + (it.pid || it.sid || '') + '|' + (it.ts || '');
    // 헤더 우측 = ⚙ 설정(아이콘) — 한 번만 배치.
    if (goEl) {
        const gear = el('button', { class: 'dash-wh-go dash-wh-gear', type: 'button', title: '알림 설정', 'aria-label': '알림 설정' }, dashGearIcon());
        gear.onclick = () => openNotifPrefs(gear, render);
        goEl.replaceWith(gear);
    }
    // 프리셋으로 걸러 렌더 + 읽음/안읽음(인박스). 설정·모두읽음 변경 시 재렌더(재요청 없이).
    const render = () => {
        const prefs = dashNotifPrefs();
        const read = dashNotifReadSet();
        const feedItems = items.filter((it) => prefs[it.pref]).slice(0, 24);
        const dueShown = prefs.due ? due : [];
        const unread = feedItems.filter((it) => !read.has(it.key));
        // 헤더: 안 읽음 수 뱃지(있으면) + '모두 읽음' 액션.
        zone.countEl.replaceChildren(unread.length
            ? el('span', { class: 'dash-ntf-unreadn', text: String(unread.length) + ' 안 읽음' })
            : (feedItems.length ? el('span', { class: 'dash-ntf-alldone', text: '다 읽음' }) : el('span')));
        if (unread.length) {
            const markBtn = el('button', { class: 'dash-ntf-markall', type: 'button', text: '모두 읽음' });
            markBtn.onclick = () => { const s = dashNotifReadSet(); feedItems.forEach((it) => s.add(it.key)); dashSaveNotifRead(s); render(); };
            zone.chipsEl.replaceChildren(markBtn);
        }
        else
            zone.chipsEl.replaceChildren();
        if (!dueShown.length && !feedItems.length) {
            zone.body.replaceChildren(dashEmpty(items.length || due.length
                ? '표시할 알림이 없어요. ⚙에서 유형을 켜 보세요.'
                : '새 알림이 없어요. 내 프로젝트에 활동·댓글·멘션이 생기면 여기 모여요.'));
            return;
        }
        const frag = [];
        if (dueShown.length) {
            frag.push(el('div', { class: 'dash-ghead', text: '다가오는 마감' }));
            for (const { p, n } of dueShown)
                frag.push(dashDueRow(p, n));
        }
        if (feedItems.length) {
            if (dueShown.length)
                frag.push(el('div', { class: 'dash-ghead', text: '알림' }));
            for (const it of feedItems)
                frag.push(notifRow(it, !read.has(it.key)));
        }
        zone.body.replaceChildren(...frag);
    };
    render();
}
// 알림 한 줄 — [유형 타일] [행위자(굵게)+동사 ·시간] / [프로젝트·스니펫] · 안읽음이면 파란 점. 클릭 시 읽음 처리.
function notifRow(it, unread) {
    const time = it.ts ? relTime(it.ts) : '';
    const head = el('span', { class: 'dash-ntf-head' }, el('b', { class: 'dash-ntf-who', text: it.who + (it.actorPerson ? '님' : '') }), el('span', { text: (it.actorPerson ? '이 ' : ' · ') + it.verb }));
    const metaBits = [it.proj, it.snippet].filter(Boolean).join(' · ');
    const main = el('span', { class: 'dash-ntf-main' }, el('span', { class: 'dash-ntf-line' }, head, el('span', { class: 'dash-ntf-time', text: time })), metaBits ? el('span', { class: 'dash-ntf-sub', title: metaBits, text: metaBits }) : null);
    const href = it.kind === 'invite' ? '#/terminal' : '#/projects2/p/' + it.pid;
    const row = el('a', { class: 'dash-ntf' + (unread ? ' unread' : ''), href }, dashNotifTile(it), main, unread ? el('span', { class: 'dash-ntf-udot', title: '안 읽음', 'aria-label': '안 읽음' }) : null);
    row.addEventListener('click', () => { const s = dashNotifReadSet(); s.add(it.key); dashSaveNotifRead(s); });
    return row;
}
// 마감 알림 — 시계 타일(임박=앰버·지남=코럴) + 프로젝트(굵게) + 마감 라벨 + D-뱃지. (마감은 상시 리마인더라 읽음 대상 아님)
function dashDueRow(p, n) {
    const overdue = n < 0;
    const badge = overdue ? '지남' : (n === 0 ? 'D-day' : 'D-' + n);
    return el('a', { class: 'dash-ntf dash-ntf--due', href: '#/projects2/p/' + p.id }, el('span', { class: 'dash-ntf-tile ' + (overdue ? 't-coral' : 't-amber') }, dashClockIcon()), el('span', { class: 'dash-ntf-main' }, el('span', { class: 'dash-ntf-line' }, el('b', { class: 'dash-ntf-who', title: p.name, text: p.name }), el('span', { class: 'dash-ntf-dbadge' + (overdue ? ' overdue' : ''), text: badge })), el('span', { class: 'dash-ntf-sub', text: '마감 ' + dueLabel(n) })));
}
// 유형 타일 — 라운드 스퀘어(앱 아이콘 톤) + 유형색 글리프. 피드의 둥근 점과 명확히 구분되는 '알림' 시그니처.
function dashNotifTile(it) {
    const kind = it.kind;
    let cls, glyph;
    if (kind === 'mention') {
        cls = 't-blue';
        glyph = el('span', { class: 'dash-ntf-glyph', text: '@' });
    }
    else if (kind === 'comment') {
        cls = 't-teal';
        glyph = dashCommentIcon();
    }
    else if (kind === 'invite') {
        cls = 't-indigo';
        glyph = dashSessionIcon();
    }
    else if (kind === 'created') {
        cls = 't-mint';
        glyph = el('span', { class: 'dash-ntf-glyph', text: '＋' });
    }
    else if (kind === 'act') {
        cls = 'tn-' + (it.tone || 'mut');
        glyph = dashSparkIcon();
    }
    else if (it.pref === 'assign') {
        cls = 't-violet';
        glyph = dashPersonIcon();
    } // 담당자 변경
    else {
        cls = 't-slate';
        glyph = el('span', { class: 'dash-ntf-glyph', text: '✎' });
    } // 상태·이름·필드 변경
    return el('span', { class: 'dash-ntf-tile ' + cls }, glyph);
}
function dashGearIcon() {
    const n = sv('svg', { class: 'dash-gear', viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 12, r: 3 }), sv('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }));
    return n;
}
function dashClockIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 12, r: 9 }), sv('path', { d: 'M12 7v5l3 2' }));
    return n;
}
function dashCommentIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 9, height: 9, fill: 'currentColor', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z' }));
    return n;
}
function dashSessionIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 9, height: 9, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M5 7l4 5-4 5' }), sv('path', { d: 'M13 17h6' }));
    return n;
}
// 활동(커밋·기능 등) — 번개 글리프.
function dashSparkIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'currentColor', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M13 2 4.5 13.5H11l-1 8.5L19.5 10H13z' }));
    return n;
}
// 담당자 변경 — 사람 글리프.
function dashPersonIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 8, r: 3.4 }), sv('path', { d: 'M5.5 20a6.5 6.5 0 0 1 13 0' }));
    return n;
}
// ── 알림 사용자화 팝업 — 유형 체크박스(그룹별), 기기별 저장, 변경 즉시 재렌더 ──
function openNotifPrefs(anchor, onChange) {
    const prefs = dashNotifPrefs();
    const panel = el('div', { class: 'dash-pop-panel' });
    panel.append(el('div', { class: 'dash-pop-head' }, el('strong', { text: '표시할 알림' }), el('span', { class: 'dash-pop-sub', text: '이 기기에 저장돼요' })));
    for (const g of DASH_NOTIF_GROUPS) {
        panel.append(el('div', { class: 'dash-pop-gh', text: g.title }));
        for (const it of g.items) {
            const cb = el('input', { type: 'checkbox' });
            cb.checked = !!prefs[it.key];
            cb.onchange = () => { prefs[it.key] = cb.checked; dashSaveNotifPrefs(prefs); onChange(); };
            panel.append(el('label', { class: 'dash-pop-row' }, cb, el('span', { class: 'dash-pop-txt' }, el('span', { class: 'dash-pop-name', text: it.label }), el('span', { class: 'dash-pop-desc', text: it.desc }))));
        }
    }
    dashPopover(anchor, panel);
}
// 경량 팝오버 — anchor 아래 고정 배치, 바깥클릭·Esc 로 닫힘.
function dashPopover(anchor, panel) {
    document.querySelectorAll('.dash-pop').forEach((n) => n.remove());
    panel.classList.add('dash-pop');
    document.body.append(panel);
    const r = anchor.getBoundingClientRect();
    const pw = panel.offsetWidth || 260;
    panel.style.left = Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8)) + 'px';
    panel.style.top = (r.bottom + 6) + 'px';
    const close = () => { panel.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
    const onDoc = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target))
        close(); };
    const onKey = (e) => { if (e.key === 'Escape')
        close(); };
    setTimeout(() => { document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); }, 0);
    return close;
}
// 필드 변경 이벤트 → 한국어 한 줄.
function eventLabel(f) {
    const lbl = DASH_FIELD_LABEL[f.field] || f.label || f.field || '항목';
    if (f.field === 'status' && f.to)
        return `상태를 '${f.to}'(으)로 변경`;
    if (f.field === 'name')
        return '이름을 바꿨어요';
    if (f.field === 'description')
        return '내용을 수정했어요';
    if (f.field === 'assignee')
        return '담당자를 바꿨어요';
    if (f.to)
        return `${lbl} 변경 → ${f.to}`;
    return `${lbl} 변경`;
}
// 마감까지 일수(자정 기준, 음수=지남). 없으면 null.
function dueInDays(dateStr) {
    if (!dateStr)
        return null;
    const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
    if (isNaN(+d))
        return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((+d - +today) / 86400000);
}
function dueLabel(n) { return n < 0 ? Math.abs(n) + '일 지남' : (n === 0 ? '오늘' : n + '일 뒤'); }
export { renderMyDashboard, };
