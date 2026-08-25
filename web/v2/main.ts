// v2/main.ts — 앱 셸(#1719, #1883)의 뿌리. main.ts boot() 가 ui_mode 로 고른 뒤 bootV2() 를 부른다.
//  구조(마진 없는 풀스크린 · 전역 상단 탭 없음):
//    좌 사이드바 — 새 작업 · **열린 앱 인스턴스**(세션·위키·프로젝트 등 동격) · 앱 도크 · 계정
//    중앙        — 활성 앱 화면. web/v2/tabs.ts 의 DOM 유지 엔진이 화면별 상태를 보존하되 탭 줄은 그리지 않는다.
//    우측        — 이 선택의 맥락(타임라인) — **탭마다 한 벌**(전환하면 그 탭의 우패널이 그대로 돌아온다)
//  라우트: #/ #/dashboard → 홈 · #/liv · #/p/<id> · #/s/<sid> · #/app/<key>[/…] · 그 밖의 클래식 해시 → 같은 해시로 앱 프레임.
//  탭 규칙(#1719 상민님 2026-08-18): 주소는 활성 탭의 라우트다. 링크는 활성 탭 안에서 이동하되, 같은 화면이 이미 다른
//  탭에 있으면 그 탭으로 간다(한 세션 = 한 탭). Alt+클릭 = 새 탭에서 열기.
//  데스크톱(일렉트론)에서 그대로 쓰기 위한 규약: 정적 자산 + 해시 라우트 + api()(상대 경로·bearer/쿠키)만 쓴다.
import { renderOnboarding, onboardingDone } from './onboarding.js'; // #/welcome 처음 설정(#1813)
import { $view, anchoredPopover, api, el, toast } from '../core.js';
import { watchStaleShell } from '../gen-watch.js';   // #1841 — 앱 창이 낡은 판을 영영 들고 있던 것
import { renderLiv } from '../liv.js';
import { CLASSIC_PAGES, appByKey, appFrame, noteAppUse } from './apps.js';
import { browserSurface } from './browser-surface.js';
import { bySeen, drawSide as drawSideTree, isAppPinned, markNav, projectOrder, sessText, type SideInstance } from './side.js';
import { dotCls, isTrashedSess, mergeSessions, projName, renderHome, renderInbox, renderSession, type Sess, type V2Data } from './views.js';
import { renderArchive, renderTrash } from './bins.js';   // #1851 — 아카이브(#/archive) · 휴지통(#/trash) 화면
import { renderConnect, renderConnectApp } from './connect.js';
import { mountPanes } from './panes.js';   // 프로젝트 = 세션 화면(#1719 원준 2026-08-20) — 칸으로 나뉜 도킹 화면 하나뿐이다.
import { createTimeline, type TimelineHandle } from '../timeline.js';
import { loadSessionActivities } from '../timeline-sources.js';
import { makeSplitter } from './split.js';
import { createSessionFiles, type FilesHandle } from './files.js';
import { createTabs, routeKey, type ShellTab, type TabsApi } from './tabs.js';
import { confirmSessionArchive } from '../session-actions.js';
import { mountMobileChrome, type MobileChrome } from './mobile.js';
import { ASIDE_MSG, setAsideGuestOpener, type AsideGuest } from './aside-slot.js';
import { takeCreated } from './created-cache.js';
import { bindOmniKey, omniOpen, setOmniHooks } from './omni.js';   // 통합검색(⌘K) — 지식·프로젝트·자료·세션·세션이력 한 칸
import { mountTitlebar, type Titlebar } from './titlebar.js';      // 데스크톱 창 맨 윗줄(최소화·닫기와 같은 줄)을 탭 줄이 쓴다
import { mountAppUiFrame } from './app-ui.js';
import { cachedAppInstance, closeAppInstance, createAppInstance, ensureSessionAppInstance, getAppInstance, listAppInstances, updateAppInstance, type AppInstanceRecord } from './app-instance.js';
import { activeNavKey } from './shell-surfaces.js';   // #1780 — 최상위 화면 대장(무엇이 앱이고 무엇이 OS 표면인가)

// 팝아웃 창(#1744) — 세션 화면 [⋯ ▸ 새 창]이 `?solo=1` 로 여는 같은 앱. **좌측(과 탭 줄)만 없다**:
//  가운데(터미널·대화)와 우패널은 본 화면과 한 코드다. 실험장으로 갈아타도 이 창은 그대로 서야 한다.
const SOLO = new URLSearchParams(location.search).get('solo') === '1';
let root: HTMLElement | null = null;
let sideEl: HTMLElement | null = null;
let centerEl: HTMLElement | null = null;
let asideEl: HTMLElement | null = null;
let tabsApi: TabsApi | null = null;
let mobile: MobileChrome | null = null;   // ≤900px 모바일 크롬(#1777) — 상단 바·서랍. 데스크톱에선 보이지 않는 채로 달려 있다.
let titlebar: Titlebar | null = null;     // 데스크톱 앱 창 버튼·드래그를 위한 OS 크롬. 브라우저에선 null.
let data: V2Data = { projects: [], sessions: [], loadedAt: 0 };
let projLoadedAt = 0;
const projRetried = new Set<number>();   // 목록에 없어 한 번 더 당겨 본 프로젝트 id(같은 id 로 반복 재조회 방지)
let suppressHash = 0;                    // 탭 전환이 만든 hashchange 를 라우터가 다시 그리지 않게
// 프로젝트 화면(#1757) 핸들 — **탭마다 하나**. 탭이 다른 화면으로 가거나 닫힐 때 destroy(리브 턴 폴링 정지).
//  탭 전환(숨김)에는 살려 둔다 — 탭의 존재 이유(상태 보존)와 같은 원칙.
//  뷰가 둘(기본·캔버스)이라 핸들은 공통 계약 하나로만 본다 — 셸이 아는 것은 '언젠가 정리해야 한다'뿐이다.
const projViews = new Map<ShellTab, { destroy(): void; newSession?(): void }>();
// 그 탭의 셸이 **어느 프로젝트로** 마운트됐나(#1834 후속). 세션을 목록에서 못 찾은 판에는 loose(0)로 마운트되는데,
//  종전엔 그 상태가 그대로 굳어 문패가 '프로젝트 없는 세션'이 되고 그 셸의 세션 목록도 남의 것이 됐다.
//  20초 갱신이 이 값과 세션의 실제 프로젝트를 대조해 어긋나면 다시 그린다.
const shellProject = new Map<ShellTab, number>();
function dropProjView(tab: ShellTab): void { const pv = projViews.get(tab); if (pv) { pv.destroy(); projViews.delete(tab); } }
function setTabAppInstance(tab: ShellTab, id: string, appId: string): void {
  tab.appInstanceId = id;
  tab.appId = appId;
}
function clearTabAppInstance(tab: ShellTab): void {
  tab.appInstanceId = null;
  tab.appId = null;
}

// ── 프로젝트 = 세션이 놓인 방(원준 2026-08-20) ────────────────────────────────
/** 그 프로젝트의 **맨 위 세션** — 사이드바에서 보이는 순서와 같은 정의(side.ts bySeen). */
/** 세션 주소를 그 세션의 **정본 id**(박스 id)로 맞춘다 — 기록 uuid 로 들어와도 같은 탭이 되도록. */
function canonSessionHash(hash: string): string {
  const k = routeKey(hash);
  if (!k.startsWith('s:')) return hash;
  const id = k.slice(2);
  const s = findSess(id);
  return s && s.id && s.id !== id ? '#/s/' + encodeURIComponent(s.id) : hash;
}
function topSessionOf(projectId: number): Sess | null {
  if (!(projectId > 0)) return null;
  // 휴지통에 있는 세션은 후보가 아니다(#1851) — 프로젝트를 눌렀는데 버린 세션이 열리면 안 된다.
  const list = data.sessions.filter((s) => Number(s.projectId) === projectId && !isTrashedSess(s)).sort(bySeen);
  return list[0] || null;
}
/** 주소를 그 세션 것으로 바꾼다 — 라우터가 다시 돌아 셸을 그린다(프로젝트 주소는 거쳐 가는 문일 뿐이다).
 *  ⚠ replace 로 바꾼다 — push 로 남기면 '뒤로'가 프로젝트 주소로 돌아왔다가 다시 세션으로 튕겨 뒤로가기가 먹지 않는다. */
function goSession(sid: string, tab: ShellTab): void {
  const href = '#/s/' + encodeURIComponent(sid);
  // ⚠ tab.route 를 **미리 바꾸지 않는다** — 라우터는 '탭 라우트와 새 해시가 같으면 다시 그리지 않는다'로 동작하므로,
  //  먼저 바꿔 두면 이 이동이 통째로 삼켜져 화면이 비어 버린다(실측 2026-08-20).
  // ⚠ 이 이동은 **이 탭 안에서 이어지는 이동**이다(프로젝트 주소 → 그 프로젝트의 맨 위 세션). 세션 주소라고 해서
  //  새 탭을 만들면, 프로젝트 탭을 누를 때마다 탭이 하나씩 늘고 활성이 끝으로 튄다(원준 2026-08-20 신고 실측:
  //  '고객사 사용 분석' 탭을 눌렀더니 12번째 탭이 새로 생기고 그리로 옮겨 갔다). 그래서 hop 으로 표시해 둔다.
  if (location.hash !== href) inTabHops++;
  location.replace(location.pathname + location.search + href);
}
/** 같은 탭 안에서 이어지는 이동(리다이렉트)의 수 — onHash 의 '새 탭' 규칙만 건너뛴다(다시 그리기는 그대로 한다). */
let inTabHops = 0;

/**
 * 복원(이어받기)으로 새 세션이 생겼다 — **그 탭만** 새 세션으로 옮긴다(#1834 후속).
 *
 * 종전엔 세션 화면이 location.hash 를 직접 바꿨다. 셸 안에서 그건 **활성 탭의 주소**라, 숨은 탭에서
 *  일어난 복원이 지금 보고 있는 탭을 남의 새 세션으로 끌고 갔다(상민님 지적 2026-08-20).
 *  활성 탭이면 주소까지 맞추고, 숨은 탭이면 그 탭의 라우트·제목·화면만 바꾼다(그 탭을 열면 맞는 화면이다).
 */
function resumedInTab(tab: ShellTab, sid: string): void {
  const href = '#/s/' + encodeURIComponent(sid);
  tab.route = href;
  if (tabsApi?.current() === tab && location.hash !== href) { suppressHash++; location.hash = href; }
  tabsApi?.routed(tab);
  void renderRoute(tab);
  drawSide();
}

/** 프로젝트 셸(문패 + 칸 + 세션 서랍)을 이 탭에 마운트한다. 세션 화면은 그 안 '세션' 칸에 통째로 들어간다. */
async function mountProjectShell(tab: ShellTab, projectId: number, sessionId: string | null, seq: number): Promise<void> {
  let detail: any = null;
  if (projectId > 0) { try { detail = await api('/api/ui/v6/projects/' + projectId); } catch (_) { detail = null; } }
  if (seq !== tab.seq) return;
  if (detail && !data.projects.some((p) => p.id === projectId)) void loadData({ projects: true }).then(() => { drawSide(); tabsApi?.paint(); });
  dropProjView(tab);
  shellProject.set(tab, projectId);
  if (tab.chat) { tab.chat.destroy(); tab.chat = null; }
  projViews.set(tab, mountPanes(tab.center, {
    data: () => data,
    id: projectId,
    detail,
    sessionId,
    onProjectChanged: () => { void loadData({ projects: true }).then(() => { drawSide(); tabsApi?.paint(); }); },
    // 서랍에서 세션을 갈아 끼웠다 — 셸은 살려 두고 **주소·탭 제목만** 그 세션 것으로(라우터를 다시 돌리지 않는다).
    onSessionPicked: (sid) => {
      // 세션을 고르면 그 세션 주소, 새 세션 자리로 돌아가면 **?new=1** 을 붙인 프로젝트 주소.
      //  쿼리를 붙이는 이유: 프로젝트 주소만 두면 새로고침·탭 복원 때 라우터가 '맨 위 세션'으로 보내 버려
      //  열어 둔 새 세션 자리가 사라진다. routeKey 는 '?' 앞만 보므로 탭 동일성에는 영향이 없다.
      const href = sid ? '#/s/' + encodeURIComponent(sid) : '#/p/' + projectId + '?new=1';
      tab.route = href;
      // 셸은 그대로 두고 주소·탭 제목만 바꾼다 — hashchange 를 한 번 삼켜 라우터가 다시 그리지 않게.
      //  ⚠ 값이 같으면 hashchange 가 아예 안 나므로 그때는 세지 않는다(안 그러면 다음 진짜 이동을 삼킨다).
      //  ⚠ 주소는 **활성 탭의 것**이다 — 숨어 있는 탭이 스스로 세션을 갈아탈 때도(목록에서 사라진 세션의
      //   유예 뒤 폴백, panes-parts sessionsPart.paint) 이 훅이 불린다. 그때 location 을 만지면 지금 보고 있는
      //   **다른 탭의 주소**를 덮어쓴다. 그 탭이 활성일 때만 맞추고, 아니면 탭 제목만 바꾼다(activate 가 나중에 맞춘다).
      if (tabsApi?.current() === tab && location.hash !== href) { suppressHash++; location.hash = href; }
      tabsApi?.routed(tab);
      drawSide();
    },
    // 새 세션 자리에서 방금 만든 세션 — 그 전문을 **지금** 목록에 끼워 넣는다(#1719 원준 2026-08-20 신고:
    //  "엔터 친 다음에 클로드 미러링이 새로고침 안 하면 안 나온다"). 20초 폴링을 기다리면 그 사이 세션 화면이
    //  붙을 세션을 못 찾아 빈 채로 굳었다. 홈 입력창은 라우트가 created-cache 로 같은 일을 한다 — 여기는 셸이 산 채로
    //  칸만 갈아 끼우는 경로라 라우트를 거치지 않으므로 그 자리를 이 훅이 맡는다.
    onSessionCreated: (row) => {
      if (!row || !row.id) return;
      data.sessions = mergeSessions([row], []).concat(data.sessions.filter((x) => x.id !== String(row.id)));
      drawSide(); tabsApi?.paint();
      void loadData().then(() => { drawSide(); tabsApi?.paint(); });   // 곧바로 진짜 목록으로 대체(이 낙관 행은 임시다)
    },
    // 세션 화면 자체 — 우패널이 없는 셸이라 발자취·파일은 넘기지 않는다(맥락은 곁칸이 쥔다).
    //  발자취(trail)는 넘긴다: 곁칸 [타임라인]이 **그 세션의** 발자취를 그리는데 그 재료가 여기서 읽히는 대화다.
    //  그릇은 셸(panes.ts)이 세션마다 쥐고 여기로 건네준다.
    mountSession: (host, sid, o) => {
      const h = renderSession(host, data, sid, {
        trail: (o && o.trail) || null,
        onPickProject: (anchor) => openProjectPicker(anchor, sid, tab),
        onRename: (label) => renameSession(sid, label, tab),
        onArchive: () => void archiveSession(sid),
        // 자동 복원은 **보이는 탭에서만**, 복원 뒤 이동은 **그 탭만**(#1834 후속 — session-chat.ts isVisible/onResumed 주석).
        isVisible: () => tabsApi?.current() === tab,
        onResumed: (nid) => resumedInTab(tab, nid),
      });
      tab.chat = h;      // 20초 목록 갱신이 이 핸들로 상태를 흘려보낸다
      return h;
    },
  }));
  tab.aside.replaceChildren();   // 우패널 없음 — 맥락은 화면 안(칸)에서 산다
}
// 프로젝트 목록은 워크스페이스 전체(수백 건·설명 포함이라 1MB 를 넘는다) — 세션처럼 20초마다 당기지 않는다.
const PROJ_TTL_MS = 5 * 60 * 1000;

