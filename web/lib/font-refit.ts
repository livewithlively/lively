// 웹폰트를 다 받은 뒤 한 번 더 재기 — 기다리는 길은 `loadingdone` 이벤트 하나다(#5616).
//
//  ⚠ `document.fonts.ready.then(재기)` 로 기다리지 않는다. iPadOS 17 사파리(17.5 시뮬레이터 실측)는 `ready` 가 이미
//   풀린 채 `status` 가 'loading' 으로 남는 때가 있다. 그때 «아직 loading 이면 ready 뒤에 다시 잰다» 를 재는 함수 안에서
//   걸면 → ready.then 이 곧바로 돌고 → 다시 loading 이라 또 건다 … 가 **마이크로태스크로 끝없이** 돈다. 마이크로태스크는
//   이벤트 루프에 차례를 넘기지 않으므로 터치·클릭·타이머가 영영 처리되지 않는다 — 화면은 그려져 있는데 아무것도 안 눌린다.
//   (홈의 실행 줄 run-picker 의 fit() 이 그랬다: 아이패드에서 앱을 열면 1.4초 뒤 통째로 멈췄다.)
//  `loadingdone` 은 받는 일이 실제로 끝났을 때만 울리므로 status 가 어떻게 남든 저절로 돌지 않는다. 다시 재는 일은
//   setTimeout 으로 넘겨 이벤트 처리 중에 레이아웃을 강제하지 않는다.

/** FontFaceSet 중 여기서 쓰는 것만. */
export interface FontSetLike {
  status?: string;
  addEventListener?: (type: string, fn: () => void, opts?: { once?: boolean }) => void;
}

/**
 * 글꼴을 받는 중이면, 다 받은 뒤 `refit` 을 **한 번** 부르도록 건다. 이미 걸려 있으면(armed) 다시 걸지 않는다.
 * @returns 이번에 새로 걸었으면 true.
 */
export function refitAfterFonts(fonts: FontSetLike | null | undefined, state: { armed: boolean }, refit: () => void): boolean {
  if (!fonts || fonts.status !== 'loading' || state.armed || typeof fonts.addEventListener !== 'function') return false;
  state.armed = true;
  fonts.addEventListener('loadingdone', () => {
    globalThis.setTimeout(() => { state.armed = false; refit(); }, 0);
  }, { once: true });
  return true;
}
