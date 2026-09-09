// #3778 한글 .hwp 본문 추출 — 순수 부분 회귀. CFB 실물 파일 불요.
//   실행: npm run build && node dist/connectors/hwp.test.js
//
// ## 사양(행위) — 아래 표의 **행마다 시나리오 하나**
//
// ### A. decodeHwpParaText(UTF-16LE 문단) — 「제어문자가 몇 칸을 먹나」
// | # | 입력 | 기대 |
// |---|---|---|
// | A1 | 일반 글자(코드 ≥ 32) | 그대로 |
// | A2 | 확장·인라인 제어(1~8·11~12·14~23) + 뒤 7칸 | 8칸이 통째로 사라지고 앞뒤 글자가 붙는다 |
// | A3 | 제어 9(탭) + 뒤 7칸 | 탭 하나, 7칸 소거 |
// | A4 | 문자 제어 10·13 | 줄바꿈 하나, **1칸만** |
// | A5 | 문자 제어 24~31·0 | 버린다, **1칸만**(뒤 글자 보존) |
// | A6 | 홀수 바이트(잘린 문단) | 예외 없이 읽을 수 있는 데까지 |
// | A7 | 빈 버퍼 | "" |
//
// ### B. collectParaText(레코드 스트림) — 「어디까지가 한 레코드인가」
// | # | 입력 | 기대 |
// |---|---|---|
// | B1 | PARA_TEXT 레코드들 | 문단 배열 |
// | B2 | 다른 태그가 섞임 | 무시하고 PARA_TEXT 만 |
// | B3 | size < 0xFFF(헤더 안에 길이) | 정상 |
// | B4 | size == 0xFFF(길이가 **다음 uint32**) | 정상 + **그 뒤 레코드도 이어서** 읽는다 |
// | B5 | 헤더가 스트림 밖을 가리킴(손상) | 거기서 멈추고 그때까지 읽은 것을 살린다 |
// | B6 | payload 길이 0 | 빈 문단 하나(걸러내기는 호출자 몫) |
// | B7 | 빈 스트림 | [] |
//
// ### C. extractHwp(파일 바이트) — 「못 읽어도 업로드는 성공이어야 한다」
// | # | 입력 | 기대 |
// |---|---|---|
// | C1 | 비-CFB(zip·평문·빈 것) | "" — 예외를 던지지 않는다 |
// | C2 | 512바이트 미만 | "" |
// | C3 | CFB 서명만 맞고 내부는 쓰레기 | "" — 예외를 던지지 않는다 |
//
// ⚠ A2/A4/A5 가 이 파일의 심장이다. 틀려도 **예외가 안 난다** — 뒤 글자가 조용히 밀리거나 사라져서
//  «추출은 됐는데 내용이 이상한» 문서가 만들어진다. 그래서 문구가 아니라 **정확한 결과 문자열**로 단언한다.
import assert from "node:assert/strict";
import { collectParaText, decodeHwpParaText, extractHwp, looksHwp } from "./hwp.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

/** UTF-16LE 문단 버퍼. 숫자는 코드유닛 그대로 넣는다(제어문자가 먹는 «칸»을 세기 위해). */
const para = (...units: Array<number | string>): Buffer => {
  const codes: number[] = [];
  for (const u of units) {
    if (typeof u === "number") codes.push(u);
    else for (const ch of u) codes.push(ch.charCodeAt(0));
  }
  const b = Buffer.alloc(codes.length * 2);
  codes.forEach((c, i) => b.writeUInt16LE(c, i * 2));
  return b;
};

const PARA_TEXT = 0x10 + 51;
/** 레코드 하나. `forceExt` 면 짧아도 0xFFF 표식 + 다음 uint32 길이 경로를 쓴다. */
const rec = (tag: number, payload: Buffer, forceExt = false): Buffer => {
  const big = forceExt || payload.length >= 0xfff;
  const head = Buffer.alloc(big ? 8 : 4);
  head.writeUInt32LE(((tag & 0x3ff) | ((big ? 0xfff : payload.length) << 20)) >>> 0, 0);
  if (big) head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
};