export async function bootV2(): Promise<void> {
  root = document.getElementById('v2-root');
  if (!root) return;
  root.hidden = false;
  // 릴레이 복귀 알림(#1881) — CP OAuth 릴레이(슬랙·노션)가 테넌트로 돌려보낼 때 ?slack=ok|slack_error= /
  //  ?notion=ok|notion_error= 를 붙인다(해시 라우트 #/connect/<앱> 은 그대로 열린다). 여기서 한 번 알리고
  //  주소에서 지운다 — 안 지우면 새로고침·탭 복제 때마다 같은 토스트가 또 뜬다.
  {
    const q = new URLSearchParams(location.search);
    let seen = false;
    for (const [app, label] of [['slack', 'Slack'], ['notion', '노션']] as const) {
      if (q.get(app) === 'ok') { toast(`${label} 연결이 끝났어요`); seen = true; }
      const err = q.get(`${app}_error`);
      if (err) { toast(`${label} 연결에 실패했어요 — ${err}`, true); seen = true; }
      q.delete(app); q.delete(`${app}_error`);
    }
    if (seen) { const rest = q.toString(); history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash); }
  }
  watchStaleShell();   // #1841 낡은 화면 자가복구 — 데스크톱 앱 창은 다시 열려도 loadURL 을 건너뛴다.
  // 실험장(#1719 원준): 작업대 골격(rail-mode)은 그대로 두되 **좌측 사이드바는 늘 보인다**(원준 2026-08-20:
  //  "새로고침하다 보면 사라질 때가 있다 — 항상 표시하고, 없앨 수는 없게. 폭만 끌어 조절"). 그래서
  //  여닫는 길(알약·×·핀)을 전부 걷고 **폭 손잡이 하나**만 남긴다 — 사라지지 않으니 되찾는 길도 필요 없다.
  root.classList.add('rail-mode');
  root.classList.toggle('solo', SOLO);
  root.replaceChildren(
    ...(SOLO ? [] : [
      sideEl = el('nav', { class: 'v2-side stu-side', 'aria-label': '탐색' }),
      makeSplitter({ axis: 'x', key: 'side-w', cssVar: '--v2-side-w', target: root, def: 316, min: 220, max: 560, grow: 1, label: '사이드바 너비' }),
    ]),
    centerEl = el('div', { class: 'v2-main', id: 'v2-main' }),
    makeSplitter({ axis: 'x', key: 'aside-w', cssVar: '--v2-aside-w', target: root, def: 316, min: 240, max: 720, grow: -1, label: '우패널 너비' }),
    asideEl = el('aside', { class: 'v2-aside', 'aria-label': '이 선택의 맥락' }));
  // 모바일 크롬(#1777) — 바는 그리드 맨 앞, 배경막은 맨 뒤. 데스크톱에선 둘 다 display:none 이라 그리드 열 순서에 안 낀다.
  if (!SOLO) {
    mobile = mountMobileChrome(root, sideEl!, asideEl!);
    root.prepend(mobile.bar);
    root.append(mobile.scrim);
    // 데스크톱 앱(frameless 창)이면 **창 맨 윗줄**을 셸이 가져간다. #1883 뒤에는 탭이 아니라
    // 창 버튼·드래그 영역만 남는다. 브라우저에서 연 웹 UI 에선 null 이다.
    titlebar = mountTitlebar(root);
  }

  // 실험장(#1719 원준): 크롬식 탭 줄은 걷는다 — 사이드바(프로젝트·열린 세션)가 이미 그 역할을 한다.
  //  탭 '기계'는 남긴다(화면마다 상태 보존·복귀가 이 구조에 실려 있다) — 줄만 안 그린다.
  // #1883: 열린 화면의 표현은 좌측 '앱' 목록 하나가 맡는다. 탭 DOM/상태 기계는 터미널·스크롤 보존을 위해
  // 그대로 두되, 전역 상단 줄은 그리지 않는다(같은 열린 화면을 위·왼쪽에서 두 번 보여 주지 않는다).
  const TABS_OFF = true;
  tabsApi = createTabs(centerEl!, asideEl!, {
    titleFor,
    onActivate: (tab, fresh) => {
      // 활성 탭의 라우트가 곧 주소다 — 다르면 맞춘다(이 hashchange 는 라우터가 무시).
      if (location.hash !== tab.route && '#' + location.hash !== tab.route) { suppressHash++; location.hash = tab.route; }
      applyTabChrome(tab);
      if (fresh) void renderRoute(tab);
      else markActive(routeKey(tab.route));
      drawSide();
    },
    onClose: (tab) => {
      if (tab.chat) { tab.chat.destroy(); tab.chat = null; }
      if (tab.appView) { tab.appView.destroy(); tab.appView = null; }
      // 탭 닫기 = AppWindow 연결 해제. AppInstance·세션·worker 생애주기는 별도라 여기서 종료 API를 부르지 않는다.
      dropProjView(tab); shellProject.delete(tab); drawSide();
    },
    // 탭 두 번 눌러 이름 바꾸기(원준 2026-08-20) — 세션 탭만. 판정은 세션 화면의 규칙과 같다:
    //  내 세션이고 살아 있고 복원 대기가 아닐 때(session-chat canRename).
    canRename: (tab) => {
      const k = routeKey(tab.route);
      if (!k.startsWith('s:')) return false;
      const s2 = findSess(k.slice(2));
      return !!s2 && s2.owned && s2.live && !s2.raw?.restorable;
    },
    onRename: async (tab, name) => {
      const id = routeKey(tab.route).slice(2);
      try { await renameSession(id, name, tab); toast('세션 이름을 바꿨어요.'); }
      catch (e: any) { toast('이름을 바꾸지 못했습니다 — ' + (e && e.message ? e.message : e), true); }
    },
  });
  if (!TABS_OFF) {
    // 탭 줄의 제자리 — 데스크톱 앱이면 창 맨 윗줄(타이틀바), 아니면 가운데 열 맨 위.
    //  (탭 패널들은 tabs.ts 가 이미 가운데·우패널에 붙였다 — 옮기는 건 '줄' 하나뿐이다.)
    const homeStrip = (): void => {
      if (titlebar) titlebar.host.prepend(tabsApi!.strip); else centerEl!.prepend(tabsApi!.strip);
    };
    homeStrip();
    // 모바일이면 탭 줄이 상단 바 가운데로 옮겨 간다(#1777) — 데스크톱으로 돌아오면 제자리로.
    mobile?.adoptStrip(tabsApi.strip, homeStrip);
  }

  setAsideGuestOpener(openAsideGuest);   // 잎(미리보기)이 곁칸을 쓸 수 있게 창구를 연다(v2/aside-slot.ts)
  //  앱 프레임(iframe) 안의 잎은 다른 창이라 위 창구가 안 닿는다 — postMessage 로 받는다.
  //  ⚠ 보낸 창이 **우리 탭의 프레임인지** 확인하고 그 탭에 연다(오리진만 보면 남의 프레임도 남의 탭을 조종할 수 있다).
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.origin !== location.origin || !ev.source || !tabsApi) return;
    const m: any = ev.data;
    if (!m || (m.type !== ASIDE_MSG.ping && m.type !== ASIDE_MSG.open)) return;
    const tab = tabsApi.tabs.find((t) => {
      const f = t.center.querySelector('iframe') as HTMLIFrameElement | null;
      return !!f && f.contentWindow === ev.source;
    });
    if (!tab) return;
    if (m.type === ASIDE_MSG.ping) { try { (ev.source as Window).postMessage({ type: ASIDE_MSG.pong }, location.origin); } catch { /* 프레임이 닫혔다 */ } return; }
    if (m.guest && typeof m.guest.url === 'string') openAsideGuest(m.guest as AsideGuest, tab);
  });
  drawSide(); // 데이터 전 골격(로고·리브·앱)부터 — 빈 화면을 오래 두지 않는다
  await loadData();

  // 시작 탭 — 주소에 화면이 있으면(딥링크) 그 화면: 있던 탭이면 그 탭, 아니면 저장된 활성 탭이 그리로 간다.
  let boot = location.hash && location.hash !== '#/' && location.hash !== '#' ? location.hash : null;
  // 처음 설정을 아직 안 끝낸 사람은 홈 대신 #/welcome 으로(#1813). 딥링크가 있으면 그쪽이 우선.
  if (!boot && !onboardingDone()) boot = '#/welcome';
  if (boot && tabsApi.find(boot)) { const hit = tabsApi.find(boot)!; hit.route = boot; tabsApi.activate(hit); }
  else {
    const saved = tabsApi.initial();
    const t = saved || tabsApi.add(boot || '#/', { activate: false });
    if (boot) t.route = boot;
    tabsApi.activate(t);
  }
  drawSide();

  window.addEventListener('hashchange', () => { histStamp(); void onHash(); });
  histStamp();     // 첫 화면도 히스토리의 한 칸이다 — 안 찍어 두면 되돌아왔을 때 '새로 감'으로 오인한다
  bindAltOpen();
  // 통합검색(⌘K) — 셸이 쥔 목록(세션·프로젝트)은 즉시, 나머지 자원은 REST 팬아웃. 이동은 탭 규칙을 아는 셸이 한다.
  setOmniHooks({
    data: () => data,
    open: (href, newTab, title) => {
      if (title) { const k = routeKey(href); if (k.startsWith('raw:')) routeTitleHint.set(k, title); }
      if (!tabsApi) { location.hash = href; return; }
      const hit = tabsApi.find(href);
      if (newTab) { if (hit) tabsApi.activate(hit); else tabsApi.add(href); return; }
      if (hit && hit !== tabsApi.current()) { hit.route = href; tabsApi.activate(hit); return; }
      location.hash = href;
    },
  });
  bindOmniKey();
  //  화면으로 돌아오면 즉시 최신으로 — 다음 틱을 기다리면 그 몇 초가 '멈춘 화면'으로 보인다.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !tabsApi) return;
    void loadData().then(() => { drawSide(); tabsApi!.paint(); });
  });
  // 사이드바 상태 — 라이브 세션은 자주 바뀐다. 8초 폴링(#1954: 20초는 '방금 끝난 것'이 한참 뒤에야 떠서
  //  화면이 묵은 것으로 읽혔다). 탭이 숨어 있으면 건너뛰고, **돌아온 순간 바로 한 판 당긴다**(아래 visibilitychange)
  //  — 건너뛴 동안 쌓인 지연이 사람 눈에 그대로 보이던 자리가 거기다.
  setInterval(() => {
    if (document.hidden || !tabsApi) return;
    void loadData().then(() => {
      drawSide(); tabsApi!.paint();
      const at = tabsApi!.active();
      const atPage = parseRoute(at.route).segs[0];
      if (atPage === 'inbox') renderInbox(at.center, data);   // 확인할 것 — 20초 결로 따라온다
      else if (atPage === 'archive') renderArchive(at.center, data, binHooks);   // 아카이브·휴지통도 같은 결(#1851)
      else if (atPage === 'trash') renderTrash(at.center, data, binHooks);
      for (const t of tabsApi!.tabs) {
        if (!t.chat) continue;
        const sid = routeKey(t.route).startsWith('s:') ? routeKey(t.route).slice(2) : '';
        const s = sid ? findSess(sid) : null;
        // ★ 셸이 **틀린 프로젝트로** 마운트돼 있으면 그 탭을 다시 그린다(#1834 재발 처방).
        //  재시작 창에 세션을 못 찾으면 loose(0)로 마운트되는데, 그대로 두면 문패가 '프로젝트 없는 세션'이고
        //  그 셸의 세션 목록도 남의 것(프로젝트 없는 세션들)이 된다 — 세션 화면이 남의 세션으로 바뀌던 사고의
        //  뿌리가 여기였다. 목록에서 그 세션을 **찾았을 때만** 판단하므로 빈 판에 흔들리지 않는다.
        if (s) {
          const want = s.projectId ? Number(s.projectId) : 0;
          const have = shellProject.get(t);
          if (have !== undefined && have !== want) { void renderRoute(t); continue; }
        }
        // ★ 탭이 보는 세션(라우트)과 **실제로 붙어 있는 화면**(chat.id)이 다르면 덧칠하지 않는다.
        //  어긋남 자체는 panes-parts.ts sessionsPart.paint 에서 막았지만, 어떤 경로로든 어긋나면 이 갱신이
        //  '상단바만 남의 세션'인 화면을 20초마다 다시 만든다(상민님 신고 2026-08-20).
        if (s && t.chat.id === s.id) { t.chat.update({ ...s, projectName: projName(data, s.projectId) });
          // 우측 '이 세션'도 — 프로젝트 드롭다운(#1749)은 body 팝오버라 우측을 되그려도 안 닫힌다.
          drawAsideSession(t, s); }
      }
    });
  }, 8000);
}

