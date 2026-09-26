// v2/wiki-main.ts — [위키] 본문 목록(#4233). 셸이 직접 그린다: 종전엔 클래식 위키 화면(#/knowledge)을 액자에 실었다.
//
//  원준 2026-09-26 결정:
//   · «A를 뼈대로 하고 C의 「새로 들어온 지식」 카드 줄만 얹는 것» — 머리 두 줄(빵부스러기 · 도구줄), 보기 탭 줄 없음, 목록 보기 하나.
//   · 문서를 누르면 이동하지 않는다. 오른쪽 640px 덧창(사이드 피크)에서 마크다운으로 읽는다.
//   · «2안 사이드 피크를 기본으로 하고, 덧창 머리의 [고정]으로 3안으로 옮길 수 있게» — 3안은 셸 오른쪽 칸에 문서를 띄워 두는 것.
//     그 칸의 이름은 사용자에게 «우측 사이드바»다(내부 이름을 화면 글에 쓰지 않는다).
//  모양은 [AI 세션] 전체 목록(bins.ts renderSessAll · 47-v2-rail.css .v2-sa)과 같은 부품이다. 여기 것은 .v2-wk 로 열 폭만 바꾼다.
//  잣대(주소 → 범위 · 묶기 · 카드 · 「이번 주」 · 덧창 본문 · 고정 손님)는 잎 모듈 lib/wiki-list.ts 한 자리(scripts/wiki-main.test.mjs).
//  편집 · 크게는 종전 문서 화면(#/k/<name>)으로 간다 — 문서 화면이 곧 에디터다(#764).
import { absTime, api, el, hasScope, personDisplayName, personFace, relTime, renderMarkdown, replaceKids, state, sv } from '../core.js';
import { icon } from './icons.js';
import { showCtxMenu, type CtxRow } from './ctx-menu.js';
import { openInAside } from './aside-slot.js';
import { embedUrl } from './apps.js';
import { WIKI_GROUP_BYS, WIKI_TYPE_LABEL, groupWikiDocs, peekBody, pickNewDocs, pinGuest, visibleDocs, weekNewCount, wikiScopeOf,
  type WikiDocLike, type WikiGroupBy, type WikiScope } from '../lib/wiki-list.js';

interface WkDoc extends WikiDocLike { summary?: string | null; version?: number | null; provenance?: string | null; injection?: string | null; body_md?: string | null }
interface WkCat { id: number; key: string; name: string }
/** 한 범위(범위 · 유형 · 찾는 말)의 목록 — 여러 탭이 같은 범위를 보면 같은 것을 쓴다. */
interface Load { rows: WkDoc[]; total: number; hasMore: boolean; loading: boolean; err: string; at: number }
/** 탭(화면)마다의 상태 — 탭 둘이 다른 분류를 보고 있어도 서로 덮지 않는다. */
interface View { route: string; scopeKey: string; peek: string; type: string; q: string; searching: boolean; closed: Set<string> }

const PAGE = 200;
const BY_KEY = 'v2.wiki.by';
const loads = new Map<string, Load>();
const views = new WeakMap<HTMLElement, View>();
const hosts = new Set<HTMLElement>();
const docs = new Map<string, { at: number; k: WkDoc | null; err: boolean }>();
let cats: WkCat[] | null = null;
let catsP: Promise<void> | null = null;
let reviewN: number | null = null;
let qTimer = 0;
let keysBound = false;
/** 키보드(Esc · ↑ ↓)가 알아야 하는 것 — 화면마다 마지막으로 그린 순서와 다시 그리기. */
const navs = new WeakMap<HTMLElement, { order: string[]; repaint: () => void }>();

