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
// 안 하는 일: **MCP 클라이언트 재등록(claude mcp remove/add)**. remove→add 가 원자적이지 않아, 백그라운드에서
//          중간에 실패하면 멤버의 lively MCP 등록이 사라진다. 되돌리기 어려운 건 명시적 설치/업데이트
//          (setup-mac.sh)의 몫으로 남긴다. → org MCP 서버 **목록 변경**은 Codex(config.toml 센티넬 통째 교체)엔
//          자동 반영되지만 Claude 쪽 `claude mcp add` 는 수동 업데이트가 필요하다(알려진 한계).
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
