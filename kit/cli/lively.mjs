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
import { join, relative, dirname } from "node:path";
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
// ⚠ **파일이 정본이고 LIVELY_TOKEN env 는 그 캐시다**(#916 — 순서를 뒤집지 말 것).
//  설치기가 codex 때문에(config.toml 은 토큰 리터럴을 거부하고 bearer_token_env_var 만 받는다) 셸 rc 에
//  `export LIVELY_TOKEN="$(cat ~/.lively/token)"` 를 심는다 → env 는 '셸 시작 시각의 파일 스냅샷'이지
//  의도적 override 가 아니다. env 를 우선하면 `lively login` 직후 **같은 셸**에서 옛 토큰이 살아남아
//  install 이 옛 신원을 .claude.json 에 굽는다(전 단계가 ✓ 로 보이면서 — 실측 재현됨).
//  새 셸에선 env==파일이라 이 순서는 무관하고, 파일이 없을 때만(CI·프로비저닝 컨테이너) env 로 폴백한다.
const token = () => (readLively("token") || process.env.LIVELY_TOKEN || "").trim();
// 이 프로세스가 **뜰 때** 셸이 준 토큰. 신원 판단엔 절대 쓰지 않는다(그건 token() 담당) — 오직
//  "당신 셸의 env 는 이제 스테일이고 우리는 그걸 못 고친다"를 login·logout·doctor 가 알릴 때만 쓴다.
const ENV_TOKEN_AT_START = (process.env.LIVELY_TOKEN || "").trim();

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
    if (res.status === 401 || res.status === 403) throw new Error("접속 열쇠가 유효하지 않습니다(만료·해제됨?) — `lively login` 으로 다시 등록하세요.");
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

// tmux 확보 — 있으면 절대경로, 없으면 **패키지 매니저로 자동 설치**(안내 말고 자동 — 사용자 요청). 그래도 없으면 die.
function ensureTmux() {
  const found = process.env.TMUX_BIN || resolveTmux();
  if (found) return found;
  say(dim("· tmux 가 없어 자동 설치를 시도합니다(웹터미널·위탁 세션 실행에 필요)…"));
  if (autoInstallTmux()) {
    const t = resolveTmux();
    if (t) { say(green(`✓ tmux 설치됨 — ${t}`)); return t; }
  }
  die(tmuxHelp(), 2);
}
// 플랫폼 패키지 매니저로 tmux 설치. 성공=true. macOS 는 brew, Linux 는 apt/dnf/yum/pacman/apk/zypper(비-root 면 sudo).
function autoInstallTmux() {
  const run = (argv) => { say(dim(`  $ ${argv.join(" ")}`)); try { return spawnSync(argv[0], argv.slice(1), { stdio: "inherit" }).status === 0; } catch { return false; } };
  if (process.platform === "darwin") return has("brew") ? run(["brew", "install", "tmux"]) : false;
  if (process.platform === "linux") {
    const root = typeof process.getuid === "function" && process.getuid() === 0;
    const sudo = root ? [] : (has("sudo") ? ["sudo"] : []);
    const spec = { "apt-get": ["install", "-y", "tmux"], dnf: ["install", "-y", "tmux"], yum: ["install", "-y", "tmux"], pacman: ["-S", "--noconfirm", "tmux"], apk: ["add", "tmux"], zypper: ["install", "-y", "tmux"] };
    const pm = Object.keys(spec).find(has);
    if (!pm) return false;
    return run([...sudo, pm, ...spec[pm]]);
  }
  return false;
}
function tmuxHelp() {
  if (process.platform === "darwin")
    return "tmux 가 필요한데 Homebrew 가 없어 자동 설치를 못 했습니다. Homebrew 설치 후 `lively node` 를 다시 실행하면 tmux 를 자동 설치합니다:\n" +
      '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
  if (process.platform === "linux")
    return "tmux 자동 설치 실패(패키지 매니저·권한 확인). 수동: sudo apt install -y tmux (또는 dnf/pacman/apk/zypper).";
  return "tmux 가 필요합니다 — 설치 후 다시 실행하세요.";
}

