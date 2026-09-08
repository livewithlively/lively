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
//  ⚠ 공유 base 위에서 지켜야 할 셋(#3678, 2026-09-08 사고 — 다른 프로젝트 세션의 admin 이 하루 5회 지워지고 커밋이 남의
//   브랜치에 얹힘): ① `git worktree prune` 을 부르지 않는다(안 보이는 경로 = 남의 컨테이너일 수 있다 → 표적 정리만)
//   ② admin id 를 basename 에 맡기지 않는다(프로젝트별 고유 id 로 relink) ③ 있는 워크트리를 재사용하기 전에 admin 이
//   자기 것인지 확인한다(아니면 중단·경고). 서버 provision·work.mjs·preview-stage 도 ①을 같이 지킨다.
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, realpathSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
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

// git 실패 한 줄 요약 — git 은 진행 메시지("Preparing worktree …")도 **stderr 에** 쓰므로 첫 줄이 곧 원인이 아니다
//  (그래서 예전 메시지는 실패를 "Preparing worktree …" 로 보여줬다 — 원인이 안 보이고 준비 중처럼 읽혔다, #932).
//  fatal:/error: 줄을 우선 집고, 없으면 마지막 비어있지 않은 줄(보통 그게 원인).
function gitFail(stderr) {
  const lines = (stderr || "").split("\n").map((s) => s.trim()).filter(Boolean);
  return lines.find((l) => /^(fatal|error):/i.test(l)) || lines[lines.length - 1] || "(원인 미상)";
}

// 인증 실패 안내(#1077) — git 은 'Permission denied (publickey)' / 'could not read Username' 까지만 말하고
//  **이 박스에서 그걸 어떻게 푸는지**는 말해주지 않는다. 라이블리엔 정규 경로(자격을 DB에 두고 세션 홈에
//  materialize)가 있는데 실패 지점에서 아무도 그리로 안내하지 않아, 실사용에선 세션 셸에서 ssh-keygen 으로
//  홈에 키를 직접 만드는 우회가 나왔다 — 되긴 하지만 자격이 라이블리 밖이라 관리탭 가시성·오프보딩 회수·
//  재프로비저닝 복원에서 전부 빠진다. 그래서 실패 그 자리에서 정규 경로를 알려준다.
//  ⚠ 판정은 stderr 문자열이라 느슨하다(호스트마다 문구가 다르다). 오탐해도 손해는 안내 한 줄이라 넓게 잡는다.
const AUTH_FAIL_RE = /permission denied|could not read username|authentication failed|access denied|repository not found|invalid username or token/i;
export function gitHostOf(url) {          // export=테스트용·순수
  const s = String(url || "");
  const scp = s.match(/^[^/]+@([^:]+):/);                 // scp 형 git@host:path
  if (scp) return scp[1];
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)/i); // scheme://[user@]host
  return m ? m[1] : "";
}
export function authNote(stderr, url) {   // export=테스트용·순수
  if (!AUTH_FAIL_RE.test(stderr || "")) return "";
  const host = gitHostOf(url);
  const h = host || "그 호스트";
  return ` — 이 계정에 ${h} git 자격이 없어 보입니다.`
    + ` \`me_git_credential_set {kind:"ssh"${host ? `, host:"${host}"` : ""}}\` 로 등록하면(웹은 [내 설정 ▸ 레포 접근 ▸ git 인증 관리])`
    + ` 공개키가 나옵니다 — 그 공개키를 ${h} 계정에 등록하면 바로 됩니다.`
    + ` (셸에서 ssh-keygen 으로 직접 만들지 마세요 — 그 키는 라이블리가 모르니 회수·복원이 안 됩니다.)`;
}

