// 박스 러너 — 프로젝트 레포 환경 provision(clone→worktree→.lively 마커). work.mjs(로컬 PC)의 서버측 대응.
//  central-box-design §1 의 '박스=경작업' 경계를 "간단 코드작업도 경작업, 쉬운 UI 제공" 으로 확장(2026-06-26 윤상민 결정).
//  설계: [[local-work-project-repo-design]] §3(경로 모델)·§5(러너가 환경 provision). 마커는 [[box-project-lively-marker]].
//  보안(central-box-design §9 위협모델=사내신뢰): 경로는 workspace 안으로 봉쇄(.. 탈출 거부) · git 은 spawn arg-array
//   (셸 없음→인젝션 불가) · clone_url 은 레지스트리 sanitize(자격증명 제거) · 레포명/브랜치명 화이트리스트 검증.
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { PROJECT_SHARED_BASE, projectAbsPath, grantSharedGroupWrite } from "./project-fs.js";
import { assertDiskWritable } from "../ops/disk-guard.js"; // #813 T5 — 클론 전에 디스크 확인(꽉 차면 507)
import { getRepo } from "../domainmap/core/repos.js";
import { sanitizeCloneUrl } from "../domainmap/core/url-util.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { resolveGitSecret, leaseGitSecretForNode, hostOf, isAuthError, prepareGitAuth, describeGitError } from "../org/credentials/git-credential-store.js";
import type { GitCredentialSecret } from "../org/credentials/git-credential-store.js";

// 노드 provision 주입 묶음(#905 C4) — DB 를 아는 게이트웨이가 조회해 넘기고, DB 가 없는 노드는 그걸 그대로 쓴다.
//  · gitUrl = 레지스트리 repo.git_url. **시크릿이 아니다** — 이것만 넘겨도 공개 레포는 클론되고, 무엇보다
//    "레지스트리에 없다"는 오진이 사라진다(진짜 원인은 '노드가 DB 를 못 읽음'이었다).
//  · secret = 그 host 의 git 자격. **의뢰자 본인 것만 넘긴다** — 게이트웨이(조직) 자격은 절대 안 넘긴다.
//    근거는 이미 선 선례다: 위탁 태스크의 자격 리스도 `getMemberSecret(t.requester,...)` 로 **본인 것만** 싣고
//    조직 폴백이 없다(task-scheduler.ts). 반면 게이트웨이 로컬용 resolveGitSecret 은 "멤버 없으면 조직 폴백"이라,
//    그걸 그대로 노드에 주입하면 **조직 공용 git 키가 멤버 노트북으로 나간다**(권한 상승). 그래서 호출자가
//    본인 자격만 해소해 넘기는 형태로 못 박는다 — 이 모듈은 받은 것만 쓴다.
export interface RepoProvisionAuth { gitUrl: string | null; secret?: GitCredentialSecret | null }

// 노드로 내보낼 레포 주입을 해소하는 **단일 관문**(#905 C4) — 위탁(task-scheduler)·프로젝트(provision-remote) 공용.
//  DB(레지스트리 git_url + 자격)를 아는 게이트웨이에서만 부른다. 자격 정책(member=본인만 · worker=조직폴백)은
//  leaseGitSecretForNode 안에 갇혀 있다 — 여기서 resolveGitSecret 을 쓰면 안 된다(그건 무조건 조직폴백이라
//  member 노드로 조직 키가 샌다). 두 호출자가 이 함수만 쓰게 해 정책 우회 지점을 하나로 모은다.
export async function resolveRepoInject(
  repo: string, requesterId: string, nodeKind: "member" | "worker",
): Promise<RepoProvisionAuth> {
  const row = await getRepo(repo).catch(() => null);
  const host = hostOf(row?.git_url);
  const secret = host ? await leaseGitSecretForNode(requesterId, host, nodeKind).catch(() => null) : null;
  return { gitUrl: row?.git_url ?? null, secret };
}
// hostOf·isAuthError·prepareGitAuth 는 git-credential-store 로 이관(#606, 스캐너와 공유). 하위호환·기존 테스트 위해 re-export.
export { hostOf, isAuthError, prepareGitAuth, type GitAuth } from "../org/credentials/git-credential-store.js";

export const REPOS_SUBDIR = "repos"; // workspace/repos/<name> — 박스 호스트 클론(프로젝트 간 공유, worktree 의 부모)
const REPO_NAME_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/; // 경로 컴포넌트로 쓰이므로 슬래시 금지 + 점세그먼트(.·..·…) 거부(traversal 방지). 이름 속 점은 허용
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/; // git 브랜치명(선두 특수문자 금지)
const GIT_TIMEOUT_MS = 180_000;

//  inject(#905 C4) — **노드 실행 전용**. 게이트웨이가 이 레포의 git_url + (정책에 맞는) 자격을 해소해 실어 보낸다.
//   노드엔 DB 가 없어 getRepo/resolveGitSecret 이 실패하므로, spec 에 실려 오면 ensureBaseClone 이 DB 대신 이걸 쓴다.
//   게이트웨이 로컬(중앙) 실행 땐 미설정 → 종전대로 DB 를 읽는다.
export interface RepoSpec { name: string; path?: string; worktree?: boolean; branch?: string; inject?: RepoProvisionAuth; }
//  subpath = cwd 의 workspace 루트 기준 상대경로. 워크트리(project/<id>/<repo>)면 프로젝트 폴더 안이라 세션 cwd 로 쓸 수 있다
//   (세션 POST 가 프로젝트 폴더 봉쇄를 거므로). 클론 직접작업(workspace/repos/<repo>)이면 프로젝트 폴더 밖이라 세션 cwd 불가.
export interface ProvisionedRepo { name: string; path: string; worktree: boolean; branch: string | null; cwd: string; subpath: string; cloned: boolean; }

