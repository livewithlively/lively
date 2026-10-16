// 수집 주기 판정(#4213 T12 #4744) — 사양 엣지 표 F·I·N·D·P·B 행(순수). DB 쪽(다음 확인 시각을 실제로 적나 · 틱이 누구를 띄우나)은
//  collect-schedule.pg-test.mjs 가 실 Postgres 로 본다.
//
//  사양 요지(상민님 2026-10-15): 주기는 그 단위에 글이 올라오는 빈도로만 정한다. 매번 가볍게 확인하고 없으면 끝낸다.
//   다 읽고 따라잡았으면 주기 뒤 · 밀렸으면 곧바로 · 못 읽었으면 물러선다. 실패가 이어지는 사람은 틱마다 다시 띄우지 않는다.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVITY_RAW_MAX, ACTIVITY_WINDOW_SEC, CATCHUP_DELAY_SEC, QUIET_INTERVAL_SEC, RETRY_BASE_SEC, RETRY_MAX_SEC, UNKNOWN_INTERVAL_SEC,
  activityOf, addSample, dueSinceMs, effectiveIntervalSec, isUnitDue, memberBackoffUntil, nextCheck, pickMembers, recommendIntervalSec,
  retryDelaySec, runFailed, samplesOf,
  type DueGroup, type MemberRunRow,
} from "./schedule-plan.js";

const NOW = 1_800_000_000;          // epoch 초
const D = 86400, H = 3600;
const iso = (sec: number): string => new Date(sec * 1000).toISOString();

// ── F 글 빈도 ──
test("F1 표본 더하기 — 14일 창 밖은 버리고 · 같은 끝 시각은 바꿔 넣고 · 하루 넘은 표본은 날마다 합친다(창은 14일 그대로)", () => {
  assert.deepEqual(addSample([], { e: NOW - 15 * D, s: D, n: 3 }, NOW), [], "창 밖 표본은 남지 않는다");
  assert.deepEqual(addSample([{ e: NOW - 2 * H, s: H, n: 1 }], { e: NOW - 2 * H, s: H, n: 9 }, NOW),
    [{ e: NOW - 2 * H, s: H, n: 9 }], "같은 판(같은 끝 시각)은 한 줄 — 뒤 값");
  //  30분 판을 13일 동안(하루 48판 · 판마다 글 1개) — 판 수와 무관하게 13일이 다 남고, 하루 넘은 판은 날마다 하나다.
  let h: unknown = [];
  for (let t = NOW - 13 * D + 1800; t <= NOW; t += 1800) h = addSample(h, { e: t, s: 1800, n: 1 }, t);
  const arr = samplesOf(h);
  const a = activityOf(arr, NOW);
  assert.ok(a.observedSec >= 13 * D - 1800, `본 시간이 13일 그대로 — ${a.observedSec}`);
  assert.equal(a.perDay, 48, "하루 48개");
  assert.ok(arr.length <= 14 + 48 + 1, `낱개는 최근 하루 몫만 — 줄 수 ${arr.length}`);
  assert.ok(arr.every((x, i) => i === 0 || arr[i - 1].e < x.e), "끝 시각 순");
  assert.ok(arr.filter((x) => x.e <= NOW - D).length <= 14, "하루 넘은 표본은 날마다 하나(13일 구간이 걸치는 날 수 이하)");
});

test("F1b 최근 하루의 낱개가 상한을 넘으면 오래된 것부터 시간마다 합친다(글 수·길이는 그대로)", () => {
  let h: unknown = [];
  for (let i = ACTIVITY_RAW_MAX + 40; i >= 1; i--) h = addSample(h, { e: NOW - i * 300, s: 300, n: 2 }, NOW);
  const arr = samplesOf(h);
  assert.ok(arr.length < ACTIVITY_RAW_MAX + 40 && arr.length <= ACTIVITY_RAW_MAX, `줄 수 ${arr.length}`);
  const total = arr.reduce((t, x) => t + x.n, 0), span = arr.reduce((t, x) => t + x.s, 0);
  assert.equal(total, (ACTIVITY_RAW_MAX + 40) * 2, "글 수는 그대로");
  assert.equal(span, (ACTIVITY_RAW_MAX + 40) * 300, "길이도 그대로");
  assert.equal(arr[arr.length - 1].e, NOW - 300, "가장 새 판은 낱개");
});

