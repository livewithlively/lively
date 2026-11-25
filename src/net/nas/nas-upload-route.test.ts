// NAS 올리기 라우트(PUT NAS_UPLOAD_PATH) — 본문이 파일 바이트 그대로 NAS 에 닿는가.
//  회귀: 이 라우트가 전역 express.json() 뒤에 붙어 `Content-Type: application/json` 본문을 전역 파서가 먼저 읽었다 — Content-Length 가
//   없으면 0바이트 STOR 가 200 {size:0} 으로 끝났고, overwrite=1 이면 기존 파일이 0바이트로 덮였다(1MB 넘는 JSON 은 413).
// 실행: npm run build && node dist/net/nas/nas-upload-route.test.js
//  인증은 가짜 검증기(Bearer)로 지나고 NAS 는 가짜 세션(registerNasUploadRoute 의 open)이라 DB·FTP 가 없다. 문(401·403)의 실제 판정은 nas-access.pg-test R3u 가 본다.
//
//  사양 행:
//   U1 index.ts 는 올리기 라우트를 전역 app.use(express.json( 보다 앞에 붙인다(U3 이 가정한 순서)
//   U2 앞의 처리기(JSON 파서)가 본문을 먼저 읽었으면 415 — NAS 를 열지 않는다(STOR 없음). chunked · Content-Length · 덮기(기존 파일 그대로)
//   U3 index.ts 순서(올리기 → 전역 JSON 파서)에서 application/json 본문이 바이트 그대로 올라간다 — chunked · Content-Length · 1MB 넘는 본문
//   U4 인증을 기다리는 사이 다 받아진 본문(req.complete 이지만 아직 아무도 안 읽음)은 «읽힘» 으로 보지 않는다 — 작은 본문 · 길이 0(빈 파일)
//   U5 앞에 JSON 파서가 있어도 그 파서가 읽지 않은 본문(octet-stream)은 그대로 올라간다 — 파서가 채우는 req.body 로 가르지 않는다
//   U6 자격이 없으면(인증 없음 401 · context 권한 없음 403) 앞 파서가 본문을 읽었어도 그 판정이 먼저다
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import express from "express";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { BearerVerifier } from "../../auth/bearer.js";
import { encodeRawPath } from "../ftp/ftp-list.js";
import { NAS_UPLOAD_PATH } from "./nas-access.js";
import { registerNasUploadRoute } from "./nas-download-route.js";

