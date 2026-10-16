// 앱 서버 길(#4485 앱 v2-6)의 **실제 express 배선** — 사양 표 SW(spec-4485.md). index.ts 와 같은 순서로 붙인다:
//  서버 쓰기 길(appFrontServerRouter) → 전역 express.json(1mb) → 나머지 앱 주소 길(registerAppFrontRoutes). Lambda 는 가짜 invokeStream(받은 이벤트를 기록하고
//  본문 지문을 돌려준다)이다.
//  이게 틀리면: 전역 JSON 읽기가 본문을 먼저 먹어 앱이 빈 본문 · 다시 쓴 JSON 을 받거나, 서버가 없는 앱에 쓰기가 닿거나, 오류가 HTML 로 나가 앱의 fetch 가 넘어진다.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { signAppFront } from "./app-front-auth.js";
import { appFrontServerRouter, registerAppFrontRoutes, type AppFrontDeps } from "./app-front-routes.js";
import type { AppServerFrontDeps } from "./app-front-server.js";
import { ed25519FromSeed, signAppIdentity } from "./app-identity.js";
import { HTTP_INTEGRATION_CT } from "./app-server-stream.js";
import { APP_SERVER_POLICY_DEFAULT } from "./app-server-policy.js";
import type { ServerRow } from "./app-server-store.js";
import type { LambdaApi } from "./app-server-deploy.js";
import type { StreamEvent } from "../net/aws/lambda-lite.js";
import type { OrgMember } from "../org/store/members.js";
import type { OrgApp } from "../org/store/apps.js";

const SECRET = "s3cret";
const T = { id: "11111111-2222-4333-8444-555555555555", slug: "lively-46e3" };
const key = ed25519FromSeed(crypto.createHash("sha256").update("front-server-wire").digest());
const ROLE = "arn:aws:iam::111122223333:role/lvly-app-exec";
const BASE_ENV = { LIVELY_TENANT_HEADER_SECRET: SECRET, LIVELY_APP_DOMAIN: "lvly.app", LIVELY_APP_IDENTITY_PUBKEYS: JSON.stringify({ k1: key.publicKeyB64 }) };
const now = (): number => Math.floor(Date.now() / 1000);
type Who = { v?: "pub" | "draft"; mid?: string };
const front = (app: string, o: Who = {}): string => signAppFront(SECRET, { op: "act", t: T.id, ws: T.slug, app, var: o.v ?? "pub", mid: o.mid ?? "alice", iat: now() } as never);
const ident = (app: string, o: Who = {}): string =>
  signAppIdentity({ ws: T.id, app, var: o.v ?? "pub", sub: o.mid ?? "alice", name: "앨리스", iat: now() - 2, exp: now() + 500 }, key.privateKey, "k1");

const member = { id: "alice", kind: "human", display_name: "앨리스", nickname: null, use_nickname: false, email: "a@x.io", identities: [], body_md: "",
  avatar: null, avatar_char: null, avatar_color: null, state: "active", scopes: ["memory"], sort: 0, version: 1, updated_at: null, updated_by: null } as unknown as OrgMember;
const mkApp = (id: string, manifest: unknown): OrgApp => ({ id, title: id, version: "1", manifest, source: {}, content_hash: "h", status: "active", enabled: true,
  visibility: "all", owner_member: "alice", draft_by: null, published_version_no: null }) as unknown as OrgApp;
const APPS: Record<string, OrgApp> = {
  srv: mkApp("srv", { web: { server: true } }), plain: mkApp("plain", {}),
  //  SW10 — 꺼진 앱 · 남(밥)의 초안이 걸린 공개 앱(앨리스의 초안 주소는 없는 판)
  off: { ...mkApp("off", { web: { server: true } }), enabled: false } as OrgApp,
  drafty: { ...mkApp("drafty", { web: { server: true } }), draft_by: "bob", published_version_no: 1 } as unknown as OrgApp,
};
const gone = { ...member, id: "carol", state: "inactive" } as unknown as OrgMember;
const row: ServerRow = {
  app_id: "srv", function_name: "lvly-app-srv-lively-46e3", cur_version_no: 1, cur_build_key: "b", cur_lambda_version: "3", cur_at: null,
  pub_version_no: null, pub_build_key: null, pub_lambda_version: null, pub_at: null, stopped_at: null, stopped_by: null, stop_kind: null, stop_reason: null,
  lock_until: null, last_error: null, created_at: "", updated_at: "", cur_token_hash: "th-cur", pub_token_hash: null,
} as ServerRow;

