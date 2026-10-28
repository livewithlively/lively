// 앱 백그라운드 작업 — 흐름 (#4486 앱 v2-7). 판정은 app-jobs-plan.ts · 행은 app-jobs-store.ts · 함수 안 쪽은 app-server-guard.ts(검사 층).
//
//  입구: 능력 app_job_start(앱 서버 POST /api/ui/app-jobs · 앱 화면 /_lively/jobs · lively.jobs.start · 사람 MCP) — 줄을 세우고(org_app_job) 자리가 나면
//   그 앱의 함수를 비동기로 부른다(dispatchAppJobs). 함수 안 검사 층이 시작 확인(onJobClaim) · 박동(onJobTick) · 결과(onJobResult)를 부른다.
//   감시(sweepAppJobs — 요청에 얹은 테넌트 정비 30초)가 대기 초과 · 시작 못 함 · 소식 없음 · 시간 초과를 끝내고 줄을 민다.
//  신원(결정 상민 2026-10-20 — #4486 댓글 539): 작업은 **시작한 사람**으로 돈다 — 앱의 SDK 가 돌기 신원을 실어 부르면 그 사람 ∩ 그 사람의 앱 동의
//   (resolveJobRunPrincipal · 사람이 누른 요청과 같은 권한 · 작업이 도는 동안만). 앱 자체 주체(사람 없는 작업 — 자동화 app_call)는 v2-12.
//  자리: 작업은 그 사람의 주소의 판(초안 주소 = cur · 공개 주소 = 남의 초안이 걸렸으면 pub)으로 돈다 — 사람 요청이 가는 별칭과 같은 규칙(app-front-server).
//   만들 때 그 별칭의 함수 판을 못 박는다(줄에 선 동안 새 판이 올라와도 그 작업을 낸 코드로 돈다) — 배포는 열린 작업의 판 · 토큰을 정리 · 회수하지 않는다.
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import type { LivelyUser } from "../context.js";
import { getApp, getActiveGrant } from "../org/store/apps.js";
import { getMember } from "../org/store/members.js";
import { workspaceAccessAllowed } from "../org/tenancy/gate.js";
import { isScope } from "../auth/scopes.js";
import { tenantSlug } from "../terminal/catalog.js";
import { AwsError } from "../net/aws/aws-json.js";
import { addressVariantFor, addressViewFor, canSeeApp, isAdminViewer } from "./visibility.js";
import { appDomain, appHost } from "./app-address.js";
import { appServerEnv, type AppServerEnv } from "./app-server-config.js";
import { appServerApi } from "./app-server-host.js";
import { parseAppServerUserId } from "./app-server-id.js";
import { appSqlTenantId } from "./app-sql-exec.js";
import * as st from "./app-server-store.js";
import type { AppServerPolicy } from "./app-server-policy.js";
import * as js from "./app-jobs-store.js";
import {
  JOB_DEPTH_MAX, JOB_DISPATCH_ATTEMPTS, JOB_GUARD_MIN, JOB_TICK_SEC, JOB_WAIT_MAX_SEC, OPEN_JOB_STATUSES,
  encodeJobBody, endOf, isJobEnded, jobAdmissionError, jobCredential, jobLabelOf, jobRouteError, jobTimeoutOf, jobTypeError, jobView,
  jobInvokeEvent, normalizeResultReport, parseJobCredential, resultViewOf, sweepVerdict, type AppJobStatus,
} from "./app-jobs-plan.js";

/** 시험이 바꿔 끼우는 자리 — 상한 · 앱 서버 설정 · 비동기 부르기 · 앱 도메인 · 슬러그 · 시계. */
export interface AppJobDeps {
  policy(): Promise<AppServerPolicy>;
  env(): AppServerEnv | null;
  invokeAsync(env: AppServerEnv, fn: string, qualifier: string, payload: unknown): Promise<void>;
  domain(): string | null;
  slug(): string | null;
  now(): number;
}
export function liveAppJobDeps(): AppJobDeps {
  return {
    policy: () => st.appServerPolicy(),
    env: () => appServerEnv(),
    invokeAsync: async (env, fn, q, payload) => { await appServerApi(env).invokeAsync(fn, q, payload); },
    domain: () => appDomain(),
    slug: () => tenantSlug(),
    now: () => Date.now(),
  };
}

