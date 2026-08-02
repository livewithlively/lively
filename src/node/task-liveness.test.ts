// 위탁 태스크 무출력 stall 판정(#1101 liveness 가드) — 사양의 엣지 표 전수.
//  정책: 상한을 **넘고** 그때까지 **한 바이트도** 안 나왔을 때만 stall. 그 외엔 살려 둔다(모르면 죽이지 않는다).
//  이 판정이 틀리면 둘 중 하나가 난다 — 멀쩡한 작업을 죽이거나(오탐), #1101 처럼 무출력으로 1시간 매달린다(누락).
import { strict as assert } from "node:assert";
import { isStalled } from "./task-scheduler.js";

const T0 = "2026-07-31T00:00:00.000Z";
const START = new Date(T0).getTime();
const STALL = 300_000;                       // 5분
const after = (ms: number): number => START + ms;

// 기본값 = "한참 초과 + 0바이트"(= stall 인 상태). 각 행은 여기서 한 축만 바꿔 그 축의 효과를 본다.
const verdict = (o: Partial<{ startedAt: string | null; now: number; bytes: number; stallMs: number }> = {}): boolean =>
  isStalled({ startedAt: T0, now: after(STALL * 10), bytes: 0, stallMs: STALL, ...o });

// ── ① 비활성 스위치는 다른 모든 조건을 이긴다 ──
assert.equal(verdict({ stallMs: 0 }), false, "상한 0(비활성)인데 stall 로 판정했다 — 기능을 끌 수 없다");
// ── ② 비활성의 다른 표현(음수) ──
assert.equal(verdict({ stallMs: -1 }), false, "상한이 음수(비활성)인데 stall 로 판정했다");

// ── ③ 시작 시각이 없으면 판정하지 않는다 ──
assert.equal(verdict({ startedAt: null }), false, "시작 시각이 없는데 죽였다 — 모르면 살려 둬야 한다");
// ── ④ 시작 시각이 불량이면 판정하지 않는다(새로 받는 입력의 부재·불량 케이스) ──
assert.equal(verdict({ startedAt: "언젠가" }), false, "시각 파싱 실패인데 죽였다 — 모르면 살려 둬야 한다");

// ── ⑤ 아직 상한 전이면 기다린다 ──
assert.equal(verdict({ now: after(STALL - 1) }), false, "상한 전인데 죽였다");
// ── ⑥ 경계: 정확히 상한에 도달한 순간은 아직 아니다(> 인가 >= 인가) ──
assert.equal(verdict({ now: after(STALL) }), false, "경과가 정확히 상한일 때 죽였다 — '넘어야' stall 이다");
// ── ⑦ 경계: 상한을 넘긴 첫 순간부터 stall ──
assert.equal(verdict({ now: after(STALL + 1) }), true, "상한을 1ms 넘겼는데 stall 이 아니라고 했다");

// ── ⑧ 한 바이트라도 나왔으면 살아 있다 ──
assert.equal(verdict({ bytes: 1 }), false, "1바이트 나온 작업을 죽였다 — 생존 신호를 무시했다");
// ── ⑨ 정상 진행(많이 나옴) ──
assert.equal(verdict({ bytes: 1_048_576 }), false, "정상 진행 중인 작업을 죽였다");

// ── ⑩ 본래 잡으려는 것: 한참 지나도록 0바이트(#1101 의 32분 무출력) ──
assert.equal(verdict(), true, "무출력으로 한참 매달린 작업을 못 잡았다 — 이 가드의 존재 이유다");
// ── ⑪ 바이트 조회가 이상값(음수)을 줘도 0 이하면 무출력 취급 ──
assert.equal(verdict({ bytes: -1 }), true, "바이트가 음수(이상값)인데 진행 중으로 봤다");

// ── 배선 확인 — 관측 장치가 죽어 '전부 false' 로 통과하는 vacuous test 방지 ──
assert.ok(verdict() === true && verdict({ now: after(STALL - 1) }) === false,
  "판정이 한쪽으로만 나온다 — 이 테스트가 아무것도 구분하지 못하고 있다");

console.log("task-liveness.test: ok (엣지 11행)");
