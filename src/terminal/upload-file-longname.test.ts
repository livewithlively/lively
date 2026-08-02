// #1278 — **긴 파일명** 업로드. 임시파일명은 `.<원본명>.upload-<hex12>` 라 원본보다 21바이트 길고,
//  종전엔 그 길이를 파일명 상한(NAME_MAX 255**바이트**)에 대해 검사하지 않았다 → 원본이 234바이트를 넘으면
//  **원본은 저장 가능한데 임시파일명이 안 들어가** ENAMETOOLONG → 정체불명 500.
//  맥은 한글을 NFD(자모 분해)로 보내 음절당 9바이트라, 화면상 40자 남짓한 md 파일들이 여기 걸렸다
//  (실박스: md 374개 폴더 업로드 중 이름 긴 것만 간헐적 500).
//  ⚠ 길이는 문자 수가 아니라 **바이트**다 — 이 테스트의 모든 경계는 바이트로 만든다.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { receiveUpload, uploadError } from "./upload-file.js";

const MAX = 1024 * 1024;
const NAME_MAX = 255;          // 리눅스 fs 컴포넌트 상한(바이트)
const TMP_OVERHEAD = 21;       // '.' + '.upload-' + hex12
const nameOf = (url: string): string => new URL(url, "http://x").searchParams.get("name") ?? "f";

// 정확히 n 바이트인 이름을 만든다. 앞에 ASCII 1개를 두어 **잘림 지점이 음절(3바이트 자모) 중간**에 걸리게 한다
//  — truncBytes 가 UTF-8 경계를 지키는지 실제로 태우기 위한 배치다.
const nameOfBytes = (n: number): string => {
  const SYL = "각";        // NFD '각' = 9바이트 (맥이 보내는 형태)
  const tail = ".md";
  const budget = n - Buffer.byteLength(tail) - 1;
  const k = Math.floor(budget / 9);
  const name = "a" + SYL.repeat(k) + "a".repeat(budget - k * 9) + tail;
  assert.equal(Buffer.byteLength(name), n, "테스트용 이름 길이 생성 실패");
  return name;
};

