// 앱 서버 검사 층의 백그라운드 작업 길 · 사람 요청 시간 끊기(#4486 앱 v2-7) 시험 — 진짜 검사 층 글(GUARD_JS)을 이 기계의 node 로 띄우고,
//  뒤에 가짜 앱 · 앞에 가짜 게이트웨이(LIVELY_API_URL — claim · tick · result 를 받아 적는다)를 둔다(Lambda 안과 같은 모양: 웹 어댑터 → 검사 층 → 앱).
//  사양 엣지 표 A(spec-4486.md): K1~K15 작업 길 · P1~P5 사람 요청 시간 · K16~K18 · P6 함수 마감(x-amzn-lambda-context) · P7 위조 작업 번호(격리 리뷰).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { GUARD_JS } from "./app-server-guard.js";
import { ed25519FromSeed, signAppIdentity } from "./app-identity.js";
import { JOB_RESULT_MAX, jobCredential } from "./app-jobs-plan.js";

const WS = "11111111-2222-4333-8444-555555555555";
const APP = "meet-notes";
const key = ed25519FromSeed(crypto.createHash("sha256").update("guard-jobs-test").digest());
const CALL_PART = "S".repeat(43);
const RUN = jobCredential("run", 7, "R".repeat(43));

const freePort = (): Promise<number> => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string; at: number; closedEarly?: boolean }
/** 가짜 앱 — ?ms= 동안 일하고 ?status= 로 답한다 · ?bytes= 면 그만큼의 글 · /stream 은 0.3초마다 조각 열 개. */
async function startApp(port: number): Promise<{ seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => { body += c; });
    req.on("end", async () => {
      const u = new URL(req.url ?? "/", "http://x");
      const rec: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body, at: Date.now() };
      seen.push(rec);
      res.on("close", () => { if (!res.writableFinished) rec.closedEarly = true; });
      if (u.pathname === "/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (let i = 0; i < 10 && !res.destroyed; i++) { res.write(`data: ${i}\n\n`); await sleep(300); }
        if (!res.destroyed) res.end();
        return;
      }
      await sleep(Number(u.searchParams.get("ms") ?? 0));
      if (res.destroyed) return;
      const n = Number(u.searchParams.get("bytes") ?? 0);
      if (n > 0) { res.writeHead(200, { "content-type": "text/plain" }); res.end("x".repeat(n)); return; }
      res.writeHead(Number(u.searchParams.get("status") ?? 200), { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, got: body ? JSON.parse(body) : null }));
    });
  });
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
  return { seen, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

interface ApiCall { path: string; headers: http.IncomingHttpHeaders; body: unknown; at: number }
type Reply = { status: number; body: unknown };
/** 가짜 게이트웨이 — 길마다 답을 정해 두고(배열이면 차례로 · 마지막 것을 되풀이 · 없으면 기본) 부른 것을 적는다. 상태 0 이면 답하지 않는다(매달림). */
async function startApi(replies: Partial<Record<"claim" | "tick" | "result", Reply | Reply[]>> = {}): Promise<{ url: string; calls: ApiCall[]; close: () => Promise<void> }> {
  const calls: ApiCall[] = [];
  const port = await freePort();
  const next = (k: "claim" | "tick" | "result"): Reply | undefined => {
    const r = replies[k];
    if (Array.isArray(r)) return r.length > 1 ? r.shift() : r[0];
    return r;
  };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => { body += c; });
    req.on("end", () => {
      const m = /^\/api\/app-jobs\/(\d+)\/(claim|tick|result)$/.exec(req.url ?? "");
      let parsed: unknown = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
      calls.push({ path: req.url ?? "", headers: req.headers, body: parsed, at: Date.now() });
      if (!m) { res.writeHead(404).end(); return; }
      const op = m[2] as "claim" | "tick" | "result";
      const def: Reply = op === "claim"
        ? { status: 200, body: { job: Number(m[1]), run: RUN, member: "윤상민", member_name: "윤 상민", variant: "draft", timeout_s: 30, tick_s: 1 } }
        : op === "tick" ? { status: 200, body: { cancel: false } } : { status: 200, body: { ok: true, status: "done" } };
      const r = next(op) ?? def;
      if (r.status === 0) return;
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

async function startGuard(appPort: number, env: Record<string, string | undefined> = {}): Promise<{ port: number; proc: ChildProcess; stop: () => void }> {
  const port = await freePort();
  const base: Record<string, string> = { PATH: process.env.PATH ?? "", PORT: String(appPort), LIVELY_GUARD_PORT: String(port), LIVELY_TENANT_ID: WS, LIVELY_APP_ID: APP,
    LIVELY_APP_IDENTITY_PUBKEYS: JSON.stringify({ k1: key.publicKeyB64 }), LIVELY_APP_TOKEN: "app-token-1" };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete base[k]; else base[k] = v; }
  const proc = spawn(process.execPath, ["-e", GUARD_JS], { stdio: ["ignore", "ignore", "ignore"], env: base });
  for (let i = 0; i < 200; i++) {
    const ok = await new Promise<boolean>((r) => { const s = net.connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
    if (ok) break;
    await sleep(25);
  }
  return { port, proc, stop: () => { try { proc.kill("SIGKILL"); } catch { /* 이미 끝났다 */ } } };
}

interface Out { status: number; headers: http.IncomingHttpHeaders; body: string; complete: boolean; at: number }
function req(port: number, path: string, headers: Record<string, string> = {}, method = "GET", body?: string): Promise<Out> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let done = false;
    const r = http.request({ host: "127.0.0.1", port, path, method, headers: { ...headers, ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}) }, agent: false }, (res) => {
      let out = "";
      const fin = (complete: boolean): void => { if (done) return; done = true; resolve({ status: res.statusCode ?? 0, headers: res.headers, body: out, complete, at: Date.now() - t0 }); };
      res.setEncoding("utf8");
      res.on("data", (c: string) => { out += c; });
      res.on("end", () => fin(res.complete));
      res.on("aborted", () => fin(false));
      res.on("error", () => fin(false));
      res.on("close", () => fin(res.complete));
    });
    r.on("error", (e) => { if (!done) reject(e); });
    r.end(body);
  });
}
/** 게이트웨이가 함수를 비동기로 부를 때의 요청 모양(웹 어댑터가 이벤트를 이 HTTP 요청으로 바꾼다 — 2026-10-20 실제 AWS 실측과 같은 머리글). */
const jobReq = (port: number, route: string, body: unknown, cred = jobCredential("call", 7, CALL_PART), extra: Record<string, string> = {}): Promise<Out> =>
  req(port, route, { "content-type": "application/json", "user-agent": "lively-job/1", "x-lively-identity": cred, ...extra }, "POST", JSON.stringify(body));

