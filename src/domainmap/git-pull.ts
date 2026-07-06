// 서버사이드 git pull + 구조 refresh — 인프로세스 스케줄러(scheduler.ts)가 호출.
//  webhook.ts(push 이벤트 트리거)와 같은 결정적 엔진(core/refresh)을 쓰되 트리거만 다르다:
//  여기는 repo.last_refreshed_sha → origin/<default_branch> 증분 diff 를 떠서 refresh 에 먹인다.
//  게이트웨이가 '바깥으로' fetch 하므로 inbound 도달성·repo당 웹훅 등록이 불필요(표준화: 셋업 0).
//  비치명적: git_url 없거나 clone/fetch 실패는 skip/error 로 반환(스케줄러를 죽이지 않는다).
//  rename/삭제 '의미 판단'은 하지 않는다 — core/refresh 가 결정적으로 처리(매핑 무변경·소프트삭제·inbox).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRepo } from "./core/repos.js";
import { refresh } from "./core/refresh.js";
import type { Actor } from "./core/types.js";
import { resolveGitSecret, hostOf, prepareGitAuth, isAuthError, describeGitError } from "../org/git-credential-store.js";
import { stateDir } from "../state-dir.js";

const execFileP = promisify(execFile);
// clone(대형 레포 초회)은 fetch 보다 오래 걸릴 수 있어 provision(180s)과 맞춘다 — 상한일 뿐(지연 아님).
const GIT_TIMEOUT_MS = 180_000;
const SHA_RE = /^[0-9a-f]{7,40}$/;

// 클론 캐시 — webhook.ts 와 동일 컨벤션(DOMAINMAP_REPOS_DIR, 기본 var/repos, .gitignore 등재).
// 클론 캐시 = 서비스 유저 쓰기가능 런타임 루트(#618 stateDir) 하위. 예전 cwd-상대 'var/repos' 는 WorkingDirectory 가
//  타 uid 소유일 때 mkdir EACCES(=#606). DOMAINMAP_REPOS_DIR 명시 오버라이드만 절대경로로 존중.
function reposDir(): string { return process.env.DOMAINMAP_REPOS_DIR ? resolve(process.env.DOMAINMAP_REPOS_DIR) : stateDir("repos"); }
function sanitizeName(name: string): string { return name.replace(/[^A-Za-z0-9._-]/g, "_"); }

// git 은 execFile(argv 배열 — 셸 문자열 금지, 인젝션 불가). 모든 op 에 하드 타임아웃.
//  extraEnv: 자격 주입(#606) — prepareGitAuth 가 만든 GIT_SSH_COMMAND(키·accept-new)/GIT_ASKPASS. process.env 위에 병합.
//  GIT_TERMINAL_PROMPT=0 항상 — 무자격(앰비언트) 폴백이어도 프롬프트로 매달리지 않고 즉시 실패.
async function git(args: string[], cwd?: string, extraEnv?: Record<string, string>) {
  return execFileP("git", args, {
    cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(extraEnv ?? {}) },
  });
}

// 로컬 클론 보장: 없으면 git_url 에서 clone, 있으면 fetch. git_url(토큰 포함 가능)은 에러에 절대 안 싣는다.
//  #606: provision 과 동일하게 게이트웨이 자격을 주입한다 — 스케줄러 무인 실행이라 멤버 없음 → resolveGitSecret(null, host)
//   = 게이트웨이 머신 자격(SSH 키+accept-new 호스트키). 자격 없으면 앰비언트 폴백. 예전엔 미주입이라 private SSH 레포에서 항상 실패.
async function ensureClone(repoName: string, gitUrl: string): Promise<string> {
  const safe = sanitizeName(repoName);
  if (!safe) throw new Error("invalid repo name for clone dir");
  const dir = reposDir();
  const cloneDir = join(dir, safe);
  const secret = await resolveGitSecret(null, hostOf(gitUrl) ?? "github.com").catch(() => null);
  const auth = await prepareGitAuth(secret);
  try {
    if (!existsSync(cloneDir)) { mkdirSync(dir, { recursive: true }); await git(["clone", gitUrl, cloneDir], undefined, auth.env); }
    else { await git(["-C", cloneDir, "fetch", "--prune", "--quiet"], undefined, auth.env); }
  } finally { await auth.cleanup(); }
  return cloneDir;
}

