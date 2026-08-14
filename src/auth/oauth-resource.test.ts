// #1473 T2 — 자원 식별자(RFC 8707 audience) 판정 + /mcp 401 의 인가서버 안내. DB 불요.
//  차단하는 회귀 2건:
//   🔴 audience 검사가 없으면 **남의 자원서버 앞으로 발급된 토큰**이 우리 게이트웨이에서 그대로 통한다
//      (MCP 사양이 MUST 로 금지한 토큰 패스스루). 여기 A 표가 그 경계를 고정한다.
//   🔴 401 에 resource_metadata 가 없으면 챗 클라이언트가 **인가서버를 발견하지 못해** 로그인 화면조차
//      못 띄운다(2026-08-04 dev.lvly.io 실측 상태). H 표가 그 헤더를 고정한다.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { normalizeResource, isOwnResource, resetResourceIdCache } from "./resource-id.js";
import { bearerWithResourceMetadata } from "./http-auth.js";
import type { BearerVerifier } from "./bearer.js";

// 이 스위트는 DB 를 쓰지 않는다 — org 프로필 조회를 타면 공개주소가 우리 통제 밖이 된다.
delete process.env.ITEMS_DATABASE_URL;

const BASE = "https://gw.example";
let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };

function setBase(v: string | undefined): void {
  if (v === undefined) delete process.env.PUBLIC_URL;
  else process.env.PUBLIC_URL = v;
  resetResourceIdCache();
}

// ── 정규화(조각 제거 · 말미 슬래시 제거) ──
assert.equal(normalizeResource(`${BASE}/mcp`), `${BASE}/mcp`);
assert.equal(normalizeResource(`${BASE}/mcp/`), `${BASE}/mcp`, "말미 슬래시 제거");
assert.equal(normalizeResource(`${BASE}/mcp#frag`), `${BASE}/mcp`, "조각 제거");
assert.equal(normalizeResource("  https://a.example/x  "), "https://a.example/x", "공백 제거");
assert.equal(normalizeResource(""), "");
ok("normalizeResource");

// ── A. 대상(resource) 판정 ──
setBase(BASE);
assert.equal(await isOwnResource(null), true, "A1 대상 없음 → 수락(레거시 토큰 무회귀)");
assert.equal(await isOwnResource(`${BASE}/mcp`), true, "A2 정본 자원");
assert.equal(await isOwnResource(BASE), true, "A3 origin 을 자원으로 보낸 클라이언트");
assert.equal(await isOwnResource(`${BASE}/mcp/`), true, "A4 말미 슬래시");
assert.equal(await isOwnResource(`${BASE}/mcp#f`), true, "A5 조각 포함");
assert.equal(await isOwnResource("https://evil.example/mcp"), false, "A6 ★ 남의 자원서버 → 거부");
assert.equal(await isOwnResource(`${BASE}/other`), false, "A6' 같은 호스트라도 다른 경로는 거부");
assert.equal(await isOwnResource("not a url"), false, "A8 URL 아님 → 거부");
setBase(undefined);
assert.equal(await isOwnResource("https://evil.example/mcp"), true, "A7 공개주소 미설정 → 판정 근거 없음(수락)");
ok("isOwnResource (A1~A8)");

// ── H. 401 안내(WWW-Authenticate) ──
// 항상 'good' 토큰만 통과시키는 가짜 검증기 — 실제 requireBearerAuth 경로를 그대로 태운다(DB 무접촉).
const verifier = {
  verifyAccessToken: async (token: string) => {
    if (token === "good") return { token, clientId: "u1", scopes: ["items"], expiresAt: Math.floor(Date.now() / 1000) + 600 };
    throw new InvalidTokenError("invalid token");
  },
} as unknown as BearerVerifier;

interface Probe { status: number; wwwAuth: string; body: string }
function listen(app: express.Express): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }));
  });
}
function get(port: number, auth?: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "/mcp", headers: auth ? { authorization: auth } : {} },
      (res) => {
        let data = ""; res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          wwwAuth: String(res.headers["www-authenticate"] ?? ""),
          body: data,
        }));
      });
    req.on("error", reject);
    req.end();
  });
}

// H1 — 공개주소가 있으면 401 이 보호자원 메타데이터 주소를 가리킨다.
{
  setBase(BASE);
  const app = express();
  app.get("/mcp", bearerWithResourceMetadata(verifier), (_req, res) => { res.json({ ok: true }); });
  const s = await listen(app);
  try {
    const r = await get(s.port);
    assert.equal(r.status, 401, "H1 인증헤더 없음 → 401");
    assert.match(r.wwwAuth, /resource_metadata="https:\/\/gw\.example\/\.well-known\/oauth-protected-resource\/mcp"/,
      "H1 ★ 401 이 인가서버 발견 경로(PRM)를 가리켜야 한다");
    // 배선 단언 — 유효 토큰은 실제로 통과해야 한다(미들웨어가 죽어 있으면 이 줄이 잡는다).
    const good = await get(s.port, "Bearer good");
    assert.equal(good.status, 200, "H3 유효 토큰 → 통과");
    assert.match(good.body, /"ok":true/);
  } finally { s.close(); }
  ok("401 챌린지 — 공개주소 설정 (H1·H3)");
}

// H2 — 공개주소를 못 정하면 안내 없이 종전 401(무회귀). OAuth 를 못 켜는 배포에서 헤더가 거짓말하면 안 된다.
{
  setBase(undefined);
  const app = express();
  app.get("/mcp", bearerWithResourceMetadata(verifier), (_req, res) => { res.json({ ok: true }); });
  const s = await listen(app);
  try {
    const r = await get(s.port);
    assert.equal(r.status, 401);
    assert.ok(r.wwwAuth.startsWith("Bearer "), "H2 종전 챌린지 형태 유지");
    assert.ok(!r.wwwAuth.includes("resource_metadata"), "H2 공개주소 미설정이면 PRM 주소를 광고하지 않는다");
  } finally { s.close(); }
  ok("401 챌린지 — 공개주소 미설정 (H2)");
}

console.log(`oauth-resource tests: ${pass} groups passed`);
