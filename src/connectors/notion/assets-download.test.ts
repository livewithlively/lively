// 노션 첨부 다운로드(#4059 후속 사고) — 파일 크기와 무관하게 메모리를 조금만 쓰고, 멈춘 연결은 유휴 한도로 끊는다.
//  실행: npm run build && node dist/connectors/notion/assets-download.test.js
//
//  왜: 2026-09-17 20:06 KST, 매니지드 soltimal 전체 점검이 1GB 넘는 영상 첨부를 본문째 메모리에 올리다가
//   게이트웨이와 같은 cgroup(2GiB)에서 OOM 이 났고, systemd 가 중앙 게이트웨이를 통째로 재시작했다.
//  서버는 이 프로세스 안의 로컬 HTTP 서버다 — 실제 fetch·스트림·파일 쓰기를 그대로 탄다.
//  시나리오마다 결과를 모아 끝에 한꺼번에 알린다(변경 전 코드에서 어느 행이 빨간지 한눈에 보이게).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import * as assets from "./assets.js";
import type { Traversal } from "./state.js";

const MB = 1024 * 1024;
const BIG = 256 * MB;
const ZEROS = Buffer.alloc(MB);
const hits = new Map<string, number>();
const hit = (k: string) => { const n = (hits.get(k) ?? 0) + 1; hits.set(k, n); return n; };

const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  const route = u.pathname.split("/")[1];
  const n = hit(`${route}${u.search}`);
  const drip = (chunks: string[], everyMs: number) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    let i = 0;
    const iv = setInterval(() => {
      if (i < chunks.length) res.write(chunks[i++]);
      else { clearInterval(iv); res.end(); }
    }, everyMs);
    res.on("close", () => clearInterval(iv));
  };
  const halfThenDrop = () => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "10" });
    res.write("HALF!");
    setTimeout(() => res.socket?.destroy(), 30);
  };
  switch (route) {
    case "chunks": return drip(["aaa", "bbb", "ccc"], 10);
    case "big": {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(BIG) });
      let left = BIG / MB;
      const pump = () => {
        while (left > 0) {
          left--;
          if (!res.write(ZEROS)) { res.once("drain", pump); return; }
        }
        res.end();
      };
      return pump();
    }
    case "empty": res.writeHead(200, { "content-length": "0" }); return res.end();
    case "flaky": if (n === 1) return halfThenDrop(); return drip(["WHOLE", "BODY!"], 5);
    case "drop": return halfThenDrop();
    case "file": // 서명 만료 흉내 — sig=old 는 403, sig=new 는 200
      if (u.searchParams.get("sig") === "new") return drip(["FRESH"], 5);
      res.writeHead(403); return res.end("expired");
    case "stall": // 헤더와 첫 조각만 보내고 영영 멈춘다
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write("x");
      return;
    case "silent": return; // 연결만 받고 헤더도 안 보낸다
    case "slow": return drip(Array.from({ length: 12 }, () => "s"), 150);
    default: res.writeHead(404); return res.end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// 노션 API(재발급)는 스텁 — 로컬 서버 밖으로는 나가지 않는다.
const realFetch = globalThis.fetch;
const notionAsked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.notion.com/v1/")) {
    notionAsked.push(url.slice("https://api.notion.com/v1".length));
    return new Response(JSON.stringify({ object: "block", id: "b1", type: "file", file: { type: "file", file: { url: `${base}/file/doc.pdf?sig=new` } } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  if (!url.startsWith(base)) throw new Error(`시험 밖으로 나갔다: ${url}`);
  return realFetch(input, init);
}) as typeof fetch;

const t = { cfg: { token: "x", version: "2025-09-03" }, stats: { assetBytes: 0 } } as unknown as Traversal;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-assets-test-"));
const job = (name: string, url: string, extra: Partial<assets.AssetJob> = {}): assets.AssetJob => ({ url, file: name, ...extra });
const parts = () => fs.readdirSync(dir).filter((f) => f.endsWith(".part"));
const within = <T>(ms: number, p: Promise<T>): Promise<T> => {
  let tm: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, rej) => { tm = setTimeout(() => rej(new Error(`${ms}ms 안에 끝나지 않았다`)), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(tm)); // 남은 타이머가 프로세스를 붙잡지 않게
};
const bytes = () => (t.stats as { assetBytes?: number }).assetBytes ?? NaN;

const results: Array<{ name: string; err?: unknown }> = [];
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name }); console.log(`ok  ${name}`); }
  catch (err) { results.push({ name, err }); console.log(`FAIL ${name}\n     ${(err as Error)?.message ?? err}`); }
}

await scenario("E1 여러 조각 본문 → 최종 파일 = 본문 · 조각 없음 · 받은 바이트 집계", async () => {
  const before = bytes();
  await within(10_000, assets.downloadAsset(t, job("e1.bin", `${base}/chunks`), dir, { idleMs: 2_000 }));
  assert.equal(fs.readFileSync(path.join(dir, "e1.bin"), "utf8"), "aaabbbccc");
  assert.deepEqual(parts(), []);
  assert.equal(hits.get("chunks"), 1, "서버가 한 번만 불려야 한다");
  assert.equal(bytes() - before, 9, "받은 바이트가 진행 신호에 잡혀야 한다");
});