/** 감시가 한 번에 보는 열린 작업 — 한 판의 줄 수 · 판 수 상한. */
const SWEEP_PAGE_SIZE = 200, SWEEP_MAX_PAGES = 25;

const actorSource = (user: LivelyUser, source?: string): string =>
  user.appServer ? (user.appJobId ? "app-job" : "app-server") : source ?? (user.appId ? "app-ui" : "person");

/**
 * 작업 하나를 받는다 — 앱 서버 · 앱 화면 · 사람(MCP) 공용. 줄을 세우고 곧바로 부를 수 있으면 부른다. 돌려주는 것은 작업 보기(+ wait 초 동안 끝나기를 기다림).
 *  막는 것: 작업 종류(agent 는 AI 실행 입구로) · 라우트 · 시간 상한(15분 너머는 작업 컨테이너로) · 본문 상한 · 앱(보임 · 켜짐 · 동의) · 서버(올라감 · 이 판의
 *  검사 층 · 멈춤) · 작업이 시작한 작업의 깊이 · 앱 대기 줄 · 하루 수.
 */
export async function startAppJob(input: Record<string, unknown>, user: LivelyUser, ctx: { source?: string } = {}, deps: AppJobDeps = liveAppJobDeps()): Promise<Record<string, unknown>> {
  if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
  const typeErr = jobTypeError(input.type);
  if (typeErr) throw new HttpError(400, typeErr);
  const routeErr = jobRouteError(input.route);
  if (routeErr) throw new HttpError(400, routeErr);
  const appId = user.appId ?? (typeof input.app_id === "string" ? input.app_id.trim() : "");
  if (!appId) throw new HttpError(400, "app_id 가 필요합니다(앱 화면 · 앱 서버에서 부르면 생략)");
  if (user.appId && input.app_id !== undefined && input.app_id !== user.appId) throw new HttpError(403, "다른 앱의 작업은 시작할 수 없습니다");
  const env = deps.env();
  if (!env) throw new HttpError(501, "이 워크스페이스는 앱 서버 실행이 꺼져 있어 백그라운드 작업을 돌릴 수 없습니다(자가호스팅 박스는 v2-8 에서)");
  const policy = await deps.policy();
  const to = jobTimeoutOf(input.timeout_s, policy);
  if ("error" in to) throw new HttpError(400, to.error);
  const enc = encodeJobBody(input.body, policy);
  if ("error" in enc) throw new HttpError(enc.status, enc.error);

  //  앱 — 보임 · 켜짐 · 그 사람의 동의(작업은 그 사람 ∩ 그 동의로 돈다).
  const app = await getApp(appId);
  const viewer = { userId: user.userId, scopes: user.scopes ?? [] };
  if (!app || !canSeeApp(app, viewer)) throw new HttpError(404, `앱 없음: ${appId}`);
  if (app.status !== "active" || !app.enabled) throw new HttpError(409, `앱 '${appId}' 이 활성 상태가 아닙니다`);
  if (!(await getActiveGrant(appId, user.userId))) throw new HttpError(403, `앱 '${appId}' 사용 동의(grant)가 없습니다 — 앱 화면에서 동의한 뒤 다시 하세요`);

  //  자리 — 그 사람의 주소의 판(앱 서버 · 앱 주소 화면은 신원 · 주소가 정한 판, 라이블리 안 화면 · 사람은 그 사람에게 보이는 판).
  const variant = user.appAddress ?? addressVariantFor(app, viewer);
  const view = addressViewFor(app, viewer, variant);
  if (view === "none") throw new HttpError(404, `앱 없음: ${appId}`);
  const alias: "cur" | "pub" = view === "published" ? "pub" : "cur";
  const row = await st.getServerRow(appId);
  const version = alias === "pub" ? row?.pub_lambda_version : row?.cur_lambda_version;
  if (!row || !version) throw new HttpError(409, "이 앱의 서버가 아직 올라가지 않았습니다 — 앱을 만든 사람이 「이대로 넣기」 또는 app_server_deploy 로 서버를 올린 뒤 작업을 보낼 수 있습니다");
  const guard = alias === "pub" ? row.pub_guard : row.cur_guard;
  if ((guard ?? 0) < JOB_GUARD_MIN) {
    throw new HttpError(409, "이 앱의 서버는 백그라운드 작업 전에 올라간 판입니다 — 앱을 만든 사람이 서버를 다시 올리면(app_server_deploy · 「이대로 넣기」) 작업을 받습니다");
  }
  if (row.stopped_at) throw new HttpError(503, `앱 서버가 멈춰 있어 작업을 받지 않습니다${row.stop_reason ? `(까닭: ${row.stop_reason})` : ""} — 관리자(손으로 멈췄으면 책임자)가 다시 켜면 됩니다`);

  //  작업이 시작한 작업 — 같은 사람 · 같은 앱이고 깊이 상한 안에서만(끝없이 이어지지 않게).
  let parentId: number | null = null;
  let depth = 0;
  if (user.appJobId) {
    const parent = await js.getAppJob(user.appJobId);
    if (!parent || parent.app_id !== appId) throw new HttpError(403, "작업 신원이 이 앱의 것이 아닙니다");
    depth = parent.depth + 1;
    parentId = parent.id;
    if (depth > JOB_DEPTH_MAX) throw new HttpError(409, `작업이 시작한 작업은 ${JOB_DEPTH_MAX}단계까지입니다 — 더 나누려면 한 작업이 여러 작업을 나란히 시작하세요`);
  }
  const tokenHash = (alias === "pub" ? row.pub_token_hash : row.cur_token_hash) ?? null;
  const out = await js.insertAppJob({
    appId, requester: user.userId, variant, alias, functionName: row.function_name, lambdaVersion: version, tokenHash,
    route: String(input.route), body: enc.json, bodyBytes: enc.bytes, label: jobLabelOf(input.label), timeoutS: to.timeout,
    source: actorSource(user, ctx.source), parentId, depth,
  }, (have) => jobAdmissionError(policy, have)?.error ?? null);
  if ("denied" in out) throw new HttpError(429, out.denied);
  logger.info({ app: appId, job: out.row.id, alias, version, source: out.row.source }, "[app-jobs] 작업을 받았다(#4486)");
  //  곧바로 부를 수 있으면 부른다(다음 감시를 기다리지 않게) — 실패해도 받은 것은 그대로(감시가 다시 민다).
  await dispatchAppJobs(deps).catch((e) => logger.warn({ err: (e as Error)?.message ?? e, app: appId }, "[app-jobs] 곧바로 부르기 실패 — 감시가 다시 민다"));
  const wait = waitSecOf(input.wait);
  const now = wait > 0 ? await waitForJob(out.row.id, wait) : await js.getAppJob(out.row.id, { view: true });
  return jobView(now ?? out.row, true);
}

