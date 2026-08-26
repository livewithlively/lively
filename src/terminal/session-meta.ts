// 세션 하나의 메타(GET /api/ui/terminal/sessions/:id) 중 **죽은 세션이 '복원 가능'이라고 말하는 자리** (#1820).
//
// 왜 라우트에서 꺼냈나 — 이 응답의 `restorable`/`canRestore` 는 화면이 "열기 = 복원"을 판정하는 **유일한 신호**다.
//  이 신호가 빠지면 터미널 페이지의 goneMode 가 'end'(그냥 끝난 세션)로 떨어져 **어떤 진입점에서도 복원이 안 된다**.
//  실제로 그런 회귀가 6일간 있었다(2026-08-14 ~ 08-20): #109(3be85ae)가 ownerMeta 를 desired(DB) 우선으로 바꾸면서
//  **죽은 박스 세션도 canAttach 를 통과**하게 됐고, 라우트는 그 뒤 tmux 에서 라벨을 읽어 `{label:"", projectId:0}` 만
//  돌려줬다 — restorable 이 통째로 빠진 응답이다. 라우트 한복판의 인라인 분기라 이걸 지키는 테스트가 없었다.
//  그래서 판정을 순수 함수로 꺼내 표로 고정한다(session-meta.test.ts).
//
// ⚠ DB·tmux·express 를 부르지 않는다(순수) — 그래야 표가 테스트로 고정된다.

/** 복원 판정에 필요한 desired-state 필드만(= org_session_state 의 부분집합). */
export interface DeadSessionStateLike {
  owner: string;
  label?: string | null;
  project_id?: number | null;
  harness?: string | null;
  exited_at?: string | null;
  exit_reason?: string | null;
}

/** 죽은 세션의 메타 응답 본문. `restorable: true` 가 곧 "박스에 없다 = 되살릴 수 있다". */
export interface DeadSessionMeta {
  id: string;
  label: string;
  projectId: number;
  restorable: true;
  /** 되살릴 수 있는 사람인가 — 소유자·admin 만. 프로젝트 세션은 남에게도 **보이되** 복원은 소유자 몫(#1059). */
  canRestore: boolean;
  /** 사용자가 직접 끝냈나(/exit·logout). 화면 문구를 가른다 — 자동 복원 여부를 가르지는 않는다(#1820). */
  exitedByUser: boolean;
  /** 메모리 부족으로 OS 가 끝냈나(#1251). exited_at 이 있으면 그쪽이 이긴다(확정 > 추정). */
  oomKilled: boolean;
  /** 하네스(claude·codex·shell…) — 이어받기 문구와 복원 인자를 가른다. */
  harness: string;
}

export type DeadSessionMetaResult =
  | { kind: "ok"; body: DeadSessionMeta }
  /** desired-state 가 없다 = 되살릴 근거가 없는 '진짜 끝난 세션'. 호출자는 종전 흐름을 계속한다. */
  | { kind: "none" }
  /** 남의 개인 세션 — 존재조차 알리지 않는다. 호출자는 403. */
  | { kind: "forbidden" };

/**
 * 죽은(박스/노드에 없는) 세션의 메타를 만든다.
 *
 * 노출 범위는 **복원 권한과 같은 축**이다: 소유자·admin 은 전부 보고 되살릴 수 있고, 프로젝트 세션은 전원에게
 *  보이되(#452 공동 세션) 되살리는 건 소유자 몫이다(canRestore=false → 화면이 '소유자만 열기'로 안내).
 */
export function deadSessionMeta(
  id: string,
  st: DeadSessionStateLike | null | undefined,
  viewerId: string,
  isAdmin: boolean,
): DeadSessionMetaResult {
  if (!st || !st.owner) return { kind: "none" };
  const mine = st.owner === viewerId || isAdmin;
  const projectId = Number(st.project_id ?? 0) || 0;
  if (!mine && projectId <= 0) return { kind: "forbidden" };
  return {
    kind: "ok",
    body: {
      id,
      label: st.label || id,
      projectId,
      restorable: true,
      canRestore: mine,
      exitedByUser: !!st.exited_at,
      oomKilled: !st.exited_at && st.exit_reason === "oom",
      harness: st.harness || "shell",
    },
  };
}

/**
 * 노드 세션 메타의 갈래 — **'지금 살아 있나'를 먼저 묻는다**(2026-08-26 상민님 신고).
 *
 * 종전엔 desired-state 에 node_id 가 **있다는 것만 보고** 곧바로 deadSessionMeta(restorable=true)로 갔다.
 *  생사 확인이 `?node=` 를 받은 갈래에만 있었기 때문인데, 목록이 좌표를 떨어뜨리면(게이트웨이와 노드가 같은
 *  tmux 를 볼 때 — sessions/session-merge.ts) 화면은 좌표 없이 물어볼 수밖에 없다. 그러면 **지금 돌고 있는
 *  세션이 '죽었다'고 답해지고**, 그 오답을 받은 셸이 대화록 기반 이어받기로 흘러 빈 새 세션을 만든다
 *  (실측 dev: 프로젝트 하나에 「새 세션(원본 기반)」이 4개 쌓였다).
 *
 * ⚠ 호출 규약 — 라우트는 `?node=` 를 받은 갈래에서 **이미 그 노드를 물어보고 못 찾았을 때** 여기로 온다.
 *  그래서 askedNode 가 stateNode 와 같으면 같은 스냅샷을 다시 보지 않는다(답이 같다). 그 경우 aliveOn 은
 *  아예 부르지 않는다 — 중복 조회를 막는 것이 이 갈래의 계약이다.
 *
 * 순수 — 스냅샷 조회는 aliveOn 으로 주입한다(위 머리말 '표를 테스트로 고정한다').
 */
export function nodeSessionMetaMode(
  askedNode: string,
  stateNode: string,
  aliveOn: (nodeId: string) => boolean,
): "alive" | "dead" {
  if (!stateNode) return "dead";              // 노드 세션이 아니다 — 호출자가 이 갈래로 보내지 않는다(방어)
  if (askedNode === stateNode) return "dead"; // 이미 물어보고 못 찾았다
  return aliveOn(stateNode) ? "alive" : "dead";
}
