// projects/session-list.ts — 프로젝트 보드의 「리스트」 뷰(#4865, 원준 2026-10-17 · 2판 2026-10-19).
//  «리스트 뷰를 새로 신설 — 세션 목록 참고해서, 세션 목록이랑 같은 내용과 형식의 뷰이되 화면 자체는 프로젝트 화면과 통일성 있게. 디폴트를 리스트뷰로.»
//  2판(원준 2026-10-19 «진행상태 아이콘 계속 띄워주고 같은거 두 줄씩 보이고 너무 별로 · 엄청 깨져 있어 · 세션목록 앱 참고해서 제대로»):
//   1판은 세션 목록을 **비슷하게 따로** 그렸다(프로젝트 표의 묶음 머리 + 묶음마다 상태 동그라미). 이제 표는 [세션 목록] 앱과
//   **같은 함수**(v2/sess-table.ts sessTable)가 그리고, 거르개 줄도 같은 것(sessFilterPicks)이다. 기본 묶기도 세션 목록과 같은 «시간».
//   · 무엇을: 지금 스코프(리스트 · 폴더 · 전체) 안 프로젝트들의 **세션**. 열 = 세션 · 프로젝트 · 상태 · 사람 · 생성 시각 · 마지막 활동.
//   · 위 세 층(브레드크럼 · 뷰 탭 · 툴바)은 보드 것. 「그룹」 단추가 세션 묶기 기준을 고르고, 툴바 검색이 세션 이름 · 프로젝트 이름에 걸린다.
//   · 재료: 셸과 **같은 함수**(v2/sess-merge.ts mergeSessions)로 라이브 + 기록을 한 목록으로 접는다. 거르기 · 묶기 · 정렬 잣대는 lib/sess-all.ts.
//  ⚠ 툴바의 프로젝트 전용 단추(하위 태스크 · 컬럼 · 필터 · 완료 · 담당자 · 나)는 이 뷰에서 숨는다(CSS .pjv-sess-mode).
import { api, currentWorkspace, el, loadPeopleAvatars, personDisplayName, state } from '../core.js';
import { cacheGet, cacheSet } from '../lib/idb-cache.js';   // «지난 판» 먼저 그리기(보드와 같은 보관함)
import { isMineSess, mergeSessions, sessWork, type Sess } from '../v2/sess-merge.js';
import { SESS_TABLE_PAGE, sessFilterPicks, sessTable, type SessTableItem, type SessTableUi } from '../v2/sess-table.js';
import { sessNameFace } from '../lib/sess-name.js';
import { NO_PROJECT_NAME, isCollectSessRow, isSpentLoginSess } from '../lib/proj-none.js';
import { isTrySessionRow } from '../lib/builder-flow.js';
import { type PastPeriod } from '../lib/past-sess.js';
import { DAY_BUCKETS, ownerCounts, selectAllSess, type SessGroupBy } from '../lib/sess-all.js';
import { SESS_STATES, sessIsDead } from '../session-status.js';
import { countMyLiveSessions } from '../lib/board-view.js';
import { enterSession, openRouteRow } from './detail-hub-kit.js';
import { pjvPopover } from './popover.js';

const PAGE = SESS_TABLE_PAGE;
// 세션 목록 화면과 같은 두 축(main.ts loadData) — 기록은 서버 상한(2000)까지 한 번에. 실측 384건 · 0.2MB.
const LIVE_URL = '/api/ui/terminal/sessions?includeProjects=1';
const LOGS_URL = '/api/ui/v6/sessions?limit=2000';

