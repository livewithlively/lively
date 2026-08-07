// 프리뷰 응답 처리 가드 — 실물 HTTP(#1572).
//
// 파비콘 치환은 응답 파이프라인 한가운데에 끼어든다. 순수 함수 테스트(preview-favicon.test.ts)가 "무엇으로
// 바꾸나"를 보는 반면, 여기서 보는 건 **바꾸면서 응답을 망가뜨리지 않는가**다 — 그 실패는 아이콘이 아니라
// 화면 전체로 나타난다(길이 불일치로 잘린 HTML · JS 변조로 빈 화면 · 압축 바디를 문자열로 다뤄 깨진 응답).
// 특히 한글: 바이트가 아니라 글자 수로 content-length 를 쓰면 **한국어 화면만** 잘린다.
//
// 실물 서버 두 개(업스트림 스텁 + 프록시)를 listen(0) 으로 띄운다 — 고정 포트 금지(러너가 병렬이다).
import express from "express";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveStatic, proxyTo, HTML_REWRITE_CAP } from "./routes.js";

const fails: string[] = [];
const ok = (cond: boolean, msg: string): void => { if (!cond) fails.push(msg); };
const eq = (a: unknown, b: unknown, msg: string): void => { if (a !== b) fails.push(`${msg} (실제 ${JSON.stringify(a)} ≠ 기대 ${JSON.stringify(b)})`); };

const PREVIEW_MARK = "1E2A26"; // 미리보기 아이콘의 지문 = 어두운 배경색(민트는 라이브와 겹쳐 판별에 못 쓴다)
const HTML_KO = `<!DOCTYPE html><html><head><link rel="icon" href="/live.svg"><title>맥락 스토어</title></head><body>미리보기 한글 본문</body></html>`;

