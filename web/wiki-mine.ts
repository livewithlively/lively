// wiki-mine.ts — #1685 '내 소유 카테고리' 대시보드. WIKI 맨 진입(상단 탭)과 사이드바 ★구역 헤더의 착지점.
//  "위키에 들어갔는데 뭐부터 눌러야 할지 막막하다"의 답 — 첫 화면이 카테고리 벽이 아니라 **내 일감의 최신 상태**다:
//  · 레인 = 내 소유 카테고리 하나(팀 소유 자동 ∪ ★ 토글). 오로라 스트립(홈 카드와 같은 시각 정체성) + 최근 문서 5행.
//  · 행은 최신순 — 민트 틱(사람 저작)·유형·시간, 이번 주 새 문서엔 '새 글'(읽으면 사라짐 — wkIsRead 기기 로컬).
//  · 꼬리 = '그 외 최근 변경'(내 소유 밖) — 조직에서 무엇이 움직이는지 잃지 않는다.
//  데이터는 전부 경량(#1091 light — 본문 0바이트): 레인은 knFetchCategoryIndex(세션 캐시, 사이드바 트리와 공유),
//  꼬리는 목록 API light=1. 홈이 본문 4MB 를 내려받던 실수를 반복하지 않는다.
import { api, el, relTime } from './core.js';
import { skeletonRows } from './learn.js';
import { KN_TYPE_LABEL, hasMemoryScope, isCategoryHomeDoc, knFetchCategoryIndex } from './wiki-data.js';
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
  const cats = ['business', 'product', 'system'].flatMap((sk) => bySpace[sk] || [])
    .filter((c) => owned.has(String(c.id)));   // 순서 = 사이드바 ★구역과 동일(공간순 → API순) — 공간 기억 유지

  const mine = el('div', { class: 'wk-mine' });
  const refresh = () => ctx.repaint();

  // ── 딥링크로 왔는데 내 소유가 없다 — 사실 + 다음 행동(★ 토글)만. ──
  if (!cats.length) {
    mine.append(
      el('div', { class: 'wk-mine-head' }, el('span', { class: 'wk-mine-star', 'aria-hidden': 'true', text: '★' }),
        el('h1', { class: 'wk-mine-title', text: '내 소유 카테고리' })),
      wkEmpty('아직 내 소유 카테고리가 없습니다. 사이드바에서 카테고리에 ★를 켜면 이 화면에 모입니다.',
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '카테고리 훑어보기',
          onclick: () => ctx.selectCategory('') })));
    box.replaceChildren(mine);
    return;
  }

  // ── 헤더 — 이름 + 현황 한 줄(mono) + 행동(검색 ghost · 새 페이지 primary 1개). ──
  const totalDocs = cats.reduce((n, c) => n + (Number(c.knowledge_count) || 0), 0);
  const freshStat = el('span', { class: 'wk-row-m wk-m-new' });   // '이번 주 새 글 n' — 레인 로드가 채운다
  const searchBtn = el('button', { class: 'wk-mine-search', type: 'button', title: '전체 지식 의미검색 (⌘K)' },
    el('span', { 'aria-hidden': 'true', text: '🔍' }),
    el('span', { class: 'wk-mine-search-ph', text: '검색' }),
    el('span', { class: 'wk-hero-kbd', text: '⌘K' }));
  searchBtn.onclick = () => openWikiSearch();
  mine.append(
    el('div', { class: 'wk-mine-head' },
      el('span', { class: 'wk-mine-star', 'aria-hidden': 'true', text: '★' }),
      el('h1', { class: 'wk-mine-title', text: '내 소유 카테고리' }),
      el('span', { class: 'wk-mine-sp' }),
      searchBtn,
      hasMemoryScope() ? el('a', { class: 'btn btn-primary wk-mine-new', href: '#/knowledge/new',
        title: '새 페이지 — 제목을 쓰면 바로 저장됩니다', text: '＋ 새 페이지' }) : null),
    el('div', { class: 'wk-mine-stats' },
      el('span', { class: 'wk-row-m', text: '카테고리 ' + cats.length }),
      el('span', { class: 'wk-row-m', text: '지식 ' + totalDocs }),
      freshStat));
  const resume = wkResumeRow();
  if (resume) mine.append(resume);

  // ── 레인 그리드 — 카테고리마다 골격을 즉시 깔고, 인덱스가 도착하는 대로 각자 채운다. ──
  const grid = el('div', { class: 'wk-mine-grid' });
  mine.append(grid);
  let freshTotal = 0;
  const ownedDocNames = new Set<string>();   // 꼬리(그 외)에서 내 소유 문서를 걸러낼 근거

  function fillLane(c: any, body: HTMLElement, headBits: any, rows: any[]) {
    const docs = laneDocsOf(rows);
    for (const r of docs) ownedDocNames.add(r.name);
    // 헤더 보강 — 대문 아이콘(있으면 글자 타일 대체) · 문서 수 · 최근 갱신.
    const homeDoc = rows.find((r) => isCategoryHomeDoc(r.name));
    if (homeDoc && homeDoc.icon) {
      headBits.ic.textContent = homeDoc.icon;
      headBits.ic.classList.remove('letter');
      if (headBits.wm) headBits.wm.textContent = homeDoc.icon;
    }
    headBits.cnt.textContent = docs.length + '개';
    if (docs[0] && docs[0].updated_at) headBits.time.textContent = relTime(docs[0].updated_at);
    const freshN = docs.filter(wkIsFresh).length;
    if (freshN) { headBits.fresh.textContent = '+' + freshN; freshTotal += freshN; paintFreshStat(); }

    if (!docs.length) {
      body.replaceChildren(wkEmpty('아직 지식이 없습니다.',
        hasMemoryScope() && c.key ? el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge/new?category=' + encodeURIComponent(c.key), text: '＋ 첫 페이지' }) : null));
      // 빈 상태가 이미 '첫 페이지'를 권한다 — 푸터의 새 페이지 링크는 같은 행동의 중복이라 걷는다.
      const dup = headBits.newLink;
      if (dup) dup.remove();
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
    const letter = (Array.from(String(c.name || c.key || '?').trim())[0] || '?').toUpperCase();
    const ic = el('span', { class: 'wk-lane-ic letter', 'aria-hidden': 'true', text: letter });
    const cnt = el('span', { class: 'wk-row-m', text: Number.isFinite(Number(c.knowledge_count)) ? c.knowledge_count + '개' : '' });
    const time = el('span', { class: 'wk-row-m' });
    const fresh = el('span', { class: 'wk-row-m wk-m-new', title: '이번 주 새 문서' });
    const cover = wkAurora(String(c.key || c.id), c.space, { cls: 'wk-lane-cover', watermark: letter });
    const head = el('div', { class: 'wk-lane-head', role: 'link', tabindex: '0', title: (c.name || c.key) + ' — 카테고리 페이지로 이동합니다' },
      cover,
      el('div', { class: 'wk-lane-headrow' },
        ic,
        el('span', { class: 'wk-lane-name', text: c.name || c.key }),
        el('span', { class: 'wk-lane-hm' }, fresh, cnt, time)));
    const go = () => ctx.selectCategory(String(c.id));
    head.addEventListener('click', go);
    head.addEventListener('keydown', (ev: any) => { if (ev.key === 'Enter') go(); });

    const body = el('div', { class: 'wk-lane-body' }, skeletonRows(3));
    const newLink = hasMemoryScope() && c.key ? el('a', { class: 'wk-sec-act', href: '#/knowledge/new?category=' + encodeURIComponent(c.key),
      title: '이 카테고리에 새 페이지를 만듭니다', text: '＋ 새 페이지' }) : null;
    const foot = el('div', { class: 'wk-lane-foot' },
      el('button', { class: 'wk-sec-act', type: 'button', text: '전체 보기 →', onclick: go }),
      el('span', { class: 'wk-sec-sp' }),
      newLink);
    const box2 = el('section', { class: 'wk-lane' }, head, body, foot);
    const bits = { ic, cnt, time, fresh, newLink, wm: cover.querySelector('.wk-aurora-wm') };
    const load = knFetchCategoryIndex(c.id)
      .then((rows) => { if (body.isConnected) fillLane(c, body, bits, rows); })
      .catch(() => { if (body.isConnected) body.replaceChildren(wkEmpty('불러오지 못했습니다.')); });
    return { el: box2, load };
  }

  function paintFreshStat() { freshStat.textContent = freshTotal ? '이번 주 새 글 ' + freshTotal : ''; }

  const lanes = cats.map(lane);
  grid.append(...lanes.map((l) => l.el));

  // ── 그 외 최근 변경 — 내 소유 밖에서 움직인 문서(경량). 레인들이 끝난 뒤 걸러서 그린다. ──
  const tailFetch = api('/api/ui/knowledge?' + new URLSearchParams({
    limit: '40', orderBy: 'updated_at', injection: 'recalled', light: '1' }))
    .then((r) => (r && r.entries) || []).catch(() => []);
  Promise.allSettled(lanes.map((l) => l.load)).then(async () => {
    const entries = await tailFetch;
    if (!mine.isConnected) return;   // 로딩 중 화면 전환 — 늦은 렌더 폐기
    const rest = entries.filter((e) => !e.is_folder && !isCategoryHomeDoc(e.name) && !ownedDocNames.has(e.name)).slice(0, TAIL_CAP);
    if (!rest.length) return;        // 빈 섹션은 나열하지 않는다
    const sec = wkSection('그 외 최근 변경', {
      hint: '내 소유 밖 카테고리에서 최근 바뀐 문서입니다.',
      actions: [el('a', { class: 'wk-sec-act', href: '#/knowledge?all=1', text: '전체 지식 →' })],
    });
    sec.el.classList.add('wk-mine-tail');
    const names = rest.map((e) => e.name);
    const open = (e: any, rowEl?: HTMLElement) => { setWikiPeekList(names); openWikiPeek(e.name, { onRefresh: refresh, originEl: rowEl }); };
    sec.body.append(...rest.map((e) => wkRow(e, { open, deck: e.summary || '' })));
    mine.append(sec.el);
  });

  box.replaceChildren(mine);
}

export { renderMineSurface };
