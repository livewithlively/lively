// 앱 주소의 같은 주소 API `/_lively/*`(#4482 앱 v2-3) — 앱 화면이 평범한 fetch 로 부르는 라이블리 API.
//
//  길: 브라우저 `https://<앱>-<워크스페이스>[-draft].lvly.app/_lively/<경로>` → 앞단(CP 라우터 control/src/appfront.ts)이 앱 주소 쿠키를
//   확인하고 본문까지 `/api/app-front/lively?path=<경로+쿼리>` 로 넘긴다(기계 헤더 x-lvly-app-front op=act 에 누가 · 어느 앱 · 어느 판).
//   여기서 그 사람(활성 · 이 워크스페이스) · 그 앱(있음 · 보임 · 켜짐) · 주소의 판을 다시 보고, 라이블리 화면의 다리와 **같은 판정**
//   (capabilities/app-tool-call.ts runAppTool — 그 사람 ∩ 그 사람의 앱 동의 · 선언한 도구만)으로 실행한다.
//  왜: 라이블리 화면 밖(새 탭 · 폰 홈 화면)에는 감싸는 라이블리 화면이 없어 postMessage 다리가 없다. 같은 주소의 API 가 있으면
//   앱은 어디서 떠도 같은 데이터를 쓴다(설계 §3-B · §3-G). 라이블리 안 iframe 에서도 같은 API 가 돈다(쿠키는 그 자리의 것).
//
//  경로(= 게이트웨이 REST 와 같은 꼴 — `/api/ui/<경로>` 를 `/_lively/<경로>` 로, 앱 id 는 주소가 정한다):
//   GET    /store/tables                         → store_tables
//   POST   /store/<표>/query   {match, limit}    → store_query           (insert {row} · update {match, set} · delete {match} 도 같은 꼴)
//   POST   /store/sql          {sql, params}     → store_sql             POST /store/sql/batch {statements} → store_sql_batch
//   POST   /tools/<도구>        {…인자}           → 선언한 그 도구(file_url · whoami · …) — lively.tools.call 과 같다
//   GET    /prefs                                → 이 앱 × 나의 개인 설정     POST|PATCH /prefs {patch} → 얕은 병합 저장
//   GET    /ai/targets                           → app_ai_targets        (#4488 앱 v2-9 — 고를 수 있는 실행 계정 · 작업 · 붙은 세션 · 만든 대화)
//   POST   /ai/runs            {prompt, schema, …} → app_ai_run           AI 실행 입구 하나(단발+API 키=프록시 · 그 밖=작업 컨테이너 · target:{fork} 는 붙은 세션 분기 #4489)
//   GET    /ai/runs?status&limit&fork_session    → app_ai_runs           GET /ai/runs/<id> → app_ai_run_get · POST /ai/runs/<id>/cancel → app_ai_run_cancel
//   POST   /jobs               {route, body, …}  → app_job_start         (#4486 앱 v2-7 — 이 앱 서버의 라우트를 뒤에서 · 15분)
//   GET    /jobs?status&limit                    → app_jobs              GET /jobs/<id>?wait → app_job_get · POST /jobs/<id>/cancel → app_job_cancel
//   (GET /me 는 앞단이 /api/app-front/me 로 따로 넘긴다 — app-front-routes.ts appFrontMe)
//  답: 성공은 그 도구의 결과 JSON 그대로. 실패는 `{error, code?, consent_url?}` + 상태 코드.
//   · 403 + code "consent_required" — 이 사람이 이 앱에 아직 동의하지 않았거나 예전 범위다. consent_url(라이블리 화면의 동의 자리)로
//     보내면 동의 뒤 이 앱 주소로 돌아온다 — SDK 는 `&next=<지금 경로>` 를 붙여 보낸다(web/v2/app-ui-runtime.ts). 돌아갈 주소는 라이블리 화면이
//     앱 id · 판 · 지금 워크스페이스로 스스로 만든다(web/lib/app-address.ts appGrantReturn — 링크가 주는 주소를 믿지 않는다).
//  ⓘ 쓰기의 출처 검사(같은 주소에서 온 것만)는 앞단이 한다(Origin · Sec-Fetch-Site). 여기 오는 요청은 그 검사를 지났다.
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http-error.js";
import { domainErrorReply } from "../http/rest-util.js";
import { logger } from "../log.js";
import { isScope } from "../auth/scopes.js";
import type { OrgApp } from "../org/store/apps.js";
import type { OrgMember } from "../org/store/members.js";
import type { TenantContext } from "../org/tenant-context.js";
import { addressViewFor } from "./visibility.js";
import { appDomain, appHost, type AppVariant } from "./app-address.js";
import type { AppFrontAct } from "./app-front-auth.js";
import { CONSENT_REQUIRED } from "./app-consent.js";

