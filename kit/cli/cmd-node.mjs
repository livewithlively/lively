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
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, dirname, win32 as pwin, posix as pposix } from "node:path";
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

/**
 * 로그를 따라 읽는 한 줄 — **그 OS 에서 한글이 안 깨지는** 명령이어야 한다.
 *
 * ★ Windows 에서 `type <파일>` 을 안내하면 안 된다(#1541 실측): 로그는 UTF-8 인데 한국어 Windows 콘솔은
 *  `chcp 949` 로 시작해 `type` 이 그 바이트를 cp949 로 해석한다 → 한글이 전부 깨진다(`?쒓?媛€?섎떎`).
 *  파일도 우리 출력도 정상인데 **읽는 명령**만 틀렸던 것이고, 그 틀린 명령을 우리가 안내해 왔다.
 *  `Get-Content -Encoding utf8` 은 파일을 UTF-8 로 **명시 디코드**해 .NET 문자열로 만들고, PowerShell 은
 *  그 문자열을 WriteConsoleW(유니코드)로 찍는다 → **콘솔 코드페이지와 무관하게** 정상이다.
 *  (`-Wait` = `tail -f` 의 따라가기 · `-Tail 50` = 끝부분부터.)
 * @param {string} logFile
 * @param {string} [platform]
 */
