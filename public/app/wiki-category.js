// wiki-category.ts — #764v6 카테고리 대문 = "대문 빌더".
//  고정 레이아웃을 강요하지 않는다 — 사용자가 지식 블록을 얹고·옮기고·바꿔서 직접 짜는 캔버스.
//  블록: intro(자유 소개글)·heading·rule·highlight(핀/고른 큰 카드)·list(조건 목록)·gallery(커버 카드)·stat(구성 현황).
//  모든 지식 블록은 카테고리 rows(allDocs)를 cfg(유형·사람저작·고정·최신 + 개수)로 질의한다 —
//  제목 형식과 무관하게 어떤 지식이든 동일하게 흘러든다(범용). 추가 API 0.
//  레이아웃(블록 배열)은 대문 문서(category-home-*)의 body_md 에 JSON 으로 저장(props-ui 는 icon/cover 화이트리스트).
//  읽기 모드 = 완성된 대문 · 편집 모드 = 커스터마이즈(드래그·⚙조건·크기·삭제·＋블록).
import { api, el, errorNote, relTime, toast } from './core.js';
import { overlayBox, skeleton } from './learn.js';
import { hasScope } from './admin.js';
import { applyCoverBg, openCoverPicker, openEmojiPicker } from './page-decor.js';
import { HOME_EMPTY, KN_TYPE_LABEL, hasMemoryScope, homeDocName, isCategoryHomeDoc, knFetchCategoryRows, knFolderFirstSort, knInvalidateTreeCaches, openProjectChooser, } from './wiki-data.js';
import { wkAurora, wkDeck, wkDocCard, wkEmpty, wkRow, wkSection, wkTick } from './wiki-ui.js';
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
        // #837 — 카테고리 '정의·범위'의 편집 주인은 [관리 ▸ 카테고리(분류 체계)] 하나다(결정: 관리탭이 주인).
        //  여기서도 열 수 있게 두면 편집 표면이 둘이 되어 '어디서 바꾸지'가 매번 퀴즈가 된다 — 링크로 보낸다.
        //  (도메인맵 탭도 이미 같은 곳으로 링크만 건다.)
        if (canCat)
            pop.append(item('✎ 정의·범위 편집 ↗', () => { location.hash = '#/categories'; })); // #1153 관리탭 → 분류체계 탭
        if (canDoc)
            pop.append(item(sel.mode ? '선택 모드 끄기' : '☑ 여러 개 선택', () => { sel.mode = !sel.mode; if (!sel.mode)
                sel.names.clear(); paintLibrary(); }));
        document.body.append(pop);
        const r = moreBtn.getBoundingClientRect();
        pop.style.top = (r.bottom + 6) + 'px';
        pop.style.left = Math.max(8, r.right - 200) + 'px';
        setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
    };
    // (팀의 소개/엔트리 카드는 #764v6 에서 빌더의 'intro' 블록으로 흡수 — 대문 본문 body_md 는 이제 빌더 레이아웃 JSON.)
    // ── 라이브러리(전체 문서 관리) — 폴더 · 유형 카운트 · 문서 목록 · 선택. 빌더 캔버스 아래 상시. ──
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
    // ════════════════ #764v6 대문 빌더 — 지식 블록으로 짜는 커스텀 캔버스 ════════════════
    //  레이아웃 = 블록 배열. 대문 문서 body_md 에 JSON 으로 저장. 읽기/편집 모드.
    let editing = false;
    let blkSeq = 1;
    const canvas = el('div', { class: 'wk-bld-canvas' });
    const SRC_OPTS = [
        ['pin', '고정(핀)한 문서'], ['human', '사람이 쓴 문서'], ['recent', '전체(최신순)'],
        ['decision', '결정'], ['reference', '참조·규칙'], ['how-to', '런북'], ['research', '리서치'], ['concept', '개념'],
    ];
    const SRC_LABEL = {
        pin: '먼저 볼 것', human: '사람이 쓴 것', recent: '최근 문서',
        decision: '결정', reference: '참조·규칙', 'how-to': '런북', research: '리서치', concept: '개념',
    };
    function normBlock(b) {
        return {
            id: b.id || ('b' + (blkSeq++)), type: b.type, w: b.w === 'half' ? 'half' : 'full',
            cfg: Object.assign({ src: 'recent', limit: 5 }, b.cfg || {}), text: typeof b.text === 'string' ? b.text : '',
        };
    }
    //  레이아웃 로드 — body_md 가 '[...]' JSON 이면 그 배열, 아니면(기존 큐레이션·빈) 기본 레이아웃.
    function loadLayout() {
        const raw = homeBody().trim();
        if (raw && raw[0] === '[') {
            try {
                const p = JSON.parse(raw);
                if (Array.isArray(p) && p.length && p.every((b) => b && b.type))
                    return p.map(normBlock);
            }
            catch (_) { /* JSON 아님 → 기본 */ }
        }
        return defaultLayout(raw);
    }
    //  기본 레이아웃 — (기존 큐레이션 있으면 소개로 보존) + 핀 하이라이트 + 상위 2유형 목록 + 갤러리.
    //  설명(desc)은 헤더에 이미 있으므로 기본 소개 블록은 넣지 않는다(중복 방지) — 팀이 원하면 ＋로 추가.
    function defaultLayout(existing) {
        const L = [];
        const seed = existing && existing[0] !== '[' ? wkDeck(existing, 480) : '';
        // 의미 있는 큐레이션만 소개로 보존 — '#' 같은 마크다운 부호 잔재는 버린다(빈/쓰레기 소개 방지).
        if (seed && seed.replace(/[#*_>·\-\s]/g, '').length >= 12)
            L.push(normBlock({ type: 'intro', text: seed }));
        if (allDocs.some((r) => r.is_wiki))
            L.push(normBlock({ type: 'highlight', cfg: { src: 'pin', limit: 3 } }));
        const counts = new Map();
        for (const r of allDocs)
            if (r.type)
                counts.set(r.type, (counts.get(r.type) || 0) + 1);
        //  유형 목록 — ≥3건인 유형만(1~2건짜리 약한 목록 방지). 하나뿐이면 전폭, 둘이면 반폭씩.
        const bigTypes = Array.from(counts.entries()).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 2);
        bigTypes.forEach(([t]) => L.push(normBlock({ type: 'list', w: bigTypes.length > 1 ? 'half' : 'full', cfg: { src: t, limit: 5 } })));
        if (allDocs.length)
            L.push(normBlock({ type: 'gallery', cfg: { src: 'recent', limit: 6 } }));
        return L; // 비면 [] — 캔버스가 '첫 페이지' 초대를 띄운다(빈 소개 블록 방지)
    }
    let blocks = loadLayout();
    // 저장 — body_md 에 블록 JSON. 디바운스. (#764 큐레이션 보호)
    //  savedBaseline 과 다를 때만 실제 저장 — 편집모드 토글만 하거나 blur 만 나도 저장되던 파괴 버그 차단.
    //  rawWasMarkdown: 원본이 손수 쓴 글이면 첫 편집 진입 시 1회 확인(블록 저장이 원문 서식을 대체하므로).
    const serializeBlocks = (bs) => JSON.stringify(bs.map((b) => ({ type: b.type, w: b.w, cfg: b.cfg, text: b.text })));
    let savedBaseline = serializeBlocks(blocks);
    const rawWasMarkdown = (() => { const raw = homeBody().trim(); return !!raw && raw[0] !== '['; })();
    let mdConvertConfirmed = !rawWasMarkdown;
    let saveTimer = null;
    let builderFirstEditAt = 0;
    const setChip = (t, busy) => { saveChip.textContent = t; saveChip.classList.toggle('busy', !!busy); };
    async function doSaveLayout() {
        const cur = serializeBlocks(blocks);
        if (cur === savedBaseline) {
            builderFirstEditAt = 0;
            return;
        } // 변경 없음 — body_md(기존 큐레이션 포함) 보존
        setChip('저장 중…', true);
        try {
            await ensureHome(cur);
            savedBaseline = cur;
            builderFirstEditAt = 0;
            setChip('저장됨'); // 상시 유지
        }
        catch (e) {
            setChip('저장 안 됨', true);
            toast('대문 저장 실패 — ' + e.message, true);
        }
    }
    //  실시간 저장 리듬 — 600ms 디바운스 + 최초 편집 후 4s maxWait 강제 flush.
    function scheduleSave() {
        if (!canDoc)
            return;
        if (!builderFirstEditAt)
            builderFirstEditAt = Date.now();
        setChip('저장 중…', true);
        clearTimeout(saveTimer);
        const waited = Date.now() - builderFirstEditAt;
        if (waited >= 4000) {
            doSaveLayout();
            return;
        }
        saveTimer = setTimeout(doSaveLayout, Math.min(600, 4000 - waited));
    }
    // 질의 — allDocs 를 cfg 로. 어떤 지식이든 제목 형식 무관하게 흘러든다(범용).
    function queryDocs(cfg) {
        const src = cfg.src || 'recent';
        let d = allDocs.slice();
        if (src === 'pin')
            d = d.filter((r) => r.is_wiki);
        else if (src === 'human')
            d = d.filter((r) => r.confidence === 'human');
        else if (src !== 'recent' && src !== 'all')
            d = d.filter((r) => (r.type || '') === src);
        d.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
        return d.slice(0, Math.max(1, Math.min(24, +cfg.limit || 5)));
    }
    const blkTitle = (b) => (b.cfg && b.cfg.title) || (b.type === 'stat' ? '이 카테고리의 구성' : (SRC_LABEL[b.cfg.src] || '문서'));
    const cfgLabel = (c) => (SRC_LABEL[c.src] || '최신') + ' · ' + (c.limit || 5) + '건';
    const emptyBlk = () => el('div', { class: 'wk-bld-empty', text: editing ? '이 조건에 맞는 문서가 아직 없어요 — ⚙로 조건을 바꿔 보세요.' : '아직 문서가 없어요.' });
    // 목록 부제 — 산문 발췌(wkDeck)가 없으면 헤딩을 건너뛴 첫 내용 줄로 폴백. 모든 행이 부제를 갖게 해
    //  '있는 행/없는 행 높이가 달라 들쭉날쭉'을 없앤다(발췌 있음/없음 무관 균일).
    function deckLine(md, cap) {
        const d = wkDeck(md || '', cap);
        if (d)
            return d;
        for (const raw of String(md || '').split('\n')) {
            const l = raw.trim();
            if (!l || l.startsWith('#') || l.startsWith('```') || l.startsWith(':::') || l.startsWith('|') || l.startsWith('!['))
                continue;
            const clean = l.replace(/^>\s*/, '').replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '')
                .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
            if (clean.length >= 4)
                return clean.slice(0, cap);
        }
        return '';
    }
    // 갤러리 카드 — 오로라 커버 + 제목(#764v2 시각 자산 재사용).
    function galCard(x) {
        const c = el('div', { class: 'wk-galc', role: 'link', tabindex: '0', title: x.title || x.name }, wkAurora(x.name, cat.space, { cls: 'wk-galc-cov', watermark: x.icon || '' }), el('div', { class: 'wk-galc-b' }, el('div', { class: 'wk-galc-t', text: x.title || x.name }), el('div', { class: 'wk-galc-m' }, wkTick(x), x.type ? el('span', { class: 'wk-row-m', text: KN_TYPE_LABEL[x.type] || x.type }) : null)));
        const go = () => openDoc(x, c);
        c.addEventListener('click', go);
        c.addEventListener('keydown', (e) => { if (e.key === 'Enter')
            go(); });
        return c;
    }
    function statBody() {
        const counts = new Map();
        for (const r of allDocs)
            counts.set(r.type || '기타', (counts.get(r.type || '기타') || 0) + 1);
        const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
        const total = allDocs.length || 1;
        const humanN = allDocs.filter((r) => r.confidence === 'human').length;
        return el('div', {}, el('div', { class: 'wk-stat-bar' }, ...entries.map(([t, n]) => el('span', { class: 'wk-stat-seg', 'data-ty': t, title: (KN_TYPE_LABEL[t] || t) + ' ' + n, style: 'width:' + (n / total * 100).toFixed(1) + '%' }))), el('div', { class: 'wk-stat-leg' }, ...[
            ...entries.map(([t, n]) => el('span', { class: 'wk-stat-li' }, el('i', { class: 'wk-stat-dot', 'data-ty': t }), el('span', { text: (KN_TYPE_LABEL[t] || t) + ' ' + n }))),
            humanN ? el('span', { class: 'wk-stat-li wk-stat-human', text: '사람저작 ' + humanN }) : null,
        ].filter(Boolean)));
    }
    // 블록 본문(읽기 형태 — 편집도 같은 본문, 위에 크롬만 얹음).
    function blockContent(b) {
        if (b.type === 'rule')
            return el('hr', { class: 'wk-bld-rule' });
        if (b.type === 'intro' || b.type === 'heading') {
            const ed = editing && canDoc;
            const node = el('div', { class: (b.type === 'heading' ? 'wk-bld-heading' : 'wk-bld-intro') + (ed ? ' ed' : ''),
                ...(ed ? { contenteditable: 'true', spellcheck: 'false', 'data-ph': b.type === 'heading' ? '소제목' : '이 카테고리가 무엇인지 팀의 말로…' } : {}) });
            node.textContent = b.text || '';
            // 실제로 바뀐 경우만 저장 — 포커스만 했다 빠져도(공백 정규화 차이) 저장되어 기존 큐레이션을 덮는 것 방지.
            if (ed)
                node.addEventListener('blur', () => { const t = (node.textContent || '').trim(); if (t !== (b.text || '').trim()) {
                    b.text = t;
                    scheduleSave();
                } });
            return node;
        }
        const head = el('div', { class: 'wk-bld-head' }, el('span', { class: 'wk-bld-title', text: blkTitle(b) }), el('span', { class: 'wk-bld-meta', text: b.type === 'stat' ? (allDocs.length + '건') : cfgLabel(b.cfg) }));
        let body;
        if (b.type === 'stat')
            body = statBody();
        else {
            const d = queryDocs(b.cfg);
            if (!d.length)
                body = emptyBlk();
            else if (b.type === 'highlight')
                body = el('div', { class: 'wk-bld-hl' }, ...d.slice(0, b.cfg.limit || 3).map((x) => wkDocCard(x, { open: openDoc, deckCap: 128, cls: 'wk-hlcard' })));
            else if (b.type === 'gallery')
                body = el('div', { class: 'wk-bld-gal' }, ...d.map(galCard));
            else {
                body = el('div', { class: 'wk-bld-list' });
                for (const x of d)
                    body.append(wkRow(x, { open: openDoc, deck: deckLine(x.body_md || '', 92), metas: [x.is_wiki ? '인덱스' : null, x.type ? (KN_TYPE_LABEL[x.type] || x.type) : null, relTime(x.updated_at)] }));
            }
        }
        return el('div', {}, head, body);
    }
    // 블록 DOM(편집 모드에서만 크롬·드래그).
    function blockEl(b, i) {
        const isText = b.type === 'intro' || b.type === 'heading' || b.type === 'rule';
        const wrap = el('div', { class: 'wk-blk' + (b.w === 'half' ? ' half' : '') + (isText ? ' text' : ''), 'data-i': String(i) });
        if (editing && canDoc) {
            wrap.setAttribute('draggable', 'true');
            wrap.append(el('span', { class: 'wk-blk-grip', 'aria-hidden': 'true', title: '끌어서 이동', text: '⠿' }));
            const chrome = el('div', { class: 'wk-blk-chrome' });
            const cbtn = (a, label, title, warn) => {
                const btn = el('button', { class: 'wk-blk-cbtn' + (warn ? ' warn' : ''), type: 'button', title, 'aria-label': title, text: label });
                btn.onclick = (e) => { e.stopPropagation(); blkAct(a, i, btn); };
                return btn;
            };
            if (!isText)
                chrome.append(cbtn('cfg', '⚙', '어떤 지식을 보일지'));
            chrome.append(cbtn('w', '⤢', '너비 바꾸기'), cbtn('up', '↑', '위로'), cbtn('down', '↓', '아래로'), cbtn('del', '✕', '삭제', true));
            wrap.append(chrome);
            wireBlkDrag(wrap, i);
        }
        wrap.append(blockContent(b));
        return wrap;
    }
    function addBtnEl(label) {
        const b = el('button', { class: 'wk-blk-add', type: 'button', text: label });
        b.onclick = openPalette;
        return b;
    }
    function renderCanvas() {
        canvas.replaceChildren();
        if (!blocks.length && !(editing && canDoc)) {
            if (!allDocs.length)
                canvas.append(wkEmpty('이 카테고리엔 아직 문서가 없어요. 첫 페이지로 시작해 보세요.', canDoc ? el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge/new?category=' + encodeURIComponent(cat.key), text: '＋ 첫 페이지' }) : null));
            else
                canvas.append(wkEmpty('대문이 비어 있어요.', canDoc ? addBtnEl('＋ 블록 추가') : null));
            return;
        }
        blocks.forEach((b, i) => canvas.append(blockEl(b, i)));
        if (editing && canDoc)
            canvas.append(el('div', { class: 'wk-blk-add-slot' }, addBtnEl('＋ 블록 추가')));
        const shown = [];
        canvas.querySelectorAll('[data-nm]').forEach((n) => { const nm = n.getAttribute('data-nm'); if (nm)
            shown.push(nm); });
        if (shown.length)
            setWikiPeekList(shown);
    }
    function blkAct(a, i, btn) {
        if (a === 'del') {
            blocks.splice(i, 1);
            renderCanvas();
            scheduleSave();
            return;
        }
        if (a === 'up' && i > 0) {
            const t = blocks[i - 1];
            blocks[i - 1] = blocks[i];
            blocks[i] = t;
            renderCanvas();
            scheduleSave();
            return;
        }
        if (a === 'down' && i < blocks.length - 1) {
            const t = blocks[i + 1];
            blocks[i + 1] = blocks[i];
            blocks[i] = t;
            renderCanvas();
            scheduleSave();
            return;
        }
        if (a === 'w') {
            blocks[i].w = blocks[i].w === 'half' ? 'full' : 'half';
            renderCanvas();
            scheduleSave();
            return;
        }
        if (a === 'cfg' && btn)
            openCfg(i, btn);
    }
    // 설정 팝오버 — 어떤 지식(src) + 개수.
    function openCfg(i, anchor) {
        document.querySelectorAll('.wk-blk-cfg').forEach((p) => (p._close ? p._close() : p.remove()));
        const b = blocks[i];
        const srcSel = el('select', { class: 'wk-cfg-sel' }, ...SRC_OPTS.map(([v, lab]) => el('option', { value: v, ...(b.cfg.src === v ? { selected: 'selected' } : {}), text: lab })));
        const limIn = el('input', { class: 'wk-cfg-num', type: 'number', min: '1', max: '24', value: String(b.cfg.limit || 5) });
        const pop = el('div', { class: 'wk-blk-cfg' }, el('div', { class: 'wk-cfg-h', text: '이 블록의 지식' }), el('label', { class: 'wk-cfg-l', text: '무엇을 보일까' }), srcSel, el('label', { class: 'wk-cfg-l', text: '몇 개' }), limIn);
        const close = () => { pop.remove(); document.removeEventListener('mousedown', onDoc, true); };
        pop._close = close;
        const onDoc = (ev) => { if (!pop.contains(ev.target) && ev.target !== anchor)
            close(); };
        srcSel.onchange = () => { b.cfg.src = srcSel.value; b.cfg.title = null; close(); renderCanvas(); scheduleSave(); };
        limIn.onchange = () => { b.cfg.limit = Math.max(1, Math.min(24, +limIn.value || 5)); close(); renderCanvas(); scheduleSave(); };
        document.body.append(pop);
        const r = anchor.getBoundingClientRect();
        pop.style.top = (r.bottom + 6 + window.scrollY) + 'px';
        pop.style.left = Math.max(8, r.right - 240) + 'px';
        setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
    }
    // 블록 추가 팔레트.
    const PALETTE = [
        { type: 'intro', ic: '✍', name: '소개 · 자유 글', desc: '팀의 말로 이 카테고리가 무엇인지 직접 씁니다.', text: '' },
        { type: 'highlight', ic: '◆', name: '핵심 하이라이트', desc: '고정하거나 고른 문서를 큰 카드로 — 본문 미리보기와 함께.', cfg: { src: 'pin', limit: 3 } },
        { type: 'list', ic: '≣', name: '문서 목록', desc: '조건(유형·사람저작·최신)에 맞는 지식을 목록으로.', w: 'half', cfg: { src: 'recent', limit: 5 } },
        { type: 'gallery', ic: '▦', name: '문서 갤러리', desc: '지식을 커버 카드 그리드로 — 시각적으로.', cfg: { src: 'recent', limit: 6 } },
        { type: 'stat', ic: '◧', name: '구성 현황', desc: '이 카테고리가 무엇으로 이뤄졌는지 한눈에.' },
        { type: 'heading', ic: 'H', name: '소제목', desc: '구역을 나누는 제목.', text: '' },
        { type: 'rule', ic: '—', name: '구분선', desc: '얇은 가로선으로 구분.' },
    ];
    function openPalette() {
        const grid = el('div', { class: 'wk-pal-grid' });
        const back = overlayBox('블록 추가', el('p', { class: 'wk-pal-note', text: '모든 블록은 이 카테고리의 지식에서 나옵니다. 조건은 나중에 ⚙로 바꿀 수 있어요.' }), grid);
        PALETTE.forEach((p) => {
            const card = el('button', { class: 'wk-pal-card', type: 'button' }, el('span', { class: 'wk-pal-ic', 'aria-hidden': 'true', text: p.ic }), el('b', { class: 'wk-pal-name', text: p.name }), el('span', { class: 'wk-pal-desc', text: p.desc }));
            card.onclick = () => {
                blocks.push(normBlock({ type: p.type, w: p.w || 'full', cfg: p.cfg, text: p.text || '' }));
                back.remove();
                renderCanvas();
                scheduleSave();
                const slot = canvas.querySelector('.wk-blk-add-slot');
                if (slot)
                    slot.scrollIntoView({ block: 'center' });
            };
            grid.append(card);
        });
    }
    // 블록 드래그 재배치 — 삽입 위치를 파란 선으로(포인터가 블록 상/하반부 어디냐로 앞/뒤 결정).
    let dragFrom = null;
    const clearDrop = () => canvas.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    function wireBlkDrag(elm, i) {
        elm.addEventListener('dragstart', (e) => { dragFrom = i; setTimeout(() => elm.classList.add('dragging'), 0); e.dataTransfer.effectAllowed = 'move'; });
        elm.addEventListener('dragend', () => { elm.classList.remove('dragging'); clearDrop(); dragFrom = null; });
        elm.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (dragFrom === null || dragFrom === i) {
                clearDrop();
                return;
            }
            const r = elm.getBoundingClientRect();
            const after = (e.clientY - r.top) > r.height / 2;
            clearDrop();
            elm.classList.add(after ? 'drop-after' : 'drop-before');
        });
        elm.addEventListener('drop', (e) => {
            e.preventDefault();
            if (dragFrom === null || dragFrom === i)
                return;
            let insertIdx = elm.classList.contains('drop-after') ? i + 1 : i;
            const m = blocks[dragFrom];
            blocks.splice(dragFrom, 1);
            if (dragFrom < insertIdx)
                insertIdx--;
            blocks.splice(Math.max(0, Math.min(blocks.length, insertIdx)), 0, m);
            clearDrop();
            dragFrom = null;
            renderCanvas();
            scheduleSave();
        });
    }
    // 편집/읽기 토글 — canDoc 만.
    const modeToggle = canDoc ? el('button', { class: 'wk-bld-mode btn btn-ghost btn-sm', type: 'button' }) : null;
    const editHint = el('div', { class: 'wk-bld-hint' }, el('span', { text: '✎ 편집 모드 — 블록을 끌어 옮기고, ⚙로 어떤 지식을 담을지 바꾸고, ⤢로 크기를, 아래 ＋로 새 블록을. 원하는 모양으로.' }));
    const inDrill = !!f.folder; // 폴더 드릴다운은 작업 모드 — 캔버스 생략(빵부스러기+폴더 내용만)
    library.id = 'wk-ch-docs';
    // 헤더 액션 순서: ＋ 새 페이지 · ✎ 편집 · (저장칩) · ⋯ — 편집을 ⋯ 앞으로.
    if (modeToggle)
        actions.insertBefore(modeToggle, moreBtn);
    actions.insertBefore(saveChip, moreBtn);
    // 전체 문서(관리) — 캔버스 아래 접이식(기본 접힘). 대문은 빌더가 주인공이고, 서고는 펼쳐 보는 아카이브.
    //  드릴다운(폴더 안)일 땐 이게 곧 작업 화면이므로 항상 펼침.
    let libOpen = inDrill;
    const libToggle = el('button', { class: 'wk-lib-toggle', type: 'button' });
    const libSec = el('section', { class: 'wk-lib-sec' });
    function paintLibSec() {
        if (inDrill) {
            libSec.replaceChildren(library);
            return;
        }
        libToggle.textContent = (libOpen ? '▾ ' : '▸ ') + '전체 문서 ' + allDocs.length;
        libSec.replaceChildren(...[libToggle, libOpen ? library : null].filter(Boolean));
    }
    libToggle.onclick = () => { libOpen = !libOpen; paintLibSec(); };
    paintLibSec();
    const root = el('div', { class: 'wk-cat wk-cat-v2 wk-cat-v6' }, cover, el('div', { class: 'wk-cat-inner' }, ...[
        iconBtn,
        el('div', { class: 'wk-cat-headrow' }, el('div', { class: 'wk-cat-headmain' }, titleEl, descEl), actions),
        inDrill ? null : editHint,
        inDrill ? null : canvas,
        libSec,
    ].filter(Boolean)));
    function paintMode() {
        if (modeToggle) {
            modeToggle.textContent = editing ? '✓ 완료' : '✎ 편집';
            modeToggle.classList.toggle('on', editing);
        }
        root.classList.toggle('editing', editing);
        canvas.classList.toggle('editing', editing);
    }
    if (modeToggle)
        modeToggle.onclick = () => {
            if (!editing) {
                // 편집 진입 — 손수 쓴 글로 작성된 대문이면 1회 확인(블록 저장이 원문 서식을 대체).
                if (!mdConvertConfirmed) {
                    if (!confirm('이 대문은 기존 서식(글)으로 작성돼 있어요.\n블록으로 편집해 저장하면 원래 서식이 블록 구조로 대체됩니다. 계속할까요?'))
                        return;
                    mdConvertConfirmed = true;
                }
                editing = true;
            }
            else {
                editing = false;
                clearTimeout(saveTimer);
                doSaveLayout(); // savedBaseline 과 다를 때만 실제 저장
            }
            paintMode();
            renderCanvas();
        };
    renderCanvas();
    paintMode();
    box.replaceChildren(root);
}
export { renderCategorySurface };
