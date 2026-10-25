// browser-host-kit.ts — AI 브라우저 호스트(browser-host)의 판정 셋: 이동 기다림 · 화면 찍기 시간 예산 · 스크롤 보내는 법 (#4993).
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

/** 휠 한 번(Electron mouseWheel 의 부호 — 아래 머리말). */
export interface WheelStep { deltaX: number; deltaY: number }

/**
 * 스크롤을 어떻게 보낼지 — 창이 보이면 진짜 휠(300px 씩), 숨었으면 페이지에서 바로(instant) 굴릴 거리(페이지 좌표 부호).
 *  · 숨은 창(트레이 · 최소화 · 가려져 숨김으로 쳐진 창)의 휠은 화면 박자에 묶여 **뒤늦게** 처리된다 — 그 자리에서 재면 덜 갔고,
 *    남은 거리를 페이지에서 마저 굴리면 뒤늦은 휠이 그 위에 더해진다(실측 2026-10-25 상민님 앱: 1200 을 굴려 그 자리 24 →
 *    마저 굴려 1200 → 몇 초 뒤 2332). 그래서 숨었을 때는 휠을 아예 보내지 않는다.
 *  · 보이는 창은 휠 — 페이지가 받는 것이 진짜 입력이어야 휠을 듣는 페이지(지도·캐러셀)가 사람과 같게 움직인다.
 *    한 번에 크게 보내면 부드러운 스크롤 도중에 재서 덜 간 것으로 보인다(실측: 1500 을 보내고 450ms 뒤 436) → 300px 씩.
 *  · Electron 휠 부호: deltaY 가 음수면 내용이 위로 올라간다(= 아래로 굴림). 실측 -500 → scrollY 500. 페이지 좌표는 그 반대.
 *  · scale = 사람 칸에 겹친 탭의 배율(browser-tabs dockScale). 휠 거리는 그 역수만큼 커져 들어가므로(실측: 칸 배율 ≈0.755 에서
 *    1200→1590) 휠에 배율을 곱해 보낸다. 휠은 정수라 조각마다 반올림하되 **누적 경계로** 나눠 합이 거리×배율과 같게 한다.
 *    배율을 모르거나 이상하면 1. 숨은 창의 페이지 굴리기는 페이지 좌표라 배율과 무관하다.
 *  거리는 1~20,000px 로 자른다(JSON 의 1e999 는 Infinity — 상한이 없으면 끝없이 굴렀다, #4993 격리 리뷰). 방향을 모르면 아래.
 */
export function scrollPlan(hidden: boolean, amount: number, dir: string, scale = 1): { page: { dx: number; dy: number } } | { wheel: WheelStep[] } {
  const n = Math.max(1, Math.min(20_000, Math.floor(amount) || 600));
  const vertical = dir !== 'left' && dir !== 'right';
  const forward = dir !== 'up' && dir !== 'left';
  if (hidden) {
    const d = forward ? n : -n;
    return { page: vertical ? { dx: 0, dy: d } : { dx: d, dy: 0 } };
  }
  const z = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const total = Math.max(1, Math.round(n * z));
  const wheel: WheelStep[] = [];
  let sent = 0;
  for (let done = 0; done < n;) {
    done = Math.min(n, done + 300);
    const upto = done === n ? total : Math.round(done * z);
    const d = (forward ? -1 : 1) * (upto - sent);
    sent = upto;
    if (d !== 0) wheel.push(vertical ? { deltaX: 0, deltaY: d } : { deltaX: d, deltaY: 0 });
  }
  return { wheel };
}
