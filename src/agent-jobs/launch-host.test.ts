// 박스 위 실행면(launch-host.ts)과 실행면 고르기(surface.ts) — 사양 엣지 표의 B · C · D · E 행 (#5082).
//  띄우기는 바꿔 끼운 의존(HostLaunchDeps)으로 돌려 **무엇이 실제로 불렸나**(tmux argv · 비밀 파일 · OS 계정 · 폴더)를 기록으로 단언한다.
//  판 머리(PANE_PRELUDE)는 진짜 셸 + 진짜 부트를 가짜 게이트웨이에 대고 돌린다(비밀 파일을 읽고 지우는지 · 머리 · 포트).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { hostJobDir, hostPaneArgv, hostPaneView, launchHostJob, killHostJob, jobMemoryLimit, cgspawnCheck, resetHostProbesForTest, PANE_PRELUDE, type CgroupCheck, type HostLaunchDeps } from "./launch-host.js";
import { describeJobSurface, jobSurfaceKind, jobsUnavailableMessage, resetJobSurfaceForTest } from "./surface.js";
import { JobLaunchError, killJobContainer, launchJobContainer } from "./launch.js";
import { BOOT_SOURCE } from "./runner.js";
import { computeExecTopology } from "../exec-topology.js";
import { BOX_CGSPAWN, BOX_SPAWN, cgspawnArgv, wrapAsMember, type CgroupLimit } from "../terminal/terminal-isolation.js";
import { MEMBER_TEMP_SECRET_SCRIPT } from "../terminal/terminal-member-fs.js";
import type { LivelyUser } from "../context.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};

const SECRET = "bootSecret_Zz9-0123456789abcdefghijklmnopqrstuv";

// ── B. 실행면 고르기 ─────────────────────────────────────────────────────────────

await t("B1·B2 확보 훅이 있는 배포(매니지드)는 늘 broker — 스위치를 켜도 박스 위로 새지 않는다", () => {
  const managed = { LIVELY_TMUX_EXEC: "docker exec lvly-tmux-{slug} tmux", LIVELY_SESSION_ENSURE: "/opt/lively/libexec/session-ensure {slug}" };
  assert.equal(jobSurfaceKind(computeExecTopology({ ...managed })), "broker");
  assert.equal(jobSurfaceKind(computeExecTopology({ ...managed, LIVELY_AGENT_JOBS: "host" })), "broker");
  //  훅만 있고 중계 tmux 가 없어도(이론상 모양) 훅이 먼저다.
  assert.equal(jobSurfaceKind(computeExecTopology({ LIVELY_SESSION_ENSURE: "/x {slug}", LIVELY_AGENT_JOBS: "host" })), "broker");
});

await t("B3·B4 훅 없는 로컬 배포 — 스위치가 host 면 host, 아니면 none", () => {
  assert.equal(jobSurfaceKind(computeExecTopology({ LIVELY_AGENT_JOBS: "host" })), "host");
  assert.equal(jobSurfaceKind(computeExecTopology({ LIVELY_AGENT_JOBS: " host " })), "host");
  assert.equal(jobSurfaceKind(computeExecTopology({})), "none");
  assert.equal(jobSurfaceKind(computeExecTopology({ LIVELY_AGENT_JOBS: "Host" })), "none");
  assert.equal(jobSurfaceKind(computeExecTopology({ LIVELY_AGENT_JOBS: "docker" })), "none", "아직 없는 값은 꺼짐");
});

await t("B5·B6 노드 에이전트 프로세스 · 중계 tmux 배포(훅 없음)는 스위치와 무관하게 none — 판을 세울 자리가 아니다", () => {
  assert.equal(jobSurfaceKind(computeExecTopology({ LIVELY_NODE_TOKEN: "lvk_x", LIVELY_AGENT_JOBS: "host" })), "none");
  assert.equal(jobSurfaceKind(computeExecTopology({ LIVELY_TMUX_EXEC: "relay {slug}", LIVELY_AGENT_JOBS: "host" })), "none");
});

await t("B7 못 띄우는 배포의 501 문장은 무엇을 켜면 되는지(LIVELY_AGENT_JOBS=host)를 말한다 · 매니지드 쪽 문장은 그 스위치를 말하지 않는다", () => {
  assert.match(jobsUnavailableMessage("none"), /LIVELY_AGENT_JOBS=host/);
  assert.match(jobsUnavailableMessage("none", computeExecTopology({})), /LIVELY_AGENT_JOBS=host/);
  assert.doesNotMatch(jobsUnavailableMessage("broker"), /LIVELY_AGENT_JOBS/);
});

