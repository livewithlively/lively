// LLM 프록시 라우트 — 가짜 위쪽 서버 · 가짜 의존으로 express 에 꽂아 잰다 (#4488 · 격리 리뷰 blocking 1 반영). 실행: npm run build && node dist/ai-runs/routes.test.js
//  이게 틀리면: 자격 없는 요청이 위로 새거나, 앱이 보낸 키가 위로 가거나, 클라이언트가 끊었는데 위쪽 연결·동시 슬롯이 10분 동안 새거나(워크스페이스 전체가 429),
//  위쪽이 중간에 끊겼는데 앱 응답이 열린 채 남는다.
//  X1 자격 없음 401 · X2 모르는 토큰 401(whoIs) · X3 사람 토큰 403 · X4 다른 경로 404 · X5 키 교체(앱 x-api-key · authorization 버림) + 계측 ·
//  X6 스트리밍 바이트 그대로 · X7 클라이언트가 중간에 끊음 → 위쪽 abort · 슬롯 반환 · X8 위쪽이 중간에 끊김 → 응답 닫힘 · 슬롯 반환 · 계측 오류 ·
//  X9 동시 상한 가득 429 · X10 하루 토큰 429 · X11 키 없음 503 · X12 위쪽에 못 닿음 502
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { HttpError } from "../http-error.js";
import { DEFAULT_AI_RUN_POLICY, type AiRunPolicy } from "../org/policies/ai-run-policy.js";
import type { NewLlmCall } from "./store.js";
import { forwardToAnthropic } from "./anthropic.js";
import { LLM_PROXY_PREFIX, llmProxyHandler, type ProxyCaller } from "./routes.js";
import type { AiRunDeps } from "./service.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── 가짜 위쪽(Anthropic) — 받은 헤더를 기록하고, 모드대로 답한다. 끊김을 본다. ──
interface Seen { headers: http.IncomingHttpHeaders; body: string; aborted: boolean }
const seen: Seen[] = [];
let mode: "json" | "stream-short" | "stream-slow" | "stream-break" | "stall" = "json";
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    const s: Seen = { headers: req.headers, body, aborted: false };
    seen.push(s);
    res.on("close", () => { if (!res.writableEnded) s.aborted = true; });
    if (mode === "stall") {
      //  머리글조차 3초 뒤에 — 클라이언트가 그 전에 끊으면 프록시는 위쪽 응답을 기다리지 말고 끊어야 한다(X7b).
      const t = setTimeout(() => { if (!res.writableEnded) { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); } }, 3_000);
      res.on("close", () => clearTimeout(t));
      return;
    }
    if (mode === "json") {
      res.writeHead(200, { "content-type": "application/json", "request-id": "req_x" });
      res.end(JSON.stringify({ model: "m", usage: { input_tokens: 5, output_tokens: 2 }, content: [{ type: "text", text: "hi" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "message_start", message: { model: "m", usage: { input_tokens: 9 } } })}\n\n`);
    if (mode === "stream-short") { res.end(`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 3 } })}\n\ndata: {"type":"message_stop"}\n\n`); return; }
    if (mode === "stream-break") { setTimeout(() => res.destroy(), 50); return; }
    //  느린 스트림 — 끊기지 않으면 60초 뒤에나 끝난다(시험은 그 전에 끊는다).
    const t = setInterval(() => { if (!res.writableEnded) res.write(`data: {"type":"ping"}\n\n`); }, 20);
    res.on("close", () => clearInterval(t));
    setTimeout(() => { clearInterval(t); if (!res.writableEnded) res.end(`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 3 } })}\n\n`); }, 60_000).unref();
  });
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const upPort = (upstream.address() as { port: number }).port;
process.env.LIVELY_ANTHROPIC_BASE_URL = `http://127.0.0.1:${upPort}`;   // anthropic.ts 는 부를 때마다 읽는다
const forward = forwardToAnthropic;