// 아카이브·휴지통 화면(#1851)의 배선 — 무엇을 바꾸든 서버가 정답이므로 다시 읽고 사이드바·탭을 되그린다.
const binHooks = { onChanged: () => { void loadData({ projects: true }).then(() => {
  drawSide(); tabsApi?.paint();
  // 그 화면 자체도 다시 — 되돌리기·완전 삭제 뒤 행이 그 자리에 남아 있으면 '안 됐나?'로 읽힌다(20초 결을 기다리지 않는다).
  const at = tabsApi?.active();
  if (at) { const pg = parseRoute(at.route).segs[0]; if (pg === 'archive') renderArchive(at.center, data, binHooks); else if (pg === 'trash') renderTrash(at.center, data, binHooks); }
}); } };

// ── 데이터 ──
// 마지막으로 **성공한** 세션 응답(라이브·기록) — 실패한 판이 화면을 비우지 않게 이 값을 다시 쓴다(loadData 주석).
let appInstances: AppInstanceRecord[] = [];   // #1883 — 서버가 아는 내 활성 인스턴스(창 유무와 무관)
let lastLive: any[] = [];
let lastLogs: any[] = [];
async function loadData(opts?: { projects?: boolean }): Promise<void> {
  const wantProj = opts && opts.projects != null ? opts.projects : (Date.now() - projLoadedAt > PROJ_TTL_MS);
  const [pj, lists0, folders0, insts0, live, logs] = await Promise.all([
    // 워크스페이스 **전체** 프로젝트(mine=1 아님) — 가시성은 서버가 시행한다(#1291).
    //  archived=include(#1851) — 보관한 프로젝트도 받는다: 그 아래 세션이 '프로젝트 없는 세션'으로 떨어지지 않게, 그리고
    //  「아카이브」 화면이 같은 데이터로 그려지게. 사이드바는 archived_at 을 보고 스스로 가른다(side.ts).
    wantProj ? api('/api/ui/v6/projects?archived=include&trashed=include').then((d) => (d && d.projects) || null).catch(() => null) : Promise.resolve(null),
    // #1883 열린 앱의 둘째·셋째 줄 — 프로젝트가 있으면 스페이스 › 리스트 › 프로젝트 계층을 보여 준다.
    wantProj ? api('/api/ui/v6/project-lists').then((d) => (d && d.lists) || null).catch(() => null) : Promise.resolve(null),
    wantProj ? api('/api/ui/v6/project-folders').then((d) => (d && d.folders) || null).catch(() => null) : Promise.resolve(null),
    // #1883 좌측 목록의 정본 — 창(탭)이 아니라 **살아 있는 앱 인스턴스**(#1780 v2.2 §2.2·§2.3).
    listAppInstances().catch(() => null),
    // ⚠ 실패를 '0건'으로 접지 않는다(null 로 구분) — 아래 '직전 목록 유지' 주석.
    api('/api/ui/terminal/sessions?includeProjects=1').then((d) => (d && d.sessions) || []).catch(() => null),
    api('/api/ui/v6/sessions').then((d) => (d && d.sessions) || []).catch(() => null),
  ]);
  let projects = data.projects;
  if (Array.isArray(pj)) {
    projects = (pj as any[]).map((p) => ({ id: Number(p.id), name: String(p.name || ''), status: p.status ?? null, status_category: p.status_category ?? null, description: p.description ?? null, list_id: p.list_id ?? null, updated_at: p.updated_at ?? null,
      // created_at — 사이드바가 '방금 만든 프로젝트'를 잠깐 맨 위에 세울 때 쓴다(side.ts freshMs).
      //  ⚠ 이 map 은 화이트리스트다. 서버가 주더라도 여기 없으면 화면엔 없는 값이다(#1819 실측: 정렬이 안 먹었다).
      created_at: p.created_at ?? null,
      archived_at: p.archived_at ?? null,   // #1851 아카이브 표식
      trashed_at: p.trashed_at ?? null,     // #1851 휴지통 표식(통째로 버림)
      created_by: p.created_by != null ? String(p.created_by) : null, member_ids: Array.isArray(p.members) ? p.members.map((m: any) => String(m && m.member_id != null ? m.member_id : m)) : [] }));
    projLoadedAt = Date.now();
  }
  if (Array.isArray(insts0)) appInstances = insts0;
  let lists = data.lists || [];
  let folders = data.folders || [];
  if (Array.isArray(lists0)) lists = lists0 as any[];
  if (Array.isArray(folders0)) folders = folders0 as any[];
  // 실패한 축은 **직전 응답을 그대로 쓴다**(상민님 신고 2026-08-20). 게이트웨이를 재배포하면 이 두 요청이
  //  몇 초간 실패하는데, 그때 빈 목록으로 덮으면 살아 있는 세션이 화면에서 통째로 사라졌다가 돌아온다 —
  //  그 한 판에 세션 화면이 다른 세션으로 갈아타는 사고가 났다(v2/panes-parts.ts sessionsPart.paint 주석).
  //  빈 배열(요청 성공)은 그대로 반영한다 — 실패와 '진짜 0건'은 다르다.
  if (Array.isArray(live)) lastLive = live as any[];
  if (Array.isArray(logs)) lastLogs = logs as any[];
  const sessions = mergeSessions(lastLive, lastLogs);
  applyRenamePins(sessions);   // 방금 고친 이름을 **떠 있던 응답이 되덮지 않게**(아래 renamePins)
  applyArchivePins(sessions);  // 방금 보관한 세션을 **되살리지 않게**(아래 archivePins)
  data = { projects, sessions, lists, folders, loadedAt: Date.now() };
  if (!wantProj) {
    const known = new Set(projects.map((p) => p.id));
    const fresh = sessions.filter((s) => s.projectId && !known.has(s.projectId) && !projRetried.has(s.projectId)).map((s) => s.projectId as number);
    if (fresh.length) { for (const id of fresh) projRetried.add(id); await loadData({ projects: true }); }
  }
}
const findSess = (id: string): Sess | undefined => data.sessions.find((x) => x.id === id) || data.sessions.find((x) => x.logId === id);

