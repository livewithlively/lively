// sessions-list.ts — 세션 이력 앱 「세션 목록」 탭(#4553 안 C, 원준 2026-10-04).
//  앱의 일: 실행 중인 세션과 기록만 남은 세션을 **한 목록**으로 본다. 줄을 누르면 오른쪽에 그 세션의 「기록 보기」(대화록)와
//  「정보」(언제·어디서·무엇을 남겼나)가 열리고, 세션 화면으로 가는 문이 머리에 있다.
//  두 목록을 한 줄로 접는 규칙은 session-history.ts mergeHistoryRows(순수) — 셸의 세션 목록과 같은 규칙이다.
import { api, el } from './core.js';
import { mountTranscript, resumeSessionRecord } from './sessions.js';
import { dropMySessions, fmtBytes, leftPanel, loadMySessions, routeLink, segOf, sessionLink } from './sessions-kit.js';
import { histFilter, mergeHistoryRows, type HistFilter, type HistRow } from './session-history.js';
import { findMatcher } from './lib/find.js';
import { whenLabel } from './lib/omni-order.js';
import { rowDotCls } from './session-status.js';

const FILTERS: ReadonlyArray<{ key: HistFilter; label: string }> = [{ key: 'all', label: '전체' }, { key: 'live', label: '실행 중' }, { key: 'rec', label: '기록만' }];
type SortCol = 'name' | 'proj' | 'state' | 'last';
type DetailTab = 'rec' | 'info';
const COLS: ReadonlyArray<{ key: SortCol; label: string }> = [
  { key: 'name', label: '세션' }, { key: 'proj', label: '프로젝트' }, { key: 'state', label: '상태' }, { key: 'last', label: '마지막 활동' },
];
const STEP = 100;
const st = { filter: 'all' as HistFilter, q: '', sort: 'last' as SortCol, asc: false, sel: '' as string, tab: 'rec' as DetailTab, shown: STEP };
let rowsCache: { at: number; rows: HistRow[] } | null = null;
const TTL_MS = 20_000;
let seq = 0;

const cmp = (a: HistRow, b: HistRow, col: SortCol): number => {
  if (col === 'name') return a.name.localeCompare(b.name, 'ko');
  if (col === 'proj') return String(a.projectName || '￿').localeCompare(String(b.projectName || '￿'), 'ko');
  if (col === 'state') return a.stateLabel.localeCompare(b.stateLabel, 'ko');
  return a.lastMs - b.lastMs;
};
const fmtAt = (ms: number): string => (ms ? new Date(ms).toLocaleString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '모름');

