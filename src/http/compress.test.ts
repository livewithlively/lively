// 웹 화면 응답 압축 (#4989) — 사양 표 C1~C12.
//
//  1Mbps 폰 실측(상민님 2026-10-25): 터미널 스트림은 멀쩡한데 사이드바 · 세션 목록이 한참 걸렸다 — 첫 판의 목록이 압축 없이 수 MB 였다.
//  웹 화면의 두 자리(/api/ui · /ui)만, 통째로 나가는 글자 형식만 압축한다. 조금씩 흐르는 응답(SSE · ndjson)은 압축기가 모아 두면
//   사건이 제때 안 닿으므로 뺀다.
//
//  C1 압축 대상 형식(json · js · css · html · plain · svg — charset · 대문자)   C2 대상 아님(event-stream · x-ndjson · csv · octet-stream · png)
//  C3 경계 · 부재(헤더 없음 · 문자열 아님 · 접두만 같은 형식 · 빈 문자열)          C4 /api/ui 큰 JSON + br → br · 풀면 원문 · ETag 있음
//  C5 gzip 만 받는 쪽 → gzip    C6 Accept-Encoding 없음 → 원문    C7 1KB 미만 → 원문    C8 If-None-Match → 304 · 본문 0 · 인코딩 없음
//  C9 /api/ui 의 SSE → 인코딩 없음 · 첫 사건이 응답 끝을 기다리지 않고 닿는다    C10 /ui 의 큰 JS → 압축    C11 다른 자리(/mcp) → 원문
//  C12 index.ts 배선 — 그 두 자리에 compressionFilter 로, 웹 라우트를 붙이기 전에
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import compression from "compression";
import { compressibleType, compressionFilter } from "./compress.js";

// ── C1 · C2 · C3 — 형식 판정 ────────────────────────────────────────────────
test("C1 통째로 나가는 글자 형식은 압축 대상", () => {
  for (const t of ["application/json", "application/json; charset=utf-8", "Application/JSON", "application/javascript; charset=utf-8",
    "text/javascript", "text/css", "text/css; charset=UTF-8", "text/html; charset=utf-8", "text/plain", "image/svg+xml"]) {
    assert.equal(compressibleType(t), true, `🔴 ${t} 를 압축하지 않는다`);
  }
});

test("C2 조금씩 흐르는 응답 · 그 밖의 형식은 대상 아님", () => {
  for (const t of ["text/event-stream", "text/event-stream; charset=utf-8", "application/x-ndjson; charset=utf-8",
    "text/csv; charset=utf-8", "application/octet-stream", "image/png", "application/gzip"]) {
    assert.equal(compressibleType(t), false, `🔴 ${t} 를 압축한다 — 흐르는 응답이면 사건이 늦게 닿는다`);
  }
});

test("C3 경계 · 부재 — 헤더 없음 · 문자열 아님 · 접두만 같은 형식 · 빈 문자열", () => {
  for (const t of [undefined, null, 42, ["application/json"], "", "application/json-patch+json", "application/jsonx", "text/htmlx"]) {
    assert.equal(compressibleType(t), false, `🔴 ${JSON.stringify(t)} 를 압축 대상으로 본다`);
  }
});

// ── C4 ~ C11 — 실제 요청 ────────────────────────────────────────────────────
//  index.ts 와 같은 배선(C12 가 그 줄이 index.ts 에 그대로 있음을 못 박는다).
const BIG = { rows: Array.from({ length: 400 }, (_, i) => ({ id: `box-${i}`, label: `세션 ${i}`, lastPrompt: "사이드바 둘째 줄 ".repeat(4) })) };
const BIG_JS = "export const x = " + JSON.stringify(BIG) + ";\n";
function makeApp(): express.Express {
  const app = express();
  app.use(["/api/ui", "/ui"], compression({ filter: compressionFilter }));
  app.get("/api/ui/big", (_req, res) => { res.setHeader("Cache-Control", "no-store"); res.json(BIG); });
  app.get("/api/ui/small", (_req, res) => { res.setHeader("Cache-Control", "no-store"); res.json({ ok: true }); });
  app.get("/api/ui/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.flushHeaders?.();
    res.write("data: hello\n\n");
    const t = setTimeout(() => res.end("data: bye\n\n"), 2500);
    req.on("close", () => clearTimeout(t));
  });
  app.get("/ui/app/big.js", (_req, res) => { res.type("application/javascript; charset=utf-8").send(BIG_JS); });
  app.get("/mcp/big", (_req, res) => { res.json(BIG); });
  return app;
}

interface Got { status: number; headers: http.IncomingHttpHeaders; body: Buffer; firstChunkMs: number; firstChunk: Buffer | null }
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Got> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      const parts: Buffer[] = [];
      let firstChunkMs = -1;
      let firstChunk: Buffer | null = null;
      res.on("data", (c: Buffer) => { if (firstChunkMs < 0) { firstChunkMs = Date.now() - t0; firstChunk = c; } parts.push(c); });
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(parts), firstChunkMs, firstChunk }));
    });
    req.on("error", reject);
  });
}
const decode = (g: Got): string => {
  const enc = g.headers["content-encoding"];
  const b = enc === "br" ? zlib.brotliDecompressSync(g.body) : enc === "gzip" ? zlib.gunzipSync(g.body) : g.body;
  return b.toString("utf8");
};

