// 로그인 판 스크립트(run.mjs)의 **실행 계약** (#4067) — 가짜 CLI · 가짜 게이트웨이(HTTP) · 실제 tmux 로 부작용을 본다.
//  (게이트웨이에 무엇이 · 어떤 비밀로 · 어떤 모양으로 갔나 · CLI 가 무엇을 받았나 · 끝나면 무엇이 남나)
//  행 번호(K23…)는 스크래치패드 spec-4067-core.md 의 엣지 표다.
//  ⚠ 윈도우는 통째로 건너뛴다 — 판은 리눅스 CP 에서만 돈다(tmux·POSIX 신호).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { LOGIN_JOB_SPECS, LOGIN_JOB_TIMING, REDACTED, loginJobRunScript, loginJobSpec, redactSecrets, type LoginJobTiming } from "./login-job-script.js";

if (process.platform === "win32") {
  console.log("skip  판 스크립트는 리눅스 CP 전용");
  process.exit(0);
}

let pass = 0;
//  만든 임시 폴더는 끝날 때 치운다(시험마다 판 작업 폴더 하나 — 남기면 쌓인다).
const made: string[] = [];
process.on("exit", () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TMUX = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
const SECRET = "job-secret-" + "q".repeat(40);
const TOKEN = "sk-ant-oat01-" + "Tk9_-".repeat(20);
//  JWT 모양의 **가짜** 값 — 조각을 이어 만든다(한 덩어리 리터럴이면 비밀 검사기가 진짜 토큰으로 본다).
const JWT = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJ1c2VyLTEyMyJ9", "c2lnbmF0dXJlLXNpZ25hdHVyZQ"].join(".");
const CODE = "authcode#state-XYZ";
const FAST = { tickMs: 100 };

// ── 가짜 CLI ──────────────────────────────────────────────────────────────────
//  모드는 env(FAKE_MODE)로 받는다 — 판이 CLI 에게 env 를 그대로 물려주는지도 함께 본다.
const FAKE_JS = String.raw`
const fs = require("fs"), path = require("path");
const E = process.env;
const log = (o) => fs.appendFileSync(E.FAKE_LOG, JSON.stringify(o) + "\n");
log({ argv: process.argv.slice(2), home: E.HOME, codexHome: E.CODEX_HOME, hasCredDir: "CREDENTIALS_DIRECTORY" in E,
  tty: !!process.stdout.isTTY, pid: process.pid, cwd: process.cwd() });
const out = (s) => process.stdout.write(s);
const readLine = () => new Promise((res) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) res(buf.slice(0, i).replace(/\r$/, "")); });
});
const hang = () => setInterval(() => {}, 1000);
(async () => {
  switch (E.FAKE_MODE) {
    case "device": {
      out("Welcome\n1. Open https://auth.openai.com/codex/device\n  ABCD-1234\nWaiting...\n");
      await new Promise((r) => setTimeout(r, 600));
      const dir = E.FAKE_TARGET_DIR === "grok" ? path.join(E.HOME, ".grok") : E.CODEX_HOME;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: E.FAKE_JWT } }));
      out("Successfully logged in\n");
      process.exit(0);
    }
    case "paste": {
      out("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1\nPaste code here if prompted > ");
      const got = await readLine();
      log({ pasted: got });
      if (got !== E.FAKE_CODE) { out("\nError: invalid code\n"); process.exit(1); }
      fs.mkdirSync(path.join(E.HOME, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(E.HOME, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "at", refreshToken: "rt" } }));
      fs.writeFileSync(path.join(E.HOME, ".claude.json"), JSON.stringify({ numStartups: 1, oauthAccount: { emailAddress: "s@example.com", organizationUuid: "org-1" } }));
      out("\nLogin successful.\n");
      process.exit(0);
    }
    case "setup-token": {
      //  실측 성질 — TTY 가 아니면 아무것도 안 찍고 기다린다.
      if (!process.stdout.isTTY) { hang(); return; }
      //  Ink 처럼 **창 폭에서 줄을 직접 끊는다**(터미널의 소프트 줄바꿈이 아니다 — capture-pane -J 로 못 잇는다).
      const cols = process.stdout.columns || 80;
      const wrap = (s) => s.split("\n").map((l) => l.match(new RegExp(".{1," + cols + "}", "g"))?.join("\n") ?? "").join("\n");
      log({ cols });
      out(wrap("Browser didn't open? Use the url below to sign in:\n\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&scope=user%3Ainference&state=abcdefghijklmnop\n\nPaste code here if prompted > "));
      const got = await readLine();
      log({ pasted: got });
      out(wrap("\n\n✓ Long-lived authentication token created successfully!\n\nYour OAuth token (valid for 1 year):\n\n" + E.FAKE_TOKEN + "\n\nStore this token securely.\n"));
      hang();
      return;
    }
    case "fail": out("Error: the device code expired " + E.FAKE_TOKEN + "\n"); process.exit(3);
    case "ok-no-file": out("done\n"); process.exit(0);
    case "hang": out("https://auth.openai.com/codex/device\n  WXYZ-9876\ntoken " + E.FAKE_JWT + "\n"); hang(); return;
    default: out("unknown mode\n"); process.exit(9);
  }
})();
`;

interface Req { kind: string; auth: string; body: Record<string, unknown> }
interface Gw {
  url: string;
  reqs: Req[];
  /** 박동 응답을 정한다(요청 → 응답). */
  onTick: (r: Req, n: number) => { status: number; body: Record<string, unknown> };
  onResult: (r: Req) => { status: number; body: Record<string, unknown> };
  close(): Promise<void>;
}
async function gateway(): Promise<Gw> {
  const reqs: Req[] = [];
  let ticks = 0;
  const g: Partial<Gw> = {
    reqs,
    onTick: () => ({ status: 200, body: { ok: true } }),
    onResult: () => ({ status: 200, body: { ok: true } }),
  };
  const srv = http.createServer((req, res) => {
    let s = "";
    req.on("data", (d) => { s += d; });
    req.on("end", () => {
      const m = /^\/api\/login-jobs\/(\d+)\/(tick|result|end)$/.exec(req.url ?? "");
      const r: Req = { kind: m ? `${m[1]}/${m[2]}` : `?${req.url}`, auth: String(req.headers.authorization ?? ""), body: s ? JSON.parse(s) : {} };
      reqs.push(r);
      const out = !m ? { status: 404, body: {} }
        : m[2] === "tick" ? g.onTick!(r, ++ticks)
          : m[2] === "result" ? g.onResult!(r)
            : { status: 200, body: { ok: true } };
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  g.url = `http://127.0.0.1:${port}`;
  g.close = () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
  return g as Gw;
}

interface Run { code: number | null; stdout: string; stderr: string; ms: number; dir: string; home: string; fakeLog: Array<Record<string, unknown>> }
async function runJob(o: {
  purpose: string; harness: string; mode: string; gw: string; job?: string; timing?: Partial<LoginJobTiming>;
  secret?: string | null; env?: Record<string, string>; timeoutMs?: number; bin?: string | null;
  onChild?: (child: ReturnType<typeof spawn>) => void;
}): Promise<Run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lj-"));
  made.push(dir);
  const work = path.join(dir, "work");
  const home = path.join(work, "home");
  fs.mkdirSync(work, { recursive: true });
  const credDir = path.join(dir, "cred");
  fs.mkdirSync(credDir);
  if (o.secret !== null) fs.writeFileSync(path.join(credDir, "job"), (o.secret ?? SECRET) + "\n");
  const fakeJs = path.join(dir, "fake.cjs");
  fs.writeFileSync(fakeJs, FAKE_JS);
  const bin = path.join(dir, "fake-cli");
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`, { mode: 0o755 });
  const run = path.join(dir, "run.mjs");
  fs.writeFileSync(run, loginJobRunScript({ ...FAST, ...(o.timing ?? {}) }));
  const fakeLog = path.join(dir, "fake.log");
  fs.writeFileSync(fakeLog, "");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    CREDENTIALS_DIRECTORY: credDir,
    LIVELY_GATEWAY_URL: o.gw,
    LIVELY_LOGIN_JOB: o.job ?? "7",
    LIVELY_LOGIN_PURPOSE: o.purpose,
    LIVELY_HARNESS: o.harness,
    LVLY_TENANT_SLUG: "acme",
    LVLY_LOGIN_TMUX: TMUX || "/nonexistent/tmux",
    FAKE_MODE: o.mode, FAKE_LOG: fakeLog, FAKE_CODE: CODE, FAKE_TOKEN: TOKEN, FAKE_JWT: JWT,
    ...(o.bin === null ? {} : { LVLY_HARNESS_BIN: o.bin ?? bin }),
    ...(o.env ?? {}),
  };
  const t0 = Date.now();
  const child = spawn(process.execPath, [run], { env, cwd: work, stdio: ["ignore", "pipe", "pipe"] });
  o.onChild?.(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const code = await new Promise<number | null>((res) => {
    const to = setTimeout(() => { child.kill("SIGKILL"); res(null); }, o.timeoutMs ?? 15_000);
    child.on("exit", (c) => { clearTimeout(to); res(c); });
  });
  const lines = fs.readFileSync(fakeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { code, stdout, stderr, ms: Date.now() - t0, dir, home, fakeLog: lines };
}
const alive = (pid: unknown): boolean => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
async function gone(pid: unknown, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (!alive(pid)) return true; await sleep(50); }
  return !alive(pid);
}
/** 판의 stdout 은 진행 줄뿐이어야 한다 — 자격·코드·비밀·화면이 없다. */
function assertCleanStdout(r: Run): void {
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.ok(lines.length >= 1, "배선 — 진행 줄을 실제로 봤다");
  for (const l of lines) assert.equal((JSON.parse(l) as { type?: string }).type, "lvly_login", `진행 줄이 아니다: ${l}`);
  for (const bad of [SECRET, TOKEN, JWT, CODE, "ABCD-1234", "WXYZ-9876", "auth.openai.com", "claude.com"]) {
    assert.ok(!r.stdout.includes(bad) && !r.stderr.includes(bad), `판 출력에 ${bad.slice(0, 16)}… 가 있다`);
  }
}
const kinds = (g: Gw): string[] => g.reqs.map((r) => r.kind.split("/")[1]!);

// ── 표 ────────────────────────────────────────────────────────────────────────

await t("K23 표 — 목적·하네스별 인자 · PTY 는 헤드리스 claude 만 · 판이 모르는 조합은 없다", () => {
  assert.deepEqual(Object.keys(LOGIN_JOB_SPECS).sort(), ["headless:claude", "headless:codex", "login:claude", "login:codex", "login:grok"]);
  assert.deepEqual(loginJobSpec("headless", "claude"), { args: ["setup-token"], pty: true, files: [], screenSecret: "sk-ant-oat01-[A-Za-z0-9_-]{20,}" });
  for (const k of ["headless:codex", "login:codex"]) {
    assert.deepEqual(LOGIN_JOB_SPECS[k]!.args, ["-c", "cli_auth_credentials_store=file", "login", "--device-auth"], k);
    assert.deepEqual(LOGIN_JOB_SPECS[k]!.files, [".codex/auth.json"], k);
  }
  assert.deepEqual(LOGIN_JOB_SPECS["login:claude"]!.args, ["auth", "login"]);
  assert.deepEqual(LOGIN_JOB_SPECS["login:grok"]!.args, ["login", "--device-auth"]);
  for (const [k, v] of Object.entries(LOGIN_JOB_SPECS)) assert.equal(v.pty, k === "headless:claude", k);
  for (const bad of [["login", "antigravity"], ["headless", "grok"], ["x", "claude"], ["login", "__proto__"], ["login", "toString"]]) {
    assert.equal(loginJobSpec(bad[0]!, bad[1]!), null, bad.join(":"));
  }
  assert.throws(() => (LOGIN_JOB_SPECS as Record<string, unknown>).x = 1, "표는 얼어 있다");
});

await t("K23 가림 — Anthropic 키·OAuth · JWT · JSON 토큰 칸을 가린다 · 평범한 글은 그대로", () => {
  const s = `a ${TOKEN} b sk-ant-api03-${"z".repeat(30)} c ${JWT} {"access_token":"x1","refresh_token" : "x2","id_token":"x3"} "accessToken": "y1"`;
  const r = redactSecrets(s);
  for (const bad of [TOKEN, "sk-ant-api03", JWT, "x1", "x2", "x3", "y1"]) assert.ok(!r.includes(bad), bad);
  assert.equal(r.split(REDACTED).length - 1, 7);
  const plain = "Open https://auth.openai.com/codex/device\n  ABCD-1234\nPaste code here if prompted >";
  assert.equal(redactSecrets(plain), plain);
});

await t("K23 스크립트 — 문법이 맞고 표·시간표를 구워 넣는다 · 시간표 덮어쓰기는 그 값만 바꾼다", () => {
  const src = loginJobRunScript();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lj-syntax-"));
  fs.writeFileSync(path.join(dir, "run.mjs"), src);
  const chk = spawnSync(process.execPath, ["--check", path.join(dir, "run.mjs")], { encoding: "utf8" });
  assert.equal(chk.status, 0, `run.mjs 문법: ${chk.stderr}`);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(src.includes(JSON.stringify(LOGIN_JOB_SPECS)));
  assert.ok(src.includes(`const T = ${JSON.stringify(LOGIN_JOB_TIMING)};`));
  const fast = loginJobRunScript({ tickMs: 5 });
  assert.ok(fast.includes(`const T = ${JSON.stringify({ ...LOGIN_JOB_TIMING, tickMs: 5 })};`));
  assert.ok(!src.includes("console.log"), "stdout 은 진행 줄 함수(say)로만");
});

// ── 실행 ──────────────────────────────────────────────────────────────────────

await t("★ K23 대화형 codex — 인자 · 홈 · 화면 박동 · 자격 파일을 결과로 · 끝나면 홈을 지운다", async () => {
  const g = await gateway();
  try {
    const r = await runJob({ purpose: "login", harness: "codex", mode: "device", gw: g.url, job: "41" });
    assert.equal(r.code, 0, r.stderr);
    const [cli] = r.fakeLog;
    assert.deepEqual(cli!.argv, ["-c", "cli_auth_credentials_store=file", "login", "--device-auth"]);
    assert.equal(cli!.home, r.home);
    assert.equal(cli!.codexHome, path.join(r.home, ".codex"));
    assert.equal(cli!.hasCredDir, false, "판의 비밀 폴더를 CLI 에 넘기지 않는다");
    assert.equal(cli!.tty, false, "대화형 codex 는 파이프");
    assert.ok(g.reqs.length >= 2);
    for (const q of g.reqs) assert.equal(q.auth, `Bearer ${SECRET}`, "모든 요청이 작업 비밀을 싣는다");
    for (const q of g.reqs) assert.ok(q.kind.startsWith("41/"), `작업 번호: ${q.kind}`);
    const ticks = g.reqs.filter((q) => q.kind.endsWith("/tick"));
    assert.ok(ticks.some((q) => String(q.body.screen).includes("ABCD-1234")), "화면(코드)을 올린다");
    const res = g.reqs.filter((q) => q.kind.endsWith("/result"));
    assert.equal(res.length, 1);
    assert.deepEqual(Object.keys(res[0]!.body), ["files"], "대화형 codex 는 계정 정보를 안 싣는다");
    assert.deepEqual(res[0]!.body.files, [{ path: ".codex/auth.json", content: JSON.stringify({ tokens: { access_token: JWT } }) }]);
    assert.equal(kinds(g).at(-1), "result", "결과가 마지막이다(끝 알림 없음)");
    assert.equal(fs.existsSync(r.home), false, "홈(자격 흔적)을 지운다");
    assertCleanStdout(r);
  } finally { await g.close(); }
});

await t("★ K23 대화형 grok — 자기 자리(.grok/auth.json)를 거둔다", async () => {
  const g = await gateway();
  try {
    const r = await runJob({ purpose: "login", harness: "grok", mode: "device", gw: g.url, env: { FAKE_TARGET_DIR: "grok" } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.fakeLog[0]!.argv, ["login", "--device-auth"]);
    const res = g.reqs.find((q) => q.kind.endsWith("/result"))!;
    assert.deepEqual((res.body.files as Array<{ path: string }>).map((f) => f.path), [".grok/auth.json"]);
  } finally { await g.close(); }
});

await t("★ K23 대화형 claude — 붙여넣기 코드를 CLI 에 한 번 넣고 · 자격 + 계정 정보를 결과로", async () => {
  const g = await gateway();
  let pasted = 0;
  g.onTick = (q) => (String(q.body.screen).includes("Paste code here") && !pasted++
    ? { status: 200, body: { ok: true, paste: CODE } } : { status: 200, body: { ok: true } });
  try {
    const r = await runJob({ purpose: "login", harness: "claude", mode: "paste", gw: g.url });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.fakeLog[0]!.argv, ["auth", "login"]);
    assert.equal(r.fakeLog.find((x) => "pasted" in x)?.pasted, CODE, "받은 코드를 그대로 CLI 에");
    const res = g.reqs.find((q) => q.kind.endsWith("/result"))!;
    assert.deepEqual(res.body, {
      files: [{ path: ".claude/.credentials.json", content: JSON.stringify({ claudeAiOauth: { accessToken: "at", refreshToken: "rt" } }) }],
      account: { emailAddress: "s@example.com", organizationUuid: "org-1" },
    });
    for (const q of g.reqs.filter((x) => x.kind.endsWith("/tick"))) assert.ok(!String(q.body.screen).includes(CODE), "코드를 화면으로 되올리지 않는다");
    assert.equal(fs.existsSync(r.home), false);
    assertCleanStdout(r);
  } finally { await g.close(); }
});

await t("★ K23 헤드리스 codex — 자격 파일 **내용**을 secret 으로(파일 모양 아님)", async () => {
  const g = await gateway();
  try {
    const r = await runJob({ purpose: "headless", harness: "codex", mode: "device", gw: g.url });
    assert.equal(r.code, 0, r.stderr);
    const res = g.reqs.find((q) => q.kind.endsWith("/result"))!;
    assert.deepEqual(res.body, { secret: JSON.stringify({ tokens: { access_token: JWT } }) });
  } finally { await g.close(); }
});

await t("★ K23 헤드리스 claude(PTY·실제 tmux) — 화면의 토큰을 결과로 · 화면 박동엔 토큰이 없다 · tmux·CLI 를 거둔다", async () => {
  if (!TMUX) { console.log("skip  tmux 없음"); return; }
  const g = await gateway();
  let pasted = 0;
  g.onTick = (q) => (String(q.body.screen).includes("Paste code here") && !pasted++
    ? { status: 200, body: { ok: true, paste: CODE } } : { status: 200, body: { ok: true } });
  try {
    const r = await runJob({ purpose: "headless", harness: "claude", mode: "setup-token", gw: g.url });
    assert.equal(r.code, 0, r.stderr);
    const cli = r.fakeLog[0]!;
    assert.deepEqual(cli.argv, ["setup-token"]);
    assert.equal(cli.tty, true, "setup-token 은 TTY 에서만 찍는다 — tmux 로 띄운다");
    assert.equal(cli.hasCredDir, false);
    assert.equal(r.fakeLog.find((x) => "pasted" in x)?.pasted, CODE);
    const res = g.reqs.filter((q) => q.kind.endsWith("/result"));
    assert.equal(res.length, 1);
    assert.deepEqual(res[0]!.body, { secret: TOKEN });
    const ticks = g.reqs.filter((q) => q.kind.endsWith("/tick"));
    assert.equal(r.fakeLog.find((x) => "cols" in x)?.cols, 500, "넓은 창에서 띄운다");
    assert.ok(ticks.some((q) => String(q.body.screen).includes("https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&scope=user%3Ainference&state=abcdefghijklmnop")),
      "주소가 끊기지 않고 한 줄로 온다(CLI 가 창 폭에서 줄을 끊는다)");
    for (const q of ticks) assert.ok(!String(q.body.screen).includes(TOKEN));
    assert.ok(await gone(cli.pid), "CLI 를 거뒀다(토큰을 찍고도 기다리던 프로세스)");
    const ls = spawnSync(TMUX, ["-S", path.join(r.dir, "work", "tmux.sock"), "ls"], { encoding: "utf8" });
    assert.notEqual(ls.status, 0, "tmux 서버가 남지 않는다");
    assert.equal(fs.existsSync(r.home), false);
    assertCleanStdout(r);
  } finally { await g.close(); }
});

await t("K23 헤드리스 claude — tmux 를 못 띄우면 끝 알림(spawn) 후 70", async () => {
  const g = await gateway();
  try {
    const r = await runJob({ purpose: "headless", harness: "claude", mode: "setup-token", gw: g.url, env: { LVLY_LOGIN_TMUX: "/nonexistent/tmux" } });
    assert.equal(r.code, 70);
    assert.deepEqual(kinds(g), ["end"]);
    assert.equal(g.reqs[0]!.body.reason, "spawn");
  } finally { await g.close(); }
});

await t("★ K19·K23 CLI 가 자격 없이 끝남 — 끝 알림(종료코드 · 가린 화면 꼬리) · 결과 없음", async () => {
  const g = await gateway();
  try {
    const r = await runJob({ purpose: "login", harness: "codex", mode: "fail", gw: g.url });
    assert.equal(r.code, 0);
    const end = g.reqs.filter((q) => q.kind.endsWith("/end"));
    assert.equal(end.length, 1);
    assert.equal(end[0]!.body.reason, "exited");
    assert.equal(end[0]!.body.exit_code, 3);
    assert.match(String(end[0]!.body.screen), /Error: the device code expired/);
    assert.ok(!String(end[0]!.body.screen).includes(TOKEN), "끝 화면도 가린다");
    assert.ok(String(end[0]!.body.screen).length <= 2000);
    assert.equal(g.reqs.filter((q) => q.kind.endsWith("/result")).length, 0);
    const r0 = await runJob({ purpose: "login", harness: "grok", mode: "ok-no-file", gw: g.url });
    assert.equal(r0.code, 0);
    const end0 = g.reqs.filter((q) => q.kind.endsWith("/end")).at(-1)!;
    assert.equal(end0.body.exit_code, 0, "0 으로 끝나도 파일이 없으면 결과가 아니다");
  } finally { await g.close(); }
});

await t("★ K23·K26 게이트웨이의 멈춤 신호 — 곧바로 끝낸다 · CLI 를 거둔다 · 홈을 지운다", async () => {
  const g = await gateway();
  //  CLI 가 화면을 찍은 뒤에 멈춘다(그래야 «CLI 를 거뒀나» 를 진짜 pid 로 본다).
  g.onTick = (q) => (String(q.body.screen).includes("WXYZ")
    ? { status: 200, body: { ok: true, stop: true, why: "cancelled" } } : { status: 200, body: { ok: true } });
  try {
    const r = await runJob({ purpose: "login", harness: "codex", mode: "hang", gw: g.url, timing: { softMaxMs: 60_000 } });
    assert.equal(r.code, 0);
    assert.ok(r.ms < 5_000, `멈춤이 늦다: ${r.ms}ms`);
    assert.ok(kinds(g).every((k) => k === "tick"), kinds(g).join(","));
    assert.ok(r.fakeLog[0]?.pid, "배선 — CLI 가 떴다");
    assert.ok(await gone(r.fakeLog[0]!.pid), "CLI 를 거뒀다");
    assert.equal(fs.existsSync(r.home), false);
  } finally { await g.close(); }
});

await t("★ K23 거절(401·404·410) — 곧바로 끝낸다 · 결과·끝 알림을 보내지 않는다", async () => {
  for (const status of [401, 404, 410]) {
    const g = await gateway();
    g.onTick = (q) => (String(q.body.screen).includes("WXYZ") ? { status, body: { message: "x" } } : { status: 200, body: { ok: true } });
    try {
      const r = await runJob({ purpose: "login", harness: "codex", mode: "hang", gw: g.url, timing: { softMaxMs: 60_000 } });
      assert.equal(r.code, 0, String(status));
      assert.ok(kinds(g).every((k) => k === "tick"), `${status}: ${kinds(g).join(",")}`);
      assert.ok(r.fakeLog[0]?.pid, "배선 — CLI 가 떴다");
      assert.ok(await gone(r.fakeLog[0]!.pid), String(status));
    } finally { await g.close(); }
  }
});

await t("K23 일시 오류(500) 는 끝내지 않는다 — 다음 박동을 이어 간다", async () => {
  const g = await gateway();
  g.onTick = (_q, n) => (n < 3 ? { status: 500, body: {} } : { status: 200, body: { ok: true, stop: true } });
  try {
    const r = await runJob({ purpose: "login", harness: "codex", mode: "hang", gw: g.url, timing: { softMaxMs: 60_000 } });
    assert.equal(r.code, 0);
    assert.deepEqual(kinds(g), ["tick", "tick", "tick"], "500 두 번을 넘기고 세 번째 박동에서 멈춤을 받았다");
  } finally { await g.close(); }
});

await t("★ K23 게이트웨이 불통이 상한을 넘으면 끝낸다 — 결과를 넘길 곳 없는 판은 남기지 않는다", async () => {
  const g = await gateway();
  const url = g.url;
  await g.close();   // 닫힌 포트
  const r = await runJob({ purpose: "login", harness: "codex", mode: "hang", gw: url, timing: { gatewayDeadMs: 700, softMaxMs: 60_000 } });
  assert.equal(r.code, 0);
  assert.ok(r.ms >= 700 && r.ms < 8_000, `${r.ms}ms`);
  assert.match(r.stdout, /gateway-unreachable/);
  assert.ok(await gone(r.fakeLog[0]!.pid));
  assert.equal(fs.existsSync(r.home), false);
});

await t("★ K23 판 자체 상한 — 끝 알림(timeout) 후 끝낸다", async () => {
  const g = await gateway();
  try {
    const r = await runJob({ purpose: "login", harness: "codex", mode: "hang", gw: g.url, timing: { softMaxMs: 800 } });
    assert.equal(r.code, 0);
    assert.ok(r.ms >= 800 && r.ms < 8_000, `${r.ms}ms`);
    assert.equal(kinds(g).at(-1), "end");
    assert.equal(g.reqs.at(-1)!.body.reason, "timeout");
    assert.ok(await gone(r.fakeLog[0]!.pid));
    const ticks = g.reqs.filter((q) => q.kind.endsWith("/tick"));
    assert.ok(ticks.length >= 1);
    for (const q of ticks) assert.ok(!String(q.body.screen).includes(JWT), "화면 속 JWT 는 올리기 전에 가린다");
    assert.ok(ticks.some((q) => String(q.body.screen).includes(REDACTED)));
  } finally { await g.close(); }
});

await t("K23 결과 거절 — 75 로 끝낸다(재시도하지 않는다)", async () => {
  const g = await gateway();
  g.onResult = () => ({ status: 400, body: { message: "no" } });
  try {
    const r = await runJob({ purpose: "login", harness: "codex", mode: "device", gw: g.url });
    assert.equal(r.code, 75);
    assert.equal(g.reqs.filter((q) => q.kind.endsWith("/result")).length, 1);
    assert.equal(fs.existsSync(r.home), false);
  } finally { await g.close(); }
});

await t("★ K23 SIGTERM(op stop) — CLI 를 거두고 홈을 지운다", async () => {
  const g = await gateway();
  try {
    let child: ReturnType<typeof spawn> | null = null;
    const p = runJob({ purpose: "login", harness: "codex", mode: "hang", gw: g.url, timing: { softMaxMs: 60_000 }, onChild: (c) => { child = c; } });
    //  판이 뜨고 CLI 가 화면을 찍을 때까지 기다린 뒤 판에 SIGTERM(op 의 systemctl stop 과 같은 신호).
    const until = Date.now() + 8000;
    while (Date.now() < until && !g.reqs.some((q) => String(q.body.screen ?? "").includes("WXYZ"))) await sleep(50);
    assert.ok(child, "배선 — 판 프로세스를 잡았다");
    (child as unknown as ReturnType<typeof spawn>).kill("SIGTERM");
    const r = await p;
    assert.equal(r.code, 0);
    assert.ok(r.ms < 10_000, `${r.ms}ms`);
    assert.ok(r.fakeLog[0]?.pid, "배선 — CLI 가 떴다");
    assert.ok(await gone(r.fakeLog[0]!.pid), "CLI 를 거뒀다");
    assert.equal(fs.existsSync(r.home), false);
  } finally { await g.close(); }
});

await t("★ K23 env 가 형식 밖이면 아무것도 안 부르고 끝낸다 — 비밀 없음 65 · 주소·작업·하네스·실행파일 64", async () => {
  const g = await gateway();
  try {
    const cases: Array<[string, Parameters<typeof runJob>[0], number]> = [
      ["비밀 없음", { purpose: "login", harness: "codex", mode: "device", gw: g.url, secret: null }, 65],
      ["빈 비밀", { purpose: "login", harness: "codex", mode: "device", gw: g.url, secret: "   " }, 65],
      ["주소에 경로", { purpose: "login", harness: "codex", mode: "device", gw: `${g.url}/x` }, 64],
      ["주소 스킴", { purpose: "login", harness: "codex", mode: "device", gw: "file:///etc" }, 64],
      ["작업 번호", { purpose: "login", harness: "codex", mode: "device", gw: g.url, job: "7;rm" }, 64],
      ["작업 0", { purpose: "login", harness: "codex", mode: "device", gw: g.url, job: "0" }, 64],
      ["모르는 조합", { purpose: "headless", harness: "grok", mode: "device", gw: g.url }, 64],
      ["실행 파일 없음", { purpose: "login", harness: "codex", mode: "device", gw: g.url, bin: null }, 64],
    ];
    for (const [name, o, code] of cases) {
      const r = await runJob(o);
      assert.equal(r.code, code, name);
      assert.equal(r.fakeLog.length, 0, `${name}: CLI 를 띄우지 않는다`);
    }
    assert.equal(g.reqs.length, 0, "게이트웨이를 부르지 않는다");
  } finally { await g.close(); }
});

console.log(`\n${pass} passed`);
