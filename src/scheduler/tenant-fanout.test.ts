// 주기 작업의 워크스페이스 순회 판정 (#2418) — 엣지 표 행마다 한 검사.
//  사양: null = 레지스트리 없음(종전 경로 1회) · [] = 담당 테넌트 없음(아무것도 안 함) · 그 외 = 순회 대상.
import test from "node:test";
import assert from "node:assert/strict";
import { planSchedulerTargets, type FanoutWorkspace } from "./tenant-fanout.js";

const REG = "registry" as const;

const ws = (slug: string, state = "active"): FanoutWorkspace => ({ id: `id-${slug}`, slug, state });
const all = () => true;

test("① 워크스페이스가 하나도 없으면 null — 종전 경로로 1회 돈다(무회귀)", () => {
  assert.equal(planSchedulerTargets([], all, REG), null);
});

test("② active 만 고른다(archived 는 제외)", () => {
  const got = planSchedulerTargets([ws("a"), ws("b", "archived"), ws("c")], all, REG);
  assert.deepEqual(got?.map((t) => t.slug), ["a", "c"]);
});

test("③ 샤드가 담당하는 것만 고른다", () => {
  const owns = (s: string) => s === "a" || s === "c";
  const got = planSchedulerTargets([ws("a"), ws("b"), ws("c")], owns, REG);
  assert.deepEqual(got?.map((t) => t.slug), ["a", "c"]);
});

test("④ 담당이 하나도 없으면 빈 배열 — null 이 아니다(남의 것을 대신 돌리지 않는다)", () => {
  const got = planSchedulerTargets([ws("a"), ws("b")], () => false, REG);
  assert.deepEqual(got, []);
  assert.notEqual(got, null);
});

test("⑤ primary 도 특별취급 없이 대상에 들어간다", () => {
  const got = planSchedulerTargets([ws("primary"), ws("team-x")], all, REG);
  assert.deepEqual(got?.map((t) => t.slug), ["primary", "team-x"]);
});

test("⑥ 대상에는 id 와 slug 가 둘 다 실린다(컨텍스트가 id 로 바인딩된다)", () => {
  const got = planSchedulerTargets([ws("a")], all, REG);
  assert.deepEqual(got, [{ id: "id-a", slug: "a" }]);
});

test("⑦ 전부 archived 면 빈 배열(종전 경로로 떨어지지 않는다)", () => {
  const got = planSchedulerTargets([ws("a", "archived")], all, REG);
  assert.deepEqual(got, []);
});

test("⑨ off·fixed 모드에서는 순회하지 않는다 — 같은 잡을 N번 돌리지 않기 위해", () => {
  assert.equal(planSchedulerTargets([ws("a"), ws("b")], all, "off"), null);
  assert.equal(planSchedulerTargets([ws("a"), ws("b")], all, "fixed"), null);
});

test("⑩ request 모드도 순회한다(공유 게이트웨이)", () => {
  assert.equal(planSchedulerTargets([ws("a")], all, "request")?.length, 1);
});

// ── 배선 단언 — 세 갈래(null · [] · 대상 있음)가 실제로 서로 다르게 나오는지 ──
test("⑧ 세 갈래가 모두 실제로 나온다(vacuous 방지)", () => {
  assert.equal(planSchedulerTargets([], all, REG), null);
  assert.deepEqual(planSchedulerTargets([ws("a")], () => false, REG), []);
  assert.equal(planSchedulerTargets([ws("a")], all, REG)?.length, 1);
});