const readBy = (): WikiGroupBy => {
  try { const v = localStorage.getItem(BY_KEY) as WikiGroupBy | null; if (v && WIKI_GROUP_BYS.some((b) => b.key === v)) return v; } catch (_) { /* 저장소를 못 쓰는 창 */ }
  return 'day';
};
let by: WikiGroupBy = readBy();
const saveBy = (v: WikiGroupBy): void => { by = v; try { localStorage.setItem(BY_KEY, v); } catch (_) { /* 저장소를 못 쓰는 창 */ } };
const fmt = (n: number): string => Number(n).toLocaleString('en-US');
/** 셸 아이콘 사전에 없는 꺾쇠 둘(bins.ts 와 같은 선). */
const IC_DOWN = 'M6 9l6 6 6-6';
const IC_UP = 'M18 15l-6-6-6 6';
const pathIcon = (d: string, cls: string): SVGElement => sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, sv('path', { d }));
const typeLabel = (t: string | null | undefined): string => (t ? WIKI_TYPE_LABEL[t] || t : '');
const docHref = (name: string): string => '#/k/' + encodeURIComponent(name);
const meId = (): string => String((state.me && (state.me as any).userId) || '');
const whoName = (id: string): string => {
  if (!id) return '모름';
  if (id === meId()) return '나';
  if (id.startsWith('connector:')) return id.slice(10) === 'notion' ? '노션' : id.slice(10);
  return personDisplayName(id) || id;
};

function viewOf(host: HTMLElement, route: string): View {
  let v = views.get(host);
  if (!v) { v = { route, scopeKey: '', peek: '', type: '', q: '', searching: false, closed: new Set() }; views.set(host, v); }
  v.route = route;
  return v;
}
/** 분류 값(id · key · none)을 서버가 받는 값(id · none)으로. 모르는 key 면 ''(분류를 못 찾음). */
function catParam(cat: string): string {
  if (cat === 'none' || /^\d+$/.test(cat)) return cat;
  const c = (cats || []).find((x) => x.key === cat);
  return c ? String(c.id) : '';
}
const keyedCat = (sc: WikiScope): sc is Extract<WikiScope, { kind: 'cat' }> => sc.kind === 'cat' && sc.cat !== 'none' && !/^\d+$/.test(sc.cat);
const catOf = (cat: string): WkCat | null => (cats || []).find((c) => String(c.id) === cat || c.key === cat) || null;
const loadKey = (sc: WikiScope, ui: View): string => [sc.kind, sc.kind === 'cat' ? catParam(sc.cat) : '', ui.type, ui.q.trim()].join('|');

function listUrl(sc: WikiScope, ui: View, offset: number, limit: number): string {
  //  항상 주입 문서(injection=always)도 싣는다 — 사이드바의 «전체 문서 N» 이 그것까지 센다(두 숫자가 어긋나면 안 된다). 편집은 그 문서 화면이 막는다.
  const p = new URLSearchParams({ light: '1', orderBy: 'updated_at', limit: String(limit), offset: String(offset) });
  if (sc.kind === 'index') p.set('is_wiki', 'true');
  if (sc.kind === 'cat') p.set('category', catParam(sc.cat));
  if (ui.type) p.set('type', ui.type);
  if (ui.q.trim()) p.set('q', ui.q.trim());
  return '/api/ui/knowledge?' + p;
}

/** 목록을 받는다. more = 뒤에 이어 받기(더 불러오기). 받는 동안에도 전에 받은 줄은 그대로 보인다. */
function fetchList(host: HTMLElement, sc: WikiScope, ui: View, more = false): void {
  const key = loadKey(sc, ui);
  const cur = loads.get(key);
  if (cur && cur.loading) return;
  const offset = more && cur ? cur.rows.length : 0;
  const limit = more ? PAGE : Math.min(500, Math.max(PAGE, cur ? cur.rows.length : 0));
  const ld: Load = cur || { rows: [], total: 0, hasMore: false, loading: false, err: '', at: 0 };
  ld.loading = true; ld.err = '';
  loads.set(key, ld);
  void api(listUrl(sc, ui, offset, limit)).then((d: any) => {
    const got = visibleDocs(((d && d.entries) || []) as WkDoc[]);
    if (more) { const seen = new Set(ld.rows.map((r) => r.name)); ld.rows = ld.rows.concat(got.filter((r) => !seen.has(r.name))); }
    else ld.rows = got;
    ld.total = Number((d && d.total) || 0);
    ld.hasMore = !!(d && d.has_more);
    ld.at = Date.now();
  }).catch((e: any) => { ld.err = (e && e.message) || String(e); })
    .finally(() => { ld.loading = false; repaintIfShown(host); });
}
function repaintIfShown(host: HTMLElement): void {
  const v = views.get(host);
  if (v && host.isConnected && host.querySelector('.v2-wk')) paint(host, v.route);
}

