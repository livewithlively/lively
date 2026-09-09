// v2/apps.ts — 새 셸의 '앱' 레지스트리 + 런치패드 + 앱 프레임(#1719).
//  앱 = 클래식 화면(탭·페이지)을 엔티티로 올린 것. 새 셸이 아직 담지 못한 화면은 전부 여기 등록돼 있고,
//  런치패드(맥OS 런치패드 문법: 전체 화면 격자 + 검색)에서 열면 **같은 index.html 을 ?embed=1 로 iframe 에 실어**
//  중앙에 띄운다 — 클래식 코드를 한 줄도 옮기지 않고 새 셸 안에서 그대로 쓴다. 나중에 화면이 새 셸로 이식되면
//  이 표의 항목이 `native` 로 바뀌거나 빠진다(표가 곧 '아직 안 옮긴 것' 목록이다).
//  ⚠ 노출은 클래식과 같은 규칙(navOn — ui_nav 로 끈 탭은 여기서도 안 보인다).
import { el, navOn, sv } from '../core.js';
import { shellPrefStore, shellPrefsPush } from './shell-prefs.js';   // #2460 — 최근 줄의 정본은 서버
import { ICONS } from './icons.js';
import { sessionTermUrl } from '../lib/session-open.js';   // #1820 — 세션 주소는 한 곳에서만 만든다
import { listSessionApps, openAppSession, type SessionApp } from './app-session.js';
import { openInstalledApp } from './app-instance.js';

export interface AppDef {
  key: string;        // 안정 키(= 클래식 data-tab 슬러그 또는 페이지 이름)
  title: string;      // 사람 말
  desc: string;       // 한 줄
  route: string;      // 클래식 해시(#/ 뒤) — iframe 에 실릴 경로
  tab: string | null; // navOn 게이팅에 쓸 클래식 탭 키(없으면 항상 노출)
  icon: 'home' | 'term' | 'chat' | 'proj' | 'wiki' | 'ctx' | 'sys' | 'learn' | 'liv' | 'sess' | 'web' | 'src';
  // 무엇으로 그리는가. 없으면 'classic'(같은 index.html 을 ?embed=1 로 iframe).
  //  'browser' = 브라우저 서피스(#1829) — 우리 화면이 아니라 **남의 웹**이라 iframe 이 아니라 `<webview>` 로 띄운다
  //   (사이트가 X-Frame-Options 로 프레임 삽입을 막기 때문 — web/v2/browser-surface.ts 머리말).
  //  'native' = 새 셸이 **직접 그리는** 화면(iframe 이 아니다). route 가 셸 해시의 첫 세그먼트다(`#/<route>`).
  //   문을 여기 두는 이유: 런치패드·최근 연 앱·독 고정은 전부 이 표를 읽는다. 표 밖에 있으면 그 셋 중
  //   어느 것도 못 한다 — 레일에 못 박아 두는 길밖에 남지 않는다(자료가 그랬다, #2423).
  kind?: 'classic' | 'browser' | 'native';
  home?: string;      // kind='browser' 의 첫 주소
  // #2199 — 런치패드·최근 앱·독·통합검색에 **안 나온다**. 주소(#/system/… · #/app/system)로는 그대로 열린다 —
  //  문이 다른 곳에 있는 앱이다(설정 = [나] 창 ▸ [고급 설정], v2/me-modal.ts). 표에서 지우지 않는 이유: 라우터·탭 제목·
  //  액자 판정(appByKey)이 이 줄을 읽고, shell-surfaces CLASSIC_BACKLOG(앱화 대장)와 같은 집합이어야 한다.
  hidden?: boolean;
}

