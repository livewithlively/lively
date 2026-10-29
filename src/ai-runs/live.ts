// 앱 AI 실행 — 살아 있는 의존(DB · 자격 금고 · 작업 컨테이너 · LLM · 정책)을 service.ts 에 잇는다 (#4488 앱 v2-9).
import crypto from "node:crypto";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import type { LivelyUser } from "../context.js";
import { RateWindow } from "../apps/app-chat-send.js";
import { PROXY_TOKEN_PREFIX, type AiRunDeps, type ResumeTarget, type SubmitJobInput } from "./service.js";
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

/** 워크스페이스 키의 Anthropic 워크스페이스 id(자격 meta.workspace_id) — 워크스페이스에 묶이지 않은 키일 때 헤더로 싣는다. 없거나 모양이 틀리면 null. */
export async function workspaceAnthropicWorkspaceId(): Promise<string | null> {
  const { getMemberSecret, GATEWAY_OWNER } = await import("../org/credentials/member-secret-store.js");
  const { ANTHROPIC_WORKSPACE_ID_RE } = await import("./anthropic.js");
  const s = await getMemberSecret(GATEWAY_OWNER, ANTHROPIC_KEY_KIND, "").catch(() => null);
  const v = typeof s?.meta?.workspace_id === "string" ? s.meta.workspace_id.trim() : "";
  return v && ANTHROPIC_WORKSPACE_ID_RE.test(v) ? v : null;
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
    apiWorkspaceId: workspaceAnthropicWorkspaceId,
    getApp: async (id) => (await import("../org/store/apps.js")).getApp(id),
    assertAppUsable: assertAppUsableFor,
    submitJob: async (j: SubmitJobInput, user: LivelyUser) => {
      //  작업 컨테이너 접수 — 입력 검증(앱 폴더 · 프로젝트 폴더)은 agent-jobs/service.submitAgentJob 과 같은 자.
      const svc = await import("../agent-jobs/service.js");
      const jobs = await (await import("../agent-jobs/live.js")).liveAgentJobDeps();
      if (!(await jobs.available())) throw new HttpError(501, `${jobs.unavailableMessage?.() ?? "이 배포에서는 에이전트 작업을 띄울 수 없습니다"} — 이 실행은 단발(프록시)로만 됩니다`);
      const plan = await import("../agent-jobs/plan.js");
      const p = await jobs.policy();
      //  #4891 — 홈 없는 작업은 앱 폴더에서만 돈다(부르는 쪽이 이미 걸렀다 — 여기서도 프로젝트 폴더를 받지 않는다). #5081 공용 시트도 같다(시트 홈은 함께 쓴다).
      if (j.homeless && j.projectId != null) throw new HttpError(400, "홈 없는 작업은 앱 폴더에서만 돕니다");
      if (j.sharedSeat && j.projectId != null) throw new HttpError(400, "공용 시트로 도는 작업은 앱 폴더에서만 돕니다");
      if (j.projectId != null) await jobs.assertProjectCwd(user, j.projectId);
      const cwd = j.projectId != null ? plan.projectFolderCwd(j.projectId) : plan.appFolderCwd(j.appId);
      let resumeConv: string | null = null;
      if (j.resumeJobId != null) {
        //  #5101 이을 대화가 남았나 — 접수 전 판정(resumeTarget)과 같은 함수로 한 번 더 본다. API 키 작업의 대화는 게이트웨이가 보관한 기록뿐이다
        //   (빈 설정 폴더는 끝나면 지워진다) — 없으면 띄워 봐야 «대화 없음» 으로 끝난다. 형식 재시도는 이 409 를 받아 «원문 붙여 실패» 로 끝낸다(syncRun).
        const t = await resumeTargetOf(j.resumeJobId);
        if (!t?.resumable || !t.conversation) throw new HttpError(409, `이어받을 작업의 대화가 없습니다${t?.why ? ` — ${t.why}` : ""}`);
        resumeConv = t.conversation;
      }
      const ai = await import("./service.js");
      const row = await svc.enqueueAgentJob(ai.agentJobOfRun(j, { cwd, resumeConversation: resumeConv, timeoutSec: plan.timeoutSecOf(j.timeoutMin ?? undefined, p) }), p, jobs);
      return { id: row.id };
    },
    getJob: async (id) => (await import("../agent-jobs/store.js")).getAgentJob(id),
    resumeTarget: resumeTargetOf,
    cancelJob: async (id, user) => {
      const svc = await import("../agent-jobs/service.js");
      const jobs = await (await import("../agent-jobs/live.js")).liveAgentJobDeps();
      await svc.cancelAgentJobFor(id, user, jobs).catch((e) => { if (!(e instanceof HttpError && e.status === 404)) throw e; });
    },
    singleShot: async (key, i, signal) => (await import("./anthropic.js")).singleShot(key, i, signal),
    newProxyToken,
    //  #5082 앱 판 지시 — 부른 사람(주소)의 판에서 그 작업 이름의 지시 파일(apps/app-job-instructions) · 형식 재시도는 원래 작업 행에 실린 글.
    instructions: async (app, who, job) => (await import("../apps/app-job-instructions.js")).resolveJobInstructions(app, who, job),
    jobInstructions: async (jobId) => (await import("../agent-jobs/store.js")).agentJobAppInstructions(jobId),
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
    memberFacts: memberFactsOf,
  };
  return cached;
}

