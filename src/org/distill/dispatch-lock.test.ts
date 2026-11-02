// 증류 배치 내기 줄 세우기(#5235) — 사양 표 M. 단언은 문구가 아니라 **무엇이 언제 돌았나**로 한다.
//  실제로 두 잡이 같은 자료를 안 집는지는 lane-jobs.pg-test.mjs 가 접수된 위탁 행으로 잰다. 여기는 줄의 규칙이다.
import test from "node:test";
import assert from "node:assert/strict";
import { withTenant } from "../tenant-context.js";
import { withDistillDispatch } from "./dispatch-lock.js";
import { oneDispatchAtATime } from "../../scheduler/actions/distill.js";

/** 손으로 끝내는 일감 — 언제 시작했고 언제 끝나는지를 시험이 정한다. */
function gate() {
  let open: () => void = () => {};
  const closed = new Promise<void>((res) => { open = res; });
  return { open, closed };
}
const tickOver = () => new Promise<void>((res) => setTimeout(res, 15));

test("M1 ★ 동시에 들어와도 한 번에 하나 · 들어온 순서대로", async () => {
  const log: string[] = [];
  let running = 0, most = 0;
  const job = (name: string) => withDistillDispatch(async () => {
    running++; most = Math.max(most, running); log.push(`시작 ${name}`);
    await tickOver();
    log.push(`끝 ${name}`); running--;
    return name;
  });
  const got = await Promise.all([job("a"), job("b"), job("c")]);
  assert.deepEqual(got, ["a", "b", "c"], "각자 자기 결과를 받는다");
  assert.equal(most, 1, "겹쳐 돌았다");
  assert.deepEqual(log, ["시작 a", "끝 a", "시작 b", "끝 b", "시작 c", "끝 c"]);
});

test("M2 앞 실행이 던지면 그 오류는 앞 실행의 것이고, 다음은 돈다", async () => {
  const first = withDistillDispatch(async () => { await tickOver(); throw new Error("앞 실행 실패"); });
  const second = withDistillDispatch(async () => "돌았다");
  await assert.rejects(first, /앞 실행 실패/);
  assert.equal(await second, "돌았다");
});

test("M3 ★ 상한 안에 차례가 안 오면 돌리지 않고 null — 오류가 아니다", async () => {
  const holder = gate();
  const held = withDistillDispatch(() => holder.closed);
  let ran = false;
  const late = await withDistillDispatch(async () => { ran = true; }, { waitMs: 10 });
  assert.equal(late, null);
  assert.equal(ran, false, "차례를 못 얻었는데 돌았다");
  holder.open();
  await held;
});

test("M4 ★ 포기한 대기자 뒤의 대기자는 앞 실행이 끝나기 전에 끼어들지 않는다", async () => {
  const holder = gate();
  const log: string[] = [];
  const held = withDistillDispatch(async () => { log.push("앞 시작"); await holder.closed; log.push("앞 끝"); });
  await withDistillDispatch(async () => { log.push("포기해야 할 일"); }, { waitMs: 5 });
  const after = withDistillDispatch(async () => { log.push("뒤"); });
  await tickOver();
  assert.deepEqual(log, ["앞 시작"], "포기한 대기자가 줄을 풀어 뒤가 끼어들었다");
  holder.open();
  await Promise.all([held, after]);
  assert.deepEqual(log, ["앞 시작", "앞 끝", "뒤"]);
});

test("M5 워크스페이스가 다르면 서로 안 기다린다 · 같으면 기다린다", async () => {
  const holder = gate();
  const held = withTenant({ id: "ws-a", slug: "a" }, () => withDistillDispatch(() => holder.closed));
  const other = await withTenant({ id: "ws-b", slug: "b" }, () => withDistillDispatch(async () => "b 가 돌았다", { waitMs: 5 }));
  assert.equal(other, "b 가 돌았다", "남의 워크스페이스를 기다렸다");
  const same = await withTenant({ id: "ws-a", slug: "a" }, () => withDistillDispatch(async () => "돌면 안 된다", { waitMs: 5 }));
  assert.equal(same, null, "같은 워크스페이스인데 안 기다렸다");
  holder.open();
  await held;
});

test("M6 ★ 쥔 쪽이 끝나지 않아도 임대가 끝나면 다음이 돈다 — 매달린 잡 하나가 증류를 통째로 세우지 않는다", async () => {
  const hung = gate();
  const held = withDistillDispatch(() => hung.closed, { leaseMs: 10 });
  assert.equal(await withDistillDispatch(async () => "돌았다", { waitMs: 1_000 }), "돌았다");
  hung.open();
  await held;
});

test("M7 끝나면 줄이 비어 다음 실행이 바로 돈다", async () => {
  await withDistillDispatch(async () => undefined);
  assert.equal(await withDistillDispatch(async () => "바로", { waitMs: 0 }), "바로");
});

test("M3 잡 결과 — 차례를 못 얻으면 «안 돌았다» 다: 실패도 정상 실행도 아니다(엔진이 기록하지 않는다 · lane-jobs.pg-test D 표)", async () => {
  const holder = gate();
  const held = withDistillDispatch(() => holder.closed);
  let ran = false;
  const r = await oneDispatchAtATime(async () => { ran = true; return { status: "ok", summary: {} }; }, { waitMs: 5 });
  assert.equal(ran, false);
  assert.equal(r.status, "deferred");
  assert.ok((r.summary as { skipped?: string }).skipped, "안 돈 이유를 말한다");
  holder.open();
  await held;
  //  차례를 얻으면 그 실행의 결과를 그대로 돌려준다.
  const done = await oneDispatchAtATime(async () => ({ status: "error", summary: { error: "x" } }));
  assert.deepEqual(done, { status: "error", summary: { error: "x" } });
});
