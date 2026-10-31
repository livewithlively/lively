// 위탁 워크트리 회수 — `provisionTaskRepo` 가 레포를 지정한 위탁마다 `<작업폴더>/<repo>` 에 워크트리를 만들고,
//  종전엔 위탁이 끝나도 아무도 걷지 않았다. 세션은 끝날 때 정리되는데(#1675) 워크트리만 남아, 큰 레포를 쓰는
//  정기 위탁이 돌 때마다 디스크가 레포 크기만큼 늘었다(실측: 위탁 폴더가 두 달 반 사이 27GB, 레포 1개가 2.3GB/건).
//
// 지우는 조건은 `workspace_reclaim(remove_worktree)` 와 **같은 판정**을 쓴다 — 미커밋 변경도, 원격 어디에도 없는
//  커밋도 없을 때만(`checkWorktree`). 그 조건이면 provision 한 번으로 그대로 복구되므로 위탁의 끝이 곧 회수 경계다.
//  판정·제거 구현은 kit 코어 한 벌을 그대로 부른다(두 벌로 갈라지면 한쪽이 조용히 위험해진다 — workspace-reclaim.ts 머리말).
//
// ⚠ 워크트리의 브랜치가 `delegate/task-<id>` 일 때만 걷는다. 위탁의 subpath 는 사용자가 정하므로 프로젝트 폴더를
//  가리킬 수 있고, 그 자리에 이미 워크트리가 있으면 provisionTaskRepo 는 **그 프로젝트의 워크트리를 재사용**한다.
//  그건 이 위탁이 만든 것이 아니라 다른 세션의 작업면이다 — 깨끗해도 남의 것을 걷지 않는다.
// ⚠ 살아 있는 세션의 작업 폴더가 워크트리 안이면 걷지 않는다. 같은 subpath·repo 로 겹친 두 번째 위탁은 첫 위탁의
//  워크트리(브랜치도 첫 위탁 것)를 재사용하므로 브랜치 대조만으로는 못 막는다. 세션 목록을 못 읽으면 걷지 않는다.
import fs from "node:fs";
import path from "node:path";
import { applyReclaim, baseRepoOf, checkWorktree, isInside, type ReclaimResult, type WorktreeCheck } from "../ops/workspace-reclaim.js";

export interface TaskWorktreeRef {
  id: number;
  repo?: string | null;
  task_dir?: string | null;
}

export interface TaskWorktreeReclaim {
  /** 회수를 시도할 워크트리 경로(레포 미지정·경로 해석 불가면 null). */
  worktree: string | null;
  removed: boolean;
  /** 걷지 않은 이유(사람이 읽는 문장). 워크트리가 이미 없으면 null. */
  reason: string | null;
}

export interface ReclaimDeps {
  exists(p: string): boolean;
  /** 이 호스트에 살아 있는 세션들의 작업 폴더. 못 읽으면 throw 해야 한다(빈 목록 = «없음» 으로 읽힌다). */
  activeSessionDirs(): Promise<string[]>;
  checkWorktree(wt: string): Promise<WorktreeCheck>;
  baseRepoOf(wt: string): Promise<string | undefined>;
  applyReclaim: typeof applyReclaim;
}

/** 실제 파일시스템·git·tmux 를 쓰는 기본 의존성. */
export const defaultReclaimDeps: ReclaimDeps = {
  exists: (p) => fs.existsSync(p),
  activeSessionDirs: async () => {
    const { listSessionsRaw } = await import("../terminal/terminal-sessions.js");
    return (await listSessionsRaw({ strict: true })).map((s) => s.dir).filter(Boolean) as string[];
  },
  checkWorktree, baseRepoOf, applyReclaim,
};

/** 위탁 브랜치 이름 — provisionTaskRepo 와 같은 규칙. */
export function delegateBranch(taskId: number): string {
  return `delegate/task-${taskId}`;
}

/**
 * task_dir(`<작업폴더>/.lively-task/<id>`, prepareTaskDir 가 만든다)에서 그 위탁의 워크트리 경로를 얻는다.
 * 모양이 다르면(샌드박스 판·옛 행·손상) null — 추측해서 엉뚱한 폴더를 가리키지 않는다.
 */
export function taskWorktreePath(t: TaskWorktreeRef): string | null {
  const repo = (t.repo ?? "").trim();
  const dir = (t.task_dir ?? "").trim();
  if (!repo || !dir) return null;
  if (repo.includes("/") || repo.includes("\\") || repo === "." || repo === "..") return null;
  const taskDir = path.resolve(dir);
  if (path.basename(taskDir) !== String(t.id) || path.basename(path.dirname(taskDir)) !== ".lively-task") return null;
  return path.join(path.dirname(path.dirname(taskDir)), repo);
}

/** 끝난 위탁의 워크트리를 조건이 맞으면 걷는다. 세션이 이미 끝났다는 전제로 부른다. 던지지 않는다. */
export async function reclaimTaskWorktree(t: TaskWorktreeRef, deps: ReclaimDeps = defaultReclaimDeps): Promise<TaskWorktreeReclaim> {
  const wt = taskWorktreePath(t);
  if (!wt) return { worktree: null, removed: false, reason: t.repo ? "작업 폴더 경로를 해석하지 못했습니다" : null };
  if (!deps.exists(wt)) return { worktree: wt, removed: false, reason: null };
  try {
    if ((await deps.activeSessionDirs()).some((d) => isInside(d, wt))) {
      return { worktree: wt, removed: false, reason: "이 워크트리에서 작업 중인 세션이 있습니다" };
    }
    const check = await deps.checkWorktree(wt);
    if (check.branch !== delegateBranch(t.id)) {
      return { worktree: wt, removed: false, reason: `이 위탁이 만든 워크트리가 아닙니다(브랜치 ${check.branch ?? "없음"})` };
    }
    if (!check.removable) return { worktree: wt, removed: false, reason: check.reason };
    const r: ReclaimResult = await deps.applyReclaim(
      { worktree: wt, entries: [], reclaimableBytes: 0, worktree_check: check, active_session: false },
      { removeWorktree: true, repoRoot: await deps.baseRepoOf(wt) },
    );
    return { worktree: wt, removed: r.worktreeRemoved, reason: r.worktreeSkippedReason };
  } catch (e) {
    return { worktree: wt, removed: false, reason: `회수 중 오류: ${(e as Error)?.message ?? String(e)}` };
  }
}
