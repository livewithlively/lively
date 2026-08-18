// v2/side.ts — 새 셸 좌측 사이드바(#1719): 워크스페이스 **전체** 프로젝트 ▸ 살아 있는 세션 트리.
//  규칙(상민님 2026-08-18, 같은 날 재구성 지시로 갱신):
//   · 프로젝트는 워크스페이스 전체가 보인다(내 것만이 아니다). '내 프로젝트만'은 필터 안의 토글.
//   · 프로젝트 아래엔 **끝나지 않은 세션만**(살아 있는 박스). 끝난 것은 프로젝트 화면·세션 이력에서.
//   · 완료 프로젝트는 기본 숨김(살아 있는 세션이 있으면 예외로 보인다). 정렬 = 마지막 작업 시각 내림차순.
//   · **기본 화면은 목록 하나다** — 상태 칩·완료 숨김·내 프로젝트만 같은 필터는 전부 [필터] 버튼 속 팝오버로
//     들어간다(밖에 늘어놓으면 목록보다 조작부가 먼저 읽힌다 — 번잡함의 주범이었다).
//   · **위계가 시각으로 갈린다**: 프로젝트 행 = 폴더 아이콘 + 굵은 글씨 → 누르면 프로젝트 화면.
//     세션 행 = 들여쓴 레일 + 상태점 + 보통 글씨 → 누르면 그 세션의 대화. 서로 다른 곳으로 간다는 게 생김새에서 보인다.
//   · 흐린 회색 본문 금지 — 완료·조용한 프로젝트도 이름은 같은 잉크색이고, 상태는 작은 태그·시각으로만 구분한다
//     (연회색 글씨가 목록의 절반을 차지하면 전체가 바래 보인다).
//  main.ts 가 데이터·활성 키를 넘기고, 필터·펼침 같은 사이드바 자체 상태는 여기 산다(브라우저에 기억).
import { el, loadPeopleAvatars, logout, navOn, personFace, profileAvatar, relTime, setUiModeOverride, state, sv } from '../core.js';
import { SESS_STATES } from '../session-status.js';
import { appIcon, openLaunchpad, visibleApps } from './apps.js';
import { dotCls } from './views.js';
import { switcherTop } from './switcher.js';
// 기본은 **전부 접힘**(상민님 2026-08-18: 선택된 프로젝트 외에는 다 접어둔다) — 사용자가 편 것만 기억한다.
//  지금 보는 프로젝트(선택)는 늘 펼침이 기본이고, 그걸 접은 건 잠깐의 상태라 기억하지 않는다(다음 방문엔 다시 펼쳐 보인다).
const OPEN_KEY = 'lively_v2_opened';
const DONE_KEY = 'lively_v2_side_done'; // '1' = 완료 프로젝트도 보인다(필터 풀림)
const MINE_KEY = 'lively_v2_side_mine'; // '1' = 내 프로젝트만
const MAX_SESS = 12; // 한 프로젝트 아래 펼쳐 보이는 세션 상한(넘치면 '외 n개' → 프로젝트 화면)
let openSet = new Set();
const closedSelected = new Set(); // 선택 프로젝트를 일부러 접은 것 — 세션(페이지) 수명만
let showDone = false;
let mineOnly = false;
let sideFilter = '';
let findOpen = false; // 돋보기로 펼친 검색칸. **검색어가 있으면 늘 펼친 상태**로 친다(왜 목록이 짧은지 화면이 말해야 한다)
let keyBound = false;
let stateFilter = null; // 상태 칩 — 세션 상태 key(waiting·busy…) 하나. 새로고침하면 풀린다(잠깐 보는 렌즈)
let people = {}; // id → 멤버(표시명·아바타). 남의 세션 소유자 이름용
let inited = false;
let last = null;
function loadSet(k) { try {
    const a = JSON.parse(localStorage.getItem(k) || '[]');
    return new Set(Array.isArray(a) ? a : []);
}
catch (_) {
    return new Set();
} }
function saveSet(k, s) { try {
    if (s.size)
        localStorage.setItem(k, JSON.stringify([...s]));
    else
        localStorage.removeItem(k);
}
catch (_) { /* noop */ } }
function saveFlag(k, v) { try {
    if (v)
        localStorage.setItem(k, '1');
    else
        localStorage.removeItem(k);
}
catch (_) { /* noop */ } }
function init() {
    if (inited)
        return;
    inited = true;
    openSet = loadSet(OPEN_KEY);
    try {
        showDone = localStorage.getItem(DONE_KEY) === '1';
        mineOnly = localStorage.getItem(MINE_KEY) === '1';
    }
    catch (_) { /* noop */ }
    void loadPeopleAvatars().then((m) => { people = m || {}; if (last)
        redraw(); });
}
/** 살아 있는 세션 = 사이드바에 보이는 세션. 라이브 박스이고 끝나지 않은 것(중단됨·종료됨 제외). 기록만 남은 대화는 아니다. */
const isLive = (s) => s.live && s.alive;
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
// 하네스가 pane 제목에 자기 이름만 써 둔 것 — '지금 하는 일'이 아니다(정보 0).
const HARNESS_TITLES = new Set(['claude code', 'claude', 'codex', 'opencode', 'antigravity', 'grok', 'shell', 'bash', 'zsh', 'tmux', 'node']);
// 기계가 붙인 세션 이름 — 사람이 읽을 게 없다('이어보기 · 3e1ca8f2', '위탁 #t501ac…').
const isMachineLabel = (s) => /^이어보기\s*[·:]/.test(s) || /^위탁\s*#/.test(s);
/** 이 이름이 프로젝트명의 되풀이인가. 세 모양을 다 잡는다(실측):
 *   ① 그대로              "APP. lvly. io 셀프서브 방식 와이어프레임"
 *   ② 만들 때 잘린 것      "라이블리 키트, cli, 노드 등록을 지금 다 cli에서 해야하는데, 이거 윈도…"(프로젝트명의 앞부분)
 *   ③ 조각만 이어붙인 변형  "app.lvly.io 와이어프레임" ⊂ "APP. lvly. io 셀프서브 방식 와이어프레임"
 *  ③은 글자·숫자만 남긴 뒤 공통 앞머리 + 공통 꼬리가 이름 전체를 덮으면 되풀이로 본다(우연 일치를 막으려 6자 미만은 제외). */
