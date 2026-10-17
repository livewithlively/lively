// projects/session-list.ts — 프로젝트 보드의 「리스트」 뷰(#4865, 원준 2026-10-17).
//  «리스트 뷰를 새로 신설 — 세션 목록 참고해서, 세션 목록이랑 같은 내용과 형식의 뷰이되 화면 자체는 프로젝트 화면과 통일성 있게. 디폴트를 리스트뷰로.»
//   · 무엇을: 지금 스코프(리스트 · 폴더 · 전체) 안 프로젝트들의 **세션**. 열은 세션 목록 화면(v2/bins.ts renderSessAll)과 같다 —
//     세션 · 프로젝트 · 상태 · 사람 · 생성 시각 · 마지막 활동. 열 머리를 누르면 정렬(오름 → 내림 → 기본), 묶음 안 줄만 다시 센다.
//   · 어떻게 보이나: 위 세 층(브레드크럼 · 뷰 탭 · 툴바)은 보드 것을 그대로 쓰고, 본문은 프로젝트 표의 묶음 머리(.pjv-tgroup-head)·행 결을 쓴다.
//     프로젝트로 묶으면 묶음 머리에 그 프로젝트의 상태 동그라미(진행 정도)가 선다 — 태스크 뷰의 행과 같은 부품(pjvProjStatusDot).
//   · 재료: 셸과 **같은 함수**(v2/sess-merge.ts mergeSessions)로 라이브 + 기록을 한 목록으로 접는다. 거르기 · 묶기 · 정렬의 잣대도
//     세션 목록과 한 벌(lib/sess-all.ts) — 두 화면이 같은 세션을 다르게 세지 않는다.
//  ⚠ 툴바의 프로젝트 전용 단추(하위 태스크 · 컬럼 · 필터 · 완료 · 담당자 · 나)는 이 뷰에서 숨는다(CSS .pjv-sess-mode). 세션을 좁히는 것은
//   이 뷰 맨 위 줄(기간 · 사람 · 상태)과 툴바의 검색(세션 이름 · 프로젝트 이름)이다. 「그룹」 단추는 이 뷰에선 세션 묶기 기준을 고른다.
import { api, el, loadPeopleAvatars, personDisplayName, personFace, relTime, state, sv } from '../core.js';
import { isMineSess, mergeSessions, sessWork, type Sess } from '../v2/sess-merge.js';
import { sessNameFace } from '../lib/sess-name.js';
import { NO_PROJECT_NAME, isCollectSessRow, isSpentLoginSess } from '../lib/proj-none.js';
import { isTrySessionRow } from '../lib/builder-flow.js';
import { PAST_PERIODS, type PastPeriod } from '../lib/past-sess.js';
import { groupAllSess, nextSessSort, ownerCounts, selectAllSess, sortAllSess, type AllSessLike, type SessGroupBy, type SessSort, type SessSortKey } from '../lib/sess-all.js';
import { SESS_STATES, sessIsDead } from '../session-status.js';
import { countMyLiveSessions } from '../lib/board-view.js';
import { enterSession } from './detail-hub-kit.js';
import { pjvPopover } from './popover.js';
import { pjvTbIcon } from './icons.js';

const PAGE = 50;
// 세션 목록 화면과 같은 두 축(main.ts loadData) — 기록은 서버 상한(2000)까지 한 번에. 실측 384건 · 0.2MB.
const LIVE_URL = '/api/ui/terminal/sessions?includeProjects=1';
const LOGS_URL = '/api/ui/v6/sessions?limit=2000';

// ── 묶기 기준 — 세션 목록 사이드바의 기준에 «프로젝트별»을 더한 것. 리스트 · 폴더 안에서는 프로젝트별이 기본이다. ──
const GROUP_BYS: ReadonlyArray<{ key: SessGroupBy; label: string }> = [
  { key: 'project', label: '프로젝트' }, { key: 'day', label: '시간' }, { key: 'state', label: '상태' }, { key: 'owner', label: '사람' },
  { key: 'none', label: '묶지 않음' },
];
const GROUP_STORE = 'pjv:sessGroupBy';
function loadGroupBy(): SessGroupBy {
  try { const v = localStorage.getItem(GROUP_STORE); if (v && GROUP_BYS.some((g) => g.key === v)) return v as SessGroupBy; } catch (_) { /* 못 읽으면 기본 */ }
  return 'project';
}

