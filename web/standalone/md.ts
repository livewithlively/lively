// 공유 DOM 헬퍼 + 안전 마크다운 렌더러 — SPA(app.js)와 터미널 워크스페이스(terminal.js)가 공용.
// 보안 불변식: 모든 텍스트는 textContent/createTextNode 만, DOM 은 el() 로만 — innerHTML 류 미사용(HTML 주입 불가).
// (app.js 의 동일 함수에서 추출. app.js 는 자체 사본 유지 — 렌더러 확장 시 web/core.ts 와 **양쪽 동기화** 필수.)
// #551 확장: 이미지 ![..](..) · 체크박스 - [ ] · 중첩 리스트 · ~~취소선~~ · ++밑줄++ · ==하이라이트== ·
//            ::: 컨테이너(toggle/callout/columns/synced/toc/unsupported) · $$ 수식 블록 · ol start · 헤더 없는 표.
'use strict';

export function el(tag, attrs?, ...children): any {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

export function safeHref(raw) {
  const url = String(raw).trim();
  if (!url) return null;
  if (url.startsWith('#') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return url;
  if (url.startsWith('//')) return url;
  const stripped = url.replace(/[\x00-\x1f\x7f]/g, '');
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return url;
    return null;
  }
  return url;
}

// 인증 이미지 로더(#551) — /api/ui/* 는 fetch(토큰)→blob(토큰 세션 401 회피), 그 외는 그대로.
export function mdImage(src, alt) {
  const img = el('img', { class: 'md-img', alt: alt || '', loading: 'lazy' });
  if (!String(src).startsWith('/api/ui/')) { img.setAttribute('src', src); return img; }
  let token = null;
  try { token = localStorage.getItem('lively_ui_token'); } catch (_) { /* noop */ }
  fetch(src, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
    .then((b) => { img.src = URL.createObjectURL(b); })
    .catch(() => { img.classList.add('md-img-missing'); img.alt = (alt || '이미지') + ' (불러오기 실패)'; });
  return img;
}

export function renderInline(text) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(document.createTextNode(buf)); buf = ''; } };
  const s = text;
  let i = 0;
  const paired = (mark, make) => {
    const prev = i > 0 ? s[i - 1] : '';
    if (prev && /[A-Za-z0-9]/.test(prev)) return false; // 코드성 a==b, i++ 오탐 방지
    const end = s.indexOf(mark, i + 2);
    if (end > i + 2 && s[i + 2] !== ' ' && s[end - 1] !== ' ') {
      flush(); out.push(make(s.slice(i + 2, end))); i = end + 2; return true;
    }
    return false;
  };
  while (i < s.length) {
    const ch = s[i];
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i) { flush(); out.push(el('code', { class: 'md-code', text: s.slice(i + 1, end) })); i = end + 1; continue; }
    }
    if (ch === '!' && s[i + 1] === '[') {
      const close = s.indexOf(']', i + 2);
      if (close > i && s[close + 1] === '(') {
        const paren = s.indexOf(')', close + 2);
        if (paren > close) {
          const alt = s.slice(i + 2, close);
          const src = safeHref(s.slice(close + 2, paren));
          flush();
          if (src) out.push(mdImage(src, alt));
          else if (alt) out.push(document.createTextNode(alt));
          i = paren + 1; continue;
        }
      }
    }
    if (ch === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > i + 1) { flush(); out.push(el('strong', {}, ...renderInline(s.slice(i + 2, end)))); i = end + 2; continue; }
    }
    if (ch === '~' && s[i + 1] === '~' && paired('~~', (t) => el('del', { class: 'md-del' }, ...renderInline(t)))) continue;
    if (ch === '+' && s[i + 1] === '+' && paired('++', (t) => el('u', { class: 'md-u' }, ...renderInline(t)))) continue;
    if (ch === '=' && s[i + 1] === '=' && paired('==', (t) => el('mark', { class: 'md-mark' }, ...renderInline(t)))) continue;
    if (ch === '*' && s[i + 1] !== '*' && s[i + 1] !== ' ' && s[i + 1] !== undefined) {
      const end = s.indexOf('*', i + 1);
      if (end > i && s[end - 1] !== ' ') { flush(); out.push(el('em', {}, ...renderInline(s.slice(i + 1, end)))); i = end + 1; continue; }
    }
    if (ch === '[') {
      const close = s.indexOf(']', i + 1);
      if (close > i && s[close + 1] === '(') {
        const paren = s.indexOf(')', close + 2);
        if (paren > close) {
          const label = s.slice(i + 1, close);
          const href = safeHref(s.slice(close + 2, paren));
          flush();
          if (href) out.push(el('a', { class: 'md-link', href, rel: 'noopener noreferrer nofollow', target: '_blank' }, ...renderInline(label)));
          else out.push(...renderInline(label));
          i = paren + 1; continue;
        }
      }
    }
    buf += ch; i++;
  }
  flush();
  return out;
}

