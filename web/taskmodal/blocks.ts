// taskmodal/blocks.ts — #1313 R56: web/taskmodal.ts 섹션 분할 ⑤(연결·체크리스트 블록).
//  연결 유형 라벨(PJV_LINK_TYPE) · 연결 추가 팝오버(같은 프로젝트 내 검색) · 체크리스트(제목 인라인 수정·항목·진행률).
//  목록 렌더(pjvtmLinks)는 드릴인이 모달 셸의 dirty/closeModal 을 잡아야 해서 shell.ts 에 남는다.
import { api, el, toast } from '../core.js';
// 소유처 직결(#1313 R56) — 배럴 경유였다면 순환 가지가 늘어난다(composer.ts 주석과 같은 이유).
import { pjvPopover } from '../projects/popover.js';
import { debounce } from '../projects/files.js';
import { pjvStatusIconStd, pjvStatusMeta } from '../projects/status.js';

const PJV_LINK_TYPE = {
  blocking:   { label: '막고 있음',  short: 'blocking' },
  waiting_on: { label: '기다리는 중', short: 'waiting on' },
  linked:     { label: '연결됨',     short: 'linked' },
};

function pjvtmLinkPop(anchor, d, t, refresh) {
  const pop = el('div', { class: 'pjv-menu pjv-tm-linkpop' });
  const typeSel = el('select', { class: 'pjv-tm-linktype-sel' },
    el('option', { value: 'blocking', text: '막고 있음 (blocking)' }),
    el('option', { value: 'waiting_on', text: '기다리는 중 (waiting on)' }),
    el('option', { value: 'linked', text: '연결됨 (linked)' }));
  const input = el('input', { type: 'text', class: 'pjv-tm-taginput', placeholder: '연결할 태스크 검색', maxlength: '100' });
  const results = el('div', { class: 'pjv-tm-tagresults' });
  pop.append(typeSel, input, results);
  const close = pjvPopover(anchor, pop);
  setTimeout(() => input.focus(), 0);
  const have = new Set((d.links || []).map((x) => x.id));
  const run = (typeof debounce === 'function' ? debounce : (f) => f)(async () => {
    const q = input.value.trim();
    let targets: any[] = [];
    try { targets = await api('/api/ui/v6/projects/' + d.project.id + '/link-targets?exclude=' + t.id + '&q=' + encodeURIComponent(q)).then((r) => (r && r.targets) || []); } catch (_) {}
    const cand = targets.filter((x) => !have.has(x.id));
    results.replaceChildren(...cand.slice(0, 10).map((x) => {
      const m = pjvStatusMeta(x.status);
      return el('button', { class: 'pjv-menu-item', type: 'button',
        onclick: async () => {
          try { await api('/api/ui/v6/tasks/' + t.id + '/links', { method: 'POST', body: JSON.stringify({ to_task: x.id, type: typeSel.value }) }); close(); refresh(); }
          catch (e) { toast('실패 — ' + e.message, true); } } },
        pjvStatusIconStd(m.bucket, 'sm'),
        el('span', { text: x.name }));
    }));
    if (!cand.length) results.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '결과 없음' }));
  }, 250);
  input.addEventListener('input', run);
  run();
}