/** 앞단이 넘기는 본문 상한과 같다(게이트웨이 REST 전역 상한 1MB — 앱 서버가 /api/ui/store/* 로 보낼 수 있는 만큼). */
export const APP_FRONT_API_BODY_LIMIT = "1mb";
/** 동의가 필요하다는 표지 — apps/app-consent.ts 한 벌(웹 런타임도 이 글자로 가른다). */
export const CONSENT_CODE = CONSENT_REQUIRED;

export interface AppFrontApiDeps {
  /** 그 사람이 이 워크스페이스에 들어올 수 있나(셀프호스트 다중 워크스페이스의 등록부 — tenancy/gate). */
  workspaceAccess: (memberId: string) => Promise<boolean>;
  /** 앱 화면의 도구 하나를 그 앱 주체로(capabilities/app-tool-call.ts runAppTool). */
  runTool: (member: LivelyUser, appId: string, name: string, args: Record<string, unknown>, address: AppVariant) => Promise<unknown>;
  prefsGet: (member: LivelyUser, appId: string) => Promise<unknown>;
  prefsSet: (member: LivelyUser, appId: string, patch: unknown) => Promise<unknown>;
  /** 라이블리 화면의 공개 주소(동의 자리를 가리킬 때) — org 프로필 > PUBLIC_URL. 없으면 consent_url 을 싣지 않는다. */
  gatewayBase: () => Promise<string | null>;
}

export interface ApiReply { status: number; json: unknown }

/** 사람 구성원 → 그 사람의 주체(웹 로그인과 같은 «사람 본인»). 권한 축소(그 사람의 앱 동의)는 runAppTool 이 한다. */
export function memberPrincipal(m: Pick<OrgMember, "id" | "email" | "scopes">, address: AppVariant): LivelyUser {
  return {
    userId: m.id, email: m.email ?? "", scopes: (m.scopes ?? []).filter(isScope), projects: ["*"], tokenSource: "session",
    appAddress: address,
  };
}

const STORE_OP_RE = /^\/store\/([A-Za-z0-9_]{1,63})\/(query|insert|update|delete)$/;
const AI_RUN_RE = /^\/ai\/runs\/([1-9][0-9]{0,15})(\/cancel)?$/;
const JOB_RE = /^\/jobs\/([1-9][0-9]{0,15})(\/cancel)?$/;
const TOOL_RE = /^\/tools\/([a-z][a-z0-9_]{0,79})$/;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** 경로 → 무엇을 할지(순수 — 시험 대상). 못 알아들으면 null(404) · 그 경로에 없는 메서드면 "method"(405). */
export type ApiRoute =
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "prefs-get" }
  | { kind: "prefs-set"; patch: unknown };
export function routeAppFrontApi(method: string, path: string, body: unknown, query: Record<string, string> = {}): ApiRoute | "method" | null {
  const m = method.toUpperCase();
  const b = obj(body);
  // #4488 AI 실행 — 입구 하나와 그 둘레(보기 · 목록 · 취소 · 대상). app_id 는 주소가 정한다(본문의 app_id 는 받지 않는다).
  if (path === "/ai/targets") return m === "GET" || m === "HEAD" ? { kind: "tool", name: "app_ai_targets", args: {} } : "method";
  if (path === "/ai/runs") {
    if (m === "POST") return { kind: "tool", name: "app_ai_run", args: pick(b, ["prompt", "system", "schema", "job", "model", "label", "files", "project_id", "agent", "timeout_min", "wait", "target"]) };
    if (m === "GET" || m === "HEAD") {
      return { kind: "tool", name: "app_ai_runs", args: { ...(query.status ? { status: query.status } : {}), ...(query.limit ? { limit: Number(query.limit) } : {}), ...(query.fork_session ? { fork_session: query.fork_session } : {}) } };
    }
    return "method";
  }
  const ar = AI_RUN_RE.exec(path);
  if (ar) {
    const id = Number(ar[1]);
    if (ar[2]) return m === "POST" ? { kind: "tool", name: "app_ai_run_cancel", args: { id } } : "method";
    return m === "GET" || m === "HEAD" ? { kind: "tool", name: "app_ai_run_get", args: { id } } : "method";
  }
  // #4486 백그라운드 작업 — 이 앱 서버의 라우트를 뒤에서. app_id 는 주소가 정한다(본문의 app_id 는 받지 않는다).
  if (path === "/jobs") {
    if (m === "POST") return { kind: "tool", name: "app_job_start", args: pick(b, ["route", "body", "label", "timeout_s", "type", "wait"]) };
    if (m === "GET" || m === "HEAD") return { kind: "tool", name: "app_jobs", args: { ...(query.status ? { status: query.status } : {}), ...(query.limit ? { limit: Number(query.limit) } : {}) } };
    return "method";
  }
  const jr = JOB_RE.exec(path);
  if (jr) {
    const id = Number(jr[1]);
    if (jr[2]) return m === "POST" ? { kind: "tool", name: "app_job_cancel", args: { id } } : "method";
    return m === "GET" || m === "HEAD" ? { kind: "tool", name: "app_job_get", args: { id, ...(query.wait ? { wait: Number(query.wait) } : {}) } } : "method";
  }
  if (path === "/store/tables") return m === "GET" || m === "HEAD" ? { kind: "tool", name: "store_tables", args: {} } : "method";
  if (path === "/store/sql") return m === "POST" ? { kind: "tool", name: "store_sql", args: pick(b, ["sql", "params", "format", "strict"]) } : "method";
  if (path === "/store/sql/batch") return m === "POST" ? { kind: "tool", name: "store_sql_batch", args: pick(b, ["statements", "format", "strict"]) } : "method";
  const so = STORE_OP_RE.exec(path);
  if (so) {
    if (m !== "POST") return "method";
    const table = so[1] as string;
    const op = so[2] as "query" | "insert" | "update" | "delete";
    const fields = op === "query" ? ["match", "limit"] : op === "insert" ? ["row"] : op === "update" ? ["match", "set"] : ["match"];
    return { kind: "tool", name: `store_${op}`, args: { table, ...pick(b, fields) } };
  }
  const t = TOOL_RE.exec(path);
  if (t) return m === "POST" ? { kind: "tool", name: t[1] as string, args: b } : "method";
  if (path === "/prefs") {
    if (m === "GET" || m === "HEAD") return { kind: "prefs-get" };
    if (m === "POST" || m === "PATCH") return { kind: "prefs-set", patch: b.patch };
    return "method";
  }
  return null;
}
function pick(b: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (b[k] !== undefined) out[k] = b[k];
  return out;
}

