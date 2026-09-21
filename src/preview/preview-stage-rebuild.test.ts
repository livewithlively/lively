// 자동 갱신의 «다시 빌드할까»(#4119) — 사양 엣지 표 R1~R14(순수 판정) · I1~I12(실제 git 위의 기록·입력).
//
// 왜 이 테스트가 있나: 종전 주기 점검(preview_reconcile, 5분)은 자동 합치기 stage 를 **바뀐 게 없어도 매번**
//  전량 빌드했다. 빌드는 게이트웨이와 같은 메모리 한도(2GiB) 안에서 돌고, stage 일곱이 한꺼번에 돌자 게이트웨이가
//  1~4분씩 통째로 멈췄다 — 5분마다(2026-09-21 매니지드 실측). 입력이 그대로면 결과도 그대로라 건너뛰는 것이 고침이다.
//  이 판정이 틀리는 두 방향이 모두 사고다: 같은데 «다르다» 면 멈춤이 돌아오고(특히 충돌로 빠진 작업 · 받기 실패),
//  다른데 «같다» 면 사람이 올린 작업이 미리보기에 영영 안 실린다.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stageRebuildVerdict, currentStageInputs, readStageRecord, writeStageRecord, type StageRecord, type StageInputs } from "./preview-stage.js";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), D = "d".repeat(40);
const cur = (over: Partial<StageInputs> = {}): StageInputs =>
  ({ ref: "origin/main", base: A, members: [["project/1", B], ["project/2", C]], ...over });
const rec = (over: Partial<StageRecord> = {}): StageRecord => ({ ...cur(), build_cmd: "npm run build:web", ...over });
const CMD = "npm run build:web";

// ── R. 순수 판정 ──
test("R1 기록이 없으면 한 번 빌드한다(첫 점검 · 이 판 이전 워크트리)", () => {
  assert.deepEqual(stageRebuildVerdict(null, cur(), CMD), { rebuild: true, reason: "no-record" });
});
test("R2 전부 같으면 건너뛴다 — 이게 5분마다의 멈춤을 없애는 행이다", () => {
  assert.deepEqual(stageRebuildVerdict(rec(), cur(), CMD), { rebuild: false, reason: "up-to-date" });
});
test("R3 base_ref 이름이 바뀌면 빌드", () => {
  assert.equal(stageRebuildVerdict(rec(), cur({ ref: "origin/stage" }), CMD).reason, "base-ref-changed");
});
test("R4 base 커밋이 움직이면 빌드(main 에 머지가 들어온 경우)", () => {
  assert.equal(stageRebuildVerdict(rec(), cur({ base: D }), CMD).reason, "base-moved");
});
test("R5 base 가 풀리지 않던 것↔풀리는 것(null 경계)도 변화다", () => {
  assert.equal(stageRebuildVerdict(rec({ base: null }), cur(), CMD).reason, "base-moved");
  assert.equal(stageRebuildVerdict(rec(), cur({ base: null }), CMD).reason, "base-moved");
});
test("R6 합칠 작업이 늘면 빌드", () => {
  assert.equal(stageRebuildVerdict(rec(), cur({ members: [["project/1", B], ["project/2", C], ["project/3", D]] }), CMD).reason, "members-changed");
});
test("R7 합칠 작업이 줄면 빌드", () => {
  assert.equal(stageRebuildVerdict(rec(), cur({ members: [["project/1", B]] }), CMD).reason, "members-changed");
});
test("R8 작업 끝 커밋이 움직이면 빌드 — 사유에 어느 작업인지 싣는다", () => {
  assert.deepEqual(stageRebuildVerdict(rec(), cur({ members: [["project/1", B], ["project/2", D]] }), CMD),
    { rebuild: true, reason: "member-moved:project/2" });
});
test("R9 없는 작업이 계속 없으면(null=null) 건너뛴다 — 지운 브랜치 하나가 매 점검 빌드를 부르면 안 된다", () => {
  const ms: StageInputs["members"] = [["project/1", B], ["gone", null]];
  assert.equal(stageRebuildVerdict(rec({ members: ms }), cur({ members: ms }), CMD).rebuild, false);
});
test("R10 없던 작업이 생기면(null→커밋) 빌드", () => {
  assert.equal(stageRebuildVerdict(rec({ members: [["project/1", B], ["later", null]] }),
    cur({ members: [["project/1", B], ["later", D]] }), CMD).reason, "member-moved:later");
});
test("R11 충돌로 빠졌던 작업도 끝 커밋이 그대로면 건너뛴다 — 판정은 합치기 결과를 보지 않는다", () => {
  // 기록은 «합치려 했던 입력» 이다. 충돌 여부는 기록에도 판정에도 없다 → 같은 입력이면 같은 결과(또 충돌).
  //  이걸 «HEAD 에 들어 있나» 로 재면 충돌 작업은 영영 안 들어 있어 5분마다 빌드한다.
  assert.equal(stageRebuildVerdict(rec(), cur(), CMD).rebuild, false);
});
test("R12 빌드 명령이 바뀌면 빌드(null↔문자열 · 문자열↔문자열)", () => {
  assert.equal(stageRebuildVerdict(rec({ build_cmd: null }), cur(), CMD).reason, "build-cmd-changed");
  assert.equal(stageRebuildVerdict(rec(), cur(), null).reason, "build-cmd-changed");
  assert.equal(stageRebuildVerdict(rec(), cur(), CMD + " && node scripts/build-standalone.mjs").reason, "build-cmd-changed");
});
test("R13 같은 작업·같은 커밋이라도 순서가 바뀌면 빌드 — 머지 순서가 충돌 쪽을 바꾼다", () => {
  assert.equal(stageRebuildVerdict(rec(), cur({ members: [["project/2", C], ["project/1", B]] }), CMD).reason, "members-changed");
});
test("R14 숫자 모양 브랜치 이름도 순서가 보존된다(객체 키였다면 JS 가 몰래 정렬한다)", () => {
  const nine: [string, string | null] = ["9", B], ten: [string, string | null] = ["10", C];
  assert.equal(stageRebuildVerdict(rec({ members: [nine, ten] }), cur({ members: [nine, ten] }), CMD).rebuild, false);
  assert.equal(stageRebuildVerdict(rec({ members: [nine, ten] }), cur({ members: [ten, nine] }), CMD).reason, "members-changed");
});

