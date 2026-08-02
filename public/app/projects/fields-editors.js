// projects/fields-editors.ts — #1405 W2: fields.ts 분할 ②.
//  값 편집 컨트롤 한 벌 — 타입별 인라인 에디터(텍스트·날짜·진행률·티셔츠·파일·관계·드롭다운·라벨)와 옵션 행 추가.
//  의존은 단방향: fields-editors → fields-types.
import { api, el, safeHref, toast } from '../core.js';
import { pjvPopover } from './popover.js';
import { pjvCheckGlyph, pjvCheckMini, pjvStarGlyph } from './icons.js';
import { authDownload, fileIconSvg, fmtSize } from './files.js';
import { pjvReloadKeepScroll } from './state.js'; // #1313 R31 — 스크롤 보존 재렌더는 state.js 소유
import { PJV_FIELD_BY_KEY, PJV_FIELD_PALETTE, PJV_TSHIRT_SIZES, pjvFieldDisplay, pjvHasFieldValue, pjvOptChip } from './fields-types.js';
// 한 셀의 컨트롤 — 낙관적 로컬 갱신 + 백그라운드 저장(전체 reload 없이 부드럽게). 옵션 추가 등 정의 변경은 reload.
function pjvFieldControl(t, field, reload) {
    let value = (t.field_values || {})[field.id];
    value = value === undefined ? null : value;
    const cell = el('span', { class: 'pjv-fcell-wrap' });
    const persist = (v) => {
        // ClickUp 리스트 컬럼(#541): 정의가 프로젝트별 복제라 POST 는 행별 내부 field id(cuIds 맵)로 해소.
        const postId = field.cuIds ? field.cuIds[t.id] : field.id;
        if (field.cuIds && !postId) {
            toast('이 행에는 ClickUp 필드 정의가 아직 없어요 — 다음 싱크 후 편집 가능해요', true);
            return;
        }
        const prev = value;
        value = v;
        render();
        api('/api/ui/v6/tasks/' + t.id + '/fields/' + postId, { method: 'POST', body: JSON.stringify({ value: v }) })
            .then(() => { (t.field_values || (t.field_values = {}))[field.id] = v; })
            .catch((e) => { value = prev; render(); toast('수정 실패 — ' + e.message, true); });
    };
    function render() { cell.replaceChildren(pjvFieldInner(t, field, value, persist, reload)); }
    render();
    return cell;
}
// 셀 내부 — 인라인 상호작용(체크박스·별점)은 셀 자체가 컨트롤, 그 외는 값 버튼(클릭→팝오버 편집기).
function pjvFieldInner(t, field, value, persist, reload) {
    const type = field.field_type;
    if (type === 'checkbox') {
        const on = value === true;
        const btn = el('button', { class: 'pjv-fcheck' + (on ? ' on' : ''), type: 'button', title: field.name, 'aria-pressed': on ? 'true' : 'false' }, pjvCheckGlyph(on));
        btn.onclick = (e) => { e.stopPropagation(); persist(!on); };
        return btn;
    }
    if (type === 'rating') {
        const max = Math.max(1, Math.min(10, Number(field.config && field.config.max) || 5));
        const cur = Number(value) || 0;
        const wrap = el('span', { class: 'pjv-frating', title: field.name });
        for (let i = 1; i <= max; i++) {
            const on = i <= cur;
            const star = el('button', { class: 'pjv-fstar' + (on ? ' on' : ''), type: 'button', 'aria-label': i + '점' }, pjvStarGlyph(on));
            star.onclick = (e) => { e.stopPropagation(); persist(i === cur ? null : i); };
            wrap.append(star);
        }
        return wrap;
    }
    if (type === 'progress_auto') {
        const pct = pjvAutoProgress(t);
        if (pct === null)
            return el('span', { class: 'pjv-cell-btn empty', title: '하위 태스크가 없어요(자동 진행률)', style: 'cursor:default' }, el('span', { class: 'pjv-cell-ph', text: '—' }));
        return el('span', { class: 'pjv-fprog', title: '하위 태스크 ' + pct + '% 완료(자동)' }, el('span', { class: 'pjv-fprog-track' }, el('span', { class: 'pjv-fprog-fill', style: 'width:' + pct + '%' })), el('span', { class: 'pjv-fprog-num', text: pct + '%' }));
    }
    const has = pjvHasFieldValue(value);
    const btn = el('button', { class: 'pjv-cell-btn' + (has ? '' : ' empty'), type: 'button', title: field.name }, has ? pjvFieldDisplay(field, value) : el('span', { class: 'pjv-cell-ph', text: '＋' }));
    btn.onclick = (e) => {
        e.stopPropagation();
        if (type === 'dropdown')
            return pjvFieldDropdownEditor(btn, t, field, value, persist, reload);
        if (type === 'labels')
            return pjvFieldLabelsEditor(btn, t, field, value, persist, reload);
        if (type === 'date')
            return pjvFieldDateEditor(btn, value, persist);
        if (type === 'progress')
            return pjvFieldProgressEditor(btn, value, persist);
        if (type === 'files')
            return pjvFieldFilesEditor(btn, t, field, value, persist);
        if (type === 'relationship')
            return pjvFieldRelEditor(btn, t, field, value, persist);
        if (type === 'tshirt')
            return pjvFieldTshirtEditor(btn, value, persist);
        if (type === 'textarea')
            return pjvFieldTextareaEditor(btn, field, value, persist);
        return pjvFieldTextEditor(btn, field, value, persist);
    };
    return btn;
}
// 텍스트류 편집기(text/number/money/website/email/phone/location) — 입력 + 저장/지우기. Enter 저장.
function pjvFieldTextEditor(anchor, field, value, persist) {
    const type = field.field_type;
    const itype = (type === 'number' || type === 'money') ? 'number' : type === 'website' ? 'url' : type === 'email' ? 'email' : type === 'phone' ? 'tel' : 'text';
    const input = el('input', { type: itype, class: 'pjv-field-input', value: value == null ? '' : String(value),
        placeholder: (PJV_FIELD_BY_KEY[type] && PJV_FIELD_BY_KEY[type].desc) || '',
        inputmode: (type === 'number' || type === 'money') ? 'decimal' : null });
    const coerce = (v) => {
        if (type === 'number' || type === 'money') {
            const n = Number(String(v).replace(/,/g, ''));
            return Number.isFinite(n) ? n : undefined;
        }
        return v;
    };
    const save = () => {
        const raw = input.value.trim();
        if (raw === '') {
            close();
            persist(null);
            return;
        }
        const out = coerce(raw);
        if (out === undefined) {
            toast('숫자를 입력하세요', true);
            return;
        }
        close();
        persist(out);
    };
    const actions = el('div', { class: 'pjv-fe-actions' }, el('button', { class: 'pjv-fe-btn primary', type: 'button', text: '저장', onclick: save }), (type === 'website' && pjvHasFieldValue(value)) ? el('a', { class: 'pjv-fe-btn', href: safeHref(String(value)) || '#', target: '_blank', rel: 'noopener', text: '열기 ↗' }) : null, pjvHasFieldValue(value) ? el('button', { class: 'pjv-fe-btn danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null);
    const close = pjvPopover(anchor, el('div', { class: 'pjv-field-editor' }, input, actions));
    setTimeout(() => { input.focus(); if (input.select)
        input.select(); }, 0);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
        e.preventDefault();
        save();
    } });
}
// 긴 텍스트 편집기 — textarea + 저장/지우기. Cmd/Ctrl+Enter 저장.
function pjvFieldTextareaEditor(anchor, field, value, persist) {
    const ta = el('textarea', { class: 'pjv-field-textarea', rows: '4', placeholder: '여러 줄 메모', maxlength: '4000' });
    ta.value = value == null ? '' : String(value);
    const save = () => { const v = ta.value.trim(); close(); persist(v === '' ? null : v); };
    const actions = el('div', { class: 'pjv-fe-actions' }, el('button', { class: 'pjv-fe-btn primary', type: 'button', text: '저장', onclick: save }), pjvHasFieldValue(value) ? el('button', { class: 'pjv-fe-btn danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null);
    const close = pjvPopover(anchor, el('div', { class: 'pjv-field-editor wide' }, ta, actions));
    setTimeout(() => { ta.focus(); }, 0);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
    } });
}
// 날짜 편집기 — 마감일과 동형(YYYY-MM-DD).
function pjvFieldDateEditor(anchor, value, persist) {
    const input = el('input', { type: 'date', class: 'pjv-date-input', value: typeof value === 'string' ? value : '' });
    const wrap = el('div', { class: 'pjv-menu pjv-date-pop' }, input, pjvHasFieldValue(value) ? el('button', { class: 'pjv-menu-item danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null);
    const close = pjvPopover(anchor, wrap);
    setTimeout(() => { input.focus(); if (input.showPicker) {
        try {
            input.showPicker();
        }
        catch (_) { /* noop */ }
    } }, 0);
    input.onchange = () => { const v = input.value || null; close(); persist(v); };
}
// 진행률 편집기 — 슬라이더 + 숫자(0–100).
function pjvFieldProgressEditor(anchor, value, persist) {
    const cur = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    const range = el('input', { type: 'range', class: 'pjv-prog-range', min: '0', max: '100', step: '5', value: String(cur) });
    const num = el('input', { type: 'number', class: 'pjv-prog-num-input', min: '0', max: '100', value: String(cur) });
    range.oninput = () => { num.value = range.value; };
    num.oninput = () => { const n = Math.max(0, Math.min(100, Number(num.value) || 0)); range.value = String(n); };
    const save = () => { const n = Math.max(0, Math.min(100, Math.round(Number(num.value) || 0))); close(); persist(n === 0 ? null : n); };
    const wrap = el('div', { class: 'pjv-field-editor pjv-prog-editor' }, el('div', { class: 'pjv-prog-row' }, range, el('span', { class: 'pjv-prog-pct' }, num, el('span', { text: '%' }))), el('div', { class: 'pjv-fe-actions' }, el('button', { class: 'pjv-fe-btn primary', type: 'button', text: '저장', onclick: save }), pjvHasFieldValue(value) ? el('button', { class: 'pjv-fe-btn danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null));
    const close = pjvPopover(anchor, wrap);
}
// 티셔츠 사이즈 — 고정 옵션(XS–XXL) 메뉴.
function pjvFieldTshirtEditor(anchor, value, persist) {
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(anchor, menu);
    for (const s of PJV_TSHIRT_SIZES) {
        const sel = value === s;
        const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-fsize', text: s }));
        item.onclick = () => { close(); persist(sel ? null : s); };
        menu.append(item);
    }
    const none = el('button', { class: 'pjv-menu-item' + (value == null ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
    none.onclick = () => { close(); if (value != null)
        persist(null); };
    menu.append(none);
}
// 하위 태스크 완료율(자동) — 진행률(자동) 필드용. 하위 없으면 null. (클릭업 Progress Auto 의 하위 기반 버전)
function pjvAutoProgress(t) {
    const subs = (t && t.subtasks) || [];
    if (!subs.length)
        return null;
    const done = subs.filter((s) => s.status === 'done').length;
    return Math.round((done / subs.length) * 100);
}
// 파일 필드 — 공유 폴더에서 선택(참조). 업로드가 아니라 프로젝트 공유폴더의 기존 파일을 골라 연결한다.
//  값=[{name, path, size}](path=공유폴더 상대경로). 연결 해제해도 실제 파일은 안 지워진다(참조만 끊음).
function pjvFieldFilesEditor(anchor, t, field, value, persist) {
    let selected = Array.isArray(value) ? value.slice() : [];
    const B = '/api/ui/v6/projects/' + field.project_id;
    const wrap = el('div', { class: 'pjv-field-editor pjv-files-editor' });
    pjvPopover(anchor, wrap);
    let curPath = '';
    let curData = null;
    const chips = el('div', { class: 'pjv-files-selected' });
    const crumb = el('div', { class: 'pjv-files-crumb' });
    const rowsBox = el('div', { class: 'pjv-files-browser' });
    const renderChips = () => {
        chips.replaceChildren(el('span', { class: 'pjv-files-sel-label', text: '연결된 파일 ' + selected.length + '개' }));
        for (const s of selected) {
            chips.append(el('span', { class: 'pjv-rel-chip removable' }, el('button', { class: 'pjv-chip-dl', type: 'button', title: '다운로드', text: '↓', onclick: () => authDownload(B + '/file?download=1&path=' + encodeURIComponent(s.path), s.name) }), el('span', { class: 'pjv-files-name', text: s.name, title: s.path }), el('button', { class: 'pjv-rel-x', type: 'button', title: '연결 해제', text: '✕', onclick: () => { selected = selected.filter((x) => x.path !== s.path); persist(selected.length ? selected.slice() : null); renderChips(); refreshRows(); } })));
        }
    };
    const refreshRows = () => {
        rowsBox.replaceChildren();
        const items = (curData && curData.items) || [];
        if (!items.length) {
            rowsBox.append(el('div', { class: 'pjv-files-empty', text: '빈 폴더예요' }));
            return;
        }
        for (const it of items) {
            const childPath = curPath ? curPath + '/' + it.name : it.name;
            if (it.type === 'dir') {
                rowsBox.append(el('button', { class: 'pjv-files-row dir', type: 'button', onclick: () => { curPath = childPath; load(); } }, fileIconSvg(it.name, true), el('span', { class: 'pjv-files-name', text: it.name }), el('span', { class: 'pjv-files-chev', text: '›' })));
            }
            else {
                const on = selected.some((x) => x.path === childPath);
                const row = el('button', { class: 'pjv-files-row file' + (on ? ' on' : ''), type: 'button' }, pjvCheckMini(on), fileIconSvg(it.name, false), el('span', { class: 'pjv-files-name', text: it.name }), el('span', { class: 'pjv-files-size', text: fmtSize(it.size) }));
                row.onclick = () => {
                    if (on)
                        selected = selected.filter((x) => x.path !== childPath);
                    else
                        selected.push({ name: it.name, path: childPath, size: it.size });
                    persist(selected.length ? selected.slice() : null);
                    renderChips();
                    refreshRows();
                };
                rowsBox.append(row);
            }
        }
    };
    const renderCrumb = () => {
        crumb.replaceChildren(el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: '루트', onclick: () => { curPath = ''; load(); } }));
        let acc = '';
        for (const p of (curPath ? curPath.split('/') : [])) {
            acc = acc ? acc + '/' + p : p;
            const target = acc;
            crumb.append(el('span', { class: 'pjv-files-crumb-sep', text: '/' }), el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: p, onclick: () => { curPath = target; load(); } }));
        }
    };
    const load = async () => {
        rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '불러오는 중…' }));
        try {
            curData = await api(B + '/files?path=' + encodeURIComponent(curPath));
        }
        catch (e) {
            curData = { items: [] };
            renderCrumb();
            rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '공유 폴더를 불러오지 못했어요' }));
            return;
        }
        renderCrumb();
        refreshRows();
    };
    wrap.append(el('div', { class: 'pjv-files-head2', text: '공유 폴더에서 파일 선택' }), chips, crumb, rowsBox);
    renderChips();
    load();
}
// 관계(태스크 연결) 필드 — 같은 프로젝트의 다른 태스크를 검색해 연결. 값=[{id, name}]. (link-targets 재활용)
function pjvFieldRelEditor(anchor, t, field, value, persist) {
    let linked = Array.isArray(value) ? value.slice() : [];
    const B = '/api/ui/v6/projects/' + field.project_id;
    const chips = el('div', { class: 'pjv-rel-chips' });
    const results = el('div', { class: 'pjv-rel-results' });
    const search = el('input', { type: 'text', class: 'pjv-field-input', placeholder: '연결할 태스크 검색…' });
    let timer = null;
    const renderChips = () => {
        chips.replaceChildren();
        if (!linked.length) {
            chips.append(el('span', { class: 'pjv-files-empty', text: '연결된 태스크가 없어요' }));
            return;
        }
        for (const r of linked) {
            chips.append(el('span', { class: 'pjv-rel-chip removable' }, el('span', { text: r.name || ('#' + r.id) }), el('button', { class: 'pjv-rel-x', type: 'button', title: '연결 해제', text: '✕', onclick: () => { linked = linked.filter((x) => x.id !== r.id); persist(linked.length ? linked.slice() : null); renderChips(); doSearch(); } })));
        }
    };
    const doSearch = async () => {
        let targets = [];
        try {
            const d = await api(B + '/link-targets?exclude=' + t.id + '&q=' + encodeURIComponent(search.value.trim()));
            targets = (d && d.targets) || [];
        }
        catch (e) {
            results.replaceChildren(el('div', { class: 'pjv-files-empty', text: '검색 실패' }));
            return;
        }
        const avail = targets.filter((x) => !linked.some((l) => l.id === x.id));
        results.replaceChildren();
        if (!avail.length) {
            results.append(el('div', { class: 'pjv-files-empty', text: '결과가 없어요' }));
            return;
        }
        for (const x of avail) {
            const row = el('button', { class: 'pjv-rel-result', type: 'button' }, el('span', { class: 'pjv-rel-result-name', text: x.name }), el('span', { class: 'pjv-rel-add', text: '＋ 연결' }));
            row.onclick = () => { linked.push({ id: x.id, name: x.name }); persist(linked.slice()); renderChips(); doSearch(); };
            results.append(row);
        }
    };
    search.oninput = () => { clearTimeout(timer); timer = setTimeout(doSearch, 220); };
    const wrap = el('div', { class: 'pjv-field-editor pjv-rel-editor' }, chips, search, results);
    pjvPopover(anchor, wrap);
    renderChips();
    doSearch();
    setTimeout(() => search.focus(), 0);
}
// 드롭다운 편집기 — 옵션 1개 선택 + 없음 + 즉석 옵션 추가.
function pjvFieldDropdownEditor(anchor, t, field, value, persist, reload) {
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(anchor, menu);
    for (const o of (field.config && field.config.options) || []) {
        const sel = value === o.id;
        const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' }, pjvOptChip(o));
        item.onclick = () => { close(); persist(sel ? null : o.id); };
        menu.append(item);
    }
    const none = el('button', { class: 'pjv-menu-item' + (value == null ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
    none.onclick = () => { close(); if (value != null)
        persist(null); };
    menu.append(none);
    menu.append(pjvAddOptionRow(field, async (opt) => {
        close();
        try {
            await api('/api/ui/v6/tasks/' + t.id + '/fields/' + field.id, { method: 'POST', body: JSON.stringify({ value: opt.id }) });
        }
        catch (_) { /* noop */ }
        pjvReloadKeepScroll(reload); // 옵션 추가·선택 후 스크롤 보존(#459)
    }));
}
// 라벨 편집기 — 옵션 여러 개(토글, 즉시 저장·셀 실시간 갱신, 팝오버 유지) + 즉석 옵션 추가.
function pjvFieldLabelsEditor(anchor, t, field, value, persist, reload) {
    const selected = Array.isArray(value) ? value.slice() : [];
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(anchor, menu);
    for (const o of (field.config && field.config.options) || []) {
        const item = el('button', { class: 'pjv-menu-item' + (selected.includes(o.id) ? ' sel' : ''), type: 'button' }, pjvCheckMini(selected.includes(o.id)), pjvOptChip(o));
        item.onclick = () => {
            const on = selected.includes(o.id);
            if (on)
                selected.splice(selected.indexOf(o.id), 1);
            else
                selected.push(o.id);
            item.classList.toggle('sel', !on);
            item.replaceChildren(pjvCheckMini(!on), pjvOptChip(o));
            persist(selected.length ? selected.slice() : null);
        };
        menu.append(item);
    }
    menu.append(pjvAddOptionRow(field, async (opt) => {
        close();
        try {
            await api('/api/ui/v6/tasks/' + t.id + '/fields/' + field.id, { method: 'POST', body: JSON.stringify({ value: [...selected, opt.id] }) });
        }
        catch (_) { /* noop */ }
        pjvReloadKeepScroll(reload); // 라벨 옵션 추가 후 스크롤 보존(#459)
    }));
}
// 즉석 옵션 추가 행 — 입력 + Enter. 필드 config 에 옵션 추가 후 onAdded(opt) 콜백.
function pjvAddOptionRow(field, onAdded) {
    const inp = el('input', { type: 'text', class: 'pjv-opt-add-input', placeholder: '＋ 옵션 추가', maxlength: '40' });
    const row = el('div', { class: 'pjv-opt-add' }, inp);
    inp.onclick = (e) => e.stopPropagation();
    inp.addEventListener('keydown', async (e) => {
        e.stopPropagation();
        if (e.key !== 'Enter')
            return;
        const label = inp.value.trim();
        if (!label)
            return;
        inp.disabled = true;
        try {
            onAdded(await pjvAddFieldOption(field, label));
        }
        catch (err) {
            toast('옵션 추가 실패 — ' + err.message, true);
            inp.disabled = false;
        }
    });
    return row;
}
async function pjvAddFieldOption(field, label) {
    const opts = (field.config && field.config.options) || [];
    const opt = { id: 'o' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), label: label.slice(0, 40), color: PJV_FIELD_PALETTE[opts.length % PJV_FIELD_PALETTE.length] };
    const config = Object.assign({}, field.config, { options: [...opts, opt] });
    await api('/api/ui/v6/fields/' + field.id, { method: 'POST', body: JSON.stringify({ config }) });
    return opt;
}
export { pjvFieldControl };
