// context-runs.ts — [맥락 관리 ▸ 현황] 지도 아래 「자동 실행」 패널(#4172 → #4135 3판, 원준 2026-09-26 확정).
//
//  2판(A안): 오늘 하루의 모든 자동 실행을 시간 막대에 찍고 바뀐 실행을 모은다 — 지도의 수집기·증류기 칩이 거름 스위치.
//  3판(원준: "오늘 하루만 되고, 이전 날짜 지정 불가능하고, 기간도 하루로 너무 하드하게 픽스 … 자세히보기 같은 걸로 보면
//   페이지 하나 넘어가서 거기서는 그냥 목록으로"):
//   ① 머리줄 = ‹ 날짜 › (하루씩 · 기간 단위로) + 가운데 날짜를 누르면 달력 팝오버(모달 아님, 바로가기: 오늘·어제·최근 7일·최근 30일)
//   ② 기간 [하루 · 7일 · 30일] — 여러 날이면 날마다 점 하나(크기 = 그 기간 안에서 가장 바쁜 날 대비 √), 점을 누르면 그날 하루로
//   ③ 종류 거르기는 범례 자리로(머리줄이 붐비지 않게) — 지도 칩과 같은 스위치
//   ④ 「자세히 보기 →」 = #/context/runs(context-runs-page.ts) 로 같은 기간·거르기를 들고 간다. 줄·점을 누르면 그 실행을 연 채로.
//  데이터: 하루 = org_auto_runs(줄 단위) · 여러 날 = org_auto_runs_daily(날짜별 합계 + 최근 바뀐 실행 다섯). 다시 받는 동안은
//   옛 그림을 흐리게 둔다(자리가 튀지 않게).
import { api, el, relTime, sv } from './core.js';
import { presetSvcKey } from './svc-icons.js';
import { svcLogo } from './svc-logos.js';
import { icon as lineIcon } from './v2/icons.js';

export type RunKind = 'c' | 'd';
export type RunFilter = 'all' | RunKind;
export type Period = 'day' | 'week' | 'month';

export interface AutoRun {
  key: string; id: number; kind: RunKind; machineId: string; name: string;
  svc: string | null; glyph: string; t: number; ok: boolean; err: string | null;
  n: number; mo: number; read: number | null; dur: number | null; lane: 'source' | 'category' | null;
}
type KindAgg = { runs: number; failed: number; inserted: number; updated: number; read: number };
export interface DayAgg { day: number; c: KindAgg; d: KindAgg }
export interface Machine { id: string; kind: RunKind; name: string; svc: string | null }

