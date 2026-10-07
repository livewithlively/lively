// v2/side-swap.ts — **메인으로 보는 칸이 가운데로 온다** (#1819 원준 2026-08-21)
//
//  ── 왜 ──
//  곁칸(오른쪽)을 화면 절반 넘게 키운다는 건 "이제 이걸 메인으로 본다"는 뜻이다 — 장표·자료를 펴 놓고
//  그걸 보면서 왼쪽 세션에 타이핑한다. 그런데 정작 메인으로 보는 것이 화면 오른쪽 끝에 붙어 있는 건
//  부자연스럽다. 작업마다 메인으로 쓰는 화면이 다르므로, **지금 크게 본 것이 가운데에 오도록** 자리를 바꾼다.
//  (네 가지 방식을 만들어 화면에서 갈아 끼우며 골랐다 — 자리바꿈 채택, 원준 2026-08-21.)
//
//  ── ⚠ 이 파일이 지키는 단 하나의 제약: 세션 화면(터미널)은 iframe 이다 ──
//  iframe 은 DOM 에서 부모가 바뀌면 **통째로 다시 로드된다**(web/session-chat.ts 의 .sc-term-frame).
//  그래서 자리를 바꿀 때 요소를 옮겨 붙이지 않는다 — 격자 칸 지정(grid-column)만 바꾼다. 실측: 좌우를
//  여러 번 오가도 iframe load 0 회(터미널·스크롤·입력 중이던 글자 그대로).
//
//  ── 자연스럽게 만드는 세 가지 ──
//   ① **놓는 순간에만** 판정한다 — 끌던 중에 좌우가 바뀌면 손잡이가 손 밑에서 뒤집혀(끄는 방향과 반대로
//      자란다) 어지럽다. 끄는 동안엔 "놓으면 이 칸이 왼쪽으로 갑니다"만 띄운다.
//   ② 되돌아오는 문턱을 넘어가는 문턱보다 낮게 둔다(52% / 46%) — 같은 값이면 경계에서 손이 떨릴 때마다
//      화면이 깜빡인다.
//   ③ 자리는 **미끄러져** 바뀐다(FLIP) — 격자를 바꾸면 브라우저는 즉시 점프시키는데, 점프는 무슨 일이
//      일어났는지를 감추고 미끄러짐은 그걸 보여 준다.
//
//  ── 처음 겪는 사람에게는 설명이 먼저다 ──
//  아무 예고 없이 화면 절반이 좌우로 뒤집히면 그건 고장으로 읽힌다. 그래서 **처음 자리가 바뀌는 그 순간**
//  왜 이렇게 했는지와 끄는 법을 안내한다(다시 보지 않기 체크). 끄면 종전처럼 곁칸이 늘 오른쪽에 고정된다.
import { anchoredPopover, el, toast } from '../core.js';
import { MOBILE_MQ } from './mobile.js';   // 좁은 폭 문턱(900) — 셸과 같은 값 하나만 둔다
import { overlay } from '../ui-primitives.js';
import { SIDE_DEF, SIDE_MIN, sideCap } from '../lib/side-card-geom.js';
import { SWAP_TH, judgeSwap, placeOnRestore, swapThFor } from '../lib/side-swap-judge.js';
import { swapCopy } from '../lib/side-label.js';   // 칸 이름은 지금 선 쪽을 따른다(왼쪽에 선 칸을 «우측» 이라 부르지 않게)

const KEY_OFF = 'lively_v2_side_swap_off';       // '1' = 자리 고정(자동 자리바꿈 끔)
const KEY_INTRO = 'lively_v2_side_swap_intro';   // '1' = 첫 안내를 다시 보지 않음
const SIDE_VAR = '--pn-side-w';
const DEF_SIDE_W = SIDE_DEF;   // 곁칸 기본 폭은 한 값(side-card-geom.ts)

