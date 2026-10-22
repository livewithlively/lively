// projects/session-list.ts — 프로젝트 보드의 「리스트」 뷰(#4865, 원준 2026-10-17 · 2판 2026-10-19).
//  «리스트 뷰를 새로 신설 — 세션 목록 참고해서, 세션 목록이랑 같은 내용과 형식의 뷰이되 화면 자체는 프로젝트 화면과 통일성 있게. 디폴트를 리스트뷰로.»
//  2판(원준 2026-10-19 «진행상태 아이콘 계속 띄워주고 같은거 두 줄씩 보이고 너무 별로 · 엄청 깨져 있어 · 세션목록 앱 참고해서 제대로»):
//   1판은 세션 목록을 **비슷하게 따로** 그렸다(프로젝트 표의 묶음 머리 + 묶음마다 상태 동그라미). 이제 표는 [세션 목록] 앱과
//   **같은 함수**(v2/sess-table.ts sessTable)가 그리고, 거르개 줄도 같은 것(sessFilterPicks)이다. 기본 묶기도 세션 목록과 같은 «시간».
//   · 무엇을: 지금 스코프(리스트 · 폴더 · 전체) 안 프로젝트들의 **세션**. 열 = 세션 · 프로젝트 · 상태 · 사람 · 생성 시각 · 마지막 활동.
//   · 위 세 층(브레드크럼 · 뷰 탭 · 툴바)은 보드 것. 「그룹」 단추가 세션 묶기 기준을 고르고, 툴바 검색이 세션 이름 · 프로젝트 이름에 걸린다.
//   · 재료: 셸과 **같은 함수**(v2/sess-merge.ts mergeSessions)로 라이브 + 기록을 한 목록으로 접는다. 거르기 · 묶기 · 정렬 잣대는 lib/sess-all.ts.
//  4판(원준 2026-10-21 «프로젝트 탭인데 세션마다 한 행을 구성하게 하면 안되지, 이러면 세션 목록 탭하고 다를 게 없잖아» —
//   그 앞 3판은 «윤상민이 만든 프로젝트는 왜 안 보여 · 프로젝트는 리스트에서 모두가 다 볼 수 있었으면» 에 세션 없는 프로젝트만 더했다):
//   **한 줄 = 프로젝트 하나.** 스코프 안 프로젝트는 세션이 보이든 말든 전부 선다(휴지통 · 보관 뺌).
//   열 = 프로젝트 · 세션(내가 볼 수 있는 세션 중 가장 급한 상태 + 나머지 수) · 상태(프로젝트 상태) · 사람(만든 사람) · 생성 시각 · 마지막 활동.
//   마지막 활동은 프로젝트 수정과 그 안 세션 활동 중 늦은 것. 표의 겉(열 머리 · 묶음 · 46px 행 · 더 보기)은 [세션 목록] 앱과 같은 sessTable.
//   묶기 = 시간 · 리스트 · 상태 · 사람 · 묶지 않음. 상태 칩(확인 필요 · 작업 중)은 «내 세션이 그 상태인 프로젝트» 를 남긴다.
//  ⚠ 툴바의 프로젝트 전용 단추(하위 태스크 · 컬럼 · 필터 · 담당자 · 나)는 이 뷰에서 숨는다(CSS .pjv-sess-mode). [완료 표시]는 4판부터 보인다(줄이 프로젝트라).
import { api, currentWorkspace, el, loadPeopleAvatars, personDisplayName, state } from '../core.js';
import { cacheGet, cacheSet } from '../lib/idb-cache.js';   // «지난 판» 먼저 그리기(보드와 같은 보관함)
import { isMineSess, mergeSessions, type Sess } from '../v2/sess-merge.js';
import { SESS_TABLE_PAGE, sessFilterPicks, sessTable, stateRank, type SessTableItem, type SessTableUi } from '../v2/sess-table.js';
import { isCollectSessRow, isSpentLoginSess } from '../lib/proj-none.js';
import { isTrySessionRow } from '../lib/builder-flow.js';
import { type PastPeriod } from '../lib/past-sess.js';
import { ownerCounts, selectAllSess, type SessGroupBy } from '../lib/sess-all.js';
import { sessIsDead } from '../session-status.js';
import { countMyLiveSessions } from '../lib/board-view.js';
import { enterSession, openRouteRow } from './detail-hub-kit.js';
import { pjvProjStatusMeta, pjvResolveProjStatus } from './status.js';
import { pjvProjClosedView } from './state.js';
import { pjvPopover } from './popover.js';