let pass = 0;
const failed: string[] = [];
const t = (name: string, fn: () => Promise<void> | void): Promise<void> =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log(`ok  ${name}`); },
    (e) => { failed.push(name); console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split("\n").join("\n     ")}`); },
  );

// 가짜 검증기 — 토큰 «ctx» 는 context 권한이 있는 구성원, «noctx» 는 없는 구성원. 그 밖은 401.
const member = (scopes: string[]) => ({ userId: "m1", email: "m1@example.invalid", scopes, projects: ["*"], tokenSource: "db" });
const verifier = {
  async verifyAccessToken(token: string) {
    const user = token === "ctx" ? member(["memory", "context"]) : token === "noctx" ? member(["memory"]) : null;
    if (!user) throw new InvalidTokenError("invalid token");
    return { token, clientId: user.userId, scopes: user.scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: user };
  },
} as unknown as BearerVerifier;

// 가짜 NAS — files: 원본 경로 → 바이트. stor 는 실제 FtpSession 처럼 본문을 pipeline 으로 흘려 받은 바이트만큼 쓴다.
function fakeNas(initial: Record<string, string> = {}) {
  const files = new Map<string, Buffer>(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  const calls: string[] = [];
  let opened = 0;
  const session = {
    async size(raw: string) { calls.push(`SIZE ${raw}`); return files.get(raw)?.length ?? null; },
    async stor(raw: string, body: Readable) {
      calls.push(`STOR ${raw}`);
      const chunks: Buffer[] = [];
      await pipeline(body, new Writable({ write(c: Buffer, _enc, cb) { chunks.push(c); cb(); } }));
      files.set(raw, Buffer.concat(chunks));
      return files.get(raw)!.length;
    },
    async rename(from: string, to: string) { calls.push(`RNTO ${to}`); files.set(to, files.get(from)!); files.delete(from); },
    async dele(raw: string) { calls.push(`DELE ${raw}`); files.delete(raw); },
    async close() {},
  };
  const open = async (_memberId: string) => { opened++; return { session, username: "mine", server: { host: "nas.example.invalid", port: 21 } }; };
  return { files, calls, open, opened: () => opened };
}

async function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  const s = await new Promise<http.Server>((r) => { const v = app.listen(0, "127.0.0.1", () => r(v)); });
  return { port: (s.address() as AddressInfo).port, close: () => new Promise((r) => s.close(() => r())) };
}

/** chunked 면 Content-Length 없이 흘려 보낸다(write 뒤 end — Node 가 Transfer-Encoding: chunked 로 보낸다). */
function put(port: number, o: { name: string; body: Buffer | string; type?: string; chunked?: boolean; overwrite?: boolean; token?: string | null }): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const body = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
  const path = `${NAS_UPLOAD_PATH}?dir=${encodeRawPath("/docs")}&name=${encodeURIComponent(o.name)}${o.overwrite ? "&overwrite=1" : ""}`;
  const headers: Record<string, string> = { "content-type": o.type ?? "application/json" };
  if (o.token !== null) headers.authorization = `Bearer ${o.token ?? "ctx"}`;
  if (!o.chunked) headers["content-length"] = String(body.length);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "PUT", path, headers, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch { /* 본문이 JSON 이 아님 */ } resolve({ status: res.statusCode ?? 0, json }); });
    });
    req.on("error", reject);
    if (body.length) req.write(body);
    req.end();
  });
}

const JSON_BODY = JSON.stringify({ 이름: "견적서", 항목: [1, 2, 3], 메모: "그대로 올라가야 한다" });

await t("U1 index.ts 는 올리기 라우트를 전역 express.json 앞에 붙인다(U3 이 가정한 순서)", () => {
  //  dist/net/nas/ → 레포 루트/src/index.ts(cwd 무관)
  const src = readFileSync(new URL("../../../src/index.ts", import.meta.url), "utf8");
  const upload = src.search(/^registerNasUploadRoute\(app, verifier\);/m);
  const json = src.search(/^app\.use\(express\.json\(/m);
  assert.ok(upload > 0, "index.ts 에 올리기 라우트 등록(registerNasUploadRoute(app, verifier);)이 없다");
  assert.ok(json > 0, "index.ts 에서 전역 express.json 을 못 찾았다(이 시험을 고쳐야 한다)");
  assert.ok(upload < json, "올리기 라우트가 전역 JSON 파서 뒤에 붙었다 — application/json 본문을 파서가 먼저 읽어 빈 파일이 된다");
});

await t("U2 앞의 JSON 파서가 본문을 먼저 읽었으면 415 이고 NAS 를 열지 않는다 — chunked · Content-Length · 덮기", async () => {
  const nas = fakeNas({ "/docs/old.json": "OLD-CONTENT" });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerNasUploadRoute(app, verifier, { open: nas.open });
  const h = await listen(app);
  try {
    for (const c of [
      { label: "chunked", name: "new.json", chunked: true },
      { label: "Content-Length", name: "cl.json", chunked: false },
      { label: "덮기(overwrite=1)", name: "old.json", chunked: true, overwrite: true },
    ]) {
      const r = await put(h.port, { ...c, body: JSON_BODY });
      assert.equal(r.status, 415, `${c.label}: status=${r.status} body=${JSON.stringify(r.json)}`);
      assert.match(String(r.json?.error ?? ""), /application\/octet-stream/, `${c.label}: 다시 보낼 방법을 알려 준다`);
    }
    assert.equal(nas.opened(), 0, `NAS 를 열었다: ${JSON.stringify(nas.calls)}`);
    assert.ok(!nas.calls.some((x) => x.startsWith("STOR")), `STOR 가 불렸다: ${JSON.stringify(nas.calls)}`);
    assert.deepEqual([...nas.files.keys()], ["/docs/old.json"], "새 파일이 생기지 않는다");
    assert.equal(nas.files.get("/docs/old.json")!.toString(), "OLD-CONTENT", "덮기 요청이어도 기존 파일은 그대로다");
  } finally { await h.close(); }
});

await t("U3 index.ts 순서(올리기 → 전역 JSON 파서)에서 application/json 본문이 바이트 그대로 올라간다", async () => {
  const nas = fakeNas();
  const app = express();
  registerNasUploadRoute(app, verifier, { open: nas.open });
  app.use(express.json({ limit: "1mb" }));
  const h = await listen(app);
  try {
    const big = Buffer.from(JSON.stringify({ a: "x".repeat(2_000_000) }));   // 전역 파서 상한(1MB)을 넘는다 — 뒤에 붙었다면 413
    for (const c of [
      { label: "chunked", name: "a.json", body: Buffer.from(JSON_BODY), chunked: true },
      { label: "Content-Length", name: "b.json", body: Buffer.from(JSON_BODY), chunked: false },
      { label: "1MB 넘는 JSON", name: "c.json", body: big, chunked: false },
    ]) {
      const r = await put(h.port, c);
      assert.equal(r.status, 200, `${c.label}: status=${r.status} body=${JSON.stringify(r.json)}`);
      assert.equal(r.json?.size, c.body.length, `${c.label}: 응답 크기`);
      assert.ok(nas.files.get(`/docs/${c.name}`)?.equals(c.body), `${c.label}: NAS 에 쓴 바이트가 보낸 바이트와 같다`);
    }
  } finally { await h.close(); }
});

await t("U4 인증을 기다리는 사이 다 받아진 본문(complete · 아직 안 읽힘)은 «읽힘» 이 아니다 — 작은 본문 · 빈 파일", async () => {
  const nas = fakeNas();
  const app = express();
  const completeAtRoute: boolean[] = [];
  //  인증(세션·토큰 조회)이 느린 자리 — 작은 본문은 그 사이 소켓에서 다 받아져 req.complete 가 되지만 스트림은 아직 아무도 안 읽었다
  app.use(NAS_UPLOAD_PATH, (req, _res, next) => {
    const t0 = Date.now();
    const tick = (): void => { if (req.complete || Date.now() - t0 > 1000) { completeAtRoute.push(req.complete); next(); } else setTimeout(tick, 5); };
    tick();
  });
  registerNasUploadRoute(app, verifier, { open: nas.open });
  app.use(express.json({ limit: "1mb" }));
  const h = await listen(app);
  try {
    const r = await put(h.port, { name: "small.json", body: "{}", chunked: false });
    //  빈 파일 — lively_local_nas_push 는 octet-stream · Content-Length 0 으로 보낸다. 받을 바이트가 없다고 «읽힘» 이 아니다
    const r0 = await put(h.port, { name: "empty.bin", body: "", type: "application/octet-stream", chunked: false });
    assert.deepEqual(completeAtRoute, [true, true], "(전제) 라우트에 닿기 전에 본문이 다 받아졌다");
    assert.equal(r.status, 200, `작은 본문: status=${r.status} body=${JSON.stringify(r.json)}`);
    assert.equal(nas.files.get("/docs/small.json")?.toString(), "{}");
    assert.equal(r0.status, 200, `빈 파일: status=${r0.status} body=${JSON.stringify(r0.json)}`);
    assert.equal(r0.json?.size, 0);
    assert.equal(nas.files.get("/docs/empty.bin")?.length, 0, "빈 파일이 생긴다");
  } finally { await h.close(); }
});

await t("U5 앞에 JSON 파서가 있어도 그 파서가 읽지 않은 본문(octet-stream)은 그대로 올라간다", async () => {
  const nas = fakeNas();
  const app = express();
  app.use(express.json({ limit: "1mb" }));   // 읽지 않고 넘겨도 req.body 를 {} 로 채운다 — req.body 로는 «읽힘» 을 가를 수 없다
  registerNasUploadRoute(app, verifier, { open: nas.open });
  const h = await listen(app);
  try {
    const r = await put(h.port, { name: "raw.bin", body: JSON_BODY, type: "application/octet-stream", chunked: true });
    assert.equal(r.status, 200, `status=${r.status} body=${JSON.stringify(r.json)}`);
    assert.equal(nas.files.get("/docs/raw.bin")?.toString(), JSON_BODY);
  } finally { await h.close(); }
});

await t("U6 자격이 없으면 앞 파서가 본문을 읽었어도 인증 401 · 권한 403 이 먼저다", async () => {
  const nas = fakeNas();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerNasUploadRoute(app, verifier, { open: nas.open });
  const h = await listen(app);
  try {
    const r1 = await put(h.port, { name: "a.json", body: JSON_BODY, chunked: true, token: null });
    assert.equal(r1.status, 401, `인증 없음: status=${r1.status} body=${JSON.stringify(r1.json)}`);
    const r2 = await put(h.port, { name: "a.json", body: JSON_BODY, chunked: true, token: "noctx" });
    assert.equal(r2.status, 403, `context 권한 없음: status=${r2.status} body=${JSON.stringify(r2.json)}`);
    assert.equal(nas.opened(), 0);
  } finally { await h.close(); }
});

console.log(`\n${pass} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
