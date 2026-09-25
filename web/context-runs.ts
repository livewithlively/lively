// context-runs.ts — [맥락 관리 ▸ 현황] 지도 아래 「자동 실행」 패널(#4172 · #4135 2판 A안, 원준 2026-09-25 확정).
//
//  원준 지시: "수집기나 증류기 모형 클릭하면 수집기 탭, 증류기 탭으로 이동하는데 그러지 말고 밑에 하단에 로그에 보이는 부분이
//   수정되는 방식으로 … 수집기 모형을 누르면 밑에가 sorting 되거나 펼쳐지거나 … 예쁘고 유려한 느낌". 시안 A(«언제 돌았나») 를 골랐다.
//
//   ① 시간 막대 — 오늘 0시(없으면 첫 실행)부터 지금까지 **모든** 자동 실행을 찍는다. 점 = 무언가 바뀐 실행(크기 = 바뀐 건수),
//      짧은 막대 = 돌았지만 바뀐 것 없음, ✕ = 실패. 두 줄(수집 · 증류). 자동 실행이 «살아 있다» 는 박동이 이 줄의 일이다.
//   ② 목록 — 바뀐 실행과 실패만. 줄을 누르면 그 자리에서 펼쳐져 «무엇이 들어왔나 / 무엇을 만들었나» 가 보인다.
//   ③ 거르기 — 지도의 수집기·증류기 칩과 패널 머리의 [전체·수집기·증류기] 가 같은 스위치다. 거르면 반대 줄이 흐려지고,
//      목록은 떠나는 줄이 흐려지며 남는 줄이 제자리로 미끄러진다(FLIP). 모션은 prefers-reduced-motion 이면 끈다.
//
//  데이터는 이 파일의 loadRuns 가 한 번에 모은다(수집 = 커넥터 실행 기록, 증류 = 증류기 실행 기록). 실패해도 지도는 선다 —
//  패널 자리에 한 줄로 사정을 말한다.
import { api, el, relTime, sv } from './core.js';
import { presetSvcKey } from './svc-icons.js';
import { svcLogo } from './svc-logos.js';
import { icon as lineIcon } from './v2/icons.js';

export type RunKind = 'c' | 'd';
export type RunFilter = 'all' | RunKind;

/** 펼쳤을 때 보이는 한 줄 — 들어온 자료 · 만든/고친 지식. */
export interface RunItem { tag: 'new' | 'mod'; title: string; where?: string | null; href?: string | null }

export interface AutoRun {
  key: string;
  kind: RunKind;
  /** 기계(수집기·증류기) 식별자와 이름 — 목록 줄의 주인. */
  machineId: string;
  name: string;
  /** 서비스 로고 키(svcLogo) — 없으면 선 글리프. */
  svc: string | null;
  glyph: string;
  /** 시작 시각(ms). */
  t: number;
  ok: boolean;
  err?: string | null;
  /** 수집: 새로 들어온 · 바뀐 자료 수 / 증류: 새 지식 · 고친 지식 수. */
  n: number;
  mo: number;
  /** 증류: 읽은 자료 수. */
  read?: number | null;
  /** 펼칠 때 부르는 상세(없으면 수치만). */
  detail?: () => Promise<{ items: RunItem[]; links: Array<{ label: string; href: string }> }>;
  /** 이 기계의 설정 화면. */
  href: string;
}

export interface RunsData {
  runs: AutoRun[];
  /** 가로축 시작·끝(ms). */
  from: number;
  to: number;
  sched: { c: string; d: string };
}

const REDUCE = (): boolean => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const changed = (r: AutoRun): boolean => !r.ok || r.n + r.mo > 0;
const hhmm = (t: number): string => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const FEED_MAX = 6;

/** 패널 — 지도(context-map)가 칩을 누를 때 setFilter 를 부른다. 패널 안 스위치를 누르면 onFilter 로 지도에 알린다. */
export interface RunsPanel { root: HTMLElement; setFilter(f: RunFilter): void }

