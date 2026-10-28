// 첨부 크기 상한 · 디스크 하한 · 건너뜀 표시(#5012) — 사양 표 C1~C7.
//  실행: npm run build && node dist/connectors/asset-limits.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AssetSkip, assetMaxBytes, assetSettled, diskFloorBytes, diskRoom, readSkipMarker, skipNotice, writeSkipMarker,
  DEFAULT_ASSET_MAX_MB, DISK_FLOOR_MIN_BYTES,
} from "./asset-limits.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const MB = 1024 ** 2, GB = 1024 ** 3;
/** 가짜 디스크 — 전체·남은 바이트(블록 1바이트). */
const disk = (total: number, free: number) => () => ({ bsize: 1, blocks: total, bavail: free });

t("C1 상한 설정이 비었거나 숫자가 아니거나 0 이하면 기본 50MB", () => {
  for (const v of [undefined, "", "  ", "abc", "0", "-5", null]) assert.equal(assetMaxBytes(v), DEFAULT_ASSET_MAX_MB * MB, String(v));
  assert.equal(DEFAULT_ASSET_MAX_MB, 50);
});
t("C2 상한 설정값을 MB 로 읽는다(소수 포함)", () => {
  assert.equal(assetMaxBytes("100"), 100 * MB);
  assert.equal(assetMaxBytes(" 0.5 "), 0.5 * MB);
});
t("C3 하한 = 전체의 15% 와 5GB 중 큰 쪽", () => {
  assert.equal(diskFloorBytes(38 * GB), Math.floor(38 * GB * 0.15));
  assert.equal(diskFloorBytes(10 * GB), DISK_FLOOR_MIN_BYTES);
  assert.equal(diskFloorBytes(100 * GB), 15 * GB);
});
t("C4 받은 뒤 남는 공간이 하한과 정확히 같으면 받고, 1바이트 모자라면 안 받는다", () => {
  const total = 100 * GB, floor = 15 * GB, need = 30 * MB;
  assert.equal(diskRoom("/x", need, disk(total, floor + need)).ok, true);
  assert.equal(diskRoom("/x", need, disk(total, floor + need - 1)).ok, false);
  assert.equal(diskRoom("/x", 0, disk(total, floor - 1)).ok, false, "크기를 몰라도(0) 이미 하한 아래면 안 받는다");
});
t("C5 디스크를 못 재면 막지 않는다(상한이 여전히 지킨다)", () => {
  assert.equal(diskRoom("/x", 10 * MB, () => { throw new Error("ENOSYS"); }).ok, true);
});
t("C6 크기 상한으로 건너뛴 첨부는 표시가 남아 «있는 셈» 이고, 안내에 원본·크기가 있다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asset-limits-"));
  assert.equal(assetSettled(dir, "a.mp4"), false);
  writeSkipMarker(dir, "a.mp4", new AssetSkip("too_large", 1800 * MB, 50 * MB), "https://www.notion.so/abc");
  assert.equal(fs.existsSync(path.join(dir, "a.mp4")), false, "본 파일은 만들지 않는다");
  assert.equal(assetSettled(dir, "a.mp4"), true, "표시가 있으면 가속 full 이 그 페이지를 매번 다시 긁지 않는다");
  const info = readSkipMarker(dir, "a.mp4");
  assert.ok(info);
  const note = skipNotice(info);
  assert.ok(note.includes("https://www.notion.so/abc") && note.includes("50MB") && note.includes("1.8GB"), note);
  fs.writeFileSync(path.join(dir, "b.png"), "x");
  assert.equal(assetSettled(dir, "b.png"), true, "파일이 있으면 당연히 있는 셈");
  fs.rmSync(dir, { recursive: true, force: true });
});
t("C7 디스크 하한으로 건너뛴 첨부는 표시를 남기지 않는다 — 공간이 생기면 다시 받아야 한다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asset-limits-"));
  writeSkipMarker(dir, "c.pdf", new AssetSkip("disk_floor", 10 * MB, 50 * MB), "https://www.notion.so/def");
  assert.equal(assetSettled(dir, "c.pdf"), false);
  assert.equal(readSkipMarker(dir, "c.pdf"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
console.log(`\n${pass} passed (asset limits)`);
