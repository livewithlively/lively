// 파생물 자동 정리(#5368) — 배선과 안전선. 고르는 규칙(planEviction)은 ops/workspace-reclaim.test.ts 가 값으로 잰다.
//  여기서 못 박는 것:
//   V1 apply=false 는 아무것도 지우지 않는다 · V2 apply=true 는 고른 것만 지운다 · V3 디스크가 넉넉하면 지우지 않고, 그때는 세션 목록도
//   워크트리도 훑지 않는다 · V4 세션 목록을 못 읽으면 회차를 그만둔다(지우지 않는다) · V5 작업 중 · 최근에 쓴 워크트리는 지우지 않는다
//   V6 워크트리 제거를 요청하지 않는다(기본 의존성이 applyReclaim 에 removeWorktree 를 넘기지 않는다)
//   S1 정책이 꺼져 있으면 타이머 회차는 아무것도 하지 않는다 · S2 켜져 있으면 정책의 경고 임계 · 쉰 기간으로 돈다 · S3 회차가 겹치지 않는다
//   P1 정책 기본값 · 범위
//  실행: npm run build && node dist/ops/workspace-evict.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWorkspaceEvict, sweepDerivedEvict, lastDerivedEvict, resetDerivedEvict, parseLsofCwds, processCwds, type EvictDeps } from "./workspace-evict.js";
import type { ReclaimPlan } from "./workspace-reclaim.js";
import { DEFAULT_STORAGE_POLICY, normalizeStoragePolicy, derivedEvictPolicy, type StoragePolicy } from "../org/policies/storage-policy.js";

const DAY = 86_400_000;
const GB = 1e9;
const root = await fsp.mkdtemp(path.join(os.tmpdir(), "evict-"));

interface Wt { name: string; gb: number; daysAgo: number; active?: boolean }
interface Spy { applied: string[]; sessionCalls: number; scans: number }
function deps(wts: Wt[], o: { usedPct: number | null; sessionsThrow?: boolean; slowMs?: number }): { d: EvictDeps; spy: Spy } {
  const spy: Spy = { applied: [], sessionCalls: 0, scans: 0 };
  const by = new Map(wts.map((w) => [path.join(root, w.name), w]));
  const d: EvictDeps = {
    roots: () => [root, path.join(root, "없는-폴더")],
    activeSessionDirs: async () => { spy.sessionCalls++; if (o.sessionsThrow) throw new Error("tmux 죽음"); return []; },
    disk: async () => { if (o.slowMs) await new Promise((r) => setTimeout(r, o.slowMs)); return o.usedPct === null ? null : { usedPct: o.usedPct, totalBytes: 100 * GB }; },
    worktrees: async (r) => { spy.scans++; return r === root ? [...by.keys()] : []; },
    plan: async (wt) => ({
      worktree: wt, entries: [], reclaimableBytes: by.get(wt)!.gb * GB, active_session: !!by.get(wt)!.active,
      worktree_check: { removable: false, reason: null, dirty: false, unpushed: 0, branch: null },
    } as ReclaimPlan),
    lastUsed: async (wt) => Date.now() - by.get(wt)!.daysAgo * DAY,
    apply: async (plan) => { spy.applied.push(path.basename(plan.worktree)); return { freedBytes: plan.reclaimableBytes }; },
  };
  return { d, spy };
}
const WTS: Wt[] = [{ name: "old", gb: 4, daysAgo: 30 }, { name: "mid", gb: 4, daysAgo: 10 }, { name: "fresh", gb: 4, daysAgo: 1 }, { name: "busy", gb: 4, daysAgo: 40, active: true }];
const OPT = { pressurePct: 85, targetPct: 75, idleDays: 3 };

