// 위탁 작업 워크트리 회수.
//  이 판정이 틀리면: 안 걷으면 위탁마다 레포 크기만큼 디스크가 쌓이고, 잘못 걷으면 살아 있는 세션·남의 워크트리·push 안 한 작업·
//  같은 작업 폴더에 막 배정된 다음 위탁의 작업면을 지운다. 대기열이 틀리면 회수가 한꺼번에 돌아 박스를 누르거나(동시성)
//  다른 워크스페이스의 테넌트로 DB 를 읽는다(문맥).
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  taskWorktreePath, reclaimTaskWorktree, defaultReclaimDeps, createSerialQueue,
  type ReclaimDeps, type TaskWorktreeRef, type WorkspaceTaskRow,
} from "./task-worktree-reclaim.js";
import { withTenant, currentTenant } from "../org/tenant-context.js";
import type { WorktreeCheck, ReclaimPlan, ReclaimResult } from "../ops/workspace-reclaim.js";

const WS = "/w/delegated/task-7";
const T7: TaskWorktreeRef = { id: 7, repo: "app", task_dir: `${WS}/.lively-task/7` };
const WT7 = path.join(WS, "app");
//  위탁 상태 조회가 돌려주는 이 위탁 자신의 행(끝났다 · subpath 비어 기본 폴더 delegated/task-7). pg 는 id 를 문자열로 준다.
const SELF_ROW: WorkspaceTaskRow = { id: "7", status: "done", subpath: "", task_dir: `${WS}/.lively-task/7` };

const okCheck = (over: Partial<WorktreeCheck> = {}): WorktreeCheck => ({
  removable: true, reason: null, dirty: false, unpushed: 0, branch: "delegate/task-7", ...over,
});

interface Calls {
  order: string[]; check: string[]; base: string[]; tasks: number[];
  apply: Array<{ plan: ReclaimPlan; opts?: { removeWorktree?: boolean; repoRoot?: string } }>;
}
function fakeDeps(over: Partial<ReclaimDeps> = {}): { deps: ReclaimDeps; calls: Calls } {
  const calls: Calls = { order: [], check: [], base: [], tasks: [], apply: [] };
  const deps: ReclaimDeps = {
    exists: () => true,
    activeSessionDirs: async () => [],
    realpath: async (p) => p,
    workspaceTasks: async () => [SELF_ROW],
    checkWorktree: async () => okCheck(),
    baseRepoOf: async (wt) => { calls.base.push(wt); return "/base/app"; },
    applyReclaim: async () => ({ removed: [], freedBytes: 0, worktreeRemoved: true, worktreeSkippedReason: null } satisfies ReclaimResult),
    ...over,
  };
  // 덮어쓴 함수도 호출 기록(순서 포함)은 남긴다
  const check = deps.checkWorktree, tasks = deps.workspaceTasks, apply = deps.applyReclaim;
  deps.checkWorktree = async (wt) => { calls.check.push(wt); calls.order.push("check"); return check(wt); };
  deps.workspaceTasks = async (id) => { calls.tasks.push(id); calls.order.push("tasks"); return tasks(id); };
  deps.applyReclaim = async (p, o) => { calls.apply.push({ plan: p, opts: o }); calls.order.push("apply"); return apply(p, o); };
  return { deps, calls };
}

// ── taskWorktreePath: <ws>/.lively-task/<id> → <ws>/<repo> (ws 는 임의 경로) ──
for (const ws of ["/w/delegated/task-7", "/w/project/12"]) {
  assert.equal(taskWorktreePath({ id: 7, repo: "app", task_dir: `${ws}/.lively-task/7` }), path.join(ws, "app"), `ws=${ws} 에서 경로를 못 만들었다`);
}

