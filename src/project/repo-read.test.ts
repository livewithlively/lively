// 등록 레포의 판 읽기(카드 정책 #326 — 코드 변경 반영의 바탕) — repo-read 를 사양 A 대로 본다(사양 기반 · 구현을 보지 않고 썼다).
//  A1 판 고르기 — 40자 해시는 원격 브랜치(origin/*) · 태그에서 닿을 때만 읽는다 · 로컬에서만 닿는 커밋(원격에 올리지 않은 작업) · 사본에 없는 해시 · 로컬 브랜치 이름은 404 ·
//     이름(main · origin/main)은 원격 머리(앞선 로컬 main 이 아니다) · 태그는 벗긴 커밋 · 꼴이 틀린 판은 400
//  A2 머리 · 태그 — 기본 브랜치(row → origin/HEAD → main) · 원격 머리 · 최근 만든 태그부터 · 주석 태그는 벗긴 커밋 · 커밋이 아닌 태그는 빠짐 · 자르면 tags_truncated · fetched_at
//  A3 두 판 사이 — A · M · D(이름 바꿈은 D + A) · path 면 패치 · 두 판 모두 A1 · 꼴 틀린 path 400
//  A4 한 판의 파일 — offset · limit(기본 400 · 최대 5000) · numbered · total_lines · range · 404 · 415 · 413 · 꼴 틀린 경로 400 · 고른 판의 내용
//  A5 찾기 — 글자 그대로 · 대소문자 · path 범위 · 400자 + … · limit(기본 50 · 최대 300) · 빈 결과 · 이진 건너뜀 · 찾을 글 꼴
//  A6 remoteKey · isRefName · isRepoPath.
//  고정물: os.tmpdir() 아래 bare 원격 + 그 clone(+ 원격에 올리지 않은 작업 커밋 · 원격보다 앞선 로컬 main · 매이지 않은 커밋) — DB 없음 · 끝나면 지운다.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isRefName, isRepoPath, parseGrepZ, remoteKey, repoDiffAt, repoFileAt, repoGrepAt, repoRefsAt, resolveCommit } from "./repo-read.js";

// ───────────────────────── 사양이 적은 돌려받는 꼴 ─────────────────────────
interface Head { branch: string; commit: string; date: string; subject: string }
interface Tag { name: string; commit: string; date: unknown; tagged_at: unknown }
interface Refs { repo: string; default_branch: string; head: Head | null; tags: Tag[]; tags_truncated: boolean; fetched_at: unknown }
interface DiffFiles { repo: string; from: string; to: string; files: { status: string; path: string }[]; truncated: boolean }
interface DiffPatch { repo: string; from: string; to: string; path: string; patch: string; truncated: boolean }
interface FileAt { repo: string; commit: string; path: string; total_lines: number; range: { from: number; to: number; has_more: boolean }; text: string }
interface Hit { path: string; line: number; text: string }
interface GrepAt { repo: string; commit: string; pattern: string; hits: Hit[]; truncated: boolean }

type Ctx = Parameters<typeof resolveCommit>[0];
type Row = { git_url?: string; default_branch?: string };

