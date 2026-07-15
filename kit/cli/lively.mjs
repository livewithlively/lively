#!/usr/bin/env node
// lively CLI — 멤버가 쓰는 단일 명령 표면 (#864)
// ────────────────────────────────────────────────────────────────────────────
// 왜 있나 — 종전엔 웹이 건네는 **복붙 한 줄**이 곧 설치기였다(토큰이 명령줄에 박히고, mac/win 이 서로
//  다른 코드였고, 1,400자 PowerShell 을 아무도 디버깅 못 했다). 그 표면 전부를 이 파일 하나로 모은다.
//
// 이 CLI 만이 할 수 있는 일(자동 업데이트가 구조적으로 못 하는 축):
//   **MCP 클라이언트 재등록(`claude mcp remove` → `add`)**. 이건 원자적이지 않아서 백그라운드 업데이터
//   (kit/hooks/self-update.mjs)가 일부러 뺐다 — 중간에 죽으면 멤버의 lively MCP 등록이 사라진다.
//   포그라운드 CLI 는 사람이 보고 있고 실패를 즉시 알릴 수 있으니 안전하게 할 수 있다.
//   → 관리자가 org MCP 서버를 추가했을 때 Claude 멤버가 손대야 하던 유일한 일이 `lively update` 로 닫힌다.
//
// 설계 원칙
//   · 의존성 0 (Node ≥20 내장 fetch). 하네스가 이미 Node 를 요구하므로(훅이 전부 .mjs) 새 런타임을 안 만든다.
//   · 설치의 **엔진은 여전히 setup/user-install.mjs** — CLI 는 오케스트레이터다(비파괴 머지 로직을 복제하지 않는다).
//     [[delivery-install-invariants]] ① 비파괴 설치는 그 파일이 지키고, 여기선 그 계약을 깨지 않는 것이 임무.
//   · 토큰은 argv 에 싣지 않는다 — `lively login` 은 /dev/tty 가림 입력(셸 히스토리에 안 남음).
//   · 전 경로 한국어 + 실패는 실패라고 말한다(조용한 반쪽 설치 금지).
//
// 환경변수: LIVELY_HOME(HOME 리다이렉트 — 샌드박스/테스트) · LIVELY_TOKEN · LIVELY_GATEWAY_URL
//           CLAUDE_CONFIG_DIR(멀티프로필 #346)

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, chmodSync,
  readdirSync, statSync, realpathSync, openSync, closeSync,
} from "node:fs";
import { homedir, tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn, execFileSync } from "node:child_process";
import { ReadStream, WriteStream } from "node:tty";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

// ── 0. 상수 · 경로 ──────────────────────────────────────────────────────────
const CLI_VERSION = "1.0.0";
const WIN = process.platform === "win32";
const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
const CODEX_CFG = join(HOME, ".codex", "config.toml");
// 자동 업데이터(self-update.mjs)와 **같은 필수 훅 목록**을 쓴다 — 손상 번들 판정 기준이 갈리면 안 된다.
//  self-update.mjs 자신은 목록에 없다(구 게이트웨이로 롤백 시 '손상'으로 오판해 영구 고착되는 걸 막기 위함 — #858).
const REQUIRED_HOOKS = ["session-preload.mjs", "work-flag.mjs", "stop-writeback-gate.mjs", "run-custom.mjs", "sync-harness-assets.mjs"];

// ── 1. 출력 ────────────────────────────────────────────────────────────────
const ESC = "\u001b";
const TTY = process.stderr.isTTY;
const c = (code, s) => (TTY ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const bold = (s) => c(1, s), dim = (s) => c(2, s), red = (s) => c(31, s), green = (s) => c(32, s), yellow = (s) => c(33, s);
// 표시 폭(터미널 컬럼 수) — 한글·CJK 는 **2칸**을 차지한다. 코드포인트 개수로 패딩하면 표가 어긋난다(실측).
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
const cols = (s) => [...String(s)].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);
// 사람 대상 출력은 stderr — stdout 은 --json 기계 판독용으로 비워 둔다(파이프 안전).
const say = (s = "") => process.stderr.write(s + "\n");
const ok = (s) => say("  " + green("✓") + " " + s);
const info = (s) => say("  " + dim("·") + " " + s);
const warn = (s) => say("  " + yellow("⚠") + " " + s);
const fail = (s) => say("  " + red("✗") + " " + s);
const die = (s, code = 1) => { say("\n" + red("✗ " + s)); process.exit(code); };