async function cmdNode(rest) {
  const sub = rest[0];
  if (sub === "stop") return nodeStop();
  const daemon = rest.includes("--daemon");
  const nodeId = (rest.includes("--id") ? rest[rest.indexOf("--id") + 1] : "") || slugHost();
  const gw = gateway(), tok = token();
  if (!gw || !tok) die("로그인이 필요합니다 — `lively login` 먼저.", 2);
  // tmux 필수 — 웹터미널·위탁 세션이 tmux 로 실행된다. 등록/설치 전에 확보한다(반쪽 상태 방지):
  //  있으면 그 절대경로, 없으면 패키지 매니저로 자동 설치 → 그래도 없으면 안내 후 종료. 절대경로라 데몬(최소 PATH)도 안전.
  const tmuxPath = ensureTmux();

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
  // 접속정보 env 파일(0600) — foreground 는 spawn env, 데몬은 이 파일을 읽는다.
  //  PATH: 데몬(launchd/systemd)은 사용자 로그인 셸을 안 거쳐 최소 PATH 다 → tmux 서버가 pane 안 harness(claude 등)를
  //   못 찾아 세션이 즉사한다(#869). `lively node` 는 사용자 대화형 셸에서 도니 지금 PATH 가 곧 사용자 PATH — 그걸 baked.
  //   (TMUX_BIN 절대경로는 tmux 자체 해석용, PATH 는 그 tmux 서버가 띄우는 pane 의 명령 해석용 — 둘 다 필요.)
  writeLively("node-agent.env",
    `LIVELY_GATEWAY_URL=${gw}\nLIVELY_NODE_TOKEN=${nodeTok}\nLIVELY_NODE_ID=${nodeId}\nTMUX_BIN=${tmuxPath}\nPATH=${process.env.PATH || ""}\n`, 0o600);

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
  // node-pty 네이티브(spawn-helper·*.node) 재서명(#869) — prebuilt 는 **linker-signed adhoc** 서명이라, 다른 맥으로
  //  복사되면 일부 macOS(Darwin 25.3+ 실측)에서 서명 검증 실패 → exec 시 segfault(=웹터미널 attach 불가·fd 폭주).
  //  로컬 머신용 adhoc 로 강제 재서명해 유효화한다(best-effort — codesign 없거나 실패해도 진행). 게이트웨이엔 무영향(노드 로컬만).
  if (process.platform === "darwin") {
    const nptyDir = join(NODE_AGENT_DIR, "node_modules", "node-pty", "prebuilds");
    for (const arch of ["darwin-arm64", "darwin-x64"]) {
      for (const bin of ["spawn-helper", "pty.node"]) {
        const p = join(nptyDir, arch, bin);
        if (existsSync(p)) { try { spawnSync("codesign", ["--force", "--sign", "-", p], { stdio: "ignore" }); } catch { /* codesign 없음 등 — 무시 */ } }
      }
    }
  }

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
    // linger 활성화(#869) — 이게 없으면 systemd --user 가 로그인 세션에 묶여 **세션 종료 시 데몬이 죽는다**(실측: SSH 닫힐
    //  때마다 정지). 상시화(부팅·로그아웃 후 유지)의 필수 조건. 자기 linger 는 polkit 로 sudo 없이 되기도, 안 되면 sudo 폴백.
    let linger = spawnSync("loginctl", ["enable-linger"], { stdio: "ignore" }).status === 0;
    if (!linger) linger = spawnSync("sudo", ["-n", "loginctl", "enable-linger", process.env.USER || ""], { stdio: "ignore" }).status === 0;
    say(green(`✅ 노드 '${nodeId}' 상시화(systemd --user${linger ? " + linger" : ""})`));
    if (!linger) say(yellow("   ⚠ linger 활성화 실패 — 로그아웃 후 데몬이 멈출 수 있습니다. 수동: sudo loginctl enable-linger $USER"));
    say(dim("   중지: lively node stop"));
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
// claude 가 `--scope user` MCP 를 쓰는 파일 — **CLAUDE_CONFIG_DIR 가 있으면 그 밑**, 없으면 $HOME/.claude.json.
//  self-update.mjs 의 claudeUserConfigPath 와 **같은 판정**이어야 한다(둘이 갈리면 백업/복원이 어긋난다).
//  ⚠ 예전엔 $HOME 고정이었다("claude 는 $HOME/.claude.json 에 쓴다"는 주석까지 달고). 사실이 아니다 —
//   프로필 격리(#346)에선 claude 가 CLAUDE_CONFIG_DIR 쪽을 쓴다(deploy/provision-profile.sh:37 이 명시).
//   그래서 backupUserMcp 가 **유저 원본을 못 보고 null 로 굳어**, uninstall 이 "설치 전 없었음"으로 판단해
//   유저의 linear/notion 을 자격증명째 지웠다 — 백업이 막으려던 #744 갭 그 자체.
function claudeUserConfigPath() {
  const cands = [];
  if (process.env.CLAUDE_CONFIG_DIR) cands.push(join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"));
  cands.push(join(HOME, ".claude.json"));
  for (const c of cands) { try { if (existsSync(c)) return c; } catch { /* */ } }
  return null;
}
function claudeUserMcp(name) {
  const p = claudeUserConfigPath();
  if (!p) return null;   // 파일 자체가 없다 = 설치 전 유저 항목도 없었다
  try { return JSON.parse(readFileSync(p, "utf8"))?.mcpServers?.[name] ?? null; }
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

// lively 본체 등록 — **토큰을 담은 유일한 MCP 항목**이라 로그인(신원 교체)도 이것만 다시 굽는다.
//  remove 후 add(재실행 안전). remove 실패는 정상(미등록 상태). 호출 전에 has("claude") 를 확인할 것.
//  ⚠ 위치는 claude 가 정한다(--scope user → CLAUDE_CONFIG_DIR 존중, deploy/provision-profile.sh:37) —
//   .claude.json 을 우리가 직접 읽어 판단하지 않는다(프로필 격리 #346 에서 엉뚱한 파일을 보게 된다).
//  ⚠ **헤더는 반드시 register-clients.sh 와 같은 세트**(그쪽이 번들 캐노니컬). x-lively-session(#852)을 빠뜨리면
//   remove→add 가 **기존 세션 헤더를 지워** 그 세션의 작업 귀속이 끊긴다 — 프로비저닝된 멤버(provision-member.sh:122)가
//   재로그인·재설치할 때 실제로 발생한다. 값은 **리터럴로** 넘긴다: 확장은 접속 시 하네스가 제 env 로 한다.
//   `:-` 기본값이 없으면 세션 밖(랩탑)에서 "Missing environment variables" 경고가 뜬다(register-clients.sh 실측).
//   x-lively-readonly(#1007): 세션을 LIVELY_READONLY=1 로 실행하면 그 세션만 읽기전용(게이트웨이가 쓰기 툴 소거). 미설정=빈 값=정상.
function registerLivelyMcp(gw, tok) {
  run("claude", ["mcp", "remove", "lively"], { allowFail: true, quiet: true });
  try {
    run("claude", ["mcp", "add", "--transport", "http", "--scope", "user", "lively", `${gw}/mcp`,
      "--header", `Authorization: Bearer ${tok}`,
      "--header", "x-lively-session: ${LIVELY_SESSION_ID:-}",
      "--header", "x-lively-readonly: ${LIVELY_READONLY:-}",
      "--header", "x-lively-incognito: ${LIVELY_INCOGNITO:-}"], { quiet: true });
    ok(`MCP 등록: lively → ${gw}/mcp`);
    return true;
  } catch (e) { fail(`MCP 등록 실패(lively): ${e.message}`); return false; }
}

function registerClaudeMcp() {
  const gw = gateway(), tok = token();
  if (!has("claude")) { info("claude 미설치 — MCP 등록 건너뜀"); return { registered: 0, failed: 0 }; }
  let registered = 0, failed = 0;
  if (registerLivelyMcp(gw, tok)) registered++; else failed++;

  // lively-local — 로컬 조작 stdio MCP(#899). 같은 CLI 가 서버(`lively mcp-local`).
  //  코드 자동 업뎃(#858)에 무임승차: command(심 절대경로)만 등록하고 서버 코드는 lib/lively-mcp-local.mjs 로
  //  매 세션 최신 → 코드가 바뀌어도 재등록 불필요(툴 목록 자체를 바꿀 때만 여기 add 가 다시 태운다).
  run("claude", ["mcp", "remove", "lively-local"], { allowFail: true, quiet: true });
  try {
    const shim = join(LIVELY, "bin", WIN ? "lively.cmd" : "lively");
    run("claude", ["mcp", "add", "--transport", "stdio", "--scope", "user", "lively-local", shim, "mcp-local"], { quiet: true });
    ok("MCP 등록: lively-local (stdio · 로컬조작)");
    registered++;
  } catch (e) { fail(`MCP 등록 실패(lively-local): ${e.message}`); failed++; }

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
    //  ⚠ LIVELY_TOKEN 을 **명시 주입**한다: user-install.mjs 의 org-seed fetch 는 아직 env 우선이라(그쪽:539),
    //   안 주면 이 셸의 스테일 env 로 시드를 받아 **번들은 새 신원·시드는 옛 신원**으로 갈린다(#916 계열).
    //   token() 이 정본(파일)을 이미 풀었으니 그 값을 그대로 물려준다 — process.env 전역을 덮지 않는 이유는 afterLogin 주석 참조.
    run(process.execPath, [join(root, "setup", "user-install.mjs"), "--clone-root", root, "--harness", harnesses.join(",")],
      { env: { LIVELY_TOKEN: token() } });

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
  const me = await validateAndStore(gw, tok);
  afterLogin(gw, tok);
  return me;
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

// 로그인 탈출구(디바이스 흐름 건너뜀) 판정 — **순수함수라 TTY 없이 직접 검증한다**(winArg 와 같은 이유:
//  아래 분기는 제어단말이 있어야 밟히는데 e2e 하네스엔 없다). 분기표:
//    --token 있음                 → 그 토큰. 문서화된 CI 경로(web/learn.ts) 이자 테스트가 쓰는 경로.
//    파일 없음 + env 있음         → env. 이 박스는 로그인한 적 없다 = env 가 유일한 자격(CI·프로비저닝 컨테이너).
//    비대화형 + env 있음          → env. 열 브라우저가 없다(탈출구의 본래 의도이자 기존 안내문구의 약속).
//    파일 있음 + 대화형           → "" (탈출구 없음 → 브라우저 흐름).
//  ⚠ **파일이 있는 대화형 셸에서 env 를 탈출구로 쓰면 안 된다**(#916): 설치기가 codex 용으로 rc 에
//   `export LIVELY_TOKEN="$(cat ~/.lively/token)"` 를 심으므로 키트를 깐 사람의 셸엔 **항상** 있다
//   → 옛 코드는 100% 이 탈출구로 빠져 브라우저를 안 열고 옛 토큰을 재검증·재저장만 하면서
//   "✓ 인증됐습니다"를 찍었다(= 재로그인으로 권한을 바꾸는 게 구조적으로 불가능했다).
//   판별자로 **파일 존재**를 함께 보는 이유: 그 rc 수화는 파일이 있어야만 일어나므로 '파일 있음+사람'이
//   정확히 #916 의 조건이고, TTY 만으로 가르면 pty 를 붙인 프로비저닝 컨테이너(docker run -t)를 깬다.
const loginEscapeToken = ({ flagToken = "", envToken = "", fileToken = "", isInteractive }) => {
  if (flagToken) return String(flagToken).trim();
  if (!fileToken || !isInteractive) return String(envToken || "").trim();
  return "";
};

// 로그인 성공 뒤 마무리 — 신원의 **사본**을 새 토큰에 맞춘다(login 이 install 을 대신하진 않는다).
//  ⚠ 여기서 `process.env.LIVELY_TOKEN` 을 덮지 **않는다**: 그러면 뒤이어 도는 registerClaudeMcp 의
//   org 서버 루프가 `process.env[s.auth_env]` 로 그 값을 집어, 관리자가 지정한 임의 URL 의 Authorization
//   헤더로 **멤버 개인 게이트웨이 토큰**을 구울 수 있다(auth_env 는 org MCP 서버 경로에서 화이트리스트
//   강제가 없다 — allowed_auth_envs 는 org_tool 전용, dynamic-tools.ts:115). 필요 없기도 하다: token() 이
//   파일 우선이고 로그인이 방금 파일을 썼으므로 같은 프로세스의 후속 호출은 이미 새 토큰을 본다.
function afterLogin(gw, tok) {
  // .claude.json 의 lively 항목은 **토큰의 사본**이고 방금 로그인이 그걸 무효화했다 → 여기서 다시 굽는다.
  //  없으면: 사용자가 로그인만 하고 멈췄을 때(bootstrap.sh·웹 안내가 그렇게 시킨다) MCP 는 옛 신원으로 남는다.
  if (has("claude")) registerLivelyMcp(gw, tok);
  else info("claude 미설치 — MCP 등록 건너뜀");
  // codex 는 토큰을 config.toml 에 안 굽고 LIVELY_TOKEN 을 읽으므로(bearer_token_env_var) 재등록할 게 없다.
  //  대신 **이 셸의 env 는 우리가 못 고친다**(자식이 부모 셸을 못 바꾼다) → 조용히 두지 말고 사실대로 알린다.
  if (ENV_TOKEN_AT_START && ENV_TOKEN_AT_START !== tok) {
    warn("이 셸의 LIVELY_TOKEN 은 아직 이전 토큰입니다 — 새 터미널을 열거나 `source ~/.zshrc` 후 codex 를 쓰세요.");
  }
}

async function cmdLogin(opts) {
  if (opts.gateway) writeLively("gateway-url", normGw(opts.gateway));
  const gw = gateway();
  if (!gw) die("게이트웨이 주소가 없습니다 — `lively login --gateway https://<주소>` 로 지정하세요.");
  const isInteractive = interactive();

  // ① 탈출구(CI·프로비저닝) — 판정은 loginEscapeToken 의 분기표 참조.
  const escape = loginEscapeToken({
    flagToken: opts.token, envToken: process.env.LIVELY_TOKEN, fileToken: readLively("token"), isInteractive,
  });
  if (escape) { const me = await validateAndStore(gw, escape); afterLogin(gw, escape); return me; }

  // ② 비대화형(TTY 없음)인데 토큰도 없음 → 명확 안내.
  if (!isInteractive) die("비대화형 환경입니다 — `lively login --token <토큰>` 또는 LIVELY_TOKEN 환경변수를 쓰세요.");

  // ③ 대화형인데 env 토큰이 파일과 다르다 = 사람이 일부러 넣었을 수 있다 → 무시한다는 걸 알린다(조용히 버리지 않는다).
  //   같으면(= rc 수화, 키트 사용자의 정상 상태) 할 말이 없으니 침묵한다.
  if (ENV_TOKEN_AT_START && ENV_TOKEN_AT_START !== readLively("token")) {
    info('환경변수 LIVELY_TOKEN 은 쓰지 않고 브라우저 로그인으로 진행합니다 — 그 토큰을 쓰려면 `lively login --token "$LIVELY_TOKEN"`.');
  }

  // ④ 기본: 브라우저 디바이스 흐름. 서버가 모르면(구 서버·롤백) 토큰 가림입력으로 폴백.
  const dev = await deviceLogin(gw);
  if (dev === "unsupported") {
    info("이 게이트웨이는 브라우저 로그인을 아직 지원하지 않습니다 — 토큰 입력으로 진행합니다.");
    return loginWithPastedToken(gw);
  }
  // ⑤ 저장 전 신원 확인(역방향 피싱 방어, R2-F1) — 불변 email 로. 확인 통과 후에만 저장.
  const me = await validateAndStore(gw, dev.token, { store: false });
  const who = me?.email || me?.id || "구성원";
  say("");
  const yes = await askYesNo(`  ${bold(who)} 로 로그인됩니다. 계속할까요?`, true);
  if (!yes) die("이 로그인은 당신이 시작한 게 아닐 수 있습니다 — 저장을 취소했습니다.", 1);
  writeLively("token", dev.token);
  writeLively("gateway-url", gw);
  ok(`${bold(who)} 님으로 로그인됐습니다. (토큰 저장: ~/.lively/token)`);
  afterLogin(gw, dev.token);
  return me;
}

function cmdLogout() {
  const p = join(LIVELY, "token");
  if (!existsSync(p)) { info("이미 로그아웃 상태입니다(저장된 토큰 없음)."); return; }
  rmSync(p, { force: true });
  ok("토큰을 지웠습니다 (~/.lively/token).");
  // 파일만 지울 수 있다 — 이 셸의 env 는 자식이 못 고친다. 남아 있으면 token() 이 env 로 폴백해
  //  `lively status` 가 계속 '인증됨' 을 보인다 → 조용히 두지 말고 사실대로 말한다(#916 계열).
  if (ENV_TOKEN_AT_START) warn("이 셸의 LIVELY_TOKEN 은 아직 남아 있습니다 — 새 터미널을 열거나 `unset LIVELY_TOKEN` 하세요.");
  info("설치 파일은 그대로입니다 — 완전 제거는 `lively uninstall`.");
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

// ── 프로젝트 섹션(#905 C5a) — cwd 가 프로젝트일 때만 붙는다(아니면 null → 렌더 자체가 없음). ──
//  왜 `lively status` 안인가: `status` 는 인자 없는 `lively` 의 **기본 명령**이라 사람이 실제로 치는 유일한 표면이다.
//   별도 하위명령을 만들면 아무도 안 친다 — `work.mjs --status`(같은 내용)가 호출자 0인 게 그 증거다.
//  ⚠ 이 섹션의 진짜 값어치 = **sync 모드를 사람 눈에 보이게 하는 것**(#905 P1-②). 마커의 sync 는 "이 폴더에
//   서버 공유파일을 써도 되는가"를 정하는데, 지금까지 그걸 볼 수 있는 표면이 **어디에도 없었다**. 안 보이는 게이트는
//   틀렸을 때 아무도 모른다.
async function gatherProjectStatus(cwd) {
  const { findProjectMarkerUp, markerSyncMode } = await import(new URL("./repo-worktree-core.mjs", import.meta.url));
  const found = findProjectMarkerUp(cwd);
  if (!found) return null;
  const p = {
    id: found.meta.project_id,
    name: null,
    dir: found.dir,
    sync: markerSyncMode(found.meta),           // null = 구 마커(훅이 폴더 소유권으로 판정)
    last_pull: Number(found.meta.last_pull) || 0,
    shared: null,                                // {server_newest, server_count, pending, truncated} — 조회 실패 시 null
    error: null,
  };
  try { p.name = (await api(`/api/ui/v6/projects/${p.id}`, { timeoutMs: 8000 }))?.project?.name ?? null; }
  catch (e) { p.error = e.message; }
  // 공유폴더 상태 — sync 가 none 이면 애초에 안 받으므로 조회하지 않는다(불필요한 왕복 + 오해 소지).
  if (p.sync !== "none") {
    try {
      const m = await api(`/api/ui/v6/projects/${p.id}/shared/manifest`, { timeoutMs: 8000 });
      const files = Array.isArray(m.files) ? m.files : [];
      let pending = 0;
      for (const f of files) {
        const dest = join(p.dir, f.path);
        if (relative(p.dir, dest).startsWith("..")) continue;   // 경로 탈출 방어(work.mjs 동형)
        try { const s = statSync(dest); if (s.size === f.size && Math.floor(s.mtimeMs) >= f.mtime) continue; } catch { /* 로컬 없음 → pending */ }
        pending++;
      }
      p.shared = { server_newest: m.newest || 0, server_count: typeof m.count === "number" ? m.count : files.length, pending, truncated: !!m.truncated };
    } catch (e) { p.error = p.error || e.message; }
  }
  // up-sync 결과(#905 C3) — 자동 up 은 확인할 사람이 없어(수동 업로드의 #877 confirm 과 다름) **기록이 유일한 표면**이다.
  //  충돌이 조용히 쌓이면 "왜 내 변경이 안 올라갔지"를 아무도 모른다. host-local(dotfile — 동기화 안 됨).
  try { p.up = JSON.parse(readFileSync(join(p.dir, ".lively", "sync-up.json"), "utf8")); } catch { p.up = null; }
  return p;
}

function renderProjectStatus(p) {
  const iso = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : dim("없음"));
  say(`  프로젝트      ${bold("#" + p.id)}${p.name ? " " + p.name : dim(" (이름 조회 실패)")}`);
  say(`    폴더        ${p.dir}`);
  if (p.sync === "none") {
    // 사용자 자기 폴더의 기본값 — '안 받는 게 정상'임을 분명히 한다(고장으로 오해하지 않게).
    say(`    공유폴더    ${dim("동기화 안 함")} ${dim("(sync=none — 이 폴더엔 서버 파일을 내려받지 않습니다)")}`);
    say(`                ${dim("받으려면 " + p.dir + "/.lively/project.json 의 sync 를 \"pull\" 로.")}`);
  } else if (!p.shared) {
    say(`    공유폴더    ${yellow("상태 조회 실패")} ${dim(p.error || "")}`);
  } else {
    // ⚠ sync 가 없는 구 마커는 **모드를 단정하지 않는다.** 그때 pull 훅은 폴더 위치로 fail-safe 판정하는데
    //  (라이블리가 만든 폴더면 pull, 그 밖은 none), 그 판정을 여기서 흉내내면 예측이 어긋나는 순간 이 화면이
    //  거짓말을 한다 — 게이트를 보여주려고 만든 표면이 게이트를 오도하는 건 최악이다. 모르면 모른다고 쓴다.
    const known = p.sync !== null;
    say(`    공유폴더    ${known ? p.sync : yellow("미명시(구 마커)")} · 서버 ${p.shared.server_count}개 파일 · 마지막 pull ${iso(p.last_pull)}`
      + (p.shared.truncated ? "  " + yellow("⚠ 서버 목록 상한 도달(일부 누락 가능)") : ""));
    if (!known) {
      say(`                ${dim("이 폴더가 받을지는 pull 훅이 폴더 위치로 판정합니다(라이블리가 만든 폴더면 받고, 그 밖은 안 받음).")}`);
      say(`                ${dim("확실히 하려면 .lively/project.json 에 sync 를 \"pull\" 또는 \"none\" 으로 명시하세요.")}`);
    }
    const willPull = known && (p.sync === "pull" || p.sync === "both");
    say(`    로컬 미반영  ${p.shared.pending
      ? yellow(`${p.shared.pending} 파일`) + (willPull ? dim("  → 세션을 새로 시작하면 자동으로 받습니다") : "")
      : green("없음(최신)")}`);
  }
  // ↑up(sync=both) 결과 — 특히 **충돌은 반드시 보인다**(자동 up 은 물어볼 사람이 없어 여기가 유일한 표면).
  if (p.up) {
    const c = (p.up.conflicts || []).length;
    // 삭제는 되돌리기 어려우니(중앙 공유문서가 사라진다) 0건이 아니면 **항상 보인다** — 올린 개수 뒤에 묻히면 안 된다.
    say(`    올린 변경    ${p.up.pushed || 0}개${p.up.deleted ? yellow(` · 서버에서 삭제 ${p.up.deleted}개`) : ""}`
      + `${p.up.remaining ? dim(` · ${p.up.remaining}개 다음 턴으로`) : ""}`
      + `${p.up.failed ? yellow(` · 실패 ${p.up.failed}(다음 턴 재시도)`) : ""}`
      + (c ? "  " + red(`⚠ 충돌 ${c}개 — 안 올림`) : ""));
    for (const x of (p.up.conflicts || []).slice(0, 5)) {
      say(`      ${red("✗")} ${x.path} ${dim("— " + x.why)}`);
    }
    // 충돌은 **사람만 풀 수 있다**(양쪽 다 바뀌어서 안 올린 것이다). 그래서 여기서 '되는 절차'를 준다.
    //  ⚠ 실행할 수 없는 지시를 쓰면 안 된다 — 강제 pull 명령 같은 건 없다. 실제로 동작하는 건 이 순서다:
    //   내 파일 이름을 바꾸면 ① 원래 경로가 비므로 다음 pull 이 서버본을 내려주고 ② 바뀐 이름은 새 문서라 올라간다
    //   → 두 본을 나란히 놓고 합친 뒤, 사본을 지우면 그 삭제가 서버에도 전파된다.
    if (c) {
      say(`                ${dim("충돌은 양쪽 다 바뀐 것 — 자동으로 못 합칩니다. 로컬본을 덮으면 남의 작업이 사라집니다.")}`);
      say(`                ${dim("푸는 법: `mv <파일> <파일>.mine` → 다음 턴에 서버본이 내려옵니다 → 합친 뒤 .mine 삭제.")}`);
    }
  }
}

async function cmdStatus(opts) {
  const st = await gatherStatus();
  st.project = await gatherProjectStatus(process.cwd()).catch(() => null); // 프로젝트 섹션은 부가 — 실패해도 status 는 유효
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
  if (st.project) { say(""); renderProjectStatus(st.project); }
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
  // 토큰의 **출처**를 사실대로 말한다 — 옛 코드는 출처와 무관하게 "~/.lively/token 있음"을 찍어서,
  //  파일이 없는데(로그아웃 직후 등) env 폴백으로 인증되는 상태를 "파일 있음"으로 거짓 보고했다.
  const tokFile = readLively("token");
  chk("토큰", !!token(), tokFile ? "~/.lively/token" : (token() ? "LIVELY_TOKEN 환경변수 (파일 없음)" : "없음"), "lively login");
  chk("토큰 유효", st.account.authenticated, st.account.authenticated ? (st.account.name || st.account.id || "인증됨") : "미인증", "lively login");
  // #916 — 이 셸의 env 가 파일과 다르면 **codex 와 이미 떠 있는 세션은 옛 신원으로** 게이트웨이에 붙는다.
  //  CLI 는 파일을 정본으로 쓰므로 위 두 줄은 멀쩡해 보이는데, 그 상태가 정확히 #916 이었다.
  //  진단이 이걸 안 보여줘서 그때는 /api/ui/me 를 손으로 찔러보고서야 잡혔다 → 도구화한다. ⚠ 값은 안 찍는다(사실만).
  if (ENV_TOKEN_AT_START && tokFile) {
    const same = ENV_TOKEN_AT_START === tokFile;
    chk("신원 일치(이 셸 env ↔ 파일)", same,
      same ? "일치" : "이 셸의 LIVELY_TOKEN 이 ~/.lively/token 과 다릅니다 — codex 는 옛 신원으로 붙습니다",
      "새 터미널을 열거나  source ~/.zshrc");
  }
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

// ── 실행 모드(#1007+) — 이 세션이 라이블리와 얼마나 상호작용하나. CLI 가 모드 이름을 env 플래그로 번역한다. ──
//  normal   : 주입 ○ / 쓰기 ○ (기본)
//  readonly : 주입 ○ / 쓰기 ✗ (게이트웨이가 x-lively-readonly 헤더로 쓰기 툴 소거 · REST 403)
//  incognito: 주입 ✗ / 읽기 ✗ / 쓰기 ✗ (게이트웨이가 x-lively-incognito 로 lively 툴 0개+전체 차단 = 사실상 연결없음) + 훅 off
const MODES = ["normal", "readonly", "incognito"];
const MODE_FILE = "mode";
// 디폴트 모드(~/.lively/mode) — 유효하지 않거나 없으면 normal.
function defaultMode() { const m = readLively(MODE_FILE); return MODES.includes(m) ? m : "normal"; }
// rest 에서 모드 플래그(--mode M / --readonly / --incognito / --normal)를 뽑고 나머지를 돌려준다. 플래그 없으면 디폴트, 여러 개면 마지막이 이긴다.
function extractMode(rest) {
  let mode = null; const out = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--mode") { const v = rest[++i]; if (!MODES.includes(v)) die(`--mode 는 ${MODES.join("|")} 중 하나여야 합니다.`, 2); mode = v; }
    else if (a === "--readonly" || a === "--read-only") mode = "readonly";
    else if (a === "--incognito") mode = "incognito";
    else if (a === "--normal") mode = "normal";
    else out.push(a);
  }
  return { mode: mode ?? defaultMode(), rest: out };
}
// 모드 → 세션 env(하네스가 상속 → MCP 헤더가 이 env 를 확장 → 게이트웨이 강제). incognito 는 훅도 끈다(주입·넛지 off).
function modeEnv(mode) {
  if (mode === "readonly") return { LIVELY_READONLY: "1" };
  if (mode === "incognito") return { LIVELY_INCOGNITO: "1", LIVELY_OFF: "1" };
  return {};
}

// `lively run [--mode M | --readonly | --incognito] [<프로젝트#> [work.mjs 인자…] | [--harness claude|codex] [하네스 인자…]]`
//  · 프로젝트# 있으면 work.mjs(공유폴더 pull · 레포 clone/worktree · 하네스 실행) — 종전 표면.
//  · 없으면 하네스를 **바로** 실행한다(프로젝트 없이 — 사용자 요청). 기본 claude, --harness 로 변경.
//  두 경로 모두 모드 env 를 세팅 → 그 세션만 읽기전용/인코그니토가 헤더로 게이트웨이에 전달된다(per-session).
function cmdRun(rest0) {
  const { mode, rest } = extractMode(rest0);
  const env = { ...process.env, ...modeEnv(mode) };
  const badge = mode === "normal" ? "" : dim(` [${mode}]`);
  const onExit = (child) => child.on("exit", (code, sig) => process.exit(sig ? 1 : (code ?? 0)));
  // 프로젝트# → work.mjs (종전 동작 보존, 모드 env 만 추가)
  if (rest.length && /^\d+$/.test(rest[0])) {
    const work = join(LIVELY, "work.mjs");
    if (!existsSync(work)) die("work.mjs 가 없습니다 — `lively install` 로 키트를 설치하세요.");
    say(dim(`프로젝트 #${rest[0]} 열기`) + badge);
    onExit(spawn(process.execPath, [work, ...rest], { stdio: "inherit", env }));
    return;
  }
  // 프로젝트# 없음 → 하네스 직접 실행. --harness <name> 로 선택(기본 claude), 나머지는 하네스에 그대로 넘긴다.
  let harness = "claude"; const args = [];
  for (let i = 0; i < rest.length; i++) { if (rest[i] === "--harness") harness = rest[++i] || harness; else args.push(rest[i]); }
  if (!has(harness)) die(`${harness} 이(가) 설치돼 있지 않습니다.`, 2);
  say(dim(`${harness} 실행`) + badge);
  onExit(spawn(harness, args, { stdio: "inherit", env, ...(WIN ? { shell: true } : {}) })); // WIN: .cmd 셰임이라 shell 필요(work.mjs:259 동형)
}

// `lively mode [normal|readonly|incognito]` — 디폴트 실행 모드 조회/설정(~/.lively/mode). lively run 이 --mode 없을 때 이걸 읽는다.
function cmdMode(rest) {
  const m = rest[0];
  if (!m) {
    const cur = defaultMode();
    say(`디폴트 실행 모드: ${bold(cur)}`);
    say(dim(`  변경: lively mode <${MODES.join("|")}>   ·   일회성: lively run --readonly  /  --incognito  /  --normal`));
    return;
  }
  if (!MODES.includes(m)) die(`모드는 ${MODES.join("|")} 중 하나여야 합니다.`, 2);
  mkdirSync(LIVELY, { recursive: true });
  writeFileSync(join(LIVELY, MODE_FILE), m + "\n", { mode: 0o600 });
  const hint = m === "incognito" ? "  (주입·읽기·쓰기 모두 off — 클린룸)" : m === "readonly" ? "  (읽기 O · 쓰기 X)" : "  (주입·읽기·쓰기 모두 on)";
  say(green(`디폴트 실행 모드 → ${bold(m)}`) + dim(hint));
}

// `lively mcp-local` — 로컬 조작 stdio MCP 서버를 이 프로세스에서 실행(하네스가 매 세션 spawn, 사람이 직접 칠 일 없음).
//  서버 본체·툴 레지스트리는 lib/lively-mcp-local.mjs 에 있다 — 새 로컬 툴은 거기 TOOLS 배열에 추가한다(여긴 위임만).
async function cmdMcpLocal() {
  const { serveMcpLocal } = await import(new URL("./lively-mcp-local.mjs", import.meta.url));
  await serveMcpLocal();
}

// `lively init` — 이 폴더를 라이블리 프로젝트로(사람 표면). MCP 툴 lively_local_project_init 과 **같은 코어**를 쓴다
//  (project-init-core.mjs — 드리프트 0). D8: 사람이 촉발해야 자연스러운 것은 사람 표면으로.
//  기본은 **제안만**(무변경) — 사람이 보고 --create / --bind <id> 로 확정한다. '알아서 만들기'를 기본으로 두지 않는 이유:
//  마커는 동기화되지 않아 다른 멤버가 이미 만든 프로젝트를 못 보는 게 정상이라, 자동 create 는 중복을 양산한다.
async function cmdInit(rest) {
  const { projectInit } = await import(new URL("./project-init-core.mjs", import.meta.url));
  const ctx = {
    cwd: process.cwd(),
    sh: (cmd2, args, opts = {}) => { const r = run(cmd2, args, { quiet: true, allowFail: true, env: opts.env }); return { stdout: r.out, stderr: r.err, code: r.code }; },
    api: (p2, opts) => api(p2, opts),
  };
  const a = { mode: "auto" };
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--create") a.mode = "create";
    else if (t === "--bind") { a.mode = "bind"; a.project_id = Number(rest[++i]); }
    else if (t === "--name") a.name = rest[++i];
    else if (t === "--path") a.path = rest[++i];
    else if (t === "--list") a.list_id = Number(rest[++i]);
    else if (t === "--json") a.json = true;
  }
  let r;
  try { r = await projectInit(ctx, a); }
  catch (e) { die(e.message, 1); }
  if (a.json) { process.stdout.write(JSON.stringify(r, null, 2) + "\n"); return; }

  if (r.status === "already_project") { say(`\n${yellow("이미 프로젝트입니다")} — #${r.project_id}\n  ${dim(r.note)}\n`); return; }
  if (r.status === "suggestion") {
    say(`\n${bold("프로젝트 연결 제안")} ${dim(r.dir)}\n`);
    say(`  git origin    ${r.git_url || dim("(없음 — git 레포가 아니거나 origin 미설정)")}`);
    if (r.active_total) say(`  기존 후보     진행 중 ${r.active_total}개${r.truncated ? dim(` (아래는 최근 ${r.candidates.length}개만)`) : ""}`);
    for (const c of (r.candidates || []).filter((c) => c.status !== "done").slice(0, 5)) say(`    ${dim("#" + c.project_id)} ${c.name} ${dim("(" + c.status + ")")}`);
    say("");
    if (r.suggestion.action === "bind") {
      say(`  ${green("→ 붙이기를 권합니다")}: ${bold("lively init --bind " + r.suggestion.project_id)}`);
      say(`     ${dim(r.suggestion.why)}`);
    } else {
      say(`  ${yellow("→ 판단이 필요합니다")}`);
      say(`     ${dim(r.suggestion.why)}`);
      say(`     새로: ${bold("lively init --create --name \"<이름>\"")}   ·   기존에: ${bold("lively init --bind <id>")}`);
    }
    say("");
    return;
  }
  // created | bound
  say(`\n${green("✓")} ${r.status === "created" ? "새 프로젝트 생성" : "기존 프로젝트에 연결"} — ${bold("#" + r.project_id)} ${r.name}`);
  say(`  폴더        ${r.dir}`);
  say(`  공유폴더    ${r.sync} ${dim("(사용자 폴더라 서버 파일을 내려받지 않습니다 — 당신 파일을 덮어쓰지 않기 위함)")}`);
  if (r.binding_error) say(`  ${yellow("⚠ 중앙 폴더 인벤토리 등록 실패")} ${dim(r.binding_error)} ${dim("— 로컬 연결은 정상입니다")}`);
  say(`\n  ${dim("다음 세션부터 이 폴더에서 프로젝트 맥락이 뜹니다. 상태: ")}${bold("lively status")}\n`);
}

// `lively repo` — 워크트리 셀프서비스 CLI(사람·스크립트용). MCP 툴 lively_local_repo_* 과 **같은 코어**를 쓴다
//  (repo-worktree-core.mjs — 드리프트 0). ctx 계약: sh → {stdout,stderr,code}(run 의 out/err 매핑) · api → JSON · cwd.
async function cmdRepo(rest) {
  const { repoList, repoWorktree, repoWorktreeRemove, repoPin, repoPinRemove } = await import(new URL("./repo-worktree-core.mjs", import.meta.url));
  const ctx = {
    cwd: process.cwd(),
    sh: (cmd, args, opts = {}) => { const r = run(cmd, args, { quiet: true, allowFail: true, env: opts.env }); return { stdout: r.out, stderr: r.err, code: r.code }; },
    api: (p) => api(p),
  };
  const sub = String(rest[0] || "").toLowerCase();
  const o = {}; const pos = [];
  for (let i = 1; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--branch") o.branch = rest[++i];
    else if (t === "--ref") o.ref = rest[++i];
    else if (t === "--path") o.path = rest[++i];
    else if (t === "--force") o.force = true;
    else pos.push(t);
  }
  try {
    if (!sub || sub === "list" || sub === "ls") {
      const res = await repoList(ctx);
      say(bold(`레포 ${res.count}개`) + dim(`  · base dir: ${res.repos_dir}`));
      for (const r of res.repos) {
        const dot = r.cloned ? green("●") : dim("○");
        const meta = r.cloned ? (r.status || `${r.branch || "?"}@${r.head || "?"}`) : "미클론";
        say(`  ${dot} ${r.name}  ${dim(meta)}`);
      }
      if (!res.repos.length) info("등록된 레포가 없습니다 — 관리탭 ▸ 레포에서 git 주소를 연결하세요.");
      return;
    }
    if (sub === "worktree" || sub === "wt") {
      const op = String(pos[0] || "").toLowerCase();
      if (op === "remove" || op === "rm") {
        const res = repoWorktreeRemove(ctx, { repo: pos[1], path: o.path, force: o.force });
        ok(`워크트리 제거: ${res.removed}`); return;
      }
      const repo = pos[0];
      if (!repo) die("레포 이름이 필요합니다.  예: lively repo worktree <repo> [--branch b] [--ref main] [--path .]");
      const res = await repoWorktree(ctx, { repo, branch: o.branch, ref: o.ref, path: o.path });
      ok(`워크트리: ${bold(res.worktree)}  ${dim(`(브랜치 ${res.branch})`)}`);
      say("  " + dim(res.note));
      return;
    }
    if (sub === "pin") {
      const op = String(pos[0] || "").toLowerCase();
      if (op === "remove" || op === "rm") {
        const res = repoPinRemove(ctx, { repo: pos[1], ref: o.ref, path: o.path });
        ok(res.removed ? `핀 제거: ${res.removed}` : (res.note || "제거할 핀 없음")); return;
      }
      const repo = pos[0];
      if (!repo) die("레포 이름이 필요합니다.  예: lively repo pin <repo> [--ref main] [--path .]");
      const res = await repoPin(ctx, { repo, ref: o.ref, path: o.path });
      ok(`핀: ${bold(res.pin)}  ${dim(`${res.repo}@${res.sha}${res.committed ? " · " + res.committed : ""}${res.reused ? " (재사용)" : ""}`)}`);
      say("  " + dim(res.note));
      return;
    }
    die(`알 수 없는 하위명령: ${sub}\n  lively repo list  ·  lively repo pin <repo> [--ref]  ·  lively repo worktree <repo> [--branch --ref --path]  ·  … remove <repo> [--force]`);
  } catch (e) { die(e.message || String(e)); }
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
  onboarding             내 환경 정리 · 라이블리 첫 세팅을 지금 시작 ${dim("(claude 를 열어 온보딩 스킬 실행 — 언제든 재실행)")}

${bold("설치 · 유지보수")}
  install                키트 설치 / 재설치 (멱등)
  update                 지금 최신으로 맞춤 ${dim("(MCP 재등록 포함 — 자동 업데이트가 못 하는 축)")}
      --check            확인만 하고 설치하지 않음
  uninstall              제거 ${dim("--dry-run  --purge  --yes  --harness claude|codex|all")}

${bold("확인")}
  status                 설치 · 버전 · 하네스 · MCP 상태  ${dim("--json")}
                         ${dim("프로젝트 폴더에서 실행하면 프로젝트 · 공유폴더 동기화 상태도 함께 보여줍니다")}
  doctor                 문제 진단 + 해결책               ${dim("--json")}

${bold("작업")}
  init                   지금 폴더를 프로젝트로 — 기본은 ${bold("제안만")}(무엇을 할지 알려주고 아무것도 안 바꿈)
      --create           새 프로젝트로 만들어 연결  ${dim('--name "<이름>"  --list <리스트id>')}
      --bind <id>        기존 프로젝트에 연결      ${dim("--path <폴더>  --json")}
  run [<프로젝트번호>]    프로젝트 열기 / ${bold("인자 없으면 하네스 바로 실행")}  ${dim("예: lively run 864  ·  lively run --readonly")}
      --readonly         이 세션만 읽기전용(라이블리 읽기 O · 쓰기 X) ${dim("· --incognito(주입·읽기·쓰기 all off) · --normal · --mode <m>")}
      --harness <name>   무인자 실행 때 하네스 선택 ${dim("(기본 claude)")}
  mode [<normal|readonly|incognito>]  디폴트 실행 모드 조회/설정 ${dim("(lively run 이 --mode 없을 때 읽음)")}
  resume <세션id>         다른 환경/멤버에서 만든 내 세션을 이 PC 로 이어받기 ${dim("--node <id>  --print(내려받기만)")}
  backfill                이 PC 의 기존 claude 대화 기록을 중앙에 소급 업로드(웹뷰에 과거 세션도) ${dim("--dry-run")}
  delegate "<작업>"       무거운 작업을 워커/중앙에 위탁 — 진행을 미러하며 결과 출력 후 종료 ${dim('예: lively delegate "테스트 실행" --ram 2048')}
      --repo <이름> [--ref main]  대상 레포 자동 준비(공유 base→worktree, cwd 로)  ${dim("--ram/--cpu/--disk N  --docker  --node <id>  --timeout <초>")}
      --detach               번호만 반환하고 즉시 종료  ${dim("(나중에 lively delegate logs <번호>)")}
  delegate status|logs|cancel <번호> · delegate list
  node                   이 PC 를 노드로 연결 — 웹에서 로컬 터미널 관리/위탁 ${dim("(foreground, Ctrl-C 로 종료)")}
      --daemon               상시화(부팅·로그인마다 자동) ${dim("macOS launchd · Linux systemd --user")}   ·   node stop  데몬 해제
  repo list              이 머신에서 뜰 수 있는 레포 + 로컬 상태
  repo pin <레포>        코드 근거 분석용 읽기전용 핀(SHA 고정) ${dim("--ref main  --path .  ·  pin remove <레포>")}
  repo worktree <레포>   워크트리 생성(코드 작업면) — 프로젝트면 그 폴더의 <레포> 자리 ${dim("--branch b  --ref main  --path .  ·  worktree remove <레포> [--force]")}

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

// lively resume <sid> — 다른 환경/멤버에서 만든 내 세션을 이 PC 로 이어받는다(#905 C1 슬⑤c).
//  중앙 트랜스크립트를 이 머신의 claude 프로젝트 경로로 물질화한 뒤 `claude --resume <sid>` 를 띄운다.
//  인가: 워터마크 GET 이 **소유자 전용**(owner && owner!==나 → 403) — 남의 세션은 못 이어받는다(canResumeAsOrigin=owner,
//   열람보다 강한 게이트). ⚠ cwd 정합: claude --resume 은 트랜스크립트가 기록된 cwd 와 현재 cwd 가 어긋나면 어색할 수
//   있다 — 환경 무관 동일 abs 경로(프로젝트 워크스페이스 격리)가 전제다(#905 설계). --print 는 물질화만 하고 명령만 출력.
async function cmdResume(args) {
  const o = { node: "", print: false, _: [] };
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "--node") o.node = String(args[++i] ?? "");
    else if (t === "--print" || t === "--dry-run") o.print = true;
    else o._.push(t);
  }
  const sid = o._[0];
  if (!sid || !/^[A-Za-z0-9._-]{1,64}$/.test(sid)) { say(red("사용법: lively resume <세션id> [--node <id>] [--print]")); process.exit(2); }
  const gw = gateway(), tok = token();
  if (!gw) { say(red("게이트웨이 주소를 모릅니다 — `lively login --gateway <url>` 로 지정하세요.")); process.exit(1); }
  if (!tok) { say(red("로그인이 필요합니다 — `lively login` 을 먼저 실행하세요.")); process.exit(1); }
  const q = new URLSearchParams({ node: o.node }).toString();
  const H = { authorization: `Bearer ${tok}` };

  // 1) 소유권·오프셋 — 워터마크는 소유자 전용(비소유자 403). 이어받기는 열람보다 강한 게이트다.
  let total = 0;
  try {
    const r = await fetch(`${gw}/api/ui/v6/sessions/${encodeURIComponent(sid)}/log/watermark?${q}`, { headers: H });
    if (r.status === 401 || r.status === 403) { say(red("이 세션을 이어받을 수 없습니다 — 소유자가 아니거나 접근 권한이 없습니다.")); process.exit(1); }
    if (!r.ok) { say(red(`게이트웨이 오류 ${r.status}.`)); process.exit(1); }
    total = Number((await r.json())?.bytes) || 0;
  } catch (e) { say(red(`게이트웨이 접속 실패: ${e.message}`)); process.exit(1); }
  if (total <= 0) { say(red(`세션 ${sid} 의 중앙 기록이 없습니다(캡처 꺼짐/미수집?) — 이어받을 내용이 없습니다.`)); process.exit(1); }

  // 2) 트랜스크립트 원문(x-ndjson) 회수.
  let body;
  try {
    const r = await fetch(`${gw}/api/ui/v6/sessions/${encodeURIComponent(sid)}/log?${q}`, { headers: H });
    if (!r.ok) { say(red(`트랜스크립트 회수 실패 ${r.status}.`)); process.exit(1); }
    body = Buffer.from(await r.arrayBuffer());
  } catch (e) { say(red(`트랜스크립트 회수 실패: ${e.message}`)); process.exit(1); }
  if (!body.length) { say(red("회수된 트랜스크립트가 비었습니다.")); process.exit(1); }

  // 3) 이 머신의 claude 프로젝트 경로로 물질화(cwd 인코딩 '/'·'.' → '-' — 서버 terminal-transcript 와 동일 규칙).
  const dir = join(HOME, ".claude", "projects", process.cwd().replace(/[/.]/g, "-"));
  const file = join(dir, `${sid}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, body);
  say(dim(`  · 트랜스크립트 물질화: ${file} (${body.length} 바이트)`));

  // 4) claude --resume 실행(또는 --print 면 명령만 출력하고 끝).
  if (o.print) { say(`claude --resume ${sid}`); return; }
  if (!has("claude")) { say(red(`claude 실행파일을 못 찾았습니다 — 물질화만 완료. 수동으로 \`claude --resume ${sid}\` 하세요.`)); process.exit(1); }
  const st = spawnSync("claude", ["--resume", sid], { stdio: "inherit", cwd: process.cwd() }).status;
  process.exit(st ?? 0);
}

