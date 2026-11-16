// 레포 클론의 디스크 가드가 **저장소 정책(노드에선 env 시드)** 으로 판정하는지 고정한다 (#5564).
//
//  회귀 대상: 클론 가드만 임계를 안 넘겨 코드 폴백(사용률 95% · 남은 공간 5GB)으로 판정하던 것. 노드 컴퓨터에서
//   DISK_CRITICAL_* 로 기준을 바꿔도 새 세션에만 먹고 클론은 옛 기준으로 막혔다(반대로, 더 엄하게 잡아도 클론은 통과했다).
//  DB 없는 상태(= 노드 조건)에서 env 만으로 양쪽을 본다: 바닥을 디스크보다 크게 → 507, 바닥을 아주 작게 → 클론 성공.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

delete process.env.ITEMS_DATABASE_URL;
delete process.env.LIVELY_NODE_TOKEN; // 문구를 게이트웨이 쪽으로 고정(disk-guard.test 와 같은 이유 #5029)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "prov-disk-guard-"));
process.env.TERMINAL_ROOT_SHARED = ROOT;

const { provisionProjectRepos } = await import("./project-provision.js");
const { invalidateStoragePolicyCache } = await import("../org/policies/storage-policy.js");
const { invalidateDiskState } = await import("../ops/disk-guard.js");
const { HttpError } = await import("../http-error.js");

const git = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString();
const setPolicy = (pct: string, gb: string) => {
  process.env.DISK_CRITICAL_PCT = pct;
  process.env.DISK_CRITICAL_FREE_GB = gb;
  invalidateStoragePolicyCache();
  invalidateDiskState();
};
//  worktree:true 로 둔다 — false 면 클론 경로를 하네스 접근 목록에 등록하느라 **실제 홈**의 ~/.codex/config.toml 을 쓴다(writeAddDir).
const clone = (id: number, name: string, url: string) => provisionProjectRepos(
  id, `project/${id}`, [{ name, worktree: true, inject: { gitUrl: url, secret: null } }], { clone: true, memberId: null });

const saved = { pct: process.env.DISK_CRITICAL_PCT, gb: process.env.DISK_CRITICAL_FREE_GB };
try {
  const srcWork = path.join(ROOT, "src-work");
  fs.mkdirSync(srcWork, { recursive: true });
  git(["init", "-q", "-b", "main", srcWork]);
  fs.writeFileSync(path.join(srcWork, "README.md"), "hello\n");
  git(["add", "-A"], srcWork);
  git(["commit", "-q", "-m", "init"], srcWork);
  const bare = path.join(ROOT, "origin.git");
  git(["clone", "-q", "--bare", srcWork, bare]);
  const fileUrl = "file://" + bare;

  // ── 바닥을 디스크보다 크게(비율은 안 봄) → 클론 전에 507, 받아온 것도 없어야 한다 ──
  //  노브 상한이 10000GB 라, 그보다 많이 남았다고 보고하는 디스크(gVisor 는 8.0E)에선 «바닥 아래» 를 만들 수 없다 — 건너뛴다.
  const st = fs.statfsSync(ROOT);
  const availGb = (Number(st.bavail) * Number(st.bsize)) / 1024 ** 3;
  if (availGb < 10_000) {
    setPolicy("0", "10000");
    await assert.rejects(
      () => clone(90611, "blocked-repo", fileUrl),
      (err: unknown) => {
        assert.ok(err instanceof HttpError, `HttpError 여야: ${String(err)}`);
        assert.equal(err.status, 507);
        assert.match(err.message, /레포 'blocked-repo' 클론/, "무엇이 막혔는지");
        assert.match(err.message, /남은 공간이 10000GB보다 적으면 새 작업을 막습니다/, "env 로 준 기준으로 막아야 한다(코드 폴백 95% · 5GB 가 아니라)");
        return true;
      },
    );
    assert.ok(!fs.existsSync(path.join(ROOT, "repos", "blocked-repo")), "막았으면 클론이 생기면 안 된다");
    console.log("ok  env 기준(비율 0 · 바닥 10000GB)으로 클론을 막는다");
  } else {
    console.log(`skip 남은 공간 ${Math.round(availGb)}GB — 노브 상한보다 커서 «바닥 아래» 를 만들 수 없다`);
  }

  // ── 바닥을 아주 작게(0.01GB) → 디스크가 아무리 찼어도 그만큼만 남아 있으면 클론한다 ──
  if (availGb > 0.05) {
    setPolicy("0", "0.01");
    const { provisioned } = await clone(90612, "open-repo", fileUrl);
    assert.equal(provisioned[0].cloned, true);
    assert.ok(fs.existsSync(path.join(ROOT, "repos", "open-repo", "README.md")), "클론이 커밋을 받아와야");
    console.log("ok  바닥(0.01GB)보다 많이 남았으면 클론한다");
  }
} finally {
  if (saved.pct === undefined) delete process.env.DISK_CRITICAL_PCT; else process.env.DISK_CRITICAL_PCT = saved.pct;
  if (saved.gb === undefined) delete process.env.DISK_CRITICAL_FREE_GB; else process.env.DISK_CRITICAL_FREE_GB = saved.gb;
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => {});
}
