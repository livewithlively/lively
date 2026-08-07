// projects/project-form.ts — #1313 R34: web/projects.ts 분해 ⑤.
//  **새 프로젝트(v2) 생성 폼** 한 덩어리 — 인메모리 할 일 트리 에디터(npTaskEditor) + 폼 본체(openProjectV2Form) +
//   폼이 쓰는 피커들(레포 멀티선택 · 리스트 선택 · 지식 연결). 생성 전이라 API 없이 메모리에만 담고 '만들기'에서 한 번에 만든다.
//  ※ 레포 피커는 프로젝트 설정 모달이, 지식 피커는 상세의 필요/산출 지식 섹션이 함께 쓴다(배럴 재수출).
//  ※ 실행 기본값(pjvRunDefaults·pjvBulkRunDefaultsModal)은 R33 이 projects/selection.ts 로, 컨테이너 비교자
//   (pjvContainerCmp)는 projects/rows.ts 로 가져갔다 — 배럴(../projects.js)을 거치지 않고 **직결**로 받는다.
import { api, appUrl, el, toast } from '../core.js';
import { overlayBox } from '../learn.js';
import { memberPicker } from './files.js';
import { pjvSubtaskIcon } from './icons.js';
import { openListForm } from './list-forms.js';
import { compactPicker } from './popover.js';
import { pjvContainerCmp } from './rows.js';
import { pjvBulkRunDefaultsModal, pjvRunDefaults } from './selection.js';
import { pjvStatusIconStd } from './status.js';

