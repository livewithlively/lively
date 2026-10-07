// v2/side-card.ts: 우측 사이드바가 화면을 다 차지하면 세션이 카드가 된다 (#3870, 원준 2026-09-27)
//
//  ── 무엇을 하나 ──
//  세션과 사이드바 사이의 손잡이를 세션 쪽 끝까지 끌면, 세션 열이 최소 폭(360px)에서 멈춘 뒤에도 손잡이는 손을
//  따라간다. 그 구간이 카드 전환 구간이다. 구간의 30% 를 넘겨 손을 놓으면 사이드바가 격자 전체를 차지하고
//  세션은 그 위에 놓인 카드가 된다. 카드는 머리줄을 끌어 옮기고, 가장자리를 끌어 크기를 바꾼다. 자리와 크기는
//  브라우저에 적어 사람마다 자기 크기로 쓴다.
//
//  ── ⚠ 지키는 제약: 세션 화면은 iframe 이다 ──
//  iframe 은 부모가 바뀌면 다시 로드된다(v2/side-swap.ts 머리말). 그래서 세션 열(.pn-col)을 옮겨 붙이지 않는다.
//  같은 요소를 격자 안에서 position: absolute 로 놓고 자리와 크기만 바꾼다. scale 로 줄이지도 않는다. 터미널
//  글자가 찌그러진다. 크기가 바뀌면 터미널이 스스로 다시 맞춘다.
//
//  ── 끄는 방향 ──
//  평소엔 세션이 왼쪽이라 왼쪽 끝까지, 자리바꿈 뒤엔 세션이 오른쪽이라 오른쪽 끝까지 끈다. 손잡이의 부호는
//  panes.ts 가 이미 자리(sw-left)에 맞춰 뒤집으므로, 여기서는 «상한을 넘겨 끈 거리» 만 받는다.
//
//  ── 움직임 ──
//  끄는 동안: 사이드바가 세션 위를 덮고 세션은 흐려진다(--cm-over, --cm-p 두 변수를 CSS 가 읽는다).
//  놓을 때: 사이드바가 끝까지 덮은 뒤 카드가 제자리에서 28px 아래부터 올라오며 나타난다.
//  되돌릴 때: 카드가 사라지고, 사이드바가 상한까지 물러나며 세션 열이 또렷해진다.
import { el } from '../core.js';
import { MOBILE_MQ } from './mobile.js';
import { pnIcon } from './panes-kit.js';
import {
  CARD_DEF, type CardEdge, type CardState, clampCard, moveCard, overProgress, overZone, parseCard, resizeCard, shouldCommit, sideCap,
} from '../lib/side-card-geom.js';

const KEY_CARD = 'lively_v2_side_card';   // 카드의 자리 · 크기 · 접힘. 브라우저마다(사람마다) 하나다.
const EDGES: CardEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export interface SideCardHost {
  body: HTMLElement;        // .pn-body 격자
  colMain: HTMLElement;     // 세션 열. 카드가 되는 요소다
  sidePane: HTMLElement;    // 우측 사이드바
  sideOn: () => boolean;    // 사이드바가 펴져 있나
  /** 사이드바 폭을 상한으로 맞춘다. persist 가 참이면 이 세션의 폭으로 적는다. 세션에 들어올 때는 화면만 맞춘다. */
  setSideW: (px: number, persist: boolean) => void;
  /** 카드가 되거나 풀릴 때. 셸이 이 세션의 것으로 적는다. */
  onChange?: (card: boolean) => void;
  /** 사이드바가 상한 폭일 때의 자리를 조용히 정한다(자리바꿈 판정, 움직임과 안내 없음). 카드가 된 직후와 돌아오기 직전에 부른다. */
  settle?: (sideW: number) => void;
  /** 세션이 열로 돌아온 직후. */
  onLeft?: () => void;
}

export interface SideCardHandle {
  active: () => boolean;
  /** 끄는 중. 상한을 넘긴 거리(px, 0 이상). */
  onOver: (overPx: number) => void;
  /** 손을 놓았다. 카드 전환 구간에서 놓았으면 true. 덜 넘겨 놓았으면(카드가 안 된다) 사이드바가 상한으로 물러난 **뒤**
   *  `back` 을 부른다 — 셸은 거기서 자리바꿈을 판정하고 폭을 적는다. 세션 열이 최소 폭에 닿고 손이 조금이라도 더 가면
   *  이 구간이라, 여기서 판정을 건너뛰면 자리바꿈이 사라진다(원준 2026-10-01 «세션이 30% 로 작아져도 좌우가 안 바뀐다»). */
  onRelease: (back?: () => void) => boolean;
  /** 세션에 들어올 때. 움직임 없이 그 세션의 상태를 입힌다. */
  restore: (card: boolean) => void;
  /** 사이드바 여닫기 · 폭 문턱이 바뀐 뒤 다시 그린다. */
  sync: () => void;
  /** 세션을 열로 되돌린다. */
  leave: () => void;
  destroy: () => void;
}

