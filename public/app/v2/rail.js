// v2/rail.ts — 좌측 끝 **레일**(#2016, 원준 2026-08-26 "안 1 · 슬랙 그대로" → 2차 "슬랙 다시 보고" → 3차 "숨김 = B안").
//
//  슬랙 데스크톱 좌측 탭 레일을 그대로 옮긴다(헬프센터 스크린샷 2장 + 원준님 스크린샷으로 대조):
//   ⓪ 워크스페이스 — **타일 한 장 + 뒤에 겹친 타일**(스택). 누르면 슬랙과 같은 흰 팝오버:
//      [아이콘 · 이름 · 부제] 목록(지금 것은 고리) · ＋ 워크스페이스 추가 · 「레일 숨기기/펼치기」(패널 아이콘).
//   ① 구역 — 홈 · 확인할 것(배지) · AI 세션 · 프로젝트 · 위키 · 리브. 슬랙의 홈·DM·내 활동·나중에 자리.
//      고른 구역이 곧 **사이드바의 내용**이다(side.ts). 리브만 구역이 아니라 '갈 곳'이다 — 리브 화면은
//      대화 한 장이라 사이드바가 바뀔 이유가 없다(활성 표시는 주소로 판정).
//   ② 최근 연 앱 — 헤어라인 아래. 맥 독의 '최근 사용' 구간.
//   ③ 발치 — 앱(런치패드) · 나(내 프로필·환경설정 #1843). 슬랙의 ＋ · 아바타 자리.
//
//  ⚠ 레일 폭은 **68px 고정**이다(원준 3차: "가로 늘리면 UI 바뀌는 거 없이 폭 고정"). 종전의 232px 펼침 모드는
//   걷었다 — 상태는 **보임 / 숨김** 둘뿐. 숨기면 레일이 들고 있던 워크스페이스·구역·앱·나가 사이드바 머리와
//   발치로 들어간다(side.ts wsHead·secFoot — 안 B '머리글 드롭다운'). 되살리는 길은 셋: 사이드바 맨 윗줄
//   왼쪽 패널 단추 · 워크스페이스 팝오버 마지막 행 · ⌘⇧S.
//
//  ⚠ 구역은 **사람이 고를 때만** 바뀐다. 주소를 따라 저절로 바꾸면, 홈 목록에서 세션 하나를 여는 순간
//   사이드바가 통째로 [AI 세션]으로 갈아엎여 방금 보던 목록이 사라진다. 슬랙도 DM 탭에서 대화를 열어도
//   탭은 DM 에 머문다. 그래서 구역은 이 모듈의 상태이고 브라우저에 기억한다.
import { el, navOn, profileAvatar, state, toast } from '../core.js';
import { APPS, openLaunchpad } from './apps.js';
import { icon } from './icons.js';
import { openMeModal } from './me-modal.js';
import { ctxMenu } from './panes-kit.js'; // 우클릭 메뉴 — 곁칸·프로젝트 행과 같은 부품
import { activeWorkspaceSlug, listWorkspaces, openWorkspaceMenu, switchWorkspace, workspaceInfo } from './switcher.js';
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
export function sectionDef(sec) { return SECTIONS.find((s) => s.key === sec) || SECTIONS[0]; }
export function sectionRoute(sec) { return sectionDef(sec).route; }
// ── 상태 ─────────────────────────────────────────────────────────────────────
const SEC_STORE = 'lively_v2_rail_sec';
const HIDE_STORE = 'lively_v2_rail_hidden'; // ⚠ 이름에 `_KEY` 를 쓰지 않는다 — gitleaks 가 시크릿으로 오인한다(#1954)
const PIN_STORE = 'lively_v2_rail_pins'; // 독에 고정한 앱 키(사람이 정한 순서). 최근 앱과 같은 이유로 이 기기에 둔다.
const RECENT_N = 4;
const NARROW_MQ = '(max-width: 900px)'; // mobile.ts MOBILE_MQ 와 같은 값 — 좁은 폭에선 레일이 늘 아이콘으로 선다(47-v2-rail.css)
let section = 'home';
let hidden = false;
let host = null;
let hooks = {};
let inited = false;
let spaces = [];
let pins = [];
function init() {
    if (inited)
        return;
    inited = true;
    try {
        const s = localStorage.getItem(SEC_STORE);
        if (s && SECTIONS.some((x) => x.key === s))
            section = s;
        hidden = localStorage.getItem(HIDE_STORE) === '1';
        const p = JSON.parse(localStorage.getItem(PIN_STORE) || '[]');
        if (Array.isArray(p))
            pins = p.filter((x) => typeof x === 'string' && APPS.some((a) => a.key === x));
        localStorage.removeItem('lively_v2_rail_open'); // 232px 펼침 모드(2차)의 기억 — 이제 뜻이 없다
    }
    catch (_) { /* 못 읽어도 홈·보임으로 선다 */ }
    void listWorkspaces().then((rows) => { if (rows.length) {
        spaces = rows;
        drawRail();
    } });
}
export function railSection() { return section; }
/** 레일이 숨겨져 있는가 — 좁은 폭에선 늘 '아니오'(거기선 CSS 가 레일을 아이콘으로 세운다). */
export function railIsHidden() { return hidden && !window.matchMedia(NARROW_MQ).matches; }
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
    hidden = !hidden;
    try {
        localStorage.setItem(HIDE_STORE, hidden ? '1' : '0');
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
        if (!a || SEC_APP_KEYS.has(a.key) || pins.includes(a.key) || pick.some((p) => p.key === a.key))
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
/** 문패 = 타일 한 장 + 뒤에 겹친 타일(슬랙의 그 스택). 레일 맨 위에도, 레일을 숨겼을 땐 사이드바 머리에도 선다. */
export function stackTile(opts) {
    const w = workspaceInfo();
    const kindText = w.kind === 'personal' ? '개인' : '팀';
    return el('button', {
        class: 'v2-rail-stack' + (opts && opts.small ? ' sm' : '') + (opts && opts.label ? ' v2-side-wsbtn' : ''), type: 'button', 'aria-haspopup': 'menu',
        title: `${w.name} · ${kindText} 워크스페이스 — 누르면 전환`,
        onclick: (e) => { e.preventDefault(); if (popEl)
            closePopover();
        else
            openPopover(e.currentTarget); },
    }, el('span', { class: 'v2-rail-stack-t' }, wsTile(w, 'v2-wscard-big')), opts && opts.label ? el('span', { class: 'v2-side-wsbtn-n', text: w.name }) : null, opts && opts.label ? el('span', { class: 'v2-ws-car', 'aria-hidden': 'true', text: '▾' }) : null);
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
function onDocDown(e) {
    const t = e.target;
    if (popEl && !popEl.contains(t) && !t.closest('.v2-rail-stack') && !t.closest('.v2-secdd'))
        closePopover();
}
function onDocKey(e) { if (e.key === 'Escape')
    closePopover(); }
function place(pop, anchor, below) {
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.round(below ? Math.max(8, r.left) : r.right + 8) + 'px';
    pop.style.top = Math.round(below ? r.bottom + 6 : Math.max(8, r.top)) + 'px';
    document.body.append(pop);
    popEl = pop;
    window.setTimeout(() => { document.addEventListener('mousedown', onDocDown, true); document.addEventListener('keydown', onDocKey, true); }, 0);
}
/** 슬랙의 워크스페이스 팝오버 — 목록(지금 것은 고리) · ＋ 추가 · 레일 숨기기/펼치기. */
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
    el('button', { class: 'v2-wspop-row', type: 'button', role: 'menuitem', onclick: () => { closePopover(); openWorkspaceMenu(anchor); } }, el('span', { class: 'v2-wspop-ic' }, icon('plus')), el('span', { class: 'v2-wspop-tt' }, el('b', { text: '워크스페이스 추가' }), el('span', { text: '새로 만들거나 팀에 연결' }))), el('div', { class: 'v2-wspop-hr', role: 'separator' }), el('button', { class: 'v2-wspop-row', type: 'button', role: 'menuitem', onclick: () => { closePopover(); toggleRail(); } }, el('span', { class: 'v2-wspop-ic' }, icon('panel')), el('span', { class: 'v2-wspop-tt' }, el('b', { text: hidden ? '레일 펼치기' : '레일 숨기기' }), el('span', { text: hidden ? '워크스페이스 · 구역 · 앱 · 나를 왼쪽 끝으로' : '워크스페이스 · 구역 · 앱 · 나를 사이드바로' })), el('kbd', { class: 'v2-wspop-k', text: '⌘⇧S' })));
    //  레일에서 열면 오른쪽 옆, 사이드바 머리에서 열면 그 아래(슬랙의 「HonestAI ▾」 메뉴 자리).
    place(pop, anchor, !!anchor.closest('.v2-side'));
}
/** 레일을 숨겼을 때 사이드바 머리의 **구역 드롭다운**(안 B) — 여섯 행 + 「레일 펼치기」. */
export function openSectionMenu(anchor) {
    if (popEl) {
        closePopover();
        return;
    }
    const c = hooks.counts?.() || { inbox: 0, busy: 0, projects: 0 };
    const ak = hooks.activeKey?.() || '';
    const linkOn = LINKS.find((l) => l.key === ak) || null;
    const row = (key, label, ic, on, extra, run) => el('button', { class: 'v2-secdd-row' + (on ? ' on' : ''), type: 'button', role: 'menuitemradio', 'aria-checked': String(on),
        onclick: () => { closePopover(); run(); } }, icon(ic, 'v2-ic'), el('span', { class: 'v2-secdd-t', text: label }), extra);
    const pop = el('div', { class: 'v2-secdd-menu', role: 'menu', 'aria-label': '구역' }, ...railSections().map((s) => {
        const extra = s.key === 'inbox' && c.inbox ? el('span', { class: 'v2-rail-bd', text: String(c.inbox) })
            : s.key === 'sess' && c.busy ? el('span', { class: 'v2-secdd-m', text: `${c.busy} 작업 중` })
                : s.key === 'proj' && c.projects ? el('span', { class: 'v2-secdd-m', text: String(c.projects) }) : null;
        return row(s.key, s.label, s.icon, !linkOn && section === s.key, extra, () => setRailSection(s.key, { navigate: true }));
    }), ...LINKS.filter((l) => !l.tab || navOn(l.tab) !== false).map((l) => row(l.key, l.label, l.icon, !!linkOn && linkOn.key === l.key, null, () => { location.hash = l.route; })), el('div', { class: 'v2-wspop-hr', role: 'separator' }), row('rail', '레일 펼치기', 'panel', false, el('kbd', { class: 'v2-wspop-k', text: '⌘⇧S' }), () => toggleRail()));
    place(pop, anchor, true);
}
// ── 독 손질(#2016 4차, 원준: "맥 독처럼 실행한 앱을 독에 고정·커스텀") ────────────────
//  맥 독 문법 그대로: 우클릭(또는 길게 누르기) → 「독에 고정 / 독에서 빼기」 · 고정한 것끼리 끌어서 순서 ·
//  최근 앱을 고정 구간으로 끌어다 놓으면 고정 · 고정한 것을 레일 밖으로 끌어내면 빼기.
//  구간은 셋 — 구역(고정, 손댈 수 없음) | 고정한 앱(사람이 정한 순서) | 최근 연 앱(자동). 맥 독의 앱 구간·최근 구간.
function savePins() { try {
    localStorage.setItem(PIN_STORE, JSON.stringify(pins));
}
catch (_) { /* 이번 화면은 된다 */ } }
function placePin(key, idx) {
    const cur = pins.indexOf(key);
    const next = pins.filter((k) => k !== key);
    if (cur >= 0 && cur < idx)
        idx -= 1;
    next.splice(Math.max(0, Math.min(idx, next.length)), 0, key);
    pins = next;
    savePins();
    drawRail();
}
function unpinApp(key) { pins = pins.filter((k) => k !== key); savePins(); drawRail(); }
function dockMenu(x, y, a, pinned) {
    ctxMenu(x, y, [
        { label: '열기', run: () => { location.hash = '#/app/' + a.key; } },
        { sep: true, label: '' },
        pinned
            ? { label: '독에서 빼기', run: () => unpinApp(a.key) }
            : { label: '독에 고정', run: () => placePin(a.key, pins.length) },
    ]);
}
let dragKey = null;
let dropped = false;
function clearOver() { host?.querySelectorAll('.over-top, .over-bot').forEach((x) => x.classList.remove('over-top', 'over-bot')); }
function wireDock(it, a, pinned) {
    let hold = null;
    let sx = 0;
    let sy = 0;
    const cancelHold = () => { if (hold) {
        window.clearTimeout(hold);
        hold = null;
    } };
    it.addEventListener('dragstart', (e) => {
        cancelHold();
        dragKey = a.key;
        dropped = false;
        it.classList.add('dragging');
        host?.classList.add('drag');
        if (e.dataTransfer) {
            e.dataTransfer.setData('text/plain', a.key);
            e.dataTransfer.effectAllowed = 'move';
        }
    });
    it.addEventListener('dragend', (e) => {
        it.classList.remove('dragging');
        host?.classList.remove('drag');
        clearOver();
        const key = dragKey;
        dragKey = null;
        //  레일 밖에 놓았다 = 독에서 뺀다(맥 독). 고정한 것만 — 최근 앱은 원래 자동으로 오가는 것이라 뺄 게 없다.
        if (!dropped && key && pinned && host) {
            const r = host.getBoundingClientRect();
            const out = e.clientX > r.right + 24 || e.clientX < r.left - 24 || e.clientY < r.top || e.clientY > r.bottom;
            if (out) {
                unpinApp(key);
                toast('독에서 뺐어요 — 최근에 열면 다시 아래에 떠요');
            }
        }
    });
    if (pinned) {
        it.addEventListener('dragover', (e) => {
            if (!dragKey || dragKey === a.key)
                return;
            e.preventDefault();
            const r = it.getBoundingClientRect();
            const before = e.clientY < r.top + r.height / 2;
            clearOver();
            it.classList.add(before ? 'over-top' : 'over-bot');
        });
        it.addEventListener('dragleave', () => it.classList.remove('over-top', 'over-bot'));
        it.addEventListener('drop', (e) => {
            if (!dragKey)
                return;
            e.preventDefault();
            e.stopPropagation();
            const r = it.getBoundingClientRect();
            const before = e.clientY < r.top + r.height / 2;
            const idx = pins.indexOf(a.key) + (before ? 0 : 1);
            dropped = true;
            placePin(dragKey, idx);
        });
    }
    it.addEventListener('contextmenu', (e) => { e.preventDefault(); dockMenu(e.clientX, e.clientY, a, pinned); });
    //  길게 누르기(550ms) — 우클릭이 없는 자리(터치·트랙패드 한 손가락)의 같은 메뉴. 움직이면 끌기로 본다.
    it.addEventListener('pointerdown', (e) => {
        if (e.button !== 0)
            return;
        sx = e.clientX;
        sy = e.clientY;
        hold = window.setTimeout(() => { hold = null; dockMenu(sx, sy, a, pinned); }, 550);
    });
    it.addEventListener('pointerup', cancelHold);
    it.addEventListener('pointerleave', cancelHold);
    it.addEventListener('pointermove', (e) => { if (hold && Math.hypot(e.clientX - sx, e.clientY - sy) > 6)
        cancelHold(); });
}
/** 고정 구간 자체도 놓을 자리다 — 비어 있을 때(끌기 중엔 점선 칸이 생긴다)와 맨 아래에 놓을 때. */
function wireZone(zone) {
    zone.addEventListener('dragover', (e) => { if (!dragKey)
        return; e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget))
        zone.classList.remove('over'); });
    zone.addEventListener('drop', (e) => {
        if (!dragKey || e.target.closest('.v2-rail-it'))
            return;
        e.preventDefault();
        zone.classList.remove('over');
        dropped = true;
        placePin(dragKey, pins.length);
    });
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
    host.classList.add('closed'); // 격자는 늘 '아이콘 위 · 이름 아래' 하나다(232px 펼침 모드 폐기)
    document.getElementById('v2-root')?.classList.toggle('rail-hidden', hidden);
    // ⓪ 워크스페이스
    const top = el('div', { class: 'v2-rail-top' }, el('div', { class: 'v2-rail-ws' }, stackTile()));
    // ① 구역 — 아이콘 위, 이름 아래.
    const item = (key, label, ic, on, extra, onclick, href) => el(href ? 'a' : 'button', {
        class: 'v2-rail-it' + (on ? ' on' : ''), ...(href ? { href } : { type: 'button' }), 'data-key': key,
        'aria-current': on ? 'page' : null, title: label,
        onclick: (e) => { if (!href)
            e.preventDefault(); onclick(); },
    }, icon(ic, 'v2-rail-ic'), el('span', { class: 'v2-rail-t', text: label }), extra);
    const secEls = railSections().map((s) => {
        const on = !linkOn && section === s.key;
        //  확인할 것 — 슬랙 '내 활동'의 그 배지. 아이콘 귀퉁이에 숫자.
        const extra = s.key === 'inbox' && c.inbox
            ? el('span', { class: 'v2-rail-bd', text: String(c.inbox), role: 'img', 'aria-label': `확인할 것 ${c.inbox}건` })
            : null;
        return item(s.key, s.label, s.icon, on, extra, () => setRailSection(s.key, { navigate: true }));
    });
    const linkEls = LINKS.filter((l) => !l.tab || navOn(l.tab) !== false)
        .map((l) => item(l.key, l.label, l.icon, !!linkOn && linkOn.key === l.key, null, () => { location.hash = l.route; }, l.route));
    // ② 독 — 고정한 앱(사람이 정한 순서) | 최근 연 앱(자동). 둘 사이는 점선(맥 독의 최근 구간 경계).
    const appItem = (a, pinned) => {
        const it = item('app:' + a.key, a.title, a.icon, false, running.has(a.key) ? el('span', { class: 'v2-rail-run', role: 'img', 'aria-label': '실행 중' }) : null, () => { }, '#/app/' + a.key);
        it.classList.add(pinned ? 'pinned' : 'recent');
        it.dataset.app = a.key;
        it.setAttribute('draggable', 'true');
        it.title = a.title + (pinned ? ' — 독에 고정됨 · 끌어서 순서, 우클릭으로 빼기' : ' — 최근에 연 앱 · 우클릭으로 독에 고정');
        wireDock(it, a, pinned);
        return it;
    };
    const pinnedEls = pins.map((k) => APPS.find((a) => a.key === k)).filter((a) => !!a && (!a.tab || navOn(a.tab))).map((a) => appItem(a, true));
    const recentEls = recentForRail(RECENT_N).map((a) => appItem(a, false));
    const pinsZone = el('div', { class: 'v2-rail-pins', 'aria-label': '독에 고정한 앱' }, ...pinnedEls);
    wireZone(pinsZone);
    const mid = el('div', { class: 'v2-rail-mid' }, ...secEls, ...linkEls, el('div', { class: 'v2-rail-hr', role: 'presentation' }), pinsZone, pinnedEls.length && recentEls.length ? el('div', { class: 'v2-rail-hr v2-rail-hr--recent', role: 'presentation' }) : null, ...recentEls);
    // ③ 발치 — 앱 · 나 (슬랙의 ＋ · 아바타). 여닫는 단추는 여기 없다(머리말).
    const me = state.me || {};
    const myName = String(me.display_name || me.email || me.userId || '');
    const foot = el('footer', { class: 'v2-rail-foot' }, item('apps', '앱', 'apps', false, null, () => openLaunchpad()), el('button', {
        class: 'v2-rail-it v2-rail-me', type: 'button', 'aria-haspopup': 'dialog', title: '내 프로필 · 환경설정',
        onclick: () => openMeModal({ onSaved: () => drawRail() }),
    }, profileAvatar(me.avatar, myName, me.userId, 'v2-ava', { char: me.avatar_char, color: me.avatar_color }), el('span', { class: 'v2-rail-t', text: myName })));
    host.replaceChildren(top, mid, foot);
}
