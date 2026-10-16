// 작업 컨테이너 — 흐름 (#4490 앱 v2-11 · #3994 1단계 공동)
//
//  접수(submit) → 자리 주기(dispatch: 워크스페이스 동시 상한·사람당 상한) → 컨테이너 띄우기(launch) → 판 첫 말(boot: 프롬프트·인자·콜백 비밀을 받아 감)
//   → 박동(tick: 진행 꼬리 · 취소 전달) → 결과(result: 상태·답을 적는다) → 걷기(reap: kill-session · 작업 토큰 폐기) → 다음 대기 작업.
//  감시(sweep)가 그 사이 끊긴 것을 끝낸다 — 대기 초과 · 시작 못 함 · 판 말 없음 · 시간 초과 · 걷지 못한 끝난 작업.
//
//  ── 수명 규칙(설계 §12 ⑤-3 «남은 설계» — 이 태스크가 정한다) ──
//  · 끝 = 결과를 **먼저** 적고 → 곧바로 걷는다. 판이 결과를 올리고 스스로 빠지면 tmux 가 끝나 브로커가 걷는다(#4696 — 세션 호스트의 3초
//    목록이 신호). 게이트웨이도 결과를 받은 뒤 kill-session 을 한 번 보낸다(판이 빠지지 못한 경우 · 신호를 앞당김).
//  · 시간 상한은 판이 스스로 지킨다(SIGTERM → 10초 → SIGKILL → 보고). 판이 못 지키면 감시가 상한+2분에 끝내고 걷는다.
//  · 작업 컨테이너는 세션이 아니다 — 사람 목록·복원·회수 규칙(T5)을 타지 않고, 걷기는 이 흐름과 브로커 안전망(닻 없음 5분·장부)이 한다.
//
//  ⚠ 청/녹 두 슬롯이 같은 작업을 볼 수 있다 — 상태 전이는 전부 store 의 «지금 상태가 이것일 때만» 쓰기로 한 번만 넘어간다.
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import type { LivelyUser } from "../context.js";
import type { AgentJobPolicy } from "../org/policies/agent-job-policy.js";
import {
  LABEL_MAX, PROMPT_MAX, RESULT_TEXT_MAX, STDERR_TAIL_MAX, TAIL_MAX, TICK_MS, appFolderCwd, convIdOf, finalOutcome, isEnded,
  jobSessionId, parseRunnerReport, projectFolderCwd, sweepDecision, timeoutSecOf, APP_ID_RE, JOB_SESSION_ID_RE,
} from "./plan.js";
import { MODEL_RE, RUNNER_SOURCE, claudeJobArgv, type RunnerJob } from "./runner.js";
import type { AgentJobRow, NewAgentJob } from "./store.js";

type Store = typeof import("./store.js");

