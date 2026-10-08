// standalone/pinch-guard.ts — 트랙패드 두 손가락 확대 막기의 **사본**(#3870). 단독 터미널 번들은 의존 0 이라 web/lib 를 못 실는다.
//  정본은 web/lib/pinch-guard.ts 다(왜 막는지 · 왜 사파리만인지는 거기). scripts/pinch-guard.test.mjs 가 두 사본을 같은 표로
//  돌려 어긋나면 빨간불을 낸다 — 한쪽만 고치지 마라.

/** 이 배율을 넘으면 «이미 확대돼 있다». 1% 만 커져도 1440 창에서 14px 이 잘리므로 문턱은 반올림 오차만 거른다. */
export const PINCH_ZOOMED_MIN = 1.001;

export function isZoomedIn(scale: unknown): boolean {
  return typeof scale === 'number' && isFinite(scale) && scale > PINCH_ZOOMED_MIN;
}

/** 지금 페이지 확대 배율. 확대는 맨 위 문서의 것이라 액자 안에서는 늘 1 로 보인다 — 닿으면 맨 위 창에 묻는다. */
export function pageScale(win: any): number {
  try { const s = win.top.visualViewport.scale; if (typeof s === 'number' && isFinite(s)) return s; } catch (_) { /* 다른 출처의 맨 위 창 */ }
  try { const s = win.visualViewport.scale; if (typeof s === 'number' && isFinite(s)) return s; } catch (_) { /* 없다 */ }
  return 1;
}

/** 손가락으로 만지는 기기인가(아이폰 · 아이패드). 거기서는 손가락 확대를 그대로 둔다 — 확대한 채 밀어 볼 수 있고,
 *  index.html 의 viewport 도 «iOS 는 손가락 확대를 그대로 허용한다» 로 정해 두었다. */
export function isTouchDevice(win: any): boolean {
  try { return Number(win.navigator.maxTouchPoints) > 0; } catch (_) { return false; }
}

/** 확대 제스처를 끊는다(확대돼 있지 않을 때만 · 트랙패드 기기에서만). 한 창에 한 번만 건다. */
export function installPinchGuard(win: any = window): void {
  if (!win || win.__livelyPinchGuard || isTouchDevice(win)) return;
  win.__livelyPinchGuard = true;
  const stop = (e: any) => { if (!isZoomedIn(pageScale(win))) e.preventDefault(); };
  win.addEventListener('gesturestart', stop, { capture: true, passive: false });
  win.addEventListener('gesturechange', stop, { capture: true, passive: false });
}
