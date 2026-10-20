// 앱 AI 실행 — 살아 있는 의존(DB · 자격 금고 · 작업 컨테이너 · LLM · 정책)을 service.ts 에 잇는다 (#4488 앱 v2-9).
import crypto from "node:crypto";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import type { LivelyUser } from "../context.js";
import { RateWindow } from "../apps/app-chat-send.js";
import { PROXY_TOKEN_PREFIX, type AiRunDeps, type SubmitJobInput } from "./service.js";
import { parseAccountSettings } from "./plan.js";

/** 워크스페이스 Anthropic API 키의 자격 금고 kind(org_credential_set kind=anthropic_api_key · owner=gateway). */
export const ANTHROPIC_KEY_KIND = "anthropic_api_key";

/** 워크스페이스 동시 프록시 호출 셈 — 프로세스 메모리(청/녹 두 슬롯이면 각자 센다 · 상한이 느슨해질 뿐 막히지 않는다). */
class Inflight {
  private n = new Map<string, number>();
  count(key: string): number { return this.n.get(key) ?? 0; }
  take(key: string, max: number): boolean { const c = this.count(key); if (c >= max) return false; this.n.set(key, c + 1); return true; }
  release(key: string): void { const c = this.count(key); if (c <= 1) this.n.delete(key); else this.n.set(key, c - 1); }
}
export const inflight = new Inflight();
const rate = new RateWindow(30);

export function hashProxyToken(token: string): string { return crypto.createHash("sha256").update(token).digest("hex"); }
export function newProxyToken(): { token: string; hash: string } {
  const token = PROXY_TOKEN_PREFIX + crypto.randomBytes(24).toString("base64url");
  return { token, hash: hashProxyToken(token) };
}

/** 워크스페이스 API 키 — 자격 금고(gateway 소유). 없으면 null. 값은 호출 헤더에만 쓰고 로그 · 응답에 싣지 않는다. */
export async function workspaceApiKey(): Promise<string | null> {
  const { getMemberSecret, GATEWAY_OWNER } = await import("../org/credentials/member-secret-store.js");
  const s = await getMemberSecret(GATEWAY_OWNER, ANTHROPIC_KEY_KIND, "").catch(() => null);
  const v = s?.secret?.trim();
  return v ? v : null;
}

/** 이 사람이 이 앱을 지금 쓸 수 있나(보임 · 켜짐 · 동의) — 작업 컨테이너와 같은 판정. */
async function assertAppUsableFor(user: LivelyUser, appId: string): Promise<void> {
  const { getApp, getActiveGrant } = await import("../org/store/apps.js");
  const { canSeeApp } = await import("../apps/visibility.js");
  const app = await getApp(appId);
  if (!app || !canSeeApp(app, { userId: user.userId, scopes: user.scopes ?? [] })) throw new HttpError(404, `앱 없음: ${appId}`);
  if (app.status !== "active" || !app.enabled) throw new HttpError(409, `앱 '${appId}' 이 활성 상태가 아닙니다`);
  if (!user.userId || !(await getActiveGrant(appId, user.userId))) throw new HttpError(403, `앱 '${appId}' 사용 동의(grant)가 없습니다`);
}

