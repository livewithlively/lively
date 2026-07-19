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
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

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

// 스테일 워크트리 등록 정리 — 워크트리 디렉터리가 사라져도 git 은 등록을 남기고, 그 등록은 **prunable 이어도
//  브랜치를 계속 점유**한다(-b 도 attach 도 실패). 청소되는 임시경로(스크래치패드 등)에 뜬 워크트리가 지워지면
//  그 브랜치가 사람이 손으로 prune 할 때까지 영구히 막히므로, **실제 add 직전에** 턴다(#932). 살아있는 등록엔 무해.
//  '직전에만' 인 이유: base 하나에 워크트리가 100개를 넘기도 해서 매 호출(멱등 no-op 포함) 스캔은 낭비고,
//   동시에 도는 다른 세션의 worktree add 와 겹칠 창만 넓힌다 — 서버 provisionProjectRepos 도 같은 게이팅이다.
const pruneWorktrees = (ctx, base) => { ctx.sh("git", ["-C", base, "worktree", "prune"], { allowFail: true }); };

// 이 base 의 워크트리들이 **점유 중인** 브랜치 → 그 워크트리 경로. git 은 한 브랜치를 두 워크트리에 못 건다.
function checkedOutBranches(ctx, base) {
  const out = ctx.sh("git", ["-C", base, "worktree", "list", "--porcelain"], { allowFail: true }).stdout || "";
  const map = new Map();
  let at = null;
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) at = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/")) map.set(line.slice("branch refs/heads/".length), at);
  }
  return map;
}

// 점유되지 않은 첫 이름 — want, want-2, want-3 … canonical 슬롯 밖 워크트리끼리도 안 겹치게(#932).
function freeBranch(taken, want) {
  if (!taken.has(want)) return want;
  for (let i = 2; i <= 99; i++) if (!taken.has(`${want}-${i}`)) return `${want}-${i}`;
  throw new Error(`쓸 수 있는 브랜치 이름이 없습니다(${want}, ${want}-2..99 전부 다른 워크트리가 점유 중) — branch 인자로 직접 지정하세요.`);
}

// git 실패 한 줄 요약 — git 은 진행 메시지("Preparing worktree …")도 **stderr 에** 쓰므로 첫 줄이 곧 원인이 아니다
//  (그래서 예전 메시지는 실패를 "Preparing worktree …" 로 보여줬다 — 원인이 안 보이고 준비 중처럼 읽혔다, #932).
//  fatal:/error: 줄을 우선 집고, 없으면 마지막 비어있지 않은 줄(보통 그게 원인).
function gitFail(stderr) {
  const lines = (stderr || "").split("\n").map((s) => s.trim()).filter(Boolean);
  return lines.find((l) => /^(fatal|error):/i.test(l)) || lines[lines.length - 1] || "(원인 미상)";
}

