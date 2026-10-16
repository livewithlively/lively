// 같은 주소 API(/_lively/* → /api/app-front/lively, #4482)의 **실제 express 배선** — 본문 파서 · 오류의 모양.
// 실행: npm run build && node dist/apps/app-front-api-wire.test.js
//  W1 JSON 본문(application/json) → 도구 인자로 · W2 Content-Type 을 빠뜨린 JSON · text/plain JSON 도 읽는다(앱이 헤더를 잊어도 된다)
//  W3 깨진 JSON(전역 파서 · 이 라우트 파서 둘 다) · 폼 꼴 본문 → 400 JSON(code bad_body) — 종전엔 Express 기본 HTML 400(격리 리뷰 4)
//  W4 1MB 넘는 본문 → 413 JSON(code body_too_large) · W5 GET 은 본문 없이 · 응답은 늘 no-store JSON
//  이게 틀리면: fetch 로 부르는 앱이 오류를 res.json() 하다 SyntaxError 로 넘어지거나, 개발 환경에서 스택(파일 경로)이 앱 코드로 샌다.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { signAppFront } from "./app-front-auth.js";
import { registerAppFrontRoutes, type AppFrontDeps } from "./app-front-routes.js";
import type { AppFrontApiDeps } from "./app-front-api.js";
import type { OrgMember } from "../org/store/members.js";
import type { OrgApp } from "../org/store/apps.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };

const SECRET = "s3cret";
const T = { id: "11111111-1111-1111-1111-111111111111", slug: "lively-46e3" };
const ENV = { LIVELY_TENANT_HEADER_SECRET: SECRET, LIVELY_APP_DOMAIN: "lvly.app" } as NodeJS.ProcessEnv;
const sign = (): string => signAppFront(SECRET, { op: "act", t: T.id, ws: T.slug, app: "talk", var: "pub", mid: "alice", iat: Math.floor(Date.now() / 1000) } as never);

const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
const api: AppFrontApiDeps = {
  workspaceAccess: async () => true,
  runTool: async (_who, _app, name, args) => { calls.push({ name, args }); return { ran: name, args }; },
  prefsGet: async () => ({ prefs: {} }), prefsSet: async (_w, _a, patch) => ({ prefs: patch }),
  gatewayBase: async () => "https://lively-46e3.app.lvly.io",
};
const member = { id: "alice", kind: "human", display_name: "앨리스", nickname: null, use_nickname: false, email: "a@x.io", identities: [], body_md: "",
  avatar: null, avatar_char: null, avatar_color: null, state: "active", scopes: ["memory"], sort: 0, version: 1, updated_at: null, updated_by: null } as unknown as OrgMember;
const theApp = { id: "talk", title: "톡", version: "1", manifest: {}, source: {}, content_hash: "h", status: "active", enabled: true,
  visibility: "all", owner_member: "alice", draft_by: null, published_version_no: null } as unknown as OrgApp;
const deps: AppFrontDeps = {
  env: ENV, tenant: () => T as never, getMember: async (id) => (id === "alice" ? member : null), getApp: async (id) => (id === "talk" ? theApp : null),
  listUiAssets: async () => [], getUiAsset: async () => null, redeem: async () => null, scripts: async () => ({ runtime: "window.lively={}", probe: "" }), api,
};

const app = express();
app.use(express.json({ limit: "1mb" }));   // 전역 파서(src/index.ts 와 같은 자리 · 같은 상한) — 이 라우트보다 먼저 돈다
registerAppFrontRoutes(app, () => deps);
const srv = http.createServer(app);
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
const port = (srv.address() as AddressInfo).port;

function req(method: string, path: string, body?: string | Buffer, headers: Record<string, string> = {}): Promise<{ status: number; type: string; cache: string; json: any }> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { "x-lvly-app-front": sign(), ...headers };
    if (body !== undefined) h["content-length"] = String(Buffer.byteLength(body));
    const r = http.request({ host: "127.0.0.1", port, method, path, headers: h }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { t += c; });
      res.on("end", () => {
        let j: unknown = null;
        try { j = JSON.parse(t); } catch { j = { __raw: t.slice(0, 200) }; }
        resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), cache: String(res.headers["cache-control"] ?? ""), json: j });
      });
    });
    r.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE" || e.code === "ECONNRESET") return; reject(e); });
    r.end(body);
  });
}
const P = (p: string): string => `/api/app-front/lively?path=${encodeURIComponent(p)}`;

