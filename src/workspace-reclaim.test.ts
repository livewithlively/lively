// 워크스페이스 회수 안전 게이트 테스트 (#813 T3-2) — **고객 코드를 지우면 되돌릴 수 없다.**
//  여기서 못 박는 것(하나라도 깨지면 고객 자산 손실):
//   ① gitignored 라도 allow-list 밖이면 안 지운다 — `.env`(시크릿)·`data/`(로컬 데이터)는 전부 gitignored 다.
//   ② allow-list 이름이어도 gitignored 가 아니면 안 지운다 — 소스 디렉터리가 `build/` 인 레포가 실제로 있다.
//   ③ 더티/미푸시/upstream 없음 → 워크트리 제거 **거부**(이유를 말한다).
//   ④ 활성 세션이 붙어 있으면 **아무것도** 안 지운다(빌드 중일 수 있다).
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { planReclaim, applyReclaim, checkWorktree, isInside, reposIn, DERIVED_NAMES, PROTECTED_NAMES } from "./workspace-reclaim.js";

const exec = promisify(execFile);
const git = (args: string[], cwd: string) => exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

// 원격(bare) + 작업 레포를 만든다 — 푸시 여부를 진짜로 검사하려면 upstream 이 있어야 한다.
async function makeRepo(): Promise<{ dir: string; remote: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "reclaim-"));
  const remote = path.join(root, "origin.git");
  const dir = path.join(root, "work");
  await fsp.mkdir(remote, { recursive: true });
  await git(["init", "--bare", "-b", "main"], remote);
  await fsp.mkdir(dir, { recursive: true });
  await git(["init", "-b", "main"], dir);
  await git(["config", "user.email", "t@t"], dir);
  await git(["config", "user.name", "t"], dir);
  await git(["remote", "add", "origin", remote], dir);
  // gitignore: 파생물 + 시크릿/로컬데이터(현실 그대로 — 둘 다 gitignored 다).
  // ⚠ `node_modules` 는 **슬래시 없이** — 실제 레포(context-ontology/.gitignore:1)와 동일. 슬래시를 붙이면
  //  디렉터리만 매치해 **심링크가 안 잡히고**, 그러면 심링크 회귀 테스트가 조용히 무력해진다(실제로 겪음).
  await fsp.writeFile(path.join(dir, ".gitignore"), "node_modules\nbuild/\ndist/\n.env\ndata/\nweird-cache/\n");
  await fsp.writeFile(path.join(dir, "src.txt"), "source");
  await git(["add", "-A"], dir);
  await git(["commit", "-m", "init"], dir);
  await git(["push", "-u", "origin", "main"], dir);
  return { dir, remote };
}

