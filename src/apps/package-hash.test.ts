import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashAppPackage } from "./package-hash.js";

async function stage(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "app-pkg-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body);
  }
  return dir;
}

test("동일 내용 = 동일 해시(결정론)", async () => {
  const a = await stage({ "lively-app.json": "{}", "ui/i.html": "<p>x</p>" });
  const b = await stage({ "lively-app.json": "{}", "ui/i.html": "<p>x</p>" });
  const ha = await hashAppPackage(a);
  const hb = await hashAppPackage(b);
  assert.equal(ha.hash, hb.hash);
  assert.equal(ha.files, 2);
  await rm(a, { recursive: true }); await rm(b, { recursive: true });
});

test("내용 1바이트 차 = 다른 해시", async () => {
  const a = await stage({ "f.txt": "hello" });
  const b = await stage({ "f.txt": "hellO" });
  assert.notEqual((await hashAppPackage(a)).hash, (await hashAppPackage(b)).hash);
  await rm(a, { recursive: true }); await rm(b, { recursive: true });
});

test("파일 이름만 다르면 다른 해시(경로가 해시에 반영)", async () => {
  // 내용 이어붙이기만 하면 {a:'x',b:'y'} 와 {a:'xy',b:''} 가 충돌 — 경로+길이 경계로 방지.
  const a = await stage({ "a": "xy", "b": "" });
  const b = await stage({ "a": "x", "b": "y" });
  assert.notEqual((await hashAppPackage(a)).hash, (await hashAppPackage(b)).hash);
  await rm(a, { recursive: true }); await rm(b, { recursive: true });
});

test("전체 길이 sha256(48비트 절단 아님) — 64 hex", async () => {
  const a = await stage({ "f": "x" });
  assert.match((await hashAppPackage(a)).hash, /^[0-9a-f]{64}$/);
  await rm(a, { recursive: true });
});

test("심링크(파일) 거부 — 심링크 공격/타깃 바꿔치기 차단 (R2-3)", async () => {
  const dir = await stage({ "real.txt": "hi" });
  await symlink(path.join(dir, "real.txt"), path.join(dir, "link.txt"));
  await assert.rejects(() => hashAppPackage(dir), /심링크/);
  await rm(dir, { recursive: true });
});

test("심링크(디렉터리) 거부", async () => {
  const dir = await stage({ "sub/f.txt": "hi" });
  await symlink(path.join(dir, "sub"), path.join(dir, "linkdir"));
  await assert.rejects(() => hashAppPackage(dir), /심링크/);
  await rm(dir, { recursive: true });
});

test("중첩 디렉터리 순회", async () => {
  const dir = await stage({ "a/b/c/deep.txt": "z", "top.txt": "t" });
  assert.equal((await hashAppPackage(dir)).files, 2);
  await rm(dir, { recursive: true });
});
