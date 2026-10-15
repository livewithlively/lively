// #4695 T5 — «보는 중» 판정(하네스 종료 규칙의 첫째 조건)의 계약. 사양 엣지 표 P1~P12.
//  틀리면 티가 크다:
//   🔴 떠남(/leave)을 즉시 «안 봄» 으로 읽으면 — 새로고침·창 둘 중 하나 닫기만으로 시계가 돈다(T2 §6: 16초 안에 다시 찍는다).
//   🔴 게이트웨이가 막 뜬 45초를 «안 봄» 으로 읽으면 — 롤 직후 보고 있던 세션이 일제히 꺼질 수 있다(도장이 메모리에만 있다).
//   🔴 끝난 시각을 «지금» 으로 잡으면 — 몇 시간 전에 떠난 세션도 시계가 늘 처음부터라 영영 안 꺼진다.
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  viewStateOf, viewState, markViewing, leaveViewing, forgetPresence, LEAVE_GRACE_MS, PRESENCE_TTL_MS,
} from "./session-presence.js";

const NOW = 1_800_000_000_000;
const LONG_AGO = NOW - 3_600_000;   // 게이트웨이가 뜬 지 오래
const at = (o: Partial<Parameters<typeof viewStateOf>[0]>) =>
  viewStateOf({ freshViewers: 0, lastStamp: 0, lastLeave: 0, bootMs: LONG_AGO, now: NOW, ...o });

test("P1 살아 있는 도장이 하나라도 있으면 보는 중", () => {
  assert.deepEqual(at({ freshViewers: 1, lastStamp: NOW - 1000 }), { viewing: true, unknown: false, endedAtMs: 0 });
});
test("P2 도장도 떠남도 없고 게이트웨이가 뜬 지 오래면 안 봄 — 끝난 시각은 모른다(0: 부르는 쪽이 tmux 열람 시각으로 메운다)", () => {
  assert.deepEqual(at({}), { viewing: false, unknown: false, endedAtMs: 0 });
});
test("P3 떠난 지 20초 안(19.999초)은 아직 보는 중(새로고침 유예)", () => {
  assert.equal(at({ lastStamp: NOW - 30_000, lastLeave: NOW - (LEAVE_GRACE_MS - 1) }).viewing, true);
});
test("P4 떠난 지 정확히 20초면 안 봄 — 끝난 시각 = 떠남 + 20초", () => {
  assert.deepEqual(at({ lastStamp: NOW - 30_000, lastLeave: NOW - LEAVE_GRACE_MS }), { viewing: false, unknown: false, endedAtMs: NOW });
});
test("P5 게이트웨이가 뜬 지 44.999초 · 도장 없음 — «모름»(끄지 않는다)", () => {
  assert.deepEqual(at({ bootMs: NOW - (PRESENCE_TTL_MS - 1) }), { viewing: false, unknown: true, endedAtMs: 0 });
});
test("P6 게이트웨이가 뜬 지 정확히 45초면 더는 «모름» 이 아니다", () => {
  assert.equal(at({ bootMs: NOW - PRESENCE_TTL_MS }).unknown, false);
});
test("P7 떠남 없이 도장이 끊겼으면(창을 숨김·네트워크) 끝난 시각 = 마지막 도장 + 45초", () => {
  assert.deepEqual(at({ lastStamp: NOW - 50_000 }), { viewing: false, unknown: false, endedAtMs: NOW - 50_000 + PRESENCE_TTL_MS });
});
test("P8 떠난 뒤 다시 와서 도장이 살아 있으면 보는 중", () => {
  assert.equal(at({ freshViewers: 1, lastStamp: NOW - 2000, lastLeave: NOW - 60_000 }).viewing, true);
});
test("P9 떠남이 마지막 도장보다 앞이면(다시 와서 보다가 끊김) 떠남은 무시 — 끝 = 마지막 도장 + 45초", () => {
  assert.deepEqual(at({ lastStamp: NOW - 50_000, lastLeave: NOW - 120_000 }), { viewing: false, unknown: false, endedAtMs: NOW - 50_000 + PRESENCE_TTL_MS });
});
test("P9b 떠남과 마지막 도장이 같은 시각이면 떠남이 끝을 정한다(떠남은 도장 뒤에만 온다)", () => {
  assert.deepEqual(at({ lastStamp: NOW - 60_000, lastLeave: NOW - 60_000 }), { viewing: false, unknown: false, endedAtMs: NOW - 60_000 + LEAVE_GRACE_MS });
});
test("P10 게이트웨이가 막 떴어도 살아 있는 도장이 있으면 보는 중(«모름» 보다 앞)", () => {
  assert.deepEqual(at({ bootMs: NOW - 1000, freshViewers: 1, lastStamp: NOW - 500 }), { viewing: true, unknown: false, endedAtMs: 0 });
});

// ── 상태를 갖는 쪽(viewState) — 모듈 전역 상태라 시나리오마다 세션 id 를 따로 쓴다 ────────────────────────────
//  이 프로세스가 막 떴으므로(모듈 적재 = 게이트웨이 부팅) «모름» 을 벗어나게 시각을 한 시간 뒤로 잡는다.
const T = Date.now() + 3_600_000;

test("P11 자리에 없던 사람의 떠남은 떠남으로 세지 않는다 · 실제로 비운 떠남만 20초 유예와 끝난 시각을 정한다", () => {
  const S = "box-p11-a";
  markViewing(S, "yoon", T);
  assert.equal(leaveViewing(S, "jang", T + 1000), false, "자리에 없던 사람");
  assert.deepEqual(viewState(S, T + 46_000), { viewing: false, unknown: false, endedAtMs: T + PRESENCE_TTL_MS },
    "🔴 없던 사람의 떠남을 세면 끝난 시각이 그 떠남 + 20초(T+21초)로 당겨진다");
  const S2 = "box-p11-b";
  markViewing(S2, "yoon", T);
  assert.equal(leaveViewing(S2, "yoon", T + 1000), true);
  assert.equal(viewState(S2, T + 1000 + LEAVE_GRACE_MS - 1).viewing, true, "떠난 뒤 20초 안은 보는 중");
  assert.deepEqual(viewState(S2, T + 1000 + LEAVE_GRACE_MS), { viewing: false, unknown: false, endedAtMs: T + 1000 + LEAVE_GRACE_MS });
});
test("P12 세션 자리를 지워도(forgetPresence — 종료·복원) 끝난 시각의 재료는 남는다(같은 id 로 되살린 세션의 시계)", () => {
  const S = "box-p12";
  markViewing(S, "yoon", T);
  forgetPresence(S);
  assert.deepEqual(viewState(S, T + 60_000), { viewing: false, unknown: false, endedAtMs: T + PRESENCE_TTL_MS });
});
