// sessions-app.ts — 「세션 이력」 앱(#4553, 원준 2026-10-04 «A,B,C안을 … 상위 가로탭으로 만들어가지고 셋 다 구현해»).
//  `#/sessions[?tab=find|journal|list&q=…]` — 가로탭 셋: 「대화 찾기」 · 「작업 일지」 · 「세션 목록」.
//  `#/sessions/<sid>[?node=&q=&ln=]` — 대화록 단독 화면(공유 링크 · 통합검색이 모르는 세션을 열 때). 종전 그대로다(sessions.ts).
//
//  종전 목록면은 내 세션을 15개씩 넘겨 보는 한 장이었다 — 찾기·거르개가 없고, 「세션 목록」 앱의 표보다 못했고, 세션이 무엇을
//  남겼는지 말하지 못했다. 그 한 장을 세 가지 일로 갈랐다: 말을 찾는다 · 한 일을 본다 · 세션을 고른다.
//  탭마다 자기 상태(검색어·고른 줄·기간)를 모듈에 쥐고 있어, 탭을 오가거나 대화록 화면에 다녀와도 보던 자리가 그대로다.
//  틀(원준 2026-10-05 «프로젝트 본문 창 참고해서 그 디자인 언어로»): 앱은 창 바닥까지 채우고 문서를 스크롤하지 않는다 — 칸마다 제 안에서
//   스크롤한다(본문 창과 같은 결). 머리 = 타일 · 이름 · 가로탭(트랙 위의 알약). 모양은 53-session-history.css.
//  사이드바(원준 2026-10-05 «A안으로 고고»): 셸 액자 안에서는 셸의 사이드바가 이 앱의 것이다(「세션 목록」 사이드바와 한 틀). 거기서 고른
//   범위가 세 탭에 함께 걸리고, 머리 맨 위 빵부스러기가 그 범위를 말한다(«세션 이력 / 시간별 / 어제 / <프로젝트> N개»). 다리는 sessions-scope.ts.
import { el } from './core.js';
import { parseSel, refreshTranscripts, renderTranscriptPage } from './sessions.js';
import { mountFind } from './sessions-find.js';
import { mountJournal } from './sessions-journal.js';
import { mountList, type TabHandle } from './sessions-list.js';
import { histBridgeOn, histRowsNow, histScope, installHistBridge, loadHistRows, onHistRows, onHistScope, scopedCount } from './sessions-scope.js';
import { histCrumb } from './lib/hist-scope.js';
import { HIST_TABS, readHistTab, rowProject, type HistTab } from './session-history.js';
import { fitHeight, ico, tileOf } from './sessions-kit.js';
import { EMBEDDED } from './v2/embed.js';

const TAB_STORE = 'lively.sessions.tab';   // 이 브라우저에서 마지막으로 본 탭(취향) — 주소에 ?tab= 이 없을 때만 쓴다
function hashParams(): URLSearchParams {
  const h = location.hash;
  return new URLSearchParams(h.includes('?') ? h.slice(h.indexOf('?') + 1) : '');
}
/** 주소에 지금 탭·검색어를 적는다 — 라우터를 다시 돌리지 않는다(replaceState 는 hashchange 를 내지 않는다). */
function writeAddress(tab: HistTab, q: string): void {
  const p = new URLSearchParams();
  p.set('tab', tab);
  if (tab === 'find' && q) p.set('q', q);
  try { history.replaceState(null, '', location.pathname + location.search + '#/sessions?' + p.toString()); } catch { /* 주소를 못 적어도 화면은 된다 */ }
}

export async function renderSessions(view: any): Promise<void> {
  const sel = parseSel();
  if (sel) {
    //  대화록 단독 화면에는 범위를 보일 자리가 없다 — 사이드바에서 고르면 앱으로 돌아와 그 범위를 보인다(찾기 단추는 「대화 찾기」로).
    installHistBridge({ onPick: () => { location.hash = '#/sessions'; }, onFind: () => { location.hash = '#/sessions?tab=find'; } });
    if (histBridgeOn()) void loadHistRows();
    return renderTranscriptPage(view, sel);
  }
  renderApp(view as HTMLElement);
}