export function logTailHint(logFile, platform = process.platform) {
  return platform === "win32"
    ? `Get-Content -Wait -Tail 50 -Encoding utf8 '${logFile}'`
    : `tail -f ${logFile}`;
}
const LAUNCHD_LABEL = "io.lvly.node-agent";
const PLIST_PATH = join(HOME, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const SYSTEMD_UNIT = join(HOME, ".config", "systemd", "user", "lively-node-agent.service");
const WIN = process.platform === "win32";
// Windows 상시화 = 작업 스케줄러(로그온 트리거 + 실패 시 재시작). 서비스가 아니라 **사용자 작업**인 이유:
//  노드가 띄우는 세션은 그 사용자의 하네스·자격·홈을 쓴다 — SYSTEM 권한 서비스로 돌리면 남의 신원이 된다.
const WIN_TASK_NAME = "Lively Node Agent";
// 폴백 상시화 — 작업 스케줄러를 **쓸 수 없는 계정**용(비관리자 + 그룹정책. 실측 #1541).
//  시작프로그램 폴더는 자기 프로필의 파일 하나라 권한상승·정책을 안 탄다. 스케줄러가 되면 이건 안 쓴다.
const WIN_STARTUP_VBS = "lively-node-agent.vbs";
// 우리가 직접 설치할 때의 자리(패키지 매니저가 없는 박스 — Server 등). ~/.lively 안이라 제거도 대칭이다.
const WIN_MUX_DIR = join(LIVELY, "bin", "psmux");

// 노드 세션이 올라탈 **멀티플렉서** — POSIX 는 tmux, Windows 는 psmux(ConPTY 네이티브 tmux 구현).
//  ⚠ 왜 Windows 에서 WSL2 가 아니라 psmux 인가: WSL2 로 가면 그 노드는 '이 PC'가 아니라 'PC 안 리눅스 VM'이
//   된다 — 사용자의 Windows 파일(C:\…)·네이티브 하네스 인증과 분리되고, /mnt/c 파일 I/O 도 느리다. psmux 는
//   같은 Windows 사용자 세션 안에서 돈다. 우리가 실제로 부르는 호출(포맷 확장 #{@user-option}·control mode
//   -CC·capture-pane 플래그 조합·세션 지속성)을 실기기에서 전수 검증했다 — 근거는 프로젝트 #1541.
const MUX = WIN ? "psmux" : "tmux";
const MUX_EXE = WIN ? "psmux.exe" : "tmux";

// 실행파일 후보 — PATH 해석이 실패했을 때의 폴백 목록.
//  ⚠ 순수함수로 뺀다(#1510 §5): Windows 분기는 mac/linux CI 에서 **한 번도 실행되지 않는다**. platform·env 를
//   인자로 받으면 그 플랫폼이 아니어도 목록 자체를 테스트로 못박을 수 있다. 경로 조립도 pwin.join 을 써서
//   POSIX 에서 만들어도 진짜 Windows 구분자가 나오게 한다(join 을 그대로 쓰면 `/` 가 섞여 검증이 무의미해진다).
export function muxCandidates(platform = process.platform, env = process.env) {
  if (platform !== "win32") return ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/opt/local/bin/tmux", "/usr/bin/tmux"];
  const h = env.LIVELY_HOME || env.USERPROFILE || env.HOME || "";
  const local = env.LOCALAPPDATA || (h ? pwin.join(h, "AppData", "Local") : "");
  const pf = env.ProgramFiles || "C:\\Program Files";
  return [
    h && pwin.join(h, ".lively", "bin", "psmux", "psmux.exe"),          // 우리가 깐 것 우선(제거도 대칭)
    local && pwin.join(local, "Microsoft", "WinGet", "Links", "psmux.exe"),
    local && pwin.join(local, "Programs", "psmux", "psmux.exe"),
    h && pwin.join(h, "scoop", "shims", "psmux.exe"),
    "C:\\ProgramData\\chocolatey\\bin\\psmux.exe",
    pwin.join(pf, "psmux", "psmux.exe"),
  ].filter(Boolean);
}

// 멀티플렉서 절대경로 해석.
//  ⚠ POSIX 에서 bash -l 로 PATH 를 재설정하지 않는다: 사용자의 대화형 셸(zsh 등) PATH 를 상속한 현재 프로세스에서
//   찾아야 homebrew·사용자 설치 경로가 잡힌다(#869 haru 사례: bash -lc 이 zsh PATH 를 버려 tmux 미검출 → 노드가
//   하드코딩 /opt/homebrew/bin/tmux 로 폴백 → spawn ENOENT → 세션생성 500). 상속 PATH 우선, 없으면 흔한 위치 폴백.
function resolveTmux() {
  if (WIN) {
    // where.exe 는 여러 줄을 낼 수 있다(같은 이름이 PATH 에 여럿) — 첫 줄만 쓴다.
    //  ⚠ stderr 는 반드시 버린다(실측 #1541): 못 찾으면 where 가 "지정된 파일에 해당되는 파일을 찾지 못했습니다"
    //   를 콘솔에 그대로 뱉는데, 이건 **정상 경로**(설치 전 탐지)다. 게다가 cp949 로 나와 UTF-8 콘솔에선 깨진
    //   글자로 보인다 — 사용자는 그걸 크래시로 읽는다. 여기선 '없음' 이 답이지 에러가 아니다.
    try {
      const out = execFileSync("where", [MUX_EXE], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first && existsSync(first)) return first;
    } catch { /* PATH 에 없음 */ }
  } else {
    try { const p = execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim(); if (p) return p; } catch { /* not on PATH */ }
  }
  for (const c of muxCandidates()) { if (existsSync(c)) return c; }
  return null;
}

// 멀티플렉서 확보 — 있으면 절대경로, 없으면 **자동 설치**(안내 말고 자동 — 사용자 요청). 그래도 없으면 die.
async function ensureTmux() {
  const found = process.env.TMUX_BIN || resolveTmux();
  if (found) return found;
  say(dim(`· ${MUX} 가 없어 자동 설치를 시도합니다(웹터미널·위탁 세션 실행에 필요)…`));
  if (await autoInstallTmux()) {
    const t = resolveTmux();
    if (t) { say(green(`✓ ${MUX} 설치됨 — ${t}`)); return t; }
  }
  die(tmuxHelp(), 2);
}
// 자동 설치. 성공=true. macOS=brew · Linux=apt/dnf/yum/pacman/apk/zypper(비-root 면 sudo) · Windows=winget/scoop→릴리스 zip.
async function autoInstallTmux() {
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
  if (process.platform === "win32") {
    // 패키지 매니저가 있으면 그쪽이 낫다 — 설치·갱신·제거가 표준 경로에 남는다(#869 의 '공급망 표면 최소' 취지).
    if (has("winget") && run(winInstallArgv())) return true;
    // scoop 은 **공식 Main 버킷**에 psmux 가 있다(bucket/psmux.json → 같은 GitHub 릴리스 zip + sha256).
    //  업스트림 README 는 전용 버킷 추가를 안내하지만 그건 대안 경로다 — 남의 버킷을 사용자 scoop 설정에
    //  영구히 등록하는 부작용을 낼 이유가 없다.
    if (has("scoop") && run(["scoop", "install", "psmux"])) return true;
    // 없으면(Windows Server 등 winget 미동봉 박스) 릴리스 zip 을 우리 자리에 푼다.
    return await installPsmuxFromRelease();
  }
  return false;
}
// winget 설치 명령 — **패키지 id 는 `marlocarlo.psmux`** 다.
//  ⚠ 이 문자열은 추측할 수 없고, 틀려도 **조용히** 실패한다(`-e` 라 엉뚱한 패키지가 깔리진 않지만, 그냥 실패한 뒤
//   zip 폴백으로 떨어져 '왜 느리지'로만 보인다). winget 공식 소스 인덱스(cdn.winget.microsoft.com/cache/source.msix
//   안의 index.db)를 직접 조회해 확정했다 — id 는 `marlocarlo.psmux`(publisher 가 psmux 가 아니다).
//   winget-pkgs 매니페스트도 manifests/m/marlocarlo/psmux/3.3.7 에 있고 InstallerUrl 이 psmux/psmux 릴리스 zip 을
//   가리킨다. 종전 값 `psmux.psmux` 는 **존재하지 않는다**(그 publisher 폴더엔 psmux.TerminalMap 뿐).
//  순수함수로 빼는 이유는 muxCandidates 와 같다(#1510 §5) — Windows 분기는 mac/linux CI 에서 한 번도 안 돈다.
export function winInstallArgv() {
  return ["winget", "install", "--id", "marlocarlo.psmux", "-e", "--silent",
    "--accept-package-agreements", "--accept-source-agreements"];
}

// psmux 릴리스 zip → ~/.lively/bin/psmux/ (패키지 매니저가 없는 박스용 폴백).
//  zip 해제는 Windows 10 1803+ 동봉 tar.exe 로 한다(별도 도구 불요). PATH 가 빈약한 컨텍스트를 대비해 절대경로 우선(#1510 §6).
//  export 인 이유: winget 이 없는 박스(Windows Server)가 **실제로 타는 유일한 경로**인데 CI 에서 한 번도 안 돈다
//   → 실기기 검증 하네스가 제품 함수를 그대로 부를 수 있어야 한다(하네스가 절차를 베끼면 하네스만 검증된다).
export async function installPsmuxFromRelease() {
  const arch = process.arch === "arm64" ? "arm64" : (process.arch === "ia32" ? "x86" : "x64");
  try {
    const rel = await fetch("https://api.github.com/repos/psmux/psmux/releases/latest", {
      headers: { "user-agent": "lively-cli", accept: "application/vnd.github+json" },
    }).then((r) => (r.ok ? r.json() : null));
    const asset = (rel?.assets || []).find((a) => /\.zip$/i.test(a.name) && a.name.includes(arch) && !/setup/i.test(a.name));
    if (!asset) return false;
    say(dim(`  ↓ ${asset.name}`));
    const res = await fetch(asset.browser_download_url, { headers: { "user-agent": "lively-cli" } });
    if (!res.ok) return false;
    mkdirSync(WIN_MUX_DIR, { recursive: true });
    const zip = join(WIN_MUX_DIR, "psmux.zip");
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    execFileSync(tarBin(), ["-xf", zip, "-C", WIN_MUX_DIR], { stdio: "ignore" });
    rmSync(zip, { force: true });
    // zip 이 하위 폴더를 만드는 배포도 있다 — 실행파일을 찾아 루트로 끌어올린다(후보 목록이 루트를 본다).
    if (!existsSync(join(WIN_MUX_DIR, MUX_EXE))) {
      const found = findFileDeep(WIN_MUX_DIR, MUX_EXE, 3);
      if (found) writeFileSync(join(WIN_MUX_DIR, MUX_EXE), readFileSync(found));
    }
    return existsSync(join(WIN_MUX_DIR, MUX_EXE));
  } catch { return false; }
}
// 얕은 재귀 탐색(깊이 제한) — zip 내부 배치가 배포마다 달라서.
function findFileDeep(dir, name, depth) {
  if (depth < 0) return null;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
    if (e.isDirectory()) { const hit = findFileDeep(p, name, depth - 1); if (hit) return hit; }
  }
  return null;
}
// 윈도우 tar.exe 는 System32 동봉이다 — 훅·자식 프로세스의 빈약한 PATH 에서도 찾도록 절대경로를 먼저 본다(#1510 §6).
function tarBin() {
  if (!WIN) return "tar";
  const abs = pwin.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "tar.exe");
  return existsSync(abs) ? abs : "tar";
}
function tmuxHelp() {
  if (process.platform === "darwin")
    return "tmux 가 필요한데 Homebrew 가 없어 자동 설치를 못 했습니다. Homebrew 설치 후 `lively node` 를 다시 실행하면 tmux 를 자동 설치합니다:\n" +
      '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
  if (process.platform === "linux")
    return "tmux 자동 설치 실패(패키지 매니저·권한 확인). 수동: sudo apt install -y tmux (또는 dnf/pacman/apk/zypper).";
  if (process.platform === "win32")
    return "psmux(윈도우용 tmux) 자동 설치에 실패했습니다. 네트워크·권한을 확인하고 다시 실행하거나, 수동으로 설치하세요:\n" +
      "  winget install marlocarlo.psmux      (또는 scoop install psmux)\n" +
      "  설치 후 `lively node --daemon` 을 다시 실행하면 됩니다.";
  return `${MUX} 가 필요합니다 — 설치 후 다시 실행하세요.`;
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
  const tmuxPath = await ensureTmux();

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
  // ⚠ tar 는 절대경로 우선(#1510 §6) — 훅·데몬처럼 PATH 가 빈약한 컨텍스트에서 System32\tar.exe 를 못 찾는 사고가 있었다.
  try { execFileSync(tarBin(), ["-xzf", tgz, "-C", NODE_AGENT_DIR], { stdio: "ignore" }); }
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
    say(dim(`   중지: lively node stop   ·   로그: ${logTailHint(NODE_LOG)}`));
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
  if (WIN) {
    // 작업 스케줄러 = Windows 의 LaunchAgent/systemd 대응물. XML 로 등록하는 이유는 `schtasks /Create` 의
    //  플래그로는 **재시작 정책·실행시간 무제한**을 못 주기 때문이다(그 둘이 '죽지 않는다'의 실체다).
    // 접속정보는 --env-file 로 넣는다(토큰이 명령줄에 안 실린다). 그건 Node 20.6+ 기능이라, 그 미만이면
    //  데몬이 게이트웨이 주소·토큰을 못 읽어 **조용히 오프라인**이 된다. '있는지'가 아니라 '되는지'로 판정하고
    //  무엇을 해야 하는지까지 말한다(#1087 의 규율 — 판정 실패를 결론으로 단정하지 않는다).
    const [nmaj, nmin] = process.versions.node.split(".").map(Number);
    if (nmaj < 20 || (nmaj === 20 && nmin < 6)) {
      die(`지금 Node(${process.versions.node})는 --env-file 을 지원하지 않습니다(20.6+ 필요) — 데몬이 접속정보를 못 읽습니다.\n` +
        "  `lively update` 로 런타임을 최신화한 뒤 `lively node --daemon` 을 다시 실행하세요.", 2);
    }
    mkdirSync(LIVELY, { recursive: true });
    // 런처(.cmd) — 스케줄러는 이것만 실행한다. 재시작 루프가 여기 있다(위 winRunnerCmd 주석 참조).
    const runnerCmd = join(LIVELY, "node-agent-run.cmd");
    writeFileSync(runnerCmd, winRunnerCmd({ nodeBin, agentJs, envFile: NODE_ENV_FILE, logFile: NODE_LOG }));
    const xmlPath = join(LIVELY, "node-agent-task.xml");
    const xml = winTaskXml({ runnerCmd, userId: winUserId() });
    // ⚠ schtasks /XML 은 UTF-16(BOM 포함)을 기대한다. UTF-8 로 쓰면 한글 설명이 깨지고 파싱이 실패할 수 있다.
    writeFileSync(xmlPath, "\ufeff" + xml, "utf16le");
    spawnSync("schtasks", ["/Delete", "/TN", WIN_TASK_NAME, "/F"], { stdio: "ignore" });   // 재등록 안전(멱등)
    // stdio:"pipe" — 실패했을 때 **schtasks 가 뭐라 했는지**가 폴백 여부 판단의 근거다(그냥 버리면 진단이 사라진다).
    const r = spawnSync("schtasks", ["/Create", "/TN", WIN_TASK_NAME, "/XML", xmlPath], { encoding: "utf8" });
    if (r.status === 0) {
      const since = Date.now();                                                            // 기동 **전** 시각 — 이후의 연결만 우리 것으로 센다
      spawnSync("schtasks", ["/Run", "/TN", WIN_TASK_NAME], { stdio: "ignore" });          // 재로그인 기다리지 않고 지금 기동
      say(green(`✅ 노드 '${nodeId}' 상시화(작업 스케줄러) — 로그인마다 자동 연결·죽으면 1분 뒤 재기동`));
      say(dim(`   중지: lively node stop   ·   로그: ${logTailHint(NODE_LOG)}`));
      reportAgentAlive(since);
      return;
    }
    // ── 폴백: 작업 스케줄러를 **못 쓰는 계정**이 있다(실측 #1541, 일반 사용자 PC). ──
    //  비관리자 + 그룹정책이면 `schtasks /Create` 가 가장 단순한 ONLOGON 작업조차 "액세스가 거부되었습니다" 로
    //  거절한다(트리거 종류·S4U 문제가 아니다 — 등록 권한 자체가 없다). 여기서 die 하면 사용자는
    //  "노트북을 노드로 쓴다" 는 이 기능의 본체를 통째로 못 쓴다. 그건 우리 사정이지 사용자 잘못이 아니다.
    //  시작프로그램 폴더는 **자기 프로필에 파일 하나 쓰는 것**이라 권한상승도 정책도 타지 않는다.
    //  잃는 것은 '로그인 전 기동' 하나뿐 — 어차피 그건 관리자 권한이 필요하고, 사용자 홈·자격으로 도는
    //  노드에겐 로그인 전 실행이 의미도 없다. 재시작 보장은 런처(.cmd)의 루프가 그대로 진다.
    say(yellow(`⚠ 작업 스케줄러 등록이 거부됐습니다 — 시작프로그램 방식으로 대체합니다.`));
    const denied = String(r.stderr || r.stdout || "").trim();
    if (denied) say(dim(`   (schtasks: ${denied.split(/\r?\n/)[0]})`));
    const vbsPath = join(winStartupDir(), WIN_STARTUP_VBS);
    try {
      mkdirSync(dirname(vbsPath), { recursive: true });
      // ⚠ UTF-16LE+BOM — BOM 이 없으면 wscript 가 ANSI 로 읽어 **한글 사용자명 경로**(C:\Users\상민\…)가 깨진다.
      writeFileSync(vbsPath, "\ufeff" + winStartupVbs({ runnerCmd }), "utf16le");
    } catch (e) {
      die(`상시화 실패 — 작업 스케줄러도 시작프로그램도 쓸 수 없습니다: ${e?.message || e}\n` +
        "  관리자 PowerShell 에서 `lively node --daemon` 을 실행하거나, `lively node` 로 창을 띄워두고 쓰세요.", 1);
    }
    winKillAgentProcs();                                                                   // 재등록 멱등 — 옛 인스턴스 회수
    const since = Date.now();                                                              // 기동 **전** 시각 — 이후의 연결만 우리 것으로 센다
    // 지금 기동 — 로그인 때와 **같은 경로**로 띄운다(다르게 띄우면 여기선 되고 재부팅 후 안 되는 걸 못 잡는다).
    const started = spawnSync("wscript", [vbsPath], { stdio: "ignore", timeout: 15_000 }).status === 0;
    if (!started) {
      // WSH(Windows Script Host)가 정책으로 꺼진 환경 — 지금 기동만 직접 하고, 자동시작은 아래에서 경고한다.
      spawn(process.env.COMSPEC || "cmd.exe", ["/c", runnerCmd], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    }
    say(green(`✅ 노드 '${nodeId}' 상시화(시작프로그램) — 로그인마다 자동 연결·죽으면 5초 뒤 재기동`));
    if (!started) say(yellow("   ⚠ WSH 가 꺼져 있어 로그인 시 자동 시작이 안 될 수 있습니다 — 재부팅 후 `lively status` 로 확인하세요."));
    say(dim("   로그인 전에는 돌지 않습니다(그 기능은 관리자 권한 필요 — 관리자 PowerShell 에서 다시 실행하면 승격됩니다)."));
    say(dim(`   중지: lively node stop   ·   로그: ${logTailHint(NODE_LOG)}`));
    reportAgentAlive(since);
    return;
  }
  die(`미지원 OS: ${process.platform}`, 1);
}

// 현재 사용자 — 작업 스케줄러의 트리거·주체는 **해석 가능한** 계정명을 요구한다(DOMAIN\user 또는 MACHINE\user).
//  ⚠ USERDOMAIN 을 믿으면 안 된다(실측, #1541): 워크그룹 머신의 일부 로그온 경로(OpenSSH 등)에서 그 값이
//   `WORKGROUP` 으로 들어오는데, 그건 계정 도메인이 아니라 워크그룹 이름이라 SID 로 해석되지 않는다 →
//   `schtasks /Create` 가 "No mapping between account names and security IDs was done" 으로 **등록 자체를 거부**한다.
//   도메인 미가입 머신에서 로컬 계정의 도메인은 **컴퓨터명**이고, `whoami` 가 그걸 정확히 준다.
export function resolveWinUserId({ whoami = "", computerName = "", userName = "", userDomain = "" } = {}) {
  const w = String(whoami).trim();
  if (w.includes("\\")) return w;                                   // 1순위: whoami (machine\user 또는 domain\user)
  if (computerName && userName) return `${computerName}\\${userName}`; // 2순위: 컴퓨터명 조합
  // 3순위: USERDOMAIN — 단, 해석 불가로 알려진 값(WORKGROUP)은 쓰지 않는다. 그럴 바엔 사용자명만 넘겨
  //  스케줄러가 현재 컨텍스트로 해석하게 두는 편이 낫다(등록 거부보다 낫다).
  if (userDomain && userDomain.toUpperCase() !== "WORKGROUP" && userName) return `${userDomain}\\${userName}`;
  return userName || "";
}
function winUserId() {
  let whoami = "";
  try { whoami = execFileSync("whoami", { encoding: "utf8" }); } catch { /* 폴백 경로로 */ }
  return resolveWinUserId({
    whoami,
    computerName: process.env.COMPUTERNAME || "",
    userName: process.env.USERNAME || "",
    userDomain: process.env.USERDOMAIN || "",
  });
}

// 데몬 런처(.cmd) — 작업 스케줄러는 이 파일 하나만 실행한다.
//  ⚠ 왜 XML 에 명령을 인라인하지 않나:
//   ① cmd 의 중첩 인용 규칙이 XML 이스케이프와 겹쳐 아주 깨지기 쉽다(디버깅도 어렵다)
//   ② 사람이 이 파일을 열어 무엇이 도는지 바로 볼 수 있다(진단 표면)
//   ③ **재시작 루프를 여기 둘 수 있다** ← 이게 핵심이다.
//  작업 스케줄러의 RestartOnFailure 는 '작업이 실패로 끝났을 때'에 걸리는데, 실측(#1541 e2e)에서
//  프로세스를 강제 종료해도 3분 동안 되살아나지 않았다. launchd KeepAlive · systemd Restart=always 와
//  같은 보장을 얻으려면 **런처가 직접 되살려야** 한다. 트리거의 1분 Repetition 은 그 위의 2중 안전망이다
//  (런처 자체가 죽어도 1분 안에 스케줄러가 다시 띄운다 — MultipleInstancesPolicy=IgnoreNew 라 중복은 안 생긴다).
//  ⚠ 본문은 **ASCII 로만** 쓴다 — .cmd 는 콘솔 코드페이지(한국어 윈도우면 cp949)로 읽혀 한글 주석이 깨진다.
//   (디스크 .ps1 은 BOM 이 필요하지만 .cmd 에 BOM 을 넣으면 첫 줄이 깨진다 — 파일 종류마다 규칙이 다르다.)
export function winRunnerCmd({ nodeBin, agentJs, envFile, logFile }) {
  return [
    "@echo off",
    "rem Lively node agent launcher - generated by `lively node --daemon`. Do not edit.",
    "rem Restarts the agent if it dies. To stop: `lively node stop`.",
    ":loop",
    `"${nodeBin}" --env-file="${envFile}" "${agentJs}" >> "${logFile}" 2>&1`,
    "timeout /t 5 /nobreak > nul",
    "goto loop",
    "",
  ].join("\r\n");
}

// Windows 상시화 정의(작업 스케줄러 XML).
//  ⚠ 순수함수로 뺀다(#1510 §5) — 이 XML 은 mac/linux CI 에서 한 번도 만들어지지 않으므로, 계약(아래 4가지)을
//   테스트로 직접 못박는다. 실행 커버리지가 0인 표면은 '생김새'라도 고정해야 조용히 썩지 않는다.
//   ① Boot + Logon 트리거 = 부팅 직후·로그인마다 기동 → 'PC 재시작 시 자동 시작'
//   ② RestartOnFailure    = 죽으면 1분 뒤 재기동(launchd KeepAlive · systemd Restart=always 의 대응물)
//   ③ ExecutionTimeLimit 0= 기본 3일 제한 해제(상시 데몬은 끝나면 안 된다)
//   ④ S4U + LeastPrivilege= **그 사용자 신원으로, 비밀번호 저장 없이, 권한상승 없이** 실행.
//        ⚠ InteractiveToken 이 아닌 이유(실측 #1541): 그건 **대화형 로그온 세션이 있어야만** 실행된다.
//         원격/무인 박스(로그인 안 한 PC, 서버, SSH 관리)에선 트리거가 걸려도 `Last Result 267011`
//         (한 번도 실행되지 않음) 로 조용히 안 돈다 — 상시성이 무너지고, 무엇보다 **검증할 수 없다**.
//         S4U 는 같은 사용자 컨텍스트(홈·하네스 자격 그대로)를 유지하면서 로그온 세션을 요구하지 않는다.
//         SYSTEM 서비스와는 다르다 — SYSTEM 으로 올리면 노드가 띄우는 세션이 남의 신원을 쓰게 된다.
export function winTaskXml({ runnerCmd, userId }) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inner = `"${runnerCmd}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Lively node agent — 이 PC 를 라이블리 노드로 연결(웹터미널 세션·위탁 워커).</Description>
    <URI>\\${esc(WIN_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT1M</Interval>
        <Duration>P3650D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </BootTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${esc(userId)}</UserId>
      <Repetition>
        <Interval>PT1M</Interval>
        <Duration>P3650D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${esc(userId)}</UserId>
      <LogonType>S4U</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c ${esc(inner)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// ── 기동 확인 — '등록했다' 와 '돌고 있다' 는 다르다 (#1541 실측). ─────────────────────────────
// 왜 필요했나: 시작프로그램 폴백이 등록에 성공해 `✅ 상시화` 를 찍었는데, 에이전트는 **한 번도 붙지 않았다**.
//  사용자는 초록 체크를 보고 끝났다고 믿었고, 노드는 관리탭에서 오프라인이었다. 등록 성공을 기동 성공이라고
//  말한 것 — 그게 거짓말이다. 여기서 실제로 떴는지 보고, 안 떴으면 **로그 꼬리까지 붙여** 사실대로 말한다.
//  ⚠ '못 쟀다(null)' 와 '안 돈다(false)' 를 구분한다 — 프로브를 못 돌린 걸 실패로 단정하지 않는다(#1087).

/** 동기 sleep — nodeInstallDaemon 이 동기 흐름이라(설치 순서가 곧 안전성이다) await 를 끼울 수 없다. */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { spawnSync(WIN ? "powershell" : "sh", WIN ? ["-NoProfile", "-Command", `Start-Sleep -Milliseconds ${ms}`] : ["-c", `sleep ${ms / 1000}`], { stdio: "ignore" }); }
}

/** 로그 꼬리 n줄 — 실패했을 때 "로그를 보세요" 대신 **로그를 보여준다**(그 한 번의 왕복이 사람의 하루를 먹는다). */
export function tailLines(text, n = 12) {
  return String(text || "").split(/\r?\n/).filter((l) => l.trim()).slice(-n);
}

/** 로그에서 **마지막으로 게이트웨이에 붙은 시각**(epoch ms) — 없으면 null. 순수.
 *  ⚠ 프로세스 존재로 판정하면 안 된다: 런처가 5초마다 되살리므로 **크래시 루프도 '실행 중'으로 보인다**.
 *   우리가 확인해야 하는 건 "떴다" 가 아니라 "붙었다" 다 — 그게 사용자가 관리탭에서 보는 축(online)이다.
 *   에이전트는 pino 로 한 줄 JSON 을 남긴다: {"level":30,"time":<ms>,...,"msg":"게이트웨이 연결됨"} */
export function lastConnectedAt(logText, marker = "게이트웨이 연결됨") {
  let t = null;
  for (const line of String(logText || "").split(/\r?\n/)) {
    if (!line.includes(marker)) continue;
    const m = line.match(/"time":(\d{10,})/);
    if (m) t = Number(m[1]);            // 마지막 것이 이긴다(로그는 append 라 뒤가 최신)
  }
  return t;
}

/** 기동 확인 후 **사실대로** 보고 — 초록 체크를 이미 찍었으니, 아니면 그 자리에서 취소한다. */
function reportAgentAlive(since = Date.now(), waitMs = 12_000, stepMs = 2_000) {
  const readLog = () => { try { return readFileSync(NODE_LOG, "utf8"); } catch { return ""; } };
  let log = "";
  for (let waited = 0; ; waited += stepMs) {
    log = readLog();
    const at = lastConnectedAt(log);
    if (at !== null && at >= since) { say(green("   ✓ 게이트웨이 연결 확인 — 지금 온라인입니다.")); return true; }
    if (waited >= waitMs) break;
    sleepSync(stepMs);
  }
  // 안 붙었다. 프로세스라도 살아 있나로 원인을 갈라준다(안 뜬 것 ≠ 떴는데 못 붙은 것 — 할 일이 다르다).
  const running = nodeStatus().running;
  say(yellow(`   ✗ 등록은 됐지만 ${Math.round(waitMs / 1000)}초 안에 게이트웨이에 붙지 않았습니다.`));
  say(dim(running === true ? "     (에이전트 프로세스는 있습니다 — 연결/인증 단계에서 막혔거나 크래시 루프입니다)"
    : running === false ? "     (에이전트 프로세스가 없습니다 — 런처가 즉시 죽었습니다)"
      : "     (프로세스 실행 여부는 확인하지 못했습니다)"));
  const tail = tailLines(log);
  if (tail.length) { say(dim("   ── 로그 꼬리 ──")); for (const l of tail) say(dim(`   ${l}`)); }
  else say(dim(`   로그가 비어 있습니다(${NODE_LOG}) — 런처 자체가 실행되지 않았습니다.`));
  say(dim("   당장 쓰려면: `lively node` (창을 열어둔 채 foreground 실행)"));
  return false;
}

// ── Windows 폴백 상시화(시작프로그램) — 작업 스케줄러를 못 쓰는 계정용(#1541 실측). ────────────
// 스케줄러 대비 잃는 것은 **로그인 전 기동** 하나뿐이다. 그건 관리자 권한이 필요하고, 사용자 홈·자격으로
//  도는 노드에겐 의미도 없다. 재시작 보장(런처 .cmd 의 루프)과 신원(그 사용자)은 그대로 유지된다.

/** 시작프로그램 폴더 — %APPDATA% 우선(로밍 프로필·리디렉션된 홈을 존중), 없으면 표준 경로로 파생. 순수.
 *  ⚠ pwin.join — muxCandidates 와 같은 이유다. mac/linux CI 에서 이 함수를 검증할 때 posix 구분자가 섞이면
 *   테스트가 '실제로 나가는 경로' 를 못 본다(Windows 분기는 CI 에서 한 번도 실행되지 않는다). */
export function winStartupDir(env = process.env, home = HOME) {
  const appData = env.APPDATA || pwin.join(home, "AppData", "Roaming");
  return pwin.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

/** 시작프로그램 런처(.vbs) — 런처 .cmd 를 **콘솔 창 없이** 띄운다. 순수.
 *  ⚠ .cmd 를 시작프로그램에 그대로 두면 로그인마다 검은 창이 뜨고, 사용자가 그 창을 닫으면 노드가 죽는다.
 *   Run 의 인자: (명령, 창모드 0=숨김, 대기여부 False=즉시 반환).
 *  ⚠ 본문은 ASCII 로만 — 경로만 유니코드일 수 있고, 그래서 파일은 UTF-16LE+BOM 으로 쓴다(한글 사용자명). */
export function winStartupVbs({ runnerCmd }) {
  const q = String(runnerCmd).replace(/"/g, '""');   // VBS 문자열 리터럴의 " 는 "" 로 이스케이프
  return [
    "' Lively node agent autostart - generated by `lively node --daemon`. Do not edit.",
    "' Registered here because Task Scheduler registration was denied for this account.",
    "' To stop: `lively node stop`",
    `CreateObject("WScript.Shell").Run """${q}""", 0, False`,
    "",
  ].join("\r\n");
}

/** 잔여 에이전트 회수 — stop 과 재등록이 **같은 자를 쓰게** 한다(둘이 갈리면 고아 프로세스가 남는다).
 *  ⚠ 순서: 런처(cmd)를 먼저 죽인다. 에이전트(node)만 죽이면 런처 루프가 5초 뒤 되살린다. */
function winKillAgentProcs() {
  const kill = (name, like) => spawnSync("powershell", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ` +
    `Where-Object { $_.CommandLine -like '${like}' } | ` +
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: "ignore" });
  kill("cmd.exe", "*node-agent-run.cmd*");
  kill("wscript.exe", `*${WIN_STARTUP_VBS}*`);
  kill("node.exe", "*node-agent*agent.mjs*");
}

