// editor/insert.ts — 이미지/파일/링크/인라인 마크 삽입 헬퍼(#1313 R58 — block-editor.ts #730 삽입 절 verbatim 적출).
//  슬래시 메뉴·붙여넣기·드롭이 공용으로 쓴다.
import { el, safeHref, toast } from '../core.js';
import { overlayBox } from '../learn.js';
import { caretRange } from './caret.js';
export function createInsert(ctx) {
    const { opts } = ctx;
    // 늦은 바인딩 별칭(context.ts 참조).
    const blockData = (block) => ctx.blockData(block);
    const convertBlock = (block, to) => ctx.convertBlock(block, to);
    const insertBlockAfter = (block, data) => ctx.insertBlockAfter(block, data);
    const focusBlock = (block, atStart) => ctx.focusBlock(block, atStart);
    const markDirty = () => ctx.markDirty();
    const openLinkPop = () => ctx.openLinkPop();
    const toggleWrap = (tag) => ctx.toggleWrap(tag);
    function promptImage(block) {
        const urlIn = el('input', { type: 'text', placeholder: 'https://… 이미지 주소', style: 'width:100%' });
        const altIn = el('input', { type: 'text', placeholder: '설명(alt, 선택)', style: 'width:100%' });
        const goBtn = el('button', { class: 'btn btn-primary', text: '삽입' });
        const back = overlayBox('이미지 삽입', el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이미지 URL' }), urlIn), el('div', { class: 'field', style: 'margin-top:10px' }, el('label', { class: 'field-label', text: '설명' }), altIn), el('div', { class: 'ov-actions' }, goBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
        setTimeout(() => urlIn.focus(), 0);
        const go = () => {
            const u = urlIn.value.trim();
            if (!safeHref(u) || !/^https?:\/\//i.test(u)) {
                toast('https:// 로 시작하는 이미지 URL 을 입력하세요', true);
                return;
            }
            back.remove();
            const md = '![' + altIn.value.trim().replace(/\]/g, '') + '](' + u + ')';
            const cur = blockData(block);
            let nb;
            if (!String(cur.text || '').trim())
                nb = convertBlock(block, { type: 'p', text: md });
            else
                nb = insertBlockAfter(block, { type: 'p', text: md });
            focusBlock(nb, false);
        };
        goBtn.onclick = go;
        urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing)
            go(); });
    }
    // ── #730 파일/이미지/링크/서식 삽입 헬퍼 (슬래시·붙여넣기·드롭 공용) ──
    function beToday() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
    // 마크다운 조각을 현재 블록에 넣는다(빈 문단이면 대체, 아니면 아래 새 블록). promptImage 와 동일 결.
    function insertMdBlock(block, md) {
        const cur = blockData(block);
        let nb;
        if (block.dataset.type === 'p' && !String(cur.text || '').trim())
            nb = convertBlock(block, { type: 'p', text: md });
        else
            nb = insertBlockAfter(block, { type: 'p', text: md });
        focusBlock(nb, false);
        return nb;
    }
    // 업로드된 이미지들을 순차로 넣는다(플레이스홀더 → 업로드 → 이미지 md 로 교체).
    async function insertUploadedImages(block, files) {
        if (!opts.uploadFile)
            return;
        let anchor = block;
        for (let i = 0; i < files.length; i++) {
            const cur = blockData(anchor);
            const empty = i === 0 && anchor.dataset.type === 'p' && !String(cur.text || '').trim();
            const ph = empty ? convertBlock(anchor, { type: 'p', text: '⬆︎ 이미지 업로드 중…' }) : insertBlockAfter(anchor, { type: 'p', text: '⬆︎ 이미지 업로드 중…' });
            anchor = ph;
            markDirty();
            try {
                const url = await opts.uploadFile(files[i]);
                anchor = convertBlock(ph, { type: 'p', text: url ? '![](' + url + ')' : '(이미지 업로드 실패)' });
            }
            catch (_) {
                anchor = convertBlock(ph, { type: 'p', text: '(이미지 업로드 실패)' });
            }
            markDirty();
        }
        focusBlock(anchor, false);
        if (opts.onChange)
            opts.onChange();
    }
    // 파일 선택 → 업로드 → 이미지면 ![](), 아니면 [📎 파일명](url) 링크.
    function pickAndUploadFile(block, asImage) {
        if (!opts.uploadFile)
            return;
        const inp = el('input', { type: 'file', accept: asImage ? 'image/*' : '', style: 'position:fixed;left:-9999px' });
        document.body.append(inp);
        inp.addEventListener('change', async () => {
            const f = inp.files && inp.files[0];
            inp.remove();
            if (!f)
                return;
            if (asImage) {
                await insertUploadedImages(block, [f]);
                return;
            }
            const ph = insertMdBlock(block, '⬆︎ 첨부 업로드 중…');
            try {
                const url = await opts.uploadFile(f);
                convertBlock(ph, { type: 'p', text: url ? '[📎 ' + f.name.replace(/[[\]]/g, '') + '](' + url + ')' : '(첨부 업로드 실패)' });
            }
            catch (_) {
                convertBlock(ph, { type: 'p', text: '(첨부 업로드 실패)' });
            }
            markDirty();
            if (opts.onChange)
                opts.onChange();
        });
        inp.click();
    }
    // 링크/북마크 — 선택이 있으면 그 선택에 링크(툴바 팝오버), 없으면 주소·표시텍스트를 물어 인라인 링크 삽입.
    function insertLinkAtBlock(block, bookmark) {
        const r = caretRange();
        if (r && !r.collapsed) {
            openLinkPop();
            return;
        }
        const urlIn = el('input', { type: 'text', placeholder: 'https://…', style: 'width:100%' });
        const txtIn = el('input', { type: 'text', placeholder: bookmark ? '표시 이름(선택)' : '표시할 텍스트(선택)', style: 'width:100%' });
        const goBtn = el('button', { class: 'btn btn-primary', text: '삽입' });
        const back = overlayBox(bookmark ? '링크 카드' : '링크 삽입', el('div', { class: 'field' }, el('label', { class: 'field-label', text: '주소' }), urlIn), el('div', { class: 'field', style: 'margin-top:10px' }, el('label', { class: 'field-label', text: '표시 텍스트' }), txtIn), el('div', { class: 'ov-actions' }, goBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
        setTimeout(() => urlIn.focus(), 0);
        const go = () => {
            const u = urlIn.value.trim();
            if (!safeHref(u) || !/^(https?:\/\/|#\/)/i.test(u)) {
                toast('https:// 또는 #/… 주소를 입력하세요', true);
                return;
            }
            back.remove();
            const label = (txtIn.value.trim() || u).replace(/[[\]]/g, '');
            insertMdBlock(block, (bookmark ? '🔖 ' : '') + '[' + label + '](' + u + ')');
            markDirty();
            if (opts.onChange)
                opts.onChange();
        };
        goBtn.onclick = go;
        urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing)
            go(); });
    }
    // 인라인 마크(code/mark) — 선택이 있으면 감싸고, 없으면 빈 래퍼를 넣고 그 안에 캐럿(다음 타이핑이 안에 들어감).
    function wrapOrInsertInline(tag) {
        const r = caretRange();
        if (r && !r.collapsed) {
            toggleWrap(tag);
            markDirty();
            return;
        }
        if (!r)
            return;
        const wrap = el(tag, tag === 'code' ? { class: 'md-code' } : (tag === 'mark' ? { class: 'md-mark' } : {}));
        wrap.append(document.createTextNode('​'));
        try {
            r.insertNode(wrap);
            const s = window.getSelection();
            const nr = document.createRange();
            nr.setStart(wrap.firstChild, 1);
            nr.collapse(true);
            s.removeAllRanges();
            s.addRange(nr);
        }
        catch (_) { /* 경계 드문 케이스 */ }
        markDirty();
    }
    return { promptImage, beToday, insertMdBlock, insertUploadedImages, pickAndUploadFile, insertLinkAtBlock, wrapOrInsertInline };
}