/** 화면 상태 — 보드가 통째로 다시 그려도 고른 것이 남게 모듈 수준(세션 목록 allUi 와 같은 이유). 기간 · 사람 · 상태는 기억하지 않는다(페이지 수명). */
const ui = {
  period: 'all' as PastPeriod, owner: '', state: '',
  by: loadGroupBy(),
  sort: null as SessSort | null,
  shown: PAGE,
  scopeKey: '',
  closed: new Set<string>(), openUntitled: new Set<string>(),
};

//  재료는 **보드 한 판 동안** 쥔다 — 보드 진입·다시 받기(pjvPrefetchSessions)만 새로 받는다. 검색 · 묶기 · 스코프 전환 같은 다시 그리기마다
//  받으면 «불러오는 중» 이 번쩍이고 보던 자리를 잃는다(격리 리뷰 지적 — 종전엔 15초 수명이라 그 뒤 다시 그릴 때마다 받았다).
let liveP: Promise<any[]> | null = null;
let cache: Promise<Sess[]> | null = null;
function fetchSessions(): void {
  const lp = api(LIVE_URL).then((d: any) => (d && d.sessions) || []);
  const p = Promise.all([
    lp,
    api(LOGS_URL).then((d: any) => (d && d.sessions) || []).catch(() => []),
    loadPeopleAvatars().catch(() => null),   // 사람 이름 — 첫 그림에 id 대신 이름이 서게
  ]).then(([live, logs]) => mergeSessions(live, logs)
    .filter((s) => !isSpentLoginSess(s.raw, s.live && s.alive) && !isCollectSessRow(s.raw) && !isTrySessionRow(s)));
  liveP = lp; cache = p;
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

interface Item extends AllSessLike { s: Sess; name: string; untitled: boolean; proj: any | null }

const HARNESS_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok', opencode: 'OpenCode', antigravity: 'Antigravity', shell: '셸' };
const harnessName = (s: Sess): string => {
  const h = String((s.raw && s.raw.harness) || '').toLowerCase();
  return HARNESS_NAME[h] || (h ? h[0].toUpperCase() + h.slice(1) : '');
};
const stateRank = (k: string): number => (SESS_STATES[k] ? SESS_STATES[k].rank : 99);
const whenMs = (ms: number): string => (ms ? relTime(new Date(ms).toISOString()) : '');
/** 「생성 시각」 — 오늘 것은 시:분, 그 밖은 월/일 시:분(세션 목록 madeCell 과 같은 자). 모르면 빈 칸. */
function madeText(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const t = new Date();
  const same = d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
  return same ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
/** 상태 칸 — 세션 목록과 같은 점(v2-dot) · 같은 말. 눈에 띄어야 할 셋(확인 필요 · 작업 완료 · 작업 중)만 진하게. */
function stateCell(s: Sess): HTMLElement {
  const k = s.stateKey;
  const cls = k === 'busy' ? 'busy' : k === 'waiting' ? 'wait' : k === 'done' ? 'done' : k === 'idle' ? 'idle' : k === 'offline' ? 'off' : k === 'shell' ? 'shell' : k === 'error' ? 'err' : '';
  const loud = k === 'waiting' || k === 'done' || k === 'busy';
  return el('span', { class: 'pjv-sl-st' + (loud ? ' loud ' + cls : '') }, el('span', { class: 'v2-dot ' + cls, 'aria-hidden': 'true' }), el('span', { text: s.stateLabel || '지난 세션' }));
}
const svgI = (d: string, cls = 'pjv-sl-ic'): SVGElement => sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, sv('path', { d }));
const IC_DOWN = 'M6 9l6 6 6-6';
const IC_UP = 'M18 15l-6-6-6 6';

export interface SessListCtx {
  /** 이 스코프의 프로젝트(툴바 좁히기 전 — 세션을 좁히는 것은 이 뷰의 줄과 검색이다). */
  projects: any[];
  /** 지금 스코프 키(L<id> · F<id> · __none__ · __all__) — 바뀌면 [더 보기]를 처음부터. */
  scopeKey: string;
  /** 툴바 검색어 — 세션 이름 · 프로젝트 이름에 건다. */
  query: string;
  /** 프로젝트 묶음 머리의 상태 동그라미(진행 정도) — 태스크 뷰 행과 같은 부품(rows.ts pjvProjStatusDot). 보드가 넘긴다:
   *  여기서 rows.ts 를 직접 들이면 배럴(projects.ts)을 되짚는 순환이 셋 생긴다(check-imports). */
  statusDot: (p: any) => HTMLElement;
}

/** 리스트 뷰 한 장 — 세션을 받는 동안 «불러오는 중»을 세우고, 받으면 제자리에 그린다. 이 뷰 안의 조작(기간 · 정렬 · 접기)은 이 자리만 다시 그린다. */
export function pjvSessionListView(ctx: SessListCtx): HTMLElement {
  const host = el('div', { class: 'pjv-sl' });
  if (ui.scopeKey !== ctx.scopeKey) { ui.scopeKey = ctx.scopeKey; ui.shown = PAGE; }
  host.append(el('div', { class: 'pjv-proj-empty', text: '세션을 불러오는 중' }));
  loadSessions().then((all) => {
    const paint = (): void => paintList(host, all, ctx, paint);
    paint();
  }).catch((e: any) => {
    host.replaceChildren(el('div', { class: 'pjv-proj-empty', text: '세션을 불러오지 못했습니다 — ' + ((e && e.message) || e) }));
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
    const pn = projName(s.projectId);
    const t = sessNameFace({ label: s.label, work: sessWork(s), harness: s.raw && s.raw.harness, human: !!s.raw && s.raw.labelSource === 'human' }, pn);
    items.push({ s, projectId: s.projectId, trashedAt: s.trashedAt || null, lastSeen: s.lastSeen, stateKey: s.stateKey,
      owner: isMineSess(s) ? 'me' : String((s.raw && s.raw.owner) || ''), name: t.main || s.label || s.id, untitled: t.untitled,
      proj: projById.get(Number(s.projectId)) || null });
  }
  const q = { proj: null, group: null, period: ui.period, owner: ui.owner, state: ui.state, now };
  const inScope = selectAllSess(items, { ...q, period: 'all', owner: '', state: '' });
  const needle = ctx.query.trim().toLowerCase();
  const vis = selectAllSess(items, q).filter((it) => !needle || it.name.toLowerCase().includes(needle) || projName(it.projectId).toLowerCase().includes(needle));
  const byState = (k: string): number => inScope.filter((it) => it.owner === 'me' && it.stateKey === k).length;

  // ── 이 뷰의 좁히기 줄 — 기간 · 사람 · 상태(내 세션 중 확인 필요 · 작업 중). 툴바 아래 한 줄, 툴바 단추와 같은 알약 결. ──
  const pick = (label: string, val: string, opts: Array<{ key: string; label: string }>, set: (v: string) => void): HTMLElement => {
    const cur = opts.find((o) => o.key === val) || opts[0];
    const b = el('button', { class: 'pjv-tb-btn pjv-tb-pill pjv-sl-pick' + (val ? ' active' : ''), type: 'button', title: label, 'aria-label': label },
      el('span', { class: 'pjv-view-btn-label', text: cur.label }), pjvTbIcon('caret', 'sm'));
    b.onclick = (e: Event) => {
      e.stopPropagation();
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(b, menu);
      for (const o of opts) {
        const on = o.key === val;
        const it = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' }, el('span', { text: o.label }), el('span', { class: 'pjv-menu-check', text: on ? '✓' : '' }));
        it.onclick = (ev: Event) => { ev.stopPropagation(); close(); if (!on) { set(o.key); ui.shown = PAGE; repaint(); } };
        menu.append(it);
      }
    };
    return b;
  };
  const periodPick = pick('기간', ui.period === 'all' ? '' : ui.period, PAST_PERIODS.map((p) => ({ key: p.key === 'all' ? '' : p.key, label: p.label })), (v) => { ui.period = (v || 'all') as PastPeriod; });
  const people = ownerCounts(items, q).map((o) => ({ key: o.key, label: `${ownerName(o.key)} ${o.n}` }));
  const whoPick = pick('사람', ui.owner, [{ key: '', label: '모든 사람' }, ...people], (v) => { ui.owner = v; });
  const chip = (key: string, label: string, cls: string): HTMLElement | null => {
    const n = byState(key);
    if (!n && ui.state !== key) return null;
    const on = ui.state === key;
    return el('button', { class: `pjv-tb-btn pjv-tb-pill pjv-sl-chip ${cls}${on ? ' active' : ''}`, type: 'button', 'aria-pressed': String(on),
      title: on ? '거르기를 풉니다' : `내 세션 중 ${label}만 봅니다`,
      onclick: () => { ui.state = on ? '' : key; ui.shown = PAGE; repaint(); } }, el('span', { class: 'v2-dot ' + cls, 'aria-hidden': 'true' }), el('span', { text: `${label} ${n}` }));
  };
  const tools = el('div', { class: 'pjv-sl-tools' }, periodPick, whoPick, chip('waiting', '확인 필요', 'wait'), chip('busy', '작업 중', 'busy'),
    el('span', { class: 'pjv-sl-sp' }),
    el('span', { class: 'pjv-sl-count', text: vis.length === inScope.length ? `세션 ${inScope.length}개` : `${vis.length}개 표시 · 전체 ${inScope.length}` }));

  // ── 표 — 열 머리 한 줄(붙어 있음) + 묶음 머리(프로젝트 표의 결) + 행 ──
  const by = ui.by;
  const cols = by !== 'project';   // 프로젝트로 묶으면 묶음 머리가 프로젝트를 말한다 — 프로젝트 열은 겹친다(세션 목록에서 프로젝트를 고른 때와 같다)
  const hc = (key: SessSortKey, label: string): HTMLElement => {
    const on = ui.sort && ui.sort.key === key ? ui.sort : null;
    return el('button', { class: 'pjv-sl-hc k-' + key + (on ? ' on' : ''), type: 'button',
      'aria-sort': on ? (on.dir === 'asc' ? 'ascending' : 'descending') : 'none',
      title: on ? (on.dir === 'asc' ? `${label} 오름차순 — 다시 누르면 내림차순` : `${label} 내림차순 — 다시 누르면 기본 순서로`) : `${label} 순으로 묶음 안 줄을 정렬합니다`,
      onclick: () => { ui.sort = nextSessSort(ui.sort, key); ui.shown = PAGE; repaint(); } },
      el('span', { text: label }), on ? svgI(on.dir === 'asc' ? IC_UP : IC_DOWN) : null);
  };
  const gridCls = cols ? '' : ' np';
  const head = el('div', { class: 'pjv-sl-head' + gridCls },
    hc('name', '세션'), ...(cols ? [hc('proj', '프로젝트')] : []), hc('state', '상태'), hc('owner', '사람'), hc('made', '생성 시각'), hc('seen', '마지막 활동'));

  const open = (s: Sess): void => enterSession({ id: s.id, label: s.label, node: s.node ? { id: s.node } : null });
  const rowOf = (it: Item): HTMLElement => {
    const s = it.s;
    const nameClick = (ev: MouseEvent): void => {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return;   // 새 탭 · 새 창은 브라우저 몫
      ev.preventDefault(); ev.stopPropagation(); open(s);
    };
    const row = el('div', { class: 'pjv-trow pjv-sl-row' + gridCls, role: 'button', tabindex: '0', 'data-sid': s.id },
      el('div', { class: 'pjv-trow-title-cell' },
        el('a', { class: 'pjv-trow-title pjv-sl-name' + (it.untitled ? ' un' : ''), href: '#/s/' + encodeURIComponent(s.id),
          title: it.untitled ? '' : it.name, text: it.untitled ? `이름 없는 세션 · ${harnessName(s)}` : it.name, onclick: nameClick })),
      cols ? el('div', { class: 'pjv-tcell pjv-sl-proj' + (it.proj ? '' : ' none'), title: projName(it.projectId) },
        el('span', { text: projName(it.projectId) || NO_PROJECT_NAME })) : null,
      el('div', { class: 'pjv-tcell' }, stateCell(s)),
      el('div', { class: 'pjv-tcell pjv-sl-who' }, personFace(it.owner === 'me' ? meId : it.owner, 'pjv-sl-face', ownerName(it.owner))),
      el('div', { class: 'pjv-tcell pjv-sl-m pjv-sl-made', title: s.createdAt ? new Date(Number(s.createdAt)).toLocaleString() : '', text: madeText(Number(s.createdAt) || 0) }),
      el('div', { class: 'pjv-tcell pjv-sl-m', title: s.lastSeen ? new Date(Number(s.lastSeen)).toLocaleString() : '', text: whenMs(Number(s.lastSeen) || 0) }));
    row.addEventListener('click', (ev) => { if ((ev.target as HTMLElement).closest('button, a, input, select')) return; open(s); });
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target === row) { ev.preventDefault(); open(s); } });
    return row;
  };
  const sortFields = (it: Item) => ({ name: it.name, proj: projName(it.projectId), owner: ownerName(String(it.owner)),
    rank: stateRank(String(it.stateKey || '')), made: Number(it.s.createdAt) || 0, seen: Number(it.lastSeen) || 0 });
  const ordered = (rs: readonly Item[]): Item[] => sortAllSess(rs, ui.sort, sortFields);
  const groupHead = (key: string, rows: Item[], gk: string, closed: boolean): HTMLElement => {
    const caret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: closed ? '▸' : '▾', 'aria-expanded': String(!closed), title: closed ? '펼치기' : '접기' });
    caret.onclick = (e: Event) => { e.stopPropagation(); if (closed) ui.closed.delete(gk); else ui.closed.add(gk); repaint(); };
    const n = el('span', { class: 'pjv-tgroup-count', text: String(rows.length) });
    if (by === 'project') {
      const p = projById.get(Number(key));
      if (p) {
        const name = el('span', { class: 'pjv-tgroup-label pjv-sl-gname clickable', title: p.name + ' — 프로젝트 열기', text: p.name });
        name.onclick = (e: Event) => { e.stopPropagation(); location.hash = '#/projects2/p/' + p.id; };
        return el('div', { class: 'pjv-tgroup-head pjv-sl-gh' }, ctx.statusDot(p), name, n, caret);
      }
    }
    const label = by === 'owner' ? ownerName(key) : by === 'state' ? ((SESS_STATES[key] && SESS_STATES[key].label) || (key === 'log' ? '기록' : key || '상태 모름')) : by === 'project' ? NO_PROJECT_NAME : key;
    return el('div', { class: 'pjv-tgroup-head pjv-sl-gh' }, el('span', { class: 'pjv-tgroup-label', text: label }), n, caret);
  };

  const list = el('div', { class: 'pjv-sl-list', 'aria-label': '세션 목록' });
  let budget = ui.shown;
  //  [더 보기]의 «외 N개» — 쪽수 때문에 못 그린 줄만 센다. 접은 묶음 · 접은 «이름 없는 세션» 줄은 더 보기로 나오지 않으니 빼고 센다.
  const groups = by === 'none' ? [] : groupAllSess(vis, by, now, stateRank);
  const reachable = by === 'none' ? vis.length : groups.reduce((n, g) => {
    const gk = `${by}:${g.key}`;
    if (ui.closed.has(gk)) return n;
    const un = g.rows.filter((it) => it.untitled).length;
    return n + (g.rows.length - un) + (ui.openUntitled.has(gk) ? un : 0);
  }, 0);
  let drawn = 0;
  if (vis.length) list.append(head);
  if (by === 'none' && vis.length) {
    const body = el('div', { class: 'pjv-tgroup-body' });
    for (const it of ordered(vis)) { if (budget-- <= 0) break; body.append(rowOf(it)); drawn++; }
    list.append(body);
  }
  for (const g of groups) {
    if (budget <= 0) break;
    const gk = `${by}:${g.key}`;
    const closed = ui.closed.has(gk);
    const grp = el('div', { class: 'pjv-tgroup pjv-sl-group' }, groupHead(g.key, g.rows, gk, closed));
    list.append(grp);
    if (closed) continue;
    const body = el('div', { class: 'pjv-tgroup-body' });
    grp.append(body);
    const rows = ordered(g.rows);
    const named = rows.filter((it) => !it.untitled);
    const unnamed = rows.filter((it) => it.untitled);
    for (const it of named) { if (budget-- <= 0) break; body.append(rowOf(it)); drawn++; }
    if (unnamed.length && budget > 0) {
      const uOpen = ui.openUntitled.has(gk);
      const hs = [...new Set(unnamed.map((it) => harnessName(it.s)).filter(Boolean))].join(' · ');
      body.append(el('button', { class: 'pjv-sl-fold', type: 'button', 'aria-expanded': String(uOpen),
        onclick: () => { if (uOpen) ui.openUntitled.delete(gk); else ui.openUntitled.add(gk); repaint(); } },
        el('span', { class: 'pjv-sl-fold-car', text: uOpen ? '▾' : '▸' }), el('span', { text: `이름 없는 세션 ${unnamed.length}개${hs ? ' · ' + hs : ''}` })));
      if (uOpen) for (const it of unnamed) { if (budget-- <= 0) break; body.append(rowOf(it)); drawn++; }
    }
  }
  const left = Math.max(0, reachable - drawn);
  const empty = !inScope.length
    ? (ctx.projects.length ? '이 범위의 프로젝트에서 연 세션이 아직 없습니다. 프로젝트를 열어 세션을 시작하세요.' : '이 범위에 프로젝트가 없습니다.')
    : '이 조건에 맞는 세션이 없습니다. 기간 · 사람 · 상태 · 검색어를 바꿔 보세요.';
  host.replaceChildren(tools, list,
    left > 0 ? el('button', { class: 'pjv-sl-more', type: 'button', text: `외 ${left}개 더 보기`, onclick: () => { ui.shown += PAGE; repaint(); } }) : null,
    !vis.length ? el('div', { class: 'pjv-proj-empty', text: empty }) : null);
}