/** 앱 주소 안 경로(앞단이 `?path=` 로 넘긴 `<경로>[?쿼리]`)에서 경로만. `/_lively` 는 앞단이 떼어 넘긴다. 꼴이 틀리면 null. */
export function apiPathOf(raw: unknown): string | null {
  return apiUrlOf(raw)?.pathname.replace(/\/+$/, "") || (apiUrlOf(raw) ? "/" : null);
}
/** 경로의 쿼리(짧은 값만 — 목록 좁히기용). 꼴이 틀리면 빈 객체. */
export function apiQueryOf(raw: unknown): Record<string, string> {
  const u = apiUrlOf(raw);
  const out: Record<string, string> = {};
  if (!u) return out;
  for (const [k, v] of u.searchParams) if (/^[a-z_]{1,32}$/.test(k) && v.length <= 64) out[k] = v;
  return out;
}
function apiUrlOf(raw: unknown): URL | null {
  const s = typeof raw === "string" ? raw : "";
  if (!s.startsWith("/") || s.startsWith("//") || s.length > 512 || /[\s\\\u0000-\u001f\u007f]/.test(s)) return null;
  let u: URL;
  try { u = new URL(s, "https://api.invalid"); } catch { return null; }
  if (u.origin !== "https://api.invalid") return null;
  return u;
}

/**
 * 동의 자리 — 라이블리 화면 `#/app-grant/<앱>?v=<판>` (web/v2/main.ts). SDK 가 `&next=<경로>` 를 붙인다. 돌아갈 앱 주소는 싣지 않는다 —
 *  라이블리 화면이 앱 id · 판 · 지금 워크스페이스로 만든다(격리 리뷰: 링크가 준 주소를 믿으면 같은 앱 id 의 남의 워크스페이스 주소로 보낼 수 있었다).
 *  앱 주소를 못 만드는 워크스페이스(꺼짐 · 이름)면 null — 돌아올 곳이 없는 동의 자리는 주지 않는다.
 */
export function consentUrlFor(base: string | null, tenantSlug: string, appId: string, variant: AppVariant, env: NodeJS.ProcessEnv): string | null {
  if (!base) return null;
  if (!appHost(tenantSlug, appId, variant, appDomain(env))) return null;
  return `${base.replace(/\/+$/, "")}/ui/#/app-grant/${encodeURIComponent(appId)}?${new URLSearchParams({ v: variant }).toString()}`;
}

/**
 * 실행 중 던진 것 → 상태 코드 · 글. HttpError 는 그대로, 스코프 판정(requireScope 의 «Forbidden:»)은 403, 그 밖은 500(글은 감춘다).
 *  ⚠ #4848 503 `{error:"busy"}`(code 없음)는 앞단(lvly-cloud appfront)만 쓰는 «본문을 받기 전에 거절» 표지다 — 앱 SDK 가 그 모양을 받으면
 *   retry-after 뒤 같은 요청을 한 번 다시 보낸다(web/v2/app-ui-runtime.ts frontBusy). 이미 실행한 쓰기의 답으로 그 모양을 내지 않는다.
 */
