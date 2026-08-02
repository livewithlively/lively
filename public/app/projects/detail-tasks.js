// projects/detail-tasks.ts — #1313 R35: web/projects.ts 분해 ⑥.
//  프로젝트 상세의 **태스크 리스트뷰**(클릭업형) 한 벌 — 섹션·상태 그룹·인라인 추가행·행 렌더러·⋯메뉴.
//
//  ⚠⚠ 몽키패치 IIFE 2개가 이 모듈 안에 있다. pjvTaskRow 는 **런타임에 두 번 감싸여 교체되는** 바인딩이다:
//    ① __tmWrapped    — 제목 클릭 → 태스크 상세 모달 배선
//    ② __cfDblWrapped — 그 위를 다시 감싸 캡처 단계에서 단일/더블 클릭을 가른다(1회=모달, 2회=하위 추가)
//   두 IIFE 는 **정의 바로 아래에 인접 배치**한다 — 정의와 패치가 다른 모듈로 갈라지면 소비자가 어느 쪽을
//   잡았는지 코드만 봐서는 알 수 없다. 적용 순서(①→②)도 그 배치가 곧 보증한다(②가 ①의 결과를 _inner 로 감싼다).
//   ⚠ 소비자는 반드시 **import 바인딩(live binding)** 으로만 호출한다 — 배럴도 `export { pjvTaskRow } from …`
//    형태(값 복사 아님)를 유지한다. 로컬 상수로 복사해 두면 **패치 이전 함수**를 잡아 제목 클릭이 죽는다.
//   같은 모듈 안(pjvStatusGroup·pjvAddRow·재귀 하위행)의 호출도 모듈 지역 바인딩이라 자동으로 패치본을 본다.
//   가드(scripts/pjv-taskrow-monkeypatch.test.mjs)가 이 배치·재수출 형태·교체 순서를 CI 에서 못박는다.
//
//  ⚠ 하위 태스크 표시 모드 메뉴(PJV_SUBTASK_OPTS·pjvSubtaskMenu)는 보드 툴바와 공유라 projects/board.ts 소유 —
//   배럴에서 받는다(R32/R33 이 남긴 역방향 엣지와 같은 부류, 정리는 R56 소관).
// 배럴 경유(../projects.js) — 하위 태스크 표시 모드 메뉴는 보드 툴바와 공유(#1313 R36 이후 projects/board.ts 소유),
//  pjvOpenTaskModal 은 taskmodal 소유(직접 엣지 금지 — R33).
import { api, el, toast } from '../core.js';
import { PJV_SUBTASK_BTNLABEL, pjvOpenTaskModal, pjvSubtaskMenu } from '../projects.js';
import { pjvApplyColWidths, pjvApplyHiddenCols, pjvGridTemplate, pjvInitNameResize, pjvNameResizeHandle, pjvStdColHead } from './columns.js';
import { pjvAddColumnButton, pjvColumnHead, pjvFieldControl } from './fields.js';
import { pjvCheckCircle, pjvSubtaskIcon } from './icons.js';
import { pjvGrpOpenGet, pjvGrpOpenSet } from './rows.js';
import { pjvGroupCheck, pjvRowActions, pjvRowCheck, pjvRowGrip, pjvRowTagsEl, pjvTagPopover } from './selection.js';
import { pjvClosedView, pjvReloadKeepScroll, pjvSubtaskMode } from './state.js';
import { PJV_TASK_STATUS, pjvStatusIconStd, pjvStatusMeta } from './status.js';
import { pjvAssigneeControl, pjvDueControl, pjvPatchTask, pjvPriorityControl, pjvSaveTask, pjvStatusControl } from './task-controls.js';
import { pjvRenameTask, pjvRowMore, pjvShowInlineSubtask } from './detail-task-actions.js';
// 태스크 섹션 — [태스크 N개][Closed 토글] 헤더 + 컬럼헤더 + 상태 그룹(할 일/진행 중/Closed). 클릭업식 리스트뷰.
//  할 일·진행 중은 비어도 항상 표시(인라인 추가행). Closed(완료) 그룹은 기본 숨김 — 헤더의 Closed 토글로만 노출.
//  fields = 커스텀 필드 정의(루트 프로젝트). 컬럼 헤더·각 행에 필드 셀을 끼우고 grid-template 을 동적으로.
function pjvTasksSection(projectId, tasks, members, reload, fields) {
    fields = fields || [];
    const card = el('div', { class: 'card pjv-tasks-card', style: 'margin-bottom:18px' });
    pjvInitNameResize(card, 'pjv:nameMin:task:' + projectId); // 이름칸 폭 드래그 저장/복원 — 프로젝트별(#483)
    pjvApplyHiddenCols(card, 'task'); // 숨긴 기본 컬럼 복원(#req)
    pjvApplyColWidths(card, 'task'); // 저장된 컬럼 폭 복원(#666)
    // Closed 토글 버튼 — 누르면 태스크/하위태스크 popover. 활성(노출 중) 시 파란 강조.
    const closedBtn = el('button', { class: 'pjv-closed-btn', type: 'button', title: '닫힌(완료) 항목 표시' }, pjvCheckCircle(), el('span', { text: 'Closed' }));
    const syncBtn = () => closedBtn.classList.toggle('active', pjvClosedView.tasks || pjvClosedView.subtasks);
    syncBtn();
    // 본문 — Closed 토글 시 서버 재요청 없이 즉시 재렌더(이미 받은 tasks 를 필터).
    const body = el('div', { class: 'pjv-tasks-body' });
    const renderGroups = () => {
        body.replaceChildren();
        if (!tasks.length) {
            body.append(el('div', { class: 'pjv-empty-hint' }, el('b', { text: '아직 태스크가 없어요.' }), ' 아래 ', el('span', { class: 'pjv-empty-chip', text: '＋ 태스크' }), ' 를 눌러 이름을 적고 Enter — 첫 할 일을 추가하세요.'));
        }
        // 별도 컬럼헤더 행 없음 — 컬럼 라벨은 첫(맨 위) 그룹 헤더에 합친다(withCols).
        const buckets = { todo: [], in_progress: [], done: [] };
        const sep = pjvSubtaskMode.mode === 'separate';
        for (const t of tasks) {
            buckets[pjvStatusMeta(t.status).bucket].push(t);
            if (sep)
                for (const s of (t.subtasks || [])) {
                    if (!pjvClosedView.subtasks && s.status === 'done')
                        continue;
                    buckets[pjvStatusMeta(s.status).bucket].push(s);
                }
        }
        let firstShown = true;
        for (const key of ['in_progress', 'todo', 'done']) { // 진행 중을 할 일 위로(기본 레이아웃)
            if (key === 'done' && !pjvClosedView.tasks)
                continue; // Closed 그룹은 토글 시에만 노출
            body.append(pjvStatusGroup(projectId, key, buckets[key], members, reload, fields, firstShown));
            firstShown = false;
        }
    };
    // Closed 버튼 = 직접 토글. 한 번 누르면 닫힌(완료) 태스크가 보이고 버튼이 활성(파란) 상태, 다시 누르면 숨김.
    //  하위 닫힘 항목도 함께 따라오게 묶는다(Closed = '닫힌 것 보기' 한 동작).
    closedBtn.onclick = (e) => {
        e.stopPropagation();
        const nv = !pjvClosedView.tasks;
        pjvClosedView.tasks = nv;
        pjvClosedView.subtasks = nv;
        syncBtn();
        renderGroups();
    };
    // 좌상단 하위 태스크(Subtasks) 버튼 — 접힘/펼침/분리. 활성(펼침·분리) 시 파란 강조. (Closed 는 우측 유지)
    const subtaskBtn = el('button', { class: 'pjv-subtask-btn', type: 'button', title: '하위 태스크 표시 방식' }, pjvSubtaskIcon(), el('span', { class: 'pjv-subtask-btn-label', text: PJV_SUBTASK_BTNLABEL[pjvSubtaskMode.mode] }));
    const syncSubBtn = () => {
        subtaskBtn.classList.toggle('active', pjvSubtaskMode.mode !== 'collapsed');
        const lbl = subtaskBtn.querySelector('.pjv-subtask-btn-label');
        if (lbl)
            lbl.textContent = PJV_SUBTASK_BTNLABEL[pjvSubtaskMode.mode];
    };
    syncSubBtn();
    subtaskBtn.onclick = (e) => { e.stopPropagation(); pjvSubtaskMenu(subtaskBtn, () => { syncSubBtn(); renderGroups(); }); };
    card.append(el('div', { class: 'card-head' }, el('div', { class: 'pjv-tasks-head-left' }, el('h2', { text: '태스크' }), subtaskBtn), el('div', { class: 'card-head-actions' }, closedBtn)));
    card.append(body);
    renderGroups();
    return card;
}
// 상태 그룹 — head(캐럿·점·라벨·개수) + body(행들 + 인라인 추가행). 완료 그룹엔 추가행 없음.
// withCols=true 면(첫 그룹) 별도 컬럼헤더 행 대신 이 그룹 헤더에 컬럼 라벨(담당자/마감일/우선순위+커스텀)을 합쳐 컬럼 위에 정렬한다.
function pjvStatusGroup(projectId, key, list, members, reload, fields, withCols) {
    const m = PJV_TASK_STATUS[key];
    const body = el('div', { class: 'pjv-tgroup-body' });
    for (const t of list)
        body.append(pjvTaskRow(projectId, t, members, reload, 0, fields));
    const countEl = el('span', { class: 'pjv-tgroup-count', text: String(list.length) });
    if (key !== 'done')
        body.append(pjvAddRow(projectId, key, members, reload, body, countEl, fields));
    // 태스크 상태 그룹 접힘도 새로고침에 유지(#req) — 프로젝트 스코프('p'+id 로 리스트 id 와 네임스페이스 분리). 기본 펼침.
    let gopen = pjvGrpOpenGet('p' + projectId, key);
    body.hidden = !gopen;
    const gcaret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: gopen ? '▾' : '▸', 'aria-expanded': String(gopen) });
    gcaret.onclick = () => {
        gopen = !gopen;
        gcaret.textContent = gopen ? '▾' : '▸';
        gcaret.setAttribute('aria-expanded', gopen ? 'true' : 'false');
        body.hidden = !gopen;
        pjvGrpOpenSet('p' + projectId, key, gopen);
    };
    const dot = pjvStatusIconStd(key, 'sm');
    const labelEl = el('span', { class: 'pjv-tgroup-label', text: m.label });
    let head;
    if (withCols) {
        // 컬럼 라벨을 행 그리드에 맞춰 헤더에 합침(별도 thead 없음). 좌측 첫 칸 = 그룹 라벨(+#664 전체선택 체크박스).
        head = el('div', { class: 'pjv-tgroup-head pjv-tgroup-head-cols ' + m.cls }, el('div', { class: 'pjv-trow-title-cell' }, pjvGroupCheck('task', body), dot, labelEl, countEl, gcaret, pjvNameResizeHandle()), pjvStdColHead('task', 'assignee', '담당자'), pjvStdColHead('task', 'due', '마감일'), pjvStdColHead('task', 'priority', '우선순위'), ...(fields || []).map((f) => pjvColumnHead(f, projectId, reload)), el('div', { class: 'pjv-tcell pjv-tcell-add' }, pjvAddColumnButton(projectId, reload)));
        head.style.gridTemplateColumns = pjvGridTemplate(fields);
    }
    else {
        // 컬럼 없는 그룹(할 일/완료)도 첫 그룹(진행 중, withCols)과 같은 제목칸 구조(체크박스+점+라벨)를
        // 써서 그룹 헤더의 가로 들여쓰기·정렬이 그룹마다 동일하게 보이도록 한다(#295).
        head = el('div', { class: 'pjv-tgroup-head ' + m.cls }, el('div', { class: 'pjv-trow-title-cell' }, pjvGroupCheck('task', body), dot, labelEl, countEl, gcaret));
    }
    return el('div', { class: 'pjv-tgroup' }, head, body);
}
// 인라인 추가행(클릭업식) — 클릭→입력칸, Enter=생성(연속 추가 위해 입력 유지·낙관적 삽입), Esc/빈 blur=접기.
//  생성은 그 그룹 상태로(todo 외엔 생성 후 status 패치). 모달 없이 그 자리에서 바로.
function pjvAddRow(projectId, status, members, reload, body, countEl, fields) {
    const row = el('div', { class: 'pjv-addrow' });
    let indentParent = null; // Tab 들여쓰기 — 바로 위 상위태스크의 하위로 만들 때 그 부모 {id,name}. Shift+Tab 으로 해제.
    const trigger = el('button', { class: 'pjv-addrow-trigger', type: 'button', 'data-tour': 'pd-add-task' }, // #853 '프로젝트 체험' 투어 앵커
    el('span', { class: 'pjv-addrow-plus', text: '＋' }), el('span', { text: '태스크' }));
    const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '태스크 이름 입력 후 Enter (Esc 취소)', maxlength: '200' });
    // 생성 전 드래프트 — 담당자·마감·우선순위를 미리 지정해 생성 직후 한 번에 적용(클릭업식). 셀은 행과 동일.
    const draft = { assignee: null, due_date: null, priority: null };
    const cAssignee = el('div', { class: 'pjv-tcell' });
    const cDue = el('div', { class: 'pjv-tcell' });
    const cPriority = el('div', { class: 'pjv-tcell' });
    const setDraft = (p) => { Object.assign(draft, p); paintCells(); setTimeout(() => { if (row.classList.contains('editing'))
        input.focus(); }, 0); };
    function paintCells() {
        cAssignee.replaceChildren(pjvAssigneeControl(draft, members, (p) => { Object.assign(draft, p); }));
        cDue.replaceChildren(pjvDueControl(draft, setDraft));
        cPriority.replaceChildren(pjvPriorityControl(draft, setDraft));
    }
    const collapse = () => { row.classList.remove('editing'); draft.assignee = draft.due_date = draft.priority = null; indentParent = null; row.replaceChildren(trigger); };
    // 추가행 제목 칸 — 실제 태스크 행과 동일 구조(캐럿 자리 + 상태 동그라미 + 입력)로 그린다. 들여쓰면 paddingLeft 22px(하위 위치)
    //  + 상태 동그라미는 todo(점선). 안 들여쓰면 그룹 상태 동그라미. → 입력 텍스트·동그라미가 행과 픽셀 단위로 정확히 일치.
    const statusDotPlaceholder = (st) => pjvStatusIconStd(pjvStatusMeta(st).bucket);
    const buildTitleCell = () => {
        // 실제 태스크 행 제목칸 맨 앞에는 선택 체크박스(.pjv-row-check, 16px)가 있다. 추가행에도 같은 폭의
        // 스페이서를 둬서 입력 글자가 시작되는 들여쓰기 위치를 행 제목과 정확히 같게 한다(#292).
        const tc = el('div', { class: 'pjv-trow-title-cell' }, el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }), el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' }), statusDotPlaceholder(indentParent ? 'todo' : status), input);
        if (indentParent)
            tc.style.paddingLeft = '22px';
        return tc;
    };
    // 펼침: 태스크 행과 동일한 그리드 — 이름 입력 + 담당자·마감·우선순위 드래프트 셀(생성 시 적용). 커스텀 필드는 생성 후 행에서.
    const expand = () => {
        row.classList.add('editing');
        row.style.gridTemplateColumns = pjvGridTemplate(fields);
        paintCells();
        row.replaceChildren(buildTitleCell(), cAssignee, cDue, cPriority, ...(fields || []).map(() => el('div', { class: 'pjv-tcell' })), el('div', { class: 'pjv-tcell pjv-tcell-add' }));
        input.focus();
    };
    trigger.onclick = expand;
    // Tab 들여쓰기 시각화 — 제목 칸을 한 단 들이고(하위 느낌) 안내문을 부모 이름으로 바꾼다.
    const applyIndent = () => {
        const old = row.querySelector('.pjv-trow-title-cell');
        if (old)
            old.replaceWith(buildTitleCell()); // 캐럿+동그라미+들여쓰기까지 하위태스크 행과 동일하게 다시 그림
        input.placeholder = indentParent
            ? ('“' + (indentParent.name || '상위 태스크') + '” 의 하위 — 이름 입력 후 Enter (Shift+Tab 해제)')
            : '태스크 이름 입력 후 Enter (Esc 취소)';
        input.focus();
    };
    let busy = false;
    // 생성 — Enter(keepOpen=연속추가) 또는 바깥클릭. 생성 후 드래프트(담당자·마감·우선순위)를 한 번에 패치.
    const commit = async (keepOpen) => {
        if (busy)
            return;
        const name = input.value.trim();
        if (!name) {
            if (!keepOpen)
                collapse();
            return;
        }
        busy = true;
        input.disabled = true;
        if (indentParent) {
            // Tab 들여쓰기 — 위 상위태스크의 하위로 생성. 생성 후 reload 로 중첩 반영(부모 caret·하위수 갱신).
            try {
                await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name, parent_task_id: indentParent.id }) });
                pjvReloadKeepScroll(reload); /* 들여쓰기 하위 추가 후 스크롤 보존(#459) */
            }
            catch (err) {
                toast('하위 추가 실패 — ' + err.message, true);
                input.disabled = false;
                busy = false;
            }
            return;
        }
        try {
            const created = await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name }) }).then((d) => d && d.task);
            if (created && status !== 'todo') {
                await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify({ status }) }).catch(() => { });
            }
            const patch = {};
            if (draft.assignee)
                patch.assignee = draft.assignee;
            if (draft.due_date)
                patch.due_date = draft.due_date;
            if (draft.priority)
                patch.priority = draft.priority;
            if (created && Object.keys(patch).length) {
                await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify(patch) }).catch(() => { });
            }
            const t = Object.assign({ priority: null, assignee: null, due_date: null }, created, patch, { status, subtasks: [], field_values: {} });
            body.insertBefore(pjvTaskRow(projectId, t, members, reload, 0, fields), row);
            if (countEl)
                countEl.textContent = String((parseInt(countEl.textContent, 10) || 0) + 1);
            const card = row.closest('.pjv-tasks-card');
            const hint = card && card.querySelector('.pjv-empty-hint');
            if (hint)
                hint.remove();
            input.value = '';
            input.disabled = false;
            busy = false;
            draft.assignee = draft.due_date = draft.priority = null;
            paintCells();
            if (keepOpen)
                input.focus();
            else
                collapse();
        }
        catch (err) {
            toast('추가 실패 — ' + err.message, true);
            input.disabled = false;
            busy = false;
        }
    };
    // 바깥클릭(=커밋) 가드 — 셀 팝오버 편집 중이거나 행 내부 포커스면 보류(드래프트 설정 중 조기 생성 방지).
    input.addEventListener('blur', () => {
        setTimeout(() => {
            if (busy || !row.classList.contains('editing'))
                return;
            if (document.querySelector('.pjv-pop'))
                return; // 셀 팝오버 편집 중
            if (row.contains(document.activeElement))
                return; // 행 내부 포커스(셀 버튼 등)
            commit(false);
        }, 130);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            input.value = '';
            collapse();
            return;
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            if (e.shiftKey) {
                if (indentParent) {
                    indentParent = null;
                    applyIndent();
                    input.focus();
                }
                return;
            }
            // 들여쓰기 — 바로 위 상위태스크를 부모로(클릭업식). 위에 (상위)태스크가 없으면 무시.
            const prev = row.previousElementSibling;
            const pid = prev && prev.dataset ? prev.dataset.taskId : null;
            if (pid && prev.dataset.taskLevel !== 'subtask') {
                indentParent = { id: Number(pid), name: prev.dataset.taskName || '' };
                applyIndent();
                input.focus();
            }
            return;
        }
        // 한글(IME) 조합 중 Enter 는 글자 확정용 — 그때 생성하면 마지막 글자가 중복된 이름이 만들어진다(#293 와 동일 버그).
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            commit(true);
        }
    });
    collapse();
    return row;
}
// 태스크 한 행 — [캐럿][상태점] 제목 [하위수] | 담당자 | 마감일 | 우선순위 | [⋯]. 하위는 중첩(상위만 하위 추가 가능).
function pjvTaskRow(projectId, t, members, reload, depth, fields) {
    depth = depth || 0;
    fields = fields || [];
    // 닫힌(완료) 하위는 Closed>하위태스크 토글 시에만 노출(클릭업 동형). separate 모드면 하위는 최상위 행으로 빠져 중첩 X.
    const allSubs = t.subtasks || [];
    const subsVisible = pjvClosedView.subtasks ? allSubs : allSubs.filter((s) => s.status !== 'done');
    const subs = pjvSubtaskMode.mode === 'separate' ? [] : subsVisible;
    const isDone = t.status === 'done';
    const wrap = el('div', { class: 'pjv-trow-wrap', 'data-task-id': t.id, 'data-task-name': t.name || t.title || '', 'data-task-level': t.level || 'task' });
    let open = false;
    const caret = subs.length
        ? el('button', { class: 'pjv-trow-caret', type: 'button', 'aria-expanded': 'false', text: '▸' })
        : el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' });
    // el() 로 구성 — null 자식을 건너뛴다(네이티브 .append(null) 은 "null" 텍스트를 삽입하므로 금지).
    // 태그 칩(클릭업식) — 이름 옆에 최대 2개 + 나머지는 "+N". 색은 태그 색.
    const tagsEl = pjvRowTagsEl(t, reload);
    const subcountEl = subs.length ? el('span', { class: 'pjv-trow-subcount pjv-subcount-ico clickable', role: 'button', tabindex: '0', title: subs.length + '개 하위 — 클릭하여 펼치기' }, pjvSubtaskIcon(), el('span', { text: String(subs.length) })) : null;
    const titleCell = el('div', { class: 'pjv-trow-title-cell' }, pjvRowGrip('task', t, { reload }), // 좌측 드래그 핸들(#366) — 잡고 끌어 순서 변경
    pjvRowCheck('task', t, { reload, projectId, members }), caret, pjvStatusControl(t, reload, projectId), el('span', { class: 'pjv-trow-title' + (isDone ? ' done' : ''), text: t.name || t.title || '(제목 없음)' }), subcountEl, tagsEl);
    if (depth)
        titleCell.style.paddingLeft = (depth * 22) + 'px';
    // 하위 영역 — 하위 행도 pjvTaskRow 재귀라 담당자·마감일·우선순위·커스텀필드까지 상위와 완전 동일하게 동작.
    const subBox = el('div', { class: 'pjv-trow-subs' });
    subBox.hidden = true;
    if (subs.length && depth < 4) {
        for (const s of subs)
            subBox.append(pjvTaskRow(projectId, s, members, reload, depth + 1, fields));
        const toggle = () => {
            open = !open;
            caret.textContent = open ? '▾' : '▸';
            caret.setAttribute('aria-expanded', open ? 'true' : 'false');
            subBox.hidden = !open;
        };
        caret.onclick = toggle;
        if (subcountEl) {
            subcountEl.onclick = (e) => { e.stopPropagation(); toggle(); };
            subcountEl.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                toggle();
            } };
        }
        // 펼침 모드 — 모든 하위를 처음부터 펼쳐 보여준다(개별 caret 으로 다시 접을 수 있음).
        if (pjvSubtaskMode.mode === 'expanded') {
            open = true;
            subBox.hidden = false;
            caret.textContent = '▾';
            caret.setAttribute('aria-expanded', 'true');
        }
    }
    // ⋯메뉴 '하위 태스크 추가'(상위 depth 0 만) → 부모 아래 인라인 입력행 펼치고 포커스. 모달/박스 없음.
    let subAddRow = null;
    const startAddSub = () => {
        subBox.hidden = false;
        open = true;
        if (caret.tagName === 'BUTTON') {
            caret.textContent = '▾';
            caret.setAttribute('aria-expanded', 'true');
        }
        if (!subAddRow) {
            const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '하위 태스크 이름 입력 후 Enter (Esc 취소)', maxlength: '200' });
            const tcell = el('div', { class: 'pjv-trow-title-cell' }, input);
            tcell.style.paddingLeft = ((depth + 1) * 22) + 'px';
            subAddRow = el('div', { class: 'pjv-addrow editing pjv-subaddrow' }, tcell, el('div', { class: 'pjv-tcell' }), el('div', { class: 'pjv-tcell' }), el('div', { class: 'pjv-tcell' }), ...fields.map(() => el('div', { class: 'pjv-tcell' })), el('div', { class: 'pjv-tcell pjv-tcell-add' }));
            subAddRow.style.gridTemplateColumns = pjvGridTemplate(fields);
            let busy = false;
            const remove = () => { if (subAddRow) {
                subAddRow.remove();
                subAddRow = null;
            } };
            const commit = async () => {
                if (busy)
                    return;
                const name = input.value.trim();
                if (!name) {
                    remove();
                    return;
                }
                busy = true;
                input.disabled = true;
                try {
                    await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name, parent_task_id: t.id }) });
                    pjvReloadKeepScroll(reload); // 하위 태스크 추가 후 스크롤 보존(#459)
                }
                catch (err) {
                    toast('하위 추가 실패 — ' + err.message, true);
                    input.disabled = false;
                    busy = false;
                }
            };
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    input.value = '';
                    remove();
                }
                else if (e.key === 'Enter') {
                    e.preventDefault();
                    commit();
                }
            });
            subBox.append(subAddRow);
        }
        const inp = subAddRow.querySelector('input');
        if (inp)
            inp.focus();
    };
    const moreBtn = pjvRowMore(projectId, t, depth, reload, (depth === 0 && t.level !== 'subtask') ? startAddSub : null);
    // 제목 우측 호버 아이콘 3개(클릭업식) — 하위 추가(상위만)·태그 편집·이름 변경. startAddSub 정의 후 붙인다.
    titleCell.append(pjvRowActions([
        (t.level !== 'subtask') ? { title: '하위 태스크 추가', icon: 'add', fn: () => startAddSub() } : null,
        { title: '태그 편집', icon: 'tag', fn: (b) => pjvTagPopover(b, t, reload) },
        { title: '이름 변경', icon: 'rename', fn: (b) => pjvRenameTask(b, t, reload) },
    ]));
    const rowEl = el('div', { class: 'pjv-trow' }, titleCell, el('div', { class: 'pjv-tcell' }, pjvAssigneeControl(t, members, (p) => pjvSaveTask(t.id, p))), el('div', { class: 'pjv-tcell' }, pjvDueControl(t, (p) => pjvPatchTask(t.id, p, reload))), el('div', { class: 'pjv-tcell' }, pjvPriorityControl(t, (p) => pjvPatchTask(t.id, p, reload))), ...fields.map((f) => el('div', { class: 'pjv-tcell pjv-fcell' }, pjvFieldControl(t, f, reload))), el('div', { class: 'pjv-tcell pjv-tcell-add' }, moreBtn));
    rowEl.style.gridTemplateColumns = pjvGridTemplate(fields);
    wrap.append(rowEl);
    wrap.append(subBox);
    return wrap;
}
// ── 태스크 행 제목 클릭 → 상세 모달 배선(몽키패치) ──
//  동시 리팩터되는 pjvTaskRow 를 인플레이스 편집하지 않고 감싼다(append-only, 그쪽 작업 무손상).
//  pjvTaskRow(projectId, t, members, reload, depth, fields[, …]) 의 인자 위치만 의존(t=1, reload=3) — 가변인자 보존.
(function () {
    if (typeof pjvTaskRow !== 'function' || pjvTaskRow.__tmWrapped)
        return;
    const _origPjvTaskRow = pjvTaskRow;
    // @ts-ignore 의도적 몽키패치 — function 선언을 런타임에서 재할당(JS 합법·동작 보존). TS 만 막아서 무시.
    pjvTaskRow = function (...args) {
        const node = _origPjvTaskRow.apply(this, args);
        try {
            const t = args[1], reload = args[3];
            const titleEl = node && node.querySelector ? node.querySelector('.pjv-trow-title') : null;
            if (titleEl && t && t.id != null && !titleEl.dataset.tmWired) {
                titleEl.dataset.tmWired = '1';
                titleEl.classList.add('clickable');
                titleEl.title = '상세 열기';
                titleEl.addEventListener('click', function (e) { e.stopPropagation(); pjvOpenTaskModal(t.id, reload); });
            }
        }
        catch (_) { /* 구조 달라도 무해 */ }
        return node;
    };
    pjvTaskRow.__tmWrapped = true;
})();
// ── 태스크 제목: 클릭=상세 모달 / 더블클릭=하위 태스크 추가(클릭업식). 위 모달 배선과 공존하도록 감싼다(append-only). ──
//  같은 click 을 행의 캡처 단계에서 가로채 단일/더블 구분 — 위 래퍼의 제목 click(모달)을 stopImmediatePropagation 으로
//  눌러두고: 1회=240ms 뒤 모달, 2회=하위 태스크 인라인 추가. depth 0(태스크)만. 셀/컨트롤 클릭은 그대로 통과.
(function () {
    if (typeof pjvTaskRow !== 'function' || pjvTaskRow.__cfDblWrapped)
        return;
    const _inner = pjvTaskRow;
    // @ts-ignore 의도적 몽키패치 — function 선언을 런타임에서 재할당(JS 합법·동작 보존). TS 만 막아서 무시.
    pjvTaskRow = function (...args) {
        const node = _inner.apply(this, args);
        try {
            const projectId = args[0], t = args[1], reload = args[3], depth = args[4] || 0;
            if (depth === 0 && node && node.querySelector) {
                const rowEl = node.querySelector('.pjv-trow');
                const titleEl = node.querySelector('.pjv-trow-title');
                const subBox = node.querySelector('.pjv-trow-subs');
                if (rowEl && titleEl && subBox && t && t.id != null && !rowEl.dataset.cfDbl) {
                    rowEl.dataset.cfDbl = '1';
                    titleEl.title = '클릭: 상세 열기 · 더블클릭: 하위 태스크 추가';
                    let clicks = 0, timer = null;
                    rowEl.addEventListener('click', function (e) {
                        // 제목 셀 전체(여백 포함)를 클릭 타깃으로 — 단, 캐럿·상태점은 각자 동작하도록 통과시킨다. 다른 컬럼 셀도 통과.
                        if (!e.target.closest('.pjv-trow-title-cell'))
                            return;
                        if (e.target.closest('.pjv-trow-caret') || e.target.closest('.pjv-status-dot') || e.target.closest('.pjv-status-btn') || e.target.closest('.pjv-subcount-ico'))
                            return; // 하위 태스크 아이콘 클릭은 펼침(모달/더블클릭 가로채기 제외)
                        if (e.target.closest('.pjv-row-check') || e.target.closest('.pjv-row-actions'))
                            return; // 다중선택 체크박스·호버 액션은 각자 동작(모달 가로채지 않음)
                        e.stopImmediatePropagation();
                        e.preventDefault();
                        clicks++;
                        if (clicks === 1) {
                            timer = setTimeout(function () { clicks = 0; if (typeof pjvOpenTaskModal === 'function')
                                pjvOpenTaskModal(t.id, reload); }, 240);
                        }
                        else {
                            clearTimeout(timer);
                            clicks = 0;
                            subBox.hidden = false;
                            const car = rowEl.querySelector('.pjv-trow-caret');
                            if (car && car.tagName === 'BUTTON') {
                                car.textContent = '▾';
                                car.setAttribute('aria-expanded', 'true');
                            }
                            pjvShowInlineSubtask(projectId, t, subBox, reload);
                        }
                    }, true); // 캡처 — 제목 자체 click(모달) 리스너보다 먼저
                }
            }
        }
        catch (_) { /* 구조 달라도 무해 */ }
        return node;
    };
    pjvTaskRow.__cfDblWrapped = true;
})();
// pjvTaskRow 는 위 IIFE 2개가 교체한 **현재 값**이 나간다 — 배럴(detail.ts→projects.ts)도 `export … from` 재수출로 받는다(값 복사 금지).
export { pjvTaskRow, pjvTasksSection };
export { pjvAddTask, pjvRowMore } from './detail-task-actions.js';