const now = (): number => Math.floor(Date.now() / 1000);
const personTok = (): string => signAppIdentity({ ws: WS, app: APP, var: "pub", sub: "sangmin-yoon", name: "윤상민", iat: now() - 5, exp: now() + 595 }, key.privateKey, "k1");

async function rig(replies: Parameters<typeof startApi>[0] = {}, env: Record<string, string | undefined> = {}) {
  const appPort = await freePort();
  const app = await startApp(appPort);
  const api = await startApi(replies);
  const g = await startGuard(appPort, { LIVELY_API_URL: api.url + "/", ...env });
  return { app, api, g, done: async () => { g.stop(); await app.close(); await api.close(); } };
}
const calls = (api: { calls: ApiCall[] }, op: string): ApiCall[] => api.calls.filter((c) => c.path.endsWith(`/${op}`));
const results = (api: { calls: ApiCall[] }): Array<Record<string, unknown>> => calls(api, "result").map((c) => c.body as Record<string, unknown>);
const claimReply = (o: Record<string, unknown> = {}): Reply => ({ status: 200, body: { job: 7, run: RUN, member: "m", member_name: "m", variant: "pub", timeout_s: 30, tick_s: 1, ...o } });

test("K1 ★ 시작 확인 → 앱은 돌기 신원 · 사람 · 판 · 작업 번호를 받고 본문은 그대로 · 결과를 보고한 «뒤» 에 함수 응답이 끝난다", async () => {
  const r = await rig();
  try {
    const t0 = Date.now();
    const out = await jobReq(r.g.port, "/api/jobs/transcribe?lang=ko&ms=50", { file: "회의.mp3", n: 1 });
    const ended = Date.now();
    assert.equal(out.status, 200);
    assert.equal(out.headers["x-lively-guard"], "job-done");
    assert.deepEqual(JSON.parse(out.body), { job: 7, outcome: "response", reported: true });
    const claim = calls(r.api, "claim");
    assert.equal(claim.length, 1);
    assert.equal(claim[0]!.path, "/api/app-jobs/7/claim", "주소 끝의 / 는 하나로");
    assert.equal(claim[0]!.headers.authorization, "Bearer app-token-1", "게이트웨이 자격 = 함수의 앱 서버 토큰");
    assert.equal(claim[0]!.headers["x-lively-job-secret"], CALL_PART, "부르기 비밀");
    assert.equal(r.app.seen.length, 1, "앱에 한 번");
    const seen = r.app.seen[0]!;
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/api/jobs/transcribe?lang=ko&ms=50");
    assert.deepEqual(JSON.parse(seen.body), { file: "회의.mp3", n: 1 });
    assert.equal(seen.headers["x-lively-identity"], RUN, "부르기 신원 대신 돌기 신원(앱의 SDK 가 다시 싣는다)");
    assert.equal(decodeURIComponent(String(seen.headers["x-lively-member"])), "윤상민");
    assert.equal(decodeURIComponent(String(seen.headers["x-lively-member-name"])), "윤 상민");
    assert.equal(seen.headers["x-lively-variant"], "draft");
    assert.equal(seen.headers["x-lively-job"], "7");
    assert.ok(claim[0]!.at <= seen.at, "앱보다 시작 확인이 먼저");
    const res = results(r.api);
    assert.equal(res.length, 1);
    assert.equal(res[0]!.outcome, "response");
    assert.equal(res[0]!.status_code, 200);
    assert.equal(res[0]!.content_type, "application/json");
    assert.deepEqual(JSON.parse(Buffer.from(String(res[0]!.body_b64), "base64").toString("utf8")), { ok: true, got: { file: "회의.mp3", n: 1 } });
    assert.equal(res[0]!.truncated, false);
    assert.ok(Number(res[0]!.duration_ms) >= 50);
    const rc = calls(r.api, "result")[0]!;
    assert.equal(rc.headers["x-lively-job-run"], RUN, "결과 보고 자격 = 돌기 신원");
    assert.equal(rc.headers.authorization, "Bearer app-token-1");
    assert.ok(rc.at >= t0 && rc.at <= ended, "결과 보고는 함수 응답이 끝나기 전");
  } finally { await r.done(); }
});

