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
//  · **홈은 고정 탭이 아니다**(상민님 2026-08-20). 맨 왼쪽에 못 닫는 홈을 박아 두면 늘 켜 두는 화면 하나가
//    자리를 먹고, 그 탭만 규칙이 달라(못 닫힘·못 끌림) 줄 전체가 두 문법이 된다. 홈은 사이드바 [새 작업]이
//    **새 탭으로** 여는 여느 화면이고, 그 탭에서 세션을 열면 그 자리가 곧 그 세션이 된다(브라우저 새 탭 문법).
//  · **탭 끌어 순서 바꾸기** — 모든 탭이 같은 자격이라 어느 것이든 끌어 옮긴다.
import { anchoredPopover, el, sv } from '../core.js';
import { EMBEDDED } from './embed.js';
const STORE_KEY = 'lively_v2_tabs';
//  ⚠ 끼워 넣은 판(미리보기 프레임 안)은 **탭을 기억하지도 기억되지도 않는다** — 미리보기도 주소가 같은
//   사이트라 저장소를 바깥과 공유한다. 복원하면 바깥이 보던 탭이 프레임 안에 통째로 되살아나 정작 보려던
//   화면이 안 뜨고(원준 2026-08-21 신고), 저장하면 바깥 사람의 탭 목록을 덮어쓴다. 자세한 배경은 embed.ts.
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
    // 줄은 두 겹이다(원준 2026-08-20 "[모든 탭] 단추가 다른 탭을 가린다"):
    //  · strip(.v2-tabs) — 자리만 잡는 바깥 틀. 모바일 상단 바가 통째로 옮겨 가는 것도 이 요소다.
    //  · scroll(.v2-tabs-scroll) — 탭이 눕고 **여기만 굴러간다**.
    //  · [모든 탭] 은 그 바깥에 붙는 **끝막이** — 종전엔 굴러가는 줄 안에 sticky 로 얹혀 있어 지나가는 탭을 덮었고,
    //    no-aside 모드의 오른쪽 여백(112px) 때문에 줄 끝이 아니라 어중간한 자리에 떠 있었다(실측: 1336px, 줄 끝 1500px).
    const strip = el('div', { class: 'v2-tabs' });
    const scroll = el('div', { class: 'v2-tabs-scroll', role: 'tablist', 'aria-label': '열린 화면' });
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
        if (EMBEDDED)
            return;
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
    // ── 연달아 닫기(원준 2026-08-20) ────────────────────────────────────────────
    //  탭은 남은 폭을 나눠 갖는다(flex 1 1 0). 그래서 하나 닫으면 나머지가 **즉시 넓어져** ×가 커서 밑에서 달아나고,
    //  같은 자리에서 두 번째를 닫으려면 매번 마우스를 다시 찾아가야 했다. 브라우저가 쓰는 방법을 그대로 쓴다 —
    //  **닫는 동안에는 탭 폭을 그대로 얼려 둔다**(그러면 오른쪽 탭이 방금 닫힌 자리로 정확히 미끄러져 들어와 ×가
    //  커서 밑에 그대로 온다). 얼음은 **줄에서 마우스가 벗어나면** 녹는다.
    let frozenW = null;
    function freezeWidths() {
        const one = scroll.querySelector('.v2-tab');
        if (one) {
            frozenW = Math.round(one.getBoundingClientRect().width);
            strip.classList.add('freeze');
        }
    }
    function thaw() {
        if (frozenW == null)
            return;
        frozenW = null;
        strip.classList.remove('freeze');
        paint();
    }
    strip.addEventListener('pointerleave', thaw);
    function close(tab) {
        const i = tabs.indexOf(tab);
        if (i < 0)
            return;
        freezeWidths();
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
        if (frozenW != null) {
            frozenW = null;
            strip.classList.remove('freeze');
        } // 탭이 늘면 언 폭은 의미가 없다
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
    //  '새 세션 자리'(kind='new')는 프로젝트 주소를 쓰지만 폴더가 아니라 **말풍선에 ＋** 다 — 그 탭에서 사람이 보는
    //  것은 프로젝트가 아니라 곧 열릴 세션이다(원준 2026-08-20).
    function icon(route, state, kind) {
        const k = routeKey(route);
        const d = kind === 'new' ? ['M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z', 'M12 9v5M9.5 11.5h5']
            : k === 'home' ? ['M4 11l8-7 8 7', 'M6 9.5V20h12V9.5']
                : k.startsWith('p:') ? ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z']
                    : k.startsWith('s:') ? ['M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z']
                        // 아카이브(상자)·휴지통(#1851) — 사이드바 발치의 두 행과 같은 글리프(side.ts glyph)
                        : k === 'raw:archive' ? ['M3 6h18v4H3z', 'M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9', 'M10 14h4']
                            : k === 'raw:trash' ? ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6M14 11v6']
                                : ['M4 5h16v12H4z', 'M4 9h16'];
        // 상태는 **아이콘 색**으로 말한다(원준 2026-08-20) — 도는 중 파랑 · 확인 필요 앰버 · 끝남 민트.
        //  글자·바탕은 '켜진 탭인가'만 말하므로 두 축이 섞이지 않는다.
        const st = state === 'busy' || state === 'wait' || state === 'done' ? ' st-' + state : '';
        return sv('svg', { viewBox: '0 0 24 24', class: 'v2-tab-ic' + st, 'aria-hidden': 'true' }, ...d.map((p) => sv('path', { d: p })));
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
        if (drag || editLocked() || e.button !== 0 || e.pointerType === 'touch')
            return;
        // ⚠ 탭 안의 단추(닫기 ×) 위에서 누른 것은 **끌기가 아니다**. 여기서 걸러 내지 않으면 pointerdown 이 탭으로
        //  버블링해 끌기가 시작되고, `setPointerCapture` 가 그 뒤의 click 을 탭 노드로 가져간다 — 그래서 ×의 onclick 이
        //  영영 안 불리고 **눌러도 탭이 안 닫혔다**(원준 2026-08-20 신고: 지식 탭 × 가 먹지 않음). 이름 편집칸이
        //  `onpointerdown: stopPropagation` 으로 자기를 지키는 것과 같은 방어를, 단추 쪽은 여기 한 곳에서 한다.
        if (e.target?.closest('button'))
            return;
        // 순서 계산은 **모든 탭 기준**(다른 세션의 최신 판) + 탭 노드는 **굴러가는 안쪽 줄**에서 찾는다(끝막이 분리).
        const els = tabs.map((x) => scroll.querySelector('[data-tab="' + x.id + '"]'));
        if (els.some((n) => !n))
            return;
        const from = tabs.indexOf(t);
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
                tabs.splice(Math.max(0, Math.min(d.to, tabs.length)), 0, d.tab);
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
            // 줄에 눕는 이름은 **짧게** — 세션 이름이 한 문단인 경우가 흔하다(첫 지시가 그대로 이름이 된다).
            //  전문은 툴팁과 [모든 탭] 목록이 갖는다(정보를 버리지 않는다).
            const short = t.title.length > 26 ? t.title.slice(0, 26).trimEnd() + '…' : t.title;
            const on = t === activeTab;
            const node = el('div', {
                class: 'v2-tab' + (on ? ' on' : ''), role: 'tab', 'aria-selected': String(on),
                'data-tab': t.id,
                title: hooks.canRename && hooks.canRename(t) ? t.title + ' — 두 번 누르면 이름을 바꿉니다' : t.title,
                onclick: () => { if (dragJustMoved)
                    return; activate(t); },
                ondblclick: () => startRename(t, node),
                onpointerdown: (e) => beginDrag(t, node, e),
                // 가운데 클릭 = 닫기(브라우저 탭 문법)
                onauxclick: (e) => { if (e.button === 1) {
                    e.preventDefault();
                    close(t);
                } },
            }, icon(t.route, info.state, info.kind), el('span', { class: 't', text: short }), el('button', {
                class: 'x', type: 'button', 'aria-label': `「${t.title}」 탭 닫기`, title: '탭 닫기',
                onclick: (e) => { e.stopPropagation(); close(t); },
            }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-tab-xic', 'aria-hidden': 'true' }, sv('path', { d: 'M6 6l12 12M18 6L6 18' }))));
            // 닫는 중이면 폭을 얼린 값으로 고정한다(위 주석) — 오른쪽 탭이 방금 닫힌 자리로 그대로 미끄러져 온다.
            if (frozenW != null)
                node.style.flex = '0 0 ' + frozenW + 'px';
            return node;
        });
        // ＋(새 빈 탭)는 줄에 두지 않는다 — 새 탭을 여는 자리는 사이드바 맨 위 [새 작업] 하나다(같은 일을 두 곳에
        //  두면 어느 쪽이 정본인지 흐려진다). 세션은 그와 별개로 저절로 제 탭에서 열린다.
        // ── 탭이 많아지면(원준 2026-08-20 "이름이 제대로 안 보인다") ──────────────────
        //  ① 탭은 일정 폭 아래로는 줄지 않는다(CSS min-width) → 글자가 뭉개지는 대신 **줄이 굴러간다**.
        //  ② 활성 탭은 더 넓게 — 지금 보고 있는 것만은 늘 읽혀야 한다.
        //  ③ 그래도 다 안 보이므로 오른쪽 끝에 **[모든 탭]** 을 둔다: 전문 이름·상태로 찾아 누르고 거기서 닫을 수도 있다.
        //     (브라우저 탭의 ⌄ 목록과 같은 문법 — 줄 밖으로 밀린 탭이 사라진 것처럼 보이지 않게 하는 장치다.)
        const menuBtn = el('button', {
            class: 'v2-tab-menu', type: 'button', title: '열린 탭 전체를 목록으로 봅니다',
            'aria-label': `열린 탭 ${tabs.length}개 — 목록`,
            onclick: (e) => openTabMenu(e.currentTarget),
        }, el('span', { class: 'n', text: String(tabs.length) }), sv('svg', { viewBox: '0 0 24 24', class: 'v2-tab-ic', 'aria-hidden': 'true' }, sv('path', { d: 'M6 9l6 6 6-6' })));
        scroll.replaceChildren(...kids);
        strip.replaceChildren(scroll, menuBtn);
        // 탭이 줄 폭을 넘치면(모바일 상단 바·좁은 창) 활성 탭이 보이게 가로로만 굴린다 — 세로는 건드리지 않는다(nearest = 이미 보이면 0).
        const on = scroll.querySelector('.v2-tab.on');
        if (on && scroll.scrollWidth > scroll.clientWidth)
            on.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
    /** [모든 탭] — 전문 이름으로 찾아가는 목록. 줄에서 잘린 이름을 여기서는 통째로 본다. */
    function openTabMenu(anchor) {
        const list = el('div', { class: 'v2-tabpop-list' });
        const rows = [];
        let closePop = null;
        for (const t of tabs) {
            const info = hooks.titleFor(t.route);
            const row = el('div', { class: 'v2-tabpop-row' + (t === activeTab ? ' on' : '') }, el('button', { class: 'go', type: 'button', title: info.title,
                onclick: () => { closePop?.(); activate(t); } }, icon(t.route, info.state, info.kind), el('span', { class: 'n', text: info.title })), el('button', {
                class: 'x', type: 'button', 'aria-label': `「${info.title}」 닫기`, title: '이 탭 닫기',
                onclick: () => { closePop?.(); close(t); }
            }, sv('svg', { viewBox: '0 0 24 24', class: 'v2-tab-xic', 'aria-hidden': 'true' }, sv('path', { d: 'M6 6l12 12M18 6L6 18' }))));
            rows.push({ tab: t, node: row });
            list.append(row);
        }
        const find = el('input', { class: 'v2-tabpop-find', type: 'search', placeholder: '탭 찾기 — 이름 일부', 'aria-label': '탭 찾기' });
        find.addEventListener('input', () => {
            const q = find.value.trim().toLowerCase();
            for (const r of rows)
                r.node.hidden = !!q && !r.tab.title.toLowerCase().includes(q);
        });
        closePop = anchoredPopover(anchor, el('div', { class: 'v2-tabpop' }, el('p', { class: 'v2-tabpop-h', text: `열린 탭 ${tabs.length}개` }), ...(tabs.length > 8 ? [find] : []), list));
        if (tabs.length > 8)
            window.setTimeout(() => find.focus(), 0);
    }
    // 가로 줄에서 세로 휠은 쓸모가 없다 — 트랙패드·마우스 어느 쪽으로도 줄이 굴러가게 바꿔 준다.
    scroll.addEventListener('wheel', (e) => {
        if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY))
            return;
        if (scroll.scrollWidth <= scroll.clientWidth)
            return;
        e.preventDefault();
        scroll.scrollLeft += e.deltaY;
    }, { passive: false });
    // 저장된 탭 복원 — 라우트·제목만(내용은 처음 누를 때 그린다). 못 읽으면 빈 채로 시작.
    let restoredActive = 0;
    try {
        const st = EMBEDDED ? null : JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        if (st && Array.isArray(st.tabs)) {
            // ⚠ 복원에는 **중복 제거**가 필요하다 — 저장본에 같은 화면이 두 번 들어 있으면(옛 버그가 만든 잔재도) 그대로
            //  탭 두 개로 되살아나고, 그 뒤로는 find() 가 첫 번째만 잡으므로 둘째가 영영 남는다(원준 2026-08-20 신고).
            const seen = new Set();
            let want = -1;
            const wantIdx = Math.max(0, Number(st.active) || 0);
            st.tabs.slice(0, 12).forEach((t, i) => {
                if (!t || typeof t.route !== 'string')
                    return;
                const k = routeKey(t.route);
                if (seen.has(k))
                    return;
                seen.add(k);
                mkTab(t.route, typeof t.title === 'string' ? t.title : undefined);
                if (i === wantIdx)
                    want = tabs.length - 1;
            });
            restoredActive = Math.min(Math.max(0, want >= 0 ? want : 0), Math.max(0, tabs.length - 1));
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