const waitSecOf = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? Math.min(JOB_WAIT_MAX_SEC, Math.floor(n)) : 0;
};

/** 끝날 때까지 기다린다(1초마다 가벼운 줄로 · sec 초까지). 끝났거나 시간이 다 되면 결과까지 읽은 줄. */
async function waitForJob(id: number, sec: number): Promise<js.AppJobRow | null> {
  const until = Date.now() + sec * 1000;
  for (;;) {
    const r = await js.getAppJob(id);
    if (!r || isJobEnded(r.status) || Date.now() >= until) return r ? (await js.getAppJob(id, { view: true })) ?? r : r;
    await new Promise((ok) => setTimeout(ok, Math.min(1000, Math.max(0, until - Date.now()))));
  }
}

// ── 보기 · 목록 · 취소 ──────────────────────────────────────────────────────────────────
/** 이 사람이 이 작업을 볼 수 있나 — full(결과까지) · summary(상태 · 오류) · null(없음과 같다). */
function accessOf(r: js.AppJobRow, user: LivelyUser): "full" | "summary" | null {
  if (user.appId && r.app_id !== user.appId) return null;           // 앱 화면 · 앱 서버 · 작업은 제 앱의 작업만
  if (r.requester === user.userId) return "full";
  if (!user.appId && isAdminViewer({ userId: user.userId, scopes: user.scopes ?? [] })) return "summary";   // 관리자는 남의 작업의 상태 · 오류만
  return null;
}

