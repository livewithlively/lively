// 묶음 압축(zip) 쓰기·읽기 — 받는 쪽에선 남이 만든 파일이라 «거절해야 할 것을 거절하나» 가 핵심이다.
//  실행: npx tsx --test src/transfer/zip.test.ts   (사양: #5458 spec 표 A)
//
//  ── 엣지 표 (행마다 테스트 하나) ──────────────────────────────────────────
//   A1  한글 경로 · 압축되는 글 · 압축 안 되는 바이트 · 빈 파일   → 경로·내용 그대로 왕복
//   A2  같은 경로 두 번 쓰기                                   → 거절
//   A3  위험한 경로(.. · 절대 · 역슬래시 · 드라이브 · . · NUL · 빈) → 쓰기 거절 · 읽을 때 거절
//   A4  풀면 항목/누적 상한을 넘는 항목                         → 거절
//   A4b 풀린 크기 = 상한 정확히                                → 허용(경계)
//   A5  내용 한 바이트가 바뀐 파일                              → 거절
//   A6  항목 수 = 상한 / 상한+1                                → 허용 / 거절(경계)
//   A7  잘린 파일 · zip 이 아닌 바이트                          → 거절
//   A8  항목 0개                                             → 빈 결과
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeZip, readZip, looksLikeZip, assertSafeEntryPath, ZipFormatError, BUNDLE_ZIP_LIMITS } from "./zip.js";

test("A1 한글 경로·글·이진 바이트·빈 파일이 그대로 왕복한다", () => {
  const bin = randomBytes(4096);
  const text = Buffer.from("가나다라 ".repeat(2000), "utf8");
  const zip = writeZip([
    { path: "knowledge/한글-이름.md", data: text },
    { path: "sources/1.json", data: bin },
    { path: "empty.txt", data: Buffer.alloc(0) },
  ]);
  assert.ok(looksLikeZip(zip));
  const out = readZip(zip);
  assert.deepEqual([...out.keys()].sort(), ["empty.txt", "knowledge/한글-이름.md", "sources/1.json"]);
  assert.ok(out.get("knowledge/한글-이름.md")!.equals(text));
  assert.ok(out.get("sources/1.json")!.equals(bin));
  assert.equal(out.get("empty.txt")!.length, 0);
  // 배선 — 글이 실제로 압축됐다(아무것도 안 하는 writer 면 크기가 합보다 크다)
  assert.ok(zip.length < text.length + bin.length);
});

test("A2 같은 경로를 두 번 쓰면 거절한다", () => {
  assert.throws(() => writeZip([{ path: "a.md", data: Buffer.from("1") }, { path: "a.md", data: Buffer.from("2") }]), ZipFormatError);
});

test("A3 위험한 경로는 쓰기·읽기 모두 거절한다", () => {
  for (const p of ["../x.md", "a/../../x", "/etc/passwd", "a\\b.md", "C:x.md", "a/./b", "nul\0.md", ""]) {
    assert.throws(() => assertSafeEntryPath(p), ZipFormatError, JSON.stringify(p));
    assert.throws(() => writeZip([{ path: p, data: Buffer.from("x") }]), ZipFormatError, JSON.stringify(p));
  }
  // 읽기 — 정상 zip 의 이름 바이트(로컬 헤더·중앙 목록 둘 다)를 같은 길이의 '../x' 로 바꿔 끼운다.
  const zip = writeZip([{ path: "ab/x", data: Buffer.from("hi") }]);
  const evil = Buffer.from(zip.toString("latin1").split("ab/x").join("../x"), "latin1");
  assert.throws(() => readZip(evil), ZipFormatError);
});

test("A4 풀면 항목·누적 상한을 넘는 항목은 거절한다", () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 0x61); // 2MB 'a' — 압축하면 몇 KB
  const zip = writeZip([{ path: "bomb.md", data: big }]);
  assert.ok(zip.length < 64 * 1024, "압축 폭탄 모양(작은 파일)이어야 시험이 뜻이 있다");
  assert.throws(() => readZip(zip, { ...BUNDLE_ZIP_LIMITS, maxEntryBytes: 1024 * 1024 }), ZipFormatError);
  assert.throws(() => readZip(zip, { ...BUNDLE_ZIP_LIMITS, maxTotalBytes: 1024 * 1024 }), ZipFormatError);
});

test("A4b 풀린 크기가 상한과 정확히 같으면 허용한다", () => {
  const exact = Buffer.alloc(1000, 0x62);
  const zip = writeZip([{ path: "a.md", data: exact }, { path: "b.md", data: exact }]);
  const out = readZip(zip, { ...BUNDLE_ZIP_LIMITS, maxEntryBytes: 1000, maxTotalBytes: 2000 });
  assert.equal(out.get("a.md")!.length, 1000);
  assert.equal(out.get("b.md")!.length, 1000);
  assert.throws(() => readZip(zip, { ...BUNDLE_ZIP_LIMITS, maxEntryBytes: 1000, maxTotalBytes: 1999 }), ZipFormatError);
});

test("A5 내용 한 바이트가 바뀐 파일은 거절한다", () => {
  const data = randomBytes(256); // 압축 안 되는 바이트 → 저장 방식이라 위치가 정해진다
  const zip = writeZip([{ path: "a.md", data }]);
  const broken = Buffer.from(zip);
  broken[30 + "a.md".length + 10] ^= 0xff; // 로컬 헤더(30) + 이름 뒤 = 내용
  assert.throws(() => readZip(broken), ZipFormatError);
});

test("A6 항목 수가 상한과 같으면 허용, 넘으면 거절한다", () => {
  const zip = writeZip(Array.from({ length: 5 }, (_, i) => ({ path: `k/${i}.md`, data: Buffer.from(String(i)) })));
  assert.equal(readZip(zip, { ...BUNDLE_ZIP_LIMITS, maxEntries: 5 }).size, 5);
  assert.throws(() => readZip(zip, { ...BUNDLE_ZIP_LIMITS, maxEntries: 4 }), ZipFormatError);
});

test("A7 잘린 파일과 zip 이 아닌 바이트는 거절한다", () => {
  const zip = writeZip([{ path: "a.md", data: Buffer.from("hello world") }]);
  assert.throws(() => readZip(zip.subarray(0, zip.length - 30)), ZipFormatError);
  assert.throws(() => readZip(Buffer.from("not a zip at all")), ZipFormatError);
  assert.equal(looksLikeZip(Buffer.from("not a zip")), false);
});

test("A8 항목이 0개인 zip 은 빈 결과다", () => {
  const zip = writeZip([]);
  assert.equal(readZip(zip).size, 0);
});
