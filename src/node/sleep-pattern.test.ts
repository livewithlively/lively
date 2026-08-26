// 순수 단위 체크(node:assert) — 노드 링크 이력의 잠자기 패턴 추정(#1849). 근거는 sleep-pattern.ts 머리말.
// 실행: npm run build && node dist/node/sleep-pattern.test.js
// 사양·엣지 표: 스크래치패드 spec-sleep-pattern.md (행 번호 = 아래 D<n>)
import assert from "node:assert/strict";
import {
  diagnoseLink, WINDOW_MS, SHORT_UP_MS, LONG_GAP_MS, MIN_CYCLES, HEALTHY_UP_MS, type LinkEvent,
} from "./sleep-pattern.js";
import { reconnectDelayMs, BACKOFF_MAX_MS, JITTER } from "./reconnect-delay.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const NOW = 1_787_500_000_000;
const s = (n: number): number => n * 1000;
const m = (n: number): number => n * 60_000;

/** 이벤트 만들기 — `[연결유지ms, 다음연결까지공백ms]` 를 과거→현재 순으로 쌓는다(끝은 `endsOpen` 로 결정). */
function timeline(pairs: Array<[up: number, gap: number]>, opts: { endsOpen?: number; now?: number } = {}): LinkEvent[] {
  const now = opts.now ?? NOW;
  // 총 길이를 먼저 재서 now 에 맞춰 뒤로 붙인다(창 밖으로 새지 않게).
  const total = pairs.reduce((a, [u, g]) => a + u + g, 0) + (opts.endsOpen ?? 0);
  let cur = now - total;
  const out: LinkEvent[] = [];
  for (const [up, gap] of pairs) {
    out.push({ at: cur, ev: "up" });
    cur += up;
    out.push({ at: cur, ev: "down" });
    cur += gap;
  }
  if (opts.endsOpen !== undefined) out.push({ at: now - opts.endsOpen, ev: "up" });
  return out;
}

// ── 표본·기본 (D1, D2, D9, D15) ────────────────────────────────────────────────
t("D1 이벤트가 없으면 판정하지 않는다", () => {
  const d = diagnoseLink([], NOW);
  assert.equal(d.suspected, null);
  assert.equal(d.cycles, 0);
});
t("D2 완결 구간이 2개뿐이면 판정하지 않는다 — 2회는 우연일 수 있다", () => {
  const d = diagnoseLink(timeline([[s(60), m(60)], [s(60), m(60)]]), NOW);
  assert.equal(d.cycles, 2);
  assert.equal(d.suspected, null);
});
t("D9 전부 창(24h) 밖이면 판정하지 않는다", () => {
  const old = timeline([[s(60), m(60)], [s(60), m(60)], [s(60), m(60)], [s(60), m(60)]], { now: NOW - WINDOW_MS - m(10) });
  const d = diagnoseLink(old, NOW);
  assert.equal(d.cycles, 0);
  assert.equal(d.suspected, null);
});
t("D15 ★경계 — 완결 구간이 정확히 최소치(3)면 판정할 수 있다", () => {
  const d = diagnoseLink(timeline([[s(60), m(60)], [s(60), m(60)], [s(60), m(60)]]), NOW);
  assert.equal(d.cycles, MIN_CYCLES);
  assert.equal(d.suspected, "sleep");
});