// ── I. 실제 git 위에서 — 원격(맨 저장소) · base 클론 · stage 워크트리 둘(stage 들이 base 하나를 같이 쓰는 모양) ──
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("I1~I12 기록·지금 입력 — 실제 git", async (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), "stage-rebuild-"));
  try {
    const origin = path.join(tmp, "origin.git"), seed = path.join(tmp, "seed"), base = path.join(tmp, "repos", "lively");
    git(tmp, "init", "--bare", origin);
    git(tmp, "clone", origin, seed);
    const commit = (msg: string): string => { writeFileSync(path.join(seed, "f.txt"), msg + Date.now() + Math.random()); git(seed, "add", "."); git(seed, "commit", "-m", msg); return git(seed, "rev-parse", "HEAD"); };
    commit("base");
    git(seed, "push", "origin", "HEAD:main");
    git(seed, "checkout", "-b", "project/1"); const f1 = commit("feat 1"); git(seed, "push", "origin", "project/1");
    git(seed, "checkout", "main");
    git(tmp, "clone", origin, base);
    const wt = path.join(tmp, "stage", "env-a"), wt2 = path.join(tmp, "stage", "env-b");
    git(base, "worktree", "add", wt, "-b", "stage/env-a", "origin/main");
    git(base, "worktree", "add", wt2, "-b", "stage/env-b", "origin/main");
    const mainTip = git(seed, "rev-parse", "main");

    await t.test("I1 새 워크트리엔 기록이 없다", async () => {
      assert.equal(await readStageRecord(wt), null);
    });

    const now = await currentStageInputs(wt, "origin/main", ["project/1"], new Set());
    await t.test("배선 — 지금 입력이 실제 커밋을 가리킨다(빈 값으로 통과하는 테스트가 아니다)", () => {
      assert.deepEqual({ ref: now.ref, base: now.base, members: now.members }, { ref: "origin/main", base: mainTip, members: [["project/1", f1]] });
      assert.equal(now.fetchError, undefined);
    });

    await t.test("I2 쓰고 읽으면 같다 · I5 준비 직후 입력과 비교하면 건너뛴다", async () => {
      await writeStageRecord(wt, { ref: now.ref, base: now.base, members: now.members, build_cmd: CMD });
      const r = await readStageRecord(wt);
      assert.deepEqual(r, { ref: "origin/main", base: mainTip, members: [["project/1", f1]], build_cmd: CMD });
      assert.deepEqual(stageRebuildVerdict(r, await currentStageInputs(wt, "origin/main", ["project/1"], new Set()), CMD),
        { rebuild: false, reason: "up-to-date" });
    });

    await t.test("I3 기록은 워크트리 밖(전용 git 디렉터리)에 있다 — reset --hard · clean -fdx 뒤에도 남고, 워크트리를 더럽히지 않는다", async () => {
      assert.equal(git(wt, "status", "--porcelain"), "", "기록이 워크트리 안에 생기면 준비의 clean -fd 가 지운다");
      git(wt, "reset", "--hard"); git(wt, "clean", "-fdx");
      assert.notEqual(await readStageRecord(wt), null);
      assert.equal(await readStageRecord(wt2), null, "다른 stage 의 기록과 섞이지 않는다");
    });

    await t.test("I6 원격 작업 브랜치에 새 커밋 → 받아 와서 member-moved", async () => {
      git(seed, "checkout", "project/1"); commit("feat 1 more"); git(seed, "push", "origin", "project/1"); git(seed, "checkout", "main");
      const r = await readStageRecord(wt);
      assert.equal(stageRebuildVerdict(r, await currentStageInputs(wt, "origin/main", ["project/1"], new Set()), CMD).reason,
        "member-moved:project/1");
    });

    await t.test("I7 원격 main 에 새 커밋 → base-moved", async () => {
      commit("main moves"); git(seed, "push", "origin", "main");
      const r = await readStageRecord(wt);
      assert.equal(stageRebuildVerdict(r, await currentStageInputs(wt, "origin/main", ["project/1"], new Set()), CMD).reason, "base-moved");
    });

    await t.test("I8 같은 판(fetched 공유)에서는 저장소를 한 번만 받는다 — 둘째 stage 는 새 커밋을 못 보고, 새 판은 본다", async () => {
      const round = new Set<string>();
      const first = await currentStageInputs(wt, "origin/main", ["project/1"], round);
      assert.equal(round.size, 1, "배선: 첫 호출이 받기를 기록해야 한다");
      git(seed, "checkout", "project/1"); const f3 = commit("feat 1 third"); git(seed, "push", "origin", "project/1"); git(seed, "checkout", "main");
      const second = await currentStageInputs(wt2, "origin/main", ["project/1"], round); // 같은 base 클론을 쓰는 다른 stage
      assert.deepEqual(second.members, first.members, "같은 판에서 또 받았다 — stage 일곱이면 fetch 일곱");
      const next = await currentStageInputs(wt2, "origin/main", ["project/1"], new Set());
      assert.deepEqual(next.members, [["project/1", f3]]);
    });

    await t.test("I10 원격·로컬 모두 없는 작업은 null · I12 형식이 틀린 이름은 입력에서 빠진다", async () => {
      const r = await currentStageInputs(wt, "origin/main", ["project/1", "nope/none", "-x", ""], new Set());
      assert.deepEqual(r.members.map(([b, s]) => [b, s === null ? null : "sha"]), [["project/1", "sha"], ["nope/none", null]]);
    });

    await t.test("I11 로컬에만 있는 작업은 로컬 커밋 · 원격에도 있으면 원격이 먼저(합치기와 같은 자)", async () => {
      git(base, "branch", "local-only", "origin/main");
      git(base, "branch", "project/1", "origin/main"); // 원격보다 뒤처진 같은 이름의 로컬
      const r = await currentStageInputs(wt, "origin/main", ["local-only", "project/1"], new Set());
      assert.deepEqual(r.members, [["local-only", git(base, "rev-parse", "origin/main")], ["project/1", git(base, "rev-parse", "origin/project/1")]]);
    });

    await t.test("I9 원격 받기에 실패해도 던지지 않고 옛 참조로 잰다 — 네트워크가 죽은 판에 다시 빌드하지 않는다", async () => {
      const inputs = await currentStageInputs(wt, "origin/main", ["project/1"], new Set());
      await writeStageRecord(wt, { ...inputs, build_cmd: CMD });
      const url = git(base, "remote", "get-url", "origin");
      git(base, "remote", "set-url", "origin", path.join(tmp, "no-such-remote.git"));
      try {
        const r = await currentStageInputs(wt, "origin/main", ["project/1"], new Set());
        assert.ok(r.fetchError, "받기 실패를 알려야 한다(로그로 남긴다)");
        assert.deepEqual(stageRebuildVerdict(await readStageRecord(wt), r, CMD), { rebuild: false, reason: "up-to-date" });
      } finally { git(base, "remote", "set-url", "origin", url); }
    });

    await t.test("I4 기록이 깨졌거나 모양이 다르면 «기록 없음» — 한 번 빌드로 복구된다", async () => {
      const f = path.join(path.resolve(wt, git(wt, "rev-parse", "--git-dir")), "lively-stage-inputs.json");
      assert.ok(existsSync(f), "배선: 기록 파일이 그 자리에 있어야 이 행이 의미가 있다");
      const good = readFileSync(f, "utf8");
      writeFileSync(f, "{ 반쯤 쓴");
      assert.equal(await readStageRecord(wt), null);
      writeFileSync(f, JSON.stringify({ ref: "origin/main", base: A, members: { "project/1": B }, build_cmd: CMD })); // 객체 모양
      assert.equal(await readStageRecord(wt), null);
      writeFileSync(f, good);
      assert.notEqual(await readStageRecord(wt), null);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
