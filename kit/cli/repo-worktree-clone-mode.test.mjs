#!/usr/bin/env node
// repo-worktree-core clone 모드 사양 테스트.
//  실행: node kit/cli/repo-worktree-clone-mode.test.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const HERE = join(fileURLToPath(import.meta.url), "..");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.error(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why || "조건 불만족"));

const SB = realpathSync(mkdtempSync(join(tmpdir(), "wt-clone-test-")));
process.env.LIVELY_WORKTREE_MODE = "worktree";   // 이 머신의 ~/.lively/worktree-mode 에 휘둘리지 않게
const GLOBAL_CFG = join(SB, "gitconfig");          // 이 컴퓨터의 git 설정(status.showUntrackedFiles 등)과 끊는다
writeFileSync(GLOBAL_CFG, "[init]\n\tdefaultBranch = main\n");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = GLOBAL_CFG;
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "wt-clone-test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "wt-clone-test@test.local";
process.env.CODEX_THREAD_ID = process.env.CODEX_SESSION_ID = process.env.CLAUDE_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID = "";
const SESSION_A = "wt-clone-test-A";
const SESSION_B = "wt-clone-test-B";
process.env.LIVELY_SESSION_ID = SESSION_A;
const sh = (cmd, args = [], { cwd = SB, allowFail = false } = {}) => {
  try { return { stdout: execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "", code: 0 }; }
  catch (e) { if (!allowFail) throw e; return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.status ?? 1 }; }
};
const git = (dir, ...args) => sh("git", ["-C", dir, ...args]).stdout.trim();
const gitTry = (dir, ...args) => sh("git", ["-C", dir, ...args], { allowFail: true });
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const samePath = (a, b) => typeof a === "string" && real(a) === real(b);
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e || new Error("throw(빈 값)"); } };
const mk = (p) => { mkdirSync(p, { recursive: true }); return p; };

