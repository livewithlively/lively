// lib/tax-loader.ts. 「분류체계」 앱과 그 사이드바가 함께 쥔 재료 캐시의 «언제 받고, 누구를 부르나» 한 자리(#3870). 순수(import 0).
//
//  원준 2026-09-27 «분류체계만 들어가면 화면 렉걸리고 제대로 로딩도 안됨»: 옛 loadTaxonomy 는 캐시가 신선하면 받은 콜백을
//   **그 자리에서 곧바로** 불렀다. 사이드바(side.ts renderTaxonomySection)는 그릴 때마다 loadTaxonomy(() => redraw()) 를 부르므로
//   그리기 → 콜백 → 다시 그리기 → 콜백 … 이 끝없이 이어져, 사이드바를 한 번 다시 그릴 때마다 호출 스택이 넘칠 때까지
//   (실측 1,562번) 사이드바 전체를 다시 세웠다. 재료가 도착한 순간(앱 화면이 redrawSide 를 부른다)에도 같은 고리가 돈다.
//  규칙(자료 앱 sources.ts loadSide 와 같은 틀):
//   · 콜백은 **새 재료(또는 실패)가 도착했을 때만** 부른다. 신선한 캐시면 부르지 않는다 — 부르는 쪽은 data() 로 이미 그렸다.
//   · 실패도 staleMs 동안은 다시 묻지 않는다. 도착 때 부르는 콜백이 다시 load 로 오므로, 안 막으면 실패가 요청을 끝없이 쏜다.
//   · 실패해도 앞서 받은 재료는 버리지 않는다(화면이 비지 않게).
//  시험: scripts/taxonomy-load.test.mjs.

export interface CachedLoader<T> {
  /** 지금 가진 재료(아직 한 번도 못 받았으면 null). */
  data(): T | null;
  /** 마지막 받기가 실패했으면 그 까닭, 아니면 ''. */
  error(): string;
  /** 재료를 받는다. 이미 받는 중이면 그 받기가 끝날 때 cb. 신선하면(성공 · 실패 모두 staleMs 안) 받지도 부르지도 않는다. force 면 캐시를 버린다. */
  load(cb?: () => void, force?: boolean): void;
}

export function createCachedLoader<T>(fetch: () => Promise<T>, staleMs: number, now: () => number = Date.now): CachedLoader<T> {
  let data: T | null = null;
  let err = '';
  let at = -Infinity;          // 마지막 받기가 끝난 때(성공 · 실패 모두)
  let loading = false;
  const waiters = new Set<() => void>();
  const flush = (): void => {
    const cbs = [...waiters];
    waiters.clear();
    for (const f of cbs) { try { f(); } catch (_) { /* 한 화면의 실패가 다른 화면을 막지 않는다 */ } }
  };
  return {
    data: () => data,
    error: () => err,
    load(cb, force = false) {
      if (loading) { if (cb) waiters.add(cb); return; }
      if (!force && now() - at < staleMs) return;
      if (cb) waiters.add(cb);
      loading = true;
      let p: Promise<T>;
      try { p = Promise.resolve(fetch()); } catch (e) { p = Promise.reject(e); }
      p.then((d) => { data = d; err = ''; })
        .catch((e: any) => { err = (e && e.message) || '불러오지 못했습니다'; })
        .finally(() => { at = now(); loading = false; flush(); });
    },
  };
}