test("K2 재전송(claim 409) — 409 · 앱 0 · 결과 보고 0 · 다시 안 함", async () => {
  const r = await rig({ claim: { status: 409, body: { error: "x", reason: "claimed" } } });
  try {
    const out = await jobReq(r.g.port, "/api/jobs/x", {});
    assert.equal(out.status, 409);
    assert.equal(out.headers["x-lively-guard"], "denied");
    assert.equal(JSON.parse(out.body).error, "job_replayed");
    assert.equal(JSON.parse(out.body).reason, "claimed");
    assert.equal(r.app.seen.length, 0, "재전송이 앱에 닿았다");
    assert.equal(results(r.api).length, 0);
    assert.equal(calls(r.api, "claim").length, 1, "409 는 판정 — 다시 하지 않는다");
  } finally { await r.done(); }
});

test("K3 위조(claim 401 · 403 · 404) — 401 · 앱 0", async () => {
  for (const status of [401, 403, 404]) {
    const r = await rig({ claim: { status, body: { error: "x" } } });
    try {
      const out = await jobReq(r.g.port, "/api/jobs/x", {});
      assert.equal(out.status, 401, `claim ${status}`);
      assert.equal(JSON.parse(out.body).error, "job_identity_invalid");
      assert.equal(r.app.seen.length, 0);
      assert.equal(calls(r.api, "claim").length, 1);
    } finally { await r.done(); }
  }
});

