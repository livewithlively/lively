// 위탁 배정 선점(withAssignClaim)과 in_flight 판정 — 사양 행위 1~10 (스크래치패드 spec.md).
//  틀렸을 때: 선점이 새면 즉시 배정 경로와 스케줄러가 같은 태스크에 판을 둘 띄워 작업 폴더를 놓고 다툰다.
//  반대로 선점이 안 풀리면 그 태스크는 영영 배정되지 않는다.
// 동시성은 타이머 없이 수동 gate(resolve 를 밖에서 쥔 Promise)로 결정적으로 재현한다.
import { strict as assert } from "node:assert";
import { withAssignClaim } from "./task-scheduler.js";
import { assignFailKind, headlessEnqueueStatus } from "./assign-outcome.js";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
const yes = async () => true;

// 선점한 채 run 을 gate 에 묶어 두고, run 진입을 확인한 뒤 돌려준다.
async function holdClaim(id: number, table: Set<number>) {
  const release = gate();
  const entered = gate();
  const p = withAssignClaim(id, yes, async () => { entered.open(); await release.promise; return "held"; }, table);
  await entered.promise;
  return { p, release: release.open };
}

// ── 행위 1: run 이 안 끝난 사이 같은 id 호출은 run 없이 null ──
{
  const table = new Set<number>();
  const held = await holdClaim(1, table);
  let called = 0;
  const second = await withAssignClaim(1, yes, async () => { called++; return "second"; }, table);
  assert.equal(second, null, "진행 중인 같은 id 가 두 번째 호출을 통과시켰다 — 판이 둘 뜬다");
  assert.equal(called, 0, "선점당한 호출이 run 을 불렀다");
  held.release();
  assert.equal(await held.p, "held");
}

// ── 행위 2: 거의 동시에 들어온 두 호출 중 run 은 정확히 한 번 ──
{
  const table = new Set<number>();
  const release = gate();
  let runs = 0;
  const call = (tag: string) => withAssignClaim(2, yes, async () => { runs++; await release.promise; return tag; }, table);
  const pa = call("a");
  const pb = call("b");
  // 이긴 쪽은 gate 에 묶여 있으므로 먼저 끝나는 쪽은 진 쪽(null)뿐이다.
  const first = await Promise.race([pa, pb]);
  assert.equal(first, null, "먼저 끝난 쪽이 null 이 아니다 — 둘 다 run 에 들어갔다");
  assert.equal(runs, 1, "동시 호출에서 run 이 한 번이 아니다");
  release.open();
  const results = await Promise.all([pa, pb]);
  assert.equal(results.filter((r) => r === null).length, 1, "진 쪽이 정확히 하나가 아니다");
  assert.equal(results.filter((r) => r !== null).length, 1, "이긴 쪽이 정확히 하나가 아니다");
  assert.equal(runs, 1);
}

// ── 행위 3: 선점 후 stillQueued 가 false 면 run 없이 null ──
{
  const table = new Set<number>();
  let called = 0;
  const r = await withAssignClaim(3, async () => false, async () => { called++; return "x"; }, table);
  assert.equal(r, null, "이미 queued 가 아닌데 배정을 진행했다");
  assert.equal(called, 0, "stillQueued=false 인데 run 을 불렀다");
}

// ── 행위 4: run 이 성공·예외로 끝나면 선점이 풀리고, 예외는 그대로 전파 ──
{
  const table = new Set<number>();
  assert.equal(await withAssignClaim(4, yes, async () => "ok1", table), "ok1");
  assert.equal(await withAssignClaim(4, yes, async () => "ok2", table), "ok2", "성공 뒤에 선점이 남았다");

  const boom = new Error("run 실패");
  await assert.rejects(withAssignClaim(4, yes, async () => { throw boom; }, table),
    (e) => e === boom, "run 의 예외가 그대로 전파되지 않았다");
  assert.equal(await withAssignClaim(4, yes, async () => "after-throw", table), "after-throw",
    "run 이 던진 뒤 선점이 남았다 — 그 태스크는 영영 배정되지 않는다");
}

// ── 행위 5: stillQueued 가 던져도 선점이 풀리고 예외는 전파 ──
{
  const table = new Set<number>();
  const boom = new Error("조회 실패");
  let called = 0;
  await assert.rejects(
    withAssignClaim(5, async () => { throw boom; }, async () => { called++; return "x"; }, table),
    (e) => e === boom, "stillQueued 의 예외가 전파되지 않았다");
  assert.equal(called, 0, "stillQueued 가 던졌는데 run 을 불렀다");
  assert.equal(await withAssignClaim(5, yes, async () => "recovered", table), "recovered",
    "stillQueued 가 던진 뒤 선점이 남았다");
}

// ── 행위 6: 물러난 경우에도 선점이 남지 않는다 ──
{
  const table = new Set<number>();
  assert.equal(await withAssignClaim(6, async () => false, async () => "x", table), null);
  assert.equal(await withAssignClaim(6, yes, async () => "later", table), "later",
    "물러난 뒤에도 선점이 남아 다음 호출이 막혔다");
}

