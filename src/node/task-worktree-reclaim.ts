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
// ⚠ 살아 있는 세션의 작업 폴더가 워크트리 안이면 걷지 않는다(심볼릭 링크를 푼 실제 경로로도 잰다 — macOS 의 /tmp 처럼
//  루트가 링크면 세션 cwd 와 task_dir 의 표기가 갈린다). 세션 목록을 못 읽으면 걷지 않는다.
// ⚠ 같은 작업 폴더(<ws>)를 쓰는 **끝나지 않은 다른 위탁**이 있으면 걷지 않는다. 세션 가드만으로는 배정 중인 위탁을 못 본다:
//  같은 subpath·repo 의 두 번째 위탁은 provisionTaskRepo 가 첫 위탁의 워크트리(브랜치도 첫 위탁 것)를 재사용하고, 그 뒤
//  tmux 판을 띄워 @box_dir 를 박기까지는 그 세션이 목록에 없거나 작업 폴더가 비어 있다(세션 목록은 @box_dir 로 폴더를 안다).
//  그 사이 첫 위탁이 끝나면 두 번째 위탁이 막 앉은 워크트리를 지운다 — 기본 중앙 슬롯이 1이라 «앞 위탁 종결 → 같은 tick 에
//  뒤 위탁 배정» 은 드문 일이 아니다. 그래서 org_task 를 본다. 배정 중인 위탁은 queued 이고 task_dir 이 아직 비어 있으므로
//  그런 행은 spawnTaskSession 이 작업 폴더를 정하는 규칙(subpath, 비면 delegated/task-<id>)으로 같은지 잰다.
//  재사용된 워크트리는 브랜치가 첫 위탁 id 라 두 번째 위탁이 끝나도 회수되지 않는다 — 새는 쪽이고, 안전하다.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { applyReclaim, baseRepoOf, checkWorktree, isInside, type ReclaimResult, type WorktreeCheck } from "../ops/workspace-reclaim.js";
import { OPEN_TASK_STATUSES, workspaceTaskRows } from "./task-store.js";

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
  /** 상태를 못 읽어서(세션 목록·위탁 상태·git) 건너뛰었다 — 정상 유지가 아니므로 호출부가 경고로 남긴다. 아니면 키가 없다. */
  undetermined?: true;
}

/** 같은 작업 폴더 판정 재료 — org_task 한 행(task-store.workspaceTaskRows). id 는 pg 가 BIGSERIAL 을 문자열로 준다. */
export interface WorkspaceTaskRow {
  id: number | string;
  status: string;
  subpath: string | null;
  task_dir: string | null;
}

export interface ReclaimDeps {
  exists(p: string): boolean;
  /** 이 호스트에 살아 있는 세션들의 작업 폴더. 못 읽으면 throw 해야 한다(빈 목록 = «없음» 으로 읽힌다). */
  activeSessionDirs(): Promise<string[]>;
  /** 심볼릭 링크를 푼 실제 경로. 못 풀면 throw — 호출부가 원래 경로로 비교한다. */
  realpath(p: string): Promise<string>;
  /** 이 위탁 행 + 끝나지 않은 위탁 행들. 못 읽으면 throw 해야 한다(빈 목록 = «다른 위탁 없음» 으로 읽힌다). */
  workspaceTasks(selfId: number): Promise<WorkspaceTaskRow[]>;
  checkWorktree(wt: string): Promise<WorktreeCheck>;
  baseRepoOf(wt: string): Promise<string | undefined>;
  applyReclaim: typeof applyReclaim;
}

/** 실제 파일시스템·git·tmux·DB 를 쓰는 기본 의존성. */
export const defaultReclaimDeps: ReclaimDeps = {
  exists: (p) => fs.existsSync(p),
  activeSessionDirs: async () => {
    const { listSessionsRaw } = await import("../terminal/terminal-sessions.js");
    return (await listSessionsRaw({ strict: true })).map((s) => s.dir).filter(Boolean) as string[];
  },
  realpath: (p) => fsp.realpath(p),
  workspaceTasks: (selfId) => workspaceTaskRows(selfId),
  checkWorktree, baseRepoOf, applyReclaim,
};

