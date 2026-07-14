// project-manifest — provision 레포/워크트리 서브트리 제외 + truncated 신호(#828). DB/WS 없이 순수 fs 검증.
//  실행: npm run build && node dist/project-manifest.test.js
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { manifestFiles, isGitRepoRoot } from "./project-manifest.js";

let pass = 0;
const ok = (name: string) => { pass++; console.log(`ok  ${name}`); };

// 문서(동기화 대상) + 숨김 + clone형 레포(.git 디렉터리) + worktree형 레포(.git 파일)를 섞은 트리.
async function mkTree(): Promise<string> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-manifest-"));
  await fsp.writeFile(path.join(base, "doc1.md"), "hello");
  await fsp.mkdir(path.join(base, "sub"), { recursive: true });
  await fsp.writeFile(path.join(base, "sub", "doc2.md"), "world");
  // 숨김(.lively) — 항상 제외
  await fsp.mkdir(path.join(base, ".lively"), { recursive: true });
  await fsp.writeFile(path.join(base, ".lively", "project.json"), "{}");
  // clone 형 레포: .git 디렉터리 보유 → 서브트리 전체 제외 대상
  await fsp.mkdir(path.join(base, "repoA", "src"), { recursive: true });
  await fsp.mkdir(path.join(base, "repoA", ".git"), { recursive: true });
  await fsp.writeFile(path.join(base, "repoA", ".git", "HEAD"), "ref: x");
  await fsp.writeFile(path.join(base, "repoA", "src", "code.ts"), "x");
  await fsp.writeFile(path.join(base, "repoA", "README.md"), "r");
  // worktree 형 레포: .git 파일(gitdir 포인터) 보유 → 서브트리 전체 제외 대상
  await fsp.mkdir(path.join(base, "repoB"), { recursive: true });
  await fsp.writeFile(path.join(base, "repoB", ".git"), "gitdir: /x/.git/worktrees/repoB");
  await fsp.writeFile(path.join(base, "repoB", "lib.js"), "y");
  return base;
}

async function main(): Promise<void> {
  const base = await mkTree();
  try {
    // ── 레포/워크트리/숨김 서브트리 제외, 문서만 포함 ──
    {
      const { files, truncated } = await manifestFiles(base);
      const paths = files.map((f) => f.path).sort();
      assert.deepEqual(paths, ["doc1.md", "sub/doc2.md"], `문서만 포함해야 함 — 실제: ${JSON.stringify(paths)}`);
      assert.equal(truncated, false, "상한 미도달이면 truncated=false");
      ok("provision 레포(.git 디렉터리·파일)·숨김 서브트리 제외, 문서만 매니페스트에 포함");
    }
    // ── isGitRepoRoot: .git 디렉터리/파일 둘 다 레포로 판정, 일반 폴더는 아님 ──
    {
      assert.equal(await isGitRepoRoot(path.join(base, "repoA")), true, ".git 디렉터리 = 레포 루트");
      assert.equal(await isGitRepoRoot(path.join(base, "repoB")), true, ".git 파일(worktree) = 레포 루트");
      assert.equal(await isGitRepoRoot(path.join(base, "sub")), false, "일반 폴더는 레포 아님");
      ok("isGitRepoRoot — .git 디렉터리/파일 판정, 일반 폴더 제외");
    }
    // ── truncated: 상한 도달 시 true + 결과는 상한 이하 ──
    {
      const { files, truncated } = await manifestFiles(base, 1);
      assert.equal(truncated, true, "문서 2개인데 limit=1 → truncated=true");
      assert.ok(files.length <= 1, `상한 이하여야 함 — 실제 ${files.length}`);
      ok("truncated — 파일 상한 도달 시 true, 결과는 상한 이하");
    }
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
