// projects/filters-state.ts — #1405 W2: filters.ts 분할 ①.
//  필터의 **상태와 판정** — 필드/연산자 카탈로그, 현재 조건, 값 추출·매칭, 툴바 통과 여부.
//  순수 잎(팝오버 UI 가 이쪽을 본다).
import { pjvFieldIcon, pjvIcon, pjvTbIcon } from './icons.js';
import { pjvBoardMineOnly, pjvProjClosedView } from './state.js';
import { PJV_DEFAULT_STATUS_DEFS, pjvResolveProjStatus, pjvStatusReg } from './status.js';
import { pjvAssignees } from './task-controls.js';
// ══ 툴바 필터 엔진 ══════════════════════════════════════════════════════════
//  ClickUp Filters 파리티. 조건행(field·op·values) + 담당자 빠른필터 + 뷰 내 검색을 한 술어로 합쳐
//  모든 렌더 경로(상태·평면·폴더·리스트·칸반)가 통과하는 pjvApplyToolbarFilters 하나로 적용한다.
//  스코프별 저장 없이 세션 유지(내 할당만·Closed 와 동일 결) — 화면을 떠나면 초기화된다.
const PJV_FILTER_FIELDS = [
    { key: 'status', label: '상태' },
    { key: 'assignee', label: '담당자' },
    { key: 'priority', label: '우선순위' },
    { key: 'tag', label: '태그' },
    { key: 'due', label: '마감일' },
    { key: 'name', label: '이름' },
];
// 연산자 — 값형(다중선택)과 날짜/텍스트형이 다르다. '있음/없음'은 값 없이 성립.
const PJV_FILTER_OPS = {
    multi: [{ key: 'is', label: '이다' }, { key: 'not', label: '아니다' }, { key: 'set', label: '있음' }, { key: 'unset', label: '없음' }],
    date: [{ key: 'on', label: '해당일' }, { key: 'before', label: '이전' }, { key: 'after', label: '이후' }, { key: 'set', label: '있음' }, { key: 'unset', label: '없음' }],
    text: [{ key: 'contains', label: '포함' }, { key: 'ncontains', label: '미포함' }],
};
function pjvFilterKind(field) { return field === 'due' ? 'date' : field === 'name' ? 'text' : 'multi'; }
const pjvFilterState = { rows: [], match: 'and' }; // rows: {field, op, values[]}
const pjvAsgFilter = { ids: new Set(), none: false }; // 담당자 빠른필터(우측 사람 아이콘)
// Me mode(#1067, ClickUp 아바타 버튼) — '내가 맡은 것만'. 프로젝트/태스크 각각 따로 끌 수 있다.
//  projects: 내가 만든·참여한 프로젝트만(기존 pjvBoardMineOnly 를 이 스위치가 대신 조종한다)
//  tasks: 프로젝트를 펼쳤을 때 나오는 태스크 중 내가 담당인 것만
const pjvMeMode = { tasks: false };
function pjvMeModeOn() { return pjvBoardMineOnly.on || pjvMeMode.tasks; }
// 이 태스크가 나에게 할당됐나 — 다중 담당자(pjvAssignees) 기준. meId 는 state.me 에서.
function pjvTaskIsMine(t, meId) {
    if (!meId)
        return true;
    return pjvAssignees(t).some((x) => String(x) === String(meId));
}
const pjvBoardSearch = { q: '' }; // 뷰 내 검색(돋보기)
// 필터 값 후보 — 보드 렌더마다 현재 데이터에서 수집(상태·담당자·태그). 카운트는 ClickUp 처럼 옆에 숫자로.
let pjvFilterUniverse = { statuses: [], members: [], tags: [], counts: { member: new Map(), none: 0 } };
function pjvSetFilterUniverse(projects, _lists) {
    const statuses = new Map();
    for (const defs of pjvStatusReg.values())
        for (const d of defs)
            if (!statuses.has(d.key))
                statuses.set(d.key, d);
    for (const d of PJV_DEFAULT_STATUS_DEFS)
        if (!statuses.has(d.key))
            statuses.set(d.key, d);
    // 네이티브 3버킷도 후보에 — 커스텀 상태를 안 쓰는 리스트의 프로젝트는 status(todo|in_progress|done)로만 산다.
    if (!statuses.has('in_progress'))
        statuses.set('in_progress', { key: 'in_progress', label: '진행 중', color: '#f59e0b', category: 'active' });
    const members = new Map();
    const tags = new Map();
    const counts = { member: new Map(), none: 0 };
    // 개수는 '지금 보이는 것' 기준 — 완료(done)는 Closed 를 켰을 때만 센다(사이드바 카운트·본문과 동형).
    //  안 그러면 리스트에 59개가 보이는데 담당자 옆엔 211 이 떠 숫자가 화면과 안 맞는다.
    for (const p of (projects || []).filter((x) => pjvProjClosedView.done || x.status !== 'done')) {
        const ms = p.members || [];
        if (!ms.length)
            counts.none++;
        for (const m of ms) {
            const id = String(m.member_id);
            if (!members.has(id))
                members.set(id, { id, name: m.display_name || m.member_id });
            counts.member.set(id, (counts.member.get(id) || 0) + 1);
        }
        for (const t of (p.tags || []))
            if (!tags.has(String(t.id)))
                tags.set(String(t.id), { id: String(t.id), name: t.name, color: t.color });
    }
    pjvFilterUniverse = { statuses: [...statuses.values()], members: [...members.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))), tags: [...tags.values()], counts };
}
// 이 프로젝트가 가질 수 있는 상태 키들 — 커스텀 상태 키 + status_raw + 네이티브 status(어느 걸로 걸어도 걸리게).
function pjvProjStatusKeys(p) {
    const out = new Set();
    const d = pjvResolveProjStatus(p);
    if (d)
        out.add(String(d.key));
    if (p.status_raw)
        out.add(String(p.status_raw));
    if (p.status)
        out.add(String(p.status));
    if (p.status === 'in_progress')
        out.add('active'); // 기본 스킴의 '진행 중' 키는 active
    return out;
}
function pjvFilterRowValues(p, field) {
    if (field === 'status')
        return [...pjvProjStatusKeys(p)];
    if (field === 'assignee')
        return (p.members || []).map((m) => String(m.member_id));
    if (field === 'priority')
        return p.priority ? [String(p.priority)] : [];
    if (field === 'tag')
        return (p.tags || []).map((t) => String(t.id));
    if (field === 'due')
        return p.due_date ? [String(p.due_date)] : [];
    return [];
}
function pjvFilterRowMatch(p, r) {
    if (!r || !r.field)
        return true;
    if (r.field === 'name') {
        const s = String(p.name || '').toLowerCase();
        const t = String((r.values || [])[0] || '').trim().toLowerCase();
        if (!t)
            return true;
        return r.op === 'ncontains' ? !s.includes(t) : s.includes(t);
    }
    const cur = pjvFilterRowValues(p, r.field);
    if (r.op === 'set')
        return cur.length > 0;
    if (r.op === 'unset')
        return cur.length === 0;
    const vals = (r.values || []).filter((v) => v !== '' && v != null);
    if (!vals.length)
        return true; // 값 미선택 = 아직 안 건 조건(ClickUp 동형 — 결과를 비우지 않는다)
    if (r.field === 'due') {
        const d = p.due_date ? String(p.due_date).slice(0, 10) : null;
        const t = String(vals[0]).slice(0, 10);
        if (!d)
            return false;
        if (r.op === 'before')
            return d < t;
        if (r.op === 'after')
            return d > t;
        return d === t;
    }
    const hit = vals.some((v) => cur.includes(String(v)));
    return r.op === 'not' ? !hit : hit;
}
// 툴바가 거는 모든 좁히기의 단일 술어 — 검색어 → 담당자 빠른필터 → 조건행(AND/OR).
function pjvProjPassesToolbar(p) {
    const q = pjvBoardSearch.q.trim().toLowerCase();
    if (q && !String(p.name || '').toLowerCase().includes(q))
        return false;
    if (pjvAsgFilter.none || pjvAsgFilter.ids.size) {
        const ms = (p.members || []).map((m) => String(m.member_id));
        const hit = (pjvAsgFilter.none && !ms.length) || ms.some((x) => pjvAsgFilter.ids.has(x));
        if (!hit)
            return false;
    }
    const rows = (pjvFilterState.rows || []).filter((r) => r && r.field);
    if (rows.length) {
        const res = rows.map((r) => pjvFilterRowMatch(p, r));
        if (!(pjvFilterState.match === 'or' ? res.some(Boolean) : res.every(Boolean)))
            return false;
    }
    return true;
}
function pjvApplyToolbarFilters(arr) {
    if (!pjvToolbarNarrowed())
        return arr;
    return (arr || []).filter(pjvProjPassesToolbar);
}
function pjvToolbarNarrowed() {
    return !!(pjvBoardSearch.q.trim() || pjvAsgFilter.none || pjvAsgFilter.ids.size || (pjvFilterState.rows || []).some((r) => r && r.field));
}
function pjvFilterCount() { return (pjvFilterState.rows || []).filter((r) => r && r.field).length; }
// 필터 필드 아이콘 — 무엇으로 거는지 형태로 먼저 읽히게(ClickUp 도 필드마다 아이콘).
function pjvFilterFieldIcon(key) {
    if (key === 'assignee')
        return pjvTbIcon('people', 'sm');
    if (key === 'priority')
        return pjvIcon('priority'); // 깃발 — 태그(라벨)와 겹치지 않게
    if (key === 'due')
        return pjvFieldIcon('date', 'sm');
    if (key === 'tag')
        return pjvFieldIcon('labels', 'sm');
    if (key === 'name')
        return pjvFieldIcon('text', 'sm');
    return pjvTbIcon('check', 'sm'); // 상태
}
export { PJV_FILTER_FIELDS, PJV_FILTER_OPS, pjvApplyToolbarFilters, pjvAsgFilter, pjvBoardSearch, pjvFilterCount, pjvFilterFieldIcon, pjvFilterKind, pjvFilterState, pjvFilterUniverse, pjvMeMode, pjvMeModeOn, pjvSetFilterUniverse, pjvTaskIsMine };