await t("S1 세션 spawn 훅(LIVELY_SESSION_SPAWN)이 있는 로컬 배포는 스위치를 켜도 none — 501 문장은 그 훅을 말하고 «켜면 된다» 고 하지 않는다", () => {
  const topo = computeExecTopology({ LIVELY_SESSION_SPAWN: "/opt/x/spawn", LIVELY_AGENT_JOBS: "host" });
  assert.equal(jobSurfaceKind(topo), "none");
  const m = jobsUnavailableMessage("none", topo);
  assert.match(m, /LIVELY_SESSION_SPAWN/);
  assert.doesNotMatch(m, /LIVELY_AGENT_JOBS=host 를 넣고/);
  //  노드 · 중계 배포도 까닭을 말한다(스위치 안내가 아니다).
  assert.doesNotMatch(jobsUnavailableMessage("none", computeExecTopology({ LIVELY_NODE_TOKEN: "lvk_x", LIVELY_AGENT_JOBS: "host" })), /LIVELY_AGENT_JOBS=host 를 넣고/);
});

await t("R1 관리자 보기 — 이 시험 프로세스(스위치 없음)는 none · 못 띄우는 까닭(501 문장과 같다) · 계정 없음 · 상한 안 걸림", async () => {
  const ambient = computeExecTopology(process.env);
  if (jobSurfaceKind(ambient) !== "none") { console.log("# R1 건너뜀 — 이 시험 프로세스의 env 가 실행면을 켰다"); return; }
  resetJobSurfaceForTest();
  const v = await describeJobSurface(3072);
  assert.equal(v.kind, "none");
  assert.equal(v.available, false);
  assert.equal(v.unavailable, jobsUnavailableMessage("none", ambient));
  assert.equal(v.runs_as, null);
  assert.deepEqual({ mb: v.memory_cap.mb, enforced: v.memory_cap.enforced }, { mb: 3072, enforced: false });
  resetJobSurfaceForTest();
});

// ── D. 작업 폴더 대응 ────────────────────────────────────────────────────────────

await t("D1 행의 두 꼴 → 박스 위 루트와 경로(앱 폴더 · 공유 자리의 project/<n>)", () => {
  assert.deepEqual(hostJobDir("/work/apps/memo"), { root: "apps", sub: "memo" });
  assert.deepEqual(hostJobDir("/work/apps/a1-crm"), { root: "apps", sub: "a1-crm" });
  assert.deepEqual(hostJobDir("/work/shared/project/7"), { root: "shared", sub: "project/7" });
  assert.deepEqual(hostJobDir("/work/shared/project/4478"), { root: "shared", sub: "project/4478" });
});

await t("D2 꼴 밖은 옮기지 않는다 — `..` · 규칙 밖 앱 id · 하위 폴더 · 0/음수/소수/선행0 프로젝트 · 다른 루트", () => {
  for (const bad of ["/work/apps/../x", "/work/apps/..", "/work/apps/Memo", "/work/apps/m", "/work/apps/memo/sub", "/work/apps/memo/", "/work/apps/",
    "/work/shared/project/0", "/work/shared/project/-1", "/work/shared/project/1.5", "/work/shared/project/07", "/work/shared/project/7/x",
    "/work/shared/x", "/work/shared/project/", "/tmp", "", "work/apps/memo", "/work/apps/memo\n"]) {
    assert.equal(hostJobDir(bad), null, JSON.stringify(bad));
  }
});

// ── C. 판 인자 ───────────────────────────────────────────────────────────────────

const argvBase = { sessionId: "job-7-0123abcd", jobId: 7, secretFile: "/tmp/lvly-job.AbC123xy/boot", hostCwd: "/srv/lively/apps/memo", tz: "Asia/Seoul", locale: "C.UTF-8", port: 8080 };

await t("C1 격리 판 — sudo box-spawn 으로 그 계정에 내려가 작업 폴더로 들어간다(tmux -c 없음) · 판 머리 + 인자 + 부트", () => {
  const a = hostPaneArgv({ ...argvBase, slug: null, osUser: "box_alice", profileDir: null, wrap: (x) => wrapAsMember("box_alice", x, argvBase.hostCwd) });
  assert.equal(a[0], "new-session");
  assert.equal(a[a.indexOf("-s") + 1], "job-7-0123abcd");
  const at = a.indexOf("sudo");
  assert.ok(at > 0, JSON.stringify(a));
  assert.deepEqual(a.slice(at), ["sudo", "-n", "-u", "box_alice", "--", BOX_SPAWN, "--cwd", "/srv/lively/apps/memo",
    "sh", "-c", PANE_PRELUDE, "lvly-job", "/tmp/lvly-job.AbC123xy/boot", "7", "8080", "", BOOT_SOURCE]);
  assert.ok(!a.slice(0, at).includes("-c"), "격리 판은 tmux -c 를 쓰지 않는다(게이트웨이 권한으로 멤버 자리에 못 들어간다)");
  assert.ok(!a.some((x) => x.startsWith("CLAUDE_CONFIG_DIR=")), "격리 판은 멤버 홈의 ~/.claude 를 쓴다");
  assert.ok(a.includes("LIVELY_SESSION_KIND=task"));
  assert.ok(!a.some((x) => x.startsWith("LVLY_TENANT_SLUG=")), "워크스페이스가 없으면 싣지 않는다");
});