// 실패 안내 — git 의 fatal 은 점유자 경로까지만 알려준다. **왜** 안 되는지(브랜치 1개 = 워크트리 1개)와
//  **어떻게 빠져나오는지**(그 워크트리에서 작업 / branch 인자)는 말해주지 않아 사람이 매번 다시 알아내야 한다(#932).
//  게다가 3단 폴백의 마지막 실패가 -b 라 fatal 이 'already exists' 로 끝나 점유 사실 자체가 안 보인다.
function branchHeldNote(ctx, base, branch) {
  const at = checkedOutBranches(listWorktrees(ctx, base)).get(branch);
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
    if (c.code !== 0) throw new Error(`git clone 실패(${repo}): ${gitFail(c.stderr)}${authNote(c.stderr, url)}`);
  } else {
    ctx.sh("git", ["-C", base, "fetch", "origin"], { allowFail: true }); // best-effort(오프라인 무시)
  }
  // gc 의 자동 워크트리 prune 을 끈다(#3678) — `git gc --auto`(commit·fetch 뒤 저절로 돈다)는 gc.worktreePruneExpire(기본 3개월)
  //  보다 오래 index 를 안 건드린 «경로 없는» 등록을 지운다. 컨테이너에서 «경로 없음» 은 «다른 프로젝트의 살아 있는
  //  워크트리」일 수 있으므로 base 에서 영구히 끈다(T0 실측: index 4개월 묵은 A 를 B 의 gc 가 지우던 것이 never 로 멈춤).
  //  base 에 만지는 건 이 config 키 하나뿐(워킹트리·ref 무변경 = RO 규율 유지). 워크트리들은 base 의 config 를 공유하므로
  //  어느 워크트리에서 gc 가 돌아도 같이 막힌다. 멱등·best-effort.
  ctx.sh("git", ["-C", base, "config", "gc.worktreePruneExpire", "never"], { allowFail: true });
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
  return `${name}-${createHash("sha1").update(resolve(wt)).digest("hex").slice(0, 8)}`;
}
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

  const pid = marker?.meta.project_id ?? null;
  const canonical = canonicalOf(marker, repo);
  const isSlot = pid !== null && canonical !== null && wt === canonical;
  const adminId = adminIdFor(wt, pid, canonical);

  // 이미 워크트리면 재사용(멱등) — 단 **내 것인지 먼저 확인한다**(#3678 T2). **브랜치를 고르기 전에** 나간다: 있는
  //  워크트리를 돌려주는 데 새 이름은 필요 없고, 이름 고르기가 실패해도(전부 점유) 여기까지 못 오면 안 되기 때문(#932).
  //  판정은 `.git` 의 존재다(git 이 열 수 있는지가 아니라) — gitfile 이 파손·미아가 된 워크트리도 «새로 만들 자리» 가 아니라
  //  «검증해서 알려 줄 자리» 다(그 자리엔 사람의 파일이 있다).
  if (existsSync(gitfileOf(wt)) || isGitRepo(ctx, wt)) {
    const { admin } = verifyOwnAdmin(wt);                       // 남의 admin 을 잇고 있으면 여기서 멈춘다(조용히 재사용 금지)
    const adminNow = admin ? relinkAdmin(wt, admin, adminId) : null; // 서버 provision 등이 basename id 로 만든 것도 고유 id 로
    const b = ctx.sh("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).stdout.trim();
    const out = { repo, worktree: wt, branch: b || null, base, admin: adminNow ? basename(adminNow) : null, note: "이미 워크트리가 있어 그대로 사용합니다." };
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
  const branch = (args.branch && String(args.branch).trim())
    || (isSlot ? `project/${pid}` : freeBranch(checkedOutBranches(live), `wt/${repo}`));
  if (!BRANCH_RE.test(branch)) throw new Error(`브랜치명 형식 오류: ${branch}`);
  clearStaleRegistrations(ctx, base, { paths: [wt], branch }, regs);

  // ⑤ worktree add — 새 브랜치(origin/<ref> 최신 기준) 시도 → 같은 브랜치가 이미 있으면 attach 폴백(provision 동형).
  let r = ctx.sh("git", ["-C", base, "worktree", "add", wt, "-b", branch, `origin/${refBranch}`], { allowFail: true });
  if (r.code !== 0) r = ctx.sh("git", ["-C", base, "worktree", "add", wt, branch], { allowFail: true });          // 기존 브랜치 attach
  if (r.code !== 0) r = ctx.sh("git", ["-C", base, "worktree", "add", wt, "-b", branch], { allowFail: true });     // origin/<ref> 없을 때 base HEAD
  if (r.code !== 0) throw new Error(`워크트리 생성 실패(${repo}): ${gitFail(r.stderr)}${branchHeldNote(ctx, base, branch)}`);

  // ⑥ admin 을 고유 id 로(#3678) — git 이 지은 basename id(`<repo>`·`<repo>N`)는 프로젝트가 달라도 겹친다.
  const admin = adminOf(wt);
  const adminNow = admin ? relinkAdmin(wt, admin, adminId) : null;

  return { repo, worktree: wt, branch, base, ref: refBranch, admin: adminNow ? basename(adminNow) : null,
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
  clearStaleRegistrations(ctx, base, { paths: [pin] }); // #932 — 핀 디렉터리가 외부에서 지워졌으면 등록만 남아 이 경로의 add 를 막는다(그 등록만, #3678)
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
    // ref 를 못 풀면 지울 핀을 특정할 수 없다 — 종전엔 여기서 blanket prune 을 돌렸지만(«스테일 등록만 정리»), 그게 남의
    //  워크트리를 지우던 바로 그 경로라 이제 아무것도 안 한다(#3678). 표적 없이 지울 것은 없다.
    if (!sha) return { removed: null, note: `핀을 특정할 수 없습니다(origin/${refBranch} 해석 실패) — 아무것도 지우지 않았습니다.` };
    pin = pinPathOf(ctx, repo, null, sha);
  }
  const r = ctx.sh("git", ["-C", base, "worktree", "remove", "--force", pin], { allowFail: true });
  clearStaleRegistrations(ctx, base, { paths: [pin] }); // 디렉터리는 이미 없고 등록만 남은 경우 — 그 등록만(#3678: blanket prune 금지)
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
