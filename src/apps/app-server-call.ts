// 게이트웨이 → 앱 서버 동기 부르기 — 흐름(#5053 앱 v2-42). 판정은 app-server-call-plan.ts · 행은 app-server-call-store.ts · 함수 안 쪽은 app-server-guard.ts(검사 층 5 판).
//
//  입구: 앱이 선언한 MCP 도구의 server 실행기(app-mcp-server-executor) — 틀(mcp/app-declared-tools)이 동의 · 구성원 · 인자를 확인한 뒤 부른다.
//   게이트웨이가 그 앱의 함수를 흘려 받기로 부르고(사람 요청과 같은 길 — app-front-server serveAppServer), 함수 안 검사 층이 앱 코드보다 먼저
//   «이 부르기 시작»(onCallClaim)을 확인받은 뒤 앱 라우트로 넘긴다. 답은 흘려 받아 모은다(본문 앞 maxBytes 까지 · 전체 크기는 센다).
//  자리: 그 사람이 보는 판 — 초안을 고친 사람 = 별칭 cur, 나머지 = 공개 판이면 pub(사람 요청 · 작업과 같은 규칙). 부를 때의 별칭을 그대로 부른다.
//  신원: 부른 사람 ∩ 그 사람의 앱 동의 ∩ 부른 연결(토큰)의 권한 — 부르기가 도는 동안만(resolveCallRunPrincipal · 백그라운드 작업의 돌기 신원과 같은 판정).
//  상한: 사람 요청 시간(app_server_policy.timeout_s — 검사 층이 끊는다) · 처리 중 상한(사람 요청과 같은 자리) · 호출 세기(자동 멈춤 감시가 본다).
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import type { LivelyUser } from "../context.js";
import { getApp, getActiveGrant } from "../org/store/apps.js";
import { getMember } from "../org/store/members.js";
import { workspaceAccessAllowed } from "../org/tenancy/gate.js";
import { isScope } from "../auth/scopes.js";
import { tenantSlug } from "../terminal/catalog.js";
import { AwsError } from "../net/aws/aws-json.js";
import { parseReport } from "../net/aws/lambda-lite.js";
import { canSeeApp } from "./visibility.js";
import { appDomain, appHost } from "./app-address.js";
import { appServerEnv, type AppServerEnv } from "./app-server-config.js";
import { appServerApi, type LambdaApi } from "./app-server-host.js";
import { startHttpStream, lambdaErrorOf, type Complete } from "./app-server-stream.js";
import { acquireInflight, recordAppServerCall } from "./app-server-usage.js";
import * as st from "./app-server-store.js";
import type { AppServerPolicy } from "./app-server-policy.js";
import { jobCallerOf, liveAppJobDeps, startAppJob, MCP_TOOL_JOB_SOURCE, type AppJobDeps, type JobCaller } from "./app-jobs.js";
import { getAppJob, jobSecretMatches, newJobSecret } from "./app-jobs-store.js";
import { JOB_GUARD_MIN, isJobEnded } from "./app-jobs-plan.js";
import * as cs from "./app-server-call-store.js";
import {
  BG_PROGRESS_SEC, BG_WAIT_QUIET_SEC, BG_WAIT_SEC, CALL_BODY_MAX, CALL_GUARD_MIN, CALL_KEEP_DAYS, CALL_RUN_GRACE_SEC, callCredential, callInvokeEvent, jobToolReplyOf, parseCallCredential,
  type ServerCallReply, type ToolReply,
} from "./app-server-call-plan.js";

