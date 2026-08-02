// 노드 provision 주입 경로(#905 C4) — **DB 없이** 진짜 git 으로 검증. 실행: npm run build && node dist/project/project-provision-inject.test.js
//
//  증명하려는 것: 노드엔 DB 가 없다. 그래서 `provisionProjectRepos` 가 레지스트리(getRepo)를 못 읽는다 —
//   inject(게이트웨이가 실어 보낸 git_url)가 있어야만 clone 이 된다. 대비로 못 박는다:
//    · inject 있음 → clone·worktree·마커까지 성공(DB 미설정이어도).
//    · inject 없음 + DB 미설정 → 409 "레지스트리에 없습니다"(노드에서 오늘 나던 바로 그 오진).
//  로컬 bare 레포를 file:// 로 원격 삼아 네트워크·자격 없이 돌린다.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// 🔴 DB 미설정 상태를 만든다 — 노드 조건 재현. PROJECT_SHARED_BASE 는 import 시점에 env 를 읽으므로 먼저 세팅.
delete process.env.ITEMS_DATABASE_URL;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "prov-inject-"));
process.env.TERMINAL_ROOT_SHARED = ROOT;

const { provisionProjectRepos } = await import("./project-provision.js");

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const git = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

try {
  // ── 원격 흉내: 커밋 하나 든 bare 레포. file:// 로 clone 대상 삼는다(네트워크·자격 불요). ──
  const srcWork = path.join(ROOT, "src-work");
  fs.mkdirSync(srcWork, { recursive: true });
  git(["init", "-q", "-b", "main", srcWork]);
  fs.writeFileSync(path.join(srcWork, "README.md"), "hello\n");
  git(["add", "-A"], srcWork);
  git(["commit", "-q", "-m", "init"], srcWork);
  const bare = path.join(ROOT, "origin.git");
  git(["clone", "-q", "--bare", srcWork, bare]);
  const fileUrl = "file://" + bare;

  const PROJECT_ID = 90599;

  // ── ✅ inject 있음 → DB 없이도 clone·worktree·마커까지 성공 ──
  {
    const { provisioned } = await provisionProjectRepos(
      PROJECT_ID, `project/${PROJECT_ID}`,
      [{ name: "demo-repo", worktree: true, inject: { gitUrl: fileUrl, secret: null } }],
      { clone: true, memberId: null },
    );
    assert.equal(provisioned.length, 1);
    const p = provisioned[0];
    assert.equal(p.name, "demo-repo");
    assert.ok(p.cloned, "첫 provision 이면 cloned=true 여야");
    // 공유 base 클론이 실재하고 커밋을 갖고 있다(진짜로 받아왔다).
    const base = path.join(ROOT, "repos", "demo-repo");
    assert.ok(fs.existsSync(path.join(base, ".git")), "공유 base 클론이 없다");
    assert.ok(fs.existsSync(path.join(base, "README.md")), "클론이 커밋 내용을 못 받았다");
    // worktree 가 project/<id>/demo-repo 에 브랜치 격리로 생겼다.
    const wt = path.join(ROOT, "project", String(PROJECT_ID), "demo-repo");
    assert.ok(fs.existsSync(path.join(wt, "README.md")), "worktree 가 안 생겼다");
    assert.equal(p.branch, `project/${PROJECT_ID}`);
    // provision 마커가 실행 호스트(=여기, 노드 흉내)의 프로젝트 폴더에 적혔다.
    const marker = JSON.parse(fs.readFileSync(path.join(ROOT, "project", String(PROJECT_ID), ".lively", "project.json"), "utf8"));
    assert.ok(Array.isArray(marker.provisioned) && marker.provisioned.some((r: { name: string }) => r.name === "demo-repo"), "마커에 provisioned 기록 누락");
    ok("✅ inject(git_url) 있음 → DB 없이 clone·worktree·마커 성공(노드 provision 의 실체)");
  }

  // ── 멱등: 두 번째 provision 은 재사용(clone 안 함) ──
  {
    const { provisioned: again } = await provisionProjectRepos(
      PROJECT_ID, `project/${PROJECT_ID}`,
      [{ name: "demo-repo", worktree: true, inject: { gitUrl: fileUrl, secret: null } }],
      { clone: true, memberId: null },
    );
    assert.equal(again[0].cloned, false, "이미 있는 클론을 또 clone 했다(멱등 위반)");
    ok("멱등 — 재-provision 은 기존 클론·워크트리 재사용");
  }

  // ── 🔴 inject 없음 + DB 미설정 → 409 "레지스트리에 없습니다"(노드에서 오늘 나던 오진의 재현) ──
  {
    let threw: Error | null = null;
    try {
      await provisionProjectRepos(
        90598, "project/90598",
        [{ name: "demo-repo-2", worktree: false }],   // inject 없음 → getRepo() 로 DB 를 읽으려 함 → 없음
        { clone: true, memberId: null },
      );
    } catch (e) { threw = e as Error; }
    assert.ok(threw, "🔴 inject 없이 DB 도 없는데 provision 이 성공했다 — 있을 수 없다");
    assert.match(threw!.message, /레지스트리에 없습니다/, `예상은 '레지스트리에 없습니다' 오진, 실제: ${threw!.message}`);
    ok("🔴 inject 없음 + DB 없음 → 레지스트리 오진(= 노드가 inject 없이는 못 한다는 증거)");
  }

  console.log(`\n${pass} passed`);
} finally {
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => {});
}