interface Seen { method: string; rawPath: string; rawQueryString: string; body: Buffer; qual: string }

/** 가짜 Lambda — 받은 이벤트를 적고, 본문 길이 · 지문을 JSON 으로 돌려준다(앱이 받은 바이트를 본다). */
function echoApi(seen: Seen[]): LambdaApi {
  return {
    invokeStream: async (_fn: string, qual: string, payloadJson: string) => {
      const ev = JSON.parse(payloadJson) as { rawPath: string; rawQueryString: string; body?: string; isBase64Encoded?: boolean; requestContext: { http: { method: string } } };
      const body = ev.body ? Buffer.from(ev.body, ev.isBase64Encoded ? "base64" : "utf8") : Buffer.alloc(0);
      seen.push({ method: ev.requestContext.http.method, rawPath: ev.rawPath, rawQueryString: ev.rawQueryString, body, qual });
      const out = JSON.stringify({ n: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") });
      async function* events(): AsyncGenerator<StreamEvent> {
        yield { type: "chunk", data: Buffer.concat([Buffer.from(JSON.stringify({ statusCode: 200, headers: { "content-type": "application/json" } })), Buffer.alloc(8)]) };
        yield { type: "chunk", data: Buffer.from(out) };
        yield { type: "complete", errorCode: null, errorDetails: null, log: "REPORT RequestId: r\tDuration: 2.00 ms\tBilled Duration: 3 ms\t" };
      }
      return { status: 200, executedVersion: qual, contentType: HTTP_INTEGRATION_CT, events: events() };
    },
  } as unknown as LambdaApi;
}

async function start(o: { serverOn?: boolean } = {}): Promise<{ port: number; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const env = { ...BASE_ENV, ...(o.serverOn === false ? {} : { LIVELY_APP_SERVER_EXEC_ROLE: ROLE }) } as NodeJS.ProcessEnv;
  const server = (): AppServerFrontDeps => ({
    env, api: echoApi(seen), getServerRow: async (id) => (id === "srv" ? row : null), policy: async () => APP_SERVER_POLICY_DEFAULT, record: () => undefined,
  });
  const deps: AppFrontDeps = {
    env, tenant: () => T as never, getMember: async (id) => (id === "alice" ? member : id === "carol" ? gone : null), getApp: async (id) => APPS[id] ?? null,
    listUiAssets: async () => [], getUiAsset: async () => null, redeem: async () => null, scripts: async () => ({ runtime: "window.lively={}", probe: "" }), server,
  };
  const app = express();
  //  index.ts 와 같은 순서 — 서버 쓰기 길이 전역 JSON 읽기보다 먼저다.
  app.use("/api/app-front/server", ...appFrontServerRouter(() => deps));
  app.use(express.json({ limit: "1mb" }));
  registerAppFrontRoutes(app, () => deps);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { port: (srv.address() as AddressInfo).port, seen, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

function call(port: number, method: string, path: string, o: { app?: string; body?: Buffer | string; headers?: Record<string, string>; noFront?: boolean; badFront?: boolean; who?: Who } = {}):
  Promise<{ status: number; type: string; allow: string; text: string; json: any }> {
  return new Promise((resolve, reject) => {
    const app = o.app ?? "srv";
    const h: Record<string, string> = { "x-lively-identity": ident(app, o.who), ...(o.headers ?? {}) };
    if (!o.noFront) h["x-lvly-app-front"] = o.badFront ? front(app, o.who).slice(0, -2) + "xx" : front(app, o.who);
    if (o.body !== undefined) h["content-length"] = String(Buffer.byteLength(o.body));
    const r = http.request({ host: "127.0.0.1", port, method, path, headers: h, agent: false }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { t += c; });
      res.on("end", () => {
        let j: unknown = null;
        try { j = JSON.parse(t); } catch { j = null; }
        resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), allow: String(res.headers.allow ?? ""), text: t, json: j });
      });
    });
    r.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE" || e.code === "ECONNRESET") return; reject(e); });
    r.end(o.body);
  });
}
const W = (p: string): string => `/api/app-front/server?path=${encodeURIComponent(p)}`;
const sha = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");