// ───────────────────────── 고정물 ─────────────────────────
const T0 = Date.now();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-read-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function git(cwd: string, args: string[], iso?: string): string {
  const when = iso ? `@${Math.floor(Date.parse(iso) / 1000)} +0000` : undefined;
  const env = when ? { ...GIT_ENV, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : GIT_ENV;
  return execFileSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}
function put(dir: string, rel: string, data: string | Buffer): void {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}
function commit(dir: string, msg: string, iso: string, body?: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", msg, ...(body ? ["-m", body] : [])], iso);
  return git(dir, ["rev-parse", "HEAD"]);
}
const nums = (n: number, f: (i: number) => string): string[] => Array.from({ length: n }, (_, i) => f(i + 1));
const MIB8 = 8 * 1024 * 1024;
const LONG450 = "LONGHIT" + "y".repeat(443); // 450자
const LONG400 = "EXACTHIT" + "z".repeat(392); // 꼭 400자

const originDir = path.join(root, "origin.git");
const seed = path.join(root, "seed");
git(root, ["init", "-q", "--bare", "-b", "main", originDir]);
git(root, ["init", "-q", "-b", "main", seed]);
git(seed, ["remote", "add", "origin", originDir]);

// c1 (2026-01-01) — 읽기 · 찾기용 파일 모두
put(seed, "a.txt", "alpha\nbeta\ngamma\n");
put(seed, "old-name.txt", "rename me\nsecond line\n");
put(seed, "del.txt", "delete me\n");
put(seed, "keep.txt", nums(10, (i) => `keep ${i}`).join("\n") + "\n");
put(seed, "big450.txt", nums(450, (i) => `row ${i}`).join("\n") + "\n");
put(seed, "big5100.txt", nums(5100, (i) => `r${i}`).join("\n") + "\n");
put(seed, "empty.txt", "");
put(seed, "noeol.txt", "a\nb\nc");
put(seed, "blank-end.txt", "a\nb\n\n");
put(seed, ".github/workflows/ci.yml", "name: ci\non: push\n");
put(seed, "bin.dat", Buffer.from([...Buffer.from("NEEDLE in binary"), 0, 1, 2, 10]));
put(seed, "src/x.ts", "export const x = 1;\n");
put(seed, "grep/lit.txt", ["axb", "a.b", "foo(bar", "star*here", "starrrhere", "arr[x]", "arrx"].join("\n") + "\n");
put(seed, "grep/case.txt", "Hello\nhello\nHELLO\n");
put(seed, "grep/one.txt", "NEEDLE one\n");
put(seed, "grep/sub/two.txt", "x\nNEEDLE two\n");
put(seed, "grep2/four.txt", "NEEDLE four\n");
put(seed, "other/three.txt", "NEEDLE three\n");
put(seed, "grep/long.txt", `${LONG450}\n${LONG400}\n`);
put(seed, "grep/many.txt", nums(350, (i) => `MANYHIT ${i}`).join("\n") + "\n");
put(seed, "grep/ten.txt", nums(20, (i) => (i % 2 === 0 ? `TENHIT ${i}` : `other ${i}`)).join("\n") + "\n");
put(seed, "grep/dash.txt", "flag -v here\nopt -e there\nsee --help\nplain\n");
put(seed, "edge8m.txt", "a\n".repeat(MIB8 / 2)); // 꼭 8 MiB
put(seed, "huge.txt", "a\n".repeat(MIB8 / 2) + "b"); // 8 MiB + 1바이트
const c1 = commit(seed, "first commit", "2026-01-01T00:00:00Z");
git(seed, ["tag", "v1.0.0"]); // 가벼운 태그 → c1

// c2 (2026-01-02) — 바꿈 · 이름 바꿈 · 지움 · 더함
put(seed, "a.txt", "alpha\nBETA2\ngamma\n");
git(seed, ["mv", "old-name.txt", "new-name.txt"]);
git(seed, ["rm", "-q", "del.txt"]);
put(seed, "added.txt", "new file\n");
const c2 = commit(seed, "second commit", "2026-01-02T00:00:00Z");
git(seed, ["tag", "-a", "v1.1.0", "-m", "release 1.1.0"], "2026-01-02T01:00:00Z"); // 주석 태그 → c2
const v110Obj = git(seed, ["rev-parse", "v1.1.0"]); // 태그 객체 해시(커밋이 아니다)

// c3 (2026-01-03) — origin/main 의 머리
put(seed, "a.txt", "alpha\nBETA2\ngamma\ndelta ONLY_IN_C3\n");
const c3 = commit(seed, "third commit", "2026-01-03T00:00:00Z", "body text");
git(seed, ["tag", "v2.0.0"]); // 가벼운 태그 → c3

// 원격 브랜치 develop
git(seed, ["checkout", "-q", "-b", "develop"]);
put(seed, "dev.txt", "dev only\n");
const cdev = commit(seed, "develop commit", "2026-01-03T12:00:00Z");

// 어느 브랜치에도 없고 태그에서만 닿는 커밋 · 옛 커밋에 나중에 단 주석 태그 · 파일 객체를 가리키는 태그
git(seed, ["checkout", "-q", "--detach", c3]);
put(seed, "tagonly.txt", "tag only\n");
const ctag = commit(seed, "tag-only commit", "2026-01-03T06:00:00Z");
git(seed, ["tag", "snap-only", ctag]);
git(seed, ["tag", "-a", "rel-late", c1, "-m", "late tag on an old commit"], "2026-01-04T00:00:00Z");
git(seed, ["tag", "blobtag", git(seed, ["rev-parse", `${c1}:keep.txt`])]);
git(seed, ["push", "-q", "origin", "main", "develop"]);
git(seed, ["push", "-q", "origin", "--tags"]);

// 게이트웨이 사본 역할의 clone — 원격에 올리지 않은 작업이 섞여 있다
const cloneDir = path.join(root, "clone");
git(root, ["clone", "-q", originDir, cloneDir]);
git(cloneDir, ["checkout", "-q", "-b", "project/1", "origin/main"]);
put(cloneDir, "secret.txt", "LOCAL_SECRET\n");
put(cloneDir, "a.txt", "alpha\nLOCAL_EDIT\n");
const local1 = commit(cloneDir, "local work", "2026-01-05T00:00:00Z"); // 로컬 브랜치 project/1 에서만 닿는다
git(cloneDir, ["checkout", "-q", "main"]);
put(cloneDir, "a.txt", "alpha\nLOCAL_MAIN_AHEAD\n");
const localMain = commit(cloneDir, "local main ahead", "2026-01-05T01:00:00Z"); // 로컬 main 이 origin/main 보다 앞선다
const dangling = git(cloneDir, ["commit-tree", `${c3}^{tree}`, "-p", c3, "-m", "dangling"], "2026-01-05T02:00:00Z"); // 어디에도 매이지 않은 커밋
git(cloneDir, ["tag", "wip-local", local1]); // 세션이 사본에 단 로컬 태그 — 올라가지 않은 커밋을 가리킨다(격리 리뷰 2026-11-22)
git(cloneDir, ["fetch", "-q", "--tags", "origin"]);

// origin/HEAD 가 develop 을 가리키는 사본 · origin/HEAD 가 없는 사본 · 원격에서 받은 적이 없는 사본
const cloneHeadDevelop = path.join(root, "clone-head-develop");
git(root, ["clone", "-q", originDir, cloneHeadDevelop]);
git(cloneHeadDevelop, ["remote", "set-head", "origin", "develop"]);
const cloneNoHead = path.join(root, "clone-no-head");
git(root, ["clone", "-q", originDir, cloneNoHead]);
git(cloneNoHead, ["remote", "set-head", "origin", "--delete"]);
const neverFetched = path.join(root, "never-fetched");
git(root, ["init", "-q", "-b", "main", neverFetched]);
git(neverFetched, ["remote", "add", "origin", originDir]);
put(neverFetched, "n.txt", "never fetched\n");
const neverFetchedCommit = commit(neverFetched, "local only", "2026-01-06T00:00:00Z");

const NAME = "fixture-repo";
const ctx = (dir: string, row: Row): Ctx => ({ name: NAME, dir, row }) as unknown as Ctx;
const c = ctx(cloneDir, { git_url: originDir, default_branch: "main" });

// ───────────────────────── 부르기 · 단언 도우미 ─────────────────────────
const refs = async (cc: Ctx, opts: { tags?: number } = {}): Promise<Refs> => (await repoRefsAt(cc, opts)) as unknown as Refs;
const diffFiles = async (from: string, to: string): Promise<DiffFiles> => (await repoDiffAt(c, from, to, {})) as unknown as DiffFiles;
const diffPatch = async (from: string, to: string, p: string): Promise<DiffPatch> => (await repoDiffAt(c, from, to, { path: p })) as unknown as DiffPatch;
const fileAt = async (rev: string, p: string, opts: { offset?: number; limit?: number; numbered?: boolean } = {}): Promise<FileAt> =>
  (await repoFileAt(c, rev, p, opts)) as unknown as FileAt;
const grepAt = async (rev: string, pattern: string, opts: { path?: string; limit?: number; ignore_case?: boolean } = {}): Promise<GrepAt> =>
  (await repoGrepAt(c, rev, pattern, opts)) as unknown as GrepAt;

const status = (n: number) => (e: unknown): boolean => {
  assert.ok(e instanceof Error, `Error 로 던지지 않았다: ${String(e)}`);
  assert.equal((e as Error & { status?: unknown }).status, n, `status 가 ${n} 이 아니다 — ${(e as Error).message}`);
  return true;
};
/** 줄로 나눈다 — 끝 줄바꿈 하나는 사양이 정하지 않아 떼고 본다. */
const lines = (text: string): string[] => text.replace(/\n$/, "").split("\n");
const where = (r: GrepAt): string[] => r.hits.map((h) => `${h.path}:${h.line}`).sort();
const lineNos = (r: GrepAt): number[] => r.hits.map((h) => h.line).sort((a, b) => a - b);
const listed = (r: DiffFiles): string[] => r.files.map((f) => `${f.status} ${f.path}`).sort();
const sorted = (xs: string[]): string[] => [...xs].sort();

// ───────────────────────── 고정물 확인 ─────────────────────────
test("고정물 — 주석 태그 객체는 커밋과 다르고 · 로컬 main 은 origin/main 보다 앞서 있다", () => {
  assert.notEqual(v110Obj, c2);
  assert.equal(git(cloneDir, ["rev-parse", "v1.1.0^{commit}"]), c2);
  assert.equal(git(cloneDir, ["rev-parse", "origin/main"]), c3);
  assert.equal(git(cloneDir, ["rev-parse", "main"]), localMain);
  assert.equal(git(cloneDir, ["rev-parse", "project/1"]), local1);
  assert.equal(git(cloneDir, ["cat-file", "-t", dangling]), "commit");
  assert.equal(git(cloneDir, ["rev-parse", "snap-only"]), ctag);
  assert.equal(git(cloneDir, ["cat-file", "-t", "blobtag"]), "blob");
});

// ───────────────────────── A1 판 고르기 ─────────────────────────
test("A1-1 해시 — 원격 브랜치 머리 · 그 조상 · 다른 원격 브랜치의 커밋은 읽는다", async () => {
  assert.equal(await resolveCommit(c, c3), c3);
  assert.equal(await resolveCommit(c, c1), c1); // origin/main 의 조상
  assert.equal(await resolveCommit(c, c2), c2);
  assert.equal(await resolveCommit(c, cdev), cdev); // origin/develop
});

//  사양 A1-1 을 좁힘(격리 리뷰 2026-11-22): 태그만으로는 받지 않는다 — refs/tags 는 세션이 단 로컬 태그와 원격에서 받은 태그를 가를 수 없다.
test("A1-1b 원격 브랜치에서 닿지 않는 커밋 — 원격 태그에서만 닿아도 · 로컬 태그로 이름을 붙여도 404(해시 · 태그 이름 둘 다)", async () => {
  await assert.rejects(() => resolveCommit(c, ctag), status(404), "원격 태그에서만 닿는 커밋(해시)");
  await assert.rejects(() => resolveCommit(c, "snap-only"), status(404), "원격 태그 이름 — 커밋이 원격 브랜치에 없다");
  await assert.rejects(() => resolveCommit(c, "wip-local"), status(404), "로컬 태그 이름 — 올라가지 않은 커밋");
});

test("A1-2 원격에 올리지 않은 커밋 — 로컬 브랜치 project/1 · 앞선 로컬 main · 매이지 않은 커밋은 해시로 줘도 404", async () => {
  for (const h of [local1, localMain, dangling]) await assert.rejects(() => resolveCommit(c, h), status(404), h);
  await assert.rejects(() => resolveCommit(ctx(neverFetched, {}), neverFetchedCommit), status(404));
});

test("A1-3 사본에 없는 해시 — 404", async () => {
  for (const h of ["0".repeat(40), "0123456789abcdef0123456789abcdef01234567"]) await assert.rejects(() => resolveCommit(c, h), status(404), h);
});

test("A1-4 이름 — main · origin/main 은 원격 머리(앞선 로컬 main 이 아니다) · 태그는 가리키는 커밋(주석 태그는 벗긴 커밋)", async () => {
  assert.equal(await resolveCommit(c, "main"), c3);
  assert.equal(await resolveCommit(c, "origin/main"), c3);
  assert.equal(await resolveCommit(c, "develop"), cdev);
  assert.equal(await resolveCommit(c, "origin/develop"), cdev);
  assert.equal(await resolveCommit(c, "v1.0.0"), c1); // 가벼운 태그
  assert.equal(await resolveCommit(c, "v1.1.0"), c2); // 주석 태그 — 태그 객체가 아니라 커밋
  assert.equal(await resolveCommit(c, "rel-late"), c1);
});

test("A1-5 로컬에만 있는 브랜치 이름 — 404", async () => {
  await assert.rejects(() => resolveCommit(c, "project/1"), status(404));
});

test("A1-6 꼴이 틀린 판 — 400 (- 로 시작 · .. · @{ · / 로 끝남 · 점으로 시작하는 마디 · 빈 글)", async () => {
  for (const rev of ["-x", "--all", "a..b", "main..develop", "main@{1}", "@{-1}", "main/", "a/.b", ".hidden", ""]) {
    await assert.rejects(() => resolveCommit(c, rev), status(400), JSON.stringify(rev));
  }
});

test("isRefName — A1-6 의 꼴", () => {
  for (const s of ["main", "origin/main", "project/1", "v1.2.3", "feature/x-y_z", "release-1.0"]) assert.equal(isRefName(s), true, s);
  for (const s of ["-x", "a..b", "main@{1}", "@{-1}", "main/", "a/.b", ".hidden", ""]) assert.equal(isRefName(s), false, JSON.stringify(s));
});

// ───────────────────────── A2 머리 · 태그 ─────────────────────────
test("A2-1 기본 브랜치 — git_url 이 있고 default_branch 가 브랜치 이름 꼴이면 그것", async () => {
  const r = await refs(ctx(cloneDir, { git_url: originDir, default_branch: "develop" }));
  assert.equal(r.default_branch, "develop");
  assert.equal(r.head?.branch, "develop");
  assert.equal(r.head?.commit, cdev);
  // row 가 정한 것이 origin/HEAD 보다 앞선다
  const r2 = await refs(ctx(cloneHeadDevelop, { git_url: originDir, default_branch: "main" }));
  assert.equal(r2.default_branch, "main");
  assert.equal(r2.head?.commit, c3);
});

test("A2-1 git_url 이 비었거나 default_branch 꼴이 아니면 — origin/HEAD 가 가리키는 것", async () => {
  const rows: Row[] = [
    { default_branch: "develop" },
    { git_url: "", default_branch: "develop" },
    { git_url: originDir, default_branch: "a..b" },
    { git_url: originDir, default_branch: "-x" },
    { git_url: originDir, default_branch: "" },
    { git_url: originDir },
    {},
  ];
  for (const row of rows) assert.equal((await refs(ctx(cloneDir, row))).default_branch, "main", JSON.stringify(row));
  const d = await refs(ctx(cloneHeadDevelop, {}));
  assert.equal(d.default_branch, "develop");
  assert.equal(d.head?.commit, cdev);
  assert.equal((await refs(ctx(cloneHeadDevelop, { default_branch: "main" }))).default_branch, "develop"); // git_url 이 없으면 row 를 보지 않는다
});

test("A2-1 origin/HEAD 도 없으면 main", async () => {
  const r = await refs(ctx(cloneNoHead, {}));
  assert.equal(r.default_branch, "main");
  assert.equal(r.head?.commit, c3);
  assert.equal((await refs(ctx(neverFetched, {}))).default_branch, "main");
});

test("A2-2 head — 기본 브랜치의 원격 머리: 커밋 · 커밋 시각(ISO) · 커밋 제목 (앞선 로컬 main 이 아니다)", async () => {
  const r = await refs(c);
  assert.equal(r.repo, NAME);
  assert.ok(r.head, "head 가 없다");
  assert.equal(r.head.branch, "main");
  assert.equal(r.head.commit, c3);
  assert.equal(r.head.subject, "third commit");
  assert.match(r.head.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.equal(new Date(r.head.date).getTime(), Date.parse("2026-01-03T00:00:00Z"));
  const d = await refs(ctx(cloneHeadDevelop, {}));
  assert.equal(d.head?.subject, "develop commit");
  assert.equal(new Date(String(d.head?.date)).getTime(), Date.parse("2026-01-03T12:00:00Z"));
});

test("A2-2 그 원격 브랜치가 없으면 head 는 null (로컬에만 있는 브랜치여도)", async () => {
  const nope = await refs(ctx(cloneDir, { git_url: originDir, default_branch: "nope" }));
  assert.equal(nope.default_branch, "nope");
  assert.equal(nope.head, null);
  const local = await refs(ctx(cloneDir, { git_url: originDir, default_branch: "project/1" }));
  assert.equal(local.default_branch, "project/1");
  assert.equal(local.head, null);
  assert.equal((await refs(ctx(neverFetched, {}))).head, null);
});

test("A2-3 tags — 주석 태그의 commit 은 벗긴 커밋 · 커밋이 아닌 것 · 원격 브랜치에서 닿지 않는 것(원격 태그만 · 로컬 태그)을 가리키는 태그는 빠진다 · 최근 만든 것부터", async () => {
  const r = await refs(c);
  const names = r.tags.map((t) => t.name);
  assert.deepEqual(sorted(names), sorted(["rel-late", "v2.0.0", "v1.1.0", "v1.0.0"]));
  const by = new Map(r.tags.map((t) => [t.name, t]));
  assert.equal(by.get("v1.0.0")?.commit, c1);
  assert.equal(by.get("v1.1.0")?.commit, c2);
  assert.notEqual(by.get("v1.1.0")?.commit, v110Obj);
  assert.equal(by.get("v2.0.0")?.commit, c3);
  assert.equal(by.get("rel-late")?.commit, c1);
  // 커밋 시각과 태그 만든 시각이 같은 차례인 셋 — 어느 쪽으로 읽어도 이 차례
  assert.deepEqual(names.filter((n) => ["v2.0.0", "v1.1.0", "v1.0.0"].includes(n)), ["v2.0.0", "v1.1.0", "v1.0.0"]);
  for (const t of r.tags) {
    assert.ok("date" in t, `${t.name} 에 date 칸이 없다`);
    assert.ok("tagged_at" in t, `${t.name} 에 tagged_at 칸이 없다`);
  }
  assert.equal(r.tags_truncated, false);
});

test("A2-3 최근 만든 것부터 — 옛 커밋에 가장 나중에 단 주석 태그가 맨 앞", async () => {
  const r = await refs(c);
  assert.equal(r.tags[0]?.name, "rel-late");
});

test("A2-4 tags 옵션으로 개수를 자르면 tags_truncated 참", async () => {
  const all = await refs(c);
  const cut = await refs(c, { tags: 2 });
  assert.equal(cut.tags.length, 2);
  assert.equal(cut.tags_truncated, true);
  assert.deepEqual(cut.tags.map((t) => t.name), all.tags.slice(0, 2).map((t) => t.name));
  const one = await refs(c, { tags: 1 });
  assert.equal(one.tags.length, 1);
  assert.equal(one.tags_truncated, true);
  const wide = await refs(c, { tags: 50 });
  assert.equal(wide.tags.length, 4); // 원격 브랜치에서 닿는 태그 넷(rel-late · v2.0.0 · v1.1.0 · v1.0.0 — 사양 A1-1 좁힘)
  assert.equal(wide.tags_truncated, false);
});

test("A2-5 fetched_at — 원격에서 받은 사본은 받은 시각 · 받은 적이 없으면 null", async () => {
  const r = await refs(c);
  assert.notEqual(r.fetched_at, null);
  assert.notEqual(r.fetched_at, undefined);
  const t = new Date(r.fetched_at as string).getTime();
  assert.ok(Number.isFinite(t), `시각으로 읽히지 않는다: ${String(r.fetched_at)}`);
  assert.ok(t >= T0 - 120_000 && t <= Date.now() + 120_000, `받은 때가 아니다: ${String(r.fetched_at)}`);
  const n = await refs(ctx(neverFetched, {}));
  assert.equal(n.fetched_at, null);
  assert.deepEqual(n.tags, []);
});

// ───────────────────────── A3 두 판 사이 ─────────────────────────
test("A3-1 바뀐 파일 목록 — 더함 A · 바꿈 M · 지움 D, 이름 바꿈은 D + A 두 줄", async () => {
  const r = await diffFiles(c1, c2);
  assert.equal(r.repo, NAME);
  assert.deepEqual(listed(r), sorted(["A added.txt", "A new-name.txt", "D del.txt", "D old-name.txt", "M a.txt"]));
  assert.ok(!r.files.some((f) => f.status.startsWith("R")), "이름 바꿈(R)이 한 줄로 나왔다");
  assert.equal(r.truncated, false);
  // 거꾸로 견주면 거꾸로
  assert.deepEqual(listed(await diffFiles(c2, c1)), sorted(["A del.txt", "A old-name.txt", "D added.txt", "D new-name.txt", "M a.txt"]));
  // 태그 이름으로도
  assert.deepEqual(listed(await diffFiles("v1.0.0", "v1.1.0")), listed(r));
  // main 은 origin/main(c3) — 같은 판끼리는 바뀐 것이 없다
  assert.deepEqual((await diffFiles(c3, "main")).files, []);
});

test("A3-2 path 를 주면 그 파일의 패치(unified diff — 바뀐 줄이 + · -)", async () => {
  const r = await diffPatch(c1, c2, "a.txt");
  assert.equal(r.repo, NAME);
  assert.equal(r.path, "a.txt");
  const ls = r.patch.split("\n");
  assert.ok(ls.includes("-beta"), r.patch);
  assert.ok(ls.includes("+BETA2"), r.patch);
  assert.ok(!ls.includes("-alpha") && !ls.includes("+alpha"), "바뀌지 않은 줄이 + · - 로 나왔다");
  assert.match(r.patch, /^@@ /m);
  assert.equal(r.truncated, false);
  const added = await diffPatch(c1, c2, "new-name.txt");
  assert.ok(added.patch.split("\n").includes("+rename me"), added.patch);
});

test("A3-3 두 판 모두 A1 — 로컬에서만 닿는 커밋 · 로컬 브랜치 이름은 404 · 꼴이 틀린 판은 400", async () => {
  await assert.rejects(() => repoDiffAt(c, c1, local1, {}), status(404));
  await assert.rejects(() => repoDiffAt(c, local1, c3, {}), status(404));
  await assert.rejects(() => repoDiffAt(c, localMain, c3, { path: "a.txt" }), status(404));
  await assert.rejects(() => repoDiffAt(c, c1, "project/1", {}), status(404));
  await assert.rejects(() => repoDiffAt(c, c1, dangling, {}), status(404));
  await assert.rejects(() => repoDiffAt(c, "-x", c3, {}), status(400));
  await assert.rejects(() => repoDiffAt(c, c1, "a..b", {}), status(400));
});

test("A3-4 꼴이 틀린 path — 400", async () => {
  for (const p of ["/a.txt", "../a.txt", "a/../b", "a//b", "./a.txt", "a/./b", "a\\b"]) {
    await assert.rejects(() => repoDiffAt(c, c1, c2, { path: p }), status(400), p);
  }
});

// ───────────────────────── A4 한 판의 파일 ─────────────────────────
test("A4-1 · A4-4 줄 범위 — offset(1부터) · limit · range {from, to, has_more}", async () => {
  const d = await fileAt(c3, "keep.txt");
  assert.equal(d.total_lines, 10);
  assert.deepEqual(d.range, { from: 1, to: 10, has_more: false });
  const mid = await fileAt(c3, "keep.txt", { offset: 3, limit: 4 });
  assert.deepEqual(mid.range, { from: 3, to: 6, has_more: true });
  assert.deepEqual(lines(mid.text), ["3\tkeep 3", "4\tkeep 4", "5\tkeep 5", "6\tkeep 6"]);
  const tail = await fileAt(c3, "keep.txt", { offset: 8, limit: 5 });
  assert.deepEqual(tail.range, { from: 8, to: 10, has_more: false });
  assert.deepEqual(lines(tail.text), ["8\tkeep 8", "9\tkeep 9", "10\tkeep 10"]);
  const exact = await fileAt(c3, "keep.txt", { offset: 1, limit: 10 });
  assert.deepEqual(exact.range, { from: 1, to: 10, has_more: false });
  const first = await fileAt(c3, "keep.txt", { limit: 2 });
  assert.deepEqual(first.range, { from: 1, to: 2, has_more: true });
});

test("A4-1 limit 기본 400", async () => {
  const d = await fileAt(c3, "big450.txt");
  assert.equal(d.total_lines, 450);
  assert.deepEqual(d.range, { from: 1, to: 400, has_more: true });
  const ls = lines(d.text);
  assert.equal(ls.length, 400);
  assert.equal(ls[399], "400\trow 400");
});

test("A4-1 limit 은 5000 까지", async () => {
  const big = await fileAt(c3, "big5100.txt", { limit: 6000 });
  assert.equal(big.total_lines, 5100);
  assert.deepEqual(big.range, { from: 1, to: 5000, has_more: true });
  assert.equal(lines(big.text).length, 5000);
  const rest = await fileAt(c3, "big5100.txt", { offset: 5001, limit: 5000 });
  assert.deepEqual(rest.range, { from: 5001, to: 5100, has_more: false });
  assert.equal(lines(rest.text)[0], "5001\tr5001");
});

test("A4-2 numbered — 기본은 줄마다 «줄번호\\t글» · 거짓이면 글 그대로(줄바꿈으로 잇는다)", async () => {
  const n = await fileAt(c3, "a.txt");
  assert.deepEqual(lines(n.text), ["1\talpha", "2\tBETA2", "3\tgamma", "4\tdelta ONLY_IN_C3"]);
  const raw = await fileAt(c3, "a.txt", { numbered: false });
  assert.equal(raw.text.replace(/\n$/, ""), "alpha\nBETA2\ngamma\ndelta ONLY_IN_C3");
  const part = await fileAt(c3, "keep.txt", { offset: 2, limit: 2, numbered: false });
  assert.equal(part.text.replace(/\n$/, ""), "keep 2\nkeep 3");
  const on = await fileAt(c3, "keep.txt", { offset: 2, limit: 2, numbered: true });
  assert.deepEqual(lines(on.text), ["2\tkeep 2", "3\tkeep 3"]);
});

test("A4-3 total_lines — 파일 끝의 줄바꿈 하나는 빈 줄로 세지 않는다 · 빈 파일은 0", async () => {
  assert.equal((await fileAt(c3, "a.txt")).total_lines, 4);
  const noeol = await fileAt(c3, "noeol.txt");
  assert.equal(noeol.total_lines, 3);
  assert.deepEqual(lines(noeol.text), ["1\ta", "2\tb", "3\tc"]);
  const blank = await fileAt(c3, "blank-end.txt"); // "a\nb\n\n" — 끝 줄바꿈 하나만 빼고 센다
  assert.equal(blank.total_lines, 3);
  assert.deepEqual(blank.range, { from: 1, to: 3, has_more: false });
  assert.deepEqual(lines(blank.text), ["1\ta", "2\tb", "3\t"]);
  const empty = await fileAt(c3, "empty.txt");
  assert.equal(empty.total_lines, 0);
  assert.equal(empty.text.replace(/\n$/, ""), "");
});

test("A4-5 그 판에 없는 경로 · 폴더 → 404", async () => {
  for (const [rev, p] of [[c3, "nope.txt"], [c3, "src"], [c3, "grep/sub"], [c3, ".github"], [c1, "added.txt"], [c2, "del.txt"], [c3, "secret.txt"], [c3, "dev.txt"]] as const) {
    await assert.rejects(() => fileAt(rev, p), status(404), `${rev.slice(0, 7)}:${p}`);
  }
  assert.equal((await fileAt(c1, "del.txt")).total_lines, 1); // 지우기 전 판에서는 읽힌다
  assert.equal((await fileAt(c2, "added.txt")).total_lines, 1);
});

test("A4-5 이진 파일(NUL 바이트) → 415", async () => {
  await assert.rejects(() => fileAt(c3, "bin.dat"), status(415));
});

test("A4-5 8 MiB 넘는 파일 → 413 · 꼭 8 MiB 는 읽힌다", async () => {
  await assert.rejects(() => fileAt(c3, "huge.txt"), status(413));
  const edge = await fileAt(c3, "edge8m.txt", { limit: 3 });
  assert.equal(edge.total_lines, MIB8 / 2);
  assert.deepEqual(edge.range, { from: 1, to: 3, has_more: true });
});

test("A4-6 꼴이 틀린 경로 → 400 · 점으로 시작하는 마디(.github/…)는 된다", async () => {
  for (const p of ["/a.txt", "a\\b.txt", "../a.txt", "a/../b", "..", "./a.txt", "a/./b", ".", "a//b", ""]) {
    await assert.rejects(() => fileAt(c3, p), status(400), JSON.stringify(p));
  }
  const y = await fileAt(c3, ".github/workflows/ci.yml");
  assert.deepEqual(lines(y.text), ["1\tname: ci", "2\ton: push"]);
});

test("isRepoPath — A4-6 의 꼴", () => {
  for (const p of ["a.txt", "src/x.ts", ".github/workflows/ci.yml", "a/b/c.txt"]) assert.equal(isRepoPath(p), true, p);
  for (const p of ["/a.txt", "a\\b", "..", "../a", "a/../b", ".", "./a", "a/./b", "a//b", ""]) assert.equal(isRepoPath(p), false, JSON.stringify(p));
});

test("A4-7 고른 판의 내용 — 같은 파일이 판마다 달라도 그 판의 줄 · 이름은 원격 쪽", async () => {
  const a1 = await fileAt(c1, "a.txt", { numbered: false });
  assert.equal(a1.text.replace(/\n$/, ""), "alpha\nbeta\ngamma");
  assert.equal(a1.commit, c1);
  assert.equal(a1.repo, NAME);
  assert.equal(a1.path, "a.txt");
  const a2 = await fileAt("v1.1.0", "a.txt", { numbered: false });
  assert.equal(a2.text.replace(/\n$/, ""), "alpha\nBETA2\ngamma");
  assert.equal(a2.commit, c2);
  const m = await fileAt("main", "a.txt", { numbered: false }); // 앞선 로컬 main 의 글(LOCAL_MAIN_AHEAD)이 아니다
  assert.equal(m.text.replace(/\n$/, ""), "alpha\nBETA2\ngamma\ndelta ONLY_IN_C3");
  assert.equal(m.commit, c3);
  assert.equal((await fileAt("develop", "dev.txt", { numbered: false })).text.replace(/\n$/, ""), "dev only");
});

test("A4 원격에 올리지 않은 커밋 · 로컬 브랜치는 파일 읽기로도 404 · 꼴이 틀린 판은 400", async () => {
  await assert.rejects(() => fileAt(local1, "secret.txt"), status(404));
  await assert.rejects(() => fileAt(localMain, "a.txt"), status(404));
  await assert.rejects(() => fileAt(dangling, "a.txt"), status(404));
  await assert.rejects(() => fileAt("project/1", "a.txt"), status(404));
  await assert.rejects(() => fileAt("-x", "a.txt"), status(400));
});

// ───────────────────────── A5 한 판에서 찾기 ─────────────────────────
test("A5-1 글자 그대로 — . * ( [ ^ 도 그 글자 자체", async () => {
  const g = (p: string) => grepAt(c3, p, { path: "grep/lit.txt" });
  assert.deepEqual(lineNos(await g("a.b")), [2]);
  assert.deepEqual(lineNos(await g("foo(")), [3]);
  assert.deepEqual(lineNos(await g("r*h")), [4]);
  assert.deepEqual(lineNos(await g("[x]")), [6]);
  assert.deepEqual(lineNos(await g("^axb")), []);
});

test("A5-2 대소문자를 가린다 · ignore_case 면 가리지 않는다", async () => {
  assert.deepEqual(lineNos(await grepAt(c3, "hello", { path: "grep/case.txt" })), [2]);
  assert.deepEqual(lineNos(await grepAt(c3, "hello", { path: "grep/case.txt", ignore_case: true })), [1, 2, 3]);
});

test("A5-3 path — 그 파일이나 그 폴더 아래만 (이름 앞부분만 같은 옆 폴더 grep2 는 아니다)", async () => {
  assert.deepEqual(where(await grepAt(c3, "NEEDLE")), sorted(["grep/one.txt:1", "grep/sub/two.txt:2", "grep2/four.txt:1", "other/three.txt:1"]));
  assert.deepEqual(where(await grepAt(c3, "NEEDLE", { path: "grep" })), sorted(["grep/one.txt:1", "grep/sub/two.txt:2"]));
  assert.deepEqual(where(await grepAt(c3, "NEEDLE", { path: "grep/sub" })), ["grep/sub/two.txt:2"]);
  assert.deepEqual(where(await grepAt(c3, "NEEDLE", { path: "other/three.txt" })), ["other/three.txt:1"]);
});

test("A5-4 맞은 줄마다 {path(레포 안 경로), line(1부터), text} · 400자 넘는 줄은 400자 + …", async () => {
  const r = await grepAt(c3, "NEEDLE two");
  assert.equal(r.repo, NAME);
  assert.equal(r.commit, c3);
  assert.equal(r.pattern, "NEEDLE two");
  assert.deepEqual(r.hits.map((h) => ({ path: h.path, line: h.line, text: h.text })), [{ path: "grep/sub/two.txt", line: 2, text: "NEEDLE two" }]);
  const long = await grepAt(c3, "LONGHIT");
  assert.equal(long.hits.length, 1);
  assert.equal(long.hits[0].text, LONG450.slice(0, 400) + "…");
  const exact = await grepAt(c3, "EXACTHIT");
  assert.equal(exact.hits.length, 1);
  assert.equal(exact.hits[0].text, LONG400); // 꼭 400자는 그대로
  assert.equal((await grepAt("main", "NEEDLE one")).commit, c3); // 이름이면 원격 머리의 커밋
});

test("A5-5 limit 기본 50 — 넘치면 truncated 참", async () => {
  const d = await grepAt(c3, "MANYHIT");
  assert.equal(d.hits.length, 50);
  assert.equal(d.truncated, true);
  const ten = await grepAt(c3, "MANYHIT", { limit: 10 });
  assert.equal(ten.hits.length, 10);
  assert.equal(ten.truncated, true);
  const few = await grepAt(c3, "TENHIT");
  assert.equal(few.hits.length, 10);
  assert.equal(few.truncated, false);
});

test("A5-5 limit 은 300 까지", async () => {
  const max = await grepAt(c3, "MANYHIT", { limit: 1000 });
  assert.equal(max.hits.length, 300);
  assert.equal(max.truncated, true);
  for (const h of max.hits) {
    assert.equal(h.path, "grep/many.txt");
    assert.equal(h.text, `MANYHIT ${h.line}`);
  }
});

test("A5-5 맞은 줄 수가 limit 과 꼭 같으면 넘친 것이 아니다", async () => {
  const all = await grepAt(c3, "TENHIT", { limit: 10 });
  assert.equal(all.hits.length, 10);
  assert.equal(all.truncated, false);
});

test("A5-6 맞는 줄이 없으면 빈 목록(오류 아님) · 이진 파일은 건너뛴다 · 그 판의 내용만", async () => {
  const none = await grepAt(c3, "NO_SUCH_TEXT_ANYWHERE");
  assert.deepEqual(none.hits, []);
  assert.equal(none.truncated, false);
  assert.ok(!(await grepAt(c3, "NEEDLE")).hits.some((h) => h.path === "bin.dat"), "이진 파일이 맞은 줄로 나왔다");
  assert.deepEqual((await grepAt(c3, "in binary")).hits, []);
  assert.deepEqual((await grepAt(c1, "ONLY_IN_C3")).hits, []);
  assert.deepEqual(where(await grepAt(c3, "ONLY_IN_C3")), ["a.txt:4"]);
});

test("A5 원격에 올리지 않은 작업의 글은 찾히지 않는다 — main 은 원격 머리 · 로컬 커밋 · 로컬 브랜치는 404", async () => {
  assert.deepEqual((await grepAt("main", "LOCAL_MAIN_AHEAD")).hits, []);
  assert.deepEqual((await grepAt("main", "LOCAL_SECRET")).hits, []);
  await assert.rejects(() => grepAt(local1, "LOCAL_SECRET"), status(404));
  await assert.rejects(() => grepAt(localMain, "LOCAL_MAIN_AHEAD"), status(404));
  await assert.rejects(() => grepAt("project/1", "LOCAL_SECRET"), status(404));
  await assert.rejects(() => grepAt("a/.b", "x"), status(400));
});

test("A5-7 찾을 글 — 비었거나 · 200자 넘거나 · 줄바꿈이 들어 있으면 400 · 꼭 200자는 된다", async () => {
  for (const p of ["", "x".repeat(201), "a\nb", "NEEDLE\n"]) {
    await assert.rejects(() => grepAt(c3, p), status(400), JSON.stringify(p.slice(0, 12)));
  }
  assert.deepEqual((await grepAt(c3, "q".repeat(200))).hits, []);
});

test("A5-7 - 로 시작하는 글도 글자 그대로 찾는다(옵션으로 읽히지 않는다)", async () => {
  assert.deepEqual(where(await grepAt(c3, "-v", { path: "grep/dash.txt" })), ["grep/dash.txt:1"]);
  assert.deepEqual(where(await grepAt(c3, "-e", { path: "grep/dash.txt" })), ["grep/dash.txt:2"]);
  assert.deepEqual(where(await grepAt(c3, "--help", { path: "grep/dash.txt" })), ["grep/dash.txt:3"]);
});

// ───────────────────────── A6 원격 주소 견주기 ─────────────────────────
test("A6-1 같은 저장소의 여러 주소 — 같은 값(대소문자 · 끝 .git · 끝 / · 자격은 보지 않는다)", () => {
  const forms = [
    "https://github.com/Org/Repo.git",
    "https://user:token@github.com/org/repo",
    "git@github.com:org/repo.git",
    "ssh://git@github.com/org/repo",
    "https://github.com/org/repo/",
    "https://GitHub.com/ORG/REPO",
  ];
  const k = remoteKey(forms[0]);
  assert.ok(k, "값이 없다");
  for (const f of forms) assert.equal(remoteKey(f), k, f);
});

test("A6-2 다른 저장소(다른 이름 · 다른 조직 · 다른 호스트) — 다른 값", () => {
  const base = remoteKey("https://github.com/org/repo");
  const others = ["https://github.com/org/other", "https://github.com/acme/repo", "https://gitlab.com/org/repo"].map(remoteKey);
  for (const k of others) {
    assert.ok(k);
    assert.notEqual(k, base);
  }
  assert.equal(new Set(others).size, 3);
  assert.equal(remoteKey("git@gitlab.com:org/repo.git"), remoteKey("https://gitlab.com/org/repo"));
});

test("A6-3 호스트가 없는 로컬 경로 — 경로 그대로 견준다(같은 경로 = 같은 값 · 끝 / 무시)", () => {
  const k = remoteKey("/srv/git/org/repo");
  assert.ok(k);
  assert.equal(remoteKey("/srv/git/org/repo/"), k);
  assert.notEqual(remoteKey("/srv/git/org/other"), k);
  assert.notEqual(remoteKey("/data/git/org/repo"), k); // 뒤 마디가 같아도 경로가 다르면 다른 값
  assert.notEqual(remoteKey("https://github.com/org/repo"), k);
  assert.equal(remoteKey(originDir), remoteKey(originDir + "/"));
});

test("A6-4 빈 글 → null", () => {
  assert.equal(remoteKey(""), null);
});


// ───────────────────────── 찾기 출력 읽기(격리 리뷰 2026-11-22) ─────────────────────────
//  git grep -z 의 한 줄은 «판:경로\0줄\0글\n». 경로에 줄바꿈이 들어도 깨지지 않고, 끝이 잘린 마지막 줄(출력 상한)은 버린다.
test("parseGrepZ — 경로 안 줄바꿈 · 판 머리 떼기 · 잘린 끝 줄 버리기", () => {
  const sha = "a".repeat(40);
  const raw = `${sha}:src/a.ts\x0012\x00const x = 1;\n${sha}:odd\nname.txt\x003\x00hit\n${sha}:cut.ts\x009\x00part`;
  assert.deepEqual(parseGrepZ(raw, sha), [
    { path: "src/a.ts", line: 12, text: "const x = 1;" },
    { path: "odd\nname.txt", line: 3, text: "hit" },
  ]);
  assert.deepEqual(parseGrepZ("", sha), []);
});
