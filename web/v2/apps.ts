// v2/apps.ts — 새 셸의 '앱' 레지스트리 + 런치패드 + 앱 프레임(#1719).
//  앱 = 클래식 화면(탭·페이지)을 엔티티로 올린 것. 새 셸이 아직 담지 못한 화면은 전부 여기 등록돼 있고,
//  런치패드(맥OS 런치패드 문법: 전체 화면 격자 + 검색)에서 열면 **같은 index.html 을 ?embed=1 로 iframe 에 실어**
//  중앙에 띄운다 — 클래식 코드를 한 줄도 옮기지 않고 새 셸 안에서 그대로 쓴다. 나중에 화면이 새 셸로 이식되면
//  이 표의 항목이 `native` 로 바뀌거나 빠진다(표가 곧 '아직 안 옮긴 것' 목록이다).
//  ⚠ 노출은 클래식과 같은 규칙(navOn — ui_nav 로 끈 탭은 여기서도 안 보인다).
import { el, navOn } from '../core.js';
import { sessionTermUrl } from '../lib/session-open.js';   // #1820 — 세션 주소는 한 곳에서만 만든다
import { listSessionApps, openAppSession, type SessionApp } from './app-session.js';
import { openAppUi } from './app-ui.js';

export interface AppDef {
  key: string;        // 안정 키(= 클래식 data-tab 슬러그 또는 페이지 이름)
  title: string;      // 사람 말
  desc: string;       // 한 줄
  route: string;      // 클래식 해시(#/ 뒤) — iframe 에 실릴 경로
  tab: string | null; // navOn 게이팅에 쓸 클래식 탭 키(없으면 항상 노출)
  icon: 'home' | 'term' | 'proj' | 'wiki' | 'ctx' | 'sys' | 'learn' | 'liv' | 'sess' | 'hist' | 'web' | 'apps';
  // 무엇으로 그리는가. 없으면 'classic'(같은 index.html 을 ?embed=1 로 iframe).
  //  'browser' = 브라우저 서피스(#1829) — 우리 화면이 아니라 **남의 웹**이라 iframe 이 아니라 `<webview>` 로 띄운다
  //   (사이트가 X-Frame-Options 로 프레임 삽입을 막기 때문 — web/v2/browser-surface.ts 머리말).
  kind?: 'classic' | 'browser';
  home?: string;      // kind='browser' 의 첫 주소
}

// 표 한 줄 = 앱 하나. 순서 = 런치패드 순서. 클래식 탭 순서(홈·AI세션·프로젝트·WIKI·맥락관리·설정·가이드)를 따른다.
export const APPS: AppDef[] = [
  { key: 'dashboard', title: '홈(클래식)', desc: '옛 대시보드 — 내 프로젝트·알림·세션·팀 로그 위젯', route: 'dashboard', tab: 'dashboard', icon: 'home' },
  { key: 'terminal', title: 'AI 세션', desc: '박스에서 도는 AI 세션 전체 · 새 세션 만들기', route: 'terminal', tab: 'terminal', icon: 'term' },
  { key: 'projects2', title: '프로젝트', desc: '보드 · 리스트 · 타임라인 · 태스크', route: 'projects2', tab: 'projects2', icon: 'proj' },
  { key: 'knowledge', title: 'WIKI', desc: '지식 트리 · 문서 · 검토 큐', route: 'knowledge', tab: 'knowledge', icon: 'wiki' },
  { key: 'context', title: '맥락 관리', desc: '수집(연결) · 증류 · 분류 · 자동 관리 파이프라인', route: 'context', tab: 'context', icon: 'ctx' },
  { key: 'sessions', title: '세션 이력', desc: '중앙에 기록된 내 세션 대화 이어보기', route: 'sessions', tab: 'terminal', icon: 'hist' },
  { key: 'system', title: '설정', desc: '내 설정 · 조직 · 구성원 · 운영', route: 'system', tab: 'system', icon: 'sys' },
  { key: 'web', title: '웹', desc: '주소를 넣으면 이 화면 안에서 그대로 — 데스크톱 앱에서만 안에 열립니다', route: 'web', tab: null, icon: 'web',
    kind: 'browser', home: 'https://www.google.com/' },
  { key: 'learn', title: '사용 가이드', desc: '둘러보기 · 문서 · 시작하기', route: 'learn', tab: null, icon: 'learn' },
];

