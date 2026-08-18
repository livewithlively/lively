// svc-icons.ts — 외부 서비스 브랜드 마크(SVG) + 서비스 타일(#1597).
//  형태 언어는 대시보드 알림 타일(dash-ntf-tile)과 **같다**: 라운드 스퀘어 타일 + 단색 글리프.
//  다른 점은 색의 출처 하나뿐이다 — 알림 타일은 유형색(팔레트), 여기는 그 서비스의 브랜드색.
//  왜 이모지가 아니라 직접 그리나: 이모지는 OS 마다 다른 그림이 나오고(같은 📔 가 기기별로 다른 색·모양),
//   크기·정렬·색이 우리 손 밖이며, 무엇보다 그 서비스의 로고가 아니다 — 사람이 '내가 아는 그 서비스'로 못 읽는다.
//
/* DS-EXCEPTION: 외부 브랜드 자산(서비스 로고) — 팔레트 밖 색 리터럴을 여기서만 허용한다.
   근거: ui-design-system-agent ▸ exception-policy §1 '외부 브랜드 자산(서비스 로고 등)'.
   범위: 아래 SVC_BRAND 표 + 이 파일의 도형 좌표. 다른 UI 색은 전부 토큰을 쓴다. 2026-08-10, #1597 */
import { el, sv } from './core.js';
// 서비스 키 → 브랜드 대표색(1색). 원 로고가 다색인 것(슬랙·드라이브·피그마)은 그 브랜드의 단색 판을 쓴다.
const SVC_BRAND = {
    notion: '#191919',
    linear: '#5E6AD2',
    slack: '#4A154B',
    'google-gmail': '#EA4335',
    'google-drive': '#0F9D58',
    'google-calendar': '#4285F4',
    github: '#181717',
    gitlab: '#FC6D26',
    clickup: '#7B68EE',
    figma: '#F24E1E',
    prometheus: '#E6522C',
    'claude-headless': '#D97757',
};
function svg(...kids) {
    const n = sv('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' });
    n.append(...kids);
    return n;
}
// 선 글리프 공통 — 획 굵기·끝맺음을 한 곳에서 정해 서비스끼리 굵기가 튀지 않게 한다.
const stroked = (d, w = 1.9) => sv('path', { d, stroke: 'currentColor', 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
const filled = (d) => sv('path', { d, fill: 'currentColor' });
// ── Notion — 페이지 테두리 + N. 원 마크와 같은 구성(획 굵은 N 한 글자). ──
const icNotion = () => svg(sv('rect', { x: 3.2, y: 2.6, width: 17.6, height: 18.8, rx: 2.6, stroke: 'currentColor', 'stroke-width': 1.9 }), stroked('M8.6 17V7.6L15.4 16.4V7', 2.1));
// ── Linear — 라운드 스퀘어 + 좌하단 모서리로 모이는 대각선 세 줄(원 마크의 구성).
//  세 줄을 대각선 **한쪽에만** 둔다 — 양쪽에 두면 빗금 패턴으로 읽혀 Linear 로 안 보인다(실측). ──
const icLinear = () => svg(sv('rect', { x: 2.6, y: 2.6, width: 18.8, height: 18.8, rx: 5, stroke: 'currentColor', 'stroke-width': 1.8 }), stroked('M3.0 6.2 17.8 21.0', 1.8), stroked('M3.0 11.4 12.6 21.0', 1.8), stroked('M3.0 16.6 7.4 21.0', 1.8));
// ── Slack — 캡슐 4 + 정사각 4 로 도는 바람개비. 원 마크의 격자(24 기준) 그대로. ──
function icSlack() {
    const n = svg();
    const cap = (x, y, w, h) => sv('rect', { x, y, width: w, height: h, rx: 2.52, fill: 'currentColor' });
    n.append(cap(0, 6.31, 11.36, 5.04), cap(12.65, 0, 5.04, 11.36), // 좌상 가로 · 우상 세로
    cap(12.65, 12.65, 11.36, 5.04), cap(6.31, 12.65, 5.04, 11.36), // 우하 가로 · 좌하 세로
    cap(6.31, 0, 5.04, 5.04), cap(18.96, 6.31, 5.04, 5.04), // 각 팔 끝의 정사각
    cap(12.65, 18.96, 5.04, 5.04), cap(0, 12.65, 5.04, 5.04));
    return n;
}
// ── Gmail — 봉투 + M 자 접힘. ──
const icGmail = () => svg(sv('rect', { x: 2.2, y: 4.9, width: 19.6, height: 14.2, rx: 2.4, stroke: 'currentColor', 'stroke-width': 1.9 }), stroked('M2.9 6.4 12 13.2 21.1 6.4'), stroked('M2.5 18.6V7.2M21.5 18.6V7.2', 1.9));
// ── Google Drive — 삼각형 + 중심에서 갈라지는 Y(원 마크의 3분할). ──
const icDrive = () => svg(stroked('M12 3.4 22 20.6H2Z', 1.9), stroked('M12 3.6V14.2', 1.7), stroked('M12 14.2 3.2 20.4', 1.7), stroked('M12 14.2 20.8 20.4', 1.7));
// ── Google 캘린더 — 달력 시트 + 31. 숫자가 이 브랜드의 식별자다. ──
function icCalendar() {
    const n = svg(sv('rect', { x: 3.2, y: 4.4, width: 17.6, height: 16.4, rx: 2.6, stroke: 'currentColor', 'stroke-width': 1.9 }), stroked('M8 2.9v3.4M16 2.9v3.4', 1.9), stroked('M3.4 9.4h17.2', 1.6));
    const t = sv('text', { x: 12, y: 18.1, 'text-anchor': 'middle', fill: 'currentColor',
        'font-size': 7.6, 'font-weight': 800, 'font-family': 'inherit' });
    t.textContent = '31';
    n.append(t);
    return n;
}
// ── GitHub — 옥토캣 실루엣(원 마크). ──
const icGithub = () => svg(filled('M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.77-.24.77-.54l-.01-1.9c-3.12.68-3.78-1.5-3.78-1.5-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.72.39-1.22.71-1.5-2.49-.29-5.11-1.25-5.11-5.55 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.42.11-2.97 0 0 .94-.3 3.09 1.15a10.7 10.7 0 0 1 5.62 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.55.23 2.69.11 2.97.72.79 1.15 1.79 1.15 3.02 0 4.31-2.62 5.26-5.12 5.54.4.35.76 1.03.76 2.08l-.01 3.08c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8z'));
// ── GitLab — 타누키(봉우리 3 · 아래 한 점으로 모이는 실루엣). 가운데 봉우리가 가장 높다. ──
const icGitlab = () => svg(filled('M12 22.4 1.3 10.6 4.5 2.6 7.6 10.6 12 1.4 16.4 10.6 19.5 2.6 22.7 10.6Z'));
// ── ClickUp — 위로 향하는 두꺼운 화살촉 + 그 위 삼각(원 마크의 상승 구성). ──
const icClickup = () => svg(filled('M2.8 18.4 12 10.6l9.2 7.8-2.9 3.4L12 15.9l-6.3 5.9Z'), filled('M12 2.2 17.4 8.6H6.6Z'));
// ── Figma — 5조각(좌 반원 3 · 우상 반원 1 · 우중 원 1). 원 마크의 구성 그대로.
//  단색이라 조각끼리 맞닿으면 한 덩어리로 뭉개진다 — 0.5 만큼 사이를 띄워 다섯 조각이 보이게 한다(실측). ──
function icFigma() {
    const n = svg();
    const g = 0.5; // 조각 사이 틈
    const left = (y) => filled(`M12 ${y + g}H9.25a2.75 2.75 0 0 0 0 5.5H12Z`);
    n.append(left(3), left(9), left(15), filled(`M12 ${3 + g}h2.75a2.75 2.75 0 0 1 0 5.5H12Z`), sv('circle', { cx: 15, cy: 12, r: 2.75, fill: 'currentColor' }));
    return n;
}
// ── Prometheus — 횃불(불꽃 + 손잡이 띠). ──
const icPrometheus = () => svg(filled('M12 2.2c3.5 3.3 5.3 5.8 5.3 8.8a5.3 5.3 0 0 1-10.6 0c0-1.8.7-3.3 2-4.8.2 1.5.9 2.3 1.7 2.5-.2-2.4.3-4.4 1.6-6.5z'), sv('rect', { x: 7.4, y: 17.9, width: 9.2, height: 3.6, rx: 1.3, fill: 'currentColor' }));
// ── Claude — 방사형 별빛(앤트로픽 마크의 성기). 길이가 조금씩 다른 살이 이 마크의 인상이다. ──
function icClaude() {
    const n = svg();
    const rays = [10.4, 8.2, 9.8, 8.6, 10.2, 8.3, 9.9, 8.5, 10.3, 8.4, 9.7, 8.7];
    rays.forEach((len, i) => {
        const a = (i / rays.length) * Math.PI * 2 - Math.PI / 2;
        const w = 1.35;
        const [cx, cy] = [12, 12];
        const [dx, dy] = [Math.cos(a), Math.sin(a)];
        const [px, py] = [-dy * w, dx * w]; // 뿌리 쪽 폭 — 끝으로 갈수록 뾰족해진다
        n.append(filled(`M${(cx + px).toFixed(2)} ${(cy + py).toFixed(2)}L${(cx + dx * len).toFixed(2)} ${(cy + dy * len).toFixed(2)}L${(cx - px).toFixed(2)} ${(cy - py).toFixed(2)}Z`));
    });
    return n;
}
const SVC_MARK = {
    notion: icNotion, linear: icLinear, slack: icSlack,
    'google-gmail': icGmail, 'google-drive': icDrive, 'google-calendar': icCalendar,
    github: icGithub, gitlab: icGitlab, clickup: icClickup, figma: icFigma,
    prometheus: icPrometheus, 'claude-headless': icClaude,
};
// 표에 없는 서비스(나중에 늘어난 것)도 화면이 깨지지 않게 — 이름 첫 글자 글리프로 떨어진다.
function fallbackMark(label) {
    return el('span', { class: 'svc-tile-ini', text: String(label || '?').trim().slice(0, 1).toUpperCase() });
}
// 서비스 타일 — on=연결됨(브랜드색) / off=미연결(무채색, 부모 hover 시 브랜드색으로 살아난다).
//  '켜져 있으면 색이 산다'가 이 화면에서 연결/미연결을 가르는 가장 빠른 신호다.
function svcTile(key, label, on) {
    const brand = SVC_BRAND[key];
    const mk = SVC_MARK[key];
    return el('span', {
        class: 'svc-tile' + (on ? '' : ' off'),
        style: brand ? '--svc-brand:' + brand : null,
    }, mk ? mk() : fallbackMark(label));
}
export { SVC_BRAND, SVC_MARK, svcTile };