function echoesProject(label, proj) {
    const a = norm(label);
    const b = norm(proj);
    if (!a || !b)
        return false;
    if (a === b || b.startsWith(a) || a.startsWith(b))
        return true;
    const ca = a.replace(/[^\p{L}\p{N}]/gu, '');
    const cb = b.replace(/[^\p{L}\p{N}]/gu, '');
    if (ca.length < 6 || !cb)
        return false;
    let head = 0;
    while (head < ca.length && head < cb.length && ca[head] === cb[head])
        head++;
    let tail = 0;
    while (tail < ca.length - head && tail < cb.length - head && ca[ca.length - 1 - tail] === cb[cb.length - 1 - tail])
        tail++;
    return head + tail >= ca.length;
}
/** 세션 행에 쓸 글 — ★프로젝트명 반복을 걷어낸다.
 *  프로젝트에서 연 세션은 이름이 **프로젝트명 그대로**인 게 대다수(dev 실측 2026-08-18: 25건 중 14건) — 그 이름은 바로 위
 *  프로젝트 행이 이미 말하고 있다. 같은 제목이 한 화면에 대여섯 번 반복돼 목록이 통째로 안 읽히던 원인이라 지운다.
 *  대신 하네스가 pane 제목에 써 두는 '지금 하는 일'이 그 자리를 받는다 — 실제로 세션을 구분해 주던 건 그 줄이었다.
 *  이름이 따로 있는 세션(사람이 지은 것)만 두 줄이 된다. 원래 이름은 툴팁에 남는다(정보를 버리지는 않는다). */