export const DAY = 864e5;
const MIN = 6e4;
const REDUCE = (): boolean => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
export const changed = (r: AutoRun): boolean => !r.ok || r.n + r.mo > 0;
export const WD = ['일', '월', '화', '수', '목', '금', '토'];
export const hhmm = (t: number): string => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
export const md = (t: number): string => { const d = new Date(t); return (d.getMonth() + 1) + '월 ' + d.getDate() + '일'; };
export const mdw = (t: number): string => md(t) + ' (' + WD[new Date(t).getDay()] + ')';
export const sd = (t: number): string => { const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate(); };
export const dayOf = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const today0 = (): number => dayOf(Date.now());
/** 하루를 더하되 자정에 맞춘다(서머타임이 있는 곳에서도 날짜가 밀리지 않게). */
export const addDays = (d0: number, n: number): number => { const d = new Date(d0); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const relDay = (d0: number): string | null => (d0 === today0() ? '오늘' : d0 === addDays(today0(), -1) ? '어제' : null);
export const ymd = (t: number): string => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
export const parseYmd = (s: string | null | undefined): number | null => {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime(); return Number.isFinite(t) ? t : null;
};
export const KEEP_DAYS = 30;   // 화면이 보여 주는 범위(서버는 31일까지 받는다)
const tzName = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

// ── 데이터 ────────────────────────────────────────────────────────────────
export function toRun(x: any): AutoRun {
  const svc = x.kind === 'c' && x.system ? presetSvcKey(String(x.system)) : null;
  return {
    key: String(x.key), id: Number(x.id), kind: x.kind === 'd' ? 'd' : 'c', machineId: String(x.machine_id), name: String(x.name || ''),
    svc: svc && svcLogo(svc) ? svc : null, glyph: x.kind === 'd' ? (x.lane === 'category' ? 'layers' : 'wiki') : 'src',
    t: Date.parse(x.started_at), ok: x.status !== 'error' && x.status !== 'canceled', err: x.error || null,
    n: Number(x.inserted || 0), mo: Number(x.updated || 0), read: x.read == null ? null : Number(x.read),
    dur: x.duration_sec == null ? null : Number(x.duration_sec), lane: x.lane || null,
  };
}
/** 하루치 줄(0시~다음 0시). */
export async function fetchDay(d0: number): Promise<AutoRun[]> {
  const r: any = await api('/api/ui/org/auto-runs?' + new URLSearchParams({ since: new Date(d0).toISOString(), until: new Date(addDays(d0, 1)).toISOString() }));
  return ((r && r.runs) || []).map(toRun).filter((x: AutoRun) => Number.isFinite(x.t));
}
/** 여러 날 합계(from 0시 ~ to 다음 0시). */
export async function fetchDaily(from0: number, to0: number): Promise<{ days: DayAgg[]; machines: Machine[]; recent: AutoRun[] }> {
  const r: any = await api('/api/ui/org/auto-runs/daily?' + new URLSearchParams({ since: new Date(from0).toISOString(), until: new Date(addDays(to0, 1)).toISOString(), tz: tzName() }));
  const days: DayAgg[] = ((r && r.days) || []).map((x: any) => ({ day: parseYmd(x.day) ?? 0, c: x.c, d: x.d }));
  const machines: Machine[] = ((r && r.machines) || []).map((m: any) => {
    const svc = m.kind === 'c' && m.system ? presetSvcKey(String(m.system)) : null;
    return { id: String(m.id), kind: m.kind === 'd' ? 'd' : 'c', name: String(m.name || ''), svc: svc && svcLogo(svc) ? svc : null };
  });
  return { days, machines, recent: ((r && r.recent) || []).map(toRun) };
}
export type RunDetail = { items: Array<{ tag: 'new' | 'mod'; title: string; where: string | null; href: string | null }>; log: string | null; summary: string | null };
/** 한 건 자세히. */
export async function fetchDetail(run: AutoRun): Promise<RunDetail> {
  const d: any = await api('/api/ui/org/auto-runs/' + run.kind + '/' + encodeURIComponent(String(run.id)));
  return { items: (d && d.items) || [], log: d && d.log != null ? String(d.log) : null, summary: d && d.summary != null ? String(d.summary) : null };
}
/** 자세히 보기 주소 — 현황에서 같은 기간·거르기를 들고 간다. */
export function runsHref(o: { from: number; to: number; kind?: RunFilter; run?: AutoRun | null }): string {
  const q = new URLSearchParams({ from: ymd(o.from), to: ymd(o.to) });
  if (o.kind && o.kind !== 'all') q.set('kind', o.kind);
  if (o.run) q.set('run', o.run.key);
  return '#/context/runs?' + q.toString();
}

// ── 조각 ──────────────────────────────────────────────────────────────────
export function runTile(r: { svc: string | null; glyph: string }, sm = false): HTMLElement {
  const logo = r.svc ? svcLogo(r.svc) : null;
  const t: HTMLElement = el('span', { class: 'cxr-tile' + (sm ? ' is-sm' : ''), 'data-svc': r.svc || undefined });
  t.append(logo || lineIcon(r.glyph, 'cxr-gl'));
  return t;
}
const num = (v: number | null): HTMLElement => (v ? el('b', { class: 'num', text: String(v) }) : el('span', { class: 'is-z num', text: '0' }));
/** 줄 요약 — 수집: 새 자료·바뀐 자료 / 증류: 읽은 → 새 지식·고친 지식 / 카테고리 붙이기: 읽은 → 붙임 / 실패: 사정. */
export function runSummary(r: AutoRun): HTMLElement {
  if (!r.ok) return el('span', { class: 'cxr-s is-fail' }, el('i', { class: 'cxr-xm', 'aria-hidden': 'true', text: '✕' }), '실패 · ' + String(r.err || '').split(' — ')[0].slice(0, 60));
  if (r.kind === 'c') return el('span', { class: 'cxr-s' }, el('span', {}, '새 자료 ', num(r.n), ' · 바뀐 자료 ', num(r.mo)));
  if (r.lane === 'category') return el('span', { class: 'cxr-s' }, el('span', {}, '읽은 지식 ', num(r.read)), el('span', { class: 'cxr-ar', text: '→' }), el('span', {}, '카테고리 붙임 ', num(r.mo)));
  return el('span', { class: 'cxr-s' }, el('span', {}, '읽은 자료 ', num(r.read)), el('span', { class: 'cxr-ar', text: '→' }), el('span', {}, '새 지식 ', num(r.n), ' · 고친 지식 ', num(r.mo)));
}
export const kindTag = (k: RunKind): HTMLElement => el('span', { class: 'cxr-kt' + (k === 'd' ? ' is-d' : ''), text: k === 'c' ? '수집기' : '증류기' });

/** 말풍선 — body 에 하나(패널 밖이라 계열색 토큰을 스스로 갖는다: .cxr-tip). 값이 앞, 이름이 뒤. */
let tipEl: HTMLElement | null = null;
export function showTip(parts: { v: string; fail?: boolean; k?: string; kind?: RunKind; m?: string }, rect: DOMRect): void {
  if (!tipEl || !tipEl.isConnected) { const made: HTMLElement = el('div', { class: 'cxr-tip', role: 'tooltip' }); document.body.append(made); tipEl = made; }
  const t = tipEl as HTMLElement;
  t.replaceChildren(el('div', { class: 'v' + (parts.fail ? ' is-fail' : ''), text: parts.v }));
  if (parts.k) t.append(el('div', { class: 'k' }, el('i', { style: `background:var(--run-${parts.kind || 'c'})` }), el('span', { text: parts.k })));
  if (parts.m) t.append(el('div', { class: 'm', text: parts.m }));
  t.classList.add('is-show');
  const w = t.offsetWidth;
  t.style.left = Math.min(innerWidth - w - 8, Math.max(8, rect.left + rect.width / 2 - w / 2)) + 'px';
  t.style.top = Math.max(8, rect.top - t.offsetHeight - 10) + 'px';
}
export const hideTip = (): void => { tipEl?.classList.remove('is-show'); };

// ── 팝오버(모달 아님) — 달력 · 고르개 ─────────────────────────────────────
let openPop: { el: HTMLElement; close: () => void } | null = null;
function placePop(pop: HTMLElement, anchor: HTMLElement): () => void {
  openPop?.close();
  document.body.append(pop);
  const place = (): void => {
    const ar = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, ar.left)) + 'px';
    pop.style.top = (ar.bottom + 6) + 'px';
  };
  place();
  requestAnimationFrame(() => pop.classList.add('is-show'));
  const outside = (e: Event): void => { if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  const close = (): void => {
    pop.classList.remove('is-show'); setTimeout(() => pop.remove(), 160);
    document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc);
    removeEventListener('resize', place); if (openPop?.el === pop) openPop = null;
  };
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc); }, 0);
  addEventListener('resize', place);
  openPop = { el: pop, close };
  return close;
}