test("F1c 평일만 바쁜 채널 — 주말을 지나도 14일 평균이라 주기가 하루로 떨어지지 않는다(리뷰 시뮬레이션)", () => {
  //  평일 08~20시에 하루 100개(30분 판마다 약 4개), 주말 0. 3주를 흘리고 월요일 07시에 본다.
  const MON0 = 1_799_971_200;   // 시험 속 «월요일 00:00» — 요일은 이 값에서 센다(실제 달력 요일과 무관)
  let h: unknown = [];
  let last = 0;
  for (let t = MON0 - 21 * D + 1800; t <= MON0 + 7 * H; t += 1800) {
    const day = Math.floor((t - (MON0 - 21 * D)) / D) % 7;   // 0 = 월
    const hour = Math.floor(((t - (MON0 - 21 * D)) % D) / H);
    const busy = day < 5 && hour >= 8 && hour < 20;
    h = addSample(h, { e: t, s: 1800, n: busy ? 4 : 0 }, t);
    last = t;
  }
  const a = activityOf(h, last);
  assert.ok((a.perDay ?? 0) >= 20, `월요일 아침에도 하루 평균이 높다 — ${a.perDay}`);
  assert.equal(recommendIntervalSec(a.perDay), 1800, "주기 30분 그대로");
});

test("F2 하루 평균 = 본 시간 안의 글 수 ÷ 본 시간 — 6시간도 못 봤으면 모른다(null)", () => {
  const a = activityOf([{ e: NOW - 7 * D, s: 7 * D, n: 14 }, { e: NOW, s: 7 * D, n: 70 }], NOW);
  assert.equal(a.perDay, 6);
  assert.equal(a.samples, 2);
  assert.equal(activityOf([{ e: NOW, s: 6 * H - 1, n: 100 }], NOW).perDay, null, "6시간에서 1초 모자라면 단정하지 않는다");
  assert.equal(activityOf([{ e: NOW, s: 6 * H, n: 3 }], NOW).perDay, 12, "정확히 6시간이면 센다");
});

test("F3 창(14일)에 걸친 표본은 창 안 몫만 센다", () => {
  //  20일 구간에 글 40개 — 창 안 14일 몫 = 28개 / 14일 = 하루 2개.
  const a = activityOf([{ e: NOW, s: 20 * D, n: 40 }], NOW);
  assert.equal(a.observedSec, ACTIVITY_WINDOW_SEC);
  assert.ok(Math.abs((a.perDay ?? 0) - 2) < 1e-9, `perDay=${a.perDay}`);
});

test("F4 모양이 틀린 표본은 버린다(손으로 고친 칸 · 옛 모양)", () => {
  const raw = [{ e: NOW, s: D, n: 1 }, { e: "x", s: D, n: 1 }, { e: NOW, s: 0, n: 1 }, { e: NOW, s: D, n: -1 }, null, 7];
  assert.deepEqual(samplesOf(raw), [{ e: NOW, s: D, n: 1 }]);
  assert.deepEqual(samplesOf({ e: NOW }), []);
  assert.equal(activityOf("깨진 칸", NOW).perDay, null);
});

// ── I 주기 ──
test("I1 주기 표 경계 — 20/5/1/0.2 개, 모르면 1시간", () => {
  const rows: Array<[number | null, number]> = [
    [100, 1800], [20, 1800], [19.99, 3600], [5, 3600], [4.99, 3 * H], [1, 3 * H], [0.99, 12 * H], [0.2, 12 * H],
    [0.19, QUIET_INTERVAL_SEC], [0, QUIET_INTERVAL_SEC], [null, UNKNOWN_INTERVAL_SEC], [Number.NaN, UNKNOWN_INTERVAL_SEC],
  ];
  for (const [perDay, sec] of rows) assert.equal(recommendIntervalSec(perDay), sec, `perDay=${perDay}`);
});

test("I2 자동이면 빈도에서 · 고정이면 정한 값 · 고정인데 값이 없으면 모를 때의 값", () => {
  const busy = [{ e: NOW, s: D, n: 48 }];
  assert.equal(effectiveIntervalSec({ interval_sec: 86400, interval_auto: true }, busy, NOW), 1800, "자동 — 저장된 값이 아니라 빈도");
  assert.equal(effectiveIntervalSec({ interval_sec: 7200, interval_auto: false }, busy, NOW), 7200, "고정 — 빈도와 무관");
  assert.equal(effectiveIntervalSec({ interval_sec: null, interval_auto: false }, busy, NOW), UNKNOWN_INTERVAL_SEC);
  assert.equal(effectiveIntervalSec({ interval_sec: null, interval_auto: true }, [], NOW), UNKNOWN_INTERVAL_SEC, "표본이 없으면 모른다");
});

