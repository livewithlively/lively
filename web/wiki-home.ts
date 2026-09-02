// wiki-home.ts — #764v2 위키 홈. "첫 화면이 목록 벽이면 거부감이 든다" 피드백의 답:
//  히어로(큰 검색 진입 + 첫 행동) → 카테고리 카드 그리드(오로라 커버 — 사용자가 좋아했던 카드형 복원,
//  드래그 정렬 #657h3 계약 유지: localStorage kn_home_cat_order_v1·그룹 경계 불가침) →
//  시작하기 문서 카드(데크 발췌) → 최근 변경(날짜 구분선 + 2열 리치 카드 — 내용은 유지, 표현을 초대장으로).
//  시각 재료는 전부 UI 가 생성한다(오로라·워터마크·아이콘) — 사진 업로드 없음.
import { api, busy, el, errorNote, relTime, state } from './core.js';
import { skeletonRows } from './learn.js';
import { hasMemoryScope, isCategoryHomeDoc, knFetchCategoryIndex } from './wiki-data.js';
import { wkAurora, wkDayLabel, wkDocCard, wkEmpty, wkReadVisits, wkSection } from './wiki-ui.js';
import { openWikiPeek, openWikiSearch, setWikiPeekList } from './wiki-doc.js';

const HOME_PIN_CAP = 8;
const HOME_DAY_CAP = 8;

// ── 카드 순서(드래그 정렬) — #657h3 과 같은 localStorage 키(기존 사용자 순서 승계). 기기별. ──
const WK_HOME_ORDER = 'kn_home_cat_order_v1';
function homeOrderSaved(): string[] {
  try { const v = JSON.parse(localStorage.getItem(WK_HOME_ORDER) || '[]'); return Array.isArray(v) ? v.map(String) : []; }
  catch (_) { return []; }
}
function homeOrderSave(ids: string[]) { try { localStorage.setItem(WK_HOME_ORDER, JSON.stringify(ids)); } catch (_) { /* noop */ } }
function homeOrderClear() { try { localStorage.removeItem(WK_HOME_ORDER); } catch (_) { /* noop */ } }
// 저장 순서를 앞에, 미지정(신설)은 원래 순서대로 뒤에 — 안정 병합.
function homeSortByOrder(cats: any[], order: string[]) {
  if (!order.length) return cats.slice();
  const pos = new Map(order.map((id, i) => [String(id), i]));
  return cats.slice().sort((a, b) => {
    const pa = pos.has(String(a.id)) ? (pos.get(String(a.id)) as number) : 1e9;
    const pb = pos.has(String(b.id)) ? (pos.get(String(b.id)) as number) : 1e9;
    return pa - pb;
  });
}

