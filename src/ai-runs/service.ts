// 앱 AI 실행 — 흐름 (#4488 앱 v2-9). 입구 하나 `/_lively/ai/runs`(= 능력 app_ai_run).
//
//  접수(submitRun) → 실행 계정(작업별 > 앱별 > 워크스페이스 기본값 · plan.resolveAccount) → 실행 자리(단발+API 키 = 프록시 · 그 밖 = 작업 컨테이너)
//   → 상한(앱당 빈도 · 사람당 동시 · 워크스페이스 동시 · 앱당 하루 토큰) → 실행 행 → 프록시면 뒤에서 LLM 한 번(runProxy) · 작업이면 작업 컨테이너 접수
//   → 결과 형식 판정(스키마 — 어긋나면 «형식에 맞게 다시» 1회) → 끝.
//  작업 컨테이너에 붙은 실행은 그 작업 행의 상태를 따라간다(syncRun — 작업이 끝나면 걷기(agent-jobs reapJob)가 알리고, 정비(sweepAiRuns)와 읽기(getRun)도 맞춘다).
//  이어받기(#5101 · 상민 2026-10-28 «A»): 앱이 끝난 답을 검사하고 어긋나면 resume_run_id + 사유(prompt)로 다시 보낸다 — 그 대화를 잇는 **새 실행**이다.
//   같은 앱 · 같은 요청자만 · 실행 계정 · 자리 · 작업 폴더는 앞 실행 것 · 한 질문당 상한(max_resumes). 단발은 앞 대화를 엮어 보내고(resumeHistory),
//   작업은 앞 작업의 대화를 갈라 잇는다(API 키 작업은 게이트웨이가 보관한 대화 기록을 판이 되돌려 놓는다 — agent-jobs/plan.TRANSCRIPT_GZ_MAX).
//
//  누가 보내나: 앱 화면(app-ui · app-front — runAppTool 의 같은 판정) · 앱 서버(앱 서버 토큰 + 사람 신원 — 능력 REST) · 사람(도구 호출 · app_id 지정).
//   구독 실행은 그 구성원 본인이 앱 화면에서 보낸 것만(plan.subscriptionRefusal). API 키 에이전트 작업은 사람이 보내면 그 사람의 자리(홈)에서,
//   앱 서버가 보내면 «홈 없는 작업 컨테이너»(#4891 — 전용 계정 · 빈 홈 · 앱 폴더만)에서 돈다 — 앱 서버 코드가 사람의 홈(자격 · 토큰)을 쓰는
//   작업을 띄우지 못하게(agent-jobs/launch.ts 머리말).
//  공용 시트(#5081 · 상민 2026-10-28): 관리자가 지정하고 그 계정 본인이 동의한 구독은 워크스페이스 구성원 누구의 요청이든 받는다 — 앱 서버가 사람
//   신원을 실어 보낸 요청도. 그 실행은 시트 계정의 홈(Claude 로그인)에서 돌고(홈 없는 자리가 아니다), 작업 AI 의 라이블리 신원은 **물은 사람**이다
//   (제안자 = 물은 사람 · 그 사람이 못 보는 것은 작업도 못 본다 — agent-jobs/live.mintMcpToken). 시트 홈은 구성원 모두가 함께 쓰므로 앱 폴더에서만 돈다.
//  관리자는 남의 실행의 상태·오류만 본다(지시·답은 보낸 사람 것 — 작업 컨테이너와 같은 규칙).
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import type { LivelyUser } from "../context.js";
import type { OrgApp } from "../org/store/apps.js";
import type { AiRunPolicy } from "../org/policies/ai-run-policy.js";
import type { AgentJobRow, NewAgentJob } from "../agent-jobs/store.js";
import { RUNNER_GATEWAY_URL } from "../agent-jobs/runner.js";
import { RateWindow } from "../apps/app-chat-send.js";
import {
  DEFAULT_MODEL, JOB_NAME_RE, LABEL_MAX, MODEL_RE, PROMPT_MAX, RESUME_REASON_MAX, SYSTEM_MAX, executorFor, isEndedRun, judgeOutput, overDailyBudget,
  resolveAccount, resumeHistory, resumeInputError, resumeLabel, resumeRefusal, retryInstruction, runKindOf, runStatusOfJob, schemaInputError, schemaInstruction,
  seatShared, serviceSeatConsented, subscriptionRefusal, waitSecOf,
  type AiAccount, type AiAccountSettings, type ChatTurn, type ResumeLink, type RunKind, type SeatTerms, type SessionTie,
} from "./plan.js";
import type { SingleShotInput, SingleShotOutput, Usage } from "./anthropic.js";
import type { AiRunRow, AiRunSummaryRow, NewAiRun } from "./store.js";

type Store = typeof import("./store.js");

export interface SubmitJobInput {
  requester: string; accountKind: "api_key" | "subscription"; accountMember: string | null; appId: string; projectId: number | null;
  model: string | null; label: string | null; prompt: string; timeoutMin: number | null; bare: boolean; resumeJobId: number | null;
  /**
   * #4891 사람 홈 없는 작업 컨테이너에서 돌린다(앱 서버가 보낸 에이전트 작업) — 앱 폴더에서만(projectId 는 null).
   *  필수다 — 접수하는 자리(첫 접수 · 형식 재시도)가 하나라도 빠뜨리면 앱 서버의 에이전트 작업이 사람 홈에서 돈다(격리 리뷰).
   */
  homeless: boolean;
  /**
   * #5081 공용 시트로 도는 실행 — 시트 계정의 홈(로그인)에서 돌되 작업 AI 의 라이블리 신원은 보낸 사람(requester)이다. 앱 폴더에서만(projectId 는 null).
   *  필수다 — 접수하는 자리(첫 접수 · 형식 재시도)가 하나라도 빠뜨리면 물은 사람의 작업이 시트 계정의 이름 · 권한으로 돈다.
   */
  sharedSeat: boolean;
}

/**
 * (순수) AI 실행의 작업 접수 → 작업 컨테이너 행(#4891) — 홈 없는 표시 · 공용 시트 표시(#5081)를 그대로 옮긴다(빠지면 앱 서버의 에이전트 작업이
 *  사람 홈에서 돌거나, 물은 사람의 작업이 시트 계정의 이름으로 돈다). 작업 폴더 · 이어받을 대화 · 시간 상한은 부르는 쪽(live.submitJob)이 정한다.
 */
export function agentJobOfRun(j: SubmitJobInput, o: { cwd: string; resumeConversation: string | null; timeoutSec: number }): NewAgentJob {
  return {
    requester: j.requester, accountKind: j.accountKind, accountMember: j.accountMember, appId: j.appId, projectId: j.projectId, cwd: o.cwd,
    harness: "claude", model: j.model, label: j.label, prompt: j.prompt, resumeConversation: o.resumeConversation, resumeJobId: j.resumeJobId,
    timeoutSec: o.timeoutSec, bare: j.bare, homeless: j.homeless, sharedSeat: j.sharedSeat,
  };
}

/** 이어받을 작업의 사실(#5101) — 작업 폴더 · 모델 · 이을 대화가 남았나(대화 id 와, API 키 작업이면 게이트웨이가 보관한 기록) · 없으면 그 까닭. */
export interface ResumeTarget { projectId: number | null; model: string | null; resumable: boolean; why: string | null }