// git 실행 — async spawn(이벤트루프 비블로킹). 셸 미사용(arg-array) → 인젝션 불가. 타임아웃 시 kill.
//  extraEnv: 자격 주입(#540) — GIT_SSH_COMMAND(키파일)/GIT_ASKPASS(토큰). process.env 위에 병합.
//  timeoutMs: 기본은 클론/fetch 기준(180s). 사람이 버튼을 누르고 기다리는 호출(연결 확인 #825)은 짧게 준다.
function git(args: string[], cwd?: string, extraEnv?: Record<string, string>, timeoutMs = GIT_TIMEOUT_MS): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    // GIT_TERMINAL_PROMPT=0 은 항상 — 자격 미주입(앰비언트 폴백)이어도 git 이 Username/Password 프롬프트로 매달리지 않고
    //  즉시 실패하게 한다(무한대기 → 프록시 504 의 근본원인 제거, #522). 주입 자격(extraEnv)의 동일 키가 있으면 그 값이 뒤에서 우선.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(extraEnv ?? {}) };
    // umask 0002 — git 이 만드는 파일을 group-writable 로(게이트웨이-소유 공유 클론/워크트리를 멤버[lively-shared 그룹]가
    //  fetch/commit/편집, #522 B). 셸 경유하되 git args 는 "$@" 위치인자로만 전달(스크립트=고정 리터럴) → 인젝션 없음.
    //  exec 로 git 이 프로세스 대체(PID 유지 → kill·stdio·종료코드 정상).
    const p = spawn("sh", ["-c", 'umask 0002; exec "$@"', "sh", "git", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env });
    let out = "", err = "", done = false;
    const finish = (r: { ok: boolean; out: string; err: string }) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* */ } finish({ ok: false, out: out.trim(), err: `git 타임아웃(${timeoutMs}ms)` }); }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => { clearTimeout(timer); finish({ ok: false, out: out.trim(), err: err.trim() || e.message }); });
    p.on("close", (code) => { clearTimeout(timer); finish({ ok: code === 0, out: out.trim(), err: err.trim() }); });
  });
}
async function isRepo(p: string): Promise<boolean> { return !!p && fs.existsSync(p) && (await git(["rev-parse", "--git-dir"], p)).ok; }

// 스테일 워크트리 등록 정리 — 워크트리 디렉터리가 사라져도 git 은 등록을 남기고, 그 등록은 **prunable 이어도
//  브랜치를 계속 점유**한다(-b 도 attach 도 실패). 청소되는 임시경로에 뜬 워크트리가 지워지면 그 브랜치가
//  사람이 손으로 prune 할 때까지 영구히 막히므로, add 전에 항상 턴다(#932). 살아있는 등록엔 무해. best-effort.
async function pruneWorktrees(repoPath: string): Promise<void> { await git(["worktree", "prune"], repoPath); }

// 브랜치를 쥐고 있는 워크트리 경로(없으면 null) — git 은 한 브랜치를 두 워크트리에 못 건다.
async function worktreeHolding(repoPath: string, branch: string): Promise<string | null> {
  const r = await git(["worktree", "list", "--porcelain"], repoPath);
  if (!r.ok) return null;
  let at: string | null = null;
  for (const raw of r.out.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) at = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return at;
  }
  return null;
}

// 재사용 공유 클론 소급 보정(#522 B) — v0.1.70 이전 생성분은 .git 이 group-write 아니라 멤버(lively-shared)가 fetch/commit 못 함
//  (FETCH_HEAD/objects 쓰기 Permission denied). .git 이 이미 group-write 면 skip(매 provision chmod -R 낭비 방지 → 사실상 1회성).
//  게이트웨이가 클론 소유자라 chmod 가능. 경로는 "$1" 위치인자(인젝션 없음). best-effort.
async function ensureRepoGroupWritable(repoPath: string): Promise<void> {
  const gitDir = path.join(repoPath, ".git");
  try {
    const st = await fsp.stat(gitDir);
    if (!st.isDirectory() || (st.mode & 0o020)) return; // 이미 group-write, 또는 .git 이 파일(워크트리) → skip
  } catch { return; }                                    // .git 없음 → skip
  await new Promise<void>((res) => {
    const p = spawn("sh", ["-c", 'chmod -R g+w "$1" 2>/dev/null; find "$1" -type d -exec chmod g+s {} + 2>/dev/null; exit 0', "sh", gitDir], { stdio: "ignore" });
    p.on("close", () => res());
    p.on("error", () => res());
  });
}

// 재사용 레포를 현재 브랜치의 upstream 으로 fast-forward — 새 워크트리가 최신 base HEAD 에서 잘리도록.
//  best-effort·비파괴: 무인 provision 이라 자동 머지커밋·리베이스·충돌 금지 → ff-only 만.
//   dirty·무upstream·갈라짐·오프라인이면 손대지 않고 낡은 채 진행(터미널 생성을 막지 않음).
//   @{u} 사용 → repos 기본 클론(main→origin/main)이든 직접입력 경로(피처브랜치→그 upstream)든 브랜치 선택 존중.
async function refreshRepo(repoPath: string, extraEnv?: Record<string, string>): Promise<void> {
  const st = await git(["status", "--porcelain"], repoPath);
  if (!st.ok || st.out) return;                             // dirty 또는 상태확인 실패 → skip
  await git(["fetch"], repoPath, extraEnv);                  // private 면 자격 필요 → extraEnv 주입. 실패(오프라인 등) 무시
  await git(["merge", "--ff-only", "@{u}"], repoPath);       // ff 불가(갈라짐/무upstream) → 실패 무시, base 그대로
}

export interface SharedRepoRefreshResult {
  repo: string;
  status: "ok" | "up-to-date" | "dirty" | "no-clone" | "no-upstream" | "error";
  before?: string;
  after?: string;
  advanced: boolean;
  detail?: string;
}

