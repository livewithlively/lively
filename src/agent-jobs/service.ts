// 작업 컨테이너 — 흐름 (#4490 앱 v2-11 · #3994 1단계 공동)
//
//  접수(submit) → 자리 주기(dispatch: 워크스페이스 동시 상한·사람당 상한) → 컨테이너 띄우기(launch) → 판 첫 말(boot: 프롬프트·인자·콜백 비밀을 받아 감)
//   → 박동(tick: 진행 꼬리 · 취소 전달) → 결과(result: 상태·답을 적는다) → 걷기(reap: kill-session · 작업 토큰 폐기) → 다음 대기 작업.
//  첫 말이 안 되면(답을 못 받음 · 판 본체가 곧바로 죽음) 판이 그 사유를 알린다(boot-failed #4829) — 그 사유로 곧바로 끝내고 걷는다.
//  감시(sweep)가 그 사이 끊긴 것을 끝낸다 — 대기 초과 · 시작 못 함 · 판 말 없음 · 시간 초과 · 걷지 못한 끝난 작업.
//
//  ── 수명 규칙(설계 §12 ⑤-3 «남은 설계» — 이 태스크가 정한다) ──
//  · 끝 = 결과를 **먼저** 적고 → 곧바로 걷는다. 판이 결과를 올리고 스스로 빠지면 tmux 가 끝나 브로커가 걷는다(#4696 — 세션 호스트의 3초
//    목록이 신호). 게이트웨이도 결과를 받은 뒤 kill-session 을 한 번 보낸다(판이 빠지지 못한 경우 · 신호를 앞당김).
//  · 시간 상한은 판이 스스로 지킨다(SIGTERM → 10초 → SIGKILL → 보고). 판이 못 지키면 감시가 상한+2분에 끝내고 걷는다.
//  · 작업 컨테이너는 세션이 아니다 — 사람 목록·복원·회수 규칙(T5)을 타지 않고, 걷기는 이 흐름과 브로커 안전망(닻 없음 5분·장부)이 한다.
//  · 띄우기 실패: 확보 단계(OS 계정 · 작업 폴더 · 컨테이너 · 홈 준비 · 판 — launch.stepFailure)와 판정을 못 한 것은 일시다 — 대기열로 되돌리고
//    이번 배차를 멈춘다. 다시 받기 전에 LAUNCH_RETRY_GAP_SEC 를 쉬고, 시도 MAX_LAUNCH_ATTEMPTS 번이 끝을 정한다(«N번 시도» 로 실패).
//    다시 해도 안 될 것(세션 id · 실행 계정 없음 · 매니지드 아님 · 앱 동의 없음)은 그 작업만 실패로 끝내고 다음 작업을 띄운다.
//    ⚠ 자리를 받은(starting) 뒤 띄우기 전에 게이트웨이가 죽으면 되돌리지 않는다 — 시작 상한(180초)에 «시작하지 못했습니다» 로 끝난다.
//
//  ── 누가 보낼 수 있나(설계 §12 ④ · 상민 2026-10-16 결정 ③ «본인 세션과 같은 신뢰») ──
//  작업은 **보낸 사람 본인으로** 돈다 — 그 사람의 Claude 구독과 홈(로그인·git 자격·키트 토큰)을 그대로 쓴다. 앱 동의는 «그 앱 화면에서 내가 보낸
//  지시를 나로서 실행» 이다. 그래서 받는 길을 좁힌다: 사람 본인(웹·본인 세션의 AI) · 앱 화면(라이블리 화면의 다리 `app-ui` · 앱 주소의
//  `/_lively/*` `app-front` — 둘 다 capabilities/app-tool-call.runAppTool 의 같은 판정)만. 앱 서버 대리 · 앱 토큰의 직접 호출 ·
//  작업 AI 자신(작업 토큰)은 거절한다. ⚠ 작업 AI 의 라이블리 도구를 앱 토큰으로 좁히는 것은 **도구 배선**이지 운영체제 경계가 아니다 —
//  같은 uid 라 홈의 멤버 토큰을 읽을 수 있다(본인 세션과 같은 한계 · apps/principal.ts 머리말).
//  동의를 거두거나 앱이 꺼지거나 실행 계정이 비활성이 되면: 기다리는 작업은 띄우지 않고(배차 직전 재판정) · 도는 작업은 감시가 멈춘다
//  (사유를 남겨 다음 박동에 끊김 · 띄우는 중이면 바로 끝내고 걷는다).
//  관리자는 남의 작업의 상태·오류만 본다 — 프롬프트·답·진행 꼬리는 보낸 사람 것이다(작업은 그 사람의 홈·지식으로 돈다).
//  #5081 공용 시트 작업(앱 AI 실행이 접수 — ai-runs)은 예외다: 자리(홈 · Claude 로그인)는 시트 계정, 작업 AI 의 라이블리 신원은 보낸 사람(앱 서버 급)이다.
//   시트 지정을 거두거나 시트 계정이 높은 권한을 얻거나 보낸 사람이 구성원이 아니게 되면 위와 같이 띄우지 않고 · 멈춘다(live.assertJobAllowed).
//
//  ⚠ 청/녹 두 슬롯이 같은 작업을 볼 수 있다 — 상태 전이는 전부 store 의 «지금 상태가 이것일 때만» 쓰기로 한 번만 넘어간다.
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import type { LivelyUser } from "../context.js";
import { resolveAgentJobPolicy, type AgentJobPolicy } from "../org/policies/agent-job-policy.js";
import { isAppScreenSource } from "../apps/app-screen-sources.js";
import {
  LABEL_MAX, PROMPT_MAX, RESULT_TEXT_MAX, STDERR_TAIL_MAX, TAIL_MAX, TICK_MS, appFolderCwd, bootFailureError, convIdOf, finalOutcome, isEnded,
  jobSessionId, noNul, parseBootFailure, parseRunnerReport, projectFolderCwd, sharedSeatJobRefusal, sweepDecision, timeoutSecOf, APP_ID_RE, JOB_SESSION_ID_RE,
  PRUNE_BATCH, PRUNE_ROUNDS_MAX,
} from "./plan.js";
import { MODEL_RE, RUNNER_SOURCE, claudeJobArgv, type RunnerJob } from "./runner.js";
import { BROKER_GATEWAY, type PaneView } from "./surface.js";
import type { AgentJobAuthRow, AgentJobRow, AgentJobSummaryRow, NewAgentJob } from "./store.js";

type Store = typeof import("./store.js");

