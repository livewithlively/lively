// editor/slash.ts — '/' 슬래시 메뉴(#1313 R58 — block-editor.ts '슬래시 메뉴' 절 verbatim 적출).
//  SLASH_ITEMS 는 이 파일이 단일 소유자다 — 툴바의 전환 드롭다운(toolbar.ts)과 ⋮⋮ 블록 메뉴(interactions.ts)도
//  같은 배열을 ctx 로 받아 쓴다(항목 추가는 여기 한 곳).
import { el } from '../core.js';
import { caretRange, insertText, placeCaret } from './caret.js';
export function createSlash(ctx) {
    const { root, opts, st } = ctx;
    // 늦은 바인딩 별칭(context.ts 참조).
    const textElOf = (block) => ctx.textElOf(block);
    const blockData = (block) => ctx.blockData(block);
    const convertBlock = (block, to) => ctx.convertBlock(block, to);
    const insertBlockAfter = (block, data) => ctx.insertBlockAfter(block, data);
    const focusBlock = (block, atStart) => ctx.focusBlock(block, atStart);
    const makeBlock = (d) => ctx.makeBlock(d);
    const ensureOne = () => ctx.ensureOne();
    const renumber = () => ctx.renumber();
    const markDirty = () => ctx.markDirty();
    const toToggleBlock = (b, summaryText) => ctx.toToggleBlock(b, summaryText);
    const openRawEditor = (block, wrap) => ctx.openRawEditor(block, wrap);
    const promptPageCard = (block) => ctx.promptPageCard(block);
    const promptImage = (block) => ctx.promptImage(block);
    const pickAndUploadFile = (block, asImage) => ctx.pickAndUploadFile(block, asImage);
    const insertLinkAtBlock = (block, bookmark) => ctx.insertLinkAtBlock(block, bookmark);
    const wrapOrInsertInline = (tag) => ctx.wrapOrInsertInline(tag);
    const syncMention = (target) => ctx.syncMention(target);
    const beToday = () => ctx.beToday();
    // ════════ 슬래시 메뉴 ════════
    const SLASH_ITEMS = [
        { k: 'text', ic: '¶', label: '텍스트', hint: '일반 문단', kw: 'text plain 텍스트 문단 본문', apply: (b) => convertBlock(b, { type: 'p' }) },
        { k: 'h1', ic: 'H1', label: '제목 1', hint: '큰 섹션 제목', kw: 'h1 # heading title 제목 헤딩 대제목', apply: (b) => convertBlock(b, { type: 'h', level: 1 }) },
        { k: 'h2', ic: 'H2', label: '제목 2', hint: '중간 제목', kw: 'h2 ## heading 제목 소제목', apply: (b) => convertBlock(b, { type: 'h', level: 2 }) },
        { k: 'h3', ic: 'H3', label: '제목 3', hint: '작은 제목', kw: 'h3 ### heading 제목', apply: (b) => convertBlock(b, { type: 'h', level: 3 }) },
        { k: 'bullet', ic: '•', label: '글머리 기호 목록', hint: '- 목록', kw: 'bullet list ul unordered 목록 글머리 리스트 점', apply: (b) => convertBlock(b, { type: 'bullet', indent: 0 }) },
        { k: 'numbered', ic: '1.', label: '번호 매기기 목록', hint: '1. 2. 3.', kw: 'numbered ordered ol list 번호 목록 리스트 숫자', apply: (b) => convertBlock(b, { type: 'numbered', indent: 0 }) },
        { k: 'todo', ic: '☑', label: '할 일 목록', hint: '체크박스', kw: 'todo [] checkbox check task 할일 체크 체크박스 체크리스트', apply: (b) => convertBlock(b, { type: 'todo', indent: 0, checked: false }) },
        { k: 'toggle', ic: '▸', label: '토글', hint: '접고 펼치는 블록', kw: 'toggle > collapse details 토글 접기 펼치기 드롭다운', apply: (b) => {
                const cur = blockData(b);
                toToggleBlock(b, String(cur.text !== undefined ? cur.text : (cur.summary || '')));
            } },
        { k: 'columns', ic: '⫴', label: '2열 컬럼', hint: '블록을 나란히 — 드래그로도 생성', kw: 'columns column 컬럼 열 나란히 레이아웃 layout 분할', apply: (b) => {
                const cur = blockData(b);
                const hasText = String(cur.text !== undefined ? cur.text : (cur.summary || '')).trim();
                const nb = makeBlock({ type: 'columns', cols: [[hasText ? cur : { type: 'p', text: '' }], [{ type: 'p', text: '' }]] });
                b.replaceWith(nb);
                ensureOne();
                renumber();
                markDirty();
                const ft = nb.querySelector('.be-col .be-text');
                if (ft) {
                    ft.focus();
                    placeCaret(ft, false);
                }
            } },
        { k: 'quote', ic: '❝', label: '인용', hint: '인용 블록', kw: 'quote " blockquote 인용 인용구 블록쿼트', apply: (b) => convertBlock(b, { type: 'quote' }) },
        { k: 'callout', ic: '💡', label: '콜아웃', hint: '아이콘 강조 상자', kw: 'callout note 콜아웃 강조 배너 안내 노트', apply: (b) => convertBlock(b, { type: 'callout', icon: '💡', color: 'default' }) },
        { k: 'code', ic: '</>', label: '코드', hint: '코드 블록', kw: 'code ``` snippet codeblock 코드 소스 코드블록', apply: (b) => convertBlock(b, { type: 'code', lang: '' }) },
        { k: 'equation', ic: '∑', label: '수식', hint: 'LaTeX 블록 수식($$)', kw: 'equation math latex tex formula 수식 수학 공식', apply: (b) => {
                const cur = blockData(b);
                const tmpl = '$$\n\n$$';
                let nb;
                if (b.dataset.type === 'p' && !String(cur.text || '').trim())
                    nb = convertBlock(b, { type: 'raw', text: tmpl });
                else
                    nb = insertBlockAfter(b, { type: 'raw', text: tmpl });
                const wrap = nb.querySelector('.be-raw');
                if (wrap)
                    openRawEditor(nb, wrap);
            } },
        { k: 'divider', ic: '—', label: '구분선', hint: '수평선', kw: 'divider --- hr line rule separator 구분선 나누기 수평선', apply: (b) => {
                const cur = blockData(b);
                if (!String(cur.text || '').trim()) {
                    const nb = convertBlock(b, { type: 'divider', text: undefined });
                    const p = insertBlockAfter(nb, { type: 'p', text: '' });
                    focusBlock(p);
                }
                else {
                    const d = insertBlockAfter(b, { type: 'divider' });
                    const p = insertBlockAfter(d, { type: 'p', text: '' });
                    focusBlock(p);
                }
            } },
        { k: 'pagecard', ic: '🔗', label: '페이지 카드', hint: '문서를 카드로 배치', kw: 'page card link 페이지 카드 문서 링크 smart 스마트', apply: (b) => promptPageCard(b) },
        { k: 'collection', ic: '▤', label: '컬렉션 (라이브 목록)', hint: '조건에 맞는 문서 자동 목록', kw: 'collection database view live 컬렉션 목록 라이브 데이터베이스 자동 최신', apply: (b) => {
                const cur = blockData(b);
                const data = { type: 'collection', attrs: { limit: 5, view: 'list', sort: 'updated' } };
                let nb;
                const empty = b.dataset.type === 'p' && !String(cur.text || '').trim();
                if (empty) {
                    nb = makeBlock(data);
                    b.replaceWith(nb);
                    ensureOne();
                    renumber();
                    markDirty();
                }
                else
                    nb = insertBlockAfter(b, data);
                const gear = nb.querySelector('.be-coll-gear');
                if (gear)
                    setTimeout(() => gear.click(), 0); // 삽입 즉시 조건 설정 열기
            } },
        { k: 'image', ic: '🖼', label: '이미지', hint: 'URL 로 삽입', kw: 'image picture 이미지 사진 그림', apply: (b) => promptImage(b) },
        { k: 'table', ic: '▦', label: '표', hint: '칸을 눌러 바로 편집합니다', kw: 'table 표 테이블', apply: (b) => {
                const tmpl = '| 열 1 | 열 2 |\n| --- | --- |\n|  |  |';
                const cur = blockData(b);
                let nb;
                if (!String(cur.text || '').trim())
                    nb = convertBlock(b, { type: 'raw', text: tmpl });
                else
                    nb = insertBlockAfter(b, { type: 'raw', text: tmpl });
                const wrap = nb.querySelector('.be-raw');
                if (wrap)
                    openRawEditor(nb, wrap);
            } },
        // ── #730 확장: 제목4 · 미디어(업로드/링크) · 인라인 삽입 · 서식 ──
        { k: 'h4', ic: 'H4', label: '제목 4', hint: '더 작은 제목', kw: 'h4 #### heading 제목 소제목', apply: (b) => convertBlock(b, { type: 'h', level: 4 }) },
        { k: 'imageup', ic: '📤', label: '이미지 업로드', hint: '내 기기에서 올리기', kw: 'image upload file photo 이미지 업로드 사진 그림 파일', up: true, apply: (b) => pickAndUploadFile(b, true) },
        { k: 'attach', ic: '📎', label: '첨부 파일', hint: '파일 올려 링크로', kw: 'attachment file upload download 첨부 파일 업로드 다운로드', up: true, apply: (b) => pickAndUploadFile(b, false) },
        { k: 'bookmark', ic: '🔖', label: '북마크 / 링크 카드', hint: '웹 주소를 링크로', kw: 'bookmark link url web embed 북마크 링크 주소 웹 카드 임베드', apply: (b) => insertLinkAtBlock(b, true) },
        { k: 'link', ic: '🔗', label: '링크', hint: '하이퍼링크 삽입', kw: 'link url hyperlink 링크 주소 하이퍼링크', apply: (b) => insertLinkAtBlock(b, false) },
        { k: 'mppage', ic: '@', label: '페이지 멘션', hint: '다른 지식 문서 링크', kw: 'mention page link doc 멘션 페이지 문서 링크 지식 앳', apply: (b) => { const t = textElOf(b); if (t) {
                t.focus();
                insertText('[[');
                syncMention(t);
            } } },
        { k: 'date', ic: '📅', label: '오늘 날짜', hint: 'YYYY-MM-DD', kw: 'date today time now 날짜 오늘 시간', apply: (b) => { const t = textElOf(b); if (t) {
                t.focus();
                insertText(beToday());
                markDirty();
            } } },
        { k: 'bold', ic: 'B', label: '굵게', hint: '**굵게**', kw: 'bold strong 굵게 볼드 강조', apply: () => { document.execCommand('bold'); markDirty(); } },
        { k: 'italic', ic: '𝑖', label: '기울임', hint: '*기울임*', kw: 'italic em 기울임 이탤릭', apply: () => { document.execCommand('italic'); markDirty(); } },
        { k: 'underline', ic: 'U̲', label: '밑줄', hint: '++밑줄++', kw: 'underline 밑줄', apply: () => { document.execCommand('underline'); markDirty(); } },
        { k: 'strike', ic: 'S̶', label: '취소선', hint: '~~취소선~~', kw: 'strike strikethrough 취소선 지움', apply: () => { document.execCommand('strikeThrough'); markDirty(); } },
        { k: 'icode', ic: '</>', label: '인라인 코드', hint: '`코드`', kw: 'code inline mono 코드 인라인 모노', apply: () => wrapOrInsertInline('code') },
        { k: 'highlight', ic: '🖍', label: '형광펜', hint: '==강조==', kw: 'highlight mark 형광펜 강조 마커 하이라이트', apply: () => wrapOrInsertInline('mark') },
        { k: 'clearfmt', ic: '⌫', label: '서식 지우기', hint: '선택 서식 제거', kw: 'clear format remove clean 서식 지우기 초기화 제거', apply: () => { document.execCommand('removeFormat'); document.execCommand('unlink'); markDirty(); } },
    ];
    // #764 슬래시 항목 단축키 표기 — 마크다운 프리픽스(줄머리 '# ' 등)와 키보드 단축을 메뉴 우측 kbd 로.
    const _isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
    const _MOD = _isMac ? '⌘' : 'Ctrl+';
    const _SFT = _isMac ? '⇧' : 'Shift+';
    const SLASH_SC = {
        h1: '#', h2: '##', h3: '###', h4: '####',
        bullet: '-', numbered: '1.', todo: '[]', toggle: '>', quote: '"', code: '```', divider: '---',
        bold: _MOD + 'B', italic: _MOD + 'I', underline: _MOD + 'U', icode: _MOD + 'E', highlight: _MOD + _SFT + 'H',
    };
    SLASH_ITEMS.forEach((it) => { if (SLASH_SC[it.k])
        it.sc = SLASH_SC[it.k]; });
    // #730 슬래시 카테고리(클릭업/노션식 섹션 그룹핑). k → 카테고리.
    const SLASH_CAT = {
        text: 'basic', h1: 'basic', h2: 'basic', h3: 'basic', h4: 'basic',
        bullet: 'list', numbered: 'list', todo: 'list', toggle: 'list',
        quote: 'block', callout: 'block', divider: 'block', code: 'block', equation: 'block', columns: 'block', table: 'block', pagecard: 'block', collection: 'block',
        image: 'media', imageup: 'media', attach: 'media', bookmark: 'media',
        link: 'inline', mppage: 'inline', date: 'inline',
        bold: 'format', italic: 'format', underline: 'format', strike: 'format', icode: 'format', highlight: 'format', clearfmt: 'format',
    };
    const SLASH_CAT_ORDER = [['basic', '기본'], ['list', '목록'], ['block', '블록'], ['media', '미디어'], ['inline', '인라인'], ['format', '서식']];
    const slashCatIndex = (k) => { const c = SLASH_CAT[k] || 'block'; const i = SLASH_CAT_ORDER.findIndex(([kk]) => kk === c); return i < 0 ? 99 : i; };
    // 열린 메뉴 세션은 ctx.st.slash — { block, anchorNode, anchorOffset, menu, items, sel, typed }
    function openSlashMenu(block, typed) {
        closeSlashMenu();
        const r = caretRange();
        const menu = el('div', { class: 'be-slash', role: 'menu' });
        document.body.append(menu);
        st.slash = { block, menu, sel: 0, typed, query: '',
            anchorNode: r ? r.startContainer : null, anchorOffset: r ? r.startOffset : 0 };
        paintSlash();
        positionSlash(block);
    }
    function positionSlash(block) {
        if (!st.slash)
            return;
        const r = caretRange();
        let rect = r ? r.getBoundingClientRect() : null;
        if (!rect || (!rect.width && !rect.height && !rect.top))
            rect = block.getBoundingClientRect();
        const m = st.slash.menu;
        const h = Math.min(m.scrollHeight || 320, 320);
        m.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 320)) + 'px';
        m.style.top = (rect.bottom + 6 + h > window.innerHeight ? Math.max(8, rect.top - h - 6) : rect.bottom + 6) + 'px';
    }
    function slashCandidates() {
        const q = (st.slash.query || '').trim().toLowerCase();
        // 업로드형 명령(up)은 uploadFile 콜백이 있을 때만 노출. 카테고리 순서로 정렬(그룹 헤더용).
        return SLASH_ITEMS
            .filter((it) => (!it.up || !!opts.uploadFile) && (!q || it.label.toLowerCase().includes(q) || it.kw.includes(q) || it.k.includes(q)))
            .slice().sort((a, b) => slashCatIndex(a.k) - slashCatIndex(b.k));
    }
    function paintSlash() {
        if (!st.slash)
            return;
        const items = slashCandidates();
        st.slash.items = items;
        if (st.slash.sel >= items.length)
            st.slash.sel = Math.max(0, items.length - 1);
        if (!items.length) {
            st.slash.menu.replaceChildren(el('div', { class: 'be-slash-empty', text: '결과 없음' }));
            return;
        }
        const kids = [];
        let lastCat = '';
        items.forEach((it, idx) => {
            const cat = SLASH_CAT[it.k] || 'block';
            if (cat !== lastCat) {
                lastCat = cat;
                const found = SLASH_CAT_ORDER.find(([k]) => k === cat);
                kids.push(el('div', { class: 'be-slash-head', text: found ? found[1] : '블록' }));
            }
            const row = el('button', { class: 'be-slash-item' + (idx === st.slash.sel ? ' on' : ''), type: 'button', role: 'menuitem' }, el('span', { class: 'be-slash-ic', text: it.ic }), el('span', { class: 'be-slash-label', text: it.label }), el('span', { class: 'be-slash-hint', text: it.hint }), it.sc ? el('kbd', { class: 'be-slash-sc', text: it.sc }) : null);
            row.addEventListener('mousedown', (e) => e.preventDefault()); // 포커스/선택 유지
            row.onclick = () => applySlash(it);
            kids.push(row);
        });
        st.slash.menu.replaceChildren(...kids);
        const onEl = st.slash.menu.querySelector('.be-slash-item.on');
        if (onEl && onEl.scrollIntoView)
            onEl.scrollIntoView({ block: 'nearest' });
    }
    function closeSlashMenu() {
        if (!st.slash)
            return;
        st.slash.menu.remove();
        st.slash = null;
    }
    // '/query' 텍스트 제거 후 항목 적용.
    function applySlash(item) {
        const s = st.slash;
        closeSlashMenu();
        if (!s)
            return;
        if (s.typed && s.anchorNode && s.anchorNode.nodeType === 3) {
            // '/'(anchorOffset-1)부터 캐럿까지 삭제 — 같은 텍스트 노드 내 타이핑 가정(조합 포함).
            try {
                const node = s.anchorNode;
                const from = Math.max(0, s.anchorOffset - 1);
                const to = from + 1 + (s.query || '').length;
                node.textContent = node.textContent.slice(0, from) + node.textContent.slice(Math.min(to, node.textContent.length));
                const t = textElOf(s.block);
                if (t) {
                    t.focus();
                    const rr = document.createRange();
                    rr.setStart(node, Math.min(from, node.textContent.length));
                    rr.collapse(true);
                    const ss = window.getSelection();
                    ss.removeAllRanges();
                    ss.addRange(rr);
                }
            }
            catch (_) { /* 노드가 바뀐 드문 경우 — 텍스트 잔존만(기능은 계속) */ }
        }
        item.apply(s.block);
    }
    // 슬래시 쿼리 재계산(input 마다) — '/' 뒤 텍스트. '/' 가 사라졌으면 닫기.
    function syncSlashQuery() {
        if (!st.slash)
            return;
        const n = st.slash.anchorNode;
        if (!n || n.nodeType !== 3 || !root.contains(n)) {
            closeSlashMenu();
            return;
        }
        const txt = n.textContent || '';
        const from = Math.max(0, st.slash.anchorOffset - 1);
        if (txt[from] !== '/') {
            closeSlashMenu();
            return;
        }
        const r = caretRange();
        if (!r || r.startContainer !== n) {
            closeSlashMenu();
            return;
        }
        st.slash.query = txt.slice(from + 1, r.startOffset);
        if (/\s/.test(st.slash.query)) {
            closeSlashMenu();
            return;
        } // 공백 = 메뉴 포기(노션 동일)
        paintSlash();
        positionSlash(st.slash.block);
    }
    return { SLASH_ITEMS, openSlashMenu, closeSlashMenu, applySlash, paintSlash, syncSlashQuery };
}
