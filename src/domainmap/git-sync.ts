// git 동기화 헬퍼 단일 출처(#1313 R23) — webhook.ts(push 트리거)와 git-pull.ts(스케줄러 폴링)가
//  reposDir·sanitizeName·git·ensureClone·parseDiff 5종을 **통째로 중복 보유**하던 것을 여기로 통합했다.
//  두 트리거는 같은 클론 캐시·같은 자격주입·같은 diff 포맷을 쓰는데 사본이 갈라지면 한쪽만 고쳐지는
//  산탄총 수술이 된다(실제로 sanitizeName 은 null 처리가, ensureClone 은 에러 번역이 이미 드리프트했다).
//
// 호출부에 남기는 것(의도적):
//  - **타임아웃**은 파라미터(GitOpts.timeoutMs) — webhook 60s(웹훅 응답 예산) / git-pull 180s(대형 레포 초회 clone,
//    provision 과 동일). 상수는 각 호출부에 그대로 둔다.
//  - **에러 번역**도 호출부 — webhook 은 isAuthError→401 / 그 외→502(httpErr)로 번역해야 하고 git-pull 은 raw 를
//    받아 PullRefreshResult.detail 로 요약한다. ensureClone 의 onError 훅이 **clone/fetch try 스코프에만**
//    걸리도록 해 종전 catch 범위(prepareGitAuth 실패는 번역 대상 아님)를 정확히 보존한다.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveGitSecret, hostOf, prepareGitAuth } from "../org/credentials/git-credential-store.js";
import { stateDir } from "../ops/state-dir.js";

const execFileP = promisify(execFile);

export interface GitOpts {
  /** 모든 git op 의 하드 타임아웃(ms). webhook 60_000 / git-pull 180_000 — 호출부 상수. */
  timeoutMs: number;
}

// 클론 캐시 디렉 — 서비스 유저 쓰기가능 런타임 루트(#618 stateDir, 기본 <cwd>/data/repos) 하위.
// 구 cwd-상대 'var/repos' 는 WorkingDirectory 가 타 uid 소유일 때 mkdir EACCES(=#606).
// env DOMAINMAP_REPOS_DIR 명시 오버라이드만 절대경로로 존중. 구 repodata 볼륨은 첫 웹훅 때 재클론(git_url 로).
export function reposDir(): string {
  return process.env.DOMAINMAP_REPOS_DIR ? resolve(process.env.DOMAINMAP_REPOS_DIR) : stateDir("repos");
}

// Sanitize a repo name to a safe single path segment for the clone dir. Strips
// any char outside [A-Za-z0-9._-]; an empty result is rejected by the caller.
export function sanitizeName(name: unknown): string {
  return String(name ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
}

// 클론 경로(캐시) — reposDir/sanitizeName 단일 조합. 부트스트랩(scheduler) 등 다른 곳도 같은 경로를 재사용(공식 1곳).
export function repoClonePath(repoName: string): string {
  const safe = sanitizeName(repoName);
  if (!safe) throw new Error("invalid repo name for clone dir");
  return join(reposDir(), safe);
}

// Run git with execFile (argv array — NEVER a shell string, no injection). SHAs
// are validated by the caller; paths in output come from git (trusted). A
// non-zero exit throws; we add a hard timeout to every git op.
//  extraEnv: 자격 주입(#606) — prepareGitAuth 의 GIT_SSH_COMMAND(키·accept-new)/GIT_ASKPASS. process.env 위에 병합.
//  GIT_TERMINAL_PROMPT=0 항상 — 무자격(앰비언트) 폴백이어도 프롬프트로 매달리지 않고 즉시 실패.
export async function git(args: string[], cwd: string | undefined, extraEnv: Record<string, string> | undefined, opts: GitOpts) {
  return execFileP("git", args, {
    cwd, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(extraEnv ?? {}) },
  });
}

export interface EnsureCloneOpts extends GitOpts {
  /** clone/fetch 실패 번역 훅(호출부 소유). 호출되면 반드시 throw 한다 — 미지정이면 raw 전파. */
  onGitError?: (e: unknown) => never;
}

// Ensure a local clone exists & is up to date. Clones from git_url if missing,
// else fetches. Returns the clone dir. NEVER includes git_url in thrown errors.
//  #606: provision 과 동일하게 게이트웨이 자격을 주입(SSH 키+accept-new). 웹훅·스케줄러 모두 무인 트리거라
//   멤버 없음 → resolveGitSecret(null, host) = 게이트웨이 머신 자격. 자격 없으면 앰비언트 폴백.
//  ⚠ onGitError 는 clone/fetch try 안에서만 — prepareGitAuth 실패는 종전대로 raw 전파(번역 대상 아님).
export async function ensureClone(repoName: string, gitUrl: string, opts: EnsureCloneOpts): Promise<string> {
  const cloneDir = repoClonePath(repoName);
  const dir = reposDir();
  const secret = await resolveGitSecret(null, hostOf(gitUrl) ?? "github.com").catch(() => null);
  const auth = await prepareGitAuth(secret);
  try {
    if (!existsSync(cloneDir)) {
      mkdirSync(dir, { recursive: true }); // 호스트 환경: 부모 디렉 보장(클론 자체엔 무영향)
      await git(["clone", gitUrl, cloneDir], undefined, auth.env, opts);
    } else {
      await git(["-C", cloneDir, "fetch", "--prune", "--quiet"], undefined, auth.env, opts);
    }
  } catch (e) {
    if (opts.onGitError) opts.onGitError(e);
    throw e;
  } finally {
    await auth.cleanup();
  }
  return cloneDir;
}

// Parse `git diff --name-status -M50` output into the refresh() changes[] shape.
// Lines: 'R<score>\t<from>\t<to>' | 'C<score>\t<from>\t<to>' (add of <to>) |
// 'A\t<path>' | 'D\t<path>' | 'M\t<path>' | 'T\t<path>' (treat as modify).
export function parseDiff(out: string): any[] {
  const changes: any[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const code = parts[0] ?? "";
    const letter = code[0];
    if (letter === "R") {
      if (!parts[1] || !parts[2]) continue;
      const score = Number(code.slice(1));
      changes.push({ status: "R", from: parts[1], to: parts[2], score: Number.isFinite(score) ? score : null });
    } else if (letter === "C") {
      if (!parts[2]) continue;
      // copy: the source is unchanged; treat the copy target as a fresh add.
      changes.push({ status: "A", path: parts[2] });
    } else if (letter === "A") {
      if (!parts[1]) continue;
      changes.push({ status: "A", path: parts[1] });
    } else if (letter === "D") {
      if (!parts[1]) continue;
      changes.push({ status: "D", path: parts[1] });
    } else if (letter === "M" || letter === "T") {
      if (!parts[1]) continue;
      changes.push({ status: "M", path: parts[1] });
    }
    // ignore U (unmerged) / X (unknown) — not reachable for a committed range.
  }
  return changes;
}