// ── 핵심 판정 (D3~D6, D17) ────────────────────────────────────────────────────
t("D3 ★실측 패턴 — 60초 연결이 1시간 간격으로 반복되면 잠자기로 추정한다", () => {
  const d = diagnoseLink(timeline([[s(62), m(59)], [s(58), m(59)], [s(64), m(59)], [s(56), m(59)]]), NOW);
  assert.equal(d.suspected, "sleep");
  assert.equal(d.cycles, 4);
  assert.ok(d.medianUpSec >= 56 && d.medianUpSec <= 64, `연결 중앙값이 실측 범위여야: ${d.medianUpSec}`);
  assert.ok(d.medianGapSec > 3000, `공백 중앙값이 커야: ${d.medianGapSec}`);
});
t("D4 건강한 노드 — 8시간 붙어 있다 재부팅 한 번이면 판정하지 않는다", () => {
  const d = diagnoseLink(timeline([[m(480), m(2)], [m(480), m(2)], [m(300), m(2)]]), NOW);
  assert.equal(d.suspected, null);
});
t("D5 ★짧은 연결이 반복돼도 공백이 짧으면 잠자기가 아니다 — 그건 네트워크 플랩이다", () => {
  // 공백 30초 = 재연결 백오프 범위. 프로세스가 깨어 있다는 뜻이므로 잠자기로 부르면 안 된다.
  const d = diagnoseLink(timeline([[s(60), s(30)], [s(60), s(30)], [s(60), s(30)], [s(60), s(30)]]), NOW);
  assert.equal(d.suspected, null, "공백이 짧으면 머신은 깨어 있다");
});
t("D6 ★공백이 길어도 연결이 길면 잠자기가 아니다 — 밤에 꺼 둔 PC", () => {
  const d = diagnoseLink(timeline([[m(120), m(600)], [m(120), m(600)], [m(120), m(60)]]), NOW);
  assert.equal(d.suspected, null);
});
t("D17 ★경계 — 짧은 연결이 정확히 절반이면 판정하지 않는다(과반이어야 한다)", () => {
  const d = diagnoseLink(timeline([[s(60), m(60)], [s(60), m(60)], [m(30), m(60)], [m(30), m(60)]]), NOW);
  assert.equal(d.cycles, 4);
  assert.equal(d.suspected, null, "반반은 패턴이 아니라 잡음이다");
});

// ── 지금 상태 우선 (D7, D8) ───────────────────────────────────────────────────
t("D7 ★지금 30분 넘게 붙어 있으면 과거 이력으로 경고하지 않는다 — 해결된 문제를 경고하면 거짓말이다", () => {
  const d = diagnoseLink(timeline([[s(60), m(60)], [s(60), m(60)], [s(60), m(60)]], { endsOpen: HEALTHY_UP_MS + m(5) }), NOW);
  assert.equal(d.suspected, null);
  assert.equal(d.cycles, 3, "판정은 접어도 근거 수치는 그대로 보인다");
});
t("D8 지금 붙어 있어도 얼마 안 됐으면(5분) 여전히 잠자기로 추정한다", () => {
  const d = diagnoseLink(timeline([[s(60), m(60)], [s(60), m(60)], [s(60), m(60)]], { endsOpen: m(5) }), NOW);
  assert.equal(d.suspected, "sleep");
});

// ── 깨진 입력 방어 (D10~D12, D16) ─────────────────────────────────────────────
t("D10 창 경계의 고아 down 은 버리고 나머지로 판정한다 — 시작을 모르는 구간 길이를 지어내지 않는다", () => {
  const evs: LinkEvent[] = [{ at: NOW - m(200), ev: "down" }, ...timeline([[s(60), m(60)], [s(60), m(60)], [s(60), m(60)]])];
  const d = diagnoseLink(evs, NOW);
  assert.equal(d.cycles, 3, "고아 down 이 구간 수를 늘리면 안 된다");
  assert.equal(d.suspected, "sleep");
});
t("D11 해제가 유실돼 up 이 연달아 와도 앞 up 을 버리고 계속한다", () => {
  const base = timeline([[s(60), m(60)], [s(60), m(60)], [s(60), m(60)]]);
  const evs: LinkEvent[] = [...base];
  evs.splice(2, 0, { at: base[1].at + 1000, ev: "up" });   // down 뒤에 up, 그 뒤 또 up
  const d = diagnoseLink(evs, NOW);
  assert.ok(d.cycles >= 2, "구간이 통째로 사라지면 안 된다");
  assert.ok(Number.isFinite(d.medianUpSec) && d.medianUpSec >= 0, "음수 길이가 나오면 안 된다");
});
t("D12 ★입력 순서에 판정이 좌우되지 않는다 — 뒤섞여 들어와도 같은 결론", () => {
  const evs = timeline([[s(60), m(60)], [s(60), m(60)], [s(60), m(60)], [s(60), m(60)]]);
  const shuffled = [evs[5], evs[0], evs[7], evs[2], evs[1], evs[6], evs[4], evs[3]];
  assert.deepEqual(diagnoseLink(shuffled, NOW), diagnoseLink(evs, NOW));
});
t("D16 ★now 가 이벤트보다 과거(시계 역행)여도 던지지 않고 판정하지 않는다", () => {
  const evs = timeline([[s(60), m(60)], [s(60), m(60)], [s(60), m(60)]]);
  const d = diagnoseLink(evs, NOW - m(600));
  assert.equal(d.suspected, null);
  assert.ok(d.cycles >= 0);
  assert.equal(diagnoseLink(evs, NaN).suspected, null);
});