(async () => {
  // ── 픽스처: origin(main + feat-x) ← base, base 에만 로컬 브랜치 loc-b ──
  const ORIGIN = join(SB, "origin-repo");
  sh("git", ["init", "-q", "--initial-branch=main", ORIGIN]);
  git(ORIGIN, "commit", "-q", "--allow-empty", "-m", "init");
  git(ORIGIN, "checkout", "-q", "-b", "feat-x");
  git(ORIGIN, "commit", "-q", "--allow-empty", "-m", "feat");
  git(ORIGIN, "checkout", "-q", "main");
  sh("git", ["clone", "-q", ORIGIN, "base"]);
  const BASE = join(SB, "base");
  const locSha = git(BASE, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "loc-only");
  git(BASE, "branch", "loc-b", locSha);
  const originMain = git(BASE, "rev-parse", "refs/remotes/origin/main");
  const originFeat = git(BASE, "rev-parse", "refs/remotes/origin/feat-x");
  const baseOriginUrl = git(BASE, "config", "--get", "remote.origin.url");
  const baseWtListBefore = git(BASE, "worktree", "list", "--porcelain");
  const remoteRefs = (dir) => git(dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/origin/")
    .split("\n").filter((l) => l && !l.startsWith("refs/remotes/origin/HEAD ")).sort().join("\n");
  const baseRemoteRefs = remoteRefs(BASE);

  process.env.LIVELY_REPOS_DIR = SB;
  process.env.TMPDIR = join(SB, "ostmp");
  mk(join(SB, "ostmp"));
  const { repoWorktree, repoWorktreeRemove, worktreeMode } = await import(pathToFileURL(join(HERE, "repo-worktree-core.mjs")));

  const ctx = (cwd) => ({ cwd, sh: (c, a, o) => sh(c, a, { ...o, cwd: o?.cwd ?? cwd }), api: async () => ({ domainmapRepos: [], repos: [] }) });
  const asSession = async (id, fn) => { const prev = process.env.LIVELY_SESSION_ID; process.env.LIVELY_SESSION_ID = id; try { return await fn(); } finally { process.env.LIVELY_SESSION_ID = prev; } };
  const headBranch = (p) => gitTry(p, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  const headSha = (p) => gitTry(p, "rev-parse", "HEAD").stdout.trim();
  const isGitDir = (p) => { try { return statSync(join(p, ".git")).isDirectory(); } catch { return false; } };
  const P = mk(join(SB, "p"));

  // ── 1) worktreeMode — 우선순위·무효값·대소문자·공백 ──
  const MODEDIR = mk(join(SB, "modefiles"));
  const CLONE_F = join(MODEDIR, "clone"), WORKTREE_F = join(MODEDIR, "worktree"), GARBAGE_F = join(MODEDIR, "garbage"), NONE_F = join(MODEDIR, "absent");
  writeFileSync(CLONE_F, "  CLONE \n");
  writeFileSync(WORKTREE_F, "worktree\n");
  writeFileSync(GARBAGE_F, "garbage\n");
  const mode = (...a) => { try { return worktreeMode(...a); } catch (e) { return `THROW:${e?.message}`; } };
  const E = (v) => ({ LIVELY_WORKTREE_MODE: v });
  check("mode: asked=clone 이 env·file(worktree) 보다 우선", mode("clone", E("worktree"), WORKTREE_F) === "clone", mode("clone", E("worktree"), WORKTREE_F));
  check("mode: asked=worktree 가 env·file(clone) 보다 우선", mode("worktree", E("clone"), CLONE_F) === "worktree", mode("worktree", E("clone"), CLONE_F));
  check("mode: asked 없으면 env(clone) 가 file(worktree) 보다 우선", mode(undefined, E("clone"), WORKTREE_F) === "clone", mode(undefined, E("clone"), WORKTREE_F));
  check("mode: asked 빈 문자열은 없는 것으로 보고 env 를 따른다", mode("", E("clone"), NONE_F) === "clone", mode("", E("clone"), NONE_F));
  check("mode: env 없으면 file(앞뒤 공백·개행·대문자) 을 따른다", mode(undefined, {}, CLONE_F) === "clone", mode(undefined, {}, CLONE_F));
  check("mode: 아무것도 없으면 worktree", mode(undefined, {}, NONE_F) === "worktree", mode(undefined, {}, NONE_F));
  check("mode: asked 가 모르는 값이면 예외", String(mode("bogus", {}, NONE_F)).startsWith("THROW:"), mode("bogus", {}, NONE_F));
  check("mode: env 의 모르는 값은 무시하고 file 로", mode(undefined, E("bogus"), CLONE_F) === "clone", mode(undefined, E("bogus"), CLONE_F));
  check("mode: file 의 모르는 값은 무시하고 worktree", mode(undefined, {}, GARBAGE_F) === "worktree", mode(undefined, {}, GARBAGE_F));
  check("mode: asked 대소문자 무시(CLONE)", mode("CLONE", {}, NONE_F) === "clone", mode("CLONE", {}, NONE_F));
  check("mode: env 대소문자 무시(ClOnE)", mode(undefined, E("ClOnE"), NONE_F) === "clone", mode(undefined, E("ClOnE"), NONE_F));

  // ── 2) 생성 — 기본 자리(프로젝트 밖 세션) ──
  const WS1 = mk(join(SB, "ws1"));
  let r1, r1err;
  try { r1 = await repoWorktree(ctx(WS1), { repo: "base", mode: "clone" }); } catch (e) { r1err = e; }
  check("clone 생성: 예외 없음", !r1err, r1err?.message);
  const WT1 = join(WS1, "base");
  check("clone 생성: 경로 = <cwd>/<repo>", samePath(r1?.worktree, WT1), r1?.worktree);
  check("clone 생성: 반환 mode=clone · admin=null · base=<reposDir>/<repo>",
    r1?.mode === "clone" && r1?.admin === null && samePath(r1?.base, BASE), JSON.stringify(r1 && { mode: r1.mode, admin: r1.admin, base: r1.base }));
  check("clone 생성: <wt>/.git 은 디렉터리", isGitDir(WT1), "gitfile 이거나 없음");
  const altFile = join(WT1, ".git", "objects", "info", "alternates");
  const altLines = existsSync(altFile) ? readFileSync(altFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [];
  check("clone 생성: alternates 에 <base>/.git/objects",
    altLines.some((l) => samePath(resolve(join(WT1, ".git", "objects"), l), join(BASE, ".git", "objects"))), JSON.stringify(altLines));
  check("clone 생성: base 의 worktree list 불변", git(BASE, "worktree", "list", "--porcelain") === baseWtListBefore, git(BASE, "worktree", "list"));
  check("clone 생성: origin 주소 = base 의 origin 주소",
    gitTry(WT1, "config", "--get", "remote.origin.url").stdout.trim() === baseOriginUrl, gitTry(WT1, "config", "--get", "remote.origin.url").stdout);
  check("clone 생성: base 의 refs/remotes/origin/* 를 그대로 가짐", existsSync(WT1) && remoteRefs(WT1) === baseRemoteRefs,
    existsSync(WT1) ? remoteRefs(WT1) : "작업면 없음");
  check("clone 생성: origin/HEAD 는 base 와 같은 symref(값으로 굳지 않음)",
    gitTry(WT1, "symbolic-ref", "refs/remotes/origin/HEAD").stdout.trim() === gitTry(BASE, "symbolic-ref", "refs/remotes/origin/HEAD").stdout.trim()
      && gitTry(BASE, "symbolic-ref", "refs/remotes/origin/HEAD").code === 0, gitTry(WT1, "symbolic-ref", "refs/remotes/origin/HEAD").stderr);
  check("clone 생성: base 에 gc.pruneExpire=never",
    gitTry(BASE, "config", "--get", "gc.pruneExpire").stdout.trim() === "never", gitTry(BASE, "config", "--get", "gc.pruneExpire").stdout);
  check("clone 생성: 기본 브랜치 = wt/<basename>-<8hex>", /^wt\/base-[0-9a-f]{8}$/.test(r1?.branch || ""), r1?.branch);
  check("clone 생성: 반환 branch 가 실제 체크아웃 브랜치", r1?.branch && headBranch(WT1) === r1.branch, `${r1?.branch} vs ${headBranch(WT1)}`);

  const WS2 = mk(join(SB, "ws2"));
  let r2, r2err;
  try { r2 = await repoWorktree(ctx(WS2), { repo: "base", mode: "clone" }); } catch (e) { r2err = e; }
  check("clone 생성: 다른 경로의 기본 브랜치는 서로 다름(경로마다 유일)",
    !r2err && /^wt\/base-[0-9a-f]{8}$/.test(r2?.branch || "") && r2.branch !== r1?.branch, r2err?.message || `${r1?.branch} / ${r2?.branch}`);

  // ── 3) 생성 — env 로 결정된 clone ──
  const WS5 = mk(join(SB, "ws5"));
  process.env.LIVELY_WORKTREE_MODE = "clone";
  let r5, r5err;
  try { r5 = await repoWorktree(ctx(WS5), { repo: "base" }); } catch (e) { r5err = e; }
  process.env.LIVELY_WORKTREE_MODE = "worktree";
  check("env LIVELY_WORKTREE_MODE=clone: mode 인자 없이 clone 작업면 생성",
    !r5err && r5?.mode === "clone" && isGitDir(join(WS5, "base")), r5err?.message || JSON.stringify(r5));

  // ── 4) 브랜치 인자 ──
  const branchCase = async (name, args, expectSha, extra) => {
    let r, err;
    try { r = await repoWorktree(ctx(SB), { repo: "base", mode: "clone", ...args }); } catch (e) { err = e; }
    if (err) return bad(name, err.message);
    const wt = r.worktree;
    const sha = headSha(wt);
    const cond = r.branch === args.branch && headBranch(wt) === args.branch && sha === expectSha && (!extra || extra(wt, r));
    check(name, cond, JSON.stringify({ branch: r.branch, head: headBranch(wt), sha, expectSha, upstream: gitTry(wt, "rev-parse", "--abbrev-ref", "@{upstream}").stdout.trim() }));
  };
  await branchCase("branch: base 로컬 브랜치가 있으면 그 커밋에서", { branch: "loc-b", path: join(P, "loc") }, locSha);
  await branchCase("branch: origin/<branch> 가 있으면 그것을 추적(upstream=origin/<branch>) · 이어받았다고 알린다", { branch: "feat-x", path: join(P, "feat") }, originFeat,
    (wt, r) => gitTry(wt, "rev-parse", "--abbrev-ref", "@{upstream}").stdout.trim() === "origin/feat-x" && /기존 브랜치 'feat-x' 를 이어받았습니다/.test(r.note));
  await branchCase("branch: 어디에도 없으면 원격 기본 브랜치에서 분기 · 이어받기 안내 없음", { branch: "brand-new", path: join(P, "new1") }, originMain,
    (wt, r) => !/이어받았습니다/.test(r.note));
  await branchCase("branch: 어디에도 없으면 origin/<ref> 에서 분기", { branch: "brand-new-2", ref: "feat-x", path: join(P, "new2") }, originFeat);
  await branchCase("branch: git init 기본 브랜치명(main) 과 같아도 생성 · 작업 파일이 온전하다", { branch: "main", path: join(P, "main") }, originMain,
    (wt) => gitTry(wt, "status", "--porcelain").stdout.trim() === "" && git(wt, "ls-files") === git(BASE, "ls-tree", "-r", "--name-only", "refs/remotes/origin/main"));
  const aheadSha = git(ORIGIN, "commit-tree", "main^{tree}", "-p", "main", "-m", "origin-ahead");
  git(ORIGIN, "update-ref", "refs/heads/behind-b", aheadSha);
  const divOrigin = git(ORIGIN, "commit-tree", "main^{tree}", "-p", "main", "-m", "origin-side");
  git(ORIGIN, "update-ref", "refs/heads/div-b", divOrigin);
  git(BASE, "fetch", "-q", "origin");
  git(BASE, "branch", "-f", "behind-b", originMain);
  const divLocal = git(BASE, "commit-tree", `${originMain}^{tree}`, "-p", originMain, "-m", "local-side");
  git(BASE, "branch", "-f", "div-b", divLocal);
  await branchCase("branch: base 로컬 브랜치가 원격보다 뒤처지기만 했으면 원격 쪽 커밋", { branch: "behind-b", path: join(P, "behind") }, aheadSha);
  await branchCase("branch: base 로컬 브랜치가 원격과 갈라졌으면 로컬 커밋(미push 작업 보존)", { branch: "div-b", path: join(P, "div") }, divLocal);

  // ── 5) 비어 있지 않은 비-git 폴더 ──
  const OCC = mk(join(P, "occupied"));
  writeFileSync(join(OCC, "keep.txt"), "keep");
  const occErr = await caught(() => repoWorktree(ctx(SB), { repo: "base", mode: "clone", path: OCC }));
  check("대상 경로가 비어 있지 않은 비-git 폴더면 예외", !!occErr, "예외 없음");
  check("대상 경로 예외 시 기존 파일 보존", existsSync(join(OCC, "keep.txt")) && readFileSync(join(OCC, "keep.txt"), "utf8") === "keep", "keep.txt 사라지거나 바뀜");

  // ── 6) 재사용 ──
  let rr, rrErr;
  try { rr = await repoWorktree(ctx(WS1), { repo: "base", mode: "clone" }); } catch (e) { rrErr = e; }
  check("재사용: 같은 세션 재호출은 같은 자리·브랜치, mode=clone, 경고 없음",
    !rrErr && samePath(rr?.worktree, WT1) && rr?.branch === r1?.branch && rr?.mode === "clone" && !rr?.warning, rrErr?.message || JSON.stringify(rr));
  let rw, rwErr;
  try { rw = await repoWorktree(ctx(WS1), { repo: "base", mode: "worktree" }); } catch (e) { rwErr = e; }
  check("재사용: mode=worktree 로 불러도 자리의 방식(clone)을 따르고 경고 없음",
    !rwErr && samePath(rw?.worktree, WT1) && rw?.mode === "clone" && !rw?.warning && isGitDir(WT1), rwErr?.message || JSON.stringify(rw));
  check("재사용: 요청 mode 와 자리 방식이 다르면 note 로 알린다", /요청한 mode\(worktree\)/.test(rw?.note || ""), rw?.note);
  let rb, rbErr;
  await asSession(SESSION_B, async () => { try { rb = await repoWorktree(ctx(WS1), { repo: "base", mode: "clone" }); } catch (e) { rbErr = e; } });
  check("재사용: 다른 세션은 옆자리(<repo>-2)에 새로 만들고 브랜치가 다름",
    !rbErr && samePath(rb?.worktree, join(WS1, "base-2")) && rb?.branch && rb.branch !== r1?.branch && isGitDir(join(WS1, "base-2")),
    rbErr?.message || JSON.stringify(rb));

  const WS3 = mk(join(SB, "ws3"));
  sh("git", ["clone", "-q", ORIGIN, join(WS3, "base")]);
  let rh, rhErr;
  try { rh = await repoWorktree(ctx(WS3), { repo: "base", mode: "clone" }); } catch (e) { rhErr = e; }
  check("손으로 clone 한 폴더(alternates 없음)는 내 자리가 아님 → 옆자리",
    !rhErr && samePath(rh?.worktree, join(WS3, "base-2")), rhErr?.message || JSON.stringify(rh));
  const WS4 = mk(join(SB, "ws4"));
  sh("git", ["clone", "-q", "--shared", ORIGIN, join(WS4, "base")]);
  let rs, rsErr;
  try { rs = await repoWorktree(ctx(WS4), { repo: "base", mode: "clone" }); } catch (e) { rsErr = e; }
  check("alternates 가 base 가 아닌 곳을 가리키는 폴더도 내 자리가 아님 → 옆자리",
    !rsErr && samePath(rs?.worktree, join(WS4, "base-2")), rsErr?.message || JSON.stringify(rs));

  // ── 7) 객체 격리 ──
  let wtCommit = "";
  if (existsSync(WT1)) {
    git(WT1, "commit", "-q", "--allow-empty", "-m", "wt-only");
    wtCommit = headSha(WT1);
  }
  check("작업면 커밋 객체는 base 객체 저장소에 쓰이지 않음",
    !!wtCommit && gitTry(BASE, "cat-file", "-e", `${wtCommit}^{commit}`).code !== 0, wtCommit ? "base 에서 보임" : "작업면 없음");

  // ── 8) 제거 ──
  const unpushedErr = await caught(() => repoWorktreeRemove(ctx(WS1), { repo: "base", path: WT1 }));
  check("제거: 미push 커밋이 있으면 예외 + «push 하지 않은 커밋» + 짧은 sha",
    !!unpushedErr && String(unpushedErr.message).includes("push 하지 않은 커밋") && !!wtCommit && String(unpushedErr.message).includes(wtCommit.slice(0, 7)),
    unpushedErr ? unpushedErr.message : "예외 없음");
  check("제거: 미push 예외 시 폴더 보존", existsSync(WT1) && isGitDir(WT1), "폴더 사라짐");

  const DIRTY = join(P, "dirty");
  let rd, rdErr;
  try { rd = await repoWorktree(ctx(SB), { repo: "base", mode: "clone", path: DIRTY }); } catch (e) { rdErr = e; }
  if (!rdErr) writeFileSync(join(DIRTY, "untracked.txt"), "x");
  const dirtyErr = rdErr ? null : await caught(() => repoWorktreeRemove(ctx(SB), { repo: "base", path: DIRTY }));
  check("제거: untracked 변경이 있으면 예외", !rdErr && !!dirtyErr, rdErr?.message || "예외 없음");
  check("제거: 변경 있음 예외 시 폴더 보존", existsSync(join(DIRTY, "untracked.txt")), "폴더/파일 사라짐");

  const hiddenWork = async (name, prep) => {
    const at = join(P, `hidden-${name}`);
    const made = await caught(() => repoWorktree(ctx(SB), { repo: "base", mode: "clone", path: at }));
    if (made) return bad(`제거: ${name} 는 거부`, made.message);
    prep(at);
    const err = await caught(() => repoWorktreeRemove(ctx(SB), { repo: "base", path: at }));
    check(`제거: ${name} 만 있어도 거부하고 폴더 보존`, !!err && existsSync(at) && gitTry(at, "status", "--porcelain").stdout.trim() === "",
      err ? `${err.message} / status=${gitTry(at, "status", "--porcelain").stdout}` : "예외 없음");
  };
  await hiddenWork("detached HEAD 커밋", (at) => { git(at, "checkout", "-q", "--detach"); git(at, "commit", "-q", "--allow-empty", "-m", "detached"); });
  await hiddenWork("stash", (at) => { writeFileSync(join(at, "wip.txt"), "x"); git(at, "stash", "push", "-q", "-u"); });
  await hiddenWork("태그만 가리키는 커밋", (at) => { git(at, "commit", "-q", "--allow-empty", "-m", "tagged"); git(at, "tag", "keep-me"); git(at, "reset", "-q", "--hard", "HEAD~1"); });

  const PUSHED = join(P, "pushed");
  let rp, rpErr;
  try { rp = await repoWorktree(ctx(SB), { repo: "base", mode: "clone", path: PUSHED }); } catch (e) { rpErr = e; }
  const baseHeadBefore = git(BASE, "rev-parse", "HEAD");
  let pushedRemoved, pushedErr;
  if (!rpErr) {
    git(PUSHED, "commit", "-q", "--allow-empty", "-m", "to-push");
    git(PUSHED, "push", "-q", "origin", "HEAD:refs/heads/pushed-x");
    git(PUSHED, "fetch", "-q", "origin");
    try { pushedRemoved = await repoWorktreeRemove(ctx(SB), { repo: "base", path: PUSHED }); } catch (e) { pushedErr = e; }
  }
  check("제거: push 된 깨끗한 작업면은 force 없이 폴더째 삭제",
    !rpErr && !pushedErr && !!pushedRemoved?.removed && !existsSync(PUSHED), rpErr?.message || pushedErr?.message || JSON.stringify(pushedRemoved));
  check("제거: base 영향 없음(HEAD·worktree list·상태)",
    existsSync(BASE) && git(BASE, "rev-parse", "HEAD") === baseHeadBefore && git(BASE, "worktree", "list", "--porcelain") === baseWtListBefore
      && gitTry(BASE, "status", "--porcelain").code === 0, "base 변화");

  let forced, forcedErr;
  try { forced = await repoWorktreeRemove(ctx(WS1), { repo: "base", path: WT1, force: true }); } catch (e) { forcedErr = e; }
  check("제거: force 면 미push 커밋이 있어도 삭제", !forcedErr && !!forced?.removed && !existsSync(WT1), forcedErr?.message || JSON.stringify(forced));

  console.error(`\n${pass} pass, ${fail} fail`);
  if (fail) process.exit(1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
