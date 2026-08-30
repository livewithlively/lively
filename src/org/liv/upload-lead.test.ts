// 첫 대면 문구가 사실을 말한다 (#1631) — «올려 주신 자료 N건» 의 N 이 그 사람 것인가.
//
//  실측 2026-08-31: 팀 워크스페이스에서 파일 5건을 올린 사람에게 리브가 «테스터님이 올려 주신 자료 2,274건» 이라고
//   했다. 자료에 사람 축이 없어서다(source 는 author='connector:local' 까지만 안다 — 누가 올렸는지 모른다).
//   남이 모아 둔 것을 그 사람 것이라 부르는 셈이고, 제품이 첫 대면에서 사실이 아닌 말을 한다.
//   신규 워크스페이스(전체 = 내가 올린 것)에서는 안 드러나므로 팀 계정으로 밟아야 보인다.
//
//  화면은 «이번에 올린 수»(S.upN)를 이미 안다 — 그래서 문구를 가른다. 세는 대상은 그대로다(갈래는 전체를 본다).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../../../web/v2/onboarding.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const B1 = SRC.slice(SRC.indexOf("if (step === 'b1')"), SRC.indexOf("if (step === 'b2')"));

test("총계를 그 사람이 «올려 주신» 것이라고 **조건 없이** 단정하지 않는다", () => {
  //  ⚠ 문자열만 세면 안 된다 — «전체 = 내가 올린 것»(total === mine)일 때는 그 말이 **사실**이라 그대로 써야 한다.
  //   지켜야 할 것은 «그 문장이 조건 없이 쓰이지 않는다» 이지 «그 문장이 없다» 가 아니다.
  //   (첫 판 가드가 정확히 이걸 혼동해 옳은 분기를 위반으로 잡았다 — 가드가 문장을 이기면 사람이 문장을 지운다.)
  const guarded = /mine > 0\s*\n?\s*\? `\$\{esc\(nick\(\)[\s\S]{0,200}올려 주신 자료 <b>\$\{total\}건/;
  assert.match(B1, guarded, "«올려 주신 자료 N건» 이 mine>0 갈래 안에 있어야 한다");
  //  그리고 lead 를 만드는 삼항 **밖**에서는 그 문장이 나오면 안 된다(=조건 없이 쓰는 자리).
  const afterLead = B1.slice(B1.indexOf("const bubble = msgLiv("));
  assert.doesNotMatch(afterLead, /올려 주신 자료 <b>\$\{total\}건/,
    "말풍선 본문이 조건 없이 총계를 그 사람 것이라고 부른다 — 팀 워크스페이스에서 사실이 아니다(#1631)");
});

test("내가 올린 수와 전체가 다르면 둘을 갈라 말한다", () => {
  assert.match(B1, /const mine = S\.upN \|\| 0;/, "이번에 올린 수를 안 본다");
  assert.match(B1, /mine > 0 && total > mine/, "«내 것 + 전체» 를 가르는 갈래가 없다");
  assert.match(B1, /이 워크스페이스에 쌓여 있는 자료/, "전체를 가리키는 정직한 표현이 없다");
});

test("아무것도 안 올린 사람에게 «올려 주신» 이라고 하지 않는다", () => {
  assert.match(B1, /: `이 워크스페이스에 쌓여 있는 자료 <b>\$\{total\}건/,
    "mine=0 인데 전체를 그 사람 것처럼 말한다");
});

test("세는 대상은 그대로다 — 갈래는 전체를 보고 잡는다(무회귀)", () => {
  assert.match(B1, /realKinds\(\)\.map/, "종류별 집계가 사라졌다");
  assert.match(B1, /const total = realTotal\(\);/, "총계 계산이 바뀌었다 — 이 수정은 문구만 고친다");
});
