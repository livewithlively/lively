// taskmodal/tags.ts — #1313 R56: web/taskmodal.ts 섹션 분할 ③(태그).
//  색 팔레트 · 편집 아이콘(기어/휴지통/없음/뒤로) · 태그 필드(칩+＋) · 태그 피커(검색·토글·색/이름·모든 태그 관리).
//  PJV_TAG_NONE 은 리스트뷰(projects/selection.ts)도 배럴 경유로 쓰는 공개 표면이다.
import { api, el, sv, toast } from '../core.js';
// 소유처 직결(#1313 R56) — 배럴 경유였다면 순환 가지가 늘어난다(composer.ts 주석과 같은 이유).
import { pjvPopover } from '../projects/popover.js';
import { pjvCheckMini } from '../projects/icons.js';
// ── 태그 색 팔레트(클릭업식) + 태그 편집 아이콘(기어/휴지통/없음/뒤로). ──
const PJV_TAG_COLORS = ['#8b7fd6', '#6b8fff', '#4aa3e0', '#2bb3a3', '#56b877', '#e0b341', '#e8853a', '#e98aa8', '#d96bb0', '#b07fd6', '#a98e7d', '#cfd6e0', '#98a3b5'];
const PJV_TAG_NONE = '#aab3c2';
function pjvtmGearIcon() {
    const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 12, r: 3 }));
    n.append(sv('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }));
    return n;
}
function pjvtmTrashIcon() {
    const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('polyline', { points: '4 7 20 7' }), sv('path', { d: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' }), sv('path', { d: 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12' }));
    return n;
}
function pjvtmNoneIcon() {
    const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'aria-hidden': 'true' });
    n.append(sv('circle', { cx: 12, cy: 12, r: 8 }), sv('line', { x1: 6.4, y1: 6.4, x2: 17.6, y2: 17.6 }));
    return n;
}
function pjvtmBackIcon() {
    const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('polyline', { points: '14 6 8 12 14 18' }));
    return n;
}
// 태그 — 칩 + 추가(자동완성). 색상은 등록시 랜덤/지정(여기선 팔레트 순환).
// 태그 필드 — 칩(색·× 제거) + Empty/＋. 변경은 로컬 갱신 + 백그라운드 저장(모달 풀 refresh 없이 부드럽게).
function pjvtmTagsField(d, t, refresh) {
    const wrap = el('div', { class: 'pjv-tm-tags' });
    const render = () => {
        wrap.replaceChildren();
        for (const tag of (d.tags || []))
            wrap.append(pjvtmTagChip(tag, () => removeTag(tag.id)));
        const addBtn = el('button', { class: 'pjv-tm-tagadd' + ((d.tags || []).length ? '' : ' empty'), type: 'button', text: (d.tags || []).length ? '＋' : 'Empty' });
        addBtn.onclick = (e) => { e.stopPropagation(); pjvtmTagPop(addBtn, d, t, render); };
        wrap.append(addBtn);
    };
    const removeTag = async (tagId) => {
        d.tags = (d.tags || []).filter((x) => x.id !== tagId);
        render();
        try {
            await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tagId, remove: true }) });
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
        }
    };
    render();
    return wrap;
}
function pjvtmTagChip(tag, onRemove) {
    const chip = el('span', { class: 'pjv-tm-tag', style: '--tag:' + (tag.color || PJV_TAG_NONE) }, el('span', { class: 'pjv-tm-tag-name', text: tag.name }));
    if (onRemove) {
        const x = el('button', { class: 'pjv-tm-tag-x', type: 'button', title: '제거', text: '✕' });
        x.onclick = (e) => { e.stopPropagation(); onRemove(); };
        chip.append(x);
    }
    return chip;
}
// 태그 피커(클릭업식) — 선택칩 + 검색/생성 입력 + 기존 태그 토글 + Create 행. 각 태그 기어 → 색/이름/삭제 뷰.
async function pjvtmTagPop(anchor, d, t, renderField) {
    const pop = el('div', { class: 'pjv-menu pjv-tm-tagpop' });
    pjvPopover(anchor, pop);
    let all = [];
    const loadAll = async () => { try {
        all = await api('/api/ui/v6/tags').then((r) => (r && r.tags) || []);
    }
    catch (_) {
        all = [];
    } };
    const selIds = () => new Set((d.tags || []).map((x) => x.id));
    await loadAll();
    function showList(query) {
        const input = el('input', { type: 'text', class: 'pjv-tm-taginput', placeholder: '태그 검색…', maxlength: '40', value: query || '' });
        const chips = el('div', { class: 'pjv-tm-tagpop-chips' });
        const list = el('div', { class: 'pjv-tm-tagresults' });
        const manageBtn = el('button', { class: 'pjv-tm-tagmanage-btn', type: 'button' }, pjvtmGearIcon(), el('span', { text: '모든 태그 관리' }));
        manageBtn.onclick = () => showManageAll();
        pop.replaceChildren(el('div', { class: 'pjv-tm-tagpop-top' }, chips, input), el('div', { class: 'pjv-tm-tagpop-head' }, el('span', { text: 'Select an option' })), list, manageBtn);
        setTimeout(() => { input.focus(); }, 0);
        const renderChips = () => chips.replaceChildren(...(d.tags || []).map((tag) => pjvtmTagChip(tag, () => persistRemove(tag.id))));
        const persistAdd = async (x) => {
            if (!selIds().has(x.id)) {
                d.tags = [...(d.tags || []), x];
                renderField();
                renderChips();
                renderList();
            }
            try {
                await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: x.id }) });
            }
            catch (e) {
                toast('실패 — ' + e.message, true);
            }
        };
        const persistRemove = async (tagId) => {
            d.tags = (d.tags || []).filter((x) => x.id !== tagId);
            renderField();
            renderChips();
            renderList();
            try {
                await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tagId, remove: true }) });
            }
            catch (e) {
                toast('실패 — ' + e.message, true);
            }
        };
        const renderList = () => {
            const qq = input.value.trim();
            const have = selIds();
            const cand = all.filter((x) => (!qq || x.name.toLowerCase().includes(qq.toLowerCase())));
            list.replaceChildren();
            for (const x of cand.slice(0, 40)) {
                const on = have.has(x.id);
                const row = el('button', { class: 'pjv-tm-tagrow' + (on ? ' sel' : ''), type: 'button' }, pjvCheckMini(on), el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (x.color || PJV_TAG_NONE) }), el('span', { class: 'pjv-tm-tagrow-name', text: x.name }));
                row.onclick = () => (on ? persistRemove(x.id) : persistAdd(x));
                const gear = el('button', { class: 'pjv-tm-tagrow-gear', type: 'button', title: '태그 편집' }, pjvtmGearIcon());
                gear.onclick = (e) => { e.stopPropagation(); showColor(x, input.value); };
                row.append(gear);
                list.append(row);
            }
            // 새 태그 생성은 '모든 태그 관리' 안에서만 — 검색창에선 만들지 않는다(검색·토글 전용).
            if (!list.children.length)
                list.append(el('div', { class: 'pjv-menu-empty', text: qq ? '검색 결과가 없습니다 — 새 태그는 아래 ‘모든 태그 관리’에서 만드세요.' : '태그가 없습니다 — ‘모든 태그 관리’에서 만드세요.' }));
        };
        input.addEventListener('input', renderList);
        input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter')
                return;
            const v = input.value.trim();
            if (!v)
                return;
            const exact = all.find((x) => x.name.toLowerCase() === v.toLowerCase());
            if (exact && !selIds().has(exact.id)) {
                persistAdd(exact);
                input.value = '';
                renderList();
            }
            // 일치하는 기존 태그가 없으면 아무 것도 하지 않음 — 새 태그 생성은 '모든 태그 관리'에서만.
        });
        renderChips();
        renderList();
    }
    function showColor(tag, backQuery, onBack) {
        const goBack = onBack || (() => showList(backQuery));
        const back = el('button', { class: 'pjv-tm-tagcolor-back', type: 'button', title: '뒤로' }, pjvtmBackIcon());
        back.onclick = goBack;
        const nameIn = el('input', { type: 'text', class: 'pjv-tm-tagcolor-name', value: tag.name, maxlength: '40' });
        const grid = el('div', { class: 'pjv-tm-tagcolor-grid' });
        const syncLocal = () => {
            all = all.map((a) => (a.id === tag.id ? { ...a, name: tag.name, color: tag.color } : a));
            d.tags = (d.tags || []).map((x) => (x.id === tag.id ? { ...x, name: tag.name, color: tag.color } : x));
        };
        const renderGrid = () => {
            grid.replaceChildren();
            for (const c of PJV_TAG_COLORS) {
                const sw = el('button', { class: 'pjv-tm-swatch' + (tag.color === c ? ' sel' : ''), type: 'button', style: 'background:' + c + ';color:' + c, 'aria-label': '색상' });
                sw.onclick = () => applyColor(c);
                grid.append(sw);
            }
            const none = el('button', { class: 'pjv-tm-swatch none' + (!tag.color ? ' sel' : ''), type: 'button', title: '색 없음' }, pjvtmNoneIcon());
            none.onclick = () => applyColor(null);
            grid.append(none);
        };
        const applyColor = async (c) => {
            tag.color = c;
            renderGrid();
            syncLocal();
            renderField();
            try {
                await api('/api/ui/v6/tags/' + tag.id, { method: 'POST', body: JSON.stringify({ color: c }) });
            }
            catch (e) {
                toast('실패 — ' + e.message, true);
            }
        };
        const rename = async () => {
            const v = nameIn.value.trim();
            if (!v || v === tag.name)
                return;
            try {
                const r = await api('/api/ui/v6/tags/' + tag.id, { method: 'POST', body: JSON.stringify({ name: v }) }).then((x) => x.tag);
                tag.name = r.name;
                syncLocal();
                renderField();
            }
            catch (e) {
                toast('이름 변경 실패 — ' + e.message, true);
                nameIn.value = tag.name;
            }
        };
        const del = el('button', { class: 'pjv-tm-tagdelete', type: 'button' }, pjvtmTrashIcon(), el('span', { text: 'Delete' }));
        del.onclick = async () => {
            if (!confirm("'" + tag.name + "' 태그를 삭제할까요?\n모든 태스크에서 제거됩니다."))
                return;
            try {
                await api('/api/ui/v6/tags/' + tag.id + '/delete', { method: 'POST', body: JSON.stringify({}) });
                d.tags = (d.tags || []).filter((x) => x.id !== tag.id);
                await loadAll();
                renderField();
                goBack();
            }
            catch (e) {
                toast('삭제 실패 — ' + e.message, true);
            }
        };
        nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
            e.preventDefault();
            rename();
        } });
        nameIn.addEventListener('blur', rename);
        pop.replaceChildren(el('div', { class: 'pjv-tm-tagcolor-top' }, back, nameIn), grid, el('div', { class: 'pjv-tm-tagcolor-sep' }), del);
        renderGrid();
        setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
    }
    // 모든 태그 관리(클릭업 Tag Manager 동형) — 워크스페이스 전체 태그를 한 곳에서 보고 이름·색상·삭제(모든 태스크 반영).
    function showManageAll() {
        const back = el('button', { class: 'pjv-tm-tagcolor-back', type: 'button', title: '뒤로' }, pjvtmBackIcon());
        back.onclick = () => showList('');
        const list = el('div', { class: 'pjv-tm-tagresults' });
        // 새 태그 생성은 '모든 태그 관리' 안에서만. 정의만 만들고 현재 항목엔 적용하지 않는다(생성 직후 링크 해제).
        const createIn = el('input', { type: 'text', class: 'pjv-tm-taginput', placeholder: '＋ 새 태그 이름 입력 후 Enter', maxlength: '40' });
        const doCreate = async () => {
            const v = createIn.value.trim();
            if (!v)
                return;
            if (all.some((x) => x.name.toLowerCase() === v.toLowerCase())) {
                toast('이미 있는 태그입니다', true);
                return;
            }
            const color = PJV_TAG_COLORS[all.length % PJV_TAG_COLORS.length];
            createIn.disabled = true;
            try {
                const tags = await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ name: v, color }) }).then((r) => (r && r.tags) || []);
                const created = (tags || []).find((x) => x.name.toLowerCase() === v.toLowerCase());
                if (created)
                    await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: created.id, remove: true }) }).catch(() => { });
                await loadAll();
                renderField();
                showManageAll();
            }
            catch (e) {
                toast('태그 생성 실패 — ' + e.message, true);
                createIn.disabled = false;
            }
        };
        createIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
            e.preventDefault();
            doCreate();
        } });
        pop.replaceChildren(el('div', { class: 'pjv-tm-tagcolor-top' }, back, el('div', { class: 'pjv-tm-tagmanage-title', text: '모든 태그 관리' })), el('div', { class: 'pjv-tm-tagpop-top' }, createIn), el('div', { class: 'pjv-tm-tagpop-head' }, el('span', { text: all.length + '개 · 클릭해 이름·색상·삭제 (모든 태스크 반영)' })), list);
        setTimeout(() => createIn.focus(), 0);
        if (!all.length) {
            list.append(el('div', { class: 'pjv-menu-empty', text: '아직 태그가 없습니다 — 위 칸에서 만들어보세요.' }));
            return;
        }
        for (const x of all) {
            const row = el('button', { class: 'pjv-tm-tagrow', type: 'button' }, el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (x.color || PJV_TAG_NONE) }), el('span', { class: 'pjv-tm-tagrow-name', text: x.name }), el('span', { class: 'pjv-tm-tagrow-gear' }, pjvtmGearIcon()));
            row.onclick = () => showColor(x, '', showManageAll);
            list.append(row);
        }
    }
    showList('');
}
export { PJV_TAG_NONE, pjvtmTagsField };
