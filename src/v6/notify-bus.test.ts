import { strict as assert } from "node:assert";
import test from "node:test";
import {
  subscribeNotify, publishNotify, notifyStreamCount, sessionEventKey, routeMatches, accountRoutesActive,
  type NotifyRoute, type NotifySessionEvent, type NotifyWorkspace,
} from "./notify-bus.js";

// ── 실시간 알림 버스 (#1842 · #4054) ────────────────────────────────────────────
// 이 버스가 조용히 고장 나는 방식은 넷이다 — ① 해지가 안 걸려 죽은 소켓이 쌓인다(앱을 껐다 켤 때마다)
//  ② 한 스트림이 던진 예외가 다른 기기의 알림까지 막는다 ③ ★ 워크스페이스를 모르는 주소 때문에 **다른
//  워크스페이스의 사건**이 흘러든다(같은 사람이면 눌러도 못 열리는 배너, 다른 사람이면 유출 — #4054)
//  ④ 받는 쪽마다 달라야 할 워크스페이스 표시가 섞인다. 아래가 사양 표 A1~A14 를 한 행씩 못박는다.

const ev = (id: string, extra: Partial<NotifySessionEvent> = {}): NotifySessionEvent =>
  ({ type: "session", id, name: "테스트", prev: "busy", phase: "idle", key: sessionEventKey(id, "idle", 1), ts: 1, ...extra });

const label = (slug: string, current: boolean, via: NotifyWorkspace["via"] = current ? "same" : "enter"): NotifyWorkspace => ({
  slug, name: slug.toUpperCase(), current, via,
  ...(via === "enter" ? { enter: "https://cp.example/ws/00000000-0000-0000-0000-000000000001/enter" } : {}),
});

/** 자기 워크스페이스만 받는 자리(웹 셸, 또는 확인 전의 첫 등록). */
const own = (ws: string, member: string): NotifyRoute[] => [{ ws, member, label: label(ws, true) }];
/** 자기 + 계정으로 확인된 다른 워크스페이스. */
const withOther = (ws: string, member: string, other: string, account: string): NotifyRoute[] =>
  [...own(ws, member), { ws: other, account, label: label(other, false) }];

type Got = Array<{ id: string; ws?: NotifyWorkspace }>;
const sink = (out: Got) => (e: NotifySessionEvent) => { out.push({ id: e.id, ws: e.ws }); };

test("A1 같은 워크스페이스·같은 사람 → 받는다, 표시는 그 구독의 자기 워크스페이스", () => {
  const got: Got = [];
  const sub = subscribeNotify(own("ws-a", "alice"), sink(got));
  assert.equal(publishNotify({ ws: "ws-a", member: "alice" }, ev("s1")), 1);
  assert.deepEqual(got, [{ id: "s1", ws: label("ws-a", true) }]);
  sub.close();
});

test("A2 ★ 다른 워크스페이스의 같은 구성원 아이디는 받지 않는다 — 매니지드 공유 게이트웨이에서 새던 자리(#4054)", () => {
  const got: Got = [];
  const sub = subscribeNotify(own("ws-a", "alice"), sink(got));
  assert.equal(publishNotify({ ws: "ws-b", member: "alice" }, ev("s2")), 0, "다른 워크스페이스 사건이 흘러들었다");
  assert.equal(publishNotify({ ws: "ws-b", member: "alice", account: "acct-1" }, ev("s2b")), 0, "계정이 실려 와도 자리가 없으면 안 된다");
  assert.deepEqual(got, []);
  sub.close();
});

test("A3 계정으로 확인된 다른 워크스페이스 → 받는다, 표시는 그 워크스페이스(current=false · enter)", () => {
  const got: Got = [];
  const sub = subscribeNotify(withOther("ws-a", "alice", "ws-b", "acct-1"), sink(got));
  assert.equal(publishNotify({ ws: "ws-b", member: "alice-2", account: "acct-1" }, ev("s3")), 1);
  assert.deepEqual(got, [{ id: "s3", ws: label("ws-b", false) }]);
  sub.close();
});

test("A4 다른 워크스페이스라도 계정이 다르면 받지 않는다", () => {
  const got: Got = [];
  const sub = subscribeNotify(withOther("ws-a", "alice", "ws-b", "acct-1"), sink(got));
  assert.equal(publishNotify({ ws: "ws-b", member: "bob", account: "acct-2" }, ev("s4")), 0);
  assert.deepEqual(got, []);
  sub.close();
});

test("A5 계정 없이 발행된 다른 워크스페이스 사건은 구성원 아이디가 같아도 받지 않는다 — 그 아이디는 사람이 아니다", () => {
  const got: Got = [];
  const sub = subscribeNotify(withOther("ws-a", "alice", "ws-b", "acct-1"), sink(got));
  assert.equal(publishNotify({ ws: "ws-b", member: "alice" }, ev("s5")), 0);
  assert.equal(publishNotify({ ws: "ws-b", member: "acct-1" }, ev("s5b")), 0, "계정 조건을 구성원 아이디로 맞췄다");
  assert.deepEqual(got, []);
  sub.close();
});

