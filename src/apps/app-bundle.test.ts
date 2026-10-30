// 판 묶음 만들기(#4481) — 사양 표 C(C1~C6, 저장소 없이 되는 것). 실행: npm run build && node dist/apps/app-bundle.test.js
//  저장소를 지나는 것(올리기 · 풀기 · 정리)은 실제 DB 시험 app-bundles.pg-test.mjs 가 본다.
//  이게 틀리면: 판의 파일 목록이 실제 내용과 다르거나(지문), 같은 경로 두 파일이 한 판에 들어가 어느 쪽이 서는지 모르거나,
//   폴더 밖을 가리키는 심링크가 판에 실리거나, 옛 코어로 되돌렸을 때 되돌릴 수 없는 판에 호환 사본이 빠진다(또는 너무 큰 판이 DB 에 실린다).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpError } from "../http-error.js";
import { COMPAT_MAX_FILES, bundleFromDir, bundleFromFiles, compatFilesFor, normalizeBundlePath, parseBundle } from "./app-bundle.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };
const sha = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");
const rejects400 = (fn: () => unknown, label: string): void => {
  try { fn(); } catch (e) { assert.ok(e instanceof HttpError && e.status === 400, `${label}: ${String(e)}`); return; }
  assert.fail(`${label}: 던지지 않았다`);
};

{
  const bin = Buffer.from([0, 1, 2, 255]);
  const p = bundleFromFiles([
    { path: "ui/index.html", content: "<p>한</p>" },
    { path: "lively-app.json", content: "{}" },
    { path: "dist/assets/x.bin", content: bin.toString("base64"), encoding: "base64" },
  ]);
  assert.deepEqual(p.bundle.files.map((f) => f.p), ["dist/assets/x.bin", "lively-app.json", "ui/index.html"], "경로 정렬");
  const x = p.bundle.files[0];
  assert.equal(x.h, sha(bin));
  assert.equal(x.s, 4);
  assert.equal(p.bundle.files[2].s, Buffer.byteLength("<p>한</p>"), "크기는 바이트");
  assert.ok(parseBundle(JSON.parse(JSON.stringify(p.bundle))), "DB 왕복 모양");
  ok("C1 파일 묶음 → 정렬된 목록 · 지문 = sha256(바이트)");
}
{
  rejects400(() => bundleFromFiles([{ path: "a", content: "1" }, { path: "./a", content: "2" }]), "같은 경로");
  for (const bad of ["../x", "/abs", "a\\b", "a/../../b"]) rejects400(() => bundleFromFiles([{ path: bad, content: "1" }]), bad);
  assert.equal(normalizeBundlePath("a//b/./c"), "a/b/c");
  assert.equal(parseBundle({ v: 1, files: [{ p: "../x", h: "a".repeat(64), s: 1 }] }), null, "DB 의 틀린 목록도 받지 않는다");
  ok("C2 같은 경로 · 틀린 경로 400");
}
const tmp = mkdtempSync(path.join(tmpdir(), "bundle-test-"));
try {
  {
    const d = path.join(tmp, "app");
    mkdirSync(path.join(d, "dist/assets"), { recursive: true });
    writeFileSync(path.join(d, "lively-app.json"), "{}");
    writeFileSync(path.join(d, "dist/index.html"), "<p>hi</p>");
    writeFileSync(path.join(d, "dist/assets/empty.css"), "");
    writeFileSync(path.join(d, ".hidden"), "x");
    const p = await bundleFromDir(d);
    assert.deepEqual(p.bundle.files.map((f) => `${f.p}:${f.s}`), [".hidden:1", "dist/assets/empty.css:0", "dist/index.html:9", "lively-app.json:2"]);
    assert.equal((await p.readers.get(p.bundle.files[2].h)!()).toString(), "<p>hi</p>", "읽는 길이 그 파일을 읽는다");
    ok("C3 폴더(스테이지) → 전부 · 빈 파일 0 · 내용 읽기");
  }
  {
    const d = path.join(tmp, "link");
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "lively-app.json"), "{}");
    symlinkSync("/etc/hosts", path.join(d, "out"));
    await assert.rejects(bundleFromDir(d), (e: unknown) => e instanceof HttpError && e.status === 400);
    ok("C4 심링크 400");
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
{
  const many = (n: number) => bundleFromFiles(Array.from({ length: n }, (_, i) => ({ path: `f/${i}.txt`, content: String(i) })));
  const c200 = await compatFilesFor(many(COMPAT_MAX_FILES));
  assert.equal(c200?.length, 200, "정확히 200개는 사본이 있다");
  assert.equal(await compatFilesFor(many(COMPAT_MAX_FILES + 1)), null, "201개는 없다");
  ok("C5 호환 사본 파일 수 경계");
}
{
  const big = bundleFromFiles([{ path: "big.bin", content: Buffer.alloc(9 * 1024 * 1024, 7).toString("base64"), encoding: "base64" }]);
  assert.equal(await compatFilesFor(big), null);
  const small = await compatFilesFor(bundleFromFiles([{ path: "a.bin", content: Buffer.from([255]).toString("base64"), encoding: "base64" }, { path: "b.json", content: "{}" }]));
  assert.deepEqual(small, [{ path: "a.bin", content: "/w==", encoding: "base64" }, { path: "b.json", content: "{}" }], "글은 utf8 · 나머지는 base64(옛 모양)");
  ok("C6 9MiB 판은 사본 없음 · 사본 모양은 옛 판과 같다");
}
console.log(`\n${pass} passed`);