// 할 일(선택) — 프로젝트 안의 하위태스크 리스트 UI를 가볍게 옮긴 인메모리 트리 에디터(생성 전이라 API 없이 메모리에만 담고, '만들기' 때 한 번에 생성).
//  클릭업식 결: 상태점(할 일 점선 링) + 이름, [＋하위]로 한 단계 중첩, ×로 삭제. ＋할 일 추가행은 Enter=추가·계속, Esc/빈칸=닫기.
//  가볍게 — 이름만(담당·마감·우선순위는 만든 뒤 프로젝트 안에서). getTasks() → [{ name, subs: [name…] }] (입력 순서 보존).
function npTaskEditor() {
  const model: any[] = [];                                   // [{ name, subs: [{name}], subBox }]
  const listEl = el('div', { class: 'np-tasklist' });
  const dot = () => pjvStatusIconStd('todo'); // 할 일 점선 링 — 프로젝트 행과 동일 톤

  // 자동 성장 입력 — 한 줄 넘으면 세로로 늘어난다(#req: 하위태스크가 여러 줄이면 할일 목록 세로 확장). 이름 전용이라 Enter=확정(줄바꿈 X).
  const growTa = (ta) => { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight || 0) + 'px'; };
  const mkGrowInput = (ph) => {
    // 글자수 제한 없음(#607) — 태스크/하위태스크 이름을 길게 적어도 잘리지 않게(서버도 태스크명 길이 제한 없음). 자동성장 textarea 라 길면 세로로 늘어난다.
    const ta = el('textarea', { class: 'pjv-addrow-input np-grow-input', rows: '1', placeholder: ph || '', spellcheck: 'false' });
    ta.addEventListener('input', () => growTa(ta));
    return ta;
  };

  // 제목 인라인 편집(#507) — 제목을 클릭·더블클릭하면 자동성장 textarea 로 교체해 수정. Enter/blur=저장, Esc=취소.
  //  한글(IME) 조합 중 Enter 는 조합 확정용이라 무시(#293 패턴). Esc/Enter 는 오버레이(문서 Esc=팝업 닫기)로 새지 않게 stopPropagation. 인메모리라 값만 갱신.
  const editTitle = (titleEl, get, set) => {
    if (titleEl.dataset.npEditing) return;
    titleEl.dataset.npEditing = '1';
    const ta = mkGrowInput('');
    ta.value = get();
    titleEl.replaceWith(ta);
    growTa(ta); ta.focus(); if (ta.select) ta.select();
    let fin = false;
    const finish = (save) => {
      if (fin) return; fin = true;
      const nv = ta.value.trim().replace(/\s+/g, ' ');
      if (save && nv) { set(nv); titleEl.textContent = nv; }
      ta.replaceWith(titleEl);
      delete titleEl.dataset.npEditing;
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && (e as any).keyCode !== 229) { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    ta.addEventListener('blur', () => finish(true));
  };
  const bindEditable = (titleEl, get, set) => {
    titleEl.classList.add('np-title-editable');
    titleEl.title = '클릭·더블클릭해 수정';
    const go = (e) => { e.stopPropagation(); editTitle(titleEl, get, set); };
    titleEl.addEventListener('click', go);
    titleEl.addEventListener('dblclick', go);
  };

  const buildSubRow = (task, sub) => {
    const del = el('button', { class: 'np-trow-del', type: 'button', title: '삭제', 'aria-label': '삭제', text: '×' });
    const titleEl = el('span', { class: 'np-trow-title', text: sub.name });
    bindEditable(titleEl, () => sub.name, (v) => { sub.name = v; });
    const row = el('div', { class: 'np-trow np-trow-sub' }, dot(), titleEl, del);
    del.onclick = () => { const i = task.subs.indexOf(sub); if (i >= 0) task.subs.splice(i, 1); row.remove(); };
    return row;
  };

  // 하위 인라인 추가 입력 — Enter=추가(입력 유지→연속), Esc/빈 blur=제거. (pjvShowInlineSubtask 의 인메모리판)
  const showSubInput = (task) => {
    const existing = task.subBox.querySelector('.np-subadd');
    if (existing) { existing.querySelector('textarea, input').focus(); return; }
    const input = mkGrowInput('하위 태스크 이름 후 Enter (Esc 취소)');
    const addRow = el('div', { class: 'np-trow np-trow-sub np-subadd' }, dot(), input);
    task.subBox.append(addRow);
    setTimeout(() => { input.focus(); growTa(input); }, 0);
    input.addEventListener('blur', () => setTimeout(() => { if (!input.value.trim()) addRow.remove(); }, 130));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); input.value = ''; addRow.remove(); return; }  // 팝업까지 닫히지 않게(문서 Esc 차단)
      if (e.key !== 'Enter') return;
      if (e.isComposing || (e as any).keyCode === 229) return;  // 한글 IME 조합 확정용 Enter — 중복 생성 방지(#505)
      e.preventDefault(); e.stopPropagation();
      const name = input.value.trim(); if (!name) return;
      const sub = { name }; task.subs.push(sub);
      task.subBox.insertBefore(buildSubRow(task, sub), addRow);  // 입력행 위에 쌓아 입력 유지(연속 입력)
      input.value = ''; growTa(input); input.focus();
    });
  };

  const buildTaskRow = (task) => {
    const addSub = el('button', { class: 'np-trow-act', type: 'button', title: '하위 태스크 추가' }, pjvSubtaskIcon(), el('span', { text: '하위' }));
    const del = el('button', { class: 'np-trow-del', type: 'button', title: '삭제', 'aria-label': '삭제', text: '×' });
    const subBox = el('div', { class: 'np-trow-subs' });
    task.subBox = subBox;
    const titleEl = el('span', { class: 'np-trow-title', text: task.name });
    bindEditable(titleEl, () => task.name, (v) => { task.name = v; });
    const wrap = el('div', { class: 'np-trow-wrap' },
      el('div', { class: 'np-trow np-trow-top' },
        el('div', { class: 'np-trow-title-cell' }, dot(), titleEl),
        el('div', { class: 'np-trow-acts' }, addSub, del)),
      subBox);
    addSub.onclick = () => showSubInput(task);
    del.onclick = () => { const i = model.indexOf(task); if (i >= 0) model.splice(i, 1); wrap.remove(); };
    return wrap;
  };

  // 상위 ＋할 일 추가행 — 트리거(＋ 할 일 추가) ↔ 입력 토글. Enter=추가·계속, Esc/빈 blur=닫기. (pjvProjAddRow 의 인메모리·이름전용판)
  //  Tab(#663) = 바로 위(마지막) 태스크의 '하위'로 들여쓰기(클릭업식), Shift+Tab = 해제. 들여쓴 채 Enter 연타로 하위 연속 추가.
  const trigger = el('button', { class: 'np-add-trigger', type: 'button' }, el('span', { class: 'pjv-addrow-plus', text: '＋' }), el('span', { text: '태스크 추가' }));
  const addInput = mkGrowInput('태스크 이름 후 Enter (여러 개면 계속, Tab 하위로, Esc 닫기)');
  const addRow = el('div', { class: 'np-addrow' }, trigger);
  let indentTask: any = null; // Tab 들여쓰기 대상(바로 위 태스크). null=상위 태스크로 추가.
  const applyIndent = () => {
    addRow.style.paddingLeft = indentTask ? '22px' : '';
    addInput.placeholder = indentTask
      ? ('“' + (indentTask.name || '위 태스크') + '” 의 하위 — 이름 입력 후 Enter (Shift+Tab 해제)')
      : '태스크 이름 후 Enter (여러 개면 계속, Tab 하위로, Esc 닫기)';
    addInput.focus();
  };
  const collapse = () => { addRow.classList.remove('editing'); indentTask = null; addRow.style.paddingLeft = ''; addRow.replaceChildren(trigger); };
  const expand = () => { addRow.classList.add('editing'); addRow.replaceChildren(dot(), addInput); setTimeout(() => { addInput.focus(); growTa(addInput); }, 0); };
  trigger.onclick = expand;
  addInput.addEventListener('blur', () => setTimeout(() => { if (!addInput.value.trim() && !addRow.contains(document.activeElement)) collapse(); }, 130));
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); addInput.value = ''; collapse(); return; }  // 팝업까지 닫히지 않게(문서 Esc 차단)
    if (e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey) { if (indentTask) { indentTask = null; applyIndent(); } return; }
      if (!indentTask && model.length) { indentTask = model[model.length - 1]; applyIndent(); } // 위에 태스크가 없으면 무시
      return;
    }
    if (e.key !== 'Enter') return;
    if (e.isComposing || (e as any).keyCode === 229) return;  // 한글 IME 조합 확정용 Enter — 중복 생성 방지(#505)
    e.preventDefault(); e.stopPropagation();
    const name = addInput.value.trim(); if (!name) return;
    if (indentTask && model.indexOf(indentTask) < 0) { indentTask = null; applyIndent(); } // 대상이 삭제됐으면 상위로 복귀
    if (indentTask) {
      // 들여쓴 상태 — 위 태스크의 하위로(인메모리). 하위 인라인 입력(np-subadd)이 열려 있으면 그 위에 쌓는다(showSubInput 동형).
      const sub = { name }; indentTask.subs.push(sub);
      const subAdd = indentTask.subBox && indentTask.subBox.querySelector('.np-subadd');
      if (subAdd) indentTask.subBox.insertBefore(buildSubRow(indentTask, sub), subAdd);
      else if (indentTask.subBox) indentTask.subBox.append(buildSubRow(indentTask, sub));
    } else {
      const task = { name, subs: [] }; model.push(task);
      listEl.append(buildTaskRow(task));
    }
    addInput.value = ''; growTa(addInput); addInput.focus();
  });

  const box = el('div', { class: 'np-tasks-tree' }, listEl, addRow);
  // 입력칸에 Enter 안 하고 남겨둔 텍스트도 커밋(#req 버그수정) — 안 그러면 마지막에 친 태스크가 저장 안 되고 사라짐(증발).
  const flushPending = () => {
    const name = (addInput.value || '').trim(); if (!name) return;
    if (indentTask && model.indexOf(indentTask) >= 0) indentTask.subs.push({ name });
    else model.push({ name, subs: [] });
    addInput.value = '';
  };
  return { box, getTasks: () => { flushPending(); return model.map((t) => ({ name: t.name, subs: t.subs.map((s) => s.name) })); } };
}

