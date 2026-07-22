#!/usr/bin/env node
// 키트 자가 업데이터(#858) — 게이트웨이의 최신 키트를 백그라운드로 받아 **멱등 재설치**한다.
//
// 왜: 멤버 키트의 네 축 중 셋(회사맥락·런타임설정·하네스자산)은 이미 매 세션 라이브 동기화된다. 남은 하나
//  — **키트 코드(훅 .mjs)와 배선(settings.json·config.toml)** — 만 재설치가 필요해서, 훅을 하나 추가할 때마다
//  전원이 설치 한 줄을 손으로 돌려야 했다. 그 마지막 수동 단계를 없앤다.
//
// 모델(클로드 코드 오토업데이터와 동형 — code.claude.com/docs/en/setup):
//   체크 = 세션 시작(session-preload 가 kit_version 불일치를 보면 이 스크립트를 detached 로 띄운다)
//   설치 = 백그라운드(현재 세션 밖 — 세션은 즉시 진행한다)
//   적용 = **다음 세션**(하네스가 훅·설정을 세션 시작에 스냅샷하므로 자연히 그렇게 된다)
// 그래서 이 스크립트는 훅으로 배선되지 않는다 — session-preload 가 낳는 자식이다(직접 실행도 가능).
//
// 하는 일: /install 번들 다운로드 → **검증**(필수 파일 + node --check) → 번들 동봉 user-install.mjs 실행
//          (비파괴·멱등 — 백업 후 센티넬/‌dedup 머지) → ~/.lively/kit-version 스탬프 → 다음 세션 안내 1줄.
// MCP 등록(#862): **ADDITIVE reconcile 만** 한다 — 누락된 기대 서버(lively·lively-local·org)를 ~/.claude.json 에
//          직접 추가하되 **remove 는 절대 안 한다**(과거엔 비원자 remove→add 가 백그라운드 중간실패로 등록을
//          잃을 수 있어 아예 건너뛰었다 — additive 는 그 실패모드가 없어 안전). 기존 항목·유저 것은 불변.
//          claude 바이너리 비의존(claude mcp add 대신 그 파일을 직접 편집 → detached PATH 빈약해도 동작).
//          Codex 는 설치기가 config.toml 관리블록을 통째 갱신하므로 별도 불요(claude 전용 갭 해소).
//          한계: 이 reconcile 코드가 멤버에 먼저 배달돼야 도니 **새 서버는 다음 kit 업데이트에 등록**된다(1회 지연).
//
// 안전장치
//  · 락(O_EXCL)      — 동시 세션 N개가 떠도 업데이트는 한 번만(스테일 락 10분 후 회수).
//  · 백오프          — 같은 버전으로 실패했으면 6시간 안엔 재시도 안 함(게이트웨이·네트워크 두들기지 않음).
//  · 사전 검증       — 깨진 번들로 훅을 덮으면 전원 훅이 죽는다. 설치 전에 필수 파일 + 구문(node --check) 강제.
//  · 전 경로 fail-open — 어떤 실패든 exit 0, 기존 설치 그대로(마지막으로 성공한 키트가 계속 돈다).
// 끄기: LIVELY_OFF=1 · LIVELY_NO_AUTO_UPDATE=1 · 어드민 토글(hooks-config.json hooks.self_update === false)
// 토큰 값은 절대 출력/로깅하지 않는다.
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, rmSync,
  existsSync, statSync, openSync, closeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1") process.exit(0);
if (process.env.LIVELY_NO_AUTO_UPDATE === "1") process.exit(0);

const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
const CODEX_DIR = join(HOME, ".codex");

const LOCK = join(LIVELY, "update.lock");
const STATE = join(LIVELY, "update-state.json");
const STAMP = join(LIVELY, "kit-version");
const NOTICE = join(LIVELY, "update-notice");
const LOGF = join(LIVELY, "update.log");

const LOCK_STALE_MS = 10 * 60 * 1000;      // 죽은 프로세스가 남긴 락 회수 시점
const BACKOFF_MS = 6 * 60 * 60 * 1000;     // 같은 버전 실패 후 재시도 간격
const FETCH_MS = 60_000;                   // 번들 다운로드(백그라운드라 넉넉히)
const INSTALL_MS = 180_000;                // 설치기 상한
const LOG_MAX = 64 * 1024;                 // 로그 상한(넘으면 갈아엎음 — 무한증식 방지)

