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
import { PART_DEFS, makePart, openInWebPart, partDef, pnIcon, type Part, type PartCtx, type PartType } from './panes-parts.js';
import { VIEWER_EVT, VIEWER_TO_EVT, ctxMenu, rememberViewerPath, slotStoreKey } from './panes-kit.js';
//  ★ 탭 = 부품의 **인스턴스**(#762) — 배치가 드는 것은 '종류'가 아니라 '탭 열쇠'다(lib/tab-key 머리말).
import { isTabKey, nextTabKey, tabBase, tabNum, type TabKey } from '../lib/tab-key.js';
import { hasBrowserSurface } from './browser-surface.js';
import { onViewers, viewersOf } from './presence.js';           // #2116 — 지금 이 세션을 보고 있는 사람
import { openSharePopover, shareSessOf } from './share-session.js';   // #2116 — 문패 [공유]
import { EMBEDDED } from './embed.js';
import { openProjSettings } from './proj-settings.js';
import { createTimeline, type TimelineHandle } from '../timeline.js';
import { loadSessionActivities } from '../timeline-sources.js';
import { loadThinTrail } from '../session-trail.js';
import type { TlOut } from '../timeline.js';
import { type V2Data } from './views.js';
import { doorProjectName } from '../lib/door-name.js';   // #2579 — 문패 이름은 셸 목록이 정본(판이 든 사본은 안 늙는다)

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
  mountSession?: (host: HTMLElement, sid: string, o?: { trail?: TimelineHandle | null }) => { destroy(): void } | null;
  /** 새 세션 자리에서 세션을 방금 만들었다 — 셸이 그 전문을 세션 목록에 즉시 끼워 넣는다(v2/panes-parts spawn). */
  onSessionCreated?: (row: any) => void;
  /** 세션 탭에서 고친 이름 — main.ts 의 renameSession 이 서버·사이드바·셸 탭·세션 머리줄까지 한 번에 갱신한다. */
  onRenameSession?: (id: string, name: string) => Promise<void>;
  /** 문패 연필로 고친 프로젝트 이름 — main.ts 의 renameProject 가 서버·목록·사이드바·탭까지 한 번에 갱신한다(#2579). */
  onRenameProject?: (id: number, name: string) => Promise<void>;
}
export interface PanesHandle {
  destroy(): void;
  /** 문패만 그 자리에서 다시 그린다 — 이름을 다른 화면에서 바꿨을 때 8초 틱을 기다리지 않게(#2579). */
  repaintDoor(): void;
  /** 이 셸을 '새 세션 자리'로 돌린다 — 사이드바 [＋]와 문패 [＋ 세션]이 같은 곳을 부른다(#1719 원준 2026-08-20). */
  newSession(): void;
}

// ── 배치 ────────────────────────────────────────────────────────────────────
type Zone = 'main' | 'side' | 'bottom';
interface Layout {
  main: TabKey[]; side: TabKey[]; bottom: TabKey[];
  act: { main: TabKey | null; side: TabKey | null; bottom: TabKey | null };
  sideOn: boolean; bottomOn: boolean;
}
// ★ 배치는 **프로젝트마다 한 벌**이고, 그 프로젝트의 세션들이 함께 쓴다(원준 2026-08-20:
//  "띄워져 있는 창의 종류만 같은 프로젝트 안의 다른 세션들이 공유하게 해줘").
//  종전엔 전역 한 벌이었다(위 ② 참조) — '프로젝트마다 설정할 게 많다'를 피하려던 선택이었지만, 정작 필요한 칸은
//  프로젝트마다 달랐다(코드 프로젝트엔 편집기·웹, 글 프로젝트엔 지식·할 일). 세션 사이에서는 여전히 한 벌이라
//  '설정할 게 많다'로 돌아가지는 않는다. 그리고 처음 여는 프로젝트는 **마지막으로 쓰던 배치를 물려받는다** —
//  기본으로 되돌려 버리면 프로젝트를 옮길 때마다 같은 배치를 다시 맞춰야 한다.
const LAYOUT_KEY = deviceStore('lively_panes_layout_v2');   // #1875 — projectId 로 키를 잡으므로 워크스페이스별    // { last: Layout, p: { [projectId]: Layout } }
const LAYOUT_KEY_V1 = 'lively_panes_layout_v1'; // 전역 한 벌이던 옛 판 — 첫 이사 때 'last' 의 씨앗으로만 읽는다
const DEF_LAYOUT = (): Layout => ({
  main: ['sessions'], side: ['files', 'knowledge', 'apps'], bottom: ['timeline'],
  act: { main: 'sessions', side: 'files', bottom: 'timeline' },
  sideOn: true, bottomOn: false,
});
const ALL = new Set<string>(PART_DEFS.map((d) => d.type));

