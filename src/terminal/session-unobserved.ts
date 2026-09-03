// 관측 못 한 세션 (#2544 · #2258 이동 2 의 2단계) — «세션 목록의 정본은 DB, tmux 는 관측» 의 목록 쪽 조각.
//
// ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
// collectSessions 는 tmux `list-sessions` 한 줄로 목록의 **집합**을 정했다. 매니지드에선 그 한 줄이 중계
//  (tmux-relay → 허브 → 브로커 → 테넌트 tmux 컨테이너)를 지나므로, 브로커 재접속 창·허브 503·타임아웃 같은
//  «못 봤다» 가 곧 «세션이 0개다» 로 읽혔다. 그러면 호출부(listRestorableSessions)가 DB 행 전부를
//  «복원 가능(중단됨)» 으로 내보내 **살아 있는 세션 전부가 그 폴링 한 번에 죽은 것처럼** 보였다
//  (hub-epipe-kills-control-plane-2258 의 5분 장애 동안 정확히 그 화면이었다). 열기=복원(#1820)이 그 행에
//  발동하면 멀쩡한 세션을 «되살려» 두 벌이 된다.
//
// ── 고치는 방향 — 대체가 아니라 병합 ─────────────────────────────────────────
//  · «없다»(tmux 가 답해서 서버 부재·세션 0) 는 종전 그대로 빈 목록 → DB 행이 복원 가능으로 뜬다(옳다).
//  · «못 봤다»(비확답) 는 **매니지드 중계일 때만** DB desired 행을 «관측 못 함»(observed:false) 으로 내보낸다.
//    attached·agentState 는 기본값(오프라인)이고 **restorable 을 약속하지 않는다** — 화면은 회색 세션으로 그리고,
//    열면 attach 가 4403 으로 재시도한다(#835 «모르면 종료라 말하지 않는다»). 중계가 돌아오면 다음 폴링이 관측으로 덮는다.
//  · 셀프호스팅(중계 없음)·registry 모드는 이 조각에 **들어오지 않는다** — 로컬 tmux 실패의 의미가 다르고(그 호스트에
//    tmux 가 없으면 세션도 없다), 그쪽 동작을 바꾸지 않는 것이 이 단계의 완료 조건이다.
//  · strict 호출(«없음» 과 «모름» 을 갈라야 하는 생성·파괴 판정)은 종전대로 던진다 — 여기 오기 전에 throw 된다.
import type { SessionInfo } from "./catalog.js";
import type { SessionState } from "../sessions/session-state.js";
import { isNoTmuxServer } from "./tmux-exec.js";

/**
 * tmux 목록 실패가 «못 봤다» 인가(순수) — 매니지드 중계에서만 참. «없다»(서버 부재 확답)는 거짓.
 *  viaRelay 는 `tmux-exec.tmuxViaRelay()` — 호출부가 넘긴다(순수성 유지).
 *  ⚠ #2599 T3 — 종전엔 `tmuxRelayManaged()` 였고, 그 이름은 gone 확답 판정과 **같은 술어를 공유**했다.
 *   T3 이 둘을 갈랐다(`tmuxServerAbsenceIsFinal` / `tmuxViaRelay`). 여기가 받아야 하는 것은 **중계 여부**다 —
 *   위 머리말의 «registry 는 이 조각에 들어오지 않는다» 가 #2544 의 완료 조건이라, gone 확답이 전용 소켓까지
 *   넓어져도 이 폴백은 그대로 중계 전용으로 남는다.
 */
export function shouldFallbackToDesired(err: unknown, viaRelay: boolean): boolean {
  return viaRelay && !isNoTmuxServer(err);
}

/**
 * DB desired 행 → «관측 못 한» 세션 행(순수). 관측값(attached·pane·phase)은 전부 기본값이다.
 *  ⚠ restorable 을 싣지 않는다 — 이 행은 «죽었다» 가 아니라 «모른다» 다.
 */
export function unobservedSessionInfo(s: SessionState, me: string | null): SessionInfo {
  return {
    id: s.id, label: s.label || s.id, harness: s.harness || "shell", dir: s.dir || "",
    autoApprove: !!s.auto_approve, owner: s.owner || "", owned: me !== null && !!s.owner && s.owner === me,
    created: s.created || 0, attached: false, invites: s.invites || [], flags: s.flags || {},
    projectId: s.project_id || 0, appId: s.app_id || undefined,
    agentState: "offline", working: false, awaiting: false, title: "",
    lastActive: s.last_busy || undefined,
    observed: false,
  };
}