// ── 묶기 기준 — 세션 목록 사이드바의 기준(시간 · 상태 · 사람 · 묶지 않음)에 «프로젝트»를 더한 것. 기본은 세션 목록과 같은 «시간». ──
const GROUP_BYS: ReadonlyArray<{ key: SessGroupBy; label: string }> = [
  { key: 'day', label: '시간' }, { key: 'project', label: '프로젝트' }, { key: 'state', label: '상태' }, { key: 'owner', label: '사람' },
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

// ── 「그룹」 단추 — 이 뷰에서는 세션 묶기 기준 ──
export function pjvSessGroupLabel(): string { return (GROUP_BYS.find((g) => g.key === ui.by) || GROUP_BYS[0]).label; }
export function pjvSessGroupMenu(anchor: HTMLElement, onChange: () => void): void {
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  menu.append(el('div', { class: 'pjv-closed-pop-head', text: '세션 묶기' }));
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

interface Item extends SessTableItem { proj: any | null }

export interface SessListCtx {
  /** 이 스코프의 프로젝트(툴바 좁히기 전 — 세션을 좁히는 것은 이 뷰의 거르개와 검색이다). */
  projects: any[];
  /** 지금 스코프 키(L<id> · F<id> · __none__ · __all__) — 바뀌면 [더 보기]를 처음부터. */
  scopeKey: string;
  /** 툴바 검색어 — 세션 이름 · 프로젝트 이름에 건다. */
  query: string;
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
  const projById = new Map<number, any>(ctx.projects.map((p) => [Number(p.id), p]));
  const projName = (pid: number | null | undefined): string => { const p = pid != null ? projById.get(Number(pid)) : null; return p ? String(p.name || '') : ''; };
  const meId = String((state.me && state.me.userId) || '');
  const ownerName = (k: string): string => (k === 'me' ? '나' : personDisplayName(k) || k || '알 수 없음');
  const items: Item[] = [];
  for (const s of all) {
    if (s.projectId == null || !projById.has(Number(s.projectId))) continue;   // 이 스코프의 프로젝트에 붙은 세션만
    const t = sessNameFace({ label: s.label, work: sessWork(s), harness: s.raw && s.raw.harness, human: !!s.raw && s.raw.labelSource === 'human' }, projName(s.projectId));
    items.push({ s, projectId: s.projectId, trashedAt: s.trashedAt || null, lastSeen: s.lastSeen, stateKey: s.stateKey,
      owner: isMineSess(s) ? 'me' : String((s.raw && s.raw.owner) || ''), name: t.main || s.label || s.id, untitled: t.untitled,
      proj: projById.get(Number(s.projectId)) || null });
  }
  const q = { proj: null, group: null, period: ui.period, owner: ui.owner, state: ui.state, now };
  const inScope = selectAllSess(items, { ...q, period: 'all', owner: '', state: '' });
  const needle = ctx.query.trim().toLowerCase();
  const vis = selectAllSess(items, q).filter((it) => !needle || it.name.toLowerCase().includes(needle) || projName(it.projectId).toLowerCase().includes(needle));
  const byState = (k: string): number => inScope.filter((it) => it.owner === 'me' && it.stateKey === k).length;

  //  거르개 줄 — [세션 목록] 앱 도구줄과 같은 부품(기간 · 사람 · 상태 칩) + 오른쪽에 개수.
  const picks = sessFilterPicks(ui, { owners: ownerCounts(items, q), ownerName, myStateCount: byState, repaint });
  const tools = el('div', { class: 'v2-sa-tools pjv-sl-tools' }, ...picks.filter((x): x is HTMLElement => !!x), el('span', { class: 'sp' }),
    el('span', { class: 'pjv-sl-count', text: vis.length === inScope.length ? `세션 ${inScope.length}개` : `${vis.length}개 표시 · 전체 ${inScope.length}` }));
  const by = ui.by;
  const groupLabel = (key: string): string => by === 'project' ? (projName(Number(key)) || NO_PROJECT_NAME)
    : by === 'owner' ? ownerName(key)
    : by === 'state' ? ((SESS_STATES[key] && SESS_STATES[key].label) || (key === 'log' ? '기록' : key || '상태 모름'))
    : (DAY_BUCKETS as readonly string[]).includes(key) ? key : key;
  const { list, more } = sessTable({
    vis, by, ui, now, cols: by !== 'project', meId, projName, ownerName, groupLabel, repaint,
    open: (s) => enterSession({ id: s.id, label: s.label, node: s.node ? { id: s.node } : null }),
    menuRows: (it) => [
      openRouteRow('새 탭에서 열기', '#/s/' + encodeURIComponent(it.s.id)),
      ...(it.proj ? [{ label: '프로젝트 열기', icon: 'doc', run: () => { location.hash = '#/projects2/p/' + it.proj.id; } }] : []),
    ],
  });
  const empty = !inScope.length
    ? (ctx.projects.length ? '이 범위의 프로젝트에서 연 세션이 아직 없습니다.' : '이 범위에 프로젝트가 없습니다.')
    : '이 조건에 맞는 세션이 없습니다. 기간 · 사람 · 상태 · 검색어를 바꿔 보세요.';
  host.replaceChildren(...[tools, list, more, !vis.length ? el('p', { class: 'v2-bin-empty', text: empty }) : null].filter((x): x is HTMLElement => !!x));
}