await t("C3·C3b 비격리 판 — sudo 없이 tmux -c 작업 폴더 · 그 사람의 Claude 설정 폴더(단일 계정이면 없음)", () => {
  const a = hostPaneArgv({ ...argvBase, hostCwd: "/Users/lively/apps/memo", slug: null, osUser: null, profileDir: "/Users/lively/.lively/profiles/alice/claude", wrap: () => { throw new Error("비격리는 wrap 을 부르지 않는다"); } });
  assert.ok(!a.includes("sudo"));
  assert.equal(a[a.indexOf("-c") + 1], "/Users/lively/apps/memo");
  assert.ok(a.includes("CLAUDE_CONFIG_DIR=/Users/lively/.lively/profiles/alice/claude"));
  const sh = a.indexOf("sh");
  assert.deepEqual(a.slice(sh), ["sh", "-c", PANE_PRELUDE, "lvly-job", "/tmp/lvly-job.AbC123xy/boot", "7", "8080", "", BOOT_SOURCE]);
  const single = hostPaneArgv({ ...argvBase, slug: null, osUser: null, profileDir: null, wrap: () => [] });
  assert.ok(!single.some((x) => x.startsWith("CLAUDE_CONFIG_DIR=")), "단일 계정 스위치면 박스 계정의 ~/.claude 그대로");
});

await t("C4 워크스페이스가 있으면 판 env(LVLY_TENANT_SLUG)와 판 머리 인자 둘 다에 · 포트도 인자로", () => {
  const a = hostPaneArgv({ ...argvBase, port: 18080, slug: "acme", osUser: "box_alice", profileDir: null, wrap: (x) => wrapAsMember("box_alice", x, argvBase.hostCwd) });
  assert.ok(a.includes("LVLY_TENANT_SLUG=acme"));
  const sh = a.indexOf(PANE_PRELUDE);
  assert.deepEqual(a.slice(sh + 1, sh + 6), ["lvly-job", "/tmp/lvly-job.AbC123xy/boot", "7", "18080", "acme"]);
});

// ── C. 띄우기 흐름(바꿔 끼운 의존) ────────────────────────────────────────────────

interface Rec { calls: string[]; tmux: string[][]; secrets: Array<{ osUser: string | null; secret: string }>; removed: string[]; mkdirs: Array<[string | null, string]>; wraps: Array<CgroupLimit | undefined> }
function fakeDeps(o: { osUser?: string | null; isolationReady?: boolean; cap?: number; cgroup?: CgroupCheck | Error; tmuxFails?: Error; inactive?: boolean; profileDir?: string | null; slug?: string | null; port?: number } = {}): { d: HostLaunchDeps; rec: Rec } {
  const rec: Rec = { calls: [], tmux: [], secrets: [], removed: [], mkdirs: [], wraps: [] };
  const osUser = o.osUser === undefined ? "box_alice" : o.osUser;
  const d: HostLaunchDeps = {
    accountUser: async (m) => {
      rec.calls.push(`account:${m}`);
      if (o.inactive) throw new JobLaunchError(`실행 계정(${m})이 활성 사람 구성원이 아닙니다`);
      return { userId: m, scopes: [] } as unknown as LivelyUser;
    },
    ensureOsUser: async () => { rec.calls.push("os-user"); return osUser; },
    isolationReady: () => o.isolationReady ?? true,
    resolveDir: async (_u, dir, os) => { rec.calls.push(`dir:${dir.root}/${dir.sub}`); return os ? `/srv/lively/${dir.root}/${dir.sub}` : `/home/gw/${dir.root}/${dir.sub}`; },
    mkdir: async (os, abs) => { rec.calls.push("mkdir"); rec.mkdirs.push([os, abs]); },
    prepareHome: async () => { rec.calls.push("home"); },
    profileDir: async () => { rec.calls.push("profile"); return o.profileDir === undefined ? "/home/gw/.lively/profiles/alice/claude" : o.profileDir; },
    memoryLimit: async () => jobMemoryLimit(o.cap ?? 3072),
    cgroupCheck: async () => { rec.calls.push("cgroup"); if (o.cgroup instanceof Error) throw o.cgroup; return o.cgroup ?? { ok: true }; },
    writeSecret: async (os, s) => { rec.calls.push("secret"); rec.secrets.push({ osUser: os, secret: s }); return "/tmp/lvly-job.Q1w2E3r4/boot"; },
    removeSecret: async (_os, f) => { rec.removed.push(f); },
    wrap: (u, a, cwd, cg) => { rec.wraps.push(cg); return cg ? cgspawnArgv(u, a, cwd, cg) : wrapAsMember(u, a, cwd); },
    tmux: async (argv) => { rec.calls.push("tmux"); rec.tmux.push(argv); if (o.tmuxFails) throw o.tmuxFails; return ""; },
    tz: async () => "Asia/Seoul",
    slug: () => (o.slug === undefined ? null : o.slug),
    port: () => o.port ?? 8080,
    locale: () => "C.UTF-8",
  };
  return { d, rec };
}
const job = (over: Record<string, unknown> = {}) => ({
  id: 7, session_id: "job-7-0123abcd", requester: "alice", account_kind: "subscription", account_member: "alice", app_id: "memo", project_id: null,
  cwd: "/work/apps/memo", homeless: false, ...over,
}) as never;