export interface AiRunDeps {
  store: Pick<Store, "insertAiRun" | "getAiRun" | "getAiRunByToken" | "getAiRunByJob" | "setAiRunJob" | "setAiRunProxyToken" | "markAiRunRunning" | "retryAiRun"
    | "finishAiRun" | "openJobRuns" | "staleProxyRuns" | "openRunCountOf" | "listAiRuns" | "appConversations" | "insertLlmCall" | "tokensUsedTodayByApp" | "aiRunSharedSeat"
    | "aiRunResumeLink" | "resumeCountOfRoot">;
  /** #5101 이어받을 작업(앞 실행의 작업 행)의 사실 — 작업 행이 없으면(보존 정리로 지워짐) null. */
  resumeTarget(jobId: number): Promise<ResumeTarget | null>;
  policy(): Promise<AiRunPolicy>;
  accountSettings(): Promise<AiAccountSettings>;
  /** 워크스페이스 Anthropic API 키(org_credential anthropic_api_key) — 없으면 null. 값은 LLM 호출 헤더에만 쓴다. */
  apiKey(): Promise<string | null>;
  /** 그 키의 Anthropic 워크스페이스 id(자격 meta.workspace_id) — 워크스페이스에 묶이지 않은 키는 이게 있어야 돈다. 없으면 null. */
  apiWorkspaceId?(): Promise<string | null>;
  getApp(appId: string): Promise<OrgApp | null>;
  /** 이 사람이 이 앱을 지금 쓸 수 있나(보임 · 켜짐 · 동의) — 안 되면 던진다. */
  assertAppUsable(user: LivelyUser, appId: string): Promise<void>;
  /** 작업 컨테이너 접수(agent-jobs/service.enqueueAgentJob) — 대기열이 차면 429 를 던진다. */
  submitJob(j: SubmitJobInput, user: LivelyUser): Promise<{ id: number }>;
  getJob(id: number): Promise<AgentJobRow | null>;
  cancelJob(id: number, user: LivelyUser): Promise<void>;
  /** 단발 한 번(anthropic.singleShot) — 시험이 바꿔 끼운다. */
  singleShot(apiKey: string, i: SingleShotInput, signal: AbortSignal): Promise<SingleShotOutput>;
  /** 프록시 토큰 — 값은 돌려주고 해시만 적는다. */
  newProxyToken(): { token: string; hash: string };
  /** 지금 열린 프록시 호출 수를 세는 자리(워크스페이스 동시 상한). */
  inflight: { take(key: string, max: number): boolean; release(key: string): void; count(key: string): number };
  rate: RateWindow;
  tenant(): string;
  later(fn: () => Promise<unknown>, ms: number): void;
  now(): number;
  /** 이 앱이 붙은 세션 중 이 사람이 들어갈 수 있는 것(targets 의 attached). */
  attachedSessions(appId: string, member: string): Promise<Array<{ session_id: string; title: string; owner_is_you: boolean }>>;
  /** 구독 실행 계정의 로그인 판정(aiLoginCheck · 짧게 기억) — 모르면 null. */
  subscriptionLoggedIn(member: string): Promise<boolean | null>;
  /** 요청이 매인 세션(ctx.session — MCP 헤더 · 앱 화면 다리가 서버 쪽에서 붙임)의 주인과, 이 사람이 그 세션에 들어갈 수 있나(apps/session-apps). 세션이 없으면 owner null. */
  sessionTie(sessionId: string, member: string): Promise<SessionTie>;
  isAdmin(user: LivelyUser): boolean;
  /** 이 토큰이 작업 컨테이너의 작업 토큰인가(agent-jobs store.isAgentJobToken) — 작업이 작업을 낳지 않게(#4490 규칙과 같다). */
  isJobToken(tokenHashPrefix: string): Promise<boolean>;
  /**
   * #5081 구성원의 사실 — 이 워크스페이스의 활성 사람 구성원인가(구성원 표 state · kind + 워크스페이스 소속) · 기본 권한 밖의 권한이 있나(plan.seatElevated).
   *  없는 사람(앱 서버 id 포함)은 { active: false, elevated: false }. 공용 시트 판정(시트 계정 · 보낸 사람)이 쓴다.
   */
  memberFacts(member: string): Promise<{ active: boolean; elevated: boolean }>;
}

export const ACCOUNT_UNAVAILABLE = "account_unavailable";
export const PROXY_TOKEN_PREFIX = "lvai_";
/** 판이 보는 게이트웨이 아래 우리 프록시 주소 — Claude Code 의 ANTHROPIC_BASE_URL(routes.LLM_PROXY_PREFIX 와 같은 자리). */
export const proxyBaseAt = (gateway: string): string => `${gateway}/api/llm/anthropic`;
/** 작업 컨테이너 안에서 우리 프록시로 가는 주소(세션 루프백 → 게이트웨이 · runner.RUNNER_GATEWAY 와 한 자리). */
export const PROXY_BASE_IN_CONTAINER = proxyBaseAt(RUNNER_GATEWAY_URL);
/** 판이 빈 설정 폴더를 만들어 바꿔 넣는 자리표(agent-jobs/runner.ts) — 멤버 홈의 Claude 로그인을 읽지 않게. */
export const CONFIG_DIR_PLACEHOLDER = "{{LVLY_CONFIG_DIR}}";
const memberOf = (u: LivelyUser | undefined): string => String(u?.userId || "");

export interface SubmitInput {
  app_id?: unknown; prompt?: unknown; system?: unknown; schema?: unknown; job?: unknown; model?: unknown; label?: unknown;
  files?: unknown; project_id?: unknown; cwd?: unknown; agent?: unknown; timeout_min?: unknown; max_tokens?: unknown; wait?: unknown;
  /** #5101 이 끝난 실행의 대화를 이어받는다(prompt = 고칠 점 · 사유) · reason = 실행 기록에 남길 까닭 이름표(선택). */
  resume_run_id?: unknown; reason?: unknown;
}

// ── 공개 모양 ──
function head(r: AiRunRow | AiRunSummaryRow): Record<string, unknown> {
  return {
    id: r.id, status: r.status, app_id: r.app_id, requester: r.requester, requester_kind: r.requester_kind, job: r.job_name, kind: r.kind,
    account: r.account_kind === "subscription" ? { kind: "subscription", member: r.account_member } : { kind: "api_key" },
    executor: r.executor, job_id: r.job_id, model: r.model, label: r.label, error: r.error, retries: r.retries,
    usage: r.input_tokens != null || r.output_tokens != null ? { input_tokens: r.input_tokens, output_tokens: r.output_tokens } : null,
    created_at: r.created_at, started_at: r.started_at, ended_at: r.ended_at,
  };
}
/**
 * 앱이 보는 실행 — 답·지시는 보낸 사람(own)에게만.
 *  resume(#5101) — 이 실행이 이어받은 줄(어느 실행 · 처음 실행 · 몇 번째 · 까닭). 준 자리(접수 · 하나 보기)에만 싣는다 — 까닭은 지시처럼 보낸 사람에게만.
 */
export function publicRun(r: AiRunRow, o: { own: boolean; withPrompt?: boolean; resume?: ResumeLink | null }): Record<string, unknown> {
  return {
    ...head(r),
    ...(o.own ? { result: r.result, session_note: r.session_note } : { has_result: r.result !== null }),
    ...(o.own && o.withPrompt ? { prompt: r.prompt, system: r.system_prompt, schema: r.schema } : {}),
    ...(o.resume !== undefined ? { resume: o.resume ? { of: o.resume.of, root: o.resume.root, depth: o.resume.depth, ...(o.own ? { reason: o.resume.reason } : {}) } : null } : {}),
  };
}
export function publicRunSummary(r: AiRunSummaryRow, o: { own: boolean }): Record<string, unknown> {
  return { ...head(r), prompt_preview: o.own ? r.prompt_preview : null, has_result: r.has_result };
}

// ── 접수 ──
function requesterOf(user: LivelyUser): { member: string; kind: "member" | "app_server" } {
  const member = memberOf(user);
  if (!member) throw new HttpError(401, "인증이 필요합니다");
  return { member, kind: user.appServer ? "app_server" : "member" };
}