export interface AgentJobDeps {
  store: Pick<Store, "insertAgentJob" | "claimAgentJobs" | "getAgentJob" | "getAgentJobAuth" | "bootAgentJob" | "setAgentJobMcpToken" | "tickAgentJob"
    | "finishAgentJob" | "requeueAgentJob" | "requestCancelAgentJob" | "openAgentJobs" | "markAgentJobReaped" | "listAgentJobs" | "queuePosition"
    | "isAgentJobToken" | "newJobSecret" | "secretMatches" | "pruneAgentJobs" | "failBootAgentJob" | "agentJobPolicyRow" | "agentJobSharedSeat">;
  policy(): Promise<AgentJobPolicy>;
  /** 작업 판을 띄울 수 있는 배포인가(매니지드 브로커 · 셀프호스트 박스 위 실행면 — surface.ts). */
  available(): Promise<boolean>;
  /** 못 띄울 때 접수가 돌려줄 문장(501 — 무엇을 켜면 되는지). 없으면 일반 문장. */
  unavailableMessage?(): string;
  /** 판의 첫 말에 줄 자리 — 작업 폴더(판의 자리 기준) · 게이트웨이 주소 · 실을 워크스페이스(surface.paneView). 없으면 행의 작업 폴더와 매니지드 루프백.
   *  던지면 그 작업은 돌지 않는다. */
  paneView?(job: AgentJobRow): Promise<PaneView>;
  /** 띄운다. 일시 실패(컨테이너 확보가 막힘)는 `transient: true` 인 오류로 던진다(launch.JobLaunchError). */
  launch(job: AgentJobRow, bootSecret: string): Promise<unknown>;
  /** 걷는다 — 이미 없다는 확답이면 조용히, 그 밖의 실패는 던진다(launch.killJobContainer). */
  kill(sessionId: string): Promise<void>;
  /**
   * 이 작업을 아직 돌려도 되나 — 실행 계정이 활성 구성원이고, 앱 작업이면 그 사람이 그 앱을 쓸 수 있나(보임 · 켜짐 · 동의).
   *  «안 된다» 는 HttpError 로 던진다(띄우기 직전 · 도는 동안 감시). 그 밖의 던짐은 «판정을 못 했다»(DB 가 잠깐 막힘)다.
   */
  assertJobAllowed(job: Pick<AgentJobRow, "id" | "app_id" | "account_member" | "account_kind" | "requester" | "project_id" | "cwd">): Promise<void>;
  /** 이 게이트웨이가 판의 말을 듣기 시작한 시각(프로세스 시작, ms) — 재기동 직후 무응답 판정을 보류하는 기준. */
  listeningSince(): number;
  /** 작업 AI 의 라이블리 MCP 토큰 — 앱 작업이면 앱 토큰(구성원 권한 ∩ 앱 동의), 아니면 그 멤버 토큰. 만료 = 작업 상한 + 여유. */
  mintMcpToken(job: AgentJobRow): Promise<{ token: string; tokenHash: string } | null>;
  /** 하네스에 더 줄 env(#4488 — API 키 실행의 프록시 주소 · 실행 토큰 · 빈 설정 폴더). 없으면 빈 객체. 던지면 그 작업은 돌지 않는다.
   *  at — 판이 보는 게이트웨이 주소와 실을 워크스페이스(#5082 paneView — 프록시도 그 아래 · 그 워크스페이스로). */
  jobEnv?(job: AgentJobRow, at: { gateway: string; workspace: string | null }): Promise<Record<string, string>>;
  /** 하네스의 시스템 지시(#5082 앱 판 지시 — 그 작업에 붙은 AI 실행의 작업 이름이 ai.instructions 를 선언했으면 그 판 파일의 글). 없으면 null.
   *  던지면 그 작업은 돌지 않는다(선언한 지시 없이 돌리지 않는다). */
  jobSystem?(job: AgentJobRow): Promise<string | null>;
  /** 작업이 끝나 걷을 때(#4488 — 그 작업에 붙은 AI 실행 행을 맞춘다). 던지지 않는다. */
  onJobEnded?(job: Pick<AgentJobRow, "id">): Promise<void>;
  /**
   * #5081 지금 공용 시트로 켜진 계정들(관리자 승인 + 본인 동의) — 자리 주기가 그 시트의 작업을 보낸 사람당 · 시트 전체로 센다(plan.planClaims).
   *  못 읽으면 빈 묶음으로 센다(시트 계정 하나로 세는 종전 셈 — 더 좁다).
   */
  sharedSeats?(): Promise<ReadonlySet<string>>;
  revokeToken(tokenHash: string): Promise<void>;
  /** 그 프로젝트 폴더에서 이 사람이 셸을 띄울 수 있나(사람 세션과 같은 판정 — 안 되면 던진다). */
  assertProjectCwd(user: LivelyUser, projectId: number): Promise<void>;
  /** 이 사람이 이 앱을 지금 쓸 수 있나(보임 · 켜짐 · 동의) — 안 되면 던진다. */
  assertAppUsable(user: LivelyUser, appId: string): Promise<void>;
  /** 테넌트 맥락을 이어서 조금 뒤에(또는 곧바로) 돈다 — 요청 응답을 붙잡지 않게. */
  later(fn: () => Promise<unknown>, ms: number): void;
  workspaceSlug(): string | null;
  hex8(): string;
  now(): number;
}

/** 결과를 받은 뒤 걷기까지 — 판이 결과 응답을 받고 스스로 빠질 틈(로그인 판 REAP_DELAY 와 같은 자리). */
export const REAP_DELAY_MS = 8_000;
/** 끝난 뒤 이만큼 걷기(kill)를 못 하면 놓는다 — 영구 실패가 감시 목록을 막지 않게. 그 뒤는 브로커 안전망(닻 없음 · 장부)의 몫이다. */
export const REAP_GIVE_UP_MS = 10 * 60_000;
/** 감시가 한 번에 보는 작업 수 — 대기열 상한의 범위 끝(500)과 동시 상한(20)을 넉넉히 넘는다. */
export const SWEEP_SCAN_MAX = 1_000;
/** 띄우기 시도 상한 — 일시 실패로 되돌리는 것은 여기까지. 넘으면 그 작업을 실패로 끝낸다(«N번 시도»). */
export const MAX_LAUNCH_ATTEMPTS = 5;
/**
 * 되돌린 작업을 다시 받기 전에 쉬는 시간(초) — 배차는 감시만이 아니라 접수·결과·취소 때도 돈다. 쉬지 않으면 몇 분짜리 장애(노드 자리 없음)에
 *  시도 상한이 몇 초 만에 다 닳는다(증분 재검토). 감시 주기와 같은 30초 — 시도 5번이면 적어도 2분.
 */
export const LAUNCH_RETRY_GAP_SEC = 30;
/** #5081 공용 시트 재판정이 읽는 사실의 출처 — live 가 설정 · 구성원 표 · 앱 판정을 잇는다(시험은 가짜로). */
export interface SharedSeatJobLoaders {
  /** 그 계정의 공용 시트 지정(관리자 승인 + 본인 동의)이 그대로인가. */
  seatConsented(member: string): Promise<boolean>;
  /** 그 구성원이 이 워크스페이스의 활성 사람 구성원인가 · 기본 권한 밖의 권한이 있나(ai-runs/live.memberFactsOf). */
  memberFacts(member: string): Promise<{ active: boolean; elevated: boolean }>;
  /** 그 사람이 그 앱을 지금 쓸 수 있나(보임 · 켜짐 · 동의) — 안 되면 HttpError 를 던진다. */
  assertAppUsable(member: string, appId: string): Promise<void>;
}

