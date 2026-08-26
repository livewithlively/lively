// #2116 — 세션 열람 presence("지금 보고 있는 사람")의 계약. 사양 엣지 표(E1~E12)를 그대로 옮긴다.
//  틀리면 티가 크다:
//   🔴 마지막 도장 순으로 세우면 — 전원이 15초마다 도장을 다시 찍으므로 얼굴 줄이 15초마다 뒤바뀐다.
//   🔴 TTL 이 도장 주기에 붙으면 — 한 번 놓칠 때마다 얼굴이 깜빡이고, 깜빡임은 "나갔다"로 읽힌다.
//   🔴 자리를 회수 안 하면 — 아무도 안 보는 세션의 map 이 게이트웨이 수명 내내 쌓인다.
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  markViewing, viewersOf, forgetPresence, sweepPresence, presenceSessionCount,
  PRESENCE_TTL_MS, PRESENCE_STAMP_MS,
} from "./session-presence.js";

const S = "box-yoon-1a2b3c4d";
const S2 = "box-jang-05ab7578";
const T0 = 1_700_000_000_000;

// 이 모듈은 프로세스 전역 상태다 — 시나리오마다 손수 비운다(테스트끼리 새는 것을 막는다).
const reset = (): void => { forgetPresence(S); forgetPresence(S2); };

test("E1 도장이 한 번도 없는 세션 — 아무도 없다", () => {
  reset();
  assert.deepEqual(viewersOf(S, T0), []);
});

test("E2 한 명이 도장 → 즉시 보인다", () => {
  reset();
  markViewing(S, "yoon", T0);
  assert.deepEqual(viewersOf(S, T0), ["yoon"]);
});

test("E3 먼저 도장한 사람이 앞", () => {
  reset();
  markViewing(S, "yoon", T0);
  markViewing(S, "jang", T0 + 1000);
  assert.deepEqual(viewersOf(S, T0 + 2000), ["yoon", "jang"]);
});

test("E4 ★ 하트비트로 재도장해도 자리가 그대로다", () => {
  reset();
  markViewing(S, "yoon", T0);
  markViewing(S, "jang", T0 + 1000);
  // 15초 하트비트 두 바퀴 — 먼저 온 yoon 이 계속 앞이어야 한다.
  markViewing(S, "yoon", T0 + PRESENCE_STAMP_MS);
  markViewing(S, "jang", T0 + PRESENCE_STAMP_MS + 1000);
  markViewing(S, "yoon", T0 + PRESENCE_STAMP_MS * 2);
  assert.deepEqual(viewersOf(S, T0 + PRESENCE_STAMP_MS * 2), ["yoon", "jang"],
    "🔴 마지막 도장 순으로 세우면 15초마다 얼굴 줄이 뒤바뀐다");
});

test("E5 ★ 경계 — 마지막 도장 + 정확히 TTL 은 아직 보고 있는 것", () => {
  reset();
  markViewing(S, "yoon", T0);
  assert.deepEqual(viewersOf(S, T0 + PRESENCE_TTL_MS), ["yoon"]);
});

test("E6 경계 — TTL + 1ms 면 사라진다", () => {
  reset();
  markViewing(S, "yoon", T0);
  assert.deepEqual(viewersOf(S, T0 + PRESENCE_TTL_MS + 1), []);
});

test("E7 한 명만 만료 — 나머지는 남고 순서도 유지", () => {
  reset();
  markViewing(S, "yoon", T0);
  markViewing(S, "jang", T0 + 1000);
  markViewing(S, "daon", T0 + 2000);
  markViewing(S, "yoon", T0 + 5000);   // yoon·daon 은 계속 보고 있고 jang 만 나갔다
  markViewing(S, "daon", T0 + 5000);
  assert.deepEqual(viewersOf(S, T0 + 5000 + PRESENCE_TTL_MS), ["yoon", "daon"]);
});

test("E8 만료된 사람이 다시 오면 새 도착 — 맨 뒤에 선다", () => {
  reset();
  markViewing(S, "yoon", T0);
  markViewing(S, "jang", T0 + 1000);
  const late = T0 + PRESENCE_TTL_MS + 10;      // yoon 은 이미 만료된 시점
  markViewing(S, "jang", late);                 // jang 은 계속 보고 있었다
  markViewing(S, "yoon", late);                 // yoon 이 다시 들어왔다
  assert.deepEqual(viewersOf(S, late), ["jang", "yoon"],
    "🔴 만료된 뒤 돌아온 사람에게 옛 앞자리를 돌려주면 '계속 있었다'는 거짓말이 된다");
});

test("E9 빈 신원은 도장을 못 찍는다", () => {
  reset();
  markViewing(S, "", T0);
  markViewing("", "yoon", T0);
  assert.deepEqual(viewersOf(S, T0), []);
  assert.deepEqual(viewersOf("", T0), []);
});

test("E10 전원 만료 뒤 sweep — 세션 자리 자체를 회수한다", () => {
  reset();
  markViewing(S, "yoon", T0);
  markViewing(S2, "jang", T0);
  const before = presenceSessionCount();
  assert.ok(before >= 2, "🔴 관측 장치가 죽어 있다 — 도장을 찍었는데 세션 수가 안 늘었다");
  sweepPresence(T0 + PRESENCE_TTL_MS + 1);
  assert.equal(presenceSessionCount(), before - 2, "🔴 아무도 안 보는 세션의 자리가 안 비워졌다");
});

test("E11 TTL 은 도장 주기의 3배 이상 — 한 번 놓쳐도 안 깜빡이게", () => {
  assert.ok(PRESENCE_TTL_MS >= PRESENCE_STAMP_MS * 3);
});

test("E12 forgetPresence — 즉시 빈다", () => {
  reset();
  markViewing(S, "yoon", T0);
  forgetPresence(S);
  assert.deepEqual(viewersOf(S, T0), []);
});