export interface AgentJobDeps {
  store: Pick<Store, "insertAgentJob" | "claimAgentJobs" | "getAgentJob" | "bootAgentJob" | "setAgentJobMcpToken" | "tickAgentJob" | "finishAgentJob"
    | "requestCancelAgentJob" | "openAgentJobs" | "markAgentJobReaped" | "listAgentJobs" | "queuePosition" | "newJobSecret" | "secretMatches">;
  policy(): Promise<AgentJobPolicy>;
  /** 작업 컨테이너를 띄울 수 있는 배포인가(매니지드). */
  available(): Promise<boolean>;
  launch(job: AgentJobRow, bootSecret: string): Promise<unknown>;
  kill(sessionId: string): Promise<void>;
  /** 작업 AI 의 라이블리 MCP 토큰 — 앱 작업이면 앱 토큰(구성원 권한 ∩ 앱 동의), 아니면 그 멤버 토큰. 만료 = 작업 상한 + 여유. */
  mintMcpToken(job: AgentJobRow): Promise<{ token: string; tokenHash: string } | null>;
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

/** 앱이 보는 작업 모양 — 비밀·프롬프트 원문은 싣지 않는다(프롬프트는 요청자 본인 조회에만 — getAgentJobFor). */
export function publicJob(r: AgentJobRow, o: { withPrompt?: boolean; position?: number | null } = {}): Record<string, unknown> {
  return {
    id: r.id, status: r.status, label: r.label, app_id: r.app_id, project_id: r.project_id, cwd: r.cwd,
    requester: r.requester, account: r.account_kind === "subscription" ? { kind: "subscription", member: r.account_member } : { kind: r.account_kind },
    harness: r.harness, model: r.model, timeout_sec: r.timeout_sec,
    conversation_id: r.conversation_id, resume_job_id: r.resume_job_id,
    result: r.result, error: r.error, exit_code: r.exit_code, output_tail: r.output_tail,
    cancel_requested: r.cancel_requested,
    created_at: r.created_at, claimed_at: r.claimed_at, started_at: r.started_at, ended_at: r.ended_at,
    ...(o.position != null ? { queue_position: o.position } : {}),
    ...(o.withPrompt ? { prompt: r.prompt } : {}),
  };
}

/**
 * 작업을 받는다. 실행 계정은 **본인 구독**(설계 §12 ④ — 본인이 보낸 일만 본인 구독으로 · 상민님 2026-10-16 «본인 세션과 같은 신뢰»).
 *  작업 폴더: 앱 화면이 보낸 작업(user.appId)은 그 앱 폴더 — project_id 를 주면 그 프로젝트 폴더(앱 폴더는 그 안 .lively/apps/<앱> 에 붙는다).
 *  앱 밖(사람·AI 도구 호출)은 project_id 나 app_id(그 앱에 동의했을 때) 중 하나가 있어야 한다.
 *  이어받기(resume_job_id): 같은 사람(앱이면 같은 앱)의 끝난 작업이고 대화 id 가 있을 때 — 작업 폴더도 그 작업 것을 그대로 쓴다
 *  (하네스 대화 기록은 작업 폴더별로 갈린다).
 */
export async function submitAgentJob(input: SubmitInput, user: LivelyUser, d: AgentJobDeps): Promise<Record<string, unknown>> {
  const me = memberOf(user);
  if (!me) throw new HttpError(401, "인증이 필요합니다");
  if (!(await d.available())) throw new HttpError(501, "작업 컨테이너는 매니지드 워크스페이스에서만 돕니다");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw new HttpError(400, "prompt 가 비었습니다");
  if (prompt.length > PROMPT_MAX) throw new HttpError(400, `prompt 가 너무 깁니다(${PROMPT_MAX.toLocaleString()}자 이하)`);
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, LABEL_MAX) : null;
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

  const job: NewAgentJob = {
    requester: me, accountKind: "subscription", accountMember: me,
    appId, projectId, cwd, harness: "claude", model, label, prompt,
    resumeConversation: resumeConv, resumeJobId,
    timeoutSec: timeoutSecOf(input.timeout_min, p),
  };
  const put = await d.store.insertAgentJob(job, p);
  if ("full" in put) {
    throw new HttpError(429, `작업 대기열이 찼습니다(대기 ${put.full.queued}건 · 실행 ${put.full.running}건) — 잠시 뒤 다시 보내 주세요`);
  }
  logger.info({ job: put.row.id, requester: me, app: appId, project: projectId }, "[agent-job] 접수");
  //  자리가 있으면 곧바로 띄운다 — 응답을 붙잡지 않게 뒤로 미룬다(같은 테넌트 맥락으로).
  d.later(() => dispatchAgentJobs(d), 0);
  return publicJob(put.row, { position: await d.store.queuePosition(put.row.id).catch(() => null) });
}

// ── 자리 주기 · 띄우기 ─────────────────────────────────────────────────────────

/** 자리가 있는 만큼 대기 작업을 띄운다. 띄우기 실패는 그 작업을 실패로 끝내고 걷는다(다른 작업은 계속). */
export async function dispatchAgentJobs(d: AgentJobDeps): Promise<number> {
  if (!(await d.available())) return 0;
  const p = await d.policy();
  const claimed = await d.store.claimAgentJobs(p, (id) => ({ sessionId: jobSessionId(id, d.hex8()), boot: d.store.newJobSecret() }));
  for (const { row, bootSecret } of claimed) {
    logger.info({ job: row.id, session: row.session_id }, "[agent-job] 자리 받음 — 컨테이너를 띄운다");
    d.later(async () => {
      try {
        await d.launch(row, bootSecret);
      } catch (e) {
        const why = (e as Error)?.message ?? String(e);
        logger.warn({ job: row.id, err: why }, "[agent-job] 띄우기 실패");
        const ended = await d.store.finishAgentJob(row.id, { status: "failed", error: why.slice(0, 600), from: ["starting"] });
        if (ended) await reapJob(ended, d);
        d.later(() => dispatchAgentJobs(d), 0);
      }
    }, 0);
  }
  return claimed.length;
}

