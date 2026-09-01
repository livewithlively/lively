#!/usr/bin/env node
// 세션 사용량(rate-limit 소진율) statusLine 순수로직 사양테스트 — 대상 A.
//  실행: node kit/hooks/usage-report.test.mjs   (kit/**/*.test.mjs 라 npm test 체인에 자동 포함)
//  근거: scratchpad/usage-spec.md 대상 A. 각 행위·엣지당 한 단언(입력 중복 단언 금지).
//
// 왜 이 테스트인가 — 핵심 도메인 원칙은 "값이 없으면 모름이지 0%가 아니다"다.
//  가짜 0/빈 뱃지를 만들면 관리자가 '안 쓴 계정'으로 오판한다 → 부재·비수치·비유한을
//  '무효 창'으로 떨구는 경계, 반올림 정수화, 스로틀 게이트를 못박는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRateLimits, usageSignature, shouldReport } from "./usage-report.mjs";

// ── extractRateLimits(input) — statusLine JSON → 정규화 rate_limits | null ──────────
test("extractRateLimits: 두 창 모두 유한 수치면 둘 다 포함(resets_at 그대로)", () => {
  const got = extractRateLimits({ rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1000 },
    seven_day: { used_percentage: 41.2, resets_at: 2000 },
  } });
  assert.deepEqual(got, {
    five_hour: { used_percentage: 23.5, resets_at: 1000 },
    seven_day: { used_percentage: 41.2, resets_at: 2000 },
  });
});

test("extractRateLimits: 한 창만 있으면 그 창만(다른 창 키는 결과에 없음)", () => {
  const got = extractRateLimits({ rate_limits: {
    five_hour: { used_percentage: 3, resets_at: 1000 },
  } });
  assert.deepEqual(got, { five_hour: { used_percentage: 3, resets_at: 1000 } });
  assert.equal("seven_day" in got, false);
});

test("extractRateLimits: used_percentage 만 있고 resets_at 없으면 그 창은 유효하되 resets_at=null", () => {
  const got = extractRateLimits({ rate_limits: {
    five_hour: { used_percentage: 50 },
  } });
  assert.deepEqual(got, { five_hour: { used_percentage: 50, resets_at: null } });
});

test("extractRateLimits: rate_limits 부재 → null", () => {
  assert.equal(extractRateLimits({ session: "x" }), null);
});

test("extractRateLimits: rate_limits 빈 객체 → null", () => {
  assert.equal(extractRateLimits({ rate_limits: {} }), null);
});

test("extractRateLimits: used_percentage 비수치(문자열)인 창은 무효 — 유효 창만 남는다", () => {
  const got = extractRateLimits({ rate_limits: {
    five_hour: { used_percentage: "23", resets_at: 1000 },
    seven_day: { used_percentage: 41, resets_at: 2000 },
  } });
  assert.deepEqual(got, { seven_day: { used_percentage: 41, resets_at: 2000 } });
});

test("extractRateLimits: used_percentage 비유한(Infinity)인 창은 무효", () => {
  const got = extractRateLimits({ rate_limits: {
    five_hour: { used_percentage: Infinity, resets_at: 1000 },
    seven_day: { used_percentage: 41, resets_at: 2000 },
  } });
  assert.deepEqual(got, { seven_day: { used_percentage: 41, resets_at: 2000 } });
});

test("extractRateLimits: 유효 창이 하나도 없으면 null(둘 다 비수치)", () => {
  const got = extractRateLimits({ rate_limits: {
    five_hour: { used_percentage: "x" },
    seven_day: { used_percentage: null },
  } });
  assert.equal(got, null);
});

test("extractRateLimits: input 이 null 이면 null", () => {
  assert.equal(extractRateLimits(null), null);
});

test("extractRateLimits: input 이 비객체(숫자)면 null", () => {
  assert.equal(extractRateLimits(42), null);
});

// ── usageSignature(rl) — 반올림 정수 % 만으로 만든 변화감지 서명 ─────────────────────
test("usageSignature: null → 빈 문자열", () => {
  assert.equal(usageSignature(null), "");
});

test("usageSignature: 두 창 → '<5h정수>/<7d정수>'({5h:23.4,7d:41}→'23/41')", () => {
  assert.equal(usageSignature({
    five_hour: { used_percentage: 23.4, resets_at: null },
    seven_day: { used_percentage: 41, resets_at: null },
  }), "23/41");
});

test("usageSignature: five_hour 만({5h:23.4}) → '23/-'", () => {
  assert.equal(usageSignature({ five_hour: { used_percentage: 23.4, resets_at: null } }), "23/-");
});

test("usageSignature: seven_day 만 → '-/<7d정수>'", () => {
  assert.equal(usageSignature({ seven_day: { used_percentage: 41, resets_at: null } }), "-/41");
});

// ── shouldReport(prevSig, curSig, lastAtMs, nowMs, throttleMs) — 보고 게이트 ─────────
test("shouldReport: 값 변화(prev!==cur)면 스로틀 무시하고 항상 true", () => {
  // now-last = 10ms < throttle 60000, 그래도 값이 바뀌면 즉시 보고
  assert.equal(shouldReport("22/40", "23/41", 1000, 1010, 60000), true);
});

test("shouldReport: 같은 시그니처면 경과가 정확히 throttleMs 여도 true(경계 >=)", () => {
  assert.equal(shouldReport("23/41", "23/41", 1000, 61000, 60000), true);
});

test("shouldReport: 같은 시그니처이고 경과 < throttleMs 면 false", () => {
  assert.equal(shouldReport("23/41", "23/41", 1000, 60999, 60000), false);
});

test("shouldReport: 첫 보고(prev='' , lastAtMs=0)는 값이 있으면 true", () => {
  assert.equal(shouldReport("", "23/41", 0, 5, 60000), true);
});
