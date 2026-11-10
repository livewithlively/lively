import { strict as assert } from "node:assert";
import test from "node:test";
import { parseByteRange, rangeResponse, previewContentType } from "./byte-range.js";

// #5480 — 미리보기 상한 대신 구간 응답. 사양 표(입력 × 기대) 한 행 = 한 단정.
const SIZE = 1000;
const rows: Array<[string | undefined, ReturnType<typeof parseByteRange>]> = [
  [undefined, null],                                 // 머리 없음 → 전체
  ["bytes=0-99", { start: 0, end: 99 }],             // 앞 100
  ["bytes=0-", { start: 0, end: 999 }],              // 열린 끝(크롬 <video> 의 첫 요청)
  ["bytes=900-", { start: 900, end: 999 }],
  ["bytes=-100", { start: 900, end: 999 }],          // 끝에서 100(moov 상자 찾기)
  ["bytes=-1000", { start: 0, end: 999 }],           // 경계: 끝에서 n == 크기
  ["bytes=-5000", { start: 0, end: 999 }],           // 끝에서 n 이 크기보다 크면 전체
  ["bytes=500-5000", { start: 500, end: 999 }],      // 끝이 넘치면 마지막 바이트로
  ["bytes=999-999", { start: 999, end: 999 }],       // 경계: 마지막 한 바이트
  ["bytes=999-", { start: 999, end: 999 }],          // 경계: 시작 == 크기-1
  ["bytes=1000-", "unsatisfiable"],                  // 경계: 시작 == 크기 → 416
  ["bytes=-0", "unsatisfiable"],
  ["bytes=5-1", null],                               // 뒤집힌 구간 → 무시(전체)
  ["bytes=0-1,5-9", null],                           // 여러 구간 → 무시(전체)
  ["items=0-9", null],                               // 다른 단위 → 무시
  ["bytes=abc", null],
  ["bytes=-", null],
];
for (const [h, want] of rows) {
  test(`parseByteRange ${JSON.stringify(h)} → ${JSON.stringify(want)}`, () => {
    assert.deepEqual(parseByteRange(h, SIZE), want);
  });
}

test("빈 파일 — 어떤 구간이든 416, 머리 없음은 전체", () => {
  assert.equal(parseByteRange("bytes=-10", 0), "unsatisfiable");
  assert.equal(parseByteRange("bytes=0-", 0), "unsatisfiable");
  assert.equal(parseByteRange(undefined, 0), null);
});

test("rangeResponse — 206 머리(Content-Range · Content-Length) · 200 도 Accept-Ranges · 416 은 */size", () => {
  const p = rangeResponse("bytes=10-19", SIZE);
  assert.equal(p.status, 206);
  assert.equal(p.headers["Content-Range"], "bytes 10-19/1000");
  assert.equal(p.headers["Content-Length"], "10");
  const f = rangeResponse(undefined, SIZE);
  assert.equal(f.status, 200);
  assert.equal(f.headers["Accept-Ranges"], "bytes");    // 브라우저 미디어 요소·화면의 canStream 이 이 머리를 본다
  assert.equal(f.headers["Content-Length"], "1000");
  const u = rangeResponse("bytes=2000-", SIZE);
  assert.equal(u.status, 416);
  assert.equal(u.headers["Content-Range"], "bytes */1000");
});

test("previewContentType — 영상·소리·PDF 는 제 형식(주소로 바로 열리게), 모르면 octet-stream", () => {
  assert.equal(previewContentType("/a/데모.MP4"), "video/mp4");
  assert.equal(previewContentType("x.mov"), "video/quicktime");
  assert.equal(previewContentType("x.mp3"), "audio/mpeg");
  assert.equal(previewContentType("x.pdf"), "application/pdf");
  assert.equal(previewContentType("noext"), "application/octet-stream");
});