// 실패 안내 — git 의 fatal 은 점유자 경로까지만 알려준다. **왜** 안 되는지(브랜치 1개 = 워크트리 1개)와
//  **어떻게 빠져나오는지**(그 워크트리에서 작업 / branch 인자)는 말해주지 않아 사람이 매번 다시 알아내야 한다(#932).
//  게다가 3단 폴백의 마지막 실패가 -b 라 fatal 이 'already exists' 로 끝나 점유 사실 자체가 안 보인다.
function branchHeldNote(ctx, base, branch) {
  const at = checkedOutBranches(ctx, base).get(branch);
  return at
    ? ` — 브랜치 '${branch}' 는 이미 '${at}' 워크트리가 쥐고 있습니다(git 은 한 브랜치를 두 워크트리에 못 겁니다).`
      + ` 거기서 작업하거나, branch 인자로 다른 이름을 주세요.`
    : "";
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
const canonicalOf = (marker, repo) => (marker ? join(marker.dir, repo) : null);

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

// base 확보 — 로컬에 없으면 레지스트리 clone_url 로 clone, 있으면 fetch(refs 만; 워킹트리 미변경 = RO 규율).
//  작업 워크트리(repoWorktree)·읽기전용 핀(repoPin) 공용 진입.
async function ensureBase(ctx, repo, base) {
  if (!isGitRepo(ctx, base)) {
    const reg = await ctx.api("/api/ui/repos");
    const row = (reg.domainmapRepos || []).find((r) => r && r.name === repo);
    const url = row && row.clone_url;
    if (!url) throw new Error(`레포 '${repo}' 가 이 머신에 없고 등록된 clone 주소도 없습니다 — 관리탭 ▸ 레포에서 git 주소를 연결하세요.`);
    mkdirSync(dirname(base), { recursive: true });
    const c = ctx.sh("git", ["clone", url, base], { allowFail: true });
    if (c.code !== 0) throw new Error(`git clone 실패(${repo}): ${gitFail(c.stderr)}`);
  } else {
    ctx.sh("git", ["-C", base, "fetch", "origin"], { allowFail: true }); // best-effort(오프라인 무시)
  }
}

// 핀 경로 — 지정 없으면 tmpdir 밑 **repo + SHA** 로 content-addressed(#932). 작업 워크트리와 섞이지 않게 별도 루트.
//  ⚠ 왜 SHA 를 박나: macOS `tmpdir()` 는 **세션당이 아니라 유저당** 하나다. sha 없이 `lively-pin/<repo>` 한 자리를
//   쓰면, 세션 A 가 SHA1 을 핀한 사이 main 이 전진해 세션 B 가 SHA2 를 핀할 때 repoPin 이 A 의 핀을 force-remove 하고
//   SHA2 로 덮어쓴다 — A 는 같은 경로를 계속 읽는데 발밑 코드가 바뀐다(핀이 막으려던 HEAD 드리프트를 핀이 세션 간에
//   재도입). SHA 를 경로에 박으면 같은 SHA 는 공유(dedup)·다른 SHA 는 공존, force-remove 자체가 필요 없어진다.
//   지정 경로(p)는 호출자가 자리를 명시한 것이라 그대로 둔다(그 자리의 스톰프는 호출자 책임).
const pinPathOf = (ctx, repo, p, sha) => (p ? (isAbsolute(p) ? p : join(ctx.cwd, p)) : join(tmpdir(), "lively-pin", repo, sha));

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

  // ① base 확보(clone or fetch) — 공용.
  await ensureBase(ctx, repo, base);

  // ② 경로 결정 — **브랜치가 경로에 달려 있으므로**(아래) 경로가 먼저다. 마커는 한 번만 걸어 올라가 재사용한다.
  const refBranch = args.ref && BRANCH_RE.test(String(args.ref).trim()) ? String(args.ref).trim() : remoteDefaultBranch(ctx, base);
  const marker = findProjectMarkerUp(ctx.cwd);
  const wt = resolveWtPath(ctx.cwd, repo, args.path && String(args.path).trim(), marker);

  // 이미 워크트리면 그대로(멱등) — 재실행 안전. **브랜치를 고르기 전에** 나간다: 있는 워크트리를 돌려주는 데
  //  새 이름은 필요 없고, 이름 고르기가 실패해도(전부 점유) 여기까지 못 오면 안 되기 때문(#932).
  if (isGitRepo(ctx, wt)) {
    const b = ctx.sh("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).stdout.trim();
    return { repo, worktree: wt, branch: b || null, base, note: "이미 워크트리가 있어 그대로 사용합니다." };
  }

  // ③ 진짜로 만들 때만 스테일 등록을 턴다 — 서버 provisionProjectRepos 와 같은 게이팅(멱등 no-op 엔 안 돈다).
  //  **브랜치를 고르기 전에** 돌아야 한다: 사라진 워크트리의 등록도 점유로 세므로, 안 털면 아래 freeBranch 가
  //  이미 죽은 wt/<repo> 를 점유중으로 보고 -2 로 건너뛰어 이름을 영영 잃는다.
  pruneWorktrees(ctx, base);

  // ④ 브랜치 기본값 — **canonical 슬롯일 때만** project/<id>: 서버 provisionProjectRepos 와 같은 자리·같은 이름이라
  //  서로 멱등이다(먼저 뜬 쪽을 뒤에 온 쪽이 그대로 재사용). 슬롯 밖(path 를 따로 준 경우)에까지 project/<id> 를
  //  걸면 그 프로젝트의 provision 이 502 로 죽는다 — **싱글턴 이름은 싱글턴 자리에만**(#932). 밖이면 이 워크트리
  //  전용 wt/<repo>[-n](점유되지 않은 첫 이름 — 슬롯 밖 워크트리끼리도 안 겹치게).
  const pid = marker?.meta.project_id ?? null;
  const canonical = canonicalOf(marker, repo);
  const branch = (args.branch && String(args.branch).trim())
    || (pid && canonical && wt === canonical ? `project/${pid}` : freeBranch(checkedOutBranches(ctx, base), `wt/${repo}`));
  if (!BRANCH_RE.test(branch)) throw new Error(`브랜치명 형식 오류: ${branch}`);

  // ⑤ worktree add — 새 브랜치(origin/<ref> 최신 기준) 시도 → 같은 브랜치가 이미 있으면 attach 폴백(provision 동형).
  mkdirSync(dirname(wt), { recursive: true });
  let r = ctx.sh("git", ["-C", base, "worktree", "add", wt, "-b", branch, `origin/${refBranch}`], { allowFail: true });
  if (r.code !== 0) r = ctx.sh("git", ["-C", base, "worktree", "add", wt, branch], { allowFail: true });          // 기존 브랜치 attach
  if (r.code !== 0) r = ctx.sh("git", ["-C", base, "worktree", "add", wt, "-b", branch], { allowFail: true });     // origin/<ref> 없을 때 base HEAD
  if (r.code !== 0) throw new Error(`워크트리 생성 실패(${repo}): ${gitFail(r.stderr)}${branchHeldNote(ctx, base, branch)}`);

  return { repo, worktree: wt, branch, base, ref: refBranch,
    note: `이 경로에서 작업하세요: ${wt} · base(${base})는 pristine 공유 원본이라 직접 작업 금지(커밋·빌드는 워크트리에서).` };
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
    if (swept) ctx.sh("git", ["-C", base, "worktree", "prune"], { allowFail: true });
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
  await ensureBase(ctx, repo, base);
  const refBranch = args.ref && BRANCH_RE.test(String(args.ref).trim()) ? String(args.ref).trim() : remoteDefaultBranch(ctx, base);
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
    if (cur === sha) return { repo, pin, sha, ref: refBranch, base, reused: true, note: pinNote(pin, repo, sha) };
    ctx.sh("git", ["-C", base, "worktree", "remove", "--force", pin], { allowFail: true });
  }
  mkdirSync(dirname(pin), { recursive: true });
  pruneWorktrees(ctx, base); // #932 — 핀 디렉터리가 외부에서 지워졌으면 등록만 남아 이 경로의 add 를 막는다
  const r = ctx.sh("git", ["-C", base, "worktree", "add", "--detach", pin, target], { allowFail: true });
  if (r.code !== 0) throw new Error(`핀 생성 실패(${repo}@${target}): ${gitFail(r.stderr)}`);
  const committed = ctx.sh("git", ["-C", pin, "log", "-1", "--format=%ci"], { allowFail: true }).stdout.trim() || null;
  return { repo, pin, sha, ref: refBranch, base, committed, reused: false, note: pinNote(pin, repo, sha) };
}

