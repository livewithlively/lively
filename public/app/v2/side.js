// v2/side.ts — 새 셸 좌측 사이드바(#1719): 워크스페이스 **전체** 프로젝트 ▸ 살아 있는 세션 트리.
//  규칙(상민님 2026-08-18):
//   · 프로젝트는 워크스페이스 전체가 보인다(내 것만이 아니다). '내 프로젝트만'은 토글.
//   · 프로젝트 아래엔 **끝나지 않은 세션만**(살아 있는 박스 — 중단됨·종료됨·기록만 남은 대화는 빼고). 끝난 것은 프로젝트 화면·세션 이력에서.
//   · 완료 프로젝트는 기본 숨김 — [완료 숨김] 필터를 풀 때만 보인다. 단 완료인데 살아 있는 세션이 있으면 보인다(도는 게 있으면 사실상 진행 중).
//   · 정렬 = 그 프로젝트 세션들의 **마지막 작업 시각**(work-flag 훅 보고 = lastActive, 기록은 last_seen) 내림차순.
//     끝난 세션도 시각엔 센다(마지막으로 일한 프로젝트가 위로) — 세션이 하나도 없는 프로젝트는 그 뒤에 updated_at 순.
//   · 한눈에 상태: 맨 위 상태 칩(확인 필요·작업 중·… 개수, 누르면 그 상태만), 프로젝트 행에 상태별 개수, 세션 행에 상태점+상태어,
//     남이 만든 세션엔 소유자 얼굴(내 것은 표시 없음). 상태 어휘는 web/session-status.ts 한 벌(AI 세션 탭·대시보드와 같다).
//  main.ts 가 데이터·활성 키를 넘기고, 필터·펼침 같은 사이드바 자체 상태는 여기 산다(브라우저에 기억).
import { el, loadPeopleAvatars, logout, navOn, personFace, profileAvatar, relTime, setUiModeOverride, state } from '../core.js';
import { SESS_STATES } from '../session-status.js';
import { appIcon, openLaunchpad, visibleApps } from './apps.js';
import { dotCls } from './views.js';
const CLOSED_KEY = 'lively_v2_closed'; // 사용자가 직접 접은 프로젝트 — 살아 있는 세션이 있으면 기본이 '펼침'이라 '접음'만 기억하면 된다
const DONE_KEY = 'lively_v2_side_done'; // '1' = 완료 프로젝트도 보인다(필터 풀림)
const MINE_KEY = 'lively_v2_side_mine'; // '1' = 내 프로젝트만
const MAX_SESS = 12; // 한 프로젝트 아래 펼쳐 보이는 세션 상한(넘치면 '외 n개' → 프로젝트 화면)
let closedSet = new Set();
let showDone = false;
let mineOnly = false;
let sideFilter = '';
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
    closedSet = loadSet(CLOSED_KEY);
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
// ── 그리기 ──
export function drawSide(host, data, activeKey) {
    init();
    last = { host, data, activeKey };
    render();
}
function redraw() { if (last)
    render(); }
