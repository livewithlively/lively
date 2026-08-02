// ═══════════════════════════════════════════════════════════════════════════
// `lively node` 서브커맨드 (#869) — lively.mjs 에서 **원문 그대로** 분리한 조각(#1313 R52).
//  repo-worktree-core.mjs·project-init-core.mjs 와 같은 레일: 경로 상수는 이 파일이 스스로 파생하고,
//  출력·게이트웨이 같은 공용 원시함수만 lively.mjs 가 ctx 로 주입한다.
//
//  ⚠ **왜 lively.mjs 가 static import 를 못 하나** — 부트스트랩(`curl … | sh`)은 게이트웨이의 무인증
//   `/cli/lively.mjs` **한 파일만** 내려받아 `lively setup` 을 실행한다(kit/cli/bootstrap.sh). 형제 모듈은
//   그 뒤 `lively install` 이 번들에서 ~/.lively/lib 로 앉힌다. 그래서 설치 이전에 닿는 명령(setup·login·
//   install·status·doctor)은 lively.mjs 안에 남아야 하고, 설치 이후 표면(node·delegate·session·repo·init·mcp)만
//   여기처럼 dynamic import 로 뗄 수 있다.
//
//  주입 컨텍스트  ctx = { say, dim, green, yellow, die, has, api, gateway, token, writeLively }
//   (lively.mjs 의 cliCtx() 가 만든다 — 본문은 원문 그대로 이 이름들을 쓴다.)
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn, execFileSync } from "node:child_process";

// lively.mjs 와 같은 계약(LIVELY_HOME 은 HOME 리다이렉트 — 샌드박스/테스트).
const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");

// ctx 주입 슬롯 — 아래 함수 본문은 lively.mjs 원문 그대로다(이름·들여쓰기 무변경).
let say, dim, green, yellow, die, has, api, gateway, token, writeLively;

export function nodeCommands(ctx) {
  ({ say, dim, green, yellow, die, has, api, gateway, token, writeLively } = ctx);
  return { cmdNode };
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
