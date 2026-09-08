// 세션 호스트 수명 표 (#2600 T1) — 사양 `spec.md` A절, 엣지 표 1~14행. 행마다 시험 하나다.
//
// 왜 표로 쓰나: 종전엔 이 살림이 두 파일(`attach-worker-entry` · `node/agent`)에 각각 적혀 있어서,
//  한쪽에만 있는 항목(유휴 자진 종료·누수 보고)이 «의도한 차이»인지 «빠뜨린 것»인지 코드로 구별할
//  수 없었다. 한 모듈로 모으면 그 차이가 **토폴로지가 정하는 값**이 되고, 그러면 표로 못박을 수 있다.
//
// ⚠ 단언은 **문구가 아니라 부작용**으로 한다 — 통지 배열·소켓 수·close 횟수. 로그 문구를 보면
//  구현 미러링이 되고 문구를 다듬는 순간 거짓 실패한다.

import assert from "node:assert/strict";
import test from "node:test";
import { SessionHost, lifetimeFor, type SessionHostOptions } from "./session-host.js";
import type { AttachSocket } from "./terminal-pty.js";

/** 최소 가짜 소켓 — 두 어댑터(실 WebSocket · ChanSocket)가 공통으로 만족하는 계약만 흉내낸다. */
function fakeSock(): AttachSocket & { fire(ev: string): void; closed: number } {
  const ls = new Map<string, Array<(...a: any[]) => void>>();
  const s = {
    closed: 0,
    send() { /* noop */ },
    close() { s.closed++; s.fire("close"); },
    on(ev: string, fn: (...a: any[]) => void) { const a = ls.get(ev) ?? []; a.push(fn); ls.set(ev, a); },
    fire(ev: string) { for (const fn of ls.get(ev) ?? []) fn(); },
  };
  return s as unknown as AttachSocket & { fire(ev: string): void; closed: number };
}

const SID = "box-a-1a2b3c4d";

/** attach 본체를 갈아끼운 호스트 — 이 파일은 살림만 본다(PTY 를 실제로 띄우지 않는다). */
function makeHost(over: Partial<SessionHostOptions> = {}) {
  const empties: string[] = [];
  let idles = 0;
  const base: SessionHostOptions = {
    lifetime: "ephemeral",
    attachImpl: () => { /* 살림만 본다 */ },
    onSessionEmpty: (id) => empties.push(id),
    onIdle: () => { idles++; },
  };
  const h = new SessionHost({ ...base, ...over });
  return { h, empties, idles: () => idles };
}

test("1행 · attach 1개 → 세션 1 · 소켓 1", () => {
  const { h } = makeHost();
  h.attach(fakeSock(), SID);
  assert.equal(h.sessionCount(), 1);
  assert.equal(h.socketCount(), 1);
  assert.equal(h.socketsFor(SID), 1);
});

test("2행 · 같은 세션에 소켓 2개 → 세션은 여전히 1 · 통지 없음", () => {
  const { h, empties } = makeHost();
  h.attach(fakeSock(), SID);
  h.attach(fakeSock(), SID);
  assert.equal(h.sessionCount(), 1);
  assert.equal(h.socketsFor(SID), 2);
  assert.deepEqual(empties, []);
});

// ★ 이 행이 이 장부의 존재 이유다 — 탭 둘이 같은 판을 볼 때 하나를 닫았다고 «비었다»로 보면
//  남아서 보고 있는 화면이 끊긴다(#2148 의 유령 정리가 그 통지로 발화한다).
test("3행 · 소켓 2 중 하나 close → 소켓 1 · 통지 없음", () => {
  const { h, empties } = makeHost();
  const a = fakeSock(), b = fakeSock();
  h.attach(a, SID); h.attach(b, SID);
  a.fire("close");
  assert.equal(h.socketsFor(SID), 1);
  assert.deepEqual(empties, [], "남은 소켓이 있으면 통지하지 않는다");
});

test("4행 · 경계(1→0) 마지막 close → 통지 1회 · 장부에서 제거", () => {
  const { h, empties } = makeHost();
  const a = fakeSock(), b = fakeSock();
  h.attach(a, SID); h.attach(b, SID);
  a.fire("close"); b.fire("close");
  assert.deepEqual(empties, [SID]);
  assert.equal(h.socketsFor(SID), 0);
  assert.equal(h.sessionCount(), 0, "장부에 남기면 유휴 판정이 영영 안 걸린다");
});

// WS 중계 어댑터의 ChanSocket 은 close 경로가 둘이다(스스로 close() · 게이트웨이발 feedClose()).
//  둘 다 'close' 를 쏘므로 장부를 두 번 빼면 음수가 되고, 그러면 그 뒤 판정이 통째로 망가진다.
test("5행 · 같은 소켓 close ×2 → 통지 1회 · 소켓수 음수 아님", () => {
  const { h, empties } = makeHost();
  const a = fakeSock();
  h.attach(a, SID);
  a.fire("close"); a.fire("close");
  assert.deepEqual(empties, [SID]);
  assert.equal(h.socketCount(), 0);
});

test("6행 · ephemeral · 소켓 0 · 시간 경과 → 유휴 알림", async () => {
  const { h, idles } = makeHost({ idleExitMs: 5 });
  const a = fakeSock();
  h.attach(a, SID);
  a.fire("close");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(idles(), 1);
});