/** 시험이 바꿔 끼우는 자리 — 앱 서버 설정 · 함수 실행면 · 서버 줄 · 상한 · 앱 도메인 · 슬러그 · 시계 · 호출 셈. */
export interface ServerCallDeps {
  env(): AppServerEnv | null;
  api(env: AppServerEnv): Pick<LambdaApi, "invokeStream">;
  getServerRow(appId: string): Promise<st.ServerRow | null>;
  policy(): Promise<AppServerPolicy>;
  domain(): string | null;
  slug(): string | null;
  now(): number;
  record(appId: string, r: { billedMs?: number | null; error?: boolean; rejected?: boolean }): void;
  /** 30초 넘는 도구(background) — 백그라운드 작업의 의존 · 대신 기다리는 시간(진행 알림을 받는 요청 · 못 받는 요청) · 진행 알림 간격(초). */
  jobDeps(): AppJobDeps;
  bgWaitSec: number;
  bgQuietWaitSec: number;
  bgProgressSec: number;
}
/** 시험이 끼우는 의존(가짜 함수 실행면 · 설정 · 시계) — 운영에서는 비어 있다(app-server-deploy setServerDepsForTest 와 같은 꼴). */
let testDeps: Partial<ServerCallDeps> = {};
export function setServerCallDepsForTest(d: Partial<ServerCallDeps>): void { testDeps = d; }
export function liveServerCallDeps(): ServerCallDeps {
  return {
    env: () => appServerEnv(),
    api: (env) => appServerApi(env),
    getServerRow: (id) => st.getServerRow(id),
    policy: () => st.appServerPolicy(),
    domain: () => appDomain(),
    slug: () => tenantSlug(),
    now: () => Date.now(),
    record: recordAppServerCall,
    jobDeps: () => liveAppJobDeps(),
    bgWaitSec: BG_WAIT_SEC,
    bgQuietWaitSec: BG_WAIT_QUIET_SEC,
    bgProgressSec: BG_PROGRESS_SEC,
    ...testDeps,
  };
}

/** 부르기 한 건 — 틀이 확인한 사실만 받는다(앱의 판 · 도구 선언 · 인자 · 부른 사람). */
export interface ServerCallInput {
  app: { id: string; view: "installed" | "published"; variant: "pub" | "draft" };
  /** 'mcp_tool' — 앱이 선언한 MCP 도구(v2-12 app_call 이 다른 값을 더한다). */
  purpose: "mcp_tool";
  tool: string;
  route: string;
  level: "L0" | "L1";
  /** 인자 JSON 글. */
  body: string;
  caller: { userId: string; name: string; scopes: string[] };
  /** 답 본문을 이만큼(바이트)까지 모은다 — 넘는 것은 읽어 버리고 크기만 센다(흐름은 끝까지 읽는다 · 셈 · 자리를 지키려고). */
  maxBytes: number;
}

const fail = (status: number, code: string, message: string): HttpError => new HttpError(status, message, { body: { code } });
const timeoutText = (s: number): string => `앱 서버가 제때 답하지 않았습니다 — 도구 하나는 ${s}초까지입니다. 더 긴 일은 앱이 백그라운드 작업으로 넘겨야 합니다`;

/**
 * 이 앱 서버를 지금 부를 수 있나 — 꺼짐 · 미배포 · 옛 판(검사 층 minGuard 판 미만 · 함수 토큰 없음) · 멈춤이면 HttpError(body.code). 부를 수 있으면 설정 · 줄 · 별칭.
 *  동기 부르기는 검사 층 5 판(부르기 신원), background 는 4 판(작업 신원)부터.
 */