/** 넘어갈 때와 돌아올 때의 문턱(히스테리시스) — 경계에서 깜빡이지 않게. 값과 판정은 lib/side-swap-judge.ts 에 있다. */
const TH = SWAP_TH;
/** **사람이 손잡이를 끌어 놓을 때만** 쓰는 문턱. 좁은 격자에서는 사이드바 상한이 52% 에 못 미쳐 상한에 닿는 것이 문턱이다(swapThFor).
 *  ⚠ 세션에 들어올 때 · 격자 폭이 바뀔 때 · 켜기 단추에는 쓰지 않는다(격리 리뷰): 좁은 격자에서는 기본 340px 사이드바도 상한에 걸려
 *   «상한에 닿았다» 가 되므로, 아무것도 끌지 않았는데 자리가 왼쪽으로 뒤집히고 안내 창까지 떴다. 그 경로들은 종전 문턱(52 / 46) 그대로다. */
const thByHand = (bodyW: number) => swapThFor(bodyW, sideCap(bodyW), SIDE_MIN);

/** 사이드바 상한. **격자 폭**에서 세션 최소 폭(360px)과 손잡이를 뺀 값이다(lib/side-card-geom.ts sideCap).
 *  종전엔 창 폭의 88% 였다. 격자는 레일과 왼쪽 사이드바를 뺀 폭이라 그 상한이 격자를 넘었고, 끝까지 끌면 세션 열이
 *  0px 가 되어 손잡이를 찾을 수 없었다(#3870, 2026-09-27 매니지드 실측: 1440px 창에서 사이드바 1037px · 세션 0px).
 *  상한을 넘겨 더 끄는 구간은 세션 카드 전환이 받는다(v2/side-card.ts).
 *  자리 고정을 켜 둔 사람에게도 같은 상한을 준다(넓게 쓰고 싶은 것과 자리를 바꾸는 것은 다른 요구다). */
export const maxSideWidth = (bodyW: number): number => sideCap(bodyW);

const read = (k: string): boolean => { try { return localStorage.getItem(k) === '1'; } catch (_) { return false; } };
const write = (k: string, v: boolean): void => { try { if (v) localStorage.setItem(k, '1'); else localStorage.removeItem(k); } catch (_) { /* noop */ } };

/** 자동 자리바꿈이 켜져 있나(기본 켜짐). */
//  ⚠ 좁은 폭(≤900px)에선 곁칸이 아예 접혀 있다(42-v2-panes.css) — 그런데 폭 변수(--pn-side-w)는 남아 있어 «곁칸이
//   화면 절반을 넘었다» 로 판정돼 세션을 열 때마다 자리바꿈 안내 창이 떴다(#4088 폰 실측). 곁칸이 없는 폭에선 «없는 이야기»다.
const narrow = (): boolean => { try { return window.matchMedia(MOBILE_MQ).matches; } catch (_) { return false; } };   // = 42-v2-panes.css 곁칸 접힘 문턱
export const swapEnabled = (): boolean => !read(KEY_OFF) && !narrow();

export interface SideSwapHost {
  body: HTMLElement;        // .pn-body — 격자 그 자체
  colMain: HTMLElement;     // 세션(터미널)이 든 열
  sidePane: HTMLElement;    // 곁칸
  sideOn: () => boolean;    // 곁칸이 펴져 있나
  /** 자리가 바뀔 때마다 — 셸이 **이 세션의 것**으로 적어 둔다(#762). 없으면 아무 데도 안 남는다. */
  onChange?: (swapped: boolean) => void;
  /** 참이면 격자 폭이 바뀌어도 자리를 다시 판정하지 않는다(세션 카드 상태, #3870). */
  holdSwap?: () => boolean;
  /** 자리가 달라져 보일 때마다. 적지는 않는다. 칸 이름을 부르는 글을 지금 선 쪽에 맞추는 데 쓴다. */
  onPlace?: (swapped: boolean) => void;
}

export interface SideSwapHandle {
  maxSideW: () => number;
  onDrag: (px: number) => void;
  onEnd: (px: number) => void;
  /** 세션에 들어올 때 — 적어 둔 자리가 있으면 **그대로**, 없으면 폭으로 판정한다. 미끄러지지 않는다(첫 그림이다). */
  restore: (px: number, swapped?: boolean) => void;
  button: () => HTMLElement;
  sync: () => void;
  /** 끄는 중 예고를 걷는다. 세션 카드 전환 구간에서는 그쪽 예고만 보인다(#3870). */
  quiet: () => void;
  /** 자리가 바뀐 것을 처음 겪는 사람에게 안내를 띄운다. 이미 «다시 보지 않기» 를 골랐으면 아무 일도 없다. */
  introOnce: () => void;
  /** 지금 사이드바가 왼쪽에 서 있나. */
  swapped: () => boolean;
  destroy: () => void;
}

