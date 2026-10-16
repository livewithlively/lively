// lib/pinch-guard.ts — 트랙패드 두 손가락 확대(pinch)를 막는다(#3870).
//  셸은 창 크기에 딱 맞춘 격자(100vh · overflow hidden)라, 사파리에서 두 손가락이 살짝만 벌어져도(실측 1.04배)
//  배치는 그대로인 채 전체가 커져 오른쪽·아래가 창 밖으로 나간다. 4% 는 글자 크기로 안 보여 «화면이 잘렸다» 로만
//  보이고, 사파리는 그 배율을 새로고침 뒤에도 되살린다. ⌘+/⌘− 확대는 화면이 다시 배치되므로 건드리지 않는다.
//  ⚠ 이미 확대돼 있으면 막지 않는다 — 막으면 오므려 되돌릴 길까지 끊긴다.
//  ⚠ 못 막는 자리: 스크립트가 못 도는 액자(sandbox='' 미리보기) · 브라우저의 PDF 보기 위에서는 제스처가 우리 코드에 안 온다.
//  ⚠ 사파리의 gesture 이벤트만 다룬다. 크롬의 pinch 는 Ctrl+wheel 로 오는데, 그걸 끊으려면 창 전체에 passive 아닌
//   wheel 리스너가 필요해 모든 스크롤이 메인 스레드를 기다린다 — 걸지 않았다.
//  사본: web/standalone/pinch-guard.ts(터미널 번들) · web/v2/app-ui-runtime.ts(앱 화면 주입 문자열, 늘 막음).
//   scripts/pinch-guard.test.mjs 가 셋을 같은 표로 돌린다 — 한쪽만 고치지 마라.

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
