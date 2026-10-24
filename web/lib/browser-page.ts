// web/lib/browser-page.ts — AI 브라우저(#4993)가 **남의 페이지 안에서** 돌리는 스크립트들.
//
//  여기 함수들은 우리 화면에서 실행되지 않는다. browser-host 가 `fn.toString()` 으로 원문을 떠서 `<webview>.executeJavaScript`
//  로 그 페이지(게스트)에 넣는다. 그래서 규칙이 셋이다:
//   ① **바깥 이름을 하나도 쓰지 않는다** — import·모듈 변수·다른 함수 모두 금지. 함수 본문만 넘어간다(인자는 JSON 으로).
//   ② **eval·new Function 을 쓰지 않는다** — 많은 사이트가 CSP 로 unsafe-eval 을 막는다(github·google). executeJavaScript 로
//      넣은 원문 자체는 CSP 를 안 타지만, 그 안에서 문자열을 다시 코드로 만들면 그 순간 막힌다. 사용자 코드(browser_eval)도
//      문자열 평가가 아니라 원문에 끼워 넣는다(evalSource).
//   ③ **페이지 상태를 바꾸지 않는다**(읽기 함수) — 요소에 속성을 달지 않는다(프레임워크가 DOM 변화를 보고 다시 그리면
//      사람이 보던 화면이 흔들린다). ref 는 페이지 전역의 숨은 표(WeakRef)에만 둔다. 같은 문서면 다음 호출에도 같은 ref.
//
//  ref 표는 **문서마다** 산다 — 새 페이지로 가면 window 가 새로 생겨 저절로 비워진다(SPA 안 이동은 그대로 이어진다).
'use strict';

export interface ReadOpts { filter: 'interactive' | 'all'; query?: string; ref?: string; max: number }
export interface ReadOut {
  url: string; title: string; count: number; truncated: boolean; tree: string;
  viewport: { width: number; height: number; scroll_x: number; scroll_y: number; page_height: number };
  error?: string;
}

