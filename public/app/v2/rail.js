// v2/rail.ts — 좌측 끝 **레일**(#2016, 원준 2026-08-26 "안 1 · 슬랙 그대로" → 같은 날 2차 "슬랙 다시 보고 수정").
//
//  슬랙 데스크톱 좌측 탭 레일을 그대로 옮긴다(헬프센터 스크린샷 2장 + 원준님 스크린샷으로 대조):
//   ⓪ 워크스페이스 — 평상시엔 **타일 한 장 + 뒤에 겹친 타일**(스택). 누르면 슬랙과 같은 흰 팝오버:
//      [아이콘 · 이름 · 부제] 목록(지금 것은 고리) · ＋ 워크스페이스 추가 · 「레일 펼치기」(패널 아이콘).
//      펼치면 문패 카드 + 다른 워크스페이스 목록이 레일 맨 위에 선다.
//   ① 구역 — 홈 · 확인할 것(배지) · AI 세션 · 프로젝트 · 위키 · 리브. 슬랙의 홈·DM·내 활동·나중에 자리.
//      고른 구역이 곧 **사이드바의 내용**이다(side.ts). 리브만 구역이 아니라 '갈 곳'이다 — 리브 화면은
//      대화 한 장이라 사이드바가 바뀔 이유가 없다(활성 표시는 주소로 판정).
//   ② 최근 연 앱 — 헤어라인 아래. 맥 독의 '최근 사용' 구간.
//   ③ 발치 — 앱(런치패드) · 나(내 프로필·환경설정 #1843). 슬랙의 ＋ · 아바타 자리.
//
//  ⚠ 레일을 여닫는 단추는 **여기 없다.** 슬랙은 창 맨 윗줄 맨 왼쪽(패널 아이콘)과 워크스페이스 팝오버
//   마지막 행, 그리고 ⌘⇧S 로 연다 — 우리도 그 셋이다(side.ts navRow · 이 파일 팝오버 · main.ts 단축키).
//
//  ⚠ 구역은 **사람이 고를 때만** 바뀐다. 주소를 따라 저절로 바꾸면, 홈 목록에서 세션 하나를 여는 순간
//   사이드바가 통째로 [AI 세션]으로 갈아엎여 방금 보던 목록이 사라진다. 슬랙도 DM 탭에서 대화를 열어도
//   탭은 DM 에 머문다. 그래서 구역은 이 모듈의 상태이고 브라우저에 기억한다.
import { el, navOn, profileAvatar, state } from '../core.js';
import { APPS, appIcon, openLaunchpad } from './apps.js';
import { icon } from './icons.js';
import { openMeModal } from './me-modal.js';
import { activeWorkspaceSlug, listWorkspaces, openWorkspaceMenu, switcherTop, switchWorkspace, workspaceInfo } from './switcher.js';
const SECTIONS = [
    { key: 'home', label: '홈', route: '#/', tab: null, icon: 'home' },
    { key: 'inbox', label: '확인할 것', route: '#/inbox', tab: null, icon: 'inbox' },
    { key: 'sess', label: 'AI 세션', route: '#/app/terminal', tab: 'terminal', icon: 'term' },
    { key: 'proj', label: '프로젝트', route: '#/app/projects2', tab: 'projects2', icon: 'proj' },
    { key: 'wiki', label: '위키', route: '#/app/knowledge', tab: 'knowledge', icon: 'wiki' },
];
const LINKS = [
    { key: 'liv', label: '리브', route: '#/liv', tab: 'liv', icon: 'liv' },
];
export function railSections() { return SECTIONS.filter((s) => !s.tab || navOn(s.tab)); }
export function sectionRoute(sec) { return (SECTIONS.find((s) => s.key === sec) || SECTIONS[0]).route; }
// ── 상태 ─────────────────────────────────────────────────────────────────────
const SEC_STORE = 'lively_v2_rail_sec';
const OPEN_STORE = 'lively_v2_rail_open'; // ⚠ 이름에 `_KEY` 를 쓰지 않는다 — gitleaks 가 시크릿으로 오인한다(#1954)
const RECENT_N = 4;
let section = 'home';
let open = false;
let host = null;
let hooks = {};
let inited = false;
let spaces = [];
function init() {
    if (inited)
        return;
    inited = true;
    try {
        const s = localStorage.getItem(SEC_STORE);
        if (s && SECTIONS.some((x) => x.key === s))
            section = s;
        open = localStorage.getItem(OPEN_STORE) === '1';
    }
    catch (_) { /* 못 읽어도 홈·접힘으로 선다 */ }
    void listWorkspaces().then((rows) => { if (rows.length) {
        spaces = rows;
        drawRail();
    } });
}
export function railSection() { return section; }
export function railIsOpen() { return open; }
export function setRailSection(sec, opts) {
    if (!SECTIONS.some((s) => s.key === sec))
        return;
    const changed = section !== sec;
    section = sec;
    try {
        localStorage.setItem(SEC_STORE, sec);
    }
    catch (_) { /* 이번 화면은 된다 */ }
    drawRail();
    hooks.onSection?.(sec, { navigate: changed || !!(opts && opts.navigate) });
}
export function toggleRail() {
    open = !open;
    try {
        localStorage.setItem(OPEN_STORE, open ? '1' : '0');
    }
    catch (_) { /* 이번 화면은 된다 */ }
    closePopover();
    drawRail();
    hooks.onLayout?.();
}
// ── 최근 앱 — 구역과 겹치는 것은 뺀다(같은 문이 레일에 둘이면 문이 아니라 헷갈림이다). ──
const SEC_APP_KEYS = new Set(['terminal', 'projects2', 'knowledge']);
function recentForRail(n) {
    let keys = [];
    try {
        const v = JSON.parse(localStorage.getItem('lively_v2_recent_apps') || '[]');
        if (Array.isArray(v))
            keys = v.filter((x) => typeof x === 'string');
    }
    catch (_) { /* 기록이 없으면 표 순서로 채운다 */ }
    const pick = [];
    const take = (a) => {
        if (!a || SEC_APP_KEYS.has(a.key) || pick.some((p) => p.key === a.key))
            return;
        if (a.tab && !navOn(a.tab))
            return;
        pick.push(a);
    };
    for (const k of keys) {
        if (pick.length >= n)
            break;
        take(APPS.find((a) => a.key === k));
    }
    for (const a of APPS) {
        if (pick.length >= n)
            break;
        take(a);
    }
    return pick.slice(0, n);
}
// ── 워크스페이스 — 스택 타일 + 슬랙식 팝오버 ─────────────────────────────────
function wsTile(w, cls) {
    const me = state.me || {};
    const cur = workspaceInfo();
    //  개인 워크스페이스의 얼굴은 내 아바타(원형) — 지금 것일 때만 계정 아바타를 안다.
    if (w.kind === 'personal' && w.name === cur.name)
        return profileAvatar(me.avatar, w.name, me.userId, cls + ' round', { char: me.avatar_char, color: me.avatar_color });
    return el('span', { class: cls + (w.kind === 'personal' ? ' round' : ''), text: String(w.name || '?').trim().slice(0, 1) });
}
/** 평상시(접힘)의 문패 — 타일 한 장 + 뒤에 겹친 타일. 슬랙의 그 스택. */
function stackTile() {
    const w = workspaceInfo();
    return el('button', {
        class: 'v2-rail-stack', type: 'button', 'aria-haspopup': 'menu',
        title: `${w.name} · ${w.kind === 'personal' ? '개인' : '팀'} 워크스페이스 — 누르면 전환`,
        onclick: (e) => { e.preventDefault(); if (popEl)
            closePopover();
        else
            openPopover(e.currentTarget); },
    }, wsTile(w, 'v2-wscard-big'));
}
let popEl = null;
function closePopover() {
    if (!popEl)
        return;
    popEl.remove();
    popEl = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
}
function onDocDown(e) { if (popEl && !popEl.contains(e.target) && !e.target.closest('.v2-rail-stack'))
    closePopover(); }
