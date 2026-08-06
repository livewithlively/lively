// editor/interactions.ts — 포인터 상호작용(#1313 R58 — block-editor.ts 체크박스/클릭/붙여넣기/드롭/⋮⋮ 메뉴/드래그 절 verbatim 적출).
//  드래그 상태(dragging·justDragged)는 이 모듈이 단독 소유한다 — 드롭 대상 판정과 클릭 오발 방지가 한 쌍이라.
import { el, renderInline } from '../core.js';
import { TEXTY } from './model.js';
import { mdToBlocks } from './parse.js';
import { blocksToMd } from './serialize.js';   // 크로스 블록 선택 복사/잘라내기 — 선택 블록을 마크다운으로
import { caretRange, insertText, placeCaret } from './caret.js';
import type { EditorCtx } from './context.js';

export function createInteractions(ctx: EditorCtx) {
  const { root, opts } = ctx;
  const SLASH_ITEMS = ctx.SLASH_ITEMS;   // 값 별칭 — createSlash 뒤에 호출해야 한다(조립 순서, block-editor.ts 참조)
  // 늦은 바인딩 별칭(context.ts 참조).
  const markDirty = () => ctx.markDirty();
  const blockOf = (node: any) => ctx.blockOf(node);
  const blockEls = () => ctx.blockEls();
  const textElOf = (block: HTMLElement) => ctx.textElOf(block);
  const makeBlock = (d: any) => ctx.makeBlock(d);
  const insertBlockAfter = (block: HTMLElement | null, data: any) => ctx.insertBlockAfter(block, data);
  const focusBlock = (block: HTMLElement, atStart?: boolean) => ctx.focusBlock(block, atStart);
  const renumber = () => ctx.renumber();
  const normalizeStructure = () => ctx.normalizeStructure();
  const duplicateBlock = (block: HTMLElement) => ctx.duplicateBlock(block);
  const moveBlockDir = (block: HTMLElement, dir: number) => ctx.moveBlockDir(block, dir);
  const deleteBlock = (block: HTMLElement) => ctx.deleteBlock(block);
  const openSlashMenu = (block: HTMLElement, typed: boolean) => ctx.openSlashMenu(block, typed);
  const insertUploadedImages = (block: HTMLElement, files: File[]) => ctx.insertUploadedImages(block, files);
  const histFlushTyping = () => ctx.histFlushTyping();

  // ── 체크박스/추가 버튼/빈 영역 클릭 ──
  root.addEventListener('change', (e: any) => {
    const cb = e.target;
    if (!cb.classList || !cb.classList.contains('be-check')) return;
    const block = blockOf(cb)!;
    block.dataset.checked = cb.checked ? '1' : '';
    const t = textElOf(block);
    if (t) t.classList.toggle('be-done', cb.checked);
    markDirty();
  });
  root.addEventListener('click', (e: any) => {
    const add = e.target.closest ? e.target.closest('.be-addbtn') : null;
    if (add) {
      const block = blockOf(add)!;
      const nb = insertBlockAfter(block, { type: 'p', text: '' });
      focusBlock(nb);
      openSlashMenu(nb, false);
      return;
    }
    // ⋮⋮ 클릭 = 블록 메뉴(전환·복제·이동·삭제) — 드래그 직후 클릭은 무시(#657n, 노션 동일).
    const h = e.target.closest ? e.target.closest('.be-handle') : null;
    if (h) {
      if (justDragged) return;
      const block = blockOf(h)!;
      openBlockMenu(block, h);
      return;
    }
    // 에디터 안 내부 링크(#/k/… 멘션 등) 클릭 = 이동(노션 멘션 동일). 외부 링크는 기본(캐럿).
    const link = e.target.closest ? e.target.closest('a[href]') : null;
    if (link && root.contains(link)) {
      const href = link.getAttribute('href') || '';
      if (href.startsWith('#/')) { e.preventDefault(); location.hash = href; return; }
    }
    if (e.target === root) {   // 본문 아래 여백 클릭 → 마지막 블록(비면 그거, 아니면 새 문단)
      const bs = blockEls();
      const last = bs[bs.length - 1];
      const lt = last ? textElOf(last) : null;
      if (last && lt && last.dataset.type === 'p' && !lt.textContent) focusBlock(last, false);
      else focusBlock(insertBlockAfter(last || null, { type: 'p', text: '' }));
    }
  });

  // ── 붙여넣기 — 마크다운/여러 줄이면 블록으로 파싱해 삽입, 한 줄이면 평문 삽입 ──
  root.addEventListener('paste', (e: any) => {
    const target = e.target as HTMLElement;
    if (target.classList && (target.classList.contains('be-raw-ta') || target.classList.contains('be-code-lang'))) return;
    const block = blockOf(target);
    if (!block || !target.classList || !target.classList.contains('be-text')) return;
    // #730 이미지 붙여넣기 — 클립보드에 이미지 파일이 있고 업로더가 있으면 인라인 삽입(첨부로 새지 않음).
    const cd = e.clipboardData || (window as any).clipboardData;
    if (opts.uploadFile && cd) {
      const imgs: File[] = [];
      for (const it of (cd.items || [])) { if (it.kind === 'file' && /^image\//.test(it.type || '')) { const f = it.getAsFile(); if (f) imgs.push(f); } }
      if (!imgs.length) for (const f of (cd.files || [])) { if (/^image\//.test(f.type || '')) imgs.push(f); }
      const plain = cd.getData ? (cd.getData('text/plain') || '') : '';
      if (imgs.length && !plain.trim()) { e.preventDefault(); insertUploadedImages(block, imgs); return; }
    }
    const text = (e.clipboardData || (window as any).clipboardData).getData('text/plain');
    if (text == null) return;
    e.preventDefault();
    if (block.dataset.type === 'code') { insertText(text); markDirty(); return; }
    const hasBlockMd = /\n/.test(text) || /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|:::|\|)/.test(text.trim());
    if (!hasBlockMd) { insertText(text); markDirty(); return; }
    const parsed = mdToBlocks(text);
    // 첫 파싱 블록이 문단이면 현재 캐럿에 인라인로 잇고, 나머지는 새 블록으로.
    let rest = parsed;
    if (parsed[0] && parsed[0].type === 'p' && TEXTY.has(block.dataset.type!)) {
      const r = caretRange();
      if (r) {
        const frag = document.createDocumentFragment();
        String(parsed[0].text || '').split('\n').forEach((l, idx) => {
          if (idx > 0) frag.append(el('br'));
          for (const n of renderInline(l)) frag.append(n);
        });
        r.deleteContents();
        r.insertNode(frag);
        placeCaret(target, false);
      }
      rest = parsed.slice(1);
    }
    let anchor: HTMLElement = block;
    for (const d of rest) anchor = insertBlockAfter(anchor, d);
    renumber();
    markDirty();
    if (rest.length) focusBlock(anchor, false);
  });

  // ── #730 이미지 드롭 — 파일을 에디터에 끌어다 놓으면 인라인 삽입(업로더 있을 때만) ──
  root.addEventListener('dragover', (e: any) => {
    if (opts.uploadFile && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); }
  });
  root.addEventListener('drop', (e: any) => {
    if (!opts.uploadFile || !e.dataTransfer) return;
    const files = (Array.from(e.dataTransfer.files || []) as File[]).filter((f) => /^image\//.test(f.type || ''));
    if (!files.length) return;
    e.preventDefault();
    const block = blockOf(e.target as HTMLElement) || blockEls()[blockEls().length - 1];
    if (block) insertUploadedImages(block, files);
  });

  // ── 블록 메뉴(⋮⋮ 클릭) — 전환(단순 텍스트 블록) + 복제/이동/삭제. 노션 핸들 메뉴 동형(#657n). ──
  function openBlockMenu(block: HTMLElement, anchor: HTMLElement) {
    const old = document.querySelector('.be-blockmenu');
    if (old) { old.remove(); return; }
    const type = block.dataset.type!;
    const menu = el('div', { class: 'be-blockmenu', role: 'menu' });
    const close = () => { menu.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
    if (['p', 'h', 'bullet', 'numbered', 'todo', 'quote', 'callout', 'code'].includes(type)) {
      menu.append(el('div', { class: 'be-bm-head', text: '전환' }));
      const grid = el('div', { class: 'be-bm-grid' });
      for (const it of SLASH_ITEMS) {
        if (!['text', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'toggle', 'columns', 'quote', 'callout', 'code'].includes(it.k)) continue;
        const b = el('button', { class: 'be-bm-turn', type: 'button', title: it.label, text: it.ic });
        b.addEventListener('mousedown', (ev) => ev.preventDefault());
        b.onclick = () => { close(); it.apply(block); };
        grid.append(b);
      }
      menu.append(grid, el('div', { class: 'be-bm-hr' }));
    }
    const item = (ic: string, label: string, fn: () => void, danger?: boolean) => {
      const b = el('button', { class: 'be-bm-item' + (danger ? ' danger' : ''), type: 'button' },
        el('span', { class: 'be-bm-ic', 'aria-hidden': 'true', text: ic }), el('span', { text: label }));
      b.onclick = () => { close(); fn(); };
      return b;
    };
    menu.append(
      item('⧉', '복제 — ⌘D', () => duplicateBlock(block)),
      item('↑', '위로 이동 — ⌘⇧↑', () => moveBlockDir(block, -1)),
      item('↓', '아래로 이동 — ⌘⇧↓', () => moveBlockDir(block, 1)),
      item('✕', '삭제', () => deleteBlock(block), true));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const mh = menu.offsetHeight || 220;
    menu.style.left = Math.max(8, Math.min(r.left - 6, window.innerWidth - 246)) + 'px';
    menu.style.top = (r.bottom + 6 + mh > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
    const onDoc = (ev: any) => { if (!menu.contains(ev.target)) close(); };
    const onKey = (ev: any) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
    setTimeout(() => { document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); }, 0);
  }

  // ── 드래그 — 위/아래 재정렬 + 좌/우 엣지 드롭 = 컬럼 생성(노션 시그니처 레이아웃, #657n). ──
  //  타깃은 elementFromPoint 로(중첩 컨테이너 안 블록도 정타깃). 컬럼 생성은 최상위 블록 간에만(중첩 컬럼 금지).
  let dragging: HTMLElement | null = null;
  let justDragged = false;
  root.addEventListener('dragstart', (e: any) => {
    const h = e.target.closest ? e.target.closest('.be-handle') : null;
    if (!h) { e.preventDefault(); return; }
    dragging = blockOf(h);
    if (!dragging) return;
    histFlushTyping();   // 드래그 직전 타이핑 버스트 확정 — undo 가 드래그만 되돌리도록
    justDragged = true;
    dragging.classList.add('be-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', ''); e.dataTransfer.setDragImage(dragging, 24, 12); } catch (_) { /* noop */ }
  });
  const DROP_CLASSES = ['be-drop-above', 'be-drop-below', 'be-drop-left', 'be-drop-right'];
  const clearDrop = () => root.querySelectorAll('.' + DROP_CLASSES.join(', .')).forEach((n) => n.classList.remove(...DROP_CLASSES));
  function dropTargetAt(e: any): HTMLElement | null {
    const under: any = document.elementFromPoint(e.clientX, e.clientY);
    let target = under && under.closest ? under.closest('.be-block') : null;
    if (target && (!root.contains(target) || target === dragging || dragging!.contains(target) || target.contains(dragging!))) target = null;
    if (target) return target;
    // 여백 폴백 — 루트 직계 블록을 Y 로 스캔(기존 동작).
    let fb: HTMLElement | null = null;
    for (const b of blockEls()) {
      if (b === dragging || b.contains(dragging!)) continue;
      const r = b.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) return b;
      fb = b;
    }
    return fb;
  }
  root.addEventListener('dragover', (e: any) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDrop();
    const target = dropTargetAt(e);
    if (!target) return;
    const r = target.getBoundingClientRect();
    // 좌/우 엣지 = 컬럼 생성 힌트 — 루트 직계 + 양쪽 다 컬럼 아님일 때만.
    const EDGE = Math.min(72, Math.max(28, r.width * 0.16));
    const canCol = target.parentElement === root && target.dataset.type !== 'columns' && dragging.dataset.type !== 'columns';
    if (canCol && e.clientX < r.left + EDGE) { target.classList.add('be-drop-left'); return; }
    if (canCol && e.clientX > r.right - EDGE) { target.classList.add('be-drop-right'); return; }
    target.classList.add(e.clientY < r.top + r.height / 2 ? 'be-drop-above' : 'be-drop-below');
  });
  root.addEventListener('drop', (e: any) => {
    if (!dragging) return;
    e.preventDefault();
    const t = root.querySelector('.' + DROP_CLASSES.join(', .')) as HTMLElement;
    if (t && t !== dragging) {
      if (t.classList.contains('be-drop-left') || t.classList.contains('be-drop-right')) {
        // 컬럼 생성 — 새 컨테이너에 [드래그, 타깃](왼쪽 드롭) 또는 [타깃, 드래그] 순으로 실 DOM 이동.
        const left = t.classList.contains('be-drop-left');
        const shell = makeBlock({ type: 'columns', cols: [[], []], __shell: true });
        t.before(shell);
        const cols = shell.querySelectorAll(':scope > .be-main > .be-cols > .be-col');
        cols[0].append(left ? dragging : t);
        cols[1].append(left ? t : dragging);
      } else if (t.classList.contains('be-drop-above')) {
        t.before(dragging);
      } else {
        t.after(dragging);
      }
      normalizeStructure();
      markDirty();
    }
    clearDrop();
  });
  root.addEventListener('dragend', () => {
    if (dragging) dragging.classList.remove('be-dragging');
    dragging = null;
    clearDrop();
    setTimeout(() => { justDragged = false; }, 50);   // 드래그 직후 handle click 오발 방지
  });

  // ════════ 크로스 블록 선택 ════════
  //  블록마다 contenteditable 이 따로라(render.ts 의 .be-text) 브라우저 Selection 은 **한 편집 호스트 안에서만**
  //  range 를 만든다 → 경계를 넘는 드래그가 원천적으로 안 되고 ⌘A 도 커서가 있는 블록 하나만 잡힌다.
  //  그래서 경계를 넘는 순간 우리가 넘겨받아 '블록 범위 선택'을 직접 그린다(노션과 같은 방식).
  //  keys.ts 가 이 범위를 보고 삭제·대체·복사를 처리한다(ctx.bsel* — context.ts 참조).
  let bselAnchor: HTMLElement | null = null;
  let bsel: HTMLElement[] = [];
  let bDragging = false;

  const bselActive = () => bsel.length > 0;
  const bselEdge = (last: boolean) => (bsel.length ? bsel[last ? bsel.length - 1 : 0] : null);
  function bselClear() {
    if (!bsel.length) return;
    for (const b of bsel) b.classList.remove('be-bsel');
    bsel = [];
    root.classList.remove('be-bselecting');
  }
  function bselSet(a: HTMLElement, b: HTMLElement) {
    const all = ctx.blockEls();
    let i = all.indexOf(a), j = all.indexOf(b);
    if (i < 0 || j < 0) return;
    if (i > j) { const t = i; i = j; j = t; }
    const next = all.slice(i, j + 1);
    // 한 블록 안에 머무는 드래그는 브라우저 기본(문자 단위)이 낫다 — 우리 하이라이트를 걷는다.
    if (next.length < 2) { bselClear(); return; }
    for (const x of bsel) if (next.indexOf(x) < 0) x.classList.remove('be-bsel');
    for (const x of next) x.classList.add('be-bsel');
    bsel = next;
    root.classList.add('be-bselecting');
    const s = window.getSelection(); if (s) s.removeAllRanges();   // 두 겹 하이라이트 방지
  }
  function bselAll(): boolean {
    const all = ctx.blockEls();
    if (all.length < 2) return false;
    bselSet(all[0], all[all.length - 1]);
    return true;
  }
  //  선택 블록을 지우고 그 자리에 빈 문단 하나를 남긴다(그리로 포커스) — 삭제·문자 대체·잘라내기 공통 경로.
  //  snapNow 로 한 스텝을 확정하므로 ⌘Z 로 통째로 되돌아온다.
  function bselDelete(): HTMLElement | null {
    if (!bsel.length) return null;
    ctx.snapNow();
    const nb = ctx.makeBlock({ type: 'p', text: '' });
    bsel[0].before(nb);
    for (const b of bsel) b.remove();
    bselClear();
    ctx.ensureOne(); ctx.renumber(); markDirty();
    ctx.focusBlock(nb, true);
    return nb;
  }
  const bselMd = () => blocksToMd(bsel.map((b) => ctx.blockData(b)));

  root.addEventListener('mousedown', (e: any) => {
    if (e.button !== 0) return;
    bselClear();
    // 거터(＋·⋮⋮ 손잡이)에서 시작한 드래그는 **블록 이동**(HTML5 drag)의 몫이다 — 범위 선택으로 가로채지 않는다.
    if (e.target && e.target.closest && e.target.closest('.be-gutter')) { bselAnchor = null; bDragging = false; return; }
    bselAnchor = blockOf(e.target);
    bDragging = !!bselAnchor;
  });
  document.addEventListener('mousemove', (e: any) => {
    if (!bDragging || !bselAnchor) return;
    const over = blockOf(document.elementFromPoint(e.clientX, e.clientY));
    if (!over) return;                     // 에디터 밖으로 나간 동안은 직전 범위를 유지
    bselSet(bselAnchor, over);             // 같은 블록으로 돌아오면 bselSet 이 알아서 걷는다
  });
  document.addEventListener('mouseup', () => { bDragging = false; });
  //  HTML5 드래그가 시작되면 mouseup 이 오지 않는다 → 여기서 끊지 않으면 이후 '마우스만 움직여도 선택'이 된다.
  root.addEventListener('dragstart', () => { bDragging = false; bselAnchor = null; bselClear(); }, true);

  //  복사·잘라내기는 선택 블록을 마크다운으로 — 붙여넣기(위 paste)가 그대로 되받아 블록으로 복원한다.
  root.addEventListener('copy', (e: any) => {
    if (!bselActive() || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', bselMd());
  });
  root.addEventListener('cut', (e: any) => {
    if (!bselActive() || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', bselMd());
    bselDelete();
  });

  return { bselActive, bselAll, bselClear, bselDelete, bselEdge };
}
