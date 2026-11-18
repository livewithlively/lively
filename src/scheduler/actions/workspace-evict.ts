// 크론 액션: 워크스페이스 파생물 축출(workspace_evict, #5368) — 디스크가 찼을 때 쉬는 워크트리의 파생물(node_modules · dist · build …)을
//  오래 안 쓴 것부터 목표 사용률까지 지운다.
//
//  ── 무엇을 지우고 무엇을 안 지우나 ──
//  규칙은 스토리지 모델 결정(지식: workspace-storage-model-asset-vs-derived-cache) 그대로다.
//   · 지우는 것은 파생물뿐이다 — gitignored 이면서 알려진 파생물 이름(kit/cli/workspace-reclaim-core.mjs 의 planReclaim · applyReclaim).
//     다시 설치 · 빌드하면 돌아온다. .env · data/ · 미분류 무시 파일 · 소스 · 커밋은 대상이 아니다.
//   · **워크트리는 지우지 않는다**(removeWorktree 를 넘기지 않는다). 워크트리는 보존 자산이고, 지울지는 사람이나 그 프로젝트를
//     마무리하는 에이전트가 정한다.
//   · 디스크 사용률이 기준 아래면 아무것도 지우지 않는다 — 넉넉한데 지우면 다시 빌드하는 값만 든다.
//   · 살아 있는 세션이 쓰는 워크트리 · idle_days 안에 손댄 워크트리는 건너뛴다. 세션 목록을 못 읽으면 회차를 통째로 그만둔다
//     («없음» 으로 읽으면 빌드 중인 node_modules 를 지운다).
//
//  ── 범위 ──
//  이 게이트웨이 호스트의 프로젝트 폴더(TERMINAL_ROOT_SHARED 아래 project/ · legacy-project/)만 본다. 구성원 PC(노드)의 폴더는
//   게이트웨이가 못 본다 — 거기서는 같은 규칙을 `lively reclaim --evict` 가 돈다(같은 코어).
//  폴더는 호스트 단위라 워크스페이스(테넌트)로 가르지 않는다. 한 프로세스가 여러 워크스페이스를 섬기는 배치에서는 워크스페이스마다 이 잡이
//   같은 폴더를 보게 되는데, 앞 회차가 지운 뒤에는 고를 것이 없어 뒤 회차는 아무 일도 하지 않는다.
import fsp from "node:fs/promises";
import path from "node:path";
import { PROJECT_SHARED_BASE, PROJECT_SUBDIR, LEGACY_SUBDIR } from "../../project/project-fs.js";
import { applyReclaim, planEviction, planReclaim, reposIn, worktreeLastUsed, EVICT_DEFAULTS, type EvictCandidate, type ReclaimPlan } from "../../ops/workspace-reclaim.js";
import { logger } from "../../log.js";

export { EVICT_DEFAULTS };

/** 요약에 싣는 워크트리 경로 수 상한 — 잡 요약은 웹 «작업» 탭이 그대로 그린다. */
const SUMMARY_PATHS = 20;

export interface EvictDeps {
  roots(): string[];
  /** 이 호스트에 살아 있는 세션들의 작업 폴더. 못 읽으면 throw 해야 한다(빈 목록 = «없음» 으로 읽힌다). */
  activeSessionDirs(): Promise<string[]>;
  /** 루트가 있는 볼륨의 사용률. 못 재면 null(축출이 아무것도 고르지 않는다). */
  disk(dir: string): Promise<{ usedPct: number; totalBytes: number } | null>;
  worktrees(root: string): Promise<string[]>;
  plan(wt: string, activeSessionDirs: string[]): Promise<ReclaimPlan>;
  lastUsed(wt: string): Promise<number | null>;
  apply(plan: ReclaimPlan): Promise<{ freedBytes: number }>;
}