/** 위탁 브랜치 이름 — provisionTaskRepo 와 같은 규칙. */
export function delegateBranch(taskId: number): string {
  return `delegate/task-${taskId}`;
}

/**
 * task_dir(`<작업폴더>/.lively-task/<id>`, prepareTaskDir 가 만든다)에서 그 위탁의 작업 폴더(<ws>)를 얻는다.
 * 모양이 다르면(샌드박스 판·옛 행·손상·배정 전이라 비어 있음) null — 추측해서 엉뚱한 폴더를 가리키지 않는다.
 */
export function taskWorkspaceDir(taskDir: string | null | undefined, id: number | string): string | null {
  const dir = String(taskDir ?? "").trim();
  if (!dir) return null;
  const abs = path.resolve(dir);
  if (path.basename(abs) !== String(id) || path.basename(path.dirname(abs)) !== ".lively-task") return null;
  return path.dirname(path.dirname(abs));
}

/** task_dir 에서 그 위탁의 워크트리 경로(`<ws>/<repo>`)를 얻는다. 레포가 없거나 경로를 못 풀면 null. */
export function taskWorktreePath(t: TaskWorktreeRef): string | null {
  const repo = (t.repo ?? "").trim();
  if (!repo) return null;
  if (repo.includes("/") || repo.includes("\\") || repo === "." || repo === "..") return null;
  const ws = taskWorkspaceDir(t.task_dir, t.id);
  return ws ? path.join(ws, repo) : null;
}

/**
 * 위탁의 작업 폴더를 **루트 기준으로** 정규화한 것 — spawnTaskSession 이 작업 폴더를 정하는 규칙 그대로다
 *  (subpath 를 다듬어 비면 `delegated/task-<id>`, 앞의 구분자를 떼고 루트에 붙여 정규화 — resolveRootPath).
 *  task_dir 이 아직 없는 위탁(queued — 배정 중)과 같은 폴더를 쓰는지 잴 때 쓴다. 루트(공유 루트·격리 여부)는 같다고 본다 —
 *  다르면 실제로는 다른 폴더인데 같다고 보게 되고, 그건 회수를 거르는 쪽(새는 쪽)이라 안전하다.
 */
export function effectiveSubpath(subpath: string | null | undefined, id: number | string): string {
  const sub = String(subpath ?? "").trim() || `delegated/task-${id}`;
  return path.resolve("/", sub.replace(/^[/\\]+/, ""));
}

const OPEN = new Set<string>(OPEN_TASK_STATUSES);

/**
 * 이 위탁과 같은 작업 폴더(<ws>)를 쓸 수 있는 **끝나지 않은 다른 위탁**(첫 건) — 없으면 null.
 *  · 자기 자신(같은 id)은 세지 않는다. id 는 숫자·문자열이 섞여 오므로 문자열로 맞춰 잰다.
 *  · 상대의 task_dir 이 정규 모양이면 거기서 뽑은 <ws> 가 **같은지**로 잰다(접두 비교가 아니다).
 *  · task_dir 로 못 재는 행(queued — 배정 중이라 비어 있음 · 정규 모양이 아님)은 작업 폴더 규칙(effectiveSubpath)으로 잰다.
 *    내 행이 목록에 없어 내 규칙값을 모르면 그런 행은 같은 폴더로 본다 — 모르면 지우지 않는다.
 */
export function openTaskSharingWorkspace(self: TaskWorktreeRef, rows: WorkspaceTaskRow[]): WorkspaceTaskRow | null {
  const me = String(self.id);
  const ws = taskWorkspaceDir(self.task_dir, me);
  const mine = rows.find((r) => String(r.id) === me);
  const mySub = mine ? effectiveSubpath(mine.subpath, me) : null;
  for (const r of rows) {
    if (String(r.id) === me || !OPEN.has(r.status)) continue;
    const theirs = taskWorkspaceDir(r.task_dir, String(r.id));
    if (theirs !== null && ws !== null) {
      if (theirs === ws) return r;
      continue;
    }
    if (mySub === null || effectiveSubpath(r.subpath, String(r.id)) === mySub) return r;
  }
  return null;
}

