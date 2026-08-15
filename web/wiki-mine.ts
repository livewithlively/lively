// wiki-mine.ts — #1685 '내 소유 카테고리' 대시보드. WIKI 맨 진입(상단 탭)과 사이드바 ★구역 헤더의 착지점.
//  "위키에 들어갔는데 뭐부터 눌러야 할지 막막하다"의 답 — 첫 화면이 카테고리 벽이 아니라 **내 일감의 최신 상태**다.
//
//  시각 언어(v3): **위키 탭의 기존 문법을 그대로 쓴다** — 새 스타일을 발명하지 않는다.
//  · 상단 = 홈과 동일한 히어로(큰 검색 + 새 페이지 + mono 현황) — 위키의 첫인상이 화면마다 갈리지 않게.
//  · 레인 = 홈 카드(wk-ccard)의 '열린' 형태: 오로라 커버 + 겹친 아이콘 타일 + 이름/mono 메타, 그 아래 wk-row 목록.
//  · 섹션은 wkSection(아이브로우), 꼬리도 홈 '최근 변경'과 같은 행 문법. 컨테이너 폭도 위키 공통 744px 컬럼.
//  v2(잉크 룰 원장)는 탭 통일성을 깨서 폐기 — 사용자 피드백 "위키탭이랑 통일성이 망함".
//
//  카테고리 순서(사용자 설정): 섹션 상단 칩 스트립 = 순서 편집기 — 끌면 레인·칩·사이드바 ★구역·홈 카드가
//  같은 순서로 재배열(kn_home_cat_order_v1 공유, 기기 로컬). 칩 클릭 = 해당 레인 점프.
//
//  내용 계약(불변): 레인 = 최근 문서 5행(민트 틱·'새 글'·유형·시간) · 행=피크 · 커버/이름/전체 보기=카테고리 ·
//  레인마다 ＋ 새 페이지(카테고리 선지정) · 현황 한 줄 · '이어서' · 꼬리 '그 외 최근 변경'.
//  데이터는 전부 경량(#1091 light — 본문 0바이트): 레인은 knFetchCategoryIndex(세션 캐시, 사이드바 트리와 공유),
//  꼬리는 목록 API light=1. 홈이 본문 4MB 를 내려받던 실수를 반복하지 않는다.
import { api, el, relTime } from './core.js';
import { skeletonRows } from './learn.js';
import { KN_TYPE_LABEL, hasMemoryScope, isCategoryHomeDoc, knApplyCatReorder, knCatOrderClear, knCatOrderSaved, knFetchCategoryIndex, knSortByCatOrder } from './wiki-data.js';
import { wkAurora, wkEmpty, wkIsRead, wkResumeRow, wkRow, wkSection } from './wiki-ui.js';
import { openWikiPeek, openWikiSearch, setWikiPeekList } from './wiki-doc.js';

const LANE_DOCS = 5;                    // 레인당 문서 행
const TAIL_CAP = 8;                     // '그 외 최근 변경' 행
const NEW_WINDOW_MS = 7 * 86400000;     // '새 글' 판정 — 생성 7일 이내

// 이번 주 새로 만들어진 문서인가 — 수정만 된 옛 문서에 '새 글'을 붙이면 거짓말이라 created_at 기준.
function wkIsFresh(e: any): boolean {
  const t = Date.parse(e.created_at || '');
  return Number.isFinite(t) && Date.now() - t <= NEW_WINDOW_MS;
}