export const defaultEvictDeps: EvictDeps = {
  roots: () => [path.join(PROJECT_SHARED_BASE, PROJECT_SUBDIR), path.join(PROJECT_SHARED_BASE, LEGACY_SUBDIR)],
  activeSessionDirs: async () => {
    const { listSessionsRaw } = await import("../../terminal/terminal-sessions.js");
    return (await listSessionsRaw({ strict: true })).map((s) => s.dir).filter(Boolean) as string[];
  },
  disk: async (dir) => {
    try {
      const f = await fsp.statfs(dir);
      const total = Number(f.blocks) * Number(f.bsize);
      if (!(total > 0)) return null;
      return { usedPct: (1 - Number(f.bavail) / Number(f.blocks)) * 100, totalBytes: total };
    } catch { return null; }
  },
  worktrees: async (root) => {
    const out: string[] = [];
    for (const name of await fsp.readdir(root).catch(() => [] as string[])) {
      const dir = path.join(root, name);
      if (!await fsp.stat(dir).then((s) => s.isDirectory()).catch(() => false)) continue;
      out.push(...await reposIn(dir));
    }
    return out;
  },
  plan: (wt, activeSessionDirs) => planReclaim(wt, { activeSessionDirs }),
  lastUsed: (wt) => worktreeLastUsed(wt),
  // removeWorktree 를 넘기지 않는다 — 이 액션은 파생물만 지운다(머리말).
  apply: (plan) => applyReclaim(plan, {}),
};

export async function runWorkspaceEvict(
  params: Record<string, unknown>, _job?: unknown, deps: EvictDeps = defaultEvictDeps,
): Promise<{ status: string; summary: unknown }> {
  const on = String(params.mode ?? "").trim() === "on"; // on 이 아니면 report(쓰기 0)
  const roots: string[] = [];
  for (const r of deps.roots()) if (await fsp.stat(r).then((s) => s.isDirectory()).catch(() => false)) roots.push(r);
  if (!roots.length) return { status: "ok", summary: { mode: on ? "on" : "report", worktrees: 0, note: "프로젝트 폴더가 없습니다" } };

  let activeSessionDirs: string[];
  try { activeSessionDirs = await deps.activeSessionDirs(); }
  catch (err) {
    logger.warn({ err }, "workspace_evict: 세션 목록을 읽지 못해 이번 회차를 건너뜁니다");
    return { status: "error", summary: { error: "세션 목록을 확인할 수 없어 건너뜁니다(작업 중인 워크트리를 지울 위험)" } };
  }

  const disk = await deps.disk(roots[0]!);
  const candidates: EvictCandidate[] = [];
  const plans = new Map<string, ReclaimPlan>();
  for (const root of roots) {
    for (const wt of await deps.worktrees(root)) {
      const plan = await deps.plan(wt, activeSessionDirs);
      plans.set(wt, plan);
      candidates.push({ worktree: wt, reclaimableBytes: plan.reclaimableBytes, lastUsedMs: await deps.lastUsed(wt), active: plan.active_session });
    }
  }
  const ev = planEviction({
    candidates, disk,
    policy: { pressurePct: params.pressure_pct as number | undefined, targetPct: params.target_pct as number | undefined, idleDays: params.idle_days as number | undefined },
  });

  let freed = 0;
  let evicted = 0;
  if (on) {
    for (const c of ev.picks) {
      const plan = plans.get(c.worktree);
      if (!plan) continue;
      try { const r = await deps.apply(plan); freed += r.freedBytes; if (r.freedBytes > 0) evicted++; }
      catch (err) { logger.warn({ err, wt: c.worktree }, "workspace_evict: 파생물 축출 실패 — 건너뜀"); }
    }
    if (evicted) logger.info({ evicted, freedBytes: freed, usedPct: disk?.usedPct }, "workspace_evict: 디스크 압박 — 쉬는 워크트리의 파생물을 축출했다");
  }
  return {
    status: "ok",
    summary: {
      mode: on ? "on" : "report",
      disk_used_pct: disk ? Math.round(disk.usedPct * 10) / 10 : null,
      pressure_pct: ev.pressurePct, target_pct: ev.targetPct, idle_days: ev.idleDays,
      worktrees: candidates.length,
      picked: ev.picks.length, picked_bytes: ev.pickedBytes,
      evicted, freed_bytes: freed,
      skipped: ev.skipped,
      reason: ev.reason,
      paths: ev.picks.slice(0, SUMMARY_PATHS).map((c) => c.worktree),
    },
  };
}