test("K4 게이트웨이 5xx — 네 번 시도 뒤 503 · 앱 0 / 한 번 5xx 뒤 200 이면 돈다(게이트웨이 교대 중)", async () => {
  {
    const r = await rig({ claim: { status: 503, body: { error: "rolling" } } });
    try {
      const out = await jobReq(r.g.port, "/api/jobs/x", {});
      assert.equal(out.status, 503);
      assert.equal(out.headers["x-lively-guard"], "error");
      assert.equal(calls(r.api, "claim").length, 4);
      assert.equal(r.app.seen.length, 0);
    } finally { await r.done(); }
  }
  {
    const r = await rig({ claim: [{ status: 502, body: {} }, claimReply()] });
    try {
      const out = await jobReq(r.g.port, "/api/jobs/x", {});
      assert.equal(out.status, 200);
      assert.equal(calls(r.api, "claim").length, 2);
      assert.equal(r.app.seen.length, 1);
    } finally { await r.done(); }
  }
});

test("K5 앱이 500 → 결과 response 500(본문 함께) · K6 앱 포트 닫힘 → app_unreachable", async () => {
  const r = await rig();
  try {
    await jobReq(r.g.port, "/api/jobs/x?status=500", { a: 1 });
    const res = results(r.api)[0]!;
    assert.equal(res.outcome, "response");
    assert.equal(res.status_code, 500);
    assert.match(Buffer.from(String(res.body_b64), "base64").toString(), /"got":\{"a":1\}/);
  } finally { await r.done(); }
  const appPort = await freePort();   // 아무도 안 듣는 포트
  const api = await startApi();
  const g = await startGuard(appPort, { LIVELY_API_URL: api.url });
  try {
    const out = await jobReq(g.port, "/api/jobs/x", {});
    assert.equal(out.status, 200);
    const res = results(api);
    assert.equal(res.length, 1);
    assert.equal(res[0]!.outcome, "app_unreachable");
  } finally { g.stop(); await api.close(); }
});

test("K7 · K8 박동 — 취소(cancel:true) · 이미 끝남(409) 이면 앱 요청을 끊고 canceled", async () => {
  for (const tick of [{ status: 200, body: { cancel: true } }, { status: 409, body: { reason: "ended" } }]) {
    const r = await rig({ tick });
    try {
      const out = await jobReq(r.g.port, "/api/jobs/x?ms=10000", {});
      assert.equal(out.status, 200);
      assert.ok(out.at < 5000, `박동(1초) 뒤 곧바로 끊어야 한다 — ${out.at}ms`);
      const res = results(r.api);
      assert.equal(res.length, 1);
      assert.equal(res[0]!.outcome, "canceled", `tick ${tick.status}`);
      await sleep(100);
      assert.equal(r.app.seen[0]!.closedEarly, true, "앱 요청을 끊었다");
      assert.equal(calls(r.api, "tick")[0]!.headers["x-lively-job-run"], RUN);
    } finally { await r.done(); }
  }
});

test("K9 작업 시간 상한(claim 의 timeout_s 1) — 1초쯤 앱 요청을 끊고 timeout", async () => {
  const r = await rig({ claim: claimReply({ timeout_s: 1, tick_s: 30 }) });
  try {
    const out = await jobReq(r.g.port, "/api/jobs/x?ms=5000", {});
    assert.ok(out.at >= 900 && out.at < 4000, `${out.at}ms`);
    const res = results(r.api)[0]!;
    assert.equal(res.outcome, "timeout");
    assert.equal(res.status_code, null);
  } finally { await r.done(); }
});