/** 매니페스트 ai.jobs — 선언 목록(없으면 빈 배열). 저장된 매니페스트를 읽는 자리라 던지지 않는다. */
export function declaredAiJobs(app: OrgApp | null): Array<{ name: string; title: string | null; description: string | null }> {
  const raw = (app?.manifest as { ai?: { jobs?: unknown } } | null)?.ai?.jobs;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; title: string | null; description: string | null }> = [];
  for (const j of raw) {
    const o = (j && typeof j === "object" ? j : {}) as Record<string, unknown>;
    if (typeof o.name === "string" && JOB_NAME_RE.test(o.name)) out.push({ name: o.name, title: typeof o.title === "string" ? o.title : null, description: typeof o.description === "string" ? o.description : null });
  }
  return out;
}

/** 앱이 AI 실행을 선언했나(permissions.ai_runs → app_ai_run 도구). */
export function appDeclaresAiRuns(app: OrgApp | null): boolean {
  const p = (app?.manifest as { permissions?: { ai_runs?: unknown; tools?: unknown } } | null)?.permissions;
  return p?.ai_runs === true || (Array.isArray(p?.tools) && p.tools.map(String).includes("app_ai_run"));
}

/**
 * 요청이 매인 세션의 tie(plan.SessionTie) — 구독 실행일 때만 묻는다(API 키는 누구든 · 사람이 아닌 요청자는 plan 이 먼저 거절).
 *  세션이 없으면 null(본인은 통과 · 남은 거절). 조회 실패는 «모르는 세션» 으로 — 막는 쪽.
 */
async function sessionTieOf(ctx: { session?: string }, who: { member: string; kind: string }, account: AiAccount | null, d: AiRunDeps): Promise<SessionTie | null> {
  if (!account || account.kind !== "subscription" || who.kind !== "member") return null;
  const sid = typeof ctx.session === "string" ? ctx.session.trim() : "";
  if (!sid) return null;
  return d.sessionTie(sid, who.member).catch(() => ({ owner: null, participant: false, human: false }));
}

/**
 * 공용 시트 판정의 입력(plan.SeatTerms) — 구독 실행일 때만, 그 계정이 두 동의를 다 받았을 때만 구성원 표를 읽는다(지정이 없으면 null → 종전 판정).
 *  보낸 사람의 사실은 보낸 사람이 시트 계정 자신이면 다시 읽지 않는다. 구성원 표를 못 읽으면 던진다(공용으로 열지 않는다 — 부르는 쪽이 500).
 */
export async function seatTermsOf(settings: AiAccountSettings, account: AiAccount | null, who: { member: string }, d: Pick<AiRunDeps, "memberFacts">): Promise<SeatTerms | null> {
  if (!account || account.kind !== "subscription" || !serviceSeatConsented(settings, account.member)) return null;
  const seat = await d.memberFacts(account.member);
  const requester = who.member === account.member ? seat : await d.memberFacts(who.member);
  return { facts: { consented: true, active: seat.active, elevated: seat.elevated }, requesterActive: requester.active };
}

/** #5101 이어받기 접수의 재료 — 앞 실행 · 그 작업 행의 사실(작업 실행일 때) · 새 실행에 남길 줄. */
interface ResumeCtx { parent: AiRunRow; target: ResumeTarget | null; link: ResumeLink }

/**
 * #5101 resume_run_id 를 읽고 판정한다(plan.resumeRefusal · resumeInputError) — 없으면 null(새 질문). 안 되면 던진다(400 · 404 · 409 + body.code).
 *  남이 보낸 실행 · 다른 앱의 실행이면 대화 · 작업 행을 읽지 않고 404 다(있는지도 드러내지 않는다).
 */
async function resumeOf(input: SubmitInput, who: { member: string }, appId: string, maxResumes: number, d: AiRunDeps): Promise<ResumeCtx | null> {
  if (input.resume_run_id === undefined || input.resume_run_id === null || input.resume_run_id === "") return null;
  const id = Number(input.resume_run_id);
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, "resume_run_id 형식이 아닙니다");
  const parent = await d.store.getAiRun(id);
  const mine = !!parent && parent.requester === who.member && parent.app_id === appId;
  const parentLink = mine ? await d.store.aiRunResumeLink(parent.id) : null;
  const root = parentLink?.root ?? id;
  //  이을 대화 — 단발(프록시)은 앞 답 글이 대화다(처음 실행부터 다시 엮는다 · resumeHistory) · 작업은 작업 행의 대화(API 키면 게이트웨이가 보관한 기록까지).
  let conversation = false, why: string | null = null, target: ResumeTarget | null = null;
  if (mine && isEndedRun(parent.status) && parent.status !== "canceled") {
    if (parent.executor === "proxy") conversation = typeof parent.result?.text === "string" && parent.result.text.trim() !== "";
    else if (parent.job_id != null) {
      target = await d.resumeTarget(parent.job_id);
      conversation = !!target?.resumable;
      why = target ? target.why : "그 실행의 작업 기록이 보존 기간(agent_job_limits 의 keep_days)이 지나 지워졌습니다";
    }
  }
  //  한 질문당 상한은 세고 → 넣는 두 단계라 같은 질문을 동시에 여럿 이으면 조금 넘길 수 있다 — 소프트 상한이다(앱당 분당 · 사람당 동시 상한이 폭을 막는다).
  const refusal = resumeRefusal(parent, {
    requester: who.member, appId, conversation, noConversationWhy: why, maxResumes,
    resumesOfRoot: mine && conversation && maxResumes > 0 ? await d.store.resumeCountOfRoot(root) : 0,
  });
  if (refusal) throw new HttpError(refusal.status, refusal.message, { body: { code: refusal.code } });
  const bad = resumeInputError(input, parent!, target?.projectId ?? null);
  if (bad) throw new HttpError(400, bad);
  const reason = typeof input.reason === "string" ? input.reason.replace(/\u0000/g, "").trim().slice(0, RESUME_REASON_MAX) : "";
  return { parent: parent!, target, link: { of: id, root, depth: (parentLink?.depth ?? 0) + 1, reason: reason || null } };
}

/** 이어받기 줄을 거슬러 오르는 상한 — 정책 max_resumes 의 범위 끝(20)을 넉넉히 넘는다(고리가 있을 수 없지만 끝을 둔다). */
const RESUME_CHAIN_MAX = 32;
/**
 * #5101 단발 실행의 대화 — 처음 실행부터 이 실행까지(이어받기 줄을 거슬러 오른다). 줄이 끊겼으면(앞 실행이 없다) 빈 배열 — 부르는 쪽이 «대화 없음» 이다.
 */
async function resumeChainOf(parent: AiRunRow, d: Pick<AiRunDeps, "store">): Promise<AiRunRow[]> {
  const chain = [parent];
  let cur = parent;
  for (let i = 0; i < RESUME_CHAIN_MAX; i++) {
    const l = await d.store.aiRunResumeLink(cur.id);
    if (!l) return chain;
    const prev = l.of < cur.id ? await d.store.getAiRun(l.of) : null;   // 앞 실행은 늘 더 이르다
    if (!prev) return [];
    chain.unshift(prev);
    cur = prev;
  }
  return [];
}

/**
 * 실행을 받는다 — 순서: 신원 → 앱(동의) → 입력(400) → 이어받기(#5101 — 404 · 409 resume_* · 400 어긋난 입력) → 작업 이름(400)
 *  → 실행 계정(409 account_unavailable · 403 구독 거절) → 자리(앱 서버 에이전트 작업 + project_id 400 — 작업 컨테이너가 없는 배포면 띄울 때 501)
 *  → 상한(429) → (이어받는 단발) 앞 대화(409) → 행(롤 창 503) → 띄움.
 *  `wait` 초를 주면 끝날 때까지(상한 WAIT_MAX_SEC) 기다렸다 답한다 — 단발은 보통 몇 초라 앱이 한 번에 받는다.
 */
