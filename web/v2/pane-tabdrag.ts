// v2/pane-tabdrag.ts — 곁칸·아래 칸 탭을 **끌어 옮기기**(#3870 «곁칸 탭 관리», 원준 2026-09-30) — 크롬 탭 문법.
//
//  종전엔 HTML5 드래그였다(draggable + dataTransfer). 반투명 고스트가 따라다니고, 떨굴 수 있는 곳은 **다른 칸의 줄**뿐이라
//  같은 줄 안에서 순서를 바꾸는 길이 아예 없었다(moveTab 이 같은 칸이면 켜기만 했다). 셸 탭 줄(tabs.ts)이 쓰던 포인터 끌기로 바꾼다.
//   · 같은 줄 안: 잡은 탭이 커서를 **그대로** 따라오고, 지나친 이웃은 잡은 탭의 폭만큼 **미끄러져** 자리를 비운다(160ms).
//     놓으면 곧바로 목록을 고친다 — 이웃은 이미 비켜 서 있어 화면은 거의 그대로다. (셸 탭 줄 tabs.ts 는 안착 애니메이션
//     160ms 뒤에 고쳤는데, 그 사이 줄이 다시 그려지면 놓은 자리가 사라지거나 죽은 화면에 reorder 가 닿는다 — 격리 리뷰 지적.)
//   · 줄 밖으로 끌어내면: 탭은 제자리에서 흐려지고 탭 모양의 조각이 커서를 따라온다. 다른 칸의 탭 줄 위면 끼울 자리에 파란 세로선,
//     그 칸의 본문 위면 줄 전체가 파랗게(맨 끝에 붙는다). 그 밖에서 놓으면 아무 일도 없다(제자리로).
//   · 고정 탭은 고정 탭끼리, 나머지는 고정 탭 뒤에서만 선다(크롬). 그 범위는 셸이 range 로 알려 준다.
//   · Esc · 창을 떠나기 · 포인터 취소 = 없던 일. 버튼이 이미 떼어진 채 움직이면(액자 · 창 밖에서 놓았다) 역시 없던 일.
//   · 끄는 동안 액자(iframe · webview)는 포인터를 못 받는다 — 세션 화면·웹·PDF 칸이 액자라, 그 위에서 놓으면 pointerup 이
//     액자 문서로 가서 끌기가 영영 안 끝났다(격리 리뷰 지적 · CSS html.pn-tab-dragging iframe). 분할선 끌기와 같은 방어다.
//  손가락(touch)은 제외 — 탭 줄은 가로로 미끄러지는 띠라 끌기를 가로채면 넘길 수가 없다.
//  ⚠ 이 파일은 탭 목록을 모른다. 셸(panes.ts)이 넘긴 줄의 DOM 을 재고, 놓은 자리만 돌려준다(reorder · moveTo).
import { dragSlot, dropSlot, type Span } from '../lib/pane-tabs.js';

export interface DragBar {
  zone: string;
  /** 탭 줄 전체(띠 + 손잡이). 파란 세로선·파란 줄이 여기에 선다. */
  bar: HTMLElement;
  /** 미끄러지는 탭 띠 — 탭(.pn-tabwrap)이 이 아래에 바로 선다. */
  tabs: HTMLElement;
  /** 그 칸 전체(줄 + 본문). 본문 위에 놓아도 그 칸으로 간다. */
  pane: HTMLElement;
}
export interface TabDragHost {
  /** 지금 보이는 칸들. */
  bars(): DragBar[];
  /** 그 탭이 그 칸으로 갈 수 있나(세션 부품은 가운데 칸 밖으로 못 나간다 · 좁은 폭엔 칸이 하나뿐). */
  canGo(key: string, from: string, to: string): boolean;
  /** 같은 줄 안에서 설 수 있는 자리 [lo, hi](줄의 자리 0..n-1) — 고정 탭 경계. */
  range(zone: string, key: string): [number, number];
  /** 같은 줄 안에서 놓았다 — to 는 놓은 뒤 그 탭이 설 줄의 자리(0..n-1). 켜기도 셸이 한다(크롬: 끈 탭이 켜진다). */
  reorder(zone: string, key: string, to: number): void;
  /** 다른 칸에 놓았다 — at 은 그 칸에 끼울 자리(0..n). */
  moveTo(key: string, from: string, to: string, at: number): void;
}

interface Target { zone: string; at: number; bar: DragBar }
interface Drag {
  host: TabDragHost; zone: string; key: string; wrap: HTMLElement; src: DragBar;
  startX: number; startY: number; pointerId: number; moved: boolean;
  els: HTMLElement[]; rects: Span[]; from: number; to: number; lo: number; hi: number;
  mode: 'strip' | 'float';
  ghost: HTMLElement | null; grabX: number; grabY: number;
  target: Target | null; caret: HTMLElement | null;
}
let drag: Drag | null = null;
let justDragged = false;
/** 누른 자리에서 이만큼은 움직여야 끌기다 — 그 안은 클릭(손떨림). */
const SLOP = 5;
/** 줄 위아래로 이만큼까지는 «줄 안» 으로 친다 — 끌면서 손이 조금 흘러도 순서 바꾸기가 풀리지 않게. */
const BAND = 18;

