// 앱 AI 실행 — 흐름 (#4488 앱 v2-9). 입구 하나 `/_lively/ai/runs`(= 능력 app_ai_run).
//
//  접수(submitRun) → 실행 계정(작업별 > 앱별 > 워크스페이스 기본값 · plan.resolveAccount) → 실행 자리(단발+API 키 = 프록시 · 그 밖 = 작업 컨테이너)
//   → 상한(앱당 빈도 · 사람당 동시 · 워크스페이스 동시 · 앱당 하루 토큰) → 실행 행 → 프록시면 뒤에서 LLM 한 번(runProxy) · 작업이면 작업 컨테이너 접수
//   → 결과 형식 판정(스키마 — 어긋나면 «형식에 맞게 다시» 1회) → 끝.
//  작업 컨테이너에 붙은 실행은 그 작업 행의 상태를 따라간다(syncRun — 작업이 끝나면 걷기(agent-jobs reapJob)가 알리고, 정비(sweepAiRuns)와 읽기(getRun)도 맞춘다).
//
//  누가 보내나: 앱 화면(app-ui · app-front — runAppTool 의 같은 판정) · 앱 서버(앱 서버 토큰 + 사람 신원 — 능력 REST) · 사람(도구 호출 · app_id 지정).
//   구독 실행은 그 구성원 본인이 앱 화면에서 보낸 것만(plan.subscriptionRefusal). API 키 에이전트 작업은 사람이 보낸 것만 — 앱 서버가 보낸 에이전트 작업은
//   «홈 없는 작업 컨테이너»(후속)가 생길 때까지 501(이 코어의 작업 컨테이너는 실행 계정 구성원의 홈을 붙인다 · launch.ts 머리말).
//  관리자는 남의 실행의 상태·오류만 본다(지시·답은 보낸 사람 것 — 작업 컨테이너와 같은 규칙).
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import type { LivelyUser } from "../context.js";
import type { OrgApp } from "../org/store/apps.js";
import type { AiRunPolicy } from "../org/policies/ai-run-policy.js";
import type { AgentJobRow } from "../agent-jobs/store.js";
import { RateWindow } from "../apps/app-chat-send.js";
import {
  DEFAULT_MODEL, JOB_NAME_RE, LABEL_MAX, MODEL_RE, PROMPT_MAX, SYSTEM_MAX, executorFor, isEndedRun, judgeOutput, overDailyBudget,
  resolveAccount, retryInstruction, runKindOf, runStatusOfJob, schemaInputError, schemaInstruction, subscriptionRefusal, waitSecOf,
  type AiAccount, type AiAccountSettings, type RunKind,
} from "./plan.js";
import type { SingleShotInput, SingleShotOutput, Usage } from "./anthropic.js";
import type { AiRunRow, AiRunSummaryRow, NewAiRun } from "./store.js";

type Store = typeof import("./store.js");

export interface SubmitJobInput {
  requester: string; accountKind: "api_key" | "subscription"; accountMember: string | null; appId: string; projectId: number | null;
  model: string | null; label: string | null; prompt: string; timeoutMin: number | null; bare: boolean; resumeJobId: number | null;
}

export interface AiRunDeps {
  store: Pick<Store, "insertAiRun" | "getAiRun" | "getAiRunByToken" | "getAiRunByJob" | "setAiRunJob" | "setAiRunProxyToken" | "markAiRunRunning" | "retryAiRun"
    | "finishAiRun" | "openJobRuns" | "staleProxyRuns" | "openRunCountOf" | "listAiRuns" | "appConversations" | "insertLlmCall" | "tokensUsedTodayByApp">;
  policy(): Promise<AiRunPolicy>;
  accountSettings(): Promise<AiAccountSettings>;
  /** 워크스페이스 Anthropic API 키(org_credential anthropic_api_key) — 없으면 null. 값은 LLM 호출 헤더에만 쓴다. */
  apiKey(): Promise<string | null>;
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
  isAdmin(user: LivelyUser): boolean;
}

export const ACCOUNT_UNAVAILABLE = "account_unavailable";
export const PROXY_TOKEN_PREFIX = "lvai_";
/** 작업 컨테이너 안에서 우리 프록시로 가는 주소(세션 루프백 → 게이트웨이) — Claude Code 의 ANTHROPIC_BASE_URL. */
export const PROXY_BASE_IN_CONTAINER = "http://127.0.0.1:8080/api/llm/anthropic";
/** 판이 빈 설정 폴더를 만들어 바꿔 넣는 자리표(agent-jobs/runner.ts) — 멤버 홈의 Claude 로그인을 읽지 않게. */
export const CONFIG_DIR_PLACEHOLDER = "{{LVLY_CONFIG_DIR}}";
/** 프록시 토큰 수명 여유 — 작업 상한 뒤에도 결과 보고가 끝날 때까지. */
export const PROXY_TOKEN_SLACK_SEC = 15 * 60;

