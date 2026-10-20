// 게이트웨이 → 앱 서버 함수(#4485 앱 v2-6) 시험 — 사양 표 D(spec-4485.md). 진짜 express 위에서 serveAppServer 를 부르고, Lambda 는 가짜
//  invokeStream(부른 것 기록 · 사건을 직접 만든다)이다. 받는 쪽은 진짜 HTTP 클라이언트라 흘려 보내기 · 끊김을 그대로 본다.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import express from "express";
import { buildFunctionUrlEvent, responseHeadersOf, serveAppServer, splitAppPath, stripFrameAncestors, type AppServerFrontDeps, type ServerTarget } from "./app-front-server.js";
import { ed25519FromSeed, signAppIdentity } from "./app-identity.js";
import { HTTP_INTEGRATION_CT } from "./app-server-stream.js";
import { APP_SERVER_POLICY_DEFAULT, type AppServerPolicy } from "./app-server-policy.js";
import { inflightNow, resetInflightForTest } from "./app-server-usage.js";
import type { LambdaApi } from "./app-server-deploy.js";
import type { ServerRow } from "./app-server-store.js";
import type { StreamEvent } from "../net/aws/lambda-lite.js";
import { AwsError } from "../net/aws/aws-json.js";
import { scriptVersion } from "./app-server-page.js";

const TENANT = { id: "11111111-2222-4333-8444-555555555555", slug: "lively-46e3" };
const key = ed25519FromSeed(crypto.createHash("sha256").update("front-server-test").digest());
const ENV: NodeJS.ProcessEnv = {
  LIVELY_APP_SERVER_EXEC_ROLE: "arn:aws:iam::111122223333:role/lvly-app-exec", LIVELY_APP_DOMAIN: "lvly.app",
  LIVELY_APP_IDENTITY_PUBKEYS: JSON.stringify({ k1: key.publicKeyB64 }),
};
const now = (): number => Math.floor(Date.now() / 1000);
const ident = (o: Partial<{ sub: string; var: "pub" | "draft"; app: string }> = {}): string =>
  signAppIdentity({ ws: TENANT.id, app: o.app ?? "notes", var: o.var ?? "pub", sub: o.sub ?? "m-1", name: "윤상민", iat: now() - 2, exp: now() + 500 }, key.privateKey, "k1");

const row = (o: Partial<ServerRow> = {}): ServerRow => ({
  app_id: "notes", function_name: "lvly-app-notes-lively-46e3", cur_version_no: 3, cur_build_key: "b", cur_lambda_version: "7", cur_at: null,
  pub_version_no: 2, pub_build_key: "a", pub_lambda_version: "5", pub_at: null, stopped_at: null, stopped_by: null, stop_kind: null, stop_reason: null,
  lock_until: null, last_error: null, created_at: "", updated_at: "", cur_token_hash: "th-cur", pub_token_hash: "th-pub", code_bytes: 0, unused_since: null,
  health: null, health_checked_at: null, ...o,
});

type Script = { kind: "ok"; prelude: unknown; body: Array<string | { wait: number }>; report?: string; errorCode?: string } | { kind: "err"; payload: string; report?: string } | { kind: "throw"; e: unknown };
interface Call { fn: string; qual: string; event: Record<string, unknown>; timeoutMs: number; signal?: AbortSignal }

function fakeApi(script: Script, calls: Call[], state: { consumed: boolean } = { consumed: false }): LambdaApi {
  return {
    invokeStream: async (fn: string, qual: string, payloadJson: string, o: { timeoutMs: number; signal?: AbortSignal }) => {
      calls.push({ fn, qual, event: JSON.parse(payloadJson), timeoutMs: o.timeoutMs, signal: o.signal });
      if (script.kind === "throw") throw script.e;
      async function* events(): AsyncGenerator<StreamEvent> {
        if (script.kind === "err") { yield { type: "chunk", data: Buffer.from(script.payload) }; yield { type: "complete", errorCode: null, errorDetails: null, log: script.report ?? "" }; return; }
        if (script.kind !== "ok") return;
        yield { type: "chunk", data: Buffer.concat([Buffer.from(JSON.stringify(script.prelude)), Buffer.alloc(8)]) };
        for (const b of script.body) {
          if (typeof b === "string") yield { type: "chunk", data: Buffer.from(b) };
          else await new Promise((r) => setTimeout(r, b.wait));
        }
        state.consumed = true;
        yield { type: "complete", errorCode: script.errorCode ?? null, errorDetails: null, log: script.report ?? "REPORT RequestId: r\tDuration: 3.00 ms\tBilled Duration: 4 ms\tMemory Size: 512 MB\t" };
      }
      return { status: 200, executedVersion: qual, contentType: script.kind === "ok" ? HTTP_INTEGRATION_CT : "application/octet-stream", events: events() };
    },
  } as unknown as LambdaApi;
}