const reduceMotion = (): boolean => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
};
const narrow = (): boolean => { try { return window.matchMedia(MOBILE_MQ).matches; } catch (_) { return false; } };

// cubic-bezier(.2,.8,.2,1) 과 (0,0,.2,1). 변수 값을 프레임마다 적어야 해서 CSS transition 대신 직접 센다.
const bez = (x1: number, y1: number, x2: number, y2: number) => {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const fx = (t: number) => ((ax * t + bx) * t + cx) * t, fy = (t: number) => ((ay * t + by) * t + cy) * t, dfx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number): number => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) { const d = fx(t) - x, s = dfx(t); if (Math.abs(d) < 1e-5 || !s) break; t -= d / s; }
    return fy(t);
  };
};
const EASE = bez(.2, .8, .2, 1), OUT = bez(0, 0, .2, 1);

/** alive 가 거짓이 되면 그 자리에서 멈춘다(마지막 프레임을 그리지 않는다). 세션이 바뀌었거나 화면이 걷힌 뒤다. */
function tween(ms: number, ease: (x: number) => number, fn: (t: number) => void, alive: () => boolean): Promise<void> {
  return new Promise((res) => {
    if (!alive()) { res(); return; }
    if (reduceMotion() || ms <= 0) { fn(1); res(); return; }
    const t0 = performance.now();
    const step = (now: number): void => {
      if (!alive()) { res(); return; }
      const x = Math.max(0, Math.min(1, (now - t0) / ms));
      fn(ease(x));
      if (x < 1) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
}

export function mountSideCard(h: SideCardHost): SideCardHandle {
  const { body, colMain } = h;
  let on = false;           // 이 세션이 카드 상태인가
  let busy = false;         // 움직이는 중(겹쳐 누르지 않게)
  let over = 0;             // 지금 상한을 넘겨 끈 거리
  let dead = false;
  //  움직임의 판 번호. 세션이 바뀌거나(restore) 화면이 걷히면(destroy) 올린다. 움직이던 함수는 기다린 뒤마다
  //  자기 판이 아직 살아 있는지 보고, 아니면 아무것도 적지 않고 끝난다. 안 그러면 움직이는 도중 세션을 바꿨을 때
  //  앞 세션의 «카드가 됐다» 가 새로 연 세션에 적힌다(격리 리뷰 지적, 2026-09-27).
  let gen = 0;
  let stopDrag: (() => void) | null = null;   // 카드를 끌고 있으면 그 끌기를 끝내는 함수
  let card: CardState = ((): CardState => { try { return parseCard(localStorage.getItem(KEY_CARD)); } catch (_) { return parseCard(null); } })();

  const bw = (): number => body.clientWidth;
  //  카드가 움직일 수 있는 범위는 **창 전체**다(원준 2026-10-07 «곁칸 안쪽으로 너무 제한적»). 카드는 position: fixed 라
  //   자리(r · b)도 창의 오른쪽 · 아래 가장자리에서 센다. 사이드바 폭 셈(상한 · 전환 구간)은 그대로 격자(bw)로 한다.
  //   격자가 화면에 없으면(다른 탭) 카드도 없다 — 창 크기는 늘 재지므로 판정은 bw() > 0 으로 한다.
  const vw = (): number => document.documentElement.clientWidth || window.innerWidth;
  const vh = (): number => document.documentElement.clientHeight || window.innerHeight;
  //  이 칸 셸이 화면에 없을 수 있다(다른 탭을 보고 있다). 그때 격자 폭은 0 이고, 0 으로 센 상한은 뜻이 없다.
  //  폭을 못 재면 사이드바 폭을 적지 않는다(잴 수 있을 때 다시 맞춘다).
  const capNow = (): number | null => (bw() > 0 ? sideCap(bw()) : null);
  const shown = (): boolean => on && h.sideOn() && !narrow();
  const save = (): void => { try { localStorage.setItem(KEY_CARD, JSON.stringify(card)); } catch (_) { /* 적지 못해도 이번 화면은 된다 */ } };

  // ── 끄는 중 예고 ──
  const hint = el('div', { class: 'sw-hint cm-hint', hidden: true }) as HTMLElement;
  // ── 카드 머리줄 오른쪽의 단추 둘: 제자리로 · 접기 ──
  const dockBtn = el('button', { class: 'cm-ic', type: 'button', title: '세션을 제자리로 되돌립니다', 'aria-label': '세션 제자리로', onclick: () => leave() },
    pnIcon('cols', 'pn-i sm')) as HTMLButtonElement;
  const foldBtn = el('button', { class: 'cm-ic cm-fold-b', type: 'button', onclick: () => setFold(!card.fold) },
    pnIcon('chev', 'pn-i sm')) as HTMLButtonElement;
  const ctl = el('div', { class: 'cm-ctl', hidden: true }, dockBtn, foldBtn) as HTMLElement;
  // ── 크기 조절 손잡이 여덟 ──
  const grips = EDGES.map((e) => el('div', { class: 'cm-grip cm-grip-' + e, 'data-edge': e, hidden: true, 'aria-hidden': 'true' }) as HTMLElement);
  colMain.append(ctl, ...grips);
  body.append(hint);

  function paintFold(): void {
    foldBtn.title = card.fold ? '카드를 폅니다' : '카드를 접습니다. 머리줄만 남습니다';
    foldBtn.setAttribute('aria-label', card.fold ? '카드 펴기' : '카드 접기');
    foldBtn.setAttribute('aria-expanded', String(!card.fold));
  }

  /** 최소화한 카드의 보이는 높이(머리줄 + 테두리) — 자리의 세로 범위를 이 높이로 센다(lib clampCard). 펴 있으면 undefined. */
  const foldH = (): number | undefined => {
    if (!card.fold) return undefined;
    const head = colMain.querySelector('.sc-head') as HTMLElement | null;
    return (head?.offsetHeight || 42) + 2;
  };
  /** 카드의 자리와 크기를 화면에 입힌다. */
  function paintRect(): void {
    if (!(bw() > 0 && vw() > 0 && vh() > 0)) return;
    const c = clampCard(card, vw(), vh(), foldH());
    body.style.setProperty('--cm-w', c.w + 'px');
    body.style.setProperty('--cm-h', c.h + 'px');
    body.style.setProperty('--cm-r', c.r + 'px');
    body.style.setProperty('--cm-b', c.b + 'px');
  }

  function paint(): void {
    const s = shown();
    body.classList.toggle('cm', s);
    body.classList.toggle('cm-fold', s && card.fold);
    ctl.hidden = !s;
    for (const g of grips) g.hidden = !s || card.fold;
    if (s) { paintRect(); paintFold(); }
  }

  function setFold(v: boolean): void {
    //  펼 때: 최소화한 채 창 위쪽에 올려 둔 카드는 편 높이로 다시 세어 창 안으로 내려온다 — 그 자리를 적어 둔다.
    card = v ? { ...card, fold: true } : { ...clampCard(card, vw(), vh()), fold: false };
    save();
    paint();
  }

  // ── 끄는 중: 사이드바가 세션 위를 덮는다 ──
  function paintOver(px: number): void {
    const p = overProgress(px, bw());
    body.classList.toggle('cm-over', px > 0);
    body.style.setProperty('--cm-over', Math.max(0, Math.round(px)) + 'px');
    body.style.setProperty('--cm-p', String(Math.round(p * 1000) / 1000));
  }
  function clearOver(): void {
    body.classList.remove('cm-over');
    body.style.removeProperty('--cm-over');
    body.style.removeProperty('--cm-p');
  }

  function onOver(px: number): void {
    if (dead || busy || on || !h.sideOn() || narrow() || !(bw() > 0)) return;
    over = Math.max(0, Math.min(px, overZone(bw())));
    paintOver(over);
    if (over <= 0) { hint.hidden = true; return; }
    hint.textContent = shouldCommit(overProgress(over, bw())) ? '놓으면 세션이 카드로 바뀝니다' : '더 끌면 세션이 카드로 바뀝니다';
    hint.hidden = false;
  }

  function onRelease(back?: () => void): boolean {
    hint.hidden = true;
    if (dead || busy || on || over <= 0) { over = 0; return false; }
    const from = over;
    over = 0;
    if (shouldCommit(overProgress(from, bw()))) void enter(from);
    else void cancel(from, back);
    return true;
  }

  /** 덜 넘기고 놓았다. 사이드바가 상한으로 물러난 뒤 back(자리바꿈 판정)을 부른다 — 물러나는 동안 자리가 미끄러지면 두 움직임이 겹친다. */
  async function cancel(from: number, back?: () => void): Promise<void> {
    const g = ++gen, alive = (): boolean => !dead && g === gen;
    busy = true;
    await tween(200, EASE, (t) => paintOver(from * (1 - t)), alive);
    if (!alive()) return;
    clearOver();
    busy = false;
    back?.();
  }

  /** 카드로 바꾼다. from = 놓은 순간 넘겨 있던 거리. */
  async function enter(from: number): Promise<void> {
    const g = ++gen, alive = (): boolean => !dead && g === gen;
    busy = true;
    const zone = overZone(bw());
    const p0 = overProgress(from, bw());
    await tween(Math.max(120, 220 * (1 - p0)), OUT, (t) => paintOver(from + (zone - from) * t), alive);
    if (!alive()) return;
    // 사이드바가 다 덮었다. 여기서 배치를 카드로 바꾼다(세션 열은 가려져 있어 바뀌는 순간이 안 보인다).
    on = true;
    const cap = capNow();
    if (cap !== null) h.setSideW(cap, true);
    clearOver();
    paint();
    h.onChange?.(true);
    if (cap !== null) h.settle?.(cap);
    if (!reduceMotion() && typeof colMain.animate === 'function') {
      try {
        await colMain.animate(
          [{ opacity: 0, transform: 'translateY(28px) scale(.94)' }, { opacity: 1, transform: 'none' }],
          { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished;
      } catch (_) { /* 움직임이 끊겨도 카드는 서 있다 */ }
    }
    if (!alive()) return;
    busy = false;
  }

  /** 세션을 열로 되돌린다. */
  async function leave(): Promise<void> {
    if (dead || busy || !on) return;
    const g = ++gen, alive = (): boolean => !dead && g === gen;
    busy = true;
    stopDrag?.();
    const vis = shown() && bw() > 0;
    if (vis && !reduceMotion() && typeof colMain.animate === 'function') {
      try {
        await colMain.animate(
          [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(16px) scale(.97)' }],
          { duration: 160, easing: 'cubic-bezier(0,0,.2,1)', fill: 'forwards' }).finished;
      } catch (_) { /* noop */ }
    }
    if (!alive()) return;
    on = false;
    const cap = capNow();
    const back = vis && cap !== null;    // 물러나는 움직임을 보여 줄 수 있나
    const zone = back ? overZone(bw()) : 0;
    if (cap !== null) { h.setSideW(cap, true); h.settle?.(cap); }
    if (back) paintOver(zone);           // 세션 열이 제자리로 가는 순간은 사이드바가 덮고 있다
    paint();
    h.onChange?.(false);
    for (const a of colMain.getAnimations?.() ?? []) a.cancel();
    if (back) await tween(220, EASE, (t) => paintOver(zone * (1 - t)), alive);
    if (!alive()) return;
    clearOver();
    busy = false;
    h.onLeft?.();
  }

  /** 움직이던 것을 그 자리에서 끝낸다. 세션이 바뀌었거나 화면이 걷힐 때. 아무것도 적지 않는다. */
  function halt(): void {
    gen++;
    busy = false;
    over = 0;
    hint.hidden = true;
    stopDrag?.();
    for (const a of colMain.getAnimations?.() ?? []) a.cancel();
    clearOver();
  }

  function restore(v: boolean): void {
    halt();
    on = !!v;
    const cap = capNow();
    if (on && cap !== null && h.sideOn() && !narrow()) h.setSideW(cap, false);
    paint();
  }

  // ── 카드 옮기기(머리줄을 끈다) · 크기 바꾸기(가장자리를 끈다) ──
  const INTERACTIVE = 'button, a, input, select, textarea, [contenteditable], [role="button"], .cm-grip';
  function dragStart(e: PointerEvent, kind: 'move' | CardEdge, grab: HTMLElement): void {
    if (e.button !== 0 || !shown() || busy || stopDrag || !(bw() > 0)) return;     // 끌기는 한 번에 하나(손가락 둘이 서로 다른 손잡이를 잡지 않게)
    e.preventDefault();
    const fh = foldH();
    const base = clampCard(card, vw(), vh(), fh);
    const x0 = e.clientX, y0 = e.clientY;
    try { grab.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    document.body.classList.add('cm-dragging');
    const move = (ev: PointerEvent): void => {
      if (dead || !shown() || !(bw() > 0)) return;
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      const c = kind === 'move' ? moveCard(base, dx, dy, vw(), vh(), fh) : resizeCard(base, kind, dx, dy, vw(), vh());
      card = { ...c, fold: card.fold };
      paintRect();
    };
    let done = false;
    const end = (persist: boolean): void => {
      if (done) return;
      done = true;
      stopDrag = null;
      document.body.classList.remove('cm-dragging');
      grab.removeEventListener('pointermove', move); grab.removeEventListener('pointerup', up); grab.removeEventListener('pointercancel', up);
      try { grab.releasePointerCapture(e.pointerId); } catch (_) { /* 이미 놓였다 */ }
      if (persist && !dead && bw() > 0) save();
    };
    const up = (): void => end(true);
    stopDrag = () => end(false);
    grab.addEventListener('pointermove', move); grab.addEventListener('pointerup', up); grab.addEventListener('pointercancel', up);
  }
  const onHeadDown = (e: PointerEvent): void => {
    const t = e.target as HTMLElement | null;
    if (!t || !shown()) return;
    const head = t.closest('.sc-head') as HTMLElement | null;
    if (!head || !colMain.contains(head) || t.closest(INTERACTIVE)) return;
    dragStart(e, 'move', head);
  };
  colMain.addEventListener('pointerdown', onHeadDown);
  for (const g of grips) g.addEventListener('pointerdown', (e) => dragStart(e as PointerEvent, g.dataset.edge as CardEdge, g));
  // 글쇠로도 된다(split.ts 와 같은 기준: 마우스만 되는 손잡이는 두지 않는다). 왼쪽 위 손잡이 하나가 초점을 받는다.
  //  화살표 = 크기(왼쪽 위 모서리를 옮긴다) · Shift+화살표 = 자리 · Home = 기본 크기와 자리.
  const keyGrip = grips[EDGES.indexOf('nw')];
  keyGrip.removeAttribute('aria-hidden');
  keyGrip.tabIndex = 0;
  keyGrip.setAttribute('role', 'button');
  keyGrip.setAttribute('aria-label', '카드 크기와 자리. 화살표는 크기, Shift 와 화살표는 자리, Home 은 기본값');
  keyGrip.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!shown() || busy) return;
    const d: Record<string, [number, number]> = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] };
    const fh = foldH();
    const base = clampCard(card, vw(), vh(), fh);
    let next = null as ReturnType<typeof clampCard> | null;
    if (e.key === 'Home') next = clampCard(CARD_DEF, vw(), vh());
    else if (d[e.key]) next = e.shiftKey ? moveCard(base, d[e.key][0], d[e.key][1], vw(), vh(), fh) : resizeCard(base, 'nw', d[e.key][0], d[e.key][1], vw(), vh());
    if (!next) return;
    e.preventDefault();
    card = { ...next, fold: card.fold };
    paintRect();
    save();
  });
  // 머리줄을 두 번 누르면 접거나 편다.
  const onHeadDbl = (e: MouseEvent): void => {
    const t = e.target as HTMLElement | null;
    if (!t || !shown() || !t.closest('.sc-head') || t.closest(INTERACTIVE)) return;
    setFold(!card.fold);
  };
  colMain.addEventListener('dblclick', onHeadDbl);

  // 격자 크기가 바뀌면(창 · 왼쪽 사이드바 폭) 카드를 창 안으로 다시 넣는다.
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      if (dead) return;
      if (!(bw() > 0)) { stopDrag?.(); return; }      // 이 칸 셸이 화면에서 내려갔다(다른 탭). 끌던 것을 끝낸다
      if (shown() && !busy) paintRect();
    });
    ro.observe(body);
  }
  //  카드는 창 기준이라 창 크기가 바뀌면 창 안으로 다시 넣는다(격자 폭이 그대로여도 창 높이는 바뀔 수 있다).
  const onWinResize = (): void => { if (!dead && shown() && !busy) paintRect(); };
  window.addEventListener('resize', onWinResize);

  paint();

  return {
    active: () => on,
    onOver, onRelease, restore,
    sync: () => paint(),
    leave: () => { void leave(); },
    destroy: () => {
      halt();
      dead = true;
      on = false;
      ro?.disconnect();
      colMain.removeEventListener('pointerdown', onHeadDown);
      colMain.removeEventListener('dblclick', onHeadDbl);
      window.removeEventListener('resize', onWinResize);
      document.body.classList.remove('cm-dragging');
      body.classList.remove('cm', 'cm-fold', 'cm-over');
      for (const k of ['--cm-w', '--cm-h', '--cm-r', '--cm-b', '--cm-over', '--cm-p']) body.style.removeProperty(k);
      ctl.remove(); hint.remove();
      for (const g of grips) g.remove();
    },
  };
}
