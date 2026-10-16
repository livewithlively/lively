// LLM 프록시 `/api/llm/anthropic/*` (#4488 앱 v2-9) — Anthropic Messages API 호환 주소. 워크스페이스 API 키는 여기서만 붙는다(설계 §3-E «프록시 = API 키 갈래 전체의 출구»).
//
//  누가 부르나(둘):
//   ① 실행 한정 토큰(`lvai_…` — ai-runs/service.bootEnvForJob): API 키 에이전트 작업의 Claude Code 가 ANTHROPIC_BASE_URL 로 부른다. 그 실행이 열려 있을 때만 유효.
//   ② 앱 서버 토큰(고급 길 — SDK 호환 주소): 워크스페이스에 API 키가 있고 앱이 permissions.ai_runs 를 선언했을 때만. 사람 신원 없이 앱 자체로 부른다.
//  둘 다 사용량을 org_app_llm_call 에 남기고 앱당 하루 토큰 · 워크스페이스 동시 상한을 본다. 본문은 바이트 그대로 흘려 보낸다(스트리밍 포함).
//  ⚠ 전역 express.json() 보다 **먼저** raw 로 받는다(index.ts) — 바이트가 바뀌면 안 되고 본문이 1MB 를 넘는다(Claude Code 의 맥락).
import type express from "express";
import { wrap, HttpError } from "../http/rest-util.js";
import { logger } from "../log.js";
import type { BearerVerifier } from "../auth/bearer.js";
import { PROXY_PATHS, forwardHeaders, forwardToAnthropic } from "./anthropic.js";

export const LLM_PROXY_PREFIX = "/api/llm/anthropic";
export const LLM_PROXY_BODY_LIMIT = "32mb";
/** 위쪽(Anthropic) 응답을 기다리는 상한 — 스트리밍 긴 답까지. */
export const LLM_PROXY_TIMEOUT_MS = 10 * 60_000;

type Caller = { caller: "run_token"; appId: string; runId: number; member: string } | { caller: "app_server"; appId: string; runId: null; member: null };

export function registerLlmProxyRoutes(app: express.Express, verifier: BearerVerifier): void {
  const tokenOf = (req: express.Request): string => {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""));
    if (m) return m[1]!;
    const k = req.headers["x-api-key"];
    return (Array.isArray(k) ? k[0] : k) ?? "";
  };
  const whoIs = async (req: express.Request): Promise<Caller> => {
    const token = tokenOf(req);
    if (!token) throw new HttpError(401, "자격이 없습니다 — Authorization: Bearer <실행 토큰> 또는 x-api-key");
    const live = await import("./live.js");
    const { PROXY_TOKEN_PREFIX } = await import("./service.js");
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
    const { appDeclaresAiRuns } = await import("./service.js");
    const a = await getApp(user.appId);
    if (!a || a.status !== "active" || !a.enabled) throw new HttpError(409, `앱 '${user.appId}' 이 활성 상태가 아닙니다`);
    if (!appDeclaresAiRuns(a)) throw new HttpError(403, `앱 '${user.appId}' 은(는) AI 실행(permissions.ai_runs)을 선언하지 않았습니다`);
    return { caller: "app_server", appId: user.appId, runId: null, member: null };
  };

  app.post(`${LLM_PROXY_PREFIX}/*`, wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const path = req.path.slice(LLM_PROXY_PREFIX.length).replace(/\/+$/, "");
    if (!PROXY_PATHS.has(path)) throw new HttpError(404, `이 프록시는 ${[...PROXY_PATHS].join(" · ")} 만 흘려 보냅니다`);
    const who = await whoIs(req);
    const d = await (await import("./live.js")).liveAiRunDeps();
    const { overDailyBudget } = await import("./plan.js");
    const key = await d.apiKey();
    if (!key) throw new HttpError(503, "이 워크스페이스에 Anthropic API 키가 없습니다 — 관리자가 org_credential_set kind=anthropic_api_key 로 등록해야 합니다");
    const p = await d.policy();
    if (overDailyBudget(await d.store.tokensUsedTodayByApp(who.appId), p.daily_tokens_per_app)) {
      throw new HttpError(429, `이 앱의 오늘 토큰 상한(${p.daily_tokens_per_app.toLocaleString()})을 다 썼습니다`);
    }
    const tenant = d.tenant();
    if (!d.inflight.take(tenant, p.max_inflight)) throw new HttpError(429, `이 워크스페이스의 AI 호출이 동시에 ${p.max_inflight}개 돌고 있습니다 — 잠시 뒤 다시`);
    const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}), "utf8");
    let stream = false, model: string | null = null;
    try { const j = JSON.parse(body.toString("utf8")) as Record<string, unknown>; stream = j.stream === true; if (typeof j.model === "string") model = j.model; } catch { /* 위쪽이 400 으로 답한다 */ }
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), LLM_PROXY_TIMEOUT_MS);
    req.on("close", () => { if (!res.writableEnded) ac.abort(); });
    const record = async (status: number | null, usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }, m: string | null, error: string | null): Promise<void> => {
      await d.store.insertLlmCall({
        appId: who.appId, runId: who.runId, caller: who.caller, member: who.member, model: m ?? model, path, stream, status,
        inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadTokens: usage.cache_read_tokens, cacheWriteTokens: usage.cache_write_tokens,
        durationMs: Date.now() - started, error,
      }).catch((e) => logger.warn({ app: who.appId, err: (e as Error)?.message }, "[llm-proxy] 계측 기록 실패"));
    };
    try {
      const r = await forwardToAnthropic({ path, headers: forwardHeaders(req.headers, key), body, stream, signal: ac.signal });
      res.status(r.status);
      for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
      if (!r.body) { res.end(); await record(r.status, (await r.usage).usage, null, null); return; }
      await new Promise<void>((resolve) => {
        r.body!.on("error", () => resolve());
        res.on("close", () => resolve());
        r.body!.pipe(res).on("finish", () => resolve());
      });
      const u = await r.usage;
      await record(r.status, u.usage, u.model, r.status >= 400 ? `HTTP ${r.status}` : null);
    } catch (e) {
      const why = ac.signal.aborted ? "시간 상한 또는 연결 끊김" : (e as Error)?.message ?? String(e);
      await record(null, { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, null, why);
      if (!res.headersSent) throw new HttpError(502, `LLM 에 닿지 못했습니다: ${why}`.slice(0, 300));
      res.end();
    } finally {
      clearTimeout(timer);
      d.inflight.release(tenant);
    }
  }, { logPath: `${LLM_PROXY_PREFIX}/*` }));
}