// 번들에 반드시 있어야 하는 러너(설치기 HOOK_SCRIPTS 와 동일 — 하나라도 없으면 그 번들은 설치하지 않는다).
//  self-update.mjs(자기 자신)는 여기 안 넣는다: 이 스크립트가 없는 구 게이트웨이 번들을 '손상'으로 오판하면
//  롤백(구버전 게이트웨이로 되돌림) 시 영영 못 도는 상태가 된다.
const REQUIRED_HOOKS = ["session-preload.mjs", "work-flag.mjs", "stop-writeback-gate.mjs", "run-custom.mjs", "sync-harness-assets.mjs"];

const argOf = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const readL = (rel) => { try { return readFileSync(join(LIVELY, rel), "utf8").trim() || null; } catch { return null; } };

// 0600 — 형제 상태파일(STAMP/STATE/NOTICE)과 동일. 설치기 stdout 을 그대로 싣기 때문에(토큰은 안 찍히지만)
//  world-readable 로 두지 않는다("토큰 값은 절대 출력/로깅하지 않는다" 불변식의 방어선).
function log(msg) {
  try {
    mkdirSync(LIVELY, { recursive: true });
    if (existsSync(LOGF) && statSync(LOGF).size > LOG_MAX) rmSync(LOGF, { force: true });
    appendFileSync(LOGF, `[${new Date().toISOString()}] ${msg}\n`, { mode: 0o600 });
  } catch { /* 로그 실패로 업데이트를 막지 않는다 */ }
}

// 어드민 토글 — hooks-config.json hooks.self_update === false 면 비활성(fail-open: 못 읽으면 활성).
function hookDisabled() {
  try {
    const c = JSON.parse(readFileSync(join(LIVELY, "hooks-config.json"), "utf8"));
    return !!(c && c.hooks && c.hooks.self_update === false);
  } catch { return false; }
}

// ── 락 — 원자(O_EXCL). 여러 세션이 동시에 떠도 업데이터는 하나만 돈다. ──
//  (멱등 가드로는 부족하다 — 두 프로세스가 같은 settings.json 을 read-modify-write 하면 한쪽 편집이 사라진다.)
function acquireLock() {
  try {
    mkdirSync(LIVELY, { recursive: true });
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) rmSync(LOCK, { force: true }); // 스테일 회수
    } catch { /* 락 없음 = 정상 */ }
    const fd = openSync(LOCK, "wx"); // 이미 있으면 EEXIST → 다른 세션이 진행 중
    try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
    return true;
  } catch { return false; }
}
const releaseLock = () => { try { rmSync(LOCK, { force: true }); } catch { /* */ } };

// ── 실패 백오프 상태 ──
const loadState = () => { try { const s = JSON.parse(readFileSync(STATE, "utf8")); return (s && typeof s === "object") ? s : {}; } catch { return {}; } };
const saveState = (s) => { try { writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 }); } catch { /* */ } };

// 설치된 하네스 — '무엇이 PATH 에 있나'가 아니라 **무엇에 lively 가 배선돼 있나**로 판정한다.
//  detached 자식은 PATH 가 빈약할 수 있어 command -v 류 탐지는 못 믿는다. 디스크의 배선이 진실이다.
function installedHarnesses() {
  const out = [];
  try { if (readFileSync(join(CLAUDE_DIR, "settings.json"), "utf8").includes(".lively/hooks/")) out.push("claude"); } catch { /* 미배선 */ }
  try { if (readFileSync(join(CODEX_DIR, "config.toml"), "utf8").includes("lively-managed")) out.push("codex"); } catch { /* 미배선 */ }
  if (!out.length) {
    const h = (argOf("--harness") || process.env.LIVELY_HARNESS || "").toLowerCase();
    if (h === "claude" || h === "codex") out.push(h); // 배선을 못 읽었지만 그 하네스 세션에서 불려왔다
  }
  return out;
}

// 게이트웨이가 서빙하는 최신 버전(직접 실행용 — session-preload 는 --to 로 넘겨줘 왕복을 아낀다).
async function fetchRemoteVersion(gw, token) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(`${gw}/api/ui/org/runtime-config`, { signal: ctl.signal, headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const j = await res.json();
    return (j && typeof j.kit_version === "string" && j.kit_version) ? j.kit_version : null;
  } catch { return null; }
  finally { clearTimeout(t); }
}