export async function getAppJobFor(id: number, user: LivelyUser, wait?: unknown): Promise<Record<string, unknown>> {
  const sec = waitSecOf(wait);
  let r = await js.getAppJob(id, { view: true });
  const how = r ? accessOf(r, user) : null;
  if (!r || !how) throw new HttpError(404, "없는 작업입니다");
  if (sec > 0 && !isJobEnded(r.status)) r = (await waitForJob(id, sec)) ?? r;
  return jobView(r, how === "full");
}

export async function listAppJobsFor(input: Record<string, unknown>, user: LivelyUser): Promise<Record<string, unknown>> {
  const status = typeof input.status === "string" && input.status ? input.status as AppJobStatus : null;
  if (status && ![...OPEN_JOB_STATUSES, "done", "failed", "canceled"].includes(status)) throw new HttpError(400, "status 는 queued · dispatched · running · done · failed · canceled");
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
  const admin = !user.appId && isAdminViewer({ userId: user.userId, scopes: user.scopes ?? [] });
  const appId = user.appId ?? (typeof input.app_id === "string" && input.app_id ? input.app_id : null);
  const rows = await js.listAppJobs({ appId, requester: admin ? null : user.userId, status, limit });
  //  목록엔 결과 본문을 싣지 않는다(작업마다 64KB 까지) — 결과는 app_job_get 으로.
  const jobs = rows.map((r) => { const v = jobView(r, accessOf(r, user) === "full"); delete v.result; return v; });
  return { jobs, count: rows.length };
}

/** 취소 — 기다리는 · 부른 작업은 곧바로 끝내고, 도는 작업은 표시만(검사 층이 다음 박동에 앱 요청을 끊는다 · 그동안 그 작업의 라이블리 호출은 막힌다). */
export async function cancelAppJobFor(id: number, user: LivelyUser, deps: AppJobDeps = liveAppJobDeps()): Promise<Record<string, unknown>> {
  const r = await js.getAppJob(id, { view: true });
  const how = r ? accessOf(r, user) : null;
  const admin = !user.appId && isAdminViewer({ userId: user.userId, scopes: user.scopes ?? [] });
  if (!r || !how) throw new HttpError(404, "없는 작업입니다");
  if (how !== "full" && !admin) throw new HttpError(403, "작업을 시작한 사람 · 관리자만 취소합니다");
  if (isJobEnded(r.status)) return jobView(r, how === "full");
  await js.requestCancelAppJob(id);
  //  아직 함수에 닿지 않은 작업은 곧바로 끝낸다 — 부른 작업이 늦게 닿아도 시작 확인이 거절한다(취소 표시).
  await js.endAppJob(id, ["queued", "dispatched"], { status: "canceled", error: "취소했습니다" });
  await dispatchAppJobs(deps).catch((e) => logger.warn({ err: (e as Error)?.message ?? e }, "[app-jobs] 취소 뒤 줄 밀기 실패 — 감시가 민다"));
  return jobView((await js.getAppJob(id, { view: true })) ?? r, how === "full");
}

// ── 부르기 ──────────────────────────────────────────────────────────────────────────────
/** 잘 안 되는 부르기 — 다시 해도 같은 결과(함수 · 판 없음 · 본문 너무 큼 · 요청 모양). 그 밖(조절 · 5xx · 연결)은 줄로 되돌려 다시 부른다. */
const permanentInvokeError = (e: unknown): boolean =>
  e instanceof AwsError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.code !== "TooManyRequestsException";

/**
 * 줄을 민다 — 워크스페이스 · 앱 동시 상한 안에서 기다린 작업을 골라(그 자리에서 dispatched + 새 부르기 비밀) 함수를 비동기로 부른다.
 *  부르기 전에 앱 · 서버를 한 번 더 본다(그사이 지웠거나 · 껐거나 · 멈췄으면 끝낸다). 부른 수.
 */
