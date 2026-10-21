// v2/sess-table.ts — 세션 표 한 벌(#4865): [세션 목록] 앱(bins.ts renderSessAll)과 프로젝트 보드 「리스트」 뷰(projects/session-list.ts)가 같이 그린다.
//  원준 2026-10-19 «리스트 뷰는 세션목록 앱 참고해서 제대로» — 종전 보드는 비슷하게 **따로** 그려 진행 상태 아이콘이 묶음마다 서고 결이 깨졌다.
//  그래서 표를 bins.ts 에서 떼어 여기 두고 두 화면이 이 함수 하나를 부른다(클래스 · 열 · 정렬 · 접기 · 더 보기가 한 자).
//  ⚠ 이 모듈은 액자(클래식 ?embed=1) 문서에도 실린다 — 셸 화면 전체를 끄는 views.ts · side.ts 를 들이지 마라(sess-merge.ts 만).
//  ⚠ 거르기 · 묶기 · 정렬의 잣대는 lib/sess-all.ts(순수). 여기는 그리기만 한다.
import { el, personFace, relTime, sv } from '../core.js';
import { ICONS, projGlyph } from '../lib/icon-paths.js';   // #4233 — 프로젝트 = 과녁
import { PAST_PERIODS, type PastPeriod } from '../lib/past-sess.js';
import { groupAllSess, nextSessSort, sortAllSess, type AllSessLike, type SessGroupBy, type SessSort, type SessSortKey } from '../lib/sess-all.js';
import { NO_PROJECT_NAME } from '../lib/proj-none.js';
import { SESS_STATES } from '../session-status.js';
import { showCtxMenu, type CtxRow } from './ctx-menu.js';
import { dotCls, type Sess } from './sess-merge.js';

/** 표의 한 줄 — 거르기 잣대(AllSessLike) + 그릴 글. 부르는 쪽이 sessNameFace 로 이름을 정해 넘긴다. */
export interface SessTableItem extends AllSessLike {
  s: Sess; name: string; untitled: boolean;
  /** 세션이 아니라 **프로젝트 한 줄**(프로젝트 보드 리스트 뷰 — 내가 볼 세션이 없는 프로젝트도 목록에 선다, 원준 2026-10-21
   *  «프로젝트는 리스트에서 모두가 다 볼 수 있었으면»). 이 줄의 s 는 자리채움이다 — 표는 s 를 읽지 않고 이 값과 name · lastSeen 을 쓴다. */
  pj?: { id: number; status: string; made: number };
}
/** 표가 쥐는 화면 상태 — 부르는 쪽이 모듈 수준으로 들고 있다(통째로 다시 그려도 남게). */
export interface SessTableUi { shown: number; closed: Set<string>; openUntitled: Set<string>; sort: SessSort | null }
export const SESS_TABLE_PAGE = 50;

const BIN_PROJ_PX = 15;
export const projIcon = (has = true): SVGElement => sv('svg', { viewBox: '0 0 24 24', class: 'v2-bin-fold sm', 'aria-hidden': 'true' }, sv('path', { d: has ? ICONS[projGlyph(BIN_PROJ_PX)] : ICONS.projNone }));
export const sessIcon = (): SVGElement => sv('svg', { viewBox: '0 0 24 24', class: 'v2-bin-fold sm', 'aria-hidden': 'true' }, sv('path', { d: 'M4 5h16v11H8l-4 4z' }));
export const whenMs = (ms: number): string => (ms ? relTime(new Date(ms).toISOString()) : '');
const dot = (k: string): HTMLElement => el('span', { class: 'v2-dot ' + dotCls(k), 'aria-hidden': 'true' });