/**
 * #5081 공용 시트 작업을 아직 돌려도 되나 — 시트 계정의 사실은 account_member 로, 보낸 사람의 사실은 requester 로 읽어 plan.sharedSeatJobRefusal 로 재고,
 *  통과하면 **보낸 사람**의 앱 동의를 본다(시트 계정의 동의가 아니다 — 앱을 쓰는 사람은 물은 사람이다). 접수 때(ai-runs/service.submitRun)와 같은 자다.
 *  «안 된다» 는 HttpError(409 · 403 · 404) — 배차 직전이면 그 작업의 끝, 도는 중이면 감시가 멈춘다(live.assertJobAllowed).
 */
export async function assertSharedSeatJob(
  job: Pick<AgentJobRow, "app_id" | "account_member" | "account_kind" | "requester" | "project_id" | "cwd">, l: SharedSeatJobLoaders,
): Promise<void> {
  const seat = job.account_member ?? "";
  const [consented, seatFacts, requesterFacts] = await Promise.all([l.seatConsented(seat), l.memberFacts(seat), l.memberFacts(job.requester)]);
  const why = sharedSeatJobRefusal(job, { consented, seat: seatFacts, requesterActive: requesterFacts.active });
  if (why) throw new HttpError(409, why);
  await l.assertAppUsable(job.requester, job.app_id!);
}

/** 더 돌릴 수 없게 돼(동의 철회 · 앱 꺼짐 · 실행 계정 비활성) 감시가 멈춘 작업의 오류 문장 — 판정이 낸 사유를 붙인다. */
export function stoppedReason(why: string): string {
  return `더 돌릴 수 없게 돼 멈췄습니다 — ${why}`.slice(0, 600);
}
/** MCP 토큰 만료 여유(초) — 작업 상한 + 대기·부트·보고 시간. */
export const MCP_TOKEN_SLACK_SEC = 15 * 60;

const isAdmin = (u: LivelyUser | undefined): boolean => Array.isArray(u?.scopes) && u!.scopes!.includes("admin");
const memberOf = (u: LivelyUser | undefined): string => String(u?.userId || "");

// ── 접수 ──────────────────────────────────────────────────────────────────────

export interface SubmitInput {
  prompt?: unknown;
  project_id?: unknown;
  app_id?: unknown;
  timeout_min?: unknown;
  model?: unknown;
  label?: unknown;
  resume_job_id?: unknown;
}

/** 작업 한 줄의 공통 칸 — 목록과 하나 보기가 같은 이름으로 싣는다. */
function jobHead(r: AgentJobSummaryRow | AgentJobRow): Record<string, unknown> {
  return {
    id: r.id, status: r.status, label: r.label, app_id: r.app_id, project_id: r.project_id, cwd: r.cwd,
    requester: r.requester, account: r.account_kind === "subscription" ? { kind: "subscription", member: r.account_member } : { kind: r.account_kind },
    harness: r.harness, model: r.model, timeout_sec: r.timeout_sec,
    //  #4891 — 사람 홈 없는 작업 컨테이너에서 돌았나(앱 서버가 보낸 에이전트 작업).
    homeless: r.homeless === true,
    conversation_id: r.conversation_id, resume_job_id: r.resume_job_id,
    error: r.error, exit_code: r.exit_code, cancel_requested: r.cancel_requested,
    created_at: r.created_at, claimed_at: r.claimed_at, started_at: r.started_at, ended_at: r.ended_at,
  };
}

/**
 * 앱이 보는 작업 모양 — 비밀은 늘 빼고, 답·진행 꼬리는 보낸 사람 본인(own)에게만 싣는다(관리자는 상태·오류만 — 머리말).
 *  프롬프트는 본인이 하나 보기(agent_job_get)로 물을 때만(withPrompt) — 접수·취소 응답엔 싣지 않는다(최대 10만 자).
 */
export function publicJob(r: AgentJobRow, o: { own: boolean; withPrompt?: boolean; position?: number | null }): Record<string, unknown> {
  return {
    ...jobHead(r),
    ...(o.own ? { result: r.result, output_tail: r.output_tail } : { has_result: r.result !== null }),
    ...(o.own && o.withPrompt ? { prompt: r.prompt } : {}),
    ...(o.position != null ? { queue_position: o.position } : {}),
  };
}

/** 목록 한 줄 — 답은 앞머리(result_preview)만, 전문은 agent_job_get 으로. 남의 작업(관리자 목록)은 앞머리도 없다. */
export function publicJobSummary(r: AgentJobSummaryRow, o: { own: boolean }): Record<string, unknown> {
  return { ...jobHead(r), result_preview: o.own ? r.result_preview : null, has_result: r.has_result };
}

/**
 * 작업을 받는다. 실행 계정은 **본인 구독**(설계 §12 ④ — 본인이 보낸 일만 본인 구독으로 · 상민님 2026-10-16 «본인 세션과 같은 신뢰»).
 *  작업 폴더: 앱 화면이 보낸 작업(user.appId)은 그 앱 폴더 — project_id 를 주면 그 프로젝트 폴더(앱 폴더는 그 안 .lively/apps/<앱> 에 붙는다).
 *  앱 밖(사람·AI 도구 호출)은 project_id 나 app_id(그 앱에 동의했을 때) 중 하나가 있어야 한다.
 *  이어받기(resume_job_id): 같은 사람(앱이면 같은 앱)의 끝난 작업이고 대화 id 가 있을 때 — 작업 폴더도 그 작업 것을 그대로 쓴다
 *  (하네스 대화 기록은 작업 폴더별로 갈린다).
 */