interface Harness { port: number; calls: Call[]; recorded: Array<{ app: string; r: unknown }>; consumed: () => boolean; close: () => Promise<void> }
async function start(script: Script, o: { row?: ServerRow | null; view?: "installed" | "published"; act?: Partial<{ var: "pub" | "draft"; mid: string }>; policy?: Partial<AppServerPolicy>; env?: NodeJS.ProcessEnv;
  scripts?: AppServerFrontDeps["scripts"] } = {}): Promise<Harness> {
  const calls: Call[] = [];
  const recorded: Array<{ app: string; r: unknown }> = [];
  const state = { consumed: false };
  const deps: AppServerFrontDeps = {
    env: o.env ?? ENV, api: fakeApi(script, calls, state), getServerRow: async () => (o.row === undefined ? row() : o.row),
    policy: async () => ({ ...APP_SERVER_POLICY_DEFAULT, ...(o.policy ?? {}) }), record: (app, r) => recorded.push({ app, r }),
    ...(o.scripts ? { scripts: o.scripts } : {}),
  };
  const app = express();
  app.use(express.raw({ type: () => true, limit: "4mb" }));
  app.all(/.*/, async (req, res) => {
    const target: ServerTarget = {
      tenant: TENANT as ServerTarget["tenant"],
      act: { op: "act", t: TENANT.id, ws: TENANT.slug, app: "notes", var: o.act?.var ?? "pub", mid: o.act?.mid ?? "m-1", iat: now() },
      member: { id: "m-1" } as ServerTarget["member"], app: { id: "notes" } as ServerTarget["app"], view: o.view ?? "installed",
    };
    const body = Buffer.isBuffer(req.body) && req.body.length ? req.body : null;
    await serveAppServer(req, res, target, body, String(req.query.path ?? req.url), deps);
  });
  const srv = await new Promise<http.Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  return { port: (srv.address() as net.AddressInfo).port, calls, recorded, consumed: () => state.consumed, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET", body?: string):
  Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; chunks: Array<{ at: number; s: string }>; complete: boolean }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = http.request({ host: "127.0.0.1", port, path: `/?path=${encodeURIComponent(path)}`, method, headers, agent: false }, (res) => {
      const chunks: Array<{ at: number; s: string }> = [];
      res.setEncoding("utf8");
      res.on("data", (c: string) => chunks.push({ at: Date.now() - t0, s: c }));
      res.on("error", () => undefined);
      res.on("close", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: chunks.map((c) => c.s).join(""), chunks, complete: res.complete }));
    });
    r.on("error", () => resolve({ status: 0, headers: {}, body: "", chunks: [], complete: false }));
    r.end(body);
  });
}

const OK: Script = { kind: "ok", prelude: { statusCode: 200, headers: { "content-type": "application/json" }, cookies: [] }, body: ["{\"ok\":1}"] };

test("D1 별칭 — 주소의 판이 공개 판이면 pub · 설치된 판이면 cur · 함수 이름은 줄의 것 · 시한은 요청 상한 + 5초", async () => {
  for (const [view, qual] of [["published", "pub"], ["installed", "cur"]] as const) {
    const h = await start(OK, { view });
    try {
      const r = await get(h.port, "/", { "x-lively-identity": ident() });
      assert.equal(r.status, 200);
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0]!.qual, qual);
      assert.equal(h.calls[0]!.fn, "lvly-app-notes-lively-46e3");
      assert.equal(h.calls[0]!.timeoutMs, APP_SERVER_POLICY_DEFAULT.timeout_s * 1000 + 5000);
    } finally { await h.close(); }
  }
});

test("D2 · D3 · D18 그 별칭에 올린 판이 없음 · 줄 없음 · 멈춘 앱 · 앱 서버 꺼짐 → 503 · 함수 호출 0", async () => {
  const cases: Array<[string, Parameters<typeof start>[1], string]> = [
    ["cur 판 없음", { row: row({ cur_lambda_version: null }) }, "app_server_not_deployed"],
    ["pub 판 없음", { row: row({ pub_lambda_version: null }), view: "published" }, "app_server_not_deployed"],
    ["줄 없음", { row: null }, "app_server_not_deployed"],
    ["멈춤", { row: row({ stopped_at: "2026-10-16", stop_reason: "5분 호출 3만 초과" }) }, "app_server_stopped"],
    ["앱 서버 꺼짐", { env: { ...ENV, LIVELY_APP_SERVER_EXEC_ROLE: "" } }, "app_server_off"],
  ];
  for (const [name, o, code] of cases) {
    const h = await start(OK, o);
    try {
      const r = await get(h.port, "/", { "x-lively-identity": ident() });
      assert.equal(r.status, 503, name);
      assert.equal(JSON.parse(r.body).error, code, name);
      assert.equal(h.calls.length, 0, `${name}: 함수를 불렀다`);
    } finally { await h.close(); }
  }
});

