// wiki-category.ts — #764 카테고리 페이지. "카테고리를 연다 = 그 카테고리의 페이지를 연다."
//  대문/문서 탭 폐지 — 한 페이지에 위→아래로: [커버] → 아이콘·이름·설명(인라인 rename) →
//  큐레이션 층(category-home-<key> 본문, 블록 에디터 — 있으면 위에 렌더) → 라이브러리(항상):
//  시작점(대문이 비었을 때만 — 자동 오리엔테이션: 리드 카드+데크 발췌) · 폴더(대표 제목 미리보기) ·
//  유형 카운트 행(칩이 아닌 클릭 텍스트) · 문서 목록(최신순, 민트 틱).
//  큐레이션 0에서도 완결된 온보딩이 되고, 꾸미면 그 위에 얹힌다(대문이 생기면 자동 시작점이 조용히 물러난다).
import { api, el, errorNote, relTime, renderMarkdown, toast } from './core.js';
import { overlayBox, skeleton } from './learn.js';
import { hasScope } from './admin.js';
import { createBlockEditor } from './block-editor.js';
import { applyCoverBg, openCoverPicker, openEmojiPicker } from './page-decor.js';
import { HOME_EMPTY, KN_TYPE_LABEL, hasMemoryScope, homeDocName, isCategoryHomeDoc, knFetchCategoryRows, knFolderFirstSort, knInvalidateTreeCaches, openProjectChooser, wkTrackEditor, } from './wiki-data.js';
import { wkDeck, wkEmpty, wkRow, wkSection, wkTick } from './wiki-ui.js';
import { openWikiPeek, setWikiPeekList } from './wiki-doc.js';
// ── 폴더 만들기 — 트리 그룹 노드(is_folder). 현재 폴더 안이면 그 아래로. ──
function openFolderForm(cat, parentFolder, done) {
    const nameIn = el('input', { type: 'text', placeholder: '폴더 이름', maxlength: '200' });
    const makeBtn = el('button', { class: 'btn btn-primary', text: '만들기' });
    const cancel = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
    const back = overlayBox('새 폴더 · ' + (cat.name || cat.key), el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn), parentFolder ? el('p', { class: 'admin-hint', text: '현재 폴더 아래에 만들어집니다.' }) : null, el('div', { class: 'ov-actions' }, makeBtn, cancel));
    setTimeout(() => nameIn.focus(), 0);
    const go = async () => {
        const title = nameIn.value.trim();
        if (!title) {
            nameIn.focus();
            return;
        }
        makeBtn.disabled = true;
        try {
            const payload = { title, body_md: '', is_folder: true, category: cat.key, type: 'reference' };
            if (parentFolder)
                payload.parent_name = parentFolder;
            await api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify(payload) });
            knInvalidateTreeCaches();
            toast('폴더를 만들었습니다');
            back.remove();
            done();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            makeBtn.disabled = false;
        }
    };
    makeBtn.onclick = go;
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229)
        go(); }); // IME 조합 확정 Enter 가드(#505)
}
// ── 리드 카드 — 시작점의 첫 문서(핀 우선). 데크 = 본문 첫 문단 발췌(클릭 전에 내용이 읽힌다). ──
function wkLeadCard(e, open) {
    const deck = wkDeck(e.body_md || '', 170);
    const card = el('div', { class: 'wk-lead', role: 'link', tabindex: '0', 'data-author': e.confidence || '' }, el('div', { class: 'wk-lead-toprow' }, wkTick(e), e.icon ? el('span', { class: 'wk-lead-ic', 'aria-hidden': 'true', text: e.icon }) : null, el('span', { class: 'wk-lead-title', text: e.title || e.name })), deck ? el('p', { class: 'wk-lead-deck', text: deck }) : null, el('div', { class: 'wk-lead-meta' }, e.is_wiki ? el('span', { class: 'wk-row-m', text: '인덱스' }) : null, e.type ? el('span', { class: 'wk-row-m', text: KN_TYPE_LABEL[e.type] || e.type }) : null, e.updated_at ? el('span', { class: 'wk-row-m', text: relTime(e.updated_at) }) : null));
    const go = () => open(e, card);
    card.addEventListener('click', go);
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter')
        go(); });
    return card;
}
// ════════════════════════════════════════════
// renderCategorySurface(box, cat, ctx { f, syncHash, onCatChanged, repaint })
// ════════════════════════════════════════════
async function renderCategorySurface(box, cat, ctx) {
    const f = ctx.f;
    const canDoc = hasScope('memory');
    const canCat = hasScope('context');
    box.replaceChildren(el('div', { class: 'wk-plainpad' }, skeleton('카테고리를 여는 중')));
    // ── 데이터 — 카테고리 rows(세션 캐시 1콜) + 대문 문서(404 = 아직 사용자화 전). ──
    let rows = [];
    let home = null;
    try {
        [rows, home] = await Promise.all([
            knFetchCategoryRows(cat.id).catch(() => []),
            api('/api/ui/knowledge/' + encodeURIComponent(homeDocName(cat))).then((r) => r && (r.knowledge || r)).catch(() => null),
        ]);
    }
    catch (e) {
        box.replaceChildren(errorNote(e, '카테고리를 불러오지 못했습니다'));
        return;
    }
    const homeBody = () => {
        const b = (home && home.body_md) || '';
        return b === HOME_EMPTY ? '' : b;
    };
    const hasContent = !!homeBody().trim();
    const refresh = () => { knInvalidateTreeCaches(); ctx.repaint(); };
    const openDoc = (e, rowEl) => {
        if (e.is_folder) {
            f.folder = e.name;
            ctx.syncHash();
            ctx.repaint();
            return;
        }
        openWikiPeek(e.name, { onRefresh: refresh, originEl: rowEl });
    };
    // ── 대문 문서 멱등 생성/저장(스키마 변경 0 — 지식 문서 1건이 대문의 전부). ──
    //  생성은 in-flight 1개로 직렬화 — 본문 자동저장과 장식 저장이 동시에 생성 경합하면
    //  빈(ZWSP) 생성이 늦게 도착해 방금 쓴 큐레이션 본문을 덮을 수 있다.
    let homeCreating = null;
    async function ensureHome(bodyMd) {
        const name = homeDocName(cat);
        if (!home && homeCreating)
            await homeCreating.catch(() => { });
        if (home && home.name) {
            if (bodyMd !== undefined) {
                await api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify({ name, body_md: bodyMd || HOME_EMPTY }) });
                home.body_md = bodyMd || HOME_EMPTY;
            }
            return name;
        }
        homeCreating = api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify({
                name, title: (cat.name || cat.key) + ' 대문', body_md: bodyMd || HOME_EMPTY, category: cat.key, type: 'reference',
            }) });
        try {
            const r = await homeCreating;
            home = (r && r.knowledge) || { name, body_md: bodyMd || HOME_EMPTY, props_ui: null };
        }
        finally {
            homeCreating = null;
        }
        return name;
    }
    async function saveDecor(patch) {
        try {
            const name = await ensureHome();
            const r = await api('/api/ui/knowledge/' + encodeURIComponent(name) + '/props-ui', { method: 'POST', body: JSON.stringify(patch) });
            home.props_ui = (r && r.props_ui) || Object.assign({}, home.props_ui || {}, patch);
        }
        catch (e) {
            toast('저장 실패 — ' + e.message, true);
        }
        paintDecor();
    }
    // ── 커버 + 아이콘 ──
    const cover = el('div', { class: 'wk-cat-cover', hidden: true });
    const iconBtn = el('button', { class: 'wk-cat-icon', type: 'button', title: canDoc ? '아이콘 변경' : '' });
    const coverAddBtn = canDoc ? el('button', { class: 'wk-addcover', type: 'button', text: '🖼 커버 추가',
        onclick: (e) => openCoverPicker(e.target, { current: null, onPick: (v) => saveDecor({ cover: v }) }) }) : null;
    function paintDecor() {
        const cv = (home && home.props_ui && home.props_ui.cover) || '';
        const hasCover = applyCoverBg(cover, cv);
        cover.hidden = !hasCover;
        cover.replaceChildren(...[hasCover && canDoc ? el('div', { class: 'wk-cover-btns' }, el('button', { class: 'wk-cover-btn', type: 'button', text: '커버 변경',
                onclick: (e) => openCoverPicker(e.target, { current: cv || null, onPick: (v) => saveDecor({ cover: v }) }) }), el('button', { class: 'wk-cover-btn', type: 'button', text: '제거', onclick: () => saveDecor({ cover: null }) })) : null].filter(Boolean));
        if (coverAddBtn)
            coverAddBtn.hidden = hasCover;
        const ic = (home && home.props_ui && home.props_ui.icon) || '';
        iconBtn.classList.toggle('letter', !ic);
        // charAt(0) 는 이모지(서로게이트 페어) 이름에서 깨진 문자 — 코드포인트 단위로 첫 문자소.
        iconBtn.textContent = ic || (Array.from(String(cat.name || cat.key || '?').trim())[0] || '?').toUpperCase();
    }
    if (canDoc) {
        iconBtn.onclick = () => openEmojiPicker(iconBtn, {
            title: '카테고리 아이콘',
            onPick: (em) => saveDecor({ icon: em }),
            onClear: (home && home.props_ui && home.props_ui.icon) ? () => saveDecor({ icon: null }) : undefined,
        });
    }
    paintDecor();
    // ── 이름/설명 — 인라인 rename(카테고리 필드, context 권한). ──
    const titleEl = el('h1', { class: 'wk-cat-title' + (canCat ? ' editable' : ''),
        ...(canCat ? { contenteditable: 'true', spellcheck: 'false', title: '클릭해서 이름 변경' } : {}) });
    titleEl.textContent = cat.name || cat.key;
    const descEl = el('div', { class: 'wk-cat-desc' + (canCat ? ' editable' : ''),
        ...(canCat ? { contenteditable: 'true', 'data-ph': '설명 추가…', spellcheck: 'false' } : {}) });
    descEl.textContent = cat.description || '';
    if (canCat) {
        const oneLine = (node) => node.addEventListener('paste', (e) => {
            e.preventDefault();
            const t = (e.clipboardData || window.clipboardData).getData('text/plain').replace(/\n+/g, ' ');
            document.execCommand('insertText', false, t);
        });
        oneLine(titleEl);
        oneLine(descEl);
        const enterBlur = (node) => node.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                node.blur();
            }
        });
        enterBlur(titleEl);
        enterBlur(descEl);
        titleEl.addEventListener('blur', async () => {
            const t = (titleEl.textContent || '').trim();
            if (!t) {
                titleEl.textContent = cat.name || cat.key;
                return;
            }
            if (t === (cat.name || cat.key))
                return;
            try {
                await api('/api/ui/categories/' + cat.id, { method: 'POST', body: JSON.stringify({ name: t }) });
                cat.name = t;
                toast('카테고리 이름을 바꿨습니다');
                if (ctx.onCatChanged)
                    ctx.onCatChanged();
            }
            catch (e) {
                toast('이름 변경 실패 — ' + e.message, true);
                titleEl.textContent = cat.name || cat.key;
            }
        });
        descEl.addEventListener('blur', async () => {
            const t = (descEl.textContent || '').trim();
            if (t === (cat.description || ''))
                return;
            try {
                await api('/api/ui/categories/' + cat.id, { method: 'POST', body: JSON.stringify({ description: t }) });
                cat.description = t;
            }
            catch (e) {
                toast('설명 저장 실패 — ' + e.message, true);
                descEl.textContent = cat.description || '';
            }
        });
    }
    // ── 헤더 액션 — 화면당 채운 primary 1개(＋ 새 페이지) + 조용한 ⋯. ──
    const saveChip = el('span', { class: 'wk-save-chip', 'aria-live': 'polite' });
    const actions = el('div', { class: 'wk-cat-actions' }, saveChip);
    if (canDoc) {
        actions.append(el('a', { class: 'btn btn-primary btn-sm', href: '#/knowledge/new?category=' + encodeURIComponent(cat.key) + (f.folder ? '&folder=' + encodeURIComponent(f.folder) : ''),
            title: '이 카테고리에 새 페이지를 씁니다 — 제목을 쓰면 바로 저장', text: '＋ 새 페이지' }));
    }
    const moreBtn = el('button', { class: 'wk-folio-btn wk-more', type: 'button', title: '카테고리 동작', 'aria-label': '카테고리 동작', text: '⋯' });
    actions.append(moreBtn);
    moreBtn.onclick = () => {
        const old = document.querySelector('.wk-morepop');
        if (old) {
            (old._close || (() => old.remove()))();
            return;
        } // 토글 닫기도 close 경유 — 리스너 잔존 방지
        const pop = el('div', { class: 'wk-morepop', role: 'menu' });
        const close = () => { pop.remove(); document.removeEventListener('mousedown', onDoc, true); };
        pop._close = close;
        const onDoc = (ev) => { if (!pop.contains(ev.target) && ev.target !== moreBtn)
            close(); };
        const item = (label, fn) => {
            const b = el('button', { class: 'wk-morepop-item', type: 'button', text: label });
            b.onclick = () => { close(); fn(); };
            return b;
        };
        if (canDoc)
            pop.append(item('📁 폴더 만들기', () => openFolderForm(cat, f.folder, refresh)));
        if (canDoc)
            pop.append(item(sel.mode ? '선택 모드 끄기' : '☑ 여러 개 선택', () => { sel.mode = !sel.mode; if (!sel.mode)
                sel.names.clear(); paintLibrary(); }));
        document.body.append(pop);
        const r = moreBtn.getBoundingClientRect();
        pop.style.top = (r.bottom + 6) + 'px';
        pop.style.left = Math.max(8, r.right - 200) + 'px';
        setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
    };
    // ── 큐레이션 층 — 대문 본문(블록 에디터, 자동 저장). 비면 유령 텍스트가 초대한다. ──
    const curation = el('div', { class: 'wk-cat-curation' });
    if (canDoc) {
        let timer = null;
        let saving = false;
        const setChip = (t, busy) => { saveChip.textContent = t; saveChip.classList.toggle('busy', !!busy); };
        const doSave = async () => {
            if (saving || !editor.isDirty())
                return;
            saving = true;
            setChip('저장 중…', true);
            try {
                await ensureHome(editor.getMarkdown().trim());
                editor.resetDirty();
                setChip('저장됨');
                setTimeout(() => { if (saveChip.textContent === '저장됨')
                    setChip(''); }, 2500);
            }
            catch (e) {
                setChip('저장 실패', true);
                toast('대문 저장 실패 — ' + e.message, true);
            }
            saving = false;
            if (editor.isDirty())
                queue();
        };
        const queue = () => { setChip('수정됨…', true); clearTimeout(timer); timer = setTimeout(doSave, 2000); };
        const editor = wkTrackEditor(createBlockEditor({
            initial: homeBody(),
            placeholder: "여는 글을 쓰세요 — '/'로 페이지 카드·라이브 목록·콜아웃·컬럼",
            onChange: queue,
            onSaveShortcut: () => { clearTimeout(timer); doSave(); },
        }));
        editor.el.addEventListener('focusout', () => { if (editor.isDirty()) {
            clearTimeout(timer);
            doSave();
        } });
        curation.append(editor.el);
        if (!hasContent) {
            const tplBtn = el('button', { class: 'wk-tpl-btn', type: 'button', title: '핀 문서 카드 + 최근/결정 라이브 목록으로 시작' }, el('span', { text: '✨ 템플릿으로 시작' }));
            tplBtn.onclick = async () => {
                tplBtn.disabled = true;
                try {
                    const md = await buildHomeTemplate(cat);
                    editor.setMarkdown(md);
                    await ensureHome(md);
                    setChip('저장됨');
                    tplBtn.remove();
                    toast('대문 템플릿을 만들었습니다 — 자유롭게 고쳐보세요');
                }
                catch (e) {
                    toast('템플릿 생성 실패 — ' + e.message, true);
                    tplBtn.disabled = false;
                }
            };
            curation.append(el('div', { class: 'wk-tpl' }, tplBtn));
        }
    }
    else if (hasContent) {
        curation.append(el('div', { class: 'md-rendered wk-doc-md' }, renderMarkdown(homeBody())));
    }
    // 엔트리 문서 하위호환(view_mode=entry) — 큐레이션 위 리드 카드로 흡수.
    const entrySlot = el('div', { class: 'wk-cat-entry' });
    if (cat.view_mode === 'entry' && cat.entry_name && !isCategoryHomeDoc(cat.entry_name)) {
        const e = rows.find((r) => r.name === cat.entry_name);
        if (e)
            entrySlot.append(wkLeadCard(e, (x, r) => openDoc(x, r)));
    }
    // ── 라이브러리(항상) — 시작점 · 폴더 · 유형 카운트 · 문서 목록. ──
    const library = el('div', { class: 'wk-cat-library' });
    const sel = { mode: false, names: new Set() };
    const bulkBar = el('div', { class: 'wk-bulkbar', hidden: true });
    const catNames = new Set(rows.map((r) => r.name));
    const allDocs = rows.filter((r) => !isCategoryHomeDoc(r.name) && !r.is_folder);
    const allFolders = rows.filter((r) => r.is_folder);
    const topFolders = allFolders.filter((r) => !(r.parent_name && catNames.has(r.parent_name))).slice().sort(knFolderFirstSort);
    function repaintBulk() {
        if (!sel.mode) {
            bulkBar.hidden = true;
            bulkBar.replaceChildren();
            return;
        }
        bulkBar.hidden = false;
        const n = sel.names.size;
        const info = el('span', { class: 'wk-bulk-info', text: n ? n + '개 선택' : '문서를 선택하세요' });
        const linkBtn = hasMemoryScope() ? el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 프로젝트 연결',
            onclick: () => openProjectChooser({
                title: '선택한 지식 ' + n + '건을 프로젝트에 연결', actionLabel: '＋ 연결', doneLabel: '연결됨',
                onPick: async (proj, relation) => {
                    const names = Array.from(sel.names);
                    await Promise.all(names.map((nm) => api('/api/ui/v6/projects/' + proj.id + '/knowledge', { method: 'POST', body: JSON.stringify({ name: nm, relation }) })));
                    toast(names.length + '건을 연결했습니다');
                    return true;
                }
            }) }) : null;
        const delBtn = hasMemoryScope() ? el('button', { class: 'btn btn-ghost btn-sm wk-bulk-del', text: '선택 삭제',
            onclick: async () => {
                if (!n || !confirm(n + '개 지식을 삭제할까요?\n휴지통(#/trash)에서 복원할 수 있습니다.'))
                    return;
                try {
                    await Promise.all(Array.from(sel.names).map((nm) => api('/api/ui/knowledge/' + encodeURIComponent(nm) + '/delete', { method: 'POST' })));
                    toast(n + '건을 삭제했습니다 — 휴지통에서 복원 가능');
                    sel.mode = false;
                    sel.names.clear();
                    refresh();
                }
                catch (e) {
                    toast('삭제 실패 — ' + e.message, true);
                }
            } }) : null;
        const exitBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '취소', onclick: () => { sel.mode = false; sel.names.clear(); paintLibrary(); } });
        if (linkBtn)
            linkBtn.disabled = !n;
        if (delBtn)
            delBtn.disabled = !n;
        bulkBar.replaceChildren(...[info, el('span', { class: 'wk-sec-sp' }), linkBtn, delBtn, exitBtn].filter(Boolean));
    }
    function paintLibrary() {
        library.replaceChildren();
        repaintBulk();
        library.append(bulkBar);
        // 폴더 드릴다운 — 브레드크럼 + 그 폴더의 직속 항목.
        if (f.folder) {
            const chain = [];
            let curName = f.folder;
            const byName = new Map(rows.map((r) => [r.name, r]));
            while (curName && byName.has(curName)) {
                chain.unshift(byName.get(curName));
                curName = byName.get(curName).parent_name;
            }
            const crumb = el('div', { class: 'wk-folder-crumb' }, el('button', { class: 'wk-crumb clickable', type: 'button', text: cat.name || cat.key,
                onclick: () => { f.folder = ''; ctx.syncHash(); paintLibrary(); } }));
            chain.forEach((fd, i) => {
                crumb.append(el('span', { class: 'wk-crumb-sep', 'aria-hidden': 'true', text: '›' }));
                if (i === chain.length - 1)
                    crumb.append(el('span', { class: 'wk-crumb wk-crumb-cur', text: '📁 ' + (fd.title || fd.name) }));
                else
                    crumb.append(el('button', { class: 'wk-crumb clickable', type: 'button', text: '📁 ' + (fd.title || fd.name),
                        onclick: () => { f.folder = fd.name; ctx.syncHash(); paintLibrary(); } }));
            });
            const kids = rows.filter((r) => r.parent_name === f.folder && !isCategoryHomeDoc(r.name)).slice().sort(knFolderFirstSort);
            const sec = wkSection('폴더 항목', { count: kids.length });
            if (!kids.length)
                sec.body.append(wkEmpty('폴더가 비어 있어요 — 문서의 ⋯ 메뉴 ▸ 이동으로 담을 수 있습니다.'));
            else {
                for (const r of kids)
                    sec.body.append(wkRow(r, { open: openDoc, select: sel.mode && !r.is_folder ? { names: sel.names, onToggle: repaintBulk } : null }));
                setWikiPeekList(kids.filter((r) => !r.is_folder).map((r) => r.name));
            }
            library.append(crumb, sec.el);
            return;
        }
        // 빈 카테고리 — 섹션 나열 금지, 초대 한 줄.
        if (!allDocs.length && !topFolders.length) {
            library.append(wkEmpty('아직 문서가 없어요. 첫 페이지로 이 카테고리를 시작해 보세요.', canDoc ? el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge/new?category=' + encodeURIComponent(cat.key), text: '＋ 첫 페이지' }) : null));
            return;
        }
        // 시작점 — 대문이 비어 있을 때만(대문이 생기면 자동 오리엔테이션이 조용히 물러난다).
        if (!hasContent && !f.type && !sel.mode) {
            const pinned = allDocs.filter((r) => r.is_wiki);
            const rest = allDocs.filter((r) => !r.is_wiki);
            const lead = pinned[0] || rest.find((r) => r.type === 'decision') || rest[0];
            if (lead) {
                const more = [...pinned.filter((r) => r !== lead), ...rest.filter((r) => r !== lead && r.type === 'concept')].slice(0, 3);
                const sec = wkSection('먼저 읽기', { hint: '핀·개념 문서 우선 — 대문을 쓰면 이 자동 구성이 대체됩니다' });
                sec.body.append(wkLeadCard(lead, (x, r) => openDoc(x, r)));
                if (more.length)
                    sec.body.append(...more.map((r) => wkRow(r, { open: openDoc })));
                library.append(sec.el);
            }
        }
        // 폴더 — 대표 제목 3개 미리보기(클릭 전 폴더 성격 파악).
        if (topFolders.length && !f.type && !sel.mode) {
            const sec = wkSection('폴더', { count: topFolders.length });
            for (const fd of topFolders) {
                const kids = rows.filter((r) => r.parent_name === fd.name && !r.is_folder);
                const preview = kids.slice(0, 3).map((r) => r.title || r.name).join(' · ');
                sec.body.append(wkRow(fd, { open: openDoc, metas: [preview ? preview.slice(0, 60) : null, kids.length + '개'] }));
            }
            library.append(sec.el);
        }
        // 유형 카운트 행 — 칩이 아닌 텍스트 필터(클릭=토글).
        const counts = new Map();
        for (const r of allDocs)
            counts.set(r.type || '', (counts.get(r.type || '') || 0) + 1);
        const typeRow = el('div', { class: 'wk-typerow' }, el('button', { class: 'wk-type-it' + (!f.type ? ' on' : ''), type: 'button', text: '전체 ' + allDocs.length,
            onclick: () => { f.type = ''; ctx.syncHash(); paintLibrary(); } }), ...Array.from(counts.entries()).filter(([t]) => t).sort((a, b) => b[1] - a[1]).map(([t, n]) => el('button', { class: 'wk-type-it' + (f.type === t ? ' on' : ''), type: 'button', text: (KN_TYPE_LABEL[t] || t) + ' ' + n,
            onclick: () => { f.type = f.type === t ? '' : t; ctx.syncHash(); paintLibrary(); } })));
        // 문서 목록 — 최신순.
        const list = allDocs.filter((r) => !f.type || r.type === f.type)
            .slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
        const secActions = [];
        if (!sel.mode)
            secActions.push(el('button', { class: 'wk-sec-act', type: 'button', text: '선택',
                title: '여러 문서를 골라 프로젝트 연결·삭제', onclick: () => { sel.mode = true; paintLibrary(); } }));
        const sec = wkSection('문서', { count: list.length, actions: secActions });
        if (!list.length)
            sec.body.append(wkEmpty(f.type ? '이 유형의 문서가 없어요.' : '문서가 없어요.'));
        else {
            for (const r of list)
                sec.body.append(wkRow(r, {
                    open: openDoc,
                    select: sel.mode ? { names: sel.names, onToggle: repaintBulk } : null,
                    metas: [r.is_wiki ? '인덱스' : null, !f.type && r.type ? (KN_TYPE_LABEL[r.type] || r.type) : null, relTime(r.updated_at)],
                }));
            if (!sel.mode)
                setWikiPeekList(list.map((r) => r.name));
        }
        const wrap = el('div', { class: 'wk-doclist-wrap' }, typeRow, sec.el);
        library.append(wrap);
    }
    paintLibrary();
    // ── 조립 ──
    box.replaceChildren(el('div', { class: 'wk-cat' }, cover, el('div', { class: 'wk-cat-inner' }, coverAddBtn, iconBtn, el('div', { class: 'wk-cat-headrow' }, el('div', { class: 'wk-cat-headmain' }, titleEl, descEl), actions), entrySlot, curation, library)));
}
// ── 대문 스타터 템플릿 — 콜아웃 환영 + 핀 우선 카드 + 2열(최근 | 결정) 라이브 컬렉션. ──
async function buildHomeTemplate(cat) {
    let rows = [];
    try {
        rows = await knFetchCategoryRows(cat.id);
    }
    catch (_) { /* 목록 실패 — 카드 없는 템플릿 */ }
    const docs = rows.filter((r) => !isCategoryHomeDoc(r.name) && !r.is_folder);
    const pinned = docs.filter((r) => r.is_wiki);
    const rest = docs.filter((r) => !r.is_wiki);
    const key = docs.length ? [...pinned, ...rest].slice(0, 3) : [];
    const cards = key.map((r) => '[' + String(r.title || r.name).replace(/[\[\]]/g, ' ').trim() + '](#/k/' + encodeURIComponent(r.name) + ')').join('\n');
    const name = cat.name || cat.key;
    return ':::callout icon=👋 color=default\n'
        + '**' + name + '** 카테고리에 오신 걸 환영해요. 처음이라면 아래 핵심 문서부터 보세요 — 이 대문은 팀 누구나 자유롭게 고칠 수 있어요 (\'/\'로 블록 추가, ⋮⋮로 배치 이동).\n'
        + ':::\n\n'
        + (cards ? '# 핵심 문서\n' + cards + '\n\n' : '')
        + ':::columns\n'
        + ':::column\n## 최근 업데이트\n:::collection category=' + cat.key + ' limit=5\n:::\n:::\n'
        + ':::column\n## 결정 기록\n:::collection category=' + cat.key + ' type=decision limit=5\n:::\n:::\n'
        + ':::';
}
export { renderCategorySurface };
