// standalone/pinch-guard.ts — 트랙패드 두 손가락 확대 막기의 **사본**(#3870). 단독 터미널 번들은 의존 0 이라 web/lib 를 못 실는다.
//  정본은 web/lib/pinch-guard.ts 다(왜 막는지 · 왜 사파리만인지는 거기). scripts/pinch-guard.test.mjs 가 두 사본을 같은 표로
//  돌려 어긋나면 빨간불을 낸다 — 한쪽만 고치지 마라.

/** 이 배율이면 «이미 확대돼 있다». 사파리는 1 아래로 안 내려가고, 1 근처 값은 반올림 오차다. */
export const PINCH_ZOOMED_MIN = 1.01;

export function isZoomedIn(scale: unknown): boolean {
  return typeof scale === 'number' && isFinite(scale) && scale > PINCH_ZOOMED_MIN;
}

/** 지금 페이지 확대 배율. 확대는 맨 위 문서의 것이라 액자 안에서는 늘 1 로 보인다 — 닿으면 맨 위 창에 묻는다. */
export function pageScale(win: any): number {
  try { const s = win.top.visualViewport.scale; if (typeof s === 'number' && isFinite(s)) return s; } catch (_) { /* 다른 출처의 맨 위 창 */ }
  try { const s = win.visualViewport.scale; if (typeof s === 'number' && isFinite(s)) return s; } catch (_) { /* 없다 */ }
  return 1;
}

/** 확대 제스처를 끊는다(확대돼 있지 않을 때만). 한 창에 한 번만 건다. */
export function installPinchGuard(win: any = window): void {
  if (!win || win.__livelyPinchGuard) return;
  win.__livelyPinchGuard = true;
  const stop = (e: any) => { if (!isZoomedIn(pageScale(win))) e.preventDefault(); };
  win.addEventListener('gesturestart', stop, { capture: true, passive: false });
  win.addEventListener('gesturechange', stop, { capture: true, passive: false });
}