export async function submitAgentJob(input: SubmitInput, user: LivelyUser, d: AgentJobDeps, via: { source?: string } = {}): Promise<Record<string, unknown>> {
  const me = memberOf(user);
  if (!me) throw new HttpError(401, "인증이 필요합니다");
  await assertMaySubmit(user, via, d);
  if (!(await d.available())) throw new HttpError(501, d.unavailableMessage?.() ?? "이 배포에서는 에이전트 작업을 띄울 수 없습니다");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw new HttpError(400, "prompt 가 비었습니다");
  if (prompt.length > PROMPT_MAX) throw new HttpError(400, `prompt 가 너무 깁니다(${PROMPT_MAX.toLocaleString()}자 이하)`);
  //  NUL 은 DB 글 칸이 받지 않는다 — 지시 원문은 고쳐 담지 않고 거절한다(기록은 보낸 그대로여야 한다).
  if (prompt.includes("\u0000")) throw new HttpError(400, "prompt 에 쓸 수 없는 문자(NUL)가 있습니다");
  const rawLabel = typeof input.label === "string" ? noNul(input.label).trim() : "";
  const label = rawLabel ? rawLabel.slice(0, LABEL_MAX) : null;
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : null;
  if (model && !MODEL_RE.test(model)) throw new HttpError(400, "model 이름 형식이 아닙니다");
  const p = await d.policy();
  const callerApp = typeof user.appId === "string" && user.appId ? user.appId : null;

  let appId: string | null = callerApp;
  let projectId: number | null = null;
  let resumeConv: string | null = null;
  let resumeJobId: number | null = null;

  if (input.resume_job_id !== undefined && input.resume_job_id !== null) {
    const rid = Number(input.resume_job_id);
    const prev = Number.isSafeInteger(rid) && rid > 0 ? await d.store.getAgentJob(rid) : null;
    if (!prev || prev.requester !== me || (callerApp && prev.app_id !== callerApp)) throw new HttpError(404, "이어받을 작업이 없습니다");
    if (prev.status !== "done" || !prev.conversation_id) throw new HttpError(409, "이어받을 수 있는 작업이 아닙니다(끝난 작업의 대화가 있어야 합니다)");
    appId = prev.app_id; projectId = prev.project_id; resumeConv = prev.conversation_id; resumeJobId = prev.id;
  } else {
    if (input.app_id !== undefined && input.app_id !== null && input.app_id !== "") {
      const a = String(input.app_id);
      if (!APP_ID_RE.test(a)) throw new HttpError(400, "app_id 형식이 아닙니다");
      if (callerApp && a !== callerApp) throw new HttpError(403, "앱은 제 앱 폴더에서만 작업을 시킬 수 있습니다");
      appId = a;
    }
    if (input.project_id !== undefined && input.project_id !== null && input.project_id !== "") {
      const n = Number(input.project_id);
      if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, "project_id 형식이 아닙니다");
      projectId = n;
    }
    if (!appId && projectId == null) throw new HttpError(400, "작업 폴더가 필요합니다 — project_id 나 app_id 를 주세요");
  }
  //  폴더 판정 — 사람 세션과 같은 자. 앱 폴더는 그 앱을 지금 쓸 수 있는 사람만(앱 화면 다리를 지난 요청도 한 번 더 본다).
  if (appId) await d.assertAppUsable(user, appId);
  if (projectId != null) await d.assertProjectCwd(user, projectId);
  const cwd = projectId != null ? projectFolderCwd(projectId) : appFolderCwd(appId!);

  const row = await enqueueAgentJob({
    requester: me, accountKind: "subscription", accountMember: me,
    appId, projectId, cwd, harness: "claude", model, label, prompt,
    resumeConversation: resumeConv, resumeJobId,
    timeoutSec: timeoutSecOf(input.timeout_min, p),
    homeless: false,   // 사람이 보낸 작업은 그 사람의 자리(홈)에서 돈다
    sharedSeat: false, // 이 길은 본인 구독뿐이다(#5081 공용 시트는 앱 AI 실행 — ai-runs — 으로만 생긴다)
  }, p, d);
  //  접수 응답에 지시를 되싣지 않는다(보낸 쪽이 이미 안다 · 앱 화면 응답이 커지지 않게).
  return publicJob(row, { own: true, position: await d.store.queuePosition(row.id).catch(() => null) });
}

/**
 * 접수의 공통 꼬리 — 행을 넣고(대기열이 차면 429) 자리가 있으면 곧바로 띄운다. 입력 검증 · 누가 보낼 수 있나는 부르는 쪽이 끝냈다.
 *  #4488 앱 AI 실행(ai-runs/service)이 실행 계정을 정해 여기로 온다 — API 키 실행(account_kind 'api_key')은 이 길로만 생긴다(사람 도구 agent_job_run 은 구독만).
 */
export async function enqueueAgentJob(job: NewAgentJob, p: AgentJobPolicy, d: AgentJobDeps): Promise<AgentJobRow> {
  const put = await d.store.insertAgentJob(job, p);
  if ("full" in put) {
    throw new HttpError(429, `작업 대기열이 찼습니다(대기 ${put.full.queued}건 · 실행 ${put.full.running}건) — 잠시 뒤 다시 보내 주세요`);
  }
  logger.info({ job: put.row.id, requester: job.requester, app: job.appId, project: job.projectId, account: job.accountKind }, "[agent-job] 접수");
  //  자리가 있으면 곧바로 띄운다 — 응답을 붙잡지 않게 뒤로 미룬다(같은 테넌트 맥락으로).
  d.later(() => dispatchAgentJobs(d), 0);
  return put.row;
}

/**
 * 누가 보낼 수 있나 — 머리말 «누가 보낼 수 있나». 작업은 보낸 사람의 구독으로 돌므로 «그 사람이 보낸 것» 만 받는다.
 *  · 앱 서버 대리(앱 서버 토큰 + 사람 신원 — 앱 화면 다리를 거쳐 와도 표식이 남는다): 거절 — 앱 서버의 실행은 API 키 갈래(v2-9).
 *  · 앱 주체인데 앱 화면(`app-ui` · `app-front`)이 아닌 길(앱 세션 토큰의 MCP·REST 직접 호출): 거절.
 *  · 작업 AI 자신의 토큰: 거절 — 작업이 작업을 낳으면 사람 없이 구독이 끝없이 돈다.
 */
async function assertMaySubmit(user: LivelyUser, via: { source?: string }, d: AgentJobDeps): Promise<void> {
  if (user.appServer) throw new HttpError(403, "앱 서버는 사람의 구독으로 작업을 보낼 수 없습니다 — 사람이 앱 화면에서 보낸 작업만 그 사람의 구독으로 돕니다");
  if (user.appId && !isAppScreenSource(via.source)) {
    throw new HttpError(403, "앱 토큰으로는 작업을 보낼 수 없습니다 — 사람이 앱 화면에서 보낸 작업만 그 사람의 구독으로 돕니다");
  }
  if (user.tokenHashPrefix && (await d.store.isAgentJobToken(user.tokenHashPrefix))) throw new HttpError(403, "작업 안에서는 새 작업을 보낼 수 없습니다");
}

// ── 자리 주기 · 띄우기 ─────────────────────────────────────────────────────────

const isTransient = (e: unknown): boolean => !!e && typeof e === "object" && (e as { transient?: unknown }).transient === true;

/**
 * 자리가 있는 만큼 대기 작업을 띄운다.
 *  · 앱 작업은 띄우기 직전에 앱 사용을 다시 본다 — 접수 뒤(대기 최대 30분) 동의를 거두거나 앱이 꺼졌으면 그 앱 폴더에서 돌지 않는다
 *    (세션 쪽 앱 폴더 판정 apps/session-app-folders.folderAppsFor 와 같은 자리).
 *  · 일시 실패는 대기열로 되돌리고 이번 배차를 멈춘다(시도 MAX_LAUNCH_ATTEMPTS 번까지) · 그 밖의 실패와 시도를 다 쓴 실패는 그 작업을
 *    실패로 끝내고 걷은 뒤 다음 작업을 띄운다.
 */