{ // V1
  const { d, spy } = deps(WTS, { usedPct: 99 });
  const r = await runWorkspaceEvict({ apply: false, ...OPT }, d);
  assert.equal(r.ok, true);
  assert.deepEqual(spy.applied, [], "V1 apply=false 는 아무것도 지우지 않는다");
  assert.equal(r.picked, 2, "V1 무엇을 지울지는 센다");
  assert.deepEqual(r.paths.map((p) => path.basename(p)), ["old", "mid"], "V1 오래 안 쓴 것부터");
  assert.deepEqual([r.evicted, r.freed_bytes], [0, 0], "V1 지운 것은 0");
}
{ // V2 · V5
  const { d, spy } = deps(WTS, { usedPct: 99 });
  const r = await runWorkspaceEvict({ apply: true, ...OPT }, d);
  assert.deepEqual(spy.applied, ["old", "mid"], "V2 고른 것만 지운다 · V5 작업 중(busy) · 최근(fresh)은 남긴다");
  assert.deepEqual([r.evicted, r.freed_bytes], [2, 8 * GB]);
  assert.deepEqual([r.skipped.active, r.skipped.fresh], [1, 1], "V5 건너뛴 사유를 센다");
}
{ // V3
  for (const usedPct of [50, 84.9, null]) {
    const { d, spy } = deps(WTS, { usedPct });
    const r = await runWorkspaceEvict({ apply: true, ...OPT }, d);
    assert.deepEqual(spy.applied, [], `V3 디스크 ${usedPct} — 넉넉하거나 못 쟀으면 지우지 않는다`);
    assert.ok(r.reason, "V3 왜 안 지웠는지 적는다");
    assert.deepEqual([spy.sessionCalls, spy.scans], [0, 0], "V3 그때는 세션 목록도 워크트리도 훑지 않는다");
  }
  const { d, spy } = deps(WTS, { usedPct: 70 });
  await runWorkspaceEvict({ apply: true, pressurePct: 60, targetPct: 55, idleDays: 3 }, d);
  assert.deepEqual(spy.applied, ["old", "mid"], "V3 기준을 낮추면 그 기준으로 지운다");
}
{ // V4
  const { d, spy } = deps(WTS, { usedPct: 99, sessionsThrow: true });
  const r = await runWorkspaceEvict({ apply: true, ...OPT }, d);
  assert.equal(r.ok, false, "V4 세션 목록을 못 읽으면 실패로 보고한다");
  assert.ok(r.error, "V4 사유를 적는다");
  assert.deepEqual([spy.applied, spy.scans], [[], 0], "V4 그리고 아무것도 지우지 않는다(워크트리도 안 훑는다)");
}
{ // V6 — 소스로: 기본 의존성이 워크트리 제거를 요청하지 않는다.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const src = fs.readFileSync(path.join(here, "..", "..", "src", "ops", "workspace-evict.ts"), "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  assert.ok(/apply: \(plan\) => applyReclaim\(plan, \{\}\)/.test(src), "V6 applyReclaim 에 빈 옵션만 넘긴다");
  assert.ok(!/removeWorktree\s*:/.test(src), "V6 removeWorktree 를 어디에서도 켜지 않는다");
}

