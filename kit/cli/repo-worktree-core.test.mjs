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
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync, utimesSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";  // ⚠ 절대경로 동적 import 는 반드시 file:// URL 로 — 윈도우는 "d:" 를 프로토콜로 읽는다(#1510)
import { join } from "node:path";
import { tmpdir } from "node:os";

const HERE = join(fileURLToPath(import.meta.url), "..");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.error(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why || "조건 불만족"));

const SB = mkdtempSync(join(tmpdir(), "wt-core-test-"));
// hermetic — git 신원이 없는 머신(CI 러너·새 개발기)에서도 픽스처 커밋이 돌게 env 로 고정(#1313 R4 CI 승격에서 실측).
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "wt-core-test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "wt-core-test@test.local";
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
  process.env.TMPDIR = join(SB, "ostmp");                // os.tmpdir() → SB/ostmp (핀 기본경로를 샌드박스 안으로 — 실제 tmp 오염 방지)
  mkdirSync(join(SB, "ostmp"), { recursive: true });
  const { repoWorktree, repoPin, repoPinRemove, REPO_NAME_RE, authNote, gitHostOf } = await import(pathToFileURL(join(HERE, "repo-worktree-core.mjs")));

  // ── 0) REPO_NAME_RE — 레포명은 경로 컴포넌트라 점세그먼트(traversal) 거부, 이름 속 점은 허용(#932 후속) ──
  check("REPO_NAME_RE: '..' 거부(traversal)", REPO_NAME_RE.test("..") === false, "'..' 통과");
  check("REPO_NAME_RE: '.' 거부", REPO_NAME_RE.test(".") === false, "'.' 통과");
  check("REPO_NAME_RE: '...' 거부", REPO_NAME_RE.test("...") === false, "'...' 통과");
  check("REPO_NAME_RE: 슬래시 거부", REPO_NAME_RE.test("a/b") === false, "'a/b' 통과");
  check("REPO_NAME_RE: 정상 이름 허용", REPO_NAME_RE.test("context-ontology") === true, "정상명 거부");
  check("REPO_NAME_RE: 이름 속 점 허용(my.repo)", REPO_NAME_RE.test("my.repo") === true, "점 포함명 거부");

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
    // ⚠ 윈도우에서 두 가지가 어긋난다(#1510): ① git 은 경로를 `/` 로 뱉는다 ② tmpdir() 은 8.3 단축형
    //  (`C:\\Users\\RUNNER~1\\…`)인데 git 은 롱패스(`C:\\Users\\runneradmin\\…`)로 되돌려준다.
    //  그래서 구분자 정규화 + realpath 정규화를 둘 다 건다.
    const slash = (p) => String(p).replace(/\\/g, "/");
    let expect = join(proj, "base");
    try { expect = realpathSync.native(expect); } catch { /* 아직 없거나 realpath 불가 — 원형 그대로 */ }
    check("점유 브랜치 명시 → 점유자 경로를 알려준다", slash(e.message).includes(slash(expect)), e.message);
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

  // ── 9b) 세션 전용 폴더의 마커(#1719, kind:"session") — 그 폴더는 프로젝트 폴더가 **아니다** ──
  //  session-project.ts 가 세션이 프로젝트에 붙을 때 sessions/<sid>/.lively/project.json 에 { kind:"session", project_id,
  //  project_dir } 를 쓴다. 슬롯은 project_dir(=프로젝트 폴더)이어야 한다 — marker.dir(세션 폴더)로 잡으면
  //  sessions/<sid>/<repo> 에 project/<id> 가 걸려 서버 provision 이 막힌다(#932 의 그 사고가 다른 자리에서 재현).
  const sess = join(SB, "box", "sessions", "box-yoon-1");
  mkdirSync(join(sess, ".lively"), { recursive: true });
  writeFileSync(join(sess, ".lively", "project.json"), JSON.stringify({ kind: "session", session_id: "box-yoon-1", project_id: 999, project_dir: proj, sync: "none" }));
  r = await repoWorktree(ctx(sess), { repo: "base" });
  check("세션 폴더 마커 + project_dir → 슬롯은 프로젝트 폴더(멱등 재사용)", r.worktree === join(proj, "base"), r.worktree);
  check("세션 폴더 마커 + project_dir → 브랜치 project/<id>", r.branch === "project/999", r.branch);
  //  project_dir 없음(그 컴퓨터에 프로젝트 폴더가 없다) → 슬롯 없음 → cwd/<repo> + wt/<repo>(project/<id> 를 세션 폴더에 걸지 않는다)
  const sess2 = join(SB, "box", "sessions", "box-yoon-2");
  mkdirSync(join(sess2, ".lively"), { recursive: true });
  writeFileSync(join(sess2, ".lively", "project.json"), JSON.stringify({ kind: "session", session_id: "box-yoon-2", project_id: 999, project_dir: null, sync: "none" }));
  r = await repoWorktree(ctx(sess2), { repo: "base" });
  check("세션 폴더 마커 · project_dir 없음 → cwd/<repo>", r.worktree === join(sess2, "base"), r.worktree);
  check("세션 폴더 마커 · project_dir 없음 → wt/<repo> 계열(project/<id> 아님)", /^wt\/base/.test(r.branch), r.branch);

  // ── 10) 핀 경로 스톰프 회귀(#932) — content-addressed 라 다른 SHA 핀이 공존, repoPin 이 남의 핀을 안 덮는다 ──
  //  tmpdir 은 macOS 에서 유저당 하나(세션당 아님)라, sha 없이 repo 만으로 자리를 잡으면 다른 세션이 다른 SHA 를
  //  핀할 때 내 핀을 force-remove 로 덮어 발밑 코드가 바뀐다 — 핀이 막으려던 바로 그 HEAD 드리프트.
  const pinCtx = ctx(proj);                              // cwd 무관 — 기본 핀 경로는 tmpdir(=SB/ostmp) 기반
  const p1 = await repoPin(pinCtx, { repo: "base" });
  check("핀 경로가 SHA 로 content-addressed", p1.pin.includes(p1.sha) && p1.pin.includes(join("lively-pin", "base")), p1.pin);
  const p1b = await repoPin(pinCtx, { repo: "base" });
  check("같은 SHA 재핀 → 같은 경로 재사용(멱등)", p1b.reused === true && p1b.pin === p1.pin, JSON.stringify(p1b));

  // '다른 세션이 main 전진 후 핀' 시뮬 — origin 에 새 커밋 → 재핀하면 새 SHA·새 경로
  sh("git", ["commit", "-q", "--allow-empty", "-m", "advance"], { cwd: join(SB, "origin-repo") });
  const p2 = await repoPin(pinCtx, { repo: "base" });
  check("main 전진 후 핀 → 다른 SHA·다른 경로", p2.sha !== p1.sha && p2.pin !== p1.pin, `${p1.sha}@${p1.pin} → ${p2.sha}@${p2.pin}`);
  // 핵심 스톰프 단언: 예전 SHA 핀의 HEAD 가 그대로 sha1 이어야 한다(수정 전이면 같은 경로가 sha2 로 덮여 있다).
  const headAtP1 = sh("git", ["-C", p1.pin, "rev-parse", "--short", "HEAD"], { allowFail: true }).stdout.trim();
  check("이전 SHA 핀이 스톰프 안 됨 (p1 HEAD 여전히 sha1)", headAtP1 === p1.sha, `p1.pin HEAD=${headAtP1}, 기대=${p1.sha}`);

  // 제거는 현재 ref(→p2 SHA)의 핀만 — 다른 SHA 핀(p1)은 안 건드린다
  const rm = repoPinRemove(pinCtx, { repo: "base" });
  check("pin_remove → 현재 SHA 핀만 제거", rm.removed === p2.pin && !existsSync(p2.pin), JSON.stringify(rm));
  check("pin_remove 후에도 다른 SHA 핀(p1)은 남음", existsSync(p1.pin), "p1 이 사라짐");
  const rm2 = repoPinRemove(pinCtx, { repo: "base" });   // best-effort: 이미 없는 걸 또 지워도 에러 아님
  check("pin_remove 재호출 → 에러 없이 removed:null", rm2.removed === null, JSON.stringify(rm2));

  // ── 11) 오래된 핀 TTL 스윕(#932) — repo_pin_remove 가 안 불려 누적된 핀을 다음 핀 호출이 걷는다 ──
  //  content-addressed 라 SHA 마다 ~20MB 가 쌓이므로, 호출 시점 GC 로 TTL(기본 14일) 넘긴 것만 청소한다.
  //  진행 중 분석(TTL 미만)과 지금 뜰 SHA 는 절대 안 건드린다. (p1 은 이 런 안에서 갓 만든 fresh 핀 = 보존돼야 함)
  sh("git", ["commit", "-q", "--allow-empty", "-m", "adv2"], { cwd: join(SB, "origin-repo") });
  const pOld = await repoPin(pinCtx, { repo: "base" });          // 새 SHA 핀
  const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);   // 20일 전으로 mtime 위조(TTL 14일 초과)
  utimesSync(pOld.pin, old, old);
  sh("git", ["commit", "-q", "--allow-empty", "-m", "adv3"], { cwd: join(SB, "origin-repo") });
  const pNew = await repoPin(pinCtx, { repo: "base" });          // 또 다른 SHA → 스윕 트리거
  check("TTL 넘긴 오래된 핀은 다음 핀 때 청소됨", !existsSync(pOld.pin), `pOld 아직 남음: ${pOld.pin}`);
  check("갓 만든 핀은 스윕 안 됨(keepSha 보호)", existsSync(pNew.pin), `pNew 없음: ${pNew.pin}`);
  check("TTL 미만 핀(p1, fresh)은 스윕 대상 아님", existsSync(p1.pin), "p1 이 과잉삭제됨");

  // ── 12) 클론 인증 실패 안내(#1077) ──
  //  사양: 클론이 **자격 부재/거부**로 막히면 실패 메시지에 정규 등록 경로(me_git_credential_set)와 대상 호스트를
  //   덧붙인다. 자격과 무관한 실패엔 아무것도 안 붙인다(모든 실패에 붙는 안내는 노이즈가 되어 안 읽힌다).
  //   셸 ssh-keygen 우회는 명시적으로 말린다 — 되긴 하지만 그 자격은 라이블리 밖이라 관리탭 가시성·오프보딩
  //   회수·재프로비저닝 복원에서 전부 빠지고, 안내가 '되는 방법'만 주면 사람은 더 쉬운 우회를 계속 고른다.
  //  판정은 stderr 문자열이라 느슨하다(호스트마다 문구가 다르다) — 오탐의 대가가 안내 한 줄이라 넓게 잡되,
  //   무관 실패까지 걸리면 안 되므로 그 경계를 아래 표로 고정한다.
  check("① 공개키 거부 + scp형 → 안내와 호스트",
    /me_git_credential_set/.test(authNote("git@git.example.com: Permission denied (publickey).", "git@git.example.com:acme-dev/example-one.git"))
    && authNote("Permission denied (publickey).", "git@git.example.com:acme-dev/example-one.git").includes("git.example.com"), "미탐");
  check("① 안내는 셸 ssh-keygen 우회를 말린다",
    /ssh-keygen/.test(authNote("Permission denied (publickey).", "git@h.kr:o/r.git")), "우회 경고 없음");
  check("② Username 못 읽음(HTTPS) → 안내와 호스트",
    /me_git_credential_set/.test(authNote("fatal: could not read Username for 'https://git.x.kr': terminal prompts disabled", "https://git.x.kr/o/r.git"))
    && gitHostOf("https://git.x.kr/o/r.git") === "git.x.kr", "미탐");
  check("③ 자격·포트 포함 https 에서 호스트만 추출",
    gitHostOf("https://user@git.example.com:443/o/r.git") === "git.example.com", gitHostOf("https://user@git.example.com:443/o/r.git"));
  check("④ 자격과 무관한 실패엔 안 붙는다",
    authNote("fatal: destination path 'x' already exists and is not an empty directory.", "https://github.com/o/r.git") === "", "오탐");
  {
    const n = authNote("Permission denied (publickey).", "");   // 주소 파싱 불가
    check("⑤ 호스트 미상이어도 안내는 나온다", /me_git_credential_set/.test(n) && n.includes("그 호스트"), n);
    check("⑤ 빈 호스트가 안내에 새지 않는다", !/host:\s*""/.test(n), n);
  }
  check("⑥ 실패 원문이 비었거나 부재면 안 붙고 깨지지도 않는다",
    authNote("", "https://github.com/o/r.git") === "" && authNote(undefined, undefined) === "" && gitHostOf(undefined) === "", "빈/부재 처리 실패");
  check("⑦ 토큰 만료 계열도 자격 문제로 본다(공개키 거부만 잡으면 안 됨)",
    /me_git_credential_set/.test(authNote("fatal: Authentication failed for 'https://git.x.kr/o/r.git'", "https://git.x.kr/o/r.git")), "미탐");
  {
    // ⑧ 배선 — 안내를 만드는 능력이 있어도 **실패 지점에서 안 불리면 없는 것과 같다**. 실제 클론 경로로 태운다.
    const calls = [];
    const authCtx = {
      cwd: SB,
      sh: (cmd, args = []) => {
        calls.push([cmd, ...args].join(" "));
        return args[0] === "clone"
          ? { stdout: "", stderr: "Cloning into '/x'...\ngit@git.example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", code: 128 }
          : { stdout: "", stderr: "", code: 0 };
      },
      api: async () => ({ domainmapRepos: [{ name: "privaterepo", clone_url: "git@git.example.com:acme-dev/example-one.git" }] }),
    };
    let msg = "";
    try { await repoWorktree(authCtx, { repo: "privaterepo" }); } catch (e) { msg = String(e?.message ?? e); }
    check("⑧ 배선: 실제 클론 인증 실패가 안내를 달고 나온다",
      /me_git_credential_set/.test(msg) && msg.includes("git.example.com"), msg || "throw 하지 않음");
    check("⑧ 배선: 클론이 실제로 시도됐다(관측 장치 생존)",
      calls.some((c) => c.startsWith("git clone")), calls.join(" | ") || "sh 호출 0건");
  }

  rmSync(SB, { recursive: true, force: true });
  console.error(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { rmSync(SB, { recursive: true, force: true }); console.error("테스트 하네스 오류:", e); process.exit(1); });