test("A6 계정이 같아도 확인된 목록에 없는 워크스페이스면 받지 않는다", () => {
  const got: Got = [];
  const sub = subscribeNotify(withOther("ws-a", "alice", "ws-b", "acct-1"), sink(got));
  assert.equal(publishNotify({ ws: "ws-c", member: "alice", account: "acct-1" }, ev("s6")), 0);
  assert.deepEqual(got, []);
  sub.close();
});

test("A7 셀프호스트 다중(registry): 다른 워크스페이스를 구성원 아이디로 받는다(박스 전역 신원)", () => {
  const got: Got = [];
  const sub = subscribeNotify([
    { ws: "primary", member: "alice", label: label("primary", true, "header") },
    { ws: "haru", member: "alice", label: label("haru", false, "header") },
  ], sink(got));
  assert.equal(publishNotify({ ws: "haru", member: "alice" }, ev("s7")), 1);
  assert.equal(publishNotify({ ws: "haru", member: "bob" }, ev("s7b")), 0);
  assert.deepEqual(got, [{ id: "s7", ws: label("haru", false, "header") }]);
  sub.close();
});

test("A8 한 사람이 PC 여러 대에서 앱을 켜면 전부에 뜬다(슬랙과 같은 모델)", () => {
  const a: Got = [], b: Got = [];
  const s1 = subscribeNotify(own("ws-a", "alice"), sink(a));
  const s2 = subscribeNotify(own("ws-a", "alice"), sink(b));
  assert.equal(publishNotify({ ws: "ws-a", member: "alice" }, ev("s8")), 2);
  assert.deepEqual([a.map((x) => x.id), b.map((x) => x.id)], [["s8"], ["s8"]]);
  s1.close(); s2.close();
});

test("A9 조건(구성원·계정)이 없는 자리·워크스페이스가 빈 자리는 버린다 — 열어 두는 기본값이 없다", () => {
  const got: Got = [];
  const sub = subscribeNotify([
    { ws: "ws-a", label: label("ws-a", true) } as NotifyRoute,
    { ws: "  ", member: "alice", label: label("x", true) },
  ], sink(got));
  assert.equal(notifyStreamCount(), 0, "아무것도 안 맞는 자리가 색인에 남았다");
  assert.equal(publishNotify({ ws: "ws-a", member: "alice" }, ev("s9")), 0);
  assert.deepEqual(got, []);
  sub.close();
});

test("A10 발행자가 사건에 표시를 실어 보내도 받는 쪽의 표시로 덮인다 — 표시는 구독 목록만 정한다", () => {
  const got: Got = [];
  const sub = subscribeNotify(own("ws-a", "alice"), sink(got));
  const forged: NotifyWorkspace = { slug: "evil", name: "가짜", current: false, via: "enter", enter: "https://evil.example/ws/x/enter" };
  assert.equal(publishNotify({ ws: "ws-a", member: "alice" }, ev("s10", { ws: forged })), 1);
  assert.deepEqual(got[0]?.ws, label("ws-a", true));
  sub.close();
});

test("A10b 같은 사건이라도 받는 쪽마다 표시가 다르다 — 누군가에겐 «지금 여기», 누군가에겐 다른 워크스페이스", () => {
  const onA: Got = [], onB: Got = [];
  // 같은 사람(acct-1)이 PC1 은 ws-a 에, PC2 는 ws-b 에 매여 있다. ws-b 에서 난 사건.
  const pc1 = subscribeNotify(withOther("ws-a", "alice", "ws-b", "acct-1"), sink(onA));
  const pc2 = subscribeNotify(withOther("ws-b", "alice-2", "ws-a", "acct-1"), sink(onB));
  assert.equal(publishNotify({ ws: "ws-b", member: "alice-2", account: "acct-1" }, ev("s10b")), 2);
  assert.equal(onA[0]?.ws?.current, false);
  assert.equal(onA[0]?.ws?.slug, "ws-b");
  assert.equal(onB[0]?.ws?.current, true);
  assert.equal(onB[0]?.ws?.slug, "ws-b");
  pc1.close(); pc2.close();
});

