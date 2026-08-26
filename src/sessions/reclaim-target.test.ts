// 압박 회수 정지 조건(#1675 ⑤) — 물리·스왑 두 축의 목표 판정.
//  틀렸을 때: 너무 일찍 멈추면 압박이 안 풀려 earlyoom 이 대신 죽이고(=#1220 이 고치려던 그 상황),
//  너무 늦게 멈추면 **필요 없는 남의 세션까지 걷는다**(회수는 되돌릴 수 없다 — 과다가 과소보다 나쁘다).
import { strict as assert } from "node:assert";
import { reclaimTargetReached } from "./session-reaper.js";

// ── 발동한 축이 없으면 걷을 이유가 없다 ──
assert.equal(reclaimTargetReached({ freedMb: 0 }), true, "발동한 축이 없는데 계속 걷으려 한다");

// ── 물리 축만 ──
// 사용률 90 · 임계 85 · 전체 16000MB → 임계까지 내리려면 5% = 800MB 초과분이 필요하다.
const mem = { usedPct: 90, thresholdPct: 85, totalMb: 16_000 };
assert.equal(reclaimTargetReached({ freedMb: 0, mem }), false, "아무것도 안 걷었는데 목표 달성이라고 했다");
assert.equal(reclaimTargetReached({ freedMb: 799, mem }), false, "임계 직전(799MB)인데 멈췄다");
assert.equal(reclaimTargetReached({ freedMb: 801, mem }), true, "임계를 넘겼는데 계속 걷는다");
// 경계 — 정확히 임계와 같아지는 지점은 **아직 미달**이다(조건이 `<` 이므로: 사용률이 임계 '밑'이어야 해소).
assert.equal(reclaimTargetReached({ freedMb: 800, mem }), false, "정확히 임계에 닿은 것을 '밑'으로 판정했다");
// 못 재는 상태(totalMb<=0)에서 '달성'을 선언하면 압박이 안 풀린 채 방어가 멈춘다 — 종전 동작 보존.
assert.equal(reclaimTargetReached({ freedMb: 99_999, mem: { ...mem, totalMb: 0 } }), false,
  "전체 메모리를 못 재는데 목표 달성이라고 했다 — 방어가 조용히 멈춘다");

// ── 스왑 축만 ──
assert.equal(reclaimTargetReached({ freedMb: 0, swap: { overMb: 500 } }), false, "스왑 초과분을 안 걷었는데 멈췄다");
assert.equal(reclaimTargetReached({ freedMb: 500, swap: { overMb: 500 } }), true, "스왑 목표(경계)에 닿았는데 계속 걷는다");
assert.equal(reclaimTargetReached({ freedMb: 501, swap: { overMb: 500 } }), true);
assert.equal(reclaimTargetReached({ freedMb: 0, swap: { overMb: 0 } }), true, "초과분 0(이미 임계 밑)인데 걷으려 한다");

// ── ★두 축이 함께 발동하면 **둘 다** 풀려야 멈춘다 ──
{
  const both = { mem, swap: { overMb: 3000 } };
  assert.equal(reclaimTargetReached({ freedMb: 900, ...both }), false,
    "물리만 풀렸는데 멈췄다 — 스왑은 그대로라 박스는 여전히 벼랑이다");
  assert.equal(reclaimTargetReached({ freedMb: 3000, ...both }), true, "두 축 다 풀렸는데 계속 걷는다");
}
{
  // 스왑이 먼저 풀리고 물리가 남은 경우도 대칭이어야 한다.
  const both = { mem: { usedPct: 99, thresholdPct: 85, totalMb: 16_000 }, swap: { overMb: 100 } };
  assert.equal(reclaimTargetReached({ freedMb: 200, ...both }), false, "스왑만 풀렸는데 멈췄다");
}

console.log("reclaim-target.test: ok");
