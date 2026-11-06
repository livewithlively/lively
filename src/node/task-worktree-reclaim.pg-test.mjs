// 위탁 워크트리 회수 — «같은 작업 폴더를 쓰는 끝나지 않은 다른 위탁» 판정의 PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=… node src/node/task-worktree-reclaim.pg-test.mjs
//
// 왜 이 계층인가: 판정 재료가 org_task 조회 한 문장이다 — «그 위탁 행 + 끝나지 않은(queued·running) 행», id 는 문자열.
//  목으로는 상태 이름을 틀리거나 자기 행을 빠뜨려도 초록이다. 그래서 행을 위탁 생애주기(createTask → markRunning →
//  markFinished·markCanceled·requeue)로 만들고, 배정 중인 위탁(queued — task_dir 이 아직 비어 있다)이 회수를 막는지 본다.
//  파일·git·세션은 «지워도 되는 깨끗한 위탁 워크트리» 대역이다 — 여기서 보는 것은 DB 판정뿐이다(실제 git 은 유닛 시험이 본다).
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
if (!process.env.ITEMS_DATABASE_URL) { console.error("ITEMS_DATABASE_URL 이 필요하다(실 Postgres)"); process.exit(2); }
const { itemsPool } = await import(`${DIST}/db/client.js`);
const st = await import(`${DIST}/node/task-store.js`);
const { reclaimTaskWorktree } = await import(`${DIST}/node/task-worktree-reclaim.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const REQ = "__twr_pg__";
//  다른 시험이 남긴 행과 겹치지 않는 작업 폴더 — 판정은 org_task 전체의 끝나지 않은 행을 보므로 이름을 고유하게 둔다.
const SUB = `__twr_pg__/${process.pid}-${Date.now()}/nightly`;
const ROOT = "/srv/lively-shared";   // 경로만 쓴다(파일은 만들지 않는다)
const taskDirOf = (root, sub, id) => `${root}/${sub}/.lively-task/${id}`;
const cleanup = () => itemsPool.query(`DELETE FROM org_task WHERE requester=$1`, [REQ]);
const mk = async (subpath) => (await st.createTask({ requester: REQ, prompt: "pg-test", subpath, repo: "app" })).id;

/** 실제 DB 조회로 판정한다. removed = 제거를 한 번 요청했고 결과가 removed. */
async function decide(self) {
  const applied = [];
  const r = await reclaimTaskWorktree(self, {
    exists: () => true,
    activeSessionDirs: async () => [],
    realpath: async (p) => p,
    workspaceTasks: (id) => st.workspaceTaskRows(id),
    checkWorktree: async () => ({ removable: true, reason: null, dirty: false, unpushed: 0, branch: `delegate/task-${self.id}` }),
    baseRepoOf: async () => "/base/app",
    applyReclaim: async (plan) => { applied.push(plan.worktree); return { removed: [], freedBytes: 0, worktreeRemoved: true, worktreeSkippedReason: null }; },
  });
  return { removed: r.removed && applied.length === 1, applied: applied.length, reason: r.reason, undetermined: r.undetermined ?? false };
}

try {
  await cleanup();

  // 끝난 위탁 A — 작업 폴더 <ROOT>/<SUB>, 워크트리 <ROOT>/<SUB>/app
  const a = await mk(SUB);
  await st.markRunning(a, "central", "box-twr-a", taskDirOf(ROOT, SUB, a));
  await st.markFinished(a, true, {});
  const A = { id: a, repo: "app", task_dir: taskDirOf(ROOT, SUB, a) };

  // R0 — 조회 모양: 자기 행(끝났어도 — 내 작업 폴더 규칙의 재료) + 끝나지 않은 행만, id 는 문자열
  const rows0 = await st.workspaceTaskRows(a);
  const mine = rows0.find((r) => r.id === String(a));
  chk("R0 자기 행은 끝났어도 함께 온다", mine?.status === "done" && mine?.subpath === SUB, JSON.stringify(mine));
  chk("R0 id 는 문자열이다", rows0.length > 0 && rows0.every((r) => typeof r.id === "string"), JSON.stringify(rows0.map((r) => typeof r.id)));
  chk("R0 다른 행은 끝나지 않은(queued·running) 것만 온다", rows0.every((r) => r.id === String(a) || r.status === "queued" || r.status === "running"),
    JSON.stringify(rows0.filter((r) => r.id !== String(a)).map((r) => r.status)));

  // P1 — 같은 폴더를 쓰는 다른 위탁이 없으면 회수한다
  const p1 = await decide(A);
  chk("P1 다른 위탁이 없으면 회수한다", p1.removed, JSON.stringify(p1));

  // P2 — 같은 subpath 의 위탁 B 가 막 들어와 배정 중(queued · task_dir 없음)이면 회수하지 않는다 ← B1 의 창
  const b = await mk(SUB);
  const bRow = (await itemsPool.query(`SELECT status, task_dir FROM org_task WHERE id=$1`, [b])).rows[0];
  chk("P2 준비: 막 만든 위탁은 queued 이고 task_dir 이 비어 있다", bRow?.status === "queued" && bRow?.task_dir === null, JSON.stringify(bRow));
  const p2 = await decide(A);
  chk("P2 같은 폴더의 queued(배정 중) 위탁이 있으면 회수하지 않는다", !p2.removed && p2.applied === 0 && !!p2.reason?.includes(`#${b}`), JSON.stringify(p2));

  // P3 — B 가 같은 <ws> 에서 running 이면 회수하지 않는다
  await st.markRunning(b, "central", "box-twr-b", taskDirOf(ROOT, SUB, b));
  const p3 = await decide(A);
  chk("P3 같은 <ws> 의 running 위탁이 있으면 회수하지 않는다", !p3.removed && p3.applied === 0 && !!p3.reason?.includes(`#${b}`), JSON.stringify(p3));

  // P4 — B 가 실패로 끝나면 회수한다
  await st.markFinished(b, false, {}, "pg-test");
  const p4 = await decide(A);
  chk("P4 같은 폴더의 위탁이 끝나면(failed) 회수한다", p4.removed, JSON.stringify(p4));

  // P5 — 기본 subpath('')로 배정 중인 위탁 C 는 그 위탁 고유 폴더(delegated/task-<C>)라 막지 않는다
  const c = await mk("");
  const p5 = await decide(A);
  chk("P5 다른 폴더(기본 subpath)의 queued 위탁은 회수를 막지 않는다", p5.removed, JSON.stringify(p5));
  await st.markCanceled(c);

  // P6 — 같은 subpath 라도 running 행의 task_dir 이 다른 <ws>(다른 루트)를 가리키면 막지 않는다 — task_dir 로 잴 수 있으면 그게 사실이다
  const d = await mk(SUB);
  await st.markRunning(d, "central", "box-twr-d", taskDirOf("/srv/isolated-shared", SUB, d));
  const p6 = await decide(A);
  chk("P6 다른 <ws> 에서 running 인 위탁은 회수를 막지 않는다", p6.removed, JSON.stringify(p6));

  // P7 — D 가 노드 유실로 재큐되면(queued · task_dir 비움) 다시 배정 중이다 — subpath 로 재서 막는다
  await st.requeue(d, { node: "central", session: "box-twr-d" });
  const p7 = await decide(A);
  chk("P7 재큐되어 다시 배정 중인 같은 폴더 위탁은 회수를 막는다", !p7.removed && p7.applied === 0 && !!p7.reason?.includes(`#${d}`), JSON.stringify(p7));

  // P8 — D 가 취소되면 회수한다
  await st.markCanceled(d);
  const p8 = await decide(A);
  chk("P8 같은 폴더의 위탁이 취소되면(canceled) 회수한다", p8.removed, JSON.stringify(p8));
} catch (e) {
  bad("예외", String(e && e.stack || e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`task-worktree-reclaim.pg-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