async function download(gw, token, dest) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const res = await fetch(`${gw}/install`, { signal: ctl.signal, headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`다운로드 실패 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error(`번들이 비정상적으로 작음(${buf.length}B)`);
    writeFileSync(dest, buf, { mode: 0o600 });
    return buf.length;
  } finally { clearTimeout(t); }
}

// 설치 전 검증 — **여기가 마지막 방어선**이다. 깨진/부분 번들로 ~/.lively/hooks 를 덮으면 그 멤버의 모든
//  세션에서 훅이 죽는다(맥락 미주입·게이트 무작동). 필수 파일 + 구문검사를 통과한 번들만 설치한다.
function verifyBundle(root) {
  const installer = join(root, "setup", "user-install.mjs");
  if (!existsSync(installer)) throw new Error("번들 손상 — setup/user-install.mjs 없음");
  const hooksDir = join(root, ".claude", "hooks");
  for (const f of REQUIRED_HOOKS) {
    const p = join(hooksDir, f);
    if (!existsSync(p)) throw new Error(`번들 손상 — .claude/hooks/${f} 없음`);
    if (statSync(p).size < 64) throw new Error(`번들 손상 — .claude/hooks/${f} 가 비어 있음`);
  }
  // 구문검사: 설치기 + **설치기가 실제로 복사하는 러너만**(REQUIRED_HOOKS + self-update). 디렉터리를 글롭하지
  //  않는다 — macOS 게이트웨이 번들엔 `._<name>` AppleDouble 쓰레기가 섞일 수 있는데(#858 회귀, tar/xattr),
  //  설치기는 명시된 이름만 복사하므로 그 쓰레기는 애초에 배포되지 않는다. 그걸 검사해 전체를 막는 건 과잉 차단이었다.
  //  (번들 자체를 깨끗하게 만드는 건 서버측 COPYFILE_DISABLE — 여기선 '설치될 파일'만 본다는 원칙으로 견고화.)
  const runners = [...REQUIRED_HOOKS, "self-update.mjs"].filter((f) => existsSync(join(hooksDir, f)));
  for (const p of [installer, ...runners.map((f) => join(hooksDir, f))]) {
    try { execFileSync(process.execPath, ["--check", p], { stdio: "ignore", timeout: 20_000 }); }
    catch { throw new Error(`번들 손상 — 구문 오류: ${p.replace(root, "")}`); }
  }
  return installer;
}

// #862 — claude mcp --scope user 가 쓰는 유저 설정 파일(mcpServers 를 담는 그 파일)을 찾는다.
//  CLAUDE_CONFIG_DIR 가 있으면 그 밑, 없으면 $HOME/.claude.json. 존재하는 것만 반환(없으면 null=미설치/타구조 → skip).
function claudeUserConfigPath() {
  const cands = [];
  if (process.env.CLAUDE_CONFIG_DIR) cands.push(join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"));
  cands.push(join(HOME, ".claude.json"));
  for (const c of cands) { try { if (existsSync(c)) return c; } catch { /* */ } }
  return null;
}

// #862 — Claude MCP 등록 ADDITIVE reconcile. 누락된 기대 서버만 ~/.claude.json 의 mcpServers 에 직접 추가한다.
//  ⚠ 절대 remove/overwrite 안 함: 있으면 손대지 않고(URL·토큰 변경은 명시적 lively update 몫), 없는 것만 add →
//   중간 실패로도 기존 등록 무손실(self-update 불변식). registerClaudeMcp(CLI)와 같은 서버 집합(lively·lively-local·org).
function reconcileClaudeMcp(gw, token) {
  const cj = claudeUserConfigPath();
  if (!cj) return; // claude 유저 설정 없음 — 손대지 않음
  let conf;
  try { conf = JSON.parse(readFileSync(cj, "utf8")); } catch { return; } // 파손/못읽음 → 안전 skip(덮어쓰지 않음)
  if (!conf || typeof conf !== "object" || Array.isArray(conf)) return;
  const servers = (conf.mcpServers && typeof conf.mcpServers === "object" && !Array.isArray(conf.mcpServers)) ? conf.mcpServers : {};
  const shim = join(LIVELY, "bin", process.platform === "win32" ? "lively.cmd" : "lively");
  // #1079 — lively 본체는 **로컬 stdio 프록시**(`lively mcp`)로 붙인다. http 직결이면 세션 시작 때 게이트웨이에
  //  못 닿을 경우(사내 게이트웨이 + VPN 미접속) 하네스가 failed 로 마킹하고 그 세션 내내 복구하지 않기 때문이다.
  //  프록시로 갈 수 있는 조건 — 둘 다 만족해야 한다(하나라도 아니면 종전 http 유지 = 무회귀):
  //   (a) 프록시 본체가 실제로 설치돼 있다(구버전 번들엔 없다. 없는데 stdio 로 등록하면 lively 가 통째로 안 뜬다)
  //   (b) 롤백 스위치가 꺼져 있다 — `echo http > ~/.lively/mcp-transport` 로 언제든 종전 방식으로 되돌린다
  const proxyPath = join(LIVELY, "lib", "lively-mcp-gateway.mjs");
  const canProxy = existsSync(proxyPath) && readL("mcp-transport") !== "http";
  const want = {};
  // ⚠ 헤더 세트는 register-clients.sh(scripts/·kit/setup/)·kit/cli/lively.mjs 와 **동일하게 유지**(lively.test.mjs ④ 가 4곳 parity 강제).
  //  값은 정적 리터럴(${LIVELY_*:-}, 비밀 아님) — 접속 시 하네스가 제 env 로 확장. Authorization(토큰)만 멤버 값이라 아래 reconcile 이 안 건드린다.
  //  (stdio 프록시로 가면 이 헤더들은 프록시가 상류 호출에 붙인다 — 같은 이름·같은 값, 출처만 설정→env/토큰파일.)
  want["lively"] = canProxy
    ? { type: "stdio", command: shim, args: ["mcp"], env: {} }
    : { type: "http", url: `${gw}/mcp`, headers: {
        Authorization: `Bearer ${token}`,
        "x-lively-session": "${LIVELY_SESSION_ID:-}",  // #852
        "x-lively-mode": "${LIVELY_MODE:-}",           // #1007+ 단일 실행모드 헤더(readonly|incognito) — 미래 모드도 재등록 불요
      } };
  want["lively-local"] = { type: "stdio", command: shim, args: ["mcp-local"], env: {} };
  // 조직 추가 MCP 서버(mcp-servers.json) — [] 또는 {servers:[]} 양식 모두 허용. enabled·name 있는 것만, additive.
  try {
    const raw = JSON.parse(readFileSync(join(LIVELY, "mcp-servers.json"), "utf8"));
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.servers) ? raw.servers : []);
    for (const s of list) {
      if (!s || s.enabled === false || !s.name || s.name === "lively") continue;
      if (s.transport === "stdio" && s.command) {
        const parts = String(s.command).trim().split(/\s+/).filter(Boolean);
        if (parts.length) want[s.name] = { type: "stdio", command: parts[0], args: parts.slice(1), env: {} };
      } else if (s.url) {
        const sec = s.auth_env ? (process.env[s.auth_env] || "") : "";
        want[s.name] = { type: "http", url: s.url, headers: sec ? { Authorization: `Bearer ${sec}` } : {} };
      }
    }
  } catch { /* 목록 없음/파손 — 무시 */ }
  let added = 0;
  for (const [name, entry] of Object.entries(want)) {
    const cur = servers[name];
    if (!cur) { servers[name] = entry; added++; log(`MCP additive 등록: ${name}`); continue; } // 없는 서버 = 통째로 add(종전)
    // #1079 — additive 무손실의 **유일한 예외**: 이미 있는 lively 를 http 직결 → stdio 프록시로 옮긴다.
    //  이건 '멤버 값 덮어쓰기'가 아니라 **우리가 심은 항목의 전송방식 교정**이다(같은 게이트웨이·같은 신원·같은 툴 이름).
    //  토큰은 설정에서 사라지고 ~/.lively/token 으로만 남는다(시크릿 노출면 축소). 되돌리려면 롤백 스위치(위 canProxy).
    if (name === "lively" && canProxy && cur.type !== "stdio") {
      servers[name] = entry; added++;
      log("MCP transport 마이그레이션: lively http 직결 → stdio 프록시(#1079, 다음 세션 적용)");
      continue;
    }
    // 이미 등록됨 — URL·토큰·기존 헤더는 **불변**(멤버 값 보존). 다만 **빠진 헤더 키만** 더한다(모드 헤더 등 새 배선을 재등록 없이 전파, 1세션 지연).
    //  remove/overwrite 를 안 하므로 무손실 불변식 유지. Authorization(토큰)은 절대 안 건드린다(멤버 값 — 값 변경은 명시적 lively update 몫).
    if (entry.headers && cur.headers && typeof cur.headers === "object" && !Array.isArray(cur.headers)) {
      for (const [hk, hv] of Object.entries(entry.headers)) {
        if (hk.toLowerCase() === "authorization") continue;
        if (!(hk in cur.headers)) { cur.headers[hk] = hv; added++; log(`MCP 헤더 additive: ${name}.${hk}`); }
      }
    }
  }
  if (!added) return; // 누락 0 → 파일 미변경(정상 세션 비용 0)
  conf.mcpServers = servers;
  try { writeFileSync(cj, JSON.stringify(conf, null, 2) + "\n"); log(`✓ claude MCP additive reconcile — ${added}건 (다음 세션 적용)`); }
  catch (e) { log(`MCP reconcile 쓰기 실패(무시): ${(e && e.message) || e}`); }
}

async function main() {
  if (hookDisabled()) return;

  const token = (process.env.LIVELY_TOKEN || "").trim() || readL("token");
  const gwRaw = (process.env.LIVELY_GATEWAY_URL || "").trim() || readL("gateway-url");
  if (!token || !gwRaw) return;                       // 미설치/무토큰 — 업데이트할 게 없다
  const gw = gwRaw.replace(/\/+$/, "").replace(/\/mcp$/, "");

  const target = argOf("--to") || await fetchRemoteVersion(gw, token);
  if (!target) return;                               // 게이트웨이가 버전을 안 줌(구버전/장애) → 무동작(fail-safe)
  const local = readL("kit-version");
  const forced = process.argv.includes("--force");
  if (!forced && local === target) return;           // 최신

  const harnesses = installedHarnesses();
  if (!harnesses.length) { log("설치된 하네스 배선을 못 찾음 — 건너뜀"); return; }

  // 백오프 — 같은 버전으로 최근에 실패했으면 쉬어간다(매 세션 다운로드 재시도로 게이트웨이를 두들기지 않게).
  const st = loadState();
  if (!forced && st.failed_version === target && typeof st.failed_at === "number" && Date.now() - st.failed_at < BACKOFF_MS) return;

  if (!acquireLock()) return;                        // 다른 세션이 이미 업데이트 중
  const tmp = mkdtempSync(join(tmpdir(), "lively-update-"));
  try {
    log(`업데이트 시작: ${local || "(스탬프 없음)"} → ${target} · harness=${harnesses.join(",")}`);
    const bytes = await download(gw, token, join(tmp, "bundle.tgz"));
    execFileSync("tar", ["-xzf", join(tmp, "bundle.tgz"), "-C", tmp], { stdio: "ignore", timeout: 60_000 });
    const installer = verifyBundle(tmp);
    log(`번들 검증 통과 (${(bytes / 1024).toFixed(0)} KiB)`);

    // 번들 동봉 설치기 — 비파괴(백업 후 센티넬/‌dedup 머지)·멱등. 이 안에서 ~/.lively/hooks/*, settings.json,
    //  codex config.toml, auto-approve, work-roots 가 최신 상태로 수렴한다.
    const out = execFileSync(process.execPath, [installer, "--clone-root", tmp, "--harness", harnesses.join(",")], {
      encoding: "utf8", timeout: INSTALL_MS, stdio: ["ignore", "pipe", "pipe"], env: process.env,
    });
    log(String(out || "").trim().split("\n").map((l) => "  " + l).join("\n"));

    // 스탬프 — 번들이 자기 버전을 들고 오면(신규 게이트웨이) 그걸 쓴다. 설치기가 이미 복사했더라도 멱등.
    let installed = target;
    try { installed = readFileSync(join(tmp, ".lively", "kit-version"), "utf8").trim() || target; } catch { /* 구 번들 → --to */ }
    writeFileSync(STAMP, installed + "\n", { mode: 0o600 });
    saveState({ ok_version: installed, ok_at: Date.now() });
    // #862 — 새 MCP 서버(lively-local 등)를 기존 멤버에게도 additive 등록(claude 전용; codex 는 설치기가 config.toml 로 처리).
    if (harnesses.includes("claude")) { try { reconcileClaudeMcp(gw, token); } catch (e) { log(`MCP reconcile 예외(무시): ${(e && e.message) || e}`); } }
    // 다음 세션에 한 번 알린다(그때는 이미 새 키트가 돌고 있다). session-preload 가 읽고 지운다.
    writeFileSync(NOTICE, `> 라이블리 키트가 자동으로 업데이트됐습니다(${installed}). 이번 세션부터 최신 훅·설정이 적용됩니다.`, { mode: 0o600 });
    log(`✓ 업데이트 완료 — ${installed} (다음 세션부터 적용)`);
  } catch (e) {
    // fail-open: 기존 설치는 그대로다(설치기가 비파괴·백업 기반). 다음 기회에 재시도한다.
    const msg = (e && e.message) ? e.message : String(e);
    saveState({ ...loadState(), failed_version: target, failed_at: Date.now(), failed_reason: msg.slice(0, 300) });
    log(`✗ 업데이트 실패(기존 키트 유지) — ${msg}`);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    releaseLock();
  }
}

try { await main(); } catch { /* fail-open */ }
process.exit(0);
