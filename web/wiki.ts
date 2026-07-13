// wiki.ts — #764 WIKI 탭 진입점(라우터 대면). "위키에는 페이지와, 페이지를 찾는 팝업뿐이다."
//  셸 = [사이드바(유지 표면 — wiki-side)] + [콘텐츠 한 장]: 홈(wiki-home) / 카테고리 페이지(wiki-category) /
//  필터 목록(검색·인덱스·전체 — 이 파일) / 휴지통 / 자료. 문서(#/k)·드래프트는 wiki-doc.
//  URL 계약(구 딥링크 호환): #/knowledge?category=N&folder=&type=&q=&indexed=1&all=1&peek=<name>
//  (?tab= 은 #657 대문/문서 탭의 잔재 — 파싱 시 무시한다. 탭이라는 모드 자체를 폐지했다.)
import { api, el, errorNote, relTime, selectFilter, state, toast } from './core.js';
import { skeleton, skeletonRows } from './learn.js';
import { KN_TYPE_LABEL, SOURCE_KIND_LABEL, isCategoryHomeDoc, knInvalidateTreeCaches, openSourceDetail } from './wiki-data.js';
import { KN_INDEXED, createWikiSide, knApplySideW, knSideResizeHandle } from './wiki-side.js';
import { wkDayLabel, wkEmpty, wkRow, wkSection } from './wiki-ui.js';
import { openWikiPeek, reanchorWikiPeek, renderWikiDraft, setWikiPeekList } from './wiki-doc.js';
import { renderCategorySurface } from './wiki-category.js';
import { renderHomeSurface } from './wiki-home.js';

// ── 라우터 진입 — sub ∈ { ''|new|pinned|sources|기타(구 space URL — 무시) } ──
async function renderWiki(view, sub, params) {
  if (sub === 'new') return renderWikiDraft(view, params);
  if (sub === 'pinned') { location.replace('#/knowledge?indexed=1'); return; }   // 구 링크 보존
  if (sub === 'sources') return renderSources(view);
  return renderWikiSpace(view, params);
}

