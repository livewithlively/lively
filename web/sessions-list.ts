// sessions-list.ts — 세션 이력 앱 「세션 목록」 탭(#4553 안 C, 원준 2026-10-04).
//  앱의 일: 실행 중인 세션과 기록만 남은 세션을 **한 목록**으로 본다. 줄을 누르면 오른쪽에 그 세션의 「기록 보기」(대화록)와
//  「정보」(언제·어디서·무엇을 남겼나)가 열리고, 세션 화면으로 가는 문이 머리에 있다.
//  두 목록을 한 줄로 접는 규칙은 session-history.ts mergeHistoryRows(순수) — 셸의 세션 목록과 같은 규칙이다.
//  모양(원준 2026-10-05 «프로젝트 본문 창 참고해서 그 디자인 언어로»): 왼쪽 카드 = 수가 선 거르개 칩 · 찾기 칸 · 두 줄짜리 줄(이름 /
//   프로젝트 · 상태 알약 · 마지막 활동), 오른쪽 카드 = 머리 하나(타일 · 이름 · 부제 · 도구 · 문) 아래 [기록 보기 | 정보].
import { api, el } from './core.js';
import { mountTranscript, resumeSessionRecord } from './sessions.js';
import { btnOf, dropMySessions, emptyBox, errBox, filterChips, fmtBytes, ibtnOf, ico, leftPanel, loadMySessions, paneHead, routeLink, searchBox, segOf, sessionLink, skelRows } from './sessions-kit.js';
import { histFilter, mergeHistoryRows, type HistFilter, type HistRow } from './session-history.js';
import { findMatcher } from './lib/find.js';
import { whenLabel } from './lib/omni-order.js';
import { rowDotCls } from './session-status.js';

const FILTERS: ReadonlyArray<{ key: HistFilter; label: string }> = [{ key: 'all', label: '전체' }, { key: 'live', label: '실행 중' }, { key: 'off', label: '오프라인' }, { key: 'rec', label: '기록만' }];
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
/** 상태의 색 — 나를 기다리는 것(호박) · 도는 것(파랑) · 끝나 안 본 것(민트) · 기록만(점선) · 그 밖(중립). */
const stateTone = (key: string): string => (key === 'waiting' ? 'wait' : key === 'busy' ? 'busy' : key === 'done' ? 'done' : key === 'log' ? 'log' : key === 'idle' ? 'idle' : 'off');
const tileTone = (key: string): string => (key === 'waiting' ? 'amber' : key === 'busy' ? 'blue' : key === 'done' ? 'mint' : '');