/** 달력 — range=false 면 날짜 하나, true 면 시작·끝 두 번. 바로가기(오늘·어제·최근 7일·최근 30일). 최근 30일 밖·미래는 못 고른다. */
export function calendarPop(anchor: HTMLElement, opt: { range: boolean; sel: [number, number]; onPick: (from0: number, to0: number) => void }): void {
  const pop: HTMLElement = el('div', { class: 'cxr-pop cxr-cal-pop', role: 'dialog', 'aria-label': '날짜 고르기' });
  const t0 = today0(), min0 = addDays(t0, -(KEEP_DAYS - 1));
  let a: number | null = opt.sel[0], b: number | null = opt.sel[1], picking = false;
  const view = new Date(opt.sel[1]); view.setDate(1);
  const presets: Array<[string, number, number]> = opt.range
    ? [['오늘', 0, 0], ['어제', 1, 1], ['최근 7일', 6, 0], ['최근 30일', KEEP_DAYS - 1, 0]]
    : [['오늘', 0, 0], ['어제', 1, 1]];
  let close = (): void => {};
  const render = (): void => {
    const y = view.getFullYear(), mo = view.getMonth(), first = new Date(y, mo, 1).getDay(), days = new Date(y, mo + 1, 0).getDate();
    const grid: HTMLElement = el('div', { class: 'cxr-cal-g' }, ...WD.map((w) => el('span', { text: w })), ...Array.from({ length: first }, () => el('span', {})));
    for (let d = 1; d <= days; d++) {
      const t = new Date(y, mo, d).getTime();
      const lo = a !== null && b !== null ? Math.min(a, b) : a, hi = a !== null && b !== null ? Math.max(a, b) : a;
      const btn: HTMLElement = el('button', { type: 'button', text: String(d), disabled: t > t0 || t < min0,
        class: [t === a || t === b ? 'is-sel' : '', lo !== null && hi !== null && t > lo && t < hi ? 'is-in' : '', t === t0 ? 'is-today' : ''].join(' ') });
      btn.addEventListener('click', () => {
        if (!opt.range) { opt.onPick(t, t); close(); return; }
        if (!picking) { a = t; b = null; picking = true; render(); return; }
        picking = false; const s = Math.min(a!, t), e = Math.max(a!, t); opt.onPick(s, e); close();
      });
      grid.append(btn);
    }
    const nav = (n: number): HTMLElement => { const bt: HTMLElement = el('button', { type: 'button', text: n < 0 ? '‹' : '›', 'aria-label': n < 0 ? '이전 달' : '다음 달' }); bt.addEventListener('click', () => { view.setMonth(view.getMonth() + n); render(); }); return bt; };
    pop.replaceChildren(
      ...presets.map(([label, s, e]) => {
        const s0 = addDays(t0, -s), e0 = addDays(t0, -e);
        const on = a === s0 && b === e0;
        const bt: HTMLElement = el('button', { type: 'button', class: 'cxr-pr' }, el('span', { class: 'ck', text: on ? '✓' : '' }), label,
          el('small', { text: s === e ? sd(s0) : sd(s0) + ' – ' + sd(e0) }));
        bt.addEventListener('click', () => { opt.onPick(s0, e0); close(); });
        return bt;
      }),
      el('div', { class: 'cxr-hr' }),
      el('div', { class: 'cxr-cal' },
        el('div', { class: 'cxr-cal-h' }, nav(-1), el('b', { text: y + '년 ' + (mo + 1) + '월' }), nav(1)),
        grid,
        el('div', { class: 'cxr-cal-f' }, el('span', { text: opt.range ? (picking ? '끝 날짜를 누르세요' : '시작일 → 끝일 순으로') : '누르면 그날로 가요' }), el('span', { class: 'r', text: '최근 30일' }))));
  };
  render();
  close = placePop(pop, anchor);
}

