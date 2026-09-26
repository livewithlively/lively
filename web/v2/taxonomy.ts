// v2/taxonomy.ts. 「분류체계」 앱(#4233). 맥락 관리의 카테고리 탭을 앱으로 뺐다(원준 2026-09-26
//  «이거 맥락 관리에 탭으로 있잖아, 그거 없애버리고 앱으로 따로 빼버리자. 우리 앱 화면에도 띄워야지»).
//
//  왜 앱인가: 분류는 위키만의 것이 아니다. 지식은 knowledge_category 로, 프로젝트는 «그 분류를 단 프로젝트 목록»
//   (project_list.category_id, #541)으로 붙는다. 위키 · 프로젝트 · 맥락 관리 어느 한 화면 안에 두면 나머지 쪽 사람은
//   분류를 고칠 자리를 못 찾는다. 그래서 자료(#2423)처럼 셸이 직접 그리는 native 앱으로 두고, 각 화면에서 이리로 온다.
//
//  화면 셋(주소가 정본):
//   · `#/taxonomy`            전체 지도: 묶음마다 한 칸, 분류마다 막대 둘(「지식 N」 「프로젝트 N」), 빈 분류는 접는다.
//   · `#/taxonomy?view=fix`   손볼 것: 정의 없음 · 빈 분류 · 제안 대기.
//   · `#/taxonomy/<id>`       분류 상세 3안(원준 2026-09-26 «3안이 좋아 가자»): 가운데 분류, 왼쪽 지식 유형, 오른쪽 프로젝트
//                             목록을 선으로 잇고 선마다 수를 적은 연결 그림 + 그 아래 지식 목록 · 프로젝트 목록.
//  사이드바는 side.ts renderTaxonomySection 이 그린다(위키 사이드바 3판과 같은 부품). 재료는 이 파일이 쥔다(taxonomyData).
//
//  고치기는 전부 기존 API 다(새 서버 기능 없음): 정의·이름 = POST /api/ui/categories/:id (category_update, 폼은 category-form.ts),
//   묶음 옮기기 = 같은 경로 {group}, 치우기·되살리기 = {state}, 지우기 = /delete(비었을 때만 연다), 묶음 = /api/ui/category-groups.
//  합치기는 아직 API 가 없어 이 앱에 없다(자리만 잡은 단추도 두지 않는다).
//  잣대(세기 · 늘어놓기 · 손볼 이유 · 지울 수 있나)는 lib/taxonomy-map.ts(순수. scripts/taxonomy-app.test.mjs).
import { api, el, hasScope, relTime, replaceKids, sv, toast } from '../core.js';
import { confirmDialog } from '../ui-primitives.js';
import { icon } from './icons.js';
import { showCtxMenu } from './ctx-menu.js';
import type { Proj } from './views.js';
import {
  FIX_REASONS, barPct, canDeleteCat, catId, countsByCategory, fixList, groupKeyOf, isArchived, isEmptyCat, knowledgeOf, planTaxMap, typeCounts,
  type TaxCat, type TaxCount, type TaxGroup, type TaxList,
} from '../lib/taxonomy-map.js';

export interface TaxCategory extends TaxCat {
  id: number | string; name: string; key?: string | null; description?: string | null; should?: string | null; origin?: string | null;
  updated_at?: string | null; repos?: string[] | null;
}
export interface TaxonomyData { cats: TaxCategory[]; groups: TaxGroup[]; lists: TaxList[]; counts: Map<number, TaxCount> }
export interface TaxonomyHooks {
  /** 셸이 이미 들고 있는 프로젝트(상세의 프로젝트 목록 · 상태 수). */
  projects: () => Proj[];
  /** 사이드바를 다시 그린다(고친 뒤 · 재료가 도착한 뒤). */
  redrawSide: () => void;
}

// ── 재료. 분류 · 묶음 · 프로젝트 목록. 앱 수명 캐시(들어올 때 30초보다 오래됐으면 다시 받는다) ──
let data: TaxonomyData | null = null;
let loadedAt = 0;
let loading: Promise<void> | null = null;
let loadErr = '';
const waiters = new Set<() => void>();
const STALE_MS = 30_000;

/** 지금 가진 재료(없으면 null). 사이드바가 읽는다. */
export function taxonomyData(): TaxonomyData | null { return data; }
export function taxonomyError(): string { return loadErr; }