// lively backfill [--dry-run] — 이 머신의 **기존** claude 트랜스크립트를 중앙에 소급 업로드(#905 C1).
//  캡처 훅은 "켠 뒤 늘어나는 델타"만 보낸다 → 웹뷰가 과거 세션은 못 본다. 이 명령이 ~/.claude/projects/*/*.jsonl
//  전체를 훑어 서버 워터마크부터 올린다(훅과 동일 로직의 배치판). 멱등(offset-CAS): 이미 올라간 건 서버가 흡수.
//  소유자=인증한 나. 세션 공유가 꺼져 있으면 서버가 막는다(관리 ▸ 세션 공유를 먼저 켜라). --dry-run 은 조회만.
// 트랜스크립트의 cwd → `.lively/project.json` 마커의 project_id(구조화된 정본 — 경로 휴리스틱 아님). 없으면 null.
//  cwd 는 앞쪽 라인에 나오므로 앞부분만 스캔. cwd 에서 위로 올라가며 마커를 찾는다.
function projectIdForTranscript(buf) {
  let cwd = null;
  const head = buf.toString("utf8", 0, Math.min(buf.length, 65536));
  for (const line of head.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try { const o = JSON.parse(line); if (typeof o.cwd === "string" && o.cwd) { cwd = o.cwd; break; } } catch { /* 부분/깨진 줄 */ }
  }
  if (!cwd) return null;
  let dir = cwd;
  for (let i = 0; i < 40 && dir; i++) {
    try { const m = JSON.parse(readFileSync(join(dir, ".lively", "project.json"), "utf8")); if (m && Number.isInteger(m.project_id) && m.project_id > 0) return m.project_id; } catch { /* 마커 없음·파손 */ }
    const p = dirname(dir); if (p === dir) break; dir = p;
  }
  return null;
}

