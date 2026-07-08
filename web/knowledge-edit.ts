// knowledge-edit.ts — #657 지식 작성/편집 페이지(노션형). 구 renderKnowledgeForm(텍스트에어리어 폼)을
//  문서 캔버스형으로 재구성: 커버/아이콘 → 큰 제목 → 속성 행(분류·유형·파일명·출처·프로젝트) → 블록 에디터 본문.
//  · 저장 API 는 불변(POST /api/ui/knowledge — 비파괴 upsert). 본문 SoT 는 여전히 markdown.
//  · '마크다운 원문' 토글 — 파워유저/미지원 문법용 raw textarea(블록 에디터와 왕복 동기화).
//  · 아이콘/커버는 props_ui(icon/cover) — 신규는 저장 성공 후 1회 POST, 편집은 즉시 저장.
//  순환 import 금지: core/learn/admin/knowledge-doc/block-editor/page-decor 만 import(knowledge.ts 가 재수출).
import { api, el, state, toast } from './core.js';
import { hasScope } from './admin.js';
import { KN_REL_LABEL, KN_TYPE_LABEL, openProjectChooser } from './knowledge-doc.js';
import { createBlockEditor } from './block-editor.js';
import { applyCoverBg, openCoverPicker, openEmojiPicker } from './page-decor.js';

// 카테고리 셀렉터(value=key) — space 별 optgroup. 편집 시 현재 분류 프리셀렉트.
async function fillCategorySelect(sel: HTMLSelectElement, preselectKey?: string) {
  const spaces: Array<[string, string]> = [['business', '사업'], ['product', '제품'], ['system', '시스템']];
  await Promise.all(spaces.map(async ([sp, label]) => {
    try {
      const d = await api('/api/ui/categories?' + new URLSearchParams({ space: sp }));
      const cats = (d && d.categories) || [];
      if (!cats.length) return;
      const og = el('optgroup', { label });
      for (const c of cats) og.append(el('option', { value: c.key, text: c.name || c.key }));
      sel.append(og);
    } catch (_) { /* graceful */ }
  }));
  if (preselectKey) sel.value = preselectKey;
}