const HARNESS_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok', opencode: 'OpenCode', antigravity: 'Antigravity', shell: '셸' };
export const harnessName = (s: Sess): string => {
  const h = String((s.raw && s.raw.harness) || '').toLowerCase();
  return HARNESS_NAME[h] || (h ? h[0].toUpperCase() + h.slice(1) : '');
};
export const stateRank = (k: string): number => (SESS_STATES[k] ? SESS_STATES[k].rank : 99);
/** 상태 표시 — 눈에 띄어야 할 셋(확인 필요 · 작업 완료 · 작업 중)은 알약, 나머지는 점 + 흐린 글. */
function stateCell(s: Sess): HTMLElement {
  const k = s.stateKey;
  const label = s.stateLabel || '지난 세션';
  if (k === 'waiting' || k === 'done' || k === 'busy') return el('span', { class: 'v2-sa-st ' + dotCls(k) }, dot(k), el('span', { text: label }));
  return el('span', { class: 'v2-sa-st quiet' }, dot(k), el('span', { text: label }));
}
/** 「만든 때」 칸 — 오늘 것은 시:분, 그 밖은 월/일 시:분. **마지막 활동(상대 표기)과 눈으로 갈리게** 절대 시각으로 적는다
 *  (#4233, 원준 2026-09-26 «기존의 시각은 구분되게 이름 변경»). 모르면 빈 칸으로 둔다 — 「방금」 으로 꾸미지 않는다. */