test("D4 · D5 ★ 신원 — 머리 없음(앞단 서명 키 미설정) 503 · 다른 사람 · 다른 판 · 다른 앱 · 서명 틀림 401 · 함수 호출 0", async () => {
  const h = await start(OK);
  try {
    const none = await get(h.port, "/");
    assert.equal(none.status, 503);
    assert.equal(JSON.parse(none.body).error, "identity_signing_off");
    //  서명 앞쪽 글자를 바꾼다 — 마지막 글자는 base64url 의 남는 비트라 바꿔도 같은 바이트로 풀릴 수 있다(그러면 «위조» 가 아니다).
    const [h0, h1, h2, sig] = ident().split(".");
    const forged = `${h0}.${h1}.${h2}.${sig![0] === "A" ? "B" : "A"}${sig!.slice(1)}`;
    for (const [name, t] of [["다른 사람", ident({ sub: "m-2" })], ["다른 판", ident({ var: "draft" })], ["다른 앱", ident({ app: "other" })], ["서명 틀림", forged]] as const) {
      const r = await get(h.port, "/", { "x-lively-identity": t });
      assert.equal(r.status, 401, name);
      assert.equal(JSON.parse(r.body).error, "identity_invalid", name);
    }
    assert.equal(h.calls.length, 0, "맞지 않는 신원으로 함수를 불렀다");
  } finally { await h.close(); }
});

test("D6 · D7 ★ 동시 처리 상한 — 앱 상한 · 워크스페이스 상한에 닿으면 429(함수 0 · 거절로 셈) · 경계 바로 아래는 통과 · 끝나면 자리를 돌려준다", async () => {
  resetInflightForTest();
  const slow: Script = { kind: "ok", prelude: { statusCode: 200, headers: {}, cookies: [] }, body: [{ wait: 400 }, "done"] };
  for (const [limits, what] of [[{ max_inflight_app: 2, max_inflight_workspace: 50 }, "앱"], [{ max_inflight_app: 20, max_inflight_workspace: 2 }, "워크스페이스"]] as const) {
    const h = await start(slow, { policy: limits });
    try {
      const a = get(h.port, "/", { "x-lively-identity": ident() });
      const b = get(h.port, "/", { "x-lively-identity": ident() });
      await new Promise((r) => setTimeout(r, 120));   // 둘이 자리를 잡은 뒤
      const c = await get(h.port, "/", { "x-lively-identity": ident() });
      assert.equal(c.status, 429, `${what} 상한에서 셋째가 통과했다`);
      assert.equal(c.headers["retry-after"], "2");
      assert.equal(JSON.parse(c.body).error, "app_server_busy");
      const [ra, rb] = await Promise.all([a, b]);
      assert.equal(ra.status, 200, "경계 바로 아래(둘째까지)는 통과해야 한다");
      assert.equal(rb.status, 200);
      assert.equal(h.calls.length, 2, "거절한 요청이 함수를 불렀다");
      assert.ok(h.recorded.some((x) => (x.r as { rejected?: boolean }).rejected === true), "거절을 세지 않았다");
      //  끝난 뒤 자리를 돌려받았다 — 다시 둘이 동시에 된다
      const [d, e] = await Promise.all([get(h.port, "/", { "x-lively-identity": ident() }), get(h.port, "/", { "x-lively-identity": ident() })]);
      assert.deepEqual([d.status, e.status], [200, 200], "자리를 돌려주지 않았다");
    } finally { await h.close(); }
  }
  //  오류로 끝나도 자리를 돌려준다
  const bad = await start({ kind: "throw", e: new AwsError(500, "ServiceException", "x") }, { policy: { max_inflight_app: 1 } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await get(bad.port, "/", { "x-lively-identity": ident() })).status, 502, `오류 뒤 자리가 남았다(${i})`);
  } finally { await bad.close(); }
});