// ── 판의 콜백(사용자 인증이 아니다 — 작업별 비밀) ──────────────────────────────────

async function authed(id: number, presented: string, which: "boot" | "secret", d: AgentJobDeps): Promise<AgentJobRow> {
  const row = await d.store.getAgentJob(id);
  if (!row) throw new HttpError(404, "없는 작업입니다");
  const hash = which === "boot" ? row.boot_hash : row.secret_hash;
  if (!d.store.secretMatches(hash, presented)) {
    if (isEnded(row.status)) throw new HttpError(410, "끝난 작업입니다");
    throw new HttpError(401, "작업 비밀이 맞지 않습니다");
  }
  if (isEnded(row.status)) throw new HttpError(410, "끝난 작업입니다");
  return row;
}

/** 판의 첫 말 — 부트 비밀을 한 번 쓰고 버리며 판 본체·프롬프트·인자·콜백 비밀을 준다. */
export async function onBoot(id: number, presented: string, d: AgentJobDeps): Promise<RunnerJob> {
  const row = await authed(id, presented, "boot", d);
  if (row.status !== "starting") throw new HttpError(409, "이미 시작한 작업입니다");
  const callback = d.store.newJobSecret();
  const booted = await d.store.bootAgentJob(row.id, row.boot_hash!, callback.hash);
  if (!booted) throw new HttpError(409, "이미 시작한 작업입니다");   // 두 판이 겹쳐 물었다 — 먼저 온 쪽만
  let mcp: Record<string, unknown> | null = null;
  try {
    const t = await d.mintMcpToken(booted);
    if (t) {
      await d.store.setAgentJobMcpToken(booted.id, t.tokenHash);
      const slug = d.workspaceSlug();
      mcp = { mcpServers: { lively: { type: "http", url: "http://127.0.0.1:8080/mcp",
        headers: { Authorization: `Bearer ${t.token}`, ...(slug ? { "x-lively-workspace": slug } : {}) } } } };
    }
  } catch (e) {
    //  토큰을 못 만들면 라이블리 도구 없이 돈다 — 작업 자체(파일·하네스)는 선다. 사유는 남긴다.
    logger.warn({ job: booted.id, err: (e as Error)?.message }, "[agent-job] 작업 AI 의 라이블리 토큰을 못 만들었다 — 도구 없이 돈다");
  }
  logger.info({ job: booted.id, session: booted.session_id }, "[agent-job] 판이 섰다");
  return {
    id: booted.id, secret: callback.secret, code: RUNNER_SOURCE,
    argv: claudeJobArgv({ model: booted.model, resume: booted.resume_conversation, mcp: !!mcp }),
    prompt: booted.prompt, mcp, env: {}, cwd: booted.cwd,
    timeoutMs: booted.timeout_sec * 1000, tickMs: TICK_MS, tailMax: TAIL_MAX, resultMax: RESULT_TEXT_MAX, stderrMax: STDERR_TAIL_MAX,
  };
}

