// lib/overlay.ts — body 에 직접 띄우는 **떠 있는 레이어**(#1313 R29b). core.ts 에서 **verbatim 이동**(로직 변경 0).
//  담당: toast(휘발 알림) · infoPop(ⓘ 설명 팝오버) · withTip(즉시 호버 툴팁) · anchoredPopover(앵커 팝오버).
//  공통 성질 — position:fixed 로 document.body 에 붙어 카드 overflow·스크롤 컨테이너에 잘리지 않고,
//   바깥클릭/Esc/스크롤로 스스로 닫힌다(리스너를 열 때 걸고 닫을 때 반드시 뗀다).
//  ⚠ web/ui-primitives.ts 에도 오버레이가 있다(overlay·overlayBox·confirmDialog) — 그쪽은 **모달 다이얼로그**
//   (.ov-back/.ov-box 배경 딤 + 포커스 가둠)이고 여기는 **비모달 떠있는 레이어**다. 마크업·CSS 클래스 계열이
//   서로 달라 지금 합치면 화면이 바뀐다 → **완전 통합은 R29b 범위 밖**이고, 관계만 여기 적어 둔다(후속 판단 필요).
//  소비 파일은 종전대로 './core.js' 에서 받는다(core 의 배럴 재수출).
import { el } from './dom.js';
import { uiText } from './uitext.js';
// ── 토스트 ──
function toast(msg, isError, ms) {
    const box = document.getElementById('toasts');
    // 메시지의 [버튼]·「옵션」도 화면과 같은 칩으로 — 안내문과 토스트가 서로 다른 표기를 쓰면 같은 버튼을 두 번 배운다.
    //  .toast 는 flex 라 텍스트 노드가 여러 조각이면 각각 flex item 이 된다 → span 하나로 감싸 한 덩이로 흐르게 한다.
    const t = el('div', { class: 'toast' + (isError ? ' coral' : '') }, el('span', {}, ...uiText(msg)));
    box.append(t);
    setTimeout(() => t.remove(), ms || 3600);
}
// ⓘ — 제목·라벨 오른쪽에 옅게 붙는 **아이콘 하나**. 누르면 그 자리에 팝오버로 설명이 뜬다(#1085).
//  왜: 회색 설명문을 제목·필드마다 화면에 깔면 글이 화면을 덮어 정작 내용·입력칸이 안 읽힌다(윤상민 지적).
//  '이게 뭐예요?' 팝업(구 meaningCard — '구성원에게 미치는 효과' 카드)은 **통째로 폐기**했다(사용자 요구:
//  "문구만 지우지 말고 팝업까지 날려버려"). 그래서 이 팝오버가 싣는 건 설명 문자열 하나뿐이다(**강조** 지원).
function infoPop(text) {
    if (!text)
        return null;
    const btn = el('button', { class: 'hint-i', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': '설명 보기', title: '설명 보기' }, el('span', { 'aria-hidden': 'true', text: 'ⓘ' }));
    let pop = null;
    const close = () => {
        if (!pop)
            return;
        pop.remove();
        pop = null;
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', close);
        window.removeEventListener('scroll', close, true);
    };
    const onDoc = (e) => { if (pop && !pop.contains(e.target) && !btn.contains(e.target))
        close(); };
    const onKey = (e) => { if (e.key === 'Escape') {
        close();
        btn.focus();
    } };
    btn.addEventListener('click', () => {
        if (pop) {
            close();
            return;
        }
        pop = el('div', { class: 'hint-pop', role: 'dialog' }, el('p', { class: 'hint-pop-text' }, ...uiText(text)));
        // 모달 오버레이(.ov-back) 위로(#1145) — CSS 에도 같은 값이 있지만, 옛 스타일이 캐시된 브라우저에선
        //  z-index 90 이 남아 모달 안 ⓘ 가 '눌러도 안 뜨는' 것처럼 보인다. 여기서 값을 확정한다.
        pop.style.zIndex = '1500';
        document.body.append(pop);
        // 아이콘 **오른쪽**에 띄운다(사용자 요구) — 아래로 내리면 바로 밑 내용을 가려 읽던 자리를 잃는다.
        //  오른쪽에 자리가 없으면 왼쪽, 그것도 없으면 아래로 떨어뜨린다. 세로는 아이콘에 맞추되 화면 안에 가둔다.
        //  (position:fixed 라 카드 overflow·스크롤 컨테이너에 잘리지 않는다.)
        const r = btn.getBoundingClientRect();
        const w = Math.min(360, window.innerWidth - 24);
        pop.style.width = w + 'px';
        const gap = 10;
        if (r.right + gap + w + 12 <= window.innerWidth)
            pop.style.left = Math.round(r.right + gap) + 'px';
        else if (r.left - gap - w >= 12)
            pop.style.left = Math.round(r.left - gap - w) + 'px';
        else
            pop.style.left = Math.round(Math.min(Math.max(12, r.left - 10), window.innerWidth - w - 12)) + 'px';
        const h = pop.offsetHeight;
        const wantTop = r.top - 8; // 아이콘 윗선에 살짝 걸치게
        pop.style.top = Math.round(Math.min(Math.max(12, wantTop), Math.max(12, window.innerHeight - h - 12))) + 'px';
        btn.setAttribute('aria-expanded', 'true');
        document.addEventListener('mousedown', onDoc, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', close);
        window.addEventListener('scroll', close, true);
    });
    return btn;
}
// ── 공용: 즉시 표시 호버 툴팁 ──
//  native title 은 지연(~1s)·발견성이 나쁘고, overflow:hidden 카드(.list-box)에선 CSS 말풍선이 잘린다.
//  → fixed 포지션 말풍선을 body 에 붙여 클립·지연 없이 즉시 보여준다(마우스 hover + 키보드 focus). 접근성은 aria-label.
function withTip(node, text) {
    if (!text)
        return node;
    node.setAttribute('aria-label', text);
    let tip = null;
    const hide = () => { if (tip) {
        tip.remove();
        tip = null;
    } };
    const show = () => {
        if (tip)
            return;
        tip = el('div', { class: 'hover-tip', role: 'tooltip', text });
        document.body.append(tip);
        const r = node.getBoundingClientRect();
        tip.style.left = Math.max(8, Math.min(r.left, window.innerWidth - tip.offsetWidth - 8)) + 'px';
        tip.style.top = (r.bottom + 6) + 'px';
        window.addEventListener('scroll', hide, { once: true, capture: true });
    };
    node.addEventListener('mouseenter', show);
    node.addEventListener('mouseleave', hide);
    node.addEventListener('focus', show);
    node.addEventListener('blur', hide);
    return node;
}
// 앵커에 붙는 팝오버 — 아래 공간이 모자라면 **위로 뒤집는다**(하단 플로팅 바처럼 화면 바닥에 붙은 앵커용).
//  스타일은 대시보드 팝오버(.dash-pop / .dash-pop-panel)를 그대로 쓴다 — 화면마다 다른 팝오버가 되지 않게.
function anchoredPopover(anchor, panel) {
    document.querySelectorAll('.dash-pop').forEach((n) => n.remove());
    panel.classList.add('dash-pop');
    document.body.append(panel);
    const r = anchor.getBoundingClientRect();
    const pw = panel.offsetWidth || 264, ph = panel.offsetHeight || 240;
    const below = window.innerHeight - r.bottom - 8;
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + 'px';
    // 위로 뒤집을 땐 여백을 넉넉히(12) — 앵커가 하단 플로팅 바 '안'에 있으면 6px 로는 바의 패딩과 겹쳐 보인다.
    panel.style.top = (below >= ph || below >= r.top ? r.bottom + 6 : Math.max(8, r.top - ph - 12)) + 'px';
    const close = () => {
        panel.remove();
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('blur', onBlur);
    };
    const onDoc = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target))
        close(); };
    const onKey = (e) => { if (e.key === 'Escape')
        close(); };
    // ⚠ **iframe 위에서 열린 팝오버**(세션 화면의 터미널·앱 프레임)는 위 mousedown 만으로는 안 닫힌다 — 프레임 안을 누르면
    //  그 이벤트는 프레임 문서로 가고 이 문서엔 아예 오지 않는다(#1744 신고: "영역 밖을 눌러도 안 닫혀").
    //  프레임이 포커스를 가져가면 window blur 가 뜨고 그때 activeElement 가 그 IFRAME 이 된다 — 그 경우에만 닫는다.
    //  (앱 전환·탭 전환도 blur 를 내지만 그땐 activeElement 가 그대로라, 돌아왔을 때 메뉴가 사라져 있지 않다.)
    const onBlur = () => { if (document.activeElement && document.activeElement.tagName === 'IFRAME')
        close(); };
    setTimeout(() => {
        document.addEventListener('mousedown', onDoc, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('blur', onBlur);
    }, 0);
    return close;
}
export { anchoredPopover, infoPop, toast, withTip, };