let cached: AiRunDeps | null = null;
export async function liveAiRunDeps(): Promise<AiRunDeps> {
  if (cached) return cached;
  const store = await import("./store.js");
  const pol = await import("../org/policies/ai-run-policy.js");
  const { currentTenant, withTenant } = await import("../org/tenant-context.js");
  const { appSqlTenantId } = await import("../apps/app-sql-exec.js");
  const { isAdmin } = await import("../capabilities/principal.js");
  cached = {
    store,
    policy: () => pol.effectiveAiRunPolicy(async () => pol.resolveAiRunPolicy(await store.aiRunPolicyRow())),
    accountSettings: async () => parseAccountSettings(await store.aiAccountRow()),
    apiKey: workspaceApiKey,
    getApp: async (id) => (await import("../org/store/apps.js")).getApp(id),
    assertAppUsable: assertAppUsableFor,
    submitJob: async (j: SubmitJobInput, user: LivelyUser) => {
      //  작업 컨테이너 접수 — 입력 검증(앱 폴더 · 프로젝트 폴더)은 agent-jobs/service.submitAgentJob 과 같은 자.
      const svc = await import("../agent-jobs/service.js");
      const jobs = await (await import("../agent-jobs/live.js")).liveAgentJobDeps();
      if (!(await jobs.available())) throw new HttpError(501, "작업 컨테이너는 매니지드 워크스페이스에서만 돕니다 — 이 실행은 단발(프록시)로만 됩니다");
      const plan = await import("../agent-jobs/plan.js");
      const p = await jobs.policy();
      if (j.projectId != null) await jobs.assertProjectCwd(user, j.projectId);
      const cwd = j.projectId != null ? plan.projectFolderCwd(j.projectId) : plan.appFolderCwd(j.appId);
      let resumeConv: string | null = null;
      if (j.resumeJobId != null) {
        const prev = await jobs.store.getAgentJob(j.resumeJobId);
        if (!prev || !prev.conversation_id) throw new HttpError(409, "이어받을 작업의 대화가 없습니다");
        resumeConv = prev.conversation_id;
      }
      const row = await svc.enqueueAgentJob({
        requester: j.requester, accountKind: j.accountKind, accountMember: j.accountMember, appId: j.appId, projectId: j.projectId, cwd,
        harness: "claude", model: j.model, label: j.label, prompt: j.prompt, resumeConversation: resumeConv, resumeJobId: j.resumeJobId,
        timeoutSec: plan.timeoutSecOf(j.timeoutMin ?? undefined, p), bare: j.bare,
      }, p, jobs);
      return { id: row.id };
    },
    getJob: async (id) => (await import("../agent-jobs/store.js")).getAgentJob(id),
    cancelJob: async (id, user) => {
      const svc = await import("../agent-jobs/service.js");
      const jobs = await (await import("../agent-jobs/live.js")).liveAgentJobDeps();
      await svc.cancelAgentJobFor(id, user, jobs).catch((e) => { if (!(e instanceof HttpError && e.status === 404)) throw e; });
    },
    singleShot: async (key, i, signal) => (await import("./anthropic.js")).singleShot(key, i, signal),
    newProxyToken,
    inflight,
    rate,
    tenant: appSqlTenantId,
    later: (fn, ms) => {
      const t = currentTenant();
      const run = (): void => {
        //  동기로 던져도 uncaught 가 되지 않게 then 안에서 부른다(격리 리뷰 nit).
        void Promise.resolve().then(() => (t ? withTenant(t, fn) : fn()))
          .catch((e) => logger.warn({ err: (e as Error)?.message ?? String(e) }, "[ai-run] 뒤로 미룬 일 실패(정비가 다시 본다)"));
      };
      if (ms <= 0) setImmediate(run); else setTimeout(run, ms).unref?.();
    },
    now: () => Date.now(),
    sessionTie: async (sid, member) => {
      const { sessionCanEnter, sessionOwnerOf } = await import("../apps/session-apps.js");
      const { getSessionState } = await import("../sessions/session-state.js");
      const { normalizeSessionKind } = await import("../sessions/session-kind.js");
      const st = await getSessionState(sid).catch(() => undefined);
      //  주인은 다리(requireSessionParticipant → sessionOwnerOf)와 같은 근거로 — 상태 행이 없고 tmux 에만 주인이 있는 세션에서 둘이 어긋나지 않게(재검토 nit).
      const owner = String(st?.owner ?? "").trim() || (await sessionOwnerOf(sid).catch(() => null));
      if (!owner) return { owner: null, participant: false, human: false };
      return { owner, participant: owner === member || (await sessionCanEnter(sid, member).catch(() => false)), human: normalizeSessionKind(st?.kind) === "human" };
    },
    attachedSessions: async (appId, member) => {
      const { sessionsWithApp, sessionCanEnter, sessionOwnerOf } = await import("../apps/session-apps.js");
      const { getSessionLabel } = await import("../terminal/tmux-exec.js");
      const out: Array<{ session_id: string; title: string; owner_is_you: boolean }> = [];
      for (const sid of (await sessionsWithApp(appId)).slice(0, 50)) {
        const owner = await sessionOwnerOf(sid).catch(() => null);
        if (owner !== member && !(await sessionCanEnter(sid, member).catch(() => false))) continue;
        out.push({ session_id: sid, title: await getSessionLabel(sid).catch(() => ""), owner_is_you: owner === member });
      }
      return out;
    },
    subscriptionLoggedIn: async (member) => loginCache.get(member, async () => {
      const { aiLoginCheck } = await import("../terminal/profiles.js");
      const { getMember } = await import("../org/store/members.js");
      const m = await getMember(member);
      if (!m || m.state !== "active") return false;
      const r = await aiLoginCheck({ userId: m.id, email: m.email ?? "", scopes: Array.isArray(m.scopes) ? m.scopes : [], projects: ["*"] } as LivelyUser, "claude");
      return r.loggedIn;
    }),
    isAdmin,
    isJobToken: async (prefix) => (await import("../agent-jobs/store.js")).isAgentJobToken(prefix),
    forkSession: forkSessionFacts,
    forkConsent: async (member, app) => {
      //  선언(그 사람이 보는 판의 매니페스트) → 동의(활성 grant) → 동의가 그 표지를 덮나(옛 범위면 다시 동의). ★ 표지 이름 그대로만 본다 —
      //   글롭(`app_*` · `*`) 선언은 동의 창에 «붙은 세션에서 실행» 줄을 세우지 않으니(web/v2/app-session.ts) 그 동의로 분기를 열지 않는다(격리 리뷰).
      const { forkConsentOf } = await import("./fork.js");
      const { getActiveGrant } = await import("../org/store/apps.js");
      const { viewAppFor } = await import("../apps/app-view.js");
      const view = await viewAppFor(app, { userId: member }).then((v) => v.app).catch(() => app);
      const p = (view.manifest as { permissions?: { tools?: unknown } } | null)?.permissions;
      const declared = Array.isArray(p?.tools) ? p.tools.map(String) : [];
      const grant = await getActiveGrant(app.id, member);
      return forkConsentOf(declared, grant ? { tools: Array.isArray(grant.tools) ? grant.tools.map(String) : [] } : null);
    },
    forkManaged: async () => (await import("../agent-jobs/launch.js")).jobContainersAvailable(),
    blockConnectors: async () => (await import("../terminal/claude-ai-connectors-policy.js")).claudeAiConnectorsBlocked("claude"),
    submitForkJob: async (j) => {
      //  분기 작업 접수 — 그 세션 주인의 자리 · 구독(account_member = 주인) · 그 세션의 작업 폴더. 보낸 사람(requester)은 행에 따로 남는다.
      const svc = await import("../agent-jobs/service.js");
      const jobs = await (await import("../agent-jobs/live.js")).liveAgentJobDeps();
      const plan = await import("../agent-jobs/plan.js");
      const p = await jobs.policy();
      const row = await svc.enqueueAgentJob({
        requester: j.requester, accountKind: "subscription", accountMember: j.owner, appId: j.appId, projectId: j.projectId, cwd: j.cwd,
        harness: "claude", model: j.spec.model, label: j.label, prompt: j.prompt, resumeConversation: null, resumeJobId: null,
        timeoutSec: plan.timeoutSecOf(j.timeoutMin ?? undefined, p), fork: j.spec as unknown as Record<string, unknown>,
      }, p, jobs);
      return { id: row.id };
    },
  };
  return cached;
}

