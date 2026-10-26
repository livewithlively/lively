// 앱 서버 빌더(#4484) 단위 시험 — 진짜 빌더(SERVER_BUILDER_JS)를 `node -e` 로 돌린다. 세션 경계 중계처럼 **stdin 을 닫지 않고**(EOF 없음) 길이로 끝을 알린다.
// 실행: npm run build && node dist/apps/app-server-builder.test.js
//  A1~A16 · E1~E9 는 사양 엣지 표(지식 app-server-deploy-asbuilt-4484 · 스크래치패드 spec-4484.md A절 · E절)의 행 번호다.
//  단언은 문구가 아니라 관찰 가능한 결과로 — 실패 단계(stage) · 올린 횟수 · 올린 바이트 · zip 안 내용(이 시험이 직접 푼다: 중앙 디렉터리 · 로컬 머리 · inflate · CRC).
//  npm 은 의존성 없는 표본이라 네트워크 없이 돈다(npm ci 가 0개를 깐다). A14b(잠금 파일 없이 의존성 있음 → npm install)는 네트워크가 필요해 뺐다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { BUILDER_VERSION, BUILD_RESULT_MARK, SERVER_BUILDER_JS, encodeBuildHeader, parseBuildResult, type BuildHeader, type BuildResult } from "./app-server-builder.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

// ── 표본 앱 ──
const PKG = (extra: Record<string, unknown> = {}): string => JSON.stringify({ name: "s", version: "1.0.0", private: true, scripts: { start: "node server.js", build: "node build.js" }, ...extra });
const LOCK = JSON.stringify({ name: "s", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "s", version: "1.0.0" } } });
const SERVER = "require('http').createServer((q,s)=>s.end('hi')).listen(Number(process.env.PORT||8080));\n";
const BUILD = "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/out.txt','built');fs.mkdirSync('bin',{recursive:true});" +
  "fs.writeFileSync('bin/tool.sh','#!/bin/sh\\necho t\\n',{mode:0o755});fs.symlinkSync('../dist/out.txt','bin/link.txt');console.log('BUILD-DONE');\n";
type Files = Record<string, string | Buffer>;
const baseApp = (over: Files = {}): Files => ({
  "package.json": PKG(), "package-lock.json": LOCK, "server.js": SERVER, "build.js": BUILD, "lively-app.json": "{\"id\":\"s\"}",
  "src/한글 파일.txt": "가나다", "src/empty.txt": "", ...over,
});

interface Run { code: number | null; res: BuildResult | null; zip: Buffer | null; stderr: string; uploads: number }

