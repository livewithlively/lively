// editor/interactions.ts — 포인터 상호작용(#1313 R58 — block-editor.ts 체크박스/클릭/붙여넣기/드롭/⋮⋮ 메뉴/드래그 절 verbatim 적출).
//  드래그 상태(dragging·justDragged)는 이 모듈이 단독 소유한다 — 드롭 대상 판정과 클릭 오발 방지가 한 쌍이라.
import { el, renderInline } from '../core.js';
import { TEXTY } from './model.js';
import { mdToBlocks } from './parse.js';
import { caretRange, insertText, placeCaret } from './caret.js';
export function createInteractions(ctx) {
    const { root, opts } = ctx;
    const SLASH_ITEMS = ctx.SLASH_ITEMS; // 값 별칭 — createSlash 뒤에 호출해야 한다(조립 순서, block-editor.ts 참조)
    // 늦은 바인딩 별칭(context.ts 참조).
    const markDirty = () => ctx.markDirty();
    const blockOf = (node) => ctx.blockOf(node);
    const blockEls = () => ctx.blockEls();
    const textElOf = (block) => ctx.textElOf(block);
    const makeBlock = (d) => ctx.makeBlock(d);
    const insertBlockAfter = (block, data) => ctx.insertBlockAfter(block, data);
    const focusBlock = (block, atStart) => ctx.focusBlock(block, atStart);
    const renumber = () => ctx.renumber();
    const normalizeStructure = () => ctx.normalizeStructure();
    const duplicateBlock = (block) => ctx.duplicateBlock(block);
    const moveBlockDir = (block, dir) => ctx.moveBlockDir(block, dir);
    const deleteBlock = (block) => ctx.deleteBlock(block);
    const openSlashMenu = (block, typed) => ctx.openSlashMenu(block, typed);
    const insertUploadedImages = (block, files) => ctx.insertUploadedImages(block, files);
    const histFlushTyping = () => ctx.histFlushTyping();
    // ── 체크박스/추가 버튼/빈 영역 클릭 ──
    root.addEventListener('change', (e) => {
        const cb = e.target;
        if (!cb.classList || !cb.classList.contains('be-check'))
            return;
        const block = blockOf(cb);
        block.dataset.checked = cb.checked ? '1' : '';
        const t = textElOf(block);
        if (t)
            t.classList.toggle('be-done', cb.checked);
        markDirty();
    });
    root.addEventListener('click', (e) => {
        const add = e.target.closest ? e.target.closest('.be-addbtn') : null;
        if (add) {
            const block = blockOf(add);
            const nb = insertBlockAfter(block, { type: 'p', text: '' });
            focusBlock(nb);
            openSlashMenu(nb, false);
            return;
        }
        // ⋮⋮ 클릭 = 블록 메뉴(전환·복제·이동·삭제) — 드래그 직후 클릭은 무시(#657n, 노션 동일).
        const h = e.target.closest ? e.target.closest('.be-handle') : null;
        if (h) {
            if (justDragged)
                return;
            const block = blockOf(h);
            openBlockMenu(block, h);
            return;
        }
        // 에디터 안 내부 링크(#/k/… 멘션 등) 클릭 = 이동(노션 멘션 동일). 외부 링크는 기본(캐럿).
        const link = e.target.closest ? e.target.closest('a[href]') : null;
        if (link && root.contains(link)) {
            const href = link.getAttribute('href') || '';
            if (href.startsWith('#/')) {
                e.preventDefault();
                location.hash = href;
                return;
            }
        }
        if (e.target === root) { // 본문 아래 여백 클릭 → 마지막 블록(비면 그거, 아니면 새 문단)
            const bs = blockEls();
            const last = bs[bs.length - 1];
            const lt = last ? textElOf(last) : null;
            if (last && lt && last.dataset.type === 'p' && !lt.textContent)
                focusBlock(last, false);
            else
                focusBlock(insertBlockAfter(last || null, { type: 'p', text: '' }));
        }
    });
    // ── 붙여넣기 — 마크다운/여러 줄이면 블록으로 파싱해 삽입, 한 줄이면 평문 삽입 ──
    root.addEventListener('paste', (e) => {
        const target = e.target;
        if (target.classList && (target.classList.contains('be-raw-ta') || target.classList.contains('be-code-lang')))
            return;
        const block = blockOf(target);
        if (!block || !target.classList || !target.classList.contains('be-text'))
            return;
        // #730 이미지 붙여넣기 — 클립보드에 이미지 파일이 있고 업로더가 있으면 인라인 삽입(첨부로 새지 않음).
        const cd = e.clipboardData || window.clipboardData;
        if (opts.uploadFile && cd) {
            const imgs = [];
            for (const it of (cd.items || [])) {
                if (it.kind === 'file' && /^image\//.test(it.type || '')) {
                    const f = it.getAsFile();
                    if (f)
                        imgs.push(f);
                }
            }
            if (!imgs.length)
                for (const f of (cd.files || [])) {
                    if (/^image\//.test(f.type || ''))
                        imgs.push(f);
                }
            const plain = cd.getData ? (cd.getData('text/plain') || '') : '';
            if (imgs.length && !plain.trim()) {
                e.preventDefault();
                insertUploadedImages(block, imgs);
                return;
            }
        }
        const text = (e.clipboardData || window.clipboardData).getData('text/plain');
        if (text == null)
            return;
        e.preventDefault();
        if (block.dataset.type === 'code') {
            insertText(text);
            markDirty();
            return;
        }
        const hasBlockMd = /\n/.test(text) || /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|:::|\|)/.test(text.trim());
        if (!hasBlockMd) {
            insertText(text);
            markDirty();
            return;
        }
        const parsed = mdToBlocks(text);
        // 첫 파싱 블록이 문단이면 현재 캐럿에 인라인로 잇고, 나머지는 새 블록으로.
        let rest = parsed;
        if (parsed[0] && parsed[0].type === 'p' && TEXTY.has(block.dataset.type)) {
            const r = caretRange();
            if (r) {
                const frag = document.createDocumentFragment();
                String(parsed[0].text || '').split('\n').forEach((l, idx) => {
                    if (idx > 0)
                        frag.append(el('br'));
                    for (const n of renderInline(l))
                        frag.append(n);
                });
                r.deleteContents();
                r.insertNode(frag);
                placeCaret(target, false);
            }
            rest = parsed.slice(1);
        }
        let anchor = block;
        for (const d of rest)
            anchor = insertBlockAfter(anchor, d);
        renumber();
        markDirty();
        if (rest.length)
            focusBlock(anchor, false);
    });
    // ── #730 이미지 드롭 — 파일을 에디터에 끌어다 놓으면 인라인 삽입(업로더 있을 때만) ──
    root.addEventListener('dragover', (e) => {
        if (opts.uploadFile && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
            e.preventDefault();
        }
    });
    root.addEventListener('drop', (e) => {
        if (!opts.uploadFile || !e.dataTransfer)
            return;
        const files = Array.from(e.dataTransfer.files || []).filter((f) => /^image\//.test(f.type || ''));
        if (!files.length)
            return;
        e.preventDefault();
        const block = blockOf(e.target) || blockEls()[blockEls().length - 1];
        if (block)
            insertUploadedImages(block, files);
    });
    // ── 블록 메뉴(⋮⋮ 클릭) — 전환(단순 텍스트 블록) + 복제/이동/삭제. 노션 핸들 메뉴 동형(#657n). ──
    function openBlockMenu(block, anchor) {
        const old = document.querySelector('.be-blockmenu');
        if (old) {
            old.remove();
            return;
        }
        const type = block.dataset.type;
        const menu = el('div', { class: 'be-blockmenu', role: 'menu' });
        const close = () => { menu.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
        if (['p', 'h', 'bullet', 'numbered', 'todo', 'quote', 'callout', 'code'].includes(type)) {
            menu.append(el('div', { class: 'be-bm-head', text: '전환' }));
            const grid = el('div', { class: 'be-bm-grid' });
            for (const it of SLASH_ITEMS) {
                if (!['text', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'toggle', 'columns', 'quote', 'callout', 'code'].includes(it.k))
                    continue;
                const b = el('button', { class: 'be-bm-turn', type: 'button', title: it.label, text: it.ic });
                b.addEventListener('mousedown', (ev) => ev.preventDefault());
                b.onclick = () => { close(); it.apply(block); };
                grid.append(b);
            }
            menu.append(grid, el('div', { class: 'be-bm-hr' }));
        }
        const item = (ic, label, fn, danger) => {
            const b = el('button', { class: 'be-bm-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { class: 'be-bm-ic', 'aria-hidden': 'true', text: ic }), el('span', { text: label }));
            b.onclick = () => { close(); fn(); };
            return b;
        };
        menu.append(item('⧉', '복제 — ⌘D', () => duplicateBlock(block)), item('↑', '위로 이동 — ⌘⇧↑', () => moveBlockDir(block, -1)), item('↓', '아래로 이동 — ⌘⇧↓', () => moveBlockDir(block, 1)), item('✕', '삭제', () => deleteBlock(block), true));
        document.body.append(menu);
        const r = anchor.getBoundingClientRect();
        const mh = menu.offsetHeight || 220;
        menu.style.left = Math.max(8, Math.min(r.left - 6, window.innerWidth - 246)) + 'px';
        menu.style.top = (r.bottom + 6 + mh > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
        const onDoc = (ev) => { if (!menu.contains(ev.target))
            close(); };
        const onKey = (ev) => { if (ev.key === 'Escape') {
            ev.stopPropagation();
            close();
        } };
        setTimeout(() => { document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); }, 0);
    }
    // ── 드래그 — 위/아래 재정렬 + 좌/우 엣지 드롭 = 컬럼 생성(노션 시그니처 레이아웃, #657n). ──
    //  타깃은 elementFromPoint 로(중첩 컨테이너 안 블록도 정타깃). 컬럼 생성은 최상위 블록 간에만(중첩 컬럼 금지).
    let dragging = null;
    let justDragged = false;
    root.addEventListener('dragstart', (e) => {
        const h = e.target.closest ? e.target.closest('.be-handle') : null;
        if (!h) {
            e.preventDefault();
            return;
        }
        dragging = blockOf(h);
        if (!dragging)
            return;
        histFlushTyping(); // 드래그 직전 타이핑 버스트 확정 — undo 가 드래그만 되돌리도록
        justDragged = true;
        dragging.classList.add('be-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try {
            e.dataTransfer.setData('text/plain', '');
            e.dataTransfer.setDragImage(dragging, 24, 12);
        }
        catch (_) { /* noop */ }
    });
    const DROP_CLASSES = ['be-drop-above', 'be-drop-below', 'be-drop-left', 'be-drop-right'];
    const clearDrop = () => root.querySelectorAll('.' + DROP_CLASSES.join(', .')).forEach((n) => n.classList.remove(...DROP_CLASSES));
    function dropTargetAt(e) {
        const under = document.elementFromPoint(e.clientX, e.clientY);
        let target = under && under.closest ? under.closest('.be-block') : null;
        if (target && (!root.contains(target) || target === dragging || dragging.contains(target) || target.contains(dragging)))
            target = null;
        if (target)
            return target;
        // 여백 폴백 — 루트 직계 블록을 Y 로 스캔(기존 동작).
        let fb = null;
        for (const b of blockEls()) {
            if (b === dragging || b.contains(dragging))
                continue;
            const r = b.getBoundingClientRect();
            if (e.clientY < r.top + r.height / 2)
                return b;
            fb = b;
        }
        return fb;
    }
    root.addEventListener('dragover', (e) => {
        if (!dragging)
            return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearDrop();
        const target = dropTargetAt(e);
        if (!target)
            return;
        const r = target.getBoundingClientRect();
        // 좌/우 엣지 = 컬럼 생성 힌트 — 루트 직계 + 양쪽 다 컬럼 아님일 때만.
        const EDGE = Math.min(72, Math.max(28, r.width * 0.16));
        const canCol = target.parentElement === root && target.dataset.type !== 'columns' && dragging.dataset.type !== 'columns';
        if (canCol && e.clientX < r.left + EDGE) {
            target.classList.add('be-drop-left');
            return;
        }
        if (canCol && e.clientX > r.right - EDGE) {
            target.classList.add('be-drop-right');
            return;
        }
        target.classList.add(e.clientY < r.top + r.height / 2 ? 'be-drop-above' : 'be-drop-below');
    });
    root.addEventListener('drop', (e) => {
        if (!dragging)
            return;
        e.preventDefault();
        const t = root.querySelector('.' + DROP_CLASSES.join(', .'));
        if (t && t !== dragging) {
            if (t.classList.contains('be-drop-left') || t.classList.contains('be-drop-right')) {
                // 컬럼 생성 — 새 컨테이너에 [드래그, 타깃](왼쪽 드롭) 또는 [타깃, 드래그] 순으로 실 DOM 이동.
                const left = t.classList.contains('be-drop-left');
                const shell = makeBlock({ type: 'columns', cols: [[], []], __shell: true });
                t.before(shell);
                const cols = shell.querySelectorAll(':scope > .be-main > .be-cols > .be-col');
                cols[0].append(left ? dragging : t);
                cols[1].append(left ? t : dragging);
            }
            else if (t.classList.contains('be-drop-above')) {
                t.before(dragging);
            }
            else {
                t.after(dragging);
            }
            normalizeStructure();
            markDirty();
        }
        clearDrop();
    });
    root.addEventListener('dragend', () => {
        if (dragging)
            dragging.classList.remove('be-dragging');
        dragging = null;
        clearDrop();
        setTimeout(() => { justDragged = false; }, 50); // 드래그 직후 handle click 오발 방지
    });
}
