// 서버 공유 클론이 «레포에 등록한 기본 브랜치» 를 따르는지(#1723) — **DB 없이** 진짜 git 으로 검증.
//  실행: npm run build && node dist/project/project-provision-default-branch.test.js
//
//  사양(이슈 #1723 «바라는 동작»):
//   1. 처음 받기 — 등록한 기본 브랜치가 있으면 그 브랜치로 받는다.
//   2. 이미 받은 것 — 지금 브랜치가 등록 브랜치와 다르면, 워킹트리가 깨끗할 때만 등록 브랜치로 바꾼다.
//      깨끗하지 않으면 손대지 않고 사유를 남긴다.
//   4. 등록 브랜치가 원격에 없을 때 — 종전 동작(원격 기본 브랜치)으로 돌아가고 사유를 남긴다.
//   · 기본 브랜치를 등록하지 않은 레포는 동작이 그대로다.
//   · 사람이 경로를 직접 지정한 기존 클론은 그 사람이 고른 브랜치를 따른다(공유 클론만 맞춘다).
//  픽스처: 원격 기본 브랜치 = develop(배포 전 코드) · 배포 브랜치 = main. 로컬 bare 를 file:// 로 원격 삼는다.
//  등록값은 노드 주입 묶음(inject.defaultBranch)으로 준다 — 게이트웨이가 레지스트리에서 읽어 싣는 그 값이다.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

delete process.env.ITEMS_DATABASE_URL;
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prov-defbranch-")));
process.env.TERMINAL_ROOT_SHARED = ROOT;

const { provisionProjectRepos, ensureProvisionBase, refreshSharedRepo, registeredBranchOf, registeredBranchOfRow, resolveRepoInject } = await import("./project-provision.js");

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (args: string[], cwd?: string): string => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: GIT_ENV, encoding: "utf8" }).trim();
const branchOf = (p: string) => git(["rev-parse", "--abbrev-ref", "HEAD"], p);
const headOf = (p: string) => git(["rev-parse", "HEAD"], p);