async function renderHomeSurface(box: HTMLElement, ctx: any) {
  busy(box, el('div', { class: 'wk-home' }, skeletonRows(4)));
  let pinned: any[] = [];
  let recent: any[] = [];
  try {
    [pinned, recent] = await Promise.all([
      api('/api/ui/knowledge?' + new URLSearchParams({ is_wiki: 'true', limit: '50', orderBy: 'updated_at', injection: 'recalled' }))
        .then((r) => ((r && r.entries) || []).filter((e) => !isCategoryHomeDoc(e.name))).catch(() => []),
      api('/api/ui/knowledge?' + new URLSearchParams({ limit: '40', orderBy: 'updated_at', injection: 'recalled' }))
        .then((r) => ((r && r.entries) || []).filter((e) => !isCategoryHomeDoc(e.name))),
    ]);
  } catch (e) { box.replaceChildren(errorNote(e, '위키를 불러오지 못했습니다')); return; }
  if (!box.isConnected) return;   // 로딩 중 화면 전환 — 늦은 렌더 폐기

  const home = el('div', { class: 'wk-home wk-home-v2' });
  const refresh = () => ctx.repaint();
  const openFrom = (names: string[]) => (e: any, rowEl?: HTMLElement) => {
    setWikiPeekList(names);
    openWikiPeek(e.name, { onRefresh: refresh, originEl: rowEl });
  };

  const allCats: any[] = (ctx.cats ? ctx.cats() : []) || [];
  const myIds = new Set(((state.me && (state.me as any).team_category_ids) || []).map((x: any) => String(x)));

  // ── 히어로 — "뭐부터 건드려야 할지"의 답: 검색이라는 큰 문 하나 + 새 페이지. 아래 mono 현황 한 줄. ──
  const totalDocs = allCats.reduce((n, c) => n + (Number(c.knowledge_count) || 0), 0);
  const todayN = recent.filter((e) => wkDayLabel(e.updated_at) === '오늘').length;
  const searchBtn = el('button', { class: 'wk-hero-search', type: 'button', title: '전체 지식 의미검색 (⌘K)' },
    el('span', { class: 'wk-hero-glass', 'aria-hidden': 'true', text: '🔍' }),
    el('span', { class: 'wk-hero-ph', text: '무엇이든 검색 — 의미로 찾습니다' }),
    el('span', { class: 'wk-hero-kbd', text: '⌘K' }));
  searchBtn.onclick = () => openWikiSearch();
  const hero = el('div', { class: 'wk-hero' },
    el('div', { class: 'wk-hero-row' },
      searchBtn,
      hasMemoryScope() ? el('a', { class: 'btn btn-primary wk-hero-new', href: '#/knowledge/new',
        title: '새 페이지 — 제목을 쓰면 바로 저장', text: '＋ 새 페이지' }) : null),
    el('div', { class: 'wk-hero-stats' },
      el('span', { class: 'wk-row-m', text: '지식 ' + totalDocs }),
      el('span', { class: 'wk-row-m', text: '카테고리 ' + allCats.length }),
      todayN ? el('span', { class: 'wk-row-m wk-hero-today', text: '오늘 갱신 ' + todayN }) : null));
  home.append(hero);

  // 이어서 — 마지막으로 열었던 문서 필(히어로 바로 아래, 조용히).
  const visits = wkReadVisits().slice(0, 3);
  if (visits.length) {
    const row = el('div', { class: 'wk-resume' }, el('span', { class: 'wk-resume-label', text: '이어서' }));
    for (const v of visits) {
      row.append(el('a', { class: 'wk-resume-it', href: '#/k/' + encodeURIComponent(v.name), title: v.title },
        v.icon ? el('span', { class: 'wk-resume-ic', 'aria-hidden': 'true', text: v.icon }) : null,
        el('span', { text: v.title })));
    }
    home.append(row);
  }

  // ── 카테고리 카드 그리드 — 오로라 커버 + 아이콘 타일 + 이름/설명 + mono 메타. ──
  //  ★ 내 소유(팀 오너십 = 우선순위)가 큰 카드로 먼저, 그 외는 컴팩트 카드. 그룹 '안'에서만 드래그 정렬.
  const enrich = new Map<string, any>();   // cat.id → { icEl, timeEl, icNow } 점진 보강 슬롯
  const arrived = new Map<string, { icon: string, latest: string, docNames: Set<string> }>();   // 도착한 보강값(재렌더에도 재적용)
  let dragId: string | null = null;
  let dragGroup: string | null = null;

  function catCard(c: any, group: string, compact: boolean) {
    const seedIcon = enrichIconOf(c);
    const icEl = el('span', { class: 'wk-ccard-ic' + (seedIcon ? '' : ' letter'), 'aria-hidden': 'true',
      text: seedIcon || (Array.from(String(c.name || c.key || '?').trim())[0] || '?').toUpperCase() });
    const timeEl = el('span', { class: 'wk-row-m wk-ccard-time' });
    const cnt = Number(c.knowledge_count);
    const otherTeam = c.owner_team_name && !myIds.has(String(c.id)) ? c.owner_team_name : '';
    const card = el('div', { class: 'wk-ccard' + (compact ? ' compact' : ''), role: 'link', tabindex: '0', title: c.name || c.key },
      wkAurora(String(c.key || c.id), { cls: 'wk-ccard-cover', watermark: seedIcon || (Array.from(String(c.name || c.key || '?').trim())[0] || '').toUpperCase() }),
      el('div', { class: 'wk-ccard-body' },
        icEl,
        el('div', { class: 'wk-ccard-main' },
          el('div', { class: 'wk-ccard-name', text: c.name || c.key }),
          c.description ? el('div', { class: 'wk-ccard-desc', text: c.description }) : null),
        el('div', { class: 'wk-ccard-meta' },
          otherTeam ? el('span', { class: 'wk-row-m wk-otherteam', title: '담당 팀', text: otherTeam }) : null,
          Number.isFinite(cnt) ? el('span', { class: 'wk-row-m', text: cnt + '개' }) : null,
          timeEl)));
    const prevSlot = enrich.get(String(c.id)) || {};
    enrich.set(String(c.id), Object.assign(prevSlot, { icEl, timeEl, wm: card.querySelector('.wk-aurora-wm') }));
    const go = () => ctx.selectCategory(String(c.id));
    card.addEventListener('click', go);
    card.addEventListener('keydown', (ev: any) => { if (ev.key === 'Enter') go(); });

    // 드래그 정렬(#657h3 동형) — 슬롯 래퍼의 ::before/::after 가 삽입 디바이더. 그룹 경계는 넘지 못한다.
    const slot = el('div', { class: 'wk-hslot', draggable: 'true', 'data-cat-id': String(c.id), 'data-group': group }, card);
    slot.addEventListener('dragstart', (ev: any) => {
      dragId = String(c.id); dragGroup = group;
      slot.classList.add('drag-src');
      try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(c.id)); } catch (_) { /* noop */ }
    });
    slot.addEventListener('dragend', () => { dragId = null; dragGroup = null; clearDropHints(); });
    slot.addEventListener('dragover', (ev: any) => {
      if (!dragId || dragGroup !== group || dragId === String(c.id)) return;
      ev.preventDefault();
      const r = slot.getBoundingClientRect();
      const before = ev.clientX < r.left + r.width / 2;
      slot.classList.toggle('drop-before', before);
      slot.classList.toggle('drop-after', !before);
    });
    slot.addEventListener('dragleave', () => slot.classList.remove('drop-before', 'drop-after'));
    slot.addEventListener('drop', (ev: any) => {
      if (!dragId || dragGroup !== group || dragId === String(c.id)) return;
      ev.preventDefault();
      const before = slot.classList.contains('drop-before');
      applyReorder(dragId, String(c.id), before);
      dragId = null; dragGroup = null;
    });
    return slot;
  }
  function clearDropHints() {
    home.querySelectorAll('.wk-hslot.drop-before, .wk-hslot.drop-after').forEach((n: any) => n.classList.remove('drop-before', 'drop-after'));
  }
  function enrichIconOf(c: any): string {
    const slot = enrich.get(String(c.id));
    return (slot && slot.icNow) || '';
  }
  // 순서 재계산 — 화면 밖(다른 그룹 포함) id 까지 보존해 저장.
  function applyReorder(src: string, target: string, before: boolean) {
    const cur = homeSortByOrder(allCats, homeOrderSaved()).map((c) => String(c.id));
    const from = cur.indexOf(src);
    if (from < 0) return;
    cur.splice(from, 1);
    let to = cur.indexOf(target);
    if (to < 0) return;
    if (!before) to += 1;
    cur.splice(to, 0, src);
    homeOrderSave(cur);
    paintCats();   // 카드 구역만 조용히 재렌더(캐시 데이터 — 깜빡임 없음)
  }

  const catsWrap = el('div', {});
  function paintCats() {
    const ordered = homeSortByOrder(allCats, homeOrderSaved());
    const mine = ordered.filter((c) => myIds.has(String(c.id)));
    const rest = ordered.filter((c) => !myIds.has(String(c.id)));
    const hasCustom = homeOrderSaved().length > 0;
    const orderCtl = hasCustom
      ? el('button', { class: 'wk-sec-act', type: 'button', title: '드래그로 바꾼 카드 순서를 기본으로 되돌립니다', text: '정렬 초기화',
          onclick: () => { homeOrderClear(); paintCats(); } })
      : el('span', { class: 'wk-sec-hint', text: '드래그해서 순서 변경' });
    const parts: any[] = [];
    if (mine.length) {
      const sec = wkSection('★ 내 소유 카테고리', { count: mine.length, actions: [orderCtl] });
      sec.el.classList.add('wk-sec-cats');
      const grid = el('div', { class: 'wk-ccard-grid' }, ...mine.map((c) => catCard(c, 'mine', false)));
      sec.body.append(grid);
      parts.push(sec.el);
    }
    if (rest.length) {
      const sec = wkSection(mine.length ? '그 외 카테고리' : '카테고리', { count: rest.length, actions: mine.length ? [] : [orderCtl] });
      sec.el.classList.add('wk-sec-cats');
      const grid = el('div', { class: 'wk-ccard-grid compact' }, ...rest.map((c) => catCard(c, 'rest', true)));
      sec.body.append(grid);
      parts.push(sec.el);
    }
    catsWrap.replaceChildren(...parts);
    applyEnrichment();   // 재렌더 후에도 이미 도착한 보강값 즉시 반영
  }
  home.append(catsWrap);

  // ── 시작하기 — 인덱스 핀 문서 카드(데크 발췌). 신규 입사자의 첫 목차가 '읽고 싶은 카드'로. ──
  if (pinned.length) {
    const show = pinned.slice(0, HOME_PIN_CAP);
    const names = show.map((e) => e.name);
    const sec = wkSection('시작하기', {
      count: pinned.length,
      hint: '인덱스에 핀된 문서 — 매 대화 첫머리에 항상 깔립니다',
      actions: pinned.length > HOME_PIN_CAP
        ? [el('button', { class: 'wk-sec-act', type: 'button', text: '전체 →', onclick: () => ctx.selectCategory('__indexed__') })]
        : [],
    });
    sec.body.append(el('div', { class: 'wk-doccard-grid wk-pinned-grid' },
      ...show.map((e) => wkDocCard(e, { open: openFrom(names), deckCap: 110 }))));
    home.append(sec.el);
  }

  // ── 최근 변경 — 날짜 구분선 + 2열 리치 카드(제목·발췌·mono 메타). "내용은 좋은데 UI 가 구리다"의 답. ──
  const recentSec = wkSection('최근 변경', {
    actions: [el('a', { class: 'wk-sec-act', href: '#/knowledge?all=1', text: '전체 지식 →' })],
  });
  const recentNames = recent.map((e) => e.name);
  const recentCatEls = new Map<string, any>();   // name → 카테고리명 슬롯(점진 보강)
  if (!recent.length) {
    recentSec.body.append(wkEmpty('아직 지식이 없어요. 첫 페이지로 시작해 보세요.',
      hasMemoryScope() ? el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge/new', text: '＋ 첫 페이지' }) : null));
  } else {
    let curDay = '';
    let dayCount = 0;
    let hiddenInDay = 0;
    let grid: any = null;
    const flushHidden = () => {
      if (hiddenInDay > 0 && grid) grid.after(el('div', { class: 'wk-day-more', text: '… ' + hiddenInDay + '개 더' }));
      hiddenInDay = 0;
    };
    for (const e of recent) {
      const day = wkDayLabel(e.updated_at);
      if (day !== curDay) {
        flushHidden();
        curDay = day;
        dayCount = 0;
        recentSec.body.append(el('div', { class: 'wk-day-rule' }, el('span', { class: 'wk-day-rule-label', text: day })));
        grid = el('div', { class: 'wk-doccard-grid wk-recent-grid' });
        recentSec.body.append(grid);
      }
      if (dayCount >= HOME_DAY_CAP) { hiddenInDay++; continue; }
      dayCount++;
      const catSlot = el('span', { class: 'wk-row-m wk-row-cat' });
      recentCatEls.set(e.name, catSlot);
      grid.append(wkDocCard(e, { open: openFrom(recentNames), deckCap: 100, cls: 'recent', metas: [catSlot] }));
    }
    flushHidden();
  }
  home.append(recentSec.el);
  paintCats();
  box.replaceChildren(home);

  // ── 점진 보강 — 카테고리 rows(세션 캐시)가 도착하는 대로 카드 아이콘(대문 props_ui.icon)·최근 갱신·
  //  최근 카드의 카테고리명을 채운다. 재렌더 후에도 applyEnrichment 로 재적용. ──
  function applyEnrichment() {
    for (const [id, got] of arrived) {
      const slot = enrich.get(id);
      if (slot && slot.icEl && slot.icEl.isConnected) {
        if (got.icon) {
          slot.icNow = got.icon;
          slot.icEl.textContent = got.icon;
          slot.icEl.classList.remove('letter');
          if (slot.wm) slot.wm.textContent = got.icon;
        }
        if (got.latest && slot.timeEl) slot.timeEl.textContent = relTime(got.latest);
      }
    }
  }
  for (const c of allCats) {
    knFetchCategoryIndex(c.id).then((rows) => {
      const homeDoc = rows.find((r) => isCategoryHomeDoc(r.name));
      const latest = rows.filter((r) => !isCategoryHomeDoc(r.name))
        .reduce((m, r) => (String(r.updated_at || '') > m ? String(r.updated_at) : m), '');
      const slot0 = enrich.get(String(c.id)) || {};
      slot0.icNow = (homeDoc && homeDoc.icon) || slot0.icNow || '';
      enrich.set(String(c.id), slot0);
      arrived.set(String(c.id), { icon: (homeDoc && homeDoc.icon) || '', latest, docNames: new Set(rows.map((r) => r.name)) });
      applyEnrichment();
      for (const r of rows) {
        const catSlot = recentCatEls.get(r.name);
        if (catSlot && catSlot.isConnected && !catSlot.textContent) catSlot.textContent = c.name || c.key;
      }
    }).catch(() => { /* 점진 보강 실패 — 기본 표기 유지 */ });
  }
}

export { renderHomeSurface };