// ::: 컨테이너(#551) — web/core.ts 와 동일 계약.
export function mdParseContainerAttrs(rest) {
  const attrs: any = {}; let summary = '';
  for (const tok of String(rest || '').split(/\s+/)) {
    const m = /^([a-zA-Z_-]+)=(.*)$/.exec(tok);
    if (m && summary === '') attrs[m[1]] = m[2];
    else summary += (summary ? ' ' : '') + tok;
  }
  return { attrs, summary: summary.trim() };
}

export function mdRenderContainer(type, rest, bodyLines) {
  const { attrs, summary } = mdParseContainerAttrs(rest);
  const inner = () => renderMarkdown(bodyLines.join('\n'));
  const move = (from, to) => { while (from.firstChild) to.append(from.firstChild); return to; };
  switch (type) {
    case 'toggle': case 'template': {
      const det = el('details', { class: 'md-toggle' },
        el('summary', { class: 'md-toggle-sum' }, ...renderInline(summary || rest || '펼치기')));
      return move(inner(), det);
    }
    case 'callout': {
      const color = String(attrs.color || '').replace(/_background$/, '') || 'default';
      const box = el('div', { class: 'md-callout md-callout-' + color.replace(/[^a-z]/g, '') });
      if (attrs.icon) box.append(el('span', { class: 'md-callout-ic', 'aria-hidden': 'true', text: attrs.icon }));
      box.append(move(inner(), el('div', { class: 'md-callout-body' })));
      return box;
    }
    case 'columns': {
      const row = el('div', { class: 'md-columns' });
      const rendered = inner();
      while (rendered.firstChild) row.append(rendered.firstChild);
      return row;
    }
    case 'column': {
      const col = el('div', { class: 'md-column' });
      const ratio = Number(attrs.ratio);
      if (Number.isFinite(ratio) && ratio > 0 && ratio <= 1) col.style.flex = String(ratio) + ' 1 0';
      return move(inner(), col);
    }
    case 'synced': {
      const box = el('div', { class: 'md-synced' });
      box.append(el('span', { class: 'md-block-chip', text: '↻ 동기화 블록' }));
      if (attrs.missing === 'true') box.append(el('div', { class: 'md-synced-missing', text: '원본 블록이 공유 범위 밖이라 내용을 가져올 수 없습니다.' }));
      else box.append(move(inner(), el('div', { class: 'md-synced-body' })));
      return box;
    }
    case 'toc':
      return el('div', { class: 'md-block-chip md-toc', text: '목차 (원본 문서의 목차 블록)' });
    case 'unsupported':
      return el('div', { class: 'md-block-chip md-unsup', title: attrs.id ? 'block ' + attrs.id : '',
        text: '지원되지 않는 블록' + (attrs.type ? ': ' + attrs.type : '') });
    default:
      return inner();
  }
}