/** 고르개(목록형 팝오버) — 도구줄의 [종류][기계][결과]. */
export function menuPop<T>(anchor: HTMLElement, items: Array<{ value: T; label: string; icon?: HTMLElement | null; note?: string }>, cur: T, onPick: (v: T) => void): void {
  const pop: HTMLElement = el('div', { class: 'cxr-pop cxr-menu', role: 'listbox' });
  let close = (): void => {};
  for (const it of items) {
    const bt: HTMLElement = el('button', { type: 'button', class: 'cxr-pr', role: 'option', 'aria-selected': String(it.value === cur) },
      el('span', { class: 'ck', text: it.value === cur ? '✓' : '' }), it.icon || null, el('span', { class: 'lbl', text: it.label }), it.note ? el('small', { text: it.note }) : null);
    bt.addEventListener('click', () => { onPick(it.value); close(); });
    pop.append(bt);
  }
  close = placePop(pop, anchor);
}

// ── 시간 막대 ─────────────────────────────────────────────────────────────
const W = 1200, GUT = 52, PADR = 44, Y = { c: 22, d: 60 } as const, HH = 100;

/** 하루 — 실행마다. 겹칠 때 읽히는 순서로(바뀐 것 없음 → 바뀐 실행 → 실패). 오늘이면 «지금» 선. */
export function dayTimeline(runs: AutoRun[], d0: number, onRun: (r: AutoRun) => void): HTMLElement {
  const now = Date.now(), end = addDays(d0, 1);
  const lastT = end > now ? now + 4 * MIN : end;
  const first = runs.length ? Math.max(d0, Math.min(...runs.map((r) => r.t)) - 20 * MIN) : d0;
  const from = Math.min(first, lastT - 6 * 36e5);
  const x = (t: number): number => GUT + ((t - from) / Math.max(1, lastT - from)) * (W - GUT - PADR);
  const svg: SVGElement = sv('svg', { viewBox: `0 0 ${W} ${HH}`, role: 'img', 'aria-label': mdw(d0) + ' 자동 실행' });
  const hr = 36e5;
  for (let t = Math.ceil(from / hr) * hr; t <= lastT; t += hr) {
    const gx = x(t);
    svg.append(sv('line', { class: 't-grid', x1: gx, x2: gx, y1: 6, y2: HH - 22 }), sv('text', { class: 't-axis', x: gx, y: HH - 6, 'text-anchor': 'middle' }, new Date(t).getHours() + '시'));
  }
  const byId = new Map(runs.map((r) => [r.key, r]));
  for (const k of ['c', 'd'] as const) {
    const y = Y[k];
    const g: SVGElement = sv('g', { class: 't-g is-' + k });
    g.append(sv('text', { class: 't-lane', x: 0, y: y + 4 }, k === 'c' ? '수집' : '증류'), sv('line', { class: 't-base', x1: GUT - 6, x2: x(lastT), y1: y, y2: y }));
    const layer = (q: AutoRun): number => (!q.ok ? 2 : changed(q) ? 1 : 0);
    for (const r of runs.filter((q) => q.kind === k).slice().reverse().sort((a, b) => layer(a) - layer(b))) {
      const cx = x(r.t);
      let mk: SVGElement;
      if (!r.ok) mk = sv('g', { class: 't-mk t-x' }, sv('circle', { cx, cy: y, r: 6.5 }), sv('path', { d: `M${cx - 2.6} ${y - 2.6}l5.2 5.2M${cx + 2.6} ${y - 2.6}l-5.2 5.2` }));
      else if (!changed(r)) mk = sv('rect', { class: 't-mk t-z', x: cx - 1, y: y - 4, width: 2, height: 8, rx: 1 });
      else mk = sv('circle', { class: 't-mk t-' + k, cx, cy: y, r: Math.min(10.5, 4.5 + 1.8 * Math.sqrt(r.n + r.mo)) });
      g.append(sv('g', { class: 't-r' + (changed(r) ? ' is-ch' : ''), 'data-k': r.key }, mk, sv('circle', { class: 't-hit', cx, cy: y, r: 12 })));
    }
    svg.append(g);
  }
  if (end > now) {
    const nx = x(now);
    svg.append(sv('line', { class: 't-now', x1: nx, x2: nx, y1: 4, y2: HH - 22 }), sv('circle', { class: 't-nowd', cx: nx, cy: 4, r: 3.5 }),
      sv('circle', { class: 't-pulse', cx: nx, cy: 4, r: 3.5 }), sv('text', { class: 't-nowl', x: nx + 7, y: 8 }, '지금 ' + hhmm(now)));
  }
  const host: HTMLElement = el('div', { class: 'cxr-tl' }, svg);
  host.addEventListener('pointerover', (e) => {
    const gr = (e.target as Element).closest('.t-r'); if (!gr) return; gr.classList.add('is-hov');
    const r = byId.get(gr.getAttribute('data-k') || ''); if (!r) return;
    const v = !r.ok ? '실패' : !changed(r) ? '바뀐 것 없음' : r.kind === 'c' ? `새 자료 ${r.n} · 바뀐 자료 ${r.mo}` : r.lane === 'category' ? `카테고리 붙임 ${r.mo}` : `새 지식 ${r.n} · 고친 지식 ${r.mo}`;
    showTip({ v, fail: !r.ok, k: r.name, kind: r.kind, m: hhmm(r.t) + (r.read != null ? ' · 읽은 ' + r.read + '건' : '') + (!r.ok ? ' · ' + String(r.err || '') : changed(r) ? ' · 누르면 자세히' : '') }, gr.getBoundingClientRect());
  });
  host.addEventListener('pointerout', (e) => { const gr = (e.target as Element).closest('.t-r'); if (gr && !gr.contains(e.relatedTarget as Node)) { gr.classList.remove('is-hov'); hideTip(); } });
  host.addEventListener('click', (e) => { const gr = (e.target as Element).closest('.t-r'); const r = gr ? byId.get(gr.getAttribute('data-k') || '') : null; if (r && changed(r)) { hideTip(); onRun(r); } });
  return host;
}

