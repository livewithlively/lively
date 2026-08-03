// projects/detail-folder.ts — #1405 W1: detail-sections.ts 분할 ②.
//  프로젝트 상세 ① '공유 폴더' 섹션 — 폴더 탐색 + 업로드(드롭·붙여넣기)/다운로드 + 검색 + 일괄삭제.
//  본문은 원문 그대로 옮겼다(verbatim).
import { api, el, errorNote, toast } from '../core.js';
import { overlayBox, skeletonRows } from '../learn.js';
import { UP_CONFIRM, UP_MANY, debounce, iconFor, openFolderGrid, openPasteDialog, projFileCardEl, projUpCardEl, upControl, upDropZone, upPrecheckOverwrite, upProgress, upSend, upToast } from './files.js';
// 새 프로젝트 오버레이 폼 — 이름(필수)·설명(선택)·팀원. 생성 시 폴더 자동 생성 + 새 전용 페이지로 이동.
// ── 상세 ① 공유 폴더 — 프로젝트 폴더 탐색 + 업로드/다운로드 + 검색. ──
//  shareBase = 이 프로젝트 폴더의 공유 워크스페이스 기준 경로(project.folder, 예 'project/1436').
//   프로젝트 폴더는 공유 루트의 한 경로라 홈 탐색기와 **같은 주소축**으로 링크를 만든다(#1436).
//   ⚠ id 로 'project/<id>' 를 추측하지 않는다 — 폴더명이 이름 기반인 프로젝트가 실재하고(project-fs.ts 주석),
//    완료 프로젝트는 legacy-project/ 로 옮겨진다. 서버가 준 folder 값만 믿는다.
function projectFolderSection(id, base, shareBase) {
    const B = base || '/api/ui/projects/';
    const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
    const body = el('div', {});
    const st = { path: '', q: '' };
    let lastData = null; // 마지막 서버 응답(업로드 중 그리드 즉시 재구성용)
    let lastFolderItems = []; // 현재 폴더(검색결과 아님) 목록 — 업로드 덮어쓰기 사전확인용(#877)
    const uploading = []; // 업로드 중 카드 [{ name, label, pct, pctEl, fill, nmEl }] — 폴더 업로드는 묶음 카드 1장
    const searchIn = el('input', { type: 'search', placeholder: '파일 검색…', class: 'proj-file-search' });
    searchIn.addEventListener('input', debounce(() => { st.q = searchIn.value.trim(); load(); }, 300));
    const up = upControl((items) => uploadFiles(items, []));
    const allBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '전체 보기', onclick: () => openFolderGrid(id, st.path, B, shareBase) });
    const mkdirBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 폴더', onclick: () => openMkdir() });
    // 선택(일괄삭제) 모드 — 카드 뷰에서 여러 항목을 골라 한 번에 삭제. ids = 선택된 rel(상대경로) 집합.
    const sel = { mode: false, ids: new Set() };
    let lastPairs = [];
    const selectBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '선택', title: '여러 항목을 골라 한 번에 삭제', onclick: () => toggleSelMode() });
    const selBar = el('div', { class: 'bulk-bar', hidden: true });
    const progBox = el('div', { class: 'up-prog-box' }); // 업로드 진행·취소 바(배치별 한 줄, #797). 그리드의 '업로드 중 카드'는 위치 표시로 그대로.
    card.append(el('div', { class: 'card-head' }, el('h3', { text: '공유 폴더' }), el('div', { class: 'card-head-actions' }, searchIn, allBtn, mkdirBtn, up.btn, selectBtn, up.fileIn, up.dirIn)));
    card.append(selBar);
    card.append(progBox);
    card.append(body);
    // 드래그앤드롭 업로드 — 카드 위로 파일·폴더를 끌어다 놓으면 현재 폴더에 올림(폴더는 하위 구조 그대로, #781).
    upDropZone(card, card, (items, emptyDirs) => uploadFiles(items, emptyDirs));
    // 클립보드 이미지 붙여넣기 — 프로젝트 상세에서 (텍스트 입력칸이 아닌 곳에) 붙여넣으면 현재 공유 폴더로 업로드.
    //  card 가 DOM 에서 사라지면(다른 화면 이동) 다음 paste 때 스스로 해제(언마운트 훅이 없어 누수 방지용 self-clean).
    const onPaste = (ev) => {
        if (!document.body.contains(card)) {
            document.removeEventListener('paste', onPaste);
            return;
        }
        const t = ev.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))
            return; // 텍스트 편집 중 붙여넣기는 방해 않음
        const items = (ev.clipboardData && ev.clipboardData.items) || [];
        const imgs = [];
        for (const it of items) {
            if (it.kind === 'file' && String(it.type || '').startsWith('image/')) {
                const b = it.getAsFile();
                if (b)
                    imgs.push(b);
            }
        }
        if (!imgs.length)
            return; // 이미지가 없으면 평소 붙여넣기 동작 유지
        ev.preventDefault();
        const dest = '공유 폴더' + (st.path ? ' / ' + st.path : '');
        openPasteDialog(imgs, dest, (files) => uploadFiles(files.map((f) => ({ file: f, rel: String(f.name) })), []));
    };
    document.addEventListener('paste', onPaste);
    load();
    return card;
    // 선택 모드 토글 — 켜면 카드가 체크박스로, 끄면 선택 해제 + 헤드 버튼 라벨 전환.
    function toggleSelMode(on) {
        sel.mode = on != null ? on : !sel.mode;
        if (!sel.mode)
            sel.ids.clear();
        selectBtn.classList.toggle('active', sel.mode);
        selectBtn.textContent = sel.mode ? '선택 취소' : '선택';
        paintSelBar();
        if (lastData)
            render(lastData);
    }
    function paintSelBar() {
        if (!sel.mode) {
            selBar.hidden = true;
            selBar.replaceChildren();
            return;
        }
        const n = sel.ids.size, total = lastPairs.length;
        const allOn = total > 0 && n >= total;
        const allBtn2 = el('button', { class: 'btn btn-ghost btn-sm', text: allOn ? '전체 해제' : '전체 선택',
            onclick: () => { if (allOn)
                sel.ids.clear();
            else
                lastPairs.forEach((p) => sel.ids.add(p.rel)); paintSelBar(); if (lastData)
                render(lastData); } });
        const delB = el('button', { class: 'btn btn-sm btn-danger', text: '선택 삭제', disabled: n === 0, onclick: () => bulkDeleteSel() });
        selBar.hidden = false;
        selBar.replaceChildren(el('span', { class: 'bulk-bar-count', text: n ? n + '개 선택됨' : '삭제할 항목을 고르세요' }), el('div', { class: 'bulk-bar-actions' }, allBtn2, delB));
    }
    async function bulkDeleteSel() {
        const rels = [...sel.ids];
        if (!rels.length)
            return;
        if (!confirm(rels.length + '개 항목을 삭제할까요?\n\n폴더는 안의 내용까지 함께 삭제됩니다(되돌릴 수 없음).'))
            return;
        // 병렬 삭제 — 일부 실패해도 나머지 진행(성공/실패 집계).
        const results = await Promise.allSettled(rels.map((rel) => api(B + id + '/file?path=' + encodeURIComponent(rel), { method: 'DELETE' })));
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const fail = results.length - ok;
        toast(fail ? (ok + '개 삭제 · ' + fail + '개 실패') : (ok + '개 삭제했습니다'), fail > 0);
        toggleSelMode(false);
        load();
    }
    // 여러 파일 업로드 — 그리드에 '업로드 중 카드'(비활성 아이콘 + 실시간 %) 띄우고 순차 전송.
    //  items[].rel = 대상 폴더 기준 상대경로 — 폴더 업로드면 'sub/child/a.png' 처럼 하위 경로가 들어있고,
    //  서버 PUT 이 dirname 을 mkdir -p 하므로 그 구조 그대로 만들어진다. emptyDirs = 파일 없는 빈 폴더(따로 mkdir).
    async function uploadFiles(items, emptyDirs) {
        const arr = items || [];
        const dirs = emptyDirs || [];
        if (!arr.length && !dirs.length) {
            toast('올릴 파일이 없습니다', true);
            return;
        }
        const cur = lastFolderItems; // 검색 중이어도 실제 업로드 대상 폴더 기준(#877 리뷰)
        const pc = upPrecheckOverwrite(arr, cur); // #877 — 겹치면 무엇이 덮이는지 보여주고 확인
        if (!pc.go)
            return;
        if (arr.length > UP_CONFIRM && !confirm(arr.length + '개 파일을 업로드합니다. 계속할까요?'))
            return;
        const dest = st.path; // 업로드 중 다른 폴더로 들어가도 '떨어뜨린 그 폴더'로 간다
        // 파일이 많으면(폴더 업로드) 파일별 카드 대신 묶음 카드 1개 — 그리드가 수백 장으로 폭주하지 않게.
        const many = arr.length > UP_MANY;
        const cards = many
            ? [{ name: arr.length + '개 파일', label: '0/' + arr.length + ' 업로드 중', pct: 0 }]
            : arr.map((u) => ({ name: u.rel, label: u.rel, pct: 0 }));
        uploading.push(...cards);
        if (lastData)
            render(lastData); // 업로드 카드 즉시 표시(load 기다리지 않음)
        // 취소는 이 배치만 끊는다 — 배치마다 컨트롤러·바가 따로라 동시 업로드끼리 서로 영향이 없다(#797).
        const ac = new AbortController();
        const bar = upProgress(arr.length, () => ac.abort());
        progBox.append(bar.row);
        const r = await upSend({
            items: arr, emptyDirs: dirs, signal: ac.signal, overwriteNames: pc.over,
            fileUrl: (rel) => B + id + '/file?path=' + encodeURIComponent((dest ? dest + '/' : '') + rel),
            dirUrl: (d) => B + id + '/folder?path=' + encodeURIComponent((dest ? dest + '/' : '') + d),
            onProgress: (i, rel, pct) => {
                bar.set(i, rel, pct);
                const c = many ? cards[0] : cards[i];
                if (!c)
                    return;
                c.pct = many ? ((i + pct / 100) / arr.length) * 100 : pct;
                if (many)
                    c.label = i + '/' + arr.length + ' — ' + (rel.split('/').pop() || rel);
                updateUpCard(c);
            },
        });
        bar.row.remove();
        for (const c of cards) {
            const ix = uploading.indexOf(c);
            if (ix >= 0)
                uploading.splice(ix, 1);
        } // 이 배치 카드만 걷어냄(동시 업로드 보호)
        upToast(r);
        st.q = '';
        searchIn.value = '';
        load();
    }
    function uploadingCard(u) {
        const pctEl = el('div', { class: 'proj-up-pct', text: Math.round(u.pct) + '%' });
        const fill = el('div', { class: 'proj-up-bar-fill', style: 'width:' + u.pct + '%' });
        const nmEl = el('div', { class: 'proj-file-card-nm', text: u.label || u.name });
        u.pctEl = pctEl;
        u.fill = fill;
        u.nmEl = nmEl;
        return el('div', { class: 'proj-file-card uploading', title: u.name }, el('div', { class: 'proj-up-icwrap' }, el('div', { class: 'proj-file-card-ic', text: iconFor(u.name) }), el('div', { class: 'proj-up-overlay' }, pctEl)), nmEl, el('div', { class: 'proj-up-bar' }, fill));
    }
    function updateUpCard(u) {
        if (u.pctEl)
            u.pctEl.textContent = Math.round(u.pct) + '%';
        if (u.fill)
            u.fill.style.width = u.pct + '%';
        if (u.nmEl)
            u.nmEl.textContent = u.label || u.name;
    }
    // 현재 폴더 안에 하위 폴더 생성.
    function openMkdir() {
        const nameIn = el('input', { type: 'text', placeholder: '폴더 이름', maxlength: '80' });
        const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기' });
        const back = overlayBox('새 폴더', el('p', { class: 'admin-hint', text: (st.path ? '“' + st.path + '” 안에' : '루트에') + ' 새 폴더를 만듭니다.' }), el('div', { class: 'field' }, el('label', { class: 'field-label', text: '폴더 이름' }), nameIn), el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
        setTimeout(() => nameIn.focus(), 0);
        const go = async () => {
            const nm = nameIn.value.trim();
            if (!nm) {
                nameIn.focus();
                toast('폴더 이름을 입력하세요', true);
                return;
            }
            const target = (st.path ? st.path + '/' : '') + nm;
            saveBtn.disabled = true;
            try {
                await api(B + id + '/folder?path=' + encodeURIComponent(target), { method: 'POST' });
                back.remove();
                toast('폴더를 만들었습니다');
                st.q = '';
                searchIn.value = '';
                load();
            }
            catch (e) {
                toast('실패 — ' + e.message, true);
                saveBtn.disabled = false;
            }
        };
        saveBtn.onclick = go;
        nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter')
            go(); });
    }
    async function load() {
        body.replaceChildren(skeletonRows(3));
        try {
            const qs = st.q ? ('?q=' + encodeURIComponent(st.q)) : ('?path=' + encodeURIComponent(st.path));
            render(await api(B + id + '/files' + qs));
        }
        catch (e) {
            body.replaceChildren(errorNote(e, '폴더를 불러오지 못했습니다'));
        }
    }
    function render(data) {
        lastData = data;
        if (data.search === undefined)
            lastFolderItems = data.items || []; // 검색결과는 무시 — 폴더 목록일 때만(#877)
        const frag = [];
        let pairs; // { it, rel }
        if (data.search !== undefined) {
            frag.push(el('div', { class: 'proj-file-crumb', text: '“' + data.search + '” 검색 — ' + data.items.length + '건' }));
            pairs = data.items.map((it) => ({ it, rel: it.path }));
            if (!data.items.length)
                frag.push(el('div', { class: 'empty', text: '일치하는 파일이 없습니다.' }));
        }
        else {
            const crumb = el('div', { class: 'proj-file-crumb' }, el('span', { class: 'proj-crumb-link', text: '⌂ 루트', onclick: () => { st.path = ''; load(); } }));
            if (data.path)
                crumb.append(el('span', { text: ' / ' + data.path }));
            frag.push(crumb);
            pairs = data.items.map((it) => ({ it, rel: join(st.path, it.name) }));
            if (!data.items.length && !data.path)
                frag.push(el('div', { class: 'empty', text: '빈 폴더입니다. ‘＋ 업로드’를 누르거나, 파일·폴더를 끌어다 놓으세요.' }));
        }
        const cards = [];
        for (const u of uploading)
            cards.push(uploadingCard(u)); // 업로드 중 카드 먼저(비활성 + 실시간 %)
        lastPairs = pairs;
        const enterDir = (t) => { sel.ids.clear(); st.q = ''; searchIn.value = ''; st.path = t; load(); };
        if (data.search === undefined && data.path)
            cards.push(projUpCardEl(() => enterDir(data.parent || '')));
        const selCtl = sel.mode ? { ids: sel.ids, onToggle: paintSelBar } : null;
        for (const { it, rel } of pairs)
            cards.push(projFileCardEl(id, it, rel, enterDir, load, B, selCtl, shareBase));
        if (cards.length)
            frag.push(el('div', { class: 'proj-file-grid' }, ...cards));
        body.replaceChildren(...frag);
        if (sel.mode)
            paintSelBar();
    }
    function join(a, b) { return a ? a + '/' + b : b; }
}
export { projectFolderSection };