// ── 경계값 (D13, D14) ─────────────────────────────────────────────────────────
t("D13 ★경계 — 연결 지속이 정확히 임계면 '짧음'이 아니다(< 이지 <= 가 아니다)", () => {
  const exact = diagnoseLink(timeline([[SHORT_UP_MS, m(60)], [SHORT_UP_MS, m(60)], [SHORT_UP_MS, m(60)]]), NOW);
  assert.equal(exact.suspected, null);
  const below = diagnoseLink(timeline([[SHORT_UP_MS - 1, m(60)], [SHORT_UP_MS - 1, m(60)], [SHORT_UP_MS - 1, m(60)]]), NOW);
  assert.equal(below.suspected, "sleep");
});
t("D14 ★경계 — 공백이 정확히 임계면 '긺'이 아니다(> 이지 >= 가 아니다)", () => {
  const exact = diagnoseLink(timeline([[s(60), LONG_GAP_MS], [s(60), LONG_GAP_MS], [s(60), LONG_GAP_MS]]), NOW);
  assert.equal(exact.suspected, null);
  const above = diagnoseLink(timeline([[s(60), LONG_GAP_MS + 1], [s(60), LONG_GAP_MS + 1], [s(60), LONG_GAP_MS + 1]]), NOW);
  assert.equal(above.suspected, "sleep");
});

// ── 근거 노출 (D18) ───────────────────────────────────────────────────────────
t("D18 판정과 함께 근거 수치를 돌려준다 — 화면이 '왜 그렇게 봤는지'를 말할 수 있어야 한다", () => {
  const d = diagnoseLink(timeline([[s(60), m(60)], [s(60), m(60)], [s(60), m(60)]]), NOW);
  assert.equal(d.suspected, "sleep");
  assert.equal(d.cycles, 3);
  assert.equal(d.medianUpSec, 60);
  assert.equal(d.medianGapSec, 3600);
});

t("D19 ★임계값의 근거를 실제 재연결 로직과 대조한다 — 백오프가 바뀌면 이 판정의 전제가 조용히 무너진다", () => {
  // '긴 공백'의 근거는 "프로세스가 깨어 있으면 이 안에 반드시 다시 붙는다" 이다.
  //  그 상한을 상수로 베끼지 않고 **실제 함수를 돌려** 최악값을 잰다(#1865 로 로직이 두 구간으로 갈렸다).
  let worst = 0;
  for (let attempt = 0; attempt < 50; attempt++) {
    for (const rand of [0, 0.5, 1]) worst = Math.max(worst, reconnectDelayMs(attempt, rand));
  }
  assert.equal(worst, Math.round(BACKOFF_MAX_MS * (1 + JITTER)), "최악 재연결 지연 = 상한 + 지터");
  assert.ok(LONG_GAP_MS > worst * 5,
    `'긴 공백'(${LONG_GAP_MS}ms)이 최악 재연결 지연(${worst}ms)의 5배는 돼야 깨어 있는 노드를 잠자기로 오판하지 않는다`);
  // 반대 방향도 — 임계가 너무 크면 실측 패턴(공백 ≈ 1시간)을 못 잡는다.
  assert.ok(LONG_GAP_MS < 30 * 60_000, "임계가 30분을 넘으면 실측 잠자기 주기(1시간)를 잡기 어려워진다");
});

console.log(`\n${pass} checks passed`);
