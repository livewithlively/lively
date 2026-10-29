// 도커 실행면(launch-docker.ts)과 실행면 고르기의 도커 갈래 — 사양 엣지 표의 A · P · G · C · K · S · L · B · R 행 (#5082 2단계).
//  자리 판정(jobPlacement) · 인자(jobContainerArgs) · 정책(jobContainerPolicy)은 순수 함수라 표로 재고, 정책은 **진짜 검사기**(ops/docker-run-guard)에
//  진짜 폴더(임시)로 대 본다 — 붙는 원본이 그 자리가 아니면 거절되는지가 이 실행면의 경계다.
//  띄우기(C)도 진짜 임시 폴더 · 진짜 작업 폴더 확인 · 진짜 검사기를 거친다 — 바꿔 끼운 것은 도커 · 계정 · DB 뿐이고, launchDockerJob 이 정책에
//   어느 사실을 넣었나(뿌리 · 원본 · 자리 · 계정 · 그룹 · env 뿌리 · 네트워크 · 이미지)를 그대로 단언한다 — 정책을 단언하지 않으면 인자를 짓는 코드와
//   정책이 함께 느슨해져도 검사기는 둘이 맞는다고만 본다.
//  판 머리(JOB_CONTAINER_PRELUDE) · ~/.claude 확인 글(claudeDirProbeScript)은 진짜 셸로, 살아 있는 의존의 docker · getent 부르기는 가짜 실행 파일로 돌린다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_JOB_UID, DockerBoxError, JOB_BARE_HOME, JOB_CLAUDE_DIR_ENV, JOB_CLAUDE_TARGET, JOB_CONTAINER_PRELUDE, JOB_LOCALE,
  claudeDirProbeScript, dockerBoxCheck, dockerMemoryMb, dockerPaneView, dockerSurfaceStatus, dockerUnavailableMessage, ensureImageOnce, envFileText,
  gatewayClaudeDirState, jobContainerArgs, jobContainerEnv,
  jobContainerName, jobContainerPolicy, jobIdentities, jobPlacement, killDockerJob, launchDockerJob, liveDockerDeps, probeDockerBox, resetDockerProbesForTest, workDirState,
  type DockerBox, type DockerLaunchDeps, type JobPlacement, type MemberFacts,
} from "./launch-docker.js";
import { jobSurfaceKind, jobsUnavailableMessage, dockerSurfaceBlocker } from "./surface.js";
import { JobLaunchError } from "./launch.js";
import { BOOT_SOURCE } from "./runner.js";
import { HOMELESS_OS_USER } from "./plan.js";
import { computeExecTopology, parseAgentJobs } from "../exec-topology.js";
import { assertSafeDockerRun, DockerRunRejected, type DockerRunPolicy } from "../ops/docker-run-guard.js";
import type { AgentJobRow } from "./store.js";
import type { LivelyUser } from "../context.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};

const SECRET = "bootSecret_Dk9-0123456789abcdefghijklmnopqrstuv";
const SID = "job-42-0a1b2c3d";
const SHARED_GID = 1500;
const GW = { uid: 1001, gid: 1001, home: "/home/lively" };

const row = (over: Partial<AgentJobRow> = {}): AgentJobRow => ({
  id: 42, session_id: SID, cwd: "/work/apps/policy-bot", app_id: "policy-bot", project_id: null,
  account_kind: "subscription", account_member: "kim", requester: "kim", homeless: false,
  ...over,
} as unknown as AgentJobRow);

const box = (over: Partial<DockerBox> = {}): DockerBox => ({
  image: "node:22-bookworm-slim", claudeBin: "/home/lively/.local/share/claude/versions/2.1.312", memMb: 7800, swapLimit: true,
  isolated: true, sharedGid: SHARED_GID, gateway: GW, jobUid: DEFAULT_JOB_UID, ...over,
});
const kim: MemberFacts = { uid: 200401, gid: 200401, home: "/home/box_kim", claude: "ok" };
const okProfile = { dir: "/home/lively/.lively/profiles/kim/claude", root: "/home/lively/.lively/profiles", state: "ok" as const };

// ── A. 실행면 고르기 · 스위치 ────────────────────────────────────────────────────

await t("A1 스위치 — 정확히 docker 만 도커 실행면(앞뒤 공백만 벗긴다) · 대소문자 · 오타는 꺼짐 · host 는 그대로", () => {
  for (const [raw, want] of [["docker", "docker"], [" docker\n", "docker"], ["Docker", "off"], ["dockers", "off"], ["docker1", "off"], ["host", "host"], ["", "off"], [undefined, "off"]] as const) {
    assert.equal(parseAgentJobs(raw), want, JSON.stringify(raw));
  }
});

await t("A2 훅 없는 로컬 배포에 docker → docker · 매니지드(확보 훅)는 늘 broker · 노드 에이전트 · 중계 배포는 none · 세션 spawn 훅은 막지 않는다", () => {
  assert.equal(jobSurfaceKind(computeExecTopology({ LIVELY_AGENT_JOBS: "docker" })), "docker");
  assert.equal(jobSurfaceKind(computeExecTopology({ LIVELY_SESSION_ENSURE: "/x {slug}", LIVELY_TMUX_EXEC: "relay {slug}", LIVELY_AGENT_JOBS: "docker" })), "broker");
  assert.equal(jobSurfaceKind(computeExecTopology({ LIVELY_NODE_TOKEN: "lvk_x", LIVELY_AGENT_JOBS: "docker" })), "none");
  assert.equal(jobSurfaceKind(computeExecTopology({ LIVELY_TMUX_EXEC: "relay {slug}", LIVELY_AGENT_JOBS: "docker" })), "none");
  //  사람 세션을 다른 것에 담아 띄우는 훅은 박스 위 판(tmux)만 막는다 — 도커 판은 그 길을 지나지 않는다.
  assert.equal(jobSurfaceKind(computeExecTopology({ LIVELY_SESSION_SPAWN: "/opt/x/spawn", LIVELY_AGENT_JOBS: "docker" })), "docker");
  assert.equal(jobSurfaceKind(computeExecTopology({ LIVELY_SESSION_SPAWN: "/opt/x/spawn", LIVELY_AGENT_JOBS: "host" })), "none");
});

await t("A3 못 띄우는 배포의 501 문장 — 스위치가 없으면 docker · host 둘 다 말한다 · docker 인데 노드 에이전트면 그 까닭을 말하고 «켜면 된다» 고 하지 않는다", () => {
  const off = jobsUnavailableMessage("none", computeExecTopology({}));
  assert.match(off, /LIVELY_AGENT_JOBS=docker/);
  assert.match(off, /LIVELY_AGENT_JOBS=host/);
  const node = computeExecTopology({ LIVELY_NODE_TOKEN: "lvk_x", LIVELY_AGENT_JOBS: "docker" });
  assert.ok(dockerSurfaceBlocker(node));
  const m = jobsUnavailableMessage("none", node);
  assert.match(m, /셀프호스트 게이트웨이 박스가 아닙니다/);
  assert.doesNotMatch(m, /넣고 게이트웨이를 다시 띄우면/);
});

// ── P. 누구로 · 무엇을 붙이나(jobPlacement) · 정책의 계정(jobIdentities) ─────────────

await t("P1 격리 박스 · 홈 없는 작업 — 박스에 없는 전용 uid + lively-shared(주 그룹) · 홈 없음 · 설정 폴더 없음", () => {
  const p = jobPlacement({ homeless: true, subscription: false, box: box(), member: null, profile: null });
  assert.deepEqual(p, { uid: DEFAULT_JOB_UID, gid: SHARED_GID, groups: [], home: JOB_BARE_HOME, claude: null, runsAs: "job" });
});

await t("P2 격리 박스 · 구독 — 그 계정 uid:gid + lively-shared 더하기 · HOME = 그 계정 홈(빈 tmpfs) · 그 홈의 ~/.claude 하나만(같은 자리 · 뿌리 = 홈 · CLAUDE_CONFIG_DIR 없음)", () => {
  const p = jobPlacement({ homeless: false, subscription: true, box: box(), member: kim, profile: null });
  assert.deepEqual(p, {
    uid: 200401, gid: 200401, groups: [SHARED_GID], home: "/home/box_kim",
    claude: { host: "/home/box_kim/.claude", target: "/home/box_kim/.claude", root: "/home/box_kim", configDirEnv: false }, runsAs: "member",
  });
  //  주 그룹이 이미 lively-shared 면 더하지 않는다.
  assert.deepEqual(jobPlacement({ homeless: false, subscription: true, box: box(), member: { ...kim, gid: SHARED_GID }, profile: null }).groups, []);
});

await t("P3 격리 박스 · 구독 — ~/.claude 가 링크 · 없음 · 남의 것이면 붙이지 않고 까닭을 말한다(상태를 모르면 «없음» 으로 본다)", () => {
  for (const [claude, re] of [["link", /링크/], ["missing", /없습니다/], ["foreign", /소유의 폴더가 아니라/], [null, /없습니다/]] as const) {
    assert.throws(() => jobPlacement({ homeless: false, subscription: true, box: box(), member: { ...kim, claude }, profile: null }), re, String(claude));
  }
});

await t("P4 격리 박스 · API 키(사람이 보낸 작업) — 그 계정 uid:gid + lively-shared · 홈 없음 · 설정 폴더 없음(빈 설정 폴더는 판이 만든다)", () => {
  const p = jobPlacement({ homeless: false, subscription: false, box: box(), member: { ...kim, claude: null }, profile: null });
  assert.deepEqual(p, { uid: 200401, gid: 200401, groups: [SHARED_GID], home: JOB_BARE_HOME, claude: null, runsAs: "member" });
});

await t("P5 격리 박스인데 lively-shared 그룹이 없다 · 사람 작업인데 그 계정 사실이 없다 — 던진다", () => {
  assert.throws(() => jobPlacement({ homeless: true, subscription: false, box: box({ sharedGid: null }), member: null, profile: null }), /lively-shared/);
  assert.throws(() => jobPlacement({ homeless: false, subscription: true, box: box(), member: null, profile: null }), /OS 계정/);
});

