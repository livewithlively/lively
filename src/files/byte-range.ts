// 파일 응답의 바이트 구간(HTTP Range, RFC 9110 §14) — 미리보기에 크기 상한을 두지 않기 위한 한 자리(#5480).
//
// ── 왜 ─────────────────────────────────────────────────────────────────────────────────
//  종전엔 미리보기 API 가 25MB 를 넘는 파일에 413 «미리보기엔 너무 큽니다» 를 돌려줬다. 그런데 응답은 원래 **스트리밍**이라
//   게이트웨이 메모리와 무관했고, 상한이 실제로 막은 것은 사람이 파일을 보는 일뿐이었다(26MB 데모 영상이 «읽지 못했어요»).
//  상한을 걷어 내면 남는 문제는 «큰 영상·소리를 다 받기 전에 틀 수 있나» 다 — 그게 Range 다. <video src> 는 앞부분과
//   moov 상자를 구간으로 받아 바로 틀고, 사람이 뒤로 건너뛰면 그 자리만 받는다. 1GB 영상도 첫 화면까지 몇 MB 면 된다.
//
// ── 무엇을 받나 ───────────────────────────────────────────────────────────────────────────
//  단일 구간만 — `bytes=a-b` · `bytes=a-` · `bytes=-n`(끝에서 n). 여러 구간(`a-b,c-d`)은 multipart 응답이 필요한데
//   브라우저 미디어 요소는 그걸 보내지 않는다 → 무시하고 전체(200)로 답한다(표준이 허용하는 답이다).
//  문법이 틀린 머리도 무시(200 전체) — 표준이 그렇게 하라고 한다. 시작이 파일 끝 이상이면 416.
'use strict';

export type ByteRange = { start: number; end: number };   // 양끝 포함(end = 마지막 바이트 위치)

/** Range 머리 → 구간. null = 머리 없음·해석 불가·여러 구간(전체 200 으로 답한다). "unsatisfiable" = 416. */
export function parseByteRange(header: unknown, size: number): ByteRange | null | "unsatisfiable" {
  if (typeof header !== "string") return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null;                               // 여러 구간·다른 단위·문법 오류 — 무시
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") {                                    // 끝에서 n 바이트
    const n = Number(b);
    if (!Number.isSafeInteger(n)) return null;
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (!Number.isSafeInteger(start)) return null;
  if (start >= size) return "unsatisfiable";
  let end = b === "" ? size - 1 : Number(b);
  if (!Number.isSafeInteger(end)) return null;
  if (end < start) return null;                      // 뒤집힌 구간은 문법 오류 — 무시
  if (end > size - 1) end = size - 1;
  return { start, end };
}

/** 응답 머리(+상태)를 정한다 — 부르는 쪽은 돌려받은 range 가 있으면 그 구간만, 없으면 전부 흘린다.
 *  416 이면 { status: 416 } 만 돌려준다(본문 없이 끝낸다). */
export function rangeResponse(header: unknown, size: number):
  { status: 200 | 206; range: ByteRange | null; headers: Record<string, string> } | { status: 416; headers: Record<string, string> } {
  const r = parseByteRange(header, size);
  if (r === "unsatisfiable") return { status: 416, headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" } };
  if (!r) return { status: 200, range: null, headers: { "Accept-Ranges": "bytes", "Content-Length": String(size) } };
  return {
    status: 206, range: r,
    headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${r.start}-${r.end}/${size}`, "Content-Length": String(r.end - r.start + 1) },
  };
}

// 확장자 → 미리보기 Content-Type. 브라우저 미디어 요소·PDF 뷰어·그림이 **주소를 바로** 열 때 이 값으로 판정한다
//  (blob 으로 받던 종전엔 화면이 타입을 붙였다). 모르는 확장자는 octet-stream — 화면이 바이트로 다시 본다.
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
  heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff",
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8", json: "application/json; charset=utf-8", log: "text/plain; charset=utf-8",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", ogv: "video/ogg", mkv: "video/x-matroska",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  opus: "audio/ogg", flac: "audio/flac", weba: "audio/webm",
};
export function previewContentType(name: string): string {
  const i = name.lastIndexOf(".");
  const ext = i >= 0 ? name.slice(i + 1).toLowerCase() : "";
  return MIME[ext] || "application/octet-stream";
}