export function mountList(host: HTMLElement): void {
  const input = el('input', { type: 'text', class: 'shx-input', placeholder: '이름·프로젝트로 거르기', value: st.q, 'aria-label': '이름·프로젝트로 거르기', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const count = el('div', { class: 'shx-count', role: 'status' });
  const tbody = el('div', { class: 'shx-tbody', role: 'rowgroup' });
  const thead = el('div', { class: 'shx-thead', role: 'row' });
  const more = el('div', { class: 'shx-tmore', role: 'row', hidden: true });
  /** 줄이 아닌 것(빈 자리 · 받는 중 · 실패 · 더 보기)도 표 안에서는 줄·칸에 담는다 — 표의 자식은 줄이어야 한다. */
  const noteRow = (node: HTMLElement): HTMLElement => el('div', { class: 'shx-trnote', role: 'row' }, el('div', { role: 'cell' }, node)) as HTMLElement;
  const markSel = (x: HTMLElement, on: boolean): void => { x.classList.toggle('sel', on); if (on) x.setAttribute('aria-current', 'true'); else x.removeAttribute('aria-current'); };
  const pane = el('section', { class: 'shx-card shx-pane', 'aria-label': '세션' }) as HTMLElement;
  const refresh = ibtnOf('refresh', '새로 고침');
  let rows: HistRow[] = [];
  const chips = filterChips(FILTERS, st.filter, (v) => { st.filter = v; st.shown = STEP; draw(); }, '세션 거르기');

  host.replaceChildren(el('div', { class: 'shx-split' },
    el('section', { class: 'shx-card shx-master', 'aria-label': '세션 목록' },
      el('div', { class: 'shx-mhead' },
        chips.el,
        el('div', { class: 'shx-srow' }, searchBox(input, () => { st.q = ''; st.shown = STEP; draw(); }), refresh),
        count),
      el('div', { class: 'shx-table', role: 'table', 'aria-label': '세션' }, thead, el('div', { class: 'shx-tscroll' }, tbody, more))),
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
      const b = el('button', { type: 'button', class: 'shx-th' + (on ? ' on' + (st.asc ? ' asc' : ' desc') : ''), title: c.label + ' 순으로' }, el('span', { text: c.label }), on ? ico('chevD') : null);
      b.addEventListener('click', () => {
        //  같은 열을 다시 누르면 방향을 뒤집는다. 처음 누른 열은 글자 열이면 오름차순, 시각 열이면 최근 것부터.
        if (st.sort === c.key) st.asc = !st.asc; else { st.sort = c.key; st.asc = c.key !== 'last'; }
        draw();
      });
      return el('div', { class: 'shx-thc ' + c.key, role: 'columnheader', 'aria-sort': on ? (st.asc ? 'ascending' : 'descending') : 'none' }, b);
    }));
  }
  function draw(): void {
    drawHead();
    const now = Date.now();
    const vis = visible();
    chips.setCounts({ all: rows.length, live: histFilter(rows, 'live').length, off: histFilter(rows, 'off').length, rec: histFilter(rows, 'rec').length });
    count.textContent = st.q || st.filter !== 'all' ? `세션 ${vis.length}개` + (vis.length !== rows.length ? ` · 전체 ${rows.length}개 가운데` : '') : `세션 ${vis.length}개`;
    tbody.replaceChildren(...vis.slice(0, st.shown).map((r) => {
      //  점 — 나를 기다리는 셋(확인 필요 · 작업 중 · 작업 완료)은 색, 열려 있는 세션(대기 중)은 채운 회색, 그 밖은 빈 고리.
      const dot = r.stateKey === 'log' ? 'log' : r.stateKey === 'idle' ? '' : rowDotCls(r.stateKey);
      const proj = r.projectName || (r.projectId != null ? '#' + r.projectId : '');
      const tr = el('div', { class: 'shx-tr', role: 'row', tabindex: '0', 'data-key': r.key },
        el('div', { class: 'shx-td shx-td-name', role: 'cell' }, el('span', { class: 'shx-dot' + (dot ? ' ' + dot : '') }), el('b', { class: 'shx-tname', text: r.name, title: r.name })),
        el('div', { class: 'shx-td shx-td-proj' + (proj ? '' : ' none'), role: 'cell', title: proj }, proj),
        el('div', { class: 'shx-td shx-td-state', role: 'cell' }, el('span', { class: 'shx-state ' + stateTone(r.stateKey), text: r.stateLabel })),
        el('div', { class: 'shx-td shx-td-last', role: 'cell', text: whenLabel(r.lastMs || undefined, now) }));
      markSel(tr as HTMLElement, r.key === st.sel);
      const pick = (): void => { st.sel = r.key; for (const x of Array.from(tbody.children) as HTMLElement[]) markSel(x, x.dataset.key === r.key); openDetail(true); };
      tr.addEventListener('click', pick);
      tr.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      return tr;
    }));
    if (!vis.length) tbody.replaceChildren(noteRow(emptyBox({ icon: 'search', title: rows.length ? '조건에 맞는 세션이 없습니다.' : '세션이 없습니다.', text: rows.length ? '거르개를 풀거나 다른 이름으로 찾아 보세요.' : '' })));
    const left = vis.length - st.shown;
    more.hidden = left <= 0;
    if (left > 0) { const b = btnOf(`더 보기 (${left}개 남음)`, { kind: 'ghost', cls: 'shx-more' }); b.addEventListener('click', () => { st.shown += STEP; draw(); }); more.replaceChildren(el('div', { role: 'cell' }, b)); }
    else more.replaceChildren();
  }

  function infoTable(r: HistRow): HTMLElement {
    const line = (k: string, v: unknown): HTMLElement | null => (v == null || v === '' ? null : el('div', { class: 'shx-kv' }, el('dt', { text: k }), el('dd', {}, v as any)));
    return el('dl', { class: 'shx-info' },
      line('프로젝트', r.projectId != null ? routeLink('#/projects2/p/' + r.projectId, { class: 'shx-link' }, r.projectName || '#' + r.projectId) : '없음'),
      line('상태', r.stateLabel),
      line('만든 때', fmtAt(r.firstMs)),
      line('마지막 활동', fmtAt(r.lastMs)),
      line('대화 크기', fmtBytes(r.bytes)),
      line('하네스', r.harness),
      line('기록 위치', r.convId ? (r.node ? '노드 ' + r.node : '중앙') : null),
      line('첫 지시', r.title)) as HTMLElement;
  }
  function openDetail(scroll = false): void {
    const r = rows.find((x) => x.key === st.sel);
    if (!r) { pane.replaceChildren(emptyBox({ icon: 'sess', big: true, title: '세션을 고르면 기록과 정보가 열립니다', text: '「기록만」 세션은 그 컴퓨터가 꺼져 있어도 읽을 수 있습니다.' })); return; }
    const now = Date.now();
    const body = el('div', { class: 'shx-detail-body' }) as HTMLElement;
    //  머리는 하나 — 대화록은 제 머리를 세우지 않고 이 머리의 도구 자리에 제 단추(목차 · 링크 복사 · 휴지통)만 단다.
    const head = paneHead(r.name, { icon: r.stateKey === 'log' ? 'doc' : 'chat', tone: tileTone(r.stateKey) });
    head.sub.replaceChildren(
      el('span', { class: 'shx-state ' + stateTone(r.stateKey), text: r.stateLabel }),
      el('span', { text: [r.projectName || (r.projectId != null ? '#' + r.projectId : '프로젝트 없음'), whenLabel(r.lastMs || undefined, now)].filter(Boolean).join(' · ') }));
    const tabs = segOf<DetailTab>([{ key: 'rec', label: '기록 보기' }, { key: 'info', label: '정보' }], st.tab, (v) => { st.tab = v; fill(); }, '세션 보기');
    const resume = btnOf('이어 질문하기', { icon: 'chat' });
    resume.addEventListener('click', () => { if (r.convId) void resumeSessionRecord(r.convId, r.node, resume); });
    //  도는 세션·멈춘 박스는 세션 화면으로 간다(멈춘 세션은 그 화면이 열면서 되살린다). 기록만 남은 세션은 기록으로 새 세션을 연다.
    //  세션으로 가는 문은 이 머리에 **하나만** 선다 — 대화록은 「이어 질문하기」를 달지 않는다(noResume).
    if (r.boxId) head.acts.append(sessionLink(r.boxId, { class: 'shx-btn' }, ico('open'), el('span', { class: 'shx-btn-l', text: '세션 열기' })));
    else if (r.convId && r.mine) head.acts.append(resume);
    function fill(): void {
      head.tools.replaceChildren();
      if (st.tab === 'info') {
        body.replaceChildren(el('div', { class: 'shx-infowrap' }, infoTable(r!), ...(r!.convId && r!.mine ? [leftPanel(r!.convId, r!.node)] : [])));
        return;
      }
      if (!r!.convId) { body.replaceChildren(emptyBox({ icon: 'doc', big: true, title: '아직 중앙에 올라온 대화 기록이 없습니다.', text: '세션에서 한 번 주고받으면 여기서 읽을 수 있습니다.' })); return; }
      void mountTranscript(body, { sid: r!.convId, node: r!.node, q: '', ln: '' }, {
        embedded: true, name: r!.name, noResume: true, head,
        rail: r!.mine ? () => leftPanel(r!.convId!, r!.node) : undefined,
        onTrashed: () => { st.sel = ''; dropMySessions(); void load(true); },
      });
    }
    pane.replaceChildren(head.el, el('div', { class: 'shx-ptabs' }, tabs), body);
    fill();
    if (scroll && pane.getBoundingClientRect().top > window.innerHeight * 0.6) pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function load(force: boolean): Promise<void> {
    const mySeq = ++seq;
    if (!force && rowsCache && Date.now() - rowsCache.at < TTL_MS) { rows = rowsCache.rows; draw(); openDetail(); return; }
    count.textContent = '불러오는 중…';
    if (!tbody.childElementCount) tbody.replaceChildren(noteRow(skelRows(7)));
    refresh.disabled = true;
    refresh.classList.add('spin');
    try {
      //  도는 세션 축이 실패해도 기록은 보여 준다(그 반대도) — 둘 다 실패하면 그렇다고 말한다.
      const [live, logs] = await Promise.all([
        api('/api/ui/terminal/sessions?includeProjects=1').then((d: any) => (Array.isArray(d?.sessions) ? d.sessions : [])).catch(() => null),
        loadMySessions(force).then((d) => d.sessions).catch(() => null),
      ]);
      if (mySeq !== seq) return;
      if (!live && !logs) { count.textContent = ''; tbody.replaceChildren(noteRow(errBox('세션 목록을 불러오지 못했습니다.'))); return; }
      rows = mergeHistoryRows(live || [], logs || [], Date.now());
      rowsCache = { at: Date.now(), rows };
      draw();
      openDetail();
      if (!live) count.textContent += ' · 실행 중인 세션을 불러오지 못해 기록만 보여 줍니다';
      else if (!logs) count.textContent += ' · 중앙 기록을 불러오지 못해 실행 중인 세션만 보여 줍니다';
    } finally { refresh.disabled = false; refresh.classList.remove('spin'); }
  }
  refresh.addEventListener('click', () => { void load(true); });
  input.addEventListener('input', () => { st.q = input.value; st.shown = STEP; draw(); });
  void load(false);
}
