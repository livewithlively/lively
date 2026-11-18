// 크론 액션 workspace_evict(#5368) — 배선과 안전선. 고르는 규칙(planEviction)은 ops/workspace-reclaim.test.ts 가 값으로 잰다.
//  여기서 못 박는 것:
//   V1 report(기본)는 아무것도 지우지 않는다 · V2 on 은 고른 것만 지운다 · V3 디스크가 넉넉하면 on 이어도 지우지 않는다
//   V4 세션 목록을 못 읽으면 회차를 그만둔다(지우지 않는다) · V5 작업 중 · 최근에 쓴 워크트리는 지우지 않는다
//   V6 워크트리 제거를 요청하지 않는다(기본 의존성이 applyReclaim 에 removeWorktree 를 넘기지 않는다)
//  실행: npm run build && node dist/scheduler/actions/workspace-evict.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWorkspaceEvict, type EvictDeps } from "./workspace-evict.js";
import type { ReclaimPlan } from "../../ops/workspace-reclaim.js";

const DAY = 86_400_000;
const GB = 1e9;
const root = await fsp.mkdtemp(path.join(os.tmpdir(), "evict-"));

interface Wt { name: string; gb: number; daysAgo: number; active?: boolean }
function deps(wts: Wt[], o: { usedPct: number | null; sessionsThrow?: boolean }): { d: EvictDeps; applied: string[] } {
  const applied: string[] = [];
  const by = new Map(wts.map((w) => [path.join(root, w.name), w]));
  const d: EvictDeps = {
    roots: () => [root, path.join(root, "없는-폴더")],
    activeSessionDirs: async () => { if (o.sessionsThrow) throw new Error("tmux 죽음"); return []; },
    disk: async () => (o.usedPct === null ? null : { usedPct: o.usedPct, totalBytes: 100 * GB }),
    worktrees: async (r) => (r === root ? [...by.keys()] : []),
    plan: async (wt) => ({
      worktree: wt, entries: [], reclaimableBytes: by.get(wt)!.gb * GB, active_session: !!by.get(wt)!.active,
      worktree_check: { removable: false, reason: null, dirty: false, unpushed: 0, branch: null },
    } as ReclaimPlan),
    lastUsed: async (wt) => Date.now() - by.get(wt)!.daysAgo * DAY,
    apply: async (plan) => { applied.push(path.basename(plan.worktree)); return { freedBytes: plan.reclaimableBytes }; },
  };
  return { d, applied };
}
const WTS: Wt[] = [{ name: "old", gb: 4, daysAgo: 30 }, { name: "mid", gb: 4, daysAgo: 10 }, { name: "fresh", gb: 4, daysAgo: 1 }, { name: "busy", gb: 4, daysAgo: 40, active: true }];
type Sum = { mode: string; picked: number; evicted: number; freed_bytes: number; paths: string[]; skipped: { active: number; fresh: number }; reason: string | null; error?: string };

{ // V1
  const { d, applied } = deps(WTS, { usedPct: 99 });
  const r = await runWorkspaceEvict({}, undefined, d);
  const s = r.summary as Sum;
  assert.equal(r.status, "ok");
  assert.equal(s.mode, "report", "V1 기본은 report");
  assert.deepEqual(applied, [], "V1 report 는 아무것도 지우지 않는다");
  assert.equal(s.picked, 2, "V1 무엇을 지울지는 요약한다");
  assert.deepEqual(s.paths.map((p) => path.basename(p)), ["old", "mid"], "V1 오래 안 쓴 것부터");
  for (const mode of ["On", "true", "1", " report "]) {
    const x = deps(WTS, { usedPct: 99 });
    await runWorkspaceEvict({ mode }, undefined, x.d);
    assert.deepEqual(x.applied, [], `V1 mode='${mode}' 는 on 이 아니다`);
  }
}
{ // V2 · V5
  const { d, applied } = deps(WTS, { usedPct: 99 });
  const r = await runWorkspaceEvict({ mode: "on" }, undefined, d);
  const s = r.summary as Sum;
  assert.deepEqual(applied, ["old", "mid"], "V2 on 은 고른 것만 지운다 · V5 작업 중(busy) · 최근(fresh)은 남긴다");
  assert.equal(s.evicted, 2);
  assert.equal(s.freed_bytes, 8 * GB);
  assert.deepEqual([s.skipped.active, s.skipped.fresh], [1, 1], "V5 건너뛴 사유를 센다");
}
{ // V3
  for (const usedPct of [50, 84.9, null]) {
    const { d, applied } = deps(WTS, { usedPct });
    const r = await runWorkspaceEvict({ mode: "on" }, undefined, d);
    assert.deepEqual(applied, [], `V3 디스크 ${usedPct} — 넉넉하거나 못 쟀으면 on 이어도 지우지 않는다`);
    assert.ok((r.summary as Sum).reason, "V3 왜 안 지웠는지 적는다");
  }
  const { d, applied } = deps(WTS, { usedPct: 70 });
  await runWorkspaceEvict({ mode: "on", pressure_pct: "60", target_pct: "55" }, undefined, d);
  assert.deepEqual(applied, ["old", "mid"], "V3 기준을 낮추면 그 기준으로 지운다(문자열 값도 읽는다)");
}
{ // V4
  const { d, applied } = deps(WTS, { usedPct: 99, sessionsThrow: true });
  const r = await runWorkspaceEvict({ mode: "on" }, undefined, d);
  assert.equal(r.status, "error", "V4 세션 목록을 못 읽으면 error");
  assert.deepEqual(applied, [], "V4 그리고 아무것도 지우지 않는다");
}
{ // V6 — 소스로: 기본 의존성이 워크트리 제거를 요청하지 않는다.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const src = fs.readFileSync(path.join(here, "..", "..", "..", "src", "scheduler", "actions", "workspace-evict.ts"), "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  assert.ok(/apply: \(plan\) => applyReclaim\(plan, \{\}\)/.test(src), "V6 applyReclaim 에 빈 옵션만 넘긴다");
  assert.ok(!/removeWorktree\s*:/.test(src), "V6 removeWorktree 를 어디에서도 켜지 않는다");
}
await fsp.rm(root, { recursive: true, force: true });
console.log("workspace-evict.test.ts ok — report 는 쓰기 0 · on 은 고른 것만 · 넉넉하면 안 지움 · 세션 목록 실패면 그만둠 · 워크트리는 안 지움");
