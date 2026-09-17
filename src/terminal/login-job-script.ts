// 하네스 로그인 **판**(CP 일시 유닛) 안에서 도는 `run.mjs` — 순수 조립 (#4012 T13 · #4067).
//
// ── 왜 판인가 ────────────────────────────────────────────────────────────────
//  종전엔 로그인마다 멤버 **세션 컨테이너**(노드 예약 1024MB)를 하나 더 띄워 그 안에서 CLI 를 돌렸다
//  (ai-login-run · headless-login-run). 새 워크스페이스가 붐비는 노드에 앉으면 로그인을 시작조차 못 했다
//  (실측 2026-09-17: LVLY_NODE_CAPACITY 약속 5184 + 요청 1024 > 예산 5708MB). 증류가 이미 CP 판에서 도니,
//  로그인도 그 판에서 돈다 — lvly-cloud task-op `login` 프로필.
//
// ── 판이 가진 것과 못 가진 것 ────────────────────────────────────────────────
//  가진 것: 이 스크립트 · 하네스 실행 파일(읽기 전용) · 작업별 일회용 비밀(`$CREDENTIALS_DIRECTORY/job`) · 공인 인터넷.
//  못 가진 것: 테넌트 저장소(멤버 홈) · 모델 자격 · 게이트웨이 자격. 그래서 결과(발급된 자격)는 판이
//   **게이트웨이 공인 주소로 넘기고**, 멤버 홈에 쓰는 일은 게이트웨이가 한다(login-job.ts).
//  홈은 `/task/work/home` — tmpfs 라 판이 끝나면 자격의 흔적이 디스크에 남지 않는다.
//
// ── 판이 스스로 끝나는 경우(상민님 2026-09-17: «끝나거나 오래 진행이 없으면 꺼라») ──
//  CLI 종료 · 게이트웨이의 멈춤 신호(취소·화면 무폴링·만료) · 게이트웨이 불통 · 판 자체 상한(SOFT_MAX).
//  그 위에 op 의 RuntimeMaxSec(20분)가 마지막 벽이다.
//
// ⚠ 이 파일의 표(무엇을 돌리나 · 무엇을 거두나 · 무엇을 가리나)는 게이트웨이 쪽 판정(login-job.ts)과
//  **같은 값**을 쓴다 — 스크립트에 JSON 으로 구워 넣는다. 두 벌로 적으면 한쪽만 고쳐진다.

export type LoginPurpose = "login" | "headless";
export type LoginJobHarness = "claude" | "codex" | "grok";

export interface LoginJobSpec {
  /** 하네스 실행 파일 뒤에 붙는 인자. */
  args: string[];
  /** TTY 가 있어야 출력이 나오나 — `claude setup-token` 은 TTY 가 아니면 0바이트다(#4051 실측). */
  pty: boolean;
  /** 성공 뒤 거둘 파일(홈 기준 상대경로). 헤드리스 claude 는 화면의 토큰을 거둔다(파일 없음). */
  files: string[];
  /** 화면에서 거둘 자격 모양(정규식 원문) — 헤드리스 claude 만. */
  screenSecret?: string;
}

/** codex 는 자격을 **파일로** 남기게 못박는다 — 판에는 키링이 없고, 자동 판정에 맡기면 판마다 다를 수 있다. */
const CODEX_ARGS = ["-c", "cli_auth_credentials_store=file", "login", "--device-auth"];
/** claude 장기 토큰 모양 — headless-login-flow 의 판정과 같은 모양이다(sk-ant-oat01-…). */
export const CLAUDE_OAUTH_TOKEN_RE = "sk-ant-oat01-[A-Za-z0-9_-]{20,}";

export const LOGIN_JOB_SPECS: Readonly<Record<string, LoginJobSpec>> = Object.freeze({
  "headless:claude": Object.freeze({ args: ["setup-token"], pty: true, files: [], screenSecret: CLAUDE_OAUTH_TOKEN_RE }),
  "headless:codex": Object.freeze({ args: CODEX_ARGS, pty: false, files: [".codex/auth.json"] }),
  "login:claude": Object.freeze({ args: ["auth", "login"], pty: false, files: [".claude/.credentials.json"] }),
  "login:codex": Object.freeze({ args: CODEX_ARGS, pty: false, files: [".codex/auth.json"] }),
  "login:grok": Object.freeze({ args: ["login", "--device-auth"], pty: false, files: [".grok/auth.json"] }),
});

