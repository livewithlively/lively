// 클론 브랜치 읽기 — 사양 기반·구현 블라인드 시험 (사양 §8, src/org/wiki-repo.ts 의 cloneHeadBranch).
//  git 을 실행하지 않는다 — mkdtemp 임시 폴더에 가짜 `.git/HEAD` · `gitdir:` 파일을 만들어 본다(고정 경로 없음, 끝나면 지움).
// 실행: npm run build && node dist/org/wiki-repo-branch.test.js
//
// 잠그는 행위(§8):
//  1. `<clonePath>/.git/HEAD` 가 `ref: refs/heads/<브랜치>` 면 그 브랜치 이름(슬래시 든 `feat/x` 도 그대로).
//  2. HEAD 가 커밋 해시(분리된 HEAD)면 null.
//  3. `.git` 이 없거나 읽을 수 없으면 null — 예외를 던지지 않는다.
//  4. `.git` 이 파일이고 내용이 `gitdir: <경로>` 면 그 경로(clonePath 기준 상대경로 허용)의 HEAD 를 읽는다.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cloneHeadBranch } from "./wiki-repo.js";

function withTmp(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-repo-branch-"));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** `.git` 폴더에 HEAD 하나만 둔 가짜 클론. */
function cloneWithHead(root: string, name: string, head: string): string {
  const dir = path.join(root, name);
  writeFile(path.join(dir, ".git", "HEAD"), head);
  return dir;
}

/** 예외를 던지면 §8.3 위반으로 실패시킨다. */
function branchOf(clonePath: string, item: string): string | null {
  try {
    return cloneHeadBranch(clonePath);
  } catch (e) {
    assert.fail(`${item}: 예외를 던지면 안 된다 — ${String(e)}`);
  }
}

test("§8.1 .git/HEAD 가 ref: refs/heads/<브랜치> 면 그 브랜치 이름", () => {
  withTmp((root) => {
    assert.equal(branchOf(cloneWithHead(root, "c1", "ref: refs/heads/main\n"), "§8.1"), "main", "§8.1 main");
    assert.equal(branchOf(cloneWithHead(root, "c2", "ref: refs/heads/feat/x\n"), "§8.1"), "feat/x", "§8.1 슬래시가 든 브랜치도 그대로");
    assert.equal(branchOf(cloneWithHead(root, "c3", "ref: refs/heads/release/2026/11\n"), "§8.1"), "release/2026/11",
      "§8.1 슬래시 여러 개");
    assert.equal(branchOf(cloneWithHead(root, "c4", "ref: refs/heads/develop"), "§8.1"), "develop", "§8.1 끝 줄바꿈이 없어도");
  });
});

test("§8.2 HEAD 가 커밋 해시(분리된 HEAD)면 null", () => {
  withTmp((root) => {
    const dir = cloneWithHead(root, "detached", "0123456789abcdef0123456789abcdef01234567\n");
    assert.equal(branchOf(dir, "§8.2"), null, "§8.2 분리된 HEAD → null");
  });
});

test("§8.3 .git 이 없거나 읽을 수 없으면 null(예외 없음)", () => {
  withTmp((root) => {
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    assert.equal(branchOf(plain, "§8.3"), null, "§8.3 .git 없음 → null");
    assert.equal(branchOf(path.join(root, "does-not-exist"), "§8.3"), null, "§8.3 clonePath 자체가 없음 → null");
    const emptyGit = path.join(root, "empty-git");
    fs.mkdirSync(path.join(emptyGit, ".git"), { recursive: true });
    assert.equal(branchOf(emptyGit, "§8.3"), null, "§8.3 .git 폴더에 HEAD 가 없음 → null");
    const dangling = path.join(root, "dangling");
    writeFile(path.join(dangling, ".git"), `gitdir: ${path.join(root, "nowhere", "worktrees", "x")}\n`);
    assert.equal(branchOf(dangling, "§8.3+§8.4"), null, "§8.3+§8.4 gitdir 가 가리키는 곳에 HEAD 가 없음 → null");
  });
});

test("§8.4 .git 이 파일(gitdir: <절대 경로>)이면 그 경로의 HEAD 를 읽는다", () => {
  withTmp((root) => {
    const gitdir = path.join(root, "main-repo", ".git", "worktrees", "wt1");
    writeFile(path.join(gitdir, "HEAD"), "ref: refs/heads/wt-branch\n");
    const wt = path.join(root, "wt1");
    writeFile(path.join(wt, ".git"), `gitdir: ${gitdir}\n`);
    assert.equal(branchOf(wt, "§8.4"), "wt-branch", "§8.4 절대 경로 gitdir");
  });
});

test("§8.4 gitdir 는 clonePath 기준 상대 경로여도 된다", () => {
  withTmp((root) => {
    writeFile(path.join(root, "gitdirs", "w2", "HEAD"), "ref: refs/heads/feat/rel\n");
    const wt = path.join(root, "nest", "wt2");
    writeFile(path.join(wt, ".git"), "gitdir: ../../gitdirs/w2\n");
    assert.equal(branchOf(wt, "§8.4"), "feat/rel", "§8.4 상대 경로 gitdir(clonePath 기준)");
  });
});

test("§8.4+§8.2 gitdir 의 HEAD 가 분리돼 있으면 null", () => {
  withTmp((root) => {
    const gitdir = path.join(root, "gitdirs", "w3");
    writeFile(path.join(gitdir, "HEAD"), "89abcdef0123456789abcdef0123456789abcdef\n");
    const wt = path.join(root, "wt3");
    writeFile(path.join(wt, ".git"), `gitdir: ${gitdir}\n`);
    assert.equal(branchOf(wt, "§8.4"), null, "§8.4+§8.2 gitdir 쪽 HEAD 가 커밋 해시 → null");
  });
});
