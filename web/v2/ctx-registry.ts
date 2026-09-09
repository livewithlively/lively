// v2/ctx-registry.ts — 우클릭 **배선**(#3784). 화면에 흩어진 「우클릭하면 무엇을 띄울까」를 한 자리에 모은다.
//
//  왜 위임(delegation)인가: 목록 행은 8초마다 다시 그려진다(사이드바·곁칸). 행마다 리스너를 달면 그릴 때마다 다시
//  달아야 하고 빠뜨린 자리가 생긴다. 대신 뿌리(#v2-root / body) 하나가 듣고, 눌린 자리에서 위로 올라가며
//  **표(data-ctx)** 를 찾는다. 행은 `data-ctx="session" data-sid="…"` 만 달면 된다 — 리스너도 import 도 없다.
//
//  메뉴는 세 겹으로 모인다(가까운 것부터):
//   ① 항목(item)    — 가장 가까운 data-ctx 표(또는 bindCtx 로 요소에 직접 묶은 제공자)가 만든 행. 머리글은 여기서 온다.
//   ② 표면(surface) — 가장 가까운 data-ctx-surface(홈·확인할 것·곁칸·위키…)의 행. 빈 자리에서 우클릭하면 이것만 뜬다.
//   ③ 공통(common)  — 선택한 글·링크·그림·이 화면 주소처럼 어디서나 같은 행(셸이 등록한다).
//
//  비켜 주는 자리(브라우저 기본 메뉴가 뜬다):
//   · 글을 치는 칸(input·textarea·contenteditable) — 붙여넣기·맞춤법은 브라우저 것이 낫다.
//   · ⇧ 를 누른 채 우클릭 — 우리 메뉴를 건너뛰는 탈출구(개발자 도구·검사 등).
//   · 이미 다른 코드가 preventDefault 한 이벤트(자료 칸·레일 독처럼 제 메뉴를 가진 자리) — 겹쳐 띄우지 않는다.
//   · iframe·webview 안 — 그 문서의 일이다(클래식 화면은 그 문서 안에서 같은 배선을 다시 건다: web/main.ts).
//  ⚠ 여기서는 값도 신호도 만들지 않는다 — 제공자가 준 행을 그릴 뿐이다. 곁칸 격리(#1819)는 제공자가 지킨다.
import { closeCtxMenu, ctxIsOpen, showCtxMenu, type CtxRow } from './ctx-menu.js';
import { EMBEDDED } from './embed.js';

/** 셸에게 「이 주소를 (새 탭에) 열어 달라」 — 부품·클래식 액자처럼 탭 API 가 없는 자리가 쓴다.
 *  같은 창이면 window 로, 액자 안이면 부모 창으로 postMessage 한다(main.ts 가 'lively:open-route' 를 받는다).
 *  newTab 이 아니면 그냥 주소를 바꾼다(액자 안에서는 액자 안 주소가 바뀐다 — 셸 탭은 그대로). */
export function requestOpenRoute(href: string, newTab = false): void {
  if (!newTab) { location.hash = href; return; }
  const w: Window = EMBEDDED && window.parent && window.parent !== window ? window.parent : window;
  try { w.postMessage({ type: 'lively:open-route', href }, location.origin); }
  catch (_) { location.hash = href; }
}

export interface CtxHit {
  /** 표를 단 요소(가장 가까운 것). */
  el: HTMLElement;
  /** data-ctx 값(또는 bindCtx 요소는 그 요소의 data-ctx, 없으면 'bound'). */
  kind: string;
  /** 그 요소의 dataset — id 류는 여기서 읽는다. */
  data: DOMStringMap;
}
export interface CtxEvent {
  e: MouseEvent;
  x: number; y: number;
  target: HTMLElement;
  /** 우클릭 시점의 선택 글(공백 제거). 없으면 ''. */
  selection: string;
  /** 눌린 자리의 링크(a[href]) — 있으면. */
  link: HTMLAnchorElement | null;
  /** 눌린 자리의 그림 — 있으면. */
  img: HTMLImageElement | null;
  /** 이 배선의 뿌리(#v2-root 또는 body). */
  root: HTMLElement;
}
export interface CtxResult { rows: CtxRow[]; title?: string; sub?: string }
export type CtxProvider = (hit: CtxHit, ev: CtxEvent) => CtxRow[] | CtxResult | null | undefined | void;

const kinds = new Map<string, CtxProvider>();
const surfaces = new Map<string, CtxProvider>();
const bound = new WeakMap<HTMLElement, CtxProvider>();
const boundSurface = new WeakMap<HTMLElement, CtxProvider>();
const commons: Array<(ev: CtxEvent) => CtxRow[]> = [];

