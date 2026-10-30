// #4697 T7 — 복원 측정 한 줄(restore-measure.ts)의 계약. 7일 측정이 이 줄로 «하루 재기동 횟수 · 복원 실패율 · 복원 시간 ·
//  쪽지(쓰다 만 글·질문) 복원 건수» 를 센다. 사양·엣지 표: 작업 스크래치 spec.md D1~D14.
//  틀리면 티가 크다:
//   🔴 결말을 잘못 가르면 — «이미 살아 있었다(alive)» 가 재기동으로 세어져 재기동 횟수가 부풀거나, 실패가 성공으로 숨는다.
//   🔴 사람이 쓴 글(쪽지의 쓰다 만 글)을 실으면 — 측정 로그에 사람의 말이 남는다.
//   🔴 응답이 끝나기 전에 찍거나 두 번 찍으면 — 상태 코드·걸린 시간이 틀리고 건수가 두 배가 된다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { EventEmitter } from "node:events";
import { restoreMeasureOf, restoreMeasureMiddleware, type RestoreMeasure } from "./restore-measure.js";
import type { SessionStopNote } from "../sessions/session-state.js";

const NOW = 1_800_000_000;
const base = { id: "box-a-1", tenant: "t1", ms: 1234.4, note: null, nowSec: NOW, force: false };

test("D1 200 · 같은 id 세션 → same-id(이어 열기 판 포함)", () => {
  const m = restoreMeasureOf({ ...base, status: 200, body: { ok: true, resumed: "precise", session: { id: "box-a-1" } } });
  assert.deepEqual([m.outcome, m.resumed, m.newId], ["same-id", "precise", undefined]);
});
test("D2 200 · 다른 id 세션 → new-id(새 id 를 싣는다)", () => {
  const m = restoreMeasureOf({ ...base, status: 200, body: { ok: true, resumed: "fresh", session: { id: "box-a-2" } } });
  assert.deepEqual([m.outcome, m.newId, m.resumed], ["new-id", "box-a-2", "fresh"]);
});
test("D3 already · movedTo 없음 → alive(이미 살아 있었다 — 재기동이 아니다)", () => {
  assert.equal(restoreMeasureOf({ ...base, status: 200, body: { ok: true, already: true, id: "box-a-1" } }).outcome, "alive");
});
test("D4 already · movedTo → moved(이미 이어진 세션으로 안내)", () => {
  assert.equal(restoreMeasureOf({ ...base, status: 200, body: { ok: true, already: true, id: "box-a-9", movedTo: "box-a-9" } }).outcome, "moved");
});
test("D5 4xx → error · 사유는 정확히 160자로 자른다", () => {
  const e = restoreMeasureOf({ ...base, status: 409, body: { canForce: true, error: "상태를 확인하지 못했습니다 ".padEnd(300, "가") } });
  assert.deepEqual([e.outcome, e.status, e.error!.length], ["error", 409, 160]);
});
test("D6 500 → error", () => {
  assert.equal(restoreMeasureOf({ ...base, status: 500, body: { error: "internal_error" } }).outcome, "error");
});
test("D7 본문 없음 → other", () => {
  assert.equal(restoreMeasureOf({ ...base, status: 200, body: undefined }).outcome, "other");
});
test("D8 노드 세션 복원 — 세션에 노드가 있거나 응답에 노드가 있으면 node", () => {
  assert.equal(restoreMeasureOf({ ...base, status: 200, body: { ok: true, session: { id: "box-a-3", node: { id: "n1" } } } }).node, true);
  assert.equal(restoreMeasureOf({ ...base, status: 200, body: { ok: true, already: true, id: "box-a-1", node: { id: "n1" } } }).node, true);
  assert.equal(restoreMeasureOf({ ...base, status: 200, body: { ok: true, session: { id: "box-a-1" } } }).node, undefined);
});
test("D9 강제 복원이면 force", () => {
  assert.equal(restoreMeasureOf({ ...base, status: 200, force: true, body: {} }).force, true);
  assert.equal(restoreMeasureOf({ ...base, status: 200, body: {} }).force, undefined);
});
test("D10 쪽지 — 사유 · 쓰다 만 글이 있었나 · 질문 종류 · 끈 지 몇 초 — 글 자체는 싣지 않는다", () => {
  const note: SessionStopNote = { at: NOW - 125, why: "asking", harness: "claude", draft: "비밀스러운 쓰다 만 글",
    question: { kind: "ask", items: [{ text: "가장 좋아하는 색은?", options: [{ n: 1, label: "빨강" }] }] } };
  const m = restoreMeasureOf({ ...base, status: 200, note, body: { ok: true, session: { id: "box-a-1" } } });
  assert.deepEqual(m.note, { why: "asking", draft: true, question: "ask", agoSec: 125 });
  const json = JSON.stringify(m);
  assert.ok(!json.includes("비밀스러운") && !json.includes("좋아하는 색") && !json.includes("빨강"), "사람이 쓴 글·질문 글은 싣지 않는다");
  const done = restoreMeasureOf({ ...base, status: 200, note: { at: NOW - 5, why: "done", harness: "codex" }, body: { ok: true, session: { id: "box-a-1" } } });
  assert.deepEqual(done.note, { why: "done", draft: false, question: null, agoSec: 5 });
});
test("D11 쪽지가 없으면 note 칸도 없다", () => {
  assert.equal(restoreMeasureOf({ ...base, status: 200, body: {} }).note, undefined);
});
test("D14 걸린 시간 — 반올림 · 음수는 0", () => {
  assert.equal(restoreMeasureOf({ ...base, status: 200, body: {} }).ms, 1234);
  assert.equal(restoreMeasureOf({ ...base, ms: -3, status: 200, body: {} }).ms, 0);
});

