// dashboard-home.ts — '대시보드' 상위 탭(#/dashboard). 옛 '시작하기' 자리를 개편한 나만의 코크핏(#617).
//  1단계(현재): A안 '나→팀 3열' 고정 프리셋 — 좌(내 프로젝트) · 중(내 AI 세션 + 팀 공유 폴더) · 우(팀 작업 로그).
//   풀스크린·페이지 스크롤 없음(body[data-route="dashboard"] 훅) — 넘치는 목록은 위젯 '안에서만' 스크롤.
//   위젯별 독립 로드·독립 실패: 한 위젯의 API 오류가 대시보드 전체를 죽이지 않는다.
//  2단계(예정): 위젯 레지스트리 + 12×12 {x,y,w,h} 편집 모드(추가/제거·드래그·리사이즈·사람별 저장) — 이 프리셋이 기본 배치가 된다.
//  §0.5 채색 예산: 채운 파란 버튼은 화면당 1개([+ 새 세션])뿐. 나머지는 무채 카드 + 작은 상태점·아웃라인 배지.
import { api, el, errorNote, relTime, state, sv } from './core.js';
import { skeleton } from './learn.js';
// 하네스 라벨 폴백(terminal config 의 harnesses 와 동일 키) — cfg 로드 실패 시에도 읽히게.
const DASH_HARNESS_LABEL = { claude: 'Claude Code', codex: 'Codex' };
// 작업 유형 → 점 톤/라벨 — 작업 현황(dashboard.ts ACT_TYPE_TONE)과 동일 매핑(성격축 8종).
const DASH_ACT_TONE = { feature: 'mint', fix: 'coral', decision: 'blue', docs: 'teal', research: 'violet', review: 'amber', chore: 'mut', other: 'mut' };
const DASH_ACT_LABEL = { feature: '기능', fix: '수정', decision: '결정', docs: '문서', research: '리서치', review: '검토', chore: '운영', other: '기타' };
async function renderMyDashboard(view) {
    // ── 셸 즉시 그리기(각 존은 스켈레톤) → 위젯별 병렬 로드 ──
    const sepEl = el('span', { text: ' · ' }); // 날짜와 요약 사이 구분점(요약 없으면 숨김)
    const summaryEl = el('span', { text: '불러오는 중…' }); // 인사줄 요약(프로젝트·세션 수) — 로드 후 갱신
    const obSlot = el('span'); // 온보딩 칩 자리(완료면 빈 채로)
    const zoneProj = dashZone('proj', '내 프로젝트', '#/projects2', '프로젝트 →');
    const zoneSess = dashZone('sess', '내 AI 세션', '#/terminal', '터미널 →');
    const zoneFold = dashZone('fold', '팀 공유 폴더', '#/terminal', '터미널 →');
    const zoneLog = dashZone('log', '팀 작업 로그', '#/projects2/worklog', '작업 로그 →');
    const strip = el('div', { class: 'dash-strip' }, el('div', {}, el('div', { class: 'dash-hi', text: greeting() + ', ' + myDisplayName() + '님' }), el('div', { class: 'dash-date' }, todayLabel(), sepEl, summaryEl)), el('div', { class: 'dash-acts' }, obSlot, el('a', { class: 'btn btn-ghost btn-sm', href: '#/projects2', text: '+ 새 프로젝트' }), el('a', { class: 'btn btn-primary btn-sm', href: '#/terminal', text: '+ 새 세션' })));
    view.replaceChildren(el('div', { class: 'dash' }, strip, el('div', { class: 'dash-zones' }, zoneProj.box, el('div', { class: 'dash-colmid' }, zoneSess.box, zoneFold.box), zoneLog.box)));
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
    fillProjects(zoneProj, (n) => { counts.projects = n; drawSummary(); });
    fillSessions(zoneSess, (n) => { counts.sessions = n; drawSummary(); });
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
async function fillProjects(zone, onCount) {
    let projects, lists;
    try {
        [projects, lists] = await Promise.all([
            api('/api/ui/v6/projects?mine=1').then((d) => (d && d.projects) || []),
            api('/api/ui/v6/project-lists').then((d) => (d && d.lists) || []).catch(() => []),
        ]);
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
    // 리스트 블럭 카드 — pjv-overview 의 ovCard 와 동일 마크업(글리프·이름 · 개수 · 상태바). 클릭→그 리스트 열기.
    const projBlock = (listId, l, arr) => {
        const b = brk(arr);
        const name = (l && l.name) || '미분류';
        const card = el('div', { class: 'pjv-ov-card', role: 'button', tabindex: '0', title: name }, el('div', { class: 'pjv-ov-card-head' }, dashListGlyph(l), el('span', { class: 'pjv-ov-card-name', text: name })), el('div', { class: 'pjv-ov-card-count', text: b.total + '개 프로젝트' }));
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
        const go = () => { location.hash = listId ? '#/projects2/l/' + listId : '#/projects2/none'; };
        card.addEventListener('click', go);
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            go();
        } });
        return card;
    };
    let mode = 'active'; // 진행 중 | 전체 — 블럭 통계에 완료 프로젝트 포함 여부.
    const draw = () => {
        const shown = mode === 'active' ? projects.filter((p) => !isDone(p)) : projects;
        zone.countEl.textContent = String(shown.length);
        dashChips(zone.chipsEl, [['active', '진행 중'], ['all', '전체']], mode, (k) => { mode = k; draw(); });
        if (!shown.length) {
            zone.body.replaceChildren(dashEmpty(mode === 'active' ? '진행 중인 내 프로젝트가 없어요.' : '내가 참여한 프로젝트가 없어요.'));
            return;
        }
        // 리스트별 묶음(응답 순서 존중), 미분류(list_id 없음)는 맨 뒤.
        const byList = new Map();
        for (const p of shown) {
            const k = p.list_id || 0;
            if (!byList.has(k))
                byList.set(k, []);
            byList.get(k).push(p);
        }
        const order = [...lists.map((l) => l.id).filter((id) => byList.has(id)), ...(byList.has(0) ? [0] : [])];
        const grid = el('div', { class: 'pjv-ov-grid dash-ov-grid' });
        for (const listId of order)
            grid.append(projBlock(listId, listById.get(listId), byList.get(listId)));
        zone.body.replaceChildren(grid);
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
// ── ② 내 AI 세션 — 내 것 + 초대받은 것 통합, 접속중 우선. [열기] = 터미널 새 창(터미널 탭과 동일 동선). ──
async function fillSessions(zone, onCount) {
    let sessions, cfg;
    try {
        [sessions, cfg] = await Promise.all([
            api('/api/ui/terminal/sessions').then((d) => (d && d.sessions) || []),
            api('/api/ui/terminal/config').catch(() => null), // 라벨 보강용 — 실패해도 폴백으로 진행
        ]);
    }
    catch (e) {
        onCount(null);
        zone.body.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다'));
        return;
    }
    onCount(sessions.filter((s) => s.attached).length);
    const memberName = (id) => {
        const m = ((cfg && cfg.members) || []).find((x) => x.id === id);
        return (m && m.name) || id || '';
    };
    const harnessLabel = (key) => {
        const h = ((cfg && cfg.harnesses) || []).find((x) => x.key === key);
        return (h && h.label) || DASH_HARNESS_LABEL[key] || key || '';
    };
    let mode = 'all'; // 전체 | 내 것 | 초대받음
    const draw = () => {
        const shown = sessions
            .filter((s) => mode === 'mine' ? s.owned : (mode === 'invited' ? !s.owned : true))
            .sort((a, b) => (b.attached ? 1 : 0) - (a.attached ? 1 : 0) || String(b.created || '').localeCompare(String(a.created || '')));
        zone.countEl.textContent = String(shown.length);
        dashChips(zone.chipsEl, [['all', '전체'], ['mine', '내 것'], ['invited', '초대받음']], mode, (k) => { mode = k; draw(); });
        if (!shown.length) {
            zone.body.replaceChildren(dashEmpty(mode === 'invited' ? '초대받은 세션이 없어요.' : '세션이 없어요 — [+ 새 세션]으로 시작해 보세요.'));
            return;
        }
        zone.body.replaceChildren(...shown.map((s) => {
            const sub = [harnessLabel(s.harness), s.dir, s.created ? relTime(s.created) : '']
                .filter(Boolean).join(' · ');
            const shareBadge = s.owned
                ? ((s.invites || []).length ? el('span', { class: 'dash-badge', text: '초대 ' + s.invites.length }) : null)
                : el('span', { class: 'dash-badge', title: '소유: ' + memberName(s.owner), text: memberName(s.owner) + ' · 초대받음' });
            return el('div', { class: 'dash-row dash-row--sess' }, el('span', { class: 'dash-nm' }, el('span', { class: 'dash-nm-line', title: s.label, text: s.label || '(이름 없음)' }), el('span', { class: 'dash-sub', title: sub, text: sub })), s.attached ? el('span', { class: 'dash-badge live', text: '접속중' }) : null, shareBadge, el('button', { class: 'dash-open', type: 'button', text: '열기',
                onclick: () => window.open('/ui/terminal.html?session=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || ''), '_blank') }));
        }));
    };
    draw();
}
// ── ③ 팀 공유 폴더 — 공유 워크스페이스 루트의 폴더. 목록형→아이콘형(#621). ──
//  프로젝트 상세 '공유 폴더'와 동일한 아이콘 카드(proj-file-*): 맥 스타일 폴더 아이콘 + 이름 + '폴더'.
async function fillFolders(zone) {
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
    if (!dirs.length) {
        zone.body.replaceChildren(dashEmpty('공유 워크스페이스에 폴더가 없어요.'));
        return;
    }
    const grid = el('div', { class: 'proj-file-grid dash-fold-grid' });
    for (const name of dirs)
        grid.append(el('div', { class: 'proj-file-card', title: name }, el('div', { class: 'proj-file-card-ic' }, dashFolderThumb()), el('div', { class: 'proj-file-card-nm', text: name }), el('div', { class: 'proj-file-card-sz', text: '폴더' })));
    zone.body.replaceChildren(grid);
}
// 맥 스타일 폴더 아이콘 — 프로젝트 상세 공유 폴더의 folderThumb 과 동일(ft ft-folder; 색은 styles.css).
function dashFolderThumb() {
    const n = sv('svg', { class: 'ft ft-folder', viewBox: '0 0 48 40', fill: 'none', 'aria-hidden': 'true' });
    n.append(sv('path', { class: 'ft-folder-tab', d: 'M4 9a3 3 0 0 1 3-3h10.5l4 4H4z' }));
    n.append(sv('path', { class: 'ft-folder-body', d: 'M4 12a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z' }));
    return n;
}
// ── ④ 팀 작업 로그 — 회사 전체 활동 피드(유형점 + 요약 + 사람·AI·상대시간). 팀원 칩 필터. ──
async function fillActivity(zone) {
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
            return el('a', { class: 'dash-row dash-row--log', href: '#/projects2/worklog' }, el('span', { class: 'dash-dot tn-' + (DASH_ACT_TONE[a.type] || 'mut'), title: DASH_ACT_LABEL[a.type] || a.type || '' }), el('span', { class: 'dash-nm' }, el('span', { class: 'dash-nm-line', title: a.summary || a.title || '', text: a.summary || a.title || '(제목 없음)' }), el('span', { class: 'dash-sub', text: sub })));
        }));
    };
    draw();
}
export { renderMyDashboard, };