/** 셸이 목록 주소로 들어올 때 부른다(renderRoute). 목록 · 분류 · 검토 대기 수를 새로 받고 그린다. */
export function renderWikiMain(host: HTMLElement, route: string): void {
  const sc = wikiScopeOf(route);
  if (!sc) return;
  for (const h of hosts) if (!h.isConnected) hosts.delete(h);   // 닫힌 탭의 화면
  hosts.add(host);
  const ui = viewOf(host, route);
  //  분류 목록은 빵부스러기 이름 · 새 문서의 분류 key · 옛 링크(?category=<key>)의 id 풀이에 쓴다. 들어올 때마다 새로 받되 받는 동안엔 전 것을 쓴다.
  const catsNow = api('/api/ui/categories').then((d: any) => { cats = ((d && d.categories) || []) as WkCat[]; }).catch(() => { if (!cats) cats = []; });
  if (!catsP) catsP = catsNow;
  void catsNow.then(() => repaintIfShown(host));
  //  id 로 온 주소는 분류 목록을 기다리지 않는다. key 로 온 옛 링크만 id 를 알아야 목록을 받을 수 있다.
  if (keyedCat(sc) && cats === null) void catsP.then(() => { fetchList(host, sc, ui); }); else fetchList(host, sc, ui);
  void api('/api/ui/review-queue/summary').then((s: any) => { reviewN = Number((s && s.total) || 0); }).catch(() => { reviewN = null; })
    .finally(() => repaintIfShown(host));
  paint(host, route);
}