export async function dispatchAgentJobs(d: AgentJobDeps): Promise<number> {
  if (!(await d.available())) return 0;
  const p = await d.policy();
  const sharedSeats = d.sharedSeats ? await d.sharedSeats().catch((e) => {
    logger.warn({ err: (e as Error)?.message }, "[agent-job] 공용 시트 목록을 못 읽었다 — 이번 배차는 시트 계정 하나로 센다");
    return new Set<string>();
  }) : new Set<string>();
  const claimed = await d.store.claimAgentJobs(p, (id) => ({ sessionId: jobSessionId(id, d.hex8()), boot: d.store.newJobSecret() }),
    { retryGapSec: LAUNCH_RETRY_GAP_SEC, sharedSeats });
  for (const { row, bootSecret } of claimed) {
    logger.info({ job: row.id, session: row.session_id }, "[agent-job] 자리 받음 — 컨테이너를 띄운다");
    d.later(async () => {
      try {
        //  «안 된다»(HttpError)는 그 작업의 끝이고, 판정을 못 한 것(DB 가 잠깐 막힘)은 일시다 — 되돌려 다시 본다.
        await d.assertJobAllowed(row).catch((e) => {
          throw e instanceof HttpError ? e : Object.assign(new Error(`돌려도 되는지 판정하지 못했습니다: ${(e as Error)?.message ?? e}`), { transient: true });
        });
        await d.launch(row, bootSecret);
      } catch (e) {
        let why = String((e as Error)?.message ?? e).slice(0, 600);
        if (isTransient(e)) {
          const back = await d.store.requeueAgentJob(row.id, `띄우기 실패 — 다시 기다립니다: ${why}`.slice(0, 600), MAX_LAUNCH_ATTEMPTS);
          //  반쯤 만든 자리가 있으면 걷는다(없으면 «이미 없다» 확답이라 조용하다). 되돌리면 세션 id 가 지워져 다시 걷을 길이 없으니,
          //   못 걷으면 크게 남긴다(브로커 안전망 — 닻 없음 — 이 마저 걷는다).
          if (row.session_id) {
            const sid = row.session_id;
            await d.kill(sid).catch((ke) => logger.warn({ job: row.id, session: sid, err: (ke as Error)?.message }, "[agent-job] 반쯤 만든 작업 컨테이너를 못 걷었다 — 브로커 안전망에 맡긴다"));
          }
          if (back) { logger.warn({ job: row.id, attempt: row.attempts, err: why }, "[agent-job] 띄우기 일시 실패 — 대기열로 되돌렸다(다음 감시가 다시 띄운다)"); return; }
          if (row.attempts >= MAX_LAUNCH_ATTEMPTS) why = `띄우기를 ${row.attempts}번 시도했지만 실패했습니다: ${why}`.slice(0, 600);
        }
        logger.warn({ job: row.id, err: why }, "[agent-job] 띄우기 실패");
        const ended = await d.store.finishAgentJob(row.id, { status: "failed", error: why, from: ["starting"] });
        if (ended) await reapJob(ended, d);
        d.later(() => dispatchAgentJobs(d), 0);
      }
    }, 0);
  }
  return claimed.length;
}

// ── 판의 콜백(사용자 인증이 아니다 — 작업별 비밀) ──────────────────────────────────

/**
 * 판의 콜백 인증 — 대조에 필요한 칸만 읽는다(비밀을 모르는 요청에 프롬프트·결과를 읽지 않는다).
 *  비밀이 맞지 않으면(없는 작업 포함) 상태와 무관하게 401 — 순차 id 로 «있나 · 끝났나» 를 엿볼 수 없게. 맞는데 끝난 작업이면 410.
 */
async function authed(id: number, presented: string, which: "boot" | "fail" | "secret", d: AgentJobDeps): Promise<AgentJobAuthRow> {
  const row = await d.store.getAgentJobAuth(id);
  const hash = row ? (which === "boot" ? row.boot_hash : which === "fail" ? row.fail_hash : row.secret_hash) : null;
  if (!row || !d.store.secretMatches(hash, presented)) throw new HttpError(401, "작업 비밀이 맞지 않습니다");
  if (isEnded(row.status)) throw new HttpError(410, "끝난 작업입니다");
  return row;
}

/**
 * 판의 첫 말 — 부트 비밀을 한 번 쓰고 버리며 판 본체·프롬프트·인자·콜백 비밀을 준다.
 *  부트 비밀은 자리 줄 때 달리고 첫 말·끝내기가 지운다 — 그래서 두 번째 부트는 인증(401)에서 막힌다. 409 는 두 판이 같은 비밀로 겹쳐 물었을 때뿐이다.
 *  작업 AI 의 라이블리 토큰을 못 만들면 그 작업은 돌리지 않는다 — 앱 작업이면 동의 철회·앱 꺼짐이고, 신원 없이 돌릴 작업은 없다.
 *  ⚠ 부트 비밀을 쓴 뒤 응답이 판에 못 닿으면(5xx·끊김) 판의 재시도는 401 이다 — 판은 그 401 을 실패 보고(onBootFailed)로 알리고, 작업은
 *   «응답이 컨테이너에 닿지 않았다» 로 곧바로 끝난다. 알림마저 못 닿으면 판 없는 «도는 중» 작업은 무응답 상한에 끝난다.
 */
