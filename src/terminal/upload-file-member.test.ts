// #1272 — **격리(멤버 uid) 업로드 경로**도 정지(stall)에서 반드시 끝난다: 408 + 임시파일 0 + **자식 사슬 종료**.
//  고객사 A 실박스에서 실제로 남은 것: 0바이트 임시파일 + `sudo → box-spawn → sh → cat` 고아 4쌍(최장 33분 생존).
//  종료는 **stdin EOF** 로 성립한다(kill 은 직접 자식 `sudo` 만 종료시키고 그 아래 sh·cat 은 고아로 남는다).
//  이 테스트는 그 성립을 marker 파일(자식 사슬이 끝나면 한 줄 추가)로 관측한다.
//  ⚠ 스텁 sudo 는 setuid 가 아니므로 시그널 semantics 는 실환경과 다르다 — 이 테스트가 지키는 것은
//  **계약**(408 · 임시파일 0 · 사슬 종료)이고, 종료 수단의 우열은 실박스 관측(#1272)이 근거다.
//  실제 sudo 권한은 CI·개발기에 없으므로 `sudo`·box-spawn 을 **스텁**으로 끼운다(PATH + LIVELY_BOX_SPAWN).
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

const MAX = 1024 * 1024; // 이 테스트의 업로드 상한(1MB)
const STALL = 300;       // 이 테스트의 정지 상한(운영 기본은 UPLOAD_STALL_MS=120s)
const OBS = 4000;        // 관측창 — 이 안에 응답이 없으면 '판정 안 함'(0)
const nameOf = (url: string): string => new URL(url, "http://x").searchParams.get("name") ?? "f";

async function main(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "co-upload-member-"));
  const bin = path.join(root, "bin");
  const files = path.join(root, "files");
  const marker = path.join(root, "exited.log");
  await fsp.mkdir(bin);
  await fsp.mkdir(files);

  // sudo 스텁 — "-n / -u <user> / --" 를 걷어내고 나머지를 그대로 실행(권한 상승 없음, stdin 그대로 전달).
  await fsp.writeFile(path.join(bin, "sudo"),
    '#!/bin/sh\n'
    + 'while [ $# -gt 0 ]; do case "$1" in -n) shift ;; -u) shift 2 ;; --) shift; break ;; *) break ;; esac; done\n'
    + 'exec "$@"\n', { mode: 0o755 });
  // box-spawn 스텁 — 자식이 끝나면 marker 에 한 줄 남긴다. 이게 "사슬이 정말 끝났나"의 관측 장치다.
  await fsp.writeFile(path.join(bin, "box-spawn"),
    '#!/bin/sh\n'
    + 'while [ "$1" = "--cwd" ]; do shift 2; done\n'
    + '"$@"; st=$?\n'
    + `echo "exit=$st" >> ${JSON.stringify(marker)}\n`
    + 'exit $st\n', { mode: 0o755 });

  process.env.PATH = bin + path.delimiter + (process.env.PATH ?? "");
  process.env.LIVELY_BOX_SPAWN = path.join(bin, "box-spawn");
  // ⚠ 환경을 세운 **뒤에** 로드한다 — BOX_SPAWN 은 모듈 로드 시점에 고정된다(정적 import 면 늦다).
  const { receiveUpload, uploadError } = await import("./upload-file.js");

  // 라우트(terminal-files.ts 격리 분기)와 같은 모양 — osUser 를 주면 멤버 경로를 탄다.
  const server = http.createServer((req, res) => {
    receiveUpload(req, path.join(files, nameOf(req.url ?? "/")), MAX, "boxuser", STALL)
      .then(() => { res.writeHead(200); res.end('{"ok":true}'); })
      .catch((e: unknown) => {
        const he = uploadError(e);
        if (!he) return; // 취소 — 응답할 상대가 없다
        res.writeHead(he.status); res.end(JSON.stringify({ error: he.message }));
      });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;

  const ls = async (): Promise<string[]> => (await fsp.readdir(files)).sort();
  const exits = async (): Promise<number> =>
    (await fsp.readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean).length;

  const put = (name: string, body: Buffer): Promise<number> => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "PUT", path: `/f?name=${name}` }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(body);
  });
  // 헤더만 보내고 **소켓은 살려 둔 채** 멈춘다 — 정지 재현(취소와의 차이는 소켓을 끊지 않는다는 것뿐).
  const stalledPut = (name: string): Promise<number> => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "PUT", path: `/f?name=${name}`,
      headers: { "content-length": String(8 * 1024 * 1024) } }, (res) => {
      res.resume(); res.on("end", () => { clearTimeout(t); req.destroy(); resolve(res.statusCode ?? 0); });
    });
    req.on("error", reject);
    const t = setTimeout(() => { req.destroy(); resolve(0); }, OBS);
    req.flushHeaders();
  });

  // ① 정상 업로드 — 내용 정확 · 임시파일 0 · **스텁이 실제로 불렸다**(배선 확인: marker 가 늘어야 한다).
  //  marker 가 0 이면 이 테스트는 격리 경로를 아예 안 태운 것이므로 이후 단언이 모두 무의미해진다.
  assert.equal(await put("ok.txt", Buffer.from("hello")), 200);
  assert.equal(await fsp.readFile(path.join(files, "ok.txt"), "utf8"), "hello");
  assert.deepEqual(await ls(), ["ok.txt"], "성공 업로드가 임시파일을 남겼다");
  const afterOk = await exits();
  assert.ok(afterOk > 0, "sudo/box-spawn 스텁이 불리지 않았다 — 격리 경로를 타지 않은 테스트다");

  // ② 0바이트 정지 — 상한 내 408 · 임시파일 0 · **자식 사슬이 끝났다**(고아 없음).
  //  고치기 전엔 세 단언 모두 깨졌다: 응답 없음(영구 매달림) · 0바이트 임시파일 잔존 · `sh`+`cat` 고아 생존.
  const t0 = Date.now();
  assert.equal(await stalledPut("stalled.bin"), 408, "격리 경로의 0바이트 정지가 408 을 응답하지 않았다");
  assert.ok(Date.now() - t0 < OBS, "정지 판정이 관측창 안에 끝나지 않았다");
  await new Promise((r) => setTimeout(r, 400)); // 사슬 종료 + 임시파일 삭제 시간
  assert.deepEqual(await ls(), ["ok.txt"], "정지한 업로드가 임시파일/부분 파일을 남겼다");
  assert.ok(await exits() > afterOk, "정지 후에도 자식 사슬(sh·cat)이 살아 있다 — 고아 누수");

  server.close();
  await fsp.rm(root, { recursive: true, force: true });
  console.log("upload-file-member.test: ok");
}

await main();