/** (순수) 이 조합을 판이 돌릴 수 있나. */
export function loginJobSpec(purpose: string, harness: string): LoginJobSpec | null {
  const k = `${purpose}:${harness}`;
  return Object.hasOwn(LOGIN_JOB_SPECS, k) ? LOGIN_JOB_SPECS[k]! : null;
}

/**
 * 화면·오류 문장에서 가릴 모양(정규식 원문). 판은 올리기 **전에** 가리고, 게이트웨이는 저장 전에 **한 번 더** 가린다
 *  (판이 낡은 판이거나 모양이 새로 나와도 한 겹은 남게).
 */
export const SECRET_PATTERNS: readonly string[] = Object.freeze([
  "sk-ant-[A-Za-z0-9]{2,10}-[A-Za-z0-9_-]{16,}",   // Anthropic 키·OAuth 토큰(oat01·api03 …)
  "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}",   // JWT(codex·grok 토큰)
  "\"(?:access_token|refresh_token|id_token|accessToken|refreshToken)\"\\s*:\\s*\"[^\"]*\"",   // JSON 에 박힌 토큰 칸
]);
export const REDACTED = "‹가림›";

/** (순수) 비밀 모양을 가린다. */
export function redactSecrets(text: string): string {
  let s = String(text ?? "");
  for (const p of SECRET_PATTERNS) s = s.replace(new RegExp(p, "g"), REDACTED);
  return s;
}

export interface LoginJobTiming { tickMs: number; softMaxMs: number; gatewayDeadMs: number; screenMax: number; fileMax: number }

/** 판 안 시간표(ms). 게이트웨이 쪽 판정(login-job.ts)과 짝이다 — 판이 먼저 끝나야 한다. */
export const LOGIN_JOB_TIMING: Readonly<LoginJobTiming> = Object.freeze({
  /** 게이트웨이에 한 번 묻는 간격 — 붙여넣기가 이 간격 안에 CLI 로 간다. */
  tickMs: 1_500,
  /** 판이 스스로 끝내는 상한 — op 의 RuntimeMaxSec(1200)보다 짧게(끝 알림을 남길 여유). */
  softMaxMs: 18 * 60_000,
  /** 게이트웨이가 이만큼 연속으로 안 닿으면 끝낸다 — 결과를 넘길 곳이 없는 판은 남겨 둘 이유가 없다. */
  gatewayDeadMs: 60_000,
  /** 화면을 올리는 상한(바이트) — 게이트웨이 저장 상한과 같다. */
  screenMax: 16_000,
  /** 거두는 파일 하나의 상한(바이트). */
  fileMax: 64 * 1024,
});

/**
 * (순수) 판 스크립트 원문. op 가 `/task/in/run.mjs` 로 두고 `/usr/bin/node` 로 돌린다.
 *  ⚠ stdout·stderr 에는 **진행 한 줄만** 쓴다 — 그 파일(out/stream.jsonl)은 CP 디스크에 남는다. 화면·코드·자격은 안 쓴다.
 */