export async function onBoot(id: number, presented: string, d: AgentJobDeps): Promise<RunnerJob> {
  const auth = await authed(id, presented, "boot", d);
  const callback = d.store.newJobSecret();
  const booted = await d.store.bootAgentJob(auth.id, auth.boot_hash!, callback.hash);
  if (!booted) throw new HttpError(409, "이미 시작한 작업입니다");   // 두 판이 겹쳐 물었다 — 먼저 온 쪽만
  let t: { token: string; tokenHash: string } | null = null;
  let why = "실행 계정이 활성 구성원이 아닙니다";
  try { t = await d.mintMcpToken(booted); } catch (e) { why = String((e as Error)?.message ?? e); }
  if (!t) {
    logger.warn({ job: booted.id, err: why }, "[agent-job] 작업 AI 의 라이블리 신원을 못 만들었다 — 돌리지 않는다");
    const ended = await d.store.finishAgentJob(booted.id, { status: "failed", error: `작업 AI 의 신원을 만들지 못했습니다: ${why}`.slice(0, 600), from: ["running"] });
    if (ended) { d.later(() => reapJob(ended, d), 0); d.later(() => dispatchAgentJobs(d), 0); }
    throw new HttpError(410, "작업을 시작하지 못했습니다");
  }
  if (!(await d.store.setAgentJobMcpToken(booted.id, t.tokenHash))) {
    //  그 사이 끝났다(취소 · 감시) — 방금 만든 토큰은 바로 버린다(걷기가 모르는 토큰이 남지 않게).
    await d.revokeToken(t.tokenHash).catch(() => undefined);
    throw new HttpError(410, "끝난 작업입니다");
  }
  //  #4488 — 하네스에 더 줄 env(API 키 실행의 프록시 주소 · 실행 토큰 · 빈 설정 폴더). 못 만들면 그 작업은 돌지 않는다(신원과 같은 규칙).
  //  #5082 — 판이 보는 자리(작업 폴더 · 게이트웨이 주소 · 워크스페이스)도 실행면이 준다. 박스 위 판은 작업 폴더가 박스 위 경로이고 게이트웨이가
  //   그 박스의 루프백 포트다 — MCP 와 LLM 프록시가 둘 다 그 아래다(자리를 먼저 구해 env 에 넘긴다).
  //  #5082 — 앱 판 지시(ai.instructions)도 여기서 구한다. 못 구하면 신원 · env 와 같은 규칙(돌리지 않는다).
  let env: Record<string, string> = {};
  let view: PaneView = { cwd: booted.cwd, gateway: BROKER_GATEWAY, workspace: null };
  let system: string | null = null;
  try {
    if (d.paneView) view = await d.paneView(booted);
    env = d.jobEnv ? await d.jobEnv(booted, { gateway: view.gateway, workspace: view.workspace }) : {};
    system = d.jobSystem ? await d.jobSystem(booted) : null;
  } catch (e) {
    const why = String((e as Error)?.message ?? e);
    logger.warn({ job: booted.id, err: why }, "[agent-job] 판 환경을 못 만들었다 — 돌리지 않는다");
    await d.revokeToken(t.tokenHash).catch(() => undefined);
    const ended = await d.store.finishAgentJob(booted.id, { status: "failed", error: `실행 환경을 만들지 못했습니다: ${why}`.slice(0, 600), from: ["running"] });
    if (ended) { d.later(() => reapJob(ended, d), 0); d.later(() => dispatchAgentJobs(d), 0); }
    throw new HttpError(410, "작업을 시작하지 못했습니다");
  }
  const slug = d.workspaceSlug();
  //  단발(bare)은 MCP 도 싣지 않는다 — 도구 없이 글만.
  const mcp: Record<string, unknown> | null = booted.bare ? null : { mcpServers: { lively: { type: "http", url: `${view.gateway}/mcp`,
    headers: { Authorization: `Bearer ${t.token}`, ...(slug ? { "x-lively-workspace": slug } : {}) } } } };
  logger.info({ job: booted.id, session: booted.session_id, bare: booted.bare, account: booted.account_kind, appInstructions: system ? system.length : 0 }, "[agent-job] 판이 섰다");
  return {
    id: booted.id, secret: callback.secret, code: RUNNER_SOURCE,
    argv: claudeJobArgv({ model: booted.model, resume: booted.resume_conversation, mcp: !booted.bare, bare: booted.bare, system: !!system }),
    prompt: booted.prompt, mcp, env, cwd: view.cwd, ...(system ? { system } : {}),
    timeoutMs: booted.timeout_sec * 1000, tickMs: TICK_MS, tailMax: TAIL_MAX, resultMax: RESULT_TEXT_MAX, stderrMax: STDERR_TAIL_MAX,
  };
}

/**
 * 판의 시작 실패 보고(#4829) — 부트가 게이트웨이의 답을 못 받았거나(401 · 5xx · 끊김) 판 본체가 곧바로 죽었을 때, 그 작업을 그 사유로
 *  곧바로 끝낸다. 종전엔 사유가 컨테이너 tmux 화면에만 남고 컨테이너와 함께 사라졌고, 작업은 시작 상한(180초) · 무응답 상한(90초)이
 *  지나서야 일반 문장으로 끝났다.
 *  비밀 = 부트 비밀과 같은 값(fail_hash — 자리 줄 때 단다 · 부트가 지워도 남는다). 첫 박동이 지운다 — 박동한 판(살아 있다)의 보고는 401,
 *  대조와 끝내기 사이에 첫 박동이 끼면 409.
 *  보고는 작업 AI 와 같은 uid 에서 온다 — 칸마다 거르고(plan.parseBootFailure) · 그 작업 하나만 실패로 끝낼 수 있다(새 권한이 아니다).
 */
export async function onBootFailed(id: number, presented: string, body: unknown, d: AgentJobDeps): Promise<{ ok: true }> {
  const auth = await authed(id, presented, "fail", d);
  const f = parseBootFailure(body);
  const ended = await d.store.failBootAgentJob(auth.id, auth.fail_hash!, bootFailureError(f, auth.status));
  if (!ended) throw new HttpError(409, "판이 이미 돌고 있거나 끝난 작업입니다");   // 박동이 왔다 · 그 사이 감시·결과가 먼저 끝냈다
  logger.warn({ job: ended.id, session: ended.session_id, stage: f.stage, status: f.status, report: f.message }, "[agent-job] 판이 시작하지 못했다고 알렸다");
  d.later(() => reapJob(ended, d), 0);
  d.later(() => dispatchAgentJobs(d), 0);
  return { ok: true };
}

/** 판의 박동 — 진행 꼬리를 싣고 취소 요청을 돌려준다. */
export async function onTick(id: number, presented: string, body: unknown, d: AgentJobDeps): Promise<{ cancel: boolean }> {
  await authed(id, presented, "secret", d);
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const tail = typeof b.tail === "string" ? noNul(b.tail).slice(-TAIL_MAX) : "";
  const r = await d.store.tickAgentJob(id, { tail, conversationId: convIdOf(b.conversation_id) });
  if (!r) throw new HttpError(410, "끝난 작업입니다");
  return r;
}

/** 판의 마지막 보고 — 상태·답을 적고, 조금 뒤 걷고, 다음 대기 작업을 띄운다. */
export async function onResult(id: number, presented: string, body: unknown, d: AgentJobDeps): Promise<{ ok: true; status: string }> {
  await authed(id, presented, "secret", d);
  const rep = parseRunnerReport(body);
  const out = finalOutcome(rep);
  const result = rep.result ? {
    text: rep.result.text, is_error: rep.result.is_error, subtype: rep.result.subtype, num_turns: rep.result.num_turns,
    duration_ms: rep.result.duration_ms, cost_usd: rep.result.cost_usd, usage: rep.result.usage, model: rep.model,
    truncated: (rep.result.text?.length ?? 0) >= RESULT_TEXT_MAX,
  } : null;
  const ended = await d.store.finishAgentJob(id, {
    status: out.status, error: out.error, result, exitCode: rep.exit_code, conversationId: rep.conversation_id, tail: rep.tail, from: ["running"],
  });
  if (!ended) throw new HttpError(410, "끝난 작업입니다");
  logger.info({ job: id, status: out.status }, "[agent-job] 결과");
  d.later(() => reapJob(ended, d), REAP_DELAY_MS);
  d.later(() => dispatchAgentJobs(d), 0);
  return { ok: true, status: out.status };
}

// ── 걷기 · 감시 ────────────────────────────────────────────────────────────────

/** 걷기에 필요한 칸 — 감시는 이것만 읽는다(프롬프트·결과는 안 읽는다). */
export type ReapRow = Pick<AgentJobRow, "id" | "status" | "reaped" | "session_id" | "mcp_token_hash" | "ended_at">;