let treeEl = null;
let countEl = null;
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
        oninput: (e) => { sideFilter = e.target.value; renderTree(); if (treeEl)
            treeEl.scrollTop = 0; } });
    const doneCount = rows.filter((r) => r.done).length;
    host.replaceChildren(el('div', { class: 'v2-side-top' }, el('a', { class: 'v2-logo', href: '#/', title: '홈으로', 'data-nav': 'home' }, 'Lively', el('span', { class: 'pulse-dot', 'aria-hidden': 'true' }))), 
    // ⚠ replaceChildren 은 null 을 글자 "null" 로 그린다(el() 과 다르다) — 조건부 자식은 스프레드로.
    ...(livOn ? [el('a', { class: 'v2-liv-btn' + (last.activeKey() === 'liv' ? ' on' : ''), href: '#/liv', 'data-nav': 'liv' }, el('span', { class: 'lm', text: 'L' }), el('span', { text: '리브' }), el('span', { class: 'sub', text: '워크스페이스 담당자' }))] : []), el('div', { class: 'v2-side-sec' }, countEl, el('a', { class: 'v2-add', href: '#/projects2', text: '+ 새 프로젝트', title: '프로젝트 앱(보드)에서 만듭니다' })), el('div', { class: 'v2-find' }, findIn), ...stateChips(liveAll), el('div', { class: 'v2-side-flt', role: 'group', 'aria-label': '필터' }, toggle('완료 숨김', !showDone, doneCount ? String(doneCount) : '', '완료된 프로젝트를 목록에서 뺍니다(살아 있는 세션이 있으면 그래도 보여요). 누르면 완료도 보입니다.', () => { showDone = !showDone; saveFlag(DONE_KEY, showDone); redraw(); }), toggle('내 프로젝트만', mineOnly, '', '내가 만들었거나 팀원인 프로젝트만 봅니다.', () => { mineOnly = !mineOnly; saveFlag(MINE_KEY, mineOnly); redraw(); })), treeEl, el('div', { class: 'v2-side-foot' }, el('button', { class: 'v2-apps-btn', type: 'button', onclick: () => openLaunchpad(), title: '앱 — 아직 새 화면으로 옮기지 않은 것들' }, appIcon('proj', 'v2-apps-ic'), el('span', { text: '앱' }), el('span', { class: 'v2-cnt', text: String(visibleApps().length) })), el('div', { class: 'v2-me' }, profileAvatar(me.avatar, name, me.userId, 'v2-ava', { char: me.avatar_char, color: me.avatar_color }), el('span', { class: 'v2-me-name', text: name }), el('button', { class: 'btn-text', type: 'button', text: '로그아웃', onclick: () => void logout() })), el('button', { class: 'v2-classic-link', type: 'button', text: '클래식 화면으로 (이 브라우저)', title: '이 브라우저에서만 옛 화면으로 봅니다. 관리탭 [화면] 에서 되돌릴 수 있어요.', onclick: () => { setUiModeOverride('classic'); location.replace(location.pathname + '#/dashboard'); location.reload(); } })));
    renderTree(rows);
    treeEl.scrollTop = prevScroll;
    if (findHad) {
        findIn.focus();
        if (findSel && findSel[0] != null)
            findIn.setSelectionRange(findSel[0], findSel[1]);
    }
}
// 상태 칩 — 살아 있는 세션 전부의 상태별 개수. rank 순('지금 볼 것 먼저'). 누르면 그 상태 세션이 있는 프로젝트·그 세션만 남는다.
function stateChips(liveAll) {
    const counts = new Map();
    for (const s of liveAll)
        counts.set(s.stateKey, (counts.get(s.stateKey) || 0) + 1);
    if (stateFilter && !counts.has(stateFilter))
        counts.set(stateFilter, 0); // 켜 둔 필터의 상태가 0이 돼도 칩은 남겨 끌 수 있게
    const keys = [...counts.keys()].sort((a, b) => rankOf(a) - rankOf(b));
    if (!keys.length)
        return [];
    return [el('div', { class: 'v2-side-sum', role: 'group', 'aria-label': '세션 상태' }, ...keys.map((k) => {
            const st = SESS_STATES[k];
            const on = stateFilter === k;
            return el('button', {
                class: 'v2-stchip ' + dotCls(k) + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on),
                title: (st ? st.hint : k) + (on ? ' — 다시 누르면 전체' : ' — 누르면 이 상태만'),
                onclick: () => { stateFilter = on ? null : k; redraw(); }
            }, el('span', { class: 'v2-dot ' + dotCls(k), 'aria-hidden': 'true' }), el('span', { text: st ? st.label : k }), el('b', { text: String(counts.get(k) || 0) }));
        }))];
}
function toggle(label, on, cnt, tip, onclick) {
    return el('button', { class: 'v2-tg' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on), title: tip, onclick }, el('span', { class: 'v2-tg-mark', 'aria-hidden': 'true' }), el('span', { text: label }), cnt ? el('span', { class: 'v2-cnt', text: cnt }) : null);
}
// 트리(프로젝트 ▸ 세션) — 검색은 여기만 다시 그린다(입력칸 포커스를 잃지 않게).
function renderTree(rowsIn) {
    if (!last || !treeEl)
        return;
    const rows = rowsIn || buildRows(last.data);
    const activeKey = last.activeKey();
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
    const kids = shown.map((r) => projRow(r, stateOf(r), activeKey));
    if (!kids.length) {
        kids.push(!last.data.loadedAt ? el('p', { class: 'v2-tree-note', text: '불러오는 중…' }) : !last.data.projects.length
            ? el('p', { class: 'v2-tree-note', text: '아직 프로젝트가 없어요. 리브에게 무엇이든 시키거나, [+ 새 프로젝트]로 시작하세요.' })
            : el('div', { class: 'v2-tree-note' }, el('span', { text: '조건에 맞는 프로젝트가 없어요.' }), el('button', { class: 'btn-text', type: 'button', text: '필터 지우기', onclick: () => { sideFilter = ''; stateFilter = null; mineOnly = false; saveFlag(MINE_KEY, false); redraw(); } })));
    }
    if (hiddenDone)
        kids.push(el('button', { class: 'v2-tree-more', type: 'button', text: `숨긴 완료 프로젝트 ${hiddenDone}개 보기`, onclick: () => { showDone = true; saveFlag(DONE_KEY, true); redraw(); } }));
    treeEl.replaceChildren(...kids);
}
function projRow(r, sess, activeKey) {
    const p = r.proj;
    const pk = r.key;
    const href = p ? '#/p/' + p.id : '#/app/terminal';
    const isOn = activeKey === pk || (!p && activeKey === 'app:terminal');
    // 펼침 기본값: 살아 있는 세션이 있으면 **펼침**(한눈에 상태를 보는 게 사이드바의 일이다) — 사용자가 접은 것만 접힌 채로.
    const isOpen = sess.length > 0 && !closedSet.has(pk);
    const caret = sess.length
        ? el('button', { class: 'v2-car', type: 'button', 'aria-label': isOpen ? '접기' : '펼치기', 'aria-expanded': String(isOpen), text: '›', onclick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (isOpen)
                    closedSet.add(pk);
                else
                    closedSet.delete(pk);
                saveSet(CLOSED_KEY, closedSet);
                renderTree();
            } })
        : el('span', { class: 'v2-car none', 'aria-hidden': 'true' });
    const tipBits = p
        ? [`#${p.id} · ${p.status_category === 'done' ? '완료' : p.status_category === 'unstarted' ? '시작 전' : '진행 중'}`, r.lastWork ? '마지막 작업 ' + when(r.lastWork) : '세션 없음', r.mine ? '내 프로젝트' : (p.created_by ? `${(people[p.created_by] && people[p.created_by].display_name) || p.created_by} 만듦` : '')]
        : ['프로젝트에 붙지 않은 세션 — AI 세션 앱에서 전부 봅니다'];
    // 살아 있는 세션이 없는 프로젝트는 한 톤 조용히(quiet) + 오른쪽에 '마지막 작업' 시각 — 왜 이 자리에 있는지(정렬 근거)가 보인다.
    const row = el('a', { class: 'v2-pj-row' + (isOn ? ' on' : '') + (r.done ? ' is-done' : '') + (sess.length ? '' : ' quiet'), href, 'data-nav': p ? pk : 'app:terminal', title: (p ? p.name + '\n' : '') + tipBits.filter(Boolean).join(' · ') }, caret, el('span', { class: 'n', text: p ? p.name : '프로젝트 없는 세션' }), r.done ? el('span', { class: 'v2-tag', text: '완료' }) : null, sess.length ? sumEl(sess) : (r.lastWork ? el('span', { class: 'v2-pj-when', text: when(r.lastWork) }) : null));
    const list = sess.length ? el('div', { class: 'v2-ss-list', role: 'group', hidden: !isOpen }, ...sess.slice(0, MAX_SESS).map((s) => sessRow(s, activeKey)), sess.length > MAX_SESS ? el('a', { class: 'v2-ss-more', href, text: `외 ${sess.length - MAX_SESS}개` }) : null) : null;
    return el('div', { class: 'v2-pj' + (isOpen ? ' open' : ''), role: 'treeitem', 'aria-expanded': sess.length ? String(isOpen) : null }, row, list);
}
// 프로젝트 행 오른쪽 — 상태별 개수(확인 필요·작업 완료·작업 중은 색으로, 그 밖의 살아 있는 것은 회색 하나로).
function sumEl(sess) {
    if (!sess.length)
        return null;
    const c = { wait: 0, done: 0, busy: 0, rest: 0 };
    for (const s of sess) {
        if (s.stateKey === 'waiting')
            c.wait++;
        else if (s.stateKey === 'done')
            c.done++;
        else if (s.stateKey === 'busy')
            c.busy++;
        else
            c.rest++;
    }
    const part = (n, cls, label) => (n ? el('span', { class: 'v2-sum ' + cls, title: `${label} ${n}` }, el('span', { class: 'v2-dot ' + cls, 'aria-hidden': 'true' }), String(n)) : null);
    return el('span', { class: 'v2-sums', 'aria-label': `세션 ${sess.length}` }, part(c.wait, 'wait', '확인 필요'), part(c.done, 'done', '작업 완료'), part(c.busy, 'busy', '작업 중'), part(c.rest, 'idle', '대기·오프라인·셸'));
}
// 세션 행 — 상태점 · 이름(+ 아래에 '지금 하는 일' 한 줄) · 남의 세션이면 소유자 얼굴 · 상태어.
function sessRow(s, activeKey) {
    const st = SESS_STATES[s.stateKey];
    const cls = dotCls(s.stateKey);
    const raw = s.raw || {};
    const owner = ownerName(s);
    // '지금 하는 일'(하네스가 pane 제목에 써 두는 요약, 클래식 카드의 💬 줄) — 이름과 다를 때만 둘째 줄로. 세션 이름이 프로젝트명 그대로인 게 많아
    //  이 줄이 사실상 세션을 구분해 준다. 끝난 세션은 트리에 없으니 '마지막으로 하던 일'로 읽어도 틀리지 않는다.
    const sub = raw.title && String(raw.title) !== s.label ? String(raw.title) : '';
    const tip = [s.label, `${st ? st.label : s.stateLabel}${s.lastSeen ? ' · ' + when(s.lastSeen) : ''}`, s.owned ? '내 세션' : `${owner}의 세션`, raw.harness ? String(raw.harness) : '', s.node ? '노드 ' + s.node : ''].filter(Boolean).join('\n');
    return el('a', { class: 'v2-ss-row' + (activeKey === 's:' + s.id ? ' on' : '') + (s.owned ? '' : ' other'), href: '#/s/' + encodeURIComponent(s.id), 'data-nav': 's:' + s.id, title: tip, role: 'treeitem' }, el('span', { class: 'v2-dot ' + cls, 'aria-hidden': 'true' }), el('span', { class: 'v2-ss-main' }, el('span', { class: 't', text: s.label }), sub ? el('span', { class: 'sub', text: sub }) : null), s.owned ? null : personFace(String(raw.owner || ''), 'v2-ss-face', owner), el('span', { class: 'w ' + cls, text: st ? st.label : s.stateLabel }));
}