// ── taskWorktreePath: 해석 불가 입력은 null ──
for (const [why, t] of [
  ["repo 없음", { id: 7, task_dir: `${WS}/.lively-task/7` }],
  ["repo null", { id: 7, repo: null, task_dir: `${WS}/.lively-task/7` }],
  ["repo 빈 문자열", { id: 7, repo: "", task_dir: `${WS}/.lively-task/7` }],
  ["task_dir 없음", { id: 7, repo: "app" }],
  ["task_dir null", { id: 7, repo: "app", task_dir: null }],
  ["task_dir 빈 문자열", { id: 7, repo: "app", task_dir: "" }],
  ["repo 에 /", { id: 7, repo: "a/b", task_dir: `${WS}/.lively-task/7` }],
  ["repo 에 \\", { id: 7, repo: "a\\b", task_dir: `${WS}/.lively-task/7` }],
  ["repo .", { id: 7, repo: ".", task_dir: `${WS}/.lively-task/7` }],
  ["repo ..", { id: 7, repo: "..", task_dir: `${WS}/.lively-task/7` }],
  ["마지막 폴더가 다른 id", { id: 7, repo: "app", task_dir: `${WS}/.lively-task/8` }],
  ["부모가 .lively-task 아님", { id: 7, repo: "app", task_dir: `${WS}/results/7` }],
] as Array<[string, TaskWorktreeRef]>) {
  assert.equal(taskWorktreePath(t), null, `${why} 인데 경로를 만들었다 — 엉뚱한 폴더를 지울 수 있다`);
}

// ── ① 경로를 못 만들면 worktree=null · removed=false. repo 없으면 reason=null, 있으면 사람이 읽는 문장 ──
{
  const { deps, calls } = fakeDeps();
  const noRepo = await reclaimTaskWorktree({ id: 7, task_dir: `${WS}/.lively-task/7` }, deps);
  assert.deepEqual(noRepo, { worktree: null, removed: false, reason: null }, "레포 없는 위탁을 사유 있는 실패로 보고했다");
  const bad = await reclaimTaskWorktree({ id: 7, repo: "app", task_dir: `${WS}/results/7` }, deps);
  assert.equal(bad.worktree, null);
  assert.equal(bad.removed, false);
  assert.ok(typeof bad.reason === "string" && bad.reason.length > 0, "레포가 있는데 경로를 못 풀었는데 사유가 없다");
  assert.equal(calls.apply.length, 0, "경로도 모르는데 제거를 요청했다");
}

// ── ② 경로가 없으면(이미 회수됨) 조용히 끝, 제거 시도 없음 ──
{
  const { deps, calls } = fakeDeps({ exists: () => false });
  const r = await reclaimTaskWorktree(T7, deps);
  assert.deepEqual(r, { worktree: WT7, removed: false, reason: null }, "이미 회수된 자리를 실패로 보고했다");
  assert.equal(calls.apply.length, 0, "없는 경로에 제거를 요청했다");
}

// ── ②-b 살아 있는 세션이 워크트리 자신·그 안에 있으면 안 지운다. 바깥 세션은 막지 않는다 ──
for (const [dirs, blocks] of [
  [[WT7], true],
  [[path.join(WT7, "src", "deep")], true],
  [[path.join(WS, "other")], false],
  [[path.join(WS, "app2")], false],
  [[WS], false],
] as Array<[string[], boolean]>) {
  const { deps, calls } = fakeDeps({ activeSessionDirs: async () => dirs });
  const r = await reclaimTaskWorktree(T7, deps);
  if (blocks) {
    assert.equal(r.removed, false, `세션(${dirs})이 안에 있는데 지웠다 — 작업 중인 세션의 cwd 가 사라진다`);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0, `세션(${dirs}) 때문에 건너뛴 사유가 없다`);
    assert.equal(calls.apply.length, 0, `세션(${dirs})이 안에 있는데 제거를 요청했다`);
  } else {
    assert.equal(calls.apply.length, 1, `워크트리 바깥 세션(${dirs})이 회수를 막았다`);
  }
}