/**
 * 끝난 작업을 걷는다 — 컨테이너(kill-session) · 작업 토큰. 둘 다 해냈을 때만 «걷음» 으로 적는다. 던지지 않는다(돌려주는 것: 걷음으로 적었나).
 *  · kill 이 실패하면(확답이 아닌 실패 — 중계 시간 초과 · 브로커 오류) 적지 않는다 → 다음 감시가 다시 걷는다. 끝난 지 REAP_GIVE_UP_MS(10분)가
 *    지나도 못 하면 크게 남기고 놓는다(브로커 안전망에 맡긴다) — 영구 실패가 감시 목록을 막아 남의 작업을 굶기지 않게.
 *  · 토큰 폐기는 kill 과 따로 한다 — kill 이 막혀도 작업 AI 의 신원은 바로 끊는다(폐기는 여러 번 해도 같다).
 *  · 세션 id 가 `job-` 꼴이 아니면 kill 을 보내지 않는다(사람 세션에 닿지 않게 — launch.killJobContainer 가 한 번 더 막는다).
 */
export async function reapJob(row: ReapRow, d: AgentJobDeps): Promise<boolean> {
  if (!isEnded(row.status) || row.reaped) return false;
  //  #4488 — 이 작업에 붙은 AI 실행 행을 맞춘다(몇 번 불러도 같다 · 던지지 않는다). 걷기를 붙잡지 않게 뒤로 미룬다 — 형식 재시도 작업 접수까지 달릴 수 있다(격리 리뷰).
  if (d.onJobEnded) { const hook = d.onJobEnded; d.later(() => hook(row).catch(() => undefined), 0); }
  let ok = true;
  if (row.session_id && !JOB_SESSION_ID_RE.test(row.session_id)) {
    logger.error({ job: row.id, session: row.session_id }, "[agent-job] 작업 세션 id 꼴이 아니다 — 컨테이너는 걷지 않는다");
  } else if (row.session_id) {
    try {
      await d.kill(row.session_id);
    } catch (e) {
      const age = row.ended_at ? d.now() - +new Date(row.ended_at) : 0;
      if (age < REAP_GIVE_UP_MS) {
        ok = false;
        logger.warn({ job: row.id, session: row.session_id, err: (e as Error)?.message }, "[agent-job] 걷기 실패 — 다음 감시가 다시 걷는다");
      } else {
        logger.error({ job: row.id, session: row.session_id, err: (e as Error)?.message }, "[agent-job] 걷기를 10분 동안 못 했다 — 놓는다(브로커 안전망에 맡긴다)");
      }
    }
  }
  if (row.mcp_token_hash) {
    try { await d.revokeToken(row.mcp_token_hash); }
    catch (e) { ok = false; logger.warn({ job: row.id, err: (e as Error)?.message }, "[agent-job] 작업 토큰 폐기 실패 — 다음 감시가 다시 한다"); }
  }
  if (!ok) return false;
  try { await d.store.markAgentJobReaped(row.id); return true; }
  catch (e) { logger.warn({ job: row.id, err: (e as Error)?.message }, "[agent-job] 걷음 기록 실패 — 다음 감시가 다시 본다"); return false; }
}

/**
 * 감시 한 판 — 열린 작업을 plan.sweepDecision 으로 재고, 끝난 작업 중 안 걷은 것을 걷고, 자리가 나면 띄운다.
 *  요청에 얹힌 정비(30초 · CP 60초 호출 · 판 자신의 박동)가 부른다 — 사람이 아무도 없어도 돈다.
 */
export async function sweepAgentJobs(d: AgentJobDeps): Promise<{ ended: number; reaped: number; launched: number }> {
  const p = await d.policy();
  let ended = 0, reaped = 0, queued = false;
  const jobs = await d.store.openAgentJobs(SWEEP_SCAN_MAX);
  for (const j of jobs) {
    if (isEnded(j.status)) {
      //  결과를 받은 판이 스스로 빠질 틈(REAP_DELAY)은 감시도 기다린다 — 그 걷기는 결과 보고(onResult)가 그 뒤에 한다. 그 사이 게이트웨이가
      //   내려가 그 걷기를 잃어도 틈이 지난 다음 감시가 걷는다(#4834 — 결과 0.5초 뒤 감시가 먼저 걷던 것).
      if (j.ended_at && d.now() - +new Date(j.ended_at) < REAP_DELAY_MS) continue;
      if (await reapJob(j, d)) reaped++;
      continue;
    }
    if (j.status === "queued") queued = true;
    //  도는 동안 더 돌릴 수 없게 됐으면(동의 철회 · 앱 꺼짐 · 실행 계정 비활성) 멈춘다(대기 작업은 배차 직전에 따로 본다).
    //   판정이 «안 된다»(HttpError)일 때만 — DB 가 잠깐 막힌 것으로 멈추지 않는다(그때는 크게 남기고 다음 감시가 다시 본다).
    //   ⚠ 취소가 이미 걸린 작업은 다시 보지 않고 아래 판정(무응답 · 시간 초과)으로 간다 — 판이 죽었으면 그 판정만이 끝낼 수 있다.
    if ((j.status === "starting" || j.status === "running") && !j.cancel_requested) {
      const stop = await d.assertJobAllowed(j).then(
        () => null,
        (e) => {
          if (e instanceof HttpError) return e.message;
          logger.warn({ job: j.id, err: (e as Error)?.message }, "[agent-job] 돌려도 되는지 판정하지 못했다 — 이번 감시는 그대로 둔다");
          return null;
        });
      if (stop) {
        const reason = stoppedReason(stop);
        logger.info({ job: j.id, app: j.app_id, why: stop }, "[agent-job] 더 돌릴 수 없다 — 작업을 멈춘다");
        const asked = await d.store.requestCancelAgentJob(j.id, reason);
        if (asked?.status === "starting") {
          const row = await d.store.finishAgentJob(j.id, { status: "canceled", error: reason, from: ["starting"] });
          if (row) { ended++; if (await reapJob(row, d)) reaped++; }
        }
        continue;
      }
    }
    //  시계는 작업마다 읽는다 — 앞 작업의 걷기(중계 왕복)가 길어도 뒤 작업을 낡은 «지금» 으로 재지 않게.
    const act = sweepDecision({
      status: j.status, createdAt: +new Date(j.created_at), claimedAt: j.claimed_at ? +new Date(j.claimed_at) : null,
      startedAt: j.started_at ? +new Date(j.started_at) : null, lastTickAt: j.last_tick_at ? +new Date(j.last_tick_at) : null,
      timeoutSec: j.timeout_sec, cancelRequested: j.cancel_requested,
      listeningSince: d.listeningSince(), lastError: j.status === "queued" ? j.error : null,
    }, d.now(), p);
    if (act.act !== "end") continue;
    //  무응답으로 끊을 때는 쓰는 순간 DB 시계로 다시 잰다 — 읽은 뒤 박동이 왔으면(살아 있는 판) 끝내지 않는다.
    const silentSec = j.status === "running" && act.status === "failed" ? p.silent_sec : null;
    const row = await d.store.finishAgentJob(j.id, { status: act.status, error: act.error, from: [j.status], silentSec });
    if (!row) continue;
    ended++;
    logger.info({ job: j.id, session: j.session_id, status: act.status, why: act.error }, "[agent-job] 감시가 끝냈다");
    if (await reapJob(row, d)) reaped++;
  }
  //  자리 주기는 기다리는 작업이 있을 때만 — 작업이 없는 워크스페이스가 30초마다 잠금 트랜잭션을 돌지 않게. 목록이 꽉 찼으면 모르니 돈다.
  const launched = queued || jobs.length >= SWEEP_SCAN_MAX ? await dispatchAgentJobs(d) : 0;
  return { ended, reaped, launched };
}