// 표 한 줄 = 앱 하나. 순서 = 런치패드 순서. 클래식 탭 순서(홈·AI세션·프로젝트·WIKI·맥락관리·설정·가이드)를 따른다.
export const APPS: AppDef[] = [
  { key: 'dashboard', title: '홈(클래식)', desc: '옛 대시보드 — 내 프로젝트·알림·세션·팀 로그 위젯', route: 'dashboard', tab: 'dashboard', icon: 'home' },
  { key: 'terminal', title: 'AI 세션', desc: '박스에서 도는 AI 세션 전체 · 새 세션 만들기', route: 'terminal', tab: 'terminal', icon: 'chat' },   // 말풍선 — 사이드바 세션 행과 같은 붓(원준 2026-08-26 "터미널 아이콘 말고 말풍선으로 통일")
  { key: 'projects2', title: '프로젝트', desc: '보드 · 리스트 · 타임라인 · 태스크', route: 'projects2', tab: 'projects2', icon: 'proj' },
  { key: 'knowledge', title: 'WIKI', desc: '지식 트리 · 문서 · 검토 큐', route: 'knowledge', tab: 'knowledge', icon: 'wiki' },
  //  자료(#2423) — 새 셸이 직접 그리는 첫 native 앱. 위키 옆에 둔다(지식의 원본이 자료다).
  //   ⚠ 레일에 못 박지 않는다(원준 2026-08-31): "맥락관리·사용가이드 저 위계로 앱에서만 보이고, 눌러서 최근에
  //   나오다가, 원하면 독에 고정". 그래서 문은 런치패드 하나이고, 열면 ② 최근 연 앱에 서고, 거기서 고정한다.
  { key: 'sources', title: '자료', desc: '출처별 원본 — 대화 · 파일 · 이슈 · 적어 둔 것', route: 'sources', tab: null, icon: 'src', kind: 'native' },
  { key: 'context', title: '맥락 관리', desc: '우리 AI 가 아는 것과 그것을 만드는 기계들 — 수집기 · 증류기 · 카테고리 · 점검 · AI 전달', route: 'context', tab: 'context', icon: 'ctx' },
  { key: 'sessions', title: '세션 이력', desc: '중앙에 기록된 내 세션 대화 이어보기', route: 'sessions', tab: 'terminal', icon: 'sess' },
  // 설정 — 앱 목록에서 **뺐다**(#2199, 원준 2026-08-27 "앱에 설정을 없애고 … 모달 사이드바에 고급설정 하나 만들어서").
  //  설정은 할 일이 있는 화면이 아니라 환경을 손보는 자리라, 문은 [나] 창 ▸ [고급 설정] 하나다(같은 문이 둘이면 어느 쪽이
  //  진짜인지 화면이 말하지 못한다). 줄은 남긴다 — 위 hidden 주석.
  { key: 'system', title: '설정', desc: '조직 · 구성원 · AI 능력 · 데이터 연결 · 운영', route: 'system', tab: 'system', icon: 'sys', hidden: true },
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

export function visibleApps(): AppDef[] { return APPS.filter((a) => !a.hidden && (!a.tab || navOn(a.tab))); }

// ── 최근 쓴 앱(#1954) — 홈 한 줄이 읽는 기억. ──
//  #2460 — **계정에 둔다**(종전엔 이 기기의 습관이라 브라우저에만 뒀다): 사무실 데스크톱에서 연 앱이
//   노트북 홈의 최근 줄에도 서야 «내가 요즘 쓰는 것»이 된다. 브라우저는 첫 페인트용 캐시로 남는다.
//  ⚠ 이름을 `*_KEY` 로 두지 않는다 — gitleaks 의 generic-api-key 룰이 브라우저 저장소 이름을 시크릿으로 오인해
//   CI 시크릿 스캔이 떨어진다(#1954 실측). 값은 localStorage 칸 이름일 뿐이다.
// #1875 — 워크스페이스별. **여기가 이 키의 유일한 자리**다(레일도 이 값을 import 해서 읽는다 — 사본을 두면
//  한쪽에만 접미사가 붙어 레일만 남의 워크스페이스 기록을 본다).
export const RECENT_STORE_KEY = shellPrefStore('lively_v2_recent_apps', 'list');
const RECENT_STORE = RECENT_STORE_KEY;
const RECENT_MAX = 12;
function readRecent(): string[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_STORE) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; }
  catch { return []; }
}
/** 앱을 열었다 — 맨 앞으로. 같은 앱을 되풀이 열어도 줄이 늘지 않는다. */
export function noteAppUse(key: string): void {
  const a = key ? appByKey(key) : null;
  if (!a || a.hidden) return;   // 문이 없는 앱은 '최근'에도 안 선다 — 서면 최근 줄이 문 없는 앱을 만든다
  const next = [key, ...readRecent().filter((k) => k !== key)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_STORE, JSON.stringify(next)); } catch { /* 못 남겨도 이번 화면은 된다 */ }
  shellPrefsPush();   // #2460 — 최근 줄은 계정의 것이다(다른 기기에서도 같은 줄이 뜬다)
}
/**
 * 최근 쓴 앱 n개. 기록이 모자라면 **표 순서로 채운다** — 처음 온 사람에게 빈 줄을 보이지 않기 위해서다
 * (빈 줄은 '아직 아무것도 없다'가 아니라 '고장'으로 읽힌다).
 */