// 지식 작성/편집 — editName 있으면 편집. main.ts 라우터가 그대로 호출(#/knowledge/new · #/k-edit/<name>).
export async function renderKnowledgeForm(view, params?, editName?) {
  if (!hasScope('memory')) { location.hash = '#/knowledge'; return; }
  const isEdit = !!editName;
  let k: any = {};
  if (isEdit) {
    try { k = await api('/api/ui/knowledge/' + encodeURIComponent(editName)).then((r) => r && (r.knowledge || r)); }
    catch (e) { toast('지식을 불러오지 못했습니다 — ' + e.message, true); location.hash = '#/k/' + encodeURIComponent(editName); return; }
    if (!k || !k.name) { toast('지식을 찾을 수 없습니다', true); location.hash = '#/knowledge'; return; }
    // (#335 ①) 항상-주입 섹션은 관리탭 '세션 주입'이 단일 편집 홈.
    if (k.injection === 'always') { toast('항상-주입 섹션은 관리 ▸ 세션 주입에서 편집합니다'); location.hash = '#/system/injection-map'; return; }
  }

  // ── 페이지 꾸미기 상태(아이콘/커버) — 저장 시 props-ui 로 반영(신규는 생성 후 1회). ──
  const decor: any = {
    icon: (k.props_ui && k.props_ui.icon) || '',
    cover: (k.props_ui && k.props_ui.cover) || '',
  };

  // ── 속성 컨트롤 ──
  const nameIn = el('input', { class: 'ke-prop-in mono', type: 'text', value: k.name || '',
    placeholder: '비우면 제목에서 자동' }) as HTMLInputElement;
  if (isEdit) nameIn.disabled = true;
  const provSel = el('select', { class: 'ke-prop-in ke-prop-sel' },
    el('option', { value: 'authored', text: '저작 (기본)' }),
    el('option', { value: 'observed', text: '외부 미러' })) as HTMLSelectElement;
  provSel.value = k.provenance || 'authored';
  const curCatKey = (Array.isArray(k.categories) ? k.categories.filter((c) => c.state !== 'rejected') : []).map((c) => c.key).filter(Boolean)[0] || '';
  const catSel = el('select', { class: 'ke-prop-in ke-prop-sel' }, el('option', { value: '', text: '카테고리 선택…' })) as HTMLSelectElement;
  // 대문/사이드바 '＋ 새 페이지'에서 온 경우(?category=key) 프리필(#657).
  const preCat = !isEdit && params && params.get ? (params.get('category') || '') : '';
  fillCategorySelect(catSel, curCatKey || preCat);
  const typeSel = el('select', { class: 'ke-prop-in ke-prop-sel' }, el('option', { value: '', text: '유형 선택…' })) as HTMLSelectElement;
  for (const [v, label] of Object.entries(KN_TYPE_LABEL)) typeSel.append(el('option', { value: v, text: label as string }));
  if (k.type) typeSel.value = k.type;

  // 프로젝트 연결 스테이징(신규만 — 편집은 상세의 '연결된 프로젝트').
  const staged: any[] = [];
  const stagedList = el('div', { class: 'ke-projchips' });
  function paintStaged() {
    stagedList.replaceChildren(...staged.map((s, i) => {
      const x = el('button', { class: 'kn-projchip-x', type: 'button', title: '제거', text: '✕' });
      x.onclick = () => { staged.splice(i, 1); paintStaged(); };
      return el('span', { class: 'kn-chip kn-projchip' },
        el('span', { class: 'kn-projlink-rel kn-projlink-rel-' + s.relation, text: KN_REL_LABEL[s.relation] }),
        el('span', { class: 'kn-projchip-link', text: s.name }), x);
    }),
    el('button', { class: 'ke-prop-add', type: 'button', text: staged.length ? '＋' : '＋ 프로젝트 연결',
      onclick: () => openProjectChooser({
        title: '프로젝트 연결', actionLabel: '＋ 추가', doneLabel: '추가됨',
        initialPicked: staged.map((s) => s.id + ':' + s.relation),
        onPick: async (proj, relation) => {
          if (staged.some((s) => s.id === proj.id && s.relation === relation)) return false;
          staged.push({ id: proj.id, name: proj.name, relation });
          paintStaged();
          return true;
        } }) }));
  }
  if (!isEdit) {
    paintStaged();
    const preProj = params && params.get && params.get('project');
    const preRel = params && params.get && params.get('relation');
    if (preProj && (preRel === 'required' || preRel === 'produced')) {
      (async () => {
        try {
          const d = await api('/api/ui/v6/projects/' + encodeURIComponent(preProj)).then((r) => r && (r.project || r));
          if (d && d.id) { staged.push({ id: d.id, name: d.name, relation: preRel }); paintStaged(); }
        } catch (_) { /* graceful */ }
      })();
    }
  }

  // ── 제목(노션형 큰 contenteditable) ──
  const titleIn = el('div', { class: 'ke-title', contenteditable: 'true', 'data-ph': '제목 없음' });
  titleIn.textContent = k.title || '';
  titleIn.addEventListener('keydown', (e: any) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); editor.focusEnd(); }
  });
  titleIn.addEventListener('paste', (e: any) => {   // 제목은 평문 한 줄
    e.preventDefault();
    const t = (e.clipboardData || (window as any).clipboardData).getData('text/plain').replace(/\n+/g, ' ');
    document.execCommand('insertText', false, t);
  });

  // ── 본문 — 블록 에디터 + 마크다운 원문 토글 ──
  const editor = createBlockEditor({
    initial: k.body_md || '',
    onSaveShortcut: () => save(),
  });
  const rawTa = el('textarea', { class: 'ke-raw-ta mono', spellcheck: 'false',
    placeholder: '마크다운 원문' }) as HTMLTextAreaElement;
  rawTa.hidden = true;
  let rawMode = false;
  const rawToggle = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'MD 원문',
    title: '블록 에디터 ⇄ 마크다운 원문 편집 전환' });
  rawToggle.onclick = () => {
    rawMode = !rawMode;
    if (rawMode) { rawTa.value = editor.getMarkdown(); rawTa.hidden = false; editor.el.hidden = true; rawToggle.textContent = '블록 에디터'; rawTa.focus(); }
    else { editor.setMarkdown(rawTa.value); (editor as any).resetDirty ? null : null; rawTa.hidden = true; editor.el.hidden = false; rawToggle.textContent = 'MD 원문'; }
  };

  // ── 커버/아이콘 ──
  const coverBox = el('div', { class: 'ke-cover', hidden: true });
  const coverBtns = el('div', { class: 'ke-cover-btns' },
    el('button', { class: 'ke-coverbtn', type: 'button', text: '커버 변경',
      onclick: (e: any) => openCoverPicker(e.target, { current: decor.cover, onPick: (v) => { decor.cover = v || ''; paintDecor(); } }) }),
    el('button', { class: 'ke-coverbtn', type: 'button', text: '제거', onclick: () => { decor.cover = ''; paintDecor(); } }));
  coverBox.append(coverBtns);
  const iconBtn = el('button', { class: 'ke-icon', type: 'button', title: '아이콘 변경' });
  iconBtn.onclick = () => openEmojiPicker(iconBtn, {
    onPick: (em) => { decor.icon = em; paintDecor(); },
    onClear: decor.icon ? () => { decor.icon = ''; paintDecor(); } : undefined,
  });
  const decorAdd = el('div', { class: 'ke-decor-add' });
  function paintDecor() {
    coverBox.hidden = !decor.cover;
    if (decor.cover) applyCoverBg(coverBox, decor.cover);
    iconBtn.hidden = !decor.icon;
    iconBtn.textContent = decor.icon || '';
    iconBtn.className = 'ke-icon' + (decor.cover ? ' ke-icon-oncover' : '');
    decorAdd.replaceChildren(
      !decor.icon ? el('button', { class: 'ke-decor-btn', type: 'button', text: '☺ 아이콘 추가',
        onclick: (e: any) => openEmojiPicker(e.target, { onPick: (em) => { decor.icon = em; paintDecor(); } }) }) : null,
      !decor.cover ? el('button', { class: 'ke-decor-btn', type: 'button', text: '🖼 커버 추가',
        onclick: (e: any) => openCoverPicker(e.target, { onPick: (v) => { decor.cover = v || ''; paintDecor(); } }) }) : null);
  }
  paintDecor();

  // ── 저장 ──
  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: isEdit ? '저장' : '만들기' });
  const statusEl = el('span', { class: 'ke-status' });
  async function save() {
    const body = (rawMode ? rawTa.value : editor.getMarkdown()).trim();
    const title = (titleIn.textContent || '').trim();
    if (!body) { toast('본문을 입력하세요', true); (rawMode ? rawTa : editor.el).focus(); return; }
    if (!catSel.value) { toast('분류를 선택하세요 (1개 필수)', true); catSel.focus(); return; }
    if (!typeSel.value) { toast('유형을 선택하세요', true); typeSel.focus(); return; }
    saveBtn.disabled = true;
    statusEl.textContent = '저장 중…';
    try {
      const payload: any = { title: title || undefined, body_md: body, provenance: provSel.value, category: catSel.value, type: typeSel.value };
      if (isEdit) payload.name = k.name;
      else if (nameIn.value.trim()) payload.name = nameIn.value.trim();
      const r = await api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify(payload) });
      const savedName = (r && r.knowledge && r.knowledge.name) || payload.name;
      if (!savedName) throw new Error('저장 응답에 이름이 없습니다');
      // 아이콘/커버(props_ui) — 값이 있거나(설정) 편집에서 지워졌으면(제거) 반영. 실패해도 본문 저장은 유효.
      const prevIcon = (k.props_ui && k.props_ui.icon) || '';
      const prevCover = (k.props_ui && k.props_ui.cover) || '';
      if (decor.icon !== prevIcon || decor.cover !== prevCover) {
        try {
          await api('/api/ui/knowledge/' + encodeURIComponent(savedName) + '/props-ui', { method: 'POST',
            body: JSON.stringify({ icon: decor.icon || null, cover: decor.cover || null }) });
        } catch (e) { toast('아이콘/커버 저장 실패 — ' + e.message, true); }
      }
      if (!isEdit && staged.length) {
        const res = await Promise.allSettled(staged.map((s) =>
          api('/api/ui/v6/projects/' + s.id + '/knowledge', { method: 'POST', body: JSON.stringify({ name: savedName, relation: s.relation }) })));
        const fail = res.filter((x) => x.status === 'rejected').length;
        if (fail) toast('지식은 저장됨 — 프로젝트 연결 ' + fail + '건 실패', true);
      }
      toast(isEdit ? '저장했습니다' : '페이지를 만들었습니다');
      editor.destroy();
      location.hash = '#/k/' + encodeURIComponent(savedName);
    } catch (e) {
      toast('저장 실패 — ' + e.message, true);
      saveBtn.disabled = false;
      statusEl.textContent = '';
    }
  }
  saveBtn.onclick = save;

  // ── 조립 — 문서 캔버스형(kn-doc 폭 규칙 재사용) ──
  const backHref = isEdit ? ('#/k/' + encodeURIComponent(k.name)) : '#/knowledge';
  const topBar = el('div', { class: 'ke-topbar' },
    el('a', { class: 'btn btn-ghost btn-sm', href: backHref, text: '← 돌아가기' }),
    el('div', { class: 'ke-topbar-right' }, statusEl, rawToggle, saveBtn));

  // 속성 행(노션형 세로 라벨-값) — 분류/유형은 필수 마크.
  const propRow = (label: string, node: any, req?: boolean) => el('div', { class: 'ke-prop' },
    el('span', { class: 'ke-prop-k', text: label + (req ? ' *' : '') }), el('div', { class: 'ke-prop-v' }, node));
  const props = el('div', { class: 'ke-props' },
    propRow('카테고리', catSel, true),
    propRow('유형', typeSel, true),
    propRow('파일명', nameIn),
    propRow('출처', provSel),
    isEdit ? null : propRow('프로젝트', stagedList));

  const page = el('div', { class: 'ke-page kn-doc' },
    coverBox,
    el('div', { class: 'ke-canvas' },
      iconBtn,
      decorAdd,
      titleIn,
      props,
      el('hr', { class: 'kn-doc-hr' }),
      rawTa,
      editor.el));
  view.replaceChildren(el('div', { class: 'ke-shell' }, topBar, page));
  setTimeout(() => { if (!isEdit && !titleIn.textContent) titleIn.focus(); else editor.focusEnd(); }, 0);
}