/**
 * 작업 기록 보존 정리(#4828 앱 v2-29) — 끝났고 걷은 작업 가운데 끝난 지 보존 기간(정책 keep_days · 기본 90일)이 지난 행을 지운다.
 *  0 = 무기한(아무것도 안 지운다). 요청 정비 «job-record-prune»(6시간)이 부른다 — 한 판에 PRUNE_BATCH 행, 꽉 찬 판이 이어지면 PRUNE_ROUNDS_MAX 판까지.
 *  ★ 정책은 캐시(d.policy)를 거치지 않고 DB 에서 바로 읽는다 — 캐시는 읽기가 실패하면 기본값(90일)을 준다. 배차 · 감시엔 무해하지만 지우기는
 *   되돌릴 수 없어, 0(무기한)이나 더 긴 기간을 정해 둔 워크스페이스를 기본값으로 지울 수 있다. 못 읽으면 던진다 — 정비 틀이 «테넌트 스윕
 *   실패(비치명)» 로 남기고 다음 판에 다시 한다(격리 리뷰 · 보안 기본값은 닫힌 쪽).
 */
export async function pruneAgentJobRecords(
  d: Pick<AgentJobDeps, "store">, o: { batch?: number; maxRounds?: number } = {},
): Promise<{ deleted: number; keep_days: number }> {
  const p = resolveAgentJobPolicy(await d.store.agentJobPolicyRow());
  if (!(p.keep_days > 0)) return { deleted: 0, keep_days: p.keep_days };
  const batch = o.batch ?? PRUNE_BATCH, rounds = o.maxRounds ?? PRUNE_ROUNDS_MAX;
  let deleted = 0;
  for (let i = 0; i < rounds; i++) {
    const n = await d.store.pruneAgentJobs(p.keep_days, batch);
    deleted += n;
    if (n < batch) break;
  }
  if (deleted > 0) logger.info({ deleted, keepDays: p.keep_days }, "[agent-job] 보존 기간이 지난 작업 기록을 지웠다");
  return { deleted, keep_days: p.keep_days };
}

// ── 사람·앱이 쓰는 조회·취소 ──────────────────────────────────────────────────

/**
 * 이 사람(이 앱)이 이 작업을 볼 수 있나 — 관리자는 다 · 앱 화면은 제 앱의 제 작업만 · 사람은 제 작업만.
 *  sharedSeat = 공용 시트로 도는 작업인가(#5081) — 그 작업은 시트 계정(구독 주인)의 것이 아니다(ai-runs/service.isOwnRun 과 같은 규칙).
 *   필수다 — 빠뜨린 자리가 기본값(«공용 시트 아님»)으로 남의 작업을 열지 않게.
 */
export function canSeeJob(r: AgentJobRow, user: LivelyUser, sharedSeat: boolean): boolean {
  if (isAdmin(user) && !user.appId) return true;
  const me = memberOf(user);
  //  구독 실행의 주인(account_member)도 본다 — 초대받은 사람이 내 세션에서 보내 내 구독·내 자리로 도는 작업(#4488 · 격리 리뷰). 취소도 같은 판정.
  //  단 이 표면(agent_job_*)에서 own(지시·답·진행 꼬리)은 보낸 사람 기준 그대로 — 주인은 상태·오류만. 지시·답까지 보는 길은 앱 AI 실행(app_ai_run_get · isOwnRun)이다.
  if (r.requester !== me && !(!sharedSeat && r.account_kind === "subscription" && r.account_member === me)) return false;
  if (user.appId && r.app_id !== user.appId) return false;
  return true;
}
/** 이 작업이 공용 시트로 도나(#5081) — 구독 주인 가지만이 판정을 가를 때만 표시를 읽는다(store.agentJobSharedSeat). */
async function sharedSeatJobFor(r: AgentJobRow, user: LivelyUser, d: AgentJobDeps): Promise<boolean> {
  const me = memberOf(user);
  if (r.requester === me || r.account_kind !== "subscription" || r.account_member !== me) return false;
  return d.store.agentJobSharedSeat(r.id);
}

export async function getAgentJobFor(id: number, user: LivelyUser, d: AgentJobDeps): Promise<Record<string, unknown>> {
  const row = Number.isSafeInteger(id) && id > 0 ? await d.store.getAgentJob(id) : null;
  if (!row || !canSeeJob(row, user, await sharedSeatJobFor(row, user, d))) throw new HttpError(404, "없는 작업입니다");
  const position = row.status === "queued" ? await d.store.queuePosition(row.id).catch(() => null) : null;
  return publicJob(row, { own: row.requester === memberOf(user), withPrompt: true, position });
}

export async function listAgentJobsFor(f: { app_id?: unknown; status?: unknown; limit?: unknown }, user: LivelyUser, d: AgentJobDeps): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Number(f.limit) || 20, 1), 100);
  const status = typeof f.status === "string" && /^[a-z]{4,10}$/.test(f.status) ? f.status : null;
  const admin = isAdmin(user) && !user.appId;
  const appId = user.appId ? user.appId : (typeof f.app_id === "string" && APP_ID_RE.test(f.app_id) ? f.app_id : null);
  const rows = await d.store.listAgentJobs({ requester: admin ? null : memberOf(user), appId, status, limit });
  const me = memberOf(user);
  return { jobs: rows.map((r) => publicJobSummary(r, { own: r.requester === me })), limit };
}

/** 취소 — 대기 중이면 바로 끝내고, 띄우는 중이면 끝내고 걷고, 도는 중이면 판의 다음 박동이 받아 하네스를 끊는다. */
export async function cancelAgentJobFor(id: number, user: LivelyUser, d: AgentJobDeps): Promise<Record<string, unknown>> {
  const row = Number.isSafeInteger(id) && id > 0 ? await d.store.getAgentJob(id) : null;
  if (!row || !canSeeJob(row, user, await sharedSeatJobFor(row, user, d))) throw new HttpError(404, "없는 작업입니다");
  const own = row.requester === memberOf(user);
  if (isEnded(row.status)) return publicJob(row, { own });
  const asked = await d.store.requestCancelAgentJob(id);
  if (!asked) return publicJob((await d.store.getAgentJob(id)) ?? row, { own });
  if (asked.status === "queued" || asked.status === "starting") {
    const ended = await d.store.finishAgentJob(id, { status: "canceled", error: "취소했습니다", from: [asked.status] });
    if (ended) { await reapJob(ended, d); d.later(() => dispatchAgentJobs(d), 0); return publicJob(ended, { own }); }
  }
  return publicJob((await d.store.getAgentJob(id)) ?? asked, { own });
}