await t("C5 비밀은 판 명령줄 어디에도 없다 — 판 계정 소유 비밀 파일로만(격리 · 비격리 · 워크스페이스 · 포트 모두)", async () => {
  for (const o of [{}, { osUser: null, isolationReady: false }, { slug: "acme" }, { cap: 0 }, { port: 18080 }]) {
    const { d, rec } = fakeDeps(o);
    await launchHostJob(job(), SECRET, d);
    assert.equal(rec.tmux.length, 1, JSON.stringify(o));
    assert.ok(rec.tmux[0]!.every((x) => !x.includes(SECRET)), `명령줄에 비밀: ${JSON.stringify(o)}`);
    assert.deepEqual(rec.secrets, [{ osUser: o.osUser === null ? null : "box_alice", secret: SECRET }], "비밀은 판 계정(격리면 그 구성원)의 파일로 한 번");
    assert.ok(rec.tmux[0]!.includes("/tmp/lvly-job.Q1w2E3r4/boot"), "판은 그 파일 경로를 받는다");
    assert.ok(rec.calls.indexOf("secret") < rec.calls.indexOf("tmux"), "파일을 먼저 두고 판을 띄운다");
  }
});

await t("M1 격리 판 · 정책 상한 3072 · 래퍼를 쓸 수 있다 — box-cgspawn(MemoryMax 만)", async () => {
  const { d, rec } = fakeDeps({ cap: 3072, cgroup: { ok: true } });
  await launchHostJob(job(), SECRET, d);
  assert.deepEqual(rec.wraps, [{ highMb: 0, maxMb: 3072, requestMb: 0 }]);
  const a = rec.tmux[0]!;
  const at = a.indexOf("sudo");
  assert.deepEqual(a.slice(at, at + 10), ["sudo", "-n", "--", BOX_CGSPAWN, "box_alice", "0", "3072M", "--", BOX_SPAWN, "--cwd"]);
});

await t("M2 격리 판 · 정책 상한 · 래퍼를 확답으로 못 쓴다(없음 · sudo 허용 없음) — 다시 해도 안 되는 실패 · 고칠 길을 말한다 · 폴더 · 비밀 · 판 없음", async () => {
  for (const why of ["cgroup 래퍼(/opt/lively/libexec/box-cgspawn)가 이 박스에 없습니다", "게이트웨이 계정이 cgroup 래퍼를 비밀번호 없이 sudo 로 쓸 수 없습니다"]) {
    const { d, rec } = fakeDeps({ cap: 3072, cgroup: { ok: false, transient: false, why } });
    await assert.rejects(launchHostJob(job(), SECRET, d), (e: unknown) => e instanceof JobLaunchError && e.transient === false
      && e.message.includes("3072MB") && e.message.includes(why) && /memory_max_mb 를 0/.test(e.message) && /install-isolation\.sh/.test(e.message));
    assert.ok(!["mkdir", "home", "secret", "tmux"].some((c) => rec.calls.includes(c)), JSON.stringify(rec.calls));
  }
});

await t("M3 격리 판 · 정책 상한 · 묻다 끊겼다(일시 답 · 던짐) — 일시(memory) 실패 · 폴더 · 비밀 · 판 없음", async () => {
  for (const cgroup of [{ ok: false, transient: true, why: "sudo 가 5초 안에 답하지 않았습니다" } as CgroupCheck, new Error("spawn EAGAIN")]) {
    const { d, rec } = fakeDeps({ cap: 3072, cgroup });
    await assert.rejects(launchHostJob(job(), SECRET, d), (e: unknown) => e instanceof JobLaunchError && e.transient === true && /메모리 상한/.test(e.message));
    assert.ok(!["mkdir", "home", "secret", "tmux"].some((c) => rec.calls.includes(c)), JSON.stringify(rec.calls));
  }
});

