// wiki-doc.ts — #764 WIKI 문서 표면 전면 재구축. "위키에는 페이지와, 페이지를 찾는 팝업(⌘K)뿐이다."
//  · 문서 캔버스(buildWikiDoc): 폴리오(mono 한 줄 브레드크럼 — 슬러그 비노출) → 아이콘/커버 → 제목 →
//    속성 한 줄(기본값 생략 — 속성 폼/블록 벽 폐지, 클릭=팝오버) → 본문(읽기=편집 in-place, 16px/720px) →
//    '문서의 끝' 헤어라인 → 부속(연결·프로젝트·유사·하위 — 뷰포트 진입 시 지연 로드) → 댓글.
//  · 시그니처 = 민트 틱: 사람 저작만 표식(AI 무표식·미러 회색 링) — 칩 더미의 구조적 대체.
//  · 피크: 기존 &peek= URL 계약 그대로(뒤로가기=닫힘·딥링크 복원) + ↑↓ 목록 순회 + 좁은 화면은 페이지 이동.
//  · 드래프트(#/knowledge/new): 만들기 버튼 없음 — 제목+분류가 서면 2초 유휴 자동 생성 → #/k 로 replaceState 승격.
//  순환 import 금지: core/learn/admin/block-editor/page-decor/wiki-data/wiki-side/wiki-history 만. (wiki.ts → wiki-doc.ts 단방향)
import { absTime, api, el, errorNote, relTime, renderMarkdown, safeHref, toast } from './core.js';
import { skeleton } from './learn.js';
import { createBlockEditor } from './block-editor.js';
import { confirmDialog } from './ui-primitives.js';
import { applyCoverBg, openCoverPicker, openEmojiPicker } from './page-decor.js';
import {
  HOME_EMPTY, KN_TYPE_LABEL, buildKnPropsBlock, fetchKnHiddenProps, hasMemoryScope, isCategoryHomeDoc,
  knChildrenPanel, knCommentsSection, knDelete, knFolderChildrenBlock, knInvalidateTreeCaches, knLinksPanel,
  knNotionPropsPanel, knPageIcon, knProjectLinks, knSimilarItem, openKnMetaPicker, openKnowledgeMoveTo,
  wkOnLeave,
  wkTrackEditor,
} from './wiki-data.js';
import { KN_INDEXED, createWikiSide, knApplySideW, knSideResizeHandle, wireSideCollapse } from './wiki-side.js';
import { wkMarkRead, wkRecordVisit, wkStamp, wkTick } from './wiki-ui.js';
import { openKnHistory } from './wiki-history.js';   // #1546 변경 이력 패널(속성 줄의 '갱신 …'에서 연다)

// 시딩 지식 편집 경고(#846) — 저장 응답에 seed_warning 이 오면(서버가 canonical 게이트웨이에서만 실어
//  준다) 띄운다. 자동저장이 짧은 간격으로 반복 커밋하므로 name 당 한 번만(같은 문서 재편집은 60s 쿨다운)
//  띄워 토스트 폭주를 막는다. 문구는 서버가 준 그대로(각색 파일 경로·절차 포함) — 9s 노출.
const _wkSeedWarnedAt = new Map<string, number>();
function wkSeedWarn(r: any) {
  const w = r && r.seed_warning;
  if (!w) return;
  const key = (r.knowledge && r.knowledge.name) || w;   // stage 응답은 knowledge:null — 문구를 키로
  const now = Date.now();
  if (now - (_wkSeedWarnedAt.get(key) || 0) < 60000) return;
  _wkSeedWarnedAt.set(key, now);
  toast(w, false, 9000);
}

