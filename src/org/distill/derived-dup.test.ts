// 파생 중복 판정(#1631) — 엣지 표 행마다 한 검사.
//  실측 2026-08-31: 같은 파일(source #7364)에서 지식이 3초 간격으로 2건 나왔다(슬러그만 다름).
//   `org_distiller_seen` 상 그 자료를 가져간 증류기는 하나뿐 — 한 배치가 둘을 쓴 것이고,
//   중복 방지가 전적으로 모델 자율이라 건너뛰면 그대로 통과한다.
import test from "node:test";
import assert from "node:assert/strict";
import { checkDerivedDup } from "./derived-dup.js";

const d = (name: string) => ({ name, relation: "derived_from" });

test("① 이 자료의 첫 파생이면 조용하다", () => {
  assert.deepEqual(checkDerivedDup([], "a"), { duplicate: false, siblings: [], note: null });
});

test("② 이미 다른 파생이 있으면 알린다 — 이게 실측에서 놓친 자리다", () => {
  const r = checkDerivedDup([d("reseller-standard-contract-terms")], "reseller-contract-standard-terms");
  assert.equal(r.duplicate, true);
  assert.deepEqual(r.siblings, ["reseller-standard-contract-terms"]);
  assert.match(String(r.note), /이미 있습니다/);
});

test("③ 같은 지식을 다시 거는 것은 중복이 아니다 — 멱등 재링크", () => {
  assert.equal(checkDerivedDup([d("a")], "a").duplicate, false);
});

test("④ cites(참조)는 세지 않는다 — 여럿인 것이 정상이라 세면 늘 울린다", () => {
  const r = checkDerivedDup([{ name: "x", relation: "cites" }, { name: "y", relation: "cites" }], "a");
  assert.equal(r.duplicate, false);
});

test("⑤ derived 와 cites 가 섞이면 derived 만 센다", () => {
  const r = checkDerivedDup([d("real"), { name: "ref", relation: "cites" }], "a");
  assert.deepEqual(r.siblings, ["real"]);
});

test("⑥ 같은 이름이 여러 번 있어도 한 번만 센다", () => {
  assert.deepEqual(checkDerivedDup([d("a"), d("a")], "b").siblings, ["a"]);
});

test("⑦ 많으면 셋까지 보이고 나머지는 수로 접는다 — 알림이 벽이 되면 안 읽는다", () => {
  const r = checkDerivedDup([d("a"), d("b"), d("c"), d("e"), d("f")], "z");
  assert.match(String(r.note), /a, b, c 외 2건/);
  assert.equal(r.siblings.length, 5, "표시는 접어도 사실은 다 준다");
});

test("⑧ 빈 이름·공백은 무시한다 — 없는 형제를 지어내지 않는다", () => {
  assert.equal(checkDerivedDup([{ name: "  ", relation: "derived_from" }], "a").duplicate, false);
  assert.equal(checkDerivedDup([d("x")], "   ").duplicate, true);   // 내 이름이 비어도 형제는 형제다
});

test("⑨ 알림은 **막지 않는다**는 뜻을 담는다 — 정당한 분할을 죽이지 않게", () => {
  const note = String(checkDerivedDup([d("a")], "b").note);
  assert.match(note, /갱신하세요/, "합치는 길을 안내하지 않는다");
  assert.match(note, /그대로 두어도 됩니다/, "정당한 경우를 인정하지 않으면 사람이 경고를 끈다");
});
