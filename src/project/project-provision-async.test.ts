// #1180 비동기 provision — "세션을 먼저 열고 코드는 뒤따른다. 그동안 세션은 '오는 중'임을 안다."
//   실행: npm run build && node dist/project/project-provision-async.test.js
//   DB·네트워크 불요 — 로컬 bare 레포(file://)로 성공, '레지스트리에 없는 이름'으로 실패를 만든다.
//   ⚠ 구현 재진술 금지 — 관찰 가능한 결과만: 시작 호출의 즉답성 · 마커 파일 · job 상태 · **훅이 만든 통지 문구의 성격**.
//
// 사양 엣지:
//   A1 시작(startProjectProvision)은 clone 을 기다리지 않고 즉시 돌아온다 + 그 시점 상태는 running
//   A2 시작 직후 마커에 repos_pending 이 있다(= 세션이 먼저 떠도 '오는 중'을 안다)
//   A3 그 마커로 세션 프리로드 훅이 '받는 중 + 직접 clone 금지' 통지를 만든다
//   A4 완료되면 repos_pending 이 사라지고 provisioned 가 기록된다 · 통지도 멈춘다
//   A5 실패로 끝나면 pending → repos_failed 로 전환된다(#1155 안내로 이어짐)
//   A6 이미 돌고 있으면 두 번째 시작은 started:false(coalesce) — 같은 프로젝트 중복 clone 금지
//   A7 모르는 프로젝트의 상태는 known:false(호출자가 재시작을 결정) · 완료 후 status 는 결과를 담는다
//   A8 pending 중이어도 **직전 준비 결과(provisioned)는 지워지지 않는다**(재-provision 중 '아무것도 없음' 오독 방지)
//   A9 입력 검증 실패는 유령 pending 을 남기지 않는다(작업 전 검증 → 마커 미기록)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

delete process.env.ITEMS_DATABASE_URL;                 // DB 없음 = 레지스트리 조회 불가(노드 조건)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "prov-async-"));
process.env.TERMINAL_ROOT_SHARED = ROOT;

const { startProjectProvision, projectProvisionStatus } = await import("./project-provision-jobs.js");
const { provisionProjectRepos } = await import("./project-provision.js");
const preloadHook: string = "../../kit/hooks/session-preload.mjs";
const { repoStatusNotice } = await import(preloadHook) as { repoStatusNotice: (cwd: string) => string | null };

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };
const git = (args: string[], cwd?: string): void => {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// 작업이 끝날 때까지 기다린다(상태 폴링 — 실제 호출자와 같은 방식). 상한을 두어 멈춤을 실패로 드러낸다.
async function settled(projectId: number, capMs = 30_000): Promise<ReturnType<typeof projectProvisionStatus>> {
  const until = Date.now() + capMs;
  for (;;) {
    const st = projectProvisionStatus(projectId);
    if (st.state !== "running") return st;
    if (Date.now() > until) throw new Error("provision 이 제한 시간 안에 끝나지 않았다");
    await sleep(50);
  }
}
const projDirOf = (pid: number): string => path.join(ROOT, "project", String(pid));
const markerOf = (pid: number): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(projDirOf(pid), ".lively", "project.json"), "utf8"));

