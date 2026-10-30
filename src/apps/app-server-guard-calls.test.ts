// 앱 서버 검사 층의 AI 도구 동기 부르기 길(#5053 앱 v2-42 · 검사 층 5 판) 시험 — 진짜 검사 층 글(GUARD_JS)을 이 기계의 node 로 띄우고,
//  뒤에 가짜 앱 · 앞에 가짜 게이트웨이(LIVELY_API_URL — /api/app-calls/<부르기>/claim 을 받아 적는다)를 둔다(Lambda 안과 같은 모양: 웹 어댑터 → 검사 층 → 앱).
//  사양 엣지 표(spec-5053) D1~D10 — 태스크 엣지 표 4(앱이 받는 머리글) · 5(같은 부르기 비밀 두 번) · 6(30초 넘김)의 함수 안 쪽.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { GUARD_JS } from "./app-server-guard.js";
import { ed25519FromSeed, signAppIdentity } from "./app-identity.js";
import { callCredential, CALL_BODY_MAX } from "./app-server-call-plan.js";

const WS = "11111111-2222-4333-8444-555555555555";
const APP = "policy-wiki";
const key = ed25519FromSeed(crypto.createHash("sha256").update("guard-calls-test").digest());
const SECRET = "C".repeat(43);
const RUN = callCredential("run", 41, "R".repeat(43));
const CALL = callCredential("call", 41, SECRET);

const freePort = (): Promise<number> => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string; at: number }
/** 가짜 앱 — ?ms= 동안 일하고 ?status= 로 답한다 · /stream 은 0.2초마다 조각 다섯 · /text 는 글. 받은 요청을 적는다. */
async function startApp(port: number): Promise<{ seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => { body += c; });
    req.on("end", async () => {
      const u = new URL(req.url ?? "/", "http://x");
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body, at: Date.now() });
      if (u.pathname === "/stream") {
        res.writeHead(200, { "content-type": "text/plain" });
        for (let i = 0; i < 5 && !res.destroyed; i++) { res.write(`조각${i}\n`); await sleep(200); }
        if (!res.destroyed) res.end();
        return;
      }
      await sleep(Number(u.searchParams.get("ms") ?? 0));
      if (res.destroyed) return;
      res.writeHead(Number(u.searchParams.get("status") ?? 200), { "content-type": "application/json", "x-app-mark": "1" });
      res.end(JSON.stringify({ answer: "연차는 15일", got: body ? JSON.parse(body) : null }));
    });
  });
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
  return { seen, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

interface ApiCall { path: string; headers: http.IncomingHttpHeaders; at: number }
type Reply = { status: number; body: unknown; delayMs?: number };
/** 가짜 게이트웨이 — claim 답을 정해 두고(배열이면 차례로 · 마지막 것을 되풀이) 부른 것을 적는다. 상태 0 이면 답하지 않는다(매달림). */
async function startApi(claim: Reply | Reply[] | null = null): Promise<{ url: string; calls: ApiCall[]; close: () => Promise<void> }> {
  const calls: ApiCall[] = [];
  const port = await freePort();
  const next = (): Reply | null => (Array.isArray(claim) ? (claim.length > 1 ? claim.shift()! : claim[0]!) : claim);
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      calls.push({ path: req.url ?? "", headers: req.headers, at: Date.now() });
      const m = /^\/api\/app-calls\/(\d+)\/claim$/.exec(req.url ?? "");
      if (!m) { res.writeHead(404).end(); return; }
      const r = next() ?? { status: 200, body: { call: Number(m[1]), run: RUN, member: "윤상민", member_name: "윤 상민", variant: "draft", timeout_s: 30 } };
      if (r.delayMs) await sleep(r.delayMs);
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
    LIVELY_APP_IDENTITY_PUBKEYS: JSON.stringify({ k1: key.publicKeyB64 }), LIVELY_APP_TOKEN: "app-token-1", LIVELY_REQUEST_TIMEOUT_S: "30" };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete base[k]; else base[k] = v; }
  const proc = spawn(process.execPath, ["-e", GUARD_JS], { stdio: ["ignore", "ignore", "ignore"], env: base });
  for (let i = 0; i < 200; i++) {
    const ok = await new Promise<boolean>((r) => { const s = net.connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
    if (ok) break;
    await sleep(25);
  }
  return { port, proc, stop: () => { try { proc.kill("SIGKILL"); } catch { /* 이미 끝났다 */ } } };
}

interface Out { status: number; headers: http.IncomingHttpHeaders; body: string; chunks: number[]; complete: boolean; at: number }
function req(port: number, path: string, headers: Record<string, string>, method: string, body: string | Buffer): Promise<Out> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let done = false;
    const r = http.request({ host: "127.0.0.1", port, path, method, headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, agent: false }, (res) => {
      let out = "";
      const chunks: number[] = [];
      const fin = (complete: boolean): void => { if (done) return; done = true; resolve({ status: res.statusCode ?? 0, headers: res.headers, body: out, chunks, complete, at: Date.now() - t0 }); };
      res.setEncoding("utf8");
      res.on("data", (c: string) => { out += c; chunks.push(Date.now() - t0); });
      res.on("end", () => fin(res.complete));
      res.on("aborted", () => fin(false));
      res.on("error", () => fin(false));
      res.on("close", () => fin(res.complete));
    });
    r.on("error", (e) => { if (!done) reject(e); });
    r.end(body);
  });
}
/** 게이트웨이가 도구 부르기로 함수를 부를 때의 요청 모양(웹 어댑터가 이벤트를 이 HTTP 요청으로 바꾼다 — app-server-call-plan callInvokeEvent 의 머리글). */
const callReq = (port: number, route: string, body: unknown, cred = CALL, extra: Record<string, string> = {}): Promise<Out> =>
  req(port, route, { "content-type": "application/json", "user-agent": "lively-mcp-tool/1", "x-lively-identity": cred, ...extra }, "POST", JSON.stringify(body));