const reduceMotion = (): boolean => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
};

/** 자리가 바뀔 때 미끄러지게 — 바뀐 뒤 위치에서 옛 위치로 되돌려 놓고 0 으로 되돌린다(FLIP). */
function slide(els: HTMLElement[], mutate: () => void): void {
  if (reduceMotion()) { mutate(); return; }
  const before = els.map((e) => e.getBoundingClientRect());
  mutate();
  const after = els.map((e) => e.getBoundingClientRect());
  els.forEach((e, i) => {
    const dx = before[i].left - after[i].left;
    if (!dx || Math.abs(dx) < 2) return;
    e.style.transition = 'none';
    e.style.transform = 'translateX(' + dx + 'px)';
    requestAnimationFrame(() => {
      e.style.transition = 'transform .26s cubic-bezier(.4,0,.2,1)';
      e.style.transform = '';
      window.setTimeout(() => { e.style.transition = ''; e.style.transform = ''; }, 320);
    });
  });
}

export function mountSideSwap(h: SideSwapHost): SideSwapHandle {
  const { body, colMain, sidePane } = h;
  let swapped = false;      // 곁칸이 왼쪽인가
  let dead = false;

  // 끄는 중 예고 — "지금 놓으면 이렇게 됩니다"
  const hint = el('div', { class: 'sw-hint', hidden: true }) as HTMLElement;
  body.append(hint);

  const ratio = (px: number): number => {
    const w = body.clientWidth || window.innerWidth;
    return w > 0 ? px / w : 0;
  };
  /** 적어 둔 폭(--pn-side-w). 보이는 폭은 이것과 상한 가운데 작은 쪽이다(42-v2-panes.css --pn-side-fit). */
  const storedSideW = (): number => {
    const raw = getComputedStyle(body).getPropertyValue(SIDE_VAR).trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : DEF_SIDE_W;
  };
  const capNow = (): number => maxSideWidth(body.clientWidth);
  /** 지금 **보이는** 사이드바 폭. 자리 판정은 보이는 폭으로 한다. */
  const curSideW = (): number => Math.min(storedSideW(), capNow());

  function paint(): void {
    body.classList.toggle('sw-left', swapped);
    btn.hidden = !h.sideOn();      // 곁칸을 접어 두었으면 자리바꿈도 없는 이야기다
    paintBtn();
  }

  /** persist 가 거짓이면 보여 주기만 하고 이 세션의 자리로 적지 않는다(onChange 를 부르지 않는다). */
  function setSwapped(v: boolean, animate = true, persist = true): void {
    if (swapped === v) return;
    swapped = v;
    if (animate) slide([colMain, sidePane], paint); else paint();
    if (persist) h.onChange?.(v); else h.onPlace?.(v);
  }

  // ── 세션에 들어올 때 (#762, 원준 2026-09-04 "나갔다 들어오더라도 위치 기억되게") ────────────
  //  ⚠ 종전엔 이 부품이 서는 순간(mount) 폭을 재 한 번 판정했는데, 그때는 셸이 **이 세션의 폭을 아직 안 입힌
  //   뒤**라 늘 기본 340px 로 「안 바꿈」이 됐다. 그 뒤 셸이 폭만 900px 로 바꾸니 «넓은 곁칸이 오른쪽에
  //   그대로» 서고, 손잡이를 한 번 끌어야 자리가 바뀌었다. 판정은 폭을 입힌 **뒤**에 셸이 부른다.
  //  ⚠ 폭만으로 되살리면 문턱 사이(46~52%)에 둔 자리가 뒤집힌다(넘어갈 땐 52, 돌아올 땐 46 이라 그 사이는
  //   «지금 상태 유지»인데, 새로 들어온 판에는 '지금 상태'가 없다). 그래서 셸이 적어 둔 자리를 먼저 믿는다.
  function restore(px: number, remembered?: boolean): void {
    hideHint();
    if (!swapEnabled()) { setSwapped(false, false); return; }
    //  보여 줄 자리는 lib/side-swap-judge.ts placeOnRestore 가 정한다. 적어 둔 «왼쪽» 이 지금 폭과 안 맞으면(46% 이하)
    //  오른쪽으로 **보여 주기만** 하고 적어 둔 값은 건드리지 않는다. 넓은 창에서 바꾼 자리를 좁은 창이 지우지 않게.
    //  px 는 적어 둔 폭이다. 판정은 **보이는 폭**(상한에 걸린 폭)으로 한다.
    const shownW = body.clientWidth > 0 ? Math.min(px, capNow()) : px;
    const want = placeOnRestore({ enabled: true, remembered, ratio: ratio(shownW), measurable: body.clientWidth > 0, cur: swapped });
    const keepStored = typeof remembered === 'boolean' && want !== remembered;
    setSwapped(want, false, !keepStored);
  }

  // ── 판정 — **놓는 순간에만** ────────────────────────────────────────────────
  //  byHand = 사람이 손잡이를 놓았다(끌기 · 글쇠 · 두 번 누르기). 그때만 좁은 격자의 «상한에 닿으면 넘어간다» 를 쓴다(thByHand).
  function judge(px: number, byHand: boolean): void {
    hideHint();
    if (!swapEnabled()) { setSwapped(false); return; }
    const want = judgeSwap(ratio(px), swapped, byHand ? thByHand(body.clientWidth) : TH);
    if (want === swapped) return;
    setSwapped(want);
    if (want) showIntroOnce();
  }

  function onDrag(px: number): void {
    if (!swapEnabled()) { hideHint(); return; }
    const r = ratio(px);
    const will = judgeSwap(r, swapped, thByHand(body.clientWidth));
    if (will === swapped) { hideHint(); return; }
    hint.textContent = (will ? '놓으면 이 칸이 왼쪽으로 갑니다' : '놓으면 이 칸이 다시 오른쪽으로 갑니다')
      + '  ·  ' + Math.round(r * 100) + '%';
    hint.hidden = false;
  }
  function hideHint(): void { hint.hidden = true; }

  // ── 켜고 끄기 ───────────────────────────────────────────────────────────────
  function setEnabled(on: boolean, opts?: { quiet?: boolean }): void {
    write(KEY_OFF, !on);
    if (!on) setSwapped(false);
    else judge(curSideW(), false);
    paint();
    if (opts?.quiet) return;
    //  글은 바뀐 **뒤**의 자리로 고른다. 켜는 순간 폭이 이미 절반을 넘었으면 onEnd 가 칸을 왼쪽으로 옮긴 뒤다.
    toast(swapCopy(on, swapped).toast);
  }

  // ── 처음 자리가 바뀌는 순간의 안내 ──────────────────────────────────────────
  //  아무 설명 없이 화면 절반이 좌우로 뒤집히면 고장으로 읽힌다. 왜 그랬는지와 끄는 법을 같이 말한다.
  //  '다시 보지 않기'는 체크하는 그 순간 저장한다 — 어떻게 닫든(버튼·Esc·바깥 클릭) 뜻이 지켜지게.
  function showIntroOnce(): void {
    if (read(KEY_INTRO)) return;
    const again = el('input', { type: 'checkbox', class: 'sw-intro-cb', id: 'sw-intro-again' }) as HTMLInputElement;
    again.addEventListener('change', () => write(KEY_INTRO, again.checked));
    const back = overlay('메인으로 보는 것을 가운데로 옮겼어요',
      el('div', { class: 'sw-intro' },
        el('div', { class: 'sw-intro-fig' }, figure()),
        el('p', { class: 'sw-intro-p' },
          el('b', { text: '사이드바를 화면 절반보다 크게 키우셨어요.' }),
          el('span', { text: ' 그건 보통 “이제 이걸 메인으로 본다”는 뜻입니다 — 장표나 자료를 펴 놓고, 그걸 보면서 옆에서 바로 고치는 식으로요.' })),
        el('p', { class: 'sw-intro-p' },
          el('span', { text: '작업마다 메인으로 쓰는 화면이 다릅니다. 그래서 크게 키운 칸을 가운데로 옮기고 세션을 오른쪽으로 보냈어요. 왼쪽으로 옮긴 칸을 절반 아래로 줄이면 원래 자리(오른쪽)로 돌아갑니다.' })),
        el('p', { class: 'sw-intro-p muted' },
          el('span', { text: '자리가 바뀌는 게 불편하시면 고정해 두실 수 있어요. 화면 위쪽 프로젝트 이름 옆의 ' }),
          el('b', { text: '⇄' }),
          el('span', { text: ' 버튼으로 언제든 다시 켜집니다.' })),
        el('label', { class: 'sw-intro-again', for: 'sw-intro-again' }, again, el('span', { text: '다시 보지 않기' })),
        el('div', { class: 'sw-intro-acts' },
          el('button', {
            class: 'btn btn-ghost', type: 'button',
            onclick: () => { setEnabled(false); back.remove(); },
          }, el('span', { text: '자리 고정하기' })),
          el('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: () => back.remove(),
          }, el('span', { text: '이대로 쓸게요' }))))) as HTMLElement;
    // 짧은 안내는 **화면 한가운데**에, 글 폭에 맞게. 기본 껍데기는 긴 모달용이라 위쪽 정렬(align-items:flex-start)에
    //  760px 고정이어서, 이 안내를 그대로 얹으면 오른쪽이 텅 비고 위로 치우쳐 어색하다(원준 신고 2026-08-21).
    back.classList.add('sw-intro-back');
    back.querySelector('.ov-box')?.classList.add('sw-intro-box');
  }

  /** 무슨 일이 일어났는지 한눈에 — 말보다 그림이 빠르다(왼쪽=바뀌기 전, 오른쪽=바뀐 뒤). */
  function figure(): HTMLElement {
    const pane = (cls: string, label: string) => el('div', { class: 'sw-fig-pane ' + cls }, el('span', { text: label }));
    return el('div', { class: 'sw-fig' },
      el('div', { class: 'sw-fig-box' }, pane('sess', '세션'), pane('side big', '사이드바')),
      el('div', { class: 'sw-fig-arrow', 'aria-hidden': 'true' }, el('span', { text: '→' })),
      el('div', { class: 'sw-fig-box' }, pane('side big', '사이드바'), pane('sess', '세션'))) as HTMLElement;
  }

  // ── 문패 버튼 — 켜짐/꺼짐을 보여 주고 그 자리에서 바꾼다 ────────────────────
  const btn = el('button', { class: 'btn btn-ghost btn-sm sw-btn', type: 'button', onclick: () => openPop() },
    el('span', { class: 'sw-btn-i', text: '⇄' })) as HTMLElement;

  function paintBtn(): void {
    const on = swapEnabled();
    //  paint() 가 자리를 바꿀 때마다(양쪽 모두) 이 붓을 부른다. 글은 켜짐과 **지금 선 쪽** 둘 다로 고른다.
    const c = swapCopy(on, swapped);
    btn.classList.toggle('on', on);
    btn.title = c.btnTitle;
    btn.setAttribute('aria-label', c.btnAria);
  }

  function openPop(): void {
    const on = swapEnabled();
    const c = swapCopy(on, swapped);
    const panel = el('div', { class: 'sw-pop' },
      el('div', { class: 'sw-pop-h' }, el('b', { text: c.popHead })),
      el('p', { class: 'sw-pop-sub', text: c.popSub }),
      el('div', { class: 'sw-pop-opts' },
        opt('자리를 바꾼다', '지금 크게 본 것이 가운데에 옵니다. (기본)', on, () => { setEnabled(true); close(); }),
        opt('자리를 고정한다', c.popFixedDesc, !on, () => { setEnabled(false); close(); })),
      el('button', {
        class: 'btn-text sw-pop-help', type: 'button',
        onclick: () => { write(KEY_INTRO, false); close(); showIntroOnce(); },
      }, el('span', { text: '설명 다시 보기' }))) as HTMLElement;
    const close = anchoredPopover(btn, panel);
  }
  function opt(name: string, desc: string, on: boolean, onclick: () => void): HTMLElement {
    return el('button', { class: 'sw-opt' + (on ? ' on' : ''), type: 'button', onclick },
      el('b', { text: name }), el('span', { text: desc })) as HTMLElement;
  }

  // 격자 폭이 바뀌면(창 크기 · 왼쪽 사이드바 폭) 문턱(비율)도 상한도 다시 잰다.
  //  ⚠ 창의 resize 만 들으면 왼쪽 사이드바를 넓혔을 때를 놓친다. 격자 자체를 본다.
  //  ⚠ 여기서 폭을 깎지 않는다. 상한은 그리는 쪽(CSS --pn-side-fit)이 맞춘다. 화면을 여는 도중 격자 폭은 잠깐 좁아졌다
  //   넓어진다(왼쪽 사이드바가 제 폭을 찾는 동안). 그 순간의 상한으로 폭을 깎으면 622px 로 적어 둔 사이드바가 581px 로
  //   열렸다(2026-09-27 매니지드 실측, 열 때마다 값이 달랐다).
  const onResize = (): void => {
    if (dead || !(body.clientWidth > 0)) return;
    if (h.holdSwap?.()) return;          // 세션 카드 상태에서는 자리를 다시 판정하지 않는다(돌아올 자리를 지킨다)
    judge(curSideW(), false);
  };
  //  격자 폭이 바뀌면(창 크기 · 왼쪽 사이드바 폭) 자리를 다시 판정한다. 폭이 **멈춘 뒤에** 한 번만 한다. 움직이는 도중의
  //  폭으로 판정하면 그 순간의 자리가 이 세션의 자리로 적힌다.
  let ro: ResizeObserver | null = null;
  let roW = body.clientWidth;
  let roT = 0;
  const RESIZE_SETTLE_MS = 250;
  const onBodyW = (): void => {
    const w = body.clientWidth;
    if (w === roW) return;
    const first = roW === 0;
    roW = w;
    window.clearTimeout(roT);
    if (dead || !(w > 0)) return;
    roT = window.setTimeout(() => {
      if (dead || body.clientWidth !== w) return;
      //  처음 잰 폭(마운트 때는 격자가 화면에 없어 0 이었다)에서는 셸이 되살린 자리를 지킨다. 하나만 바로잡는다:
      //  사이드바가 돌아올 문턱(46%)보다 좁은데 왼쪽에 서 있으면 오른쪽으로 **보여 준다**(적지 않는다, placeOnRestore 와 같은 판정).
      if (first) { if (swapped && !h.holdSwap?.() && ratio(curSideW()) <= TH.off) setSwapped(false, false, false); return; }
      onResize();
    }, RESIZE_SETTLE_MS);
  };
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(onBodyW);
    ro.observe(body);
  } else {
    window.addEventListener('resize', onBodyW);
  }

  paint();
  //  ⚠ 여기서 자리를 판정하지 않는다(#3870). 종전엔 서는 순간 `onEnd(지금 폭)` 을 불렀는데, 그때의 폭은 이 세션의 폭이
  //   아니라 손잡이가 전역 키에서 읽은 «마지막으로 끌던 폭» 이다. 앞 세션에서 사이드바를 절반 넘게 키웠으면 그 폭으로
  //   «왼쪽» 이 판정되고 onChange 가 그것을 **지금 연 세션의 자리로 적었다**. 바로 뒤 셸의 restore 는 방금 적힌 «왼쪽» 을
  //   믿어, 손댄 적 없는 세션이 340px 사이드바를 왼쪽에 둔 채 열렸다(2026-09-27 매니지드 실측).
  //   자리는 셸이 이 세션의 폭을 입힌 뒤 restore 로 정한다(panes.ts applyView).

  return {
    maxSideW: capNow,
    onDrag, onEnd: (px: number) => judge(px, true), restore,
    button: () => btn,
    sync: () => paint(),
    quiet: () => hideHint(),
    introOnce: () => showIntroOnce(),
    swapped: () => swapped,
    destroy: () => {
      dead = true;
      ro?.disconnect();
      window.clearTimeout(roT);
      window.removeEventListener('resize', onBodyW);
      body.classList.remove('sw-left');
    },
  };
}
