// 순수 단위 체크(node:assert) — 노드 재연결 지연의 두 구간(#1865). 근거는 reconnect-delay.ts 머리말.
// 실행: npm run build && node dist/node/reconnect-delay.test.js
import assert from "node:assert/strict";
import {
  reconnectDelayMs, BACKOFF_MIN_MS, BACKOFF_FAST_MAX_MS, BACKOFF_MAX_MS, FAST_TRIES, JITTER,
} from "./reconnect-delay.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const NOJIT = 0.5;                                   // 지터 없음(중앙값)
const d = (n: number): number => reconnectDelayMs(n, NOJIT);

t("R1 첫 시도는 곧바로(1초) — 재배포는 대개 금방 끝난다", () => {
  assert.equal(d(0), BACKOFF_MIN_MS);
});
t("R2 초기 구간은 배증하되 5초에서 멈춘다 — 종전엔 8·16·30초까지 갔다", () => {
  assert.equal(d(1), 2_000);
  assert.equal(d(2), 4_000);
  assert.equal(d(3), BACKOFF_FAST_MAX_MS);          // 8초가 아니라 5초
  assert.equal(d(6), BACKOFF_FAST_MAX_MS);
});
t("R3 ★ 촘촘한 구간이 게이트웨이 재시작 창을 덮는다 — 그 안에 누적 50초 이상 두드린다", () => {
  let sum = 0;
  for (let i = 0; i < FAST_TRIES; i++) sum += d(i);
  assert.ok(sum >= 50_000, `누적 ${sum}ms`);
  // 종전 곡선(1·2·4·8·16·30…)은 같은 횟수에 훨씬 적게 두드렸다 — 대기가 길어 시도가 적었다.
  assert.ok(d(3) < 8_000 && d(4) < 16_000);
});
t("R4 촘촘한 구간이 끝나면 느슨해진다 — 오래 죽어 있는 게이트웨이를 계속 두드리지 않는다", () => {
  assert.equal(d(FAST_TRIES), BACKOFF_MAX_MS);
  assert.equal(d(FAST_TRIES + 50), BACKOFF_MAX_MS);
});
t("R5 지터는 ±20% 안에 있고, 최소값 아래로는 안 내려간다", () => {
  const lo = reconnectDelayMs(3, 0);                 // 최저 지터
  const hi = reconnectDelayMs(3, 1);                 // 최고 지터
  assert.ok(lo >= BACKOFF_FAST_MAX_MS * (1 - JITTER) - 1, `lo=${lo}`);
  assert.ok(hi <= BACKOFF_FAST_MAX_MS * (1 + JITTER) + 1, `hi=${hi}`);
  assert.ok(lo < hi, "지터가 실제로 흔들려야 몰림(thundering herd)이 풀린다");
  assert.ok(reconnectDelayMs(0, 0) >= BACKOFF_MIN_MS, "지터가 최소 간격을 깨면 안 된다");
});
t("R6 이상한 입력에도 무너지지 않는다(음수·NaN·소수)", () => {
  assert.equal(d(-5), BACKOFF_MIN_MS);
  assert.equal(d(NaN), BACKOFF_MIN_MS);
  assert.equal(d(2.7), 4_000);
  assert.ok(reconnectDelayMs(3, NaN) > 0);
});
t("C1 상수 관계 — 촘촘 상한 < 느슨 상한, 촘촘 구간은 재시작 창(최악 33초)보다 길다", () => {
  assert.ok(BACKOFF_FAST_MAX_MS < BACKOFF_MAX_MS);
  let sum = 0;
  for (let i = 0; i < FAST_TRIES; i++) sum += reconnectDelayMs(i, NOJIT);
  assert.ok(sum > 33_000, "노드 재연결 최악 33초(백오프 30 + push 3)를 덮어야 의미가 있다");
});

console.log(`\n${pass} passed`);
