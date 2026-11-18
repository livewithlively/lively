// 워크스페이스 회수 안전 게이트 테스트 (#813 T3-2) — **고객 코드를 지우면 되돌릴 수 없다.**
//  여기서 못 박는 것(하나라도 깨지면 고객 자산 손실):
//   ① gitignored 라도 allow-list 밖이면 안 지운다 — `.env`(시크릿)·`data/`(로컬 데이터)는 전부 gitignored 다.
//   ② allow-list 이름이어도 gitignored 가 아니면 안 지운다 — 소스 디렉터리가 `build/` 인 레포가 실제로 있다.
//   ③ 더티 / 원격 어디에도 없는 커밋 → 워크트리 제거 **거부**(이유를 말한다).
//     — 반대로 **원격에 있으면 upstream 설정이 없어도 허용**해야 한다(#922: 프록시를 보면 안전한 워크트리를 거부한다).
//   ④ 활성 세션이 붙어 있으면 **아무것도** 안 지운다(빌드 중일 수 있다).
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { planReclaim, applyReclaim, checkWorktree, isInside, reposIn, DERIVED_NAMES, PROTECTED_NAMES, isWorktreeActive, planEviction, worktreeLastUsed, type EvictCandidate } from "./workspace-reclaim.js";

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

// ── 워크트리 제거 게이트: 더티 / 원격에 없는 커밋 ──
{
  const { dir } = await makeRepo();

  // 깨끗 + 푸시 완료 → 제거 가능
  let c = await checkWorktree(dir);
  assert.equal(c.removable, true, `클린·푸시완료면 제거 가능해야: ${c.reason}`);

  // 미푸시 커밋 → 거부 (upstream 이 **있는** 브랜치 — 아래 'local-only' 케이스와 짝)
  await fsp.writeFile(path.join(dir, "src.txt"), "changed");
  await git(["commit", "-am", "wip"], dir);
  c = await checkWorktree(dir);
  assert.equal(c.removable, false, "⚠ 미푸시 커밋이 있는데 제거 가능이라 했다 — 커밋 손실!");
  assert.equal(c.unpushed, 1);
  assert.match(c.reason ?? "", /원격/);

  // 더티(미커밋 변경) → 거부
  await git(["push"], dir);
  await fsp.writeFile(path.join(dir, "src.txt"), "dirty now");
  c = await checkWorktree(dir);
  assert.equal(c.removable, false, "⚠ 더티인데 제거 가능이라 했다 — 작업 손실!");
  assert.equal(c.dirty, true);

  await fsp.rm(path.dirname(dir), { recursive: true, force: true });
}

// ── upstream 없는 브랜치 + 어디에도 push 안 함 → 거부 (박스를 재구축하면 사라진다) ──
//  아래 #922 케이스와 **한 글자 차이**다(push 를 했나 안 했나). upstream 이 없다는 사실은 둘이 똑같으므로,
//  판정이 upstream 설정을 보면 둘을 구분하지 못한다 — 이 짝이 "안전을 안 낮췄다"를 지킨다.
{
  const { dir } = await makeRepo();
  await git(["checkout", "-b", "local-only"], dir);
  await fsp.writeFile(path.join(dir, "new.txt"), "only here");
  await git(["add", "-A"], dir);
  await git(["commit", "-m", "local only"], dir);
  const c = await checkWorktree(dir);
  assert.equal(c.removable, false, "⚠ 원격 어디에도 없는 커밋인데 제거 가능이라 했다 — 박스 재구축 시 소멸!");
  assert.equal(c.unpushed, 1);
  assert.match(c.reason ?? "", /원격/);
  await fsp.rm(path.dirname(dir), { recursive: true, force: true });
}