async function rig(claim: Reply | Reply[] | null = null, env: Record<string, string | undefined> = {}) {
  const appPort = await freePort();
  const app = await startApp(appPort);
  const api = await startApi(claim);
  const g = await startGuard(appPort, { LIVELY_API_URL: api.url + "/", ...env });
  return { app, api, g, done: async () => { g.stop(); await app.close(); await api.close(); } };
}
const claims = (api: { calls: ApiCall[] }): ApiCall[] => api.calls.filter((c) => c.path.endsWith("/claim"));

test("D1 ★ 시작 확인 → 앱이 받는 머리글 = x-lively-member · x-lively-member-name(인코딩) · x-lively-variant · x-lively-identity(돌기 신원) — x-lively-job 없음 · 들어온 x-lively-* 는 지움 · 본문 · 길이 · 답 그대로(엣지 표 4)", async () => {
  const r = await rig();
  try {
    const out = await callReq(r.g.port, "/api/tools/ask?lang=ko", { q: "휴가 규정", n: 1 }, CALL, {
      "x-lively-member": "mallory", "x-lively-job": "99", "x-lively-variant": "draft", "x-lively-whatever": "1", "x-lively-guard": "timeout",
    });
    assert.equal(out.status, 200);
    assert.equal(out.headers["x-lively-guard"], undefined, "앱의 답에는 문 표지가 없다(문이 직접 낸 답이 아니다)");
    assert.equal(out.headers["x-app-mark"], "1", "앱의 머리글은 그대로");
    assert.deepEqual(JSON.parse(out.body), { answer: "연차는 15일", got: { q: "휴가 규정", n: 1 } });
    const cl = claims(r.api);
    assert.equal(cl.length, 1);
    assert.equal(cl[0]!.path, "/api/app-calls/41/claim", "주소 끝의 / 는 하나로");
    assert.equal(cl[0]!.headers.authorization, "Bearer app-token-1", "게이트웨이 자격 = 함수의 앱 서버 토큰");
    assert.equal(cl[0]!.headers["x-lively-call-secret"], SECRET, "부르기 비밀");
    assert.equal(r.app.seen.length, 1);
    const seen = r.app.seen[0]!;
    assert.ok(cl[0]!.at <= seen.at, "앱보다 시작 확인이 먼저");
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/api/tools/ask?lang=ko");
    assert.deepEqual(JSON.parse(seen.body), { q: "휴가 규정", n: 1 });
    assert.equal(seen.headers["content-length"], String(Buffer.byteLength(seen.body)));
    assert.equal(seen.headers["x-lively-identity"], RUN, "부르기 신원 대신 돌기 신원(앱의 SDK 가 다시 싣는다)");
    assert.equal(decodeURIComponent(String(seen.headers["x-lively-member"])), "윤상민");
    assert.equal(decodeURIComponent(String(seen.headers["x-lively-member-name"])), "윤 상민");
    assert.equal(seen.headers["x-lively-variant"], "draft");
    const livelyHeaders = Object.keys(seen.headers).filter((k) => k.startsWith("x-lively-")).sort();
    assert.deepEqual(livelyHeaders, ["x-lively-identity", "x-lively-member", "x-lively-member-name", "x-lively-variant"], "그 밖의 x-lively-* 없음(작업 번호 · 위조 머리글)");
  } finally { await r.done(); }
});

