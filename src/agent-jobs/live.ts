// 작업 컨테이너 — 살아 있는 의존(DB · 브로커 · 토큰 · 판정)을 service.ts 에 잇는다 (#4490 앱 v2-11).
//  service.ts 는 이 묶음을 받아서만 움직인다 — 시험은 가짜 묶음으로 같은 흐름을 잰다.
//
//  ⚠ 앱 작업의 «앱 토큰으로만» 은 작업 AI 의 라이블리 **도구 배선**을 그 앱 동의로 좁히는 것이지 운영체제 경계가 아니다. 작업은 실행 계정
//   멤버의 uid·홈으로 돈다(구독 로그인이 거기 있다) — 같은 uid 라 홈의 키트 토큰·git 자격을 읽을 수 있고, 판이 물려준 env 도 같다.
//   그래서 앱 동의의 뜻은 «그 앱 화면에서 내가 보낸 지시를 나로서 실행» 이다(상민 2026-10-16 결정 ③ «본인 세션과 같은 신뢰» · 동의 창의
//   «에이전트 작업» 줄). 받는 길은 service.assertMaySubmit 이 좁힌다(앱 서버 · 앱 토큰 직접 · 작업 AI 자신은 거절).
//  #5082 박스 위 실행면(셀프호스트)도 같은 한계 위에 하나가 더 있다 — 판이 그 구성원 OS 계정으로 박스 위에서 돌아, 그 계정이 읽을 수 있는
//   공유 자리(다른 프로젝트 · 다른 앱 폴더 — lively-shared 그룹)가 다 보인다. 앱 폴더만 보이게 하는 것은 도커 실행면(2단계)의 몫이다.
//  #4891 홈 없는 작업(앱 서버가 보낸 API 키 에이전트 작업)은 다르다: 그 사람의 홈 · OS 계정을 붙이지 않고(launch.ts — 전용 계정 · 빈 홈),
//   작업 AI 의 토큰도 앱 서버 급 주체다(plan.jobAppTokenOpts — 능력 API · /mcp 에서만 · 무조건 통과 도구 없음). 그 AI 를 부린 것은 앱 서버
//   코드라, 사람 이름으로 세션을 열거나(홈이 붙는다) 파일 · 계정 길을 쓰는 것을 토큰 층에서도 막는다(격리 리뷰 — 마운트 층만으로는 모자랐다).
//  #5081 공용 시트 작업은 또 다르다: 자리는 시트 계정의 홈(Claude 로그인이 거기 있다 — 상민 2026-10-28), 작업 AI 의 토큰은 **보낸 사람** ∩ 앱 동의
//   (앱 서버 급 — plan.jobIdentityMember · jobAppTokenOpts). 시트 홈에 키트(라이블리 토큰 · 훅)와 git 자격을 새로 심지 않는다(launch.ts) — 그 홈은
//   구성원 누구의 지시든 닿는 자리다. 시트 계정이 사람 세션을 열어 둔 적이 있으면 그 홈엔 이미 시트의 토큰이 있다 — 그래서 시트는 기본 권한
//   (items · context · memory)만 가진 전용 계정이어야 한다(ai-runs/plan.seatShared).
import crypto from "node:crypto";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import type { LivelyUser } from "../context.js";
import { MCP_TOKEN_SLACK_SEC, assertSharedSeatJob, type AgentJobDeps } from "./service.js";
import { jobAppTokenOpts, jobIdentityMember, jobSeatMember } from "./plan.js";
import type { AgentJobRow } from "./store.js";

/** 이 작업이 공용 시트로 도는 작업인가(#5081) — 구독 작업만 표시를 읽는다(API 키 작업은 그 표시가 생기지 않는다). */
async function sharedSeatJob(job: Pick<AgentJobRow, "id" | "account_kind">): Promise<boolean> {
  if (job.account_kind !== "subscription") return false;
  return (await import("./store.js")).agentJobSharedSeat(job.id);
}

/**
 * #5081 공용 시트 작업을 아직 돌려도 되나 — 판정은 service.assertSharedSeatJob(시트 계정 · 보낸 사람의 사실 → plan.sharedSeatJobRefusal → 보낸 사람의
 *  앱 동의). 여기서는 그 사실의 출처(설정 칸 · 구성원 표 · 앱 판정)만 잇는다.
 */
