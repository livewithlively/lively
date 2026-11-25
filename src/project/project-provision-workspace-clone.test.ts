// 공유 클론 자리를 워크스페이스마다 따로 — **진짜 git** 으로 검증(DB 없음 · 주입 경로). 실행: npm run build && node dist/project/project-provision-workspace-clone.test.js
//
//  증명하려는 것: 게이트웨이 하나가 여러 워크스페이스를 서비스할 때, 한 워크스페이스가 받아 둔 공유 클론을 다른 워크스페이스가
//   **같은 레포 이름으로** 쓰지 못한다(주소가 달라도 · 같아도). 워크스페이스 열쇠가 없는 배포(단일 워크스페이스 · primary · 노드)는
//   종전 자리 그대로다. 로컬 bare 레포를 file:// 로 원격 삼아 네트워크 · 자격 없이 돌린다.
//
// ── 입력 × 기대 ──────────────────────────────────────────────────────────────
//  W1  | 열쇠 없음 · 레포 x                              | 종전 자리 repos/x 에 받는다(무회귀)
//  W2  | 열쇠 A · 레포 x(주소 A)                         | repos/@ws/<A>/x 에 받는다 · 종전 자리의 것을 쓰지 않는다
//  W3  | 열쇠 B · 같은 이름 x(주소 B)                    | repos/@ws/<B>/x 에 **B 의 코드** — A 의 클론을 쓰지 않는다
//  W4  | 열쇠 B · 같은 이름 · **A 와 같은 주소**         | 그래도 제 자리에 새로 받는다(cloned) — A 의 자리는 그대로
//  W5  | 열쇠 B · A 만 받아 둔 레포 y 를 «코드 최신화»   | no-clone(A 의 클론을 최신화 · 노출하지 않는다)
//  W6  | 열쇠 B · 경로 직접 지정 = A 의 자리 · 종전 자리 · 남의 프로젝트 폴더 | 400 — 클론 · 워크트리를 만들지 않는다
//  W6b | 열쇠 B · 경로 직접 지정 = 제 공유 클론 폴더 안  | 된다
//  W7  | 열쇠 없음 · 경로 직접 지정 = repos/@ws/<A>/x    | 400
//  W7b | 열쇠 없음 · 경로 직접 지정 = 워크스페이스 안 다른 곳 | 종전대로 된다
//  W8  | 열쇠가 UUID 꼴이 아님                           | 던진다(error) — 종전(공용) 자리에 받지 않는다
//  W9  | 종전 자리의 클론에 붙은 워크트리가 있는 프로젝트를 열쇠가 생긴 뒤 다시 준비 | 워크트리는 그대로 재사용(409 아님) · base 는 제 자리에 새로
//  W10 | 워크트리 준비(열쇠 A)                           | 워크트리의 base 가 repos/@ws/<A>/x 다
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

delete process.env.ITEMS_DATABASE_URL;   // DB 없이(주입 경로) — 레지스트리를 읽지 않는다
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prov-ws-clone-")));
process.env.TERMINAL_ROOT_SHARED = ROOT;

const { installWorkspaceDirKeyResolver } = await import("../ops/workspace-dir-key.js");
const { provisionProjectRepos, ensureProvisionBase, refreshSharedRepo, sharedRepoPath, sharedReposBase } = await import("./project-provision.js");

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const git = (args: string[], cwd?: string) => execFileSync("git", args, {
  cwd, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
}).toString().trim();
const errOf = async (p: Promise<unknown>): Promise<{ status?: number; message?: string } | null> => { try { await p; return null; } catch (e) { return e as { status?: number; message?: string }; } };

const A = "aaaaaaaa-1111-2222-3333-444444444444";
const B = "bbbbbbbb-1111-2222-3333-444444444444";
let key: string | null = null;
installWorkspaceDirKeyResolver(() => key);
const as = async <T>(k: string | null, fn: () => Promise<T>): Promise<T> => { key = k; try { return await fn(); } finally { key = null; } };

/** 커밋 하나 든 bare 원격 — README 에 표지 글. */
function origin(tag: string): string {
  const work = path.join(ROOT, `src-${tag}`);
  fs.mkdirSync(work, { recursive: true });
  git(["init", "-q", "-b", "main", work]);
  fs.writeFileSync(path.join(work, "README.md"), `owner=${tag}\n`);
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", "init"], work);
  const bare = path.join(ROOT, `origin-${tag}.git`);
  git(["clone", "-q", "--bare", work, bare]);
  return "file://" + bare;
}
const readme = (dir: string): string => fs.readFileSync(path.join(dir, "README.md"), "utf8").trim();
const inj = (gitUrl: string) => ({ gitUrl, secret: null });