async function serverTargetOf(app: { id: string; view: "installed" | "published" }, minGuard: number, deps: ServerCallDeps): Promise<{ env: AppServerEnv; row: st.ServerRow; alias: st.AliasName }> {
  const env = deps.env();
  if (!env) throw fail(503, "app_server_off", "이 워크스페이스는 앱 서버 실행이 꺼져 있어 이 도구를 부를 수 없습니다");
  const alias: st.AliasName = app.view === "published" ? "pub" : "cur";
  const row = await deps.getServerRow(app.id);
  const version = alias === "pub" ? row?.pub_lambda_version : row?.cur_lambda_version;
  if (!row || !version) {
    throw fail(503, "app_server_not_deployed", "이 앱의 서버가 아직 올라가지 않았습니다 — 앱을 만든 사람이 「이대로 넣기」 또는 app_server_deploy 로 서버를 올리면 이 도구를 쓸 수 있습니다");
  }
  if (!(alias === "pub" ? row.pub_token_hash : row.cur_token_hash) || ((alias === "pub" ? row.pub_guard : row.cur_guard) ?? 0) < minGuard) {
    throw fail(503, "app_server_outdated", "이 앱의 서버는 AI 도구를 받기 전에 올라간 판입니다 — 앱을 만든 사람이 서버를 다시 올리면(app_server_deploy · 「이대로 넣기」) 이 도구를 쓸 수 있습니다");
  }
  if (row.stopped_at) {
    throw fail(503, "app_server_stopped", `앱 서버가 멈춰 있습니다${row.stop_reason ? `(까닭: ${row.stop_reason})` : ""} — 관리자(손으로 멈췄으면 책임자)가 다시 켜면 이 도구를 쓸 수 있습니다`);
  }
  return { env, row, alias };
}

/**
 * 앱 서버 라우트 하나를 동기로 부르고 답을 모은다. 앱이 답했으면(상태와 무관) 그 답, 못 했으면 HttpError(body.code — 도구 오류 코드):
 *  app_server_off · app_server_not_deployed · app_server_outdated · app_server_stopped · app_server_busy(429) · app_server_throttled · app_server_missing ·
 *  app_server_timeout(504) · app_server_unavailable · app_server_error. 앱에 닿기 전에 막힌 것은 부르기 행도 만들지 않는다.
 */