export async function dispatchAppJobs(deps: AppJobDeps = liveAppJobDeps()): Promise<number> {
  const env = deps.env();
  if (!env) return 0;
  const p = await deps.policy();
  const picked = await js.claimDispatchable({ workspace: p.jobs_running_workspace, app: Math.min(p.jobs_running_app, p.jobs_running_workspace) });
  let n = 0;
  for (const { row: j, secret } of picked) {
    const end = (error: string): Promise<unknown> => js.endAppJob(j.id, ["dispatched"], { status: "failed", error });
    try {
      const app = await getApp(j.app_id);
      if (!app || app.status !== "active" || !app.enabled) { await end("앱이 지워졌거나 꺼져 작업을 돌리지 않았습니다"); continue; }
      const srv = await st.getServerRow(j.app_id);
      if (!srv) { await end("앱 서버가 없어 작업을 돌리지 않았습니다"); continue; }
      if (srv.stopped_at) { await end(`앱 서버가 멈춰 작업을 돌리지 않았습니다${srv.stop_reason ? `(까닭: ${srv.stop_reason})` : ""}`); continue; }
      const slug = deps.slug() ?? "local";
      const host = appHost(slug, j.app_id, j.variant, deps.domain()) ?? `${j.app_id}-${slug}.lively.invalid`;
      const event = jobInvokeEvent(j, jobCredential("call", j.id, secret), host, deps.now());
      await deps.invokeAsync(env, j.function_name, j.lambda_version, event);
      n++;
    } catch (e) {
      //  구성원이 보는 오류 칸엔 AWS 의 짧은 오류 이름(code)만 — 원문(함수 경로 · 요청 번호 · 우리 코드의 글)은 기록에만 남긴다(#4887 «상태에 원문 안 싣기» · 격리 리뷰).
      const why = e instanceof AwsError ? e.code : "일시 오류";
      const onEndFail = (err: unknown): void => logger.warn({ err: (err as Error)?.message ?? err, job: j.id }, "[app-jobs] 작업 끝내기 실패 — 감시가 끝낸다");
      if (permanentInvokeError(e)) {
        logger.warn({ err: (e as Error)?.message, app: j.app_id, job: j.id }, "[app-jobs] 함수를 부르지 못했다(다시 해도 같다) — 작업을 끝낸다");
        await end(`앱 서버 함수를 부르지 못했습니다: ${why}`).catch(onEndFail);
      } else if (j.attempts >= JOB_DISPATCH_ATTEMPTS + 2) {
        logger.warn({ err: (e as Error)?.message, app: j.app_id, job: j.id, attempts: j.attempts }, "[app-jobs] 함수 부르기가 거듭 실패 — 작업을 끝낸다");
        await end(`앱 서버 함수를 부르지 못했습니다(${j.attempts}번 — ${why})`).catch(onEndFail);
      } else {
        logger.warn({ err: (e as Error)?.message, app: j.app_id, job: j.id }, "[app-jobs] 함수 부르기 일시 실패 — 줄로 되돌린다");
        await js.requeueAppJob(j.id, j.call_hash).catch((err) => logger.warn({ err: (err as Error)?.message ?? err, job: j.id }, "[app-jobs] 줄로 되돌리기 실패 — 감시가 다시 민다"));
      }
    }
  }
  return n;
}

// ── 검사 층의 콜백(작업 비밀 + 그 함수의 앱 서버 토큰) ────────────────────────────────────────
/** 콜백을 부른 함수의 앱(앱 서버 토큰에서) — 이 워크스페이스 · 그 작업의 앱이어야 한다. */
export interface JobCaller { appId: string }

/** 앱 서버 토큰 주체 → 부른 앱. 아니면 401(어느 작업인지 말하지 않는다). */
export function jobCallerOf(user: LivelyUser | undefined): JobCaller {
  const bound = parseAppServerUserId(user?.userId);
  if (!user || !bound || !user.appId || bound.appId !== user.appId) throw new HttpError(401, "앱 서버 토큰이 필요합니다");
  if (bound.tenantId !== appSqlTenantId().toLowerCase()) throw new HttpError(401, "다른 워크스페이스의 앱 서버 토큰입니다");
  return { appId: bound.appId };
}

const conflict = (reason: string, message: string): HttpError => new HttpError(409, message, { body: { reason } });

/**
 * 시작 확인 — 그 앱의 함수가 · 부른 그 작업의 · 그 부르기 비밀로 · 아직 시작 안 했고 · 취소 안 됐을 때만 한 번 넘긴다.
 *  넘기면 돌기 신원과 작업을 시작한 사람 · 판 · 시간 상한(검사 층이 앱에 넘길 것). 아니면 401 · 404 · 409(앱 코드에 닿기 전에 끝).
 */