export function runsPanel(data: RunsData | null, opts: { onFilter?: (f: RunFilter) => void; error?: string | null } = {}): RunsPanel {
  const st = { f: 'all' as RunFilter, all: false, open: new Set<string>() };
  const root: HTMLElement = el('section', { class: 'cxr', 'data-f': 'all', 'aria-label': '자동 실행' });
  const sub: HTMLElement = el('span', { class: 'cxr-sub' });
  const seg: HTMLElement = el('div', { class: 'cxr-seg', role: 'tablist', 'aria-label': '거르기' }, el('span', { class: 'cxr-seg-ind', 'aria-hidden': 'true' }));
  const segBtn = (f: RunFilter, label: string): HTMLElement => {
    const b: HTMLElement = el('button', { type: 'button', role: 'tab', 'data-f': f, 'aria-selected': String(f === 'all') },
      f === 'all' ? null : el('i', { class: 'cxr-dot' + (f === 'd' ? ' is-d' : ''), 'aria-hidden': 'true' }), label);
    b.addEventListener('click', () => { setFilter(f); opts.onFilter?.(f); });
    return b;
  };
  seg.append(segBtn('all', '전체'), segBtn('c', '수집기'), segBtn('d', '증류기'));
  const sched: HTMLElement = el('span', { class: 'cxr-sched' },
    el('span', { class: 'is-c' }, el('i', { class: 'cxr-dot', 'aria-hidden': 'true' }), '수집 ' + (data?.sched.c || '—')),
    el('span', { class: 'is-d' }, el('i', { class: 'cxr-dot is-d', 'aria-hidden': 'true' }), '증류 ' + (data?.sched.d || '—')));
  root.append(el('div', { class: 'cxr-head' }, el('div', { class: 'cxr-title' }, el('b', { text: '자동 실행' }), sub), sched, seg));

  if (!data) {
    root.append(el('p', { class: 'cxr-empty', text: opts.error ? '자동 실행 기록을 불러오지 못했습니다 — ' + opts.error : '자동 실행 기록을 불러오지 못했습니다.' }));
    return { root, setFilter: () => {} };
  }
  const runs = data.runs.slice().sort((a, b) => b.t - a.t);
  const byKey = new Map(runs.map((r) => [r.key, r]));

  const tl: HTMLElement = el('div', { class: 'cxr-tl' }, timeline(runs, data.from, data.to));
  const legend: HTMLElement = el('div', { class: 'cxr-legend' },
    el('span', {}, el('i', { class: 'cxr-dot', 'aria-hidden': 'true' }), '수집기'),
    el('span', {}, el('i', { class: 'cxr-dot is-d', 'aria-hidden': 'true' }), '증류기'),
    el('span', {}, el('i', { class: 'cxr-lz', 'aria-hidden': 'true' }), '바뀐 것 없음'),
    el('span', {}, el('i', { class: 'cxr-xm', 'aria-hidden': 'true', text: '✕' }), '실패'),
    el('span', { class: 'cxr-sp', text: '점이 클수록 많이 바뀌었어요 · 점을 누르면 아래에서 펼쳐져요' }));
  const feed: HTMLElement = el('div', { class: 'cxr-feed' });
  const more: HTMLElement = el('div', { class: 'cxr-more' });
  root.append(tl, legend, feed, more);

  // ── 말풍선(값이 앞, 이름이 뒤) ──
  const tip: HTMLElement = el('div', { class: 'cxr-tip', role: 'tooltip' });
  document.body.append(tip);
  const showTip = (r: AutoRun, at: DOMRect): void => {
    const v = !r.ok ? '실패' : !changed(r) ? '바뀐 것 없음' : r.kind === 'c' ? `새 자료 ${r.n} · 바뀐 자료 ${r.mo}` : `새 지식 ${r.n} · 고친 지식 ${r.mo}`;
    const m = !r.ok ? String(r.err || '') : (r.kind === 'd' && r.read != null ? `읽은 자료 ${r.read}건 · ` : '') + hhmm(r.t) + (changed(r) ? ' · 누르면 아래에서 펼쳐져요' : '');
    tip.replaceChildren(
      el('div', { class: 'v' + (r.ok ? '' : ' is-fail'), text: v }),
      el('div', { class: 'k' }, el('i', { style: `background:var(--run-${r.kind})` }), el('span', { text: r.name })),
      el('div', { class: 'm', text: m }));
    tip.classList.add('is-show');
    const w = tip.offsetWidth;
    tip.style.left = Math.min(innerWidth - w - 8, Math.max(8, at.left + at.width / 2 - w / 2)) + 'px';
    tip.style.top = Math.max(8, at.top - tip.offsetHeight - 10) + 'px';
  };
  const hideTip = (): void => { tip.classList.remove('is-show'); };
  //  패널이 화면에서 빠지면(탭 이동) 말풍선도 치운다 — body 에 붙은 것이라 저절로 사라지지 않는다.
  const gone = new MutationObserver(() => { if (!root.isConnected) { tip.remove(); gone.disconnect(); } });
  gone.observe(document.body, { childList: true, subtree: true });

  tl.addEventListener('pointerover', (e) => {
    const g = (e.target as Element).closest('.t-r') as SVGGElement | null;
    if (!g) return;
    g.classList.add('is-hov');
    const r = byKey.get(g.getAttribute('data-k') || '');
    if (r) showTip(r, g.getBoundingClientRect());
  });
  tl.addEventListener('pointerout', (e) => {
    const g = (e.target as Element).closest('.t-r');
    if (g && !g.contains(e.relatedTarget as Node)) { g.classList.remove('is-hov'); hideTip(); }
  });
  tl.addEventListener('click', (e) => {
    const g = (e.target as Element).closest('.t-r');
    const r = g ? byKey.get(g.getAttribute('data-k') || '') : null;
    if (!r || !changed(r)) return;
    if (st.f !== 'all' && st.f !== r.kind) { setFilter('all'); opts.onFilter?.('all'); }
    const rows = runs.filter((x) => inF(x) && changed(x));
    if (rows.indexOf(r) >= FEED_MAX) st.all = true;
    st.open.add(r.key);
    paintFeed();
    paintSel();
    const row = feed.querySelector(`.cxr-row[data-key="${cssEsc(r.key)}"]`) as HTMLElement | null;
    if (row) { openRow(row, r, true); setTimeout(() => row.scrollIntoView({ block: 'nearest', behavior: REDUCE() ? 'auto' : 'smooth' }), 120); }
  });

  const inF = (r: AutoRun): boolean => st.f === 'all' || r.kind === st.f;
  const paintSel = (): void => { tl.querySelectorAll('.t-r').forEach((g) => g.classList.toggle('is-sel', st.open.has(g.getAttribute('data-k') || ''))); };

  function paintSub(): void {
    const rs = runs.filter(inF);
    const lbl = st.f === 'c' ? '수집 ' : st.f === 'd' ? '증류 ' : '';
    const prev = Array.from(sub.querySelectorAll('b')).map((b) => Number((b.textContent || '0').replace(/,/g, '')) || 0);
    const a: HTMLElement = el('b', { text: '0' }), b: HTMLElement = el('b', { text: '0' });
    sub.replaceChildren('오늘 ' + lbl + '실행 ', a, '회 · 변화 있던 실행 ', b, '회');
    countTo(a, prev[0] || 0, rs.length);
    countTo(b, prev[1] || 0, rs.filter(changed).length);
  }

  function paintFeed(): void {
    const rows = runs.filter((r) => inF(r) && changed(r));
    const shown = st.all ? rows : rows.slice(0, FEED_MAX);
    if (!rows.length) {
      keyed(feed, [{ key: 'empty', make: () => el('p', { class: 'cxr-empty', 'data-key': 'empty',
        text: runs.some(inF) ? '오늘은 자동 실행이 돌았지만 바뀐 것이 없습니다.' : '오늘은 아직 자동 실행이 없습니다.' }) }]);
    } else keyed(feed, shown.map((r) => ({ key: r.key, make: () => runRow(r) })));
    more.replaceChildren();
    if (rows.length > FEED_MAX) {
      const btn: HTMLElement = el('button', { type: 'button', text: st.all ? '최근 ' + FEED_MAX + '개만 보기' : '오늘 바뀐 실행 모두 보기 (' + rows.length + ')' });
      btn.addEventListener('click', () => { st.all = !st.all; paintFeed(); });
      more.append(btn);
    }
  }

  function runRow(r: AutoRun): HTMLElement {
    const row: HTMLElement = el('div', { class: 'cxr-row' + (st.open.has(r.key) ? ' is-open' : ''), 'data-key': r.key });
    const btn: HTMLElement = el('button', { type: 'button', class: 'cxr-row-m', 'aria-expanded': String(st.open.has(r.key)) },
      el('span', { class: 'cxr-t', text: hhmm(r.t) }),
      tile(r),
      el('span', { class: 'cxr-n' }, el('b', { text: r.name, title: r.name }), el('span', { class: 'cxr-kt' + (r.kind === 'd' ? ' is-d' : ''), text: r.kind === 'c' ? '수집기' : '증류기' })),
      summary(r),
      chevron());
    const body: HTMLElement = el('div', {});
    row.append(btn, el('div', { class: 'cxr-xp' }, body));
    btn.addEventListener('click', () => {
      if (st.open.has(r.key)) st.open.delete(r.key); else st.open.add(r.key);
      openRow(row, r, st.open.has(r.key));
      paintSel();
    });
    if (st.open.has(r.key)) void fillDetail(body, r);
    return row;
  }
  function openRow(row: HTMLElement, r: AutoRun, open: boolean): void {
    row.classList.toggle('is-open', open);
    row.querySelector('.cxr-row-m')?.setAttribute('aria-expanded', String(open));
    const body = row.querySelector('.cxr-xp > div') as HTMLElement | null;
    if (open && body && !body.dataset.filled) void fillDetail(body, r);
  }
  async function fillDetail(body: HTMLElement, r: AutoRun): Promise<void> {
    body.dataset.filled = '1';
    const xd: HTMLElement = el('div', { class: 'cxr-xd' });
    body.replaceChildren(xd);
    const act: HTMLElement = el('div', { class: 'cxr-act' });
    if (!r.ok) {
      xd.append(el('div', { style: 'grid-column:1/-1' }, el('h6', { text: '무슨 일이 있었나' }), el('div', { text: String(r.err || '실패') })));
    } else if (r.kind === 'd') {
      xd.append(el('div', { class: 'cxr-chain' },
        el('span', {}, '읽은 자료 ', el('b', { text: String(r.read ?? '—') }), '건'), el('i', { text: '→' }),
        el('span', {}, '새 지식 ', el('b', { text: String(r.n) })), el('span', {}, '고친 지식 ', el('b', { text: String(r.mo) }))));
    }
    xd.append(act);
    act.append(el('a', { href: r.href, text: (r.kind === 'c' ? '수집기' : '증류기') + ' 설정 열기 →' }));
    if (!r.detail || !r.ok) return;
    const wait: HTMLElement = el('div', { class: 'admin-hint', style: 'grid-column:1/-1', text: '불러오는 중…' });
    xd.insertBefore(wait, act);
    try {
      const d = await r.detail();
      const news = d.items.filter((i) => i.tag === 'new'), mods = d.items.filter((i) => i.tag === 'mod');
      const list = (arr: RunItem[], empty: string): HTMLElement => el('ul', { class: 'cxr-il' },
        arr.length ? arr.map((i) => el('li', {},
          el('span', { class: 'cxr-tg' + (i.tag === 'mod' ? ' is-mod' : ''), text: i.tag === 'new' ? '새' : (r.kind === 'c' ? '바뀜' : '고침') }),
          i.where ? el('span', { class: 'cxr-wh', text: i.where }) : null,
          el('span', {}, i.href ? el('a', { href: i.href, text: i.title, title: i.title }) : el('span', { text: i.title, title: i.title })))) : [el('li', { class: 'admin-hint', text: empty })]);
      wait.replaceWith(
        el('div', {}, el('h6', { text: (r.kind === 'c' ? '새로 들어온 자료 ' : '새 지식 ') + news.length }), list(news, '없음')),
        el('div', {}, el('h6', { text: (r.kind === 'c' ? '바뀐 자료 ' : '고친 지식 ') + mods.length }), list(mods, '없음')));
      for (const l of d.links) act.append(el('a', { href: l.href, text: l.label }));
    } catch (e) { wait.textContent = '자세한 내용을 불러오지 못했습니다 — ' + (e as Error).message; }
  }

  function setFilter(f: RunFilter): void {
    st.f = f; st.all = false;
    root.setAttribute('data-f', f);
    seg.querySelectorAll('button').forEach((b) => { const on = b.getAttribute('data-f') === f; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
    paintSeg(); paintSub(); paintFeed();
  }
  function paintSeg(): void {
    const b = seg.querySelector(`button[data-f="${st.f}"]`) as HTMLElement | null;
    const ind = seg.querySelector('.cxr-seg-ind') as HTMLElement | null;
    if (!b || !ind || !b.offsetWidth) return;
    ind.style.width = b.offsetWidth + 'px';
    ind.style.transform = `translateX(${b.offsetLeft}px)`;
  }
  //  첫 그림 — 붙은 뒤에야 버튼 폭을 잰다(세그먼트 표시자).
  seg.querySelector('button[data-f="all"]')?.classList.add('is-on');
  paintSub(); paintFeed();
  requestAnimationFrame(() => {
    paintSeg();
    //  좁은 화면(폰)에선 시간 막대가 옆으로 밀린다 — 처음엔 «지금» 쪽을 보인다.
    if (tl.scrollWidth > tl.clientWidth) tl.scrollLeft = tl.scrollWidth;
  });
  const ro = new ResizeObserver(() => paintSeg()); ro.observe(seg);
  return { root, setFilter };
}

// ── 시간 막대 ─────────────────────────────────────────────────────────────
const W = 1200, GUT = 52, PADR = 40, Y = { c: 22, d: 60 } as const, H = 100;
function timeline(runs: AutoRun[], from: number, to: number): SVGElement {
  const span = Math.max(60_000, to - from);
  const x = (t: number): number => GUT + ((t - from) / span) * (W - GUT - PADR);
  const svg: SVGElement = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '오늘 자동 실행 시간 막대' });
  // 시각 눈금 — 한 시간마다(범위가 길면 두 시간마다). 눈금·축은 가라앉힌다.
  const hour = 3_600_000, first = Math.ceil(from / hour) * hour;
  const step = span > 14 * hour ? 2 * hour : hour;
  for (let t = first; t <= to; t += step) {
    const gx = x(t);
    svg.append(sv('line', { class: 't-grid', x1: gx, x2: gx, y1: 6, y2: H - 22 }),
      sv('text', { class: 't-axis', x: gx, y: H - 6, 'text-anchor': 'middle' }, new Date(t).getHours() + '시'));
  }
  for (const k of ['c', 'd'] as const) {
    const y = Y[k];
    const g: SVGElement = sv('g', { class: 't-g is-' + k });
    g.append(sv('text', { class: 't-lane', x: 0, y: y + 4 }, k === 'c' ? '수집' : '증류'),
      sv('line', { class: 't-base', x1: GUT - 6, x2: x(to), y1: y, y2: y }));
    //  겹칠 때 읽히는 순서로 쌓는다 — 바뀐 것 없음(짧은 막대) → 바뀐 실행(점) → 실패(✕). 같은 층에선 최근 것이 위.
    const layer = (q: AutoRun): number => (!q.ok ? 2 : changed(q) ? 1 : 0);
    for (const r of runs.filter((q) => q.kind === k).slice().reverse().sort((a, b) => layer(a) - layer(b))) {
      const cx = x(r.t);
      let mk: SVGElement;
      if (!r.ok) mk = sv('g', { class: 't-mk t-x' }, sv('circle', { cx, cy: y, r: 6.5 }), sv('path', { d: `M${cx - 2.6} ${y - 2.6}l5.2 5.2M${cx + 2.6} ${y - 2.6}l-5.2 5.2` }));
      else if (!changed(r)) mk = sv('rect', { class: 't-mk t-z', x: cx - 1, y: y - 4, width: 2, height: 8, rx: 1 });
      else mk = sv('circle', { class: 't-mk t-' + k, cx, cy: y, r: Math.min(10.5, 4.5 + 1.8 * Math.sqrt(r.n + r.mo)) });
      //  맞히는 자리는 점보다 크게(24px) — 2px 막대를 조준하게 하지 않는다.
      g.append(sv('g', { class: 't-r' + (changed(r) ? ' is-ch' : ''), 'data-k': r.key }, mk, sv('circle', { class: 't-hit', cx, cy: y, r: 12 })));
    }
    svg.append(g);
  }
  const nx = x(to);
  svg.append(sv('line', { class: 't-now', x1: nx, x2: nx, y1: 4, y2: H - 22 }),
    sv('circle', { class: 't-nowd', cx: nx, cy: 4, r: 3.5 }), sv('circle', { class: 't-pulse', cx: nx, cy: 4, r: 3.5 }),
    sv('text', { class: 't-nowl', x: nx + 7, y: 8 }, '지금 ' + hhmm(to)));
  return svg;
}

