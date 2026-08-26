// 노드 에이전트 재연결 지연(#1865) — 순수 함수. agent.ts 의 teardown 이 이 값으로 다음 시도를 잡는다.
//
// 왜 따로 뺐나: 종전 식은 `min(30s, 1s * 2^attempt)` 하나였다(1·2·4·8·16·30초). 그런데 **끊기는 이유가 두 가지**고
//  둘의 복구 시간이 전혀 다르다 —
//   ⓐ 게이트웨이 재배포·재시작: 대개 10~30초면 다시 뜬다. 이때 노드가 16초 백오프에 들어가 있으면, 게이트웨이가
//      살아난 뒤에도 한참을 더 기다린다(dev 실측: 재시작 직후 웹터미널이 4462 로 계속 튕기고, 사람은 "터미널이
//      3초쯤 늦게 뜬다"로 느꼈다).
//   ⓑ 게이트웨이가 오래 죽어 있거나 네트워크가 끊김: 이때는 촘촘히 두드려 봐야 소용없다(로그만 쌓인다).
//
//  둘을 시간으로 가른다 — **초기 구간은 촘촘히(최대 5초), 그 뒤로는 느슨하게(30초)**. ⓐ 는 초기 구간에서 끝나고,
//  ⓑ 는 자연히 느슨한 구간으로 넘어간다. '지금 왜 못 붙는지'를 노드가 알 방법이 없으므로(연결 실패는 둘 다 똑같이
//  ECONNREFUSED 다) **경과 시간을 대리 신호로 쓴다** — 이게 원인을 추측하지 않고도 둘을 가르는 유일하게 정직한 축이다.
export const BACKOFF_MIN_MS = 1_000;
/** 초기(촘촘) 구간의 상한 — 재배포가 끝나는 즉시 붙도록. */
export const BACKOFF_FAST_MAX_MS = 5_000;
/** 촘촘히 두드리는 횟수. 1+2+4+5×9 ≈ 52초 — 게이트웨이 재시작(+노드 재연결)이 끝나고도 남는 창이다. */
export const FAST_TRIES = 12;
/** 그 뒤 느슨한 구간의 고정 간격(종전 상한과 같다 — 오래 죽어 있는 경우의 동작은 바꾸지 않는다). */
export const BACKOFF_MAX_MS = 30_000;
/** 지터 폭(±) — 노드가 여러 대일 때 재시도가 한 순간에 몰리지 않게(thundering herd). */
export const JITTER = 0.2;

/**
 * attempt(0부터) → 다음 재연결까지 기다릴 ms.
 * @param rand 0~1 난수(테스트에서 고정값을 넣는다). 0.5 면 지터 없음.
 */
export function reconnectDelayMs(attempt: number, rand = Math.random()): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const base = n < FAST_TRIES
    ? Math.min(BACKOFF_FAST_MAX_MS, BACKOFF_MIN_MS * 2 ** n)
    : BACKOFF_MAX_MS;
  const r = Number.isFinite(rand) ? Math.min(1, Math.max(0, rand)) : 0.5;
  return Math.max(BACKOFF_MIN_MS, Math.round(base * (1 + (r - 0.5) * 2 * JITTER)));
}
