// 묶음 비밀번호 — 걸고 열기, 틀린 비밀번호, 바뀐 파일, 서버 자원을 태우는 머리 값.
//  실행: npx tsx --test src/transfer/seal.test.ts   (사양: #5458 spec 표 B)
//
//  ── 엣지 표 ──────────────────────────────────────────────────────────────
//   B1  걸고 같은 비밀번호로 열기               → 원래 바이트
//   B2  틀린 비밀번호                          → 비밀번호 오류
//   B3  머리(salt)를 바꾼 파일                  → 비밀번호 오류
//   B4  본문 한 바이트를 바꾼 파일               → 비밀번호 오류
//   B5  서버 자원을 태우는 머리 값(N 과대)        → 형식 오류, 키 계산 전에 빨리
//   B6  7자 / 8자 비밀번호로 걸기               → 거절 / 허용(경계)
//   B7  잠긴 파일인지 판별                      → zip 아니오 · 잠긴 묶음 예
//   B8  빈 비밀번호로 열기                      → 비밀번호 오류
//   B9  같은 한글 비밀번호를 NFD 로 입력          → 열린다
//   B10 머리가 JSON null                       → 형식 오류(500 이 아니라 400 으로 갈 오류)
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sealBundle, openSealedBundle, isSealed, SealPasswordError, SealFormatError } from "./seal.js";
import { writeZip } from "./zip.js";

const PW = "올바른-비밀번호-123";

test("B1 걸고 같은 비밀번호로 열면 원래 바이트가 나온다", async () => {
  const zip = randomBytes(10_000);
  const sealed = await sealBundle(zip, PW);
  assert.ok(!sealed.includes(zip.subarray(0, 64)), "평문이 그대로 들어 있으면 안 된다");
  assert.ok((await openSealedBundle(sealed, PW)).equals(zip));
});

test("B2 틀린 비밀번호는 비밀번호 오류", async () => {
  const sealed = await sealBundle(Buffer.from("hello"), PW);
  await assert.rejects(openSealedBundle(sealed, "틀린-비밀번호-999"), SealPasswordError);
});

test("B3 머리의 salt 를 바꾸면 열리지 않는다", async () => {
  const sealed = await sealBundle(Buffer.from("hello"), PW);
  const text = sealed.toString("latin1");
  const m = /"salt":"([^"]+)"/.exec(text);
  assert.ok(m, "머리에 salt 가 있어야 한다");
  const forged = Buffer.from(text.replace(m[1], randomBytes(16).toString("base64")), "latin1");
  await assert.rejects(openSealedBundle(forged, PW), SealPasswordError);
  // 키 계산과 무관한 칸을 머리에 끼워 넣어도 열리지 않는다 — 머리 전체가 인증에 묶여 있다는 뜻(salt 변경은 키가 달라져 어차피 실패한다).
  const padded = Buffer.from(text.replace('{"v":1,', '{"v":1,"note":"x",'), "latin1");
  assert.notEqual(padded.toString("latin1"), text, "머리에 칸을 끼워 넣었어야 한다");
  await assert.rejects(openSealedBundle(padded, PW), SealPasswordError);
});

test("B4 본문 한 바이트를 바꾸면 열리지 않는다", async () => {
  const sealed = await sealBundle(randomBytes(200), PW);
  const broken = Buffer.from(sealed);
  broken[broken.length - 40] ^= 0x01;
  await assert.rejects(openSealedBundle(broken, PW), SealPasswordError);
});

test("B5 메모리를 태우는 N 값은 키 계산 전에 형식 오류로 거절한다", async () => {
  const sealed = await sealBundle(Buffer.from("hello"), PW);
  const forged = Buffer.from(sealed.toString("latin1").replace(/"N":\d+/, `"N":${2 ** 24}`), "latin1");
  const t0 = Date.now();
  await assert.rejects(openSealedBundle(forged, PW), SealFormatError);
  assert.ok(Date.now() - t0 < 1500, "범위 검사가 키 계산보다 먼저여야 한다");
});

test("B6 비밀번호 7자는 거절, 8자는 허용한다", async () => {
  await assert.rejects(sealBundle(Buffer.from("x"), "1234567"), SealPasswordError);
  const ok = await sealBundle(Buffer.from("x"), "12345678");
  assert.equal((await openSealedBundle(ok, "12345678")).toString(), "x");
});

test("B7 잠긴 파일인지 판별한다", async () => {
  assert.equal(isSealed(writeZip([{ path: "a", data: Buffer.from("x") }])), false);
  assert.equal(isSealed(await sealBundle(Buffer.from("x"), PW)), true);
});

test("B8 빈 비밀번호로는 열리지 않는다", async () => {
  const sealed = await sealBundle(Buffer.from("hello"), PW);
  await assert.rejects(openSealedBundle(sealed, ""), SealPasswordError);
});

test("B9 같은 한글 비밀번호를 다른 정규형(NFD)으로 넣어도 열린다", async () => {
  const nfc = "비밀번호-한글만-ㅎ".normalize("NFC");
  const sealed = await sealBundle(Buffer.from("hello"), nfc);
  assert.notEqual(nfc.normalize("NFD"), nfc);
  assert.equal((await openSealedBundle(sealed, nfc.normalize("NFD"))).toString(), "hello");
});

test("B10 머리가 JSON null 이면 형식 오류다(TypeError 가 아니다)", async () => {
  const forged = Buffer.concat([Buffer.from("LIVELY-SEALED-BUNDLE\n", "ascii"), Buffer.from("null\n", "utf8"), Buffer.alloc(32)]);
  await assert.rejects(openSealedBundle(forged, PW), SealFormatError);
});
