// ═══════════════════════════════════════════════════════════════════════════
// 워크트리 셀프서비스 코어 (#900) — MCP 툴(lively-mcp-local.mjs)과 CLI(lively.mjs `repo`)가 공유한다.
//  드리프트 0: 두 표면이 이 한 벌의 로직을 각자의 컨텍스트만 주입해 호출한다.
//
//  주입 컨텍스트  ctx = {
//    cwd,                                             // 하네스/사람이 선 작업 디렉터리
//    sh(cmd, args, { allowFail })  → { stdout, stderr, code },  // 로컬 셸(git). allowFail 시 throw 안 함
//    api(path)                     → parsed JSON,     // 게이트웨이 REST GET(Bearer 자동) — 레포 레지스트리 조회
//  }
//
//  규율: base working tree 는 안 건드리고 origin/<ref> 최신에서 워크트리를 분기한다(base RO). 서버측
//   provisionProjectRepos·로컬 work.mjs 의 clone/worktree 와 동형이되 프로젝트에 매이지 않는다.
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
export const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;         // 경로 컴포넌트 — 슬래시·.. 금지(project-provision 과 동일)
export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/; // git 브랜치명(선두 특수문자 금지)

// 이 머신의 base 레포 dir — 박스/워커: <work-root>/repos · 로컬 PC: ~/lively/repos.
//  work-roots(설치가 기록)의 첫 루트를 정본으로, 없으면 ~/lively/repos 폴백. env 로 override.
export function reposDir() {
  if (process.env.LIVELY_REPOS_DIR) return process.env.LIVELY_REPOS_DIR;
  let roots = "";
  try { roots = readFileSync(join(LIVELY, "work-roots"), "utf8"); } catch { /* 없음 */ }
  const first = roots.split("\n").map((s) => s.trim()).filter((l) => l && !l.startsWith("#"))[0];
  return first ? join(first, "repos") : join(HOME, "lively", "repos");
}

