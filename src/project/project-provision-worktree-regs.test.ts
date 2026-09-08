// #3678 서버측 provision 이 공유 base 위 **남의 워크트리 등록을 지우지 않는다** — 실행: npm run build && node dist/project/project-provision-worktree-regs.test.js
//   DB·네트워크 불요 — 로컬 bare 레포(file://)를 inject 로 주입해 provisionProjectRepos 를 실제 git 으로 돌린다.
//   ⚠ 구현 재진술 금지 — 관찰 가능한 결과만 단언한다: 등록(admin) 디렉터리 존재 · 그 역참조 · HEAD 브랜치 · base config.
//
// 사고(2026-09-08): 세션 컨테이너들이 base 하나를 공유하는데 각자 자기 프로젝트 폴더만 본다. `git worktree prune` 이 «안 보이는»
//  남의 워크트리 admin 을 지웠고, 같은 basename 으로 다시 뜬 admin 을 둘이 가리켜 HEAD·index 를 공유했다(커밋이 남의 브랜치에).
//  provision 도 add 앞에 prune 을 돌리던 자리 — 툴(kit/cli/repo-worktree-core.mjs)만 고치면 이 경로가 여전히 지운다.
//  «컨테이너가 서로의 경로를 못 본다» 는 프로젝트 폴더 rename 으로 흉내 낸다(부모까지 사라진다).
//
// 사양 엣지:
//   S1 다른 프로젝트의 워크트리가 안 보이는 사이 provision 해도 그 등록·HEAD 브랜치가 그대로다
//   S4 있는 워크트리가 다른 워크트리의 admin 을 잇고 있으면(사고 상태) 재사용하지 않고 거절한다 — 아무것도 고치지 않는다
//   S2 목표 경로의 스테일 등록(디렉터리 삭제·부모 있음)은 치우고 다시 만든다(#932 유지 — 브랜치 영구잠금 없음)
//   S3 base 에 gc.worktreePruneExpire=never
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

delete process.env.ITEMS_DATABASE_URL;   // DB 미설정 = 노드 조건(inject 로만 레포를 안다)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "prov-wt-regs-"));
process.env.TERMINAL_ROOT_SHARED = ROOT;