export function apiErrorReply(e: unknown, consentUrl: () => string | null): ApiReply {
  if (e instanceof HttpError) {
    //  5xx 는 로그에 남긴다(rest-util wrap 과 같은 규칙 #1278 — 도구 앞 단계의 실패는 mcp_call_log 에도 안 남는다).
    if (e.status >= 500) {
      const c = (e as { cause?: unknown }).cause;
      logger.error({ status: e.status, msg_out: e.message, cause: c instanceof Error ? { message: c.message, code: (c as NodeJS.ErrnoException).code } : c }, "[app-front] /_lively API 5xx");
    }
    const body = { ...(e.body ?? {}), error: e.message } as Record<string, unknown>;
    if (body.code === CONSENT_CODE) { const u = consentUrl(); if (u) body.consent_url = u; }
    return { status: e.status, json: body };
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/^Forbidden:/.test(msg)) return { status: 403, json: { error: "이 앱의 권한 밖입니다 — " + msg.replace(/^Forbidden:\s*/, "") } };
  //  도구가 던진 도메인 글(«없음» · 검증)은 REST 와 같은 4xx 로 — 안 보이는 대상과 없는 대상이 같은 404 다.
  //   내부 서비스 연결 실패(502)는 글에 주소가 실릴 수 있어 아래의 감춘 500 그대로 둔다.
  const mapped = domainErrorReply(msg);
  if (mapped && mapped.status !== 502) return { status: mapped.status, json: { error: mapped.error } };
  logger.error({ err: msg, stack: e instanceof Error ? e.stack : undefined }, "[app-front] /_lively API 처리 실패");
  return { status: 500, json: { error: "처리하지 못했습니다 — 잠시 뒤 다시 하세요" } };
}

/**
 * 한 요청을 처리한다 — 문(기계 헤더) · 사람 · 앱은 부르는 쪽(app-front-routes.ts)이 이미 봤다. 여기는 이 워크스페이스 출입 · 앱 켜짐 ·
 *  주소의 판 · 경로 → 실행.
 */
export async function handleAppFrontApi(
  input: { act: AppFrontAct; tenant: TenantContext; member: OrgMember; app: OrgApp; method: string; rawPath: unknown; body: unknown; env: NodeJS.ProcessEnv },
  d: AppFrontApiDeps,
): Promise<ApiReply> {
  const { act, tenant, member, app } = input;
  const path = apiPathOf(input.rawPath);
  if (!path) return { status: 400, json: { error: "앱 주소 안 경로를 읽지 못했습니다" } };
  const route = routeAppFrontApi(input.method, path, input.body, apiQueryOf(input.rawPath));
  if (route === null) return { status: 404, json: { error: `'/_lively${path}' 은(는) 없는 API 입니다 — store · tools · prefs · ai · me 를 쓰세요`, code: "not_found" } };
  if (route === "method") return { status: 405, json: { error: `'/_lively${path}' 은(는) ${input.method.toUpperCase()} 로 부를 수 없습니다`, code: "method_not_allowed" } };
  if (!(await d.workspaceAccess(member.id).catch(() => false))) return { status: 403, json: { error: "이 워크스페이스의 구성원만 앱을 쓸 수 있습니다" } };
  if (app.status !== "active" || !app.enabled) return { status: 409, json: { error: `앱 '${app.id}' 이(가) 지금 활성 상태가 아닙니다` } };
  //  주소의 판 — 초안 주소는 그 초안을 고친 사람만(남의 초안은 없는 판). 공개 주소는 모두에게 공개 판(초안을 고친 사람에게도).
  if (addressViewFor(app, { userId: member.id, scopes: member.scopes }, act.var) === "none") return { status: 404, json: { error: `앱 '${app.id}' 에 열 수 있는 초안 판이 없습니다` } };
  const who = memberPrincipal(member, act.var);
  let base: string | null | undefined;
  const consentUrl = (): string | null => consentUrlFor(base ?? null, tenant.slug, app.id, act.var, input.env);
  try {
    let out: unknown;
    if (route.kind === "tool") out = await d.runTool(who, app.id, route.name, route.args, act.var);
    else if (route.kind === "prefs-get") out = await d.prefsGet(who, app.id);
    else out = await d.prefsSet(who, app.id, route.patch);
    return { status: 200, json: out ?? null };
  } catch (e) {
    if (e instanceof HttpError && (e.body as { code?: unknown } | undefined)?.code === CONSENT_CODE) base = await d.gatewayBase().catch(() => null);
    return apiErrorReply(e, consentUrl);
  }
}
