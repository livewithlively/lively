// dash/chrome.ts — 대시보드 위젯 공용 크롬(#1313 R42 · dashboard-home.ts 에서 verbatim 분리).
//  위젯이 저마다 그리는 게 아니라 **여기 한 벌**을 쓴다: 헤더 우상단 컨트롤(⚙·→) · 칩 줄 · 빈 상태 ·
//  팝오버/서브메뉴/단일선택 팝오버. 다섯 위젯이 같은 문법으로 보이는 근거가 이 파일이다.
//  ⚠ 여기로 내려온 이유(R42): 위젯을 파일로 쪼개는 순간 이 프리미티브들이 **양쪽에서** 필요해진다 —
//   dashboard-home.ts 에 두면 dashboard-home ↔ widget-* 순환이 된다(R41 이 status.ts 헤더에 남긴 그 문제).
//  ⚠ dashZone(존 카드 셸 자체)은 배치를 조립하는 renderMyDashboard 쪽 관심사라 dash/shell.ts 가 갖는다(#1313 R43).
//   그쪽이 만든 zone 을 여기 dashCtl/dashChips 가 채우는 관계다.
//  ⚠ 팝오버는 document 리스너(mousedown·keydown)를 close 까지 소유한다 — 그 수명이 이 파일 안에서 닫힌다.
//  ⚠ myDisplayName 이 크롬도 아닌데 여기 있는 이유(#1313 R43): 소비자가 **둘**이다 — 셸의 인사줄(shell.ts)과
//   최신 알림의 멘션 판정(widget-notifications.ts). 셸에 두면 shell → widget-notifications → shell 순환이 되므로,
//   둘 다 이미 의존하는 이 리프에 내려 두 소비자가 같은 한 벌을 읽게 했다.
import { el, state } from '../core.js';
import { dashGearIcon, dashArrowIcon, dashExpandIcon } from './icons.js';
// 로그인한 사람의 표시 이름 — display_name → 이메일/아이디의 @ 앞 → '나'.
function myDisplayName() {
    const me = state.me || {};
    return me.display_name || String(me.email || me.userId || '').split('@')[0] || '나';
}
// 칩 컨테이너가 넘치면 .is-clipped(우측 페이드), 아니면 해제.
function dashUpdateChipClip(chipsEl) {
    if (chipsEl)
        chipsEl.classList.toggle('is-clipped', chipsEl.scrollWidth - chipsEl.clientWidth > 1);
}
// 위젯 헤더 우상단 통일 컨트롤 — 모든 존 동일: [⚙ 설정](설정 있을 때) + [액션](→ 딥링크 or ⤢ 모달). 둘 다 같은 아이콘버튼(dash-wh-btn).
//  opts = { gear?: {title, open(anchor)}, action?: {title, href? , onClick?} }  — href 있으면 딥링크(→), 없으면 모달 여는 버튼(⤢).
function dashCtl(zone, opts) {
    const ctl = zone.ctlEl;
    if (!ctl)
        return;
    const kids = [];
    if (opts.gear) {
        const g = el('button', { class: 'dash-wh-btn dash-wh-btn-gear', type: 'button', title: opts.gear.title, 'aria-label': opts.gear.title }, dashGearIcon());
        g.onclick = () => opts.gear.open(g);
        kids.push(g);
    }
    const a = opts.action;
    if (a) {
        if (a.href)
            kids.push(el('a', { class: 'dash-wh-btn dash-wh-btn-go', href: a.href, title: a.title, 'aria-label': a.title }, dashArrowIcon()));
        else {
            const b = el('button', { class: 'dash-wh-btn dash-wh-btn-go', type: 'button', title: a.title, 'aria-label': a.title }, dashExpandIcon());
            b.onclick = a.onClick;
            kids.push(b);
        }
    }
    ctl.replaceChildren(...kids);
}
function dashChips(chipsEl, items, activeKey, onPick) {
    chipsEl.replaceChildren(...items.map(([key, label]) => el('button', {
        class: 'dash-chip' + (key === activeKey ? ' on' : ''), type: 'button',
        'aria-pressed': key === activeKey ? 'true' : 'false', text: label,
        onclick: () => { if (key !== activeKey)
            onPick(key); },
    })));
    dashUpdateChipClip(chipsEl); // 렌더 직후 넘침 판정(칩 수 변동 반영)
}
function dashEmpty(text) { return el('div', { class: 'dash-empty', text }); }
// 경량 팝오버 — anchor 아래 고정 배치, 바깥클릭·Esc 로 닫힘.
function dashPopover(anchor, panel) {
    document.querySelectorAll('.dash-pop').forEach((n) => n.remove());
    panel.classList.add('dash-pop');
    document.body.append(panel);
    const r = anchor.getBoundingClientRect();
    const pw = panel.offsetWidth || 260;
    panel.style.left = Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8)) + 'px';
    panel.style.top = (r.bottom + 6) + 'px';
    // #1236 — 앵커가 화면 중간이면 기본 max-height(70vh)가 아래로 잘려 뒷 섹션에 닿지 못한다(대시보드는 페이지 스크롤이 없다).
    //  .dash-pop-panel(overflow-y:auto)은 남은 화면 높이로 줄여 팝오버 **안에서** 스크롤되게 한다. 스크롤 규칙이 없는 pjv-menu 류는 제외.
    if (panel.classList.contains('dash-pop-panel'))
        panel.style.maxHeight = Math.max(180, window.innerHeight - r.bottom - 16) + 'px';
    const close = () => { panel.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
    const onDoc = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target))
        close(); };
    const onKey = (e) => { if (e.key === 'Escape')
        close(); };
    setTimeout(() => { document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); }, 0);
    return close;
}
// 중첩 서브메뉴 — dashPopover 와 달리 부모 팝오버(.dash-pop)를 지우지 않는다(팝오버 안 항목의 상태 메뉴 등). 위(z-90)에 뜬다.
function dashSubMenu(anchor, panel) {
    document.querySelectorAll('.dash-submenu').forEach((n) => n.remove()); // 다른 서브메뉴만 정리
    panel.classList.add('dash-submenu');
    document.body.append(panel);
    const r = anchor.getBoundingClientRect();
    const pw = panel.offsetWidth || 180;
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + 'px';
    panel.style.top = (r.bottom + 4) + 'px';
    const close = () => { panel.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
    const onDoc = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target))
        close(); };
    const onKey = (e) => { if (e.key === 'Escape') {
        e.stopPropagation();
        close();
    } };
    setTimeout(() => { document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); }, 0);
    return close;
}
// 단일 선택 팝오버 — [제목] + 라디오형 옵션 목록. 선택 시 닫고 onPick(key). 위젯 ⚙(기본값 설정) 공용.
function dashChoicePopover(anchor, title, options, current, onPick) {
    const panel = el('div', { class: 'dash-pop-panel' });
    panel.append(el('div', { class: 'dash-pop-head' }, el('strong', { text: title }), el('span', { class: 'dash-pop-sub', text: '이 기기에 저장돼요' })));
    let close = () => { };
    for (const [k, label] of options) {
        const row = el('button', { class: 'dash-pop-opt' + (k === current ? ' sel' : ''), type: 'button' }, el('span', { class: 'dash-pop-name', text: label }), k === current ? el('span', { class: 'dash-pop-check', text: '✓' }) : null);
        row.onclick = () => { close(); onPick(k); };
        panel.append(row);
    }
    close = dashPopover(anchor, panel);
}
export { dashUpdateChipClip, dashCtl, dashChips, dashEmpty, dashPopover, dashSubMenu, dashChoicePopover, myDisplayName };
