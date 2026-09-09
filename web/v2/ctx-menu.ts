// v2/ctx-menu.ts — 우클릭 메뉴 **엔진**(#3784). 화면 어디서 부르든 같은 메뉴 한 벌.
//  종전 panes-kit.ctxMenu(자료 칸·사이드바 프로젝트 행·레일 독·곁칸 탭)는 이 파일로 위임된다 — 호출 서명은 그대로다.
//  이 파일이 아는 것: 좌표·행 목록 → DOM. **무엇을 띄울지**는 모른다(그건 ctx-registry.ts 가 화면에서 모은다).
//
//  더한 것(종전 ctxMenu 대비):
//   · 키보드 — ↑↓ Home End 로 옮기고 Enter/Space 로 누르고 → 로 하위 메뉴, ← Esc 로 닫는다(맥·윈도 메뉴 관례).
//   · 하위 메뉴(sub) — 오른쪽에 펼친다. 화면 오른쪽 끝이면 왼쪽으로 뒤집는다.
//   · 머리글(title) — 「무엇에 대한 메뉴인가」를 맨 위에 한 줄(세션 이름·파일 이름). 항목이 많아질수록 이게 있어야 읽힌다.
//   · 아이콘·힌트(단축키)·체크 표시 — 있는 행만 그린다. 하나라도 아이콘이 있으면 열을 맞춘다.
//   · 닫힘 — 밖 클릭·Esc·창 blur(iframe 이 포커스를 가져갈 때)·스크롤·크기 변경. 열려 있던 포커스는 돌려준다.
//  ⚠ 메뉴는 늘 하나만 산다 — 새로 띄우면 앞 것을 지운다. body 에 붙으므로 곁칸 격리(#1819)와 무관하다(값도 신호도 안 만진다).
import { el } from '../lib/dom.js';
import { icon as lineIcon } from './icons.js';

export interface CtxRow {
  label: string;
  run?: () => void;
  /** 위험색(삭제·휴지통) — 맨 아래에 두는 관례. */
  danger?: boolean;
  /** 구분선. label 은 무시된다. */
  sep?: boolean;
  /** 누를 수 없음(흐리게). 왜 안 되는지는 hint 로 말한다. */
  off?: boolean;
  /** icons.ts 의 이름. */
  icon?: string;
  /** 오른쪽 흐린 글 — 단축키(⌘C) 또는 짧은 부연. */
  hint?: string;
  /** 체크 표시(토글 항목). */
  checked?: boolean;
  /** 하위 메뉴 — 있으면 run 은 무시된다. */
  sub?: CtxRow[];
  /** 구획 머리글(누를 수 없는 작은 글). */
  head?: boolean;
  /** 누른 뒤 메뉴를 닫지 않는다(토글을 연달아 누를 때). */
  keep?: boolean;
}

export interface CtxOpts {
  /** 머리글 — 「이 메뉴는 무엇에 대한 것인가」. 비면 안 그린다. */
  title?: string;
  /** 머리글 아래 흐린 한 줄(종류·상태). */
  sub?: string;
  onClose?: () => void;
  minWidth?: number;
}

const MENU_CLS = 'pn-ctx';
const MARGIN = 6;
let openRoot: HTMLElement | null = null;
let openClose: (() => void) | null = null;

export function ctxIsOpen(): boolean { return !!openRoot && openRoot.isConnected; }
export function closeCtxMenu(): void { openClose?.(); }

/** 구분선 정리 — 연속·맨 앞·맨 뒤의 구분선을 턴다(모으는 쪽이 신경 쓰지 않아도 되게). */
export function tidyRows(rows: CtxRow[]): CtxRow[] {
  const out: CtxRow[] = [];
  for (const r of rows) {
    if (!r) continue;
    if (r.sep) { if (out.length && !out[out.length - 1].sep) out.push(r); continue; }
    out.push(r);
  }
  while (out.length && out[out.length - 1].sep) out.pop();
  return out;
}