test("K10 큰 응답 — 앞 64KB 만 보고 · truncated · bytes 는 전체 / 정확히 64KB 면 truncated 아님", async () => {
  const r = await rig();
  try {
    await jobReq(r.g.port, `/api/jobs/x?bytes=${JOB_RESULT_MAX + 5000}`, {});
    await jobReq(r.g.port, `/api/jobs/x?bytes=${JOB_RESULT_MAX}`, {});
    const [big, edge] = results(r.api);
    assert.equal(Buffer.from(String(big!.body_b64), "base64").length, JOB_RESULT_MAX);
    assert.equal(big!.truncated, true);
    assert.equal(big!.bytes, JOB_RESULT_MAX + 5000);
    assert.equal(Buffer.from(String(edge!.body_b64), "base64").length, JOB_RESULT_MAX);
    assert.equal(edge!.truncated, false, "경계 — 정확히 64KB");
  } finally { await r.done(); }
});

test("K11 · K12 돌기 신원 · 모양이 틀린 부르기 신원 — 작업 길을 안 탄다(사람 신원 검사 → 401) · 게이트웨이 0", async () => {
  const r = await rig();
  try {
    for (const cred of [RUN, "lvjc1.0." + CALL_PART, "lvjc1.7.short", "lvjc1.7." + CALL_PART + "!", `lvjc1.7.${CALL_PART}.x`, "lvjc1.07." + CALL_PART]) {
      const out = await jobReq(r.g.port, "/api/jobs/x", {}, cred);
      assert.equal(out.status, 401, cred.slice(0, 24));
      assert.equal(out.headers["x-lively-guard"], "denied");
    }
    assert.equal(r.app.seen.length, 0);
    assert.equal(r.api.calls.length, 0, "게이트웨이도 부르지 않는다");
  } finally { await r.done(); }
});

test("K13 새로 도입한 env 부재 — 라이블리 주소 · 앱 서버 토큰이 없으면 작업을 안 받는다(401 job_unconfigured · 앱 0)", async () => {
  for (const env of [{ LIVELY_API_URL: undefined }, { LIVELY_APP_TOKEN: undefined }, { LIVELY_API_URL: "" }]) {
    const appPort = await freePort();
    const app = await startApp(appPort);
    const g = await startGuard(appPort, env);
    try {
      const out = await jobReq(g.port, "/api/jobs/x", {});
      assert.equal(out.status, 401, JSON.stringify(env));
      assert.equal(JSON.parse(out.body).error, "job_unconfigured");
      assert.equal(app.seen.length, 0);
    } finally { g.stop(); await app.close(); }
  }
});

test("K14 들어온 x-lively-* 는 지우고 검사한 값으로 — 이벤트에 x-lively-member: evil 을 실어도 앱은 작업을 시작한 사람만 본다", async () => {
  const r = await rig();
  try {
    await jobReq(r.g.port, "/api/jobs/x", {}, jobCredential("call", 7, CALL_PART), { "x-lively-member": "evil", "x-lively-job": "999", "x-lively-other": "1" });
    const h = r.app.seen[0]!.headers;
    assert.equal(decodeURIComponent(String(h["x-lively-member"])), "윤상민");
    assert.equal(h["x-lively-job"], "7");
    assert.equal(h["x-lively-other"], undefined);
  } finally { await r.done(); }
});

test("K15 claim 에 박동 간격이 없거나 범위 밖이면 20초 — 1.5초짜리 작업 동안 박동이 없다", async () => {
  for (const tick_s of [undefined, 0, 61, "x"]) {
    const r = await rig({ claim: claimReply({ tick_s }) });
    try {
      await jobReq(r.g.port, "/api/jobs/x?ms=1500", {});
      assert.equal(calls(r.api, "tick").length, 0, `tick_s ${String(tick_s)}`);
      assert.equal(results(r.api)[0]!.outcome, "response");
    } finally { await r.done(); }
  }
});