// ── 행위 7: 서로 다른 id 는 서로를 막지 않는다 ──
{
  const table = new Set<number>();
  const held = await holdClaim(7, table);
  assert.equal(await withAssignClaim(8, yes, async () => "other", table), "other",
    "다른 id 의 진행이 이 id 를 막았다");
  held.release();
  await held.p;
}

// ── 행위 8: run 의 반환값을 그대로 돌려준다 ──
{
  const table = new Set<number>();
  const value = { assigned: true, nodeId: 42 };
  assert.equal(await withAssignClaim(9, yes, async () => value, table), value, "반환값이 변형됐다");
}

// ── 행위 9: 주입한 table 만 쓴다 — 다른 Set 끼리는 서로를 막지 않는다 ──
{
  const tableA = new Set<number>();
  const tableB = new Set<number>();
  const held = await holdClaim(10, tableA);
  assert.equal(await withAssignClaim(10, yes, async () => "on-b", tableB), "on-b",
    "다른 table 의 선점이 이 table 의 같은 id 를 막았다 — 주입한 Set 을 안 쓴다");
  held.release();
  await held.p;
}

// ── 행위 10: in_flight 는 배압, 기존 코드 판정은 그대로 ──
{
  assert.equal(assignFailKind("in_flight"), "backpressure", "in_flight 를 고장으로 봤다 — 정상 경합이 실패로 기록된다");
  assert.equal(headlessEnqueueStatus({ assigned: false, code: "in_flight" }), "ok",
    "in_flight 미배정을 error 로 적었다 — 경합마다 브레이커를 때린다");
  assert.equal(assignFailKind("capacity"), "backpressure");
  for (const code of ["no_nodes", "no_harness", "node_disabled", "spawn_error", "no_credential"] as const) {
    assert.equal(assignFailKind(code), "fault", `${code} 의 판정이 바뀌었다`);
  }
  assert.equal(assignFailKind(undefined), "fault");
  assert.equal(assignFailKind(null), "fault");
  assert.equal(assignFailKind("made-up" as never), "fault", "모르는 코드를 배압으로 접었다");
}

// 배선 — 선점을 맞게 구현하고 배정 경로에서 안 쓰는 상태를 막는다. 즉시 배정과 tick 이 모두 assignOne 을 지나므로 거기를 본다.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/node/task-scheduler.ts", import.meta.url), "utf8");
  const start = src.indexOf("async function assignOne("), end = src.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "assignOne 본문 경계를 못 찾았다 — 함수 이름이 바뀌면 이 단언부터 고쳐라");
  const body = src.slice(start, end);
  assert.ok(/withAssignClaim\(t\.id,/.test(body), "assignOne 이 선점 없이 바로 판을 띄운다 — 이중 배정이 재발한다");
  assert.ok(/status === "queued"/.test(body), "선점 뒤 DB 상태를 다시 보지 않는다 — tick 의 오래된 목록이 running 행을 다시 띄운다");
}

// delegate_run 의 다음 행동 — in_flight 를 취소로 접으면 tick 쪽 판과 하네스 로컬 실행이 함께 돈다.
{
  const { delegateRunNext } = await import("./assign-outcome.js");
  assert.equal(delegateRunNext({ assigned: false, code: "in_flight" }, false), "proceed",
    "다른 경로가 띄우는 태스크를 취소하고 로컬 실행을 권했다 — 같은 일이 두 번 돈다");
  assert.equal(delegateRunNext({ assigned: false, code: "in_flight" }, true), "proceed", "in_flight 를 대기 등록으로 접었다");
  assert.equal(delegateRunNext({ assigned: true }, false), "proceed");
  assert.equal(delegateRunNext({ assigned: false, code: "capacity" }, false), "cancel", "queue:false 의 자리 부족은 종전대로 취소다");
  assert.equal(delegateRunNext({ assigned: false, code: "capacity" }, true), "queued");
  assert.equal(delegateRunNext({ assigned: false, code: "no_nodes" }, false), "cancel");
  const { readFileSync } = await import("node:fs");
  const del = readFileSync(new URL("../../src/capabilities/delegate.ts", import.meta.url), "utf8");
  assert.ok(/delegateRunNext\(r,/.test(del), "delegate_run 이 판정 함수를 안 쓴다 — in_flight 가 다시 취소로 떨어진다");
}

// in_flight 는 미배정 사유로 기록하지 않는다 — 기록하는 순간 이미 running 인 행의 result 에 «못 갔다» 가 끼어든다.
{
  const { readFileSync } = await import("node:fs");
  const store = readFileSync(new URL("../../src/node/task-store.ts", import.meta.url), "utf8");
  const start = store.indexOf("export async function noteAssignFailure(");
  assert.ok(start >= 0, "noteAssignFailure 를 못 찾았다 — 이름이 바뀌면 이 단언부터 고쳐라");
  assert.ok(/if \(code === "in_flight"\) return;/.test(store.slice(start, store.indexOf("\n}\n", start))),
    "noteAssignFailure 가 in_flight 도 기록한다 — 다른 경로가 띄운 running 행에 미배정 사유가 남는다");
}

console.log("task-assign-claim.test: ok");
