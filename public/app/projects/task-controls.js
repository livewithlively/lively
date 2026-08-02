// projects/task-controls.ts — #1313 R31: web/projects.ts 분해 ②.
//  태스크 행·모달의 **인라인 편집 컨트롤** — 상태(커스텀/네이티브) · 담당자(다중) · 마감일 · 우선순위 와
//  그 저장 경로(pjvPatchTask=재페인트 / pjvSaveTask=조용히), 그리고 전체 구성원 디렉터리 1회 캐시.
//  ⚠ _pjvMemDir(디렉터리 캐시)는 이 모듈이 **단독 소유**한다 — 사본이 생기면 팝오버마다 따로 fetch 한다.
import { api, el, personFace, toast } from '../core.js';
import { pjvIcon } from './icons.js';
import { pjvPopover } from './popover.js';
import { PJV_PRIORITY, PJV_PRIORITY_ORDER, PJV_STATUS_CATS, PJV_STATUS_ORDER, PJV_TASK_STATUS, pjvCustomStatusDot, pjvFmtDate, pjvIsOverdue, pjvNativeStatusOf, pjvResolveStatusDef, pjvStatusIcon, pjvStatusIconBtn, pjvStatusIconStd, pjvStatusMeta, pjvTaskStatusDefs } from './status.js';
import { pjvReloadKeepScroll } from './state.js';
// 전체 사람 구성원 디렉터리(팀원 검색 후보) — /api/ui/dash/members 1회 캐시. 팀원 팝오버가 공유한다(memberPicker 와 동일 소스).
let _pjvMemDir = null;
function pjvMemberDirectory() {
    if (!_pjvMemDir)
        _pjvMemDir = api('/api/ui/dash/members').then((d) => (d && d.members) || []).catch((e) => { _pjvMemDir = null; throw e; });
    return _pjvMemDir;
}
// 필드 패치 — task_update_v6 호출 후 전체 재페인트. 실패 시 토스트.
async function pjvPatchTask(taskId, patch, reload) {
    try {
        await api('/api/ui/v6/tasks/' + taskId, { method: 'POST', body: JSON.stringify(patch) });
        pjvReloadKeepScroll(reload); // 태스크/하위태스크 상태·필드 변경 후 스크롤 보존(#358)
    }
    catch (e) {
        toast('수정 실패 — ' + e.message, true);
    }
}
// 상태 점(클릭→메뉴) — #731 프로젝트 행(pjvProjStatusDot)과 동일한 디자인으로 통일. 소속(루트 프로젝트) 리스트가
//  커스텀 상태면 그 상태들(색·이름·아이콘·진행 파이)을 그대로 제시하고, 아니면 네이티브 3단계(할 일/진행 중/완료).
//  projectId = 루트 프로젝트 id(태스크는 list_id 가 없어 이걸로 소속 리스트 커스텀 상태를 해소, pjvTaskStatusDefs).
function pjvStatusControl(t, reload, projectId) {
    const defs = pjvTaskStatusDefs(projectId);
    if (defs) {
        const cur = pjvResolveStatusDef(t.status_raw, t.status, defs) || defs[0];
        const btn = el('button', { class: 'pjv-status-btn', type: 'button',
            title: '상태: ' + cur.label, 'aria-label': '상태 ' + cur.label }, pjvStatusIcon(cur.category, cur.color, cur.frac));
        btn.onclick = (e) => {
            e.stopPropagation();
            const menu = el('div', { class: 'pjv-menu' });
            const close = pjvPopover(btn, menu);
            for (const cat of PJV_STATUS_CATS) {
                for (const d of defs.filter((x) => x.category === cat.key)) {
                    const isCur = d.key === cur.key;
                    const item = el('button', { class: 'pjv-menu-item' + (isCur ? ' sel' : ''), type: 'button' }, pjvCustomStatusDot(d, 'sm'), el('span', { text: d.label }));
                    item.onclick = () => { close(); if (!isCur)
                        pjvPatchTask(t.id, { status: pjvNativeStatusOf(d.category), status_raw: d.key }, reload); };
                    menu.append(item);
                }
            }
        };
        return btn;
    }
    const meta = pjvStatusMeta(t.status);
    const btn = pjvStatusIconBtn(pjvStatusIconStd(meta.bucket), { title: '상태: ' + meta.label, 'aria-label': '상태 ' + meta.label });
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu' });
        const close = pjvPopover(btn, menu);
        for (const key of PJV_STATUS_ORDER) {
            const m = PJV_TASK_STATUS[key];
            const sel = meta.bucket === key;
            const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' }, pjvStatusIconStd(key, 'sm'), el('span', { text: m.label }));
            item.onclick = () => { close(); if (!sel)
                pjvPatchTask(t.id, { status: key, status_raw: null }, reload); };
            menu.append(item);
        }
    };
    return btn;
}
// 담당자(아바타/이니셜, 클릭→프로젝트 팀원 선택 + '담당 없음').
// 담당자 다중 지정 — assignee 컬럼에 JSON 배열(["yoon","jang"]) 저장. 단일 문자열("yoon")은 레거시로 하위호환.
//  서버는 assignee 를 검증없이 문자열 그대로 저장하고 SQL 필터도 없어, 배열 직렬화만으로 다중이 된다(조인테이블 불요).
function pjvAssignees(t) {
    const a = t && t.assignee;
    if (a == null)
        return [];
    if (Array.isArray(a))
        return a.filter(Boolean);
    const s = String(a).trim();
    if (!s)
        return [];
    if (s[0] === '[') {
        try {
            const arr = JSON.parse(s);
            return Array.isArray(arr) ? arr.filter(Boolean) : [s];
        }
        catch (_) {
            return [s];
        }
    }
    return [s];
}
function pjvAssigneeWrite(ids) {
    const a = [...new Set((ids || []).filter(Boolean))];
    return a.length ? JSON.stringify(a) : null;
}
// 저장만(전체 reload 없이) — 다중 토글 중 메뉴를 닫지 않으려고 낙관적 갱신 + 백그라운드 저장.
function pjvSaveTask(taskId, patch) {
    return api('/api/ui/v6/tasks/' + taskId, { method: 'POST', body: JSON.stringify(patch) }).catch((e) => toast('수정 실패 — ' + e.message, true));
}
// 담당자 셀(다중) — 페이스파일 아바타(최대 3 + N) / 빈 아이콘. 메뉴=팀원 토글(체크 유지, 닫지 않음) + 담당 없음.
function pjvAssigneeControl(t, members, apply) {
    const nameOf = (id) => { const m = members.find((x) => x.member_id === id); return m ? (m.display_name || m.member_id) : id; };
    const btn = el('button', { class: 'pjv-cell-btn', type: 'button', title: '담당자' });
    function render() {
        const ids = pjvAssignees(t);
        btn.className = 'pjv-cell-btn' + (ids.length ? '' : ' empty');
        if (ids.length) {
            const faces = el('span', { class: 'pjv-asg-faces' });
            for (const id of ids.slice(0, 3))
                faces.append(personFace(id, 'pjv-ava', nameOf(id)));
            if (ids.length > 3)
                faces.append(el('span', { class: 'pjv-ava pjv-ava-more', text: '+' + (ids.length - 3) }));
            btn.replaceChildren(faces);
        }
        else {
            btn.replaceChildren(pjvIcon('assignee'));
        }
    }
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu pjv-asg-menu' });
        pjvPopover(btn, menu);
        const setIds = (ids) => { t.assignee = pjvAssigneeWrite(ids); render(); apply({ assignee: t.assignee }); rebuild(); };
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
                itemsBox.append(el('div', { class: 'pjv-menu-empty', text: '팀원을 먼저 추가하세요' }));
        }
        rebuild();
    };
    render();
    return btn;
}
// 마감일(YYYY-MM-DD, 표시는 m/d). 클릭→날짜입력 + 지우기.
function pjvDueControl(t, apply) {
    const overdue = pjvIsOverdue(t);
    const btn = el('button', { class: 'pjv-cell-btn' + (t.due_date ? '' : ' empty'), type: 'button', title: '마감일' });
    btn.append(t.due_date
        ? el('span', { class: 'pjv-due-text' + (overdue ? ' overdue' : ''), text: pjvFmtDate(t.due_date) })
        : pjvIcon('due'));
    btn.onclick = (e) => {
        e.stopPropagation();
        const input = el('input', { type: 'date', class: 'pjv-date-input', value: t.due_date || '' });
        const wrap = el('div', { class: 'pjv-menu pjv-date-pop' }, input, t.due_date ? el('button', { class: 'pjv-menu-item danger', type: 'button', text: '마감일 지우기',
            onclick: () => { close(); apply({ due_date: null }); } }) : null);
        const close = pjvPopover(btn, wrap);
        setTimeout(() => { input.focus(); if (input.showPicker) {
            try {
                input.showPicker();
            }
            catch (_) { /* noop */ }
        } }, 0);
        input.onchange = () => { const v = input.value || null; close(); apply({ due_date: v }); };
    };
    return btn;
}
// 우선순위(깃발, 색상). 클릭→긴급/높음/보통/낮음/없음.
function pjvPriorityControl(t, apply) {
    const m = t.priority ? PJV_PRIORITY[t.priority] : null;
    const btn = el('button', { class: 'pjv-cell-btn' + (m ? '' : ' empty'), type: 'button', title: '우선순위' });
    btn.append(m
        ? el('span', { class: 'pjv-flag ' + m.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' }), el('span', { class: 'pjv-flag-label', text: m.label }))
        : pjvIcon('priority'));
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu' });
        const close = pjvPopover(btn, menu);
        for (const key of PJV_PRIORITY_ORDER) {
            const pm = PJV_PRIORITY[key];
            const sel = t.priority === key;
            const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-flag ' + pm.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' })), el('span', { text: pm.label }));
            item.onclick = () => { close(); if (!sel)
                apply({ priority: key }); };
            menu.append(item);
        }
        const none = el('button', { class: 'pjv-menu-item' + (!t.priority ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
        none.onclick = () => { close(); if (t.priority)
            apply({ priority: null }); };
        menu.append(none);
    };
    return btn;
}
export { pjvAssigneeControl, pjvAssignees, pjvAssigneeWrite, pjvDueControl, pjvMemberDirectory, pjvPatchTask, pjvPriorityControl, pjvSaveTask, pjvStatusControl, };
