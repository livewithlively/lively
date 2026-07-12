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
import { wkAurora, wkDeck, wkDocCard, wkEmpty, wkIsRead, wkRow, wkSection } from './wiki-ui.js';
import { openWikiPeek, setWikiPeekList } from './wiki-doc.js';
import { openCategoryForm } from './category-form.js'; // 개요 ✎ — 정의·범위(should) 편집
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
// (시작점/엔트리 카드 = wiki-ui 의 wkDocCard 공용 — #764v2 에서 wkLeadCard 폐지)
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
    // ── 커버 + 아이콘 — 커버는 **항상** 있다(#764v2): 커스텀(props_ui.cover)이 없으면 카테고리 시드의
    //  오로라(공간 색 계열 제너레이티브 + 오버사이즈 워터마크). 큐레이션 0에서도 대문이 대문답게 보이게. ──
    const cover = el('div', { class: 'wk-cat-cover' });
    const iconBtn = el('button', { class: 'wk-cat-icon', type: 'button', title: canDoc ? '아이콘 변경' : '' });
    const letterOf = () => (Array.from(String(cat.name || cat.key || '?').trim())[0] || '?').toUpperCase();
    function paintDecor() {
        const cv = (home && home.props_ui && home.props_ui.cover) || '';
        const ic = (home && home.props_ui && home.props_ui.icon) || '';
        cover.replaceChildren();
        cover.removeAttribute('style');
        const hasCustom = !!cv && applyCoverBg(cover, cv);
        if (!hasCustom)
            cover.append(wkAurora(String(cat.key || cat.id), cat.space, { cls: 'wk-cat-aurora', watermark: ic || letterOf() }));
        if (canDoc) {
            cover.append(el('div', { class: 'wk-cover-btns' }, el('button', { class: 'wk-cover-btn', type: 'button', text: hasCustom ? '커버 변경' : '커버 직접 고르기',
                onclick: (e) => openCoverPicker(e.target, { current: cv || null, onPick: (v) => saveDecor({ cover: v }) }) }), hasCustom ? el('button', { class: 'wk-cover-btn', type: 'button', title: '기본(자동 생성) 커버로 되돌립니다', text: '기본으로',
                onclick: () => saveDecor({ cover: null }) }) : null));
        }
        iconBtn.classList.toggle('letter', !ic);
        iconBtn.textContent = ic || letterOf();
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
    // ── 팀의 소개(큐레이션) — 대문 본문(블록 에디터, 자동 저장). 개요 챕터의 한 칸에 들어간다.
    //  페이지 카드([제목](#/k/이름))를 쓰면 그 순서가 곧 '읽기 코스'가 된다(코스 큐레이션 = 그냥 글쓰기).
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
            placeholder: "팀의 말로 소개를 쓰세요 — 페이지 카드([[)를 넣으면 읽기 코스가 그 순서를 따라요",
            onChange: queue,
            onSaveShortcut: () => { clearTimeout(timer); doSave(); },
        }));
        editor.el.addEventListener('focusout', () => { if (editor.isDirty()) {
            clearTimeout(timer);
            doSave();
        } });
        curation.append(editor.el);
    }
    else if (hasContent) {
        curation.append(el('div', { class: 'md-rendered wk-doc-md' }, renderMarkdown(homeBody())));
    }
    // 엔트리 문서 하위호환(view_mode=entry) — 큐레이션 위 문서 카드로 흡수.
    const entrySlot = el('div', { class: 'wk-cat-entry' });
    if (cat.view_mode === 'entry' && cat.entry_name && !isCategoryHomeDoc(cat.entry_name)) {
        const e = rows.find((r) => r.name === cat.entry_name);
        if (e)
            entrySlot.append(wkDocCard(e, { open: (x, r) => openDoc(x, r), deckCap: 150, cls: 'entry' }));
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
        // (구 '시작점/먼저 읽기'는 #764v3 브리핑의 '읽기 코스'로 대체 — 아래 buildCourse)
        // 폴더 — 타일 그리드(큰 아이콘 + 이름 + 개수 + 대표 제목 미리보기).
        if (topFolders.length && !f.type && !sel.mode) {
            const sec = wkSection('폴더', { count: topFolders.length });
            const grid = el('div', { class: 'wk-folder-grid' });
            for (const fd of topFolders) {
                const kids = rows.filter((r) => r.parent_name === fd.name && !r.is_folder);
                const preview = kids.slice(0, 2).map((r) => r.title || r.name).join(' · ');
                const tile = el('div', { class: 'wk-folder-tile', role: 'link', tabindex: '0', title: fd.title || fd.name }, el('span', { class: 'wk-folder-tile-ic', 'aria-hidden': 'true', text: fd.icon || '📁' }), el('div', { class: 'wk-folder-tile-main' }, el('div', { class: 'wk-folder-tile-name', text: fd.title || fd.name }), preview ? el('div', { class: 'wk-folder-tile-prev', text: preview }) : null), el('span', { class: 'wk-row-m', text: kids.length + '개' }));
                const go = () => openDoc(fd);
                tile.addEventListener('click', go);
                tile.addEventListener('keydown', (ev) => { if (ev.key === 'Enter')
                    go(); });
                grid.append(tile);
            }
            sec.body.append(grid);
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
                    deck: sel.mode ? '' : wkDeck(r.body_md || '', 110), // 발췌 한 줄 — 목록이 피드처럼 읽히게(#764v2)
                    metas: [r.is_wiki ? '인덱스' : null, !f.type && r.type ? (KN_TYPE_LABEL[r.type] || r.type) : null, relTime(r.updated_at)],
                }));
            if (!sel.mode)
                setWikiPeekList(list.map((r) => r.name));
        }
        const wrap = el('div', { class: 'wk-doclist-wrap' }, typeRow, sec.el);
        library.append(wrap);
    }
    paintLibrary();
    // ════════ #764v3 브리핑 — 지식을 온보딩용으로 '가공'한다: 개요(정의·범위 + 팀의 소개) ·
    //  읽기 코스(진행률) · 핵심 개념(사전 카드) · 결정 기록(타임라인) · 런북. 전부 rows 1콜 재가공(추가 API 0). ════════
    const byName = new Map(rows.map((r) => [r.name, r]));
    const byUpdatedDesc = (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    const concepts = allDocs.filter((r) => r.type === 'concept').sort(byUpdatedDesc);
    const decisions = allDocs.filter((r) => r.type === 'decision').sort(byUpdatedDesc);
    const howtos = allDocs.filter((r) => r.type === 'how-to').sort(byUpdatedDesc);
    const smoothOpt = matchMedia('(prefers-reduced-motion: reduce)').matches ? { block: 'start' } : { behavior: 'smooth', block: 'start' };
    // 브리핑 섹션 골격 — 챕터 앵커(id) + 큼직한 제목(가르치는 문서의 스케일).
    function bfSection(id, title, count, ...actions2) {
        const head = el('div', { class: 'wk-bf-head' }, el('h2', { class: 'wk-bf-title', text: title }), count != null ? el('span', { class: 'wk-bf-count', text: String(count) }) : null, el('span', { class: 'wk-sec-sp' }), ...actions2.filter(Boolean));
        const body = el('div', { class: 'wk-bf-body' });
        return { el: el('section', { class: 'wk-bf-sec', id }, head, body), body };
    }
    // '모두 보기 →' — 유형 필터를 걸고 전체 문서 챕터로 데려간다.
    function seeAllBtn(type) {
        return el('button', { class: 'wk-sec-act', type: 'button', text: '모두 보기 →',
            onclick: () => {
                f.type = type;
                ctx.syncHash();
                paintLibrary();
                const t = document.getElementById('wk-ch-docs');
                if (t)
                    t.scrollIntoView(smoothOpt);
            } });
    }
    // ── 개요 — 좌: 정의·범위·규칙(cat.should — 도메인의 헌법을 대문에 처음 승격) / 우: 팀의 소개(큐레이션). ──
    function buildOverview() {
        const shouldTxt = String(cat.should || '').trim();
        const introSlot = canDoc || hasContent;
        if (!shouldTxt && !introSlot && !cat.description)
            return null;
        const sec = bfSection('wk-ch-overview', '개요', null, canCat ? el('button', { class: 'wk-sec-act', type: 'button', title: '정의·범위·규칙(should)과 설명을 편집합니다',
            text: '✎ 정의 편집', onclick: () => openCategoryForm(cat.space, cat, () => { ctx.onCatChanged(); ctx.repaint(); }) }) : null);
        const grid = el('div', { class: 'wk-bf-grid' + ((shouldTxt && introSlot) ? ' two' : '') });
        if (shouldTxt) {
            const bodyEl = el('div', { class: 'md-rendered wk-bf-should' }, renderMarkdown(shouldTxt));
            const col = el('div', { class: 'wk-bf-col' }, el('div', { class: 'wk-bf-collabel', text: '정의 · 범위 · 규칙' }), bodyEl);
            // 길면 접기 — 개요는 지도이지 전문이 아니다.
            setTimeout(() => {
                if (bodyEl.scrollHeight > 300) {
                    bodyEl.classList.add('clamped');
                    const more = el('button', { class: 'wk-bf-more', type: 'button', text: '전체 펼치기 ▾' });
                    more.onclick = () => {
                        const on = bodyEl.classList.toggle('clamped');
                        more.textContent = on ? '전체 펼치기 ▾' : '접기 ▴';
                    };
                    col.append(more);
                }
            }, 0);
            grid.append(col);
        }
        else if (canCat) {
            grid.append(el('div', { class: 'wk-bf-col' }, el('div', { class: 'wk-bf-collabel', text: '정의 · 범위 · 규칙' }), el('button', { class: 'wk-bf-invite', type: 'button',
                onclick: () => openCategoryForm(cat.space, cat, () => { ctx.onCatChanged(); ctx.repaint(); }) }, el('span', { text: '이 카테고리의 정의와 범위를 적어두면, 새로 오는 팀원의 첫 지도가 됩니다.' }), el('span', { class: 'wk-bf-invite-act', text: '✎ 작성하기' }))));
        }
        if (introSlot) {
            grid.append(el('div', { class: 'wk-bf-col' }, el('div', { class: 'wk-bf-collabel', text: '팀의 소개' }), curation));
        }
        sec.body.append(grid);
        return sec.el;
    }
    // ── 읽기 코스 — "처음이라면 이 순서로". 대문 본문의 페이지 카드가 있으면 그 순서(큐레이션=글쓰기),
    //  없으면 핀→개념→결정→런북에서 자동 구성. 읽음(기기 로컬)은 민트 체크 + 진행률. ──
    function courseDocs() {
        const picked = [];
        const seen = new Set();
        const re = /\[[^\]]*\]\(#\/k\/([^)]+)\)/g;
        let m;
        while ((m = re.exec(homeBody())) && picked.length < 5) {
            let nm = m[1];
            try {
                nm = decodeURIComponent(nm);
            }
            catch (_) { /* 원문 유지 */ }
            if (seen.has(nm) || isCategoryHomeDoc(nm))
                continue;
            seen.add(nm);
            const r = byName.get(nm);
            if (r && !r.is_folder)
                picked.push(r);
        }
        if (picked.length >= 2)
            return picked;
        const auto = [];
        const push = (r) => { if (r && !auto.includes(r) && auto.length < 5)
            auto.push(r); };
        allDocs.filter((r) => r.is_wiki).slice(0, 2).forEach(push);
        push(concepts[0]);
        push(decisions[0]);
        push(howtos[0]);
        for (const r of allDocs) {
            if (auto.length >= 4)
                break;
            push(r);
        }
        return auto;
    }
    function buildCourse() {
        const docs = courseDocs();
        if (docs.length < 2)
            return null;
        const readN = docs.filter((d) => wkIsRead(d.name)).length;
        const sec = bfSection('wk-ch-course', '처음이라면', null, el('span', { class: 'wk-course-progress' + (readN === docs.length ? ' done' : ''), text: readN + '/' + docs.length + ' 읽음' }));
        const track = el('div', { class: 'wk-course' });
        docs.forEach((d, i) => {
            const read = wkIsRead(d.name);
            const step = el('div', { class: 'wk-step' + (read ? ' read' : ''), role: 'link', tabindex: '0', title: d.title || d.name }, el('span', { class: 'wk-step-num', 'aria-hidden': 'true', text: read ? '✓' : String(i + 1) }), el('div', { class: 'wk-step-main' }, el('div', { class: 'wk-step-title', text: d.title || d.name }), el('div', { class: 'wk-step-meta' }, d.type ? el('span', { class: 'wk-row-m', text: KN_TYPE_LABEL[d.type] || d.type }) : null, read ? el('span', { class: 'wk-row-m wk-step-readlbl', text: '읽음' }) : null)));
            const go = () => openDoc(d, step);
            step.addEventListener('click', go);
            step.addEventListener('keydown', (ev) => { if (ev.key === 'Enter')
                go(); });
            track.append(step);
        });
        sec.body.append(track, el('div', { class: 'wk-course-hint', text: '이 순서는 대문 소개글의 페이지 카드를 따라요 — 소개글에 카드를 넣어 코스를 직접 짤 수 있어요.' }));
        return sec.el;
    }
    // ── 핵심 개념 — 이 도메인의 언어(사전 카드). ──
    function buildConcepts() {
        if (!concepts.length)
            return null;
        const CAP = 6;
        const sec = bfSection('wk-ch-concepts', '핵심 개념', concepts.length, concepts.length > CAP ? seeAllBtn('concept') : null);
        sec.body.append(el('div', { class: 'wk-doccard-grid wk-concept-grid' }, ...concepts.slice(0, CAP).map((r) => wkDocCard(r, { open: (x, rEl) => openDoc(x, rEl), deckCap: 160, cls: 'concept' }))));
        return sec.el;
    }
    // ── 결정 기록 — 도메인의 스토리(월별 타임라인). ──
    function buildDecisions() {
        if (!decisions.length)
            return null;
        const CAP = 8;
        const sec = bfSection('wk-ch-decisions', '결정 기록', decisions.length, decisions.length > CAP ? seeAllBtn('decision') : null);
        const tl = el('div', { class: 'wk-timeline' });
        let curMonth = '';
        for (const d of decisions.slice(0, CAP)) {
            const dt = new Date(d.updated_at);
            const month = isNaN(dt.getTime()) ? '' : (dt.getFullYear() + '년 ' + (dt.getMonth() + 1) + '월');
            if (month && month !== curMonth) {
                curMonth = month;
                tl.append(el('div', { class: 'wk-tl-month', text: month }));
            }
            const deck = wkDeck(d.body_md || '', 110);
            const item = el('div', { class: 'wk-tl-item', role: 'link', tabindex: '0', title: d.title || d.name }, el('span', { class: 'wk-tl-dot', 'aria-hidden': 'true' }), el('div', { class: 'wk-tl-main' }, el('div', { class: 'wk-tl-title', text: d.title || d.name }), deck ? el('div', { class: 'wk-tl-deck', text: deck }) : null), el('span', { class: 'wk-row-m wk-tl-date', text: isNaN(dt.getTime()) ? '' : ((dt.getMonth() + 1) + '/' + dt.getDate()) }));
            const go = () => openDoc(d, item);
            item.addEventListener('click', go);
            item.addEventListener('keydown', (ev) => { if (ev.key === 'Enter')
                go(); });
            tl.append(item);
        }
        sec.body.append(tl);
        return sec.el;
    }
    // ── 런북·방법 — 손에 잡히는 실행(발췌 행). ──
    function buildRunbooks() {
        if (!howtos.length)
            return null;
        const CAP = 6;
        const sec = bfSection('wk-ch-runbooks', '런북 · 방법', howtos.length, howtos.length > CAP ? seeAllBtn('how-to') : null);
        for (const r of howtos.slice(0, CAP)) {
            sec.body.append(wkRow(r, { open: (x, rEl) => openDoc(x, rEl), deck: wkDeck(r.body_md || '', 100), metas: [relTime(r.updated_at)] }));
        }
        return sec.el;
    }
    // ── 챕터 바 — 대문의 목차(스크롤 스파이 + 점프). 챕터 2개 이상일 때만. ──
    function buildChapterBar(sections) {
        if (sections.length < 2)
            return null;
        const bar = el('nav', { class: 'wk-chbar', 'aria-label': '대문 목차' });
        const items = new Map();
        for (const s of sections) {
            const it = el('button', { class: 'wk-ch-it', type: 'button' }, el('span', { text: s.label }), s.count != null ? el('span', { class: 'wk-ch-count', text: String(s.count) }) : null);
            it.onclick = () => { const t = document.getElementById(s.id); if (t)
                t.scrollIntoView(smoothOpt); };
            items.set(s.id, it);
            bar.append(it);
        }
        if (typeof IntersectionObserver !== 'undefined') {
            const io = new IntersectionObserver((ents) => {
                for (const en of ents) {
                    const it = items.get(en.target.id);
                    if (!it)
                        continue;
                    if (en.isIntersecting) {
                        bar.querySelectorAll('.wk-ch-it.on').forEach((n) => n.classList.remove('on'));
                        it.classList.add('on');
                    }
                }
            }, { rootMargin: '-120px 0px -65% 0px' });
            setTimeout(() => { for (const s of sections) {
                const t = document.getElementById(s.id);
                if (t)
                    io.observe(t);
            } }, 0);
        }
        return bar;
    }
    // ── 조립 — 커버(상시) → 아이콘/제목/설명/액션 → 현황 라인 → 챕터 바 → 브리핑 → 전체 문서. ──
    const SPACE_KO2 = { business: '사업', product: '제품', system: '시스템' };
    const latestAt = allDocs.reduce((m, r) => (String(r.updated_at || '') > m ? String(r.updated_at) : m), '');
    const statsLine = el('div', { class: 'wk-cat-stats' }, ...[
        el('span', { class: 'wk-row-m', text: SPACE_KO2[cat.space] || cat.space || '' }),
        el('span', { class: 'wk-row-m', text: '문서 ' + allDocs.length }),
        decisions.length ? el('span', { class: 'wk-row-m', text: '결정 ' + decisions.length }) : null,
        topFolders.length ? el('span', { class: 'wk-row-m', text: '폴더 ' + topFolders.length }) : null,
        latestAt ? el('span', { class: 'wk-row-m', text: '최근 ' + relTime(latestAt) }) : null,
    ].filter(Boolean));
    library.id = 'wk-ch-docs';
    const inDrill = !!f.folder; // 폴더 드릴다운은 작업 모드 — 브리핑·챕터 바 생략(빵부스러기+폴더 내용만)
    const briefing = inDrill ? [] : [buildOverview(), buildCourse(), buildConcepts(), buildDecisions(), buildRunbooks()].filter(Boolean);
    const chapterDefs = inDrill ? [] : [
        briefing.find((s) => s.id === 'wk-ch-overview') ? { id: 'wk-ch-overview', label: '개요', count: null } : null,
        briefing.find((s) => s.id === 'wk-ch-course') ? { id: 'wk-ch-course', label: '처음이라면', count: null } : null,
        concepts.length ? { id: 'wk-ch-concepts', label: '개념', count: concepts.length } : null,
        decisions.length ? { id: 'wk-ch-decisions', label: '결정', count: decisions.length } : null,
        howtos.length ? { id: 'wk-ch-runbooks', label: '런북', count: howtos.length } : null,
        { id: 'wk-ch-docs', label: '전체 문서', count: allDocs.length },
    ].filter(Boolean);
    const chbar = inDrill ? null : buildChapterBar(chapterDefs);
    box.replaceChildren(el('div', { class: 'wk-cat wk-cat-v2 wk-cat-v3' }, cover, el('div', { class: 'wk-cat-inner' }, ...[
        iconBtn,
        el('div', { class: 'wk-cat-headrow' }, el('div', { class: 'wk-cat-headmain' }, titleEl, descEl), actions),
        statsLine,
        entrySlot,
        chbar,
        ...briefing,
        library,
    ].filter(Boolean))));
}
export { renderCategorySurface };