export function mountList(host: HTMLElement): void {
  const input = el('input', { type: 'text', class: 'shx-input', placeholder: '이름·프로젝트로 거르기', value: st.q, 'aria-label': '이름·프로젝트로 거르기' }) as HTMLInputElement;
  const count = el('div', { class: 'shx-count', role: 'status' });
  const tbody = el('tbody');
  const thead = el('tr');
  const more = el('div');
  const pane = el('div', { class: 'shx-pane' });
  const refresh = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '새로 고침' }) as HTMLButtonElement;
  let rows: HistRow[] = [];

  host.replaceChildren(el('div', { class: 'shx-cols' },
    el('div', { class: 'shx-col' },
      el('div', { class: 'shx-bar' }, segOf(FILTERS, st.filter, (v) => { st.filter = v; st.shown = STEP; draw(); }, '세션 거르기'), el('span', { class: 'shx-grow' }), refresh),
      input, count,
      el('div', { class: 'shx-tablewrap' }, el('table', { class: 'shx-table' }, el('thead', {}, thead), tbody)),
      more),
    pane));

  const visible = (): HistRow[] => {
    const match = findMatcher(st.q);
    const out = histFilter(rows, st.filter).filter((r) => match(r.name, r.projectName, r.title));
    out.sort((a, b) => (st.asc ? 1 : -1) * cmp(a, b, st.sort) || b.lastMs - a.lastMs);
    return out;
  };
  function drawHead(): void {
    thead.replaceChildren(...COLS.map((c) => {
      const on = st.sort === c.key;
      const b = el('button', { type: 'button', class: 'shx-th' + (on ? ' on' : ''), text: c.label + (on ? (st.asc ? ' ↑' : ' ↓') : '') });
      b.addEventListener('click', () => {
        //  같은 열을 다시 누르면 방향을 뒤집는다. 처음 누른 열은 글자 열이면 오름차순, 시각 열이면 최근 것부터.
        if (st.sort === c.key) st.asc = !st.asc; else { st.sort = c.key; st.asc = c.key !== 'last'; }
        draw();
      });
      return el('th', { scope: 'col', 'aria-sort': on ? (st.asc ? 'ascending' : 'descending') : 'none' }, b);
    }));
  }
  function draw(): void {
    drawHead();
    const now = Date.now();
    const vis = visible();
    const live = rows.filter((r) => r.alive).length;
    count.textContent = `세션 ${vis.length}개` + (st.filter === 'all' && !st.q ? ` · 실행 중 ${live} · 기록만 ${histFilter(rows, 'rec').length}` : '');
    tbody.replaceChildren(...vis.slice(0, st.shown).map((r) => {
      const dot = rowDotCls(r.stateKey);
      const tr = el('tr', { class: 'shx-tr' + (r.key === st.sel ? ' sel' : ''), tabindex: '0', 'data-key': r.key },
        el('td', { class: 'shx-td-name' }, el('b', { text: r.name })),
        el('td', { text: r.projectName || (r.projectId != null ? '#' + r.projectId : '') }),
        el('td', {}, el('span', { class: 'shx-dot ' + (r.stateKey === 'log' ? 'log' : dot) }), r.stateLabel),
        el('td', { text: whenLabel(r.lastMs || undefined, now) }));
      const pick = (): void => { st.sel = r.key; for (const x of Array.from(tbody.children) as HTMLElement[]) x.classList.toggle('sel', x.dataset.key === r.key); openDetail(true); };
      tr.addEventListener('click', pick);
      tr.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      return tr;
    }));
    if (!vis.length) tbody.replaceChildren(el('tr', {}, el('td', { colspan: '4', class: 'admin-hint', text: rows.length ? '조건에 맞는 세션이 없습니다.' : '세션이 없습니다.' })));
    more.replaceChildren(...(vis.length > st.shown ? [el('button', { class: 'btn btn-ghost btn-sm shx-more', type: 'button', text: `더 보기 (${vis.length - st.shown}개 남음)`, onclick: () => { st.shown += STEP; draw(); } })] : []));
  }

  function infoTable(r: HistRow): HTMLElement {
    const line = (k: string, v: unknown): HTMLElement | null => (v == null || v === '' ? null : el('tr', {}, el('th', { scope: 'row', text: k }), el('td', {}, v as any)));
    return el('table', { class: 'shx-info' }, el('tbody', {},
      line('프로젝트', r.projectId != null ? routeLink('#/projects2/p/' + r.projectId, {}, r.projectName || '#' + r.projectId) : '없음'),
      line('상태', r.stateLabel),
      line('만든 때', fmtAt(r.firstMs)),
      line('마지막 활동', fmtAt(r.lastMs)),
      line('대화 크기', fmtBytes(r.bytes)),
      line('하네스', r.harness),
      line('기록 위치', r.convId ? (r.node ? '노드 ' + r.node : '중앙') : null),
      line('첫 지시', r.title)));
  }
  function openDetail(scroll = false): void {
    const r = rows.find((x) => x.key === st.sel);
    if (!r) { pane.replaceChildren(el('p', { class: 'admin-hint shx-pane-empty', text: '왼쪽에서 세션을 누르면 기록과 정보가 열립니다. 「기록만」 세션은 그 컴퓨터가 꺼져 있어도 읽을 수 있습니다.' })); return; }
    const body = el('div', { class: 'shx-detail-body' });
    const tabs = segOf<DetailTab>([{ key: 'rec', label: '기록 보기' }, { key: 'info', label: '정보' }], st.tab, (v) => { st.tab = v; fill(); }, '세션 보기');
    const resume = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '이어 질문하기' }) as HTMLButtonElement;
    resume.addEventListener('click', () => { if (r.convId) void resumeSessionRecord(r.convId, r.node, resume); });
    const head = el('div', { class: 'shx-bar' }, tabs, el('span', { class: 'shx-grow' }),
      //  도는 세션·멈춘 박스는 세션 화면으로 간다(멈춘 세션은 그 화면이 열면서 되살린다). 기록만 남은 세션은 기록으로 새 세션을 연다.
      //  세션으로 가는 문은 이 머리에 **하나만** 선다 — 아래 대화록 머리의 「이어 질문하기」는 달지 않는다(noResume).
      r.boxId ? sessionLink(r.boxId, { class: 'btn btn-primary btn-sm' }, '세션 열기') : null,
      !r.boxId && r.convId && r.mine ? resume : null);
    function fill(): void {
      if (st.tab === 'info') {
        body.replaceChildren(el('h3', { class: 'shx-detail-title', text: r!.name }), infoTable(r!), ...(r!.convId && r!.mine ? [leftPanel(r!.convId, r!.node)] : []));
        return;
      }
      if (!r!.convId) { body.replaceChildren(el('p', { class: 'admin-hint', text: '아직 중앙에 올라온 대화 기록이 없습니다. 세션에서 한 번 주고받으면 여기서 읽을 수 있습니다.' })); return; }
      void mountTranscript(body, { sid: r!.convId, node: r!.node, q: '', ln: '' }, {
        embedded: true, name: r!.name, noResume: true,
        onTrashed: () => { st.sel = ''; dropMySessions(); void load(true); },
      });
    }
    pane.replaceChildren(head, body);
    fill();
    if (scroll && pane.getBoundingClientRect().top > window.innerHeight * 0.6) pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function load(force: boolean): Promise<void> {
    const mySeq = ++seq;
    if (!force && rowsCache && Date.now() - rowsCache.at < TTL_MS) { rows = rowsCache.rows; draw(); openDetail(); return; }
    count.textContent = '불러오는 중…';
    refresh.disabled = true;
    try {
      //  도는 세션 축이 실패해도 기록은 보여 준다(그 반대도) — 둘 다 실패하면 그렇다고 말한다.
      const [live, logs] = await Promise.all([
        api('/api/ui/terminal/sessions?includeProjects=1').then((d: any) => (Array.isArray(d?.sessions) ? d.sessions : [])).catch(() => null),
        loadMySessions(force).then((d) => d.sessions).catch(() => null),
      ]);
      if (mySeq !== seq) return;
      if (!live && !logs) { count.textContent = ''; tbody.replaceChildren(el('tr', {}, el('td', { colspan: '4', class: 'install-token-err', text: '세션 목록을 불러오지 못했습니다.' }))); return; }
      rows = mergeHistoryRows(live || [], logs || [], Date.now());
      rowsCache = { at: Date.now(), rows };
      draw();
      openDetail();
      if (!live) count.textContent += ' · 실행 중인 세션을 불러오지 못해 기록만 보여 줍니다';
      else if (!logs) count.textContent += ' · 중앙 기록을 불러오지 못해 실행 중인 세션만 보여 줍니다';
    } finally { refresh.disabled = false; }
  }
  refresh.addEventListener('click', () => { void load(true); });
  input.addEventListener('input', () => { st.q = input.value; st.shown = STEP; draw(); });
  void load(false);
}