function sessText(s, projName) {
    const label = String(s.label || '').trim();
    const work = String((s.raw && s.raw.title) || '').trim();
    let name = label;
    // '프로젝트명 + 꼬리'(예: "… 와이어프레임 - 3열")면 꼬리만 남기고, 그 밖의 되풀이는 통째로 지운다.
    if (projName && label.startsWith(projName))
        name = label.slice(projName.length).replace(/^[\s·:\-–—_/|]+/, '').trim();
    if (projName && name && echoesProject(name, projName))
        name = '';
    if (isMachineLabel(name))
        name = '';
    const job = work && !HARNESS_TITLES.has(norm(work)) && norm(work) !== norm(name) ? work : '';
    if (name && job)
        return { main: name, sub: job };
    if (name || job)
        return { main: name || job, sub: '' };
    return { main: label || String((s.raw && s.raw.harness) || '') || '이름 없는 세션', sub: '' };
}
const rankOf = (k) => (SESS_STATES[k] ? SESS_STATES[k].rank : 9);
const bySeen = (a, b) => rankOf(a.stateKey) - rankOf(b.stateKey) || b.lastSeen - a.lastSeen;
const when = (ms) => (ms ? relTime(new Date(ms).toISOString()) : '');
function ownerName(s) {
    if (s.owned)
        return '나';
    const id = String((s.raw && s.raw.owner) || '');
    const m = people[id];
    return (m && m.display_name) || id || '?';
}
function buildRows(data) {
    const me = String((state.me && state.me.userId) || '');
    const byProj = new Map();
    const noProj = [];
    for (const s of data.sessions) {
        if (s.projectId) {
            const arr = byProj.get(s.projectId) || [];
            arr.push(s);
            byProj.set(s.projectId, arr);
        }
        else
            noProj.push(s);
    }
    const lastOf = (arr) => arr.reduce((m, s) => Math.max(m, s.lastSeen || 0), 0);
    const rows = data.projects.map((p) => {
        const all = byProj.get(p.id) || [];
        return { key: 'p:' + p.id, proj: p, live: all.filter(isLive).sort(bySeen), lastWork: lastOf(all), done: p.status_category === 'done',
            mine: !!me && (p.created_by === me || (p.member_ids || []).includes(me)) };
    });
    // 프로젝트 없는 세션 — 가짜 프로젝트 한 줄로 같은 정렬에 섞는다(맨 아래 고정이면 프로젝트 수백 개 밑에 묻힌다).
    const loose = noProj.filter(isLive).sort(bySeen);
    if (loose.length)
        rows.push({ key: 'p:0', proj: null, live: loose, lastWork: lastOf(noProj), done: false, mine: true });
    return rows;
}
// ── 사이드바 정렬을 밖에서도(#1749 상단바 프로젝트 연결 드롭다운) — 트리와 **같은 순서**(마지막 작업 시각 ↓ → updated_at ↓).
//  완료 프로젝트는 뒤로 보낸다(트리는 기본 숨김이라 "보이는 순서"가 곧 미완료 순서 — 드롭다운은 숨기는 대신 가라앉힌다).
export function projectOrder(data) {
    const byWork = (a, b) => b.lastWork - a.lastWork || String((b.proj && b.proj.updated_at) || '').localeCompare(String((a.proj && a.proj.updated_at) || ''));
    return buildRows(data).filter((r) => r.proj)
        .sort((a, b) => Number(a.done) - Number(b.done) || byWork(a, b))
        .map((r) => ({ proj: r.proj, done: r.done, mine: r.mine, lastWork: r.lastWork }));
}
// ── 그리기 ──
export function drawSide(host, data, activeKey, openSessions) {
    init();
    last = { host, data, activeKey, openSessions: openSessions || (() => []) };
    render();
}
function redraw() { if (last)
    render(); }