function renderApp(view: HTMLElement): void {
  const params = hashParams();
  let stored: string | null = null;
  try { stored = localStorage.getItem(TAB_STORE); } catch { /* */ }
  let tab: HistTab = readHistTab(params.get('tab') ?? stored);
  let findQ = params.get('q') || '';
  const hosts = new Map<HistTab, HTMLElement>();
  const mounted = new Set<HistTab>();
  //  사이드바에서 범위가 바뀌면 보이는 탭만 곧바로 다시 그리고, 감춰 둔 탭은 다음에 볼 때 그린다(안 보는 탭의 조회를 미리 하지 않는다).
  const handles = new Map<HistTab, TabHandle>();
  const stale = new Set<HistTab>();
  const body = el('div', { class: 'shx-body' });
  const tabsEl = el('div', { class: 'shx-tabs', role: 'tablist', 'aria-label': '세션 이력' });
  const btns = new Map<HistTab, HTMLButtonElement>();

  const show = (next: HistTab, write: boolean): void => {
    tab = next;
    for (const t of HIST_TABS) {
      const on = t.key === next;
      const b = btns.get(t.key)!;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      hosts.get(t.key)!.hidden = !on;
    }
    refreshTranscripts(hosts.get(next)!);   // 감춰져 있던 사이 실린 대화록의 접기를 이제 잰다
    //  처음 여는 탭만 그린다 — 안 본 탭의 조회를 미리 하지 않는다. 한 번 그린 탭은 감춰 둘 뿐이라 보던 자리가 남는다.
    if (!mounted.has(next)) {
      mounted.add(next);
      stale.delete(next);
      const host = hosts.get(next)!;
      if (next === 'find') handles.set(next, mountFind(host, { q: params.has('q') ? findQ : undefined, onQuery: (q) => { findQ = q; if (tab === 'find') writeAddress('find', q); } }));
      else if (next === 'journal') handles.set(next, mountJournal(host));
      else handles.set(next, mountList(host));
    } else if (stale.delete(next)) handles.get(next)!.rescope();
    if (write) {
      writeAddress(next, findQ);
      try { localStorage.setItem(TAB_STORE, next); } catch { /* 못 남겨도 이번 화면은 된다 */ }
    }
  };

  for (const t of HIST_TABS) {
    const host = el('div', { class: 'shx-tabpanel', role: 'tabpanel', id: 'shx-panel-' + t.key, 'aria-labelledby': 'shx-tab-' + t.key, hidden: true }) as HTMLElement;
    hosts.set(t.key, host);
    body.append(host);
    const b = el('button', { type: 'button', role: 'tab', class: 'shx-tab', id: 'shx-tab-' + t.key, 'aria-controls': 'shx-panel-' + t.key, title: t.hint }, ico(t.icon), el('span', { text: t.label })) as HTMLButtonElement;
    b.addEventListener('click', () => show(t.key, true));
    //  탭 줄의 표준 키 — ← → 로 옆 탭.
    b.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const i = HIST_TABS.findIndex((x) => x.key === t.key);
      const n = HIST_TABS[(i + (e.key === 'ArrowRight' ? 1 : HIST_TABS.length - 1)) % HIST_TABS.length]!;
      e.preventDefault();
      show(n.key, true);
      btns.get(n.key)!.focus();
    });
    btns.set(t.key, b);
    tabsEl.append(b);
  }
  //  빵부스러기 — 셸 액자 안에서만 선다(셸의 「세션 목록」 화면과 같은 부품 .v2-sa-top). 셸 밖에는 사이드바가 없어 범위도 없다.
  const inShell = histBridgeOn();
  const crumb = inShell ? el('div', { class: 'shx-crumb v2-sa-top', 'aria-label': '지금 보는 범위' }) as HTMLElement : null;
  const paintCrumb = (): void => {
    if (!crumb) return;
    const now = Date.now();
    const rows = histRowsNow();
    const names = new Map<number, string>();
    for (const r of rows || []) { const p = rowProject(r); if (p.id != null && p.name && !names.has(p.id)) names.set(p.id, p.name); }
    const c = histCrumb(histScope(), now, (pid) => names.get(pid) || '');
    const kids: HTMLElement[] = [];
    for (const piece of c.trail) kids.push(el('span', { class: 'crumb', text: piece }) as HTMLElement, el('span', { class: 'sl', 'aria-hidden': 'true', text: '/' }) as HTMLElement);
    kids.push(el('b', { class: 'now', text: c.now }) as HTMLElement);
    //  수는 사이드바가 세는 그 수(범위 안의 기록) — 줄을 받기 전에는 적지 않는다(0 이라 말하지 않는다).
    if (rows) kids.push(el('span', { class: 'desc', text: `${scopedCount(rows, now).toLocaleString('en-US')}개` }) as HTMLElement);
    crumb.replaceChildren(...kids);
  };
  const root = el('div', { class: 'shx' + (EMBEDDED ? ' embedded' : '') + (inShell ? ' inshell' : '') },
    crumb,
    el('div', { class: 'shx-head' }, el('div', { class: 'shx-brand' }, tileOf('sess', 'blue'), el('h2', { text: '세션 이력' })), tabsEl),
    body) as HTMLElement;
  view.replaceChildren(root);
  fitHeight(root);
  if (inShell) {
    const off: Array<() => void> = [];
    const gone = (): boolean => { if (root.isConnected) return false; for (const f of off) f(); return true; };   // 떠난 화면은 듣기를 걷는다
    off.push(onHistScope(() => {
      if (gone()) return;
      paintCrumb();
      for (const t of mounted) { if (t === tab) handles.get(t)!.rescope(); else stale.add(t); }
    }));
    off.push(onHistRows(() => { if (!gone()) paintCrumb(); }));
    installHistBridge({
      onFind: () => {
        if (!root.isConnected) return;
        show('find', true);
        const input = hosts.get('find')!.querySelector<HTMLInputElement>('.shx-input');
        if (input) { input.focus(); input.select(); }
      },
    });
    paintCrumb();
    void loadHistRows();   // 사이드바가 그릴 줄 — 어느 탭에서 열든 보낸다
  }
  show(tab, false);
}
