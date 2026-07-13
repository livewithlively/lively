// 워크스페이스 회수(#813 T3-2) — 프로젝트 워크트리에서 **재생성 가능한 것만** 되돌린다.
//
// 설계 원칙 (haru 결정 2026-07-13): **무인 자동 삭제 프로세스를 만들지 않는다.**
//  되돌릴 수 없는 삭제를 데몬에게 맡기지 않고, **맥락을 아는 주체(프로젝트를 마무리하는 에이전트/사람)가 생애주기
//  경계에서** 회수한다. 이 모듈은 그 주체가 호출하는 **도구**다 — 판단은 호출자가, **삭제 규칙은 코드가 강제**한다
//  (LLM 이 rm -rf 를 즉흥적으로 치는 것보다 훨씬 안전하다).
//  → close-out 루틴(지식 project-closeout-routine)의 한 스텝 + 관리탭 수동 버튼이 호출자다.
//
// 무엇을 지우나 — **두 조건을 모두** 만족해야 한다:
//  ① git 이 ignored 라고 말한 것(`git clean -Xdn` — 즉 "커밋 안 하는 것" = 재생성 가능 후보)
//  ② 우리가 아는 파생물 이름(allow-list)일 것
//  둘 다 필요하다. ①만으로는 위험하다 — gitignored 라고 삭제해도 되는 게 아니다(`.env` 시크릿, `data/` 로컬 데이터가
//  전부 gitignored 다. dev 박스 dry-run 에서 실제로 `Would remove data/` 가 나왔다). ②만으로도 위험하다 — 이름이
//  `build` 여도 그게 소스면 gitignore 에 없다(그러면 ①에서 걸러진다).
//  allow-list 에 없는 gitignored 항목은 **지우지 않고 '미분류'로 보고**한다 — 관리자가 보고 판단한다.
//
// 워크트리 자체(#675 세션 워크트리와 달리 프로젝트 워크트리는 영속)는 **푸시 완료 + 더티 없음**일 때만 제거한다.
//  그 조건이면 `git worktree add` 로 언제든 복구된다 = 진짜 '복구 가능한 것'. 하나라도 어긋나면 **거부하고 이유를 말한다.**
//  (지식: workspace-storage-model-asset-vs-derived-cache)
import path from "node:path";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "./log.js";
import { dirSize } from "./session-cache.js";

const execFileAsync = promisify(execFile);

// 알려진 파생물 — 이 이름이면서 **gitignored 일 때만** 회수한다(둘 다 필요).
//  이름만으로는 절대 지우지 않으므로, 여기 있는 이름이 소스 디렉터리인 레포라도 안전하다(그러면 gitignored 가 아니다).
export const DERIVED_NAMES: readonly string[] = [
  "node_modules", ".pnpm-store", ".yarn",                       // node
  "build", "target", "dist", "out",                             // 범용 빌드 산출물
  ".gradle", ".cxx",                                            // gradle/android
  "Pods", "DerivedData", ".build",                              // ios/swift
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".tox", ".ruff_cache", // python
  ".next", ".nuxt", ".svelte-kit", ".astro", ".turbo", ".parcel-cache", ".vite", // 웹 프레임워크
  "obj",                                                        // dotnet
  ".terraform",                                                 // iac
  "coverage", ".nyc_output",                                    // 커버리지
];

// 절대 안 지운다 — gitignored 이고 위 allow-list 에 걸리더라도 여기 걸리면 제외(마지막 안전망).
//  gitignore 는 "커밋하지 마라"이지 "지워도 좋다"가 아니다: 시크릿·로컬 데이터·개인 설정이 전부 여기 산다.
export const PROTECTED_NAMES: readonly string[] = [
  ".env", ".git", "data", "secrets", "credentials",
  ".claude", ".codex", ".lively", ".vscode", ".idea", ".ssh",
];

export type EntryKind = "derived" | "unclassified" | "protected";

export interface ReclaimEntry {
  /** 워크트리 기준 상대 경로(모노레포면 `packages/a/node_modules` 처럼 중첩). */
  rel: string;
  kind: EntryKind;
  bytes: number;
  partial: boolean; // 크기 측정이 시간 예산에 걸렸는지
}

export interface WorktreeCheck {
  removable: boolean;
  /** removable=false 인 이유(사람이 읽는 문장). */
  reason: string | null;
  dirty: boolean;
  unpushed: number; // 원격에 없는 커밋 수 (-1 = upstream 없음 = 전부 미푸시로 간주)
  branch: string | null;
}