function paint(host: HTMLElement, route: string): void {
  const sc = wikiScopeOf(route);
  if (!sc) return;
  const ui = viewOf(host, route);
  const scopeKey = sc.kind + '|' + (sc.kind === 'cat' ? sc.cat : '');
  if (ui.scopeKey !== scopeKey) { ui.scopeKey = scopeKey; ui.peek = sc.peek || ''; }   // 사이드바에서 다른 범위를 골랐다 — 덧창은 닫는다(딥링크면 그 문서)
  const repaint = (): void => paint(host, ui.route);
  const now = Date.now();
  const unknownCat = keyedCat(sc) && cats !== null && !catParam(sc.cat);
  const ld = (keyedCat(sc) && cats === null) || unknownCat ? undefined : loads.get(loadKey(sc, ui));
  const rows = ld ? ld.rows : [];
  const openPeek = (name: string): void => { ui.peek = name; repaint(); };
  const go = (name: string): void => { location.hash = docHref(name); };

  // ── 1행 빵부스러기 ──
  const cat = sc.kind === 'cat' ? catOf(sc.cat) : null;
  const now1 = sc.kind === 'all' ? '전체 문서' : sc.kind === 'index' ? '인덱스' : sc.cat === 'none' ? '분류 없음' : cat ? cat.name : '분류';
  const week = ld && !ld.loading && !ui.q && !ui.type ? weekNewCount(rows, now, ld.hasMore) : null;
  const top = el('div', { class: 'v2-sa-top' },
    el('a', { class: 'crumb', href: '#/knowledge', text: '위키' }), el('span', { class: 'sl', text: '/' }),
    el('b', { class: 'now', text: now1 }),
    ld && ld.at ? el('span', { class: 'desc', text: `${fmt(ld.total)}개` + (week ? ` · 이번 주 +${fmt(week)}` : '') }) : null);

  // ── 2행 도구줄 — 묶기 · 거르개 · 검토 대기 · 찾기 · ＋ 새 문서 ──
  const byLabel = (WIKI_GROUP_BYS.find((b) => b.key === by) || WIKI_GROUP_BYS[0]).label;
  const byBtn = el('button', { class: 'v2-sa-tb', type: 'button', 'aria-haspopup': 'menu', 'data-grpby': by, title: '묶는 기준을 고릅니다',
    onclick: (ev: MouseEvent) => {
      const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      const row = (b: (typeof WIKI_GROUP_BYS)[number]): CtxRow => ({ label: b.label, checked: b.key === by, run: () => { saveBy(b.key); repaint(); } });
      showCtxMenu(r.left, r.bottom + 4, [...WIKI_GROUP_BYS.filter((b) => b.key !== 'none').map(row), { label: '', sep: true },
        ...WIKI_GROUP_BYS.filter((b) => b.key === 'none').map(row)], { title: '묶기', sub: '묶음 안은 최근에 고친 순' });
    } }, icon('layers', 'v2-sa-ic'), el('span', { text: byLabel }), pathIcon(IC_DOWN, 'v2-sa-ic sm'));
  const setType = (t: string): void => { ui.type = t; fetchList(host, sc, ui); repaint(); };
  const filterBtn = el('button', { class: 'v2-sa-tb ic' + (ui.type ? ' on' : ''), type: 'button', 'aria-haspopup': 'menu', 'aria-label': '거르개', title: '유형으로 거릅니다',
    onclick: (ev: MouseEvent) => {
      const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      showCtxMenu(r.left, r.bottom + 4, [{ label: '모든 유형', checked: !ui.type, run: () => setType('') }, { label: '', sep: true },
        ...Object.keys(WIKI_TYPE_LABEL).map((t): CtxRow => ({ label: WIKI_TYPE_LABEL[t], checked: ui.type === t, run: () => setType(t) }))], { title: '거르개', sub: '유형' });
    } }, icon('sliders', 'v2-sa-ic'));
  const typeChip = ui.type ? el('button', { class: 'v2-sa-chip blue on', type: 'button', title: '거르기를 풉니다', onclick: () => setType('') },
    el('span', { text: `유형 ${typeLabel(ui.type)} ×` })) : null;
  const reviewChip = reviewN ? el('a', { class: 'v2-sa-chip warn', href: '#/knowledge/review', title: '검토 대기 화면에서 승인하거나 반려합니다' },
    el('span', { text: `검토 대기 ${fmt(reviewN)}` })) : null;
  const search = ui.searching || ui.q
    ? el('input', { class: 'v2-sa-q', type: 'search', placeholder: '제목 · 본문 찾기', 'data-pick': 'q', value: ui.q,
        oninput: (e: Event) => {
          ui.q = (e.target as HTMLInputElement).value;
          window.clearTimeout(qTimer);
          qTimer = window.setTimeout(() => { fetchList(host, sc, ui); repaint(); }, 350);
        },
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Escape') { ui.q = ''; ui.searching = false; repaint(); } } })
    : el('button', { class: 'v2-sa-tb ic', type: 'button', 'aria-label': '찾기', title: '문서 찾기', onclick: () => { ui.searching = true; repaint(); host.querySelector<HTMLElement>('[data-pick="q"]')?.focus(); } }, icon('search', 'v2-sa-ic'));
  const newHref = '#/knowledge/new' + (cat ? '?category=' + encodeURIComponent(cat.key) : '');
  const tools = el('div', { class: 'v2-sa-tools' }, byBtn, filterBtn, typeChip, reviewChip, el('span', { class: 'sp' }), search,
    el('a', { class: 'v2-sa-new', href: newHref, title: cat ? `${cat.name} 분류로 새 문서를 씁니다` : '새 문서를 하나 씁니다' },
      icon('plus', 'v2-sa-ic'), el('span', { text: '새 문서' })));

  // ── 「새로 들어온 지식」 카드 ──
  const cards = pickNewDocs(rows, 4);
  const newSec = cards.length ? el('section', { class: 'v2-sa-now', 'aria-label': '새로 들어온 지식' },
    el('div', { class: 'v2-sa-now-h' }, el('b', { text: '새로 들어온 지식' }), week ? el('span', { class: 'c', text: `이번 주 ${fmt(week)}` }) : null),
    el('div', { class: 'v2-sa-cards' }, ...cards.map((d) => el('button', { class: 'v2-sa-card v2-wk-card' + (ui.peek === d.name ? ' on' : ''), type: 'button', 'data-doc': d.name,
      onclick: () => openPeek(d.name), ondblclick: () => go(d.name) },
      el('div', { class: 'k' }, el('i', { class: 'dot', 'aria-hidden': 'true' }), el('span', { class: 'cn', text: d.category_name || '분류 없음' })),
      el('div', { class: 't', text: d.title || d.name }),
      el('div', { class: 'p', text: [typeLabel(d.type), relTime(d.created_at) + ' 들어옴'].filter(Boolean).join(' · ') }))))) : null;

  // ── 묶음별 목록 ──
  const order: string[] = [];
  const headCols = (): HTMLElement[] => [['cat', '분류'], ['type', '유형'], ['who', '작성'], ['when', '시각']].map(([k, t]) => el('span', { class: 'hc h-' + k, text: t })).concat(el('span', {}));
  const rowOf = (d: WkDoc): HTMLElement => {
    order.push(d.name);
    const nameClick = (ev: MouseEvent): void => {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return;   // ⌘ · Ctrl · Shift 클릭은 브라우저 몫(새 탭 · 새 창)
      ev.preventDefault(); ev.stopPropagation(); openPeek(d.name);
    };
    const more = el('button', { class: 'v2-sa-more', type: 'button', 'aria-label': '더 보기', title: '미리보기 · 우측 사이드바에 고정 · 문서 화면',
      onclick: (ev: MouseEvent) => {
        ev.stopPropagation();
        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        showCtxMenu(r.right - 200, r.bottom + 4, [
          { label: '미리보기', icon: 'eye', run: () => openPeek(d.name) },
          { label: '우측 사이드바에 고정', icon: 'pin', run: () => pinDoc(d, ui, repaint) },
          { label: '문서 화면으로 열기', icon: 'open', run: () => go(d.name) },
        ], { title: d.title || d.name });
      } }, icon('more', 'v2-sa-ic'));
    const who = String(d.updated_by || '');
    const row = el('div', { class: 'v2-sa-row v2-wk-row' + (ui.peek === d.name ? ' on' : ''), role: 'button', tabindex: '0', 'data-doc': d.name },
      el('div', { class: 'c-name' }, icon(d.is_folder ? 'folder' : 'doc', 'v2-sa-ic'),
        el('a', { class: 't', href: docHref(d.name), text: d.title || d.name, title: d.title || d.name, onclick: nameClick })),
      el('div', { class: 'c-cat' + (d.category_key ? '' : ' none') }, el('i', { 'aria-hidden': 'true' }), el('span', { text: d.category_name || '분류 없음' })),
      el('div', { class: 'c-type' + (d.type ? '' : ' none'), text: typeLabel(d.type) || '유형 없음' }),
      el('div', { class: 'c-who' }, who && !who.startsWith('connector:') ? personFace(who, 'v2-sall-face', whoName(who)) : el('span', { class: 'm', text: whoName(who), title: who })),
      el('div', { class: 'c-when' }, el('span', { class: 'm', text: relTime(d.updated_at), title: d.updated_at ? absTime(d.updated_at) : '' })),
      el('div', { class: 'c-acts' }, more));
    row.addEventListener('click', (ev) => { if ((ev.target as HTMLElement).closest('button, a, input, select')) return; openPeek(d.name); });
    row.addEventListener('dblclick', (ev) => { if ((ev.target as HTMLElement).closest('button, input, select')) return; go(d.name); });
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target === row) { ev.preventDefault(); openPeek(d.name); } });
    return row;
  };
  const list = el('div', { class: 'v2-sa-list v2-wk-list', 'aria-label': '문서 목록' });
  for (const g of groupWikiDocs(rows, by, now, meId())) {
    if (by === 'none') { list.append(el('div', { class: 'v2-sa-gh flat' }, el('span', { class: 'hc', text: '문서' }), ...headCols())); g.rows.forEach((d) => list.append(rowOf(d))); continue; }
    const gk = `${by}:${g.key}`;
    const closed = ui.closed.has(gk);
    list.append(el('div', { class: 'v2-sa-gh' },
      el('button', { class: 'l', type: 'button', 'aria-expanded': String(!closed), onclick: () => { if (closed) ui.closed.delete(gk); else ui.closed.add(gk); repaint(); } },
        el('span', { class: 'car' + (closed ? ' shut' : '') }, pathIcon(IC_DOWN, 'v2-sa-ic sm')),
        el('span', { class: 'pill', text: by === 'person' ? whoName(g.key) : g.label }), el('span', { class: 'n', text: String(g.rows.length) })),
      ...headCols()));
    if (!closed) g.rows.forEach((d) => list.append(rowOf(d)));
  }
  const filtered = !!(ui.q.trim() || ui.type);
  const empty = unknownCat ? '이 분류를 찾지 못했어요. 지워졌거나 주소가 바뀌었을 수 있어요.'
    : !ld || (ld.loading && !ld.at) ? '불러오는 중…'
    : ld.err && !rows.length ? '목록을 불러오지 못했어요. ' + ld.err
    : rows.length ? ''
    : filtered ? '이 조건에 맞는 문서가 없어요. 찾는 말이나 유형을 바꿔 보세요.'
    : sc.kind === 'index' ? '인덱스에 꽂힌 문서가 없어요.' : sc.kind === 'cat' ? '이 분류에 든 문서가 없어요.' : '아직 문서가 없어요. ＋ 새 문서로 첫 문서를 써 보세요.';
  const left = ld && ld.hasMore ? Math.max(0, ld.total - rows.length) : 0;

  // ── 사이드 피크 ──
  const pd = ui.peek ? rows.find((r) => r.name === ui.peek) || ({ name: ui.peek, title: '' } as WkDoc) : null;
  const peekEl = pd ? renderPeek(pd, ui, order, repaint) : null;

  const act = document.activeElement;
  const hadPick = act instanceof HTMLElement && host.contains(act) ? act.dataset.pick || '' : '';
  const caret = hadPick && act instanceof HTMLInputElement ? [act.selectionStart, act.selectionEnd] : null;
  const bodyOld = host.querySelector<HTMLElement>('.v2-wk .v2-sa-body');
  const scrollTop = bodyOld && bodyOld.dataset.scope === scopeKey ? bodyOld.scrollTop : 0;
  replaceKids(host, el('div', { class: 'v2-sa v2-wk' + (peekEl ? ' peeking' : '') }, top, tools,
    el('div', { class: 'v2-sa-body', 'data-scope': scopeKey },
      newSec, list,
      left > 0 ? el('button', { class: 'btn-text v2-bin-more', type: 'button', text: ld && ld.loading ? '불러오는 중…' : `${fmt(left)}개 더 불러오기`, onclick: () => fetchList(host, sc, ui, true) }) : null,
      empty ? el('p', { class: 'v2-bin-empty', text: empty }) : null,
      ld && ld.err && !ld.loading ? el('button', { class: 'btn-text v2-bin-more', type: 'button', text: '다시 불러오기', onclick: () => { fetchList(host, sc, ui); repaint(); } }) : null),
    peekEl));
  if (hadPick) {
    const f = host.querySelector<HTMLInputElement>(`[data-pick="${hadPick}"]`);
    f?.focus();
    if (f && caret) { try { f.setSelectionRange(Number(caret[0] ?? f.value.length), Number(caret[1] ?? f.value.length)); } catch (_) { /* search 입력은 선택 범위를 안 받는 브라우저가 있다 */ } }
  }
  const bodyNew = host.querySelector<HTMLElement>('.v2-sa-body');
  if (bodyNew && scrollTop) bodyNew.scrollTop = scrollTop;
  host.querySelector<HTMLElement>('.v2-wk-row.on')?.scrollIntoView({ block: 'nearest' });
  navs.set(host, { order, repaint });
  bindWikiKeys();
}