// 공유 베이스(workspace/repos/<name>) 워킹트리를 upstream 으로 fast-forward — 웹 '코드 최신화' 버튼·MCP 공용 진입(#660 RO 모델).
//  게이트웨이(클론 소유자 lively)가 실행하므로 멤버는 워킹트리 group-write 없이도 최신 코드를 '읽게' 된다 — 즉 공유 실행코드(하네스·
//  플러그인·스킬)를 멤버가 못 고쳐 OS uid 격리(#524)를 유지한다(로컬쓰기 축 P1 우회). fetch 는 요청멤버(없으면 게이트웨이) 자격을
//  주입한다(원격인증 축 P2, #540). 비파괴: dirty 면 손대지 않고 skip, ff 불가(갈라짐/무upstream)면 base 그대로(reset·머지커밋 없음).
//  대상은 도메인맵 스캐너 클론(stateDir/repos, git-pull.ts)이 아니라 멤버가 실제로 읽는 provision 클론(PROJECT_SHARED_BASE/repos)이다.
export async function refreshSharedRepo(name: string, memberId?: string | null): Promise<SharedRepoRefreshResult> {
  const clean = String(name ?? "").trim();
  if (!REPO_NAME_RE.test(clean)) throw new HttpError(400, `레포 이름 형식 오류(영숫자.-_, 슬래시 불가): ${name}`);
  const repoPath = confineToWorkspace(path.join(PROJECT_SHARED_BASE, REPOS_SUBDIR, clean), "레포");
  if (!(await isRepo(repoPath))) {
    return { repo: clean, status: "no-clone", advanced: false, detail: "공유 베이스에 클론이 없습니다 — 이 레포를 쓰는 프로젝트에서 먼저 provision 하세요." };
  }
  const headOf = async () => (await git(["rev-parse", "HEAD"], repoPath)).out.trim();
  const before = await headOf();

  // dirty 면 비파괴로 skip(공유 클론은 게이트웨이 소유라 보통 clean — dirty 면 사람이 봐야 함).
  const st = await git(["status", "--porcelain"], repoPath);
  if (!st.ok) return { repo: clean, status: "error", before, advanced: false, detail: "git status 실패" };
  if (st.out) return { repo: clean, status: "dirty", before, advanced: false, detail: "공유 클론에 로컬 변경이 있어 건드리지 않았습니다(관리자 확인 필요)." };

  // upstream 없으면 ff 대상 자체가 없음.
  const up = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repoPath);
  if (!up.ok) return { repo: clean, status: "no-upstream", before, advanced: false, detail: "현재 브랜치에 upstream 이 없습니다." };

  // 자격 주입 — 요청멤버 우선, 없으면 게이트웨이. host: 레지스트리 git_url → origin remote → github.com.
  const row = await getRepo(clean).catch(() => null);
  const host = hostOf(row?.git_url) ?? hostOf(await originUrl(repoPath)) ?? "github.com";
  const secret = await resolveGitSecret(memberId ?? null, host).catch(() => null);
  const auth = await prepareGitAuth(secret);
  try {
    const f = await git(["fetch", "--prune"], repoPath, auth.env);
    if (!f.ok) {
      if (isAuthError(f.err)) {
        throw new HttpError(401, `레포 '${clean}' fetch 인증 실패 — 호스트 '${host}' 자격이 없습니다. `
          + `멤버는 내 프로필 ▸ git 인증에, 관리자는 관리탭 ▸ 게이트웨이 git 계정에 '${host}' 자격을 등록하세요.`);
      }
      return { repo: clean, status: "error", before, advanced: false, detail: `fetch 실패: ${describeGitError(f.err, row?.git_url)}` };
    }
    const m = await git(["merge", "--ff-only", "@{u}"], repoPath);
    const after = await headOf();
    if (!m.ok) {
      return { repo: clean, status: "error", before, after, advanced: after !== before,
        detail: "fast-forward 불가 — 공유 클론이 upstream 과 갈라졌습니다(관리자 확인 필요)." };
    }
    return { repo: clean, status: before === after ? "up-to-date" : "ok", before, after, advanced: before !== after };
  } finally {
    await auth.cleanup();
  }
}

// 기존 클론의 origin remote URL(호스트 매칭 폴백용) — 레지스트리에 git_url 이 없을 때.
async function originUrl(repoPath: string): Promise<string | null> {
  const r = await git(["config", "--get", "remote.origin.url"], repoPath);
  return r.ok ? (r.out.trim() || null) : null;
}

const CHECK_TIMEOUT_MS = 20_000; // 사람이 [연결 확인] 누르고 기다리는 시간 — 클론(180s)과 달리 짧게.

export interface RepoCheckResult {
  ok: boolean;
  host: string;
  default_branch: string | null;   // 원격 HEAD 가 가리키는 실제 기본 브랜치(--symref)
  branches: number;
  auth_error: boolean;
  detail: string | null;           // 실패 사유(자격·URL 스크럽됨)
}

