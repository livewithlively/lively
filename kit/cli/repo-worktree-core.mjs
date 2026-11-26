// ═══════════════════════════════════════════════════════════════════════════
// 워크트리 셀프서비스 코어 (#900) — MCP 툴(lively-mcp-local.mjs)과 CLI(lively.mjs `repo`)가 공유한다.
//  드리프트 0: 두 표면이 이 한 벌의 로직을 각자의 컨텍스트만 주입해 호출한다.
//
//  주입 컨텍스트  ctx = {
//    cwd,                                             // 하네스/사람이 선 작업 디렉터리
//    sh(cmd, args, { allowFail, env, noTty })  → { stdout, stderr, code },  // 로컬 셸(git). allowFail 시 throw 안 함 · env 는 그 호출에만 얹는다
//                                                     // noTty = 사람에게 물을 수 없는 표면(MCP)은 이 호출을 제어 터미널 없이 띄운다(아래 NET)
//    api(path, { method, body, timeoutMs }) → parsed JSON,  // 게이트웨이 REST(Bearer 자동) — 레포 레지스트리 조회 · 내 git 토큰 받기
//  }
//
//  규율: base working tree 는 안 건드리고 origin/<ref> 최신에서 워크트리를 분기한다(base RO). 서버측
//   provisionProjectRepos·로컬 work.mjs 의 clone/worktree 와 동형이되 프로젝트에 매이지 않는다.
//  ⚠ 공유 base 위에서 지켜야 할 셋(#3678, 2026-09-08 사고 — 다른 프로젝트 세션의 admin 이 하루 5회 지워지고 커밋이 남의
//   브랜치에 얹힘): ① `git worktree prune` 을 부르지 않는다(안 보이는 경로 = 남의 컨테이너일 수 있다 → 표적 정리만)
//   ② admin id 를 basename 에 맡기지 않는다(프로젝트별 고유 id 로 relink) ③ 있는 워크트리를 재사용하기 전에 admin 이
//   자기 것인지 확인한다(아니면 중단·경고). 서버 provision·work.mjs·preview-stage 도 ①을 같이 지킨다.
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, rmdirSync, realpathSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname, basename, isAbsolute, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";

const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
export const REPO_NAME_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/; // 경로 컴포넌트 — 슬래시 금지 + 점세그먼트(.·..·…) 거부(traversal 방지, project-provision 과 동일). 이름 속 점(my.repo)은 허용
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

