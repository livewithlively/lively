// 올리기 경로의 본문 파서 오류 → 응답(#5458). 실행: npx tsx --test src/transfer/http-errors.test.ts
//
//  ── 엣지 표 ──────────────────────────────────────────────────────────────
//   H1  올리기 본문이 상한 초과(본문 파서 type 'entity.too.large') → 413 + 한국어 안내 + code too_large
//   H2  그 밖의 오류(일반 Error · null · 다른 type)               → null(다음 처리로 넘긴다)
import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadBodyError, UPLOAD_TOO_LARGE } from "./http-errors.js";

test("H1 상한을 넘은 본문은 413 과 한국어 안내로 답한다(영어 HTML 이 아니다)", () => {
  const out = uploadBodyError(Object.assign(new Error("request entity too large"), { type: "entity.too.large", status: 413 }));
  assert.ok(out);
  assert.equal(out!.status, 413);
  assert.equal(out!.body.code, "too_large");
  assert.equal(out!.body.error, UPLOAD_TOO_LARGE);
  assert.match(out!.body.error, /100MB/);
});

test("H2 그 밖의 오류는 넘긴다", () => {
  assert.equal(uploadBodyError(new Error("boom")), null);
  assert.equal(uploadBodyError(null), null);
  assert.equal(uploadBodyError({ type: "entity.parse.failed", status: 400 }), null);
});
