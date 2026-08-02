// projects/list-status-editor.ts — #1405 W2: list-forms.ts 분할 ②.
//  리스트의 상태 단계 편집기 + 상태 템플릿 저장.
import { api, el, toast } from '../core.js';
import { overlayBox } from '../learn.js';
import { pjvPopover } from './popover.js';
import { PJV_STATUS_CATS, pjvAssignFracs, pjvListIsCustomStatus, pjvListStatusDefs, pjvLoadStatusTemplates, pjvNormStatusDefs, pjvSpaceDefaultDefs, pjvStatusIcon, pjvStatusTemplatesCache } from './status.js';
import { PJV_LIST_COLORS } from './list-forms-folder.js';
// ══════════════════════════════════════════════════════════════════════════
// 리스트별 상태 편집기(#475 Task statuses) — 클릭업 'Edit statuses' 화면 대응.
//  할 일/진행 중/완료 3버킷 안에 커스텀 단계(기획중·개발중·QA중·보류 등)를 추가/이름·색/정렬/삭제.
//  저장: settings.statusMode('inherit'|'custom') + settings.statuses[{key,label,color,category}] (/project-lists/:id/settings).
// ══════════════════════════════════════════════════════════════════════════
function pjvListStatusEditor(list, reload) {
    let mode = pjvListIsCustomStatus(list) ? 'custom' : 'inherit';
    // 작업용 복사본 — 커스텀이면 현재 정의, 아니면 기본 3단계 복사(커스텀 전환 시 출발점).
    let defs = pjvListStatusDefs(list).map((d) => ({ key: d.key, label: d.label, color: d.color, category: d.category }));
    let keySeq = 1;
    const genKey = (label) => {
        const base = String(label || 'status').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'status';
        let k = base;
        while (defs.some((d) => d.key === k))
            k = base + '-' + (keySeq++);
        return k;
    };
    const groupsBox = el('div', { class: 'pjv-statused-groups' });
    const moveDef = (d, dir) => {
        const sameCat = defs.filter((x) => x.category === d.category);
        const i = sameCat.indexOf(d);
        const j = i + dir;
        if (j < 0 || j >= sameCat.length)
            return;
        // 전체 defs 배열에서 두 항목 위치 교환.
        const gi = defs.indexOf(sameCat[i]);
        const gj = defs.indexOf(sameCat[j]);
        [defs[gi], defs[gj]] = [defs[gj], defs[gi]];
        paint();
    };
    const delDef = (d) => {
        const sameCat = defs.filter((x) => x.category === d.category);
        // Closed 는 비워도 됨(선택), Active·Done 은 최소 1개.
        if (d.category !== 'closed' && sameCat.length <= 1) {
            toast('Active·Done 버킷엔 최소 1개 상태가 필요해요', true);
            return;
        }
        defs = defs.filter((x) => x !== d);
        paint();
    };
    const addDef = (category) => {
        const label = '새 상태';
        defs.push({ key: genKey(label), label, color: PJV_LIST_COLORS[defs.length % PJV_LIST_COLORS.length], category });
        paint();
    };
    const pickColor = (anchor, d) => {
        const menu = el('div', { class: 'pjv-menu pjv-color-pop' });
        const close = pjvPopover(anchor, menu);
        const wrap = el('div', { class: 'pjv-color-swatches' });
        for (const c of PJV_LIST_COLORS) {
            const s = el('button', { class: 'pjv-sw' + (d.color === c ? ' on' : ''), type: 'button', style: 'background:' + c, title: c });
            s.onclick = () => { d.color = c; close(); paint(); };
            wrap.append(s);
        }
        menu.append(wrap);
    };
    const paint = () => {
        groupsBox.classList.toggle('inherit', mode !== 'custom');
        groupsBox.replaceChildren();
        pjvAssignFracs(defs); // Active 진행 파이 갱신 — 순서·개수(1/n) 반영(#499)
        for (const cat of PJV_STATUS_CATS) {
            const rows = el('div', { class: 'pjv-statused-rows' });
            for (const d of defs.filter((x) => x.category === cat.key)) {
                const dot = el('button', { class: 'pjv-status-btn', type: 'button', title: mode === 'custom' ? '색 변경' : undefined,
                    disabled: mode !== 'custom' ? 'disabled' : undefined }, pjvStatusIcon(d.category, d.color, d.frac));
                dot.onclick = (e) => { e.stopPropagation(); if (mode === 'custom')
                    pickColor(dot, d); };
                const nameIn = el('input', { class: 'pjv-statused-name', type: 'text', value: d.label, maxlength: '40', disabled: mode !== 'custom' ? 'disabled' : undefined });
                nameIn.addEventListener('input', () => { d.label = nameIn.value; });
                const more = el('button', { class: 'pjv-trow-more', type: 'button', title: '상태 작업', text: '⋯' });
                more.onclick = (e) => {
                    e.stopPropagation();
                    const m = el('div', { class: 'pjv-menu' });
                    const close = pjvPopover(more, m);
                    const mk = (label, fn, danger) => { const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label })); b.onclick = () => { close(); fn(); }; return b; };
                    m.append(mk('위로', () => moveDef(d, -1)), mk('아래로', () => moveDef(d, 1)), el('div', { class: 'pjv-bulk-sep-h' }), mk('삭제', () => delDef(d), true));
                };
                rows.append(el('div', { class: 'pjv-statused-row' }, el('span', { class: 'pjv-statused-grip', 'aria-hidden': 'true', text: '⠿' }), dot, nameIn, mode === 'custom' ? more : null));
            }
            const addBtn = el('button', { class: 'pjv-statused-add', type: 'button', onclick: () => addDef(cat.key) }, el('span', { class: 'pjv-newlist-plus', text: '＋' }), el('span', { text: '상태 추가' }));
            // 버킷 헤더 — 라벨 + 우측 ＋(클릭업처럼 헤더에서 바로 추가).
            const catAdd = mode === 'custom'
                ? el('button', { class: 'pjv-statused-cat-add', type: 'button', title: cat.label + ' 상태 추가', 'aria-label': cat.label + ' 상태 추가', text: '＋', onclick: () => addDef(cat.key) })
                : null;
            groupsBox.append(el('div', { class: 'pjv-statused-cat' }, el('div', { class: 'pjv-statused-cat-h' }, el('span', { text: cat.label }), catAdd), rows, mode === 'custom' ? addBtn : null));
        }
    };
    // 좌측 — 상태 타입 라디오.
    const radio = (val, label, hint) => {
        const on = mode === val;
        const r = el('button', { class: 'pjv-statused-radio' + (on ? ' on' : ''), type: 'button' }, el('span', { class: 'pjv-statused-radio-mark' }), el('span', {}, el('div', { class: 'pjv-statused-radio-label', text: label }), el('div', { class: 'pjv-statused-radio-hint', text: hint })));
        r.onclick = () => { mode = val; paintRadios(); paint(); };
        return r;
    };
    const radios = el('div', { class: 'pjv-statused-radios' });
    const paintRadios = () => radios.replaceChildren(radio('inherit', '기본(스페이스) 상태 사용', (pjvSpaceDefaultDefs && pjvSpaceDefaultDefs.length)
        ? ('스페이스 기본 상태 체계를 따름 — ' + pjvSpaceDefaultDefs.map((d) => d.label).join(' · '))
        : '할 일 · 진행 중 · 완료 (표준 3단계)'), radio('custom', '커스텀 상태 사용', '이 리스트만의 상태 — 버킷 안에 중간 단계를 자유롭게'));
    paintRadios();
    paint();
    // #729 템플릿 바 — 저장된 템플릿 불러오기(적용) + 현재 구성을 템플릿으로 저장(스페이스 기본 지정 가능).
    //  클릭업 'Edit statuses' 의 'Inherit from Space' + 'Save template' 대응. 리스트마다 재생성하던 문제 해소.
    const tmplSelect = el('select', { class: 'pjv-statused-tmpl' });
    const paintTmpl = () => {
        tmplSelect.replaceChildren(el('option', { value: '', text: '템플릿 불러오기…' }));
        for (const t of pjvStatusTemplatesCache)
            tmplSelect.append(el('option', { value: String(t.id), text: t.name + (t.is_default ? '  ★ 기본' : '') }));
    };
    paintTmpl();
    tmplSelect.onchange = () => {
        const id = Number(tmplSelect.value);
        tmplSelect.value = '';
        if (!id)
            return;
        const t = pjvStatusTemplatesCache.find((x) => Number(x.id) === id);
        const loaded = t ? pjvNormStatusDefs(t.statuses) : [];
        if (!loaded.length) {
            toast('빈 템플릿이에요', true);
            return;
        }
        mode = 'custom';
        defs = loaded.map((d) => ({ key: d.key, label: d.label, color: d.color, category: d.category }));
        paintRadios();
        paint();
        toast('‘' + t.name + '’ 불러옴 — 저장하면 이 리스트에 적용돼요');
    };
    const saveTmplBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 템플릿으로 저장',
        onclick: () => pjvSaveStatusTemplate(defs, reload, paintTmpl) });
    const tmplBar = el('div', { class: 'pjv-statused-tmplbar' }, el('div', { class: 'field-label', text: '템플릿' }), el('div', { class: 'pjv-statused-tmplrow' }, tmplSelect, saveTmplBtn), el('div', { class: 'field-hint', text: '스페이스 단위로 상태 체계를 재사용해요. 저장 시 ‘스페이스 기본’으로 지정하면 새 리스트가 자동으로 상속합니다.' }));
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
    const layout = el('div', { class: 'pjv-statused' }, el('div', { class: 'pjv-statused-left' }, el('div', { class: 'field-label', text: '상태 유형' }), radios, tmplBar), el('div', { class: 'pjv-statused-right' }, groupsBox));
    const back = overlayBox('‘' + list.name + '’ 상태 편집', layout, el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
    saveBtn.onclick = async () => {
        // 검증 — 커스텀이면 각 상태 라벨 채우고, 각 버킷 최소 1개.
        let statuses = [];
        if (mode === 'custom') {
            for (const d of defs) {
                if (!String(d.label).trim()) {
                    toast('상태 이름을 모두 입력하세요', true);
                    return;
                }
            }
            // Active·Done 은 최소 1개, Closed 는 선택(비워도 됨).
            for (const cat of PJV_STATUS_CATS)
                if (cat.key !== 'closed' && !defs.some((d) => d.category === cat.key)) {
                    toast('‘' + cat.label + '’에 상태가 최소 1개 필요해요', true);
                    return;
                }
            statuses = defs.map((d) => ({ key: d.key, label: String(d.label).trim(), color: d.color, category: d.category }));
        }
        saveBtn.disabled = true;
        try {
            await api('/api/ui/v6/project-lists/' + list.id + '/settings', { method: 'POST', body: JSON.stringify({ settings: { statusMode: mode, statuses } }) });
            back.remove();
            toast('상태를 저장했습니다');
            if (reload)
                reload();
        }
        catch (e) {
            toast('저장 실패 — ' + e.message, true);
            saveBtn.disabled = false;
        }
    };
    return back;
}
// #729 현재 상태 구성을 재사용 템플릿으로 저장 — 이름 + '스페이스 기본으로 지정' 옵션. 저장 후 캐시 리로드·드롭다운 갱신.
//  스페이스 기본으로 지정하면 inherit(기본 상태 사용) 리스트·새 리스트가 이 스킴을 물려받는다(reload 로 반영).
function pjvSaveStatusTemplate(defs, reload, refreshSelect) {
    for (const d of defs)
        if (!String(d.label).trim()) {
            toast('상태 이름을 모두 입력하세요', true);
            return;
        }
    for (const cat of PJV_STATUS_CATS)
        if (cat.key !== 'closed' && !defs.some((d) => d.category === cat.key)) {
            toast('‘' + cat.label + '’에 상태가 최소 1개 필요해요', true);
            return;
        }
    const statuses = defs.map((d) => ({ key: d.key, label: String(d.label).trim(), color: d.color, category: d.category }));
    const nameIn = el('input', { type: 'text', placeholder: '템플릿 이름 (예: 개발 표준)', maxlength: '120' });
    const defChk = el('input', { type: 'checkbox' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const back = overlayBox('상태 템플릿으로 저장', el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn), el('label', { class: 'pjv-tmpl-defrow' }, defChk, el('span', { text: '스페이스 기본으로 지정 — 새 리스트·기본 상속 리스트가 이 체계를 따름' })), el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
    setTimeout(() => nameIn.focus(), 0);
    const go = async () => {
        const nm = nameIn.value.trim();
        if (!nm) {
            nameIn.focus();
            toast('이름을 입력하세요', true);
            return;
        }
        saveBtn.disabled = true;
        try {
            await api('/api/ui/v6/status-templates', { method: 'POST', body: JSON.stringify({ name: nm, statuses, is_default: defChk.checked }) });
            await pjvLoadStatusTemplates();
            if (refreshSelect)
                refreshSelect();
            back.remove();
            toast(defChk.checked ? '템플릿 저장 + 스페이스 기본으로 지정했어요' : '템플릿을 저장했어요');
            if (defChk.checked && reload)
                reload(); // 스페이스 기본 변경 → inherit 리스트 재렌더
        }
        catch (e) {
            toast('저장 실패 — ' + e.message, true);
            saveBtn.disabled = false;
        }
    };
    saveBtn.onclick = go;
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
        e.preventDefault();
        go();
    } });
}
export { pjvListStatusEditor };
