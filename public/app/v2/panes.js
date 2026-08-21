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
//   문패(door) — 프로젝트 이름·요약, 오른쪽에 [정보](이름·상태·본문·할 일을 한곳에 모은 창).
//   가운데 칸(main) — 기본 [세션]. 위는 **지금 보는 세션의 화면 그 자체**, 아래는 세션 서랍.
//   아래 칸(bottom) — 기본 닫힘. 여닫이는 각 칸 [+] 발치의 [아래 칸 열기]와 칸의 ×.
//   곁칸(side) — 기본 [자료][지식] 탭. 경계를 끌어 폭 조절, 탭 줄 끝 손잡이로 접고 오른쪽 위 손잡이로 편다.
//   (문패의 [칸] 버튼은 뺐다 — 원준 2026-08-20 "그냥 지워도 될 것 같다". 배치 복구는 [+] 발치로 옮겼다.)
//
//  ── ★ 프로젝트 화면과 세션 화면은 하나다(원준 2026-08-20) ──
//  종전엔 `#/p/<id>`(프로젝트)와 `#/s/<sid>`(세션)가 서로 다른 화면이었다. 이제 **주소는 늘 세션**이고,
//  프로젝트는 그 세션이 놓인 방일 뿐이다 — `#/p/<id>` 로 들어오면 라우터가 그 프로젝트 맨 위 세션으로 보낸다.
//  서랍에서 세션을 갈아 끼울 때 이 셸은 다시 그리지 않는다(자료·지식·문패가 그대로 산다) — 주소만 바뀐다.
//
//  이 파일이 모르는 것: 각 칸에 들어가는 내용(v2/panes-parts.ts) · 프로젝트 설정 창(v2/proj-settings.ts).
import { anchoredPopover, api, el, personFace, toast } from '../core.js';
import { makeSplitter } from './split.js';
import { mountSideSwap } from './side-swap.js'; // 곁칸이 절반을 넘으면 자리를 바꾼다(#1819)
import { PART_DEFS, makePart, openInWebPart, partDef, pnIcon } from './panes-parts.js';
import { hasBrowserSurface } from './browser-surface.js';
import { openProjSettings } from './proj-settings.js';
import { createTimeline } from '../timeline.js';
import { loadSessionActivities } from '../timeline-sources.js';
// ★ 배치는 **프로젝트마다 한 벌**이고, 그 프로젝트의 세션들이 함께 쓴다(원준 2026-08-20:
//  "띄워져 있는 창의 종류만 같은 프로젝트 안의 다른 세션들이 공유하게 해줘").
//  종전엔 전역 한 벌이었다(위 ② 참조) — '프로젝트마다 설정할 게 많다'를 피하려던 선택이었지만, 정작 필요한 칸은
//  프로젝트마다 달랐다(코드 프로젝트엔 편집기·웹, 글 프로젝트엔 지식·할 일). 세션 사이에서는 여전히 한 벌이라
//  '설정할 게 많다'로 돌아가지는 않는다. 그리고 처음 여는 프로젝트는 **마지막으로 쓰던 배치를 물려받는다** —
//  기본으로 되돌려 버리면 프로젝트를 옮길 때마다 같은 배치를 다시 맞춰야 한다.
const LAYOUT_KEY = 'lively_panes_layout_v2'; // { last: Layout, p: { [projectId]: Layout } }
const LAYOUT_KEY_V1 = 'lively_panes_layout_v1'; // 전역 한 벌이던 옛 판 — 첫 이사 때 'last' 의 씨앗으로만 읽는다
const DEF_LAYOUT = () => ({
    main: ['sessions'], side: ['files', 'knowledge', 'apps'], bottom: ['timeline'],
    act: { main: 'sessions', side: 'files', bottom: 'timeline' },
    sideOn: true, bottomOn: false,
});
const ALL = new Set(PART_DEFS.map((d) => d.type));
/** ⚠ 불변식: **세션 부품은 가운데 칸에만 산다.**
 *  세션은 탭을 만들지 않는다(고르기는 사이드바가 한다 — 아래 'tabsOf' 주석). 그래서 곁칸·아래 칸에 들어가면
 *  탭도 ×도 없어 **뺄 방법이 사라지고**, 그 칸에 세션만 남으면 탭 줄 자체가 숨어 ＋ 마저 없어진다
 *  (원준 2026-08-20 신고: "세션이 어디 열린 건지도 모르겠고 닫을 수도 없어 골머리"). 넣는 길을 막고(addBtn·moveTab),
 *  이미 그렇게 저장된 배치는 여기서 되돌린다 — 갇힌 사람은 새로고침 한 번으로 풀린다. */
