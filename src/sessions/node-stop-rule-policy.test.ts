// #5043 — 원격 PC 하네스 종료 규칙의 유효값(워크스페이스 기본 + 컴퓨터별). 사양: 스크래치 spec.md 표 C.
//  틀리면: 화면에 적힌 분과 실제로 끄는 분이 갈리거나(두 벌), 깨진 DB 값이 «0분 = 즉시» 로 읽혀 막 끝난 세션이 꺼진다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { effectiveNodeStopRule, mergeNodeStopRuleOverride, parseNodeStopRuleOverride } from "./node-stop-rule-policy.js";
import { DEFAULT_SESSION_RECLAIM_POLICY } from "./session-reclaim-policy.js";

const WS = { node_stop_enabled: true, node_stop_done_minutes: 30, node_stop_asking_minutes: 180, node_stop_unknown_minutes: 1440 };

test("C1 컴퓨터 값이 없으면 전부 워크스페이스 값 — 출처 workspace", () => {
  for (const o of [null, undefined, {}]) {
    assert.deepEqual(effectiveNodeStopRule(WS, o), {
      enabled: true, doneMin: 30, askingMin: 180, unknownMin: 1440,
      source: { enabled: "workspace", done: "workspace", asking: "workspace", unknown: "workspace" },
    });
  }
});
test("C2 한 칸만 정하면 그 칸만 컴퓨터 값 — 0 도 «정한 값» 이다(끔)", () => {
  const e = effectiveNodeStopRule(WS, { done_minutes: 5 });
  assert.deepEqual([e.doneMin, e.askingMin, e.unknownMin], [5, 180, 1440]);
  assert.deepEqual(e.source, { enabled: "workspace", done: "node", asking: "workspace", unknown: "workspace" });
  const z = effectiveNodeStopRule(WS, { unknown_minutes: 0 });
  assert.equal(z.unknownMin, 0);
  assert.equal(z.source.unknown, "node");
});
test("C3 켜기는 컴퓨터 값이 이긴다 — 워크스페이스 켬 + 컴퓨터 끔 = 끔 · 워크스페이스 끔 + 컴퓨터 켬 = 켬", () => {
  assert.equal(effectiveNodeStopRule(WS, { enabled: false }).enabled, false);
  assert.equal(effectiveNodeStopRule({ ...WS, node_stop_enabled: false }, { enabled: true }).enabled, true);
  assert.equal(effectiveNodeStopRule({ ...WS, node_stop_enabled: false }, null).enabled, false);
});
test("C4 깨진 DB 값은 그 칸만 버린다(기본값을 따른다) — 글 숫자·음수·상한 초과·소수·배열·객체 아님", () => {
  assert.equal(parseNodeStopRuleOverride(null), null);
  assert.equal(parseNodeStopRuleOverride([1, 2]), null);
  assert.equal(parseNodeStopRuleOverride("x"), null);
  assert.deepEqual(parseNodeStopRuleOverride({ enabled: "true", done_minutes: "30", asking_minutes: -1, unknown_minutes: 43_201 }), null);
  assert.deepEqual(parseNodeStopRuleOverride({ done_minutes: 2.5, asking_minutes: 90, unknown_minutes: null, enabled: false }), { asking_minutes: 90, enabled: false });
});
test("C5 변경 — 칸이 있으면 바꾸고 · null 은 기본값으로 되돌리고 · 없는 칸은 그대로 · 다 비면 null", () => {
  const cur = { enabled: true, done_minutes: 10, asking_minutes: 60 };
  assert.deepEqual(mergeNodeStopRuleOverride(cur, { done_minutes: 15 }), { ok: true, value: { enabled: true, done_minutes: 15, asking_minutes: 60 } });
  assert.deepEqual(mergeNodeStopRuleOverride(cur, { asking_minutes: null, enabled: null }), { ok: true, value: { done_minutes: 10 } });
  assert.deepEqual(mergeNodeStopRuleOverride(cur, { enabled: null, done_minutes: null, asking_minutes: null }), { ok: true, value: null });
  assert.deepEqual(mergeNodeStopRuleOverride(null, {}), { ok: true, value: null });
});
test("C5b 잘못된 값은 조용히 버리지 않고 거절한다(사람의 말) — 저장했다고 믿었는데 기본값이 도는 일이 없게", () => {
  for (const body of [{ done_minutes: "30" }, { asking_minutes: 1.5 }, { enabled: "yes" }, { unknown_minutes: -5 }]) {
    const r = mergeNodeStopRuleOverride(null, body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.ok(!r.ok && r.message.length > 0);
  }
  assert.equal(mergeNodeStopRuleOverride(null, null).ok, false);
  assert.equal(mergeNodeStopRuleOverride(null, [1]).ok, false);
});
test("C6 경계 — 0 과 43200 은 받고 -1 · 43201 은 거절한다", () => {
  assert.deepEqual(mergeNodeStopRuleOverride(null, { done_minutes: 0, unknown_minutes: 43_200 }), { ok: true, value: { done_minutes: 0, unknown_minutes: 43_200 } });
  assert.equal(mergeNodeStopRuleOverride(null, { done_minutes: -1 }).ok, false);
  assert.equal(mergeNodeStopRuleOverride(null, { asking_minutes: 43_201 }).ok, false);
});
test("C7 코드 기본값 — 꺼짐(컴퓨터별로 켜서 실측) · 완료 30분 · 질의 180분 · 상태 모름 24시간", () => {
  const p = DEFAULT_SESSION_RECLAIM_POLICY;
  assert.deepEqual([p.node_stop_enabled, p.node_stop_done_minutes, p.node_stop_asking_minutes, p.node_stop_unknown_minutes], [false, 30, 180, 1440]);
  //  매니지드 값은 그대로(무회귀)
  assert.deepEqual([p.stop_done_minutes, p.stop_asking_minutes], [3, 60]);
});
