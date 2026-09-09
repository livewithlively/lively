// standalone/ctx-lite.ts — 터미널 페이지(별 문서)용 우클릭 메뉴(#3784). 셸의 엔진(web/v2/ctx-menu.ts)과 같은 문법·같은
//  겉모습이지만 **의존이 0** 이다 — 이 번들은 셸 밖(terminal.html)에서 <script> 로 뜨므로 core.js 를 끌어올 수 없다.
//  키보드(↑↓ Enter Esc)·밖 클릭·창 blur(부모 셸을 누르면 이 문서엔 이벤트가 안 온다)·화면 밖 뒤집기.
//  ⚠ dev 반영: 이 폴더의 변경은 build:web 이 아니라 build-standalone 이 만든다 — serve-sync 가 그걸 따로 돌린다(#3784).
export interface LiteRow { label: string; run?: () => void; hint?: string; danger?: boolean; sep?: boolean; off?: boolean }

let openEl: HTMLElement | null = null;
let closer: (() => void) | null = null;
export function closeLiteMenu(): void { if (closer) closer(); }

export function liteMenu(x: number, y: number, rows: LiteRow[], title?: string): void {
  closeLiteMenu();
  const list: LiteRow[] = [];
  for (const r of rows) { if (r.sep) { if (list.length && !list[list.length - 1].sep) list.push(r); } else list.push(r); }
  while (list.length && list[list.length - 1].sep) list.pop();
  if (!list.length) return;
  const menu = document.createElement('div');
  menu.className = 'tctx'; menu.setAttribute('role', 'menu'); menu.tabIndex = -1;
  if (title) { const h = document.createElement('div'); h.className = 'tctx-title'; h.textContent = title; menu.append(h); }
  const btns: HTMLButtonElement[] = [];
  const close = (): void => {
    if (openEl !== menu) return;
    menu.remove(); openEl = null; closer = null;
    document.removeEventListener('pointerdown', away, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
  };
  const away = (e: Event): void => { if (!menu.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent): void => {
    const live = btns.filter((b) => !b.disabled);
    const i = live.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number): void => { live[(n + live.length) % live.length]?.focus(); };
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); go(i < 0 ? 0 : i + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); go(i < 0 ? live.length - 1 : i - 1); return; }
    if ((e.key === 'Enter' || e.key === ' ') && i >= 0) { e.preventDefault(); e.stopPropagation(); live[i].click(); return; }
    if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); }
  };
  for (const r of list) {
    if (r.sep) { const s = document.createElement('div'); s.className = 'tctx-sep'; menu.append(s); continue; }
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tctx-i' + (r.danger ? ' danger' : ''); b.setAttribute('role', 'menuitem'); b.tabIndex = -1;
    const l = document.createElement('span'); l.className = 'tctx-l'; l.textContent = r.label; b.append(l);
    if (r.hint) { const h = document.createElement('span'); h.className = 'tctx-hint'; h.textContent = r.hint; b.append(h); }
    if (r.off) b.disabled = true;
    else { b.onclick = () => { close(); r.run?.(); }; b.addEventListener('pointerenter', () => b.focus()); }
    menu.append(b); btns.push(b);
  }
  document.body.append(menu);
  openEl = menu; closer = close;
  const rc = menu.getBoundingClientRect();
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - rc.width - 6)) + 'px';
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - rc.height - 6)) + 'px';
  menu.focus({ preventScroll: true });
  setTimeout(() => {
    if (openEl !== menu) return;
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
  }, 0);
}