// ── 분류: gitignored ∩ allow-list 만 지운다 ──
{
  const { dir } = await makeRepo();
  // 파생물(지워도 됨)
  await fsp.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
  await fsp.writeFile(path.join(dir, "node_modules", "pkg", "x"), "x".repeat(5000));
  await fsp.mkdir(path.join(dir, "build"), { recursive: true });
  await fsp.writeFile(path.join(dir, "build", "o"), "x".repeat(1000));
  // ⚠ gitignored 지만 지우면 안 되는 것들
  await fsp.writeFile(path.join(dir, ".env"), "SECRET=abc");
  await fsp.mkdir(path.join(dir, "data"), { recursive: true });
  await fsp.writeFile(path.join(dir, "data", "db.sqlite"), "real-data");
  // gitignored 지만 우리가 모르는 것 → 미분류(안 지움)
  await fsp.mkdir(path.join(dir, "weird-cache"), { recursive: true });
  await fsp.writeFile(path.join(dir, "weird-cache", "w"), "?");

  const plan = await planReclaim(dir);
  const kindOf = (rel: string) => plan.entries.find((e) => e.rel === rel || e.rel === rel + "/")?.kind;

  assert.equal(kindOf("node_modules"), "derived", "node_modules 는 회수 대상");
  assert.equal(kindOf("build"), "derived", "gitignored 인 build 는 회수 대상");
  assert.equal(kindOf(".env"), "protected", "⚠ .env(시크릿)는 gitignored 여도 절대 안 지운다");
  assert.equal(kindOf("data"), "protected", "⚠ data/(로컬 데이터)는 gitignored 여도 절대 안 지운다");
  assert.equal(kindOf("weird-cache"), "unclassified", "모르는 gitignored 항목은 미분류 — 지우지 않고 보고만");
  assert.ok(plan.reclaimableBytes >= 6000, "회수 가능량은 derived 만 합산");

  const res = await applyReclaim(plan);
  assert.ok(!fs.existsSync(path.join(dir, "node_modules")), "파생물은 지워져야");
  assert.ok(!fs.existsSync(path.join(dir, "build")), "파생물은 지워져야");
  assert.ok(fs.existsSync(path.join(dir, ".env")), "⚠ .env 가 지워졌다 — 시크릿 손실!");
  assert.equal(await fsp.readFile(path.join(dir, "data", "db.sqlite"), "utf8"), "real-data", "⚠ data/ 가 지워졌다 — 데이터 손실!");
  assert.ok(fs.existsSync(path.join(dir, "weird-cache")), "미분류는 안 지운다");
  assert.ok(fs.existsSync(path.join(dir, "src.txt")), "추적 중인 소스는 당연히 보존");
  assert.ok(res.freedBytes >= 6000);

  await fsp.rm(path.dirname(dir), { recursive: true, force: true });
}

// ── allow-list 이름이어도 gitignored 가 아니면 안 지운다 (소스가 build/ 인 레포) ──
{
  const { dir } = await makeRepo();
  // build 를 .gitignore 에서 빼고 **추적되는 소스**로 만든다.
  await fsp.writeFile(path.join(dir, ".gitignore"), "node_modules/\n");
  await fsp.mkdir(path.join(dir, "build"), { recursive: true });
  await fsp.writeFile(path.join(dir, "build", "important.c"), "int main(){}");
  await git(["add", "-A"], dir);
  await git(["commit", "-m", "build is source here"], dir);

  const plan = await planReclaim(dir);
  assert.ok(!plan.entries.some((e) => e.rel.startsWith("build")), "추적되는 build/ 는 후보에 아예 없어야 한다");
  await applyReclaim(plan);
  assert.ok(fs.existsSync(path.join(dir, "build", "important.c")), "⚠ 추적 중인 build/ 가 지워졌다 — 소스 손실!");

  await fsp.rm(path.dirname(dir), { recursive: true, force: true });
}

// ── 워크트리 제거 게이트: 더티 / 미푸시 / upstream 없음 ──
{
  const { dir } = await makeRepo();

  // 깨끗 + 푸시 완료 → 제거 가능
  let c = await checkWorktree(dir);
  assert.equal(c.removable, true, `클린·푸시완료면 제거 가능해야: ${c.reason}`);

  // 미푸시 커밋 → 거부
  await fsp.writeFile(path.join(dir, "src.txt"), "changed");
  await git(["commit", "-am", "wip"], dir);
  c = await checkWorktree(dir);
  assert.equal(c.removable, false, "⚠ 미푸시 커밋이 있는데 제거 가능이라 했다 — 커밋 손실!");
  assert.equal(c.unpushed, 1);
  assert.match(c.reason ?? "", /push/);

  // 더티(미커밋 변경) → 거부
  await git(["push"], dir);
  await fsp.writeFile(path.join(dir, "src.txt"), "dirty now");
  c = await checkWorktree(dir);
  assert.equal(c.removable, false, "⚠ 더티인데 제거 가능이라 했다 — 작업 손실!");
  assert.equal(c.dirty, true);

  await fsp.rm(path.dirname(dir), { recursive: true, force: true });
}