// ── ②-c 세션 가드는 심볼릭 링크를 푼 실제 경로로도 잰다(macOS /tmp → /private/tmp 처럼 루트가 링크인 박스). 못 풀면 적힌 그대로 ──
const ENOENT = async (): Promise<string> => { throw new Error("ENOENT"); };
for (const [why, dirs, realpath, blocks] of [
  ["세션 cwd 가 링크이고 실제 위치가 워크트리 안", ["/link/src"], async (p: string) => (p === "/link/src" ? `${WT7}/src` : p), true],
  ["워크트리가 링크 표기이고 세션 cwd 는 실제 경로", ["/real/delegated/task-7/app/x"], async (p: string) => (p === WT7 ? "/real/delegated/task-7/app" : p), true],
  ["워크트리 realpath 만 실패 — 적힌 경로로 잰다", ["/link/src"], async (p: string) => { if (p === WT7) throw new Error("ENOENT"); return p === "/link/src" ? `${WT7}/src` : p; }, true],
  ["realpath 실패 + 적힌 경로가 워크트리 밖", ["/elsewhere"], ENOENT, false],
  ["realpath 실패 + 적힌 경로가 워크트리 안", [path.join(WT7, "deep")], ENOENT, true],
] as Array<[string, string[], ReclaimDeps["realpath"], boolean]>) {
  const { deps, calls } = fakeDeps({ activeSessionDirs: async () => dirs, realpath });
  const r = await reclaimTaskWorktree(T7, deps);
  if (blocks) {
    assert.equal(calls.apply.length, 0, `${why}: 작업 중인 세션의 워크트리를 지우려 했다`);
    assert.equal(r.removed, false, `${why}: removed=true`);
  } else {
    assert.equal(calls.apply.length, 1, `${why}: 바깥 세션이 회수를 막았다(${r.reason})`);
  }
}

// ── ②-d 세션 목록을 못 읽으면 안 지우고 오류를 사유로 — 그리고 «판정 불가» 로 표시한다(호출부가 경고로 남긴다) ──
{
  const { deps, calls } = fakeDeps({ activeSessionDirs: async () => { throw new Error("boom-sessions"); } });
  const r = await reclaimTaskWorktree(T7, deps);
  assert.equal(r.removed, false, "세션 목록을 못 읽었는데 지웠다 — 모르면 건드리지 않아야 한다");
  assert.ok(r.reason?.includes("boom-sessions"), `세션 목록 오류가 reason 에 없다: ${r.reason}`);
  assert.equal(r.undetermined, true, "세션 목록을 못 읽은 것을 정상 유지와 같게 보고했다 — 경고로 안 남는다");
  assert.equal(calls.apply.length, 0, "세션 목록을 못 읽었는데 제거를 요청했다");
}

// ── ③ 브랜치가 delegate/task-<id> 가 아니면 남의 워크트리 — 안 지운다(정상 유지 — 판정 불가 표시 없음) ──
for (const branch of ["project/12", null, "delegate/task-8"]) {
  const { deps, calls } = fakeDeps({ checkWorktree: async () => okCheck({ branch }) });
  const r = await reclaimTaskWorktree(T7, deps);
  assert.equal(r.removed, false, `브랜치 ${branch} 인 워크트리를 지웠다`);
  assert.ok(typeof r.reason === "string" && r.reason.length > 0, `브랜치 ${branch} 건너뛴 사유가 없다`);
  assert.equal(r.undetermined, undefined, `브랜치 ${branch} 정상 유지를 판정 불가로 보고했다`);
  assert.equal(calls.apply.length, 0, `브랜치 ${branch} 인데 제거를 요청했다 — 프로젝트 워크트리를 날린다`);
}

// ── ④ 점검이 제거 불가면 안 지우고 점검 사유를 그대로 ──
{
  const { deps, calls } = fakeDeps({ checkWorktree: async () => okCheck({ removable: false, reason: "미커밋 변경 3건", dirty: true }) });
  const r = await reclaimTaskWorktree(T7, deps);
  assert.deepEqual(r, { worktree: WT7, removed: false, reason: "미커밋 변경 3건" }, "점검 사유가 그대로 안 왔다");
  assert.equal(calls.apply.length, 0, "제거 불가 판정인데 제거를 요청했다 — 작업을 잃는다");
}