test("D1b 앱의 답을 흘려 보낸다(모았다 보내지 않는다) · 앱의 오류 상태도 그대로(게이트웨이가 도구 오류로 바꾼다)", async () => {
  const r = await rig();
  try {
    const out = await callReq(r.g.port, "/stream", {});
    assert.equal(out.status, 200);
    assert.equal(out.body, "조각0\n조각1\n조각2\n조각3\n조각4\n");
    assert.ok(out.chunks.length >= 3 && out.chunks.at(-1)! - out.chunks[0]! >= 500, `조각이 시간에 걸쳐 왔다 ${JSON.stringify(out.chunks)}`);
    const nf = await callReq(r.g.port, "/x?status=404", {});
    assert.equal(nf.status, 404);
    assert.equal(nf.headers["x-lively-guard"], undefined);
  } finally { await r.done(); }
});

test("D2 ★ 같은 부르기 비밀 두 번(claim 409) — 409 denied(call_replayed · 까닭) · 앱 0 · 다시 묻지 않는다(엣지 표 5)", async () => {
  const r = await rig({ status: 409, body: { error: "x", reason: "claimed" } });
  try {
    const out = await callReq(r.g.port, "/api/tools/ask", { q: 1 });
    assert.equal(out.status, 409);
    assert.equal(out.headers["x-lively-guard"], "denied");
    assert.deepEqual(JSON.parse(out.body), { error: "call_replayed", reason: "claimed" });
    assert.equal(r.app.seen.length, 0, "재전송이 앱에 닿았다");
    assert.equal(claims(r.api).length, 1, "409 는 판정 — 다시 하지 않는다");
  } finally { await r.done(); }
});

test("D3 위조 · 남의 부르기(claim 401 · 403 · 404) — 401 denied(call_identity_invalid) · 앱 0", async () => {
  for (const status of [401, 403, 404]) {
    const r = await rig({ status, body: { error: "x" } });
    try {
      const out = await callReq(r.g.port, "/api/tools/ask", {});
      assert.equal(out.status, 401, `claim ${status}`);
      assert.equal(out.headers["x-lively-guard"], "denied");
      assert.equal(JSON.parse(out.body).error, "call_identity_invalid");
      assert.equal(r.app.seen.length, 0);
      assert.equal(claims(r.api).length, 1, `claim ${status} 는 판정 — 다시 하지 않는다`);
    } finally { await r.done(); }
  }
});

test("D4 게이트웨이가 잠깐 안 됨(5xx · 429 · 돌기 신원 없는 200) — 두 번까지 묻고 503(call_claim_unavailable) · 앱 0", async () => {
  for (const claim of [{ status: 503, body: {} }, { status: 429, body: {} }, { status: 200, body: { call: 41 } }] as Reply[]) {
    const r = await rig(claim);
    try {
      const out = await callReq(r.g.port, "/api/tools/ask", {});
      assert.equal(out.status, 503, JSON.stringify(claim));
      assert.equal(out.headers["x-lively-guard"], "error");
      assert.equal(JSON.parse(out.body).error, "call_claim_unavailable");
      assert.equal(r.app.seen.length, 0);
      assert.equal(claims(r.api).length, claim.status === 200 ? 1 : 2, "일시 오류는 두 번까지 · 200 은 판정");
    } finally { await r.done(); }
  }
  //  게이트웨이에 아예 닿지 못한다(주소가 닫힘) — 매달리지 않고 503.
  const appPort = await freePort();
  const app = await startApp(appPort);
  const dead = await freePort();
  const g = await startGuard(appPort, { LIVELY_API_URL: `http://127.0.0.1:${dead}` });
  try {
    const out = await callReq(g.port, "/api/tools/ask", {});
    assert.equal(out.status, 503);
    assert.equal(app.seen.length, 0);
  } finally { g.stop(); await app.close(); }
});

