// v2/panes.ts — **프로젝트 화면 = 세션 화면**(#1719 원준 2026-08-20). 새 셸의 유일한 작업 화면이다.
//
//  ── 왜 이 모양인가 ──
//  앞선 캔버스(v2/studio.ts, 2026-08-20 폐기 — 지식 canvas-view-retired-1719)는 **빈 판에서 시작해 사람이 위젯을
//  올려야** 채워졌다. 그게 처음 보는 사람에게는 "프로젝트마다 설정할 게 너무 많고, 공간은 텅 비어 있다"로 읽혔다.
//  이 화면의 규칙은 정확히 그 반대다:
//   ① **들어오면 이미 채워져 있다** — 왼쪽은 세션, 오른쪽은 자료·지식. 아무것도 안 해도 일이 보인다.
//   ② **배치는 프로젝트마다가 아니라 한 벌뿐이다**(localStorage 전역) — 한 번 맞춰 두면 모든 프로젝트가 그 모양이다.
//      캔버스는 프로젝트마다 판을 따로 기억한다. 그 차이가 '설정할 게 많다'의 실체였다.
//   ③ 자유배치가 아니라 **도킹 분할**(VS Code·Cursor 문법) — 칸의 경계를 끌어 크기를 바꾸고, 탭을 끌어 칸을 옮긴다.
//      아무 데나 놓을 수 없다는 제약이 곧 '아무것도 안 해도 되는' 기본값을 가능하게 한다.
//
//  ── 구도 ──
//   문패(door) — 프로젝트 이름·요약, 오른쪽에 [칸] · [설정].
//   가운데 칸(main) — 기본 [세션]. 위는 **지금 보는 세션의 화면 그 자체**, 아래는 세션 서랍.
//   아래 칸(bottom) — 기본 닫힘. 열면 main 아래에 붙는다(타임라인·할 일 자리).
//   곁칸(side) — 기본 [자료][지식] 탭. 경계를 끌어 폭 조절, [칸]에서 접을 수 있다.
//
//  ── ★ 프로젝트 화면과 세션 화면은 하나다(원준 2026-08-20) ──
//  종전엔 `#/p/<id>`(프로젝트)와 `#/s/<sid>`(세션)가 서로 다른 화면이었다. 이제 **주소는 늘 세션**이고,
//  프로젝트는 그 세션이 놓인 방일 뿐이다 — `#/p/<id>` 로 들어오면 라우터가 그 프로젝트 맨 위 세션으로 보낸다.
//  서랍에서 세션을 갈아 끼울 때 이 셸은 다시 그리지 않는다(자료·지식·문패가 그대로 산다) — 주소만 바뀐다.
//
//  이 파일이 모르는 것: 각 칸에 들어가는 내용(v2/panes-parts.ts) · 프로젝트 설정 창(v2/proj-settings.ts).
import { anchoredPopover, api, el, personFace, toast } from '../core.js';
import { confirmSessionArchive, confirmSessionHideTab } from '../session-actions.js';
import { makeSplitter } from './split.js';
import { PART_DEFS, hiddenSessions, hideSession, lookupSessNames, makePart, partDef, pnIcon, sessTitle } from './panes-parts.js';
import { openProjSettings } from './proj-settings.js';
import { dotCls } from './views.js';
const LAYOUT_KEY = 'lively_panes_layout_v1';
const DEF_LAYOUT = () => ({
    main: ['sessions'], side: ['files', 'knowledge'], bottom: ['timeline'],
    act: { main: 'sessions', side: 'files', bottom: 'timeline' },
    sideOn: true, bottomOn: false,
});
const ALL = new Set(PART_DEFS.map((d) => d.type));
function loadLayout() {
    try {
        const s = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
        if (!s || typeof s !== 'object')
            return DEF_LAYOUT();
        const arr = (v) => (Array.isArray(v) ? v.filter((x) => ALL.has(x)) : []);
        const d = DEF_LAYOUT();
        const lay = {
            main: arr(s.main), side: arr(s.side), bottom: arr(s.bottom),
            act: {
                main: ALL.has(s.act?.main) ? s.act.main : null,
                side: ALL.has(s.act?.side) ? s.act.side : null,
                bottom: ALL.has(s.act?.bottom) ? s.act.bottom : null,
            },
            sideOn: s.sideOn !== false, bottomOn: !!s.bottomOn,
        };
        // 저장된 배치가 모든 칸에서 비었으면(옛 판·손상) 기본으로 — 빈 화면을 보여 주는 것보다 낫다.
        if (!lay.main.length && !lay.side.length && !lay.bottom.length)
            return d;
        return lay;
    }
    catch (_) {
        return DEF_LAYOUT();
    }
}
export function mountPanes(host, opts) {
    const id = opts.id;
    const loose = id === 0; // 프로젝트 없는 세션들의 화면 — 공유 폴더·지식·할 일이 없다
    let detail = opts.detail;
    let dead = false;
    let lay = loadLayout();
    // 프로젝트 없는 세션 화면 — 공유 폴더·지식·할 일이 없으니 곁칸에 넣을 것도 없다. 빈 칸을 보여 주느니 접어 둔다.
    if (loose) {
        lay = { ...lay, side: lay.side.filter((t) => t === 'timeline'), bottom: [], bottomOn: false, sideOn: false };
    }
    function saveLayout() {
        if (loose)
            return; // 자투리 화면의 임시 배치를 정본으로 굳히지 않는다
        try {
            localStorage.setItem(LAYOUT_KEY, JSON.stringify(lay));
        }
        catch (_) { /* noop */ }
    }
    const pj = () => (loose ? { id: 0, name: '프로젝트 없는 세션' } : (detail && detail.project) || { id, name: '프로젝트 #' + id });
    const ctx = {
        id,
        data: opts.data,
        detail: () => detail,
        dead: () => dead,
        onChanged: () => { void refreshDetail(); opts.onProjectChanged?.(); },
        openSettings: () => openSettings(),
        sessionId: opts.sessionId || null,
        onSessionPicked: (sid) => { opts.onSessionPicked?.(sid); paintDoor(); },
        mountSession: opts.mountSession,
    };
    // ── 골격 ──
    const door = el('header', { class: 'pn-door' });
    const colMain = el('div', { class: 'pn-col' });
    const body = el('div', { class: 'pn-body' });
    const wrap = el('div', { class: 'pn-wrap' }, door, body);
    host.replaceChildren(wrap);
    const panes = new Map();
    function makePane(zone) {
        const tabs = el('div', { class: 'pn-tabs', role: 'tablist' });
        const bodyEl = el('div', { class: 'pn-pane-body' });
        const root = el('section', { class: 'pn-pane', 'data-zone': zone }, tabs, bodyEl);
        const p = { zone, root, tabs, bodyEl, parts: new Map() };
        // 탭을 끌어 이 칸에 떨구면 그 부품이 여기로 옮겨 온다(VS Code 의 탭 도킹).
        tabs.addEventListener('dragover', (e) => {
            if (!e.dataTransfer?.types.includes('text/x-pn-part'))
                return;
            e.preventDefault();
            tabs.classList.add('drop');
        });
        tabs.addEventListener('dragleave', () => tabs.classList.remove('drop'));
        tabs.addEventListener('drop', (e) => {
            tabs.classList.remove('drop');
            const raw = e.dataTransfer?.getData('text/x-pn-part') || '';
            if (!raw)
                return;
            e.preventDefault();
            let msg;
            try {
                msg = JSON.parse(raw);
            }
            catch (_) {
                return;
            }
            moveTab(msg.type, msg.from, zone);
        });
        panes.set(zone, p);
        return p;
    }
    const mainPane = makePane('main');
    const bottomPane = makePane('bottom');
    const sidePane = makePane('side');
    // 세로 경계(가운데|곁칸) · 가로 경계(가운데|아래 칸) — 폭·높이는 split.ts 가 기억한다.
    const splitX = makeSplitter({ axis: 'x', key: 'panes_side', cssVar: '--pn-side-w', target: body, def: 340, min: 220, max: 620, grow: -1, label: '곁칸 너비' });
    const splitY = makeSplitter({ axis: 'y', key: 'panes_bottom', cssVar: '--pn-bottom-h', target: colMain, def: 240, min: 120, max: 560, grow: -1, label: '아래 칸 높이' });
    colMain.append(mainPane.root, splitY, bottomPane.root);
    body.append(colMain, splitX, sidePane.root);
    // ── 탭 ──
    function ensurePart(pane, type) {
        let p = pane.parts.get(type);
        if (!p) {
            p = makePart(type, ctx);
            pane.parts.set(type, p);
            pane.bodyEl.append(p.root);
        }
        return p;
    }
    function activate(zone, type) {
        lay.act[zone] = type;
        saveLayout();
        paintPane(zone);
    }
    function addTab(zone, type) {
        const list = lay[zone];
        if (!list.includes(type))
            list.push(type);
        lay.act[zone] = type;
        if (zone === 'side')
            lay.sideOn = true;
        if (zone === 'bottom')
            lay.bottomOn = true;
        saveLayout();
        paintAll();
    }
    function removeTab(zone, type) {
        const list = lay[zone];
        const i = list.indexOf(type);
        if (i < 0)
            return;
        list.splice(i, 1);
        const pane = panes.get(zone);
        const part = pane.parts.get(type);
        if (part) {
            part.destroy?.();
            part.root.remove();
            pane.parts.delete(type);
        }
        if (lay.act[zone] === type)
            lay.act[zone] = list[Math.max(0, i - 1)] || null;
        saveLayout();
        paintAll();
    }
    function moveTab(type, from, to) {
        if (from === to) {
            activate(to, type);
            return;
        }
        removeTab(from, type);
        addTab(to, type);
    }
    function tabEl(zone, type, on) {
        const d = partDef(type);
        const b = el('button', {
            class: 'pn-tab' + (on ? ' on' : ''), type: 'button', role: 'tab',
            'aria-selected': String(on), title: d.hint, draggable: 'true',
            onclick: () => activate(zone, type),
        }, pnIcon(d.icon, 'pn-i sm'), el('span', { text: d.name }));
        b.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData('text/x-pn-part', JSON.stringify({ type, from: zone }));
            if (e.dataTransfer)
                e.dataTransfer.effectAllowed = 'move';
            b.classList.add('drag');
        });
        b.addEventListener('dragend', () => b.classList.remove('drag'));
        const x = el('button', {
            class: 'pn-tab-x', type: 'button', title: `${d.name} 칸에서 뺍니다`, 'aria-label': `${d.name} 빼기`,
            onclick: (e) => { e.stopPropagation(); removeTab(zone, type); },
        }, pnIcon('x', 'pn-i xs'));
        return el('span', { class: 'pn-tabwrap' + (on ? ' on' : '') }, b, x);
    }
    function addBtn(zone) {
        const b = el('button', { class: 'pn-tab-add', type: 'button', title: '이 칸에 내용을 더합니다', 'aria-label': '내용 더하기' }, pnIcon('plus', 'pn-i sm'));
        b.onclick = () => {
            const rest = PART_DEFS.filter((d) => !lay[zone].includes(d.type) && !(loose && (d.type === 'files' || d.type === 'knowledge' || d.type === 'tasks' || d.type === 'overview' || d.type === 'liv')));
            const close = anchoredPopover(b, el('div', { class: 'pn-pop' }, el('p', { class: 'pn-pop-h', text: '이 칸에 넣을 것을 고르세요.' }), rest.length ? el('div', { class: 'pn-pop-list' }, ...rest.map((d) => el('button', { class: 'pn-pop-row', type: 'button', onclick: () => { close(); addTab(zone, d.type); } }, pnIcon(d.icon, 'pn-i sm'), el('span', { class: 'n' }, el('b', { text: d.name }), el('span', { class: 'pn-fine', text: d.hint })))))
                : el('p', { class: 'pn-fine', text: '넣을 수 있는 것을 이미 다 넣었어요.' })));
        };
        return b;
    }
    /** 이 프로젝트의 세션 — 탭 줄에 눕히는 순서(답 기다림 → 도는 중 → 최근). */
    const mySessions = () => {
        const rank = (s) => (s.stateKey === 'waiting' ? 0 : s.stateKey === 'busy' ? 1 : s.live && s.alive ? 2 : 3);
        return opts.data().sessions
            .filter((s) => (loose ? !s.projectId : Number(s.projectId) === id))
            .sort((a, b) => rank(a) - rank(b) || (b.lastSeen || 0) - (a.lastSeen || 0));
    };
    const SESS_TAB_MAX = 40; // 탭 줄에 눕히는 상한 — 프로젝트 없는 세션 화면엔 수백 개가 몰린다(실측 188개)
    // ── 세션 탭 순서(원준 2026-08-20) ──────────────────────────────────────────
    //  기본 정렬은 상태순(답 기다림 → 도는 중 → 최근)이지만, 사람이 끌어 옮기면 **그 순서가 이긴다**.
    //  칸 배치와 마찬가지로 보기 취향이라 이 브라우저에 기억한다(프로젝트별 — 프로젝트마다 쓰는 세션이 다르다).
    const ORDER_KEY = 'pn_sess_order';
    const orderKeyOf = () => (loose ? 'loose' : String(id));
    function savedOrder() {
        try {
            const m = JSON.parse(localStorage.getItem(ORDER_KEY) || '{}');
            const a = m && m[orderKeyOf()];
            return Array.isArray(a) ? a.map(String) : [];
        }
        catch (_) {
            return [];
        }
    }
    function saveOrder(ids) {
        try {
            const m = JSON.parse(localStorage.getItem(ORDER_KEY) || '{}') || {};
            m[orderKeyOf()] = ids.slice(0, 200);
            localStorage.setItem(ORDER_KEY, JSON.stringify(m));
        }
        catch (_) { /* noop */ }
    }
    /** 저장된 순서를 앞에, 나머지(새로 생긴 세션)는 기존 규칙대로 뒤에. */
    function applyOrder(ss) {
        const ord = savedOrder();
        if (!ord.length)
            return ss;
        const rank = new Map(ord.map((x, i) => [x, i]));
        const placed = ss.filter((s) => rank.has(s.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
        return [...placed, ...ss.filter((s) => !rank.has(s.id))];
    }
    // 끌어 옮기기 — 셸 탭(tabs.ts)과 같은 크롬 문법: 잡은 탭은 커서를 따라오고 이웃은 그 폭만큼 미끄러진다.
    let sdrag = null;
    let sdragJustMoved = false;
    let sEditing = null;
    let sEditEl = null;
    const sEditLocked = () => {
        if (!sEditing)
            return false;
        if (sEditEl && sEditEl.isConnected)
            return true;
        sEditing = null;
        sEditEl = null;
        return false;
    };
    function clearSDrag(d) {
        for (const n of d.els) {
            n.style.transform = '';
            n.style.transition = '';
        }
        d.el.classList.remove('dragging');
        const strip = d.el.closest('.pn-tabs');
        if (strip)
            strip.classList.remove('dnd');
    }
    function beginSDrag(node, e) {
        if (sdrag || sEditLocked() || e.button !== 0 || e.pointerType === 'touch')
            return;
        const strip = node.closest('.pn-tabs');
        if (!strip)
            return;
        const els = Array.from(strip.querySelectorAll('[data-sess]'));
        const from = els.indexOf(node);
        if (from < 0 || els.length < 2)
            return;
        const rects = els.map((n) => n.getBoundingClientRect());
        const gap = rects.length > 1 ? Math.max(0, Math.round(rects[1].left - rects[0].right)) : 3;
        sdrag = { el: node, startX: e.clientX, pointerId: e.pointerId, moved: false, from, to: from, els, rects, step: rects[from].width + gap };
        try {
            node.setPointerCapture(e.pointerId);
        }
        catch (_) { /* noop */ }
    }
    function onSDragMove(e) {
        const d = sdrag;
        if (!d || e.pointerId !== d.pointerId)
            return;
        const dx = e.clientX - d.startX;
        if (!d.moved) {
            if (Math.abs(dx) < 4)
                return; // 손떨림은 클릭이다
            d.moved = true;
            d.el.classList.add('dragging');
            const strip = d.el.closest('.pn-tabs');
            if (strip)
                strip.classList.add('dnd');
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
    function endSDrag(e) {
        const d = sdrag;
        if (!d || (e && e.pointerId !== d.pointerId))
            return;
        sdrag = null;
        try {
            d.el.releasePointerCapture(d.pointerId);
        }
        catch (_) { /* noop */ }
        if (!d.moved) {
            clearSDrag(d);
            return;
        }
        sdragJustMoved = true;
        const land = d.to === d.from ? 0
            : d.to > d.from ? (d.rects[d.to].right - d.rects[d.from].right)
                : (d.rects[d.to].left - d.rects[d.from].left);
        d.el.style.transition = 'transform .16s ease';
        d.el.style.transform = 'translateX(' + land + 'px)';
        window.setTimeout(() => {
            const ids = d.els.map((n) => String(n.dataset.sess || ''));
            const moved = ids.splice(d.from, 1)[0];
            ids.splice(Math.max(0, Math.min(d.to, ids.length)), 0, moved);
            saveOrder(ids);
            clearSDrag(d);
            paintPane('main');
            window.setTimeout(() => { sdragJustMoved = false; }, 0);
        }, d.to === d.from ? 0 : 170);
    }
    window.addEventListener('pointermove', onSDragMove);
    window.addEventListener('pointerup', endSDrag);
    window.addEventListener('pointercancel', endSDrag);
    /** 세션 탭 이름 고치기 — 여기서 고치면 서버에 저장되어 사이드바·셸 탭·세션 머리줄이 함께 바뀐다. */
    function startSessRename(s, wrap, shown) {
        if (sEditLocked() || sdrag || !opts.onRenameSession || !s.owned || !wrap.isConnected)
            return;
        const label = wrap.querySelector('.ell');
        if (!label)
            return;
        sEditing = s.id;
        const input = el('input', { class: 'pn-stab-in', type: 'text', maxlength: '80', value: String(s.label || shown), 'aria-label': '세션 이름', spellcheck: 'false' });
        let closed = false;
        const done = () => { sEditing = null; sEditEl = null; paintPane('main'); };
        const cancel = () => { if (closed)
            return; closed = true; done(); };
        const commit = async () => {
            if (closed)
                return;
            const to = input.value.replace(/\s+/g, ' ').trim();
            if (!to || to === s.label) {
                cancel();
                return;
            }
            closed = true;
            input.disabled = true;
            try {
                await opts.onRenameSession(s.id, to);
                toast('세션 이름을 바꿨어요.');
            }
            catch (e) {
                toast('이름을 바꾸지 못했어요 — ' + (e && e.message ? e.message : e), true);
            }
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
        input.onpointerdown = (ev) => ev.stopPropagation();
        input.onclick = (ev) => ev.stopPropagation();
        sEditEl = input;
        label.replaceWith(input);
        input.focus();
        input.select();
    }
    /** 세션 탭 하나 — 상태점 + 이름 + ×(보관).
     *  ⚠ ×는 '화면 닫기'가 아니라 **세션 보관**이다(원준 2026-08-20): 돌던 터미널을 내리고 대화·설정은 남겨
     *   [보관한 세션]에서 되살릴 수 있게 한다. 돌고 있는 AI 를 멈추는 동작이라 확인창을 반드시 거친다.
     *   내 세션이고 살아 있을 때만 보인다 — 남의 세션은 못 내리고, 이미 끝난 세션은 보관할 것이 없다. */
    function sessTab(s, on, part) {
        const t = sessTitle(s, String(pj().name || ''));
        const wrap = el('span', { class: 'pn-tabwrap' + (on ? ' on' : ''), 'data-sess': s.id });
        const b = el('button', {
            class: 'pn-tab pn-stab' + (on ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': String(on),
            title: t + ' — ' + s.stateLabel + (s.owned ? ' · 두 번 누르면 이름을 바꿉니다' : ''),
            onclick: () => { if (sdragJustMoved)
                return; part.selectSession?.(s.id); paintPane('main'); },
            ondblclick: () => startSessRename(s, wrap, t),
        }, el('span', { class: 'v2-dot ' + dotCls(s.stateKey), 'aria-hidden': 'true' }), el('span', { class: 'ell', text: t }));
        // ×는 **모든 세션 탭**에 있다(원준 2026-08-20 "탭을 닫을 수가 없음"). 하는 일이 상태에 따라 갈릴 뿐이다:
        //  · 살아 있는 내 세션 → 확인창 뒤 **보관**(터미널을 내리고 대화·설정은 남긴다) + 탭에서 치움.
        //  · 그 밖(끝난 세션·남의 세션) → 내릴 터미널이 없으니 **탭에서만 치운다**. 둘 다 [보관한 세션]에 남는다.
        const canArchive = s.owned && s.live && s.alive;
        const x = el('button', {
            class: 'pn-tab-x', type: 'button',
            title: canArchive ? '이 세션을 보관합니다 — 대화는 남고, [보관한 세션]에서 되살릴 수 있어요.'
                : '탭에서 치웁니다 — 세션은 [보관한 세션]에 그대로 있어요.',
            'aria-label': canArchive ? `「${t}」 세션 보관` : `「${t}」 탭 치우기`,
            onclick: (e) => { e.stopPropagation(); void closeSessTab(s, t, part); },
        }, pnIcon('x', 'pn-i xs'));
        wrap.addEventListener('pointerdown', (e) => beginSDrag(wrap, e));
        wrap.append(b, x);
        return wrap;
    }
    /** 탭 × — 살아 있는 내 세션이면 보관까지, 아니면 보기에서만 치운다. 치운 뒤 보던 탭이면 옆 탭으로 옮겨 준다. */
    async function closeSessTab(s, name, part) {
        if (s.owned && s.live && s.alive) {
            if (!await archiveSess(s, name))
                return;
        }
        // 끝난 세션·남의 세션 — 잃는 것이 없지만, ×를 '영영 지움'으로 읽는 사람이 많아 처음 한 번은 무슨 일이 일어나는지 보여 준다.
        else if (!await confirmSessionHideTab({ title: `「${name}」 탭을 치울까요?` }))
            return;
        hideSession(s.id);
        if (part.currentSession?.() === s.id) {
            const next = mySessions().find((x) => x.id !== s.id && !hiddenSessions().has(x.id));
            part.selectSession?.(next ? next.id : null);
        }
        if (!(s.owned && s.live && s.alive))
            toast('탭에서 치웠어요 — [보관한 세션]에 그대로 있어요.');
        paintPane('main');
    }
    /** 세션 보관 — 터미널만 내리고 좌표·대화는 DB 에 남긴다(DELETE ?reclaim=1 = restorable). 성공하면 true. */
    async function archiveSess(s, name) {
        const working = s.stateKey === 'busy' || s.stateKey === 'waiting';
        // 확인창 정의는 web/session-actions.ts 한 곳에 둔다(#1582 — 같은 동작이 화면마다 다른 말을 하면 한쪽이 거짓말이 된다).
        if (!await confirmSessionArchive({ title: `「${name}」 세션을 보관할까요?`, working }))
            return false;
        try {
            await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '?reclaim=1' + (s.node ? '&node=' + encodeURIComponent(s.node) : ''), { method: 'DELETE' });
            toast('세션을 보관했어요 — [보관한 세션]에서 되살릴 수 있어요.');
            opts.onProjectChanged?.();
            return true;
        }
        catch (e) {
            toast('보관하지 못했어요 — ' + (e && e.message ? e.message : e), true);
            return false;
        }
    }
    /** 가운데 칸의 탭 줄에 세션 탭들을 그린다(원준 2026-08-20 — 하단 서랍을 이 줄로 옮겼다). */
    function sessTabs(pane, act) {
        const part = pane.parts.get('sessions');
        if (!part || !part.selectSession)
            return [];
        const cur = part.currentSession?.() ?? null;
        const hid = hiddenSessions();
        // 치운 탭은 줄에서 빠진다 — 단 **지금 보고 있는 세션은 예외**(보는 화면의 탭이 없으면 어디 있는지 알 수 없다).
        const ss = applyOrder(mySessions().filter((s) => !hid.has(s.id) || s.id === cur));
        const shown = ss.slice(0, SESS_TAB_MAX);
        // 지금 보는 세션이 상한 밖이면 그 탭만은 끼워 넣는다 — 켜진 것이 안 보이면 어디 있는지 알 수 없다.
        const out = ss.find((s) => s.id === cur && !shown.some((x) => x.id === s.id));
        const on = act === 'sessions';
        void lookupSessNames(shown.slice(0, 12), String(pj().name || ''), () => { if (!dead)
            paintPane('main'); });
        return [
            el('span', { class: 'pn-tabwrap' + (on && cur == null ? ' on' : '') }, el('button', {
                class: 'pn-tab pn-stab new' + (on && cur == null ? ' on' : ''), type: 'button',
                title: '새 세션을 엽니다', onclick: () => { activate('main', 'sessions'); part.selectSession?.(null); paintPane('main'); },
            }, pnIcon('plus', 'pn-i sm'), el('span', { text: '새 세션' }))),
            ...(out ? [sessTab(out, on, part)] : []),
            ...shown.map((s) => sessTab(s, on && s.id === cur, part)),
        ];
    }
    function paintPane(zone) {
        // 세션 탭을 끌거나 이름을 고치는 중에는 그 줄을 다시 그리지 않는다(8초 틱이 그 동작을 끊는다).
        if (zone === 'main' && (sdrag || sEditLocked()))
            return;
        const pane = panes.get(zone);
        const list = lay[zone];
        let act = lay.act[zone];
        if (act && !list.includes(act))
            act = null;
        if (!act && list.length)
            act = list[0];
        lay.act[zone] = act;
        const hideBtn = zone === 'side'
            ? el('button', { class: 'pn-pane-hide', type: 'button', title: '곁칸을 접습니다', 'aria-label': '곁칸 접기', onclick: () => { lay.sideOn = false; saveLayout(); paintAll(); } }, pnIcon('chev', 'pn-i sm'))
            : zone === 'bottom'
                ? el('button', { class: 'pn-pane-hide', type: 'button', title: '아래 칸을 닫습니다', 'aria-label': '아래 칸 닫기', onclick: () => { lay.bottomOn = false; saveLayout(); paintAll(); } }, pnIcon('x', 'pn-i sm'))
                : null;
        // 'sessions' 는 탭 하나가 아니라 **세션마다 탭 하나**로 펼친다(그 부품이 살아 있어야 하므로 먼저 만든다).
        const tabsOf = (t) => {
            if (t !== 'sessions')
                return [tabEl(zone, t, t === act)];
            ensurePart(pane, 'sessions');
            return sessTabs(pane, act);
        };
        // ⚠ replaceChildren 은 el() 과 달리 null 을 걸러 주지 않는다 — 넣으면 'null' 이 글자로 찍힌다.
        pane.tabs.replaceChildren(...[...list.flatMap(tabsOf), addBtn(zone), hideBtn].filter(Boolean));
        // 켜진 부품만 보이게(나머지는 살려 둔 채 숨긴다 — 탭을 오가도 대화·스크롤이 그대로다).
        if (act)
            ensurePart(pane, act);
        for (const [t, p] of pane.parts)
            p.root.hidden = t !== act;
        pane.bodyEl.classList.toggle('empty', !act);
        if (!act) {
            let ph = pane.bodyEl.querySelector('.pn-pane-empty');
            if (!ph) {
                ph = el('div', { class: 'pn-pane-empty' }, el('p', { class: 'pn-fine', text: '이 칸이 비어 있어요 — 위의 ＋ 로 넣을 것을 고르세요.' }));
                pane.bodyEl.append(ph);
            }
            ph.hidden = false;
        }
        else {
            const ph = pane.bodyEl.querySelector('.pn-pane-empty');
            if (ph)
                ph.hidden = true;
        }
    }
    function paintAll() {
        body.classList.toggle('no-side', !lay.sideOn);
        colMain.classList.toggle('no-bottom', !lay.bottomOn);
        sidePane.root.hidden = !lay.sideOn;
        splitX.hidden = !lay.sideOn;
        bottomPane.root.hidden = !lay.bottomOn;
        splitY.hidden = !lay.bottomOn;
        paintPane('main');
        paintPane('side');
        paintPane('bottom');
        paintDoor();
    }
    // ── 문패 ──
    function paintDoor() {
        const p = pj();
        const tasks = Array.isArray(p.tasks) ? p.tasks : [];
        const doneN = tasks.filter((t) => t.status_category === 'done').length;
        const kn = p.knowledge || {};
        const knN = (kn.required || []).length + (kn.produced || []).length;
        const ss = opts.data().sessions.filter((s) => (loose ? !s.projectId : Number(s.projectId) === id));
        const live = ss.filter((s) => s.live && s.alive);
        const members = Array.isArray(p.members) ? p.members : [];
        const st = p.status_category === 'done' ? { t: '끝남', c: 'done' } : p.status_category === 'unstarted' ? { t: '시작 전', c: 'todo' } : { t: '진행 중', c: 'run' };
        door.replaceChildren(el('div', { class: 'pn-door-l' }, el('div', { class: 'pn-eyebrow' }, loose ? el('span', { text: '아직 어느 프로젝트에도 붙지 않았어요.' }) : el('span', { class: 'mono', text: '#' + p.id }), loose ? null : el('span', { class: 'sep', text: '·' }), loose ? null : el('span', { class: 'pn-state ' + st.c, text: st.t }), el('span', { class: 'sep', text: '·' }), el('span', { text: `세션 ${ss.length}` + (live.length ? ` · 지금 ${live.length}` : '') }), loose ? null : el('span', { class: 'sep', text: '·' }), loose ? null : el('span', { text: `할 일 ${tasks.length - doneN}/${tasks.length}` }), loose ? null : el('span', { class: 'sep', text: '·' }), loose ? null : el('span', { text: `지식 ${knN}` })), el('h1', { class: 'pn-title', text: p.name || '프로젝트 #' + id })), el('div', { class: 'pn-door-r' }, el('span', { class: 'pn-faces' }, ...members.slice(0, 5).map((m) => personFace(String(m.member_id || m), 'pn-face', String(m.display_name || m.member_id || '')))), zonesBtn(), loose ? null : el('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: '이름·상태·본문·할 일을 고칩니다', onclick: () => openSettings() }, pnIcon('gear', 'pn-i sm'), el('span', { text: '설정' }))));
    }
    /** [칸] — 어떤 칸을 보일지, 배치를 되돌릴지. VS Code 의 보기 메뉴 자리다. */
    function zonesBtn() {
        const b = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: '어떤 칸을 볼지 정합니다' }, pnIcon('cols', 'pn-i sm'), el('span', { text: '칸' }));
        b.onclick = () => {
            const row = (label, on, hint, onPick) => el('button', { class: 'pn-pop-row' + (on ? ' on' : ''), type: 'button', onclick: () => { close(); onPick(); } }, el('span', { class: 'pn-check' + (on ? ' on' : ''), 'aria-hidden': 'true' }), el('span', { class: 'n' }, el('b', { text: label }), el('span', { class: 'pn-fine', text: hint })));
            const close = anchoredPopover(b, el('div', { class: 'pn-pop' }, el('div', { class: 'pn-pop-list' }, row('곁칸', lay.sideOn, '오른쪽에 자료·지식을 두는 칸입니다.', () => { lay.sideOn = !lay.sideOn; saveLayout(); paintAll(); }), loose ? null : row('아래 칸', lay.bottomOn, '가운데 아래에 타임라인·할 일을 두는 칸입니다.', () => { lay.bottomOn = !lay.bottomOn; saveLayout(); paintAll(); })), el('div', { class: 'pn-pop-foot' }, el('button', { class: 'btn-text', type: 'button', text: '기본 배치로 되돌리기', onclick: () => { close(); resetLayout(); } }))));
        };
        return b;
    }
    function resetLayout() {
        for (const pane of panes.values()) {
            for (const p of pane.parts.values()) {
                p.destroy?.();
                p.root.remove();
            }
            pane.parts.clear();
        }
        lay = DEF_LAYOUT();
        saveLayout();
        paintAll();
        toast('기본 배치로 되돌렸어요.');
    }
    function openSettings() {
        if (loose)
            return;
        openProjSettings({ id, detail, onChanged: () => { void refreshDetail(); opts.onProjectChanged?.(); } });
    }
    async function refreshDetail() {
        if (loose) {
            paintDoor();
            return;
        }
        try {
            const d = await api('/api/ui/v6/projects/' + id);
            if (dead || !d)
                return;
            detail = d;
            paintDoor();
            for (const pane of panes.values())
                for (const [t, p] of pane.parts) {
                    if (!p.root.hidden && t !== 'sessions')
                        p.tick?.();
                }
        }
        catch (_) { /* 다음 틱에 다시 시도한다 */ }
    }
    // ── 라이브 틱 — 보이는 부품만 제자리 갱신(서명이 같으면 DOM 을 안 건드린다) ──
    const timer = window.setInterval(() => {
        if (dead)
            return;
        for (const pane of panes.values()) {
            const act = lay.act[pane.zone];
            if (!act)
                continue;
            const p = pane.parts.get(act);
            if (p && !p.root.hidden)
                p.tick?.();
        }
        paintDoor();
    }, 8000);
    paintAll();
    if (!loose && !detail)
        void refreshDetail();
    // [보관한 세션]에서 [탭에 꺼내기]를 누르면 이 줄을 그 자리에서 다시 그린다(8초 틱을 기다리지 않게).
    const onViewChanged = () => { if (!dead)
        paintPane('main'); };
    window.addEventListener('pn:sessions-view', onViewChanged);
    return {
        destroy() {
            dead = true;
            window.removeEventListener('pn:sessions-view', onViewChanged);
            window.clearInterval(timer);
            for (const pane of panes.values())
                for (const p of pane.parts.values())
                    p.destroy?.();
            panes.clear();
        },
    };
}
