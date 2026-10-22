// LLM 프록시 `/api/llm/anthropic/*` (#4488 앱 v2-9) — Anthropic Messages API 호환 주소. 워크스페이스 API 키는 여기서만 붙는다(설계 §3-E «프록시 = API 키 갈래 전체의 출구»).
//
//  누가 부르나(둘):
//   ① 실행 한정 토큰(`lvai_…` — ai-runs/service.bootEnvForJob): API 키 에이전트 작업의 Claude Code 가 ANTHROPIC_BASE_URL 로 부른다. 그 실행이 열려 있을 때만 유효.
//   ② 앱 서버 토큰(고급 길 — SDK 호환 주소): 워크스페이스에 API 키가 있고 앱이 permissions.ai_runs 를 선언했을 때만. 사람 신원 없이 앱 자체로 부른다.
//  둘 다 사용량을 org_app_llm_call 에 남기고 앱당 하루 토큰 · 워크스페이스 동시 상한을 본다. 본문은 바이트 그대로 흘려 보낸다(스트리밍 포함).
//  ⚠ 전역 express.json() 보다 **먼저** raw 로 받는다(index.ts) — 바이트가 바뀌면 안 되고 본문이 1MB 를 넘는다(Claude Code 의 맥락).
//  ⚠ 끊김은 **res** 의 close 로 듣는다 — raw 본문을 다 읽은 뒤에는 req 가 이미 끝나 있어 req 의 close 는 여기서 울리지 않는다(격리 리뷰 blocking 1).
//   클라이언트가 중간에 끊으면 위쪽 요청을 끊고(abort) 몸을 destroy 해 동시 슬롯을 바로 되돌린다 — 안 그러면 10분 상한까지 슬롯이 새고 위쪽이 토큰을 계속 만든다.
import type express from "express";
import { pipeline } from "node:stream/promises";
import { wrap, HttpError } from "../http/rest-util.js";
import { logger } from "../log.js";
import type { BearerVerifier } from "../auth/bearer.js";
import { PROXY_PATHS, forwardHeaders, forwardToAnthropic, zeroUsage, type ForwardResult, type Usage } from "./anthropic.js";
import type { AiRunDeps } from "./service.js";

export const LLM_PROXY_PREFIX = "/api/llm/anthropic";
export const LLM_PROXY_BODY_LIMIT = "32mb";
/** 위쪽(Anthropic) 응답을 기다리는 상한 — 스트리밍 긴 답까지. */
export const LLM_PROXY_TIMEOUT_MS = 10 * 60_000;

export type ProxyCaller = { caller: "run_token"; appId: string; runId: number; member: string } | { caller: "app_server"; appId: string; runId: null; member: null };

/** 시험이 바꿔 끼우는 자리 — 살아 있는 의존(DB · 자격 금고) · 토큰 판정 · 위쪽 호출 · 시간 상한. */
export interface LlmProxyDeps {
  deps(): Promise<AiRunDeps>;
  whoIs(token: string): Promise<ProxyCaller>;
  forward: typeof forwardToAnthropic;
  timeoutMs: number;
}

/** 토큰 → 부른 쪽. 실행 토큰(lvai_)은 열린 실행에서만 · 그 밖은 앱 서버 토큰(고급 길)만 · 사람 토큰 · 작업 토큰은 403. */
export async function liveWhoIs(verifier: BearerVerifier, token: string): Promise<ProxyCaller> {
  const live = await import("./live.js");
  const { PROXY_TOKEN_PREFIX, appDeclaresAiRuns } = await import("./service.js");
  if (token.startsWith(PROXY_TOKEN_PREFIX)) {
    const store = await import("./store.js");
    const run = await store.getAiRunByToken(live.hashProxyToken(token));
    if (!run) throw new HttpError(401, "실행 토큰이 유효하지 않습니다(끝난 실행이거나 모르는 토큰)");
    return { caller: "run_token", appId: run.app_id, runId: run.id, member: run.requester };
  }
  let auth: Awaited<ReturnType<BearerVerifier["verifyAccessToken"]>>;
  try { auth = await verifier.verifyAccessToken(token); } catch { throw new HttpError(401, "토큰이 유효하지 않습니다"); }
  const user = auth.extra as { userId?: string; appId?: string } | undefined;
  const { parseAppServerUserId } = await import("../apps/app-server-id.js");
  const srv = parseAppServerUserId(user?.userId);
  if (!srv || !user?.appId || srv.appId !== user.appId) throw new HttpError(403, "LLM 프록시는 앱 서버 토큰(고급 길) 또는 실행 토큰으로만 부를 수 있습니다");
  const { getApp } = await import("../org/store/apps.js");
  const a = await getApp(user.appId);
  if (!a || a.status !== "active" || !a.enabled) throw new HttpError(409, `앱 '${user.appId}' 이 활성 상태가 아닙니다`);
  if (!appDeclaresAiRuns(a)) throw new HttpError(403, `앱 '${user.appId}' 은(는) AI 실행(permissions.ai_runs)을 선언하지 않았습니다`);
  return { caller: "app_server", appId: user.appId, runId: null, member: null };
}

