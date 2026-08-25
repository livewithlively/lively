// v2/side-swap.ts — **메인으로 보는 칸이 가운데로 온다** (#1819 원준 2026-08-21)
//
//  ── 왜 ──
//  곁칸(오른쪽)을 화면 절반 넘게 키운다는 건 "이제 이걸 메인으로 본다"는 뜻이다 — 장표·자료를 펴 놓고
//  그걸 보면서 왼쪽 세션에 타이핑한다. 그런데 정작 메인으로 보는 것이 화면 오른쪽 끝에 붙어 있는 건
//  부자연스럽다. 작업마다 메인으로 쓰는 화면이 다르므로, **지금 크게 본 것이 가운데에 오도록** 자리를 바꾼다.
//  (네 가지 방식을 만들어 화면에서 갈아 끼우며 골랐다 — 자리바꿈 채택, 원준 2026-08-21.)
//
//  ── ⚠ 이 파일이 지키는 단 하나의 제약: 세션 화면(터미널)은 iframe 이다 ──
//  iframe 은 DOM 에서 부모가 바뀌면 **통째로 다시 로드된다**(web/session-chat.ts 의 .sc-term-frame).
//  그래서 자리를 바꿀 때 요소를 옮겨 붙이지 않는다 — 격자 칸 지정(grid-column)만 바꾼다. 실측: 좌우를
//  여러 번 오가도 iframe load 0 회(터미널·스크롤·입력 중이던 글자 그대로).
//
//  ── 자연스럽게 만드는 세 가지 ──
//   ① **놓는 순간에만** 판정한다 — 끌던 중에 좌우가 바뀌면 손잡이가 손 밑에서 뒤집혀(끄는 방향과 반대로
//      자란다) 어지럽다. 끄는 동안엔 "놓으면 곁칸이 왼쪽으로 갑니다"만 띄운다.
//   ② 되돌아오는 문턱을 넘어가는 문턱보다 낮게 둔다(52% / 46%) — 같은 값이면 경계에서 손이 떨릴 때마다
//      화면이 깜빡인다.
//   ③ 자리는 **미끄러져** 바뀐다(FLIP) — 격자를 바꾸면 브라우저는 즉시 점프시키는데, 점프는 무슨 일이
//      일어났는지를 감추고 미끄러짐은 그걸 보여 준다.
//
//  ── 처음 겪는 사람에게는 설명이 먼저다 ──
//  아무 예고 없이 화면 절반이 좌우로 뒤집히면 그건 고장으로 읽힌다. 그래서 **처음 자리가 바뀌는 그 순간**
//  왜 이렇게 했는지와 끄는 법을 안내한다(다시 보지 않기 체크). 끄면 종전처럼 곁칸이 늘 오른쪽에 고정된다.
import { anchoredPopover, el, toast } from '../core.js';
import { overlay } from '../ui-primitives.js';
const KEY_OFF = 'lively_v2_side_swap_off'; // '1' = 자리 고정(자동 자리바꿈 끔)
const KEY_INTRO = 'lively_v2_side_swap_intro'; // '1' = 첫 안내를 다시 보지 않음
const SPLIT_KEY = 'panes_side'; // panes.ts 의 곁칸 경계 키와 같은 것
const SIDE_VAR = '--pn-side-w';
const DEF_SIDE_W = 340;
/** 넘어갈 때와 돌아올 때의 문턱(히스테리시스) — 경계에서 깜빡이지 않게. */
const TH = { on: 0.52, off: 0.46 };
/** 곁칸 상한 — 창의 88%. 종전 620px 로는 절반을 넘길 수가 없어 이 기능 자체가 성립하지 않는다.
 *  자리 고정을 켜 둔 사람에게도 같은 상한을 준다(넓게 쓰고 싶은 것과 자리를 바꾸는 것은 다른 요구다). */
