// 수집 첨부의 크기 상한 · 디스크 여유 하한(#5012).
//
//  ★ 왜: 셀프호스트 박스는 디스크가 차면 DB 와 게이트웨이가 함께 멈춘다. 위시스트 실측(2026-10-26): 노션 첨부
//   15,022개 중 2,300개를 받는 데 5.03GB — 그중 **50MB 를 넘는 11개(0.5%)가 3.73GB(74%)** 였다(동영상·큰 pptx).
//   같은 비율이면 전부 받는 데 약 35GB 로, 38GB 디스크의 남은 16GB 를 넘는다. 동영상은 증류도 검색도 읽지 못해
//   맥락 가치가 낮고, 맥락에 쓰이는 캡처·PDF 는 대부분 1MB 안쪽(중간값 0.08MB)이다.
//   그래서 두 겹으로 막는다 — 파일당 상한(수집기 설정 · 기본 50MB)과, 받은 뒤 남을 공간이 하한 아래면 받지 않기.
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_ASSET_MAX_MB = 50;
/** 디스크 여유 하한 — 전체의 15% 와 5GiB 중 큰 쪽. 38GB 박스면 5.7GB, 100GB 면 15GB 를 남긴다. */
export const DISK_FLOOR_RATIO = 0.15;
export const DISK_FLOOR_MIN_BYTES = 5 * 1024 ** 3;

/** 수집기 설정 «첨부 크기 상한(MB)» → 바이트. 비었거나 숫자가 아니거나 0 이하면 기본값. */
export function assetMaxBytes(v: unknown): number {
  const n = Number(String(v ?? "").trim());
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_ASSET_MAX_MB) * 1024 * 1024;
}

export function diskFloorBytes(totalBytes: number): number {
  return Math.max(DISK_FLOOR_MIN_BYTES, Math.floor(totalBytes * DISK_FLOOR_RATIO));
}

export type StatFs = (dir: string) => { bsize: number; blocks: number; bavail: number };
/** need 바이트를 더 쓴 뒤에도 하한이 남나. 디스크를 못 재면(지원 안 되는 파일시스템) 막지 않는다 — 상한이 여전히 지킨다. */
export function diskRoom(dir: string, needBytes: number, statfs: StatFs = fs.statfsSync): { ok: boolean; freeBytes: number; floorBytes: number } {
  try {
    const s = statfs(dir);
    const free = s.bavail * s.bsize;
    const floor = diskFloorBytes(s.blocks * s.bsize);
    return { ok: free - Math.max(0, needBytes) >= floor, freeBytes: free, floorBytes: floor };
  } catch {
    return { ok: true, freeBytes: NaN, floorBytes: NaN };
  }
}

export type SkipReason = "too_large" | "disk_floor";
/** 받지 않은 첨부 — 크기 상한이나 디스크 하한에 걸렸다. 재시도할 실패가 아니다(커서를 묶지 않는다). */
export class AssetSkip extends Error {
  constructor(readonly reason: SkipReason, readonly bytes: number | null, readonly maxBytes: number) {
    super(reason === "too_large"
      ? `첨부가 크기 상한(${fmtBytes(maxBytes)})을 넘어 받지 않았습니다${bytes ? ` — 실제 ${fmtBytes(bytes)}` : ""}`
      : `디스크 여유가 하한 아래로 내려가 첨부를 받지 않았습니다${bytes ? ` — 이 파일 ${fmtBytes(bytes)}` : ""}`);
  }
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)}MB`;
  return `${Math.max(1, Math.round(n / 1024))}KB`;
}

// 건너뜀 표시 — 받지 않은 첨부 자리에 남긴다. 본문은 이미 그 주소를 가리키고 있어서(방출이 다운로드보다 먼저다)
//  ① 화면이 그 주소를 열면 «왜 없는지» 를 보여 주고 ② 가속 full 이 «첨부가 디스크에 없다» 며 페이지를 매번 다시
//  긁지 않게 한다(traverse.ts 의 assetsOk). 디스크 하한으로 건너뛴 것은 표시를 남기지 않는다 — 공간이 생기면 다시 받아야 한다.
export const SKIP_SUFFIX = ".skipped.json";
export interface SkipInfo { reason: SkipReason; bytes: number | null; maxBytes: number; source?: string | null; at: string }

export function writeSkipMarker(dir: string, file: string, s: AssetSkip, source?: string | null): void {
  if (s.reason !== "too_large") return;
  const info: SkipInfo = { reason: s.reason, bytes: s.bytes, maxBytes: s.maxBytes, source: source ?? null, at: new Date().toISOString() };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file + SKIP_SUFFIX), JSON.stringify(info));
}

export function readSkipMarker(dir: string, file: string): SkipInfo | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, file + SKIP_SUFFIX), "utf8")) as SkipInfo; }
  catch { return null; }
}

/** 첨부가 «있는 셈» 인가 — 파일이 있거나, 크기 상한으로 일부러 안 받았다. */
export function assetSettled(dir: string, file: string): boolean {
  try { return fs.existsSync(path.join(dir, file)) || fs.existsSync(path.join(dir, file + SKIP_SUFFIX)); }
  catch { return false; }
}

/** 화면에 보일 안내 — 받지 않은 이유와 원본 위치. */
export function skipNotice(info: SkipInfo): string {
  const why = info.reason === "too_large"
    ? `이 첨부는 크기 상한(${fmtBytes(info.maxBytes)})을 넘어 라이블리에 받아 두지 않았습니다${info.bytes ? `(실제 ${fmtBytes(info.bytes)})` : ""}.`
    : "디스크 여유가 부족해 이 첨부를 받아 두지 않았습니다.";
  return info.source ? `${why}\n원본: ${info.source}\n` : `${why}\n원본 앱에서 확인해 주세요.\n`;
}
