// editor/blocks.ts — 블록 접근/데이터 추출 + 구조 연산(#1313 R58 — block-editor.ts '블록 접근/데이터' 절 verbatim 적출).
//  DOM(블록 엘리먼트) ↔ 블록 데이터의 경계다 — 직렬화는 serialize.ts, 생성은 render.ts 가 맡는다.
import { LISTY } from './model.js';
import { inlineDomToMd } from './serialize.js';
import { placeCaret } from './caret.js';
export function createBlocks(ctx) {
    const { root, opts } = ctx;
    // 늦은 바인딩 별칭(context.ts 참조).
    const makeBlock = (d) => ctx.makeBlock(d);
    const collAttrsOf = (block) => ctx.collAttrsOf(block);
    const markDirty = () => ctx.markDirty();
    // ── 블록 접근/데이터 ──
    const blockEls = () => Array.from(root.children).filter((n) => n.classList && n.classList.contains('be-block'));
    const blockOf = (node) => {
        let n = node && node.nodeType === 3 ? node.parentElement : node;
        while (n && n !== root) {
            if (n.classList && n.classList.contains('be-block'))
                return n;
            n = n.parentElement;
        }
        return null;
    };
    const textElOf = (block) => block.querySelector('.be-text');
    const prevTextBlock = (block) => { let p = block.previousElementSibling; return p; };
    const nextTextBlock = (block) => { let n = block.nextElementSibling; return n; };
    function blockData(block) {
        const type = block.dataset.type;
        const t = textElOf(block);
        switch (type) {
            case 'h': return { type, level: Number(block.dataset.level) || 1, text: t ? inlineDomToMd(t) : '' };
            case 'bullet':
            case 'numbered':
                return { type, indent: Number(block.dataset.indent) || 0, text: t ? inlineDomToMd(t) : '' };
            case 'todo':
                return { type, indent: Number(block.dataset.indent) || 0, checked: block.dataset.checked === '1', text: t ? inlineDomToMd(t) : '' };
            case 'quote':
            case 'callout':
                return { type, icon: block.dataset.icon, color: block.dataset.color, text: t ? inlineDomToMd(t) : '' };
            case 'code': {
                const codeBox = block.querySelector('.be-code');
                return { type, lang: block.dataset.lang || '', text: codeBox ? codeBox.innerText.replace(/\u200B/g, '').replace(/\n$/, '') : '' };
            }
            case 'divider': return { type };
            case 'pagecard': return { type, name: block.dataset.name || '', label: block.dataset.label || '' };
            case 'collection': return { type, attrs: collAttrsOf(block) };
            case 'raw': {
                const ta = block.querySelector('.be-raw-ta');
                return { type, text: ta ? ta.value : (block._raw || '') };
            }
            case 'toggle': {
                const sum = block.querySelector(':scope > .be-main > .be-toggle > .be-toggle-row > .be-text');
                const kids = block.querySelector(':scope > .be-main > .be-toggle > .be-togglekids');
                return { type, summary: sum ? inlineDomToMd(sum) : '', children: kids ? childBlocksOf(kids) : [] };
            }
            case 'columns': {
                const cols = Array.from(block.querySelectorAll(':scope > .be-main > .be-cols > .be-col'));
                return { type, cols: cols.map((c) => childBlocksOf(c)) };
            }
            default: return { type: 'p', text: t ? inlineDomToMd(t) : '' };
        }
    }
    // 컨테이너(togglekids/col)의 직계 블록 데이터 — toggle/columns 재귀 직렬화용.
    function childBlocksOf(container) {
        return Array.from(container.children)
            .filter((n) => n.classList && n.classList.contains('be-block'))
            .map((n) => blockData(n));
    }
    // 번호 목록 재부여 + 글머리 글리프(깊이별 • ◦ ▪) + 들여쓰기 패딩 — 컨테이너(루트/토글/컬럼) 스코프별로.
    function renumberIn(scope) {
        const counters = [];
        for (const b of Array.from(scope.children).filter((n) => n.classList && n.classList.contains('be-block'))) {
            const type = b.dataset.type;
            if (!LISTY.has(type)) {
                counters.length = 0;
                continue;
            }
            const d = Math.min(Number(b.dataset.indent) || 0, 4);
            counters.length = d + 1;
            const row = b.querySelector('.be-li');
            if (row)
                row.style.paddingLeft = (d * 26) + 'px';
            const marker = b.querySelector('.be-marker');
            if (type === 'numbered') {
                counters[d] = (counters[d] || 0) + 1;
                if (marker)
                    marker.textContent = counters[d] + '.';
            }
            else {
                counters[d] = 0;
                if (marker)
                    marker.textContent = ['•', '◦', '▪', '▹', '·'][d] || '•';
            }
        }
    }
    //  번호 매기기 — **컬럼은 문서 흐름을 잇는다**(왼쪽 열 → 오른쪽 열 순으로 카운터를 이어받는다).
    //   목록 도중에 열을 만들면 4·5 였던 항목이 1·1 로 되돌아가 '번호가 망가진' 것처럼 보였다.
    //   토글 자식은 접히면 보이지 않는 별개 흐름이라 지금처럼 독립적으로 1부터 센다.
    function renumber() {
        const counters = [];
        const walk = (scope) => {
            for (const b of Array.from(scope.children).filter((n) => n.classList && n.classList.contains('be-block'))) {
                const type = b.dataset.type;
                if (type === 'columns') { // 열을 왼쪽부터 훑어 카운터를 이어간다
                    b.querySelectorAll(':scope > .be-main > .be-cols > .be-col').forEach((c) => walk(c));
                    continue;
                }
                if (!LISTY.has(type)) {
                    counters.length = 0;
                    continue;
                }
                const d = Math.min(Number(b.dataset.indent) || 0, 4);
                counters.length = d + 1;
                const row = b.querySelector('.be-li');
                if (row)
                    row.style.paddingLeft = (d * 26) + 'px';
                const marker = b.querySelector('.be-marker');
                if (type === 'numbered') {
                    counters[d] = (counters[d] || 0) + 1;
                    if (marker)
                        marker.textContent = counters[d] + '.';
                }
                else {
                    counters[d] = 0;
                    if (marker)
                        marker.textContent = ['•', '◦', '▪', '▹', '·'][d] || '•';
                }
            }
        };
        walk(root);
        root.querySelectorAll('.be-togglekids').forEach((c) => renumberIn(c)); // 토글 자식은 독립 흐름
    }
    // #657n 구조 정규화 — 빈 컬럼 정리(1열 이하면 해체), 빈 토글엔 빈 문단 채움. 컨테이너 간 이동/삭제 뒤 호출.
    function normalizeStructure() {
        root.querySelectorAll('.be-block[data-type="columns"]').forEach((cb) => {
            const colsWrap = cb.querySelector(':scope > .be-main > .be-cols');
            if (!colsWrap)
                return;
            const cols = Array.from(colsWrap.children).filter((c) => c.classList.contains('be-col'));
            const hasBlock = (c) => Array.from(c.children).some((n) => n.classList && n.classList.contains('be-block'));
            const nonEmpty = cols.filter(hasBlock);
            if (nonEmpty.length <= 1) {
                // 해체 — 남은 블록을 컬럼 자리에 펼치고 컨테이너 제거(노션 동일).
                let anchor = cb;
                nonEmpty.forEach((c) => Array.from(c.children).forEach((n) => {
                    if (n.classList && n.classList.contains('be-block')) {
                        anchor.after(n);
                        anchor = n;
                    }
                }));
                cb.remove();
            }
            else {
                cols.forEach((c) => { if (!hasBlock(c))
                    c.remove(); });
            }
        });
        root.querySelectorAll('.be-togglekids').forEach((k) => {
            if (!Array.from(k.children).some((n) => n.classList && n.classList.contains('be-block'))) {
                k.append(makeBlock({ type: 'p', text: '' }));
            }
        });
        ensureOne();
        renumber();
    }
    // 블록 복제(⌘D)·이동(⌘⇧↑↓)·삭제 — 핸들 메뉴/단축키 공용.
    function duplicateBlock(block) {
        const nb = makeBlock(blockData(block));
        block.after(nb);
        renumber();
        markDirty();
        focusBlock(nb, false);
    }
    function moveBlockDir(block, dir) {
        const sib = dir < 0 ? block.previousElementSibling : block.nextElementSibling;
        if (!sib || !sib.classList.contains('be-block'))
            return;
        if (dir < 0)
            sib.before(block);
        else
            sib.after(block);
        renumber();
        markDirty();
        const t = textElOf(block);
        if (t)
            t.focus();
    }
    function deleteBlock(block) {
        const nb = nextTextBlock(block) || prevTextBlock(block);
        block.remove();
        normalizeStructure();
        markDirty();
        if (nb && nb.isConnected)
            focusBlock(nb, false);
    }
    function ensureOne() {
        if (!blockEls().length)
            root.append(makeBlock({ type: 'p', text: '' }));
        root.classList.toggle('be-empty', isEmptyNow());
        // 에디터가 통째로 빈 상태(유일한 빈 문단) — 그 블록에 에디터 수준 안내 플레이스홀더를 얹는다(포커스 없이도 노출).
        const bs = blockEls();
        if (bs.length === 1 && bs[0].dataset.type === 'p' && opts.placeholder) {
            const t = textElOf(bs[0]);
            if (t)
                t.dataset.ph = opts.placeholder;
        }
    }
    function isEmptyNow() {
        const bs = blockEls();
        return bs.length === 1 && bs[0].dataset.type === 'p' && !(textElOf(bs[0]) || { textContent: '' }).textContent;
    }
    function focusBlock(block, atStart = true) {
        const t = textElOf(block);
        if (t) {
            t.focus();
            placeCaret(t, atStart);
            return;
        }
        const focusable = block.querySelector('.be-div, .be-raw, .be-pagecard, .be-collection');
        if (focusable)
            focusable.focus();
    }
    // 타입 변환 — 인라인 내용 보존(문단↔제목↔목록↔인용↔콜아웃), 코드/구분선/이미지는 내용 규칙에 맞게.
    //  토글 → 다른 유형은 자식을 밖(아래)으로 펼쳐 데이터 유실 방지(#657n).
    function convertBlock(block, to) {
        const cur = blockData(block);
        const baseText = cur.text !== undefined ? cur.text : (cur.summary || '');
        const data = { ...to, text: to.text !== undefined ? to.text : (baseText || '') };
        const nb = makeBlock(data);
        block.replaceWith(nb);
        if (cur.type === 'toggle' && to.type !== 'toggle' && Array.isArray(cur.children) && cur.children.length) {
            let anchor = nb;
            for (const c of cur.children) {
                const cb = makeBlock(c);
                anchor.after(cb);
                anchor = cb;
            }
        }
        ensureOne();
        renumber();
        markDirty();
        focusBlock(nb, false);
        return nb;
    }
    function insertBlockAfter(block, data) {
        const nb = makeBlock(data);
        if (block)
            block.after(nb);
        else
            root.append(nb);
        ensureOne();
        renumber();
        markDirty();
        return nb;
    }
    // 토글 전환(공용) — 슬래시 '/토글' 과 마크다운 '> '(노션: > = 토글) 둘 다 사용. 현재 텍스트를 요약으로 옮기고 빈 자식 1개.
    function toToggleBlock(b, summaryText) {
        const nb = makeBlock({ type: 'toggle', summary: String(summaryText || '').replace(/\n+/g, ' '), children: [{ type: 'p', text: '' }] });
        b.replaceWith(nb);
        ensureOne();
        renumber();
        markDirty();
        const sum = nb.querySelector('.be-togglesum');
        if (sum) {
            sum.focus();
            placeCaret(sum, false);
        }
        return nb;
    }
    return { blockEls, blockOf, textElOf, prevTextBlock, nextTextBlock, blockData, renumber, normalizeStructure,
        duplicateBlock, moveBlockDir, deleteBlock, ensureOne, isEmptyNow, focusBlock, convertBlock, insertBlockAfter, toToggleBlock };
}
