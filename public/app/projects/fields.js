// projects/fields.ts — #1313 R32: web/projects.ts 분해 ③ (커스텀 필드).
//  형식 정의 18종(PJV_FIELD_TYPES) · 값 표시(pjvFieldDisplay) · 셀 컨트롤(pjvFieldControl/pjvFieldInner) ·
//  타입별 편집기 12종 · 커스텀 컬럼 헤더/메뉴 · 옵션 빌더 · 필드 패널(＋컬럼 추가) · pjvCreateField.
//  ⚠ 옛 (PJ as any).pjvFieldControl **런타임 지연 조회**(순환 회피 해킹)는 R56 이 정적 import 로 환원했다 —
//   태스크 모달(web/taskmodal/fields.ts)은 projects.ts 배럴 경유로 이 표면을 받는다.
//  ※ #1313 R36 — 컬럼 헤더 클릭 정렬(pjvHeadSortable)이 projects/columns.ts 로 내려오면서 이 파일이 배럴을
//   되짚을 이유가 사라졌다(fields→projects 역방향 엣지 소멸).
// ════════════════════════════════════════════════════════════════════════════
// 커스텀 필드(클릭업형 "+ 컬럼 추가") — 우선순위 옆 (+) 로 형식을 지정해 컬럼을 추가하고, 각 태스크에 값을 채운다.
//  백엔드 task_field/task_field_value(루트 프로젝트 단위 정의 + 태스크별 값). FIELD_TYPES 는 store 의 것과 1:1.
//  아이콘은 우리 서비스 톤(단색 라인, currentColor, 형태로 구분 — 컬러 이모지 금지)으로 직접 제작.
// ════════════════════════════════════════════════════════════════════════════
import { api, busy, el, toast } from '../core.js';
import { overlayBox } from '../learn.js';
import { pjvPopover } from './popover.js';
import { pjvFieldIcon, pjvPlusIcon } from './icons.js';
import { pjvCustomColsSection, pjvColResizeHandle, pjvDefaultColsSection, pjvHeadSortable, pjvSetStdColVisible } from './columns.js';
import { pjvReloadKeepScroll } from './state.js'; // #1313 R31 — 스크롤 보존 재렌더는 state.js 소유
import { PJV_CURRENCIES, PJV_FIELD_BY_KEY, PJV_FIELD_PALETTE, PJV_FIELD_TYPES } from './fields-types.js';
// ── 컬럼 헤더(커스텀 필드) — 아이콘 + 이름 + ⋯ 메뉴(이름변경/옵션편집/삭제) ──
function pjvColumnHead(field, projectId, reload) {
    const nameEl = el('span', { class: 'pjv-thcol-name', text: field.name, title: field.name });
    pjvHeadSortable(nameEl, String(field.id)); // 클릭 정렬(#541) — field_values 값 기준
    const cell = el('div', { class: 'pjv-tcell pjv-thcol', 'data-col': 'f:' + field.id }, // data-col: 열 순서 드래그(#611)
    pjvFieldIcon(field.field_type, 'pjv-thcol-ic'), nameEl);
    // ClickUp 이관 컬럼(#541) — 정의는 커넥터 소유(이름변경·삭제 불가), 배지로 출처 표시. 폭 조절(#666)은 가능.
    if (field.readonlyDef) {
        cell.append(el('span', { class: 'pjv-thcol-src', text: 'CU', title: 'ClickUp에서 이관된 컬럼' }));
        cell.append(pjvColResizeHandle('f:' + field.id));
        return cell;
    }
    const menuBtn = el('button', { class: 'pjv-thcol-menu', type: 'button', text: '⋯', 'aria-label': field.name + ' 컬럼 설정' });
    menuBtn.onclick = (e) => { e.stopPropagation(); pjvColumnMenu(menuBtn, field, projectId, reload); };
    cell.append(menuBtn);
    cell.append(pjvColResizeHandle('f:' + field.id)); // 컬럼 폭 드래그(#666)
    return cell;
}
function pjvColumnMenu(anchor, field, projectId, reload) {
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(anchor, menu);
    const mk = (label, fn, danger) => { const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label })); b.onclick = () => { close(); fn(); }; return b; };
    menu.append(mk('이름 변경', () => pjvRenameColumn(anchor, field, reload)));
    const meta = PJV_FIELD_BY_KEY[field.field_type];
    if (meta && meta.config === 'options')
        menu.append(mk('옵션 편집', () => pjvEditColumnOptions(field, reload)));
    // #710 이 컬럼 숨기기 — 프로젝트 보드에서만(리스트 스코프면 그 리스트만·팀 공유, 아니면 보드 전역). 되살리기: 컬럼 추가(＋)→커스텀 필드.
    const _card = anchor.closest('.pjv-tasks-card');
    if (_card && _card.classList.contains('pjv-proj-card'))
        menu.append(mk('이 컬럼 숨기기', () => pjvSetStdColVisible('proj', 'f:' + field.id, false, _card)));
    menu.append(mk('컬럼 삭제', () => pjvDeleteColumn(field, reload), true));
}
function pjvRenameColumn(anchor, field, reload) {
    const input = el('input', { type: 'text', class: 'pjv-rename-input', value: field.name, maxlength: '120' });
    const close = pjvPopover(anchor, el('div', { class: 'pjv-menu pjv-rename-pop' }, input));
    input.onkeydown = async (e) => {
        if (e.key !== 'Enter')
            return;
        e.preventDefault();
        const v = input.value.trim();
        close();
        if (v && v !== field.name) {
            try {
                await api('/api/ui/v6/fields/' + field.id, { method: 'POST', body: JSON.stringify({ name: v }) });
                pjvReloadKeepScroll(reload); /* 컬럼 이름변경 후 스크롤 보존(#459) */
            }
            catch (err) {
                toast('수정 실패 — ' + err.message, true);
            }
        }
    };
    setTimeout(() => { input.focus(); input.select(); }, 0);
}
function pjvEditColumnOptions(field, reload) {
    const ob = pjvOptionsBuilder((field.config && field.config.options) || []);
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const back = overlayBox('옵션 편집 · ' + field.name, el('div', { class: 'field' }, ob.el), el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
    saveBtn.onclick = async () => {
        const options = ob.get();
        if (!options.length) {
            toast('옵션을 1개 이상 두세요', true);
            return;
        }
        saveBtn.disabled = true;
        const config = Object.assign({}, field.config, { options });
        try {
            await api('/api/ui/v6/fields/' + field.id, { method: 'POST', body: JSON.stringify({ config }) });
            back.remove();
            pjvReloadKeepScroll(reload); /* 옵션 편집 후 스크롤 보존(#459) */
        }
        catch (e) {
            toast('저장 실패 — ' + e.message, true);
            saveBtn.disabled = false;
        }
    };
}
function pjvDeleteColumn(field, reload) {
    if (!confirm("'" + field.name + "' 컬럼을 삭제할까요?\n\n이 컬럼의 모든 값이 함께 사라집니다."))
        return;
    (async () => {
        try {
            await api('/api/ui/v6/fields/' + field.id + '/delete', { method: 'POST', body: JSON.stringify({}) });
            toast('컬럼을 삭제했어요');
            pjvReloadKeepScroll(reload); /* 컬럼 삭제 후 스크롤 보존(#459) */
        }
        catch (e) {
            toast('삭제 실패 — ' + e.message, true);
        }
    })();
}
// ── 옵션 빌더(생성/편집 공용) — 색 점(클릭=색 순환)·라벨·삭제 + 추가. 기존 id 보존(값 깨짐 방지). ──
function pjvOptionsBuilder(initial) {
    const rows = el('div', { class: 'pjv-optb-rows' });
    const data = [];
    const addRow = (o) => {
        o = o || {};
        const item = { id: o.id || null, label: o.label || '', color: o.color || PJV_FIELD_PALETTE[data.length % PJV_FIELD_PALETTE.length] };
        data.push(item);
        let ci = Math.max(0, PJV_FIELD_PALETTE.indexOf(item.color));
        const dot = el('button', { class: 'pjv-optb-dot', type: 'button', style: '--opt:' + item.color, title: '색상 변경' });
        dot.onclick = () => { ci = (ci + 1) % PJV_FIELD_PALETTE.length; item.color = PJV_FIELD_PALETTE[ci]; dot.style.setProperty('--opt', item.color); };
        const inp = el('input', { type: 'text', class: 'pjv-optb-input', value: item.label, placeholder: '옵션 이름', maxlength: '40' });
        inp.oninput = () => { item.label = inp.value; };
        const rm = el('button', { class: 'pjv-optb-rm', type: 'button', text: '✕', title: '삭제' });
        const rowEl = el('div', { class: 'pjv-optb-row' }, dot, inp, rm);
        rm.onclick = () => { const i = data.indexOf(item); if (i >= 0)
            data.splice(i, 1); rowEl.remove(); };
        rows.append(rowEl);
    };
    (initial && initial.length ? initial : [{}, {}]).forEach(addRow);
    const addBtn = el('button', { class: 'pjv-optb-add', type: 'button', text: '＋ 옵션 추가', onclick: () => addRow(null) });
    return {
        el: el('div', { class: 'pjv-optb' }, rows, addBtn),
        get: () => data.filter((d) => d.label.trim()).map((d) => ({
            id: d.id || ('o' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)),
            label: d.label.trim().slice(0, 40), color: d.color,
        })),
    };
}
// ── (+) 컬럼 추가 버튼 + Fields 패널(클릭업형: 검색 · 새로 만들기/기존 항목 탭 · 형식 목록 · 설정 폼) ──
function pjvAddColumnButton(projectId, reload, listId) {
    const btn = el('button', { class: 'pjv-addcol-btn', type: 'button', title: listId ? '이 리스트에 컬럼 추가' : '컬럼 추가', 'aria-label': '컬럼 추가' }, pjvPlusIcon());
    btn.onclick = (e) => { e.stopPropagation(); pjvOpenFieldsPanel(btn, projectId, reload, listId); };
    return btn;
}
function pjvOpenFieldsPanel(anchor, projectId, reload, listId) {
    const panel = el('div', { class: 'pjv-fields-panel' });
    const close = pjvPopover(anchor, panel);
    // 이 +버튼이 속한 표(카드)로 surface 판별 — 기본 컬럼 보임/숨김 토글(되살리기)용(#req).
    const card = anchor.closest('.pjv-tasks-card');
    const surface = (card && card.classList.contains('pjv-proj-card')) ? 'proj' : 'task';
    let catalog = null;
    const showPicker = (tab) => {
        tab = tab || 'new';
        const search = el('input', { type: 'text', class: 'pjv-fields-search', placeholder: '필드 검색…' });
        const tNew = el('button', { class: 'pjv-fields-tab' + (tab === 'new' ? ' on' : ''), type: 'button', text: '새로 만들기', onclick: () => showPicker('new') });
        const tExist = el('button', { class: 'pjv-fields-tab' + (tab === 'existing' ? ' on' : ''), type: 'button', text: '기존 항목', onclick: () => showPicker('existing') });
        const list = el('div', { class: 'pjv-fields-list' });
        const _customSec = surface === 'proj' ? pjvCustomColsSection(card, reload) : null; // #710 확장 — 커스텀 필드 표시/숨김(프로젝트 보드)
        panel.replaceChildren(el('div', { class: 'pjv-fields-head' }, el('span', { class: 'pjv-fields-title', text: '필드' })), pjvDefaultColsSection(surface, card), ...(_customSec ? [_customSec] : []), search, el('div', { class: 'pjv-fields-tabs' }, tNew, tExist), list);
        const renderNew = () => {
            const qs = search.value.trim().toLowerCase();
            const matches = PJV_FIELD_TYPES.filter((f) => !qs || f.label.toLowerCase().includes(qs) || f.desc.toLowerCase().includes(qs) || f.key.includes(qs));
            list.replaceChildren();
            if (!matches.length) {
                list.append(el('div', { class: 'pjv-fields-empty', text: '일치하는 형식이 없어요' }));
                return;
            }
            list.append(el('div', { class: 'pjv-fields-sec', text: '필드 형식' }));
            for (const f of matches) {
                const row = el('button', { class: 'pjv-field-opt', type: 'button' }, el('span', { class: 'pjv-field-opt-ic' }, pjvFieldIcon(f.key)), el('span', { class: 'pjv-field-opt-tx' }, el('span', { class: 'pjv-field-opt-name', text: f.label }), el('span', { class: 'pjv-field-opt-desc', text: f.desc })));
                row.onclick = () => panel.replaceChildren(pjvFieldConfigForm(projectId, f, reload, close, () => showPicker('new'), listId));
                list.append(row);
            }
        };
        const renderExisting = async () => {
            busy(list, el('div', { class: 'pjv-fields-empty', text: '불러오는 중…' }));
            if (catalog === null) {
                try {
                    catalog = await api('/api/ui/v6/projects/' + projectId + '/field-catalog').then((d) => d.fields || []);
                }
                catch (_) {
                    catalog = [];
                }
            }
            const qs = search.value.trim().toLowerCase();
            const matches = catalog.filter((c) => !qs || String(c.name).toLowerCase().includes(qs));
            list.replaceChildren();
            if (!matches.length) {
                list.append(el('div', { class: 'pjv-fields-empty', text: '다른 프로젝트에 만든 필드가 없어요' }));
                return;
            }
            for (const c of matches) {
                const meta = PJV_FIELD_BY_KEY[c.field_type];
                const row = el('button', { class: 'pjv-field-opt', type: 'button' }, el('span', { class: 'pjv-field-opt-ic' }, pjvFieldIcon(c.field_type)), el('span', { class: 'pjv-field-opt-tx' }, el('span', { class: 'pjv-field-opt-name', text: c.name }), el('span', { class: 'pjv-field-opt-desc', text: meta ? meta.label : c.field_type })));
                row.onclick = () => pjvCreateField(projectId, { field_type: c.field_type, name: c.name, config: c.config || {}, list_id: listId || undefined }, reload, close); // #607/D 리스트별 필드
                list.append(row);
            }
        };
        search.oninput = () => { tab === 'new' ? renderNew() : renderExisting(); };
        (tab === 'new' ? renderNew : renderExisting)();
        setTimeout(() => search.focus(), 0);
    };
    showPicker('new');
}
// 형식 선택 후 설정 폼 — 이름 + (옵션/통화/별점) 설정 → 만들기.
function pjvFieldConfigForm(projectId, f, reload, close, back, listId) {
    const wrap = el('div', { class: 'pjv-fcfg' });
    wrap.append(el('div', { class: 'pjv-fcfg-head' }, el('button', { class: 'pjv-fcfg-back', type: 'button', text: '←', title: '뒤로', onclick: back }), el('span', { class: 'pjv-fcfg-ic' }, pjvFieldIcon(f.key)), el('span', { class: 'pjv-fcfg-title', text: f.label })));
    const nameIn = el('input', { type: 'text', class: 'pjv-fcfg-name', value: f.label, maxlength: '120', placeholder: '필드 이름' });
    wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '이름' }), nameIn);
    let getConfig = () => ({});
    if (f.config === 'options') {
        const ob = pjvOptionsBuilder([]);
        wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '옵션' }), ob.el);
        getConfig = () => ({ options: ob.get() });
    }
    else if (f.config === 'money') {
        const sel = el('select', { class: 'pjv-fcfg-sel' });
        for (const [code, c] of Object.entries(PJV_CURRENCIES))
            sel.append(el('option', { value: code, text: c.label }));
        sel.value = 'KRW';
        wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '통화' }), sel);
        getConfig = () => ({ currency: sel.value, symbol: PJV_CURRENCIES[sel.value].symbol });
    }
    else if (f.config === 'rating') {
        const sel = el('select', { class: 'pjv-fcfg-sel' });
        for (const n of [3, 5, 10])
            sel.append(el('option', { value: String(n), text: n + '점 만점' }));
        sel.value = '5';
        wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '별 개수' }), sel);
        getConfig = () => ({ max: Number(sel.value) });
    }
    const createBtn = el('button', { class: 'pjv-fcfg-create', type: 'button', text: '만들기' });
    createBtn.onclick = () => {
        const name = nameIn.value.trim() || f.label;
        const config = getConfig();
        if (f.config === 'options' && (!config.options || !config.options.length)) {
            toast('옵션을 1개 이상 추가하세요', true);
            return;
        }
        pjvCreateField(projectId, { field_type: f.key, name, config, list_id: listId || undefined }, reload, close); // #607/D 리스트별 필드
    };
    wrap.append(el('div', { class: 'pjv-fcfg-actions' }, createBtn, el('button', { class: 'pjv-fcfg-cancel', type: 'button', text: '취소', onclick: back })));
    setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
    return wrap;
}
async function pjvCreateField(projectId, payload, reload, close) {
    try {
        await api('/api/ui/v6/projects/' + projectId + '/fields', { method: 'POST', body: JSON.stringify(payload) });
        if (close)
            close();
        toast('컬럼을 추가했어요');
        pjvReloadKeepScroll(reload); /* 컬럼 추가 후 스크롤 보존(#459) */
    }
    catch (e) {
        toast('컬럼 추가 실패 — ' + e.message, true);
    }
}
export { pjvAddColumnButton, pjvColumnHead };
export { PJV_FIELD_BY_KEY, PJV_FIELD_PALETTE } from './fields-types.js';
export { pjvFieldControl } from './fields-editors.js';