async function main(): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "co-upload-long-"));

  const server = http.createServer((req, res) => {
    receiveUpload(req, path.join(dir, nameOf(req.url ?? "/")), MAX, null)
      .then(() => { res.writeHead(200); res.end('{"ok":true}'); })
      .catch((e: unknown) => {
        const he = uploadError(e);
        if (!he) return;
        res.writeHead(he.status); res.end(JSON.stringify({ error: he.message }));
      });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;

  const put = (name: string, body: Buffer): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "PUT",
        path: `/f?name=${encodeURIComponent(name)}` }, (res) => {
        let b = ""; res.setEncoding("utf8");
        res.on("data", (c) => { b += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      req.on("error", reject);
      req.end(body);
    });

  const leftovers = async (): Promise<string[]> =>
    (await fsp.readdir(dir)).filter((f) => f.includes(".upload-"));

  // ── 경계 표: 원본명 바이트 × 기대 ──
  //  234 = NAME_MAX(255) - 오버헤드(21). 종전 구현은 여기를 **1바이트라도 넘으면** 500 이었다.
  for (const bytes of [234, 235, NAME_MAX]) {
    const name = nameOfBytes(bytes);
    const r = await put(name, Buffer.from("x".repeat(bytes)));
    assert.equal(r.status, 200, `원본명 ${bytes}B (임시파일 ${bytes + TMP_OVERHEAD}B) 가 200 이 아니다 — ${r.body}`);
    assert.equal(await fsp.readFile(path.join(dir, name), "utf8"), "x".repeat(bytes), `${bytes}B 파일 내용 불일치`);
    assert.deepEqual(await leftovers(), [], `${bytes}B 업로드가 임시파일을 남겼다`);
  }

  // 상한 초과(256B) — 목적지 이름 자체가 담길 수 없다. **500 이 아니라 무엇이 문제인지 말하는 400**.
  //  ⚠ 이 케이스만은 **ASCII** 로 만든다. 파일명 상한의 단위가 OS 마다 다르기 때문이다(맥 실측):
  //   · 리눅스 ext4 = 255 **바이트**  · 맥 APFS = 255 **문자(코드포인트)**
  //  NFD 한글로 256바이트를 만들면 음절당 9바이트라 88문자뿐이어서, 맥에선 상한을 안 넘어 정상 저장(200)된다
  //  → 리눅스에서만 빨간불이 되는 환경 의존 테스트가 된다. ASCII 는 1바이트=1문자라 두 기준을 동시에 넘겨
  //  어느 OS 에서든 ENAMETOOLONG 이 나므로, 이 검사가 노리는 '400 으로 원인을 말해주는가'를 곧게 검증한다.
  const tooLong = "a".repeat(NAME_MAX + 1 - ".md".length) + ".md";
  assert.equal(Buffer.byteLength(tooLong), NAME_MAX + 1, "상한 초과 이름 생성 실패");
  const r400 = await put(tooLong, Buffer.from("x"));
  assert.equal(r400.status, 400, `상한 초과 이름이 400 이 아니다(정체불명 500 회귀?) — ${r400.status} ${r400.body}`);
  assert.match(JSON.parse(r400.body).error as string, /이름이 너무 깁니다/, "원인을 말해주지 않는 문구다");
  assert.deepEqual(await leftovers(), [], "실패한 업로드가 임시파일을 남겼다");

  // 잘린 임시파일명이 **충돌하지 않는다** — 250B 두 이름이 앞 234B 는 같고 꼬리만 다르다(자르면 동일해진다).
  //  유일성은 hex 난수가 보장해야 한다. 동시에 보내 서로를 덮지 않는지 본다.
  const stem = nameOfBytes(250).slice(0, -3);              // ".md" 떼고 공통 줄기
  const [a, b] = [`${stem}-A.md`, `${stem}-B.md`];
  const both = await Promise.all([put(a, Buffer.from("AAA")), put(b, Buffer.from("BBB"))]);
  assert.deepEqual(both.map((x) => x.status), [200, 200], `꼬리만 다른 긴 이름 동시 업로드 실패 — ${JSON.stringify(both)}`);
  assert.equal(await fsp.readFile(path.join(dir, a), "utf8"), "AAA", "동시 업로드가 서로를 덮었다(A)");
  assert.equal(await fsp.readFile(path.join(dir, b), "utf8"), "BBB", "동시 업로드가 서로를 덮었다(B)");
  assert.deepEqual(await leftovers(), [], "동시 업로드가 임시파일을 남겼다");

  // 임시파일명이 **유효한 UTF-8** 이어야 한다 — 바이트로 자르면서 멀티바이트 문자를 쪼개면 U+FFFD 가 박힌다.
  //  전송 중에 디렉터리를 훔쳐봐 실제 임시파일명을 붙잡아 검사한다(잘림이 음절 중간에 떨어지도록 배치해 뒀다).
  const slowName = nameOfBytes(250);
  let seen = "";
  const slow = new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "PUT",
      path: `/f?name=${encodeURIComponent(slowName)}`, headers: { "content-length": "2" } }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.write("x");
    setTimeout(() => req.end("y"), 300);      // 300ms 동안 임시파일이 디스크에 있다
  });
  for (let i = 0; i < 40 && !seen; i++) {
    seen = (await fsp.readdir(dir)).find((f) => f.includes(".upload-")) ?? "";
    if (!seen) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(seen, "전송 중 임시파일을 붙잡지 못했다 — 이 검사가 무의미해졌다(관측 장치 고장)");
  assert.ok(Buffer.byteLength(seen) <= NAME_MAX, `임시파일명이 상한을 넘었다: ${Buffer.byteLength(seen)}B`);
  assert.ok(!seen.includes("�"), "임시파일명이 UTF-8 문자 중간에서 잘렸다(U+FFFD 포함)");
  assert.equal(await slow, 200);

  server.close();
  await fsp.rm(dir, { recursive: true, force: true });
  console.log("upload-file-longname.test: ok");
}

await main();
