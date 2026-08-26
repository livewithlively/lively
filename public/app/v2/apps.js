// v2/apps.ts — 새 셸의 '앱' 레지스트리 + 런치패드 + 앱 프레임(#1719).
//  앱 = 클래식 화면(탭·페이지)을 엔티티로 올린 것. 새 셸이 아직 담지 못한 화면은 전부 여기 등록돼 있고,
//  런치패드(맥OS 런치패드 문법: 전체 화면 격자 + 검색)에서 열면 **같은 index.html 을 ?embed=1 로 iframe 에 실어**
//  중앙에 띄운다 — 클래식 코드를 한 줄도 옮기지 않고 새 셸 안에서 그대로 쓴다. 나중에 화면이 새 셸로 이식되면
//  이 표의 항목이 `native` 로 바뀌거나 빠진다(표가 곧 '아직 안 옮긴 것' 목록이다).
//  ⚠ 노출은 클래식과 같은 규칙(navOn — ui_nav 로 끈 탭은 여기서도 안 보인다).
import { el, navOn, sv } from '../core.js';
import { ICONS } from './icons.js';
import { sessionTermUrl } from '../lib/session-open.js'; // #1820 — 세션 주소는 한 곳에서만 만든다
import { listSessionApps, openAppSession } from './app-session.js';
import { openInstalledApp } from './app-instance.js';
// 표 한 줄 = 앱 하나. 순서 = 런치패드 순서. 클래식 탭 순서(홈·AI세션·프로젝트·WIKI·맥락관리·설정·가이드)를 따른다.
export const APPS = [
    { key: 'dashboard', title: '홈(클래식)', desc: '옛 대시보드 — 내 프로젝트·알림·세션·팀 로그 위젯', route: 'dashboard', tab: 'dashboard', icon: 'home' },
    { key: 'terminal', title: 'AI 세션', desc: '박스에서 도는 AI 세션 전체 · 새 세션 만들기', route: 'terminal', tab: 'terminal', icon: 'chat' }, // 말풍선 — 사이드바 세션 행과 같은 붓(원준 2026-08-26 "터미널 아이콘 말고 말풍선으로 통일")
    { key: 'projects2', title: '프로젝트', desc: '보드 · 리스트 · 타임라인 · 태스크', route: 'projects2', tab: 'projects2', icon: 'proj' },
    { key: 'knowledge', title: 'WIKI', desc: '지식 트리 · 문서 · 검토 큐', route: 'knowledge', tab: 'knowledge', icon: 'wiki' },
    { key: 'context', title: '맥락 관리', desc: '수집(연결) · 증류 · 분류 · 자동 관리 파이프라인', route: 'context', tab: 'context', icon: 'ctx' },
    { key: 'sessions', title: '세션 이력', desc: '중앙에 기록된 내 세션 대화 이어보기', route: 'sessions', tab: 'terminal', icon: 'sess' },
    { key: 'system', title: '설정', desc: '내 설정 · 조직 · 구성원 · 운영', route: 'system', tab: 'system', icon: 'sys' },
    { key: 'learn', title: '사용 가이드', desc: '둘러보기 · 문서 · 시작하기', route: 'learn', tab: null, icon: 'learn' },
];
// 클래식 라우트 첫 세그먼트 → 앱 키. 새 셸에서 옛 딥링크(#/knowledge/…, #/projects2/p/12 …)가 들어오면
//  이 표로 '어느 앱 프레임에 실을지'를 정한다 — 북마크·공유 링크가 새 셸에서도 그대로 산다.
export const CLASSIC_PAGES = {
    dashboard: 'dashboard', terminal: 'terminal', projects2: 'projects2', projects: 'projects2',
    knowledge: 'knowledge', k: 'knowledge', 'k-edit': 'knowledge', trash: 'knowledge',
    context: 'context', domainmap: 'context', categories: 'context',
    system: 'system', learn: 'learn', start: 'learn', onboarding: 'learn', install: 'learn',
    sessions: 'sessions', activate: 'system', f: 'knowledge',
};
export function visibleApps() { return APPS.filter((a) => !a.tab || navOn(a.tab)); }
// ── 최근 쓴 앱(#1954) — 홈 한 줄이 읽는 기억. 이 기기의 내 습관이라 브라우저에 둔다(서버 저장 아님). ──
//  ⚠ 이름을 `*_KEY` 로 두지 않는다 — gitleaks 의 generic-api-key 룰이 브라우저 저장소 이름을 시크릿으로 오인해
//   CI 시크릿 스캔이 떨어진다(#1954 실측). 값은 localStorage 칸 이름일 뿐이다.
const RECENT_STORE = 'lively_v2_recent_apps';
const RECENT_MAX = 12;
function readRecent() {
    try {
        const v = JSON.parse(localStorage.getItem(RECENT_STORE) || '[]');
        return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    }
    catch {
        return [];
    }
}
/** 앱을 열었다 — 맨 앞으로. 같은 앱을 되풀이 열어도 줄이 늘지 않는다. */
export function noteAppUse(key) {
    if (!key || !appByKey(key))
        return;
    const next = [key, ...readRecent().filter((k) => k !== key)].slice(0, RECENT_MAX);
    try {
        localStorage.setItem(RECENT_STORE, JSON.stringify(next));
    }
    catch { /* 못 남겨도 이번 화면은 된다 */ }
}
/**
 * 최근 쓴 앱 n개. 기록이 모자라면 **표 순서로 채운다** — 처음 온 사람에게 빈 줄을 보이지 않기 위해서다
 * (빈 줄은 '아직 아무것도 없다'가 아니라 '고장'으로 읽힌다).
 */