// 핀 제거 — 읽기전용 사본이라 force(낙서 무시). base·작업 워크트리 무영향.
//  기본 경로는 content-addressed(repo+sha)라 지우려면 SHA 를 알아야 한다 → origin/<ref> 를 repoPin 과 **같은 방식**으로
//  다시 해석해 **그 SHA 의 핀만** 지운다(다른 세션의 다른 SHA 핀은 안 건드린다, #932). ref 는 핀 때와 같은 값을 줘야
//  맞아떨어진다(기본은 원격 기본 브랜치로 대칭). **best-effort**: 핀이 이미 없어도(main 이 그새 움직여 SHA 가 달라졌거나
//  tmpdir 이 청소됐거나) 에러가 아니다 — 스테일 등록만 털고 removed:null 로 알린다(남는 detached 핀은 읽기전용이라 무해).
export function repoPinRemove(ctx, args) {
  const repo = String(args.repo || "").trim();
  if (!REPO_NAME_RE.test(repo)) throw new Error(`레포 이름 형식 오류(영숫자.-_): ${repo}`);
  const base = join(reposDir(), repo);
  const explicit = args.path && String(args.path).trim();
  let pin;
  if (explicit) {
    pin = isAbsolute(explicit) ? explicit : join(ctx.cwd, explicit);
  } else {
    const refBranch = args.ref && BRANCH_RE.test(String(args.ref).trim()) ? String(args.ref).trim() : remoteDefaultBranch(ctx, base);
    const sha = ctx.sh("git", ["-C", base, "rev-parse", "--short", `origin/${refBranch}`], { allowFail: true }).stdout.trim();
    if (!sha) { pruneWorktrees(ctx, base); return { removed: null, note: `핀을 특정할 수 없습니다(origin/${refBranch} 해석 실패) — 스테일 등록만 정리했습니다.` }; }
    pin = pinPathOf(ctx, repo, null, sha);
  }
  const r = ctx.sh("git", ["-C", base, "worktree", "remove", "--force", pin], { allowFail: true });
  pruneWorktrees(ctx, base); // 남은 등록 정리
  if (r.code !== 0) return { removed: null, note: `핀이 이미 없거나 제거 실패(무해): ${gitFail(r.stderr)}` };
  return { removed: pin };
}

// lively_*_repo_worktree 로 만든 워크트리 제거(base·다른 워크트리 무영향). 미커밋 변경 있으면 실패(force 로 강제).
export function repoWorktreeRemove(ctx, args) {
  const repo = String(args.repo || "").trim();
  if (!REPO_NAME_RE.test(repo)) throw new Error(`레포 이름 형식 오류(영숫자.-_): ${repo}`);
  const base = join(reposDir(), repo);
  const wt = resolveWtPath(ctx.cwd, repo, args.path && String(args.path).trim());
  const r = ctx.sh("git", ["-C", base, "worktree", "remove", ...(args.force ? ["--force"] : []), wt], { allowFail: true });
  if (r.code !== 0) throw new Error(`워크트리 제거 실패: ${gitFail(r.stderr)}`);
  return { removed: wt };
}