try {
  // W1
  const a = await req("POST", P("/store/notes/query"), JSON.stringify({ match: { done: false }, limit: 3 }), { "content-type": "application/json" });
  assert.equal(a.status, 200);
  assert.deepEqual(calls.at(-1), { name: "store_query", args: { table: "notes", match: { done: false }, limit: 3 } });
  assert.match(a.type, /application\/json/);
  assert.equal(a.cache, "no-store");
  ok("W1 application/json 본문 → 도구 인자 · no-store JSON");

  // W2
  const b = await req("POST", P("/store/notes/insert"), JSON.stringify({ row: { text: "헤더 없음" } }));
  assert.equal(b.status, 200);
  assert.deepEqual(calls.at(-1), { name: "store_insert", args: { table: "notes", row: { text: "헤더 없음" } } });
  const c = await req("POST", P("/tools/whoami"), JSON.stringify({ x: 1 }), { "content-type": "text/plain;charset=UTF-8" });
  assert.equal(c.status, 200);
  assert.deepEqual(calls.at(-1), { name: "whoami", args: { x: 1 } });
  ok("W2 Content-Type 을 빠뜨린 JSON · text/plain JSON 도 읽는다");

  // W3
  const n = calls.length;
  for (const [body, headers, why] of [
    ["{bad json", { "content-type": "application/json" }, "깨진 JSON(전역 파서)"],
    ["{bad json", {}, "깨진 JSON(이 라우트 파서)"],
    ["a=1&b=2", { "content-type": "application/x-www-form-urlencoded" }, "폼 꼴 본문"],
    ["\"abc\"", { "content-type": "application/json" }, "JSON 이지만 객체가 아닌 값(strict)"],
  ] as const) {
    const r = await req("POST", P("/store/sql"), body, headers as Record<string, string>);
    assert.equal(r.status, 400, why);
    assert.match(r.type, /application\/json/, `${why} — HTML 이 아니라 JSON`);
    assert.equal(r.json.code, "bad_body", why);
    assert.ok(!JSON.stringify(r.json).includes("node_modules") && !JSON.stringify(r.json).includes(" at "), `${why} — 스택이 새지 않는다`);
  }
  assert.equal(calls.length, n, "읽지 못한 본문으로는 도구를 부르지 않는다");
  ok("W3 깨진 본문 · 폼 꼴 · 객체 아닌 JSON → 400 JSON(code bad_body) · 도구 0");

  // W4
  const big = await req("POST", P("/store/sql"), JSON.stringify({ sql: "x".repeat(1_100_000) }), { "content-type": "application/json" });
  assert.equal(big.status, 413);
  assert.match(big.type, /application\/json/);
  assert.equal(big.json.code, "body_too_large");
  const big2 = await req("POST", P("/store/sql"), JSON.stringify({ sql: "x".repeat(1_100_000) }));
  assert.equal(big2.status, 413, "Content-Type 없이도(이 라우트 파서) 413");
  assert.equal(big2.json.code, "body_too_large");
  ok("W4 1MB 넘는 본문 → 413 JSON(두 파서 모두)");

  // W5
  const g = await req("GET", P("/store/tables"));
  assert.equal(g.status, 200);
  assert.deepEqual(calls.at(-1), { name: "store_tables", args: {} });
  const nope = await req("GET", P("/nope"));
  assert.ok(nope.status === 404 && /application\/json/.test(nope.type) && nope.json.code === "not_found");
  const noSig = await new Promise<number>((resolve) => { http.request({ host: "127.0.0.1", port, method: "GET", path: P("/store/tables") }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).end(); });
  assert.equal(noSig, 401, "기계 헤더가 없으면 401");
  ok("W5 GET 은 본문 없이 · 없는 API 404 JSON · 기계 헤더 없으면 401");
} finally {
  await new Promise<void>((r) => srv.close(() => r()));
}
console.log(`\n${pass} passed`);
