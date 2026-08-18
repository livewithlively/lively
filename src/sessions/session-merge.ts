// 세션 목록 병합(#1716) — 한 세션이 여러 출처에 잡혀도 화면엔 카드 1장.
//
// 세션 목록은 세 출처를 이어 붙여 만든다: 중앙 tmux 라이브(local) · 노드 스냅샷(remote) · 복원 가능(restorable).
// 종전엔 restorable 만 liveIds 로 걸렀고 remote 는 무필터라, **같은 세션 id 가 local 과 remote 양쪽에 있으면
// 그대로 두 장**이 됐다. 실측(2026-08-15 dev): 게이트웨이와 노드 에이전트가 같은 머신에서 돌아 **같은 tmux 서버**를
// 보고 있었고, AI 세션 탭의 세션 14개가 전부 '중앙박스 것 1장 + 맥미니 노드 것 1장'으로 이중 표기됐다.
// 게이트웨이가 도는 박스에 노드를 붙이는 건 1인·자가호스팅에서 자연스러운 구성이라, 구성으로 피하는 대신
// 병합에서 접는다.
//
// 우선순위는 **라이브 관측 > 기억**. 인자 순서가 곧 우선순위이고, 출력도 그 순서다.
//  1) local      — 지금 tmux 에 있다(가장 확실 · 릴레이 없이 attach/kill 가능)
//  2) remote     — 노드 스냅샷(온라인이면 라이브, 오프라인이면 마지막 관측)
//  3) restorable — tmux 에 없음이 확정되고 DB desired-state 만 남은 것
// 로컬이 이기면 그 카드엔 node 배지가 빠지는데, 같은 tmux 를 공유한다는 건 곧 같은 박스라는 뜻이라 잃는 정보가 없다.
export function mergeSessionViews<T extends { id: string }>(...groups: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const g of groups) {
    for (const s of g) {
      if (seen.has(s.id)) continue;   // 앞 그룹(더 확실한 출처)이 이미 실었다 — 같은 그룹 안 중복도 여기서 접힌다
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}