// git 주소 연결 확인(#825) — 저장 전에 ls-remote 로 '진짜 접근되는지 + 기본 브랜치가 뭔지' 를 확인한다.
//  드롭다운(repo_discover)이 못 덮는 구간(API 토큰 없는 호스트·SSH 전송·미지원 provider)을 메꾼다: 오타를
//  '등록 후 스캔이 조용히 실패' 가 아니라 등록 시점에 잡는다. 자격은 클론과 동일 체인(멤버 → 게이트웨이 폴백)이라
//  여기서 통과하면 provision 클론도 통과한다는 게 성립한다.
//  ⚠ 응답에 시크릿·원격 URL 을 싣지 않는다 — describeGitError 가 URL/scp/자격을 스크럽한 한 줄만 남긴다.
//  새 표면 아님: 같은 URL 을 repo_set_source 로 저장하면 스캐너가 어차피 clone/fetch 한다(ls-remote 는 그 예행).
export async function checkGitRemote(gitUrl: string, memberId?: string | null): Promise<RepoCheckResult> {
  const url = String(gitUrl ?? "").trim();
  if (!url) throw new HttpError(400, "git 주소가 필요합니다");
  const host = hostOf(url);
  if (!host) throw new HttpError(400, "git 주소를 해석할 수 없습니다 — https://호스트/그룹/레포.git 또는 git@호스트:그룹/레포.git 형식이어야 합니다");

  const secret = await resolveGitSecret(memberId ?? null, host).catch(() => null);
  const auth = await prepareGitAuth(secret);
  try {
    // --symref: HEAD 의 심볼릭 참조(=원격 기본 브랜치)를 클론 없이 읽는다. 접근 확인과 브랜치 확인이 한 번에 끝난다.
    const r = await git(["ls-remote", "--symref", url], undefined, auth.env, CHECK_TIMEOUT_MS);
    if (!r.ok) {
      // ⚠ 오타(없는 레포)와 '권한 없는 private 레포' 를 구분해 안내하면 안 된다 — GitHub·GitLab 이 의도적으로
      //  둘을 같은 응답(not found)으로 은닉하기 때문에 우리도 알 수 없다(isAuthError 가 그래서 not-found 를 포함).
      //  [연결 확인] 을 누르는 가장 흔한 이유가 주소 오타이므로, '자격 문제' 라고만 말하면 사람을 엉뚱한 곳으로 보낸다.
      const authErr = isAuthError(r.err);
      return {
        ok: false, host, default_branch: null, branches: 0, auth_error: authErr,
        detail: authErr
          ? `접근할 수 없습니다 — ① 주소 오타(없는 레포)이거나 ② 호스트 '${host}' 자격이 없거나 권한이 부족합니다. `
            + `(private 레포는 권한이 없으면 '없음'과 똑같이 보여서 둘을 구분할 수 없습니다.) `
            + `주소를 먼저 확인하고, 자격은 관리탭 ▸ 게이트웨이 git 계정 또는 내 프로필 ▸ git 인증에서 '${host}' 에 등록하세요.`
          : describeGitError(r.err, url),
      };
    }
    // 출력: "ref: refs/heads/main\tHEAD" + "<sha>\tHEAD" + "<sha>\trefs/heads/<branch>" …
    const lines = r.out.split("\n").map((l) => l.trim()).filter(Boolean);
    const symref = lines.find((l) => l.startsWith("ref: refs/heads/"));
    const defaultBranch = symref ? symref.slice("ref: refs/heads/".length).split(/\s/)[0] || null : null;
    const branches = lines.filter((l) => /\srefs\/heads\//.test(l)).length;
    return { ok: true, host, default_branch: defaultBranch, branches, auth_error: false, detail: null };
  } finally {
    await auth.cleanup();
  }
}

// 경로 봉쇄 — 절대경로 정규화 후 workspace 루트 안에 있어야 함(.. 탈출 거부). 신뢰 위협모델이라 string-prefix 검사로 충분.
function confineToWorkspace(abs: string, label: string): string {
  const resolved = path.resolve(abs);
  if (resolved !== PROJECT_SHARED_BASE && !resolved.startsWith(PROJECT_SHARED_BASE + path.sep)) {
    throw new HttpError(400, `${label} 경로가 워크스페이스(${PROJECT_SHARED_BASE}) 밖입니다: ${abs}`);
  }
  return resolved;
}
const expandHome = (p: string): string => (p.startsWith("~/") ? path.join(process.env.HOME || "", p.slice(2)) : p);

// 공유 base 클론 확보(#458/#660 RO 모델) — workspace/repos/<name> 에 호스트당 1회 clone, 재사용 시 upstream FF.
//  이 base 는 '읽기 원본'이다: 실제 작업은 worktree 로 격리한다(base 직접 작업 금지 규율). 프로젝트·위탁 provision 공용.
//  자격(#540): 레포 host 매칭 멤버(없으면 게이트웨이) 자격을 이 호출의 git 에만 주입. inputPath 로 기존 클론 경로 지정 가능(프로젝트용).
async function ensureBaseClone(
  name: string, memberId: string | null,
  opts?: { inputPath?: string | null; allowClone?: boolean; inject?: RepoProvisionAuth },
): Promise<{ repoPath: string; cloned: boolean }> {
  if (!REPO_NAME_RE.test(name)) throw new HttpError(400, `레포 이름 형식 오류(영숫자.-_, 슬래시 불가): ${name}`);
  const reposBase = path.join(PROJECT_SHARED_BASE, REPOS_SUBDIR);
  const inputPath = opts?.inputPath && String(opts.inputPath).trim() ? expandHome(String(opts.inputPath).trim()) : path.join(reposBase, name);
  const repoPath = confineToWorkspace(inputPath, "레포");
  const allowClone = opts?.allowClone !== false;
  const existed = await isRepo(repoPath);
  // 🔴 주입 경로(#905 C4) — **노드엔 DB 가 없다**(agent.ts: "DB·웹 UI 없이 부팅한다"). 여기서 getRepo/resolveGitSecret 을
  //  부르면 itemsPool 이 localhost:5432 로 붙으려다 실패하고, .catch(()=>null) 이 그걸 삼켜 아래에서 409
  //  "레포의 git 주소가 레지스트리에 없습니다" 라는 **오진**이 난다 — 레포는 멀쩡히 등록돼 있는데 사용자에게
  //  "레지스트리에 등록하라"고 시킨다(시키는 대로 해도 안 고쳐진다). 그래서 DB 를 아는 게이트웨이가 조회해 넘긴다.
  const inject = opts?.inject;
  const row = inject ? { git_url: inject.gitUrl } : await getRepo(name).catch(() => null);
  const host = hostOf(row?.git_url) ?? (existed ? hostOf(await originUrl(repoPath)) : null) ?? "github.com";
  const secret = inject ? (inject.secret ?? null) : await resolveGitSecret(memberId, host).catch(() => null);
  const auth = await prepareGitAuth(secret);
  let cloned = false;
  try {
    if (!existed) {
      if (!allowClone) throw new HttpError(409, `레포가 '${repoPath}' 에 없습니다(클론 비활성).`);
      const url = sanitizeCloneUrl(row?.git_url ?? null);
      if (!url) throw new HttpError(409, `레포 '${name}' 의 git 주소가 레지스트리에 없습니다 — 관리탭 ▸ 레포(git) 관리에서 연결하세요.`);
      await assertDiskWritable(`레포 '${name}' 클론`, [PROJECT_SHARED_BASE]);
      await fsp.mkdir(path.dirname(repoPath), { recursive: true });
      const c = await git(["clone", "--config", "core.sharedRepository=group", url, repoPath], undefined, auth.env);
      if (!c.ok) {
        if (isAuthError(c.err)) {
          throw new HttpError(401, `레포 '${name}' 클론 인증 실패 — 호스트 '${host}' 자격이 없거나 프로토콜이 안 맞습니다. `
            + `내 프로필 ▸ git 인증(또는 관리탭 ▸ 게이트웨이 git 계정)에 '${host}' 자격을 등록하세요. `
            + `HTTPS 가 막힌 셀프호스팅(GitLab 등)은 레포 주소를 SSH 형(git@${host}:그룹/레포.git)으로 등록하고 SSH 키를 쓰세요. (git: ${c.err})`);
        }
        throw new HttpError(502, `git clone 실패(${name}): ${c.err}`);
      }
      cloned = true;
    } else {
      await ensureRepoGroupWritable(repoPath);
      await git(["config", "core.sharedRepository", "group"], repoPath).catch(() => { /* best-effort */ });
      await refreshRepo(repoPath, auth.env);
    }
    return { repoPath, cloned };
  } finally {
    await auth.cleanup();
  }
}

// 작업용 공유 base(workspace/repos/<name>) 확보·최신화 — 없으면 clone, 있으면 FF. 워크트리 셀프서비스(lively_local_repo_worktree)
//  의 최신 원본이자 scheduler 'refresh_bases' 주기 갱신의 per-repo 진입점(#900). ensureBaseClone(#458/#660) 공용 래퍼 —
//  실패는 던지지 않고 status:'error' 로 담아, 전 repo 순회 배치가 한 레포 실패(인증·오프라인 등)로 멈추지 않게 한다.
export async function ensureProvisionBase(
  name: string, memberId?: string | null,
): Promise<{ repo: string; status: "cloned" | "refreshed" | "error"; cloned: boolean; head: string | null; detail?: string }> {
  try {
    const { repoPath, cloned } = await ensureBaseClone(name, memberId ?? null, { allowClone: true });
    const head = (await git(["rev-parse", "--short", "HEAD"], repoPath)).out.trim() || null;
    return { repo: name, status: cloned ? "cloned" : "refreshed", cloned, head };
  } catch (e) {
    return { repo: name, status: "error", cloned: false, head: null, detail: e instanceof Error ? e.message : String(e) };
  }
}

// 위탁 레포 준비 실패 → 원인 분류 + 다음 행동을 실은 에러(#1155). **위탁은 fail-fast 를 유지한다** — 대화형
//  `lively run` 은 레포 준비가 실패해도 세션을 띄우지만(사람이 그 자리에서 자격·VPN 을 고칠 수 있다), 위탁은 무인이라
//  레포 없이 띄우면 빈 워크스페이스에서 헛돌다 그럴듯한 실패 리포트만 낸다(토큰·시간 낭비 + 오답 리스크). 대신 사람이
//  한 번에 고치도록 원인을 갈라 알려준다 — 종전엔 raw git stderr 만 떠서 무엇을 해야 하는지가 안 보였다.
//  분류는 메시지 텍스트 기반이다(위 throw 들이 이미 한국어로 사유를 담고, 그 밑 git stderr 는 영어) — 상태코드는 보존한다.
function delegateRepoError(e: unknown, repo: string): HttpError {
  const msg = e instanceof Error ? e.message : String(e);
  const status = e instanceof HttpError ? e.status : 502;
  const advice =
    /인증 실패|Authentication failed|could not read Username|could not read Password|Permission denied|403 Forbidden|401 Unauthorized/i.test(msg)
      ? "git 자격 문제 — 내 프로필 ▸ git 인증에 이 레포 호스트 자격을 등록한 뒤 다시 위탁하세요."
    : /레지스트리에 없|클론 비활성/.test(msg)
      ? "레포 등록 문제 — 관리탭 ▸ 레포(git) 관리에서 git 주소를 연결한 뒤 다시 위탁하세요."
    : /Could not resolve host|Connection refused|Connection timed out|network is unreachable|Operation timed out|SSL certificate|timeout/i.test(msg)
      ? "네트워크 문제 — 실행 노드에서 이 git 호스트에 닿는지 확인하세요(사내망·VPN 전용이면 그 망에 있는 노드를 --node 로 지정)."
    : /워크트리|worktree/i.test(msg)
      ? "워크트리 점유 — 위 경로의 워크트리를 정리하거나, 태스크를 새로 만들어 다시 위탁하세요."
      : "위 오류를 해결한 뒤 다시 위탁하세요.";
  // 위탁이 '레포 없이 그냥 시작'하지 않는 이유를 함께 밝힌다 — 대화형과 동작이 다른 게 의도임을 사용자가 알아야 한다.
  return new HttpError(status, `${msg}\n→ ${advice}\n  (레포 준비 전엔 위탁을 시작하지 않습니다 — 코드 없이 돌면 헛돕니다. `
    + `지금 당장 붙어서 작업할 거면 대화형 \`lively run\` 은 레포 준비가 실패해도 세션이 뜹니다.)`);
}

// 위탁 태스크용 레포 provision(#869 P2 후속) — 공유 base(RO 원본) 확보 후, 태스크 전용 worktree 에 격리 브랜치로 체크아웃.
//  워커 세션 cwd 는 이 worktree 다(base 직접작업 안 함 = RO 모델). ref 지정 시 그 upstream(origin/<ref>)에서 분기.
//  중앙 노드·원격 노드가 각자 자기 호스트의 workspace/repos 에 클론(호스트별 로컬 복제본 — 미동기화, git remote 로 수렴).
export async function provisionTaskRepo(
  workspaceDir: string, taskId: number, repo: string, ref: string | null, memberId: string | null,
  inject?: RepoProvisionAuth,
): Promise<string> {
  // inject 는 **노드에서 실행될 때** 게이트웨이가 실어 보낸다(노드엔 DB 가 없다 — ensureBaseClone 주석 참조).
  //  중앙(게이트웨이 내장 노드)에서 돌 땐 undefined → 종전대로 DB 를 직접 읽는다(무회귀).
  let repoPath: string;
  try {
    ({ repoPath } = await ensureBaseClone(repo, memberId, { inject }));
  } catch (e) {
    throw delegateRepoError(e, repo);
  }
  const wtParent = confineToWorkspace(workspaceDir, "위탁 워크스페이스");
  const wtPath = confineToWorkspace(path.join(wtParent, repo), "위탁 워크트리");
  const branch = `delegate/task-${taskId}`;
  if (!BRANCH_RE.test(branch)) throw new HttpError(400, `브랜치명 형식 오류: ${branch}`);
  if (!fs.existsSync(wtPath)) {
    await fsp.mkdir(wtParent, { recursive: true });
    await pruneWorktrees(repoPath); // #932 — 이전 위탁 워크트리가 지워졌어도 등록이 delegate/task-<id> 를 쥐고 있음
    const from = ref && BRANCH_RE.test(ref) ? [`origin/${ref}`] : []; // ref 지정 시 그 upstream 기준(없으면 base HEAD)
    let w = await git(["worktree", "add", wtPath, "-b", branch, ...from], repoPath);
    if (!w.ok) w = await git(["worktree", "add", wtPath, branch], repoPath); // 재큐로 이미 브랜치 있으면 attach 폴백
    if (!w.ok) {
      const at = await worktreeHolding(repoPath, branch);
      throw delegateRepoError(new HttpError(502, `위탁 워크트리 생성 실패(${repo}): ${w.err}`
        + (at ? ` — 브랜치 '${branch}' 는 이미 '${at}' 워크트리가 쥐고 있습니다(git 은 한 브랜치를 두 워크트리에 못 겁니다).` : "")), repo);
    }
  }
  return wtPath;
}

// 레포 준비 실패 1건(#1155) — **kit/setup/work.mjs 의 repos_failed 항목과 같은 스키마**다. 같은 마커 키에 같은 모양으로
//  써야 세션 프리로드 훅(session-preload.repoFailureNotice)이 로컬 실행이든 박스·노드 실행이든 구분 없이 읽는다.
export interface ProvisionFailure {
  name: string; path: string | null; expect: string | null; worktree: boolean; reason: string; hint: string | null;
}
export interface ProvisionResult { provisioned: ProvisionedRepo[]; failed: ProvisionFailure[] }
// 준비 '진행 중' 1건(#1180) — 비동기 provision 에선 세션이 코드보다 먼저 뜬다. 그 세션의 AI 가 빈 폴더를 보고
//  '레포가 없다'고 오판해 엉뚱한 자리에 clone 하지 않도록, 시작 시점에 마커에 남겨 프리로드가 주입한다.
export interface ProvisionPending { name: string; expect: string; worktree: boolean; at: string }

// 레포 준비 실패 → 원인 분류 + 복구 한 줄(#1155). work.mjs 의 gitHint 와 같은 분류·같은 복구 표면(`lively repo worktree`).
function provisionHint(msg: string, name: string): string {
  const recover = `세션 안에서 \`lively repo worktree ${name}\` 로 다시 준비할 수 있습니다.`;
  if (/인증 실패|Authentication failed|could not read Username|Permission denied|403 Forbidden|401 Unauthorized/i.test(msg)) {
    return `git 자격 문제로 보입니다 — 내 프로필 ▸ git 인증에 이 레포 호스트 자격을 등록한 뒤, ${recover}`;
  }
  if (/레지스트리에 없|클론 비활성/.test(msg)) {
    return `레포 등록 문제 — 관리탭 ▸ 레포(git) 관리에서 git 주소를 연결한 뒤, ${recover}`;
  }
  if (/Could not resolve host|Connection refused|Connection timed out|network is unreachable|Operation timed out|SSL certificate/i.test(msg)) {
    return `네트워크 문제로 보입니다 — 이 호스트에서 git 서버에 닿는지 확인한 뒤, ${recover}`;
  }
  if (/워크트리가 쥐고|worktree/i.test(msg)) {
    return `브랜치 점유 — 위 워크트리를 정리하거나 이 레포의 branch 를 다른 이름으로 지정하세요.`;
  }
  return recover;
}

interface RepoPlan { spec: RepoSpec; name: string; branch: string; worktree: boolean; expect: string }

// 계획 수립(입력 검증 + 코드가 놓일 자리 계산) — **실제 작업 전에 전부 검증**한다. '준비 중' 마커를 먼저 쓰기 때문에,
//  검증 실패로 중간에 튕기면 그 마커가 유령으로 남는다(영영 "받는 중"이라고 안내된다). I/O 없이 끝나므로 앞으로 모은다.
function planSpecs(projectId: number, projDir: string, specs: RepoSpec[]): RepoPlan[] {
  return specs.map((spec) => {
    const name = String(spec?.name || "").trim();
    if (!REPO_NAME_RE.test(name)) throw new HttpError(400, `레포 이름 형식 오류(영숫자.-_, 슬래시 불가): ${name}`);
    const branch = (spec.branch && String(spec.branch).trim()) || `project/${projectId}`;
    if (!BRANCH_RE.test(branch)) throw new HttpError(400, `브랜치명 형식 오류: ${branch}`);
    const worktree = !!spec.worktree;
    // 준비되면 코드가 놓일 자리 — 세션 프리로드 훅이 이 경로의 존재로 '이미 준비됨/복구됨'을 판정한다.
    //  worktree 면 프로젝트 폴더 아래, 아니면 클론 경로(ensureBaseClone 의 기본 자리와 같은 계산).
    const expect = worktree
      ? path.join(projDir, name)
      : (spec.path && String(spec.path).trim() ? expandHome(String(spec.path).trim()) : path.join(PROJECT_SHARED_BASE, REPOS_SUBDIR, name));
    return { spec, name, branch, worktree, expect };
  });
}
function markPending(projDir: string, projectId: number, plan: RepoPlan[]): Promise<void> {
  return writeProvisionMarker(projDir, projectId, [], [], plan.map((p) => ({
    name: p.name, expect: p.expect, worktree: p.worktree, at: new Date().toISOString(),
  })));
}

// '준비 중' 표시만 먼저 남긴다(#1180) — **비동기 시작의 순서 보장용**. 시작 응답이 나가기 전에 이걸 await 해야,
//  그 직후 열리는 세션의 프리로드가 반드시 "받는 중"을 본다(안 그러면 빈 폴더를 보고 AI 가 제멋대로 clone 한다).
//  입력 검증도 여기서 끝나므로 잘못된 spec 은 백그라운드로 새지 않고 호출자에게 바로 4xx 로 돌아간다.
export async function markProvisionPending(projectId: number, folder: string, specs: RepoSpec[]): Promise<void> {
  if (!folder) throw new HttpError(400, "프로젝트 폴더가 없습니다");
  const projDir = projectAbsPath(folder);
  await markPending(projDir, projectId, planSpecs(projectId, projDir, specs));
}

// 프로젝트 레포들을 박스에 provision — 각 spec: 경로(없으면 workspace/repos/<name> 기본) 확보(없으면 clone) +
//  worktree 옵션 시 project/<id>/<name> 워크트리(브랜치 project/<id>) 생성. 결과 경로를 .lively/project.json(provisioned)에 기록.
//  멱등: 이미 있는 클론/워크트리는 재사용(덮어쓰기 없음).
//  실패 정책(#1155) — **호출자가 고른다**:
//   · 기본(failOpen 미지정): 첫 실패에서 throw(종전). 준비된 코드가 없으면 의미가 없는 호출자용(프리뷰 환경 등).
//   · failOpen: 실패한 레포만 건너뛰고 나머지를 계속 준비한 뒤, 실패 목록을 **마커(repos_failed)에 남기고 반환**한다.
//     세션을 여는 경로가 이걸 쓴다 — 레포 하나 못 받았다고 세션 자체를 못 열면 사람이 그 자리에서 고칠 기회조차 없다
//     (로컬 `lively run` 이 같은 이유로 fail-open 이다). 마커에 남은 실패는 세션 시작 시 AI 컨텍스트로 주입된다.
//  ⚠ 입력 검증(레포명·브랜치명 형식)은 failOpen 이어도 throw 한다 — 그건 환경 문제가 아니라 호출자 버그이고,
//   세션 안에서 사람이 고칠 수 있는 종류가 아니다.
export async function provisionProjectRepos(
  projectId: number, folder: string, specs: RepoSpec[],
  opts?: { clone?: boolean; memberId?: string | null; failOpen?: boolean },
): Promise<ProvisionResult> {
  if (!folder) throw new HttpError(400, "프로젝트 폴더가 없습니다");
  const projDir = projectAbsPath(folder);                       // workspace/project/<id>
  const allowClone = opts?.clone !== false;
  const out: ProvisionedRepo[] = [];
  const failed: ProvisionFailure[] = [];

  const plan = planSpecs(projectId, projDir, specs);

  // '준비 중' 표시(#1180) — 아래 finally 가 성공/실패 결과로 이 키를 반드시 걷어낸다(중간에 throw 해도).
  await markPending(projDir, projectId, plan).catch(() => { /* 마커 실패가 provision 을 막지 않는다 */ });

  try {
  for (const { spec, name, branch, worktree, expect } of plan) {
    try {
      // ①·② 공유 base 확보(clone 또는 재사용+FF) — 자격주입·디스크가드·RO 리프레시는 ensureBaseClone 공용(위탁도 재사용).
      //  spec.inject 가 있으면(노드 실행) DB 대신 그걸 쓴다 — 없으면(중앙) 종전대로 DB 조회(무회귀).
      const { repoPath, cloned } = await ensureBaseClone(name, opts?.memberId ?? null, { inputPath: spec.path, allowClone, inject: spec.inject });

      // ③ worktree 옵션 — project/<id>/<name> 에 브랜치 격리(이미 있으면 재사용). 미사용 시 cwd=클론 경로.
      let cwd = repoPath;
      if (worktree) {
        const wtPath = confineToWorkspace(path.join(projDir, name), "워크트리");
        if (!fs.existsSync(wtPath)) {
          await fsp.mkdir(projDir, { recursive: true });
          await pruneWorktrees(repoPath); // #932 — 사라진 워크트리의 등록이 이 브랜치를 계속 쥐고 있지 않게
          // -b 로 새 브랜치 시도 → 같은 브랜치가 이미 다른 worktree 면 실패 → 기존 브랜치 attach 폴백(work.mjs 동형).
          let w = await git(["worktree", "add", wtPath, "-b", branch], repoPath);
          if (!w.ok) w = await git(["worktree", "add", wtPath, branch], repoPath);
          if (!w.ok) {
            // #932 — 여기 오는 압도적 다수는 '그 브랜치를 다른 워크트리가 쥐고 있음'이다. git 은 점유자 경로를
            //  말해주지만 왜/어떻게 빠져나오는지는 안 알려준다. 슬롯 밖 워크트리가 project/<id> 를 선점한 상태라
            //  사람이 그 워크트리를 정리하거나 branch 를 지정해야 풀린다.
            const at = await worktreeHolding(repoPath, branch);
            throw new HttpError(502, `git worktree add 실패(${name}): ${w.err}`
              + (at ? ` — 브랜치 '${branch}' 는 이미 '${at}' 워크트리가 쥐고 있습니다(git 은 한 브랜치를 두 워크트리에 못 겁니다).`
                + ` 그 워크트리를 정리하거나, 이 레포의 branch 를 다른 이름으로 지정하세요.` : ""));
          }
        }
        cwd = wtPath;
      }
      const subpath = path.relative(PROJECT_SHARED_BASE, cwd);
      out.push({ name, path: repoPath, worktree, branch: worktree ? branch : null, cwd, subpath, cloned });
    } catch (e) {
      if (!opts?.failOpen) throw e;
      const reason = e instanceof Error ? e.message : String(e);
      failed.push({ name, path: spec.path ? String(spec.path) : null, expect, worktree, reason, hint: provisionHint(reason, name) });
      logger.warn({ projectId, repo: name, reason }, "레포 provision 실패 — 세션은 계속 진행(#1155)");
    }
  }
  } finally {
    // 결과 기록은 **어떤 경로로 빠져나가든** 한다 — fail-fast 로 throw 하는 중이어도 '준비 중' 표시는 걷어내야 한다
    //  (안 그러면 세션이 영영 "받는 중"이라고 안내받는다). 여기서 pending=[] 이라 그 키는 지워진다.
    await writeAddDir(projDir, projectId, out.filter((r) => !r.worktree).map((r) => r.path)).catch(() => { /* 무해 */ });
    await writeProvisionMarker(projDir, projectId, out, failed).catch(() => { /* 마커 실패는 비치명 */ });
  }
  return { provisioned: out, failed };
}

// add-dir — 세션 cwd(프로젝트 폴더) 밖의 레포 클론을 하네스가 접근하도록 등록(work.mjs writeAddDir 서버 포팅, 멱등).
//  Claude Code: 프로젝트 폴더의 .claude/settings.local.json(additionalDirectories, host-local·비동기화).
//  Codex: ~/.codex/config.toml 의 [sandbox_workspace_write] writable_roots(이미 있는 경로는 건너뜀).
// 옛 버전이 이스케이프 없이 박은 윈도우 경로 복구 — 그 파일은 codex 가 통째로 못 읽는 상태라 사용자는
//  손으로 고치기 전엔 codex 를 아예 못 켠다(2026-08-04 윈도우 실기기). 우리가 만든 고장이므로 우리가 되돌린다.
//  대상은 `writable_roots = [...]` 줄뿐 — 사용자의 다른 줄은 불가침.
//  ⚠ 유효 이스케이프를 **통째로 소비**해야 멱등이다. 백슬래시를 하나씩 lookahead 로 보면 이미 올바른 `\\Users` 의
//   두 번째 백슬래시가 '\U 로 시작하는 잘못된 이스케이프'로 보여 재실행마다 백슬래시가 늘어난다(실측).
//  ⚠ kit/setup/work.mjs 의 동명 함수와 **같은 규칙을 유지**할 것(두 경로가 같은 파일을 쓴다).
const TOML_ESC = /\\\\|\\["bfnrt]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}|\\/g;
export function repairTomlWinPaths(toml: string): string {
  return String(toml).replace(/^([ \t]*writable_roots[ \t]*=[ \t]*)(\[[^\]\n]*\])/gm, (_line, head: string, arr: string) =>
    head + arr.replace(/"(?:[^"\\]|\\.)*"/g, (lit) =>
      lit.replace(TOML_ESC, (m) => (m === "\\" ? "\\\\" : m))));
}