await t("P6 비격리 박스 · 구독 — 게이트웨이 uid:gid · 그 사람의 프로필 설정 폴더를 같은 자리에(뿌리 = 프로필 뿌리) · CLAUDE_CONFIG_DIR 로 알린다", () => {
  const p = jobPlacement({ homeless: false, subscription: true, box: box({ isolated: false, sharedGid: null }), member: null, profile: okProfile });
  assert.deepEqual(p, {
    uid: 1001, gid: 1001, groups: [], home: JOB_BARE_HOME,
    claude: { host: okProfile.dir, target: okProfile.dir, root: okProfile.root, configDirEnv: true }, runsAs: "gateway",
  });
});

await t("P7 비격리 박스 · 구독 — 설정 폴더가 없음 · 링크 · 남의 것이면 붙이지 않는다(단일 계정 스위치의 게이트웨이 ~/.claude 포함 — 도커가 그 자리를 root 로 만들지 않게) · 사실이 없으면 던진다", () => {
  const b = box({ isolated: false, sharedGid: null });
  for (const [state, re] of [["missing", /로그인 폴더가 없습니다/], ["link", /링크라/], ["foreign", /소유의 폴더가 아니라/]] as const) {
    assert.throws(() => jobPlacement({ homeless: false, subscription: true, box: b, member: null, profile: { dir: "/home/lively/.claude", root: "/home/lively", state } }), re, state);
  }
  assert.throws(() => jobPlacement({ homeless: false, subscription: true, box: b, member: null, profile: null }), /확인하지 못했습니다/);
  for (const [homeless, subscription] of [[false, false], [true, false]] as const) {
    const p = jobPlacement({ homeless, subscription, box: b, member: null, profile: null });
    assert.equal(p.claude, null);
    assert.equal(p.runsAs, "gateway");
    assert.deepEqual([p.uid, p.gid, p.home], [1001, 1001, JOB_BARE_HOME]);
  }
});

await t("P8 비격리 박스의 게이트웨이가 root(uid 0) — 띄우지 않는다(컨테이너 안은 root 가 아닌 계정)", () => {
  assert.throws(() => jobPlacement({ homeless: false, subscription: false, box: box({ isolated: false, gateway: { uid: 0, gid: 0, home: "/root" } }), member: null, profile: null }), /root/);
});

await t("P9 정책의 계정 · 그룹(jobIdentities) — 정확히 한 계정: 격리 사람 작업은 그 계정만(전용 uid 아님) · 홈 없는 작업은 전용 uid:lively-shared 만 / 그룹 lively-shared 만 · 비격리는 게이트웨이 계정만 / 그룹 없음 · lively-shared 없는 격리 박스의 홈 없는 작업은 계정 없음", () => {
  assert.deepEqual(jobIdentities(box(), kim), { users: ["200401:200401"], groups: [SHARED_GID] });
  assert.deepEqual(jobIdentities(box(), null), { users: [`${DEFAULT_JOB_UID}:${SHARED_GID}`], groups: [SHARED_GID] });
  assert.deepEqual(jobIdentities(box({ isolated: false, sharedGid: null }), kim), { users: ["1001:1001"], groups: [] });
  assert.deepEqual(jobIdentities(box({ sharedGid: null }), null), { users: [], groups: [] });
});

// ── G. 인자 · 정책 · 진짜 검사기 ─────────────────────────────────────────────────

await t("G1 컨테이너 이름 — `lvly-<작업 세션 id>` · job- 꼴이 아니면 던진다(사람 세션 · 앱 서버 이름 · 빈 값 · 옵션 모양)", () => {
  assert.equal(jobContainerName(SID), "lvly-job-42-0a1b2c3d");
  for (const bad of ["box-kim-1", "", "job-0-0a1b2c3d", "job-1-XYZ", "--rm", "lvly-job-42-0a1b2c3d", "job-42-0a1b2c3d;rm"]) assert.throws(() => jobContainerName(bad), /꼴이 아니다/, bad);
});

await t("G2 메모리 — 정책 값 그대로(소수 내림) · 0 · 음수 · NaN 은 도커 메모리 전체(검사기는 --memory 를 꼭 받는다 · 못 읽었으면 256)", () => {
  assert.equal(dockerMemoryMb(3072, 7800), 3072);
  assert.equal(dockerMemoryMb(1.9, 7800), 1);
  for (const v of [0, -5, Number.NaN]) assert.equal(dockerMemoryMb(v, 7800), 7800, String(v));
  assert.equal(dockerMemoryMb(0, 0), 256);
});

await t("G3 env — 부트 넷(비밀 · id · 포트 · 워크스페이스) · HOME · PATH 맨 앞이 하네스 자리 · 로캘 C.UTF-8 · 설정 폴더 확인 env 는 붙일 때만 · CLAUDE_CONFIG_DIR 은 알려야 할 때만", () => {
  const pl = jobPlacement({ homeless: false, subscription: true, box: box(), member: kim, profile: null });
  const e = jobContainerEnv({ jobId: 42, bootSecret: SECRET, port: 18080, slug: "acme", tz: "Asia/Seoul", place: pl });
  assert.equal(e.LVLY_JOB_BOOT, SECRET);
  assert.equal(e.LVLY_JOB_ID, "42");
  assert.equal(e.LVLY_JOB_PORT, "18080");
  assert.equal(e.LVLY_JOB_WS, "acme");
  assert.equal(e.LVLY_TENANT_SLUG, "acme");
  assert.equal(e.HOME, "/home/box_kim");
  assert.equal(e.PATH.split(":")[0], path.dirname(JOB_CLAUDE_TARGET));
  assert.deepEqual([e.LANG, e.LC_ALL, e.LC_CTYPE], [JOB_LOCALE, JOB_LOCALE, JOB_LOCALE]);
  assert.equal(e.TZ, "Asia/Seoul");
  assert.equal(e.LIVELY_SESSION_KIND, "task");
  assert.equal(e[JOB_CLAUDE_DIR_ENV], "/home/box_kim/.claude");
  assert.equal(e.CLAUDE_CONFIG_DIR, undefined);
  const bare = jobContainerEnv({ jobId: 42, bootSecret: SECRET, port: 8080, slug: null, tz: "UTC", place: jobPlacement({ homeless: true, subscription: false, box: box(), member: null, profile: null }) });
  for (const k of ["LVLY_JOB_WS", "LVLY_TENANT_SLUG", JOB_CLAUDE_DIR_ENV, "CLAUDE_CONFIG_DIR"]) assert.equal(bare[k], undefined, k);
  assert.equal(bare.HOME, JOB_BARE_HOME);
  const gw = jobContainerEnv({ jobId: 42, bootSecret: SECRET, port: 8080, slug: null, tz: "UTC", place: jobPlacement({ homeless: false, subscription: true, box: box({ isolated: false }), member: null, profile: { dir: "/home/lively/.claude", root: "/home/lively", state: "ok" } }) });
  assert.equal(gw.CLAUDE_CONFIG_DIR, "/home/lively/.claude");
  assert.equal(gw[JOB_CLAUDE_DIR_ENV], "/home/lively/.claude");
});

await t("G4 env 파일 글 — KEY=VALUE 한 줄씩 · 줄바꿈 · CR · NUL 이 든 값과 꼴 밖 이름은 던진다", () => {
  assert.equal(envFileText({ A: "1", B_2: "x=y z" }), "A=1\nB_2=x=y z\n");
  for (const v of ["a\nB=1", "a\rb", "a\0b"]) assert.throws(() => envFileText({ A: v }), /넘길 수 없습니다/, JSON.stringify(v));
  for (const k of ["1A", "A-B", "", "A B"]) assert.throws(() => envFileText({ [k]: "1" }), /넘길 수 없습니다/, k);
});