/** 여러 날 — 날마다 점 하나. 크기 = 그 기간 안에서 가장 바쁜 날 대비 √(면적이 양에 비례) · 칸 폭을 넘지 않게. 주말은 옅게. */
export function daysTimeline(days: DayAgg[], from0: number, to0: number, onDay: (d0: number) => void): HTMLElement {
  const nDays = Math.round((to0 - from0) / DAY) + 1;
  const end = addDays(to0, 1);
  const x = (t: number): number => GUT + ((t - from0) / (end - from0)) * (W - GUT - PADR);
  const svg: SVGElement = sv('svg', { viewBox: `0 0 ${W} ${HH}`, role: 'img', 'aria-label': md(from0) + '–' + md(to0) + ' 날짜별 자동 실행' });
  const byDay = new Map(days.map((d) => [d.day, d]));
  for (let d = from0, i = 0; d <= to0; d = addDays(d, 1), i++) {
    const wd = new Date(d).getDay(), we = wd === 0 || wd === 6, x0 = x(d), x1 = x(addDays(d, 1));
    if (we) svg.append(sv('rect', { class: 't-wkend', x: x0, y: 4, width: x1 - x0, height: HH - 26 }));
    const show = nDays <= 7 || new Date(d).getDate() % 5 === 0 || i === 0;
    if (show) svg.append(sv('text', { class: 't-axis' + (we ? ' is-we' : ''), x: (x0 + x1) / 2, y: HH - 6, 'text-anchor': 'middle' }, sd(d) + (nDays <= 7 ? ' ' + WD[wd] : '')));
  }
  const colW = x(addDays(from0, 1)) - x(from0);
  for (const k of ['c', 'd'] as const) {
    const y = Y[k];
    const g: SVGElement = sv('g', { class: 't-g is-' + k });
    g.append(sv('text', { class: 't-lane', x: 0, y: y + 4 }, k === 'c' ? '수집' : '증류'), sv('line', { class: 't-base', x1: GUT - 6, x2: x(end), y1: y, y2: y }));
    const vmax = Math.max(1, ...days.map((dd) => dd[k].inserted + dd[k].updated)), rmax = Math.min(12, colW * 0.36);
    for (let d = from0; d <= to0; d = addDays(d, 1)) {
      const a = byDay.get(d)?.[k];
      if (!a || !a.runs) continue;
      const ch = a.inserted + a.updated, cx = x(d + DAY / 2);
      const rad = ch ? Math.max(3, rmax * Math.sqrt(ch / vmax)) : 0;
      const gr: SVGElement = sv('g', { class: 't-r is-ch', 'data-day': String(d), 'data-kind': k });
      gr.append(ch ? sv('circle', { class: 't-mk t-' + k, cx, cy: y, r: rad }) : sv('rect', { class: 't-mk t-z', x: cx - 1, y: y - 4, width: 2, height: 8, rx: 1 }));
      if (a.failed) {
        const fx = cx + Math.max(rad, 3) + 5, fy = y - Math.max(rad, 3) - 1;
        gr.append(sv('g', { class: 't-x' }, sv('circle', { cx: fx, cy: fy, r: 4.5 }), sv('path', { d: `M${fx - 1.8} ${fy - 1.8}l3.6 3.6M${fx + 1.8} ${fy - 1.8}l-3.6 3.6` })));
      }
      gr.append(sv('circle', { class: 't-hit', cx, cy: y, r: Math.max(12, Math.min(16, colW / 2)) }));
      g.append(gr);
    }
    svg.append(g);
  }
  const host: HTMLElement = el('div', { class: 'cxr-tl' }, svg);
  host.addEventListener('pointerover', (e) => {
    const gr = (e.target as Element).closest('.t-r'); if (!gr) return; gr.classList.add('is-hov');
    const d = Number(gr.getAttribute('data-day')), k = gr.getAttribute('data-kind') as RunKind, a = byDay.get(d)?.[k];
    if (!a) return;
    showTip({ v: k === 'c' ? `새 자료 ${a.inserted} · 바뀐 자료 ${a.updated}` : `새 지식 ${a.inserted} · 고친 지식 ${a.updated}`, k: (k === 'c' ? '수집기 · ' : '증류기 · ') + mdw(d), kind: k,
      m: `실행 ${a.runs}회` + (a.failed ? ` · 실패 ${a.failed}` : '') + ' · 누르면 그날 하루로' }, gr.getBoundingClientRect());
  });
  host.addEventListener('pointerout', (e) => { const gr = (e.target as Element).closest('.t-r'); if (gr && !gr.contains(e.relatedTarget as Node)) { gr.classList.remove('is-hov'); hideTip(); } });
  host.addEventListener('click', (e) => { const gr = (e.target as Element).closest('.t-r'); if (gr) { hideTip(); onDay(Number(gr.getAttribute('data-day'))); } });
  return host;
}