/** 페이지를 접근성 트리처럼 읽는다 — 역할·이름·값 + ref. 게스트 안에서 돈다(위 규칙 ①②③). */
export function pageRead(opts: ReadOpts): ReadOut {
  const W = window as any;
  const KEY = '__livelyRefs';
  let st = W[KEY];
  if (!st || st.doc !== document) {
    st = { n: 0, byId: new Map<string, WeakRef<Element>>(), byEl: new WeakMap<Element, string>(), doc: document };
    try { Object.defineProperty(W, KEY, { value: st, configurable: true, enumerable: false, writable: true }); } catch { W[KEY] = st; }
  }
  const refOf = (el: Element): string => {
    let id = st.byEl.get(el);
    if (!id) { id = 'e' + (++st.n); st.byEl.set(el, id); st.byId.set(id, new WeakRef(el)); }
    return id;
  };
  const clean = (s: unknown, max: number): string => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  };
  const q = String(opts.query || '').toLowerCase();
  const all = opts.filter === 'all';
  const max = Math.max(10, Math.min(2000, opts.max | 0 || 400));
  const vw = window.innerWidth, vh = window.innerHeight;

  const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'gridcell']);
  const LANDMARKS: Record<string, string> = { MAIN: 'main', NAV: 'navigation', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form', DIALOG: 'dialog' };

  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    const cv = (el as any).checkVisibility;
    if (typeof cv === 'function') { try { return cv.call(el, { checkVisibilityCSS: true, checkOpacity: false }); } catch { /* 구형 */ } }
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const textOf = (el: Element | null): string => (el ? clean((el as HTMLElement).innerText ?? el.textContent ?? '', 120) : '');
  const labelFor = (el: Element): string => {
    const doc = el.ownerDocument;
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return clean(al, 120);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map((id) => textOf(doc.getElementById(id))).filter(Boolean).join(' '); if (t) return clean(t, 120); }
    const id = (el as HTMLElement).id;
    if (id) { try { const l = doc.querySelector('label[for="' + CSS.escape(id) + '"]'); if (l) { const t = textOf(l); if (t) return t; } } catch { /* 이상한 id */ } }
    const wrap = el.closest('label');
    if (wrap && wrap !== el) { const t = textOf(wrap); if (t) return t; }
    const ph = el.getAttribute('placeholder'); if (ph) return clean(ph, 120);
    const ti = el.getAttribute('title'); if (ti) return clean(ti, 120);
    const alt = el.getAttribute('alt'); if (alt) return clean(alt, 120);
    return '';
  };
  const roleOf = (el: Element): string => {
    const r = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (r) return r;
    const t = el.tagName;
    if (t === 'A' && (el as HTMLAnchorElement).href) return 'link';
    if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'INPUT') {
      const ty = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (ty === 'hidden') return '';
      if (['button', 'submit', 'reset', 'image'].includes(ty)) return 'button';
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'range') return 'slider';
      if (ty === 'file') return 'button';
      return ty === 'search' ? 'searchbox' : 'textbox';
    }
    if (/^H[1-6]$/.test(t)) return 'heading';
    if (t === 'IMG') return el.getAttribute('alt') ? 'img' : '';
    if (t === 'IFRAME') return 'iframe';
    if ((el as HTMLElement).isContentEditable && (el.parentElement ? !(el.parentElement as HTMLElement).isContentEditable : true)) return 'textbox';
    if (LANDMARKS[t]) return LANDMARKS[t];
    return '';
  };
  const isInteractive = (el: Element, role: string): boolean => {
    if (INTERACTIVE_ROLES.has(role) || role === 'iframe' || role === 'clickable') return true;
    const ti = el.getAttribute('tabindex');
    return ti !== null && Number(ti) >= 0 && !['heading', 'img'].includes(role);
  };
  /** 클릭 처리기를 단 div 는 DOM 으로 못 본다 — 손가락 커서로 갈음한다(부모가 이미 손가락이면 자식은 같은 단추다).
   *  모든 요소에 스타일을 묻지 않도록 글이 짧게 든 요소만 본다(큰 덩어리는 단추가 아니다). */
  const clickable = (el: Element): boolean => {
    const t = el.textContent || '';
    if (!t.trim() || t.length > 200) return false;
    try {
      if (getComputedStyle(el).cursor !== 'pointer') return false;
      const p = el.parentElement;
      return !p || getComputedStyle(p).cursor !== 'pointer';
    } catch { return false; }
  };
  const nameOf = (el: Element, role: string): string => {
    const lab = labelFor(el);
    if (lab) return lab;
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return '';
    if (el.tagName === 'INPUT') return clean((el as HTMLInputElement).value, 80);
    return textOf(el);
  };
  const lines: string[] = [];
  let count = 0;
  let truncated = false;
  const pushLine = (depth: number, s: string): void => {
    if (count >= max) { truncated = true; return; }
    lines.push('  '.repeat(Math.min(depth, 12)) + s);
    count++;
  };
  const describe = (el: Element, role: string, depth: number, off: { x: number; y: number }): void => {
    const name = nameOf(el, role);
    const parts: string[] = ['- ' + role];
    if (name) parts.push(JSON.stringify(name));
    if (role === 'heading') parts.push('(h' + el.tagName.slice(1) + ')');
    parts.push('[' + refOf(el) + ']');
    const h = el as HTMLInputElement;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const ty = (h.type || '').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') parts.push(h.checked ? 'checked' : 'unchecked');
      else if (ty === 'password') parts.push('value=' + (h.value ? '"' + '•'.repeat(Math.min(h.value.length, 8)) + '"' : '""') + ' (password)');
      else if (ty !== 'button' && ty !== 'submit' && ty !== 'reset') parts.push('value=' + JSON.stringify(clean(h.value, 120)));
      if (ty && !['text', 'textarea', 'checkbox', 'radio', 'password', 'submit', 'button'].includes(ty)) parts.push('type=' + ty);
    } else if (el.tagName === 'SELECT') {
      const s = el as HTMLSelectElement;
      const cur = s.selectedIndex >= 0 ? s.options[s.selectedIndex] : null;
      parts.push('value=' + JSON.stringify(cur ? clean(cur.text, 80) : ''));
      const opts = [...s.options].slice(0, 12).map((o) => clean(o.text, 40)).filter(Boolean);
      if (opts.length) parts.push('options=' + JSON.stringify(opts) + (s.options.length > 12 ? '…' : ''));
    } else if ((el as HTMLElement).isContentEditable && role === 'textbox') {
      parts.push('value=' + JSON.stringify(textOf(el)));
    }
    if (role === 'link') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:')) parts.push('href=' + JSON.stringify(clean(href, 160)));
    }
    if (role === 'iframe') {
      const src = el.getAttribute('src') || '';
      if (src) parts.push('src=' + JSON.stringify(clean(src, 160)));
    }
    if (el.getAttribute('aria-expanded')) parts.push('expanded=' + el.getAttribute('aria-expanded'));
    if (el.getAttribute('aria-selected') === 'true') parts.push('selected');
    if (el.getAttribute('aria-checked')) parts.push('checked=' + el.getAttribute('aria-checked'));
    if ((h as any).disabled || el.getAttribute('aria-disabled') === 'true') parts.push('(disabled)');
    const r = el.getBoundingClientRect();
    const cx = r.left + off.x + r.width / 2, cy = r.top + off.y + r.height / 2;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) parts.push('(offscreen)');
    pushLine(depth, parts.join(' '));
  };
  const matches = (el: Element, role: string): boolean => {
    if (!q) return true;
    const hay = (nameOf(el, role) + ' ' + (el.getAttribute('href') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + ((el as HTMLInputElement).value || '') + ' ' + (el.id || '')).toLowerCase();
    return hay.includes(q);
  };

  const walk = (node: Element | ShadowRoot | Document, depth: number, off: { x: number; y: number }, insideInteractive: boolean): void => {
    if (count >= max) { truncated = true; return; }
    const kids = (node as ParentNode).children;
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      const tag = el.tagName.toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'LINK' || tag === 'META') continue;
      if (!visible(el) && !(el as HTMLElement).shadowRoot) {
        // 숨은 파일 입력칸은 보여 준다 — 사이트가 흔히 감추고 단추로 대신하는데, 파일 올리기(browser_upload)의 과녁이다
        if (tag === 'INPUT' && String((el as HTMLInputElement).type).toLowerCase() === 'file') {
          if (matches(el, 'button')) pushLine(depth, '- file-input ' + JSON.stringify(labelFor(el) || el.getAttribute('name') || '') + ' [' + refOf(el) + '] (hidden)' + ((el as HTMLInputElement).multiple ? ' multiple' : ''));
          continue;
        }
        // 숨은 요소는 건너뛴다 — 단 display:contents 류(크기 0)라도 자식은 보일 수 있으니 자식은 본다
        if (getComputedStyle(el).display !== 'contents') continue;
      }
      let role = roleOf(el);
      if (!role && !insideInteractive && clickable(el)) role = 'clickable';
      const inter = !!role && isInteractive(el, role) && !insideInteractive;
      let nextDepth = depth;
      if (inter) {
        if (matches(el, role)) describe(el, role, depth, off);
        nextDepth = depth + 1;
      } else if (all && role && (role === 'heading' || role === 'img' || Object.values(LANDMARKS).includes(role)) && matches(el, role)) {
        describe(el, role, depth, off);
        nextDepth = depth + 1;
      } else if (all && !q && /^(P|LI|TD|TH|DT|DD|BLOCKQUOTE|PRE|FIGCAPTION|LABEL)$/.test(tag)) {
        const t = textOf(el);
        if (t && !el.querySelector('a[href],button,input,select,textarea,[role]')) { pushLine(depth, '- text ' + JSON.stringify(t)); continue; }
      }
      if (tag === 'IFRAME') {
        try {
          const fd = (el as HTMLIFrameElement).contentDocument;
          if (fd && fd.body) {
            const fr = el.getBoundingClientRect();
            walk(fd.body, nextDepth, { x: off.x + fr.left, y: off.y + fr.top }, false);
          } else pushLine(nextDepth, '  (다른 사이트의 프레임 — 안은 읽을 수 없다. 좌표로 누른다)');
        } catch { pushLine(nextDepth, '  (다른 사이트의 프레임 — 안은 읽을 수 없다. 좌표로 누른다)'); }
        continue;
      }
      if (tag === 'SVG') continue;   // 아이콘 속(path·g)은 요소가 아니다 — svg 자체가 단추면 위에서 이미 읽었다
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) walk(sr, nextDepth, off, inter || insideInteractive);
      if (inter && ['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'option', 'menuitem', 'tab', 'switch', 'slider', 'clickable'].includes(role)) {
        // 단추 안은 이름으로 이미 읽었다 — 다만 안에 숨은 파일 입력칸이 있으면 알린다(올리기 browser_upload 는 이 단추 ref 로도 된다)
        const fi = el.querySelector('input[type=file]') as HTMLInputElement | null;
        if (fi && matches(el, role)) pushLine(nextDepth, '- file-input [' + refOf(fi) + '] (이 단추 안에 숨음' + (fi.multiple ? ' · 여러 개' : '') + ')');
        continue;
      }
      walk(el, nextDepth, off, inter || insideInteractive);
    }
  };
  let root: Element | null = document.body;
  if (opts.ref) {
    const wr = st.byId.get(opts.ref);
    root = wr ? wr.deref() || null : null;
    if (!root || !root.isConnected) {
      return { url: location.href, title: document.title, count: 0, truncated: false, tree: '', viewport: { width: vw, height: vh, scroll_x: scrollX, scroll_y: scrollY, page_height: document.documentElement.scrollHeight }, error: 'ref ' + opts.ref + ' 를 찾지 못했습니다 — 페이지가 바뀌었을 수 있습니다. browser_read 로 다시 읽으세요.' };
    }
  }
  if (root) walk(root, 0, { x: 0, y: 0 }, false);
  // 열린 대화창(modal)이 있으면 맨 위에 알린다 — 그 뒤 요소는 눌러도 막힌다
  const dlg = document.querySelector('dialog[open], [role=dialog][aria-modal=true], [aria-modal="true"]');
  const head = dlg ? ['(열린 대화창이 있다: ' + (labelFor(dlg) || textOf(dlg).slice(0, 60)) + ')'] : [];
  return {
    url: location.href, title: document.title, count, truncated,
    tree: head.concat(lines).join('\n') + (truncated ? '\n… (요소가 더 있다 — query 로 좁히거나 max_nodes 를 늘리세요)' : ''),
    viewport: { width: vw, height: vh, scroll_x: Math.round(scrollX), scroll_y: Math.round(scrollY), page_height: document.documentElement.scrollHeight },
  };
}