// ── 2. 자식 프로세스 ────────────────────────────────────────────────────────
// Windows 의 claude/codex 는 .cmd/.ps1 셰임이라 shell 없이 spawn 하면 ENOENT(work.mjs:259 와 같은 이유).
//  ⚠ 그런데 Node 는 shell:true 일 때 인자를 **자동 quote 하지 않는다** — 공백이 든 인자
//  (`Authorization: Bearer lvk_…`)가 cmd.exe 에서 두 토막 난다. 그래서 여기서 직접 quote 한다.
//  규칙(CommandLineToArgvW): 백슬래시는 `"` 앞에서만 특별하다 → 내부 " 앞 백슬래시 배증 + 이스케이프,
//  그리고 **인용할 때만** 말미 백슬래시 배증(인용 안 하는 `C:\path\` 는 원형이 맞다 — 과잉 인용이 오히려 깨뜨린다).
//  한계: cmd.exe 의 `%VAR%` 확장은 큰따옴표로도 못 막는다. 우리가 넘기는 값(게이트웨이 URL·lvk_ 토큰·
//  관리자가 넣은 서버명/URL)엔 `%VAR%` 패턴이 없으므로 실질 위험은 없다 — 생기면 여기부터 의심할 것.
//  POSIX CI 에선 이 함수가 한 번도 실행되지 않으므로(WIN=false) lively.test.mjs 가 순수함수로 직접 검증한다.
const winArg = (s) => {
  const v = String(s);
  if (v && !/[\s"^&|<>()%!]/.test(v)) return v;
  return '"' + v.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1") + '"';
};
function run(cmd, args, { allowFail = false, quiet = false, env } = {}) {
  const r = spawnSync(cmd, WIN ? args.map(winArg) : args, {
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, ...(env || {}) },
    encoding: "utf8",
    shell: WIN,
  });
  if (r.error && !allowFail) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} 실행 실패 (exit ${r.status})${r.stderr ? ": " + String(r.stderr).trim().split("\n")[0] : ""}`);
  }
  return { code: r.status ?? -1, out: String(r.stdout || ""), err: String(r.stderr || "") };
}
const has = (bin) => spawnSync(WIN ? "where" : "command", WIN ? [bin] : ["-v", bin], { stdio: "ignore", shell: !WIN }).status === 0;

// ── 3. 대화형 입력 — `curl … | sh` 로 stdin 이 파이프여도 사람 입력을 받는다 ──────────────────
//  POSIX 의 /dev/tty 는 프로세스의 **제어 단말**이라 stdin 파이프와 독립이다. 이게 없으면
//  `curl … | sh` 가 부트스트랩한 뒤 토큰을 물어볼 방법이 없다(설치가 2단계로 갈라진다).
function ttyIO() {
  if (!WIN) {
    try {
      const fd = openSync("/dev/tty", "r+");
      return { in: new ReadStream(fd), out: new WriteStream(fd), close: () => { try { closeSync(fd); } catch { /* */ } } };
    } catch { /* 단말 없음(CI·데몬) → 아래 폴백 */ }
  }
  return { in: process.stdin, out: process.stderr, close: () => { /* 소유 아님 — 닫지 않는다 */ } };
}
const interactive = () => { const t = ttyIO(); const y = !!t.in.isTTY; t.close(); return y; };

// 가림 입력(에코 없음) — 토큰이 화면·스크롤백·화면녹화·셸 히스토리 어디에도 안 남는다. 비대화형이면 null.
const CTRL_C = "\u0003", CTRL_D = "\u0004", BACKSPACE = "\u007f";
function askHidden(label) {
  const t = ttyIO();
  if (!t.in.isTTY) { t.close(); return Promise.resolve(null); }
  return new Promise((resolve) => {
    t.out.write(label);
    let buf = "";
    const finish = (val) => {
      try { t.in.setRawMode(false); } catch { /* */ }
      t.in.pause(); t.in.off("data", onData); t.out.write("\n"); t.close(); resolve(val);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return finish(buf);
        if (ch === CTRL_C) { finish(null); process.exit(130); return; }
        if (ch === CTRL_D) return finish(buf || null);
        if (ch === BACKSPACE || ch === "\b") { buf = buf.slice(0, -1); continue; }
        if (ch < " ") continue;   // 그 외 제어문자(방향키 등) 무시
        buf += ch;
      }
    };
    t.in.setEncoding("utf8");
    try { t.in.setRawMode(true); } catch { /* */ }
    t.in.resume();
    t.in.on("data", onData);
  });
}

// 예/아니오 — 비대화형이면 기본값을 그대로 쓴다(프롬프트가 자동화를 막지 않게).
function askYesNo(label, def = true) {
  const t = ttyIO();
  if (!t.in.isTTY) { t.close(); return Promise.resolve(def); }
  return new Promise((resolve) => {
    t.out.write(label + (def ? " [Y/n] " : " [y/N] "));
    t.in.setEncoding("utf8");
    t.in.resume();
    t.in.once("data", (d) => {
      t.in.pause(); t.close();
      const s = String(d).trim().toLowerCase();
      resolve(s === "" ? def : /^y/.test(s));
    });
  });
}

// ── 4. 자격(토큰 · 게이트웨이) ──────────────────────────────────────────────
const readLively = (name) => { try { return readFileSync(join(LIVELY, name), "utf8").trim(); } catch { return ""; } };
// mode 는 **생성과 동시에** 준다 — write 후 chmod 하면 그 사이 umask 기본 권한으로 토큰이 잠깐 노출된다(TOCTOU).
//  기존 파일을 덮어쓸 땐 writeFileSync 의 mode 가 무시되므로 chmod 로 한 번 더 못박는다.
function writeLively(name, val, mode = 0o600) {
  mkdirSync(LIVELY, { recursive: true, mode: 0o700 });
  const p = join(LIVELY, name);
  writeFileSync(p, val, { mode });
  try { chmodSync(p, mode); } catch { /* Windows 는 무의미 */ }
}
// gateway-url 은 항상 **/mcp 없이** 저장한다(setup-mac.sh · user-install.mjs 와 같은 계약).
const normGw = (u) => String(u || "").trim().replace(/\/+$/, "").replace(/\/mcp$/, "").replace(/\/+$/, "");
const gateway = () => normGw(process.env.LIVELY_GATEWAY_URL || readLively("gateway-url"));
const token = () => (process.env.LIVELY_TOKEN || readLively("token")).trim();

async function api(path, { timeoutMs = 15000, method = "GET", body } = {}) {
  const gw = gateway(), tok = token();
  if (!gw) throw new Error("게이트웨이 주소를 모릅니다 — `lively login --gateway <url>` 로 지정하세요.");
  if (!tok) throw new Error("로그인이 필요합니다 — `lively login` 을 먼저 실행하세요.");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { authorization: `Bearer ${tok}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(gw + path, { method, signal: ctl.signal, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (res.status === 401 || res.status === 403) throw new Error("토큰이 유효하지 않습니다(만료·회수됨?) — `lively login` 으로 다시 등록하세요.");
    if (!res.ok) { let m = ""; try { m = (await res.json())?.error || ""; } catch { /* */ } throw new Error(`게이트웨이 오류 ${res.status}${m ? " — " + m : ""} (${path})`); }
    return await res.json();
  } finally { clearTimeout(timer); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 위탁(delegate, #869 §11) — 세션이 무거운 1회성 작업을 워커/중앙에 위탁하는 클라이언트 프로세스. ──
//  하네스의 Bash/백그라운드셸/서브에이전트와 동형: 실행→진행 stdout 미러→결과 출력+exit code(0/1).
//  진행 로그는 게이트웨이가 워커 stream.jsonl 을 오프셋 tail 로 릴레이(폴링). 진행은 stderr, 최종 결과는 stdout.
// stream.jsonl 청크를 소비 — 항상 파싱해 최종 result 이벤트를 잡고(스케줄러 타이밍 무관 = 클라 자립),
//  mirror 면 assistant 텍스트/툴사용을 stderr 로 흘린다(진행은 stderr, 최종 결과는 stdout — 분리).
let _cbuf = "", _finalResult = null, _finalIsError = false;
function consumeStream(chunk, mirror) {
  _cbuf += chunk;
  const lines = _cbuf.split("\n"); _cbuf = lines.pop();
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let ev; try { ev = JSON.parse(ln); } catch { continue; }
    if (ev.type === "result") { _finalResult = typeof ev.result === "string" ? ev.result : JSON.stringify(ev); if (ev.is_error) _finalIsError = true; }
    else if (mirror && ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        if (b.type === "text" && b.text) process.stderr.write(dim(b.text) + "\n");
        else if (b.type === "tool_use") process.stderr.write(dim(`· ${b.name}`) + "\n");
      }
    }
  }
}
async function streamAndExit(id, jsonMode) {
  let from = 0, last = "", exitCode = null;
  for (;;) {
    let r;
    try { r = await api(`/api/ui/delegate/${id}/logs?from=${from}`, { timeoutMs: 20000 }); }
    catch (e) { say(dim(`(재연결: ${e.message})`)); await sleep(2000); continue; }
    if (r.pending) { if (last !== "queued") { say(dim("적합한 노드를 기다리는 중…")); last = "queued"; } await sleep(2000); continue; }
    if (r.status === "running" && last !== "running") { say(dim("워커에서 실행 중…")); last = "running"; }
    if (r.chunk) { from = r.next; consumeStream(r.chunk, !jsonMode); }
    if (r.done) { exitCode = r.exit; break; }
    if (!r.chunk) await sleep(1000);
  }
  // 결과 텍스트는 스트림에서 직접 뽑은 게 우선(스케줄러 종결 마킹을 기다리지 않는다). 없으면 status 폴백.
  let result = _finalResult, error = null;
  if (result === null) {
    for (let i = 0; i < 15; i++) {
      const { task } = await api(`/api/ui/delegate/${id}`);
      if (["done", "failed", "canceled"].includes(task.status)) { result = (task.result && task.result.summary) || ""; error = task.error; break; }
      await sleep(1000);
    }
  }
  const ok = exitCode === 0 && !_finalIsError && !error;
  if (jsonMode) { const { task } = await api(`/api/ui/delegate/${id}`); process.stdout.write(JSON.stringify(task) + "\n"); }
  else {
    if (result) process.stdout.write(result + (result.endsWith("\n") ? "" : "\n"));
    if (ok) say(green(`✓ 위탁 #${id} 완료`));
    else say(red(`위탁 실패${error ? ": " + error : exitCode != null ? ` (exit ${exitCode})` : ""} — 워커 세션은 보존됨(웹터미널로 검시)`));
  }
  process.exit(ok ? 0 : 1);
}
// ── 노드(#869) — 이 PC 를 라이블리 노드로 연결(로컬 터미널 원격 관리 + 위탁 워커). ──
//  `lively node`         : foreground(데몬 없이 이 세션 동안만, Ctrl-C 종료)
//  `lively node --daemon`: 상시화(macOS LaunchAgent · Linux systemd --user · WSL2 nohup) — 부팅·로그인마다 자동 기동
//  `lively node stop`    : 데몬 해제(등록·번들은 남김)
//  번들 = agent.mjs(단일) + node-pty(네이티브). ~/.lively/node-agent/ 에 풀어 그 Node 로 실행.
const NODE_AGENT_DIR = join(LIVELY, "node-agent");
const NODE_ENV_FILE = join(LIVELY, "node-agent.env");
const NODE_LOG = join(LIVELY, "logs", "node-agent.log");
const LAUNCHD_LABEL = "io.lvly.node-agent";
const PLIST_PATH = join(HOME, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const SYSTEMD_UNIT = join(HOME, ".config", "systemd", "user", "lively-node-agent.service");

// tmux 절대경로 해석 — 웹터미널·위탁 세션은 tmux 로 실행되므로 노드에 tmux 가 필수다.
//  ⚠ bash -l 로 PATH 를 재설정하지 않는다: 사용자의 대화형 셸(zsh 등) PATH 를 상속한 현재 프로세스에서 찾아야
//   homebrew·사용자 설치 경로가 잡힌다(#869 haru 사례: bash -lc 이 zsh PATH 를 버려 tmux 미검출 → 노드가
//   하드코딩 /opt/homebrew/bin/tmux 로 폴백 → spawn ENOENT → 세션생성 500). 상속 PATH 우선, 없으면 흔한 위치 폴백.
function resolveTmux() {
  try { const p = execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim(); if (p) return p; } catch { /* not on PATH */ }
  for (const c of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/opt/local/bin/tmux", "/usr/bin/tmux"]) { if (existsSync(c)) return c; }
  return null;
}

async function cmdNode(rest) {
  const sub = rest[0];
  if (sub === "stop") return nodeStop();
  const daemon = rest.includes("--daemon");
  const nodeId = (rest.includes("--id") ? rest[rest.indexOf("--id") + 1] : "") || slugHost();
  const gw = gateway(), tok = token();
  if (!gw || !tok) die("로그인이 필요합니다 — `lively login` 먼저.", 2);
  // tmux 필수 — 웹터미널·위탁 세션이 tmux 로 실행된다. 등록/설치 전에 먼저 막아 반쪽 상태(등록됐지만 세션 불가)를
  //  남기지 않는다. 이미 설정된 TMUX_BIN(격리 소켓 shim 등)은 존중, 없으면 상속 PATH 에서 해석. 절대경로라 데몬(최소 PATH)도 안전.
  const tmuxPath = process.env.TMUX_BIN || resolveTmux();
  if (!tmuxPath) die("tmux 가 필요합니다 — 웹터미널·위탁 세션이 tmux 로 실행됩니다. 설치 후 다시 실행하세요:\n" +
    "  · macOS:        brew install tmux\n  · Debian/Ubuntu: sudo apt install -y tmux\n  · Fedora/RHEL:   sudo dnf install -y tmux", 2);

  // 1) 노드 토큰 — 로컬에 있으면 재사용, 없으면 등록(중복이면 회전).
  let nodeTok = readEnvFile(NODE_ENV_FILE, "LIVELY_NODE_TOKEN");
  if (!nodeTok) {
    say(dim(`· 노드 등록: ${nodeId}`));
    let r = await api("/api/ui/nodes", { method: "POST", body: { id: nodeId, name: hostname() } }).catch((e) => ({ __err: e }));
    if (r.__err) { // 이미 존재 → 토큰 회전으로 새 토큰 확보(본인 노드여야 통과)
      r = await api(`/api/ui/nodes/${encodeURIComponent(nodeId)}/rotate`, { method: "POST", body: {} }).catch((e2) => die(`노드 등록/회전 실패 — ${e2.message}`, 1));
    }
    nodeTok = r.token;
    say(green(`✓ 노드 '${nodeId}' 등록됨`));
  }
  // 접속정보 env 파일(0600) — foreground 는 spawn env, 데몬은 이 파일을 읽는다. TMUX_BIN 은 절대경로(데몬 최소 PATH 안전).
  writeLively("node-agent.env",
    `LIVELY_GATEWAY_URL=${gw}\nLIVELY_NODE_TOKEN=${nodeTok}\nLIVELY_NODE_ID=${nodeId}\nTMUX_BIN=${tmuxPath}\n`, 0o600);

  // 2) 에이전트 번들 내려받기(멤버 pull) → ~/.lively/node-agent/
  say(dim("· 노드 에이전트 내려받는 중…"));
  mkdirSync(NODE_AGENT_DIR, { recursive: true });
  const res = await fetch(gw + "/api/ui/node-agent", { headers: { authorization: `Bearer ${tok}` } });
  if (!res.ok) die(`에이전트 번들 다운로드 실패 HTTP ${res.status}`, 1);
  const tgz = join(NODE_AGENT_DIR, "bundle.tgz");
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  try { execFileSync("tar", ["-xzf", tgz, "-C", NODE_AGENT_DIR], { stdio: "ignore" }); }
  catch (e) { die(`번들 해제 실패 — ${e.message}`, 1); }
  rmSync(tgz, { force: true });
  const agentJs = join(NODE_AGENT_DIR, "agent.mjs");
  if (!existsSync(agentJs)) die("번들에 agent.mjs 가 없습니다.", 1);

  // 3) 실행 — 데몬(상시화) 또는 foreground.
  if (daemon) return nodeInstallDaemon(agentJs, nodeId);
  say(green(`✓ 노드 '${nodeId}' 연결 — 웹 터미널 탭의 '실행 위치'에서 이 노드를 고르세요. (Ctrl-C 로 종료)`));
  const child = spawn(process.execPath, [agentJs], {
    stdio: "inherit",
    env: { ...process.env, LIVELY_GATEWAY_URL: gw, LIVELY_NODE_TOKEN: nodeTok, LIVELY_NODE_ID: nodeId, TMUX_BIN: tmuxPath },
  });
  child.on("exit", (code, sig) => process.exit(sig ? 1 : (code ?? 0)));
}

// 상시화 — install.sh 의 데몬 등록을 번들 기반으로 포팅(node ~/.lively/node-agent/agent.mjs).
function nodeInstallDaemon(agentJs, nodeId) {
  mkdirSync(join(LIVELY, "logs"), { recursive: true });
  const nodeBin = process.execPath;
  const runCmd = `set -a; . '${NODE_ENV_FILE}'; exec '${nodeBin}' '${agentJs}'`;
  if (process.platform === "darwin") {
    mkdirSync(join(HOME, "Library", "LaunchAgents"), { recursive: true });
    const uid = process.getuid();
    spawnSync("launchctl", ["bootout", `gui/${uid}`, PLIST_PATH], { stdio: "ignore" });
    writeFileSync(PLIST_PATH, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-lc</string><string>${runCmd.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${NODE_LOG}</string>
  <key>StandardErrorPath</key><string>${NODE_LOG}</string>
</dict></plist>\n`);
    const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, PLIST_PATH], { stdio: "inherit" });
    if (r.status !== 0) die("LaunchAgent 등록 실패 — launchctl bootstrap", 1);
    say(green(`✅ 노드 '${nodeId}' 상시화(LaunchAgent) — 부팅·로그인마다 자동 연결`));
    say(dim(`   중지: lively node stop   ·   로그: tail -f ${NODE_LOG}`));
    return;
  }
  if (process.platform === "linux") {
    if (!existsSync("/run/systemd/system")) { // WSL2 등 systemd 미활성 → nohup
      spawnSync("pkill", ["-f", "node-agent/agent.mjs"], { stdio: "ignore" });
      spawn("bash", ["-lc", `nohup bash -lc "${runCmd}" >> '${NODE_LOG}' 2>&1 &`], { detached: true, stdio: "ignore" }).unref();
      say(green(`✅ 노드 '${nodeId}' 기동(systemd 미활성 → nohup)`));
      say(dim("   상시화: /etc/wsl.conf 에 [boot] systemd=true 추가 후 'wsl --shutdown' → 재실행"));
      return;
    }
    mkdirSync(join(HOME, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(SYSTEMD_UNIT, `[Unit]
Description=Lively node agent (#869)
After=network-online.target

[Service]
Type=simple
EnvironmentFile=${NODE_ENV_FILE}
ExecStart=${nodeBin} ${agentJs}
Restart=always
RestartSec=3
StandardOutput=append:${NODE_LOG}
StandardError=append:${NODE_LOG}

[Install]
WantedBy=default.target\n`);
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    const r = spawnSync("systemctl", ["--user", "enable", "--now", "lively-node-agent.service"], { stdio: "inherit" });
    if (r.status !== 0) die("systemd 등록 실패 — systemctl --user enable --now", 1);
    say(green(`✅ 노드 '${nodeId}' 상시화(systemd --user)`));
    say(dim("   부팅 유지: loginctl enable-linger $USER   ·   중지: lively node stop"));
    return;
  }
  die(`미지원 OS: ${process.platform} — Windows 는 WSL2 안에서 실행하세요.`, 1);
}

function nodeStop() {
  if (process.platform === "darwin") {
    spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, PLIST_PATH], { stdio: "ignore" });
    rmSync(PLIST_PATH, { force: true });
    say(green("✅ 노드 데몬 해제(LaunchAgent)"));
  } else if (process.platform === "linux") {
    spawnSync("systemctl", ["--user", "disable", "--now", "lively-node-agent.service"], { stdio: "ignore" });
    rmSync(SYSTEMD_UNIT, { force: true });
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    spawnSync("pkill", ["-f", "node-agent/agent.mjs"], { stdio: "ignore" });
    say(green("✅ 노드 데몬 해제(systemd)"));
  } else { die(`미지원 OS: ${process.platform}`, 1); }
  say(dim("   (노드 등록·번들은 남습니다 — 완전 제거는 웹/REST 로 노드 삭제)"));
}
// 호스트명 → 노드 id 슬러그(소문자·숫자·하이픈).
function slugHost() {
  return (hostname().split(".")[0] || "node").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "node";
}
function readEnvFile(file, key) {
  try { const m = readFileSync(file, "utf8").match(new RegExp("^" + key + "=(.*)$", "m")); return m ? m[1].trim() : null; }
  catch { return null; }
}

async function cmdDelegate(rest) {
  const sub = rest[0];
  const needId = (v) => { if (!/^\d+$/.test(v || "")) die("위탁 번호가 필요합니다. 예: lively delegate status 3", 2); return v; };
  if (sub === "status") { const { task } = await api(`/api/ui/delegate/${needId(rest[1])}`); process.stdout.write(JSON.stringify(task, null, 2) + "\n"); return; }
  if (sub === "cancel") { await api(`/api/ui/delegate/${needId(rest[1])}/cancel`, { method: "POST", body: {} }); say(green(`위탁 #${rest[1]} 취소됨`)); return; }
  if (sub === "list") { const { tasks } = await api("/api/ui/delegate"); for (const t of (tasks || [])) say(`#${t.id}  ${t.status}${t.node_id ? "  @" + t.node_id : ""}  ${dim((t.prompt || "").slice(0, 60).replace(/\s+/g, " "))}`); return; }
  if (sub === "logs") { await streamAndExit(needId(rest[1]), rest.includes("--json")); return; }
  // 기본: 위탁 실행 — rest = 프롬프트 + 옵션.
  const need = {}; let detach = false, jsonMode = false; const parts = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--ram") need.need_ram_mb = Number(rest[++i]);
    else if (t === "--cpu") need.need_cpu = Number(rest[++i]);
    else if (t === "--disk") need.need_disk_mb = Number(rest[++i]);
    else if (t === "--timeout") need.timeout_sec = Number(rest[++i]);
    else if (t === "--node") need.node = rest[++i];
    else if (t === "--repo") need.repo = rest[++i];
    else if (t === "--ref") need.ref = rest[++i];
    else if (t === "--docker") need.needs_docker = true;
    else if (t === "--detach") detach = true;
    else if (t === "--json") jsonMode = true;
    else parts.push(t);
  }
  const prompt = parts.join(" ").trim();
  if (!prompt) die('위탁할 작업 지시가 필요합니다.  예: lively delegate "테스트 전체 실행하고 결과 보고" --ram 2048', 2);
  // CLI 는 자체 로그 스트리밍(streamAndExit)을 하므로 서버 wait 는 끈다(이중 대기 방지).
  //  queue 옵션은 CLI 에선 기본 대기(배치 불가면 계속 폴링) — 서버엔 queue:true 로 등록(no_capacity 즉실패 대신).
  const res = await api("/api/ui/delegate", { method: "POST", body: { prompt, ...need, wait: false, queue: true } });
  if (res.no_capacity) { say(red(`위탁 불가 — ${res.reason || "가용 노드 없음"}`)); say(dim("로컬에서 직접 실행하세요.")); process.exit(2); }
  const task = res.task;
  if (detach) { say(green(`위탁 #${task.id} 생성 — 진행: lively delegate logs ${task.id}`)); process.stdout.write(String(task.id) + "\n"); return; }
  say(dim(`위탁 #${task.id} 생성 — 배치 대기…`));
  await streamAndExit(task.id, jsonMode);
}

// ── 5. 하네스 감지 ──────────────────────────────────────────────────────────
//  PATH 우선, 없으면 **디스크 배선**으로 판정한다. 왜 둘 다 보나 — 갓 부트스트랩한 셸이나 detached 자식은
//  PATH 가 빈약해 `command -v claude` 를 못 믿는다(#858 에서 실측한 함정). 배선이 있으면 설치된 것으로 본다.
function detectHarnesses() {
  const out = new Set();
  if (has("claude")) out.add("claude");
  if (has("codex")) out.add("codex");
  try {
    const s = readFileSync(join(CLAUDE_DIR, "settings.json"), "utf8");
    if (s.includes(".lively/hooks/") || s.includes(".lively\\hooks\\")) out.add("claude");
  } catch { /* */ }
  try { if (readFileSync(CODEX_CFG, "utf8").includes("lively-managed")) out.add("codex"); } catch { /* */ }
  return [...out];
}

// ── 6. 번들 — 다운로드 · 검증 ───────────────────────────────────────────────
async function downloadBundle() {
  const gw = gateway(), tok = token();
  const dir = mkdtempSync(join(tmpdir(), "lively-cli-"));
  const tgz = join(dir, "kit.tgz");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  let buf;
  try {
    const res = await fetch(gw + "/install", { signal: ctl.signal, headers: { authorization: `Bearer ${tok}` } });
    if (res.status === 401 || res.status === 403) throw new Error("토큰이 유효하지 않습니다 — `lively login` 으로 다시 등록하세요.");
    if (!res.ok) throw new Error(`키트 다운로드 실패 (HTTP ${res.status})`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    if (e?.name === "AbortError") throw new Error("키트 다운로드 타임아웃 — 네트워크를 확인하세요.");
    throw e;
  } finally { clearTimeout(timer); }
  // 프록시가 로그인 페이지·에러 HTML 을 200 으로 돌려주는 사고를 여기서 잡는다(tar 가 쓰레기를 풀지 않게).
  if (buf.length < 1024) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`키트가 비정상적으로 작습니다(${buf.length}B) — 게이트웨이 주소를 확인하세요.`);
  }
  writeFileSync(tgz, buf);
  const root = join(dir, "kit");
  mkdirSync(root, { recursive: true });
  run("tar", ["-xzf", tgz, "-C", root], { quiet: true });
  return { dir, root };
}

// 손상 번들로 ~/.lively/hooks 를 덮으면 그 멤버의 **모든 세션에서 훅이 죽는다** → 여기가 마지막 방어선.
//  self-update.mjs 의 verifyBundle 과 같은 판정(필수 러너 존재 + 비어있지 않음 + node --check 구문검사).
function verifyBundle(root) {
  const installer = join(root, "setup", "user-install.mjs");
  if (!existsSync(installer)) throw new Error("번들 손상 — setup/user-install.mjs 없음");
  const hooksDir = join(root, ".claude", "hooks");
  for (const h of REQUIRED_HOOKS) {
    const p = join(hooksDir, h);
    if (!existsSync(p)) throw new Error(`번들 손상 — 훅 누락: ${h}`);
    if (statSync(p).size < 64) throw new Error(`번들 손상 — 훅이 비었음: ${h}`);
  }
  const files = [installer];
  try { for (const f of readdirSync(hooksDir)) if (f.endsWith(".mjs")) files.push(join(hooksDir, f)); } catch { /* */ }
  const cli = join(root, "cli", "lively.mjs");
  if (existsSync(cli)) files.push(cli);   // CLI 가 자기 후임을 검증한다(자기 발등 찍기 방지)
  for (const f of files) {
    if (spawnSync(process.execPath, ["--check", f], { stdio: "ignore" }).status !== 0) {
      throw new Error(`번들 손상 — 구문 오류: ${f.slice(root.length)}`);
    }
  }
  try { return readFileSync(join(root, ".lively", "kit-version"), "utf8").trim(); } catch { return ""; }
}

// ── 7. MCP 등록 — 이 CLI 의 존재 이유 ───────────────────────────────────────
//  kit/setup/register-clients.sh 와 **동일한 claude 호출**을 Node 로 재현한다(bash·PowerShell 분기 제거 →
//  mac/linux/windows 가 같은 코드). 셸 스크립트는 setup-mac.sh · deploy/install-kit.sh 하위호환으로 남는다.
//  Codex 는 MCP 를 config.toml 에 쓰므로(user-install.mjs 가 담당) 여기서 할 일이 없다.
function readMcpServers() {
  try {
    const d = JSON.parse(readFileSync(join(LIVELY, "mcp-servers.json"), "utf8"));
    return Array.isArray(d.servers) ? d.servers : [];
  } catch { return []; }
}

// 비파괴 라운드트립 — 유저가 라이블리 이전부터 쓰던 org-겹침 MCP(linear/notion 등)를 **덮어쓰기 전에** 스냅샷한다.
//  uninstall(deregisterExtraMcp)이 이걸 읽어 원복 → 유저 원본이 살아난다. 안 하면 설치가 덮어쓰고 제거가 지워 영구 소실(#744 갭).
//  claude 는 user 스코프 MCP 를 $HOME/.claude.json 의 mcpServers 에 쓴다(run() 이 ambient HOME 으로 claude 실행 = 여기 HOME).
function claudeUserMcp(name) {
  try { return JSON.parse(readFileSync(join(HOME, ".claude.json"), "utf8"))?.mcpServers?.[name] ?? null; }
  catch { return null; }
}
//  **최초 1회만** 스냅샷 — 이미 백업에 키가 있으면 스킵. 재설치/업데이트가 (이미 라이블리가 덮어쓴) 자기 항목을
//  '유저 것'으로 오인해 백업을 오염시키지 않도록. 값: 유저 항목(객체) 또는 null(설치 전 없었음 → 제거 시 그대로 유지).
function backupUserMcp(name) {
  const p = join(LIVELY, "mcp-user-backup.json");
  let bak = {};
  try { bak = JSON.parse(readFileSync(p, "utf8")) || {}; } catch { bak = {}; }
  if (Object.prototype.hasOwnProperty.call(bak, name)) return;
  bak[name] = claudeUserMcp(name);
  try { writeFileSync(p, JSON.stringify(bak, null, 2) + "\n", { mode: 0o600 }); } catch { /* best-effort — 백업 실패해도 등록은 진행 */ }
}

function registerClaudeMcp() {
  const gw = gateway(), tok = token();
  if (!has("claude")) { info("claude 미설치 — MCP 등록 건너뜀"); return { registered: 0, failed: 0 }; }
  let registered = 0, failed = 0;
  // lively 본체 — remove 후 add(재실행 안전). remove 실패는 정상(미등록 상태).
  run("claude", ["mcp", "remove", "lively"], { allowFail: true, quiet: true });
  try {
    run("claude", ["mcp", "add", "--transport", "http", "--scope", "user", "lively", `${gw}/mcp`,
      "--header", `Authorization: Bearer ${tok}`], { quiet: true });
    ok(`MCP 등록: lively → ${gw}/mcp`);
    registered++;
  } catch (e) { fail(`MCP 등록 실패(lively): ${e.message}`); failed++; }

  // 조직 추가 MCP 서버 — auth_env 는 환경변수 '이름' 간접참조(토큰 리터럴을 파일에 두지 않는다).
  for (const s of readMcpServers()) {
    if (!s || s.enabled === false || !s.name || s.name === "lively") continue;
    backupUserMcp(s.name); // 덮어쓰기 전 유저 원본 스냅샷(최초 1회) — uninstall 원복용(비파괴 라운드트립)
    run("claude", ["mcp", "remove", s.name], { allowFail: true, quiet: true });
    try {
      if (s.transport === "stdio" && s.command) {
        // claude stdio 는 command+args 를 분리 인자로 받는다(공백 토큰 분리 — register-clients.sh 와 동일 한계).
        const parts = String(s.command).trim().split(/\s+/).filter(Boolean);
        run("claude", ["mcp", "add", "--transport", "stdio", "--scope", "user", s.name, ...parts], { quiet: true });
      } else if (s.url) {
        const secret = s.auth_env ? (process.env[s.auth_env] || "") : "";
        const a = ["mcp", "add", "--transport", "http", "--scope", "user", s.name, s.url];
        if (secret) a.push("--header", `Authorization: Bearer ${secret}`);
        run("claude", a, { quiet: true });
        if (s.auth_env && !secret) warn(`${s.name}: 환경변수 ${s.auth_env} 가 비어 무인증 등록됨`);
      } else continue;
      ok(`MCP 등록: ${s.name}`);
      registered++;
    } catch (e) { fail(`MCP 등록 실패(${s.name}): ${e.message}`); failed++; }
  }
  return { registered, failed };
}

// ── 8. 설치/업데이트의 단일 코드 경로 ───────────────────────────────────────
//  install 과 update 는 같은 일을 한다(멱등). 다른 건 문구와, install 이 claude 부재 시 설치를 제안한다는 것뿐.
async function syncKit({ label, offerHarness }) {
  if (!gateway()) die("게이트웨이 주소를 모릅니다 — `lively login --gateway <url>` 로 지정하세요.");
  if (!token()) die("로그인이 필요합니다 — 먼저 `lively login` 을 실행하세요.");

  let harnesses = detectHarnesses();
  if (!harnesses.length && offerHarness) {
    warn("Claude Code · Codex 가 둘 다 안 보입니다.");
    if (WIN) {
      // Windows 엔 sh 가 없다 — 공식 설치 안내만 하고 진행한다(있지도 않은 셸을 부르고 조용히 실패하지 않는다).
      info("Claude Code 를 먼저 설치하세요: https://code.claude.com/docs/setup  → 설치 후 `lively install` 재실행");
    } else if (await askYesNo("  Claude Code 를 지금 설치할까요?", true)) {
      run("sh", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"], { allowFail: true });
      // claude 설치기는 ~/.local/bin 에 넣고 PATH 영속화는 사용자 몫으로 남긴다 — 이 프로세스에서만 보이게 해 둔다.
      process.env.PATH = `${join(HOME, ".local", "bin")}:${process.env.PATH || ""}`;
      harnesses = detectHarnesses();
    }
  }
  if (!harnesses.length) {
    warn("하네스 없이 진행합니다 — 맥락·훅은 설치되지만 켤 AI 가 없습니다.");
    info("Claude Code 설치 후 `lively install` 을 다시 실행하면 배선이 완료됩니다.");
    harnesses = ["claude"];   // 자산은 깔아 둔다 — 나중에 claude 를 깔면 바로 작동.
  }

  say(`\n${bold(label)}  ${dim("하네스: " + harnesses.join(", "))}`);
  say(dim("  [1/3] 키트 내려받는 중…"));
  const { dir, root } = await downloadBundle();
  try {
    const version = verifyBundle(root);
    ok(`키트 검증 완료${version ? "  " + dim("(" + version + ")") : ""}`);

    say(dim("  [2/3] 설치 중…"));
    // 설치의 엔진은 번들 동봉 user-install.mjs — 비파괴 머지·백업·auto-approve reconcile 이 전부 거기 있다.
    run(process.execPath, [join(root, "setup", "user-install.mjs"), "--clone-root", root, "--harness", harnesses.join(",")]);

    say(dim("  [3/3] MCP 등록 중…"));
    const r = registerClaudeMcp();
    if (r.failed) warn(`MCP 등록 ${r.failed}건 실패 — 위 오류를 확인하고 다시 시도하세요.`);

    say("");
    say(green(bold("=== 끝! ===")));
    say(`  이제 아무 폴더에서든 ${bold("claude")}${harnesses.includes("codex") ? " · " + bold("codex") : ""} 를 켜면 회사 맥락이 따라옵니다.`);
    say(dim("  (훅은 세션 시작에 스냅샷됩니다 — 이미 켜 둔 세션이 있으면 껐다 켜세요.)"));
    say(dim("  상태 확인: ") + bold("lively status") + dim("    문제 진단: ") + bold("lively doctor"));
    return version;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 9. 로그인 ──────────────────────────────────────────────────────────────
// PKCE S256 — 서버(device-auth.ts)와 동일 계산. verifier→challenge.
const s256 = (verifier) => crypto.createHash("sha256").update(verifier).digest("base64url");

// 브라우저 자동 오픈 — best-effort·detached·비블로킹·전 에러 무시(폴 루프를 절대 안 막음, 설계 V2).
//  darwin `open` · win `cmd /c start "" <url>`(빈 title 필수) · linux `xdg-open`(단 $DISPLAY 있을 때만 — headless no-op).
function openBrowser(url) {
  try {
    let cmd, args;
    if (process.platform === "darwin") { cmd = "open"; args = [url]; }
    else if (WIN) { cmd = "cmd"; args = ["/c", "start", "", url]; }
    else {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return; // 헤드리스 — URL 만 표시(위에서 이미 출력)
      cmd = "xdg-open"; args = [url];
    }
    const c = spawn(cmd, args, { detached: true, stdio: "ignore" });
    c.on("error", () => { /* 브라우저 없음 등 — 무시 */ });
    c.unref();
  } catch { /* best-effort */ }
}

// 토큰 신원 확인(옵션으로 저장) — --token·디바이스 흐름·폴백이 공유. me 반환. store=false 면 확인만(디바이스 흐름이
//  저장 전 [Y/n] 을 물어야 하므로 — 저장 후 취소는 어색).
async function validateAndStore(gw, tok, { announce = true, store = true } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  let me;
  try {
    const res = await fetch(gw + "/api/ui/me/profile", { signal: ctl.signal, headers: { authorization: `Bearer ${tok}` } });
    if (res.status === 401 || res.status === 403) die("토큰이 거부됐습니다 — 관리자에게 받은 토큰이 맞는지 확인하세요.");
    if (!res.ok) die(`게이트웨이가 정상 응답하지 않습니다 (HTTP ${res.status}) — 주소를 확인하세요: ${gw}`);
    me = await res.json();
  } catch (e) {
    if (e?.name === "AbortError") die(`게이트웨이 응답 없음(타임아웃) — 주소·네트워크·VPN 을 확인하세요: ${gw}`);
    throw e;
  } finally { clearTimeout(timer); }
  if (store) {
    writeLively("token", tok);
    writeLively("gateway-url", gw);
    if (announce) {
      say("");
      ok(`${bold(me?.display_name || me?.id || "구성원")} 님으로 인증됐습니다.`);
      info(`토큰 저장: ~/.lively/token (0600) · 게이트웨이: ${gw}`);
    }
  }
  return me;
}

// 토큰 가림입력 경로(구 방식) — 롤백 폴백 + 비대화형이 아닐 때의 명시적 요청. 셸 히스토리에 안 남는다.
async function loginWithPastedToken(gw) {
  if (!interactive()) die("비대화형 환경입니다 — `lively login --token <토큰>` 또는 LIVELY_TOKEN 환경변수를 쓰세요.");
  say(`\n${bold("라이블리 로그인")}  ${dim(gw)}`);
  say(dim("  토큰은 관리자에게 받거나, 웹 [사용 가이드 › 내 AI 세션 생성] 에서 발급합니다."));
  const tok = String(await askHidden("  접속 토큰을 붙여넣으세요 (화면에 안 보입니다): ") || "").trim();
  if (!tok) die("토큰이 비어 있습니다.");
  return validateAndStore(gw, tok);
}

// 디바이스 코드 흐름(기본 대화형). 서버가 디바이스 엔드포인트를 모르면(구 서버·롤백) 'unsupported' 반환 → 폴백.
async function deviceLogin(gw) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const label = `${process.env.LIVELY_HARNESS || "lively"}@${hostLabel()}`;
  // ① start — 404/501/비-JSON/500 이면 폴백(구 서버).
  let start;
  try {
    const res = await fetch(gw + "/cli/device/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code_challenge: s256(verifier), label }),
    });
    if (res.status === 404 || res.status === 501 || res.status === 500) return "unsupported";
    const text = await res.text();
    try { start = JSON.parse(text); } catch { return "unsupported"; } // 비-JSON(로그인 HTML 등) → 폴백
    if (!res.ok || !start.device_code) return "unsupported";
  } catch (e) {
    // 네트워크 실패는 폴백이 아니라 진짜 오류(주소·연결) — 명확히 알린다.
    die(`게이트웨이에 연결하지 못했습니다 (${e.message}) — 주소·네트워크를 확인하세요: ${gw}`);
  }

  // ② URL·코드 먼저 출력(브라우저 오픈은 순수 부가).
  say(`\n${bold("라이블리 로그인")}  ${dim(gw)}`);
  say("  아래 주소를 브라우저에서 열어 승인하세요:");
  say("    " + bold(start.verification_uri));
  say("    코드: " + bold(start.user_code));
  say(dim("  (브라우저가 자동으로 열립니다. 안 열리면 위 주소를 직접 여세요.)"));
  openBrowser(start.verification_uri_complete || start.verification_uri);
  say(dim("  · 브라우저에서 승인을 기다리는 중… (이 창은 열어 두세요)"));

  // ③ 폴 루프 — 전송오류 내성(백오프 계속), 종료는 명시적 denied/expired/invalid 만.
  let interval = Math.max(2, Number(start.interval) || 5);
  const deadline = Date.now() + (Number(start.expires_in) || 900) * 1000;
  for (;;) {
    await sleep(interval * 1000);
    if (Date.now() > deadline) die("코드가 만료됐습니다 — `lively login` 을 다시 실행하세요.");
    let status, body;
    try {
      const res = await fetch(gw + "/cli/device/poll", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: start.device_code, code_verifier: verifier }),
      });
      status = res.status;
      const text = await res.text();
      try { body = JSON.parse(text); } catch { body = null; } // 비-JSON(Caddy 502 등) → 일시 오류
    } catch { status = 0; body = null; } // ECONNREFUSED·타임아웃 등 → 일시 오류
    if (status === 200 && body?.token) return { token: body.token, scopes: body.scopes || [] };
    if (status === 202) continue;                                  // authorization_pending
    if (status === 429) { interval = (Number(body?.interval) || interval) + 5; continue; } // slow_down
    if (status === 403) die("승인이 거부됐습니다.");
    if (status === 410 || status === 401) die("코드가 만료됐습니다 — `lively login` 을 다시 실행하세요.");
    // 그 외(0·5xx·비-JSON) = 일시 오류 → 백오프 후 계속(게이트웨이 재시작 중일 수 있음, DB 행은 살아있음).
  }
}

// 호스트 라벨(승인 화면 표시용, 자기주장 값) — 서버가 [\w .@-] 로 제한한다.
function hostLabel() {
  try { return String(spawnSync("hostname", [], { encoding: "utf8" }).stdout || "").trim().split(".")[0] || "내PC"; }
  catch { return "내PC"; }
}

async function cmdLogin(opts) {
  if (opts.gateway) writeLively("gateway-url", normGw(opts.gateway));
  const gw = gateway();
  if (!gw) die("게이트웨이 주소가 없습니다 — `lively login --gateway https://<주소>` 로 지정하세요.");

  // ① --token / LIVELY_TOKEN — CI·프로비저닝 탈출구(디바이스 흐름 건너뜀).
  const explicit = opts.token || (process.env.LIVELY_TOKEN || "").trim();
  if (explicit) return validateAndStore(gw, String(explicit).trim());

  // ② 비대화형(TTY 없음)인데 토큰도 없음 → 명확 안내.
  if (!interactive()) die("비대화형 환경입니다 — `lively login --token <토큰>` 또는 LIVELY_TOKEN 환경변수를 쓰세요.");

  // ③ 기본: 브라우저 디바이스 흐름. 서버가 모르면(구 서버·롤백) 토큰 가림입력으로 폴백.
  const dev = await deviceLogin(gw);
  if (dev === "unsupported") {
    info("이 게이트웨이는 브라우저 로그인을 아직 지원하지 않습니다 — 토큰 입력으로 진행합니다.");
    return loginWithPastedToken(gw);
  }
  // ④ 저장 전 신원 확인(역방향 피싱 방어, R2-F1) — 불변 email 로. 확인 통과 후에만 저장.
  const me = await validateAndStore(gw, dev.token, { store: false });
  const who = me?.email || me?.id || "구성원";
  say("");
  const yes = await askYesNo(`  ${bold(who)} 로 로그인됩니다. 계속할까요?`, true);
  if (!yes) die("이 로그인은 당신이 시작한 게 아닐 수 있습니다 — 저장을 취소했습니다.", 1);
  writeLively("token", dev.token);
  writeLively("gateway-url", gw);
  ok(`${bold(who)} 님으로 로그인됐습니다. (토큰 저장: ~/.lively/token)`);
  return me;
}

function cmdLogout() {
  const p = join(LIVELY, "token");
  if (!existsSync(p)) { info("이미 로그아웃 상태입니다(저장된 토큰 없음)."); return; }
  rmSync(p, { force: true });
  ok("토큰을 지웠습니다 (~/.lively/token).");
  info("설치 자산은 그대로입니다 — 완전 제거는 `lively uninstall`.");
  info("claude 에 등록된 MCP 항목은 남아 있습니다 — 지우려면 `claude mcp remove lively`.");
}

const cmdInstall = () => syncKit({ label: "라이블리 설치", offerHarness: true });

async function cmdUpdate(opts) {
  if (opts.check) {
    const st = await gatherStatus();
    if (!st.gateway.reachable) die(`게이트웨이에 닿지 못했습니다 — ${st.gateway.error || "원인 불명"}`);
    if (!st.kit.remote) { info("게이트웨이가 키트 버전을 알려주지 않습니다(구버전 게이트웨이)."); return; }
    if (st.kit.current) ok(`이미 최신입니다 (${st.kit.local}).`);
    else {
      warn(`업데이트가 있습니다: ${st.kit.local || "(미설치)"} → ${st.kit.remote}`);
      say(dim("  적용: ") + bold("lively update"));
    }
    return;
  }
  await syncKit({ label: "라이블리 업데이트", offerHarness: false });
}

const uninstallArgs = (o) => [
  ...(o.dryRun ? ["--dry-run"] : []), ...(o.purge ? ["--purge"] : []), ...(o.yes ? ["--yes"] : []),
  ...(o.harness ? ["--harness", o.harness] : []),
];

async function cmdUninstall(opts) {
  // 제거기도 **설치와 같은 세대**를 쓴다 — 센티넬 리터럴이 짝이 맞아야 완전복구가 성립한다(#744).
  //  로그아웃/오프라인이면 설치 때 함께 심어 둔 로컬 사본(~/.lively/lib)으로 폴백한다(제거는 언제나 가능해야 한다).
  if (token() && gateway()) {
    let bundle = null;
    try { bundle = await downloadBundle(); }
    catch (e) { warn(`번들을 못 받아 로컬 제거기로 진행합니다 (${e.message})`); }
    if (bundle) {
      try {
        const un = join(bundle.root, "setup", "user-uninstall.mjs");
        if (existsSync(un)) { run(process.execPath, [un, ...uninstallArgs(opts)]); return; }
        warn("번들에 제거기가 없습니다(구버전 게이트웨이) — 로컬 제거기로 진행합니다.");
      } finally { rmSync(bundle.dir, { recursive: true, force: true }); }
    }
  }
  const local = join(LIVELY, "lib", "user-uninstall.mjs");
  if (!existsSync(local)) die("제거기를 찾지 못했습니다 — `lively login` 후 다시 시도하세요.");
  run(process.execPath, [local, ...uninstallArgs(opts)]);
}

// 상태 수집 — status 와 doctor 가 공유. 네트워크 실패는 예외가 아니라 **값**으로 담는다(진단이 목적이라 죽으면 안 된다).
async function gatherStatus() {
  const gw = gateway(), tok = token();
  const st = {
    cli: CLI_VERSION,
    gateway: { url: gw || null, reachable: false, error: null },
    account: { authenticated: false, id: null, name: null },
    kit: { local: readLively("kit-version") || null, remote: null, current: false, autoUpdate: null },
    harness: {
      claude: { installed: has("claude"), wired: false, mcp: false },
      codex: { installed: has("codex"), wired: false },
    },
    hooks: { installed: 0, expected: REQUIRED_HOOKS.length },
  };
  try {
    const s = readFileSync(join(CLAUDE_DIR, "settings.json"), "utf8");
    st.harness.claude.wired = s.includes(".lively/hooks/") || s.includes(".lively\\hooks\\");
  } catch { /* */ }
  try { st.harness.codex.wired = readFileSync(CODEX_CFG, "utf8").includes("lively-managed"); } catch { /* */ }
  try { st.hooks.installed = readdirSync(join(LIVELY, "hooks")).filter((f) => REQUIRED_HOOKS.includes(f)).length; } catch { /* */ }
  if (st.harness.claude.installed) {
    const r = run("claude", ["mcp", "list"], { allowFail: true, quiet: true });
    st.harness.claude.mcp = /(^|\s)lively\b/m.test(r.out + r.err);
  }
  if (!gw) { st.gateway.error = "게이트웨이 미설정"; return st; }
  if (!tok) { st.gateway.error = "로그인 필요"; return st; }
  try {
    const rc = await api("/api/ui/org/runtime-config", { timeoutMs: 8000 });
    st.gateway.reachable = true;
    st.account.authenticated = true;
    st.kit.remote = typeof rc?.kit_version === "string" ? rc.kit_version : null;
    st.kit.current = !!(st.kit.remote && st.kit.local && st.kit.remote === st.kit.local);
    st.kit.autoUpdate = rc?.hooks?.self_update !== false;
    try {
      const me = await api("/api/ui/me/profile", { timeoutMs: 8000 });
      st.account.id = me?.id ?? null;
      st.account.name = me?.display_name ?? null;
    } catch { /* 프로필은 부가 정보 — 실패해도 상태는 유효 */ }
  } catch (e) { st.gateway.error = e.message; }
  return st;
}

async function cmdStatus(opts) {
  const st = await gatherStatus();
  if (opts.json) { process.stdout.write(JSON.stringify(st, null, 2) + "\n"); return; }
  const mark = (b) => (b ? green("✓") : dim("–"));
  say(`\n${bold("라이블리")} ${dim("CLI " + st.cli)}\n`);
  say(`  게이트웨이    ${st.gateway.url || dim("(미설정)")}  ${st.gateway.reachable ? green("도달 OK") : red(st.gateway.error || "도달 실패")}`);
  say(`  계정          ${st.account.authenticated ? (st.account.name || st.account.id || "인증됨") : dim("미인증")}`);
  if (st.kit.remote || st.kit.local) {
    say(`  키트 버전     ${st.kit.current ? green(`${st.kit.local} (최신)`)
      : st.kit.remote ? yellow(`${st.kit.local || "(미설치)"} → ${st.kit.remote} 업데이트 있음`)
        : String(st.kit.local)}`);
  }
  say(`  훅            ${st.hooks.installed}/${st.hooks.expected} ${mark(st.hooks.installed === st.hooks.expected)}`);
  say(`  claude        ${mark(st.harness.claude.installed)} 설치   ${mark(st.harness.claude.wired)} 배선   ${mark(st.harness.claude.mcp)} MCP 등록`);
  say(`  codex         ${mark(st.harness.codex.installed)} 설치   ${mark(st.harness.codex.wired)} 배선`);
  if (st.kit.autoUpdate !== null) say(`  자동 업데이트 ${st.kit.autoUpdate ? green("켜짐") : yellow("꺼짐")}`);
  say("");
  if (!st.account.authenticated) say(dim("  → ") + bold("lively login") + dim(" 으로 시작하세요."));
  else if (st.kit.remote && !st.kit.current) say(dim("  → ") + bold("lively update") + dim(" 로 최신화할 수 있습니다."));
  else if (st.harness.claude.installed && !st.harness.claude.mcp) say(dim("  → MCP 등록이 안 돼 있습니다: ") + bold("lively update"));
}

async function cmdDoctor(opts) {
  const st = await gatherStatus();
  const checks = [];
  const chk = (name, pass, detail, fix) => checks.push({ name, pass, detail, fix: fix || null });

  chk("Node", true, `${process.version}`);
  chk("게이트웨이 설정", !!st.gateway.url, st.gateway.url || "~/.lively/gateway-url 없음", "lively login --gateway <url>");
  chk("게이트웨이 도달", st.gateway.reachable, st.gateway.reachable ? "OK" : (st.gateway.error || "실패"), "주소 · 네트워크 · VPN 확인");
  chk("토큰", !!token(), token() ? "~/.lively/token 있음" : "없음", "lively login");
  chk("토큰 유효", st.account.authenticated, st.account.authenticated ? (st.account.name || st.account.id || "인증됨") : "미인증", "lively login");
  chk("Claude Code", st.harness.claude.installed, st.harness.claude.installed ? "PATH 에 있음" : "미설치 또는 PATH 밖", "curl -fsSL https://claude.ai/install.sh | bash");
  chk("훅 파일", st.hooks.installed === st.hooks.expected, `${st.hooks.installed}/${st.hooks.expected} (~/.lively/hooks)`, "lively install");
  chk("Claude 훅 배선", st.harness.claude.wired, st.harness.claude.wired ? "settings.json OK" : "미배선", "lively install");
  if (st.harness.claude.installed) chk("Claude MCP 등록", st.harness.claude.mcp, st.harness.claude.mcp ? "lively 등록됨" : "미등록", "lively update");
  if (st.harness.codex.installed) chk("Codex 배선", st.harness.codex.wired, st.harness.codex.wired ? "config.toml OK" : "미배선", "lively install");
  if (st.kit.remote) chk("키트 최신", st.kit.current, st.kit.current ? String(st.kit.local) : `${st.kit.local || "(미설치)"} → ${st.kit.remote}`, "lively update");
  // 새 터미널에서 `lively` 가 잡히는지 — rc 배선이 안 됐으면 다음 창에서 못 찾는다.
  chk("lively PATH", has("lively"), has("lively") ? "OK" : "현 셸의 PATH 밖", "새 터미널을 열거나  source ~/.zshrc");

  if (opts.json) { process.stdout.write(JSON.stringify({ status: st, checks }, null, 2) + "\n"); return; }
  say(`\n${bold("라이블리 진단")}\n`);
  const w = Math.max(...checks.map((x) => cols(x.name)));
  for (const x of checks) {
    const pad = " ".repeat(Math.max(0, w - cols(x.name)));
    say(`  ${x.pass ? green("✓") : red("✗")} ${x.name}${pad}   ${x.pass ? dim(x.detail) : x.detail}`);
    if (!x.pass && x.fix) say(`    ${dim("→ 해결: ")}${bold(x.fix)}`);
  }
  const bad = checks.filter((x) => !x.pass);
  say("");
  if (!bad.length) say(green("  모두 정상입니다."));
  else { say(yellow(`  ${bad.length}건 문제 — 위 '해결' 을 순서대로 실행하세요.`)); process.exitCode = 1; }
}

// 프로젝트를 내 PC 에서 연다 — 종전 `node ~/.lively/work.mjs <id> …` 의 이름 있는 표면.
//  work.mjs 가 엔진(공유폴더 pull · 레포 clone/worktree · 하네스 실행) — CLI 는 인자를 **그대로** 넘긴다.
function cmdRun(rest) {
  const work = join(LIVELY, "work.mjs");
  if (!existsSync(work)) die("work.mjs 가 없습니다 — `lively install` 로 키트를 설치하세요.");
  if (!rest.length || !/^\d+$/.test(rest[0])) die("프로젝트 번호가 필요합니다.  예: lively run 864", 2);
  const child = spawn(process.execPath, [work, ...rest], { stdio: "inherit" });
  child.on("exit", (code, sig) => process.exit(sig ? 1 : (code ?? 0)));
}

// 부트스트랩(curl … | sh)이 곧장 부르는 대화형 첫 설치 — 로그인 + 설치를 한 흐름으로.
async function cmdSetup() {
  say(`\n${bold("라이블리 설치를 시작합니다.")}`);
  if (token() && gateway()) info("이미 로그인돼 있습니다 — 설치만 진행합니다.");
  else await cmdLogin({});
  await cmdInstall();
}

// ── 10. 인자 파싱 · 디스패치 ───────────────────────────────────────────────
const HELP = `${bold("lively")} — 라이블리 키트 명령

${bold("사용법")}
  lively <명령> [옵션]

${bold("시작하기")}
  setup                  로그인 + 설치를 한 번에 (처음 설치할 때)
  login                  접속 토큰 등록 (가림 입력 — 화면·히스토리에 안 남음)
  logout                 토큰만 지움 (설치는 유지)

${bold("설치 · 유지보수")}
  install                키트 설치 / 재설치 (멱등)
  update                 지금 최신으로 맞춤 ${dim("(MCP 재등록 포함 — 자동 업데이트가 못 하는 축)")}
      --check            확인만 하고 설치하지 않음
  uninstall              제거 ${dim("--dry-run  --purge  --yes  --harness claude|codex|all")}

${bold("확인")}
  status                 설치 · 버전 · 하네스 · MCP 상태  ${dim("--json")}
  doctor                 문제 진단 + 해결책               ${dim("--json")}

${bold("작업")}
  run <프로젝트번호>      프로젝트를 내 PC 에서 열기  ${dim("예: lively run 864")}
  delegate "<작업>"       무거운 작업을 워커/중앙에 위탁 — 진행을 미러하며 결과 출력 후 종료 ${dim('예: lively delegate "테스트 실행" --ram 2048')}
      --repo <이름> [--ref main]  대상 레포 자동 준비(공유 base→worktree, cwd 로)  ${dim("--ram/--cpu/--disk N  --docker  --node <id>  --timeout <초>")}
      --detach               번호만 반환하고 즉시 종료  ${dim("(나중에 lively delegate logs <번호>)")}
  delegate status|logs|cancel <번호> · delegate list
  node                   이 PC 를 노드로 연결 — 웹에서 로컬 터미널 관리/위탁 ${dim("(foreground, Ctrl-C 로 종료)")}
      --daemon               상시화(부팅·로그인마다 자동) ${dim("macOS launchd · Linux systemd --user")}   ·   node stop  데몬 해제

${bold("옵션")}
  --gateway <url>        게이트웨이 주소 지정 (login 과 함께)
  --token <토큰>         비대화형 로그인 (스크립트 · 프로비저닝용)
  -v, --version          버전
  -h, --help             이 도움말

${dim("업데이트는 보통 자동입니다 — 세션을 켜면 키트가 알아서 최신이 됩니다.")}
${dim("`lively update` 는 지금 당장 맞추거나, 관리자가 MCP 서버를 추가했을 때 씁니다.")}`;

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--gateway") o.gateway = argv[++i];
    else if (t === "--token") o.token = argv[++i];
    else if (t === "--harness") o.harness = argv[++i];
    else if (t === "--check") o.check = true;
    else if (t === "--json") o.json = true;
    else if (t === "--dry-run") o.dryRun = true;
    else if (t === "--purge") o.purge = true;
    else if (t === "--yes" || t === "-y") o.yes = true;
    else if (t === "-v" || t === "--version") o.version = true;
    else if (t === "-h" || t === "--help") o.help = true;
    else o._.push(t);
  }
  return o;
}

async function main() {
  const argv = process.argv.slice(2);
  const o = parse(argv);
  const cmd = o._[0] || (o.version ? "version" : o.help ? "help" : "status");

  switch (cmd) {
    case "setup": return cmdSetup();
    case "login": { await cmdLogin(o); return; }
    case "logout": return cmdLogout();
    case "install": { await cmdInstall(); return; }
    case "update": case "upgrade": return cmdUpdate(o);
    case "uninstall": case "remove": return cmdUninstall(o);
    case "status": return cmdStatus(o);
    case "doctor": return cmdDoctor(o);
    // run 은 나머지 인자를 **그대로** work.mjs 로 넘긴다(--harness 등이 CLI 옵션과 겹쳐도 원형 보존).
    case "run": return cmdRun(argv.slice(argv.indexOf("run") + 1));
    // delegate 도 나머지 인자 원형 보존(--ram 등 delegate 전용 옵션이 CLI 공통 파서에 안 먹히게).
    case "delegate": return cmdDelegate(argv.slice(argv.indexOf("delegate") + 1));
    // node — 이 PC 를 라이블리 노드로 연결(데몬 없이 foreground). 나머지 인자 원형 보존.
    case "node": return cmdNode(argv.slice(argv.indexOf("node") + 1));
    case "version": say(`lively ${CLI_VERSION}${readLively("kit-version") ? dim("  · 키트 " + readLively("kit-version")) : ""}`); return;
    case "help": say(HELP); return;
    default:
      say(red(`알 수 없는 명령: ${cmd}\n`));
      say(HELP);
      process.exit(2);
  }
}

// 직접 실행일 때만 동작 — 테스트가 export 를 import 해도 명령이 돌지 않게(user-install.mjs 와 같은 가드).
//  ⚠ 비교는 realpath 로 — /tmp 는 macOS 에서 /private/tmp 심링크라 URL 문자열 비교가 어긋난다(v0.1.131 회귀 실측).
const DIRECT_RUN = (() => {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || ""); }
  catch { return false; }   // 판정 불가 = import 로 본다(설치기와 달리 CLI 는 '조용히 아무것도 안 함'이 안전한 기본).
})();
if (DIRECT_RUN) main().catch((e) => die(e?.message || String(e)));

export { parse, detectHarnesses, verifyBundle, normGw, gatherStatus, registerClaudeMcp, backupUserMcp, winArg, REQUIRED_HOOKS, CLI_VERSION };