/** 판의 박동 — 진행 꼬리를 싣고 취소 요청을 돌려준다. */
export async function onTick(id: number, presented: string, body: unknown, d: AgentJobDeps): Promise<{ cancel: boolean }> {
  await authed(id, presented, "secret", d);
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const tail = typeof b.tail === "string" ? b.tail.slice(-TAIL_MAX) : "";
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

/** 끝난 작업을 걷는다 — 컨테이너(kill-session 신호) · 작업 토큰. 실패해도 던지지 않는다(감시가 다시 본다). */
export async function reapJob(row: AgentJobRow, d: AgentJobDeps): Promise<void> {
  if (!isEnded(row.status) || row.reaped) return;
  try {
    if (row.session_id && JOB_SESSION_ID_RE.test(row.session_id)) await d.kill(row.session_id);
    if (row.mcp_token_hash) await d.revokeToken(row.mcp_token_hash);
    await d.store.markAgentJobReaped(row.id);
  } catch (e) {
    logger.warn({ job: row.id, err: (e as Error)?.message }, "[agent-job] 걷기 실패 — 다음 감시가 다시 본다");
  }
}

/**
 * 감시 한 판 — 열린 작업을 plan.sweepDecision 으로 재고, 끝난 작업 중 안 걷은 것을 걷고, 자리가 나면 띄운다.
 *  요청에 얹힌 정비(30초 · CP 60초 호출 · 판 자신의 박동)가 부른다 — 사람이 아무도 없어도 돈다.
 */
export async function sweepAgentJobs(d: AgentJobDeps): Promise<{ ended: number; reaped: number; launched: number }> {
  const p = await d.policy();
  const now = d.now();
  let ended = 0, reaped = 0;
  for (const j of await d.store.openAgentJobs()) {
    if (isEnded(j.status)) { await reapJob(j, d); reaped++; continue; }
    const act = sweepDecision({
      status: j.status, createdAt: +new Date(j.created_at), claimedAt: j.claimed_at ? +new Date(j.claimed_at) : null,
      startedAt: j.started_at ? +new Date(j.started_at) : null, lastTickAt: j.last_tick_at ? +new Date(j.last_tick_at) : null,
      timeoutSec: j.timeout_sec, cancelRequested: j.cancel_requested,
    }, now, p);
    if (act.act !== "end") continue;
    const row = await d.store.finishAgentJob(j.id, { status: act.status, error: act.error, from: [j.status] });
    if (!row) continue;
    ended++;
    logger.info({ job: j.id, status: act.status, why: act.error }, "[agent-job] 감시가 끝냈다");
    await reapJob(row, d);
  }
  const launched = await dispatchAgentJobs(d);
  return { ended, reaped, launched };
}

// ── 사람·앱이 쓰는 조회·취소 ──────────────────────────────────────────────────

/** 이 사람(이 앱)이 이 작업을 볼 수 있나 — 관리자는 다 · 앱 화면은 제 앱의 제 작업만 · 사람은 제 작업만. */
export function canSeeJob(r: AgentJobRow, user: LivelyUser): boolean {
  if (isAdmin(user) && !user.appId) return true;
  if (r.requester !== memberOf(user)) return false;
  if (user.appId && r.app_id !== user.appId) return false;
  return true;
}

export async function getAgentJobFor(id: number, user: LivelyUser, d: AgentJobDeps): Promise<Record<string, unknown>> {
  const row = Number.isSafeInteger(id) && id > 0 ? await d.store.getAgentJob(id) : null;
  if (!row || !canSeeJob(row, user)) throw new HttpError(404, "없는 작업입니다");
  const position = row.status === "queued" ? await d.store.queuePosition(row.id).catch(() => null) : null;
  return publicJob(row, { withPrompt: row.requester === memberOf(user), position });
}

export async function listAgentJobsFor(f: { app_id?: unknown; status?: unknown; limit?: unknown }, user: LivelyUser, d: AgentJobDeps): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Number(f.limit) || 20, 1), 100);
  const status = typeof f.status === "string" && /^[a-z]{4,10}$/.test(f.status) ? f.status : null;
  const admin = isAdmin(user) && !user.appId;
  const appId = user.appId ? user.appId : (typeof f.app_id === "string" && APP_ID_RE.test(f.app_id) ? f.app_id : null);
  const rows = await d.store.listAgentJobs({ requester: admin ? null : memberOf(user), appId, status, limit });
  return { jobs: rows.map((r) => publicJob(r)), limit };
}

/** 취소 — 대기 중이면 바로 끝내고, 띄우는 중이면 끝내고 걷고, 도는 중이면 판의 다음 박동이 받아 하네스를 끊는다. */
export async function cancelAgentJobFor(id: number, user: LivelyUser, d: AgentJobDeps): Promise<Record<string, unknown>> {
  const row = Number.isSafeInteger(id) && id > 0 ? await d.store.getAgentJob(id) : null;
  if (!row || !canSeeJob(row, user)) throw new HttpError(404, "없는 작업입니다");
  if (isEnded(row.status)) return publicJob(row);
  const asked = await d.store.requestCancelAgentJob(id);
  if (!asked) return publicJob((await d.store.getAgentJob(id)) ?? row);
  if (asked.status === "queued" || asked.status === "starting") {
    const ended = await d.store.finishAgentJob(id, { status: "canceled", error: "취소했습니다", from: [asked.status] });
    if (ended) { await reapJob(ended, d); d.later(() => dispatchAgentJobs(d), 0); return publicJob(ended); }
  }
  return publicJob((await d.store.getAgentJob(id)) ?? asked);
}
