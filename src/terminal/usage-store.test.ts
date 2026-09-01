import { strict as assert } from "node:assert";
import test from "node:test";
import { recordUsage, getUsage } from "./usage-store.js";

// ── 게이트웨이 사용량 스토어(in-memory) 사양테스트 — 대상 B ──────────────────────────
//  근거: scratchpad/usage-spec.md 대상 B. 각 행위·엣지당 한 단언(입력 중복 단언 금지).
//
// 스토어는 모듈 전역 Map 이라 테스트가 서로 오염된다 → 각 테스트는 자기 이름 슬러그를
//  account id 로 써서 격리한다. TTL(15분) 경과는 실제 대기 대신 nowMs 주입으로 시뮬레이트.
//  핵심 원칙 "값 없음=모름(≠0%)"의 서버측 방어: 음수/>100 클램프, 오래된 값 TTL 만료.

test("recordUsage/getUsage: 유효 두 창 기록 후 nowMs·값과 함께 반환", () => {
  const acc = "record-basic";
  assert.equal(recordUsage(acc, {
    five_hour: { used_percentage: 23, resets_at: 1000 },
    seven_day: { used_percentage: 41, resets_at: 2000 },
  }, 5000), true);
  assert.deepEqual(getUsage(acc, 5000), {
    five_hour: { used_percentage: 23, resets_at: 1000 },
    seven_day: { used_percentage: 41, resets_at: 2000 },
    at: 5000,
  });
});

test("recordUsage: used_percentage 음수는 0 으로 클램프", () => {
  const acc = "clamp-neg";
  recordUsage(acc, { five_hour: { used_percentage: -5, resets_at: 1000 } }, 0);
  assert.equal(getUsage(acc, 0)!.five_hour!.used_percentage, 0);
});

test("recordUsage: used_percentage 100 초과는 100 으로 클램프", () => {
  const acc = "clamp-over";
  recordUsage(acc, { five_hour: { used_percentage: 150, resets_at: 1000 } }, 0);
  assert.equal(getUsage(acc, 0)!.five_hour!.used_percentage, 100);
});

test("recordUsage: resets_at 수치면 그대로, 없으면 null", () => {
  const acc = "resets-at";
  recordUsage(acc, {
    five_hour: { used_percentage: 10, resets_at: 12345 },
    seven_day: { used_percentage: 20 },
  }, 0);
  const got = getUsage(acc, 0)!;
  assert.equal(got.five_hour!.resets_at, 12345);
  assert.equal(got.seven_day!.resets_at, null);
});

test("recordUsage: 유효 창이 하나도 없으면 false·무기록", () => {
  const acc = "no-valid-window";
  assert.equal(recordUsage(acc, { five_hour: { used_percentage: "abc" } }, 0), false);
  assert.equal(getUsage(acc, 0), null);
});

test("recordUsage: account 가 빈 문자열이면 false·무기록", () => {
  assert.equal(recordUsage("", { five_hour: { used_percentage: 10, resets_at: 1000 } }, 0), false);
});

test("getUsage: account 가 falsy 면 null", () => {
  assert.equal(getUsage("", 0), null);
});

test("getUsage: 기록이 전혀 없으면 null", () => {
  assert.equal(getUsage("never-recorded", 0), null);
});

test("recordUsage: 같은 계정 재기록은 last-write-wins 로 전체 덮어쓰기", () => {
  const acc = "last-write-wins";
  recordUsage(acc, {
    five_hour: { used_percentage: 10, resets_at: 1000 },
    seven_day: { used_percentage: 20, resets_at: 2000 },
  }, 0);
  recordUsage(acc, { five_hour: { used_percentage: 30, resets_at: 3000 } }, 100);
  assert.deepEqual(getUsage(acc, 100), {
    five_hour: { used_percentage: 30, resets_at: 3000 },
    at: 100,
  });
});

test("getUsage: TTL(15분) 초과면 null(t=0 기록, t=16분 조회)", () => {
  const acc = "ttl-expired";
  recordUsage(acc, { five_hour: { used_percentage: 50, resets_at: 1000 } }, 0);
  assert.equal(getUsage(acc, 16 * 60 * 1000), null);
});

test("getUsage: TTL 이내면 값 반환(t=0 기록, t=14분 조회)", () => {
  const acc = "ttl-within";
  recordUsage(acc, { five_hour: { used_percentage: 50, resets_at: 1000 } }, 0);
  const got = getUsage(acc, 14 * 60 * 1000);
  assert.notEqual(got, null);
  assert.equal(got!.five_hour!.used_percentage, 50);
});