test("A11 update — 확인이 끝나 넓히면 그때부터 받고, 다시 좁히면 끊긴다(자기 워크스페이스는 계속)", () => {
  const got: Got = [];
  const sub = subscribeNotify(own("ws-a", "alice"), sink(got));
  assert.equal(accountRoutesActive(), false);
  assert.equal(publishNotify({ ws: "ws-b", member: "b", account: "acct-1" }, ev("u1")), 0, "넓히기 전");
  sub.update(withOther("ws-a", "alice", "ws-b", "acct-1"));
  assert.equal(accountRoutesActive(), true);
  assert.equal(accountRoutesActive("acct-1"), true);
  assert.equal(accountRoutesActive("acct-2"), false);
  assert.equal(publishNotify({ ws: "ws-b", member: "b", account: "acct-1" }, ev("u2")), 1, "넓힌 뒤");
  sub.update(own("ws-a", "alice"));
  assert.equal(accountRoutesActive(), false, "좁힌 뒤에도 계정 색인이 남았다(발행이 쓸데없이 DB 를 친다)");
  assert.equal(publishNotify({ ws: "ws-b", member: "b", account: "acct-1" }, ev("u3")), 0, "좁힌 뒤");
  assert.equal(publishNotify({ ws: "ws-a", member: "alice" }, ev("u4")), 1, "자기 워크스페이스는 그대로");
  assert.deepEqual(got.map((x) => x.id), ["u2", "u4"]);
  sub.close();
});

test("A12 ★ 해지하면 구독이 완전히 사라진다 — 뒤늦은 넓히기가 되살리지도 않는다", () => {
  const sub = subscribeNotify(withOther("ws-a", "alice", "ws-b", "acct-1"), () => { /* noop */ });
  assert.equal(notifyStreamCount("alice"), 1);
  assert.equal(notifyStreamCount(), 1, "구성원·계정 두 색인에 걸린 한 구독은 하나로 센다");
  sub.close();
  assert.equal(notifyStreamCount("alice"), 0);
  assert.equal(notifyStreamCount(), 0, "빈 Set 이 남아 있다(누수)");
  assert.equal(accountRoutesActive(), false);
  assert.equal(publishNotify({ ws: "ws-a", member: "alice" }, ev("c1")), 0, "해지한 뒤에도 전달을 시도한다");
  sub.close();   // 두 번 불러도 안전해야 한다(close·error 가 함께 오는 경로가 있다)
  sub.update(own("ws-a", "alice"));   // 끊긴 뒤 도착한 확인 결과
  assert.equal(notifyStreamCount(), 0, "끊긴 구독이 update 로 되살아났다");
  assert.equal(publishNotify({ ws: "ws-a", member: "alice" }, ev("c2")), 0);
});

test("A13 ★ 한 스트림이 던져도 나머지는 받는다 — 끊긴 소켓 하나가 다른 기기의 알림을 막으면 안 된다", () => {
  const got: Got = [];
  const s1 = subscribeNotify(own("ws-a", "alice"), () => { throw new Error("이 소켓은 죽었다"); });
  const s2 = subscribeNotify(own("ws-a", "alice"), sink(got));
  assert.equal(publishNotify({ ws: "ws-a", member: "alice" }, ev("t1")), 1, "던진 쪽은 전달 성공으로 세지 않는다");
  assert.deepEqual(got.map((x) => x.id), ["t1"]);
  s1.close(); s2.close();
});

test("A14 구독자가 없거나 발행 주소가 비면 아무 일도 하지 않는다 — 훅 보고는 핫패스다", () => {
  const got: Got = [];
  const sub = subscribeNotify(own("ws-a", "alice"), sink(got));
  assert.equal(publishNotify({ ws: "ws-a", member: "nobody" }, ev("n1")), 0);
  assert.equal(publishNotify({ ws: "ws-a", member: "" }, ev("n2")), 0);
  assert.equal(publishNotify({ ws: "", member: "alice" }, ev("n3")), 0);
  assert.deepEqual(got, []);
  sub.close();
});

test("routeMatches(순수) — 워크스페이스가 먼저, 그다음 구성원 또는 계정", () => {
  const r: NotifyRoute = { ws: "b", account: "acct", label: label("b", false) };
  assert.equal(routeMatches(r, { ws: "b", member: "m", account: "acct" }), true);
  assert.equal(routeMatches(r, { ws: "c", member: "m", account: "acct" }), false);
  assert.equal(routeMatches(r, { ws: "b", member: "acct", account: null }), false, "계정 조건을 구성원 아이디로 맞췄다");
  assert.equal(routeMatches({ ws: "b", member: "m", label: label("b", true) }, { ws: "b", member: "m" }), true);
  assert.equal(routeMatches({ ws: "b", label: label("b", true) }, { ws: "b", member: "m", account: "acct" }), false);
});

test("사건 키는 세션·단계·초가 같으면 같다(재시도·중복 보고를 한 사건으로 흡수)", () => {
  assert.equal(sessionEventKey("box-a", "idle", 100), sessionEventKey("box-a", "idle", 100));
  assert.notEqual(sessionEventKey("box-a", "idle", 100), sessionEventKey("box-a", "idle", 101));
  assert.notEqual(sessionEventKey("box-a", "idle", 100), sessionEventKey("box-b", "idle", 100));
});
