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
import { revokeAllGrantsForMember, transferOwnedAppsToAdmins, type AppVisibility } from "../org/store/apps.js";
import { notifyAppInstaller } from "./notify.js";
import { listActiveAdminIds, onMemberDeactivated } from "../org/store/members.js";
import { listSessionStatesForOwner, deleteSessionState } from "../sessions/session-state.js";

export interface ReclaimSessionRow { id: string; app_id?: string | null; node_id?: string | null }

export interface ReclaimDeps {
  revokeGrants(memberId: string): Promise<number>;
  /**
   * #4667 떠난 사람이 책임지던 앱 — 책임자를 «관리자»(NULL)로 넘긴다(만든 사람 기록은 그대로). 앱 · 데이터 · 자동화는 멈추지 않는다
   *  (퇴사 한 번에 팀 업무가 멈추지 않게 — 설계 §12 ⑤-4). 돌려준 앱들을 notifyAdmins 가 관리자 모두에게 알린다. 없으면 이 단계를 건너뛴다.
   */
  transferApps?(memberId: string): Promise<Array<{ id: string; title: string; visibility: AppVisibility }>>;
  notifyAdmins?(memberId: string, apps: Array<{ id: string; title: string; visibility: AppVisibility }>): Promise<number>;
  listSessions(owner: string): Promise<ReclaimSessionRow[]>;
  killCentral(id: string): Promise<void>;
  killNode(nodeId: string, id: string, owner: string): Promise<void>;
  deleteState(id: string): Promise<void>;
  stopWorkers(memberId: string): Promise<number>;
  /** #4684 — 그 사람이 붙여 둔 세션들의 앱 폴더를 다시 맞춘다(동의가 사라졌으니 빠진다). 없으면 건너뛴다. 기다리지 않는다. */
  resyncAppFolders?(memberId: string): void;
}

export interface ReclaimResult { grants: number; workers: number; sessions: string[]; failed: string[]; apps_transferred?: string[] }

/** 순수 오케스트레이션 — 한 세션의 회수 실패가 나머지를 막지 않는다(failed 에 모아 돌려준다). */
export async function reclaimMemberAppFootprint(memberId: string, deps: ReclaimDeps): Promise<ReclaimResult> {
  const grants = await deps.revokeGrants(memberId);
  const workers = await deps.stopWorkers(memberId);
  deps.resyncAppFolders?.(memberId);
  //  #4667 — 책임자 이관은 회수와 따로 실패한다(로그만) — 세션 회수가 이관 실패에 막히지 않게.
  let appsTransferred: string[] | undefined;
  if (deps.transferApps) {
    try {
      const moved = await deps.transferApps(memberId);
      appsTransferred = moved.map((a) => a.id);
      if (moved.length && deps.notifyAdmins) await deps.notifyAdmins(memberId, moved);
    } catch (err) {
      logger.warn({ err, member: memberId }, "member deactivation: app owner transfer failed");
    }
  }
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
  return { grants, workers, sessions, failed, ...(appsTransferred ? { apps_transferred: appsTransferred } : {}) };
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
    stopWorkers: async (memberId) => {
      const { stopWorkersForMember } = await import("./worker-service.js");
      return stopWorkersForMember(memberId, "member_deactivated");
    },
    resyncAppFolders: (memberId) => {
      void import("./session-app-folders.js").then(({ resyncSessionsAttachedBy }) => resyncSessionsAttachedBy(memberId, "멤버 비활성")).catch(() => undefined);
    },
    transferApps: transferOwnedAppsToAdmins,
    notifyAdmins: notifyAdminsOfTransfer,
  };
}

/** 넘어온 앱을 관리자 모두에게 알린다(앱마다 한 건 · 「확인할 것」 의 앱 알림). 보낸 수. */
export async function notifyAdminsOfTransfer(memberId: string, apps: Array<{ id: string; title: string; visibility: AppVisibility }>): Promise<number> {
  const admins = (await listActiveAdminIds()).filter((a) => a !== memberId);
  let sent = 0;
  for (const a of apps) {
    for (const admin of admins) {
      const r = await notifyAppInstaller({
        appId: a.id, memberId: admin,
        title: `「${a.title}」 앱의 책임자가 관리자로 넘어왔습니다`,
        body: `만든 사람(${memberId})이 워크스페이스를 떠나 이 앱의 책임자를 관리자로 바꿨습니다. 앱과 데이터는 그대로 돌고, 이 앱의 알림(자동화 실패 등)은 이제 관리자에게 옵니다.`
          + (a.visibility === "me" ? " 공개하지 않은(나만 보는) 앱이라 지금은 관리자만 열 수 있습니다." : "")
          + " 다른 구성원에게 맡기려면 app_owner_set.",
        dedupe_key: `app-owner-transfer:${a.id}`,
      }).catch(() => null);
      if (r && r.ok && "notification" in r) sent++;
    }
  }
  return sent;
}

/** 부팅 스텝이 부른다 — 이후 멤버 비활성/삭제 전이마다 회수가 돈다. */
export function armMemberDeactivationHook(deps: ReclaimDeps = defaultReclaimDeps()): void {
  onMemberDeactivated(async (memberId, reason, actor) => {
    const r = await reclaimMemberAppFootprint(memberId, deps);
    if (r.grants || r.workers || r.sessions.length || r.failed.length) {
      logger.info({ member: memberId, reason, actor, ...r }, "member deactivated — app grants revoked, app sessions reclaimed");
    }
  });
}
