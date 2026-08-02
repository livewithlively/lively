// taskmodal/fields.ts — #1313 R56: web/taskmodal.ts 섹션 분할 ④(필드 영역).
//  필드 행 셸 · 상태 · 커스텀 필드(#541) · 담당자 · 기간 · 우선순위 · 시간추적(+엔트리 팝오버).
//  ⚠ 커스텀 필드 셀 컨트롤(pjvFieldControl)은 R32 이전 (PJ as any) **런타임 지연 조회**였다. R56 에서 정적
//   import 로 환원 — 배럴(../projects.js) 경유다. 소유처(projects/fields.js) 직결은 projects/fields → projects
//   역방향 엣지(pjvHeadSortable) 때문에 순환이 더 늘어 택하지 않았다(실측 근거는 커밋 메시지·보고 참조).
import { api, el, personFace, toast } from '../core.js';
import { PJV_PRIORITY, PJV_PRIORITY_ORDER, pjvAssignees, pjvAssigneeWrite, pjvFieldControl, pjvFmtDate, pjvIsOverdue, pjvPatchTask, pjvPopover, pjvSaveTask, pjvStatusMeta, pjvTaskModalStatusField } from '../projects.js';
import { pjvFmtClock, pjvFmtDuration } from './util.js';
function pjvtmFieldRow(glyph, label, control) {
    return el('div', { class: 'pjv-tm-field' }, el('span', { class: 'pjv-tm-field-ico', 'aria-hidden': 'true', text: glyph }), el('span', { class: 'pjv-tm-field-label', text: label }), el('div', { class: 'pjv-tm-field-val' }, control));
}
// 상태 — #731 프로젝트/행과 동일한 디자인으로 통일. 소속 리스트가 커스텀 상태면 그 상태들(색·이름)을 pill+메뉴로,
//  아니면 네이티브 3단계. d.list(리스트 상태 체계)로 판단. onPick 은 status(네이티브 투영)+status_raw(커스텀 키)를 함께 저장.
function pjvtmStatusField(t, refresh, listStatus) {
    const ctrl = pjvTaskModalStatusField(t, listStatus, (patch) => pjvPatchTask(t.id, patch, refresh));
    // 원문 상태 칩(#541 무손실) — 커스텀 리스트면 raw 가 곧 커스텀 상태라 병기 불필요. 네이티브 리스트인데 이관 raw 가
    //  3상태 라벨과 다르면(예: 'in review') 읽기전용 병기. 네이티브 행은 status_raw=NULL 이라 표시 없음.
    const isCustom = !!(listStatus && listStatus.statusMode === 'custom' && Array.isArray(listStatus.statuses) && listStatus.statuses.length);
    const meta = pjvStatusMeta(t.status);
    const raw = String(t.status_raw || '').trim();
    if (!isCustom && raw && raw.toLowerCase() !== meta.label.toLowerCase() && raw.toLowerCase() !== String(t.status || '').toLowerCase()) {
        return el('span', { class: 'pjv-tm-statuswrap' }, ctrl, el('span', { class: 'pjv-tm-statusraw', title: '원본 상태(읽기전용): ' + raw, text: raw }));
    }
    return ctrl;
}
// 커스텀 필드(#541) — 루트 프로젝트의 task_field 정의별 한 행(라벨+셀 컨트롤). 컨트롤은 리스트뷰의
//  pjvFieldControl(낙관 저장 포함)을 재사용. 없으면 값만 읽기전용 노출(pjvtmFieldReadonly — 방어 폴백).
function pjvtmCustomFields(d, t, refresh) {
    const fields = d.fields || [];
    if (!fields.length)
        return el('div');
    if (!t.field_values)
        t.field_values = d.field_values || {}; // pjvFieldControl 이 t.field_values 를 읽고/갱신
    const fieldControl = pjvFieldControl; // #1313 R56 — 옛 (PJ as any) 런타임 지연 조회를 정적 import 로 환원
    const grid = el('div', { class: 'pjv-tm-fields pjv-tm-cfields' });
    for (const f of fields) {
        grid.append(pjvtmFieldRow('▤', f.name, fieldControl ? fieldControl(t, f, refresh) : pjvtmFieldReadonly(f, (t.field_values || {})[f.id])));
    }
    const sec = el('div', { class: 'pjv-tm-block pjv-tm-cfblock' });
    sec.append(el('div', { class: 'pjv-tm-block-head' }, el('span', { class: 'pjv-tm-block-title', text: '커스텀 필드' })));
    sec.append(grid);
    return sec;
}
// 읽기전용 값 폴백 — dropdown/labels 는 옵션 id→이름 치환, 그 외는 문자열화(textContent 만 — XSS 불변식).
function pjvtmFieldReadonly(f, v) {
    const has = !(v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0));
    let txt = '';
    if (has) {
        const opts = (f.config && f.config.options) || [];
        // 옵션 shape 은 {id,label,color}(projects.ts pjvOptChip 동형) — name 은 구형/커넥터 원본 폴백.
        const optName = (idv) => { const o = opts.find((x) => x.id === idv); return o ? (o.label || o.name || String(idv)) : String(idv); };
        if (f.field_type === 'dropdown')
            txt = optName(v);
        else if (f.field_type === 'labels' && Array.isArray(v))
            txt = v.map(optName).join(', ');
        else if (Array.isArray(v))
            txt = v.map((x) => (x && typeof x === 'object' ? (x.name || x.id || '') : String(x))).join(', ');
        else if (typeof v === 'object')
            txt = JSON.stringify(v);
        else
            txt = String(v);
    }
    return el('span', { class: 'pjv-tm-cfield-ro' + (has ? '' : ' empty'), text: has ? txt : 'Empty' });
}
function pjvtmAssigneeField(t, members, refresh) {
    const nameOf = (id) => { const m = members.find((x) => x.member_id === id); return m ? (m.display_name || m.member_id) : id; };
    const btn = el('button', { class: 'pjv-tm-valbtn', type: 'button' });
    function render() {
        const ids = pjvAssignees(t);
        btn.className = 'pjv-tm-valbtn' + (ids.length ? '' : ' empty');
        if (ids.length) {
            const faces = el('span', { class: 'pjv-asg-faces' });
            for (const id of ids.slice(0, 4))
                faces.append(personFace(id, 'pjv-ava', nameOf(id)));
            btn.replaceChildren(faces, el('span', { class: 'pjv-tm-valtext', text: ids.length === 1 ? nameOf(ids[0]) : ids.length + '명' }));
        }
        else {
            btn.replaceChildren(el('span', { text: 'Empty' }));
        }
    }
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu pjv-asg-menu' });
        pjvPopover(btn, menu);
        const setIds = (ids) => { t.assignee = pjvAssigneeWrite(ids); render(); pjvSaveTask(t.id, { assignee: t.assignee }); rebuild(); };
        const none = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '담당 없음' }));
        none.onclick = (ev) => { ev.stopPropagation(); setIds([]); };
        const itemsBox = el('div', {});
        menu.append(none, itemsBox);
        function rebuild() {
            const ids = pjvAssignees(t);
            none.className = 'pjv-menu-item' + (!ids.length ? ' sel' : '');
            itemsBox.replaceChildren(...members.map((m) => {
                const on = ids.includes(m.member_id);
                const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' }, personFace(m.member_id, 'pjv-ava', m.display_name || m.member_id), el('span', { class: 'pjv-asg-mname', text: m.display_name || m.member_id }), el('span', { class: 'pjv-asg-check', text: on ? '✓' : '' }));
                item.onclick = (ev) => { ev.stopPropagation(); const c = pjvAssignees(t); setIds(c.includes(m.member_id) ? c.filter((x) => x !== m.member_id) : [...c, m.member_id]); };
                return item;
            }));
            if (!members.length)
                itemsBox.append(el('div', { class: 'pjv-menu-empty', text: '프로젝트 팀원을 먼저 추가하세요' }));
        }
        rebuild();
    };
    render();
    return btn;
}
// 기간 — start → due, 각각 날짜 picker.
function pjvtmDatesField(t, refresh) {
    const wrap = el('div', { class: 'pjv-tm-dates' });
    const mk = (field, ph) => {
        const val = t[field];
        const overdue = field === 'due_date' && pjvIsOverdue(t);
        const b = el('button', { class: 'pjv-tm-datebtn' + (val ? '' : ' empty') + (overdue ? ' overdue' : ''), type: 'button' }, el('span', { text: val ? pjvFmtDate(val) : ph }));
        b.onclick = (e) => {
            e.stopPropagation();
            const input = el('input', { type: 'date', class: 'pjv-date-input', value: val || '' });
            const wrapPop = el('div', { class: 'pjv-menu pjv-date-pop' }, input, val ? el('button', { class: 'pjv-menu-item danger', type: 'button', text: '지우기',
                onclick: () => { close(); pjvPatchTask(t.id, { [field]: null }, refresh); } }) : null);
            const close = pjvPopover(b, wrapPop);
            setTimeout(() => { input.focus(); if (input.showPicker) {
                try {
                    input.showPicker();
                }
                catch (_) { }
            } }, 0);
            input.onchange = () => { const v = input.value || null; close(); pjvPatchTask(t.id, { [field]: v }, refresh); };
        };
        return b;
    };
    wrap.append(mk('start_date', 'Start'), el('span', { class: 'pjv-tm-datearrow', text: '→' }), mk('due_date', 'Due'));
    return wrap;
}
function pjvtmPriorityField(t, refresh) {
    const m = t.priority ? PJV_PRIORITY[t.priority] : null;
    const btn = el('button', { class: 'pjv-tm-valbtn' + (m ? '' : ' empty'), type: 'button' });
    btn.append(m
        ? el('span', { class: 'pjv-flag ' + m.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' }), el('span', { class: 'pjv-flag-label', text: m.label }))
        : el('span', { text: 'Empty' }));
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu' });
        const close = pjvPopover(btn, menu);
        for (const key of PJV_PRIORITY_ORDER) {
            const pm = PJV_PRIORITY[key];
            const sel = t.priority === key;
            const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-flag ' + pm.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' })), el('span', { text: pm.label }));
            item.onclick = () => { close(); if (!sel)
                pjvPatchTask(t.id, { priority: key }, refresh); };
            menu.append(item);
        }
        const none = el('button', { class: 'pjv-menu-item' + (!t.priority ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
        none.onclick = () => { close(); if (t.priority)
            pjvPatchTask(t.id, { priority: null }, refresh); };
        menu.append(none);
    };
    return btn;
}
// 시간추적 — 총합 + 타이머 토글 + 수동입력 + 엔트리 목록(팝오버).
function pjvtmTimeField(d, t, refresh) {
    const time = d.time || { entries: [], total_seconds: 0, running: null };
    const wrap = el('div', { class: 'pjv-tm-time' });
    const running = time.running;
    const playBtn = el('button', { class: 'pjv-tm-timebtn' + (running ? ' on' : ''), type: 'button',
        title: running ? '타이머 정지' : '타이머 시작' }, el('span', { text: running ? '⏸' : '▶' }), el('span', { text: running ? '정지' : 'Start' }));
    playBtn.onclick = async () => {
        playBtn.disabled = true;
        try {
            await api('/api/ui/v6/tasks/' + t.id + '/time', { method: 'POST', body: JSON.stringify({ action: running ? 'stop' : 'start' }) });
            refresh();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            playBtn.disabled = false;
        }
    };
    wrap.append(playBtn);
    if (time.total_seconds > 0 || running) {
        wrap.append(el('span', { class: 'pjv-tm-timer-live', text: pjvFmtClock(time.total_seconds || 0) }));
    }
    // 더보기(수동 입력 + 엔트리 목록)
    const more = el('button', { class: 'pjv-tm-timemore', type: 'button', title: '시간 기록', text: '⋯' });
    more.onclick = (e) => { e.stopPropagation(); pjvtmTimePop(more, d, t, refresh); };
    wrap.append(more);
    return wrap;
}
function pjvtmTimePop(anchor, d, t, refresh) {
    const time = d.time || { entries: [] };
    const pop = el('div', { class: 'pjv-menu pjv-tm-timepop' });
    const close = pjvPopover(anchor, pop);
    // 수동 입력
    const hh = el('input', { type: 'number', min: '0', class: 'pjv-tm-tnum', placeholder: '0' });
    const mm = el('input', { type: 'number', min: '0', max: '59', class: 'pjv-tm-tnum', placeholder: '0' });
    const addBtn = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '추가' });
    addBtn.onclick = async () => {
        const secs = (Number(hh.value) || 0) * 3600 + (Number(mm.value) || 0) * 60;
        if (secs <= 0) {
            toast('시간을 입력하세요', true);
            return;
        }
        addBtn.disabled = true;
        try {
            await api('/api/ui/v6/tasks/' + t.id + '/time', { method: 'POST', body: JSON.stringify({ action: 'add', seconds: secs }) });
            close();
            refresh();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            addBtn.disabled = false;
        }
    };
    pop.append(el('div', { class: 'pjv-tm-tmanual' }, el('span', { class: 'pjv-tm-tlabel', text: '수동 입력' }), hh, el('span', { text: '시간' }), mm, el('span', { text: '분' }), addBtn));
    // 엔트리 목록
    if (time.entries && time.entries.length) {
        const list = el('div', { class: 'pjv-tm-tentries' });
        for (const en of time.entries) {
            if (en.ended_at == null)
                continue; // 실행중은 위 라이브 표시
            const row = el('div', { class: 'pjv-tm-tentry' }, el('span', { text: pjvFmtDuration(en.duration_seconds || 0) }), el('span', { class: 'pjv-tm-tentry-src', text: en.source === 'manual' ? '수동' : '타이머' }), el('button', { class: 'pjv-tm-tentry-x', type: 'button', title: '삭제', text: '✕',
                onclick: async () => {
                    try {
                        await api('/api/ui/v6/tasks/' + t.id + '/time', { method: 'POST', body: JSON.stringify({ action: 'delete', entry_id: en.id }) });
                        close();
                        refresh();
                    }
                    catch (e) {
                        toast('실패 — ' + e.message, true);
                    }
                } }));
            list.append(row);
        }
        pop.append(list);
    }
}
export { pjvtmAssigneeField, pjvtmCustomFields, pjvtmDatesField, pjvtmFieldRow, pjvtmPriorityField, pjvtmStatusField, pjvtmTimeField };