export async function callAppServerRoute(i: ServerCallInput, deps: ServerCallDeps = liveServerCallDeps()): Promise<{ reply: ServerCallReply; timeoutS: number }> {
  if (Buffer.byteLength(i.body, "utf8") > CALL_BODY_MAX) throw fail(413, "bad_args", `도구 인자가 너무 큽니다(${CALL_BODY_MAX / 1024 / 1024}MB 까지) — 큰 자료는 앱 폴더나 파일 주소에 두고 경로만 넘기세요`);
  const { env, row, alias } = await serverTargetOf(i.app, CALL_GUARD_MIN, deps);
  const policy = await deps.policy();
  const slot = acquireInflight(i.app.id, { workspace: policy.max_inflight_workspace, app: policy.max_inflight_app });
  if (typeof slot !== "function") {
    deps.record(i.app.id, { rejected: true });
    throw fail(429, "app_server_busy", slot.denied === "app"
      ? `이 앱이 동시에 처리하는 요청이 상한(${slot.limit}개)에 닿았습니다 — 잠시 뒤 다시 하세요`
      : `이 워크스페이스의 앱 서버가 동시에 처리하는 요청이 상한(${slot.limit}개)에 닿았습니다 — 잠시 뒤 다시 하세요`);
  }
  const t0 = Date.now();
  let counted = false;
  const count = (r: { billedMs?: number | null; error?: boolean }): void => { if (!counted) { counted = true; deps.record(i.app.id, r); } };
  let callId: number | null = null;
  let ended = false;
  const end = async (e: Parameters<typeof cs.endAppCall>[1]): Promise<void> => {
    if (ended || callId === null) return;
    ended = true;
    await cs.endAppCall(callId, { durationMs: Date.now() - t0, ...e })
      .catch((err) => logger.warn({ err: (err as Error)?.message ?? err, call: callId }, "[app-server-call] 부르기 끝 적기 실패 — 하우스키핑이 닫는다"));
  };
  try {
    const made = await cs.insertAppCall({
      appId: i.app.id, purpose: i.purpose, tool: i.tool, requester: i.caller.userId, requesterName: i.caller.name, variant: i.app.variant, alias,
      functionName: row.function_name, level: i.level, scopes: i.caller.scopes, timeoutS: policy.timeout_s,
    });
    callId = made.row.id;
    const slug = deps.slug() ?? "local";
    const host = appHost(slug, i.app.id, i.app.variant, deps.domain()) ?? `${i.app.id}-${slug}.lively.invalid`;
    const event = callInvokeEvent({ id: made.row.id, route: i.route, body: i.body }, callCredential("call", made.row.id, made.secret), host, deps.now());
    let out;
    try {
      out = await deps.api(env).invokeStream(row.function_name, alias, JSON.stringify(event), { timeoutMs: policy.timeout_s * 1000 + 5_000, logTail: true });
    } catch (e) {
      count({ billedMs: Date.now() - t0, error: true });
      const code = e instanceof AwsError ? e.code : "";
      logger.warn({ app: i.app.id, fn: row.function_name, alias, code, err: (e as Error)?.message }, "[app-server-call] 앱 서버 함수를 부르지 못했다");
      await end({ status: "failed", error: code || "invoke" });
      if (code === "TooManyRequestsException") throw fail(503, "app_server_throttled", "앱 서버가 지금 바쁩니다 — 잠시 뒤 다시 하세요");
      if (code === "ResourceNotFoundException") throw fail(503, "app_server_missing", "앱 서버를 찾지 못했습니다 — 앱을 만든 사람이 서버를 다시 올려야 합니다(app_server_deploy)");
      if (code === "Timeout") throw fail(504, "app_server_timeout", timeoutText(policy.timeout_s));
      throw fail(502, "app_server_unavailable", "앱 서버에 닿지 못했습니다 — 잠시 뒤 다시 하세요");
    }
    const start = await startHttpStream(out);
    if (start.kind === "error") {
      let complete = start.complete;
      if (!complete) for await (const ev of out.events) if (ev.type === "complete") { complete = ev; break; }
      const rep = complete ? parseReport(complete.log) : null;
      count({ billedMs: rep?.billedMs ?? Date.now() - t0, error: true });
      const le = lambdaErrorOf(start.payload);
      logger.warn({ app: i.app.id, fn: row.function_name, alias, type: le.type, status: rep?.status }, "[app-server-call] 앱 서버가 응답을 시작하지 못했다");
      const timedOut = rep?.status === "timeout" || le.type === "Sandbox.Timedout";
      await end({ status: "failed", error: timedOut ? "timeout" : le.type ?? rep?.errorType ?? "start" });
      if (timedOut) throw fail(504, "app_server_timeout", timeoutText(policy.timeout_s));
      throw fail(502, "app_server_error", le.type === "Runtime.ExitError"
        ? "앱 서버 프로그램이 도구 부르기를 처리하다 끝났습니다 — 앱을 만든 사람이 서버 기록을 확인해야 합니다"
        : `앱 서버가 오류로 끝났습니다(${le.type ?? rep?.errorType ?? "까닭 모름"})`);
    }
    //  본문 — 앞 maxBytes 까지만 모으고 나머지는 읽어 버린다(흐름은 끝까지 읽는다: REPORT 의 청구 시간으로 세고 · 그동안 자리를 쥔다 — app-front-server ★).
    const parts: Buffer[] = [];
    let kept = 0, bytes = 0;
    const take = (b: Buffer): void => {
      bytes += b.length;
      if (kept < i.maxBytes) { const p = b.subarray(0, i.maxBytes - kept); parts.push(p); kept += p.length; }
    };
    take(start.first);
    let complete: Complete | null = null;
    for await (const ev of start.rest) {
      if (ev.type === "complete") { complete = ev; break; }
      take(ev.data);
    }
    const rep = complete ? parseReport(complete.log) : null;
    const appFailed = !complete || !!complete.errorCode || (rep !== null && rep.status !== "ok");
    //  검사 층이 직접 답했다(x-lively-guard) — 요청 시간에서 끊었으면(timeout) 앱의 실패로 센다(사람 요청과 같다 · app-front-server).
    //   그 밖(denied · error · app-unreachable · app-bad-response)은 앱이 끝까지 돌지 못한 부르기라 행은 failed 로 적되, 앱 오류로 세지는 않는다.
    const guard = start.prelude.headers["x-lively-guard"];
    const guardTimeout = guard === "timeout";
    count({ billedMs: rep?.billedMs ?? Date.now() - t0, error: appFailed || guardTimeout });
    const status = start.prelude.statusCode;
    if (appFailed) {
      logger.warn({ app: i.app.id, fn: row.function_name, alias, status: rep?.status ?? "no-complete", type: rep?.errorType ?? complete?.errorCode }, "[app-server-call] 앱 서버 응답이 중간에 끊겼다");
      await end({ status: "failed", error: "cut", statusCode: status, bytes });
      if (rep?.status === "timeout") throw fail(504, "app_server_timeout", timeoutText(policy.timeout_s));
      throw fail(502, "app_server_error", "앱 서버 응답이 중간에 끊겼습니다 — 잠시 뒤 다시 하세요");
    }
    await end(guard ? { status: "failed", error: guardTimeout ? "timeout" : `guard:${String(guard).slice(0, 40)}`, statusCode: status, bytes } : { status: "done", statusCode: status, bytes });
    return { reply: { status, headers: start.prelude.headers, body: Buffer.concat(parts), bytes }, timeoutS: policy.timeout_s };
  } catch (e) {
    if (!(e instanceof HttpError)) {
      //  부르기 행을 만든 뒤의 예기치 못한 실패만 센다(행을 못 만들었으면 함수를 부르지도 않았다).
      if (callId !== null) count({ billedMs: Date.now() - t0, error: true });
      await end({ status: "failed", error: "gateway" });
    }
    throw e;
  } finally {
    slot();
  }
}