// ── 라우터 ──
function parseRoute(route: string): { segs: string[]; params: URLSearchParams; raw: string } {
  const h = String(route || '').replace(/^#\/?/, '');
  const q = h.indexOf('?');
  const path = q >= 0 ? h.slice(0, q) : h;
  return { segs: path.split('/').filter(Boolean), params: new URLSearchParams(q >= 0 ? h.slice(q + 1) : ''), raw: h };
}
// ── 클래식 딥링크의 이름 힌트 ──────────────────────────────────────────────
//  `#/k/<name>`·`#/knowledge/sources?src=…` 같은 주소는 앱 프레임으로 열리므로 탭 이름이 전부 **'WIKI'** 가 된다
//  (앱 표의 제목이 그거다). 지식 문서를 두 개만 열어도 탭 줄이 'WIKI · WIKI' 가 되어 서로 구분이 안 된다.
//  통합검색은 무엇을 여는지 **이미 알고 있으므로**(결과 줄의 제목) 그 이름을 여기 남긴다 — 탭이 제 이름을 갖는다.
//  ⚠ 힌트는 클래식 딥링크(routeKey 'raw:…')에만 쓴다. 세션·프로젝트 이름은 살아 있는 데이터가 정본이다.
const routeTitleHint = new Map<string, string>();
/** 라우트 → 탭 제목·우패널 유무(탭 줄이 매 paint 마다 묻는다 — 데이터가 늦게 와도 이름이 따라잡는다). */
function titleFor(route: string): { title: string; noAside: boolean; state?: string; kind?: string } {
  const { segs, raw } = parseRoute(route);
  const p = segs[0] || '';
  const key = routeKey(route);
  if (key.startsWith('raw:')) { const hint = routeTitleHint.get(key); if (hint) return { title: hint, noAside: true }; }
  // 실험장: **어느 화면에도 상시 타임라인 열은 없다**(원준 2026-08-19 "메인 홈에도 리브에도 떠 있는데 둘 다 없애줘").
  //  돌아보기는 불러오는 것 — 프로젝트 화면은 문패 [타임라인](알림 센터)이 그 자리를 맡는다.
  if (!p || p === 'dashboard') return { title: '홈', noAside: true };
  if (p === 'inbox') return { title: '확인할 것', noAside: true };
  if (p === 'archive') return { title: '아카이브', noAside: true };   // #1851
  if (p === 'trash') return { title: '휴지통', noAside: true };
  if (p === 'connect') return { title: segs[1] ? '앱 연결' : '외부 앱 연결', noAside: true };
  if (p === 'liv') return { title: '리브', noAside: true };
  if (p === 'welcome') return { title: '처음 설정', noAside: true };   // 온보딩(#1813) — 우패널 없이, 리브와 둘이서
  // 실험장 v4(2026-08-19 바탕화면): 프로젝트 화면은 우패널 없이 — 판이 폭 전체를 쓴다. 타임라인은 문패 [타임라인](알림 센터),
  //  위젯·앱은 도크 ⊞(런치패드)로 옮겨 갔다(web/v2/studio.ts 머리 주석).
  //  #/p/0 = 프로젝트 없는 세션들의 작업대(사이드바의 그 폴더) — 프로젝트가 아니라 '자투리 묶음'이다.
  // 프로젝트 주소로 남아 있는 탭 = **새 세션 자리**다(세션이 하나라도 있으면 라우터가 맨 위 세션으로 보낸다 —
  //  이 주소가 그대로 살아 있는 경우는 '＋ 세션'을 눌러 새 세션을 여는 중일 때뿐이다). 그래서 탭에는
  //  폴더+프로젝트명이 아니라 **새 세션**이라고 쓴다(원준 2026-08-20) — 프로젝트 이름은 바로 아래 문패가 말하고 있고,
  //  탭이 프로젝트명을 달고 있으면 '무엇을 하는 탭인지'가 아니라 '어디 있는지'만 되풀이된다.
  //  이름은 첫 지시를 넣는 순간 그 세션의 이름으로 바뀐다(서버가 지어 붙인다 — src/terminal/session-name-ai.ts).
  if (p === 'p') return { title: '새 세션', noAside: true, kind: 'new' };
  if (p === 's') {
    // 탭 제목도 사이드바와 **같은 규칙**(side.ts sessText)을 쓴다(#1744) — 종전엔 s.label 을 날것으로 써서
    //  탭에 `box-yoon-…`·`위탁 #41`·프로젝트명 반복이 그대로 떴다(dev 실측: 자동 생성 이름이 죽은 세션의 83%).
    //  sessText 는 그런 이름을 걷어내고 pane 제목('지금 하는 일')을 그 자리에 올린다.
    //  ★ 우패널 없음 — 세션 화면은 프로젝트 셸(v2/panes.ts) 안에서 열리고, 맥락(자료·지식·타임라인)은 그 셸의
    //   곁칸이 쥔다(2026-08-20 통합). 팝아웃 창(?solo=1)만 종전대로 세션 하나 + 발자취 우패널이다.
    const s = findSess(decodeURIComponent(segs[1] || ''));
    // 못 찾은 세션(죽었거나 아직 목록에 안 온 것)도 **서로 구분되게** — 전부 '세션'이면 다른 탭이 같아 보인다.
    if (!s) { const raw = decodeURIComponent(segs[1] || ''); const tail = raw.split('-').pop() || raw; return { title: '세션 ' + tail.slice(0, 6), noAside: !SOLO }; }
    const t = sessText(s, projName(data, s.projectId));
    // 아이콘 색이 될 상태 — 사이드바 점과 같은 판정(dotCls): 도는 중·확인 필요·끝남만 색을 갖는다.
    return { title: t.main || t.sub || String(s.raw?.harness || '세션'), noAside: !SOLO, state: dotCls(s.stateKey) };
  }
  if (p === 'i') {
    const instance = cachedAppInstance(decodeURIComponent(segs[1] || ''));
    return { title: instance?.title || instance?.app?.title || '앱', noAside: true };
  }
  //  프로젝트 화면은 **어느 프로젝트인가**가 곧 이름이다(#1883) — 여러 개 열면 전부 '프로젝트'라 서로 구분되지 않는다.
  const openedProject = projectPath(projectIdForRoute(route));
  if (p === 'app') { if (openedProject) return { title: openedProject.name, noAside: true }; const a = appByKey(segs[1]); return { title: a ? a.title : segs[1], noAside: true }; }
  if (CLASSIC_PAGES[p]) { if (openedProject) return { title: openedProject.name, noAside: true }; const a = appByKey(CLASSIC_PAGES[p]); return { title: a ? a.title : raw, noAside: true }; }
  return { title: '홈', noAside: true };
}
function applyTabChrome(tab: ShellTab): void {
  //  손님(미리보기)이 실려 있으면 곁칸이 없던 화면에도 곁칸을 연다 — 닫으면 다시 사라진다.
  const guest = !!(tab.aside as AsideHost).__guest;
  root!.classList.toggle('no-aside', tab.noAside && !guest);
  if (mobile) mobile.setAside(!tab.noAside || guest);   // 모바일 상단 바의 [타임라인] — 우패널이 없는 화면(앱 프레임)에선 버튼도 없다
  if (mobile) mobile.setTitle(titleFor(tab.route).title);
  // 리브 페이지를 떠나면 그 폴링이 멈추게(liv.ts 는 body.dataset.route==='liv' 동안만 폴링).
  document.body.dataset.route = routeKey(tab.route) === 'raw:liv' || parseRoute(tab.route).segs[0] === 'liv' ? 'liv' : 'v2';
}

/** 주소가 바뀌었다(링크 클릭·뒤로가기) — 활성 탭이 그 화면으로 이동한다. 이미 다른 탭에 있으면 그 탭으로 간다. */
async function onHash(): Promise<void> {
  if (!tabsApi) return;
  if (suppressHash > 0) { suppressHash--; return; }
  let hash = location.hash || '#/';
  // ★ 프로젝트 주소는 '거쳐 가는 문'이다(원준 2026-08-20 "그거 눌렀을 때 열리는 탭도 그냥 세션이 열리는걸로").
  //  사이드바에서 프로젝트 제목을 누르면 #/p/<id> 로 오는데, 그대로 탭을 만들면 **프로젝트 탭**이 하나 생겼다가
  //  그 안에서 다시 세션으로 바뀐다(제목이 두 번 바뀌고, 이미 프로젝트 탭이 있으면 그 낡은 탭이 켜졌다).
  //  그래서 탭을 고르기 **전에** 여기서 그 프로젝트의 맨 위 세션(사이드바 첫 줄과 같은 정의)으로 갈아 끼운다.
  // ★ 같은 세션이 **두 철자**로 열려 탭이 둘이 되던 것(원준 2026-08-20 신고) — 세션은 박스 id(box-…)와
  //  중앙 기록 id(uuid) 두 이름을 갖는다(findSess 가 둘 다 받는다). 타임라인·기록에서 열면 uuid, 사이드바에서
  //  열면 박스 id 라 routeKey 가 갈려 '한 세션 = 한 탭'이 깨졌다. 탭을 고르기 전에 **박스 id 로 통일**한다.
  const canon = canonSessionHash(hash);
  if (canon !== hash) { hash = canon; suppressHash++; location.replace(location.pathname + location.search + hash); }
  const pk0 = routeKey(hash);
  // ⚠ ?new=1 은 **새 세션 자리를 달라**는 뜻이라 이 갈아끼우기를 건너뛴다(사이드바 프로젝트 줄의 [＋]·문패 [＋ 세션]).
  //  routeKey 는 쿼리를 버리므로 여기서 원래 주소의 쿼리를 따로 본다 — 안 그러면 [＋]를 눌러도 맨 위 세션이 열린다(실측 2026-08-20).
  if (pk0.startsWith('p:') && parseRoute(hash).params.get('new') !== '1') {
    const top = topSessionOf(Number(pk0.slice(2)));
    if (top) {
      hash = '#/s/' + encodeURIComponent(top.id);
      suppressHash++;                                   // 이 replace 가 만든 hashchange 는 라우터가 무시한다
      location.replace(location.pathname + location.search + hash);
    }
  }
  const cur = tabsApi.active();
  if (routeKey(cur.route) === routeKey(hash)) { cur.route = hash; tabsApi.routed(cur); return; }
  // 이 탭 안에서 이어지는 이동인가(프로젝트 → 그 프로젝트의 세션) — 새 탭 규칙만 건너뛴다.
  const hop = inTabHops > 0;
  if (hop) inTabHops--;
  const other = tabsApi.find(hash);
  if (other && other !== cur) { tabsApi.activate(other); return; }   // 같은 화면(같은 세션·프로젝트)은 그 탭으로 — 두 번 그리지 않는다
  // ⓪ **홈에서 출발하면 그 자리에서 간다**(상민님 2026-08-20) — 홈은 [새 작업]이 새 탭으로 여는 **빈 탭**이라,
  //  거기서 연 화면이 그 탭이 된다(브라우저 새 탭 페이지 문법). 아래 ①·②보다 먼저 본다: 안 그러면 [새 작업]을
  //  누를 때마다 쓰지 않은 홈 탭이 하나씩 남는다.
  //  새 탭에서 여는 두 경우(원준 2026-08-20 + #1780 AppInstance):
  //  ① **실행 인스턴스로 간다** — 세션(s:)·일반 앱 인스턴스(i:)가 탭으로 나란히 살아야 한다.
  //  ② **실행 인스턴스에서 출발** — 그 탭은 해당 AppInstance 창으로 남는다. 안 그러면 다른 앱을 열었다고
  //     열어 둔 대화가 통째로 사라진다(실측: dev 에서 '안뇽' 세션 탭이 프로젝트로 바뀌어 없어졌다).
  //  나머지(프로젝트 → 프로젝트·앱 등)는 종전대로 그 탭 안에서 이동한다 — 클릭마다 탭이 불어나면 그것도 못 쓴다.
  const fromHome = routeKey(cur.route) === 'home';
  const targetInstance = /^(s|i):/.test(routeKey(hash));
  const currentInstance = /^(s|i):/.test(routeKey(cur.route));
  if (!hop && !fromHome && (targetInstance || currentInstance)) { tabsApi.add(hash); return; }
  if (cur.chat) { cur.chat.destroy(); cur.chat = null; }   // 세션 화면을 떠나면 그 폴링·리스너를 끈다
  dropProjView(cur);                                       // 프로젝트 화면(#1757)의 리브 턴 폴링도
  cur.route = hash;
  tabsApi.routed(cur);     // 제목·noAside 를 새 라우트로 먼저 — 그 뒤에 크롬을 맞춘다(거꾸로 하면 no-aside 가 한 화면 늦게 따라온다, 실측 #1777)
  applyTabChrome(cur);
  await renderRoute(cur);
  drawSide();
}

// Alt+클릭 = 새 탭에서 열기 — 셸 안 링크(#/…)에만. (Cmd/Ctrl+클릭은 브라우저 새 탭 그대로 둔다.)
function bindAltOpen(): void {
  document.addEventListener('click', (e) => {
    if (!e.altKey || !tabsApi) return;
    const a = (e.target as HTMLElement | null)?.closest?.('a[href^="#/"]') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    const href = a.getAttribute('href') || '#/';
    const hit = tabsApi.find(href);
    if (hit) tabsApi.activate(hit); else tabsApi.add(href);
  }, true);
}

async function renderRoute(tab: ShellTab): Promise<void> {
  const seq = ++tab.seq;
  if ((tab as any).ob) { (tab as any).ob.destroy(); (tab as any).ob = null; }   // 처음 설정 화면을 떠나면 읽기 타이머·사이드바 숨김을 푼다
  const { segs, raw, params } = parseRoute(tab.route);
  const page = segs[0] || '';

  // 한 탭에는 한 AppInstance 화면만 산다. 같은 탭이 다른 route로 이동하면 이전 iframe/브리지를 먼저 정리한다.
  if (tab.appView) { tab.appView.destroy(); tab.appView = null; }
  if (page !== 's' && page !== 'i') clearTabAppInstance(tab);

  // 활성 표시 키는 화면 대장(shell-surfaces)이 정한다 — 새 화면을 만들면 대장을 거치게 되고,
  //  그때 '이건 앱인가 OS 표면인가'를 반드시 고르게 된다(가드: scripts/shell-surface-registry.test.mjs).
  markActive(activeNavKey(page, page === 's' ? decodeURIComponent(segs[1] || '') : segs[1]));
  try {
    if (page === '' || page === 'dashboard') {
      renderHome(tab.center, data);
      tab.aside.replaceChildren();
    } else if (page === 'inbox') {
      markActive('inbox');
      renderInbox(tab.center, data);
      tab.aside.replaceChildren();
    } else if (page === 'archive' || page === 'trash') {
      // 아카이브·휴지통(#1851) — 사이드바 발치의 두 행이 여는 화면. ⚠ 'trash' 는 클래식 표(CLASSIC_PAGES)에도 있어
      //  이 분기가 그보다 **앞에** 서야 한다(뒤에 두면 WIKI 앱 프레임의 옛 휴지통이 열린다 — 그쪽은 화면 안 링크로 간다).
      markActive(page);
      if (page === 'archive') renderArchive(tab.center, data, binHooks); else renderTrash(tab.center, data, binHooks);
      tab.aside.replaceChildren();
    } else if (page === 'connect') {
      markActive('connect');
      tab.aside.replaceChildren();
      // 목록과 앱 상세는 같은 라우트의 두 깊이 — seq 로 늦은 응답을 버린다(빠르게 오가면 옛 화면이 덮는다).
      if (segs[1]) await renderConnectApp(tab.center, decodeURIComponent(segs[1]));
      else await renderConnect(tab.center);
      if (seq !== tab.seq) return;
    } else if (page === 'liv') {
      tab.center.replaceChildren();
      const host = el('div', { class: 'v2-livpage' });
      tab.center.append(host);
      tab.aside.replaceChildren();
      await renderLiv(host, { rail: null, embedded: true });   // rail 없음 = 카드·편지는 본문에(종전 drawAsideLiv 도 null 을 돌려줬다)
    } else if (page === 'welcome') {
      // 처음 설정(#1813) — 리브가 이름·무대·자료·AI 를 묻고 채팅으로 이어진다. 막1(이름)에서는 사이드바·탭 줄을 숨긴다(노션 p1).
      tab.center.replaceChildren();
      const host = el('div', { class: 'ob-root' });
      tab.center.append(host);
      markActive('liv');
      (tab as any).ob = renderOnboarding(host, {
        onBare: (bare) => root?.classList.toggle('ob-bare', bare),
        onDone: () => { void loadData().then(() => drawSide()); },
      });
    } else if (page === 'p' && segs[1]) {
      // ★ 프로젝트 전용 화면은 없앴다(원준 2026-08-20) — 프로젝트는 세션이 놓인 방이고, 주소는 늘 세션이다.
      //  그 프로젝트의 **맨 위 세션**(사이드바와 같은 정렬)으로 보낸다. 세션이 하나도 없으면 그때만 이 주소가
      //  '새 세션 자리'로 열린다(갈 세션이 없으니 폴백이 필요하다).
      const id = Number(segs[1]);
      // ?new=1 = **새 세션 자리를 달라**는 뜻(사이드바 [＋]·문패 [＋ 세션]). 그때는 맨 위 세션으로 보내지 않는다.
      const first = params.get('new') === '1' ? null : topSessionOf(id);
      if (first) { goSession(first.id, tab); return; }
      await mountProjectShell(tab, id, null, seq);
    } else if (page === 's' && segs[1]) {
      const id = decodeURIComponent(segs[1]);
      let s = findSess(id);
      // 방금 만든 세션이면 생성 응답 전문으로 먼저 그린다(created-cache — 노드 세션은 목록 반영이 한 박자 늦다).
      if (!s) {
        const seeded = takeCreated(id);
        if (seeded) { data.sessions = mergeSessions([seeded as any], []).concat(data.sessions); s = findSess(id); }
      }
      if (!s) { await loadData(); drawSide(); s = findSess(id); }
      // 그래도 없으면(다른 탭에서 만든 노드 세션 등) 에러로 끝내지 않는다 — "새로고침해 주세요"는 사람에게 폴링을 시키는 것.
      if (!s) {
        tab.center.replaceChildren(el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '세션을 여는 중…' })));
        for (let i = 0; i < 4 && !s; i++) {
          await new Promise((r) => setTimeout(r, 800));
          if (seq !== tab.seq) return;
          await loadData();
          s = findSess(id);
        }
        drawSide();
      }
      if (seq !== tab.seq) return;
      // 기존 공개 route(#/s/:id)는 유지하되 실행 정체성은 세션을 실제로 띄운 AppPackage의 AppInstance로 확보한다.
      // 일반 세션만 ai-session builtin으로 접힌다 — 종전의 '세션 앱'과 일반 앱이 같은 package/instance 모델을 쓴다.
      // 인스턴스 메타 실패가 살아 있는 세션 자체를 가리지 않도록 화면 렌더와는 분리한다.
      try {
        const title = s ? (sessText(s, projName(data, s.projectId)).main || s.label || 'AI 세션') : 'AI 세션';
        const appId = String(s?.raw?.appId || s?.raw?.app_id || 'ai-session');
        const instance = await ensureSessionAppInstance(appId, s?.id || id, { projectId: s?.projectId ? Number(s.projectId) : null, title });
        if (seq !== tab.seq) return;
        setTabAppInstance(tab, instance.id, instance.app_id);
      } catch (error) { console.warn('[app-instance] AI 세션 인스턴스 확보 실패', error); }
      // 팝아웃 창(?solo=1)은 **세션 하나만 담은 창**이다 — 프로젝트 셸을 두르지 않는다(그게 이 창의 정의).
      if (SOLO) {
        const trail = drawAsideSession(tab, s || null);
        tab.chat = renderSession(tab.center, data, id, {
          trail,
          onPickProject: (anchor) => openProjectPicker(anchor, id, tab),
          onRename: (label) => renameSession(s ? s.id : id, label, tab),
          onToggleFiles: () => toggleAsideFiles(tab, id),
          solo: true,
        });
        return;
      }
      await mountProjectShell(tab, s && s.projectId ? Number(s.projectId) : 0, id, seq);
    } else if (page === 'i' && segs[1]) {
      const instance = await getAppInstance(decodeURIComponent(segs[1]));
      if (seq !== tab.seq) return;
      setTabAppInstance(tab, instance.id, instance.app_id);
      const renderer = instance.app.system?.renderer;
      if (renderer === 'browser') {
        let lastSaved = String(instance.state?.url || '');
        let timer = 0;
        const saveUrl = (url: string): void => {
          if (!url || url === lastSaved) return;
          lastSaved = url;
          window.clearTimeout(timer);
          timer = window.setTimeout(() => { void updateAppInstance(instance.id, { state: { url } }).catch(() => {}); }, 300);
        };
        const root = browserSurface({
          url: String(instance.state?.url || instance.app.system?.home || 'https://www.google.com/'),
          title: instance.title || instance.app.title,
          onUrl: saveUrl,
        });
        tab.center.replaceChildren(root);
        tab.appView = { destroy: () => { window.clearTimeout(timer); root.remove(); } };
      } else if (instance.subject_kind === 'session' && instance.subject_ref) {
        // 현재 세션의 공개·공유 링크는 #/s/:id가 정본이다. 복원된 #/i route만 같은 탭 안에서 그 정본으로 넘긴다.
        goSession(instance.subject_ref, tab);
        return;
      } else {
        const frame = await mountAppUiFrame(instance.app_id, {
          page: instance.page_key || undefined,
          title: instance.title || instance.app.title,
          instanceId: instance.id,
        });
        if (seq !== tab.seq) { frame.destroy(); return; }
        tab.center.replaceChildren(frame.root);
        tab.appView = frame;
      }
      tab.aside.replaceChildren();
      markActive('app-instance:' + instance.app_id);
    } else if (page === 'app' && segs[1]) {
      // 구 브라우저 route를 저장한 탭/북마크는 새 browser AppPackage 인스턴스로 한 번 이관한다.
      if (segs[1] === 'web') {
        let url = 'https://www.google.com/';
        if (segs[2]) { try { url = decodeURIComponent(segs[2]); } catch { url = segs[2]; } }
        const instance = await createAppInstance('browser', { title: '웹 브라우저', state: { url } });
        const href = '#/i/' + encodeURIComponent(instance.id);
        tab.route = href;
        if (tabsApi?.current() === tab && location.hash !== href) { suppressHash++; location.replace(location.pathname + location.search + href); }
        tabsApi?.routed(tab);
        void renderRoute(tab);
        return;
      }
      const a = appByKey(segs[1]);
      if (a) noteAppUse(a.key);   // 홈 한 줄이 읽는 '최근에 연 앱'(#1954)
      const rest = segs.slice(2).join('/');
      // 브라우저 앱(#1829)은 우리 화면이 아니라 남의 웹이다 — iframe(appFrame)이 아니라 서피스로 띄운다.
      //  ⚠ 주소는 **한 세그먼트에 encodeURIComponent 로** 싣는다(`#/app/web/https%3A%2F%2Fexample.com`).
      //   raw 로 넣으면 안 된다 — parseRoute 가 '/' 로 쪼갠 뒤 filter(Boolean) 로 빈 조각을 버려서
      //   `https://x` 의 `//` 가 `/` 하나로 뭉개진다(`https:/x` = 못 여는 주소).
      if (a && a.kind === 'browser') {
        let url = a.home || '';
        if (segs[2]) { try { url = decodeURIComponent(segs[2]); } catch { url = segs[2]; } }
        tab.center.replaceChildren(browserSurface({ url, title: a.title }));
        markActive('app:' + a.key);
      } else {
      const hash = a ? a.route + (rest ? '/' + rest : '') : segs.slice(1).join('/');
      tab.center.replaceChildren(appFrame(hash, a ? a.title : segs[1]));
      markActive('app:' + (a ? a.key : ''));
      }
    } else if (CLASSIC_PAGES[page]) {
      const a = appByKey(CLASSIC_PAGES[page]);
      if (a) noteAppUse(a.key);
      tab.center.replaceChildren(appFrame(raw, a ? a.title : page));
      markActive('app:' + (a ? a.key : ''));
    } else {
      renderHome(tab.center, data);
      tab.aside.replaceChildren();
    }
  } catch (e: any) {
    tab.center.replaceChildren(el('div', { class: 'v2-center' }, el('p', { class: 'v2-muted', text: '화면을 불러오지 못했습니다 — ' + (e && e.message ? e.message : e) })));
  }
  tabsApi?.routed(tab);
}