export interface PointOut { x: number; y: number; w: number; h: number; tag: string; name: string; covered?: string; error?: string }

/** ref 의 화면 좌표(게스트 뷰포트 px) — 먼저 화면 안으로 굴린다. 다른 요소가 덮고 있으면 covered 로 알린다. 게스트 안에서 돈다. */
export function pageRefPoint(ref: string): PointOut {
  const st = (window as any).__livelyRefs;
  const wr = st && st.doc === document ? st.byId.get(ref) : null;
  const el: Element | null = wr ? wr.deref() || null : null;
  if (!el || !el.isConnected) return { x: 0, y: 0, w: 0, h: 0, tag: '', name: '', error: 'ref ' + ref + ' 를 찾지 못했습니다 — 페이지가 바뀌었을 수 있습니다. browser_read 로 다시 읽으세요.' };
  try { (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior }); } catch { (el as HTMLElement).scrollIntoView(); }
  // 같은 사이트 프레임 안의 요소면 프레임 위치를 더한다(바깥 뷰포트 좌표로)
  let ox = 0, oy = 0;
  let w: Window | null = el.ownerDocument.defaultView;
  while (w && w !== window && w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); ox += fr.left; oy += fr.top; w = w.parent; }
  const r = el.getBoundingClientRect();
  const x = Math.round(Math.max(1, Math.min(window.innerWidth - 2, r.left + ox + r.width / 2)));
  const y = Math.round(Math.max(1, Math.min(window.innerHeight - 2, r.top + oy + r.height / 2)));
  const name = String((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const out: PointOut = { x, y, w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName.toLowerCase(), name };
  if (ox === 0 && oy === 0) {
    const top = document.elementFromPoint(x, y);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      out.covered = top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + ' "' + String((top as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40) + '"';
    }
  }
  return out;
}

/** 입력칸에 커서를 끝으로 둔다(type 전에) — 클릭이 글 가운데에 커서를 꽂으면 글이 중간에 끼어든다. 게스트 안에서 돈다. */
export function pageCaretEnd(ref: string): { ok: boolean; focused: string } {
  const st = (window as any).__livelyRefs;
  const wr = st && st.doc === document ? st.byId.get(ref) : null;
  const el: any = wr ? wr.deref() || null : null;
  if (el && el.isConnected) {
    try { el.focus({ preventScroll: true }); } catch { /* 초점 못 받는 요소 */ }
    try {
      if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') { const n = el.value.length; el.setSelectionRange(n, n); }
      else if (el.isContentEditable) { const sel = getSelection(); const rg = document.createRange(); rg.selectNodeContents(el); rg.collapse(false); sel?.removeAllRanges(); sel?.addRange(rg); }
    } catch { /* email·number 는 선택 범위를 못 바꾼다 — 그대로 둔다 */ }
  }
  const a = document.activeElement;
  return { ok: !!el, focused: a ? a.tagName.toLowerCase() + ((a as HTMLElement).id ? '#' + (a as HTMLElement).id : '') : '' };
}

/** 양식 값 넣기 — 값 설정 + input·change 이벤트(리액트의 제어 입력도 따라오게 원형의 setter 로). 게스트 안에서 돈다. */
export function pageFill(ref: string, value: string | boolean | number): { ok: boolean; value?: unknown; error?: string } {
  const st = (window as any).__livelyRefs;
  const wr = st && st.doc === document ? st.byId.get(ref) : null;
  const el: any = wr ? wr.deref() || null : null;
  if (!el || !el.isConnected) return { ok: false, error: 'ref ' + ref + ' 를 찾지 못했습니다 — browser_read 로 다시 읽으세요.' };
  const fire = (t: string) => el.dispatchEvent(new Event(t, { bubbles: true }));
  const tag = el.tagName;
  if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
    const want = typeof value === 'string' ? !/^(false|0|no|off|)$/i.test(value.trim()) : !!value;
    if (el.checked !== want) el.click();
    return { ok: true, value: el.checked };
  }
  if (tag === 'SELECT') {
    const s = String(value);
    const opts = [...el.options] as HTMLOptionElement[];
    const hit = opts.find((o) => o.value === s) || opts.find((o) => o.text.trim() === s.trim())
      || opts.find((o) => o.text.trim().toLowerCase().includes(s.trim().toLowerCase()));
    if (!hit) return { ok: false, error: '고를 항목이 없습니다: ' + s + ' — 있는 항목: ' + opts.slice(0, 20).map((o) => o.text.trim()).join(' / ') };
    el.value = hit.value;
    fire('input'); fire('change');
    return { ok: true, value: hit.text.trim() };
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    try { el.focus({ preventScroll: true }); } catch { /* noop */ }
    if (set) set.call(el, String(value)); else el.value = String(value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: String(value) }));
    fire('change');
    return { ok: true, value: el.type === 'password' ? '••••' : el.value };
  }
  if (el.isContentEditable) {
    try { el.focus({ preventScroll: true }); } catch { /* noop */ }
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, String(value));
    return { ok: true, value: String(el.innerText || '').slice(0, 200) };
  }
  return { ok: false, error: '값을 넣을 수 있는 요소가 아닙니다(' + tag.toLowerCase() + ') — browser_act action=type 을 쓰세요.' };
}