// ── 30초 넘는 도구(run.background) ─────────────────────────────────────────────────────
export interface ServerJobInput {
  app: { id: string; view: "installed" | "published"; variant: "pub" | "draft" };
  tool: string;
  route: string;
  args: Record<string, unknown>;
  /** 부른 사람 — 작업을 시작하는 사람이고, 작업의 돌기 신원은 scopes(부른 연결의 권한 ∩ 동의)를 넘지 않는다. */
  caller: { userId: string; scopes: string[]; tokenScopes: string[]; tokenHashPrefix?: string };
  signal?: AbortSignal;
  progress?: (p: { progress: number; total?: number; message?: string }) => Promise<void>;
}

/**
 * 그 라우트를 부른 사람의 백그라운드 작업(#4486 — 함수 비동기 · claim 신원 · 최대 15분)으로 돌리고 bgWaitSec 까지 대신 기다린다(bgProgressSec 마다 진행 알림).
 *  진행 알림을 받을 수 없는 요청(progress 없음)은 bgQuietWaitSec 까지만 — 클라이언트의 요청 시한에 먼저 끊기지 않게(BG_WAIT_QUIET_SEC).
 *  끝나면 {done, reply}(작업 결과 → 도구 결과), 못 끝나면 {done:false, jobId}(작업은 그대로 돈다 — 부른 사람이 app_job_get 으로 받는다).
 *  부른 쪽이 끊으면(signal) 기다리기만 그만둔다(작업은 취소하지 않는다 — 다시 와서 받을 수 있다).
 */