async function assertSharedSeatJobAllowed(job: Pick<AgentJobRow, "app_id" | "account_member" | "account_kind" | "requester" | "project_id" | "cwd">): Promise<void> {
  const { memberFactsOf } = await import("../ai-runs/live.js");
  const { parseAccountSettings, serviceSeatConsented } = await import("../ai-runs/plan.js");
  const { aiAccountRow } = await import("../ai-runs/store.js");
  const { getMember } = await import("../org/store/members.js");
  return assertSharedSeatJob(job, {
    seatConsented: async (member) => serviceSeatConsented(parseAccountSettings(await aiAccountRow()), member),
    memberFacts: memberFactsOf,
    assertAppUsable: async (member, appId) => {
      const r = await getMember(member);
      await assertAppUsableFor({ userId: member, scopes: Array.isArray(r?.scopes) ? r!.scopes : [] } as LivelyUser, appId);
    },
  });
}

let cached: AgentJobDeps | null = null;
/** 이 프로세스가 판의 말을 듣기 시작한 시각 — 재기동 직후의 무응답 판정 보류 기준(plan.sweepDecision listeningSince). */
const LISTENING_SINCE = Date.now() - Math.round(process.uptime() * 1000);

/** 이 사람이 이 앱을 지금 쓸 수 있나(보임 · 켜짐 · 동의) — 접수 때와 띄우기 직전이 같은 판정을 쓴다. 안 되면 던진다. */
async function assertAppUsableFor(user: LivelyUser, appId: string): Promise<void> {
  const { getApp, getActiveGrant } = await import("../org/store/apps.js");
  const { canSeeApp } = await import("../apps/visibility.js");
  const app = await getApp(appId);
  if (!app || !canSeeApp(app, { userId: user.userId, scopes: user.scopes ?? [] })) throw new HttpError(404, `앱 없음: ${appId}`);
  if (app.status !== "active" || !app.enabled) throw new HttpError(409, `앱 '${appId}' 이 활성 상태가 아닙니다`);
  if (!user.userId || !(await getActiveGrant(appId, user.userId))) throw new HttpError(403, `앱 '${appId}' 사용 동의(grant)가 없습니다`);
}