try {
  // 원격 흉내 — 커밋 하나 든 bare 레포(file:// clone, 네트워크·자격 불요).
  const srcWork = path.join(ROOT, "src-work");
  fs.mkdirSync(srcWork, { recursive: true });
  git(["init", "-q", "-b", "main", srcWork]);
  fs.writeFileSync(path.join(srcWork, "README.md"), "hello\n");
  git(["add", "-A"], srcWork);
  git(["commit", "-q", "-m", "init"], srcWork);
  const bare = path.join(ROOT, "origin.git");
  git(["clone", "-q", "--bare", srcWork, bare]);
  const GOOD = { name: "good-repo", worktree: true, inject: { gitUrl: "file://" + bare, secret: null } };
  const BAD = { name: "ghost-repo", worktree: true };   // 레지스트리에 없음 = 환경 실패

  // ── A1·A2·A3 — 즉시 반환 + '오는 중' 표시 + 훅 통지 ──
  {
    const PID = 118001;
    const t0 = Date.now();
    const r = await startProjectProvision(PID, `project/${PID}`, [GOOD], { clone: true, memberId: null });
    const elapsed = Date.now() - t0;
    assert.equal(r.started, true);
    assert.ok(elapsed < 500, `시작 호출이 ${elapsed}ms 걸렸다 — clone 을 기다리면 안 된다`);
    assert.equal(projectProvisionStatus(PID).state, "running", "시작 직후 상태는 running 이어야 한다");
    ok("A1 시작은 clone 을 기다리지 않고 즉답한다");

    // ⚠ 순서 보장 — 시작이 돌아온 **그 시점에** 마커가 있어야 한다(폴링·대기 없이). 호출자는 곧바로 세션을 열고,
    //  그 세션의 프리로드가 바로 이 파일을 읽는다. 여기서 기다려주면 실제로는 존재하는 '안내 없는 창'을 못 잡는다.
    const pend = (markerOf(PID).repos_pending ?? []) as { name: string; expect: string }[];
    assert.equal(pend.length, 1, "시작이 돌아온 시점에 마커의 repos_pending 이 이미 있어야 한다(세션이 먼저 뜨므로)");
    assert.equal(pend[0].name, "good-repo");
    assert.equal(pend[0].expect, path.join(projDirOf(PID), "good-repo"), "곧 코드가 생길 자리를 알려줘야 한다");
    ok("A2 시작 직후 마커에 '준비 중'이 남는다");

    const notice = repoStatusNotice(projDirOf(PID));
    assert.ok(notice, "준비 중인데 세션 통지가 없다");
    assert.ok(notice.includes("good-repo"), "통지에 레포 이름이 없다");
    assert.ok(/clone 하지 마세요/.test(notice), "통지에 '직접 clone 금지' 지시가 없다");
    assert.ok(/받는 중|진행 중/.test(notice), "통지가 '받는 중'임을 말하지 않는다");
    ok("A3 세션 프리로드 훅이 '받는 중 + 직접 clone 금지'를 알린다");

    // ── A4 — 끝나면 pending 소멸 + 결과 기록 + 통지 중단 ──
    const st = await settled(PID);
    assert.equal(st.state, "done");
    assert.equal(st.failed.length, 0);
    assert.equal(st.provisioned.length, 1);
    const m = markerOf(PID);
    assert.ok(!("repos_pending" in m), "완료됐는데 '준비 중' 표시가 남았다");
    assert.ok(Array.isArray(m.provisioned) && (m.provisioned as { name: string }[]).some((x) => x.name === "good-repo"), "완료 결과가 마커에 없다");
    assert.ok(fs.existsSync(path.join(projDirOf(PID), "good-repo", "README.md")), "워크트리에 코드가 없다");
    assert.equal(repoStatusNotice(projDirOf(PID)), null, "준비가 끝났는데도 통지가 뜬다");
    ok("A4 완료되면 '준비 중'이 걷히고 결과가 남는다");
  }

  // ── A5 — 실패로 끝나면 pending → failed 전환 ──
  {
    const PID = 118002;
    await startProjectProvision(PID, `project/${PID}`, [BAD], { clone: true, memberId: null });
    const st = await settled(PID);
    assert.equal(st.state, "done", "레포 실패는 job 실패가 아니다(fail-open — #1155)");
    assert.equal(st.failed.length, 1);
    const m = markerOf(PID);
    assert.ok(!("repos_pending" in m), "실패로 끝났는데 '준비 중'이 남았다");
    assert.ok(Array.isArray(m.repos_failed) && (m.repos_failed as { name: string }[])[0].name === "ghost-repo");
    const notice = repoStatusNotice(projDirOf(PID));
    assert.ok(notice && /준비 실패/.test(notice), "실패 통지로 전환되지 않았다");
    assert.ok(!/받는 중/.test(notice), "끝났는데 아직 '받는 중'이라고 말한다");
    ok("A5 실패로 끝나면 '준비 중' → '준비 실패' 로 전환된다");
  }

  // ── A6 — 같은 프로젝트 중복 시작은 coalesce ──
  {
    const PID = 118003;
    const first = await startProjectProvision(PID, `project/${PID}`, [GOOD], { clone: true, memberId: null });
    const second = await startProjectProvision(PID, `project/${PID}`, [GOOD], { clone: true, memberId: null });
    assert.equal(first.started, true);
    assert.equal(second.started, false, "이미 돌고 있는데 또 시작했다(중복 clone)");
    await settled(PID);
    // 끝난 뒤엔 다시 시작할 수 있다(재시도 경로가 막히면 안 된다).
    assert.equal((await startProjectProvision(PID, `project/${PID}`, [GOOD], { clone: true, memberId: null })).started, true, "끝난 뒤 재시작이 막혔다");
    await settled(PID);
    ok("A6 진행 중 중복 시작은 coalesce · 끝난 뒤엔 재시작 가능");
  }

  // ── A7 — 모르는 프로젝트는 known:false ──
  {
    const st = projectProvisionStatus(999999);
    assert.equal(st.known, false, "시작한 적 없는 프로젝트를 안다고 답한다");
    assert.deepEqual(st.provisioned, []);
    assert.deepEqual(st.failed, []);
    ok("A7 모르는 작업은 known:false 로 답한다");
  }

  // ── A8 — 재-provision 중에도 직전 결과는 보존된다 ──
  {
    const PID = 118004;
    await startProjectProvision(PID, `project/${PID}`, [GOOD], { clone: true, memberId: null });
    await settled(PID);
    const before = markerOf(PID).provisioned as { name: string }[];
    assert.equal(before.length, 1);
    await startProjectProvision(PID, `project/${PID}`, [GOOD], { clone: true, memberId: null });
    const mid = markerOf(PID);   // 시작이 돌아온 시점 = pending 기록 시점
    assert.ok(mid.repos_pending, "재-provision 의 '준비 중' 표시가 없다");
    assert.ok(Array.isArray(mid.provisioned) && (mid.provisioned as { name: string }[]).length === 1, "재-provision 시작이 직전 결과를 지웠다");
    await settled(PID);
    ok("A8 재-provision 중에도 직전 준비 결과가 보존된다");
  }

  // ── A9 — 입력 검증 실패는 유령 '준비 중' 을 남기지 않는다 ──
  {
    const PID = 118005;
    await assert.rejects(() => provisionProjectRepos(PID, `project/${PID}`, [{ name: "a/b" }], { failOpen: true }));
    await assert.rejects(() => startProjectProvision(PID, `project/${PID}`, [{ name: "a/b" }], { clone: true, memberId: null }),
      "비동기 시작도 잘못된 spec 은 백그라운드로 넘기지 말고 호출자에게 던져야 한다");
    const f = path.join(projDirOf(PID), ".lively", "project.json");
    const stale = fs.existsSync(f) ? markerOf(PID).repos_pending : undefined;
    assert.ok(!stale, "검증 실패인데 '준비 중' 표시가 남았다(영영 받는 중이라고 안내된다)");
    ok("A9 검증 실패는 유령 '준비 중' 을 남기지 않는다");
  }

  console.log(`\n${pass} passed`);
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