// ── 패널 ──────────────────────────────────────────────────────────────────
function jobText(job: any): string {
  if (!job) return '미등록';
  if (!job.any_enabled) return '꺼짐';
  const n = Number(job.interval_sec) || 0;
  const every = !n ? '' : n % 3600 === 0 ? n / 3600 + '시간마다' : n % 60 === 0 ? n / 60 + '분마다' : n + '초마다';
  return every + (job.last_run_at ? ' · ' + relTime(job.last_run_at) : ' · 미실행');
}

export interface RunsPanel { root: HTMLElement; setFilter(f: RunFilter): void }

/** 지도 아래 패널. pipeline = 지도가 이미 받은 /org/pipeline(주기 표기). onFilter = 패널 안에서 거르기를 바꾸면 지도 칩에 알린다. */
export function runsPanel(pipeline: any, opts: { onFilter?: (f: RunFilter) => void } = {}): RunsPanel {
  const st = { period: 'day' as Period, end: today0(), f: 'all' as RunFilter, seq: 0 };
  const root: HTMLElement = el('section', { class: 'cxr', 'data-f': 'all', 'aria-label': '자동 실행' });
  const prev: HTMLButtonElement = el('button', { type: 'button', class: 'cxr-stp', 'aria-label': '이전', text: '‹' });
  const next: HTMLButtonElement = el('button', { type: 'button', class: 'cxr-stp', 'aria-label': '다음', text: '›' });
  const lbl: HTMLButtonElement = el('button', { type: 'button', class: 'cxr-stp-lbl', 'aria-haspopup': 'dialog' });
  const seg: HTMLElement = el('div', { class: 'cxr-seg', role: 'tablist', 'aria-label': '기간' }, el('span', { class: 'cxr-seg-ind', 'aria-hidden': 'true' }));
  for (const [p, label] of [['day', '하루'], ['week', '7일'], ['month', '30일']] as Array<[Period, string]>) {
    const b: HTMLElement = el('button', { type: 'button', role: 'tab', 'data-p': p, text: label });
    b.addEventListener('click', () => { if (st.period !== p) { st.period = p; void load(); } });
    seg.append(b);
  }
  const sub: HTMLElement = el('span', { class: 'cxr-sub' });
  const more: HTMLAnchorElement = el('a', { class: 'cxr-more-link', text: '자세히 보기 →' });
  root.append(el('div', { class: 'cxr-head' }, el('b', { class: 'cxr-h', text: '자동 실행' }), el('div', { class: 'cxr-stepper' }, prev, lbl, next), seg, sub, more));
  const body: HTMLElement = el('div', { class: 'cxr-body' });
  const stc = (pipeline && pipeline.stages) || {};
  const lgBtn = (f: RunFilter, label: string): HTMLElement => {
    const b: HTMLElement = el('button', { type: 'button', class: 'cxr-lgf', 'data-lf': f }, f === 'all' ? null : el('i', { class: 'cxr-dot' + (f === 'd' ? ' is-d' : ''), 'aria-hidden': 'true' }), label);
    b.addEventListener('click', () => { setFilter(f); opts.onFilter?.(f); });
    return b;
  };
  const hint: HTMLElement = el('span', { class: 'cxr-sp' });
  const legend: HTMLElement = el('div', { class: 'cxr-legend' },
    lgBtn('all', '전체'), lgBtn('c', '수집기'), lgBtn('d', '증류기'), el('span', { class: 'cxr-lsep', 'aria-hidden': 'true' }),
    el('span', {}, el('i', { class: 'cxr-lz', 'aria-hidden': 'true' }), '바뀐 것 없음'),
    el('span', {}, el('i', { class: 'cxr-xm', 'aria-hidden': 'true', text: '✕' }), '실패'),
    el('span', { class: 'cxr-sched', title: '자동 실행 주기' },
      el('span', { class: 'is-c' }, '수집 ' + jobText(stc.collect?.job)), el('span', { class: 'is-d' }, '증류 ' + jobText(stc.distill?.job))),
    hint);
  const feed: HTMLElement = el('div', { class: 'cxr-feed' });
  const foot: HTMLElement = el('div', { class: 'cxr-more' });
  root.append(body, legend, feed, foot);

  const spanDays = (): number => (st.period === 'day' ? 1 : st.period === 'week' ? 7 : KEEP_DAYS);
  const startOf = (): number => addDays(st.end, -(spanDays() - 1));
  const clampEnd = (): void => { const t0 = today0(); if (st.end > t0) st.end = t0; const minEnd = addDays(t0, -(KEEP_DAYS - spanDays())); if (st.end < minEnd) st.end = minEnd; };
  prev.addEventListener('click', () => { st.end = addDays(st.end, -spanDays()); void load(); });
  next.addEventListener('click', () => { st.end = addDays(st.end, spanDays()); void load(); });
  lbl.addEventListener('click', () => calendarPop(lbl, { range: st.period !== 'day', sel: [startOf(), st.end], onPick: (s, e) => {
    const n = Math.round((e - s) / DAY) + 1;
    st.period = n === 1 ? 'day' : n <= 7 ? 'week' : 'month'; st.end = e; void load();
  } }));

  function paintHead(): void {
    const s = startOf(), t0 = today0();
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.getAttribute('data-p') === st.period));
    paintSeg();
    const r = relDay(st.end);
    lbl.replaceChildren(document.createTextNode(st.period === 'day' ? mdw(st.end) : md(s) + ' – ' + md(st.end)));
    if (st.period === 'day' ? !!r : st.end === t0) lbl.append(el('small', { text: st.period === 'day' ? r! : '오늘까지' }));
    next.disabled = st.end >= t0;
    prev.disabled = addDays(s, -1) < addDays(t0, -(KEEP_DAYS - 1));
    more.href = runsHref({ from: s, to: st.end, kind: st.f });
    hint.textContent = st.period === 'day' ? '점이 클수록 많이 바뀌었어요 · 점을 누르면 자세히' : '날마다 점 하나 — 누르면 그날 하루로';
  }
  function paintSeg(): void {
    const b = seg.querySelector('button.is-on') as HTMLElement | null, ind = seg.querySelector('.cxr-seg-ind') as HTMLElement | null;
    if (!b || !ind || !b.offsetWidth) return;
    ind.style.width = b.offsetWidth + 'px'; ind.style.transform = `translateX(${b.offsetLeft}px)`;
  }
  const goRun = (r: AutoRun): void => { location.hash = runsHref({ from: dayOf(r.t), to: dayOf(r.t), run: r }).slice(1); };
  const row = (r: AutoRun): HTMLElement => el('a', { class: 'cxr-row', href: runsHref({ from: dayOf(r.t), to: dayOf(r.t), run: r }), 'data-key': r.key },
    el('span', { class: 'cxr-t num', text: st.period === 'day' ? hhmm(r.t) : sd(r.t) + ' ' + hhmm(r.t) }), runTile(r),
    el('span', { class: 'cxr-n' }, el('b', { text: r.name, title: r.name }), kindTag(r.kind)), runSummary(r),
    el('span', { class: 'cxr-chev', 'aria-hidden': 'true', text: '›' }));
  let dayRuns: AutoRun[] = [], daily: { days: DayAgg[]; recent: AutoRun[] } | null = null;
  function paintBody(): void {
    const inF = (r: AutoRun): boolean => st.f === 'all' || r.kind === st.f;
    const s = startOf();
    if (st.period === 'day') {
      const rs = dayRuns.filter(inF), ch = rs.filter(changed);
      sub.replaceChildren('실행 ', el('b', { class: 'num', text: rs.length.toLocaleString() }), '회 · 변화 있던 실행 ', el('b', { class: 'num', text: ch.length.toLocaleString() }), '회');
      keyed(feed, ch.slice(0, 5).map((r) => ({ key: r.key, make: () => row(r) })), ch.length ? null : (dayRuns.length ? '이날은 자동 실행이 돌았지만 바뀐 것이 없어요.' : '이날은 자동 실행 기록이 없어요.'));
      foot.replaceChildren();
      if (ch.length > 5) foot.append(el('a', { class: 'cxr-btn is-pri', href: runsHref({ from: s, to: st.end, kind: st.f }), text: `이날 바뀐 실행 ${ch.length}개 모두 보기 →` }));
    } else {
      const ds = daily?.days || [];
      const sum = (k: RunKind, f: 'runs' | 'inserted'): number => ds.reduce((a, d) => a + d[k][f], 0);
      const runs = (st.f !== 'd' ? sum('c', 'runs') : 0) + (st.f !== 'c' ? sum('d', 'runs') : 0);
      sub.replaceChildren('실행 ', el('b', { class: 'num', text: runs.toLocaleString() }), '회');
      if (st.f !== 'd') sub.append(' · 새 자료 ', el('b', { class: 'num', text: sum('c', 'inserted').toLocaleString() }));
      if (st.f !== 'c') sub.append(' · 새 지식 ', el('b', { class: 'num', text: sum('d', 'inserted').toLocaleString() }));
      const rec = (daily?.recent || []).filter(inF);
      // 여러 날 줄은 시간 칸에 날짜가 붙는다 — 하루 보기에서 만든 같은 줄을 다시 쓰지 않게 키를 가른다
      keyed(feed, rec.map((r) => ({ key: r.key + '@d', make: () => row(r) })), rec.length ? null : '이 기간엔 바뀐 실행이 없어요.');
      foot.replaceChildren(el('a', { class: 'cxr-btn is-pri', href: runsHref({ from: s, to: st.end, kind: st.f }), text: '이 기간 기록 모두 보기 →' }));
    }
  }
  async function load(): Promise<void> {
    clampEnd(); paintHead();
    const my = ++st.seq, s = startOf();
    root.classList.add('is-loading');
    try {
      if (st.period === 'day') {
        const rs = await fetchDay(st.end); if (my !== st.seq) return;
        dayRuns = rs; body.replaceChildren(dayTimeline(rs, st.end, goRun));
      } else {
        const d = await fetchDaily(s, st.end); if (my !== st.seq) return;
        daily = d; body.replaceChildren(daysTimeline(d.days, s, st.end, (d0) => { st.period = 'day'; st.end = d0; void load(); }));
      }
      //  좁은 화면(폰)에선 시간 막대가 옆으로 밀린다 — 처음엔 끝(«지금»·마지막 날 쪽)을 보인다.
      requestAnimationFrame(() => { const tl = body.querySelector<HTMLElement>('.cxr-tl'); if (tl && tl.scrollWidth > tl.clientWidth) tl.scrollLeft = tl.scrollWidth; });
      paintBody();
    } catch (e) {
      if (my !== st.seq) return;
      body.replaceChildren(el('p', { class: 'cxr-empty', text: '자동 실행 기록을 불러오지 못했습니다 — ' + (e as Error).message }));
    } finally { if (my === st.seq) root.classList.remove('is-loading'); }
  }
  function setFilter(f: RunFilter): void {
    st.f = f; root.setAttribute('data-f', f);
    legend.querySelectorAll('[data-lf]').forEach((b) => b.classList.toggle('is-on', b.getAttribute('data-lf') === f));
    more.href = runsHref({ from: startOf(), to: st.end, kind: st.f });
    paintBody();
  }
  legend.querySelector('[data-lf="all"]')?.classList.add('is-on');
  requestAnimationFrame(paintSeg);
  new ResizeObserver(() => paintSeg()).observe(seg);
  void load();
  return { root, setFilter };
}