export interface UploadFile { name: string; type: string; b64: string }

/**
 * 파일 넣기 — ref 가 파일 입력칸이면 그 칸의 files 를 바꾸고(input·change), 단추·라벨이면 이어진 입력칸을 찾아 넣고,
 *  둘 다 아니면 그 자리에 끌어 놓기(dragenter·dragover·drop)를 일으킨다. 게스트 안에서 돈다.
 *  ⚠ 파일 바이트는 base64 로 원문에 실려 온다(바깥 이름을 못 쓰는 규칙 ① 때문) — 크기 상한은 부르는 쪽이 지킨다.
 */
export function pageUpload(target: { ref?: string; x?: number; y?: number }, files: UploadFile[]): { ok: boolean; via?: string; target?: string; files?: Array<{ name: string; size: number }>; error?: string } {
  let el: any = null;
  if (target.ref) {
    const st = (window as any).__livelyRefs;
    const wr = st && st.doc === document ? st.byId.get(target.ref) : null;
    el = wr ? wr.deref() || null : null;
    if (!el || !el.isConnected) return { ok: false, error: 'ref ' + target.ref + ' 를 찾지 못했습니다 — browser_read 로 다시 읽으세요.' };
  } else {
    el = document.elementFromPoint(Number(target.x), Number(target.y));
    if (!el) return { ok: false, error: '그 좌표(' + target.x + ',' + target.y + ')에 요소가 없습니다 — 화면 안 좌표인지 확인하세요.' };
  }
  const desc = (el.tagName || '').toLowerCase() + (el.id ? '#' + el.id : '') + ((el.getAttribute && el.getAttribute('aria-label')) ? ' «' + el.getAttribute('aria-label') + '»' : '');
  const list = files.map((f) => {
    const bin = atob(f.b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new File([u8], f.name, { type: f.type || 'application/octet-stream' });
  });
  const dt = new DataTransfer();
  for (const f of list) dt.items.add(f);
  const isFile = (x: any): boolean => !!x && x.tagName === 'INPUT' && String(x.type).toLowerCase() === 'file';
  // 숨은 입력칸을 단추·라벨로 감싼 흔한 모양 — 라벨의 control · 안쪽(하나뿐일 때) · 같은 감싸개 안(하나뿐일 때)을 차례로 본다.
  //  ⚠ 감싸개는 두 칸까지, body 는 안 간다 — 넓게 뒤지면 끌어 놓는 자리를 가리켜도 같은 페이지의 **다른 입력칸**에 들어간다
  //   (실측 2026-10-25: 좌표로 가리킨 끌어 놓기 자리 대신 맨 위 «첨부 파일» 칸에 들어갔다). 좌표(끌어 놓기)는 감싸개를 안 본다.
  let input: any = isFile(el) ? el : null;
  if (!input && el.tagName === 'LABEL' && isFile(el.control)) input = el.control;
  if (!input) { const lb = el.closest ? el.closest('label') : null; if (lb && isFile(lb.control)) input = lb.control; }
  if (!input && el.querySelectorAll) { const inner = el.querySelectorAll('input[type=file]'); if (inner.length === 1) input = inner[0]; }
  if (!input && target.ref) {
    for (let p = el.parentElement, n = 0; !input && p && n < 2 && p !== document.body && p !== document.documentElement; p = p.parentElement, n++) {
      const xs = p.querySelectorAll('input[type=file]');
      if (xs.length === 1) input = xs[0];
      else if (xs.length > 1) break;
    }
  }
  const out = list.map((f) => ({ name: f.name, size: f.size }));
  if (input) {
    if (!input.multiple && list.length > 1) return { ok: false, error: '이 입력칸은 파일을 하나만 받습니다(' + list.length + '개를 줬습니다).' };
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, via: 'input', target: desc, files: out };
  }
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, dataTransfer: dt };
  el.dispatchEvent(new DragEvent('dragenter', o));
  el.dispatchEvent(new DragEvent('dragover', o));
  el.dispatchEvent(new DragEvent('drop', o));
  return { ok: true, via: 'drop', target: desc, files: out };
}

