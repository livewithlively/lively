// HEIC·미리보기 변환 — 실제 HEIC 파일(libheif 저장소의 72×72 표본)을 디코드한다. 워커 경로까지 태운다.
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { MAX_PIXELS, shrinkToRgba } from "./image-transform-core.js";
import { imageFormatOf, renderImage } from "./image-transform.js";
import { readableArtifact } from "../v6/source-artifact.js";

const t = async (name: string, f: () => Promise<void> | void): Promise<void> => {
  try { await f(); console.log(`ok - ${name}`); } catch (e) { console.error(`not ok - ${name}`); throw e; }
};

const HEIC = Buffer.from("AAAAGGZ0eXBoZWljAAAAAG1pZjFoZWljAAAB/W1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAADnBpdG0AAAAAAAEAAAA0aWxvYwAAAABEQAACAAEAAAAAAh0AAQAAAAAAAAE7AAIAAAAAA1gAAQAAAAAAAADnAAAAOGlpbmYAAAAAAAIAAAAVaW5mZQIAAAAAAQAAaHZjMQAAAAAVaW5mZQIAAAAAAgAAaHZjMQAAAAE8aXBycAAAARppcGNvAAAAdWh2Y0MBA3AAAAAAAAAAAAAe8AD8/fj4AAAPAyAAAQAYQAEMAf//A3AAAAMAkAAAAwAAAwAeugJAIQABAChCAQEDcAAAAwCQAAADAAADAB6gJIEllupJKa5sCAAAAwAIAAADAAhAIgABAAdEAcFysCJAAAAAFGlzcGUAAAAAAAAASAAAAEgAAAB1aHZjQwEDcAAAAAAAAAAAAB7wAPz9+PgAAA8DIAABABhAAQwB//8DcAAAAwCQAAADAAADAB66AkAhAAEAKEIBAQNwAAADAJAAAAMAAAMAHqAggQWW6kkprmwIAAADAAgAAAMACEAiAAEAB0QBwXKwIkAAAAAUaXNwZQAAAAAAAABAAAAAQAAAABppcG1hAAAAAAAAAAIAAQKBAgACAoMEAAAAGmlyZWYAAAAAAAAADnRobWIAAgABAAEAAAIqbWRhdAAAATcmAa8TgHzRVjrk1HaANdypZonm/zPoN58h9E1bL19iT1jq3e/QdKdE9lIk9TqThuU/pIvSe+ObymVAZa4VDE1SZWDjQPEBhHSfTXOvuBulzdLA36fL3Ng5meoAl6TYBMDH4ifjh7wBZsaaq1nfoHl+VxHLZ0ACoHJn2zAPApAgEChXcdGDroYTlg7a+jSx+EwXi835LqQ2+p3yyhX0Vxt7H2/UDDzeWhRvCmBEzNevIwPE5XSQyl7AHsVdLauVXgWSSJ0mWf8qCgrt1B4+Eyzg4pO6zbtQA8yfKsIO0ukWp9QG2fI9m0faFgBizYcLVp8ZTjERMw9Qv5jpveLp4FzGkcTI5aI0/dydnmST3LIqDlAkkkHQ2Afmf1IEnZF2fa5nDuB3UJZPyyEVhF6eSomujCZ8WrOO0AAAAOMmAa8TgIMpsS84GZqspb6oE5A0hqRRlPOuVuFwr+3Jh4Fx9D1yqOv1Itypvf51jFlv9xMLybUeTlb4TDUCVw0Ec/R/Zqiqgw5K/fUze4YNGRaYFkJyY6qc8MWy6FKc0OAJ6HHyMx6Y4Q9nT4Rrd1LkdvaOxdjZyPxmE7ndpYpsVmJQLmSEy3o7J+KPt+AF4T43Os+8LZ4FfvgfxwH9N2viWDHj8+HGkkxei3dLKXSkSWFtc/IFXgqHCMLTeZ/Aav+kstMiXIEWPPXwg66NqpQ2fFoi/ofFPbX0FbRGMk/+J2cHgA==", "base64");
function png(w: number, h: number, rgba: [number, number, number, number]): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < p.data.length; i += 4) p.data.set(rgba, i);
  return PNG.sync.write(p);
}
const isJpeg = (b: Uint8Array): boolean => b[0] === 0xff && b[1] === 0xd8;
const dir = await mkdtemp(path.join(tmpdir(), "img-"));
const art = async (name: string, bytes: Buffer, mime: string) => {
  const p = path.join(dir, name);
  await writeFile(p, bytes);
  return { path: p, mime, bytes: bytes.length, expires_at: "2099-01-01T00:00:00.000Z" };
};