async function writeAddDir(projDir: string, projectId: number, targets: string[]): Promise<void> {
  if (!targets.length) return;
  // Claude Code — 프로젝트-로컬 설정
  const ccDir = path.join(projDir, ".claude");
  await fsp.mkdir(ccDir, { recursive: true });
  const ccFile = path.join(ccDir, "settings.local.json");
  let cc: Record<string, unknown> = {};
  try { cc = JSON.parse(await fsp.readFile(ccFile, "utf8")); } catch { /* 신규 */ }
  const dirs = new Set(Array.isArray(cc.additionalDirectories) ? cc.additionalDirectories as string[] : []);
  targets.forEach((t) => dirs.add(t));
  cc.additionalDirectories = [...dirs];
  await fsp.writeFile(ccFile, JSON.stringify(cc, null, 2) + "\n");
  // Codex — 박스 사용자 전역 config(이미 등재된 경로는 제외; 미설치/실패는 무해)
  //  ⚠ 경로는 **반드시 JSON.stringify** 로 — TOML basic string 은 백슬래시를 이스케이프로 읽으므로 윈도우 경로를
  //   날것으로 넣으면 `C:\Users\…` 의 `\U` 가 유니코드 이스케이프로 해석돼 `too few unicode value digits` 로
  //   **config.toml 전체가 로드 실패**한다(= codex 가 아예 안 뜬다). mac/linux 에선 절대 재현되지 않는다.
  try {
    const cxFile = path.join(os.homedir(), ".codex", "config.toml");
    let toml = ""; try { toml = await fsp.readFile(cxFile, "utf8"); } catch { /* 신규 */ }
    const before = toml;
    toml = repairTomlWinPaths(toml);           // 옛 버전이 남긴 깨진 줄 복구
    // 중복 판정도 **기록되는 표기**로 — 날것 경로로 찾으면 윈도우에선 매번 못 찾아 같은 경로가 계속 쌓인다.
    const fresh = targets.filter((t) => !toml.includes(JSON.stringify(t)) && !toml.includes(`"${t}"`));
    if (!fresh.length && toml !== before) await fsp.writeFile(cxFile, toml); // 복구만 필요한 경우
    if (fresh.length) {
      await fsp.mkdir(path.dirname(cxFile), { recursive: true });
      const roots = fresh.map((t) => JSON.stringify(t)).join(", ");
      const ins = `[sandbox_workspace_write]\n# lively: 프로젝트 ${projectId} 레포\nwritable_roots = [${roots}]`;
      const block = toml.includes("[sandbox_workspace_write]") ? toml.replace(/\[sandbox_workspace_write\]/, ins) : toml + "\n" + ins + "\n";
      await fsp.writeFile(cxFile, block);
    }
  } catch { /* codex 미설치 등 — 무해 */ }
}