/** 덧창 — 머리(이전 · 다음 · 편집 · 우측 사이드바에 고정 · 크게 · 닫기), 본문(기존 마크다운 렌더러), 발치(키 안내). */
function renderPeek(d: WkDoc, ui: View, order: string[], repaint: () => void): HTMLElement {
  const hit = docs.get(d.name);
  if (!hit || (!hit.k && !hit.err && Date.now() - hit.at > 15000) || Date.now() - hit.at > 30000) {
    docs.set(d.name, { at: Date.now(), k: hit ? hit.k : null, err: false });
    void api('/api/ui/knowledge/' + encodeURIComponent(d.name)).then((r: any) => {
      docs.set(d.name, { at: Date.now(), k: ((r && (r.knowledge || r)) || null) as WkDoc | null, err: false });
    }).catch(() => { docs.set(d.name, { at: Date.now(), k: null, err: true }); })
      .finally(() => { if (ui.peek === d.name) repaint(); });
  }
  const cur = docs.get(d.name);
  const k: WkDoc = { ...d, ...(cur && cur.k ? cur.k : {}) };
  const title = k.title || k.name;
  const i = order.indexOf(d.name);
  const step = (dir: number): void => { const nx = i >= 0 ? order[i + dir] : undefined; if (nx) { ui.peek = nx; repaint(); } };
  const canEdit = hasScope('memory') && k.provenance !== 'observed' && k.injection !== 'always' && !k.is_folder;
  const ib = (ic: SVGElement, tip: string, run: () => void, off = false): HTMLElement =>
    el('button', { class: 'ib', type: 'button', title: tip, 'aria-label': tip, disabled: off, onclick: run }, ic);
  const b = peekBody(cur && cur.k ? cur.k.body_md : '', title);
  const who = String(k.updated_by || '');
  const body = !cur || (!cur.k && !cur.err) ? el('p', { class: 'v2-sa-note', text: '문서를 불러오는 중…' })
    : cur.err ? el('p', { class: 'v2-sa-note', text: '문서를 불러오지 못했어요. [크게]로 문서 화면에서 열어 보세요.' })
    : b.empty ? el('p', { class: 'v2-sa-note', text: '본문이 없는 문서예요.' })
    : el('div', { class: 'md-rendered v2-wk-md' }, renderMarkdown(b.md.length > 60000 ? b.md.slice(0, 60000) : b.md));
  return el('aside', { class: 'v2-sa-peek v2-wk-peek', 'aria-label': `${title} 미리보기`, 'data-doc': d.name },
    el('div', { class: 'v2-sa-ph' },
      el('span', { class: 'cr', text: [k.category_name || '분류 없음', typeLabel(k.type)].filter(Boolean).join(' › ') }),
      el('span', { class: 'sp' }),
      ib(pathIcon(IC_UP, 'v2-sa-ic'), '이전 문서 (↑)', () => step(-1), i <= 0),
      ib(pathIcon(IC_DOWN, 'v2-sa-ic'), '다음 문서 (↓)', () => step(1), i < 0 || i >= order.length - 1),
      canEdit ? el('a', { class: 'ibt', href: docHref(d.name), title: '문서 화면에서 바로 고칩니다' }, icon('pen', 'v2-sa-ic sm'), el('span', { text: '편집' })) : null,
      el('button', { class: 'ibt', type: 'button', title: '다른 화면으로 가도 오른쪽에 계속 띄워 둡니다', onclick: () => pinDoc(k, ui, repaint) },
        icon('pin', 'v2-sa-ic sm'), el('span', { text: '우측 사이드바에 고정' })),
      el('a', { class: 'ib', href: docHref(d.name), title: '크게 보기 (문서 화면)', 'aria-label': '크게 보기' }, icon('open', 'v2-sa-ic')),
      ib(icon('x', 'v2-sa-ic'), '닫기 (Esc)', () => { ui.peek = ''; repaint(); })),
    el('div', { class: 'v2-wk-rd' },
      el('h1', { text: title }),
      el('div', { class: 'dm' },
        k.type ? el('span', { class: 'pill', text: typeLabel(k.type) }) : null,
        el('span', { class: 'pill', text: k.category_name || '분류 없음' }),
        el('span', { class: 'pill', text: [who ? whoName(who) + ' 고침' : '', k.version ? 'v' + k.version : '', relTime(k.updated_at)].filter(Boolean).join(' · ') })),
      k.summary ? el('p', { class: 'v2-wk-sum', text: String(k.summary) }) : null,
      body,
      b.md.length > 60000 ? el('p', { class: 'v2-sa-note', text: '여기까지만 보여요. 나머지는 [크게]에서 볼 수 있어요.' }) : null),
    el('div', { class: 'v2-wk-foot' },
      el('span', { class: 'v2-wk-kbd', text: '↑' }), el('span', { class: 'v2-wk-kbd', text: '↓' }), el('span', { text: '옆 문서' }),
      el('span', { class: 'sl', text: '·' }), el('span', { class: 'v2-wk-kbd', text: 'Esc' }), el('span', { text: '닫기' })));
}