// ── 조각 ──────────────────────────────────────────────────────────────────
function tile(r: AutoRun): HTMLElement {
  const logo = r.svc ? svcLogo(r.svc) : null;
  const t: HTMLElement = el('span', { class: 'cxr-tile', 'data-svc': r.svc || undefined });
  t.append(logo || lineIcon(r.glyph, 'cxr-gl'));
  return t;
}
function summary(r: AutoRun): HTMLElement {
  const num = (v: number): HTMLElement => v ? el('b', { text: String(v) }) : el('span', { class: 'is-z', text: '0' });
  if (!r.ok) return el('span', { class: 'cxr-s is-fail' }, el('i', { class: 'cxr-xm', 'aria-hidden': 'true', text: '✕' }), '실패 · ' + String(r.err || '').split(' — ')[0].slice(0, 60));
  if (r.kind === 'c') return el('span', { class: 'cxr-s' }, el('span', {}, '새 자료 ', num(r.n), ' · 바뀐 자료 ', num(r.mo)));
  return el('span', { class: 'cxr-s' },
    r.read != null ? el('span', {}, '읽은 자료 ', num(r.read)) : null, r.read != null ? el('span', { class: 'cxr-ar', text: '→' }) : null,
    el('span', {}, '새 지식 ', num(r.n), ' · 고친 지식 ', num(r.mo)));
}
function chevron(): SVGElement {
  return sv('svg', { class: 'cxr-chev', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d: 'M6 9l6 6 6-6' }));
}
function countTo(node: HTMLElement, from: number, to: number): void {
  if (REDUCE() || from === to) { node.textContent = to.toLocaleString(); return; }
  const t0 = performance.now(), dur = 450;
  const step = (now: number): void => {
    const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    node.textContent = Math.round(from + (to - from) * e).toLocaleString();
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const cssEsc = (s: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));

/**
 * 키가 있는 목록 갱신 — 남는 줄은 **같은 노드**를 옮겨 제자리로 미끄러지게(FLIP), 떠나는 줄은 제자리에 띄워 흐리게 한 뒤 치우고,
 *  새 줄은 차례로 올라온다. 컨테이너 높이도 부드럽게 바뀐다. 노드를 다시 만들지 않으니 펼친 줄은 펼친 채로 남는다.
 */
function keyed(box: HTMLElement, items: Array<{ key: string; make: () => HTMLElement }>): void {
  const reduce = REDUCE();
  const old = new Map<string, HTMLElement>();
  for (const n of Array.from(box.children) as HTMLElement[]) if (n.dataset.key) old.set(n.dataset.key, n);
  const boxR = box.getBoundingClientRect();
  const first = new Map<string, DOMRect>();
  old.forEach((n, k) => first.set(k, n.getBoundingClientRect()));
  const next = new Set(items.map((i) => i.key));
  const h0 = box.offsetHeight;
  old.forEach((n, k) => {
    if (next.has(k)) return;
    if (reduce) { n.remove(); return; }
    const r = first.get(k)!;
    Object.assign(n.style, { position: 'absolute', left: (r.left - boxR.left) + 'px', top: (r.top - boxR.top) + 'px', width: r.width + 'px' });
    delete n.dataset.key;
    n.classList.add('cxr-leave');
    setTimeout(() => n.remove(), 220);
  });
  let enter = 0;
  const nodes = items.map((it) => {
    let n = old.get(it.key);
    if (!n) {
      n = it.make();
      if (!reduce) {
        const nn = n;
        nn.classList.add('cxr-enter');
        nn.style.animationDelay = Math.min(enter++ * 32, 260) + 'ms';
        nn.addEventListener('animationend', () => { nn.classList.remove('cxr-enter'); nn.style.animationDelay = ''; }, { once: true });
      }
    }
    return n;
  });
  const leavers = (Array.from(box.children) as HTMLElement[]).filter((n) => !n.dataset.key);
  box.replaceChildren(...nodes, ...leavers);
  if (reduce) return;
  for (const n of nodes) {
    const f = first.get(n.dataset.key || '');
    if (!f) continue;
    const l = n.getBoundingClientRect();
    const dx = f.left - l.left, dy = f.top - l.top;
    if (!dx && !dy) continue;
    n.style.transition = 'none';
    n.style.transform = `translate(${dx}px,${dy}px)`;
    requestAnimationFrame(() => {
      n.style.transition = 'transform .42s cubic-bezier(.2,.8,.2,1)';
      n.style.transform = '';
      n.addEventListener('transitionend', () => { n.style.transition = ''; }, { once: true });
    });
  }
  const h1 = box.offsetHeight;
  if (h0 && h0 !== h1) {
    Object.assign(box.style, { height: h0 + 'px', overflow: 'hidden' });
    requestAnimationFrame(() => { box.style.transition = 'height .38s cubic-bezier(.2,.8,.2,1)'; box.style.height = h1 + 'px'; });
    setTimeout(() => { Object.assign(box.style, { height: '', overflow: '', transition: '' }); }, 420);
  }
}

// ── 데이터 — 서버 한 번(org_auto_runs). 오늘 0시부터. ──────────────────────────
/** 주기 한 줄 — 지도 칩과 같은 말(«10분마다 · 4분 전» · 꺼짐 · 미등록). */
function jobText(job: any): string {
  if (!job) return '미등록';
  if (!job.any_enabled) return '꺼짐';
  const n = Number(job.interval_sec) || 0;
  const every = !n ? '' : n % 3600 === 0 ? n / 3600 + '시간마다' : n % 60 === 0 ? n / 60 + '분마다' : n + '초마다';
  return every + (job.last_run_at ? ' · ' + relTime(job.last_run_at) : ' · 미실행');
}

/** 오늘 자동 실행을 모은다. pipeline 은 지도가 이미 받은 /org/pipeline 응답(주기 표기에만 쓴다). */
export async function loadRuns(pipeline: any): Promise<RunsData> {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const r: any = await api('/api/ui/org/auto-runs?' + new URLSearchParams({ since: midnight.toISOString() }));
  const now = Date.parse(r?.now || '') || Date.now();
  const runs: AutoRun[] = ((r && r.runs) || []).map((x: any): AutoRun => {
    const svc = x.kind === 'c' && x.system ? presetSvcKey(String(x.system)) : null;
    return {
      key: String(x.key), kind: x.kind === 'd' ? 'd' : 'c', machineId: String(x.machine_id), name: String(x.name || ''),
      svc: svc && svcLogo(svc) ? svc : null,
      glyph: x.kind === 'd' ? (x.lane === 'category' ? 'layers' : 'wiki') : 'src',
      t: Date.parse(x.started_at), ok: x.status !== 'error' && x.status !== 'canceled', err: x.error || null,
      n: Number(x.inserted || 0), mo: Number(x.updated || 0), read: x.read == null ? null : Number(x.read),
      href: x.kind === 'd' ? '#/context/distill' : '#/context/sources',
      detail: async () => {
        const d: any = await api('/api/ui/org/auto-runs/' + (x.kind === 'd' ? 'd' : 'c') + '/' + encodeURIComponent(String(x.id)));
        return { items: ((d && d.items) || []) as RunItem[], links: [] };
      },
    };
  }).filter((x: AutoRun) => Number.isFinite(x.t));
  //  가로축 — 빈 새벽을 길게 그리지 않는다: 첫 실행 20분 전부터(최소 6시간 폭, 오늘 0시 이전으로는 안 간다).
  const first = runs.length ? Math.min(...runs.map((x) => x.t)) : now;
  const from = Math.max(midnight.getTime(), Math.min(first - 20 * 60_000, now - 6 * 3_600_000));
  const st = (pipeline && pipeline.stages) || {};
  return { runs, from, to: now, sched: { c: jobText(st.collect?.job), d: jobText(st.distill?.job) } };
}