export async function runServerToolJob(i: ServerJobInput, deps: ServerCallDeps = liveServerCallDeps()): Promise<{ done: true; reply: ToolReply } | { done: false; jobId: number; waitedSec: number }> {
  await serverTargetOf(i.app, JOB_GUARD_MIN, deps);
  const user: LivelyUser = { userId: i.caller.userId, email: "", scopes: [...i.caller.tokenScopes], projects: ["*"], ...(i.caller.tokenHashPrefix ? { tokenHashPrefix: i.caller.tokenHashPrefix } : {}) };
  let view: Record<string, unknown>;
  try {
    view = await startAppJob({ app_id: i.app.id, route: i.route, body: i.args, label: `AI 도구 ${i.tool}` }, user,
      { source: MCP_TOOL_JOB_SOURCE, scopeCeiling: [...i.caller.scopes] }, deps.jobDeps());
  } catch (e) {
    //  작업 상한(대기 줄 · 하루 수) · 그 밖의 거절 — 사람이 읽을 글은 그대로, 코드만 단다(위 판정을 지난 뒤라 서버 상태의 거절은 드물다).
    if (e instanceof HttpError && !e.body?.code) throw fail(e.status, e.status === 429 ? "app_jobs_limit" : "app_job_refused", e.message);
    throw e;
  }
  const id = Number(view.id);
  const t0 = Date.now();
  const waitSec = i.progress ? deps.bgWaitSec : Math.min(deps.bgWaitSec, deps.bgQuietWaitSec);
  const waitMs = waitSec * 1000, tickMs = Math.max(1, deps.bgProgressSec) * 1000;
  let nextTick = t0 + tickMs;
  for (;;) {
    const j = await getAppJob(id);
    if (!j) throw fail(502, "app_job_failed", `도구의 작업 #${id} 을(를) 찾지 못했습니다`);
    if (isJobEnded(j.status)) return { done: true, reply: jobToolReplyOf((await getAppJob(id, { view: true })) ?? j) };
    const elapsed = Date.now() - t0;
    if (elapsed >= waitMs || i.signal?.aborted) return { done: false, jobId: id, waitedSec: Math.round(elapsed / 1000) };
    if (i.progress && Date.now() >= nextTick) {
      nextTick += tickMs;
      const sec = Math.round(elapsed / 1000);
      await i.progress({ progress: sec, total: deps.bgWaitSec, message: `도구의 작업 #${id} 이(가) 도는 중입니다(${sec}초)` });
    }
    await new Promise((ok) => setTimeout(ok, Math.min(1000, Math.max(1, waitMs - elapsed))));
  }
}

// ── 검사 층의 콜백(부르기 비밀 + 그 함수의 앱 서버 토큰) ─────────────────────────────────────
const conflict = (reason: string, message: string): HttpError => new HttpError(409, message, { body: { reason } });

/**
 * 시작 확인 — 그 앱의 함수가 · 부른 그 부르기의 · 그 비밀로 · 아직 시작 안 했고 · 부른 지 얼마 안 됐을 때만 한 번 넘긴다.
 *  넘기면 돌기 신원과 부른 사람 · 판 · 요청 시간(검사 층이 앱에 넘길 것). 아니면 401 · 404 · 409(앱 코드에 닿기 전에 끝).
 */
export async function onCallClaim(id: number, caller: JobCaller, secret: string): Promise<Record<string, unknown>> {
  const c = await cs.getAppCall(id);
  if (!c || c.app_id !== caller.appId) throw new HttpError(404, "없는 부르기입니다");
  if (!jobSecretMatches(c.call_hash, secret)) {
    if (c.status !== "dispatched") throw conflict("ended", "이미 끝난 부르기입니다");
    throw new HttpError(401, "부르기 비밀이 맞지 않습니다");
  }
  if (c.status !== "dispatched") throw conflict(c.status === "running" ? "claimed" : "ended", "이미 시작했거나 끝난 부르기입니다(같은 부르기가 두 번 왔습니다)");
  //  부른 사람이 지금도 이 워크스페이스에서 그 앱을 쓸 수 있어야 한다 — 아니면 시작하지 않는다(그 사람 신원으로 돈다).
  const member = await getMember(c.requester);
  if (!member || member.state !== "active" || !(await workspaceAccessAllowed(member.id)) || !(await getActiveGrant(c.app_id, member.id))) {
    await cs.endAppCall(id, { status: "failed", error: "requester_gone" });
    throw conflict("requester_gone", "부른 사람이 이 앱을 쓸 수 없습니다");
  }
  const run = newJobSecret();
  const claimed = await cs.claimAppCall(id, c.call_hash!, run.hash);
  if (!claimed) {
    const now = await cs.getAppCall(id);
    throw conflict(now?.status === "running" ? "claimed" : now?.status === "dispatched" ? "expired" : "ended", "이미 시작했거나 끝났거나 늦게 온 부르기입니다");
  }
  return {
    call: id, run: callCredential("run", id, run.secret), member: member.id, member_name: claimed.requester_name || member.display_name || member.id,
    variant: claimed.variant, timeout_s: claimed.timeout_s,
  };
}