async function cmdBackfill(args) {
  const dry = args.includes("--dry-run") || args.includes("--print");
  const gw = gateway(), tok = token();
  if (!gw) { say(red("게이트웨이 주소를 모릅니다 — `lively login --gateway <url>`.")); process.exit(1); }
  if (!tok) { say(red("로그인이 필요합니다 — `lively login`.")); process.exit(1); }
  const base = join(HOME, ".claude", "projects");
  let dirs;
  try { dirs = readdirSync(base); } catch { say(`claude 기록 폴더가 없습니다: ${base} — 올릴 게 없습니다.`); return; }
  const files = [];
  for (const d of dirs) {
    let inner; try { inner = readdirSync(join(base, d)); } catch { continue; }
    for (const f of inner) if (f.endsWith(".jsonl")) files.push({ sid: f.slice(0, -6), path: join(base, d, f) });
  }
  if (!files.length) { say("올릴 트랜스크립트가 없습니다."); return; }
  say(`발견: ${files.length}개 세션 트랜스크립트${dry ? dim("  (dry-run — 전송 안 함)") : ""}`);
  const H = { authorization: `Bearer ${tok}` };
  const MAXD = 8 * 1024 * 1024;
  let sent = 0, already = 0, skipped = 0, failed = 0, bytesUp = 0, mapped = 0;
  for (const { sid, path: fp } of files) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(sid)) { skipped++; continue; }
    let full; try { full = readFileSync(fp); } catch { skipped++; continue; }
    if (!full.length) { skipped++; continue; }
    // 서버 워터마크 + 캡처 정책(한 왕복).
    let from = 0;
    try {
      const r = await fetch(`${gw}/api/ui/v6/sessions/${encodeURIComponent(sid)}/log/watermark?node=`, { headers: H });
      if (r.status === 401 || r.status === 403) { say(red("접근 거부(세션 공유 꺼짐 또는 토큰 무효) — 관리 ▸ 세션 공유를 켜고 다시 시도하세요.")); process.exit(1); }
      if (!r.ok) { failed++; continue; }
      const j = await r.json();
      from = Number(j.bytes) || 0;
      if (j.capture && j.capture.enabled !== true) { say(red("세션 공유가 꺼져 있습니다 — 관리 ▸ 세션 공유에서 켜세요.")); process.exit(1); }
    } catch { failed++; continue; }
    // 프로젝트 귀속 값 — .lively/project.json 마커에서(구조화된 정본). append 쿼리에 실어 서버가 멤버 확인 후 매핑.
    const projectId = projectIdForTranscript(full);
    const projQ = projectId ? { project: String(projectId) } : {};
    if (full.length <= from) {
      // 내용은 이미 다 올라감 — 프로젝트 매핑만 갱신(0바이트 append + 마커 project). projectId 없으면 그냥 스킵.
      if (projectId && !dry) {
        try {
          await fetch(`${gw}/api/ui/v6/sessions/${encodeURIComponent(sid)}/log?${new URLSearchParams({ at: String(from), node: "", harness: "claude", ...projQ })}`,
            { method: "POST", headers: { ...H, "content-type": "application/octet-stream" }, body: Buffer.alloc(0) });
          mapped++;
        } catch { /* 비치명 */ }
      }
      already++; continue;
    }
    if (dry) { say(dim(`  [dry] ${sid}  ${from}→${full.length} (+${full.length - from}B)${projectId ? ` · project ${projectId}` : ""}`)); sent++; continue; }
    // 델타를 MAXD 청크로 순차 POST(offset-CAS 가 이어붙임). 응답 bytes 로 다음 오프셋 정정.
    let ok = true;
    while (from < full.length) {
      const end = Math.min(full.length, from + MAXD);
      const buf = full.subarray(from, end);
      try {
        const r = await fetch(`${gw}/api/ui/v6/sessions/${encodeURIComponent(sid)}/log?${new URLSearchParams({ at: String(from), node: "", harness: "claude", ...projQ })}`, {
          method: "POST", headers: { ...H, "content-type": "application/octet-stream" }, body: buf });
        if (!r.ok) { ok = false; break; }
        const j = await r.json();
        const nb = Number(j.bytes);
        bytesUp += buf.length;
        from = Number.isFinite(nb) && nb > from ? nb : end;   // 서버 진실로 전진(중복/gap 정정)
      } catch { ok = false; break; }
    }
    if (ok) sent++; else failed++;
  }
  say(`완료 — 전송 ${sent} · 이미있음 ${already} · 프로젝트매핑 ${mapped} · 건너뜀 ${skipped} · 실패 ${failed}${bytesUp ? ` · ${Math.round(bytesUp / 1024)}KB` : ""}`);
}