// `git diff --name-status -M50` → refresh() changes[] (webhook.ts parseDiff 와 동일 형식; R/C/A/D/M/T).
function parseDiff(out: string): any[] {
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
    } else if (letter === "C") { if (parts[2]) changes.push({ status: "A", path: parts[2] }); }
    else if (letter === "A") { if (parts[1]) changes.push({ status: "A", path: parts[1] }); }
    else if (letter === "D") { if (parts[1]) changes.push({ status: "D", path: parts[1] }); }
    else if (letter === "M" || letter === "T") { if (parts[1]) changes.push({ status: "M", path: parts[1] }); }
  }
  return changes;
}

export interface PullRefreshResult {
  repo: string;
  status: "ok" | "skipped" | "baseline" | "error";
  detail?: string;
  base?: string;
  head?: string;
  changes?: number;
  tally?: unknown;
}

// 한 repo 를 git 에서 당겨 구조 refresh. 멱등: base==head 면 skip, base 없으면 체크포인트만 세움(다음 틱부터 증분).
export async function refreshRepoFromGit(repoName: string, actor: Actor): Promise<PullRefreshResult> {
  const repo = await getRepo(repoName);
  if (!repo) return { repo: repoName, status: "error", detail: "no such repo" };
  if (!repo.git_url) return { repo: repoName, status: "skipped", detail: "no git_url" };
  const branch = repo.default_branch || "main";

  let cloneDir: string;
  try { cloneDir = await ensureClone(repo.name, repo.git_url); }
  catch (e) {
    // git_url(토큰 포함 가능)은 절대 안 싣는다 — 인증계열이면 자격 안내로, 그 외는 describeGitError 로 안전요약(URL 스크럽)해 진단가능성을 남긴다(#606).
    const detail = isAuthError((e as { stderr?: unknown })?.stderr ?? (e as Error)?.message ?? e)
      ? `git 인증 실패 — 호스트 '${hostOf(repo.git_url) ?? "?"}' 게이트웨이 SSH 키 미등록/불일치(관리탭 ▸ 게이트웨이 git 계정에 등록)`
      : `git clone/fetch 실패: ${describeGitError(e, repo.git_url)}`;
    return { repo: repoName, status: "error", detail };
  }

  let head: string;
  try { head = (await git(["-C", cloneDir, "rev-parse", `origin/${branch}`])).stdout.trim(); }
  catch { return { repo: repoName, status: "error", detail: "rev-parse failed" }; }
  if (!SHA_RE.test(head)) return { repo: repoName, status: "error", detail: "bad head sha" };

  const baseRaw = (typeof repo.last_refreshed_sha === "string" && SHA_RE.test(repo.last_refreshed_sha))
    ? repo.last_refreshed_sha : null;
  // base 가 클론에서 실제 reachable 한 커밋인지 검증 — phantom/history-rewrite/local-only 체크포인트(diff 영원히 실패)는
  //  null 취급해 head 로 자가 재베이스라인한다(is 는 이미 부트스트랩으로 현 HEAD 기준 → 적용할 diff 없음, 체크포인트만 정렬).
  let base = baseRaw;
  if (base) {
    try { await git(["-C", cloneDir, "cat-file", "-e", `${base}^{commit}`]); }
    catch { base = null; }
  }
  if (base && base === head) return { repo: repoName, status: "skipped", detail: "up-to-date", head };

  if (!base) {
    // 체크포인트 없음(ingest 부트스트랩 후) 또는 stale/unreachable → 베이스라인만 세우고 diff 미적용. 다음 틱부터 증분.
    await refresh(repoName, { head, changes: [] }, actor);
    return { repo: repoName, status: "baseline",
      detail: baseRaw ? "stale/unreachable base re-baselined to head" : "checkpoint set (no diff applied)", head };
  }

  let diffOut: string;
  try { diffOut = (await git(["-C", cloneDir, "diff", "--name-status", "-M50", base, head])).stdout || ""; }
  catch { return { repo: repoName, status: "skipped", detail: "sha not in clone yet, will retry next tick", base, head }; }

  const changes = parseDiff(diffOut);
  const r = await refresh(repoName, { base, head, changes, granularity: "file" }, actor);
  return { repo: repoName, status: "ok", base, head, changes: changes.length, tally: (r as { tally?: unknown }).tally };
}
