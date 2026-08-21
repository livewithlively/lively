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
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const screen = apps.filter((a) => !q || a.title.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q)).map((a) =>
      el('a', { class: 'v2-pad-item', role: 'listitem', href: '#/app/' + a.key, onclick: () => closeLaunchpad() },
        el('span', { class: 'v2-pad-ico' }, appIcon(a.icon)),
        el('b', { text: a.title }),
        el('span', { class: 'v2-pad-desc', text: a.desc })));
    const session = sApps.filter((a) => !q || a.title.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)).map((a) => {
      const hasUi = a.pages.length > 0;   // UI 앱이면 UI 를 연다(샌드박스 iframe), 아니면 세션 앱.
      return el('button', { class: 'v2-pad-item v2-pad-item--app', role: 'listitem', type: 'button',
        title: hasUi ? '앱 — 열면 이 앱의 화면이 창으로 뜹니다' : '세션 앱 — 열면 이 앱 전용 AI 세션이 뜹니다',
        onclick: () => { closeLaunchpad(); if (hasUi) void openAppUi(a.id, { title: a.title }); else void openAppSession(a.id, { title: a.title }); } },
        el('span', { class: 'v2-pad-ico' }, appIcon(hasUi ? 'apps' : 'term')),
        el('b', { text: a.title }),
        el('span', { class: 'v2-pad-desc', text: hasUi ? '앱 화면 — 창으로 열려요' : '앱 세션 — 열면 이 앱으로 대화가 시작돼요' }),
        el('span', { class: 'v2-pad-badge', text: hasUi ? '앱' : '세션 앱' }));
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
export function appFrame(hash: string, title: string, opts?: { live?: boolean; src?: string }): HTMLElement {
  const src = opts?.src || embedUrl(hash);
  const frame = el('iframe', { class: 'v2-frame', src, title, loading: 'eager', allow: 'clipboard-read; clipboard-write' }) as HTMLIFrameElement;
  const head = el('div', { class: 'v2-frame-h' },
    el('b', { class: 'v2-frame-t', text: title }),
    el('span', { class: 'v2-frame-sub', text: opts?.live ? '라이브 세션' : '클래식 화면 · 그대로 실림' }),
    el('span', { class: 'v2-frame-acts' },
      el('a', { class: 'btn-text', href: opts?.src ? src : classicUrl(hash), target: '_blank', rel: 'noopener', text: '새 탭에서 열기 ↗' })));
  return el('div', { class: 'v2-app' }, head, frame);
}