export async function submitRun(input: SubmitInput, user: LivelyUser, ctx: { source?: string; session?: string }, d: AiRunDeps): Promise<Record<string, unknown>> {
  const who = requesterOf(user);
  //  작업 AI 자신의 토큰은 거절 — 작업이 작업을 낳으면 사람 없이 끝없이 돈다(agent-jobs/service.assertMaySubmit 과 같은 규칙 · 격리 리뷰).
  if (user.tokenHashPrefix && (await d.isJobToken(user.tokenHashPrefix))) throw new HttpError(403, "작업 안에서는 새 AI 실행을 보낼 수 없습니다");
  const appId = typeof user.appId === "string" && user.appId ? user.appId : (typeof input.app_id === "string" ? input.app_id.trim() : "");
  if (!appId) throw new HttpError(400, "app_id 가 필요합니다 — 앱 화면 · 앱 서버에서 부르면 생략합니다");
  if (!user.appId) await d.assertAppUsable(user, appId);
  const app = await d.getApp(appId);
  if (!app) throw new HttpError(404, `앱 없음: ${appId}`);

  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw new HttpError(400, "prompt 가 비었습니다");
  if (prompt.length > PROMPT_MAX) throw new HttpError(400, `prompt 가 너무 깁니다(${PROMPT_MAX.toLocaleString()}자 이하)`);
  if (prompt.includes("\u0000")) throw new HttpError(400, "prompt 에 쓸 수 없는 문자(NUL)가 있습니다");
  const system = typeof input.system === "string" && input.system.trim() ? input.system.trim() : null;
  if (system && system.length > SYSTEM_MAX) throw new HttpError(400, `system 이 너무 깁니다(${SYSTEM_MAX.toLocaleString()}자 이하)`);
  const se = schemaInputError(input.schema);
  if (se) throw new HttpError(400, se);
  const schema = (input.schema ?? null) as Record<string, unknown> | null;
  const rawLabel = typeof input.label === "string" ? input.label.replace(/\u0000/g, "").trim() : "";
  const label = rawLabel ? rawLabel.slice(0, LABEL_MAX) : null;
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : null;
  if (model && !MODEL_RE.test(model)) throw new HttpError(400, "model 이름 형식이 아닙니다");
  //  #5101 이어받기 — 앞 실행이 대화 자리를 정한다(작업 이름 · 작업 종류 · 작업 폴더 · 실행 계정 · system · 안 주면 schema). 한 질문당 상한(정책)이 필요해 정책을 먼저 읽는다.
  const p = await d.policy();
  const resume = await resumeOf(input, who, appId, p.max_resumes, d);
  let jobName: string | null = resume ? resume.parent.job_name : null;
  if (!resume && input.job !== undefined && input.job !== null && input.job !== "") {
    jobName = String(input.job).trim();
    if (!JOB_NAME_RE.test(jobName)) throw new HttpError(400, "job(작업 이름) 형식이 아닙니다 — 소문자·숫자·_·- 1~64자");
    const declared = declaredAiJobs(app);
    if (declared.length && !declared.some((j) => j.name === jobName)) {
      throw new HttpError(400, `작업 '${jobName}' 은 이 앱 매니페스트(ai.jobs)에 없습니다 — 선언한 것: ${declared.map((j) => j.name).join(", ")}`);
    }
  }
  const kind: RunKind = resume ? resume.parent.kind : runKindOf(input);
  let projectId: number | null = resume ? resume.target?.projectId ?? null : null;
  if (!resume && input.project_id !== undefined && input.project_id !== null && input.project_id !== "") {
    const n = Number(input.project_id);
    if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, "project_id 형식이 아닙니다");
    projectId = n;
  }
  if (typeof input.cwd === "string" && input.cwd.trim()) throw new HttpError(400, "cwd 는 아직 받지 않습니다 — 앱 폴더(기본) 또는 project_id 를 쓰세요");

  // 실행 계정 — 작업별 > 앱별 > 워크스페이스 기본값 > (있으면) API 키. 이어받기는 앞 실행의 계정 그대로(대화가 그 자리에 있다) — 아래 판정은 지금 다시 탄다.
  const [settings, key] = await Promise.all([d.accountSettings(), d.apiKey()]);
  let account: AiAccount;
  if (resume) {
    account = resume.parent.account_kind === "subscription" ? { kind: "subscription", member: resume.parent.account_member ?? "" } : { kind: "api_key" };
  } else {
    const picked = resolveAccount(settings, appId, jobName, !!key);
    if (!picked) {
      throw new HttpError(409, "실행 계정이 없습니다 — 관리자가 워크스페이스 API 키(org_credential_set kind=anthropic_api_key)를 등록하거나, 구성원이 자기 구독을 기본 실행 계정으로 걸어야 합니다(app_ai_account_set)",
        { body: { code: ACCOUNT_UNAVAILABLE } });
    }
    account = picked.account;
  }
  //  #5081 공용 시트 — 지정(두 동의)이 있으면 시트 계정과 보낸 사람의 사실을 모은다. 켜져 있으면(plan.seatShared) 본인 · 초대 조건 대신 «활성 구성원» 을 본다.
  const seat = await seatTermsOf(settings, account, who, d);
  const refusal = subscriptionRefusal(account, who, await sessionTieOf(ctx, who, account, d), seat);
  if (refusal) throw new HttpError(403, refusal, { body: { code: ACCOUNT_UNAVAILABLE } });
  if (account.kind === "api_key" && !key) throw new HttpError(409, "이 앱의 실행 계정은 워크스페이스 API 키인데 등록된 키가 없습니다", { body: { code: ACCOUNT_UNAVAILABLE } });
  const executor = executorFor(kind, account);
  if (resume && executor !== resume.parent.executor) {
    throw new HttpError(409, "이어받을 실행의 자리가 맞지 않습니다 — 새 실행으로 보내세요", { body: { code: "resume_not_resumable" } });
  }
  const sharedSeat = account.kind === "subscription" && !!seat && seatShared(seat.facts);
  //  #4891 — 앱 서버가 보낸 에이전트 작업(파일 · 도구)은 사람 홈 없는 작업 컨테이너에서 돈다(사람의 자격 · 토큰이 든 홈을 앱 서버 코드에 주지 않는다).
  //   작업 폴더는 그 앱 폴더뿐 — 프로젝트 폴더는 사람 경계(공개범위)다. 구독은 위에서 이미 거절됐다(앱 서버는 사람이 아니다) — 한 겹 더 본다.
  //   #5081 예외 — 공용 시트는 앱 서버의 사람 대리 요청도 시트 계정의 홈(Claude 로그인)에서 돈다(홈 없는 자리엔 구독 로그인이 없다 · 상민 2026-10-28).
  const homeless = executor === "job" && who.kind === "app_server" && !sharedSeat;
  if (homeless && account.kind !== "api_key") throw new HttpError(403, "앱 서버가 보낸 에이전트 작업은 워크스페이스 API 키로만 돕니다", { body: { code: ACCOUNT_UNAVAILABLE } });
  //  이어받기는 앞 실행의 작업 폴더를 그대로 쓴다 — 사람이 프로젝트 폴더에서 돌린 대화를 앱 서버가 · 공용 시트로 잇지 못한다(그 자리는 앱 폴더뿐이다).
  const projectGap = resume ? "이 실행은 프로젝트 폴더에서 돌았습니다 — 이 자리(앱 서버 · 공용 시트)에서는 그 대화를 이어받을 수 없습니다(앱 폴더 실행만)" : null;
  if (homeless && projectId != null) throw new HttpError(400, projectGap ?? "앱 서버가 보낸 에이전트 작업은 앱 폴더에서만 돕니다 — project_id 를 빼세요");
  //  #5081 — 공용 시트의 홈은 구성원 모두가 함께 쓴다(대화 기록 · 홈의 파일이 다음 작업에 남는다). 프로젝트 폴더(사람 경계)를 그 자리에 붙이지 않는다.
  if (sharedSeat && projectId != null) throw new HttpError(400, projectGap ?? "공용 시트로 도는 실행은 앱 폴더에서만 돕니다 — project_id 를 빼세요(시트 계정의 홈은 구성원 모두가 함께 씁니다)");

  // 상한 — 앱당 빈도 · 사람당 동시 · (프록시) 워크스페이스 동시 · (API 키) 앱당 하루 토큰.
  const tenant = d.tenant();
  if (!d.rate.take(`${tenant}\0${appId}`, d.now())) throw new HttpError(429, `이 앱이 AI 실행을 너무 자주 보내고 있습니다(분당 ${p.app_per_minute}회) — 요청을 모아 한 번에 보내세요`);
  //  세고 → 넣는 두 단계라 같은 사람이 동시에 여럿 보내면 상한을 조금 넘길 수 있다 — 소프트 상한이다(앱당 분당 상한이 먼저 걸려 폭이 작다 · 격리 리뷰 note).
  if ((await d.store.openRunCountOf(who.member)) >= p.max_running_per_member) {
    throw new HttpError(429, `${who.member}님의 AI 실행이 이미 ${p.max_running_per_member}개 돌고 있습니다 — 끝난 뒤 다시 보내세요`);
  }
  if (account.kind === "api_key" && overDailyBudget(await d.store.tokensUsedTodayByApp(appId), p.daily_tokens_per_app)) {
    throw new HttpError(429, `이 앱의 오늘 토큰 상한(${p.daily_tokens_per_app.toLocaleString()})을 다 썼습니다 — 내일 다시, 또는 관리자가 상한을 올립니다(app_ai_limits_set)`);
  }
  if (executor === "proxy" && d.inflight.count(tenant) >= p.max_inflight) {
    throw new HttpError(429, `이 워크스페이스의 AI 호출이 동시에 ${p.max_inflight}개 돌고 있습니다 — 잠시 뒤 다시 보내세요`);
  }

  //  #5101 단발 이어받기 — 앞 대화(처음 실행부터)를 엮는다. 줄이 끊겼으면 이을 대화가 없다(행을 넣기 전에 거절).
  let history: ChatTurn[] | null = null;
  if (resume && executor === "proxy") {
    history = resumeHistory(await resumeChainOf(resume.parent, d));
    if (!history) throw new HttpError(409, "이어받을 대화가 남아 있지 않습니다(앞 실행의 답이 없습니다) — 새 실행으로 보내세요", { body: { code: "resume_not_resumable" } });
  }

  //  이어받기 — schema 는 안 주면 앞 실행 것(같은 모양의 답을 다시 받는다) · model 은 주면 바꾼다(더 센 모델로 다시 시키기) · 안 주면 앞 실행 것.
  const runSchema = resume && (input.schema === undefined || input.schema === null) ? resume.parent.schema : schema;
  const runModel = model ?? (resume ? (executor === "proxy" ? resume.parent.model : resume.target?.model ?? null) : null);
  const n: NewAiRun = {
    appId, requester: who.member, requesterKind: who.kind, source: ctx.source ?? null, jobName, kind,
    accountKind: account.kind, accountMember: account.kind === "subscription" ? account.member : null, executor,
    model: runModel ?? (executor === "proxy" ? settings.default_model ?? DEFAULT_MODEL : null),
    label: label ?? (resume ? resumeLabel(resume.parent.label, resume.link.root, resume.link.depth) : null),
    prompt, systemPrompt: resume ? resume.parent.system_prompt : system, schema: runSchema,
    status: executor === "proxy" ? "running" : "queued", sharedSeat, resume: resume?.link ?? null,
  };
  const row = await d.store.insertAiRun(n).catch((e) => {
    //  #5081 롤 창 — 새 게이트웨이가 공용 DB 마이그레이션보다 먼저 받는 몇 분 동안 공용 시트 실행은 «없는 칸»(42703)으로 실패한다
    //   (store.RUN_SHARED_SEAT_COL 머리말). 막힌 게 아니라 아직 준비 중이니 다시 보내라고 말한다. #5101 이어받기(store.RUN_RESUME_COLS)도 같다.
    if ((sharedSeat || resume) && (e as { code?: string })?.code === "42703") {
      throw new HttpError(503, `${resume ? "이어받기를" : "공용 시트 실행을"} 받을 준비가 아직 안 됐습니다(배포 중) — 잠시 뒤 다시 보내세요`);
    }
    throw e;
  });
  logger.info({ run: row.id, app: appId, requester: who.member, kind, account: account.kind, executor, ...(resume ? { resumeOf: resume.link.of, depth: resume.link.depth } : {}) }, "[ai-run] 접수");

  if (executor === "proxy") {
    d.later(() => runProxy(row, p, d, history), 0);
  } else {
    try {
      const job = await d.submitJob({
        requester: who.member, accountKind: account.kind, accountMember: n.accountMember, appId, projectId, model: n.model, label: n.label ?? `AI 실행 #${row.id}`,
        prompt: jobPrompt(row, input.files, { resumed: !!resume }), timeoutMin: typeof input.timeout_min === "number" ? input.timeout_min : null, bare: kind === "single",
        //  #5101 — 앞 실행의 마지막 작업(형식 재시도가 있었으면 그 작업)의 대화를 갈라 잇는다(runner.claudeJobArgv --fork-session).
        resumeJobId: resume ? resume.parent.job_id : null,
        homeless, sharedSeat,
      }, user);
      await d.store.setAiRunJob(row.id, job.id);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await d.store.finishAiRun(row.id, { status: "failed", result: null, error: `작업 컨테이너에 보내지 못했습니다: ${why}`.slice(0, 600) }).catch(() => null);
      throw e;
    }
  }
  const waitSec = waitSecOf(input.wait);
  const latest = waitSec > 0 ? await waitForRun(row.id, waitSec, d) : await d.store.getAiRun(row.id);
  return publicRun(latest ?? row, { own: true, resume: resume?.link ?? null });
}