// ── 노드 상태 (#1541 T4) ────────────────────────────────────────────────────
// 데스크톱 앱이 폴링할 축이다. 사람이 트레이에서 한 줄로 이해하는 건 "지금 도는가"이고, 버튼이 갈리는 건
//  "등록됐나 / 자동시작이 켜졌나" 다 — 그 셋을 따로 준다.
// ⚠ 파일 존재만 보면 **거짓말한다**: 데몬 등록이 남아 있어도 프로세스는 죽어 있을 수 있고(그게 정확히
//  #1541 §6-3 이 잡은 상황이다), 반대로 데몬 없이 foreground 로 도는 경우도 있다. 그래서 축을 나눈다.
//  registered = 등록(env 파일) · daemon = OS 데몬 등록 · running = 프로세스 실측.

/** 플랫폼별 데몬 아티팩트(파일 경로 또는 작업 이름) — 순수. Windows 분기는 CI 에서 안 도므로 목록을 못박는다. */
export function nodeDaemonArtifact(platform = process.platform, home = HOME, env = process.env) {
  // ⚠ 구분자는 **인자로 받은 platform** 을 따른다 — 호스트 join() 을 쓰면 안 된다. 이 함수는 platform 을
  //  파라미터로 받는 순수 함수인데 호스트 기본 join 은 '지금 도는 OS' 의 구분자를 쓰므로, Windows 에서
  //  nodeDaemonArtifact('darwin', …) 을 부르면 `\Users\…\Library\…` 를 돌려준다(윈도우 CI 에서 실제로 잡혔다).
  //  실기기에선 platform === process.platform 이라 안 드러나지만, 계약이 깨져 있으면 계약 테스트도 못 믿는다.
  if (platform === "darwin") return { kind: "file", path: pposix.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`) };
  if (platform === "linux") return { kind: "file", path: pposix.join(home, ".config", "systemd", "user", "lively-node-agent.service") };
  // Windows 는 **두 자리 중 하나**다 — 스케줄러가 거부된 계정은 시작프로그램으로 앉는다(#1541).
  //  둘 중 하나만 보면 "자동시작 꺼짐" 이라고 거짓말한다(폴백으로 설치된 PC 전부가 그렇게 보인다).
  if (platform === "win32") return { kind: "task", name: WIN_TASK_NAME, fallbackPath: pwin.join(winStartupDir(env, home), WIN_STARTUP_VBS) };
  return { kind: "none" };
}

/** '우리 에이전트가 도는가' 를 세는 명령 — 순수(실행은 nodeStatus 가 한다). */
export function nodeProcProbe(platform = process.platform) {
  if (platform === "win32") {
    // ⚠ `tasklist /IM node.exe` 는 사용자의 다른 Node 까지 센다 — 커맨드라인으로 우리 것만 고른다(stop 과 같은 자).
    return { cmd: "powershell", args: ["-NoProfile", "-Command",
      "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*node-agent*agent.mjs*' }).Count"] };
  }
  return { cmd: "pgrep", args: ["-f", "node-agent/agent.mjs"] };
}

/** 프로브 출력 → 실행 중 개수(순수). pgrep 은 pid 줄, PowerShell 은 숫자 한 줄. */
export function parseProcCount(platform, stdout, status) {
  const s = String(stdout || "").trim();
  if (platform === "win32") { const n = Number(s.split(/\r?\n/).filter(Boolean).pop()); return Number.isFinite(n) ? n : 0; }
  // pgrep 은 못 찾으면 exit 1 + 빈 출력 — 그걸 '모름' 이 아니라 0 으로 읽는다(찾았는데 못 셌으면 pid 가 나온다).
  if (status !== 0 && !s) return 0;
  return s.split(/\r?\n/).filter((l) => /^\d+$/.test(l.trim())).length;
}

/** 노드 상태 실측 — 앱·`status --json` 이 쓰는 단일 통로. 못 재는 축은 null(모르는 걸 false 로 눕히지 않는다). */
export function nodeStatus() {
  const artifact = nodeDaemonArtifact();
  const registered = existsSync(NODE_ENV_FILE);
  const out = {
    registered,
    bundled: existsSync(join(NODE_AGENT_DIR, "agent.mjs")),
    daemon: artifact.kind === "file" ? existsSync(artifact.path)
      : artifact.kind === "task" ? (winTaskExists() || (!!artifact.fallbackPath && existsSync(artifact.fallbackPath)))
        : false,
    running: null,
    id: registered ? readEnvFile(NODE_ENV_FILE, "LIVELY_NODE_ID") : null,
    gateway: registered ? readEnvFile(NODE_ENV_FILE, "LIVELY_GATEWAY_URL") : null,
  };
  try {
    const probe = nodeProcProbe();
    const r = spawnSync(probe.cmd, probe.args, { encoding: "utf8", timeout: 8000 });
    // 프로브 자체를 못 돌렸으면(명령 없음 등) **모름(null)** 이다 — 0 으로 적으면 "정지됨" 이라고 거짓말한다.
    out.running = r.error ? null : parseProcCount(process.platform, r.stdout, r.status) > 0;
  } catch { out.running = null; }
  return out;
}
function winTaskExists() {
  try { return spawnSync("schtasks", ["/Query", "/TN", WIN_TASK_NAME], { stdio: "ignore", timeout: 8000 }).status === 0; }
  catch { return false; }
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
  } else if (WIN) {
    // 폴백(시작프로그램)도 함께 걷는다 — **어느 쪽으로 앉았는지 모르고 stop 하기 때문**이다.
    //  한쪽만 지우면 "정지했다" 고 말해놓고 다음 로그인에 되살아난다(사용자는 우리가 거짓말했다고 느낀다).
    //  ⚠ 어느 쪽이었는지는 **지우기 전에** 재야 한다.
    const vbs = join(winStartupDir(), WIN_STARTUP_VBS);
    const hadTask = winTaskExists(), hadVbs = existsSync(vbs);
    // 순서가 중요하다: 실행 중인 인스턴스를 먼저 끝내고(/End) 지운다(/Delete). 반대로 하면 고아 프로세스가 남는다.
    spawnSync("schtasks", ["/End", "/TN", WIN_TASK_NAME], { stdio: "ignore" });
    spawnSync("schtasks", ["/Delete", "/TN", WIN_TASK_NAME, "/F"], { stdio: "ignore" });
    rmSync(vbs, { force: true });
    // 잔여 프로세스 회수 = POSIX 의 `pkill -f node-agent/agent.mjs` 대응물.
    //  ⚠ 순서가 또 중요하다: **런처(cmd)를 먼저** 죽여야 한다. 에이전트(node)만 죽이면 런처의 재시작 루프가
    //   5초 뒤 그대로 되살린다 — 그게 런처의 존재 이유다.
    //  ⚠ `taskkill /IM node.exe` 는 금지 — 사용자의 다른 Node 를 전부 죽인다. 커맨드라인으로 우리 것만 고른다
    //   (이 CLI 자신은 그 문자열이 없어 대상이 아니다).
    winKillAgentProcs();
    say(green(`✅ 노드 데몬 해제(${hadTask ? "작업 스케줄러" : hadVbs ? "시작프로그램" : "등록 없음 — 잔여 프로세스만 회수"})`));
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