// ── ⑤ 제거 가능: 워크트리만 제거 요청(파생물 개별삭제 없음), repoRoot=baseRepoOf, 결과를 그대로 ──
for (const res of [
  { worktreeRemoved: true, worktreeSkippedReason: null },
  { worktreeRemoved: false, worktreeSkippedReason: "worktree remove 거부" },
]) {
  const { deps, calls } = fakeDeps({
    applyReclaim: async () => ({ removed: [], freedBytes: 0, ...res }),
  });
  const r = await reclaimTaskWorktree(T7, deps);
  assert.equal(calls.apply.length, 1, "제거를 한 번 요청하지 않았다");
  const { plan, opts } = calls.apply[0];
  assert.equal(plan.worktree, WT7, "엉뚱한 경로의 제거를 요청했다");
  assert.deepEqual(plan.entries, [], "파생물 개별 삭제를 요청했다 — 워크트리 통째 제거만 해야 한다");
  assert.equal(opts?.removeWorktree, true, "워크트리 제거를 요청하지 않았다");
  assert.equal(opts?.repoRoot, "/base/app", "repoRoot 가 baseRepoOf 값이 아니다");
  assert.deepEqual(calls.base, [WT7], "baseRepoOf 를 워크트리 경로로 묻지 않았다");
  assert.deepEqual(r, { worktree: WT7, removed: res.worktreeRemoved, reason: res.worktreeSkippedReason }, "제거 결과를 그대로 안 돌려줬다");
}

// ── ⑥ 점검·제거 중 오류는 throw 하지 않고 reason 으로(판정 불가) ──
for (const [where, over] of [
  ["checkWorktree", { checkWorktree: async () => { throw new Error("boom-check"); } }],
  ["applyReclaim", { applyReclaim: async () => { throw new Error("boom-apply"); } }],
] as Array<[string, Partial<ReclaimDeps>]>) {
  const { deps } = fakeDeps(over);
  const r = await reclaimTaskWorktree(T7, deps);
  assert.equal(r.removed, false, `${where} 오류인데 removed=true`);
  assert.ok(r.reason?.includes(where === "checkWorktree" ? "boom-check" : "boom-apply"), `${where} 오류 메시지가 reason 에 없다: ${r.reason}`);
  assert.equal(r.undetermined, true, `${where} 오류를 정상 유지로 보고했다`);
}