const PAGE = SESS_TABLE_PAGE;
// 세션 목록 화면과 같은 두 축(main.ts loadData) — 기록은 서버 상한(2000)까지 한 번에. 실측 384건 · 0.2MB.
const LIVE_URL = '/api/ui/terminal/sessions?includeProjects=1';
const LOGS_URL = '/api/ui/v6/sessions?limit=2000';

// ── 묶기 기준 — 세션 목록 사이드바와 같은 축(시간 · 리스트 · 사람 · 상태 · 묶지 않음). 줄이 프로젝트라 «프로젝트» 묶기는 없다. 기본 «시간». ──
const GROUP_BYS: ReadonlyArray<{ key: SessGroupBy; label: string }> = [
  { key: 'day', label: '시간' }, { key: 'list', label: '리스트' }, { key: 'state', label: '상태' }, { key: 'owner', label: '사람' },
  { key: 'none', label: '묶지 않음' },
];
//  2판에서 기본을 바꿨으므로 기억 열쇠도 바꾼다 — 1판 기본(프로젝트)이 기억으로 남아 새 기본을 가리지 않게.
const GROUP_STORE = 'pjv:sessGroupBy2';
function loadGroupBy(): SessGroupBy {
  try { const v = localStorage.getItem(GROUP_STORE); if (v && GROUP_BYS.some((g) => g.key === v)) return v as SessGroupBy; } catch (_) { /* 못 읽으면 기본 */ }
  return 'day';
}

/** 화면 상태 — 보드가 통째로 다시 그려도 고른 것이 남게 모듈 수준(세션 목록 allUi 와 같은 이유). 기간 · 사람 · 상태는 기억하지 않는다(페이지 수명). */
const ui: SessTableUi & { period: PastPeriod; owner: string; state: string; by: SessGroupBy; scopeKey: string } = {
  period: 'all', owner: '', state: '',
  by: loadGroupBy(),
  sort: null,
  shown: PAGE,
  scopeKey: '',
  closed: new Set<string>(), openUntitled: new Set<string>(),
};

