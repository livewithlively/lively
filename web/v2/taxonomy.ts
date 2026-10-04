// v2/taxonomy.ts. 「분류체계」 앱(#4233). 맥락 관리의 카테고리 탭을 앱으로 뺐다(원준 2026-09-26
//  «이거 맥락 관리에 탭으로 있잖아, 그거 없애버리고 앱으로 따로 빼버리자. 우리 앱 화면에도 띄워야지»).
//
//  왜 앱인가: 분류는 위키만의 것이 아니다. 지식은 knowledge_category 로, 프로젝트는 «그 분류를 단 프로젝트 목록»
//   (project_list.category_id, #541)으로 붙는다. 위키 · 프로젝트 · 맥락 관리 어느 한 화면 안에 두면 나머지 쪽 사람은
//   분류를 고칠 자리를 못 찾는다. 그래서 자료(#2423)처럼 셸이 직접 그리는 native 앱으로 두고, 각 화면에서 이리로 온다.
//
//  화면 셋(주소가 정본):
//   · `#/taxonomy`            전체 지도: 묶음마다 가로 레인, 분류마다 한 줄(막대 둘 「지식」 「프로젝트」), 빈 분류는 접는다.
//                             [구조 편집]을 켜면 묶음 · 분류를 이 화면에서 고친다(#4135 — 아래 renderMap 머리말).
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
  FIX_REASONS, NO_GROUP, barPct, canDeleteCat, catId, countsByCategory, fixList, groupKeyOf, isArchived, isEmptyCat, knowledgeOf, planTaxMap, typeCounts,
  type TaxCat, type TaxCount, type TaxGroup, type TaxList,
} from '../lib/taxonomy-map.js';
import { createCachedLoader } from '../lib/tax-loader.js';

export interface TaxCategory extends TaxCat {
  id: number | string; name: string; key?: string | null; description?: string | null; should?: string | null; origin?: string | null;
  updated_at?: string | null; repos?: string[] | null; cross_cutting?: boolean | null;
}
export interface TaxonomyData { cats: TaxCategory[]; groups: TaxGroup[]; lists: TaxList[]; counts: Map<number, TaxCount> }
export interface TaxonomyHooks {
  /** 셸이 이미 들고 있는 프로젝트(상세의 프로젝트 목록 · 상태 수). */
  projects: () => Proj[];
  /** 사이드바를 다시 그린다(고친 뒤 · 재료가 도착한 뒤). */
  redrawSide: () => void;
}

// ── 재료. 분류 · 묶음 · 프로젝트 목록. 앱 수명 캐시(들어올 때 30초보다 오래됐으면 다시 받는다) ──
//  언제 받고 누구를 부르나는 lib/tax-loader.ts 가 정한다: 콜백은 새 재료가 도착했을 때만 부른다(신선한 캐시에서 곧바로 부르면
//   그릴 때마다 loadTaxonomy 를 부르는 사이드바가 스스로를 끝없이 다시 그린다 — #3870 «분류체계만 들어가면 렉»).
const STALE_MS = 30_000;
const store = createCachedLoader<TaxonomyData>(() => Promise.all([
  api('/api/ui/categories'),
  api('/api/ui/category-groups').catch(() => ({ groups: [] })),
  api('/api/ui/v6/project-lists').catch(() => ({ lists: [] })),
]).then(([c, g, l]: any[]) => {
  const lists = ((l && l.lists) || []) as TaxList[];
  return { cats: ((c && c.categories) || []) as TaxCategory[], groups: ((g && g.groups) || []) as TaxGroup[], lists, counts: countsByCategory(lists) };
}), STALE_MS);

/** 지금 가진 재료(없으면 null). 사이드바가 읽는다. */
export function taxonomyData(): TaxonomyData | null { return store.data(); }
export function taxonomyError(): string { return store.error(); }

/** 재료를 받는다. cb 는 받기가 끝났을 때만(이미 받는 중이면 그 끝에) 부른다 — 신선하면 부르지 않는다. force 면 캐시를 버린다. */
export function loadTaxonomy(cb?: () => void, force = false): void { store.load(cb, force); }

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
  mod.openCategoryForm(c, reload, { repos, groups: store.data()?.groups || [] });
}

// ══════════════════════════════ 화면 ══════════════════════════════