// ── 돌기 신원 → 사람(앱의 SDK 가 게이트웨이를 부를 때) ────────────────────────────────────
/**
 * 앱 서버 토큰 + 돌기 신원 → 부른 사람 ∩ 그 사람의 앱 동의 ∩ 부른 연결의 권한(주소의 판 = 그 부르기의 판).
 *  부르기가 도는 동안(running · 요청 시간 + 여유 안)만 — 게이트웨이가 답을 다 받으면 그 부르기의 라이블리 호출이 막힌다. 아니면 401 · 403.
 */
export async function resolveCallRunPrincipal(user: LivelyUser, raw: string, now: number = Date.now()): Promise<LivelyUser> {
  const caller = jobCallerOf(user);
  const c = parseCallCredential(raw);
  if (!c) throw new HttpError(401, "부르기 신원 모양이 맞지 않습니다");
  if (c.kind !== "run") throw new HttpError(401, "부르기 신원은 게이트웨이 호출에 쓸 수 없습니다(검사 층만 씁니다)");
  const row = await cs.getAppCall(c.id);
  if (!row || row.app_id !== caller.appId || !jobSecretMatches(row.run_hash, c.secret)) throw new HttpError(401, "부르기 신원이 맞지 않습니다");
  if (row.status !== "running") throw new HttpError(401, "끝난 부르기의 신원입니다 — 도구 라우트는 답하기 전에 라이블리를 부르세요(답한 뒤의 호출은 막힙니다)");
  if (!row.claimed_at || now - new Date(row.claimed_at).getTime() > (row.timeout_s + CALL_RUN_GRACE_SEC) * 1000) throw new HttpError(401, "시간이 지난 부르기의 신원입니다");
  const member = await getMember(row.requester);
  if (!member || member.state !== "active") throw new HttpError(403, "부른 사람이 이 워크스페이스에서 활성 상태가 아닙니다");
  if (!(await workspaceAccessAllowed(member.id))) throw new HttpError(403, "부른 사람이 이 워크스페이스의 구성원이 아닙니다");
  const app = await getApp(row.app_id);
  if (!app || !canSeeApp(app, { userId: member.id, scopes: member.scopes })) throw new HttpError(403, `이 사람은 앱 '${row.app_id}' 을(를) 쓸 수 없습니다(나만 보는 앱)`);
  const grant = await getActiveGrant(row.app_id, member.id);
  if (!grant) throw new HttpError(403, `부른 사람이 앱 '${row.app_id}' 사용 동의를 거두었습니다`);
  const allowed = new Set(member.scopes.filter(isScope));
  const granted = new Set(grant.scopes);
  return {
    userId: member.id, email: member.email ?? "", scopes: row.scopes.filter((s) => isScope(s) && allowed.has(s) && granted.has(s)), projects: ["*"],
    tokenSource: "db", tokenHashPrefix: user.tokenHashPrefix, appId: row.app_id, appServer: true, appAddress: row.variant, appCallId: row.id,
  };
}

// ── 정리 ───────────────────────────────────────────────────────────────────────────────
/** 하우스키핑 — 끝맺지 못한 부르기를 닫고, 끝난 지 CALL_KEEP_DAYS 가 지난 행을 지운다(한 판 1,000줄 · 10판까지). */
export async function sweepAppCalls(): Promise<{ expired: number; pruned: number }> {
  const expired = await cs.expireStaleAppCalls();
  let pruned = 0;
  for (let k = 0; k < 10; k++) { const n = await cs.pruneAppCalls(1000, CALL_KEEP_DAYS); pruned += n; if (n < 1000) break; }
  return { expired, pruned };
}
