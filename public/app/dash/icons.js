// dash/icons.ts — 대시보드 SVG 아이콘 팩토리 모음(#1313 R41 · dashboard-home.ts 에서 verbatim 분리).
//  전부 '인자 → 노드' 순수 함수라 상태가 없다. 도형은 프로젝트 탭(pjv*)·공유 폴더의 원본과 **같은 도형**을 쓰기로 한
//  결정(#619 동형 인라인)의 결과물이라, 도형을 바꾸면 그 짝도 함께 바꿔야 한다.
import { el, sv } from '../core.js';
// 리스트 글리프 — 프로젝트 탭 사이드바(pjvListGlyph)와 동일: 이모지 아이콘 or 체크리스트 라인 아이콘.
function dashListGlyph(list) {
    const emoji = list && list.settings && list.settings.icon;
    if (emoji)
        return el('span', { class: 'pjv-side-listemoji', text: String(emoji) });
    const color = (list && list.color) || 'var(--muted-2)';
    const n = sv('svg', { class: 'pjv-side-listglyph', viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M4 7l1.6 1.6L8.4 5.6' }), sv('path', { d: 'M11 7h9' }), sv('path', { d: 'M4 15l1.6 1.6L8.4 13.6' }), sv('path', { d: 'M11 15h9' }));
    return n;
}
// 새 세션 아이콘(#1236) — 프로젝트 탭 pjvActIcon('session') 동형: 터미널 창(>_ 프롬프트) + 우상단 ＋ 배지(만들기).
//  가운데 ＋만 넣으면 그냥 네모+더하기로 읽혀 터미널 느낌이 없다는 피드백으로 프롬프트를 살렸다.
//  크기 피드백 2회: 15→18→20px + 도형이 뷰박스를 꽉 채우게(창이 60%만 차지해 같은 px 여도 작아 보였다).
function dashSessAddIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('rect', { x: 1.5, y: 4.5, width: 16, height: 14, rx: 2.4 }), sv('path', { d: 'M5.2 9.4l3 2.6-3 2.6' }), sv('path', { d: 'M10.6 15.4h3.8' }), sv('path', { d: 'M20.6 2.6v5' }), sv('path', { d: 'M18.1 5.1h5' }));
    return n;
}
// 하위 태스크 아이콘 — 프로젝트 탭 pjvSubtaskIcon 동형(서브카운트 배지 안).
function dashSubtaskIcon() {
    const n = sv('svg', { class: 'pjv-subtask-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 7, cy: 6, r: 2.2 }), sv('circle', { cx: 17, cy: 17, r: 2.2 }), sv('path', { d: 'M7 8.2v5.6a2.6 2.6 0 0 0 2.6 2.6H14.6' }));
    return n;
}
// 카드 잡는 자리(그립) — 6점 글리프. 순수 어포던스라 aria-hidden.
function dashGripIcon() {
    const n = sv('svg', { class: 'dash-lay-grip', viewBox: '0 0 10 16', width: 10, height: 16, fill: 'currentColor', 'aria-hidden': 'true' });
    for (const [x, y] of [[2, 3], [8, 3], [2, 8], [8, 8], [2, 13], [8, 13]])
        n.append(sv('circle', { cx: x, cy: y, r: 1.3 }));
    return n;
}
// 파일 타입 아이콘 — 프로젝트 상세 공유 폴더 docIcon 동형(#619 인라인 원칙: projects.ts 안 건드림). 흰 페이지+접힘+색 띠+라벨.
const DASH_FILE_META = {
    pdf: ['PDF', 'ft-pdf'], doc: ['DOC', 'ft-word'], docx: ['DOC', 'ft-word'], hwp: ['HWP', 'ft-word'], hwpx: ['HWP', 'ft-word'],
    ppt: ['PPT', 'ft-ppt'], pptx: ['PPT', 'ft-ppt'], key: ['KEY', 'ft-ppt'],
    xls: ['XLS', 'ft-xls'], xlsx: ['XLS', 'ft-xls'], csv: ['CSV', 'ft-xls'],
    zip: ['ZIP', 'ft-zip'], tar: ['TAR', 'ft-zip'], gz: ['GZ', 'ft-zip'], rar: ['RAR', 'ft-zip'], '7z': ['7Z', 'ft-zip'],
    mp3: ['MP3', 'ft-av'], wav: ['WAV', 'ft-av'], m4a: ['M4A', 'ft-av'], flac: ['FLAC', 'ft-av'],
    mp4: ['MP4', 'ft-av'], mov: ['MOV', 'ft-av'], webm: ['WEBM', 'ft-av'], mkv: ['MKV', 'ft-av'],
    md: ['MD', 'ft-txt'], txt: ['TXT', 'ft-txt'], rtf: ['RTF', 'ft-txt'],
};
function dashFileThumb(name) {
    const i = String(name || '').lastIndexOf('.');
    const ext = i >= 0 ? name.slice(i + 1).toLowerCase() : '';
    const meta = DASH_FILE_META[ext] || [(ext.toUpperCase().slice(0, 4) || 'FILE'), 'ft-generic'];
    const n = sv('svg', { class: 'ft ft-file ' + meta[1], viewBox: '0 0 40 48', fill: 'none', 'aria-hidden': 'true' });
    n.append(sv('path', { class: 'ft-page', d: 'M6 2.5h17.5L34 13v30.5a2.5 2.5 0 0 1-2.5 2.5h-25A2.5 2.5 0 0 1 4 43.5V5A2.5 2.5 0 0 1 6 2.5z' }));
    n.append(sv('path', { class: 'ft-fold', d: 'M23.5 2.5V11a2 2 0 0 0 2 2H34z' }));
    n.append(sv('rect', { class: 'ft-band', x: 4, y: 29, width: 30, height: 12, rx: 2.5 }));
    const t = sv('text', { class: 'ft-label', x: 19, y: 37.8, 'text-anchor': 'middle' });
    t.textContent = meta[0];
    n.append(t);
    return n;
}
function dashDownloadIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M12 4v10' }), sv('path', { d: 'M8 11l4 4 4-4' }), sv('path', { d: 'M5 19h14' }));
    return n;
}
function dashRenameIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M14.5 5.5l4 4' }), sv('path', { d: 'M4 20l1-4L16 5l3 3L8 19z' }));
    return n;
}
function dashTrashIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M4 7h16' }), sv('path', { d: 'M9 7V4h6v3' }), sv('path', { d: 'M6 7l1 13h10l1-13' }), sv('path', { d: 'M10 11v6M14 11v6' }));
    return n;
}
// 맥 스타일 폴더 아이콘 — 프로젝트 상세 공유 폴더의 folderThumb 과 동일(ft ft-folder; 색은 styles.css).
function dashFolderThumb() {
    const n = sv('svg', { class: 'ft ft-folder', viewBox: '0 0 48 40', fill: 'none', 'aria-hidden': 'true' });
    n.append(sv('path', { class: 'ft-folder-tab', d: 'M4 9a3 3 0 0 1 3-3h10.5l4 4H4z' }));
    n.append(sv('path', { class: 'ft-folder-body', d: 'M4 12a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z' }));
    return n;
}
function dashReviewIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z' }), sv('path', { d: 'm8.5 12.2 2.4 2.4 4.6-5' }));
    return n;
}
function dashGearIcon() {
    const n = sv('svg', { class: 'dash-gear', viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 12, r: 3 }), sv('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }));
    return n;
}
function dashClockIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 12, r: 9 }), sv('path', { d: 'M12 7v5l3 2' }));
    return n;
}
function dashCommentIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 9, height: 9, fill: 'currentColor', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z' }));
    return n;
}
function dashSessionIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 9, height: 9, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M5 7l4 5-4 5' }), sv('path', { d: 'M13 17h6' }));
    return n;
}
// 활동(커밋·기능 등) — 번개 글리프.
function dashSparkIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'currentColor', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M13 2 4.5 13.5H11l-1 8.5L19.5 10H13z' }));
    return n;
}
// 담당자 변경 — 사람 글리프.
function dashPersonIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 8, r: 3.4 }), sv('path', { d: 'M5.5 20a6.5 6.5 0 0 1 13 0' }));
    return n;
}
// 딥링크 화살표(→) 아이콘 — 헤더 통일 액션버튼(다른 탭으로 이동).
function dashArrowIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M5 12h13' }), sv('path', { d: 'M13 6l6 6-6 6' }));
    return n;
}
// 필터 아이콘 — 아래로 좁아지는 3선. 프로젝트 탭 툴바(pjvTbIcon('filter'))와 **같은 도형**을 쓴다:
//  우리 서비스의 필터 표시는 이 3선 하나로 통일한다(깔때기 도형은 쓰지 않는다 — #req).
function dashFilterIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M3 6.5h18M7 12h10M10 17.5h4' }));
    return n;
}
// 확장(⤢) 아이콘 — 헤더 통일 액션버튼(모달 '전체 보기').
function dashExpandIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M8 3H5a2 2 0 0 0-2 2v3' }), sv('path', { d: 'M16 3h3a2 2 0 0 1 2 2v3' }), sv('path', { d: 'M21 16v3a2 2 0 0 1-2 2h-3' }), sv('path', { d: 'M3 16v3a2 2 0 0 0 2 2h3' }));
    return n;
}
// 폴더 브라우저 뷰 토글 아이콘 — 아이콘(그리드) / 목록(라인).
function dashViewIconIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('rect', { x: 4, y: 4, width: 7, height: 7, rx: 1.5 }), sv('rect', { x: 13, y: 4, width: 7, height: 7, rx: 1.5 }), sv('rect', { x: 4, y: 13, width: 7, height: 7, rx: 1.5 }), sv('rect', { x: 13, y: 13, width: 7, height: 7, rx: 1.5 }));
    return n;
}
function dashViewListIcon() {
    const n = sv('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M8 6h12' }), sv('path', { d: 'M8 12h12' }), sv('path', { d: 'M8 18h12' }), sv('path', { d: 'M4 6h.01' }), sv('path', { d: 'M4 12h.01' }), sv('path', { d: 'M4 18h.01' }));
    return n;
}
export { dashListGlyph, dashSessAddIcon, dashSubtaskIcon, dashGripIcon, DASH_FILE_META, dashFileThumb, dashDownloadIcon, dashRenameIcon, dashTrashIcon, dashFolderThumb, dashReviewIcon, dashGearIcon, dashClockIcon, dashCommentIcon, dashSessionIcon, dashSparkIcon, dashPersonIcon, dashArrowIcon, dashFilterIcon, dashExpandIcon, dashViewIconIcon, dashViewListIcon, };