type Res = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
function fetchRaw(port: number, p: string, method = "GET"): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method }, (r) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => resolve({ status: r.statusCode || 0, headers: r.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}
const listen = (app: express.Express | http.Server): Promise<http.Server> =>
  new Promise((resolve) => { const s = (typeof app === "function" ? http.createServer(app) : app).listen(0, "127.0.0.1", () => resolve(s)); });
const portOf = (s: http.Server): number => (s.address() as { port: number }).port;

const BIG_HTML = `<head><link rel="icon" href="/live.svg"></head><body>` + "가".repeat(HTML_REWRITE_CAP) + "</body>"; // CAP 초과(한 글자 3바이트)

// ── 업스트림 스텁 — 프리뷰 자식 게이트웨이 흉내. 경로마다 다른 종류의 응답을 준다. ──
const upstream = http.createServer((req, res) => {
  const p = (req.url || "").split("?")[0];
  if (p === "/html") {
    const b = Buffer.from(HTML_KO, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": String(b.length) });
    res.end(req.method === "HEAD" ? undefined : b); return;
  }
  if (p === "/chunked-html") { // 한 글자씩 쪼개 보낸다 — 버퍼 결합이 깨지면 여기서 드러난다
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    for (const ch of Buffer.from(HTML_KO, "utf8")) res.write(Buffer.from([ch]));
    res.end(); return;
  }
  if (p === "/big-html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(Buffer.from(BIG_HTML, "utf8")); return;
  }
  if (p === "/app.js") {
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
    res.end(Buffer.from(`export const icon = "rel=icon";`, "utf8")); return; // 본문에 icon 이 있어도 손대면 안 된다
  }
  if (p === "/gz-html") {
    const gz = gzipSync(Buffer.from(HTML_KO, "utf8"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip", "content-length": String(gz.length) });
    res.end(gz); return;
  }
  if (p === "/redir") { res.writeHead(302, { location: "/ui/" }); res.end(); return; }
  if (p === "/nomod") { res.writeHead(304, { "content-type": "text/html; charset=utf-8" }); res.end(); return; }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("nope");
});

const run = async (): Promise<void> => {
  const up = await listen(upstream);
  const base = `http://127.0.0.1:${portOf(up)}`;

  const proxyApp = express();
  proxyApp.use(express.json());
  proxyApp.all(/.*/, (req, res) => proxyTo(base, req.path.replace(/^\/+/, ""), req, res, "/preview/t"));
  const px = await listen(proxyApp);
  const pp = portOf(px);

  // P1 — HTML 은 아이콘이 갈리고, 길이는 **바이트** 기준이라 한글 본문이 잘리지 않는다.
  {
    const r = await fetchRaw(pp, "/html");
    eq(r.status, 200, "P1: 상태 유지");
    ok(r.body.toString("utf8").includes(PREVIEW_MARK), "P1: 미리보기 아이콘이 들어가야 한다");
    ok(!r.body.toString("utf8").includes("/live.svg"), "P1: 라이브 아이콘이 남으면 안 된다");
    ok(r.body.toString("utf8").includes("미리보기 한글 본문"), "P1: 한글 본문이 온전해야 한다");
    ok(r.body.toString("utf8").endsWith("</html>"), "P1: 문서 끝이 잘리면 안 된다");
    eq(Number(r.headers["content-length"]), r.body.length, "P1: content-length 가 실제 바이트 수와 같아야 한다(글자 수로 세면 한글 화면만 잘린다)");
  }

  // P10 — 응답이 잘게 쪼개져 와도 온전히 합쳐 치환한다.
  {
    const r = await fetchRaw(pp, "/chunked-html");
    ok(r.body.toString("utf8").includes(PREVIEW_MARK), "P10: 청크 분할 응답도 치환돼야 한다");
    ok(r.body.toString("utf8").includes("미리보기 한글 본문") && r.body.toString("utf8").endsWith("</html>"), "P10: 본문 손실 없어야 한다");
  }

  // P2 — JS 는 한 바이트도 건드리지 않는다(본문에 icon 이 있어도).
  {
    const r = await fetchRaw(pp, "/app.js");
    eq(r.body.toString("utf8"), `export const icon = "rel=icon";`, "P2: JS 바디는 원본 그대로여야 한다");
  }

  // P3 — 압축 바디는 통과시킨다(문자열로 다루면 응답이 깨진다).
  {
    const r = await fetchRaw(pp, "/gz-html");
    eq(r.headers["content-encoding"], "gzip", "P3: 인코딩 헤더 유지");
    eq(r.body.toString("base64"), gzipSync(Buffer.from(HTML_KO, "utf8")).toString("base64"), "P3: 압축 바이트가 그대로여야 한다");
  }

  // P4 — HEAD 는 바디가 없다. 치환을 시도하면 **헤더만 조용히 거짓말**을 하게 된다(Node 가 바디는 알아서
  //  억제하므로 바디 길이만 보면 통과한다 — 그래서 content-length 를 직접 본다).
  {
    const r = await fetchRaw(pp, "/html", "HEAD");
    eq(r.status, 200, "P4: HEAD 상태 유지");
    eq(r.body.length, 0, "P4: HEAD 응답에 바디가 붙으면 안 된다");
    eq(Number(r.headers["content-length"]), Buffer.byteLength(HTML_KO, "utf8"),
      "P4: HEAD 의 content-length 는 업스트림 값 그대로여야 한다(바디 없는 응답을 치환 경로에 넣으면 여기가 어긋난다)");
  }

  // P5 — 304 도 바디 없는 응답이다. 없던 content-length 가 생기면 안 된다.
  {
    const r = await fetchRaw(pp, "/nomod");
    eq(r.status, 304, "P5: 304 유지");
    eq(r.body.length, 0, "P5: 304 에 바디가 붙으면 안 된다");
    eq(r.headers["content-length"], undefined, "P5: 304 에 content-length 가 생기면 안 된다");
  }

  // P6 — CAP 초과 HTML 은 아이콘을 포기하더라도 **바디가 온전**해야 한다(버퍼링 복귀 경로).
  {
    const r = await fetchRaw(pp, "/big-html");
    eq(r.body.length, Buffer.byteLength(BIG_HTML, "utf8"), "P6: 큰 HTML 이 잘리거나 중복되면 안 된다");
    ok(r.body.toString("utf8").endsWith("</body>"), "P6: 끝까지 와야 한다");
  }

  // P7 — Location 재작성(#1169) 무회귀. 치환 분기를 넣으면서 이 경로를 건드리지 않았는지.
  {
    const r = await fetchRaw(pp, "/redir");
    eq(r.status, 302, "P7: 302 유지");
    eq(r.headers.location, "/preview/t/ui/", "P7: Location 이 프리뷰 서브패스로 되돌아와야 한다");
  }

  // ── 정적 서빙(stage·shared-proxy 모드) ──
  const dir = mkdtempSync(path.join(tmpdir(), "prevfav-"));
  writeFileSync(path.join(dir, "index.html"), HTML_KO, "utf8");
  writeFileSync(path.join(dir, "core.js"), `const icon = "rel=icon";`, "utf8");
  const staticApp = express();
  staticApp.get(/.*/, (req, res) => serveStatic(dir, req.path.replace(/^\/+/, ""), res));
  const ss = await listen(staticApp);
  const sp = portOf(ss);

  // P8 — 정적 HTML 도 아이콘이 갈린다(프리뷰 기본 모드).
  {
    const r = await fetchRaw(sp, "/index.html");
    ok(r.body.toString("utf8").includes(PREVIEW_MARK), "P8: 정적 HTML 도 미리보기 아이콘이어야 한다");
    ok(!r.body.toString("utf8").includes("/live.svg"), "P8: 라이브 아이콘 제거");
    ok(r.body.toString("utf8").includes("미리보기 한글 본문"), "P8: 한글 본문 온전");
    eq(Number(r.headers["content-length"]), r.body.length, "P8: 길이가 바이트 기준이어야 한다");
  }
  // P8b — `/` (rel 빈 문자열) 도 index.html 로 풀리고 치환된다.
  {
    const r = await fetchRaw(sp, "/");
    ok(r.body.toString("utf8").includes(PREVIEW_MARK), "P8b: 루트 진입도 치환돼야 한다");
  }
  // P9 — 정적 JS 는 그대로.
  {
    const r = await fetchRaw(sp, "/core.js");
    eq(r.body.toString("utf8"), `const icon = "rel=icon";`, "P9: 정적 JS 는 원본 그대로여야 한다");
  }

  await new Promise<void>((r) => up.close(() => r()));
  await new Promise<void>((r) => px.close(() => r()));
  await new Promise<void>((r) => ss.close(() => r()));
};

await run();

if (fails.length > 0) {
  console.error(`preview-favicon-http: ${fails.length}건 실패`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log("preview-favicon-http: ok");