// ── upstream 없는 브랜치 → 거부 (커밋이 이 워크트리에만 있다) ──
{
  const { dir } = await makeRepo();
  await git(["checkout", "-b", "local-only"], dir);
  await fsp.writeFile(path.join(dir, "new.txt"), "only here");
  await git(["add", "-A"], dir);
  await git(["commit", "-m", "local only"], dir);
  const c = await checkWorktree(dir);
  assert.equal(c.removable, false, "⚠ 원격에 없는 브랜치인데 제거 가능이라 했다 — 커밋 소멸!");
  assert.equal(c.unpushed, -1);
  assert.match(c.reason ?? "", /upstream|원격/);
  await fsp.rm(path.dirname(dir), { recursive: true, force: true });
}

// ── 활성 세션이 붙어 있으면 아무것도 안 지운다 ──
{
  const { dir } = await makeRepo();
  await fsp.mkdir(path.join(dir, "node_modules"), { recursive: true });
  await fsp.writeFile(path.join(dir, "node_modules", "x"), "x".repeat(3000));

  const plan = await planReclaim(dir, { activeSessionDirs: [path.join(dir, "packages", "a")] });
  assert.equal(plan.active_session, true, "워크트리 안에서 도는 세션을 감지해야");
  assert.equal(plan.worktree_check.removable, false);

  const res = await applyReclaim(plan, { removeWorktree: true, repoRoot: dir });
  assert.deepEqual(res.removed, [], "⚠ 활성 세션이 있는데 파일을 지웠다 — 그 세션의 빌드가 깨진다!");
  assert.ok(fs.existsSync(path.join(dir, "node_modules")));
  assert.equal(res.worktreeRemoved, false);

  await fsp.rm(path.dirname(dir), { recursive: true, force: true });
}

// ── ⚠ 심링크: 회수 대상이 되면 안 된다 (실제 사고 회귀, 2026-07-13) ──
//  실사고: 누가 워크트리의 node_modules 를 **라이브 게이트웨이의 node_modules 로 가는 심링크**로 걸어뒀는데,
//   dirSize 가 링크를 따라가 대상 크기(224MB)를 "회수 가능"으로 **거짓 보고**했다.
//   ("라이브 의존성을 지울 뻔했다"고 알려졌으나, 실측하니 fs.rm 은 심링크를 lstat 으로 판별해 **링크만 unlink**
//    한다 — 대상은 무사했다. 즉 데이터 손실 위험은 없었고 **거짓 회수량 보고**가 진짜 결함이었다.)
//  어느 쪽이든 심링크는 지워봐야 0바이트 회수하고 남의 의도적 배치만 깨뜨린다 → 손대지 않고 '미분류'로 보고한다.
{
  const { dir } = await makeRepo();
  const outside = path.join(path.dirname(dir), "LIVE_node_modules"); // 워크트리 '밖'의 라이브 의존성
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(outside, "live.js"), "x".repeat(100000));
  await fsp.symlink(outside, path.join(dir, "node_modules"), "dir");
  // 대조군 — 진짜 파생물은 회수돼야 한다.
  await fsp.mkdir(path.join(dir, "dist"), { recursive: true });
  await fsp.writeFile(path.join(dir, "dist", "o"), "x".repeat(3000));

  const plan = await planReclaim(dir);
  const nm = plan.entries.find((e) => e.rel === "node_modules");
  assert.ok(nm, "심링크도 후보 목록엔 보여야 한다(사람이 알아채게)");
  assert.equal(nm.kind, "unclassified", "⚠ 심링크가 derived 로 잡히면 지워진다 — 반드시 미분류여야 한다");
  assert.equal(nm.symlink, true, "심링크임을 표시해야 왜 안 지워지는지 안다");
  assert.equal(nm.bytes, 0, "⚠ 심링크 대상의 크기를 우리 것인 양 보고하면 안 된다(거짓 회수량 = 실제 사고 원인)");

  assert.ok(plan.reclaimableBytes < 100_000, `회수 가능량에 심링크 대상 크기가 섞였다: ${plan.reclaimableBytes}`);
  assert.ok(plan.reclaimableBytes >= 3000, "진짜 파생물(dist)은 회수 가능량에 잡혀야 한다");

  await applyReclaim(plan);
  assert.ok(fs.existsSync(path.join(dir, "node_modules")), "⚠ 심링크를 지웠다 — 남의 의도적 배치를 깨뜨린다");
  assert.ok(fs.existsSync(path.join(outside, "live.js")), "⚠⚠ 심링크 대상(라이브 의존성)이 지워졌다 — 데이터 손실!");
  assert.ok(!fs.existsSync(path.join(dir, "dist")), "진짜 파생물은 회수돼야 한다");

  await fsp.rm(path.dirname(dir), { recursive: true, force: true });
}

