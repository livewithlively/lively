// 머리 줄 높이 손잡이(#5319, 원준 2026-11-06 «경계 드래그해서 높이 줄이거나 키울 수 있게 · 디폴트는 지금이 좋은데 사용자가 원하면 줄일 수 있게»).
//  세션 큰 머리(session-chat.ts bigHead)와 곁칸 머리 줄 독(panes.ts dock-top)은 한 값(--pn-bighead-h, .pn-wrap)을 읽어 두 열의 아랫선이
//  한 줄이다 — 손잡이는 그 둘의 **아랫선 위 6px** 에 눕고(어느 쪽을 끌든 둘이 같이 움직인다), 끌면 .pn-wrap 의 값을 바꾼다.
//  높이에 따라 무엇이 어떻게 줄어드나는 CSS 가 그 값 하나로 푼다(42-v2-panes.css --hd-r · 42-v2-dock.css --pn-dock-row — 거기 주석의 사다리).
//  기본(113)이면 아무것도 안 적는다 — 저장값은 «기본이 아닌 때» 만. 두 번 누르면 기본으로.
import { el } from '../core.js';

export const HEAD_H = { def: 113, min: 52, max: 150 } as const;
/** 이 아래로 끌면 큰 머리가 두 줄에서 **한 줄**이 된다(원준 2026-11-06 «2열 이하로 댕겨서 줄이려면 줄일 수 있도록») — .pn-wrap.hd-one(42-v2-panes.css). */
export const ONE_ROW_BELOW = 80;
const KEY = 'v2.head.h';
const STEP = 4;   // 키보드 한 칸

export function savedHeadH(): number | null {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n >= HEAD_H.min && n <= HEAD_H.max ? n : null;
  } catch (_) { return null; }
}
export function applyHeadH(wrap: HTMLElement, h: number | null): void {
  if (h == null || h === HEAD_H.def) wrap.style.removeProperty('--pn-bighead-h');
  else wrap.style.setProperty('--pn-bighead-h', Math.round(h) + 'px');
  wrap.classList.toggle('hd-one', (h ?? HEAD_H.def) < ONE_ROW_BELOW);
}
const clampH = (h: number): number => Math.round(Math.max(HEAD_H.min, Math.min(HEAD_H.max, h)));
const currentH = (wrap: HTMLElement): number => parseFloat(getComputedStyle(wrap).getPropertyValue('--pn-bighead-h')) || HEAD_H.def;
function remember(h: number): void {
  try { if (h === HEAD_H.def) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(h)); } catch (_) { /* 저장 못 해도 이번 화면은 바뀐다 */ }
}

/** 손잡이 하나 — 큰 머리 · 곁칸 머리 줄 안에 각각 하나씩 단다(둘 다 .pn-wrap 안이라 같은 값을 민다). */
export function headGrip(): HTMLElement {
  const g = el('div', {
    class: 'pn-head-grip', role: 'separator', tabindex: '0', 'aria-orientation': 'horizontal', 'aria-label': '머리 줄 높이',
    'aria-valuemin': String(HEAD_H.min), 'aria-valuemax': String(HEAD_H.max), 'aria-valuenow': String(HEAD_H.def),
    title: '끌어서 머리 줄 높이를 바꿔요 — 두 번 누르면 기본 높이로',
  }) as HTMLElement;
  let wrap: HTMLElement | null = null;
  let y0 = 0, h0 = 0, moved = false;
  const set = (w: HTMLElement, h: number): number => { const v = clampH(h); applyHeadH(w, v); g.setAttribute('aria-valuenow', String(v)); return v; };
  g.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    wrap = g.closest('.pn-wrap') as HTMLElement | null;
    if (!wrap) return;
    y0 = e.clientY; h0 = currentH(wrap); moved = false;
    g.setPointerCapture(e.pointerId);
    g.classList.add('drag');
    document.body.classList.add('pn-head-dragging');   // 끄는 동안 프레임(터미널 · 앱)이 포인터를 삼키지 않게 · 글자 안 긁히게(CSS)
    e.preventDefault();
  });
  g.addEventListener('pointermove', (e: PointerEvent) => {
    if (!wrap || !g.hasPointerCapture(e.pointerId)) return;
    const dy = e.clientY - y0;
    if (Math.abs(dy) > 1) moved = true;
    set(wrap, h0 + dy);
  });
  const end = (e: PointerEvent): void => {
    if (!wrap || !g.hasPointerCapture(e.pointerId)) return;
    g.releasePointerCapture(e.pointerId);
    g.classList.remove('drag');
    document.body.classList.remove('pn-head-dragging');
    if (moved) remember(currentH(wrap));
    wrap = null;
  };
  g.addEventListener('pointerup', end);
  g.addEventListener('pointercancel', end);
  g.addEventListener('dblclick', () => { const w = g.closest('.pn-wrap') as HTMLElement | null; if (w) { set(w, HEAD_H.def); remember(HEAD_H.def); } });
  g.addEventListener('keydown', (e: KeyboardEvent) => {
    const w = g.closest('.pn-wrap') as HTMLElement | null;
    if (!w) return;
    const h = currentH(w);
    const next = e.key === 'ArrowUp' ? h - STEP : e.key === 'ArrowDown' ? h + STEP : e.key === 'Home' ? HEAD_H.def : null;
    if (next == null) return;
    e.preventDefault();
    remember(set(w, next));
  });
  return g;
}
