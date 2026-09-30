// v2/panes.ts — **프로젝트 화면 = 세션 화면**(#1719 원준 2026-08-20). 새 셸의 유일한 작업 화면이다.
//
//  ── 왜 이 모양인가 ──
//  앞선 캔버스(v2/studio.ts, 2026-08-20 폐기 — 지식 canvas-view-retired-1719)는 **빈 판에서 시작해 사람이 위젯을
//  올려야** 채워졌다. 그게 처음 보는 사람에게는 "프로젝트마다 설정할 게 너무 많고, 공간은 텅 비어 있다"로 읽혔다.
//  이 화면의 규칙은 정확히 그 반대다:
//   ① **들어오면 이미 채워져 있다** — 왼쪽은 세션, 오른쪽은 자료·지식. 아무것도 안 해도 일이 보인다.
//   ② **배치는 프로젝트마다가 아니라 한 벌뿐이다**(localStorage 전역) — 한 번 맞춰 두면 모든 프로젝트가 그 모양이다.
//      캔버스는 프로젝트마다 판을 따로 기억한다. 그 차이가 '설정할 게 많다'의 실체였다.
//   ③ 자유배치가 아니라 **도킹 분할**(VS Code·Cursor 문법) — 칸의 경계를 끌어 크기를 바꾸고, 탭을 끌어 칸을 옮긴다.
//      아무 데나 놓을 수 없다는 제약이 곧 '아무것도 안 해도 되는' 기본값을 가능하게 한다.
//
//  ── 구도 ──
//   문패(door) — 프로젝트 이름·요약, 오른쪽에 [정보](이름·상태·본문·할 일을 한곳에 모은 창).
//   가운데 칸(main) — 기본 [세션]. 위는 **지금 보는 세션의 화면 그 자체**, 아래는 세션 서랍.
//   아래 칸(bottom) — 기본 닫힘. 여닫이는 각 칸 [+] 발치의 [아래 칸 열기]와 칸의 ×.
//   곁칸(side) — 기본 [자료][지식] 탭. 경계를 끌어 폭 조절, 탭 줄 끝 손잡이로 접고 오른쪽 위 손잡이로 편다.
//   (문패의 [칸] 버튼은 뺐다 — 원준 2026-08-20 "그냥 지워도 될 것 같다". 배치 복구는 [+] 발치로 옮겼다.)
//
//  ── ★ 프로젝트 화면과 세션 화면은 하나다(원준 2026-08-20) ──
//  종전엔 `#/p/<id>`(프로젝트)와 `#/s/<sid>`(세션)가 서로 다른 화면이었다. 이제 **주소는 늘 세션**이고,
//  프로젝트는 그 세션이 놓인 방일 뿐이다 — `#/p/<id>` 로 들어오면 라우터가 그 프로젝트 맨 위 세션으로 보낸다.
//  서랍에서 세션을 갈아 끼울 때 이 셸은 다시 그리지 않는다(자료·지식·문패가 그대로 산다) — 주소만 바뀐다.
//
//  이 파일이 모르는 것: 각 칸에 들어가는 내용(v2/panes-parts.ts) · 프로젝트 설정 창(v2/proj-settings.ts).
import { anchoredPopover, api, apiUrl, el, personFace, sv, toast, TOKEN_KEY } from '../core.js';
import { deviceStore } from './shell-prefs.js';   // #2460 — 곁칸 배치는 이 창의 사실
import { canOpenInAside, openInAside } from './aside-slot.js';
import { makeSplitter } from './split.js';
import { mountSideSwap, type SideSwapHandle } from './side-swap.js';   // 곁칸이 절반을 넘으면 자리를 바꾼다(#1819)
import { mountSideCard, type SideCardHandle } from './side-card.js';   // #3870: 사이드바가 화면을 다 차지하면 세션이 카드가 된다
import { sideLabels } from '../lib/side-label.js';   // 곁칸의 화면 이름. 자리바꿈으로 왼쪽에 서면 «우측» 이라 부르지 않는다(#4233)
import { MOBILE_MQ } from './mobile.js';   // 좁은 폭(≤900)의 접힌 배치 — side-swap 과 같은 문턱을 읽는다(#4088 후속)
import { PART_DEFS, makePart, openInWebPart, partDef, pnIcon, type Part, type PartCtx, type PartType } from './panes-parts.js';
import { mountDock, type DockApp, type DockHandle } from './pane-dock.js';   // #4443 곁칸 독 — 곁칸에 띄울 앱의 문(macOS 독)
import { appColor } from '../lib/pane-dock.js';                              // #4443 앱마다 한 색 — 탭과 독이 같은 앱으로 읽히게
import { VIEWER_EVT, VIEWER_TO_EVT, ctxMenu, kindOf, rememberViewerPath, rememberedViewerPath, slotStoreKey } from './panes-kit.js';
import { bindCtx, bindCtxSurface } from './ctx-registry.js';   // #3784 곁칸 빈 자리 우클릭
import { type CtxRow } from './ctx-menu.js';
//  ★ 탭 = 부품의 **인스턴스**(#762) — 배치가 드는 것은 '종류'가 아니라 '탭 열쇠'다(lib/tab-key 머리말).
import { isTabKey, nextTabKey, tabBase, tabNum, type TabKey } from '../lib/tab-key.js';
//  #3870 «곁칸 탭 관리» — 닫은 뒤 갈 곳 · 한꺼번에 닫기 · 끌어 옮길 자리 · 폭 · 닫은 탭 다시 열기(규칙은 lib, 끌기 손은 v2/pane-tabdrag).
import { bulkTargets, landingAfterClose, normalizePins, placeKey, planTabs, popClosed, pushClosed, stripRoom, touchRecent, type BulkKind, type ClosedTab } from '../lib/pane-tabs.js';
import { beginTabDrag, cancelTabDrag, consumeDragClick, type DragBar, type TabDragHost } from './pane-tabdrag.js';
import { seedTasksTab } from '../lib/task-pane.js';   // #4084 — 저장된 배치에 «태스크» 탭을 한 번만 들인다
import { hasBrowserSurface } from './browser-surface.js';
import { onViewers, viewersOf } from './presence.js';           // #2116 — 지금 이 세션을 보고 있는 사람
import { openSharePopover, shareSessOf } from './share-session.js';   // #2116 — 문패 [공유]
import { EMBEDDED } from './embed.js';
import { openProjSettings } from './proj-settings.js';
import { createTimeline, type TimelineHandle } from '../timeline.js';
import { loadSessionActivities } from '../timeline-sources.js';
import { loadThinTrail } from '../session-trail.js';
import type { TlOut } from '../timeline.js';
import { type Sess, type V2Data } from './views.js';
import { icon } from './icons.js';
import { doorProjectName } from '../lib/door-name.js';   // #2579 — 문패 이름은 셸 목록이 정본(판이 든 사본은 안 늙는다)
import { editHold } from '../lib/edit-hold.js';   // #3870 — 이름 칸이 열린 동안 문패를 다시 그리지 않는다

export interface PanesOpts {
  data: () => V2Data;
  id: number;
  detail: any;
  onProjectChanged?: () => void;
  /** 라우트가 지정한 '지금 보는 세션'(#/s/<sid>). 없으면 새 세션 자리로 연다. */
  sessionId?: string | null;
  /** 서랍에서 세션을 갈아 끼웠다 — 셸을 다시 그리지 않고 주소만 그 세션 것으로. */
  onSessionPicked?: (sid: string | null) => void;
  /** 세션 화면(대화창·터미널·상단바) 통째를 붙이는 배선 — main.ts 가 준다. */
  mountSession?: (host: HTMLElement, sid: string, o?: { trail?: TimelineHandle | null; openFiles?: () => void; filesLabel?: string }) => { destroy(): void } | null;
  /** 새 세션 자리에서 세션을 방금 만들었다 — 셸이 그 전문을 세션 목록에 즉시 끼워 넣는다(v2/panes-parts spawn). */
  onSessionCreated?: (row: any) => void;
  /** 세션 탭에서 고친 이름 — main.ts 의 renameSession 이 서버·사이드바·셸 탭·세션 머리줄까지 한 번에 갱신한다. */
  onRenameSession?: (id: string, name: string) => Promise<void>;
  /** 문패 연필로 고친 프로젝트 이름 — main.ts 의 renameProject 가 서버·목록·사이드바·탭까지 한 번에 갱신한다(#2579). */
  onRenameProject?: (id: number, name: string) => Promise<void>;
  /** 문패 [세션 옮기기](#3778) — 지금 보는 세션을 다른 프로젝트로 옮기거나 뗀다. 창·실행은 main.ts 가 쥔다. */
  onMoveSession?: (sid: string) => void;
  /** 그 세션을 옮길 수 있나 — 내 세션만(남의 세션은 [⋯] 에도 이 줄이 없다). 없으면 단추를 안 단다. */
  canMoveSession?: (sid: string) => boolean;
  /** 좁은 폭(≤900)에서 곁칸을 **서랍으로 연다/닫는다** — 셸(main.ts)의 모바일 크롬이 맡는다(#4088 후속, 2026-09-23).
   *  파일을 열었는데 서랍이 닫혀 있으면 «눌렀는데 아무 일도 없다» 가 된다 — 곁칸에 무언가를 켤 때마다 부른다. */
  onOpenDrawer?: () => void;
  onCloseDrawer?: () => void;
}
export interface PanesHandle {
  destroy(): void;
  /** 문패만 그 자리에서 다시 그린다 — 이름을 다른 화면에서 바꿨을 때 8초 틱을 기다리지 않게(#2579). */
  repaintDoor(): void;
  /** 이 셸을 '새 세션 자리'로 돌린다 — 사이드바 [＋]와 문패 [＋ 세션]이 같은 곳을 부른다(#1719 원준 2026-08-20). */
  newSession(): void;
  /** 그 종류의 탭을 보이게 한다 — 있으면 켜고(접힌 칸·서랍은 편다), 없으면 곁칸에 만든다. 세션 머리줄 [자료]가 부른다. */
  showPart(type: PartType): void;
}

// ── 배치 ────────────────────────────────────────────────────────────────────
type Zone = 'main' | 'side' | 'bottom';
interface Layout {
  main: TabKey[]; side: TabKey[]; bottom: TabKey[];
  act: { main: TabKey | null; side: TabKey | null; bottom: TabKey | null };
  sideOn: boolean; bottomOn: boolean;
  /** 고정한 탭(#3870 «곁칸 탭 관리») — 아이콘만 남고 줄 맨 앞에 모이며, 한꺼번에 닫기에서 빠진다(크롬·사파리의 탭 고정). */
  pin: TabKey[];
}
// ★ 배치는 **프로젝트마다 한 벌**이고, 그 프로젝트의 세션들이 함께 쓴다(원준 2026-08-20:
//  "띄워져 있는 창의 종류만 같은 프로젝트 안의 다른 세션들이 공유하게 해줘").
//  종전엔 전역 한 벌이었다(위 ② 참조) — '프로젝트마다 설정할 게 많다'를 피하려던 선택이었지만, 정작 필요한 칸은
//  프로젝트마다 달랐다(코드 프로젝트엔 편집기·웹, 글 프로젝트엔 지식·할 일). 세션 사이에서는 여전히 한 벌이라
//  '설정할 게 많다'로 돌아가지는 않는다. 그리고 처음 여는 프로젝트는 **마지막으로 쓰던 배치를 물려받는다** —
//  기본으로 되돌려 버리면 프로젝트를 옮길 때마다 같은 배치를 다시 맞춰야 한다.
const LAYOUT_KEY = deviceStore('lively_panes_layout_v2');   // #1875 — projectId 로 키를 잡으므로 워크스페이스별    // { last: Layout, p: { [projectId]: Layout } }
const LAYOUT_KEY_V1 = 'lively_panes_layout_v1'; // 전역 한 벌이던 옛 판 — 첫 이사 때 'last' 의 씨앗으로만 읽는다
//  #4084 — 곁칸 기본에 «태스크»가 선다(원준 2026-09-20: "연동되어서 자동으로 보이게"). 종전엔 [+] 로 넣어야만 보였다.
const DEF_LAYOUT = (): Layout => ({
  main: ['sessions'], side: ['files', 'tasks', 'knowledge', 'apps'], bottom: ['timeline'],
  act: { main: 'sessions', side: 'files', bottom: 'timeline' },
  sideOn: true, bottomOn: false, pin: [],
});
const ALL = new Set<string>(PART_DEFS.map((d) => d.type));

/** ⚠ 불변식: **세션 부품은 가운데 칸에만 산다.**
 *  세션은 탭을 만들지 않는다(고르기는 사이드바가 한다 — 아래 'tabsOf' 주석). 그래서 곁칸·아래 칸에 들어가면
 *  탭도 ×도 없어 **뺄 방법이 사라지고**, 그 칸에 세션만 남으면 탭 줄 자체가 숨어 ＋ 마저 없어진다
 *  (원준 2026-08-20 신고: "세션이 어디 열린 건지도 모르겠고 닫을 수도 없어 골머리"). 넣는 길을 막고(addBtn·moveTab),
 *  이미 그렇게 저장된 배치는 여기서 되돌린다 — 갇힌 사람은 새로고침 한 번으로 풀린다. */
/** 한꺼번에 닫기·되살리기에서 빼는 탭(main 판: 붙은 앱 탭 #4225). stage 판엔 붙은 앱 탭이 없어 비어 있다 — 탭 줄 코드를
 *  main 과 같은 모양으로 두려고 자리만 남긴다(#3870 곁칸 탭 관리 stage 이식). */
const DERIVED_TABS: ReadonlySet<string> = new Set<string>();
function normalizeLayout(lay: Layout): Layout {
  //  같은 열쇠가 두 칸에 있으면 부품이 두 몸을 갖고 서로를 덮는다 — 먼저 나온 것만 남긴다.
  const seen = new Set<TabKey>();
  for (const z of ['main', 'side', 'bottom'] as const) {
    lay[z] = lay[z].filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
  }
  for (const z of ['side', 'bottom'] as const) {
    //  세션은 종류로 막는다 — 'sessions#2' 같은 것이 저장돼 들어와도 곁칸엔 못 산다(아래 불변식).
    lay[z] = lay[z].filter((k) => tabBase(k) !== 'sessions');
    if (lay.act[z] && !lay[z].includes(lay.act[z]!)) lay.act[z] = lay[z][0] || null;
  }
  if (!lay.main.includes('sessions')) lay.main.unshift('sessions');
  if (!lay.act.main || !lay.main.includes(lay.act.main)) lay.act.main = 'sessions';
  //  고정 탭 — 칸에 실제로 있는 것만, 그리고 줄 맨 앞에 모인다(lib/pane-tabs normalizePins). 세션은 탭이 없어 고정할 것도 없다.
  const live = new Set<TabKey>([...lay.side, ...lay.bottom]);
  lay.pin = (lay.pin || []).filter((k, i, a) => live.has(k) && a.indexOf(k) === i);
  const pins = new Set(lay.pin);
  for (const z of ['side', 'bottom'] as const) lay[z] = normalizePins(lay[z], pins);
  return lay;
}

/** 저장된 한 벌(어떤 판이든) → 쓸 수 있는 Layout. 못 읽으면 null(부른 쪽이 다음 후보로 넘어간다). */
function parseLayout(s: any): Layout | null {
  if (!s || typeof s !== 'object') return null;
  //  ⚠ 저장된 배치엔 종류 이름만 들어 있던 옛 판이 섞여 있다 — 열쇠 모양을 보되 **1번은 종류 이름 그대로**라
  //   옛 배치가 그대로 첫 탭이 된다(lib/tab-key 머리말의 호환 규칙).
  const okKey = (x: any): boolean => isTabKey(x) && ALL.has(tabBase(x));
  const arr = (v: any): TabKey[] => (Array.isArray(v) ? v.filter(okKey) : []);
  const lay: Layout = {
    main: arr(s.main), side: arr(s.side), bottom: arr(s.bottom),
    act: {
      main: okKey(s.act?.main) ? s.act.main : null,
      side: okKey(s.act?.side) ? s.act.side : null,
      bottom: okKey(s.act?.bottom) ? s.act.bottom : null,
    },
    sideOn: s.sideOn !== false, bottomOn: !!s.bottomOn, pin: arr(s.pin),
  };
  // 저장된 배치가 모든 칸에서 비었으면(옛 판·손상) 없는 것으로 — 빈 화면을 보여 주는 것보다 낫다.
  if (!lay.main.length && !lay.side.length && !lay.bottom.length) return null;
  return normalizeLayout(lay);
}
interface LayoutStore { last?: any; p?: Record<string, any>; seeded?: Record<string, number> }
function layoutStore(): LayoutStore {
  try { const s = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); return s && typeof s === 'object' ? s : {}; } catch (_) { return {}; }
}
/** #4084 — 이미 배치를 저장한 사람에게 «태스크» 탭을 **한 번만** 들인다(lib/task-pane seedTasksTab).
 *  기본 배치만 고치면 쓰던 사람에겐 영영 안 보이고(배치는 프로젝트마다 저장되고 새 프로젝트는 마지막 것을 물려받는다),
 *  열 때마다 넣으면 사람이 닫은 탭이 되살아난다 — 그래서 저장소에 표식(seeded.tasks)을 남기고 그 뒤론 손대지 않는다.
 *  배치가 아예 없는 브라우저도 표식은 찍는다: 그 사람은 기본 배치로 이미 받았고, 나중에 닫으면 닫힌 채여야 한다. */
function seedLayoutStore(): void {
  if (EMBEDDED) return;                         // 끼워 넣은 판은 바깥 사람의 배치를 건드리지 않는다(saveLayout 과 같은 이유)
  try {
    const r = seedTasksTab(layoutStore());
    if (r.changed) localStorage.setItem(LAYOUT_KEY, JSON.stringify(r.store));
  } catch (_) { /* 저장소를 못 쓰는 문맥 — 기억만 못 할 뿐 */ }
}
/** 이 프로젝트의 배치 — 없으면 마지막으로 쓰던 것, 그것도 없으면 옛 전역 한 벌, 끝으로 기본. */
function loadLayout(id: number): Layout {
  const st = layoutStore();
  const mine = parseLayout(st.p ? st.p[String(id)] : null);
  if (mine) return mine;
  const last = parseLayout(st.last);
  if (last) return last;
  try { const v1 = parseLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY_V1) || 'null')); if (v1) return v1; } catch (_) { /* noop */ }
  return DEF_LAYOUT();
}

