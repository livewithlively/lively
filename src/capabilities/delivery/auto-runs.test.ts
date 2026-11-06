// 「자동 실행」 최근 다섯 줄 — 두 기계(수집 · 증류)가 다 서게 (#5159, 원준 2026-10-31).
//  증류가 늘 앞을 차지해 수집기 줄이 사라지던 것. 줄 수는 늘리지 않고, 없는 쪽의 최신 바뀐 실행이 다른 쪽의 가장 오래된 줄 자리를 받는다.
import test from "node:test";
import assert from "node:assert/strict";
import { bothKinds } from "./auto-runs.js";

const r = (kind: "c" | "d", h: number) => ({ kind, started_at: `2026-10-31T${String(h).padStart(2, "0")}:00:00Z` });
const show = (xs: Array<{ kind: string; started_at: string }>) => xs.map((x) => x.kind + Number(x.started_at.slice(11, 13))).join(" ");

test("증류만 다섯이면 가장 오래된 증류 자리를 최신 수집이 받는다", () => {
  assert.equal(show(bothKinds([r("d", 9), r("d", 8), r("d", 7), r("d", 6), r("d", 5), r("c", 4), r("d", 3), r("c", 2)], 5)), "d9 d8 d7 d6 c4");
});
test("반대쪽도 같다", () => {
  assert.equal(show(bothKinds([r("c", 9), r("c", 8), r("c", 7), r("c", 6), r("c", 5), r("d", 1)], 5)), "c9 c8 c7 c6 d1");
});
test("자리가 남으면 빼지 않는다 · 한쪽만 있으면 그대로 · 비면 빈 것", () => {
  assert.equal(show(bothKinds([r("d", 9), r("c", 8), r("d", 7)], 5)), "d9 c8 d7");
  assert.equal(show(bothKinds([r("d", 9), r("d", 8), r("d", 7), r("d", 6), r("d", 5), r("d", 4)], 5)), "d9 d8 d7 d6 d5");
  assert.equal(show(bothKinds([], 5)), "");
});
test("이미 둘 다 있으면 앞 다섯 그대로", () => {
  assert.equal(show(bothKinds([r("d", 9), r("c", 8), r("d", 7), r("d", 6), r("d", 5), r("c", 4)], 5)), "d9 c8 d7 d6 d5");
});