// 체크리스트 — 목록(진행률) + 항목(체크·이름·삭제) + 항목추가 + 새 체크리스트.
function pjvtmChecklists(d, t, members, refresh) {
  const lists = d.checklists || [];
  const sec = el('div', { class: 'pjv-tm-block' });
  sec.append(el('div', { class: 'pjv-tm-block-head' },
    el('span', { class: 'pjv-tm-block-title', text: '체크리스트' })));
  for (const cl of lists) {
    const done = cl.items.filter((i) => i.done).length;
    const clBox = el('div', { class: 'pjv-tm-cl' });
    // 제목 — 클릭하면 인라인 입력으로 바뀌어 수정(rename). Enter/blur 저장, Esc 취소.
    const nameEl = el('span', { class: 'pjv-tm-cl-name', text: cl.name, title: '클릭해 제목 수정', role: 'button', tabindex: '0' });
    const editName = () => {
      const inp = el('input', { type: 'text', class: 'pjv-tm-cl-nameedit', value: cl.name, maxlength: '120' });
      nameEl.replaceWith(inp); inp.focus(); inp.select();
      let fin = false;
      const finish = async (save) => {
        if (fin) return; fin = true;
        const nv = inp.value.trim();
        if (save && nv && nv !== cl.name) {
          try { await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'rename', checklist_id: cl.id, name: nv }) }); cl.name = nv; nameEl.textContent = nv; }
          catch (e) { toast('제목 수정 실패 — ' + e.message, true); }
        }
        inp.replaceWith(nameEl);
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { finish(false); } });
      inp.addEventListener('blur', () => finish(true));
    };
    nameEl.onclick = editName;
    nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') editName(); });
    clBox.append(el('div', { class: 'pjv-tm-cl-head' },
      nameEl,
      el('span', { class: 'pjv-tm-cl-prog', text: done + '/' + cl.items.length }),
      el('button', { class: 'pjv-tm-cl-x', type: 'button', title: '체크리스트 삭제', text: '✕',
        onclick: async () => { if (!confirm('이 체크리스트를 삭제하겠습니까?\n하위 항목도 모두 사라집니다.')) return; try { await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'delete', checklist_id: cl.id }) }); refresh(); } catch (e) { toast('실패 — ' + e.message, true); } } })));
    for (const it of cl.items) {
      const cb = el('button', { class: 'pjv-tm-cl-check' + (it.done ? ' on' : ''), type: 'button', text: it.done ? '✓' : '',
        onclick: async () => { try { await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'update_item', item_id: it.id, done: !it.done }) }); refresh(); } catch (e) { toast('실패 — ' + e.message, true); } } });
      clBox.append(el('div', { class: 'pjv-tm-cl-item' }, cb,
        el('span', { class: 'pjv-tm-cl-itemname' + (it.done ? ' done' : ''), text: it.name }),
        el('button', { class: 'pjv-tm-cl-x', type: 'button', title: '항목 삭제', text: '✕',
          onclick: async () => { try { await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'delete_item', item_id: it.id }) }); refresh(); } catch (e) { toast('실패 — ' + e.message, true); } } })));
    }
    const itemIn = el('input', { type: 'text', class: 'pjv-tm-cl-add', placeholder: '＋ 항목 추가 후 Enter', maxlength: '200' });
    // Enter 로 연속 추가 — 전체 새로고침 대신 항목을 낙관적으로 붙이고 입력 포커스를 유지(커서가 안 사라짐).
    itemIn.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const name = itemIn.value.trim(); if (!name) return;
      itemIn.value = ''; itemIn.focus();
      try {
        const res = await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'add_item', checklist_id: cl.id, name }) });
        const updated = ((res && res.checklists) || []).find((c) => c.id === cl.id);
        const it = updated && updated.items[updated.items.length - 1];
        if (!it) { refresh(); return; }
        const cb = el('button', { class: 'pjv-tm-cl-check', type: 'button', text: '',
          onclick: async () => { try { await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'update_item', item_id: it.id, done: true }) }); refresh(); } catch (e2) { toast('실패 — ' + e2.message, true); } } });
        clBox.insertBefore(el('div', { class: 'pjv-tm-cl-item' }, cb,
          el('span', { class: 'pjv-tm-cl-itemname', text: it.name }),
          el('button', { class: 'pjv-tm-cl-x', type: 'button', title: '항목 삭제', text: '✕',
            onclick: async () => { try { await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'delete_item', item_id: it.id }) }); refresh(); } catch (e2) { toast('실패 — ' + e2.message, true); } } })), itemIn);
        const prog = clBox.querySelector('.pjv-tm-cl-prog');
        if (prog) prog.textContent = updated.items.filter((i) => i.done).length + '/' + updated.items.length;
      } catch (err) { toast('실패 — ' + err.message, true); }
    });
    clBox.append(itemIn);
    sec.append(clBox);
  }
  const addBtn = el('button', { class: 'pjv-tm-block-add', type: 'button', text: '✓ 체크리스트 만들기' });
  addBtn.onclick = async () => {
    const name = prompt('체크리스트 이름', '체크리스트'); if (name == null) return;
    try { await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'create', name: name || '체크리스트' }) }); refresh(); }
    catch (e) { toast('실패 — ' + e.message, true); }
  };
  sec.append(addBtn);
  return sec;
}

export { PJV_LINK_TYPE, pjvtmChecklists, pjvtmLinkPop };