// ── A. 제어문자 폭 ───────────────────────────────────────────────────────────
t("A1·A2: 확장·인라인 제어(1~8·11~12·14~23)는 8칸을 먹는다 — 안 건너뛰면 채움값이 글자로 샌다", () => {
  //  채움 7칸에 **일부러 읽히는 값**(0x41 'A', 0xac00 '가')을 넣는다 — 8칸을 안 건너뛰면 그게 결과에 섞인다.
  assert.equal(decodeHwpParaText(para("문", 2, 0x0041, 0xac00, 0xffff, 0x0042, 0x1234, 0x0043, 2, "서")), "문서");
  for (const c of [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 18, 22, 23]) {
    assert.equal(decodeHwpParaText(para("A", c, 0x0058, 0x0059, 0x005a, 0x0058, 0x0059, 0x005a, c, "B")), "AB", `제어 ${c}`);
  }
});

t("A3: 제어 9(탭)는 탭 한 글자를 내되 역시 8칸", () => {
  assert.equal(decodeHwpParaText(para("A", 9, 0x0058, 0x0058, 0x0058, 0x0058, 0x0058, 0x0058, 9, "B")), "A\tB");
});

t("A4·A5: 문자 제어는 1칸이다 — 8칸으로 오인하면 뒤 글자를 삼킨다", () => {
  assert.equal(decodeHwpParaText(para("가", 13, "나")), "가\n나");
  assert.equal(decodeHwpParaText(para("가", 10, "나")), "가\n나");
  assert.equal(decodeHwpParaText(para("가", 24, "나")), "가나");
  assert.equal(decodeHwpParaText(para("가", 31, "나", 30, "다")), "가나다");
  assert.equal(decodeHwpParaText(para("가", 0, "나")), "가나");
  //  1칸짜리 다섯을 연달아 두어도 뒤 글자가 살아 있어야 한다(8칸 오인이면 전부 삼켜진다).
  assert.equal(decodeHwpParaText(para("A", 24, 25, 26, 27, 28, "B")), "AB");
});

t("A6·A7: 잘린 문단·빈 버퍼 — 예외 없이", () => {
  assert.equal(decodeHwpParaText(Buffer.alloc(0)), "");
  assert.equal(decodeHwpParaText(Buffer.from([0x41])), "");                       // 1바이트(반쪽 코드유닛)
  assert.equal(decodeHwpParaText(Buffer.concat([para("가나"), Buffer.from([0x41])])), "가나");
});

// ── B. 레코드 헤더 ───────────────────────────────────────────────────────────
t("B1·B2·B3: PARA_TEXT 만 순서대로 줍는다", () => {
  const stream = Buffer.concat([
    rec(PARA_TEXT, para("첫줄")),
    rec(0x10 + 50, para("다른태그")),      // PARA_HEADER — 무시돼야 한다
    rec(PARA_TEXT, para("둘째줄")),
  ]);
  assert.deepEqual(collectParaText(stream), ["첫줄", "둘째줄"]);
});

t("B4: size==0xFFF 면 길이가 다음 uint32 다 — 이 경로를 빠뜨리면 그 뒤 레코드를 통째로 잃는다", () => {
  const ext = Buffer.concat([rec(PARA_TEXT, para("확장길이"), true), rec(PARA_TEXT, para("그다음"))]);
  assert.deepEqual(collectParaText(ext), ["확장길이", "그다음"]);
});

t("B5·B6·B7: 손상·빈 payload·빈 스트림", () => {
  //  손상 — 길이가 스트림 밖을 가리킨다. 멈추되 앞서 읽은 것은 살린다.
  const broken = Buffer.concat([rec(PARA_TEXT, para("살아남는줄")), Buffer.from([0x43, 0x00, 0xf0, 0x7f])]);
  assert.deepEqual(collectParaText(broken), ["살아남는줄"]);
  assert.deepEqual(collectParaText(rec(PARA_TEXT, Buffer.alloc(0))), [""]);
  assert.deepEqual(collectParaText(Buffer.alloc(0)), []);
  assert.deepEqual(collectParaText(Buffer.from([0x43, 0x00])), []);               // 헤더도 못 채움
});

// ── C. 진입 안전 ─────────────────────────────────────────────────────────────
t("C1·C2·C3: 못 읽는 입력은 빈 문자열 — 예외를 던지지 않는다(업로드는 성공이어야 한다)", () => {
  assert.equal(looksHwp(Buffer.alloc(16)), false);
  assert.equal(looksHwp(Buffer.from("PK")), false);
  assert.equal(extractHwp(Buffer.alloc(0)), "");
  assert.equal(extractHwp(Buffer.from("hello world")), "");
  assert.equal(extractHwp(Buffer.alloc(4096)), "");
  const sigOnly = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(4096)]);
  assert.equal(extractHwp(sigOnly), "");
});

console.log(`\n${pass} passed`);
