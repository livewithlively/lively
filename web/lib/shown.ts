// 화면 한 조각이 **지금 사람 눈앞에 있나** — 문서가 보이고, 그 요소가 그려져 있다 (#5398).
//
//  ── 왜 필요한가 ────────────────────────────────────────────────────────────────────
//  평문 http(HTTP/1.1)에서 크롬은 같은 주소에 연결을 **6개까지만** 연다 — 그 주소의 모든 탭이 이 한도를 함께 쓴다.
//   끊지 않는 스트림(세션 상태 통로 · codex 실시간 층)이 그 자리를 물고 있으면 새로 연 화면의 평범한 요청이
//   대기열에서 영영 안 나온다(터미널 «연결 준비 중…» 멈춤 — 원인 지식 http1-6conn-limit-terminal-gate-stuck-5267).
//  스트림이 자리를 무는 경우는 둘이다:
//   ① 브라우저 탭이 숨었다(document.hidden).
//   ② 셸이 화면을 «숨겼다 보였다» 한다 — 왼쪽 목록에서 연 세션들은 DOM 째로 남아(v2/tabs.ts DOM 유지형)
//      문서가 보이는 동안에도 안 보이는 세션 화면이 스트림을 문다. 브라우저 탭 하나로도 6개가 찬다.
//  그래서 «보인다» 는 둘을 함께 본다: 문서가 보이고 **그 요소에 상자가 있다**(display:none 조상이 없다).
//
//  ── 판정과 신호 ────────────────────────────────────────────────────────────────────
//  · 판정은 그때그때 잰다(getClientRects) — 값을 쥐고 있다 얼리지 않는다.
//  · 바뀌었다는 신호는 셋에서 온다: visibilitychange(문서) · IntersectionObserver · ResizeObserver(요소의 상자가 생기고 사라짐).
//    IO 는 «화면 안에 있나» 까지 알려 오지만, 판정은 상자 유무만 본다 — 스크롤로 밖에 나간 것은 «숨었다» 가 아니다.
//    ⚠ IO 하나로는 모자란다: IO 는 «화면 안에 있나» 가 바뀔 때만 알린다. 화면 밖에서 숨었다(display:none) 다시 그려지면
//     둘 다 «밖» 이라 아무 말이 없다. 상자가 0 ↔ 실제 크기로 바뀌는 것은 RO 가 화면 안팎과 상관없이 알린다.
//  · 알림은 **값이 바뀔 때만** 간다(같은 값을 두 번 알리지 않는다).
//  · 요소를 안 주면 문서만 본다.
//  · 브라우저 밖(시험의 node)에서도 던지지 않는다 — document 가 없으면 늘 보인다.

export interface ShownWatch {
  /** 지금 보이나 — 부를 때마다 다시 잰다. */
  shown(): boolean;
  /** 신호를 끊는다. 두 번 불러도 된다. */
  stop(): void;
}

/** (판정) 이 요소가 지금 사람 눈앞에 있나. 요소가 없으면 문서만 본다. */
export function isShown(anchor: Element | null | undefined): boolean {
  if (typeof document === 'undefined') return true;
  if (document.visibilityState === 'hidden') return false;
  if (!anchor) return true;
  return anchor.isConnected && anchor.getClientRects().length > 0;
}

/**
 * 보임이 바뀔 때마다 onChange 를 부른다(바뀐 값과 함께). 처음 값은 부르지 않는다 — 필요하면 shown() 으로 잰다.
 *  ⚠ 반드시 stop() 을 부른다 — 안 부르면 문서 듣개와 IO 가 화면보다 오래 산다.
 */
export function watchShown(anchor: Element | null | undefined, onChange: (shown: boolean) => void): ShownWatch {
  let last = isShown(anchor);
  let stopped = false;
  const check = (): void => {
    if (stopped) return;
    const now = isShown(anchor);
    if (now === last) return;
    last = now;
    onChange(now);
  };
  const hasDoc = typeof document !== 'undefined' && typeof document.addEventListener === 'function';
  if (hasDoc) document.addEventListener('visibilitychange', check);
  const io = anchor && typeof IntersectionObserver === 'function' ? new IntersectionObserver(check) : null;
  if (io && anchor) io.observe(anchor);
  const ro = anchor && typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null;
  if (ro && anchor) ro.observe(anchor);
  return {
    shown: () => isShown(anchor),
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (hasDoc) document.removeEventListener('visibilitychange', check);
      io?.disconnect();
      ro?.disconnect();
    },
  };
}