// cwd 에서 위로 `.lively/project.json` 마커를 찾는다 — { dir, file, meta } 또는 null.
//  git 의 `.git` 상향탐색과 동형. **40단계는 리더 전원이 지켜야 하는 계약**이다(pull 훅 2종·project_init·여기).
//  한 곳이라도 깊이가 다르면 "어떤 리더는 프로젝트로 보고 어떤 리더는 아니라고 보는" 폴더가 생긴다.
//  meta 는 마커 전문 — project_id 만이 아니라 sync(공유폴더 쓰기 자격, #905 P1-②)·last_pull·repos 도 들어 있다.
export function findProjectMarkerUp(cwd) {
  let dir = cwd || HOME;
  for (let i = 0; i < 40; i++) {
    const file = join(dir, ".lively", "project.json");
    try {
      const meta = JSON.parse(readFileSync(file, "utf8"));
      if (meta && meta.project_id) return { dir, file, meta };
    } catch { /* 없음/파손 → 계속 위로 */ }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// cwd 의 프로젝트 id(워크트리 브랜치 기본값 project/<id> → 서버 provisionProjectRepos 와 동일 규약).
//  없으면 null(프로젝트 밖 세션). 마커 전문이 필요하면 findProjectMarkerUp 을 직접 써라.
export function projectIdFromCwd(cwd) {
  return findProjectMarkerUp(cwd)?.meta.project_id ?? null;
}

// 마커의 공유폴더 동기화 모드(#905 P1-②) — none=안 받음 | pull=받음 | both=양방향(C3).
//  사람에게 보여주기 위한 읽기 헬퍼. **판정 권위는 pull 훅 자신**이다(오프라인·fail-safe 폴백까지 포함) —
//  여기선 마커에 명시된 값만 그대로 읽고, 없으면 null(= '구 마커, 훅이 폴더 소유권으로 판정')을 돌려준다.
export const FOLDER_SYNC_MODES = ["none", "pull", "both"];
export function markerSyncMode(meta) {
  const m = String((meta && meta.sync) || "").trim().toLowerCase();
  return FOLDER_SYNC_MODES.includes(m) ? m : null;
}

const isGitRepo = (ctx, p) => existsSync(p) && ctx.sh("git", ["-C", p, "rev-parse", "--git-dir"], { allowFail: true }).code === 0;

// ⚠ clone 모드의 대가: push 하지 않은 커밋·stash 는 그 작업면 `.git` 에만 있다 — 폴더를 지우면 함께 사라진다(worktree 는 base 에 남는다).
export const WT_MODES = ["worktree", "clone"];
export function worktreeMode(asked, env = process.env, file = join(LIVELY, "worktree-mode")) {   // export=테스트용
  const pick = (v) => { const m = String(v ?? "").trim().toLowerCase(); return WT_MODES.includes(m) ? m : null; };
  if (asked !== undefined && asked !== null && String(asked).trim()) {
    const m = pick(asked);
    if (!m) throw new Error(`mode 는 ${WT_MODES.join(" | ")} 중 하나입니다: ${asked}`);
    return m;
  }
  const fromEnv = pick(env.LIVELY_WORKTREE_MODE);
  if (fromEnv) return fromEnv;
  try { return pick(readFileSync(file, "utf8")) || "worktree"; } catch { return "worktree"; }
}
const baseObjectsOf = (base) => join(base, ".git", "objects");
// alternates 가 이 base 를 가리키는 clone 의 `.git`(소유 스탬프 자리), 아니면 null. 누구 것인지는 스탬프가 따로 판정한다.
function cloneGitDirOf(wt, base) {
  const dir = gitfileOf(wt);
  try { if (!statSync(dir).isDirectory()) return null; } catch { return null; }
  let alt; try { alt = readFileSync(join(dir, "objects", "info", "alternates"), "utf8"); } catch { return null; }
  const want = baseObjectsOf(base);
  return alt.split("\n").some((l) => l.trim() && samePath(l.trim(), want)) ? dir : null;
}
const UNBORN_HEAD = "refs/heads/lively-clone-unborn";   // 받아 올 브랜치와 이름이 겹치지 않는 임시 HEAD
// 네트워크를 다시 타지 않는다 — ensureBase 가 방금 받은 base 의 origin/* 를 옮겨 오고, 객체는 alternates 로 이미 있어 ref 만 쓴다.
//  옆 임시 폴더에서 끝까지 만든 뒤 rename 으로 올린다. 도중에 죽거나 실패해도 wt 에는 반쯤 만든 자리가 남지 않고,
//  같은 자리를 동시에 만들던 다른 호출의 결과를 지우지 않는다(rename 이 비어 있지 않은 목적지를 거부한다).
function cloneFromBase(ctx, base, wt, branch, refBranch) {
  const existed = existsSync(wt);
  if (existed && !statSync(wt).isDirectory()) throw new Error(`워크트리 생성 실패: '${wt}' 가 디렉터리가 아닌 파일로 이미 있습니다.`);
  if (existed && readdirSync(wt).length) throw new Error(`워크트리 생성 실패: '${wt}' 가 이미 있고 비어 있지 않습니다.`);
  const tmp = join(dirname(wt), `.${basename(wt)}.lively-tmp-${process.pid}-${Date.now().toString(36)}`);
  const g = (args) => ctx.sh("git", ["-C", tmp, ...args], { allowFail: true });
  const has = (ref) => g(["show-ref", "--verify", "--quiet", ref]).code === 0;
  const objects = baseObjectsOf(base);
  const steps = () => {
    let r = ctx.sh("git", ["init", "-q", tmp], { allowFail: true });
    if (r.code !== 0) return r;
    writeFileSync(join(tmp, ".git", "objects", "info", "alternates"), `${process.platform === "win32" ? objects.replace(/\\/g, "/") : objects}\n`);
    r = g(["symbolic-ref", "HEAD", UNBORN_HEAD]);
    if (r.code !== 0) return r;
    const url = ctx.sh("git", ["-C", base, "remote", "get-url", "origin"], { allowFail: true }).stdout.trim();
    if (url) { r = g(["remote", "add", "origin", url]); if (r.code !== 0) return r; }
    const local = ctx.sh("git", ["-C", base, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true }).code === 0;
    r = g(["-c", "core.logAllRefUpdates=false", "fetch", "-q", "--no-tags", base, "+refs/remotes/origin/*:refs/remotes/origin/*",
      ...(local ? [`+refs/heads/${branch}:refs/heads/${branch}`] : [])]);
    if (r.code !== 0) return r;
    // refspec 은 base 의 symref origin/HEAD 를 값으로 풀어 옮긴다 — 그대로 두면 생성 시점 커밋에 굳는다.
    const originHead = ctx.sh("git", ["-C", base, "symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { allowFail: true }).stdout.trim();
    if (originHead && has(originHead)) g(["symbolic-ref", "refs/remotes/origin/HEAD", originHead]);
    else g(["update-ref", "-d", "refs/remotes/origin/HEAD"]);
    const tracked = has(`refs/remotes/origin/${branch}`);
    if (local) {
      // base 의 로컬 브랜치는 base 가 fetch 만 하므로 원격보다 뒤처져 있기 쉽다 — 뒤처지기만 했으면 원격 쪽을 쓴다.
      if (tracked && g(["merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/remotes/origin/${branch}`]).code === 0) {
        r = g(["update-ref", `refs/heads/${branch}`, `refs/remotes/origin/${branch}`]);
        if (r.code !== 0) return r;
      }
      r = g(["checkout", "-q", branch]);
      if (r.code === 0 && tracked) g(["branch", "-q", "--set-upstream-to", `origin/${branch}`, branch]);
      return { ...r, from: "existing" };
    }
    if (tracked) return { ...g(["checkout", "-q", "-b", branch, "--track", `origin/${branch}`]), from: "existing" };
    if (has(`refs/remotes/origin/${refBranch}`)) return { ...g(["checkout", "-q", "-b", branch, `origin/${refBranch}`]), from: "ref" };
    r = g(["fetch", "-q", "--no-tags", base, "HEAD"]);
    return r.code !== 0 ? r : { ...g(["checkout", "-q", "-b", branch, "FETCH_HEAD"]), from: "base-head" };
  };
  let r;
  try { r = steps(); } catch (e) { r = { code: 1, stderr: String(e && e.message || e) }; }
  if (r.code === 0) {
    try {
      try { renameSync(tmp, wt); }
      catch (e) {
        if (!existed) throw e;
        rmdirSync(wt);              // 빈 목적지 디렉터리 위로의 rename 을 거부하는 플랫폼(윈도우) — 비어 있지 않으면 여기서 실패한다
        renameSync(tmp, wt);
      }
      return { from: r.from };
    } catch (e) { r = { code: 1, stderr: `'${wt}' 로 옮기지 못했습니다: ${e.message}` }; }
  }
  rmSync(tmp, { recursive: true, force: true });
  throw new Error(`워크트리 생성 실패(clone 모드): ${gitFail(r.stderr)}`);
}

// 경로 정규화(비교용) — 있으면 realpath(macOS /var→/private/var · 윈도우 8.3/대소문자), 없으면 **가장 가까운 있는 조상**을
//  realpath 하고 나머지를 붙인다. git 은 등록 경로를 realpath 로 저장하므로, 아직 없는 목표 경로도 같은 표기로 견줘야
//  «내 목표 경로의 등록」을 알아본다(안 그러면 macOS 에서 /var 와 /private/var 가 남남이 돼 스테일 등록을 못 찾는다).
export function normPath(p) {                       // export=테스트용·순수
  let cur = resolve(p);
  const tail = [];
  for (let i = 0; i < 64; i++) {
    let real = null;
    try { real = realpathSync.native(cur); } catch { /* 없음 → 한 단계 위로 */ }
    if (real !== null) { tail.reverse(); return join(real, ...tail); }
    const up = dirname(cur);
    if (up === cur) break;
    tail.push(basename(cur));
    cur = up;
  }
  return resolve(p);
}
const samePath = (a, b) => normPath(a) === normPath(b);

// 이 base 의 워크트리 등록 목록(base 자신 제외) → [{ path, branch|null, locked }].
//  `git worktree list --porcelain` 은 디렉터리가 사라진 등록도 경로 그대로 보여준다. locked = 사람이 `worktree lock` 으로
//  지킨 것(이동식 디스크 등) — 표적 정리에서도 건드리지 않는다(git 도 -f 두 번을 요구한다).
function listWorktrees(ctx, base) {
  const out = ctx.sh("git", ["-C", base, "worktree", "list", "--porcelain"], { allowFail: true }).stdout || "";
  const list = [];
  let cur = null;
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) { cur = { path: line.slice("worktree ".length), branch: null, locked: false }; list.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith("branch refs/heads/")) cur.branch = line.slice("branch refs/heads/".length);
    else if (line.startsWith("locked")) cur.locked = true;
  }
  return list.filter((w) => !samePath(w.path, base));
}

// «지워졌다» 와 «안 보인다» 를 가르는 유일한 근거 — 경로는 없는데 **부모 디렉터리는 있다**(#3678).
//  세션 컨테이너는 남의 프로젝트 폴더를 통째로 못 보므로, 부모까지 없으면 «다른 컨테이너에서 살아 있는 워크트리» 일 수
//  있어 손대지 않는다. 부모가 보이는데 그 안에 없으면 정말 지워진 것이다(스크래치패드 청소·rm -rf).
export const provablyGone = (p) => !existsSync(p) && existsSync(dirname(p));   // export=테스트용·순수

// 표적 정리 — blanket `git worktree prune` 의 대체(#3678). 지우는 건 «목표 경로들의 등록 ∪ 목표 브랜치를 쥔 등록» 중
//  provablyGone 인 것뿐이다. 그 밖의 등록(남의 컨테이너 것일 수 있는 «안 보이는» 등록 포함)은 절대 건드리지 않는다.
//  ⚠ 왜 prune 을 버렸나: `git worktree prune` 은 이 프로세스에서 안 보이는 경로를 전부 «없다» 로 판정해 admin 을 지운다.
//   세션 컨테이너는 자기 프로젝트만 마운트하므로 **다른 프로젝트 세션이 뜬 워크트리의 admin 이 통째로 날아갔고**(하루 5회
//   실측, 2026-09-08), 그 뒤 같은 basename 으로 다시 뜬 admin 을 두 워크트리가 같이 가리켜 HEAD·index 를 공유했다 — 내
//   커밋이 남의 브랜치에 얹히고, index 재구성 뒤 커밋이 main 의 남의 수정을 조용히 되돌렸다. #932 가 prune 으로 풀려던
//   것(사라진 워크트리의 등록이 브랜치를 영구 점유)은 아래 표적 정리가 그대로 푼다 — 그 등록만 `worktree remove --force`.
//  `worktree remove --force` 가 없는 경로의 등록을 걷는 건 git ≥ 2.17(2018) — 고객 박스 최저 2.34 에서 성립.
function clearStaleRegistrations(ctx, base, { paths = [], branch = null } = {}, regs = listWorktrees(ctx, base)) {
  const removed = [];
  for (const w of regs) {
    const target = paths.some((p) => p && samePath(p, w.path)) || (branch !== null && w.branch === branch);
    if (!target || w.locked || !provablyGone(w.path)) continue;
    const r = ctx.sh("git", ["-C", base, "worktree", "remove", "--force", w.path], { allowFail: true });
    if (r.code === 0) removed.push(w.path);
  }
  return removed;
}

// 등록들이 **점유 중인** 브랜치 → 그 워크트리 경로. git 은 한 브랜치를 두 워크트리에 못 건다.
function checkedOutBranches(regs) {
  const map = new Map();
  for (const w of regs) if (w.branch) map.set(w.branch, w.path);
  return map;
}

// 점유되지 않은 첫 이름 — want, want-2, want-3 … canonical 슬롯 밖 워크트리끼리도 안 겹치게(#932).
function freeBranch(taken, want) {
  if (!taken.has(want)) return want;
  for (let i = 2; i <= 99; i++) if (!taken.has(`${want}-${i}`)) return `${want}-${i}`;
  throw new Error(`쓸 수 있는 브랜치 이름이 없습니다(${want}, ${want}-2..99 전부 다른 워크트리가 점유 중) — branch 인자로 직접 지정하세요.`);
}

// ── 워크트리 소유(#3678 후속) — 브랜치에만 있던 규율을 **경로에도** 준다 ────────────────────────────────
// 재사용 판정에 소유자가 없었다: verifyOwnAdmin 은 git 배관(gitfile ↔ admin 상호참조)만 보므로, 배관이 멀쩡한
//  **다른 세션의 워크트리**는 그대로 통과해 "이미 워크트리가 있어 그대로 사용합니다" 로 돌아갔다. 그 자리에서
//  편집·커밋하면 남의 브랜치 위에 얹힌다. 이름은 freeBranch 로 비켜 가면서 자리는 안 비켜 가던 비대칭이 사고의
//  본체다 — 아래 세 조각(신원·스탬프·freeSlot)이 그 비대칭을 없앤다.

// 이 실행 세션의 신원 — 훅의 executionSessionId(kit/hooks/run-custom.mjs)와 **같은 규약**이다(한쪽만 바꾸면 같은
//  세션이 훅과 툴에서 다른 이름을 갖는다). 로컬 MCP 서버는 세션당 하나가 스폰되어 하네스 env 를 상속하므로 이
//  값이 곧 «이 세션» 이다. 훅과 다른 점은 CLAUDE_CODE_SESSION_ID 하나 — 훅은 stdin 의 session_id 로 받지만 MCP
//  서버엔 그 입구가 없고, Claude Code 가 자식 프로세스에 싣는 이름이 이것이다(실측 2026-09-18: 동시 생존 중인
//  mcp-local 프로세스들이 서로 다른 값을 갖고 있었다). 신원이 없으면 null — 그 땐 소유 판정을 하지 않는다(종전 동작).
//  ⚠ 이 값이 세션 재개(--resume 등)에서 유지되는지는 하네스에 달려 있고 여기서 보장하지 않는다. 안 유지되면 재개한
//   세션이 자기 어제 자리를 «주인 있는 남의 자리» 로 보고 옆자리를 판다 — 손실은 없고(작업은 그 자리에 그대로 있다)
//   대가는 디렉터리 하나다. 되찾으려면 그 자리를 path 로 지목해 쓰면 된다(남의 스탬프는 덮지 않으니 경고가 뜬다).
//  순서는 MCP 프록시의 x-lively-session(lively-mcp-gateway.mjs sessionHeaderValue)과 같다 — CLAUDE_CODE_SESSION_ID 가
//   CLAUDE_SESSION_ID 보다 먼저(셸에 남은 옛 값이 이기면 그 셸에서 뜬 세션 전부가 한 신원이 되어 소유 판정이 무너진다),
//   네이티브 id 는 띄운 하네스(LIVELY_HARNESS stamp, 없으면 claude) 것부터 — 코덱스가 셸로 띄운 claude 는 부모의
//   CODEX_THREAD_ID 를 상속하므로 codex 를 고정으로 먼저 보면 같은 코덱스 스레드에서 띄운 claude 들이 한 신원이 된다.
export function sessionKey(env = process.env) {   // export=테스트용·순수
  const direct = String(env.LIVELY_SESSION_ID || "").trim();
  if (direct) return direct;
  const codex = String(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || "").trim();
  const claude = String(env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || "").trim();
  const native = String(env.LIVELY_HARNESS || "").trim().toLowerCase() === "codex"
    ? [["codex", codex], ["claude", claude]]
    : [["claude", claude], ["codex", codex]];
  const hit = native.find(([, id]) => id);
  return hit ? `${hit[0]}-${hit[1]}` : null;
}

// 스탬프는 워킹트리가 아니라 **admin 디렉터리**에 둔다. 워킹트리에 두면 untracked 파일이 되어 `git add -A` 에
//  딸려 들어가고 status 를 더럽힌다. admin 은 git 이 워크트리를 지울 때 함께 지우고 relinkAdmin 의 rename 도 따라오니
//  수명이 정확히 워크트리와 같다 — 고아 스탬프가 남지 않는다.
const ownerFileOf = (admin) => join(admin, "lively-owner.json");
// 반환 셋을 가른다: 스탬프 객체 | null(«표시가 없다» = ENOENT) | false(«있는데 못 읽는다» — 손상·부분 쓰기·지금 쓰는 중).
//  뭉개면 안 되는 이유: 아래 입양은 «표시가 없다» 일 때만 해야 한다. 못 읽는 것까지 «없다» 로 보면 남의 세션이 스탬프를
//  쓰는 중인 찰나에 다른 세션이 그 자리를 지목해 소유를 가져간다 — 이 모듈이 막으려는 바로 그 일이 좁은 창으로 되돌아온다.
function readOwner(admin) {
  if (!admin) return null;
  let txt;
  try { txt = readFileSync(ownerFileOf(admin), "utf8"); }
  catch (e) { return e && e.code === "ENOENT" ? null : false; }
  try { const o = JSON.parse(txt); return o && typeof o === "object" ? o : false; } catch { return false; }
}
// best-effort — 쓰기에 실패해도 워크트리는 멀쩡하다. 실패의 대가는 «다음 호출이 이 자리를 남의 것으로 보고 비켜선다»
//  뿐이라(유실 0) 예외를 올리지 않는다. 대신 성공 여부를 돌려 호출부가 안내에 실을 수 있게 한다.
//  ⚠ 주인이 없는 스탬프(session·project_id 둘 다 null — 신원 없는 호출)는 쓰지 않는다. 쓰면 ① 신원 없는 재사용이
//   남의 스탬프를 «주인 없음» 으로 덮어 원래 세션이 제 자리에서 밀려나고 ② 신원 없이 만든 자리가 «다른 세션 것» 으로
//   읽혀(표시는 있는데 이름이 없다) 입양도 안 되는 사석이 된다. 표시가 없어야 «주인 불명» 으로 읽혀 지목 입양이 된다.
function writeOwner(admin, data) {
  if (!admin) return false;
  if (!data.session && (data.project_id === null || data.project_id === undefined)) return false;
  try { writeFileSync(ownerFileOf(admin), JSON.stringify({ ...data, stamped_at: new Date().toISOString() }, null, 2)); return true; }
  catch { return false; }
}
// «내 자리인가». 판정 축이 두 개인 이유: canonical 슬롯은 **프로젝트 공용**(서버 provisionProjectRepos 와 멱등해야
//  하므로 같은 프로젝트의 다른 세션이 써도 정상)이고, 슬롯 밖 기본 자리는 **세션 전용**이다.
//  스탬프가 없으면(이 변경 이전에 뜬 워크트리·쓰기 실패) «모른다» → 내 것이 아닌 쪽으로 판정한다: 모르는 자리를
//  물어 커밋이 섞이는 쪽보다, 옆에 새 자리를 파는 쪽이 싸다(유실 0, 대가는 디렉터리 하나).
function isMine(stamp, { pid, me, isSlot }) {
  if (isSlot) return true;
  // 신원 축이 아예 없는 호출(하네스 밖 맨 터미널의 `lively repo worktree` — 세션 id 도 프로젝트도 없다)은 **종전대로**
  //  재사용한다. 여기서 «모르니 비켜선다» 로 가면 같은 명령을 두 번 친 사람이 매번 새 자리를 파게 된다(foo, foo-2 …).
  //  비켜서기는 «내가 누구인지 아는데 이 자리는 내가 아니다» 일 때만 의미가 있다.
  if (!me && (pid === null || pid === undefined)) return true;
  if (!stamp) return false;
  if (pid !== null && pid !== undefined && stamp.project_id === pid) return true;
  return Boolean(me) && stamp.session === me;
}
// 이 툴이 만든 작업면의 스탬프 자리 — clone 이면 그 `.git`, worktree 면 배관이 온전한 admin. 그 밖은 null.
function ownerDirOf(wt, base) {
  const cloned = cloneGitDirOf(wt, base);
  if (cloned) return cloned;
  const admin = adminOf(wt);
  if (!admin || !existsSync(admin)) return null;
  const back = adminBackref(admin);
  return back && samePath(back, gitfileOf(wt)) ? admin : null;
}
// 이 자리를 지금 쓸 수 있나 — "free" | "mine" | "other"(다른 세션 것) | "unowned"(주인을 알 수 없는 자리).
//  왜 other 와 unowned 를 가르나: **비켜서는 행동은 같아도 사람에게 할 말이 다르다.** 주인을 모르는 자리는
//  ① 이 변경 이전에 뜬 워크트리 ② `.git` 이 디렉터리인 자리(사람이 손으로 clone 한 폴더 — 이 툴의 워크트리가 아니다)
//  ③ 배관이 파손된 자리(#3678 사고 상태)다. 셋 다 "다른 세션이 쓰는 중" 이 아닌데 그렇게 안내하면 거짓말이 된다.
//  워크트리가 아닌데 디렉터리만 있는 경우는 free 로 본다(종전과 같이 git 의 add 가 판정하게 둔다 — 비어 있으면 성공,
//  아니면 git 이 거부한다).
function slotStatus(ctx, wt, who, base) {
  if (!existsSync(gitfileOf(wt)) && !isGitRepo(ctx, wt)) return "free";
  const admin = ownerDirOf(wt, base);
  if (!admin) return "unowned";
  const stamp = readOwner(admin);
  if (isMine(stamp, who)) return "mine";
  return stamp ? "other" : "unowned";
}
// 비켜선 이유를 사람 말로 — 자리마다 사유가 다르므로 note 도 달라야 한다.
const asideReason = (why) => (why === "other"
  ? "다른 세션이 쓰고 있어"
  : "이 툴이 만든 자리가 아니거나 주인 표시가 없어");
// 쓸 수 있는 첫 자리 — <dir>/<repo>, <dir>/<repo>-2 … freeBranch 와 같은 규율을 경로에 적용한 것이다.
//  ⚠ 여기서 고른 자리를 ⑤ 가 잡기 전에 다른 세션이 먼저 잡는 창이 있다(TOCTOU). 그 땐 자동으로 다시 고르지 않고
//   git 의 실패를 그대로 올린다 — 조용한 공유가 아니라 시끄러운 실패이고(안전측), 호출자가 한 번 더 부르면 그 땐
//   상대의 스탬프가 보여 비켜선다. 그 자리에서 재시도를 돌리는 건 창이 ms 단위라 값에 비해 흐름만 복잡해진다.
//  상한이 9 인 이유(브랜치는 99): 자리는 디스크를 먹고, 10개가 찼다면 그건 배정 문제가 아니라 청소 문제다 —
//  조용히 100번째를 파는 것보다 여기서 멈추고 사람에게 알리는 편이 낫다.
function freeSlot(ctx, want, who, base) {
  const taken = [];
  for (let i = 1; i <= 9; i++) {
    const at = i === 1 ? want : `${want}-${i}`;
    const st = slotStatus(ctx, at, who, base);
    if (st === "free" || st === "mine") return { path: at, why: i === 1 ? null : taken[0].why };
    taken.push({ at, why: st, stamp: readOwner(ownerDirOf(at, base) ?? adminOf(at)) });
  }
  // 막다른 길에 두지 않는다 — 어느 자리가 누구 것인지까지 적는다(스탬프가 이미 그 정보를 갖고 있는데
  //  안 보여주면 사람이 admin 의 json 을 아홉 번 열어 봐야 한다).
  const who_ = taken.map((t) => `  ${t.at} — ${t.why === "other" ? `세션 ${t.stamp?.session ?? "?"}` : "주인 불명"}`
    + `${t.stamp?.branch ? ` [${t.stamp.branch}]` : ""}${t.stamp?.stamped_at ? ` (${t.stamp.stamped_at})` : ""}`).join("\n");
  throw new Error(`쓸 수 있는 워크트리 자리가 없습니다(${want}, ${want}-2..9 가 전부 차 있습니다):\n${who_}\n`
    + `다 쓴 워크트리를 lively_local_repo_worktree_remove(CLI: lively repo worktree remove)로 정리하거나 path 인자로 자리를 직접 지정하세요.`);
}

// git 실패 한 줄 요약 — git 은 진행 메시지("Preparing worktree …")도 **stderr 에** 쓰므로 첫 줄이 곧 원인이 아니다
//  (그래서 예전 메시지는 실패를 "Preparing worktree …" 로 보여줬다 — 원인이 안 보이고 준비 중처럼 읽혔다, #932).
//  fatal:/error: 줄을 우선 집고, 없으면 마지막 비어있지 않은 줄(보통 그게 원인).
function gitFail(stderr) {
  const lines = (stderr || "").split("\n").map((s) => s.trim()).filter(Boolean);
  return lines.find((l) => /^(fatal|error):/i.test(l)) || lines[lines.length - 1] || "(원인 미상)";
}

// 인증 실패 안내(#1077) — git 은 'Permission denied (publickey)' / 'could not read Username' 까지만 말하고
//  **그걸 어떻게 푸는지**는 말해주지 않는다. 그래서 실패 그 자리에서 정규 경로를 알려준다.
//  정규 경로는 **주소의 종류와 자리**에 따라 다르다:
//   · https 주소 — 어디서나 «라이블리에 등록한 내 HTTPS 토큰» 이 정규 경로다. 박스에서는 게이트웨이가 홈에 내려 두고
//     (git-credential-materialize.ts), 그 밖(내 PC)에서는 이 도구가 git 을 띄울 때 받아 온다(아래 leaseFor). 안내는
//     «받아 오기가 어떻게 끝났나»(lease.state)로 고른다 — 등록이 없는지 · 등록한 토큰이 거절됐는지 · 받아 오지 못했는지.
//   · ssh 주소 + 라이블리 박스 — 자격을 DB 에 두고 게이트웨이가 홈에 materialize 한다(me_git_credential_set {kind:"ssh"}).
//     셸 ssh-keygen 우회는 되긴 하지만 관리탭 가시성·오프보딩 회수·재프로비저닝 복원에서 전부 빠지므로 말린다.
//   · ssh 주소 + 내 PC — SSH 개인키는 박스 밖으로 나오지 않는다. 여기서 me_git_credential_set {kind:"ssh"} 를 안내하면
//     막다른 길이다(신규 입사 온보딩에서 실제로 그 안내를 따르다 막혔다). 이 컴퓨터의 ssh 키를 쓴다.
//  ⚠ 판정은 stderr 문자열이라 느슨하다(호스트마다 문구가 다르다). 오탐해도 손해는 안내 한 줄이라 넓게 잡는다.
//  «terminal prompts disabled» = 자격이 없어 git 이 물으려다 멈춘 것(GIT_TERMINAL_PROMPT=0) · «returned error: 401|403» = 토큰이 거절된 것.
const AUTH_FAIL_RE = /permission denied|could not read (?:username|password)|terminal prompts disabled|authentication failed|access denied|repository not found|invalid username or token|returned error: 40[13]/i;
//  처음 붙는 ssh 호스트 — ssh 는 지문을 **제어 터미널(/dev/tty)에 직접** 묻는다(GIT_TERMINAL_PROMPT 가 닿지 않는다). 제어 터미널이
//   없으면 물을 수 없어 그대로 실패한다 — MCP 는 원격에 닿는 git 을 그렇게 띄운다(noTty). 사람이 부른 CLI 에서는 ssh 가 묻는다.
const HOSTKEY_FAIL_RE = /host key verification failed|no \S*\s*host key is known/i;
//  저장된 호스트키와 다른 키 — ssh 는 같은 «verification failed» 로 끝나지만 묻지도 않고, «처음 붙는 호스트» 로 안내하면
//  서버 키 교체·중간자를 일상 절차 뒤에 숨긴다. 먼저 가른다.
const HOSTKEY_CHANGED_RE = /remote host identification has changed|offending \S+ key in/i;
export function gitHostOf(url) {          // export=테스트용·순수
  const s = String(url || "");
  const scp = s.match(/^[^/]+@([^:]+):/);                 // scp 형 git@host:path
  if (scp) return scp[1];
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)/i); // scheme://[user@]host
  return m ? m[1] : "";
}
// ssh 로 붙는 주소면 { user, host, port }, 아니면 null(https 등). user 기본 git — GitHub·GitLab 관례. (export=테스트용·순수)
export function sshTargetOf(url) {
  const s = String(url || "");
  //  scp 형 [user@]host:path — git 규칙대로 첫 ':' 앞에 '/' 가 없을 때만. 한 글자 host 는 윈도우 드라이브(C:/…)다.
  const scp = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? null : s.match(/^(?:([^@/:]+)@)?([^/:@]+):/);
  if (scp && scp[2].length > 1) return safeTarget({ user: scp[1] || "git", host: scp[2], port: null });
  const m = s.match(/^(?:git\+)?ssh:\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?(?:\/|$)/i);
  return m ? safeTarget({ user: m[1] || "git", host: m[2], port: m[3] || null }) : null;
}
//  user · host 는 ssh argv 로 넘어가고 복붙 명령으로도 찍힌다 — 이름 글자만 받는다('-' 로 시작하면 ssh 옵션이 된다).
//  안내 문구(authNote)에 넣는 호스트도 이 규칙 하나로 거른다.
const SSH_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const isSshName = (s) => typeof s === "string" && SSH_NAME_RE.test(s);
const safeTarget = (t) => (isSshName(t.user) && isSshName(t.host) ? t : null);
const sshProbeCmd = (t) => `ssh -T ${t.port ? `-p ${t.port} ` : ""}${t.user}@${t.host}`;
//  바뀐 호스트키를 지우는 명령 — OpenSSH 는 22 가 아닌 포트를 known_hosts 에 `[host]:port` 로 적는다. 이름만 주면 그 줄이 안 지워져
//  안내대로 해도 계속 막힌다. 대괄호는 셸 글롭 문자라 따옴표로 감싼다.
const sshForgetCmd = (t) => (t.port && Number(t.port) !== 22 ? `ssh-keygen -R "[${t.host}]:${Number(t.port)}"` : `ssh-keygen -R ${t.host}`);
//  안내에 쓰는 호스트 — ssh 주소면 sshTargetOf 가 거른 값, 아니면 주소의 호스트를 같은 이름 규칙으로 거른 값. 못 통과하면 "".
//  원문으로 되돌아가면 `ssh -T git@-oProxyCommand=x` 같은 복붙 명령이 나간다(PR #1734 리뷰 실측).
function noteHostOf(url) {
  const raw = gitHostOf(url);
  return sshTargetOf(url)?.host || (isSshName(raw) ? raw : "");
}

// 이 컴퓨터가 라이블리 박스인가 — 게이트웨이가 그 호스트 자격을 이 홈에 내려 줬으면(materialize 산출물) 박스다.
//  내려 준 게 없으면 OS 로 가른다: 격리 박스는 Linux 전용이라(git-credential-materialize.ts) macOS·Windows 는 내 PC 다.
//  Linux 인데 내려 준 게 없으면(자격 미등록 박스 · 리눅스 PC) 가를 수 없다 → "unknown" — 안내가 두 길을 다 적는다.
//  파일 이름 규칙은 materialize 쪽 safeHost 와 같아야 한다(영숫자 밖은 '_'). (export=테스트용)
export function gitAuthPlace(host, { platform = process.platform, home = homedir(), exists = existsSync } = {}) {
  const h = String(host || "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (h && exists(join(home, ".ssh", `id_lively_${h}`))) return "box";
  if (exists(join(home, ".lively", "git-credentials"))) return "box";
  return platform === "linux" ? "unknown" : "pc";
}

const isHttpUrl = (url) => /^https?:\/\//i.test(String(url || "").trim());
//  https 주소의 안내 — lease = 내 토큰 받아 오기가 어떻게 끝났나({ state, why } | null). null 은 «물어보지 않았다»(옛 호출 · 시험).
function httpsAuthNote(h, host, lease) {
  const set = (tok) => `\`me_git_credential_set {kind:"https"${host ? `, host:"${host}"` : ""}, token:"${tok}"}\``;
  const where = `(웹은 [내 설정 ▸ 레포 접근 ▸ git 인증 관리])`;
  const helper = ` 이 컴퓨터의 git 자격을 쓰려면 ${h} 개인 액세스 토큰을 git credential helper(macOS 는 키체인)에 저장하세요.`;
  const state = lease && lease.state;
  if (state === "used-failed") {
    return ` — 라이블리에 등록한 내 ${h} 토큰으로 인증하지 못했습니다(만료됐거나 이 레포를 읽을 권한이 없는 토큰). 이 컴퓨터의 git 자격으로도 되지 않았습니다.`
      + ` ${set("<새 토큰>")} 로 다시 등록하세요${where}.`;
  }
  if (state === "ssh-credential") {
    return ` — 라이블리에 등록한 내 ${h} 자격이 SSH 키인데 이 레포는 https 주소라 그 키로는 받을 수 없습니다.`
      + ` ${set("<개인 액세스 토큰>")} 로 HTTPS 토큰을 등록하면${where} git 을 따로 설정하지 않아도 받습니다`
      + ` — ⚠ 같은 호스트에 등록해 둔 SSH 키는 토큰으로 바뀝니다.`;
  }
  if (state === "unsupported") {
    return ` — 이 컴퓨터의 git 자격으로 ${h} 에 인증하지 못했습니다. 이 게이트웨이는 라이블리에 등록한 토큰을 로컬 도구에 내려 주지 않는 옛 판입니다(게이트웨이 업데이트 필요).${helper}`;
  }
  if (state === "unavailable") {
    return ` — 이 컴퓨터의 git 자격으로 ${h} 에 인증하지 못했고, 라이블리에 등록한 내 토큰도 받아 오지 못했습니다${lease.why ? `(${lease.why})` : ""}.`
      + ` 잠시 뒤 다시 하세요.${helper}`;
  }
  if (state === "host-mismatch") {
    return ` — 이 컴퓨터에 받아 둔 레포의 원격 주소(${h})가 라이블리에 등록된 주소와 달라(호스트 · http/https · 포트), 등록한 토큰을 쓰지 않았습니다.${helper}`;
  }
  //  등록한 토큰이 없다(no-credential) · 물어보지 않았다(null) — 등록이 정규 경로이고, 이 컴퓨터의 git 자격은 대안이다.
  return ` — 라이블리에 등록한 내 ${h} 토큰이 없고 이 컴퓨터의 git 자격으로도 인증하지 못했습니다.`
    + ` ${set("<개인 액세스 토큰>")} 로 등록하면${where} git 을 따로 설정하지 않아도 받습니다.`
    + ` 또는 ${h} 개인 액세스 토큰을 이 컴퓨터의 git credential helper(macOS 는 키체인)에 저장해도 됩니다.`;
}

export function authNote(stderr, url, place = gitAuthPlace(noteHostOf(url)), lease = null) {   // export=테스트용·순수(place 를 주면)
  const ssh = sshTargetOf(url);
  const host = noteHostOf(url);
  const h = host || "그 호스트";
  //  명령 예시의 대상 — ssh 주소면 그 주소(포트 포함), 아니면 거른 호스트에 기본값(git 사용자·22 번). 호스트를 모르면 명령을 안 준다.
  const target = ssh || (host ? { user: "git", host, port: null } : null);
  if (HOSTKEY_CHANGED_RE.test(stderr || "")) {
    return ` — ${h} 의 ssh 호스트키가 이 컴퓨터에 저장된 키와 다릅니다. 서버 키 교체이거나 중간자일 수 있습니다.`
      + ` ${h} 관리자에게 키 교체 여부를 확인한 뒤에만 ${target ? `\`${sshForgetCmd(target)}\` 로` : "~/.ssh/known_hosts 에서"} 옛 키를 지우고 다시 붙으세요.`;
  }
  if (HOSTKEY_FAIL_RE.test(stderr || "")) {
    return ` — 이 컴퓨터가 ${h} 의 ssh 호스트키를 아직 모릅니다(~/.ssh/known_hosts 에 없음). git 은 여기서 지문 확인을 물을 수 없어 멈췄습니다.`
      + ` 터미널에서 ${target ? `\`${sshProbeCmd(target)}\` 를 한 번 실행해` : "그 호스트에 ssh 로 한 번 접속해"} 지문을 ${h} 관리자가 알려 준 값과 대조하고 yes 로 받아 두면 됩니다.`;
  }
  if (!AUTH_FAIL_RE.test(stderr || "")) return "";
  //  https 주소 — 등록한 HTTPS 토큰이 어디서나 정규 경로다(박스는 홈에 내려 둔 것 · 그 밖은 이 도구가 받아 온 것).
  if (isHttpUrl(url)) return httpsAuthNote(h, host, lease);
  const box = ` \`me_git_credential_set {kind:"ssh"${host ? `, host:"${host}"` : ""}}\` 로 등록하면(웹은 [내 설정 ▸ 레포 접근 ▸ git 인증 관리])`
    + ` 공개키가 나옵니다 — 그 공개키를 ${h} 계정에 등록하면 바로 됩니다.`
    + ` (셸에서 ssh-keygen 으로 직접 만들지 마세요 — 그 키는 라이블리가 모르니 회수·복원이 안 됩니다.)`;
  const pc = ` 이 컴퓨터의 ssh 키를 씁니다 — 키가 없으면 \`ssh-keygen -t ed25519\` 로 만들고, 공개키(~/.ssh/id_ed25519.pub)를 ${h} 계정의 SSH 키에 등록한 뒤 ${ssh ? `\`${sshProbeCmd(ssh)}\` 로` : "ssh 접속으로"} 확인하세요.`
    + ` 이미 등록했는데도 거부되면 키에 암호가 걸려 ssh-agent 에 안 올라간 것입니다 — \`ssh-add\`(macOS 는 \`ssh-add --apple-use-keychain\`).`;
  const pcWhy = `내 PC 에서는 라이블리에 등록한 SSH 키를 쓸 수 없습니다(me_git_credential_set {kind:"ssh"} 는 라이블리 박스 세션 전용 — 개인키가 박스 밖으로 나오지 않습니다).`;
  if (place === "box") return ` — 이 계정에 ${h} git 자격이 없어 보입니다.${box}`;
  if (place === "pc") return ` — 이 컴퓨터의 git 자격으로 ${h} 에 인증하지 못했습니다. ${pcWhy}${pc}`;
  return ` — 이 계정에 ${h} git 자격이 없어 보입니다. 라이블리 박스 세션이면${box} 내 PC 라면 ${pcWhy}${pc}`;
}

// ssh -T 시험 접속 결과 판정(lively doctor) — "ok" | "hostkey" | "hostkey-changed" | "denied" | null(판정 못 함: 네트워크·타임아웃 등).
//  GitHub 는 인증에 성공해도 셸을 안 줘서 종료코드 1 이다 → 종료코드가 아니라 인사말로 본다. (export=테스트용·순수)
export function classifySshProbe(code, output) {
  const o = String(output || "");
  if (HOSTKEY_CHANGED_RE.test(o)) return "hostkey-changed";
  if (HOSTKEY_FAIL_RE.test(o)) return "hostkey";
  if (/permission denied|publickey/i.test(o)) return "denied";
  if (code === 0 || /welcome to gitlab|successfully authenticated|authenticated via ssh key|welcome to gitea|logged in as/i.test(o)) return "ok";
  return null;
}

// lively doctor 가 시험할 ssh 대상 — 등록 레포의 clone 주소에서 ssh 인 것만, 같은 user@host:port 는 한 번. (export=테스트용·순수)
//  호스트 이름은 대소문자를 가리지 않으므로 소문자로 맞춰 센다(사용자 이름은 가리므로 그대로). cmd = 확인 명령 · forgetCmd = 바뀐 호스트키 지우기.
export function sshProbeTargets(repos) {
  const seen = new Map();
  for (const r of Array.isArray(repos) ? repos : []) {
    const s = sshTargetOf(r && r.clone_url);
    if (!s) continue;
    const t = { ...s, host: s.host.toLowerCase() };
    const key = `${t.user}@${t.host}:${t.port || ""}`;
    if (!seen.has(key)) seen.set(key, { ...t, cmd: sshProbeCmd(t), forgetCmd: sshForgetCmd(t) });
  }
  return [...seen.values()];
}

// 실패 안내 — git 의 fatal 은 점유자 경로까지만 알려준다. **왜** 안 되는지(브랜치 1개 = 워크트리 1개)와
//  **어떻게 빠져나오는지**(그 워크트리에서 작업 / branch 인자)는 말해주지 않아 사람이 매번 다시 알아내야 한다(#932).
//  게다가 3단 폴백의 마지막 실패가 -b 라 fatal 이 'already exists' 로 끝나 점유 사실 자체가 안 보인다.
function branchHeldNote(ctx, base, branch) {
  const at = checkedOutBranches(listWorktrees(ctx, base)).get(branch);
  return at
    ? ` — 브랜치 '${branch}' 는 이미 '${at}' 워크트리가 쥐고 있습니다(git 은 한 브랜치를 두 워크트리에 못 겁니다).`
      + ` 그 자리가 내 것이면 거기서 작업하고, 아니면 path·branch 인자 없이 다시 불러 옆자리를 받으세요`
      + ` (남의 세션 워크트리에서 작업하지 말 것 — reset·stash 가 그쪽 작업에 닿습니다).`
    : "";
}

// 레지스트리의 이 레포 행(clone 주소 · 등록한 기본 브랜치) — 한 호출 안에서 게이트웨이를 한 번만 묻는다(#1723).
//  부르는 쪽이 필요할 때 `await row()` 한다: base 가 이미 있고 ref 도 받은 호출은 게이트웨이를 아예 안 묻는다.
function registryRow(ctx, repo) {
  let p = null;
  return () => (p ??= (async () => {
    const reg = await ctx.api("/api/ui/repos");
    return (reg && reg.domainmapRepos || []).find((r) => r && r.name === repo) || null;
  })());
}
// 등록한 기본 브랜치 — 레지스트리 default_branch 를 «쓸 수 있는 브랜치 이름» 으로. 비었거나 형식이 안 맞으면 ""(등록값 없음).
//  ⚠ **git 소스를 연결한 레포(clone_url 있음)만** 등록값이 있다고 본다: default_branch 칸은 기본값이 'main' 이라, 스캔·인입으로
//   생기기만 하고 아무도 git 주소 · 기본 브랜치를 등록한 적 없는 레포에도 'main' 이 실려 온다. 그 값은 사람이 고른 게 아니다
//   → 그런 레포는 종전 동작(원격 기본 브랜치) 그대로다. 서버(project-provision registeredBranchOfRow)와 같은 규칙.
const registeredBranch = (row) => {
  if (!row || typeof row.clone_url !== "string" || !row.clone_url.trim()) return "";
  const b = typeof row.default_branch === "string" ? row.default_branch.trim() : "";
  return b && BRANCH_RE.test(b) ? b : "";
};

// ref 를 안 준 호출의 기준 브랜치(#1723) — **레포에 등록한 기본 브랜치**가 원격에 있으면 그것, 아니면 원격 기본 브랜치.
//  왜: 등록 화면의 «기본 브랜치» 는 도메인맵 스캔과 작업 클론이 함께 보는 단일 소스다. 원격 기본이 develop 이고 배포가
//   main 인 레포를 «main» 으로 등록해 두면, ref 없는 워크트리 · 핀도 main(배포된 코드)에서 떠야 한다 — 종전엔 원격 기본
//   (develop)에서 떠 배포 전 코드를 읽었다. ref 를 직접 준 호출은 여기로 오지 않는다(그 값을 그대로 따른다).
//  등록 브랜치가 원격에 없거나 게이트웨이가 답하지 않으면 종전 동작(원격 기본)으로 돌아가고 note 로 사유를 돌려준다.
async function defaultRefBranch(ctx, base, row) {
  let r = null, asked = true;
  try { r = await row(); } catch { asked = false; }
  const remote = () => remoteDefaultBranch(ctx, base);
  if (!asked) {
    const b = remote();
    return { branch: b, note: `등록한 기본 브랜치를 읽지 못해(게이트웨이 응답 없음) 원격 기본 브랜치 '${b}' 를 기준으로 삼았습니다.` };
  }
  const reg = registeredBranch(r);
  if (!reg) return { branch: remote(), note: null };
  if (ctx.sh("git", ["-C", base, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${reg}`], { allowFail: true }).code === 0) return { branch: reg, note: null };
  const b = remote();
  return { branch: b, note: b === reg ? null
    : `등록한 기본 브랜치 '${reg}' 가 원격(origin)에 없어 원격 기본 브랜치 '${b}' 를 기준으로 삼았습니다 — 관리 ▸ 레포에서 기본 브랜치를 확인하세요.` };
}
// ref 인자 해석 — 준 값이 있으면 그대로(형식만 확인), 없으면 위 기본값.
async function refBranchOf(ctx, base, ref, row) {
  const given = ref && BRANCH_RE.test(String(ref).trim()) ? String(ref).trim() : "";
  return given ? { branch: given, note: null } : defaultRefBranch(ctx, base, row);
}

// origin 기본 브랜치(main/master 등) — symbolic-ref 우선, 없으면 흔한 후보 확인, 최종 폴백 main.
function remoteDefaultBranch(ctx, base) {
  const sym = ctx.sh("git", ["-C", base, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { allowFail: true }).stdout.trim();
  if (sym) return sym.replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    if (ctx.sh("git", ["-C", base, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${b}`], { allowFail: true }).code === 0) return b;
  }
  return "main";
}

// 프로젝트의 **canonical 워크트리 슬롯** — <프로젝트 폴더>/<repo>. 서버 provisionProjectRepos 가 워크트리를
//  두는 자리(path.join(projDir, name))와 **같은 자리**다. 마커 없으면(프로젝트 밖) null.
//  ⚠ 세션 전용 폴더의 마커(#1719, `kind:"session"`)는 **그 폴더가 프로젝트 폴더가 아니다** — 프로젝트 폴더는 마커의
//   `project_dir` 가 가리킨다(세션이 나중에 프로젝트에 붙을 때 session-project.ts 가 적는다). 그걸 슬롯 기준으로 쓴다.
//   project_dir 가 없으면(그 컴퓨터에 프로젝트 폴더가 없다) 슬롯도 없다 → cwd/<repo> + wt/<repo> 로 떨어진다.
//   여기서 marker.dir 을 쓰면 sessions/<id>/<repo> 에 project/<id> 브랜치가 걸려 서버 provision 이 막힌다(#932 의 그 사고).
const canonicalOf = (marker, repo) => {
  if (!marker) return null;
  if (marker.meta && marker.meta.kind === "session") return marker.meta.project_dir ? join(String(marker.meta.project_dir), repo) : null;
  return join(marker.dir, repo);
};

// 워크트리 목표 경로 해석 — 지정 경로가 있으면 그대로(절대) 또는 cwd 기준(상대).
//  미지정이면 **cwd 가 아니라 canonical 슬롯**(프로젝트 밖이면 cwd/<repo> 폴백).
//  ⚠ 왜 cwd 가 아닌가(#932): 브랜치는 마커까지 **위로 올라가** 정하는데(project/<id>) 경로만 cwd 에서 뽑으면,
//   cwd 가 프로젝트 폴더 하위 어디냐에 따라 **같은 project/<id> 를 노리는 워크트리가 여러 자리에** 생긴다.
//   git 은 한 브랜치를 두 워크트리에 못 걸므로 나중에 온 쪽이 죽는다(provision 이면 502). 브랜치와 경로를
//   **둘 다 마커에서** 뽑아 한 자리로 수렴시키면 provision 과도 서로 멱등이 된다.
//  ⚠ 반드시 **정규화**해서 돌려준다: 호출부의 canonical 판정이 문자열 === 비교라, 같은 자리를 가리키는 다른
//   표기(끝 슬래시·`.`·`..`)가 '슬롯 밖'으로 오판되면 canonical 자리에 wt/<repo> 가 박혀 또 어긋난다.
//   (심링크 경유로 같은 자리를 가리키는 경우는 여전히 못 알아본다 — realpath 가 필요하고 대상이 아직 없을 수도
//    있어 안 했다. 오판의 결과는 '슬롯 밖 취급'(= wt/<repo>)이라 충돌이 아니라 이름만 손해라 안전측 실패다.)
//  marker 를 넘기면 재탐색을 피한다(호출부가 이미 걸어 올라간 경우).
function resolveWtPath(cwd, repo, p, marker = findProjectMarkerUp(cwd)) {
  if (!p) return canonicalOf(marker, repo) ?? join(cwd, repo);
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

// ── 원격에 닿는 git 의 자격 ───────────────────────────────────────────────────
// 왜: 이 도구는 «등록된 레포를 이 컴퓨터에서 읽게 해 주는» 도구다. 종전엔 이 컴퓨터에 이미 깔린 git 자격(ssh 키 ·
//  credential helper)에만 기댔다 — git 을 한 번도 설정하지 않은 사람은 라이블리에 토큰을 등록해 두고도 사설 레포를 받지
//  못했고, 물을 터미널이 없는 MCP 에서는 git 이 사용자 이름을 물으며 **끝없이 멈췄다**(실측: 클론 5분째 무응답).
//  그래서 ① 묻지 않게 하고(GIT_TERMINAL_PROMPT=0 — 서버 쪽 git 은 전부 이렇게 돈다) ② 라이블리에 등록한 **내 HTTPS 토큰**을
//  받아 그 git 한 번에만 넘긴다.
//
// 순서: 등록한 내 토큰 → (그 토큰이 거절되면) 이 컴퓨터의 git 자격. 서버 provision 과 같은 순서다(구성원 자격 먼저).
//  토큰이 없거나 받아 오지 못하면 곧바로 이 컴퓨터의 git 자격으로 간다 — 종전에 되던 클론은 그대로 된다.
//
// 토큰이 머무는 자리: 게이트웨이 응답 → 이 프로세스의 메모리 → git 자식 프로세스의 환경변수(LIVELY_GIT_PASS). 그게 전부다.
//  · 파일에 쓰지 않는다. git 설정도 환경변수(GIT_CONFIG_COUNT/KEY/VALUE, git ≥ 2.31)로 넘겨 argv 에도 싣지 않는다.
//  · 자격 도우미를 «그 원격의 scheme://host[:port]» 에만 건다(credential.<url>.helper) — 다른 호스트로 넘어가는 요청에는
//    git 이 이 도우미를 부르지 않는다. 프롬프트 문구를 읽어 답하는 GIT_ASKPASS 와 달리 로캘 · 문구에 기대지 않는다.
//  · 앞에 빈 credential.helper 를 둬 이 컴퓨터의 도우미(키체인 등)를 그 호출에서 뺀다 — 낡은 키체인 자격이 먼저 나가 실패하는
//    것을 막고, 성공 뒤 git 이 도우미에 «저장» 을 시켜도 받아 온 토큰이 이 컴퓨터의 키체인에 남지 않는다.
//  GCM_INTERACTIVE=never — 윈도우용 git 에 딸려 오는 자격 관리자(GCM)는 터미널이 아니라 **창**으로 묻는다. 동기 실행 중인 MCP 뒤에서
//   뜬 로그인 창도 같은 멈춤이다(kit/setup/work.mjs 의 git 과 같은 두 값). 이미 저장된 자격을 조용히 내주는 도우미는 그대로 돈다.
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
//  원격에 닿는 git 을 띄울 때의 공통 옵션. noTty — GIT_TERMINAL_PROMPT 는 git 자신의 물음만 끈다. ssh 는 호스트키 지문 · 키 암호를
//   제어 터미널에 직접 묻는데, 로컬 MCP 는 하네스(Claude Code 등)와 **같은 터미널**에 붙어 있어 그 물음이 사람의 세션 화면에 끼어들고
//   키 입력을 가로챈 채 끝없이 기다렸다(실측: ssh 주소 · 모르는 호스트키 → «Are you sure you want to continue connecting» 에서 멈춤).
//   그래서 «물을 수 없는 표면» 은 이 호출을 제어 터미널 없이 띄운다 — 어떤 프롬프트든 묻지 못하고 곧바로 실패한다(사용자의
//   GIT_SSH_COMMAND · core.sshCommand 는 건드리지 않는다). 사람이 터미널에서 부른 CLI 는 이 표식을 무시한다(ssh 물음에 답할 수 있다).
const NET = { allowFail: true, noTty: true };
//  도우미 본문 — git 이 `sh -c "<본문> get"` 으로 부른다. get 일 때만 답하고(store · erase 는 아무것도 안 한다), 값은 환경에서 읽는다.
const LEASE_HELPER = `!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' "$LIVELY_GIT_USER" "$LIVELY_GIT_PASS"; }; f`;

//  건넨 설정을 git 이 읽지 못했을 때의 문구(«missing config value» · «bad config» · 환경변수 이름이 그대로 실린 오류).
const INJECT_FAIL_RE = /missing config (?:key|value)|bad config|bogus (?:count|format) in GIT_CONFIG|GIT_CONFIG_(?:COUNT|KEY|VALUE)/i;
//  환경변수 설정(GIT_CONFIG_COUNT)을 모르는 옛 git 인가 — 판을 못 읽으면 아니라고 본다(모르는 것을 단정하지 않는다).
function gitTooOld(ctx) {
  const m = /(\d+)\.(\d+)/.exec(ctx.sh("git", ["version"], { allowFail: true }).stdout || "");
  return Boolean(m) && (Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 31));
}

// 원격 주소 → 자격을 걸 자리 { origin: "https://host[:port]", host: "host" } — http(s) 가 아니거나 못 읽으면 null. (export=테스트용·순수)
export function httpRemoteOf(url) {
  let u; try { u = new URL(String(url || "").trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!u.hostname) return null;
  return { origin: `${u.protocol}//${u.host}`, host: u.hostname.toLowerCase() };
}

// 받아 온 토큰을 그 git 한 번에 싣는 환경변수. 이미 GIT_CONFIG_COUNT 를 쓰는 환경이면 그 뒤에 잇는다. (export=테스트용·순수)
export function gitAuthEnv(remote, cred, env = process.env) {
  const n = Number.parseInt(String(env.GIT_CONFIG_COUNT ?? ""), 10);
  const base = Number.isInteger(n) && n > 0 ? n : 0;
  return {
    ...NO_PROMPT,
    GIT_CONFIG_COUNT: String(base + 2),
    [`GIT_CONFIG_KEY_${base}`]: "credential.helper", [`GIT_CONFIG_VALUE_${base}`]: "",
    [`GIT_CONFIG_KEY_${base + 1}`]: `credential.${remote.origin}.helper`, [`GIT_CONFIG_VALUE_${base + 1}`]: LEASE_HELPER,
    LIVELY_GIT_USER: String(cred.username || "x-access-token"),
    LIVELY_GIT_PASS: String(cred.token),
  };
}

// 이 레포의 내 토큰 받아 오기 — { state, cred?, remote?, why? }.
//  state: ok(받음) · n/a(https 주소가 아님 — 묻지 않는다) · no-credential · ssh-credential · not-https-url · repo-unregistered(서버의 까닭 그대로)
//         · host-mismatch(이 원격의 자리 scheme://host[:port] 가 등록 주소의 자리와 다르다 — 토큰을 다른 자리로 보내지 않는다)
//         · unsupported(이 길이 없는 옛 게이트웨이) · unavailable(그 밖의 실패 — why 에 한 줄).
//  실패는 던지지 않는다: 받아 오지 못해도 이 컴퓨터의 git 자격으로 갈 길이 남아 있다.
async function leaseFor(ctx, repo, url) {
  const remote = httpRemoteOf(url);
  if (!remote) return { state: "n/a" };
  let j;
  try { j = await ctx.api("/api/ui/me/git-credential/lease", { method: "POST", body: { repo }, timeoutMs: 8000 }); }
  catch (e) {
    if (e && e.status === 404) return { state: "unsupported" };
    if (e && e.status === 403) return { state: "unavailable", why: "이 접속 열쇠로는 등록한 토큰을 받을 수 없습니다" };
    return { state: "unavailable", why: String((e && e.message) || e || "").split("\n")[0].slice(0, 160) };
  }
  const c = j && j.credential;
  if (c && c.kind === "https" && typeof c.token === "string" && c.token) {
    //  토큰은 «등록 주소의 자리(scheme://host[:port])» 로만 보낸다. 호스트 이름만 대조하면 https 로 등록한 레포의 토큰이 같은 호스트의
    //   평문 http · 다른 포트로 나간다(받아 둔 base 의 origin 은 이 컴퓨터의 상태라 등록 주소와 다를 수 있다).
    if (typeof j.origin !== "string" || j.origin !== remote.origin) return { state: "host-mismatch" };
    return { state: "ok", remote, cred: { username: c.username, token: c.token } };
  }
  const reason = j && typeof j.reason === "string" ? j.reason : "";
  return { state: ["no-credential", "ssh-credential", "not-https-url", "repo-unregistered"].includes(reason) ? reason : "unavailable" };
}

// 원격에 닿는 git — url 은 그 git 이 닿을 원격 주소(자격을 걸 자리). lease() 는 한 호출 안에서 한 번만 받아 온다(아래 netGitFor).
//  돌려주는 lease 는 안내(authNote)가 읽는다: 받아 온 토큰이 거절됐으면 state 를 used-failed 로 바꿔 준다.
async function netGit(ctx, args, lease) {
  const l = await lease();
  if (l.state === "ok") {
    const r = ctx.sh("git", args, { ...NET, env: gitAuthEnv(l.remote, l.cred) });
    if (r.code === 0) return { ...r, lease: l };
    const authFail = AUTH_FAIL_RE.test(r.stderr || "");
    //  토큰을 git 에 건네는 것 자체가 실패했다 — 건넨 설정을 git 이 읽지 못했다(빈 환경변수 값을 떨어뜨리는 환경 등). 자격 탓이 아니다.
    const injectFail = !authFail && INJECT_FAIL_RE.test(r.stderr || "");
    if (!authFail && !injectFail) return { ...r, lease: l };   // 자격과 무관한 실패(네트워크 등) — 다시 해도 같다
    //  이 컴퓨터의 git 자격으로 한 번 더. 그래도 안 되면 안내가 까닭에 맞는 길을 말한다(토큰 거절 → 다시 등록 · 건네기 실패 · 옛 git).
    const amb = ctx.sh("git", args, { ...NET, env: NO_PROMPT });
    if (amb.code === 0) return { ...amb, lease: l };
    if (injectFail) return { ...amb, lease: { state: "unavailable", why: `받아 온 토큰을 git 에 건네지 못했습니다: ${gitFail(r.stderr)}` } };
    //  git < 2.31 은 환경변수 설정(GIT_CONFIG_COUNT)을 읽지 않는다 — 토큰은 쓰이지도 않았다. «토큰이 거절됐다» 고 말하면 거짓이다.
    return { ...amb, lease: gitTooOld(ctx) ? { state: "unavailable", why: "이 컴퓨터의 git 이 2.31 보다 옛 판이라 받아 온 토큰을 쓰지 못합니다 — git 을 업데이트하세요" } : { state: "used-failed" } };
  }
  return { ...ctx.sh("git", args, { ...NET, env: NO_PROMPT }), lease: l };
}
//  이 레포 · 이 원격의 netGit — 토큰 받아 오기를 한 번으로 묶는다(clone → ls-remote → clone 이 게이트웨이를 세 번 묻지 않게).
function netGitFor(ctx, repo, url) {
  let p = null;
  const lease = () => (p ??= leaseFor(ctx, repo, url));
  return (args) => netGit(ctx, args, lease);
}

// base 확보 — 로컬에 없으면 레지스트리 clone_url 로 clone, 있으면 fetch(refs 만; 워킹트리 미변경 = RO 규율).
//  작업 워크트리(repoWorktree)·읽기전용 핀(repoPin) 공용 진입.
//  새로 받을 땐 등록한 기본 브랜치로 받는다(#1723) — 그 브랜치가 원격에 없으면(원격에 물어 확인) 원격 기본 브랜치로 받는다.
//  돌려주는 값 { fetchWarning } — 이미 있는 base 의 fetch 가 실패했을 때의 한 줄(없으면 null). fetch 실패는 종전처럼 던지지 않는다
//   (오프라인에서도 받아 둔 코드로 일한다). 다만 **조용히 넘기지 않는다**: 그 뒤의 워크트리 · 핀은 «마지막으로 받아 둔 origin» 기준이라
//   최신이 아닐 수 있고, 부른 쪽이 그걸 모르면 묵은 코드를 최신이라 믿는다. 자격 문제면 고치는 길까지 싣는다.
async function ensureBase(ctx, repo, base, row = registryRow(ctx, repo)) {
  let fetchWarning = null;
  if (!isGitRepo(ctx, base)) {
    const r = await row();
    const url = r && r.clone_url;
    if (!url) throw new Error(`레포 '${repo}' 가 이 머신에 없고 등록된 clone 주소도 없습니다 — 관리탭 ▸ 레포에서 git 주소를 연결하세요.`);
    mkdirSync(dirname(base), { recursive: true });
    const want = registeredBranch(r);
    const git = netGitFor(ctx, repo, url);
    let c = await git(["clone", ...(want ? ["--branch", want] : []), url, base]);
    if (c.code !== 0 && want) {
      // 실패가 «등록 브랜치가 원격에 없음» 때문인지 원격에 물어 가른다 — git 의 실패 문구는 로캘·버전마다 달라 문구로 가르지 않는다.
      const ls = await git(["ls-remote", "--heads", url, `refs/heads/${want}`]);
      if (ls.code === 0 && !ls.stdout.trim()) c = await git(["clone", url, base]);
    }
    if (c.code !== 0) throw new Error(`git clone 실패(${repo}): ${gitFail(c.stderr)}${authNote(c.stderr, url, undefined, c.lease)}`);
  } else {
    //  이미 받아 둔 base — 닿을 주소는 그 base 의 origin 이다(등록 주소와 다를 수 있다 → leaseFor 가 호스트를 대조한다).
    const url = ctx.sh("git", ["-C", base, "remote", "get-url", "origin"], { allowFail: true }).stdout.trim();
    const f = await netGitFor(ctx, repo, url)(["-C", base, "fetch", "origin"]); // best-effort(오프라인 무시)
    if (f.code !== 0) {
      fetchWarning = `원격에서 새 커밋을 받지 못했습니다(${gitFail(f.stderr)}) — 이 컴퓨터에 마지막으로 받아 둔 origin 기준이라 최신이 아닐 수 있습니다.`
        + authNote(f.stderr, url, undefined, f.lease);
    }
  }
  // gc 의 자동 워크트리 prune 을 끈다(#3678) — `git gc --auto`(commit·fetch 뒤 저절로 돈다)는 gc.worktreePruneExpire(기본 3개월)
  //  보다 오래 index 를 안 건드린 «경로 없는» 등록을 지운다. 컨테이너에서 «경로 없음» 은 «다른 프로젝트의 살아 있는
  //  워크트리」일 수 있으므로 base 에서 영구히 끈다(T0 실측: index 4개월 묵은 A 를 B 의 gc 가 지우던 것이 never 로 멈춤).
  //  base 에 만지는 건 이 config 키 하나뿐(워킹트리·ref 무변경 = RO 규율 유지). 워크트리들은 base 의 config 를 공유하므로
  //  어느 워크트리에서 gc 가 돌아도 같이 막힌다. 멱등·best-effort.
  ctx.sh("git", ["-C", base, "config", "gc.worktreePruneExpire", "never"], { allowFail: true });
  return { fetchWarning };
}

// 핀 경로 — 지정 없으면 tmpdir 밑 **repo + SHA** 로 content-addressed(#932). 작업 워크트리와 섞이지 않게 별도 루트.
//  ⚠ 왜 SHA 를 박나: macOS `tmpdir()` 는 **세션당이 아니라 유저당** 하나다. sha 없이 `lively-pin/<repo>` 한 자리를
//   쓰면, 세션 A 가 SHA1 을 핀한 사이 main 이 전진해 세션 B 가 SHA2 를 핀할 때 repoPin 이 A 의 핀을 force-remove 하고
//   SHA2 로 덮어쓴다 — A 는 같은 경로를 계속 읽는데 발밑 코드가 바뀐다(핀이 막으려던 HEAD 드리프트를 핀이 세션 간에
//   재도입). SHA 를 경로에 박으면 같은 SHA 는 공유(dedup)·다른 SHA 는 공존, force-remove 자체가 필요 없어진다.
//   지정 경로(p)는 호출자가 자리를 명시한 것이라 그대로 둔다(그 자리의 스톰프는 호출자 책임).
const pinPathOf = (ctx, repo, p, sha) => (p ? (isAbsolute(p) ? p : join(ctx.cwd, p)) : join(tmpdir(), "lively-pin", repo, sha));

// ── admin id(#3678) ──────────────────────────────────────────────────────────
// git 은 admin 디렉터리(`<base>/.git/worktrees/<id>`) 이름을 **워크트리 경로의 basename** 으로 짓는다(이미 있으면 숫자만 붙인다).
//  canonical 슬롯은 모든 프로젝트가 `<프로젝트 폴더>/<repo>` 라 basename 이 전부 `<repo>` — 한쪽 admin 이 지워졌다(prune)
//  다른 쪽이 다시 뜨면 **같은 이름**이 재생성돼, 지워진 쪽의 gitfile 이 그 새 admin 을 가리킨다 = 두 워크트리가 HEAD·index
//  하나를 공유한다(2026-09-08 사고: 내 커밋이 project/3646 에 얹힘). 그래서 만든 직후 id 를 **경로에서 유일하게 정해지는
//  이름**으로 옮긴다: 슬롯이면 `<repo>-p<pid>`, 밖이면 `<basename>-<8hex(경로)>`. 같은 경로 ⇒ 같은 id(서버 provision 과
//  재사용이 멱등). 관측용이기도 하다 — `ls .git/worktrees` 만으로 누구 것인지 보인다. 지워지더라도 남이 같은 이름을 다시
//  만들 일이 없으니 «조용한 공유» 가 «시끄러운 실패(not a git repository)» 로 바뀐다 — 그게 의도다.
export function adminIdFor(wt, pid, canonical) {   // export=테스트용·순수
  const name = basename(wt);
  if (pid !== null && pid !== undefined && canonical && wt === canonical) return `${name}-p${pid}`;
  return `${name}-${pathHash8(wt)}`;
}
const pathHash8 = (p) => createHash("sha1").update(resolve(p)).digest("hex").slice(0, 8);
const gitfileOf = (wt) => join(wt, ".git");
const readGitdirLine = (file, baseDir) => {         // "gitdir: <경로>" 한 줄 → 절대경로 | "" (파손) | null (파일 없음)
  let txt; try { txt = readFileSync(file, "utf8"); } catch { return null; }
  const m = txt.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return "";
  return isAbsolute(m[1]) ? m[1] : resolve(baseDir, m[1]);   // worktree.useRelativePaths(git≥2.48)면 상대경로
};
// 워크트리의 gitfile(`.git` **파일**) 이 가리키는 admin 경로 — `.git` 이 디렉터리(그 자리에 직접 clone)면 null.
function adminOf(wt) {
  const f = gitfileOf(wt);
  let st; try { st = statSync(f); } catch { return null; }
  if (!st.isFile()) return null;
  return readGitdirLine(f, wt);
}
// admin → 그 admin 이 «자기 워크트리» 라고 적어 둔 gitfile 경로(`<admin>/gitdir` — 접두 없이 `<wt>/.git` 경로 한 줄). 없으면 "".
const adminBackref = (admin) => {
  let txt; try { txt = readFileSync(join(admin, "gitdir"), "utf8"); } catch { return ""; }
  const line = (txt.split("\n")[0] || "").trim();
  if (!line) return "";
  return isAbsolute(line) ? line : resolve(admin, line);   // worktree.useRelativePaths(git≥2.48)면 상대경로
};

// 재사용 전 **소유 검증**(#3678 T2): gitfile 이 가리키는 admin 이 있고, 그 admin 의 gitdir 가 **이 워크트리 자신**을 가리켜야
//  한다. 아니면 남의 admin 을 잇고 있는 사고 상태다 — 조용히 재사용하면 여기서 한 커밋이 남의 브랜치에 얹힌다. 무엇도 고치지
//  않고 멈춘다(그 자리의 파일·미커밋 변경은 그대로다). 반환 { admin } (직접 clone 이면 admin:null 로 통과).
function verifyOwnAdmin(wt) {
  const admin = adminOf(wt);
  if (admin === null) return { admin: null };
  const help = "이 워크트리에서 git 을 쓰지 마세요(reset·stash 가 남의 작업에 닿습니다). 파일은 그대로 있으니 다른 경로에"
    + " 새 워크트리를 뜬 뒤(path 인자) 내 변경만 옮기세요 — 절차: 지식 'shared-worktree-hijacked-by-other-session'.";
  if (!admin) throw new Error(`워크트리 '${wt}' 의 .git 파일이 파손됐습니다(gitdir 줄 없음). ${help}`);
  if (!existsSync(admin)) {
    throw new Error(`워크트리 '${wt}' 의 git 등록(admin '${admin}')이 사라졌습니다 — 다른 세션의 worktree prune 에 지워졌을 수 있습니다. ${help}`);
  }
  const back = adminBackref(admin);
  if (!back || !samePath(back, gitfileOf(wt))) {
    throw new Error(`워크트리 '${wt}' 가 **다른 워크트리의** git 등록을 잇고 있습니다 — admin '${admin}' 은 '${back ? dirname(back) : "(불명)"}' 의 것입니다`
      + `(같은 base 에서 같은 basename 으로 다시 뜬 admin 을 둘이 가리키는 상태). 여기서 커밋하면 그쪽 브랜치에 얹힙니다. ${help}`);
  }
  return { admin };
}

// admin 을 고유 id 로 옮긴다(#3678): `<base>/.git/worktrees/<old>` → `<…>/<newId>` 로 rename 하고 gitfile 을 다시 쓴다.
//  `git worktree move/repair` 가 하는 것과 같은 두 파일 조작이다(admin 의 gitdir 파일은 워크트리 경로를 담으므로 그대로 유효).
//  이미 그 id 면 no-op. 목적지가 있으면 — 스테일(경로 없음·부모 있음 = provablyGone)이면 치우고, 살아 있는 워크트리 것이면
//  남의 것이라 옮기지 않고 throw. gitfile 쓰기가 실패하면 rename 을 되돌린다(중간 상태를 남기지 않는다).
function relinkAdmin(wt, admin, newId) {
  if (basename(admin) === newId) return admin;
  const dst = join(dirname(admin), newId);
  if (existsSync(dst)) {
    const back = adminBackref(dst);
    if (back && !provablyGone(dirname(back))) throw new Error(`admin id '${newId}' 자리를 살아 있는 워크트리('${dirname(back)}')가 쓰고 있어 옮기지 않습니다.`);
    // 여기 오는 건 둘뿐 — 그 등록의 워크트리가 정말 지워졌거나(provablyGone), gitdir 파일이 없어 git 도 «gitdir file does not
    //  exist» 로 prune 대상으로 보는 껍데기다. 둘 다 git prune 이 지울 것을 이 자리에서만 지운다.
    rmSync(dst, { recursive: true, force: true });
  }
  //  ⚠ 원자적이지 않다(rename → gitfile 쓰기 두 걸음). 그 사이 이 워크트리에서 도는 git(IDE 워처 등)은 한 번 실패한다 —
  //   툴은 세션 시작 자리에서 불리고 방금 만든/재사용하는 워크트리라 실용상 창이 없다. 실패하면 되돌려 중간 상태를 안 남긴다.
  const gitfile = gitfileOf(wt);
  const prev = readFileSync(gitfile, "utf8");
  renameSync(admin, dst);
  try {
    // ⚠ 윈도우: git 이 만든 `.git` 파일은 hidden 속성이라 'w' 로 열면 EPERM — 지우고 새로 쓴다(속성은 git 에 불필요, CI 실측).
    try { unlinkSync(gitfile); } catch { /* 없으면 그대로 */ }
    writeFileSync(gitfile, `gitdir: ${process.platform === "win32" ? dst.replace(/\\/g, "/") : dst}\n`);
  } catch (e) {
    try { writeFileSync(gitfile, prev); } catch { /* 되돌리기도 실패 — 원인 e 를 그대로 */ }
    try { renameSync(dst, admin); } catch { /* 위와 같음 */ }
    throw e;
  }
  return dst;
}

// 이 머신에서 뜰 수 있는 등록 레포 + 로컬 base 상태(clone 여부·브랜치·origin 대비 최신).
export async function repoList(ctx) {
  const reg = await ctx.api("/api/ui/repos");
  const cloneUrl = new Map(), regBranch = new Map();
  for (const r of (reg.domainmapRepos || [])) if (r && typeof r.name === "string") { cloneUrl.set(r.name, r.clone_url ?? null); regBranch.set(r.name, registeredBranch(r) || null); }
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
    // default_branch = 등록한 기본 브랜치(#1723) — ref 없는 워크트리·핀이 뜨는 기준. branch(base 가 지금 서 있는 브랜치)와 다를 수 있다.
    return { name, clone_url: cloneUrl.get(name) ?? null, default_branch: regBranch.get(name) ?? null, cloned, base, branch, head, status };
  });
  return { repos_dir: dir, count: repos.length, repos };
}

