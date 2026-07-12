// wiki-category.ts — #764v4 카테고리 대문. "하나의 원자(지식), 다섯 투영."
//  모든 구역은 카테고리 rows 1콜의 재가공이다(추가 API 0 — 최소 단위는 작성된 페이지):
//  ① 정체 — 커버(상시 오로라)·아이콘·이름·설명 + 정의 한 문장(cat.should 발췌) + mono 현황.
//  ② 입구 — 우측 레일 '먼저 읽기'(소개글 페이지 카드 순서 > 핀∪사람 저작, 읽음 진행률).
//  ③ 일 — 좌측 주인공 '일의 흐름': 사건 피드(스레드=#NNN 묶음 카드+서수 도트 레일+델타 연대기 /
//     정본 스택=개정판 접기 / 단신). 절대 시각은 제목 파싱 날짜가 있을 때만(updated_at 은 정렬 폴백만).
//  ④ 주제 — 점선 리더 색인(n≥40만) → 전체 문서에 주제 필터.
//  ⑤ 전체 — 서고(유형 카운트 + 발췌 행 목록).
//  규모 적응: 0건=초대 / 1~9건=목록 중심 단열 / 10~39건=색인 생략 / ≥40건=풀 구성.
import { api, el, errorNote, relTime, renderMarkdown, toast } from './core.js';
import { overlayBox, skeleton } from './learn.js';
import { hasScope } from './admin.js';
import { createBlockEditor } from './block-editor.js';
import { applyCoverBg, openCoverPicker, openEmojiPicker } from './page-decor.js';
import { HOME_EMPTY, KN_TYPE_LABEL, hasMemoryScope, homeDocName, isCategoryHomeDoc, knFetchCategoryRows, knFolderFirstSort, knInvalidateTreeCaches, openProjectChooser, wkTrackEditor, } from './wiki-data.js';
import { wkAurora, wkDeck, wkDocCard, wkEmpty, wkIsRead, wkRow, wkSection, wkTick } from './wiki-ui.js';
import { mineEvents, mineThemes } from './wiki-mine.js';
import { openWikiPeek, setWikiPeekList } from './wiki-doc.js';
import { openCategoryForm } from './category-form.js'; // 정의·범위(should) 편집
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
    // 피크로 문서를 읽으면(wkMarkRead 는 진입 즉시 기록) 대문의 읽음 표식을 제자리 갱신 — 전체 repaint 없이
    //  '먼저 읽기' 진행률·번호 원 ✓·델타 연대기 '읽음' 뱃지만 다시 칠한다(펼침·스크롤 상태 보존).
    function syncReadState() {
        const items = box.querySelectorAll('.wk-c4-it[data-nm]');
        let readN = 0;
        items.forEach((it) => {
            const read = wkIsRead(it.getAttribute('data-nm'));
            if (read)
                readN++;
            it.classList.toggle('read', read);
            const num = it.querySelector('.wk-c4-num');
            if (num && read)
                num.textContent = '✓';
        });
        const prog = box.querySelector('.wk-rail-prog');
        if (prog && items.length) {
            prog.textContent = readN + '/' + items.length;
            prog.classList.toggle('done', readN === items.length);
        }
        box.querySelectorAll('.wk-ev-kid[data-nm]').forEach((kid) => {
            const read = wkIsRead(kid.getAttribute('data-nm'));
            kid.classList.toggle('read', read);
            if (read && !kid.querySelector('.wk-ev-kid-read'))
                kid.append(el('span', { class: 'wk-row-m wk-ev-kid-read', text: '읽음' }));
        });
    }
    const openDoc = (e, rowEl) => {
        if (e.is_folder) {
            f.folder = e.name;
            ctx.syncHash();
            ctx.repaint();
            return;
        }
        openWikiPeek(e.name, { onRefresh: refresh, onClose: syncReadState, originEl: rowEl });
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
    const saveChip = el('span', { class: 'wk-save-chip', 'aria-live': 'polite' }); // '팀의 소개' 라벨 옆에 부착(v4)
    const actions = el('div', { class: 'wk-cat-actions' });
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
        if (canCat)
            pop.append(item('✎ 정의·범위 편집', () => openCategoryForm(cat.space, cat, () => { ctx.onCatChanged(); ctx.repaint(); })));
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
    // 주제 색인 → 서고 필터(세션 내 일시 상태 — URL 미반영). paintLibrary 최초 호출 전에 선언(TDZ).
    let topicFilter = null;
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
                // 드릴 탈출 = 대문으로 복귀. paintLibrary 만으론 v4 구역(정의·피드·레일·색인)이 안 살아나므로 전체 재조립.
                onclick: () => { f.folder = ''; ctx.syncHash(); ctx.repaint(); } }));
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
        // 문서 목록 — 최신순. 주제 색인에서 온 필터가 있으면 그 멤버만.
        const list = allDocs.filter((r) => (!f.type || r.type === f.type) && (!topicFilter || topicFilter.names.has(r.name)))
            .slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
        const secActions = [];
        if (!sel.mode)
            secActions.push(el('button', { class: 'wk-sec-act', type: 'button', text: '선택',
                title: '여러 문서를 골라 프로젝트 연결·삭제', onclick: () => { sel.mode = true; paintLibrary(); } }));
        const sec = wkSection('문서', { count: list.length, actions: secActions });
        if (!list.length)
            sec.body.append(wkEmpty(topicFilter ? '이 주제의 문서가 없어요.' : f.type ? '이 유형의 문서가 없어요.' : '문서가 없어요.'));
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
        // 주제 필터 크럼 — 색인에서 온 조종간(해제 ×).
        const topicCrumb = topicFilter ? el('div', { class: 'wk-topic-crumb' }, el('span', { class: 'wk-row-m', text: '주제' }), el('span', { class: 'wk-topic-crumb-name', text: '「' + topicFilter.label + '」' }), el('button', { class: 'wk-topic-crumb-x', type: 'button', 'aria-label': '주제 필터 해제', title: '주제 필터 해제', text: '×',
            onclick: () => { topicFilter = null; paintLibrary(); } })) : null;
        const wrap = el('div', { class: 'wk-doclist-wrap' }, ...[topicCrumb, typeRow, sec.el].filter(Boolean));
        library.append(wrap);
    }
    paintLibrary();
    // ════════ #764v4 — 다섯 투영. 전부 rows 1콜 재가공(추가 API 0), 최소 단위 = 지식 페이지. ════════
    const byName = new Map(rows.map((r) => [r.name, r]));
    const smoothOpt = matchMedia('(prefers-reduced-motion: reduce)').matches ? { block: 'start' } : { behavior: 'smooth', block: 'start' };
    const events = mineEvents(allDocs);
    const themes = mineThemes(allDocs, cat.name || cat.key, { minDocs: 40 });
    const threadsN = events.filter((e) => e.kind === 'thread').length;
    const liveN = events.filter((e) => e.live).length;
    // 절대 시각 표기 — **제목에서 파싱된 날짜가 있을 때만**(패널 심사의 공통 안전 규칙: updated_at 은
    //  전부 최근 뭉침·시스템 어림이라 절대 위치를 주장하면 거짓 정밀도가 된다. 정렬 폴백으로만 쓴다).
    function fmtDay(iso) {
        if (!iso)
            return '';
        const [y, m, d] = iso.split('-').map((x) => parseInt(x, 10));
        return (y !== new Date().getFullYear() ? (y % 100) + '.' : '') + m + '.' + d;
    }
    // 섹션 골격 — 챕터 앵커(id) + 큼직한 제목(v3 bf 문법 유지).
    function bfSection(id, title, count, ...actions2) {
        const head = el('div', { class: 'wk-bf-head' }, el('h2', { class: 'wk-bf-title', text: title }), count != null ? el('span', { class: 'wk-bf-count', text: String(count) }) : null, el('span', { class: 'wk-sec-sp' }), ...actions2.filter(Boolean));
        const body = el('div', { class: 'wk-bf-body' });
        return { el: el('section', { class: 'wk-bf-sec', id }, head, body), body };
    }
    // ── 투영 1 · 정의 한 문장 — cat.should 첫 문장 발췌(신규 입사자가 제일 먼저 읽는 문장) + 전문 펼침. ──
    //  설명(desc)과 겹치면 문장은 생략하고 '정의·범위 전문 ▾' 토글만 남긴다(같은 말 두 번 방지).
    function buildDef() {
        const shouldTxt = String(cat.should || '').trim();
        if (!shouldTxt)
            return null;
        const plain = wkDeck(shouldTxt, 400) || shouldTxt.replace(/\s+/g, ' ').slice(0, 400);
        const m = plain.match(/^(.{10,160}?(?:다|요|것|함|음)\.)(?:\s|$)/);
        const first = m ? m[1] : (plain.slice(0, 140) + (plain.length > 140 ? '…' : ''));
        const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[.·,]/g, '');
        const dn = norm(cat.description);
        const fn = norm(first);
        const redundant = !!dn && !!fn && (dn.startsWith(fn.slice(0, 14)) || fn.startsWith(dn.slice(0, 14)));
        const full = el('div', { class: 'md-rendered wk-def-full', hidden: true }, renderMarkdown(shouldTxt));
        const moreBtn = el('button', { class: 'wk-def-more', type: 'button', title: '정의·범위·규칙 전문', text: redundant ? '정의·범위 ▾' : '전문 ▾' });
        const collapsedLbl = redundant ? '정의·범위 ▾' : '전문 ▾';
        moreBtn.onclick = () => { full.hidden = !full.hidden; moreBtn.textContent = full.hidden ? collapsedLbl : '접기 ▴'; };
        const editBtn = canCat ? el('button', { class: 'wk-def-more', type: 'button', title: '정의·범위·규칙(should) 편집', text: '✎',
            onclick: () => openCategoryForm(cat.space, cat, () => { ctx.onCatChanged(); ctx.repaint(); }) }) : null;
        return el('div', { class: 'wk-cat-def' + (redundant ? ' compact' : '') }, el('div', { class: 'wk-def-line' }, ...(redundant
            ? [moreBtn, editBtn]
            : [el('span', { class: 'wk-def-dash', 'aria-hidden': 'true', text: '—' }),
                el('span', { class: 'wk-def-text', text: first }), moreBtn, editBtn]).filter(Boolean)), full);
    }
    // ── 투영 3 · 일의 흐름 — 사건 피드. 스레드 = 카드(서수 도트 레일: 개수·순서·최근성만 주장 —
    //  등간격이라 시간 간격을 주장하지 않는 정직한 인코딩), 정본 = 개정판 스택, 단신 = 발췌 행. ──
    function railDots(n, live) {
        const rail = el('span', { class: 'wk-ev-rail', 'aria-hidden': 'true' });
        const dot = (cls = '') => el('i', { class: 'wk-ev-dot' + cls });
        if (n <= 8) {
            for (let i = 0; i < n - 1; i++)
                rail.append(dot());
        }
        else {
            rail.append(dot(), dot(), el('span', { class: 'wk-ev-gap', text: '‥' + (n - 7) }), dot(), dot(), dot(), dot());
        }
        rail.append(dot(' last' + (live ? ' live' : '')));
        return rail;
    }
    function threadCard(ev) {
        const kids = el('div', { class: 'wk-ev-kids', hidden: true }); // 자식이 role=link 라 role=list 부적합(빈 목록 안내됨)
        let filled = false;
        const head = el('button', { class: 'wk-ev-head', type: 'button', 'aria-expanded': 'false' }, el('span', { class: 'wk-ev-title', text: ev.label }), el('span', { class: 'wk-ev-no', text: ev.id }), railDots(ev.docs.length, ev.live), el('span', { class: 'wk-ev-tw', 'aria-hidden': 'true', text: '▸' }));
        const period = (ev.dateMin && ev.dateMax && ev.dateMin !== ev.dateMax)
            ? fmtDay(ev.dateMin) + ' → ' + fmtDay(ev.dateMax) : (ev.dateMax ? fmtDay(ev.dateMax) : '');
        const meta = el('div', { class: 'wk-ev-meta' }, ...[
            el('span', { class: 'wk-row-m', text: '문서 ' + ev.docs.length }),
            period ? el('span', { class: 'wk-row-m', text: period }) : null,
            ev.live ? el('span', { class: 'wk-row-m wk-ev-livelbl', text: '진행 중' }) : null,
        ].filter(Boolean));
        const lk = ev.kids[0];
        const latest = el('button', { class: 'wk-ev-latest', type: 'button', title: lk.doc.title || lk.doc.name }, el('span', { class: 'wk-ev-latestlbl', text: '최신' }), el('span', { class: 'wk-ev-latesttxt', text: lk.delta }));
        latest.onclick = (e2) => { e2.stopPropagation(); openDoc(lk.doc, latest); };
        const card = el('article', { class: 'wk-ev wk-ev-thread' + (ev.live ? ' live' : '') }, head, meta, latest, kids);
        head.onclick = () => {
            const open = kids.hidden;
            if (open && !filled) {
                filled = true;
                // 델타 연대기 — 위에서부터 '지금 → 과거'(최신 제목 = 스레드의 현재 상태).
                const hasDates = ev.kids.some((k2) => k2.date); // 날짜가 전무하면 컬럼 자체 생략
                for (const k of ev.kids) {
                    const read = wkIsRead(k.doc.name);
                    const kid = el('div', { class: 'wk-ev-kid' + (read ? ' read' : ''), role: 'link', tabindex: '0', 'data-nm': k.doc.name, title: k.doc.title || k.doc.name }, hasDates ? el('span', { class: 'wk-ev-kid-date wk-row-m', text: k.date ? fmtDay(k.date) : '' }) : null, wkTick(k.doc), el('span', { class: 'wk-ev-kid-delta', text: k.delta }), read ? el('span', { class: 'wk-row-m wk-ev-kid-read', text: '읽음' }) : null);
                    const go = () => openDoc(k.doc, kid);
                    kid.addEventListener('click', go);
                    kid.addEventListener('keydown', (ev2) => { if (ev2.key === 'Enter')
                        go(); });
                    kids.append(kid);
                }
            }
            kids.hidden = !open;
            head.setAttribute('aria-expanded', String(open));
            card.classList.toggle('open', open);
        };
        return card;
    }
    function canonCard(ev) {
        const cur = ev.docs[0];
        const olds = ev.docs.slice(1);
        const deck = wkDeck(cur.body_md || '', 110);
        const kids = el('div', { class: 'wk-ev-kids wk-canon-old', hidden: true });
        let filled = false;
        const toggle = el('button', { class: 'wk-ev-toggle', type: 'button', text: '이전 판 ' + olds.length + ' ▾' });
        toggle.onclick = (e2) => {
            e2.stopPropagation();
            if (kids.hidden && !filled) {
                filled = true;
                for (const o of olds)
                    kids.append(wkRow(o, { open: openDoc, metas: [relTime(o.updated_at)] }));
            }
            kids.hidden = !kids.hidden;
            toggle.textContent = '이전 판 ' + olds.length + (kids.hidden ? ' ▾' : ' ▴');
        };
        const card = el('article', { class: 'wk-ev wk-ev-canon', role: 'link', tabindex: '0', title: cur.title || cur.name }, el('div', { class: 'wk-ev-canonhead' }, el('span', { class: 'wk-canon-badge', text: '정본' }), el('span', { class: 'wk-ev-title', text: ev.label })), deck ? el('p', { class: 'wk-ev-deck', text: deck }) : null, el('div', { class: 'wk-ev-meta' }, el('span', { class: 'wk-row-m', text: '개정 ' + ev.docs.length + '판' }), ev.dateMax ? el('span', { class: 'wk-row-m', text: fmtDay(ev.dateMax) }) : null, toggle), kids);
        card.addEventListener('click', (e2) => { if (!kids.contains(e2.target) && e2.target !== toggle)
            openDoc(cur, card); });
        // 카드 자체가 포커스 대상일 때만 — 내부 토글·이전 판 행에서 버블된 Enter 가 정본을 덮어 열지 않게.
        card.addEventListener('keydown', (ev2) => { if (ev2.key === 'Enter' && ev2.target === card)
            openDoc(cur, card); });
        return card;
    }
    // 단신 = 사건 1건. 스레드·정본과 같은 카드 셸(.wk-ev)을 써 피드 리듬을 하나로(들쭉날쭉 제거).
    function briefCard(ev) {
        const x = ev.docs[0];
        const deck = wkDeck(x.body_md || '', 120);
        const card = el('article', { class: 'wk-ev wk-ev-brief' + (ev.live ? ' live' : ''), role: 'link', tabindex: '0', 'data-nm': x.name, title: x.title || x.name }, el('div', { class: 'wk-ev-head' }, wkTick(x), el('span', { class: 'wk-ev-title', text: x.title || x.name })), deck ? el('p', { class: 'wk-ev-deck', text: deck }) : null, el('div', { class: 'wk-ev-meta' }, ...[
            x.is_wiki ? el('span', { class: 'wk-row-m', text: '인덱스' }) : null,
            x.type ? el('span', { class: 'wk-row-m', text: KN_TYPE_LABEL[x.type] || x.type }) : null,
            el('span', { class: 'wk-row-m', text: ev.dateMax ? fmtDay(ev.dateMax) : relTime(x.updated_at) }),
            ev.live ? el('span', { class: 'wk-row-m wk-ev-livelbl', text: '진행 중' }) : null,
        ].filter(Boolean)));
        const go = () => openDoc(x, card);
        card.addEventListener('click', go);
        card.addEventListener('keydown', (e2) => { if (e2.key === 'Enter' && e2.target === card)
            go(); });
        return card;
    }
    function renderEvent(ev) {
        if (ev.kind === 'thread')
            return threadCard(ev);
        if (ev.kind === 'canon')
            return canonCard(ev);
        return briefCard(ev);
    }
    function buildFeed() {
        if (!events.length)
            return null;
        const sec = bfSection('wk-ch-now', '일의 흐름', events.length, liveN ? el('span', { class: 'wk-feed-live', text: '지금 움직임 ' + liveN }) : null);
        const INITIAL = 8, MORE = 32;
        const feed = el('div', { class: 'wk-feed' }, ...events.slice(0, INITIAL).map(renderEvent));
        sec.body.append(feed);
        if (events.length > INITIAL) {
            const moreBtn = el('button', { class: 'wk-feed-more', type: 'button', text: '지난 일 ' + (events.length - INITIAL) + '건 더 보기 ▾' });
            moreBtn.onclick = () => {
                feed.append(...events.slice(INITIAL, INITIAL + MORE).map(renderEvent));
                moreBtn.remove();
                if (events.length > INITIAL + MORE)
                    sec.body.append(el('div', { class: 'wk-feed-note',
                        text: '나머지 ' + (events.length - INITIAL - MORE) + '건은 아래 전체 문서에서 이어져요.' }));
            };
            sec.body.append(moreBtn);
        }
        return sec.el;
    }
    // ── 투영 2 · 먼저 읽기 — 소개글 페이지 카드 순서(큐레이션 = 글쓰기) > 핀 ∪ 사람 저작(실측상
    //  유일하게 신뢰 가능한 앵커 풀). 읽음(기기 로컬) 진행률. ──
    function firstReadDocs() {
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
            return { docs: picked, curated: true };
        const byUpdatedDesc = (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
        const auto = [];
        const push = (r) => { if (r && !auto.includes(r) && auto.length < 5)
            auto.push(r); };
        allDocs.filter((r) => r.is_wiki).sort(byUpdatedDesc).forEach(push);
        allDocs.filter((r) => r.confidence === 'human').sort(byUpdatedDesc).forEach(push);
        return { docs: auto, curated: false };
    }
    function introBlock(cls = '') {
        if (!canDoc && !hasContent)
            return null;
        return el('div', { class: 'wk-rail-sec wk-rail-intro' + (cls ? ' ' + cls : '') }, el('div', { class: 'wk-rail-label' }, el('span', { text: '팀의 소개' }), saveChip), curation);
    }
    // 팀이 직접 쓴 소개가 '리치'(헤딩·페이지 카드·목록·긴 글)면 그게 곧 읽기 가이드 — 자동 '먼저 읽기'는
    //  같은 문서를 두 번 세우는 중복이라 접고, 소개에 레일을 내준다. 빈/짧은 카테고리에서만 자동 앵커.
    const curationRich = (() => {
        const cb = homeBody();
        return cb.length > 140 || /\]\(#\/k\/|\[\[[^\]]/.test(cb)
            || /(^|\n)\s{0,3}#{1,3}\s/.test(cb) || /(^|\n)\s*[-*]\s+\S/.test(cb);
    })();
    function buildRail() {
        const rail = el('aside', { class: 'wk-v4-rail' });
        const fr = curationRich ? { docs: [], curated: false } : firstReadDocs();
        if (fr.docs.length >= 2) {
            const readN = fr.docs.filter((d) => wkIsRead(d.name)).length;
            const blk = el('div', { class: 'wk-rail-sec' }, el('div', { class: 'wk-rail-label' }, el('span', { text: '먼저 읽기' }), el('span', { class: 'wk-rail-prog' + (readN === fr.docs.length ? ' done' : ''), text: readN + '/' + fr.docs.length })));
            fr.docs.forEach((d, i) => {
                const read = wkIsRead(d.name);
                const it = el('div', { class: 'wk-c4-it' + (read ? ' read' : ''), role: 'link', tabindex: '0', 'data-nm': d.name, title: d.title || d.name }, el('span', { class: 'wk-c4-num', 'aria-hidden': 'true', text: read ? '✓' : String(i + 1) }), el('span', { class: 'wk-c4-title', text: d.title || d.name }));
                const go = () => openDoc(d, it);
                it.addEventListener('click', go);
                it.addEventListener('keydown', (ev2) => { if (ev2.key === 'Enter')
                    go(); });
                blk.append(it);
            });
            if (!fr.curated && canDoc)
                blk.append(el('div', { class: 'wk-rail-hint', text: '소개글에 페이지 카드([[)를 넣으면 이 순서를 직접 짤 수 있어요.' }));
            rail.append(blk);
        }
        const intro = introBlock();
        if (intro)
            rail.append(intro);
        return rail.childElementCount ? rail : null;
    }
    // ── 투영 4 · 주제 색인 — 점선 리더(신문 목차 문법: 주제→규모→진입 한 행). n≥40 만. ──
    function setTopic(label, names) {
        topicFilter = { label, names };
        paintLibrary();
        const t = document.getElementById('wk-ch-docs');
        if (t)
            t.scrollIntoView(smoothOpt);
    }
    function buildIndex() {
        if (!themes.length)
            return null;
        const covered = themes.coveredNames || new Set();
        const uncov = allDocs.filter((r) => !covered.has(r.name));
        const pct = Math.round(covered.size / Math.max(1, allDocs.length) * 100);
        const sec = bfSection('wk-ch-index', '주제', null, el('span', { class: 'wk-index-note', text: '제목 기준 자동 분류 · 커버 ' + pct + '%' }));
        const grid = el('div', { class: 'wk-index' });
        const idxRow = (label, names, extraCls = '') => {
            const row = el('button', { class: 'wk-index-row' + extraCls, type: 'button', title: '「' + label + '」 문서만 보기' }, el('span', { class: 'wk-index-topic', text: label }), el('span', { class: 'wk-index-dots', 'aria-hidden': 'true' }), el('span', { class: 'wk-index-n', text: String(names.size) }));
            row.onclick = () => setTopic(label, names);
            return row;
        };
        for (const g of themes)
            grid.append(idxRow(g.label, new Set(g.docs.map((d) => d.name))));
        if (uncov.length)
            grid.append(idxRow('그 외', new Set(uncov.map((d) => d.name)), ' etc'));
        sec.body.append(grid);
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
    // ── 조립 — 통일 뼈대: 문서가 1건이라도 있으면 모든 카테고리가 같은 구조를 쓴다(규모로 레이아웃을
    //  갈아엎지 않는다 — 적으면 그 구역만 조용히 비거나 빠진다). 커버→정의→현황→챕터바→
    //  [일의 흐름 · 먼저읽기/소개]→주제(n≥40)→서고. 드릴다운=작업 모드, 0건=초대. ──
    const SPACE_KO2 = { business: '사업', product: '제품', system: '시스템' };
    const latestAt = allDocs.reduce((m, r) => (String(r.updated_at || '') > m ? String(r.updated_at) : m), '');
    const statsLine = el('div', { class: 'wk-cat-stats' }, ...[
        el('span', { class: 'wk-row-m', text: SPACE_KO2[cat.space] || cat.space || '' }),
        el('span', { class: 'wk-row-m', text: '문서 ' + allDocs.length }),
        threadsN ? el('span', { class: 'wk-row-m', text: '스레드 ' + threadsN }) : null,
        liveN ? el('span', { class: 'wk-row-m wk-stats-live', text: '진행 중 ' + liveN }) : null,
        topFolders.length ? el('span', { class: 'wk-row-m', text: '폴더 ' + topFolders.length }) : null,
        latestAt ? el('span', { class: 'wk-row-m', text: '최근 ' + relTime(latestAt) }) : null,
    ].filter(Boolean));
    library.id = 'wk-ch-docs';
    const inDrill = !!f.folder; // 폴더 드릴다운은 작업 모드 — 대문 구역 생략(빵부스러기+폴더 내용만)
    const populated = !inDrill && allDocs.length > 0;
    const defRow = inDrill ? null : buildDef();
    const feedSec = populated ? buildFeed() : null;
    const railEl = populated ? buildRail() : null;
    const indexSec = populated ? buildIndex() : null; // buildIndex 내부에서 n≥40 게이트 — 없으면 조용히 빠짐
    // 서고(전체 문서)는 피드가 다 담지 못할 때만 = 아카이브: 스레드로 묶여 숨은 문서가 있거나 · 폴더가 있거나 ·
    //  양이 많을 때(>24). 소형 평면 카테고리(피드가 곧 전부)에서는 같은 목록 두 번을 피한다.
    const showLibrary = inDrill || !populated || topFolders.length > 0
        || allDocs.length > events.length || allDocs.length > 24 || !!f.type || !!topicFilter;
    const chapterDefs = (populated ? [
        feedSec ? { id: 'wk-ch-now', label: '일의 흐름', count: events.length } : null,
        indexSec ? { id: 'wk-ch-index', label: '주제', count: themes.length } : null,
        showLibrary ? { id: 'wk-ch-docs', label: '전체 문서', count: allDocs.length } : null,
    ].filter(Boolean) : []);
    const chbar = populated ? buildChapterBar(chapterDefs) : null;
    // 중앙부 — 항상 2열(좌 일의 흐름 + 우 레일). 레일이 비면(권한·풀 부재) 피드 전폭. 0건은 초대만.
    const mid = populated
        ? (railEl ? el('div', { class: 'wk-v4-grid' }, el('div', { class: 'wk-v4-main' }, ...[feedSec].filter(Boolean)), railEl)
            : feedSec)
        : (inDrill ? null : introBlock('wide'));
    box.replaceChildren(el('div', { class: 'wk-cat wk-cat-v2 wk-cat-v4' }, cover, el('div', { class: 'wk-cat-inner' }, ...[
        iconBtn,
        el('div', { class: 'wk-cat-headrow' }, el('div', { class: 'wk-cat-headmain' }, titleEl, descEl), actions),
        defRow,
        statsLine,
        entrySlot,
        chbar,
        mid,
        indexSec,
        showLibrary ? library : null,
    ].filter(Boolean))));
}
export { renderCategorySurface };