test("P1 · P2 · P4 · P5 ★ 사람 요청 시간(1초) — 앞머리 전이면 504 timeout · 흘려 보내는 중이면 잘린 응답 · 상한 안은 그대로 · 작업 길은 안 끊는다", async () => {
  const r = await rig({}, { LIVELY_REQUEST_TIMEOUT_S: "1" });
  try {
    const slow = await req(r.g.port, "/slow?ms=3000", { "x-lively-identity": personTok() });
    assert.equal(slow.status, 504);
    assert.equal(slow.headers["x-lively-guard"], "timeout");
    assert.equal(JSON.parse(slow.body).error, "app_timeout");
    assert.ok(slow.at >= 900 && slow.at < 2500, `${slow.at}ms`);
    const fast = await req(r.g.port, "/slow?ms=100", { "x-lively-identity": personTok() });
    assert.equal(fast.status, 200, "P4 상한 안의 요청은 그대로");
    const stream = await req(r.g.port, "/stream", { "x-lively-identity": personTok() });
    assert.equal(stream.status, 200);
    assert.equal(stream.complete, false, "P2 끊긴 흘려 보내기를 온전한 응답으로 닫았다");
    assert.match(stream.body, /data: 0/);
    assert.doesNotMatch(stream.body, /data: 9/);
    const job = await jobReq(r.g.port, "/api/jobs/x?ms=1500", {});
    assert.equal(job.status, 200);
    assert.equal(results(r.api)[0]!.outcome, "response", "P5 작업은 사람 요청 시간을 타지 않는다");
  } finally { await r.done(); }
});

//  웹 어댑터가 앱 쪽에 넘기는 이번 호출의 마감(2026-10-20 실제 AWS 실측 — deadline 은 epoch ms).
const lambdaCtx = (deadline: number): Record<string, string> => ({ "x-amzn-lambda-context": JSON.stringify({ request_id: "r", deadline, invoked_function_arn: "arn", xray_trace_id: null }) });
const MARGIN = 15_000;   // 검사 층의 JOB_REPORT_MARGIN_MS

test("K16 ★ 함수 마감 — 작업 시간(900초)보다 함수 마감이 이르면 결과를 알릴 여유(15초)를 두고 그 앞에서 끊고 timeout 을 보고한다", async () => {
  const r = await rig({ claim: claimReply({ timeout_s: 900 }) });
  try {
    const out = await jobReq(r.g.port, "/api/jobs/x?ms=5000", {}, undefined, lambdaCtx(Date.now() + MARGIN + 1500));
    assert.equal(out.status, 200);
    const rep = results(r.api)[0]!;
    assert.equal(rep.outcome, "timeout", "Lambda 가 먼저 멈추면 결과가 사라진다 — 검사 층이 먼저 끊어 알려야 한다");
    assert.ok(Number(rep.duration_ms) >= 1000 && Number(rep.duration_ms) < 3500, `${rep.duration_ms}ms`);
    assert.equal(r.app.seen[0]!.closedEarly, true, "앱 요청을 끊었다");
    assert.ok(out.at < 4500, `함수 응답 ${out.at}ms`);
  } finally { await r.done(); }
});

test("K17 함수 마감 머리가 없거나 · 못 읽거나 · 작업 시간보다 늦으면 작업 시간대로(새 칸 부재)", async () => {
  const r = await rig({ claim: claimReply({ timeout_s: 1 }) });
  try {
    for (const extra of [{ "x-amzn-lambda-context": "not json" }, { "x-amzn-lambda-context": JSON.stringify({ deadline: "soon" }) }, lambdaCtx(Date.now() + 600_000)]) {
      const before = results(r.api).length;
      await jobReq(r.g.port, "/api/jobs/x?ms=3000", {}, undefined, extra);
      const rep = results(r.api)[before]!;
      assert.equal(rep.outcome, "timeout", JSON.stringify(extra));
      assert.ok(Number(rep.duration_ms) >= 900 && Number(rep.duration_ms) < 2500, `${rep.duration_ms}ms ${JSON.stringify(extra)}`);
    }
  } finally { await r.done(); }
  const r2 = await rig({ claim: claimReply({ timeout_s: 900 }) });
  try {
    await jobReq(r2.g.port, "/api/jobs/x?ms=1500", {});
    assert.equal(results(r2.api)[0]!.outcome, "response", "머리가 없으면 마감을 모른다 — 끊지 않는다");
  } finally { await r2.done(); }
});