test("D8 · D9 ★ 함수로 가는 이벤트 — 우리 머리글 · 자격 · 신원 밖 x-lively-* 없음 · host 는 앱 주소 · 쿠키 배열 · 본문 base64 · 쿼리 그대로", () => {
  const ev = buildFunctionUrlEvent({
    method: "post",
    headers: {
      host: "lively-46e3.app.lvly.io", "x-lvly-tenant-auth": "SECRET", "x-lvly-app-front": "v1.x.y", "x-lvly-tenant": "lively-46e3",
      authorization: "Bearer lvk_x", "x-lively-identity": "SPOOF", "x-lively-member": "admin", cookie: "a=1; b=2", "content-length": "3",
      "content-type": "application/json", "x-forwarded-for": "203.0.113.7, 10.0.0.1", connection: "keep-alive", "user-agent": "ua",
    },
    path: { rawPath: "/api/x", rawQueryString: "q=%ED%95%9C&z=1" }, host: "notes-lively-46e3.lvly.app", identity: "REAL", body: Buffer.from("{}"), requestId: "rid", now: 1_700_000_000_000,
  });
  const h = ev.headers as Record<string, string>;
  for (const k of Object.keys(h)) assert.ok(!k.startsWith("x-lvly-"), `우리 머리 ${k} 가 앱으로 간다`);
  assert.equal(h.authorization, undefined);
  assert.equal(h["x-lively-member"], undefined);
  assert.equal(h["x-lively-identity"], "REAL", "들어온 신원 머리를 그대로 넘겼다(앞단이 서명한 값이어야 한다)");
  assert.equal(h.host, "notes-lively-46e3.lvly.app");
  assert.equal(h["x-forwarded-host"], "notes-lively-46e3.lvly.app");
  assert.equal(h.cookie, undefined);
  assert.equal(h.connection, undefined);
  assert.equal(h["content-length"], undefined);
  assert.deepEqual(ev.cookies, ["a=1", "b=2"]);
  assert.equal(ev.rawPath, "/api/x");
  assert.equal(ev.rawQueryString, "q=%ED%95%9C&z=1");
  assert.equal(ev.isBase64Encoded, true);
  assert.equal(Buffer.from(String(ev.body), "base64").toString(), "{}");
  const rc = ev.requestContext as { http: { method: string; sourceIp: string } };
  assert.equal(rc.http.method, "POST");
  assert.equal(rc.http.sourceIp, "203.0.113.7");
  const ev2 = buildFunctionUrlEvent({ method: "GET", headers: {}, path: { rawPath: "/", rawQueryString: "" }, host: "h", identity: "I", body: null, requestId: "r", now: 0 });
  assert.equal(ev2.body, undefined);
  assert.equal(ev2.isBase64Encoded, false);
  assert.equal(ev2.cookies, undefined);
});

test("D10 · D11 · D12 응답 — 상태 · 머리글 · 쿠키 여러 줄 · 표지 · X-Frame-Options · CSP frame-ancestors 걷기 · 조각째 흘려 보냄", async () => {
  const s: Script = {
    kind: "ok",
    prelude: { statusCode: 201, headers: { "content-type": "text/event-stream", "x-frame-options": "SAMEORIGIN", "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
      connection: "keep-alive", "keep-alive": "timeout=60", "x-lvly-tenant-auth": "leak", "x-lively-guard": "x", "cache-control": "no-cache" },
      cookies: ["sid=1; Path=/", "t=2; Path=/"] },
    body: ["data: 1\n\n", { wait: 300 }, "data: 2\n\n"],
  };
  const h = await start(s);
  try {
    const r = await get(h.port, "/stream", { "x-lively-identity": ident() });
    assert.equal(r.status, 201);
    assert.equal(r.headers["x-lvly-app-server"], "1", "앞단이 쿠키를 고쳐 넘길 표지가 없다");
    assert.deepEqual(r.headers["set-cookie"], ["sid=1; Path=/", "t=2; Path=/"]);
    assert.equal(r.headers["x-frame-options"], undefined);
    assert.equal(r.headers["content-security-policy"], "default-src 'self'");
    assert.equal(r.headers["x-lvly-tenant-auth"], undefined);
    assert.equal(r.headers["x-lively-guard"], undefined);
    assert.equal(r.headers["keep-alive"], undefined, "앱 쪽 홉 머리를 넘겼다");
    assert.equal(r.headers["cache-control"], "no-cache", "앱의 캐시 머리를 덮었다");
    assert.equal(r.body, "data: 1\n\ndata: 2\n\n");
    assert.equal(r.complete, true);
    assert.ok(r.chunks.length >= 2 && r.chunks.at(-1)!.at - r.chunks[0]!.at >= 200, `모았다 보냈다: ${JSON.stringify(r.chunks)}`);
    assert.deepEqual(h.recorded.map((x) => x.r), [{ billedMs: 4, error: false }], "호출 셈이 다르다(D16)");
  } finally { await h.close(); }
  assert.equal(stripFrameAncestors("frame-ancestors 'none'"), null);
  assert.equal(stripFrameAncestors("default-src 'self';  FRAME-ANCESTORS x; img-src *"), "default-src 'self'; img-src *");
  //  D21 같은 이름 머리글 여러 줄 = 쉼표로 이은 여러 정책 — 정책마다 빼고 빈 정책은 버린다
  assert.equal(stripFrameAncestors("default-src 'self', frame-ancestors 'none'"), "default-src 'self'", "뒤 정책의 frame-ancestors 가 남았다");
  assert.equal(stripFrameAncestors("frame-ancestors 'none', default-src 'self'"), "default-src 'self'", "앞 정책 하나로 전체를 지웠다");
  assert.equal(stripFrameAncestors("a 1; frame-ancestors x, b 2; frame-ancestors y"), "a 1, b 2");
  assert.equal(stripFrameAncestors("frame-ancestors 'none', frame-ancestors 'self'"), null);
  assert.deepEqual(responseHeadersOf({ statusCode: 200, headers: { "set-cookie": "x=1" }, cookies: ["y=2"] }).cookies, ["y=2", "x=1"]);
});

