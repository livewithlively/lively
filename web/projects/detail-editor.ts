// projects/detail-editor.ts — #1405 W2: detail-body.ts 분할 ②.
//  위지윅 편집 도구 — DOM → 마크다운 역변환(mdFromDom)과 서식 툴바.
//  순수 잎: 파일 내 어느 심볼도 참조하지 않는다(밖에서 쓰라고 있는 부품).
import { el, sv } from '../core.js';

// ── 위지위그 본문 직렬화 — contentEditable DOM → 마크다운(renderMarkdown 지원 서브셋의 역). 알 수 없는 요소는 자식만 재귀(텍스트 보존). ──
function mdFromDom(root) {
  // 인라인(텍스트 + 굵게/기울임/코드/링크/줄바꿈) → 마크다운 문자열.
  const inlineMd = (node) => {
    let out = '';
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) { out += n.textContent; return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      if (tag === 'br') { out += '\n'; return; }
      if (tag === 'code') { out += '`' + n.textContent + '`'; return; }
      if (tag === 'a') { const href = n.getAttribute('href') || ''; const lbl = inlineMd(n) || n.textContent; out += href ? '[' + lbl + '](' + href + ')' : lbl; return; }
      if (tag === 'img') { const src = n.getAttribute('src') || ''; if (src) out += '![' + (n.getAttribute('alt') || '') + '](' + src + ')'; return; } // 이미지 왕복(#541)
      if (tag === 'del' || tag === 's' || tag === 'strike') { out += '~~' + inlineMd(n) + '~~'; return; } // 취소선 왕복(#541)
      const st = (n.getAttribute && n.getAttribute('style')) || '';
      const bold = tag === 'strong' || tag === 'b' || /font-weight\s*:\s*(bold|[6-9]00)/.test(st);
      const ital = tag === 'em' || tag === 'i' || /font-style\s*:\s*italic/.test(st);
      let inner = inlineMd(n);
      if (ital) inner = '*' + inner + '*';
      if (bold) inner = '**' + inner + '**';
      out += inner;
    });
    return out;
  };
  const blocks: string[] = [];
  const walk = (node, quote) => {
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) { const t = n.textContent.replace(/\s+/g, ' ').trim(); if (t) blocks.push((quote ? '> ' : '') + t); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      const q = quote ? '> ' : '';
      if (/^h[1-6]$/.test(tag)) { const t = inlineMd(n).trim(); if (t) blocks.push(q + '#'.repeat(Number(tag[1])) + ' ' + t); return; }
      if (tag === 'p' || tag === 'div') {
        const t = inlineMd(n).replace(/\n+$/, '').trim();
        if (t) blocks.push(quote ? t.split('\n').map((l) => '> ' + l).join('\n') : t);
        return;
      }
      if (tag === 'ul' || tag === 'ol') {
        // 중첩 리스트 직렬화(#541 — ClickUp 본문 다단 불릿 무손실 왕복): li 안의 하위 ul/ol 을 2칸 들여쓰기로 재귀.
        const items: string[] = [];
        const serializeList = (listEl: any, listTag: string, depth: number) => {
          let idx = 1;
          listEl.childNodes.forEach((li: any) => {
            if (li.nodeType !== 1 || li.tagName.toLowerCase() !== 'li') return;
            const mk = listTag === 'ol' ? (idx++ + '. ') : '- ';
            // li 의 인라인 내용(하위 리스트 제외) — 하위 ul/ol 은 별도 재귀.
            const clone = li.cloneNode(true);
            clone.querySelectorAll && clone.querySelectorAll('ul, ol').forEach((s: any) => s.remove());
            // 체크박스(input) → '[ ] '/'[x] ' 접두 복원(하위 리스트 제거 후 남은 첫 input = 이 항목 것).
            let prefix = '';
            const cb = clone.querySelector && clone.querySelector('input[type=checkbox]');
            if (cb) { prefix = cb.checked ? '[x] ' : '[ ] '; cb.remove(); }
            const t = inlineMd(clone).trim();
            items.push(q + '  '.repeat(depth) + mk + prefix + t);
            li.querySelectorAll && li.querySelectorAll(':scope > ul, :scope > ol').forEach((s: any) => serializeList(s, s.tagName.toLowerCase(), depth + 1));
          });
        };
        serializeList(n, tag, 0);
        if (items.length) blocks.push(items.join('\n'));
        return;
      }
      if (tag === 'blockquote') { walk(n, true); return; }
      if (tag === 'pre') { blocks.push('```\n' + n.textContent.replace(/\n$/, '') + '\n```'); return; }
      if (tag === 'hr') { blocks.push('---'); return; }
      walk(n, quote); // 알 수 없는 래퍼 → 자식 블록 재귀
    });
  };
  walk(root, false);
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── 위지위그 서식 바 — contentEditable 용(execCommand). 선택 시 떠서 그 자리에서 굵게/기울임/제목/목록/인용/코드/링크 즉시 적용. ──
function buildWysiwygToolbar(ce) {
  const bar = el('div', { class: 'fmt-toolbar' });
  bar.hidden = true;
  try { document.execCommand('styleWithCSS', false, 'false'); } catch (_) { /* 시맨틱 태그(<b>/<i>) 우선 */ }
  const exec = (cmd, val?) => { ce.focus(); try { document.execCommand(cmd, false, val); } catch (_) { /* noop */ } setTimeout(position, 0); };
  const wrapCode = () => {
    const sel = window.getSelection(); if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0); const txt = range.toString(); if (!txt) return;
    const code = el('code', { class: 'md-code', text: txt });
    range.deleteContents(); range.insertNode(code);
    const r = document.createRange(); r.selectNodeContents(code); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
    ce.focus(); setTimeout(position, 0);
  };
  const insertLink = () => {
    const sel = window.getSelection(); const txt = sel ? sel.toString() : '';
    const url = window.prompt('링크 URL', 'https://'); if (url == null) return;
    ce.focus();
    if (txt) { try { document.execCommand('createLink', false, url); } catch (_) { /* noop */ } }
    else { try { document.execCommand('insertHTML', false, '<a href="' + url.replace(/"/g, '%22') + '">' + url + '</a>'); } catch (_) { /* noop */ } }
    setTimeout(position, 0);
  };
  const ic = (...kids) => { const n = sv('svg', { class: 'fmt-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); for (const k of kids) n.append(k); return n; };
  const mkBtn = (inner, title, fn, cls?) => {
    const b = el('button', { class: 'fmt-btn' + (cls ? ' ' + cls : ''), type: 'button', title });
    if (typeof inner === 'string') b.textContent = inner; else b.append(inner);
    b.addEventListener('mousedown', (e) => e.preventDefault()); // 에디터 포커스·선택 유지
    b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
    return b;
  };
  bar.append(
    mkBtn('H', '제목', () => exec('formatBlock', 'h2'), 'fmt-h'),
    mkBtn('B', '굵게', () => exec('bold'), 'fmt-b'),
    mkBtn('I', '기울임', () => exec('italic'), 'fmt-i'),
    mkBtn(ic(sv('polyline', { points: '8 8 4 12 8 16' }), sv('polyline', { points: '16 8 20 12 16 16' })), '코드', wrapCode),
    mkBtn(ic(sv('line', { x1: 9, y1: 6, x2: 20, y2: 6 }), sv('line', { x1: 9, y1: 12, x2: 20, y2: 12 }), sv('line', { x1: 9, y1: 18, x2: 20, y2: 18 }), sv('circle', { cx: 4.5, cy: 6, r: 1.1 }), sv('circle', { cx: 4.5, cy: 12, r: 1.1 }), sv('circle', { cx: 4.5, cy: 18, r: 1.1 })), '목록', () => exec('insertUnorderedList')),
    mkBtn(ic(sv('path', { d: 'M6 7h8M6 12h12M6 17h8' }), sv('path', { d: 'M3 6.5v11' })), '인용', () => exec('formatBlock', 'blockquote')),
    mkBtn(ic(sv('path', { d: 'M10 13a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1.5 1.5' }), sv('path', { d: 'M14 11a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1.5-1.5' })), '링크', insertLink),
  );
  document.body.append(bar);
  function position() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !ce.contains(sel.anchorNode)) { bar.hidden = true; return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) { bar.hidden = true; return; }
    bar.hidden = false;
    const bw = bar.offsetWidth || 250, bh = bar.offsetHeight || 38;
    let x = rect.left + rect.width / 2 - bw / 2;
    let y = rect.top - bh - 10;
    x = Math.max(8, Math.min(x, window.innerWidth - bw - 8));
    if (y < 8) y = rect.bottom + 10;
    bar.style.left = x + 'px'; bar.style.top = y + 'px';
  }
  const onSel = () => setTimeout(position, 0);
  document.addEventListener('selectionchange', onSel);
  ce.addEventListener('mouseup', onSel);
  ce.addEventListener('keyup', onSel);
  const onScroll = () => { if (!bar.hidden) position(); };
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  return { destroy: () => { bar.remove(); document.removeEventListener('selectionchange', onSel); window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll); } };
}

export { buildWysiwygToolbar, mdFromDom };