// ── 가짜 의존 ──
const calls: NewLlmCall[] = [];
let inflightN = 0; let usedToday = 0; let key: string | null = "sk-ws";
const policy: AiRunPolicy = { ...DEFAULT_AI_RUN_POLICY };
const d = {
  store: { insertLlmCall: async (c: NewLlmCall) => { calls.push(c); }, tokensUsedTodayByApp: async () => usedToday },
  policy: async () => policy, apiKey: async () => key, tenant: () => "t",
  inflight: { take: (_k: string, max: number) => { if (inflightN >= max) return false; inflightN++; return true; }, release: () => { inflightN--; }, count: () => inflightN },
} as unknown as AiRunDeps;
const whoIs = async (token: string): Promise<ProxyCaller> => {
  if (token === "lvai_ok") return { caller: "run_token", appId: "crm", runId: 7, member: "alice" };
  if (token === "lvk_app") return { caller: "app_server", appId: "crm", runId: null, member: null };
  if (token === "lvk_human") throw new HttpError(403, "사람 토큰");
  throw new HttpError(401, "모르는 토큰");
};
const app = express();
app.use(LLM_PROXY_PREFIX, express.raw({ type: () => true, limit: "1mb" }));
app.post(`${LLM_PROXY_PREFIX}/*`, llmProxyHandler({ deps: async () => d, whoIs, forward, timeoutMs: 5_000 }));
const srv = http.createServer(app);
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const port = (srv.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}${LLM_PROXY_PREFIX}`;
const post = (path: string, headers: Record<string, string>, body: unknown): Promise<Response> =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

try {
  // X1~X4
  assert.equal((await post("/v1/messages", {}, {})).status, 401);
  assert.equal((await post("/v1/messages", { authorization: "Bearer lvai_nope" }, {})).status, 401);
  assert.equal((await post("/v1/messages", { authorization: "Bearer lvk_human" }, {})).status, 403);
  assert.equal((await post("/v1/complete", { authorization: "Bearer lvai_ok" }, {})).status, 404);
  assert.equal((await post("/v1/models", { "x-api-key": "lvai_ok" }, {})).status, 404);
  assert.equal(seen.length, 0, "자격이 안 서면 위로 안 간다");
  assert.equal(inflightN, 0);
  ok("X1~X4 자격 없음 401 · 모르는 토큰 401 · 사람 토큰 403 · 다른 경로 404 · 위로 0건");

  // X5 키 교체 + 계측(JSON)
  mode = "json";
  const r5 = await post("/v1/messages", { authorization: "Bearer lvai_ok", "x-api-key": "sk-from-app", "anthropic-beta": "b1", cookie: "a=1" }, { model: "claude-opus-5-5", messages: [] });
  assert.equal(r5.status, 200);
  assert.equal(r5.headers.get("request-id"), "req_x");
  assert.equal((await r5.json() as { model: string }).model, "m");
  const s5 = seen.at(-1)!;
  assert.equal(s5.headers["x-api-key"], "sk-ws"); assert.equal(s5.headers.authorization, undefined); assert.equal(s5.headers.cookie, undefined); assert.equal(s5.headers["anthropic-beta"], "b1");
  await sleep(20);
  const c5 = calls.at(-1)!;
  assert.equal(c5.caller, "run_token"); assert.equal(c5.runId, 7); assert.equal(c5.inputTokens, 5); assert.equal(c5.outputTokens, 2); assert.equal(c5.status, 200); assert.equal(c5.model, "m");
  assert.equal(inflightN, 0, "슬롯 반환");
  ok("X5 키 교체(앱 자격 · 쿠키 버림 · 베타 통과) · 계측(run_token · 토큰 · 상태)");

  // X6 스트리밍 — 끝까지 오는 짧은 스트림이 바이트 그대로 지나가고 사용량(입력 9 · 출력 3)이 셈된다
  mode = "stream-short";
  const r6 = await post("/v1/messages", { authorization: "Bearer lvk_app" }, { stream: true });
  assert.equal(r6.status, 200);
  assert.equal(r6.headers.get("content-type"), "text/event-stream");
  const text6 = await r6.text();
  assert.equal(text6, `data: ${JSON.stringify({ type: "message_start", message: { model: "m", usage: { input_tokens: 9 } } })}\n\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 3 } })}\n\ndata: {"type":"message_stop"}\n\n`, "바이트 그대로");
  await sleep(30);
  assert.equal(inflightN, 0);
  const c6 = calls.at(-1)!;
  assert.equal(c6.caller, "app_server"); assert.equal(c6.stream, true); assert.equal(c6.inputTokens, 9); assert.equal(c6.outputTokens, 3); assert.equal(c6.error, null);
  ok("X6 스트리밍 바이트 그대로 · 사용량 셈(app_server)");

  // X8 위쪽이 중간에 끊김 → 응답 닫힘 · 슬롯 반환 · 계측에 오류
  mode = "stream-break";
  const r8 = await post("/v1/messages", { authorization: "Bearer lvk_app" }, { stream: true });
  const text8 = await r8.text().catch(() => "(끊김)");
  assert.ok(text8.includes("message_start") || text8 === "(끊김)", "끊기기 전 조각 또는 끊김 — 응답이 열린 채 남지 않는다");
  await sleep(50);
  assert.equal(inflightN, 0, "위쪽이 중간에 끊겨도 슬롯 반환");
  const c8 = calls.at(-1)!;
  assert.equal(c8.inputTokens, 9, "끊기기 전까지 셈한 사용량"); assert.ok(c8.error, "위쪽이 끊긴 것을 계측에 남긴다");
  ok("X8 위쪽이 중간에 끊기면 응답이 닫히고 슬롯이 돌아온다");

  // X7 클라이언트가 중간에 끊음 → 위쪽 abort · 슬롯 반환
  mode = "stream-slow";
  const ac = new AbortController();
  const p7 = fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer lvai_ok" }, body: JSON.stringify({ stream: true }), signal: ac.signal });
  const r7 = await p7;
  const reader = r7.body!.getReader();
  await reader.read();   // 첫 조각을 받았다 — 스트림이 흐르는 중
  assert.equal(inflightN, 1, "흐르는 동안 슬롯 하나");
  ac.abort();
  let released = false;
  for (let i = 0; i < 100 && !released; i++) { await sleep(20); released = inflightN === 0; }
  assert.ok(released, "클라이언트가 끊으면 슬롯이 곧 돌아온다(10분 상한을 기다리지 않는다)");
  let aborted = false;
  for (let i = 0; i < 100 && !aborted; i++) { await sleep(20); aborted = seen.at(-1)!.aborted; }
  assert.ok(aborted, "위쪽 요청도 끊긴다(토큰이 계속 만들어지지 않게)");
  await sleep(30);
  assert.equal(calls.at(-1)!.caller, "run_token"); assert.ok(calls.at(-1)!.error, "끊김을 계측에 남긴다");
  ok("X7 클라이언트가 중간에 끊음 → 위쪽 abort · 슬롯 반환 · 계측");

  // X7b 위쪽이 머리글도 안 준 사이에 클라이언트가 끊음 → 위쪽 응답(3초)을 기다리지 않고 바로 끊고 슬롯 반환(res 의 close 를 듣는다 — req 의 close 는 여기서 울리지 않는다)
  mode = "stall";
  const ac2 = new AbortController();
  const p7b = fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer lvai_ok" }, body: JSON.stringify({}), signal: ac2.signal });
  p7b.catch(() => undefined);
  for (let i = 0; i < 50 && inflightN === 0; i++) await sleep(10);
  assert.equal(inflightN, 1, "위쪽을 기다리는 동안 슬롯 하나");
  const t0 = Date.now();
  ac2.abort();
  let rel2 = false;
  for (let i = 0; i < 100 && !rel2; i++) { await sleep(20); rel2 = inflightN === 0; }
  assert.ok(rel2 && Date.now() - t0 < 1_500, `끊은 뒤 ${Date.now() - t0}ms — 위쪽 머리글(3초)을 기다리지 않아야 한다`);
  ok("X7b 위쪽 응답 전에 끊어도 바로 슬롯 반환(res close 로 듣는다)");

  // X9~X12 상한 · 키 없음 · 못 닿음
  inflightN = policy.max_inflight;
  assert.equal((await post("/v1/messages", { authorization: "Bearer lvai_ok" }, {})).status, 429);
  inflightN = 0;
  usedToday = policy.daily_tokens_per_app;
  assert.equal((await post("/v1/messages", { authorization: "Bearer lvai_ok" }, {})).status, 429);
  usedToday = 0;
  key = null;
  assert.equal((await post("/v1/messages", { authorization: "Bearer lvai_ok" }, {})).status, 503);
  key = "sk-ws";
  const before = seen.length;
  await new Promise<void>((r) => upstream.close(() => r()));
  const r12 = await post("/v1/messages", { authorization: "Bearer lvai_ok" }, {});
  assert.equal(r12.status, 502);
  assert.equal(seen.length, before);
  assert.equal(inflightN, 0, "못 닿아도 슬롯 반환");
  ok("X9~X12 동시 가득 429 · 하루 토큰 429 · 키 없음 503 · 못 닿음 502 · 슬롯 반환");
} finally {
  srv.close();
  upstream.close();
}
console.log(`ai-runs routes.test: ${pass} passed`);