// ── WIKI 셸 — 사이드바 + 콘텐츠 한 장. 상태 f 는 세션 전역(state.wiki). ──
async function renderWikiSpace(view, params) {
  const f = (state as any).wiki = (state as any).wiki || { category: '', folder: '', type: '', q: '', indexed: false, all: false };
  // 파라미터 없는 진입 = 상단 WIKI 탭 클릭 등 '맨 진입' — 홈으로 리셋(이전 카테고리가 복원되면 놀란다).
  if (!params || Array.from(params.keys()).length === 0) {
    f.category = ''; f.folder = ''; f.type = ''; f.q = ''; f.indexed = false; f.all = false;
  }
  if (params) {
    // category 딥링크는 폴더 드릴다운을 리셋 — 세션 잔존 f.folder 가 다른 카테고리로 새면
    //  '폴더가 비어 있어요' 빈 화면이 뜬다. ?category=..&folder=.. 조합은 아래 folder 절이 다시 채운다.
    if (params.has('category')) { f.category = params.get('category') || ''; f.indexed = false; f.all = false; f.folder = ''; }
    if (params.has('folder')) f.folder = params.get('folder') || '';
    if (params.has('type')) f.type = params.get('type') || '';
    if (params.has('q')) f.q = params.get('q') || '';
    if (params.has('indexed')) { f.indexed = params.get('indexed') === '1'; if (f.indexed) { f.category = ''; f.folder = ''; f.all = false; } }
    if (params.has('all')) { f.all = params.get('all') === '1'; if (f.all) { f.category = ''; f.folder = ''; f.indexed = false; } }
  }
  if (!f.category) f.folder = '';   // 폴더는 카테고리 컨텍스트에서만

  view.replaceChildren(el('div', { class: 'wk-plainpad' }, skeleton('위키를 여는 중')));

  // URL 동기화 — replaceState(피크 파라미터는 승계). 피크 기준 해시 재앵커.
  function syncHash() {
    const p = new URLSearchParams();
    if (f.indexed) p.set('indexed', '1');
    else if (f.all) p.set('all', '1');
    else if (f.category) p.set('category', f.category);
    if (f.folder) p.set('folder', f.folder);
    if (f.type) p.set('type', f.type);
    if (f.q) p.set('q', f.q);
    const curQ = location.hash.indexOf('?');
    const peek = curQ >= 0 ? new URLSearchParams(location.hash.slice(curQ + 1)).get('peek') : null;
    if (peek) p.set('peek', peek);
    const qs = p.toString();
    history.replaceState(null, '', '#/knowledge' + (qs ? '?' + qs : ''));
    reanchorWikiPeek();
  }

  const main = el('section', { class: 'wk-main' });
  const sideCtl = createWikiSide({
    selected: () => (f.indexed ? KN_INDEXED : f.category),
    onSelect: (v) => selectCategory(v),
    onOpen: (name) => { setWikiPeekList(null); openWikiPeek(name, { onRefresh: repaint }); },
    tools: true,
  });
  const ctx = {
    f,
    syncHash,
    repaint,
    selectCategory,
    onCatChanged: () => sideCtl.rebuild(),
    bySpace: sideCtl.bySpace,
    findCat: sideCtl.findCat,
  };

  function selectCategory(v: string) {
    if (v === KN_INDEXED) { f.indexed = true; f.category = ''; }
    else { f.indexed = false; f.category = v || ''; }
    f.folder = ''; f.type = ''; f.q = ''; f.all = false;
    syncHash();
    sideCtl.rebuild();
    repaint();
  }

  // repaint 는 매번 새 surface 박스를 깐다 — 사이드바 연타 등으로 비동기 렌더가 겹쳐도
  //  늦게 끝난 이전 렌더는 자기(분리된) 박스에 그릴 뿐 최신 화면을 덮지 못한다.
  function repaint() {
    const box = el('div', { class: 'wk-surface' });
    main.replaceChildren(box);
    // type 이 category 와 함께면 카테고리 페이지의 인라인 필터가 처리 — 단독 딥링크만 목록으로.
    if (f.q || f.all || f.indexed || (f.type && !f.category)) return renderFilterList(box, ctx);
    if (f.category) {
      const cat = sideCtl.findCat(f.category);
      if (cat) return renderCategorySurface(box, cat, ctx);
      // 카테고리를 못 찾음(삭제/딥링크 오류) — 홈으로 조용히 폴백.
      f.category = ''; f.folder = '';
      syncHash();
      sideCtl.rebuild();
    }
    return renderHomeSurface(box, ctx);
  }

  const shell = el('div', { class: 'kn-shell' }, sideCtl.side, main);
  knApplySideW(shell); shell.append(knSideResizeHandle(shell));
  await sideCtl.ready;   // 카테고리 해석(findCat)·홈 지도(bySpace)에 필요
  // 로딩(카테고리 fetch) 중 사용자가 다른 탭으로 떠났으면 여기서 멈춘다 — 늦은 mount 가
  //  남의 화면을 덮고 replaceState 로 주소까지 되돌리는 경합 방지(라우터가 dataset.route 를 즉시 세팅).
  if (document.body.dataset.route !== 'knowledge') return;
  view.replaceChildren(shell);
  syncHash();
  repaint();
  // &peek= 딥링크/뒤·앞으로가기 복원 — pushState 없이 현 URL 그대로 자동 오픈.
  const peekName = params && params.get && params.get('peek');
  if (peekName) openWikiPeek(peekName, { fromUrl: true, onRefresh: repaint });
}

// ── 필터 목록 — 검색(q)·인덱스(핀)·전체. 한 장의 평면 목록 + 정직한 헤더(무엇으로 좁혀졌나). ──
async function renderFilterList(box: HTMLElement, ctx: any) {
  const f = ctx.f;
  box.replaceChildren(el('div', { class: 'wk-home' }, skeletonRows(4)));
  const p = new URLSearchParams({ limit: '200', orderBy: 'updated_at', injection: 'recalled' });
  if (f.indexed) p.set('is_wiki', 'true');
  if (f.category && !f.indexed) p.set('category', f.category);
  if (f.type) p.set('type', f.type);
  if (f.q) p.set('q', f.q);
  let entries: any[] = [];
  try {
    entries = await api('/api/ui/knowledge?' + p).then((r) => ((r && r.entries) || []).filter((e) => !isCategoryHomeDoc(e.name)));
  } catch (e) { box.replaceChildren(errorNote(e, '목록을 불러오지 못했습니다')); return; }

  const title = f.indexed ? '인덱스' : (f.q ? '검색' : '전체 지식');
  const clearBits: any[] = [];
  if (f.q) clearBits.push(el('button', { class: 'wk-filter-chip', type: 'button', title: '검색 지우기', text: '"' + f.q + '" ×',
    onclick: () => { f.q = ''; ctx.syncHash(); ctx.repaint(); } }));
  if (f.type) clearBits.push(el('button', { class: 'wk-filter-chip', type: 'button', title: '유형 필터 지우기', text: (KN_TYPE_LABEL[f.type] || f.type) + ' ×',
    onclick: () => { f.type = ''; ctx.syncHash(); ctx.repaint(); } }));
  const cat = f.category ? ctx.findCat(f.category) : null;
  if (cat) clearBits.push(el('button', { class: 'wk-filter-chip', type: 'button', title: '카테고리 필터 지우기', text: (cat.name || cat.key) + ' ×',
    onclick: () => { f.category = ''; f.folder = ''; ctx.syncHash(); ctx.repaint(); } }));

  const sec = wkSection(title, {
    count: entries.length,
    hint: f.indexed ? '매 대화 첫머리에 항상 깔리는 핀 문서' : (f.q ? '제목·본문 일치(정확 검색) — 의미로 찾으려면 ⌘K' : null),
    actions: clearBits,
  });
  const names = entries.map((e) => e.name);
  if (!entries.length) {
    sec.body.append(wkEmpty(f.q ? '일치하는 문서가 없어요 — ⌘K 의미검색으로 시도해 보세요.' : '문서가 없습니다.'));
  } else {
    let curDay = '';
    for (const e of entries) {
      if (!f.q) {
        const day = wkDayLabel(e.updated_at);
        if (day !== curDay) { curDay = day; sec.body.append(el('div', { class: 'wk-day-label', text: day })); }
      }
      sec.body.append(wkRow(e, {
        open: (x, rowEl) => { setWikiPeekList(names); openWikiPeek(x.name, { onRefresh: ctx.repaint, originEl: rowEl }); },
      }));
    }
  }
  box.replaceChildren(el('div', { class: 'wk-home' }, sec.el));
}

