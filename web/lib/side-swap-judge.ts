// lib/side-swap-judge.ts: 자리바꿈의 판정(#1819 · #3870). 순수 함수만 둔다. DOM 없음.
//
//  사이드바가 격자의 52% 이상이면 왼쪽, 46% 이하면 오른쪽, 그 사이는 지금 자리를 지킨다(v2/side-swap.ts).
//  좁은 격자에서는 상한에 닿는 것이 «52%» 를 대신한다(swapThFor).
//  세션에 들어올 때는 그 세션에 적어 둔 자리가 있으면 그것을 따른다. 판정을 여기 모아 값으로 시험한다.

/** 넘어갈 때와 돌아올 때의 문턱. 같은 값이면 경계에서 손이 떨릴 때마다 자리가 깜빡인다. */
export const SWAP_TH = { on: 0.52, off: 0.46 } as const;

export interface SwapTh { on: number; off: number }

/** 이 격자 폭에서 쓸 문턱. capPx = 사이드바 상한(side-card-geom sideCap), minPx = 사이드바 하한.
 *
 *  사이드바는 상한(격자 − 세션 최소 360 − 손잡이)까지만 큰다. 격자가 762px 보다 좁으면 그 상한이 52% 에 못 미쳐
 *  자리바꿈이 영영 일어나지 않았다(1116 창 = 격자 718 → 상한 352 = 49%, 원준 2026-10-01 «좌우가 바뀌는 기능이 사라짐»).
 *  그런 격자에서는 **상한에 닿으면** 넘어간다(세션을 최소 폭까지 줄였다 = 사이드바를 메인으로 본다는 뜻은 같다).
 *  돌아오는 문턱은 넘어가는 문턱보다 6%p 낮게, 다만 하한보다는 위에 둔다(하한 아래면 끌어서는 영영 못 돌아온다).
 *  상한이 하한과 같으면(끌 거리가 없다) 넘어가지 않는다. */
export function swapThFor(bodyW: number, capPx: number, minPx: number): SwapTh {
  if (!(bodyW > 0) || !(capPx > 0)) return SWAP_TH;
  const capR = capPx / bodyW;
  if (capR >= SWAP_TH.on) return SWAP_TH;
  const minR = minPx / bodyW;
  const on = capR - 0.002;                     // 상한에 닿은 폭은 반올림해도 넘어가게
  if (!(on > minR)) return { on: Infinity, off: SWAP_TH.off };
  let off = Math.min(SWAP_TH.off, on - 0.06);
  if (!(off > minR)) off = (on + minR) / 2;
  return { on, off };
}

/** 손을 놓았을 때의 자리. ratio = 사이드바 폭 / 격자 폭, cur = 지금 자리(왼쪽이면 참), th = 그 격자의 문턱(swapThFor). */
export function judgeSwap(ratio: number, cur: boolean, th: SwapTh = SWAP_TH): boolean {
  if (!(ratio >= 0)) return cur;
  return ratio >= th.on ? true : ratio <= th.off ? false : cur;
}

export interface RestoreIn {
  /** 자리바꿈이 켜져 있나 */
  enabled: boolean;
  /** 이 세션에 적어 둔 자리. 없으면 undefined */
  remembered: boolean | undefined;
  /** 사이드바 폭 / 격자 폭 */
  ratio: number;
  /** 격자 폭을 잴 수 있나. 못 재면 ratio 는 창 폭으로 센 어림값이라 믿지 않는다 */
  measurable: boolean;
  /** 지금 자리 */
  cur: boolean;
  /** 그 격자의 문턱(swapThFor). 없으면 기본 문턱 */
  th?: SwapTh;
}

/** 세션에 들어올 때 **보여 줄** 자리. 적어 둔 값은 바꾸지 않는다(이 함수의 결과를 세션에 적지 않는다).
 *
 *  적어 둔 자리가 «왼쪽» 인데 격자 폭을 잴 수 있고 사이드바가 돌아올 문턱(46%)보다 좁으면 오른쪽으로 보여 준다.
 *  두 경우가 여기 걸린다.
 *   ① 옛 결함이 사이드바를 키운 적 없는 세션에 «왼쪽» 을 적어 둔 경우(#3870). 사이드바 340px 이 왼쪽에 서 있었다.
 *   ② 넓은 창에서 자리를 바꾼 세션을 좁은 창에서 다시 연 경우. 상한에 걸려 사이드바가 좁아졌으니 지금은 오른쪽이 맞다.
 *  둘을 가를 수 없으므로 **적어 둔 값은 그대로 둔다.** ② 의 사람이 창을 다시 넓히면 적어 둔 «왼쪽» 이 그대로 산다.
 */
export function placeOnRestore(i: RestoreIn): boolean {
  if (!i.enabled) return false;
  const th = i.th ?? SWAP_TH;
  if (typeof i.remembered === 'boolean') {
    if (i.remembered && i.measurable && i.ratio >= 0 && i.ratio <= th.off) return false;
    return i.remembered;
  }
  return judgeSwap(i.ratio, i.cur, th);
}