// ════════════════════════════════════════════
// 문서 캔버스 — buildWikiDoc(container, name, opts { mode: 'page'|'peek', onDeleted?, originHash? })
// ════════════════════════════════════════════
async function buildWikiDoc(container: HTMLElement, name: string, opts: any = {}) {
  const mode = opts.mode || 'page';
  container.classList.add('wk-doc', 'wk-doc-' + mode);
  container.replaceChildren(skeleton('문서를 불러오는 중'));
  let k: any; let hidden: string[] = [];
  let pendingRev: any = null;   // #783 이 문서에 검토 대기 중인 수정(있으면) — 응답의 형제 필드라 knowledge 만 꺼내면 유실된다.
  try {
    let resp: any;
    [resp, hidden] = await Promise.all([
      api('/api/ui/knowledge/' + encodeURIComponent(name)),
      fetchKnHiddenProps(),
    ]);
    k = (resp && resp.knowledge) || resp;
    pendingRev = (resp && resp.pending_revision) || null;
  } catch (e: any) {
    if (e && e.status === 404) {
      container.replaceChildren(el('div', { class: 'wk-doc-missing' },
        el('div', { class: 'wk-doc-missing-title', text: '문서를 찾을 수 없어요' }),
        el('div', { class: 'wk-doc-missing-sub', text: '삭제됐거나 파일명이 바뀌었을 수 있습니다. 휴지통에서 복원할 수 있어요.' }),
        el('div', { class: 'wk-doc-missing-actions' },
          el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge', text: '← 위키 홈' }),
          el('a', { class: 'btn btn-ghost btn-sm', href: '#/trash', text: '🗑 휴지통' }))));
      return;
    }
    container.replaceChildren(errorNote(e, '문서를 불러오지 못했습니다'));
    return;
  }
  const reload = () => buildWikiDoc(container, name, opts);
  const canEdit = hasMemoryScope();
  const observed = k.provenance === 'observed';
  const always = k.injection === 'always';
  const canMeta = canEdit && !observed && !always;
  const canRename = canMeta;
  const editableDoc = canMeta && !k.is_folder;
  if (mode === 'page') wkRecordVisit(k);
  wkMarkRead(k.name);   // 피크·페이지 모두 '읽음' — 대문 읽기 코스 진행률의 근거

  // ── 본문(선언 먼저 — 제목 rename·메타 저장의 bodyMdNow 가 참조) ──
  const body = el('div', { class: 'wk-doc-body' });
  const bodyMdNow = () => ((body as any)._getMd ? (body as any)._getMd() : (k.body_md || ''));
  const saveChip = el('span', { class: 'wk-save-chip', 'aria-live': 'polite' });

  // ── 폴리오 — mono 한 줄 러닝헤드: [카테고리] › [조상 폴더…] › 현재. 슬러그(파일명) 비노출. ──
  const cat = (Array.isArray(k.categories) ? k.categories : []).filter((c) => c.state !== 'rejected')[0] || null;
  const crumbs = el('nav', { class: 'wk-folio-crumbs', 'aria-label': '문서 위치' });
  crumbs.append(el('a', { class: 'wk-crumb', href: '#/knowledge', text: 'WIKI' }));
  if (cat) {
    crumbs.append(el('span', { class: 'wk-crumb-sep', 'aria-hidden': 'true', text: '›' }),
      el('a', { class: 'wk-crumb', href: '#/knowledge?category=' + encodeURIComponent(cat.category_id), text: cat.name || cat.key }));
  }
  for (const a of (Array.isArray(k.ancestors) ? k.ancestors : [])) {
    crumbs.append(el('span', { class: 'wk-crumb-sep', 'aria-hidden': 'true', text: '›' }),
      el('a', { class: 'wk-crumb', href: '#/k/' + encodeURIComponent(a.name), text: a.title || a.name }));
  }
  crumbs.append(el('span', { class: 'wk-crumb-sep', 'aria-hidden': 'true', text: '›' }),
    el('span', { class: 'wk-crumb wk-crumb-cur', title: k.title || '', text: String(k.short_title || '').trim() || k.title || k.name }));

  // 폴리오 우측 액션 — 저장칩 · 핀 · ⋯ (화면당 채운 primary 0 — 문서 페이지의 주인공은 본문).
  const actions = el('div', { class: 'wk-folio-actions' }, saveChip);
  if (canEdit) {
    const pinBtn = el('button', { class: 'wk-folio-btn wk-pin' + (k.is_wiki ? ' on' : ''), type: 'button',
      title: k.is_wiki ? '인덱스에서 내립니다' : '인덱스에 핀 — 매 대화 첫머리에 제목이 항상 깔립니다',
      text: k.is_wiki ? '📌 핀됨' : '📌 핀' });
    pinBtn.onclick = async () => {
      pinBtn.disabled = true;
      try {
        await api('/api/ui/knowledge/' + encodeURIComponent(k.name) + '/wiki', { method: 'POST', body: JSON.stringify({ is_wiki: !k.is_wiki }) });
        k.is_wiki = !k.is_wiki;
        toast(k.is_wiki ? '인덱스에 핀했습니다' : '핀을 해제했습니다');
      } catch (e) { toast('실패 — ' + e.message, true); }
      pinBtn.disabled = false;
      pinBtn.classList.toggle('on', !!k.is_wiki);
      pinBtn.textContent = k.is_wiki ? '📌 핀됨' : '📌 핀';
      pinBtn.title = k.is_wiki ? '인덱스에서 내립니다' : '인덱스에 핀 — 매 대화 첫머리에 제목이 항상 깔립니다';
    };
    actions.append(pinBtn);
  }
  // 변경 이력(#1600) — 종전 진입점은 ⋯ 메뉴와 속성줄의 회색 '갱신 …' 글씨뿐이라 아무도 못 찾았다.
  //  "누가 언제 무엇을 왜 고쳤나"는 이 문서를 믿을지 판단하는 근거라, 문서 위에 상시 노출한다.
  const histBtn = el('button', { class: 'wk-folio-btn wk-hist', type: 'button',
    title: '이 문서가 언제·누가·무엇을 고쳤는지, 고치기 전과 후를 나란히 봅니다', text: '↺ 수정 기록' });
  histBtn.onclick = () => openKnHistory(k.name, { canEdit: editableDoc, currentVersion: k.version, onReverted: reload });
  actions.append(histBtn);
  const moreBtn = el('button', { class: 'wk-folio-btn wk-more', type: 'button', title: '문서 동작', 'aria-label': '문서 동작', text: '⋯' });
  actions.append(moreBtn);

  // ── ⋯ 메뉴 — 변경 이력 / 이동 / 원문(MD) / 전폭 / 삭제 ──
  let rawOpen = false;
  moreBtn.onclick = () => {
    const old: any = document.querySelector('.wk-morepop');
    if (old) { (old._close || (() => old.remove()))(); return; }   // 토글 닫기도 close 경유 — 리스너 잔존 방지
    const pop: any = el('div', { class: 'wk-morepop', role: 'menu' });
    const close = () => { pop.remove(); document.removeEventListener('mousedown', onDoc, true); };
    pop._close = close;
    const onDoc = (ev: any) => { if (!pop.contains(ev.target) && ev.target !== moreBtn) close(); };
    const item = (label, fn, danger?) => {
      const b = el('button', { class: 'wk-morepop-item' + (danger ? ' danger' : ''), type: 'button', text: label });
      b.onclick = () => { close(); fn(); };
      return b;
    };
    // #1546 변경 이력 — **문서 동작 메뉴가 정식 진입점**이다. 속성줄의 '갱신 …' 클릭은 지름길일 뿐:
    //  거긴 유형·분류 피커와 똑같이 생긴 회색 잔글씨라 "누르면 이력이 열린다"는 신호가 없다(실사용자 피드백).
    //  권한 게이트 없음 — 이력 조회는 읽기다(서버가 문서 가시성으로 판정하고, 되돌리기 버튼만 편집자에게 뜬다).
    pop.append(item('↺ 변경 이력', () => openKnHistory(k.name, {
      canEdit: editableDoc, currentVersion: k.version, onReverted: reload,
    })));
    if (canMeta) pop.append(item('⇥ 폴더로 이동', () => openKnowledgeMoveTo(k, reload)));
    pop.append(item(rawOpen ? '¶ 서식 보기로' : 'MD 원문 ' + (editableDoc ? '편집' : '보기'), () => toggleRaw()));
    const fullOn = !!(k.props_ui && k.props_ui.full_width);
    pop.append(item(fullOn ? '⇤ 본문 폭 되돌리기' : '⤢ 전체 폭으로', async () => {
      const next = !fullOn;
      container.classList.toggle('full', next);
      if (canEdit) {
        try { await api('/api/ui/knowledge/' + encodeURIComponent(k.name) + '/props-ui', { method: 'POST', body: JSON.stringify({ full_width: next }) });
          k.props_ui = Object.assign({}, k.props_ui || {}, { full_width: next }); } catch (_) { /* 화면만 */ }
      }
    }));
    if (canEdit) pop.append(item('✕ 삭제', () => knDelete(k.name, opts.onDeleted), true));
    document.body.append(pop);
    const r = moreBtn.getBoundingClientRect();
    pop.style.top = (r.bottom + 6) + 'px';
    pop.style.left = Math.max(8, r.right - 200) + 'px';
    setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
  };

  // ── 아이콘 / 커버 — 노션형 hover 어포던스. 장식(props_ui)은 미러에도 허용. ──
  const coverEl = el('div', { class: 'wk-doc-cover', hidden: true });
  const iconBtn = el('button', { class: 'wk-doc-icon', type: 'button', hidden: true, title: canEdit ? '아이콘 변경' : '' });
  const decorAdd = el('div', { class: 'wk-decor-add' });
  const curIcon = () => (k.props_ui && k.props_ui.icon) || (k.is_folder ? '📁' : '');
  const curCover = () => (k.props_ui && k.props_ui.cover) || '';
  async function saveDecor(patch) {
    try {
      const r = await api('/api/ui/knowledge/' + encodeURIComponent(k.name) + '/props-ui', { method: 'POST', body: JSON.stringify(patch) });
      k.props_ui = (r && r.props_ui) || Object.assign({}, k.props_ui || {}, patch);
    } catch (e) { toast('저장 실패 — ' + e.message, true); }
    paintDecor();
  }
  function paintDecor() {
    const ic = curIcon(), cv = curCover();
    coverEl.hidden = !cv;
    if (cv) applyCoverBg(coverEl, cv);
    coverEl.replaceChildren(...[canEdit && cv ? el('div', { class: 'wk-cover-btns' },
      el('button', { class: 'wk-cover-btn', type: 'button', text: '커버 변경',
        onclick: (e: any) => openCoverPicker(e.target, { current: cv, onPick: (v) => saveDecor({ cover: v }) }) }),
      el('button', { class: 'wk-cover-btn', type: 'button', text: '제거', onclick: () => saveDecor({ cover: null }) })) : null].filter(Boolean));
    iconBtn.hidden = !ic;
    iconBtn.textContent = ic;
    iconBtn.classList.toggle('on-cover', !!cv);
    decorAdd.replaceChildren(...[
      canEdit && !ic ? el('button', { class: 'wk-decor-btn', type: 'button', text: '☺ 아이콘 추가',
        onclick: (e: any) => openEmojiPicker(e.target, { onPick: (em) => saveDecor({ icon: em }) }) }) : null,
      canEdit && !cv ? el('button', { class: 'wk-decor-btn', type: 'button', text: '🖼 커버 추가',
        onclick: (e: any) => openCoverPicker(e.target, { onPick: (v) => saveDecor({ cover: v }) }) }) : null,
    ].filter(Boolean));
    decorAdd.hidden = !decorAdd.childNodes.length;
  }
  if (canEdit) {
    iconBtn.onclick = () => openEmojiPicker(iconBtn, {
      onPick: (em) => saveDecor({ icon: em }),
      onClear: (k.props_ui && k.props_ui.icon) ? () => saveDecor({ icon: null }) : undefined,
    });
  }
  paintDecor();

  // ── 제목 — 페이지가 곧 에디터(클릭해서 바로 rename). ──
  //  #1600 화면의 제목 = 사람용 짧은 제목(short_title). 없으면 종전대로 원래 제목.
  //  원래 제목(title)은 지우지 않고 아래 wk-doc-fulltitle 로 따로 보인다 — AI 가 보는 이름이 무엇인지
  //  사람도 확인할 수 있어야 하고, '원문을 그대로 읽고 싶다'는 요구가 이 화면의 예외이기 때문이다.
  const humanTitle = () => String(k.short_title || '').trim() || String(k.title || k.name || '');
  const titleEl = el('h1', { class: 'wk-doc-title' + (canRename ? ' editable' : ''),
    ...(canRename ? { contenteditable: 'true', 'data-ph': '제목 없음', spellcheck: 'false',
      title: '사람이 보는 짧은 제목 — 클릭해서 고칩니다(40자 이하 권장)' } : {}) });
  titleEl.textContent = humanTitle();
  if (canRename) {
    titleEl.addEventListener('keydown', (e: any) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); titleEl.blur(); }
    });
    titleEl.addEventListener('paste', (e: any) => {
      e.preventDefault();
      const t = (e.clipboardData || (window as any).clipboardData).getData('text/plain').replace(/\n+/g, ' ');
      document.execCommand('insertText', false, t);
    });
    titleEl.addEventListener('blur', async () => {
      const t = (titleEl.textContent || '').trim();
      const cur = humanTitle();
      if (!t) { titleEl.textContent = cur; return; }
      if (t === cur) return;
      //  본문과 같은 약속(#1600) — 제목도 물어보고 바꾼다. 스쳐 지나가다 고쳐지는 자리가 아니어야 한다.
      const okTitle = await confirmDialog({
        title: '보이는 제목을 바꿀까요?',
        message: '“' + cur + '” → “' + t + '”',
        lines: ['사람이 보는 짧은 제목만 바뀝니다. 원래 제목과 AI 가 보는 이름은 그대로입니다.'],
        confirmText: '제목 바꾸기',
        cancelText: '되돌리기',
      });
      if (!okTitle) { titleEl.textContent = cur; return; }
      try {
        const payload: any = { name: k.name, short_title: t, body_md: bodyMdNow() };
        if (k.is_folder) payload.is_folder = true;
        const r = await api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify(payload) });
        k.short_title = t;
        knInvalidateTreeCaches();   // 사이드바 트리·목록에 옛 제목이 남지 않게
        const cur = crumbs.querySelector('.wk-crumb-cur');
        if (cur) cur.textContent = t;
        toast('제목을 저장했습니다');
        wkSeedWarn(r);   // #846 시딩 지식이면 seed 파일도 갱신하라고 안내
      } catch (e) { toast('제목 저장 실패 — ' + e.message, true); titleEl.textContent = humanTitle(); }
    });
  }

  // ── 요지(#1600) — 제목 다음에 사람이 읽는 줄. 클릭해서 그 자리에서 고친다. ──
  const ledeEl = el('div', { class: 'wk-doc-lede' + (canMeta ? ' editable' : ''),
    ...(canMeta ? { contenteditable: 'true', spellcheck: 'false', 'data-ph': '한 줄 요지 추가 — 12살이 읽어도 아는 말로',
      title: '요지 — 클릭해서 고칩니다. AI 에게는 전달되지 않는 사람용 설명입니다.' } : {}) });
  ledeEl.textContent = k.summary || '';
  if (!canMeta && !k.summary) ledeEl.hidden = true;
  if (canMeta) {
    const oneLineGuard = (node: any) => {
      node.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); node.blur(); } });
      node.addEventListener('paste', (e: any) => {
        e.preventDefault();
        const t = (e.clipboardData || (window as any).clipboardData).getData('text/plain').replace(/\n+/g, ' ');
        document.execCommand('insertText', false, t);
      });
    };
    oneLineGuard(ledeEl);
    ledeEl.addEventListener('blur', async () => {
      const t = (ledeEl.textContent || '').trim();
      if (t === (k.summary || '')) return;
      try {
        const payload: any = { name: k.name, summary: t, body_md: bodyMdNow() };
        if (k.is_folder) payload.is_folder = true;
        await api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify(payload) });
        k.summary = t;
        toast('요지를 저장했습니다');
      } catch (e: any) { toast('요지 저장 실패 — ' + e.message, true); ledeEl.textContent = k.summary || ''; }
    });
  }

  // ── 원래 제목 — 짧은 제목이 따로 있을 때만 보인다(원문 확인용, 클릭해서 고침). ──
  const fullTitleEl = el('div', { class: 'wk-doc-fulltitle' + (canRename ? ' editable' : ''),
    ...(canRename ? { contenteditable: 'true', spellcheck: 'false',
      title: '원래 제목 — AI 가 보는 이름입니다. 클릭해서 고칩니다.' } : {}) });
  fullTitleEl.textContent = k.title || '';
  if (!String(k.short_title || '').trim()) fullTitleEl.hidden = true;   // 짧은 제목이 없으면 위 제목이 곧 원래 제목이다
  if (canRename) {
    fullTitleEl.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); fullTitleEl.blur(); } });
    fullTitleEl.addEventListener('blur', async () => {
      const t = (fullTitleEl.textContent || '').trim();
      if (!t || t === (k.title || '')) { fullTitleEl.textContent = k.title || ''; return; }
      try {
        const payload: any = { name: k.name, title: t, body_md: bodyMdNow() };
        if (k.is_folder) payload.is_folder = true;
        await api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify(payload) });
        k.title = t;
        knInvalidateTreeCaches();
        toast('원래 제목을 저장했습니다');
      } catch (e: any) { toast('저장 실패 — ' + e.message, true); fullTitleEl.textContent = k.title || ''; }
    });
  }

  // ── 속성 한 줄 — "그 문서에서 값이 변하는 것만". 상세는 팝오버(전체 카탈로그 + ⚙ 노출 설정). ──
  const propline = el('div', { class: 'wk-propline' });
  const editMetaSave = async (field: string, value: string) => {
    const payload: any = { name: k.name, body_md: bodyMdNow() };
    if (k.is_folder) payload.is_folder = true;
    payload[field] = value;
    const r = await api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify(payload) });
    if (field === 'type') { k.type = value; }
    else {
      try { const d = await api('/api/ui/knowledge/' + encodeURIComponent(k.name)); k.categories = ((d && d.knowledge) || d).categories || k.categories; }
      catch (_) { /* 다음 리로드에서 정합 */ }
    }
    knInvalidateTreeCaches();   // 사이드바 트리·카테고리 목록 캐시에 stale 유형/분류가 남지 않게
    toast('저장했습니다');
    wkSeedWarn(r);   // #846 시딩 지식이면 seed 파일도 갱신하라고 안내
    paintPropline();
  };
  function proplineItem(text: string, opts2: any = {}) {
    const it = el(opts2.click ? 'button' : 'span', {
      class: 'wk-prop-it' + (opts2.cls ? ' ' + opts2.cls : '') + (opts2.click ? ' clickable' : ''),
      ...(opts2.click ? { type: 'button' } : {}), ...(opts2.title ? { title: opts2.title } : {}), text });
    if (opts2.click) (it as any).onclick = (ev: any) => opts2.click(ev.currentTarget);
    return it;
  }
  function paintPropline() {
    const parts: any[] = [wkTick(k)];
    if (k.confidence === 'human') parts.push(proplineItem('사람 저작', { cls: 'human', title: '사람이 직접 작성한 지식' }));
    const curCat2 = (Array.isArray(k.categories) ? k.categories : []).filter((c) => c.state !== 'rejected')[0];
    parts.push(proplineItem(KN_TYPE_LABEL[k.type] || k.type || '유형 없음',
      canMeta ? { title: '유형 — 클릭해서 변경', click: (a) => openKnMetaPicker(a, 'type', k, editMetaSave) } : {}));
    if (curCat2) parts.push(proplineItem(curCat2.name || curCat2.key,
      canMeta ? { title: '카테고리 — 클릭해서 변경', click: (a) => openKnMetaPicker(a, 'category', k, editMetaSave) } : {}));
    if (always) parts.push(proplineItem('⚡ 항상 주입', { cls: 'warn', title: '모든 세션 첫머리에 항상 주입되는 문서' }));
    if (k.lifecycle === 'archived') parts.push(proplineItem('📦 보관됨', { cls: 'dim' }));
    // #783 승인 전 지식 — 검색·주입에서 빠져 있다는 사실이 문서 자체에서 보여야 한다.
    if (k.lifecycle === 'pending') parts.push(proplineItem('🔎 검토 대기', { cls: 'warn', title: '승인 전까지 검색·세션주입·목록에 노출되지 않습니다' }));
    // #1546 갱신 시각 = 변경 이력 진입점. 이 문서가 '언제 바뀌었나'를 이미 말하고 있는 자리라, 누르면
    //  '무엇이 바뀌었나'로 이어지는 게 자연스럽다(별도 버튼을 속성 줄에 하나 더 늘리지 않는다).
    if (k.updated_at) {
      // #1600 절대 시각 — 목록·카드가 전부 '8월 11일 15:53' 로 말하는데 여기만 '21분 전'이면 같은 사실이
      //  화면마다 다른 언어로 보인다. 상대 시각은 title(툴팁)이 아니라 아예 안 쓴다(정확한 날짜가 본문이다).
      parts.push(proplineItem('갱신 ' + wkStamp(k.updated_at), {
        cls: 'time',
        title: absTime(k.updated_at) + (k.updated_by ? ' · ' + k.updated_by : '') + ' — 클릭해서 변경 이력 보기',
        click: () => openKnHistory(k.name, {
          canEdit: editableDoc, currentVersion: k.version,
          onReverted: reload,   // 되돌리면 본문이 바뀌었으니 문서를 다시 그린다
        }),
      }));
    }
    parts.push(proplineItem('속성 모두', { cls: 'all', title: '모든 속성 보기·노출 설정', click: (a) => openProplinePopover(a) }));
    propline.replaceChildren(...parts);
  }
  function openProplinePopover(anchor: HTMLElement) {
    const old: any = document.querySelector('.wk-propspop');
    if (old) { (old._close || (() => old.remove()))(); return; }
    const pop: any = el('div', { class: 'wk-propspop' });
    const close = () => { pop.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey); };
    pop._close = close;
    const onDoc = (ev: any) => { if (!pop.contains(ev.target) && ev.target !== anchor) close(); };
    const onKey = (ev: any) => { if (ev.key === 'Escape') close(); };
    pop.append(buildKnPropsBlock(k, hidden, {
      canEdit,
      editMeta: canMeta ? { save: editMetaSave } : null,
      onChanged: () => { close(); fetchKnHiddenProps().then((h) => { hidden = h; }); paintPropline(); },
    }));
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.top = Math.min(r.bottom + 6, window.innerHeight - 60) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 380)) + 'px';
    setTimeout(() => { document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey); }, 0);
  }
  paintPropline();

  // ── 미러/항상주입 배너 — 한 줄(속성 반복 대신 상태를 문장으로). ──
  let banner: any = null;
  if (observed) {
    const safe = k.external_url ? safeHref(k.external_url) : null;
    banner = el('div', { class: 'wk-banner mirror' },
      el('span', { class: 'wk-banner-txt', text: (k.external_system === 'notion' ? '노션' : '외부') + ' 미러 — 원본에서 편집됩니다' + (k.last_synced_at ? ' · 동기화 ' + relTime(k.last_synced_at) : '') }),
      safe ? el('a', { class: 'wk-banner-link', href: safe, target: '_blank', rel: 'noopener noreferrer', text: '원본 열기 ↗' }) : null);
  } else if (always) {
    banner = el('div', { class: 'wk-banner always' },
      el('span', { class: 'wk-banner-txt', text: '항상 주입 문서 — 본문은 관리 탭 · 세션 주입에서 편집합니다' }),
      el('a', { class: 'wk-banner-link', href: '#/system/injection-map', text: '세션 주입 열기 →' }));
  }

  // ── #783 검토 배너 — 이 문서가 '승인 전'이거나 '검토 대기 수정'을 안고 있으면 그 사실을 문서 위에서 알린다. ──
  //  게이트가 켜지면 pending 지식이 트리엔 보이는데 검색·주입엔 없다 → 이 배너가 없으면 "왜 안 나오지?"가 된다.
  let reviewBanner: any = null;
  if (k.lifecycle === 'pending') {
    const acts: any[] = [];
    if (canEdit) {
      acts.push(el('button', {
        class: 'btn btn-ghost btn-sm', text: '✓ 승인',
        onclick: async () => {
          try {
            await api('/api/ui/knowledge/' + encodeURIComponent(k.name) + '/lifecycle', { method: 'POST', body: JSON.stringify({ lifecycle: 'active' }) });
            toast('승인 — 지식으로 반영했습니다'); reload();
          } catch (e: any) { toast('실패 — ' + e.message, true); }
        },
      }));
      acts.push(el('button', {
        class: 'btn btn-ghost btn-sm', text: '✕ 반려',
        onclick: async () => {
          if (!confirm('이 지식을 반려할까요? 휴지통으로 이동하며 복원할 수 있습니다.')) return;
          try {
            await api('/api/ui/knowledge/' + encodeURIComponent(k.name) + '/delete', { method: 'POST' });
            toast('반려했습니다(휴지통)'); location.hash = '#/knowledge';
          } catch (e: any) { toast('실패 — ' + e.message, true); }
        },
      }));
    }
    acts.push(el('a', { class: 'wk-banner-link', href: '#/knowledge/review', text: '검토 대기 →' }));
    reviewBanner = el('div', { class: 'wk-banner always' },
      el('span', { class: 'wk-banner-txt', text: '검토 대기 — 승인 전까지 검색·세션주입·목록에 노출되지 않습니다' + (k.confidence === 'ai' ? ' (에이전트가 작성)' : '') }),
      ...acts);
  } else if (pendingRev) {
    reviewBanner = el('div', { class: 'wk-banner always' },
      el('span', { class: 'wk-banner-txt', text: pendingRev.mode === 'staged'
        ? '검토 대기 중인 수정 제안이 있습니다 — 아래 본문은 아직 옛 승인본입니다(승인하면 교체)'
        : '최근 수정이 사람 검토 대기 중입니다 — 본문은 반영돼 있으나 되돌려질 수 있습니다' }),
      el('a', { class: 'wk-banner-link', href: '#/knowledge/review', text: '검토 대기 →' }));
  }

  // ── 본문 — 폴더=자식 목록 / 편집 가능=블록 에디터(자동 저장) / 그 외=읽기 렌더. ──
  let editor: any = null;
  let saveTimer: any = null;
  let retryTimer: any = null;
  let retryDelay = 0;
  let firstEditAt = 0;   // 마지막 저장 이후 최초 편집 시각 — maxWait 강제 flush 기준
  let saving = false;
  let lastSaveFailed = false;
  const setChip = (t, busy?) => { saveChip.textContent = t; saveChip.classList.toggle('busy', !!busy); };
  // force: 원문 적용 등 dirty 게이트를 우회해야 하는 경로(setMarkdown 이 dirty 를 리셋하므로).
  // opts.keepalive: 언로드/이탈 시 동기 flush — 응답을 기다리지 않고 keepalive fetch 로 전송을 보장(sendBeacon 은 Authorization 불가).
  const doSave = async (force?: boolean, opts?: { keepalive?: boolean }) => {
    if (!editor || saving || (!force && !editor.isDirty())) return;
    const keepalive = !!(opts && opts.keepalive);
    saving = true;
    if (!keepalive) setChip('저장 중…', true);
    const md = editor.getMarkdown();
    try {
      const payload: any = { name: k.name, body_md: md || HOME_EMPTY };
      await api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify(payload), keepalive });
      editor.resetDirty();
      k.body_md = md;
      lastSaveFailed = false;
      retryDelay = 0; firstEditAt = 0; clearTimeout(retryTimer);
      setChip('저장됨');   // 상시 유지 — 빈 문자열로 사라져 '미저장'과 혼동되던 문제 제거
    } catch (e: any) {
      lastSaveFailed = true;
      setChip('저장 안 됨 — 재시도 중…', true);   // 소거되지 않는 상태 — 성공 시에만 사라짐
      if (!keepalive) {   // 지수 백오프 자동 재시도(첫 실패에만 토스트 1회) — online 이벤트가 별도로 재플러시
        const first = !retryDelay;
        retryDelay = Math.min(retryDelay ? retryDelay * 2 : 2000, 30000);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { if (editor && editor.el.isConnected && editor.isDirty()) doSave(true); }, retryDelay);
        if (first) toast('저장이 지연되고 있어요 — 자동 재시도 중', true);
      }
    }
    saving = false;
    if (!lastSaveFailed && editor && editor.isDirty()) queueSave();   // 저장 중 추가 편집분 재큐잉(성공 시에만)
  };
  // ── 저장 리듬(#1600) — **자동저장하지 않는다. 편집을 마칠 때 한 번 묻는다.** ──
  //  종전엔 600ms 디바운스로 타이핑이 곧 저장이었다. 그래서 지나가다 잘못 누르고 한 글자만 스쳐도
  //  버전이 오르고 변경 이력에 남았다("수정의 허들이 너무 낮다" — 사용자 지적).
  //  지금은 타이핑 중엔 화면에만 남기고, 본문 밖으로 나갈 때 실제로 바뀐 게 있으면 확인창을 띄운다.
  //  ⌘S 는 명시적 의도라 묻지 않고 바로 저장한다.
  const queueSave = () => {
    lastSaveFailed = false;
    if (!firstEditAt) firstEditAt = Date.now();
    clearTimeout(saveTimer);
    setChip('수정 중 — 아직 저장 안 됨');
  };
  //  편집을 마쳤을 때(본문 밖 클릭·다른 화면으로 이동) 묻는다. 실제 변경이 없으면 묻지 않는다.
  let confirming = false;
  async function confirmAndSave(): Promise<boolean> {
    if (!editor || !editor.isDirty() || confirming || rawOpen) return false;
    confirming = true;
    let ok = false;
    try {
      ok = await confirmDialog({
        title: '지식을 수정할까요?',
        message: '이 문서의 내용이 바뀌었습니다.',
        lines: [
          '수정하면 변경 이력에 남고, 다른 사람과 AI가 보는 내용이 바뀝니다.',
          '되돌리기를 누르면 방금 고친 것은 사라지고 원래 내용으로 돌아갑니다.',
        ],
        confirmText: '수정',
        cancelText: '되돌리기',
      });
    } finally { confirming = false; }
    if (ok) { clearTimeout(saveTimer); await doSave(true); return true; }
    //  되돌리기 — 화면을 원래 본문으로 되돌린다. 반쯤 고쳐진 상태로 두면 다음 편집이 그걸 기준으로 삼는다.
    editor.setMarkdown(k.body_md || '');
    editor.resetDirty();
    setChip('저장됨');
    return false;
  }

  if (k.is_folder) {
    body.append(await knFolderChildrenBlock(k));
  } else if (editableDoc) {
    editor = wkTrackEditor(createBlockEditor({
      initial: k.body_md || '',
      placeholder: "내용 입력 · '/' 블록 메뉴",
      onChange: queueSave,
      onSaveShortcut: () => { clearTimeout(saveTimer); doSave(true); },   // ⌘S = 명시적 의도 — 묻지 않는다
    }), () => { /* 언로드 flush 안 함(#1600) — 확인 없이 저장하지 않는 게 이 화면의 약속. 미저장분은 이탈 경고로 지킨다 */ });
    //  묻는 시점은 **이 화면을 떠날 때**다(#1685). 종전엔 focusout(본문 밖 클릭)에 걸려 있어서, 제목을 누르거나
    //  옆을 스치기만 해도 창이 떠 편집이 끊겼다. 라우터가 새 화면을 그리기 전에 wkConfirmLeave 로 이 훅을 부른다.
    //  (새로고침·탭 닫기는 wiki-data 의 beforeunload 경고가 계속 지킨다. ⌘S 는 종전대로 묻지 않고 즉시 저장.)
    wkOnLeave(editor, confirmAndSave);
    (body as any)._getMd = () => editor.getMarkdown();
    body.append(editor.el);
  } else {
    body.append(el('div', { class: 'md-rendered wk-doc-md' }, renderMarkdown(k.body_md || '')));
  }

  // MD 원문 토글(⋯ 메뉴) — 편집 가능하면 textarea(완료 시 에디터에 반영), 아니면 읽기 pre.
  //  ⚠ textarea 값은 el() attr(setAttribute)로는 안 들어간다 — 반드시 .value 프로퍼티 대입.
  let rawBox: any = null;
  function toggleRaw() {
    if (rawOpen) {
      if (editableDoc && rawBox) {
        const ta = rawBox.querySelector('textarea');
        if (ta && editor) { editor.setMarkdown(ta.value); doSave(true); }   // setMarkdown 이 dirty 리셋 → 강제 저장
      }
      if (rawBox) rawBox.remove();
      rawBox = null;
      rawOpen = false;
      body.hidden = false;
      return;
    }
    rawOpen = true;
    body.hidden = true;
    const backBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button',
      text: editableDoc ? '✓ 원문 적용하고 서식으로' : '¶ 서식 보기로' , onclick: () => toggleRaw() });
    let rawIn: any = null;
    if (editableDoc) {
      rawIn = el('textarea', { class: 'wk-rawbox-ta', spellcheck: 'false' });
      rawIn.value = editor ? editor.getMarkdown() : (k.body_md || '');
    }
    rawBox = el('div', { class: 'wk-rawbox' },
      el('div', { class: 'wk-rawbox-bar' }, el('span', { class: 'wk-rawbox-label', text: 'MD 원문' }), backBtn),
      editableDoc ? rawIn : el('pre', { class: 'wk-rawbox-pre', text: k.body_md || '' }));
    body.after(rawBox);
  }

  // ── 부속(문서의 끝 아래) — 하위·노션 속성·연결·프로젝트·유사. 뷰포트 진입 시 지연 로드. ──
  const tail = el('div', { class: 'wk-doc-tail' });
  const commentsSlot = el('div', { class: 'wk-doc-comments' });
  let tailBuilt = false;
  function buildTail() {
    if (tailBuilt) return;
    tailBuilt = true;
    const relatedBox = el('div', { class: 'wk-related', hidden: true });
    tail.append(...[
      el('div', { class: 'wk-doc-end', 'aria-hidden': 'true' }),
      k.is_folder ? null : knChildrenPanel(k),
      knNotionPropsPanel(k),
      knLinksPanel(k, reload),
      knProjectLinks(k.name),
      relatedBox,
    ].filter(Boolean));
    commentsSlot.append(knCommentsSection(k.name));
    (async () => {
      try {
        const r = await api('/api/ui/knowledge/similar?' + new URLSearchParams({ name: k.name, limit: '6', min_score: '0.45' }));
        const rel = (r && r.entries) || [];
        if (!rel.length) return;
        relatedBox.replaceChildren(
          el('div', { class: 'sec-label sec-label-row' },
            el('span', { text: '비슷한 지식' }),
            el('span', { class: 'kn-sim-hint', title: '벡터 임베딩 코사인 유사도로 자동 추천 — 직접 맺은 ‘연결된 지식’과는 다릅니다', text: '자동 · 의미 유사도' })),
          el('div', { class: 'kn-linkrows' }, ...rel.map(knSimilarItem)));
        relatedBox.hidden = false;
      } catch (_) { /* 임베딩 off 등 → 숨김 유지 */ }
    })();
  }
  if (typeof IntersectionObserver !== 'undefined') {
    const io = new IntersectionObserver((ents) => {
      if (ents.some((x) => x.isIntersecting)) { io.disconnect(); buildTail(); }
    }, { rootMargin: '600px' });
    setTimeout(() => { if (!tailBuilt) io.observe(tail); }, 0);
  } else {
    buildTail();
  }

  container.classList.toggle('full', !!(k.props_ui && k.props_ui.full_width));
  // replaceChildren/append 는 el() 과 달리 null 을 'null' 텍스트로 찍는다 — 반드시 필터.
  container.replaceChildren(...[
    coverEl,
    el('div', { class: 'wk-folio' }, crumbs, actions),
    el('div', { class: 'wk-doc-head' }, iconBtn, decorAdd, titleEl),
    ledeEl,        // #1600 요지 — 제목 바로 아래(사람이 가장 먼저 읽을 줄)
    fullTitleEl,   // 원래 제목 — 짧은 제목이 따로 있을 때만. 원문 확인용
    propline,
    banner,
    reviewBanner,   // #783 검토 대기(pending) · 대기 중인 수정 제안
    body,
    tail,
    commentsSlot,
  ].filter(Boolean));
}