// 새 프로젝트(v2) 폼 — 이름·설명·할 일(히어로) + 컴팩트 메타(폴더·카테고리·레포·팀원). 생성 후 상세로 이동.
export function openProjectV2Form(reload, prefill?: any) {
  prefill = prefill || {};
  const nameIn = el('input', { type: 'text', class: 'np-name', value: prefill.name || '', placeholder: '프로젝트 이름 (예: 6월 데모데이 준비)', maxlength: '200' });
  const descIn = el('textarea', { class: 'np-desc', placeholder: '이 프로젝트로 무엇을, 왜 하려는지 적어주세요.\n여기 적은 설명은 나중에 AI 세션이 맥락으로 씁니다 — 길게 써도 좋아요.', maxlength: '5000' });
  if (prefill.description) descIn.value = prefill.description;
  const growDesc = () => { descIn.style.height = 'auto'; descIn.style.height = Math.min(Math.max(descIn.scrollHeight, 132), Math.round((window.innerHeight || 800) * 0.5)) + 'px'; };
  descIn.addEventListener('input', growDesc);
  const listPick = listPicker(prefill.listId);  // 분류(리스트) — 한 목록/상태 뷰에서 만들 때도 여기서 정해 미분류 방지(#337). 카테고리는 이 리스트에서 상속(#541 후속).
  const repoField = compactPicker('관련 레포', (onChange) => repoPicker(prefill.repos || [], { defaultOne: true, onChange }), { emptyText: '선택 안 함' });
  const memberField = compactPicker('팀원', (onChange) => memberPicker(prefill.memberIds || [], { includeMe: true, onChange }), { emptyText: '나만 참여', avatars: true, maxChips: 6 });
  // 선행 프로젝트에서 이어받는 '연결된 지식'(#519/C) — 후속 프로젝트를 인라인 생성할 때 선행의 연결 지식을 프리필로 보여주고
  //  만들 때 새 프로젝트에 required 로 연결한다. 칩 ×로 뺄 수 있음(원치 않으면 제외). 이름(name) 기준 중복 제거.
  const inheritKn: any[] = [];
  { const seen = new Set(); for (const k of (prefill.knowledge || [])) { const nm = k && (k.name || k.knowledge_name); if (nm && !seen.has(nm)) { seen.add(nm); inheritKn.push({ name: nm, title: k.title || nm }); } } }
  let knRow: any = null;
  if (inheritKn.length) {
    const chips = el('div', { class: 'np-inherit-chips' });
    const paintKn = () => {
      chips.replaceChildren(...inheritKn.map((k) => {
        const chip = el('span', { class: 'np-inherit-chip' }, el('span', { class: 'np-inherit-chip-name', text: k.title }));
        const x = el('button', { class: 'np-inherit-chip-x', type: 'button', title: '이어받지 않기', text: '✕' });
        x.onclick = () => { const i = inheritKn.indexOf(k); if (i >= 0) inheritKn.splice(i, 1); paintKn(); if (!inheritKn.length && knRow) knRow.remove(); };
        chip.append(x); return chip;
      }));
    };
    paintKn();
    knRow = el('div', { class: 'cf-row np-inherit-row' }, el('span', { class: 'cf-label', text: '이어받는 지식' }), chips);
  }
  // 태스크(선택) — 설명 바로 아래, 프로젝트 안 하위태스크 리스트를 옮긴 인메모리 트리 에디터. '만들기' 때 태스크(+하위)로 생성.
  const taskEd = npTaskEditor();
  const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기', 'data-tour': 'pd-create-btn' });   // #853 '프로젝트 체험' 투어 앵커
  // #758 만들고 바로 이 프로젝트에 내 AI 세션 열기 + 그 세션 실행 기본값 편집(기본값 = pjvBulkRunDefaultsModal 의 __new__ 전역 스코프).
  const runBtn = el('button', { class: 'btn btn-primary np-run', text: '만들고 AI세션 실행', title: '프로젝트를 만들고 바로 이 프로젝트에 내 AI 세션을 열어 새 탭으로 입장' });
  const defaultsBtn = el('button', { class: 'btn btn-ghost np-run-cfg', type: 'button', text: '기본값', title: 'AI세션 실행 기본값 — 실행기·모델·자동승인·워크트리 등' });
  defaultsBtn.onclick = () => pjvBulkRunDefaultsModal({ projectId: '__new__' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('새 프로젝트',
    el('div', { class: 'np-form' },
      el('div', { class: 'np-hero' },
        el('label', { class: 'np-hero-lbl', text: '이름' }), nameIn,
        el('label', { class: 'np-hero-lbl', style: 'margin-top:14px', text: '설명' }), descIn,
        // 태스크(선택) — 설명 바로 아래에 얹되 '선택'임을 라벨 배지 + 안내로 분명히. 각 태스크 아래로 하위 태스크까지 넣을 수 있음.
        el('label', { class: 'np-hero-lbl np-hero-lbl-opt', style: 'margin-top:16px' }, el('span', { text: '태스크' }), el('span', { class: 'np-opt', text: '선택' })),
        el('div', { class: 'np-tasks-hint', text: '지금 떠오르는 태스크가 있으면 여기에 적어두세요 — 각 태스크 아래로 하위 태스크까지 넣을 수 있어요. 비워둬도 되고, 나중에 프로젝트 안에서 얼마든지 추가·정리할 수 있어요.' }),
        taskEd.box),
      el('div', { class: 'np-meta' },
        el('div', { class: 'cf-row' }, el('span', { class: 'cf-label', text: '리스트' }), listPick.box),
        el('div', { class: 'np-meta-cap', text: '카테고리는 소속 리스트에서 물려받아요. 레포·팀원은 비워둬도 되고 나중에 언제든 바꿀 수 있어요.' }),
        repoField.row, memberField.row, knRow)),
    el('div', { class: 'ov-actions' }, saveBtn, runBtn, defaultsBtn, cancelBtn));
  setTimeout(() => { nameIn.focus(); nameIn.select(); growDesc(); }, 0); // 프리필된 이름 전체 선택 + 설명 높이 초기화
  const go = async (withRun?) => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    // 분류(영역) — 영역이 있는데 미선택이면 막는다(미분류는 '기타(미분류)'를 명시적으로 골라야 함, #337).
    await listPick.ready;
    const listChoice = listPick.getSelected();
    if (!listChoice.ok) { toast('리스트를 선택하세요 — 프로젝트는 반드시 리스트에 들어갑니다', true); return; }
    saveBtn.disabled = true; runBtn.disabled = true;
    try {
      const r = await api('/api/ui/v6/projects', { method: 'POST', body: JSON.stringify({
        name, description: descIn.value.trim() || undefined, members: memberField.getSelected(),
      }) });
      const np = r && (r.project || r);
      // 인라인 그룹에서 연 경우 그 상태로 생성(기본 생성은 active=진행 중). 커스텀 상태면 status_raw 도 함께(#475).
      if (np && np.id && (prefill.status_raw || (prefill.status && prefill.status !== 'active'))) {
        await api('/api/ui/v6/projects/' + np.id + '/status', { method: 'POST', body: JSON.stringify({ status: prefill.status || 'in_progress', status_raw: prefill.status_raw ?? null }) }).catch(() => {});
      }
      // 인라인 추가행에서 지정해 둔 마감·우선순위 드래프트가 있으면 생성 직후 반영.
      if (np && np.id) {
        const patch: any = {};
        if (prefill.due_date) patch.due_date = prefill.due_date;
        if (prefill.priority) patch.priority = prefill.priority;
        if (Object.keys(patch).length) await api('/api/ui/v6/projects/' + np.id, { method: 'POST', body: JSON.stringify(patch) }).catch(() => {});
      }
      // 관련 레포를 생성 직후 연결. (카테고리는 소속 리스트에서 상속 — 프로젝트 단위 지정 폐지 #541 후속.)
      const repoNames = repoField.getSelected();
      if (np && np.id && repoNames.length) await api('/api/ui/v6/projects/' + np.id + '/repos', { method: 'POST', body: JSON.stringify({ repos: repoNames }) }).catch(() => {});
      // 모달의 분류(영역) 선택대로 소속 지정 — '기타(미분류)'면 listId=null 이라 호출 생략(기본이 미분류).
      if (np && np.id && listChoice.listId != null) await api('/api/ui/v6/projects/' + np.id + '/list', { method: 'POST', body: JSON.stringify({ list_id: listChoice.listId }) }).catch(() => {});
      // 할 일(선택) — 드래프트 트리를 순서대로 태스크로 생성: 상위 먼저(순차·순서 보존) → 그 하위를 parent_task_id 로. 실패는 조용히 건너뜀(프로젝트는 이미 생성됨).
      const draftTasks = taskEd.getTasks();
      let taskFail = 0; // #req 조용히 삼키지 말고 실패 개수 집계 → 사용자에게 알림.
      if (np && np.id && draftTasks.length) {
        for (const dt of draftTasks) {
          let parentId = null;
          try { const tr = await api('/api/ui/v6/projects/' + np.id + '/tasks', { method: 'POST', body: JSON.stringify({ name: dt.name }) }); parentId = tr && tr.task && tr.task.id; }
          catch (_) { taskFail++; } // 상위 생성 실패 시 그 하위도 건너뜀
          if (parentId && dt.subs.length) {
            for (const sn of dt.subs) await api('/api/ui/v6/projects/' + np.id + '/tasks', { method: 'POST', body: JSON.stringify({ name: sn, parent_task_id: parentId }) }).catch(() => { taskFail++; });
          }
        }
        if (taskFail) toast(taskFail + '개 태스크 저장 실패 — 프로젝트 안에서 다시 추가해 주세요', true);
      }
      // 선행/후속 엣지(#519) — 후속 피커에서 인라인 생성한 경우 현재 프로젝트와 연결. edgeDir='in'=새 프로젝트가 edgeWith 의 후속(new→follow_up→edgeWith),
      //  'out'=새 프로젝트가 edgeWith 의 선행(edgeWith→follow_up→new). (from --follow_up--> to = from 이 to 의 후속, #340.)
      if (np && np.id && prefill.edgeWith) {
        const fromId = prefill.edgeDir === 'out' ? prefill.edgeWith : np.id;
        const toId = prefill.edgeDir === 'out' ? np.id : prefill.edgeWith;
        await api('/api/ui/v6/projects/' + fromId + '/link', { method: 'POST', body: JSON.stringify({ to: toId, relation: 'follow_up' }) }).catch(() => {});
      }
      // 선행에서 이어받는 연결 지식(#519/C) — 남긴 것만 required 로 연결.
      if (np && np.id && inheritKn.length) {
        for (const k of inheritKn) await api('/api/ui/v6/projects/' + np.id + '/knowledge', { method: 'POST', body: JSON.stringify({ name: k.name, relation: 'required' }) }).catch(() => {});
      }
      try { localStorage.setItem('lively.newproj.recentRepos', JSON.stringify(repoNames)); } catch (_) { /* */ }
      // #758 '만들고 AI세션 실행' — 생성 직후 이 프로젝트에 내 세션을 열고 새 탭으로 입장. 실행 기본값은 pjvBulkRunDefaultsModal(__new__ 전역).
      if (withRun && np && np.id) {
        const rd = pjvRunDefaults('__new__', []);
        const sbody: any = { label: name, harness: rd.harness || 'claude', autoApprove: rd.autoApprove === true };   // #782 기본 꺼짐
        if (rd.model) sbody.flags = { '--model': rd.model };
        let sid = '';
        try { const sr = await api('/api/ui/v6/projects/' + np.id + '/sessions', { method: 'POST', body: JSON.stringify(sbody) }); sid = (sr && sr.session && sr.session.id) || ''; }
        catch (e) { toast('프로젝트는 만들었지만 세션 실행 실패 — ' + (e.message || e), true); }
        back.remove();
        if (reload) reload();
        toast(sid ? '프로젝트 생성 · AI세션을 새 탭에서 열었어요' : '프로젝트를 만들었어요');
        if (sid) window.open(appUrl('/ui/terminal.html?session=') + encodeURIComponent(sid) + '&label=' + encodeURIComponent(name), '_blank');
        return;
      }
      back.remove();
      toast('프로젝트를 만들었습니다');
      // stay(#670) — 대시보드처럼 '목록 흐름 유지'가 필요한 호출측은 상세로 튀지 않고 그 자리 목록만 갱신(새 프로젝트가 목록 맨 아래에 자연스럽게).
      if (prefill.stay) { if (reload) reload(); }
      else if (np && np.id) location.hash = '#/projects2/p/' + np.id;
      else if (reload) reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; runBtn.disabled = false; }
  };
  saveBtn.onclick = () => go(false);
  runBtn.onclick = () => go(true);
  // 한글(IME) 조합 중 Enter 는 조합 확정용 — 조합 끝난 진짜 Enter 에서만 생성(#505 중복 방지).
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && (e as any).keyCode !== 229) go(false); });
  return back; // 호출측(인라인 추가행)이 팝업 닫힘을 감지해 인라인 행을 정리할 수 있게 오버레이 엘리먼트 반환
}

