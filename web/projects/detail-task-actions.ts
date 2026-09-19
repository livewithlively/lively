// projects/detail-task-actions.ts — #1405 W2: detail-tasks.ts 분할 ①.
//  태스크 행의 **동작** 조각 — 하위작업 인라인 표시 · ⋯ 메뉴(이름변경·삭제) · 새 태스크 생성.
//  ⚠ 행 렌더(pjvTaskRow)와 그 몽키패치 IIFE 2개는 detail-tasks.ts 에 그대로 남는다 —
//   교체 순서·재수출 형태를 scripts/pjv-taskrow-monkeypatch.test.mjs 가 못박고 있어 배치를 바꾸면 안 된다.
import { api, el, toast } from '../core.js';
import { overlayBox } from '../learn.js';
import { pjvPopover } from './popover.js';
import { pjvReloadKeepScroll } from './state.js';
import { pjvPatchTask } from './task-controls.js';
import { spawnSession } from '../v2/quick-session.js';   // #4084 — 세션 생성은 한 곳(생성 캐시·첫 지시 규약이 거기 묶여 있다)

// #4084 세션 = 태스크 — 세션 화면으로 간다. 보드는 새 셸 안의 액자로 떠 있으므로 주소는 **바깥 셸**이 연다
//  (context-map.ts 와 같은 'lively:open-route' 규약). 액자가 아니면(구 셸 단독) 제 주소를 바꾼다.
function pjvOpenSessionRoute(sid: string): void {
  const href = '#/s/' + encodeURIComponent(sid);
  if (window.parent && window.parent !== window) {
    try { window.parent.postMessage({ type: 'lively:open-route', href }, location.origin); return; } catch (_) { /* 아래로 */ }
  }
  location.hash = href;
}

// #4084 — 이 태스크를 **맡은 새 세션**을 연다. 첫 지시는 서버가 «태스크 #<id> 진행해» + 본문으로 채우고, 세션 이름은
//  태스크 이름이 된다. 잇는 순간 태스크는 «진행 중», 세션이 일을 끝내면 «완료»로 바꾼다(v6/session-task.ts).
async function pjvOpenTaskSession(projectId, t, reload) {
  const made = await spawnSession('', { projectId: Number(projectId), taskId: Number(t.id) });
  if (!made) return;                                 // 이유는 spawnSession 이 toast 로 이미 말했다
  toast('이 태스크를 맡은 세션을 열었어요.');
  pjvReloadKeepScroll(reload);
  pjvOpenSessionRoute(made.id);
}

// 더블클릭 → 하위 태스크 인라인 생성(클릭업식). 같은 행에 입력칸 1개만, Enter=생성, Esc/빈 blur=취소.
function pjvShowInlineSubtask(projectId, parentTask, subBox, reload) {
  const existing = subBox.querySelector('.pjv-subadd');
  if (existing) { const i = existing.querySelector('input'); if (i) i.focus(); return; }
  const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '하위 태스크 이름 입력 후 Enter (Esc 취소)', maxlength: '200' });
  const row = el('div', { class: 'pjv-subadd' }, input);
  subBox.append(row);
  setTimeout(() => input.focus(), 0);
  let busy = false;
  input.addEventListener('blur', () => { if (!input.value.trim()) row.remove(); });
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { input.value = ''; row.remove(); return; }
    if (e.key !== 'Enter') return;
    const name = input.value.trim(); if (!name || busy) return;
    busy = true; input.disabled = true;
    try { await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name, parent_task_id: parentTask.id }) }); pjvReloadKeepScroll(reload); /* 하위 추가 후 스크롤 보존(#459) */ }
    catch (err) { toast('추가 실패 — ' + err.message, true); input.disabled = false; busy = false; }
  });
}

