// sessions-app.ts — 「세션 이력」 앱(#4553, 원준 2026-10-04 «A,B,C안을 … 상위 가로탭으로 만들어가지고 셋 다 구현해»).
//  `#/sessions[?tab=find|journal|list&q=…]` — 가로탭 셋: 「대화 찾기」 · 「작업 일지」 · 「세션 목록」.
//  `#/sessions/<sid>[?node=&q=&ln=]` — 대화록 단독 화면(공유 링크 · 통합검색이 모르는 세션을 열 때). 종전 그대로다(sessions.ts).
//
//  종전 목록면은 내 세션을 15개씩 넘겨 보는 한 장이었다 — 찾기·거르개가 없고, 「세션 목록」 앱의 표보다 못했고, 세션이 무엇을
//  남겼는지 말하지 못했다. 그 한 장을 세 가지 일로 갈랐다: 말을 찾는다 · 한 일을 본다 · 세션을 고른다.
//  탭마다 자기 상태(검색어·고른 줄·기간)를 모듈에 쥐고 있어, 탭을 오가거나 대화록 화면에 다녀와도 보던 자리가 그대로다.
import { el } from './core.js';
import { parseSel, renderTranscriptPage } from './sessions.js';
import { mountFind } from './sessions-find.js';
import { mountJournal } from './sessions-journal.js';
import { mountList } from './sessions-list.js';
import { HIST_TABS, readHistTab, type HistTab } from './session-history.js';

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
  if (sel) return renderTranscriptPage(view, sel);
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
  const body = el('div', { class: 'shx-body' });
  const tabsEl = el('div', { class: 'seg-tabs shx-tabs', role: 'tablist', 'aria-label': '세션 이력' });
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
    //  처음 여는 탭만 그린다 — 안 본 탭의 조회를 미리 하지 않는다. 한 번 그린 탭은 감춰 둘 뿐이라 보던 자리가 남는다.
    if (!mounted.has(next)) {
      mounted.add(next);
      const host = hosts.get(next)!;
      if (next === 'find') mountFind(host, { q: params.has('q') ? findQ : undefined, onQuery: (q) => { findQ = q; if (tab === 'find') writeAddress('find', q); } });
      else if (next === 'journal') mountJournal(host);
      else mountList(host);
    }
    if (write) {
      writeAddress(next, findQ);
      try { localStorage.setItem(TAB_STORE, next); } catch { /* 못 남겨도 이번 화면은 된다 */ }
    }
  };

  for (const t of HIST_TABS) {
    const host = el('div', { class: 'shx-tabpanel', role: 'tabpanel', id: 'shx-panel-' + t.key, 'aria-labelledby': 'shx-tab-' + t.key, hidden: true }) as HTMLElement;
    hosts.set(t.key, host);
    body.append(host);
    const b = el('button', { type: 'button', role: 'tab', id: 'shx-tab-' + t.key, 'aria-controls': 'shx-panel-' + t.key, title: t.hint, text: t.label }) as HTMLButtonElement;
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
  view.replaceChildren(el('div', { class: 'shx' },
    el('div', { class: 'shx-head' }, el('h2', { text: '세션 이력' }), tabsEl),
    body));
  show(tab, false);
}