const { provisionProjectRepos } = await import("./project-provision.js");

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };
const git = (args: string[], cwd?: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const gitfileAdmin = (wt: string): string => {
  const m = fs.readFileSync(path.join(wt, ".git"), "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
  return m ? m[1] : "";
};
const adminBack = (admin: string): string => { try { return fs.readFileSync(path.join(admin, "gitdir"), "utf8").split("\n")[0].trim(); } catch { return ""; } };
const real = (p: string): string => { try { return fs.realpathSync.native(p); } catch { return p; } };
const norm = (p: string): string => (process.platform === "win32" ? real(p).replace(/\\/g, "/").toLowerCase() : real(p));

try {
  const srcWork = path.join(ROOT, "src-work");
  fs.mkdirSync(srcWork, { recursive: true });
  git(["init", "-q", "-b", "main", srcWork]);
  fs.writeFileSync(path.join(srcWork, "README.md"), "hello\n");
  git(["add", "-A"], srcWork);
  git(["commit", "-q", "-m", "init"], srcWork);
  const bare = path.join(ROOT, "origin.git");
  git(["clone", "-q", "--bare", srcWork, bare]);
  const REPO = { name: "good-repo", worktree: true, inject: { gitUrl: "file://" + bare, secret: null } };
  const base = path.join(ROOT, "repos", "good-repo");
  const provision = (pid: number) => provisionProjectRepos(pid, `project/${pid}`, [REPO], { clone: true, memberId: null });
  const wtOf = (pid: number) => path.join(ROOT, "project", String(pid), "good-repo");

  // ── S1 — A(2600) 가 안 보이는 사이 B(3646) 를 provision 해도 A 의 등록은 그대로 ──
  {
    await provision(2600);
    const wtA = wtOf(2600);
    const adminA = gitfileAdmin(wtA);
    assert.ok(adminA && fs.existsSync(adminA), "전제: A 의 admin 이 있어야 한다");
    fs.renameSync(path.join(ROOT, "project", "2600"), path.join(ROOT, "hidden-2600"));   // = 다른 컨테이너에서 안 보임
    await provision(3646);
    fs.renameSync(path.join(ROOT, "hidden-2600"), path.join(ROOT, "project", "2600"));
    assert.ok(fs.existsSync(adminA), "B 의 provision 이 A 의 등록(admin)을 지웠다 — 사고의 첫 단계");
    assert.equal(norm(adminBack(adminA)), norm(path.join(wtA, ".git")), "A 의 admin 이 A 자신을 가리켜야 한다(남의 것과 섞이지 않음)");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], wtA), "project/2600", "A 의 HEAD 브랜치가 바뀌었다(admin 공유 = 사고)");
    assert.notEqual(gitfileAdmin(wtOf(3646)), adminA, "B 가 A 와 같은 admin 을 가리킨다(사고 상태)");
    ok("S1 안 보이는 남의 워크트리 등록을 provision 이 지우지 않는다");
  }

  // ── S4 — 재사용 전 소유 검증: B 의 gitfile 이 A 의 admin 을 가리키는 사고 상태 → 거절, 아무것도 안 고침 ──
  {
    const wtA = wtOf(2600), wtB = wtOf(3646);
    const adminA = gitfileAdmin(wtA);
    const gitfileB = path.join(wtB, ".git");
    const before = fs.readFileSync(gitfileB, "utf8");
    fs.rmSync(gitfileB, { force: true });                                   // ⚠ 윈도우: git 이 만든 .git 은 hidden 이라 덮어쓰기 EPERM — 지우고 쓴다
    fs.writeFileSync(gitfileB, `gitdir: ${adminA}\n`);
    await assert.rejects(() => provision(3646), /다른 워크트리의 git 등록/, "남의 admin 을 잇고 있는 워크트리를 조용히 재사용했다(사고 상태에 세션을 앉힘)");
    assert.equal(fs.readFileSync(gitfileB, "utf8"), `gitdir: ${adminA}\n`, "거절하면서 gitfile 을 고쳤다 — 아무것도 고치지 않아야 한다");
    assert.ok(fs.existsSync(adminA) && norm(adminBack(adminA)) === norm(path.join(wtA, ".git")), "거절하면서 A 의 admin 을 건드렸다");
    fs.rmSync(gitfileB, { force: true });
    fs.writeFileSync(gitfileB, before);
    ok("S4 남의 admin 을 잇고 있는 워크트리는 재사용하지 않는다(거절·무변경)");
  }

  // ── S2 — 목표 경로의 스테일 등록(디렉터리 삭제·부모 있음)은 치우고 다시 만든다 ──
  {
    const wtB = wtOf(3646);
    const adminB = gitfileAdmin(wtB);
    fs.rmSync(wtB, { recursive: true, force: true });                     // 워크트리 디렉터리만 사라짐(등록은 남아 project/3646 을 쥔다)
    await provision(3646);
    assert.ok(fs.existsSync(path.join(wtB, "README.md")), "스테일 등록이 남아 있으면 같은 자리에 다시 못 만든다(#932)");
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], wtB), "project/3646", "같은 브랜치를 다시 써야 한다(영구잠금 없음)");
    assert.ok(!fs.existsSync(adminB) || norm(adminBack(adminB)) === norm(path.join(wtB, ".git")), "옛 등록이 남의 자리로 남아 있다");
    ok("S2 목표 경로의 스테일 등록은 치우고 재생성(#932 유지)");
  }

  // ── S3 — base 에 gc.worktreePruneExpire=never ──
  {
    assert.equal(git(["config", "--get", "gc.worktreePruneExpire"], base), "never", "gc 의 자동 prune 이 켜져 있다(3개월 넘게 index 를 안 건드린 남의 워크트리를 지운다)");
    ok("S3 base 에 gc.worktreePruneExpire=never");
  }

  console.log(`\n${pass} passed`);
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