/** 재료를 받는다(이미 받는 중이면 끝날 때 cb). force 면 캐시를 버린다. */
export function loadTaxonomy(cb?: () => void, force = false): void {
  if (cb) waiters.add(cb);
  if (loading) return;
  if (data && !force && Date.now() - loadedAt < STALE_MS) { flush(); return; }
  loading = Promise.all([
    api('/api/ui/categories'),
    api('/api/ui/category-groups').catch(() => ({ groups: [] })),
    api('/api/ui/v6/project-lists').catch(() => ({ lists: [] })),
  ]).then(([c, g, l]: any[]) => {
    const lists = ((l && l.lists) || []) as TaxList[];
    data = { cats: ((c && c.categories) || []) as TaxCategory[], groups: ((g && g.groups) || []) as TaxGroup[], lists, counts: countsByCategory(lists) };
    loadedAt = Date.now(); loadErr = '';
  }).catch((e: any) => { loadErr = (e && e.message) || '불러오지 못했습니다'; })
    .finally(() => { loading = null; flush(); });
}
function flush(): void { const cbs = [...waiters]; waiters.clear(); for (const f of cbs) { try { f(); } catch (_) { /* 한 화면의 실패가 다른 화면을 막지 않는다 */ } } }

/** 이 분류의 지식(가벼운 행, 최근 순). 상세가 연결 그림 왼쪽(유형별 수)과 지식 목록에 쓴다. */
interface KnowRow { name: string; title?: string | null; type?: string | null; updated_at?: string | null }
const knowCache = new Map<number, { at: number; rows: KnowRow[] | null; total: number; err: string; cbs: Set<() => void> }>();
//  받는 중에 같은 분류를 또 그리면(셸이 같은 화면을 두 번 그린다) 그 화면도 끝 알림을 받아야 한다. 기다리는 화면을 모아 둔다.
function loadKnowledge(id: number, cb: () => void): void {
  const hit = knowCache.get(id);
  if (hit && hit.rows === null) { hit.cbs.add(cb); return; }
  if (hit && Date.now() - hit.at < STALE_MS) return;
  const slot = { at: Date.now(), rows: null as KnowRow[] | null, total: 0, err: '', cbs: new Set<() => void>([cb]) };
  knowCache.set(id, slot);
  void api('/api/ui/knowledge?category=' + encodeURIComponent(String(id)) + '&light=1&limit=500&orderBy=updated_at')
    .then((d: any) => { slot.rows = ((d && d.entries) || []) as KnowRow[]; slot.total = Number(d && d.total) || slot.rows.length; })
    .catch((e: any) => { slot.rows = []; slot.err = (e && e.message) || '불러오지 못했습니다'; })
    .finally(() => { slot.at = Date.now(); const cbs = [...slot.cbs]; slot.cbs.clear(); for (const f of cbs) f(); });
}

const DOC_TYPE: Record<string, string> = { decision: '결정', concept: '개념', 'how-to': '절차', reference: '참조', research: '조사', entity: '사람·조직', '': '유형 없음' };
const fmt = (n: number): string => Number(n || 0).toLocaleString('en-US');
const groupName = (d: TaxonomyData, key: string): string => (d.groups.find((g) => g.key === key)?.name) || '묶음 없음';
const catHref = (c: { id: number | string }): string => '#/taxonomy/' + encodeURIComponent(String(catId(c)));
const canEdit = (): boolean => hasScope('context');

// ── 공용: 머리 두 줄(빵부스러기 · 도구줄) ──
function head(crumbs: Array<{ t: string; href?: string }>, desc: string, tools: Array<HTMLElement | null>): HTMLElement[] {
  const cr: HTMLElement[] = [];
  crumbs.forEach((c, i) => {
    const last = i === crumbs.length - 1;
    if (i) cr.push(el('span', { class: 'sl', text: '/' }));
    cr.push(last ? el('b', { class: 'now', text: c.t }) : el('a', { class: 'crumb', href: c.href || '#/taxonomy', text: c.t }));
  });
  return [
    el('div', { class: 'v2-tx-top' }, ...cr, desc ? el('span', { class: 'desc', text: desc }) : null),
    el('div', { class: 'v2-tx-tools' }, ...tools),
  ];
}
function toolBtn(label: string, ic: string | null, onclick: (ev: MouseEvent) => void, cls = ''): HTMLElement {
  return el('button', { class: 'v2-tx-tb' + (cls ? ' ' + cls : ''), type: 'button', onclick }, ic ? icon(ic, 'v2-tx-ic') : null, el('span', { text: label }));
}
function newCatBtn(reload: () => void): HTMLElement | null {
  if (!canEdit()) return null;
  return el('button', { class: 'v2-tx-new', type: 'button', title: '새 분류를 만듭니다', onclick: () => void openForm(null, reload) },
    icon('plus', 'v2-tx-ic'), el('span', { text: '새 분류' }));
}

/** 분류 폼(이름 · 정의 · 설명 · 묶음 · 레포). 맥락 관리가 쓰던 그 폼(category-form.ts)을 그대로 연다. 누를 때만 싣는다. */
export async function openForm(c: TaxCategory | null, reload: () => void): Promise<void> {
  const [mod, repos] = await Promise.all([
    import('../category-form.js'),
    api('/api/ui/repos').then((d: any) => (d && d.repos) || []).catch(() => []),
  ]);
  mod.openCategoryForm(c, reload, { repos, groups: (data && data.groups) || [] });
}

