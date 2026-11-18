// 워크스페이스 파생물 자동 정리(#5368) — 디스크가 찼을 때 쉬는 워크트리의 파생물(node_modules · dist · build …)을 오래 안 쓴 것부터
//  목표 사용률까지 지운다. 관리탭 [저장소] 의 정책(storage_policy.derived_evict_*)으로 켜고 끄고, 서버 안 타이머가 돈다
//  (boot/housekeeping.ts — 로그 회전 · 유휴 세션 회수와 같은 자리).
//
//  ── 왜 스케줄(org_cron) 잡이 아닌가 ──
//  디스크는 박스의 자원이고 org_cron 은 워크스페이스마다 돈다 — 잡으로 두면 같은 폴더를 워크스페이스 수만큼 본다. 켬/끔이 스케줄
//   탭에, 임계가 저장소 탭에 갈려 한 기능의 설정이 두 화면에 놓인다. 박스 단위 정비는 저장소 정책 + 타이머가 이 코드베이스의 자리다.
//
//  ── 무엇을 지우고 무엇을 안 지우나 ──
//  규칙은 스토리지 모델 결정(지식: workspace-storage-model-asset-vs-derived-cache) 그대로다.
//   · 지우는 것은 파생물뿐이다 — gitignored 이면서 알려진 파생물 이름(kit/cli/workspace-reclaim-core.mjs 의 planReclaim · applyReclaim).
//     다시 설치 · 빌드하면 돌아온다. .env · data/ · 미분류 무시 파일 · 소스 · 커밋은 대상이 아니다.
//   · **워크트리는 지우지 않는다**(removeWorktree 를 넘기지 않는다). 워크트리는 보존 자산이고, 지울지는 사람이 저장소 탭에서 정한다.
//   · 디스크 사용률이 경고 임계 아래면 아무것도 지우지 않는다 — 넉넉한데 지우면 다시 빌드하는 값만 든다.
//   · 살아 있는 세션이 쓰는 워크트리 · 쉰 기간 안에 손댄 워크트리는 건너뛴다. 세션 목록을 못 읽으면 회차를 통째로 그만둔다
//     («없음» 으로 읽으면 빌드 중인 node_modules 를 지운다).
//
//  ── 범위 ──
//  이 게이트웨이 호스트의 프로젝트 폴더(TERMINAL_ROOT_SHARED 아래 project/ · legacy-project/)만 본다. 구성원 PC(노드)의 폴더는
//   게이트웨이가 못 본다 — 거기서는 같은 규칙을 `lively reclaim --evict` 가 돈다(같은 코어).
import fsp from "node:fs/promises";
import path from "node:path";
import { PROJECT_SHARED_BASE, PROJECT_SUBDIR, LEGACY_SUBDIR } from "../project/project-fs.js";
import { applyReclaim, planEviction, planReclaim, reposIn, worktreeLastUsed, type EvictCandidate, type ReclaimPlan } from "./workspace-reclaim.js";
import { derivedEvictPolicy, type StoragePolicy } from "../org/policies/storage-policy.js";
import { logger } from "../log.js";

/** 보고에 싣는 워크트리 경로 수 상한 — 저장소 탭이 그대로 그린다. */
const REPORT_PATHS = 20;

export interface EvictDeps {
  roots(): string[];
  /** 이 호스트에 살아 있는 세션들의 작업 폴더. 못 읽으면 throw 해야 한다(빈 목록 = «없음» 으로 읽힌다). */
  activeSessionDirs(): Promise<string[]>;
  /** 루트가 있는 볼륨의 사용률. 못 재면 null(아무것도 고르지 않는다). */
  disk(dir: string): Promise<{ usedPct: number; totalBytes: number } | null>;
  worktrees(root: string): Promise<string[]>;
  plan(wt: string, activeSessionDirs: string[]): Promise<ReclaimPlan>;
  lastUsed(wt: string): Promise<number | null>;
  apply(plan: ReclaimPlan): Promise<{ freedBytes: number }>;
}