// base 확보(없으면 clone·있으면 fetch) → cwd(기본)/지정경로에 격리 브랜치 워크트리. base working tree 미변경.
export async function repoWorktree(ctx, args) {
  const repo = String(args.repo || "").trim();
  if (!REPO_NAME_RE.test(repo)) throw new Error(`레포 이름 형식 오류(영숫자.-_): ${repo}`);
  const base = join(reposDir(), repo);
  const mode = worktreeMode(args.mode);

  // ① base 확보(clone or fetch) — 공용.
  const row = registryRow(ctx, repo);
  const { fetchWarning } = await ensureBase(ctx, repo, base, row);

  // ② 경로 결정 — **브랜치가 경로에 달려 있으므로**(아래) 경로가 먼저다. 마커는 한 번만 걸어 올라가 재사용한다.
  const marker = findProjectMarkerUp(ctx.cwd);
  const asked = args.path && String(args.path).trim();
  const want = resolveWtPath(ctx.cwd, repo, asked, marker);

  const pid = marker?.meta.project_id ?? null;
  const canonical = canonicalOf(marker, repo);
  const me = sessionKey();
  const who = { pid, me, isSlot: canonical !== null && pid !== null && want === canonical };

  // ②-b 자리도 비켜간다(브랜치처럼) — **기본 자리일 때만**. path 를 명시했으면 그건 호출자가 고른 자리라
  //  옮기지 않는다(멱등 계약). canonical 슬롯도 옮기지 않는다: 그 자리는 프로젝트 공용이고 서버 provision 과
  //  같은 자리여야 한다. 남는 건 «마커 없는 세션의 기본 자리 <cwd>/<repo>» — 여러 세션이 같은 cwd 에서 뜨면
  //  전부 이 한 자리로 수렴해 남의 워킹트리를 물던 바로 그 자리다.
  const slot = (asked || who.isSlot) ? { path: want, why: null } : freeSlot(ctx, want, who, base);
  const wt = slot.path;
  const asideFrom = wt === want ? null : want;
  const isSlot = canonical !== null && pid !== null && wt === canonical;
  const adminId = adminIdFor(wt, pid, canonical);

  // 이미 워크트리면 재사용(멱등) — 단 **내 것인지 먼저 확인한다**(#3678 T2). **브랜치를 고르기 전에** 나간다: 있는
  //  워크트리를 돌려주는 데 새 이름은 필요 없고, 이름 고르기가 실패해도(전부 점유) 여기까지 못 오면 안 되기 때문(#932).
  //  판정은 `.git` 의 존재다(git 이 열 수 있는지가 아니라) — gitfile 이 파손·미아가 된 워크트리도 «새로 만들 자리» 가 아니라
  //  «검증해서 알려 줄 자리» 다(그 자리엔 사람의 파일이 있다).
  if (existsSync(gitfileOf(wt)) || isGitRepo(ctx, wt)) {
    // 있는 자리의 방식은 지금 고른 mode 가 아니라 그 자리가 정한다 — clone 으로 뜬 자리는 mode 가 바뀌어도 clone 으로 재사용한다.
    const cloneDir = cloneGitDirOf(wt, base);
    let adminNow = cloneDir;
    if (!cloneDir) {
      const { admin } = verifyOwnAdmin(wt);                       // 남의 admin 을 잇고 있으면 여기서 멈춘다(조용히 재사용 금지)
      adminNow = admin ? relinkAdmin(wt, admin, adminId) : null;  // 서버 provision 등이 basename id 로 만든 것도 고유 id 로
    }
    const b = ctx.sh("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).stdout.trim();
    const stamp = readOwner(adminNow);
    const mine = isMine(stamp, who);
    if (mine) writeOwner(adminNow, { session: me, project_id: pid, branch: b || null, worktree: wt });
    const out = { repo, worktree: wt, branch: b || null, base, mode: cloneDir ? "clone" : "worktree",
      admin: !cloneDir && adminNow ? basename(adminNow) : null, note: "이미 워크트리가 있어 그대로 사용합니다." };
    if (args.mode && out.mode !== mode) out.note += ` 요청한 mode(${mode})와 달리 이 자리는 ${out.mode} 방식이라 그 방식대로 씁니다 — ${mode} 가 필요하면 path 로 다른 자리를 지정하세요.`;
    // 내 것이 아닌 자리를 그대로 쓰는 경로는 이제 하나뿐이다 — 호출자가 path 로 그 자리를 **지목**한 경우(기본 자리는
    //  위에서 비켜섰다). 지목은 존중하되 조용히 넘기지는 않는다: 여기서 커밋하면 그 세션의 브랜치에 얹힌다.
    if (!mine && stamp === null) {
      // 주인 표시가 없는 자리를 **지목**했다 — 이 변경 이전에 뜬 워크트리가 여기 해당한다. 입양해서 이 세션 것으로
      //  표시한다: 표시를 안 하면 그 자리는 아무 세션도 못 쓰는 사석으로 남고 부를 때마다 같은 경고가 뜬다.
      //  남의 스탬프가 있는 자리는 입양하지 않는다(소유 탈취 금지) — 아래 경고로 간다.
      if (writeOwner(adminNow, { session: me, project_id: pid, branch: b || null, worktree: wt })) {
        out.note += " 주인 표시가 없던 자리라 이 세션 것으로 표시했습니다.";
      } else {
        // 표시를 남길 데가 없는 자리 — `.git` 이 디렉터리(사람이 손으로 clone 한 폴더)면 admin 자체가 없다.
        //  이 툴의 워크트리가 아니므로 소유를 말할 수 없다. 조용히 넘기지는 않는다.
        out.warning = `이 자리는 이 툴이 만든 워크트리가 아니라 소유를 확인할 수 없습니다 — 다른 사람·세션이 쓰는 폴더일 수 있습니다.`;
      }
    } else if (!mine) {
      out.warning = stamp === false
        ? `이 워크트리의 주인 표시를 읽을 수 없습니다(손상됐거나 다른 세션이 지금 쓰는 중). 남의 자리일 수 있으니`
          + ` 커밋 전에 git status 로 내가 안 만진 변경이 없는지 확인하세요 — 새 자리가 필요하면 path 인자를 빼고 다시 부르세요.`
        : `이 워크트리는 이 세션이 만든 자리가 아닙니다(세션 ${stamp.session ?? "?"}, 브랜치 '${b || "?"}').`
          + ` 그 세션이 쓰는 중일 수 있으니 커밋 전에 git status 로 내가 안 만진 변경이 없는지 확인하세요`
          + ` — 새 자리가 필요하면 path 인자를 빼고 다시 부르세요.`;
    } else if (!me && (pid === null || pid === undefined) && stamp && stamp.session) {   // stamp===false 면 읽을 이름이 없다
      // 신원 없는 호출은 소유 판정을 끄고 재사용한다(isMine) — 그래서 다른 세션의 자리도 그대로 열린다. 막지는
      //  않되(맨 터미널 CLI 의 멱등이 걸려 있다) 조용히 넘기지도 않는다.
      out.warning = `이 자리는 세션 ${stamp.session} 이 쓰던 곳인데, 이 호출엔 세션 신원이 없어 소유 판정 없이 재사용합니다`
        + ` — 그 세션이 작업 중이면 커밋이 섞입니다.`;
    }
    // 경고는 슬롯에서만 — 슬롯은 «어느 브랜치여야 하는지»(project/<pid>)가 정해져 있어 어긋남을 판정할 수 있다. 슬롯 밖은
    //  기대 브랜치가 없다(호출자가 branch 를 줬을 수도, wt/<repo>-n 일 수도) → 반환 branch 를 호출자가 본다.
    if (isSlot && b && b !== `project/${pid}`) {
      out.warning = `canonical 슬롯인데 브랜치가 project/${pid} 가 아니라 '${b}' 입니다 — 다른 세션이 이 자리에서 브랜치를 갈아탔을 수`
        + ` 있습니다(git status 에 내가 안 만진 파일이 보이면 그 신호). 커밋 전에 확인하세요.`;
    }
    return out;
  }

  // ③ 진짜로 만들 때만, **표적** 스테일 등록을 턴다(#932 → #3678) — blanket prune 은 다른 컨테이너의 살아 있는 워크트리를
  //  지운다. 부모 디렉터리를 먼저 만든다: «경로 없음 + 부모 있음» 이 곧 «정말 지워졌다» 의 근거라서.
  //  **브랜치를 고르기 전에** 스테일을 가려야 한다: 사라진 워크트리의 등록도 점유로 세면 freeBranch 가 이미 죽은
  //  wt/<repo> 를 점유중으로 보고 -2 로 건너뛰어 이름을 영영 잃는다. 반대로 **부모까지 안 보이는** 등록은 살아 있을 수
  //  있으므로 점유로 센다(그 이름을 뺏지 않는다).
  mkdirSync(dirname(wt), { recursive: true });
  const regs = listWorktrees(ctx, base);
  const live = regs.filter((w) => w.locked || !provablyGone(w.path));   // locked = 경로가 없어도 점유(표적 정리도 안 지우므로 이름을 주면 add 가 죽는다)

  // ④ 브랜치 기본값 — **canonical 슬롯일 때만** project/<id>: 서버 provisionProjectRepos 와 같은 자리·같은 이름이라
  //  서로 멱등이다(먼저 뜬 쪽을 뒤에 온 쪽이 그대로 재사용). 슬롯 밖(path 를 따로 준 경우)에까지 project/<id> 를
  //  걸면 그 프로젝트의 provision 이 502 로 죽는다 — **싱글턴 이름은 싱글턴 자리에만**(#932). 밖이면 이 워크트리
  //  전용 wt/<repo>[-n](점유되지 않은 첫 이름 — 슬롯 밖 워크트리끼리도 안 겹치게).
  //  clone 모드는 브랜치를 공유하지 않으니 점유 검사 대신 경로에서 유일한 이름을 쓴다 — 두 작업면이 같은 원격 브랜치로 push 하지 않게.
  const branch = (args.branch && String(args.branch).trim())
    || (isSlot ? `project/${pid}`
      : mode === "clone" ? `wt/${repo}-${pathHash8(wt)}` : freeBranch(checkedOutBranches(live), `wt/${repo}`));
  if (!BRANCH_RE.test(branch)) throw new Error(`브랜치명 형식 오류: ${branch}`);
  clearStaleRegistrations(ctx, base, { paths: [wt], branch }, regs);

  // ⑤ worktree add — 새 브랜치(origin/<ref> 최신 기준) 시도 → 같은 브랜치가 이미 있으면 attach 폴백(provision 동형).
  //  ref 를 안 줬으면 레포에 등록한 기본 브랜치가 기준이다(#1723). 있는 워크트리를 돌려주는 위쪽 경로는 기준이 필요 없어 묻지 않는다.
  const { branch: refBranch, note: refNote } = await refBranchOf(ctx, base, args.ref, row);
  if (mode === "clone") return repoWorktreeClone({ ctx, repo, base, wt, branch, refBranch, refNote, fetchWarning, asideFrom, slot, me, pid, live });
  let r = ctx.sh("git", ["-C", base, "worktree", "add", wt, "-b", branch, `origin/${refBranch}`], { allowFail: true });
  if (r.code !== 0) r = ctx.sh("git", ["-C", base, "worktree", "add", wt, branch], { allowFail: true });          // 기존 브랜치 attach
  if (r.code !== 0) r = ctx.sh("git", ["-C", base, "worktree", "add", wt, "-b", branch], { allowFail: true });     // origin/<ref> 없을 때 base HEAD
  if (r.code !== 0) throw new Error(`워크트리 생성 실패(${repo}): ${gitFail(r.stderr)}${branchHeldNote(ctx, base, branch)}`);

  // ⑥ admin 을 고유 id 로(#3678) — git 이 지은 basename id(`<repo>`·`<repo>N`)는 프로젝트가 달라도 겹친다.
  const admin = adminOf(wt);
  const adminNow = admin ? relinkAdmin(wt, admin, adminId) : null;
  const stampable = Boolean(me) || (pid !== null && pid !== undefined);   // 신원 없는 호출은 표시를 남기지 않는다(writeOwner)
  const stamped = stampable && writeOwner(adminNow, { session: me, project_id: pid, branch, worktree: wt });

  const out = { repo, worktree: wt, branch, base, mode: "worktree", ref: refBranch, admin: adminNow ? basename(adminNow) : null,
    note: `이 경로에서 작업하세요: ${wt} · base(${base})는 pristine 공유 원본이라 직접 작업 금지(커밋·빌드는 워크트리에서).` };
  if (asideFrom) {
    out.note += ` · 기본 자리(${asideFrom})는 ${asideReason(slot.why)} 옆자리로 비켜섰습니다.`;
  }
  if (refNote) { out.ref_note = refNote; out.note += ` · ${refNote}`; }
  if (fetchWarning) out.fetch_warning = fetchWarning;   // 새 워크트리가 «받아 둔 origin» 에서 떴다 — 최신이 아닐 수 있다
  // 스탬프가 없으면 다음 호출이 이 자리를 «모르는 자리» 로 보고 또 옆으로 비켜선다 — 자리가 늘어나는 건 그 신호다.
  if (adminNow && stampable && !stamped) out.warning = `소유 표시(${basename(adminNow)}/lively-owner.json)를 쓰지 못했습니다 — 다음 호출이 이 자리를 재사용하지 않고 옆자리를 팝니다.`;
  return out;
}

function repoWorktreeClone({ ctx, repo, base, wt, branch, refBranch, refNote, fetchWarning, asideFrom, slot, me, pid, live }) {
  // clone 이 빌려 쓰는 객체를 base 가 지우면 그 clone 은 복구할 수 없게 깨진다. base 에서 떨어진 객체(지워진 원격 브랜치·
  //  force-push 이전 커밋)를 gc 가 지우지 않게 한다. 해제 조건: 이 base 를 alternates 로 쓰는 clone 이 하나도 없을 때.
  //  `git gc --prune=now`·`git prune` 을 base 에서 직접 돌리면 이 보호를 넘는다.
  const guarded = ctx.sh("git", ["-C", base, "config", "gc.pruneExpire", "never"], { allowFail: true }).code === 0;
  const { from } = cloneFromBase(ctx, base, wt, branch, refBranch);
  const gitDir = gitfileOf(wt);
  const stampable = Boolean(me) || (pid !== null && pid !== undefined);
  const stamped = stampable && writeOwner(gitDir, { session: me, project_id: pid, branch, worktree: wt });
  const out = { repo, worktree: wt, branch, base, mode: "clone", ref: refBranch, admin: null,
    note: `이 경로에서 작업하세요: ${wt} · clone 모드 — .git 이 이 폴더 안에 있고 base(${base}) 객체는 읽기만 합니다.`
      + ` push 하지 않은 커밋은 이 폴더에만 있으니 폴더를 지우기 전에 push 하세요.` };
  if (asideFrom) out.note += ` · 기본 자리(${asideFrom})는 ${asideReason(slot.why)} 옆자리로 비켜섰습니다.`;
  if (from === "existing") out.note += ` · 기존 브랜치 '${branch}' 를 이어받았습니다(origin/${refBranch} 최신에서 새로 분기한 것이 아닙니다).`;
  if (refNote) { out.ref_note = refNote; out.note += ` · ${refNote}`; }
  if (fetchWarning) out.fetch_warning = fetchWarning;
  const warnings = [];
  const heldAt = checkedOutBranches(live).get(branch);
  if (heldAt) warnings.push(`브랜치 '${branch}' 는 worktree 모드 작업면 '${heldAt}' 에도 걸려 있습니다 — 두 자리에서 따로 커밋하면 갈라지니 한쪽에서만 작업하세요.`);
  if (stampable && !stamped) warnings.push(`소유 표시(${gitDir}/lively-owner.json)를 쓰지 못했습니다 — 다음 호출이 이 자리를 재사용하지 않고 옆자리를 팝니다.`);
  if (!guarded) warnings.push(`base(${base}) 에 gc.pruneExpire=never 를 쓰지 못했습니다 — base 의 gc 가 이 clone 이 빌린 객체를 지우면 clone 이 깨집니다.`);
  if (warnings.length) out.warning = warnings.join(" · ");
  return out;
}

// 오래된 핀 청소(#932) — content-addressed 라 SHA 마다 새 디렉터리(~20MB)가 쌓인다. repo_pin_remove 가 안 불리면
//  (세션 크래시·스킬 스킵·main 이동으로 remove 가 현재 SHA 만 지목) tmpdir 에 누적된다. OS tmp 정리(macOS ~3일·
//  Linux tmpfiles)가 백스톱이지만 장수 박스에선 순간 수백 MB. **데몬이 아니라 핀 호출 시점**(caller-triggered)에,
//  이 repo 의 핀 중 mtime 이 TTL 을 넘긴 것만 best-effort 로 걷는다 — 핀은 읽기전용·재생성 자명이라 안전하고,
//  지금 뜰 SHA(keepSha)와 TTL 미만은 안 건드린다(진행 중 분석 보호). "무인 자동삭제 데몬 금지"(haru) 원칙과 무충돌.
const PIN_TTL_MS = Number(process.env.LIVELY_PIN_TTL_MS) || 14 * 24 * 60 * 60 * 1000; // 14일 (env 로 override — 테스트용)
function sweepStalePins(ctx, base, repo, keepSha) {
  let swept = 0;
  try {
    const root = join(tmpdir(), "lively-pin", repo);
    const now = Date.now();
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === keepSha) continue;      // 현재 SHA 는 보호
      const dir = join(root, ent.name);
      let mtimeMs; try { mtimeMs = statSync(dir).mtimeMs; } catch { continue; }
      if (now - mtimeMs < PIN_TTL_MS) continue;                       // TTL 미만 = 진행 중일 수 있음 → 보존
      ctx.sh("git", ["-C", base, "worktree", "remove", "--force", dir], { allowFail: true }); // 등록+디렉터리
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 등록 없는 고아까지 */ }
      swept++;
    }
    // ⚠ 여기서 `git worktree prune` 을 돌리지 않는다(#3678) — 이 프로세스에서 안 보이는 남의 워크트리까지 지운다.
    //  remove --force 가 등록을 함께 걷었고, 혹 남은 등록은 같은 SHA 를 다시 핀할 때 표적 정리가 치운다(그 경로만).
  } catch { /* root 없음 등 — 무해 */ }
  return swept;
}