function normalizeLayout(lay) {
    for (const z of ['side', 'bottom']) {
        const i = lay[z].indexOf('sessions');
        if (i < 0)
            continue;
        lay[z].splice(i, 1);
        if (lay.act[z] === 'sessions')
            lay.act[z] = lay[z][0] || null;
    }
    if (!lay.main.includes('sessions'))
        lay.main.unshift('sessions');
    if (!lay.act.main || !lay.main.includes(lay.act.main))
        lay.act.main = 'sessions';
    return lay;
}
/** 저장된 한 벌(어떤 판이든) → 쓸 수 있는 Layout. 못 읽으면 null(부른 쪽이 다음 후보로 넘어간다). */
function parseLayout(s) {
    if (!s || typeof s !== 'object')
        return null;
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => ALL.has(x)) : []);
    const lay = {
        main: arr(s.main), side: arr(s.side), bottom: arr(s.bottom),
        act: {
            main: ALL.has(s.act?.main) ? s.act.main : null,
            side: ALL.has(s.act?.side) ? s.act.side : null,
            bottom: ALL.has(s.act?.bottom) ? s.act.bottom : null,
        },
        sideOn: s.sideOn !== false, bottomOn: !!s.bottomOn,
    };
    // 저장된 배치가 모든 칸에서 비었으면(옛 판·손상) 없는 것으로 — 빈 화면을 보여 주는 것보다 낫다.
    if (!lay.main.length && !lay.side.length && !lay.bottom.length)
        return null;
    return normalizeLayout(lay);
}
function layoutStore() {
    try {
        const s = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
        return s && typeof s === 'object' ? s : {};
    }
    catch (_) {
        return {};
    }
}
/** 이 프로젝트의 배치 — 없으면 마지막으로 쓰던 것, 그것도 없으면 옛 전역 한 벌, 끝으로 기본. */
function loadLayout(id) {
    const st = layoutStore();
    const mine = parseLayout(st.p ? st.p[String(id)] : null);
    if (mine)
        return mine;
    const last = parseLayout(st.last);
    if (last)
        return last;
    try {
        const v1 = parseLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY_V1) || 'null'));
        if (v1)
            return v1;
    }
    catch (_) { /* noop */ }
    return DEF_LAYOUT();
}
export function mountPanes(host, opts) {
    const id = opts.id;
    const loose = id === 0; // 프로젝트 없는 세션들의 화면 — 공유 폴더·지식·할 일이 없다
    let detail = opts.detail;
    let dead = false;
    let lay = loadLayout(id);
    // 프로젝트 없는 세션 화면 — 공유 폴더·지식·할 일이 없으니 곁칸에 넣을 것도 없다. 빈 칸을 보여 주느니 접어 둔다.
    if (loose) {
        lay = { ...lay, side: lay.side.filter((t) => t === 'timeline'), bottom: [], bottomOn: false, sideOn: false };
    }
    function saveLayout() {
        if (loose)
            return; // 자투리 화면의 임시 배치를 정본으로 굳히지 않는다
        try {
            const st = layoutStore();
            const map = st.p && typeof st.p === 'object' ? st.p : {};
            map[String(id)] = lay;
            localStorage.setItem(LAYOUT_KEY, JSON.stringify({ last: lay, p: map }));
        }
        catch (_) { /* noop */ }
    }
    saveLayout(); // loadLayout 의 교정(normalizeLayout)을 디스크에도 남긴다 — 갇힌 배치가 한 번 열고 끝나지 않게
    // ── 어느 탭을 보고 있었나는 **세션마다** 기억한다(원준 2026-08-20) ─────────────────
    //  칸에 무엇이 들어 있는지(탭의 종류)는 한 벌로 공유한다 — 프로젝트를 옮겨도 같은 도구 세트가 따라오는 게 맞고,
    //  새 세션도 그 세트를 그대로 물려받는다. 하지만 **그중 무엇을 켜 두고 일하는가**는 세션마다 다르다:
    //  이 세션은 웹을 띄워 두고, 저 세션은 타임라인을 본다. 그걸 매번 다시 고르게 하지 않는다.
    //  기록은 이 브라우저에(칸 배치와 같은 급의 보기 취향), 세션 id 로 — 없으면 공용 기본값(lay.act)으로 떨어진다.
    const ACT_KEY = 'pn_act_by_sess';
    const actKey = () => String(opts.sessionId || ('p' + id));
    function readActs() {
        try {
            const m = JSON.parse(localStorage.getItem(ACT_KEY) || '{}');
            return m && typeof m === 'object' ? m : {};
        }
        catch (_) {
            return {};
        }
    }
    function saveAct(zone, type) {
        if (loose)
            return;
        try {
            const m = readActs();
            const cur = { ...(m[actKey()] || {}) };
            if (type)
                cur[zone] = type;
            else
                delete cur[zone];
            m[actKey()] = cur;
            // 무한히 쌓이지 않게 — 오래된 것부터 접는다(브라우저 저장은 5MB 남짓이고, 세션은 수백 개가 된다).
            const keys = Object.keys(m);
            if (keys.length > 300)
                for (const k of keys.slice(0, keys.length - 300))
                    delete m[k];
            localStorage.setItem(ACT_KEY, JSON.stringify(m));
        }
        catch (_) { /* noop */ }
    }
    /** 이 세션이 마지막으로 보던 탭을 되살린다 — 지금 칸에 실제로 들어 있는 것만(빠진 탭은 무시). */
    (function applySessionAct() {
        if (loose)
            return;
        const mine = readActs()[actKey()];
        if (!mine)
            return;
        for (const z of ['main', 'side', 'bottom']) {
            const t = mine[z];
            if (t && lay[z].includes(t))
                lay.act[z] = t;
        }
    })();
    const pj = () => (loose ? { id: 0, name: '프로젝트 없는 세션' } : (detail && detail.project) || { id, name: '프로젝트 #' + id });
    // ── 발자취 — **세션마다 한 벌**, 그릇은 셸이 쥔다(원준 2026-08-20) ─────────────────
    //  왜 타임라인 칸이 아니라 여기서 만드나: 재료는 세션 화면(session-chat)이 대화를 읽으며 흘려 준다.
    //  그릇이 그 칸의 것이면 **칸을 닫았다 열 때마다 그 세션이 한 일이 통째로 사라진다** — 그릇은 세션 화면과
    //  같은 수명이어야 한다. 그래서 셸이 쥐고, 타임라인 칸은 이 자리를 자기 몸에 들이기만 한다.
    //  담기는 것 두 갈래: ① 트랜스크립트(내가 올린 지시 + 그 지시로 남은 것) ② 서버에 남은 작업 기록.
    const trailHost = el('div', { class: 'pn-tlhost' });
    let trailSid = null;
    let trailW = null;
    function trailFor(sid) {
        if (!sid) {
            trailSid = null;
            trailW = null;
            trailHost.replaceChildren();
            return null;
        }
        if (trailSid === sid && trailW)
            return trailW;
        trailSid = sid;
        trailW = null;
        trailHost.replaceChildren();
        const nm = opts.data().sessions.find((x) => x.id === sid);
        const w = createTimeline(trailHost, {
            scope: (nm && nm.label) || '이 세션',
            chapters: true, // 지시 하나 = 한 장, 그 아래 그 지시로 일어난 일
            allSays: true, // 아직 아무것도 안 남은 지시도 그 자리에 — 내가 뭘 시켰나가 이 화면의 줄기다
            empty: '아직 아무것도 없어요 — 이 세션에 무언가 시키면 여기 쌓입니다.',
        });
        trailW = w;
        void loadSessionActivities(sid).then((items) => { if (!dead && trailSid === sid)
            w.addAll(items); });
        return w;
    }
    // 세션에 딸린 칸들(타임라인·웹·편집기)에게 '보는 세션이 바뀌었다'를 알린다 — 각자 자기 것을 그 세션 것으로 갈아입는다.
    const sessSubs = new Set();
    function curSession() {
        const sp = panes.get('main')?.parts.get('sessions');
        return sp && sp.currentSession ? sp.currentSession() : (opts.sessionId || null);
    }
    function announceSession(sid) {
        for (const fn of [...sessSubs]) {
            try {
                fn(sid);
            }
            catch (_) { /* 한 칸이 넘어져도 나머지는 간다 */ }
        }
    }
    const ctx = {
        id,
        data: opts.data,
        detail: () => detail,
        dead: () => dead,
        onChanged: () => { void refreshDetail(); opts.onProjectChanged?.(); },
        openSettings: () => openSettings(),
        sessionId: opts.sessionId || null,
        onSessionPicked: (sid) => { trailFor(sid); announceSession(sid); opts.onSessionPicked?.(sid); paintDoor(); },
        // 세션 화면을 붙일 때 **그 세션의 발자취 그릇**을 함께 넘긴다 — 대화가 읽히는 대로 타임라인 칸이 자란다.
        mountSession: opts.mountSession ? (host, sid) => opts.mountSession(host, sid, { trail: trailFor(sid) }) : undefined,
        onSessionCreated: (row) => { opts.onSessionCreated?.(row); paintDoor(); },
        curSession: () => curSession(),
        onSession: (fn) => { sessSubs.add(fn); return () => { sessSubs.delete(fn); }; },
        trailHost: () => trailHost,
        // 세션에 딸린 값(웹 주소·편집 중인 파일)의 저장 열쇠. 세션이 없을 때만 프로젝트로 떨어진다(새 세션 자리).
        memKey: () => curSession() || 'p' + id,
    };
    // ── 골격 ──
    const door = el('header', { class: 'pn-door' });
    const colMain = el('div', { class: 'pn-col' });
    const body = el('div', { class: 'pn-body' });
    const wrap = el('div', { class: 'pn-wrap' }, door, body);
    host.replaceChildren(wrap);
    const panes = new Map();
    const ros = [];
    function makePane(zone) {
        const tabs = el('div', { class: 'pn-tabs', role: 'tablist' });
        const tail = el('div', { class: 'pn-tabtail' });
        const bar = el('div', { class: 'pn-tabbar' }, tabs, tail);
        const bodyEl = el('div', { class: 'pn-pane-body' });
        const root = el('section', { class: 'pn-pane', 'data-zone': zone }, bar, bodyEl);
        const p = { zone, root, bar, tabs, tail, bodyEl, parts: new Map() };
        // 탭을 끌어 이 칸에 떨구면 그 부품이 여기로 옮겨 온다(VS Code 의 탭 도킹). 과녁은 줄 전체다 —
        //  띠가 꽉 차면 빈 자리가 없어져, 띠만 과녁이면 떨굴 데가 사라진다.
        bar.addEventListener('dragover', (e) => {
            if (!e.dataTransfer?.types.includes('text/x-pn-part'))
                return;
            e.preventDefault();
            bar.classList.add('drop');
        });
        bar.addEventListener('dragleave', () => bar.classList.remove('drop'));
        bar.addEventListener('drop', (e) => {
            bar.classList.remove('drop');
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
        // 세로 휠로도 띠가 미끄러지게 — 가로 막대는 디자인상 숨겨 두어서(scrollbar-width: none) 마우스만 쓰는
        //  사람에겐 잡을 데가 없다. 넘칠 때만 가로채고, 그때도 Shift(브라우저 기본 가로 스크롤)는 그대로 둔다.
        tabs.addEventListener('wheel', (e) => {
            if (e.shiftKey || !e.deltaY)
                return;
            if (tabs.scrollWidth <= tabs.clientWidth + 1)
                return;
            e.preventDefault();
            tabs.scrollLeft += e.deltaY;
        }, { passive: false });
        tabs.addEventListener('scroll', () => syncMore(p), { passive: true });
        // 칸 폭이 바뀌면(경계 끌기·창 크기·곁칸 여닫기) '가려진 탭이 있다'를 다시 잰다.
        if (typeof ResizeObserver === 'function') {
            const ro = new ResizeObserver(() => fit(p));
            ro.observe(tabs);
            ros.push(ro);
        }
        panes.set(zone, p);
        return p;
    }
    /** 띠가 넘치는가 — 넘칠 때만 손잡이 왼쪽 그늘을 켠다(안 넘치면 군더더기다). */
    function syncMore(p) {
        p.bar.classList.toggle('has-more', p.tabs.scrollWidth > p.tabs.clientWidth + 1);
    }
    /** 이름을 접을까 — **재서** 정한다(원준 2026-08-20: "충분히 다 보여줄 수 있는데 접는 일은 절대 없게").
     *
     *  폭 브레이크포인트로 정하면 '곁칸은 좁지만 탭은 둘뿐'인 화면까지 아이콘만 남는다. 그래서 기준을 폭이 아니라
     *  **넘치는가**로 둔다: 이름을 다 편 채로 재서 들어가면 그대로 두고, 넘칠 때만 켜진 탭 하나만 이름을 남기고
     *  나머지를 아이콘으로 접는다(파비콘 문법 — 이름은 툴팁과 [모두 보기]가 말한다).
     *
     *  ⚠ 잴 때는 **가장 너그러운 상태**(이름 다 펴고 ⌄ 숨긴 채)로 되돌려 놓고 잰다. 접힌 상태에서 재면
     *  '한 번 접히면 넓혀도 안 펴지는' 이력(hysteresis)이 생기고, ⌄(30px)를 낀 채 재면 그 30px 때문에
     *  들어갈 것도 접힌다. scrollWidth 를 읽는 순간 레이아웃이 동기 계산되므로 이 되돌림은 화면에 안 보인다. */
    function fit(p) {
        p.bar.classList.remove('compact', 'has-more');
        if (p.tabs.scrollWidth > p.tabs.clientWidth + 1)
            p.bar.classList.add('compact');
        syncMore(p); // 접고도 남는 넘침만 '더 있다'(그늘)로 말한다
    }
    const mainPane = makePane('main');
    const bottomPane = makePane('bottom');
    const sidePane = makePane('side');
    // 세로 경계(가운데|곁칸) · 가로 경계(가운데|아래 칸) — 폭·높이는 split.ts 가 기억한다.
    // 곁칸 경계 — 상한·부호를 side-swap 이 정한다(#1819). 곁칸이 왼쪽으로 가면 같은 손잡이의 부호가 반대가 된다.
    let swap = null;
    const splitX = makeSplitter({
        axis: 'x', key: 'panes_side', cssVar: '--pn-side-w', target: body, def: 340, min: 220,
        max: () => swap?.maxSideW() ?? 620,
        grow: () => (body.classList.contains('sw-left') ? 1 : -1),
        label: '곁칸 너비',
        onDrag: (px) => swap?.onDrag(px),
        onEnd: (px) => swap?.onEnd(px),
    });
    const splitY = makeSplitter({ axis: 'y', key: 'panes_bottom', cssVar: '--pn-bottom-h', target: colMain, def: 240, min: 120, max: 560, grow: -1, label: '아래 칸 높이' });
    colMain.append(mainPane.root, splitY, bottomPane.root);
    // 접힌 곁칸을 다시 펴는 손잡이 — 문패의 [칸] 버튼을 빼면서(원준 2026-08-20) 유일한 복구 통로가 됐다.
    //  격자 칸을 차지하지 않고 오른쪽 위에 떠 있는다(no-side 격자를 안 건드리기 위해).
    const sideReopen = el('button', {
        class: 'pn-side-reopen', type: 'button', title: '곁칸을 폅니다 — 자료·지식이 여기 들어 있어요.', 'aria-label': '곁칸 펴기',
        onclick: () => { lay.sideOn = true; saveLayout(); paintAll(); },
    }, pnIcon('chev', 'pn-i sm'));
    body.append(colMain, splitX, sidePane.root, sideReopen);
    swap = mountSideSwap({ body, colMain, sidePane: sidePane.root, sideOn: () => lay.sideOn });
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
        saveAct(zone, type); // 이 세션이 무엇을 보고 있었는지도 함께 — 다시 돌아오면 그 탭이 켜져 있다
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
    // 미리보기 칸에서 "이 주소 열어" 하고 부르면 웹 칸을 켠다 — 없으면 곁칸에 만들고, 이미 있으면 그 칸이 스스로 받는다.
    const onOpenWeb = () => { addTab('side', 'web'); };
    document.addEventListener('pn:open-web', onOpenWeb);
    // 터미널 iframe 이 미리보기 링크를 넘겨 온다 — 새 탭 대신 웹 칸에 싣는다(원준 2026-08-21).
    //  ⚠ 출처를 반드시 확인한다. 받았으면 답을 보내 터미널이 새 탭 폴백을 접게 한다.
    const onMsg = (e) => {
        if (e.origin !== location.origin)
            return;
        const d = e.data;
        if (!d || d.type !== 'lively:open-in-pane' || typeof d.url !== 'string')
            return;
        // 남의 사이트(claude.ai 아티팩트 등)는 **앱에서만** 칸에 들어간다 — 브라우저 iframe 은 상대가 막는다
        //  (CSP frame-ancestors). 막힐 걸 알면서 칸에 넣으면 빈 화면만 남으므로 그때는 새 탭으로 연다.
        let cross = false;
        try {
            cross = new URL(d.url).origin !== location.origin;
        }
        catch (_) { /* 파싱 실패 — 같은 곳으로 본다 */ }
        if (cross && !hasBrowserSurface())
            window.open(d.url, '_blank', 'noopener');
        else {
            openInWebPart(ctx, d.url);
            addTab('side', 'web');
        }
        // 어느 쪽이든 받았다고 답한다 — 안 그러면 터미널이 잠시 뒤 새 탭을 한 번 더 연다.
        try {
            e.source?.postMessage({ type: 'lively:open-in-pane:ok' }, e.origin);
        }
        catch (_) { /* 이미 닫힘 */ }
    };
    window.addEventListener('message', onMsg);
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
        if (type === 'sessions' && to !== 'main')
            return; // 세션은 가운데 칸 밖으로 나가지 않는다(위 불변식)
        removeTab(from, type);
        addTab(to, type);
    }
    function tabEl(zone, type, on) {
        const d = partDef(type);
        const b = el('button', {
            class: 'pn-tab' + (on ? ' on' : ''), type: 'button', role: 'tab',
            // 접히면 아이콘만 남는다(fit) — 이름은 툴팁이 말해야 한다. 읽어주는 이름(aria-label)도 이름으로 고정.
            'aria-selected': String(on), title: `${d.name} — ${d.hint}`, 'aria-label': d.name, draggable: 'true',
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
    /** [모두 보기] — 띠가 넘쳐 **가려진 탭이 생겼을 때만** 뜨는 통로(CSS: .pn-tabbar.has-more).
     *  여기서 고르면 그 탭이 켜지고, 여기 ×로 빼면 띠를 훑지 않고도 뺄 수 있다 — 신고의 '×를 누르기 힘들다'가
     *  실은 '×가 칸 밖에 있어 손이 닿지 않는다'였다. 이 목록은 스크롤과 무관하게 늘 칸 안에 있다. */
    function moreBtn(zone) {
        const b = el('button', { class: 'pn-tab-more', type: 'button', title: '이 칸에 든 탭을 모두 봅니다', 'aria-label': '탭 모두 보기' }, pnIcon('chev', 'pn-i sm'));
        b.onclick = () => {
            const list = lay[zone].filter((t) => t !== 'sessions');
            const close = anchoredPopover(b, el('div', { class: 'pn-pop' }, el('p', { class: 'pn-pop-h', text: '이 칸에 들어 있는 것입니다 — 누르면 그 탭이 켜지고, ×는 이 칸에서 뺍니다.' }), el('div', { class: 'pn-pop-list' }, ...list.map((t) => {
                const d = partDef(t);
                return el('div', { class: 'pn-pop-line' + (lay.act[zone] === t ? ' on' : '') }, el('button', { class: 'pn-pop-row', type: 'button', onclick: () => { close(); activate(zone, t); } }, pnIcon(d.icon, 'pn-i sm'), el('span', { class: 'n' }, el('b', { text: d.name }), el('span', { class: 'pn-fine', text: d.hint }))), el('button', {
                    class: 'pn-pop-x', type: 'button', title: `${d.name} 칸에서 뺍니다`, 'aria-label': `${d.name} 빼기`,
                    onclick: () => { close(); removeTab(zone, t); },
                }, pnIcon('x', 'pn-i xs')));
            }))));
        };
        return b;
    }
    function addBtn(zone) {
        const b = el('button', { class: 'pn-tab-add', type: 'button', title: '이 칸에 내용을 더합니다', 'aria-label': '내용 더하기' }, pnIcon('plus', 'pn-i sm'));
        b.onclick = () => {
            const rest = PART_DEFS.filter((d) => !lay[zone].includes(d.type)
                && !(d.type === 'sessions' && zone !== 'main') // 세션은 가운데 칸의 것 — 여기 넣으면 뺄 수가 없다(위 불변식)
                && !(loose && (d.type === 'files' || d.type === 'knowledge' || d.type === 'tasks' || d.type === 'liv' || d.type === 'editor')));
            const close = anchoredPopover(b, el('div', { class: 'pn-pop' }, el('p', { class: 'pn-pop-h', text: '이 칸에 넣을 것을 고르세요.' }), rest.length ? el('div', { class: 'pn-pop-list' }, ...rest.map((d) => el('button', { class: 'pn-pop-row', type: 'button', onclick: () => { close(); addTab(zone, d.type); } }, pnIcon(d.icon, 'pn-i sm'), el('span', { class: 'n' }, el('b', { text: d.name }), el('span', { class: 'pn-fine', text: d.hint })))))
                : el('p', { class: 'pn-fine', text: '넣을 수 있는 것을 이미 다 넣었어요.' }), 
            // 문패의 [칸] 버튼을 빼면서(원준 2026-08-20) 배치 복구가 갈 곳이 없어졌다 — '화면에 무엇을 둘까'를
            //  고르는 자리는 여기뿐이라, 닫힌 아래 칸의 유일한 입구와 되돌리기를 이 발치에 둔다.
            el('div', { class: 'pn-pop-foot' }, loose || lay.bottomOn ? null : el('button', { class: 'btn-text', type: 'button', text: '아래 칸 열기', onclick: () => { close(); lay.bottomOn = true; saveLayout(); paintAll(); } }), el('button', { class: 'btn-text', type: 'button', text: '기본 배치로 되돌리기', onclick: () => { close(); resetLayout(); } }))));
        };
        return b;
    }
    // ── 세션 탭 줄은 없앴다(원준 2026-08-20) ──────────────────────────────────────
    //  "한 프로젝트에서 여러 세션 고르는 건 그냥 사이드바에서 하면 될 것 같아" — 같은 목록이 사이드바(프로젝트 폴더 안)와
    //  이 줄에 두 벌 있었고, 세션이 40개씩 쌓이면 그 줄이 화면 폭을 다 먹었다(실측: 이 프로젝트 41개).
    //  그래서 **고르기는 사이드바 한 곳**으로 모으고, 이 칸은 '지금 보는 세션 하나'만 그린다.
    //  함께 사라진 것: 세션 탭의 ×(보관·치우기)·끌어 순서 바꾸기·두 번 눌러 이름 고치기 — 줄이 없으니 붙을 자리가 없다.
    //   · 보관은 세션 머리줄 [⋯ ▸ 이 세션 보관]으로 옮겼다.
    //   · 이름 고치기는 머리줄 제목(두 번 누르기·연필)과 최상단 탭(두 번 누르기)에 그대로 있다.
    //   · '탭에서 치우기'는 개념 자체가 없어졌다(치울 줄이 없다).
    function paintPane(zone) {
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
            return []; // 세션은 탭을 만들지 않는다 — 고르기는 사이드바가 한다(위 주석)
        };
        // '＋'가 한 줄에 둘이면 무엇이 열리는지 읽히지 않는다(원준 2026-08-20). 이 칸이 **세션 전용**이면
        //  일반 [+](칸에 내용 더하기)를 빼고 [+ 새 세션] 하나만 둔다 — 다른 것을 넣고 싶으면 곁칸·아래 칸의 [+]로 넣거나
        //  그 탭을 이 칸으로 끌어오면 된다(탭 끌어 옮기기는 그대로 산다).
        const sessionOnly = list.length === 1 && list[0] === 'sessions';
        pane.tabs.replaceChildren(...list.flatMap(tabsOf));
        // 손잡이는 띠 **밖**이라 탭이 몇 개가 되든 밀려나지 않는다(위 makePane 주석). [모두 보기]는 탭이 둘 이상일
        //  때만 만들고, 실제로 보이는 건 띠가 넘칠 때뿐이다(syncMore).
        // ⚠ replaceChildren 은 el() 과 달리 null 을 걸러 주지 않는다 — 넣으면 'null' 이 글자로 찍힌다.
        pane.tail.replaceChildren(...[
            pane.tabs.childElementCount > 1 ? moreBtn(zone) : null,
            sessionOnly ? null : addBtn(zone),
            hideBtn,
        ].filter(Boolean));
        // 세션만 든 칸에는 탭도 손잡이도 없다 → 줄 자체를 감춘다(빈 띠가 남으면 그게 더 이상하다).
        pane.bar.hidden = pane.tabs.childElementCount === 0 && pane.tail.childElementCount === 0;
        fit(pane);
        // 켜진 탭이 띠 밖으로 밀려 있으면 끌어온다(셸 탭 줄과 같은 문법 — tabs.ts). 'nearest' 라 이미 보이면 안 움직인다.
        const onTab = pane.tabs.querySelector('.pn-tabwrap.on');
        if (onTab && pane.tabs.scrollWidth > pane.tabs.clientWidth + 1)
            onTab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
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
        sideReopen.hidden = lay.sideOn;
        bottomPane.root.hidden = !lay.bottomOn;
        splitY.hidden = !lay.bottomOn;
        paintPane('main');
        paintPane('side');
        paintPane('bottom');
        swap?.sync();
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
        door.replaceChildren(el('div', { class: 'pn-door-l' }, el('div', { class: 'pn-eyebrow' }, loose ? el('span', { text: '아직 어느 프로젝트에도 붙지 않았어요.' }) : el('span', { class: 'mono', text: '#' + p.id }), loose ? null : el('span', { class: 'sep', text: '·' }), loose ? null : el('span', { class: 'pn-state ' + st.c, text: st.t }), el('span', { class: 'sep', text: '·' }), el('span', { text: `세션 ${ss.length}` + (live.length ? ` · 지금 ${live.length}` : '') }), loose ? null : el('span', { class: 'sep', text: '·' }), loose ? null : el('span', { text: `할 일 ${tasks.length - doneN}/${tasks.length}` }), loose ? null : el('span', { class: 'sep', text: '·' }), loose ? null : el('span', { text: `지식 ${knN}` })), el('h1', { class: 'pn-title', text: p.name || '프로젝트 #' + id })), el('div', { class: 'pn-door-r' }, el('span', { class: 'pn-faces' }, ...members.slice(0, 5).map((m) => personFace(String(m.member_id || m), 'pn-face', String(m.display_name || m.member_id || '')))), 
        // ── 문패의 두 버튼 (원준 2026-08-20 "거의 안 보인다") ─────────────────────────
        //  자리는 그대로 둔다 — 대상(프로젝트)의 오른쪽 위는 그 대상에 대한 동작이 사는 관습적인 자리이고,
        //  옮기면 시선이 제목에서 멀어질 뿐이다. 문제는 위치가 아니라 **무게**였다: 둘 다 ghost(배경·테두리 없음)라
        //  흰 문패 위에서 회색 글자로 흩어졌고, 나란히 있으니 무엇이 주된 동작인지도 말하지 않았다.
        //  그래서 **크기·글자크기는 그대로 두고 채움만** 바꾼다 — 이 칸에서 사람이 제일 자주 하는 일(세션 열기)은
        //  칠한 버튼, 가끔 보는 것(상세)은 테두리 버튼. 위계가 색으로 먼저 읽힌다.
        el('span', { class: 'pn-door-sep', 'aria-hidden': 'true' }), swap ? swap.button() : null, el('button', { class: 'btn btn-primary btn-sm pn-door-btn', type: 'button', title: '이 프로젝트에서 새 세션을 엽니다', onclick: () => newSession() }, pnIcon('plus', 'pn-i sm'), el('span', { text: '세션' })), 
        // 이름은 '정보'가 아니라 **프로젝트 상세** — 개요 부품을 없앤 뒤로 본문·할 일·상태를 보는 유일한 입구다.
        //  '정보'만 있으면 무엇에 대한 정보인지 안 말해 준다(원준 2026-08-20).
        loose ? null : el('button', { class: 'btn btn-ghost btn-sm pn-door-btn', type: 'button', title: '본문·할 일·상태·이름을 보고 고칩니다', onclick: () => openSettings() }, pnIcon('info', 'pn-i sm'), el('span', { text: '프로젝트 상세' }))));
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
    /** 새 세션 — 탭 줄과 함께 사라진 [＋ 새 세션]의 새 자리(문패 오른쪽). 세션 부품을 '새 세션 자리'로 돌린다. */
    function newSession() {
        const pane = panes.get('main');
        if (!pane)
            return;
        ensurePart(pane, 'sessions');
        activate('main', 'sessions');
        pane.parts.get('sessions')?.selectSession?.(null);
    }
    const onViewChanged = () => { if (!dead)
        paintPane('main'); };
    window.addEventListener('pn:sessions-view', onViewChanged);
    return {
        newSession,
        destroy() {
            document.removeEventListener('pn:open-web', onOpenWeb);
            window.removeEventListener('message', onMsg);
            dead = true;
            window.removeEventListener('pn:sessions-view', onViewChanged);
            window.clearInterval(timer);
            swap?.destroy();
            for (const ro of ros)
                ro.disconnect();
            ros.length = 0;
            for (const pane of panes.values())
                for (const p of pane.parts.values())
                    p.destroy?.();
            panes.clear();
            sessSubs.clear();
            trailSid = null;
            trailW = null;
            trailHost.replaceChildren();
        },
    };
}
