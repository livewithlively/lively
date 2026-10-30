import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseAppSource, stageAppSource, normalizeInlinePath, decodeInlineFiles, INLINE_MAX_FILES, INLINE_MAX_BYTES } from "./install-source.js";
import { loadAppPackage } from "./loader.js";

// #4224 — inline 소스: 세션이 만든 파일 묶음을 요청 본문으로 받아 설치한다(매니지드 게이트웨이는 세션 폴더를 못 읽는다).
//  「입력 × 기대」 엣지 표 — 경로 탈출·중복·상한·매니페스트 누락·인코딩, 그리고 스테이지가 로더로 그대로 읽히는지.

const MANIFEST = JSON.stringify({
  id: "probe-app", title: "시험 앱", version: "0.1.0",
  permissions: { tools: ["store_insert", "store_query"] },
  data: { tables: [{ name: "notes", columns: [{ name: "body", type: "text" }] }] },
  ui: { pages: [{ key: "main", title: "시험", entry: "ui/index.html" }] },
});
const HTML = "<!doctype html><meta charset=utf-8><title>시험</title><p>안녕</p>";

test("normalizeInlinePath — 패키지 안 상대경로로 정규화", () => {
  assert.equal(normalizeInlinePath("lively-app.json"), "lively-app.json");
  assert.equal(normalizeInlinePath("./ui//index.html"), "ui/index.html");
  assert.equal(normalizeInlinePath(" skills/greet/SKILL.md "), "skills/greet/SKILL.md");
});

test("normalizeInlinePath — 탈출·절대경로·역슬래시·NUL·.git·빈 경로 거부", () => {
  for (const bad of ["../x", "ui/../../x", "/etc/passwd", "C:/x", "ui\\x", "a\0b", ".git/config", "a/.git/x", "", "  ", "./", "a/".repeat(17) + "x"]) {
    assert.throws(() => normalizeInlinePath(bad), /inline 파일/, JSON.stringify(bad));
  }
});

test("decodeInlineFiles — utf8·base64 디코드", () => {
  const out = decodeInlineFiles([
    { path: "lively-app.json", content: MANIFEST },
    { path: "img/dot.bin", content: Buffer.from([0, 1, 2, 255]).toString("base64"), encoding: "base64" },
  ]);
  assert.equal(out[0].bytes.toString("utf8"), MANIFEST);
  assert.deepEqual([...out[1].bytes], [0, 1, 2, 255]);
});

test("decodeInlineFiles — 비었거나·매니페스트 없음·중복(정규화 뒤)·content 없음·모르는 encoding 거부", () => {
  assert.throws(() => decodeInlineFiles([]), /files/);
  assert.throws(() => decodeInlineFiles(undefined), /files/);
  assert.throws(() => decodeInlineFiles([{ path: "ui/index.html", content: HTML }]), /lively-app\.json/);
  assert.throws(() => decodeInlineFiles([{ path: "lively-app.json", content: MANIFEST }, { path: "./lively-app.json", content: "{}" }]), /중복/);
  assert.throws(() => decodeInlineFiles([{ path: "lively-app.json" }]), /content/);
  assert.throws(() => decodeInlineFiles([{ path: "lively-app.json", content: MANIFEST, encoding: "hex" }]), /encoding/);
});

test("decodeInlineFiles — 개수·크기 상한", () => {
  const many = Array.from({ length: INLINE_MAX_FILES + 1 }, (_, i) => ({ path: `f${i}.txt`, content: "x" }));
  assert.throws(() => decodeInlineFiles(many), /너무 많습니다/);
  const big = [{ path: "lively-app.json", content: MANIFEST }, { path: "big.txt", content: "x".repeat(INLINE_MAX_BYTES) }];
  assert.throws(() => decodeInlineFiles(big), /너무 큽니다/);
});

test("parseAppSource — inline 은 stage 전에 검증한다(나쁜 경로면 400)", () => {
  const ok = parseAppSource({ kind: "inline", files: [{ path: "lively-app.json", content: MANIFEST }] });
  assert.equal(ok.kind, "inline");
  assert.throws(() => parseAppSource({ kind: "inline", files: [{ path: "../lively-app.json", content: MANIFEST }] }), /'\.\.'/);
  assert.throws(() => parseAppSource({ kind: "inline" }), /files/);
});

test("stageAppSource(inline) — 임시 폴더에 풀고, 로더가 그대로 읽고, cleanup 이 지운다", async () => {
  const src = parseAppSource({ kind: "inline", files: [
    { path: "lively-app.json", content: MANIFEST },
    { path: "ui/index.html", content: HTML },
    { path: "skills/greet/SKILL.md", content: "---\nname: greet\n---\n인사한다" },
  ] });
  const staged = await stageAppSource(src);
  try {
    assert.equal(await readFile(path.join(staged.dir, "ui/index.html"), "utf8"), HTML);
    // 출처 기록엔 내용 없이 모양만 — org_app.source 가 부풀지 않게.
    assert.deepEqual(staged.meta, { kind: "inline", files: 3, bytes: Buffer.byteLength(MANIFEST) + Buffer.byteLength(HTML) + Buffer.byteLength("---\nname: greet\n---\n인사한다") });
    const loaded = await loadAppPackage(staged.dir);
    assert.equal(loaded.manifest.id, "probe-app");
    assert.equal(loaded.uiAssets[0]?.html, HTML);
    assert.ok(loaded.items.some((it) => it.comp.kind === "harness_asset" && it.comp.orig_name === "greet"));
    assert.ok(loaded.items.some((it) => it.comp.kind === "data_table" && it.comp.ref === "notes"));
  } finally {
    await staged.cleanup();
  }
  assert.equal(existsSync(staged.dir), false);
});

test("stageAppSource(inline) — 같은 내용이면 content_hash 가 같다(재설치 판정이 흔들리지 않게)", async () => {
  const files = [{ path: "lively-app.json", content: MANIFEST }, { path: "ui/index.html", content: HTML }];
  const a = await stageAppSource(parseAppSource({ kind: "inline", files }));
  const b = await stageAppSource(parseAppSource({ kind: "inline", files: [...files].reverse() }));
  try {
    assert.equal((await loadAppPackage(a.dir)).contentHash, (await loadAppPackage(b.dir)).contentHash);
  } finally { await a.cleanup(); await b.cleanup(); }
});

test("stageAppSource(inline) — 파일과 같은 이름의 폴더가 겹치면 400 으로 거부하고 임시 폴더를 남기지 않는다", async () => {
  const src = parseAppSource({ kind: "inline", files: [
    { path: "lively-app.json", content: MANIFEST }, { path: "ui", content: "x" }, { path: "ui/index.html", content: HTML },
  ] });
  await assert.rejects(() => stageAppSource(src), /inline 파일을 풀지 못했습니다/);
});
