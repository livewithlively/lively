// #797 — 업로드를 중간에 끊어도(취소 버튼·새로고침·네트워크 끊김) **목적지 파일이 멀쩡한가**를 실제 HTTP 로 검증.
//  고치기 전(`createWriteStream(목적지)` + `req.pipe`)에는 두 가지가 실제로 재현됐다:
//   ① 덮어쓰기 업로드를 끊으면 원본이 잘려 사라짐(43바이트 원본 → 262KB 미완성 데이터) ② 새 파일도 부분 파일로 남음.
//  취소 기능(진행 패널의 '취소' 버튼)이 생기면 사용자가 이 경로를 일상적으로 밟으므로, 이 테스트가 그 회귀를 막는다.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { receiveUpload, uploadError } from "./upload-file.js";

const MAX = 1024 * 1024; // 이 테스트의 업로드 상한(1MB)
const STALL = 300;       // 이 테스트의 정지 상한(운영 기본은 UPLOAD_STALL_MS=120s — 테스트는 축약)
const nameOf = (url: string): string => new URL(url, "http://x").searchParams.get("name") ?? "f";

async function main(): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "co-upload-"));

  // 라우트(project-routes.ts / terminal-files.ts)와 같은 모양: receiveUpload → 실패는 uploadError 로 매핑(null = 취소).
  const server = http.createServer((req, res) => {
    receiveUpload(req, path.join(dir, nameOf(req.url ?? "/")), MAX, null, STALL)
      .then(() => { res.writeHead(200); res.end('{"ok":true}'); })
      .catch((e: unknown) => {
        const he = uploadError(e);
        if (!he) return; // 취소 — 응답할 상대가 없다
        res.writeHead(he.status); res.end(JSON.stringify({ error: he.message }));
      });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;

  // 정지 상한을 끈(0) 같은 서버 — ⑧(도입 변수의 부재) 전용.
  const offServer = http.createServer((req, res) => {
    receiveUpload(req, path.join(dir, nameOf(req.url ?? "/")), MAX, null, 0)
      .then(() => { res.writeHead(200); res.end('{"ok":true}'); })
      .catch((e: unknown) => { const he = uploadError(e); if (!he) return; res.writeHead(he.status); res.end(JSON.stringify({ error: he.message })); });
  });
  await new Promise<void>((r) => offServer.listen(0, "127.0.0.1", () => r()));
  const offPort = (offServer.address() as AddressInfo).port;

  const put = (name: string, body: Buffer): Promise<number> => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "PUT", path: `/f?name=${name}` }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(body);
  });

  // 업로드를 시작했다가 중간에 끊는다 — 브라우저의 xhr.abort()('취소' 버튼)와 같은 효과(소켓 파괴).
  //  content-length 로 예고한 양보다 적게 보내고 끊으므로 서버는 'aborted' 로 본다.
  const abortedPut = async (name: string, sent: number): Promise<void> => {
    const req = http.request({ host: "127.0.0.1", port, method: "PUT", path: `/f?name=${name}`,
      headers: { "content-length": String(8 * 1024 * 1024) } });
    req.on("error", () => { /* 우리가 끊은 것 */ });
    req.write(Buffer.alloc(sent, 0x41));
    await new Promise((r) => setTimeout(r, 80));
    req.destroy();                                  // ← 취소
    await new Promise((r) => setTimeout(r, 250));   // 서버가 정리(임시파일 삭제)할 시간
  };

  // 헤더(+선택적 일부 바이트)만 보내고 **소켓은 살려 둔 채** 멈춘다 — 정지(stall) 재현. 취소(abortedPut)와의 차이는
  //  '소켓을 끊지 않는다'는 것뿐이고, 그 차이가 곧 "응답할 상대가 있다"는 차이다.
  //  응답이 오면 그 상태코드, 관측창(OBS) 안에 아무 응답도 안 오면 0(= 정지 판정을 하지 않았다).
  const OBS = 4000;
  const stalledPut = (name: string, sent: number, p = port): Promise<number> => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: p, method: "PUT", path: `/f?name=${name}`,
      headers: { "content-length": String(8 * 1024 * 1024) } }, (res) => {
      res.resume();
      res.on("end", () => { clearTimeout(t); req.destroy(); resolve(res.statusCode ?? 0); });
    });
    req.on("error", reject);   // 이미 settle 된 뒤의 destroy 로 오는 건 no-op
    const t = setTimeout(() => { req.destroy(); resolve(0); }, OBS);
    if (sent > 0) req.write(Buffer.alloc(sent, 0x41)); else req.flushHeaders();
  });

  // 청크를 gapMs 간격으로 **계속** 보낸다(총 소요 > 상한) — 느린 회선. 정지 판정이 idle 기준인지 가른다.
  const slowPut = (name: string, chunks: number, gapMs: number): Promise<{ status: number; elapsed: number }> =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const req = http.request({ host: "127.0.0.1", port, method: "PUT", path: `/f?name=${name}`,
        headers: { "content-length": String(chunks) } }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, elapsed: Date.now() - t0 }));
      });
      req.on("error", reject);
      let i = 0;
      const tick = (): void => {
        if (i >= chunks) { req.end(); return; }
        req.write(String.fromCharCode(0x61 + i)); i++;
        setTimeout(tick, gapMs);
      };
      setTimeout(tick, gapMs);
    });

  const ls = async (): Promise<string[]> => (await fsp.readdir(dir)).sort();
  const read = (name: string): Promise<string> => fsp.readFile(path.join(dir, name), "utf8");

  // ① 정상 업로드 — 내용이 그대로 쓰이고, 임시파일 잔여물이 없다.
  assert.equal(await put("ok.txt", Buffer.from("hello")), 200);
  assert.equal(await read("ok.txt"), "hello");
  assert.deepEqual(await ls(), ["ok.txt"], "성공 업로드가 임시파일을 남겼다");

  // ② 덮어쓰기 업로드를 중간에 취소 — **원본이 살아있어야 한다**(고치기 전엔 잘려나갔다).
  const KEEP = "ORIGINAL — 취소해도 살아있어야 한다";
  await fsp.writeFile(path.join(dir, "keep.txt"), KEEP);
  await abortedPut("keep.txt", 256 * 1024);
  assert.equal(await read("keep.txt"), KEEP, "업로드 취소가 기존 파일을 파괴했다");
  assert.deepEqual(await ls(), ["keep.txt", "ok.txt"], "취소된 업로드가 임시파일을 남겼다");

  // ③ 새 파일 업로드를 중간에 취소 — 목적지에 부분 파일이 생기지 않는다(사용자에겐 '안 올라간 파일').
  await abortedPut("fresh.bin", 256 * 1024);
  assert.deepEqual(await ls(), ["keep.txt", "ok.txt"], "취소된 업로드가 부분 파일을 남겼다");

  // ④ 상한 초과 — 413 이 전달되고(소켓을 죽이지 않는다), 덮어쓰려던 원본도 무손상.
  await fsp.writeFile(path.join(dir, "big.txt"), KEEP);
  assert.equal(await put("big.txt", Buffer.alloc(MAX + 1024, 0x42)), 413);
  assert.equal(await read("big.txt"), KEEP, "상한 초과 업로드가 기존 파일을 파괴했다");
  assert.deepEqual(await ls(), ["big.txt", "keep.txt", "ok.txt"], "상한 초과 업로드가 임시파일을 남겼다");

  const SETTLED = ["big.txt", "keep.txt", "ok.txt"];   // ①~④ 이후의 정상 상태 — ⑤~⑦ 은 여기서 변하지 않아야 한다

  // ⑤ 0바이트 정지(#1272) — 헤더는 왔는데 **본문이 한 바이트도 안 오고 소켓도 안 끊긴다**(사내 보안장비가 중계를 멈춘 상황).
  //  고치기 전엔 data·end·error 가 아무것도 오지 않아 요청이 영구히 열린 채였다(실박스에서 33분 생존 관측).
  const t5 = Date.now();
  assert.equal(await stalledPut("stalled.bin", 0), 408, "0바이트 정지가 408 을 응답하지 않았다");
  assert.ok(Date.now() - t5 < 5000, "정지 판정이 상한 안에 끝나지 않았다(절대시간 대기 의심)");
  assert.deepEqual(await ls(), SETTLED, "정지한 업로드가 임시파일/부분 파일을 남겼다");

  // ⑥ 진행 후 정지 — 일부 바이트가 온 뒤 멈춘다(덮어쓰기 대상이 있어도 원본은 무손상).
  const t6 = Date.now();
  assert.equal(await stalledPut("keep.txt", 64 * 1024), 408, "진행 후 정지가 408 을 응답하지 않았다");
  assert.ok(Date.now() - t6 < 5000, "진행 후 정지 판정이 상한 안에 끝나지 않았다");
  assert.equal(await read("keep.txt"), KEEP, "정지한 덮어쓰기 업로드가 기존 파일을 파괴했다");
  assert.deepEqual(await ls(), SETTLED, "정지한 업로드가 임시파일을 남겼다");

  // ⑦ 느린 회선 — 청크가 상한보다 짧은 간격으로 **계속** 온다(총 소요는 상한보다 길다). 정지로 오판하면 안 된다.
  //  이 행이 없으면 상한을 '요청 시작부터 절대시간'으로 잘못 구현해도 ⑤·⑥ 만으로는 통과한다.
  const slow = await slowPut("slow.txt", 5, Math.floor(STALL / 2));   // 5청크 × STALL/2 간격 = 총 2.5×STALL
  assert.equal(slow.status, 200, "느린 업로드를 정지로 오판했다");
  assert.ok(slow.elapsed > STALL * 2, "느린 업로드 시나리오가 상한보다 짧게 끝났다(시나리오 무효)");
  assert.equal(await read("slow.txt"), "abcde", "느린 업로드 내용이 어긋났다");

  // ⑧ 정지 상한 부재(0 = 비활성) — 이번에 도입한 변수의 부재 케이스. 판정하지 않으므로 관측창 안에 응답이 없다.
  assert.equal(await stalledPut("nostall.bin", 0, offPort), 0, "상한 0(비활성)인데 정지 판정을 했다");
  await new Promise((r) => setTimeout(r, 250));   // 끊긴 요청의 임시파일 정리 시간
  offServer.close();

  server.close();
  await fsp.rm(dir, { recursive: true, force: true });
  console.log("upload-file.test: ok");
}

await main();
