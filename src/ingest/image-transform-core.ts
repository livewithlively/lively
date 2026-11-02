// 그림 → 작은 JPEG 순수 변환 — AI 가 읽을 수 있는 꼴로 바꾼다.
//  · HEIC: 아이폰 원본 형식. Claude Read 가 못 읽으니 JPEG 로 바꿔야 내용을 볼 수 있다.
//  · 미리보기: 파일명으로 값어치를 모르는 사진을 작게 한 번 본다(토큰은 화소 수에 비례 — 실측 평균 1,200 → 450).
//  순수 JS·WASM 만 쓴다: sharp 프리빌트에는 HEVC 디코더가 없고, 네이티브 의존을 늘리지 않는다.
import { createRequire } from "node:module";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

const require = createRequire(import.meta.url);

export const MAX_PIXELS = 100_000_000;   // 압축 폭탄 방어 — 1억 화소 위로는 디코드하지 않는다(jpeg-js 기본 상한과 같다).
const JPEG_QUALITY = 72;

export type ImageFormat = "heic" | "png" | "jpeg";
export interface RenderInput { bytes: Uint8Array; format: ImageFormat; maxEdge: number }
export interface RenderOutput { bytes: Uint8Array; width: number; height: number; srcWidth: number; srcHeight: number }
interface Raster { width: number; height: number; data: Uint8Array | Buffer | Uint8ClampedArray }

function assertPixels(w: number, h: number): void {
  if (!w || !h || w * h > MAX_PIXELS) throw new Error(`그림이 너무 큽니다(${w}×${h})`);
}

// PNG 는 IHDR 에 크기가 있다 — 픽셀 버퍼를 잡기 전에 거른다.
function pngSize(b: Buffer): { w: number; h: number } {
  if (b.length < 24) throw new Error("PNG 머리가 잘렸습니다");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

async function decodeRaster(buf: Buffer, format: ImageFormat): Promise<Raster> {
  if (format === "png") {
    const { w, h } = pngSize(buf);
    assertPixels(w, h);
    return PNG.sync.read(buf);
  }
  if (format === "jpeg") return jpeg.decode(buf, { useTArray: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 1024 });
  const decode = require("heic-decode") as (o: { buffer: Buffer }) => Promise<Raster>;
  const r = await decode({ buffer: buf });
  assertPixels(r.width, r.height);
  return r;
}

/** 면적 평균 축소 + 흰 바탕 합성. 스크린샷의 글자가 최근접 축소보다 덜 뭉개진다. 원본이 작으면 키우지 않는다. */
export function shrinkToRgba(src: Raster, maxEdge: number): { width: number; height: number; data: Buffer } {
  const { width: w, height: h, data: d } = src;
  const s = Math.min(1, maxEdge / Math.max(w, h));
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor((y * h) / H), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor((x * w) / W), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / W));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * 4, a = d[i + 3], bg = 255 - a;
          r += (d[i] * a) / 255 + bg; g += (d[i + 1] * a) / 255 + bg; b += (d[i + 2] * a) / 255 + bg; n++;
        }
      }
      const o = (y * W + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };
}

export async function renderJpeg({ bytes, format, maxEdge }: RenderInput): Promise<RenderOutput> {
  const src = await decodeRaster(Buffer.from(bytes), format);
  const small = shrinkToRgba(src, maxEdge);
  const encoded = jpeg.encode(small, JPEG_QUALITY).data;
  return { bytes: new Uint8Array(encoded), width: small.width, height: small.height, srcWidth: src.width, srcHeight: src.height };
}