// 핀 안내문 — 규약을 반환값에 실어 나른다(스킬이 절차를 중복 서술하지 않아도 되도록).
const pinNote = (pin, repo, sha) =>
  `이후 이 레포의 코드 인용·grep 은 이 핀 경로에서만: ${pin} · 리포트·지식엔 경로가 아니라 '${repo}@${sha}' 로 앵커하라`
  + `(다음 세션이 그 SHA 로 재핀하면 동일 truth 재현) · 끝나면 repo_pin_remove 로 정리.`;

// 코드 근거 분석용 **읽기전용 핀** — base 확보·fetch 후 origin/<ref> 를 **detached** 워크트리로 뜬다.
//  작업 워크트리(repoWorktree)와 목적이 다르다: 브랜치 없음(--detach) = SHA 고정 = 분석 내내 아무도 못 움직임.
//  stale 소스·작업 브랜치 오독·HEAD 드리프트로 잘못된 코드 근거 결론이 나오는 걸 막는다. 핀은 일회용 —
//  영속 앵커는 경로가 아니라 반환 sha(리포트·지식에 repo@sha).
export async function repoPin(ctx, args) {
  const repo = String(args.repo || "").trim();
  if (!REPO_NAME_RE.test(repo)) throw new Error(`레포 이름 형식 오류(영숫자.-_): ${repo}`);
  const base = join(reposDir(), repo);
  const row = registryRow(ctx, repo);
  const { fetchWarning } = await ensureBase(ctx, repo, base, row);
  const { branch: refBranch, note: refNote } = await refBranchOf(ctx, base, args.ref, row);   // ref 없으면 등록한 기본 브랜치(#1723)
  //  fetch 가 실패했으면 이 핀의 SHA 는 «받아 둔 origin» 의 것이다 — 최신이라 믿고 인용하지 않게 알린다.
  const withRef = (o) => ({ ...(refNote ? { ...o, ref_note: refNote, note: `${o.note} · ${refNote}` } : o), ...(fetchWarning ? { fetch_warning: fetchWarning } : {}) });
  const target = `origin/${refBranch}`;
  const sha = ctx.sh("git", ["-C", base, "rev-parse", "--short", target], { allowFail: true }).stdout.trim();
  if (!sha) throw new Error(`ref 해석 실패: ${target} (레포 '${repo}') — ref 이름을 확인하세요.`);
  const pin = pinPathOf(ctx, repo, args.path && String(args.path).trim(), sha);

  // 오래된 핀 GC — 이 핀 호출을 트리거 삼아, 이 repo 의 TTL 넘긴 핀을 걷는다(현재 SHA 는 보호). 누적 릭 방지(#932).
  sweepStalePins(ctx, base, repo, sha);

  // 이미 이 경로에 핀이 있으면 재사용(멱등). 기본 경로는 content-addressed 라 여기 걸리면 곧 같은 SHA 다(다른 SHA 는
  //  애초에 다른 경로 = 스톰프 불가). HEAD 가 그 SHA 와 어긋난 이상 상태만 **우리 자신의 이 경로**를 고쳐 다시 뜬다
  //  — 지우는 건 (기본이면) 이 SHA 의 자리이거나 (지정이면) 호출자가 명시한 자리라, 남의 세션 핀이 아니다(#932).
  if (isGitRepo(ctx, pin)) {
    const cur = ctx.sh("git", ["-C", pin, "rev-parse", "--short", "HEAD"], { allowFail: true }).stdout.trim();
    if (cur === sha) return withRef({ repo, pin, sha, ref: refBranch, base, reused: true, note: pinNote(pin, repo, sha) });
    ctx.sh("git", ["-C", base, "worktree", "remove", "--force", pin], { allowFail: true });
  }
  mkdirSync(dirname(pin), { recursive: true });
  clearStaleRegistrations(ctx, base, { paths: [pin] }); // #932 — 핀 디렉터리가 외부에서 지워졌으면 등록만 남아 이 경로의 add 를 막는다(그 등록만, #3678)
  const r = ctx.sh("git", ["-C", base, "worktree", "add", "--detach", pin, target], { allowFail: true });
  if (r.code !== 0) throw new Error(`핀 생성 실패(${repo}@${target}): ${gitFail(r.stderr)}`);
  const committed = ctx.sh("git", ["-C", pin, "log", "-1", "--format=%ci"], { allowFail: true }).stdout.trim() || null;
  return withRef({ repo, pin, sha, ref: refBranch, base, committed, reused: false, note: pinNote(pin, repo, sha) });
}

