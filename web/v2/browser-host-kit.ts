// browser-host-kit.ts — AI 브라우저 호스트(browser-host)의 판정 셋: 이동 기다림 · 화면 찍기 시간 예산 · 스크롤 마저 굴리기 (#4993).
//  DOM 을 만지지 않는다(webview 는 사건 표적으로만, 찍기·쉬기는 넘겨받는다) — node 시험이 가짜 사건 순서·가짜 찍기로 재현한다
//  (scripts/browser-host-pure.test.mjs). 셋 다 실앱 끝단 확인(상민님 앱, 2026-10-25)에서 나온 고장이다.

/** loadAndWait 가 쓰는 webview 의 부분 — 사건 표적 + 지금 적재 중인가. */
export interface LoadView {
  addEventListener(type: string, fn: (e: any) => void): void;
  removeEventListener(type: string, fn: (e: any) => void): void;
  isLoading(): boolean;
}

/**
 * 이동을 걸고 다 열릴 때까지(또는 한도까지) 기다린다. 한도를 넘으면 오류가 아니라 그냥 돌아간다(느린 사이트 — loading:true).
 *  ⚠ **이번 이동이 시작된 뒤의** 멈춤만 받는다. 갓 만든 탭은 빈 페이지(about:blank)의 dom-ready 에서 «준비됨»이 되는데,
 *   그 빈 페이지의 멈춤(did-stop-loading)은 그 뒤에 온다 — 그걸 받으면 새 주소가 열리기도 전에 끝난다
 *   (실측 2026-10-25 상민님 앱: 첫 navigate 가 310ms 에 url "" · about:blank 로 돌아왔고, 2초 뒤에야 위키백과가 떠 있었다).
 *   늦게 온 멈춤은 새 시작보다 반드시 먼저 온다(같은 통로로 차례대로 온다) — 그래서 «시작을 본 뒤의 멈춤» 이면 이번 이동의 것이다.
 *  시작 신호는 둘이다 — did-start-loading, 그리고 앞 적재가 아직 도는 중이라 적재 상태가 안 꺼진 채 갈아탈 때 오는
 *   did-start-navigation(본 프레임 · 같은 문서 아님). 뒤로·앞으로가 저장해 둔 페이지를 되살리면 적재 없이 확정만 오므로
 *   확정(did-navigate) 때 적재 중이 아니면 거기서 끝낸다.
 */
export function loadAndWait(v: LoadView, kick: () => unknown, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let fin = false;
    let failed = '';
    let started = false;
    const done = (err?: Error): void => {
      if (fin) return;
      fin = true;
      clearTimeout(timer);
      for (const [type, fn] of listeners) v.removeEventListener(type, fn);
      if (err) reject(err); else resolve();
    };
    //  끝은 곧바로 — 실패(did-fail-load)는 멈춤보다 먼저 온다. 여기 타이머를 두면 숨은 창에서 1초가 된다.
    const finish = (): void => { queueMicrotask(() => done(failed ? new Error(failed) : undefined)); };
    const onStart = (): void => { started = true; };
    const onNavStart = (e: any): void => { if (e && e.isMainFrame !== false && !e.isInPlace) started = true; };
    const onStop = (): void => { if (started) finish(); };
    const onNavigated = (): void => { if (started && !v.isLoading()) finish(); };
    const onInPage = (): void => { if (!started) setTimeout(() => { if (!started) done(); }, 400); };
    const onFail = (e: any): void => {
      if (!e || e.isMainFrame === false || e.errorCode === -3) return;
      failed = `페이지를 열지 못했습니다 — ${e.errorDescription || '오류'}(${e.errorCode}) ${e.validatedURL || ''}`;
    };
    const listeners: Array<[string, (e: any) => void]> = [
      ['did-start-loading', onStart], ['did-start-navigation', onNavStart], ['did-stop-loading', onStop],
      ['did-navigate', onNavigated], ['did-fail-load', onFail], ['did-navigate-in-page', onInPage],
    ];
    for (const [type, fn] of listeners) v.addEventListener(type, fn);
    const timer = setTimeout(() => done(), ms);
    try {
      const r: any = kick();
      if (r && typeof r.catch === 'function') r.catch((e: any) => {
        const m = String(e?.message || e);
        if (/ERR_ABORTED|\(-3\)/.test(m)) return;            // 리다이렉트·덮어쓴 적재 — 오류가 아니다
        failed = failed || ('페이지를 열지 못했습니다 — ' + m);
        if (!started) done(new Error(failed));
      });
    } catch (e) { done(e as Error); }
  });
}

