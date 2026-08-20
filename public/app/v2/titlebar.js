// v2/titlebar.ts — 데스크톱 앱 창의 **맨 윗줄을 탭 줄에게 준다**(상민님 2026-08-20: "윈도우·맥 둘 다 맨 위
//  최소화·창모드·닫기가 있는 줄이 텅 비어 있다 — 거기로 탭 섹션을 옮기자").
//
//  ── 지금까지의 그림 ──
//  데스크톱 앱은 frameless 창이라(desktop/main/web-shell.mjs frameOptions) OS 타이틀바가 없고, 대신 **preload 가**
//  페이지 위 36px 짜리 빈 띠를 그려 그걸 끌어 창을 옮겼다(desktop/preload/web.cjs ③). 웹이 아니라 preload 가
//  소유한 이유는 버전 어긋남 방어다 — 구 게이트웨이에 새 앱이 붙어도 창은 끌려야 한다.
//  그래서 그 띠는 늘 **비어 있었다**. 세로 36px 이 아무 일도 안 하고, 바로 아래에 탭 줄이 또 한 줄을 먹었다.
//
//  ── 바뀐 그림: 웹이 그 줄을 '가져간다' ──
//  preload 는 이제 능력(`livelyDesktop.titlebar`)과 인수인계 함수(`claimTitlebar`)를 내준다. 웹이 가져가면
//  preload 는 제 띠를 걷고, 웹이 그 자리에 **탭 줄이 든 진짜 타이틀바**를 그린다. 안 가져가면(구 웹·클래식 화면)
//  종전 그대로 빈 띠가 남는다 — 두 방향 모두 안전하다(새 앱+구 웹, 구 앱+새 웹).
//
//  ── 창 버튼 자리를 비켜 앉기 ──
//  · Windows: WCO(네이티브 최소화/최대화/닫기)가 **오른쪽**에 얹힌다. 정확한 자리는 브라우저가 CSS env()·
//    `navigator.windowControlsOverlay` 로 알려 준다 — 배율·언어에 따라 폭이 달라지므로 상수로 두지 않는다.
//  · macOS: 신호등이 **왼쪽**에 얹힌다. WCO 가 아니라서 알려 주는 API 가 없다 → hiddenInset 의 실측 폭을 쓴다.
//  · 그리고 어느 쪽이든 **끌 자리**가 남아야 한다. 탭이 줄을 꽉 채우면 창을 옮길 데가 없다(크롬이 탭 줄 오른쪽에
//    늘 빈 자리를 두는 이유가 이것이다) → 오른쪽에 손잡이(.v2-tb-grip)를 고정으로 둔다.
import { el } from '../core.js';
/** macOS hiddenInset 신호등이 먹는 왼쪽 폭(실측) — 버튼 3개 + 좌우 여백. */
const MAC_LIGHTS_W = 78;
const desk = () => window.livelyDesktop || null;
/**
 * 창 맨 윗줄을 셸이 가져간다. 데스크톱 frameless 창이 아니면 **null** — 웹(브라우저)에서는 아무 일도 일어나지 않고
 * 탭 줄은 종전대로 가운데 열 맨 위에 남는다.
 */
export function mountTitlebar(root) {
    const d = desk();
    const tb = d && d.titlebar;
    if (!d || !tb || typeof d.claimTitlebar !== 'function')
        return null;
    // preload 가 그려 둔 빈 띠를 걷고(본문을 밀어 두던 margin 도 함께) 우리가 그 자리를 받는다.
    //  색 보고(Windows WCO 버튼 색)는 preload 가 계속 맡되, 이제 **이 줄의 배경색**을 읽게 선택자를 넘긴다.
    if (!d.claimTitlebar({ selector: '.v2-topbar' }))
        return null;
    const h = Math.max(24, Math.round(Number(tb.height) || 36));
    const host = el('div', { class: 'v2-topbar' }, el('div', { class: 'v2-tb-grip', 'aria-hidden': 'true' }));
    root.classList.add('has-topbar');
    root.style.setProperty('--v2-tb-h', h + 'px');
    root.prepend(host);
    // ── 창 버튼이 먹는 좌·우 폭 ──
    const wco = navigator.windowControlsOverlay;
    const mac = String(d.platform || '') === 'darwin';
    const applyInsets = () => {
        let left = mac ? MAC_LIGHTS_W : 0;
        let right = 0;
        // WCO(Windows) — 끌 수 있는 영역의 실제 사각형. 그 바깥이 곧 네이티브 버튼 자리다.
        if (wco && wco.visible) {
            try {
                const r = wco.getTitlebarAreaRect();
                if (r && r.width > 0) {
                    left = Math.max(left, Math.round(r.x));
                    right = Math.max(0, Math.round(window.innerWidth - (r.x + r.width)));
                }
            }
            catch (_) { /* 구형 — 아래 폴백 */ }
        }
        root.style.setProperty('--v2-tb-left', left + 'px');
        root.style.setProperty('--v2-tb-right', right + 'px');
    };
    applyInsets();
    if (wco && typeof wco.addEventListener === 'function')
        wco.addEventListener('geometrychange', applyInsets);
    window.addEventListener('resize', applyInsets);
    return { host, on: true };
}