export const maxSideWidth = () => Math.max(620, Math.round(window.innerWidth * 0.88));
const read = (k) => { try {
    return localStorage.getItem(k) === '1';
}
catch (_) {
    return false;
} };
const write = (k, v) => { try {
    if (v)
        localStorage.setItem(k, '1');
    else
        localStorage.removeItem(k);
}
catch (_) { /* noop */ } };
/** 자동 자리바꿈이 켜져 있나(기본 켜짐). */
export const swapEnabled = () => !read(KEY_OFF);
const reduceMotion = () => {
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    catch (_) {
        return false;
    }
};
/** 자리가 바뀔 때 미끄러지게 — 바뀐 뒤 위치에서 옛 위치로 되돌려 놓고 0 으로 되돌린다(FLIP). */
function slide(els, mutate) {
    if (reduceMotion()) {
        mutate();
        return;
    }
    const before = els.map((e) => e.getBoundingClientRect());
    mutate();
    const after = els.map((e) => e.getBoundingClientRect());
    els.forEach((e, i) => {
        const dx = before[i].left - after[i].left;
        if (!dx || Math.abs(dx) < 2)
            return;
        e.style.transition = 'none';
        e.style.transform = 'translateX(' + dx + 'px)';
        requestAnimationFrame(() => {
            e.style.transition = 'transform .26s cubic-bezier(.4,0,.2,1)';
            e.style.transform = '';
            window.setTimeout(() => { e.style.transition = ''; e.style.transform = ''; }, 320);
        });
    });
}
export function mountSideSwap(h) {
    const { body, colMain, sidePane } = h;
    let swapped = false; // 곁칸이 왼쪽인가
    let dead = false;
    // 끄는 중 예고 — "지금 놓으면 이렇게 됩니다"
    const hint = el('div', { class: 'sw-hint', hidden: true });
    body.append(hint);
    const ratio = (px) => {
        const w = body.clientWidth || window.innerWidth;
        return w > 0 ? px / w : 0;
    };
    const curSideW = () => {
        const raw = getComputedStyle(body).getPropertyValue(SIDE_VAR).trim();
        const n = parseFloat(raw);
        return Number.isFinite(n) ? n : DEF_SIDE_W;
    };
    const setSideW = (px) => {
        const v = Math.round(px);
        body.style.setProperty(SIDE_VAR, v + 'px');
        try {
            localStorage.setItem('lively_v2_split_' + SPLIT_KEY, String(v));
        }
        catch (_) { /* noop */ }
    };
    function paint() {
        body.classList.toggle('sw-left', swapped);
        btn.hidden = !h.sideOn(); // 곁칸을 접어 두었으면 자리바꿈도 없는 이야기다
        paintBtn();
    }
    function setSwapped(v, animate = true) {
        if (swapped === v)
            return;
        swapped = v;
        if (animate)
            slide([colMain, sidePane], paint);
        else
            paint();
    }
    // ── 판정 — **놓는 순간에만** ────────────────────────────────────────────────
    function onEnd(px) {
        hideHint();
        if (!swapEnabled()) {
            setSwapped(false);
            return;
        }
        const r = ratio(px);
        const want = r >= TH.on ? true : r <= TH.off ? false : swapped;
        if (want === swapped)
            return;
        setSwapped(want);
        if (want)
            showIntroOnce();
    }
    function onDrag(px) {
        if (!swapEnabled()) {
            hideHint();
            return;
        }
        const r = ratio(px);
        const will = r >= TH.on ? true : r <= TH.off ? false : swapped;
        if (will === swapped) {
            hideHint();
            return;
        }
        hint.textContent = (will ? '놓으면 곁칸이 왼쪽으로 갑니다' : '놓으면 곁칸이 다시 오른쪽으로 갑니다')
            + '  ·  ' + Math.round(r * 100) + '%';
        hint.hidden = false;
    }
    function hideHint() { hint.hidden = true; }
    // ── 켜고 끄기 ───────────────────────────────────────────────────────────────
    function setEnabled(on, opts) {
        write(KEY_OFF, !on);
        if (!on)
            setSwapped(false);
        else
            onEnd(curSideW());
        paint();
        if (opts?.quiet)
            return;
        toast(on
            ? '곁칸이 절반을 넘으면 자리를 바꿉니다.'
            : '곁칸 자리를 고정했어요 — 곁칸은 늘 오른쪽에 있습니다.');
    }
    // ── 처음 자리가 바뀌는 순간의 안내 ──────────────────────────────────────────
    //  아무 설명 없이 화면 절반이 좌우로 뒤집히면 고장으로 읽힌다. 왜 그랬는지와 끄는 법을 같이 말한다.
    //  '다시 보지 않기'는 체크하는 그 순간 저장한다 — 어떻게 닫든(버튼·Esc·바깥 클릭) 뜻이 지켜지게.
    function showIntroOnce() {
        if (read(KEY_INTRO))
            return;
        const again = el('input', { type: 'checkbox', class: 'sw-intro-cb', id: 'sw-intro-again' });
        again.addEventListener('change', () => write(KEY_INTRO, again.checked));
        const back = overlay('메인으로 보는 것을 가운데로 옮겼어요', el('div', { class: 'sw-intro' }, el('div', { class: 'sw-intro-fig' }, figure()), el('p', { class: 'sw-intro-p' }, el('b', { text: '곁칸을 화면 절반보다 크게 키우셨어요.' }), el('span', { text: ' 그건 보통 “이제 이걸 메인으로 본다”는 뜻입니다 — 장표나 자료를 펴 놓고, 그걸 보면서 옆에서 바로 고치는 식으로요.' })), el('p', { class: 'sw-intro-p' }, el('span', { text: '작업마다 메인으로 쓰는 화면이 다릅니다. 그래서 크게 키운 칸을 가운데로 옮기고 세션을 오른쪽으로 보냈어요. 곁칸을 절반 아래로 줄이면 원래 자리로 돌아갑니다.' })), el('p', { class: 'sw-intro-p muted' }, el('span', { text: '자리가 바뀌는 게 불편하시면 고정해 두실 수 있어요. 화면 위쪽 프로젝트 이름 옆의 ' }), el('b', { text: '⇄' }), el('span', { text: ' 버튼으로 언제든 다시 켜집니다.' })), el('label', { class: 'sw-intro-again', for: 'sw-intro-again' }, again, el('span', { text: '다시 보지 않기' })), el('div', { class: 'sw-intro-acts' }, el('button', {
            class: 'btn btn-ghost', type: 'button',
            onclick: () => { setEnabled(false); back.remove(); },
        }, el('span', { text: '자리 고정하기' })), el('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: () => back.remove(),
        }, el('span', { text: '이대로 쓸게요' })))));
        // 짧은 안내는 **화면 한가운데**에, 글 폭에 맞게. 기본 껍데기는 긴 모달용이라 위쪽 정렬(align-items:flex-start)에
        //  760px 고정이어서, 이 안내를 그대로 얹으면 오른쪽이 텅 비고 위로 치우쳐 어색하다(원준 신고 2026-08-21).
        back.classList.add('sw-intro-back');
        back.querySelector('.ov-box')?.classList.add('sw-intro-box');
    }
    /** 무슨 일이 일어났는지 한눈에 — 말보다 그림이 빠르다(왼쪽=바뀌기 전, 오른쪽=바뀐 뒤). */
    function figure() {
        const pane = (cls, label) => el('div', { class: 'sw-fig-pane ' + cls }, el('span', { text: label }));
        return el('div', { class: 'sw-fig' }, el('div', { class: 'sw-fig-box' }, pane('sess', '세션'), pane('side big', '곁칸')), el('div', { class: 'sw-fig-arrow', 'aria-hidden': 'true' }, el('span', { text: '→' })), el('div', { class: 'sw-fig-box' }, pane('side big', '곁칸'), pane('sess', '세션')));
    }
    // ── 문패 버튼 — 켜짐/꺼짐을 보여 주고 그 자리에서 바꾼다 ────────────────────
    const btn = el('button', { class: 'btn btn-ghost btn-sm sw-btn', type: 'button', onclick: () => openPop() }, el('span', { class: 'sw-btn-i', text: '⇄' }));
    function paintBtn() {
        const on = swapEnabled();
        btn.classList.toggle('on', on);
        btn.title = on
            ? '곁칸을 절반보다 크게 키우면 곁칸이 왼쪽으로, 세션이 오른쪽으로 자리를 바꿉니다 — 눌러서 고정할 수 있어요.'
            : '곁칸 자리를 고정해 두었습니다 — 눌러서 다시 켤 수 있어요.';
        btn.setAttribute('aria-label', on ? '곁칸 자리바꿈 켜짐' : '곁칸 자리 고정됨');
    }
    function openPop() {
        const on = swapEnabled();
        const panel = el('div', { class: 'sw-pop' }, el('div', { class: 'sw-pop-h' }, el('b', { text: '곁칸이 절반을 넘으면' })), el('p', { class: 'sw-pop-sub', text: '메인으로 보는 칸이 가운데로 오도록 곁칸과 세션이 자리를 바꿉니다.' }), el('div', { class: 'sw-pop-opts' }, opt('자리를 바꾼다', '지금 크게 본 것이 가운데에 옵니다. (기본)', on, () => { setEnabled(true); close(); }), opt('자리를 고정한다', '종전처럼 곁칸이 늘 오른쪽에 있습니다.', !on, () => { setEnabled(false); close(); })), el('button', {
            class: 'btn-text sw-pop-help', type: 'button',
            onclick: () => { write(KEY_INTRO, false); close(); showIntroOnce(); },
        }, el('span', { text: '설명 다시 보기' })));
        const close = anchoredPopover(btn, panel);
    }
    function opt(name, desc, on, onclick) {
        return el('button', { class: 'sw-opt' + (on ? ' on' : ''), type: 'button', onclick }, el('b', { text: name }), el('span', { text: desc }));
    }
    // 창 크기가 바뀌면 문턱(비율)도 상한도 다시 잰다.
    const onResize = () => {
        if (dead)
            return;
        const w = curSideW(), m = maxSideWidth();
        if (w > m)
            setSideW(m);
        onEnd(curSideW());
    };
    window.addEventListener('resize', onResize);
    paint();
    onEnd(curSideW()); // 새로고침해도 넓혀 둔 폭 그대로 자리가 유지되게
    return {
        maxSideW: maxSideWidth,
        onDrag, onEnd,
        button: () => btn,
        sync: () => paint(),
        destroy: () => {
            dead = true;
            window.removeEventListener('resize', onResize);
            body.classList.remove('sw-left');
        },
    };
}
