// 위탁 작업 워크트리 회수.
//  이 판정이 틀리면: 안 걷으면 위탁마다 레포 크기만큼 디스크가 쌓이고, 잘못 걷으면 살아 있는 세션·남의 워크트리·push 안 한 작업을 지운다.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { taskWorktreePath, reclaimTaskWorktree, defaultReclaimDeps, type ReclaimDeps, type TaskWorktreeRef } from "./task-worktree-reclaim.js";
import type { WorktreeCheck, ReclaimPlan, ReclaimResult } from "../ops/workspace-reclaim.js";

const WS = "/w/delegated/task-7";
const T7: TaskWorktreeRef = { id: 7, repo: "app", task_dir: `${WS}/.lively-task/7` };
const WT7 = path.join(WS, "app");

const okCheck = (over: Partial<WorktreeCheck> = {}): WorktreeCheck => ({
  removable: true, reason: null, dirty: false, unpushed: 0, branch: "delegate/task-7", ...over,
});

interface Calls { check: string[]; base: string[]; apply: Array<{ plan: ReclaimPlan; opts?: { removeWorktree?: boolean; repoRoot?: string } }> }
function fakeDeps(over: Partial<ReclaimDeps> = {}): { deps: ReclaimDeps; calls: Calls } {
  const calls: Calls = { check: [], base: [], apply: [] };
  const deps: ReclaimDeps = {
    exists: () => true,
    activeSessionDirs: async () => [],
    checkWorktree: async (wt) => { calls.check.push(wt); return okCheck(); },
    baseRepoOf: async (wt) => { calls.base.push(wt); return "/base/app"; },
    applyReclaim: async (plan, opts) => {
      calls.apply.push({ plan, opts });
      return { removed: [], freedBytes: 0, worktreeRemoved: true, worktreeSkippedReason: null } satisfies ReclaimResult;
    },
    ...over,
  };
  // 덮어쓴 함수도 호출 기록은 남긴다
  if (over.checkWorktree) { const f = over.checkWorktree; deps.checkWorktree = async (wt) => { calls.check.push(wt); return f(wt); }; }
  if (over.applyReclaim) { const f = over.applyReclaim; deps.applyReclaim = async (p, o) => { calls.apply.push({ plan: p, opts: o }); return f(p, o); }; }
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

// ── ②-b 세션 목록을 못 읽으면 안 지우고 오류를 사유로 ──
{
  const { deps, calls } = fakeDeps({ activeSessionDirs: async () => { throw new Error("boom-sessions"); } });
  const r = await reclaimTaskWorktree(T7, deps);
  assert.equal(r.removed, false, "세션 목록을 못 읽었는데 지웠다 — 모르면 건드리지 않아야 한다");
  assert.ok(r.reason?.includes("boom-sessions"), `세션 목록 오류가 reason 에 없다: ${r.reason}`);
  assert.equal(calls.apply.length, 0, "세션 목록을 못 읽었는데 제거를 요청했다");
}

// ── ③ 브랜치가 delegate/task-<id> 가 아니면 남의 워크트리 — 안 지운다 ──
for (const branch of ["project/12", null, "delegate/task-8"]) {
  const { deps, calls } = fakeDeps({ checkWorktree: async () => okCheck({ branch }) });
  const r = await reclaimTaskWorktree(T7, deps);
  assert.equal(r.removed, false, `브랜치 ${branch} 인 워크트리를 지웠다`);
  assert.ok(typeof r.reason === "string" && r.reason.length > 0, `브랜치 ${branch} 건너뛴 사유가 없다`);
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

// ── ⑥ 점검·제거 중 오류는 throw 하지 않고 reason 으로 ──
for (const [where, over] of [
  ["checkWorktree", { checkWorktree: async () => { throw new Error("boom-check"); } }],
  ["applyReclaim", { applyReclaim: async () => { throw new Error("boom-apply"); } }],
] as Array<[string, Partial<ReclaimDeps>]>) {
  const { deps } = fakeDeps(over);
  const r = await reclaimTaskWorktree(T7, deps);
  assert.equal(r.removed, false, `${where} 오류인데 removed=true`);
  assert.ok(r.reason?.includes(where === "checkWorktree" ? "boom-check" : "boom-apply"), `${where} 오류 메시지가 reason 에 없다: ${r.reason}`);
}

// ── 실제 git — 기본 의존성(세션 목록만 빈 배열): push 끝난 깨끗한 위탁 워크트리는 끝에서 끝까지 걷힌다 ──
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
{
  const id = 41;
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "twr-")));
  try {
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
    git(base, "worktree", "add", "-q", wt, "-b", `delegate/task-${id}`);
    const taskDir = path.join(ws, ".lively-task", String(id));
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(taskDir, "result.md"), "done\n");
    writeFileSync(path.join(wt, "work.txt"), "w\n");
    git(wt, "add", "work.txt");
    git(wt, "commit", "-q", "-m", "work");
    git(wt, "push", "-q", "-u", "origin", `delegate/task-${id}`);

    const r = await reclaimTaskWorktree({ id, repo: "app", task_dir: taskDir }, { ...defaultReclaimDeps, activeSessionDirs: async () => [] });
    assert.equal(r.removed, true, `push 끝난 깨끗한 워크트리를 안 걷었다: ${r.reason}`);
    assert.equal(existsSync(wt), false, "removed=true 인데 폴더가 남았다");
    assert.ok(!git(base, "worktree", "list", "--porcelain").includes(wt), "base 의 worktree list 에 남았다 — 등록 찌꺼기");
    assert.equal(existsSync(path.join(taskDir, "result.md")), true, "위탁 결과(.lively-task)까지 지웠다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("task-worktree-reclaim.test: ok");