//  ⓘ claim 응답이 오다 끊기면(서버는 시작으로 적었는데 검사 층이 못 받음) 다시 묻는 claim 은 409 claimed 를 받고 앱을 부르지 않는다 —
//   작업은 running 으로 남았다가 90초 뒤 감시가 «응답을 멈췄습니다» 로 끝낸다. 두 번 도는 것보다 안전한 쪽을 골랐다(같은 비밀에 새 돌기 신원을
//   또 주면 AWS 의 중복 전달도 두 번 돈다 · 격리 리뷰 메모).
export async function onJobClaim(id: number, caller: JobCaller, secret: string): Promise<Record<string, unknown>> {
  const j = await js.getAppJob(id);
  if (!j || j.app_id !== caller.appId) throw new HttpError(404, "없는 작업입니다");
  if (!js.jobSecretMatches(j.call_hash, secret)) {
    //  끝난 · 다시 부른 작업의 옛 부르기 · 위조 — 상태로 갈라 알린다(비밀은 말하지 않는다).
    if (isJobEnded(j.status)) throw conflict("ended", "이미 끝난 작업입니다");
    throw new HttpError(401, "작업 비밀이 맞지 않습니다");
  }
  if (j.cancel_requested) {
    await js.endAppJob(id, ["dispatched"], { status: "canceled", error: "취소했습니다" });
    throw conflict("canceled", "취소한 작업입니다");
  }
  if (j.status !== "dispatched") throw conflict(j.status === "running" ? "claimed" : "ended", "이미 시작했거나 끝난 작업입니다(같은 호출이 두 번 왔습니다)");
  //  작업을 시작한 사람이 지금도 이 워크스페이스에서 그 앱을 쓸 수 있어야 한다 — 아니면 시작하지 않는다(그 사람 신원으로 돈다).
  const member = await getMember(j.requester);
  if (!member || member.state !== "active" || !(await workspaceAccessAllowed(member.id)) || !(await getActiveGrant(j.app_id, member.id))) {
    await js.endAppJob(id, ["dispatched"], { status: "failed", error: "작업을 시작한 사람이 이제 이 앱을 쓸 수 없어(떠남 · 동의 철회) 시작하지 않았습니다" });
    throw conflict("requester_gone", "작업을 시작한 사람이 이 앱을 쓸 수 없습니다");
  }
  const run = js.newJobSecret();
  const claimed = await js.claimAppJob(id, j.call_hash!, run.hash);
  if (!claimed) {
    const now = await js.getAppJob(id);
    if (now?.cancel_requested) throw conflict("canceled", "취소한 작업입니다");
    throw conflict(now?.status === "running" ? "claimed" : "ended", "이미 시작했거나 끝난 작업입니다(같은 호출이 두 번 왔습니다)");
  }
  logger.info({ app: j.app_id, job: id, attempt: j.attempts }, "[app-jobs] 작업 시작(#4486)");
  return {
    job: id, run: jobCredential("run", id, run.secret), member: member.id, member_name: member.display_name ?? member.id,
    variant: claimed.variant, timeout_s: claimed.timeout_s, tick_s: JOB_TICK_SEC,
  };
}

/** 돌기 신원 확인 → 그 작업(도는 중 · 그 앱 · 그 비밀). 아니면 null. */
async function runningJobOf(id: number, caller: JobCaller, runCred: string): Promise<js.AppJobRow | null> {
  const c = parseJobCredential(runCred);
  if (!c || c.kind !== "run" || c.id !== id) return null;
  const j = await js.getAppJob(id);
  if (!j || j.app_id !== caller.appId || !js.jobSecretMatches(j.run_hash, c.secret)) return null;
  return j;
}

export async function onJobTick(id: number, caller: JobCaller, runCred: string): Promise<{ cancel: boolean }> {
  const j = await runningJobOf(id, caller, runCred);
  if (!j) throw new HttpError(401, "작업 신원이 맞지 않습니다");
  const t = await js.tickAppJob(id, j.run_hash!);
  if (!t) throw conflict("ended", "이미 끝난 작업입니다");
  return t;
}