let server: http.Server;
let port = 0;
test.before(async () => {
  server = makeApp().listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  port = (server.address() as AddressInfo).port;
});
test.after(() => new Promise<void>((r) => server.close(() => r())));

test("C4 /api/ui 큰 JSON + br → br · 풀면 원문 · ETag 그대로", async () => {
  const g = await get(port, "/api/ui/big", { "Accept-Encoding": "br, gzip" });
  assert.equal(g.status, 200);
  assert.equal(g.headers["content-encoding"], "br", "🔴 웹 화면 목록이 압축 없이 나간다");
  assert.deepEqual(JSON.parse(decode(g)), BIG);
  assert.ok(g.body.length < JSON.stringify(BIG).length / 3, `압축이 거의 안 됐다(${g.body.length}B)`);
  assert.ok(String(g.headers.etag || "").length > 0, "🔴 ETag 가 사라졌다 — 조건부 다시 받기(304)가 죽는다");
});

test("C5 gzip 만 받는 쪽 → gzip", async () => {
  const g = await get(port, "/api/ui/big", { "Accept-Encoding": "gzip" });
  assert.equal(g.headers["content-encoding"], "gzip");
  assert.deepEqual(JSON.parse(decode(g)), BIG);
});

test("C6 Accept-Encoding 없음 → 원문", async () => {
  const g = await get(port, "/api/ui/big");
  assert.equal(g.headers["content-encoding"], undefined, "🔴 압축을 못 푸는 쪽(스크립트 · CLI)에 압축본을 보낸다");
  assert.deepEqual(JSON.parse(g.body.toString("utf8")), BIG);
});

test("C7 1KB 미만 → 원문", async () => {
  const g = await get(port, "/api/ui/small", { "Accept-Encoding": "br, gzip" });
  assert.equal(g.headers["content-encoding"], undefined);
  assert.deepEqual(JSON.parse(g.body.toString("utf8")), { ok: true });
});

test("C8 If-None-Match 일치 → 304 · 본문 0 · 인코딩 없음", async () => {
  const first = await get(port, "/api/ui/big", { "Accept-Encoding": "br, gzip" });
  const etag = String(first.headers.etag || "");
  assert.ok(etag, "기준 ETag 를 못 받았다");
  const g = await get(port, "/api/ui/big", { "Accept-Encoding": "br, gzip", "If-None-Match": etag });
  assert.equal(g.status, 304, "🔴 같은 답인데 본문을 다시 보낸다");
  assert.equal(g.body.length, 0);
  assert.equal(g.headers["content-encoding"], undefined);
});

test("C9 /api/ui 의 SSE → 인코딩 없음 · 첫 사건이 응답 끝을 기다리지 않는다", async () => {
  const g = await get(port, "/api/ui/stream", { "Accept-Encoding": "br, gzip" });
  assert.equal(g.headers["content-encoding"], undefined, "🔴 SSE 를 압축한다 — 압축기가 사건을 모아 둔다");
  assert.ok(g.firstChunk && g.firstChunk.toString("utf8").includes("data: hello"), "첫 덩어리에 첫 사건이 없다");
  assert.ok(g.firstChunkMs >= 0 && g.firstChunkMs < 1500, `🔴 첫 사건이 ${g.firstChunkMs}ms 뒤에 닿았다(응답 끝 2.5초를 기다렸다)`);
});

test("C10 /ui 의 큰 JS → 압축", async () => {
  const g = await get(port, "/ui/app/big.js", { "Accept-Encoding": "br, gzip" });
  assert.equal(g.headers["content-encoding"], "br", "🔴 화면 코드가 압축 없이 나간다");
  assert.equal(decode(g), BIG_JS);
});

test("C11 다른 자리(/mcp)의 큰 JSON → 원문", async () => {
  const g = await get(port, "/mcp/big", { "Accept-Encoding": "br, gzip" });
  assert.equal(g.headers["content-encoding"], undefined, "🔴 웹 화면 밖의 표면까지 압축한다");
});

// ── C12 배선 ─────────────────────────────────────────────────────────────────
test("C12 index.ts — 그 두 자리에 compressionFilter 로, 웹 라우트를 붙이기 전에", () => {
  const src = readFileSync("src/index.ts", "utf8");
  const mount = src.indexOf('app.use(["/api/ui", "/ui"], compression({ filter: compressionFilter }));');
  assert.ok(mount > 0, "🔴 index.ts 에 웹 화면 압축 배선이 없다");
  for (const later of ["registerWebUi(app, verifier);", "registerProjectV6Routes(app, verifier,", "registerSessionLogRoutes(app, verifier);"]) {
    const at = src.indexOf(later);
    assert.ok(at > mount, `🔴 ${later} 가 압축 배선보다 먼저다 — Express 는 붙인 순서대로 돌아 그 라우트는 압축을 안 탄다`);
  }
});