function madeCell(ms: number): HTMLElement {
  if (!ms || !Number.isFinite(ms)) return el('span', { class: 'm none', text: '' });
  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return el('span', { class: 'm', text: sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`, title: d.toLocaleString() });
}
export const svgI = (d: string, cls = 'v2-sa-ic'): SVGElement => sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, sv('path', { d }));
export const IC_SEARCH = 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-4.3-4.3';
const IC_CHEV = 'M6 9l6 6 6-6';
const IC_UP = 'M18 15l-6-6-6 6';
const IC_MORE = 'M5 12h.01 M12 12h.01 M19 12h.01';
export const IC_PLUS = 'M12 5v14 M5 12h14';

// ── 도구줄의 거르개 셋 — 기간 · 사람 · 상태 칩. [세션 목록] 과 보드 리스트 뷰가 같은 것을 쓴다. ──
export interface SessPickUi { period: PastPeriod; owner: string; state: string }
export function sessFilterPicks(ui: SessPickUi & { shown: number }, o: {
  owners: Array<{ key: string; n: number }>;
  ownerName: (k: string) => string;
  /** 내 세션 중 그 상태 수(칩 숫자). */
  myStateCount: (k: string) => number;
  repaint: () => void;
}): Array<HTMLElement | null> {
  const period = el('select', { class: 'v2-sa-pick', 'aria-label': '기간', 'data-pick': 'period',
    onchange: (e: Event) => { ui.period = (e.target as HTMLSelectElement).value as PastPeriod; ui.shown = SESS_TABLE_PAGE; o.repaint(); } },
    ...PAST_PERIODS.map((p) => el('option', { value: p.key, text: p.label }))) as HTMLSelectElement;
  period.value = ui.period;
  const who = el('select', { class: 'v2-sa-pick', 'aria-label': '사람', 'data-pick': 'owner',
    onchange: (e: Event) => { ui.owner = (e.target as HTMLSelectElement).value; ui.shown = SESS_TABLE_PAGE; o.repaint(); } },
    el('option', { value: '', text: '모든 사람' }),
    ...o.owners.map((x) => el('option', { value: x.key, text: `${o.ownerName(x.key)} ${x.n}` }))) as HTMLSelectElement;
  who.value = ui.owner;
  const chip = (key: string, label: string, cls: string): HTMLElement | null => {
    const n = o.myStateCount(key);
    if (!n && ui.state !== key) return null;
    const on = ui.state === key;
    return el('button', { class: `v2-sa-chip ${cls}${on ? ' on' : ''}`, type: 'button', 'aria-pressed': String(on),
      title: on ? '거르기를 풉니다' : `내 세션 중 ${label}만 봅니다`,
      onclick: () => { ui.state = on ? '' : key; ui.shown = SESS_TABLE_PAGE; o.repaint(); } }, el('span', { text: `${label} ${n}` }));
  };
  return [period, who, chip('waiting', '확인 필요', 'warn'), chip('busy', '작업 중', 'blue')];
}

export interface SessTableOpts<T extends SessTableItem> {
  /** 이미 거른 줄(최근 순). */
  vis: T[];
  /** 묶는 기준 — 'none' 이면 묶음 머리 없이 한 목록. */
  by: SessGroupBy;
  ui: SessTableUi;
  now: number;
  /** 「프로젝트」 열을 둘까 — 한 프로젝트만 보는 자리면 겹치므로 뺀다. */
  cols: boolean;
  projName: (pid: number | null | undefined) => string;
  ownerName: (k: string) => string;
  groupLabel: (key: string) => string;
  meId: string;
  /** 줄을 누르면 연다. */
  open: (s: Sess) => void;
  /** 프로젝트 줄(it.pj)을 누르면 연다 — 프로젝트 줄을 넣는 쪽만 준다. */
  openProj?: (it: T) => void;
  /** 첫 열 머리 글 — 기본 「세션」. */
  nameHead?: string;
  /** ⋯ 메뉴의 줄 — 「세션 열기」 다음에 붙는다. */
  menuRows?: (it: T) => CtxRow[];
  /** 줄에 붙는 클래스 · 이름 뒤 꼬리표(예: 「치움」). */
  rowClass?: (it: T) => string;
  rowTag?: (it: T) => HTMLElement | null;
  repaint: () => void;
}

/** 세션 표 — 열 머리 한 줄(붙어 있음 · 누르면 정렬) + 묶음 머리(이름 · 개수 · 접기) + 46px 행 + «이름 없는 세션» 접기 + [더 보기].
 *  돌려주는 list 는 `.v2-sa-list`, more 는 [외 N개 더 보기](없으면 null). */
export function sessTable<T extends SessTableItem>(o: SessTableOpts<T>): { list: HTMLElement; more: HTMLElement | null } {
  const { ui, by, vis, cols } = o;
  //  열 머리는 **표 맨 위 한 줄**뿐이다(#4233, 원준 2026-09-26 «리스트별로 묶으면 묶음마다 열 제목이 화면 절반»).
  //   클릭업 리스트 뷰와 같게 머리를 하나만 두고 **붙여 둔다**(sticky). 묶음 머리줄은 이름과 개수만 든다.
  //  ★ 열 머리를 누르면 그 열로 정렬한다(원준 2026-09-27 «클릭업 참고»). 오름차순 → 내림차순 → 기본.
  //   ⚠ 묶는 기준은 **건드리지 않는다** — 묶음의 순서·구성은 그대로 두고 묶음 안 줄만 다시 센다.
  const hc = (key: SessSortKey, label: string): HTMLElement => {
    const on = ui.sort && ui.sort.key === key ? ui.sort : null;
    return el('button', { class: 'hc' + (on ? ' on' : ''), type: 'button',
      'aria-sort': on ? (on.dir === 'asc' ? 'ascending' : 'descending') : 'none',
      title: on ? (on.dir === 'asc' ? `${label} 오름차순 — 다시 누르면 내림차순` : `${label} 내림차순 — 다시 누르면 기본 순서로`) : `${label} 순으로 묶음 안 줄을 정렬합니다`,
      onclick: () => { ui.sort = nextSessSort(ui.sort, key); ui.shown = SESS_TABLE_PAGE; o.repaint(); } },
      el('span', { text: label }),
      on ? svgI(on.dir === 'asc' ? IC_UP : IC_CHEV, 'v2-sa-ic sm') : null);
  };
  const tableHead = (): HTMLElement => el('div', { class: 'v2-sa-head' + (cols ? '' : ' np') },
    hc('name', o.nameHead || '세션'),
    ...(cols ? [hc('proj', '프로젝트')] : []),
    hc('state', '상태'), hc('owner', '사람'),
    hc('made', '생성 시각'), hc('seen', '마지막 활동'), el('span', {}));
  const rowOf = (it: T): HTMLElement => (it.pj ? projRowOf(it, it.pj) : sessRowOf(it));
  //  프로젝트 줄 — 세션 줄과 같은 칸에 프로젝트 것을 넣는다: 이름(과녁) · 프로젝트 칸 비움(이름과 겹친다) · 상태 = 프로젝트 상태 · 사람 = 만든 사람.
  const projRowOf = (it: T, pj: NonNullable<SessTableItem['pj']>): HTMLElement => {
    const go = (): void => { if (o.openProj) o.openProj(it); };
    const href = '#/projects2/p/' + pj.id;
    const more = el('button', { class: 'v2-sa-more', type: 'button', 'aria-label': '더 보기', title: '열기 · 그 밖의 일',
      onclick: (ev: MouseEvent) => {
        ev.stopPropagation();
        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        showCtxMenu(r.right - 180, r.bottom + 4, [
          { label: '프로젝트 열기', icon: 'open', run: go },
          ...(o.menuRows ? o.menuRows(it) : []),
        ], { title: it.name });
      } }, svgI(IC_MORE));
    const row = el('div', { class: 'v2-sa-row pj' + (cols ? '' : ' np') + (o.rowClass ? o.rowClass(it) : ''),
      role: 'button', tabindex: '0', 'data-pid': String(pj.id) },
      el('div', { class: 'c-name' }, projIcon(true),
        el('a', { class: 't', href, text: it.name, onclick: (ev: MouseEvent) => { if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return; ev.preventDefault(); ev.stopPropagation(); go(); } }),
        o.rowTag ? o.rowTag(it) : null),
      cols ? el('div', { class: 'c-proj none' }) : null,
      el('div', { class: 'c-kind' }, el('span', { class: 'v2-sa-st quiet' }, el('span', { text: pj.status }))),
      el('div', { class: 'c-who' }, it.owner ? personFace(it.owner === 'me' ? o.meId : it.owner, 'v2-sall-face', o.ownerName(it.owner)) : null),
      el('div', { class: 'c-made' }, madeCell(pj.made)),
      el('div', { class: 'c-when' }, el('span', { class: 'm', text: whenMs(Number(it.lastSeen) || 0), title: it.lastSeen ? new Date(Number(it.lastSeen)).toLocaleString() : '' })),
      el('div', { class: 'c-acts' }, more));
    row.addEventListener('click', (ev) => { if ((ev.target as HTMLElement).closest('button, a, input, select')) return; go(); });
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target === row) { ev.preventDefault(); go(); } });
    return row;
  };
  const sessRowOf = (it: T): HTMLElement => {
    const s = it.s;
    //  ⌘/Ctrl/Shift+클릭은 브라우저 몫으로 둔다(새 창·새 탭) — 셸 안 링크의 관례(main.ts bindAltOpen 머리말)와 같다.
    const nameClick = (ev: MouseEvent): void => {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
      ev.preventDefault(); ev.stopPropagation(); o.open(s);
    };
    const more = el('button', { class: 'v2-sa-more', type: 'button', 'aria-label': '더 보기', title: '열기 · 그 밖의 일',
      onclick: (ev: MouseEvent) => {
        ev.stopPropagation();
        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        showCtxMenu(r.right - 180, r.bottom + 4, [
          { label: '세션 열기', icon: 'open', run: () => o.open(s) },
          ...(o.menuRows ? o.menuRows(it) : []),
        ], { title: it.untitled ? '이름 없는 세션' : it.name });
      } }, svgI(IC_MORE));
    const pn = o.projName(s.projectId);
    const row = el('div', { class: 'v2-sa-row' + (cols ? '' : ' np') + (o.rowClass ? o.rowClass(it) : ''),
      role: 'button', tabindex: '0', 'data-sid': s.id },
      el('div', { class: 'c-name' }, sessIcon(),
        el('a', { class: 't' + (it.untitled ? ' un' : ''), href: '#/s/' + encodeURIComponent(s.id), text: it.untitled ? `이름 없는 세션 · ${harnessName(s)}` : it.name, onclick: nameClick }),
        o.rowTag ? o.rowTag(it) : null),
      cols ? el('div', { class: 'c-proj' + (s.projectId ? '' : ' none') }, projIcon(!!s.projectId), el('span', { text: pn || NO_PROJECT_NAME })) : null,
      el('div', { class: 'c-kind' }, stateCell(s)),
      el('div', { class: 'c-who' }, personFace(it.owner === 'me' ? o.meId : it.owner, 'v2-sall-face', o.ownerName(it.owner))),
      el('div', { class: 'c-made' }, madeCell(Number(s.createdAt) || 0)),
      el('div', { class: 'c-when' }, el('span', { class: 'm', text: whenMs(Number(s.lastSeen) || 0), title: s.lastSeen ? new Date(Number(s.lastSeen)).toLocaleString() : '' })),
      el('div', { class: 'c-acts' }, more));
    //  #4233(원준 2026-09-26 «사이드 피크 개념 그냥 없애자») — 한 번 누르면 바로 그 세션을 연다.
    row.addEventListener('click', (ev) => { if ((ev.target as HTMLElement).closest('button, a, input, select')) return; o.open(s); });
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target === row) { ev.preventDefault(); o.open(s); } });
    return row;
  };
  const list = el('div', { class: 'v2-sa-list', 'aria-label': '세션 목록' });
  //  정렬이 읽는 값 — 표에 그려진 그 글자여야 사람이 «이 열 기준» 을 눈으로 확인할 수 있다.
  const sortFields = (it: T) => ({ name: it.name, proj: o.projName(it.projectId) || '', owner: o.ownerName(it.owner),
    rank: stateRank(String(it.stateKey || '')), made: it.pj ? it.pj.made : Number(it.s.createdAt) || 0, seen: Number(it.lastSeen) || 0 });
  const ordered = (rs: readonly T[]): T[] => sortAllSess(rs, ui.sort, sortFields);
  const groups = by === 'none' ? [] : groupAllSess(vis, by, o.now, stateRank);
  //  [더 보기]의 «외 N개» — 쪽수 때문에 못 그린 줄만 센다. 접은 묶음 · 접은 «이름 없는 세션» 은 더 보기로 나오지 않으니 빼고 센다.
  const reachable = by === 'none' ? vis.length : groups.reduce((n, g) => {
    const gk = `${by}:${g.key}`;
    if (ui.closed.has(gk)) return n;
    const un = g.rows.filter((it) => it.untitled).length;
    return n + (g.rows.length - un) + (ui.openUntitled.has(gk) ? un : 0);
  }, 0);
  let budget = ui.shown;
  let drawn = 0;
  //  묶지 않음 — 묶음 머리 없이 열 머리 한 줄, 이름 없는 세션도 접지 않고 전부 최근 순(«완전 raw 한 전체보기»).
  if (vis.length) list.append(tableHead());
  if (by === 'none' && vis.length) {
    for (const it of ordered(vis)) { if (budget-- <= 0) break; list.append(rowOf(it)); drawn++; }
  }
  for (const g of groups) {
    if (budget <= 0) break;
    const gk = `${by}:${g.key}`;
    const closed = ui.closed.has(gk);
    list.append(el('div', { class: 'v2-sa-gh plain' },
      el('button', { class: 'l', type: 'button', 'aria-expanded': String(!closed), onclick: () => { if (closed) ui.closed.delete(gk); else ui.closed.add(gk); o.repaint(); } },
        el('span', { class: 'car' + (closed ? ' shut' : '') }, svgI(IC_CHEV, 'v2-sa-ic sm')),
        el('span', { class: 'pill', text: o.groupLabel(g.key) }), el('span', { class: 'n', text: String(g.rows.length) }))));
    if (closed) continue;
    const rows = ordered(g.rows);
    const named = rows.filter((it) => !it.untitled);
    const unnamed = rows.filter((it) => it.untitled);
    for (const it of named) { if (budget-- <= 0) break; list.append(rowOf(it)); drawn++; }
    if (unnamed.length && budget > 0) {
      const uOpen = ui.openUntitled.has(gk);
      const hs = [...new Set(unnamed.map((it) => harnessName(it.s)).filter(Boolean))].join(' · ');
      list.append(el('button', { class: 'v2-sa-fold', type: 'button', 'aria-expanded': String(uOpen),
        onclick: () => { if (uOpen) ui.openUntitled.delete(gk); else ui.openUntitled.add(gk); o.repaint(); } },
        el('span', { class: 'car' + (uOpen ? '' : ' shut') }, svgI(IC_CHEV, 'v2-sa-ic sm')),
        el('span', { text: `이름 없는 세션 ${unnamed.length}개${hs ? ' · ' + hs : ''}` })));
      if (uOpen) for (const it of unnamed) { if (budget-- <= 0) break; list.append(rowOf(it)); drawn++; }
    }
  }
  const left = Math.max(0, reachable - drawn);
  const more = left > 0 ? el('button', { class: 'btn-text v2-bin-more', type: 'button', text: `외 ${left}개 더 보기`, onclick: () => { ui.shown += SESS_TABLE_PAGE; o.repaint(); } }) : null;
  return { list, more };
}