/** 본문 글 — main/article 이 충분히 길면 거기서, 아니면 body 전체. 게스트 안에서 돈다. */
export function pageText(max: number): { url: string; title: string; text: string; length: number; truncated: boolean } {
  const main = document.querySelector('main, article, [role=main]') as HTMLElement | null;
  const body = document.body as HTMLElement | null;
  const pick = main && (main.innerText || '').trim().length > 200 ? main : body;
  const t = String((pick && pick.innerText) || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const n = Math.max(500, max | 0);
  return { url: location.href, title: document.title, text: t.slice(0, n), length: t.length, truncated: t.length > n };
}

/** 스크롤 위치 — 창 + 그 좌표 아래에서 가장 가까운 스크롤되는 상자. 휠이 다 굴렀는지(멈췄는지) 볼 때 쓴다. 게스트 안에서 돈다. */
export function pageScrollState(x: number, y: number): { x: number; y: number; page_height: number; viewport_height: number; inner?: { tag: string; top: number; left: number; height: number } } {
  const out: { x: number; y: number; page_height: number; viewport_height: number; inner?: { tag: string; top: number; left: number; height: number } } = {
    x: Math.round(scrollX), y: Math.round(scrollY), page_height: document.documentElement.scrollHeight, viewport_height: innerHeight,
  };
  let n: Element | null = document.elementFromPoint(x, y);
  while (n && n !== document.body && n !== document.documentElement) {
    const cs = getComputedStyle(n);
    if ((/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) || (/(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1)) {
      out.inner = { tag: n.tagName.toLowerCase() + ((n as HTMLElement).id ? '#' + (n as HTMLElement).id : ''), top: Math.round(n.scrollTop), left: Math.round(n.scrollLeft), height: n.scrollHeight };
      break;
    }
    n = n.parentElement;
  }
  return out;
}

/** 이 글이 페이지에 있나(wait text). 게스트 안에서 돈다. */
export function pageHasText(text: string): boolean {
  return String((document.body && document.body.innerText) || '').includes(text);
}

/** 새 창으로 여는 링크·window.open 을 **같은 탭**으로 — AI 가 쓰는 탭에만 건다. 데스크톱 앱은 새 창을 시스템 브라우저로 보내
 *  (desktop main 의 setWindowOpenHandler) AI 가 그 페이지를 놓친다. 멱등이다(두 번 걸어도 한 번). 게스트 안에서 돈다. */
export function pageSameTab(until: number): boolean {
  const W = window as any;
  //  «AI 가 쓰는 동안» 만 — 이 시각(같은 기계의 Date.now)이 지나면 고리는 아무것도 바꾸지 않는다. 사람이 나중에 이 탭에서
  //   둘러볼 때 새 창 · 팝업이 제자리 이동으로 바뀌면 사이트가 기대한 팝업(결제 · 미리보기)이 깨진다(#4993 격리 리뷰).
  try { Object.defineProperty(W, '__livelyAiUntil', { value: Number(until) || 0, writable: true, configurable: true, enumerable: false }); } catch { W.__livelyAiUntil = Number(until) || 0; }
  if (W.__livelySameTab) return false;
  try { Object.defineProperty(W, '__livelySameTab', { value: true, enumerable: false }); } catch { W.__livelySameTab = true; }
  const aiNow = (): boolean => Date.now() < (Number(W.__livelyAiUntil) || 0);
  document.addEventListener('click', (e) => {
    if (!aiNow()) return;
    const t = e.target as Element | null;
    const a = t && typeof t.closest === 'function' ? t.closest('a[target]') as HTMLAnchorElement | null : null;
    if (a && a.target && a.target !== '_self' && a.target !== '_top' && a.target !== '_parent' && /^https?:/.test(a.href)) a.target = '_self';
  }, true);
  const orig = window.open;
  window.open = function (this: Window, url?: string | URL, target?: string, features?: string): Window | null {
    if (aiNow() && (!target || target === '_blank')) {
      //  빈 창(about:blank)을 먼저 열고 나중에 주소를 넣는 흔한 모양 — 제자리로 옮기면 이 페이지가 비워진다. 막힌 팝업처럼 null 을 준다.
      const raw = url === undefined || url === null ? '' : String(url).trim();
      if (!raw || /^(about:|javascript:)/i.test(raw)) return null;
      try {
        const u = new URL(raw, location.href);
        if (/^(https?|blob|data):$/.test(u.protocol)) { location.href = u.href; return window; }
      } catch { /* 이상한 주소 — 원래대로 */ }
    }
    return orig.call(window, url as string, target, features);
  } as typeof window.open;
  return true;
}

// ── 원문 만들기 ─────────────────────────────────────────────────────────────

/** 위 함수 하나를 인자와 함께 게스트에서 돌릴 원문으로. 인자는 JSON 으로만 넘어간다(함수·DOM 은 못 넘긴다). */
export function callSource(fn: (...a: any[]) => unknown, ...args: unknown[]): string {
  return '(' + fn.toString() + ')(' + args.map((a) => JSON.stringify(a === undefined ? null : a)).join(',') + ')';
}

/**
 * browser_eval 의 사용자 코드를 게스트에서 돌릴 원문으로. **문자열 평가(eval)가 아니라 원문에 끼워 넣는다**(위 규칙 ②).
 *  expr=true 면 식으로(`1+1` · `document.title`), false 면 본문으로(`const a = 1; return a`) 감싼다 — 호출하는 쪽이 식으로 먼저
 *  해 보고 문법 오류면 본문으로 다시 부른다. 결과는 JSON 으로 바뀔 수 있는 모양으로 줄여 돌려준다(DOM 은 태그·글로, 순환은 끊는다).
 */
export function evalSource(code: string, expr: boolean): string {
  const body = expr ? 'return (\n' + code + '\n);' : code;
  return `(async () => {
  //  결과 직렬화 — 페이지 객체는 끝없이 이어진다(window.self · document.defaultView · 리액트 fiber). 세 겹으로 막는다:
  //   ① 지나온 길에 있던 객체를 또 만나면 '[순환]' ② 칸 수 예산(5,000) ③ 글자 예산(150만 자) — 넘으면 '[생략]'.
  //   window · document · storage 같은 «평범하지 않은» 객체는 펼치지 않고 그 종류 이름만 준다(#4993 격리 리뷰: window 한 번에 페이지가 멈췄다).
  let __nodes = 0, __chars = 0;
  const __path = new Set();
  const __ser = (v, d) => {
    if (++__nodes > 5000 || __chars > 1500000) return '[생략 — 결과가 너무 큽니다]';
    if (v === undefined) return { __undefined: true };
    if (typeof v === 'string') { const cut = Math.min(50000, Math.max(0, 1500000 - __chars)); __chars += Math.min(v.length, cut); return v.length > cut ? v.slice(0, cut) + '…' : v; }
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return String(v) + 'n';
    if (typeof v === 'symbol') return String(v);
    if (typeof v === 'function') return '[function ' + (v.name || '익명') + ']';
    if (v instanceof Error) return { error: v.name + ': ' + v.message };
    if (typeof Element !== 'undefined' && v instanceof Element) return { element: v.tagName.toLowerCase(), id: v.id || undefined, text: String(v.innerText || v.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) };
    if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    const tag = Object.prototype.toString.call(v);
    const plain = tag === '[object Object]' || tag === '[object Array]' || tag === '[object Map]' || tag === '[object Set]' || tag === '[object NodeList]' || tag === '[object HTMLCollection]' || tag === '[object Arguments]';
    if (!plain) return tag;
    if (__path.has(v)) return '[순환]';
    if (d > 6) return '[깊이 초과]';
    __path.add(v);
    try {
      if (tag === '[object Map]') return { __map: Array.from(v.entries()).slice(0, 200).map(([k, x]) => [__ser(k, d + 1), __ser(x, d + 1)]) };
      if (tag !== '[object Object]') return Array.from(v).slice(0, 200).map((x) => __ser(x, d + 1));
      const o = {}; let n = 0;
      for (const k in v) { if (n++ >= 200) { o['…'] = '키가 더 있다'; break; } try { o[k] = __ser(v[k], d + 1); } catch (e) { o[k] = '[읽기 실패]'; } }
      return o;
    } finally { __path.delete(v); }
  };
  try {
    const __v = await (async () => {
${body}
    })();
    return { ok: true, value: __ser(__v, 0) };
  } catch (e) {
    return { ok: false, error: (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)) };
  }
})()`;
}