//  앱 안 이동(전체 지도 · 손볼 것 · 분류 하나 사이)은 이 앱이 스스로 듣는다. 셸은 탭 키가 같은 주소끼리는 다시 그리지 않는다
//   (main.ts onHash: routeKey 가 같으면 주소만 갱신, tabs.ts 가 #/taxonomy… 를 한 탭 키로 접는다). 자료 앱(sources.ts)과 같은 규칙이다.
let mounted: { host: HTMLElement; hooks: TaxonomyHooks } | null = null;
let lastDrawn = '';
window.addEventListener('hashchange', () => {
  if (!mounted || !mounted.host.isConnected) { mounted = null; return; }
  const h = location.hash;
  if (h === lastDrawn || !/^#\/taxonomy(\/|\?|$)/.test(h)) return;
  if (!ownsHost(mounted.host)) return;   // 그 칸에 다른 화면이 서 있으면 셸에 맡긴다(덮지 않는다)
  const q = h.indexOf('?');
  const segs = (q >= 0 ? h.slice(2, q) : h.slice(2)).split('/').filter(Boolean);
  renderTaxonomyApp(mounted.host, segs[1] ? decodeURIComponent(segs[1]) : '', new URLSearchParams(q >= 0 ? h.slice(q + 1) : ''), mounted.hooks);
  mounted.hooks.redrawSide();   // 사이드바의 «지금 보는 것» 표시(고정 줄 · 분류 줄)를 따라 옮긴다
});

/** 이 칸에 지금 분류체계가 서 있나. 이 앱의 화면은 늘 칸의 바로 아래에 `.v2-tx` 하나로 선다. */
export function ownsHost(host: HTMLElement): boolean {
  return host.isConnected && !!host.querySelector(':scope > .v2-tx');
}

/** 셸 라우터가 부른다(main.ts). sub = 주소 둘째 칸(분류 id), params = 쿼리. */
export function renderTaxonomyApp(host: HTMLElement, sub: string, params: URLSearchParams, hooks: TaxonomyHooks): void {
  mounted = { host, hooks };
  lastDrawn = location.hash;
  //  화면 번호: 앱 안에서 주소를 옮기면(지도 → 분류 → 다른 분류) 이 함수가 같은 칸에 다시 불린다. 앞 화면이 기다리던
  //   응답이 늦게 와서 새 화면을 덮지 않게, 그린 뒤에도 «지금도 내 화면인가» 를 이 번호로 묻는다.
  const seq = String((Number(host.dataset.txSeq) || 0) + 1);
  host.dataset.txSeq = seq;
  //  한 번 그린 뒤에는 «이 칸이 아직 내 것인가» 도 묻는다. 셸은 같은 칸에 다른 화면(사용 가이드 · 수집 · 증류 …)을 그린다.
  //   그 뒤에 늦게 온 응답이 그 화면을 덮으면 안 된다(#4179, 2026-09-28: 분류체계 → 사용 가이드로 가면 0.3초 뒤 지도가 다시 덮었다).
  let painted = false;
  const live = (): boolean => host.isConnected && host.dataset.txSeq === seq && (!painted || ownsHost(host));
  const paint = (): void => {
    if (!live()) return;
    painted = true;
    const d = store.data();
    if (!d) {
      const err = store.error();
      replaceKids(host, el('div', { class: 'v2-tx' }, ...head([{ t: '분류체계' }], '', []),
        el('p', { class: 'v2-tx-note', text: err ? '분류체계를 불러오지 못했습니다. ' + err : '불러오는 중…' })));
      return;
    }
    host.dataset.txView = sub ? 'detail' : params.get('view') === 'fix' ? 'fix' : 'map';
    if (sub) renderDetail(host, d, Number(sub), hooks, reload, live);
    else if (params.get('view') === 'fix') renderFix(host, d, reload);
    else renderMap(host, d, reload);
  };
  const reload = (): void => { knowCache.clear(); loadTaxonomy(() => { paint(); hooks.redrawSide(); }, true); };
  paint();
  loadTaxonomy(() => { paint(); hooks.redrawSide(); });
}

// ── 전체 지도: 묶음마다 가로 한 줄(레인), 분류는 촘촘한 줄(#4135, 원준 2026-09-27 «3안으로 가자») ──
//  옛 판은 묶음마다 세로 칸이라 분류 26개 묶음만 밑으로 길게 늘어졌다(«밸런스가 엉망»). 이제 묶음은 가로 레인이고,
//   분류 한 줄(이름 · 지식 막대 · 프로젝트 막대)이 1~3단으로 흐른다. 단마다 네 줄까지 보이고 나머지는 [N개 더 보기].
//   빈 분류 · 치운 분류는 레인 끝 접힌 칩. 막대 잣대는 옛 지도와 같다(쓰는 분류 전체의 최댓값).
//  [구조 편집]을 켜면 이 화면에서 고친다(«겉에서도 가능하게»): 묶음 이름 · 한 줄 뜻 · 순서 · 지우기 · 이 묶음에 분류,
//   분류는 끌어 다른 레인에 놓거나 눌러 레인 밑 서랍에서 이름 · 묶음 · 정의 · 설명 · 연결 레포 · 횡단 · 확인 후 반영 · 치우기 · 지우기.
//  전부 기존 API 다. 확인 후 반영 = 인입 정책 규칙 {match_category: <key>, match_actor_kind: 'ai', action: 'confirm'} 하나.
//  검토판(이 화면의 정본 그림): 프로젝트 #4135 taxonomy-lanes-3-plans.html 의 C-3.
const MAP_ROWS = 4;          // 단마다 보이는 줄
const MAP_COL_MIN = 380;     // 단 최소 폭(px). 이름이 잘리지 않을 만큼
const MAP_LEFT = 220;        // 왼쪽 칸 200 + 사이 20. 단 수는 «화면 폭 − 220» 으로 센다(검토판과 같은 잣대 — 본문 여백은 빼지 않는다)
const map = {
  edit: false,
  sel: null as number | 'new' | null,   // 서랍이 연 분류('new' = 새 분류)
  newGroup: '',                          // 새 분류가 들어갈 묶음
  confirm: null as string | null,        // 지우기를 묻는 묶음
  open: new Set<string>(),               // [N개 더 보기]를 편 레인
  xOpen: new Set<string>(),              // 편 칩 줄(`e:<묶음>` 빈 분류 · `a:<묶음>` 치운 분류)
};
interface Policy {
  id: number | string; enabled?: boolean | null; action?: string | null; match_category?: string | null;
  match_system?: string | null; match_channel?: string | null; match_provenance?: string | null; match_sensitive?: string | null;
  match_agent?: string | null; match_type?: string | null;
}
//  서랍이 쓰는 곁재료: 고를 레포 · 인입 정책(확인 후 반영). 지도에 처음 올 때 한 번 받고, 고친 뒤 다시 받는다.
let side: { repos: string[]; policies: Policy[]; canPolicy: boolean } | null = null;
let sideAt = 0;
function loadSide(force: boolean, then: () => void): void {
  if (!force && side && Date.now() - sideAt < STALE_MS) return;
  sideAt = Date.now();
  void Promise.all([
    api('/api/ui/repos').then((r: any) => ((r && r.repos) || []).map((x: any) => String(typeof x === 'string' ? x : (x && x.name) || '')).filter(Boolean)).catch(() => [] as string[]),
    api('/api/ui/org/ingest-policy').catch(() => ({ policies: [], canEdit: false })),
  ]).then(([repos, p]: any[]) => { side = { repos, policies: (p && p.policies) || [], canPolicy: !!(p && p.canEdit) }; then(); });
}
/** 이 분류의 «확인 후 반영» 규칙 — 분류 하나만 거는(다른 조건 없는) 켜진 confirm 규칙. */
const reviewRule = (key: string): Policy | undefined => (side?.policies || []).find((p) => p.enabled !== false && p.action === 'confirm'
  && String(p.match_category || '') === key && !p.match_system && !p.match_channel && !p.match_provenance && !p.match_sensitive && !p.match_agent && !p.match_type);

let mapPaint: (() => void) | null = null;
const mapRO = new WeakMap<HTMLElement, { ro: ResizeObserver; cols: number }>();
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || !mapPaint || document.querySelector('.ov-confirm')) return;
  if (map.sel !== null || map.confirm) { map.sel = null; map.confirm = null; mapPaint(); }
});
const slugKey = (): string => 'c-' + Math.random().toString(16).slice(2, 12).padEnd(10, '0');