// 클래식 라우트 첫 세그먼트 → 앱 키. 새 셸에서 옛 딥링크(#/knowledge/…, #/projects2/p/12 …)가 들어오면
//  이 표로 '어느 앱 프레임에 실을지'를 정한다 — 북마크·공유 링크가 새 셸에서도 그대로 산다.
export const CLASSIC_PAGES: Record<string, string> = {
  dashboard: 'dashboard', terminal: 'terminal', projects2: 'projects2', projects: 'projects2',
  knowledge: 'knowledge', k: 'knowledge', 'k-edit': 'knowledge', trash: 'knowledge',
  context: 'context', domainmap: 'context', categories: 'context',
  system: 'system', learn: 'learn', start: 'learn', onboarding: 'learn', install: 'learn',
  sessions: 'sessions', activate: 'system', f: 'knowledge',
};

export function visibleApps(): AppDef[] { return APPS.filter((a) => !a.tab || navOn(a.tab)); }
export function appByKey(key: string): AppDef | null { return APPS.find((a) => a.key === key) || null; }

// 임베드 URL — **같은 문서**를 ?embed=1 로. location.pathname 은 이미 프리뷰 프리픽스(/preview/<id>/ui/)를 포함하므로
//  appUrl 을 거치지 않는다(거치면 프리픽스가 두 번 붙는다). 같은 경로 = 같은 API 베이스 = 같은 인증.
export function embedUrl(hash: string): string {
  const h = hash.replace(/^#\/?/, '');
  return location.pathname + '?embed=1#/' + h;
}
export function classicUrl(hash: string): string {
  const h = hash.replace(/^#\/?/, '');
  return location.pathname + '?ui=classic#/' + h;
}
// 라이브 터미널 페이지(클래식 terminal.html) — 세션 하나의 xterm 화면.
//  embed=1(#1744): 이 페이지가 **세션 화면 안 프레임**으로 실릴 때. 그 안의 상단바·파일 탐색기는 세션 화면 상단바와
//   우패널로 이미 합쳐졌으므로 프레임 쪽은 크롬 없이 터미널만 그린다(상단바 둘이 겹쳐 보이던 것을 없앤다).
//   프레임 밖(단독 탭)에서는 embed 없이 종전 그대로 — 이 주소를 아는 곳이 여럿이다(프로젝트 화면·활동 로그 등).
export function terminalUrl(id: string, label: string, node?: string | null, opts?: { embed?: boolean }): string {
  return sessionTermUrl(id, { label, node, embed: opts?.embed });   // #1820 — 주소를 만드는 곳은 한 곳뿐이다
}
// 세션 하나만 담은 **팝아웃 창**(#1744) — 세션 화면의 [새 탭]이 여는 주소.
//  종전엔 terminal.html(터미널만)을 열었는데, 이제 같은 앱을 `?solo=1` 로 열어 **가운데 대화창 + 우패널**을 그대로
//  띄운다(왼쪽 사이드바만 없다 — v2/main.ts bootV2). 즉 새 탭과 본 화면이 같은 컴포넌트를 쓴다.
export function soloSessionUrl(id: string): string {
  return location.pathname + '?solo=1#/s/' + encodeURIComponent(id);
}

// ── 아이콘 12종 (#1841) — 하나의 키라인 격자 위에 다시 그렸다. ────────────────
//  왜 통째로 다시 그렸나: 종전 글리프는 눈대중으로 찍은 좌표라 같은 세트로 안 보였다 —
//   지구본만 반지름 9로 혼자 크고, 프로젝트만 모서리가 안 깎였고, 책등은 두 번 그어져 그 선만
//   두꺼웠고, 설정은 길이가 제각각인 선 8개라 톱니가 아니라 해로 읽혔다.
//  규격(전 아이콘 공통): 격자 24 · 작업영역 20 · 사각 키라인 17.2 · 원 키라인 Ø17.2 ·
//   모서리 2.4(바깥)/1.2(안쪽) · 선 1.7 round cap·join(디자인 시스템 tabIcon 문법 그대로).
//  ⚠ 값은 innerHTML(<path>/<rect>/<circle> 섞임)이다 — dash/icons.ts·panes-kit.ts pnIcon 과 같은 방식.
//   d 문자열 하나로 두면 원·둥근사각을 원호로 흉내 내야 해서 좌표가 다시 눈대중이 된다.
//  sys(톱니)는 손으로 찍은 점이 아니라 기어 기하로 생성한 좌표다 — 톱니 6 · 팁 반경 9.4 ·
//   골 반경 6.5 · 팁 반각 14° · 골 반각 18°. 그래서 톱니 여섯이 정확히 같은 모양·같은 간격이다.
const ICON_PATHS: Record<AppDef['icon'], string> = {
  // 지붕 선이 몸통 어깨(y 8.9)에서 정확히 만난다 — 종전엔 지붕과 몸통이 어긋나 틈이 보였다.
  home: '<path d="M3.4 10.9 12 4.1l8.6 6.8"/><path d="M6 8.9v9.9a1.6 1.6 0 0 0 1.6 1.6h8.8a1.6 1.6 0 0 0 1.6-1.6V8.9"/><path d="M10.1 20.4v-5.2h3.8v5.2"/>',
  // 터미널 프롬프트 `>_` — 꺾쇠와 밑줄의 아래끝을 y 16.6 으로 맞춰 한 줄로 읽히게 했다.
  term: '<path d="M4.8 7.4 10.4 12l-5.6 4.6"/><path d="M12.6 16.6h6.6"/>',
  // 보드 = 머리띠 한 줄 + 세로 구분선(곁칸 cols 아이콘과 같은 어휘).
  proj: '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.4"/><path d="M3.4 8.4h17.2"/><path d="M12 8.4v11"/>',
  // 펼친 책 — 책등을 한 번만 긋고 양 페이지가 그 끝점(12,7.6)·(12,19.7)에서 시작·종료한다.
  wiki: '<path d="M12 7.6v12.1"/><path d="M12 7.6c-1.6-1.5-4-2.3-6.4-2.3H3.5v12.1h2.1c2.4 0 4.8.8 6.4 2.3"/><path d="M12 7.6c1.6-1.5 4-2.3 6.4-2.3h2.1v12.1h-2.1c-2.4 0-4.8.8-6.4 2.3"/>',
  // 흩어진 출처 셋 → 한 점. 수집·증류·분류가 하나의 맥락이 되는 일 그대로다.
  //  ⚠ 깔때기는 쓰지 않는다 — 우리 화면에서 깔때기는 '필터'로 읽힌다(design-guide 아이콘 규칙).
  //  연결선 끝점은 두 원의 중심을 잇는 선과 원둘레의 교점이다(눈대중 아님) — 그래서 선이 원에 정확히 닿는다.
  ctx: '<circle cx="4.6" cy="5.4" r="1.9"/><circle cx="4.6" cy="12" r="1.9"/><circle cx="4.6" cy="18.6" r="1.9"/><circle cx="17.8" cy="12" r="2.9"/><path d="M6.3 6.25 15.21 10.7"/><path d="M6.5 12h8.4"/><path d="M6.3 17.75 15.21 13.3"/>',
  // 톱니 6개 — 위 머리말의 기어 기하로 생성. 안쪽 구멍 r 3.4.
  sys: '<path d="M9.73 2.88A9.4 9.4 0 0 1 14.27 2.88L14.01 5.82A6.5 6.5 0 0 1 16.35 7.17L18.76 5.47A9.4 9.4 0 0 1 21.04 9.41L18.36 10.65A6.5 6.5 0 0 1 18.36 13.35L21.04 14.59A9.4 9.4 0 0 1 18.76 18.53L16.35 16.83A6.5 6.5 0 0 1 14.01 18.18L14.27 21.12A9.4 9.4 0 0 1 9.73 21.12L9.99 18.18A6.5 6.5 0 0 1 7.65 16.83L5.24 18.53A9.4 9.4 0 0 1 2.96 14.59L5.64 13.35A6.5 6.5 0 0 1 5.64 10.65L2.96 9.41A9.4 9.4 0 0 1 5.24 5.47L7.65 7.17A6.5 6.5 0 0 1 9.99 5.82Z"/><circle cx="12" cy="12" r="3.4"/>',
  // 학사모 — 술을 오른쪽에 달아 왼쪽으로 쏠린 무게를 잡는다.
  learn: '<path d="M12 4.4 21.4 8.6 12 12.8 2.6 8.6z"/><path d="M5.9 10.2v4.6c0 1.9 2.7 3.4 6.1 3.4s6.1-1.5 6.1-3.4v-4.6"/><path d="M21.4 8.6v4.5"/>',
  // 리브(담당자)의 얼굴. 설치된 앱에는 쓰지 않는다 — 그 자리는 apps(격자)다.
  liv: '<circle cx="12" cy="12" r="8.6"/><path d="M9.2 10.3h.01"/><path d="M14.8 10.3h.01"/><path d="M8.7 14.3a4.3 4.3 0 0 0 6.6 0"/>',
  // 말풍선 = 대화. 프로젝트 화면 '코멘트' 칸(project-view.ts)도 이걸 쓴다.
  //  ⚠ 그래서 '세션 이력'은 이걸 쓰지 않는다 — 한 글리프가 두 뜻을 지면 둘 다 흐려진다(아래 hist).
  sess: '<path d="M6.6 5.6h10.8a2.4 2.4 0 0 1 2.4 2.4v6.6a2.4 2.4 0 0 1-2.4 2.4h-5.9l-4.4 3.1v-3.1h-.5a2.4 2.4 0 0 1-2.4-2.4V8a2.4 2.4 0 0 1 2.4-2.4z"/>',
  // 되감는 시계 = 지난 것(세션 이력).
  hist: '<path d="M3.6 12a8.4 8.4 0 1 0 8.4-8.4 9.1 9.1 0 0 0-6.3 2.56L3.4 8.5"/><path d="M3.4 4.3v4.2h4.2"/><path d="M12 7.9V12l3.3 2"/>',
  // 지구본 — 반지름 8.6(원 키라인). 종전 9는 이 아이콘만 혼자 커 보이게 했다.
  web: '<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4a4.7 8.6 0 0 1 0 17.2 4.7 8.6 0 0 1 0-17.2z"/>',
  // 앱 = 타일 넷. 사이드바 [앱] 단추와 설치된 앱 타일이 함께 쓴다.
  apps: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
};
/** 앱 아이콘 하나.
 *  ⚠ 선 속성(fill·stroke·굵기·캡)을 **SVG 자체에** 박는다 — CSS 에만 맡기면 안 된다.
 *   런치패드는 document.body 바로 아래에 붙는데 `.v2-ic` 선 규칙이 `#v2-root` 안쪽에만 걸려 있어,
 *   규칙이 닿지 않아 SVG 기본값(검은 면 채움·선 없음)으로 떨어졌다 — 같은 아이콘이 사이드바에선
 *   선으로, 런치패드에선 검은 덩어리로 보이던 원인이다(#1841, dev 실측 fill:rgb(0,0,0)/stroke:none).
 *   CSS 쪽 범위도 함께 풀었지만(40-v2.css), 어디에 붙어도 같게 그려지도록 여기서 한 번 더 못박는다.
 *   learn.ts tabIcon()·디자인 시스템 아이콘 규격과 같은 문법이다. */
export function appIcon(icon: AppDef['icon'], cls?: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'v2-ic ' + (cls || ''));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICON_PATHS[icon];
  return svg;
}

// ── 앱 아이콘 — 유리 (#1841 원준) ────────────────────────────────────────────
//  위 appIcon() 은 **선 글리프**다(사이드바 행·칸 머리처럼 글자 옆 16px 자리). 런치패드는 다르다:
//  거기서 아이콘은 글자를 거드는 표식이 아니라 **그 앱 자체**라 채운 그림이어야 한다.
//  자료 폴더 아이콘(panes-kit folderIcon)이 같은 이유로 혼자 채운 그림인 것과 같은 판단이다.
//
//  ── 규칙 (레퍼런스 해부 + 원준 리뷰 5회로 굳은 것) ──
//   ① 색은 **한 계열 하나**. 열한 개가 같은 램프를 쓴다 — 구분은 색이 아니라 **형태**가 한다.
//      예외 둘 다 램프를 벗어나지 않는다: 설정은 같은 램프를 **탈색**(muted), 웹은 같은 램프의 **앞자락만**(span).
//   ② 구성은 **둘의 겹침**. 진한 색 도형 하나 + 서리 도형 하나. 그 겹친 자리가 유리다.
//   ③ 서리는 **색이 평평**하다. 테두리도 색 변화도 없다. 투명도만 20% 폭으로 눕혀 깊이를 준다.
//   ④ 그림자·글로우 **없음**. 색 halo 를 깔면 그게 '네온'이 된다(반려 사유 1).
//   ⑤ 유리 뒤는 **초점이 나간다**. 겹친 자리에만 흐린 색을 되돌린다 — 없으면 그냥 반투명 도형이다.
//   ⑥ 빛띠 한 줄. 있는 줄 모를 만큼만(.26). 보이기 시작하면 번잡해진다(반려 사유 2).
//   ⑦ 두께는 **그늘로만**. 흰 하이라이트를 더 얹으면 서리·빛띠와 합쳐 흰색이 세 겹이 되어
//      도형마다 흰 테가 도는 것처럼 보인다. 단 웹처럼 서리가 색을 **가로지르는** 구성만 rim 으로 켠다.
//   ⑧ 서리끼리는 겹치지 않는다. 겹치면 한 덩어리로 뭉개져 형태가 사라진다.
//
//  ⚠ 밝은 바탕에서 산다 — 런치패드 스크림을 어둡게 두면 유리가 탁해진다(40-v2.css .v2-pad).
//  ⚠ 서리 **색**은 CSS 에서 `.v2-gi { color: … }` 로 준다. 서리의 옅은 기울기가 currentColor 를 쓰는데,
//   그건 그라디언트가 얹힌 **svg 자신의** color 를 보지 참조하는 도형의 color 를 보지 않는다.
//  ⚠ id 는 인스턴스마다 유일해야 한다 — 같은 id 가 여럿이면 브라우저가 첫 것만 써서 색이 굳는다.

interface GlassArt {
  span?: number[];      // 램프가 가로지를 구간 = 그 아이콘 **색 도형의 바운딩 박스** 대각선.
                        //  전 아이콘 공통 대각선으로 두면 색 도형이 그 일부만 차지하는 아이콘은
                        //  램프 앞자락(민트)만 쓰고 끝까지 못 간다(실측: 홈·시계·리브가 전부 민트였다).
  color?: string;       // 진한 색 도형
  frost?: string;       // 서리 도형
  punch?: string;       // 흰색으로 뚫은 자리(유리에 난 구멍)
  over?: string;        // 유리 **위에** 색으로 얹는 것 — 흰색으로는 대비가 안 나는 자리(터미널 프롬프트·시계 바늘)
  overSolid?: number;   // over 를 램프의 이 정거장 **단색**으로. 그라디언트로 두면 가운데(틸)를 써서
                        //  옅은 서리 위에서 대비가 안 난다 — 시계 바늘이 그래서 안 보였다(실측).
  frostFirst?: boolean; // 서리가 색 **뒤로** 가는 구성
  rim?: boolean;        // 흰 안쪽 테두리(규칙 ⑦의 예외)
  muted?: boolean;      // 탈색 램프(설정)
}

const RAMP: string[] = ['#3EDCAB', '#16C79A', '#0F86B4', '#1C4FC2'];
// 설정 전용 — 우리 화면의 회색 토큰을 그대로 램프로 세운 것(--line-net → --muted-2 → --ink-sub → --ink 쪽).
//  ⚠ 민트 램프를 '탈색'해서 만들지 마라 — 그러면 청록기가 남아 화면의 다른 회색과 계열이 어긋난다(실측).
const RAMP_MUTED: string[] = ['#C8D2E0', '#A6B2C8', '#7183A0', '#41516E'];
// ⚠ 정거장 넷이다. 앞판은 셋(밝은민트→민트→블루)이었는데, 시작이 너무 밝고(L 82%) 끝이 얕아
//  전체가 사탕색으로 보였다("과하게 밝고 네온"). 시작을 낮추고 중간에 틸을 끼워 넣어 여정을 길게 하면
//  같은 시그니처 민트를 쓰면서도 보석처럼 깊어진다.
// 서리 값은 CSS 토큰이다(아래 .g2-frost) — 라이트/다크가 다른 값을 써야 한다.
//  라이트: 맑은 청회색을 높은 알파로. 다크: 더 밝은 색을 낮은 알파로(그래야 유리로 남는다).
//  앞판 #C7DFEC 는 채도가 낮아 '먼지 낀 회색'으로 읽혔다 — 조금 맑게 올린다.
const GLASS_ART: Record<string, GlassArt> = {
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
  // 손목시계 — 색 베젤 + 유리 문자판 + 색 바늘. 앞판은 서리 원판에 가는 바늘뿐이라 창백했다.
  //  베젤을 색으로 두르면 색 덩어리가 생기면서 동시에 '시계'라는 사물이 또렷해진다.
  //  바늘은 over(유리 위) — 유리 아래 두면 부옇게 묻힌다.
  hist: {
    span: [7, 7, 57, 57],
    color: '<circle cx="32" cy="32" r="25"/>',
    frost: '<circle cx="32" cy="32" r="19.5"/>',
    overSolid: 3,   // 깊은 끝 단색 — 옅은 문자판 위에서 바늘이 읽히려면 이 대비가 필요하다
    over: '<path d="M32 32V17.8" stroke-width="5.2" stroke-linecap="round" fill="none"/>'
      + '<path d="M32 32l10 5.8" stroke-width="5.2" stroke-linecap="round" fill="none"/>'
      + '<circle cx="32" cy="32" r="3.2"/>',
  },
  // 톱니 — **별이 되는 조건**을 피한 비율이다. 앞판은 골이 4°뿐이라 이빨 사이가 뾰족한 점으로 만났고,
  //  그게 정확히 별의 정의였다. 기어로 읽히려면 ① 골이 원호로 충분히 보이고(12°) ② 깊이가 얕고(22%)
  //  ③ 이빨 사이로 **원형 몸통**이 드러나야 한다. 실제 기어는 피치원에서 이빨과 골의 폭이 비슷하다.
  //  8톱니 · 이빨 20° · 옆면 6.5°×2 · 골 12° · 팁 26 / 골바닥 20.4.
  sys: {
    span: [7, 6, 58, 58],
    muted: true,   // 기계는 무채색으로
    color: '<path d="M27.49 6.39A26 26 0 0 1 36.51 6.39L37.79 12.44A20.4 20.4 0 0 1 41.73 14.07L46.91 10.7A26 26 0 0 1 53.3 17.09L49.93 22.27A20.4 20.4 0 0 1 51.56 26.21L57.61 27.49A26 26 0 0 1 57.61 36.51L51.56 37.79A20.4 20.4 0 0 1 49.93 41.73L53.3 46.91A26 26 0 0 1 46.91 53.3L41.73 49.93A20.4 20.4 0 0 1 37.79 51.56L36.51 57.61A26 26 0 0 1 27.49 57.61L26.21 51.56A20.4 20.4 0 0 1 22.27 49.93L17.09 53.3A26 26 0 0 1 10.7 46.91L14.07 41.73A20.4 20.4 0 0 1 12.44 37.79L6.39 36.51A26 26 0 0 1 6.39 27.49L12.44 26.21A20.4 20.4 0 0 1 14.07 22.27L10.7 17.09A26 26 0 0 1 17.09 10.7L22.27 14.07A20.4 20.4 0 0 1 26.21 12.44Z"/>',
    frost: '<circle cx="32" cy="32" r="10.6"/>',
  },
  // 구 + 고리 — 색 구체를 서리 고리가 가로지른다. 레퍼런스의 '겹쳐 지나가는' 문법 그대로.
  web: {
    // ⚠ 이 아이콘만 흰 안쪽 테두리를 켠다(rim). 전역에서는 흰색이 세 겹이 되어 번잡해 걷어냈지만,
    //  웹은 서리 고리가 색 구체를 **가로지르는** 구성이라 그 테두리가 고리의 앞뒤를 갈라 준다 —
    //  걷어내니 고리가 구체에 묻혔다. 램프 구간도 전 구간으로 되돌린다.
    span: [11, 9, 53, 51],
    rim: true,
    color: '<circle cx="32" cy="30" r="21"/>',
    frost: '<ellipse cx="32" cy="34" rx="31" ry="11.5" transform="rotate(-21 32 34)"/>',
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
export function appGlassIcon(icon: AppDef['icon'], cls?: string): SVGElement {
  const n = ++glassSeq;
  const a: GlassArt = GLASS_ART[icon] || GLASS_ART.apps;
  const color = a.color || '', frost = a.frost || '';
  const sp = a.span || [6, 4, 58, 60];
  const R = a.muted ? RAMP_MUTED : RAMP;
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
    + (a.over
      ? `<g fill="${a.overSolid != null ? R[a.overSolid] : `url(#gk${n})`}" stroke="${a.overSolid != null ? R[a.overSolid] : `url(#gk${n})`}">${a.over}</g>`
      : '');
  return svg;
}

// ── 런치패드 오버레이 ──
//  전체 화면을 덮는 격자. 검색(제목·설명 부분일치)·Esc 로 닫기.
//   · 화면 앱(APPS 표) 클릭 = #/app/<key> 로 이동(가운데 iframe).
//   · 설치된 세션 앱(org_app, #1780) 클릭 = openAppSession → 앱 세션을 열고 그 대화 화면으로. 동의(grant)가 없으면
//     그때 동의 창이 뜬다. 세션 앱은 비동기로 불러와(listSessionApps) 도착하면 격자에 덧그린다(없으면 화면앱만 보인다).
let padEl: HTMLElement | null = null;
export function openLaunchpad(): void {
  closeLaunchpad();
  const apps = visibleApps();
  let sApps: SessionApp[] = [];
  const grid = el('div', { class: 'v2-pad-grid', role: 'list' });
  const input = el('input', { class: 'v2-pad-search', type: 'search', placeholder: '앱 찾기', 'aria-label': '앱 찾기' }) as HTMLInputElement;
  // 맥 응용 프로그램 폴더 문법(원준 2026-08-21) — **아이콘과 이름만**. 설명 줄은 두지 않는다.
  //  설명을 타일마다 달면 격자가 카드 목록이 되어, 아이콘을 알아보고 고르는 자리가 읽는 자리로 바뀐다.
  //  ⚠ 설명(desc)은 지운 게 아니라 화면에서 내린 것이다 — 검색은 여전히 설명까지 훑는다(아래 filter).
  //   "맥락"으로 찾으면 '맥락 관리'가 잡혀야 하고, 그 낱말은 제목이 아니라 설명에 있다.
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const screen = apps.filter((a) => !q || a.title.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q)).map((a) =>
      el('a', { class: 'v2-pad-item', role: 'listitem', href: '#/app/' + a.key, title: a.title + ' — ' + a.desc,
        onclick: () => closeLaunchpad() },
        appGlassIcon(a.icon),
        el('span', { class: 'v2-pad-name', text: a.title })));
    const session = sApps.filter((a) => !q || a.title.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)).map((a) => {
      const hasUi = a.pages.length > 0;   // UI 앱이면 UI 를 연다(샌드박스 iframe), 아니면 세션 앱.
      return el('button', { class: 'v2-pad-item', role: 'listitem', type: 'button',
        title: hasUi ? a.title + ' — 열면 이 앱의 화면이 창으로 뜹니다' : a.title + ' — 열면 이 앱 전용 AI 세션이 뜹니다',
        onclick: () => { closeLaunchpad(); if (hasUi) void openAppUi(a.id, { title: a.title }); else void openAppSession(a.id, { title: a.title }); } },
        appGlassIcon(hasUi ? 'apps' : 'term'),
        el('span', { class: 'v2-pad-name', text: a.title }));
    });
    grid.replaceChildren(...screen, ...session);
    if (!grid.childElementCount) grid.append(el('p', { class: 'v2-pad-empty', text: '맞는 앱이 없어요.' }));
  };
  input.addEventListener('input', draw);
  void listSessionApps().then((a) => { if (padEl) { sApps = a; draw(); } });
  padEl = el('div', { class: 'v2-pad', role: 'dialog', 'aria-label': '앱', onclick: (e) => { if (e.target === padEl) closeLaunchpad(); } },
    el('div', { class: 'v2-pad-top' },
      el('div', { class: 'v2-pad-h' }, el('b', { text: '앱' }), el('span', { class: 'v2-pad-sub', text: '아직 새 화면으로 옮기지 않은 것들 — 열면 가운데에 그대로 실립니다.' })),
      input,
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기 (Esc)', onclick: () => closeLaunchpad() })),
    grid);
  document.body.append(padEl as HTMLElement); draw(); input.focus();
  document.addEventListener('keydown', padKey);
}
function padKey(e: KeyboardEvent): void { if (e.key === 'Escape') closeLaunchpad(); }
export function closeLaunchpad(): void { if (padEl) { padEl.remove(); padEl = null; } document.removeEventListener('keydown', padKey); }

// ── 앱 프레임 — 중앙에 iframe 하나. 헤더 한 줄(앱 이름 · 새 탭 · 클래식으로) 외엔 크롬이 없다. ──
//  #1841 — 안의 화면이 프로젝트 탭 문법의 머리(빵부스러기·뷰 탭·툴바)를 스스로 그리는 앱(FRAMELESS)은 이 띠를 안 단다.
//   '클래식 화면 · 그대로 실림' 띠가 그 머리 위에 한 줄 더 얹히면 제목이 두 번 보이고 액자 티가 난다. 새 탭 열기는 그 화면의 ⋯ 메뉴가 든다.
const FRAMELESS = new Set(['terminal', 'projects2', 'knowledge', 'context']);
export function appFrame(hash: string, title: string, opts?: { live?: boolean; src?: string }): HTMLElement {
  const src = opts?.src || embedUrl(hash);
  const frame = el('iframe', { class: 'v2-frame', src, title, loading: 'eager', allow: 'clipboard-read; clipboard-write' }) as HTMLIFrameElement;
  const key = hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  if (!opts?.live && FRAMELESS.has(key)) {
    const pop = el('a', { class: 'v2-frame-pop', href: classicUrl(hash), target: '_blank', rel: 'noopener', title: '새 탭에서 열기', 'aria-label': '새 탭에서 열기', text: '↗' });
    return el('div', { class: 'v2-app v2-app-frameless' }, pop, frame);
  }
  const head = el('div', { class: 'v2-frame-h' },
    el('b', { class: 'v2-frame-t', text: title }),
    el('span', { class: 'v2-frame-sub', text: opts?.live ? '라이브 세션' : '클래식 화면 · 그대로 실림' }),
    el('span', { class: 'v2-frame-acts' },
      el('a', { class: 'btn-text', href: opts?.src ? src : classicUrl(hash), target: '_blank', rel: 'noopener', text: '새 탭에서 열기 ↗' })));
  return el('div', { class: 'v2-app' }, head, frame);
}
