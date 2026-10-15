// 세션 고치기(POST /api/ui/terminal/sessions/:id — 이름 · 초대)가 **어디로 가나** — 순수(#4632, 원준 2026-10-15).
//
//  종전엔 화면이 좌표(node)를 실어 줄 때만 노드로 갔다. 좌표 없이 온 고침은 중앙 tmux 로 가서, 다른 컴퓨터(노드)에서 뜬 세션과
//  쉬고 있는 세션(tmux 가 없다)은 500 으로 끝났다 — 앱빌더가 세션 이름 «"회의록" 앱 제작» 을 박는 호출이 그렇게 조용히 실패해
//  AI 가 지은 「회의록 기획카드」 가 남았다. 지금:
//   · node   — 좌표(화면이 준 것 → 기록 → 스냅샷, 호출부가 sessionRelayNodeId 로 되찾는다)가 있고 그 노드가 켜져 있다. 초대가 섞였으면
//              노드가 꺼져 있어도 종전대로 노드로 간다(초대 명단의 정본은 그 노드의 tmux 다 — 기록만 고치면 다시 켜질 때 되돌아간다).
//   · stored — **이름만** 바꾸는데 그 세션이 지금 어디서도 돌지 않는다(노드가 꺼졌거나, 켜진 노드가 «없다» 고 확답했거나, 중앙 tmux 가 확답으로 없다). 기록(desired-state)에
//              사람 이름으로 적는다 — 복원이 이 이름으로 세션을 다시 띄우고, AI 의 session_rename 은 이 이름을 못 덮는다.
//   · central — 그 밖(종전). 중앙 tmux 가 살아 있는지 모르면(null) 살아 있다고 본다(#3752 — 모름을 죽음으로 읽지 않는다).
export type SessionEditPath = "node" | "stored" | "central";

/**
 * nodeId = 되찾은 좌표(화면이 준 것 → 기록 → 스냅샷) · rowNode = **기록(desired-state)의** 좌표(같은 접기를 거친 것).
 *  꺼진 노드로 «기록만» 가는 건 그 좌표가 기록의 좌표와 같을 때뿐이다 — 화면이 실어 보낸 낡은(엉뚱한) 좌표 하나로 살아 있는 세션의
 *  이름이 기록에만 적히고 화면(tmux)은 옛 이름으로 남는 일을 막는다(격리 리뷰). 다르면 종전대로 노드로 보낸다(그 노드가 답한다).
 */
export function sessionEditPath(i: { nodeId: string; rowNode: string; nodeOnline: boolean; nodeGone?: boolean | null; labelOnly: boolean; centralGone: boolean | null }): SessionEditPath {
  //  켜진 노드라도 그 세션이 끝났으면(노드의 gone 확답 true — 지우기 라우트와 같은 3값, 모르면 null) 노드는 «본인 세션이 아닙니다» 로 거절한다 —
  //   끝난 세션은 그 노드의 tmux 에 없어 주인을 못 읽기 때문이다(실측 2026-10-15 「회의록 기획카드」). 이름만이면 기록에 적는다.
  if (i.nodeId) return i.labelOnly && i.nodeId === i.rowNode && (!i.nodeOnline || i.nodeGone === true) ? "stored" : "node";
  return i.labelOnly && i.centralGone === true ? "stored" : "central";
}

/** 기록에 적을 이름 — 중앙 editSession(cleanLabel) · 노드 미러와 같은 다듬기(탭 · 줄바꿈은 공백 · 앞뒤 공백 · 80자). */
export function cleanEditLabel(raw: unknown): string {
  return String(raw ?? "").replace(/[\t\n\r]/g, " ").trim().slice(0, 80);
}

/**
 * «기록만» 이름 바꾸기를 막을 까닭 — 없으면 null. 순서가 곧 답이다:
 *  기록을 못 읽었다(503 — 없는 게 아니다) · 기록이 없다(404) · 주인이 아니다(403 — 초대받은 사람도 이름은 못 바꾼다, 중앙 assertManage 와 같다) ·
 *  다른 세션으로 이어진 옛 행이다(409 — 이름은 이어진 새 세션에) · 다듬으니 빈 이름(400).
 */
export function storedLabelRefusal(
  row: { owner: string; superseded_by?: string | null } | null | undefined, me: string, label: string, readFailed: boolean,
): { status: number; message: string } | null {
  if (readFailed) return { status: 503, message: "세션 기록을 읽지 못했습니다 — 잠시 뒤 다시 해 주세요" };
  if (!row) return { status: 404, message: "세션을 찾을 수 없습니다" };
  if (!me || row.owner !== me) return { status: 403, message: "내 세션만 이름을 바꿀 수 있습니다" };
  if (row.superseded_by) return { status: 409, message: "이 세션은 새 세션으로 이어졌어요 — 이어진 세션에서 이름을 바꿔 주세요" };
  if (!label) return { status: 400, message: "이름이 필요합니다" };
  return null;
}
