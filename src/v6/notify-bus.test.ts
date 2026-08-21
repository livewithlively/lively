import { strict as assert } from "node:assert";
import test from "node:test";
import { subscribeNotify, publishNotify, notifyStreamCount, sessionEventKey, type NotifySessionEvent } from "./notify-bus.js";

// ── 실시간 알림 버스 (#1842) ────────────────────────────────────────────────
// 이 버스가 조용히 고장 나는 방식은 둘이다 — ① 해지가 안 걸려 죽은 소켓이 쌓인다(앱을 껐다 켤 때마다)
//  ② 한 스트림이 던진 예외가 다른 기기의 알림까지 막는다. 아래가 그 둘을 표로 못박는다.

const ev = (id: string): NotifySessionEvent =>
  ({ type: "session", id, name: "테스트", prev: "busy", phase: "idle", key: sessionEventKey(id, "idle", 1), ts: 1 });

test("발행은 그 사람에게만 간다 — 남의 사건이 내 스트림으로 새지 않는다", () => {
  const mine: string[] = [], other: string[] = [];
  const offA = subscribeNotify("alice", (e) => mine.push(e.id));
  const offB = subscribeNotify("bob", (e) => other.push(e.id));
  assert.equal(publishNotify("alice", ev("s1")), 1);
  assert.deepEqual(mine, ["s1"]);
  assert.deepEqual(other, [], "다른 사람에게 샜다");
  offA(); offB();
});

test("한 사람이 PC 여러 대에서 앱을 켜면 전부에 뜬다(슬랙과 같은 모델)", () => {
  const a: string[] = [], b: string[] = [];
  const off1 = subscribeNotify("alice", (e) => a.push(e.id));
  const off2 = subscribeNotify("alice", (e) => b.push(e.id));
  assert.equal(publishNotify("alice", ev("s2")), 2);
  assert.deepEqual([a, b], [["s2"], ["s2"]]);
  off1(); off2();
});

test("★ 해지하면 구독이 완전히 사라진다 — 안 그러면 앱을 껐다 켤 때마다 죽은 소켓이 쌓인다", () => {
  const off = subscribeNotify("alice", () => { /* noop */ });
  assert.equal(notifyStreamCount("alice"), 1);
  off();
  assert.equal(notifyStreamCount("alice"), 0);
  assert.equal(notifyStreamCount(), 0, "빈 Set 이 멤버 수만큼 남아 있다(누수)");
  assert.equal(publishNotify("alice", ev("s3")), 0, "해지한 뒤에도 전달을 시도한다");
  off();   // 두 번 불러도 안전해야 한다(close·error 가 함께 오는 경로가 있다)
  assert.equal(notifyStreamCount(), 0);
});

test("★ 한 스트림이 던져도 나머지는 받는다 — 끊긴 소켓 하나가 다른 기기의 알림을 막으면 안 된다", () => {
  const got: string[] = [];
  const off1 = subscribeNotify("alice", () => { throw new Error("이 소켓은 죽었다"); });
  const off2 = subscribeNotify("alice", (e) => got.push(e.id));
  assert.equal(publishNotify("alice", ev("s4")), 1, "던진 쪽은 전달 성공으로 세지 않는다");
  assert.deepEqual(got, ["s4"]);
  off1(); off2();
});

test("구독자가 없으면 아무 일도 하지 않는다 — 훅 보고는 핫패스다", () => {
  assert.equal(publishNotify("nobody", ev("s5")), 0);
  assert.equal(publishNotify("", ev("s6")), 0);
});

test("신원 없는 구독은 만들지 않는다(해지 함수는 그래도 돌려준다)", () => {
  const off = subscribeNotify("", () => { /* noop */ });
  assert.equal(notifyStreamCount(), 0);
  assert.doesNotThrow(() => off());
});

test("사건 키는 세션·단계·초가 같으면 같다(재시도·중복 보고를 한 사건으로 흡수)", () => {
  assert.equal(sessionEventKey("box-a", "idle", 100), sessionEventKey("box-a", "idle", 100));
  assert.notEqual(sessionEventKey("box-a", "idle", 100), sessionEventKey("box-a", "idle", 101));
  assert.notEqual(sessionEventKey("box-a", "idle", 100), sessionEventKey("box-b", "idle", 100));
});