export function recentApps(n: number): AppDef[] {
  const vis = visibleApps();
  const byKey = new Map(vis.map((a) => [a.key, a]));
  const out: AppDef[] = [];
  for (const k of readRecent()) { const a = byKey.get(k); if (a && !out.includes(a)) out.push(a); if (out.length >= n) return out; }
  for (const a of vis) { if (!out.includes(a)) out.push(a); if (out.length >= n) break; }
  return out;
}
export function appByKey(key: string): AppDef | null { return APPS.find((a) => a.key === key) || null; }
/** 이 앱을 여는 주소 — native 는 셸이 직접 그리는 제 주소(`#/sources`), 나머지는 액자(`#/app/<key>`). */
export function appHref(a: AppDef): string { return a.kind === 'native' ? '#/' + a.route : '#/app/' + a.key; }
/** 주소 첫 세그먼트로 native 앱을 되찾는다 — '지금 이 앱이 떠 있나'(레일 실행 중 점)를 판정하는 자리에서 쓴다. */
export function nativeAppByRoute(seg: string): AppDef | null { return APPS.find((a) => a.kind === 'native' && a.route === seg) || null; }

// 임베드 URL — **같은 문서**를 ?embed=1 로. location.pathname 은 이미 프리뷰 프리픽스(/preview/<id>/ui/)를 포함하므로
//  appUrl 을 거치지 않는다(거치면 프리픽스가 두 번 붙는다). 같은 경로 = 같은 API 베이스 = 같은 인증.
export function embedUrl(hash: string): string {
  const h = hash.replace(/^#\/?/, '');
  //  shell=classic — **이 앱은 클래식 페이지다**를 명시한다(#2208). 종전엔 embed=1 하나가 '끼워 넣은 판'과
  //   '클래식 셸을 써라' 두 뜻을 겸했는데, 그러면 embed 를 붙이는 **다른 자리**(곁칸 웹 칸 — web-url.ts 가
  //   우리 오리진에 자동으로 붙인다)까지 클래식으로 끌려간다. 뜻이 둘이면 플래그도 둘이어야 한다.
  return location.pathname + '?embed=1&shell=classic#/' + h;
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

// ── 아이콘(라인, 채움 없음 — DS 규약) ──
const ICON_PATHS: Record<AppDef['icon'], string> = {
  //  #2016 — 선 아이콘은 icons.ts 한 벌이다. 홈(클래식)은 옛 대시보드라 위젯 판 넷, 설정은 이빨 있는 톱니.
  home: ICONS.dashboard, term: ICONS.term, chat: ICONS.chat, proj: ICONS.proj, wiki: ICONS.wiki, ctx: ICONS.ctx,
  sys: ICONS.sys, learn: ICONS.learn, liv: ICONS.liv, sess: ICONS.sess, web: ICONS.web, src: ICONS.src,
};
export function appIcon(icon: AppDef['icon'], cls?: string): SVGElement {
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'v2-ic ' + (cls || '')); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svgNs, 'path'); path.setAttribute('d', ICON_PATHS[icon]);
  svg.append(path); return svg;
}

// ── 런치패드 아이콘 — 유리 (#1841) ── 정의는 ./glass-icon.ts(리프)로 옮겼다(#3830, 맥락 관리 표지가 같은 문패를 쓴다).
//  여기서는 받아서 다시 내보낸다 — appGlassIcon 을 이 파일에서 import 하던 자리(views.ts)가 그대로 살아 있다.
import { appGlassIcon } from './glass-icon.js';
export { appGlassIcon };

