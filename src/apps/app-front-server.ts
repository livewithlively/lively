// 앱 주소 → 앱 서버 함수(#4485 앱 v2-6) — 앱 주소의 요청을 그 앱의 Lambda 함수(별칭 cur · pub)에 넘기고 응답을 조각째 잇는다.
//
//  길(설계 §19 · 상민 2026-10-16 «게이트웨이가 직접 부름»): 브라우저 → Caddy → CP 라우터(앱 갈래: 로그인 쿠키 · 출처 검사 · 신원 서명)
//   → 게이트웨이(/api/app-front/page · /server — 여기) → Lambda InvokeWithResponseStream(함수 주소 없음 — 인터넷에서 함수를 부를 길이 없다)
//   → 함수 안 검사 층(app-server-guard: 신원 서명 검사) → 앱($PORT).
//  여기서 하는 일:
//   · 판 고르기 — 주소의 판(addressViewFor)이 공개 판이면 별칭 pub, 아니면 cur(v2-5 as-built «cur = 고친 사람이 보는 판 · pub = 공개 판»).
//   · 신원 — 앞단이 서명한 X-Lively-Identity 를 그대로 싣는다. 넘기기 전에 이 요청의 사람 · 주소의 판과 같은지 한 번 본다(앞단 기계 헤더와 엇갈리지 않게).
//   · 동시 처리 상한(#4792 결정) · 호출 세기(자동 멈춤 감시) — app-server-usage.
//   · 요청 → 함수 주소 모양 이벤트(웹 어댑터가 받는 틀): 우리 머리글(x-lvly-* · 테넌트 비밀)은 절대 넘기지 않는다 · Host 는 앱 주소 · 쿠키는 cookies 배열.
//   · 응답: 앞머리(상태 · 머리글 · 쿠키)를 쓰고 본문을 조각째 흘려 보낸다(SSE 가 된다). 앱의 화면 끼우기 규칙(X-Frame-Options · CSP frame-ancestors)은
//     걷는다 — 앱 주소를 어디에 끼울지는 앞단이 정한다(라이블리 워크스페이스 화면만 · CP 라우터가 frame-ancestors 를 붙인다). 쿠키는 앞단이 고쳐 넘긴다
//     (그래서 이 응답임을 x-lvly-app-server: 1 로 알린다 — 앞단이 지우고 넘긴다).
//   · 앱이 본문을 보내다 죽거나 시간이 넘으면(REPORT «Status: error|timeout» · 흐름 끝의 ErrorCode) 연결을 끊는다 — 잘린 응답을 온전히 끝난 것처럼 닫지 않는다.
//   · 브라우저가 떠나도 함수 흐름은 끝까지 읽는다(자리 · 실행 시간 셈을 지키려고 — serveAppServer 안 ★).
import type express from "express";
import crypto from "node:crypto";
import { logger } from "../log.js";
import { HttpError } from "../http-error.js";
import type { TenantContext } from "../org/tenant-context.js";
import type { OrgApp } from "../org/store/apps.js";
import type { OrgMember } from "../org/store/members.js";
import type { AppFrontAct } from "./app-front-auth.js";
import { appErrorHtml } from "./app-front-page.js";
import { appDomain, appHost } from "./app-address.js";
import { appServerEnv } from "./app-server-config.js";
import { realLambdaApi, type LambdaApi } from "./app-server-deploy.js";
import { startHttpStream, lambdaErrorOf, type Complete, type HttpPrelude } from "./app-server-stream.js";
import { APP_IDENTITY_HEADER, appIdentityKeysFromEnv, verifyAppIdentity } from "./app-identity.js";
import { acquireInflight, recordAppServerCall } from "./app-server-usage.js";
import * as st from "./app-server-store.js";
import type { AppServerPolicy } from "./app-server-policy.js";
import { parseReport } from "../net/aws/lambda-lite.js";
import { AwsError } from "../net/aws/aws-json.js";