function renderMap(host: HTMLElement, d: TaxonomyData, reload: () => void): void {
  host.dataset.txView = 'map';
  const edit = map.edit && canEdit();
  const repaint = (): void => { if (ownsHost(host) && host.dataset.txView === 'map') renderMap(host, d, reload); };
  mapPaint = repaint;
  if (!side) loadSide(false, repaint);
  const active = d.cats.filter((c) => !isArchived(c));
  const lanes = planTaxMap(d.cats, d.groups, d.counts);
  const projOf = (c: TaxCategory): number => (d.counts.get(catId(c)) || { projects: 0 }).projects;
  const maxK = Math.max(0, ...active.map(knowledgeOf));
  const maxP = Math.max(0, ...active.map(projOf));
  const totalK = active.reduce((a, c) => a + knowledgeOf(c), 0);
  const totalP = [...d.counts.values()].reduce((a, x) => a + x.projects, 0);
  const w = host.clientWidth || 1100;
  const rightW = w >= 760 ? w - MAP_LEFT : w;
  const cols = Math.max(1, Math.min(3, Math.floor((rightW + 24) / (MAP_COL_MIN + 24))));
  //  폭이 바뀌어 단 수가 달라질 때만 다시 그린다(서랍에서 치던 글자를 지우지 않게 단 수가 같으면 그대로 둔다).
  let hold = mapRO.get(host);
  if (!hold && typeof ResizeObserver !== 'undefined') {
    const h = { cols, ro: new ResizeObserver(() => {
      //  칸이 다른 화면의 것이 됐으면 폭이 바뀌어도 그리지 않는다(사이드바를 접는 화면으로 가면 칸 폭이 바뀐다).
      if (!ownsHost(host) || host.dataset.txView !== 'map') return;
      const ww = host.clientWidth || 1100; const rw = ww >= 760 ? ww - MAP_LEFT : ww;
      const n = Math.max(1, Math.min(3, Math.floor((rw + 24) / (MAP_COL_MIN + 24))));
      if (n !== h.cols && mapPaint) mapPaint();
    }) };
    h.ro.observe(host); mapRO.set(host, h); hold = h;
  }
  if (hold) hold.cols = cols;

  const act = async (fn: () => Promise<unknown>, ok: string, after?: () => void): Promise<boolean> => {
    try { await fn(); toast(ok); after?.(); reload(); return true; } catch (e: any) { toast((e && e.message) || '실패했습니다', true); return false; }
  };
  const post = (url: string, body: unknown): Promise<unknown> => api(url, { method: 'POST', body: JSON.stringify(body) });
  const groupsSorted = [...d.groups].sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));

  // ── 한 줄: 이름 · 지식 막대 · 프로젝트 막대 ──
  const mb = (cls: string, v: number, max: number): HTMLElement =>
    el('span', { class: 'v2-tx-mb ' + cls },
      el('span', { class: 'v2-tx-btr' }, el('span', { class: 'v2-tx-bfl', style: `width:${barPct(v, max)}%` })),
      el('span', { class: 'v2-tx-bv', text: fmt(v) }));
  const badges = (c: TaxCategory): HTMLElement[] => [
    c.cross_cutting ? el('span', { class: 'v2-tx-bdg', text: '횡단' }) : null,
    c.key && reviewRule(String(c.key)) ? el('span', { class: 'v2-tx-bdg warn', text: '확인 후 반영' }) : null,
    isArchived(c) ? el('span', { class: 'v2-tx-bdg off', text: '치움' }) : null,
    !String(c.should || '').trim() ? el('span', { class: 'v2-tx-bdg warn', text: '정의 없음' }) : null,
  ].filter(Boolean) as HTMLElement[];
  const openCat = (id: number): void => { map.sel = map.sel === id ? null : id; repaint(); scrollDrawer(); };
  const dragAttrs = (id: number): Record<string, unknown> => (edit ? {
    draggable: 'true',
    ondragstart: (ev: DragEvent) => { try { ev.dataTransfer?.setData('text/x-lively-cat', String(id)); ev.dataTransfer!.effectAllowed = 'move'; } catch { /* 끌기 미지원 */ } },
  } : {});
  const row = (c: TaxCategory): HTMLElement => {
    const id = catId(c);
    const kids = [el('span', { class: 't' }, el('span', { class: 'tn', text: c.name }), ...badges(c)), mb('k', knowledgeOf(c), maxK), mb('p', projOf(c), maxP)];
    return edit
      ? el('button', { class: 'v2-tx-row' + (map.sel === id ? ' sel' : '') + (isArchived(c) ? ' dim' : ''), type: 'button', title: c.name, onclick: () => openCat(id), ...dragAttrs(id) }, ...kids)
      : el('a', { class: 'v2-tx-row' + (isArchived(c) ? ' dim' : ''), href: catHref(c), title: c.description || c.name }, ...kids);
  };
  const chip = (c: TaxCategory): HTMLElement => {
    const id = catId(c);
    return edit
      ? el('button', { class: 'v2-tx-ech' + (map.sel === id ? ' sel' : ''), type: 'button', text: c.name, onclick: () => openCat(id), ...dragAttrs(id) })
      : el('a', { class: 'v2-tx-ech', href: catHref(c), text: c.name });
  };

  // ── 레인 오른쪽: 줄 흐름 + 더 보기 + 접힌 칩 ──
  const laneRight = (key: string, rows: Array<{ cat: TaxCategory }>, empty: TaxCategory[], archived: TaxCategory[]): HTMLElement => {
    const full = rows.map((r) => r.cat);
    const cap = cols * MAP_ROWS;
    const open = map.open.has(key);
    const shown = open || full.length <= cap ? full : full.slice(0, cap);
    const per = Math.ceil(shown.length / cols) || 1;
    const colEls: HTMLElement[] = [];
    for (let i = 0; i < cols; i++) {
      const part = shown.slice(i * per, (i + 1) * per);
      if (!part.length) continue;
      colEls.push(el('div', { class: 'v2-tx-rcol' },
        el('div', { class: 'v2-tx-rows-h' }, el('span', { text: '분류' }), el('span', { text: '지식' }), el('span', { text: '프로젝트' })),
        ...part.map(row)));
    }
    const chips: HTMLElement[] = [];
    const fold = (kind: string, label: string, list: TaxCategory[]): void => {
      if (!list.length) return;
      const k = kind + ':' + key; const on = map.xOpen.has(k);
      chips.push(el('button', { class: 'v2-tx-xbtn', type: 'button', 'aria-expanded': String(on),
        onclick: () => { if (on) map.xOpen.delete(k); else map.xOpen.add(k); repaint(); } }, `${on ? '▾' : '›'} ${label} ${list.length}`));
      if (on) chips.push(...list.map(chip));
    };
    fold('e', '빈 분류', empty);
    fold('a', '치운 분류', archived);
    return el('div', { class: 'v2-tx-lane-r' },
      full.length ? el('div', { class: 'v2-tx-rgrid', style: `grid-template-columns:repeat(${cols},minmax(0,1fr))` }, ...colEls)
        : el('p', { class: 'v2-tx-note v2-tx-lane-none', text: '지식이나 프로젝트가 붙은 분류가 아직 없습니다.' }),
      full.length > cap ? el('button', { class: 'v2-tx-moreln', type: 'button',
        onclick: () => { if (open) map.open.delete(key); else map.open.add(key); repaint(); } }, open ? '접기' : `${full.length - cap}개 더 보기 ›`) : null,
      chips.length ? el('div', { class: 'v2-tx-extras' }, ...chips) : null);
  };

  // ── 레인 왼쪽: 묶음 이름 · 뜻 · 합계 (+ 편집) ──
  const saveGroup = (key: string, patch: { name?: string; hint?: string }): void => {
    const g = d.groups.find((x) => x.key === key); if (!g) return;
    const name = patch.name ?? g.name; const hint = patch.hint ?? String(g.hint || '');
    if (name === g.name && hint === String(g.hint || '')) return;
    if (!name.trim()) { repaint(); return; }
    void act(() => post('/api/ui/category-groups', { key, name, hint }), patch.name !== undefined ? '묶음 이름을 바꿨습니다' : '한 줄 뜻을 고쳤습니다');
  };
  const inlineIn = (cls: string, value: string, label: string, placeholder: string, commit: (v: string) => void): HTMLInputElement => {
    const inp = el('input', { class: 'v2-tx-inl ' + cls, type: 'text', value, maxlength: cls === 'nm' ? '80' : '300', 'aria-label': label, placeholder }) as HTMLInputElement;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); inp.blur(); } });
    inp.addEventListener('blur', () => { const v = inp.value.trim(); if (v !== value) commit(v); });
    return inp;
  };
  const moveGroup = (key: string, dir: number): void => {
    const gs = [...groupsSorted]; const i = gs.findIndex((g) => g.key === key); const j = i + dir;
    if (i < 0 || j < 0 || j >= gs.length) return;
    [gs[i], gs[j]] = [gs[j], gs[i]];
    void act(() => Promise.all(gs.map((g, n) => (Number(g.sort) === n ? null
      : post('/api/ui/category-groups', { key: g.key, name: g.name, sort: n })))), '순서를 바꿨습니다');
  };
  const laneLeft = (col: { key: string; name: string; hint: string; rows: Array<{ cat: TaxCategory; knowledge: number; projects: number }>; empty: TaxCategory[]; archived: TaxCategory[] }, gi: number): HTMLElement => {
    const n = col.rows.length + col.empty.length + col.archived.length;
    const tk = col.rows.reduce((a, r) => a + r.knowledge, 0);
    const tp = col.rows.reduce((a, r) => a + r.projects, 0);
    const real = col.key !== NO_GROUP;
    const head = edit && real
      ? [inlineIn('nm', col.name, '묶음 이름', '묶음 이름', (v) => saveGroup(col.key, { name: v })),
         inlineIn('ht', col.hint, '묶음 한 줄 뜻', '한 줄 뜻', (v) => saveGroup(col.key, { hint: v }))]
      : [el('b', { class: 'nm', text: col.name }), col.hint ? el('span', { class: 'ht', text: col.hint }) : null];
    const ctl = edit && real ? el('div', { class: 'ctl' },
      el('button', { class: 'v2-tx-ib', type: 'button', 'aria-label': '위로', disabled: gi === 0, onclick: () => moveGroup(col.key, -1) }, '▲'),
      el('button', { class: 'v2-tx-ib', type: 'button', 'aria-label': '아래로', disabled: gi === groupsSorted.length - 1, onclick: () => moveGroup(col.key, 1) }, '▼'),
      el('button', { class: 'v2-tx-ib', type: 'button', onclick: () => { map.sel = 'new'; map.newGroup = col.key; repaint(); scrollDrawer(); } }, '＋ 분류'),
      el('button', { class: 'v2-tx-ib dan', type: 'button', onclick: () => { map.confirm = col.key; repaint(); } }, '지우기')) : null;
    return el('div', { class: 'v2-tx-lane-l' }, ...head,
      el('div', { class: 'tot' }, '분류 ', el('b', { text: fmt(n) }), ' · 지식 ', el('b', { text: fmt(tk) }), ' · 프로젝트 ', el('b', { text: fmt(tp) })),
      ctl, map.confirm === col.key && real ? groupConfirm(col.key, n) : null);
  };
  const groupConfirm = (key: string, n: number): HTMLElement => {
    const g = d.groups.find((x) => x.key === key)!;
    const others = groupsSorted.filter((x) => x.key !== key);
    const cancel = el('button', { class: 'v2-tx-btn', type: 'button', text: n && !others.length ? '닫기' : '취소', onclick: () => { map.confirm = null; repaint(); } });
    if (n && !others.length) return el('div', { class: 'v2-tx-confirm' }, el('span', { text: '옮길 다른 묶음이 없습니다. 새 묶음을 먼저 만드세요.' }), cancel);
    const sel = n ? el('select', { 'aria-label': '옮길 묶음' }, ...others.map((x) => el('option', { value: x.key, text: x.name }))) as HTMLSelectElement : null;
    return el('div', { class: 'v2-tx-confirm' },
      el('b', { text: `「${g.name}」을 지울까요?` }),
      ...(sel ? [el('span', { text: `분류 ${n}개를` }), sel, el('span', { text: '로 옮깁니다.' })] : [el('span', { text: '든 분류가 없습니다.' })]),
      el('button', { class: 'v2-tx-btn dan', type: 'button', text: '지우기', onclick: () => void act(
        () => post('/api/ui/category-groups/' + encodeURIComponent(key) + '/delete', sel ? { reassign_to: sel.value } : {}), '묶음을 지웠습니다', () => { map.confirm = null; }) }),
      cancel);
  };

  // ── 설정 서랍(레인 밑) ──
  const drawer = (c: TaxCategory | null, groupKey: string): HTMLElement => {
    const isNew = !c;
    const id = c ? catId(c) : 0;
    const key = c ? String(c.key || '') : '';
    const f = (lab: string, forId: string, input: HTMLElement, sub?: string | null, cls = ''): HTMLElement =>
      el('div', { class: cls || null }, el('label', { class: 'l', for: forId, text: lab }), input, sub ? el('div', { class: 'sub', text: sub }) : null);
    const nameIn = el('input', { id: 'txd-nm', type: 'text', maxlength: '200', value: c ? c.name : '', placeholder: '분류 이름' }) as HTMLInputElement;
    const keyIn = isNew ? el('input', { id: 'txd-key', type: 'text', maxlength: '64', placeholder: '비우면 자동(소문자 영문 · 숫자 · -)' }) as HTMLInputElement : null;
    const grpSel = el('select', { id: 'txd-gp' },
      ...(groupsSorted.some((g) => g.key === groupKey) ? [] : [el('option', { value: '', text: '— 묶음 없음 —' })]),
      ...groupsSorted.map((g) => el('option', { value: g.key, text: g.name }))) as HTMLSelectElement;
    grpSel.value = groupsSorted.some((g) => g.key === groupKey) ? groupKey : '';
    const shouldIn = el('textarea', { id: 'txd-sh', rows: '6', maxlength: '8000', placeholder: '이 분류가 무엇을 담고, 무엇은 옆 분류로 가는지' }) as HTMLTextAreaElement;
    shouldIn.value = c ? String(c.should || '') : '';
    const count = el('div', { class: 'sub', text: `증류기가 이 글로 판정합니다 · 400~600자 권장 · 지금 ${shouldIn.value.length}자` });
    shouldIn.addEventListener('input', () => { count.textContent = `증류기가 이 글로 판정합니다 · 400~600자 권장 · 지금 ${shouldIn.value.length}자`; });
    const descIn = el('input', { id: 'txd-ds', type: 'text', maxlength: '2000', value: c ? String(c.description || '') : '', placeholder: '목록에 보일 짧은 설명' }) as HTMLInputElement;
    const linked = new Set((c && Array.isArray(c.repos) ? c.repos : []) as string[]);
    const repoNames = [...new Set([...(side?.repos || []), ...linked])];
    const repoBoxes = repoNames.map((r) => { const cb = el('input', { type: 'checkbox', value: r, checked: linked.has(r) }) as HTMLInputElement; return { r, cb }; });
    const crossIn = el('input', { type: 'checkbox', checked: !!(c && c.cross_cutting) }) as HTMLInputElement;
    const rule = key ? reviewRule(key) : undefined;
    const reviewIn = el('input', { type: 'checkbox', checked: !!rule, disabled: !!side && !side.canPolicy }) as HTMLInputElement;
    const deletable = c ? canDeleteCat(c, d.counts) : false;
    const archived = c ? isArchived(c) : false;

    const save = async (btn: HTMLButtonElement): Promise<void> => {
      const name = nameIn.value.trim();
      if (!name) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
      btn.disabled = true;
      try {
        let cid = id; let ckey = key;
        const group = grpSel.value || null;
        if (isNew) {
          const k = (keyIn!.value.trim().toLowerCase()) || slugKey();
          const r: any = await post('/api/ui/categories', { key: k, name, should: shouldIn.value.trim(), description: descIn.value.trim() || undefined,
            cross_cutting: crossIn.checked || undefined, group });
          cid = Number(r && r.category && r.category.id); ckey = String((r && r.category && r.category.key) || k);
        } else {
          await post('/api/ui/categories/' + cid, { name, should: shouldIn.value.trim() || undefined, description: descIn.value.trim(),
            cross_cutting: crossIn.checked, group });
        }
        const picked = repoBoxes.filter((x) => x.cb.checked).map((x) => x.r);
        if (cid && (picked.length !== linked.size || picked.some((r) => !linked.has(r)))) await post('/api/ui/categories/' + cid + '/repos', { repos: picked });
        if (side?.canPolicy && reviewIn.checked !== !!rule) {
          if (reviewIn.checked) await post('/api/ui/org/ingest-policy', { match_category: ckey, match_actor_kind: 'ai', action: 'confirm', action_update: 'auto', enabled: true,
            note: '분류체계 앱 — 이 분류는 AI 가 만든 지식을 사람이 확인한 뒤 반영' });
          else if (rule) await post('/api/ui/org/ingest-policy/remove', { id: Number(rule.id) });
          loadSide(true, repaint);
        }
        toast(isNew ? '분류를 만들었습니다' : '저장했습니다');
        if (isNew && cid) map.sel = cid;
        reload();
      } catch (e: any) { toast((e && e.message) || '저장하지 못했습니다', true); btn.disabled = false; }
    };
    const saveBtn = el('button', { class: 'v2-tx-btn pri', type: 'button', text: isNew ? '만들기' : '저장', onclick: (ev: MouseEvent) => void save(ev.currentTarget as HTMLButtonElement) }) as HTMLButtonElement;
    const del = async (): Promise<void> => {
      if (!c) return;
      if (!await confirmDialog({ title: `「${c.name}」 분류를 지울까요?`, lines: ['이 분류와 분류 사이 연결이 함께 지워집니다. 되돌릴 수 없습니다.'], confirmText: '지우기', danger: true })) return;
      try { await api('/api/ui/categories/' + id + '/delete', { method: 'POST' }); toast('지웠습니다'); map.sel = null; reload(); }
      catch (e: any) { toast((e && e.message) || '실패했습니다', true); }
    };
    setTimeout(() => { if (isNew && nameIn.isConnected && !nameIn.value) nameIn.focus(); }, 0);
    return el('div', { class: 'v2-tx-drawer', 'data-drawer': isNew ? 'new' : String(id) },
      el('div', { class: 'v2-tx-drawer-h' }, el('b', { text: c ? c.name : '새 분류' }),
        c ? el('span', { class: 'm' }, `지식 ${fmt(knowledgeOf(c))} · 프로젝트 ${fmt(projOf(c))} · 키 `, el('span', { class: 'ky', text: key })) : el('span', { class: 'm', text: '정의는 40자 이상 적어 주세요' })),
      el('div', { class: 'v2-tx-fm' },
        f('이름', 'txd-nm', nameIn),
        isNew ? f('키', 'txd-key', keyIn!, '만든 뒤에는 못 바꿉니다') : f('묶음', 'txd-gp', grpSel),
        el('div', { class: 'def' }, el('label', { class: 'l', for: 'txd-sh', text: '정의 (무엇을 담고, 무엇은 옆 분류로 가나)' }), shouldIn, count),
        isNew ? f('묶음', 'txd-gp', grpSel) : f('설명 한 줄', 'txd-ds', descIn),
        isNew ? f('설명 한 줄', 'txd-ds', descIn) : el('div', {}, el('span', { class: 'l', text: '연결 레포' }),
          repoBoxes.length ? el('div', { class: 'repos' }, ...repoBoxes.map((x) => el('label', {}, x.cb, el('span', { text: x.r }))))
            : el('div', { class: 'sub', text: side ? '등록된 레포가 없습니다' : '불러오는 중…' })),
        el('label', { class: 'v2-tx-tg' }, crossIn, el('div', {}, el('b', { text: '횡단 분류' }), el('span', { text: '여러 분류에 걸친 규약 (개발 규약 · 디자인 시스템처럼)' }))),
        el('label', { class: 'v2-tx-tg' + (reviewIn.disabled ? ' off' : '') }, reviewIn, el('div', {}, el('b', { text: '사람이 확인한 뒤 반영' }),
          el('span', { text: reviewIn.disabled ? '관리자만 바꿀 수 있습니다' : '켜면 AI가 이 분류에 만든 지식은 확인 전까지 주입되지 않습니다' }))),
        el('div', { class: 'acts span' }, saveBtn,
          el('button', { class: 'v2-tx-btn', type: 'button', text: '닫기', onclick: () => { map.sel = null; repaint(); } }),
          el('span', { class: 'sp' }),
          c ? el('button', { class: 'v2-tx-btn', type: 'button', text: archived ? '되살리기' : '치우기',
            onclick: () => void act(() => post('/api/ui/categories/' + id, { state: archived ? 'active' : 'deprecated' }), archived ? '되살렸습니다' : '치웠습니다. 분류 후보에서 빠집니다',
              () => { if (!archived) map.xOpen.add('a:' + groupKeyOf(c)); }) }) : null,
          c ? el('button', { class: 'v2-tx-btn dan', type: 'button', text: '지우기', disabled: !deletable,
            title: deletable ? null : '지식과 프로젝트 목록이 없을 때만 지울 수 있습니다', onclick: () => void del() }) : null)));
  };
  const scrollDrawer = (): void => { requestAnimationFrame(() => { const dr = host.querySelector('.v2-tx-drawer'); if (dr) (dr as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }); };

  // ── 레인 ──
  const selCat = typeof map.sel === 'number' ? d.cats.find((x) => catId(x) === map.sel) || null : null;
  if (typeof map.sel === 'number' && !selCat) map.sel = null;
  const laneEls = lanes.map((col, gi) => {
    const lane = el('div', { class: 'v2-tx-lane', 'data-lane': col.key },
      laneLeft(col as any, gi),
      laneRight(col.key, col.rows as any, col.empty as TaxCategory[], col.archived as TaxCategory[]),
      edit && selCat && groupKeyOf(selCat) === col.key ? drawer(selCat, col.key) : null,
      edit && map.sel === 'new' && (map.newGroup || (lanes[0] && lanes[0].key)) === col.key ? drawer(null, col.key) : null);
    if (edit) {
      lane.addEventListener('dragover', (ev) => {
        if (!ev.dataTransfer || ![...ev.dataTransfer.types].includes('text/x-lively-cat')) return;
        ev.preventDefault(); host.querySelectorAll('.v2-tx-lane.drop').forEach((x) => { if (x !== lane) x.classList.remove('drop'); }); lane.classList.add('drop');
      });
      lane.addEventListener('dragleave', (ev) => { if (!lane.contains(ev.relatedTarget as Node)) lane.classList.remove('drop'); });
      lane.addEventListener('drop', (ev) => {
        lane.classList.remove('drop');
        const id = Number(ev.dataTransfer?.getData('text/x-lively-cat')); if (!id) return;
        ev.preventDefault();
        const c = d.cats.find((x) => catId(x) === id); if (!c || groupKeyOf(c) === col.key) return;
        const g = d.groups.find((x) => x.key === col.key);
        void act(() => post('/api/ui/categories/' + id, { group: col.key || null }), `「${g ? g.name : '묶음 없음'}」 묶음으로 옮겼습니다`);
      });
    }
    return lane;
  });

  const addGroup = (): void => {
    const n = d.groups.length + 1;
    const sort = d.groups.reduce((m, g) => Math.max(m, Number(g.sort) || 0), -1) + 1;
    void act(() => post('/api/ui/category-groups', { name: '새 묶음 ' + n, sort }), '묶음을 만들었습니다');
  };
  const modeBtn = canEdit() ? el('button', { class: 'v2-tx-cmode', type: 'button', 'aria-pressed': String(edit),
    onclick: () => { map.edit = !map.edit; if (!map.edit) { map.sel = null; map.confirm = null; } repaint(); } },
    el('span', { class: 'sw' }), el('span', { text: '구조 편집' })) : null;
  const newBtn = canEdit() ? el('button', { class: 'v2-tx-new', type: 'button', title: '새 분류를 만듭니다',
    onclick: () => { map.edit = true; map.sel = 'new'; map.newGroup = (lanes[0] && lanes[0].key) || ''; repaint(); scrollDrawer(); } },
    icon('plus', 'v2-tx-ic'), el('span', { text: '새 분류' })) : null;

  replaceKids(host, el('div', { class: 'v2-tx' + (edit ? ' editing' : '') },
    ...head([{ t: '분류체계', href: '#/taxonomy' }, { t: '전체 지도' }],
      `분류 ${active.length} · 지식 ${fmt(totalK)} · 프로젝트 ${fmt(totalP)}`,
      [el('span', { class: 'v2-tx-legend' },
        el('span', {}, el('i', { class: 'k' }), el('span', { text: '지식' })),
        el('span', {}, el('i', { class: 'p' }), el('span', { text: '프로젝트' }))),
       el('span', { class: 'sp' }), modeBtn, newBtn]),
    el('div', { class: 'v2-tx-body' },
      !d.cats.length ? el('div', { class: 'v2-tx-empty' },
        el('b', { text: '아직 분류가 없어요' }),
        el('p', { text: '분류는 지식과 프로젝트가 붙는 칸입니다. 분류마다 정의를 적어 두면 증류기가 그 기준으로 지식을 보냅니다.' })) : null,
      edit ? el('p', { class: 'v2-tx-edit-hint', text: '구조 편집 중 · 묶음 이름과 뜻은 왼쪽 칸에서 바로 고치고, 분류는 끌어서 다른 묶음에 놓거나 눌러서 설정을 엽니다.' }) : null,
      el('div', { class: 'v2-tx-lanes' }, ...laneEls),
      edit ? el('div', { class: 'v2-tx-addg' }, el('button', { class: 'v2-tx-btn', type: 'button', text: '＋ 묶음 추가', onclick: addGroup })) : null)));
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
          el('a', { class: 'h', href: '#/projects2/l/' + encodeURIComponent(String(l.id)) }, icon('list', 'v2-tx-ic'),   // #4233 — 목록(리스트) = 점과 줄 셋
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
  const d = store.data();
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
