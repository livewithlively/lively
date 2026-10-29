// 도커 실행면(launch-docker.ts)과 실행면 고르기의 도커 갈래 — 사양 엣지 표의 A · P · G · C · K · L · S 행 (#5082 2단계).
//  자리 판정(jobPlacement) · 인자(jobContainerArgs) · 정책(jobContainerPolicy)은 순수 함수라 표로 재고, 정책은 **진짜 검사기**(ops/docker-run-guard)에
//  진짜 폴더(임시)로 대 본다 — 붙는 원본이 뿌리 밖이면 거절되는지가 이 실행면의 경계다.
//  띄우기는 바꿔 끼운 의존(DockerLaunchDeps)으로 돌려 **무엇이 불렸나**(순서 · env 파일 글 · 인자)를 기록으로 단언하고,
//  판 머리(JOB_CONTAINER_PRELUDE) · ~/.claude 확인 글(claudeDirProbeScript)은 진짜 셸로, 살아 있는 의존의 docker 부르기는 가짜 docker 실행 파일로 돌린다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_JOB_UID, JOB_BARE_HOME, JOB_CLAUDE_DIR_ENV, JOB_CLAUDE_TARGET, JOB_CONTAINER_PRELUDE, JOB_LOCALE,
  claudeDirProbeScript, dockerBoxCheck, dockerMemoryMb, dockerPaneView, dockerSurfaceStatus, envFileText, jobContainerArgs, jobContainerEnv,
  jobContainerName, jobContainerPolicy, jobPlacement, killDockerJob, launchDockerJob, liveDockerDeps, probeDockerBox, resetDockerProbesForTest,
  type DockerBox, type DockerLaunchDeps, type JobPlacement, type MemberFacts,
} from "./launch-docker.js";
import { jobSurfaceKind, jobsUnavailableMessage, dockerSurfaceBlocker } from "./surface.js";
import { JobLaunchError } from "./launch.js";
import { BOOT_SOURCE } from "./runner.js";
import { HOMELESS_OS_USER } from "./plan.js";
import { computeExecTopology, parseAgentJobs } from "../exec-topology.js";
import { assertSafeDockerRun, DockerRunRejected } from "../ops/docker-run-guard.js";
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

// ── P. 누구로 · 무엇을 붙이나(jobPlacement) ──────────────────────────────────────

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
  const p = jobPlacement({ homeless: false, subscription: true, box: box({ isolated: false, sharedGid: null }), member: null, profile: { dir: "/home/lively/.lively/profiles/kim/claude", root: "/home/lively/.lively/profiles" } });
  assert.deepEqual(p, {
    uid: 1001, gid: 1001, groups: [], home: JOB_BARE_HOME,
    claude: { host: "/home/lively/.lively/profiles/kim/claude", target: "/home/lively/.lively/profiles/kim/claude", root: "/home/lively/.lively/profiles", configDirEnv: true }, runsAs: "gateway",
  });
});

await t("P7 비격리 박스 · 구독 · 단일 계정(프로필 없음) — 게이트웨이 ~/.claude(뿌리 = 게이트웨이 홈) · API 키 · 홈 없는 작업은 설정 폴더 없음", () => {
  const b = box({ isolated: false, sharedGid: null });
  assert.deepEqual(jobPlacement({ homeless: false, subscription: true, box: b, member: null, profile: null }).claude,
    { host: "/home/lively/.claude", target: "/home/lively/.claude", root: "/home/lively", configDirEnv: true });
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
  const gw = jobContainerEnv({ jobId: 42, bootSecret: SECRET, port: 8080, slug: null, tz: "UTC", place: jobPlacement({ homeless: false, subscription: true, box: box({ isolated: false }), member: null, profile: null }) });
  assert.equal(gw.CLAUDE_CONFIG_DIR, "/home/lively/.claude");
  assert.equal(gw[JOB_CLAUDE_DIR_ENV], "/home/lively/.claude");
});

await t("G4 env 파일 글 — KEY=VALUE 한 줄씩 · 줄바꿈 · CR · NUL 이 든 값과 꼴 밖 이름은 던진다", () => {
  assert.equal(envFileText({ A: "1", B_2: "x=y z" }), "A=1\nB_2=x=y z\n");
  for (const v of ["a\nB=1", "a\rb", "a\0b"]) assert.throws(() => envFileText({ A: v }), /넘길 수 없습니다/, JSON.stringify(v));
  for (const k of ["1A", "A-B", "", "A B"]) assert.throws(() => envFileText({ [k]: "1" }), /넘길 수 없습니다/, k);
});