let treeEl = null;
let countEl = null;
let filterOpen = false; // [필터] 팝오버 — 열림은 잠깐의 상태라 브라우저에 기억하지 않는다
let outsideBound = false;
// 위계 아이콘 — 프로젝트는 폴더(펼치면 열린 폴더), 세션은 말풍선. 같은 24 뷰박스·현재색 스트로크(붓은 하나).
function glyph(kind, cls) {
    const D = {
        folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
        // 뚜껑이 젖혀진 열린 폴더 — 카드가 열려 있다는 것을 아이콘도 함께 말한다(안 1 '방').
        'folder-open': ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1', 'M3 17l2.3-6.6A2 2 0 0 1 7.2 9H21l-2.4 7.6a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-1z'],
        chat: ['M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z'],
    };
    return sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, ...D[kind].map((d) => sv('path', { d })));
}
function render() {
    if (!last)
        return;
    const { host, data } = last;
    const me = state.me || {};
    const name = String(me.display_name || me.email || me.userId || '');
    const rows = buildRows(data);
    const liveAll = rows.flatMap((r) => r.live);
    const livOn = navOn('liv') !== false;
    // 20초 폴링마다 통째로 다시 그린다 — 스크롤 위치와 검색칸 포커스는 이어져야 한다(수백 행에서 매번 맨 위로 튀면 못 쓴다).
    const prevScroll = treeEl ? treeEl.scrollTop : 0;
    const findHad = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('v2-find-in') ? document.activeElement : null;
    const findSel = findHad ? [findHad.selectionStart, findHad.selectionEnd] : null;
    countEl = el('span', { class: 'v2-k' });
    treeEl = el('div', { class: 'v2-tree', role: 'tree', 'aria-label': '프로젝트와 세션' });
    const findIn = el('input', { class: 'v2-find-in', type: 'search', placeholder: '프로젝트 찾기', 'aria-label': '프로젝트 찾기', value: sideFilter,
        // 타이핑 중에는 트리만 다시 그린다(전면 재렌더는 포커스·한글 IME 조합을 깬다) → 아이콘 강조는 클래스만 손댄다
        oninput: (e) => {
            sideFilter = e.target.value;
            renderTree();
            if (treeEl)
                treeEl.scrollTop = 0;
            markFind();
        },
        // Esc = 지우고 접는다(검색어가 있으면 한 번 더 눌러야 접힌다 — 실수로 지운 걸 되돌릴 여지를 준다)
        onkeydown: (e) => {
            if (e.key !== 'Escape')
                return;
            e.stopPropagation();
            if (sideFilter) {
                sideFilter = '';
                renderTree();
                e.currentTarget.value = '';
                markFind();
            }
            else
                closeFind();
        },
        // 검색어 없이 다른 곳을 누르면 조용히 접힌다 — 빈 칸이 자리를 계속 차지할 이유가 없다
        onblur: () => { if (!sideFilter && findOpen)
            window.setTimeout(() => { if (!sideFilter)
                closeFind(); }, 120); } });
    const doneCount = rows.filter((r) => r.done).length;
    const fltN = (stateFilter ? 1 : 0) + (mineOnly ? 1 : 0) + (showDone ? 1 : 0);
    host.replaceChildren(switcherTop(), // 좌상단 워크스페이스 스위처(#1750) — 홈 워드마크 + 개인/팀 배지·전환·연결 메뉴
    // ⚠ replaceChildren 은 null 을 글자 "null" 로 그린다(el() 과 다르다) — 조건부 자식은 스프레드로.
    ...(livOn ? [el('a', { class: 'v2-liv-btn' + (last.activeKey() === 'liv' ? ' on' : ''), href: '#/liv', 'data-nav': 'liv' }, el('span', { class: 'lm', text: 'L' }), el('span', { text: '리브' }), el('span', { class: 'sub', text: '워크스페이스 담당자' }))] : []), el('div', { class: 'v2-side-sec' }, countEl, findBtn(), filterBtn(fltN, liveAll, doneCount), 
    // ＋도 아이콘으로 — 돋보기가 자리를 차지하면서 글자 버튼까지 두면 헤더가 두 줄로 접힌다(#1067 의 🔍/＋ 문법).
    el('a', { class: 'v2-add', href: '#/projects2', title: '새 프로젝트 — 프로젝트 앱(보드)에서 만듭니다', 'aria-label': '새 프로젝트' }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-add-ic', 'aria-hidden': 'true' }, sv('path', { d: 'M12 5v14M5 12h14' })))), 
    // 검색칸은 돋보기를 눌렀을 때만(#1067 의 방식). 단 **검색어가 남아 있으면 계속 보인다** —
    //  #1154 가 토글을 폐지했던 사유 중 하나가 '검색 중인 줄 모른 채 짧아진 목록을 본다'였다.
    ...(findShown() ? [el('div', { class: 'v2-find' }, findIn)] : []), ...(fltN ? [filterSummary(fltN)] : []), ...pinnedBlock(), treeEl, el('div', { class: 'v2-side-foot' }, el('button', { class: 'v2-apps-btn', type: 'button', onclick: () => openLaunchpad(), title: '앱 — 아직 새 화면으로 옮기지 않은 것들' }, appIcon('proj', 'v2-apps-ic'), el('span', { text: '앱' }), el('span', { class: 'v2-cnt', text: String(visibleApps().length) })), el('div', { class: 'v2-me' }, profileAvatar(me.avatar, name, me.userId, 'v2-ava', { char: me.avatar_char, color: me.avatar_color }), el('span', { class: 'v2-me-name', text: name }), el('button', { class: 'btn-text', type: 'button', text: '로그아웃', onclick: () => void logout() })), el('button', { class: 'v2-classic-link', type: 'button', text: '클래식 화면으로 (이 브라우저)', title: '이 브라우저에서만 옛 화면으로 봅니다. 관리탭 [화면] 에서 되돌릴 수 있어요.', onclick: () => { setUiModeOverride('classic'); location.replace(location.pathname + '#/dashboard'); location.reload(); } })));
    renderTree(rows);
    treeEl.scrollTop = prevScroll;
    if (findHad) {
        findIn.focus();
        if (findSel && findSel[0] != null)
            findIn.setSelectionRange(findSel[0], findSel[1]);
    }
    else if (findFocusWanted) {
        findFocusWanted = false;
        findIn.focus();
    }
    bindFindKey();
}
// ── 돋보기 = 검색칸 여닫기 (#1067 의 방식을 되살리되 #1154 의 반려 사유 둘을 설계로 막는다) ──
//  ⓐ "있는 줄도 모른다" → 돋보기 **아이콘 자체는 늘 보인다**(헤더 고정 자리) + 어디서든 `/` 키로 열린다 +
//     검색 중이면 아이콘이 켜진 상태로 남고 지우는 [×] 가 붙는다.
//  ⓑ "사이드바를 접으면 닿을 길이 없다" → 새 셸 사이드바는 통째로 접히지 않는다(손잡이 최소 200px).
//     클래식 프로젝트 보드(접힘 레일 없음)와 다른 조건이라 그 사유는 여기 해당하지 않는다.
let findFocusWanted = false;
const findShown = () => findOpen || !!sideFilter;
// 검색 중이면 돋보기를 켠 색으로 — 전면 재렌더 없이 클래스만(재렌더는 포커스·한글 IME 조합을 깬다)
function markFind() { const fb = document.querySelector('.v2-findbtn'); if (fb)
    fb.classList.toggle('has', !!sideFilter); }
function openFind() { findOpen = true; findFocusWanted = true; redraw(); }
function closeFind() { if (!findOpen && !sideFilter)
    return; findOpen = false; sideFilter = ''; redraw(); }
// `/` 한 번으로 열린다 — 글자를 치던 중이면(입력칸·편집영역) 가로채지 않는다.
function bindFindKey() {
    if (keyBound)
        return;
    keyBound = true;
    document.addEventListener('keydown', (e) => {
        if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey)
            return;
        const t = e.target;
        if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName)))
            return;
        if (!last)
            return;
        e.preventDefault();
        openFind();
    });
}
function findBtn() {
    const on = findShown();
    return el('span', { class: 'v2-findbtn-wrap' }, el('button', {
        class: 'v2-findbtn' + (on ? ' on' : '') + (sideFilter ? ' has' : ''), type: 'button',
        'aria-label': on ? '프로젝트 찾기 닫기' : '프로젝트 찾기', 'aria-expanded': String(on),
        title: on ? '닫기 (Esc)' : '프로젝트 찾기 — / 키로도 열려요',
        onclick: () => { if (findShown())
            closeFind();
        else
            openFind(); }
    }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-findbtn-ic', 'aria-hidden': 'true' }, sv('circle', { cx: '11', cy: '11', r: '6.5' }), sv('path', { d: 'M16 16l4.5 4.5' }))));
}
// [필터] 버튼 + 팝오버 — 조작부는 여기 다 모인다. 목록 표면에는 필터가 없다(켜져 있으면 요약 한 줄만).
function filterBtn(activeN, liveAll, doneCount) {
    const counts = new Map();
    for (const s of liveAll)
        counts.set(s.stateKey, (counts.get(s.stateKey) || 0) + 1);
    if (stateFilter && !counts.has(stateFilter))
        counts.set(stateFilter, 0); // 켜 둔 상태가 0이 돼도 끌 수 있게 남긴다
    const keys = [...counts.keys()].sort((a, b) => rankOf(a) - rankOf(b));
    const wrap = el('div', { class: 'v2-flt' });
    const btn = el('button', {
        class: 'v2-flt-btn' + (activeN ? ' has' : '') + (filterOpen ? ' open' : ''), type: 'button',
        'aria-haspopup': 'true', 'aria-expanded': String(filterOpen), title: '보기 조건 — 상태·범위·완료',
        onclick: (e) => { e.stopPropagation(); filterOpen = !filterOpen; redraw(); }
    }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-flt-ic', 'aria-hidden': 'true' }, sv('path', { d: 'M4 6h16M7 12h10M10 18h4' })), el('span', { text: '필터' }), activeN ? el('b', { class: 'v2-flt-n', text: String(activeN) }) : null);
    wrap.append(btn);
    if (filterOpen) {
        const opt = (on, label, cnt, dot, onclick) => el('button', { class: 'v2-fo' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on), onclick }, dot ? el('span', { class: 'v2-dot ' + dot, 'aria-hidden': 'true' }) : el('span', { class: 'v2-fo-pad', 'aria-hidden': 'true' }), el('span', { class: 'n', text: label }), cnt ? el('span', { class: 'v2-cnt', text: cnt }) : null, on ? el('span', { class: 'v2-fo-ck', text: '✓', 'aria-hidden': 'true' }) : null);
        wrap.append(el('div', { class: 'v2-flt-pop', role: 'menu', onclick: (e) => e.stopPropagation() }, el('div', { class: 'v2-flt-k', text: '세션 상태' }), opt(!stateFilter, '전체', '', null, () => { stateFilter = null; redraw(); }), ...keys.map((k) => {
            const st = SESS_STATES[k];
            return opt(stateFilter === k, st ? st.label : k, String(counts.get(k) || 0), dotCls(k), () => { stateFilter = stateFilter === k ? null : k; redraw(); });
        }), el('div', { class: 'v2-flt-k', text: '범위' }), opt(mineOnly, '내 프로젝트만', '', null, () => { mineOnly = !mineOnly; saveFlag(MINE_KEY, mineOnly); redraw(); }), opt(showDone, '완료 프로젝트도 보기', doneCount ? String(doneCount) : '', null, () => { showDone = !showDone; saveFlag(DONE_KEY, showDone); redraw(); }), el('div', { class: 'v2-flt-foot' }, el('button', { class: 'btn-text', type: 'button', text: '전부 지우기', onclick: () => { stateFilter = null; mineOnly = false; showDone = false; saveFlag(MINE_KEY, false); saveFlag(DONE_KEY, false); redraw(); } }), el('button', { class: 'btn-text', type: 'button', text: '닫기', onclick: () => { filterOpen = false; redraw(); } }))));
        if (!outsideBound) {
            outsideBound = true;
            document.addEventListener('click', (e) => {
                if (filterOpen && !e.target?.closest?.('.v2-flt')) {
                    filterOpen = false;
                    redraw();
                }
            });
        }
    }
    return wrap;
}
// 필터가 켜져 있을 때만 나오는 한 줄 — 무엇으로 걸러 보고 있는지 + 한 번에 끄기.
function filterSummary(n) {
    const bits = [];
    if (stateFilter) {
        const st = SESS_STATES[stateFilter];
        bits.push((st ? st.label : stateFilter) + ' 세션만');
    }
    if (mineOnly)
        bits.push('내 프로젝트만');
    if (showDone)
        bits.push('완료 포함');
    return el('div', { class: 'v2-flt-sum' }, el('span', { text: bits.join(' · ') }), el('button', { class: 'btn-text', type: 'button', text: '지우기', title: `필터 ${n}개를 끕니다`,
        onclick: () => { stateFilter = null; mineOnly = false; showDone = false; saveFlag(MINE_KEY, false); saveFlag(DONE_KEY, false); redraw(); } }));
}
// '열린 세션' 고정 줄(#1719 탭) — 셸 탭에 열려 있는 세션이 트리 위에 **상단 고정**으로 보인다(스크롤과 무관).
//  트리 속 원래 자리도 그대로 둔다(위치 보존) — 이 블록은 복사본이지 이동이 아니다. 누르면 그 탭으로 간다(한 세션 = 한 탭).
function pinnedBlock() {
    if (!last)
        return [];
    const open = last.openSessions();
    if (!open.length)
        return [];
    const { data, activeKey } = last;
    const ak = activeKey();
    const rows = [];
    for (const o of open) {
        const s = data.sessions.find((x) => x.id === o.id) || data.sessions.find((x) => x.logId === o.id);
        if (!s)
            continue;
        const pn = s.projectId ? (data.projects.find((p) => Number(p.id) === Number(s.projectId))?.name || '') : '';
        const t = sessText(s, '');
        rows.push(sessRow(s, ak, { main: t.main, sub: t.sub || pn }));
    }
    if (!rows.length)
        return [];
    return [el('div', { class: 'v2-pin' }, el('div', { class: 'v2-pin-h', text: '열린 세션' }), ...rows)];
}
// 트리(프로젝트 ▸ 세션) — 검색은 여기만 다시 그린다(입력칸 포커스를 잃지 않게).
function renderTree(rowsIn) {
    if (!last || !treeEl)
        return;
    const rows = rowsIn || buildRows(last.data);
    const activeKey = last.activeKey();
    // 지금 보는 프로젝트 — 프로젝트 화면이면 그것, 세션 화면이면 그 세션이 붙은 프로젝트(없으면 '프로젝트 없는 세션' 묶음).
    let selectedPk = activeKey.startsWith('p:') ? activeKey : '';
    if (activeKey.startsWith('s:')) {
        const sid = activeKey.slice(2);
        const s = last.data.sessions.find((x) => x.id === sid) || last.data.sessions.find((x) => x.logId === sid);
        selectedPk = s ? 'p:' + (s.projectId || 0) : '';
    }
    const q = sideFilter.trim().toLowerCase();
    const hit = (r) => !q || (r.proj ? (r.proj.name.toLowerCase().includes(q) || String(r.proj.id) === q) : '프로젝트 없는 세션'.includes(q));
    const stateOf = (r) => (stateFilter ? r.live.filter((s) => s.stateKey === stateFilter) : r.live);
    let hiddenDone = 0;
    const shown = rows.filter((r) => {
        if (!hit(r))
            return false;
        if (mineOnly && !r.mine)
            return false;
        if (stateFilter && !stateOf(r).length)
            return false;
        if (r.done && !showDone && !r.live.length) {
            hiddenDone++;
            return false;
        }
        return true;
    }).sort((a, b) => b.lastWork - a.lastWork || String((b.proj && b.proj.updated_at) || '').localeCompare(String((a.proj && a.proj.updated_at) || '')));
    if (countEl)
        countEl.textContent = `프로젝트 · ${shown.filter((r) => r.proj).length}${q || mineOnly || stateFilter ? ` / ${rows.filter((r) => r.proj && (showDone || !r.done || r.live.length)).length}` : ''}`;
    const kids = shown.map((r) => projRow(r, stateOf(r), activeKey, selectedPk));
    if (!kids.length) {
        kids.push(!last.data.loadedAt ? el('p', { class: 'v2-tree-note', text: '불러오는 중…' }) : !last.data.projects.length
            ? el('p', { class: 'v2-tree-note', text: '아직 프로젝트가 없어요. 가운데 입력창에 무엇이든 시키면 세션이 열리고, 프로젝트는 나중에 붙일 수 있어요.' })
            : el('div', { class: 'v2-tree-note' }, el('span', { text: '조건에 맞는 프로젝트가 없어요.' }), el('button', { class: 'btn-text', type: 'button', text: '필터 지우기', onclick: () => { sideFilter = ''; stateFilter = null; mineOnly = false; saveFlag(MINE_KEY, false); redraw(); } })));
    }
    if (hiddenDone)
        kids.push(el('button', { class: 'v2-tree-more', type: 'button', text: `숨긴 완료 프로젝트 ${hiddenDone}개 보기`, onclick: () => { showDone = true; saveFlag(DONE_KEY, true); redraw(); } }));
    treeEl.replaceChildren(...kids);
}
function projRow(r, sess, activeKey, selectedPk) {
    const p = r.proj;
    const pk = r.key;
    const href = p ? '#/p/' + p.id : '#/app/terminal';
    const isOn = activeKey === pk || (!p && activeKey === 'app:terminal');
    // 펼침 기본값(#1719 재구성): **선택된 프로젝트만 펼침**, 나머지는 접힘 — 사용자가 편 것만 그대로.
    //  선택을 일부러 접은 건 이 페이지 수명만 기억한다(다음 방문엔 다시 펼쳐 보인다 — 선택은 늘 보이는 게 기본).
    const isSel = pk === selectedPk;
    const isOpen = sess.length > 0 && (isSel ? !closedSelected.has(pk) : openSet.has(pk));
    const caret = sess.length
        ? el('button', { class: 'v2-car', type: 'button', 'aria-label': isOpen ? '접기' : '펼치기', 'aria-expanded': String(isOpen), text: '›', onclick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (isSel) {
                    if (isOpen)
                        closedSelected.add(pk);
                    else
                        closedSelected.delete(pk);
                }
                if (isOpen)
                    openSet.delete(pk);
                else
                    openSet.add(pk);
                saveSet(OPEN_KEY, openSet);
                renderTree();
            } })
        : el('span', { class: 'v2-car none', 'aria-hidden': 'true' });
    const tipBits = p
        ? [`#${p.id} · ${p.status_category === 'done' ? '완료' : p.status_category === 'unstarted' ? '시작 전' : '진행 중'}`, r.lastWork ? '마지막 작업 ' + when(r.lastWork) : '세션 없음', r.mine ? '내 프로젝트' : (p.created_by ? `${(people[p.created_by] && people[p.created_by].display_name) || p.created_by} 만듦` : '')]
        : ['프로젝트에 붙지 않은 세션 — AI 세션 앱에서 전부 봅니다'];
    // 이름은 언제나 같은 잉크색이다 — 완료·조용함은 태그·시각이 말한다(연회색 본문이 목록 절반이면 전체가 바래 보인다).
    const row = el('a', { class: 'v2-pj-row' + (isOn ? ' on' : ''), href, 'data-nav': p ? pk : 'app:terminal', title: (p ? p.name + '\n' : '') + tipBits.filter(Boolean).join(' · ') + '\n프로젝트 화면을 엽니다' }, caret, glyph(isOpen ? 'folder-open' : 'folder', 'v2-pj-ic'), el('span', { class: 'n', text: p ? p.name : '프로젝트 없는 세션' }), r.done ? el('span', { class: 'v2-tag', text: '완료' }) : null, sess.length ? sumEl(sess) : (r.lastWork ? el('span', { class: 'v2-pj-when', text: when(r.lastWork) }) : null));
    const head = sess.slice(0, MAX_SESS);
    const list = sess.length ? el('div', { class: 'v2-ss-list', role: 'group', hidden: !isOpen }, ...head.map((s) => sessRow(s, activeKey, sessText(s, p ? p.name : ''))), sess.length > MAX_SESS ? el('a', { class: 'v2-ss-more', href, text: `외 ${sess.length - MAX_SESS}개` }) : null) : null;
    return el('div', { class: 'v2-pj' + (isOpen ? ' open' : ''), role: 'treeitem', 'aria-expanded': sess.length ? String(isOpen) : null }, row, list);
}
// 프로젝트 행 오른쪽 — 숫자를 늘어놓지 않는다. **볼 일이 있는 것만**: 확인 필요(호박)·작업 중(파랑).
//  그 밖의 살아 있는 세션은 개수 하나(회색). 상태별 전체 분포는 [필터] 팝오버가 보여 준다.
function sumEl(sess) {
    if (!sess.length)
        return null;
    const c = { wait: 0, busy: 0, rest: 0 };
    for (const s of sess) {
        if (s.stateKey === 'waiting')
            c.wait++;
        else if (s.stateKey === 'busy')
            c.busy++;
        else
            c.rest++;
    }
    const part = (n, cls, label) => (n ? el('span', { class: 'v2-sum ' + cls, title: `${label} ${n}` }, el('span', { class: 'v2-dot ' + cls, 'aria-hidden': 'true' }), String(n)) : null);
    return el('span', { class: 'v2-sums', 'aria-label': `세션 ${sess.length}` }, part(c.wait, 'wait', '확인 필요'), part(c.busy, 'busy', '작업 중'), (!c.wait && !c.busy && c.rest) ? el('span', { class: 'v2-sum idle', title: `살아 있는 세션 ${c.rest}` }, String(c.rest)) : null);
}
// 세션 행 — 상태점 · 세션을 실제로 구분해 주는 글(sessText) · 남의 세션이면 소유자 얼굴 · 상태어.
function sessRow(s, activeKey, text) {
    const st = SESS_STATES[s.stateKey];
    const cls = dotCls(s.stateKey);
    const raw = s.raw || {};
    const owner = ownerName(s);
    // 프로젝트명 반복을 걷어낸 뒤의 이름·'지금 하는 일'(하네스 pane 제목 = 클래식 카드의 💬 줄).
    //  끝난 세션은 트리에 없으니 '마지막으로 하던 일'로 읽어도 틀리지 않는다.
    const main = text.main;
    const sub = text.sub;
    const tip = [s.label, raw.title && String(raw.title) !== s.label ? String(raw.title) : '', `${st ? st.label : s.stateLabel}${s.lastSeen ? ' · ' + when(s.lastSeen) : ''}`, s.owned ? '내 세션' : `${owner}의 세션`, raw.harness ? String(raw.harness) : '', s.node ? '노드 ' + s.node : ''].filter(Boolean).join('\n');
    return el('a', { class: 'v2-ss-row' + (activeKey === 's:' + s.id ? ' on' : '') + (s.owned ? '' : ' other'), href: '#/s/' + encodeURIComponent(s.id), 'data-nav': 's:' + s.id, title: tip + '\n세션 대화를 엽니다', role: 'treeitem' }, el('span', { class: 'v2-dot ' + cls, 'aria-hidden': 'true' }), el('span', { class: 'v2-ss-main' }, el('span', { class: 't', text: main }), sub ? el('span', { class: 'sub', text: sub }) : null), s.owned ? null : personFace(String(raw.owner || ''), 'v2-ss-face', owner), 
    // 오른쪽 끝은 **한 자리**로 고정한다 — 상태어를 조건부로 넣으면 행마다 길이가 달라 목록이 들쭉날쭉해진다(상민님 2026-08-18).
    //  상태는 왼쪽 점이, 개수는 프로젝트 행이 말한다. 여기는 '누르면 대화로 간다'는 표식만(hover 때 보인다).
    glyph('chat', 'v2-ss-go'));
}