/** 찍기가 시간 안에 안 끝났을 때의 안내 — 다시 기다리지 않고 이걸로 실패한다. */
export function shotStuckMessage(ms: number): string {
  return `화면을 찍지 못했습니다(${Math.round(ms / 1000)}초) — 데스크톱 앱 창이 지금 화면에 그려지지 않는 것 같습니다`
    + '(다른 데스크톱 공간 · 전체 화면 앱 뒤에 있거나 화면이 꺼짐). 그래도 browser_read · browser_text · browser_act 는 됩니다.'
    + ' 화면이 꼭 필요하면 사람에게 Lively 창을 화면에 띄워 달라고 하세요.';
}

type ShotTry<T> = { ok: true; img: T } | { ok: false; timedOut: boolean; err?: unknown };
function tryShot<T>(capture: () => Promise<T>, ms: number): Promise<ShotTry<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
    Promise.resolve().then(capture).then(
      (img) => { clearTimeout(timer); resolve({ ok: true, img }); },
      (err) => { clearTimeout(timer); resolve({ ok: false, timedOut: false, err }); },
    );
  });
}

/**
 * 화면 찍기 한 장 — 시간 예산 안에서.
 *  · 숨은 창(트레이·최소화): 첫 찍기는 **마지막으로 그린(옛) 프레임**을 주고 그 찍기가 새 프레임을 청한다 → 한 장 버리고 빈 왕복 뒤 다시.
 *  · 빠른 오류(막 다시 실린 탭 — 그린 프레임이 아직 없다)는 0.25초 쉬고 한 번만 다시.
 *  · 시간이 다 되면 **다시 기다리지 않는다**. 창이 다른 데스크톱 공간(전체 화면 앱 뒤)에 있으면 게스트가 그리기를 아예 멈춰
 *    찍기가 영영 안 끝난다(실측 2026-10-25 상민님 앱: 10초 한도를 두 번 넘겨 22초 · 부분 찍기는 중계 한도 30초에 걸림).
 */
export async function captureFrame<T>(capture: () => Promise<T>, o: {
  hidden: boolean; firstMs: number; mainMs: number; ping: () => Promise<unknown>; nap: (ms: number) => Promise<void>;
}): Promise<T> {
  if (o.hidden) {
    const first = await tryShot(capture, o.firstMs);
    if (!first.ok && first.timedOut) throw new Error(shotStuckMessage(o.firstMs));
    await o.ping();
  }
  let r = await tryShot(capture, o.mainMs);
  if (!r.ok && !r.timedOut) { await o.nap(250); r = await tryShot(capture, o.mainMs); }
  if (r.ok) return r.img;
  if (r.timedOut) throw new Error(shotStuckMessage(o.mainMs));
  throw r.err instanceof Error ? r.err : new Error(String(r.err));
}

/** pageScrollState 의 꼴(필요한 칸만). */
export interface ScrollState { x: number; y: number; inner?: { tag: string; top: number; left: number } }

/**
 * 휠로 굴린 뒤 남은 거리 — 휠이 같은 칸을 움직이기 시작했는데 요청의 절반도 못 가고 멈췄으면 남은 거리(dx·dy, 페이지 좌표 부호)를,
 *  아니면 null. 창이 화면에 그려지지 않으면 부드러운 스크롤이 첫 박자에서 멈춘다(실측 2026-10-25 상민님 앱: 1200 을 굴려 24).
 *  안 움직였으면(끝이거나 페이지가 휠을 가로챔 — 지도·캐러셀) 손대지 않는다. 앞뒤 칸이 다르면 짐작하지 않는다.
 */
export function scrollRemainder(before: ScrollState | null | undefined, after: ScrollState | null | undefined, amount: number, dir: string): { dx: number; dy: number } | null {
  if (!before || !after || !(amount > 0)) return null;
  if ((before.inner?.tag ?? '') !== (after.inner?.tag ?? '')) return null;
  const vertical = dir === 'down' || dir === 'up';
  const pos = (s: ScrollState): number => (s.inner ? (vertical ? s.inner.top : s.inner.left) : (vertical ? s.y : s.x));
  const moved = Math.abs(pos(after) - pos(before));
  if (!(moved > 0) || moved >= amount / 2) return null;
  const left = Math.round(amount - moved);
  const sign = dir === 'down' || dir === 'right' ? 1 : -1;
  return vertical ? { dx: 0, dy: sign * left } : { dx: sign * left, dy: 0 };
}
