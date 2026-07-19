#!/usr/bin/env node
// repo-worktree-core(#900) 유닛 — 워크트리 **경로·브랜치 결정**을 실제 git 으로 검증한다(#932).
//  실행: node kit/cli/repo-worktree-core.test.mjs   (npm test 체인에 포함)
//  네트워크·~/.lively 무접촉 — tmp 에 origin/base 를 만들고 LIVELY_REPOS_DIR 로 reposDir() 를 갈아끼운다.
//
//  왜 이 파일이 있나: `project/<id>` 는 **프로젝트당 1개인 싱글턴 이름**인데 워크트리는 프로젝트당 여러 개
//   생길 수 있는 다중 인스턴스 자원이고, git 은 "브랜치 1개 = 워크트리 최대 1개"를 강제한다. 예전엔 브랜치를
//   마커까지 올라가 정하면서 경로는 cwd 에서 뽑아, 같은 project/<id> 를 노리는 워크트리가 여러 자리에 생겼다
//   → 나중에 온 쪽이 죽었다(서버 provision 이면 502). 아래는 그 불변식들이다.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = join(fileURLToPath(import.meta.url), "..");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.error(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why || "조건 불만족"));

const SB = mkdtempSync(join(tmpdir(), "wt-core-test-"));
const sh = (cmd, args = [], { cwd = SB, allowFail = false } = {}) => {
  try { return { stdout: execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "", code: 0 }; }
  catch (e) { if (!allowFail) throw e; return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.status ?? 1 }; }
};