// .lively/project.json 의 'provisioned' 키에 박스 클론/워크트리 경로 기록(이름만 적는 'repos' 키와 분리 — 충돌 없음·비파괴).
//  ensureAgentsMd 가 'repos'(이름) 를 갱신해도 'provisioned' 는 보존되고, 그 반대도 성립.
async function writeProvisionMarker(
  projDir: string, projectId: number, repos: ProvisionedRepo[], failed: ProvisionFailure[] = [], pending: ProvisionPending[] = [],
): Promise<void> {
  const file = path.join(projDir, ".lively", "project.json");
  let prev: Record<string, unknown> = {};
  try { prev = JSON.parse(await fsp.readFile(file, "utf8")); } catch { /* 신규/파손 */ }
  const next: Record<string, unknown> = { ...prev, project_id: projectId };
  // 시작 표시(pending)일 땐 provisioned 를 덮지 않는다 — 직전 준비 결과가 남아 있어야 재-provision 중에도
  //  이미 있는 워크트리 정보가 사라지지 않는다(빈 배열로 덮으면 '아무것도 없다'로 오독된다).
  if (!pending.length) next.provisioned = repos.map((r) => ({ name: r.name, path: r.path, worktree: r.worktree, branch: r.branch, cwd: r.cwd, subpath: r.subpath }));
  // repos_failed(#1155)·repos_pending(#1180) — work.mjs 와 **같은 키·같은 스키마**라 세션 프리로드 훅이 그대로 읽는다
  //  (로컬/박스/노드 공통). 해당 상태가 아니면 지운다: 마커는 늘 '지금의 사실'만 말해야 낡은 안내가 남지 않는다.
  if (failed.length) next.repos_failed = failed;
  else delete next.repos_failed;
  if (pending.length) next.repos_pending = pending;
  else delete next.repos_pending;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(next, null, 2) + "\n");
  // 격리 세션(box_)의 마커 갱신(last_pull 등)·원장 생성이 막히지 않게 그룹 rw(#1246).
  await grantSharedGroupWrite(file, projDir, "file");
}
