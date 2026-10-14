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
import { readRawBody, MAX_DELTA, registerSessionLogRoutes, sessionLogProjectClaim } from "./session-log-routes.js";
import type { BearerVerifier } from "../auth/bearer.js";
import { wrap } from "../http/rest-util.js";

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

  assert.deepEqual(sessionLogProjectClaim({ project_id: 17, binding_epoch: 3 }, 99), { projectId: 17, bindingEpoch: 3 });
  assert.deepEqual(sessionLogProjectClaim({ project_id: null, binding_epoch: 4 }, 99), { projectId: null, bindingEpoch: 4 },
    "실행 세션이 detach면 legacy project query로 되살아나면 안 된다");
  assert.deepEqual(sessionLogProjectClaim(null, 99), { projectId: 99, bindingEpoch: undefined });
  assert.equal(sessionLogProjectClaim(null, Number.NaN), null);
  ok("⓪ 실행 바인딩이 legacy query보다 우선하며 detach도 이력에 남김");

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

  // ── ⑥ 검색 기록 요약(#4530)은 관리자만 — 검색어는 그 사람이 찾던 것이다. 가드가 DB 앞에 있어 이 경로는 DB 무접촉. ──
  //   이 줄(isAdmin)이 사라지면 모든 구성원의 검색어가 누구에게나 보인다 — 저장소 시험(search-log.pg-test)은 이걸 못 잡는다(격리 리뷰).
  {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    registerSessionLogRoutes(app, fakeVerifier);        // u1 — 권한(scopes) 없음 = 관리자 아님
    const { port, close } = await listen(app);
    try {
      const r = await new Promise<Resp>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "/api/ui/v6/search-log/summary?days=7", headers: { authorization: "Bearer x" } }, (res) => {
          let data = ""; res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        });
        const to = setTimeout(() => req.destroy(new Error("client-timeout")), 2000);
        req.on("close", () => clearTimeout(to));
        req.on("error", reject);
        req.end();
      });
      assert.equal(r.status, 403, "🔴 관리자가 아니면 403 — 남의 검색어를 보여 주면 안 된다");
      assert.doesNotMatch(r.body, /"abandoned"|"total"/, "요약 본문이 실려 나가지 않는다");
      ok("⑥ 검색 기록 요약 — 관리자가 아니면 403");
    } finally { close(); }
  }

  // ── ⑦ 맞은 말 검색의 POST(#4553 — 세션 이력 사이드바에서 고른 범위) — 본문의 sessions 를 **읽는다**. ──
  //   틀린 목록은 400(조용히 버리고 남은 것으로 찾으면 «그 범위 안에서 찾았다» 는 답이 거짓이 된다), 빈 목록은 저장 쪽에 묻지 않고 빈 답.
  //   검증과 빈 목록 답이 getRuntimeConfig(DB) 앞에 있어 이 경로는 DB 무접촉. 저장 쪽(그 세션의 말만)은 session-history.pg-test M19~M23.
  {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    registerSessionLogRoutes(app, fakeVerifier);
    const { port, close } = await listen(app);
    const search = (body: unknown): Promise<Resp> => post(port, "/api/ui/v6/session-search/messages", { body: Buffer.from(JSON.stringify(body)), contentType: "application/json" });
    try {
      for (const [name, sessions] of [["배열이 아님", "c1"], ["id 꼴이 아닌 값", ["c1", "a b"]], ["글자가 아닌 값", ["c1", 5]], ["상한 초과", Array.from({ length: 5001 }, (_, i) => "s" + i)]] as Array<[string, unknown]>) {
        const r = await search({ q: "검색", sessions });
        assert.equal(r.status, 400, `🔴 sessions ${name} → 400`);
        assert.match(r.body, /sessions/, "무엇이 틀렸는지 말한다");
      }
      ok("⑦ 맞은 말 검색 POST — 틀린 sessions 는 400(배열 아님 · id 꼴 아님 · 글자 아님 · 상한 초과)");
      const empty = await search({ q: "검색", sessions: [] });
      assert.equal(empty.status, 200, "빈 목록은 오류가 아니다");
      assert.deepEqual(JSON.parse(empty.body), { hits: [], total: 0, sessions: 0, capped: false, words: [], pending: 0 }, "🔑 빈 목록 = 찾을 세션이 없다 → 빈 답(전체에서 찾지 않는다)");
      ok("⑦ 맞은 말 검색 POST — 빈 sessions 는 저장 쪽에 묻지 않고 빈 답");
      const noq = await search({ sessions: "틀린 값" });
      assert.equal(noq.status, 200, "검색어가 없으면 종전처럼 빈 답이 먼저다");
      ok("⑦ 맞은 말 검색 POST — 검색어가 없으면 빈 답(종전 GET 과 같은 순서)");
    } finally { close(); }
  }

  // ── readRawBody 격리 검증(전역 express.json 뒤에 둔 라우트에서) — 세 가지 ──
  const LIMIT = 16;
  const rawApp = express();
  rawApp.use(express.json({ limit: "1mb" }));
  rawApp.post("/raw", wrap(async (req, res) => { const buf = await readRawBody(req, LIMIT); res.json({ n: buf.length }); }));
  // 핸들러가 readRawBody 전에 비동기 작업(실제로는 auth 토큰조회)을 하는 경우 — 작은 본문이 그 사이 전부 버퍼된다.
  rawApp.post("/rawdelay", wrap(async (req, res) => { await new Promise((r) => setTimeout(r, 40)); const buf = await readRawBody(req, LIMIT); res.json({ n: buf.length }); }));
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
    // ⑤ 🔴 작은 octet-stream 이 핸들러 지연(auth 비동기) 중 전부 버퍼돼 complete=true 여도 잃지 않는다(#905 실버그 회귀).
    //    complete 를 '소진'으로 오인해 조기 종료하면 여기서 n=0 이 되어 실패한다(작은 델타·서브에이전트 캡처 유실).
    {
      const r = await post(raw.port, "/rawdelay", { body: Buffer.from("small delta"), contentType: "application/octet-stream" }); // 11B
      assert.equal(JSON.parse(r.body).n, 11, "🔑 지연 뒤에도 버퍼된 본문 전량 수집(complete=true 를 소진으로 오인 안 함)");
      ok("⑤ 작은 본문이 핸들러 지연 중 complete=true 여도 유실 없이 수집(readRawBody 회귀)");
    }
  } finally { raw.close(); }

  assert.ok(MAX_DELTA === 8 * 1024 * 1024, "MAX_DELTA 상한 노출(엔드포인트와 동일)");
  console.log(`\n${pass} passed`);
}

await main();