// ── ⑦ B1: 같은 작업 폴더(<ws>)를 쓰는 끝나지 않은 다른 위탁이 있으면 안 지운다 ──
//  배정 중인 위탁은 queued 이고 task_dir 이 비어 있다 — 그 행은 작업 폴더 규칙(subpath, 비면 delegated/task-<id>)으로 잰다.
const row = (id: string, status: string, subpath: string, task_dir: string | null): WorkspaceTaskRow => ({ id, status, subpath, task_dir });
for (const [why, rows, blocker] of [
  ["다른 행 없음(목록이 비었다)", [], null],
  ["자기 행만", [SELF_ROW], null],
  ["running · 같은 <ws>", [SELF_ROW, row("8", "running", "delegated/task-7", `${WS}/.lively-task/8`)], "8"],
  ["running · 다른 <ws>(같은 레포)", [SELF_ROW, row("9", "running", "delegated/task-9", "/w/delegated/task-9/.lively-task/9")], null],
  ["running · subpath 는 같지만 실제 <ws> 가 다름(다른 루트)", [SELF_ROW, row("10", "running", "delegated/task-7", "/iso/delegated/task-7/.lively-task/10")], null],
  ["queued(배정 중) · 같은 subpath", [SELF_ROW, row("11", "queued", "delegated/task-7", null)], "11"],
  ["queued · 같은 폴더를 앞뒤 슬래시로", [SELF_ROW, row("12", "queued", "/delegated/task-7/", null)], "12"],
  ["queued · 같은 폴더를 ./·겹 슬래시·공백으로", [SELF_ROW, row("13", "queued", " ./delegated//task-7 ", null)], "13"],
  ["queued · subpath 비어 있음(그 위탁 고유 폴더)", [SELF_ROW, row("14", "queued", "", null)], null],
  ["queued · 다른 subpath", [SELF_ROW, row("15", "queued", "delegated/other", null)], null],
  ["done · 같은 <ws>", [SELF_ROW, row("16", "done", "delegated/task-7", `${WS}/.lively-task/16`)], null],
  ["failed · 같은 <ws>", [SELF_ROW, row("17", "failed", "delegated/task-7", `${WS}/.lively-task/17`)], null],
  ["canceled · 같은 subpath(배정 전 취소)", [SELF_ROW, row("18", "canceled", "delegated/task-7", null)], null],
  ["내 행이 목록에 없음 + queued 다른 폴더 — 내 폴더 규칙을 모르니 지키는 쪽", [row("19", "queued", "delegated/other", null)], "19"],
  ["내 행이 목록에 없음 + running 다른 <ws> — task_dir 로 잴 수 있다", [row("20", "running", "x", "/w/x/.lively-task/20")], null],
  ["running · task_dir 이 정규 모양 아님(샌드박스) · subpath 같음", [SELF_ROW, row("21", "running", "delegated/task-7", "/sandbox/data/21")], "21"],
  ["running · task_dir 이 정규 모양 아님 · subpath 다름", [SELF_ROW, row("22", "running", "delegated/zzz", "/sandbox/data/22")], null],
  ["내 id 는 숫자 7 · 행 id 는 문자열 \"7\" — 자기 행이 running 으로 보여도 세지 않는다", [row("7", "running", "", `${WS}/.lively-task/7`)], null],
] as Array<[string, WorkspaceTaskRow[], string | null]>) {
  const { deps, calls } = fakeDeps({ workspaceTasks: async () => rows });
  const r = await reclaimTaskWorktree(T7, deps);
  assert.deepEqual(calls.tasks, [7], `${why}: 위탁 상태를 이 위탁 id 로 묻지 않았다(배선)`);
  if (blocker) {
    assert.equal(calls.apply.length, 0, `${why}: 제거를 요청했다 — 같은 폴더에 막 배정된 위탁의 작업면이 사라진다`);
    assert.equal(r.removed, false, `${why}: removed=true`);
    assert.ok(r.reason?.includes(`#${blocker}`), `${why}: 막은 위탁(#${blocker})을 사유에 안 밝혔다: ${r.reason}`);
    assert.equal(r.undetermined, undefined, `${why}: 정상 유지를 판정 불가로 보고했다`);
  } else {
    assert.equal(calls.apply.length, 1, `${why}: 막을 위탁이 없는데 회수하지 않았다(${r.reason}) — 디스크가 샌다`);
  }
}

// ── ⑦-b 위탁 상태는 git 점검 뒤 · 제거 바로 앞에서 본다(그 사이 배정된 위탁을 놓치는 창을 줄인다) ──
{
  const { deps, calls } = fakeDeps();
  await reclaimTaskWorktree(T7, deps);
  assert.deepEqual(calls.order, ["check", "tasks", "apply"], `위탁 상태 조회 자리가 제거 바로 앞이 아니다: ${calls.order}`);
}

// ── ⑦-c 위탁 상태를 못 읽으면 안 지운다(판정 불가) ──
{
  const { deps, calls } = fakeDeps({ workspaceTasks: async () => { throw new Error("boom-db"); } });
  const r = await reclaimTaskWorktree(T7, deps);
  assert.equal(calls.apply.length, 0, "위탁 상태를 못 읽었는데 제거를 요청했다 — 모르면 건드리지 않아야 한다");
  assert.equal(r.removed, false);
  assert.equal(r.undetermined, true, "위탁 상태 조회 실패를 정상 유지로 보고했다");
  assert.ok(r.reason?.includes("boom-db"), `조회 오류가 reason 에 없다: ${r.reason}`);
}

// ── ⑧ 직렬 대기열 — 한 번에 하나 · 넣은 순서 · 같은 키 중복 제거 · 상한 · 오류 격리 · 넣은 쪽 문맥 ──
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };

// ⑧-1 서로 다른 세 건을 한꺼번에 넣어도 동시에 도는 건 하나, 넣은 순서대로 전부 끝난다
{
  const q = createSerialQueue({ cap: 10 });
  const log: string[] = [];
  let active = 0, peak = 0;
  const gates = { a: gate(), b: gate(), c: gate() };
  for (const k of ["a", "b", "c"] as const) {
    assert.equal(q.enqueue(k, async () => {
      active++; peak = Math.max(peak, active); log.push(`start-${k}`);
      await gates[k].promise;
      log.push(`end-${k}`); active--;
    }), "queued", `${k} 를 받지 않았다`);
  }
  await settle();
  assert.deepEqual(log, ["start-a"], `첫 건이 끝나기 전에 다른 건이 시작됐다: ${log}`);
  gates.c.open(); gates.b.open();   // 뒤 건의 문을 먼저 열어도 순서는 넣은 순서다
  await settle();
  assert.deepEqual(log, ["start-a"], `앞 건이 안 끝났는데 뒤 건이 시작됐다: ${log}`);
  gates.a.open();
  await q.idle();
  assert.deepEqual(log, ["start-a", "end-a", "start-b", "end-b", "start-c", "end-c"], `넣은 순서대로 하나씩 돌지 않았다: ${log}`);
  assert.equal(peak, 1, `동시에 ${peak}건이 돌았다 — 큰 레포 회수가 한꺼번에 터진다`);
  assert.equal(q.size(), 0, "다 끝났는데 남은 건이 있다");
}

// ⑧-2·3·4 같은 키: 대기 중이면 duplicate · 실행 중이면 duplicate · 끝난 뒤면 다시 받는다
{
  const q = createSerialQueue({ cap: 10 });
  const runs: string[] = [];
  const hold = gate(), started = gate();
  q.enqueue("a", async () => { runs.push("a"); started.open(); await hold.promise; });
  assert.equal(q.enqueue("b", async () => { runs.push("b"); }), "queued");
  assert.equal(q.enqueue("b", async () => { runs.push("b-dup"); }), "duplicate", "대기 중인 같은 위탁을 또 받았다");
  await started.promise;
  assert.equal(q.enqueue("a", async () => { runs.push("a-dup"); }), "duplicate", "실행 중인 같은 위탁을 또 받았다");
  hold.open();
  await q.idle();
  assert.deepEqual(runs, ["a", "b"], `같은 위탁이 두 번 돌았다: ${runs}`);
  assert.equal(q.enqueue("a", async () => { runs.push("a-again"); }), "queued", "끝난 위탁을 다시 받지 않았다");
  await q.idle();
  assert.deepEqual(runs, ["a", "b", "a-again"], `끝난 뒤 다시 받은 건이 돌지 않았다: ${runs}`);
}

// ⑧-5 상한 경계(cap=2): 실행 1 + 대기 0 → 받음, 실행 1 + 대기 1 → full. 비면 다시 받는다
{
  const q = createSerialQueue({ cap: 2 });
  const hold = gate(), started = gate();
  assert.equal(q.enqueue("a", async () => { started.open(); await hold.promise; }), "queued");
  await started.promise;
  assert.equal(q.size(), 1, "실행 중인 건이 셈에 안 들어갔다");
  assert.equal(q.enqueue("b", async () => {}), "queued", "상한 직전(실행 1)인데 받지 않았다");
  assert.equal(q.size(), 2, "대기 중인 건이 셈에 안 들어갔다");
  assert.equal(q.enqueue("c", async () => {}), "full", "상한(실행 1 + 대기 1 = 2)인데 받았다");
  assert.equal(q.size(), 2, "full 로 거절한 건이 셈에 들어갔다");
  hold.open();
  await q.idle();
  assert.equal(q.enqueue("c", async () => {}), "queued", "비었는데 다시 받지 않았다");
  await q.idle();
}