test("K18 결과 보고도 함수 마감 전에 — 마감이 지났으면 보고를 붙잡지 않고 곧바로 함수 응답을 끝낸다(게이트웨이가 매달려도)", async () => {
  const r = await rig({ claim: claimReply({ timeout_s: 900 }), result: { status: 0, body: null } });
  try {
    const out = await jobReq(r.g.port, "/api/jobs/x?ms=5000", {}, undefined, lambdaCtx(Date.now() + 1500));
    assert.equal(out.status, 200);
    assert.equal(JSON.parse(out.body).reported, false);
    assert.ok(out.at < 3000, `마감 뒤에도 보고를 붙잡았다 — ${out.at}ms`);
    assert.equal(calls(r.api, "result").length, 0, "마감이 지난 보고는 보내지 않는다");
  } finally { await r.done(); }
});

test("P6 사람 요청도 함수 마감 1초 앞에서 끊는다(요청 시간이 함수 시간과 같게 설정된 때) — Lambda 오류 대신 504", async () => {
  const r = await rig({}, { LIVELY_REQUEST_TIMEOUT_S: "30" });
  try {
    const slow = await req(r.g.port, "/slow?ms=4000", { "x-lively-identity": personTok(), ...lambdaCtx(Date.now() + 2500) });
    assert.equal(slow.status, 504);
    assert.equal(slow.headers["x-lively-guard"], "timeout");
    assert.ok(slow.at >= 1200 && slow.at < 2400, `${slow.at}ms`);
  } finally { await r.done(); }
});

test("P7 사람 요청에 실린 위조 x-lively-job — 앱은 작업 번호를 못 본다(livelyMember(req).job 으로 판정하는 새 머리글)", async () => {
  const r = await rig();
  try {
    const out = await req(r.g.port, "/slow?ms=0", { "x-lively-identity": personTok(), "x-lively-job": "999" });
    assert.equal(out.status, 200);
    assert.equal(r.app.seen[0]!.headers["x-lively-job"], undefined);
    assert.equal(r.app.seen[0]!.headers["x-lively-member"], "sangmin-yoon");
  } finally { await r.done(); }
});

test("P3 새로 도입한 env 부재 — LIVELY_REQUEST_TIMEOUT_S 가 없으면(옛 함수 설정) 끊지 않는다", async () => {
  const r = await rig();
  try {
    const slow = await req(r.g.port, "/slow?ms=1500", { "x-lively-identity": personTok() });
    assert.equal(slow.status, 200);
  } finally { await r.done(); }
});

test("4487-K2j 작업 길의 열쇠 — LIVELY_GUARD_KEY 가 있으면 앱에 x-lively-guard-key(밖에서 온 것은 지우고 제 값) · 없으면 싣지 않는다", async () => {
  const keyed = await rig({}, { LIVELY_GUARD_KEY: "k-job" });
  try {
    assert.equal((await jobReq(keyed.g.port, "/api/jobs/x", {}, undefined, { "x-lively-guard-key": "forged" })).status, 200);
    assert.equal(keyed.app.seen[0]!.headers["x-lively-guard-key"], "k-job");
  } finally { await keyed.done(); }
  const plain = await rig();
  try {
    assert.equal((await jobReq(plain.g.port, "/api/jobs/x", {}, undefined, { "x-lively-guard-key": "forged" })).status, 200);
    assert.equal(plain.app.seen[0]!.headers["x-lively-guard-key"], undefined);
  } finally { await plain.done(); }
});