// ★ 토폴로지가 정하는 차이 — 노드 데몬은 붙은 세션이 없어도 게이트웨이 지시를 기다려야 한다.
//  종전엔 이 차이가 «워커 파일에만 IDLE_EXIT_MS 가 있다» 는 형태로만 존재했다(코드로 말해지지 않았다).
test("7행 · resident · 소켓 0 · 시간 경과 → 유휴 알림 없음", async () => {
  const { h, idles } = makeHost({ lifetime: "resident", idleExitMs: 5 });
  const a = fakeSock();
  h.attach(a, SID);
  a.fire("close");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(idles(), 0, "상주 호스트가 스스로 나가면 그 PC 의 세션이 통째로 안 붙는다");
});

// 도착과 attach 사이엔 핸드셰이크가 낀다(fd 이관은 handleUpgrade 가 비동기다).
//  그 틈에 유휴 만료가 터지면 **막 받은 소켓을 손에 쥔 채** 프로세스가 나간다.
test("8행 · 유휴 대기 중 arriving() → 유휴 알림 없음", async () => {
  const { h, idles } = makeHost({ idleExitMs: 25 });
  const a = fakeSock();
  h.attach(a, SID);
  a.fire("close");                       // 유휴 타이머 장전
  await new Promise((r) => setTimeout(r, 5));
  h.arriving();                          // 새 소켓이 오는 중 — 핸드셰이크 전
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(idles(), 0);
});

test("9행 · 종료 뒤 도착한 소켓 → 즉시 close · 장부 안 늚", () => {
  const { h } = makeHost();
  h.shutdown();
  const a = fakeSock();
  h.attach(a, SID);
  assert.equal(a.closed, 1);
  assert.equal(h.sessionCount(), 0);
});

// 24행 — 정확성 리뷰가 짚은 것: 거절을 «조용히» 하면 WS 중계 어댑터가 그 뒤 `opened` 를 보내고
//  곧바로 `close` 가 뒤따른다. 게이트웨이엔 «열렸다 끊겼다» 로 보여 재시도 판단이 틀어진다.
//  그래서 attach 가 **거절을 값으로** 알린다.
test("24행 · attach 의 반환값이 수락/거절을 알린다", () => {
  const { h } = makeHost();
  assert.equal(h.attach(fakeSock(), SID), true, "정상 수락은 true");
  h.shutdown();
  assert.equal(h.attach(fakeSock(), SID), false, "종료 중 거절은 false — 어댑터가 openfail 로 답할 근거");
});

// attach 본체는 스폰 반복 실패 시 **동기로** ws.close(4403) 한다(서킷브레이커 — terminal-pty).
//  장부 등록이 attach 뒤였다면 그 close 를 놓쳐 세션이 영원히 «붙어 있음»으로 남는다.
test("10행 · attach 본체가 동기로 close → 장부에 남지 않는다", () => {
  const { h, empties } = makeHost({ attachImpl: (sock) => { sock.close(); } });
  h.attach(fakeSock(), SID);
  assert.equal(h.socketCount(), 0, "등록을 attach 뒤에 하면 이 행이 빨간불이 된다");
  assert.deepEqual(empties, [SID]);
});

test("11행 · 수명은 토폴로지가 정한다 — node=resident · local/relay=ephemeral", () => {
  assert.equal(lifetimeFor("node"), "resident");
  assert.equal(lifetimeFor("local"), "ephemeral");
  assert.equal(lifetimeFor("relay"), "ephemeral");
});

// ── 새로 도입한 인자가 **부재**인 경우(스킬 규율: 새 변수·헬퍼는 그 자체로 새 엣지를 만든다) ──
test("12행 · onIdle 없음 + ephemeral + 소켓 0 + 경과 → 아무 일도 안 일어난다", async () => {
  const h = new SessionHost({ lifetime: "ephemeral", idleExitMs: 5, attachImpl: () => { /* noop */ } });
  const a = fakeSock();
  h.attach(a, SID);
  a.fire("close");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(h.socketCount(), 0, "콜백이 없다고 장부가 망가지면 안 된다");
});

test("13행 · onSessionEmpty 없음 + 마지막 close → 크래시 없이 장부만 정리", () => {
  const h = new SessionHost({ lifetime: "ephemeral", attachImpl: () => { /* noop */ } });
  const a = fakeSock();
  h.attach(a, SID);
  a.fire("close");
  assert.equal(h.sessionCount(), 0);
});

// 22행 — 블라인드 리뷰(#2600 T1 이해가능성 게이트)가 찾은 구멍. `arriving()` 뒤 핸드셰이크가 던지면
//  attach 까지 못 가 close 핸들러가 없고, 유휴 타이머를 켜는 자리가 그 핸들러뿐이라 **영영 안 켜진다**.
//  종전 워커도 같은 구멍이 있었다(살림을 한 곳으로 모으면서 닫는다).
test("22행 · arriving() 뒤 도착 실패 → arrivalAborted 가 유휴 대기를 되건다", async () => {
  const { h, idles } = makeHost({ idleExitMs: 5 });
  h.arriving();          // 온다고 알렸는데
  h.arrivalAborted();    // 핸드셰이크가 실패했다
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(idles(), 1, "되걸지 않으면 소켓 0 인 채 «안 죽는 워커» 로 남는다");
});

test("23행 · arrivalAborted 뒤 진짜 소켓이 오면 유휴는 다시 취소된다", async () => {
  const { h, idles } = makeHost({ idleExitMs: 25 });
  h.arriving(); h.arrivalAborted();
  await new Promise((r) => setTimeout(r, 5));
  h.attach(fakeSock(), SID);   // 재장전된 타이머를 새 attach 가 다시 끈다
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(idles(), 0);
});

test("14행 · 종료 2회 → 멱등", () => {
  const { h } = makeHost();
  h.shutdown();
  h.shutdown();
  assert.equal(h.sessionCount(), 0);
});