function onDocKey(e) { if (e.key === 'Escape')
    closePopover(); }
/** 슬랙의 워크스페이스 팝오버 — 목록(지금 것은 고리) · ＋ 추가 · 레일 펼치기. */
function openPopover(anchor) {
    closePopover();
    const cur = workspaceInfo();
    const curSlug = activeWorkspaceSlug();
    const rows = spaces.length
        ? spaces.map((w) => ({ slug: String(w.slug), name: String(w.name || w.slug), kind: String(w.kind || 'team'), active: w.slug === curSlug || (!!w.is_primary && curSlug === 'primary') }))
        : [{ slug: 'primary', name: cur.name, kind: cur.kind, active: true }];
    const pop = el('div', { class: 'v2-wspop', role: 'menu', 'aria-label': '워크스페이스' }, ...rows.map((w) => el('button', {
        class: 'v2-wspop-row' + (w.active ? ' cur' : ''), type: 'button', role: 'menuitemradio', 'aria-checked': String(w.active),
        title: w.active ? '지금 이 워크스페이스예요' : `${w.name} 워크스페이스로 전환`,
        onclick: () => { closePopover(); if (!w.active)
            switchWorkspace(w.slug); },
    }, wsTile(w, 'v2-wscard-big'), el('span', { class: 'v2-wspop-tt' }, el('b', { text: w.name }), el('span', { text: w.kind === 'personal' ? '개인 워크스페이스' : '팀 워크스페이스' })))), el('div', { class: 'v2-wspop-hr', role: 'separator' }), 
    //  ＋ — 만들기·연결 폼은 종전 메뉴(switcher.ts)가 이미 갖고 있다. 여기서 두 벌 만들지 않고 그 메뉴를 연다.
    el('button', { class: 'v2-wspop-row', type: 'button', role: 'menuitem', onclick: () => { closePopover(); openWorkspaceMenu(anchor); } }, el('span', { class: 'v2-wspop-ic' }, icon('plus')), el('span', { class: 'v2-wspop-tt' }, el('b', { text: '워크스페이스 추가' }), el('span', { text: '새로 만들거나 팀에 연결' }))), el('div', { class: 'v2-wspop-hr', role: 'separator' }), el('button', { class: 'v2-wspop-row', type: 'button', role: 'menuitem', onclick: () => { closePopover(); toggleRail(); } }, el('span', { class: 'v2-wspop-ic' }, icon('panel')), el('span', { class: 'v2-wspop-tt' }, el('b', { text: open ? '레일 접기' : '레일 펼치기' }), el('span', { text: '워크스페이스와 구역 이름을 늘 보이게' })), el('kbd', { class: 'v2-wspop-k', text: '⌘⇧S' })));
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.round(r.right + 8) + 'px';
    pop.style.top = Math.max(8, Math.round(r.top)) + 'px';
    document.body.append(pop);
    popEl = pop;
    window.setTimeout(() => { document.addEventListener('mousedown', onDocDown, true); document.addEventListener('keydown', onDocKey, true); }, 0);
}
/** 펼친 레일의 「다른 워크스페이스」 — 팝오버를 그 자리에 편 것. 하나뿐이면 그리지 않는다. */
function wsListOpen() {
    const cur = activeWorkspaceSlug();
    const others = spaces.filter((w) => !(w.slug === cur || (w.is_primary && cur === 'primary')));
    if (!others.length)
        return null;
    return el('div', { class: 'v2-rail-wsl' }, el('div', { class: 'v2-rail-k', text: '다른 워크스페이스' }), ...others.map((w) => el('button', {
        class: 'v2-rail-wsr', type: 'button', title: `${w.name} 워크스페이스로 전환`,
        onclick: () => switchWorkspace(String(w.slug)),
    }, wsTile({ name: String(w.name || w.slug), kind: String(w.kind || 'team') }, 'v2-wscard-big'), el('span', { class: 'v2-rail-t', text: String(w.name || w.slug) }), el('span', { class: 'v2-rail-kd', text: w.kind === 'personal' ? '개인' : '팀' }))));
}
// ── 그리기 ───────────────────────────────────────────────────────────────────
export function mountRail(el0, h) {
    init();
    host = el0;
    hooks = h || hooks;
    drawRail();
}
export function drawRail() {
    if (!host)
        return;
    init();
    const c = hooks.counts?.() || { inbox: 0, busy: 0, projects: 0 };
    const running = hooks.openApps?.() || new Set();
    const ak = hooks.activeKey?.() || '';
    const linkOn = LINKS.find((l) => l.key === ak) || null;
    host.classList.toggle('open', open);
    host.classList.toggle('closed', !open);
    document.getElementById('v2-root')?.classList.toggle('rail-open', open);
    // ⓪ 워크스페이스
    const top = el('div', { class: 'v2-rail-top' }, open
        ? switcherTop({ people: hooks.people?.() || {}, faces: hooks.faces?.() || [] })
        : el('div', { class: 'v2-rail-ws' }, stackTile()), open ? wsListOpen() : null);
    // ① 구역 — 아이콘 위, 이름 아래(접힘) / 가로 행(펼침).
    const item = (key, label, ic, on, extra, onclick, href) => el(href ? 'a' : 'button', {
        class: 'v2-rail-it' + (on ? ' on' : ''), ...(href ? { href } : { type: 'button' }), 'data-key': key,
        'aria-current': on ? 'page' : null, title: label,
        onclick: (e) => { if (!href)
            e.preventDefault(); onclick(); },
    }, icon(ic, 'v2-rail-ic'), el('span', { class: 'v2-rail-t', text: label }), extra);
    const secEls = railSections().map((s) => {
        const on = !linkOn && section === s.key;
        const meta = s.key === 'sess' && c.busy ? `${c.busy} 작업 중` : s.key === 'proj' && c.projects ? String(c.projects) : '';
        //  확인할 것 — 슬랙 '내 활동'의 그 배지. 접혀도 숫자가 아이콘 귀퉁이에 남는다.
        const extra = s.key === 'inbox' && c.inbox
            ? el('span', { class: 'v2-rail-bd', text: String(c.inbox), role: 'img', 'aria-label': `확인할 것 ${c.inbox}건` })
            : meta ? el('span', { class: 'v2-rail-m', text: meta }) : null;
        return item(s.key, s.label, s.icon, on, extra, () => setRailSection(s.key, { navigate: true }));
    });
    const linkEls = LINKS.filter((l) => !l.tab || navOn(l.tab) !== false)
        .map((l) => item(l.key, l.label, l.icon, !!linkOn && linkOn.key === l.key, null, () => { location.hash = l.route; }, l.route));
    // ② 최근 연 앱
    const recents = recentForRail(RECENT_N);
    const recentEls = recents.map((a) => item('app:' + a.key, a.title, a.icon, false, running.has(a.key) ? el('span', { class: 'v2-rail-run', role: 'img', 'aria-label': '실행 중' }) : null, () => { }, '#/app/' + a.key));
    //  선 아이콘은 icons.ts 한 벌이다 — 앱 아이콘 키(appIcon)와 같은 표를 쓰므로 여기서 appIcon 을 따로 부르지 않는다.
    void appIcon;
    const mid = el('div', { class: 'v2-rail-mid' }, ...secEls, ...linkEls, recentEls.length ? el('div', { class: 'v2-rail-hr', role: 'presentation' }) : null, recentEls.length && open ? el('div', { class: 'v2-rail-k', text: '최근 앱' }) : null, ...recentEls);
    // ③ 발치 — 앱 · 나 (슬랙의 ＋ · 아바타). 여닫는 단추는 여기 없다(머리말).
    const me = state.me || {};
    const myName = String(me.display_name || me.email || me.userId || '');
    const foot = el('footer', { class: 'v2-rail-foot' }, item('apps', '앱', 'apps', false, null, () => openLaunchpad()), el('button', {
        class: 'v2-rail-it v2-rail-me', type: 'button', 'aria-haspopup': 'dialog', title: '내 프로필 · 환경설정',
        onclick: () => openMeModal({ onSaved: () => drawRail() }),
    }, profileAvatar(me.avatar, myName, me.userId, 'v2-ava', { char: me.avatar_char, color: me.avatar_color }), el('span', { class: 'v2-rail-t', text: myName })));
    host.replaceChildren(top, mid, foot);
}