// ⑧-6 한 건이 던져도 다음 건은 돌고, 오류는 그 키와 함께 보고된다
{
  const errs: Array<[string, string]> = [];
  const q = createSerialQueue({ cap: 10, onError: (e, k) => errs.push([k, (e as Error).message]) });
  const ran: string[] = [];
  q.enqueue("bad", async () => { throw new Error("boom-job"); });
  q.enqueue("good", async () => { ran.push("good"); });
  await q.idle();
  assert.deepEqual(ran, ["good"], "앞 건의 오류가 대기열을 멈췄다");
  assert.deepEqual(errs, [["bad", "boom-job"]], `오류가 키와 함께 보고되지 않았다: ${JSON.stringify(errs)}`);
}

// ⑧-7 처리는 처음 넣은 쪽(A 워크스페이스)의 문맥에서 시작됐어도, B 문맥에서 넣은 건은 B 문맥으로 돈다
//  (어긋나면 B 의 회수가 A 테넌트로 위탁 상태·세션 desired 를 읽는다 — itemsPool 의 테넌트 바인딩이 AsyncLocalStorage 를 본다)
{
  const q = createSerialQueue({ cap: 10 });
  const seen: Record<string, string | null> = {};
  const hold = gate();
  withTenant({ id: "tenant-a", slug: "a" }, () => {
    q.enqueue("a", async () => { await hold.promise; seen.a = currentTenant()?.id ?? null; });
  });
  withTenant({ id: "tenant-b", slug: "b" }, () => {
    q.enqueue("b", async () => { await null; seen.b = currentTenant()?.id ?? null; });
  });
  q.enqueue("none", async () => { seen.none = currentTenant()?.id ?? null; });
  hold.open();
  await q.idle();
  assert.deepEqual(seen, { a: "tenant-a", b: "tenant-b", none: null }, `넣은 쪽 문맥으로 돌지 않았다: ${JSON.stringify(seen)}`);
}

// ⑧-8 넣는 호출은 job 을 그 자리에서 시작하지 않는다(호출부 — finish·회수기 — 는 넣고 곧바로 다음 일로 간다)
{
  const q = createSerialQueue({ cap: 10 });
  let started = false;
  q.enqueue("x", async () => { started = true; });
  assert.equal(started, false, "넣는 호출 안에서 job 이 시작됐다");
  await q.idle();
  assert.equal(started, true, "넣은 job 이 끝내 돌지 않았다");
}

// ⑧-9 다 비운 뒤 새로 넣어도 다시 돈다(처리 루프가 끝난 뒤의 깨우기)
{
  const q = createSerialQueue({ cap: 10 });
  const ran: string[] = [];
  q.enqueue("1", async () => { ran.push("1"); });
  await q.idle();
  await settle();
  q.enqueue("2", async () => { ran.push("2"); });
  await q.idle();
  await settle();
  assert.deepEqual(ran, ["1", "2"], `비운 뒤 넣은 건이 돌지 않았다: ${ran}`);
}

// ── 실제 git — 가짜 의존성은 kit 판정을 통째로 대신하므로, 지키는 경우는 실제 레포로 끝에서 끝까지 본다 ──
//  세션 목록·위탁 상태(DB)만 비운다. 나머지(파일시스템·realpath·git 점검·제거)는 기본 의존성 그대로다.
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const realDeps: ReclaimDeps = { ...defaultReclaimDeps, activeSessionDirs: async () => [], workspaceTasks: async () => [] };