// ── 사이드바 ── (트리·필터·펼침은 web/v2/side.ts — 여기선 활성 표시·활성 키·열린 탭 목록만)
function markActive(key: string): void {
  if (!sideEl) return;
  let hit: HTMLElement | null = null;
  for (const a of Array.from(sideEl.querySelectorAll<HTMLElement>('[data-nav]'))) { const on = a.dataset.nav === key; a.classList.toggle('on', on); if (on && !hit) hit = a; }
  //  모바일 서랍이 닫혀 있을 땐 굴리지 않는다(#1777) — 화면 밖에 고정된 서랍을 향해 굴리면 문서 자체가 밀린다. 서랍을 열 때 mobile.ts 가 굴린다.
  if (hit && key !== 'home' && key !== 'liv' && !(mobile && mobile.isMobile() && !root!.classList.contains('m-side'))) hit.scrollIntoView({ block: 'nearest' });
}
function activeKey(): string {
  // 부작용 없는 조회 — 부팅 중(활성 탭 확정 전)의 drawSide 가 탭을 만들어 버리면 딥링크가 죽는다(실측).
  const t = tabsApi ? tabsApi.current() : null;
  const cur = parseRoute(t ? t.route : location.hash);
  return cur.segs[0] === 'p' ? 'p:' + cur.segs[1] : cur.segs[0] === 's' ? 's:' + decodeURIComponent(cur.segs[1] || '') : cur.segs[0] === 'liv' ? 'liv' : cur.segs[0] === 'inbox' ? 'inbox' : cur.segs[0] === 'connect' ? 'connect' : cur.segs[0] === 'archive' ? 'archive' : cur.segs[0] === 'trash' ? 'trash' : (!cur.segs[0] || cur.segs[0] === 'dashboard') ? 'home' : cur.segs[0] === 'app' ? 'app:' + cur.segs[1] : 'app:' + (CLASSIC_PAGES[cur.segs[0]] || '');
}
// ── 좌측 사이드바는 **늘 있다**(원준 2026-08-20) ──────────────────────────────────
//  이력: 3차(2026-08-19)에 좌측 열을 걷고 떠다니는 알약으로 여닫게 했는데, 그 알약이 ⓐ 자리를 가리고
//  ⓑ 새로고침·상태에 따라 목록이 사라져 "왜 없어졌나"를 매번 되찾아야 했다(원준 신고). 목록은 셸의 뼈대다 —
//  숨길 수 있는 것으로 두면 숨겨진 상태가 기본이 된다. 그래서 **없앨 수 없고, 폭만 조절**한다.
//  · 닫기(×)·핀 고정·알약(stu-panel-fab)·그 자리 기억(stu_fab_pos)은 전부 제거했다.
//  · 패널 머리글도 뺐다 — 트리 자신이 이미 '프로젝트 · N'과 검색·필터를 머리에 두고 있어 두 겹이었다.
// ⚠ **패널 DOM 을 매번 새로 만들지 않는다**(원준 2026-08-21 "세션을 클릭할 때마다 팅팅 맨 위로 올라간다").
//  종전엔 drawSide 마다 `sideEl.replaceChildren(새 div)` 로 통째 교체했는데, 그러면 **옛 트리가 문서에서
//  떨어져 나가는 순간 그 scrollTop 이 0 이 된다.** side.ts 의 render() 는 `prevScroll = treeEl.scrollTop` 으로
//  스크롤을 이어받으려 하지만, 그 값을 읽을 때 옛 트리는 **이미 detach 된 뒤**라 늘 0 을 읽었다.
//  실측(라이브, 트리 높이 8405 · 창 266): 600 으로 내려 둔 스크롤이 20초 폴링 한 번에 **0** 으로 튀었다.
//  세션 클릭·이름 변경·보관(×)·폴링 — drawSide 를 부르는 모든 길에서 같은 일이 났다.
//  숙주(treeHost)를 **재사용**하면 옛 트리가 render() 안에서 교체될 때까지 붙어 있어 prevScroll 이 살아난다.
//  (불변식: 제자리 갱신은 스크롤을 옮기지 않는다 — [[inplace-update-must-not-move-scroll-1635]] ⓑ 와 같은 뿌리.)
let sideTreeHost: HTMLElement | null = null;

function projectIdForRoute(route: string): number {
  const { segs } = parseRoute(route);
  if (segs[0] === 'p') return Number(segs[1]) || 0;
  if (segs[0] === 's') {
    const s = findSess(decodeURIComponent(segs[1] || ''));
    return s && s.projectId ? Number(s.projectId) : 0;
  }
  if (segs[0] === 'app' && segs[1] === 'projects2' && segs[2] === 'p') return Number(segs[3]) || 0;
  if (segs[0] === 'projects2' && segs[1] === 'p') return Number(segs[2]) || 0;
  return 0;
}

/** 소속 프로젝트 — **이름 하나**. 스페이스 › 리스트 계층은 좁은 줄에서 뒤가 잘려 읽히지 않아 걷었다(#1954). */
function projectPath(id: number): { id: number; name: string } | null {
  if (!(id > 0)) return null;
  const p = data.projects.find((x) => Number(x.id) === id);
  return { id, name: (p && p.name) || `프로젝트 #${id}` };
}

/** 좌측 목록의 행 키 — 창·인스턴스·세션 중 무엇에서 왔든 **같은 대상이면 같은 한 행**으로 접힌다(#1883). */
function sideRowKey(route: string): string {
  const { segs } = parseRoute(route);
  if (segs[0] === 's') return 'sess:' + decodeURIComponent(segs[1] || '');
  if (segs[0] === 'i') return 'inst:' + decodeURIComponent(segs[1] || '');
  return 'route:' + routeKey(route);
}

/** route 하나가 좌측에서 갖는 얼굴 — 이름·아이콘·부제·소속 프로젝트. */
function sideRowFace(route: string): Omit<SideInstance, 'id' | 'active'> {
  const { segs } = parseRoute(route);
  const page = segs[0] || '';
  const info = titleFor(route);
  const base = projectPath(projectIdForRoute(route));
  //  프로젝트 화면 자신은 제목이 곧 프로젝트명이다 — 둘째 줄에 이름을 되풀이하지 않고 조상 경로만 둔다.
  const selfProject = !!base && (page === 'app' ? segs[1] === 'projects2' : (page === 'projects2' || CLASSIC_PAGES[page] === 'projects2'));
  const project = base ? { ...base, self: selfProject } : null;
  let icon: SideInstance['icon'] = 'app';
  let meta = '라이블리 앱';
  if (!page || page === 'dashboard') { icon = 'home'; meta = '아직 시작하지 않은 작업'; }
  else if (page === 's' || page === 'p') { icon = 'chat'; meta = project ? '' : 'AI 세션 · 프로젝트 없음'; }
  else if (page === 'inbox') { icon = 'inbox'; meta = '답과 확인을 기다리는 작업'; }
  else if (page === 'connect') { icon = 'link'; meta = '외부 앱 연결'; }
  //  치워 둔 곳(#1851)은 클래식 지식 앱으로 접히므로(CLASSIC_PAGES) 여기서 먼저 가른다 — 아니면 '지식 트리…'가 붙는다.
  else if (page === 'archive') { icon = 'archive'; meta = '보관해 둔 프로젝트'; }
  else if (page === 'trash') { icon = 'trash'; meta = '버린 세션과 프로젝트'; }
  else if (page === 'liv') { icon = 'liv'; meta = '워크스페이스 담당자'; }
  else {
    const appKey = page === 'app' ? segs[1] : CLASSIC_PAGES[page];
    const app = appByKey(appKey);
    if (app) { icon = app.icon; meta = app.desc; }
  }
  return { title: (!page || page === 'dashboard') ? '새 작업' : info.title, icon, state: info.state, meta, project };
}

//  행 키 → 그 행을 여는 route · 그 행이 쥔 AppInstance. 활성화·닫기가 이 두 표로 되돌아간다.
const sideRowRoute = new Map<string, string>();
const lastSideRows = new Map<string, SideInstance>();   // 방금 그린 행 — × 가 '그때 어떤 상태였나'를 읽는다
const sideRowInstance = new Map<string, string>();

