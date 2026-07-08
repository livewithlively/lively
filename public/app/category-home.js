// category-home.ts — #657(#658·#659) 카테고리 대문(노션 팀스페이스 홈처럼). 카테고리를 열면 커버+아이콘+제목+설명+
//  꾸밀 수 있는 대문 본문이 목록 위에 뜬다. **스키마 변경 0** — 대문의 모든 사용자화는 카테고리당 지식 문서
//  `category-home-<key>` 하나에 담는다(본문 = body_md, 아이콘/커버 = props_ui.icon/cover). 이 문서는
//  WIKI 목록/트리에서 숨긴다(isCategoryHomeDoc — knowledge.ts 필터).
//  권한: 대문 본문·아이콘·커버 = memory(지식 편집과 동일 — 팀 전체가 꾸밀 수 있게, 노션과 같은 개방성),
//        제목/설명 rename = context(카테고리 소유 필드 — category_update).
//  순환 import 금지: core/admin/block-editor/page-decor 만 import(knowledge.ts 가 이 모듈을 쓴다).
import { api, el, renderMarkdown, toast } from './core.js';
import { hasScope } from './admin.js';
import { createBlockEditor } from './block-editor.js';
import { applyCoverBg, defaultCoverFor, openCoverPicker, openEmojiPicker } from './page-decor.js';
const HOME_PREFIX = 'category-home-';
// 빈 대문 본문 자리표시 — knowledge_save 가 빈 body 를 거부해(비폴더), 보이지 않는 ZWSP 1자로 저장한다.
const HOME_EMPTY = '\u200B';
function homeDocName(cat) { return HOME_PREFIX + (cat.key || cat.id); }
// WIKI 목록/트리/검색에서 대문 문서를 숨길 때 쓰는 판별자(knowledge.ts 등에서 import).
function isCategoryHomeDoc(name) { return String(name || '').startsWith(HOME_PREFIX); }
// 카테고리 대문 렌더 — slot 내부를 통째로 그린다.
//  opts: { actions?: Node[](우측 버튼들 — ＋새 페이지/＋폴더/⚙보기), onCatChanged?: ()=>void(rename 후 사이드바 갱신) }
async function buildCategoryHome(slot, cat, opts = {}) {
    const canDoc = hasScope('memory');
    const canCat = hasScope('context');
    slot.replaceChildren();
    // ── 대문 문서 로드(404 = 아직 사용자화 전 — 기본 대문) ──
    let home = null;
    try {
        home = await api('/api/ui/knowledge/' + encodeURIComponent(homeDocName(cat))).then((r) => r && (r.knowledge || r));
    }
    catch (_) {
        home = null;
    }
    const homeBody = () => {
        const b = (home && home.body_md) || '';
        return b === HOME_EMPTY ? '' : b;
    };
    // 첫 사용자화 시 대문 문서 생성(멱등) — 이후 본문/아이콘/커버가 이 문서에 산다.
    async function ensureHome(bodyMd) {
        const name = homeDocName(cat);
        if (home && home.name) {
            if (bodyMd !== undefined) {
                await api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify({ name, body_md: bodyMd || HOME_EMPTY }) });
                home.body_md = bodyMd || HOME_EMPTY;
            }
            return name;
        }
        const r = await api('/api/ui/knowledge', { method: 'POST', body: JSON.stringify({
                name,
                title: (cat.name || cat.key) + ' 대문',
                body_md: bodyMd || HOME_EMPTY,
                category: cat.key,
                type: 'reference',
            }) });
        home = (r && r.knowledge) || { name, body_md: bodyMd || HOME_EMPTY, props_ui: null };
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
    const cover = el('div', { class: 'cath-cover' });
    const iconBtn = el('button', { class: 'cath-icon', type: 'button', title: canDoc ? '아이콘 변경' : '' });
    function paintDecor() {
        const cv = (home && home.props_ui && home.props_ui.cover) || '';
        if (!applyCoverBg(cover, cv))
            applyCoverBg(cover, defaultCoverFor(cat.key || String(cat.id)));
        cover.replaceChildren(canDoc ? el('div', { class: 'kn-cover-btns cath-cover-btns' }, el('button', { class: 'ke-coverbtn', type: 'button', text: '커버 변경',
            onclick: (e) => openCoverPicker(e.target, { current: cv || null, onPick: (v) => saveDecor({ cover: v }) }) })) : null);
        const ic = (home && home.props_ui && home.props_ui.icon) || '';
        iconBtn.classList.toggle('cath-icon-letter', !ic);
        iconBtn.textContent = ic || String(cat.name || cat.key || '?').trim().charAt(0).toUpperCase();
    }
    if (canDoc) {
        iconBtn.onclick = () => openEmojiPicker(iconBtn, {
            title: '카테고리 아이콘',
            onPick: (em) => saveDecor({ icon: em }),
            onClear: (home && home.props_ui && home.props_ui.icon) ? () => saveDecor({ icon: null }) : undefined,
        });
    }
    paintDecor();
    // ── 제목/설명(카테고리 필드 — context 권한 인라인 편집) ──
    const titleEl = el('h1', { class: 'cath-title' + (canCat ? ' cath-editable' : ''),
        ...(canCat ? { contenteditable: 'true', spellcheck: 'false', title: '클릭해서 이름 변경' } : {}) });
    titleEl.textContent = cat.name || cat.key;
    const descEl = el('div', { class: 'cath-desc' + (canCat ? ' cath-editable' : ''),
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
                if (opts.onCatChanged)
                    opts.onCatChanged();
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
    // ── 대문 본문 — 블록 에디터(자동 저장). 읽기 전용 사용자에겐 렌더만(비면 생략). ──
    const bodyBox = el('div', { class: 'cath-body' });
    const saveChip = el('span', { class: 'kn-save-chip', 'aria-live': 'polite' });
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
        const editor = createBlockEditor({
            initial: homeBody(),
            placeholder: "대문을 꾸며보세요 — 공지·소개·핵심 문서 링크… ('/'로 콜아웃·제목·목록 추가)",
            onChange: queue,
            onSaveShortcut: () => { clearTimeout(timer); doSave(); },
        });
        editor.el.addEventListener('focusout', () => { if (editor.isDirty()) {
            clearTimeout(timer);
            doSave();
        } });
        bodyBox.append(editor.el);
    }
    else if (homeBody().trim()) {
        bodyBox.append(el('div', { class: 'md-rendered' }, renderMarkdown(homeBody())));
    }
    else {
        bodyBox.hidden = true;
    }
    // ── 조립 — mono 카탈로그 라인(공간 · 카테고리)이 대문의 '색인' 정체성을 준다(#657r). ──
    const SPACE_KO = { business: '사업', product: '제품', system: '시스템' };
    const metaEl = el('div', { class: 'cath-meta' }, el('span', { class: 'cath-meta-sp', text: SPACE_KO[cat.space] || cat.space || '카테고리' }), el('span', { class: 'cath-meta-sep', 'aria-hidden': 'true', text: '/' }), el('span', { class: 'cath-meta-key', text: cat.key }));
    const actionRow = el('div', { class: 'cath-actions' }, saveChip, ...(opts.actions || []).filter(Boolean));
    slot.append(el('div', { class: 'cath' }, cover, el('div', { class: 'cath-inner' }, iconBtn, el('div', { class: 'cath-headrow' }, el('div', { class: 'cath-headmain' }, metaEl, titleEl, descEl), actionRow), bodyBox)));
}
export { buildCategoryHome, isCategoryHomeDoc, homeDocName };
