// 그림 변환 입구 — 워커 하나씩만 돌린다. 증류 세션이 사진을 연달아 열어도 게이트웨이의 CPU 를 다 먹지 않게 한다.
import { Worker } from "node:worker_threads";
import type { ImageFormat, RenderOutput } from "./image-transform-core.js";

export const PREVIEW_MAX_EDGE = 768;     // 값어치 판정용 — 실측 표본에서 화면 글자가 읽히고 종류가 가려졌다.
export const HEIC_READ_MAX_EDGE = 2048;  // HEIC 본문 읽기용 — 모델 입력 상한(긴 변 1568px)보다 크게 둔다.
const TIMEOUT_MS = 30_000;

/** MIME → 변환할 수 있는 형식. GIF·WEBP 는 디코더가 없어 null(원본을 그대로 쓴다 — Claude 가 직접 읽는다). */
export function imageFormatOf(mime: string): ImageFormat | null {
  const m = mime.toLowerCase().split(";")[0].trim();
  if (m === "image/heic" || m === "image/heif") return "heic";
  if (m === "image/png") return "png";
  if (m === "image/jpeg" || m === "image/jpg") return "jpeg";
  return null;
}

function runWorker(bytes: Uint8Array, format: ImageFormat, maxEdge: number): Promise<RenderOutput> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./image-transform-worker.js", import.meta.url), { workerData: { bytes, format, maxEdge } });
    const timer = setTimeout(() => { void w.terminate(); reject(new Error(`그림 변환 시간 초과(${TIMEOUT_MS / 1000}초)`)); }, TIMEOUT_MS);
    w.once("message", (m: { ok: true } & RenderOutput | { ok: false; error: string }) => {
      clearTimeout(timer);
      void w.terminate();
      if (m.ok) resolve(m); else reject(new Error(m.error));
    });
    w.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

let tail: Promise<unknown> = Promise.resolve();
export function renderImage(bytes: Uint8Array, format: ImageFormat, maxEdge: number): Promise<RenderOutput> {
  const job = tail.then(() => runWorker(bytes, format, maxEdge));
  tail = job.catch(() => undefined);
  return job;
}