/**
 * #4489 분기 대상 세션의 사실 — 세션 복제(#4135 terminal/routes.ts fork 라우트)와 같은 출처를 쓴다: 실행 설정 행(org_session_state) ·
 *  주인(행 · 없으면 tmux) · 입장(canAttach) · 대화 id(훅 보고 → 대화 파일 경로) · 그 대화 파일이 그 자리에 있나(resumeTranscriptCheck).
 *  ⚠ 들어갈 수 없는 사람에게는 주인 · 들어갈 수 없음만 채운다 — 남의 세션의 폴더 · 하네스 · 대화 id 를 판정 재료로도 들고 다니지 않는다.
 */
async function forkSessionFacts(sid: string, member: string, appId: string, opts: { transcript?: boolean } = {}): Promise<import("./service.js").ForkSessionFacts> {
  const none = { exists: false, owner: null, kind: null, harness: null, dir: null, nodeId: null, appAttached: false, participant: false, conversation: null,
    projectId: null, flags: {}, incognito: false };
  const { getSessionState } = await import("../sessions/session-state.js");
  const { sessionCanEnter, sessionOwnerOf, listAttachedApps } = await import("../apps/session-apps.js");
  const st = await getSessionState(sid).catch(() => undefined);
  const owner = String(st?.owner ?? "").trim() || (await sessionOwnerOf(sid).catch(() => null));
  if (!st || !owner) return { ...none, exists: !!owner, owner: owner ?? null };
  const participant = owner === member || (await sessionCanEnter(sid, member).catch(() => false));
  if (!participant) return { ...none, exists: true, owner };
  const { normalizeSessionKind } = await import("../sessions/session-kind.js");
  const { convIdFromTranscriptPath } = await import("../sessions/conv-mapping.js");
  const { nodeOfSession } = await import("../node/registry.js");
  const { getNode } = await import("../node/store.js");
  //  사람 PC 노드인가 — 가르는 자는 노드 종류(org_node.kind): worker(세션호스트 — 소유자 홈을 우리와 같이 본다)는 매니지드 자리, member 는 사람 PC
  //   (resumeTranscriptCheck 머리말과 같은 자). 노드 좌표가 없으면 중앙(컨테이너) 세션이다.
  const rawNode = nodeOfSession(sid) || String(st.node_id ?? "").trim();
  const nodeKind = rawNode ? await getNode(rawNode).then((n) => n?.kind ?? null).catch(() => null) : null;
  const nodeId = rawNode && nodeKind !== "worker" ? rawNode : null;
  const conversation = st.claude_session_id || convIdFromTranscriptPath(st.harness, st.transcript_path) || null;
  const appAttached = (await listAttachedApps(sid).catch(() => [])).some((a) => a.app_id === appId);
  let convOk: string | null = conversation;
  if (conversation && !nodeId && opts.transcript !== false) {
    //  그 대화 파일이 그 자리에 실제로 있나 — «없다» 는 확답일 때만 대화 없음으로 본다(«못 봤다» 는 그대로 시도한다 · 복원과 같은 규율).
    const { resumeTranscriptCheck } = await import("../terminal/routes.js");
    const check = await resumeTranscriptCheck(sid, st, conversation, null).catch(() => "unknown" as const);
    if (check === "absent") convOk = null;
  }
  return {
    exists: true, owner, kind: normalizeSessionKind(st.kind), harness: st.harness || "claude", dir: st.dir || null, nodeId, appAttached, participant,
    conversation: convOk, projectId: st.project_id ? Number(st.project_id) : null, flags: st.flags ?? {}, incognito: !!st.incognito,
  };
}

/** 로그인 판정은 비싸다(원격 실행 2번) — 60초 기억(설계 §12 ④ «짧게 기억»). 모름(null)도 기억한다. */
class LoginCache {
  private m = new Map<string, { at: number; v: boolean | null }>();
  constructor(private ttlMs: number) {}
  async get(key: string, load: () => Promise<boolean | null>): Promise<boolean | null> {
    const hit = this.m.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.v;
    let v: boolean | null = null;
    try { v = await load(); } catch { v = null; }
    this.m.set(key, { at: Date.now(), v });
    return v;
  }
}
const loginCache = new LoginCache(60_000);