// 행 오른쪽 끝 ⋯ 더보기 메뉴(클릭업식) — 하위 태스크 추가(상위만)·이름 변경·삭제.
function pjvRowMore(projectId, t, depth, reload, onAddSub) {
  const btn = el('button', { class: 'pjv-trow-more', type: 'button', title: '더보기', 'aria-label': '태스크 작업' , text: '⋯' });
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    const mkItem = (label, onPick, danger?) => {
      const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label }));
      b.onclick = () => { close(); onPick(); };
      return b;
    };
    // #4084 세션 = 태스크 — 맡은 세션이 있으면 그리로 가는 길과 새 세션으로 이어 하는 길, 없으면 세션 열기.
    const sess = Array.isArray(t.sessions) ? t.sessions : [];
    if (depth === 0 && t.level !== 'subtask') {
      if (sess.length) menu.append(mkItem('맡은 세션으로 가기' + (sess[0].label ? ` («${sess[0].label}»)` : ''), () => pjvOpenSessionRoute(String(sess[0].id))));
      menu.append(mkItem(sess.length ? '새 세션으로 이어 하기' : '세션 열기', () => void pjvOpenTaskSession(projectId, t, reload)));
    }
    if (depth === 0 && onAddSub) menu.append(mkItem('하위 태스크 추가', onAddSub));
    menu.append(mkItem('이름 변경', () => pjvRenameTask(btn, t, reload)));
    menu.append(mkItem('삭제', () => pjvDeleteTask(t, reload), true));
  };
  return btn;
}

// 이름 변경 — 앵커 아래 인라인 입력 팝오버. Enter 저장 / Esc·바깥클릭 취소.
function pjvRenameTask(anchor, t, reload) {
  const cur = t.name || t.title || '';
  const input = el('input', { type: 'text', class: 'pjv-rename-input', value: cur, maxlength: '200' });
  const close = pjvPopover(anchor, el('div', { class: 'pjv-menu pjv-rename-pop' }, input));
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const v = input.value.trim(); close(); if (v && v !== cur) pjvPatchTask(t.id, { name: v }, reload); }
  };
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

// 삭제 — 확인 후 task_delete_v6. 하위 동반 삭제 경고. #/trash 복원 가능.
function pjvDeleteTask(t, reload) {
  const nm = t.name || t.title || '이 태스크';
  const nSub = (t.subtasks || []).length;
  const msg = "'" + nm + "' 태스크를 삭제할까요?" + (nSub ? '\n\n하위 ' + nSub + '개도 함께 삭제됩니다.' : '') + '\n\n#/trash 에서 복원할 수 있습니다.';
  if (!confirm(msg)) return;
  (async () => {
    try {
      await api('/api/ui/v6/tasks/' + t.id + '/delete', { method: 'POST', body: JSON.stringify({}) });
      toast('삭제했습니다 — #/trash 에서 복원 가능');
      pjvReloadKeepScroll(reload);  // 태스크 삭제 후 위로 튀지 않게 스크롤 보존(#459)
    } catch (e) { toast('삭제 실패 — ' + e.message, true); }
  })();
}

// 태스크/하위 추가 폼 — 이름(필수)·설명(선택). parentTaskId 있으면 하위로 생성(parent_task_id).
function pjvAddTask(projectId, parentTaskId, reload) {
  const nameIn = el('input', { type: 'text', placeholder: parentTaskId ? '하위 태스크 이름' : '태스크 이름', maxlength: '200' });
  const descIn = el('textarea', { rows: '2', placeholder: '설명 (선택)', maxlength: '4000' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '추가' });
  const back = overlayBox(parentTaskId ? '하위 태스크 추가' : '새 태스크',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '설명 (선택)' }), descIn),
    el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
  setTimeout(() => nameIn.focus(), 0);
  const go = async () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({
        name, description: descIn.value.trim() || undefined,
        parent_task_id: parentTaskId != null ? parentTaskId : undefined,
      }) });
      back.remove();
      toast(parentTaskId ? '하위 태스크를 추가했습니다' : '태스크를 추가했습니다');
      pjvReloadKeepScroll(reload);  // 태스크 추가 후 스크롤 보존(#459)
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

export { pjvAddTask, pjvRenameTask, pjvRowMore, pjvShowInlineSubtask };