const memberOf = (u: LivelyUser | undefined): string => String(u?.userId || "");

export interface SubmitInput {
  app_id?: unknown; prompt?: unknown; system?: unknown; schema?: unknown; job?: unknown; model?: unknown; label?: unknown;
  files?: unknown; project_id?: unknown; cwd?: unknown; agent?: unknown; timeout_min?: unknown; max_tokens?: unknown; wait?: unknown;
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
/** 앱이 보는 실행 — 답·지시는 보낸 사람(own)에게만. */
export function publicRun(r: AiRunRow, o: { own: boolean; withPrompt?: boolean }): Record<string, unknown> {
  return {
    ...head(r),
    ...(o.own ? { result: r.result, session_note: r.session_note } : { has_result: r.result !== null }),
    ...(o.own && o.withPrompt ? { prompt: r.prompt, system: r.system_prompt, schema: r.schema } : {}),
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
 * 실행을 받는다 — 순서: 신원 → 앱(동의) → 입력(400) → 작업 이름(400) → 실행 계정(409 account_unavailable · 403 구독 거절) → 자리(501) → 상한(429) → 행 → 띄움.
 *  `wait` 초를 주면 끝날 때까지(상한 WAIT_MAX_SEC) 기다렸다 답한다 — 단발은 보통 몇 초라 앱이 한 번에 받는다.
 */
export async function submitRun(input: SubmitInput, user: LivelyUser, ctx: { source?: string }, d: AiRunDeps): Promise<Record<string, unknown>> {
  const who = requesterOf(user);
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
  let jobName: string | null = null;
  if (input.job !== undefined && input.job !== null && input.job !== "") {
    jobName = String(input.job).trim();
    if (!JOB_NAME_RE.test(jobName)) throw new HttpError(400, "job(작업 이름) 형식이 아닙니다 — 소문자·숫자·_·- 1~64자");
    const declared = declaredAiJobs(app);
    if (declared.length && !declared.some((j) => j.name === jobName)) {
      throw new HttpError(400, `작업 '${jobName}' 은 이 앱 매니페스트(ai.jobs)에 없습니다 — 선언한 것: ${declared.map((j) => j.name).join(", ")}`);
    }
  }
  const kind: RunKind = runKindOf(input);
  let projectId: number | null = null;
  if (input.project_id !== undefined && input.project_id !== null && input.project_id !== "") {
    const n = Number(input.project_id);
    if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, "project_id 형식이 아닙니다");
    projectId = n;
  }
  if (typeof input.cwd === "string" && input.cwd.trim()) throw new HttpError(400, "cwd 는 아직 받지 않습니다 — 앱 폴더(기본) 또는 project_id 를 쓰세요");

  // 실행 계정 — 작업별 > 앱별 > 워크스페이스 기본값 > (있으면) API 키.
  const [settings, key] = await Promise.all([d.accountSettings(), d.apiKey()]);
  const picked = resolveAccount(settings, appId, jobName, !!key);
  if (!picked) {
    throw new HttpError(409, "실행 계정이 없습니다 — 관리자가 워크스페이스 API 키(org_credential_set kind=anthropic_api_key)를 등록하거나, 구성원이 자기 구독을 기본 실행 계정으로 걸어야 합니다(app_ai_account_set)",
      { body: { code: ACCOUNT_UNAVAILABLE } });
  }
  const account = picked.account;
  const refusal = subscriptionRefusal(account, who, ctx.source);
  if (refusal) throw new HttpError(403, refusal, { body: { code: ACCOUNT_UNAVAILABLE } });
  if (account.kind === "api_key" && !key) throw new HttpError(409, "이 앱의 실행 계정은 워크스페이스 API 키인데 등록된 키가 없습니다", { body: { code: ACCOUNT_UNAVAILABLE } });
  const executor = executorFor(kind, account);
  if (executor === "job" && who.kind === "app_server") {
    throw new HttpError(501, "앱 서버가 보낸 에이전트 작업(파일 · 도구)은 아직 자리가 없습니다 — 단발(텍스트 · 결과 스키마)만 보내거나, 앱 화면에서 사람이 보내게 하세요");
  }

  // 상한 — 앱당 빈도 · 사람당 동시 · (프록시) 워크스페이스 동시 · (API 키) 앱당 하루 토큰.
  const p = await d.policy();
  const tenant = d.tenant();
  if (!d.rate.take(`${tenant}\0${appId}`, d.now())) throw new HttpError(429, `이 앱이 AI 실행을 너무 자주 보내고 있습니다(분당 ${p.app_per_minute}회) — 요청을 모아 한 번에 보내세요`);
  if ((await d.store.openRunCountOf(who.member)) >= p.max_running_per_member) {
    throw new HttpError(429, `${who.member}님의 AI 실행이 이미 ${p.max_running_per_member}개 돌고 있습니다 — 끝난 뒤 다시 보내세요`);
  }
  if (account.kind === "api_key" && overDailyBudget(await d.store.tokensUsedTodayByApp(appId), p.daily_tokens_per_app)) {
    throw new HttpError(429, `이 앱의 오늘 토큰 상한(${p.daily_tokens_per_app.toLocaleString()})을 다 썼습니다 — 내일 다시, 또는 관리자가 상한을 올립니다(app_ai_limits_set)`);
  }
  if (executor === "proxy" && d.inflight.count(tenant) >= p.max_inflight) {
    throw new HttpError(429, `이 워크스페이스의 AI 호출이 동시에 ${p.max_inflight}개 돌고 있습니다 — 잠시 뒤 다시 보내세요`);
  }

  const n: NewAiRun = {
    appId, requester: who.member, requesterKind: who.kind, source: ctx.source ?? null, jobName, kind,
    accountKind: account.kind, accountMember: account.kind === "subscription" ? account.member : null, executor,
    model: model ?? (executor === "proxy" ? settings.default_model ?? DEFAULT_MODEL : null), label, prompt, systemPrompt: system, schema,
    status: executor === "proxy" ? "running" : "queued",
  };
  const row = await d.store.insertAiRun(n);
  logger.info({ run: row.id, app: appId, requester: who.member, kind, account: account.kind, executor }, "[ai-run] 접수");

  if (executor === "proxy") {
    d.later(() => runProxy(row, p, d), 0);
  } else {
    try {
      const job = await d.submitJob({
        requester: who.member, accountKind: account.kind, accountMember: n.accountMember, appId, projectId, model, label: label ?? `AI 실행 #${row.id}`,
        prompt: jobPrompt(row, input.files), timeoutMin: typeof input.timeout_min === "number" ? input.timeout_min : null, bare: kind === "single", resumeJobId: null,
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
  return publicRun(latest ?? row, { own: true });
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

/** 작업 컨테이너에 보내는 프롬프트 — 시스템 지시 · 관련 파일 · 형식 지시를 한 글로(하네스는 stdin 프롬프트 하나). */
export function jobPrompt(row: Pick<AiRunRow, "prompt" | "system_prompt" | "schema">, files: unknown): string {
  const parts: string[] = [];
  if (row.system_prompt) parts.push(`[시스템 지시]\n${row.system_prompt}\n`);
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

export async function runProxy(row: AiRunRow, p: AiRunPolicy, d: AiRunDeps): Promise<void> {
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
  const total: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  const add = (u: Usage): void => { total.input_tokens += u.input_tokens; total.output_tokens += u.output_tokens; total.cache_read_tokens += u.cache_read_tokens; total.cache_write_tokens += u.cache_write_tokens; };
  const model = row.model ?? DEFAULT_MODEL;
  const maxTokens = p.max_output_tokens;
  const prompt = row.prompt + (row.schema ? schemaInstruction(row.schema) : "");
  const call = async (i: SingleShotInput): Promise<SingleShotOutput> => {
    const t0 = d.now();
    let out: SingleShotOutput;
    try { out = await d.singleShot(key, i, ac.signal); }
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
    let out = await call({ model, prompt, system: row.system_prompt, maxTokens });
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
        messages: [{ role: "user", content: prompt }, { role: "assistant", content: out.text || "(빈 답)" }, { role: "user", content: retryInstruction(judged.errors, row.schema) }],
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
  if (run.retries === 0 && run.schema && job.conversation_id) {
    try {
      const retry = await d.submitJob({
        requester: run.requester, accountKind: run.account_kind, accountMember: run.account_member, appId: run.app_id, projectId: job.project_id,
        model: job.model, label: `${run.label ?? `AI 실행 #${run.id}`} (형식 다시)`, prompt: retryInstruction(judged.errors, run.schema),
        timeoutMin: Math.max(1, Math.round(job.timeout_sec / 60)), bare: run.kind === "single", resumeJobId: job.id,
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
 */
export async function bootEnvForJob(job: Pick<AgentJobRow, "id" | "account_kind">, d: AiRunDeps): Promise<Record<string, string>> {
  if (job.account_kind !== "api_key") return {};
  const run = await d.store.getAiRunByJob(job.id);
  if (!run) throw new HttpError(409, "API 키 작업에 붙은 실행 행이 없습니다");
  const t = d.newProxyToken();
  await d.store.setAiRunProxyToken(run.id, t.hash);
  return {
    ANTHROPIC_BASE_URL: PROXY_BASE_IN_CONTAINER,
    ANTHROPIC_AUTH_TOKEN: t.token,
    ANTHROPIC_API_KEY: "",
    CLAUDE_CONFIG_DIR: CONFIG_DIR_PLACEHOLDER,
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

// ── 조회 · 취소 · 대상 ──
export function canSeeRun(r: AiRunRow, user: LivelyUser, d: AiRunDeps): boolean {
  if (d.isAdmin(user) && !user.appId) return true;
  if (r.requester !== memberOf(user)) return false;
  if (user.appId && r.app_id !== user.appId) return false;
  return true;
}

export async function getRunFor(id: number, user: LivelyUser, d: AiRunDeps): Promise<Record<string, unknown>> {
  let row = Number.isSafeInteger(id) && id > 0 ? await d.store.getAiRun(id) : null;
  if (!row || !canSeeRun(row, user, d)) throw new HttpError(404, "없는 실행입니다");
  if (row.executor === "job" && !isEndedRun(row.status)) row = (await syncRun(row, d)) ?? row;
  return publicRun(row, { own: row.requester === memberOf(user), withPrompt: true });
}

export async function listRunsFor(f: { app_id?: unknown; status?: unknown; limit?: unknown }, user: LivelyUser, d: AiRunDeps): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Number(f.limit) || 20, 1), 100);
  const status = typeof f.status === "string" && /^[a-z]{4,10}$/.test(f.status) ? f.status : null;
  const admin = d.isAdmin(user) && !user.appId;
  const appId = user.appId ? user.appId : (typeof f.app_id === "string" && f.app_id ? f.app_id : null);
  const me = memberOf(user);
  const rows = await d.store.listAiRuns({ appId, requester: admin ? null : me, status, limit });
  return { runs: rows.map((r) => publicRunSummary(r, { own: r.requester === me })), limit };
}

export async function cancelRunFor(id: number, user: LivelyUser, d: AiRunDeps): Promise<Record<string, unknown>> {
  const row = Number.isSafeInteger(id) && id > 0 ? await d.store.getAiRun(id) : null;
  if (!row || !canSeeRun(row, user, d)) throw new HttpError(404, "없는 실행입니다");
  const own = row.requester === memberOf(user);
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
export async function targetsFor(user: LivelyUser, input: { app_id?: unknown }, d: AiRunDeps): Promise<Record<string, unknown>> {
  const who = requesterOf(user);
  const appId = typeof user.appId === "string" && user.appId ? user.appId : (typeof input.app_id === "string" ? input.app_id.trim() : "");
  if (!appId) throw new HttpError(400, "app_id 가 필요합니다");
  if (!user.appId) await d.assertAppUsable(user, appId);
  const app = await d.getApp(appId);
  const [settings, key] = await Promise.all([d.accountSettings(), d.apiKey()]);
  const describe = async (a: AiAccount | null, from: string | null): Promise<Record<string, unknown>> => {
    if (!a) return { kind: null, available: false, reason: "실행 계정이 없습니다 — 워크스페이스 API 키 또는 구독을 설정하세요", from };
    if (a.kind === "api_key") return { kind: "api_key", available: !!key, reason: key ? null : "워크스페이스 API 키가 등록되지 않았습니다", from };
    const refusal = subscriptionRefusal(a, who, "app-ui");
    const loggedIn = refusal ? null : await d.subscriptionLoggedIn(a.member).catch(() => null);
    return { kind: "subscription", member: a.member, available: !refusal && loggedIn !== false, logged_in: loggedIn, reason: refusal ?? (loggedIn === false ? "AI 연결 필요 — 그 구성원이 Claude 에 로그인해야 합니다" : null), from };
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
