// 멤버 비활성 전이 → 앱 발자국 회수(#1780 v2 §7-1, 설계 R2-O8).
//  멤버가 비활성/삭제되면 라이블리 토큰은 verifyDbToken 이 즉시 401 로 막지만, **tmux 세션·하네스·LLM 소비는 계속**된다
//  (벤더 자격은 라이블리 토큰과 무관) — 그리고 앱 동의(org_app_grant)는 FK 가 없어 남아 재활성화 때 부활한다.
//  여기서 (a) 그 멤버의 모든 앱 grant 회수 (b) `owner=멤버 ∧ app_id 있음` 세션을 즉시 회수(복원 카드도 남기지 않는다 —
//  복원은 grant 재검사에서 어차피 403) 한다. **일반 세션은 건드리지 않는다**(멤버 비활성의 일반 세션 정책은 별도 축).
//
//  배선: members.ts 의 onMemberDeactivated 단일 슬롯(registry.onTaskDone 선례) 에 부팅 스텝이 armMemberDeactivationHook 으로 건다.
//  terminal/node 모듈은 **지연 import** — terminal/sessions.ts 가 apps/principal.ts 를 import 하므로 정적 import 면 순환.
//  회수 자체는 순수 오케스트레이션(reclaimMemberAppFootprint) 으로 두고 deps 를 주입해 단위 테스트한다(failed-session-reaper 선례).
import { logger } from "../log.js";
import { revokeAllGrantsForMember } from "../org/store/apps.js";
import { onMemberDeactivated } from "../org/store/members.js";
import { listSessionStatesForOwner, deleteSessionState } from "../sessions/session-state.js";

export interface ReclaimSessionRow { id: string; app_id?: string | null; node_id?: string | null }

export interface ReclaimDeps {
  revokeGrants(memberId: string): Promise<number>;
  listSessions(owner: string): Promise<ReclaimSessionRow[]>;
  killCentral(id: string): Promise<void>;
  killNode(nodeId: string, id: string, owner: string): Promise<void>;
  deleteState(id: string): Promise<void>;
}

export interface ReclaimResult { grants: number; sessions: string[]; failed: string[] }

/** 순수 오케스트레이션 — 한 세션의 회수 실패가 나머지를 막지 않는다(failed 에 모아 돌려준다). */
export async function reclaimMemberAppFootprint(memberId: string, deps: ReclaimDeps): Promise<ReclaimResult> {
  const grants = await deps.revokeGrants(memberId);
  const rows = await deps.listSessions(memberId);
  const sessions: string[] = [];
  const failed: string[] = [];
  for (const s of rows) {
    if (!s.app_id) continue; // 일반 세션은 이 축의 대상이 아니다
    try {
      if (s.node_id) await deps.killNode(s.node_id, s.id, memberId);
      else await deps.killCentral(s.id);
      await deps.deleteState(s.id);
      sessions.push(s.id);
    } catch (err) {
      failed.push(s.id);
      logger.warn({ err, member: memberId, session: s.id, node: s.node_id ?? null }, "member deactivation: app session reclaim failed");
    }
  }
  return { grants, sessions, failed };
}

export function defaultReclaimDeps(): ReclaimDeps {
  return {
    revokeGrants: revokeAllGrantsForMember,
    listSessions: listSessionStatesForOwner,
    killCentral: async (id) => {
      const { reapCentralSession } = await import("../terminal/terminal-sessions.js");
      await reapCentralSession(id);
    },
    killNode: async (nodeId, id, owner) => {
      const { nodeRpc } = await import("../node/registry.js");
      await nodeRpc(nodeId, "kill", { user: { userId: owner }, id });
    },
    deleteState: deleteSessionState,
  };
}

/** 부팅 스텝이 부른다 — 이후 멤버 비활성/삭제 전이마다 회수가 돈다. */
export function armMemberDeactivationHook(deps: ReclaimDeps = defaultReclaimDeps()): void {
  onMemberDeactivated(async (memberId, reason, actor) => {
    const r = await reclaimMemberAppFootprint(memberId, deps);
    if (r.grants || r.sessions.length || r.failed.length) {
      logger.info({ member: memberId, reason, actor, ...r }, "member deactivated — app grants revoked, app sessions reclaimed");
    }
  });
}
