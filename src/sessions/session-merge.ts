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
// ⚠ 이긴 쪽이 모르는 **노드 소속(node)** 은 진 쪽에서 옮겨 싣는다. 종전엔 "같은 tmux 를 공유한다는 건 곧 같은
//  박스라는 뜻이라 잃는 정보가 없다"고 보고 그냥 버렸는데, 그게 틀렸다(실측 2026-08-26 dev, 상민님 신고):
//  node 는 배지가 아니라 **좌표**다 — 화면은 그 값으로 `&node=`/`?node=` 를 붙여 입장·메타조회·종료를 그 노드로
//  릴레이한다. 좌표가 빠진 카드는 `?node=` 없이 메타를 묻고, 그 조회는 desired-state 의 node_id 만 보고
//  **살아 있는 세션을 '복원 가능'(=죽음)이라 답한다**(routes.ts `/sessions/:id`). 그 오답을 받은 새 셸이
//  대화록 기반 이어받기로 흘러 매번 **빈 새 세션**을 만들었다(session-log-routes.ts 폴백).
//  같은 세션을 프로젝트 탭(project-routes.ts)은 dir 이 안 맞아 remote 만 남겨 node 를 달고 있었으므로,
//  이 옮겨싣기는 두 목록의 답을 **같게** 만든다.
export function mergeSessionViews<T extends { id: string; node?: unknown }>(...groups: T[][]): T[] {
  const won = new Map<string, T>();
  const out: T[] = [];
  for (const g of groups) {
    for (const s of g) {
      const prev = won.get(s.id);
      if (prev) {                                     // 앞 그룹(더 확실한 출처)이 이미 실었다 — 같은 그룹 안 중복도 여기서 접힌다
        if (!prev.node && s.node) prev.node = s.node; // 좌표만 물려받는다(상태는 이긴 쪽이 SoT — restorable 은 안 옮긴다)
        continue;
      }
      won.set(s.id, s);
      out.push(s);
    }
  }
  return out;
}
