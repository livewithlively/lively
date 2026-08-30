// 한 번에 하나만 — 이미 돌고 있으면 새로 시작하지 않고 '바쁨' 값을 즉시 돌려준다.
//
//  왜 필요한가(#1631): 매니지드는 **테넌트마다** 하우스키핑 틱이 들어오는데, 리브 2턴 스윕의 후보 목록은
//   신원 전역(org_member)이라 여러 틱이 같은 후보를 동시에 본다. 멱등 표식(distill_at)은 배달 **뒤에**
//   찍히므로 그 사이가 겹치면 같은 세션에 2턴이 두 번 들어간다. 게이트웨이는 프로세스 하나이므로
//   프로세스 안 가드로 그 창이 닫힌다.
//
//  ⚠ 이건 **분산 락이 아니다.** 프로세스가 여럿이면 각자 하나씩 돈다 — 그땐 DB 쪽 표식이 정본이어야 한다.
export function onceAtATime<T>(fn: () => Promise<T>, whenBusy: () => T): () => Promise<T> {
  let running = false;
  return async () => {
    if (running) return whenBusy();
    running = true;
    try { return await fn(); } finally { running = false; }
  };
}