export interface ReclaimPlan {
  worktree: string;
  entries: ReclaimEntry[];
  /** 실제로 지울 것들의 합계(kind=derived 만). */
  reclaimableBytes: number;
  worktree_check: WorktreeCheck;
  /** 이 워크트리에 살아있는 세션이 붙어 있다 → 아무것도 회수하지 않는다(빌드 중일 수 있다). */
  active_session: boolean;
}

/** 세션의 작업 디렉터리가 이 워크트리 안(또는 자신)인가. 경로 접두사 비교의 흔한 함정(`/a/b` vs `/a/bc`)을 피한다. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function classify(rel: string): EntryKind {
  const parts = rel.split("/").filter(Boolean);
  // 경로의 **어느 구간이라도** 보호목록이면 제외 — `some/.env`·`x/data/y` 도 지키기 위해.
  if (parts.some((p) => PROTECTED_NAMES.includes(p) || p.startsWith(".env"))) return "protected";
  const base = parts[parts.length - 1] ?? "";
  return DERIVED_NAMES.includes(base) ? "derived" : "unclassified";
}

async function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, out: stdout };
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
}

/** 워크트리의 **베이스 레포**(공유 부모 클론) 경로. `git worktree remove` 는 워크트리 자신이 아니라 부모에서 돌려야 한다.
 *  `--git-common-dir` 이 부모의 `.git` 을 가리키므로 그 상위가 베이스 레포 루트. 못 찾으면 null(제거 안 함). */
export async function baseRepoOf(wt: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], wt);
  if (!r.ok) return undefined;
  const common = r.out.trim();
  if (!common) return undefined;
  return path.dirname(common); // <base>/.git → <base>
}

/** 워크트리 제거가 안전한가 — **푸시 완료 + 더티 없음**일 때만. 하나라도 어긋나면 이유를 말하고 거부한다. */
export async function checkWorktree(wt: string): Promise<WorktreeCheck> {
  const st = await git(["status", "--porcelain"], wt);
  if (!st.ok) return { removable: false, reason: "git 상태를 읽지 못했습니다(레포가 아니거나 손상)", dirty: false, unpushed: 0, branch: null };
  const dirty = st.out.trim().length > 0;

  const br = await git(["branch", "--show-current"], wt);
  const branch = br.ok ? br.out.trim() || null : null;

  // upstream 이 없으면 '전부 미푸시'로 본다 — 원격에 없는 브랜치의 워크트리를 지우면 커밋이 사라진다.
  let unpushed = -1;
  const up = await git(["rev-list", "--count", "@{upstream}..HEAD"], wt);
  if (up.ok) unpushed = Number(up.out.trim()) || 0;

  if (dirty) return { removable: false, reason: "커밋하지 않은 변경이 있습니다 — 잃어버릴 수 있어 제거하지 않습니다", dirty, unpushed, branch };
  if (unpushed < 0) return { removable: false, reason: "원격에 올라간 브랜치가 아닙니다(upstream 없음) — 커밋이 이 워크트리에만 있습니다", dirty, unpushed, branch };
  if (unpushed > 0) return { removable: false, reason: `아직 push 하지 않은 커밋이 ${unpushed}개 있습니다`, dirty, unpushed, branch };
  return { removable: true, reason: null, dirty, unpushed, branch };
}

/** 회수 계획 — **아무것도 지우지 않는다.** 무엇을 지울지/못 지울지와 그 이유만 돌려준다.
 *  activeSessionDirs: 지금 살아있는 세션들의 작업 디렉터리(호출자가 tmux 에서 수집). 이 워크트리 안에 있으면
 *  회수를 통째로 막는다 — 빌드 중인 워크트리의 node_modules 를 지우면 그 세션이 깨진다. */
