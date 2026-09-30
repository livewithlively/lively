// older-autoload.ts — 대화창 «위로 더» 를 단추 없이, 스크롤로 (#3778, 원준 2026-09-19).
//
//  신고: «보관 중인 세션에서 위로 올리다가 꼭대기의 불러오기 단추(남은 용량 표시)를 눌러야 더 위를 볼 수 있는 게 별로다.
//   그냥 위로 스크롤하면 적당한 때 알아서 위의 것을 가져와서 끊기는 경험이 없게.»
//
//  ── 무엇 ──
//   · 맨 위 표지(session-chat 의 .sc-older)가 **화면에 닿기 전에**(화면 높이 OLDER_AHEAD 만큼 앞에서) 불러오기 시작한다.
//     사람이 꼭대기에 닿을 즈음엔 그 위가 이미 붙어 있다.
//   · 붙인 뒤에도 표지가 아직 그 거리 안이면(불러온 창이 화면을 못 채웠다) 이어서 또 부른다 — 찰 때까지.
//   · 한 번에 하나만 돈다. 실패하면 **멈춘다**(되묻기 폭주 금지). 사람이 그 자리를 떠났다가 돌아오거나 [다시 시도] 를 누르면 다시.
//   · 목록이 가려져 있으면(터미널 보기 — display:none) 관찰자가 «안 보임» 으로 알려 주므로 숨은 화면에서는 부르지 않는다.
//
//  이 파일은 DOM 을 쓰되 앱 모듈을 import 하지 않는다 — 헤드리스 크롬 테스트(scripts/older-autoload-runtime.test.mjs)가
//   이 파일 하나만 컴파일해 실제 스크롤·관찰자로 돌린다.

/** 서버가 한 번에 내주는 상한 — src/sessions/transcript-range.ts TRANSCRIPT_MAX_CHUNK 와 같은 값(서버는 이보다 긴 창을 잘라 낸다). */
export const OLDER_MAX_SPAN = 4 * 1024 * 1024;

/** 표지가 화면 위로 이만큼(목록 높이 기준) 떨어져 있을 때부터 부른다 — 관찰자 rootMargin 의 윗변. */
export const OLDER_AHEAD = '200%';

/**
 * 다음에 청할 원문 구간 [from, to). loadedFrom = 화면 맨 위 창의 시작(서버가 줄 경계로 맞춰 준 값).
 *
 *  stalls = 직전 요청이 **한 바이트도 못 올라간** 횟수. 서버는 창을 줄 경계로 맞추는데(src/terminal/harness-io/window.ts),
 *  청한 구간 전체가 한 줄(큰 도구 결과·이미지)의 꼬리 안에 들면 반 줄을 줄 수 없어 빈 창을 loadedFrom 그대로 돌려준다.
 *  같은 구간을 또 청하면 영원히 같은 답이다 — 종전 단추는 그 자리에서 눌러도 아무 일이 없었고, 자동으로 부르면 무한 반복이 된다.
 *   · 0  → 기본 창 [L-win, L)
 *   · 1  → 서버 상한까지 넓힌다 [L-max, L) — 그 줄이 상한 안이면 통째로 온다
 *   · 2+ → 그 줄은 상한보다 길어 서버가 못 준다 — 끝을 상한 단위로 **당겨** 그 줄을 건너뛴다.
 *          서버의 끝 정렬이 다시 줄 경계로 맞추므로 이음새에 빈틈·중복이 생기지 않는다.
 */
export function olderRequest(loadedFrom: number, stalls: number, win: number, max = OLDER_MAX_SPAN): { from: number; to: number } {
  const L = Math.max(0, Math.floor(loadedFrom));
  if (stalls <= 0) return { from: Math.max(0, L - win), to: L };
  if (stalls === 1) return { from: Math.max(0, L - max), to: L };
  const to = Math.max(0, L - max * (stalls - 1));
  return { from: Math.max(0, to - win), to };
}

/** 응답 하나를 받은 뒤 — 올라갔으면(gotFrom < loadedFrom) 그 자리로, 못 올라갔으면 stalls+1(다음 요청을 olderRequest 가 넓힌다). */
export function olderNext(loadedFrom: number, stalls: number, gotFrom: number): { loadedFrom: number; stalls: number; moved: boolean } {
  return gotFrom < loadedFrom ? { loadedFrom: gotFrom, stalls: 0, moved: true } : { loadedFrom, stalls: stalls + 1, moved: false };
}

/**
 * 위에 무언가를 끼우는 동안 **보던 자리**를 지킨다 — 끼운 높이만큼 scrollTop 을 내린다.
 *  브라우저가 이미 맞춰 두었으면(스크롤 앵커링) 같은 값을 다시 쓰지 않는다 — 스크롤이 두 번 움직이지 않게.
 */
export function prependKeepingView(scroller: HTMLElement, fn: () => void): void {
  const before = scroller.scrollHeight; const top = scroller.scrollTop;
  fn();
  const want = top + (scroller.scrollHeight - before);
  if (Math.abs(scroller.scrollTop - want) > 1) scroller.scrollTop = want;
}

export interface OlderLoader {
  /** 맨 위 표지를 지켜본다(새로 그렸으면 새 것을). null = 더 불러올 것이 없다. */
  watch(bar: HTMLElement | null): void;
  /** 사람이 [다시 시도] 를 눌렀다 — 지금 부른다(누를 수 있었다 = 표지가 보인다 = 그 거리 안). */
  retry(): void;
  destroy(): void;
}

/**
 * scroller 안의 표지가 «화면 + ahead» 안에 들어오면 load 를 부른다.
 *  load 는 성공이면 true(붙였다 — 표지를 새로 그렸어도 된다), 실패면 false(표지에 실패를 적었다 — 여기서는 멈춘다).
 */
export function olderLoader(scroller: HTMLElement, load: () => Promise<boolean>, ahead: string = OLDER_AHEAD): OlderLoader {
  let target: HTMLElement | null = null;
  let near = false;      // 표지가 그 거리 안에 있나 — 관찰자가 알려 준 마지막 값
  let busy = false;      // 한 번에 하나
  let dead = false;
  const run = (): void => {
    if (busy || !near || !target) return;
    const t = target;
    busy = true;
    load().then((ok) => ok, () => false).then((ok) => {
      busy = false;
      // 그새 표지가 바뀌었다(붙이면서 새로 그렸다·목록을 비웠다·치웠다) — 새 표지 기준으로 다시 본다.
      //  도는 동안 온 관찰 결과는 near 에 이미 담겨 있다(run 만 busy 에 막혔다).
      if (t !== target) { run(); return; }
      //  실패 — **다시 걸지 않는다**. 관찰자는 경계를 넘을 때만 알려 주므로, 사람이 그 거리를 벗어났다 돌아오거나
      //   [다시 시도](retry)를 눌러야 다시 불린다. 그 자리에 머무는 동안 되묻지 않는다.
      if (!ok) return;
      // 같은 표지로 성공(서버가 제자리 응답 — olderRequest) — 관찰자는 «변화» 만 알려 주므로 아직 그 거리 안인지 새로 묻는다.
      near = false; io.unobserve(t); io.observe(t);
    });
  };
  const io = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.target === target) near = e.isIntersecting;
    run();
  }, { root: scroller, rootMargin: `${ahead} 0px 0px 0px` });
  return {
    watch(bar) {
      if (dead || bar === target) return;
      if (target) io.unobserve(target);
      target = bar; near = false;
      if (bar) io.observe(bar);
    },
    retry() { run(); },
    destroy() { dead = true; io.disconnect(); target = null; },
  };
}
