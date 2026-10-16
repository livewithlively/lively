// 한 번에 하나만 — 이미 돌고 있으면 새로 시작하지 않고 '바쁨' 값을 즉시 돌려준다.
//
//  왜 필요한가(#1631): 매니지드는 **테넌트마다** 하우스키핑 틱이 들어오는데, 리브 2턴 스윕의 후보 목록은
//   신원 전역(org_member)이라 여러 틱이 같은 후보를 동시에 본다. 멱등 표식(distill_at)은 배달 **뒤에**
//   찍히므로 그 사이가 겹치면 같은 세션에 2턴이 두 번 들어간다. 게이트웨이는 프로세스 하나이므로
//   프로세스 안 가드로 그 창이 닫힌다.
//
//  ⚠ 이건 **분산 락이 아니다.** 프로세스가 여럿이면 각자 하나씩 돈다 — 그땐 DB 쪽 표식이 정본이어야 한다.
//
//  slotOf(#4851) — 칸을 나눌 수 있다. 같은 칸끼리만 하나씩 돌고, 다른 칸은 함께 돈다. 안 주면 칸 하나(종전 그대로).
//   매니지드 리브 2턴 스윕이 쓴다: 그 틱이 보는 후보가 그 워크스페이스 사람뿐이라(행 수준 격리) 워크스페이스끼리 겹쳐도 같은 후보를 두 번 보지
//   않는데, 칸이 하나면 CP 의 테넌트 틱(5분 주기 · 해시 지터 · 동시 4)이 앞 스윕과 겹친 워크스페이스를 **매 주기** 건너뛴다(주기가 같아 겹침이 되풀이된다).
export function onceAtATime<T>(fn: () => Promise<T>, whenBusy: () => T, slotOf: () => string = () => ""): () => Promise<T> {
  const running = new Set<string>();
  return async () => {
    const slot = slotOf();
    if (running.has(slot)) return whenBusy();
    running.add(slot);
    try { return await fn(); } finally { running.delete(slot); }
  };
}