/** 끝날 때까지 기다린다(상한 안) — 끝나지 않으면 지금 상태 그대로. */
async function waitForRun(id: number, sec: number, d: AiRunDeps): Promise<AiRunRow | null> {
  const deadline = d.now() + sec * 1000;
  let row = await d.store.getAiRun(id);
  while (row && !isEndedRun(row.status) && d.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    row = await d.store.getAiRun(id);
    if (row && row.executor === "job") row = (await syncRun(row, d)) ?? row;
  }
  return row;
}

/**
 * 작업 컨테이너에 보내는 프롬프트 — 시스템 지시 · 관련 파일 · 형식 지시를 한 글로(하네스는 stdin 프롬프트 하나).
 *  resumed(#5101 이어받기) — 시스템 지시는 다시 싣지 않는다(앞 대화의 첫 말에 이미 있다 · 실행 행에는 기록으로 남긴다).
 */
export function jobPrompt(row: Pick<AiRunRow, "prompt" | "system_prompt" | "schema">, files: unknown, o: { resumed?: boolean } = {}): string {
  const parts: string[] = [];
  if (row.system_prompt && !o.resumed) parts.push(`[시스템 지시]\n${row.system_prompt}\n`);
  parts.push(row.prompt);
  if (Array.isArray(files) && files.length) {
    const list = files.filter((f) => typeof f === "string" && f.trim()).slice(0, 50).map((f) => `- ${String(f).trim()}`);
    if (list.length) parts.push(`\n관련 파일(작업 폴더 기준):\n${list.join("\n")}`);
  }
  if (row.schema) parts.push(schemaInstruction(row.schema));
  return parts.join("\n");
}

