// 한 번에 하나만(#1631) — 엣지 표 행마다 한 검사.
//  관측은 '본체 호출 횟수'로 한다(문구 아님). ⚠ 가드가 깨져도 **멈추지 않고 실패하게** 짰다 —
//  변이 시 테스트가 매달리면 빨간불인지 행인지 구분이 안 된다(실측으로 한 번 겪었다).
import test from "node:test";
import assert from "node:assert/strict";
import { onceAtATime } from "./once-at-a-time.js";

const deferred = () => { let go!: () => void; const p = new Promise<void>((r) => { go = r; }); return { p, go }; };

test("① 겹치는 동안 두 번째 호출은 본체를 안 부르고 '바쁨' 값을 준다", async () => {
  let calls = 0;
  const d = deferred();
  const run = onceAtATime(async () => { calls++; await d.p; return "done"; }, () => "busy");
  const first = run();
  const second = run();                 // 첫 호출이 아직 안 끝난 시점
  await Promise.resolve();              // 두 번째가 본체에 들어갔다면 여기서 calls 가 이미 2다
  assert.equal(calls, 1, "본체는 한 번만 불려야 한다");
  d.go();                               // 가드가 깨져 있어도 여기서 전부 풀린다(행 방지)
  assert.equal(await second, "busy");
  assert.equal(await first, "done");
});

test("② 끝난 뒤에는 다시 돈다(가드가 영구 잠기지 않는다)", async () => {
  let calls = 0;
  const run = onceAtATime(async () => { calls++; return calls; }, () => -1);
  assert.equal(await run(), 1);
  assert.equal(await run(), 2);
});

test("③ 본체가 던져도 가드가 풀린다", async () => {
  let calls = 0;
  const run = onceAtATime(async () => { calls++; throw new Error("boom"); }, () => -1);
  await assert.rejects(run(), /boom/);
  await assert.rejects(run(), /boom/);
  assert.equal(calls, 2, "첫 실패가 이후 호출을 막으면 안 된다");
});

test("④ 셋이 동시에 와도 본체는 한 번", async () => {
  let calls = 0;
  const d = deferred();
  const run = onceAtATime(async () => { calls++; await d.p; return "ok"; }, () => "busy");
  const a = run(); const b = run(); const c = run();
  await Promise.resolve();
  assert.equal(calls, 1);
  d.go();
  assert.deepEqual([await b, await c], ["busy", "busy"]);
  assert.equal(await a, "ok");
});

test("⑤ 칸(slotOf)을 나누면 같은 칸끼리만 하나씩 — 다른 칸은 함께 돈다 · 칸이 끝나면 그 칸만 풀린다(#4851)", async () => {
  let calls = 0;
  let slot = "ws:a";
  const da = deferred(); const db = deferred();
  const run = onceAtATime(async () => { calls++; await (slot === "ws:a" ? da.p : db.p); return slot; }, () => "busy", () => slot);
  const a1 = run();                       // 칸 a 시작
  const a2 = run();                       // 칸 a 는 바쁘다
  slot = "ws:b";
  const b1 = run();                       // 칸 b 는 따로 돈다
  await Promise.resolve();
  assert.equal(calls, 2, "다른 칸이 막혔거나 같은 칸이 두 번 돌았다");
  assert.equal(await a2, "busy");
  da.go(); await a1;
  slot = "ws:a";
  const a3 = run();                       // 칸 a 는 풀렸다 · 칸 b 는 아직 바쁘다
  assert.equal(calls, 3);
  slot = "ws:b";
  assert.equal(await run(), "busy");
  db.go(); await b1; await a3;
});
