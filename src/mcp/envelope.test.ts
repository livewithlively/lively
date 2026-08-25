// 봉투(envelope) 판정(#1881) — HTTP 2xx 로 오는 실패를 실패로 본다. 사양 = scratch spec.md §A.
//  실행: npm run build && node dist/mcp/envelope.test.js (순수 — 네트워크/DB 불요)
import assert from "node:assert/strict";
import { envelopeFailed } from "./dynamic-tools.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("A1 슬랙식 실패 {ok:false,error} 는 실패다", () => {
  assert.equal(envelopeFailed('{"ok":false,"error":"not_in_channel"}'), true);
});
t("A2 {ok:true} 는 성공", () => {
  assert.equal(envelopeFailed('{"ok":true,"messages":[]}'), false);
});
t("A3 ok 필드가 없는 JSON(구글 등)은 판정하지 않는다", () => {
  assert.equal(envelopeFailed('{"files":[{"id":"x"}]}'), false);
});
t("A4 JSON 이 아니면(HTML·평문) 판정하지 않는다", () => {
  assert.equal(envelopeFailed("<html>ok:false</html>"), false);
  assert.equal(envelopeFailed("ok=false"), false);
});
t("A5 앞 공백·개행 뒤의 {ok:false} 도 실패", () => {
  assert.equal(envelopeFailed('\n  {"ok":false}'), true);
});
t("A6 배열 JSON 은 최상위가 아니므로 판정하지 않는다", () => {
  assert.equal(envelopeFailed('[{"ok":false}]'), false);
});
t("A7 ok 가 문자열 \"false\" 면 불리언이 아니라 판정하지 않는다", () => {
  assert.equal(envelopeFailed('{"ok":"false"}'), false);
});
t("A8 빈 본문·깨진 JSON 은 false", () => {
  assert.equal(envelopeFailed(""), false);
  assert.equal(envelopeFailed('{"ok":false'), false);
});

console.log(`\nenvelope tests: ${pass} passed`);