// ── 프록시(단발 + API 키) ──
/** 단발 결과 모양 — 작업 결과(agent-jobs onResult)와 칸 이름을 맞춘다(text · model · usage · duration_ms). */
function proxyResult(o: { text: string; json: unknown; model: string | null; usage: Usage; durationMs: number; retries: number; stopReason: string | null; truncated: boolean }): Record<string, unknown> {
  return { text: o.text, ...(o.json !== undefined ? { json: o.json } : {}), model: o.model, usage: o.usage, duration_ms: o.durationMs, retries: o.retries, stop_reason: o.stopReason, truncated: o.truncated };
}

/** 단발 한 번 — history(#5101 이어받기)는 앞 대화(처음 실행부터 · plan.resumeHistory) — 그 뒤에 이번 지시를 잇는다. 새 질문이면 null. */
export async function runProxy(row: AiRunRow, p: AiRunPolicy, d: AiRunDeps, history: ChatTurn[] | null = null): Promise<void> {
  const tenant = d.tenant();
  const key = await d.apiKey();
  if (!key) { await d.store.finishAiRun(row.id, { status: "failed", result: null, error: "워크스페이스 API 키가 없습니다" }); return; }
  if (!d.inflight.take(tenant, p.max_inflight)) {
    await d.store.finishAiRun(row.id, { status: "failed", result: null, error: `이 워크스페이스의 AI 호출이 동시에 ${p.max_inflight}개 돌고 있습니다 — 잠시 뒤 다시 보내세요` });
    return;
  }
  const started = d.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), p.single_timeout_sec * 1000);
  timer.unref?.();   // 상한 시계가 프로세스를 붙잡지 않게(시험 · 종료)
  const total: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  const add = (u: Usage): void => { total.input_tokens += u.input_tokens; total.output_tokens += u.output_tokens; total.cache_read_tokens += u.cache_read_tokens; total.cache_write_tokens += u.cache_write_tokens; };
  const model = row.model ?? DEFAULT_MODEL;
  const maxTokens = p.max_output_tokens;
  const prompt = row.prompt + (row.schema ? schemaInstruction(row.schema) : "");
  const first: ChatTurn[] | undefined = history ? [...history, { role: "user", content: prompt }] : undefined;
  const workspaceId = (await d.apiWorkspaceId?.()) ?? null;   // 워크스페이스에 묶이지 않은 키의 anthropic-workspace-id
  const call = async (i: SingleShotInput): Promise<SingleShotOutput> => {
    const t0 = d.now();
    let out: SingleShotOutput;
    try { out = await d.singleShot(key, { ...i, workspaceId: i.workspaceId ?? workspaceId }, ac.signal); }
    catch (e) {
      const why = ac.signal.aborted ? `시간 상한(${p.single_timeout_sec}초)을 넘었습니다` : `LLM 호출 실패: ${e instanceof Error ? e.message : String(e)}`;
      out = { ok: false, status: 0, text: "", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, model: null, stopReason: null, error: why.slice(0, 400) };
    }
    add(out.usage);
    await d.store.insertLlmCall({
      appId: row.app_id, runId: row.id, caller: "run", member: row.requester, model: out.model ?? model, path: "/v1/messages", stream: false, status: out.status || null,
      inputTokens: out.usage.input_tokens, outputTokens: out.usage.output_tokens, cacheReadTokens: out.usage.cache_read_tokens, cacheWriteTokens: out.usage.cache_write_tokens,
      durationMs: d.now() - t0, error: out.error,
    }).catch((e) => logger.warn({ run: row.id, err: (e as Error)?.message }, "[ai-run] 프록시 계측 기록 실패"));
    return out;
  };
  try {
    let out = await call({ model, prompt, system: row.system_prompt, maxTokens, ...(first ? { messages: first } : {}) });
    if (!out.ok) {
      await d.store.finishAiRun(row.id, { status: "failed", result: null, error: out.error ?? "LLM 호출 실패", inputTokens: total.input_tokens, outputTokens: total.output_tokens });
      return;
    }
    let retries = 0;
    let judged = judgeOutput(out.text, row.schema);
    if (!judged.ok && row.schema) {
      retries = 1;
      const retry = await call({
        model, prompt, system: row.system_prompt, maxTokens,
        messages: [...(first ?? [{ role: "user" as const, content: prompt }]), { role: "assistant", content: out.text || "(빈 답)" }, { role: "user", content: retryInstruction(judged.errors, row.schema) }],
      });
      if (retry.ok) { out = retry; judged = judgeOutput(out.text, row.schema); }
    }
    const durationMs = d.now() - started;
    const truncated = out.stopReason === "max_tokens";
    if (!judged.ok) {
      await d.store.finishAiRun(row.id, {
        status: "failed", error: `답이 결과 형식에 맞지 않습니다(${judged.errors.slice(0, 3).join(" · ")}) — 원문은 result.text 에`,
        result: proxyResult({ text: out.text, json: undefined, model: out.model, usage: total, durationMs, retries, stopReason: out.stopReason, truncated }),
        inputTokens: total.input_tokens, outputTokens: total.output_tokens, retries,
      });
      return;
    }
    await d.store.finishAiRun(row.id, {
      status: "done", error: null,
      result: proxyResult({ text: out.text, json: judged.json, model: out.model, usage: total, durationMs, retries, stopReason: out.stopReason, truncated }),
      inputTokens: total.input_tokens, outputTokens: total.output_tokens, retries,
    });
  } catch (e) {
    logger.warn({ run: row.id, err: (e as Error)?.message }, "[ai-run] 프록시 실행 실패");
    await d.store.finishAiRun(row.id, { status: "failed", result: null, error: `실행 실패: ${(e as Error)?.message ?? e}`.slice(0, 600) }).catch(() => null);
  } finally {
    clearTimeout(timer);
    d.inflight.release(tenant);
  }
}

// ── 작업 컨테이너에 붙은 실행 ──
/**
 * 작업 행의 상태를 실행 행에 맞춘다. 끝난 작업이면 결과 형식을 판정하고 — 어긋나면(스키마 · 첫 번째) 그 대화를 이어받는 작업으로 «형식에 맞게 다시» 한 번 —
 *  실행을 끝낸다. 몇 번 불러도 같다(끝내기는 조건부 쓰기). 돌려주는 것 = 지금 행(없으면 null).
 */