/** 진짜 폴더 한 벌 — 검사기가 실제 경로(realpath)로 본다. */
function realTree(): { root: string; apps: string; work: string; homeRoot: string; home: string; bin: string; run: string; envFile: string; done: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-"));
  const apps = path.join(root, "apps"), work = path.join(apps, "policy-bot");
  const homeRoot = path.join(root, "home"), home = path.join(homeRoot, "box_kim");
  const bin = path.join(root, "bin", "claude"), run = path.join(root, "run"), envFile = path.join(run, "lvly-job-42-0a1b2c3d.env");
  for (const d of [work, path.join(home, ".claude"), path.dirname(bin), run]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(bin, "\x7fELF", { mode: 0o755 });
  fs.writeFileSync(envFile, "A=1\n", { mode: 0o600 });
  return { root, apps, work, homeRoot, home, bin, run, envFile, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** 한 벌의 자리로 인자 · 정책을 짓는다. */
function argsAndPolicy(tr: ReturnType<typeof realTree>, place: Pick<JobPlacement, "uid" | "gid" | "groups" | "home" | "claude">, over: { workHost?: string; workdir?: string } = {}): { args: string[]; policy: ReturnType<typeof jobContainerPolicy> } {
  const workdir = over.workdir ?? "/work/apps/policy-bot";
  const args = jobContainerArgs({
    name: "lvly-job-42-0a1b2c3d", image: "node:22-bookworm-slim", labels: { "lvly.agent-job": "1", "lvly.agent-job.id": "42" }, place, memoryMb: 3072,
    workHost: over.workHost ?? tr.work, workdir, claudeBin: tr.bin, envFile: tr.envFile,
  });
  const policy = jobContainerPolicy({
    image: "node:22-bookworm-slim", workRoot: tr.apps, workdir: "/work/apps/policy-bot", claude: place.claude ? { root: place.claude.root, target: place.claude.target } : null,
    claudeBin: tr.bin, envRoot: tr.run, home: place.home, groups: place.groups,
  });
  return { args, policy };
}

const subPlace = (tr: ReturnType<typeof realTree>): JobPlacement => jobPlacement({ homeless: false, subscription: true, box: box(), member: { ...kim, home: tr.home }, profile: null });

await t("G5 세 자리(격리 구독 · 격리 홈 없음 · 비격리 구독) 모두 진짜 검사기를 지난다 — 이미지 · 판 머리 · 부트가 끝에 그대로", () => {
  const tr = realTree();
  try {
    const places: JobPlacement[] = [
      subPlace(tr),
      jobPlacement({ homeless: true, subscription: false, box: box(), member: null, profile: null }),
      jobPlacement({ homeless: false, subscription: true, box: box({ isolated: false }), member: null, profile: { dir: path.join(tr.home, ".claude"), root: tr.homeRoot } }),
    ];
    for (const pl of places) {
      const { args, policy } = argsAndPolicy(tr, pl);
      const r = assertSafeDockerRun(args, policy);
      assert.equal(r.image, "node:22-bookworm-slim");
      assert.deepEqual(r.command, ["sh", "-c", JOB_CONTAINER_PRELUDE, "lvly-job", BOOT_SOURCE]);
    }
  } finally { tr.done(); }
});

await t("G6 인자의 막이 — 분리 · 끝나면 지움 · host 네트워크 · 루트 읽기 전용 · 메모리 = 메모리+스왑 · cap 전부 빼기 · no-new-privileges · --init · 그 사용자 · 비밀 없음", () => {
  const tr = realTree();
  try {
    const { args } = argsAndPolicy(tr, subPlace(tr));
    const val = (f: string): string[] => args.flatMap((a, i) => (a === f ? [args[i + 1]!] : []));
    for (const f of ["-d", "--rm", "--read-only", "--init"]) assert.ok(args.includes(f), f);
    assert.deepEqual(val("--network"), ["host"]);
    assert.deepEqual(val("--memory"), ["3072m"]);
    assert.deepEqual(val("--memory-swap"), ["3072m"]);
    assert.deepEqual(val("--cap-drop"), ["ALL"]);
    assert.deepEqual(val("--security-opt"), ["no-new-privileges"]);
    assert.deepEqual(val("--user"), ["200401:200401"]);
    assert.deepEqual(val("--group-add"), [String(SHARED_GID)]);
    assert.deepEqual(val("--restart"), ["no"]);
    assert.deepEqual(val("--workdir"), ["/work/apps/policy-bot"]);
    assert.ok(Number(val("--pids-limit")[0]) > 0);
    //  HOME 은 그 사용자의 빈 tmpfs(0700) · /tmp 도 tmpfs.
    assert.ok(val("--tmpfs").some((v) => v.startsWith(`${tr.home}:`) && v.includes("mode=0700") && v.includes("uid=200401") && v.includes("gid=200401")));
    assert.ok(val("--tmpfs").some((v) => v.startsWith("/tmp:")));
    //  붙는 것은 셋뿐 — 작업 폴더(쓰기) · ~/.claude(쓰기) · 하네스 실행 파일(읽기 전용).
    assert.deepEqual(val("--volume").sort(), [`${tr.work}:/work/apps/policy-bot`, `${path.join(tr.home, ".claude")}:${path.join(tr.home, ".claude")}`, `${tr.bin}:${JOB_CLAUDE_TARGET}:ro`].sort());
    assert.deepEqual(val("--env-file"), [tr.envFile]);
    assert.ok(!args.join("\n").includes("bootSecret"), "부트 비밀은 인자에 없다");
    assert.ok(!args.some((a) => a === "-e" || a === "--env"), "env 는 파일로만");
  } finally { tr.done(); }
});

await t("G7 정책이 막는 것 — 뿌리 밖 작업 폴더 · 행과 다른 작업 폴더 자리 · 홈 밖 설정 폴더 · 하네스 쓰기 마운트 · 다른 이미지 · 정책 밖 그룹 · 홈이 아닌 tmpfs", () => {
  const tr = realTree();
  try {
    const pl = subPlace(tr);
    const reject = (args: string[], policy: ReturnType<typeof jobContainerPolicy>, re: RegExp, why: string): void => {
      assert.throws(() => assertSafeDockerRun(args, policy), (e: unknown) => e instanceof DockerRunRejected && re.test(e.message), why);
    };
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-out-"));
    try {
      reject(argsAndPolicy(tr, pl, { workHost: outside }).args, argsAndPolicy(tr, pl).policy, /마운트 원본/, "apps 뿌리 밖의 폴더를 작업 폴더로");
      reject(argsAndPolicy(tr, pl, { workdir: "/work/apps/other-app" }).args, argsAndPolicy(tr, pl).policy, /마운트 원본/, "행의 작업 폴더가 아닌 자리에");
      //  링크로 뿌리 밖을 가리켜도 실제 경로로 본다.
      const link = path.join(tr.apps, "sneaky");
      fs.symlinkSync(outside, link);
      reject(argsAndPolicy(tr, pl, { workHost: link }).args, argsAndPolicy(tr, pl).policy, /마운트 원본/, "뿌리 안 링크 → 밖");
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
    const { args, policy } = argsAndPolicy(tr, pl);
    const swap = (from: string, to: string): string[] => args.map((a) => (a === from ? to : a));
    reject(swap(`${path.join(tr.home, ".claude")}:${path.join(tr.home, ".claude")}`, `${tr.root}:${path.join(tr.home, ".claude")}`), policy, /마운트 원본/, "홈 밖을 설정 폴더 자리에");
    reject(swap(`${tr.bin}:${JOB_CLAUDE_TARGET}:ro`, `${tr.bin}:${JOB_CLAUDE_TARGET}`), policy, /마운트 원본/, "하네스 실행 파일을 쓰기로");
    reject(swap("node:22-bookworm-slim", "evil:latest"), policy, /이미지/, "다른 이미지");
    reject(swap(String(SHARED_GID), "27"), policy, /group-add/, "정책 밖 그룹(sudo 등)");
    reject(swap(`${pl.home}:rw,nosuid,nodev,size=256m,mode=0700,uid=200401,gid=200401`, `/etc:rw,nosuid,nodev,size=256m,mode=0700,uid=200401,gid=200401`), policy, /tmpfs 자리/, "홈이 아닌 tmpfs");
    reject([...args.slice(0, 1), "--volume", "/var/run/docker.sock:/var/run/docker.sock", ...args.slice(1)], policy, /docker 소켓/, "docker 소켓");
  } finally { tr.done(); }
});

await t("G8 정책 — 행의 작업 폴더가 두 꼴(앱 폴더 · 프로젝트 폴더) 밖이면 짓지 않는다", () => {
  for (const bad of ["/work/apps/policy-bot/sub", "/work/apps/../etc", "/srv/lively/apps/x", "/work/shared/project/0", "/work/shared"]) {
    assert.throws(() => jobContainerPolicy({ image: "i", workRoot: "/srv", workdir: bad, claude: null, claudeBin: "/b", envRoot: "/r", home: JOB_BARE_HOME, groups: [] }), /꼴이 아닙니다/, bad);
  }
  assert.doesNotThrow(() => jobContainerPolicy({ image: "i", workRoot: "/srv", workdir: "/work/shared/project/12", claude: null, claudeBin: "/b", envRoot: "/r", home: JOB_BARE_HOME, groups: [] }));
});

// ── C. 띄우기(바꿔 끼운 의존) ────────────────────────────────────────────────────

interface Rec { calls: string[]; envText: string | null; args: string[] | null; policy: unknown; removedEnv: string[] }
function fakeDeps(over: Partial<DockerLaunchDeps> = {}, rec: Rec = { calls: [], envText: null, args: null, policy: null, removedEnv: [] }): { d: DockerLaunchDeps; rec: Rec } {
  const c = (s: string): void => { rec.calls.push(s); };
  const d: DockerLaunchDeps = {
    box: async () => { c("box"); return box(); },
    accountUser: async (m) => { c(`accountUser:${m}`); return { userId: m, scopes: [] } as unknown as LivelyUser; },
    ensureOsUser: async (u) => { c(`ensureOsUser:${u.userId}`); return `box_${u.userId}`; },
    memberFacts: async (osUser, want) => { c(`memberFacts:${osUser}:${want}`); return { ...kim, claude: want ? "ok" : null }; },
    profileDir: async (u) => { c(`profileDir:${u.userId}`); return { dir: `/home/lively/.lively/profiles/${u.userId}/claude`, root: "/home/lively/.lively/profiles" }; },
    resolveWork: async (_u, dir, osUser) => { c(`resolveWork:${dir.root}/${dir.sub}:${osUser}`); return { abs: `/srv/lively/${dir.root}/${dir.sub}`, base: `/srv/lively/${dir.root}` }; },
    mkdirWork: async (osUser, abs, shared) => { c(`mkdirWork:${osUser}:${abs}:${shared}`); },
    memoryMaxMb: async () => { c("memoryMaxMb"); return 3072; },
    ensureImage: async (image) => { c(`ensureImage:${image}`); },
    writeEnvFile: async (name, text) => { c(`writeEnvFile:${name}`); rec.envText = text; return { file: `/data/agent-jobs/run/${name}.env`, root: "/data/agent-jobs/run" }; },
    removeEnvFile: async (file) => { c("removeEnvFile"); rec.removedEnv.push(file); },
    run: async (args, policy) => { c("run"); rec.args = args; rec.policy = policy; },
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

await t("C1 격리 박스 · 구독 — 도커 → 상한 → 그 계정 → ~/.claude 확인 → 작업 폴더(그 계정이 만든다) → 이미지 → env 파일 → 띄움 → env 파일 지움(순서) · 이름 = lvly-<세션>", async () => {
  const { d, rec } = fakeDeps();
  const r = await launchDockerJob(row(), SECRET, d);
  assert.equal(r.container, "lvly-job-42-0a1b2c3d");
  assert.deepEqual(rec.calls, [
    "box", "memoryMaxMb", "accountUser:kim", "ensureOsUser:kim", "memberFacts:box_kim:true",
    "resolveWork:apps/policy-bot:box_kim", "mkdirWork:box_kim:/srv/lively/apps/policy-bot:false", "ensureImage:node:22-bookworm-slim",
    "writeEnvFile:lvly-job-42-0a1b2c3d", "run", "removeEnvFile",
  ]);
  assert.ok(rec.envText!.includes(`LVLY_JOB_BOOT=${SECRET}\n`));
  assert.ok(!rec.args!.join("\n").includes(SECRET), "비밀은 인자에 없다");
  assert.ok(rec.args!.includes("/srv/lively/apps/policy-bot:/work/apps/policy-bot"));
  assert.ok(rec.args!.includes("/home/box_kim/.claude:/home/box_kim/.claude"));
  assert.deepEqual(rec.removedEnv, ["/data/agent-jobs/run/lvly-job-42-0a1b2c3d.env"]);
});

await t("C2 격리 박스 · 홈 없는 작업 — 그 사람의 계정 · 홈을 쓰지 않는다(OS 계정 · 계정 사실 · 실행 계정 조회 없음) · 앱 자리는 전용 계정 기준 · 폴더는 게이트웨이가 2775 로 · 전용 uid", async () => {
  const { d, rec } = fakeDeps();
  await launchDockerJob(row({ homeless: true, account_kind: "api_key", account_member: null, requester: "app-srv-member" } as Partial<AgentJobRow>), SECRET, d);
  assert.ok(!rec.calls.some((c) => c.startsWith("ensureOsUser") || c.startsWith("memberFacts") || c.startsWith("accountUser") || c.startsWith("profileDir")), rec.calls.join(" "));
  assert.ok(rec.calls.includes(`resolveWork:apps/policy-bot:${HOMELESS_OS_USER}`));
  assert.ok(rec.calls.includes("mkdirWork:null:/srv/lively/apps/policy-bot:true"));
  const at = rec.args!.indexOf("--user");
  assert.equal(rec.args![at + 1], `${DEFAULT_JOB_UID}:${SHARED_GID}`);
  assert.ok(!rec.args!.some((a) => a.includes(".claude")), "설정 폴더를 붙이지 않는다");
});

await t("C3 비격리 박스 · 구독 — OS 계정을 만들지 않고 그 사람의 프로필 폴더를 붙인다 · 게이트웨이 uid · 폴더는 게이트웨이가", async () => {
  const { d, rec } = fakeDeps({ box: async () => { rec.calls.push("box"); return box({ isolated: false, sharedGid: null }); } });
  await launchDockerJob(row(), SECRET, d);
  assert.ok(!rec.calls.some((c) => c.startsWith("ensureOsUser") || c.startsWith("memberFacts")));
  assert.ok(rec.calls.includes("profileDir:kim"));
  assert.ok(rec.calls.includes("resolveWork:apps/policy-bot:null"));
  assert.ok(rec.calls.includes("mkdirWork:null:/srv/lively/apps/policy-bot:false"));
  assert.ok(rec.envText!.includes("CLAUDE_CONFIG_DIR=/home/lively/.lively/profiles/kim/claude\n"));
  assert.equal(rec.args![rec.args!.indexOf("--user") + 1], "1001:1001");
});

await t("C4 상한 0 — 도커 메모리 전체로 건다(검사기는 --memory 를 꼭 받는다) · 스왑 상한을 못 거는 박스여도 상한 0 이면 띄운다", async () => {
  const { d, rec } = fakeDeps({ memoryMaxMb: async () => 0, box: async () => box({ swapLimit: false, memMb: 5000 }) });
  await launchDockerJob(row(), SECRET, d);
  assert.equal(rec.args![rec.args!.indexOf("--memory") + 1], "5000m");
  assert.equal(rec.args![rec.args!.indexOf("--memory-swap") + 1], "5000m");
});

await t("C5 다시 해도 안 될 것 — 부수효과(작업 폴더 · env 파일 · 띄우기) 없이 JobLaunchError(일시 아님)", async () => {
  const cases: Array<[string, Partial<AgentJobRow>, Partial<DockerLaunchDeps>, RegExp]> = [
    ["세션 id 없음", { session_id: null } as Partial<AgentJobRow>, {}, /세션 id/],
    ["세션 id 꼴 밖", { session_id: "box-kim-1" } as Partial<AgentJobRow>, {}, /세션 id/],
    ["홈 없는 작업 · 구독", { homeless: true } as Partial<AgentJobRow>, {}, /API 키/],
    ["홈 없는 작업 · 프로젝트", { homeless: true, account_kind: "api_key", project_id: 7, cwd: "/work/shared/project/7" } as Partial<AgentJobRow>, {}, /프로젝트/],
    ["실행 계정 없음", { account_member: null } as Partial<AgentJobRow>, {}, /실행 계정/],
    ["작업 폴더 꼴 밖", { cwd: "/work/apps/policy-bot/../../etc" } as Partial<AgentJobRow>, {}, /작업 폴더 꼴/],
    ["스왑 상한 못 걺 · 상한 있음", {}, { box: async () => box({ swapLimit: false }) }, /스왑 상한/],
    ["~/.claude 링크", {}, { memberFacts: async () => ({ ...kim, claude: "link" }) }, /링크/],
    ["lively-shared 없음", {}, { box: async () => box({ sharedGid: null }) }, /lively-shared/],
    ["검사기 거절", {}, { run: async () => { throw new DockerRunRejected("모르는 깃발입니다: --privileged"); } }, /컨테이너 인자를 거절/],
  ];
  for (const [why, over, dover, re] of cases) {
    const { d, rec } = fakeDeps(dover);
    await failsWith(launchDockerJob(row(over), SECRET, d), (e) => {
      assert.equal(e.transient, false, why);
      assert.match(e.message, re, why);
    });
    if (why !== "검사기 거절") assert.ok(!rec.calls.some((c) => c.startsWith("mkdirWork") || c.startsWith("writeEnvFile") || c === "run"), `${why}: ${rec.calls.join(" ")}`);
    else assert.deepEqual(rec.removedEnv.length, 1, "거절돼도 env 파일은 지운다");
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
    ["작업 폴더", { mkdirWork: boom("EACCES") }, /작업 폴더를 만들지 못했습니다/],
    ["이미지", { ensureImage: boom("pull 실패") }, /작업 컨테이너를 확보하지 못했습니다: pull/],
    ["띄우기", { run: boom(`docker run 실패: Command failed: docker run ... LVLY_JOB_BOOT=${SECRET}`) }, /작업 컨테이너를 확보하지 못했습니다/],
  ];
  for (const [why, over, re] of cases) {
    const { d, rec } = fakeDeps(over);
    await failsWith(launchDockerJob(row(), SECRET, d), (e) => {
      assert.equal(e.transient, true, why);
      assert.match(e.message, re, why);
      assert.ok(!e.message.includes(SECRET), `${why}: 비밀이 글에 남았다`);
    });
    if (why === "띄우기") assert.equal(rec.removedEnv.length, 1, "띄우기 실패여도 env 파일을 지운다");
  }
});

await t("C7 비활성 실행 계정 — accountUser 가 던진 JobLaunchError 를 그대로(일시 아님) · OS 계정을 만들지 않는다", async () => {
  const { d, rec } = fakeDeps({ accountUser: async () => { throw new JobLaunchError("실행 계정(kim)이 활성 사람 구성원이 아닙니다"); } });
  await failsWith(launchDockerJob(row(), SECRET, d), (e) => { assert.equal(e.transient, false); assert.match(e.message, /활성 사람 구성원/); });
  assert.ok(!rec.calls.some((c) => c.startsWith("ensureOsUser")));
});

await t("C8 프로젝트 폴더 작업(격리 · API 키) — 공유 자리의 project/<n> 을 그 계정이 만들고 같은 자리(/work/shared/project/<n>)에 붙인다 · ~/.claude 는 보지 않는다", async () => {
  const { d, rec } = fakeDeps();
  await launchDockerJob(row({ account_kind: "api_key", account_member: null, project_id: 7, cwd: "/work/shared/project/7" } as Partial<AgentJobRow>), SECRET, d);
  assert.ok(rec.calls.includes("memberFacts:box_kim:false"));
  assert.ok(rec.calls.includes("resolveWork:shared/project/7:box_kim"));
  assert.ok(rec.args!.includes("/srv/lively/shared/project/7:/work/shared/project/7"));
  assert.equal(rec.args![rec.args!.indexOf("--workdir") + 1], "/work/shared/project/7");
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

// ── S. 진짜 셸 — 판 머리 · ~/.claude 확인 글 ─────────────────────────────────────

function sh(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn("sh", args, { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "", err = "";
    p.stdout.on("data", (x) => { out += x; }); p.stderr.on("data", (x) => { err += x; });
    const kill = setTimeout(() => p.kill("SIGKILL"), 20_000);
    p.on("close", (code) => { clearTimeout(kill); resolve({ code, out, err }); });
  });
}
//  판 머리 뒤의 «부트» 자리에 넣을 작은 node 글 — 설정 폴더 확인 env 가 지워졌는지 찍는다.
const PROBE_BOOT = `process.stdout.write("booted:" + (process.env.${JOB_CLAUDE_DIR_ENV} === undefined ? "clean" : "leaked"))`;
const envFor = (over: Record<string, string>): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, ...over };
  return e;
};

await t("S1 판 머리 — 붙인 설정 폴더가 없으면(API 키 · 홈 없음) 곧바로 부트 · 이 계정 소유 폴더면 부트 · 확인 env 는 부트에 넘기지 않는다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-c-"));
  try {
    const a = await sh(["-c", JOB_CONTAINER_PRELUDE, "lvly-job", PROBE_BOOT], envFor({}));
    assert.equal(a.code, 0, a.err);
    assert.equal(a.out, "booted:clean");
    const b = await sh(["-c", JOB_CONTAINER_PRELUDE, "lvly-job", PROBE_BOOT], envFor({ [JOB_CLAUDE_DIR_ENV]: dir }));
    assert.equal(b.code, 0, b.err);
    assert.equal(b.out, "booted:clean");
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

// ── L. 살아 있는 의존 — 가짜 docker 실행 파일로 ───────────────────────────────────

/** 가짜 docker — 받은 인자를 파일에 적고, 정해진 끝 · stderr 로 답한다. */
function fakeDocker(dir: string, script: string): string {
  const bin = path.join(dir, "docker");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${path.join(dir, "calls")}"\n${script}\n`, { mode: 0o755 });
  return bin;
}

await t("L1 지우기 — `docker rm -f <이름>` · «No such container» 는 조용히 · 그 밖의 실패는 던진다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-bin-"));
  const keep = process.env.LIVELY_DOCKER_BIN;
  try {
    process.env.LIVELY_DOCKER_BIN = fakeDocker(dir, `echo "Error response from daemon: No such container: $3" >&2; exit 1`);
    const d = await liveDockerDeps();
    await d.remove("lvly-job-42-0a1b2c3d");
    assert.equal(fs.readFileSync(path.join(dir, "calls"), "utf8").trim(), "rm -f lvly-job-42-0a1b2c3d");
    process.env.LIVELY_DOCKER_BIN = fakeDocker(dir, `echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1`);
    await assert.rejects((await liveDockerDeps()).remove("lvly-job-42-0a1b2c3d"), /permission denied/);
  } finally {
    if (keep === undefined) delete process.env.LIVELY_DOCKER_BIN; else process.env.LIVELY_DOCKER_BIN = keep;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await t("L2 띄우기 — 검사기가 먼저다: 거절하면 docker 를 부르지 않는다 · 지나면 그 인자 그대로 docker 에", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-bin-"));
  const tr = realTree();
  const keep = process.env.LIVELY_DOCKER_BIN;
  try {
    process.env.LIVELY_DOCKER_BIN = fakeDocker(dir, "exit 0");
    const d = await liveDockerDeps();
    const { args, policy } = argsAndPolicy(tr, subPlace(tr));
    await assert.rejects(d.run(["run", "--privileged", ...args.slice(1)], policy), DockerRunRejected);
    assert.equal(fs.existsSync(path.join(dir, "calls")), false, "거절된 인자로 docker 를 부르지 않았다");
    await d.run(args, policy);
    assert.match(fs.readFileSync(path.join(dir, "calls"), "utf8"), /^run -d --rm --name lvly-job-42-0a1b2c3d /);
  } finally {
    if (keep === undefined) delete process.env.LIVELY_DOCKER_BIN; else process.env.LIVELY_DOCKER_BIN = keep;
    fs.rmSync(dir, { recursive: true, force: true });
    tr.done();
  }
});

await t("L3 박스 사실 — 하네스 실행 파일은 ELF · 다른 계정 실행 가능이어야 한다(아니면 까닭 · 고칠 길) · docker info 의 메모리 · 스왑 상한을 읽는다 · 도커에 못 닿으면 까닭", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-dk-box-"));
  const keep = { bin: process.env.LIVELY_DOCKER_BIN, claude: process.env.LIVELY_AGENT_JOB_CLAUDE_BIN, image: process.env.LIVELY_AGENT_JOB_IMAGE };
  try {
    const elf = path.join(dir, "claude-elf"), text = path.join(dir, "claude-js"), priv = path.join(dir, "claude-priv");
    fs.writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]), { mode: 0o755 });
    fs.writeFileSync(text, "#!/usr/bin/env node\n", { mode: 0o755 });
    fs.writeFileSync(priv, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o700 });
    process.env.LIVELY_DOCKER_BIN = fakeDocker(dir, `[ "$1" = info ] && echo "8178892800 true"; exit 0`);
    process.env.LIVELY_AGENT_JOB_IMAGE = "registry.local/node:22-bookworm-slim";
    process.env.LIVELY_AGENT_JOB_CLAUDE_BIN = elf;
    const b = await probeDockerBox();
    assert.equal(b.claudeBin, fs.realpathSync(elf));
    assert.equal(b.memMb, 7800);
    assert.equal(b.swapLimit, true);
    assert.equal(b.image, "registry.local/node:22-bookworm-slim");
    assert.equal(b.gateway.uid, process.getuid?.());
    process.env.LIVELY_AGENT_JOB_CLAUDE_BIN = text;
    await assert.rejects(probeDockerBox(), /ELF.*install\.sh/s);
    process.env.LIVELY_AGENT_JOB_CLAUDE_BIN = priv;
    await assert.rejects(probeDockerBox(), /다른 계정이 실행할 수 없습니다/);
    process.env.LIVELY_AGENT_JOB_CLAUDE_BIN = path.join(dir, "none");
    await assert.rejects(probeDockerBox(), /찾지 못했습니다/);
    process.env.LIVELY_AGENT_JOB_CLAUDE_BIN = elf;
    process.env.LIVELY_DOCKER_BIN = fakeDocker(dir, `echo "Cannot connect to the Docker daemon" >&2; exit 1`);
    await assert.rejects(probeDockerBox(), /도커에 닿지 못했습니다.*docker 그룹/s);
    process.env.LIVELY_DOCKER_BIN = fakeDocker(dir, `[ "$1" = info ] && echo "8178892800 false"; exit 0`);
    assert.equal((await probeDockerBox()).swapLimit, false);
  } finally {
    for (const [k, v] of [["LIVELY_DOCKER_BIN", keep.bin], ["LIVELY_AGENT_JOB_CLAUDE_BIN", keep.claude], ["LIVELY_AGENT_JOB_IMAGE", keep.image]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  const bad = async (): Promise<DockerBox> => { m++; throw new Error("도커에 닿지 못했습니다"); };
  const r = await dockerBoxCheck({ probe: bad, now: () => now });
  assert.deepEqual(r, { ok: false, why: "도커에 닿지 못했습니다" });
  now += 14_000; await dockerBoxCheck({ probe: bad, now: () => now }); assert.equal(m, 1);
  now += 2_000; await dockerBoxCheck({ probe: bad, now: () => now }); assert.equal(m, 2);
  resetDockerProbesForTest();
});

await t("B2 관리자 보기 — 못 씀 · 상한 0 · 스왑 상한 못 걺은 «안 걸림» 과 까닭 · 된다면 «걸림» · 계정은 격리 판정 그대로(띄우기와 같은 판정)", async () => {
  const check = (r: Awaited<ReturnType<typeof dockerBoxCheck>>) => async () => r;
  const down = await dockerSurfaceStatus(3072, { check: check({ ok: false, why: "도커에 닿지 못했습니다" }) });
  assert.deepEqual([down.runsAs, down.enforced], [null, false]);
  assert.match(down.note, /도커에 닿지 못했습니다/);
  const zero = await dockerSurfaceStatus(0, { check: check({ ok: true, box: box() }) });
  assert.deepEqual([zero.runsAs, zero.enforced], ["member", false]);
  assert.match(zero.note, /7800MB/);
  const noSwap = await dockerSurfaceStatus(3072, { check: check({ ok: true, box: box({ swapLimit: false, isolated: false }) }) });
  assert.deepEqual([noSwap.runsAs, noSwap.enforced], ["gateway", false]);
  assert.match(noSwap.note, /띄우지 않습니다/);
  const ok = await dockerSurfaceStatus(3072, { check: check({ ok: true, box: box() }) });
  assert.deepEqual([ok.runsAs, ok.enforced], ["member", true]);
  //  띄우기와 같은 판정 — 스왑 상한을 못 거는 박스 · 상한 있음이면 띄우기도 거절한다(C5).
  const { d } = fakeDeps({ box: async () => box({ swapLimit: false }) });
  await failsWith(launchDockerJob(row(), SECRET, d), (e) => assert.equal(e.transient, false));
});

console.log(`\n${pass} passed`);
