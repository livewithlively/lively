// 서버사이드 git pull + 구조 refresh — 인프로세스 스케줄러(scheduler/index.ts)가 호출.
//  webhook.ts(push 이벤트 트리거)와 같은 결정적 엔진(core/refresh)을 쓰되 트리거만 다르다:
//  여기는 repo.last_refreshed_sha → origin/<default_branch> 증분 diff 를 떠서 refresh 에 먹인다.
//  게이트웨이가 '바깥으로' fetch 하므로 inbound 도달성·repo당 웹훅 등록이 불필요(표준화: 셋업 0).
//  비치명적: git_url 없거나 clone/fetch 실패는 skip/error 로 반환(스케줄러를 죽이지 않는다).
//  rename/삭제 '의미 판단'은 하지 않는다 — core/refresh 가 결정적으로 처리(매핑 무변경·소프트삭제·inbox).
import { getRepo } from "./core/repos.js";
import { refresh } from "./core/refresh.js";
import type { Actor } from "./core/types.js";
import { hostOf, isAuthError, describeGitError } from "../org/credentials/git-credential-store.js";
import { git as gitExec, ensureClone as ensureCloneRaw, repoClonePath, parseDiff } from "./git-sync.js";

// repoClonePath 는 구 git-pull.ts 표면(scheduler/actions/map-bootstrap.ts 가 동적 import).
//  구현은 git-sync 단일 출처, 여기선 재수출로 표면 유지.
export { repoClonePath };

// clone(대형 레포 초회)은 fetch 보다 오래 걸릴 수 있어 provision(180s)과 맞춘다 — 상한일 뿐(지연 아님).
const GIT_TIMEOUT_MS = 180_000;
const SHA_RE = /^[0-9a-f]{7,40}$/;

// 스케줄러 예산(180s)을 묶은 git 실행기 — 구 로컬 git() 과 동일 시그니처라 호출부 무변경.
const git = (args: string[], cwd?: string, extraEnv?: Record<string, string>) =>
  gitExec(args, cwd, extraEnv, { timeoutMs: GIT_TIMEOUT_MS });

// 클론 보장 — 구현은 git-sync.ensureClone 단일 출처. 여기는 번역 훅 없이 raw 전파(호출부
//  refreshRepoFromGit 의 catch 가 PullRefreshResult.detail 로 요약 — 종전 의미 그대로).
const ensureClone = (repoName: string, gitUrl: string): Promise<string> =>
  ensureCloneRaw(repoName, gitUrl, { timeoutMs: GIT_TIMEOUT_MS });

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