/**
 * 키가 있는 목록 갱신 — 남는 줄은 같은 노드를 옮겨 제자리로 미끄러지게(FLIP), 떠나는 줄은 흐리게 치우고, 새 줄은 차례로 올라온다.
 *  empty 를 주면 빈 목록 대신 그 문장 한 줄.
 */
export function keyed(box: HTMLElement, items: Array<{ key: string; make: () => HTMLElement }>, empty?: string | null): void {
  if (!items.length && empty) { box.replaceChildren(el('p', { class: 'cxr-empty', text: empty })); return; }
  const reduce = REDUCE();
  const old = new Map<string, HTMLElement>();
  for (const n of Array.from(box.children) as HTMLElement[]) if (n.dataset.key) old.set(n.dataset.key, n);
  const boxR = box.getBoundingClientRect();
  const first = new Map<string, DOMRect>();
  old.forEach((n, k) => first.set(k, n.getBoundingClientRect()));
  const nextKeys = new Set(items.map((i) => i.key));
  old.forEach((n, k) => {
    if (nextKeys.has(k)) return;
    if (reduce) { n.remove(); return; }
    const r = first.get(k)!;
    Object.assign(n.style, { position: 'absolute', left: (r.left - boxR.left) + 'px', top: (r.top - boxR.top) + 'px', width: r.width + 'px' });
    delete n.dataset.key; n.classList.add('cxr-leave'); setTimeout(() => n.remove(), 220);
  });
  let enter = 0;
  const nodes = items.map((it) => {
    let n = old.get(it.key);
    if (!n) {
      n = it.make();
      if (!reduce) { const nn = n; nn.classList.add('cxr-enter'); nn.style.animationDelay = Math.min(enter++ * 32, 260) + 'ms'; nn.addEventListener('animationend', () => { nn.classList.remove('cxr-enter'); nn.style.animationDelay = ''; }, { once: true }); }
    }
    return n;
  });
  const leavers = (Array.from(box.children) as HTMLElement[]).filter((n) => !n.dataset.key && n.classList.contains('cxr-leave'));
  box.replaceChildren(...nodes, ...leavers);
  if (reduce) return;
  for (const n of nodes) {
    const f = first.get(n.dataset.key || ''); if (!f) continue;
    const l = n.getBoundingClientRect(); const dx = f.left - l.left, dy = f.top - l.top;
    if (!dx && !dy) continue;
    n.style.transition = 'none'; n.style.transform = `translate(${dx}px,${dy}px)`;
    requestAnimationFrame(() => { n.style.transition = 'transform .42s cubic-bezier(.2,.8,.2,1)'; n.style.transform = ''; n.addEventListener('transitionend', () => { n.style.transition = ''; }, { once: true }); });
  }
}