const errText = (e: unknown): string => (e as Error)?.message ?? String(e);

/** 살아 있는 세션의 작업 폴더가 워크트리 안인가 — 적힌 그대로, 그리고 심볼릭 링크를 푼 실제 경로로(못 풀면 적힌 그대로). */
async function sessionInside(dirs: string[], wt: string, deps: ReclaimDeps): Promise<boolean> {
  if (dirs.some((d) => isInside(d, wt))) return true;
  const real = async (p: string): Promise<string> => {
    try { return await deps.realpath(p); } catch { return p; }
  };
  const realWt = await real(wt);
  return (await Promise.all(dirs.map(real))).some((d) => isInside(d, realWt));
}

/** 끝난 위탁의 워크트리를 조건이 맞으면 걷는다. 세션이 이미 끝났다는 전제로 부른다. 던지지 않는다. */
export async function reclaimTaskWorktree(t: TaskWorktreeRef, deps: ReclaimDeps = defaultReclaimDeps): Promise<TaskWorktreeReclaim> {
  const wt = taskWorktreePath(t);
  if (!wt) return { worktree: null, removed: false, reason: t.repo ? "작업 폴더 경로를 해석하지 못했습니다" : null };
  if (!deps.exists(wt)) return { worktree: wt, removed: false, reason: null };
  const keep = (reason: string | null, undetermined = false): TaskWorktreeReclaim =>
    ({ worktree: wt, removed: false, reason, ...(undetermined ? { undetermined: true as const } : {}) });
  let dirs: string[];
  try { dirs = await deps.activeSessionDirs(); }
  catch (e) { return keep(`세션 목록을 읽지 못해 회수하지 않습니다: ${errText(e)}`, true); }
  try {
    if (await sessionInside(dirs, wt, deps)) return keep("이 워크트리에서 작업 중인 세션이 있습니다");
    const check = await deps.checkWorktree(wt);
    if (check.branch !== delegateBranch(t.id)) return keep(`이 위탁이 만든 워크트리가 아닙니다(브랜치 ${check.branch ?? "없음"})`);
    if (!check.removable) return keep(check.reason);
    //  같은 작업 폴더를 쓰는 끝나지 않은 위탁(머리말) — **제거 바로 앞에서** 본다. 위의 git 점검은 큰 레포면 수 초라
    //   그 앞에서 보면 그동안 배정된 위탁을 놓친다. 그래도 이 조회와 아래 제거 사이의 창은 남는다(배정과 함께 쥐는 잠금이 없다).
    let rows: WorkspaceTaskRow[];
    try { rows = await deps.workspaceTasks(t.id); }
    catch (e) { return keep(`위탁 상태를 읽지 못해 회수하지 않습니다: ${errText(e)}`, true); }
    const other = openTaskSharingWorkspace(t, rows);
    if (other) return keep(`같은 작업 폴더를 쓰는 위탁 #${other.id}(${other.status})이 아직 끝나지 않았습니다`);
    //  ⓘ `git worktree remove`(--force 없이)는 추적 파일 수정·추적 안 된 새 파일이 있으면 거부하지만 **gitignore 된 것은
    //   워크트리째 지운다** — out/·dist/·node_modules/ 같은 산출물은 물론 .env 같은 무시된 로컬 파일도 함께 사라진다.
    //   checkWorktree 의 `git status --porcelain` 도 무시된 파일을 안 보므로 그걸로 막히지 않는다. workspace_reclaim(remove_worktree)
    //   와 같은 동작이다(kit 의 PROTECTED_NAMES 는 파생물 개별 삭제에만 걸린다). 위탁 결과는 워크트리 밖 .lively-task 에 남는다.
    const r: ReclaimResult = await deps.applyReclaim(
      { worktree: wt, entries: [], reclaimableBytes: 0, worktree_check: check, active_session: false },
      { removeWorktree: true, repoRoot: await deps.baseRepoOf(wt) },
    );
    return { worktree: wt, removed: r.worktreeRemoved, reason: r.worktreeSkippedReason };
  } catch (e) {
    return keep(`회수 중 오류: ${errText(e)}`, true);
  }
}