(async () => {
  // ── 픽스처: origin ← base(공유 원본) · 프로젝트 폴더(마커 포함) ──
  sh("git", ["init", "-q", "--initial-branch=main", "origin-repo"]);
  sh("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: join(SB, "origin-repo") });
  sh("git", ["clone", "-q", join(SB, "origin-repo"), "base"]);
  process.env.LIVELY_REPOS_DIR = SB;                     // reposDir() → SB ⇒ base = SB/base
  const { repoWorktree } = await import(join(HERE, "repo-worktree-core.mjs"));

  const proj = join(SB, "workspace", "project", "999");
  mkdirSync(join(proj, ".lively"), { recursive: true });
  writeFileSync(join(proj, ".lively", "project.json"), JSON.stringify({ project_id: 999 }));
  mkdirSync(join(proj, "deep", "nested"), { recursive: true });
  // 코어 ctx — sh 는 호출자 cwd 기본, api 는 안 쓰이게 base 를 미리 깔아둠(clone 경로 미진입).
  const ctx = (cwd) => ({ cwd, sh: (c, a, o) => sh(c, a, { ...o, cwd: o?.cwd ?? cwd }), api: async () => ({ domainmapRepos: [], repos: [] }) });
  const branchAt = (p) => sh("git", ["-C", p, "rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).stdout.trim();

  // ── 1) 프로젝트 세션: 기본 경로 = canonical 슬롯(<프로젝트 폴더>/<repo>), 브랜치 = project/<id> ──
  //  서버 provisionProjectRepos 가 워크트리를 두는 자리·이름과 **같아야** 둘이 서로 멱등이다.
  let r = await repoWorktree(ctx(proj), { repo: "base" });
  check("프로젝트 루트 · path 없음 → canonical 슬롯", r.worktree === join(proj, "base"), r.worktree);
  check("프로젝트 루트 · path 없음 → project/<id>", r.branch === "project/999", r.branch);

  // ── 2) cwd 가 프로젝트 **하위 깊은 곳**이어도 같은 슬롯으로 수렴 ──
  //  회귀 방어: 경로를 cwd 에서 뽑던 시절엔 deep/nested/base 에 또 하나가 생기며 project/999 를 두고 충돌했다.
  r = await repoWorktree(ctx(join(proj, "deep", "nested")), { repo: "base" });
  check("프로젝트 하위 cwd · path 없음 → 같은 canonical 슬롯(멱등 재사용)", r.worktree === join(proj, "base"), r.worktree);

  // ── 3) 슬롯 **밖**(path 명시)엔 project/<id> 를 걸지 않는다 ──
  //  걸면 그 프로젝트의 provision 이 502 로 죽는다 — 싱글턴 이름은 싱글턴 자리에만.
  r = await repoWorktree(ctx(proj), { repo: "base", path: join(SB, "scratch", "co-work") });
  check("슬롯 밖(path 명시) → project/<id> 를 뺏지 않음", r.branch !== "project/999", r.branch);
  check("슬롯 밖(path 명시) → wt/<repo>", r.branch === "wt/base", r.branch);

  // ── 4) 슬롯 밖끼리도 안 겹친다(점유되지 않은 첫 이름) ──
  r = await repoWorktree(ctx(proj), { repo: "base", path: join(SB, "scratch", "co-src") });
  check("슬롯 밖 두 번째 → wt/<repo>-2", r.branch === "wt/base-2", r.branch);

  // ── 5) canonical 슬롯은 계속 project/<id> 를 쥔다(= provision 이 재사용할 자리가 살아있다) ──
  check("canonical 슬롯 브랜치 보존", branchAt(join(proj, "base")) === "project/999", branchAt(join(proj, "base")));

  // ── 6) prune: 워크트리 디렉터리가 청소돼도 그 브랜치가 영구히 막히지 않는다 ──
  //  git 은 디렉터리가 사라진 등록(prunable)도 **점유로 세서** -b 도 attach 도 막는다. add 전에 털어야 풀린다.
  rmSync(join(SB, "scratch", "co-work"), { recursive: true, force: true });   // = /tmp 청소
  r = await repoWorktree(ctx(proj), { repo: "base", path: join(SB, "scratch", "again") });
  check("스테일 워크트리 청소 후 wt/<repo> 재사용(영구잠금 없음)", r.branch === "wt/base", r.branch);

  // ── 7) 점유된 브랜치를 명시하면 — 점유자 경로 + 빠져나갈 방법이 담긴 실패 ──
  //  git 의 fatal 만 흘리면 '왜/어떻게'가 없고, 3단 폴백의 마지막이 -b 라 fatal 이 'already exists' 로 끝나
  //  점유 사실 자체가 안 보인다.
  try {
    await repoWorktree(ctx(proj), { repo: "base", path: join(SB, "scratch", "boom"), branch: "project/999" });
    bad("점유 브랜치 명시 → 실패해야 함", "성공해버림");
  } catch (e) {
    check("점유 브랜치 명시 → 점유자 경로를 알려준다", e.message.includes(join(proj, "base")), e.message);
    check("점유 브랜치 명시 → 빠져나갈 방법을 알려준다", /branch 인자/.test(e.message), e.message);
  }

  // ── 8) canonical 슬롯을 **다른 표기로** 가리켜도 슬롯으로 알아본다(끝 슬래시·`..`) ──
  //  판정이 문자열 === 라 정규화가 빠지면 '슬롯 밖'으로 오판 → canonical 자리에 wt/<repo> 가 박힌다.
  r = await repoWorktree(ctx(proj), { repo: "base", path: join(proj, "base") + "/" });
  check("canonical 을 끝 슬래시로 가리켜도 같은 워크트리(멱등)", r.worktree === join(proj, "base"), r.worktree);
  r = await repoWorktree(ctx(proj), { repo: "base", path: join(proj, "deep", "..", "base") });
  check("canonical 을 `..` 경유로 가리켜도 같은 워크트리(멱등)", r.worktree === join(proj, "base"), r.worktree);

  // ── 9) 프로젝트 **밖** 세션은 종전대로 cwd/<repo> · wt/<repo> ──
  const outside = join(SB, "elsewhere");
  mkdirSync(outside, { recursive: true });
  r = await repoWorktree(ctx(outside), { repo: "base" });
  check("프로젝트 밖 → cwd/<repo>", r.worktree === join(outside, "base"), r.worktree);
  check("프로젝트 밖 → wt/<repo> 계열", /^wt\/base/.test(r.branch), r.branch);

  rmSync(SB, { recursive: true, force: true });
  console.error(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { rmSync(SB, { recursive: true, force: true }); console.error("테스트 하네스 오류:", e); process.exit(1); });