// ════════════════════════════════════════════
// 휴지통 #/trash — 죽은 문서는 바랜다(전 행 dim). 복원은 본체만(cascade 링크는 안 돌아옴).
// ════════════════════════════════════════════
const TRASH_ENTITY_LABEL = { knowledge: '지식', project: '프로젝트', category: '카테고리' };

async function renderWikiTrash(view) {
  view.replaceChildren(el('div', { class: 'wk-plainpad' }, skeleton('삭제된 항목을 불러오는 중')));
  let entries: any[] = [];
  try {
    entries = await api('/api/ui/deleted').then((d) => (d && d.entries) || []);
  } catch (e) {
    view.replaceChildren(el('div', { class: 'wk-plainpad' }, errorNote(e, '휴지통을 불러오지 못했습니다')));
    return;
  }
  if (document.body.dataset.route !== 'trash') return;   // 로딩 중 라우트 이탈 — 늦은 mount 방지
  const sec = wkSection('휴지통', {
    count: entries.length,
    hint: '삭제된 지식·프로젝트·카테고리 — 본체만 복원됩니다(삭제 시 정리된 연결은 제외)',
    actions: [el('a', { class: 'wk-sec-act', href: '#/knowledge', text: '← 위키' })],
  });
  if (!entries.length) {
    sec.body.append(wkEmpty('휴지통이 비어 있습니다.'));
  } else {
    for (const e of entries) {
      const restoreBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '복원' });
      restoreBtn.onclick = async () => {
        (restoreBtn as any).disabled = true;
        try {
          await api('/api/ui/deleted/restore', { method: 'POST', body: JSON.stringify({ entity: e.entity, key: e.key }) });
          if (e.entity === 'knowledge') knInvalidateTreeCaches();   // 복원 문서가 목록/트리에 바로 보이게
          toast('복원했습니다');
          renderWikiTrash(view);
        } catch (err) {
          (restoreBtn as any).disabled = false;
          toast('복원 실패 — ' + err.message, true);
        }
      };
      const who = (e.actor ? e.actor : '') + (e.actor_kind ? ' (' + (e.actor_kind === 'ai' ? 'AI' : '사람') + ')' : '');
      sec.body.append(el('div', { class: 'wk-trash-row' },
        el('span', { class: 'wk-trash-kind', text: TRASH_ENTITY_LABEL[e.entity] || e.entity }),
        el('span', { class: 'wk-trash-title', text: e.label || e.key }),
        el('span', { class: 'wk-row-meta' },
          who ? el('span', { class: 'wk-row-m', text: who }) : null,
          el('span', { class: 'wk-row-m', text: '삭제 ' + relTime(e.at) })),
        restoreBtn));
    }
  }
  view.replaceChildren(el('div', { class: 'wk-plainpad wk-trash' }, sec.el));
}