/** 빌더를 돌린다 — 업로드는 이 프로세스의 작은 서버가 받는다(statuses 차례로 흉내 — 다 쓰면 200). */
async function runBuilder(files: Files, hdr: Partial<BuildHeader> = {}, opts: { statuses?: number[]; rawHeader?: string; extra?: Array<[string, Buffer]> } = {}): Promise<Run> {
  let zip: Buffer | null = null;
  let uploads = 0;
  const statuses = [...(opts.statuses ?? [])];
  const srv = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (d: Buffer) => parts.push(d));
    req.on("end", () => {
      uploads++;
      const st = statuses.shift() ?? 200;
      if (st === 200) zip = Buffer.concat(parts);
      res.writeHead(st); res.end(st === 200 ? "" : "<Error><Code>X</Code></Error>");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const list: Array<readonly [string, Buffer]> = [...Object.entries(files).map(([p, c]) => [p, Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8")] as const), ...(opts.extra ?? [])];
  const header: BuildHeader = {
    v: 1, deadline_ms: Date.now() + 120_000, files: list.map(([p, b]) => [p, b.length]), build: null, start: null,
    unzipped_max: 50 * 1024 * 1024, mem_floor_mb: 300, heap_mb: 0, upload_url: `http://127.0.0.1:${port}/zip?X-Amz-Signature=x`,
    meminfo_path: "/nonexistent/meminfo", ...hdr,
  };
  const c = spawn(process.execPath, ["-e", SERVER_BUILDER_JS], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, npm_config_offline: "true" } });
  let out = "", err = "";
  c.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  c.stderr.on("data", (d: Buffer) => { err += d.toString(); });
  c.stdin.on("error", () => { /* 빌더가 먼저 끝났다 */ });
  //  머리와 파일 바이트를 한 덩어리로 이어 7바이트씩 보낸다 — 머리와 바이트가 한 조각에 섞이고, 파일 경계가 조각 중간에 걸린다(A16).
  const all = Buffer.concat([opts.rawHeader != null ? Buffer.from(opts.rawHeader) : encodeBuildHeader(header), ...list.map(([, b]) => b)]);
  for (let i = 0; i < all.length; i += 7) c.stdin.write(all.subarray(i, i + 7));
  //  ⚠ stdin 을 닫지 않는다 — 세션 경계 중계는 EOF 를 전하지 않는다.
  const code = await new Promise<number | null>((r) => c.on("close", (k) => r(k)));
  c.stdin.destroy();
  srv.close();
  return { code, res: parseBuildResult(out), zip, stderr: err, uploads };
}

// ── 작은 zip 읽개(시험용) — EOCD → (Zip64 위치) → 중앙 디렉터리 → 로컬 머리 → 내용 · CRC ──
interface ZEnt { name: string; mode: number; data: Buffer }
function readZip(buf: Buffer): ZEnt[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  assert.ok(eocd >= 0, "EOCD 없음");
  let n = buf.readUInt16LE(eocd + 10);
  let cdAt = buf.readUInt32LE(eocd + 16);
  if (n === 0xffff && eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z = Number(buf.readBigUInt64LE(eocd - 20 + 8));
    n = Number(buf.readBigUInt64LE(z + 32)); cdAt = Number(buf.readBigUInt64LE(z + 48));
  }
  const out: ZEnt[] = [];
  let p = cdAt;
  for (let k = 0; k < n; k++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "중앙 머리 서명");
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38), lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString("utf8");
    assert.equal(buf.readUInt32LE(lho), 0x04034b50, `로컬 머리 서명 ${name}`);
    assert.equal(buf.readUInt32LE(lho + 14), crc, `로컬 머리 crc ${name}`);
    const lnl = buf.readUInt16LE(lho + 26), lxl = buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(lho + 30 + lnl + lxl, lho + 30 + lnl + lxl + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(data.length, usize, `크기 ${name}`);
    const z = zlib as unknown as { crc32?: (b: Buffer) => number };
    if (z.crc32) assert.equal(z.crc32(data) >>> 0, crc, `CRC ${name}`);
    out.push({ name, mode: ext >>> 16, data });
    p += 46 + nl + xl + cl;
  }
  return out;
}
const fileOf = (z: ZEnt[], n: string): ZEnt | undefined => z.find((e) => e.name === n);
/** 지금 비어 있는 포트 — OS 에게 받고(listen(0)) 바로 닫는다. 표본 서버처럼 주소 없이 받아 같은 자리를 잰다. */
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});
/**
 * zip 을 새 폴더에 풀고(링크는 링크로) 시작 스크립트(lively-run.sh)로 띄워 «/» 의 본문을 받는다 — 30초 안에 못 받으면 "".
 *  포트는 OS 가 빈 것으로 준다. 종전엔 20000~39999 에서 무작위로 골랐고 상한이 5초였다 — 그 자리를 다른 소켓이 쥐고 있거나
 *  부하(-j 4) 속에서 sh → node 기동이 5초를 넘기면 빈 본문이 되어 CI 에서 간헐적으로 빨갰다(2026-10-26 main run 40269685959 ·
 *  merge queue 40289205992). 서버가 먼저 죽으면 상한을 기다리지 않고 끝내고, 그 출력과 종료 사유를 남긴다.
 */