/** 앱 서버로 넘기는 요청 본문 상한 — Lambda 호출 한 번의 한도(6MB)가 이벤트(본문은 base64 로 ⁴⁄₃)까지 담아야 한다. 앞단(CP 라우터)도 같은 값으로 끊는다. */
export const APP_SERVER_BODY_LIMIT = 4 * 1024 * 1024;
/** 앞단이 «이 응답은 앱 서버의 것» 으로 읽는 표지(쿠키를 고쳐 넘긴다 · 브라우저로는 안 나간다). */
export const APP_SERVER_MARK = "x-lvly-app-server";

export interface ServerTarget {
  tenant: TenantContext;
  act: AppFrontAct;
  member: OrgMember;
  app: OrgApp;
  /** 주소의 판 — installed(지금 판 · 초안 주소 · 나만 보는 앱 · 초안 없는 공개 앱) | published(남의 초안이 걸린 공개 앱의 공개 주소). */
  view: "installed" | "published";
}

export interface AppServerFrontDeps {
  env: NodeJS.ProcessEnv;
  api?: LambdaApi;
  getServerRow: (appId: string) => Promise<st.ServerRow | null>;
  policy: () => Promise<AppServerPolicy>;
  now?: () => number;
  /** 시험 — 호출 셈(기본 = app-server-usage recordAppServerCall). */
  record?: (appId: string, r: { billedMs?: number | null; error?: boolean; rejected?: boolean }) => void;
}

const policyCache = new Map<string, { at: number; p: AppServerPolicy }>();
/** 상한은 요청마다 DB 를 읽지 않게 10초 기억한다(관리자가 바꾸면 10초 안에 반영). */
async function cachedPolicy(tenantId: string): Promise<AppServerPolicy> {
  const hit = policyCache.get(tenantId);
  if (hit && Date.now() - hit.at < 10_000) return hit.p;
  const p = await st.appServerPolicy();
  policyCache.set(tenantId, { at: Date.now(), p });
  return p;
}
export const liveServerFrontDeps = (tenantId: string): AppServerFrontDeps => ({
  env: process.env,
  getServerRow: (id) => st.getServerRow(id),
  policy: () => cachedPolicy(tenantId),
});

//  중계자가 넘기지 않는 머리글(RFC 9110 §7.6.1) + 본문 길이(웹 어댑터가 본문에서 다시 정한다).
const HOP_REQ = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "expect", "host"]);
const HOP_RES = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

/**
 * CSP 에서 frame-ancestors 지시를 뺀다(순수). 같은 이름 머리글 여러 줄은 쉼표로 이어져 온다(parsePrelude) — 쉼표는 정책 사이의 구분이라
 *  (CSP3 serialized-policy-list) 정책마다 뺀 뒤 빈 정책은 버린다. 남는 게 없으면 null.
 */
export function stripFrameAncestors(csp: string): string | null {
  const policies = csp.split(",").map((pol) => pol.split(";").map((d) => d.trim()).filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d)).join("; "))
    .filter(Boolean);
  return policies.length ? policies.join(", ") : null;
}

/** 앞단 → 게이트웨이로 온 경로(경로 + 쿼리, 인코딩된 그대로) → rawPath · rawQueryString. `/` 로 시작하지 않으면 null. */
export function splitAppPath(raw: unknown): { rawPath: string; rawQueryString: string } | null {
  const s = String(raw ?? "");
  if (!s.startsWith("/") || s.startsWith("//") || s.length > 8192 || /[\u0000-\u001f\u007f\s]/.test(s)) return null;
  const i = s.indexOf("?");
  return i < 0 ? { rawPath: s, rawQueryString: "" } : { rawPath: s.slice(0, i), rawQueryString: s.slice(i + 1) };
}

/**
 * 요청 → 함수 주소(Function URL) 모양 이벤트(순수 — 시험 대상). 웹 어댑터는 rawPath · rawQueryString · headers · cookies · body 로 앱에 보낼 HTTP 요청을 만든다.
 *  ★ x-lvly-* (테넌트 비밀 · 앞단 기계 헤더) · 신원 말고의 x-lively-* · Authorization 은 절대 싣지 않는다 — 앱 코드가 그대로 본다.
 */