/** 지금 사람이 볼 일이 있는 상태 — 이 셋만 위 묶음으로 올라간다(#1954). */
const PRIORITY_ST: Record<string, { label: string; rank: number }> = {
  waiting: { label: '확인 필요', rank: 0 },   // 내 승인·선택을 기다린다
  done:    { label: '작업 완료', rank: 1 },   // 끝났는데 아직 안 봤다 — 들어가 보면 사라진다
  busy:    { label: '작업 중',   rank: 2 },   // 지금 돌고 있다
};
const PRIORITY_GROUP = '지금 볼 것';
const PINNED_GROUP = '고정';   // 사람이 고른 것 — 상태·날짜와 무관하게 맨 위(#1954)

/** 마지막 작업 일시 → 묶음 이름. 오늘·어제는 그렇게 부르고, 그 앞은 날짜로. */
function dayGroup(at: number, now: number): string {
  if (!at) return '언젠가';
  const d = new Date(at); const n = new Date(now);
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86400000);
  if (diff <= 0) return '오늘';
  if (diff === 1) return '어제';
  return d.getFullYear() === n.getFullYear() ? `${d.getMonth() + 1}월 ${d.getDate()}일`
    : `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/**
 * 목록 안에서 **행이 스스로 움직이지 않게** 하는 자물쇠(#1954).
 *  돌고 있는 세션은 20초마다 lastSeen 이 갱신되므로, 그 값을 정렬에 그대로 쓰면 볼 때마다 순서가 뒤바뀐다
 *  (상민님 지적: "코덱스는 안 바뀌던데"). 그래서 정렬 키는 **그 행이 지금 묶음에 들어온 순간의 값**으로 얼린다.
 *  묶음이 바뀔 때만(상태가 변해 위로 올라가거나 날짜가 넘어갈 때) 다시 잰다 — 그때는 움직이는 게 맞다.
 */
/**
 * 목록에서 **치운 행**(#1954 상민님: "왜 어떤 건 닫을 수 있고 어떤 건 안 되냐").
 *  세션은 닫아도 박스에서 계속 돈다 — 그래서 × 의 뜻은 '끝내기'가 아니라 **'지금은 안 볼래'**다.
 *  치울 때의 상태를 함께 적어 두고, 그 상태가 바뀌면(작업 중 → 확인 필요·작업 완료) **다시 올라온다** —
 *  그게 이 목록이 하는 일이기 때문이다. 같은 상태로 계속 도는 동안엔 조용하다.
 *  기기별 습관이라 브라우저에 둔다.
 */
const DISMISS_STORE = 'lively_v2_side_dismissed';   // 이름을 `*_KEY` 로 두지 않는다 — 위 apps.ts 주석과 같은 이유(gitleaks 오탐)
let dismissed: Record<string, string> = (() => {
  try { const v = JSON.parse(localStorage.getItem(DISMISS_STORE) || '{}'); return v && typeof v === 'object' ? v : {}; }
  catch { return {}; }
})();
function saveDismissed(): void {
  try { localStorage.setItem(DISMISS_STORE, JSON.stringify(dismissed)); } catch { /* 못 남겨도 이번 화면은 된다 */ }
}

const orderPin = new Map<string, { group: string; at: number }>();
function pinnedAt(key: string, group: string, at: number): number {
  const had = orderPin.get(key);
  if (had && had.group === group) return had.at;
  orderPin.set(key, { group, at });
  return at;
}

/**
 * 좌측 목록의 정본(#1883 · #1780 v2.2 §2.2·§2.3) + 묶음·순서 규칙(#1954).
 *  **창(탭)이 아니라 살아 있는 것**을 센다 — 탭은 AppWindow 일 뿐이고 인스턴스는 창 없이도 산다(1:0..1).
 *  세 줄기를 한 목록으로 접는다:
 *   ① 돌고 있는 내 세션 — 이 브라우저에서 안 열었어도 박스에서 돌고 있으면 내 앱이다.
 *   ② 세션이 아닌 활성 인스턴스 — 창을 닫아도 서버에 살아 있다.
 *   ③ 지금 열려 있는 창 — 홈·확인할 것처럼 인스턴스가 없는 화면도 보고 있는 동안은 목록에 있어야 한다.
 *  끝난 세션의 인스턴스는 세우지 않는다(창이 붙어 있으면 ③이 세운다) — 아니면 지난 세션이 목록을 덮는다.
 *  묶음: 사람이 볼 일 있는 것(작업 중·확인 필요·완료 미확인)이 맨 위, 나머지는 마지막 작업 날짜별로.
 */
function sideInstances(): SideInstance[] {
  const activeTab = tabsApi ? tabsApi.current() : null;
  const activeKey = activeTab ? sideRowKey(activeTab.route) : '';
  const now = Date.now();
  sideRowRoute.clear(); sideRowInstance.clear();
  interface Row extends SideInstance { at: number; rank: number }
  const rows = new Map<string, Row>();
  const put = (key: string, route: string, at: number, stateKey?: string, force?: boolean): void => {
    const prev = rows.get(key);
    //  치운 행은 **그 상태 그대로인 동안** 숨는다. 창이 열려 있으면(force) 늘 보인다 — 보고 있는 화면이 목록에 없으면 그게 고장이다.
    if (!force && !prev && dismissed[key] !== undefined && dismissed[key] === (stateKey || '')) return;
    sideRowRoute.set(key, route);
    let sk = stateKey;
    //  ★ 보고 있는 행은 **그 자리에 머문다**(#1954 2차 상민님: "누르고 보고 있는 동안엔 위치 유지").
    //   초록점(작업 완료)을 눌러 들어가면 서버가 lastAttached 를 갱신해 그 즉시 '확인함'이 되고, 목록이
    //   눈앞에서 그 행을 아래로 내려보냈다 — 방금 연 것이 도망가는 화면이다. 활성인 동안엔 직전 상태를 쓰고,
    //   다른 곳으로 나가는 순간 제 자리를 찾아간다(그때는 옮겨도 사람이 안 놓친다).
    if (key === activeKey) { const was = lastSideRows.get(key); if (was && !sk) sk = was.status?.key; }
    const st = sk ? PRIORITY_ST[sk] : undefined;
    const rawAt = Math.max(at, prev ? prev.at : 0);
    //  고정한 것은 상태·날짜와 무관하게 맨 위 제 묶음에 선다 — 사람이 고른 자리를 자동 규칙이 흔들지 않는다.
    const pin = isAppPinned(key);
    const group = pin ? PINNED_GROUP : st ? PRIORITY_GROUP : dayGroup(rawAt, now);
    rows.set(key, { ...sideRowFace(route), id: key, active: key === activeKey, pinned: pin,
      status: st ? { key: sk!, label: st.label } : null,
      group, rank: st ? st.rank : 9, at: pinnedAt(key, group, rawAt) });
  };

  for (const s of data.sessions) {                                   // ① 돌고 있는 내 세션
    if (!s.live || !s.alive || !s.owned || isTrashedSess(s)) continue;
    put('sess:' + s.id, '#/s/' + encodeURIComponent(s.id), s.lastSeen || 0, s.stateKey);   // lastSeen 은 ms(views.ts)
  }
  for (const inst of appInstances) {                                 // ② 세션 아닌 활성 인스턴스
    if (inst.status !== 'active') continue;
    const at = Date.parse(String(inst.updated_at || inst.created_at || '')) || 0;
    if (inst.subject_kind === 'session') {
      if (inst.subject_ref && rows.has('sess:' + inst.subject_ref)) sideRowInstance.set('sess:' + inst.subject_ref, inst.id);
      continue;
    }
    sideRowInstance.set('inst:' + inst.id, inst.id);
    put('inst:' + inst.id, '#/i/' + encodeURIComponent(inst.id), at);
  }
  (tabsApi ? tabsApi.tabs : []).forEach((tab, i) => {                // ③ 지금 열린 창
    const key = sideRowKey(tab.route);
    put(key, tab.route, rows.has(key) ? rows.get(key)!.at : now - i, rows.get(key)?.status?.key, true);
  });

  // 살아 있는 행만 자물쇠에 남긴다 — 안 그러면 닫힌 세션의 옛 자리가 영영 쌓인다.
  for (const k of [...orderPin.keys()]) if (!rows.has(k)) orderPin.delete(k);

  const all = [...rows.values()];
  const dayOf = new Map<string, number>();   // 묶음 이름 → 그 묶음의 최신 시각(묶음끼리의 순서)
  for (const r of all) if (r.group !== PRIORITY_GROUP && r.group !== PINNED_GROUP) dayOf.set(r.group!, Math.max(dayOf.get(r.group!) || 0, r.at));
  const out = all.sort((a, b) => {
    const af = a.group === PINNED_GROUP, bf = b.group === PINNED_GROUP;
    if (af !== bf) return af ? -1 : 1;                       // 고정한 것이 맨 위 — 사람이 고른 자리다
    if (af) return b.at - a.at;
    const ap = a.group === PRIORITY_GROUP, bp = b.group === PRIORITY_GROUP;
    if (ap !== bp) return ap ? -1 : 1;                       // 볼 일 있는 것이 그다음
    if (ap) return a.rank - b.rank || b.at - a.at;           // 확인 필요 → 작업 완료 → 작업 중
    if (a.group !== b.group) return (dayOf.get(b.group!) || 0) - (dayOf.get(a.group!) || 0);   // 날짜 내림차순
    return b.at - a.at;
  }).map(({ at: _at, rank: _rank, ...row }) => row);
  lastSideRows.clear();
  for (const r of out) lastSideRows.set(r.id, r);
  return out;
}

/**
 * 좌측 행의 × = **목록에서 치우기**(#1954). 어느 행이든 같은 뜻이라 전부 닫을 수 있다.
 *  하는 일: ① 창이 있으면 뗀다(UI detach) ② 인스턴스가 있으면 닫는다 ③ 그 행을 지금 상태로 치워 둔다.
 *  ⚠ 세션·worker 는 죽이지 않는다(#1780 v2.2 §2.3) — 돌던 일은 그대로 돌고, 상태가 바뀌면 목록에 다시 올라온다.
 */
async function closeSideRow(key: string): Promise<void> {
  const route = sideRowRoute.get(key);
  const instanceId = sideRowInstance.get(key);
  const row = lastSideRows.get(key);
  dismissed[key] = row?.status?.key || '';
  saveDismissed();
  if (route && tabsApi) { const hit = tabsApi.find(route); if (hit) tabsApi.close(hit); }
  if (instanceId) {
    try { await closeAppInstance(instanceId); appInstances = appInstances.filter((x) => x.id !== instanceId); }
    catch (_) { toast('앱을 닫지 못했습니다'); }
  }
  drawSide();
  refreshSideNow();
}

/**
 * 사이드바에서 무언가를 한 **직후**에는 다음 틱을 기다리지 않고 그 자리에서 다시 읽는다(#1954 2차).
 *  8초 틱만 믿으면 방금 누른 결과가 몇 초 뒤에야 반영돼 화면이 굼떠 보인다 — 사람이 만든 변화는 즉시 비춘다.
 */
function refreshSideNow(): void {
  void loadData().then(() => { drawSide(); tabsApi?.paint(); });
}

/** 좌측 행을 누르면 그 대상에 창을 붙인다 — 이미 열려 있으면 그 창으로, 아니면 새 창. */
function openSideRow(key: string): void {
  const route = sideRowRoute.get(key);
  if (!route || !tabsApi) return;
  const hit = tabsApi.find(route);
  if (hit) tabsApi.activate(hit); else tabsApi.add(route);
  refreshSideNow();
}

/** 프로젝트 경로를 누르면 현재 세션을 덮지 않고 '프로젝트' 앱 인스턴스를 열거나 재사용한다. */
function openProjectPage(projectId: number): void {
  if (!tabsApi || !(projectId > 0)) return;
  const href = '#/app/projects2/p/' + projectId;
  const hit = tabsApi.find(href);
  if (!hit) { tabsApi.add(href); return; }
  const wasRendered = hit.rendered;
  hit.route = href;
  if (tabsApi.current() !== hit) tabsApi.activate(hit);
  else if (location.hash !== href) { suppressHash++; location.hash = href; applyTabChrome(hit); }
  tabsApi.routed(hit);
  if (wasRendered) void renderRoute(hit);
  drawSide();
  refreshSideNow();
}

function drawSide(): void {
  if (!sideEl) return;
  if (!sideTreeHost || !sideEl.contains(sideTreeHost)) {
    sideTreeHost = el('div', { class: 'stu-panel-tree' }) as HTMLElement;
    sideEl.replaceChildren(el('div', { class: 'stu-panel' }, sideTreeHost));
  }
  const treeHost = sideTreeHost;
  drawSideTree(treeHost!, data, activeKey, {
    onNewSession: newSessionFor,
    // 사이드바에서 고친 이름은 **화면 전체**에 반영한다 — 목록만 바뀌고 탭·대화창 제목이 옛 이름이면 그게 더 혼란스럽다.
    onRenameSession: (id, label) => renameSessionEverywhere(id, label),
    onRenameProject: (pid, name) => renameProject(pid, name),
    // 보관(×) 뒤 — 그 세션은 이제 '지난 세션'이라 목록의 자리가 바뀐다. 서버가 정답이므로 다시 읽는다.
    //  휴지통·아카이브(#1851)도 같은 훅으로 온다 — 그 화면이 열려 있으면 그 화면까지 다시 그린다(binHooks).
    //  ⚠ 서버 응답을 기다린 뒤에 옮기면 **몇 초 동안 그대로 살아 있는 것처럼 보인다**(원준 2026-08-21:
    //   "바로 없어지는 게 아니라 시간이 좀 지나거나 새로고침해야 이동한다"). 목록에서 tmux 가 실제로 죽고
    //   그게 목록 API 에 반영되기까지 시차가 있어서다. 그래서 **먼저 화면에서 옮기고**(pinArchived) 나서
    //   서버를 다시 읽는다. 되읽기가 아직 '살아 있다'고 해도 30초 동안은 이 결정이 이긴다(applyArchivePins).
    onArchived: (id?: string) => { if (id) { pinArchived(id); drawSide(); } binHooks.onChanged(); },
    // [새 작업] — **늘 새 탭**에 홈을 연다. 이미 열린 홈 탭으로 되돌아가면(find→activate) 거기 쓰던 지시가 덮이고,
    //  '새로 시작한다'는 이름과 동작이 어긋난다. 빈 홈 탭이 남으면 세션을 열 때 그 자리가 세션이 되어 정리된다.
    onNewTask: () => { tabsApi?.add('#/'); },
    onSearch: () => omniOpen(),
    onBack: () => history.back(),
    onForward: () => history.forward(),
    navState: () => ({ back: histPos > 0, forward: histPos < histSeq }),
    instances: sideInstances,
    onActivateInstance: openSideRow,
    onCloseInstance: (key) => { void closeSideRow(key); },
    onOpenProject: openProjectPage,
    //  창 맨 윗줄이 우리 것이면 뒤로·앞으로·검색을 거기 건다 — 상단 탭이 빠져 비어 있던 자리다(#1954).
    navHost: () => (titlebar ? titlebar.host : null),
    onPinChanged: () => { orderPin.clear(); },   // 고정이 바뀌면 자물쇠를 푼다 — 새 묶음에서 자리를 다시 잡아야 한다
  });
}

// ── 뒤로/앞으로가 켜져 있어야 하는가 ─────────────────────────────────────────────
//  브라우저는 "뒤에 뭐가 있나"를 알려 주지 않는다(history.length 는 앞뒤를 안 가른다). 그래서 **우리가 센다**:
//  엔트리마다 replaceState 로 순번을 찍어 두고, hashchange 때 그 순번이 있으면 '되돌아온 것', 없으면 '새로 간 것'이다.
//  · 새로 감  → 순번 = ++histSeq (앞 기록은 잘렸으므로 forward 꺼짐)
//  · 되돌아옴 → 찍힌 순번을 그대로 → back/forward 판정이 정확해진다
//  location.replace(라우터의 리다이렉트)는 상태를 지운다 → 그 엔트리는 '새로 감'으로 잡힌다(pos=seq → forward 꺼짐).
//  뒤로는 켜진 채로 남는데, 그게 맞다(앞 화면은 실제로 있다).
let histSeq = -1;   // 아직 아무 엔트리도 안 찍었다 — 첫 찍기가 0 이 되어 '뒤로'가 꺼진 채 시작한다
let histPos = 0;
function histStamp(): void {
  const st: any = history.state || {};
  if (typeof st.v2i === 'number') { histPos = st.v2i; histSeq = Math.max(histSeq, st.v2i); paintNav(); return; }
  histPos = ++histSeq;
  try { history.replaceState({ ...st, v2i: histPos }, ''); } catch (_) { /* 사파리 rate limit — 판정만 흐려진다 */ }
  paintNav();
}
// 화살표 두 개만 켜고 끈다 — 이동할 때마다 사이드바를 통째로 다시 그리면 트리 스크롤·검색칸 조합이 흔들린다(markFind 와 같은 원칙).
function paintNav(): void { markNav({ back: histPos > 0, forward: histPos < histSeq }); }

/** 이 탭이 보고 있는 프로젝트 — 프로젝트 주소면 그 id, 세션 주소면 그 세션이 붙은 프로젝트. 아니면 -1. */
function tabProject(t: ShellTab): number {
  const k = routeKey(t.route);
  if (k.startsWith('p:')) return Number(k.slice(2)) || 0;
  if (k.startsWith('s:')) { const s = findSess(k.slice(2)); return s && s.projectId ? Number(s.projectId) : -1; }
  return -1;
}

/** 사이드바 프로젝트 줄의 [＋] — 그 프로젝트를 '새 세션 자리'로 연다(#1719 원준 2026-08-20).
 *  그 프로젝트를 이미 보고 있는 탭이 있으면 **그 탭 안에서** 자리만 바꾼다(탭을 늘리지 않는다 — 프로젝트 하나 = 탭 하나).
 *  없으면 ?new=1 주소로 새 탭을 연다(그 쿼리가 '맨 위 세션으로 보내기'를 건너뛰게 한다). */
function newSessionFor(projectId: number): void {
  if (!(projectId > 0)) return;
  const href = '#/p/' + projectId + '?new=1';
  const hit = tabsApi?.tabs.find((t) => tabProject(t) === projectId);
  if (!tabsApi || !hit) { location.hash = href; return; }      // 그 프로젝트를 보는 탭이 없다 — 새 탭에서 연다
  const pv = projViews.get(hit);
  // 셸이 이미 살아 있으면 **그 셸 안에서** 자리만 바꾼다(대화·터미널·배치가 그대로 산다).
  if (pv?.newSession) { tabsApi.activate(hit); pv.newSession(); return; }
  // ⚠ 아직 안 그려진(또는 그리는 중인) 탭이면 셸 핸들이 없다 — 여기서 activate 만 하면 그 탭이 **옛 주소로**
  //  그려져(세션 화면) 방금 연 새 세션 자리를 덮는다(실측 2026-08-20). 그래서 주소를 먼저 새 세션 자리로 바꾼다.
  hit.route = href;
  if (tabsApi.current() === hit) {   // 이미 활성 탭이면 activate 는 아무 일도 하지 않으므로 직접 그린다
    suppressHash++; location.hash = href;
    void renderRoute(hit);
    tabsApi.paint();
  } else tabsApi.activate(hit);
}

// ── 우측(탭마다 한 벌 — tab.aside 에 그린다) ──
//  실험장에선 홈·리브·프로젝트가 우패널을 쓰지 않는다(위 titleFor 주석) — 남은 소비자는 세션 화면뿐이다.
// 세션 우패널 = 짧은 사실 줄 + **타임라인**. 같은 세션이면 위젯을 다시 만들지 않는다(폴링이 상태만 갱신) —
//  탭마다 한 벌이므로 캐시도 탭의 aside 에 붙어 산다(전환해도 쌓인 것이 그대로).
//  #1744 로 같은 자리에 **파일 탐색기**가 한 칸 더 산다(상단바 [파일]). 두 칸은 지워서 갈아 끼우지 않고 hidden 으로
//  바꿔 낀다 — 발자취는 세션 화면이 대화를 읽으며 계속 밀어 넣는 곳이라, 지웠다 새로 만들면 쌓인 것이 사라진다.
//  #1719(2026-08-20) 로 같은 자리에 **손님 화면**(미리보기 iframe)이 한 칸 더 산다 — v2/aside-slot.ts 참고.
//   손님이 떠 있는 동안은 나머지 칸이 물러난다(지우지 않는다 — 닫으면 쌓아 둔 발자취가 그대로 돌아와야 한다).
type AsideHost = HTMLElement & {
  __trail?: { id: string; w: TimelineHandle }; __files?: { id: string; h: FilesHandle }; __filesOn?: boolean;
  __guest?: { key: string; route: string; root: HTMLElement };
  __prevW?: string;                           // 손님을 위해 넓히기 전의 우패널 너비(닫으면 돌려준다)
};
function paintAsidePanes(host: AsideHost): void {
  const g = !!host.__guest;
  if (host.__trail) host.__trail.w.root.hidden = g || !!host.__filesOn;
  if (host.__files) host.__files.h.root.hidden = g || !host.__filesOn;
}
/** 곁칸에 화면을 실으면 기본 폭으로는 못 본다 — 넓힌다. 사람이 끌어 둔 값이 더 넓으면 그대로 두고,
 *  저장값(localStorage)은 건드리지 않는다 — 남의 설정을 말없이 바꾸지 않기 위해서다(닫으면 원래대로). */
function widenAsideForGuest(host: AsideHost): void {
  if (!root) return;
  const cur = parseFloat(getComputedStyle(root).getPropertyValue('--v2-aside-w')) || 316;
  const want = Math.min(720, Math.max(360, window.innerWidth - 560));   // 720 = 우패널 스플리터의 최대폭
  if (want <= cur) return;
  host.__prevW = root.style.getPropertyValue('--v2-aside-w');
  root.style.setProperty('--v2-aside-w', Math.round(want) + 'px');
}
function dropAsideGuest(host: AsideHost): void {
  if (host.__guest) { host.__guest.root.remove(); host.__guest = undefined; }
  if (root && host.__prevW !== undefined) {
    if (host.__prevW) root.style.setProperty('--v2-aside-w', host.__prevW);
    else root.style.removeProperty('--v2-aside-w');
    host.__prevW = undefined;
  }
}
/** aside-slot 의 창구 구현 — 그 탭의 곁칸에 손님을 끼운다.
 *  ⚠ 앱 프레임 탭(noAside)이라고 돌려보내지 않는다 — 미리보기 버튼이 사는 관리탭·클래식 프로젝트 상세가 바로 그
 *   화면이라, 거기서 못 열면 이 기능은 아무 데서도 안 열린다. 손님이 있는 동안만 곁칸을 열어 준다(applyTabChrome). */
function openAsideGuest(g: AsideGuest, forTab?: ShellTab): boolean {
  const tab = forTab || (tabsApi ? tabsApi.active() : null);
  if (!tab) return false;
  const host = tab.aside as AsideHost;
  if (host.__guest && host.__guest.key === g.key) { paintAsidePanes(host); return true; }   // 이미 그 손님 — 리로드하지 않는다
  dropAsideGuest(host);
  const frame = el('iframe', { class: 'v2-guest-frame', src: g.url, title: g.title,
    allow: 'clipboard-read; clipboard-write' }) as HTMLIFrameElement;
  const hbtn = (label: string, title: string, onclick: () => void): HTMLElement =>
    el('button', { class: 'fx-hbtn', type: 'button', title, 'aria-label': title, text: label, onclick });
  const guest = el('section', { class: 'v2-guest' },
    el('div', { class: 'v2-aside-h v2-guest-h' },
      el('b', { text: '미리보기' }),
      el('span', { class: 'v2-guest-t', text: g.title, title: g.title }),
      el('span', { class: 'v2-guest-acts' },
        hbtn('⟳', '새로고침', () => { try { frame.contentWindow!.location.reload(); } catch { frame.src = g.url; } }),
        el('a', { class: 'fx-hbtn', href: g.url, target: '_blank', rel: 'noopener', text: '↗', title: '새 창으로 열기', 'aria-label': '새 창으로 열기' }),
        hbtn('×', '닫기', () => { dropAsideGuest(host); paintAsidePanes(host); if (tabsApi && tabsApi.active() === tab) applyTabChrome(tab); }))),
    frame);
  host.__guest = { key: g.key, route: tab.route, root: guest };
  host.append(guest);
  widenAsideForGuest(host);
  paintAsidePanes(host);
  if (tabsApi && tabsApi.active() === tab) applyTabChrome(tab);   // 곁칸이 없던 화면이면 이 순간 열린다
  if (mobile) mobile.openAside();              // 모바일에선 곁칸이 서랍이다 — 열어 주지 않으면 아무 일도 안 일어난 것처럼 보인다
  return true;
}
function dropAsideFiles(host: AsideHost): void {
  if (host.__files) { host.__files.h.destroy(); host.__files = undefined; }
  host.__filesOn = false;
}
/** 상단바 [파일] — 이 탭의 우패널을 '발자취 ↔ 파일 탐색기'로 갈아 낀다. 켠 상태를 돌려준다(버튼 불). */
function toggleAsideFiles(tab: ShellTab, id: string): boolean {
  const host = tab.aside as AsideHost;
  const s = findSess(id);
  if (!s) { toast('세션 정보를 찾지 못해 파일을 열 수 없어요.', true); return false; }
  if (host.__files && host.__files.id !== s.id) dropAsideFiles(host);
  host.__filesOn = !host.__filesOn;
  if (host.__filesOn && !host.__files) {
    host.__files = { id: s.id, h: createSessionFiles(host, { sessionId: s.id, node: s.node,
      onClose: () => { host.__filesOn = false; paintAsidePanes(host); if (tab.chat) tab.chat.setFilesOn(false); } }) };
  }
  paintAsidePanes(host);
  return !!host.__filesOn;
}
function drawAsideSession(tab: ShellTab, s: Sess | null): TimelineHandle | null {
  const host = tab.aside as AsideHost;
  if (!s) { host.__trail = undefined; dropAsideFiles(host); dropAsideGuest(host); host.replaceChildren(el('p', { class: 'v2-empty', text: '세션 정보를 찾을 수 없어요.' })); return null; }
  const raw = s.raw || {};
  const factsEl = el('div', { class: 'v2-sfacts' },
    el('span', { class: 'v2-dot ' + dotCls(s.stateKey), 'aria-hidden': 'true' }), el('span', { text: s.stateLabel }),
    el('span', { class: 'sep', text: '·' }), s.projectId ? el('a', { href: '#/p/' + s.projectId, text: projName(data, s.projectId) }) : el('span', { text: '프로젝트 없음' }),
    raw.harness ? [el('span', { class: 'sep', text: '·' }), el('span', { class: 'mono', text: String(raw.harness) })] : null,
    s.node ? [el('span', { class: 'sep', text: '·' }), el('span', { text: String(s.node) })] : null,
    !s.owned && (raw.owner_name || raw.owner) ? [el('span', { class: 'sep', text: '·' }), el('span', { text: String(raw.owner_name || raw.owner) })] : null);
  if (host.__trail && host.__trail.id === s.id && host.__trail.w.root.isConnected) { host.__trail.w.setMeta(factsEl); paintAsidePanes(host); return host.__trail.w; }
  dropAsideGuest(host);          // 우패널을 통째로 다시 세운다 — 손님(미리보기)도 함께 물러난다
  host.replaceChildren();
  dropAsideFiles(host);          // 다른 세션으로 옮겼다 — 파일 패널도 그 세션 것으로 새로 연다
  const w = createTimeline(host, { scope: '이 세션', outcomes: true, empty: '아직 남은 것이 없어요 — 세션이 만들고 고친 것이 여기에 쌓입니다.' });
  w.setMeta(factsEl);
  host.__trail = { id: s.id, w };
  paintAsidePanes(host);
  void loadSessionActivities(s.id).then((items) => w.addAll(items));
  return w;
}
// 세션 이름 바꾸기(#1719) — 가운데 화면의 제목이 곧 편집 자리다. 서버(POST terminal/sessions/:id {label})가
//  tmux @box_label 과 복원용 desired-state 를 함께 바꾼다. 소유자만(서버가 403 으로 강제 — 화면도 내 세션에서만 연다).
//  ⚠ 바꾼 뒤 **좌측 사이드바·우패널·탭 제목이 곧바로 그 이름**이어야 한다 — 20초 폴링을 기다리게 하면 "안 바뀌었다"로 읽힌다.
//   그래서 손에 든 목록을 먼저 고쳐 다시 그리고(낙관), 서버 목록은 뒤따라 당겨 사실로 덮는다.
/** 세션 보관(#1719) — 터미널만 내리고 좌표·대화는 DB 에 남긴다(DELETE ?reclaim=1 = restorable).
 *  세션 탭 줄을 없애면서 입구가 [⋯ ▸ 이 세션 보관] 하나로 모였다. 확인창 정의는 session-actions.ts(#1582 규약). */
async function archiveSession(sessionId: string): Promise<void> {
  const s = findSess(sessionId);
  const name = s ? (sessText(s, projName(data, s.projectId)).main || sessionId) : sessionId;
  const working = !!s && (s.stateKey === 'busy' || s.stateKey === 'waiting');
  if (!await confirmSessionArchive({ title: `「${name}」 세션을 보관할까요?`, working })) return;
  try {
    await api('/api/ui/terminal/sessions/' + encodeURIComponent(sessionId) + '?reclaim=1' + (s && s.node ? '&node=' + encodeURIComponent(s.node) : ''), { method: 'DELETE' });
    toast('세션을 보관했어요 — [보관한 세션]에서 되살릴 수 있어요.');
    await loadData();
    drawSide(); tabsApi?.paint();
  } catch (e: any) {
    toast('보관하지 못했어요 — ' + (e && e.message ? e.message : e), true);
  }
}

// ── 방금 고친 이름 고정(#1719 원준) ────────────────────────────────────────────
//  이름을 바꾸는 순간에도 20초 폴링이 **이미 떠 있을 수 있다.** 그 응답에는 옛 이름이 담겨 있어서, 늦게
//  도착하면 방금 고친 이름을 도로 옛것으로 되돌린다(실측: 4초 뒤 옛 이름, 13초 뒤 새 이름으로 복귀).
//  자가 치유되긴 하지만 "내가 바꿨는데 안 바뀌네" 로 읽히는 몇 초다 — 그래서 짧게 고정해 둔다.
//  서버가 정답이라는 원칙은 지킨다: 고정은 **내가 방금 쓴 값**에 대해서만, 30초만.
// 보관(×) 고정 — 방금 지난 세션으로 보낸 것을 **떠 있던 응답이 되살리지 않게**(renamePins 와 같은 규율).
//  30초면 tmux 종료가 목록 API 에 반영되기 충분하고(실측 수 초), 그 안에 서버가 따라잡으면 즉시 해제한다.
const archivePins = new Map<string, number>();
function markArchived(s: Sess): void { s.alive = false; if (s.raw) s.raw.alive = false; }
function pinArchived(id: string): void {
  archivePins.set(id, Date.now() + 30_000);
  const s = data.sessions.find((x) => x.id === id);
  if (s) markArchived(s);                      // 지금 그리는 목록에 곧바로 반영 — 되읽기를 기다리지 않는다
}
function applyArchivePins(sessions: Sess[]): void {
  if (!archivePins.size) return;
  const now = Date.now();
  for (const [id, until] of [...archivePins]) {
    const s = sessions.find((x) => x.id === id);
    if (until < now || !s) { archivePins.delete(id); continue; }
    if (!s.alive) { archivePins.delete(id); continue; }   // 서버가 따라잡았다 — 고정 해제
    markArchived(s);
  }
}

const renamePins = new Map<string, { label: string; until: number }>();
function pinRename(id: string, label: string): void { renamePins.set(id, { label, until: Date.now() + 30_000 }); }
function applyRenamePins(sessions: Sess[]): void {
  if (!renamePins.size) return;
  const now = Date.now();
  for (const [id, p] of [...renamePins]) {
    if (p.until < now) { renamePins.delete(id); continue; }
    const s = sessions.find((x) => x.id === id);
    if (!s) continue;
    if (s.label === p.label) { renamePins.delete(id); continue; }   // 서버가 따라잡았다 — 고정 해제
    s.label = p.label;
    if (s.raw) s.raw.label = p.label;
  }
}

/** 사이드바 인라인 편집(#1719 원준) — 탭이 어디에 있든 이름을 전체에 반영한다.
 *  그 세션을 연 탭이 있으면 그 탭의 대화창·우패널·탭 제목까지, 없으면 목록만. 서버 반영은 renameSession 과 같은 경로. */
async function renameSessionEverywhere(sessionId: string, label: string): Promise<void> {
  // ⚠ 그 세션을 연 탭이 없으면 **활성 탭으로 폴백하지 않는다** — 폴백하면 지금 보고 있는 다른 세션의 상단바·
  //  우패널이 남의 세션 것으로 갈아 끼워진다(겉과 속이 어긋난 화면의 또 다른 입구). 목록만 고치면 된다.
  const tab = tabsApi?.tabs.find((t) => routeKey(t.route) === 's:' + sessionId) || null;
  await renameSession(sessionId, label, tab);
}

/** 프로젝트 이름(#1719 원준 2026-08-24) — 사이드바 줄 더블클릭·문패 제목 클릭이 같은 이 경로로 온다.
 *  이름은 사이드바·탭 제목·문패·세션 상단바(프로젝트 링크)에 흩어져 있으므로 **한곳만 고치고 나머지가 옛 이름**이면
 *  안 고친 것보다 나쁘다 — 그래서 로컬 목록을 먼저 손보고(즉시 반응) 서버에서 다시 읽어 맞춘다. */
async function renameProject(projectId: number, name: string): Promise<void> {
  await api('/api/ui/v6/projects/' + projectId, { method: 'POST', body: JSON.stringify({ name }) });
  const pj0 = data.projects.find((x: any) => Number(x.id) === Number(projectId));
  if (pj0) pj0.name = name;
  drawSide(); tabsApi?.paint();
  void loadData({ projects: true }).then(() => { drawSide(); tabsApi?.paint(); });
}

async function renameSession(sessionId: string, label: string, tab: ShellTab | null): Promise<void> {
  const s = findSess(sessionId);            // 기록(uuid) 링크로 열린 세션도 같은 박스를 가리키게
  const body: Record<string, unknown> = { label };
  if (s && s.node) body.node = s.node;         // 노드 세션은 게이트웨이가 그 노드로 중계한다(라우트가 body.node 를 본다)
  await api('/api/ui/terminal/sessions/' + encodeURIComponent(sessionId), { method: 'POST', body: JSON.stringify(body) });
  pinRename(sessionId, label);                 // 떠 있던 폴링 응답이 옛 이름으로 되덮지 않게(위 renamePins)
  if (s) { s.label = label; if (s.raw) s.raw.label = label; }
  drawSide();
  const cur = findSess(sessionId);
  if (tab && tab.chat && cur && tab.chat.id === cur.id) tab.chat.update({ ...cur, projectName: projName(data, cur.projectId) });
  if (tab) { drawAsideSession(tab, cur || null); tabsApi?.routed(tab); }   // 탭 줄의 제목도 새 이름으로
  tabsApi?.paint();
  void loadData().then(() => { drawSide(); tabsApi?.paint(); });
}

// 세션의 프로젝트 소속(#1749) — 상단바 [프로젝트 연결]/[▾] 이 여는 검색 드롭다운.
function openProjectPicker(anchor: HTMLElement, sessionId: string, tab: ShellTab): void {
  const s = data.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  const rows = projectOrder(data);
  const input = el('input', { class: 'v2-pjpick-in', type: 'search', placeholder: '프로젝트 검색', 'aria-label': '프로젝트 검색' }) as HTMLInputElement;
  const listEl = el('div', { class: 'v2-pjpick-list', role: 'listbox' });
  const note = el('p', { class: 'v2-fine v2-pjpick-note' });
  const panel = el('div', { class: 'dash-pop-panel v2-pjpick' }, input, listEl, note);
  let closePop: (() => void) | null = null;
  let busyPick = false;

  async function pick(pid: number | null): Promise<void> {
    if (busyPick) return;
    busyPick = true;
    note.textContent = pid ? '붙이는 중…' : '떼는 중…';
    try {
      await api('/api/ui/terminal/sessions/' + encodeURIComponent(sessionId) + '/project', { method: 'POST', body: JSON.stringify({ projectId: pid }) });
      toast(pid ? '프로젝트에 붙였어요. 다음 질문부터 프로젝트 맥락이 반영됩니다.' : '프로젝트에서 뗐어요.');
      if (closePop) closePop();
      await loadData(); drawSide(); tabsApi?.paint();
      const cur = data.sessions.find((x) => x.id === sessionId) || null;
      if (tab.chat && cur && tab.chat.id === cur.id) tab.chat.update({ ...cur, projectName: projName(data, cur.projectId) });
      drawAsideSession(tab, cur);
    } catch (e: any) {
      busyPick = false;
      note.textContent = '';
      toast('프로젝트를 바꾸지 못했습니다 — ' + (e && e.message ? e.message : e), true);
    }
  }

  const renderList = (): void => {
    const q = input.value.trim().toLowerCase();
    const hits = rows.filter((r) => !q || r.proj.name.toLowerCase().includes(q) || String(r.proj.id) === q);
    const kids: HTMLElement[] = [];
    if (s.projectId) kids.push(el('button', { class: 'v2-pjpick-row v2-pjpick-none', type: 'button', role: 'option', onclick: () => void pick(null) },
      el('span', { class: 'n', text: '프로젝트에서 떼기' }), el('span', { class: 'm', text: '프로젝트 없음으로' })));
    for (const r of hits.slice(0, 50)) {
      const cur = Number(s.projectId) === Number(r.proj.id);
      kids.push(el('button', { class: 'v2-pjpick-row' + (cur ? ' cur' : ''), type: 'button', role: 'option', 'aria-selected': String(cur), onclick: () => { if (!cur) void pick(r.proj.id); },
        title: r.proj.name + ' · #' + r.proj.id },
        el('span', { class: 'n', text: r.proj.name }),
        el('span', { class: 'm' }, el('span', { class: 'mono', text: '#' + r.proj.id }), r.done ? el('span', { class: 'v2-pjpick-done', text: '완료' }) : null, cur ? el('span', { class: 'v2-pjpick-cur', text: '✓ 지금' }) : null)));
    }
    if (hits.length > 50) kids.push(el('p', { class: 'v2-fine', text: `외 ${hits.length - 50}개 — 더 좁혀 검색하세요.` }));
    if (!kids.length) kids.push(el('p', { class: 'v2-fine', text: '조건에 맞는 프로젝트가 없어요.' }));
    listEl.replaceChildren(...kids);
  };
  input.oninput = renderList;
  input.onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const first = listEl.querySelector('.v2-pjpick-row:not(.v2-pjpick-none):not(.cur)') as HTMLButtonElement | null;
      if (first) first.click();
    }
  };
  renderList();
  closePop = anchoredPopover(anchor, panel);
  window.setTimeout(() => input.focus(), 0);
}

// 미사용 경고 방지 — 라우터 밖에서도 뷰를 갱신하고 싶을 때 쓰는 진입점(툴바 등 후속용).
export function v2Refresh(): void { void loadData().then(() => { drawSide(); if (tabsApi) void renderRoute(tabsApi.active()); }); }

// 사이드바에서 세션 기록을 완전 삭제하면(#1850) 목록·카운트를 서버 기준으로 다시 맞춘다.
//  side.ts 가 여기를 직접 import 하면 순환(main→side→main)이라 이벤트로 받는다.
window.addEventListener('lively:session-purged', () => { v2Refresh(); });
export function v2Toast(msg: string): void { toast(msg); }
// 지금 열려 있는 **세션 탭**의 세션 id 들(#1683 후속2) — '현재 열린 탭 모두 적용' 이 이걸 대상으로 삼는다.
//  세션 탭만 골라낸다(홈·프로젝트·앱 탭은 하네스가 없다). chat 핸들이 곧 그 탭이 붙어 있는 세션이다.
export function v2OpenSessionIds(): string[] {
  if (!tabsApi) return [];
  const out: string[] = [];
  for (const t of tabsApi.tabs) { const id = t.chat?.id; if (id && !out.includes(id)) out.push(id); }
  return out;
}
export function v2View(): HTMLElement | null { return $view(); }