/** express 응답의 대역 — json·status·statusCode·writableFinished 와 finish·close 사건만. */
type FakeRes = EventEmitter & { statusCode: number; writableFinished: boolean; status: (c: number) => FakeRes; json: (b: unknown) => FakeRes; sent: unknown[] };
function fakeRes(): FakeRes {
  const r = new EventEmitter() as FakeRes;
  r.statusCode = 200; r.sent = []; r.writableFinished = false;
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.sent.push(b); return r; };
  return r;
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

test("D12 미들웨어 — 응답이 끝난 뒤 한 번만 찍는다 · 응답 모양·상태 코드·요청 때의 쪽지로 · 본문은 그대로 나가고 요청은 계속된다", async () => {
  const logs: RestoreMeasure[] = [];
  const asked: string[] = [];
  const mw = restoreMeasureMiddleware(async (id) => { asked.push(id); return { at: Math.floor(Date.now() / 1000) - 60, why: "done", harness: "claude", draft: "x" }; },
    (m) => logs.push(m));
  const res = fakeRes();
  let nexted = 0;
  mw({ params: { id: "box-a-1" }, query: {} } as never, res as never, () => { nexted++; });
  assert.equal(nexted, 1, "요청은 그대로 다음으로 간다");
  res.json({ ok: true, resumed: "precise", session: { id: "box-a-1" } });
  assert.deepEqual(res.sent, [{ ok: true, resumed: "precise", session: { id: "box-a-1" } }], "응답 본문은 그대로 나간다");
  await tick();
  assert.equal(logs.length, 0, "응답이 끝나기 전엔 안 찍는다");
  res.emit("finish");
  res.emit("finish");
  await tick();
  assert.equal(logs.length, 1, "한 번만");
  assert.deepEqual(asked, ["box-a-1"], "그 세션의 쪽지를 읽었다");
  assert.deepEqual([logs[0]!.outcome, logs[0]!.status, logs[0]!.id, logs[0]!.note?.why, logs[0]!.note?.draft], ["same-id", 200, "box-a-1", "done", true]);
  assert.ok(logs[0]!.ms >= 0 && logs[0]!.note!.agoSec >= 60);
});
test("D13 미들웨어 — 실패 응답도 찍고 · 쪽지를 못 읽어도 찍는다 · force 를 싣는다", async () => {
  const logs: RestoreMeasure[] = [];
  const mw = restoreMeasureMiddleware(async () => { throw new Error("DB 순간 장애"); }, (m) => logs.push(m));
  const res = fakeRes();
  mw({ params: { id: "box-a-2" }, query: { force: "1" } } as never, res as never, () => {});
  res.status(409).json({ error: "모른다", canForce: true });
  res.emit("finish");
  await tick();
  assert.equal(logs.length, 1);
  assert.deepEqual([logs[0]!.outcome, logs[0]!.status, logs[0]!.force, logs[0]!.note], ["error", 409, true, undefined]);
});

test("D15 사람 쪽이 먼저 끊으면(finish 없이 close) — 서버가 나중에 낸 응답의 결말로 한 줄 · aborted", async () => {
  const logs: RestoreMeasure[] = [];
  const mw = restoreMeasureMiddleware(async () => null, (m) => logs.push(m));
  const res = fakeRes();
  mw({ params: { id: "box-a-5" }, query: {} } as never, res as never, () => {});
  res.emit("close");                         // 롤 교대·탭 닫힘 — 응답 전에 끊겼다
  await tick();
  assert.equal(logs.length, 0, "응답이 아직 없으면 결말을 모른다 — 기다린다");
  res.json({ ok: true, resumed: "precise", session: { id: "box-a-5" } });   // 서버는 끝까지 돌아 되살렸다
  await tick();
  assert.equal(logs.length, 1);
  assert.deepEqual([logs[0]!.outcome, logs[0]!.aborted], ["same-id", true]);
});
test("D16 응답을 냈는데 다 보내기 전에 끊겼으면 — 그 결말로 한 줄 · aborted · 정상 종료는 aborted 없음 · 어느 쪽이든 한 번", async () => {
  const logs: RestoreMeasure[] = [];
  const mw = restoreMeasureMiddleware(async () => null, (m) => logs.push(m));
  const a = fakeRes();
  mw({ params: { id: "box-a-6" }, query: {} } as never, a as never, () => {});
  a.json({ ok: true, already: true, id: "box-a-6" });
  a.emit("close"); a.emit("close");
  const b = fakeRes();
  mw({ params: { id: "box-a-7" }, query: {} } as never, b as never, () => {});
  b.json({ ok: true, session: { id: "box-a-8" } });
  b.writableFinished = true; b.emit("finish"); b.emit("close");
  await tick();
  assert.equal(logs.length, 2);
  const byId = Object.fromEntries(logs.map((m) => [m.id, m]));
  assert.deepEqual([byId["box-a-6"]!.outcome, byId["box-a-6"]!.aborted], ["alive", true]);
  assert.deepEqual([byId["box-a-7"]!.outcome, byId["box-a-7"]!.aborted], ["new-id", undefined]);
});
test("D16b 끊겨서(aborted) 한 줄을 낸 뒤 finish 가 와도 두 번 찍지 않는다", async () => {
  const logs: RestoreMeasure[] = [];
  const mw = restoreMeasureMiddleware(async () => null, (m) => logs.push(m));
  const r = fakeRes();
  mw({ params: { id: "box-a-9" }, query: {} } as never, r as never, () => {});
  r.emit("close");                 // 응답 전에 끊김
  r.json({ ok: true, session: { id: "box-a-9" } });   // 끊긴 뒤 낸 응답 — 여기서 한 줄
  r.writableFinished = true; r.emit("finish");       // 그래도 finish 가 오는 경우
  await tick();
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.aborted, true);
});