// ── ⚠ #922 회귀: 다른 이름으로 push 된 브랜치 → **허용** (upstream '설정' 이 아니라 '원격 도달성'을 물어야 한다) ──
//  실사고(#904): `git push origin project/904:main` 으로 밀어 브랜치명이 달라 upstream 추적이 없었는데, 커밋은
//   origin/main 에 멀쩡히 있었다. 그런데 판정이 upstream **설정**을 보고 "커밋이 이 워크트리에만 있습니다"라며
//   거부했다 — 확인한 적도 없는 주장이었다.
//  이건 엣지가 아니라 **기본 경로**다: provisionProjectRepos 는 시작점 없이 `worktree add -b project/<id>` 로 자르므로
//   프로젝트 워크트리엔 애초에 upstream 이 안 붙는다 → 프록시를 보면 **푸시 여부와 무관하게 영영 거부**된다.
{
  const { dir } = await makeRepo();
  await git(["checkout", "-b", "project/904"], dir); // provision 동형 — 시작점을 안 주므로 upstream 이 안 붙는다
  await fsp.writeFile(path.join(dir, "new.txt"), "the work");
  await git(["add", "-A"], dir);
  await git(["commit", "-m", "work"], dir);
  await git(["push", "origin", "project/904:main"], dir); // 브랜치명과 **다른 이름**으로 push(#904 가 실제로 한 것)

  // 전제 확인 — upstream 은 정말 없다. 이게 깨지면(예: git 기본값이 바뀌어 추적이 붙으면) 이 테스트는 오탐을
  //  재현하지 못한 채 조용히 통과한다. 재현 조건부터 못 박는다.
  await assert.rejects(
    git(["rev-parse", "--abbrev-ref", "@{upstream}"], dir),
    "이 테스트는 upstream 없는 브랜치를 전제한다 — 추적이 붙었다면 #922 오탐을 재현하지 못한다",
  );

  const c = await checkWorktree(dir);
  assert.equal(c.removable, true, `⚠ 커밋이 origin/main 에 있는데 거부했다 — 원격 도달성이 아니라 upstream 설정을 보고 있다: ${c.reason}`);
  assert.equal(c.unpushed, 0, "origin/main 에서 닿는 커밋이므로 '원격에 없는 커밋' 은 0 이어야");
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

// ───────────────────────── #5368 — 워크트리 제거가 지키는 무시 파일을 같이 지우지 않는다 ─────────────────────────
//  `git worktree remove` 는 무시된 파일을 막지 않고 폴더째 지운다. 파생물 회수에서는 지키던 .env · data/ · 미분류 항목이
//   워크트리 제거에서 함께 사라졌다. 수정 전 코드로는 K1 · K2 가 빨간불이다(워크트리가 지워지고 .env 가 없어진다).
async function makeWorktree(): Promise<{ root: string; base: string; wt: string }> {
  const { dir } = await makeRepo();
  const root = path.dirname(dir);
  const wt = path.join(root, "wt");
  await git(["worktree", "add", "-b", "feat", wt, "main"], dir);
  return { root, base: dir, wt };
}
{
  // K1 — .env(보호)가 남아 있으면 거부하고 무엇이 남았는지 말한다.
  const { root, base, wt } = await makeWorktree();
  await fsp.writeFile(path.join(wt, ".env"), "SECRET=abc");
  await fsp.mkdir(path.join(wt, "node_modules"), { recursive: true });
  await fsp.writeFile(path.join(wt, "node_modules", "x"), "x");
  const res = await applyReclaim(await planReclaim(wt), { removeWorktree: true, repoRoot: base });
  assert.equal(res.worktreeRemoved, false, "K1 보호 무시 파일(.env)이 있으면 워크트리를 제거하지 않는다");
  assert.match(String(res.worktreeSkippedReason), /\.env/, "K1 남은 것을 사유에 적는다");
  assert.equal(fs.existsSync(path.join(wt, ".env")), true, "K1 .env 가 그대로 있다");
  assert.equal(fs.existsSync(path.join(wt, "node_modules")), false, "K1 파생물은 종전대로 지운다");
  await fsp.rm(root, { recursive: true, force: true });
}
{
  // K2 — 미분류 무시 항목(weird-cache/ · 로그 같은 것)도 같다.
  const { root, base, wt } = await makeWorktree();
  await fsp.mkdir(path.join(wt, "weird-cache"), { recursive: true });
  await fsp.writeFile(path.join(wt, "weird-cache", "w"), "?");
  const res = await applyReclaim(await planReclaim(wt), { removeWorktree: true, repoRoot: base });
  assert.equal(res.worktreeRemoved, false, "K2 미분류 무시 항목이 있으면 워크트리를 제거하지 않는다");
  assert.equal(fs.existsSync(path.join(wt, "weird-cache", "w")), true, "K2 미분류 항목이 그대로 있다");
  await fsp.rm(root, { recursive: true, force: true });
}
{
  // K3 — 무시 파일이 파생물뿐이면 종전대로 제거한다(막기만 하면 회수가 죽는다).
  const { root, base, wt } = await makeWorktree();
  await fsp.mkdir(path.join(wt, "node_modules"), { recursive: true });
  await fsp.writeFile(path.join(wt, "node_modules", "x"), "x");
  await fsp.mkdir(path.join(wt, "dist"), { recursive: true });
  await fsp.writeFile(path.join(wt, "dist", "o"), "o");
  const res = await applyReclaim(await planReclaim(wt), { removeWorktree: true, repoRoot: base });
  assert.equal(res.worktreeRemoved, true, `K3 파생물만 있던 워크트리는 제거한다 (${res.worktreeSkippedReason})`);
  assert.equal(fs.existsSync(wt), false, "K3 폴더가 사라졌다");
  await fsp.rm(root, { recursive: true, force: true });
}
{
  // K4 — 심링크는 링크만 사라지고 대상은 그대로라 막지 않는다.
  const { root, base, wt } = await makeWorktree();
  const shared = path.join(root, "shared-nm");
  await fsp.mkdir(shared, { recursive: true });
  await fsp.writeFile(path.join(shared, "keep"), "k");
  await fsp.symlink(shared, path.join(wt, "node_modules"));
  const res = await applyReclaim(await planReclaim(wt), { removeWorktree: true, repoRoot: base });
  assert.equal(res.worktreeRemoved, true, `K4 무시된 심링크만 있으면 제거한다 (${res.worktreeSkippedReason})`);
  assert.equal(fs.existsSync(path.join(shared, "keep")), true, "K4 심링크 대상은 그대로다");
  await fsp.rm(root, { recursive: true, force: true });
}

// ───────────────────────── #5368 — 이 워크트리에서 누가 일하고 있나 ─────────────────────────
{
  const P = "/Users/u/workspace/project";
  const wt = `${P}/5321/lively`;
  const scratch = "/private/tmp/claude-501/-Users-u-workspace-project-5321/04daa51e/scratchpad/stage5321";
  const rows: Array<[string, string, string[], boolean]> = [
    ["A1 세션이 워크트리 안에서 돈다", wt, [`${wt}/web`], true],
    ["A2 세션이 워크트리 자신에서 돈다", wt, [wt], true],
    ["A3 세션이 바로 위 프로젝트 폴더에서 돈다", wt, [`${P}/5321`], true],
    ["A4 다른 프로젝트 폴더의 세션은 상관없다", wt, [`${P}/5322`, `${P}/5322/lively`], false],
    ["A5 이름이 앞부분만 같은 프로젝트(532 · 53210)는 상관없다", wt, [`${P}/532`, `${P}/53210`], false],
    ["A6 홈 · 워크스페이스 루트에서 도는 프로세스가 모든 워크트리를 잡지 않는다", wt, ["/Users/u", "/Users/u/workspace", P, "/"], false],
    ["A7 스크래치 워크트리 — 그 프로젝트 폴더에서 도는 세션이 있다", scratch, [`${P}/5321`], true],
    ["A8 스크래치 워크트리 — 그 프로젝트의 워크트리 안에서 도는 세션이 있다", scratch, [`${P}/5321/lively`], true],
    ["A9 스크래치 워크트리 — 같은 스크래치의 다른 폴더에서 도는 프로세스가 있다", scratch, ["/private/tmp/claude-501/-Users-u-workspace-project-5321/04daa51e/scratchpad"], true],
    ["A10 스크래치 워크트리 — 다른 프로젝트(532 · 53210 · 5322)의 세션은 상관없다", scratch, [`${P}/532`, `${P}/53210/lively`, `${P}/5322`], false],
    ["A11 세션이 하나도 없다", wt, [], false],
  ];
  for (const [name, w, dirs, want] of rows) assert.equal(isWorktreeActive(w, dirs), want, name);
  // planReclaim 이 같은 판정을 쓴다 — 프로젝트 폴더에서 도는 세션이 있으면 그 아래 워크트리는 손대지 않는다.
  const { dir } = await makeRepo();
  await fsp.mkdir(path.join(dir, "node_modules"), { recursive: true });
  await fsp.writeFile(path.join(dir, "node_modules", "x"), "x");
  const plan = await planReclaim(dir, { activeSessionDirs: [path.dirname(dir)] });
  assert.equal(plan.active_session, true, "A12 바로 위 폴더의 세션이 계획에서도 «작업 중» 으로 잡힌다");
  const res = await applyReclaim(plan);
  assert.deepEqual(res.removed, [], "A12 그러면 아무것도 지우지 않는다");
  assert.equal(fs.existsSync(path.join(dir, "node_modules", "x")), true, "A12 node_modules 가 그대로 있다");
  await fsp.rm(path.dirname(dir), { recursive: true, force: true });
}

// ───────────────────────── #5368 — 파생물 축출 계획 ─────────────────────────
{
  const DAY = 86_400_000;
  const now = 1_800_000_000_000;
  const GB = 1e9;
  const disk = (usedPct: number) => ({ usedPct, totalBytes: 100 * GB });
  const c = (worktree: string, gb: number, daysAgo: number | null, active = false): EvictCandidate =>
    ({ worktree, reclaimableBytes: gb * GB, lastUsedMs: daysAgo === null ? null : now - daysAgo * DAY, active });
  const names = (p: { picks: EvictCandidate[] }) => p.picks.map((x) => x.worktree);

  const all = [c("old", 4, 30), c("mid", 4, 10), c("new", 4, 5), c("fresh", 4, 1), c("busy", 4, 40, true), c("empty", 0, 50), c("unknown", 4, null)];
  // E1 — 넉넉하면 아무것도 고르지 않는다.
  let p = planEviction({ candidates: all, disk: disk(60), now });
  assert.deepEqual(names(p), [], "E1 기준(85%) 아래면 고르지 않는다");
  assert.equal(p.pressure, false, "E1 압박 아님");
  // E2 — 기준 바로 위: 목표까지 필요한 만큼만, 오래 안 쓴 것부터.
  p = planEviction({ candidates: all, disk: disk(86), now });            // 86 → 75 = 11GB 필요 → old(4)+mid(4)+new(4)
  assert.deepEqual(names(p), ["old", "mid", "new"], "E2 오래 안 쓴 것부터 목표에 닿을 때까지");
  p = planEviction({ candidates: all, disk: disk(86), policy: { targetPct: 80 }, now }); // 6GB 필요 → old+mid
  assert.deepEqual(names(p), ["old", "mid"], "E3 목표에 닿으면 멈춘다");
  // E4 — 작업 중 · 최근에 쓴 것 · 쓴 때 모르는 것 · 파생물 없는 것은 아무리 압박이 커도 고르지 않는다.
  p = planEviction({ candidates: all, disk: disk(99), now });
  assert.deepEqual(names(p), ["old", "mid", "new"], "E4 쉬는 것만 고른다");
  assert.deepEqual(p.skipped, { active: 1, fresh: 1, unknown_age: 1, empty: 1 }, "E4 건너뛴 사유를 센다");
  // E5 — 쉰 기간 기준.
  p = planEviction({ candidates: all, disk: disk(99), policy: { idleDays: 20 }, now });
  assert.deepEqual(names(p), ["old"], "E5 idleDays 안에 손댄 것은 건너뛴다");
  // E6 — 디스크를 못 쟀으면 고르지 않는다(«다 지워라» 가 아니다).
  for (const d of [null, { usedPct: Number.NaN, totalBytes: 100 * GB }, { usedPct: 99, totalBytes: 0 }]) {
    assert.deepEqual(names(planEviction({ candidates: all, disk: d, now })), [], "E6 디스크를 못 재면 고르지 않는다");
  }
  // E7 — force 는 디스크를 보지 않고 쉬는 것 전부(작업 중 · 최근 것은 여전히 제외).
  p = planEviction({ candidates: all, disk: null, policy: { force: true }, now });
  assert.deepEqual(names(p), ["old", "mid", "new"], "E7 force 는 쉬는 것 전부");
  // E8 — 이상한 기준값은 기본값으로(오입력이 «전부 지움» 이 되지 않는다).
  p = planEviction({ candidates: all, disk: disk(60), policy: { pressurePct: "abc" as unknown as number, targetPct: -5, idleDays: "x" as unknown as number }, now });
  assert.deepEqual([p.pressurePct, p.targetPct, p.idleDays], [85, 75, 3], "E8 못 읽는 값은 기본값");
  assert.deepEqual(names(p), [], "E8 그래서 60% 에서는 고르지 않는다");
  // E9 — 목표가 기준보다 높게 들어오면 기준으로 내린다(끝없이 지우지 않는다).
  p = planEviction({ candidates: all, disk: disk(90), policy: { pressurePct: 80, targetPct: 95 }, now });
  assert.equal(p.targetPct, 80, "E9 목표는 기준을 넘지 않는다");
}
{
  // L1 — 마지막으로 쓴 때: 방금 만든 레포는 «방금» 이고, 레포가 아니면 폴더 시각만 본다.
  const { dir } = await makeRepo();
  const t = await worktreeLastUsed(dir);
  assert.ok(t !== null && Math.abs(Date.now() - t) < 120_000, "L1 방금 커밋한 레포의 마지막 사용 시각은 지금 근처다");
  await fsp.rm(path.dirname(dir), { recursive: true, force: true });
  assert.equal(await worktreeLastUsed(path.join(os.tmpdir(), "reclaim-nope-" + process.pid)), null, "L1 없는 경로는 null");
}

console.log("workspace-reclaim.test.ts ok — gitignored∩allow-list 만 삭제 · .env/data 보호 · 더티·원격에없는커밋·활성세션이면 거부(단 다른 이름으로 push 됐으면 upstream 없어도 허용) · reposIn(워크트리=.git파일/클론=.git디렉터리 둘 다, 껍데기는 빈 배열)");