export function recentApps(n) {
    const vis = visibleApps();
    const byKey = new Map(vis.map((a) => [a.key, a]));
    const out = [];
    for (const k of readRecent()) {
        const a = byKey.get(k);
        if (a && !out.includes(a))
            out.push(a);
        if (out.length >= n)
            return out;
    }
    for (const a of vis) {
        if (!out.includes(a))
            out.push(a);
        if (out.length >= n)
            break;
    }
    return out;
}
export function appByKey(key) { return APPS.find((a) => a.key === key) || null; }
// 임베드 URL — **같은 문서**를 ?embed=1 로. location.pathname 은 이미 프리뷰 프리픽스(/preview/<id>/ui/)를 포함하므로
//  appUrl 을 거치지 않는다(거치면 프리픽스가 두 번 붙는다). 같은 경로 = 같은 API 베이스 = 같은 인증.
export function embedUrl(hash) {
    const h = hash.replace(/^#\/?/, '');
    return location.pathname + '?embed=1#/' + h;
}
export function classicUrl(hash) {
    const h = hash.replace(/^#\/?/, '');
    return location.pathname + '?ui=classic#/' + h;
}
// 라이브 터미널 페이지(클래식 terminal.html) — 세션 하나의 xterm 화면.
//  embed=1(#1744): 이 페이지가 **세션 화면 안 프레임**으로 실릴 때. 그 안의 상단바·파일 탐색기는 세션 화면 상단바와
//   우패널로 이미 합쳐졌으므로 프레임 쪽은 크롬 없이 터미널만 그린다(상단바 둘이 겹쳐 보이던 것을 없앤다).
//   프레임 밖(단독 탭)에서는 embed 없이 종전 그대로 — 이 주소를 아는 곳이 여럿이다(프로젝트 화면·활동 로그 등).
export function terminalUrl(id, label, node, opts) {
    return sessionTermUrl(id, { label, node, embed: opts?.embed }); // #1820 — 주소를 만드는 곳은 한 곳뿐이다
}
// 세션 하나만 담은 **팝아웃 창**(#1744) — 세션 화면의 [새 탭]이 여는 주소.
//  종전엔 terminal.html(터미널만)을 열었는데, 이제 같은 앱을 `?solo=1` 로 열어 **가운데 대화창 + 우패널**을 그대로
//  띄운다(왼쪽 사이드바만 없다 — v2/main.ts bootV2). 즉 새 탭과 본 화면이 같은 컴포넌트를 쓴다.
export function soloSessionUrl(id) {
    return location.pathname + '?solo=1#/s/' + encodeURIComponent(id);
}
// ── 아이콘(라인, 채움 없음 — DS 규약) ──
const ICON_PATHS = {
    //  #2016 — 선 아이콘은 icons.ts 한 벌이다. 홈(클래식)은 옛 대시보드라 위젯 판 넷, 설정은 이빨 있는 톱니.
    home: ICONS.dashboard, term: ICONS.term, chat: ICONS.chat, proj: ICONS.proj, wiki: ICONS.wiki, ctx: ICONS.ctx,
    sys: ICONS.sys, learn: ICONS.learn, liv: ICONS.liv, sess: ICONS.sess, web: ICONS.web,
};
export function appIcon(icon, cls) {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'v2-ic ' + (cls || ''));
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('d', ICON_PATHS[icon]);
    svg.append(path);
    return svg;
}
const GLASS_ART = {
    // 대시보드 — 머리띠(서리) · 본문 판(색) · 곁 위젯 하나(서리). 판 넷은 번잡했다.
    //  세 덩어리면 '화면 배치'가 읽히고, 그 이상은 잔무늬가 된다.
    home: {
        span: [5, 15, 40, 58],
        color: '<rect x="5" y="15" width="33" height="43" rx="4.5"/>',
        frost: '<rect x="5" y="5" width="54" height="15" rx="4.5"/><rect x="42" y="25" width="17" height="33" rx="4.5"/>',
        punch: '<rect x="11" y="29" width="20" height="2.8" rx="1.4"/><rect x="11" y="37" width="13" height="2.8" rx="1.4"/>',
    },
    // 터미널 창 — 색 타이틀바 + 서리 본문. 프롬프트는 **유리 위에** 색으로 얹는다(over).
    //  흰색으로 뚫으면 옅은 서리 위라 대비가 안 나 안 읽힌다.
    term: {
        span: [5, 11, 59, 53],
        color: '<path d="M10.5 11h43a5 5 0 0 1 5 5v7.5H5.5V16a5 5 0 0 1 5-5z"/>',
        frost: '<path d="M5.5 20.5h53V48a5 5 0 0 1-5 5h-43a5 5 0 0 1-5-5z"/>',
        punch: '<circle cx="14" cy="17.5" r="2.5"/><circle cx="22.6" cy="17.5" r="2.5"/><circle cx="31.2" cy="17.5" r="2.5"/>',
        over: '<path d="M15 32.5l7 6.4-7 6.4" stroke-width="3.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
            + '<path d="M28 45.4h14.5" stroke-width="3.7" fill="none" stroke-linecap="round"/>',
    },
    // 태스크 목록 + 체크 — 서리 카드에 흰 줄(할 일) 세 개, 그 위를 색 체크가 가로지른다.
    //  체크의 오른팔은 카드 **밖으로 나간다** — 유리 안에서는 부옇고 밖에서는 선명하다(겹침의 문법).
    proj: {
        span: [13, 14, 58, 46],
        color: '<path d="M24.5 36.5l7.5 7.5L58 13.5" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
        frost: '<rect x="5" y="10" width="39" height="44" rx="5.5"/>',
        punch: '<rect x="13" y="21" width="21" height="3.6" rx="1.8"/><rect x="13" y="31" width="15" height="3.6" rx="1.8"/>',
    },
    // 펼친 책 — 오른쪽 면이 색, 왼쪽 면이 서리. 두 면의 재질이 달라 펼쳐진 게 읽힌다.
    wiki: {
        span: [33, 11, 59, 53],
        color: '<path d="M33.6 17.2c4.9-3.9 11.3-6 18.1-6h4.7a2.6 2.6 0 0 1 2.6 2.6v30.5a2.6 2.6 0 0 1-2.6 2.6h-4.7c-6.8 0-13.2 2.1-18.1 6z"/>',
        frost: '<path d="M30.4 17.2c-4.9-3.9-11.3-6-18.1-6H7.6A2.6 2.6 0 0 0 5 13.8v30.5a2.6 2.6 0 0 0 2.6 2.6h4.7c6.8 0 13.2 2.1 18.1 6z"/>',
    },
    // 깔때기 — 위로 들어온 것이 좁아지며 걸러진다. 수집→증류→분류가 이 형태 하나에 다 있다.
    //  서리 입구 바가 깔때기 아가리를 덮는다(레퍼런스 폴더의 '탭이 삐져나오는' 문법과 같은 자리).
    ctx: {
        span: [8, 17, 56, 56],
        color: '<path d="M9.5 17h45a2 2 0 0 1 1.5 3.3L38.2 40.4v11.3a2 2 0 0 1-1.1 1.8l-6.8 3.4A2 2 0 0 1 27.4 55V40.4L8 20.3A2 2 0 0 1 9.5 17z"/>',
        frost: '<rect x="8" y="6" width="38" height="12.5" rx="4"/>',
    },
    // 겹친 말풍선 — 세션 이력의 실체는 시간이 아니라 **지난 대화 기록**이다.
    //  시계는 게으른 은유였다: '이력=시계'는 이 앱이 무엇인지 아무것도 말하지 않는다(원준 2026-08-21 반려).
    // AI 세션 — 말풍선 하나(색) + 흰 줄 둘. 사이드바 세션 행의 말풍선과 같은 뜻(#2016 6차, 터미널 창 아이콘 폐기).
    chat: {
        span: [5, 8, 59, 56],
        color: '<path d="M14 8h36a9 9 0 0 1 9 9v22a9 9 0 0 1-9 9H30l-13 11 1.8-11H14a9 9 0 0 1-9-9V17a9 9 0 0 1 9-9z"/>',
        punch: '<rect x="15" y="20" width="26" height="3.6" rx="1.8"/><rect x="15" y="29" width="17" height="3.6" rx="1.8"/>',
    },
    //  앞 풍선이 색, 뒤 풍선이 서리 — 뒤집기 전(앞이 서리)에는 색 덩어리가 뒤로 밀려 창백했다.
    //  ⚠ 안의 흰 것은 **줄**이지 점이 아니다. 점 셋은 '지금 입력 중'으로 읽혀 지난 기록과 뜻이 어긋난다.
    sess: {
        span: [5, 21, 43, 48],
        frost: '<path d="M36 7h17a6 6 0 0 1 6 6v14a6 6 0 0 1-6 6H36a6 6 0 0 1-6-6V13a6 6 0 0 1 6-6z"/>',
        color: '<path d="M11 21h26a6 6 0 0 1 6 6v13a6 6 0 0 1-6 6h-9.5l-9 8 1.2-8H11a6 6 0 0 1-6-6V27a6 6 0 0 1 6-6z"/>',
        punch: '<rect x="11.5" y="29.5" width="20" height="3.2" rx="1.6"/><rect x="11.5" y="36.5" width="13" height="3.2" rx="1.6"/>',
        frostFirst: true,
    },
    // 톱니 — **별이 되는 조건**을 피한 비율이다. 앞판은 골이 4°뿐이라 이빨 사이가 뾰족한 점으로 만났고,
    //  그게 정확히 별의 정의였다. 기어로 읽히려면 ① 골이 원호로 충분히 보이고(12°) ② 깊이가 얕고(22%)
    //  ③ 이빨 사이로 **원형 몸통**이 드러나야 한다. 실제 기어는 피치원에서 이빨과 골의 폭이 비슷하다.
    //  8톱니 · 이빨 20° · 옆면 6.5°×2 · 골 12° · 팁 26 / 골바닥 20.4.
    sys: {
        span: [7, 6, 58, 58],
        muted: true, // 기계는 무채색으로
        color: '<path d="M27.49 6.39A26 26 0 0 1 36.51 6.39L37.79 12.44A20.4 20.4 0 0 1 41.73 14.07L46.91 10.7A26 26 0 0 1 53.3 17.09L49.93 22.27A20.4 20.4 0 0 1 51.56 26.21L57.61 27.49A26 26 0 0 1 57.61 36.51L51.56 37.79A20.4 20.4 0 0 1 49.93 41.73L53.3 46.91A26 26 0 0 1 46.91 53.3L41.73 49.93A20.4 20.4 0 0 1 37.79 51.56L36.51 57.61A26 26 0 0 1 27.49 57.61L26.21 51.56A20.4 20.4 0 0 1 22.27 49.93L17.09 53.3A26 26 0 0 1 10.7 46.91L14.07 41.73A20.4 20.4 0 0 1 12.44 37.79L6.39 36.51A26 26 0 0 1 6.39 27.49L12.44 26.21A20.4 20.4 0 0 1 14.07 22.27L10.7 17.09A26 26 0 0 1 17.09 10.7L22.27 14.07A20.4 20.4 0 0 1 26.21 12.44Z"/>',
        frost: '<circle cx="32" cy="32" r="10.6"/>',
    },
    // 행성 — 고리가 구체를 **감싼다**. 앞판은 타원이 구체 '위에 얹혀' 있어 행성으로 안 읽혔다(원준 2026-08-21).
    //  감싸려면 고리를 두 번 그린다: ① 고리 전체를 구체 **밑에** → ② 구체 → ③ 앞쪽 반만 다시 **위에**(overFrost).
    //  앞쪽 반은 클립이 아니라 기하로 잘랐다 — 바깥·안쪽 타원의 아래쪽 호만 이은 고리 조각.
    web: {
        span: [12, 12, 52, 52],
        frost: '<path fill-rule="evenodd" d="M2 32A30 9.6 0 1 0 62 32A30 9.6 0 1 0 2 32ZM6.8 32A25.2 5.6 0 1 1 57.2 32A25.2 5.6 0 1 1 6.8 32Z" transform=\"rotate(-18 32 32)\"/>',
        color: '<circle cx="32" cy="32" r="20"/>',
        overFrost: '<path d="M2 32A30 9.6 0 0 0 62 32L57.2 32A25.2 5.6 0 0 1 6.8 32Z" transform=\"rotate(-18 32 32)\"/>',
        frostFirst: true,
    },
    // 학사모 — 색 판(위에서 보는 면) + 서리 몸통.
    learn: {
        span: [5, 8, 59, 34],
        color: '<path d="M30.8 7.9a2.8 2.8 0 0 1 2.4 0l25.4 11.4a1.7 1.7 0 0 1 0 3.1L33.2 33.8a2.8 2.8 0 0 1-2.4 0L5.4 22.4a1.7 1.7 0 0 1 0-3.1z"/>',
        frost: '<path d="M15 28.5v13.4c0 5.8 7.6 10.5 17 10.5s17-4.7 17-10.5V28.5L33.4 35.1a4.2 4.2 0 0 1-2.8 0z"/>',
    },
    // 사각 넷 — 둘은 색, 둘은 서리. 대각으로 엇갈린다.
    apps: {
        span: [5, 5, 59, 59],
        color: '<rect x="5.5" y="5.5" width="24" height="24" rx="5.5"/><rect x="34.5" y="34.5" width="24" height="24" rx="5.5"/>',
        frost: '<rect x="34.5" y="5.5" width="24" height="24" rx="5.5"/><rect x="5.5" y="34.5" width="24" height="24" rx="5.5"/>',
    },
    // 리브 — 색 고리 + 유리 원반 + 색 코어. 펄스 돗이 퍼져 나가는 모양 그대로다.
    //  고리를 서리로 두면 세트에서 혼자 창백해진다 — 색 덩어리를 바깥에 준다.
    liv: {
        span: [7, 7, 57, 57],
        color: '<path fill-rule="evenodd" d="M32 7.5a24.5 24.5 0 1 0 0 49 24.5 24.5 0 1 0 0-49Zm0 5.4a19.1 19.1 0 1 1 0 38.2 19.1 19.1 0 1 1 0-38.2Z"/>',
        frost: '<circle cx="32" cy="32" r="16"/>',
        over: '<circle cx="32" cy="32" r="8.4"/>',
    },
};
let glassSeq = 0;
/** 런치패드용 유리 앱 아이콘(64×64). 글자 옆 16px 자리에는 이걸 쓰지 말고 appIcon() 을 쓴다. */
export function appGlassIcon(icon, cls) {
    const n = ++glassSeq;
    const a = GLASS_ART[icon] || GLASS_ART.apps;
    const color = a.color || '', frost = a.frost || '';
    const sp = a.span || [6, 4, 58, 60];
    const pre = a.muted ? '--gi-m' : '--gi-r';
    const R = [0, 1, 2, 3].map((i) => `var(${pre}${i})`);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.setAttribute('class', 'v2-gi ' + (cls || ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML =
        `<defs>`
            + `<linearGradient id="gk${n}" gradientUnits="userSpaceOnUse" x1="${sp[0]}" y1="${sp[1]}" x2="${sp[2]}" y2="${sp[3]}">`
            + `<stop offset="0" stop-color="${R[0]}"/><stop offset=".32" stop-color="${R[1]}"/>`
            + `<stop offset=".66" stop-color="${R[2]}"/><stop offset="1" stop-color="${R[3]}"/></linearGradient>`
            + `<linearGradient id="gf${n}" gradientUnits="userSpaceOnUse" x1="8" y1="6" x2="56" y2="58">`
            + `<stop offset="0" stop-color="currentColor" stop-opacity="1"/>`
            + `<stop offset="1" stop-color="currentColor" stop-opacity=".74"/></linearGradient>`
            + `<linearGradient id="gh${n}" gradientUnits="userSpaceOnUse" x1="6" y1="10" x2="34" y2="46">`
            + `<stop offset="0" stop-color="#FFFFFF" stop-opacity="0"/>`
            + `<stop offset=".45" stop-color="#FFFFFF" stop-opacity=".26"/>`
            + `<stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>`
            + `<clipPath id="gp${n}">${frost}</clipPath>`
            + `<filter id="gs${n}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.6"/></filter>`
            + `</defs>`
            + (a.frostFirst
                ? `<g class="v2-gi-frost" fill="url(#gf${n})">${frost}</g><g fill="url(#gk${n})" stroke="url(#gk${n})">${color}</g>`
                : `<g fill="url(#gk${n})" stroke="url(#gk${n})">${color}</g>`
                    + `<g class="v2-gi-frost" fill="url(#gf${n})">${frost}</g>`
                    + `<g clip-path="url(#gp${n})" filter="url(#gs${n})" fill="url(#gk${n})" stroke="url(#gk${n})" opacity=".5">${color}</g>`)
            + `<g clip-path="url(#gp${n})"><rect x="-18" y="-12" width="26" height="120" fill="url(#gh${n})" transform="rotate(-32 32 32)"/></g>`
            + `<g clip-path="url(#gp${n})" class="v2-gi-edge">`
            + (a.rim ? `<g fill="none" stroke="#FFFFFF" stroke-opacity=".8" stroke-width="2" transform="translate(-1.1 -1.1)">${frost}</g>` : '')
            + `<g fill="none" stroke="#0B2A3A" stroke-opacity=".085" stroke-width="2.6" transform="translate(1.3 1.3)">${frost}</g>`
            + `</g>`
            + (a.punch ? `<g class="v2-gi-punch">${a.punch}</g>` : '')
            + (a.over ? `<g fill="${R[3]}" stroke="${R[3]}">${a.over}</g>` : '')
            + (a.overFrost ? `<g class="v2-gi-frost" fill="url(#gf${n})">${a.overFrost}</g>` : '');
    return svg;
}
// ── 런치패드 오버레이 ──
//  전체 화면을 덮는 격자. 검색(제목·설명 부분일치)·Esc 로 닫기.
//   · 화면 앱(APPS 표) 클릭 = #/app/<key> 로 이동(가운데 iframe).
//   · 설치된 세션 앱(org_app, #1780) 클릭 = openAppSession → 앱 세션을 열고 그 대화 화면으로. 동의(grant)가 없으면
//     그때 동의 창이 뜬다. 세션 앱은 비동기로 불러와(listSessionApps) 도착하면 격자에 덧그린다(없으면 화면앱만 보인다).
let padEl = null;
export function openLaunchpad() {
    closeLaunchpad();
    const apps = visibleApps();
    let sApps = [];
    const grid = el('div', { class: 'v2-pad-grid', role: 'list' });
    const input = el('input', { class: 'v2-pad-search', type: 'search', placeholder: '앱 찾기', 'aria-label': '앱 찾기' });
    const draw = () => {
        const q = input.value.trim().toLowerCase();
        // 이름에 맞은 것이 설명에만 맞은 것보다 앞에 온다 — Enter 가 맨 앞을 여니 순서가 곧 정답이어야 한다.
        //  ('프' 를 치면 설명에 '프로젝트'가 든 홈이 아니라 프로젝트 앱이 먼저다.) sort 는 안정 정렬이라 동점은 원래 차례.
        const rank = (t) => { const i = t.toLowerCase().indexOf(q); return i === 0 ? 0 : i > 0 ? 1 : 2; };
        const screen = apps.filter((a) => !q || a.title.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q))
            .sort((a, b) => rank(a.title) - rank(b.title)).map((a) => el('a', { class: 'v2-pad-item', role: 'listitem', href: '#/app/' + a.key, title: a.desc, onclick: () => closeLaunchpad() }, el('span', { class: 'v2-pad-ico' }, appGlassIcon(a.icon)), el('b', { text: a.title })));
        const session = sApps.filter((a) => a.id !== 'ai-session')
            .filter((a) => !q || a.title.toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
            .sort((a, b) => rank(a.title) - rank(b.title)).map((a) => {
            const hasUi = a.pages.length > 0; // UI 앱이면 UI 를 연다(샌드박스 iframe), 아니면 세션 앱.
            return el('button', { class: 'v2-pad-item v2-pad-item--app', role: 'listitem', type: 'button',
                title: hasUi ? '앱 — 열면 이 앱의 화면이 창으로 뜹니다' : '세션 앱 — 열면 이 앱 전용 AI 세션이 뜹니다',
                onclick: () => { closeLaunchpad(); if (hasUi || a.system)
                    void openInstalledApp(a);
                else
                    void openAppSession(a.id, { title: a.title }); } }, el('span', { class: 'v2-pad-ico' }, appGlassIcon(hasUi ? 'liv' : 'term')), el('b', { text: a.title }), el('span', { class: 'v2-pad-badge', text: hasUi ? '앱' : '세션 앱' }));
        });
        grid.replaceChildren(...screen, ...session);
        grid.classList.toggle('v2-pad-grid--q', !!q); // 검색 중이면 첫 칸이 Enter 로 열릴 자리 — 그걸 보인다.
        if (!grid.childElementCount)
            grid.append(el('p', { class: 'v2-pad-empty', text: '맞는 앱이 없어요.' }));
    };
    input.addEventListener('input', draw);
    // 스포트라이트처럼 Enter 는 맨 앞 결과를 연다 — 이름을 몇 글자 치고 바로 들어가는 길.
    input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter')
            return;
        const first = grid.querySelector('.v2-pad-item');
        if (first) {
            e.preventDefault();
            first.click();
        }
    });
    void listSessionApps().then((a) => { if (padEl) {
        sApps = a;
        draw();
    } });
    // 검색칸 하나만 띄운다(맥 스포트라이트) — 제목·설명 줄·닫기 버튼은 없앴다.
    //  닫기는 Esc 와 배경 클릭이 이미 하고, 칸 오른쪽 esc 키캡이 그걸 알린다.
    padEl = el('div', { class: 'v2-pad', role: 'dialog', 'aria-label': '앱 찾기', onclick: (e) => { if (e.target === padEl)
            closeLaunchpad(); } }, el('div', { class: 'v2-pad-field' }, sv('svg', { class: 'v2-pad-mag', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('circle', { cx: '11', cy: '11', r: '6.75' }), sv('path', { d: 'M16.1 16.1 21 21' })), input, el('kbd', { class: 'v2-pad-esc', text: 'esc' })), grid);
    document.body.append(padEl);
    draw();
    input.focus();
    document.addEventListener('keydown', padKey);
}
function padKey(e) { if (e.key === 'Escape')
    closeLaunchpad(); }
export function closeLaunchpad() { if (padEl) {
    padEl.remove();
    padEl = null;
} document.removeEventListener('keydown', padKey); }
// ── 앱 프레임 — 중앙에 iframe 하나. 헤더 한 줄(앱 이름 · 새 탭 · 클래식으로) 외엔 크롬이 없다. ──
//  #1841 — 안의 화면이 프로젝트 탭 문법의 머리(빵부스러기·뷰 탭·툴바)를 스스로 그리는 앱(FRAMELESS)은 이 띠를 안 단다.
//   '클래식 화면 · 그대로 실림' 띠가 그 머리 위에 한 줄 더 얹히면 제목이 두 번 보이고 액자 티가 난다. 새 탭 열기는 그 화면의 ⋯ 메뉴가 든다.
const FRAMELESS = new Set(['terminal', 'projects2', 'knowledge', 'context', 'learn', 'start', 'onboarding']);
export function appFrame(hash, title, opts) {
    const src = opts?.src || embedUrl(hash);
    const frame = el('iframe', { class: 'v2-frame', src, title, loading: 'eager', allow: 'clipboard-read; clipboard-write' });
    // 하위 라우트(#/k/… · #/trash · #/start/…)도 같은 앱이다 — CLASSIC_PAGES 로 앱 키를 먼저 접고 판정한다.
    //  (안 접으면 문서 페이지에만 '클래식 화면 · 그대로 실림' 띠가 되살아난다 — #1841 실측)
    const seg = hash.replace(/^#\/?/, '').split(/[/?]/)[0];
    const key = CLASSIC_PAGES[seg] || seg;
    frame.dataset.appKey = key; // #2043 — 같은 앱이면 셸이 액자를 다시 싣지 않고 안의 주소만 바꾼다(main.ts 클래식 분기)
    if (!opts?.live && FRAMELESS.has(key)) {
        const pop = el('a', { class: 'v2-frame-pop', href: classicUrl(hash), target: '_blank', rel: 'noopener', title: '새 탭에서 열기', 'aria-label': '새 탭에서 열기', text: '↗' });
        return el('div', { class: 'v2-app v2-app-frameless' }, pop, frame);
    }
    const head = el('div', { class: 'v2-frame-h' }, el('b', { class: 'v2-frame-t', text: title }), el('span', { class: 'v2-frame-sub', text: opts?.live ? '라이브 세션' : '클래식 화면 · 그대로 실림' }), el('span', { class: 'v2-frame-acts' }, el('a', { class: 'btn-text', href: opts?.src ? src : classicUrl(hash), target: '_blank', rel: 'noopener', text: '새 탭에서 열기 ↗' })));
    return el('div', { class: 'v2-app' }, head, frame);
}