/** [우측 사이드바에 고정] — 셸 오른쪽 칸에 문서 화면을 싣는다(탭을 옮겨 다녀도 × 로 닫을 때까지 남는다). 덧창은 닫는다. */
function pinDoc(d: WkDoc, ui: View, repaint: () => void): void {
  const g = pinGuest(d.name, d.title);
  if (!openInAside({ key: g.key, title: g.title, url: embedUrl(g.hash), label: g.label })) { location.hash = '#/' + g.hash; return; }
  ui.peek = '';
  repaint();
}

/** Esc = 덧창 닫기 · ↑ ↓ = 그려진 순서의 옆 문서. 보이는 위키 화면 하나에만, 입력칸 · 메뉴 안에서는 먹지 않는다. */
function bindWikiKeys(): void {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener('keydown', (ev) => {
    const host = [...hosts].find((h) => h.isConnected && !!h.offsetParent && !!h.querySelector('.v2-wk'));
    const ui = host ? views.get(host) : undefined;
    const nav = host ? navs.get(host) : undefined;
    if (!host || !ui || !nav || !ui.peek) return;
    const t = ev.target as HTMLElement | null;
    if (t && t.closest && t.closest('textarea, input, select, [contenteditable="true"], .pn-ctx')) return;
    if (ev.key === 'Escape') { ui.peek = ''; nav.repaint(); return; }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const i = nav.order.indexOf(ui.peek);
    if (i < 0) return;
    const nx = nav.order[i + (ev.key === 'ArrowDown' ? 1 : -1)];
    if (nx) { ev.preventDefault(); ui.peek = nx; nav.repaint(); }
  });
}