await scenario("E2 256MB 본문 → 받는 동안 RSS 증가 < 100MB · 파일 크기 온전", async () => {
  const base0 = process.memoryUsage.rss();
  let peak = base0;
  const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 5);
  try {
    await within(120_000, assets.downloadAsset(t, job("e2.bin", `${base}/big`), dir, { idleMs: 10_000 }));
  } finally { clearInterval(iv); }
  assert.equal(fs.statSync(path.join(dir, "e2.bin")).size, BIG);
  const grew = (peak - base0) / MB;
  fs.rmSync(path.join(dir, "e2.bin"));
  assert.ok(grew < 100, `본문을 메모리에 올렸다 — RSS 가 ${grew.toFixed(0)}MB 늘었다`);
});

await scenario("E3 0바이트 → 실패 · 최종·조각 없음", async () => {
  await assert.rejects(within(15_000, assets.downloadAsset(t, job("e3.bin", `${base}/empty`), dir, { idleMs: 2_000 })));
  assert.equal(fs.existsSync(path.join(dir, "e3.bin")), false);
  assert.deepEqual(parts(), []);
});

await scenario("E4 첫 시도 중간 끊김 → 재시도로 온전한 파일", async () => {
  await within(15_000, assets.downloadAsset(t, job("e4.bin", `${base}/flaky`), dir, { idleMs: 2_000 }));
  assert.equal(fs.readFileSync(path.join(dir, "e4.bin"), "utf8"), "WHOLEBODY!");
  assert.equal(hits.get("flaky"), 2);
  assert.deepEqual(parts(), []);
});

await scenario("E5 매번 중간 끊김 → 실패 · 기존 파일 그대로 · 조각 없음", async () => {
  fs.writeFileSync(path.join(dir, "e5.bin"), "OLD");
  await assert.rejects(within(15_000, assets.downloadAsset(t, job("e5.bin", `${base}/drop`), dir, { idleMs: 2_000 })));
  assert.equal(fs.readFileSync(path.join(dir, "e5.bin"), "utf8"), "OLD");
  assert.equal(hits.get("drop"), 3, "세 번 시도해야 한다");
  assert.deepEqual(parts(), []);
});

await scenario("E6 403 → 재발급 URL 로 성공", async () => {
  await within(15_000, assets.downloadAsset(t, job("e6.pdf", `${base}/file/doc.pdf?sig=old`, { blockId: "b1" }), dir, { idleMs: 2_000 }));
  assert.equal(fs.readFileSync(path.join(dir, "e6.pdf"), "utf8"), "FRESH");
  assert.equal(hits.get("file?sig=old"), 1);
  assert.equal(hits.get("file?sig=new"), 1);
  assert.deepEqual(notionAsked, ["/blocks/b1"], "재발급은 소유 블록 조회 한 번이어야 한다");
});

await scenario("E7 헤더 뒤 멈춤 → 유휴 한도로 끊고 제한 시간 안에 실패", async () => {
  const t0 = Date.now();
  await assert.rejects(within(20_000, assets.downloadAsset(t, job("e7.bin", `${base}/stall`), dir, { idleMs: 300 })),
    (err: Error) => /멈춤/.test(err.message)); // 바깥 시한이 아니라 유휴 한도가 끊었고, 로그에 그 사유가 남는다
  assert.ok(Date.now() - t0 < 10_000, `너무 오래 기다렸다 ${Date.now() - t0}ms`);
  assert.equal(hits.get("stall"), 3);
  assert.equal(fs.existsSync(path.join(dir, "e7.bin")), false);
  assert.deepEqual(parts(), []);
});

await scenario("E7b 헤더도 안 옴 → 유휴 한도로 끊고 제한 시간 안에 실패", async () => {
  const t0 = Date.now();
  await assert.rejects(within(20_000, assets.downloadAsset(t, job("e7b.bin", `${base}/silent`), dir, { idleMs: 300 })),
    (err: Error) => /멈춤/.test(err.message));
  assert.ok(Date.now() - t0 < 10_000, `너무 오래 기다렸다 ${Date.now() - t0}ms`);
  assert.equal(hits.get("silent"), 3);
  assert.deepEqual(parts(), []);
});

await scenario("E8 계속 들어오는 느린 본문(전체 1.8초 > 유휴 0.6초) → 성공", async () => {
  await within(20_000, assets.downloadAsset(t, job("e8.bin", `${base}/slow`), dir, { idleMs: 600 }));
  assert.equal(fs.readFileSync(path.join(dir, "e8.bin"), "utf8"), "s".repeat(12));
  assert.equal(hits.get("slow"), 1, "끊지 말고 한 번에 받아야 한다");
});

server.closeAllConnections();
server.close();
fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => r.err);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
