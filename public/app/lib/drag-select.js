// lib/drag-select.ts — 체크박스 드래그 범위 선택(#1313 R29b). core.ts 에서 **verbatim 이동**(로직 변경 0).
//  ⚠ 이 모듈은 **모듈 전역 mutable 상태(_dragSel*) + document 리스너 1회 등록 불변식 + rAF 루프**를 통째로 소유한다.
//   갈라 두면 리스너가 두 벌 붙거나(클릭 1회 무시 로직이 어긋난다) 드래그 상태를 서로 다른 사본으로 보게 된다.
//   initDragRangeSelect 가 유일한 진입점이고, 리스너는 _dragSelCfgs 최초 등록 때만 붙는다(그 규칙이 곧 계약).
//  의존 0(leaf). 소비 파일은 종전대로 './core.js' 에서 받는다(core 의 배럴 재수출).
const _dragSelCfgs = [];
let _dragSel = null; // 드래그 중 상태
let _dragSelSuppress = null; // 드래그 직후 앵커에 따라오는 click 1회 무시
const _dragSelLast = new Map(); // cfg.check → 마지막으로 누른 체크박스(Shift+클릭 앵커)
function _dragSelCfgOf(cb) {
    if (!cb || cb.tagName !== 'INPUT' || cb.type !== 'checkbox')
        return null;
    return _dragSelCfgs.find((c) => cb.matches(c.check) && cb.closest(c.row)) || null;
}
// 같은 목록(앵커 행의 부모) 안의 체크박스들을 DOM(=시각) 순서로.
function _dragSelBoxes(cfg, anchor) {
    const row = anchor.closest(cfg.row);
    const scope = (row && row.parentElement) || document;
    return [...scope.querySelectorAll(cfg.check)].filter((c) => c.closest(cfg.row));
}
// 체크박스를 특정 상태로(멱등) — 바뀔 때만 change 를 쏴 호출부 상태를 갱신한다.
function _dragSelSet(cb, on) {
    if (!!cb.checked === !!on)
        return;
    cb.checked = !!on;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
}
// 앵커~over 범위를 mode 로 칠하고, 범위 밖은 드래그 시작 시점(base)으로 되돌린다.
function _dragSelPaint(over) {
    const st = _dragSel;
    if (!st)
        return;
    const boxes = _dragSelBoxes(st.cfg, st.anchor);
    const ai = boxes.indexOf(st.anchor), ci = boxes.indexOf(over);
    if (ai < 0 || ci < 0)
        return;
    const lo = Math.min(ai, ci), hi = Math.max(ai, ci);
    boxes.forEach((c, i) => _dragSelSet(c, (i >= lo && i <= hi) ? st.mode : !!st.base.get(c)));
}
// 드래그가 목록 가장자리에 닿으면 스스로 스크롤한다 — 세션 위젯처럼 3~4장만 보이는 목록에서
//  '보이는 만큼만' 선택되면 드래그가 반쪽이 된다. 스크롤 뒤에는 포인터가 멈춰 있어도 행이 바뀌므로
//  포인터 아래 행을 매 프레임 직접 판정한다(pointerover 만 믿으면 스크롤분이 누락된다).
function _dragSelScroller(anchor) {
    let e = anchor.parentElement;
    while (e && e !== document.body) {
        const s = getComputedStyle(e);
        if (/(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 2)
            return e;
        e = e.parentElement;
    }
    return null;
}
// 포인터 세로 위치에 해당하는 행의 체크박스 — elementFromPoint 를 쓰지 않는다.
//  하단 플로팅 바(sticky)·카드 사이 여백·목록 아래 빈 공간이 포인터를 가리면 '스크롤은 되는데 안 칠해지는' 구간이 생긴다.
//  세로로만 판정하되(드래그는 위아래 동작), 가로로 목록에서 멀리 벗어나면(다른 열로 이동) 칠하지 않는다.
function _dragSelRowAt(st) {
    const boxes = _dragSelBoxes(st.cfg, st.anchor);
    let best = null, bestD = Infinity;
    for (const c of boxes) {
        const row = c.closest(st.cfg.row);
        if (!row)
            continue;
        const r = row.getBoundingClientRect();
        if (st.px < r.left - 80 || st.px > r.right + 80)
            continue;
        const d = st.py < r.top ? r.top - st.py : st.py > r.bottom ? st.py - r.bottom : 0;
        if (d < bestD) {
            bestD = d;
            best = c;
            if (d === 0)
                break;
        }
    }
    return best;
}
function _dragSelTick() {
    const st = _dragSel;
    if (!st)
        return; // 드래그가 끝나면 루프도 끝
    if (st.px != null) {
        // 스크롤 조상이 없으면(AI 세션 탭처럼 문서 전체가 스크롤되는 화면) 뷰포트 가장자리 기준으로 창을 스크롤한다.
        const sc = st.scroller;
        const r = sc ? sc.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
        const EDGE = 44, MAX = 16;
        let dy = 0;
        if (st.py < r.top + EDGE)
            dy = -Math.ceil(MAX * Math.min(1, (r.top + EDGE - st.py) / EDGE));
        else if (st.py > r.bottom - EDGE)
            dy = Math.ceil(MAX * Math.min(1, (st.py - (r.bottom - EDGE)) / EDGE));
        if (dy) {
            if (sc)
                sc.scrollTop += dy;
            else
                window.scrollBy(0, dy);
        }
        const cb = _dragSelRowAt(st);
        if (cb && cb !== st.last) {
            st.last = cb;
            if (cb !== st.anchor)
                st.moved = true;
            _dragSelPaint(cb);
        }
    }
    requestAnimationFrame(_dragSelTick);
}
function _dragSelEnd(e) {
    const st = _dragSel;
    if (!st)
        return;
    // 앵커 위에서 손을 뗐고 실제로 끌었다면, 뒤이어 오는 click 이 앵커를 되돌리지 않게 한 번 삼킨다.
    const row = st.anchor.closest(st.cfg.row);
    const endOnAnchor = !!(e && e.target && row && row.contains(e.target));
    _dragSelSuppress = (st.moved && endOnAnchor) ? st.anchor : null;
    _dragSel = null;
    document.body.classList.remove('lv-dragselect');
}
// 등록 — (행 선택자, 체크박스 선택자). 같은 조합은 한 번만 등록되고, 문서 리스너도 한 벌만 붙는다.
function initDragRangeSelect(row, check) {
    if (_dragSelCfgs.some((c) => c.row === row && c.check === check))
        return;
    _dragSelCfgs.push({ row, check });
    if (_dragSelCfgs.length > 1)
        return; // 리스너는 최초 1회만
    document.addEventListener('pointerdown', (e) => {
        if (e.button !== 0)
            return; // 좌클릭(주 버튼)만
        const cb = e.target, cfg = _dragSelCfgOf(cb);
        if (!cfg)
            return;
        const boxes = _dragSelBoxes(cfg, cb);
        _dragSel = { cfg, anchor: cb, mode: !cb.checked, moved: false, last: cb, px: e.clientX, py: e.clientY,
            scroller: _dragSelScroller(cb), base: new Map(boxes.map((c) => [c, !!c.checked])) };
        _dragSelSuppress = null;
        document.body.classList.add('lv-dragselect'); // 드래그 중 텍스트 선택 방지 + 체크박스 상시 노출
        requestAnimationFrame(_dragSelTick); // 가장자리 자동 스크롤 + 포인터 아래 행 추적
    }, true);
    // 포인터 좌표만 받아 두고, 실제 판정·칠하기는 매 프레임 _dragSelTick 한 곳에서 한다(경로를 둘로 두지 않는다).
    document.addEventListener('pointermove', (e) => {
        const st = _dragSel;
        if (!st)
            return;
        if (e.buttons === 0) {
            _dragSelEnd(null);
            return;
        } // 창 밖에서 손을 뗀 경우 등 — 끊김 방지
        st.px = e.clientX;
        st.py = e.clientY;
    }, true);
    document.addEventListener('pointerup', (e) => { if (_dragSel)
        _dragSelEnd(e); }, true);
    document.addEventListener('click', (e) => {
        const cb = e.target, cfg = _dragSelCfgOf(cb);
        if (!cfg)
            return;
        if (_dragSelSuppress === cb) { // 드래그가 이미 앵커를 칠했다 — 네이티브 토글은 취소(preventDefault 가 원상복구)
            _dragSelSuppress = null;
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        _dragSelSuppress = null;
        // Shift+클릭 — 직전에 누른 체크박스~현재까지를 지금 값으로 맞춘다(click 시점엔 이미 네이티브 토글이 끝난 상태).
        const prev = _dragSelLast.get(cfg.check);
        if (e.shiftKey && prev && prev !== cb && prev.isConnected) {
            const boxes = _dragSelBoxes(cfg, cb);
            const ai = boxes.indexOf(prev), ci = boxes.indexOf(cb);
            if (ai >= 0 && ci >= 0) {
                const lo = Math.min(ai, ci), hi = Math.max(ai, ci);
                boxes.forEach((c, i) => { if (i >= lo && i <= hi && c !== cb)
                    _dragSelSet(c, !!cb.checked); });
            }
        }
        _dragSelLast.set(cfg.check, cb);
    }, true);
}
export { initDragRangeSelect, };
