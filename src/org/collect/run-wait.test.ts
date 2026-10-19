// 수집 실행 기다리기(org/collect/run-wait.ts) — 값으로 잠근다(#4213 T13 · 격리 리뷰 2026-10-17).
//
//  사양 — 엣지 표:
//   S1 실행 중                                   → 안 끝남
//   S2 끝 · 실행 기록 없음(ingest null)            → 끝(기다릴 저장 단계가 없다)
//   S3 끝 · 점검(probe) 실행                       → 끝
//   S4 끝 · 목록 실행 · 저장 차례를 아직 안 잡음({mode}) → 안 끝남(리브가 저장 전의 단위 수를 보지 않게)
//   S5 끝 · 목록 실행 · 저장 중(state running)       → 안 끝남
//   S6 끝 · 목록·수집 실행 · 저장 done/failed         → 끝(실패도 끝 — 사유는 ingest 에 있다)
//   L1 wait 0 · 음수 · NaN · 없음                  → 한 번만 읽고 돌려준다(잠 0)
//   L2 끝날 때까지 읽는다 — 끝나는 순간 돌려준다(남은 시간을 다 쓰지 않는다)
//   L3 끝까지 안 끝나면 마감에 마지막 값을 돌려준다 — 잠 합계 = 기다림(마감을 넘겨 자지 않는다)
//   L4 상한 — 99초를 줘도 maxSec(25)까지만
//   L5 간격 — 한 번의 잠은 pollMs 를 넘지 않는다
import test from "node:test";
import assert from "node:assert/strict";
import { collectRunSettled, waitForCollectRun, type RunWaitView } from "./run-wait.js";

const v = (state: string, ingest: Record<string, unknown> | null): RunWaitView => ({ state, ingest });

test("S1~S6 끝 판정 — 목록·수집 실행은 저장 단계까지", () => {
  assert.equal(collectRunSettled(v("running", null)), false, "S1");
  assert.equal(collectRunSettled(v("done", null)), true, "S2");
  assert.equal(collectRunSettled(v("done", { mode: "probe" })), true, "S3");
  assert.equal(collectRunSettled(v("done", { mode: "listing" })), false, "S4 차례 안 잡음");
  assert.equal(collectRunSettled(v("done", { mode: "listing", state: "running" })), false, "S5 저장 중");
  assert.equal(collectRunSettled(v("done", { mode: "listing", state: "done", units: 3 })), true, "S6 목록 저장 끝");
  assert.equal(collectRunSettled(v("done", { mode: "collect", state: "failed", error: "x" })), true, "S6 수집 저장 실패도 끝");
  assert.equal(collectRunSettled(v("running", { mode: "collect", state: "done" })), false, "실행이 안 끝났으면 저장 값과 무관하게 안 끝남");
});

/** 가짜 시계 — 잠이 시계를 민다. 읽기는 정해 둔 값을 차례로 준다(다 쓰면 마지막 값). */
function rig(seq: RunWaitView[]) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  let reads = 0;
  return {
    reads: () => reads,
    sleeps,
    read: async () => { const x = seq[Math.min(reads, seq.length - 1)]; reads++; return x; },
    deps: { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, pollMs: 3000, maxSec: 25 },
  };
}

test("L1 기다림 0 · 음수 · NaN · 없음 — 한 번만 읽는다", async () => {
  for (const w of [0, -5, Number.NaN, undefined]) {
    const r = rig([v("running", null)]);
    const out = await waitForCollectRun(r.read, w, r.deps);
    assert.equal(out.state, "running");
    assert.deepEqual([r.reads(), r.sleeps.length], [1, 0], `wait ${w}`);
  }
});

test("L2 끝나는 순간 돌려준다 — 남은 시간을 다 쓰지 않는다", async () => {
  const r = rig([v("running", null), v("done", { mode: "listing" }), v("done", { mode: "listing", state: "running" }), v("done", { mode: "listing", state: "done" }), v("done", { mode: "listing", state: "done", extra: 1 })]);
  const out = await waitForCollectRun(r.read, 25, r.deps);
  assert.deepEqual(out.ingest, { mode: "listing", state: "done" }, "저장 끝 값을 돌려준다");
  assert.deepEqual([r.reads(), r.sleeps], [4, [3000, 3000, 3000]], "끝난 뒤로는 더 읽지도 자지도 않는다");
});

test("L3 마감까지 안 끝나면 마지막 값 · 잠 합계 = 기다림", async () => {
  const r = rig([v("running", null)]);
  const out = await waitForCollectRun(r.read, 10, r.deps);
  assert.equal(out.state, "running");
  assert.equal(r.sleeps.reduce((a, b) => a + b, 0), 10_000, "마감을 넘겨 자거나 덜 기다린다");
  assert.deepEqual(r.sleeps, [3000, 3000, 3000, 1000], "마지막 잠은 남은 시간만큼");
});

test("L4 상한 — 99초를 줘도 25초까지만 · L5 한 번의 잠은 간격을 넘지 않는다", async () => {
  const r = rig([v("running", null)]);
  await waitForCollectRun(r.read, 99, r.deps);
  assert.equal(r.sleeps.reduce((a, b) => a + b, 0), 25_000, "L4");
  assert.ok(r.sleeps.every((ms) => ms <= 3000), "L5");
});