try {
  const urlLegacy = origin("legacy"), urlA = origin("a"), urlB = origin("b"), urlY = origin("y");
  const legacyX = path.join(ROOT, "repos", "x");
  const aX = path.join(ROOT, "repos", "@ws", A, "x");
  const bX = path.join(ROOT, "repos", "@ws", B, "x");

  // ── W1 열쇠 없음 — 종전 자리 ──
  {
    assert.equal(sharedReposBase(), path.join(ROOT, "repos"));
    assert.equal(sharedRepoPath("x"), legacyX);
    const r = await ensureProvisionBase("x", null, inj(urlLegacy));
    assert.equal(r.status, "cloned", JSON.stringify(r));
    assert.equal(readme(legacyX), "owner=legacy");
    ok("W1 열쇠가 없으면 종전 자리 repos/x 에 받는다");
  }

  // ── W2 열쇠 A — 제 자리 ──
  {
    const r = await as(A, async () => {
      assert.equal(sharedRepoPath("x"), aX);
      return ensureProvisionBase("x", null, inj(urlA));
    });
    assert.equal(r.status, "cloned", `종전 자리의 클론을 재사용하면 안 된다: ${JSON.stringify(r)}`);
    assert.equal(readme(aX), "owner=a");
    assert.equal(readme(legacyX), "owner=legacy", "종전 자리는 그대로");
    ok("W2 열쇠 A 는 repos/@ws/<A>/x 에 받고 종전 자리의 클론을 쓰지 않는다");
  }

  // ── W3 열쇠 B · 같은 이름 · 다른 주소 ──
  {
    const r = await as(B, () => ensureProvisionBase("x", null, inj(urlB)));
    assert.equal(r.status, "cloned", JSON.stringify(r));
    assert.equal(readme(bX), "owner=b", "B 는 B 의 코드를 받아야 한다");
    assert.equal(readme(aX), "owner=a");
    ok("W3 같은 이름을 등록한 다른 워크스페이스는 제 주소의 코드를 제 자리에 받는다");
  }

  // ── W4 열쇠 B · 같은 이름 · A 와 같은 주소 ──
  {
    await fsp.rm(bX, { recursive: true, force: true });
    const aHeadBefore = git(["rev-parse", "HEAD"], aX);
    const fetchStamp = (): number | null => { try { return fs.statSync(path.join(aX, ".git", "FETCH_HEAD")).mtimeMs; } catch { return null; } };
    const aFetchBefore = fetchStamp();
    const r = await as(B, () => ensureProvisionBase("x", null, inj(urlA)));
    assert.equal(r.status, "cloned", `A 의 클론을 재사용(refreshed)하면 안 된다: ${JSON.stringify(r)}`);
    assert.ok(fs.existsSync(path.join(bX, ".git")), "B 의 자리에 새 클론이 있어야 한다");
    assert.notEqual(fs.realpathSync(bX), fs.realpathSync(aX));
    assert.equal(git(["rev-parse", "HEAD"], aX), aHeadBefore);
    assert.equal(fetchStamp(), aFetchBefore, "A 의 클론은 건드리지 않는다(fetch 도 안 한다)");
    ok("W4 주소가 같아도 다른 워크스페이스의 클론을 쓰지 않고 제 자리에 새로 받는다");
  }

  // ── W5 «코드 최신화» — A 만 받아 둔 레포 ──
  {
    await as(A, () => ensureProvisionBase("y", null, inj(urlY)));
    const mine = await as(A, () => refreshSharedRepo("y", null, inj(urlY)));
    assert.notEqual(mine.status, "no-clone", `배선: A 자신은 제 클론을 봐야 한다 — ${JSON.stringify(mine)}`);
    const theirs = await as(B, () => refreshSharedRepo("y", null, inj(urlY)));
    assert.equal(theirs.status, "no-clone", `B 는 A 의 클론을 볼 수 없어야 한다: ${JSON.stringify(theirs)}`);
    const none = await refreshSharedRepo("y", null, inj(urlY));
    assert.equal(none.status, "no-clone", "열쇠 없는 호출도 워크스페이스 자리의 클론을 보지 않는다");
    ok("W5 다른 워크스페이스가 받아 둔 레포는 «코드 최신화» 에 없는 것으로 보인다");
  }

  // ── W6 열쇠 B · 경로 직접 지정이 남의 자리 ──
  {
    // 남의 프로젝트 폴더에 있는 워크트리(열쇠 없는 프로젝트 7001 — W9 에서도 쓴다)
    await provisionProjectRepos(7001, "project/7001", [{ name: "x", worktree: true, inject: inj(urlLegacy) }], { memberId: null });
    assert.equal(readme(path.join(ROOT, "project", "7001", "x")), "owner=legacy", "배선: 남의 프로젝트 워크트리가 실제로 있다");
    const foreign = [aX, legacyX, path.join(ROOT, "project", "7001", "x"), path.join(ROOT, "repos", "@ws", A)];
    for (const p of foreign) {
      const e = await as(B, () => errOf(provisionProjectRepos(8001, "project/8001", [{ name: "x", path: p, worktree: true, inject: inj(urlB) }], { memberId: null })));
      assert.equal(e?.status, 400, `막혀야 한다: ${p} → ${e?.status} ${e?.message}`);
    }
    assert.equal(fs.existsSync(path.join(ROOT, "project", "8001", "x")), false, "거절된 준비는 워크트리를 만들지 않는다");
    ok("W6 다른 워크스페이스의 클론 · 종전 자리 · 남의 프로젝트 폴더를 레포 경로로 지정하면 400");

    const own = path.join(ROOT, "repos", "@ws", B, "custom-x");
    const { provisioned } = await as(B, () => provisionProjectRepos(8002, "project/8002", [{ name: "x", path: own, worktree: true, inject: inj(urlB) }], { memberId: null }));
    assert.equal(provisioned.length, 1);
    assert.equal(readme(path.join(ROOT, "project", "8002", "x")), "owner=b");
    ok("W6b 제 공유 클론 폴더 안의 경로는 직접 지정할 수 있다");
  }

  // ── W7 열쇠 없음 · 경로 직접 지정 ──
  {
    const e = await errOf(provisionProjectRepos(7002, "project/7002", [{ name: "x", path: aX, worktree: true, inject: inj(urlLegacy) }], { memberId: null }));
    assert.equal(e?.status, 400, `${e?.status} ${e?.message}`);
    assert.equal(fs.existsSync(path.join(ROOT, "project", "7002", "x")), false);
    ok("W7 열쇠 없는 호출도 repos/@ws/… 를 레포 경로로 지정하지 못한다");

    const custom = path.join(ROOT, "custom", "x");
    const { provisioned } = await provisionProjectRepos(7003, "project/7003", [{ name: "x", path: custom, worktree: true, inject: inj(urlLegacy) }], { memberId: null });
    assert.equal(provisioned.length, 1);
    assert.equal(readme(custom), "owner=legacy");
    ok("W7b 열쇠 없는 호출의 그 밖의 직접 지정 경로는 종전대로 된다");
  }

  // ── W8 열쇠 꼴이 틀림 ──
  {
    for (const bad of ["../../evil", "acme", A.slice(0, -1)]) {
      const r = await as(bad, () => ensureProvisionBase("z", null, inj(urlB)));
      assert.equal(r.status, "error", `${bad}: ${JSON.stringify(r)}`);
    }
    assert.equal(fs.existsSync(path.join(ROOT, "repos", "z")), false, "종전(공용) 자리에 받지 않는다");
    assert.equal(fs.existsSync(path.join(ROOT, "evil")), false);
    assert.deepEqual(fs.readdirSync(path.join(ROOT, "repos", "@ws")).sort(), [A, B].sort(), "@ws 밑에는 두 워크스페이스의 폴더만 있다");
    ok("W8 열쇠가 UUID 꼴이 아니면 받지 않고 멈춘다(공용 자리로 떨어지지 않는다)");
  }

  // ── W9 종전 자리의 클론에 붙은 워크트리 — 열쇠가 생긴 뒤 다시 준비 ──
  {
    const wt = path.join(ROOT, "project", "7001", "x");
    fs.writeFileSync(path.join(wt, "wip.txt"), "작업 중\n");   // 커밋 안 한 사람의 파일
    await fsp.rm(aX, { recursive: true, force: true });       // A 가 아직 제 자리에 받지 않은 상태로
    const { provisioned, failed } = await as(A, () => provisionProjectRepos(7001, "project/7001",
      [{ name: "x", worktree: true, inject: inj(urlA) }], { memberId: null, failOpen: true }));
    assert.deepEqual(failed, [], JSON.stringify(failed));
    assert.equal(provisioned[0]?.cwd, wt);
    assert.equal(readme(wt), "owner=legacy", "있던 워크트리의 내용은 그대로");
    assert.ok(fs.existsSync(path.join(wt, "wip.txt")), "사람의 파일을 건드리지 않는다");
    assert.equal(git(["rev-parse", "--is-inside-work-tree"], wt), "true");
    assert.equal(readme(aX), "owner=a", "base 는 제 자리에 새로 받는다");
    ok("W9 종전 자리의 클론에 붙은 워크트리는 그대로 재사용되고 base 만 제 자리에 새로 받는다");
  }

  // ── W10 워크트리의 base ──
  {
    const { provisioned } = await as(A, () => provisionProjectRepos(9001, "project/9001", [{ name: "x", worktree: true, inject: inj(urlA) }], { memberId: null }));
    const wt = provisioned[0]!.cwd;
    const common = fs.realpathSync(path.resolve(wt, git(["rev-parse", "--git-common-dir"], wt)));
    assert.equal(common, fs.realpathSync(path.join(aX, ".git")));
    assert.equal(readme(wt), "owner=a");
    ok("W10 워크스페이스의 워크트리는 그 워크스페이스의 공유 클론에서 뜬다");
  }

  console.log(`\n${pass} passed`);
} finally {
  installWorkspaceDirKeyResolver(() => null);
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => { /* */ });
}