//  재료는 **보드 한 판 동안** 쥔다 — 보드 진입·다시 받기(pjvPrefetchSessions)만 새로 받는다. 검색 · 묶기 · 스코프 전환 같은 다시 그리기마다
//  받으면 «불러오는 중» 이 번쩍이고 보던 자리를 잃는다(격리 리뷰 지적 — 종전엔 15초 수명이라 그 뒤 다시 그릴 때마다 받았다).
let liveP: Promise<any[]> | null = null;
let cache: Promise<Sess[]> | null = null;
/** 지금 쥔 판이 다 받아졌으면 그 목록(동기로 바로 그린다 — «불러오는 중» 이 번쩍이지 않게). */
let ready: { p: Promise<Sess[]>; all: Sess[] } | null = null;
//  보관함 열쇠 — 보드와 같은 규칙(사람 · 워크스페이스). 모르면 쓰지 않는다.
const sessCacheKey = (): string | null => {
  const me = String((state.me && (state.me.userId || state.me.email)) || '');
  return me ? 'projects-sessions:v1:' + (currentWorkspace() || '-') + ':' + me : null;
};
function fetchSessions(): void {
  const lp = api(LIVE_URL).then((d: any) => (d && d.sessions) || []);
  const p = Promise.all([
    lp,
    api(LOGS_URL).then((d: any) => (d && d.sessions) || []).catch(() => []),
    loadPeopleAvatars().catch(() => null),   // 사람 이름 — 첫 그림에 id 대신 이름이 서게
  ]).then(([live, logs]) => mergeSessions(live, logs)
    .filter((s) => !isSpentLoginSess(s.raw, s.live && s.alive) && !isCollectSessRow(s.raw) && !isTrySessionRow(s)));
  liveP = lp; cache = p;
  void p.then((all) => {
    ready = { p, all };
    const k = sessCacheKey();
    if (k) void cacheSet(k, all);
  }).catch(() => null);
  //  실패한 판은 쥐지 않는다 — 다음에 그릴 때 다시 받는다.
  lp.catch(() => { if (liveP === lp) liveP = null; });
  p.catch(() => { if (cache === p) cache = null; });
}
/** 세션 재료 — 라이브 + 기록을 셸과 같은 규칙으로 접고, 셸이 목록에 세우지 않는 것(끝난 로그인 · 수집 실행 · 앱 시험)은 뺀다(main.ts loadData). */
function loadSessions(): Promise<Sess[]> {
  if (!cache) fetchSessions();
  return cache!;
}
/** 보드 진입(다시 받기 포함) 때 새로 출발시킨다 — 프로젝트 목록을 기다리는 동안 세션도 받아 두면 기본 뷰(리스트)가 곧바로 선다. */
export function pjvPrefetchSessions(): void { fetchSessions(); }
/** 프로젝트별 «내 세션» 수 — 보드 「내 세션」 칸(rows.ts pjvProjSessionCell)의 재료. 종전엔 서버 mine=1 이 tmux 목록을 한 번 더 훑어
 *  붙여 줬다(projects-v6 project_list_v6 — 내가 주인이고 projectId 가 있는 세션 행). 여기선 **라이브 목록 행만** 센다 — 기록 · 이름 접기를
 *  기다리지 않으니 칸반 · 표 같은 다른 뷰의 첫 그림도 이 셈 때문에 늦지 않다(#4865 — mine=1 은 첫 화면의 가장 느린 줄이었다, 실측 0.6초).
 *  살아 있는 행만 센다(칸의 뜻이 «지금 내 세션이 있나» 다).
 *  못 받으면 빈 셈(칸이 «없음»으로 선다 — 종전 실패 때와 같다). */
export function pjvMySessionCounts(): Promise<Map<number, number>> {
  if (!liveP) fetchSessions();
  const now = Date.now();
  return liveP!.then((rows) => countMyLiveSessions(rows.map((r: any) => ({
    live: true, alive: r.observed === false ? false : !sessIsDead(r, now), owned: !!r.owned, projectId: r.projectId ? Number(r.projectId) : null,
  })))).catch(() => new Map<number, number>());
}

// ── 「그룹」 단추 — 이 뷰의 묶기 기준 ──
export function pjvSessGroupLabel(): string { return (GROUP_BYS.find((g) => g.key === ui.by) || GROUP_BYS[0]).label; }
export function pjvSessGroupMenu(anchor: HTMLElement, onChange: () => void): void {
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  menu.append(el('div', { class: 'pjv-closed-pop-head', text: '묶기' }));
  for (const g of GROUP_BYS) {
    const on = ui.by === g.key;
    const it = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' },
      el('span', { text: g.label }), el('span', { class: 'pjv-menu-check', text: on ? '✓' : '' }));
    it.onclick = (e: Event) => {
      e.stopPropagation(); close();
      if (on) return;
      ui.by = g.key; ui.shown = PAGE;
      try { localStorage.setItem(GROUP_STORE, g.key); } catch (_) { /* 저장 못 해도 이번 화면엔 반영 */ }
      onChange();
    };
    menu.append(it);
  }
}

/** 표의 한 줄 = 프로젝트 하나. top: 내가 볼 수 있는 세션 중 가장 급한 것(⋯ 메뉴 «가장 급한 세션 열기»). mine: 내 세션들의 상태(상태 칩). */
interface Item extends SessTableItem { proj: any; top: Sess | null; mine: Set<string> }
/** 「상태」 열 정렬 순위 — 할 일 → 진행 중 → 완료(pjvProjStatusMeta 의 key). */
const PROJ_RANK: Record<string, number> = { todo: 0, in_progress: 1, done: 2 };