const spanOf = (n: HTMLElement): Span => { const r = n.getBoundingClientRect(); return { left: r.left, width: r.width }; };
const inRect = (r: DOMRect, x: number, y: number, pad = 0): boolean => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
const tabEls = (tabs: HTMLElement): HTMLElement[] => [...tabs.children].filter((n) => n.classList.contains('pn-tabwrap')) as HTMLElement[];

/** 지금 끄는 중인가(움직이기 시작한 뒤). 시험이 «끌기가 끝났다» 를 잰다(셸은 다시 그리기 전에 cancelTabDrag 를 부른다). */
export function tabDragging(): boolean { return !!drag && drag.moved; }
/** 방금 끌기로 끝난 누름의 click 인가 — 그렇다면 탭 켜기로 치지 않는다(한 번만 참). */
export function consumeDragClick(): boolean {
  if (!justDragged) return false;
  justDragged = false;
  return true;
}

/** 탭(.pn-tabwrap) 위의 pointerdown 에서 부른다. 움직이기 전까지는 아무것도 바꾸지 않는다(그냥 누르면 클릭이다). */
export function beginTabDrag(host: TabDragHost, zone: string, key: string, wrap: HTMLElement, e: PointerEvent): void {
  if (drag || e.button !== 0 || e.pointerType === 'touch') return;
  //  × 위에서 누른 것은 끌기가 아니다 — 여기서 걸러야 × 의 click 이 산다(tabs.ts 의 같은 방어, 원준 2026-08-20 신고).
  if ((e.target as HTMLElement | null)?.closest('.pn-tab-x')) return;
  const src = host.bars().find((b) => b.zone === zone);
  if (!src) return;
  const els = tabEls(src.tabs);
  const from = els.indexOf(wrap);
  if (from < 0) return;
  const [lo, hi] = host.range(zone, key);
  drag = {
    host, zone, key, wrap, src, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId, moved: false,
    els, rects: els.map(spanOf), from, to: from, lo: Math.min(lo, from), hi: Math.max(hi, from),
    mode: 'strip', ghost: null, grabX: 0, grabY: 0, target: null, caret: null,
  };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onBlur);
}

/** 끄는 중이면 없던 일로 — 셸이 줄을 다시 그려야 할 때(다른 사건으로 탭이 바뀌었다) 먼저 부른다. */
export function cancelTabDrag(): void { if (drag) finish(false); }

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !drag) return;
  e.preventDefault(); e.stopPropagation();
  finish(false);
}
function onCancel(e: PointerEvent): void { if (drag && e.pointerId === drag.pointerId) finish(false); }
function onBlur(): void { if (drag) finish(false); }

function onMove(e: PointerEvent): void {
  const d = drag;
  if (!d || e.pointerId !== d.pointerId) return;
  //  버튼이 떼어진 채 움직인다 — 놓은 곳이 이 문서 밖(액자 · 창 밖)이라 pointerup 을 못 받았다. 없던 일로.
  if ((e.buttons & 1) === 0) { finish(false); return; }
  const dx = e.clientX - d.startX;
  const dy = e.clientY - d.startY;
  if (!d.moved) {
    if (Math.hypot(dx, dy) < SLOP) return;
    d.moved = true;
    const r = d.wrap.getBoundingClientRect();
    d.grabX = d.startX - r.left; d.grabY = d.startY - r.top;
    d.src.tabs.classList.add('dnd');       // 이 클래스가 붙어 있는 동안만 이웃이 미끄러진다
    d.wrap.classList.add('dragging');
    document.documentElement.classList.add('pn-tab-dragging');   // 커서 · 글자 선택 막기
  }
  e.preventDefault();
  const inStrip = inRect(d.src.bar.getBoundingClientRect(), e.clientX, e.clientY, BAND);
  if (inStrip) stripMove(d, dx); else floatMove(d, e.clientX, e.clientY);
}

function stripMove(d: Drag, dx: number): void {
  if (d.mode === 'float') { d.mode = 'strip'; d.wrap.classList.remove('lifted'); dropGhost(d); clearTarget(d); }
  //  잡은 탭은 제 범위(고정 경계) 밖으로 나가지 않는다 — 줄 끝에서 멈춘다.
  const first = d.rects[d.lo], last = d.rects[d.hi], me = d.rects[d.from];
  const x = Math.max(first.left - me.left, Math.min(last.left + last.width - (me.left + me.width), dx));
  d.wrap.style.transform = 'translateX(' + x + 'px)';
  d.to = dragSlot(d.rects, d.from, x, d.lo, d.hi);
  const step = me.width;
  for (let i = 0; i < d.els.length; i++) {
    if (i === d.from) continue;
    const shift = (i > d.from && i <= d.to) ? -step : (i < d.from && i >= d.to) ? step : 0;
    d.els[i].style.transform = shift ? 'translateX(' + shift + 'px)' : '';
  }
}