export async function syncRun(run: AiRunRow, d: AiRunDeps): Promise<AiRunRow | null> {
  if (run.executor !== "job" || isEndedRun(run.status)) return run;
  if (run.job_id == null) {
    //  접수 뒤 작업 행을 못 달았다(submitJob 실패는 접수가 끝냈다) — 오래됐으면 끝낸다.
    if (d.now() - +new Date(run.created_at) > 5 * 60_000) return d.store.finishAiRun(run.id, { status: "failed", result: null, error: "작업 컨테이너에 보내지 못했습니다" });
    return run;
  }
  const job = await d.getJob(run.job_id);
  if (!job) return d.store.finishAiRun(run.id, { status: "failed", result: null, error: "작업 행이 없습니다" });
  const st = runStatusOfJob(job.status);
  if (st === "queued") return run;
  if (st === "running") { if (run.status === "queued") await d.store.markAiRunRunning(run.id); return d.store.getAiRun(run.id); }
  const jr = (job.result ?? {}) as Record<string, unknown>;
  const text = typeof jr.text === "string" ? jr.text : "";
  const usage = (jr.usage && typeof jr.usage === "object" ? jr.usage : null) as Record<string, unknown> | null;
  const base = {
    text, model: (jr.model as string | null) ?? job.model, usage, cost_usd: (jr.cost_usd as number | null) ?? null, duration_ms: (jr.duration_ms as number | null) ?? null,
    num_turns: (jr.num_turns as number | null) ?? null, conversation_id: job.conversation_id, job_id: job.id, retries: run.retries, truncated: jr.truncated === true,
  };
  const toks = { inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : null, outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : null };
  const finish = (f: { status: "done" | "failed" | "canceled"; result: Record<string, unknown> | null; error: string | null }): Promise<AiRunRow | null> =>
    d.store.finishAiRun(run.id, { ...f, ...toks }).then(async (r) => { if (r?.proxy_token_hash) await d.store.setAiRunProxyToken(r.id, null).catch(() => undefined); return r; });
  if (st !== "done" || jr.is_error === true) {
    return finish({ status: st === "canceled" ? "canceled" : "failed", result: text ? { ...base } : null, error: job.error ?? (jr.is_error ? "하네스가 오류로 끝났습니다" : "작업이 실패했습니다") });
  }
  const judged = judgeOutput(text, run.schema);
  if (judged.ok) return finish({ status: "done", result: { ...base, ...(judged.json !== undefined ? { json: judged.json } : {}) }, error: null });
  //  #5101 — API 키 작업의 대화는 게이트웨이가 보관한 기록뿐이다(빈 설정 폴더는 끝나면 지워진다). 기록이 없으면(올리지 못함 · 상한 초과) 다시 묻지 않고
  //   원문을 붙여 실패한다 — 띄워 봐야 하네스가 «대화 없음» 으로 끝나 원문 대신 그 오류가 남는다.
  const resumable = !!job.conversation_id && (run.account_kind !== "api_key" || !!(await d.resumeTarget(job.id).catch(() => null))?.resumable);
  if (run.retries === 0 && run.schema && resumable) {
    try {
      const retry = await d.submitJob({
        requester: run.requester, accountKind: run.account_kind, accountMember: run.account_member, appId: run.app_id, projectId: job.project_id,
        model: job.model, label: `${run.label ?? `AI 실행 #${run.id}`} (형식 다시)`, prompt: retryInstruction(judged.errors, run.schema),
        timeoutMin: Math.max(1, Math.round(job.timeout_sec / 60)), bare: run.kind === "single", resumeJobId: job.id,
        //  #4891 — 재시도는 원래 작업의 자리를 그대로 탄다(홈 없는 작업의 재시도가 사람 홈에서 돌지 않게 — 격리 리뷰).
        //  #5081 — 공용 시트 표시도 이 실행 것을 그대로(지금 설정으로 다시 고르지 않는다 — 그 사이 지정을 거뒀으면 재시도는 띄우기 직전에 멈춘다).
        homeless: job.homeless === true, sharedSeat: await d.store.aiRunSharedSeat(run.id),
      }, { userId: run.requester, email: "", scopes: [], projects: ["*"] } as LivelyUser);
      if (await d.store.retryAiRun(run.id, retry.id)) { logger.info({ run: run.id, job: retry.id }, "[ai-run] 형식에 맞게 다시 — 재시도 작업"); return d.store.getAiRun(run.id); }
    } catch (e) {
      logger.warn({ run: run.id, err: (e as Error)?.message }, "[ai-run] 재시도 작업을 보내지 못했다 — 원문 붙여 실패");
    }
  }
  return finish({ status: "failed", result: { ...base }, error: `답이 결과 형식에 맞지 않습니다(${judged.errors.slice(0, 3).join(" · ")}) — 원문은 result.text 에` });
}

/** 작업이 끝났을 때(agent-jobs reapJob) — 그 작업에 붙은 실행을 곧바로 맞춘다. 던지지 않는다. */
export async function onJobEnded(job: Pick<AgentJobRow, "id">, d: AiRunDeps): Promise<void> {
  try {
    const run = await d.store.getAiRunByJob(job.id);
    if (run) await syncRun(run, d);
  } catch (e) {
    logger.warn({ job: job.id, err: (e as Error)?.message }, "[ai-run] 작업 끝 반영 실패(정비가 다시 본다)");
  }
}

/** 정비 — 작업에 붙은 열린 실행을 맞추고, 게이트웨이가 죽어 끝맺지 못한 프록시 실행을 끝낸다. */
export async function sweepAiRuns(d: AiRunDeps): Promise<{ synced: number; stale: number }> {
  let synced = 0, stale = 0;
  for (const r of await d.store.openJobRuns()) { await syncRun(r, d).catch((e) => logger.warn({ run: r.id, err: (e as Error)?.message }, "[ai-run] 정비 맞추기 실패")); synced++; }
  const p = await d.policy();
  for (const r of await d.store.staleProxyRuns(p.single_timeout_sec * 2 + 60)) {
    if (await d.store.finishAiRun(r.id, { status: "failed", result: null, error: "게이트웨이가 실행을 끝맺지 못했습니다(재기동) — 다시 보내세요" })) stale++;
  }
  return { synced, stale };
}

// ── API 키 에이전트 작업의 판 환경(agent-jobs onBoot 가 묻는다) ──
/**
 * 작업 컨테이너의 판이 하네스에 더 줄 env — API 키 실행이면 우리 프록시 주소 + 그 실행 한정 토큰 + 빈 설정 폴더(멤버 홈의 로그인을 읽지 않게).
 *  키는 컨테이너에 들어가지 않는다(설계 §12 ⑤-5). 구독 실행이면 빈 객체.
 *  at — 판이 보는 게이트웨이(#5082 — 박스 위 판은 그 박스의 루프백 포트)와 실을 워크스페이스(게이트웨이에 바로 닿는 판만 — 셀프호스트 다중
 *   워크스페이스는 머리로 고른다. Claude Code 가 모든 API 요청에 ANTHROPIC_CUSTOM_HEADERS 를 싣는다 · 프록시는 위로 넘기지 않는다).
 */