// ══════════════════════════════ 화면 ══════════════════════════════

/** 셸 라우터가 부른다(main.ts). sub = 주소 둘째 칸(분류 id), params = 쿼리. */
export function renderTaxonomyApp(host: HTMLElement, sub: string, params: URLSearchParams, hooks: TaxonomyHooks): void {
  //  화면 번호: 앱 안에서 주소를 옮기면(지도 → 분류 → 다른 분류) 이 함수가 같은 칸에 다시 불린다. 앞 화면이 기다리던
  //   응답이 늦게 와서 새 화면을 덮지 않게, 그린 뒤에도 «지금도 내 화면인가» 를 이 번호로 묻는다.
  const seq = String((Number(host.dataset.txSeq) || 0) + 1);
  host.dataset.txSeq = seq;
  const live = (): boolean => host.isConnected && host.dataset.txSeq === seq;
  const paint = (): void => {
    if (!live()) return;
    const d = data;
    if (!d) {
      replaceKids(host, el('div', { class: 'v2-tx' }, ...head([{ t: '분류체계' }], '', []),
        el('p', { class: 'v2-tx-note', text: loadErr ? '분류체계를 불러오지 못했습니다. ' + loadErr : '불러오는 중…' })));
      return;
    }
    if (sub) renderDetail(host, d, Number(sub), hooks, reload, live);
    else if (params.get('view') === 'fix') renderFix(host, d, reload);
    else renderMap(host, d, reload);
  };
  const reload = (): void => { knowCache.clear(); loadTaxonomy(() => { paint(); hooks.redrawSide(); }, true); };
  paint();
  loadTaxonomy(() => { paint(); hooks.redrawSide(); });
}

// ── 전체 지도 ──
const mapOpen = new Set<string>();   // 펼친 접힌 줄(`empty:<묶음>` · `arch:<묶음>`). 페이지 수명
function renderMap(host: HTMLElement, d: TaxonomyData, reload: () => void): void {
  const active = d.cats.filter((c) => !isArchived(c));
  const cols = planTaxMap(d.cats, d.groups, d.counts);
  const maxK = Math.max(0, ...active.map(knowledgeOf));
  const maxP = Math.max(0, ...active.map((c) => (d.counts.get(catId(c)) || { projects: 0 }).projects));
  const totalK = active.reduce((a, c) => a + knowledgeOf(c), 0);
  const totalP = [...d.counts.values()].reduce((a, x) => a + x.projects, 0);
  const bar = (cls: string, label: string, v: number, max: number): HTMLElement =>
    el('span', { class: 'v2-tx-bar ' + cls },
      el('span', { class: 'v2-tx-bl', text: label }),
      el('span', { class: 'v2-tx-btr' }, el('span', { class: 'v2-tx-bfl', style: `width:${barPct(v, max)}%` })),
      el('span', { class: 'v2-tx-bv', text: fmt(v) }));
  const row = (c: TaxCategory, k: number, p: number): HTMLElement =>
    el('a', { class: 'v2-tx-mrow', href: catHref(c), title: c.description || c.name },
      el('span', { class: 'nm', text: c.name }),
      el('span', { class: 'v2-tx-bars' }, bar('k', '지식', k, maxK), bar('p', '프로젝트', p, maxP)));
  const fold = (key: string, label: string, list: TaxCategory[]): HTMLElement[] => {
    if (!list.length) return [];
    const open = mapOpen.has(key);
    const btn = el('button', { class: 'v2-tx-fold' + (open ? ' open' : ''), type: 'button', 'aria-expanded': String(open),
      onclick: () => { if (open) mapOpen.delete(key); else mapOpen.add(key); renderMap(host, d, reload); } },
      el('span', { class: 'car', text: '›' }), el('span', { text: `${label} ${list.length}` }));
    return [btn, ...(open ? list.map((c) => row(c, knowledgeOf(c), (d.counts.get(catId(c)) || { projects: 0 }).projects)) : [])];
  };
  const colEls = cols.map((col) => el('section', { class: 'v2-tx-col', 'aria-label': col.name },
    el('div', { class: 'v2-tx-colh' }, el('span', { class: 'v2-tx-pill', text: col.name }),
      el('span', { class: 'n', text: String(col.rows.length + col.empty.length + col.archived.length) })),
    col.hint ? el('p', { class: 'v2-tx-colhint', text: col.hint }) : null,
    ...col.rows.map((r) => row(r.cat as TaxCategory, r.knowledge, r.projects)),
    ...fold('empty:' + col.key, '빈 분류', col.empty as TaxCategory[]),
    ...fold('arch:' + col.key, '치운 분류', col.archived as TaxCategory[]),
    !col.rows.length && !col.empty.length && !col.archived.length ? el('p', { class: 'v2-tx-note', text: '이 묶음에 든 분류가 없어요.' }) : null));
  replaceKids(host, el('div', { class: 'v2-tx' },
    ...head([{ t: '분류체계', href: '#/taxonomy' }, { t: '전체 지도' }],
      `분류 ${active.length} · 지식 ${fmt(totalK)} · 프로젝트 ${fmt(totalP)}`,
      [el('span', { class: 'v2-tx-legend' },
        el('span', {}, el('i', { class: 'k' }), el('span', { text: '지식: 이 분류에 붙은 지식 수' })),
        el('span', {}, el('i', { class: 'p' }), el('span', { text: '프로젝트: 이 분류의 프로젝트 목록에 든 프로젝트 수' }))),
       el('span', { class: 'sp' }), newCatBtn(reload)]),
    el('div', { class: 'v2-tx-body' },
      !d.cats.length ? el('div', { class: 'v2-tx-empty' },
        el('b', { text: '아직 분류가 없어요' }),
        el('p', { text: '분류는 지식과 프로젝트가 붙는 칸입니다. 분류마다 정의를 적어 두면 증류기가 그 기준으로 지식을 보냅니다.' })) : null,
      el('div', { class: 'v2-tx-map' }, ...colEls))));
}