try {
  // ── 원격: main(배포) + develop(원격 기본 · main 보다 앞섬) ──
  const work = path.join(ROOT, "src-work");
  fs.mkdirSync(work, { recursive: true });
  git(["init", "-q", "-b", "main", work]);
  fs.writeFileSync(path.join(work, "WHERE"), "main\n");
  git(["add", "-A"], work); git(["commit", "-q", "-m", "main 1"], work);
  git(["checkout", "-q", "-b", "develop"], work);
  fs.writeFileSync(path.join(work, "WHERE"), "develop\n");
  git(["add", "-A"], work); git(["commit", "-q", "-m", "develop 1"], work);
  const bare = path.join(ROOT, "origin.git");
  git(["clone", "-q", "--bare", work, bare]);
  git(["symbolic-ref", "HEAD", "refs/heads/develop"], bare);          // 원격 기본 브랜치 = develop
  const url = "file://" + bare;
  const remoteTip = (b: string) => git(["rev-parse", `refs/heads/${b}`], bare);
  // 원격 브랜치에 커밋 하나 더 — «맞춘 뒤 최신화까지 되는지» 볼 때 쓴다.
  const pushCommit = (b: string, msg: string) => {
    git(["checkout", "-q", b], work);
    fs.writeFileSync(path.join(work, "WHERE"), `${b} ${msg}\n`);
    git(["add", "-A"], work); git(["commit", "-q", "-m", msg], work);
    git(["push", "-q", bare, `${b}:${b}`], work);
  };
  const baseOf = (name: string) => path.join(ROOT, "repos", name);
  const inj = (defaultBranch?: string | null) => ({ gitUrl: url, secret: null, ...(defaultBranch === undefined ? {} : { defaultBranch }) });
  // 원격 기본 브랜치(develop)로 받아져 있는 옛 공유 클론을 흉내 — 이 변경 이전에 받은 클론의 모양이다.
  const legacyClone = (name: string) => { git(["clone", "-q", url, baseOf(name)]); assert.equal(branchOf(baseOf(name)), "develop"); };

  // 픽스처 배선 — 원격 기본 브랜치가 정말 develop 이어야 아래 시험이 뜻을 가진다(main 이 기본이면 전부 헛통과한다).
  {
    const probe = path.join(ROOT, "probe");
    git(["clone", "-q", url, probe]);
    assert.equal(branchOf(probe), "develop", "픽스처: 원격 기본 브랜치가 develop 이 아니다");
    assert.notEqual(remoteTip("main"), remoteTip("develop"));
  }

  // ── R0 등록값 읽기 — 형식이 안 맞는 이름은 «등록값 없음» ──
  {
    assert.equal(registeredBranchOf("main"), "main");
    assert.equal(registeredBranchOf("  release/1.2  "), "release/1.2");
    for (const bad of ["", "   ", null, undefined, 3, "-evil", "--upload-pack=x", "a b", "a;rm -rf"]) {
      assert.equal(registeredBranchOf(bad), null, `형식이 안 맞는 등록값이 통과: ${String(bad)}`);
    }
    // 레지스트리 행 — default_branch 칸은 기본값이 'main' 이라 git 소스를 연결한 적 없는 행에도 'main' 이 들어 있다.
    //  그 값은 사람이 고른 게 아니다 → git 주소가 있는 행만 등록값으로 읽는다.
    assert.equal(registeredBranchOfRow({ git_url: "https://h/o/r.git", default_branch: "main" }), "main");
    assert.equal(registeredBranchOfRow({ git_url: null, default_branch: "main" }), null, "git 소스 없는 행의 기본값 'main' 을 등록값으로 읽었다");
    assert.equal(registeredBranchOfRow({ git_url: "  ", default_branch: "main" }), null);
    assert.equal(registeredBranchOfRow({ default_branch: "main" }), null);
    assert.equal(registeredBranchOfRow({ git_url: "https://h/o/r.git", default_branch: null }), null);
    assert.equal(registeredBranchOfRow(null), null);
    assert.equal(registeredBranchOfRow(undefined), null);
    ok("R0 등록값 — 비었거나 형식이 안 맞으면 없음 · git 소스를 연결한 행만 등록값으로 읽는다");
  }

  // ── S1 처음 받기: 등록 main → main 으로 받는다(원격 기본은 develop) ──
  {
    const r = await ensureProvisionBase("s1", null, inj("main"));
    assert.equal(r.status, "cloned", r.detail);
    assert.equal(branchOf(baseOf("s1")), "main");
    assert.equal(fs.readFileSync(path.join(baseOf("s1"), "WHERE"), "utf8"), "main\n");
    assert.equal(r.branch, "main");
    assert.equal(r.branch_note, undefined, "제대로 받았는데 사유가 붙었다");
    // 다른 브랜치도 받아져 있어야 한다(단일 브랜치 클론이 아니다) — ref 를 직접 준 워크트리가 거기서 뜬다.
    assert.equal(git(["rev-parse", "refs/remotes/origin/develop"], baseOf("s1")), remoteTip("develop"));
    ok("S1 새 공유 클론이 등록한 기본 브랜치(main)로 받아진다");
  }

  // ── S2 이미 받은 깨끗한 클론(develop) → 다음 갱신에서 main 으로 바뀌고 최신화된다 ──
  {
    legacyClone("s2");
    pushCommit("main", "main 2");
    const r = await ensureProvisionBase("s2", null, inj("main"));
    assert.equal(r.status, "refreshed", r.detail);
    assert.equal(branchOf(baseOf("s2")), "main");
    assert.equal(headOf(baseOf("s2")), remoteTip("main"), "바꾼 뒤 원격 main 최신까지 가야 한다");
    assert.match(r.branch_note ?? "", /'develop'.*'main'/, `바꿨다는 말이 없다: ${r.branch_note}`);
    // 옛 브랜치는 지우지 않는다(checkout 만).
    assert.ok(git(["rev-parse", "--verify", "refs/heads/develop"], baseOf("s2")));
    // 한 번 더 — 이미 맞으면 조용하다(멱등).
    const again = await ensureProvisionBase("s2", null, inj("main"));
    assert.equal(branchOf(baseOf("s2")), "main");
    assert.equal(again.branch_note, undefined, `이미 맞는데 사유가 또 나왔다: ${again.branch_note}`);
    ok("S2 develop 으로 받아져 있던 깨끗한 클론이 다음 갱신에서 main 으로 바뀐다(멱등)");
  }

  // ── S3 지저분한 클론 → 그대로 남고 사유가 나온다 ──
  {
    legacyClone("s3");
    const dirtyFile = path.join(baseOf("s3"), "WHERE");
    fs.writeFileSync(dirtyFile, "local edit\n");
    const before = headOf(baseOf("s3"));
    const r = await ensureProvisionBase("s3", null, inj("main"));
    assert.equal(branchOf(baseOf("s3")), "develop", "지저분한 클론의 브랜치를 바꿨다");
    assert.equal(headOf(baseOf("s3")), before);
    assert.equal(fs.readFileSync(dirtyFile, "utf8"), "local edit\n", "로컬 변경이 사라졌다");
    assert.ok(r.branch_note, "지저분해서 못 바꿨는데 사유가 없다");
    assert.equal(r.branch, "develop");
    // 추적 안 되는 파일만 있어도 지저분한 것이다(기존 dirty 판정과 같은 기준).
    legacyClone("s3u");
    fs.writeFileSync(path.join(baseOf("s3u"), "untracked.txt"), "x\n");
    const u = await ensureProvisionBase("s3u", null, inj("main"));
    assert.equal(branchOf(baseOf("s3u")), "develop");
    assert.ok(u.branch_note, "추적 안 되는 파일 때문에 못 바꿨는데 사유가 없다");
    assert.ok(fs.existsSync(path.join(baseOf("s3u"), "untracked.txt")));
    ok("S3 지저분한 클론은 그대로 남고 사유가 나온다");
  }

  // ── S4 등록 브랜치가 원격에 없다 → 종전 동작(원격 기본 브랜치) + 사유 ──
  {
    const c = await ensureProvisionBase("s4new", null, inj("release"));
    assert.equal(c.status, "cloned", `등록 브랜치가 원격에 없다고 클론이 실패했다: ${c.detail}`);
    assert.equal(branchOf(baseOf("s4new")), "develop");
    assert.ok(c.branch_note && c.branch_note.includes("release"), `사유가 없다: ${c.branch_note}`);

    legacyClone("s4old");
    pushCommit("develop", "develop 2");
    const r = await ensureProvisionBase("s4old", null, inj("release"));
    assert.equal(branchOf(baseOf("s4old")), "develop");
    assert.equal(headOf(baseOf("s4old")), remoteTip("develop"), "종전 동작(지금 브랜치 최신화)은 그대로여야 한다");
    assert.ok(r.branch_note && r.branch_note.includes("release"), `사유가 없다: ${r.branch_note}`);
    ok("S4 등록 브랜치가 원격에 없으면 원격 기본 브랜치로 돌아가고 사유가 나온다");
  }

  // ── S5 기본 브랜치를 등록하지 않은 레포 → 동작 그대로 ──
  {
    for (const [name, v] of [["s5a", undefined], ["s5b", null], ["s5c", ""], ["s5d", "-bad"]] as const) {
      const c = await ensureProvisionBase(name, null, inj(v));
      assert.equal(c.status, "cloned", c.detail);
      assert.equal(branchOf(baseOf(name)), "develop", `등록값 없음(${String(v)})인데 원격 기본 브랜치가 아니다`);
      assert.equal(c.branch_note, undefined);
    }
    pushCommit("develop", "develop 3");
    const r = await ensureProvisionBase("s5a", null, inj(undefined));
    assert.equal(branchOf(baseOf("s5a")), "develop");
    assert.equal(headOf(baseOf("s5a")), remoteTip("develop"));
    assert.equal(r.branch_note, undefined);
    // git 소스가 등록되지 않은 레포(칸 기본값 'main' 만 있는 행) — 이미 받아 둔 공유 클론도 그대로다.
    const noSrc = await refreshSharedRepo("s5b", null, { gitUrl: null, secret: null, defaultBranch: "main" });
    assert.equal(branchOf(baseOf("s5b")), "develop", "git 소스 없는 행의 기본값 'main' 으로 공유 클론을 바꿨다");
    assert.equal(noSrc.branch, "develop"); assert.equal(noSrc.branch_note, undefined); assert.equal(noSrc.switched_from, undefined);
    ok("S5 기본 브랜치를 등록하지 않은 레포는 동작이 그대로다(원격 기본 브랜치 · 사유 없음)");
  }

  // ── S6 사람이 경로를 직접 지정한 기존 클론은 맞추지 않는다 ──
  {
    const custom = path.join(ROOT, "custom", "mine");
    fs.mkdirSync(path.dirname(custom), { recursive: true });
    git(["clone", "-q", url, custom]);
    assert.equal(branchOf(custom), "develop");
    const { provisioned } = await provisionProjectRepos(70006, "project/70006",
      [{ name: "s6", path: custom, worktree: false, inject: inj("main") }], { clone: true, memberId: null });
    assert.equal(provisioned[0].path, custom, "배선: 지정한 경로가 쓰이지 않았다");
    assert.equal(branchOf(custom), "develop", "직접 지정한 클론의 브랜치를 바꿨다");
    ok("S6 경로를 직접 지정한 기존 클론은 그 사람이 고른 브랜치를 따른다");
  }

  // ── S7 detached HEAD → 손대지 않고 사유 ──
  {
    legacyClone("s7");
    git(["checkout", "-q", "--detach"], baseOf("s7"));
    const before = headOf(baseOf("s7"));
    const r = await ensureProvisionBase("s7", null, inj("main"));
    assert.equal(branchOf(baseOf("s7")), "HEAD", "detached 클론을 브랜치로 옮겼다");
    assert.equal(headOf(baseOf("s7")), before);
    assert.ok(r.branch_note, "detached 라 못 바꿨는데 사유가 없다");
    assert.equal(r.branch, null);
    ok("S7 detached 공유 클론은 손대지 않고 사유가 나온다");
  }

  // ── S8 등록 브랜치를 다른 워크트리가 쥐고 있다 → 못 바꾸고 사유(공유 클론은 그대로) ──
  {
    legacyClone("s8");
    const holder = path.join(ROOT, "holder-s8");
    git(["worktree", "add", "-q", holder, "-b", "main", "origin/main"], baseOf("s8"));
    const r = await ensureProvisionBase("s8", null, inj("main"));
    assert.equal(branchOf(baseOf("s8")), "develop");
    assert.ok(r.branch_note, "못 바꿨는데 사유가 없다");
    assert.equal(branchOf(holder), "main", "브랜치를 쥔 워크트리가 건드려졌다");
    ok("S8 등록 브랜치를 다른 워크트리가 쥐고 있으면 그대로 두고 사유가 나온다");
  }

  // ── S9 로컬에 등록 브랜치가 이미 있고 뒤처져 있다 → 그 브랜치로 바꾸고 최신화 ──
  {
    git(["clone", "-q", "--branch", "main", url, baseOf("s9")]);
    const oldMain = headOf(baseOf("s9"));
    git(["checkout", "-q", "develop"], baseOf("s9"));                 // 누가 develop 으로 옮겨 둔 상태
    pushCommit("main", "main 3");
    assert.notEqual(oldMain, remoteTip("main"));
    await ensureProvisionBase("s9", null, inj("main"));
    assert.equal(branchOf(baseOf("s9")), "main");
    assert.equal(headOf(baseOf("s9")), remoteTip("main"));
    ok("S9 로컬에 뒤처진 등록 브랜치가 있으면 그 브랜치로 바꾼 뒤 최신화한다");
  }

  // ── S9b 로컬 등록 브랜치에 upstream 이 없다(누가 손으로 만든 브랜치) → 바꾸고도 최신까지 간다 ──
  {
    git(["clone", "-q", "--branch", "main", url, baseOf("s9b")]);
    git(["branch", "--unset-upstream", "main"], baseOf("s9b"));
    git(["checkout", "-q", "develop"], baseOf("s9b"));
    pushCommit("main", "main 4");
    const r = await refreshSharedRepo("s9b", null, inj("main"));
    assert.equal(branchOf(baseOf("s9b")), "main");
    assert.equal(headOf(baseOf("s9b")), remoteTip("main"), "upstream 없는 로컬 브랜치로 바꾼 뒤 옛 커밋에 머물렀다");
    assert.equal(r.status, "ok", r.detail);
    ok("S9b upstream 없는 로컬 등록 브랜치도 바꾼 뒤 원격 최신까지 간다");
  }

  // ── S11 등록 브랜치가 원격에서 지워졌다(옛 origin/<이름> 만 남음) → 죽은 브랜치로 바꾸지 않는다 ──
  {
    git(["push", "-q", bare, "main:gone"], work);
    legacyClone("s11");
    assert.ok(git(["rev-parse", "--verify", "refs/remotes/origin/gone"], baseOf("s11")), "배선: 지워지기 전 ref 가 있어야 한다");
    git(["push", "-q", bare, ":gone"], work);                           // 원격에서 지운다
    const r = await ensureProvisionBase("s11", null, inj("gone"));
    assert.equal(branchOf(baseOf("s11")), "develop", "원격에서 지워진 브랜치로 공유 클론을 바꿨다");
    assert.ok(r.branch_note && r.branch_note.includes("gone"), `사유가 없다: ${r.branch_note}`);
    ok("S11 원격에서 지워진 등록 브랜치로는 바꾸지 않는다(옛 ref 를 믿지 않는다)");
  }

  // ── S10 서버 provision 워크트리의 분기점 — 공유 클론이 맞춰진 뒤 base HEAD(= 등록 브랜치)에서 갈라진다 ──
  {
    legacyClone("s10");
    const { provisioned } = await provisionProjectRepos(70010, "project/70010",
      [{ name: "s10", worktree: true, inject: inj("main") }], { clone: true, memberId: null });
    const wt = path.join(ROOT, "project", "70010", "s10");
    assert.equal(provisioned[0].branch, "project/70010");
    assert.equal(headOf(wt), remoteTip("main"), "새 프로젝트 워크트리가 등록 브랜치(main)에서 갈라지지 않았다");
    // 이미 떠 있는 프로젝트 워크트리는 건드리지 않는다 — 등록값이 바뀌어도 그 워크트리의 브랜치·HEAD 는 그대로.
    const wtHead = headOf(wt);
    await provisionProjectRepos(70010, "project/70010",
      [{ name: "s10", worktree: true, inject: inj("develop") }], { clone: true, memberId: null });
    assert.equal(branchOf(wt), "project/70010");
    assert.equal(headOf(wt), wtHead, "이미 떠 있는 프로젝트 워크트리가 움직였다");
    assert.equal(branchOf(baseOf("s10")), "develop", "등록값을 develop 으로 바꾸면 공유 클론은 따라가야 한다");
    ok("S10 새 프로젝트 워크트리는 등록 브랜치에서 갈라지고, 이미 떠 있는 워크트리는 그대로다");
  }

  // ── F1~F5 «코드 최신화»(refreshSharedRepo) — 같은 규칙 + 상태·사유 칸 ──
  {
    legacyClone("f1");
    const r = await refreshSharedRepo("f1", null, inj("main"));
    assert.equal(r.status, "ok", r.detail);
    assert.equal(r.branch, "main"); assert.equal(r.switched_from, "develop");
    assert.ok(r.branch_note, "바꿨는데 알림이 없다");
    assert.equal(branchOf(baseOf("f1")), "main");
    assert.equal(r.after, remoteTip("main"));
    assert.equal(r.advanced, true);
    const again = await refreshSharedRepo("f1", null, inj("main"));
    assert.equal(again.status, "up-to-date");
    assert.equal(again.branch, "main");
    assert.equal(again.switched_from, undefined); assert.equal(again.branch_note, undefined);
    ok("F1 코드 최신화 — 깨끗한 클론을 등록 브랜치로 바꾸고 무엇을 바꿨는지 돌려준다(멱등)");
  }
  {
    legacyClone("f2");
    fs.writeFileSync(path.join(baseOf("f2"), "WHERE"), "local edit\n");
    const r = await refreshSharedRepo("f2", null, inj("main"));
    assert.equal(r.status, "dirty");
    assert.equal(r.branch, "develop");
    assert.equal(r.switched_from, undefined);
    assert.ok(r.branch_note, "브랜치가 어긋난 채 남았는데 사유가 없다");
    assert.ok((r.detail ?? "").includes(r.branch_note!), "화면이 읽는 detail 에 브랜치 사유가 없다");
    assert.equal(branchOf(baseOf("f2")), "develop");
    assert.equal(fs.readFileSync(path.join(baseOf("f2"), "WHERE"), "utf8"), "local edit\n");
    // 등록값이 없거나 이미 맞으면 dirty 여도 브랜치 사유는 없다(종전 그대로).
    const plain = await refreshSharedRepo("f2", null, inj("develop"));
    assert.equal(plain.status, "dirty"); assert.equal(plain.branch_note, undefined);
    ok("F2 코드 최신화 — 지저분한 클론은 dirty 로 남고 브랜치 사유가 함께 나온다");
  }
  {
    legacyClone("f3");
    pushCommit("develop", "develop 4");
    const r = await refreshSharedRepo("f3", null, inj("release"));
    assert.equal(r.status, "ok", r.detail);                              // 지금 브랜치(develop)는 종전대로 최신화된다
    assert.equal(r.branch, "develop");
    assert.equal(r.after, remoteTip("develop"));
    assert.ok(r.branch_note && r.branch_note.includes("release"));
    assert.equal(r.switched_from, undefined);
    ok("F3 코드 최신화 — 등록 브랜치가 원격에 없으면 지금 브랜치를 최신화하고 사유를 남긴다");
  }
  {
    legacyClone("f4");
    pushCommit("develop", "develop 5");
    const r = await refreshSharedRepo("f4", null, inj(null));
    assert.equal(r.status, "ok", r.detail);
    assert.equal(r.branch, "develop"); assert.equal(r.branch_note, undefined); assert.equal(r.switched_from, undefined);
    assert.equal(r.after, remoteTip("develop"));
    ok("F4 코드 최신화 — 등록값이 없으면 종전 그대로(사유 없음)");
  }
  {
    // upstream 없는 로컬 브랜치에 서 있어도, 등록 브랜치가 있으면 그리로 맞춘 뒤 최신화한다(종전엔 no-upstream 으로 끝).
    legacyClone("f5");
    git(["checkout", "-q", "-b", "scratch"], baseOf("f5"));
    const none = await refreshSharedRepo("f5", null, inj(null));
    assert.equal(none.status, "no-upstream", "등록값이 없을 때의 종전 동작이 바뀌었다");
    assert.equal(branchOf(baseOf("f5")), "scratch");
    const r = await refreshSharedRepo("f5", null, inj("main"));
    assert.equal(r.branch, "main"); assert.equal(r.switched_from, "scratch");
    assert.equal(r.after, remoteTip("main"));
    ok("F5 코드 최신화 — upstream 없는 브랜치: 등록값 없으면 no-upstream 그대로 · 있으면 등록 브랜치로");
  }

  // ── N1 게이트웨이 → 노드 주입 묶음에 등록 브랜치가 실린다(칸 이름 고정) ──
  {
    // DB 가 없는 여기서는 레지스트리를 못 읽으니 값은 null 이다 — 칸이 «있다» 는 것만 본다(값 경로는 registeredBranchOf R0).
    const i = await resolveRepoInject("whatever", "nobody", "member");
    assert.ok("defaultBranch" in i, "주입 묶음에 defaultBranch 칸이 없다 — 노드가 등록 브랜치를 못 받는다");
    assert.equal(i.defaultBranch, null);
    ok("N1 노드 주입 묶음(resolveRepoInject)에 defaultBranch 칸이 있다");
  }

  console.log(`\n${pass} passed`);
} finally {
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => {});
}
