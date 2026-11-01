// 레인 뼈대 — 사양 엣지 표(scratchpad/spec-lane-skeleton.md) 행마다 한 검사.
import test from "node:test";
import assert from "node:assert/strict";
import { planLaneSkeleton, lookbackFromCadence, laneKeyFor, CATCH_ALL_KEY, drawerOfLane, settleDrawerTarget } from "./lane-skeleton.js";

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

// ── 서랍 레인의 목적지 (#1631 · #5235) ────────────────────────────────────────────────────────
//  실측 #1631: 뼈대가 `(null) → d-21c2235a7d` 로 넣은 목적지를, 리브가 그 레인을 **켜면서** `→ (null)` 로 지웠다.
//  실측 #5235: 없는 서랍이 키에서 되살아났고(`liv-product-thread`), 비우는 저장은 200 인데 아무것도 안 바뀌었다.
//  표의 D 번호는 #5235 사양의 행이다. 실 upsert 경로는 org/distill/lane-settings.pg-test.mjs 가 재고, 여기는 판정 표를 잠근다.
const STATES = new Map<string, string>([["a", "active"], ["b", "active"], ["dep", "deprecated"], ["d-21c2235a7d", "active"], ["product-plans", "active"]]);
const settle = (key: string | null, given: string | null, clearing = false, states: Map<string, string> = STATES) =>
  settleDrawerTarget({ key, given, clearing, stateOf: (k) => states.get(k) });

test("관측 장치 — 표가 실제로 갈린다(세 결과가 다 나온다)", () => {
  assert.deepEqual(settle("liv-a", null), { target: "a" });
  assert.deepEqual(settle("liv-x", null), { target: null });
  assert.deepEqual(settle("liv-a", null, true), { refuse: "a" });
});

test("D1·D10 서랍이 있고 목적지가 비면 키에서 채운다 — 빈 값 모양은 가리지 않는다", () => {
  for (const blank of [null, "", "   "]) assert.deepEqual(settle("liv-d-21c2235a7d", blank), { target: "d-21c2235a7d" }, JSON.stringify(blank));
});

test("D2·D12 서랍이 없으면 지어내지 않는다 — 종전엔 없는 카테고리가 박혔다", () => {
  assert.deepEqual(settle("liv-product-thread", null), { target: null });
  assert.deepEqual(settle("liv-x", ""), { target: null });
});

test("D3·D4·D11 서랍이 없으면 비우기가 먹는다 — 없는 서랍이 박힌 레인을 고치는 길이다", () => {
  assert.deepEqual(settle("liv-x", null, true), { target: null });
  assert.deepEqual(settle("liv-x", "", true), { target: null });
});

test("D5·D6·D8·D18 서랍이 있는데 비우려 하면 거절한다 — 조용히 되살리면 저장이 듣지 않는다", () => {
  for (const blank of [null, "", "   "]) assert.deepEqual(settle("liv-a", blank, true), { refuse: "a" }, JSON.stringify(blank));
});

test("D9 이미 빈 목적지를 되돌려 보낸 저장은 거절하지 않고 되살린다 — 스위치 저장이 막히면 안 된다", () => {
  assert.deepEqual(settle("liv-a", null, false), { target: "a" });
});

test("D13·D14·D20 비어 있지 않으면 그대로다 — 옮기기는 정당하고, 명시값 검증은 이 판정의 일이 아니다", () => {
  assert.deepEqual(settle("liv-a", "b"), { target: "b" });
  assert.deepEqual(settle("liv-a", "b", true), { target: "b" });
  assert.deepEqual(settle("liv-x", "ghost"), { target: "ghost" }, "없는 값이 박힌 레인의 무관한 저장을 막지 않는다");
  assert.deepEqual(settle("liv-a", "  b  "), { target: "b" }, "공백은 다듬는다");
});

test("D15 비활성 서랍은 없는 서랍과 같다 — 되살리지 않고 비우기가 먹는다", () => {
  assert.deepEqual(settle("liv-dep", null, true), { target: null });
  assert.deepEqual(settle("liv-dep", null), { target: null });
});

test("D16 안전망은 목적지가 없는 것이 설계다 — 같은 이름의 카테고리가 있어도 관여하지 않는다", () => {
  const withCatchAll = new Map(STATES).set("catch-all", "active");
  assert.deepEqual(settle(CATCH_ALL_KEY, null, true, withCatchAll), { target: null });
  assert.deepEqual(settle(CATCH_ALL_KEY, "", false, withCatchAll), { target: null });
});

test("D17 서랍 레인이 아니면 관여하지 않는다 — 프리셋·손수 만든 증류기의 뜻을 바꾸지 않는다", () => {
  assert.deepEqual(settle("local-files", null, true), { target: null });
  assert.deepEqual(settle("issue-threads", "", false), { target: null });
  assert.deepEqual(settle(null, null, true), { target: null });
  assert.deepEqual(settle("", null), { target: null });
});

test("D19 'liv-' 뒤가 비면 되살릴 것이 없다 — 지어내지 않는다", () => {
  assert.deepEqual(settle("liv-", null, true), { target: null });
  assert.deepEqual(settle("liv-   ", null), { target: null });
  assert.equal(drawerOfLane("liv-"), null);
  assert.equal(drawerOfLane(CATCH_ALL_KEY), null);
  assert.equal(drawerOfLane("plain"), null);
  assert.equal(drawerOfLane(null), null);
});

test("D21 카테고리가 하나도 없는 워크스페이스 — 어떤 키도 되살리지 않는다", () => {
  assert.deepEqual(settle("liv-a", null, false, new Map()), { target: null });
  assert.deepEqual(settle("liv-a", null, true, new Map()), { target: null });
});

test("laneKeyFor 의 역 — 뼈대가 만든 키에서 같은 서랍을 읽는다", () => {
  const drawer = "product-plans";
  assert.equal(drawerOfLane(laneKeyFor(drawer)), drawer);
  assert.deepEqual(settle(laneKeyFor(drawer), null), { target: drawer });
});