function floatMove(d: Drag, x: number, y: number): void {
  if (d.mode === 'strip') {
    d.mode = 'float';
    d.to = d.from;
    for (const n of d.els) n.style.transform = '';
    d.wrap.classList.add('lifted');
    //  탭 모양 그대로 — 아이콘과 이름만 떼어 온다(× 는 안 가져온다).
    const face = d.wrap.querySelector('.pn-tab')?.cloneNode(true) as HTMLElement | undefined;
    d.ghost = document.createElement('div');
    d.ghost.className = 'pn-tab-ghost';
    d.ghost.setAttribute('aria-hidden', 'true');
    if (face) { face.removeAttribute('id'); face.setAttribute('tabindex', '-1'); d.ghost.append(face); }
    document.body.append(d.ghost);
  }
  if (d.ghost) { d.ghost.style.left = (x - d.grabX) + 'px'; d.ghost.style.top = (y - d.grabY) + 'px'; }
  //  과녁 — 다른 칸의 줄이면 끼울 자리, 그 칸의 본문이면 맨 끝.
  let t: Target | null = null;
  for (const b of d.host.bars()) {
    if (b.zone === d.zone || !d.host.canGo(d.key, d.zone, b.zone)) continue;
    if (inRect(b.bar.getBoundingClientRect(), x, y, 6)) { t = { zone: b.zone, at: dropSlot(tabEls(b.tabs).map(spanOf), x), bar: b }; break; }
    if (inRect(b.pane.getBoundingClientRect(), x, y)) { t = { zone: b.zone, at: tabEls(b.tabs).length, bar: b }; break; }
  }
  showTarget(d, t, x, y);
}

function showTarget(d: Drag, t: Target | null, x: number, y: number): void {
  if (d.target && (!t || t.bar !== d.target.bar)) clearTarget(d);
  d.target = t;
  if (!t) return;
  t.bar.bar.classList.add('drop');
  //  끼울 자리 세로선 — 줄 위에 있을 때만(본문 위면 줄 전체가 파랗게 = 맨 끝).
  const barR = t.bar.bar.getBoundingClientRect();
  const els = tabEls(t.bar.tabs);
  if (!inRect(barR, x, y, 6) || !els.length) { d.caret?.remove(); d.caret = null; return; }
  const at = Math.min(t.at, els.length);
  const edge = at < els.length ? els[at].getBoundingClientRect().left : els[els.length - 1].getBoundingClientRect().right;
  if (!d.caret) { d.caret = document.createElement('div'); d.caret.className = 'pn-tab-caret'; d.caret.setAttribute('aria-hidden', 'true'); }
  if (d.caret.parentElement !== t.bar.bar) t.bar.bar.append(d.caret);
  d.caret.style.left = Math.round(edge - barR.left - 1) + 'px';
}
function clearTarget(d: Drag): void {
  d.target?.bar.bar.classList.remove('drop');
  d.caret?.remove(); d.caret = null;
  d.target = null;
}
function dropGhost(d: Drag): void { d.ghost?.remove(); d.ghost = null; }

function onUp(e: PointerEvent): void {
  const d = drag;
  if (!d || e.pointerId !== d.pointerId) return;
  if (!d.moved) { finish(false); return; }
  e.preventDefault();
  finish(true);
}

function detach(): void {
  window.removeEventListener('pointermove', onMove, true);
  window.removeEventListener('pointerup', onUp, true);
  window.removeEventListener('pointercancel', onCancel, true);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', onBlur);
}
function clearStyles(d: Drag): void {
  for (const n of d.els) { n.style.transform = ''; n.style.transition = ''; }
  d.wrap.classList.remove('dragging', 'lifted');
  d.src.tabs.classList.remove('dnd');
  document.documentElement.classList.remove('pn-tab-dragging');
  dropGhost(d); clearTarget(d);
}

function finish(apply: boolean): void {
  const d = drag;
  if (!d) return;
  drag = null;
  detach();
  if (d.moved) {
    //  끌기로 끝난 누름 — 바로 뒤따를 click 은 탭 켜기가 아니다. 그 click 이 안 오면(노드가 다시 그려짐) 다음 틱에 푼다.
    justDragged = true;
    window.setTimeout(() => { justDragged = false; }, 0);
  }
  if (!apply || !d.moved) { clearStyles(d); return; }
  if (d.mode === 'float') {
    const t = d.target;
    clearStyles(d);
    if (t) d.host.moveTo(d.key, d.zone, t.zone, t.at);
    return;
  }
  //  줄 안 — 곧바로 목록을 고친다(셸이 다시 그린다).
  clearStyles(d);
  d.host.reorder(d.zone, d.key, d.to);
}
