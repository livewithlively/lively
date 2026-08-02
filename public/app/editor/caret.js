// editor/caret.ts — 캐럿/선택 헬퍼(#1313 R58 — block-editor.ts §3 verbatim 적출).
//  window.getSelection/document 전역에만 의존 — 에디터 인스턴스 상태와 무관해 모듈 스코프에 그대로 둔다.
// ════════════════════════════════════════════
// §3 캐럿/선택 헬퍼
// ════════════════════════════════════════════
function caretRange() {
    const s = window.getSelection();
    return s && s.rangeCount ? s.getRangeAt(0) : null;
}
function caretAtStart(box) {
    const r = caretRange();
    if (!r || !r.collapsed || !box.contains(r.startContainer))
        return false;
    const pre = document.createRange();
    pre.selectNodeContents(box);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length === 0;
}
function caretAtEnd(box) {
    const r = caretRange();
    if (!r || !r.collapsed || !box.contains(r.endContainer))
        return false;
    const post = document.createRange();
    post.selectNodeContents(box);
    post.setStart(r.endContainer, r.endOffset);
    return post.toString().length === 0;
}
function placeCaret(box, atStart) {
    const r = document.createRange();
    r.selectNodeContents(box);
    r.collapse(atStart);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
}
// 캐럿 이후 내용을 잘라내 반환(블록 분할용).
function extractAfterCaret(box) {
    const r = caretRange();
    const rest = document.createRange();
    rest.selectNodeContents(box);
    rest.setStart(r.endContainer, r.endOffset);
    return rest.extractContents();
}
function insertText(str) { document.execCommand('insertText', false, str); }
export { caretRange, caretAtStart, caretAtEnd, placeCaret, extractAfterCaret, insertText };