test("D5 ★ 앱이 요청 시간을 넘긴다 — 504 timeout(x-lively-guard) · claim 이 걸린 시간도 요청 시간에 들어간다(엣지 표 6)", async () => {
  //  요청 시간 2초(claim 의 timeout_s) · claim 이 1.2초 걸림 · 앱은 1.5초 — 합 2.7초 > 2초라 끊긴다. 앱만 보면 2초 안이다.
  const r = await rig({ status: 200, body: { call: 41, run: RUN, member: "m", member_name: "m", variant: "pub", timeout_s: 2 }, delayMs: 1200 });
  try {
    const out = await callReq(r.g.port, "/api/tools/ask?ms=1500", {});
    assert.equal(out.status, 504);
    assert.equal(out.headers["x-lively-guard"], "timeout");
    assert.equal(JSON.parse(out.body).error, "app_timeout");
    assert.ok(out.at >= 1900 && out.at < 2700, `받은 때부터 2초 안팎에 끊었다 — ${out.at}ms`);
    assert.equal(r.app.seen.length, 1, "앱에는 닿았다(시작 확인 뒤)");
  } finally { await r.done(); }
});

test("D6 본문이 1MiB 를 넘으면 413(claim 0 · 앱 0) — 경계 1MiB 정확히는 받는다", async () => {
  const r = await rig();
  try {
    const pad = (n: number): string => JSON.stringify({ p: "x".repeat(n - 8) });
    const exact = pad(CALL_BODY_MAX);
    assert.equal(Buffer.byteLength(exact), CALL_BODY_MAX);
    const ok = await req(r.g.port, "/api/tools/ask", { "content-type": "application/json", "x-lively-identity": CALL }, "POST", exact);
    assert.equal(ok.status, 200, "경계는 받는다");
    const big = await req(r.g.port, "/api/tools/ask", { "content-type": "application/json", "x-lively-identity": CALL }, "POST", pad(CALL_BODY_MAX + 1));
    assert.equal(big.status, 413);
    assert.equal(JSON.parse(big.body).error, "call_body_too_large");
    assert.equal(claims(r.api).length, 1, "넘친 부르기는 확인하지도 않는다");
    assert.equal(r.app.seen.length, 1);
  } finally { await r.done(); }
});

test("D7 (새로 쓰는 env 가 없음) 라이블리 주소 · 앱 서버 토큰이 없는 함수 — 401 call_unconfigured · claim 0 · 앱 0", async () => {
  for (const env of [{ LIVELY_API_URL: "" }, { LIVELY_APP_TOKEN: undefined }]) {
    const appPort = await freePort();
    const app = await startApp(appPort);
    const api = await startApi();
    const g = await startGuard(appPort, { LIVELY_API_URL: api.url, ...env });
    try {
      const out = await callReq(g.port, "/api/tools/ask", {});
      assert.equal(out.status, 401, JSON.stringify(env));
      assert.equal(JSON.parse(out.body).error, "call_unconfigured");
      assert.equal(api.calls.length, 0);
      assert.equal(app.seen.length, 0);
    } finally { g.stop(); await app.close(); await api.close(); }
  }
});

test("D8 돌기 신원(lvsr1)으로 함수를 직접 부르면 — 부르기가 아니라 사람 신원 검사로 가서 401(claim 0 · 앱 0)", async () => {
  const r = await rig();
  try {
    const out = await callReq(r.g.port, "/api/tools/ask", {}, RUN);
    assert.equal(out.status, 401);
    assert.equal(JSON.parse(out.body).error, "identity_invalid");
    assert.equal(claims(r.api).length, 0);
    assert.equal(r.app.seen.length, 0);
  } finally { await r.done(); }
});