export function renderMarkdown(md) {
  const root = el('div', { class: 'md' });
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const isTableSep = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.indexOf('-') >= 0;
  const splitRow = (l) => {
    let t = l.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    // 이스케이프 파이프(\|) 인지 분리 — 노션 셀의 리터럴 '|' 보존(#551).
    const cells = [];
    let cur = '';
    for (let j = 0; j < t.length; j++) {
      const ch = t[j];
      if (ch === '\\' && t[j + 1] === '|') { cur += '|'; j++; continue; }
      if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  };
  const contOpen = (l) => /^:::\s*[a-zA-Z_-]/.test(l);
  const contClose = (l) => l.trim() === ':::';
  while (i < lines.length) {
    let line = lines[i];
    if (line.trim() === '') { i++; continue; }
    const cont = /^:::\s*([a-zA-Z_-]+)\s*(.*)$/.exec(line);
    if (cont) {
      const body = []; let depth = 1; let inFence = false; i++;
      while (i < lines.length && depth > 0) {
        const l = lines[i];
        if (/^(```|~~~)/.test(l)) inFence = !inFence;
        else if (!inFence && contOpen(l)) depth++;
        else if (!inFence && contClose(l)) { depth--; if (depth === 0) { i++; break; } }
        body.push(l); i++;
      }
      root.append(mdRenderContainer(cont[1], cont[2], body));
      continue;
    }
    if (contClose(line)) { i++; continue; }
    if (line.trim() === '$$') {
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) { if (lines[j].trim() === '$$') { close = j; break; } }
      if (close >= 0) {
        root.append(el('pre', { class: 'md-eq', title: 'LaTeX' }, el('code', { text: lines.slice(i + 1, close).join('\n') })));
        i = close + 1; continue;
      }
      root.append(el('p', { class: 'md-p', text: '$$' }));
      i++; continue;
    }
    const fence = /^(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1]; const code = []; i++;
      while (i < lines.length && lines[i].trimEnd() !== marker && !lines[i].startsWith(marker)) { code.push(lines[i]); i++; }
      if (i < lines.length) i++;
      root.append(el('pre', { class: 'md-pre' }, el('code', { text: code.join('\n') })));
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { root.append(el('hr', { class: 'md-hr' })); i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { const lvl = h[1].length; root.append(el('h' + lvl, { class: 'md-h md-h' + lvl }, ...renderInline(h[2].trim()))); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      const inner = renderMarkdown(quote.join('\n'));
      const bq = el('blockquote', { class: 'md-quote' });
      while (inner.firstChild) bq.append(inner.firstChild);
      root.append(bq); continue;
    }
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') >= 0) { rows.push(splitRow(lines[i])); i++; }
      const headerEmpty = header.every((c) => !c);
      const table = el('table', { class: 'md-table' });
      if (!headerEmpty) {
        const thead = el('thead'); const htr = el('tr');
        for (const c of header) htr.append(el('th', {}, ...renderInline(c)));
        thead.append(htr); table.append(thead);
      }
      const tbody = el('tbody');
      for (const r of rows) { const tr = el('tr'); for (let c = 0; c < header.length; c++) tr.append(el('td', {}, ...renderInline(r[c] || ''))); tbody.append(tr); }
      table.append(tbody); root.append(table); continue;
    }
    const bulletRe = /^(\s*)([-*+])\s+(.*)$/;
    const orderedRe = /^(\s*)(\d+)[.)]\s+(.*)$/;
    if (bulletRe.test(line) || orderedRe.test(line)) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const bm = bulletRe.exec(l);
        const om = bm ? null : orderedRe.exec(l);
        if (bm || om) {
          const m = bm || om;
          const level = Math.floor(m[1].replace(/\t/g, '  ').length / 2);
          let text = m[3];
          let checked = null;
          if (bm) {
            const cb = /^\[( |x|X)\]\s+(.*)$/.exec(text);
            if (cb) { checked = cb[1] !== ' '; text = cb[2]; }
          }
          items.push({ level, ordered: !!om, num: om ? Number(om[2]) : 0, checked, text });
          i++; continue;
        }
        if (l.trim() !== '' && /^\s+/.test(l) && items.length) {
          items[items.length - 1].text += ' ' + l.trim();
          i++; continue;
        }
        break;
      }
      const build = (idx, level) => {
        const first = items[idx];
        const list = el(first.ordered ? 'ol' : 'ul', { class: 'md-list' });
        if (first.ordered && first.num > 1) list.setAttribute('start', String(first.num));
        let j = idx;
        while (j < items.length && items[j].level >= level) {
          if (items[j].level > level) {
            const sub = build(j, items[j].level);
            (list.lastChild || list).append(sub.node);
            j = sub.next; continue;
          }
          if (items[j].ordered !== first.ordered) break;
          const it = items[j];
          const li = el('li', {});
          if (it.checked != null) {
            const cb = el('input', { type: 'checkbox', class: 'md-check', tabindex: '-1', 'aria-hidden': 'true' });
            cb.disabled = true; cb.checked = it.checked;
            li.classList.add('md-task');
            if (it.checked) li.classList.add('md-task-done');
            li.append(cb);
          }
          for (const n of renderInline(it.text)) li.append(n);
          list.append(li);
          j++;
        }
        return { node: list, next: j };
      };
      let idx = 0;
      while (idx < items.length) {
        const r = build(idx, items[idx].level);
        root.append(r.node);
        idx = r.next;
      }
      continue;
    }
    const para = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') break;
      if (/^(#{1,6})\s+/.test(l) || /^(```|~~~)/.test(l) || /^\s*>\s?/.test(l) ||
          /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) || /^(\s*)([-*+])\s+/.test(l) ||
          /^(\s*)(\d+)[.)]\s+/.test(l) || contOpen(l) || contClose(l) || l.trim() === '$$' ||
          (l.indexOf('|') >= 0 && lines[i + 1] != null && isTableSep(lines[i + 1]))) break;
      para.push(l); i++;
    }
    const p = el('p', { class: 'md-p' });
    para.forEach((l, idx) => { if (idx > 0) p.append(el('br')); for (const n of renderInline(l)) p.append(n); });
    root.append(p);
  }
  return root;
}
