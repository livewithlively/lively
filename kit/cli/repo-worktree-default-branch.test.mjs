#!/usr/bin/env node
// 워크트리 · 핀 도구의 **기본 ref** 가 «레포에 등록한 기본 브랜치» 를 따르는지(#1723) — 실제 git 으로 검증.
//  실행: node kit/cli/repo-worktree-default-branch.test.mjs   (npm test 체인에 포함)
//  네트워크·~/.lively 무접촉 — tmp 에 원격/base 를 만들고 LIVELY_REPOS_DIR 로 reposDir() 를 갈아끼운다.
//
//  사양(이슈 #1723 «바라는 동작» 3·4):
//   · ref 를 안 준 워크트리 · 핀은 등록한 기본 브랜치에서 뜬다. 등록값이 없으면 지금처럼 원격 기본 브랜치.
//   · ref 를 직접 준 호출은 그 값을 따른다.
//   · 등록 브랜치가 원격에 없으면 지금 동작(원격 기본 브랜치)으로 돌아가고 사유를 남긴다.
//   · 이미 떠 있는 워크트리는 건드리지 않는다.
//  픽스처: 원격 기본 브랜치 = develop(배포 전 코드) · 배포 브랜치 = main. 등록값은 게이트웨이 레포 목록
//   (GET /api/ui/repos 의 domainmapRepos[].default_branch) 흉내로 준다.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";  // ⚠ 절대경로 동적 import 는 반드시 file:// URL 로(#1510)
import { join } from "node:path";
import { tmpdir } from "node:os";

const HERE = join(fileURLToPath(import.meta.url), "..");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.error(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why || "조건 불만족"));

const SB = realpathSync(mkdtempSync(join(tmpdir(), "wt-defbranch-test-")));
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "wt-defbranch-test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "wt-defbranch-test@test.local";
process.env.CODEX_THREAD_ID = process.env.CODEX_SESSION_ID = process.env.CLAUDE_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID = "";
process.env.LIVELY_SESSION_ID = "wt-defbranch-test-A";
const sh = (cmd, args = [], { cwd = SB, allowFail = false } = {}) => {
  try { return { stdout: execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "", code: 0 }; }
  catch (e) { if (!allowFail) throw e; return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.status ?? 1 }; }
};
const out = (cmd, args, cwd) => sh(cmd, args, { cwd }).stdout.trim();