/** 종류(data-ctx 값)에 제공자를 건다. 같은 종류를 다시 걸면 갈아 끼운다. 돌려주는 함수로 뗀다. */
export function registerCtx(kind: string, p: CtxProvider): () => void {
  kinds.set(kind, p);
  return () => { if (kinds.get(kind) === p) kinds.delete(kind); };
}
/** 표면(data-ctx-surface 값)에 제공자를 건다 — 빈 자리 우클릭. */
export function registerCtxSurface(name: string, p: CtxProvider): () => void {
  surfaces.set(name, p);
  return () => { if (surfaces.get(name) === p) surfaces.delete(name); };
}
/** 요소 하나에 제공자를 직접 묶는다 — 닫힌 클로저(칸 안의 go/back 같은 것)를 쓰는 부품용. 요소가 죽으면 같이 사라진다(WeakMap). */
export function bindCtx(node: HTMLElement, p: CtxProvider): void { bound.set(node, p); }
/** 요소 하나를 **표면**으로 묶는다 — 곁칸 한 벌(pn-wrap)처럼 인스턴스마다 닫힌 값을 가진 빈 자리 메뉴. */
export function bindCtxSurface(node: HTMLElement, p: CtxProvider): void { boundSurface.set(node, p); }
/** 어디서나 맨 아래에 붙는 공통 행(선택 복사·링크 복사·이 화면 주소). */
export function registerCtxCommon(f: (ev: CtxEvent) => CtxRow[]): () => void {
  commons.push(f);
  return () => { const i = commons.indexOf(f); if (i >= 0) commons.splice(i, 1); };
}

const EDIT_SEL = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
const FRAME_SEL = 'iframe, webview, .pn-ctx';

function norm(r: CtxRow[] | CtxResult | null | undefined | void): CtxResult | null {
  if (!r) return null;
  if (Array.isArray(r)) return r.length ? { rows: r } : null;
  return r.rows && r.rows.length ? r : (r.title ? r : null);
}

/** 그 자리에서 메뉴 행을 모은다. 띄우지는 않는다(테스트·프로그램 호출용). */
export function collectCtx(target: HTMLElement, ev: CtxEvent): { rows: CtxRow[]; title?: string; sub?: string } | null {
  let item: CtxResult | null = null;
  let itemEl: HTMLElement | null = null;
  let surface: CtxResult | null = null;
  let n: HTMLElement | null = target;
  while (n && n !== ev.root.parentElement) {
    if (!item) {
      const bp = bound.get(n);
      const kind = n.dataset ? n.dataset.ctx : undefined;
      const p = bp || (kind ? kinds.get(kind) : undefined);
      if (p) {
        const hit: CtxHit = { el: n, kind: kind || 'bound', data: n.dataset };
        item = norm(p(hit, ev));
        if (item) itemEl = n;
      }
    }
    if (!surface) {
      const bs = boundSurface.get(n);
      const sname = n.dataset ? n.dataset.ctxSurface : undefined;
      const sp = bs || (sname ? surfaces.get(sname) : undefined);
      if (sp) surface = norm(sp({ el: n, kind: sname || 'surface', data: n.dataset }, ev));
    }
    if (item && surface) break;
    n = n.parentElement;
  }
  void itemEl;
  // 겹은 **같은 이름이 이미 있으면** 뺀다 — 세션 행은 링크이기도 해서 「새 탭에서 열기」가 두 번 서고, 홈 앱 타일의
  //  「모든 앱」·알림 행의 「모두 읽음으로」는 표면에도 있다(프리뷰 실측 2026-09-09). 앞 겹(가까운 것)이 이긴다.
  const rows: CtxRow[] = [];
  const seen = new Set<string>();
  const put = (add: CtxRow[]): void => {
    const fresh = add.filter((r) => r.sep || !seen.has(r.label));
    if (!fresh.some((r) => !r.sep)) return;
    if (rows.length) rows.push({ sep: true, label: '' });
    for (const r of fresh) { rows.push(r); if (!r.sep) seen.add(r.label); }
  };
  if (item) put(item.rows);
  if (surface) put(surface.rows);
  put(commons.flatMap((f) => { try { return f(ev) || []; } catch (_) { return []; } }));
  if (!rows.length) return null;
  return { rows, title: item?.title ?? surface?.title, sub: item?.sub ?? surface?.sub };
}

