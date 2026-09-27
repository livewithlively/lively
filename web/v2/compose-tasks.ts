// v2/compose-tasks.ts — 새 세션 글칸의 **태스크 배지**(#4135, 원준 2026-09-27 «담기 누르면 입력창에 @사람 했을 때처럼
//  태스크 내용 담긴 뱃지가 들어가게 · 순서 지정도 되게»). 사람 초대(compose-mention.ts)와 같은 자리·같은 문법이다.
//
//  · 곁칸 «프로젝트» 앱의 [담기]가 넣고(task-picks.ts 목록), 여기서도 `#` 을 치면 태스크 목록이 떠서 고를 수 있다.
//  · 배지 앞의 **번호가 곧 순서**다 — 세션이 열리면 이 순서대로 «이 세션의 태스크» 1. 2. 가 된다.
//    순서 바꾸기: ① 담은 순서 ② 배지를 끌어 놓기 ③ 번호를 눌러 메뉴(1번으로 · 한 칸 앞/뒤로 · 빼기) ④ `#` 로 맨 뒤에 붙이기.
//    곁칸의 줄을 끌어 이 배지 줄에 놓아도 그 자리에 들어간다.
//  · 배지에 상태 아이콘은 두지 않는다(원준 2026-09-27 «뱃지 안에는 진행중 아이콘 필요없을듯»).
import { el } from '../core.js';
import { pjvPopover } from '../projects/popover.js';
import { hashMatches, hashQuery, isDoing, isDone, moveInOrder } from '../lib/task-pane.js';
import { charPos } from './compose-mention.js';
import { onTaskPicks, setTaskPicks, taskPicks } from './task-picks.js';

/** 곁칸 줄을 끌어 올 때 싣는 종류 — 곁칸(panes-tasks.ts)과 같은 글자. */
export const TASK_DRAG_TYPE = 'application/x-lively-task';

export interface ComposerTasks {
  /** 배지 줄 — 첨부·사람 칩 줄 옆에 둔다. 비면 숨김. */
  chips: HTMLElement;
  /** `#` 후보 목록 — 카드(.v2-launch, position:relative) 안에 붙인다. */
  menu: HTMLElement;
  /** 입력칸에 건다 — 입력칸당 한 번만. */
  wire(ta: HTMLTextAreaElement): void;
  ids(): number[];
  clear(): void;
  destroy(): void;
}