// lively onboarding [초기프롬프트…] — 온보딩 스킬을 이 PC 에서 바로 실행한다.
//  claude 를 초기 프롬프트("온보딩 도와줘")로 띄우면 하네스가 그 문구로 lively-onboarding 스킬을 소환한다.
//  설치 직후 제안(setup-mac.sh)과 사람의 수동 재실행이 같은 진입을 쓴다. cmdResume 과 동형(has 가드 + spawnSync inherit).
//  ⚠ 자동승인 플래그는 주지 않는다 — 멤버가 깔아둔 auto-approve 를 쓰고 나머지는 정상 권한 프롬프트(온보딩은 신뢰가 전부).
//  --print 는 실제로 안 띄우고 실행할 명령만 출력(테스트·확인용, resume 과 동일 관례).
function cmdOnboarding(rest) {
  const printOnly = rest.includes("--print") || rest.includes("--dry-run");
  const prompt = rest.filter((a) => a !== "--print" && a !== "--dry-run").join(" ").trim() || "온보딩 도와줘";
  if (printOnly) { say(`claude ${JSON.stringify(prompt)}`); return; }
  if (!has("claude")) { say(red("claude 실행파일을 못 찾았습니다 — 먼저 `lively install` 로 하네스를 설치하세요.")); process.exit(1); }
  say(dim(`  · 온보딩 세션을 엽니다 — "${prompt}"`));
  const st = spawnSync("claude", [prompt], { stdio: "inherit", cwd: process.cwd() }).status;
  process.exit(st ?? 0);
}

