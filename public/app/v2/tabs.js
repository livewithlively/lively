// v2/tabs.ts — 셸 안 탭(#1719 상민님 2026-08-18: "여러 탭 띄우고 편리하게 이동, 탭은 프로젝트·대화창·메인·앱,
//  우측 사이드바 상태까지 같이 저장되고 바뀌어야 함").
//
//  ── 방식: DOM 유지형 ──
//  탭마다 가운데(center)·우패널(aside) 컨테이너 한 쌍을 만들어 **숨겼다 보였다** 한다(재렌더 없음).
//  그래서 전환이 즉시이고, 터미널 WS·대화 폴링·타임라인 스크롤·필터 같은 "우패널 뷰의 상태"가 통째로 보존된다 —
//  상태를 직렬화해 복원하는 게 아니라 DOM 이 곧 상태다(세션 대화창의 터미널 토글과 같은 원칙).
//
//  ── 규칙 ──
//  · 주소(hash)는 **활성 탭의 라우트**다 — 링크 클릭은 활성 탭 안에서 이동(브라우저 한 탭과 같은 문법).
//  · 같은 화면이 이미 다른 탭에 열려 있으면 새로 그리지 않고 **그 탭으로 간다**(한 세션 = 한 탭, #1598 의 셸 안 판 —
//    같은 세션 터미널을 두 번 붙이지 않는다).
//  · 탭 목록(라우트·제목)은 브라우저에 기억되고, 다시 열면 **게으르게**(처음 눌렀을 때) 그린다.
//  · 마지막 탭은 닫으면 홈으로 바뀐다(빈 셸을 만들지 않는다).
import { el, sv } from '../core.js';
const STORE_KEY = 'lively_v2_tabs';
/** 라우트 정규화 키 — 같은 화면인지 비교(홈의 '', '#/', '#/dashboard' 는 한 화면). */
export function routeKey(route) {
    const h = String(route || '').replace(/^#\/?/, '');
    const q = h.indexOf('?');
    const segs = (q >= 0 ? h.slice(0, q) : h).split('/').filter(Boolean);
    const p = segs[0] || '';
    if (!p || p === 'dashboard')
        return 'home';
    if (p === 'p' || p === 's' || p === 'app')
        return p + ':' + decodeURIComponent(segs[1] || '');
    return 'raw:' + h;
}
export function createTabs(centerHost, asideHost, hooks) {
    const tabs = [];
    let activeTab = null;
    let seq = 0;
    const strip = el('div', { class: 'v2-tabs', role: 'tablist', 'aria-label': '열린 화면' });
    function mkTab(route, title) {
        const t = {
            id: 'tab' + (++seq),
            route, title: title || hooks.titleFor(route).title, noAside: hooks.titleFor(route).noAside,
            center: el('div', { class: 'v2-tabpane', hidden: true }),
            aside: el('div', { class: 'v2-aside-pane', hidden: true }),
            rendered: false, chat: null, seq: 0,
        };
        centerHost.append(t.center);
        asideHost.append(t.aside);
        tabs.push(t);
        return t;
    }
    function save() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify({
                tabs: tabs.map((t) => ({ route: t.route, title: t.title })),
                active: activeTab ? tabs.indexOf(activeTab) : 0,
            }));
        }
        catch (_) { /* noop */ }
    }
    function activate(tab) {
        if (activeTab === tab)
            return;
        for (const t of tabs) {
            t.center.hidden = t !== tab;
            t.aside.hidden = t !== tab;
        }
        activeTab = tab;
        const fresh = !tab.rendered;
        tab.rendered = true;
        hooks.onActivate(tab, fresh);
        paint();
        save();
    }
    function close(tab) {
        const i = tabs.indexOf(tab);
        if (i < 0)
            return;
        tabs.splice(i, 1);
        hooks.onClose(tab);
        tab.center.remove();
        tab.aside.remove();
        if (activeTab === tab) {
            activeTab = null;
            const next = tabs[Math.min(i, tabs.length - 1)] || add('#/', { activate: false });
            activate(next);
        }
        else {
            paint();
            save();
        }
    }
    function add(route, opts) {
        const t = mkTab(route, opts?.title);
        if (opts?.activate !== false)
            activate(t);
        else {
            paint();
            save();
        }
        return t;
    }
    // 탭 아이콘 — 사이드바와 같은 붓(24 뷰박스·현재색 스트로크). 홈/프로젝트/세션/앱이 모양으로 갈린다.
    function icon(route) {
        const k = routeKey(route);
        const d = k === 'home' ? ['M4 11l8-7 8 7', 'M6 9.5V20h12V9.5']
            : k.startsWith('p:') ? ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z']
                : k.startsWith('s:') ? ['M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z']
                    : ['M4 5h16v12H4z', 'M4 9h16'];
        return sv('svg', { viewBox: '0 0 24 24', class: 'v2-tab-ic', 'aria-hidden': 'true' }, ...d.map((p) => sv('path', { d: p })));
    }
    function paint() {
        const kids = tabs.map((t) => {
            const info = hooks.titleFor(t.route);
            t.title = info.title;
            t.noAside = info.noAside;
            const on = t === activeTab;
            return el('div', {
                class: 'v2-tab' + (on ? ' on' : ''), role: 'tab', 'aria-selected': String(on), title: t.title,
                onclick: () => activate(t),
                // 가운데 클릭 = 닫기(브라우저 탭 문법)
                onauxclick: (e) => { if (e.button === 1) {
                    e.preventDefault();
                    close(t);
                } },
            }, icon(t.route), el('span', { class: 't', text: t.title }), el('button', {
                class: 'x', type: 'button', 'aria-label': `「${t.title}」 탭 닫기`, title: '탭 닫기',
                onclick: (e) => { e.stopPropagation(); close(t); },
            }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-tab-xic', 'aria-hidden': 'true' }, sv('path', { d: 'M6 6l12 12M18 6L6 18' }))));
        });
        kids.push(el('button', {
            class: 'v2-tab-add', type: 'button', 'aria-label': '새 탭', title: '새 탭 — 홈이 열립니다',
            onclick: () => add('#/'),
        }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-tab-ic', 'aria-hidden': 'true' }, sv('path', { d: 'M12 5v14M5 12h14' }))));
        strip.replaceChildren(...kids);
        // 탭이 줄 폭을 넘치면(모바일 상단 바·좁은 창) 활성 탭이 보이게 가로로만 굴린다 — 세로는 건드리지 않는다(nearest = 이미 보이면 0).
        const on = strip.querySelector('.v2-tab.on');
        if (on && strip.scrollWidth > strip.clientWidth)
            on.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
    // 저장된 탭 복원 — 라우트·제목만(내용은 처음 누를 때 그린다). 못 읽으면 빈 채로 시작.
    let restoredActive = 0;
    try {
        const st = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        if (st && Array.isArray(st.tabs)) {
            for (const t of st.tabs.slice(0, 12)) {
                if (t && typeof t.route === 'string')
                    mkTab(t.route, typeof t.title === 'string' ? t.title : undefined);
            }
            restoredActive = Math.min(Math.max(0, Number(st.active) || 0), tabs.length - 1);
        }
    }
    catch (_) { /* noop */ }
    const api = {
        strip, tabs,
        active: () => { if (!activeTab)
            activate(tabs[restoredActive] || mkTab('#/')); return activeTab; },
        current: () => activeTab,
        add, activate,
        routed: (tab) => { const info = hooks.titleFor(tab.route); tab.title = info.title; tab.noAside = info.noAside; paint(); save(); },
        find: (route) => tabs.find((t) => routeKey(t.route) === routeKey(route)),
        initial: () => tabs[restoredActive] || null,
        paint, save,
    };
    return api;
}
