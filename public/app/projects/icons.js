// projects/icons.ts — #1313 R30: web/projects.ts 분해 ① 리프.
//  프로젝트 화면의 라인 아이콘 팩(태그 · 셀 · 하위태스크 · 사이드바/툴바 · 뷰 탭 · 커스텀 필드).
//  전부 순수 함수(입력 → 새 SVG 노드) — 상태도 리스너도 없다. 톤 규약은 아래 '툴바 아이콘' 주석 참고.
import { sv } from '../core.js';
function pjvTagGearIcon() {
    const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 12, r: 3 }));
    n.append(sv('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }));
    return n;
}
function pjvTagTrashIcon() {
    const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('polyline', { points: '4 7 20 7' }), sv('path', { d: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' }), sv('path', { d: 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12' }));
    return n;
}
function pjvTagNoneIcon() {
    const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 12, r: 8 }), sv('line', { x1: 6.4, y1: 6.4, x2: 17.6, y2: 17.6 }));
    return n;
}
function pjvTagBackIcon() {
    const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('polyline', { points: '14 6 8 12 14 18' }));
    return n;
}
// 빈 상태 회색 라인 아이콘(클릭업식) — 담당자=사람＋ · 마감일=달력＋ · 우선순위=깃발. 색은 CSS(.pjv-cell-ico).
function pjvIcon(kind) {
    const svg = (...kids) => sv('svg', { class: 'pjv-cell-ico', viewBox: '0 0 24 24', width: '17', height: '17',
        fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ...kids);
    if (kind === 'assignee') { // 사람 + (담당자 지정)
        return svg(sv('circle', { cx: '9.5', cy: '8', r: '3.4' }), sv('path', { d: 'M3.7 19a5.8 5.8 0 0 1 11.6 0' }), sv('path', { d: 'M18.8 13.6v4.6M16.5 15.9h4.6' }));
    }
    if (kind === 'due') { // 달력 + (마감일 지정)
        return svg(sv('rect', { x: '3.3', y: '5', width: '17.4', height: '15.2', rx: '2.4' }), sv('path', { d: 'M3.3 9.3h17.4' }), sv('path', { d: 'M8 2.8v3.6M16 2.8v3.6' }), sv('path', { d: 'M12 12.2v4.6M9.7 14.5h4.6' }));
    }
    if (kind === 'session') { // 터미널 바로가기(내 세션) — 창 + 프롬프트(>_)
        return svg(sv('rect', { x: '3', y: '4.5', width: '18', height: '15', rx: '2.4' }), sv('path', { d: 'M7 9.5l3 2.5-3 2.5' }), sv('path', { d: 'M13 14.5h4' }));
    }
    return svg(// 깃발 (우선순위)
    sv('path', { d: 'M6 20.5V4' }), sv('path', { d: 'M6 4.7h10.3l-2.4 3.3 2.4 3.3H6z' }));
}
// 하위 태스크 아이콘(클릭업식) — 좌상단 노드 → 꺾인 가지 → 우하단 노드.
function pjvSubtaskIcon() {
    const n = sv('svg', { class: 'pjv-subtask-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 7, cy: 6, r: 2.2 }), sv('circle', { cx: 17, cy: 17, r: 2.2 }), sv('path', { d: 'M7 8.2v5.6a2.6 2.6 0 0 0 2.6 2.6H14.6' }));
    return n;
}
// 사이드바 검색창 돋보기 아이콘(#req).
function pjvSideSearchIcon() {
    const n = sv('svg', { class: 'pjv-side-search-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 11, cy: 11, r: 6.5 }), sv('path', { d: 'M20 20l-3.6-3.6' }));
    return n;
}
// 폴더(사이드바 항목) 아이콘 — 색을 채운 폴더. kind='all'(전체·파랑) / 'none'(미분류·점선 외곽) / 그 외=해당 폴더 색 채움.
function pjvBundleIcon(color, kind) {
    const FOLDER = 'M3 6.7C3 5.8 3.72 5.1 4.6 5.1h3.55c.46 0 .9.22 1.18.58l.86 1.1h8.2c.88 0 1.6.72 1.6 1.6v8.42c0 .88-.72 1.6-1.6 1.6H4.6C3.72 18.9 3 18.2 3 17.3V6.7z';
    const n = sv('svg', { class: 'pjv-bundle-ic' + (kind ? ' ' + kind : ''), viewBox: '0 0 24 24', width: 17, height: 17, 'aria-hidden': 'true' });
    if (kind === 'none')
        n.append(sv('path', { d: FOLDER, fill: 'none', stroke: 'var(--muted-3)', 'stroke-width': 1.5, 'stroke-dasharray': '3 2.4', 'stroke-linejoin': 'round' }));
    else
        n.append(sv('path', { d: FOLDER, fill: color || 'var(--muted-2)' }));
    return n;
}
// '보기' 버튼 아이콘 — 슬라이더 2줄(설정 느낌).
function pjvViewIcon() {
    const n = sv('svg', { class: 'pjv-view-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M4 8h7M15 8h5' }), sv('circle', { cx: 13, cy: 8, r: 2.1 }), sv('path', { d: 'M4 16h5M13 16h7' }), sv('circle', { cx: 11, cy: 16, r: 2.1 }));
    return n;
}
// (구 '보기 방식' 팝오버(#670)는 #1067 에서 툴바 톱니(보기 설정)로 이관 — pjvBoardSettingsPopover 가 같은 라디오를 품는다.)
// 체크-원 아이콘(Closed 버튼용).
function pjvCheckCircle() {
    const n = sv('svg', { class: 'pjv-closed-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 12, r: 9 }));
    n.append(sv('path', { d: 'M8.5 12.3l2.4 2.4 4.6-5' }));
    return n;
}
// ── 툴바 아이콘 (#1067) ─────────────────────────────────────────────────────
//  세 가지를 통일해야 '우글거림'이 사라진다 — 손으로 좌표를 찍으면 미세 비대칭이 작은 크기에서 그대로 보인다.
//   ① 광학 상자: 모든 아이콘 내용이 24 그리드의 3~21 안을 꽉 채운다(어떤 건 크고 어떤 건 작아 보이던 문제).
//   ② 획: 1.6 단일 두께 · round cap/join(예전엔 1.7/1.8/1.9 가 섞여 굵기가 튀었다).
//   ③ 대칭이 중요한 도형(톱니·별)은 **각도·반지름으로 계산**해서 만든다 — 손으로 쓴 베지어는 좌우가 미세하게 어긋난다.
// 중심에서 반지름 목록대로 점을 찍어 만드는 폐곡선. spec[i] = i 번째 점의 반지름(각도는 균등 분할).
//  rot 로 첫 점의 각도를 잡는다(기본 위쪽). 좌표는 소수 2자리로 굳혀 렌더마다 동일.
function pjvRadialPath(spec, rot, cx = 12, cy = 12) {
    const n = spec.length;
    const pts = spec.map((r, i) => {
        const a = rot + (i * 2 * Math.PI) / n;
        return (cx + r * Math.cos(a)).toFixed(2) + ' ' + (cy + r * Math.sin(a)).toFixed(2);
    });
    return 'M' + pts.join('L') + 'Z';
}
// 톱니 8개 기어 — 톱니마다 [윗면 시작·끝 / 골 시작·끝] 4점. 각 구간의 **각도 폭을 따로** 줘야
//  톱니가 각지게(사다리꼴) 나온다. 균등분할이면 옆면이 완만해져 8각 별처럼 뾰족하게 읽힌다.
function pjvGearPath(teeth, rOut, rIn, topDeg, valleyDeg) {
    const step = 360 / teeth;
    const rad = (d) => (d * Math.PI) / 180;
    const pt = (r, deg) => (12 + r * Math.cos(rad(deg))).toFixed(2) + ' ' + (12 + r * Math.sin(rad(deg))).toFixed(2);
    const out = [];
    for (let i = 0; i < teeth; i++) {
        const c = -90 + i * step; // 이 톱니의 중심각(첫 톱니가 12시)
        const v = c + step / 2; // 다음 톱니와의 사이 골 중심각
        out.push(pt(rOut, c - topDeg / 2), pt(rOut, c + topDeg / 2), pt(rIn, v - valleyDeg / 2), pt(rIn, v + valleyDeg / 2));
    }
    return 'M' + out.join('L') + 'Z';
}
const PJV_GEAR_PATH = pjvGearPath(8, 9.2, 6.6, 19, 19);
// 5각 별 — 바깥/안쪽 반지름 교대. 꼭짓점이 12시.
const PJV_STAR_PATH = pjvRadialPath(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 8.8 : 3.9)), -Math.PI / 2);
function pjvTbIcon(kind, cls) {
    const n = sv('svg', { class: 'pjv-tb-ic' + (cls ? ' ' + cls : ''), viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    if (kind === 'group') { // 그룹 — 겹쳐 쌓은 판 3장(레이어)
        n.append(sv('path', { d: 'M12 3.2 3 7.5l9 4.3 9-4.3-9-4.3Z' }), sv('path', { d: 'M3 12.1 12 16.4l9-4.3' }), sv('path', { d: 'M3 16.6 12 20.9l9-4.3' }));
        return n;
    }
    if (kind === 'columns') { // 컬럼 — 세로 3분할 판
        n.append(sv('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.4 }), sv('path', { d: 'M9 4.5v15M15 4.5v15' }));
        return n;
    }
    if (kind === 'filter') { // 필터 — 아래로 좁아지는 3선. 폭 18/10/4 로 확실히 좁아지게.
        //  ⚠ 이게 우리 서비스의 **유일한 필터 아이콘**이다(깔때기 도형 금지 — #req). 다른 화면도 같은 d 를 쓴다(예 dashFilterIcon).
        n.append(sv('path', { d: 'M3 6.5h18M7 12h10M10 17.5h4' }));
        return n;
    }
    if (kind === 'people') { // 담당자 — 두 사람(앞사람 온전 + 뒷사람 반쪽)
        n.append(sv('circle', { cx: 9.6, cy: 8.2, r: 3.6 }), sv('path', { d: 'M3 20.2v-1.1a4.4 4.4 0 0 1 4.4-4.4h4.4a4.4 4.4 0 0 1 4.4 4.4v1.1' }), sv('path', { d: 'M17.2 4.9a3.6 3.6 0 0 1 0 6.6' }), sv('path', { d: 'M21 20.2v-1.1a4.4 4.4 0 0 0-3.3-4.26' }));
        return n;
    }
    if (kind === 'search') {
        n.append(sv('circle', { cx: 10.6, cy: 10.6, r: 7 }), sv('path', { d: 'M21 21l-5.4-5.4' }));
        return n;
    }
    if (kind === 'gear') {
        n.append(sv('path', { d: PJV_GEAR_PATH }), sv('circle', { cx: 12, cy: 12, r: 3.2 }));
        return n;
    }
    if (kind === 'star' || kind === 'star-on') {
        const p = sv('path', { d: PJV_STAR_PATH });
        if (kind === 'star-on')
            p.setAttribute('fill', 'currentColor');
        n.append(p);
        return n;
    }
    if (kind === 'check') { // 완료 — 원 + 체크(원이 3~21 을 채운다)
        n.append(sv('circle', { cx: 12, cy: 12, r: 9 }), sv('path', { d: 'M8.1 12.2l2.7 2.7 5.1-5.6' }));
        return n;
    }
    if (kind === 'subtask') { // 하위 태스크 — 부모 노드에서 꺾여 내려가는 가지
        n.append(sv('circle', { cx: 6.4, cy: 5.6, r: 2.6 }), sv('circle', { cx: 17.6, cy: 18.4, r: 2.6 }), sv('path', { d: 'M6.4 8.2v7A3.2 3.2 0 0 0 9.6 18.4h5.4' }));
        return n;
    }
    if (kind === 'sidebar') { // 사이드바 — 좌측 패널이 붙은 판(폴더보다 '패널 여닫기'가 직관적)
        n.append(sv('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.4 }), sv('path', { d: 'M9.6 4.5v15' }));
        return n;
    }
    if (kind === 'plus') {
        n.append(sv('path', { d: 'M12 5v14M5 12h14' }));
        return n;
    }
    if (kind === 'trash') {
        n.append(sv('path', { d: 'M4 6.6h16' }), sv('path', { d: 'M9.6 6.6V5c0-.83.67-1.5 1.5-1.5h1.8c.83 0 1.5.67 1.5 1.5v1.6' }), sv('path', { d: 'M6.4 6.6l.83 12.5A1.5 1.5 0 0 0 8.72 20.5h6.56a1.5 1.5 0 0 0 1.5-1.4L17.6 6.6' }));
        return n;
    }
    if (kind === 'x') {
        n.append(sv('path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }));
        return n;
    }
    n.append(sv('path', { d: 'M6.5 9.5 12 15l5.5-5.5' })); // caret(기본)
    return n;
}
// ── 뷰 탭 아이콘(보드·타임라인·테이블·리스트) — 같은 광학 상자·같은 획. ────────
function pjvTabIcon(kind) {
    const n = sv('svg', { class: 'pjv-vtab-ic', viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    if (kind === 'board') { // 칸반 — 높이가 다른 세 컬럼
        n.append(sv('rect', { x: 3, y: 4.5, width: 5, height: 15, rx: 1.6 }), sv('rect', { x: 9.5, y: 4.5, width: 5, height: 9.5, rx: 1.6 }), sv('rect', { x: 16, y: 4.5, width: 5, height: 12.5, rx: 1.6 }));
    }
    else if (kind === 'timeline') { // 간트 — 어긋나게 쌓인 막대 3개
        n.append(sv('rect', { x: 3, y: 5, width: 10, height: 4, rx: 2 }), sv('rect', { x: 8, y: 10, width: 13, height: 4, rx: 2 }), sv('rect', { x: 5, y: 15, width: 9, height: 4, rx: 2 }));
    }
    else if (kind === 'table') { // 표 — 헤더행 + 첫 열 경계
        n.append(sv('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.4 }), sv('path', { d: 'M3 9.4h18M9.6 9.4v10.1' }));
    }
    else { // 리스트 — 점 + 줄 3
        n.append(sv('circle', { cx: 4.6, cy: 6.6, r: 1.3, fill: 'currentColor', stroke: 'none' }), sv('circle', { cx: 4.6, cy: 12, r: 1.3, fill: 'currentColor', stroke: 'none' }), sv('circle', { cx: 4.6, cy: 17.4, r: 1.3, fill: 'currentColor', stroke: 'none' }), sv('path', { d: 'M8.8 6.6H21M8.8 12H21M8.8 17.4H21' }));
    }
    return n;
}
// 라인 아이콘 글리프(24x24, currentColor) — 형태만으로 형식을 구분(파일 아이콘 idiom 과 동일 톤).
const PJV_FIELD_ICON_PATHS = {
    text: [['polyline', { points: '5 7 5 4 19 4 19 7' }], ['line', { x1: 12, y1: 4, x2: 12, y2: 20 }], ['line', { x1: 9, y1: 20, x2: 15, y2: 20 }]],
    textarea: [['line', { x1: 4, y1: 6, x2: 20, y2: 6 }], ['line', { x1: 4, y1: 11, x2: 20, y2: 11 }], ['line', { x1: 4, y1: 16, x2: 13, y2: 16 }]],
    number: [['line', { x1: 9.5, y1: 4, x2: 7.5, y2: 20 }], ['line', { x1: 16.5, y1: 4, x2: 14.5, y2: 20 }], ['line', { x1: 4, y1: 9, x2: 20, y2: 9 }], ['line', { x1: 4, y1: 15, x2: 20, y2: 15 }]],
    money: [['line', { x1: 12, y1: 3, x2: 12, y2: 21 }], ['path', { d: 'M16 6.8H10.1a2.85 2.85 0 0 0 0 5.7h3.8a2.85 2.85 0 0 1 0 5.7H8' }]],
    date: [['rect', { x: 3, y: 5, width: 18, height: 16, rx: 2.5 }], ['line', { x1: 3, y1: 9.5, x2: 21, y2: 9.5 }], ['line', { x1: 8, y1: 3, x2: 8, y2: 7 }], ['line', { x1: 16, y1: 3, x2: 16, y2: 7 }]],
    dropdown: [['rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.5 }], ['polyline', { points: '8.5 10 12 13.5 15.5 10' }]],
    labels: [['path', { d: 'M3.6 12.4 11 5a2 2 0 0 1 1.42-.6H19A1.4 1.4 0 0 1 20.4 5.8v6.6a2 2 0 0 1-.6 1.42l-7.4 7.4a1.55 1.55 0 0 1-2.2 0l-6.6-6.6a1.55 1.55 0 0 1 0-2.2Z' }], ['circle', { cx: 16, cy: 8, r: 1.25 }]],
    checkbox: [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 3.5 }], ['polyline', { points: '8.4 12.4 11 15 16 9.4' }]],
    website: [['circle', { cx: 12, cy: 12, r: 9 }], ['line', { x1: 3, y1: 12, x2: 21, y2: 12 }], ['path', { d: 'M12 3c2.6 2.7 2.6 15.3 0 18' }], ['path', { d: 'M12 3c-2.6 2.7-2.6 15.3 0 18' }]],
    email: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }], ['polyline', { points: '4 7.5 12 13 20 7.5' }]],
    phone: [['path', { d: 'M6.5 3h3l1.6 4.2-2.3 1.5a11 11 0 0 0 4.9 4.9l1.5-2.3 4.2 1.6v3a2 2 0 0 1-2.1 2A15.5 15.5 0 0 1 4.5 5.1 2 2 0 0 1 6.5 3Z' }]],
    rating: [['path', { d: 'M12 4.3l2.34 4.74 5.23.76-3.78 3.69.89 5.2L12 16.9l-4.68 2.46.89-5.2-3.78-3.69 5.23-.76Z' }]],
    progress: [['rect', { x: 3, y: 9, width: 18, height: 6, rx: 3 }], ['path', { d: 'M6.2 12h6', 'stroke-width': 3.2, 'stroke-linecap': 'round' }]],
    tshirt: [['path', { d: 'M8.2 3.5 4 6.5l2.1 3.2 1.9-1.1V19a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V8.6l1.9 1.1L20 6.5l-4.2-3a2.4 2.4 0 0 1-3.8 1.4 2.4 2.4 0 0 1-3.8-1.4Z' }]],
    location: [['path', { d: 'M12 21s-6.4-5.3-6.4-10.4A6.4 6.4 0 0 1 18.4 10.6C18.4 15.7 12 21 12 21Z' }], ['circle', { cx: 12, cy: 10.4, r: 2.3 }]],
    files: [['path', { d: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48' }]],
    relationship: [['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }], ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }]],
    progress_auto: [['path', { d: 'M5.5 17.5a8 8 0 1 1 13 0' }], ['path', { d: 'M12 13l3.4-3.4' }]],
};
function pjvFieldIcon(key, cls) {
    const node = sv('svg', { class: 'pjv-ficon' + (cls ? ' ' + cls : ''), viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    for (const [t, a] of (PJV_FIELD_ICON_PATHS[key] || PJV_FIELD_ICON_PATHS.text))
        node.append(sv(t, a));
    return node;
}
function pjvPlusIcon() {
    const n = sv('svg', { class: 'pjv-addcol-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 12, r: 9 }), sv('line', { x1: 12, y1: 8, x2: 12, y2: 16 }), sv('line', { x1: 8, y1: 12, x2: 16, y2: 12 }));
    return n;
}
function pjvStarGlyph(on) {
    const n = sv('svg', { class: 'pjv-fstar-ic', viewBox: '0 0 24 24', fill: on ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M12 4.3l2.34 4.74 5.23.76-3.78 3.69.89 5.2L12 16.9l-4.68 2.46.89-5.2-3.78-3.69 5.23-.76Z' }));
    return n;
}
function pjvCheckGlyph(on) {
    const n = sv('svg', { class: 'pjv-fcheck-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('rect', { x: 4, y: 4, width: 16, height: 16, rx: 4 }));
    if (on)
        n.append(sv('polyline', { points: '8.4 12.4 11 15 16 9' }));
    return n;
}
function pjvCheckMini(on) {
    const n = sv('svg', { class: 'pjv-check-mini' + (on ? ' on' : ''), viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('rect', { x: 4, y: 4, width: 16, height: 16, rx: 4 }));
    if (on)
        n.append(sv('polyline', { points: '8.4 12.4 11 15 16 9' }));
    return n;
}
export { pjvBundleIcon, pjvCheckCircle, pjvCheckGlyph, pjvCheckMini, pjvFieldIcon, pjvIcon, pjvPlusIcon, pjvSideSearchIcon, pjvStarGlyph, pjvSubtaskIcon, pjvTabIcon, pjvTagBackIcon, pjvTagGearIcon, pjvTagNoneIcon, pjvTagTrashIcon, pjvTbIcon, pjvViewIcon, };
