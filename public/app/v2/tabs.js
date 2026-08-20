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
//  · **홈 탭은 하나뿐, 늘 맨 왼쪽, 못 닫는다**(원준 2026-08-20). 홈에서 무언가를 열면 홈이 그리로 가는 게 아니라
//    **새 탭**이 생긴다 — 그래서 홈은 언제 돌아와도 홈이고, '＋ 눌러 빈 탭부터 만들기'가 필요 없다.
//  · **탭 끌어 순서 바꾸기** — 홈은 제자리(0번)에 고정이라 끌리지도, 그 앞에 놓이지도 않는다.
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
            rendered: false, chat: null, seq: 0, fixed: false,
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
        if (tab.fixed)
            return; // 홈은 닫히지 않는다(닫기 버튼도 안 그린다 — 여기는 가운데클릭·단축키 대비 이중 잠금)
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
    let drag = null;
    let dragJustMoved = false; // 끌고 난 직후의 click 은 탭 전환이 아니다
    function clearDragStyles(d) {
        for (const n of d.els) {
            n.style.transform = '';
            n.style.transition = '';
        }
        d.el.classList.remove('dragging');
        strip.classList.remove('dnd');
    }
    function beginDrag(t, node, e) {
        if (drag || editLocked() || t.fixed || e.button !== 0 || e.pointerType === 'touch')
            return;
        const movable = tabs.filter((x) => !x.fixed);
        const els = movable.map((x) => strip.querySelector('[data-tab="' + x.id + '"]'));
        if (els.some((n) => !n))
            return;
        const from = movable.indexOf(t);
        if (from < 0)
            return;
        const rects = els.map((n) => n.getBoundingClientRect());
        // 이웃이 비켜 줄 거리 = 잡은 탭의 폭 + 탭 사이 간격(줄에서 실측 — 폭이 제각각이라 상수로 두면 어긋난다).
        const gap = rects.length > 1 ? Math.max(0, Math.round(rects[1].left - rects[0].right)) : 3;
        drag = { tab: t, el: node, startX: e.clientX, pointerId: e.pointerId, moved: false, from, to: from, els, rects, step: rects[from].width + gap };
        try {
            node.setPointerCapture(e.pointerId);
        }
        catch (_) { /* noop */ }
    }
    function onDragMove(e) {
        const d = drag;
        if (!d || e.pointerId !== d.pointerId)
            return;
        const dx = e.clientX - d.startX;
        if (!d.moved) {
            if (Math.abs(dx) < 4)
                return; // 손떨림은 클릭이다
            d.moved = true;
            strip.classList.add('dnd'); // 이 클래스가 붙어 있는 동안만 이웃이 미끄러진다
            d.el.classList.add('dragging');
        }
        d.el.style.transform = 'translateX(' + dx + 'px)';
        const c = d.rects[d.from].left + d.rects[d.from].width / 2 + dx;
        let to = d.from;
        for (let i = 0; i < d.rects.length; i++) {
            if (i === d.from)
                continue;
            const mid = d.rects[i].left + d.rects[i].width / 2;
            if (i > d.from && c > mid)
                to = Math.max(to, i);
            if (i < d.from && c < mid)
                to = Math.min(to, i);
        }
        d.to = to;
        for (let i = 0; i < d.els.length; i++) {
            if (i === d.from)
                continue;
            const shift = (i > d.from && i <= to) ? -d.step : (i < d.from && i >= to) ? d.step : 0;
            d.els[i].style.transform = shift ? 'translateX(' + shift + 'px)' : '';
        }
    }
    function endDrag(e) {
        const d = drag;
        if (!d || (e && e.pointerId !== d.pointerId))
            return;
        drag = null;
        try {
            d.el.releasePointerCapture(d.pointerId);
        }
        catch (_) { /* noop */ }
        if (!d.moved) {
            clearDragStyles(d);
            return;
        }
        dragJustMoved = true;
        const land = d.to === d.from ? 0
            : d.to > d.from ? (d.rects[d.to].right - d.rects[d.from].right)
                : (d.rects[d.to].left - d.rects[d.from].left);
        d.el.style.transition = 'transform .16s ease';
        d.el.style.transform = 'translateX(' + land + 'px)';
        window.setTimeout(() => {
            const cur = tabs.indexOf(d.tab);
            if (cur >= 0 && d.to !== d.from) {
                tabs.splice(cur, 1);
                tabs.splice(Math.max(1, Math.min(1 + d.to, tabs.length)), 0, d.tab); // 0번(홈) 앞자리는 없다
                save();
            }
            clearDragStyles(d);
            paint();
            window.setTimeout(() => { dragJustMoved = false; }, 0);
        }, d.to === d.from ? 0 : 170);
    }
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    // ── 탭 이름 두 번 눌러 고치기(원준 2026-08-20) — 세션 탭만.
    //  20초 폴링이 입력 중인 칸을 지우지 않게, 고치는 동안 paint 를 멈춘다(session-chat 의 renaming 과 같은 규칙).
    let editing = null;
    let editEl = null;
    //  ⚠ 잠금은 **화면에 살아 있는 입력칸**에만 걸린다. 편집칸이 DOM 에서 떨어져 나가면(탭 줄이 통째로 옮겨가는
    //   모바일 전환, 닫힌 탭, 바깥 재렌더) blur 도 Esc 도 오지 않아 잠금이 영영 안 풀린다 —
    //   그러면 paint 가 멈춰 탭 줄이 굳고 끌기도 안 걸린다(실측: dev 에서 탭 줄이 굳어 드래그가 시작되지 않았다).
    function editLocked() {
        if (!editing)
            return false;
        if (editEl && editEl.isConnected)
            return true;
        editing = null;
        editEl = null;
        return false;
    }
    function startRename(t, node) {
        if (editLocked() || drag || !hooks.canRename || !hooks.canRename(t) || !hooks.onRename)
            return;
        if (!node.isConnected)
            return; // 이미 갈아치워진 옛 노드에는 편집칸을 열지 않는다
        const label = node.querySelector('.t');
        if (!label)
            return;
        editing = t;
        const input = el('input', { class: 'v2-tab-in', type: 'text', maxlength: '80', value: t.title, 'aria-label': '세션 이름', spellcheck: 'false' });
        let closed = false;
        const done = () => { editing = null; editEl = null; paint(); };
        const cancel = () => { if (closed)
            return; closed = true; done(); };
        const commit = async () => {
            if (closed)
                return;
            const to = input.value.replace(/\s+/g, ' ').trim();
            if (!to || to === t.title) {
                cancel();
                return;
            }
            closed = true;
            input.disabled = true;
            try {
                await hooks.onRename(t, to);
            }
            catch (_) { /* 알림은 호출자가 냈다 */ }
            done();
        };
        input.onkeydown = (ev) => {
            if (ev.isComposing)
                return; // 한글 조합 중 Enter 는 확정이지 저장이 아니다
            if (ev.key === 'Enter') {
                ev.preventDefault();
                void commit();
            }
            else if (ev.key === 'Escape') {
                ev.preventDefault();
                cancel();
            }
        };
        input.onblur = () => { void commit(); };
        input.onpointerdown = (ev) => ev.stopPropagation(); // 고치는 중엔 끌기가 시작되지 않게
        input.onclick = (ev) => ev.stopPropagation();
        editEl = input;
        label.replaceWith(input);
        input.focus();
        input.select();
    }
    function paint() {
        if (drag || editLocked())
            return; // 끌거나 고치는 중에 다시 그리면 그 동작이 끊긴다(20초 폴링도 paint 를 부른다)
        const kids = tabs.map((t) => {
            const info = hooks.titleFor(t.route);
            t.title = info.title;
            t.noAside = info.noAside;
            const on = t === activeTab;
            const node = el('div', {
                class: 'v2-tab' + (on ? ' on' : '') + (t.fixed ? ' fixed' : ''), role: 'tab', 'aria-selected': String(on),
                'data-tab': t.id,
                title: t.fixed ? t.title + ' — 늘 여기 있어요'
                    : (hooks.canRename && hooks.canRename(t) ? t.title + ' — 두 번 누르면 이름을 바꿉니다' : t.title),
                onclick: () => { if (dragJustMoved)
                    return; activate(t); },
                ondblclick: () => startRename(t, node),
                onpointerdown: (e) => beginDrag(t, node, e),
                // 가운데 클릭 = 닫기(브라우저 탭 문법)
                onauxclick: (e) => { if (e.button === 1) {
                    e.preventDefault();
                    close(t);
                } },
            }, icon(t.route), el('span', { class: 't', text: t.title }), 
            // 홈은 닫기 단추가 없다 — 지울 수 없는 자리라는 걸 생김새가 먼저 말한다.
            ...(t.fixed ? [] : [el('button', {
                    class: 'x', type: 'button', 'aria-label': `「${t.title}」 탭 닫기`, title: '탭 닫기',
                    onclick: (e) => { e.stopPropagation(); close(t); },
                }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-tab-xic', 'aria-hidden': 'true' }, sv('path', { d: 'M6 6l12 12M18 6L6 18' })))]));
            return node;
        });
        // ＋(새 빈 탭)는 없앴다 — 홈이 하나뿐이라 ＋ 는 홈 복제밖에 못 하고, 세션은 이제 저절로 제 탭에서 열린다.
        //  '새 탭에서 시작하기'는 홈 탭(맨 왼쪽)에서 무엇이든 열면 된다(홈은 늘 홈으로 남고 새 탭이 생긴다).
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
    // 홈 탭 보장 — 하나만, 맨 왼쪽, 고정. 저장본이 홈을 여러 개 들고 있어도 하나로 접는다.
    {
        const want = tabs[restoredActive] || null;
        const homes = tabs.filter((t) => routeKey(t.route) === 'home');
        let home = homes[0];
        for (const dup of homes.slice(1)) {
            const i = tabs.indexOf(dup);
            if (i >= 0)
                tabs.splice(i, 1);
            dup.center.remove();
            dup.aside.remove();
        }
        if (home) {
            const i = tabs.indexOf(home);
            if (i >= 0)
                tabs.splice(i, 1);
        }
        else {
            home = mkTab('#/');
            tabs.pop();
        }
        home.route = '#/';
        home.fixed = true;
        tabs.unshift(home);
        restoredActive = want && tabs.indexOf(want) >= 0 ? tabs.indexOf(want) : 0;
    }
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