// ── 런치패드 오버레이 ──
//  전체 화면을 덮는 격자. 검색(제목·설명 부분일치)·Esc 로 닫기.
//   · 화면 앱(APPS 표) 클릭 = #/app/<key> 로 이동(가운데 iframe).
//   · 설치된 세션 앱(org_app, #1780) 클릭 = openAppSession → 앱 세션을 열고 그 대화 화면으로. 동의(grant)가 없으면
//     그때 동의 창이 뜬다. 세션 앱은 비동기로 불러와(listSessionApps) 도착하면 격자에 덧그린다(없으면 화면앱만 보인다).
//  설치된 앱(org_app) 중 **우리가 만든 빌트인**은 제 아이콘을 갖는다 — 남의 앱만 종류(앱/세션 앱)로 뭉뚱그린다.
//   이 표가 없으면 빌트인들이 런치패드에서 전부 같은 그림으로 서서 어느 것이 무엇인지 못 고른다.
//   (자료는 이제 APPS 표의 native 앱이라 이 길로 오지 않는다 — 위 session 필터가 뺀다.)
const BUILTIN_ICON: Record<string, AppDef['icon']> = { browser: 'web' };

let padEl: HTMLElement | null = null;
export function openLaunchpad(): void {
  closeLaunchpad();
  const apps = visibleApps();
  let sApps: SessionApp[] = [];
  const grid = el('div', { class: 'v2-pad-grid', role: 'list' });
  const input = el('input', { class: 'v2-pad-search', type: 'search', placeholder: '앱 찾기', 'aria-label': '앱 찾기' }) as HTMLInputElement;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    // 이름에 맞은 것이 설명에만 맞은 것보다 앞에 온다 — Enter 가 맨 앞을 여니 순서가 곧 정답이어야 한다.
    //  ('프' 를 치면 설명에 '프로젝트'가 든 홈이 아니라 프로젝트 앱이 먼저다.) sort 는 안정 정렬이라 동점은 원래 차례.
    const rank = (t: string) => { const i = t.toLowerCase().indexOf(q); return i === 0 ? 0 : i > 0 ? 1 : 2; };
    const screen = apps.filter((a) => !q || a.title.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q))
      .sort((a, b) => rank(a.title) - rank(b.title)).map((a) =>
      el('a', { class: 'v2-pad-item', role: 'listitem', href: appHref(a), title: a.desc, onclick: () => closeLaunchpad() },
        el('span', { class: 'v2-pad-ico' }, appGlassIcon(a.icon)),
        el('b', { text: a.title })));
    //  ⚠ 화면 앱 표(APPS)에 이미 있는 빌트인은 여기서 뺀다 — 안 그러면 같은 앱이 격자에 두 번 선다(자료, #2423).
    //   표 쪽이 이긴다: 아이콘·설명·최근·독 고정이 전부 그 줄에 달려 있다.
    const session = sApps.filter((a) => a.id !== 'ai-session' && !APPS.some((x) => x.kind === 'native' && x.key === a.id))
      .filter((a) => !q || a.title.toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
      .sort((a, b) => rank(a.title) - rank(b.title)).map((a) => {
      const hasUi = a.pages.length > 0;   // UI 앱이면 UI 를 연다(샌드박스 iframe), 아니면 세션 앱.
      //  정본 주소를 갖는 빌트인(확인할 것·자료)은 **화면 앱**이다 — UI 페이지가 없다고 «세션 앱» 이라 부르면
      //   배지가 거짓말을 한다(그 앱을 열어도 AI 세션은 안 뜬다). 셋을 가르는 축은 pages 가 아니라 '무엇으로 뜨나'다.
      const isScreen = !!a.system?.route || hasUi;
      return el('button', { class: 'v2-pad-item v2-pad-item--app', role: 'listitem', type: 'button',
        title: isScreen ? '앱 — 열면 이 앱의 화면이 창으로 뜹니다' : '세션 앱 — 열면 이 앱 전용 AI 세션이 뜹니다',
        onclick: () => {
          closeLaunchpad();
          //  정본 주소가 있는 앱(확인할 것·자료)은 **그 주소로** 간다 — 그 화면이 인스턴스를 뒤에서 멱등 확보한다.
          //   여기서 openInstalledApp 을 부르면 #/i/<id> 로 가는데, 그 앱들은 UI 페이지가 없어 그 자리에서 죽는다(#2423).
          if (a.system?.route) { location.hash = a.system.route; return; }
          if (hasUi || a.system) void openInstalledApp(a); else void openAppSession(a.id, { title: a.title });
        } },
        el('span', { class: 'v2-pad-ico' }, appGlassIcon(BUILTIN_ICON[a.id] || (hasUi ? 'liv' : 'term'))),
        el('b', { text: a.title }),
        el('span', { class: 'v2-pad-badge', text: isScreen ? '앱' : '세션 앱' }));
    });
    grid.replaceChildren(...screen, ...session);
    grid.classList.toggle('v2-pad-grid--q', !!q);   // 검색 중이면 첫 칸이 Enter 로 열릴 자리 — 그걸 보인다.
    if (!grid.childElementCount) grid.append(el('p', { class: 'v2-pad-empty', text: '맞는 앱이 없어요.' }));
  };
  input.addEventListener('input', draw);
  // 스포트라이트처럼 Enter 는 맨 앞 결과를 연다 — 이름을 몇 글자 치고 바로 들어가는 길.
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key !== 'Enter') return;
    const first = grid.querySelector('.v2-pad-item') as HTMLElement | null;
    if (first) { e.preventDefault(); first.click(); }
  });
  void listSessionApps().then((a) => { if (padEl) { sApps = a; draw(); } });
  // 검색칸 하나만 띄운다(맥 스포트라이트) — 제목·설명 줄·닫기 버튼은 없앴다.
  //  닫기는 Esc 와 배경 클릭이 이미 하고, 칸 오른쪽 esc 키캡이 그걸 알린다.
  padEl = el('div', { class: 'v2-pad', role: 'dialog', 'aria-label': '앱 찾기', onclick: (e) => { if (e.target === padEl) closeLaunchpad(); } },
    el('div', { class: 'v2-pad-field' },
      sv('svg', { class: 'v2-pad-mag', viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        sv('circle', { cx: '11', cy: '11', r: '6.75' }),
        sv('path', { d: 'M16.1 16.1 21 21' })),
      input,
      el('kbd', { class: 'v2-pad-esc', text: 'esc' })),
    grid);
  document.body.append(padEl as HTMLElement); draw(); input.focus();
  document.addEventListener('keydown', padKey);
}
function padKey(e: KeyboardEvent): void { if (e.key === 'Escape') closeLaunchpad(); }
export function closeLaunchpad(): void { if (padEl) { padEl.remove(); padEl = null; } document.removeEventListener('keydown', padKey); }