// ── 레포 멀티선택 피커 — 레포 레지스트리(관리탭 ▸ 레포 관리)의 비폐기 레포 체크박스. 비동기 로드. ──
//  생성 모달에서 사용(이름만 매핑 — 경로는 각 PC 의 .lively/project.json). selectedNames 는 미리 체크할 레포 이름.
//  opts.onChange: 선택 변할 때(로드 완료 포함) 호출 · opts.defaultOne: 미리 선택된 게 없으면 하나 자동 선택(최근 사용 → 없으면 첫 레포).
//  반환 { box, getSelected(), getSelectedLabels() }.
function repoPicker(selectedNames, opts?) {
  opts = opts || {};
  const sel = new Set(selectedNames || []);
  const fire = () => { try { opts.onChange && opts.onChange(); } catch (_) { /* */ } };
  const box = el('div', { class: 'cp-box' }, el('div', { class: 'cp-list' }, el('div', { class: 'admin-hint', text: '불러오는 중…' })));
  const checks: any[] = [];  // [{name, input}]
  (async () => {
    let names: any[] = [];
    try { const r = await api('/api/ui/repos'); names = ((r && r.domainmapRepos) || []).filter((it) => it && it.name && !it.deprecated).map((it) => it.name); } catch (_) { /* */ }
    for (const n of sel) if (!names.includes(n)) names.push(n);  // 저장됐지만 목록에 없는 것도 노출
    names.sort();
    if (!names.length) { box.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '등록된 레포가 없어요. 관리탭 ▸ 레포(git) 관리에서 먼저 추가하세요.' })); fire(); return; }
    // 디폴트 하나 선택 — 미리 선택된 게 없을 때만. 최근 사용 레포(있으면) → 없으면 첫 레포.
    if (opts.defaultOne && !sel.size) {
      let recents: any[] = [];
      try { recents = JSON.parse(localStorage.getItem('lively.newproj.recentRepos') || '[]'); } catch (_) { /* */ }
      const pick = (recents || []).find((n) => names.includes(n)) || names[0];
      if (pick) sel.add(pick);
    }
    box.replaceChildren(el('div', { class: 'cp-list' }, ...names.map((n) => {
      const cb = el('input', { type: 'checkbox' }); if (sel.has(n)) cb.checked = true;
      cb.addEventListener('change', () => { if (cb.checked) sel.add(n); else sel.delete(n); fire(); });
      checks.push({ name: n, input: cb });
      return el('label', { class: 'cp-item' }, cb, el('span', { text: n, title: n }));
    })));
    fire();
  })();
  return {
    box,
    getSelected: () => checks.filter((c) => c.input.checked).map((c) => c.name),
    getSelectedLabels: () => checks.filter((c) => c.input.checked).map((c) => ({ key: c.name, label: c.name })),
  };
}

