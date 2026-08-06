// editor/keys.ts — 키 입력(keydown) + 마크다운 단축 변환(input)(#1313 R58 — block-editor.ts '키 입력' 절 verbatim 적출).
//  한국어 IME 조합 가드(#505 동형)의 소유자 — compositionstart/end 로 ctx.st.composing 을 세운다.
import { el } from '../core.js';
import { LISTY } from './model.js';
import { inlineDomToMd } from './serialize.js';
import { caretAtEnd, caretAtStart, caretRange, extractAfterCaret, insertText, placeCaret } from './caret.js';
import type { EditorCtx } from './context.js';

export function createKeys(ctx: EditorCtx) {
  const { root, opts, st } = ctx;
  // 늦은 바인딩 별칭(context.ts 참조).
  const markDirty = () => ctx.markDirty();
  const markDirtyType = () => ctx.markDirtyType();
  const blockOf = (node: any) => ctx.blockOf(node);
  const textElOf = (block: HTMLElement) => ctx.textElOf(block);
  const prevTextBlock = (block: HTMLElement) => ctx.prevTextBlock(block);
  const nextTextBlock = (block: HTMLElement) => ctx.nextTextBlock(block);
  const makeBlock = (d: any) => ctx.makeBlock(d);
  const convertBlock = (block: HTMLElement, to: any) => ctx.convertBlock(block, to);
  const insertBlockAfter = (block: HTMLElement | null, data: any) => ctx.insertBlockAfter(block, data);
  const focusBlock = (block: HTMLElement, atStart?: boolean) => ctx.focusBlock(block, atStart);
  const toToggleBlock = (b: HTMLElement, summaryText: string) => ctx.toToggleBlock(b, summaryText);
  const ensureOne = () => ctx.ensureOne();
  const renumber = () => ctx.renumber();
  const normalizeStructure = () => ctx.normalizeStructure();
  const duplicateBlock = (block: HTMLElement) => ctx.duplicateBlock(block);
  const moveBlockDir = (block: HTMLElement, dir: number) => ctx.moveBlockDir(block, dir);
  const openSlashMenu = (block: HTMLElement, typed: boolean) => ctx.openSlashMenu(block, typed);
  const closeSlashMenu = () => ctx.closeSlashMenu();
  const applySlash = (item: any) => ctx.applySlash(item);
  const paintSlash = () => ctx.paintSlash();
  const syncSlashQuery = () => ctx.syncSlashQuery();
  const closeMention = () => ctx.closeMention();
  const paintMention = () => ctx.paintMention();
  const applyMention = (it: any) => ctx.applyMention(it);
  const syncMention = (target: HTMLElement) => ctx.syncMention(target);
  const toggleWrap = (tag: string) => ctx.toggleWrap(tag);
  const histUndo = () => ctx.histUndo();
  const histRedo = () => ctx.histRedo();
  const histFlushTyping = () => ctx.histFlushTyping();

  // ════════ 키 입력 ════════
  root.addEventListener('compositionstart', () => { st.composing = true; }, true);
  root.addEventListener('compositionend', () => { st.composing = false; setTimeout(syncSlashQuery, 0); }, true);

  root.addEventListener('keydown', (e: any) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      if (opts.onSaveShortcut) { e.preventDefault(); opts.onSaveShortcut(); }
      return;
    }
    const target = e.target as HTMLElement;
    if (target.classList && (target.classList.contains('be-raw-ta') || target.classList.contains('be-code-lang'))) return;

    // #657z 실행취소 — 에디터가 소유(⌘Z 취소 / ⌘⇧Z·Ctrl+Y 재실행). 네이티브 undo 는 구조 변경을 모른다.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (st.composing || e.isComposing || e.keyCode === 229) return;
      if (e.shiftKey) histRedo(); else histUndo();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      if (st.composing || e.isComposing || e.keyCode === 229) return;
      histRedo();
      return;
    }
    // 구조 키 직전 — 진행 중 타이핑 버스트를 별도 undo 스텝으로 확정(타이핑↔Enter 분할이 한 스텝으로 뭉치지 않게).
    if (!e.isComposing && e.keyCode !== 229 && (e.key === 'Enter' || e.key === 'Tab' || e.metaKey || e.ctrlKey)) histFlushTyping();

    // ── 블록 범위(크로스 블록 선택)가 잡혀 있으면 그 범위에 대한 동작이 먼저다. 아래 blockOf 가드보다 앞에 둔다
    //    — 범위 선택 중에는 포커스가 특정 .be-text 에 없을 수 있어 거기서 걸러지면 키가 통째로 죽는다.
    if (ctx.bselActive()) {
      if (e.key === 'Escape') { e.preventDefault(); const last = ctx.bselEdge(true); ctx.bselClear(); if (last) focusBlock(last, false); return; }
      if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter') { e.preventDefault(); ctx.bselDelete(); return; }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); ctx.bselAll(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;      // 복사·잘라내기·붙여넣기·⌘Z 는 각자 경로가 처리
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); const f = ctx.bselEdge(false); ctx.bselClear(); if (f) focusBlock(f, true); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); const l = ctx.bselEdge(true); ctx.bselClear(); if (l) focusBlock(l, false); return; }
      // IME 조합 시작 — 막지 않고 자리만 비워 준다(빈 문단으로 대체된 뒤 거기서 조합이 이어진다).
      if (e.keyCode === 229 || e.key === 'Process') { ctx.bselDelete(); return; }
      if (e.key.length === 1) {                            // 그 밖의 문자 = 선택 대체
        e.preventDefault();
        const nb = ctx.bselDelete();
        const t = nb && textElOf(nb);
        if (t) { t.textContent = e.key; placeCaret(t, false); markDirtyType(); }
        return;
      }
      return;
    }
    // ⌘A — 1차는 이 블록 전체(브라우저 기본), 이미 전체거나 빈 블록이면 2차로 **문서 전체를 블록 선택**.
    //  블록마다 편집 호스트가 달라 브라우저는 여기까지밖에 못 한다 — 그 위를 우리가 잇는다.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'a' || e.key === 'A')) {
      const t = target.classList && target.classList.contains('be-text') ? target : null;
      const len = t ? (t.textContent || '').length : 0;
      const s = window.getSelection();
      const already = !!t && len > 0 && !!s && String(s).length >= len;
      if (!t || len === 0 || already) { e.preventDefault(); ctx.bselAll(); return; }
      return;
    }

    const block = blockOf(target);
    if (!block) return;

    // 블록 단축(#657n) — ⌘D 복제 · ⌘⇧↑/↓ 이동(노션 동일).
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      duplicateBlock(block);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveBlockDir(block, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }

    // [[ 멘션 메뉴 열림 — 방향키/Enter/Esc 는 메뉴가 소비(#657t).
    if (st.mention) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = st.mention.items ? st.mention.items.length : 0;
        if (n) { st.mention.sel = (st.mention.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; paintMention(); }
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !st.composing && e.keyCode !== 229) {
        e.preventDefault();
        const it = st.mention.items && st.mention.items[st.mention.sel];
        if (it) applyMention(it); else closeMention();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); closeMention(); return; }
    }

    // 슬래시 메뉴 열림 — 방향키/Enter/Esc 는 메뉴가 소비.
    if (st.slash) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = st.slash.items ? st.slash.items.length : 0;
        if (n) { st.slash.sel = (st.slash.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; paintSlash(); }
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !st.composing && e.keyCode !== 229) {
        e.preventDefault();
        const it = st.slash.items && st.slash.items[st.slash.sel];
        if (it) applySlash(it); else closeSlashMenu();
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); closeSlashMenu(); return; }
    }

    const type = block.dataset.type!;
    const t = textElOf(block);

    // 구분선/raw/카드/컬렉션 래퍼에 포커스가 있을 때 — Backspace/Enter.
    const wrapType = type === 'divider' || type === 'raw' || type === 'pagecard' || type === 'collection';
    if (!target.classList.contains('be-text')) {
      if ((e.key === 'Backspace' || e.key === 'Delete') && wrapType) {
        e.preventDefault();
        const pb = prevTextBlock(block);
        block.remove(); normalizeStructure(); markDirty();
        if (pb && pb.isConnected) focusBlock(pb, false);
        return;
      }
      if (e.key === 'Enter' && wrapType) {
        e.preventDefault();
        focusBlock(insertBlockAfter(block, { type: 'p', text: '' }));
        return;
      }
      return;
    }
    if (!t) return;

    // '/' — 슬래시 메뉴. 임의 위치에서 열림(단어 중간·끝 포함) — 쿼리에 공백 들어오면 syncSlashQuery 가 자동으로 닫는다.
    if (e.key === '/' && !st.composing && !st.slash) {
      setTimeout(() => {   // 기본 입력('/')이 DOM 에 들어간 뒤 앵커 기록
        const rr = caretRange();
        if (!rr) return;
        openSlashMenu(block, true);
        if (st.slash) { st.slash.anchorNode = rr.startContainer; st.slash.anchorOffset = rr.startOffset; }
      }, 0);
      return;
    }

    if (e.isComposing || e.keyCode === 229) return;   // IME 조합 중 — 구조 조작 금지(#505)

    // 코드 블록 — Enter=개행, Tab=스페이스2, 그 외 기본.
    if (type === 'code' && target.classList.contains('be-code')) {
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); insertText('\n'); markDirtyType(); return; }
      if (e.key === 'Tab') { e.preventDefault(); insertText('  '); markDirtyType(); return; }
      if (e.key === 'Backspace' && caretAtStart(t) && !t.textContent) {
        e.preventDefault(); convertBlock(block, { type: 'p', text: '' }); return;
      }
      return;
    }

    // 서식 단축키(⌘E 코드 / ⌘⇧H 하이라이트) — B/I/U 는 브라우저 기본(execCommand 동형 결과).
    if ((e.metaKey || e.ctrlKey) && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); toggleWrap('code'); markDirty(); return; }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); toggleWrap('mark'); markDirty(); return; }

    if (e.key === 'Enter') {
      if (e.shiftKey) { e.preventDefault(); document.execCommand('insertLineBreak'); markDirtyType(); return; }
      e.preventDefault();
      const plain = t.textContent || '';
      // 토글 요약에서 Enter — 열려 있으면 첫 자식으로(노션 동일), 접혀 있으면 아래 새 문단.
      if (type === 'toggle') {
        const kids = block.querySelector(':scope > .be-main > .be-toggle > .be-togglekids') as HTMLElement;
        if (block.dataset.open === '1' && kids) {
          let first = Array.from(kids.children).find((n: any) => n.classList && n.classList.contains('be-block')) as HTMLElement;
          if (!first) { first = makeBlock({ type: 'p', text: '' }); kids.append(first); }
          focusBlock(first, true);
        } else {
          focusBlock(insertBlockAfter(block, { type: 'p', text: '' }));
        }
        markDirty();
        return;
      }
      // 빈 리스트 항목 → 문단으로(들여쓰기 있으면 한 단 내어쓰기) — 노션 동일.
      if (LISTY.has(type) && !plain) {
        const ind = Number(block.dataset.indent) || 0;
        if (ind > 0) { block.dataset.indent = String(ind - 1); renumber(); markDirty(); }
        else convertBlock(block, { type: 'p', text: '' });
        return;
      }
      // 인용/콜아웃 — 마지막 빈 줄에서 Enter = 블록 탈출, 그 외 = 줄바꿈.
      if (type === 'quote' || type === 'callout') {
        if (caretAtEnd(t) && (plain === '' || /\n$/.test(inlineDomToMd(t)) || t.lastChild && (t.lastChild as any).tagName === 'BR')) {
          if (t.lastChild && (t.lastChild as any).tagName === 'BR') t.removeChild(t.lastChild);
          focusBlock(insertBlockAfter(block, { type: 'p', text: '' }));
        } else { document.execCommand('insertLineBreak'); }
        markDirty();
        return;
      }
      // 분할 — 캐럿 뒤 내용을 새 블록으로. 리스트는 같은 유형 지속, 제목 뒤엔 문단.
      const tail = extractAfterCaret(t);
      const nType = LISTY.has(type) ? type : 'p';
      const nb = insertBlockAfter(block, {
        type: nType,
        indent: Number(block.dataset.indent) || 0,
        checked: false,
        text: '',
      });
      const nt = textElOf(nb)!;
      nt.replaceChildren(tail);
      // 앞뒤 잔여 <br> 정리(분할 지점이 줄 경계였을 때).
      if (t.lastChild && (t.lastChild as any).tagName === 'BR') t.removeChild(t.lastChild);
      if (nt.firstChild && (nt.firstChild as any).tagName === 'BR') nt.removeChild(nt.firstChild);
      renumber();
      markDirty();
      focusBlock(nb, true);
      return;
    }

    if (e.key === 'Backspace') {
      const r = caretRange();
      if (r && !r.collapsed) return;   // 범위 삭제는 기본
      if (!caretAtStart(t)) return;
      e.preventDefault();
      if (LISTY.has(type)) {
        const ind = Number(block.dataset.indent) || 0;
        if (ind > 0) { block.dataset.indent = String(ind - 1); renumber(); markDirty(); return; }
        convertBlock(block, { type: 'p' });
        const nb = blockOf(window.getSelection()!.anchorNode);
        if (nb) focusBlock(nb, true);
        return;
      }
      if (type === 'h' || type === 'quote' || type === 'callout' || type === 'toggle') {
        // 토글은 convertBlock 이 자식을 밖으로 펼쳐 보존한다(#657n).
        const nb = convertBlock(block, { type: 'p' });
        focusBlock(nb, true);
        return;
      }
      // 문단 — 이전 블록과 병합. 토글 첫 자식이면 요약으로 캐럿 이동(컨테이너 경계).
      const prev = prevTextBlock(block);
      if (!prev) {
        const kidsWrap = block.parentElement;
        if (kidsWrap && kidsWrap.classList.contains('be-togglekids')) {
          const tb = blockOf(kidsWrap);
          const sum = tb && tb.querySelector('.be-togglesum') as HTMLElement;
          if (sum) { sum.focus(); placeCaret(sum, false); }
        }
        return;
      }
      const ptype = prev.dataset.type!;
      if (ptype === 'divider') { prev.remove(); ensureOne(); renumber(); markDirty(); return; }
      if (ptype === 'raw' || ptype === 'code') { focusBlock(prev, false); return; }
      const pt = textElOf(prev);
      if (!pt) return;
      const hadContent = !!t.childNodes.length;
      placeCaretJunctionMerge(pt, t);
      block.remove();
      ensureOne();
      renumber();
      markDirty();
      if (!hadContent) placeCaret(pt, false);
      return;
    }

    if (e.key === 'Delete') {
      const r = caretRange();
      if (r && !r.collapsed) return;
      if (!caretAtEnd(t)) return;
      const next = nextTextBlock(block);
      if (!next) return;
      const ntype = next.dataset.type!;
      if (ntype === 'divider') { e.preventDefault(); next.remove(); ensureOne(); renumber(); markDirty(); return; }
      const nt = textElOf(next);
      if (!nt) return;
      e.preventDefault();
      placeCaretJunctionMerge(t, nt);
      next.remove();
      ensureOne();
      renumber();
      markDirty();
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      if (LISTY.has(type)) {
        const ind = Number(block.dataset.indent) || 0;
        block.dataset.indent = String(Math.max(0, Math.min(4, ind + (e.shiftKey ? -1 : 1))));
        renumber();
        markDirty();
      }
      return;
    }

    // 블록 경계 화살표 이동.
    if (e.key === 'ArrowUp' && caretAtStart(t)) {
      const prev = prevTextBlock(block);
      if (prev) { e.preventDefault(); focusBlock(prev, false); }
      return;
    }
    if (e.key === 'ArrowDown' && caretAtEnd(t)) {
      const next = nextTextBlock(block);
      if (next) { e.preventDefault(); focusBlock(next, true); }
      return;
    }
    if (e.key === 'ArrowLeft' && caretAtStart(t)) {
      const prev = prevTextBlock(block);
      if (prev && textElOf(prev)) { e.preventDefault(); focusBlock(prev, false); }
      return;
    }
    if (e.key === 'ArrowRight' && caretAtEnd(t)) {
      const next = nextTextBlock(block);
      if (next && textElOf(next)) { e.preventDefault(); focusBlock(next, true); }
      return;
    }
  });

  // ── input: 마크다운 단축 변환 + 인라인 페어 변환 + 슬래시 쿼리 + dirty ──
  root.addEventListener('input', (e: any) => {
    const target = e.target as HTMLElement;
    if (target.classList && (target.classList.contains('be-raw-ta') || target.classList.contains('be-code-lang'))) { markDirtyType(); return; }
    markDirtyType();
    //  #764 단어 단위 실행취소 — 공백·구두점 입력 시 직전 타이핑 버스트를 히스토리 1스텝으로 확정(노션 감각).
    //  IME 조합 중엔 건너뛴다(조합 종료 후의 공백만 경계로).
    if (!st.composing && !e.isComposing && e.inputType === 'insertText' && e.data && /[\s.,;:!?)\]}"'、。]/.test(e.data)) histFlushTyping();
    if (st.slash) { syncSlashQuery(); return; }
    if (target.classList.contains('be-text') && !target.classList.contains('be-code')) syncMention(target);   // [[ 멘션(조합 중 갱신 허용)
    if (st.composing || e.isComposing) return;
    const block = blockOf(target);
    if (!block || !target.classList.contains('be-text') || target.classList.contains('be-code')) return;
    const type = block.dataset.type!;
    const txt = target.textContent || '';

    // 블록 단축(내용이 프리픽스뿐일 때) — p 에서 변환, 리스트에선 '[] '로 할일 전환.
    if (type === 'p') {
      let m;
      if ((m = /^(#{1,6})\s$/.exec(txt))) { convertBlock(block, { type: 'h', level: m[1].length, text: '' }); return; }
      if (/^([-*+])\s$/.test(txt)) { convertBlock(block, { type: 'bullet', indent: 0, text: '' }); return; }
      if (/^(\d+)[.)]\s$/.test(txt)) { convertBlock(block, { type: 'numbered', indent: 0, text: '' }); return; }
      if (/^\[( |x)?\]\s$/.test(txt)) { convertBlock(block, { type: 'todo', indent: 0, checked: /x/.test(txt), text: '' }); return; }
      if (/^>\s$/.test(txt)) { toToggleBlock(block, ''); return; }        // 노션: > = 토글
      if (/^"\s$/.test(txt)) { convertBlock(block, { type: 'quote', text: '' }); return; }  // 노션: " = 인용
      if (txt === '```') { convertBlock(block, { type: 'code', lang: '', text: '' }); return; }
      if (txt === '---') {
        const nb = convertBlock(block, { type: 'divider', text: undefined });
        focusBlock(insertBlockAfter(nb, { type: 'p', text: '' }));
        return;
      }
    } else if (type === 'bullet' && /^\[( |x)?\]\s$/.test(txt)) {
      convertBlock(block, { type: 'todo', indent: Number(block.dataset.indent) || 0, checked: /x/.test(txt), text: '' });
      return;
    }

    // 인라인 페어 변환 — 캐럿 앞이 **…**·`…`·~~…~~·==…==·++…++·*…* 로 끝나면 실서식으로.
    inlinePairConvert(target);
  });

  function inlinePairConvert(t: HTMLElement) {
    const r = caretRange();
    if (!r || !r.collapsed || r.startContainer.nodeType !== 3) return;
    const node: any = r.startContainer;
    if (node.parentElement && node.parentElement.closest('code, a')) return;   // 코드/링크 안은 원문 유지
    const upto = (node.textContent || '').slice(0, r.startOffset);
    // lead=true → 그룹1은 선행 경계문자(치환 대상 아님), inner=그룹2. 노션 인라인 서식 페어 전부.
    const rules: Array<[RegExp, string, boolean]> = [
      [/\*\*([^*\n]+)\*\*$/, 'strong', false],
      [/`([^`\n]+)`$/, 'code', false],
      [/~~([^~\n]+)~~$/, 'del', false],
      [/==([^=\n]+)==$/, 'mark', false],
      [/\+\+([^+\n]+)\+\+$/, 'u', false],
      [/(^|[^~])~([^~\s\n](?:[^~\n]*[^~\s\n])?)~$/, 'del', true],   // 노션: 단일 ~ 취소선(~~ 규칙 뒤에 둬 이중이 우선)
      [/(^|[\s(가-힣])\*([^*\s\n](?:[^*\n]*[^*\s\n])?)\*$/, 'em', true],
    ];
    for (const [re, tag, lead] of rules) {
      const m = re.exec(upto);
      if (!m) continue;
      const inner = lead ? m[2] : m[1];
      const mdLen = (lead ? m[0].length - (m[1] ? m[1].length : 0) : m[0].length);
      const from = r.startOffset - mdLen;
      const wrap = el(tag === 'code' ? 'code' : tag, tag === 'code' ? { class: 'md-code' } : (tag === 'mark' ? { class: 'md-mark' } : {}), inner);
      const after = node.splitText(r.startOffset);
      node.textContent = (node.textContent || '').slice(0, from);
      node.parentNode.insertBefore(wrap, after);
      // 캐럿 패딩 — 마크 바로 뒤 빈 경계는 브라우저가 이어지는 타이핑을 마크 '안'으로 넣는다(볼드 지속).
      //  ZWSP 텍스트 노드를 끼우고 그 뒤에 캐럿 → 다음 타이핑이 마크 밖 평문. 직렬화(escInline)가 ZWSP 제거.
      const pad = document.createTextNode('\u200B');
      node.parentNode.insertBefore(pad, after);
      const s = window.getSelection()!;
      const nr = document.createRange();
      nr.setStart(pad, 1);
      nr.collapse(true);
      s.removeAllRanges();
      s.addRange(nr);
      markDirty();
      return;
    }
  }

  // 병합 — front 끝에 back 의 자식들을 옮기고 캐럿을 접합점(자식 인덱스 경계)에.
  function placeCaretJunctionMerge(front: HTMLElement, back: HTMLElement) {
    front.focus();
    const idx = front.childNodes.length;
    while (back.firstChild) front.appendChild(back.firstChild);
    const s = window.getSelection()!;
    const nr = document.createRange();
    nr.setStart(front, Math.min(idx, front.childNodes.length));
    nr.collapse(true);
    s.removeAllRanges();
    s.addRange(nr);
  }
}
