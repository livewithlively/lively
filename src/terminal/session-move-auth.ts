// 세션 소속 바꾸기(옮기기)를 **누가** 할 수 있나 — 그리고 누구 이름으로 실행하나 (#3870, 원준 2026-09-30 «초대받은 사람도 되게»).
//
//  ★ 초대받은 사람도 옮긴다. 초대받은 사람은 이미 그 세션에 주인 이름으로 지시를 넣을 수 있다(canAttach) — 소속을 바꾸는 것은
//   그보다 큰 권한이 아니다. 다만 실행은 **언제나 주인 이름으로** 한다: 실행 세션 행(execution_session.owner)·노드의 소유 확인·
//   tmux `@box_owner` 확인이 모두 주인을 기준으로 잠겨 있고, 요청자를 그 자리에 넣으면 남의 세션 id 를 제 것으로 claim 하는
//   모양이 된다(execution-session-store 의 ON CONFLICT … WHERE owner 가 막아 403 이 났다).
//  순수 함수다 — 재료(행·tmux·canAttach)는 호출부(session-project-routes.setSessionProject)가 모은다.

export interface MoveAuthFacts {
  /** 요청한 사람. */
  me: string;
  /** 세션이 다른 컴퓨터(노드)에 있나 — 그때는 desired-state 행이 소유·초대의 정본이다. */
  node: boolean;
  /** 노드 세션의 desired-state 행(없으면 null). */
  st?: { owner: string; invites?: string[] | null } | null;
  /** 이 박스(tmux) 세션의 `@box_owner`(없으면 ''). */
  localOwner?: string;
  /**
   * 요청자가 이 세션에 **초대받아 들어갈 수 있나** — 입장 판정 canAttach(초대 명단 + 그 세션 프로젝트의 공개범위 #1291)의 답.
   *  노드·박스 공통이다. 초대 명단만 보면 초대 뒤에 그 프로젝트를 못 보게 된 사람도 통과한다(격리 리뷰 지적 — 다른 모든 세션 동작은
   *  canAttach 로 막는다). 주인이면 보지 않는다. 생략 = 아니다(fail-closed).
   */
  invited?: boolean;
  /** 외부 실행 세션이 제 문맥으로 부른 것(인증 헤더의 자기 id). */
  externalSelf?: boolean;
}

export type MoveAuth = { ok: true; owner: string } | { ok: false; status: number; message: string };

export const MOVE_FORBIDDEN = "이 세션을 만든 사람이나 초대받은 사람만 프로젝트를 바꿀 수 있습니다";

export function sessionMoveAuth(f: MoveAuthFacts): MoveAuth {
  if (f.node) {
    if (!f.st) return { ok: false, status: 404, message: "세션을 찾을 수 없습니다" };
    const owner = f.st.owner;
    if (owner === f.me || (f.invited && (f.st.invites ?? []).includes(f.me))) return { ok: true, owner };
    return { ok: false, status: 403, message: MOVE_FORBIDDEN };
  }
  const local = String(f.localOwner || "");
  if (!local) return f.externalSelf ? { ok: true, owner: f.me } : { ok: false, status: 404, message: "세션을 찾을 수 없습니다" };
  if (local === f.me || f.invited) return { ok: true, owner: local };
  return { ok: false, status: 403, message: MOVE_FORBIDDEN };
}
