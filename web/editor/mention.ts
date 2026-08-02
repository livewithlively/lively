// editor/mention.ts — '[[' 페이지 멘션(#1313 R58 — block-editor.ts '페이지 멘션' 절 verbatim 적출).
import { api, el, toast } from '../core.js';
import { caretRange } from './caret.js';
import type { EditorCtx } from './context.js';

export function createMention(ctx: EditorCtx) {
  const { st } = ctx;
  // 늦은 바인딩 별칭(context.ts 참조).
  const blockOf = (node: any) => ctx.blockOf(node);
  const markDirty = () => ctx.markDirty();

  // ════════ [[ 페이지 멘션 — 노션 @링크/옵시디언 [[]] 동형(#657t). 다른 지식으로의 인라인 링크. ════════
  //  타이핑 중 '[[' 감지 → 지식 검색 메뉴 → 선택 시 '[[쿼리' 를 <a href="#/k/이름">제목</a> 로 치환.
  //  직렬화는 기존 A 브랜치([제목](#/k/이름)) — renderInline 의 내부 앵커(safeHref '#')와 왕복 호환.
  // 열린 멘션 세션은 ctx.st.mention — { block, node, from(''[[' 시작 오프셋), query, menu, items, sel, timer }
  function closeMention() {
    if (!st.mention) return;
    clearTimeout(st.mention.timer);
    st.mention.menu.remove();
    st.mention = null;
  }
  function paintMention() {
    if (!st.mention) return;
    const items = st.mention.items || [];
    if (st.mention.sel >= items.length) st.mention.sel = Math.max(0, items.length - 1);
    st.mention.menu.replaceChildren(
      el('div', { class: 'be-slash-head', text: '페이지 링크' }),
      ...(!items.length ? [el('div', { class: 'be-slash-empty', text: st.mention.query ? '결과 없음' : '검색어를 입력하세요' })]
        : items.map((it: any, idx: number) => {
          const row = el('button', { class: 'be-slash-item' + (idx === st.mention.sel ? ' on' : ''), type: 'button' },
            el('span', { class: 'be-slash-ic', text: it.icon || '📄' }),
            el('span', { class: 'be-slash-label', text: it.title || it.name }));
          row.addEventListener('mousedown', (e) => e.preventDefault());
          row.onclick = () => applyMention(it);
          return row;
        })));
    const r = caretRange();
    let rect: DOMRect = r ? r.getBoundingClientRect() : st.mention.block.getBoundingClientRect();
    if (!rect.width && !rect.height && !rect.top) rect = st.mention.block.getBoundingClientRect();
    const h = Math.min(st.mention.menu.scrollHeight || 280, 280);
    st.mention.menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 320)) + 'px';
    st.mention.menu.style.top = (rect.bottom + 6 + h > window.innerHeight ? Math.max(8, rect.top - h - 6) : rect.bottom + 6) + 'px';
  }
  function scheduleMentionSearch() {
    if (!st.mention) return;
    clearTimeout(st.mention.timer);
    st.mention.timer = setTimeout(async () => {
      if (!st.mention) return;
      const q = st.mention.query.trim();
      try {
        const url = q
          ? '/api/ui/knowledge/search?' + new URLSearchParams({ q, limit: '8', mode: 'names', injection: 'recalled' })
          : '/api/ui/knowledge?' + new URLSearchParams({ limit: '8', orderBy: 'updated_at', injection: 'recalled' });
        const r = await api(url);
        if (!st.mention) return;
        st.mention.items = ((r && r.entries) || []).filter((e: any) => !String(e.name || '').startsWith('category-home-'));
        st.mention.sel = 0;
        paintMention();
      } catch (_) { /* 검색 실패 — 이전 결과 유지 */ }
    }, 250);
  }
  // input 마다 — 캐럿 앞 '[[쿼리' 프로브. 없으면 닫기, 있으면 열기/갱신.
  function syncMention(target: HTMLElement) {
    const r = caretRange();
    if (!r || !r.collapsed || r.startContainer.nodeType !== 3) { closeMention(); return; }
    const node: any = r.startContainer;
    const upto = (node.textContent || '').slice(0, r.startOffset);
    const m = /\[\[([^\[\]\n]{0,40})$/.exec(upto);
    if (!m) { closeMention(); return; }
    const block = blockOf(target);
    if (!block) { closeMention(); return; }
    if (!st.mention) {
      const menu = el('div', { class: 'be-slash be-mention', role: 'menu' });
      document.body.append(menu);
      st.mention = { block, node, menu, items: [], sel: 0, query: '', timer: null };
    }
    st.mention.block = block;
    st.mention.node = node;
    st.mention.from = r.startOffset - m[1].length - 2;   // '[[' 시작
    if (st.mention.query !== m[1] || !st.mention.items.length) { st.mention.query = m[1]; scheduleMentionSearch(); }
    paintMention();
  }
  // 선택 — '[[쿼리' 삭제 후 <a> + ZWSP 삽입(마크 지속 차단 패딩과 동일 수법).
  function applyMention(it: any) {
    const m = st.mention;
    closeMention();
    if (!m) return;
    try {
      const node = m.node;
      const r = caretRange();
      const to = r && r.startContainer === node ? r.startOffset : (m.from + 2 + m.query.length);
      node.textContent = node.textContent.slice(0, m.from) + node.textContent.slice(to);
      const a = el('a', { class: 'md-link', href: '#/k/' + encodeURIComponent(it.name), text: it.title || it.name });
      const after = node.splitText(Math.min(m.from, node.textContent.length));
      node.parentNode.insertBefore(a, after);
      const pad = document.createTextNode('\u200B');
      node.parentNode.insertBefore(pad, after);
      const s = window.getSelection()!;
      const nr = document.createRange();
      nr.setStart(pad, 1);
      nr.collapse(true);
      s.removeAllRanges();
      s.addRange(nr);
      markDirty();
    } catch (_) { toast('링크 삽입 실패 — 다시 시도해 주세요', true); }
  }

  return { closeMention, paintMention, applyMention, syncMention };
}
