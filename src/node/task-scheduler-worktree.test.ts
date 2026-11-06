// 위탁 워크트리 회수의 스케줄러 배선 — 어느 위탁을 회수 대기열에 넣나 · 대기열이 가득 찼을 때 실패 세션 회수기가 그 행을 다시 집나.
//  틀리면: 원격 노드의 경로를 중앙에서 지우려 들거나(그 PC 의 경로다), 만석에 밀린 실패 위탁이 «걷힘» 으로 찍혀
//  다시는 안 집히고 워크트리가 영영 남는다(회수기는 session_reaped 가 찍힌 행을 다시 조회하지 않는다).
import { strict as assert } from "node:assert";
import { queueCentralWorktreeReclaim, deferReapWhenQueueFull, CENTRAL_NODE_ID } from "./task-scheduler.js";
import { reapFailedTaskSessions, type FailedTaskRow, type ReapAttempt } from "./failed-session-reaper.js";
import type { SerialQueue, EnqueueVerdict } from "./task-worktree-reclaim.js";

/** 받은 키를 적고 정해진 답을 주는 대기열 대역 — job 은 돌리지 않는다(배선만 본다). */
function fakeQueue(verdict: EnqueueVerdict): { queue: SerialQueue; keys: string[] } {
  const keys: string[] = [];
  return { keys, queue: { enqueue: (k) => { keys.push(k); return verdict; }, size: () => keys.length, idle: async () => {} } };
}

// ── 1 중앙에서 돈 레포 지정 위탁 → 위탁 id 를 문자열 키로 넣고, 대기열의 답을 그대로 돌려준다 ──
for (const v of ["queued", "duplicate", "full"] as const) {
  const { queue, keys } = fakeQueue(v);
  const got = queueCentralWorktreeReclaim({ id: 41, repo: "app", task_dir: "/w/d/.lively-task/41", node_id: CENTRAL_NODE_ID }, queue);
  assert.equal(got, v, `대기열 답(${v})을 그대로 돌려주지 않았다: ${got}`);
  assert.deepEqual(keys, ["41"], `위탁 id 를 문자열 키로 넣지 않았다: ${JSON.stringify(keys)}`);
}
//  pg 는 BIGSERIAL 을 문자열로 준다 — 숫자로 넣든 문자열로 넣든 같은 키여야 중복 제거가 새지 않는다
{
  const { queue, keys } = fakeQueue("queued");
  queueCentralWorktreeReclaim({ id: "41" as unknown as number, repo: "app", task_dir: "/w/d/.lively-task/41", node_id: CENTRAL_NODE_ID }, queue);
  assert.deepEqual(keys, ["41"], `문자열 id 가 다른 키가 됐다: ${JSON.stringify(keys)}`);
}

// ── 2 원격 노드 · node_id 없음 · 레포 없음 → 넣지 않는다(skip) ──
for (const [why, node_id, repo] of [
  ["원격 노드", "node-laptop", "app"],
  ["node_id 없음", null, "app"],
  ["레포 null", CENTRAL_NODE_ID, null],
  ["레포 빈 문자열", CENTRAL_NODE_ID, ""],
] as Array<[string, string | null, string | null]>) {
  const { queue, keys } = fakeQueue("queued");
  const got = queueCentralWorktreeReclaim({ id: 42, repo, task_dir: "/w/d/.lively-task/42", node_id }, queue);
  assert.equal(got, "skip", `${why}: skip 이 아니다(${got})`);
  assert.deepEqual(keys, [], `${why}: 대기열에 넣었다 — 중앙이 지울 수 없는 워크트리다`);
}

// ── 3 회수기 판정: 세션은 걷었는데 대기열이 만석 → «아직»(다시 집게) · 닿지 못함으로(포기 상한에 안 걸리게) ──
{
  const a = deferReapWhenQueueFull({ done: true }, "full");
  assert.equal(a.done, false, "만석에 밀린 행을 걷힘으로 표시하게 했다 — 다시 안 집혀 워크트리가 영영 남는다");
  assert.equal(a.reached, false, "만석을 «노드가 거절함» 으로 보고했다 — 열 번이면 포기 표시가 찍힌다");
  assert.ok(typeof a.why === "string" && a.why.length > 0, "미룬 사유가 없다");
}
// ── 4 queued · duplicate · skip 이면 kill 판정 그대로 ──
for (const v of ["queued", "duplicate", "skip"] as const) {
  const before: ReapAttempt = { done: true };
  assert.deepEqual(deferReapWhenQueueFull(before, v), before, `${v} 인데 kill 판정을 바꿨다`);
}
// ── 5 kill 자체가 실패했으면 만석이어도 kill 판정(사유·닿음) 그대로 ──
{
  const before: ReapAttempt = { done: false, reached: true, why: "403 본인 세션이 아닙니다" };
  assert.deepEqual(deferReapWhenQueueFull(before, "full"), before, "kill 실패 판정을 만석 판정으로 덮었다 — 노드 원문 사유가 사라진다");
}

// ── 6 실제 회수기와 이어서: 만석으로 미룬 행은 걷힘 표시 없이 백오프 예약만 받고, 열 번째에도 포기하지 않는다. 자리가 나면 걷힘 ──
{
  const row: FailedTaskRow = {
    id: 501, node_id: CENTRAL_NODE_ID, session_id: "box-x-00000001", requester: "u1",
    task_dir: "/w/d/.lively-task/501", repo: "app", finished_at: new Date(0).toISOString(), reap_fails: 9,
  };
  const run = async (queued: EnqueueVerdict) => {
    const marked: number[] = [], attempts: Array<[number, number]> = [], gaveUp: number[] = [];
    let kills = 0;
    const res = await reapFailedTaskSessions(
      async () => { kills++; return deferReapWhenQueueFull({ done: true }, queued); },
      { keep: 0, ttlMin: 0 },
      {
        list: async () => [row],
        mark: async (ids) => { marked.push(...ids); },
        markAttempt: async (id, fails) => { attempts.push([id, fails]); },
        markGaveUp: async (id) => { gaveUp.push(id); },
        alert: (async () => {}) as never,
        now: () => Date.now(),
      },
    );
    return { res, marked, attempts, gaveUp, kills };
  };
  const full = await run("full");
  assert.equal(full.kills, 1, "회수기가 그 행을 시도하지 않았다(배선)");
  assert.deepEqual(full.marked, [], "만석으로 미룬 행을 걷힘으로 표시했다 — 다음 조회에서 빠져 워크트리를 다시 안 본다");
  assert.deepEqual(full.attempts, [[501, 10]], `백오프 예약(다음 회차)이 없다: ${JSON.stringify(full.attempts)}`);
  assert.deepEqual(full.gaveUp, [], "만석(대기열이 비면 풀리는 일)으로 포기 표시를 찍었다");
  const roomy = await run("queued");
  assert.deepEqual(roomy.marked, [501], "대기열에 들어갔는데 걷힘으로 표시하지 않았다 — 같은 세션을 계속 다시 걷는다");
  assert.deepEqual(roomy.attempts, [], "대기열에 들어갔는데 실패로 셌다");
}

console.log("task-scheduler-worktree.test: ok");