await t("M4·M5 상한 0(격리) · 비격리 박스(상한 3072) — 래퍼를 묻지 않고 띄운다(상한 없이)", async () => {
  {
    const { d, rec } = fakeDeps({ cap: 0, cgroup: { ok: false, transient: false, why: "묻지 않아야 한다" } });
    await launchHostJob(job(), SECRET, d);
    assert.ok(!rec.calls.includes("cgroup"), "상한 0 이면 묻지 않는다");
    assert.deepEqual(rec.wraps, [undefined]);
    assert.ok(!rec.tmux[0]!.includes(BOX_CGSPAWN) && rec.tmux[0]!.includes(BOX_SPAWN), "상한 없이도 그 계정으로는 내려간다");
  }
  {
    const { d, rec } = fakeDeps({ osUser: null, isolationReady: false, cap: 3072, cgroup: { ok: false, transient: false, why: "묻지 않아야 한다" } });
    await launchHostJob(job(), SECRET, d);
    assert.ok(!rec.calls.includes("cgroup"), "비격리 박스는 걸 자리가 없다 — 묻지 않는다");
    assert.equal(rec.tmux.length, 1);
    assert.ok(!rec.tmux[0]!.includes(BOX_CGSPAWN));
  }
});

await t("C3 비격리 박스(OS 계정 null · 격리 미지원) — 게이트웨이 계정 · 박스 위 폴더를 게이트웨이가 만든다 · 홈 준비 없음 · 상한 없음", async () => {
  const { d, rec } = fakeDeps({ osUser: null, isolationReady: false });
  await launchHostJob(job({ cwd: "/work/shared/project/7", project_id: 7, app_id: null }), SECRET, d);
  assert.deepEqual(rec.mkdirs, [[null, "/home/gw/shared/project/7"]]);
  assert.ok(!rec.calls.includes("home"), "비격리 박스의 사람 세션도 홈 준비를 하지 않는다");
  assert.deepEqual(rec.wraps, [], "sudo 래퍼를 부르지 않는다");
  const a = rec.tmux[0]!;
  assert.equal(a[a.indexOf("-c") + 1], "/home/gw/shared/project/7");
  assert.ok(a.includes("CLAUDE_CONFIG_DIR=/home/gw/.lively/profiles/alice/claude"));
});

await t("C1 격리 박스 — 그 구성원 계정 · 상한을 걸 수 있는지 본 뒤 폴더를 만들고 홈을 준비하고 판(순서)", async () => {
  const { d, rec } = fakeDeps();
  await launchHostJob(job(), SECRET, d);
  assert.deepEqual(rec.calls, ["account:alice", "os-user", "cgroup", "dir:apps/memo", "mkdir", "home", "secret", "tmux"]);
  assert.deepEqual(rec.mkdirs, [["box_alice", "/srv/lively/apps/memo"]]);
});

await t("V1 판의 첫 말 자리 — 띄울 때 만든 폴더와 같은 경로(앱 · 공유 × 격리 · 비격리) · 게이트웨이 = 그 루프백 포트 · 워크스페이스 = 판에 넘긴 값", async () => {
  for (const [o, j] of [
    [{}, job()], [{ osUser: null, isolationReady: false }, job()],
    [{ slug: "acme", port: 18080 }, job({ cwd: "/work/shared/project/7", project_id: 7, app_id: null })],
    [{ osUser: null, isolationReady: false, slug: "acme" }, job({ cwd: "/work/shared/project/7", project_id: 7, app_id: null })],
  ] as const) {
    const { d, rec } = fakeDeps(o);
    await launchHostJob(j, SECRET, d);
    const v = await hostPaneView(j, d);
    assert.equal(v.cwd, rec.mkdirs[0]![1], `띄울 때 만든 폴더에서 돈다: ${JSON.stringify(o)}`);
    assert.equal(v.gateway, `http://127.0.0.1:${(o as { port?: number }).port ?? 8080}`);
    assert.equal(v.workspace, (o as { slug?: string }).slug ?? null);
    const a = rec.tmux[0]!;
    const sh = a.indexOf(PANE_PRELUDE);
    assert.deepEqual(a.slice(sh + 4, sh + 6), [v.gateway.split(":").pop(), v.workspace ?? ""], "판 머리가 받은 포트 · 워크스페이스와 같다");
  }
});

await t("V2 격리 박스인데 첫 말 때 OS 계정이 없다 — 던진다(그 작업은 실패로 끝난다)", async () => {
  const { d } = fakeDeps({ osUser: null, isolationReady: true });
  await assert.rejects(hostPaneView(job(), d), /OS 계정/);
  await assert.rejects(hostPaneView(job({ cwd: "/tmp" }), fakeDeps().d), /박스 위 자리/);
});

await t("C6 홈 없는 작업은 박스 위 길에서 띄우지 않는다 — 다시 해도 안 되는 실패 · 아무것도 안 부른다", async () => {
  const { d, rec } = fakeDeps();
  await assert.rejects(launchHostJob(job({ homeless: true, account_kind: "api_key", account_member: null }), SECRET, d),
    (e: unknown) => e instanceof JobLaunchError && e.transient === false && /홈 없는/.test(e.message));
  assert.deepEqual(rec.calls, []);
});