// ── 경로 포함 판정: /a/b 와 /a/bc 를 헷갈리면 안 된다 ──
{
  assert.equal(isInside("/a/b/c", "/a/b"), true);
  assert.equal(isInside("/a/b", "/a/b"), true, "자기 자신도 '안'");
  assert.equal(isInside("/a/bc", "/a/b"), false, "접두사만 같은 형제 디렉터리를 '안'으로 보면 안 된다");
  assert.equal(isInside("/x", "/a/b"), false);
}

// ── 목록 자체의 정합성 (보호목록이 파생물 목록에 섞이면 시크릿이 지워진다) ──
{
  for (const p of PROTECTED_NAMES) {
    assert.ok(!DERIVED_NAMES.includes(p), `⚠ '${p}' 가 파생물 목록에도 있다 — 보호가 무력화된다`);
  }
}

// ── reposIn: 레포 탐지 (#845) ──────────────────────────────────────────────────
//  이 판정이 목록·분석·회수에서 갈리면 "목록엔 [분석] 버튼이 있는데 누르면 '레포가 없습니다' 에러"가 난다.
//  실제로 그랬다 — dev 박스 307개 폴더 중 184개가 레포 없는 껍데기였고, 관리탭은 거기에도 버튼을 달았다.
{
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "reposin-"));

  // ① 레포를 provision 하지 않은 프로젝트 폴더 = 껍데기. **에러가 아니라 빈 배열**이어야 한다.
  const shell = path.join(root, "shell");
  await fsp.mkdir(shell, { recursive: true });
  await fsp.mkdir(path.join(shell, ".lively"), { recursive: true });
  await fsp.writeFile(path.join(shell, "AGENTS.md"), "# agents");
  assert.deepEqual(await reposIn(shell), [], "레포 없는 폴더는 빈 배열(에러가 아니다 — 회수할 게 없을 뿐)");

  // ② 없는 폴더도 던지지 않는다(고아 폴더가 그새 사라졌을 수 있다).
  assert.deepEqual(await reposIn(path.join(root, "nope")), [], "없는 폴더는 빈 배열");

  // ③ 워크트리(.git = **파일**)와 일반 클론(.git = **디렉터리**)을 **둘 다** 잡아야 한다.
  //    워크트리의 .git 은 gitdir 포인터 파일이라, isDirectory() 로 판정하면 워크트리를 통째로 놓친다.
  const proj = path.join(root, "proj");
  const asWorktree = path.join(proj, "repo-worktree");
  const asClone = path.join(proj, "repo-clone");
  const notRepo = path.join(proj, "uploads"); // 스크린샷·업로드 등 — 레포가 아니다
  for (const d of [asWorktree, asClone, notRepo]) await fsp.mkdir(d, { recursive: true });
  await fsp.writeFile(path.join(asWorktree, ".git"), "gitdir: /somewhere/.git/worktrees/x\n"); // 파일
  await fsp.mkdir(path.join(asClone, ".git"), { recursive: true }); // 디렉터리
  await fsp.writeFile(path.join(notRepo, "shot.png"), "x");

  const found = await reposIn(proj);
  assert.deepEqual(found, [asClone, asWorktree].sort(), "워크트리(.git 파일)와 일반 클론(.git 디렉터리) 둘 다 — 레포 아닌 폴더는 제외");

  await fsp.rm(root, { recursive: true, force: true });
}

console.log("workspace-reclaim.test.ts ok — gitignored∩allow-list 만 삭제 · .env/data 보호 · 미푸시·더티·활성세션이면 거부 · reposIn(워크트리=.git파일/클론=.git디렉터리 둘 다, 껍데기는 빈 배열)");