test("SW1 JSON 본문 POST — 함수가 받은 본문 = 보낸 바이트(전역 JSON 읽기가 먼저 먹지 않는다) · 메서드 · 경로 · 쿼리 그대로", async () => {
  const h = await start();
  try {
    //  공백 · 키 순서까지 그대로여야 한다 — 전역 파서가 읽고 다시 쓰면 바이트가 바뀐다.
    const body = '{ "b": 2,  "a": [1, 2, 3], "t": "한글" }';
    const r = await call(h.port, "POST", W("/api/items?x=1&y=%20z"), { body, headers: { "content-type": "application/json" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(h.seen.length, 1, "함수를 한 번 불러야 한다");
    assert.equal(h.seen[0]!.method, "POST");
    assert.equal(h.seen[0]!.rawPath, "/api/items");
    assert.equal(h.seen[0]!.rawQueryString, "x=1&y=%20z");
    assert.equal(h.seen[0]!.body.toString("utf8"), body);
    assert.deepEqual(r.json, { n: Buffer.byteLength(body), sha256: sha(body) });
    //  같은 길로 PUT · PATCH · DELETE 도 간다(바이너리 본문 포함).
    const bin = crypto.randomBytes(3000);
    for (const m of ["PUT", "PATCH", "DELETE"]) {
      const x = await call(h.port, m, W("/api/bin"), { body: bin, headers: { "content-type": "application/octet-stream" } });
      assert.equal(x.status, 200, `${m} ${x.text}`);
      assert.equal(x.json.sha256, sha(bin), m);
    }
    assert.deepEqual(h.seen.map((s) => s.method), ["POST", "PUT", "PATCH", "DELETE"]);
  } finally { await h.close(); }
});

test("SW2 경계 — 본문 정확히 4MiB 는 통과 · 4MiB+1 은 413 JSON(body_too_large) · 함수 0", async () => {
  const h = await start();
  try {
    const exact = Buffer.alloc(4 * 1024 * 1024, 0x61);
    const a = await call(h.port, "POST", W("/up"), { body: exact, headers: { "content-type": "application/octet-stream" } });
    assert.equal(a.status, 200, a.text.slice(0, 200));
    assert.equal(a.json.n, exact.length);
    const over = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61);
    const b = await call(h.port, "POST", W("/up"), { body: over, headers: { "content-type": "application/octet-stream" } });
    assert.equal(b.status, 413);
    assert.match(b.type, /application\/json/, "오류도 JSON 이어야 한다(Express 기본 HTML 이 아니라)");
    assert.equal(b.json.error, "body_too_large");
    assert.equal(h.seen.length, 1, "넘친 요청은 함수를 부르지 않는다");
  } finally { await h.close(); }
});

test("SW9 압축 본문(Content-Encoding gzip · br) → 415 JSON(unsupported_encoding) · 함수 0 — 풀면 «보낸 바이트 그대로» 가 아니다 · identity 는 그대로", async () => {
  const h = await start();
  try {
    const zlib = await import("node:zlib");
    const raw = Buffer.from(JSON.stringify({ hello: "세계" }));
    for (const [enc, body] of [["gzip", zlib.gzipSync(raw)], ["br", zlib.brotliCompressSync(raw)], ["deflate", zlib.deflateSync(raw)]] as const) {
      const r = await call(h.port, "POST", W("/api/x"), { body, headers: { "content-type": "application/json", "content-encoding": enc } });
      assert.equal(r.status, 415, enc);
      assert.match(r.type, /application\/json/, `${enc}: 오류가 JSON 이 아니다`);
      assert.equal(r.json.error, "unsupported_encoding", enc);
    }
    assert.equal(h.seen.length, 0, "압축 본문을 함수로 넘겼다");
    const ok = await call(h.port, "POST", W("/api/x"), { body: raw, headers: { "content-type": "application/json", "content-encoding": "identity" } });
    assert.equal(ok.status, 200);
    assert.equal(h.seen[0]!.body.toString(), raw.toString(), "identity 본문이 바뀌었다");
  } finally { await h.close(); }
});

test("SW3 GET · HEAD 를 쓰기 길로 → 405 JSON + Allow · 함수 0", async () => {
  const h = await start();
  try {
    const g = await call(h.port, "GET", W("/x"));
    assert.equal(g.status, 405);
    assert.match(g.allow, /POST/);
    assert.equal(g.json.error, "method_not_allowed");
    const hd = await call(h.port, "HEAD", W("/x"));
    assert.equal(hd.status, 405);
    assert.equal(h.seen.length, 0);
  } finally { await h.close(); }
});

test("SW4 서버를 선언하지 않은 앱에 POST → 405 JSON(method_not_allowed) · 함수 0", async () => {
  const h = await start();
  try {
    const r = await call(h.port, "POST", W("/x"), { app: "plain", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(r.status, 405);
    assert.match(r.type, /application\/json/);
    assert.equal(r.json.error, "method_not_allowed");
    assert.equal(h.seen.length, 0);
  } finally { await h.close(); }
});

test("SW5 앞단 기계 헤더 없음 · 틀림 → 401 JSON · 함수 0", async () => {
  const h = await start();
  try {
    for (const o of [{ noFront: true }, { badFront: true }]) {
      const r = await call(h.port, "POST", W("/x"), { ...o, body: "{}", headers: { "content-type": "application/json" } });
      assert.equal(r.status, 401, JSON.stringify(o));
      assert.match(r.type, /application\/json/);
    }
    assert.equal(h.seen.length, 0);
  } finally { await h.close(); }
});

test("SW10 쓰기 길의 문 — 꺼진 앱 409 · 남의 초안이 걸린 앱의 초안 주소 404 · 비활성 구성원 403 — 모두 JSON(화면 HTML 이 아님) · 함수 0", async () => {
  const h = await start();
  try {
    const cases: Array<[string, Parameters<typeof call>[3], number]> = [
      ["꺼진 앱", { app: "off" }, 409],
      ["남의 초안 · 초안 주소", { app: "drafty", who: { v: "draft" } }, 404],
      ["비활성 구성원", { who: { mid: "carol" } }, 403],
    ];
    for (const [why, o, status] of cases) {
      const r = await call(h.port, "POST", W("/x"), { ...o, body: "{}", headers: { "content-type": "application/json" } });
      assert.equal(r.status, status, why);
      assert.match(r.type, /application\/json/, `${why}: 쓰기 길이 화면(HTML)으로 답했다`);
      assert.ok(r.json && typeof r.json.error === "string", `${why}: JSON 오류가 아니다`);
    }
    assert.equal(h.seen.length, 0, "막힌 쓰기가 함수에 닿았다");
  } finally { await h.close(); }
});

test("SW6 서버 앱의 화면 GET(/page) → 함수가 답한다(GET · 본문 없음 · 경로 그대로 · 별칭 cur)", async () => {
  const h = await start();
  try {
    const r = await call(h.port, "GET", `/api/app-front/page?path=${encodeURIComponent("/dash/a%2Fb?tab=2")}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(h.seen.length, 1);
    assert.deepEqual({ ...h.seen[0]!, body: h.seen[0]!.body.length }, { method: "GET", rawPath: "/dash/a%2Fb", rawQueryString: "tab=2", body: 0, qual: "cur" });
  } finally { await h.close(); }
});

test("SW7 ★실행 역할 env 없음(앱 서버 꺼짐) — /page 는 함수를 부르지 않고(정적 길) · 쓰기는 405 · 함수 0", async () => {
  const h = await start({ serverOn: false });
  try {
    const p = await call(h.port, "GET", `/api/app-front/page?path=${encodeURIComponent("/")}`);
    assert.notEqual(p.status, 200, "화면이 없는 시험 앱 — 정적 길이면 404 류");
    assert.match(p.type, /text\/html/, "정적 길의 오류 화면");
    const w = await call(h.port, "POST", W("/x"), { body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(w.status, 405);
    assert.equal(h.seen.length, 0, "꺼졌으면 함수를 부르지 않는다");
  } finally { await h.close(); }
});

test("SW8 index.ts — 서버 쓰기 길이 전역 express.json 보다 먼저 붙는다(위 시험들이 가정한 순서)", async () => {
  const fs = await import("node:fs");
  //  dist/apps/ → 레포 루트/src/index.ts(cwd 무관)
  const src = fs.readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
  const server = src.indexOf('app.use("/api/app-front/server", ...appFrontServerRouter())');
  const json = src.search(/app\.use\(express\.json\(\{ limit: "1mb"/);
  assert.ok(server > 0, "index.ts 에 서버 쓰기 길이 없다");
  assert.ok(json > 0, "index.ts 에서 전역 JSON 읽기를 못 찾았다(이 시험을 고쳐야 한다)");
  assert.ok(server < json, "서버 쓰기 길이 전역 JSON 읽기 뒤에 붙었다 — JSON 본문을 전역 파서가 먼저 먹는다");
});