export async function planReclaim(
  wt: string,
  opts: { sizeBudgetMs?: number; activeSessionDirs?: string[] } = {},
): Promise<ReclaimPlan> {
  const sizeBudgetMs = opts.sizeBudgetMs ?? 4000;
  const active = (opts.activeSessionDirs ?? []).some((d) => isInside(d, wt));
  const entries: ReclaimEntry[] = [];
  // git 에게 '삭제'를 시키지 않는다 — **후보 나열만**(-n) 시키고, 무엇을 지울지는 우리가 필터링해서 정한다.
  const clean = await git(["clean", "-Xdn"], wt);
  if (clean.ok) {
    const deadline = Date.now() + sizeBudgetMs;
    for (const line of clean.out.split("\n")) {
      const m = /^Would remove (.+?)\/?$/.exec(line.trim());
      if (!m || !m[1]) continue;
      const rel = m[1];
      const kind = classify(rel);
      const budget = Math.max(0, Math.min(1500, deadline - Date.now()));
      const { bytes, partial } = await dirSize(path.join(wt, rel), budget);
      entries.push({ rel, kind, bytes, partial });
    }
  } else {
    logger.warn({ wt, err: clean.out }, "회수 후보 조회 실패(git clean -Xdn)");
  }
  entries.sort((a, b) => b.bytes - a.bytes);
  const reclaimableBytes = entries.filter((e) => e.kind === "derived").reduce((s, e) => s + e.bytes, 0);
  const check = await checkWorktree(wt);
  // 활성 세션이 붙어 있으면 워크트리 제거도 당연히 불가 — 이유를 그 문장으로 덮어쓴다(사용자가 바로 이해하게).
  const worktree_check: WorktreeCheck = active
    ? { ...check, removable: false, reason: "이 워크트리에서 작업 중인 세션이 있습니다" }
    : check;
  return { worktree: wt, entries, reclaimableBytes, worktree_check, active_session: active };
}

export interface ReclaimResult {
  removed: string[];
  freedBytes: number;
  worktreeRemoved: boolean;
  /** 워크트리를 못 지웠으면 그 이유(사용자에게 그대로 보여준다). */
  worktreeSkippedReason: string | null;
}

/**
 * 계획 실행. **derived 로 분류된 것만** 지운다 — unclassified·protected 는 손대지 않는다.
 * removeWorktree=true 여도 checkWorktree 가 거부하면 **워크트리는 남긴다**(호출자가 우겨도 코드가 막는다).
 */
export async function applyReclaim(
  plan: ReclaimPlan,
  opts: { removeWorktree?: boolean; repoRoot?: string } = {},
): Promise<ReclaimResult> {
  // ⚠ 활성 세션이 붙어 있으면 **아무것도** 하지 않는다. 빌드 중인 워크트리의 node_modules 를 지우면 그 세션이 깨진다.
  //  호출자가 실수로 강행해도 여기서 막힌다(안전은 호출자가 아니라 코드가 보장한다).
  if (plan.active_session) {
    return { removed: [], freedBytes: 0, worktreeRemoved: false, worktreeSkippedReason: "이 워크트리에서 작업 중인 세션이 있습니다" };
  }
  const removed: string[] = [];
  let freedBytes = 0;
  for (const e of plan.entries) {
    if (e.kind !== "derived") continue; // ← 여기가 안전선. 미분류·보호는 절대 안 지운다.
    const target = path.join(plan.worktree, e.rel);
    try {
      await fsp.rm(target, { recursive: true, force: true });
      removed.push(e.rel);
      freedBytes += e.bytes;
    } catch (err) {
      logger.warn({ err, target }, "파생물 회수 실패 — 건너뜀");
    }
  }
  logger.info({ wt: plan.worktree, removed: removed.length, freedBytes }, "워크스페이스 파생물 회수");

  let worktreeRemoved = false;
  let worktreeSkippedReason: string | null = null;
  if (opts.removeWorktree) {
    // ⚠ 계획 수립 이후 상태가 바뀌었을 수 있다(그 사이 누가 작업했을 수도) → **실행 직전에 다시 확인**한다.
    const recheck = await checkWorktree(plan.worktree);
    if (!recheck.removable) {
      worktreeSkippedReason = recheck.reason;
    } else if (!opts.repoRoot) {
      worktreeSkippedReason = "베이스 레포 경로를 몰라 워크트리를 제거하지 못했습니다";
    } else {
      const r = await git(["worktree", "remove", plan.worktree], opts.repoRoot);
      if (r.ok) {
        worktreeRemoved = true;
        logger.info({ wt: plan.worktree }, "워크트리 회수(푸시 완료·클린 확인)");
      } else {
        worktreeSkippedReason = `git worktree remove 실패: ${r.out}`;
      }
    }
  }
  return { removed, freedBytes, worktreeRemoved, worktreeSkippedReason };
}
