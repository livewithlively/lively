// #2116 — 세션 열람 presence("지금 보고 있는 사람")의 계약. 사양 엣지 표(E1~E12)를 그대로 옮긴다.
//  틀리면 티가 크다:
//   🔴 마지막 도장 순으로 세우면 — 전원이 15초마다 도장을 다시 찍으므로 얼굴 줄이 15초마다 뒤바뀐다.
//   🔴 TTL 이 도장 주기에 붙으면 — 한 번 놓칠 때마다 얼굴이 깜빡이고, 깜빡임은 "나갔다"로 읽힌다.
//   🔴 자리를 회수 안 하면 — 아무도 안 보는 세션의 map 이 게이트웨이 수명 내내 쌓인다.
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  markViewing, viewersOf, forgetPresence, sweepPresence, presenceSessionCount,
  leaveViewing, presenceShifted, pushViewers,
  PRESENCE_TTL_MS, PRESENCE_STAMP_MS,
} from "./session-presence.js";
import { subscribeNotify, type NotifyEvent } from "../v6/notify-bus.js";
import { hereSlug } from "../v6/notify-scope.js";
import { withTenant } from "../org/tenant-context.js";

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

// ── #3870 — 실시간(원준 2026-09-30: «초대받은 사람의 아바타가 실시간으로 … 잘 안 되는 것 같다») ──────────────
//  종전엔 얼굴 줄이 각자 찍는 도장의 **응답**으로만 바뀌어, 남이 들어온 걸 ≤16초 · 나간 걸 ≤60초 뒤에야 봤다.
//   🔴 떠남이 없으면 — 다른 화면으로 옮겨도 45초 동안 얼굴이 남는다.
//   🔴 밀지 않으면 — 들어온 사람은 제 화면에만 보이고, 먼저 보던 사람 화면엔 다음 도장까지 안 보인다.
//   🔴 하트비트마다 밀면 — 15초마다 같은 줄이 가서 문패가 깜빡인다.
//   🔴 워크스페이스를 안 가르면 — 공유 게이트웨이에서 같은 아이디의 다른 워크스페이스로 얼굴 줄이 샌다.
const face = (id: string) => ({ id, name: id.toUpperCase() });
function listen(member: string, ws = hereSlug()): { got: NotifyEvent[]; close: () => void } {
  const got: NotifyEvent[] = [];
  const sub = subscribeNotify([{ ws, member, label: { slug: ws, name: "", current: true, via: "same" } }], (ev) => { got.push(ev); });
  return { got, close: () => sub.close() };
}

test("E13 떠남 — TTL 을 기다리지 않고 즉시 빠진다 · 없던 사람은 false", () => {
  reset();
  markViewing(S, "yoon", T0);
  markViewing(S, "jang", T0 + 1);
  assert.equal(leaveViewing(S, "jang"), true);
  assert.deepEqual(viewersOf(S, T0 + 2), ["yoon"], "🔴 떠났는데 얼굴이 남았다");
  assert.equal(leaveViewing(S, "jang"), false, "두 번째 떠남은 할 일이 없다");
  assert.equal(leaveViewing(S2, "jang"), false, "도장이 없는 세션");
});

test("E14 바뀐 때만 민다 — 같은 줄은 false · 순서가 바뀌거나 사람이 바뀌면 true · 빈 줄은 기억을 비운다", () => {
  reset();
  assert.equal(presenceShifted(S, ["yoon"]), true, "첫 줄");
  assert.equal(presenceShifted(S, ["yoon"]), false, "🔴 하트비트마다 민다");
  assert.equal(presenceShifted(S, ["yoon", "jang"]), true, "들어왔다");
  assert.equal(presenceShifted(S, ["yoon"]), true, "나갔다");
  assert.equal(presenceShifted(S, []), true, "모두 나갔다");
  assert.equal(presenceShifted(S, []), false, "빈 줄은 한 번만");
  assert.equal(presenceShifted(S, ["yoon"]), true, "비운 뒤 다시 온 사람은 다시 민다");
});

test("E15 ★ 들어오면 그 세션을 보고 있는 사람 **전원**에게 민다 — 먼저 보던 사람도 곧바로 안다", () => {
  reset();
  const y = listen("yoon"); const j = listen("jang"); const k = listen("kim");
  try {
    markViewing(S, "yoon", T0);
    assert.equal(pushViewers(S, [face("yoon")]), 1);
    markViewing(S, "jang", T0 + 1);
    const n = pushViewers(S, [face("yoon"), face("jang")]);
    assert.equal(n, 2, "🔴 먼저 보던 사람(yoon)에게 안 갔다");
    const last = y.got.at(-1) as { type: string; session: string; viewers: Array<{ id: string; name: string }> };
    assert.equal(last.type, "presence");
    assert.equal(last.session, S);
    assert.deepEqual(last.viewers.map((v) => v.id), ["yoon", "jang"]);
    assert.equal(last.viewers[1].name, "JANG", "이름이 함께 간다 — 화면이 누구인지 그릴 재료");
    assert.equal(j.got.length, 1);
    assert.equal(k.got.length, 0, "안 보는 사람에게는 안 간다");
    assert.equal(pushViewers(S, [face("yoon"), face("jang")]), 0, "🔴 하트비트(같은 줄)에 또 밀었다");
  } finally { y.close(); j.close(); k.close(); }
});

test("E16 ★ 떠나면 남은 사람에게 민다 — 떠난 사람 얼굴이 곧바로 걷힌다", () => {
  reset();
  const y = listen("yoon");
  try {
    markViewing(S, "yoon", T0); markViewing(S, "jang", T0 + 1);
    pushViewers(S, viewersOf(S, T0 + 2).map(face));
    const before = y.got.length;
    leaveViewing(S, "jang");
    pushViewers(S, viewersOf(S, T0 + 3).map(face));
    assert.equal(y.got.length, before + 1, "🔴 떠남이 남은 사람에게 안 갔다");
    assert.deepEqual((y.got.at(-1) as { viewers: Array<{ id: string }> }).viewers.map((v) => v.id), ["yoon"]);
  } finally { y.close(); }
});

test("E17 ★ 워크스페이스가 다르면 같은 세션 id·같은 아이디여도 자리가 섞이지 않는다(공유 게이트웨이)", () => {
  reset();
  const A = { id: "t-a", slug: "a" }; const B = { id: "t-b", slug: "b" };
  withTenant(A, () => markViewing(S, "jang", T0));
  assert.deepEqual(withTenant(B, () => viewersOf(S, T0)), [], "🔴 다른 워크스페이스의 도장이 보인다");
  assert.equal(withTenant(B, () => leaveViewing(S, "jang")), false, "🔴 다른 워크스페이스에서 남의 도장을 걷었다");
  assert.deepEqual(withTenant(A, () => viewersOf(S, T0)), ["jang"]);
  const inB = listen("jang", "b");
  try {
    withTenant(A, () => pushViewers(S, [face("jang")]));
    assert.equal(inB.got.length, 0, "🔴 A 의 얼굴 줄이 B 의 같은 아이디로 밀려 갔다");
  } finally { inB.close(); withTenant(A, () => forgetPresence(S)); }
});