export const defaultEvictDeps: EvictDeps = {
  roots: () => [path.join(PROJECT_SHARED_BASE, PROJECT_SUBDIR), path.join(PROJECT_SHARED_BASE, LEGACY_SUBDIR)],
  activeSessionDirs: async () => {
    const { listSessionsRaw } = await import("../terminal/terminal-sessions.js");
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
  // removeWorktree 를 넘기지 않는다 — 자동 정리는 파생물만 지운다(머리말).
  apply: (plan) => applyReclaim(plan, {}),
};

export interface EvictOptions { apply: boolean; pressurePct: number; targetPct: number; idleDays: number }

export interface EvictReport {
  at: number;
  ok: boolean;
  /** ok=false 일 때 왜 그만뒀나. */
  error?: string;
  applied: boolean;
  disk_used_pct: number | null;
  pressure_pct: number;
  target_pct: number;
  idle_days: number;
  worktrees: number;
  picked: number;
  picked_bytes: number;
  evicted: number;
  freed_bytes: number;
  skipped: { active: number; fresh: number; unknown_age: number; empty: number };
  /** 아무것도 고르지 않았을 때의 사유(디스크가 넉넉함 · 못 쟀음). */
  reason: string | null;
  paths: string[];
}

/** 한 회차. apply=false 면 무엇을 지울지만 센다(쓰기 0). */
export async function runWorkspaceEvict(o: EvictOptions, deps: EvictDeps = defaultEvictDeps): Promise<EvictReport> {
  const base = {
    at: Date.now(), applied: o.apply, disk_used_pct: null, pressure_pct: o.pressurePct, target_pct: o.targetPct, idle_days: o.idleDays,
    worktrees: 0, picked: 0, picked_bytes: 0, evicted: 0, freed_bytes: 0,
    skipped: { active: 0, fresh: 0, unknown_age: 0, empty: 0 }, reason: null, paths: [],
  };
  const roots: string[] = [];
  for (const r of deps.roots()) if (await fsp.stat(r).then((s) => s.isDirectory()).catch(() => false)) roots.push(r);
  if (!roots.length) return { ...base, ok: true, reason: "프로젝트 폴더가 없습니다" };

  // 디스크를 먼저 잰다 — 넉넉하면 세션 목록도 워크트리도 훑지 않는다(대부분의 회차가 여기서 끝난다).
  const disk = await deps.disk(roots[0]!);
  const diskPct = disk ? Math.round(disk.usedPct * 10) / 10 : null;
  const early = planEviction({ candidates: [], disk, policy: { pressurePct: o.pressurePct, targetPct: o.targetPct, idleDays: o.idleDays } });
  if (!early.pressure) return { ...base, ok: true, disk_used_pct: diskPct, reason: early.reason };

  let activeSessionDirs: string[];
  try { activeSessionDirs = await deps.activeSessionDirs(); }
  catch (err) {
    logger.warn({ err }, "파생물 자동 정리: 세션 목록을 읽지 못해 이번 회차를 건너뜁니다");
    return { ...base, ok: false, disk_used_pct: diskPct, error: "세션 목록을 확인할 수 없어 건너뜁니다(작업 중인 워크트리를 지울 위험)" };
  }

  const candidates: EvictCandidate[] = [];
  const plans = new Map<string, ReclaimPlan>();
  for (const root of roots) {
    for (const wt of await deps.worktrees(root)) {
      const plan = await deps.plan(wt, activeSessionDirs);
      plans.set(wt, plan);
      candidates.push({ worktree: wt, reclaimableBytes: plan.reclaimableBytes, lastUsedMs: await deps.lastUsed(wt), active: plan.active_session });
    }
  }
  const ev = planEviction({ candidates, disk, policy: { pressurePct: o.pressurePct, targetPct: o.targetPct, idleDays: o.idleDays } });

  let freed = 0;
  let evicted = 0;
  if (o.apply) {
    for (const c of ev.picks) {
      const plan = plans.get(c.worktree);
      if (!plan) continue;
      try { const r = await deps.apply(plan); freed += r.freedBytes; if (r.freedBytes > 0) evicted++; }
      catch (err) { logger.warn({ err, wt: c.worktree }, "파생물 자동 정리: 축출 실패 — 건너뜀"); }
    }
    if (evicted) logger.info({ evicted, freedBytes: freed, usedPct: disk?.usedPct }, "파생물 자동 정리: 디스크가 차서 쉬는 워크트리의 파생물을 지웠다");
  }
  return {
    ...base, ok: true, disk_used_pct: diskPct,
    worktrees: candidates.length, picked: ev.picks.length, picked_bytes: ev.pickedBytes, evicted, freed_bytes: freed,
    skipped: ev.skipped, reason: ev.reason, paths: ev.picks.slice(0, REPORT_PATHS).map((c) => c.worktree),
  };
}

// ── 타이머 쪽 ──
/** 마지막 회차의 보고 — 저장소 탭이 «마지막으로 언제 무엇을 지웠나» 를 보여 준다. 인메모리(재기동하면 비고, 다음 회차가 채운다). */
let last: EvictReport | null = null;
let running = false;
export function lastDerivedEvict(): EvictReport | null { return last; }
/** 테스트용. */
export function resetDerivedEvict(): void { last = null; running = false; }

/** 정책을 읽어 한 회차를 돈다. 꺼져 있으면 아무것도 하지 않는다. 앞 회차가 아직 돌고 있으면 겹치지 않는다(큰 박스에서 du 가 오래 걸린다). */
export async function sweepDerivedEvict(loadPolicy: () => Promise<StoragePolicy>, deps: EvictDeps = defaultEvictDeps): Promise<EvictReport | null> {
  if (running) return null;
  running = true;
  try {
    const p = derivedEvictPolicy(await loadPolicy());
    if (!p.enabled) return null;
    last = await runWorkspaceEvict({ apply: true, pressurePct: p.pressurePct, targetPct: p.targetPct, idleDays: p.idleDays }, deps);
    return last;
  } finally { running = false; }
}