// ── 앱 프레임 — 중앙에 iframe 하나. 헤더 한 줄(앱 이름 · 새 탭 · 클래식으로) 외엔 크롬이 없다. ──
//  #1841 — 안의 화면이 프로젝트 탭 문법의 머리(빵부스러기·뷰 탭·툴바)를 스스로 그리는 앱(FRAMELESS)은 이 띠를 안 단다.
//   '클래식 화면 · 그대로 실림' 띠가 그 머리 위에 한 줄 더 얹히면 제목이 두 번 보이고 액자 티가 난다. 새 탭 열기는 그 화면의 ⋯ 메뉴가 든다.
const FRAMELESS = new Set(['terminal', 'projects2', 'knowledge', 'context', 'learn', 'start', 'onboarding']);
export function appFrame(hash: string, title: string, opts?: { live?: boolean; src?: string }): HTMLElement {
  const src = opts?.src || embedUrl(hash);
  const frame = el('iframe', { class: 'v2-frame', src, title, loading: 'eager', allow: 'clipboard-read; clipboard-write' }) as HTMLIFrameElement;
  // 하위 라우트(#/k/… · #/trash · #/start/…)도 같은 앱이다 — CLASSIC_PAGES 로 앱 키를 먼저 접고 판정한다.
  //  (안 접으면 문서 페이지에만 '클래식 화면 · 그대로 실림' 띠가 되살아난다 — #1841 실측)
  const seg = hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  const key = CLASSIC_PAGES[seg] || seg;
  frame.dataset.appKey = key;   // #2043 — 같은 앱이면 셸이 액자를 다시 싣지 않고 안의 주소만 바꾼다(main.ts 클래식 분기)
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