export function loginJobRunScript(timingOverride: Partial<LoginJobTiming> = {}): string {
  const table = JSON.stringify(LOGIN_JOB_SPECS);
  const patterns = JSON.stringify(SECRET_PATTERNS);
  //  시간표 덮어쓰기는 시험 이음매다(분 단위 상한을 초 단위로) — 운영 호출은 인자 없이 부른다.
  const timing = JSON.stringify({ ...LOGIN_JOB_TIMING, ...timingOverride });
  return `// lively 로그인 판 (#4067) — lvly-task-op 이 일회용 uid 로 돌린다. 코어(login-job-script.ts)가 만든다.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SPECS = ${table};
const PATTERNS = ${patterns};
const T = ${timing};
const REDACTED = ${JSON.stringify(REDACTED)};
const E = process.env;
const say = (msg, extra) => { try { process.stdout.write(JSON.stringify({ type: "lvly_login", msg, ...(extra || {}), t: Date.now() }) + "\\n"); } catch (_) {} };
const GW = String(E.LIVELY_GATEWAY_URL || "").replace(/\\/+$/, "");
const JOB = String(E.LIVELY_LOGIN_JOB || "");
const PURPOSE = String(E.LIVELY_LOGIN_PURPOSE || "");
const H = String(E.LIVELY_HARNESS || "");
const BIN = String(E.LVLY_HARNESS_BIN || E.LVLY_LOGIN_BIN || "");
const spec = Object.prototype.hasOwnProperty.call(SPECS, PURPOSE + ":" + H) ? SPECS[PURPOSE + ":" + H] : null;
if (!spec || !/^https?:\\/\\/[A-Za-z0-9._:-]+$/.test(GW) || !/^[1-9][0-9]{0,15}$/.test(JOB) || !BIN) { say("bad-env"); process.exit(64); }
let SECRET = "";
try { SECRET = fs.readFileSync(path.join(String(E.CREDENTIALS_DIRECTORY || "/nonexistent"), "job"), "utf8").trim(); } catch (_) { /* 아래에서 끝낸다 */ }
if (!SECRET) { say("no-secret"); process.exit(65); }

const HOME = String(E.HOME || "/task/work/home");
const WORK = path.dirname(HOME);
for (const d of ["", ".claude", ".codex", ".grok"]) fs.mkdirSync(path.join(HOME, d), { recursive: true, mode: 0o700 });
const childEnv = { ...E, HOME, CODEX_HOME: path.join(HOME, ".codex"), TERM: "xterm-256color", COLUMNS: "500", LINES: "60" };
delete childEnv.CREDENTIALS_DIRECTORY;
const redact = (s) => PATTERNS.reduce((a, p) => a.replace(new RegExp(p, "g"), REDACTED), String(s == null ? "" : s));
const stripAnsi = (s) => String(s).replace(/\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)/g, "").replace(/\\u001b\\[[0-9;?]*[ -\\/]*[@-~]/g, "").replace(/\\u001b[@-Z\\\\-_]/g, "");

async function call(kind, body) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(GW + "/api/login-jobs/" + JOB + "/" + kind, {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", authorization: "Bearer " + SECRET },
      body: JSON.stringify(body || {}),
    });
    let j = {};
    try { j = await r.json(); } catch (_) { j = {}; }
    return { status: r.status, body: j && typeof j === "object" ? j : {} };
  } catch (_) {
    return { status: 0, body: {} };
  } finally { clearTimeout(to); }
}

// ── CLI ──
const TMUX = String(E.LVLY_LOGIN_TMUX || "/usr/bin/tmux");
const SOCK = path.join(WORK, "tmux.sock");
const CONF = path.join(WORK, "tmux.conf");
const tmux = (...a) => spawnSync(TMUX, ["-S", SOCK, "-f", CONF, ...a], { env: childEnv, encoding: "utf8", timeout: 10000 });
let out = "";
let exitCode = null;
let child = null;
if (spec.pty) {
  //  remain-on-exit 는 **설정 파일로** 켠다 — 세션을 띄운 뒤에 켜면 CLI 가 그 사이에 끝났을 때 종료코드를 못 읽는다.
  fs.writeFileSync(CONF, "set -g remain-on-exit on\\nset -g history-limit 2000\\n", { mode: 0o600 });
  const r = tmux("new-session", "-d", "-x", "500", "-y", "60", "-s", "L", BIN, ...spec.args);
  if (r.status !== 0) { say("spawn-failed"); await call("end", { reason: "spawn", message: "로그인 명령을 띄우지 못했습니다" }); process.exit(70); }
} else {
  child = spawn(BIN, spec.args, { env: childEnv, cwd: HOME, stdio: ["pipe", "pipe", "pipe"] });
  const add = (d) => { out += String(d); if (out.length > 200000) out = out.slice(-100000); };
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  child.on("error", () => { exitCode = 127; });
  child.on("exit", (c) => { exitCode = c == null ? -1 : c; });
}
const screen = () => {
  if (!spec.pty) return stripAnsi(out);
  const r = tmux("capture-pane", "-p", "-J", "-t", "L", "-S", "-200");
  const d = tmux("display-message", "-p", "-t", "L", "#{pane_dead} #{pane_dead_status}");
  const m = /^1 (-?[0-9]+)/.exec(String(d.stdout || ""));
  if (m && exitCode === null) exitCode = Number(m[1]);
  return stripAnsi(String(r.stdout || ""));
};
const deliver = (code) => {
  if (spec.pty) { tmux("send-keys", "-t", "L", "-l", code); tmux("send-keys", "-t", "L", "Enter"); }
  else if (child && child.stdin && !child.stdin.destroyed) child.stdin.write(code + "\\n");
};
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { if (child && exitCode === null) child.kill("SIGTERM"); } catch (_) {}
  try { tmux("kill-server"); } catch (_) {}
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
};
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

const readFiles = () => {
  const files = [];
  for (const rel of spec.files) {
    const abs = path.join(HOME, rel);
    let st;
    try { st = fs.lstatSync(abs); } catch (_) { return null; }
    if (!st.isFile() || st.size <= 0 || st.size > T.fileMax) return null;
    files.push({ path: rel, content: fs.readFileSync(abs, "utf8") });
  }
  return files;
};
const claudeAccount = () => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HOME, ".claude.json"), "utf8"));
    return j && typeof j.oauthAccount === "object" && j.oauthAccount ? j.oauthAccount : null;
  } catch (_) { return null; }
};

const t0 = Date.now();
let lastOk = Date.now();
let lastSent = "";
let lastBeat = 0;
say("start", { purpose: PURPOSE, harness: H });
for (;;) {
  const text = screen();
  // ① 헤드리스 claude — 화면에 토큰이 뜨면 그것이 결과다(파일로 안 남는다).
  if (spec.screenSecret) {
    const m = new RegExp(spec.screenSecret).exec(text);
    if (m) {
      const r = await call("result", { secret: m[0] });
      say(r.status === 200 ? "stored" : "result-rejected", { status: r.status });
      cleanup();
      process.exit(r.status === 200 ? 0 : 75);
    }
  }
  // ② CLI 가 끝났다 — 성공이면 자격 파일을 거둔다.
  if (exitCode !== null) {
    const files = exitCode === 0 && spec.files.length ? readFiles() : null;
    if (files) {
      const body = { files };
      if (H === "claude" && PURPOSE === "login") body.account = claudeAccount();
      if (PURPOSE === "headless") { delete body.files; body.secret = files[0].content; }
      const r = await call("result", body);
      say(r.status === 200 ? "stored" : "result-rejected", { status: r.status });
      cleanup();
      process.exit(r.status === 200 ? 0 : 75);
    }
    const tail = redact(text).slice(-2000);
    await call("end", { reason: "exited", exit_code: exitCode, screen: tail });
    say("exited", { code: exitCode });
    cleanup();
    process.exit(0);
  }
  // ③ 게이트웨이에 화면을 올리고, 붙여넣기·멈춤을 받는다(바뀌었거나 5초마다).
  const shown = redact(text).slice(-T.screenMax);
  if (shown !== lastSent || Date.now() - lastBeat > 5000) {
    const r = await call("tick", { screen: shown });
    if (r.status === 200) {
      lastOk = Date.now();
      lastSent = shown;
      lastBeat = Date.now();
      if (typeof r.body.paste === "string" && r.body.paste) deliver(r.body.paste);
      if (r.body.stop === true) { say("stopped", { why: String(r.body.why || "") }); cleanup(); process.exit(0); }
    } else if (r.status === 401 || r.status === 404 || r.status === 410) {
      say("rejected", { status: r.status });
      cleanup();
      process.exit(0);
    } else if (Date.now() - lastOk > T.gatewayDeadMs) {
      say("gateway-unreachable");
      cleanup();
      process.exit(0);
    }
  }
  // ④ 판 자체 상한 — op 의 RuntimeMaxSec 보다 먼저 끝내고 끝을 알린다.
  if (Date.now() - t0 > T.softMaxMs) {
    await call("end", { reason: "timeout" });
    say("timeout");
    cleanup();
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, T.tickMs));
}
`;
}
