import { strict as assert } from "node:assert";
import test from "node:test";
import { PREFS_MAX_BYTES, mergePrefs, serializePrefs } from "./app-prefs.js";

// ── 앱 × 보는 사람 개인 설정 (#4601) — 사양 표 S3 의 순수 부분 ────────────────────────────
//  이게 틀리면: 앱이 「기본값으로」 를 표현할 길이 없다(null 삭제) · 다른 키를 지운다(얕은 병합) · 설정 칸이 문서 저장소가 된다(16KB).

const status = (fn: () => unknown): number | "ok" => { try { fn(); return "ok"; } catch (e) { return (e as { status?: number }).status ?? -1; } };

test("S3-1 없던 사람 → 빈 객체에서 시작 · patch 의 키만 들어온다", () => {
  assert.deepEqual(mergePrefs(null, { layout: "rows" }), { layout: "rows" });
  assert.deepEqual(mergePrefs(undefined, {}), {});
});

test("S3-2 얕은 병합 — 다른 키는 그대로, 같은 키는 덮어씀, 중첩 객체는 통째로 바뀜", () => {
  const cur = { layout: "cols", font: "m", lastSlide: { a: "s1", b: "s2" } };
  assert.deepEqual(mergePrefs(cur, { layout: "rows", lastSlide: { a: "s9" } }), { layout: "rows", font: "m", lastSlide: { a: "s9" } });
});

test("S3-3 값이 null 인 키는 지운다 — 앱의 「기본값으로」", () => {
  assert.deepEqual(mergePrefs({ layout: "rows", font: "l" }, { font: null }), { layout: "rows" });
  assert.deepEqual(mergePrefs({ a: 1 }, { b: null }), { a: 1 });   // 없는 키를 지워도 조용히
});

test("S3-4 patch 가 객체가 아니면 400 · 지금 값이 깨져 있어도(배열·문자열) 새로 시작한다", () => {
  assert.equal(status(() => mergePrefs({}, "x")), 400);
  assert.equal(status(() => mergePrefs({}, [1])), 400);
  assert.equal(status(() => mergePrefs({}, null)), 400);
  assert.deepEqual(mergePrefs(["junk"], { a: 1 }), { a: 1 });
});

test("S3-4b 값 어디든 NUL 문자(\\u0000)가 있으면 400 — jsonb 가 못 담아 500 이 날 자리를 앞에서 막는다", () => {
  assert.equal(status(() => mergePrefs({}, { a: "x\u0000y" })), 400);
  assert.equal(status(() => mergePrefs({}, { a: { deep: ["\u0000"] } })), 400);
  assert.equal(status(() => mergePrefs({}, { "k\u0000": 1 })), 400);
  assert.deepEqual(mergePrefs({}, { a: "\\u0000 라는 글자" }), { a: "\\u0000 라는 글자" }, "역슬래시 u0000 글자(실제 NUL 아님)는 된다");
});

test("S3-5 16KB 초과 → 413 · 그 아래는 직렬화 문자열을 돌려준다", () => {
  const ok = { note: "가".repeat(5000) };            // 한글 3바이트 × 5000 = 15,000B + 틀 < 16,384B
  assert.equal(serializePrefs(ok), JSON.stringify(ok));
  const big = { note: "가".repeat(5500) };           // 16,500B 초과
  assert.equal(status(() => serializePrefs(big)), 413);
  assert.equal(PREFS_MAX_BYTES, 16384);
});
