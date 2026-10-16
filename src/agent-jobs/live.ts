// 작업 컨테이너 — 살아 있는 의존(DB · 브로커 · 토큰 · 판정)을 service.ts 에 잇는다 (#4490 앱 v2-11).
//  service.ts 는 이 묶음을 받아서만 움직인다 — 시험은 가짜 묶음으로 같은 흐름을 잰다.
import crypto from "node:crypto";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import type { LivelyUser } from "../context.js";
import { MCP_TOKEN_SLACK_SEC, type AgentJobDeps } from "./service.js";

let cached: AgentJobDeps | null = null;

export async function liveAgentJobDeps(): Promise<AgentJobDeps> {
  if (cached) return cached;
  const store = await import("./store.js");
  const launch = await import("./launch.js");
  const pol = await import("../org/policies/agent-job-policy.js");
  const { currentTenant, withTenant } = await import("../org/tenant-context.js");
  const { tenantSlug } = await import("../terminal/catalog.js");
  cached = {
    store,
    policy: () => pol.effectiveAgentJobPolicy(async () => pol.resolveAgentJobPolicy(await store.agentJobPolicyRow())),
    available: () => launch.jobContainersAvailable(),
    launch: (job, boot) => launch.launchJobContainer(job, boot),
    kill: (sid) => launch.killJobContainer(sid),
    mintMcpToken: async (job) => {
      const ttlSec = job.timeout_sec + MCP_TOKEN_SLACK_SEC;
      if (job.app_id && job.account_member) {
        //  앱 작업 — 앱 토큰(구성원 권한 ∩ 앱 동의 · 도구도 그 앱 동의 목록으로 좁혀진다 — principal.requireAppTool).
        const { mintAppToken } = await import("../apps/principal.js");
        const t = await mintAppToken(job.account_member, job.app_id, "agent-job", { ttlSec });
        return { token: t.token, tokenHash: t.tokenHash };
      }
      if (!job.account_member) return null;
      //  사람이 직접 시킨 작업 — 그 사람의 세션 토큰과 같은 급(멤버 권한을 따라간다 · 작업 상한만큼만 산다).
      const { getMember } = await import("../org/store/members.js");
      const m = await getMember(job.account_member);
      if (!m || m.state !== "active") return null;
      const { mintToken } = await import("../org/store/tokens.js");
      const t = await mintToken({
        userId: m.id, memberId: m.id, scopes: Array.isArray(m.scopes) ? m.scopes : [], followMemberScopes: true,
        label: `agent-job:${job.id}`, expiresInSec: ttlSec,
      }, "agent-job", "agent-job");
      return { token: t.token, tokenHash: t.tokenHash };
    },
    revokeToken: async (hash) => {
      const { revokeToken } = await import("../org/store/tokens.js");
      await revokeToken(hash, "agent-job", "agent-job");
    },
    assertProjectCwd: async (user, projectId) => {
      //  사람 세션을 그 폴더에서 열 때와 같은 판정(공유 폴더 공개범위 · 관리자도 우회 안 함).
      const { assertSessionCwdVisibleTo } = await import("../v6/shared-folder-store.js");
      await assertSessionCwdVisibleTo(user.userId || null, "shared", `project/${projectId}`);
    },
    assertAppUsable: async (user: LivelyUser, appId: string) => {
      const { getApp, getActiveGrant } = await import("../org/store/apps.js");
      const { canSeeApp } = await import("../apps/visibility.js");
      const app = await getApp(appId);
      if (!app || !canSeeApp(app, { userId: user.userId, scopes: user.scopes ?? [] })) throw new HttpError(404, `앱 없음: ${appId}`);
      if (app.status !== "active" || !app.enabled) throw new HttpError(409, `앱 '${appId}' 이 활성 상태가 아닙니다`);
      if (!user.userId || !(await getActiveGrant(appId, user.userId))) throw new HttpError(403, `앱 '${appId}' 사용 동의(grant)가 없습니다`);
    },
    later: (fn, ms) => {
      const t = currentTenant();
      const run = (): void => {
        void Promise.resolve(t ? withTenant(t, fn) : fn())
          .catch((e) => logger.warn({ err: (e as Error)?.message ?? String(e) }, "[agent-job] 뒤로 미룬 일 실패(감시가 다시 본다)"));
      };
      if (ms <= 0) setImmediate(run);
      else setTimeout(run, ms).unref?.();
    },
    workspaceSlug: () => tenantSlug(),
    hex8: () => crypto.randomBytes(4).toString("hex"),
    now: () => Date.now(),
  };
  return cached;
}