// 레인에 앉힐 문서만 — 폴더·대문·(index 는 원래 active,pending 만 오지만 방어로) archived 제외, 최신순.
function laneDocsOf(rows: any[]): any[] {
  return rows.filter((r) => !r.is_folder && !isCategoryHomeDoc(r.name) && r.lifecycle !== 'archived')
    .slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

async function renderMineSurface(box: HTMLElement, ctx: any) {
  const owned: Set<string> = ctx.ownedCatIds ? ctx.ownedCatIds() : new Set();
  const bySpace = ctx.bySpace ? ctx.bySpace() : { business: [], product: [], system: [] };
  const allOwned = ['business', 'product', 'system'].flatMap((sk) => bySpace[sk] || [])
    .filter((c) => owned.has(String(c.id)));

  const mine = el('div', { class: 'wk-home wk-mine' });   // 홈과 같은 컬럼 리듬(wk-home) 위에 대시보드 구획만 얹는다
  const refresh = () => ctx.repaint();

  // ── 딥링크로 왔는데 내 소유가 없다 — 사실 + 다음 행동(★ 토글)만. ──
  if (!allOwned.length) {
    const sec = wkSection('★ 내 소유 카테고리');
    sec.body.append(wkEmpty('아직 내 소유 카테고리가 없습니다. 사이드바에서 카테고리에 ★를 켜면 이 화면에 모입니다.',
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '카테고리 훑어보기',
        onclick: () => ctx.selectCategory('') })));
    mine.append(sec.el);
    box.replaceChildren(mine);
    return;
  }

  // ── 히어로 — 홈과 동일한 큰 검색 문 + 새 페이지 + mono 현황(카테고리·지식·이번 주 새 글). ──
  const totalDocs = allOwned.reduce((n, c) => n + (Number(c.knowledge_count) || 0), 0);
  const freshStat = el('span', { class: 'wk-row-m wk-hero-today' });   // '이번 주 새 글 n' — 레인 로드가 채운다
  const searchBtn = el('button', { class: 'wk-hero-search', type: 'button', title: '전체 지식 의미검색 (⌘K)' },
    el('span', { class: 'wk-hero-glass', 'aria-hidden': 'true', text: '🔍' }),
    el('span', { class: 'wk-hero-ph', text: '무엇이든 검색 — 의미로 찾습니다' }),
    el('span', { class: 'wk-hero-kbd', text: '⌘K' }));
  searchBtn.onclick = () => openWikiSearch();
  mine.append(el('div', { class: 'wk-hero' },
    el('div', { class: 'wk-hero-row' },
      searchBtn,
      hasMemoryScope() ? el('a', { class: 'btn btn-primary wk-hero-new', href: '#/knowledge/new',
        title: '새 페이지 — 제목을 쓰면 바로 저장됩니다', text: '＋ 새 페이지' }) : null),
    el('div', { class: 'wk-hero-stats' },
      el('span', { class: 'wk-row-m', text: '카테고리 ' + allOwned.length }),
      el('span', { class: 'wk-row-m', text: '지식 ' + totalDocs }),
      freshStat)));
  const resume = wkResumeRow();
  if (resume) mine.append(resume);

  // ── ★ 내 소유 — 칩 스트립(순서 편집 + 점프) + 레인 스택. ──
  const sec = wkSection('★ 내 소유 카테고리', { count: allOwned.length });
  const strip = el('div', { class: 'wk-mn-strip', role: 'list', 'aria-label': '내 소유 카테고리 순서' });
  const lanesBox = el('div', { class: 'wk-mn-lanes' });
  sec.body.append(strip, lanesBox);
  mine.append(sec.el);

  let freshTotal = 0;
  const ownedDocNames = new Set<string>();          // 꼬리(그 외)에서 내 소유 문서를 걸러낼 근거
  const iconOf = new Map<string, string>();         // 도착한 대문 아이콘 — 칩·레인 재렌더에도 재적용
  const freshOf = new Map<string, number>();        // 카테고리별 이번 주 새 문서 수
  const laneEls = new Map<string, HTMLElement>();   // 순서 변경 시 DOM 만 재배열(재조회 없음)
  const orderedCats = () => knSortByCatOrder(allOwned);
  const letterOf = (c: any) => (Array.from(String(c.name || c.key || '?').trim())[0] || '?').toUpperCase();

  function fillLane(c: any, body: HTMLElement, bits: any, rows: any[]) {
    const docs = laneDocsOf(rows);
    for (const r of docs) ownedDocNames.add(r.name);
    // 헤더 보강 — 대문 아이콘(글자 타일 대체) · 문서 수 · 최근 갱신.
    const homeDoc = rows.find((r) => isCategoryHomeDoc(r.name));
    if (homeDoc && homeDoc.icon) {
      iconOf.set(String(c.id), homeDoc.icon);
      bits.ic.textContent = homeDoc.icon;
      bits.ic.classList.remove('letter');
      if (bits.wm) bits.wm.textContent = homeDoc.icon;
      paintStrip();
    }
    bits.cnt.textContent = docs.length + '개';
    if (docs[0] && docs[0].updated_at) bits.time.textContent = relTime(docs[0].updated_at);
    const freshN = docs.filter(wkIsFresh).length;
    if (freshN) {
      freshOf.set(String(c.id), freshN);
      bits.fresh.textContent = '+' + freshN;
      freshTotal += freshN;
      freshStat.textContent = '이번 주 새 글 ' + freshTotal;
      paintStrip();
    }

    if (!docs.length) {
      body.replaceChildren(wkEmpty('아직 지식이 없습니다.',
        hasMemoryScope() && c.key ? el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge/new?category=' + encodeURIComponent(c.key), text: '＋ 첫 페이지' }) : null));
      // 빈 상태가 이미 '첫 페이지'를 권한다 — 푸터의 새 페이지 링크는 같은 행동의 중복이라 걷는다.
      if (bits.newLink) bits.newLink.remove();
      return;
    }
    const show = docs.slice(0, LANE_DOCS);
    const names = show.map((r) => r.name);
    const open = (e: any, rowEl?: HTMLElement) => { setWikiPeekList(names); openWikiPeek(e.name, { onRefresh: refresh, originEl: rowEl }); };
    body.replaceChildren(...show.map((r) => wkRow(r, {
      open,
      metas: [
        wkIsFresh(r) && !wkIsRead(r.name) ? el('span', { class: 'wk-row-m wk-m-new', text: '새 글' }) : null,
        r.lifecycle === 'pending' ? '검토 대기' : null,
        r.type ? (KN_TYPE_LABEL[r.type] || r.type) : null,
        r.updated_at ? relTime(r.updated_at) : null,
      ].filter(Boolean),
    })));
  }

  function lane(c: any) {
    const id = String(c.id);
    const icon = iconOf.get(id) || '';
    const letter = letterOf(c);
    // 홈 카드(wk-ccard)와 같은 문법 — 오로라 커버 + 겹친 아이콘 타일. 커버·이름 = 카테고리 페이지로.
    const cover = wkAurora(String(c.key || c.id), c.space, { cls: 'wk-lane3-cover', watermark: icon || letter });
    const ic = el('span', { class: 'wk-ccard-ic' + (icon ? '' : ' letter'), 'aria-hidden': 'true', text: icon || letter });
    const cnt = el('span', { class: 'wk-row-m', text: Number.isFinite(Number(c.knowledge_count)) ? c.knowledge_count + '개' : '' });
    const time = el('span', { class: 'wk-row-m' });
    const fresh = el('span', { class: 'wk-row-m wk-m-new', title: '이번 주 새 문서' });
    const go = () => ctx.selectCategory(id);
    cover.classList.add('wk-lane3-go');
    cover.setAttribute('role', 'link');
    cover.setAttribute('tabindex', '0');
    cover.setAttribute('title', (c.name || c.key) + ' — 카테고리 페이지로 이동합니다');
    cover.addEventListener('click', go);
    cover.addEventListener('keydown', (ev: any) => { if (ev.key === 'Enter') go(); });
    const name = el('a', { class: 'wk-lane3-name', href: '#/knowledge?category=' + encodeURIComponent(id),
      title: (c.name || c.key) + ' — 카테고리 페이지로 이동합니다', text: c.name || c.key });
    name.addEventListener('click', (ev: any) => { ev.preventDefault(); go(); });

    const list = el('div', { class: 'wk-lane3-list' }, skeletonRows(3));
    const newLink = hasMemoryScope() && c.key ? el('a', { class: 'wk-sec-act', href: '#/knowledge/new?category=' + encodeURIComponent(c.key),
      title: '이 카테고리에 새 페이지를 만듭니다', text: '＋ 새 페이지' }) : null;
    const foot = el('div', { class: 'wk-lane3-foot' },
      el('button', { class: 'wk-sec-act', type: 'button', text: '전체 보기 →', onclick: go }),
      el('span', { class: 'wk-sec-sp' }),
      newLink);
    const card = el('section', { class: 'wk-lane3', id: 'wkl-' + id },
      cover,
      el('div', { class: 'wk-lane3-body' },
        el('div', { class: 'wk-lane3-headrow' }, ic, name, el('span', { class: 'wk-lane3-hm' }, fresh, cnt, time)),
        list, foot));
    laneEls.set(id, card);
    const bits = { ic, cnt, time, fresh, newLink, wm: cover.querySelector('.wk-aurora-wm') };
    const load = knFetchCategoryIndex(c.id)
      .then((rows) => { if (list.isConnected) fillLane(c, list, bits, rows); })
      .catch(() => { if (list.isConnected) list.replaceChildren(wkEmpty('불러오지 못했습니다.')); });
    return { el: card, load };
  }

  // ── 칩 스트립 — 칩 = 잡아서 옮기는 순서 단위이자 그 레인으로 가는 점프. '이어서' 필과 같은 시각 언어. ──
  let dragId: string | null = null;
  function paintStrip() {
    const cats = orderedCats();
    const slots = cats.map((c) => {
      const id = String(c.id);
      const icon = iconOf.get(id) || '';
      const freshN = freshOf.get(id) || 0;
      const chip = el('button', { class: 'wk-mn-chip', type: 'button',
        title: (c.name || c.key) + ' — 눌러서 해당 레인으로, 끌어서 순서 변경' },
      icon ? el('span', { class: 'wk-mn-chip-ic', 'aria-hidden': 'true', text: icon }) : null,
      el('span', { class: 'wk-mn-chip-name', text: c.name || c.key }),
      freshN ? el('span', { class: 'wk-row-m wk-m-new', text: '+' + freshN }) : null);
      chip.addEventListener('click', () => {
        const laneEl = laneEls.get(id);
        if (!laneEl) return;
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        laneEl.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      });
      const slot = el('div', { class: 'wk-mn-chipslot', role: 'listitem', draggable: 'true', 'data-cat-id': id }, chip);
      slot.addEventListener('dragstart', (ev: any) => {
        dragId = id;
        slot.classList.add('drag-src');
        try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', id); } catch (_) { /* noop */ }
      });
      slot.addEventListener('dragend', () => { dragId = null; strip.querySelectorAll('.drop-before, .drop-after').forEach((n: any) => n.classList.remove('drop-before', 'drop-after')); });
      slot.addEventListener('dragover', (ev: any) => {
        if (!dragId || dragId === id) return;
        ev.preventDefault();
        const r = slot.getBoundingClientRect();
        const before = ev.clientX < r.left + r.width / 2;
        slot.classList.toggle('drop-before', before);
        slot.classList.toggle('drop-after', !before);
      });
      slot.addEventListener('dragleave', () => slot.classList.remove('drop-before', 'drop-after'));
      slot.addEventListener('drop', (ev: any) => {
        if (!dragId || dragId === id) return;
        ev.preventDefault();
        const before = slot.classList.contains('drop-before');
        if (knApplyCatReorder(allOwned, dragId, id, before)) applyOrder();
        dragId = null;
      });
      return slot;
    });
    const tailBits: any[] = [];
    if (knCatOrderSaved().length) {
      tailBits.push(el('button', { class: 'wk-sec-act wk-mn-striptail', type: 'button', title: '끌어서 바꾼 카테고리 순서를 기본으로 되돌립니다', text: '↺ 순서 초기화',
        onclick: () => { knCatOrderClear(); applyOrder(); } }));
    } else if (cats.length > 1) {
      tailBits.push(el('span', { class: 'wk-sec-hint wk-mn-striptail', text: '드래그해서 순서 변경' }));
    }
    strip.replaceChildren(...slots, ...tailBits);
  }
  // 순서 반영 — 레인은 DOM 재배열만(이미 채워진 내용 보존, 재조회 0), 칩은 다시 그린다.
  //  사이드바 ★구역·홈 카드도 같은 키(kn_home_cat_order_v1)를 읽는다.
  function applyOrder() {
    paintStrip();
    lanesBox.append(...orderedCats().map((c) => laneEls.get(String(c.id))).filter(Boolean) as HTMLElement[]);
    if (ctx.onCatChanged) ctx.onCatChanged();   // 사이드바 ★구역 순서도 즉시 맞춘다(rebuild)
  }

  const lanes = orderedCats().map(lane);
  lanesBox.append(...lanes.map((l) => l.el));
  paintStrip();

  // ── 그 외 최근 변경 — 내 소유 밖에서 움직인 문서(경량). 레인들이 끝난 뒤 걸러서 그린다. ──
  const tailFetch = api('/api/ui/knowledge?' + new URLSearchParams({
    limit: '40', orderBy: 'updated_at', injection: 'recalled', light: '1' }))
    .then((r) => (r && r.entries) || []).catch(() => []);
  Promise.allSettled(lanes.map((l) => l.load)).then(async () => {
    const entries = await tailFetch;
    if (!mine.isConnected) return;   // 로딩 중 화면 전환 — 늦은 렌더 폐기
    const rest = entries.filter((e) => !e.is_folder && !isCategoryHomeDoc(e.name) && !ownedDocNames.has(e.name)).slice(0, TAIL_CAP);
    if (!rest.length) return;        // 빈 섹션은 나열하지 않는다
    const sec2 = wkSection('그 외 최근 변경', {
      hint: '내 소유 밖 카테고리에서 최근 바뀐 문서입니다.',
      actions: [el('a', { class: 'wk-sec-act', href: '#/knowledge?all=1', text: '전체 지식 →' })],
    });
    sec2.el.classList.add('wk-mine-tail');
    const names = rest.map((e) => e.name);
    const open = (e: any, rowEl?: HTMLElement) => { setWikiPeekList(names); openWikiPeek(e.name, { onRefresh: refresh, originEl: rowEl }); };
    sec2.body.append(...rest.map((e) => wkRow(e, { open, deck: e.summary || '' })));
    mine.append(sec2.el);
  });

  box.replaceChildren(mine);
}

export { renderMineSurface };