await t("C7 세션 id 없음 · 꼴 밖 세션 id · 실행 계정 없음 · 작업 폴더 꼴 밖 — 다시 해도 안 되는 실패 · 부수효과 0", async () => {
  for (const o of [{ session_id: null }, { session_id: "box-alice-1" }, { account_member: null }, { cwd: "/work/apps/../etc" }, { cwd: "/tmp" }]) {
    const { d, rec } = fakeDeps();
    await assert.rejects(launchHostJob(job(o), SECRET, d), (e: unknown) => e instanceof JobLaunchError && e.transient === false, JSON.stringify(o));
    assert.deepEqual(rec.calls, [], JSON.stringify(o));
  }
  const { d, rec } = fakeDeps({ inactive: true });
  await assert.rejects(launchHostJob(job(), SECRET, d), (e: unknown) => e instanceof JobLaunchError && e.transient === false && /활성 사람/.test(e.message));
  assert.deepEqual(rec.calls, ["account:alice"], "비활성 실행 계정은 OS 계정 · 폴더 · 판 앞에서 끝난다");
});

await t("C8 격리를 지원하는 박스인데 OS 계정을 못 만들었다 — 게이트웨이 계정으로 내려앉지 않고 일시(os-user) 실패 · 판을 안 띄운다", async () => {
  const { d, rec } = fakeDeps({ osUser: null, isolationReady: true });
  await assert.rejects(launchHostJob(job(), SECRET, d), (e: unknown) => e instanceof JobLaunchError && e.transient === true && /OS 계정/.test(e.message));
  assert.ok(!rec.calls.includes("tmux") && !rec.calls.includes("secret") && !rec.calls.includes("mkdir"), JSON.stringify(rec.calls));
});

await t("C9 판 명령이 실패 — 일시(pane) 실패 · 문장에 비밀이 없다 · 둔 비밀 파일을 지운다", async () => {
  const boom = Object.assign(new Error(`Command failed: tmux new-session … ${SECRET} …`), { stderr: "no space" });
  const { d, rec } = fakeDeps({ tmuxFails: boom });
  await assert.rejects(launchHostJob(job(), SECRET, d), (e: unknown) => e instanceof JobLaunchError && e.transient === true && !e.message.includes(SECRET) && /판/.test(e.message));
  assert.deepEqual(rec.removed, ["/tmp/lvly-job.Q1w2E3r4/boot"]);
});

await t("C2 작업 정책 상한 → cgroup 상한: 0 · 음수 · NaN 은 상한 없음 · 소수는 내림", () => {
  assert.deepEqual(jobMemoryLimit(3072), { highMb: 0, maxMb: 3072, requestMb: 0 });
  assert.deepEqual(jobMemoryLimit(1536.9), { highMb: 0, maxMb: 1536, requestMb: 0 });
  for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(jobMemoryLimit(v), undefined, String(v));
});

// ── P. 래퍼를 쓸 수 있나(sudo -n -l) — 확답만 기억한다 ─────────────────────────────────

function probeSpy(codes: Array<number | null>): { probe: (cmd: string) => Promise<{ code: number | null; error?: string }>; asked: string[] } {
  const asked: string[] = [];
  return { asked, probe: async (cmd) => { asked.push(cmd); const code = codes.length ? codes.shift()! : 0; return code === null ? { code, error: "sudo 가 5초 안에 답하지 않았습니다" } : { code }; } };
}

await t("P1 래퍼 파일이 없다 — 확답 «없다»(일시 아님) · sudo 를 묻지 않는다", async () => {
  resetHostProbesForTest();
  const s = probeSpy([0]);
  const r = await cgspawnCheck({ infraReady: () => false, wrapper: "/opt/x/box-cgspawn", probe: s.probe, now: () => 1 });
  assert.deepEqual(r, { ok: false, transient: false, why: "cgroup 래퍼(/opt/x/box-cgspawn)가 이 박스에 없습니다" });
  assert.deepEqual(s.asked, []);
});

await t("P2·P3·P5 끝 0 = 된다 · 끝 1 = 못 쓴다(확답) — 10분 기억하고 지나면 다시 묻는다", async () => {
  for (const [code, ok] of [[0, true], [1, false]] as const) {
    resetHostProbesForTest();
    const s = probeSpy([code, code]);
    let now = 1_000;
    const o = { infraReady: () => true, wrapper: "/opt/x/box-cgspawn", probe: s.probe, now: () => now };
    const first = await cgspawnCheck(o);
    assert.equal(first.ok, ok);
    if (!first.ok) assert.equal(first.transient, false, "확답이다");
    now += 10 * 60_000 - 1;
    assert.deepEqual(await cgspawnCheck(o), first, "10분 안엔 기억한 답");
    assert.deepEqual(s.asked, ["/opt/x/box-cgspawn"], "한 번만 물었다");
    now += 2;
    await cgspawnCheck(o);
    assert.equal(s.asked.length, 2, "10분이 지나면 다시 묻는다");
  }
});