// ════════════════════════════════════════════
// 자료 #/knowledge/sources — 정제 전 원본(회의록·이메일·슬랙). 지식의 보조 입력층.
// ════════════════════════════════════════════
async function renderSources(view) {
  const kindSel = selectFilter([['', '전체 종류'], ...Object.entries(SOURCE_KIND_LABEL)], '');
  kindSel.setAttribute('aria-label', '종류');
  const provSel = selectFilter([['', '전체 출처'], ['authored', '캡처'], ['observed', '외부 미러']], '');
  provSel.setAttribute('aria-label', '출처');
  const qIn = el('input', { type: 'search', class: 'wk-src-q', placeholder: '제목·본문 검색', 'aria-label': '검색' });
  const listBox = el('div', { class: 'wk-sec-body' });
  const sec = wkSection('자료', {
    hint: '아직 정리하기 전의 원본 — 여기서 다듬으면 지식이 됩니다',
    actions: [el('a', { class: 'wk-sec-act', href: '#/knowledge', text: '← 위키' })],
  });
  const moreBox = el('div', { class: 'wk-src-more' });
  sec.body.append(el('div', { class: 'wk-src-filters' }, qIn, kindSel, provSel), listBox, moreBox);
  view.replaceChildren(el('div', { class: 'wk-plainpad' }, sec.el));

  const PAGE = 100;
  let offset = 0, loading = false;

  // 행 렌더 — 채널명(container_name)·작성자(author_name)는 커넥터-불가지 구조화 메타(source.fields)에서 표시(#735).
  //  slack=채널, 다른 커넥터도 각자 container/author 를 fields 에 담으면 동일하게 노출된다.
  function rowOf(s: any) {
    const f = (s.fields || {}) as any;
    const meta = el('span', { class: 'wk-row-meta' },
      el('span', { class: 'wk-row-m', text: SOURCE_KIND_LABEL[s.kind] || s.kind }));
    if (f.container_name) meta.append(el('span', { class: 'wk-row-m wk-src-chan', text: '#' + f.container_name }));
    if (f.author_name) meta.append(el('span', { class: 'wk-row-m', text: '@' + f.author_name }));
    meta.append(el('span', { class: 'wk-row-m', text: relTime(s.occurred_at || s.updated_at) }));
    const row = el('div', { class: 'wk-row', role: 'button', tabindex: '0' },
      el('span', { class: 'wk-tick' + (s.provenance === 'observed' ? ' mirror' : '') }),
      el('span', { class: 'wk-row-title', text: s.title || ('자료 #' + s.id) }),
      meta);
    const open = () => openSourceDetail(s.id);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (ev: any) => { if (ev.key === 'Enter') open(); });
    return row;
  }

  // 페이지네이션 — 서버 기본 100건 cap + has_more 를 [더 보기]로 이어붙인다(#735: 예전엔 limit/offset 미전송으로
  //  100건에서 잘려 나머지가 안 보였다). 필터 변경/검색은 reset(offset=0), 더보기는 append.
  async function loadPage(reset: boolean) {
    if (loading) return;
    loading = true;
    if (reset) { offset = 0; listBox.replaceChildren(skeletonRows(4)); moreBox.replaceChildren(); }
    try {
      const p = new URLSearchParams();
      if ((kindSel as any).value) p.set('kind', (kindSel as any).value);
      if ((provSel as any).value) p.set('provenance', (provSel as any).value);
      if ((qIn as any).value.trim()) p.set('q', (qIn as any).value.trim());
      p.set('limit', String(PAGE));
      p.set('offset', String(offset));
      const r = await api('/api/ui/sources?' + p.toString());
      const entries = (r && r.entries) || [];
      if (reset) listBox.replaceChildren();
      if (offset === 0 && !entries.length) {
        listBox.replaceChildren(wkEmpty('자료가 없습니다. 커넥터(이메일·슬랙)나 회의록이 여기로 들어옵니다.'));
        moreBox.replaceChildren();
        return;
      }
      for (const s of entries) listBox.append(rowOf(s));
      offset += entries.length;
      const total = (r && typeof r.total === 'number') ? r.total : offset;
      if (r && r.has_more) {
        const btn = el('button', { class: 'wk-more-btn', text: `더 보기 (${offset}/${total})` });
        btn.addEventListener('click', () => loadPage(false));
        moreBox.replaceChildren(btn);
      } else {
        moreBox.replaceChildren(el('div', { class: 'wk-src-count', text: `전체 ${offset}건` }));
      }
    } catch (e) {
      if (reset) listBox.replaceChildren(errorNote(e, '자료를 불러오지 못했습니다'));
    } finally {
      loading = false;
    }
  }
  let t: any = null;
  qIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => loadPage(true), 250); });
  kindSel.addEventListener('change', () => loadPage(true));
  provSel.addEventListener('change', () => loadPage(true));
  loadPage(true);
}

export { renderWiki, renderWikiTrash };