// ── 분류(영역) 단일선택 피커 — 새 프로젝트 모달용. 영역(=project-list) 목록을 그 자리에서 fetch. ──
//  '한 목록'·'상태' 뷰처럼 영역 맥락이 없는 곳에서 만들 때도 모달에서 영역을 정하게 해 미분류 프로젝트가 무심코 생기지 않게 한다(#337).
//  반환 { box, ready, getSelected() }. getSelected → { ok, listId }:
//   ok=false → 영역이 있는데 아직 미선택(검증에서 막음) · listId=null → 명시적 '기타(미분류)' · 그 외 → 선택한 영역 id.
//  selectedListId 가 주어지면(특정 영역 추가행에서 연 경우) 그 영역을 미리 선택 — 기존 동작 유지.
function listPicker(selectedListId) {
  // #1098 — 20개 넘는 리스트가 평면 <select> 로 쏟아져 원하는 걸 못 찾았다(상민님).
  //  AI 세션 탭의 프로젝트 피커와 **같은 방식**으로 바꾼다: 검색 + 폴더 트리(접힌 가지는 눌러서 들어감).
  //  클래스도 거기 것(tsess-projfilter-*/tsess-tree-*)을 그대로 쓴다 — 새 CSS 를 만들면 두 화면이 갈라진다(#1062 관례).
  let loaded: any[] = [];      // 로드된 리스트(하나도 없으면 미분류 허용 — 첫 프로젝트 부트스트랩)
  let folders: any[] = [];
  let picked: number | null = selectedListId != null ? Number(selectedListId) : null;
  const expanded = new Set<string>();

  const box = el('div', { class: 'pjv-listpick tsess-projfilter' });
  const btn = el('button', { type: 'button', class: 'tsess-projfilter-btn', 'aria-haspopup': 'true', title: '리스트 고르기' },
    el('span', { class: 'pjv-listpick-label', text: '불러오는 중…' }), el('span', { class: 'tsess-projfilter-chev', text: '▾' }));
  const dd = el('div', { class: 'tsess-projfilter-dd', hidden: true });
  const search = el('input', { type: 'search', class: 'tsess-projfilter-search', placeholder: '리스트 검색…' }) as HTMLInputElement;
  const listBox = el('div', { class: 'tsess-projfilter-list' });
  const foot = el('div', { class: 'tsess-projfilter-foot' });
  dd.append(search, listBox, foot);
  box.append(btn, dd);

  const nameOf = (id: number | null) => { const l = loaded.find((x) => Number(x.id) === Number(id)); return l ? l.name : ''; };
  const paintBtn = () => {
    const lab = btn.querySelector('.pjv-listpick-label') as HTMLElement;
    if (!loaded.length) { lab.textContent = '리스트 없음 — 미분류로 생성'; btn.classList.remove('active'); return; }
    lab.textContent = picked != null ? nameOf(picked) || ('리스트 #' + picked) : '리스트를 선택하세요…';
    btn.classList.toggle('active', picked != null);
  };

  let docHandler: any = null;
  const close = () => { dd.hidden = true; if (docHandler) { document.removeEventListener('mousedown', docHandler); docHandler = null; } };
  const open = () => {
    dd.hidden = false; search.value = ''; render(''); search.focus();
    docHandler = (e: any) => { if (!box.contains(e.target)) close(); };
    setTimeout(() => { if (!dd.hidden) document.addEventListener('mousedown', docHandler); }, 0);
  };
  btn.addEventListener('click', () => (dd.hidden ? open() : close()));
  search.addEventListener('input', () => render(search.value));

  // 폴더(중첩) › 리스트 트리. 리스트가 없는 폴더 가지는 통째로 감춘다(빈 서랍을 늘리지 않는다).
  type Node = { key: string; name: string; sort: number; children: Node[]; lists: any[]; count: number };
  const buildTree = () => {
    const byId = new Map<string, any>(folders.map((f) => [String(f.id), f]));
    const nodeOf = new Map<string, Node>();
    const roots: Node[] = [];
    const orphans: any[] = [];
    const ensure = (fid: any): Node | null => {
      const f = byId.get(String(fid));
      if (!f) return null;
      const k = 'f' + f.id;
      let n = nodeOf.get(k);
      if (n) return n;
      n = { key: k, name: f.name || '폴더', sort: Number(f.sort) || 0, children: [], lists: [], count: 0 };
      nodeOf.set(k, n);
      const parent = f.parent_id != null ? ensure(f.parent_id) : null;
      if (parent) parent.children.push(n); else roots.push(n);
      return n;
    };
    for (const l of loaded) {
      const n = l.folder_id != null ? ensure(l.folder_id) : null;
      if (n) n.lists.push(l); else orphans.push(l);
    }
    const cnt = (n: Node): number => { n.count = n.lists.length + n.children.reduce((a, c) => a + cnt(c), 0); return n.count; };
    for (const r of roots) cnt(r);
    const prune = (ns: Node[]): Node[] => ns.filter((n) => n.count > 0).map((n) => ({ ...n, children: prune(n.children) }));
    return { roots: prune(roots).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'ko')), orphans };
  };

  const listRow = (l: any, depth: number) => {
    const on = picked != null && Number(picked) === Number(l.id);
    return el('button', {
      class: 'tsess-projfilter-opt' + (on ? ' active' : ''), type: 'button', title: l.name,
      style: depth ? 'padding-left:' + (10 + depth * 13) + 'px' : '',
      onmousedown: (e: any) => { e.preventDefault(); picked = Number(l.id); paintBtn(); close(); },
    }, el('span', { class: 'tsess-opt-name', text: l.name }));
  };

  const render = (q: string) => {
    const ql = (q || '').trim().toLowerCase();
    const hit = (l: any) => !ql || String(l.name || '').toLowerCase().includes(ql);
    if (!loaded.length) {
      listBox.replaceChildren(el('div', { class: 'tsess-projfilter-none', text: '리스트가 아직 없어요 — 아래에서 만들 수 있어요(만들기 전에는 미분류로 생성됩니다).' }));
      return;
    }
    const { roots, orphans } = buildTree();
    const nodes: any[] = [];
    let shown = 0;
    const walk = (ns: Node[], depth: number) => {
      for (const n of ns) {
        const deep = (function c(x: Node): number { return x.lists.filter(hit).length + x.children.reduce((a, y) => a + c(y), 0); })(n);
        if (ql && !deep) continue;                      // 검색 중 매치 없는 가지는 숨긴다
        const isOpen = ql ? true : expanded.has(n.key);  // 검색 중엔 자동으로 펼친다
        nodes.push(el('button', {
          class: 'tsess-tree-node tsess-tree-folder' + (isOpen ? ' open' : ''), type: 'button',
          style: depth ? 'padding-left:' + (8 + depth * 13) + 'px' : '', 'aria-expanded': String(isOpen), title: '폴더: ' + n.name,
          onmousedown: (e: any) => {
            e.preventDefault(); e.stopPropagation();     // 가지를 여닫아도 팝오버는 닫지 않는다
            if (expanded.has(n.key)) expanded.delete(n.key); else expanded.add(n.key);
            render(search.value);
          },
        },
          el('span', { class: 'tsess-tree-caret', text: isOpen ? '▾' : '▸' }),
          el('span', { class: 'tsess-tree-name', text: n.name }),
          el('span', { class: 'tsess-tree-n', text: String(deep) })));
        shown++;
        if (isOpen) {
          walk(n.children, depth + 1);
          for (const l of n.lists.filter(hit).sort(sortLists)) { nodes.push(listRow(l, depth + 1)); shown++; }
        }
      }
    };
    walk(roots, 0);
    for (const l of orphans.filter(hit).sort(sortLists)) { nodes.push(listRow(l, 0)); shown++; }   // 폴더 밖 리스트는 최상위에
    if (!shown) nodes.push(el('div', { class: 'tsess-projfilter-none', text: '일치하는 리스트가 없어요' }));
    listBox.replaceChildren(...nodes);
  };

  const sortLists = pjvContainerCmp; // #541 — 사이드바와 동일 비교자(sort → ClickUp orderindex → 이름)
  const seedExpand = () => { for (const r of buildTree().roots) expanded.add(r.key); };   // 스페이스(최상위 폴더)는 펼친 채로 시작

  // 새 리스트 만들기 — 만들면 그 리스트를 곧바로 고른 상태로.
  const newBtn = el('button', { class: 'tsess-projfilter-new', type: 'button', text: '＋ 새 리스트 만들기…' });
  newBtn.onmousedown = (e: any) => {
    e.preventDefault(); close();
    openListForm(null, undefined, { onCreated: (list) => {
      if (!list || list.id == null) return;
      loaded = [...loaded, list]; picked = Number(list.id); seedExpand(); paintBtn();
    } });
  };
  foot.append(newBtn);

  const ready = Promise.all([
    api('/api/ui/v6/project-lists').then((d) => (d && d.lists) || []).catch(() => []),
    api('/api/ui/v6/project-folders').then((d) => (d && d.folders) || []).catch(() => []),
  ]).then(([lists, folds]) => {
    loaded = [...lists].sort(sortLists);
    folders = folds || [];
    if (picked != null && !loaded.some((l) => Number(l.id) === Number(picked))) picked = null;
    seedExpand();
    paintBtn();
  });

  return {
    box,
    ready,
    getSelected: () => {
      if (picked != null) return { ok: true, listId: Number(picked) };
      // 리스트가 하나도 없는 최초 부트스트랩만 미분류 생성을 허용한다(그 외엔 검증에서 막힌다).
      return loaded.length ? { ok: false, listId: undefined } : { ok: true, listId: null };
    },
  };
}

// (카테고리 블록 제거 — #473 후속. openProjectSettings 의 컴팩트 피커 + 자동저장으로 대체.)

// (참고 파일 블록 제거 — #246. 프로젝트 파일 업로드는 본문 '공유 폴더' 섹션(projectFolderSection)으로 일원화.
//  '공유 폴더'가 업로드·드래그앤드롭·붙여넣기·폴더 탐색을 모두 제공하므로 모달의 약식 업로더는 중복이었다.)


export {
  listPicker,
  repoPicker,
};
export { openKnowledgePicker } from './knowledge-picker.js';