export async function onJobResult(id: number, caller: JobCaller, runCred: string, raw: unknown, deps: AppJobDeps = liveAppJobDeps()): Promise<Record<string, unknown>> {
  const j = await runningJobOf(id, caller, runCred);
  if (!j) throw new HttpError(401, "작업 신원이 맞지 않습니다");
  const rep = normalizeResultReport(raw);
  const e = endOf(rep, { timeoutSec: j.timeout_s, cancelRequested: j.cancel_requested });
  const end = { status: e.status, error: e.error, statusCode: rep.status_code, result: resultViewOf(rep), durationMs: rep.duration_ms };
  //  Postgres 가 결과 칸(jsonb)을 받지 않으면(데이터 예외 22xxx — 판정이 못 거른 이스케이프 등) base64 꼴로 한 번 더 — 결과 때문에 끝맺음을 잃지 않게.
  //   (잃으면 검사 층이 다섯 번 다시 보낸 뒤 90초 뒤 «응답을 멈췄습니다» 로 엉뚱하게 끝난다 · 격리 리뷰)
  const ended = await js.endAppJob(id, ["running"], end, j.run_hash!).catch(async (err: unknown) => {
    if (!/^22/.test(String((err as { code?: unknown })?.code ?? "")) || !end.result) throw err;
    logger.warn({ job: id, code: (err as { code?: unknown }).code }, "[app-jobs] 결과를 그대로 적지 못해 base64 로 적는다(#4486)");
    const { json: _j, text: _t, ...meta } = end.result;
    return js.endAppJob(id, ["running"], { ...end, result: { ...meta, base64: rep.body_b64 ?? undefined } }, j.run_hash!);
  });
  if (!ended) throw conflict("ended", "이미 끝난 작업입니다(감시가 먼저 끝냈습니다)");
  logger.info({ app: j.app_id, job: id, status: ended.status, code: rep.status_code, ms: rep.duration_ms }, "[app-jobs] 작업 끝(#4486)");
  //  자리가 났다 — 기다리는 작업을 민다.
  await dispatchAppJobs(deps).catch((err) => logger.warn({ err: (err as Error)?.message ?? err }, "[app-jobs] 끝난 뒤 줄 밀기 실패 — 감시가 민다"));
  return { ok: true, status: ended.status };
}

// ── 돌기 신원 → 사람(앱의 SDK 가 게이트웨이를 부를 때) ────────────────────────────────────
/**
 * 앱 서버 토큰 + 돌기 신원 → 작업을 시작한 사람 ∩ 그 사람의 앱 동의(사람 신원과 같은 판정 · 주소의 판 = 그 작업의 판).
 *  작업이 도는 동안(running · 취소 표시 없음)만 — 끝나면 · 취소하면 그 작업의 라이블리 호출이 막힌다. 아니면 401 · 403.
 */
export async function resolveJobRunPrincipal(user: LivelyUser, raw: string): Promise<LivelyUser> {
  const caller = jobCallerOf(user);
  const c = parseJobCredential(raw);
  if (!c) throw new HttpError(401, "작업 신원 모양이 맞지 않습니다");
  if (c.kind !== "run") throw new HttpError(401, "부르기 신원은 게이트웨이 호출에 쓸 수 없습니다(검사 층만 씁니다)");
  const j = await js.getAppJob(c.id);
  if (!j || j.app_id !== caller.appId || !js.jobSecretMatches(j.run_hash, c.secret)) throw new HttpError(401, "작업 신원이 맞지 않습니다");
  if (j.status !== "running") throw new HttpError(401, "끝난 작업의 신원입니다 — 작업 라우트는 일을 다 끝낸 뒤 답하세요(답한 뒤의 호출은 막힙니다)");
  if (j.cancel_requested) throw new HttpError(401, "취소한 작업입니다");
  const member = await getMember(j.requester);
  if (!member || member.state !== "active") throw new HttpError(403, "작업을 시작한 사람이 이 워크스페이스에서 활성 상태가 아닙니다");
  if (!(await workspaceAccessAllowed(member.id))) throw new HttpError(403, "작업을 시작한 사람이 이 워크스페이스의 구성원이 아닙니다");
  const app = await getApp(j.app_id);
  if (!app || !canSeeApp(app, { userId: member.id, scopes: member.scopes })) throw new HttpError(403, `이 사람은 앱 '${j.app_id}' 을(를) 쓸 수 없습니다(나만 보는 앱)`);
  const grant = await getActiveGrant(j.app_id, member.id);
  if (!grant) throw new HttpError(403, `작업을 시작한 사람이 앱 '${j.app_id}' 사용 동의를 거두었습니다`);
  const allowed = new Set(member.scopes.filter(isScope));
  return {
    userId: member.id, email: member.email ?? "", scopes: grant.scopes.filter((s) => isScope(s) && allowed.has(s)), projects: ["*"],
    tokenSource: "db", tokenHashPrefix: user.tokenHashPrefix, appId: j.app_id, appServer: true, appAddress: j.variant, appJobId: j.id,
  };
}

