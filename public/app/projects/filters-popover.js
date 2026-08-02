// projects/filters-popover.ts — #1405 W2: filters.ts 분할 ②.
//  필터 편집 UI — 다중선택 피커·필드 선택 메뉴·조건 팝오버·담당자 팝오버.
//  의존은 단방향: filters-popover → filters-state.
import { el, personFace } from '../core.js';
import { pjvPopover } from './popover.js';
import { pjvCheckMini, pjvIcon, pjvTbIcon } from './icons.js';
import { PJV_PRIORITY, PJV_PRIORITY_ORDER, PJV_STATUS_CATS } from './status.js';
import { PJV_FILTER_FIELDS, PJV_FILTER_OPS, pjvAsgFilter, pjvFilterCount, pjvFilterFieldIcon, pjvFilterKind, pjvFilterState, pjvFilterUniverse } from './filters-state.js';
// ── 다중 선택 팝오버(값 고르기) — 검색 + 전체 선택 + 체크박스 목록. ClickUp 'Select option' 파리티. ──
//  opts: [{id, label, color?, count?, group?}]. sel=Set(문자열 id). onChange 마다 호출(팝오버는 안 닫힘).
function pjvMultiPick(anchor, title, opts, sel, onChange) {
    const pop = el('div', { class: 'pjv-menu pjv-multipick' });
    pjvPopover(anchor, pop);
    const search = el('input', { type: 'text', class: 'pjv-multipick-search', placeholder: '검색…' });
    const listBox = el('div', { class: 'pjv-multipick-list' });
    const head = el('div', { class: 'pjv-multipick-head' }, el('span', { class: 'pjv-multipick-title', text: title }));
    const all = el('button', { class: 'pjv-multipick-all', type: 'button', text: '전체 선택' });
    head.append(all);
    pop.append(el('div', { class: 'pjv-multipick-searchwrap' }, pjvTbIcon('search', 'sm'), search), head, listBox);
    const paint = () => {
        const q = search.value.trim().toLowerCase();
        const cand = opts.filter((o) => !q || String(o.label).toLowerCase().includes(q));
        const everyOn = cand.length > 0 && cand.every((o) => sel.has(String(o.id)));
        all.textContent = everyOn ? '전체 해제' : '전체 선택';
        if (!cand.length) {
            listBox.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '일치하는 항목이 없어요.' }));
            return;
        }
        const nodes = [];
        let lastGroup = undefined;
        for (const o of cand) {
            if (o.group !== undefined && o.group !== lastGroup) {
                nodes.push(el('div', { class: 'pjv-multipick-group', text: o.group }));
                lastGroup = o.group;
            }
            const on = sel.has(String(o.id));
            const row = el('button', { class: 'pjv-multipick-row' + (on ? ' on' : ''), type: 'button', role: 'checkbox', 'aria-checked': String(on) }, o.color ? el('span', { class: 'pjv-multipick-dot', style: 'background:' + o.color }) : (o.face || el('span', { class: 'pjv-multipick-dot none' })), el('span', { class: 'pjv-multipick-label', text: o.label }), o.count != null ? el('span', { class: 'pjv-multipick-count', text: String(o.count) }) : null, pjvCheckMini(on));
            row.onclick = (e) => { e.stopPropagation(); if (on)
                sel.delete(String(o.id));
            else
                sel.add(String(o.id)); paint(); onChange(); };
            nodes.push(row);
        }
        listBox.replaceChildren(...nodes);
    };
    all.onclick = (e) => {
        e.stopPropagation();
        const q = search.value.trim().toLowerCase();
        const cand = opts.filter((o) => !q || String(o.label).toLowerCase().includes(q));
        const everyOn = cand.length > 0 && cand.every((o) => sel.has(String(o.id)));
        for (const o of cand) {
            if (everyOn)
                sel.delete(String(o.id));
            else
                sel.add(String(o.id));
        }
        paint();
        onChange();
    };
    search.addEventListener('input', paint);
    paint();
    setTimeout(() => search.focus(), 0);
}
// 필터 행의 값 후보 — 필드별. 상태는 카테고리(Active/Done/Closed)로 묶어 보여준다(ClickUp 동형).
function pjvFilterOptsFor(field) {
    if (field === 'status') {
        const catLabel = { active: '진행', done: '완료', closed: '닫힘' };
        return [...pjvFilterUniverse.statuses]
            .sort((a, b) => PJV_STATUS_CATS.findIndex((c) => c.key === a.category) - PJV_STATUS_CATS.findIndex((c) => c.key === b.category))
            .map((d) => ({ id: d.key, label: d.label, color: d.color, group: catLabel[d.category] || '진행' }));
    }
    if (field === 'assignee')
        return pjvFilterUniverse.members.map((m) => ({ id: m.id, label: m.name, face: personFace(m.id, 'pjv-ava', m.name), count: pjvFilterUniverse.counts.member.get(m.id) }));
    if (field === 'priority')
        return PJV_PRIORITY_ORDER.map((k) => ({ id: k, label: PJV_PRIORITY[k].label }));
    if (field === 'tag')
        return pjvFilterUniverse.tags.map((t) => ({ id: t.id, label: t.name, color: t.color }));
    return [];
}
// 필드 선택 드롭다운 — 검색 + 아이콘 목록. 필드가 늘어나도(커스텀 필드 등) 스크롤·검색으로 감당된다.
function pjvFilterFieldMenu(anchor, current, onPick) {
    const pop = el('div', { class: 'pjv-menu pjv-fieldpick' });
    const close = pjvPopover(anchor, pop);
    const search = el('input', { type: 'text', class: 'pjv-multipick-search', placeholder: '검색…' });
    const listBox = el('div', { class: 'pjv-fieldpick-list' });
    pop.append(el('div', { class: 'pjv-multipick-searchwrap' }, pjvTbIcon('search', 'sm'), search), listBox);
    const paint = () => {
        const q = search.value.trim().toLowerCase();
        const cand = PJV_FILTER_FIELDS.filter((f) => !q || f.label.toLowerCase().includes(q));
        if (!cand.length) {
            listBox.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '일치하는 필드가 없어요.' }));
            return;
        }
        listBox.replaceChildren(...cand.map((f) => {
            const on = current === f.key;
            const it = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' }, pjvFilterFieldIcon(f.key), el('span', { class: 'pjv-fieldpick-name', text: f.label }), el('span', { class: 'pjv-menu-check', text: on ? '✓' : '' }));
            it.onclick = (e) => { e.stopPropagation(); close(); onPick(f.key); };
            return it;
        }));
    };
    search.addEventListener('input', paint);
    search.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter')
            return; // Enter = 첫 후보 선택(타이핑만으로 끝나게)
        const first = listBox.querySelector('.pjv-menu-item');
        if (first) {
            e.preventDefault();
            first.click();
        }
    });
    paint();
    setTimeout(() => search.focus(), 0);
}
// ── '필터' 팝오버 — 조건행 목록 + 모두/아무 + 값 선택 + 삭제 + 조건 추가 + 전체 해제. ──
function pjvFilterPopover(anchor, onChange) {
    const pop = el('div', { class: 'pjv-menu pjv-filter-pop' });
    pjvPopover(anchor, pop, { align: 'right' });
    const rowsBox = el('div', { class: 'pjv-filter-rows' });
    const head = el('div', { class: 'pjv-filter-head' }, el('span', { class: 'pjv-filter-title', text: '필터' }));
    const clearAll = el('button', { class: 'pjv-filter-clear', type: 'button', text: '모두 지우기' });
    clearAll.onclick = (e) => { e.stopPropagation(); pjvFilterState.rows = []; paint(); onChange(); };
    head.append(clearAll);
    const addBtn = el('button', { class: 'pjv-filter-add', type: 'button' }, pjvTbIcon('plus', 'sm'), el('span', { text: '필터 추가' }));
    // 조건을 추가하면 곧바로 필드 드롭다운까지 연다 — 추가만 하고 멈추면 '빈 줄'만 생겨 한 번 더 눌러야 한다.
    addBtn.onclick = (e) => { e.stopPropagation(); pjvFilterState.rows.push({ field: null, op: 'is', values: [] }); paint(); openFieldMenuFor(pjvFilterState.rows.length - 1); };
    pop.append(head, rowsBox, addBtn);
    // 방금 그린 n번째 행의 필드 셀렉트를 눌러 준다(paint 직후라 DOM 이 이미 있다).
    const openFieldMenuFor = (i) => setTimeout(() => {
        const sels = rowsBox.querySelectorAll('.pjv-filter-field');
        const b = sels[i];
        if (b)
            b.click();
    }, 0);
    const mkSelect = (label, cls, onOpen) => {
        const b = el('button', { class: 'pjv-filter-sel ' + cls, type: 'button' }, el('span', { class: 'pjv-filter-sel-label', text: label }), pjvTbIcon('caret', 'sm'));
        b.onclick = (e) => { e.stopPropagation(); onOpen(b); };
        return b;
    };
    const valueLabel = (r) => {
        const kind = pjvFilterKind(r.field);
        if (kind === 'text')
            return (r.values || [])[0] ? String(r.values[0]) : '값 입력';
        if (kind === 'date')
            return (r.values || [])[0] ? String(r.values[0]) : '날짜 선택';
        const opts = pjvFilterOptsFor(r.field);
        const sel = (r.values || []).map(String);
        if (!sel.length)
            return '값 선택';
        const first = opts.find((o) => String(o.id) === sel[0]);
        return (first ? first.label : sel[0]) + (sel.length > 1 ? ' +' + (sel.length - 1) : '');
    };
    function paint() {
        clearAll.style.display = pjvFilterCount() ? '' : 'none';
        if (!pjvFilterState.rows.length) {
            rowsBox.replaceChildren(el('div', { class: 'pjv-filter-empty', text: '조건이 없어요. 아래에서 필터를 추가하세요.' }));
            return;
        }
        const nodes = [];
        pjvFilterState.rows.forEach((r, i) => {
            const kind = pjvFilterKind(r.field);
            const line = el('div', { class: 'pjv-filter-row' });
            // 첫 행은 '조건', 둘째 행부터 모두 충족(and)/하나라도(or) 선택기 — 전체 행에 공통 적용.
            if (i === 0)
                line.append(el('span', { class: 'pjv-filter-lead', text: '조건' }));
            else {
                const m = mkSelect(pjvFilterState.match === 'or' ? '하나라도' : '모두 충족', 'pjv-filter-match', (b) => {
                    const menu = el('div', { class: 'pjv-menu' });
                    const close = pjvPopover(b, menu);
                    for (const o of [{ k: 'and', l: '모두 충족' }, { k: 'or', l: '하나라도' }]) {
                        const it = el('button', { class: 'pjv-menu-item' + (pjvFilterState.match === o.k ? ' sel' : ''), type: 'button' }, el('span', { text: o.l }));
                        it.onclick = (ev) => { ev.stopPropagation(); close(); pjvFilterState.match = o.k; paint(); onChange(); };
                        menu.append(it);
                    }
                });
                line.append(m);
            }
            const fdef = PJV_FILTER_FIELDS.find((f) => f.key === r.field);
            const fieldSel = mkSelect(fdef ? fdef.label : '필터 선택', 'pjv-filter-field' + (fdef ? '' : ' is-empty'), (b) => {
                pjvFilterFieldMenu(b, r.field, (key) => {
                    if (r.field === key)
                        return;
                    r.field = key;
                    r.values = [];
                    r.op = PJV_FILTER_OPS[pjvFilterKind(key)][0].key; // 필드가 바뀌면 연산자도 그 형의 기본으로
                    paint();
                    onChange();
                });
            });
            if (fdef)
                fieldSel.prepend(pjvFilterFieldIcon(r.field));
            line.append(fieldSel);
            // 필드를 아직 안 고른 행 — 연산자·값 칸을 그리지 않는다(고를 게 정해지지 않았다). 삭제만 가능.
            if (!r.field) {
                const del0 = el('button', { class: 'pjv-filter-del', type: 'button', title: '이 조건 삭제', 'aria-label': '이 조건 삭제' }, pjvTbIcon('trash', 'sm'));
                del0.onclick = (e) => { e.stopPropagation(); pjvFilterState.rows.splice(i, 1); paint(); onChange(); };
                line.append(del0);
                nodes.push(line);
                return;
            }
            const ops = PJV_FILTER_OPS[kind];
            const odef = ops.find((o) => o.key === r.op) || ops[0];
            r.op = odef.key;
            // 한국어 어순(#1067) — [필터 항목][값][이다/아니다]. 연산자(술어)가 맨 뒤로 온다: "우선순위 · 높음 · 이다".
            //  그래서 연산자 셀렉트는 만들어만 두고, 값 칸을 먼저 붙인 **뒤** 맨 끝에 붙인다.
            const opSel = mkSelect(odef.label, 'pjv-filter-op', (b) => {
                const menu = el('div', { class: 'pjv-menu' });
                const close = pjvPopover(b, menu);
                for (const o of ops) {
                    const it = el('button', { class: 'pjv-menu-item' + (r.op === o.key ? ' sel' : ''), type: 'button' }, el('span', { text: o.label }));
                    it.onclick = (ev) => { ev.stopPropagation(); close(); r.op = o.key; paint(); onChange(); };
                    menu.append(it);
                }
            });
            // 값 — '있음/없음'은 값이 필요 없다(ClickUp 동형: 값칸 자체를 안 그림) → 그땐 [필터 항목][있음]만.
            if (r.op !== 'set' && r.op !== 'unset') {
                if (kind === 'text') {
                    const inp = el('input', { type: 'text', class: 'pjv-filter-text', placeholder: '텍스트', value: (r.values || [])[0] || '' });
                    inp.addEventListener('input', () => { r.values = [inp.value]; onChange(); });
                    inp.addEventListener('click', (e) => e.stopPropagation());
                    line.append(inp);
                }
                else if (kind === 'date') {
                    const inp = el('input', { type: 'date', class: 'pjv-filter-date', value: (r.values || [])[0] ? String(r.values[0]).slice(0, 10) : '' });
                    inp.addEventListener('change', () => { r.values = inp.value ? [inp.value] : []; onChange(); });
                    inp.addEventListener('click', (e) => e.stopPropagation());
                    line.append(inp);
                }
                else {
                    line.append(mkSelect(valueLabel(r), 'pjv-filter-val', (b) => {
                        const sel = new Set((r.values || []).map(String));
                        pjvMultiPick(b, (fdef ? fdef.label : '값') + ' 선택', pjvFilterOptsFor(r.field), sel, () => {
                            r.values = [...sel];
                            const lbl = b.querySelector('.pjv-filter-sel-label');
                            if (lbl)
                                lbl.textContent = valueLabel(r);
                            onChange();
                        });
                    }));
                }
            }
            line.append(opSel); // 술어(이다/아니다/있음/없음)는 맨 끝 — 한국어 어순
            const del = el('button', { class: 'pjv-filter-del', type: 'button', title: '이 조건 삭제', 'aria-label': '이 조건 삭제' }, pjvTbIcon('trash', 'sm'));
            del.onclick = (e) => { e.stopPropagation(); pjvFilterState.rows.splice(i, 1); paint(); onChange(); };
            line.append(del);
            nodes.push(line);
        });
        rowsBox.replaceChildren(...nodes);
    }
    // 열릴 때: 지난번에 필드를 안 고르고 닫은 빈 줄은 치우고, 조건이 하나도 없으면 **곧장** 한 줄 + 필드 드롭다운까지.
    //  예전엔 [필터] → [필터 추가] → [필드] 세 번 눌러야 첫 조건을 골랐다(ClickUp 은 버튼 한 번).
    pjvFilterState.rows = (pjvFilterState.rows || []).filter((r) => r && r.field);
    const fresh = !pjvFilterState.rows.length;
    if (fresh)
        pjvFilterState.rows.push({ field: null, op: 'is', values: [] });
    paint();
    if (fresh)
        openFieldMenuFor(0);
}
// ── '담당자' 빠른필터 팝오버 — 검색 + 미지정 + 사람별 개수(ClickUp Assignees 파리티). ──
function pjvAssigneePopover(anchor, onChange) {
    const opts = [
        { id: '__none__', label: '미지정', count: pjvFilterUniverse.counts.none, face: pjvIcon('assignee') },
        ...pjvFilterUniverse.members.map((m) => ({ id: m.id, label: m.name, count: pjvFilterUniverse.counts.member.get(m.id), face: personFace(m.id, 'pjv-ava', m.name) })),
    ];
    const sel = new Set([...pjvAsgFilter.ids]);
    if (pjvAsgFilter.none)
        sel.add('__none__');
    pjvMultiPick(anchor, '담당자', opts, sel, () => {
        pjvAsgFilter.none = sel.has('__none__');
        pjvAsgFilter.ids = new Set([...sel].filter((x) => x !== '__none__'));
        onChange();
    });
}
export { pjvAssigneePopover, pjvFilterPopover };
