// 레인 뼈대 — 사양 엣지 표(scratchpad/spec-lane-skeleton.md) 행마다 한 검사.
import test from "node:test";
import assert from "node:assert/strict";
import { planLaneSkeleton, lookbackFromCadence, laneKeyFor, CATCH_ALL_KEY } from "./lane-skeleton.js";

const D = (...keys: string[]) => keys.map((k) => ({ key: k, name: `서랍 ${k}` }));

test("① 서랍 3, 기존 없음 → 레인 3 + catch-all, 전부 꺼짐, 목적지 = 서랍 key", () => {
  const p = planLaneSkeleton({ drawers: D("a", "b", "c"), existingKeys: [] });
  assert.deepEqual(p.map((x) => x.key), ["liv-a", "liv-b", "liv-c", CATCH_ALL_KEY]);
  assert.ok(p.every((x) => x.enabled === false));
  assert.deepEqual(p.slice(0, 3).map((x) => x.target_category), ["a", "b", "c"]);
  assert.equal(p[3].target_category, null);
  assert.equal(p[3].priority, -100);
  assert.equal(p[0].priority, 50);
});
test("② 서랍 0 → 아무것도 없음(catch-all 포함)", () => {
  assert.deepEqual(planLaneSkeleton({ drawers: [], existingKeys: [] }), []);
});
test("③ 기존에 liv-a 있으면 liv-b + catch-all 만", () => {
  const p = planLaneSkeleton({ drawers: D("a", "b"), existingKeys: ["liv-a"] });
  assert.deepEqual(p.map((x) => x.key), ["liv-b", CATCH_ALL_KEY]);
});
test("④ 기존에 catch-all 있으면 안 만든다", () => {
  const p = planLaneSkeleton({ drawers: D("a"), existingKeys: [CATCH_ALL_KEY] });
  assert.deepEqual(p.map((x) => x.key), ["liv-a"]);
});
test("⑤ 서랍 전부 기존 + catch-all 기존 → []", () => {
  assert.deepEqual(planLaneSkeleton({ drawers: D("a"), existingKeys: ["liv-a", CATCH_ALL_KEY] }), []);
});
test("⑥ 서랍 전부 기존, catch-all 없음 → catch-all 만", () => {
  const p = planLaneSkeleton({ drawers: D("a"), existingKeys: ["liv-a"] });
  assert.deepEqual(p.map((x) => x.key), [CATCH_ALL_KEY]);
});
test("⑦ 주기 → lookback: week 30 · month 90 · no/undefined null", () => {
  assert.equal(lookbackFromCadence("week"), 30);
  assert.equal(lookbackFromCadence("month"), 90);
  assert.equal(lookbackFromCadence("no"), null);
  assert.equal(lookbackFromCadence(undefined), null);
  assert.equal(planLaneSkeleton({ drawers: D("a"), existingKeys: [], cadence: "week" })[0].lookback_days, 30);
});
test("⑧ 같은 서랍 key 둘 → 하나만", () => {
  const p = planLaneSkeleton({ drawers: D("a", "a"), existingKeys: [] });
  assert.deepEqual(p.map((x) => x.key), ["liv-a", CATCH_ALL_KEY]);
});
test("⑨ key 정규화 — 대문자·공백·해시형", () => {
  assert.equal(laneKeyFor("d-dc5e190147"), "liv-d-dc5e190147");
  assert.equal(laneKeyFor("My Drawer"), "liv-my-drawer");
  assert.equal(laneKeyFor("A_b"), "liv-a_b");
});
test("⑩ 빈 key → liv-drawer", () => {
  assert.equal(laneKeyFor(""), "liv-drawer");
  assert.equal(laneKeyFor("---"), "liv-drawer");
});
test("⑪ 경계 — 49자 key 는 48자로 잘린다", () => {
  const k = "x".repeat(49);
  assert.equal(laneKeyFor(k), "liv-" + "x".repeat(48));
  assert.equal(laneKeyFor("x".repeat(48)), "liv-" + "x".repeat(48));
});