// cwd 에서 위로 .lively/project.json 을 찾아 project_id 를 얻는다(있으면 워크트리 브랜치 기본값 project/<id>
//  → 서버 provisionProjectRepos 와 동일 규약). git 의 .git 상향탐색과 동형. 없으면 null(프로젝트 밖 세션).
export function projectIdFromCwd(cwd) {
  let dir = cwd || HOME;
  for (let i = 0; i < 40; i++) {
    try { const m = JSON.parse(readFileSync(join(dir, ".lively", "project.json"), "utf8")); if (m && m.project_id) return m.project_id; } catch { /* 없음 */ }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const isGitRepo = (ctx, p) => existsSync(p) && ctx.sh("git", ["-C", p, "rev-parse", "--git-dir"], { allowFail: true }).code === 0;

// origin 기본 브랜치(main/master 등) — symbolic-ref 우선, 없으면 흔한 후보 확인, 최종 폴백 main.
function remoteDefaultBranch(ctx, base) {
  const sym = ctx.sh("git", ["-C", base, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { allowFail: true }).stdout.trim();
  if (sym) return sym.replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    if (ctx.sh("git", ["-C", base, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${b}`], { allowFail: true }).code === 0) return b;
  }
  return "main";
}

// 워크트리 목표 경로 해석 — 절대경로면 그대로, 상대면 cwd 기준, 미지정이면 cwd/<repo>.
function resolveWtPath(cwd, repo, p) {
  if (!p) return join(cwd, repo);
  return isAbsolute(p) ? p : join(cwd, p);
}

// 이 머신에서 뜰 수 있는 등록 레포 + 로컬 base 상태(clone 여부·브랜치·origin 대비 최신).
export async function repoList(ctx) {
  const reg = await ctx.api("/api/ui/repos");
  const cloneUrl = new Map();
  for (const r of (reg.domainmapRepos || [])) if (r && typeof r.name === "string") cloneUrl.set(r.name, r.clone_url ?? null);
  const names = Array.isArray(reg.repos) && reg.repos.length ? reg.repos : [...cloneUrl.keys()];
  const dir = reposDir();
  const repos = names.map((name) => {
    const base = join(dir, name);
    const cloned = isGitRepo(ctx, base);
    let branch = null, head = null, status = null;
    if (cloned) {
      branch = ctx.sh("git", ["-C", base, "rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).stdout.trim() || null;
      head = ctx.sh("git", ["-C", base, "rev-parse", "--short", "HEAD"], { allowFail: true }).stdout.trim() || null;
      status = (ctx.sh("git", ["-C", base, "status", "-sb"], { allowFail: true }).stdout.split("\n")[0] || "").trim() || null;
    }
    return { name, clone_url: cloneUrl.get(name) ?? null, cloned, base, branch, head, status };
  });
  return { repos_dir: dir, count: repos.length, repos };
}

// base 확보(없으면 clone·있으면 fetch) → cwd(기본)/지정경로에 격리 브랜치 워크트리. base working tree 미변경.
export async function repoWorktree(ctx, args) {
  const repo = String(args.repo || "").trim();
  if (!REPO_NAME_RE.test(repo)) throw new Error(`레포 이름 형식 오류(영숫자.-_): ${repo}`);
  const base = join(reposDir(), repo);

  // ① base 확보 — 없으면 레지스트리 clone_url 로 clone, 있으면 fetch(refs 만; 워킹트리 미변경 = RO 규율).
  if (!isGitRepo(ctx, base)) {
    const reg = await ctx.api("/api/ui/repos");
    const row = (reg.domainmapRepos || []).find((r) => r && r.name === repo);
    const url = row && row.clone_url;
    if (!url) throw new Error(`레포 '${repo}' 가 이 머신에 없고 등록된 clone 주소도 없습니다 — 관리탭 ▸ 레포에서 git 주소를 연결하세요.`);
    mkdirSync(dirname(base), { recursive: true });
    const c = ctx.sh("git", ["clone", url, base], { allowFail: true });
    if (c.code !== 0) throw new Error(`git clone 실패(${repo}): ${(c.stderr || "").trim().split("\n")[0]}`);
  } else {
    ctx.sh("git", ["-C", base, "fetch", "origin"], { allowFail: true }); // best-effort(오프라인 무시)
  }

  // ② 브랜치·ref 결정 — 프로젝트면 project/<id>, ref 지정 시 origin/<ref> 에서 분기.
  const refBranch = args.ref && BRANCH_RE.test(String(args.ref).trim()) ? String(args.ref).trim() : remoteDefaultBranch(ctx, base);
  const pid = projectIdFromCwd(ctx.cwd);
  const branch = (args.branch && String(args.branch).trim()) || (pid ? `project/${pid}` : `wt/${repo}`);
  if (!BRANCH_RE.test(branch)) throw new Error(`브랜치명 형식 오류: ${branch}`);
  const wt = resolveWtPath(ctx.cwd, repo, args.path && String(args.path).trim());

  // 이미 워크트리면 그대로(멱등) — 재실행 안전.
  if (isGitRepo(ctx, wt)) {
    const b = ctx.sh("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).stdout.trim();
    return { repo, worktree: wt, branch: b || branch, base, note: "이미 워크트리가 있어 그대로 사용합니다." };
  }

  // ③ worktree add — 새 브랜치(origin/<ref> 최신 기준) 시도 → 같은 브랜치가 이미 있으면 attach 폴백(provision 동형).
  mkdirSync(dirname(wt), { recursive: true });
  let r = ctx.sh("git", ["-C", base, "worktree", "add", wt, "-b", branch, `origin/${refBranch}`], { allowFail: true });
  if (r.code !== 0) r = ctx.sh("git", ["-C", base, "worktree", "add", wt, branch], { allowFail: true });          // 기존 브랜치 attach
  if (r.code !== 0) r = ctx.sh("git", ["-C", base, "worktree", "add", wt, "-b", branch], { allowFail: true });     // origin/<ref> 없을 때 base HEAD
  if (r.code !== 0) throw new Error(`워크트리 생성 실패(${repo}): ${(r.stderr || "").trim().split("\n")[0]}`);

  return { repo, worktree: wt, branch, base, ref: refBranch,
    note: `이 경로에서 작업하세요: ${wt} · base(${base})는 pristine 공유 원본이라 직접 작업 금지(커밋·빌드는 워크트리에서).` };
}

// lively_*_repo_worktree 로 만든 워크트리 제거(base·다른 워크트리 무영향). 미커밋 변경 있으면 실패(force 로 강제).
export function repoWorktreeRemove(ctx, args) {
  const repo = String(args.repo || "").trim();
  if (!REPO_NAME_RE.test(repo)) throw new Error(`레포 이름 형식 오류(영숫자.-_): ${repo}`);
  const base = join(reposDir(), repo);
  const wt = resolveWtPath(ctx.cwd, repo, args.path && String(args.path).trim());
  const r = ctx.sh("git", ["-C", base, "worktree", "remove", ...(args.force ? ["--force"] : []), wt], { allowFail: true });
  if (r.code !== 0) throw new Error(`워크트리 제거 실패: ${(r.stderr || "").trim().split("\n")[0]}`);
  return { removed: wt };
}