/** 진짜 폴더 한 벌 — 검사기 · 작업 폴더 확인이 실제 경로(realpath)로 본다. */
interface Tree { root: string; apps: string; work: string; other: string; shared: string; project: string; homeRoot: string; home: string; profiles: string; profile: string; bin: string; run: string; done: () => void }
function realTree(): Tree {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-")));
  const apps = path.join(root, "apps"), work = path.join(apps, "policy-bot"), other = path.join(apps, "other-app");
  const shared = path.join(root, "shared"), project = path.join(shared, "project", "7");
  const homeRoot = path.join(root, "home"), home = path.join(homeRoot, "box_kim");
  const profiles = path.join(root, "profiles"), profile = path.join(profiles, "kim", "claude");
  const bin = path.join(root, "bin", "claude"), run = path.join(root, "run");
  for (const d of [work, other, project, path.join(home, ".claude"), profile, path.dirname(bin), run]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(other, "secret.txt"), "OTHER");
  fs.writeFileSync(bin, "\x7fELF", { mode: 0o755 });
  return { root, apps, work, other, shared, project, homeRoot, home, profiles, profile, bin, run, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** 한 벌의 자리로 인자 · 정책을 짓는다(정책 사실은 자리 — 원본 · 계정 · 그룹). */
function argsAndPolicy(tr: Tree, place: Pick<JobPlacement, "uid" | "gid" | "groups" | "home" | "claude">, over: { workHost?: string; workdir?: string; ids?: { users: string[]; groups: number[] } } = {}): { args: string[]; policy: DockerRunPolicy } {
  const workdir = over.workdir ?? "/work/apps/policy-bot";
  const envFile = path.join(tr.run, "lvly-job-42-0a1b2c3d.env");
  fs.writeFileSync(envFile, "A=1\n", { mode: 0o600 });
  const args = jobContainerArgs({
    name: "lvly-job-42-0a1b2c3d", image: "node:22-bookworm-slim", labels: { "lvly.agent-job": "1", "lvly.agent-job.id": "42" }, place, memoryMb: 3072,
    workHost: over.workHost ?? tr.work, workdir, claudeBin: tr.bin, envFile,
  });
  const ids = over.ids ?? { users: [`${place.uid}:${place.gid}`], groups: place.groups };
  const policy = jobContainerPolicy({
    image: "node:22-bookworm-slim", work: { root: tr.apps, source: tr.work, target: "/work/apps/policy-bot" },
    claude: place.claude ? { root: place.claude.root, source: place.claude.host, target: place.claude.target } : null,
    claudeBin: tr.bin, envRoot: tr.run, home: place.home, users: ids.users, groups: ids.groups,
  });
  return { args, policy };
}

const subPlace = (tr: Tree): JobPlacement => jobPlacement({ homeless: false, subscription: true, box: box(), member: { ...kim, home: tr.home }, profile: null });

await t("G5 세 자리(격리 구독 · 격리 홈 없음 · 비격리 구독) 모두 진짜 검사기를 지난다 — 이미지 · 판 머리 · 부트가 끝에 그대로", () => {
  const tr = realTree();
  try {
    const places: JobPlacement[] = [
      subPlace(tr),
      jobPlacement({ homeless: true, subscription: false, box: box(), member: null, profile: null }),
      jobPlacement({ homeless: false, subscription: true, box: box({ isolated: false }), member: null, profile: { dir: tr.profile, root: tr.profiles, state: "ok" } }),
    ];
    for (const pl of places) {
      const { args, policy } = argsAndPolicy(tr, pl);
      const r = assertSafeDockerRun(args, policy);
      assert.equal(r.image, "node:22-bookworm-slim");
      assert.deepEqual(r.command, ["sh", "-c", JOB_CONTAINER_PRELUDE, "lvly-job", BOOT_SOURCE]);
    }
  } finally { tr.done(); }
});

await t("G6 인자의 막이 — 분리 · 끝나면 지움 · host 네트워크 · 루트 읽기 전용 · 메모리 = 메모리+스왑 · oom 먼저 · cap 전부 빼기 · no-new-privileges · --init · 그 사용자 · 없는 원본은 실패하는 바인드 셋뿐 · tmpfs exec · 비밀 없음", () => {
  const tr = realTree();
  try {
    const { args } = argsAndPolicy(tr, subPlace(tr));
    const val = (f: string): string[] => args.flatMap((a, i) => (a === f ? [args[i + 1]!] : []));
    for (const f of ["-d", "--rm", "--read-only", "--init"]) assert.ok(args.includes(f), f);
    assert.deepEqual(val("--network"), ["host"]);
    assert.deepEqual(val("--memory"), ["3072m"]);
    assert.deepEqual(val("--memory-swap"), ["3072m"]);
    assert.deepEqual(val("--oom-score-adj"), ["1000"]);
    assert.deepEqual(val("--cap-drop"), ["ALL"]);
    assert.deepEqual(val("--security-opt"), ["no-new-privileges"]);
    assert.deepEqual(val("--user"), ["200401:200401"]);
    assert.deepEqual(val("--group-add"), [String(SHARED_GID)]);
    assert.deepEqual(val("--restart"), ["no"]);
    assert.deepEqual(val("--workdir"), ["/work/apps/policy-bot"]);
    assert.ok(Number(val("--pids-limit")[0]) > 0);
    //  HOME 은 그 사용자의 빈 tmpfs(0700) · /tmp 도 tmpfs · 둘 다 exec(도커 기본 noexec 를 푼다).
    const home = val("--tmpfs").find((v) => v.startsWith(`${tr.home}:`)) ?? "";
    assert.ok(home.includes("mode=0700") && home.includes("uid=200401") && home.includes("gid=200401") && home.split(",").includes("exec"), home);
    assert.ok(val("--tmpfs").some((v) => v.startsWith("/tmp:") && v.split(",").includes("exec")));
    //  붙는 것은 셋뿐 — 작업 폴더(쓰기) · ~/.claude(쓰기) · 하네스 실행 파일(읽기 전용) — 모두 --mount type=bind(-v 는 없는 원본을 root 로 만든다).
    assert.equal(val("--volume").length, 0, "-v 를 쓰지 않는다");
    assert.deepEqual(val("--mount").sort(), [
      `type=bind,src=${tr.work},dst=/work/apps/policy-bot`,
      `type=bind,src=${path.join(tr.home, ".claude")},dst=${path.join(tr.home, ".claude")}`,
      `type=bind,src=${tr.bin},dst=${JOB_CLAUDE_TARGET},readonly`,
    ].sort());
    assert.ok(val("--env-file")[0]!.startsWith(tr.run));
    assert.ok(!args.join("\n").includes("bootSecret"), "부트 비밀은 인자에 없다");
    assert.ok(!args.some((a) => a === "-e" || a === "--env"), "env 는 파일로만");
    //  쉼표 · 따옴표가 든 경로는 --mount 에 못 싣는다 — 짓지 않는다(다시 해도 같다).
    assert.throws(() => jobContainerArgs({ name: "lvly-job-42-0a1b2c3d", image: "i", labels: {}, place: subPlace(tr), memoryMb: 1, workHost: "/srv/a,b", workdir: "/work/apps/policy-bot", claudeBin: tr.bin, envFile: "/e" }),
      (e: unknown) => e instanceof JobLaunchError && !e.transient && /쉼표/.test(e.message));
  } finally { tr.done(); }
});

await t("G7 정책이 막는 것 — 뿌리 밖 · 형제 앱 폴더 · 행과 다른 자리 · 홈 밖 설정 폴더 · 하네스 쓰기 · 다른 이미지 · 정책 밖 그룹 · 정책 밖 계정(gid 0 포함) · 홈이 아닌 tmpfs · docker 소켓", () => {
  const tr = realTree();
  try {
    const pl = subPlace(tr);
    const reject = (args: string[], policy: DockerRunPolicy, re: RegExp, why: string): void => {
      assert.throws(() => assertSafeDockerRun(args, policy), (e: unknown) => e instanceof DockerRunRejected && re.test(e.message), why);
    };
    const base = argsAndPolicy(tr, pl);
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-out-")));
    try {
      reject(argsAndPolicy(tr, pl, { workHost: outside }).args, base.policy, /마운트 원본/, "apps 뿌리 밖의 폴더를 작업 폴더로");
      reject(argsAndPolicy(tr, pl, { workHost: tr.other }).args, base.policy, /마운트 원본/, "같은 뿌리 안의 형제 앱 폴더");
      reject(argsAndPolicy(tr, pl, { workHost: tr.apps }).args, base.policy, /마운트 원본/, "apps 뿌리 자체");
      reject(argsAndPolicy(tr, pl, { workdir: "/work/apps/other-app" }).args, base.policy, /마운트 원본/, "행의 작업 폴더가 아닌 자리에");
      const link = path.join(tr.apps, "sneaky");
      fs.symlinkSync(outside, link);
      reject(argsAndPolicy(tr, pl, { workHost: link }).args, base.policy, /마운트 원본/, "뿌리 안 링크 → 밖");
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
    const { args, policy } = base;
    const swap = (from: string, to: string): string[] => { assert.ok(args.includes(from), from); return args.map((a) => (a === from ? to : a)); };
    const claudeMount = `type=bind,src=${path.join(tr.home, ".claude")},dst=${path.join(tr.home, ".claude")}`;
    reject(swap(claudeMount, `type=bind,src=${tr.root},dst=${path.join(tr.home, ".claude")}`), policy, /마운트 원본/, "홈 밖을 설정 폴더 자리에");
    reject(swap(claudeMount, `type=bind,src=${tr.home},dst=${path.join(tr.home, ".claude")}`), policy, /마운트 원본/, "홈 전체를 설정 폴더 자리에");
    reject(swap(`type=bind,src=${tr.bin},dst=${JOB_CLAUDE_TARGET},readonly`, `type=bind,src=${tr.bin},dst=${JOB_CLAUDE_TARGET}`), policy, /마운트 원본/, "하네스 실행 파일을 쓰기로");
    reject(swap("node:22-bookworm-slim", "evil:latest"), policy, /이미지/, "다른 이미지");
    reject(swap(String(SHARED_GID), "27"), policy, /group-add/, "정책 밖 그룹(sudo 등)");
    reject(swap("200401:200401", "200402:200401"), policy, /돌 수 있는 계정이 아닙니다/, "정책 밖 계정");
    reject(swap("200401:200401", "200401:0"), policy, /돌 수 있는 계정이 아닙니다/, "gid 0");
    reject(swap(`${pl.home}:rw,exec,nosuid,nodev,size=256m,mode=0700,uid=200401,gid=200401`, "/etc:rw,exec,nosuid,nodev,size=256m,mode=0700,uid=200401,gid=200401"), policy, /tmpfs 자리/, "홈이 아닌 tmpfs");
    reject([...args.slice(0, 1), "--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock", ...args.slice(1)], policy, /docker 소켓/, "docker 소켓");
  } finally { tr.done(); }
});

await t("G8 정책 — 행의 작업 폴더가 두 꼴(앱 폴더 · 프로젝트 폴더) 밖이면 짓지 않는다", () => {
  const mk = (target: string): DockerRunPolicy => jobContainerPolicy({ image: "i", work: { root: "/srv", source: "/srv/x", target }, claude: null, claudeBin: "/b", envRoot: "/r", home: JOB_BARE_HOME, users: ["1:1"], groups: [] });
  for (const bad of ["/work/apps/policy-bot/sub", "/work/apps/../etc", "/srv/lively/apps/x", "/work/shared/project/0", "/work/shared"]) assert.throws(() => mk(bad), /꼴이 아닙니다/, bad);
  assert.doesNotThrow(() => mk("/work/shared/project/12"));
});

// ── C. 띄우기(진짜 폴더 · 진짜 작업 폴더 확인 · 진짜 검사기 — 바꿔 끼운 것은 도커 · 계정 · DB) ──

interface Rec { calls: string[]; envText: string | null; args: string[] | null; policy: DockerRunPolicy | null; guard: string | null; removedEnv: string[] }
function fakeDeps(tr: Tree, over: Partial<DockerLaunchDeps> = {}): { d: DockerLaunchDeps; rec: Rec } {
  const rec: Rec = { calls: [], envText: null, args: null, policy: null, guard: null, removedEnv: [] };
  const c = (s: string): void => { rec.calls.push(s); };
  const d: DockerLaunchDeps = {
    box: async () => { c("box"); return box({ claudeBin: tr.bin }); },
    accountUser: async (m) => { c(`accountUser:${m}`); return { userId: m, scopes: [] } as unknown as LivelyUser; },
    ensureOsUser: async (u) => { c(`ensureOsUser:${u.userId}`); return `box_${u.userId}`; },
    memberFacts: async (osUser, want) => { c(`memberFacts:${osUser}:${want}`); return { ...kim, home: tr.home, claude: want ? "ok" : null }; },
    profileDir: async (u) => { c(`profileDir:${u.userId}`); return { dir: tr.profile, root: tr.profiles, state: "ok" }; },
    resolveWork: async (_u, dir, osUser) => {
      c(`resolveWork:${dir.root}/${dir.sub}:${osUser}`);
      const base = dir.root === "apps" ? tr.apps : tr.shared;
      return { abs: path.join(base, dir.sub), base };
    },
    mkdirWork: async (osUser, abs, shared) => { c(`mkdirWork:${osUser}:${path.relative(tr.root, abs)}:${shared}`); },
    checkWork: async (work) => { c("checkWork"); return workDirState(work); },
    memoryMaxMb: async () => { c("memoryMaxMb"); return 3072; },
    ensureImage: async (image) => { c(`ensureImage:${image}`); },
    writeEnvFile: async (name, text) => {
      c(`writeEnvFile:${name}`); rec.envText = text;
      const file = path.join(tr.run, `${name}.env`);
      fs.writeFileSync(file, text, { mode: 0o600 });
      return { file, root: tr.run };
    },
    removeEnvFile: async (file) => { c("removeEnvFile"); rec.removedEnv.push(file); fs.rmSync(file, { force: true }); },
    //  진짜 검사기를 거친다 — launchDockerJob 이 지은 인자와 정책이 서로 맞는지가 여기서 갈린다.
    run: async (args, policy) => { c("run"); rec.args = args; rec.policy = policy; assertSafeDockerRun(args, policy); rec.guard = "ok"; },
    remove: async (name) => { c(`remove:${name}`); },
    tz: async () => "Asia/Seoul",
    slug: () => null,
    port: () => 8080,
    ...over,
  };
  return { d, rec };
}
const failsWith = async (p: Promise<unknown>, test: (e: JobLaunchError) => void): Promise<void> => {
  let err: unknown = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err instanceof JobLaunchError, `JobLaunchError 여야 한다: ${String(err)}`);
  test(err as JobLaunchError);
};
const mounts = (args: string[]): string[] => args.flatMap((a, i) => (a === "--mount" ? [args[i + 1]!] : []));
const userOf = (args: string[]): string => args[args.indexOf("--user") + 1]!;

await t("C1 격리 박스 · 구독 — 순서(도커 → 상한 → 그 계정 → ~/.claude → 작업 폴더 만들고 확인 → 이미지 → env → 작업 폴더 다시 확인 → 띄움 → env 지움) · 진짜 검사기 통과 · 정책 사실(원본 · 자리 · 계정 · 그룹 · env 뿌리 · tmpfs · 네트워크 · 이미지 · 루트 읽기 전용 · 포트 없음)", async () => {
  const tr = realTree();
  try {
    const { d, rec } = fakeDeps(tr);
    const r = await launchDockerJob(row(), SECRET, d);
    assert.equal(r.container, "lvly-job-42-0a1b2c3d");
    assert.deepEqual(rec.calls, [
      "box", "memoryMaxMb", "accountUser:kim", "ensureOsUser:kim", "memberFacts:box_kim:true",
      "resolveWork:apps/policy-bot:box_kim", "mkdirWork:box_kim:apps/policy-bot:false", "checkWork", "ensureImage:node:22-bookworm-slim",
      "writeEnvFile:lvly-job-42-0a1b2c3d", "checkWork", "run", "removeEnvFile",
    ]);
    assert.equal(rec.guard, "ok", "진짜 검사기를 지났다");
    assert.ok(rec.envText!.includes(`LVLY_JOB_BOOT=${SECRET}\n`));
    assert.ok(!rec.args!.join("\n").includes(SECRET), "비밀은 인자에 없다");
    const p = rec.policy!;
    assert.deepEqual(p.binds.map((b) => [b.root, b.source, b.rw]), [[tr.apps, tr.work, true], [tr.home, path.join(tr.home, ".claude"), true], [tr.bin, tr.bin, false]]);
    //  자리는 정확히 그 하나 — 다른 앱 · 홈 · 하네스 자리 · 루트는 꼴 밖.
    const [workBind, claudeBind, binBind] = p.binds;
    assert.deepEqual(["/work/apps/policy-bot", "/work/apps/other-app", "/work/apps", "/", path.join(tr.home, ".claude")].map((s) => workBind!.targets!.test(s)), [true, false, false, false, false]);
    assert.deepEqual([path.join(tr.home, ".claude"), tr.home, "/work/apps/policy-bot", "/"].map((s) => claudeBind!.targets!.test(s)), [true, false, false, false]);
    assert.deepEqual([JOB_CLAUDE_TARGET, "/usr/local/bin/claude", "/"].map((s) => binBind!.targets!.test(s)), [true, false, false]);
    assert.deepEqual(p.users, ["200401:200401"]);
    assert.deepEqual(p.groupAdds, [SHARED_GID]);
    assert.deepEqual(p.envFiles, [tr.run]);
    assert.deepEqual(p.tmpfs, ["/tmp", tr.home]);
    assert.deepEqual(p.tmpfsExec, ["/tmp", tr.home]);
    assert.deepEqual(p.networks, ["host"]);
    assert.deepEqual(p.images, ["node:22-bookworm-slim"]);
    assert.equal(p.readOnly, true);
    assert.equal(p.publish, false);
    assert.deepEqual([p.volumes, p.envKeys, p.addHosts], [undefined, undefined, undefined], "이름 없는 볼륨 · -e · --add-host 를 받지 않는다");
    assert.equal(userOf(rec.args!), "200401:200401");
    assert.deepEqual(rec.removedEnv, [path.join(tr.run, "lvly-job-42-0a1b2c3d.env")]);
    assert.equal(fs.readdirSync(tr.run).length, 0, "env 파일이 남지 않는다");
  } finally { tr.done(); }
});

await t("C2 격리 박스 · 홈 없는 작업 — 그 사람의 계정 · 홈을 쓰지 않는다 · 앱 자리는 전용 계정 기준 · 폴더는 게이트웨이가 2775 로 · 전용 uid · 정책 계정은 전용 uid 하나", async () => {
  const tr = realTree();
  try {
    const { d, rec } = fakeDeps(tr);
    await launchDockerJob(row({ homeless: true, account_kind: "api_key", account_member: null, requester: "app-srv-member" } as Partial<AgentJobRow>), SECRET, d);
    assert.ok(!rec.calls.some((c) => c.startsWith("ensureOsUser") || c.startsWith("memberFacts") || c.startsWith("accountUser") || c.startsWith("profileDir")), rec.calls.join(" "));
    assert.ok(rec.calls.includes(`resolveWork:apps/policy-bot:${HOMELESS_OS_USER}`));
    assert.ok(rec.calls.includes("mkdirWork:null:apps/policy-bot:true"));
    assert.equal(rec.guard, "ok");
    assert.equal(userOf(rec.args!), `${DEFAULT_JOB_UID}:${SHARED_GID}`);
    assert.deepEqual(rec.policy!.users, [`${DEFAULT_JOB_UID}:${SHARED_GID}`]);
    assert.deepEqual(rec.policy!.groupAdds, [SHARED_GID], "정책 그룹은 박스 사실(lively-shared) — 자리 판정의 그룹이 아니다");
    assert.ok(!mounts(rec.args!).some((a) => a.includes(".claude")), "설정 폴더를 붙이지 않는다");
    assert.equal(rec.policy!.binds.length, 2);
  } finally { tr.done(); }
});

await t("C3 비격리 박스 · 구독 — OS 계정을 만들지 않고 그 사람의 프로필 폴더를 붙인다 · 게이트웨이 uid · 정책의 설정 폴더 = 프로필 뿌리 아래 그 폴더 하나", async () => {
  const tr = realTree();
  try {
    const { d, rec } = fakeDeps(tr, { box: async () => box({ isolated: false, sharedGid: null, claudeBin: tr.bin }) });
    await launchDockerJob(row(), SECRET, d);
    assert.ok(!rec.calls.some((c) => c.startsWith("ensureOsUser") || c.startsWith("memberFacts")));
    assert.ok(rec.calls.includes("profileDir:kim"));
    assert.ok(rec.calls.includes("resolveWork:apps/policy-bot:null"));
    assert.ok(rec.calls.includes("mkdirWork:null:apps/policy-bot:false"));
    assert.ok(rec.envText!.includes(`CLAUDE_CONFIG_DIR=${tr.profile}\n`));
    assert.equal(rec.guard, "ok");
    assert.equal(userOf(rec.args!), "1001:1001");
    assert.deepEqual(rec.policy!.users, ["1001:1001"]);
    assert.deepEqual(rec.policy!.groupAdds, []);
    assert.deepEqual(rec.policy!.binds[1]!.root, tr.profiles);
    assert.deepEqual(rec.policy!.binds[1]!.source, tr.profile);
  } finally { tr.done(); }
});

await t("C4 상한 0 — 도커 메모리 전체로 건다(검사기는 --memory 를 꼭 받는다) · 스왑 상한을 못 거는 박스여도 상한 0 이면 띄운다", async () => {
  const tr = realTree();
  try {
    const { d, rec } = fakeDeps(tr, { memoryMaxMb: async () => 0, box: async () => box({ swapLimit: false, memMb: 5000, claudeBin: tr.bin }) });
    await launchDockerJob(row(), SECRET, d);
    assert.equal(rec.args![rec.args!.indexOf("--memory") + 1], "5000m");
    assert.equal(rec.args![rec.args!.indexOf("--memory-swap") + 1], "5000m");
  } finally { tr.done(); }
});

await t("C5 다시 해도 안 될 것 — 부수효과(작업 폴더 · env 파일 · 띄우기) 없이 JobLaunchError(일시 아님)", async () => {
  const cases: Array<[string, Partial<AgentJobRow>, (tr: Tree) => Partial<DockerLaunchDeps>, RegExp]> = [
    ["세션 id 없음", { session_id: null } as Partial<AgentJobRow>, () => ({}), /세션 id/],
    ["세션 id 꼴 밖", { session_id: "box-kim-1" } as Partial<AgentJobRow>, () => ({}), /세션 id/],
    ["홈 없는 작업 · 구독", { homeless: true } as Partial<AgentJobRow>, () => ({}), /API 키/],
    ["홈 없는 작업 · 프로젝트", { homeless: true, account_kind: "api_key", project_id: 7, cwd: "/work/shared/project/7" } as Partial<AgentJobRow>, () => ({}), /프로젝트/],
    ["실행 계정 없음", { account_member: null } as Partial<AgentJobRow>, () => ({}), /실행 계정/],
    ["작업 폴더 꼴 밖", { cwd: "/work/apps/policy-bot/../../etc" } as Partial<AgentJobRow>, () => ({}), /작업 폴더 꼴/],
    ["스왑 상한 못 걺 · 상한 있음", {}, (tr) => ({ box: async () => box({ swapLimit: false, claudeBin: tr.bin }) }), /스왑 상한/],
    ["~/.claude 링크", {}, (tr) => ({ memberFacts: async () => ({ ...kim, home: tr.home, claude: "link" }) }), /링크/],
    ["lively-shared 없음", {}, (tr) => ({ box: async () => box({ sharedGid: null, claudeBin: tr.bin }) }), /lively-shared/],
    ["비격리 · 게이트웨이 설정 폴더 없음", {}, (tr) => ({ box: async () => box({ isolated: false, sharedGid: null, claudeBin: tr.bin }), profileDir: async () => ({ dir: path.join(tr.root, "gw-home", ".claude"), root: path.join(tr.root, "gw-home"), state: "missing" }) }), /로그인 폴더가 없습니다/],
    ["작업 폴더 자리가 행과 다름(형제)", {}, (tr) => ({ resolveWork: async () => ({ abs: tr.other, base: tr.apps }) }), /맞지 않습니다/],
    ["작업 폴더 자리가 뿌리 밖", {}, (tr) => ({ resolveWork: async () => ({ abs: "/etc", base: tr.apps }) }), /맞지 않습니다/],
    ["검사기 거절", {}, () => ({ run: async () => { throw new DockerRunRejected("모르는 깃발입니다: --privileged"); } }), /컨테이너 인자를 거절/],
  ];
  for (const [why, over, dover, re] of cases) {
    const tr = realTree();
    try {
      const { d, rec } = fakeDeps(tr, dover(tr));
      await failsWith(launchDockerJob(row(over), SECRET, d), (e) => {
        assert.equal(e.transient, false, why);
        assert.match(e.message, re, why);
        //  작업 오류는 앱이 받는다 — 박스 위 경로는 싣지 않는다(게이트웨이 로그에만).
        assert.ok(!e.message.includes(tr.root), `${why}: ${e.message}`);
        if (why === "작업 폴더 자리가 뿌리 밖") assert.ok(!e.message.includes("/etc"), e.message);
      });
      if (why !== "검사기 거절") assert.ok(!rec.calls.some((c) => c.startsWith("mkdirWork") || c.startsWith("writeEnvFile") || c === "run"), `${why}: ${rec.calls.join(" ")}`);
      else assert.equal(rec.removedEnv.length, 1, "거절돼도 env 파일은 지운다");
    } finally { tr.done(); }
  }
});

await t("C6 인프라가 잠깐 막힘 — 일시(transient) 실패 · 단계 글 · 비밀은 글에 없다 · 띄우기 실패여도 env 파일은 지운다", async () => {
  const boom = (m: string) => async (): Promise<never> => { throw new Error(m); };
  const cases: Array<[string, Partial<DockerLaunchDeps>, RegExp]> = [
    ["도커", { box: boom("도커에 닿지 못했습니다") }, /작업 컨테이너를 확보하지 못했습니다: 도커/],
    ["정책", { memoryMaxMb: boom("db down") }, /작업 메모리 상한을 지금 걸 수 없습니다/],
    ["OS 계정 던짐", { ensureOsUser: boom("useradd 실패") }, /OS 계정을 준비하지 못했습니다/],
    ["OS 계정 null", { ensureOsUser: async () => null }, /게이트웨이 계정으로는 띄우지 않는다/],
    ["계정 사실", { memberFacts: boom("id 실패") }, /OS 계정을 준비하지 못했습니다/],
    ["작업 폴더 자리", { resolveWork: boom("EACCES") }, /작업 폴더를 만들지 못했습니다/],
    ["작업 폴더 만들기", { mkdirWork: boom("EACCES") }, /작업 폴더를 만들지 못했습니다/],
    ["작업 폴더 확인", { checkWork: boom("EACCES") }, /작업 폴더를 만들지 못했습니다/],
    ["작업 폴더가 만든 뒤에도 없음", { checkWork: async () => "missing" as const }, /만든 뒤에도 없습니다/],
    ["이미지", { ensureImage: boom("pull 실패") }, /작업 컨테이너를 확보하지 못했습니다: pull/],
    ["띄우기", { run: boom(`docker run 실패: Command failed: docker run ... LVLY_JOB_BOOT=${SECRET}`) }, /작업 컨테이너를 확보하지 못했습니다/],
  ];
  for (const [why, over, re] of cases) {
    const tr = realTree();
    try {
      const { d, rec } = fakeDeps(tr, over);
      await failsWith(launchDockerJob(row(), SECRET, d), (e) => {
        assert.equal(e.transient, true, why);
        assert.match(e.message, re, why);
        assert.ok(!e.message.includes(SECRET), `${why}: 비밀이 글에 남았다`);
      });
      if (why === "띄우기") { assert.equal(rec.removedEnv.length, 1, "띄우기 실패여도 env 파일을 지운다"); assert.equal(fs.readdirSync(tr.run).length, 0); }
    } finally { tr.done(); }
  }
});

await t("C7 비활성 실행 계정 — accountUser 가 던진 JobLaunchError 를 그대로(일시 아님) · OS 계정을 만들지 않는다", async () => {
  const tr = realTree();
  try {
    const { d, rec } = fakeDeps(tr, { accountUser: async () => { throw new JobLaunchError("실행 계정(kim)이 활성 사람 구성원이 아닙니다"); } });
    await failsWith(launchDockerJob(row(), SECRET, d), (e) => { assert.equal(e.transient, false); assert.match(e.message, /활성 사람 구성원/); });
    assert.ok(!rec.calls.some((c) => c.startsWith("ensureOsUser")));
  } finally { tr.done(); }
});

await t("C8 프로젝트 폴더 작업(격리 · API 키) — 공유 자리의 project/<n> 을 그 계정이 만들고 같은 자리(/work/shared/project/<n>)에 붙인다 · ~/.claude 는 보지 않는다 · 정책 뿌리 = 공유 자리", async () => {
  const tr = realTree();
  try {
    const { d, rec } = fakeDeps(tr);
    await launchDockerJob(row({ account_kind: "api_key", account_member: null, project_id: 7, cwd: "/work/shared/project/7" } as Partial<AgentJobRow>), SECRET, d);
    assert.ok(rec.calls.includes("memberFacts:box_kim:false"));
    assert.ok(rec.calls.includes("resolveWork:shared/project/7:box_kim"));
    assert.equal(rec.guard, "ok");
    assert.ok(mounts(rec.args!).includes(`type=bind,src=${tr.project},dst=/work/shared/project/7`));
    assert.deepEqual([rec.policy!.binds[0]!.root, rec.policy!.binds[0]!.source], [tr.shared, tr.project]);
    assert.equal(rec.args![rec.args!.indexOf("--workdir") + 1], "/work/shared/project/7");
  } finally { tr.done(); }
});

await t("C9 작업 폴더가 링크(다른 앱 폴더를 가리킴) · 폴더가 아님 — 붙이지 않는다(일시 아님) · env 파일 · 띄우기 없음", async () => {
  for (const kind of ["link", "file"] as const) {
    const tr = realTree();
    try {
      fs.rmSync(tr.work, { recursive: true, force: true });
      if (kind === "link") fs.symlinkSync(tr.other, tr.work); else fs.writeFileSync(tr.work, "x");
      const { d, rec } = fakeDeps(tr);
      await failsWith(launchDockerJob(row(), SECRET, d), (e) => {
        assert.equal(e.transient, false, kind);
        assert.match(e.message, kind === "link" ? /링크이거나 실제 경로가 그 자리가 아니라/ : /폴더가 아닌 것/);
      });
      assert.ok(!rec.calls.some((c) => c.startsWith("writeEnvFile") || c === "run"), rec.calls.join(" "));
    } finally { tr.done(); }
  }
});

await t("C11 만든 뒤 확인을 지난 작업 폴더를 이미지 받는 사이 링크로 바꿔치기 — 띄우기 바로 앞 확인이 거절한다(일시 아님) · docker run 없음 · env 파일은 지운다 · 작업 오류에 박스 위 경로가 없다", async () => {
  const tr = realTree();
  try {
    const { d, rec } = fakeDeps(tr, {
      //  첫 작업의 이미지 받기 동안 같은 그룹 구성원이 앱 폴더 이름을 형제 앱 폴더를 가리키는 링크로 바꾼다.
      ensureImage: async () => { rec.calls.push("ensureImage"); fs.rmSync(tr.work, { recursive: true, force: true }); fs.symlinkSync(tr.other, tr.work); },
    });
    await failsWith(launchDockerJob(row(), SECRET, d), (e) => {
      assert.equal(e.transient, false);
      assert.match(e.message, /링크이거나 실제 경로가 그 자리가 아니라/);
      assert.match(e.message, /\/work\/apps\/policy-bot/);
      assert.ok(!e.message.includes(tr.root), `박스 위 경로가 글에 있다: ${e.message}`);
    });
    assert.ok(!rec.calls.includes("run"), rec.calls.join(" "));
    assert.equal(rec.calls.filter((c) => c === "checkWork").length, 2);
    assert.equal(rec.removedEnv.length, 1, "env 파일을 지운다");
    assert.equal(fs.readdirSync(tr.run).length, 0);
  } finally { tr.done(); }
});

await t("C10 작업 폴더 확인(workDirState) — 실제 폴더 ok · 링크 · 뿌리 위 링크는 괜찮다(실제 경로로 잰다) · 뿌리 밖 자리 · 없음", async () => {
  const tr = realTree();
  try {
    assert.equal(await workDirState({ abs: tr.work, base: tr.apps }), "ok");
    const alias = path.join(tr.root, "apps-alias");
    fs.symlinkSync(tr.apps, alias);
    assert.equal(await workDirState({ abs: path.join(alias, "policy-bot"), base: alias }), "ok", "뿌리 자체가 링크인 것(맥 /var)은 괜찮다");
    fs.symlinkSync(tr.other, path.join(tr.apps, "linked"));
    assert.equal(await workDirState({ abs: path.join(tr.apps, "linked"), base: tr.apps }), "link");
    assert.equal(await workDirState({ abs: tr.other, base: tr.work }), "link", "뿌리 밖");
    assert.equal(await workDirState({ abs: path.join(tr.apps, "none"), base: tr.apps }), "missing");
    //  뿌리 안 중간 자리가 링크(shared/project → 다른 곳) — 끝 자리는 실제 폴더라 lstat 으로는 안 보인다 · 실제 경로로 잰다.
    const elsewhere = path.join(tr.root, "elsewhere");
    fs.mkdirSync(path.join(elsewhere, "7"), { recursive: true });
    fs.rmSync(path.join(tr.shared, "project"), { recursive: true, force: true });
    fs.symlinkSync(elsewhere, path.join(tr.shared, "project"));
    assert.equal(await workDirState({ abs: path.join(tr.shared, "project", "7"), base: tr.shared }), "link", "중간 링크");
  } finally { tr.done(); }
});

// ── K. 걷기 · 판의 자리 ────────────────────────────────────────────────────────

await t("K1 걷기 — job- 꼴이면 lvly-<세션> 을 지운다 · 꼴 밖이면 docker 를 부르지 않고 던진다 · 지우기 실패는 그대로 던진다", async () => {
  const seen: string[] = [];
  await killDockerJob(SID, { remove: async (n) => { seen.push(n); } });
  assert.deepEqual(seen, ["lvly-job-42-0a1b2c3d"]);
  for (const bad of ["box-kim-1", "", "--all"]) await assert.rejects(killDockerJob(bad, { remove: async (n) => { seen.push(n); } }), /꼴이 아니다/);
  assert.equal(seen.length, 1);
  await assert.rejects(killDockerJob(SID, { remove: async () => { throw new Error("permission denied"); } }), /permission denied/);
});

await t("K2 판의 첫 말 자리 — 작업 폴더는 행의 작업 폴더 그대로(같은 자리에 붙인다) · 게이트웨이 = 이 박스 루프백 포트 · 워크스페이스", () => {
  assert.deepEqual(dockerPaneView({ cwd: "/work/apps/policy-bot" }, { port: 18080, slug: "acme" }), { cwd: "/work/apps/policy-bot", gateway: "http://127.0.0.1:18080", workspace: "acme" });
  assert.deepEqual(dockerPaneView({ cwd: "/work/shared/project/7" }, { port: 8080, slug: null }), { cwd: "/work/shared/project/7", gateway: "http://127.0.0.1:8080", workspace: null });
});

// ── S. 진짜 셸 — 판 머리 · 설정 폴더 확인 ──────────────────────────────────────────

function sh(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn("sh", args, { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "", err = "";
    p.stdout.on("data", (x) => { out += x; }); p.stderr.on("data", (x) => { err += x; });
    const kill = setTimeout(() => p.kill("SIGKILL"), 20_000);
    p.on("close", (code) => { clearTimeout(kill); resolve({ code, out, err }); });
  });
}
//  판 머리 뒤의 «부트» 자리에 넣을 작은 node 글 — 설정 폴더 확인 env 가 지워졌는지 · umask 를 찍는다.
const PROBE_BOOT = `process.stdout.write("booted:" + (process.env.${JOB_CLAUDE_DIR_ENV} === undefined ? "clean" : "leaked") + ":umask=" + process.umask().toString(8))`;
const envFor = (over: Record<string, string>): NodeJS.ProcessEnv => ({ PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, ...over });

await t("S1 판 머리 — 붙인 설정 폴더가 없으면(API 키 · 홈 없음) 곧바로 부트 · 이 계정 소유 폴더면 부트 · 확인 env 는 부트에 넘기지 않는다 · umask 002(공유 · 앱 폴더에 남는 것을 lively-shared 가 고친다)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-c-"));
  try {
    const a = await sh(["-c", JOB_CONTAINER_PRELUDE, "lvly-job", PROBE_BOOT], envFor({}));
    assert.equal(a.code, 0, a.err);
    assert.equal(a.out, "booted:clean:umask=2");
    const b = await sh(["-c", JOB_CONTAINER_PRELUDE, "lvly-job", PROBE_BOOT], envFor({ [JOB_CLAUDE_DIR_ENV]: dir }));
    assert.equal(b.code, 0, b.err);
    assert.equal(b.out, "booted:clean:umask=2");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await t("S2 판 머리 — 붙인 자리가 폴더가 아니거나(파일) 없으면 부트하지 않고 3 · 까닭을 stderr 로", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-c-"));
  try {
    const file = path.join(dir, "f");
    fs.writeFileSync(file, "x");
    for (const target of [file, path.join(dir, "missing")]) {
      const r = await sh(["-c", JOB_CONTAINER_PRELUDE, "lvly-job", PROBE_BOOT], envFor({ [JOB_CLAUDE_DIR_ENV]: target }));
      assert.equal(r.code, 3, target);
      assert.equal(r.out, "", "부트하지 않았다");
      assert.match(r.err, /이 계정의 폴더가 아닙니다/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await t("S3 판 머리 — 남의 소유 폴더(/ 는 root 소유)면 3(시험 계정이 root 가 아닐 때)", async () => {
  if (process.getuid?.() === 0) return;
  const r = await sh(["-c", JOB_CONTAINER_PRELUDE, "lvly-job", PROBE_BOOT], envFor({ [JOB_CLAUDE_DIR_ENV]: "/" }));
  assert.equal(r.code, 3);
  assert.equal(r.out, "");
});

await t("S4 ~/.claude 확인 글(그 계정 권한으로 돈다) — 폴더 ok · 링크 link(폴더를 가리켜도) · 없음 missing · 파일 foreign · 남의 소유 foreign · 꼴 밖 경로는 짓지 않는다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-h-"));
  try {
    const ok = path.join(dir, "ok"), link = path.join(dir, "link"), file = path.join(dir, "file");
    fs.mkdirSync(ok);
    fs.symlinkSync(ok, link);
    fs.writeFileSync(file, "x");
    const run = async (p: string): Promise<string> => (await sh(["-c", claudeDirProbeScript(p)], envFor({}))).out.trim();
    assert.equal(await run(ok), "ok");
    assert.equal(await run(link), "link");
    assert.equal(await run(path.join(dir, "none")), "missing");
    assert.equal(await run(file), "foreign");
    if (process.getuid?.() !== 0) assert.equal(await run("/usr"), "foreign");
    for (const bad of ["/home/x'; rm -rf /", "relative/.claude", "/home/$(id)/.claude", ""]) assert.throws(() => claudeDirProbeScript(bad), /꼴 밖/, bad);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await t("S5 게이트웨이가 보는 설정 폴더(비격리) — 그 계정 소유 폴더 ok · 없음 · 링크 · 파일 · 남의 소유(/)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-g-"));
  try {
    const ok = path.join(dir, "claude"), link = path.join(dir, "link"), file = path.join(dir, "file");
    fs.mkdirSync(ok); fs.symlinkSync(ok, link); fs.writeFileSync(file, "x");
    assert.equal(await gatewayClaudeDirState(ok), "ok");
    assert.equal(await gatewayClaudeDirState(path.join(dir, "none")), "missing");
    assert.equal(await gatewayClaudeDirState(link), "link");
    assert.equal(await gatewayClaudeDirState(file), "foreign");
    if (process.getuid?.() !== 0) assert.equal(await gatewayClaudeDirState("/"), "foreign");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── L. 살아 있는 의존 — 가짜 docker · getent 실행 파일로 ──────────────────────────────

/** 가짜 실행 파일 — 받은 인자를 파일에 적고, 정해진 끝 · stderr 로 답한다. */
function fakeBin(dir: string, name: string, script: string): string {
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${path.join(dir, `${name}.calls`)}"\n${script}\n`, { mode: 0o755 });
  return bin;
}
const withEnv = async (over: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> => {
  const keep: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(over)) { keep[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await fn(); } finally { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

await t("L1 지우기 — `docker rm -f <이름>` · «No such container» · «이미 지우는 중»(--rm 이 지우는 중)은 조용히 · 그 밖의 실패는 던진다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-bin-"));
  try {
    await withEnv({ LIVELY_DOCKER_BIN: fakeBin(dir, "docker", `echo "Error response from daemon: No such container: $3" >&2; exit 1`) }, async () => {
      await (await liveDockerDeps()).remove("lvly-job-42-0a1b2c3d");
    });
    assert.equal(fs.readFileSync(path.join(dir, "docker.calls"), "utf8").trim(), "rm -f lvly-job-42-0a1b2c3d");
    await withEnv({ LIVELY_DOCKER_BIN: fakeBin(dir, "docker", `echo "Error response from daemon: removal of container $3 is already in progress" >&2; exit 1`) }, async () => {
      await (await liveDockerDeps()).remove("lvly-job-42-0a1b2c3d");
    });
    await withEnv({ LIVELY_DOCKER_BIN: fakeBin(dir, "docker", `echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1`) }, async () => {
      await assert.rejects((await liveDockerDeps()).remove("lvly-job-42-0a1b2c3d"), /permission denied/);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await t("L2 띄우기 — 검사기가 먼저다: 거절하면 docker 를 부르지 않는다 · 지나면 그 인자 그대로 docker 에", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-bin-"));
  const tr = realTree();
  try {
    await withEnv({ LIVELY_DOCKER_BIN: fakeBin(dir, "docker", "exit 0") }, async () => {
      const d = await liveDockerDeps();
      const { args, policy } = argsAndPolicy(tr, subPlace(tr));
      await assert.rejects(d.run(["run", "--privileged", ...args.slice(1)], policy), DockerRunRejected);
      assert.equal(fs.existsSync(path.join(dir, "docker.calls")), false, "거절된 인자로 docker 를 부르지 않았다");
      await d.run(args, policy);
      assert.match(fs.readFileSync(path.join(dir, "docker.calls"), "utf8"), /^run -d --rm --name lvly-job-42-0a1b2c3d /);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); tr.done(); }
});

await t("L3 박스 사실 — 하네스 실행 파일은 ELF · 다른 계정 실행 가능이어야 한다(아니면 까닭 · 고칠 길) · docker info 의 메모리 · 스왑 상한 · 도커에 못 닿으면 까닭 · 실행 파일을 못 읽으면 까닭(도커 원문 · 경로 · 파일 오류는 공개 글에 없다)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-box-"));
  try {
    const elf = path.join(dir, "claude-elf"), text = path.join(dir, "claude-js"), priv = path.join(dir, "claude-priv");
    fs.writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]), { mode: 0o755 });
    fs.writeFileSync(text, "#!/usr/bin/env node\n", { mode: 0o755 });
    fs.writeFileSync(priv, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o700 });
    const okDocker = fakeBin(dir, "docker", `[ "$1" = info ] && echo "8178892800 true"; exit 0`);
    await withEnv({ LIVELY_DOCKER_BIN: okDocker, LIVELY_AGENT_JOB_IMAGE: "registry.local/node:22-bookworm-slim", LIVELY_AGENT_JOB_CLAUDE_BIN: elf }, async () => {
      const b = await probeDockerBox({ isolated: false });
      assert.equal(b.claudeBin, fs.realpathSync(elf));
      assert.equal(b.memMb, 7800);
      assert.equal(b.swapLimit, true);
      assert.equal(b.image, "registry.local/node:22-bookworm-slim");
      assert.equal(b.gateway.uid, process.getuid?.());
    });
    //  게이트웨이가 못 읽는 실행 파일(모드 000 — root 는 읽으므로 그때는 건너뛴다).
    const unreadable = path.join(dir, "claude-unreadable");
    fs.writeFileSync(unreadable, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o000 });
    const cases: Array<readonly [string, RegExp]> = [[text, /ELF.*install\.sh/s], [priv, /다른 계정이 실행할 수 없습니다/], [path.join(dir, "none"), /찾지 못했습니다/],
      ...(process.getuid?.() === 0 ? [] : [[unreadable, /claude 실행 파일을 읽지 못했습니다.*권한/s] as const])];
    for (const [bin, re] of cases) {
      await withEnv({ LIVELY_DOCKER_BIN: okDocker, LIVELY_AGENT_JOB_CLAUDE_BIN: bin }, async () => {
        await assert.rejects(probeDockerBox({ isolated: false }), (e: unknown) => {
          const m = (e as Error).message;
          return e instanceof DockerBoxError && re.test(m) && !m.includes(dir) && !/EACCES|ENOENT|permission denied/i.test(m);
        }, String(bin));
      });
    }
    if (process.getuid?.() !== 0) {
      //  판정 · 501 · 관리자 보기까지 — 원문(경로 · EACCES)은 detail(로그)에만.
      await withEnv({ LIVELY_DOCKER_BIN: okDocker, LIVELY_AGENT_JOB_CLAUDE_BIN: unreadable }, async () => {
        resetDockerProbesForTest();
        const r = await dockerBoxCheck();
        assert.equal(r.ok, false);
        for (const s of [r.ok ? "" : r.why, dockerUnavailableMessage(), (await dockerSurfaceStatus(3072)).note]) {
          assert.ok(!s.includes(dir) && !/EACCES|permission denied/i.test(s), s);
          assert.match(s, /읽지 못했습니다/);
        }
        resetDockerProbesForTest();
      });
    }
    await withEnv({ LIVELY_DOCKER_BIN: fakeBin(dir, "docker", `echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock-SECRETPATH" >&2; exit 1`), LIVELY_AGENT_JOB_CLAUDE_BIN: elf }, async () => {
      await assert.rejects(probeDockerBox({ isolated: false }), (e: unknown) => {
        const m = (e as Error).message, detail = (e as { detail?: string }).detail ?? "";
        return /도커에 닿지 못했습니다.*docker 그룹/s.test(m) && !m.includes("SECRETPATH") && detail.includes("SECRETPATH");
      });
    });
    await withEnv({ LIVELY_DOCKER_BIN: fakeBin(dir, "docker", `[ "$1" = info ] && echo "8178892800 false"; exit 0`), LIVELY_AGENT_JOB_CLAUDE_BIN: elf }, async () => {
      assert.equal((await probeDockerBox({ isolated: false })).swapLimit, false);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await t("L4 격리 박스 판정 — lively-shared gid · 전용 uid 가 비었으면 된다 · 그룹 없음(끝 2) · uid 를 박스 계정이 씀 · getent 의 다른 실패는 닫힌 쪽(던진다) · 공개 글에 계정 이름 없음", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-ge-"));
  try {
    const elf = path.join(dir, "claude");
    fs.writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
    const env = { LIVELY_DOCKER_BIN: fakeBin(dir, "docker", `[ "$1" = info ] && echo "8178892800 true"; exit 0`), LIVELY_AGENT_JOB_CLAUDE_BIN: elf, LIVELY_AGENT_JOB_UID: undefined };
    const ge = (group: string, passwd: string): string => fakeBin(dir, `getent-${Math.random().toString(16).slice(2, 8)}`, `case "$1" in group) ${group};; passwd) ${passwd};; esac`);
    await withEnv(env, async () => {
      const b = await probeDockerBox({ isolated: true, getent: ge(`echo "lively-shared:x:1500:box_kim"; exit 0`, "exit 2") });
      assert.deepEqual([b.isolated, b.sharedGid, b.jobUid], [true, 1500, DEFAULT_JOB_UID]);
      await assert.rejects(probeDockerBox({ isolated: true, getent: ge("exit 2", "exit 2") }), /lively-shared 그룹이 없습니다/);
      await assert.rejects(probeDockerBox({ isolated: true, getent: ge(`echo "lively-shared:x:1500:"; exit 0`, `echo "secretuser:x:65532:65532::/home/secretuser:/bin/sh"; exit 0`) }),
        (e: unknown) => /uid\(LIVELY_AGENT_JOB_UID\)를 박스 계정이 씁니다/.test((e as Error).message) && !(e as Error).message.includes("secretuser"));
      await assert.rejects(probeDockerBox({ isolated: true, getent: ge(`echo "lively-shared:x:1500:"; exit 0`, "exit 1") }), /계정 정보를 읽지 못했습니다/, "passwd 판정 실패를 «겹침 없음» 으로 읽지 않는다");
      await assert.rejects(probeDockerBox({ isolated: true, getent: ge("exit 3", "exit 2") }), /계정 정보를 읽지 못했습니다/, "group 판정 실패");
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await t("L5 기억한 판정 동안 하네스가 새 판으로 바뀌어 옛 실행 파일이 지워졌다 — box() 가 다시 판정해 새 파일을 준다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-up-"));
  try {
    const v1 = path.join(dir, "v1"), v2 = path.join(dir, "v2"), link = path.join(dir, "claude");
    for (const f of [v1, v2]) fs.writeFileSync(f, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
    fs.symlinkSync(v1, link);
    await withEnv({ LIVELY_DOCKER_BIN: fakeBin(dir, "docker", `[ "$1" = info ] && echo "8178892800 true"; exit 0`), LIVELY_AGENT_JOB_CLAUDE_BIN: link, LIVELY_MEMBER_ISOLATION: "off" }, async () => {
      resetDockerProbesForTest();
      const d = await liveDockerDeps();
      assert.equal((await d.box()).claudeBin, fs.realpathSync(v1));
      fs.rmSync(link); fs.rmSync(v1); fs.symlinkSync(v2, link);
      assert.equal((await d.box()).claudeBin, fs.realpathSync(v2), "옛 판(v1)을 기억한 채 주지 않는다");
    });
  } finally { resetDockerProbesForTest(); fs.rmSync(dir, { recursive: true, force: true }); }
});

await t("L6 비격리 · 단일 계정 스위치(LIVELY_MULTIPROFILE=0)의 설정 폴더 — 게이트웨이 ~/.claude 를 만들지 않고 상태만 본다(없음 · 폴더 ok · 링크) · 뿌리 = 게이트웨이 홈", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-home-")));
  try {
    await withEnv({ HOME: home, LIVELY_MULTIPROFILE: "0" }, async () => {
      const d = await liveDockerDeps();
      const u = { userId: "kim", scopes: [] } as unknown as LivelyUser;
      const dir = path.join(home, ".claude");
      assert.deepEqual(await d.profileDir(u), { dir, root: home, state: "missing" });
      assert.equal(fs.existsSync(dir), false, "없는 자리를 만들지 않는다(만들면 로그인하지 않은 계정이 빈 설정으로 돈다)");
      fs.mkdirSync(dir);
      assert.equal((await d.profileDir(u)).state, "ok");
      fs.rmSync(dir, { recursive: true });
      fs.symlinkSync(os.tmpdir(), dir);
      assert.equal((await d.profileDir(u)).state, "link");
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

await t("L7 이미지 받기(ensureImageOnce) — 박스에 없을(«No such image») 때만 받는다 · 같은 때 셋이 물어도 확인 · 받기 한 번 · 받은 뒤엔 다시 묻지 않는다 · 받기 실패는 잊어 다음에 다시 받는다 · 다른 확인 실패는 받지 않고 던진다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-img-"));
  try {
    const bin = fakeBin(dir, "docker", [
      `case "$1" in`,
      `  image) [ -n "$FAKE_INSPECT_OK" ] && { echo sha256:1; exit 0; }`,
      `         [ -n "$FAKE_INSPECT_DOWN" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }`,
      `         echo "Error response from daemon: No such image: $5" >&2; exit 1;;`,
      `  pull) sleep 0.3; [ -n "$FAKE_PULL_FAIL" ] && { echo "pull access denied for $3" >&2; exit 1; }; exit 0;;`,
      `esac`,
    ].join("\n"));
    const calls = (image: string): string[] => (fs.existsSync(path.join(dir, "docker.calls")) ? fs.readFileSync(path.join(dir, "docker.calls"), "utf8") : "")
      .split("\n").filter((l) => l.endsWith(` ${image}`)).map((l) => l.split(" ")[0]!);
    await withEnv({ LIVELY_DOCKER_BIN: bin, FAKE_INSPECT_OK: undefined, FAKE_INSPECT_DOWN: undefined, FAKE_PULL_FAIL: undefined }, async () => {
      await Promise.all([ensureImageOnce("lvly-l7-a"), ensureImageOnce("lvly-l7-a"), ensureImageOnce("lvly-l7-a")]);
      assert.deepEqual(calls("lvly-l7-a"), ["image", "pull"], "확인 한 번 · 받기 한 번");
      await ensureImageOnce("lvly-l7-a");
      assert.deepEqual(calls("lvly-l7-a"), ["image", "pull"], "받은 뒤엔 다시 묻지 않는다");
      process.env.FAKE_PULL_FAIL = "1";
      await assert.rejects(ensureImageOnce("lvly-l7-b"), /pull access denied/);
      delete process.env.FAKE_PULL_FAIL;
      await ensureImageOnce("lvly-l7-b");
      assert.deepEqual(calls("lvly-l7-b"), ["image", "pull", "image", "pull"], "실패한 받기는 잊고 다시 받는다");
      process.env.FAKE_INSPECT_DOWN = "1";
      await assert.rejects(ensureImageOnce("lvly-l7-c"), /Cannot connect/);
      assert.deepEqual(calls("lvly-l7-c"), ["image"], "«없음» 이 아닌 실패로는 받지 않는다");
      delete process.env.FAKE_INSPECT_DOWN;
      process.env.FAKE_INSPECT_OK = "1";
      await ensureImageOnce("lvly-l7-d");
      assert.deepEqual(calls("lvly-l7-d"), ["image"], "박스에 있으면 받지 않는다");
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── B. 박스 판정 기억 · 관리자 보기 ─────────────────────────────────────────────

await t("B1 박스 판정 기억 — 된다 1분 · 안 된다 15초 · 지나면 다시 묻는다 · 같은 때 여러 번 물어도 한 번", async () => {
  resetDockerProbesForTest();
  let n = 0, now = 1_000_000;
  const probe = async (): Promise<DockerBox> => { n++; return box(); };
  await Promise.all([dockerBoxCheck({ probe, now: () => now }), dockerBoxCheck({ probe, now: () => now }), dockerBoxCheck({ probe, now: () => now })]);
  assert.equal(n, 1);
  now += 59_000; await dockerBoxCheck({ probe, now: () => now }); assert.equal(n, 1);
  now += 2_000; await dockerBoxCheck({ probe, now: () => now }); assert.equal(n, 2);
  resetDockerProbesForTest();
  let m = 0;
  const bad = async (): Promise<DockerBox> => { m++; throw new DockerBoxError("도커에 닿지 못했습니다", "dial unix /var/run/docker.sock: connect: permission denied"); };
  const r = await dockerBoxCheck({ probe: bad, now: () => now });
  assert.deepEqual(r, { ok: false, why: "도커에 닿지 못했습니다" });
  now += 14_000; await dockerBoxCheck({ probe: bad, now: () => now }); assert.equal(m, 1);
  now += 2_000; await dockerBoxCheck({ probe: bad, now: () => now }); assert.equal(m, 2);
  resetDockerProbesForTest();
  //  DockerBoxError 가 아닌 오류(경로가 든 파일 오류 원문)는 공개 글에 싣지 않는다 — 정해진 글 · 원문은 로그에만.
  const raw = async (): Promise<DockerBox> => { throw new Error("EACCES: permission denied, open '/srv/lively/secret-path/claude'"); };
  const r2 = await dockerBoxCheck({ probe: raw, now: () => now });
  assert.equal(r2.ok, false);
  for (const s of [r2.ok ? "" : r2.why, dockerUnavailableMessage()]) {
    assert.ok(!s.includes("secret-path") && !s.includes("EACCES"), s);
    assert.match(s, /확인하지 못했습니다/);
  }
  resetDockerProbesForTest();
});

await t("B2 판정 시각은 판정이 끝난 때 — 20초 걸린 실패도 그 뒤 15초는 다시 묻지 않는다", async () => {
  resetDockerProbesForTest();
  let now = 5_000_000, m = 0;
  const slowBad = async (): Promise<DockerBox> => { m++; now += 20_000; throw new Error("도커가 답하지 않습니다"); };
  await dockerBoxCheck({ probe: slowBad, now: () => now });
  now += 10_000;
  await dockerBoxCheck({ probe: slowBad, now: () => now });
  assert.equal(m, 1, "끝난 지 10초 — 기억한 판정");
  now += 6_000;
  await dockerBoxCheck({ probe: slowBad, now: () => now });
  assert.equal(m, 2);
  resetDockerProbesForTest();
});

await t("B3 관리자 보기 — 못 씀 · 상한 0 · 스왑 상한 못 걺은 «안 걸림» 과 까닭 · 된다면 «걸림» · 계정은 격리 판정 그대로(띄우기와 같은 판정)", async () => {
  const check = (r: Awaited<ReturnType<typeof dockerBoxCheck>>) => async () => r;
  const down = await dockerSurfaceStatus(3072, { check: check({ ok: false, why: "도커에 닿지 못했습니다" }) });
  assert.deepEqual([down.runsAs, down.enforced], [null, false]);
  assert.match(down.note, /도커에 닿지 못했습니다.*게이트웨이 로그/s, "관리자 보기는 까닭 뒤에 로그 자리를 알린다");
  const zero = await dockerSurfaceStatus(0, { check: check({ ok: true, box: box() }) });
  assert.deepEqual([zero.runsAs, zero.enforced], ["member", false]);
  assert.match(zero.note, /7800MB/);
  const noSwap = await dockerSurfaceStatus(3072, { check: check({ ok: true, box: box({ swapLimit: false, isolated: false }) }) });
  assert.deepEqual([noSwap.runsAs, noSwap.enforced], ["gateway", false]);
  assert.match(noSwap.note, /띄우지 않습니다/);
  const ok = await dockerSurfaceStatus(3072, { check: check({ ok: true, box: box() }) });
  assert.deepEqual([ok.runsAs, ok.enforced], ["member", true]);
  //  띄우기와 같은 판정 — 스왑 상한을 못 거는 박스 · 상한 있음이면 띄우기도 거절한다(C5).
  const tr = realTree();
  try {
    const { d } = fakeDeps(tr, { box: async () => box({ swapLimit: false, claudeBin: tr.bin }) });
    await failsWith(launchDockerJob(row(), SECRET, d), (e) => assert.equal(e.transient, false));
  } finally { tr.done(); }
});

// ── R. 실행면 배선(진짜 jobSurface · 자식 프로세스 — 토폴로지는 부팅에 언다) ─────────────

await t("R1 스위치를 켠 프로세스(docker) — jobSurface 가 도커 실행면 · 관리자 보기(kind · 띄울 수 있음 · 계정 · 상한 걸림) · 판의 자리(포트 · 행의 작업 폴더)", async () => {
  const { isolationInfraReady } = await import("../terminal/terminal-isolation.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-r-"));
  try {
    const elf = path.join(dir, "claude");
    fs.writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
    const env: NodeJS.ProcessEnv = {
      ...process.env, LIVELY_AGENT_JOBS: "docker", LIVELY_AGENT_JOBS_PORT: "18123",
      LIVELY_DOCKER_BIN: fakeBin(dir, "docker", `[ "$1" = info ] && echo "8178892800 true"; exit 0`), LIVELY_AGENT_JOB_CLAUDE_BIN: elf,
    };
    for (const k of ["LIVELY_SESSION_ENSURE", "LIVELY_SESSION_SPAWN", "LIVELY_TMUX_EXEC", "LIVELY_NODE_TOKEN", "LIVELY_SESSION_EXEC", "TMUX", "TMUX_PANE"]) delete env[k];
    const url = new URL("./surface.js", import.meta.url).href;
    const code = `import(${JSON.stringify(url)}).then(async (m) => { const v = await m.describeJobSurface(3072); const s = await m.jobSurface(); const pv = await s.paneView({ cwd: "/work/apps/x" }); process.stdout.write(JSON.stringify({ v, kind: s.kind, pv }), () => process.exit(0)); })`;
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", code], { env, stdio: ["ignore", "pipe", "pipe"] });
      let o = "", e = "";
      p.stdout.on("data", (x) => { o += x; }); p.stderr.on("data", (x) => { e += x; });
      p.on("close", (c) => (c === 0 ? resolve(o) : reject(new Error(`자식 프로세스 ${c}: ${e.slice(0, 400)}`))));
    });
    const { v, kind, pv } = JSON.parse(out);
    assert.equal(kind, "docker");
    assert.equal(v.kind, "docker");
    assert.equal(v.available, true, JSON.stringify(v));
    assert.equal(v.unavailable, null);
    assert.equal(v.runs_as, isolationInfraReady() ? "member" : "gateway");
    if (!isolationInfraReady()) assert.equal(v.memory_cap.enforced, true, JSON.stringify(v.memory_cap));
    assert.equal(pv.cwd, "/work/apps/x");
    assert.equal(pv.gateway, "http://127.0.0.1:18123");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${pass} passed`);