(async () => {
  // ── 원격: main(배포) + develop(원격 기본 · main 보다 앞섬) ──
  const work = join(SB, "src-work");
  sh("git", ["init", "-q", "--initial-branch=main", work]);
  writeFileSync(join(work, "WHERE"), "main\n");
  sh("git", ["add", "-A"], { cwd: work }); sh("git", ["commit", "-q", "-m", "main 1"], { cwd: work });
  sh("git", ["checkout", "-q", "-b", "develop"], { cwd: work });
  writeFileSync(join(work, "WHERE"), "develop\n");
  sh("git", ["add", "-A"], { cwd: work }); sh("git", ["commit", "-q", "-m", "develop 1"], { cwd: work });
  const bare = join(SB, "origin.git");
  sh("git", ["clone", "-q", "--bare", work, bare]);
  sh("git", ["symbolic-ref", "HEAD", "refs/heads/develop"], { cwd: bare });   // 원격 기본 브랜치 = develop
  const url = pathToFileURL(bare).href;
  const tip = (b) => out("git", ["rev-parse", `refs/heads/${b}`], bare);
  const short = (b) => out("git", ["rev-parse", "--short", `refs/heads/${b}`], bare);

  const REPOS = join(SB, "repos");
  mkdirSync(REPOS, { recursive: true });
  process.env.LIVELY_REPOS_DIR = REPOS;
  process.env.TMPDIR = join(SB, "ostmp");                 // 핀 기본경로를 샌드박스 안으로
  mkdirSync(join(SB, "ostmp"), { recursive: true });
  const { repoWorktree, repoPin, repoPinRemove, repoList } = await import(pathToFileURL(join(HERE, "repo-worktree-core.mjs")));

  // 이 변경 이전에 받은 base 의 모양 — 원격 기본 브랜치(develop)로 받아져 있다.
  const legacyBase = (name) => { sh("git", ["clone", "-q", url, join(REPOS, name)]); return join(REPOS, name); };
  // 게이트웨이 레포 목록 흉내. calls 로 «게이트웨이를 물었나» 를 본다. rows = name → default_branch(없으면 행 자체가 없다).
  const mkCtx = (cwd, rows, { failApi = false } = {}) => {
    const c = {
      cwd, calls: 0,
      sh: (cmd, a, o) => sh(cmd, a, { ...o, cwd: o?.cwd ?? cwd }),
      api: async (p) => {
        c.calls++;
        if (failApi) throw new Error("gateway down");
        if (p !== "/api/ui/repos") throw new Error(`예상 밖 경로: ${p}`);
        // 값이 객체면 그 행을 그대로(예: git 소스 없는 행 { clone_url: null, default_branch: "main" }), 아니면 git 소스가 연결된 행.
        const domainmapRepos = Object.entries(rows).map(([name, v]) => (v && typeof v === "object" ? { name, ...v } : { name, clone_url: url, default_branch: v }));
        return { domainmapRepos, repos: Object.keys(rows) };
      },
    };
    return c;
  };
  const cwdOf = (n) => { const d = join(SB, "cwd", n); mkdirSync(d, { recursive: true }); return d; };
  const headOf = (p) => out("git", ["rev-parse", "HEAD"], p);

  // 픽스처 배선 — 원격 기본이 정말 develop 이어야 아래가 뜻을 가진다.
  {
    const b = legacyBase("probe");
    check("픽스처: 원격 기본 브랜치 = develop", out("git", ["rev-parse", "--abbrev-ref", "HEAD"], b) === "develop");
    check("픽스처: main 과 develop 이 다른 커밋", tip("main") !== tip("develop"));
  }

  // ── K1 ref 없는 워크트리 · 등록 main → origin/main 에서 뜬다 ──
  {
    legacyBase("k1");
    const c = mkCtx(cwdOf("k1"), { k1: "main" });
    const r = await repoWorktree(c, { repo: "k1" });
    check("K1 ref 없는 워크트리가 등록 브랜치(main) 커밋에서 뜬다", headOf(r.worktree) === tip("main"), `${headOf(r.worktree)} ≠ main ${tip("main")}`);
    check("K1 반환 ref = main", r.ref === "main", r.ref);
    check("K1 제대로 떴으면 사유가 없다", r.ref_note === undefined, r.ref_note);
    check("K1 배선: 게이트웨이에 등록값을 물었다", c.calls >= 1, `calls=${c.calls}`);
    check("K1 base 워킹트리는 안 건드린다(RO)", out("git", ["rev-parse", "--abbrev-ref", "HEAD"], join(REPOS, "k1")) === "develop");
  }

  // ── K2 ref 를 직접 준 호출은 그 값을 따른다 ──
  {
    legacyBase("k2");
    const c = mkCtx(cwdOf("k2"), { k2: "main" });
    const r = await repoWorktree(c, { repo: "k2", ref: "develop" });
    check("K2 ref=develop 워크트리는 develop 에서", headOf(r.worktree) === tip("develop"));
    check("K2 반환 ref = develop", r.ref === "develop", r.ref);
    const p = await repoPin(c, { repo: "k2", ref: "develop" });
    check("K2 ref=develop 핀은 develop SHA", headOf(p.pin) === tip("develop") && p.ref === "develop", `${p.sha} ${p.ref}`);
    check("K2 ref 를 줬으면 게이트웨이를 묻지 않는다(base 있음)", c.calls === 0, `calls=${c.calls}`);
  }

  // ── K3 ref 없는 핀 · 핀 지우기 — 등록 브랜치로 대칭 ──
  {
    legacyBase("k3");
    const c = mkCtx(cwdOf("k3"), { k3: "main" });
    const p = await repoPin(c, { repo: "k3" });
    check("K3 ref 없는 핀이 등록 브랜치(main) SHA", headOf(p.pin) === tip("main"), `${p.sha}`);
    check("K3 핀 반환 sha·ref", p.sha === short("main") && p.ref === "main", `${p.sha} ${p.ref}`);
    check("K3 핀 내용이 배포 코드", readFileSync(join(p.pin, "WHERE"), "utf8") === "main\n");
    // develop 핀도 떠 둔다 — 지우기가 «등록 브랜치의 핀» 만 집는지 본다.
    const pd = await repoPin(c, { repo: "k3", ref: "develop" });
    const rm = await repoPinRemove(c, { repo: "k3" });
    check("K3 ref 없는 핀 지우기가 main 핀을 지운다", rm.removed === p.pin && !existsSync(p.pin), JSON.stringify(rm));
    check("K3 다른 ref 의 핀은 남는다", existsSync(pd.pin));
  }

  // ── K4 등록 브랜치가 원격에 없다 → 원격 기본 브랜치 + 사유 ──
  {
    legacyBase("k4");
    const c = mkCtx(cwdOf("k4"), { k4: "release" });
    const r = await repoWorktree(c, { repo: "k4" });
    check("K4 워크트리: 원격 기본(develop)으로 돌아간다", headOf(r.worktree) === tip("develop") && r.ref === "develop", `${r.ref}`);
    check("K4 워크트리: 사유가 나온다", typeof r.ref_note === "string" && r.ref_note.includes("release"), String(r.ref_note));
    check("K4 워크트리: 사유가 note 에도 실린다(사람·AI 가 읽는 칸)", r.note.includes(r.ref_note));
    const p = await repoPin(c, { repo: "k4" });
    check("K4 핀: 원격 기본(develop) SHA", headOf(p.pin) === tip("develop") && p.ref === "develop");
    check("K4 핀: 사유가 나온다", typeof p.ref_note === "string" && p.ref_note.includes("release") && p.note.includes(p.ref_note), String(p.ref_note));
    const again = await repoPin(c, { repo: "k4" });
    check("K4 핀 재사용 경로에도 사유가 붙는다", again.reused === true && typeof again.ref_note === "string");
  }

  // ── K5 등록값 없음 → 종전 그대로 · 사유 없음 ──
  {
    for (const [name, rows] of [["k5a", {}], ["k5b", { k5b: "" }], ["k5c", { k5c: null }], ["k5d", { k5d: "-bad name" }]]) {
      legacyBase(name);
      const c = mkCtx(cwdOf(name), rows);
      const r = await repoWorktree(c, { repo: name });
      check(`K5 ${name}: 원격 기본(develop)에서 뜬다`, headOf(r.worktree) === tip("develop") && r.ref === "develop", `${r.ref}`);
      check(`K5 ${name}: 사유 없음`, r.ref_note === undefined, String(r.ref_note));
      const p = await repoPin(c, { repo: name });
      check(`K5 ${name}: 핀도 develop`, headOf(p.pin) === tip("develop") && p.ref_note === undefined);
    }
    // git 소스를 연결한 적 없는 레포 — 목록의 default_branch 는 칸 기본값 'main' 으로 실려 오지만 사람이 고른 값이 아니다.
    legacyBase("k5e");
    const c = mkCtx(cwdOf("k5e"), { k5e: { clone_url: null, default_branch: "main" } });
    const r = await repoWorktree(c, { repo: "k5e" });
    check("K5 k5e: git 소스 없는 레포의 기본값 'main' 은 등록값이 아니다 → develop", headOf(r.worktree) === tip("develop") && r.ref === "develop", `${r.ref}`);
    check("K5 k5e: 사유 없음", r.ref_note === undefined, String(r.ref_note));
    const l = await repoList(c);
    check("K5 k5e: 목록의 등록값도 null", l.repos.find((x) => x.name === "k5e").default_branch === null);
  }

  // ── K6 게이트웨이가 답하지 않는다 · base 는 있다 → 던지지 않고 원격 기본 + 사유 ──
  {
    legacyBase("k6");
    const c = mkCtx(cwdOf("k6"), { k6: "main" }, { failApi: true });
    let r = null, err = null;
    try { r = await repoWorktree(c, { repo: "k6" }); } catch (e) { err = e; }
    check("K6 게이트웨이 실패가 워크트리를 막지 않는다", !!r && !err, String(err && err.message));
    check("K6 원격 기본(develop)으로", !!r && headOf(r.worktree) === tip("develop") && r.ref === "develop");
    check("K6 등록값을 못 읽었다는 사유가 나온다", !!r && typeof r.ref_note === "string" && r.ref_note.length > 0, String(r && r.ref_note));
    let p = null; err = null;
    try { p = await repoPin(c, { repo: "k6" }); } catch (e) { err = e; }
    check("K6 핀도 막지 않는다 + 사유", !!p && !err && headOf(p.pin) === tip("develop") && typeof p.ref_note === "string", String(err && err.message));
    let rm = null; err = null;
    try { rm = await repoPinRemove(c, { repo: "k6" }); } catch (e) { err = e; }
    check("K6 핀 지우기도 던지지 않는다", !err && !!rm && rm.removed === p.pin, String(err && err.message));
    // 게이트웨이가 살아 있을 때 뜬 핀(main)을, 죽었을 때 지우려 하면 기준이 달라 못 찾는다 — 그때 왜 못 찾았는지가 나와야 한다.
    const up = mkCtx(cwdOf("k6"), { k6: "main" });
    const pm = await repoPin(up, { repo: "k6" });
    check("K6 배선: 살아 있을 때 핀은 main", headOf(pm.pin) === tip("main"));
    const rm2 = await repoPinRemove(c, { repo: "k6" });
    check("K6 기준이 달라 못 지운 핀은 남는다", rm2.removed === null && existsSync(pm.pin), JSON.stringify(rm2));
    check("K6 못 찾은 사유에 실제로 쓴 기준 브랜치가 나온다", typeof rm2.note === "string" && rm2.note.includes("develop"), String(rm2.note));
  }

  // ── K7 새 base 클론 — 등록 브랜치로 받는다 / 원격에 없으면 원격 기본으로 ──
  {
    const c = mkCtx(cwdOf("k7"), { k7: "main" });
    const r = await repoWorktree(c, { repo: "k7" });
    check("K7 새 base 가 등록 브랜치(main)로 받아진다", out("git", ["rev-parse", "--abbrev-ref", "HEAD"], join(REPOS, "k7")) === "main");
    check("K7 다른 브랜치 ref 도 있다(단일 브랜치 클론 아님)", out("git", ["rev-parse", "refs/remotes/origin/develop"], join(REPOS, "k7")) === tip("develop"));
    check("K7 워크트리도 main 에서", headOf(r.worktree) === tip("main"));
    const c2 = mkCtx(cwdOf("k7x"), { k7x: "release" });
    let r2 = null, err = null;
    try { r2 = await repoWorktree(c2, { repo: "k7x" }); } catch (e) { err = e; }
    check("K7 등록 브랜치가 원격에 없어도 클론은 된다", !!r2 && !err, String(err && err.message));
    check("K7 그땐 원격 기본(develop)으로 받고 사유를 남긴다", !!r2 && out("git", ["rev-parse", "--abbrev-ref", "HEAD"], join(REPOS, "k7x")) === "develop" && typeof r2.ref_note === "string");
    const c3 = mkCtx(cwdOf("k7n"), { k7n: null });
    await repoWorktree(c3, { repo: "k7n" });
    check("K7 등록값 없는 새 base 는 종전대로 원격 기본", out("git", ["rev-parse", "--abbrev-ref", "HEAD"], join(REPOS, "k7n")) === "develop");
  }

  // ── K8 이미 떠 있는 워크트리는 건드리지 않는다 — 등록값이 바뀌어도 그대로, 게이트웨이도 안 묻는다 ──
  {
    legacyBase("k8");
    const cwd = cwdOf("k8");
    const first = await repoWorktree(mkCtx(cwd, { k8: "develop" }), { repo: "k8" });
    const head = headOf(first.worktree);
    check("K8 배선: 처음엔 develop 에서 떴다", head === tip("develop"));
    const c = mkCtx(cwd, { k8: "main" });                              // 그 뒤 등록값을 main 으로 바꿨다
    const again = await repoWorktree(c, { repo: "k8" });
    check("K8 같은 워크트리를 돌려준다", again.worktree === first.worktree, again.worktree);
    check("K8 브랜치·HEAD 그대로", again.branch === first.branch && headOf(again.worktree) === head);
    check("K8 재사용은 게이트웨이를 묻지 않는다", c.calls === 0, `calls=${c.calls}`);
  }

  // ── K9 목록에 등록한 기본 브랜치가 실린다 ──
  {
    const c = mkCtx(SB, { k1: "main", k4: "release", k5c: null });
    const l = await repoList(c);
    const by = Object.fromEntries(l.repos.map((r) => [r.name, r]));
    check("K9 등록값이 실린다", by.k1 && by.k1.default_branch === "main" && by.k4.default_branch === "release", JSON.stringify(by.k1));
    check("K9 등록값이 없으면 null", by.k5c && by.k5c.default_branch === null, JSON.stringify(by.k5c));
    check("K9 base 의 지금 브랜치는 따로 보인다", by.k1.branch === "develop", by.k1.branch);
  }

  rmSync(SB, { recursive: true, force: true });
  console.error(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { rmSync(SB, { recursive: true, force: true }); console.error("테스트 하네스 오류:", e); process.exit(1); });