function eventOf(e: MouseEvent, target: HTMLElement, root: HTMLElement, x: number, y: number): CtxEvent {
  let selection = '';
  try { selection = String(window.getSelection()?.toString() || '').trim(); } catch (_) { /* noop */ }
  // 선택이 눌린 자리와 무관하면(다른 칸의 옛 선택) 선택으로 치지 않는다.
  if (selection) {
    try {
      const sel = window.getSelection();
      const a = sel && sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
      const box = a && (a.nodeType === 1 ? (a as HTMLElement) : a.parentElement);
      if (box && !box.contains(target) && !target.contains(box)) selection = '';
    } catch (_) { /* noop */ }
  }
  const link = target.closest('a[href]') as HTMLAnchorElement | null;
  const img = (target.tagName === 'IMG' ? target : target.closest('img')) as HTMLImageElement | null;
  return { e, x, y, target, selection, link, img, root };
}

/** 프로그램에서 띄운다(길게 누르기·메뉴 키). 띄울 것이 있었으면 true. */
export function openCtxAt(target: HTMLElement, x: number, y: number, root: HTMLElement, e?: MouseEvent): boolean {
  const ev = eventOf(e || new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true }), target, root, x, y);
  const got = collectCtx(target, ev);
  if (!got) return false;
  showCtxMenu(x, y, got.rows, { title: got.title, sub: got.sub });
  return true;
}

/** 뿌리 하나에 배선을 건다(bubble 단계 — 제 메뉴를 가진 자리가 먼저 받고 preventDefault 하면 여기선 비켜 준다). */
export function mountCtxMenus(root: HTMLElement, opts: { longPress?: boolean; menuKey?: boolean } = {}): () => void {
  const onCtx = (e: MouseEvent): void => {
    if (e.defaultPrevented || e.shiftKey) return;
    const t = e.target as HTMLElement | null;
    if (!t || !(t instanceof HTMLElement)) return;
    if (t.closest(FRAME_SEL)) return;
    if (t.closest(EDIT_SEL)) return;
    const ev = eventOf(e, t, root, e.clientX, e.clientY);
    const got = collectCtx(t, ev);
    if (!got) return;                      // 아무도 할 말이 없으면 브라우저 메뉴
    e.preventDefault(); e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY, got.rows, { title: got.title, sub: got.sub });
  };
  root.addEventListener('contextmenu', onCtx);

  // 메뉴 키(≣ · ⇧F10) — 포커스 든 요소 자리에서 띄운다. 키보드만으로도 같은 메뉴에 닿게.
  const onKey = (e: KeyboardEvent): void => {
    if (!opts.menuKey) return;
    if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
    const a = document.activeElement as HTMLElement | null;
    if (!a || !root.contains(a) || a.closest(EDIT_SEL) || a.closest(FRAME_SEL)) return;
    if (ctxIsOpen()) { closeCtxMenu(); return; }
    const r = a.getBoundingClientRect();
    if (openCtxAt(a, Math.round(r.left + Math.min(24, r.width / 2)), Math.round(r.bottom - 4), root)) { e.preventDefault(); e.stopPropagation(); }
  };
  root.addEventListener('keydown', onKey);

  // 손가락으로 길게 누르기(터치) — 우클릭이 없는 자리. 550ms, 8px 넘게 움직이면 취소(레일 독과 같은 규칙).
  let lp = 0; let lpX = 0; let lpY = 0; let lpT: HTMLElement | null = null;
  const lpCancel = (): void => { if (lp) { window.clearTimeout(lp); lp = 0; } lpT = null; };
  const onDown = (e: PointerEvent): void => {
    if (!opts.longPress || e.pointerType !== 'touch') return;
    const t = e.target as HTMLElement | null;
    if (!t || t.closest(EDIT_SEL) || t.closest(FRAME_SEL)) return;
    lpCancel(); lpX = e.clientX; lpY = e.clientY; lpT = t;
    lp = window.setTimeout(() => {
      lp = 0;
      const tt = lpT; lpT = null;
      if (tt && openCtxAt(tt, lpX, lpY, root)) { try { navigator.vibrate?.(8); } catch (_) { /* noop */ } }
    }, 550);
  };
  const onMove = (e: PointerEvent): void => { if (lp && (Math.abs(e.clientX - lpX) > 8 || Math.abs(e.clientY - lpY) > 8)) lpCancel(); };
  root.addEventListener('pointerdown', onDown, true);
  root.addEventListener('pointermove', onMove, true);
  root.addEventListener('pointerup', lpCancel, true);
  root.addEventListener('pointercancel', lpCancel, true);
  return () => {
    root.removeEventListener('contextmenu', onCtx);
    root.removeEventListener('keydown', onKey);
    root.removeEventListener('pointerdown', onDown, true);
    root.removeEventListener('pointermove', onMove, true);
    root.removeEventListener('pointerup', lpCancel, true);
    root.removeEventListener('pointercancel', lpCancel, true);
  };
}
