// editor/history.ts — #657z 실행취소 히스토리(#1313 R58 — block-editor.ts 히스토리 절 verbatim 적출).
//  스택은 '마크다운 스냅샷'이다 — parse↔serialize 왕복이 무손실이라는 계약 위에 서 있고,
//  그 계약은 scripts/block-editor-roundtrip.test.mjs 가 고정한다(깨지면 ⌘Z 한 번에 문서가 뒤틀린다).
import { mdToBlocks } from './parse.js';
import { blocksToMd } from './serialize.js';
import { placeCaret } from './caret.js';
import type { EditorCtx } from './context.js';

export function createHistory(ctx: EditorCtx) {
  const { root, opts, st } = ctx;
  // 늦은 바인딩 별칭(context.ts 참조).
  const blockEls = () => ctx.blockEls();
  const blockData = (block: HTMLElement) => ctx.blockData(block);
  const blockOf = (node: any) => ctx.blockOf(node);
  const textElOf = (block: HTMLElement) => ctx.textElOf(block);
  const makeBlock = (d: any) => ctx.makeBlock(d);
  const focusBlock = (block: HTMLElement, atStart?: boolean) => ctx.focusBlock(block, atStart);
  const ensureOne = () => ctx.ensureOne();
  const renumber = () => ctx.renumber();
  const closeSlashMenu = () => ctx.closeSlashMenu();
  const closeMention = () => ctx.closeMention();

  // ════════ #657z 실행취소 히스토리 ════════
  // 마크다운 스냅샷 스택 — 네이티브 undo 가 모르는 구조 변경(드래그·전환·삭제·컬럼·컬렉션 설정…)까지
  //  ⌘Z/⌘⇧Z(Ctrl+Y) 한 계층으로 되돌린다. 라운드트립이 무손실이라 스냅샷 = 마크다운으로 충분.
  //  · 구조 변경: markDirty → snapSoon(setTimeout 0) — 복합 연산도 동기 프레임 끝 상태 1장 = 1스텝.
  //  · 타이핑: markDirtyType → snapLater(600ms) — 버스트 단위 1스텝. 구조 키(Enter/Tab/⌘조합) 직전
  //    histFlushTyping 으로 버스트를 확정해 "타이핑 → Enter 분할"이 두 스텝으로 남는다(노션 동일 감각).
  //  raw 블록 textarea 내부는 네이티브 undo(stopPropagation), 커밋 시점만 스택에 잡힌다.
  const HIST_MAX = 100;
  const hist: { md: string; focus: { idx: number; off: number } | null }[] = [];
  let histPos = -1;
  let histTimerT: any = null;   // 타이핑 디바운스
  let histTimerS: any = null;   // 구조 코얼레싱
  const editorMd = () => blocksToMd(blockEls().map(blockData));

  function captureFocus(): { idx: number; off: number } | null {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return null;
    const r = s.getRangeAt(0);
    const sc: any = r.startContainer;
    const eln: HTMLElement | null = sc.nodeType === 3 ? sc.parentElement : sc;
    const t = eln && eln.closest ? (eln.closest('.be-text') as HTMLElement) : null;
    if (!t || !root.contains(t)) return null;
    const b = blockOf(t);
    if (!b) return null;
    const idx = Array.from(root.querySelectorAll('.be-block')).indexOf(b);
    if (idx < 0) return null;
    const pre = document.createRange();
    pre.selectNodeContents(t);
    try { pre.setEnd(r.startContainer, r.startOffset); } catch { return { idx, off: 0 }; }
    return { idx, off: pre.toString().length };
  }
  function restoreFocus(f: { idx: number; off: number } | null) {
    const bs = Array.from(root.querySelectorAll('.be-block')) as HTMLElement[];
    if (!bs.length) return;
    const b = bs[Math.max(0, Math.min(f ? f.idx : bs.length - 1, bs.length - 1))];
    const t = textElOf(b);
    if (!t) { focusBlock(b, false); return; }
    t.focus();
    let remain = f ? f.off : (t.textContent || '').length;
    const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
    let n: any = w.nextNode();
    while (n) {
      const len = (n.textContent || '').length;
      if (remain <= len) {
        const nr = document.createRange();
        nr.setStart(n, remain);
        nr.collapse(true);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(nr);
        return;
      }
      remain -= len;
      n = w.nextNode();
    }
    placeCaret(t, false);
  }

  function snapNow() {
    if (st.histLock) return;
    if (st.composing) { snapLater(); return; }   // IME 조합 중 상태는 담지 않는다 — 종료 후로 미룸
    clearTimeout(histTimerT); histTimerT = null;
    clearTimeout(histTimerS); histTimerS = null;
    const md = editorMd();
    if (histPos >= 0 && hist[histPos].md === md) return;
    hist.length = histPos + 1;                // redo 꼬리 절단
    hist.push({ md, focus: captureFocus() });
    if (hist.length > HIST_MAX) hist.shift();
    histPos = hist.length - 1;
  }
  function snapSoon() { if (st.histLock || histTimerS) return; histTimerS = setTimeout(() => { histTimerS = null; snapNow(); }, 0); }
  function snapLater() { if (st.histLock) return; clearTimeout(histTimerT); histTimerT = setTimeout(() => { histTimerT = null; snapNow(); }, 600); }
  function histFlushTyping() { if (histTimerT && !st.composing) snapNow(); }
  function resetHistory() {
    clearTimeout(histTimerT); histTimerT = null;
    clearTimeout(histTimerS); histTimerS = null;
    hist.length = 0;
    hist.push({ md: editorMd(), focus: null });
    histPos = 0;
  }
  function applyHistory(pos: number) {
    if (pos < 0 || pos >= hist.length) return;
    const h = hist[pos];
    st.histLock = true;
    try {
      closeSlashMenu();
      closeMention();
      //  #764 부분 패치 — 블록 개수가 같으면 '달라진 블록만' 교체해 나머지 DOM·캐럿·스크롤을 보존한다.
      //  (전체 replaceChildren 은 매 undo 마다 문서 전체를 다시 그려 깜빡임·캐럿튐을 유발) 구조 변경(개수 상이)은 안전하게 전체 재구성.
      const target = mdToBlocks(h.md);
      const cur = blockEls();
      if (target.length > 0 && cur.length === target.length) {
        for (let k = 0; k < target.length; k++) {
          const tMd = blocksToMd([target[k]]);
          const cMd = blocksToMd([blockData(cur[k])]);
          if (cMd !== tMd) cur[k].replaceWith(makeBlock(target[k]));
        }
      } else {
        root.replaceChildren(...target.map(makeBlock));
      }
      ensureOne();
      renumber();
    } finally { st.histLock = false; }
    histPos = pos;
    try { restoreFocus(h.focus); } catch { /* 캐럿 복원은 최선노력 */ }
    st.dirty = true;                             // 되돌린 상태도 자동저장 대상
    if (opts.onChange) opts.onChange();
  }
  function histUndo() { histFlushTyping(); if (histPos > 0) applyHistory(histPos - 1); }
  function histRedo() { if (histPos < hist.length - 1) applyHistory(histPos + 1); }

  // 스택 길이·타이머 해제는 createBlockEditor 의 setMarkdown/destroy 가 쓴다(내부 상태는 이 모듈이 계속 소유).
  const histLen = () => hist.length;
  const clearHistoryTimers = () => { clearTimeout(histTimerT); clearTimeout(histTimerS); };

  return { snapNow, snapSoon, snapLater, histFlushTyping, resetHistory, histUndo, histRedo, histLen, clearHistoryTimers };
}