export interface SessListCtx {
  /** 이 스코프의 프로젝트(툴바 좁히기 전 — 세션을 좁히는 것은 이 뷰의 거르개와 검색이다). */
  projects: any[];
  /** 지금 스코프 키(L<id> · F<id> · __none__ · __all__) — 바뀌면 [더 보기]를 처음부터. */
  scopeKey: string;
  /** 툴바 검색어 — 프로젝트 이름에 건다. */
  query: string;
  /** 리스트들 — 「리스트」 로 묶을 때 묶음 이름. */
  lists?: any[];
}

/** 리스트 뷰 한 장 — 세션을 받는 동안 «불러오는 중»을 세우고, 받으면 제자리에 그린다. 이 뷰 안의 조작(기간 · 정렬 · 접기)은 이 자리만 다시 그린다. */
export function pjvSessionListView(ctx: SessListCtx): HTMLElement {
  const host = el('div', { class: 'pjv-sl' });
  if (ui.scopeKey !== ctx.scopeKey) { ui.scopeKey = ctx.scopeKey; ui.shown = PAGE; }
  const paintWith = (all: Sess[]): void => { const paint = (): void => paintList(host, all, ctx, paint); paint(); };
  const p = loadSessions();
  //  이번 판이 이미 다 받아졌으면 바로 그린다(스코프 전환 · 검색 · 묶기처럼 보드가 통째로 다시 그리는 경우).
  if (ready && ready.p === p) { paintWith(ready.all); return host; }
  //  아직이면 — 보관함의 «지난 판» 을 먼저 그리고, 새 판이 오면 그것으로 바꿔 그린다(#4865 «불러오는 중» 이 오래 서 있던 것).
  host.append(el('p', { class: 'v2-bin-empty', text: '세션을 불러오는 중' }));
  let freshDone = false;
  const k = sessCacheKey();
  if (k) void cacheGet<Sess[]>(k).then((c) => { if (!freshDone && c && Array.isArray(c.v)) paintWith(c.v); });
  p.then((all) => { freshDone = true; paintWith(all); }).catch((e: any) => {
    freshDone = true;
    if (host.querySelector('.v2-sa-list')) return;   // 지난 판이 서 있다 — 그 화면을 오류로 덮지 않는다
    host.replaceChildren(el('p', { class: 'v2-bin-empty', text: '세션을 불러오지 못했습니다 — ' + ((e && e.message) || e) }));
  });
  return host;
}