// ── 감시 · 정리 ────────────────────────────────────────────────────────────────────────
/**
 * 감시 — 열린 작업마다 판정(app-jobs-plan sweepVerdict)대로 끝내거나 다시 부르고, 줄을 민다. 요청에 얹은 테넌트 정비(30초)가 부른다.
 *  ⚠ 함수 안에서 도는 작업을 멈추지는 못한다(Lambda 에 «이 호출을 멈춰라» 는 없다) — 끝낸 작업의 라이블리 호출 · 결과 보고가 막힐 뿐이다.
 */
export async function sweepAppJobs(deps: AppJobDeps = liveAppJobDeps()): Promise<{ ended: number; requeued: number; dispatched: number }> {
  const p = await deps.policy();
  const now = deps.now();
  let ended = 0, requeued = 0;
  //  열린 작업을 끝까지 판을 이어 본다(한 판 200줄 · 25판까지) — 앞줄만 보면 뒤의 죽은 작업이 동시 자리를 붙잡는다(격리 리뷰).
  let after = 0;
  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const rows = await js.openAppJobs(after, SWEEP_PAGE_SIZE);
    for (const j of rows) {
      const v = sweepVerdict(j, now, p);
      if (v.kind === "requeue") { if (await js.requeueAppJob(j.id, j.call_hash)) requeued++; continue; }
      if (v.kind === "end") {
        const from: AppJobStatus[] = [j.status];
        if (await js.endAppJob(j.id, from, { status: v.status, error: v.error })) {
          ended++;
          logger.info({ app: j.app_id, job: j.id, from: j.status, to: v.status, why: v.error }, "[app-jobs] 감시가 작업을 끝냈다(#4486)");
        }
      }
    }
    if (rows.length < SWEEP_PAGE_SIZE) break;
    after = rows[rows.length - 1]!.id;
    if (page === SWEEP_MAX_PAGES - 1) logger.warn({ seen: SWEEP_PAGE_SIZE * SWEEP_MAX_PAGES, after }, "[app-jobs] 열린 작업이 감시 한 번의 상한을 넘었다 — 뒤쪽은 다음 감시가 본다(#4486)");
  }
  const dispatched = deps.env() ? await dispatchAppJobs(deps) : 0;
  return { ended, requeued, dispatched };
}

/**
 * 끝난 지 job_keep_days(기본 30일)가 지난 작업 행을 지운다(한 판 1,000줄 · 10판까지).
 *  보존 기간은 DB 에서 바로 읽고, 못 읽으면 지우지 않는다(던진다) — 기본값으로 잘못 읽어 관리자가 늘린 기간의 기록을 지우지 않게(#4828 과 같은 규칙).
 */
export async function pruneAppJobRecords(policy: () => Promise<AppServerPolicy> = st.appServerPolicyStrict): Promise<number> {
  const days = (await policy()).job_keep_days;
  let n = 0;
  for (let i = 0; i < 10; i++) { const k = await js.pruneAppJobs(1000, days); n += k; if (k < 1000) break; }
  return n;
}

/**
 * 앱을 지울 때 — 열린 작업을 끝낸다(함수 · 토큰이 곧 사라진다). 행(결과)은 보존 기간까지 남긴다 — 누구 이름으로 무엇이 돌았나의 기록이고,
 *  요청 본문은 끝낼 때 비운다.
 */
export async function endJobsForApp(appId: string, why: string): Promise<number> {
  return js.endOpenAppJobsForApp(appId, "failed", why);
}

