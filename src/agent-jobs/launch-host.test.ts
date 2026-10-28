// 박스 위 실행면(launch-host.ts)과 실행면 고르기(surface.ts) — 사양 엣지 표의 B · C · D · E 행 (#5082).
//  띄우기는 바꿔 끼운 의존(HostLaunchDeps)으로 돌려 **무엇이 실제로 불렸나**(tmux argv · 비밀 파일 · OS 계정 · 폴더)를 기록으로 단언한다.
//  판 머리(PANE_PRELUDE)는 진짜 셸 + 진짜 부트를 가짜 게이트웨이에 대고 돌린다(비밀 파일을 읽고 지우는지 · 머리 · 포트).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { hostJobDir, hostPaneArgv, launchHostJob, killHostJob, jobMemoryLimit, PANE_PRELUDE, type HostLaunchDeps } from "./launch-host.js";
import { jobSurfaceKind, jobsUnavailableMessage } from "./surface.js";
import { JobLaunchError, killJobContainer, launchJobContainer } from "./launch.js";
import { BOOT_SOURCE } from "./runner.js";
import { computeExecTopology } from "../exec-topology.js";
import { BOX_CGSPAWN, BOX_SPAWN, cgspawnArgv, wrapAsMember, type CgroupLimit } from "../terminal/terminal-isolation.js";
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
  assert.doesNotMatch(jobsUnavailableMessage("broker"), /LIVELY_AGENT_JOBS/);
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
function fakeDeps(o: { osUser?: string | null; isolationReady?: boolean; cap?: number; cgroupOk?: boolean; tmuxFails?: Error; inactive?: boolean; profileDir?: string | null; slug?: string | null } = {}): { d: HostLaunchDeps; rec: Rec } {
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
    cgroupReady: async () => o.cgroupOk ?? true,
    writeSecret: async (os, s) => { rec.calls.push("secret"); rec.secrets.push({ osUser: os, secret: s }); return "/tmp/lvly-job.Q1w2E3r4/boot"; },
    removeSecret: async (_os, f) => { rec.removed.push(f); },
    wrap: (u, a, cwd, cg) => { rec.wraps.push(cg); return cg ? cgspawnArgv(u, a, cwd, cg) : wrapAsMember(u, a, cwd); },
    tmux: async (argv) => { rec.calls.push("tmux"); rec.tmux.push(argv); if (o.tmuxFails) throw o.tmuxFails; return ""; },
    tz: async () => "Asia/Seoul",
    slug: () => (o.slug === undefined ? null : o.slug),
    port: () => 8080,
    locale: () => "C.UTF-8",
  };
  return { d, rec };
}
const job = (over: Record<string, unknown> = {}) => ({
  id: 7, session_id: "job-7-0123abcd", requester: "alice", account_kind: "subscription", account_member: "alice", app_id: "memo", project_id: null,
  cwd: "/work/apps/memo", homeless: false, ...over,
}) as never;

await t("C5 비밀은 판 명령줄 어디에도 없다 — 판 계정 소유 비밀 파일로만(격리 · 비격리 · 워크스페이스 · 포트 모두)", async () => {
  for (const o of [{}, { osUser: null, isolationReady: false }, { slug: "acme" }, { cap: 0 }, { cgroupOk: false }]) {
    const { d, rec } = fakeDeps(o);
    await launchHostJob(job(), SECRET, d);
    assert.equal(rec.tmux.length, 1, JSON.stringify(o));
    assert.ok(rec.tmux[0]!.every((x) => !x.includes(SECRET)), `명령줄에 비밀: ${JSON.stringify(o)}`);
    assert.deepEqual(rec.secrets, [{ osUser: o.osUser === null ? null : "box_alice", secret: SECRET }], "비밀은 판 계정(격리면 그 구성원)의 파일로 한 번");
    assert.ok(rec.tmux[0]!.includes("/tmp/lvly-job.Q1w2E3r4/boot"), "판은 그 파일 경로를 받는다");
    assert.ok(rec.calls.indexOf("secret") < rec.calls.indexOf("tmux"), "파일을 먼저 두고 판을 띄운다");
  }
});

await t("C1·C2 격리 판의 메모리 상한 — 정책 상한 + 래퍼 가능이면 box-cgspawn(MemoryMax 만) · 래퍼 불가 · 상한 0 이면 그냥 sudo(상한 없이)", async () => {
  {
    const { d, rec } = fakeDeps({ cap: 3072, cgroupOk: true });
    await launchHostJob(job(), SECRET, d);
    assert.deepEqual(rec.wraps, [{ highMb: 0, maxMb: 3072, requestMb: 0 }]);
    const a = rec.tmux[0]!;
    const at = a.indexOf("sudo");
    assert.deepEqual(a.slice(at, at + 10), ["sudo", "-n", "--", BOX_CGSPAWN, "box_alice", "0", "3072M", "--", BOX_SPAWN, "--cwd"]);
  }
  for (const o of [{ cap: 3072, cgroupOk: false }, { cap: 0, cgroupOk: true }]) {
    const { d, rec } = fakeDeps(o);
    await launchHostJob(job(), SECRET, d);
    assert.deepEqual(rec.wraps, [undefined], JSON.stringify(o));
    assert.ok(!rec.tmux[0]!.includes(BOX_CGSPAWN), JSON.stringify(o));
    assert.ok(rec.tmux[0]!.includes(BOX_SPAWN), "상한 없이도 그 계정으로는 내려간다");
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

await t("C1 격리 박스 — 그 구성원 계정으로 폴더를 만들고 홈을 준비한 뒤 판(순서)", async () => {
  const { d, rec } = fakeDeps();
  await launchHostJob(job(), SECRET, d);
  assert.deepEqual(rec.calls, ["account:alice", "os-user", "dir:apps/memo", "mkdir", "home", "secret", "tmux"]);
  assert.deepEqual(rec.mkdirs, [["box_alice", "/srv/lively/apps/memo"]]);
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
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-job."));
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
  } finally { await g.close(); }
});

await t("C5 판 머리 — 워크스페이스가 빈 값이면 머리를 싣지 않는다 · 비밀 파일이 없으면 부르지 않고 3", async () => {
  const g = await bootTarget();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-job."));
    const file = path.join(dir, "boot");
    fs.writeFileSync(file, SECRET, { mode: 0o600 });
    assert.equal((await runPrelude([file, "1", String(g.port), "", BOOT_SOURCE])).code, 3);
    assert.ok(g.seen.length >= 1 && g.seen.every((s) => s.ws === undefined), JSON.stringify(g.seen));
    const before = g.seen.length;
    const r = await runPrelude([path.join(dir, "없는-파일"), "1", String(g.port), "", BOOT_SOURCE]);
    assert.equal(r.code, 3);
    assert.match(r.err, /부트 비밀을 읽지 못했습니다/);
    assert.equal(g.seen.length, before, "비밀이 없으면 게이트웨이를 부르지 않는다");
  } finally { await g.close(); }
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
