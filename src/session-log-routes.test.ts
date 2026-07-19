// #905 C1 슬2b 회귀 — 캡처 append 엔드포인트의 HTTP 계약. 실제 express 앱 + 소켓으로 검증한다
//  (순수 단위론 못 잡는 계층 — 리뷰가 "route layer 무커버리지 → 블로킹 2건을 기존 스위트가 못 잡음" 으로 지적).
//  차단하는 회귀 2건:
//   🔴 content-type 가 octet-stream 이 아니면(특히 전역 express.json 이 먼저 스트림을 소진하는 application/json)
//      readRawBody 가 'data'/'end' 를 영영 못 받아 **매달렸다**. → ① 라우트가 415 로 일찍 막고 ② readRawBody 는
//      이미 소진된 스트림(readableEnded)에 매달리지 않고 즉시 종료한다.
//   🔴 8MB 초과 시 req.destroy() 로 **소켓을 죽여** 413 을 보낼 상대가 사라졌다(클라는 커넥션 끊김만 봄).
//      → pause() 로 바꿔 소켓을 살려두고 진짜 413(바디 포함)을 돌려준다.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { readRawBody, MAX_DELTA, registerSessionLogRoutes } from "./session-log-routes.js";
import type { BearerVerifier } from "./auth/bearer.js";
import { wrap } from "./capabilities/rest-util.js";

interface Resp { status: number; body: string }
// POST 헬퍼 — 상태코드+바디로 resolve. 서버가 매달리면 timeoutMs 후 reject(=hang 회귀 시 여기로 빠져 테스트 실패).
//  소켓이 죽으면(413 회귀) 'error' 로 reject(=413 을 못 받으면 테스트 실패). 즉 두 회귀 모두 여기서 걸린다.
function post(port: number, path: string, opts: { body?: Buffer; contentType?: string; timeoutMs?: number }): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { authorization: "Bearer x" };
    if (opts.contentType) headers["content-type"] = opts.contentType;
    if (opts.body) headers["content-length"] = String(opts.body.length);
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path, headers }, (res) => {
      let data = ""; res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    const to = setTimeout(() => req.destroy(new Error("client-timeout — 서버가 응답 없이 매달림(hang 회귀)")), opts.timeoutMs ?? 2000);
    req.on("close", () => clearTimeout(to));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function listen(app: express.Express): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }));
  });
}

// 항상 u1 으로 인증되는 가짜 검증기(DB 무접촉). 실제 sessionOrBearer→requireBearerAuth 경로를 태운다.
const fakeVerifier = {
  verifyAccessToken: async () => ({
    token: "x", clientId: "u1", scopes: [] as string[],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { userId: "u1", email: "u1@example.com", scopes: [] },
  }),
} as unknown as BearerVerifier;

async function main(): Promise<void> {
  let pass = 0; const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };

  // ── ① 실제 라우트 + 전역 express.json(프로덕션 순서) — application/json POST 는 415 로 즉시 막힌다(매달리지 않음). ──
  //   가드가 getRuntimeConfig(DB) 앞에 있어 이 경로는 DB 무접촉 → 순수 라우트 계약만 본다.
  {
    const app = express();
    app.use(express.json({ limit: "1mb" }));           // 🔑 프로덕션 index.ts 와 같은 순서(전역 json 파서 먼저)
    registerSessionLogRoutes(app, fakeVerifier);
    const { port, close } = await listen(app);
    try {
      const r = await post(port, "/api/ui/v6/sessions/s1/log?at=0", { body: Buffer.from("{}"), contentType: "application/json" });
      assert.equal(r.status, 415, "🔴 json content-type 은 415(전역 파서가 소진 → readRawBody 매달림 회귀 차단)");
      ok("① 실제 라우트 — application/json POST → 415 즉시(매달리지 않음)");
    } finally { close(); }
  }

  // ── readRawBody 격리 검증(전역 express.json 뒤에 둔 라우트에서) — 세 가지 ──
  const LIMIT = 16;
  const rawApp = express();
  rawApp.use(express.json({ limit: "1mb" }));
  rawApp.post("/raw", wrap(async (req, res) => { const buf = await readRawBody(req, LIMIT); res.json({ n: buf.length }); }));
  const raw = await listen(rawApp);
  try {
    // ② 정상 octet-stream → 그대로 수집.
    {
      const r = await post(raw.port, "/raw", { body: Buffer.from("hello world"), contentType: "application/octet-stream" }); // 11B < 16
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(r.body).n, 11, "octet-stream 바이트를 정확히 수집");
      ok("② 정상 octet-stream → 바이트 수집");
    }
    // ③ 🔴 이미 express.json 이 소진한 스트림 → readRawBody 가 매달리지 않고 즉시 종료(readableEnded).
    {
      const r = await post(raw.port, "/raw", { body: Buffer.from("{}"), contentType: "application/json", timeoutMs: 1500 });
      assert.equal(r.status, 200, "소진된 스트림에서도 응답이 온다(매달리면 client-timeout 으로 reject)");
      assert.equal(JSON.parse(r.body).n, 0, "이미 소진 → 남은 바이트 0");
      ok("③ 소진된 스트림(readableEnded) → 매달리지 않고 즉시 종료");
    }
    // ④ 🔴 상한 초과 → 소켓을 죽이지 않고 진짜 413(바디 포함)을 돌려준다.
    {
      const r = await post(raw.port, "/raw", { body: Buffer.alloc(LIMIT + 64, 0x41), contentType: "application/octet-stream" });
      assert.equal(r.status, 413, "🔴 초과는 413(소켓을 죽이면 커넥션 끊김만 보여 여기서 reject 됨)");
      assert.match(r.body, /너무 큽니다|error/, "413 바디가 실제로 전달된다(소켓 생존)");
      ok("④ 상한 초과 → 소켓 생존 + 진짜 413 응답");
    }
  } finally { raw.close(); }

  assert.ok(MAX_DELTA === 8 * 1024 * 1024, "MAX_DELTA 상한 노출(엔드포인트와 동일)");
  console.log(`\n${pass} passed`);
}

await main();
