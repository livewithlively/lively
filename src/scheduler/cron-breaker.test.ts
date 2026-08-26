// 크론 서킷 브레이커 판정(#1675 ④) — 사양 엣지 표.
//  틀렸을 때: 안 끄면 어니스트처럼 200회 연속 실패가 방치되고, 과잉으로 끄면 **멀쩡한 파이프라인이 죽는다**.
//  자동 정지는 보수적이어야 한다 — 그래서 실패로 세는 건 'error' 하나뿐이라는 게 이 표의 중심이다.
import { strict as assert } from "node:assert";
import { cronBreakerDecision } from "./cron-breaker.js";

const d = (status: string, streak: number, max = 5) => cronBreakerDecision({ status, streak, max });

// ── 기본 누적 ──
assert.deepEqual(d("error", 0), { nextStreak: 1, disable: false }, "첫 실패에 카운터가 안 올랐다");
assert.deepEqual(d("error", 1), { nextStreak: 2, disable: false });

// ── 경계값 — 임계 직전 / 정확히 임계 ──
assert.deepEqual(d("error", 3), { nextStreak: 4, disable: false }, "임계 직전(4/5)에 껐다 — 조급하다");
assert.deepEqual(d("error", 4), { nextStreak: 5, disable: true }, "임계(5/5)에 닿았는데 안 껐다 — 200회 실패가 재현된다");
assert.deepEqual(d("error", 9), { nextStreak: 10, disable: true }, "임계를 넘겼는데 안 껐다");
// 임계 1 = "한 번만 실패해도 끈다"
assert.deepEqual(d("error", 0, 1), { nextStreak: 1, disable: true }, "임계 1 이 안 먹는다");

// ── 성공은 카운터를 리셋한다(간헐 실패로 서서히 임계에 닿으면 안 된다) ──
assert.deepEqual(d("ok", 4), { nextStreak: 0, disable: false }, "성공했는데 카운터가 안 풀렸다");

// ── ★ skipped 는 중립 — 실행 자체를 안 한 회차다(중첩 락) ──
assert.deepEqual(d("skipped", 4), { nextStreak: 4, disable: false },
  "skipped 를 성공/실패로 셌다 — 실행되지도 않은 회차가 판정을 흔든다");
assert.deepEqual(d("skipped", 0), { nextStreak: 0, disable: false });

// ── ★ 알 수 없는 status 는 실패로 세지 않는다(보수적) ──
assert.deepEqual(d("partial", 4), { nextStreak: 0, disable: false },
  "모르는 status 를 실패로 셌다 — 새 액션이 다른 낱말을 쓰는 순간 멀쩡한 잡이 꺼진다");

// ── 브레이커 끔(max<=0) — 카운터는 세되 끄지 않는다(관측은 남는다) ──
assert.deepEqual(d("error", 10, 0), { nextStreak: 11, disable: false }, "브레이커를 껐는데(max=0) 잡을 껐다");
assert.deepEqual(d("error", 10, -1), { nextStreak: 11, disable: false }, "음수 임계로 잡을 껐다");

// ── 잡값 방어 — 카운터가 이상해도 0 부터 센다 ──
assert.deepEqual(d("error", -3), { nextStreak: 1, disable: false }, "음수 카운터가 그대로 이어졌다");
assert.deepEqual(d("error", NaN), { nextStreak: 1, disable: false }, "NaN 카운터에서 NaN 이 나왔다");
assert.deepEqual(d("error", 2.7), { nextStreak: 3, disable: false }, "소수 카운터를 그대로 뒀다");

console.log("cron-breaker.test: ok");