async function main() {
  const argv = process.argv.slice(2);
  const o = parse(argv);
  const cmd = o._[0] || (o.version ? "version" : o.help ? "help" : "status");

  switch (cmd) {
    case "setup": return cmdSetup();
    case "login": { await cmdLogin(o); return; }
    case "logout": return cmdLogout();
    // onboarding — 온보딩 스킬을 이 PC 에서 바로 실행(설치 직후 제안·수동 재실행 공용). 나머지 인자=초기 프롬프트.
    case "onboarding": return cmdOnboarding(argv.slice(argv.indexOf("onboarding") + 1));
    case "install": { await cmdInstall(); return; }
    case "update": case "upgrade": return cmdUpdate(o);
    case "uninstall": case "remove": return cmdUninstall(o);
    case "init": return cmdInit(argv.slice(argv.indexOf("init") + 1));
    case "status": return cmdStatus(o);
    case "doctor": return cmdDoctor(o);
    // run 은 나머지 인자를 **그대로** 넘긴다(모드 플래그만 cmdRun 이 소비, 나머지는 work.mjs/하네스로 원형 보존).
    case "run": return cmdRun(argv.slice(argv.indexOf("run") + 1));
    // mode — 디폴트 실행 모드(normal|readonly|incognito) 조회/설정(#1007+). lively run 이 이걸 읽는다.
    case "mode": return cmdMode(argv.slice(argv.indexOf("mode") + 1));
    // delegate 도 나머지 인자 원형 보존(--ram 등 delegate 전용 옵션이 CLI 공통 파서에 안 먹히게).
    case "delegate": return cmdDelegate(argv.slice(argv.indexOf("delegate") + 1));
    // node — 이 PC 를 라이블리 노드로 연결(데몬 없이 foreground). 나머지 인자 원형 보존.
    case "node": return cmdNode(argv.slice(argv.indexOf("node") + 1));
    // mcp-local — 로컬 조작 stdio MCP 서버(하네스가 spawn). stdin 이 닫힐 때까지 블로킹.
    case "mcp-local": return cmdMcpLocal();
    // repo — 워크트리 셀프서비스(list/worktree). MCP 툴과 같은 코어. 나머지 인자 원형 보존.
    case "repo": return cmdRepo(argv.slice(argv.indexOf("repo") + 1));
    // resume — 다른 환경에서 내 세션 이어받기(#905 C1). 중앙 트랜스크립트를 이 PC 로 내려 claude --resume.
    case "resume": return cmdResume(argv.slice(argv.indexOf("resume") + 1));
    // backfill — 이 머신의 기존 claude 트랜스크립트를 중앙에 소급 업로드(#905 C1). 웹뷰에 과거 세션도 보이게.
    case "backfill": return cmdBackfill(argv.slice(argv.indexOf("backfill") + 1));
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

export { parse, detectHarnesses, verifyBundle, normGw, gatherStatus, registerClaudeMcp, backupUserMcp, winArg, loginEscapeToken, REQUIRED_HOOKS, CLI_VERSION };
export { MODES, extractMode, modeEnv, defaultMode }; // #1007+ 실행 모드(normal|readonly|incognito) — 테스트용
