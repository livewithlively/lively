// 올리기 본문의 비밀번호 틀 — 비밀번호를 머리글이 아니라 본문 앞에 싣는다(프록시 기록에 남지 않게).
//  실행: npx tsx --test src/transfer/frame.test.ts   (사양: #5458 spec «리뷰 반영» F1~F4)
//
//  ── 엣지 표 ──────────────────────────────────────────────────────────────
//   F1  틀 왕복(한글·줄바꿈 포함 비밀번호)   → 비밀번호·파일 바이트 그대로
//   F2  틀이 아닌 본문(zip · 잠긴 묶음)     → 본문 전체가 파일, 비밀번호 없음
//   F3  망가진 틀(줄바꿈 없음 · base64 아님) → 오류
//   F4  빈 비밀번호 틀                     → 비밀번호 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { splitPasswordFrame, joinPasswordFrame, PasswordFrameError, PASSWORD_FRAME } from "./frame.js";

test("F1 한글·줄바꿈이 든 비밀번호와 파일 바이트가 그대로 갈라진다", () => {
  const file = Buffer.concat([Buffer.from("PK\u0003\u0004", "latin1"), randomBytes(500)]);
  const pw = "비밀\n번호 🎉 x";
  const r = splitPasswordFrame(joinPasswordFrame(pw, file));
  assert.equal(r.password, pw);
  assert.ok(r.file.equals(file));
});

test("F2 틀이 아닌 본문은 전체가 파일이다", () => {
  for (const head of ["PK\u0003\u0004", "LIVELY-SEALED-BUNDLE\n"]) {
    const body = Buffer.concat([Buffer.from(head, "latin1"), randomBytes(64)]);
    const r = splitPasswordFrame(body);
    assert.equal(r.password, null);
    assert.ok(r.file.equals(body));
  }
});

test("F3 망가진 틀은 오류다", () => {
  assert.throws(() => splitPasswordFrame(Buffer.concat([PASSWORD_FRAME, Buffer.from("줄바꿈없음")])), PasswordFrameError);
  assert.throws(() => splitPasswordFrame(Buffer.concat([PASSWORD_FRAME, Buffer.from("not base64!!\n"), randomBytes(8)])), PasswordFrameError);
});

test("F4 빈 비밀번호 틀은 비밀번호 없음이다", () => {
  const file = randomBytes(16);
  const r = splitPasswordFrame(Buffer.concat([PASSWORD_FRAME, Buffer.from("\n"), file]));
  assert.equal(r.password, null);
  assert.ok(r.file.equals(file));
});