// ════════════════════════════════════════════
// 피크 — 목록 행 클릭 시 우측 슬라이드 오버. &peek= URL 계약(#592) 그대로: pushState·뒤로가기=닫힘·딥링크 복원.
//  + #764: ↑↓ 목록 순회(마지막 목록 컨텍스트), 닫힘 시 출발 행 하이라이트, 좁은 화면(≤1100px)은 페이지 이동.
// ════════════════════════════════════════════
let wkPeekCur: any = null;        // { back, name, pushed, baseHash, onPop, onKey, onRefresh }
let wkPeekNavGuard = false;
let wkPeekListCtx: string[] | null = null;   // 마지막 목록의 문서 name 순서 — ↑↓ 순회용
let wkPeekOriginEl: HTMLElement | null = null;

function setWikiPeekList(names: string[] | null) { wkPeekListCtx = names && names.length ? names.slice() : null; }

function consumeWikiPeekGuard() { const v = wkPeekNavGuard; wkPeekNavGuard = false; return v; }

function wkHashWithPeek(name: string | null) {
  const h = location.hash.replace(/^#\/?/, '');
  const qIdx = h.indexOf('?');
  const path = qIdx >= 0 ? h.slice(0, qIdx) : h;
  const p = new URLSearchParams(qIdx >= 0 ? h.slice(qIdx + 1) : '');
  if (name) p.set('peek', name); else p.delete('peek');
  const qs = p.toString();
  return '#/' + path + (qs ? '?' + qs : '');
}

// 피크 열린 채 목록 필터가 바뀌면(syncHash replaceState) 기준 해시를 재앵커 — '뒤로가기=닫힘' 판정 정확화.
function reanchorWikiPeek() { if (wkPeekCur) wkPeekCur.baseHash = wkHashWithPeek(null); }

function dismissWikiPeek() {
  const cur = wkPeekCur;
  if (!cur) return;
  wkPeekCur = null;
  window.removeEventListener('popstate', cur.onPop);
  document.removeEventListener('keydown', cur.onKey, true);
  cur.back.classList.remove('open');
  setTimeout(() => cur.back.remove(), 220);
  // 출발 행 복귀 하이라이트 — "어디서 열었더라"의 시각 앵커.
  if (wkPeekOriginEl && wkPeekOriginEl.isConnected) {
    const o = wkPeekOriginEl;
    o.classList.add('wk-row-flash');
    setTimeout(() => o.classList.remove('wk-row-flash'), 900);
  }
  wkPeekOriginEl = null;
  if (cur.onClose) { try { cur.onClose(); } catch (_) { /* 갱신 실패는 무해 — 다음 repaint 가 바로잡음 */ } }
}

function openWikiPeek(name: string, opts?: any) {
  const fromUrl = !!(opts && opts.fromUrl);
  const onRefresh = opts && opts.onRefresh;
  const onClose = opts && opts.onClose;   // 닫힘(교체·순회·닫기) 시 1회 — 호출부의 제자리 읽음 갱신 등
  // 좁은 화면 — 피크 대신 페이지로(호버·오버레이가 비좁음). URL 복원(fromUrl) 진입은 반드시 replace —
  //  push 하면 뒤로가기가 &peek= 해시로 돌아와 다시 강등되는 무한 전방 트랩이 생긴다.
  if (matchMedia('(max-width: 1100px)').matches) {
    dismissWikiPeek();
    if (fromUrl) location.replace(location.href.split('#')[0] + '#/k/' + encodeURIComponent(name));
    else location.hash = '#/k/' + encodeURIComponent(name);
    return;
  }
  const prevPushed = wkPeekCur && opts && opts._traverse ? wkPeekCur.pushed : false;
  if (opts && opts.originEl) wkPeekOriginEl = opts.originEl;
  dismissWikiPeek();   // 패널은 항상 1개 — 열려 있으면 교체
  if (opts && opts.originEl) wkPeekOriginEl = opts.originEl;   // dismiss 가 초기화한 것 복원
  const baseHash = wkHashWithPeek(null);

  const body = el('div', { class: 'wk-peek-scroll' });
  const fullBtn = el('button', { class: 'wk-peek-btn', type: 'button', title: '이 문서를 전체 페이지로 엽니다', text: '⤢ 전체화면' });
  const tabBtn = el('button', { class: 'wk-peek-btn', type: 'button', title: '이 문서를 새 탭에서 엽니다', text: '↗ 새 탭' });
  const xBtn = el('button', { class: 'wk-peek-btn wk-peek-x', type: 'button', 'aria-label': '닫기', title: '닫기 (Esc)', text: '✕' });
  const navHint = wkPeekListCtx && wkPeekListCtx.includes(name)
    ? el('span', { class: 'wk-peek-navhint', title: '목록의 이전/다음 문서로', text: '↑↓ 이동' }) : null;
  const panel = el('aside', { class: 'wk-peek', role: 'dialog', 'aria-label': '문서 미리보기' },
    el('div', { class: 'wk-peek-head' }, navHint, fullBtn, tabBtn, xBtn), body);
  const back = el('div', { class: 'wk-peek-backdrop' }, panel);

  const requestClose = () => {
    const cur = wkPeekCur;
    if (!cur || cur.back !== back) return;
    if (cur.pushed) { history.back(); return; }
    history.replaceState(null, '', wkHashWithPeek(null));
    dismissWikiPeek();
  };
  const onPop = () => {
    const cur = wkPeekCur;
    if (!cur || cur.back !== back) return;
    if (wkHashWithPeek(null) !== cur.baseHash) { dismissWikiPeek(); return; }   // 필터/경로까지 변함 — route 가 재렌더
    const h = location.hash.replace(/^#\/?/, '');
    const qIdx = h.indexOf('?');
    const nowPeek = new URLSearchParams(qIdx >= 0 ? h.slice(qIdx + 1) : '').get('peek');
    if (!nowPeek) { wkPeekNavGuard = true; dismissWikiPeek(); return; }          // 뒤로가기 = 닫힘
    if (nowPeek !== cur.name) {                                                  // 다른 피크로 이동 — 내용 교체
      wkPeekNavGuard = true;
      openWikiPeek(nowPeek, { fromUrl: true, onRefresh: cur.onRefresh, onClose: cur.onClose });
    }
  };
  const traverse = (dir: number) => {
    if (!wkPeekListCtx) return false;
    const at = wkPeekListCtx.indexOf(name);
    if (at < 0) return false;
    const next = wkPeekListCtx[at + dir];
    if (!next) return true;   // 끝 — 소비만
    history.replaceState(null, '', wkHashWithPeek(next));
    openWikiPeek(next, { onRefresh, onClose, _traverse: true });
    return true;
  };
  const onKey = (ev: any) => {
    if (ev.key === 'Escape') {
      if (document.querySelector('.qk-back')) return;   // ⌘K 팔레트가 위에 떠 있으면 그쪽이 먼저 닫힌다
      requestClose(); return;
    }
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    const t = ev.target as HTMLElement;
    // 편집 중엔 순회 금지 — target 이 요소가 아닐 수도 있다(document 디스패치 등).
    if (t && typeof t.closest === 'function' && (t.closest('.be') || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (traverse(ev.key === 'ArrowDown' ? 1 : -1)) { ev.preventDefault(); ev.stopPropagation(); }
  };
  back.addEventListener('mousedown', (ev) => { if (ev.target === back) requestClose(); });
  xBtn.onclick = requestClose;
  fullBtn.onclick = () => {
    dismissWikiPeek();   // 히스토리는 그대로(피크 URL 유지) — #/k 에서 뒤로가면 피크 상태로 복원
    location.hash = '#/k/' + encodeURIComponent(name);
  };
  tabBtn.onclick = () => { window.open(location.href.split('#')[0] + '#/k/' + encodeURIComponent(name)); };

  document.body.append(back);
  requestAnimationFrame(() => back.classList.add('open'));
  wkPeekCur = { back, name, pushed: prevPushed, baseHash, onPop, onKey, onRefresh, onClose };
  if (!fromUrl && !(opts && opts._traverse)) { history.pushState(null, '', wkHashWithPeek(name)); wkPeekCur.pushed = true; }
  window.addEventListener('popstate', onPop);
  document.addEventListener('keydown', onKey, true);

  buildWikiDoc(body, name, { mode: 'peek', onDeleted: () => { requestClose(); if (onRefresh) onRefresh(); } });
}

// ════════════════════════════════════════════
// ⌘K 빠른 검색 — 의미검색(semantic, grep 폴백) 12건 + ↑↓ / Enter(피크) / ⌘Enter(페이지).
//  마지막 줄 상시 명령: "«q» 제목으로 새 페이지".
// ════════════════════════════════════════════
let wkQkOpen = false;
function openWikiSearch() {
  if (wkQkOpen) return;
  wkQkOpen = true;
  let entries: any[] = [];
  let sel = 0;
  let closed = false;
  let qkSeq = 0;   // 의미검색 응답 순서 역전 가드 — 늦게 온 이전 검색어 결과 폐기
  const input = el('input', { class: 'qk-input', type: 'search',
    placeholder: '검색어 입력 — 자연어 의미검색', 'aria-label': '빠른 검색' }) as HTMLInputElement;
  const list = el('div', { class: 'qk-results' },
    el('div', { class: 'qk-hint', text: '전체 지식에서 의미로 찾습니다. ↑↓ 이동 · Enter 미리보기 · ⌘Enter 페이지로' }));
  const newRow = el('button', { class: 'qk-newrow', type: 'button', hidden: true });
  const panel = el('div', { class: 'qk-panel', role: 'dialog', 'aria-label': '빠른 검색' },
    el('div', { class: 'qk-inrow' }, el('span', { class: 'qk-glass', 'aria-hidden': 'true', text: '🔍' }), input,
      el('span', { class: 'qk-esc', text: 'esc' })),
    list, newRow);
  const back = el('div', { class: 'qk-back' }, panel);
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    wkQkOpen = false;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', close);
  };
  window.addEventListener('hashchange', close);   // 라우트 이동(뒤로가기 포함) 시 팔레트가 다른 화면 위에 남지 않게
  newRow.onclick = () => {
    const q = input.value.trim();
    close();
    location.hash = '#/knowledge/new' + (q ? '?title=' + encodeURIComponent(q) : '');
  };
  const openEntry = (e, fullPage) => {
    if (!e) return;
    close();
    if (fullPage) { location.hash = '#/k/' + encodeURIComponent(e.name); return; }
    const page = location.hash.replace(/^#\//, '').split(/[/?]/)[0] || '';
    if (page === 'k') location.hash = '#/k/' + encodeURIComponent(e.name);
    else openWikiPeek(e.name);
  };
  function paint() {
    const q = input.value.trim();
    newRow.hidden = !q || !hasMemoryScope();
    if (q) newRow.replaceChildren(el('span', { class: 'qk-newrow-plus', 'aria-hidden': 'true', text: '＋' }),
      el('span', { text: '"' + q + '" 제목으로 새 페이지' }));
    if (!entries.length) {
      list.replaceChildren(el('div', { class: 'qk-hint',
        text: q ? '결과가 없습니다 — 다른 말로 시도해 보세요.' : '전체 지식에서 의미로 찾습니다. ↑↓ 이동 · Enter 미리보기 · ⌘Enter 페이지로' }));
      return;
    }
    list.replaceChildren(...entries.map((e, i) => {
      const snip = String(e.snippet || '').replace(/L\d+:\s*/g, '').replace(/[\n⋯]+/g, ' · ').replace(/\s+/g, ' ').trim().slice(0, 120);
      const row = el('button', { class: 'qk-row' + (i === sel ? ' on' : ''), type: 'button' },
        wkTick(e),
        el('span', { class: 'qk-row-ic', text: knPageIcon(e) }),
        el('div', { class: 'qk-row-main' },
          el('div', { class: 'qk-row-title', title: e.title || '', text: (e.short_title || '').trim() || e.title || e.name }),
          snip ? el('div', { class: 'qk-row-snip', text: snip }) : null));
      row.addEventListener('mousedown', (ev) => ev.preventDefault());
      row.onclick = (ev: any) => openEntry(e, ev.metaKey || ev.ctrlKey);
      return row;
    }));
    const on = list.querySelector('.qk-row.on');
    if (on) (on as any).scrollIntoView({ block: 'nearest' });
  }
  let t: any = null;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = input.value.trim();
      const seq = ++qkSeq;
      if (!q) { entries = []; sel = 0; paint(); return; }
      try {
        const r = await api('/api/ui/knowledge/semantic?' + new URLSearchParams({ q, limit: '12', injection: 'recalled' }));
        if (seq !== qkSeq || closed) return;   // 그 사이 검색어가 바뀜/닫힘 — 이 결과는 폐기
        entries = ((r && r.entries) || []).filter((e) => !isCategoryHomeDoc(e.name));
        sel = 0;
        paint();
      } catch (_) { /* 검색 실패 — 이전 결과 유지 */ }
    }, 240);
  });
  const onKey = (e: any) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (entries.length) { sel = (sel + (e.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length; paint(); }
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); openEntry(entries[sel], e.metaKey || e.ctrlKey); }
  };
  back.addEventListener('mousedown', (ev) => { if (ev.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  requestAnimationFrame(() => back.classList.add('open'));
  input.focus();
}
document.addEventListener('keydown', (e: any) => {
  if (!(e.metaKey || e.ctrlKey) || (e.key !== 'k' && e.key !== 'K')) return;
  const page = location.hash.replace(/^#\//, '').split(/[/?]/)[0] || '';
  if (!['knowledge', 'k', 'trash'].includes(page)) return;
  e.preventDefault();
  openWikiSearch();
});

// ════════════════════════════════════════════
// 문서 페이지 #/k/<name> — 접이식 사이드바 + 캔버스.
// ════════════════════════════════════════════
async function renderWikiDocPage(view, name) {
  const sideCtl = createWikiSide({
    selected: () => '',
    onSelect: (v) => {
      location.hash = v === KN_INDEXED ? '#/knowledge?indexed=1' : (v ? '#/knowledge?category=' + encodeURIComponent(v) : '#/knowledge');
    },
    uncategorized: true,
    collapsible: true,
  });
  const canvas = el('article', { class: 'wk-doc' });
  const shell = el('div', { class: 'kn-shell' }, sideCtl.side, sideCtl.reopenBtn, canvas);
  knApplySideW(shell); shell.append(knSideResizeHandle(shell));
  wireSideCollapse(shell, sideCtl);
  view.replaceChildren(shell);
  buildWikiDoc(canvas, name, { mode: 'page' });
}

// ════════════════════════════════════════════
// 드래프트 #/knowledge/new — 만들기 버튼 없음. 제목+분류가 서면 2초 유휴에 자동 생성 → #/k 로 승격(replaceState).
//  params: category(key 프리필) · folder(parent_name) · project+relation(생성 후 연결) · title(⌘K 명령 프리필).
// ════════════════════════════════════════════
async function renderWikiDraft(view, params) {
  if (!hasMemoryScope()) { location.hash = '#/knowledge'; return; }
  const preCatKey = (params && params.get && params.get('category')) || '';
  const preFolder = (params && params.get && params.get('folder')) || '';
  const preTitle = (params && params.get && params.get('title')) || '';
  const preProject = (params && params.get && params.get('project')) || '';
  const preRelation = (params && params.get && params.get('relation')) || 'produced';

  const sideCtl = createWikiSide({
    selected: () => '',
    onSelect: (v) => {
      location.hash = v === KN_INDEXED ? '#/knowledge?indexed=1' : (v ? '#/knowledge?category=' + encodeURIComponent(v) : '#/knowledge');
    },
    uncategorized: true,
    collapsible: true,
  });
  const canvas = el('article', { class: 'wk-doc wk-doc-page wk-doc-draft' });
  const shell = el('div', { class: 'kn-shell' }, sideCtl.side, sideCtl.reopenBtn, canvas);
  knApplySideW(shell); shell.append(knSideResizeHandle(shell));
  wireSideCollapse(shell, sideCtl);
  view.replaceChildren(shell);

  // ── 드래프트 상태 ──
  let created: any = null;              // 생성된 knowledge(서버 응답) — 이후부터는 일반 upsert
  let catKey = preCatKey;
  let catName = '';
  let typeVal = '';                     // 미선택 = 생성 시 '참조' 기본(속성 라인에 명시, 언제든 변경)
  const decor: any = { icon: null, cover: null };   // 생성 전 스테이징 — 생성 직후 props-ui 로 반영
  let saving = false;
  let timer: any = null;

  // 초안 로컬 백업(#764 유실 봉쇄) — 제목·분류가 서기 전 본문은 서버에 저장되지 않으므로 localStorage 에 미러링.
  //  생성 성공 시 정리. 진입 시 최근(7일 내) 초안이 있으면 복구. keepaliveSaveCreated 는 생성 후 언로드 flush.
  const draftKey = 'wkdraft:' + preCatKey + ':' + preFolder + ':' + preProject;
  function readDraft(): any { try { const s = localStorage.getItem(draftKey); return s ? JSON.parse(s) : null; } catch (_) { return null; } }
  function clearDraft() { try { localStorage.removeItem(draftKey); } catch (_) { /* 무시 */ } }
  function mirrorDraft() {
    if (created) return;   // 생성됨 = 서버가 진실, 로컬 미러 불필요
    const title = (titleEl.textContent || '').trim();
    const body_md = editor ? editor.getMarkdown() : '';
    if (!title && !body_md.trim()) { clearDraft(); return; }
    try { localStorage.setItem(draftKey, JSON.stringify({ title, body_md, catKey, typeVal, ts: Date.now() })); } catch (_) { /* 용량 초과 등 무시 */ }
  }
  function keepaliveSaveCreated() {
    if (!created) return;
    const title = (titleEl.textContent || '').trim();
    const payload: any = { name: created.name, title: title || created.title, body_md: editor.getMarkdown().trim() || HOME_EMPTY };
    if (typeVal) payload.type = typeVal;
    if (catKey) payload.category = catKey;
    try { api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify(payload), keepalive: true }); } catch (_) { /* 무시 */ }
  }

  const saveChip = el('span', { class: 'wk-save-chip', 'aria-live': 'polite' });
  const setChip = (t, busy?) => { saveChip.textContent = t; saveChip.classList.toggle('busy', !!busy); };

  // 폴리오 — '새 페이지'(생성되면 브레드크럼으로 교체) + 저장칩.
  const crumbs = el('nav', { class: 'wk-folio-crumbs' },
    el('a', { class: 'wk-crumb', href: '#/knowledge', text: 'WIKI' }),
    el('span', { class: 'wk-crumb-sep', 'aria-hidden': 'true', text: '›' }),
    el('span', { class: 'wk-crumb wk-crumb-cur', text: '새 페이지' }));

  // 제목.
  const titleEl = el('h1', { class: 'wk-doc-title editable', contenteditable: 'true', 'data-ph': '제목 없음', spellcheck: 'false' });
  if (preTitle) titleEl.textContent = preTitle;
  titleEl.addEventListener('keydown', (e: any) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); editor.focusEnd(); }
  });
  titleEl.addEventListener('paste', (e: any) => {
    e.preventDefault();
    const t = (e.clipboardData || (window as any).clipboardData).getData('text/plain').replace(/\n+/g, ' ');
    document.execCommand('insertText', false, t);
  });
  titleEl.addEventListener('input', () => queue());

  // 아이콘/커버 스테이징.
  const iconBtn = el('button', { class: 'wk-doc-icon', type: 'button', hidden: true, title: '아이콘 변경' });
  const decorAdd = el('div', { class: 'wk-decor-add' });
  const coverEl = el('div', { class: 'wk-doc-cover', hidden: true });
  function paintDecor() {
    coverEl.hidden = !decor.cover;
    if (decor.cover) applyCoverBg(coverEl, decor.cover);
    coverEl.replaceChildren(...[decor.cover ? el('div', { class: 'wk-cover-btns' },
      el('button', { class: 'wk-cover-btn', type: 'button', text: '커버 변경',
        onclick: (e: any) => openCoverPicker(e.target, { current: decor.cover, onPick: (v) => { decor.cover = v; paintDecor(); syncDecor(); } }) }),
      el('button', { class: 'wk-cover-btn', type: 'button', text: '제거', onclick: () => { decor.cover = null; paintDecor(); syncDecor(); } })) : null].filter(Boolean));
    iconBtn.hidden = !decor.icon;
    iconBtn.textContent = decor.icon || '';
    iconBtn.classList.toggle('on-cover', !!decor.cover);
    decorAdd.replaceChildren(...[
      !decor.icon ? el('button', { class: 'wk-decor-btn', type: 'button', text: '☺ 아이콘 추가',
        onclick: (e: any) => openEmojiPicker(e.target, { onPick: (em) => { decor.icon = em; paintDecor(); syncDecor(); } }) }) : null,
      !decor.cover ? el('button', { class: 'wk-decor-btn', type: 'button', text: '🖼 커버 추가',
        onclick: (e: any) => openCoverPicker(e.target, { onPick: (v) => { decor.cover = v; paintDecor(); syncDecor(); } }) }) : null,
    ].filter(Boolean));
    decorAdd.hidden = false;
  }
  iconBtn.onclick = () => openEmojiPicker(iconBtn, { onPick: (em) => { decor.icon = em; paintDecor(); syncDecor(); },
    onClear: decor.icon ? () => { decor.icon = null; paintDecor(); syncDecor(); } : undefined });
  async function syncDecor() {
    if (!created) return;
    try { await api('/api/ui/knowledge/' + encodeURIComponent(created.name) + '/props-ui', { method: 'POST', body: JSON.stringify(decor) }); }
    catch (_) { /* 장식 저장 실패는 비치명 */ }
  }
  paintDecor();

  // 속성 라인 — 분류·유형 인라인 피커(만들기 폼의 잔재를 한 줄로 흡수).
  const propline = el('div', { class: 'wk-propline wk-propline-draft' });
  function paintPropline() {
    const catBtn = el('button', { class: 'wk-prop-it clickable' + (catKey ? '' : ' need'), type: 'button',
      title: '분류 — 이 페이지가 속할 카테고리', text: catName || (catKey ? catKey : '분류 선택…') });
    catBtn.onclick = () => openKnMetaPicker(catBtn, 'category', { categories: catKey ? [{ key: catKey, state: 'confirmed' }] : [] },
      async (_f, v) => { catKey = v; catName = ''; await resolveCatName(); paintPropline(); queue(); });
    const typeBtn = el('button', { class: 'wk-prop-it clickable', type: 'button', title: '유형 — 언제든 바꿀 수 있어요',
      text: typeVal ? (KN_TYPE_LABEL[typeVal] || typeVal) : '참조 (기본)' });
    typeBtn.onclick = () => openKnMetaPicker(typeBtn, 'type', { type: typeVal || 'reference' },
      async (_f, v) => { typeVal = v; paintPropline(); queue(); });
    const hint = created
      ? el('span', { class: 'wk-prop-it time', text: '자동 저장 중' })
      : el('span', { class: 'wk-prop-it dim', text: catKey ? '제목을 쓰면 자동으로 저장됩니다' : '분류를 고르면 저장됩니다' });
    propline.replaceChildren(catBtn, typeBtn, hint);
  }
  async function resolveCatName() {
    if (!catKey) { catName = ''; return; }
    try {
      const d = await api('/api/ui/categories');
      const c = ((d && d.categories) || []).find((x) => x.key === catKey);
      catName = c ? (c.name || c.key) : catKey;
    } catch (_) { catName = catKey; }
  }

  // 본문 에디터.
  const editor = wkTrackEditor(createBlockEditor({
    initial: '',
    placeholder: "내용 입력 · '/' 블록 메뉴",
    onChange: () => queue(),
    onSaveShortcut: () => { clearTimeout(timer); commit(); },
  }), () => { if (created) keepaliveSaveCreated(); else mirrorDraft(); });   // 언로드 flush — 생성 후 keepalive, 생성 전 로컬 미러

  // ── 자동 생성/저장 — 생성 후 600ms 디바운스+4s maxWait 강제 flush. 생성 전엔 localStorage 가 이미 보호. ──
  let draftFirstEditAt = 0;
  const queue = () => {
    mirrorDraft();   // 매 변경마다 로컬 백업 갱신(제목·분류 확정 전 유실 방지)
    if (!draftFirstEditAt) draftFirstEditAt = Date.now();
    if (created) setChip('저장 중…', true);
    else setChip(editor && editor.getMarkdown().trim() ? '초안 보관 중' : '', false);   // 생성 전 — 로컬에 안전 보관 중임을 명시
    clearTimeout(timer);
    const waited = Date.now() - draftFirstEditAt;
    if (created && waited >= 4000) { commit(); return; }   // maxWait — 연속 타이핑 중 강제 저장
    timer = setTimeout(commit, created ? Math.min(600, 4000 - waited) : 1000);
  };
  async function commit() {
    const title = (titleEl.textContent || '').trim();
    if (saving) { queue(); return; }
    if (!created) {
      if (!canvas.isConnected) return;   // 생성 전에 페이지를 떠남 — 지연 타이머가 유령 문서를 만들지 않게
      if (!title || !catKey) return;     // 제목+분류가 서야 생성 — 유령 문서 0
      saving = true;
      setChip('만드는 중…', true);
      try {
        const payload: any = { title, body_md: editor.getMarkdown().trim() || HOME_EMPTY, category: catKey, type: typeVal || 'reference', provenance: 'authored' };
        if (preFolder) payload.parent_name = preFolder;
        const r = await api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify(payload) });
        created = (r && r.knowledge) || null;
        if (!created) throw new Error('생성 응답이 비었습니다');
        knInvalidateTreeCaches();
        editor.resetDirty();
        clearDraft();   // 서버 생성 완료 — 로컬 초안 정리
        draftFirstEditAt = 0;
        setChip('저장됨');   // 상시 유지
        // URL 승격 — 뒤로가기 히스토리 오염 없이 이 화면이 곧 문서 페이지가 된다.
        history.replaceState(null, '', '#/k/' + encodeURIComponent(created.name));
        crumbs.replaceChildren(
          el('a', { class: 'wk-crumb', href: '#/knowledge', text: 'WIKI' }),
          el('span', { class: 'wk-crumb-sep', 'aria-hidden': 'true', text: '›' }),
          el('a', { class: 'wk-crumb', href: '#/knowledge?category=' + encodeURIComponent(String((created.categories && created.categories[0] && created.categories[0].category_id) || '')), text: catName || catKey }),
          el('span', { class: 'wk-crumb-sep', 'aria-hidden': 'true', text: '›' }),
          el('span', { class: 'wk-crumb wk-crumb-cur', text: created.title || created.name }));
        canvas.classList.remove('wk-doc-draft');
        if (decor.icon || decor.cover) syncDecor();
        if (preProject) {
          api('/api/ui/v6/projects/' + encodeURIComponent(preProject) + '/knowledge',
            { method: 'POST', body: JSON.stringify({ name: created.name, relation: preRelation }) })
            .then(() => toast('프로젝트에 연결했습니다')).catch(() => { /* 비치명 */ });
        }
        if (r && r.similar && r.similar.length) {
          toast('비슷한 지식이 이미 있어요 — "' + (r.similar[0].title || r.similar[0].name) + '"');
        }
        wkSeedWarn(r);   // #846 시딩 지식이면 seed 파일도 갱신하라고 안내
        wkRecordVisit(created);
        paintPropline();
      } catch (e) {
        setChip('저장 안 됨', true);   // 생성 전 본문은 localStorage 초안으로 보호됨
        toast('페이지 생성 실패 — ' + e.message, true);
        saving = false;
        return;   // 실패 시 자동 재시도 금지 — 다음 입력(queue)에서만(1.2초 토스트 폭주 방지)
      }
      saving = false;
      if (created && (editor.isDirty() || (titleEl.textContent || '').trim() !== created.title)) queue();
      return;
    }
    // 생성 후 — 일반 upsert(제목+본문, 유형/분류는 피커가 개별 처리).
    saving = true;
    setChip('저장 중…', true);
    try {
      const payload: any = { name: created.name, title: title || created.title, body_md: editor.getMarkdown().trim() || HOME_EMPTY };
      if (typeVal) payload.type = typeVal;
      if (catKey) payload.category = catKey;
      const r = await api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify(payload) });
      editor.resetDirty();
      created.title = payload.title;
      draftFirstEditAt = 0;
      setChip('저장됨');   // 상시 유지
      wkSeedWarn(r);   // #846 시딩 지식이면 seed 파일도 갱신하라고 안내
    } catch (e) {
      setChip('저장 안 됨', true);
      toast('저장 실패 — ' + e.message, true);
      saving = false;
      return;   // 실패 시 자동 재시도 금지 — 다음 입력/focusout 에서만
    }
    saving = false;
    if (editor.isDirty()) queue();
  }
  editor.el.addEventListener('focusout', () => { clearTimeout(timer); commit(); });

  // 최근 초안 복구 — 제목/분류 미확정으로 서버에 못 담긴 이전 작성분을 되살린다(7일 내).
  const savedDraft = readDraft();
  if (savedDraft && (Date.now() - (savedDraft.ts || 0) < 7 * 864e5) && (savedDraft.title || (savedDraft.body_md || '').trim())) {
    if (savedDraft.title && !(titleEl.textContent || '').trim()) titleEl.textContent = savedDraft.title;
    if (savedDraft.body_md) editor.setMarkdown(savedDraft.body_md);
    if (savedDraft.catKey && !catKey) catKey = savedDraft.catKey;
    if (savedDraft.typeVal && !typeVal) typeVal = savedDraft.typeVal;
    toast('이전에 작성 중이던 초안을 불러왔어요');
    setTimeout(() => queue(), 0);   // 제목+분류가 서 있으면 곧 생성/저장
  }

  canvas.replaceChildren(
    coverEl,
    el('div', { class: 'wk-folio' }, crumbs, el('div', { class: 'wk-folio-actions' }, saveChip)),
    el('div', { class: 'wk-doc-head' }, iconBtn, decorAdd, titleEl),
    propline,
    el('div', { class: 'wk-doc-body' }, editor.el));
  await resolveCatName();
  paintPropline();
  setTimeout(() => titleEl.focus(), 0);
}

export {
  buildWikiDoc,
  consumeWikiPeekGuard,
  dismissWikiPeek,
  openWikiPeek,
  openWikiSearch,
  reanchorWikiPeek,
  renderWikiDocPage,
  renderWikiDraft,
  setWikiPeekList,
};