await t("P4 묻다 끊겼다(시간 초과) · 알 수 없는 끝(2) — 일시 · 기억하지 않는다(다음 판에 다시 묻는다)", async () => {
  for (const code of [null, 2]) {
    resetHostProbesForTest();
    const s = probeSpy([code, 0]);
    const o = { infraReady: () => true, wrapper: "/opt/x/box-cgspawn", probe: s.probe, now: () => 5 };
    const r = await cgspawnCheck(o);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.transient, true, String(code));
    assert.deepEqual(await cgspawnCheck(o), { ok: true }, "같은 시각이라도 다시 물어 새 답을 받는다");
    assert.equal(s.asked.length, 2);
  }
  resetHostProbesForTest();
});

// ── W. 판 계정의 임시 비밀 스크립트(memberWriteTempSecret) — 진짜 셸 ───────────────────

function runTempSecret(input: string, tmp: string, prefix = ""): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("sh", ["-c", `${prefix}${MEMBER_TEMP_SECRET_SCRIPT}`], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, TMPDIR: tmp } });
    let out = "";
    p.stdout.on("data", (x) => { out += x; });
    p.on("close", (code) => resolve({ code, out }));
    p.stdin.on("error", () => undefined);
    p.stdin.end(input);
  });
}

await t("W1 임시 비밀 — 경로 한 줄 · 새 폴더 0700 · 파일 0600 · 내용 = 입력", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lvj-w1-"));
  try {
    const r = await runTempSecret(SECRET, tmp);
    assert.equal(r.code, 0);
    assert.match(r.out, new RegExp(`^${tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/lvly-job\\.[A-Za-z0-9]{8}/boot$`));
    assert.equal(fs.statSync(path.dirname(r.out)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(r.out).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(r.out, "utf8"), SECRET);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

await t("W2 임시 비밀 — 쓰기가 실패하면(파일 크기 한도 0) 0 아닌 끝 · 만든 폴더를 남기지 않는다", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lvj-w2-"));
  try {
    const r = await runTempSecret(SECRET, tmp, "ulimit -f 0; trap '' XFSZ; ");
    assert.notEqual(r.code, 0);
    assert.equal(r.out, "");
    assert.deepEqual(fs.readdirSync(tmp), [], "lvly-job.* 폴더가 남지 않는다");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── C5 판 머리를 진짜 셸로 — 비밀 파일을 읽고 지운 뒤 부트가 그 비밀 · 포트 · 워크스페이스로 부른다 ──

async function bootTarget(): Promise<{ port: number; seen: Array<{ url: string; auth: string | undefined; ws: string | string[] | undefined }>; close: () => Promise<void> }> {
  const seen: Array<{ url: string; auth: string | undefined; ws: string | string[] | undefined }> = [];
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ url: String(req.url), auth: req.headers.authorization, ws: req.headers["x-lively-workspace"] });
      //  부트는 401(남의 작업으로 본다) → 판은 실패를 알리고 3 으로 끝난다 — 머리 · 포트 · 비밀만 보면 된다.
      res.writeHead(req.url?.endsWith("/boot") ? 401 : 200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { port: (srv.address() as { port: number }).port, seen, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
function runPrelude(args: string[]): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    const p = spawn("sh", ["-c", PANE_PRELUDE, "lvly-job", ...args], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, LVLY_JOB_BOOT: "", LVLY_JOB_ID: "", LVLY_JOB_PORT: "", LVLY_JOB_WS: "" } });
    let err = "";
    p.stderr.on("data", (x) => { err += x; });
    const kill = setTimeout(() => p.kill("SIGKILL"), 20_000);
    p.on("close", (code) => { clearTimeout(kill); resolve({ code, err }); });
  });
}

await t("C5·F2·F3 판 머리(진짜 셸) — 비밀 파일을 읽고 파일 · 폴더를 지운 뒤 부트가 그 비밀로 · 인자의 포트로 · 워크스페이스 머리를 싣고 부른다", async () => {
  const g = await bootTarget();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-job."));
  try {
    const file = path.join(dir, "boot");
    fs.writeFileSync(file, SECRET, { mode: 0o600 });
    const r = await runPrelude([file, "1", String(g.port), "acme", BOOT_SOURCE]);
    assert.equal(r.code, 3, `부트 401 → 실패 보고 뒤 3 (stderr: ${r.err.slice(0, 200)})`);
    assert.ok(!fs.existsSync(file), "비밀 파일을 지웠다");
    assert.ok(!fs.existsSync(dir), "임시 폴더도 지웠다");
    assert.deepEqual(g.seen.map((x) => x.url), ["/api/agent-jobs/1/boot", "/api/agent-jobs/1/boot-failed"], "부트 → 실패 보고, 둘 다 인자로 받은 포트로");
    for (const s of g.seen) {
      assert.equal(s.auth, `Bearer ${SECRET}`, "파일의 비밀이 그대로");
      assert.equal(s.ws, "acme", "워크스페이스 머리");
    }
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

await t("C5 판 머리 — 워크스페이스가 빈 값이면 머리를 싣지 않는다 · 비밀 파일이 없으면 부르지 않고 3", async () => {
  const g = await bootTarget();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-job."));
  try {
    const file = path.join(dir, "boot");
    fs.writeFileSync(file, SECRET, { mode: 0o600 });
    assert.equal((await runPrelude([file, "1", String(g.port), "", BOOT_SOURCE])).code, 3);
    assert.ok(g.seen.length >= 1 && g.seen.every((s) => s.ws === undefined), JSON.stringify(g.seen));
    const before = g.seen.length;
    const r = await runPrelude([path.join(dir, "없는-파일"), "1", String(g.port), "", BOOT_SOURCE]);
    assert.equal(r.code, 3);
    assert.match(r.err, /부트 비밀을 읽지 못했습니다/);
    assert.equal(g.seen.length, before, "비밀이 없으면 게이트웨이를 부르지 않는다");
  } finally { await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── E. 걷기 ──────────────────────────────────────────────────────────────────────

const tmuxErr = (stderr: string): Error => Object.assign(new Error(`Command failed: tmux kill-session\n${stderr}`), { code: 1, stderr });

await t("E2 박스 위 걷기 — 세션 없음 · tmux 서버 자체가 없음 · 소켓 없음/거절은 조용히 걷힘(한 번 부른다)", async () => {
  for (const stderr of ["can't find session: job-7-0123abcd", "no server running on /tmp/tmux-1000/default",
    "error connecting to /tmp/tmux-1000/default (No such file or directory)", "error connecting to /tmp/tmux-501/lvly-acme (Connection refused)"]) {
    const calls: string[][] = [];
    await killHostJob("job-7-0123abcd", async (a) => { calls.push(a); throw tmuxErr(stderr); });
    assert.deepEqual(calls, [["kill-session", "-t", "job-7-0123abcd"]], stderr);
  }
  const calls: string[][] = [];
  await killHostJob("job-7-0123abcd", async (a) => { calls.push(a); return ""; });
  assert.deepEqual(calls, [["kill-session", "-t", "job-7-0123abcd"]]);
});

await t("E3 박스 위 걷기 — 권한 · 시간 초과 · 신호는 확답이 아니라 던진다(다음 감시가 다시 걷는다)", async () => {
  const perm = tmuxErr("error connecting to /tmp/tmux-1000/default (Permission denied)");
  const timedOut = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", stderr: "" });
  const other = tmuxErr("server exited unexpectedly");
  for (const e of [perm, timedOut, other]) {
    await assert.rejects(killHostJob("job-7-0123abcd", async () => { throw e; }), (x: unknown) => x === e);
  }
});

// ── 두 실행면이 같은 표 — 걷기의 마지막 자리 · 다시 해도 안 될 띄우기 ─────────────────

await t("계약 E1 — 브로커 · 박스 위 둘 다 `job-` 꼴이 아니면 tmux 를 부르지 않고 던진다(사람 세션 · 빈 값 · 옵션 모양)", async () => {
  const kills: Array<[string, (sid: string, run: (a: string[]) => Promise<unknown>) => Promise<void>]> = [
    ["broker", (sid, run) => killJobContainer(sid, run, () => false)],
    ["host", (sid, run) => killHostJob(sid, run)],
  ];
  for (const [name, kill] of kills) {
    const calls: string[][] = [];
    for (const bad of ["box-alice-1", "", "-t", "job-0-0123abcd", "job-7-0123ABCD", "job-7-0123abcd;x", "job-7"]) {
      await assert.rejects(kill(bad, async (a) => { calls.push(a); return ""; }), /작업 세션 id 꼴이 아니다/, `${name} ${bad}`);
    }
    assert.deepEqual(calls, [], `${name} 은 한 번도 부르지 않았다`);
  }
});

await t("계약 C7 — 브로커 · 박스 위 둘 다 세션 id 없음 · 실행 계정 없음은 다시 해도 안 되는 실패(일시 아님)", async () => {
  const launches: Array<[string, (j: never) => Promise<unknown>]> = [
    ["broker", (j) => launchJobContainer(j, SECRET)],
    ["host", (j) => launchHostJob(j, SECRET, fakeDeps().d)],
  ];
  for (const [name, launch] of launches) {
    await assert.rejects(launch(job({ session_id: null })), (e: unknown) => e instanceof JobLaunchError && e.transient === false && /세션 id/.test(e.message), `${name} 세션 id`);
    await assert.rejects(launch(job({ account_member: null })), (e: unknown) => e instanceof JobLaunchError && e.transient === false && /실행 계정/.test(e.message), `${name} 실행 계정`);
  }
});

console.log(`# ${pass} pass`);