// ── 손볼 것 ──
function renderFix(host: HTMLElement, d: TaxonomyData, reload: () => void): void {
  const items = fixList(d.cats, d.counts);
  const secs = FIX_REASONS.map((r) => {
    const hit = items.filter((x) => x.reasons.includes(r.key));
    if (!hit.length) return null;
    return el('section', { class: 'v2-tx-fsec', 'aria-label': r.label },
      el('div', { class: 'v2-tx-fh' }, el('span', { class: 'v2-tx-pill ' + r.key, text: r.label }), el('span', { class: 'n', text: String(hit.length) }),
        el('span', { class: 'hint', text: r.hint })),
      ...hit.map(({ cat }) => {
        const c = cat as TaxCategory;
        const n = d.counts.get(catId(c)) || { lists: 0, projects: 0 };
        return el('a', { class: 'v2-tx-frow', href: catHref(c) },
          icon('tags', 'v2-tx-ic'),
          el('span', { class: 'nm', text: c.name }),
          el('span', { class: 'g', text: groupName(d, groupKeyOf(c)) }),
          el('span', { class: 'm', text: `지식 ${fmt(knowledgeOf(c))}` }),
          el('span', { class: 'm', text: `프로젝트 ${fmt(n.projects)}` }),
          r.key === 'proposed' ? el('span', { class: 'm', text: `제안 ${fmt(Number(c.proposed_count) || 0)}` }) : el('span', {}));
      }));
  }).filter(Boolean) as HTMLElement[];
  replaceKids(host, el('div', { class: 'v2-tx' },
    ...head([{ t: '분류체계', href: '#/taxonomy' }, { t: '손볼 것' }], `분류 ${items.length}개`, [
      el('span', { class: 'v2-tx-tip', text: '정의 없음 · 빈 분류 · 제안 대기인 분류입니다. 누르면 그 분류를 엽니다.' }),
      el('span', { class: 'sp' }), newCatBtn(reload)]),
    el('div', { class: 'v2-tx-body' },
      secs.length ? el('div', { class: 'v2-tx-fix' }, ...secs) : el('div', { class: 'v2-tx-empty' }, el('b', { text: '손볼 것이 없습니다' }),
        el('p', { text: '모든 분류에 정의가 있고, 빈 분류와 확인을 기다리는 제안도 없습니다.' })))));
}