// ── N 다음 확인 시각 ──
test("N1 다 읽고 따라잡음 → 주기 뒤 · 실패 수 0", () => {
  assert.deepEqual(nextCheck({ nowSec: NOW, intervalSec: 3 * H, outcome: "complete", fails: 4 }), { nextSec: NOW + 3 * H, fails: 0, why: "interval" });
});
test("N2 다 읽었지만 밀림(다음 구간도 지금보다 앞) → 곧바로", () => {
  assert.deepEqual(nextCheck({ nowSec: NOW, intervalSec: 3 * H, outcome: "complete", behind: true, fails: 2 }),
    { nextSec: NOW + CATCHUP_DELAY_SEC, fails: 0, why: "catchup" });
});
test("N4 못 다 읽음 + 구간을 줄였다(슬랙·지메일) → 곧바로 · 실패 수는 그대로", () => {
  assert.deepEqual(nextCheck({ nowSec: NOW, intervalSec: H, outcome: "incomplete", shrunk: true, fails: 2 }), { nextSec: NOW + CATCHUP_DELAY_SEC, fails: 2, why: "catchup" });
});
test("N4b 못 다 읽음 + 줄일 구간이 없다(노션) → 물러서기 — 곧바로 다시 읽어도 같은 실패라 틱마다 되풀이되지 않게", () => {
  assert.deepEqual(nextCheck({ nowSec: NOW, intervalSec: D, outcome: "incomplete", shrunk: false, fails: 0 }),
    { nextSec: NOW + RETRY_BASE_SEC, fails: 1, why: "retry" });
  assert.equal(nextCheck({ nowSec: NOW, intervalSec: D, outcome: "incomplete" }).why, "retry", "줄였다는 표시가 없으면 줄이지 않은 것");
});
test("N5 못 다 읽음 + 줄였지만 더 못 줄임(stuck) → 물러서기 · 실패 수 + 1", () => {
  assert.deepEqual(nextCheck({ nowSec: NOW, intervalSec: H, outcome: "incomplete", shrunk: true, stuck: true, fails: 1 }),
    { nextSec: NOW + 2 * RETRY_BASE_SEC, fails: 2, why: "retry" });
});
test("N6 안 읽음 · 막힘 → 물러서기가 10분부터 두 배씩, 6시간에서 멈춘다", () => {
  for (const outcome of ["unread", "blocked"] as const) {
    const delays: number[] = [];
    let fails = 0;
    for (let i = 0; i < 9; i++) {
      const r = nextCheck({ nowSec: NOW, intervalSec: D, outcome, fails });
      delays.push(r.nextSec - NOW); fails = r.fails;
      assert.equal(r.why, "retry");
    }
    assert.deepEqual(delays, [600, 1200, 2400, 4800, 9600, 19200, RETRY_MAX_SEC, RETRY_MAX_SEC, RETRY_MAX_SEC], outcome);
    assert.equal(fails, 9, "실패 수는 계속 오른다");
  }
  assert.equal(retryDelaySec(0), RETRY_BASE_SEC, "0 이하는 첫 번으로 본다");
  assert.equal(retryDelaySec(1000), RETRY_MAX_SEC);
});
test("N7 주기는 60초 아래로 내려가지 않는다", () => {
  assert.equal(nextCheck({ nowSec: NOW, intervalSec: 5, outcome: "complete" }).nextSec, NOW + 60);
});

// ── D 때가 됨 ──
test("D1 다음 확인 시각이 있으면 그것만 본다", () => {
  assert.equal(isUnitDue({ next_at: iso(NOW - 1), read_at: iso(NOW - 10), interval_sec: D }, NOW * 1000), true);
  assert.equal(isUnitDue({ next_at: iso(NOW), read_at: null, interval_sec: null }, NOW * 1000), true, "같은 시각이면 때가 됐다");
  assert.equal(isUnitDue({ next_at: iso(NOW + 1), read_at: null, interval_sec: null }, NOW * 1000), false, "처음 읽는 단위도 시각이 남았으면 아니다");
});
test("D2 다음 확인 시각이 없으면 — 처음 읽는 단위는 늘 때가 됐고, 아니면 읽은 시각 + 주기", () => {
  assert.equal(isUnitDue({ next_at: null, read_at: null, interval_sec: D }, NOW * 1000), true);
  assert.equal(isUnitDue({ next_at: null, read_at: iso(NOW - H), interval_sec: H }, NOW * 1000), true, "정확히 주기");
  assert.equal(isUnitDue({ next_at: null, read_at: iso(NOW - H + 1), interval_sec: H }, NOW * 1000), false, "주기에서 1초 모자람");
  assert.equal(isUnitDue({ next_at: null, read_at: iso(NOW - UNKNOWN_INTERVAL_SEC + 5), interval_sec: null }, NOW * 1000), false, "주기가 비면 1시간");
  assert.equal(isUnitDue({ next_at: null, read_at: iso(NOW - UNKNOWN_INTERVAL_SEC), interval_sec: null }, NOW * 1000), true);
});
test("D3 때가 된 시각 — 처음 읽는 단위가 맨 앞(0), 아니면 다음 확인 시각 · 읽은 시각 + 주기", () => {
  assert.equal(dueSinceMs({ next_at: null, read_at: null, interval_sec: H }), 0);
  assert.equal(dueSinceMs({ next_at: iso(NOW), read_at: iso(NOW - D), interval_sec: H }), NOW * 1000);
  assert.equal(dueSinceMs({ next_at: null, read_at: iso(NOW), interval_sec: H }), (NOW + H) * 1000);
});

