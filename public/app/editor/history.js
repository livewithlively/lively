// editor/history.ts — #657z 실행취소 히스토리(#1313 R58 — block-editor.ts 히스토리 절 verbatim 적출).
//  스택은 '마크다운 스냅샷'이다 — parse↔serialize 왕복이 무손실이라는 계약 위에 서 있고,
//  그 계약은 scripts/block-editor-roundtrip.test.mjs 가 고정한다(깨지면 ⌘Z 한 번에 문서가 뒤틀린다).
import { mdToBlocks } from './parse.js';
import { blocksToMd } from './serialize.js';
import { placeCaret } from './caret.js';
export function createHistory(ctx) {
    const { root, opts, st } = ctx;
    // 늦은 바인딩 별칭(context.ts 참조).
    const blockEls = () => ctx.blockEls();
    const blockData = (block) => ctx.blockData(block);
    const blockOf = (node) => ctx.blockOf(node);
    const textElOf = (block) => ctx.textElOf(block);
    const makeBlock = (d) => ctx.makeBlock(d);
    const focusBlock = (block, atStart) => ctx.focusBlock(block, atStart);
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
    const hist = [];
    let histPos = -1;
    let histTimerT = null; // 타이핑 디바운스
    let histTimerS = null; // 구조 코얼레싱
    const editorMd = () => blocksToMd(blockEls().map(blockData));
    function captureFocus() {
        const s = window.getSelection();
        if (!s || !s.rangeCount)
            return null;
        const r = s.getRangeAt(0);
        const sc = r.startContainer;
        const eln = sc.nodeType === 3 ? sc.parentElement : sc;
        const t = eln && eln.closest ? eln.closest('.be-text') : null;
        if (!t || !root.contains(t))
            return null;
        const b = blockOf(t);
        if (!b)
            return null;
        const idx = Array.from(root.querySelectorAll('.be-block')).indexOf(b);
        if (idx < 0)
            return null;
        const pre = document.createRange();
        pre.selectNodeContents(t);
        try {
            pre.setEnd(r.startContainer, r.startOffset);
        }
        catch {
            return { idx, off: 0 };
        }
        return { idx, off: pre.toString().length };
    }
    //  ⚠ f=null 이면 **캐럿을 건드리지 않는다**(#1685). 예전엔 '마지막 블록 끝'으로 보냈는데, 문서를 열 때 만드는
    //   첫 스냅샷은 focus 가 늘 null 이라(resetHistory) 첫 ⌘Z 마다 캐럿이 문서 맨 아래로 튀었다.
    //   어디였는지 모를 땐 호출자(applyHistory)가 더 나은 후보를 고른다.
    function restoreFocus(f) {
        if (!f)
            return;
        const bs = Array.from(root.querySelectorAll('.be-block'));
        if (!bs.length)
            return;
        const b = bs[Math.max(0, Math.min(f.idx, bs.length - 1))];
        const t = textElOf(b);
        if (!t) {
            focusBlock(b, false);
            return;
        }
        t.focus();
        let remain = f.off;
        const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
        let n = w.nextNode();
        while (n) {
            const len = (n.textContent || '').length;
            if (remain <= len) {
                const nr = document.createRange();
                nr.setStart(n, remain);
                nr.collapse(true);
                const sel = window.getSelection();
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
        if (st.histLock)
            return;
        if (st.composing) {
            snapLater();
            return;
        } // IME 조합 중 상태는 담지 않는다 — 종료 후로 미룸
        clearTimeout(histTimerT);
        histTimerT = null;
        clearTimeout(histTimerS);
        histTimerS = null;
        const md = editorMd();
        if (histPos >= 0 && hist[histPos].md === md)
            return;
        hist.length = histPos + 1; // redo 꼬리 절단
        hist.push({ md, focus: captureFocus() });
        if (hist.length > HIST_MAX)
            hist.shift();
        histPos = hist.length - 1;
    }
    function snapSoon() { if (st.histLock || histTimerS)
        return; histTimerS = setTimeout(() => { histTimerS = null; snapNow(); }, 0); }
    function snapLater() { if (st.histLock)
        return; clearTimeout(histTimerT); histTimerT = setTimeout(() => { histTimerT = null; snapNow(); }, 600); }
    function histFlushTyping() { if (histTimerT && !st.composing)
        snapNow(); }
    function resetHistory() {
        clearTimeout(histTimerT);
        histTimerT = null;
        clearTimeout(histTimerS);
        histTimerS = null;
        hist.length = 0;
        hist.push({ md: editorMd(), focus: null });
        histPos = 0;
    }
    function applyHistory(pos) {
        if (pos < 0 || pos >= hist.length)
            return;
        const h = hist[pos];
        const before = captureFocus(); // ⌘Z 직전 캐럿 — 최후 폴백(그 자리에 그대로 두기)
        let changedEl = null; // 이번 되돌림으로 실제 달라진 첫 블록(캐럿의 1순위 기준점)
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
                    if (cMd !== tMd) {
                        const nb = makeBlock(target[k]);
                        if (!changedEl)
                            changedEl = nb;
                        cur[k].replaceWith(nb);
                    }
                }
            }
            else {
                // 전체 재구성 — 앞에서부터 처음 어긋나는 자리가 '되돌려진 지점'이다(개수가 달라도 공통 접두는 비교된다).
                let diff = -1;
                const n = Math.min(cur.length, target.length);
                for (let k = 0; k < n && diff < 0; k++) {
                    if (blocksToMd([blockData(cur[k])]) !== blocksToMd([target[k]]))
                        diff = k;
                }
                if (diff < 0)
                    diff = n;
                const made = target.map(makeBlock);
                changedEl = made[Math.min(diff, made.length - 1)] || null;
                root.replaceChildren(...made);
            }
            ensureOne();
            renumber();
        }
        finally {
            st.histLock = false;
        }
        histPos = pos;
        //  캐럿 — ① 되돌려진 그 블록(스냅샷 캐럿이 같은 블록이면 오프셋까지 살려서) ② 스냅샷 캐럿 ③ ⌘Z 직전 자리.
        //  셋 다 없으면 아무것도 하지 않는다 — 모를 때 문서 끝으로 보내는 게 예전의 캐럿 튐이었다(#1685).
        try {
            let f = h.focus;
            if (changedEl && changedEl.isConnected) {
                const ci = Array.from(root.querySelectorAll('.be-block')).indexOf(changedEl);
                if (ci >= 0 && !(f && f.idx === ci)) {
                    const t = textElOf(changedEl);
                    f = { idx: ci, off: (t ? (t.textContent || '') : '').length }; // 되돌려진 블록 끝
                }
            }
            restoreFocus(f || before);
        }
        catch { /* 캐럿 복원은 최선노력 */ }
        st.dirty = true; // 되돌린 상태도 자동저장 대상
        if (opts.onChange)
            opts.onChange();
    }
    function histUndo() { histFlushTyping(); if (histPos > 0)
        applyHistory(histPos - 1); }
    function histRedo() { if (histPos < hist.length - 1)
        applyHistory(histPos + 1); }
    // 스택 길이·타이머 해제는 createBlockEditor 의 setMarkdown/destroy 가 쓴다(내부 상태는 이 모듈이 계속 소유).
    const histLen = () => hist.length;
    const clearHistoryTimers = () => { clearTimeout(histTimerT); clearTimeout(histTimerS); };
    return { snapNow, snapSoon, snapLater, histFlushTyping, resetHistory, histUndo, histRedo, histLen, clearHistoryTimers };
}