test("D13 응답 시작 전 Lambda 오류 → 502 · D14 ★ 본문 도중 앱이 죽음 · 시간 넘김 → 연결을 끊는다(완료 아님)", async () => {
  const pre = await start({ kind: "err", payload: JSON.stringify({ errorType: "Runtime.ExitError", errorMessage: "exit 4" }), report: "REPORT RequestId: r\tDuration: 5.00 ms\tBilled Duration: 6 ms\tStatus: error\tError Type: Runtime.ExitError" });
  try {
    const r = await get(pre.port, "/", { "x-lively-identity": ident(), accept: "text/html", "sec-fetch-mode": "navigate" });
    assert.equal(r.status, 502);
    assert.match(String(r.headers["content-type"]), /text\/html/, "D19 문서 이동이면 HTML 오류");
    assert.deepEqual(pre.recorded.map((x) => x.r), [{ billedMs: 6, error: true }]);
  } finally { await pre.close(); }
  for (const status of ["error", "timeout"]) {
    const h = await start({ kind: "ok", prelude: { statusCode: 200, headers: { "content-type": "text/plain" } }, body: ["partial"],
      report: `REPORT RequestId: r\tDuration: 30000.00 ms\tBilled Duration: 30000 ms\tStatus: ${status}` });
    try {
      const r = await get(h.port, "/", { "x-lively-identity": ident() });
      assert.equal(r.status, 200);
      assert.equal(r.body, "partial");
      assert.equal(r.complete, false, `${status}: 잘린 응답을 온전히 끝난 것처럼 닫았다`);
      assert.equal((h.recorded[0]!.r as { error: boolean }).error, true);
    } finally { await h.close(); }
  }
});

test("D13b 응답 시작 전 시간 넘김 → 504 app_server_timeout(요청 하나 시간 안내) · 오류로 셈 — REPORT 만 · errorType 만 · 둘 다", async () => {
  const timedOut = JSON.stringify({ errorType: "Sandbox.Timedout", errorMessage: "RequestId: r Error: Task timed out after 30.00 seconds" });
  const cases: Array<[string, string, string]> = [
    ["둘 다", timedOut, "REPORT RequestId: r\tDuration: 30000.00 ms\tBilled Duration: 30000 ms\tStatus: timeout"],
    ["REPORT 만", "{}", "REPORT RequestId: r\tDuration: 30000.00 ms\tBilled Duration: 30000 ms\tStatus: timeout"],
    ["errorType 만(REPORT 없음)", timedOut, ""],
  ];
  for (const [why, payload, report] of cases) {
    const h = await start({ kind: "err", payload, report });
    try {
      const r = await get(h.port, "/", { "x-lively-identity": ident(), accept: "application/json" });
      assert.equal(r.status, 504, why);
      const j = JSON.parse(r.body);
      assert.equal(j.error, "app_server_timeout", why);
      assert.match(j.message, /30초까지/, `${why}: 요청 하나의 시간(정책 timeout_s)을 알려야 한다`);
      assert.equal((h.recorded[0]!.r as { error: boolean }).error, true, why);
    } finally { await h.close(); }
  }
  //  시간 넘김이 아닌 오류는 그대로 502.
  const h = await start({ kind: "err", payload: JSON.stringify({ errorType: "Runtime.ExitError" }), report: "REPORT RequestId: r\tDuration: 5.00 ms\tBilled Duration: 6 ms\tStatus: error" });
  try { assert.equal((await get(h.port, "/", { "x-lively-identity": ident(), accept: "application/json" })).status, 502); } finally { await h.close(); }
});

