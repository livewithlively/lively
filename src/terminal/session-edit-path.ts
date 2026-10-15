// 세션 고치기(POST /api/ui/terminal/sessions/:id — 이름 · 초대)가 **어디로 가나** — 순수(#4632, 원준 2026-10-15).
//
//  종전엔 화면이 좌표(node)를 실어 줄 때만 노드로 갔다. 좌표 없이 온 고침은 중앙 tmux 로 가서, 다른 컴퓨터(노드)에서 뜬 세션과
//  쉬고 있는 세션(tmux 가 없다)은 500 으로 끝났다 — 앱빌더가 세션 이름 «"회의록" 앱 제작» 을 박는 호출이 그렇게 조용히 실패해
//  AI 가 지은 「회의록 기획카드」 가 남았다. 지금:
//   · node   — 좌표(화면이 준 것 → 기록 → 스냅샷, 호출부가 sessionRelayNodeId 로 되찾는다)가 있고 그 노드가 켜져 있다. 초대가 섞였으면
//              노드가 꺼져 있어도 종전대로 노드로 간다(초대 명단의 정본은 그 노드의 tmux 다 — 기록만 고치면 다시 켜질 때 되돌아간다).
//   · stored — **이름만** 바꾸는데 그 세션이 지금 어디서도 돌지 않는다(노드가 꺼졌거나, 중앙 tmux 가 확답으로 없다). 기록(desired-state)에
//              사람 이름으로 적는다 — 복원이 이 이름으로 세션을 다시 띄우고, AI 의 session_rename 은 이 이름을 못 덮는다.
//   · central — 그 밖(종전). 중앙 tmux 가 살아 있는지 모르면(null) 살아 있다고 본다(#3752 — 모름을 죽음으로 읽지 않는다).
export type SessionEditPath = "node" | "stored" | "central";

export function sessionEditPath(i: { nodeId: string; nodeOnline: boolean; labelOnly: boolean; centralGone: boolean | null }): SessionEditPath {
  if (i.nodeId) return i.nodeOnline || !i.labelOnly ? "node" : "stored";
  return i.labelOnly && i.centralGone === true ? "stored" : "central";
}