export async function liveAgentJobDeps(): Promise<AgentJobDeps> {
  if (cached) return cached;
  const store = await import("./store.js");
  //  #5082 — 판을 세우고 걷는 자리(실행면): 매니지드는 브로커(launch.ts), 브로커 없는 박스는 박스 위(launch-host.ts) — surface.ts 가 고른다.
  const { jobSurface } = await import("./surface.js");
  const surface = await jobSurface();
  const pol = await import("../org/policies/agent-job-policy.js");
  const { currentTenant, withTenant } = await import("../org/tenant-context.js");
  const { tenantSlug } = await import("../terminal/catalog.js");
  cached = {
    store,
    policy: () => pol.effectiveAgentJobPolicy(async () => pol.resolveAgentJobPolicy(await store.agentJobPolicyRow())),
    available: () => surface.available(),
    unavailableMessage: () => surface.unavailableMessage(),
    //  #5081 — 공용 시트 작업이면 실행면이 시트 홈에 키트 · git 자격을 심지 않는다(매니지드 launch.ts · 박스 위 launch-host.ts 둘 다).
    launch: async (job, boot) => surface.launch(job, boot, { sharedSeat: await sharedSeatJob(job) }),
    kill: (sid) => surface.kill(sid),
    paneView: (job) => surface.paneView(job),
    //  #5082 — 구독 작업의 기록 자리를 작업마다 덮는 실행면(도커)이면 그 대화를 묶음으로 잇는다(surface.subscriptionTranscripts).
    subscriptionTranscripts: surface.subscriptionTranscripts,
    assertJobAllowed: async (job) => {
      //  실행 계정 멤버가 아직 활성인가(모든 작업) · 앱 작업이면 그 사람의 지금 권한으로 그 앱을 쓸 수 있나(접수 때와 같은 판정).
      //   #5081 공용 시트 작업은 앱을 쓰는 사람이 보낸 사람이다 — 시트 계정의 동의 대신 보낸 사람의 동의를 본다(assertSharedSeatJobAllowed).
      const { getMember } = await import("../org/store/members.js");
      const seat = jobSeatMember(job);
      const m = seat ? await getMember(seat) : null;
      if (!m || m.state !== "active") throw new HttpError(409, `실행 계정(${seat ?? "?"})이 활성 구성원이 아닙니다`);
      if (await sharedSeatJob(job)) return assertSharedSeatJobAllowed(job);
      if (job.app_id) await assertAppUsableFor({ userId: m.id, scopes: Array.isArray(m.scopes) ? m.scopes : [] } as LivelyUser, job.app_id);
    },
    //  #5081 — 자리 주기가 공용 시트의 작업을 보낸 사람당 · 시트 전체로 센다. 지정(두 동의)만 본다 — 시트 계정이 높은 권한을 얻었으면 띄우기 직전에 멈춘다.
    sharedSeats: async () => {
      const { parseAccountSettings, serviceSeatConsented } = await import("../ai-runs/plan.js");
      const { aiAccountRow } = await import("../ai-runs/store.js");
      const s = parseAccountSettings(await aiAccountRow());
      return new Set(Object.keys(s.service_seats ?? {}).filter((m) => serviceSeatConsented(s, m)));
    },
    //  #4488 — API 키 실행의 판 환경(프록시 주소 · 실행 토큰 · 빈 설정 폴더). 구독 실행은 빈 객체. #5082 — 프록시 주소는 판이 보는 게이트웨이 아래.
    jobEnv: async (job, at) => { const ai = await import("../ai-runs/live.js"); return (await import("../ai-runs/service.js")).bootEnvForJob(job, await ai.liveAiRunDeps(), at); },
    //  #5082 앱 판 지시 — 작업 행에 실려 있다(앱 AI 실행이 접수 때 부른 사람의 판에서 읽어 함께 적었다 · 판이 뜰 때 다시 고르지 않는다).
    jobSystem: async (job) => (await import("./store.js")).agentJobAppInstructions(job.id),
    onJobEnded: async (job) => { const ai = await import("../ai-runs/live.js"); await (await import("../ai-runs/service.js")).onJobEnded(job, await ai.liveAiRunDeps()); },
    listeningSince: () => LISTENING_SINCE,
    mintMcpToken: async (job) => {
      const ttlSec = job.timeout_sec + MCP_TOKEN_SLACK_SEC;
      //  #5081 공용 시트 작업은 보낸 사람의 이름으로 굽는다(plan.jobIdentityMember) — 시트 계정 이름이면 물은 사람이 시트의 권한을 빌린다.
      const shared = await sharedSeatJob(job);
      if (shared && !job.app_id) return null;   // 공용 시트는 앱 작업만(접수가 이미 거른다 — 신원 없이 돌릴 작업은 없다)
      const who = jobIdentityMember(job, shared);
      if (job.app_id && who) {
        //  앱 작업 — 앱 토큰(구성원 권한 ∩ 앱 동의 · 도구도 그 앱 동의 목록으로 좁혀진다 — principal.requireAppTool). 배선이지 경계가 아니다(머리말).
        //   동의를 거뒀거나 앱이 꺼졌으면 던진다 → 그 작업은 돌지 않는다(service.onBoot).
        const { mintAppToken } = await import("../apps/principal.js");
        //   #4891 — 홈 없는 작업 · #5081 공용 시트 작업은 앱 서버 급 주체(plan.jobAppTokenOpts) — 사람 이름의 세션 · 파일 · 계정 길을 열지 않는다.
        const t = await mintAppToken(who, job.app_id, "agent-job", jobAppTokenOpts(job, ttlSec, shared));
        return { token: t.token, tokenHash: t.tokenHash };
      }
      if (!who) return null;
      //  사람이 직접 시킨 작업 — 그 사람의 세션 토큰과 같은 급(멤버 권한을 따라간다 · 작업 상한만큼만 산다).
      const { getMember } = await import("../org/store/members.js");
      const m = await getMember(who);
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
    assertAppUsable: (user: LivelyUser, appId: string) => assertAppUsableFor(user, appId),
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