// 핀 제거 — 읽기전용 사본이라 force(낙서 무시). base·작업 워크트리 무영향.
//  기본 경로는 content-addressed(repo+sha)라 지우려면 SHA 를 알아야 한다 → origin/<ref> 를 repoPin 과 **같은 방식**으로
//  다시 해석해 **그 SHA 의 핀만** 지운다(다른 세션의 다른 SHA 핀은 안 건드린다, #932). ref 는 핀 때와 같은 값을 줘야
//  맞아떨어진다(기본은 repoPin 과 같은 기준 — 등록한 기본 브랜치, 없으면 원격 기본 브랜치 — 로 대칭). **best-effort**: 핀이 이미 없어도(main 이 그새 움직여 SHA 가 달라졌거나
//  tmpdir 이 청소됐거나) 에러가 아니다 — 스테일 등록만 털고 removed:null 로 알린다(남는 detached 핀은 읽기전용이라 무해).
export async function repoPinRemove(ctx, args) {
  const repo = String(args.repo || "").trim();
  if (!REPO_NAME_RE.test(repo)) throw new Error(`레포 이름 형식 오류(영숫자.-_): ${repo}`);
  const base = join(reposDir(), repo);
  const explicit = args.path && String(args.path).trim();
  let pin, why = "";
  if (explicit) {
    pin = isAbsolute(explicit) ? explicit : join(ctx.cwd, explicit);
  } else {
    const { branch: refBranch, note: refNote } = await refBranchOf(ctx, base, args.ref, registryRow(ctx, repo));
    why = refNote ? ` · ${refNote}` : "";   // 기준이 핀 만들 때와 달라졌을 수 있다(게이트웨이 무응답 등) — 못 찾았을 때 그 사유를 함께 준다
    const sha = ctx.sh("git", ["-C", base, "rev-parse", "--short", `origin/${refBranch}`], { allowFail: true }).stdout.trim();
    // ref 를 못 풀면 지울 핀을 특정할 수 없다 — 종전엔 여기서 blanket prune 을 돌렸지만(«스테일 등록만 정리»), 그게 남의
    //  워크트리를 지우던 바로 그 경로라 이제 아무것도 안 한다(#3678). 표적 없이 지울 것은 없다.
    if (!sha) return { removed: null, note: `핀을 특정할 수 없습니다(origin/${refBranch} 해석 실패) — 아무것도 지우지 않았습니다.` };
    pin = pinPathOf(ctx, repo, null, sha);
  }
  const r = ctx.sh("git", ["-C", base, "worktree", "remove", "--force", pin], { allowFail: true });
  clearStaleRegistrations(ctx, base, { paths: [pin] }); // 디렉터리는 이미 없고 등록만 남은 경우 — 그 등록만(#3678: blanket prune 금지)
  if (r.code !== 0) return { removed: null, note: `핀이 이미 없거나 제거 실패(무해): ${gitFail(r.stderr)}${why}` };
  return { removed: pin };
}