export function buildFunctionUrlEvent(i: {
  method: string; headers: Record<string, string | string[] | undefined>; path: { rawPath: string; rawQueryString: string };
  host: string; identity: string; body: Buffer | null; requestId: string; now: number;
}): Record<string, unknown> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (HOP_REQ.has(lk) || lk === "cookie" || lk === "authorization" || lk === "proxy-authorization") continue;
    if (lk.startsWith("x-lvly-") || lk.startsWith("x-lively-")) continue;
    headers[lk] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  headers.host = i.host;
  headers["x-forwarded-host"] = i.host;
  headers["x-forwarded-proto"] = "https";
  headers[APP_IDENTITY_HEADER] = i.identity;
  const rawCookie = i.headers.cookie;
  const cookieLine = Array.isArray(rawCookie) ? rawCookie.join("; ") : String(rawCookie ?? "");
  const cookies = cookieLine.split(";").map((c) => c.trim()).filter(Boolean);
  const sourceIp = String(headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() || "0.0.0.0";
  const method = i.method.toUpperCase();
  return {
    version: "2.0", routeKey: "$default", rawPath: i.path.rawPath, rawQueryString: i.path.rawQueryString,
    ...(cookies.length ? { cookies } : {}),
    headers,
    requestContext: {
      accountId: "anonymous", apiId: "lively", domainName: i.host, domainPrefix: i.host.split(".")[0] ?? i.host,
      http: { method, path: i.path.rawPath, protocol: "HTTP/1.1", sourceIp, userAgent: headers["user-agent"] ?? "" },
      requestId: i.requestId, routeKey: "$default", stage: "$default", time: new Date(i.now).toUTCString(), timeEpoch: i.now,
    },
    ...(i.body && i.body.length ? { body: i.body.toString("base64"), isBase64Encoded: true } : { isBase64Encoded: false }),
  };
}

/** 앱의 응답 앞머리 → 우리가 쓸 머리글(순수). 홉 · 우리 접두 · 화면 끼우기 규칙을 걷고, 쿠키는 따로. */
export function responseHeadersOf(p: HttpPrelude): { headers: Record<string, string>; cookies: string[] } {
  const headers: Record<string, string> = {};
  const cookies = [...p.cookies];
  for (const [k, v] of Object.entries(p.headers)) {
    const lk = k.toLowerCase();
    if (HOP_RES.has(lk) || lk.startsWith("x-lvly-") || lk === "x-lively-guard" || lk === "x-frame-options") continue;
    if (lk === "set-cookie") { cookies.push(v); continue; }
    if (lk === "content-security-policy") { const c = stripFrameAncestors(v); if (c) headers[lk] = c; continue; }
    headers[lk] = v;
  }
  return { headers, cookies };
}

function wantsHtml(req: express.Request): boolean {
  const accept = String(req.headers.accept ?? "");
  const mode = String(req.headers["sec-fetch-mode"] ?? "");
  return /text\/html/.test(accept) && (mode === "navigate" || !mode);
}

function failReply(req: express.Request, res: express.Response, status: number, code: string, title: string, detail: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) { res.destroy(); return; }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  if (wantsHtml(req)) { res.status(status).type("html").send(appErrorHtml(title, detail)); return; }
  res.status(status).json({ error: code, message: `${title} — ${detail}` });
}

/**
 * 잘린 응답 끝내기 — 이미 쓴 조각은 보내고(소켓 쓰기를 비운 뒤) 마지막 조각 표시 없이 연결을 닫는다. 받는 쪽은 «덜 끝난 응답» 으로 안다.
 *  res.destroy() 를 바로 부르면 아직 소켓에 안 나간 조각까지 버린다.
 */
function abortAfterFlush(res: express.Response): void {
  const sock = res.socket as (import("node:net").Socket & { destroySoon?: () => void }) | null;
  if (sock && !sock.destroyed && typeof sock.destroySoon === "function") sock.destroySoon();
  else res.destroy();
}