export function composerTasks(o: { root: () => HTMLElement; tasks: () => any[]; onChange?: (ids: number[]) => void }): ComposerTasks {
  const chips = el('div', { class: 'pn-att v2-ppl pj-tchips', hidden: true });
  const menu = el('div', { class: 'v2-mention pj-hmenu', hidden: true, role: 'listbox' });
  let ta: HTMLTextAreaElement | null = null;
  let picks: any[] = [];
  let sel = 0;
  let dragId = 0;
  const caret = el('span', { class: 'pj-caret2', 'aria-hidden': 'true' });

  const ids = (): number[] => taskPicks(o.root());
  const set = (next: number[]): void => setTaskPicks(o.root(), next);
  const byId = (id: number): any => o.tasks().find((t) => Number(t.id) === id) || { id, name: '' };

  function numMenu(btn: HTMLElement, id: number): void {
    const cur = ids();
    const i = cur.indexOf(id);
    const item = (label: string, on: boolean, run: () => void): HTMLElement => {
      const b = el('button', { class: 'pjv-menu-item', type: 'button', disabled: on ? undefined : '' }, el('span', { text: label }));
      b.onclick = () => { close(); run(); };
      return b;
    };
    const box = el('div', { class: 'pjv-menu' },
      item('1번으로', i > 0, () => set(moveInOrder(ids(), ids().indexOf(id), 0))),
      item('한 칸 앞으로', i > 0, () => set(moveInOrder(ids(), ids().indexOf(id), ids().indexOf(id) - 1))),
      item('한 칸 뒤로', i >= 0 && i < cur.length - 1, () => set(moveInOrder(ids(), ids().indexOf(id), ids().indexOf(id) + 1))),
      item('빼기', true, () => set(ids().filter((x) => x !== id))));
    const close = pjvPopover(btn, box);
  }

  function paint(): void {
    const cur = ids();
    chips.hidden = !cur.length;
    chips.replaceChildren(...cur.map((id, i) => {
      const t = byId(id);
      const chip = el('span', {
        class: 'pn-att-c pj-tchip', draggable: 'true', 'data-id': String(id),
        title: `${i + 1}번 · #${id} ${t.name || ''}\n끌어서 순서를 바꾸거나 번호를 눌러 옮기세요`,
      },
        el('button', { class: 'pj-tnum', type: 'button', text: String(i + 1), title: '순서 바꾸기 · 빼기', 'aria-label': `${i + 1}번 — 순서 바꾸기`,
          onclick: (e: Event) => { e.stopPropagation(); numMenu(e.currentTarget as HTMLElement, id); } }),
        el('span', { class: 'n' }, el('b', { text: '#' + id }), el('span', { text: ' ' + String(t.name || '') })),
        el('button', { class: 'pn-att-x', type: 'button', title: '빼기', 'aria-label': '빼기', text: '✕',
          onclick: () => { set(ids().filter((x) => x !== id)); ta?.focus(); } }));
      chip.addEventListener('dragstart', (e: DragEvent) => {
        dragId = id; chip.classList.add('lift');
        e.dataTransfer?.setData(TASK_DRAG_TYPE, String(id));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      chip.addEventListener('dragend', () => { dragId = 0; chip.classList.remove('lift'); caret.remove(); });
      return chip;
    }), el('span', { class: 'pj-chint', text: cur.length > 1 ? '이 순서대로 1번부터 진행해요 · 끌거나 번호를 눌러 순서 바꾸기' : '세션이 열리면 이 태스크를 맡아요' }));
    o.onChange?.(cur);
  }

  /** 끌어 놓을 자리(옮긴 뒤 몇 번째 앞인가) — 같은 줄에서 칩 가운데보다 왼쪽이면 그 칩 앞. */
  function dropIndex(e: DragEvent): number {
    const list = ([...(chips as HTMLElement).querySelectorAll('.pj-tchip')] as HTMLElement[]);
    for (let i = 0; i < list.length; i++) {
      const r = list[i].getBoundingClientRect();
      if (e.clientY < r.top) return i;
      if (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2) return i;
    }
    return list.length;
  }
  const accepts = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes(TASK_DRAG_TYPE);
  chips.addEventListener('dragover', (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    const at = dropIndex(e);
    const list = ([...(chips as HTMLElement).querySelectorAll('.pj-tchip')] as HTMLElement[]);
    if (at < list.length) list[at].before(caret); else (list[list.length - 1] || chips.firstChild)?.after(caret);
  });
  chips.addEventListener('dragleave', (e: DragEvent) => { if (!chips.contains(e.relatedTarget as Node)) caret.remove(); });
  chips.addEventListener('drop', (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    const id = Number(e.dataTransfer?.getData(TASK_DRAG_TYPE) || dragId);
    const at = dropIndex(e);
    caret.remove();
    if (!(id > 0)) return;
    const cur = ids();
    const from = cur.indexOf(id);
    if (from < 0) { const next = cur.slice(); next.splice(at, 0, id); set(next); return; }   // 곁칸에서 끌어 왔다
    set(moveInOrder(cur, from, from < at ? at - 1 : at));
  });

  // ── `#` 로 태스크 부르기 ──
  function closeMenu(): void { menu.hidden = true; picks = []; sel = 0; }
  function paintMenu(): void {
    if (!ta) return;
    const q = hashQuery(ta.value, ta.selectionStart ?? ta.value.length);
    if (!q) { closeMenu(); return; }
    picks = hashMatches(o.tasks(), q.q, new Set(ids()));
    if (!picks.length) { closeMenu(); return; }
    sel = Math.min(sel, picks.length - 1);
    const pos = charPos(ta, q.start);
    const host = ta.offsetParent as HTMLElement | null;
    const room = host ? host.clientWidth : ta.clientWidth;
    menu.style.top = (pos.top + pos.line + 4) + 'px';
    menu.style.left = Math.max(8, Math.min(pos.left, room - 348)) + 'px';
    menu.hidden = false;
    menu.replaceChildren(...picks.map((t, i) => el('div', {
      class: 'v2-mention-row' + (i === sel ? ' is-sel' : ''), role: 'option',
      onmousedown: (ev: Event) => { ev.preventDefault(); choose(i); },
    },
      el('span', { class: 'pn-tk-st static ' + (isDone(t) ? 'done' : isDoing(t) ? 'doing' : 'todo'), 'aria-hidden': 'true' }),
      el('span', { class: 'n' }, el('b', { text: '#' + t.id }), el('span', { text: ' ' + String(t.name || '') })))));
  }
  function choose(i: number): void {
    const t = picks[i];
    if (!ta || !t) return;
    const c = ta.selectionStart ?? ta.value.length;
    const q = hashQuery(ta.value, c);
    if (q) { ta.value = ta.value.slice(0, q.start) + ta.value.slice(c); ta.setSelectionRange(q.start, q.start); }
    set([...ids(), Number(t.id)]);
    closeMenu();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  }

  const off = onTaskPicks(o.root(), () => paint());
  return {
    chips, menu,
    wire(input) {
      ta = input;
      ta.addEventListener('input', paintMenu);
      ta.addEventListener('keydown', (ev: KeyboardEvent) => {
        if (menu.hidden || !picks.length || ev.isComposing) return;
        if (ev.key === 'ArrowDown') { sel = (sel + 1) % picks.length; paintMenu(); ev.preventDefault(); return; }
        if (ev.key === 'ArrowUp') { sel = (sel - 1 + picks.length) % picks.length; paintMenu(); ev.preventDefault(); return; }
        if (ev.key === 'Enter' || ev.key === 'Tab') { choose(sel); ev.preventDefault(); ev.stopImmediatePropagation(); return; }
        if (ev.key === 'Escape') { closeMenu(); ev.preventDefault(); ev.stopImmediatePropagation(); }
      }, true);
      ta.addEventListener('click', paintMenu);
      ta.addEventListener('blur', () => window.setTimeout(closeMenu, 120));
      paint();
    },
    ids,
    clear() { set([]); closeMenu(); },
    destroy() { off(); },
  };
}