export async function bootEnvForJob(
  job: Pick<AgentJobRow, "id" | "account_kind">, d: AiRunDeps,
  at: { gateway: string; workspace: string | null } = { gateway: RUNNER_GATEWAY_URL, workspace: null },
): Promise<Record<string, string>> {
  if (job.account_kind !== "api_key") return {};
  const run = await d.store.getAiRunByJob(job.id);
  if (!run) throw new HttpError(409, "API 키 작업에 붙은 실행 행이 없습니다");
  const t = d.newProxyToken();
  await d.store.setAiRunProxyToken(run.id, t.hash);
  return {
    ANTHROPIC_BASE_URL: proxyBaseAt(at.gateway),
    ...(at.workspace ? { ANTHROPIC_CUSTOM_HEADERS: `x-lively-workspace: ${at.workspace}` } : {}),
    ANTHROPIC_AUTH_TOKEN: t.token,
    ANTHROPIC_API_KEY: "",
    CLAUDE_CONFIG_DIR: CONFIG_DIR_PLACEHOLDER,
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

// ── 조회 · 취소 · 대상 ──
/**
 * 내 실행인가 — 보낸 사람, 또는 (구독 실행이면) 그 구독의 주인(초대받은 사람이 내 세션에서 보내 내 구독·내 자리로 도는 실행 — 격리 리뷰 non-blocking 3).
 *  #5081 공용 시트로 돈 실행(sharedSeat — 실행 행의 shared_seat 표시)은 구독 주인의 것이 아니다 — 시트 계정은 구성원 누구의 지시든 받는 자리일 뿐이고
 *   지시 · 답은 물은 사람 것이다(시트 계정으로 로그인한 사람이 남의 질문 · 답을 읽거나 끊지 않게). 지정을 거둔 뒤에도 그 실행은 그대로 남의 것이다.
 *   sharedSeat 는 필수다 — 빠뜨린 자리가 기본값(«공용 시트 아님»)으로 남의 실행을 열지 않게.
 */
export function isOwnRun(r: Pick<AiRunRow, "requester" | "account_kind" | "account_member">, user: LivelyUser, sharedSeat: boolean): boolean {
  const me = memberOf(user);
  return r.requester === me || (!sharedSeat && r.account_kind === "subscription" && r.account_member === me);
}
export function canSeeRun(r: AiRunRow, user: LivelyUser, d: AiRunDeps, sharedSeat: boolean): boolean {
  if (d.isAdmin(user) && !user.appId) return true;
  if (!isOwnRun(r, user, sharedSeat)) return false;
  if (user.appId && r.app_id !== user.appId) return false;
  return true;
}
/**
 * 이 실행이 공용 시트로 돌았나(#5081 — 실행 행의 표시 · store.aiRunSharedSeat) — 구독 주인 가지만이 판정을 가를 때만 읽는다(그 밖엔 답이 같다).
 *  작업 행을 보지 않는다 — 작업 행이 없거나(접수 실패) 지워져도(보존 정리) 실행 행의 표시는 남는다.
 */
async function sharedSeatRunFor(r: Pick<AiRunRow, "id" | "requester" | "account_kind" | "account_member">, user: LivelyUser, d: Pick<AiRunDeps, "store">): Promise<boolean> {
  const me = memberOf(user);
  if (r.requester === me || r.account_kind !== "subscription" || r.account_member !== me) return false;
  return d.store.aiRunSharedSeat(r.id);
}

export async function getRunFor(id: number, user: LivelyUser, d: AiRunDeps): Promise<Record<string, unknown>> {
  let row = Number.isSafeInteger(id) && id > 0 ? await d.store.getAiRun(id) : null;
  const shared = row ? await sharedSeatRunFor(row, user, d) : false;
  if (!row || !canSeeRun(row, user, d, shared)) throw new HttpError(404, "없는 실행입니다");
  if (row.executor === "job" && !isEndedRun(row.status)) row = (await syncRun(row, d)) ?? row;
  return publicRun(row, { own: isOwnRun(row, user, shared), withPrompt: true, resume: await d.store.aiRunResumeLink(row.id) });
}

export async function listRunsFor(f: { app_id?: unknown; status?: unknown; limit?: unknown }, user: LivelyUser, d: AiRunDeps): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Number(f.limit) || 20, 1), 100);
  const status = typeof f.status === "string" && /^[a-z]{4,10}$/.test(f.status) ? f.status : null;
  const admin = d.isAdmin(user) && !user.appId;
  const appId = user.appId ? user.appId : (typeof f.app_id === "string" && f.app_id ? f.app_id : null);
  const me = memberOf(user);
  //  requester 필터는 «내 실행»(보낸 것 + 공용 시트가 아닌 내 구독으로 도는 것)이다 — store.listAiRuns 의 SQL 조건과 isOwnRun 이 한 뜻.
  const rows = await d.store.listAiRuns({ appId, requester: admin ? null : me, status, limit });
  return { runs: rows.map((r) => publicRunSummary(r, { own: isOwnRun(r, user, r.shared_seat === true) })), limit };
}

export async function cancelRunFor(id: number, user: LivelyUser, d: AiRunDeps): Promise<Record<string, unknown>> {
  const row = Number.isSafeInteger(id) && id > 0 ? await d.store.getAiRun(id) : null;
  const shared = row ? await sharedSeatRunFor(row, user, d) : false;
  if (!row || !canSeeRun(row, user, d, shared)) throw new HttpError(404, "없는 실행입니다");
  const own = isOwnRun(row, user, shared);
  if (isEndedRun(row.status)) return publicRun(row, { own });
  if (row.executor === "job" && row.job_id != null) {
    await d.cancelJob(row.job_id, user);
    const synced = await syncRun((await d.store.getAiRun(row.id)) ?? row, d);
    if (synced && isEndedRun(synced.status)) return publicRun(synced, { own });
    //  도는 중이면 판의 다음 박동이 받는다 — 실행 행은 작업이 끝날 때 따라 끝난다(reapJob → onJobEnded).
    return publicRun(synced ?? row, { own });
  }
  //  프록시 실행은 몇 초짜리라 끊지 않는다 — 끝나는 대로 결과가 남고, 앱이 보지 않으면 그만이다.
  const ended = await d.store.finishAiRun(row.id, { status: "canceled", result: null, error: "취소했습니다" });
  return publicRun(ended ?? row, { own });
}

/**
 * 고를 수 있는 대상(설계 §5) — 실행 계정(워크스페이스가 정한 것 · 쓸 수 있나) · 이 앱이 붙은 내 세션(본 대화에 보내기 — chat.send) ·
 *  이 앱이 만든 대화(이어받기) · 선언한 작업과 그 실행 계정. 분기(fork)는 v2-10 — 지금은 false.
 *  구독 로그인 판정은 여기서만 부르고 짧게 기억한다(설계 §12 ④).
 */
export async function targetsFor(user: LivelyUser, input: { app_id?: unknown }, d: AiRunDeps, ctx: { session?: string } = {}): Promise<Record<string, unknown>> {
  const who = requesterOf(user);
  const appId = typeof user.appId === "string" && user.appId ? user.appId : (typeof input.app_id === "string" ? input.app_id.trim() : "");
  if (!appId) throw new HttpError(400, "app_id 가 필요합니다");
  if (!user.appId) await d.assertAppUsable(user, appId);
  const app = await d.getApp(appId);
  const [settings, key] = await Promise.all([d.accountSettings(), d.apiKey()]);
  //  세션 tie 는 요청마다 한 번만 조회한다(계정 종류가 셋이어도 — 격리 리뷰 nit).
  let tieP: Promise<SessionTie | null> | null = null;
  const tieOnce = (a: AiAccount): Promise<SessionTie | null> => (tieP ??= sessionTieOf(ctx, who, a, d));
  const describe = async (a: AiAccount | null, from: string | null): Promise<Record<string, unknown>> => {
    if (!a) return { kind: null, available: false, reason: "실행 계정이 없습니다 — 워크스페이스 API 키 또는 구독을 설정하세요", from };
    if (a.kind === "api_key") return { kind: "api_key", available: !!key, reason: key ? null : "워크스페이스 API 키가 등록되지 않았습니다", from };
    //  #5081 공용 시트 — 접수와 같은 판정. 구성원 표를 못 읽으면 «쓸 수 없음» 으로(대상 보기는 던지지 않는다).
    const seat = await seatTermsOf(settings, a, who, d).catch(() => undefined);
    if (seat === undefined) return { kind: "subscription", member: a.member, shared_seat: false, available: false, logged_in: null, reason: "실행 계정을 확인하지 못했습니다 — 잠시 뒤 다시 보세요", from };
    const shared = !!seat && seatShared(seat.facts);
    const refusal = subscriptionRefusal(a, who, await tieOnce(a), seat);
    const loggedIn = refusal ? null : await d.subscriptionLoggedIn(a.member).catch(() => null);
    return { kind: "subscription", member: a.member, shared_seat: shared, available: !refusal && loggedIn !== false, logged_in: loggedIn, reason: refusal ?? (loggedIn === false ? (shared ? "AI 연결 필요 — 공용 시트 계정이 Claude 에 로그인해야 합니다" : "AI 연결 필요 — 그 구성원이 Claude 에 로그인해야 합니다") : null), from };
  };
  const def = resolveAccount(settings, appId, null, !!key);
  const jobs = await Promise.all(declaredAiJobs(app).map(async (j) => {
    const r = resolveAccount(settings, appId, j.name, !!key);
    return { ...j, account: await describe(r?.account ?? null, r?.from ?? null) };
  }));
  const attached = who.kind === "member" ? await d.attachedSessions(appId, who.member).catch(() => []) : [];
  const conversations = await d.store.appConversations(appId, who.member).catch(() => []);
  return {
    invoker: { member: who.member, kind: who.kind },
    account: await describe(def?.account ?? null, def?.from ?? null),
    default_model: settings.default_model ?? DEFAULT_MODEL,
    llm_proxy: !!key,
    jobs,
    attached: attached.map((s) => ({ ...s, can_send: true, can_fork: false })),
    conversations: conversations.map((c) => ({ run_id: c.run_id, conversation_id: c.conversation_id, label: c.label, ended_at: c.ended_at })),
    fork: false,
  };
}
