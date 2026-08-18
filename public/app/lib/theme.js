// lib/theme.ts — 화면 테마(#1683 다크모드). 값의 집: localStorage['lively_theme'] ∈ 'system'|'light'|'dark'(없으면 system).
//  적용은 <html data-theme="light|dark"> 로 **해석된 값**만 싣는다 — CSS 는 html[data-theme="dark"] 한 갈래만 본다
//  (설정값 3종 × 시스템 상태 2종을 CSS 가 다 알 필요 없게, 해석은 여기 한 곳에서).
//  첫 페인트 전 적용은 index.html <head> 인라인 스크립트가 **같은 규칙으로** 선반영한다(다크 사용자가 매 로드마다
//  흰 화면을 번쩍 보는 FOUC 방지) — 이 모듈은 그 뒤의 구독(시스템 변경·다른 탭)과 토글 UI 를 맡는다.
//  ⚠ terminal.html(워크스페이스)·graph.html(아틀라스)은 이 축 밖 — 터미널은 자체 테마 설정이 크롬 명암을 정하고
//    (terminal.js applyChrome), 아틀라스는 상시 다크다. 여기 키를 그쪽에 배선하지 말 것.
//  의존은 dom.js(leaf)뿐 — 소비 파일은 core.js 배럴 재수출로 받는다.
import { el } from './dom.js';
const THEME_KEY = 'lively_theme';
const PREFS = [
    { key: 'system', label: '시스템', title: '기기 설정을 따릅니다' },
    { key: 'light', label: '라이트', title: '항상 밝은 화면으로 봅니다' },
    { key: 'dark', label: '다크', title: '항상 어두운 화면으로 봅니다' },
];
export function themePref() {
    try {
        const v = localStorage.getItem(THEME_KEY);
        return v === 'light' || v === 'dark' ? v : 'system';
    }
    catch {
        return 'system';
    }
}
// 해석된 값(문서에 실리는 값). pref=system 이면 기기 설정을 본다.
export function themeApplied() {
    const p = themePref();
    if (p !== 'system')
        return p;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function apply() {
    document.documentElement.dataset.theme = themeApplied();
    // 색을 JS 로 읽어 그리는 표면(캔버스·차트)이 다시 그릴 수 있게 알린다. CSS 만 쓰는 표면은 들을 필요 없다.
    document.dispatchEvent(new CustomEvent('lively:theme', { detail: { theme: themeApplied(), pref: themePref() } }));
}
export function setThemePref(p) {
    try {
        p === 'system' ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, p);
    }
    catch { /* 시크릿 창 등 — 이번 페이지에만 적용 */ }
    apply();
}
// 부팅 시 1회 — 인라인 스크립트가 이미 적용해 뒀으므로 여기선 구독만 보탠다(재적용은 멱등).
export function initTheme() {
    apply();
    try {
        // 시스템 설정이 바뀌는 순간(OS 다크 전환·일몰 자동 전환) — pref=system 인 사용자만 실제로 바뀐다.
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
    }
    catch { /* 구형 브라우저 — 다음 로드에서 반영 */ }
    // 다른 탭에서 토글하면 이 탭도 따라간다(같은 브라우저에서 탭마다 명암이 다르면 고장으로 보인다).
    window.addEventListener('storage', (e) => { if (e.key === THEME_KEY)
        apply(); });
}
// ── 토글 UI — 시스템|라이트|다크 3분할(세그먼트). 클래식 상단바·v2 사이드바 발치 공용. ──
//  아이콘 없이 글자만: 상단 유틸 어휘(사용량·사용 가이드)와 같은 결이고, 해/달 아이콘만으론 '시스템 따름'을 표현할 수 없다.
export function themeControl(cls) {
    const wrap = el('div', { class: 'theme-seg' + (cls ? ' ' + cls : ''), role: 'group', 'aria-label': '화면 테마' });
    const draw = () => {
        const cur = themePref();
        wrap.replaceChildren(...PREFS.map((p) => el('button', {
            type: 'button', class: 'theme-seg-btn' + (p.key === cur ? ' on' : ''), text: p.label, title: p.title,
            'aria-pressed': p.key === cur ? 'true' : 'false',
            onclick: () => { setThemePref(p.key); draw(); },
        })));
    };
    draw();
    // 다른 탭·다른 컨트롤에서 바뀌어도 눌림 표시가 따라오게(그리기는 싸다 — 버튼 셋뿐).
    document.addEventListener('lively:theme', draw);
    return wrap;
}
