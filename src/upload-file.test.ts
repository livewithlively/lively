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
const nameOf = (url: string): string => new URL(url, "http://x").searchParams.get("name") ?? "f";

async function main(): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "co-upload-"));

  // 라우트(project-routes.ts / terminal-files.ts)와 같은 모양: receiveUpload → 실패는 uploadError 로 매핑(null = 취소).
  const server = http.createServer((req, res) => {
    receiveUpload(req, path.join(dir, nameOf(req.url ?? "/")), MAX, null)
      .then(() => { res.writeHead(200); res.end('{"ok":true}'); })
      .catch((e: unknown) => {
        const he = uploadError(e);
        if (!he) return; // 취소 — 응답할 상대가 없다
        res.writeHead(he.status); res.end(JSON.stringify({ error: he.message }));
      });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;

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

  server.close();
  await fsp.rm(dir, { recursive: true, force: true });
  console.log("upload-file.test: ok");
}

await main();