export function tokenOfRequest(headers: Record<string, string | string[] | undefined>): string {
  const m = /^Bearer\s+(\S+)$/i.exec(String(headers.authorization ?? ""));
  if (m) return m[1]!;
  const k = headers["x-api-key"];
  return (Array.isArray(k) ? k[0] : k) ?? "";
}

/** 라우트 본체 — 시험이 가짜 의존으로 express 에 꽂는다. */
export function llmProxyHandler(p: LlmProxyDeps): express.RequestHandler {
  return wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const path = req.path.slice(LLM_PROXY_PREFIX.length).replace(/\/+$/, "");
    if (!PROXY_PATHS.has(path)) throw new HttpError(404, `이 프록시는 ${[...PROXY_PATHS].join(" · ")} 만 흘려 보냅니다`);
    const token = tokenOfRequest(req.headers);
    if (!token) throw new HttpError(401, "자격이 없습니다 — Authorization: Bearer <실행 토큰> 또는 x-api-key");
    const who = await p.whoIs(token);
    const d = await p.deps();
    const { overDailyBudget } = await import("./plan.js");
    const key = await d.apiKey();
    const workspaceId = (await d.apiWorkspaceId?.()) ?? null;
    if (!key) throw new HttpError(503, "이 워크스페이스에 Anthropic API 키가 없습니다 — 관리자가 관리탭 ▸ 서비스 로그인(또는 org_credential_set kind=anthropic_api_key)으로 등록해야 합니다");
    const pol = await d.policy();
    if (overDailyBudget(await d.store.tokensUsedTodayByApp(who.appId), pol.daily_tokens_per_app)) {
      throw new HttpError(429, `이 앱의 오늘 토큰 상한(${pol.daily_tokens_per_app.toLocaleString()})을 다 썼습니다`);
    }
    const tenant = d.tenant();
    if (!d.inflight.take(tenant, pol.max_inflight)) throw new HttpError(429, `이 워크스페이스의 AI 호출이 동시에 ${pol.max_inflight}개 돌고 있습니다 — 잠시 뒤 다시`);
    const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}), "utf8");
    let stream = false, model: string | null = null;
    try { const j = JSON.parse(body.toString("utf8")) as Record<string, unknown>; stream = j.stream === true; if (typeof j.model === "string") model = j.model; } catch { /* 위쪽이 400 으로 답한다 */ }
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), p.timeoutMs);
    let upstream: ForwardResult | null = null;
    //  클라이언트가 먼저 끊었다 — 위쪽도 끊고 몸을 버린다(슬롯 반환은 finally).
    const onClientGone = (): void => { if (!res.writableEnded) { ac.abort(); upstream?.body?.destroy(); } };
    res.on("close", onClientGone);
    const record = async (status: number | null, usage: Usage, m: string | null, error: string | null): Promise<void> => {
      await d.store.insertLlmCall({
        appId: who.appId, runId: who.runId, caller: who.caller, member: who.member, model: m ?? model, path, stream, status,
        inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadTokens: usage.cache_read_tokens, cacheWriteTokens: usage.cache_write_tokens,
        durationMs: Date.now() - started, error,
      }).catch((e) => logger.warn({ app: who.appId, err: (e as Error)?.message }, "[llm-proxy] 계측 기록 실패"));
    };
    try {
      upstream = await p.forward({ path, headers: forwardHeaders(req.headers, key, workspaceId), body, stream, signal: ac.signal });
      res.status(upstream.status);
      for (const [k, v] of Object.entries(upstream.headers)) res.setHeader(k, v);
      if (!upstream.body) { res.end(); await record(upstream.status, (await upstream.usage).usage, null, null); return; }
      //  pipeline — 위쪽 몸이 오류로 끝나면 응답도 닫히고(열린 채 안 남는다), 응답이 먼저 닫히면 위쪽 몸도 destroy 된다.
      let pipeErr: string | null = null;
      try { await pipeline(upstream.body, res); } catch (e) { pipeErr = ac.signal.aborted ? "연결 끊김" : (e as Error)?.message ?? String(e); }
      const u = await upstream.usage;
      await record(upstream.status, u.usage, u.model, pipeErr ?? (upstream.status >= 400 ? `HTTP ${upstream.status}` : null));
    } catch (e) {
      const why = ac.signal.aborted ? "시간 상한 또는 연결 끊김" : (e as Error)?.message ?? String(e);
      await record(null, zeroUsage(), null, why);
      if (!res.headersSent) throw new HttpError(502, `LLM 에 닿지 못했습니다: ${why}`.slice(0, 300));
      if (!res.writableEnded) res.end();
    } finally {
      clearTimeout(timer);
      res.off("close", onClientGone);
      d.inflight.release(tenant);
    }
  }, { logPath: `${LLM_PROXY_PREFIX}/*` });
}

export function registerLlmProxyRoutes(app: express.Express, verifier: BearerVerifier): void {
  app.post(`${LLM_PROXY_PREFIX}/*`, llmProxyHandler({
    deps: async () => (await import("./live.js")).liveAiRunDeps(),
    whoIs: (token) => liveWhoIs(verifier, token),
    forward: forwardToAnthropic,
    timeoutMs: LLM_PROXY_TIMEOUT_MS,
  }));
}
