// 프리뷰 프록시가 **본문을 흘려보내는가** (#1819).
//  실측 사고: 프리뷰를 거친 PUT /file 이 전부 0바이트로 저장됐다 — 프록시가 앞단 express.json 이 파싱한 JSON 만
//  다시 실어 보내고, 파서가 손대지 않은 원시 본문(application/octet-stream 등)은 통째로 버렸기 때문이다.
//  서버는 200 을 주므로 화면에는 성공으로 보인다(빈 파일이 생긴다) — 조용한 실패라 테스트로 못 박는다.
import { strict as assert } from "node:assert";
import test from "node:test";
import http from "node:http";
import express from "express";
import { proxyTo } from "./routes.js";

/** 받은 본문을 그대로 돌려주는 상류 서버. */
function upstream(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ len: body.length, sha: body.toString("base64").slice(0, 24), ct: req.headers["content-type"] ?? null }));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ port: (s.address() as { port: number }).port, close: () => s.close() }));
  });
}

/** 프리뷰와 같은 배치: 전역 express.json 뒤에 프록시가 앉는다. */
function front(upPort: number): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use((req, res) => proxyTo(`http://127.0.0.1:${upPort}`, req.path.replace(/^\//, ""), req, res, "/preview/x"));
    const s = app.listen(0, "127.0.0.1", () => resolve({ port: (s.address() as { port: number }).port, close: () => s.close() }));
  });
}

function send(port: number, method: string, path: string, body: Buffer | null, ct?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers: { ...(ct ? { "content-type": ct } : {}), ...(body ? { "content-length": String(body.length) } : {}) } }, (r) => {
      const cs: Buffer[] = [];
      r.on("data", (c: Buffer) => cs.push(c));
      r.on("end", () => { try { resolve(JSON.parse(Buffer.concat(cs).toString("utf8"))); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

test("★★ 원시 본문(파일 업로드)이 상류까지 그대로 간다 — 0바이트로 삼키지 않는다", async () => {
  const u = await upstream(); const f = await front(u.port);
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const out = await send(f.port, "PUT", "/api/file", bytes, "application/octet-stream");
    assert.equal(out.len, bytes.length, "본문 길이가 보존돼야 한다(0 이면 빈 파일이 저장된다)");
    assert.equal(out.sha, bytes.toString("base64").slice(0, 24), "바이트가 그대로여야 한다");
  } finally { f.close(); u.close(); }
});

test("★ 앞단이 파싱한 JSON 은 종전대로 다시 직렬화돼 간다", async () => {
  const u = await upstream(); const f = await front(u.port);
  try {
    const body = Buffer.from(JSON.stringify({ a: 1, b: "가나다" }), "utf8");
    const out = await send(f.port, "POST", "/api/thing", body, "application/json");
    assert.equal(out.len, body.length, "JSON 본문도 온전해야 한다");
    assert.equal(out.ct, "application/json");
  } finally { f.close(); u.close(); }
});

test("★ 본문 없는 GET 은 길이를 남기지 않는다 — 남기면 상대가 오지 않을 바이트를 기다린다", async () => {
  const u = await upstream(); const f = await front(u.port);
  try {
    const out = await send(f.port, "GET", "/api/thing", null);
    assert.equal(out.len, 0);
  } finally { f.close(); u.close(); }
});