function paintList(host: HTMLElement, all: Sess[], ctx: SessListCtx, repaint: () => void): void {
  const now = Date.now();
  const meId = String((state.me && state.me.userId) || '');
  const ownerName = (k: string): string => (k === 'me' ? '나' : personDisplayName(k) || k || '알 수 없음');
  const listName = new Map<number, string>((ctx.lists || []).map((l) => [Number(l.id), String(l.name || '')]));
  //  프로젝트마다 내가 볼 수 있는 세션(휴지통 뺌) — 「세션」 칸 · 마지막 활동 · 상태 칩의 재료.
  const sessOf = new Map<number, Sess[]>();
  for (const s of all) {
    if (s.projectId == null || s.trashedAt) continue;
    const k = Number(s.projectId); const a = sessOf.get(k); if (a) a.push(s); else sessOf.set(k, [s]);
  }
  const items: Item[] = [];
  for (const p of ctx.projects) {
    if (p.trashed_at || p.archived_at) continue;   // 휴지통 · 보관은 보드도 세우지 않는다
    if (p.status === 'done' && !pjvProjClosedView.done) continue;   // 완료는 툴바 [완료 표시]를 켤 때만 — 사이드바 · 다른 뷰의 수와 같은 자
    const id = Number(p.id);
    const ss = (sessOf.get(id) || []).slice().sort((x, y) => stateRank(x.stateKey) - stateRank(y.stateKey) || (Number(y.lastSeen) || 0) - (Number(x.lastSeen) || 0));
    const top = ss[0] || null;
    const st = pjvResolveProjStatus(p);
    const meta = pjvProjStatusMeta(p.status);
    const made = Date.parse(p.created_at || '') || 0;
    const owner = String(p.created_by || '');
    //  마지막 활동 = 프로젝트 수정과 그 안 세션 활동 중 늦은 것(세션만 돌고 프로젝트는 그대로인 날도 «오늘» 에 선다).
    const seen = Math.max(Date.parse(p.updated_at || '') || made, ...ss.map((x) => Number(x.lastSeen) || 0));
    items.push({
      s: { id: 'proj:' + id, label: String(p.name || ''), projectId: id, node: null, live: false, alive: false, owned: false,
        stateKey: '', stateLabel: '', lastSeen: 0, raw: null },
      pj: { id, status: st ? String(st.label || '') : meta.label, made, rank: PROJ_RANK[meta.key] ?? 9,
        sess: { n: ss.length, key: top ? top.stateKey : '', label: top ? top.stateLabel : '' } },
      projectId: id, listId: p.list_id != null ? Number(p.list_id) : null, trashedAt: null, lastSeen: seen,
      stateKey: 'p:' + (st ? String(st.label || '') : meta.label),
      owner: owner && owner === meId ? 'me' : owner, name: String(p.name || '') || '이름 없는 프로젝트', untitled: false, proj: p,
      top, mine: new Set(ss.filter((x) => isMineSess(x)).map((x) => x.stateKey)),
    });
  }
  //  상태 칩(확인 필요 · 작업 중)은 «내 세션이 그 상태인 프로젝트» 를 남긴다 — 줄의 stateKey 는 프로젝트 상태라 여기서 따로 건다.
  const q = { proj: null, group: null, period: ui.period, owner: ui.owner, state: '', now };
  const inScope = selectAllSess(items, { ...q, period: 'all', owner: '' });
  const needle = ctx.query.trim().toLowerCase();
  const vis = selectAllSess(items, q).filter((it) => (!ui.state || it.mine.has(ui.state)) && (!needle || it.name.toLowerCase().includes(needle)));
  const byState = (k: string): number => inScope.filter((it) => it.mine.has(k)).length;

  //  거르개 줄 — [세션 목록] 앱 도구줄과 같은 부품(기간 · 사람 · 상태 칩) + 오른쪽에 개수.
  const picks = sessFilterPicks(ui, { owners: ownerCounts(items, q), ownerName, myStateCount: byState, repaint });
  const tools = el('div', { class: 'v2-sa-tools pjv-sl-tools' }, ...picks.filter((x): x is HTMLElement => !!x), el('span', { class: 'sp' }),
    el('span', { class: 'pjv-sl-count', text: vis.length === inScope.length ? `프로젝트 ${inScope.length}개` : `${vis.length}개 표시 · 전체 ${inScope.length}` }));
  const by = ui.by;
  const groupLabel = (key: string): string => by === 'list' ? (listName.get(Number(key)) || '리스트 없음')
    : by === 'owner' ? ownerName(key)
    : by === 'state' ? key.replace(/^p:/, '') || '상태 모름'
    : key;
  const { list, more } = sessTable({
    vis, by, ui, now, cols: true, meId, projName: () => '', ownerName, groupLabel, repaint, nameHead: '프로젝트', projHead: '세션',
    open: () => { /* 세션 줄이 없다 */ },
    openProj: (it) => { location.hash = '#/projects2/p/' + it.pj!.id; },
    menuRows: (it) => [
      openRouteRow('새 탭에서 열기', '#/projects2/p/' + it.pj!.id),
      ...(it.top ? [{ label: '가장 급한 세션 열기', icon: 'open', run: () => { const t = it.top!; enterSession({ id: t.id, label: t.label, node: t.node ? { id: t.node } : null }); } }] : []),
    ],
  });
  const empty = !inScope.length ? '이 범위에 프로젝트가 없습니다.' : '이 조건에 맞는 프로젝트가 없습니다. 기간 · 사람 · 상태 · 검색어를 바꿔 보세요.';
  host.replaceChildren(...[tools, list, more, !vis.length ? el('p', { class: 'v2-bin-empty', text: empty }) : null].filter((x): x is HTMLElement => !!x));
}
