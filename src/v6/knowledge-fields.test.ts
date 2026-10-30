// mergeFieldsPatch · jsonEqual 단위 체크 — DB 불요(순수 함수).
// 실행: npm run build && node dist/v6/knowledge-fields.test.js
//
// 잠그는 불변식(RFC 7396):
//  · 중첩 객체 패치는 형제 키를 보존한다 — domain_wiki.code_sot 만 고쳐도 domain_wiki.relpath 가 남는다.
//  · null 은 그 키를 지운다(중첩 안에서도). 없는 키를 null 로 지우는 것은 무해하다.
//  · 배열·스칼라는 통째로 바뀐다. 객체가 아닌 자리에 객체 패치가 오면 객체로 바뀐다.
//  · base 는 변하지 않는다(호출자가 before 스냅샷을 감사에 그대로 쓴다).
//  · jsonEqual 은 키 순서를 무시한다 — jsonb 가 키 순서를 바꿔 돌려줘도 «변경 없음» 판정이 흔들리지 않게.
import assert from "node:assert/strict";
import { jsonEqual, mergeFieldsPatch } from "./knowledge-fields.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const BASE = { _item_type: "doc", domain_wiki: { relpath: "knowledge/a.md", code_sot: "old" } };

t("중첩 키 하나를 바꿔도 형제 키와 다른 최상위 키가 그대로다", () => {
  assert.deepEqual(mergeFieldsPatch(BASE, { domain_wiki: { code_sot: "new" } }),
    { _item_type: "doc", domain_wiki: { relpath: "knowledge/a.md", code_sot: "new" } });
});

t("null 은 키를 지운다 — 최상위와 중첩 모두 · 없는 키는 무해", () => {
  assert.deepEqual(mergeFieldsPatch(BASE, { domain_wiki: { code_sot: null } }),
    { _item_type: "doc", domain_wiki: { relpath: "knowledge/a.md" } });
  assert.deepEqual(mergeFieldsPatch(BASE, { domain_wiki: null }), { _item_type: "doc" });
  assert.deepEqual(mergeFieldsPatch(BASE, { nope: null }), BASE);
});

t("새 중첩 객체를 만든다 · 객체가 아닌 자리에 객체 패치가 오면 객체로 바꾼다 · 그 안의 null 은 남기지 않는다", () => {
  assert.deepEqual(mergeFieldsPatch({}, { a: { b: { c: 1 } } }), { a: { b: { c: 1 } } });
  assert.deepEqual(mergeFieldsPatch({ a: "str" }, { a: { b: 1 } }), { a: { b: 1 } });
  assert.deepEqual(mergeFieldsPatch({}, { a: { b: null, c: 1 } }), { a: { c: 1 } });
});

t("배열과 스칼라는 통째로 바뀐다(원소 단위 병합 없음)", () => {
  assert.deepEqual(mergeFieldsPatch({ tags: ["a", "b"], n: 1 }, { tags: ["c"], n: "x" }), { tags: ["c"], n: "x" });
});

t("base 는 변하지 않는다", () => {
  const base = JSON.parse(JSON.stringify(BASE));
  mergeFieldsPatch(base, { domain_wiki: { code_sot: "new", relpath: null } });
  assert.deepEqual(base, BASE);
});

t("jsonEqual — 키 순서 무시 · 배열 순서는 본다 · 키 수·타입이 다르면 다르다", () => {
  assert.ok(jsonEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }));
  assert.ok(!jsonEqual({ a: [1, 2] }, { a: [2, 1] }));
  assert.ok(!jsonEqual({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!jsonEqual({ a: "1" }, { a: 1 }));
  assert.ok(!jsonEqual([], {}));
});

console.log(`\n${pass} passed`);
