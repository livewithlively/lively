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
import { existsSync, mkdirSync, openSync, writeSync, closeSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { resolveGitSecret, hostOf, prepareGitAuth } from "../org/credentials/git-credential-store.js";
import { stateDir } from "../ops/state-dir.js";
import { workspaceDirSegments } from "../ops/workspace-dir-key.js";

const execFileP = promisify(execFile);

export interface GitOpts {
  /** 모든 git op 의 하드 타임아웃(ms). webhook 60_000 / git-pull 180_000 — 호출부 상수. */
  timeoutMs: number;
  /** 표준출력 상한(바이트). 기본 16MB — 넘으면 execFile 이 ERR_CHILD_PROCESS_STDIO_MAXBUFFER 로 던진다. */
  maxBuffer?: number;
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
//  워크스페이스 열쇠가 있으면 `reposDir/@ws/<워크스페이스 id>/<name>`(ops/workspace-dir-key.ts) — 이름만으로 자리를 잡으면 게이트웨이 하나가
//  여러 워크스페이스를 서비스할 때 다른 워크스페이스가 같은 이름으로 등록한 레포가 먼저 받아 둔 클론을 fetch 해 그 코드를 제 것으로 읽는다
//  (ensureClone 은 있는 클론이면 주소를 다시 보지 않는다). 열쇠가 없으면(단일 워크스페이스 · primary) 종전 자리 그대로다.
export function repoClonePath(repoName: string): string {
  const safe = sanitizeName(repoName);
  if (!safe) throw new Error("invalid repo name for clone dir");
  return join(reposDir(), ...workspaceDirSegments(), safe);
}

/** git 표준출력 기본 상한(바이트). */
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;

// Run git with execFile (argv array — NEVER a shell string, no injection). SHAs
// are validated by the caller; paths in output come from git (trusted). A
// non-zero exit throws; we add a hard timeout to every git op.
//  extraEnv: 자격 주입(#606) — prepareGitAuth 의 GIT_SSH_COMMAND(키·accept-new)/GIT_ASKPASS. process.env 위에 병합.
//  GIT_TERMINAL_PROMPT=0 항상 — 무자격(앰비언트) 폴백이어도 프롬프트로 매달리지 않고 즉시 실패.
export async function git(args: string[], cwd: string | undefined, extraEnv: Record<string, string> | undefined, opts: GitOpts) {
  return execFileP("git", args, {
    cwd, timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer ?? GIT_MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(extraEnv ?? {}) },
  });
}

export interface EnsureCloneOpts extends GitOpts {
  /** clone/fetch 실패 번역 훅(호출부 소유). 호출되면 반드시 throw 한다 — 미지정이면 raw 전파. */
  onGitError?: (e: unknown) => never;
  /** 레포별 clone/fetch 잠금을 기다리는 상한(ms). 기본 CLONE_LOCK_WAIT_MS. */
  lockWaitMs?: number;
}

// ── 레포별 clone/fetch 잠금 ──
//  같은 클론을 웹훅·git-pull·작업 기록 touch 유도(activity/derive-touches.ts)가 함께 fetch 하고, blue/green 두 색
//  프로세스가 같은 데이터 디렉터리를 본다. 그래서 프로세스 안 뮤텍스로는 못 막고 파일로 잠근다.
//  DB advisory lock 을 쓰지 않는 이유: 세션 락은 풀 연결 하나를 fetch 내내 쥐고(레포 수만큼 점유), 본 작업이 두 번째
//  연결을 쓰면 풀이 잠금만으로 바닥날 수 있다(dispatch-lock.ts 머리말과 같은 이유).
//  pid 생존으로 낡은 잠금을 가리지 않는다 — 두 색이 다른 pid 네임스페이스(컨테이너)일 수 있어 남의 잠금을 죽은 것으로 볼 수 있다.
//  그래서 나이만 본다: CLONE_LOCK_STALE_MS 는 git 한 번의 최대 타임아웃(git-pull 180s)보다 길어야 한다.
export const CLONE_LOCK_WAIT_MS = 10_000;
export const CLONE_LOCK_STALE_MS = 10 * 60_000;

/** 잠금을 기다리다 상한에 닿았다 — 호출부는 오류가 아니라 「다음에 다시」로 다룬다. */
export class CloneBusyError extends Error {
  readonly code = "ECLONEBUSY";
  constructor(repoName: string) { super(`clone busy: ${sanitizeName(repoName)}`); }
}

function cloneLockPath(repoName: string): string {
  // 클론 디렉터리 옆에 둔다 — 첫 clone 전에는 클론 디렉터리가 없다. 자리는 클론 자리(repoClonePath)를 그대로 따른다:
  //  워크스페이스 열쇠가 있으면 reposDir/@ws/<id>/ 밑이다. reposDir 바로 밑에 두면 두 워크스페이스의 같은 이름 레포가 클론은
  //  따로인데 잠금을 나눠, 한쪽 fetch 가 남의 웹훅을 «clone busy» 로 돌려보내고 git-pull · touch 유도를 건너뛰게 한다.
  return join(dirname(repoClonePath(repoName)), `.${sanitizeName(repoName)}.fetch.lock`);
}

function lockAgeMs(path: string): number | null {
  try {
    const at = Number((JSON.parse(readFileSync(path, "utf8")) as { at?: unknown }).at);
    if (Number.isFinite(at)) return Date.now() - at;
  } catch { /* 쓰는 도중이거나 깨진 파일 — mtime 으로 */ }
  try { return Date.now() - statSync(path).mtimeMs; } catch { return null; }
}

/** 레포별 파일 잠금 아래에서 fn 을 돈다. waitMs 안에 못 얻으면 CloneBusyError. */
export async function withCloneLock<T>(repoName: string, fn: () => Promise<T>, waitMs: number = CLONE_LOCK_WAIT_MS): Promise<T> {
  const path = cloneLockPath(repoName);
  mkdirSync(dirname(path), { recursive: true });   // 워크스페이스 자리(@ws/<id>)는 첫 clone 전에 없을 수 있다
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token })); } finally { closeSync(fd); }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    }
    const age = lockAgeMs(path);
    if (age !== null && age > CLONE_LOCK_STALE_MS) { try { unlinkSync(path); } catch { /* 다른 쪽이 먼저 걷었다 */ } continue; }
    if (Date.now() >= deadline) throw new CloneBusyError(repoName);
    await new Promise((r) => setTimeout(r, 100));
  }
  try { return await fn(); }
  finally {
    // 내 잠금일 때만 지운다 — 낡은 것으로 걷힌 뒤 남이 새로 잡은 잠금을 지우지 않게.
    try { if ((JSON.parse(readFileSync(path, "utf8")) as { token?: unknown }).token === token) unlinkSync(path); }
    catch { /* 이미 없다 */ }
  }
}

// Ensure a local clone exists & is up to date. Clones from git_url if missing,
// else fetches. Returns the clone dir. NEVER includes git_url in thrown errors.
//  #606: provision 과 동일하게 게이트웨이 자격을 주입(SSH 키+accept-new). 웹훅·스케줄러 모두 무인 트리거라
//   멤버 없음 → resolveGitSecret(null, host) = 게이트웨이 머신 자격. 자격 없으면 앰비언트 폴백.
//  ⚠ onGitError 는 clone/fetch try 안에서만 — prepareGitAuth 실패는 종전대로 raw 전파(번역 대상 아님).
export async function ensureClone(repoName: string, gitUrl: string, opts: EnsureCloneOpts): Promise<string> {
  const cloneDir = repoClonePath(repoName);
  const dir = dirname(cloneDir);
  const secret = await resolveGitSecret(null, hostOf(gitUrl) ?? "github.com").catch(() => null);
  const auth = await prepareGitAuth(secret);
  try {
    // 잠금 대기 실패(CloneBusyError)는 onGitError 로 번역하지 않는다 — git 오류가 아니라 「다음에 다시」다.
    await withCloneLock(repoName, async () => {
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
      }
    }, opts.lockWaitMs);
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