/** ⚠ 불변식: **세션 부품은 가운데 칸에만 산다.**
 *  세션은 탭을 만들지 않는다(고르기는 사이드바가 한다 — 아래 'tabsOf' 주석). 그래서 곁칸·아래 칸에 들어가면
 *  탭도 ×도 없어 **뺄 방법이 사라지고**, 그 칸에 세션만 남으면 탭 줄 자체가 숨어 ＋ 마저 없어진다
 *  (원준 2026-08-20 신고: "세션이 어디 열린 건지도 모르겠고 닫을 수도 없어 골머리"). 넣는 길을 막고(addBtn·moveTab),
 *  이미 그렇게 저장된 배치는 여기서 되돌린다 — 갇힌 사람은 새로고침 한 번으로 풀린다. */
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
    sideOn: s.sideOn !== false, bottomOn: !!s.bottomOn,
  };
  // 저장된 배치가 모든 칸에서 비었으면(옛 판·손상) 없는 것으로 — 빈 화면을 보여 주는 것보다 낫다.
  if (!lay.main.length && !lay.side.length && !lay.bottom.length) return null;
  return normalizeLayout(lay);
}
interface LayoutStore { last?: any; p?: Record<string, any> }
function layoutStore(): LayoutStore {
  try { const s = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); return s && typeof s === 'object' ? s : {}; } catch (_) { return {}; }
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
  let lay = loadLayout(id);
  // 프로젝트 없는 세션 화면 — 공유 폴더·지식·할 일이 없으니 곁칸에 넣을 것도 없다. 빈 칸을 보여 주느니 접어 둔다.
  if (loose) { lay = { ...lay, side: lay.side.filter((t) => t === 'timeline'), bottom: [], bottomOn: false, sideOn: false }; }

  // 칸 하나 = 탭 줄 + 본문(만드는 곳은 아래 makePane). **이 두 줄은 함수 맨 앞이어야 한다** —
  //  curSession() 이 `panes` 를 읽는데, actKey() → applySessionAct() 로 이어지는 그 길을 마운트가
  //  **칸을 만들기 전에** 이미 한 번 지난다. 선언이 뒤에 있으면 그 순간 TDZ 로 죽어 세션·프로젝트
  //  화면이 통째로 «화면을 불러오지 못했습니다 — Cannot access 'panes' before initialization» 가 된다
  //  (2026-09-03 dev 실측, 윤상민 신고 — #762 에서 actKey 를 curSession() 으로 바꾼 판에서 났다).
  //  마운트 시점엔 빈 Map 이라 curSession() 은 opts.sessionId 로 떨어진다 — 그때는 그게 지금 보는 세션이다.
  interface Pane { zone: Zone; root: HTMLElement; bar: HTMLElement; tabs: HTMLElement; tail: HTMLElement; bodyEl: HTMLElement; parts: Map<TabKey, Part> }
  const panes = new Map<Zone, Pane>();

  function saveLayout(): void {
    if (loose) return;                          // 자투리 화면의 임시 배치를 정본으로 굳히지 않는다
    if (EMBEDDED) return;                       // 끼워 넣은 판(미리보기 프레임 안) — 바깥 사람의 배치를 덮어쓰지 않는다
    try {
      const st = layoutStore();
      const map = st.p && typeof st.p === 'object' ? st.p : {};
      map[String(id)] = lay;
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ last: lay, p: map }));
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
  type View = { sideW?: number; bottomH?: number; sideOn?: boolean; bottomOn?: boolean; sideLeft?: boolean };   // sideLeft = 곁칸이 왼쪽(자리바꿈, #762)
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
  const sessRow = (sid: string): any => opts.data().sessions.find((x) => x.id === sid) || null;
  /** 주소가 기록 uuid 로 온 경우까지 받아 **박스 행**을 찾는다 — 문패의 얼굴·공유는 박스 id 를 축으로 돈다(#2116). */
  const boxRow = (sid: string | null): any => {
    if (!sid) return null;
    return sessRow(sid) || opts.data().sessions.find((x: any) => x.logId === sid) || null;
  };
  /** 세션 폴더 기준 상대경로. 그 밖(다른 폴더의 절대경로)이면 null — 열 수 없는 것에 버튼을 달지 않기 위해서다. */
  function relOf(sid: string, p: string): string | null {
    const raw = String(p || '');
    if (!raw) return null;
    if (!raw.startsWith('/')) return raw.replace(/^\.\//, '');            // 이미 상대경로
    const dir = String((sessRow(sid) || {}).dir || '');
    if (dir && raw.startsWith(dir + '/')) return raw.slice(dir.length + 1);
    return null;
  }
  const fileUrlOf = (sid: string, rel: string): string =>
    '/api/ui/terminal/sessions/' + encodeURIComponent(sid) + '/file?path=' + encodeURIComponent(rel);

  function openOut(sid: string, o: TlOut): void {
    if (o.kind === 'url' && o.url) {
      // 앱이면 곁칸에 띄우고(작업하던 자리를 안 떠난다), 브라우저면 새 탭 — aside-slot 규약 그대로.
      if (canOpenInAside() && openInAside({ key: 'out:' + o.url, title: o.label, url: o.url })) return;
      window.open(o.url, '_blank', 'noopener');
      return;
    }
    const rel = relOf(sid, String(o.path || ''));
    if (!rel) { toast('이 파일은 세션 폴더 밖에 있어 여기서 열 수 없어요.', true); return; }
    // 프로젝트 자료(세션 폴더의 ./project)면 뷰어 칸에서 연다 — 자료 칸이 쓰는 것과 같은 신호다.
    const inProject = rel === 'project' || rel.startsWith('project/');
    if (inProject && id > 0) {
      window.dispatchEvent(new CustomEvent('pn-viewer-open', { detail: { id, path: rel.replace(/^project\/?/, '') } }));
      return;
    }
    window.open(apiUrl(fileUrlOf(sid, rel)), '_blank', 'noopener');
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
    mountSession: opts.mountSession ? (host, sid) => opts.mountSession!(host, sid, { trail: trailFor(sid) }) : undefined,
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
    const root = el('section', { class: 'pn-pane', 'data-zone': zone }, bar, bodyEl);
    const p: Pane = { zone, root, bar, tabs, tail, bodyEl, parts: new Map() };
    // 탭을 끌어 이 칸에 떨구면 그 부품이 여기로 옮겨 온다(VS Code 의 탭 도킹). 과녁은 줄 전체다 —
    //  띠가 꽉 차면 빈 자리가 없어져, 띠만 과녁이면 떨굴 데가 사라진다.
    bar.addEventListener('dragover', (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('text/x-pn-part')) return;
      e.preventDefault(); bar.classList.add('drop');
    });
    bar.addEventListener('dragleave', () => bar.classList.remove('drop'));
    bar.addEventListener('drop', (e: DragEvent) => {
      bar.classList.remove('drop');
      const raw = e.dataTransfer?.getData('text/x-pn-part') || '';
      if (!raw) return;
      e.preventDefault();
      let msg: { type: PartType; from: Zone };
      try { msg = JSON.parse(raw); } catch (_) { return; }
      moveTab(msg.type, msg.from, zone);
    });
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

  /** 이름을 접을까 — **재서** 정한다(원준 2026-08-20: "충분히 다 보여줄 수 있는데 접는 일은 절대 없게").
   *
   *  폭 브레이크포인트로 정하면 '곁칸은 좁지만 탭은 둘뿐'인 화면까지 아이콘만 남는다. 그래서 기준을 폭이 아니라
   *  **넘치는가**로 둔다: 이름을 다 편 채로 재서 들어가면 그대로 두고, 넘칠 때만 켜진 탭 하나만 이름을 남기고
   *  나머지를 아이콘으로 접는다(파비콘 문법 — 이름은 툴팁과 [모두 보기]가 말한다).
   *
   *  ⚠ 잴 때는 **가장 너그러운 상태**(이름 다 펴고 ⌄ 숨긴 채)로 되돌려 놓고 잰다. 접힌 상태에서 재면
   *  '한 번 접히면 넓혀도 안 펴지는' 이력(hysteresis)이 생기고, ⌄(30px)를 낀 채 재면 그 30px 때문에
   *  들어갈 것도 접힌다. scrollWidth 를 읽는 순간 레이아웃이 동기 계산되므로 이 되돌림은 화면에 안 보인다. */
  function fit(p: Pane): void {
    p.bar.classList.remove('compact', 'has-more');
    if (p.tabs.scrollWidth > p.tabs.clientWidth + 1) p.bar.classList.add('compact');
    syncMore(p);        // 접고도 남는 넘침만 '더 있다'(그늘)로 말한다
  }

  const mainPane = makePane('main');
  const bottomPane = makePane('bottom');
  const sidePane = makePane('side');

  // 세로 경계(가운데|곁칸) · 가로 경계(가운데|아래 칸) — 폭·높이는 split.ts 가 기억한다.
  // 곁칸 경계 — 상한·부호를 side-swap 이 정한다(#1819). 곁칸이 왼쪽으로 가면 같은 손잡이의 부호가 반대가 된다.
  let swap: SideSwapHandle | null = null;
  const splitX = makeSplitter({
    axis: 'x', key: 'panes_side', cssVar: '--pn-side-w', target: body, def: 340, min: 220,
    max: () => swap?.maxSideW() ?? 620,
    grow: () => (body.classList.contains('sw-left') ? 1 : -1),
    label: '곁칸 너비',
    onDrag: (px) => swap?.onDrag(px),
    //  놓는 순간 **이 세션의 폭**으로 적는다. makeSplitter 는 전역 키에도 그대로 남기는데(그건 '마지막으로 쓰던 값'),
    //  그게 다음에 처음 여는 세션이 물려받을 값이다 — 둘은 싸우지 않는다(읽을 때 세션 값이 먼저다).
    onEnd: (px) => { swap?.onEnd(px); saveView({ sideW: Math.round(px) }); },
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
    const w = Math.max(220, Math.min(swap?.maxSideW() ?? 620, Number(v.sideW) || 340));
    const h = Math.max(120, Math.min(560, Number(v.bottomH) || 240));
    body.style.setProperty('--pn-side-w', w + 'px');
    colMain.style.setProperty('--pn-bottom-h', h + 'px');
    // 접힘도 그 세션이 정한 적이 있을 때만 따른다 — 없으면 이 프로젝트의 기본 배치 그대로(칸의 '종류'와 같은 축).
    if (typeof v.sideOn === 'boolean') lay.sideOn = v.sideOn;
    if (typeof v.bottomOn === 'boolean') lay.bottomOn = v.bottomOn;
    // ★ 자리(곁칸이 왼쪽인가)도 폭을 입힌 **뒤에** 되살린다(#762) — 폭보다 먼저 판정하면 늘 기본 폭으로 «안 바꿈»이 된다.
    //   적어 둔 자리가 있으면 그대로, 없으면(그 세션에서 자리가 바뀐 적이 없으면) 폭으로 판정한다.
    swap?.restore(w, typeof v.sideLeft === 'boolean' ? v.sideLeft : undefined);
  }
  colMain.append(mainPane.root, splitY, bottomPane.root);
  // 접힌 곁칸을 다시 펴는 손잡이 — 문패의 [칸] 버튼을 빼면서(원준 2026-08-20) 유일한 복구 통로가 됐다.
  //  격자 칸을 차지하지 않고 오른쪽 위에 떠 있는다(no-side 격자를 안 건드리기 위해).
  const sideReopen = el('button', {
    class: 'pn-side-reopen', type: 'button', title: '곁칸을 폅니다 — 자료·지식이 여기 들어 있어요.', 'aria-label': '곁칸 펴기',
    onclick: () => { lay.sideOn = true; saveLayout(); saveView({ sideOn: true }); paintAll(); },
  }, pnIcon('chev', 'pn-i sm')) as HTMLElement;
  body.append(colMain, splitX, sidePane.root, sideReopen);
  swap = mountSideSwap({ body, colMain, sidePane: sidePane.root, sideOn: () => lay.sideOn,
    //  자리가 바뀌면 **이 세션의 것**으로 적는다 — 폭·접힘과 같은 표에(나갔다 들어와도 그 자리, 원준 2026-09-04).
    onChange: (v) => saveView({ sideLeft: v }) });

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
        for (const z of ['main', 'side', 'bottom'] as Zone[]) if (lay[z].includes(slot)) paintTabs(z);
      },
    };
  }
  function ensurePart(pane: Pane, key: TabKey): Part {
    let p = pane.parts.get(key);
    if (!p) { p = makePart(tabBase(key) as PartType, ctxFor(key)); pane.parts.set(key, p); pane.bodyEl.append(p.root); }
    return p;
  }
  function activate(zone: Zone, key: TabKey | null): void {
    lay.act[zone] = key;
    saveLayout();
    saveAct(zone, key);      // 이 세션이 무엇을 보고 있었는지도 함께 — 다시 돌아오면 그 탭이 켜져 있다
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
    const list = lay[zone];
    if (!list.includes(key)) list.push(key);
    lay.act[zone] = key;
    if (zone === 'side') { lay.sideOn = true; saveView({ sideOn: true }); }
    if (zone === 'bottom') { lay.bottomOn = true; saveView({ bottomOn: true }); }
    saveLayout(); paintAll();
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
    openZone(z); activate(z, key); paintAll();
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
  const onOpenViewer = (e: Event): void => {
    const d = (e as CustomEvent).detail as { path?: string; newTab?: boolean } | undefined;
    const found = d?.newTab ? null : findTab('editor');
    //  새 탭은 **이미 뷰어가 사는 칸**에 나란히 세운다 — 아래 칸에 뷰어를 두고 쓰는 사람에게 곁칸이 튀어나오면
    //   그건 나란히 보기가 아니라 자리 뺏기다. 뷰어가 하나도 없으면 곁칸.
    const zone: Zone = found ? found.zone : (findTab('editor')?.zone ?? 'side');
    //  ⚠ **열쇠를 먼저 잡고 기억을 적은 뒤에** 탭을 만든다 — 순서가 뒤면 갓 만들어진 뷰어가 빈 목록을
    //   한 번 그렸다가 신호를 받고 다시 그린다(화면이 깜빡인다).
    const key = found ? found.key : nextTabKey('editor', allKeys());
    if (d?.path) rememberViewerPath(ctx.memKey(), key, d.path);
    if (!found) addTab(zone, key);
    openZone(zone);
    activate(zone, key);
    paintAll();
    //  이미 있던 칸은 이 신호로 갈아입는다(방금 만든 칸은 기억에서 이미 읽었다 — 두 번 열어도 같은 파일이라 무해).
    if (d?.path) wrap.dispatchEvent(new CustomEvent(VIEWER_TO_EVT, { detail: { id, path: d.path, slot: key } }));
  };
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

  function removeTab(zone: Zone, key: TabKey): void {
    const list = lay[zone];
    const i = list.indexOf(key);
    if (i < 0) return;
    list.splice(i, 1);
    const pane = panes.get(zone)!;
    const part = pane.parts.get(key);
    if (part) { part.destroy?.(); part.root.remove(); pane.parts.delete(key); }
    tabTitles.delete(key);
    if (lay.act[zone] === key) lay.act[zone] = list[Math.max(0, i - 1)] || null;
    saveLayout(); paintAll();
  }
  function moveTab(key: TabKey, from: Zone, to: Zone): void {
    if (from === to) { activate(to, key); return; }
    if (tabBase(key) === 'sessions' && to !== 'main') return;   // 세션은 가운데 칸 밖으로 나가지 않는다(위 불변식)
    removeTab(from, key);
    addTab(to, key);
  }

  /** 탭에 걸 이름 — 부품이 단 것(뷰어=파일명·웹=사이트) > 「종류 n」(둘 이상 떠 있을 때) > 종류 이름. */
  function tabName(key: TabKey): string {
    const t = tabTitles.get(key);
    if (t) return t;
    const d = partDef(tabBase(key) as PartType);
    const n = tabNum(key);
    return n >= 2 ? `${d.name} ${n}` : d.name;
  }
  function tabEl(zone: Zone, key: TabKey, on: boolean): HTMLElement {
    const d = partDef(tabBase(key) as PartType);
    const nm = tabName(key);
    const b = el('button', {
      class: 'pn-tab' + (on ? ' on' : ''), type: 'button', role: 'tab',
      // 접히면 아이콘만 남는다(fit) — 이름은 툴팁이 말해야 한다. 읽어주는 이름(aria-label)도 이름으로 고정.
      'aria-selected': String(on), title: `${nm} — ${d.hint}`, 'aria-label': nm, draggable: 'true',
      onclick: () => activate(zone, key),
      //  우클릭 = 이 탭을 어디에 둘까(#762) — 두 파일을 **동시에** 보려면 한 탭을 다른 칸으로 보내야 하는데,
      //   그 길이 끌어 옮기기뿐이라 아무도 몰랐다. 같은 일을 메뉴로도 연다.
      oncontextmenu: (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); tabMenu(e, zone, key); },
      //  ⚠ 번호는 **단추에** 심는다 — ::after 의 attr() 은 제 요소의 값만 읽는다(겉싸개 것은 못 본다).
      'data-n': tabNum(key) > 1 ? String(tabNum(key)) : null,
    }, pnIcon(d.icon, 'pn-i sm'), el('span', { text: nm })) as HTMLElement;
    b.addEventListener('dragstart', (e: DragEvent) => {
      e.dataTransfer?.setData('text/x-pn-part', JSON.stringify({ type: key, from: zone }));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      b.classList.add('drag');
    });
    b.addEventListener('dragend', () => b.classList.remove('drag'));
    const x = el('button', {
      class: 'pn-tab-x', type: 'button', title: `${nm} 칸에서 뺍니다`, 'aria-label': `${nm} 빼기`,
      onclick: (e: MouseEvent) => { e.stopPropagation(); removeTab(zone, key); },
    }, pnIcon('x', 'pn-i xs'));
    //  접히면 아이콘만 남는다 — 같은 종류가 둘 이상이면 그때 서로를 구별할 길이 사라진다(#762 실측:
    //   뷰어 셋이 같은 눈 아이콘 셋이었다). 번호를 아이콘 어깨에 남긴다(CSS ::after, 접혔을 때만 보인다).
    return el('span', { class: 'pn-tabwrap' + (on ? ' on' : ''), 'data-tab': key, 'data-n': tabNum(key) > 1 ? String(tabNum(key)) : null }, b, x);
  }

  /** 지금 띠에 서 있는 탭들 — [열쇠, 겉싸개]. paintTabs 가 이름만 갈아 끼울 때 쓴다. */
  function tabNodes(pane: Pane): Array<[TabKey, HTMLElement]> {
    return [...pane.tabs.querySelectorAll('.pn-tabwrap')]
      .map((n) => [String((n as HTMLElement).dataset.tab || ''), n as HTMLElement] as [TabKey, HTMLElement])
      .filter(([k]) => !!k);
  }

  /** 탭 우클릭 메뉴 — 「다른 칸으로 보내기」와 「하나 더」. 나란히 보기가 여기서 시작된다. */
  function tabMenu(e: MouseEvent, zone: Zone, key: TabKey): void {
    const type = tabBase(key) as PartType;
    const d = partDef(type);
    const label: Record<Zone, string> = { main: '가운데 칸', side: '곁칸', bottom: '아래 칸' };
    const canGo = (z: Zone): boolean => z !== zone && !(type === 'sessions' && z !== 'main') && z !== 'main';
    ctxMenu(e.clientX, e.clientY, [
      ...(['side', 'bottom'] as Zone[]).filter(canGo).map((z) => ({
        label: `${label[z]}으로 보내기`, run: () => { openZone(z); moveTab(key, zone, z); },
      })),
      ...(d.multi ? [{ sep: true, label: '' }, { label: `${d.name} 하나 더`, run: () => { addPart(zone, type); } }] : []),
      { sep: true, label: '' },
      { label: '이 칸에서 빼기', danger: true, run: () => removeTab(zone, key) },
    ]);
  }

  /** [모두 보기] — 띠가 넘쳐 **가려진 탭이 생겼을 때만** 뜨는 통로(CSS: .pn-tabbar.has-more).
   *  여기서 고르면 그 탭이 켜지고, 여기 ×로 빼면 띠를 훑지 않고도 뺄 수 있다 — 신고의 '×를 누르기 힘들다'가
   *  실은 '×가 칸 밖에 있어 손이 닿지 않는다'였다. 이 목록은 스크롤과 무관하게 늘 칸 안에 있다. */
  function moreBtn(zone: Zone): HTMLElement {
    const b = el('button', { class: 'pn-tab-more', type: 'button', title: '이 칸에 든 탭을 모두 봅니다', 'aria-label': '탭 모두 보기' }, pnIcon('chev', 'pn-i sm')) as HTMLElement;
    b.onclick = () => {
      const list = lay[zone].filter((t) => tabBase(t) !== 'sessions');
      const close = anchoredPopover(b, el('div', { class: 'pn-pop' },
        el('p', { class: 'pn-pop-h', text: '이 칸에 들어 있는 것입니다 — 누르면 그 탭이 켜지고, ×는 이 칸에서 뺍니다.' }),
        el('div', { class: 'pn-pop-list' }, ...list.map((t) => {
          const d = partDef(tabBase(t) as PartType);
          const nm = tabName(t);
          return el('div', { class: 'pn-pop-line' + (lay.act[zone] === t ? ' on' : '') },
            el('button', { class: 'pn-pop-row', type: 'button', onclick: () => { close(); activate(zone, t); } },
              pnIcon(d.icon, 'pn-i sm'),
              el('span', { class: 'n' }, el('b', { text: nm }), el('span', { class: 'pn-fine', text: nm === d.name ? d.hint : d.name }))),
            el('button', {
              class: 'pn-pop-x', type: 'button', title: `${nm} 칸에서 뺍니다`, 'aria-label': `${nm} 빼기`,
              onclick: () => { close(); removeTab(zone, t); },
            }, pnIcon('x', 'pn-i xs')));
        }))));
    };
    return b;
  }

  function addBtn(zone: Zone): HTMLElement {
    const b = el('button', { class: 'pn-tab-add', type: 'button', title: '이 칸에 내용을 더합니다', 'aria-label': '내용 더하기' }, pnIcon('plus', 'pn-i sm')) as HTMLElement;
    b.onclick = () => {
      //  ★ 이미 있어도 **multi 부품이면 하나 더** 낼 수 있다(#762) — 셸은 그 선언만 본다(부품 이름이 여기 안 박힌다).
      const has = (t: PartType): boolean => lay[zone].some((k) => tabBase(k) === t);
      const rest = PART_DEFS.filter((d) => (d.multi || !has(d.type))
        && !(d.type === 'sessions' && zone !== 'main')     // 세션은 가운데 칸의 것 — 여기 넣으면 뺄 수가 없다(위 불변식)
        && !(loose && (d.type === 'files' || d.type === 'knowledge' || d.type === 'tasks' || d.type === 'liv' || d.type === 'editor')));
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
          loose || lay.bottomOn ? null : el('button', { class: 'btn-text', type: 'button', text: '아래 칸 열기', onclick: () => { close(); lay.bottomOn = true; saveLayout(); saveView({ bottomOn: true }); paintAll(); } }),
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
    const list = lay[zone];
    let act = lay.act[zone];
    if (act && !list.includes(act)) act = null;
    if (!act && list.length) act = list[0];
    lay.act[zone] = act;

    const hideBtn = zone === 'side'
      ? el('button', { class: 'pn-pane-hide', type: 'button', title: '곁칸을 접습니다', 'aria-label': '곁칸 접기', onclick: () => { lay.sideOn = false; saveLayout(); saveView({ sideOn: false }); paintAll(); } }, pnIcon('chev', 'pn-i sm'))
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
    fit(pane);
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
  }

  /** 탭 **띠만** 다시 그린다 — 부품이 자기 이름을 바꿨을 때(뷰어가 다른 파일을 폈을 때) 쓴다.
   *  ⚠ paintPane 을 부르면 안 된다: 그러면 부품 몸이 다시 서면서 보던 자리·스크롤이 튄다(#762 덱 사고와 같은 뿌리). */
  function paintTabs(zone: Zone): void {
    const pane = panes.get(zone);
    if (!pane) return;
    const act = lay.act[zone];
    for (const [key, wrapEl] of tabNodes(pane)) {
      const b = wrapEl.querySelector('.pn-tab') as HTMLElement | null;
      const span = b?.querySelector('span');
      const nm = tabName(key);
      if (span && span.textContent !== nm) span.textContent = nm;
      if (b) { b.setAttribute('aria-label', nm); b.title = `${nm} — ${partDef(tabBase(key) as PartType).hint}`; }
      wrapEl.classList.toggle('on', key === act);
    }
    fit(pane);
  }

  function paintAll(): void {
    body.classList.toggle('no-side', !lay.sideOn);
    colMain.classList.toggle('no-bottom', !lay.bottomOn);
    sidePane.root.hidden = !lay.sideOn;
    splitX.hidden = !lay.sideOn;
    sideReopen.hidden = lay.sideOn;
    bottomPane.root.hidden = !lay.bottomOn;
    splitY.hidden = !lay.bottomOn;
    paintPane('main'); paintPane('side'); paintPane('bottom');
    swap?.sync();
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
    const p = pj();
    const st = p.status_category === 'done' ? { t: '끝남', c: 'done' } : p.status_category === 'unstarted' ? { t: '시작 전', c: 'todo' } : { t: '진행 중', c: 'run' };
    // ⚠ 주소의 id 는 **박스 id 일 수도, 중앙 기록 uuid 일 수도** 있다(main.ts findSess 와 같은 사정).
    //  얼굴 줄도 공유도 축은 박스 id 다(열람 도장이 그 id 로 찍힌다) — 여기서 한 번 맞춰 두면 둘 다 바로 선다.
    const doorRow = boxRow(curSession());
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
          loose ? null : el('span', { class: 'pn-state ' + st.c, text: st.t }))),
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
    const cancel = (): void => { if (closed) return; closed = true; paintDoor(); };
    const save = async (): Promise<void> => {
      if (closed) return;
      const to = input.value.replace(/\s+/g, ' ').trim();
      if (!to || to === cur) { cancel(); return; }
      closed = true; input.disabled = true;
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

  return {
    newSession,
    repaintDoor(): void { paintDoor(); },
    destroy(): void {
      wrap.removeEventListener('pn:open-web', onOpenWeb);
      wrap.removeEventListener(VIEWER_EVT, onOpenViewer);
      window.removeEventListener('message', onMsg);
      dead = true;
      offViewers();
      window.removeEventListener('pn:sessions-view', onViewChanged);
      window.clearInterval(timer);
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