/** 원격·base 와, 커밋 하나를 push 까지 끝낸 위탁 워크트리 `<root>/delegated/task-<id>/app`(브랜치 branch). */
function fixture(id: number, branch = `delegate/task-${id}`) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "twr-")));
  const remote = path.join(root, "remote.git");
  const base = path.join(root, "base");
  const ws = path.join(root, "delegated", `task-${id}`);
  git(root, "init", "--bare", "-q", remote);
  git(root, "clone", "-q", remote, base);
  writeFileSync(path.join(base, "README"), "x\n");
  git(base, "add", "README");
  git(base, "commit", "-q", "-m", "init");
  git(base, "push", "-q", "origin", "HEAD:main");
  mkdirSync(ws, { recursive: true });
  const wt = path.join(ws, "app");
  git(base, "worktree", "add", "-q", wt, "-b", branch);
  const taskDir = path.join(ws, ".lively-task", String(id));
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, "result.md"), "done\n");
  writeFileSync(path.join(wt, "work.txt"), "w\n");
  git(wt, "add", "work.txt");
  git(wt, "commit", "-q", "-m", "work");
  git(wt, "push", "-q", "-u", "origin", branch);
  const registered = (): boolean => git(base, "worktree", "list", "--porcelain").split("\n").includes(`worktree ${wt}`);
  return { root, wt, taskDir, registered, ref: { id, repo: "app", task_dir: taskDir } as TaskWorktreeRef };
}

// 기존 해피패스: push 끝난 깨끗한 위탁 워크트리는 끝에서 끝까지 걷힌다(결과 폴더는 남는다)
{
  const f = fixture(41);
  try {
    assert.equal(f.registered(), true, "준비가 잘못됐다 — 워크트리가 등록돼 있지 않다");
    const r = await reclaimTaskWorktree(f.ref, realDeps);
    assert.equal(r.removed, true, `push 끝난 깨끗한 워크트리를 안 걷었다: ${r.reason}`);
    assert.equal(existsSync(f.wt), false, "removed=true 인데 폴더가 남았다");
    assert.equal(f.registered(), false, "base 의 worktree list 에 남았다 — 등록 찌꺼기");
    assert.equal(existsSync(path.join(f.taskDir, "result.md")), true, "위탁 결과(.lively-task)까지 지웠다");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

// 지키는 경우: 추적 파일 수정 · 추적 안 된 새 파일 · push 안 한 커밋 · 남의 브랜치 · 재사용된 다른 위탁 브랜치 · 링크로 들어온 세션
for (const [why, id, branch, mutate, sessions] of [
  ["추적 파일을 고쳤다(미커밋)", 51, undefined, (wt: string) => appendFileSync(path.join(wt, "work.txt"), "more\n"), undefined],
  ["추적 안 된 새 파일이 있다", 52, undefined, (wt: string) => writeFileSync(path.join(wt, "new.txt"), "n\n"), undefined],
  ["push 안 한 커밋이 있다", 53, undefined, (wt: string) => {
    writeFileSync(path.join(wt, "local.txt"), "l\n"); git(wt, "add", "local.txt"); git(wt, "commit", "-q", "-m", "local only");
  }, undefined],
  ["브랜치가 project/12(프로젝트 워크트리를 재사용한 자리)", 54, "project/12", () => {}, undefined],
  ["브랜치가 delegate/task-99(앞 위탁의 워크트리를 재사용한 자리)", 55, "delegate/task-99", () => {}, undefined],
  ["살아 있는 세션의 cwd 가 링크를 거쳐 워크트리 안", 56, undefined, (wt: string) => mkdirSync(path.join(wt, "sub")),
    (root: string, wt: string) => { symlinkSync(wt, path.join(root, "link")); return [path.join(root, "link", "sub")]; }],
] as Array<[string, number, string | undefined, (wt: string) => void, ((root: string, wt: string) => string[]) | undefined]>) {
  const f = fixture(id, branch);
  try {
    mutate(f.wt);
    const dirs = sessions ? sessions(f.root, f.wt) : [];
    const r = await reclaimTaskWorktree(f.ref, { ...realDeps, activeSessionDirs: async () => dirs });
    assert.equal(r.removed, false, `${why}: removed=true`);
    assert.equal(existsSync(f.wt), true, `${why}: 워크트리 폴더를 지웠다 — 작업을 잃는다`);
    assert.equal(existsSync(path.join(f.wt, "work.txt")), true, `${why}: 워크트리 안의 파일이 사라졌다`);
    assert.equal(f.registered(), true, `${why}: base 의 워크트리 등록이 사라졌다`);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0, `${why}: 남긴 사유가 없다`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

console.log("task-worktree-reclaim.test: ok");