test("D15 AWS 오류 — 조절 503 · 함수 없음 503 · 시간 초과 504 · 그 밖 502 · fetch 면 JSON", async () => {
  const cases: Array<[unknown, number, string]> = [
    [new AwsError(429, "TooManyRequestsException", "Rate Exceeded"), 503, "app_server_throttled"],
    [new AwsError(404, "ResourceNotFoundException", "no"), 503, "app_server_missing"],
    [new AwsError(0, "Timeout", "t"), 504, "app_server_timeout"],
    [new AwsError(500, "ServiceException", "x"), 502, "app_server_unavailable"],
    [new Error("boom"), 502, "app_server_unavailable"],
  ];
  for (const [e, status, code] of cases) {
    const h = await start({ kind: "throw", e });
    try {
      const r = await get(h.port, "/", { "x-lively-identity": ident(), accept: "application/json" });
      assert.equal(r.status, status, code);
      assert.equal(JSON.parse(r.body).error, code);
    } finally { await h.close(); }
  }
});

test("D17 경로 — `/` 로 시작하지 않음 · `//` · 제어문자 · 공백 → 400(함수 0) · 정상 경로는 그대로 나눈다", async () => {
  assert.deepEqual(splitAppPath("/a/b?x=1&y=%20"), { rawPath: "/a/b", rawQueryString: "x=1&y=%20" });
  assert.deepEqual(splitAppPath("/"), { rawPath: "/", rawQueryString: "" });
  for (const bad of ["a/b", "//evil.example/x", "/a\nb", "/a b", "", "/\u0000"]) assert.equal(splitAppPath(bad), null, JSON.stringify(bad));
  const h = await start(OK);
  try {
    const r = await new Promise<number>((resolve) => {
      const q = http.request({ host: "127.0.0.1", port: h.port, path: `/?path=${encodeURIComponent("//evil.example/x")}`, headers: { "x-lively-identity": ident() }, agent: false }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      q.end();
    });
    assert.equal(r, 400);
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test("D7' · D19 ★ 브라우저가 응답 도중 떠나도 — 함수 흐름은 끝까지 읽고 그동안 상한 자리를 쥔다 · 끝나면 돌려주고 REPORT 청구 시간으로 · 앱 오류로 세지 않는다", async () => {
  resetInflightForTest();
  const h = await start({ kind: "ok", prelude: { statusCode: 200, headers: {} }, body: ["a", { wait: 600 }, "b"],
    report: "REPORT RequestId: r\tDuration: 650.00 ms\tBilled Duration: 651 ms\t" });
  try {
    await new Promise<void>((resolve) => {
      const q = http.request({ host: "127.0.0.1", port: h.port, path: `/?path=${encodeURIComponent("/")}`, headers: { "x-lively-identity": ident() }, agent: false }, (res) => {
        res.once("data", () => { q.destroy(); resolve(); });
      });
      q.on("error", () => undefined);
      q.end();
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(inflightNow("notes").app, 1, "브라우저가 떠나자마자 자리를 돌려줬다 — 함수는 아직 돈다(끊었다 다시 붙기로 상한을 넘는다)");
    assert.equal(h.calls[0]!.signal, undefined, "함수 흐름을 끊으려 했다(끊어도 Lambda 는 계속 돈다)");
    for (let i = 0; i < 60 && inflightNow("notes").app !== 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(inflightNow("notes").app, 0, "흐름이 끝났는데 자리를 안 돌려줬다");
    assert.equal(h.consumed(), true, "남은 흐름을 끝까지 읽지 않았다");
    assert.deepEqual(h.recorded.map((x) => x.r), [{ billedMs: 651, error: false }], "실제 청구 시간으로 세지 않았거나 · 떠난 것을 앱 오류로 셌다");
  } finally { await h.close(); }
});

test("D20 흐름 끝(InvokeComplete)에 ErrorCode — REPORT 가 ok 이거나 없어도 잘린 응답으로 본다(끊는다) · 오류로 셈", async () => {
  for (const report of ["REPORT RequestId: r\tDuration: 3.00 ms\tBilled Duration: 4 ms\t", ""]) {
    const h = await start({ kind: "ok", prelude: { statusCode: 200, headers: {} }, body: ["part"], errorCode: "Sandbox.Timedout", report });
    try {
      const r = await get(h.port, "/", { "x-lively-identity": ident() });
      assert.equal(r.body, "part");
      assert.equal(r.complete, false, `REPORT=${JSON.stringify(report)}: 잘린 응답을 온전히 끝냈다`);
      assert.equal((h.recorded[0]!.r as { error: boolean }).error, true);
    } finally { await h.close(); }
  }
});

test("D22 ★ 그 별칭의 판에 앱 토큰 기록이 없다(v2-5 때 올린 판) — 부르지 않고 503 app_server_outdated", async () => {
  for (const [view, o] of [["installed", { cur_token_hash: null }], ["published", { pub_token_hash: null }]] as const) {
    const h = await start({ kind: "ok", prelude: { statusCode: 200, headers: {} }, body: ["x"] }, { view, row: row(o) });
    try {
      const r = await get(h.port, "/", { "x-lively-identity": ident(), accept: "application/json" });
      assert.equal(r.status, 503, view);
      assert.equal(JSON.parse(r.body).error, "app_server_outdated", view);
      assert.equal(h.calls.length, 0, `${view}: 옛 판을 불렀다`);
    } finally { await h.close(); }
  }
  //  다른 별칭의 기록만 없으면 이 주소는 연다(공개 판만 옛 판 · 지금 판은 새 판)
  const h = await start({ kind: "ok", prelude: { statusCode: 200, headers: {} }, body: ["ok"] }, { view: "installed", row: row({ pub_token_hash: null }) });
  try { assert.equal((await get(h.port, "/", { "x-lively-identity": ident() })).status, 200); } finally { await h.close(); }
});

// ── R #4485 후속 — 화면 문서에 SDK 런타임 넣기(사양 spec-4485-runtime.md 표 B · C · D 의 흐름 쪽) ──
//  이게 틀리면: 서버 앱이 라이블리 안에서 인사하지 않아 8초 뒤 종전 화면으로 바뀌거나, fetch 로 받는 HTML · JSON · 압축 답이 깨진다.
const DOC = { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
const FAKE_SCRIPTS = async () => ({ runtime: "RT()", probe: "PB()" });
const page = (headers: Record<string, string> = {}, body: Array<string | { wait: number }> = ["<!doctype html><p>안녕</p>"], status = 200): Script =>
  ({ kind: "ok", prelude: { statusCode: status, headers: { "content-type": "text/html; charset=utf-8", ...headers }, cookies: [] }, body });
const sentHeaders = (h: Harness): Record<string, string> => (h.calls[0]!.event as { headers: Record<string, string> }).headers;

test("R1 ★ 화면 문서 — 런타임이 doctype 바로 뒤 · 길이 · 검증값 머리를 뺀다 · 함수로 가는 요청에서 압축 · 조건부 머리를 뺀다 · 나머지는 그대로", async () => {
  const body = "<!doctype html><p>안녕</p>";
  const h = await start(page({ "content-length": String(Buffer.byteLength(body)), etag: "\"e1\"", "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT", "cache-control": "max-age=60" }, [body]),
    { scripts: FAKE_SCRIPTS });
  try {
    const r = await get(h.port, "/page", { ...DOC, "x-lively-identity": ident(), "accept-encoding": "gzip, br", "if-none-match": "\"e1\"", "if-modified-since": "Mon" });
    assert.equal(r.status, 200);
    assert.equal(r.body, "<!doctype html><script>RT()</script><p>안녕</p>");
    assert.equal(r.complete, true);
    assert.equal(r.headers["content-length"], undefined, "넣기 전 길이를 그대로 보냈다");
    assert.equal(r.headers.etag, undefined, "넣기 전 본문의 ETag 를 그대로 보냈다");
    assert.equal(r.headers["last-modified"], undefined);
    assert.equal(r.headers["cache-control"], "max-age=60", "앱의 캐시 머리는 그대로");
    const sent = sentHeaders(h);
    assert.equal(sent["accept-encoding"], undefined, "압축을 청하면 넣을 수 없다");
    assert.equal(sent["if-none-match"], undefined, "304 면 넣을 본문이 없다");
    assert.equal(sent["if-modified-since"], undefined);
    assert.equal(sent["sec-fetch-dest"], "iframe", "나머지 머리는 그대로 간다");
  } finally { await h.close(); }
});

test("R2 문서가 아닌 요청(fetch) · HEAD · JSON · 압축된 답 · 준비물 없음 → 손대지 않는다(바이트 · 머리 · 넘기는 머리 그대로)", async () => {
  const body = "<!doctype html><li>조각</li>";
  //  fetch 로 받는 HTML 조각
  let h = await start(page({ etag: "\"e2\"" }, [body]), { scripts: FAKE_SCRIPTS });
  try {
    const r = await get(h.port, "/frag", { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", accept: "text/html", "accept-encoding": "gzip", "x-lively-identity": ident() });
    assert.equal(r.body, body);
    assert.equal(r.headers.etag, "\"e2\"");
    assert.equal(sentHeaders(h)["accept-encoding"], "gzip", "문서가 아니면 압축 머리를 그대로 넘긴다");
  } finally { await h.close(); }
  //  HEAD — 본문 없음
  h = await start(page({}, []), { scripts: FAKE_SCRIPTS });
  try {
    const r = await get(h.port, "/page", { ...DOC, "accept-encoding": "gzip", "x-lively-identity": ident() }, "HEAD");
    assert.equal(r.status, 200);
    assert.equal(sentHeaders(h)["accept-encoding"], "gzip");
  } finally { await h.close(); }
  //  문서 요청인데 JSON · 압축된 HTML(앱이 머리를 무시하고 압축)
  for (const [headers, b] of [[{ "content-type": "application/json" }, "{\"a\":1}"], [{ "content-encoding": "gzip" }, "\u001f\u008bGZ"]] as const) {
    h = await start(page(headers, [b]), { scripts: FAKE_SCRIPTS });
    try {
      const r = await get(h.port, "/page", { ...DOC, "x-lively-identity": ident() });
      assert.equal(r.body, b, JSON.stringify(headers));
    } finally { await h.close(); }
  }
  //  준비물(웹 빌드 산출물)을 못 읽음 — 넣지 않고 그대로 낸다(화면은 열린다)
  h = await start(page({}, [body]), { scripts: async () => { throw new Error("no web build"); } });
  try {
    const r = await get(h.port, "/page", { ...DOC, "x-lively-identity": ident() });
    assert.equal(r.status, 200);
    assert.equal(r.body, body);
    assert.equal(r.complete, true);
  } finally { await h.close(); }
});

test("R3 조각으로 오는 문서 — doctype 이 조각에 걸쳐도 그 뒤에 · doctype 이 끝나기 전에 흐름이 끝나면 맨 앞 · 흘려 보내기는 그대로", async () => {
  let h = await start(page({}, ["<!doc", { wait: 30 }, "type html><p>a</p>", { wait: 250 }, "<p>b</p>"]), { scripts: FAKE_SCRIPTS });
  try {
    const r = await get(h.port, "/page", { ...DOC, "x-lively-identity": ident() });
    assert.equal(r.body, "<!doctype html><script>RT()</script><p>a</p><p>b</p>");
    assert.ok(r.chunks.length >= 2 && r.chunks.at(-1)!.at - r.chunks[0]!.at >= 150, `모았다 한 번에 보냈다: ${JSON.stringify(r.chunks)}`);
  } finally { await h.close(); }
  h = await start(page({}, ["<!doctype ht"]), { scripts: FAKE_SCRIPTS });
  try {
    const r = await get(h.port, "/page", { ...DOC, "x-lively-identity": ident() });
    assert.equal(r.body, "<script>RT()</script><!doctype ht");
    assert.equal(r.complete, true);
  } finally { await h.close(); }
  //  앱의 오류 화면(404 HTML)도 문서다 — 넣는다
  h = await start(page({}, ["<!doctype html><h1>없음</h1>"], 404), { scripts: FAKE_SCRIPTS });
  try {
    const r = await get(h.port, "/nope", { ...DOC, "x-lively-identity": ident() });
    assert.equal(r.status, 404);
    assert.equal(r.body, "<!doctype html><script>RT()</script><h1>없음</h1>");
  } finally { await h.close(); }
});

test("R4 앱의 CSP · 탐침 — 인라인을 막으면 같은 주소 파일 · nonce 면 그 nonce · 탐침 쿼리면 탐침도 · frame-ancestors 는 걷은 뒤 판정", async () => {
  const cases: Array<[Record<string, string>, string, string]> = [
    [{ "content-security-policy": "default-src 'self'; script-src 'self'; frame-ancestors 'self'" }, "/page", `<script src="/_lively/sdk.js?v=${scriptVersion("RT()")}"></script>`],
    [{ "content-security-policy": "script-src 'nonce-n0nce' 'strict-dynamic'" }, "/page", "<script nonce=\"n0nce\">RT()</script>"],
    [{ "content-security-policy": "frame-ancestors 'none'" }, "/page", "<script>RT()</script>"],
    [{}, "/page?__lively_probe=1", "<script>RT()</script><script>PB()</script>"],
    [{ "content-security-policy": "script-src 'self'" }, "/page?x=1&__lively_probe=1", `<script src="/_lively/sdk.js?v=${scriptVersion("RT()")}"></script><script src="/_lively/probe.js?v=${scriptVersion("PB()")}"></script>`],
  ];
  for (const [headers, path, tag] of cases) {
    const h = await start(page(headers, ["<!doctype html><p>x</p>"]), { scripts: FAKE_SCRIPTS });
    try {
      const r = await get(h.port, path, { ...DOC, "x-lively-identity": ident() });
      assert.equal(r.body, `<!doctype html>${tag}<p>x</p>`, `${JSON.stringify(headers)} ${path}`);
    } finally { await h.close(); }
  }
});
