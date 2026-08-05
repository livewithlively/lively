// 공유 승격 차단 — POST /api/ui/nodes/:id/share 의 HTTP 계약 (#1558). 실제 express 앱 + 소켓으로 검증한다.
// 행 번호(S1~S4)는 사양 엣지 표와 1:1.
//
// 무엇을 막나: 종전엔 관리자가 **아무 노드나** `{shared:true}` 로 올릴 수 있었다(#1540). 그러면 구성원이 붙여 둔
// 개인 노트북이 어느 날 조직 공용이 되는 경로가 열려 있다. 공유 컴퓨터는 **등록할 때** 정하는 것으로 바꿨고
// (POST /api/ui/nodes {shared:true}), 이 라우트는 **해제 전용**이 됐다. 그 규칙이 살아 있는지 못박는다.
//
// 왜 라우트 계층인가: 이 규칙은 순수 함수가 아니라 **핸들러 안의 판정 순서**로 표현된다(권한 → 승격차단 → DB).
// 순수 단위로 내리면 `() => false` 를 검사하는 공허한 테스트가 되고 정작 회귀(핸들러에서 조건이 사라지는 것)를
// 못 잡는다. 아래 케이스는 전부 **DB 조회 전에** 끝나므로 실 DB 없이 계약만 본다 — DB 경로로 새면 응답이
// 돌아오지 않아 타임아웃으로 잡힌다(그 자체가 '순서가 틀어졌다'는 관측이다).
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { registerNodeRoutes } from "./routes.js";
import type { BearerVerifier } from "../auth/bearer.js";

interface Resp { status: number; body: string }

function post(port: number, path: string, body: unknown): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1", port, method: "POST", path,
      headers: { authorization: "Bearer x", "content-type": "application/json", "content-length": String(payload.length) },
    }, (res) => {
      let data = ""; res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    // 판정이 DB 뒤로 밀리면 여기서 응답이 안 온다 — 그 회귀도 실패로 잡히게 타임아웃을 둔다.
    const to = setTimeout(() => req.destroy(new Error("client-timeout — 판정이 DB 경로 뒤로 밀렸을 수 있음")), 3000);
    req.on("close", () => clearTimeout(to));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function listen(app: express.Express): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }));
  });
}

// scopes 만 바꿔 끼우는 가짜 검증기(DB 무접촉) — 실제 sessionOrBearer→requireBearerAuth 경로를 그대로 태운다.
const verifierWith = (scopes: string[]): BearerVerifier => ({
  verifyAccessToken: async () => ({
    token: "x", clientId: "u1", scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { userId: "u1", email: "u1@example.com", scopes },
  }),
}) as unknown as BearerVerifier;

async function withApp(scopes: string[], fn: (port: number) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));   // 프로덕션 index.ts 와 같은 순서(전역 json 파서 먼저)
  registerNodeRoutes(app, verifierWith(scopes));
  const { port, close } = await listen(app);
  try { await fn(port); } finally { close(); }
}

async function main(): Promise<void> {
  let pass = 0;
  const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };

  // ── S1 🔴 급소 — 관리자의 승격 요청은 400. 대상 노드가 실재하지 않아도(존재 검사 전에) 같은 답이어야 한다.
  //   200 이 오면 승격 경로가 되살아난 것이고, 404 가 오면 규칙이 노드 상태에 따라 흔들리는 것이다.
  await withApp(["admin"], async (port) => {
    const r = await post(port, "/api/ui/nodes/nonexistent-node/share", { shared: true });
    assert.equal(r.status, 400,
      `🔴 관리자의 승격 요청은 400 이어야 한다(200=승격 부활 · 404=DB 뒤로 밀림) — got ${r.status} ${r.body.slice(0, 160)}`);
    ok("S1 관리자 + shared:true(승격) → 400 · 노드 조회 전에 차단");
  });

  // ── S2 형변환 우회 없음 — truthy 면 전부 승격 시도다.
  await withApp(["admin"], async (port) => {
    for (const v of ["true", 1, "1", {}] as unknown[]) {
      const r = await post(port, "/api/ui/nodes/nonexistent-node/share", { shared: v });
      assert.equal(r.status, 400, `S2 shared=${JSON.stringify(v)} 도 승격 시도다 — got ${r.status}`);
    }
    ok("S2 truthy 한 shared 값(문자열·숫자·객체) 전부 400 — 형변환 우회 불가");
  });

  // ── S3·S4 권한이 먼저 — 비관리자는 무엇을 보내든 403. 400 이 오면 내부 규칙이 권한 없는 사람에게 새는 것이고,
  //   순서가 뒤집혔다는 뜻이다.
  await withApp(["items", "context"], async (port) => {
    for (const shared of [true, false]) {
      const r = await post(port, "/api/ui/nodes/nonexistent-node/share", { shared });
      assert.equal(r.status, 403, `S3/S4 비관리자는 shared=${shared} 든 403 — got ${r.status}`);
    }
    ok("S3·S4 비관리자 → 403(권한 판정이 승격 차단보다 앞)");
  });

  // 배선 확인 — 위 단언들이 '라우트가 아예 없어서' 통과한 게 아님을 못박는다(없으면 404 가 온다).
  //  등록 라우트는 신원만 보고 400/403 을 내므로 DB 없이도 응답이 온다.
  await withApp(["admin"], async (port) => {
    const r = await post(port, "/api/ui/nodes/nonexistent-node/no-such-action", { shared: true });
    assert.equal(r.status, 404, `배선 확인 — 없는 경로는 404 여야 한다(got ${r.status}). 위 400/403 은 실제 핸들러가 낸 것이다.`);
    ok("배선 확인 — 없는 경로는 404(위 응답이 실제 핸들러에서 나왔다는 증거)");
  });

  // ⚠ S5(관리자 + shared:false → 해제)는 여기서 검증하지 않는다 — 그 경로는 getNode/DB 를 타므로 실 DB 가
  //  필요하다(이 계층은 DB 무접촉이 규율). 해제 동작은 화면·통합 검증의 몫이다.

  console.log(`\n${pass} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
