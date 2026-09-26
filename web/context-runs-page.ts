// context-runs-page.ts — [맥락 관리 ▸ 자동 실행 기록] 페이지(#4135 3판, 원준 2026-09-26: "자세히보기 같은걸로 보면 페이지 하나 넘어가서
//  거기서는 그냥 목록으로"). 현황 아래 패널의 「자세히 보기 →」 가 같은 기간·거르기를 들고 온다(#/context/runs?from&to&kind&run).
//
//  위키·AI 세션과 같은 문법(#4233 원준 선택 안 A): 빵부스러기 + 도구줄([기간][종류][기계][결과] + 찾기) · 날짜 무리(알약 · 수 · 열 머리) ·
//   행 46px · 줄을 누르면 **오른쪽 사이드 피크**(목록을 덮지 않고 목록이 좁아진다) · ↑↓ 로 이웃 줄, Esc 로 닫기.
//  바뀐 것 없는 실행은 날마다 한 줄로 접는다(«바뀐 것 없는 실행 N회» — 위키 사이드바 «빈 분류 N» 과 같은 방식).
//  데이터: 요약줄·기계 목록 = org_auto_runs_daily(기간 전체 합계) · 목록 = 날마다 org_auto_runs(한 번에 사흘씩, «이전 날짜 더 보기»).
import { el } from './core.js';
import {
  type AutoRun, type DayAgg, type Machine, type RunFilter, type RunDetail,
  DAY, KEEP_DAYS, addDays, calendarPop, changed, fetchDaily, fetchDay, fetchDetail, hhmm, kindTag, md, mdw, menuPop, parseYmd,
  dayOf, relDay, runSummary, runTile, today0, ymd,
} from './context-runs.js';

type Result = 'all' | 'changed' | 'fail';
const CHUNK = 3;
const ENOUGH = 12;   // 거르기가 걸려 있으면 이만큼 줄이 찰 때까지 이전 날짜를 이어 받는다(빈 화면에 «더 보기»만 남지 않게)
const durText = (sec: number | null): string => (sec == null ? '—' : sec < 60 ? sec + '초' : Math.round(sec / 60) + '분');