async function bootZip(z: ZEnt[]): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-"));
  for (const e of z) {
    const abs = path.join(dir, e.name);
    if (e.name.endsWith("/")) { fs.mkdirSync(abs, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if ((e.mode & 0o170000) === 0o120000) fs.symlinkSync(e.data.toString(), abs); else fs.writeFileSync(abs, e.data, { mode: e.mode & 0o777 });
  }
  const port = await freePort();
  //  detached = 제 프로세스 그룹. 시작 스크립트는 sh 라 서버(node)는 그 손자다 — sh 만 죽이면 node 가 PID 1 에 붙어 영영 남는다.
  //   그래서 그룹째 죽인다.
  const srvProc = spawn(path.join(dir, "lively-run.sh"), [], { env: { ...process.env, PORT: String(port), LAMBDA_TASK_ROOT: dir }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = "";
  let ended: string | null = null;
  srvProc.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
  srvProc.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
  srvProc.on("exit", (code, signal) => { ended = `종료 code=${code} signal=${signal}`; });
  srvProc.on("error", (err) => { ended = `실행 실패 ${err.message}`; });
  let body = "";
  try {
    const until = Date.now() + 30_000;
    while (!body && ended === null && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      body = await new Promise<string>((r) => http.get(`http://127.0.0.1:${port}/`, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => r(b)); }).on("error", () => r("")));
    }
    if (!body) console.error(`bootZip: 본문을 못 받았다(포트 ${port} · ${ended ?? "30초 상한"})\n${out}`);
  } finally {
    if (srvProc.pid) { try { process.kill(-srvProc.pid, "SIGKILL"); } catch { /* 이미 끝났다 */ } }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
  return body;
}
const memFile = (mb: number): string => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mem-")), "meminfo");
  fs.writeFileSync(f, `MemTotal: 2621440 kB\nMemFree: ${mb * 1024} kB\nMemAvailable: ${mb * 1024} kB\n`);
  return f;
};

await t("A0b 빌더 글이 바뀌면 빌더 판(BUILDER_VERSION)도 올린다 — 빌드 지문에 들어가는 판이라 안 올리면 같은 코드가 옛 빌더의 zip 을 재사용한다", () => {
  //  빌더를 고쳤으면: BUILDER_VERSION 을 올리고 아래 표에 새 판의 지문을 적는다(지문 = 아래 실패 글의 actual). TypeScript 판이 바뀌어 글이 바뀌어도 같다.
  //   줄 전체가 주석인 줄은 빼고 잰다 — 주석만 고친 것은 빌드 결과가 같으니 판을 올릴(= 전 앱 재빌드) 까닭이 아니다.
  const PIN: Record<number, string> = { 2: "1ac92efd5981f7e20a6262ff5358cf86a7db5d1e6919affffc1b441ff546ab6b" };
  const codeOnly = SERVER_BUILDER_JS.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.equal(crypto.createHash("sha256").update(codeOnly).digest("hex"), PIN[BUILDER_VERSION], `빌더 글이 바뀌었다 — BUILDER_VERSION(${BUILDER_VERSION})을 올리고 지문을 적으세요`);
});

await t("A0 결과 표식이 빌더 안의 상수와 같다(바깥 이름을 못 쓰는 함수라 두 벌이다)", () => {
  assert.ok(SERVER_BUILDER_JS.includes(JSON.stringify(BUILD_RESULT_MARK).slice(1, -1)), "빌더 글에 같은 표식");
  assert.ok(SERVER_BUILDER_JS.startsWith('"use strict";'));
});

let baseline: Run;
await t("A1 · A16 성공 — 설치 · 빌드 · 정리 · zip · 올림 · 지문 = 올린 바이트 · 시작 스크립트(실행) · 매니페스트 없음 · 실행 권한 · 안쪽 심링크 · 한글 · 빈 파일 · 폴더 항목", async () => {
  const r = await runBuilder(baseApp());
  baseline = r;
  assert.equal(r.code, 0, r.stderr.slice(-800));
  assert.equal(r.res?.ok, true, JSON.stringify(r.res));
  assert.equal(r.res!.install, "ci");
  assert.deepEqual(r.res!.steps.map((s) => s.name), ["install", "build", "prune", "zip", "upload"]);
  assert.ok(r.stderr.includes("BUILD-DONE"), "빌드가 실제로 돌았다(그 출력이 기록에)");
  assert.equal(r.uploads, 1);
  assert.equal(r.res!.zip!.bytes, r.zip!.length);
  assert.equal(r.res!.zip!.sha256_hex, crypto.createHash("sha256").update(r.zip!).digest("hex"));
  assert.equal(r.res!.zip!.sha256_b64, crypto.createHash("sha256").update(r.zip!).digest("base64"));
  const z = readZip(r.zip!);
  assert.equal(r.res!.zip!.entries, z.length);
  assert.equal(fileOf(z, "lively-app.json"), undefined, "매니페스트는 담지 않는다");
  assert.equal(fileOf(z, "lively-run.sh")!.mode & 0o777, 0o755, "핸들러는 실행 권한");
  assert.equal(fileOf(z, "lively-start.sh")!.data.toString(), "node server.js\n");
  assert.equal(fileOf(z, "dist/out.txt")!.data.toString(), "built");
  assert.equal(fileOf(z, "bin/tool.sh")!.mode & 0o777, 0o755);
  assert.equal(fileOf(z, "server.js")!.mode & 0o777, 0o644);
  const link = fileOf(z, "bin/link.txt")!;
  assert.equal(link.mode & 0o170000, 0o120000, "심링크는 심링크로");
  assert.equal(link.data.toString(), "../dist/out.txt");
  assert.equal(fileOf(z, "src/한글 파일.txt")!.data.toString(), "가나다");
  assert.equal(fileOf(z, "src/empty.txt")!.data.length, 0, "크기 0 파일");
  assert.equal(fileOf(z, "dist/")!.mode & 0o170000, 0o040000, "폴더 항목");
  //  시작 스크립트가 실제로 돈다 — 풀어서 실행하면 $PORT 에서 받는다.
  assert.equal(await bootZip(z), "hi", "풀어서 시작 스크립트로 띄운 서버가 응답한다");
});

await t("A2 같은 입력이면 같은 zip(바이트 단위)", async () => {
  const again = await runBuilder(baseApp());
  assert.equal(again.res?.zip?.sha256_hex, baseline.res!.zip!.sha256_hex);
});

await t("A3 package.json 없음 → detect · 올리지 않음", async () => {
  const f = baseApp(); delete f["package.json"];
  const r = await runBuilder(f);
  assert.equal(r.code, 3);
  assert.equal(r.res?.stage, "detect");
  assert.equal(r.uploads, 0);
});

await t("A4 시작 명령이 어디에도 없음 → start · 올리지 않음", async () => {
  const r = await runBuilder(baseApp({ "package.json": PKG({ scripts: { build: "node build.js" } }) }));
  assert.equal(r.res?.stage, "start");
  assert.equal(r.uploads, 0);
});

await t("A5 머리 start 를 쓰고 · scripts.build 가 없으면 빌드 단계가 없다", async () => {
  const r = await runBuilder(baseApp({ "package.json": PKG({ scripts: {} }) }), { start: "node server.js --x" });
  assert.equal(r.res?.ok, true, JSON.stringify(r.res));
  assert.ok(!r.res!.steps.some((s) => s.name === "build"));
  assert.ok(!r.stderr.includes("BUILD-DONE"));
  assert.equal(fileOf(readZip(r.zip!), "lively-start.sh")!.data.toString(), "node server.js --x\n");
});

await t("A6 빌드가 비-0 종료 → build · 올리지 않음", async () => {
  const r = await runBuilder(baseApp({ "build.js": "process.exit(7);\n" }));
  assert.equal(r.res?.stage, "build");
  assert.equal(r.res!.steps.find((s) => s.name === "build")?.code, 7);
  assert.equal(r.uploads, 0);
});

await t("A7 빌드 도중 남은 메모리가 바닥 밑 → memory · 60초 빌드를 기다리지 않음 · 시작/최저 기록", async () => {
  const mem = memFile(1024);
  const slow = `setTimeout(()=>{},60000); setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(mem)},'MemAvailable: 204800 kB\\n'),400);\n`;
  const t0 = Date.now();
  const r = await runBuilder(baseApp({ "build.js": slow }), { meminfo_path: mem, mem_floor_mb: 400 });
  assert.equal(r.res?.stage, "memory", JSON.stringify(r.res));
  assert.ok(Date.now() - t0 < 20_000);
  assert.equal(r.res!.mem!.start_mb, 1024);
  assert.equal(r.res!.mem!.min_mb, 200);
  assert.equal(r.uploads, 0);
});

await t("A7b (경계) 남은 메모리 = 바닥이면 멈추지 않는다", async () => {
  const r = await runBuilder(baseApp(), { meminfo_path: memFile(400), mem_floor_mb: 400 });
  assert.equal(r.res?.ok, true, JSON.stringify(r.res));
  assert.equal(r.res!.mem!.min_mb, 400);
});

await t("A7c (새 변수 부재) meminfo 를 못 읽으면 감시는 아무것도 안 하고 끝까지 간다", async () => {
  const r = await runBuilder(baseApp(), { meminfo_path: "/nonexistent/x", mem_floor_mb: 1500 });
  assert.equal(r.res?.ok, true, JSON.stringify(r.res));
  assert.equal(r.res!.mem!.start_mb, null);
});

await t("A8 시간 상한이 지나면 time", async () => {
  const r = await runBuilder(baseApp({ "build.js": "setTimeout(()=>{},60000);\n" }), { deadline_ms: Date.now() + 2500 });
  assert.equal(r.res?.stage, "time", JSON.stringify(r.res));
  assert.equal(r.uploads, 0);
});

await t("A9 올리기 4xx → upload · 한 번만", async () => {
  const r = await runBuilder(baseApp(), {}, { statuses: [403, 403, 403] });
  assert.equal(r.res?.stage, "upload");
  assert.equal(r.uploads, 1);
});

await t("A9b 올리기 5xx 한 번 뒤 성공 → 성공 · 두 번", async () => {
  const r = await runBuilder(baseApp(), {}, { statuses: [503] });
  assert.equal(r.res?.ok, true, JSON.stringify(r.res));
  assert.equal(r.uploads, 2);
  assert.equal(r.res!.zip!.sha256_hex, crypto.createHash("sha256").update(r.zip!).digest("hex"));
});

await t("A10 앱 폴더 밖을 가리키는 심링크(절대 · ..) → zip · 올리지 않음", async () => {
  const r = await runBuilder(baseApp({ "build.js": "require('fs').symlinkSync('/etc/hosts','leak');\n" }));
  assert.equal(r.res?.stage, "zip");
  assert.equal(r.uploads, 0);
  const r2 = await runBuilder(baseApp({ "build.js": "require('fs').symlinkSync('../../outside','leak2');\n" }));
  assert.equal(r2.res?.stage, "zip");
});

await t("A11 맨 위에 lively-run.sh · lively-start.sh 가 있으면 start", async () => {
  assert.equal((await runBuilder(baseApp({ "lively-run.sh": "x" }))).res?.stage, "start");
  assert.equal((await runBuilder(baseApp({ "lively-start.sh": "x" }))).res?.stage, "start");
});

await t("A12 판 파일 경로가 .. · 절대 · 중복 → input", async () => {
  assert.equal((await runBuilder({ "../evil": "x", "package.json": PKG() })).res?.stage, "input");
  assert.equal((await runBuilder({ "/etc/x": "x" })).res?.stage, "input");
  assert.equal((await runBuilder({ "package.json": PKG() }, {}, { extra: [["package.json", Buffer.from("{}")]] })).res?.stage, "input");
});

await t("A13 · A13b 풀린 크기: 상한과 같으면 성공 · 1바이트 넘으면 size(가장 큰 의존성 이름)", async () => {
  //  잠금 파일 없는 표본(설치 · 정리 없음) — 정리(npm prune)는 package.json 에 없는 node_modules 를 지우므로 그 단계가 없는 길로 잰다.
  const fatApp = (): Files => { const f = baseApp({ "node_modules/fat-pkg/blob.bin": Buffer.alloc(200 * 1024, 1), "node_modules/fat-pkg/package.json": "{\"name\":\"fat-pkg\"}" }); delete f["package-lock.json"]; return f; };
  const probe = await runBuilder(fatApp());
  const exact = probe.res!.zip!.unzipped;
  assert.ok(exact > 200 * 1024, "큰 의존성이 zip 에 들었다");
  assert.equal((await runBuilder(fatApp(), { unzipped_max: exact })).res?.ok, true);
  const over = await runBuilder(fatApp(), { unzipped_max: exact - 1 });
  assert.equal(over.res?.stage, "size");
  assert.ok(over.res!.error!.includes("fat-pkg"), "어느 의존성이 큰지 알린다");
  assert.equal(over.uploads, 0);
});

await t("A14 잠금 파일 없음 + 의존성 없음 → 설치 · 정리 없이 성공", async () => {
  const f = baseApp(); delete f["package-lock.json"];
  const r = await runBuilder(f);
  assert.equal(r.res?.ok, true, JSON.stringify(r.res));
  assert.equal(r.res!.install, "none");
  assert.deepEqual(r.res!.steps.map((s) => s.name), ["build", "zip", "upload"]);
});

await t("A15 머리 JSON 이 깨짐 → input · 결과 줄은 남김", async () => {
  const r = await runBuilder({}, {}, { rawHeader: "{not json\n" });
  assert.equal(r.res?.stage, "input");
  assert.equal(r.code, 3);
});

// ── E: 올릴 폴더(web.server.dir) · /tmp 링크 ──
const OUT_SERVER = "require('http').createServer((q,s)=>s.end('from-out')).listen(Number(process.env.PORT||8080));";
/** 빌드가 out/ 에 자기 완결 서버를 만든다(+ more 는 그 뒤에 더 할 일). */
const outBuild = (more = ""): string => `const fs=require('fs');fs.mkdirSync('out/sub',{recursive:true});fs.writeFileSync('out/server.js',${JSON.stringify(OUT_SERVER)});` +
  `fs.writeFileSync('out/sub/a.txt','A');${more}console.log('BUILD-DONE');\n`;

await t("E1 올릴 폴더 = 빌드가 만든 폴더 → zip 맨 위 = 그 폴더 + 시작 스크립트 · 밖 파일 없음 · 정리 없음 · 그 폴더에서 뜬다", async () => {
  const r = await runBuilder(baseApp({ "build.js": outBuild() }), { dir: "out", start: "node server.js" });
  assert.equal(r.res?.ok, true, JSON.stringify(r.res));
  assert.deepEqual(r.res!.steps.map((s) => s.name), ["install", "build", "zip", "upload"], "정리(prune) 없음");
  assert.equal(r.res!.dir, "out");
  const z = readZip(r.zip!);
  assert.deepEqual(z.map((e) => e.name).sort(), ["lively-run.sh", "lively-start.sh", "server.js", "sub/", "sub/a.txt"]);
  assert.equal(fileOf(z, "server.js")!.data.toString(), OUT_SERVER, "앱 맨 위 server.js 가 아니라 out/server.js");
  assert.equal(fileOf(z, "lively-run.sh")!.mode & 0o777, 0o755);
  assert.equal(await bootZip(z), "from-out", "그 폴더를 맨 위로 풀어 시작 스크립트로 띄운다");
});

await t("E2 · E3 올릴 폴더가 빌드 뒤에 없거나 파일이면 dir · 올리지 않음", async () => {
  const missing = await runBuilder(baseApp(), { dir: "out" });
  assert.equal(missing.res?.stage, "dir", JSON.stringify(missing.res));
  assert.ok(missing.res!.steps.some((s) => s.name === "build"), "빌드 뒤에 안다");
  assert.equal(missing.uploads, 0);
  const file = await runBuilder(baseApp({ "build.js": "require('fs').writeFileSync('out','x');\n" }), { dir: "out" });
  assert.equal(file.res?.stage, "dir");
  assert.equal(file.uploads, 0);
});

await t("E4 올릴 폴더가 .. · 절대 · 역슬래시 · NUL 이면 빌드 전에 dir(설치 · 빌드 0)", async () => {
  for (const dir of ["../x", "a/../../x", "/abs", "a\\b", "a\u0000b"]) {
    const r = await runBuilder(baseApp(), { dir });
    assert.equal(r.res?.stage, "dir", `${JSON.stringify(dir)} → ${JSON.stringify(r.res)}`);
    assert.deepEqual(r.res!.steps, [], `${dir} — 아무 단계도 돌지 않았다`);
    assert.ok(!r.stderr.includes("BUILD-DONE"));
  }
});

await t("E5 (새 변수 부재) 올릴 폴더 없음 · 빈 글 · '.' · './' → 앱 폴더 전체(A1 과 같은 zip)", async () => {
  for (const dir of [null, "", ".", "./"]) {
    const r = await runBuilder(baseApp(), { dir });
    assert.equal(r.res?.zip?.sha256_hex, baseline.res!.zip!.sha256_hex, `dir=${JSON.stringify(dir)}`);
    assert.equal(r.res!.dir, undefined);
  }
});

await t("E6 올릴 폴더 맨 위에 lively-run.sh → start", async () => {
  const r = await runBuilder(baseApp({ "build.js": outBuild("fs.writeFileSync('out/lively-run.sh','x');") }), { dir: "out" });
  assert.equal(r.res?.stage, "start", JSON.stringify(r.res));
  assert.equal(r.uploads, 0);
});

await t("E7 풀린 크기를 넘고 큰 의존성에 next 가 있으면 standalone · web.server.dir 을 알린다", async () => {
  const f = baseApp({ "node_modules/next/blob.bin": Buffer.alloc(300 * 1024, 1), "node_modules/next/package.json": "{\"name\":\"next\"}" });
  delete f["package-lock.json"];
  const r = await runBuilder(f, { unzipped_max: 100 * 1024 });
  assert.equal(r.res?.stage, "size");
  assert.ok(r.res!.error!.includes("standalone") && r.res!.error!.includes("web.server.dir"), r.res!.error);
  const plain = baseApp({ "node_modules/fat-pkg/blob.bin": Buffer.alloc(300 * 1024, 1), "node_modules/fat-pkg/package.json": "{\"name\":\"fat-pkg\"}" });
  delete plain["package-lock.json"];
  const r2 = await runBuilder(plain, { unzipped_max: 100 * 1024 });
  assert.ok(!r2.res!.error!.includes("standalone"), "next 가 아니면 Next.js 안내는 없다");
});

await t("E8 /tmp 아래를 가리키는 링크 → 링크로 담고 · 시작 스크립트가 그 자리를 만들어 앱이 그리로 쓴다", async () => {
  const target = `/tmp/lv-e8-${process.pid}-${Date.now()}/cache`;
  const writer = "const fs=require('fs');require('http').createServer((q,s)=>{fs.writeFileSync('.cache/w.txt','w');s.end('wrote')}).listen(Number(process.env.PORT||8080));";
  const build = `const fs=require('fs');fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/server.js',${JSON.stringify(writer)});fs.symlinkSync(${JSON.stringify(target)},'out/.cache');\n`;
  const r = await runBuilder(baseApp({ "build.js": build }), { dir: "out", start: "node server.js" });
  assert.equal(r.res?.ok, true, JSON.stringify(r.res));
  const z = readZip(r.zip!);
  const link = fileOf(z, ".cache")!;
  assert.equal(link.mode & 0o170000, 0o120000, "링크로 담았다");
  assert.equal(link.data.toString(), target);
  assert.ok(!fs.existsSync(target), "시험 전엔 그 자리가 없다");
  try {
    assert.equal(await bootZip(z), "wrote", "시작 전에 그 자리를 만들어 앱이 링크로 썼다");
    assert.equal(fs.readFileSync(path.join(target, "w.txt"), "utf8"), "w");
  } finally { fs.rmSync(path.dirname(target), { recursive: true, force: true }); }
});

await t("E9 (경계) /tmp 자체는 허락 · /tmpx · /tmp/../etc 는 zip", async () => {
  const mk = (t: string): string => `const fs=require('fs');fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/server.js','');fs.symlinkSync(${JSON.stringify(t)},'out/l');\n`;
  const ok = await runBuilder(baseApp({ "build.js": mk("/tmp") }), { dir: "out", start: "node server.js" });
  assert.equal(ok.res?.ok, true, JSON.stringify(ok.res));
  assert.ok(!fileOf(readZip(ok.zip!), "lively-run.sh")!.data.toString().includes("mkdir"), "/tmp 자체는 만들 것이 없다");
  for (const bad of ["/tmpx", "/tmp/../etc", "/tmpx/y"]) {
    const r = await runBuilder(baseApp({ "build.js": mk(bad) }), { dir: "out", start: "node server.js" });
    assert.equal(r.res?.stage, "zip", `${bad} → ${JSON.stringify(r.res)}`);
    assert.equal(r.uploads, 0);
  }
});

await t("결과 줄 읽기 — 마지막 표식 줄 · 깨진 줄은 건너뛰고 앞을 본다 · 없으면 null", () => {
  const good = { ok: true, steps: [], warnings: [] };
  assert.deepEqual(parseBuildResult(`x\n${BUILD_RESULT_MARK}${JSON.stringify({ ok: false, steps: [], warnings: [] })}\n${BUILD_RESULT_MARK}${JSON.stringify(good)}\n`), good);
  assert.equal(parseBuildResult(`${BUILD_RESULT_MARK}${JSON.stringify(good)}\n${BUILD_RESULT_MARK}{broken\n`)?.ok, true);
  assert.equal(parseBuildResult("nothing here"), null);
});

console.log(`\n${pass} passed`);
