// editor/toolbar.ts — 선택 시 뜨는 인라인 서식 툴바 + 링크 팝오버 + 블록 전환 드롭다운
//  (#1313 R58 — block-editor.ts '인라인 서식 툴바' 절 verbatim 적출).
//  ⚠ 이 팩토리는 호출 즉시 document.body 에 툴바를 붙이고 selectionchange 를 구독한다 —
//    해제는 createBlockEditor 의 destroy() 가 ctx.tools / ctx.onSelChange 로 수행한다.
import { el, safeHref, toast } from '../core.js';
import { caretRange } from './caret.js';
export function createToolbar(ctx) {
    const { root } = ctx;
    const SLASH_ITEMS = ctx.SLASH_ITEMS; // 값 별칭 — createSlash 뒤에 호출해야 한다(조립 순서, block-editor.ts 참조)
    // 늦은 바인딩 별칭(context.ts 참조).
    const markDirty = () => ctx.markDirty();
    const blockOf = (node) => ctx.blockOf(node);
    const closeSlashMenu = () => ctx.closeSlashMenu();
    const closeMention = () => ctx.closeMention();
    // ════════ 인라인 서식 툴바 ════════
    const tools = el('div', { class: 'be-tools', hidden: true });
    document.body.append(tools);
    const toolBtn = (label, title, fn, cls) => {
        const b = el('button', { class: 'be-tool' + (cls ? ' ' + cls : ''), type: 'button', title });
        b.append(typeof label === 'string' ? document.createTextNode(label) : label);
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.onclick = () => { fn(); markDirty(); positionTools(); };
        return b;
    };
    // 선택을 tag 로 감싸기/풀기(간단 토글) — execCommand 미지원 마크(code/mark)용.
    function toggleWrap(tag) {
        const r = caretRange();
        if (!r || r.collapsed)
            return;
        let n = r.commonAncestorContainer;
        if (n.nodeType === 3)
            n = n.parentElement;
        const existing = n && n.closest ? n.closest(tag) : null;
        if (existing && root.contains(existing)) {
            const parent = existing.parentNode;
            while (existing.firstChild)
                parent.insertBefore(existing.firstChild, existing);
            parent.removeChild(existing);
            return;
        }
        try {
            const frag = r.extractContents();
            const wrap = el(tag, tag === 'code' ? { class: 'md-code' } : (tag === 'mark' ? { class: 'md-mark' } : {}));
            wrap.append(frag);
            r.insertNode(wrap);
            const s = window.getSelection();
            s.removeAllRanges();
            const nr = document.createRange();
            nr.selectNodeContents(wrap);
            s.addRange(nr);
        }
        catch (_) { /* 경계 걸친 드문 케이스 — no-op */ }
    }
    // 링크 — 노션형 인라인 팝오버(입력 + 적용/해제). window.prompt 금지(#657t).
    //  선택 레인지를 저장해 두고 input 포커스로 선택이 사라져도 적용 시 복원 후 execCommand.
    function openLinkPop() {
        const r0 = caretRange();
        if (!r0 || r0.collapsed)
            return;
        const saved = r0.cloneRange();
        const old = document.querySelector('.be-linkpop');
        if (old) {
            old.remove();
            return;
        }
        let n = r0.commonAncestorContainer;
        if (n.nodeType === 3)
            n = n.parentElement;
        const existing = n && n.closest ? n.closest('a') : null;
        const input = el('input', { class: 'be-linkpop-in', type: 'text', spellcheck: 'false',
            placeholder: '주소 붙여넣기 (https://… 또는 #/k/문서명)',
            value: existing ? (existing.getAttribute('href') || '') : '' });
        const close = () => { pop.remove(); document.removeEventListener('mousedown', onDoc, true); };
        const restoreSel = () => { const s = window.getSelection(); s.removeAllRanges(); s.addRange(saved); };
        const apply = () => {
            const url = input.value.trim();
            if (!url) {
                restoreSel();
                document.execCommand('unlink');
                close();
                markDirty();
                return;
            }
            const safe = safeHref(url);
            if (!safe) {
                toast('허용되지 않는 URL 입니다', true);
                input.focus();
                return;
            }
            restoreSel();
            document.execCommand('createLink', false, safe);
            close();
            markDirty();
        };
        const applyBtn = el('button', { class: 'be-linkpop-btn', type: 'button', text: '적용' });
        applyBtn.onclick = apply;
        const unlinkBtn = existing ? el('button', { class: 'be-linkpop-btn be-linkpop-un', type: 'button', text: '해제',
            onclick: () => { restoreSel(); document.execCommand('unlink'); close(); markDirty(); } }) : null;
        const pop = el('div', { class: 'be-linkpop' }, input, applyBtn, unlinkBtn);
        document.body.append(pop);
        const rect = saved.getBoundingClientRect();
        pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 330)) + 'px';
        pop.style.top = (rect.bottom + 8) + 'px';
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                apply();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                close();
            }
            e.stopPropagation();
        });
        const onDoc = (ev) => { if (!pop.contains(ev.target))
            close(); };
        setTimeout(() => { document.addEventListener('mousedown', onDoc, true); input.focus(); }, 0);
    }
    // 전환 드롭다운(툴바 좌측) — 현재 블록 유형 라벨 + 리스트(노션 'Text ∨' 동형).
    const TURN_LABEL = { p: '텍스트', h1: '제목 1', h2: '제목 2', h3: '제목 3', h4: '제목 4',
        bullet: '글머리 목록', numbered: '번호 목록', todo: '할 일', quote: '인용', callout: '콜아웃', code: '코드', toggle: '토글' };
    const curTypeKey = (block) => {
        const t = block.dataset.type;
        return t === 'h' ? 'h' + Math.min(Number(block.dataset.level) || 1, 4) : t;
    };
    let toolsBlock = null; // 현재 선택이 속한 블록(전환 대상)
    const turnLabel = el('span', { class: 'be-turn-label', text: '텍스트' });
    const turnBtn = el('button', { class: 'be-tool be-tool-turn', type: 'button', title: '블록 유형 전환' }, turnLabel, el('span', { class: 'be-turn-caret', 'aria-hidden': 'true', text: '⌄' }));
    turnBtn.addEventListener('mousedown', (e) => e.preventDefault());
    turnBtn.onclick = () => {
        const old = document.querySelector('.be-turnpop');
        if (old) {
            old.remove();
            return;
        }
        if (!toolsBlock)
            return;
        const block = toolsBlock;
        const pop = el('div', { class: 'be-turnpop' });
        const close = () => { pop.remove(); document.removeEventListener('mousedown', onDoc, true); };
        for (const it of SLASH_ITEMS) {
            if (!['text', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'toggle', 'quote', 'callout', 'code'].includes(it.k))
                continue;
            const cur = curTypeKey(block) === (it.k === 'text' ? 'p' : it.k);
            const b = el('button', { class: 'be-turnpop-item' + (cur ? ' on' : ''), type: 'button' }, el('span', { class: 'be-slash-ic', text: it.ic }), el('span', { text: it.label }), cur ? el('span', { class: 'be-turnpop-check', text: '✓' }) : null);
            b.addEventListener('mousedown', (e) => e.preventDefault());
            b.onclick = () => { close(); it.apply(block); };
            pop.append(b);
        }
        document.body.append(pop);
        const r = turnBtn.getBoundingClientRect();
        pop.style.left = Math.max(8, r.left) + 'px';
        pop.style.top = (r.bottom + 6) + 'px';
        const onDoc = (ev) => { if (!pop.contains(ev.target) && ev.target !== turnBtn)
            close(); };
        setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
    };
    const markBtns = {};
    const addTool = (key, label, title, fn, cls) => {
        const b = toolBtn(label, title, fn, cls);
        markBtns[key] = b;
        return b;
    };
    tools.append(turnBtn, el('span', { class: 'be-tools-sep', 'aria-hidden': 'true' }), addTool('b', 'B', '굵게 — ⌘B', () => document.execCommand('bold'), 'be-tool-b'), addTool('i', 'i', '기울임 — ⌘I', () => document.execCommand('italic'), 'be-tool-i'), addTool('u', 'U', '밑줄 — ⌘U', () => document.execCommand('underline'), 'be-tool-u'), addTool('s', 'S', '취소선', () => document.execCommand('strikeThrough'), 'be-tool-s'), addTool('code', '</>', '인라인 코드 — ⌘E', () => toggleWrap('code'), 'be-tool-code'), addTool('mark', '형광', '하이라이트 — ⌘⇧H', () => toggleWrap('mark'), 'be-tool-mark'), el('span', { class: 'be-tools-sep', 'aria-hidden': 'true' }), addTool('a', '링크', '링크 걸기', () => openLinkPop(), 'be-tool-link'));
    function positionTools() {
        const s = window.getSelection();
        if (!s || !s.rangeCount || s.isCollapsed) {
            tools.hidden = true;
            return;
        }
        const r = s.getRangeAt(0);
        const anc = r.commonAncestorContainer;
        const ancEl = anc.nodeType === 3 ? anc.parentElement : anc;
        const t = ancEl && ancEl.closest ? ancEl.closest('.be-text') : null;
        if (!t || !root.contains(t) || t.classList.contains('be-code')) {
            tools.hidden = true;
            return;
        }
        const rect = r.getBoundingClientRect();
        if (!rect.width && !rect.height) {
            tools.hidden = true;
            return;
        }
        // 활성 마크 상태 + 현재 블록 유형 라벨(노션 'Text ∨').
        toolsBlock = blockOf(t);
        if (toolsBlock)
            turnLabel.textContent = TURN_LABEL[curTypeKey(toolsBlock)] || '텍스트';
        const on = (sel) => !!(ancEl && ancEl.closest && ancEl.closest(sel));
        markBtns.b.classList.toggle('on', on('b, strong'));
        markBtns.i.classList.toggle('on', on('i, em'));
        markBtns.u.classList.toggle('on', on('u'));
        markBtns.s.classList.toggle('on', on('s, del, strike'));
        markBtns.code.classList.toggle('on', on('code'));
        markBtns.mark.classList.toggle('on', on('mark'));
        markBtns.a.classList.toggle('on', on('a'));
        tools.hidden = false;
        const w = tools.offsetWidth || 300;
        tools.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8)) + 'px';
        tools.style.top = Math.max(8, rect.top - tools.offsetHeight - 9) + 'px';
    }
    const onSelChange = () => {
        if (!root.isConnected) {
            document.removeEventListener('selectionchange', onSelChange);
            tools.remove();
            closeSlashMenu();
            closeMention();
            return;
        }
        requestAnimationFrame(positionTools);
    };
    document.addEventListener('selectionchange', onSelChange);
    return { tools, toggleWrap, openLinkPop, onSelChange };
}