// ── 타이머 회차 ──
const pol = (over: Partial<StoragePolicy>): (() => Promise<StoragePolicy>) => async () => normalizeStoragePolicy({ ...DEFAULT_STORAGE_POLICY, ...over });
{ // S1
  resetDerivedEvict();
  const { d, spy } = deps(WTS, { usedPct: 99 });
  const r = await sweepDerivedEvict(pol({ derived_evict_enabled: false }), d);
  assert.equal(r, null, "S1 정책이 꺼져 있으면 회차를 돌지 않는다");
  assert.deepEqual(spy.applied, [], "S1 아무것도 지우지 않는다");
  assert.equal(lastDerivedEvict(), null, "S1 마지막 보고도 남기지 않는다");
}
{ // S2
  resetDerivedEvict();
  const a = deps(WTS, { usedPct: 80 });
  await sweepDerivedEvict(pol({}), a.d);                                   // 기본 경고 임계 85 → 80% 는 넉넉
  assert.deepEqual(a.spy.applied, [], "S2 경고 임계 아래면 지우지 않는다");
  const b = deps(WTS, { usedPct: 80 });
  const r = await sweepDerivedEvict(pol({ disk_warn_pct: 70, derived_evict_idle_days: 20 }), b.d);
  assert.deepEqual(b.spy.applied, ["old"], "S2 정책의 경고 임계(70)와 쉰 기간(20일)으로 돈다");
  assert.deepEqual([r?.pressure_pct, r?.target_pct, r?.idle_days, r?.applied], [70, 60, 20, true], "S2 목표는 경고 임계 − 10%p");
  assert.equal(lastDerivedEvict()?.evicted, 1, "S2 마지막 보고를 남긴다");
}
{ // S3
  resetDerivedEvict();
  const { d, spy } = deps(WTS, { usedPct: 99, slowMs: 80 });
  const [x, y] = await Promise.all([sweepDerivedEvict(pol({}), d), sweepDerivedEvict(pol({}), d)]);
  assert.equal([x, y].filter((r) => r !== null).length, 1, "S3 겹친 회차는 하나만 돈다");
  assert.deepEqual(spy.applied, ["old", "mid"], "S3 같은 것을 두 번 지우지 않는다");
  const again = await sweepDerivedEvict(pol({}), d);
  assert.ok(again, "S3 앞 회차가 끝나면 다시 돈다");
}
{ // P1
  assert.equal(DEFAULT_STORAGE_POLICY.derived_evict_enabled, true, "P1 기본 켬");
  assert.equal(DEFAULT_STORAGE_POLICY.derived_evict_idle_days, 3, "P1 기본 3일");
  assert.equal(normalizeStoragePolicy({ derived_evict_idle_days: 9999 }).derived_evict_idle_days, 365, "P1 상한 365");
  assert.equal(normalizeStoragePolicy({ derived_evict_idle_days: 0 }).derived_evict_idle_days, 0, "P1 0 은 기간을 보지 않음");
  assert.equal(normalizeStoragePolicy({ derived_evict_enabled: false }).derived_evict_enabled, false, "P1 끌 수 있다");
  assert.equal(normalizeStoragePolicy({}).derived_evict_enabled, true, "P1 안 정했으면 기본값");
  assert.deepEqual(derivedEvictPolicy(normalizeStoragePolicy({ disk_warn_pct: 5 })), { enabled: true, pressurePct: 5, targetPct: 1, idleDays: 3 }, "P1 목표는 1% 아래로 내려가지 않는다");
}
{ // C1 — 프로세스 현재 경로: 게이트웨이가 띄우지 않은 작업(노드 세션 · 손으로 돌린 빌드)도 «작업 중» 으로 잡는 재료.
  assert.deepEqual(parseLsofCwds("p123\nfcwd\nn/Users/u/workspace/project/1\np456\nfcwd\nn/\nnot-a-path\n"), ["/Users/u/workspace/project/1", "/"], "C1 n/ 줄만 경로다");
  const cwds = await processCwds();
  if (process.platform === "linux" || process.platform === "darwin") {
    const here = await fsp.realpath(process.cwd());
    const real = await Promise.all(cwds.map((d) => fsp.realpath(d).catch(() => d)));
    assert.ok(real.includes(here), "C1 이 시험 프로세스 자신의 현재 경로가 잡힌다");
  } else {
    assert.deepEqual(cwds, [], "C1 그 밖의 OS 에서는 빈 목록(세션 목록만으로 간다)");
  }
}
await fsp.rm(root, { recursive: true, force: true });
console.log("workspace-evict.test.ts ok — 넉넉하면 안 지움 · 고른 것만 · 세션 목록 실패면 그만둠 · 워크트리는 안 지움 · 정책 꺼짐이면 안 돎 · 회차 안 겹침");