// ── 분류 상세 3안: 연결 그림 + 지식 목록 · 프로젝트 목록 ──
const defOpen = new Set<number>();
function renderDetail(host: HTMLElement, d: TaxonomyData, id: number, hooks: TaxonomyHooks, reload: () => void, live: () => boolean): void {
  const c = d.cats.find((x) => catId(x) === id);
  if (!c) {
    replaceKids(host, el('div', { class: 'v2-tx' }, ...head([{ t: '분류체계', href: '#/taxonomy' }, { t: '찾을 수 없음' }], '', []),
      el('div', { class: 'v2-tx-empty' }, el('b', { text: '이 분류를 찾지 못했어요' }),
        el('p', { text: '지워졌거나 주소가 바뀌었습니다.' }), el('a', { class: 'btn-text', href: '#/taxonomy', text: '전체 지도로' }))));
    return;
  }
  const repaint = (): void => { if (live()) renderDetail(host, d, id, hooks, reload, live); };
  loadKnowledge(id, repaint);
  const kn = knowCache.get(id);
  const n = d.counts.get(id) || { lists: 0, projects: 0 };
  const gk = groupKeyOf(c);
  const archived = isArchived(c);
  const myLists = d.lists.filter((l) => Number(l.category_id) === id);
  const projs = hooks.projects().filter((p) => !p.trashed_at && !p.archived_at);
  const listProjs = (lid: number): Proj[] => projs.filter((p) => Number(p.list_id) === lid)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const stCount = (ps: Proj[], k: string): number => ps.filter((p) => String(p.status_category || '') === k).length;

  // 도구줄
  const edit = canEdit();
  const moveBtn = edit ? toolBtn('묶음 옮기기', 'layers', (ev) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    showCtxMenu(r.left, r.bottom + 4, d.groups.map((g) => ({ label: g.name, checked: g.key === gk,
      run: () => { if (g.key !== gk) void act(() => api('/api/ui/categories/' + id, { method: 'POST', body: JSON.stringify({ group: g.key }) }), `「${g.name}」 묶음으로 옮겼습니다`); } })),
      { title: '묶음 옮기기', sub: c.name });
  }) : null;
  const act = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    try { await fn(); toast(ok); reload(); } catch (e: any) { toast((e && e.message) || '실패했습니다', true); }
  };
  const deletable = canDeleteCat(c, d.counts);
  const moreBtn = edit ? el('button', { class: 'v2-tx-tb ic', type: 'button', 'aria-label': '더 보기', title: '치우기 · 지우기',
    onclick: (ev: MouseEvent) => {
      const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      showCtxMenu(r.right - 220, r.bottom + 4, [
        archived
          ? { label: '되살리기', hint: '분류 후보에 다시 넣습니다', run: () => void act(() => api('/api/ui/categories/' + id, { method: 'POST', body: JSON.stringify({ state: 'active' }) }), '되살렸습니다') }
          : { label: '치우기', hint: '분류 후보에서 뺍니다', run: () => void act(() => api('/api/ui/categories/' + id, { method: 'POST', body: JSON.stringify({ state: 'deprecated' }) }), '치웠습니다. 분류 후보에서 빠집니다') },
        { sep: true, label: '' },
        deletable
          ? { label: '지우기', danger: true, run: () => void del() }
          : { label: '지우기', off: true, hint: '지식과 프로젝트 목록이 없을 때만' },
      ], { title: c.name });
    } }, icon('more', 'v2-tx-ic')) : null;
  const del = async (): Promise<void> => {
    if (!await confirmDialog({ title: `「${c.name}」 분류를 지울까요?`, lines: ['이 분류와 분류 사이 연결이 함께 지워집니다. 되돌릴 수 없습니다.'], confirmText: '지우기', danger: true })) return;
    try { await api('/api/ui/categories/' + id + '/delete', { method: 'POST' }); toast('지웠습니다'); location.hash = '#/taxonomy'; reload(); }
    catch (e: any) { toast((e && e.message) || '실패했습니다', true); }
  };
  const tools = [
    el('a', { class: 'v2-tx-tb', href: '#/knowledge?category=' + id, title: '위키에서 이 분류의 지식을 봅니다' }, icon('wiki', 'v2-tx-ic'), el('span', { text: '위키에서 보기' })),
    edit ? toolBtn('정의 고치기', 'pen', () => void openForm(c, reload)) : null,
    moveBtn, el('span', { class: 'sp' }), moreBtn,
  ];

  // 정의
  const should = String(c.should || '').trim();
  const dOpen = defOpen.has(id);
  const defSec = el('section', { class: 'v2-tx-def' },
    el('div', { class: 'v2-tx-sech' }, el('b', { text: '정의' }), el('span', { class: 'c', text: '지식을 이 분류에 붙일지 판정하는 기준' }),
      should ? el('button', { class: 'lnk', type: 'button', text: dOpen ? '접기' : '펼치기', onclick: () => { if (dOpen) defOpen.delete(id); else defOpen.add(id); repaint(); } }) : null),
    //  여백은 바깥 칸이, 세 줄 자르기는 안쪽 글이 맡는다(한 칸이 둘 다 하면 넷째 줄이 여백 자리에 반쯤 보인다).
    should ? el('div', { class: 'txt' }, el('p', { class: dOpen ? '' : 'clamp', text: should }))
      : el('div', { class: 'txt none' }, el('p', { text: '정의가 없어요. 증류기가 이 분류로 지식을 보낼 기준이 없습니다.' })));

  // 연결 그림
  const tcs = kn && kn.rows ? typeCounts(kn.rows) : null;
  const diagram = drawDiagram(c, tcs, knowledgeOf(c), myLists.map((l) => {
    const ps = listProjs(Number(l.id));
    return { id: Number(l.id), name: String(l.name || '목록'), n: Number(l.project_count) || 0, go: stCount(ps, 'started'), todo: stCount(ps, 'unstarted'), done: stCount(ps, 'done') };
  }), n.projects);

  // 지식 목록 · 프로젝트 목록
  const kList = el('section', { class: 'v2-tx-list' },
    el('div', { class: 'v2-tx-sech' }, el('b', { text: '지식' }), el('span', { class: 'c', text: `${fmt(knowledgeOf(c))} · 최근 순` }),
      el('a', { class: 'lnk', href: '#/knowledge?category=' + id, text: '위키에서 모두 보기' })),
    ...(!kn || kn.rows === null ? [el('p', { class: 'v2-tx-note', text: '불러오는 중…' })]
      : kn.err ? [el('p', { class: 'v2-tx-note', text: '지식을 불러오지 못했습니다. ' + kn.err })]
      : !kn.rows.length ? [el('p', { class: 'v2-tx-note', text: '이 분류에 붙은 지식이 없어요.' })]
      : kn.rows.slice(0, 8).map((k) => el('a', { class: 'v2-tx-krow', href: '#/k/' + encodeURIComponent(k.name) },
          el('span', { class: 't', text: k.title || k.name }),
          el('span', { class: 'm', text: `${DOC_TYPE[String(k.type || '')] || String(k.type || '')} · ${k.updated_at ? relTime(k.updated_at) : ''}` })))));
  const pList = el('section', { class: 'v2-tx-list' },
    el('div', { class: 'v2-tx-sech' }, el('b', { text: '프로젝트' }), el('span', { class: 'c', text: `목록 ${n.lists} · 프로젝트 ${fmt(n.projects)}` })),
    ...(!myLists.length ? [el('p', { class: 'v2-tx-note', text: '이 분류를 단 프로젝트 목록이 없어요. 프로젝트 탭에서 목록의 분류를 정하면 여기 섭니다.' })]
      : myLists.map((l) => {
        const ps = listProjs(Number(l.id));
        return el('div', { class: 'v2-tx-lcard' },
          el('a', { class: 'h', href: '#/projects2/l/' + encodeURIComponent(String(l.id)) }, icon('folder', 'v2-tx-ic'),
            el('b', { text: String(l.name || '목록') }), el('span', { class: 'n', text: fmt(Number(l.project_count) || 0) })),
          el('div', { class: 's', text: `진행 ${stCount(ps, 'started')} · 할 일 ${stCount(ps, 'unstarted')} · 완료 ${stCount(ps, 'done')}` }),
          ...ps.slice(0, 5).map((p) => el('a', { class: 'v2-tx-prow', href: '#/p/' + p.id },
            el('span', { class: 'dot ' + String(p.status_category || '') }), el('span', { class: 't', text: p.name }),
            el('span', { class: 'm', text: p.updated_at ? relTime(p.updated_at) : '' }))));
      })));

  replaceKids(host, el('div', { class: 'v2-tx' },
    ...head([{ t: '분류체계', href: '#/taxonomy' }, { t: groupName(d, gk), href: '#/taxonomy' }, { t: c.name }],
      `지식 ${fmt(knowledgeOf(c))} · 프로젝트 목록 ${n.lists} · 프로젝트 ${fmt(n.projects)}`, tools),
    el('div', { class: 'v2-tx-body' },
      el('div', { class: 'v2-tx-dhead' },
        el('h1', { text: c.name }), c.key ? el('span', { class: 'ky', text: String(c.key) }) : null),
      el('div', { class: 'v2-tx-chips' },
        el('span', { class: 'v2-tx-pill' }, icon('layers', 'v2-tx-ic'), el('span', { text: groupName(d, gk) })),
        el('span', { class: 'v2-tx-pill', text: c.origin === 'agent' ? '에이전트가 만듦' : '사람이 만듦' }),
        c.updated_at ? el('span', { class: 'v2-tx-pill', text: `정의 ${relTime(c.updated_at)} 고침` }) : null,
        archived ? el('span', { class: 'v2-tx-pill warn', text: '치운 분류' }) : null,
        isEmptyCat(c, d.counts) ? el('span', { class: 'v2-tx-pill', text: '빈 분류' }) : null,
        Number(c.proposed_count) > 0 ? el('span', { class: 'v2-tx-pill', text: `제안 대기 ${fmt(Number(c.proposed_count))}` }) : null),
      defSec,
      diagram,
      el('div', { class: 'v2-tx-two' }, kList, pList))));
}