/**
 * #5101 이어받을 작업(앞 실행의 작업 행)의 사실 — 작업 폴더 · 모델 · 이을 대화가 남았나. 작업 행이 없으면(보존 정리로 지워짐) null.
 *  API 키 작업은 게이트웨이가 보관한 대화 기록이 그 작업의 대화 id 와 맞아야 잇는다(빈 설정 폴더는 끝나면 지워진다 — agent-jobs/plan.TRANSCRIPT_GZ_MAX).
 *  구독 작업은 대화 파일이 그 사람(시트)의 홈에 남는다 — 대화 id 만 본다.
 */
export async function resumeTargetOf(jobId: number): Promise<ResumeTarget | null> {
  const store = await import("../agent-jobs/store.js");
  const j = await store.getAgentJob(jobId);
  if (!j) return null;
  const base = { projectId: j.project_id, model: j.model, conversation: j.conversation_id };
  if (!j.conversation_id) return { ...base, resumable: false, why: "그 작업에 대화가 남지 않았습니다 — 하네스가 대화를 시작하기 전에 끝났습니다" };
  if (j.account_kind === "api_key" && (await store.agentJobTranscriptConv(j.id)) !== j.conversation_id) {
    return { ...base, resumable: false, why: "API 키 작업의 대화 기록이 없습니다 — 게이트웨이는 끝난 뒤 transcript_keep_days 동안만 두고, 이 기능 전에 끝난 작업 · 기록이 상한을 넘은 작업은 남지 않습니다" };
  }
  return { ...base, resumable: true, why: null };
}

/**
 * #5081 구성원의 사실 — 이 워크스페이스의 활성 사람 구성원인가 · 기본 권한 밖의 권한이 있나(plan.seatElevated). 앱 서버 id(`app-server:…`)처럼
 *  구성원 표에 없는 이름은 «아님». 공용 시트의 시트 계정과 보낸 사람(앱 서버가 실은 사람 신원이면 그 사람)을 같은 자로 본다 — agent-jobs/live 의
 *  배차 직전 · 감시 재판정도 이것을 쓴다.
 */
export async function memberFactsOf(member: string): Promise<{ active: boolean; elevated: boolean }> {
  const { getMember } = await import("../org/store/members.js");
  const { workspaceAccessAllowed } = await import("../org/tenancy/gate.js");
  const { seatElevated } = await import("./plan.js");
  const m = member ? await getMember(member) : null;
  if (!m || m.state !== "active" || m.kind !== "human" || !(await workspaceAccessAllowed(m.id))) return { active: false, elevated: false };
  return { active: true, elevated: seatElevated(Array.isArray(m.scopes) ? m.scopes : []) };
}

/**
 * #5081 구성원이 비활성 · 삭제되면 그 계정의 공용 시트 지정(관리자 승인 · 본인 동의)을 지운다 — 앱 동의(org_app_grant)를 거두는 것과 같은 까닭
 *  (apps/member-deactivation 머리말): 남겨 두면 다시 활성화되거나 같은 id 로 다시 만들어질 때 두 동의가 되살아난다(동의한 적 없는 사람에게도).
 *  지운 줄이 있으면 감사(op app_ai_service_seat · 쓰기와 같은 트랜잭션)에 남기고 true, 없으면 쓰지 않고 false.
 */
export async function dropServiceSeatOf(member: string): Promise<boolean> {
  const store = await import("./store.js");
  const { audit } = await import("../org/store/audit.js");
  return store.updateAiAccountRow(async (cur, c) => {
    const s = parseAccountSettings(cur);
    const before = s.service_seats?.[member];
    if (!before) return { next: null, out: false };
    const seats = { ...s.service_seats };
    delete seats[member];
    if (Object.keys(seats).length) s.service_seats = seats; else delete s.service_seats;
    await audit("org_runtime_config", "1", "app_ai_service_seat", { member, seat: before }, { member, seat: null }, undefined, "member-deactivation", c);
    return { next: s, out: true };
  });
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