export async function renderRunsPage(host: HTMLElement): Promise<void> {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const t0 = today0(), min0 = addDays(t0, -(KEEP_DAYS - 1));
  const clampDay = (d: number | null, dflt: number): number => Math.min(t0, Math.max(min0, d ?? dflt));
  const st = {
    to: clampDay(parseYmd(q.get('to')), t0),
    from: 0,
    kind: (['c', 'd'].includes(q.get('kind') || '') ? q.get('kind') : 'all') as RunFilter,
    mach: q.get('machine') || null as string | null,
    result: (['changed', 'fail'].includes(q.get('result') || '') ? q.get('result') : 'all') as Result,
    q: q.get('q') || '',
    sel: q.get('run') || null as string | null,
    shown: CHUNK,
    open: new Set<number>(),
  };
  st.from = Math.min(st.to, clampDay(parseYmd(q.get('from')), addDays(st.to, -6)));

  const cache = new Map<number, AutoRun[] | 'loading' | Error>();
  let daily: { days: DayAgg[]; machines: Machine[] } | null = null;
  let dailyErr = false;

  // ── 뼈대 ──
  const crumb: HTMLElement = el('nav', { class: 'cxrp-crumb', 'aria-label': '위치' },
    el('a', { href: '#/context/home', text: '맥락 관리' }), el('i', { text: '/' }),
    el('a', { href: '#/context/home', text: '현황' }), el('i', { text: '/' }), el('b', { text: '자동 실행 기록' }));
  const dd = (label: string): { btn: HTMLButtonElement; v: HTMLElement } => {
    const v: HTMLElement = el('span', { class: 'v' });
    const btn: HTMLButtonElement = el('button', { type: 'button', class: 'cxrp-dd', 'aria-haspopup': 'listbox' }, label + ' ', v, el('span', { class: 'cv', 'aria-hidden': 'true', text: '⌄' }));
    return { btn, v };
  };
  const dRange = dd('기간'), dKind = dd('종류'), dMach = dd('기계'), dRes = dd('결과');
  const find: HTMLInputElement = el('input', { type: 'search', placeholder: '기계 이름·실패 사정 찾기', 'aria-label': '찾기', value: st.q });
  const tools: HTMLElement = el('div', { class: 'cxrp-tools' }, dRange.btn, dKind.btn, dMach.btn, dRes.btn,
    el('label', { class: 'cxrp-find' }, el('span', { 'aria-hidden': 'true', text: '⌕' }), find));
  const sum: HTMLElement = el('div', { class: 'cxrp-sum' });
  const list: HTMLElement = el('div', { class: 'cxrp-list' });
  const inner: HTMLElement = el('div', { class: 'cxrp-in' }, crumb, tools, sum, list);
  const peek: HTMLElement = el('aside', { class: 'cxrp-peek', 'aria-label': '실행 자세히' });
  const page: HTMLElement = el('div', { class: 'cxrp' }, inner, peek);
  host.replaceChildren(page);

  // ── 주소 — 거르기·고른 줄을 주소에 남긴다(새로고침·공유해도 같은 화면). 라우터는 다시 부르지 않는다(replaceState). ──
  const syncUrl = (): void => {
    const p = new URLSearchParams({ from: ymd(st.from), to: ymd(st.to) });
    if (st.kind !== 'all') p.set('kind', st.kind);
    if (st.mach) p.set('machine', st.mach);
    if (st.result !== 'all') p.set('result', st.result);
    if (st.q) p.set('q', st.q);
    if (st.sel) p.set('run', st.sel);
    try { history.replaceState(history.state, '', '#/context/runs?' + p.toString()); } catch { /* 액자 안 등 — 주소 동기화는 덤 */ }
  };

  // ── 도구줄 ──
  dRange.btn.addEventListener('click', () => calendarPop(dRange.btn, { range: true, sel: [st.from, st.to], onPick: (s, e) => {
    st.from = s; st.to = e; st.shown = CHUNK; st.open.clear(); daily = null; dailyErr = false; void refresh();
  } }));
  dKind.btn.addEventListener('click', () => menuPop<RunFilter>(dKind.btn, [
    { value: 'all', label: '전체' }, { value: 'c', label: '수집기', icon: el('i', { class: 'cxr-dot' }) }, { value: 'd', label: '증류기', icon: el('i', { class: 'cxr-dot is-d' }) },
  ], st.kind, (v) => { st.kind = v; if (st.mach && machines().find((m) => m.id === st.mach)?.kind !== v && v !== 'all') st.mach = null; void topUp(); }));
  dMach.btn.addEventListener('click', () => menuPop<string | null>(dMach.btn, [
    { value: null, label: '모든 기계' },
    ...machines().filter((m) => st.kind === 'all' || m.kind === st.kind).map((m) => ({ value: m.id, label: m.name, icon: runTile({ svc: m.svc, glyph: m.kind === 'd' ? 'wiki' : 'src' }, true), note: m.kind === 'c' ? '수집기' : '증류기' })),
  ], st.mach, (v) => { st.mach = v; void topUp(); }));
  dRes.btn.addEventListener('click', () => menuPop<Result>(dRes.btn, [
    { value: 'all', label: '전체' }, { value: 'changed', label: '바뀐 것만' }, { value: 'fail', label: '실패만' },
  ], st.result, (v) => { st.result = v; void topUp(); }));
  let qTimer: any = null;
  find.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { st.q = find.value.trim(); void topUp(); }, 160); });

  const machines = (): Machine[] => {
    if (daily?.machines.length) return daily.machines;
    const m = new Map<string, Machine>();
    for (const v of cache.values()) if (Array.isArray(v)) for (const r of v) m.set(r.kind + r.machineId, { id: r.machineId, kind: r.kind, name: r.name, svc: r.svc });
    return [...m.values()];
  };
  const pass = (r: AutoRun): boolean => {
    if (st.kind !== 'all' && r.kind !== st.kind) return false;
    if (st.mach && r.machineId !== st.mach) return false;
    if (st.result === 'changed' && !(r.ok && changed(r))) return false;
    if (st.result === 'fail' && r.ok) return false;
    if (st.q) { const s = st.q.toLowerCase(); if (!r.name.toLowerCase().includes(s) && !String(r.err || '').toLowerCase().includes(s)) return false; }
    return true;
  };
  const daysDesc = (): number[] => { const out: number[] = []; for (let d = st.to; d >= st.from; d = addDays(d, -1)) out.push(d); return out; };
  /** 기록이 있는 날만(합계를 받았으면) — 빈 날은 무리를 세우지 않는다. 종류·«실패만» 은 합계로 미리 거른다(그날 줄을 받을 필요도 없게). */
  const daysWithRuns = (): number[] => {
    if (!daily) return daysDesc();
    const n = (x: DayAgg, f: 'runs' | 'failed'): number => (st.kind !== 'd' ? x.c[f] : 0) + (st.kind !== 'c' ? x.d[f] : 0);
    const has = new Set(daily.days.filter((x) => n(x, st.result === 'fail' ? 'failed' : 'runs') > 0).map((x) => x.day));
    return daysDesc().filter((d) => has.has(d));
  };
  const filtering = (): boolean => st.kind !== 'all' || !!st.mach || st.result !== 'all' || !!st.q;
  const visibleRows = (): number => daysWithRuns().slice(0, st.shown).reduce((a, d) => { const v = cache.get(d); return a + (Array.isArray(v) ? v.filter(pass).filter((r) => changed(r) || st.open.has(d)).length : 0); }, 0);

  // ── 요약줄 · 도구줄 값 ──
  function paintTools(): void {
    const span = Math.round((st.to - st.from) / DAY) + 1;
    dRange.v.textContent = span === 1 ? mdw(st.to) + (relDay(st.to) ? ' · ' + relDay(st.to) : '') : md(st.from) + ' – ' + md(st.to) + ` (${span}일)`;
    dKind.v.textContent = { all: '전체', c: '수집기', d: '증류기' }[st.kind];
    dMach.v.textContent = st.mach ? (machines().find((m) => m.id === st.mach)?.name.split(' — ')[0] || '고른 기계') : '모든 기계';
    dRes.v.textContent = { all: '전체', changed: '바뀐 것만', fail: '실패만' }[st.result];
    [dKind.btn, dMach.btn, dRes.btn].forEach((b, i) => b.classList.toggle('is-on', [st.kind !== 'all', !!st.mach, st.result !== 'all'][i]));
    sum.replaceChildren();
    if (!daily) { sum.append(el('span', { class: 'cxr-sub', text: dailyErr ? '합계를 불러오지 못했습니다 — 목록은 날마다 따로 불러옵니다' : '합계를 세는 중…' })); return; }
    const k = (kk: 'c' | 'd', f: 'runs' | 'inserted' | 'updated' | 'failed'): number => daily!.days.reduce((a, x) => a + x[kk][f], 0);
    const useC = st.kind !== 'd', useD = st.kind !== 'c';
    const runs = (useC ? k('c', 'runs') : 0) + (useD ? k('d', 'runs') : 0), fails = (useC ? k('c', 'failed') : 0) + (useD ? k('d', 'failed') : 0);
    sum.append(el('b', { class: 'num', text: runs.toLocaleString() + '회 실행' }));
    if (useC) sum.append(el('span', {}, '새 자료 ', el('b', { class: 'num', text: k('c', 'inserted').toLocaleString() }), ' · 바뀐 자료 ', el('b', { class: 'num', text: k('c', 'updated').toLocaleString() })));
    if (useD) sum.append(el('span', {}, '새 지식 ', el('b', { class: 'num', text: k('d', 'inserted').toLocaleString() }), ' · 고친 지식 ', el('b', { class: 'num', text: k('d', 'updated').toLocaleString() })));
    if (fails) sum.append(el('span', { class: 'is-fail', text: '실패 ' + fails.toLocaleString() + '회' }));
    if (st.mach || st.result !== 'all' || st.q) sum.append(el('span', { class: 'cxr-sub', text: '· 목록은 거른 조건에 맞는 것만' }));
  }

  // ── 목록 ──
  const rowEl = (r: AutoRun): HTMLElement => {
    const row: HTMLElement = el('div', { class: 'cxrp-row' + (st.sel === r.key ? ' is-sel' : ''), role: 'button', tabindex: '0', 'data-key': r.key },
      el('span', { class: 'cxrp-t num', text: hhmm(r.t) }),
      el('span', { class: 'cxrp-m' }, runTile(r, true), el('b', { text: r.name, title: r.name }), kindTag(r.kind)),
      el('span', { class: 'cxrp-w' }, runSummary(r)),
      el('span', { class: 'cxrp-res ' + (r.ok ? 'is-ok' : 'is-fail'), text: r.ok ? '성공' : '실패' }),
      el('span', { class: 'cxrp-dur num', text: durText(r.dur) }));
    const open = (): void => { st.sel = st.sel === r.key ? null : r.key; syncUrl(); paintSel(); };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return row;
  };
  function paint(): void {
    syncUrl(); paintTools();
    const days = daysWithRuns();
    const shown = days.slice(0, st.shown);
    const out: HTMLElement[] = [];
    let any = false;
    for (const d of shown) {
      const v = cache.get(d);
      const head = (counts: HTMLElement | null): HTMLElement => el('div', { class: 'cxrp-gh' },
        el('span', { class: 'cxrp-day' }, el('span', { class: 'cxrp-pill', text: mdw(d) + (relDay(d) ? ' · ' + relDay(d) : '') }), counts),
        el('span', { class: 'cxrp-ch', text: '무엇이 바뀌었나' }), el('span', { class: 'cxrp-ch', text: '결과' }), el('span', { class: 'cxrp-ch is-r', text: '걸린 시간' }));
      if (!v || v === 'loading') { out.push(head(null), el('div', { class: 'cxrp-wait', text: '불러오는 중…' })); any = true; continue; }
      if (v instanceof Error) { out.push(head(null), el('div', { class: 'cxrp-wait', text: '이날 기록을 불러오지 못했습니다 — ' + v.message })); any = true; continue; }
      const rs = v.filter(pass);
      if (!rs.length) continue;
      any = true;
      const ch = rs.filter(changed), zero = rs.filter((r) => !changed(r)), fails = rs.filter((r) => !r.ok).length;
      out.push(head(el('span', { class: 'cxrp-cnt' }, `실행 ${rs.length} · 변화 ${ch.length - fails}`, fails ? el('span', { class: 'is-fail', text: ` · 실패 ${fails}` }) : null)));
      for (const r of ch) out.push(rowEl(r));
      if (zero.length) {
        const opened = st.open.has(d);
        const fold: HTMLElement = el('button', { type: 'button', class: 'cxrp-fold', 'aria-expanded': String(opened) },
          el('span', { class: 'ticks', 'aria-hidden': 'true' }, ...Array.from({ length: Math.min(12, zero.length) }, () => el('i', {}))),
          `바뀐 것 없는 실행 ${zero.length.toLocaleString()}회 — ${opened ? '접기' : '펼치기'}`);
        fold.addEventListener('click', () => { opened ? st.open.delete(d) : st.open.add(d); paint(); });
        out.push(fold);
        if (opened) for (const r of zero.slice(0, 300)) out.push(rowEl(r));
      }
    }
    const rest = days.length - shown.length;
    if (rest > 0) {
      const b: HTMLElement = el('button', { type: 'button', class: 'cxr-btn', text: `이전 날짜 더 보기 (${rest}일)` });
      b.addEventListener('click', () => { st.shown += CHUNK; void topUp(); });
      out.push(el('div', { class: 'cxrp-loadmore' }, b));
    }
    if (!any) out.push(el('p', { class: 'cxr-empty', text: daily || dailyErr ? '이 조건에 맞는 실행이 없어요.' : '불러오는 중…' }));
    list.replaceChildren(...out);
    paintSel();
  }

  // ── 사이드 피크 ──
  const detailCache = new Map<string, RunDetail | Error>();
  const findRun = (key: string): AutoRun | null => { for (const v of cache.values()) if (Array.isArray(v)) { const r = v.find((x) => x.key === key); if (r) return r; } return null; };
  function paintSel(): void {
    list.querySelectorAll('.cxrp-row').forEach((x) => x.classList.toggle('is-sel', x.getAttribute('data-key') === st.sel));
    const r = st.sel ? findRun(st.sel) : null;
    page.classList.toggle('has-peek', !!r);
    if (!r) { peek.replaceChildren(); return; }
    const nav = (dir: number): void => {
      const keys = [...list.querySelectorAll('.cxrp-row')].map((x) => x.getAttribute('data-key') || '');
      const n = keys[keys.indexOf(st.sel || '') + dir];
      if (n) { st.sel = n; syncUrl(); paintSel(); list.querySelector(`.cxrp-row[data-key="${n}"]`)?.scrollIntoView({ block: 'nearest' }); }
    };
    const ib = (label: string, text: string, fn: () => void): HTMLElement => { const b: HTMLElement = el('button', { type: 'button', class: 'cxrp-ib', title: label, 'aria-label': label, text }); b.addEventListener('click', fn); return b; };
    const k = r.kind, cat = r.lane === 'category';
    const kv: Array<[string, string]> = k === 'c'
      ? [[String(r.n), '새 자료'], [String(r.mo), '바뀐 자료'], [durText(r.dur), '걸린 시간'], [r.ok ? '성공' : '실패', '결과']]
      : cat ? [[String(r.read ?? 0), '읽은 지식'], [String(r.mo), '카테고리 붙임'], [durText(r.dur), '걸린 시간'], [r.ok ? '성공' : '실패', '결과']]
      : [[String(r.read ?? 0), '읽은 자료'], [String(r.n), '새 지식'], [String(r.mo), '고친 지식'], [durText(r.dur), '걸린 시간']];
    const bodyEl: HTMLElement = el('div', { class: 'cxrp-pk-b' }, el('div', { class: 'cxrp-kv' }, ...kv.map(([v, l]) => el('div', {}, el('b', { class: 'num', text: v }), el('span', { text: l })))));
    if (!r.ok) bodyEl.append(el('h5', { text: '무슨 일이 있었나' }), el('p', { class: 'cxrp-err', text: String(r.err || '실패') }));
    const detailHost: HTMLElement = el('div', {}, el('p', { class: 'cxr-sub', text: '불러오는 중…' }));
    bodyEl.append(detailHost);
    peek.replaceChildren(el('div', { class: 'cxrp-pk' },
      el('div', { class: 'cxrp-pk-h' }, runTile(r),
        el('div', { class: 'nm' }, el('b', { text: r.name }), el('span', { text: `${mdw(r.t)} ${hhmm(r.t)} · ${k === 'c' ? '수집기' : '증류기'} · 자동 실행` })),
        el('div', { class: 'sp' }, ib('이전 줄(↑)', '↑', () => nav(-1)), ib('다음 줄(↓)', '↓', () => nav(1)), ib('닫기(Esc)', '✕', () => { st.sel = null; syncUrl(); paintSel(); }))),
      bodyEl,
      el('div', { class: 'cxrp-pk-f' }, el('a', { class: 'cxr-btn', href: k === 'c' ? '#/context/sources' : '#/context/distill', text: (k === 'c' ? '수집기' : '증류기') + ' 설정 열기 →' }))));
    const fill = (d: RunDetail | Error): void => {
      if (st.sel !== r.key) return;
      if (d instanceof Error) { detailHost.replaceChildren(el('p', { class: 'cxr-sub', text: '자세한 내용을 불러오지 못했습니다 — ' + d.message })); return; }
      const news = d.items.filter((i) => i.tag === 'new'), mods = d.items.filter((i) => i.tag === 'mod');
      const ul = (arr: RunDetail['items'], empty: string): HTMLElement => el('ul', { class: 'cxrp-il' }, ...(arr.length ? arr.map((i) => el('li', {},
        el('span', { class: 'cxrp-tg' + (i.tag === 'mod' ? ' is-mod' : ''), text: i.tag === 'new' ? '새' : k === 'c' ? '바뀜' : cat ? '칸' : '고침' }),
        i.where ? el('span', { class: 'cxrp-wh', text: i.where }) : null,
        i.href ? el('a', { href: i.href, text: i.title, title: i.title }) : el('span', { text: i.title }))) : [el('li', { class: 'is-empty', text: empty })]));
      const out: HTMLElement[] = [];
      if (r.ok) {
        if (k === 'c') out.push(el('h5', { text: `새로 들어온 자료 ${news.length}` }), ul(news, '없음'), el('h5', { text: `바뀐 자료 ${mods.length}` }), ul(mods, '없음'));
        else if (cat) out.push(el('h5', { text: `카테고리를 붙인 지식 ${mods.length}` }), ul(mods, '없음'));
        else out.push(el('h5', { text: `새로 만든 지식 ${news.length}` }), ul(news, '없음'), el('h5', { text: `고친 지식 ${mods.length}` }), ul(mods, '없음'));
      }
      if (k === 'c' && d.log) out.push(el('h5', { text: '로그(끝부분)' }), el('pre', { class: 'cxrp-log', text: d.log.split('\n').slice(-14).join('\n') }));
      if (k === 'd') out.push(el('h5', { text: '그때의 세션 — AI 의 마지막 말' }),
        d.summary ? el('p', { class: 'cxrp-said', text: d.summary }) : el('p', { class: 'cxr-sub', text: '배치 AI 의 마지막 말은 그 증류기의 실행 계정과 관리자만 봅니다(읽은 자료 내용이 담길 수 있어서).' }));
      detailHost.replaceChildren(...out);
    };
    const hit = detailCache.get(r.key);
    if (hit) fill(hit);
    else fetchDetail(r).then((d) => { detailCache.set(r.key, d); fill(d); }, (e) => { const er = e as Error; detailCache.set(r.key, er); fill(er); });
  }
  const onKey = (e: KeyboardEvent): void => {
    if (!page.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (!st.sel || (e.target as HTMLElement)?.closest?.('input,textarea')) return;
    if (e.key === 'Escape') { st.sel = null; syncUrl(); paintSel(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const keys = [...list.querySelectorAll('.cxrp-row')].map((x) => x.getAttribute('data-key') || '');
    const n = keys[keys.indexOf(st.sel) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (n) { st.sel = n; syncUrl(); paintSel(); list.querySelector(`.cxrp-row[data-key="${n}"]`)?.scrollIntoView({ block: 'nearest' }); }
  };
  document.addEventListener('keydown', onKey);

  // ── 불러오기 ──
  async function ensureLoaded(): Promise<void> {
    const want = daysWithRuns().slice(0, st.shown).filter((d) => !cache.has(d));
    if (!want.length) return;
    for (const d of want) cache.set(d, 'loading');
    paint();
    await Promise.all(want.map((d) => fetchDay(d).then((rs) => { cache.set(d, rs); }, (e) => { cache.set(d, e instanceof Error ? e : new Error(String(e))); })));
    paint();
  }
  /** 거르기가 걸려 있으면 줄이 ENOUGH 개 찰 때까지(또는 기간 끝까지) 사흘씩 더 받는다. */
  async function topUp(): Promise<void> {
    paint();
    await ensureLoaded();
    while (filtering() && visibleRows() < ENOUGH && st.shown < daysWithRuns().length && page.isConnected) { st.shown += CHUNK; await ensureLoaded(); }
    paint();
  }
  async function refresh(): Promise<void> {
    paint();
    try { daily = await fetchDaily(st.from, st.to); dailyErr = false; } catch { daily = null; dailyErr = true; }
    await topUp();
    // 링크로 연 줄이 «바뀐 것 없는 실행» 이면 그날 접힌 줄을 펴 둔다(↑↓ 로 이웃 줄을 오갈 수 있게)
    const r0 = st.sel ? findRun(st.sel) : null;
    if (r0 && !changed(r0) && !st.open.has(dayOf(r0.t))) { st.open.add(dayOf(r0.t)); paint(); }
    if (st.sel) list.querySelector(`.cxrp-row[data-key="${st.sel}"]`)?.scrollIntoView({ block: 'center' });
  }
  await refresh();
}