/** 연결 그림. 가운데 분류, 왼쪽 지식 유형, 오른쪽 프로젝트 목록. 선마다 수를 적는다. 색은 CSS 토큰(라이트 · 다크 같은 규칙). */
function drawDiagram(c: TaxCategory, tcs: Array<[string, number]> | null, kTotal: number,
  lists: Array<{ id: number; name: string; n: number; go: number; todo: number; done: number }>, pTotal: number): HTMLElement {
  const W = 1000, ROW = 46, TOP = 34, MAX_R = 6;
  const left = tcs === null ? [{ t: '불러오는 중…', v: -1 }] : tcs.length ? tcs.slice(0, 6).map(([k, v]) => ({ t: DOC_TYPE[k] || k, v })) : [{ t: '지식 없음', v: -1 }];
  const shown = lists.slice(0, MAX_R);
  const rest = lists.length - shown.length;
  const right: Array<{ t: string; s: string; v: number; href?: string }> = lists.length
    ? [...shown.map((l) => ({ t: l.name, s: `진행 ${l.go} · 할 일 ${l.todo} · 완료 ${l.done}`, v: l.n, href: '#/projects2/l/' + l.id })),
       ...(rest > 0 ? [{ t: `목록 ${rest}개 더`, s: '', v: -1 }] : [])]
    : [{ t: '프로젝트 목록 없음', s: '', v: -1 }];
  const rows = Math.max(left.length, right.length, 2);
  const H = TOP + rows * ROW + 10;
  const cy = TOP + (rows * ROW) / 2;
  const yAt = (i: number, n: number): number => TOP + ((rows - n) * ROW) / 2 + i * ROW + ROW / 2;
  const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const g: SVGElement[] = [];
  const curve = (x1: number, y1: number, x2: number, y2: number, dashed: boolean): SVGElement => {
    const mx = (x1 + x2) / 2;
    return sv('path', { class: 'ln' + (dashed ? ' dash' : ''), d: `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}` });
  };
  const label = (x: number, y: number, v: number): SVGElement[] => [
    sv('rect', { class: 'lbg', x: String(x - 18), y: String(y - 9), width: '36', height: '18', rx: '9' }),
    sv('text', { class: 'lb', x: String(x), y: String(y + 4), 'text-anchor': 'middle' }, fmt(v)),
  ];
  const CXL = 400, CXR = 600;
  g.push(sv('text', { class: 'cap', x: '10', y: '16' }, '지식 (유형별)'), sv('text', { class: 'cap', x: String(W - 10), y: '16', 'text-anchor': 'end' }, '프로젝트 목록 · 프로젝트'));
  left.forEach((n, i) => {
    const y = yAt(i, left.length);
    g.push(curve(210, y, CXL, cy, n.v < 0));
    if (n.v >= 0) g.push(...label(290, y + (cy - y) * 0.42, n.v));
    g.push(sv('rect', { class: 'nd' + (n.v < 0 ? ' dash' : ''), x: '10', y: String(y - 16), width: '200', height: '32', rx: '8' }),
      sv('text', { class: 't', x: '24', y: String(y + 4) }, cut(n.t, 14)));
  });
  right.forEach((n, i) => {
    const y = yAt(i, right.length);
    g.push(curve(CXR, cy, 770, y, n.v < 0));
    if (n.v >= 0) g.push(...label(690, cy + (y - cy) * 0.58, n.v));
    const box = [sv('rect', { class: 'nd' + (n.v < 0 ? ' dash' : ''), x: '770', y: String(y - 19), width: '220', height: '38', rx: '8' }),
      sv('text', { class: 't', x: '784', y: String(n.s ? y - 3 : y + 4) }, cut(n.t, 16)),
      n.s ? sv('text', { class: 's', x: '784', y: String(y + 12) }, n.s) : null];
    g.push(n.href ? sv('a', { href: n.href }, ...box) : sv('g', {}, ...box));
  });
  g.push(sv('rect', { class: 'nd c', x: String(CXL), y: String(cy - 28), width: String(CXR - CXL), height: '56', rx: '12' }),
    sv('text', { class: 't c', x: String((CXL + CXR) / 2), y: String(cy - 3), 'text-anchor': 'middle' }, cut(c.name, 16)),
    sv('text', { class: 's', x: String((CXL + CXR) / 2), y: String(cy + 15), 'text-anchor': 'middle' }, `지식 ${fmt(kTotal)} · 프로젝트 ${fmt(pTotal)}`));
  return el('section', { class: 'v2-tx-dg', 'aria-label': '연결 그림' },
    sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${c.name}: 지식 ${kTotal}, 프로젝트 ${pTotal}` }, ...g));
}

// ══════════════════════════════ 묶음 정리 ══════════════════════════════
//  사이드바 「묶음」 이름표의 [정리]가 연다. 이름 바꾸기 · 순서 · 새 묶음 · 지우기(든 분류는 다른 묶음으로 옮긴 뒤).
//  API 는 맥락 관리가 쓰던 그대로다(category-groups: {name,sort} 만들기 · {key,name} 이름 · {key,name,sort} 순서 · /delete {reassign_to}).
export function openGroupManager(onDone: () => void): void {
  const d = data;
  if (!d) return;
  if (!canEdit()) { toast('묶음을 정리할 권한이 없습니다', true); return; }
  const groups = [...d.groups].sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
  const countIn = (key: string): number => d.cats.filter((c) => groupKeyOf(c) === key).length;
  let changed = false;
  const list = el('div', { class: 'v2-tx-gm-list' });
  const close = (): void => { back.remove(); document.removeEventListener('keydown', onKey); if (changed) onDone(); };
  const run = async (fn: () => Promise<unknown>, ok: string): Promise<boolean> => {
    try { await fn(); changed = true; toast(ok); return true; } catch (e: any) { toast((e && e.message) || '실패했습니다', true); return false; }
  };
  const save = (): Promise<unknown> => Promise.all(groups.map((g, i) => (Number(g.sort) === i ? null
    : api('/api/ui/category-groups', { method: 'POST', body: JSON.stringify({ key: g.key, name: g.name, sort: i }) }).then(() => { g.sort = i; }))));
  const paint = (): void => {
    list.replaceChildren(...groups.map((g, i) => {
      const name = el('input', { class: 'nm', type: 'text', value: g.name, maxlength: '80', 'aria-label': '묶음 이름' }) as HTMLInputElement;
      const commit = (): void => {
        const v = name.value.trim();
        if (!v || v === g.name) { name.value = g.name; return; }
        void run(() => api('/api/ui/category-groups', { method: 'POST', body: JSON.stringify({ key: g.key, name: v }) }), '묶음 이름을 바꿨습니다').then((ok) => { if (ok) g.name = v; });
      };
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
      name.addEventListener('blur', commit);
      const move = (dir: number): void => {
        const j = i + dir; if (j < 0 || j >= groups.length) return;
        [groups[i], groups[j]] = [groups[j], groups[i]];
        paint();
        void run(save, '순서를 바꿨습니다');
      };
      const n = countIn(g.key);
      return el('div', { class: 'v2-tx-gm-row' },
        name, el('span', { class: 'c', text: `분류 ${n}` }),
        el('button', { class: 'ib', type: 'button', 'aria-label': '위로', disabled: i === 0 ? 'true' : undefined, onclick: () => move(-1) }, icon('chevD', 'v2-tx-ic up')),
        el('button', { class: 'ib', type: 'button', 'aria-label': '아래로', disabled: i === groups.length - 1 ? 'true' : undefined, onclick: () => move(1) }, icon('chevD', 'v2-tx-ic')),
        el('button', { class: 'btn-text danger', type: 'button', text: '지우기', onclick: () => void removeGroup(g) }));
    }));
  };
  const removeGroup = async (g: TaxGroup): Promise<void> => {
    const n = countIn(g.key);
    const others = groups.filter((x) => x.key !== g.key);
    if (n && !others.length) { toast('옮길 다른 묶음이 없습니다. 새 묶음을 먼저 만드세요', true); return; }
    const sel = n ? el('select', { class: 'v2-tx-gm-sel' }, ...others.map((x) => el('option', { value: x.key, text: x.name }))) as HTMLSelectElement : null;
    const ok = await confirmDialog({ title: `「${g.name}」 묶음을 지울까요?`, lines: n ? [`이 묶음의 분류 ${n}개는 아래 묶음으로 옮깁니다.`] : ['이 묶음에 든 분류가 없습니다.'],
      extra: sel, confirmText: '지우기', danger: true });
    if (!ok) return;
    if (await run(() => api('/api/ui/category-groups/' + encodeURIComponent(g.key) + '/delete', { method: 'POST', body: JSON.stringify(sel ? { reassign_to: sel.value } : {}) }), '묶음을 지웠습니다')) {
      groups.splice(groups.indexOf(g), 1);
      if (sel) for (const c of d.cats) if (groupKeyOf(c) === g.key) { c.group_key = sel.value; c.group = sel.value; }
      paint();
    }
  };
  const addIn = el('input', { class: 'nm', type: 'text', placeholder: '새 묶음 이름', maxlength: '80', 'aria-label': '새 묶음 이름' }) as HTMLInputElement;
  const add = async (): Promise<void> => {
    const name = addIn.value.trim();
    if (!name) { addIn.focus(); return; }
    const sort = groups.reduce((m, g) => Math.max(m, Number(g.sort) || 0), -1) + 1;
    let made: any = null;
    if (await run(async () => { made = await api('/api/ui/category-groups', { method: 'POST', body: JSON.stringify({ name, sort }) }); }, '묶음을 만들었습니다')) {
      const gg = made && (made.group || made);
      groups.push({ key: String((gg && gg.key) || name), name, sort });
      addIn.value = ''; paint();
    }
  };
  addIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } });
  const box = el('div', { class: 'ov-box v2-tx-gm', role: 'dialog', 'aria-label': '묶음 정리' },
    el('div', { class: 'ov-head' }, el('h3', { text: '묶음 정리' })),
    el('p', { class: 'v2-tx-gm-hint', text: '묶음은 분류를 화면에서 나눠 보여 주는 이름표입니다. 이름을 고치면 바로 저장됩니다.' }),
    list,
    el('div', { class: 'v2-tx-gm-add' }, addIn, el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '묶음 추가', onclick: () => void add() })),
    el('div', { class: 'ov-confirm-acts' }, el('button', { class: 'btn btn-primary', type: 'button', text: '닫기', onclick: () => close() })));
  const back = el('div', { class: 'ov-back ov-confirm-back' }, box);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  //  지우기 확인창이 떠 있으면 Esc 는 그 창의 것이다(그 창이 스스로 닫는다).
  const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape' && !document.querySelector('.ov-confirm')) close(); };
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  paint();
}