test("D9 claim 의 timeout_s 가 없거나 범위 밖이면 함수 env 의 요청 시간(LIVELY_REQUEST_TIMEOUT_S) — 둘 다 있으면 짧은 쪽", async () => {
  for (const t of [undefined, 0, 99999, "x"]) {
    const r = await rig({ status: 200, body: { call: 41, run: RUN, member: "m", member_name: "m", variant: "pub", ...(t === undefined ? {} : { timeout_s: t }) } }, { LIVELY_REQUEST_TIMEOUT_S: "1" });
    try {
      const out = await callReq(r.g.port, "/api/tools/ask?ms=1600", {});
      assert.equal(out.status, 504, `timeout_s=${String(t)} → env 1초`);
    } finally { await r.done(); }
  }
  const r2 = await rig({ status: 200, body: { call: 41, run: RUN, member: "m", member_name: "m", variant: "pub", timeout_s: 1 } }, { LIVELY_REQUEST_TIMEOUT_S: "30" });
  try {
    const out = await callReq(r2.g.port, "/api/tools/ask?ms=1600", {});
    assert.equal(out.status, 504, "claim 1초 < env 30초 → 1초");
  } finally { await r2.done(); }
});

test("D10 판 — claim 의 variant 가 draft 면 draft, 그 밖(없음 · 이상한 값)이면 pub", async () => {
  for (const [variant, want] of [["draft", "draft"], ["pub", "pub"], [undefined, "pub"], ["DRAFT", "pub"], ["x", "pub"]] as const) {
    const r = await rig({ status: 200, body: { call: 41, run: RUN, member: "m", member_name: "m", timeout_s: 30, ...(variant === undefined ? {} : { variant }) } });
    try {
      await callReq(r.g.port, "/api/tools/ask", {});
      assert.equal(r.app.seen[0]?.headers["x-lively-variant"], want, String(variant));
    } finally { await r.done(); }
  }
});

test("D11 사람 요청 길은 그대로 — 서명 신원이면 claim 없이 앱에 닿는다(부르기 갈래가 사람 길을 가로채지 않는다)", async () => {
  const r = await rig();
  try {
    const now = Math.floor(Date.now() / 1000);
    const tok = signAppIdentity({ ws: WS, app: APP, var: "pub", sub: "sangmin-yoon", name: "윤상민", iat: now - 5, exp: now + 595 }, key.privateKey, "k1");
    const out = await req(r.g.port, "/x", { "x-lively-identity": tok, "content-type": "application/json" }, "POST", "{}");
    assert.equal(out.status, 200);
    assert.equal(claims(r.api).length, 0);
    assert.equal(r.app.seen[0]?.headers["x-lively-identity"], tok, "사람 신원 원문 그대로");
    assert.equal(r.app.seen[0]?.headers["x-lively-member"], "sangmin-yoon");
  } finally { await r.done(); }
});

test("D12 #4487 자가호스팅 열쇠 — LIVELY_GUARD_KEY 가 있으면 부르기 길도 앱에 x-lively-guard-key 를 싣는다(들어온 같은 머리글은 지우고 문의 값만) · 없으면 안 싣는다", async () => {
  const r = await rig(null, { LIVELY_GUARD_KEY: "k-container-1" });
  try {
    const out = await callReq(r.g.port, "/api/tools/ask", { q: "x" }, CALL, { "x-lively-guard-key": "forged" });
    assert.equal(out.status, 200);
    assert.equal(r.app.seen[0]?.headers["x-lively-guard-key"], "k-container-1", "문의 열쇠(들어온 위조 값이 아니라)");
  } finally { await r.done(); }
  const r0 = await rig();
  try {
    await callReq(r0.g.port, "/api/tools/ask", { q: "x" }, CALL, { "x-lively-guard-key": "forged" });
    assert.equal(r0.app.seen[0]?.headers["x-lively-guard-key"], undefined, "Lambda(열쇠 없음)엔 싣지 않는다 · 들어온 값도 지운다");
  } finally { await r0.done(); }
});