// ── P 띄울 구성원 ──
const g = (member: string, oldestDueMs: number, units = 1): DueGroup => ({ member, oldestDueMs, units });
test("P1 가장 오래 기다린 사람부터 · 같으면 구성원 id 순 · 빈 자리만큼", () => {
  const r = pickMembers([g("c", 5), g("b", 1), g("a", 5), g("d", 9)], { running: new Set(), backoffUntilMs: new Map(), nowMs: 100, slots: 3 });
  assert.deepEqual(r.map((x) => x.member), ["b", "a", "c"]);
});
test("P2 도는 사람 · 아직 물러선 사람 · 맡은 단위가 없는 사람은 뺀다(물러섬이 끝났으면 넣는다)", () => {
  const r = pickMembers([g("a", 1), g("b", 2), g("c", 3), g("d", 4, 0), g("e", 5)], {
    running: new Set(["a"]), backoffUntilMs: new Map([["b", 101], ["c", 100]]), nowMs: 100, slots: 9,
  });
  assert.deepEqual(r.map((x) => x.member), ["c", "e"]);
});
test("P3 빈 자리가 없으면 아무도 안 띄운다", () => {
  assert.deepEqual(pickMembers([g("a", 1)], { running: new Set(), backoffUntilMs: new Map(), nowMs: 0, slots: 0 }), []);
  assert.deepEqual(pickMembers([g("a", 1)], { running: new Set(), backoffUntilMs: new Map(), nowMs: 0, slots: -2 }), []);
});

// ── B 구성원 물러서기 ──
const run = (o: Partial<MemberRunRow>): MemberRunRow => ({ started_ms: 0, ended_ms: null, outcome: "ok", ingest_state: "done", ...o });
test("B1 실패로 셀 판 — 성공·턴 상한은 아님(저장 단계가 됐으면) · 저장 단계 실패는 실패 · 끝을 모르면 셈 밖", () => {
  assert.equal(runFailed(run({})), false);
  assert.equal(runFailed(run({ outcome: "max_turns" })), false);
  assert.equal(runFailed(run({ outcome: "ok", ingest_state: "failed" })), true);
  assert.equal(runFailed(run({ outcome: "max_turns", ingest_state: "failed" })), true);
  for (const o of ["timeout", "gone", "lost", "oom", "error", "login", "quota", "no_connector", "connector_load", "canceled"]) {
    assert.equal(runFailed(run({ outcome: o })), true, o);
  }
  assert.equal(runFailed(run({ outcome: null })), null);
});
test("B2 최근부터 연달아 실패한 수만큼 — 마지막 실패(끝난 시각) 뒤 물러서기", () => {
  const rows = [
    run({ started_ms: 9_000, ended_ms: 9_500, outcome: "timeout" }),
    run({ started_ms: 8_000, outcome: null }),                        // 끝을 모르는 판은 건너뛰고 센다
    run({ started_ms: 7_000, ended_ms: 7_100, outcome: "ok", ingest_state: "failed" }),
    run({ started_ms: 6_000, ended_ms: 6_100, outcome: "ok" }),      // 성공에서 멈춘다
    run({ started_ms: 5_000, ended_ms: 5_100, outcome: "error" }),
  ];
  assert.equal(memberBackoffUntil(rows), 9_500 + retryDelaySec(2) * 1000);
  assert.equal(memberBackoffUntil([run({ started_ms: 4_000, outcome: "gone" })]), 4_000 + RETRY_BASE_SEC * 1000, "끝난 시각이 없으면 시작 시각");
  assert.equal(memberBackoffUntil([run({}), run({ outcome: "error" })]), null, "가장 새 판이 성공이면 물러서지 않는다");
  assert.equal(memberBackoffUntil([]), null);
});