/** 메뉴 하나를 띄운다. 돌려주는 함수로 닫을 수 있다. */
export function showCtxMenu(x: number, y: number, rows: CtxRow[], opts: CtxOpts = {}): () => void {
  closeCtxMenu();
  const list = tidyRows(rows);
  if (!list.length) return () => { /* 띄울 것이 없다 */ };
  const prevFocus = document.activeElement as HTMLElement | null;
  const root = el('div', { class: MENU_CLS, role: 'menu', tabindex: '-1' }) as HTMLElement;
  if (opts.minWidth) root.style.minWidth = opts.minWidth + 'px';
  if (opts.title) {
    root.append(el('div', { class: 'pn-ctx-title' },
      el('b', { class: 'pn-ctx-title-t', text: opts.title, title: opts.title }),
      opts.sub ? el('span', { class: 'pn-ctx-title-s', text: opts.sub }) : null));
  }
  const subs: HTMLElement[] = [];   // 열려 있는 하위 메뉴(깊이 순)
  const closeSubsFrom = (depth: number): void => { while (subs.length > depth) subs.pop()!.remove(); };
  const close = (): void => {
    if (openRoot !== root) return;
    closeSubsFrom(0);
    root.remove();
    openRoot = null; openClose = null;
    document.removeEventListener('pointerdown', away, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', close);
    if (prevFocus && prevFocus.isConnected && document.activeElement === document.body) { try { prevFocus.focus({ preventScroll: true }); } catch (_) { /* noop */ } }
    opts.onClose?.();
  };
  const inMenus = (n: Node | null): boolean => !!n && (root.contains(n) || subs.some((s) => s.contains(n)));
  const away = (e: Event): void => { if (!inMenus(e.target as Node)) close(); };
  const onScroll = (e: Event): void => { if (!inMenus(e.target as Node)) close(); };
  const onBlur = (): void => { if (document.activeElement && document.activeElement.tagName === 'IFRAME') close(); };

  // ── 행 그리기 — 한 단(level)의 목록을 만든다. 하위 메뉴도 같은 붓. ───────────────
  const paintList = (host: HTMLElement, items: CtxRow[], depth: number): HTMLButtonElement[] => {
    const hasIcon = items.some((r) => !!r.icon || r.checked !== undefined);
    const btns: HTMLButtonElement[] = [];
    for (const r of items) {
      if (r.sep) { host.append(el('div', { class: 'pn-ctx-sep', role: 'separator' })); continue; }
      if (r.head) { host.append(el('div', { class: 'pn-ctx-head', text: r.label })); continue; }
      const b = el('button', {
        class: 'pn-ctx-i' + (r.danger ? ' danger' : '') + (r.sub ? ' has-sub' : '') + (r.checked ? ' checked' : ''),
        type: 'button', role: r.sub ? 'menuitem' : (r.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'),
        'aria-haspopup': r.sub ? 'menu' : null, 'aria-checked': r.checked !== undefined ? String(!!r.checked) : null,
        tabindex: '-1',
      }) as HTMLButtonElement;
      if (hasIcon) {
        const ic = el('span', { class: 'pn-ctx-ic', 'aria-hidden': 'true' });
        if (r.checked) ic.append(lineIcon('check', 'v2-ic pn-ctx-svg'));
        else if (r.icon) ic.append(lineIcon(r.icon, 'v2-ic pn-ctx-svg'));
        b.append(ic);
      }
      b.append(el('span', { class: 'pn-ctx-l', text: r.label }));
      if (r.hint) b.append(el('span', { class: 'pn-ctx-hint', text: r.hint }));
      if (r.sub) b.append(el('span', { class: 'pn-ctx-chev', 'aria-hidden': 'true' }, lineIcon('chevR', 'v2-ic pn-ctx-svg')));
      if (r.off) b.disabled = true;
      else if (r.sub) {
        const sub = r.sub;
        let t = 0;
        b.addEventListener('pointerenter', () => { window.clearTimeout(t); t = window.setTimeout(() => openSub(b, sub, depth + 1), 140); });
        b.addEventListener('pointerleave', () => window.clearTimeout(t));
        b.onclick = () => openSub(b, sub, depth + 1, true);
      } else {
        b.addEventListener('pointerenter', () => { closeSubsFrom(depth); b.focus({ preventScroll: true }); });
        b.onclick = () => { if (!r.keep) close(); r.run?.(); };
      }
      host.append(b);
      btns.push(b);
    }
    return btns;
  };

  const openSub = (anchor: HTMLButtonElement, items: CtxRow[], depth: number, focusFirst = false): void => {
    closeSubsFrom(depth - 1);
    const menu = el('div', { class: MENU_CLS + ' pn-ctx-sub', role: 'menu', tabindex: '-1' }) as HTMLElement;
    const btns = paintList(menu, tidyRows(items), depth);
    document.body.append(menu);
    subs.push(menu);
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    let left = a.right + 2;
    if (left + m.width > window.innerWidth - MARGIN) left = Math.max(MARGIN, a.left - m.width - 2);   // 오른쪽이 모자라면 왼쪽으로
    const top = Math.max(MARGIN, Math.min(a.top - 5, window.innerHeight - m.height - MARGIN));
    menu.style.left = left + 'px'; menu.style.top = top + 'px';
    wireKeys(menu, btns, depth);
    if (focusFirst && btns.length) btns[0].focus({ preventScroll: true });
  };

  // ── 키보드 — 단마다 리스너를 하나씩. 지금 포커스가 든 단이 받는다. ───────────────
  const wireKeys = (menu: HTMLElement, btns: HTMLButtonElement[], depth: number): void => {
    menu.addEventListener('keydown', (e: KeyboardEvent) => {
      const live = btns.filter((b) => !b.disabled);
      if (!live.length) return;
      const i = live.indexOf(document.activeElement as HTMLButtonElement);
      const go = (n: number): void => { live[(n + live.length) % live.length].focus({ preventScroll: true }); };
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); go(i < 0 ? 0 : i + 1); break;
        case 'ArrowUp': e.preventDefault(); go(i < 0 ? live.length - 1 : i - 1); break;
        case 'Home': e.preventDefault(); go(0); break;
        case 'End': e.preventDefault(); go(live.length - 1); break;
        case 'ArrowRight': { e.preventDefault(); const b = live[i]; if (b && b.classList.contains('has-sub')) b.click(); break; }
        case 'ArrowLeft': if (depth > 0) { e.preventDefault(); const parentBtn = parentAnchor(depth); closeSubsFrom(depth - 1); parentBtn?.focus({ preventScroll: true }); } break;
        case 'Enter': case ' ': { e.preventDefault(); const b = live[i]; if (b) b.click(); break; }
        case 'Tab': e.preventDefault(); break;   // 메뉴 밖으로 포커스가 새지 않게
        default: return;
      }
      e.stopPropagation();
    });
  };
  const parentAnchor = (depth: number): HTMLButtonElement | null => {
    const host = depth <= 1 ? root : subs[depth - 2];
    return (host?.querySelector('.pn-ctx-i.has-sub:focus, .pn-ctx-i.has-sub.open') as HTMLButtonElement | null)
      || (host?.querySelector('.pn-ctx-i.has-sub') as HTMLButtonElement | null);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); return; }
    // 메뉴 밖에 포커스가 있어도(우클릭 직후) 화살표는 메뉴로 들어온다.
    if (!inMenus(document.activeElement) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault(); e.stopPropagation();
      const first = root.querySelector('.pn-ctx-i:not(:disabled)') as HTMLButtonElement | null;
      first?.focus({ preventScroll: true });
    }
  };

  const btns = paintList(root, list, 0);
  document.body.append(root);
  openRoot = root; openClose = close;
  // 화면 밖으로 나가지 않게 — 오른쪽·아래 끝에서 뒤집는다(좁은 곁칸에서 우클릭하면 늘 걸린다).
  const r = root.getBoundingClientRect();
  root.style.left = Math.max(MARGIN, Math.min(x, window.innerWidth - r.width - MARGIN)) + 'px';
  root.style.top = Math.max(MARGIN, Math.min(y, window.innerHeight - r.height - MARGIN)) + 'px';
  wireKeys(root, btns, 0);
  root.focus({ preventScroll: true });
  // ⚠ 우클릭을 만든 그 pointerdown 이 아직 흐르는 중일 수 있다 — 한 박자 뒤에 듣기 시작한다.
  window.setTimeout(() => {
    if (openRoot !== root) return;
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', close);
  }, 0);
  return close;
}

/** 클립보드에 쓴다 — 못 쓰면(권한·http) 사람이 직접 복사할 수 있게 prompt 로 보여 준다. 결과를 돌려준다. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) {
    try { window.prompt('복사할 글이에요 — ⌘C(Ctrl+C)로 복사하세요:', text); } catch (__) { /* noop */ }
    return false;
  }
}