// lively_*_repo_worktree 로 만든 워크트리 제거(base·다른 워크트리 무영향). 미커밋 변경 있으면 실패(force 로 강제).
export function repoWorktreeRemove(ctx, args) {
  const repo = String(args.repo || "").trim();
  if (!REPO_NAME_RE.test(repo)) throw new Error(`레포 이름 형식 오류(영숫자.-_): ${repo}`);
  const base = join(reposDir(), repo);
  const wt = resolveWtPath(ctx.cwd, repo, args.path && String(args.path).trim());
  if (cloneGitDirOf(wt, base)) {
    // clone 작업면은 git 이 지울 등록이 없어 폴더째 지운다. 그래서 git worktree remove 가 지켜 주던 «미커밋 거부» 를 여기서
    //  지키고, worktree 엔 없던 «미push 거부» 를 더한다 — 커밋이 이 폴더에만 있기 때문이다.
    if (!args.force) {
      const st = ctx.sh("git", ["-C", wt, "status", "--porcelain", "--untracked-files=normal"], { allowFail: true });
      if (st.code !== 0 || st.stdout.trim()) throw new Error(`워크트리 제거 실패: 커밋하지 않은 변경이 있거나 상태를 읽지 못했습니다(force 로 강제).`);
      // HEAD 와 --all 을 함께 본다 — detached HEAD 의 커밋·stash·태그만 가리키는 커밋도 원격에 없으면 이 폴더에만 있다.
      const lg = ctx.sh("git", ["-C", wt, "log", "--oneline", "-n", "5", "HEAD", "--all", "--not", "--remotes"], { allowFail: true });
      if (lg.code !== 0 || lg.stdout.trim()) {
        throw new Error(`워크트리 제거 실패: push 하지 않은 커밋(stash·detached 포함)이 있습니다 — clone 모드라 폴더를 지우면 영구히 사라집니다.`
          + ` push 하거나, 정말 버릴 것이면 force 로 지우세요.\n${lg.stdout.trim()}`);
      }
    }
    rmSync(wt, { recursive: true, force: true });
    return { removed: wt };
  }
  const r = ctx.sh("git", ["-C", base, "worktree", "remove", ...(args.force ? ["--force"] : []), wt], { allowFail: true });
  if (r.code !== 0) throw new Error(`워크트리 제거 실패: ${gitFail(r.stderr)}`);
  return { removed: wt };
}
