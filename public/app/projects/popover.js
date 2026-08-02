// projects/popover.ts — #1313 R30: web/projects.ts 분해 ① 리프.
//  인라인 편집 팝오버 프리미티브(pjvPopover)와 그 위에 세운 컴팩트 피커(compactPicker)·토글 스위치 행(pjvSwitchRow).
//  ⚠ 열린 팝오버 스택(pjvPopStack)과 document 레벨 리스너(mousedown/keydown)는 이 모듈이 **단독 소유**한다 —
//   중첩 팝오버의 부모/자식 판정이 한 배열에 의존하므로 사본이 생기면 즉시 깨진다(#1067).
import { el } from '../core.js';
// 인라인 편집용 경량 팝오버 — 앵커 아래 위치, 바깥클릭/ESC 로 닫힘. body 에 1개만(기존 것 제거). 닫기함수 반환.
// 열린 팝오버 스택(#1067) — 팝오버 **안의** 드롭다운(필터의 필드/연산자/값, 그룹의 기준/방향)을 지원한다.
//  예전엔 pjvPopover 가 열릴 때 '.pjv-pop 전부 제거' 였다 → 안쪽 드롭다운을 누르는 순간 부모 팝오버가 사라지고,
//  그 안에 있던 앵커까지 DOM 에서 떨어져 place() 가 조기 반환 → "눌러도 아무 일 없이 팝오버만 꺼진다"로 보였다.
//  이제 새 팝오버의 앵커를 품은 팝오버(=부모)는 남기고 그 위에 쌓인 것만 닫는다.
const pjvPopStack = [];
function pjvPopover(anchor, content, opts) {
    // 부모 체인은 유지 — 앵커를 품지 않는(형제·이전) 팝오버만 위에서부터 닫는다.
    while (pjvPopStack.length) {
        const top = pjvPopStack[pjvPopStack.length - 1];
        if (top.pop.contains(anchor))
            break;
        top.close();
    }
    const pop = el('div', { class: 'pjv-pop' }, content);
    document.body.append(pop);
    // 위치 — 기본 앵커 아래, 아래 공간 부족하고 위가 더 넓으면 위로 뒤집음(하단 일괄 바 등). 콘텐츠가 나중에
    //  (동기 append·비동기 fetch) 채워져 높이가 바뀌면 ResizeObserver 로 재배치 → 항상 화면 안.
    //  opts.align='right': 앵커의 '오른쪽 끝'에 팝오버 오른쪽을 맞춘다(우상단 버튼 등 오른쪽 정렬 트리거용 — 기본은 왼쪽정렬 #481).
    const alignRight = !!(opts && opts.align === 'right');
    const place = () => {
        const r = anchor.getBoundingClientRect();
        // 앵커가 DOM 에서 떨어졌거나(재렌더로 교체) 0크기면 재배치하지 않는다 — 그대로 두지 않으면 rect=0,0 으로 좌상단에 튄다.
        if (!anchor.isConnected || (r.width === 0 && r.height === 0))
            return;
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
        const ph = pop.offsetHeight;
        const flipUp = (r.bottom + 4 + ph > vh) && (r.top > vh - r.bottom);
        pop.style.top = ((flipUp ? r.top - ph - 4 : r.bottom + 4) + window.scrollY) + 'px';
        const wantLeft = alignRight ? (r.right - pop.offsetWidth) : r.left; // 우측정렬이면 앵커 오른쪽 끝에 맞춤
        const left = Math.min(wantLeft + window.scrollX, window.scrollX + vw - pop.offsetWidth - 10);
        pop.style.left = Math.max(8, left) + 'px';
    };
    place();
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(() => place()) : null;
    if (ro)
        ro.observe(pop);
    const entry = { pop, anchor };
    const close = () => {
        const i = pjvPopStack.indexOf(entry);
        if (i >= 0) {
            // 내 위에 쌓인 자식 팝오버부터 닫는다(부모가 사라지는데 자식만 떠 있으면 앵커 없는 유령이 된다).
            for (const child of pjvPopStack.splice(i + 1))
                child.close();
            pjvPopStack.splice(i, 1);
        }
        if (ro)
            ro.disconnect();
        pop.remove();
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
    };
    entry.close = close;
    // 바깥 클릭 판정 — 나와 **내 위에 쌓인 자식들** 안의 클릭은 바깥이 아니다.
    //  (자식 팝오버는 body 직속이라 pop.contains 로는 안 잡힌다 — 이 검사가 없으면 자식을 누를 때 부모가 닫힌다.)
    const onDoc = (e) => {
        const i = pjvPopStack.indexOf(entry);
        const mine = i >= 0 ? pjvPopStack.slice(i) : [entry];
        if (mine.some((x) => x.pop.contains(e.target) || (x.anchor && x.anchor.contains(e.target))))
            return;
        close();
    };
    // Esc 는 맨 위 팝오버 하나만 닫는다(중첩 드롭다운에서 한 단계씩 빠져나오게).
    const onKey = (e) => {
        if (e.key !== 'Escape')
            return;
        if (pjvPopStack[pjvPopStack.length - 1] !== entry)
            return;
        e.stopPropagation();
        close();
    };
    pjvPopStack.push(entry);
    setTimeout(() => {
        document.addEventListener('mousedown', onDoc, true);
        document.addEventListener('keydown', onKey, true);
    }, 0);
    return close;
}
// ── 컴팩트 피커 — 멀티선택 피커({box,getSelected,getSelectedLabels})를 '요약 칩 + ▾' 트리거로 감싸 팝오버로 편집. ──
//  카테고리·레포·팀원을 같은 위계(한 줄 트리거)로 통일 + 세로를 크게 절약. makePicker(onChange) 로 피커 생성(onChange=요약 리페인트).
function compactPicker(label, makePicker, opts) {
    opts = opts || {};
    const chipsWrap = el('div', { class: 'cf-chips' });
    const trigger = el('button', { class: 'cf-trigger', type: 'button', 'aria-haspopup': 'dialog' }, chipsWrap, el('span', { class: 'cf-caret', text: '▾' }));
    const repaint = () => {
        const items = (picker.getSelectedLabels && picker.getSelectedLabels()) || [];
        if (!items.length) {
            chipsWrap.replaceChildren(el('span', { class: 'cf-empty', text: opts.emptyText || '선택 안 함' }));
            return;
        }
        const shown = items.slice(0, opts.maxChips || 5);
        const chips = shown.map((it) => el('span', { class: 'cf-chip' }, (opts.avatars && it.color) ? el('span', { class: 'cf-ava', style: 'background:' + it.color, text: it.initials }) : null, el('span', { class: 'cf-chip-t', text: it.label })));
        if (items.length > shown.length)
            chips.push(el('span', { class: 'cf-more', text: '+' + (items.length - shown.length) }));
        chipsWrap.replaceChildren(...chips);
    };
    const picker = makePicker(() => { repaint(); if (opts.onChange)
        opts.onChange(); }); // onChange = 요약 리페인트(+ 호출측 훅: 세부설정의 자동저장 등)
    trigger.onclick = () => {
        const panel = el('div', { class: 'cf-panel' }, picker.box);
        pjvPopover(trigger, panel);
        setTimeout(() => { const inp = panel.querySelector('input[type="text"]'); if (inp)
            inp.focus(); }, 0);
    };
    repaint();
    const row = el('div', { class: 'cf-row' }, el('span', { class: 'cf-label', text: label }), trigger);
    // trigger 도 함께 돌려준다 — cf-row(가로 라벨) 대신 세로 스택 .field 안에 넣어 쓰는 폼(리스트 만들기/설정 #1128)이 있다.
    return { row, trigger, getSelected: () => picker.getSelected(), getSelectedLabels: () => (picker.getSelectedLabels ? picker.getSelectedLabels() : []) };
}
// ── 토글 스위치 행(라벨 + iOS식 스위치). after() = 상태 반영 후 재렌더. ──
//  #1404 에서 projects/board.ts 에서 내려왔다 — 팝오버 안에 놓이는 순수 표시 프리미티브(상태를 게터/세터로만
//  주고받고 도메인을 모른다)라 이 리프가 원래 집이다. 읽는 쪽은 filters(완료·나·설정 팝오버)와 board 둘인데,
//  둘 다 이미 여기를 직결하므로 filters 가 배럴을 되짚을 이유가 사라졌다.
function pjvSwitchRow(label, getOn, setOn, after) {
    const sw = el('button', { class: 'pjv-switch' + (getOn() ? ' on' : ''), type: 'button', role: 'switch', 'aria-checked': getOn() ? 'true' : 'false' }, el('span', { class: 'pjv-switch-knob' }));
    sw.onclick = (e) => { e.stopPropagation(); const nv = !getOn(); setOn(nv); sw.classList.toggle('on', nv); sw.setAttribute('aria-checked', nv ? 'true' : 'false'); after(); };
    return el('div', { class: 'pjv-closed-row' }, el('span', { class: 'pjv-closed-row-label', text: label }), sw);
}
export { compactPicker, pjvPopover, pjvSwitchRow };