async function writeChunk(res: express.Response, buf: Buffer): Promise<boolean> {
  if (!buf.length) return !res.destroyed;
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(buf)) return true;
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean): void => { res.off("drain", onDrain); res.off("close", onClose); resolve(ok); };
    const onDrain = (): void => done(true);
    const onClose = (): void => done(false);
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

/**
 * 앱 서버로 넘기고 응답을 잇는다. 이 함수가 응답을 끝까지 맡는다(헤더 · 본문 · 끊기).
 *  body — 앞단이 넘긴 본문(쓰기 요청) · GET/HEAD 는 null. rawPath — 앞단이 넘긴 «경로 + 쿼리»(인코딩된 그대로).
 */
export async function serveAppServer(req: express.Request, res: express.Response, t: ServerTarget, body: Buffer | null, rawPath: unknown,
  deps: AppServerFrontDeps = liveServerFrontDeps(t.tenant.id)): Promise<void> {
  const env = appServerEnv(deps.env, t.tenant.slug);
  if (!env) return failReply(req, res, 503, "app_server_off", "앱 서버를 열 수 없습니다", "이 워크스페이스는 앱 서버 실행이 꺼져 있습니다.");
  const path = splitAppPath(rawPath);
  if (!path) return failReply(req, res, 400, "bad_path", "주소가 틀렸습니다", "앱 주소 안의 경로를 읽지 못했습니다.");
  const domain = appDomain(deps.env);
  const host = domain ? appHost(t.tenant.slug, t.app.id, t.act.var, domain) : null;
  if (!host) return failReply(req, res, 404, "no_address", "앱 주소가 없습니다", "이 앱은 앱 주소를 만들 수 없습니다.");
  const alias: st.AliasName = t.view === "published" ? "pub" : "cur";
  const row = await deps.getServerRow(t.app.id);
  const version = alias === "pub" ? row?.pub_lambda_version : row?.cur_lambda_version;
  if (!row || !version) {
    return failReply(req, res, 503, "app_server_not_deployed", "앱 서버가 아직 올라가지 않았습니다",
      "앱을 만든 사람이 「이대로 넣기」 또는 app_server_deploy 로 서버를 올리면 열립니다.");
  }
  //  그 판에 앱 토큰 기록이 없다 = v2-6 전(v2-5)에 올린 판 — 검사 층 · 흘려 보내기 설정이 없어 부르면 알 수 없는 오류가 된다. 다시 올리라고 말한다.
  if (!(alias === "pub" ? row.pub_token_hash : row.cur_token_hash)) {
    return failReply(req, res, 503, "app_server_outdated", "앱 서버를 다시 올려야 합니다",
      "이 판은 앱 주소에서 부르는 설정 전에 올라갔습니다. 앱을 만든 사람이 「이대로 넣기」 또는 app_server_deploy 로 다시 올리면 열립니다.");
  }
  if (row.stopped_at) {
    return failReply(req, res, 503, "app_server_stopped", "앱 서버가 멈춰 있습니다",
      `${row.stop_reason ? `까닭: ${row.stop_reason}. ` : ""}관리자(손으로 멈췄으면 책임자)가 다시 켜면 열립니다.`);
  }
  //  신원 — 앞단 기계 헤더(act)와 같은 사람 · 같은 판이어야 한다. 신원 서명 키가 앞단에 없으면(운영 설정 전) 앱 서버로 넘길 수 없다.
  const identity = String((Array.isArray(req.headers[APP_IDENTITY_HEADER]) ? req.headers[APP_IDENTITY_HEADER]![0] : req.headers[APP_IDENTITY_HEADER]) ?? "");
  if (!identity) {
    return failReply(req, res, 503, "identity_signing_off", "앱 서버를 열 수 없습니다", "앱 주소 앞단의 사람 신원 서명이 아직 켜져 있지 않습니다(운영 설정).");
  }
  try {
    const c = verifyAppIdentity(identity, { ws: t.tenant.id, app: t.app.id }, { keys: appIdentityKeysFromEnv(deps.env), ...(deps.now ? { now: Math.floor(deps.now() / 1000) } : {}) });
    if (c.sub !== t.act.mid || c.var !== t.act.var) throw new HttpError(401, "앞단 기계 헤더와 신원이 다릅니다");
  } catch (e) {
    logger.warn({ app: t.app.id, why: (e as Error)?.message }, "[app-front-server] 신원이 맞지 않아 앱 서버로 넘기지 않았다");
    return failReply(req, res, 401, "identity_invalid", "로그인을 다시 확인해야 합니다", "화면을 새로 고치면 새 신원을 받습니다.");
  }
  const policy = await deps.policy();
  const slot = acquireInflight(t.app.id, { workspace: policy.max_inflight_workspace, app: policy.max_inflight_app });
  if (typeof slot !== "function") {
    (deps.record ?? recordAppServerCall)(t.app.id, { rejected: true });
    return failReply(req, res, 429, "app_server_busy", "앱 서버가 지금 바쁩니다",
      slot.denied === "app" ? `이 앱이 동시에 처리하는 요청이 상한(${slot.limit}개)에 닿았습니다. 잠시 뒤 다시 해 주세요.`
        : `이 워크스페이스의 앱 서버가 동시에 처리하는 요청이 상한(${slot.limit}개)에 닿았습니다. 잠시 뒤 다시 해 주세요.`,
      { "Retry-After": "2" });
  }
  const now = (deps.now ?? Date.now)();
  const t0 = Date.now();
  //  ★ 브라우저가 떠나도 함수 흐름을 끊지 않는다 — Lambda 는 부른 쪽이 끊어도 함수가 끝날 때(또는 시간)까지 돈다. 끊고 자리를 돌려주면
  //   «부르고 곧 끊기» 를 되풀이해 동시 처리 상한을 넘기고, 실행 시간도 끊은 때까지만 세어 자동 멈춤이 덜 본다(격리 리뷰).
  //   그래서 남은 흐름은 끝까지 읽어 버리고(브라우저로는 안 보낸다) 그동안 자리를 쥐며, 끝나면 REPORT 의 청구 시간으로 센다.
  //   흐름은 invokeStream 의 시한(요청 상한 + 5초)이 끊는다.
  let counted = false;
  const count = (r: { billedMs?: number | null; error?: boolean }): void => { if (!counted) { counted = true; (deps.record ?? recordAppServerCall)(t.app.id, r); } };
  try {
    const event = buildFunctionUrlEvent({
      method: req.method, headers: req.headers as Record<string, string | string[] | undefined>, path, host, identity, body,
      requestId: crypto.randomUUID(), now,
    });
    const api = deps.api ?? realLambdaApi(env.region);
    let out;
    try {
      out = await api.invokeStream(row.function_name, alias, JSON.stringify(event), { timeoutMs: policy.timeout_s * 1000 + 5_000, logTail: true });
    } catch (e) {
      count({ billedMs: Date.now() - t0, error: true });
      if (res.destroyed) return;
      if (e instanceof AwsError) {
        logger.warn({ app: t.app.id, fn: row.function_name, alias, code: e.code, status: e.status }, "[app-front-server] 앱 서버 함수를 부르지 못했다");
        if (e.code === "TooManyRequestsException") return failReply(req, res, 503, "app_server_throttled", "앱 서버가 지금 바쁩니다", "잠시 뒤 다시 해 주세요.", { "Retry-After": "5" });
        if (e.code === "ResourceNotFoundException") return failReply(req, res, 503, "app_server_missing", "앱 서버를 찾지 못했습니다", "앱을 만든 사람이 서버를 다시 올려야 합니다(app_server_deploy).");
        if (e.code === "Timeout") return failReply(req, res, 504, "app_server_timeout", "앱 서버가 제때 답하지 않았습니다", `요청 하나는 ${policy.timeout_s}초까지입니다 — 더 긴 일은 /jobs 로 넘겨야 합니다.`);
      } else {
        logger.warn({ app: t.app.id, err: (e as Error)?.message }, "[app-front-server] 앱 서버 호출 실패");
      }
      return failReply(req, res, 502, "app_server_unavailable", "앱 서버에 닿지 못했습니다", "잠시 뒤 다시 해 주세요.");
    }
    const start = await startHttpStream(out);
    if (start.kind === "error") {
      let complete = start.complete;
      if (!complete) for await (const ev of out.events) if (ev.type === "complete") { complete = ev; break; }
      const rep = complete ? parseReport(complete.log) : null;
      count({ billedMs: rep?.billedMs ?? Date.now() - t0, error: true });
      const le = lambdaErrorOf(start.payload);
      logger.warn({ app: t.app.id, fn: row.function_name, alias, type: le.type, status: rep?.status }, "[app-front-server] 앱 서버가 응답을 시작하지 못했다");
      //  요청 하나가 함수 시간을 넘겼다 — 앞머리 전에 넘기면 이 길로 온다(2026-10-16 AWS 실측: errorType Sandbox.Timedout · REPORT Status: timeout).
      if (rep?.status === "timeout" || le.type === "Sandbox.Timedout") {
        return failReply(req, res, 504, "app_server_timeout", "앱 서버가 제때 답하지 않았습니다", `요청 하나는 ${policy.timeout_s}초까지입니다 — 더 긴 일은 /jobs 로 넘겨야 합니다.`);
      }
      return failReply(req, res, 502, "app_server_error", "앱 서버가 응답하지 못했습니다",
        le.type === "Runtime.ExitError" ? "서버 프로그램이 요청을 처리하다 끝났습니다. 앱을 만든 사람이 서버 기록을 확인해야 합니다."
          : `서버가 오류로 끝났습니다(${le.type ?? rep?.errorType ?? "까닭 모름"}).`);
    }
    const { headers, cookies } = responseHeadersOf(start.prelude);
    res.status(start.prelude.statusCode);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    if (cookies.length) res.setHeader("set-cookie", cookies);
    res.setHeader(APP_SERVER_MARK, "1");
    res.flushHeaders();
    let alive = await writeChunk(res, start.first);
    let complete: Complete | null = null;
    for await (const ev of start.rest) {
      if (ev.type === "complete") { complete = ev; break; }
      if (alive) alive = await writeChunk(res, ev.data);   // 브라우저가 떠났으면 읽기만 한다(위 ★)
    }
    const rep = complete ? parseReport(complete.log) : null;
    //  앱 쪽 실패 — 흐름이 끝 표시 없이 끝남 · 흐름 끝에 AWS 오류 칸(ErrorCode) · REPORT 가 error/timeout. 브라우저가 떠난 것은 앱의 오류가 아니다(셈에서 가른다).
    const appFailed = !complete || !!complete.errorCode || (rep !== null && rep.status !== "ok");
    count({ billedMs: rep?.billedMs ?? Date.now() - t0, error: appFailed });
    if (!alive) { res.destroy(); return; }   // 브라우저가 떠났다 — 보낼 곳이 없다
    if (appFailed) {
      logger.warn({ app: t.app.id, fn: row.function_name, alias, status: rep?.status ?? "no-complete", type: rep?.errorType ?? complete?.errorCode }, "[app-front-server] 앱 서버 응답이 중간에 끊겼다 — 연결을 끊는다");
      abortAfterFlush(res);   // 잘린 응답 — 온전히 끝난 것처럼 닫지 않는다
      return;
    }
    res.end();
  } catch (e) {
    count({ billedMs: Date.now() - t0, error: true });
    if (!res.headersSent && !res.destroyed) {
      logger.warn({ app: t.app.id, err: (e as Error)?.message }, "[app-front-server] 앱 서버 응답을 잇다 실패");
      return failReply(req, res, 502, "app_server_stream_error", "앱 서버 응답을 받지 못했습니다", "잠시 뒤 다시 해 주세요.");
    }
    res.destroy();
  } finally {
    slot();
  }
}