await t("MIME → 형식: 변환 가능한 것만", () => {
  assert.equal(imageFormatOf("image/heic"), "heic");
  assert.equal(imageFormatOf("IMAGE/HEIF"), "heic");
  assert.equal(imageFormatOf("image/png"), "png");
  assert.equal(imageFormatOf("image/jpeg; charset=x"), "jpeg");
  assert.equal(imageFormatOf("image/gif"), null);
  assert.equal(imageFormatOf("application/pdf"), null);
});

await t("HEIC → JPEG (워커)", async () => {
  const r = await renderImage(HEIC, "heic", 2048);
  assert.ok(isJpeg(r.bytes));
  assert.equal(r.srcWidth, 72);
  assert.equal(r.width, 72);   // 작은 원본을 키우지 않는다
});

await t("미리보기: 긴 변 기준 축소 · 비율 유지", async () => {
  const r = await renderImage(png(2000, 1000, [10, 20, 30, 255]), "png", 768);
  assert.deepEqual([r.width, r.height, r.srcWidth], [768, 384, 2000]);
  const d = jpeg.decode(Buffer.from(r.bytes));
  assert.deepEqual([d.width, d.height], [768, 384]);
});

await t("투명 PNG 는 흰 바탕에 합성(검게 뭉개지지 않는다)", () => {
  const s = shrinkToRgba({ width: 4, height: 4, data: new Uint8Array(16 * 4) }, 2);
  assert.deepEqual([...s.data.subarray(0, 4)], [255, 255, 255, 255]);
});

await t("거대 PNG 는 픽셀 버퍼 전에 거절", async () => {
  const b = png(1, 1, [0, 0, 0, 255]);
  b.writeUInt32BE(Math.ceil(Math.sqrt(MAX_PIXELS)) + 1, 16);
  b.writeUInt32BE(Math.ceil(Math.sqrt(MAX_PIXELS)) + 1, 20);
  await assert.rejects(renderImage(b, "png", 768), /너무 큽니다/);
});

await t("깨진 파일 뒤에도 다음 변환이 돈다(대기열이 안 막힌다)", async () => {
  await assert.rejects(renderImage(Buffer.from("not a heic"), "heic", 768));
  assert.ok(isJpeg((await renderImage(HEIC, "heic", 768)).bytes));
});

await t("readableArtifact: PNG 는 preview 없으면 원본 그대로", async () => {
  const a = await art("a.png", png(10, 10, [1, 2, 3, 255]), "image/png");
  assert.deepEqual(await readableArtifact(a, {}), a);
});

await t("readableArtifact: PNG preview → 작은 JPEG 경로", async () => {
  const a = await art("b.png", png(1600, 800, [1, 2, 3, 255]), "image/png");
  const r = await readableArtifact(a, { preview: true });
  assert.notEqual(r.path, a.path);
  assert.equal(r.mime, "image/jpeg");
  assert.equal(r.preview, true);
  assert.equal(r.original_bytes, a.bytes);
  assert.ok(isJpeg(await readFile(r.path)));
});

await t("readableArtifact: HEIC 는 preview 없어도 JPEG 로(본문 읽기)", async () => {
  const r = await readableArtifact(await art("c.heic", HEIC, "image/heic"), {});
  assert.equal(r.mime, "image/jpeg");
  assert.equal(r.preview, undefined);
  assert.ok(isJpeg(await readFile(r.path)));
});

await t("readableArtifact: 깨진 HEIC 는 throw(그 자료 skip) · 깨진 PNG 미리보기는 원본으로 물러선다", async () => {
  await assert.rejects(readableArtifact(await art("d.heic", Buffer.from("xx"), "image/heic"), {}), /HEIC 변환 실패/);
  const a = await art("e.png", Buffer.from("xx"), "image/png");
  const r = await readableArtifact(a, { preview: true });
  assert.equal(r.path, a.path);
  assert.ok(r.preview_error);
});

await t("readableArtifact: PDF·GIF 는 preview 를 청해도 원본", async () => {
  const a = await art("f.pdf", Buffer.from("%PDF"), "application/pdf");
  assert.deepEqual(await readableArtifact(a, { preview: true }), a);
});