export function mountPanes(host: HTMLElement, opts: PanesOpts): PanesHandle {
  const id = opts.id;
  const loose = id === 0;                       // 프로젝트 없는 세션들의 화면 — 공유 폴더·지식·할 일이 없다
  let detail: any = opts.detail;
  let dead = false;
  //  문패 이름 입력칸(startRenameProject) — 열려 있는 동안 paintDoor 는 건너뛴다(lib/edit-hold, #3870).
  const titleEdit = editHold();
  seedLayoutStore();
  let lay = loadLayout(id);
  // 프로젝트 없는 세션 화면 — 공유 폴더·지식·할 일이 없으니 곁칸에 넣을 것도 없다. 빈 칸을 보여 주느니 접어 둔다.
  //  #4088 후속(2026-09-23): 프로젝트가 없어도 **세션 작업 폴더**는 있다 — 그 파일을 보고 내려받는 자리(sessfiles)와 발자취를 곁칸에 둔다.
  //   데스크톱은 종전대로 접어 둔다(펴는 손잡이·머리줄 [세션 파일]로 편다). 좁은 폭에선 서랍이 이걸 든다.
  if (loose) { lay = { ...lay, side: ['sessfiles', 'timeline'], bottom: [], act: { ...lay.act, side: 'sessfiles', bottom: null }, bottomOn: false, sideOn: false, pin: [] }; }

  // 칸 하나 = 탭 줄 + 본문(만드는 곳은 아래 makePane). **이 두 줄은 함수 맨 앞이어야 한다** —
  //  curSession() 이 `panes` 를 읽는데, actKey() → applySessionAct() 로 이어지는 그 길을 마운트가
  //  **칸을 만들기 전에** 이미 한 번 지난다. 선언이 뒤에 있으면 그 순간 TDZ 로 죽어 세션·프로젝트
  //  화면이 통째로 «화면을 불러오지 못했습니다 — Cannot access 'panes' before initialization» 가 된다
  //  (2026-09-03 dev 실측, 윤상민 신고 — #762 에서 actKey 를 curSession() 으로 바꾼 판에서 났다).
  //  마운트 시점엔 빈 Map 이라 curSession() 은 opts.sessionId 로 떨어진다 — 그때는 그게 지금 보는 세션이다.
  //  frozen — 마우스로 탭을 닫은 뒤 그 줄의 탭 폭을 **얼려 둔다**(크롬·사파리). 줄에서 손을 떼면(pointerleave) 푼다(thaw).
  //   얼려 두는 동안엔 닫힌 탭 오른쪽의 탭들이 그 자리로 미끄러져 들어올 뿐 폭이 다시 나뉘지 않아, 다음 탭의 × 가 **커서 바로 밑**에 온다.
  interface Pane { zone: Zone; root: HTMLElement; bar: HTMLElement; tabs: HTMLElement; tail: HTMLElement; bodyEl: HTMLElement; parts: Map<TabKey, Part>; act: TabKey | null; frozen: Map<TabKey, number> | null; frozenAct: TabKey | null; unfreeze: (() => void) | null }
  const panes = new Map<Zone, Pane>();
  //  #3870 «곁칸 탭 관리» — 탭 줄의 기억(이 화면이 사는 동안만). 칸마다 최근에 본 순서 · 닫은 탭 더미.
  //   ⚠ 여기(함수 맨 앞)에 둔다 — 마운트 중 첫 paintAll 이 이 값들을 읽는다(위 panes 와 같은 TDZ 이유).
  const recent: Record<Zone, TabKey[]> = { main: [], side: [], bottom: [] };
  let closedStack: ClosedTab[][] = [];
  //  #4443 곁칸 독 — paintPane('side') 가 부른다. 세우는 것은 첫 그림 직전(아래 applyView 옆) — 여기엔 자리만(같은 TDZ 이유).
  let dock: DockHandle | null = null;
  function isPinned(k: TabKey): boolean { return lay.pin.includes(k); }
  function pinSet(): Set<TabKey> { return new Set(lay.pin); }
  /** 한꺼번에 닫기에서 빠지는 탭 — 고정 탭 · 붙은 앱(닫기 = 이 세션에서 떼기라 다른 일이 생긴다). */
  function keepInBulk(k: TabKey): boolean { return isPinned(k) || DERIVED_TABS.has(tabBase(k)); }
  function isFileTab(k: TabKey): boolean { return tabBase(k) === 'editor'; }
  //  끌어 옮기기(v2/pane-tabdrag)에 넘기는 손 — 보이는 칸 · 갈 수 있는 칸 · 고정 경계 · 놓은 자리.
  const dragHost: TabDragHost = {
    bars: (): DragBar[] => [...panes.values()]
      .filter((p) => !p.bar.hidden && !p.root.hidden && p.root.getClientRects().length > 0)
      .map((p) => ({ zone: p.zone, bar: p.bar, tabs: p.tabs, pane: p.root })),
    //  곁칸 ↔ 아래 칸만 — 가운데 칸은 세션 전용이다(tabMenu 의 canGo 와 같은 규칙).
    canGo: (key, from, to) => !narrow() && from !== to && to !== 'main' && tabBase(key) !== 'sessions',
    range: (zone, key) => {
      const list = zoneTabs(zone as Zone);
      const pc = list.filter((k) => isPinned(k)).length;
      return isPinned(key) ? [0, Math.max(0, pc - 1)] : [pc, Math.max(pc, list.length - 1)];
    },
    reorder: (zone, key, to) => reorderTab(zone as Zone, key, to),
    moveTo: (key, from, to, at) => { openZone(to as Zone); moveTab(key, from as Zone, to as Zone, at); },
  };

  // ── 좁은 폭(≤900, MOBILE_MQ)의 **접힌 배치**(#4088 후속, 2026-09-23) ─────────────────────
  //  아래 칸은 좁은 폭에서 설 자리가 없다(세션 대화 위에 240px 를 얹으면 대화가 사라진다). 그래서 아래 칸의 탭을
  //  **곁칸(서랍)에 접어 넣어** 그린다 — 타임라인이 폰에서도 닿는다. 저장된 배치(lay)는 건드리지 않는다: 같은
  //  브라우저로 데스크톱 폭에 오면 원래 자리 그대로다. 부품은 한 벌만 — 문턱을 넘으면 반대쪽 칸의 것을 걷는다(onNarrow).
  const narrowMq = window.matchMedia(MOBILE_MQ);
  const narrow = (): boolean => narrowMq.matches;
  let sideActNarrow: TabKey | null = null;     // 서랍에서 켠 탭(아래 칸의 것일 수 있다) — 저장하지 않는다
  /** 그 칸에 **그려질** 탭 — 좁은 폭에선 곁칸이 아래 칸의 탭까지 든다. */
  const zoneTabs = (zone: Zone): TabKey[] => (narrow() ? (zone === 'side' ? [...lay.side, ...lay.bottom] : zone === 'bottom' ? [] : lay[zone]) : lay[zone]);
  /** 열쇠가 실제로 사는 칸(저장된 배치 기준) — 접힌 탭은 곁칸에 그려져도 아래 칸의 것이다. */
  const zoneOf = (key: TabKey): Zone | null => (['main', 'side', 'bottom'] as Zone[]).find((z) => lay[z].includes(key)) || null;
  const dropPartFrom = (pane: Pane, key: TabKey): void => { const p = pane.parts.get(key); if (p) { p.destroy?.(); p.root.remove(); pane.parts.delete(key); } };

  function saveLayout(): void {
    if (loose) return;                          // 자투리 화면의 임시 배치를 정본으로 굳히지 않는다
    if (EMBEDDED) return;                       // 끼워 넣은 판(미리보기 프레임 안) — 바깥 사람의 배치를 덮어쓰지 않는다
    try {
      const st = layoutStore();
      const map = st.p && typeof st.p === 'object' ? st.p : {};
      map[String(id)] = lay;
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...st, last: lay, p: map }));   // ...st — 표식(seeded)을 지우지 않는다
    } catch (_) { /* noop */ }
  }
  saveLayout();   // loadLayout 의 교정(normalizeLayout)을 디스크에도 남긴다 — 갇힌 배치가 한 번 열고 끝나지 않게

  // ── 어느 탭을 보고 있었나는 **세션마다** 기억한다(원준 2026-08-20) ─────────────────
  //  칸에 무엇이 들어 있는지(탭의 종류)는 한 벌로 공유한다 — 프로젝트를 옮겨도 같은 도구 세트가 따라오는 게 맞고,
  //  새 세션도 그 세트를 그대로 물려받는다. 하지만 **그중 무엇을 켜 두고 일하는가**는 세션마다 다르다:
  //  이 세션은 웹을 띄워 두고, 저 세션은 타임라인을 본다. 그걸 매번 다시 고르게 하지 않는다.
  //  기록은 이 브라우저에(칸 배치와 같은 급의 보기 취향), 세션 id 로 — 없으면 공용 기본값(lay.act)으로 떨어진다.
  const ACT_KEY = 'pn_act_by_sess';
  //  ⚠ **`opts.sessionId` 를 쓰면 안 된다**(원준 2026-09-03 신고의 한 갈래) — 서랍에서 세션을 갈아 끼울 때
  //   이 셸은 다시 그리지 않으므로 그 값은 **처음 연 세션에 굳는다**. 그러면 '세션마다 기억한다'가 실은
  //   '이 창을 처음 연 세션에 전부 덮어쓴다'가 된다. 지금 보는 세션은 curSession() 만이 안다.
  const actKey = (): string => String(curSession() || ('p' + id));
  type ActMap = Record<string, Partial<Record<Zone, TabKey>>>;
  function readActs(): ActMap {
    try { const m = JSON.parse(localStorage.getItem(ACT_KEY) || '{}'); return m && typeof m === 'object' ? m as ActMap : {}; }
    catch (_) { return {}; }
  }
  function saveAct(zone: Zone, type: TabKey | null): void {
    if (loose) return;
    try {
      const m = readActs();
      const cur = { ...(m[actKey()] || {}) };
      if (type) cur[zone] = type; else delete cur[zone];
      m[actKey()] = cur;
      // 무한히 쌓이지 않게 — 오래된 것부터 접는다(브라우저 저장은 5MB 남짓이고, 세션은 수백 개가 된다).
      const keys = Object.keys(m);
      if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete m[k];
      localStorage.setItem(ACT_KEY, JSON.stringify(m));
    } catch (_) { /* noop */ }
  }
  /** 이 세션이 마지막으로 보던 탭을 되살린다 — 지금 칸에 실제로 들어 있는 것만(빠진 탭은 무시). */
  function applySessionAct(): void {
    if (loose) return;
    const mine = readActs()[actKey()];
    if (!mine) return;
    for (const z of ['main', 'side', 'bottom'] as Zone[]) {
      const t = mine[z];
      if (t && lay[z].includes(t)) lay.act[z] = t;
    }
  }
  applySessionAct();

  // ── 곁칸의 '보기 상태'는 세션마다 (원준 2026-09-03) ────────────────────────────────
  //  #1819 확정 원문: *"지식과 자료 위젯을 제외하고는 모두 다 각 세션에 딸려있는 거야 … 단 띄워져 있는
  //  창의 종류만 같은 프로젝트 안의 다른 세션들이 공유하게."* 그런데 **크기·접힘은 그 판정표에 없었고**,
  //  실제 구현은 브라우저 전역 한 값이었다(split.ts 의 `panes_side`·`panes_bottom` 키 하나씩). 그래서
  //  한 세션에서 곁칸을 넓히면 **모든 세션·모든 프로젝트가 같이 넓어졌다** — 결정된 적 없는 자리라 고친다.
  //   · 세션마다: 폭·높이 · 접힘(sideOn·bottomOn) · 활성 탭. (좌우 자리는 폭에서 자동으로 따라온다 — side-swap)
  //   · 공유(프로젝트): **탭의 종류**(칸에 무엇이 들어 있나) — 위 확정의 그 한 줄.
  //  ⭐ **물려받지 않는다**(원준 2026-09-03 "완전히 독립으로 해") — 끌어 본 적 없는 세션은 언제나 기본값이다.
  //   '마지막으로 쓰던 값'을 물려주면 방금 스쳐 본 세션의 폭이 다음 세션으로 새어 나가 독립이 깨진다.
  //   #1719 가 걱정한 '설정할 게 많다'는 **기본값이 늘 쓸 만한 자리**(곁칸 340)라는 것으로 답한다.
  const VIEW_KEY = 'pn_view_by_sess';
  type View = { sideW?: number; bottomH?: number; sideOn?: boolean; bottomOn?: boolean; sideLeft?: boolean; card?: boolean };   // sideLeft = 곁칸이 왼쪽(자리바꿈, #762) · card = 세션이 카드(#3870)
  function readViews(): Record<string, View> {
    try { const m = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}'); return m && typeof m === 'object' ? m as Record<string, View> : {}; }
    catch (_) { return {}; }
  }
  function saveView(patch: View): void {
    if (loose || EMBEDDED) return;               // 자투리 화면·끼워 넣은 판의 임시 상태를 정본으로 굳히지 않는다
    try {
      const m = readViews();
      const k = actKey();
      m[k] = { ...(m[k] || {}), ...patch };
      const keys = Object.keys(m);
      if (keys.length > 300) for (const kk of keys.slice(0, keys.length - 300)) delete m[kk];   // act 맵과 같은 상한
      localStorage.setItem(VIEW_KEY, JSON.stringify(m));
    } catch (_) { /* noop */ }
  }

  //  ⭐ 이름만은 **셸 목록**에서 가져온다(#2579 — 판단은 lib/door-name.ts 한 자리에).
  //   `detail` 은 이 탭을 열 때 한 번 읽고 마는데(refreshDetail 은 마운트와 「프로젝트 상세」 변경에서만 돈다),
  //   이름은 다른 화면에서도 바뀐다 — 프로젝트 탭 상세, 사이드바 줄 더블클릭. 그래서 종전엔 이 문패만
  //   **탭을 닫았다 열기 전까지 옛 이름을 들고 있었다**(8초 틱은 옛 값으로 다시 그릴 뿐이다).
  const pj = (): any => {
    if (loose) return { id: 0, name: '프로젝트 없는 세션' };
    const base = (detail && detail.project) || { id, name: '프로젝트 #' + id };
    const name = doorProjectName(opts.data().projects as any, id, String(base.name || ''));
    return name === base.name ? base : { ...base, name };
  };

  // ── 발자취 — **세션마다 한 벌**, 그릇은 셸이 쥔다(원준 2026-08-20) ─────────────────
  //  왜 타임라인 칸이 아니라 여기서 만드나: 재료는 세션 화면(session-chat)이 대화를 읽으며 흘려 준다.
  //  그릇이 그 칸의 것이면 **칸을 닫았다 열 때마다 그 세션이 한 일이 통째로 사라진다** — 그릇은 세션 화면과
  //  같은 수명이어야 한다. 그래서 셸이 쥐고, 타임라인 칸은 이 자리를 자기 몸에 들이기만 한다.
  //  담기는 것 두 갈래: ① 트랜스크립트(내가 올린 지시 + 그 지시로 남은 것) ② 서버에 남은 작업 기록.
  const trailHost = el('div', { class: 'pn-tlhost' });
  let trailSid: string | null = null;
  let trailW: TimelineHandle | null = null;

  // ── 산출물 열기(#1819 안 A) ─────────────────────────────────────────────────
  //  타임라인은 '무엇이 나왔나'만 안다. **어디로 여는지는 여기가 안다** — 세션 폴더·프로젝트 자료·곁칸을 아는 건 셸이다.
  //  ⚠ 도구가 준 경로는 절대·상대가 섞여 온다. 세션 폴더(row.dir) 기준으로 상대화해야 파일 API 가 연다.
  //  ⚠ any 로 두지 않는다 — 종전의 `row.dir`(목록 행에 없는 필드)이 any 라서 조용히 '' 로 컴파일됐다. Sess 면 없는 필드는 빌드가 막는다.
  const sessRow = (sid: string): Sess | null => opts.data().sessions.find((x) => x.id === sid) ?? null;
  /** 주소가 기록 uuid 로 온 경우까지 받아 **박스 행**을 찾는다 — 문패의 얼굴·공유는 박스 id 를 축으로 돈다(#2116). */
  const boxRow = (sid: string | null): any => {
    if (!sid) return null;
    return sessRow(sid) || opts.data().sessions.find((x: any) => x.logId === sid) || null;
  };
  /** 세션 폴더 기준 상대경로. 그 밖(다른 폴더의 절대경로)이면 null — 열 수 없는 것에 버튼을 달지 않기 위해서다. */
  /** 경로 구분자 무관 정규화 — 노드가 윈도우면 `C:\Users\…\project\3966` 처럼 온다(src/terminal/node-upload-coord.ts 와 같은 규칙). */
  const slash = (p: string): string => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const isAbs = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:\//.test(p);
  /** 세션 작업 폴더. ⚠ 목록 행(Sess)은 dir 을 안 옮겨 싣는다(views.ts mergeSessions) — 서버가 준 원본(raw)에만 있다.
   *  종전엔 `row.dir` 을 읽어 **늘 빈 문자열**이었고, 도구가 준 절대경로가 전부 «세션 폴더 밖» 으로 떨어졌다(2026-09-23 실측). */
  const sessDir = (sid: string): string => slash(String(sessRow(sid)?.raw?.dir ?? ''));
  const sessNode = (sid: string): string | null => { const r = sessRow(sid); return r && r.node ? String(r.node) : null; };
  /** 노드가 켜져 있나 — 원본 행의 node 는 {id,name,online} 이다(views.ts mergeSessions 주석). 모르면 켜진 것으로 본다. */
  const nodeOnline = (sid: string): boolean => { const n = sessRow(sid)?.raw?.node; return !(n && typeof n === 'object' && n.online === false); };
  function relOf(sid: string, p: string): string | null {
    const raw = slash(String(p || ''));
    if (!raw) return null;
    if (!isAbs(raw)) return raw.replace(/^\.\//, '');            // 이미 상대경로
    const dir = sessDir(sid);
    if (dir && raw.startsWith(dir + '/')) return raw.slice(dir.length + 1);
    return null;
  }
  /** 세션 작업 폴더가 이 프로젝트의 폴더(또는 그 하위)인가 — 맞으면 프로젝트 폴더 기준 오프셋('' 또는 'sub/a').
   *  ⚠ 이름 추측이 아니라 좌표 규약이다 — 프로젝트 폴더는 어느 노드에서나 `<공유 루트>/project/<id>` 다
   *   (src/terminal/node-upload-coord.ts projectOffsetOfSessionDir 과 **같은 규칙**: 한쪽만 고치면 두 판정이 갈린다). */
  function projectOffsetOfDir(dir: string, pid: number): string | null {
    if (!dir || !(pid > 0)) return null;
    const m = slash(dir).match(/\/(?:project|legacy-project)\/(\d+)(?:\/(.+))?$/);
    if (!m || Number(m[1]) !== pid) return null;
    return m[2] ? m[2] : '';
  }
  //  노드 세션은 `node=` 를 실어야 그 노드의 파일이다(files.ts nodeQ 와 같은 규칙) — 없으면 게이트웨이 fs 를 뒤져 404.
  const fileUrlOf = (sid: string, rel: string): string => {
    const node = sessNode(sid);
    return '/api/ui/terminal/sessions/' + encodeURIComponent(sid) + '/file?path=' + encodeURIComponent(rel) + (node ? '&node=' + encodeURIComponent(node) : '');
  };

  function openOut(sid: string, o: TlOut): void {
    if (o.kind === 'url' && o.url) {
      // 앱이면 곁칸에 띄우고(작업하던 자리를 안 떠난다), 브라우저면 새 탭 — aside-slot 규약 그대로.
      if (canOpenInAside() && openInAside({ key: 'out:' + o.url, title: o.label, url: o.url })) return;
      window.open(o.url, '_blank', 'noopener');
      return;
    }
    const rel = relOf(sid, String(o.path || ''));
    if (!rel) { toast('이 파일은 세션 폴더 밖에 있어 여기서 열 수 없어요.', true); return; }
    //  산출물은 **뷰어 칸**에서 연다 — 자료 칸이 파일을 열 때와 같은 길(openViewerAt). 종전엔 ① window 에 신호를 뿌려
    //   아무 칸도 못 받았고(셸은 자기 곁칸에서만 듣는다) ② 그 밖은 새 탭에 날 주소를 열어 폰에선 로그인 창이 떴다(2026-09-23 실측).
    //  노드 세션은 **노드의 파일을 직접** 읽는다(세션 출처) — 게이트웨이의 프로젝트 사본은 Stop 훅(project-push)이 밀어 올릴 때까지
    //   늦고, 방금 나온 산출물은 꼭 그 사이에 있다. 노드가 꺼져 있으면(online:false) 그 사본이 유일한 길이라 아래 프로젝트 갈래로.
    const node = sessNode(sid);
    if (node && nodeOnline(sid)) { openViewerAt({ path: rel, sid, node }); return; }
    //  프로젝트 세션의 작업 폴더는 곧 프로젝트 폴더(또는 그 하위)다 — 그러면 프로젝트 자료로 연다(고치기·기억·살아 있는 미리보기가 산다).
    const off = id > 0 ? projectOffsetOfDir(sessDir(sid), id) : null;
    if (off !== null) { openViewerAt({ path: off ? off + '/' + rel : rel }); return; }
    //  옛 배치(세션 폴더 안의 ./project 링크) — 그 아래면 역시 프로젝트 자료.
    if (id > 0 && (rel === 'project' || rel.startsWith('project/'))) { openViewerAt({ path: rel.replace(/^project\/?/, '') }); return; }
    //  그 밖(프로젝트 없는 세션·개인 폴더 세션)은 세션 폴더의 파일로 — 뷰어가 세션 파일 API 로 읽는다(보기·내려받기, 고치기는 없다).
    openViewerAt({ path: rel, sid, node: sessNode(sid) });
  }

  /** 그림 산출물의 축소본 — <img src> 는 Authorization 을 못 실으므로 받아서 blob 으로 물린다. */
  async function thumbOf(sid: string, o: TlOut): Promise<string | null> {
    const rel = relOf(sid, String(o.path || ''));
    if (!rel) return null;
    const headers: Record<string, string> = {};
    const tok = localStorage.getItem(TOKEN_KEY); if (tok) headers.Authorization = 'Bearer ' + tok;
    try {
      const res = await fetch(apiUrl(fileUrlOf(sid, rel)), { headers, credentials: 'same-origin' });
      if (!res.ok) return null;
      const b = await res.blob();
      if (b.size > 4_000_000) return null;                                 // 너무 큰 그림은 타일로 쓰지 않는다
      return URL.createObjectURL(b);
    } catch (_) { return null; }
  }
  function trailFor(sid: string | null): TimelineHandle | null {
    if (!sid) { trailSid = null; trailW = null; trailHost.replaceChildren(); return null; }
    if (trailSid === sid && trailW) return trailW;
    trailSid = sid; trailW = null;
    trailHost.replaceChildren();
    const nm = opts.data().sessions.find((x) => x.id === sid);
    const w = createTimeline(trailHost, {
      onOpen: (o) => openOut(sid, o),
      thumb: (o) => thumbOf(sid, o),
      scope: (nm && nm.label) || '이 세션',
      chapters: true,      // 지시 하나 = 한 장, 그 아래 그 지시로 일어난 일
      allSays: true,       // 아직 아무것도 안 남은 지시도 그 자리에 — 내가 뭘 시켰나가 이 화면의 줄기다
      empty: '아직 아무것도 없어요 — 이 세션에 무언가 시키면 여기 쌓입니다.',
    });
    trailW = w;
    // ★ 세션 **전체**를 얇은 판으로 한 번에 붓는다(#1819 원준 2026-08-21).
    //  종전엔 재료가 대화창이 읽은 창(꼬리 1.5MB)뿐이라, 20MB 세션에서 질문 15개 중 14개가 창 밖이었다 —
    //  화면엔 2줄만 떴고 그게 "누락이 엄청 많다"의 실체다. 얇은 판은 같은 내용의 2.24% 라 통째로 받아도 가볍다.
    const row = opts.data().sessions.find((x) => x.id === sid) as any;
    void loadThinTrail(w, { id: sid, node: (row && row.node) || null, logId: (row && row.raw && row.raw.claudeSessionId) || null })
      .then((r) => {
        if (dead || trailW !== w) return;
        // 얇은 판마저 상한을 넘긴 초대형 세션 — 앞이 잘렸다는 사실만 조용히 밝힌다.
        if (r.ok && r.from > 0) w.setNote('이 세션이 아주 커서 뒤쪽만 불러왔어요. 앞부분은 가운데 대화에서 보실 수 있습니다.');
      });
    void loadSessionActivities(sid).then((items) => { if (!dead && trailSid === sid) w.addAll(items); });
    return w;
  }

  // 세션에 딸린 칸들(타임라인·웹·편집기)에게 '보는 세션이 바뀌었다'를 알린다 — 각자 자기 것을 그 세션 것으로 갈아입는다.
  const sessSubs = new Set<(sid: string | null) => void>();
  function curSession(): string | null {
    const sp = panes.get('main')?.parts.get('sessions');
    return sp && sp.currentSession ? sp.currentSession() : (opts.sessionId || null);
  }
  function announceSession(sid: string | null): void {
    for (const fn of [...sessSubs]) { try { fn(sid); } catch (_) { /* 한 칸이 넘어져도 나머지는 간다 */ } }
  }

  const ctx: PartCtx = {
    id,
    //  ⚠ 이 두 값은 **자리표시**다 — 실제 부품은 ctxFor(탭 열쇠)가 덮어쓴 사본을 받는다(아래).
    //   여기 그대로 쓰이는 곳은 없지만, 셸이 부품 없이 쓰는 길(뷰어 라우팅의 memKey 등)이 형을 맞춰야 한다.
    slot: 'sessions',
    slotKey: () => String(curSession() || ('p' + id)),
    data: opts.data,
    detail: () => detail,
    dead: () => dead,
    onChanged: () => { void refreshDetail(); opts.onProjectChanged?.(); },
    openSettings: () => openSettings(),
    sessionId: opts.sessionId || null,
    onSessionPicked: (sid) => { trailFor(sid); announceSession(sid); opts.onSessionPicked?.(sid); applySessionAct(); applyView(); paintAll(); },
    // 세션 화면을 붙일 때 **그 세션의 발자취 그릇**을 함께 넘긴다 — 대화가 읽히는 대로 타임라인 칸이 자란다.
    //  머리줄 [자료](#4088 후속) — 자료 칸(프로젝트 없는 세션은 세션 폴더 칸)을 보이게 한다. 배선만 넘긴다(무엇을 켤지는 셸이 안다).
    mountSession: opts.mountSession ? (host, sid) => opts.mountSession!(host, sid, { trail: trailFor(sid), openFiles: () => showPart(loose ? 'sessfiles' : 'files'), filesLabel: loose ? '세션 파일' : '자료' }) : undefined,
    onSessionCreated: (row) => { opts.onSessionCreated?.(row); paintDoor(); },
    curSession: () => curSession(),
    onSession: (fn) => { sessSubs.add(fn); return () => { sessSubs.delete(fn); }; },
    trailHost: () => trailHost,
    // 세션에 딸린 값(웹 주소·편집 중인 파일)의 저장 열쇠. 세션이 없을 때만 프로젝트로 떨어진다(새 세션 자리).
    memKey: () => curSession() || 'p' + id,
    // 부품끼리의 신호가 도는 **울타리**. 아래 wrap 은 이 객체보다 나중에 만들어지지만, 부르는 것은 늘
    //  부품이 살아 있을 때(그때는 이미 있다)라 게터로 둔다.
    paneRoot: () => wrap,
  };

  // ── 골격 ──
  const door = el('header', { class: 'pn-door' });
  const colMain = el('div', { class: 'pn-col' });
  const body = el('div', { class: 'pn-body' });
  const wrap = el('div', { class: 'pn-wrap' }, door, body) as HTMLElement;
  host.replaceChildren(wrap);
  // #3784 — 문패 우클릭 = 이 프로젝트의 메뉴(사이드바 행과 같은 것). 프로젝트 없는 세션 화면(loose)엔 안 단다.
  if (!loose) { door.dataset.ctx = 'project'; door.dataset.pid = String(id); }
  // #3784 — 곁칸 빈 자리 우클릭 = 이 화면의 배치 조작(＋ 칸에 넣기 · 새 세션 · 배치 되돌리기 · 프로젝트 설정).
  //  탭마다 곁칸이 한 벌씩 살므로(#1819) 표면도 **이 wrap 에 묶는다**(전역 이름이 아니라 닫힌 값).
  bindCtxSurface(wrap, (hit, ev) => {
    const z = (ev.target.closest('.pn-pane') as HTMLElement | null)?.dataset.zone;
    const zone: Zone = z === 'bottom' && !narrow() ? 'bottom' : 'side';   // 가운데 칸(세션)에서 부르면 곁칸에 넣는다(좁은 폭엔 아래 칸이 없다)
    const adds: CtxRow[] = PART_DEFS.filter((d) => d.type !== 'sessions').map((d) => ({
      label: d.name, icon: d.type === 'files' || d.type === 'sessfiles' ? 'folder' : d.type === 'knowledge' ? 'doc' : d.type === 'web' ? 'web' : d.type === 'apps' ? 'apps' : d.type === 'liv' ? 'liv' : d.type === 'timeline' ? 'clock' : d.type === 'archive' ? 'archive' : d.type === 'editor' ? 'eye' : d.type === 'preview' ? 'window' : 'layers',
      hint: d.hint, run: () => { openZone(zone); addPart(zone, d.type); },
    }));
    void hit;
    const rows: CtxRow[] = [
      { label: '칸에 넣기', icon: 'plus', sub: adds },
      { label: '새 세션', icon: 'chat', run: () => newSession() },
      { sep: true, label: '' },
      { label: '기본 배치로 되돌리기', icon: 'columns', run: () => resetLayout() },
    ];
    if (!loose) rows.push({ label: '프로젝트 설정…', icon: 'gear', run: () => openSettings() });
    return rows;
  });

  // 칸 하나 = 탭 줄 + 본문. 부품은 탭을 옮겨도 **살아 있는 채로** 따라간다(대화·스크롤 보존).
  //
  //  ★ 탭 줄(bar)은 두 조각이다 — **미끄러지는 탭 띠(tabs)** + **못 박은 손잡이(tail: 모두 보기·＋·접기)**.
  //   종전엔 셋이 한 띠 안에 있어서, 탭이 칸 폭을 넘기는 순간 ＋·접기까지 함께 밀려 화면 밖으로 사라졌다
  //   (원준 2026-08-20 신고 "탭 공간이 부족해 가려져서 ×로 지우거나 ＋를 하기 힘들다" — 곁칸 기본 폭 339px 에
  //   부품 9개를 넣으면 띠가 884px 이라 ＋는 x=1918, 즉 칸 밖이었다). 손잡이를 띠 밖에 두면 탭이 몇 개가 되든
  //   ＋·접기는 늘 같은 자리에 있고, 가려진 탭은 [모두 보기]로 골라 켜거나 거기서 ×로 뺀다.
  //   (Pane 의 모양과 `panes` 맵은 **함수 맨 앞**에 있다 — 왜 거기여야 하는지는 그 자리 주석.)
  const ros: ResizeObserver[] = [];

  function makePane(zone: Zone): Pane {
    const tabs = el('div', { class: 'pn-tabs', role: 'tablist' });
    const tail = el('div', { class: 'pn-tabtail' });
    const bar = el('div', { class: 'pn-tabbar' }, tabs, tail);
    const bodyEl = el('div', { class: 'pn-pane-body' });
    //  tabindex -1: 좁은 폭의 서랍으로 열릴 때 초점이 안으로 들어온다(mobile.ts setAsideTarget). 탭 순서엔 안 낀다.
    const root = el('section', { class: 'pn-pane', 'data-zone': zone, tabindex: '-1' }, bar, bodyEl);
    const p: Pane = { zone, root, bar, tabs, tail, bodyEl, parts: new Map(), act: null, frozen: null, frozenAct: null, unfreeze: null };
    //  탭 끌어 옮기기(같은 줄 안 · 다른 칸으로)는 v2/pane-tabdrag 가 맡는다 — 탭마다 pointerdown 에서 시작한다(tabEl).
    //  마우스로 닫은 뒤 얼려 둔 폭은 **줄에서 손을 떼면** 푼다(크롬·사파리) — 그때 비로소 남은 탭들이 폭을 다시 나눈다.
    bar.addEventListener('pointerleave', () => thaw(p));
    //  줄의 빈 자리 우클릭 — 닫은 탭 다시 열기 · 파일 탭 모두 닫기가 먼저, 그 아래로 곁칸 빈 자리의 메뉴(칸에 넣기…)가 잇는다.
    //   탭 위의 우클릭은 탭이 스스로 받는다(tabEl — 여기까지 오지 않는다).
    bindCtx(bar, () => stripMenuRows(zone));
    //  빈 자리를 두 번 누르면 [+](크롬·사파리의 «새 탭»). 탭 위의 두 번 누르기는 건드리지 않는다.
    tabs.addEventListener('dblclick', (e: MouseEvent) => {
      if (e.target !== tabs) return;
      (tail.querySelector('.pn-tab-add') as HTMLElement | null)?.click();
    });
    //  키보드(WAI-ARIA 탭 패턴) — ←/→/Home/End 로 탭 사이를 옮겨 다니고(Enter·Space 로 켠다), Delete·Backspace 로 닫는다.
    tabs.addEventListener('keydown', (e: KeyboardEvent) => onTabsKey(p, e));
    // 세로 휠로도 띠가 미끄러지게 — 가로 막대는 디자인상 숨겨 두어서(scrollbar-width: none) 마우스만 쓰는
    //  사람에겐 잡을 데가 없다. 넘칠 때만 가로채고, 그때도 Shift(브라우저 기본 가로 스크롤)는 그대로 둔다.
    tabs.addEventListener('wheel', (e: WheelEvent) => {
      if (e.shiftKey || !e.deltaY) return;
      if (tabs.scrollWidth <= tabs.clientWidth + 1) return;
      e.preventDefault();
      tabs.scrollLeft += e.deltaY;
    }, { passive: false });
    tabs.addEventListener('scroll', () => syncMore(p), { passive: true });
    // 칸 폭이 바뀌면(경계 끌기·창 크기·곁칸 여닫기) '가려진 탭이 있다'를 다시 잰다.
    if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(() => fit(p)); ro.observe(tabs); ros.push(ro); }
    panes.set(zone, p);
    return p;
  }

  /** 띠가 넘치는가 — 넘칠 때만 손잡이 왼쪽 그늘을 켠다(안 넘치면 군더더기다). */
  function syncMore(p: Pane): void {
    p.bar.classList.toggle('has-more', p.tabs.scrollWidth > p.tabs.clientWidth + 1);
  }
  const wrapsOf = (p: Pane): HTMLElement[] => [...p.tabs.children].filter((n) => n.classList.contains('pn-tabwrap')) as HTMLElement[];

  /** 탭 폭을 **재서** 정한다(원준 2026-08-20: "충분히 다 보여줄 수 있는데 접는 일은 절대 없게").
   *
   *  #3870 «곁칸 탭 관리»(2026-09-30) — 종전엔 «전부 펴거나 · 켜진 탭만 남기고 전부 접거나» 둘뿐이라, 곁칸을 620px 로
   *  넓혀도 탭 열 개 중 아홉이 같은 눈 아이콘이었다. 이제 세 단계다(lib/pane-tabs planTabs):
   *   ① 들어가면 이름을 다 편다 → ② 모자라면 **긴 이름부터** 줄인다(짧은 이름은 그대로) → ③ 그래도 모자라면 켜진 탭만 이름을
   *   남기고 아이콘으로 접는다 → 그래도 넘치면 띠가 미끄러지고 ⌄ 목록이 나머지를 말한다.
   *
   *  ⚠ 잴 때는 **가장 너그러운 상태**(이름 다 펴고 ⌄ 숨긴 채)로 되돌려 놓고 잰다. 접힌 상태에서 재면 '한 번 접히면 넓혀도
   *   안 펴지는' 이력(hysteresis)이 생긴다. ②·③ 이면 ⌄ 가 서므로 그 폭을 뺀 줄에 다시 앉힌다. 폭을 읽는 순간 레이아웃이
   *   동기 계산되므로 이 되돌림은 화면에 안 보인다.
   *  ⚠ 얼려 둔 줄(마우스로 닫은 직후)은 재지 않는다 — 다시 나누면 다음 × 가 커서 밑에서 달아난다(thaw 가 푼 뒤에 잰다). */
  function fit(p: Pane): void {
    if (p.frozen) { syncMore(p); return; }
    const wraps = wrapsOf(p);
    p.bar.classList.remove('compact', 'shrunk', 'has-more');
    for (const w of wraps) w.style.width = '';
    restoreTitles(p);
    const full = p.tabs.clientWidth;
    if (!full || !wraps.length) { syncMore(p); return; }       // 접힌 칸·숨은 칸 — 보일 때 ResizeObserver 가 다시 부른다
    const tabsIn = wraps.map((w) => ({ natural: w.getBoundingClientRect().width, active: w.classList.contains('on'), pinned: w.classList.contains('pinned') }));
    //  탭이 나눠 쓸 폭 = 띠 안 폭 − 좌우 안 여백 − 탭 사이 간격(#4443 탭 새 옷 — lib/pane-tabs stripRoom 머리말).
    const cs = getComputedStyle(p.tabs);
    const room = (cw: number): number => stripRoom(cw, parseFloat(cs.paddingLeft) || 0, parseFloat(cs.paddingRight) || 0, parseFloat(cs.columnGap) || 0, wraps.length);
    let plan = planTabs(tabsIn, room(full));
    if (plan.mode !== 'full') {
      p.bar.classList.add('shrunk');                            // ⌄ 가 선다 — 그 폭을 뺀 줄에 다시 앉힌다
      plan = planTabs(tabsIn, room(p.tabs.clientWidth));
    }
    wraps.forEach((w, i) => { w.style.width = plan.widths[i] + 'px'; });
    p.bar.classList.toggle('compact', plan.mode === 'icons');
    fitTitles(p);
    syncMore(p);        // 접고도 남는 넘침만 '더 있다'(그늘)로 말한다
  }
  //  파일 이름은 **가운데**를 줄인다(파인더 문법) — 끝을 줄이면 「붙여넣은 그림 20260930-….png」 여럿이 모두 「붙여넣은 그…」
  //   같은 글자가 된다(실측: 자료의 붙여넣은 그림 탭 다섯이 앞머리가 같다). 끝(날짜·확장자)을 남겨야 서로 가린다.
  //   다른 탭(자료·지식…)은 짧은 이름이라 끝 말줄임(CSS) 그대로 둔다.
  let measureCtx: CanvasRenderingContext2D | null | undefined;
  function midEllipsis(full: string, px: number, font: string): string {
    if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d');
    if (!measureCtx || px <= 0) return full;
    measureCtx.font = font;
    if (measureCtx.measureText(full).width <= px) return full;
    //  확장자(.png · .html)는 통째로 남긴다 — «…tml» 처럼 잘리면 종류도 못 읽는다. 남은 글자는 앞 절반 · 뒤(날짜 쪽) 절반.
    const ext = (/\.[A-Za-z0-9]{1,6}$/.exec(full) || [''])[0];
    const stem = [...full.slice(0, full.length - ext.length)];
    const tailOf = (k: number): string => { const head = Math.ceil(k / 2); return stem.slice(0, head).join('') + '…' + stem.slice(stem.length - (k - head)).join('') + ext; };
    let lo = 1, hi = stem.length - 1, best = '';
    while (lo <= hi) {
      const keep = (lo + hi) >> 1;
      const t = tailOf(keep);
      if (measureCtx.measureText(t).width <= px) { best = t; lo = keep + 1; } else hi = keep - 1;
    }
    //  확장자까지 넣을 자리도 없으면 끝 말줄임(앞 글자라도 남긴다).
    if (!best) { const chars = [...full]; let n = chars.length - 1; while (n > 1 && measureCtx.measureText(chars.slice(0, n).join('') + '…').width > px) n--; best = chars.slice(0, n).join('') + '…'; }
    return best;
  }
  /** 폭을 입힌 뒤 — 넘친 파일 이름을 가운데 말줄임으로 바꾼다(온전한 이름은 툴팁·읽어 주는 이름이 그대로 갖는다). */
  function fitTitles(p: Pane): void {
    for (const w of wrapsOf(p)) {
      if (!isFileTab(w.dataset.tab || '')) continue;
      const t = w.querySelector('.pn-tab-t') as HTMLElement | null;
      if (!t || !t.clientWidth) continue;                         // 접힌 탭(아이콘만)은 이름이 안 보인다
      const full = t.dataset.full || t.textContent || '';
      if (t.scrollWidth <= t.clientWidth + 1 && !t.dataset.full) continue;
      t.dataset.full = full;
      t.textContent = midEllipsis(full, t.clientWidth, getComputedStyle(t).font);
    }
  }
  /** 재기 전에 — 가운데 말줄임을 걷고 온전한 이름으로(온전한 폭을 재야 한다). */
  function restoreTitles(p: Pane): void {
    for (const t of p.tabs.querySelectorAll('.pn-tab-t[data-full]')) {
      const el0 = t as HTMLElement;
      el0.textContent = el0.dataset.full || el0.textContent;
      delete el0.dataset.full;
    }
  }
  /** 마우스로 닫기 직전 — 지금 탭 폭을 얼린다(닫힌 탭 오른쪽의 탭들이 그 자리로 미끄러질 뿐 폭은 그대로). */
  function freeze(p: Pane): void {
    const m = new Map<TabKey, number>();
    for (const w of wrapsOf(p)) { const k = w.dataset.tab; if (k) m.set(k, w.getBoundingClientRect().width); }
    p.frozen = m;
    p.frozenAct = p.act;
    //  안전장치 — 줄 밖에서 포인터가 움직이면 푼다. 닫기가 줄 위가 아닌 데서 일어났으면(pointerleave 가 올 일이 없다) 얼린 폭이
    //   남아 곁칸을 넓혀도 탭이 다시 나뉘지 않았다(실측 — 전후 사진 스크립트). 줄 안의 움직임은 그대로 얼려 둔다.
    if (!p.unfreeze) {
      const onMove = (e: PointerEvent): void => { if (!p.bar.contains(e.target as Node | null)) thaw(p); };
      window.addEventListener('pointermove', onMove, true);
      p.unfreeze = () => window.removeEventListener('pointermove', onMove, true);
    }
  }
  /** 다시 그린 줄에 얼려 둔 폭을 입힌다. 새로 켜진 탭은 이름이 보여야 하므로 얼리지 않는다(그 왼쪽 끝은 어차피 그대로다). */
  function applyFreeze(p: Pane): void {
    const m = p.frozen;
    if (!m) return;
    for (const w of wrapsOf(p)) {
      const k = w.dataset.tab || '';
      const px = m.get(k);
      const newlyOn = w.classList.contains('on') && k !== p.frozenAct;
      w.style.width = px != null && !newlyOn ? px + 'px' : '';
    }
    fitTitles(p);
    syncMore(p);
  }
  /** 모든 칸의 얼림을 푼다(다시 재지는 않는다 — 부르는 쪽이 곧 다시 그린다). 탭이 늘거나 순서·고정이 바뀌면 얼린 폭은 뜻이 없다. */
  function thawAll(): void { for (const p of panes.values()) { p.unfreeze?.(); p.unfreeze = null; p.frozen = null; } }
  function thaw(p: Pane): void {
    p.unfreeze?.(); p.unfreeze = null;
    if (!p.frozen) return;
    p.frozen = null;
    fit(p);
  }

  const mainPane = makePane('main');
  const bottomPane = makePane('bottom');
  const sidePane = makePane('side');

  // 세로 경계(가운데|곁칸) · 가로 경계(가운데|아래 칸) — 폭·높이는 split.ts 가 기억한다.
  // 곁칸 경계 — 상한·부호를 side-swap 이 정한다(#1819). 곁칸이 왼쪽으로 가면 같은 손잡이의 부호가 반대가 된다.
  let swap: SideSwapHandle | null = null;
  //  세션 카드(#3870). 손잡이를 상한 너머로 끈 거리는 split 이 onOver 로 알리고, 놓을 때 카드가 먼저 받는다.
  let card: SideCardHandle | null = null;
  //  카드가 되기 전 사이드바가 어느 쪽에 있었나. 돌아왔을 때 자리가 달라졌으면 자리바꿈 안내를 한 번 띄운다.
  let leftBeforeCard = true;
  //  곁칸이 지금 왼쪽에 서 있나(side-swap 이 격자에 sw-left 를 건다). 칸 이름을 부르는 글은 전부 이것으로 고른다.
  const isLeft = (): boolean => body.classList.contains('sw-left');
  let sideHide: HTMLElement | null = null;   // 곁칸 머리의 접기 단추(paintPane 이 새로 만들 때마다 바꿔 든다)
  const splitX = makeSplitter({
    axis: 'x', key: 'panes_side', cssVar: '--pn-side-w', target: body, def: 340, min: 220,
    max: () => swap?.maxSideW() ?? 620,
    grow: () => (body.classList.contains('sw-left') ? 1 : -1),
    label: sideLabels(false).width,
    onOver: (over) => { card?.onOver(over); if (over > 0) swap?.quiet(); },
    onDrag: (px) => { if (!body.classList.contains('cm-over')) swap?.onDrag(px); },
    //  놓는 순간 **이 세션의 폭**으로 적는다. makeSplitter 는 전역 키에도 그대로 남기는데(그건 '마지막으로 쓰던 값'),
    //  그게 다음에 처음 여는 세션이 물려받을 값이다 — 둘은 싸우지 않는다(읽을 때 세션 값이 먼저다).
    //  카드 전환 구간에서 놓았으면 카드가 받는다. 그때는 자리바꿈을 판정하지 않는다(자리는 카드가 된 뒤 조용히 정한다).
    onEnd: (px) => { if (card?.onRelease()) return; swap?.onEnd(px); saveView({ sideW: Math.round(px) }); },
  });
  const splitY = makeSplitter({ axis: 'y', key: 'panes_bottom', cssVar: '--pn-bottom-h', target: colMain, def: 240, min: 120, max: 560, grow: -1, label: '아래 칸 높이',
    onEnd: (px) => saveView({ bottomH: Math.round(px) }) });

  /** 지금 보는 세션의 폭·높이·접힘을 화면에 입힌다.
   *  ⭐ **물려받지 않는다**(원준 2026-09-03 "완전히 독립으로 해") — 그 세션이 직접 끌어 본 적이 없으면
   *   언제나 기본값(곁칸 340 · 아래 칸 240)이다. 종전 초안은 '마지막으로 쓰던 값'을 물려주려 했는데,
   *   그러면 방금 스쳐 본 세션의 폭이 다음 세션으로 새어 나가 **독립이 아니게 된다**. 기본값은 늘 같은 자리다.
   *  ⚠ 전역 키(`lively_v2_split_panes_*`)는 **읽지도 쓰지도 않는다** — 읽으면 위의 새어 나감이 그대로 돌아온다.
   *   (makeSplitter 가 끌 때마다 그 키에 남기는 것은 막지 않는다. 아무도 안 읽으므로 화면에 영향이 없다.) */
  function applyView(): void {
    const v = loose ? {} : (readViews()[actKey()] || {});
    //  상한으로 깎지 않는다(#3870). 상한은 그릴 때 CSS 가 맞춘다(--pn-side-fit). 여기서 깎으면 화면을 여는 도중의
    //  좁은 격자 폭이 이 세션의 폭을 줄인다. 말이 안 되는 값(옛 결함이 적은 아주 큰 수)만 거른다.
    const w = Math.max(220, Math.min(4000, Number(v.sideW) || 340));
    const h = Math.max(120, Math.min(560, Number(v.bottomH) || 240));
    body.style.setProperty('--pn-side-w', w + 'px');
    colMain.style.setProperty('--pn-bottom-h', h + 'px');
    // 접힘도 그 세션이 정한 적이 있을 때만 따른다 — 없으면 이 프로젝트의 기본 배치 그대로(칸의 '종류'와 같은 축).
    if (typeof v.sideOn === 'boolean') lay.sideOn = v.sideOn;
    if (typeof v.bottomOn === 'boolean') lay.bottomOn = v.bottomOn;
    // ★ 자리(곁칸이 왼쪽인가)도 폭을 입힌 **뒤에** 되살린다(#762) — 폭보다 먼저 판정하면 늘 기본 폭으로 «안 바꿈»이 된다.
    //   적어 둔 자리가 있으면 그대로, 없으면(그 세션에서 자리가 바뀐 적이 없으면) 폭으로 판정한다.
    swap?.restore(w, typeof v.sideLeft === 'boolean' ? v.sideLeft : undefined);
    //  세션 카드도 이 세션의 것이다(#3870). 자리 · 크기는 브라우저 하나에 하나(사람마다), 카드인지 아닌지는 세션마다.
    //  되살린 카드는 «카드가 되기 전 자리» 를 모른다. 앞 세션의 값이 남아 자리바꿈 안내가 엉뚱하게 뜨지 않게 안내 없음으로 둔다.
    leftBeforeCard = true;
    card?.restore(v.card === true);
  }
  colMain.append(mainPane.root, splitY, bottomPane.root);
  // 접힌 곁칸을 다시 펴는 손잡이 — 문패의 [칸] 버튼을 빼면서(원준 2026-08-20) 유일한 복구 통로가 됐다.
  //  격자 칸을 차지하지 않고 오른쪽 위에 떠 있는다(no-side 격자를 안 건드리기 위해).
  const sideReopen = el('button', {
    class: 'pn-side-reopen', type: 'button', title: sideLabels(false).reopenTitle, 'aria-label': sideLabels(false).reopenAria,
    onclick: () => { lay.sideOn = true; saveLayout(); saveView({ sideOn: true }); paintAll(); },
  }, pnIcon('chev', 'pn-i sm')) as HTMLElement;
  body.append(colMain, splitX, sidePane.root, sideReopen);
  swap = mountSideSwap({ body, colMain, sidePane: sidePane.root, sideOn: () => lay.sideOn,
    //  자리가 바뀌면 **이 세션의 것**으로 적는다 — 폭·접힘과 같은 표에(나갔다 들어와도 그 자리, 원준 2026-09-04).
    //  칸 이름도 그 자리로 다시 적는다(양쪽 모두): 경계 손잡이 · 펴기 손잡이 · 접기 단추.
    onChange: (v) => { saveView({ sideLeft: v }); paintSideLabels(v); },
    //  적지 않고 보여 주기만 한 자리(적어 둔 «왼쪽» 이 지금 폭과 안 맞을 때). 글만 맞춘다.
    onPlace: (v) => paintSideLabels(v),
    holdSwap: () => !!card?.active() });
  card = mountSideCard({ body, colMain, sidePane: sidePane.root, sideOn: () => lay.sideOn,
    setSideW: (px, persist) => {
      if (!(px > 0 && px < 100000)) return;        // 격자 폭을 못 잰 값은 받지 않는다
      body.style.setProperty('--pn-side-w', Math.round(px) + 'px');
      if (persist) saveView({ sideW: Math.round(px) });
    },
    //  카드가 되는 순간의 자리를 적어 둔다(바로 뒤 settle 이 자리를 정하기 전이다).
    onChange: (v) => { if (v) leftBeforeCard = !!swap?.swapped(); saveView({ card: v }); },
    //  사이드바가 상한 폭일 때의 자리를 조용히 정한다. 절반을 넘으므로 자리바꿈이 켜져 있으면 세션이 설 자리는 오른쪽이다.
    //  미끄러짐도 안내도 없다(그 순간 사이드바가 세션 열을 덮고 있어 자리가 바뀌는 것이 보이지 않는다).
    settle: (px) => swap?.restore(px),
    onLeft: () => { if (swap?.swapped() && !leftBeforeCard) swap.introOnce(); leftBeforeCard = true; } });

  /** 곁칸을 부르는 글을 지금 선 쪽에 맞춘다. 탭 메뉴는 열 때마다 isLeft() 로 새로 고른다. */
  function paintSideLabels(left: boolean = isLeft()): void {
    const l = sideLabels(left);
    splitX.setAttribute('aria-label', l.width);
    sideReopen.title = l.reopenTitle;
    sideReopen.setAttribute('aria-label', l.reopenAria);
    if (sideHide) { sideHide.title = l.hideTitle; sideHide.setAttribute('aria-label', l.hideAria); }
  }

  // ── 탭 ──
  //  탭이 스스로 단 이름(뷰어=파일명·웹=사이트) — 열쇠마다 하나. 부품이 setTabTitle 로 적는다(#762).
  const tabTitles = new Map<TabKey, string>();
  /** 그 탭 앞으로 만든 ctx — 셸이 쥔 한 벌에 **이 탭의 정체**만 얹는다. */
  function ctxFor(slot: TabKey): PartCtx {
    return {
      ...ctx,
      slot,
      slotKey: () => slotStoreKey(ctx.memKey(), slot),
      setTabTitle: (t: string | null) => {
        const cur = tabTitles.get(slot) || '';
        const next = String(t || '');
        if (cur === next) return;                       // 같은 이름을 다시 적었다 — 띠를 다시 그릴 이유가 없다
        if (next) tabTitles.set(slot, next); else tabTitles.delete(slot);
        //  띠만 다시 그린다 — paintAll 이면 부품이 통째로 다시 서서 보던 자리가 튄다.
        for (const z of ['main', 'side', 'bottom'] as Zone[]) if (zoneTabs(z).includes(slot)) paintTabs(z);
      },
    };
  }
  function ensurePart(pane: Pane, key: TabKey): Part {
    let p = pane.parts.get(key);
    if (!p) { p = makePart(tabBase(key) as PartType, ctxFor(key)); pane.parts.set(key, p); pane.bodyEl.append(p.root); }
    return p;
  }
  function activate(zone: Zone, key: TabKey | null): void {
    //  좁은 폭의 서랍에서 아래 칸의 탭(접혀 들어온 것)을 켰다 — 그 켜짐은 **제 칸**(bottom)의 것으로 적는다(배치를 안 흔든다).
    const real: Zone = narrow() && zone === 'side' && key && lay.bottom.includes(key) ? 'bottom' : zone;
    if (zone !== 'main') sideActNarrow = key;
    lay.act[real] = key;
    if (key) { recent[real] = touchRecent(recent[real], key); if (real !== zone) recent[zone] = touchRecent(recent[zone], key); }
    saveLayout();
    saveAct(real, key);      // 이 세션이 무엇을 보고 있었는지도 함께 — 다시 돌아오면 그 탭이 켜져 있다
    paintPane(zone);
  }
  /** 이 배치 **전체**에 이미 있는 탭 열쇠 — 새 인스턴스 번호는 여기서 겹치지 않게 뽑는다. */
  const allKeys = (): TabKey[] => [...lay.main, ...lay.side, ...lay.bottom];
  /** 그 종류를 **하나 더** 띄운다(#762). 이미 있어도 새 번호로 선다 — multi 가 아닌 부품은 부르는 쪽이 막는다. */
  function addPart(zone: Zone, type: PartType): TabKey {
    const key = nextTabKey(type, allKeys());
    addTab(zone, key);
    return key;
  }
  function addTab(zone: Zone, key: TabKey): void {
    thawAll();   // 탭이 늘면 얼려 둔 폭은 뜻이 없다(크롬)
    const list = lay[zone];
    if (!list.includes(key)) list.push(key);
    lay.act[zone] = key;
    if (zone === 'side') { lay.sideOn = true; saveView({ sideOn: true }); }
    if (zone === 'bottom') { lay.bottomOn = true; saveView({ bottomOn: true }); }
    if (zone !== 'main') { sideActNarrow = key; revealZone(zone); }   // 좁은 폭이면 서랍도 연다 — 만든 탭이 보여야 한다
    saveLayout(); paintAll();
  }
  /** 그 칸을 펴고, 좁은 폭이면 **서랍도 연다** — 신호를 보냈는데 아무 일도 안 일어난 것처럼 보이면 안 된다(#4088 후속). */
  function revealZone(z: Zone): void {
    //  좁은 폭에선 배치(lay)를 건드리지 않는다 — 켜진 탭은 서랍이 보여 주고(접힌 아래 칸도 서랍 안이다), 여기서 bottomOn:true 를
    //   적으면 데스크톱에 돌아갔을 때 닫아 뒀던 아래 칸이 열려 있다(격리 리뷰 지적 — 이 파일 머리의 «배치는 안 건드린다» 약속).
    if (narrow()) { if (z !== 'main') opts.onOpenDrawer?.(); return; }
    openZone(z);
  }
  /** 그 종류의 탭을 **보이게** 한다 — 있으면 켜고(접힌 칸·서랍은 편다), 없으면 곁칸에 만든다. 세션 머리줄 [자료]가 부른다. */
  function showPart(type: PartType): void {
    const found = findTab(type);
    if (!found) { addPart('side', type); return; }
    revealZone(found.zone); activate(found.zone, found.key); paintAll();
  }
  // 미리보기 칸에서 "이 주소 열어" 하고 부르면 웹 칸을 켠다 — 없으면 곁칸에 만들고, 이미 있으면 그 칸이 스스로 받는다.
  //  ⚠ 칸을 새로 만들 때는 부품이 이벤트를 이미 놓친 뒤라, 주소는 openInWebPart 가 저장해 둔 값에서 읽힌다.
  //  ⚠ `document` 가 아니라 **이 곁칸**에서 듣는다 — 문서에 달면 열려 있는 모든 세션 탭에 웹 칸이 한꺼번에
  //   켜진다(실측 2026-08-21: 미리보기 한 번에 두 세션 탭 모두 칸이 생기고 저장값도 둘 다 물들었다).
  const onOpenWeb = (): void => {
    //  이미 웹 칸이 있으면 그 칸을 켠다 — 신호(openInWebPart)는 켜져 있는 칸이 받는다.
    const z = (['side', 'main', 'bottom'] as Zone[]).find((zz) => lay[zz].some((k) => tabBase(k) === 'web'));
    if (!z) { addPart('side', 'web'); return; }
    const key = lay[z].find((k) => tabBase(k) === 'web')!;
    revealZone(z); activate(z, key); paintAll();
  };
  wrap.addEventListener('pn:open-web', onOpenWeb);
  // 자료 칸에서 파일을 누르면 뷰어 탭으로 (#762, 원준 2026-09-04) — 웹 칸과 같은 길이다.
  //  ⚠ 이미 뷰어가 있으면 **또 만들지 않고 그 칸을 켠다**(부품은 칸마다 한 벌이라 두 곳에 생기면 둘이 따로 논다).
  //   접혀 있던 칸이면 펴 준다 — 신호를 보냈는데 아무 일도 안 일어난 것처럼 보이면 안 된다.
  /** 그 칸이 접혀 있으면 편다 — 신호를 보냈는데 아무 일도 안 일어난 것처럼 보이면 안 된다. */
  function openZone(z: Zone): void {
    if (z === 'side' && !lay.sideOn) { lay.sideOn = true; saveView({ sideOn: true }); }
    if (z === 'bottom' && !lay.bottomOn) { lay.bottomOn = true; saveView({ bottomOn: true }); }
  }
  /** 그 종류의 탭이 어디 있나 — 켜져 있는 것을 먼저(사람이 지금 보던 것), 없으면 처음 것. */
  function findTab(type: PartType): { zone: Zone; key: TabKey } | null {
    const zones = ['side', 'main', 'bottom'] as Zone[];
    for (const z of zones) if (lay.act[z] && tabBase(lay.act[z]!) === type) return { zone: z, key: lay.act[z]! };
    for (const z of zones) { const k = lay[z].find((x) => tabBase(x) === type); if (k) return { zone: z, key: k }; }
    return null;
  }
  // 자료 칸에서 파일을 누르면 뷰어 탭으로 (#762, 원준 2026-09-04) — 웹 칸과 같은 길이다.
  //  ★ 뷰어는 여럿 뜰 수 있다(#762, 원준 2026-09-05). **어느 탭에 펼지는 여기서 정한다**: 기본은 보고 있던
  //   뷰어에, `newTab` 이면 새 탭에. 정한 뒤 그 탭의 열쇠로 기억을 적고(새로 만들어지는 뷰어는 신호를 놓치므로)
  //   slot 을 실어 알린다 — 그래야 뷰어 셋이 떠 있어도 엉뚱한 칸이 갈아입지 않는다.
  //  sid 가 실리면 **세션 작업 폴더의 파일**이다(타임라인 산출물 · 세션 폴더 칸) — 뷰어가 세션 파일 API 로 읽는다(#4088 후속).
  type ViewerOpen = { path?: string; newTab?: boolean; sid?: string | null; node?: string | null };
  function openViewerAt(d: ViewerOpen | undefined): void {
    const found = d?.newTab ? null : findTab('editor');
    //  새 탭은 **이미 뷰어가 사는 칸**에 나란히 세운다 — 아래 칸에 뷰어를 두고 쓰는 사람에게 곁칸이 튀어나오면
    //   그건 나란히 보기가 아니라 자리 뺏기다. 뷰어가 하나도 없으면 곁칸.
    const zone: Zone = found ? found.zone : (findTab('editor')?.zone ?? 'side');
    //  ⚠ **열쇠를 먼저 잡고 기억을 적은 뒤에** 탭을 만든다 — 순서가 뒤면 갓 만들어진 뷰어가 빈 목록을
    //   한 번 그렸다가 신호를 받고 다시 그린다(화면이 깜빡인다).
    const key = found ? found.key : nextTabKey('editor', allKeys());
    //  세션 폴더의 파일(sid)은 기억하지 않는다 — 다시 열 때 프로젝트 자료 경로로 읽혀 «못 읽었어요» 가 된다.
    if (d?.path && !d?.sid) rememberViewerPath(ctx.memKey(), key, d.path);
    if (!found) addTab(zone, key);
    revealZone(zone);
    activate(zone, key);
    paintAll();
    //  이미 있던 칸은 이 신호로 갈아입는다(방금 만든 칸은 기억에서 이미 읽었다 — 두 번 열어도 같은 파일이라 무해).
    if (d?.path) wrap.dispatchEvent(new CustomEvent(VIEWER_TO_EVT, { detail: { id, path: d.path, slot: key, sid: d.sid || null, node: d.node || null } }));
  }
  const onOpenViewer = (e: Event): void => openViewerAt((e as CustomEvent).detail as ViewerOpen | undefined);
  wrap.addEventListener(VIEWER_EVT, onOpenViewer);
  // 터미널 iframe 이 미리보기 링크를 넘겨 온다 — 새 탭 대신 웹 칸에 싣는다(원준 2026-08-21).

  //  ⚠ 출처를 반드시 확인한다(남의 프레임이 우리 칸을 마음대로 열지 못하게). 받았으면 답을 보내
  //   터미널이 새 탭 폴백을 접게 한다 — 답이 없으면 저쪽은 잠시 뒤 새 탭을 연다.
  //  ⚠ 창에 오는 message 는 **열려 있는 모든 탭의 곁칸이 함께** 받는다. 보낸 프레임이 내 탭 안의 것인지
  //   가리지 않으면 터미널 링크 하나에 모든 세션 탭의 웹 칸이 같이 갈아입는다(같은 뿌리의 신고).
  const ownsFrame = (w: unknown): boolean => {
    const scope = wrap.closest('.v2-tabpane') as HTMLElement | null;
    if (!scope) return true;                   // 탭이 없는 판(단독 화면) — 곁칸이 하나뿐이라 가릴 것이 없다
    if (!w) return false;
    for (const f of scope.querySelectorAll('iframe')) if ((f as HTMLIFrameElement).contentWindow === w) return true;
    return false;
  };
  const onMsg = (e: MessageEvent): void => {
    if (e.origin !== location.origin) return;
    const d: any = e.data;
    if (!d || d.type !== 'lively:open-in-pane' || typeof d.url !== 'string') return;
    if (!ownsFrame(e.source)) return;           // 남의 탭 터미널이 보낸 것 — 그 탭의 곁칸이 받는다
    // 남의 사이트(claude.ai 아티팩트 등)는 **앱에서만** 칸에 들어간다 — 브라우저 iframe 은 상대가 막는다
    //  (CSP frame-ancestors). 막힐 걸 알면서 칸에 넣으면 빈 화면만 남으므로 그때는 새 탭으로 연다.
    let cross = false;
    try { cross = new URL(d.url).origin !== location.origin; } catch (_) { /* 파싱 실패 — 같은 곳으로 본다 */ }
    if (cross && !hasBrowserSurface()) window.open(d.url, '_blank', 'noopener');
    else { openInWebPart(ctx, d.url); addTab('side', 'web'); }
    // 어느 쪽이든 받았다고 답한다 — 안 그러면 터미널이 잠시 뒤 새 탭을 한 번 더 연다.
    try { (e.source as Window | null)?.postMessage({ type: 'lively:open-in-pane:ok' }, e.origin); } catch (_) { /* 이미 닫힘 */ }
  };
  window.addEventListener('message', onMsg);

  // ── 탭 닫기 · 옮기기 · 고정 · 되살리기 (#3870 «곁칸 탭 관리», 원준 2026-09-30) ──────────────────────
  //  "하나 닫고 하나씩 다 찾으러 다녀야 함 … 사파리나 크롬 탭들 닫거나 열거나 끌거나 드래그하는 거 최대한 참고해서."
  //   · × 는 **모든 탭**에 있다 — 마우스를 올리면 아이콘 자리가 × 로 바뀐다(사파리). 켜지 않은 탭도 켜지 않고 바로 닫힌다.
  //     아이콘 자리라 탭 폭이 달라도 × 는 늘 탭의 왼쪽 끝이고, 닫힌 탭 오른쪽의 탭이 그 자리로 미끄러져 오므로
  //     **다음 탭의 × 가 커서 바로 밑**이다(폭은 줄에서 손을 뗄 때까지 얼려 둔다 — freeze/thaw). 연달아 눌러 닫으면 된다.
  //   · 휠 클릭(가운데 버튼) = 닫기 · Delete = 닫기(키보드).
  //   · 우클릭: 닫기 · 다른 탭 닫기 · 오른쪽 탭 닫기 · 파일 탭 모두 닫기 · 탭 고정 · 다른 칸으로 보내기 · 닫은 탭 다시 열기.
  //   · 켜진 탭을 닫으면 가장 최근에 보던 탭으로(자료에서 파일을 열어 보고 닫으면 자료로 돌아간다 — lib/pane-tabs).
  //   · 끌어서 같은 줄 안 순서를 바꾸고, 다른 칸 줄에 놓으면 그 자리에 끼운다(v2/pane-tabdrag).
  function removeTab(zone: Zone, key: TabKey): void {
    //  (main 판은 여기서 붙은 앱 탭의 «떼기»(#4225)를 먼저 따른다 — stage 판엔 붙은 앱 탭이 없다.)
    if (DERIVED_TABS.has(tabBase(key))) { const z = zoneOf(key) || zone; revealZone(z); activate(z, key); return; }
    recordClosed([key]);
    dropTab(zone, key);
  }
  /** 사람이 탭 하나를 닫았다(× · 휠 클릭 · 메뉴 · Delete). 마우스로 닫았으면 그 줄의 폭을 얼린다 — 다음 탭의 × 가 커서 밑에 온다. */
  function closeTab(zone: Zone, key: TabKey, o?: { pointer?: boolean }): void {
    const pane = panes.get(zone);
    if (o?.pointer && pane && !narrow()) freeze(pane);
    removeTab(zone, key);
  }
  /** 닫은 탭을 [닫은 탭 다시 열기] 더미에 쌓는다 — 한 번에 닫은 것이 한 묶음(크롬: 한꺼번에 닫은 것은 한꺼번에 돌아온다). */
  function recordClosed(keys: TabKey[]): void {
    const batch: ClosedTab[] = [];
    for (const k of keys) {
      if (DERIVED_TABS.has(tabBase(k))) continue;          // 붙은 앱은 세션에서 나온다 — 되살릴 탭이 아니다
      const z = zoneOf(k);
      if (!z) continue;
      const path = isFileTab(k) ? rememberedViewerPath(ctx.memKey(), k) : '';
      batch.push({ key: k, zone: z, at: lay[z].indexOf(k), ...(path ? { path } : {}), ...(isPinned(k) ? { pinned: true } : {}) });
    }
    closedStack = pushClosed(closedStack, batch);
  }
  function dropTab(zone: Zone, key: TabKey, o?: { paint?: boolean }): void {
    const real = zoneOf(key) || zone;            // 접힌 탭(좁은 폭)은 서랍에서 빼도 아래 칸의 것이다
    const list = lay[real];
    const i = list.indexOf(key);
    if (i < 0) return;
    const before = list.slice();
    const drawn = narrow() ? [...lay.side, ...lay.bottom] : null;   // 서랍에 그려진 줄(좁은 폭)
    list.splice(i, 1);
    lay.pin = lay.pin.filter((k) => k !== key);
    //  부품은 **그려진 칸**에 산다 — 접힌 탭은 아래 칸의 열쇠라도 곁칸에 서 있다. 어디 있든 걷는다.
    for (const pane of panes.values()) dropPartFrom(pane, key);
    tabTitles.delete(key);
    //  켜진 탭을 닫았으면 **가장 최근에 보던 탭**으로 — 기록이 없으면 오른쪽 이웃(크롬), 그것도 없으면 왼쪽(lib/pane-tabs).
    //   종전엔 늘 왼쪽 이웃이었다: 자료에서 파일을 열어 보고 닫으면 자료가 아니라 그 앞에 열어 둔 다른 파일이 켜졌다.
    //  ⚠ 여기서 saveAct 를 부르지 않는다 — dropTab 은 세션을 갈아 끼울 때도 불린다(syncSessApps 가 옛 세션의 앱 탭을 걷는다).
    //   그 순간 actKey() 는 이미 **새 세션**이라, 여기서 적으면 새 세션이 기억하던 탭을 덮어쓴다(격리 리뷰 지적). lay.act 는 saveLayout 이 남긴다.
    if (lay.act[real] === key) lay.act[real] = landingAfterClose(before, key, recent[real]);
    if (sideActNarrow === key) sideActNarrow = drawn ? landingAfterClose(drawn, key, recent.side) : null;
    for (const z of ['main', 'side', 'bottom'] as Zone[]) recent[z] = recent[z].filter((k) => k !== key);
    saveLayout();
    if (o?.paint !== false) paintAll();
  }
  function moveTab(key: TabKey, from: Zone, to: Zone, at?: number): void {
    if (from === to) { activate(to, key); return; }
    if (tabBase(key) === 'sessions' && to !== 'main') return;   // 세션은 가운데 칸 밖으로 나가지 않는다(위 불변식)
    //  ⚠ removeTab 이 아니라 dropTab — removeTab 은 «사람이 × 를 눌렀다» 라 [닫은 탭 다시 열기] 더미에 쌓는다. 옮기기는 닫기가 아니다.
    const wasPinned = isPinned(key);
    dropTab(from, key, { paint: false });
    if (wasPinned) lay.pin = [...lay.pin, key];                  // 고정은 따라간다(크롬: 고정 탭을 다른 창으로 옮겨도 고정)
    lay[to] = placeKey(lay[to], key, at ?? lay[to].length, pinSet());
    addTab(to, key);
  }
  /** 같은 줄 안에서 끌어 놓았다 — to 는 놓은 뒤 설 줄의 자리. 끈 탭이 켜진다(크롬). */
  function reorderTab(zone: Zone, key: TabKey, to: number): void {
    const real = zoneOf(key) || zone;
    if (narrow() || !lay[real].includes(key)) return;
    thawAll();
    lay[real] = placeKey(lay[real], key, to, pinSet());
    activate(real, key);
  }
  /** 탭 고정 / 고정 해제 — 고정하면 아이콘만 남고 고정 탭들 맨 뒤로, 풀면 고정 탭 바로 뒤로(크롬). */
  function togglePin(zone: Zone, key: TabKey): void {
    const real = zoneOf(key) || zone;
    lay.pin = isPinned(key) ? lay.pin.filter((k) => k !== key) : [...lay.pin, key];
    lay[real] = normalizePins(lay[real], pinSet());
    thawAll();
    saveLayout(); paintAll();
  }
  /** 한꺼번에 닫기 — 다른 탭 · 오른쪽 탭 · 파일 탭 모두(lib/pane-tabs bulkTargets). 고정 탭 · 붙은 앱은 남는다. */
  function closeMany(zone: Zone, anchor: TabKey | null, kind: BulkKind): void {
    const keys = bulkTargets(zoneTabs(zone), anchor, kind, { keep: keepInBulk, isFile: isFileTab });
    if (!keys.length) return;
    recordClosed(keys);
    for (const k of keys) dropTab(zone, k, { paint: false });
    //  «다른 탭 닫기» · «오른쪽 탭 닫기» 는 우클릭한 탭이 켜진다(크롬).
    if (anchor && (kind === 'others' || kind === 'right') && zoneTabs(zone).includes(anchor)) {
      const real = zoneOf(anchor) || zone;
      lay.act[real] = anchor;
      if (zone !== 'main') sideActNarrow = anchor;
      saveAct(real, anchor);
    }
    thawAll();
    saveLayout(); paintAll();
    if (keys.length > 1) toast(`탭 ${keys.length}개를 닫았어요. 탭 줄을 우클릭해 [닫은 탭 다시 열기]로 되살릴 수 있어요.`);
  }
  /** 뷰어 탭들(어느 칸에 있든) — 되살릴 파일이 이미 떠 있나 볼 때. (main 판은 #4135 의 openViewerAt 이 같은 함수를 쓴다.) */
  function viewerTabs(): Array<{ zone: Zone; key: TabKey }> {
    const out: Array<{ zone: Zone; key: TabKey }> = [];
    for (const z of ['side', 'main', 'bottom'] as Zone[]) for (const k of lay[z]) if (tabBase(k) === 'editor') out.push({ zone: z, key: k });
    return out;
  }
  /** [닫은 탭 다시 열기] — 가장 최근에 닫은 묶음을 닫기 전 자리에 되살린다. 뷰어는 펴 두었던 파일로 돌아온다. */
  function reopenClosed(): void {
    const r = popClosed(closedStack);
    if (!r) return;
    closedStack = r.rest;
    let last: { zone: Zone; key: TabKey } | null = null;
    for (const t of r.batch) {
      const base = tabBase(t.key);
      if (!ALL.has(base)) continue;
      const zone: Zone = t.zone === 'bottom' ? 'bottom' : 'side';
      //  한 벌만 사는 부품(자료·지식…)을 그 사이 [+] 로 다시 넣었으면 그것을 켠다 — 둘을 세우지 않는다.
      const twin = !partDef(base as PartType).multi ? allKeys().find((k) => tabBase(k) === base) : undefined;
      if (twin) { last = { zone: zoneOf(twin) || zone, key: twin }; continue; }
      //  그 파일이 그 사이 다른 뷰어 탭에 이미 떠 있으면 그 탭을 켠다 — 같은 파일을 두 탭에 세우지 않는다(#4135 «파일마다 뷰어 하나»).
      const open = t.path ? viewerTabs().find((v) => rememberedViewerPath(ctx.memKey(), v.key) === t.path) : undefined;
      if (open) { last = open; continue; }
      //  열쇠 번호는 그 사이 다른 탭이 가져갔을 수 있다 — 그러면 새 번호로(뷰어는 파일 경로를 다시 적는다).
      const key = allKeys().includes(t.key) ? nextTabKey(base, allKeys()) : t.key;
      if (t.path) rememberViewerPath(ctx.memKey(), key, t.path);
      if (t.pinned && !isPinned(key)) lay.pin = [...lay.pin, key];   // 고정했던 탭은 고정한 채로 돌아온다
      lay[zone] = placeKey(lay[zone], key, t.at, pinSet());
      last = { zone, key };
    }
    if (!last) return;
    lay.act[last.zone] = last.key;
    saveAct(last.zone, last.key);
    if (last.zone !== 'main') { sideActNarrow = last.key; revealZone(last.zone); }
    thawAll();
    saveLayout(); paintAll();
  }
  /** [닫은 탭 다시 열기] 오른쪽에 적을 말 — 무엇이 돌아오는지(한 개면 이름, 여럿이면 개수). */
  function closedHint(): string {
    const b = closedStack[closedStack.length - 1];
    if (!b) return '';
    if (b.length > 1) return `${b.length}개`;
    const t = b[0];
    return t.path ? (t.path.split('/').pop() || '') : partDef(tabBase(t.key) as PartType).name;
  }

  /** 탭에 걸 이름 — 부품이 단 것(뷰어=파일명·웹=사이트) > 「종류 n」(둘 이상 떠 있을 때) > 종류 이름. */
  function tabName(key: TabKey): string {
    const t = tabTitles.get(key);
    if (t) return t;
    //  뷰어는 켜야 부품이 서고 그때 이름을 단다 — 아직 안 켠 뷰어 탭(새로고침 직후 · 다시 연 탭)은 펴 둔 파일 이름으로 부른다.
    //   (종전엔 «뷰어 5» 로 섰다 — 무엇인지 모르는 탭은 닫을지 말지도 고를 수 없다.)
    if (tabBase(key) === 'editor') { const p = rememberedViewerPath(ctx.memKey(), key); if (p) return p.split('/').pop() || p; }
    const d = partDef(tabBase(key) as PartType);
    const n = tabNum(key);
    return n >= 2 ? `${d.name} ${n}` : d.name;
  }
  /** 탭 아이콘 — 뷰어는 **파일 종류**로 그린다(그림 · 문서 · 코드 · 시안 · 영상). 종전엔 뷰어가 전부 같은 눈 아이콘이라
   *  접힌 줄에서 서로를 가릴 길이 아이콘 어깨의 작은 번호뿐이었다(그 번호가 아이콘을 한쪽으로 치우쳐 보이게 했다 — 원준 신고). */
  function tabIcon(key: TabKey): string {
    const d = partDef(tabBase(key) as PartType);
    if (tabBase(key) !== 'editor') return d.icon;
    const nm = tabTitles.get(key) || rememberedViewerPath(ctx.memKey(), key);
    if (!nm) return d.icon;
    const k = kindOf(nm);
    return k.kind === 'img' ? 'img' : k.kind === 'video' || k.kind === 'audio' ? 'play' : k.kind === 'page' ? 'window' : k.type === '코드' ? 'code' : 'doc';
  }
  /** 탭 툴팁 — 이름이 줄어 있거나 아이콘만 남았을 때 여기서 온전한 이름을 읽는다. */
  function tabTip(key: TabKey): string {
    const d = partDef(tabBase(key) as PartType);
    const nm = tabName(key);
    const head = nm === d.name || tabNum(key) > 1 && !tabTitles.get(key) ? `${nm} — ${d.hint}` : nm;
    return isPinned(key) ? `${head}\n(고정한 탭 — 우클릭해 고정을 풀 수 있어요)` : head;
  }
  function tabEl(zone: Zone, key: TabKey, on: boolean): HTMLElement {
    const nm = tabName(key);
    const pinned = isPinned(key);
    const ic = tabIcon(key);
    const b = el('button', {
      class: 'pn-tab', type: 'button', role: 'tab', tabindex: on ? '0' : '-1',
      'aria-selected': String(on), title: tabTip(key), 'aria-label': nm,
      //  끌기로 끝난 누름의 click 은 켜기가 아니다(놓을 때 셸이 이미 켰다 — reorderTab).
      onclick: () => { if (consumeDragClick()) return; activate(zone, key); },
      //  우클릭 = 이 탭을 어떻게 할까(#762 · #3870) — 닫기 · 한꺼번에 닫기 · 고정 · 다른 칸으로 보내기 · 다시 열기.
      oncontextmenu: (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); tabMenu(e, zone, key); },
    }, el('span', { class: 'pn-tab-lead', 'data-ic': ic }, pnIcon(ic, 'pn-i sm')), el('span', { class: 'pn-tab-t', text: nm })) as HTMLElement;
    const detachX = DERIVED_TABS.has(tabBase(key));   // #4225 붙은 앱 탭의 × 는 «닫기» 가 아니라 «이 세션에서 떼기»
    //  × 는 아이콘 자리에 겹쳐 선다(CSS: 마우스를 올리면 아이콘이 × 로 바뀐다). 고정 탭은 × 가 없다(크롬) — 메뉴로 닫는다.
    //  tabindex -1: 키보드는 탭 위에서 Delete 로 닫는다(× 마다 초점이 서면 탭 사이를 옮겨 다니기가 두 배로 길어진다).
    //  붙은 앱 탭은 **켜졌을 때만** × — 떼기는 그 앱 화면이 서 있어야 어느 앱인지 안다(removeTab 머리의 같은 사정).
    const x = pinned || (detachX && !on) ? null : el('button', {
      class: 'pn-tab-x', type: 'button', tabindex: '-1',
      title: detachX ? `${nm} 을(를) 이 세션에서 뗍니다 — 앱의 데이터는 그대로 남아요` : `${nm} 탭 닫기`,
      'aria-label': detachX ? `${nm} 떼기` : `${nm} 닫기`,
      //  폭은 **마우스로** 닫을 때만 얼린다 — 손가락은 pointerleave 가 click 보다 먼저 와서 풀 기회가 없다(격리 리뷰 지적).
      onclick: (e: MouseEvent) => { e.stopPropagation(); const pt = (e as PointerEvent).pointerType; closeTab(zone, key, { pointer: pt ? pt === 'mouse' : e.detail > 0 && matchMedia('(pointer: fine)').matches }); },   // 사파리 click 엔 pointerType 이 없다
    }, pnIcon('x', 'pn-i xs'));
    //  #4443 — 앱마다 한 색(--ac): 아이콘 칩의 선 · 켜진 탭의 옅은 물. 독 아이콘과 같은 토큰이라 같은 앱으로 읽힌다(lib/pane-dock appColor).
    //   단추에도 건다 — 끌 때 뜨는 조각(pane-tabdrag 의 고스트)은 단추만 복제한다.
    const ac = `--ac: var(--gi-c-${appColor(tabBase(key))})`;
    b.setAttribute('style', ac);
    const w = el('span', { class: 'pn-tabwrap' + (on ? ' on' : '') + (pinned ? ' pinned' : ''), 'data-tab': key, style: ac, role: 'presentation' }, b, x) as HTMLElement;
    //  휠 클릭 = 닫기(크롬·사파리). 누를 때 브라우저의 자동 스크롤이 뜨지 않게 mousedown 도 막는다.
    w.addEventListener('mousedown', (e: MouseEvent) => { if (e.button === 1) e.preventDefault(); });
    w.addEventListener('auxclick', (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault(); e.stopPropagation();
      if (!pinned && !(detachX && !on)) closeTab(zone, key, { pointer: true });
    });
    //  끌어 옮기기 — 같은 줄 안에서 순서 · 다른 칸으로(v2/pane-tabdrag). 좁은 폭(서랍)은 칸이 하나뿐이라 끌지 않는다.
    w.addEventListener('pointerdown', (e: PointerEvent) => { if (!narrow()) beginTabDrag(dragHost, zone, key, w, e); });
    return w;
  }

  /** 지금 띠에 서 있는 탭들 — [열쇠, 겉싸개]. paintTabs 가 이름만 갈아 끼울 때 쓴다. */
  function tabNodes(pane: Pane): Array<[TabKey, HTMLElement]> {
    return [...pane.tabs.querySelectorAll('.pn-tabwrap')]
      .map((n) => [String((n as HTMLElement).dataset.tab || ''), n as HTMLElement] as [TabKey, HTMLElement])
      .filter(([k]) => !!k);
  }

  /** 행 묶음 사이에만 구분선 — 빈 묶음이 두 줄 구분선을 만들지 않게. */
  const withSeps = (groups: CtxRow[][]): CtxRow[] => groups.filter((g) => g.length).flatMap((g, i) => (i ? [{ sep: true, label: '' }, ...g] : g));

  /** 탭 우클릭 메뉴(크롬·사파리 순서) — 닫기들 · 고정·하나 더·보내기 · 닫은 탭 다시 열기. */
  function tabMenu(e: MouseEvent, zone: Zone, key: TabKey): void {
    const type = tabBase(key) as PartType;
    const d = partDef(type);
    const list = zoneTabs(zone);
    const derived = DERIVED_TABS.has(type);
    const pinned = isPinned(key);
    const o = { keep: keepInBulk, isFile: isFileTab };
    const others = bulkTargets(list, key, 'others', o).length;
    const right = bulkTargets(list, key, 'right', o).length;
    const files = bulkTargets(list, null, 'files', o).length;
    const toZone: Record<Zone, string> = { main: '가운데 칸으로', side: sideLabels(isLeft()).sendTo, bottom: '아래 칸으로' };   // 받침마다 조사가 다르다
    const canGo = (z: Zone): boolean => !narrow() && z !== zone && !(type === 'sessions' && z !== 'main') && z !== 'main';   // 좁은 폭엔 칸이 하나뿐
    ctxMenu(e.clientX, e.clientY, withSeps([
      [
        { label: derived ? '이 세션에서 떼기' : '닫기', icon: 'x', hint: derived ? '' : '휠 클릭', run: () => closeTab(zone, key) },
        { label: '다른 탭 닫기', off: !others, hint: others ? `${others}개` : '', run: () => closeMany(zone, key, 'others') },
        { label: '오른쪽 탭 닫기', off: !right, hint: right ? `${right}개` : '', run: () => closeMany(zone, key, 'right') },
        ...(files ? [{ label: '파일 탭 모두 닫기', hint: `${files}개`, run: () => closeMany(zone, null, 'files') }] : []),
      ],
      [
        ...(derived ? [] : [{ label: pinned ? '고정 해제' : '탭 고정', icon: 'pin', hint: pinned ? '' : '아이콘만 남기고 맨 앞에', run: () => togglePin(zone, key) }]),
        ...(d.multi ? [{ label: `${d.name} 하나 더`, icon: 'plus', run: () => { addPart(zone, type); } }] : []),
        ...(['side', 'bottom'] as Zone[]).filter(canGo).map((z) => ({
          label: `${toZone[z]} 보내기`, icon: 'moveto', run: () => { openZone(z); moveTab(key, zone, z); },
        })),
      ],
      [{ label: '닫은 탭 다시 열기', icon: 'undo', off: !closedStack.length, hint: closedHint(), run: () => reopenClosed() }],
    ]), { title: tabName(key) });
  }

  /** [모두 보기] — 탭 이름이 줄었거나 접혔거나 넘쳤을 때 서는 목록(CSS: .pn-tabbar.shrunk · .compact · .has-more).
   *  #3870 — × 를 눌러도 목록이 **열린 채** 그 줄만 사라진다(종전엔 × 한 번마다 목록이 닫혀 매번 다시 열어야 했다).
   *  발치에 [파일 탭 n개 모두 닫기] · [닫은 탭 다시 열기]. */
  function moreBtn(zone: Zone): HTMLElement {
    const b = el('button', { class: 'pn-tab-more', type: 'button', title: '이 칸에 열린 탭을 모두 봅니다', 'aria-label': '탭 모두 보기' }, pnIcon('chev', 'pn-i sm')) as HTMLElement;
    b.onclick = () => {
      const listEl = el('div', { class: 'pn-pop-list' }) as HTMLElement;
      const foot = el('div', { class: 'pn-pop-foot' }) as HTMLElement;
      let close: () => void = () => { /* 아래에서 채운다 */ };
      const fill = (): void => {
        const list = zoneTabs(zone).filter((t) => tabBase(t) !== 'sessions');
        const act = panes.get(zone)?.act ?? lay.act[zone];
        listEl.replaceChildren(...list.map((t) => {
          const d = partDef(tabBase(t) as PartType);
          const nm = tabName(t);
          const pinned = isPinned(t);
          return el('div', { class: 'pn-pop-line' + (act === t ? ' on' : '') },
            el('button', { class: 'pn-pop-row', type: 'button', title: nm, onclick: () => { close(); activate(zone, t); } },
              pnIcon(tabIcon(t), 'pn-i sm'),
              el('span', { class: 'n' }, el('b', { text: nm }), el('span', { class: 'pn-fine', text: pinned ? '고정한 탭' : nm === d.name ? d.hint : d.name }))),
            pinned ? null : el('button', {
              class: 'pn-pop-x', type: 'button', title: `${nm} 탭 닫기`, 'aria-label': `${nm} 닫기`,
              onclick: () => { removeTab(zone, t); if (zoneTabs(zone).length) fill(); else close(); },
            }, pnIcon('x', 'pn-i xs')));
        }));
        const files = bulkTargets(zoneTabs(zone), null, 'files', { keep: keepInBulk, isFile: isFileTab }).length;
        foot.replaceChildren(...[
          files ? el('button', { class: 'btn-text', type: 'button', text: `파일 탭 ${files}개 모두 닫기`, onclick: () => { closeMany(zone, null, 'files'); fill(); } }) : null,
          closedStack.length ? el('button', { class: 'btn-text', type: 'button', text: '닫은 탭 다시 열기', onclick: () => { reopenClosed(); fill(); } }) : null,
        ].filter(Boolean) as HTMLElement[]);
        foot.hidden = !foot.childElementCount;
      };
      fill();
      close = anchoredPopover(b, el('div', { class: 'pn-pop' },
        el('p', { class: 'pn-pop-h', text: '이 칸에 열린 탭이에요. 누르면 그 탭이 켜지고, × 를 누르면 목록은 그대로 둔 채 닫혀요.' }),
        listEl, foot));
    };
    return b;
  }

  /** 탭 줄 빈 자리의 메뉴 행. */
  function stripMenuRows(zone: Zone): CtxRow[] {
    const files = bulkTargets(zoneTabs(zone), null, 'files', { keep: keepInBulk, isFile: isFileTab }).length;
    return [
      { label: '닫은 탭 다시 열기', icon: 'undo', off: !closedStack.length, hint: closedHint(), run: () => reopenClosed() },
      ...(files ? [{ label: '파일 탭 모두 닫기', hint: `${files}개`, run: () => closeMany(zone, null, 'files') }] : []),
    ];
  }

  /** 탭 줄에서의 키보드(WAI-ARIA 탭 패턴) — ←/→/Home/End 로 초점을 옮기고(Enter·Space 가 켠다), Delete·Backspace 로 닫는다. */
  function onTabsKey(p: Pane, e: KeyboardEvent): void {
    const btn = (e.target as HTMLElement | null)?.closest('.pn-tab') as HTMLElement | null;
    if (!btn || !p.tabs.contains(btn)) return;
    const btns = wrapsOf(p).map((w) => w.querySelector('.pn-tab') as HTMLElement).filter(Boolean);
    const i = btns.indexOf(btn);
    if (i < 0) return;
    const key = (btn.parentElement as HTMLElement | null)?.dataset.tab || '';
    if ((e.key === 'Delete' || e.key === 'Backspace') && key) {
      e.preventDefault();
      if (isPinned(key)) return;                  // 고정 탭은 메뉴로 닫는다(실수로 지우지 않게)
      closeTab(p.zone, key);
      (p.tabs.querySelector('.pn-tabwrap.on .pn-tab') as HTMLElement | null)?.focus();
      return;
    }
    const j = e.key === 'ArrowRight' ? (i + 1) % btns.length : e.key === 'ArrowLeft' ? (i - 1 + btns.length) % btns.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    for (const x of btns) x.tabIndex = -1;
    btns[j].tabIndex = 0;
    btns[j].focus();
    btns[j].scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  function addBtn(zone: Zone): HTMLElement {
    const b = el('button', { class: 'pn-tab-add', type: 'button', title: '이 칸에 내용을 더합니다', 'aria-label': '내용 더하기' }, pnIcon('plus', 'pn-i sm')) as HTMLElement;
    b.onclick = () => {
      //  ★ 이미 있어도 **multi 부품이면 하나 더** 낼 수 있다(#762) — 셸은 그 선언만 본다(부품 이름이 여기 안 박힌다).
      const has = (t: PartType): boolean => zoneTabs(zone).some((k) => tabBase(k) === t);
      const rest = PART_DEFS.filter((d) => (d.multi || !has(d.type))
        && !(d.type === 'sessions' && zone !== 'main')     // 세션은 가운데 칸의 것 — 여기 넣으면 뺄 수가 없다(위 불변식)
        && !(loose && (d.type === 'files' || d.type === 'knowledge' || d.type === 'tasks' || d.type === 'liv')));   // 뷰어는 세션 폴더 파일도 열므로 남긴다
      const close = anchoredPopover(b, el('div', { class: 'pn-pop' },
        el('p', { class: 'pn-pop-h', text: '이 칸에 넣을 것을 고르세요.' }),
        rest.length ? el('div', { class: 'pn-pop-list' }, ...rest.map((d) =>
          el('button', { class: 'pn-pop-row', type: 'button', onclick: () => { close(); addPart(zone, d.type); } },
            pnIcon(d.icon, 'pn-i sm'),
            el('span', { class: 'n' },
              el('b', { text: has(d.type) ? `${d.name} 하나 더` : d.name }),
              el('span', { class: 'pn-fine', text: has(d.type) ? '같은 것을 하나 더 띄워 나란히 봅니다.' : d.hint })))))
          : el('p', { class: 'pn-fine', text: '넣을 수 있는 것을 이미 다 넣었어요.' }),
        // 문패의 [칸] 버튼을 빼면서(원준 2026-08-20) 배치 복구가 갈 곳이 없어졌다 — '화면에 무엇을 둘까'를
        //  고르는 자리는 여기뿐이라, 닫힌 아래 칸의 유일한 입구와 되돌리기를 이 발치에 둔다.
        el('div', { class: 'pn-pop-foot' },
          loose || lay.bottomOn || narrow() ? null : el('button', { class: 'btn-text', type: 'button', text: '아래 칸 열기', onclick: () => { close(); lay.bottomOn = true; saveLayout(); saveView({ bottomOn: true }); paintAll(); } }),
          el('button', { class: 'btn-text', type: 'button', text: '기본 배치로 되돌리기', onclick: () => { close(); resetLayout(); } }))));
    };
    return b;
  }


  // ── 세션 탭 줄은 없앴다(원준 2026-08-20) ──────────────────────────────────────
  //  "한 프로젝트에서 여러 세션 고르는 건 그냥 사이드바에서 하면 될 것 같아" — 같은 목록이 사이드바(프로젝트 폴더 안)와
  //  이 줄에 두 벌 있었고, 세션이 40개씩 쌓이면 그 줄이 화면 폭을 다 먹었다(실측: 이 프로젝트 41개).
  //  그래서 **고르기는 사이드바 한 곳**으로 모으고, 이 칸은 '지금 보는 세션 하나'만 그린다.
  //  함께 사라진 것: 세션 탭의 ×(보관·치우기)·끌어 순서 바꾸기·두 번 눌러 이름 고치기 — 줄이 없으니 붙을 자리가 없다.
  //   · 보관은 세션 머리줄 [⋯ ▸ 이 세션 보관]으로 옮겼다.
  //   · 이름 고치기는 머리줄 제목(두 번 누르기·연필)과 최상단 탭(두 번 누르기)에 그대로 있다.
  //   · '탭에서 치우기'는 개념 자체가 없어졌다(치울 줄이 없다).

  function paintPane(zone: Zone): void {
    const pane = panes.get(zone)!;
    const n = narrow();
    //  끄는 중에 줄을 다시 그리면 잡고 있던 탭이 사라진다 — 끌기를 먼저 없던 일로(놓을 때 셸이 다시 그리는 것은 끌기가 끝난 뒤다).
    cancelTabDrag();
    //  좁은 폭의 아래 칸 — 탭은 곁칸(서랍)에 접혀 들어갔다. 줄도 부품도 세우지 않는다(배치는 그대로 둔다).
    if (n && zone === 'bottom') {
      pane.act = null; pane.tabs.replaceChildren(); pane.tail.replaceChildren(); pane.bar.hidden = true;
      for (const p of pane.parts.values()) p.root.hidden = true;
      return;
    }
    const list = zoneTabs(zone);
    let act = lay.act[zone];
    //  좁은 폭의 곁칸 — 서랍에서 켠 것 > 곁칸의 켜짐 > 아래 칸의 켜짐. 접힌 열쇠는 lay.act.side 에 적지 않는다(데스크톱 배치 보존).
    if (n && zone === 'side') act = sideActNarrow && list.includes(sideActNarrow) ? sideActNarrow : (act && list.includes(act) ? act : (lay.act.bottom && list.includes(lay.act.bottom) ? lay.act.bottom : null));
    if (act && !list.includes(act)) act = null;
    if (!act && list.length) act = list[0];
    if (!(n && zone === 'side' && act && lay.bottom.includes(act))) lay.act[zone] = act;
    pane.act = act;
    if (act) recent[zone] = touchRecent(recent[zone], act);   // 처음 그릴 때 켜져 있던 탭도 «본 것» 이다

    if (zone === 'side') sideHide = null;   // 좁은 폭은 서랍 닫기 단추라 칸 이름을 안 쓴다
    const hideBtn = zone === 'side'
      //  좁은 폭에선 «곁칸 접기»가 아니라 **서랍 닫기**다 — 접기는 눌러도 보이는 게 안 변하는데 sideOn:false 만 저장돼 데스크톱 곁칸이 사라졌다.
      ? (n ? el('button', { class: 'pn-pane-hide', type: 'button', title: '서랍을 닫습니다', 'aria-label': '서랍 닫기', onclick: () => opts.onCloseDrawer?.() }, pnIcon('x', 'pn-i sm'))
        : (sideHide = el('button', { class: 'pn-pane-hide', type: 'button', title: sideLabels(isLeft()).hideTitle, 'aria-label': sideLabels(isLeft()).hideAria, onclick: () => { lay.sideOn = false; saveLayout(); saveView({ sideOn: false }); paintAll(); } }, pnIcon('chev', 'pn-i sm')) as HTMLElement))
      : zone === 'bottom'
        ? el('button', { class: 'pn-pane-hide', type: 'button', title: '아래 칸을 닫습니다', 'aria-label': '아래 칸 닫기', onclick: () => { lay.bottomOn = false; saveLayout(); saveView({ bottomOn: false }); paintAll(); } }, pnIcon('x', 'pn-i sm'))
        : null;
    // 'sessions' 는 탭 하나가 아니라 **세션마다 탭 하나**로 펼친다(그 부품이 살아 있어야 하므로 먼저 만든다).
    const tabsOf = (t: TabKey): HTMLElement[] => {
      if (tabBase(t) !== 'sessions') return [tabEl(zone, t, t === act)];
      ensurePart(pane, t);
      return [];       // 세션은 탭을 만들지 않는다 — 고르기는 사이드바가 한다(위 주석)
    };
    // '＋'가 한 줄에 둘이면 무엇이 열리는지 읽히지 않는다(원준 2026-08-20). 이 칸이 **세션 전용**이면
    //  일반 [+](칸에 내용 더하기)를 빼고 [+ 새 세션] 하나만 둔다 — 다른 것을 넣고 싶으면 곁칸·아래 칸의 [+]로 넣거나
    //  그 탭을 이 칸으로 끌어오면 된다(탭 끌어 옮기기는 그대로 산다).
    const sessionOnly = list.length === 1 && tabBase(list[0]) === 'sessions';
    pane.tabs.replaceChildren(...list.flatMap(tabsOf));
    // 손잡이는 띠 **밖**이라 탭이 몇 개가 되든 밀려나지 않는다(위 makePane 주석). [모두 보기]는 탭이 둘 이상일
    //  때만 만들고, 실제로 보이는 건 띠가 넘칠 때뿐이다(syncMore).
    // ⚠ replaceChildren 은 el() 과 달리 null 을 걸러 주지 않는다 — 넣으면 'null' 이 글자로 찍힌다.
    pane.tail.replaceChildren(...[
      pane.tabs.childElementCount > 1 ? moreBtn(zone) : null,
      sessionOnly ? null : addBtn(zone),
      hideBtn,
    ].filter(Boolean) as HTMLElement[]);
    // 세션만 든 칸에는 탭도 손잡이도 없다 → 줄 자체를 감춘다(빈 띠가 남으면 그게 더 이상하다).
    pane.bar.hidden = pane.tabs.childElementCount === 0 && pane.tail.childElementCount === 0;
    //  마우스로 막 닫은 줄이면 얼려 둔 폭 그대로(다음 × 가 커서 밑에 남는다), 아니면 새로 잰다.
    if (pane.frozen) applyFreeze(pane); else fit(pane);
    // 켜진 탭이 띠 밖으로 밀려 있으면 끌어온다(셸 탭 줄과 같은 문법 — tabs.ts). 'nearest' 라 이미 보이면 안 움직인다.
    const onTab = pane.tabs.querySelector('.pn-tabwrap.on') as HTMLElement | null;
    if (onTab && pane.tabs.scrollWidth > pane.tabs.clientWidth + 1) onTab.scrollIntoView({ inline: 'nearest', block: 'nearest' });

    // 켜진 부품만 보이게(나머지는 살려 둔 채 숨긴다 — 탭을 오가도 대화·스크롤이 그대로다).
    if (act) ensurePart(pane, act);
    for (const [t, p] of pane.parts) p.root.hidden = t !== act;
    pane.bodyEl.classList.toggle('empty', !act);
    if (!act) {
      let ph = pane.bodyEl.querySelector('.pn-pane-empty') as HTMLElement | null;
      if (!ph) {
        ph = el('div', { class: 'pn-pane-empty' },
          el('p', { class: 'pn-fine', text: '이 칸이 비어 있어요 — 위의 ＋ 로 넣을 것을 고르세요.' })) as HTMLElement;
        pane.bodyEl.append(ph);
      }
      ph.hidden = false;
    } else {
      const ph = pane.bodyEl.querySelector('.pn-pane-empty') as HTMLElement | null;
      if (ph) ph.hidden = true;
    }
    if (zone === 'side') dock?.sync();   // #4443 — 떠 있는 탭·켜진 탭이 바뀌면 독의 점·켜짐도 맞춘다
  }

  /** 탭 **띠만** 다시 그린다 — 부품이 자기 이름을 바꿨을 때(뷰어가 다른 파일을 폈을 때) 쓴다.
   *  ⚠ paintPane 을 부르면 안 된다: 그러면 부품 몸이 다시 서면서 보던 자리·스크롤이 튄다(#762 덱 사고와 같은 뿌리). */
  function paintTabs(zone: Zone): void {
    const pane = panes.get(zone);
    if (!pane) return;
    const act = pane.act ?? lay.act[zone];
    for (const [key, wrapEl] of tabNodes(pane)) {
      const b = wrapEl.querySelector('.pn-tab') as HTMLElement | null;
      const span = b?.querySelector('.pn-tab-t') as HTMLElement | null;
      const nm = tabName(key);
      //  가운데 말줄임 중이면 온전한 이름은 data-full 에 있다(fitTitles) — 그것과 비교하고, 바뀌었으면 말줄임을 걷는다(fit 이 다시 잰다).
      if (span && (span.dataset.full ?? span.textContent) !== nm) { span.textContent = nm; delete span.dataset.full; }
      if (b) { b.setAttribute('aria-label', nm); b.title = tabTip(key); }
      //  뷰어는 파일 이름이 서야 종류(그림·문서…)를 안다 — 이름이 바뀌면 아이콘도 갈아 낀다.
      const lead = b?.querySelector('.pn-tab-lead') as HTMLElement | null;
      const ic = tabIcon(key);
      if (lead && lead.dataset.ic !== ic) { lead.dataset.ic = ic; lead.replaceChildren(pnIcon(ic, 'pn-i sm')); }
      wrapEl.classList.toggle('on', key === act);
    }
    fit(pane);
  }

  function paintAll(): void {
    const n = narrow();
    body.classList.toggle('no-side', !lay.sideOn);
    colMain.classList.toggle('no-bottom', n || !lay.bottomOn);
    //  좁은 폭: 곁칸은 서랍이라 **접힘(sideOn)과 무관하게** 서 있고(보이기는 CSS m-aside 가 정한다), 아래 칸은 접혀 들어갔다.
    sidePane.root.hidden = n ? false : !lay.sideOn;
    splitX.hidden = !lay.sideOn;
    sideReopen.hidden = n || lay.sideOn;
    bottomPane.root.hidden = n || !lay.bottomOn;
    splitY.hidden = n || !lay.bottomOn;
    paintPane('main'); paintPane('side'); paintPane('bottom');
    swap?.sync();
    card?.sync();
    paintSideLabels();
    paintDoor();
  }

  // ⭐ 문패의 얼굴 줄은 '이 프로젝트의 구성원'이 아니라 **지금 이 세션을 보고 있는 사람**이다(#2116).
  //  구성원 명단은 [프로젝트 상세]가 이미 갖고 있고, 문패에서 사람이 알고 싶은 건 "지금 여기 누가 있나"다
  //  — 구글 문서의 얼굴 줄과 같은 질문. 그래서 자리도 같다: **[공유] 바로 왼쪽에 상주**한다.
  //  ⚠ 혼자일 때 숨기지 않는다(원준 2026-08-26). 내 얼굴 하나는 정보가 적어 보이지만, 얼굴 줄이 **늘 그 자리에
  //   있다**는 사실 자체가 "여기 사람이 보인다"를 말한다 — 있다 없다 하면 아무도 그 자리를 안 쳐다본다.
  const FACE_MAX = 3;   // 넘으면 접는다 — 네 번째부터는 이름이 아니라 '몇 명 더'가 알고 싶은 것이다
  function facesNode(row: any): HTMLElement | null {
    const vs = viewersOf(row && row.id);
    if (!vs.length) return null;                 // 도장이 아직 없다(막 열렸거나 멈춘 세션) — 빈 자리를 그리지 않는다
    const shown = vs.slice(0, FACE_MAX);
    const rest = vs.length - shown.length;
    return el('span', { class: 'pn-faces', title: '지금 보고 있는 사람 — ' + vs.map((v) => v.name).join(', ') },
      ...shown.map((v) => personFace(v.id, 'pn-face', v.name)),
      rest > 0 ? el('span', { class: 'pn-face pn-face-more', text: '+' + rest }) : null);
  }

  // 공유(#2116) — 지금 보고 있는 **세션**을 함께 볼 사람을 고른다(초대는 세션 단위다).
  //  열어 둔 세션이 없으면(새 세션 자리) 공유할 대상이 없으므로 단추도 없다 — 눌러서 "무엇을?"이 되지 않게.
  function shareNode(row: any): HTMLElement | null {
    const sh = shareSessOf(row);
    if (!sh) return null;
    const b = el('button', {
      class: 'btn btn-ghost btn-sm pn-door-btn', type: 'button',
      title: sh.owned ? '이 세션을 함께 볼 사람을 고릅니다' : '이 세션을 누가 볼 수 있는지 봅니다',
      onclick: () => openSharePopover(b as HTMLElement, sh, (invites) => {
        const cur = sessRow(sh.id);
        if (cur && cur.raw) cur.raw.invites = invites;   // 다음 폴링 전까지 화면이 방금 정한 사실을 들고 있게
        paintDoor();
      }),
    }, pnIcon('share', 'pn-i sm'), el('span', { text: '공유' }));
    return b as HTMLElement;
  }

  // ── 문패 ──
  //  ⭐ 한 줄이다(원준 2026-08-26: "너무 높이 많이 차지해"). 종전엔 눈썹줄(#id · 상태 · 세션 n · 할 일 x/y · 지식 n)이
  //   제목 **위에** 한 줄을 더 먹었는데, 그 네 숫자는 이미 화면이 말하고 있다 — 세션 수·지금 도는 수는 왼쪽 트리와
  //   세션 칸이, 할 일·지식은 각자의 칸이. 문패에서 두 번 세는 대신 자리를 돌려준다. 남는 건 **좌표(#id)와 상태**뿐이고
  //   그 둘은 제목과 같은 줄에 선다.
  function paintDoor(): void {
    //  ⚠ 이름을 고치는 중이면 문패를 다시 그리지 않는다(#3870) — 8초 라이브 틱·paintAll 이 문패를 통째로 갈아 끼우면
    //   입력칸이 뜯겨 나가고(연 지 몇 초 만에 옛 이름으로 돌아왔다), 크롬이 뜯긴 칸에 쏘는 blur 가 치던 글자를 저장까지 했다.
    //   건너뛴 판은 편집이 끝날 때 cancel·save 가 바로 다시 그려 갚는다.
    if (titleEdit.skip()) return;
    titleEdit.paid();
    const p = pj();
    const st = p.status_category === 'done' ? { t: '끝남', c: 'done' } : p.status_category === 'unstarted' ? { t: '시작 전', c: 'todo' } : { t: '진행 중', c: 'run' };
    // ⚠ 주소의 id 는 **박스 id 일 수도, 중앙 기록 uuid 일 수도** 있다(main.ts findSess 와 같은 사정).
    //  얼굴 줄도 공유도 축은 박스 id 다(열람 도장이 그 id 로 찍힌다) — 여기서 한 번 맞춰 두면 둘 다 바로 선다.
    const doorRow = boxRow(curSession());
    // ── [세션 옮기기] (#3778, 원준 2026-09-19: «[⋯] 안에만 있지 말고 밖에도 빼놓은 버튼이 있고 싶다») ──
    //  자리는 꼬리표(#번호 · 상태) 바로 뒤다 — 그 꼬리표가 곧 «이 세션이 지금 어디 있나» 이고, 단추는 그걸 바꾼다.
    //  ⚠ 이름에 **«세션»** 을 넣는다: 이 줄은 프로젝트를 말하는 줄이라 «바꾸기» 만 두면 «프로젝트를 바꾼다(다른
    //   프로젝트로 간다)» 로 읽힌다 — 옮겨지는 것은 지금 보는 세션이다(문패 [공유] 가 프로젝트 공유로 읽혔던 것과
    //   같은 함정, 원준 2026-09-09). 세션이 없는 새 세션 자리·남의 세션이면 단추를 안 단다([⋯] 과 같은 조건).
    const sid = curSession();
    const move = sid && opts.onMoveSession && opts.canMoveSession?.(sid)
      ? el('button', { class: 'pn-move', type: 'button', 'aria-label': loose ? '이 세션을 프로젝트에 붙이기' : '이 세션을 다른 프로젝트로 옮기기',
          title: loose ? '이 세션을 프로젝트에 붙입니다' : '이 세션을 다른 프로젝트로 옮기거나 프로젝트에서 뗍니다',
          onclick: () => opts.onMoveSession!(sid) },
          icon('moveto', 'pn-i sm'), el('span', { class: 'pn-move-t', text: loose ? '프로젝트에 붙이기' : '세션 옮기기' }))
      : null;
    door.replaceChildren(
      el('div', { class: 'pn-door-l' },
        // ⭐ 순서는 **이름 › 번호 › 상태**(원준 2026-09-03: "프로젝트 이름이 제일 왼쪽으로 가야 밸런스가 맞는다").
        //  종전엔 눈썹(#id · 상태)이 앞에 서서, 왼쪽 끝에 오는 것이 제목이 아니라 좌표였다 — 화면의 주인공은
        //  이름인데 12.5px 회색 글자가 25px 굵은 글자보다 먼저 읽혔다. 이름을 왼쪽 끝으로 되돌리고
        //  좌표·상태는 그 뒤 꼬리표로 붙인다(같은 줄인 것은 그대로 — 문패는 한 줄이라는 결정은 유효하다).
        titleNode(String(p.name || '프로젝트 #' + id)),
        el('div', { class: 'pn-eyebrow' },
          loose ? el('span', { text: '아직 어느 프로젝트에도 붙지 않았어요.' }) : el('span', { class: 'mono', text: '#' + p.id }),
          loose ? null : el('span', { class: 'sep', text: '·' }),
          loose ? null : el('span', { class: 'pn-state ' + st.c, text: st.t }),
          move)),
      el('div', { class: 'pn-door-r' },
        facesNode(doorRow),
        shareNode(doorRow),
        // ── 문패의 두 버튼 (원준 2026-08-20 "거의 안 보인다") ─────────────────────────
        //  자리는 그대로 둔다 — 대상(프로젝트)의 오른쪽 위는 그 대상에 대한 동작이 사는 관습적인 자리이고,
        //  옮기면 시선이 제목에서 멀어질 뿐이다. 문제는 위치가 아니라 **무게**였다: 둘 다 ghost(배경·테두리 없음)라
        //  흰 문패 위에서 회색 글자로 흩어졌고, 나란히 있으니 무엇이 주된 동작인지도 말하지 않았다.
        //  그래서 **크기·글자크기는 그대로 두고 채움만** 바꾼다 — 이 칸에서 사람이 제일 자주 하는 일(세션 열기)은
        //  칠한 버튼, 가끔 보는 것(상세)은 테두리 버튼. 위계가 색으로 먼저 읽힌다.
        el('span', { class: 'pn-door-sep', 'aria-hidden': 'true' }),
        swap ? swap.button() : null,
        el('button', { class: 'btn btn-primary btn-sm pn-door-btn', type: 'button', title: '이 프로젝트에서 새 세션을 엽니다', onclick: () => newSession() }, pnIcon('plus', 'pn-i sm'), el('span', { text: '세션' })),
        // 이름은 '정보'가 아니라 **프로젝트 상세** — 개요 부품을 없앤 뒤로 본문·할 일·상태를 보는 유일한 입구다.
        //  '정보'만 있으면 무엇에 대한 정보인지 안 말해 준다(원준 2026-08-20).
        loose ? null : el('button', { class: 'btn btn-ghost btn-sm pn-door-btn', type: 'button', title: '본문·할 일·상태·이름을 보고 고칩니다', onclick: () => openSettings() }, pnIcon('info', 'pn-i sm'), el('span', { text: '프로젝트 상세' }))));
  }

  // ── 문패 제목 = **프로젝트 전체 화면으로 가는 문**(원준 2026-08-26) ─────────────────
  //  종전엔 눌러서 이름을 고치는 자리였다. 그런데 문패에서 제목을 누르는 사람이 기대하는 건 '그 프로젝트로
  //  가기'지 '이름 고치기'가 아니다 — 제목은 어디에서나 그 대상으로 가는 링크라는 것이 웹의 기본 문법이고,
  //  거기에 편집을 걸어 두면 **가려던 사람이 편집을 연다**(되돌리려면 Esc 를 눌러야 한다는 것도 알아야 한다).
  //  이름 편집은 사라지지 않는다 — 사이드바 줄 더블클릭(side.ts beginRenameProject)이 그대로 그 길이다.
  //  ⚠ 주소를 고를 때 함정이 둘이다:
  //   · `#/p/<id>` 로 보내면 안 된다 — 라우터가 그걸 '거쳐 가는 문'으로 보고 맨 위 세션으로 갈아 끼운다(main.ts onHash).
  //     즉 지금 보고 있는 화면으로 되돌아와 **아무 일도 안 일어난 것처럼** 보인다.
  //   · `#/projects/<id>` 도 안 된다 — v1 프로젝트 탭 폐기(2026-06-23) 이후 그 경로는 **id 를 버리고** `#/projects2`
  //     (보드)로 리다이렉트한다(web/main.ts). 엉뚱한 화면에 떨어진다.
  //   맞는 주소는 **`#/projects2/p/<id>`** — 그 프로젝트의 상세 화면(본문·할 일·보드)이다.
  //  아이콘은 이 굵은 글자가 **프로젝트 이름**임을 말한다(세션 이름과 한 화면에 있어 둘이 헷갈렸다).
  //  '프로젝트 없는 세션'(loose)은 갈 곳이 없으므로 평범한 제목으로 둔다.
  //  ── 이름 고치기는 **연필**로 (원준 2026-09-03) ────────────────────────────────
  //   위 결정(제목 클릭 = 이동)은 그대로 두되, 종전엔 이 화면에서 이름을 고칠 길이 **아예 없었다** — 사람은
  //   「사이드바 줄 더블클릭」을 미리 알고 있어야 했다. 세션 이름 옆엔 연필이 있는데 프로젝트 이름 옆엔 없으니
  //   같은 화면 안에서 규칙이 둘이었다. 그래서 연필을 붙인다: **그림도 손짓도 세션 이름과 같다**
  //   (session-chat.ts penBtn/startRename — 같은 path, Enter=저장 · Esc=취소 · 다른 데 누르면 저장).
  function startRenameProject(host: HTMLElement, cur: string): void {
    const input = el('input', { class: 'pn-title-in', type: 'text', maxlength: '200', value: cur,
      'aria-label': '프로젝트 이름', spellcheck: 'false' }) as HTMLInputElement;
    let closed = false;
    //  취소는 **제목 자리만** 되돌린다 — 문패를 통째로 다시 그리면, 문패의 단추([세션]·[프로젝트 상세]·[세션 옮기기])를
    //   눌러 편집을 끝낸 경우 그 단추가 누름과 뗌 사이에 새 노드로 바뀌어 클릭이 사라진다(blur 는 누름에서 난다).
    //   편집 중 건너뛴 문패 그리기가 있으면 손을 뗀 뒤 한 번 갚는다(lib/edit-hold).
    const cancel = (): void => {
      if (closed) return;
      closed = true;
      titleEdit.end(input, paintDoor);
      host.replaceWith(titleNode(String(pj().name || '프로젝트 #' + id)));
    };
    const save = async (): Promise<void> => {
      if (closed) return;
      const to = input.value.replace(/\s+/g, ' ').trim();
      if (!to || to === cur) { cancel(); return; }
      //  저장을 기다리는 동안엔 칸을 놓아 둔다 — 응답이 안 와도 문패가 굳지 않게(틱이 옛 모양으로라도 다시 그린다).
      closed = true; input.disabled = true; titleEdit.end(input);
      try {
        await opts.onRenameProject!(id, to);
        if (detail && detail.project) detail.project.name = to;   // 이 판이 든 사본도 곧바로 새 이름으로
        toast('프로젝트 이름을 바꿨어요.');
      } catch (e: any) { toast('이름을 바꾸지 못했습니다 — ' + ((e as Error)?.message || e), true); }
      paintDoor();
    };
    input.onkeydown = (e: KeyboardEvent) => {
      if (e.isComposing) return;             // 한글 조합 중의 Enter 는 확정이지 저장이 아니다
      if (e.key === 'Enter') { e.preventDefault(); void save(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    input.onblur = () => { void save(); };   // 다른 데를 누르면 그대로 저장(취소는 Esc)
    host.replaceChildren(input);
    titleEdit.begin(input);
    input.focus(); input.select();
  }
  function titleNode(name: string): HTMLElement {
    if (loose) return el('h1', { class: 'pn-title', text: name });
    const h = el('h1', { class: 'pn-title' },
      el('a', { class: 'pn-title-btn', href: '#/projects2/p/' + id, title: name + ' — 프로젝트 전체 화면으로 갑니다' },
        pnIcon('proj', 'pn-title-ic'),
        el('span', { class: 'pn-title-t', text: name })));
    if (opts.onRenameProject) h.append(el('button', {
      class: 'pn-title-penbtn', type: 'button', 'aria-label': '프로젝트 이름 바꾸기',
      title: '프로젝트 이름 바꾸기 — 제목을 누르면 그 프로젝트로 갑니다',
      onclick: () => startRenameProject(h, name),
    }, sv('svg', { viewBox: '0 0 24 24', class: 'pn-title-pen', 'aria-hidden': 'true' },
      sv('path', { d: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z' }))));
    return h;
  }

  function resetLayout(): void {
    for (const pane of panes.values()) {
      for (const p of pane.parts.values()) { p.destroy?.(); p.root.remove(); }
      pane.parts.clear();
    }
    lay = DEF_LAYOUT();
    sideActNarrow = null;
    saveLayout(); paintAll();
    toast('기본 배치로 되돌렸어요.');
  }

  function openSettings(): void {
    if (loose) return;
    openProjSettings({ id, detail, onChanged: () => { void refreshDetail(); opts.onProjectChanged?.(); } });
  }

  async function refreshDetail(): Promise<void> {
    if (loose) { paintDoor(); return; }
    try {
      const d = await api('/api/ui/v6/projects/' + id);
      if (dead || !d) return;
      detail = d;
      paintDoor();
      for (const pane of panes.values()) for (const [t, p] of pane.parts) { if (!p.root.hidden && t !== 'sessions') p.tick?.(); }
    } catch (_) { /* 다음 틱에 다시 시도한다 */ }
  }

  // ── 라이브 틱 — 보이는 부품만 제자리 갱신(서명이 같으면 DOM 을 안 건드린다) ──
  const timer = window.setInterval(() => {
    if (dead) return;
    // 안 보이는 셸 탭에서는 돌지 않는다 — 탭은 갈아 껴도 살아 있으므로(대화 보존), 열어 둔 탭 수만큼
    //  8초마다 문패를 다시 그리고 부품을 갱신하는 값이 그대로 붙는다. 지금 아무도 안 보는 화면이다.
    //  (다시 보이면 다음 틱에 따라잡는다 — 본디 8초 간격이라 사람이 느낄 차이가 아니다.)
    if (!wrap.isConnected || wrap.getClientRects().length === 0) return;
    for (const pane of panes.values()) {
      const act = lay.act[pane.zone];
      if (!act) continue;
      const p = pane.parts.get(act);
      if (p && !p.root.hidden) p.tick?.();
    }
    paintDoor();
  }, 8000);

  // ── 곁칸 독(#4443, 원준 2026-09-30) — 곁칸에 띄울 앱의 문. 규칙은 lib/pane-dock, 그리기는 v2/pane-dock ──────────
  //  여기(모든 선언이 끝난 뒤 · 첫 그림 직전)에 세운다 — 독은 세우자마자 한 번 그리며 tabName(tabTitles) 까지 읽는다.
  //  독이 아는 «떠 있는 것» = 곁칸 + 아래 칸의 탭(좁은 폭이면 서랍의 줄). 하나만 사는 앱이 아래 칸에 있으면 곁칸에 둘째를 세우지 않고 그리로 간다.
  //  옛 [앱] 부품(설치 앱 목록)은 독에 세우지 않는다 — 독의 [더보기]가 같은 일을 한다(둘을 나란히 두면 같은 격자 아이콘 둘이 선다, 실측).
  const dockKeys = (): TabKey[] => (narrow() ? zoneTabs('side') : [...lay.side, ...lay.bottom]).filter((k) => tabBase(k) !== 'sessions' && tabBase(k) !== 'apps');
  const dockApps = (): DockApp[] => PART_DEFS.filter((d) => d.type !== 'sessions').map((d) => ({
    type: d.type, name: d.name, glyph: d.icon, hint: d.hint, multi: !!d.multi,
    //  프로젝트 없는 세션 화면엔 공유 폴더·지식·할 일·리브가 없다([+] 목록과 같은 규칙).
    //  stage 판의 PartDef 엔 pickable 이 없다(main #4135 에서 생김) — 없으면 고를 수 있는 것으로 본다.
    pickable: (d as { pickable?: boolean }).pickable !== false && !(loose && (d.type === 'files' || d.type === 'knowledge' || d.type === 'tasks' || d.type === 'liv')),
  }));
  dock = mountDock({
    pane: sidePane.root,
    apps: dockApps,
    tabs: () => dockKeys().map((k) => ({ key: k, type: tabBase(k) })),
    act: () => panes.get('side')?.act ?? null,
    recent: () => [...recent.side, ...recent.bottom],
    title: (k) => tabName(k),
    show: (k) => { const z = zoneOf(k) || 'side'; revealZone(z); activate(z, k); paintAll(); },
    open: (type) => { openZone('side'); addPart('side', type as PartType); },
    close: (k) => closeTab(zoneOf(k) || 'side', k),
    closeAll: (type) => {
      const keys = dockKeys().filter((k) => tabBase(k) === type && !DERIVED_TABS.has(tabBase(k)));
      if (!keys.length) return;
      recordClosed(keys);                                 // [닫은 탭 다시 열기] 로 한꺼번에 돌아온다(탭 줄의 한꺼번에 닫기와 같다)
      for (const k of keys) dropTab(zoneOf(k) || 'side', k, { paint: false });
      thawAll(); saveLayout(); paintAll();
      if (keys.length > 1) toast(`${partDef(type as PartType).name} ${keys.length}개를 닫았어요. 탭 줄을 우클릭해 [닫은 탭 다시 열기]로 되살릴 수 있어요.`);
    },
    curSession: () => curSession(),
    //  [더보기]의 «이 세션에 붙이기»(#4225)는 이 판(stage)에 없다 — attach 를 안 넘기면 독이 그 구획을 안 세운다.
    narrow: () => narrow(),
  });

  applyView();          // 첫 그림 전에 이 세션의 폭·높이·접힘을 입힌다(swap 이 선 뒤라 상한 판정이 산다)
  paintAll();
  if (!loose && !detail) void refreshDetail();

  // [보관한 세션]에서 [탭에 꺼내기]를 누르면 이 줄을 그 자리에서 다시 그린다(8초 틱을 기다리지 않게).
  /** 새 세션 — 탭 줄과 함께 사라진 [＋ 새 세션]의 새 자리(문패 오른쪽). 세션 부품을 '새 세션 자리'로 돌린다. */
  function newSession(): void {
    const pane = panes.get('main');
    if (!pane) return;
    ensurePart(pane, 'sessions');
    activate('main', 'sessions');
    pane.parts.get('sessions')?.selectSession?.(null);
  }
  const onViewChanged = (): void => { if (!dead) paintPane('main'); };
  window.addEventListener('pn:sessions-view', onViewChanged);
  // #2116 — 얼굴 줄이 바뀌면 문패만 다시 그린다. **지금 보고 있는 세션의 것일 때만** — 다른 탭의 얼굴이
  //  바뀌었다고 이 문패를 다시 그릴 이유가 없다(presence.setViewers 가 이미 '바뀐 것'만 알려준다).
  const offViewers = onViewers((sid) => { if (!dead && sid === boxRow(curSession())?.id) paintDoor(); });
  //  문턱(≤900)을 넘나들면 접힌 배치를 다시 그린다 — 접힌 탭의 부품은 한 벌만(반대쪽 칸의 것을 걷는다: moveTab 과 같은 규칙, 부품은 다시 선다).
  const onNarrow = (): void => {
    if (dead) return;
    sideActNarrow = null;
    for (const key of lay.bottom) dropPartFrom(narrow() ? bottomPane : sidePane, key);
    paintAll();
  };
  if (typeof narrowMq.addEventListener === 'function') narrowMq.addEventListener('change', onNarrow); else (narrowMq as any).addListener(onNarrow);

  return {
    newSession,
    showPart,
    repaintDoor(): void { paintDoor(); },
    destroy(): void {
      if (typeof narrowMq.removeEventListener === 'function') narrowMq.removeEventListener('change', onNarrow); else (narrowMq as any).removeListener(onNarrow);
      wrap.removeEventListener('pn:open-web', onOpenWeb);
      wrap.removeEventListener(VIEWER_EVT, onOpenViewer);
      window.removeEventListener('message', onMsg);
      dead = true;
      offViewers();
      window.removeEventListener('pn:sessions-view', onViewChanged);
      window.clearInterval(timer);
      cancelTabDrag(); thawAll();   // #3870 — 끄는 중이던 탭 · 얼림 감시(window pointermove)를 걷는다
      dock?.destroy(); dock = null;   // #4443
      card?.destroy();
      swap?.destroy();
      for (const ro of ros) ro.disconnect();
      ros.length = 0;
      for (const pane of panes.values()) for (const p of pane.parts.values()) p.destroy?.();
      panes.clear();
      sessSubs.clear();
      trailSid = null; trailW = null; trailHost.replaceChildren();
    },
  };
}
