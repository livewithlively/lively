#!/usr/bin/env node
// codex 배선 사양테스트 — 불변식 "멤버 대상 기능은 Claude·Codex 양쪽에 같은 수준으로 배선된다"
//  ([[delivery-install-invariants]] ②)를 **실제 설치기를 돌려** 고정한다. 엣지 표는 프로젝트 #1475 사양의
//  15행이고, 아래 케이스 번호가 그 행 번호다(행 하나에 케이스 하나 — 빠진 행이 곧 못 잡는 버그다).
//  오프라인·fs-only: 샌드박스 HOME(LIVELY_HOME) 안에서만 읽고 쓴다. 실 ~/.codex 무접촉은 ⓪ 이 지문으로 못박는다.
//  실행: node kit/setup/codex-wiring.test.mjs   (kit/**/*.test.mjs 라 npm test 체인에 자동 포함)
//
//  왜 이 테스트인가: 코덱스 배선은 **한 파일(config.toml)의 텍스트 생성**이라 조용히 어긋난다. 이 테스트가
//   없던 동안 세 가지가 동시에 새 있었다 — ① 러너가 3개 이벤트에만 붙어 조직 거버넌스(PreToolUse)가 코덱스엔
//   전무 ② #1221 세션 실행단계 보고가 어댑터에만 들어가 실배포 설치기엔 누락 ③ 추가 stdio MCP 를 배열 command 로
//   써서 조직에 stdio 서버가 하나라도 생기면 config.toml **전체**가 로드 실패(= 코덱스 배선 통째 사망).
//   그래서 ⑧ 은 "무엇이 있나"가 아니라 **"클로드에 있는 것이 코덱스에도 있나"** 로 쓴다 — claude 쪽에 이벤트를
//   추가하면서 codex 를 안 챙기면 여기서 깨진다.
import { mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = mkdtempSync(join(tmpdir(), "codex-wiring-test-"));
const BUNDLE = join(SANDBOX, "bundle");
const HOME = join(SANDBOX, "home");
const CODEX_CFG = join(HOME, ".codex", "config.toml");
const LEGACY_HOOKS = join(HOME, ".codex", "hooks.json");
const LEGACY_BACKUPS = join(HOME, ".lively", "backups");
const CODEX_POLICY = join(HOME, ".lively", "codex-account.json");
const CODEX_AGENTS = join(HOME, ".codex", "AGENTS.md");

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };
const bad = (name, why) => { fail++; console.error(`FAIL ${name} — ${why}`); };
const digest = (p) => { try { return createHash("sha256").update(readFileSync(p)).digest("hex") + ":" + statSync(p).mode; } catch { return "(none)"; } };

// ⓪ 배선 단언 — 이 테스트가 **실 홈을 안 건드린다**는 것 자체를 지문으로 확인한다(마지막에 재검).
//  이게 없으면 샌드박스 계약이 깨졌을 때 테스트는 통과하면서 개발자의 진짜 codex 설정을 갈아엎는다.
const REAL_CODEX_CFG = join(homedir(), ".codex", "config.toml");
const REAL_BEFORE = digest(REAL_CODEX_CFG);

// ── 발행물 번들 구성(generator/build-context.mjs publish() 의 배치를 최소 재현) ──────────────
// 번들에 넣을 훅 파일 목록은 **설치기의 정본을 따른다**(사본을 두지 않는다 — 훅이 하나 늘 때 여기가 빠지면
//  이 테스트가 "발행물에 훅 누락"으로 죽는다). DIRECT_RUN 가드가 있어 import 해도 설치는 돌지 않는다.
//  ⚠ pathToFileURL 필수 — ESM 의 dynamic import 는 인자를 **URL 로** 해석해서, 윈도우 절대경로(`C:\…`)는
//   드라이브문자가 스킴으로 오해돼 ERR_UNSUPPORTED_ESM_URL_SCHEME 로 죽는다(mac/linux 에선 우연히 통과한다).
const { HOOK_SCRIPTS: HOOKS } = await import(pathToFileURL(join(KIT, "setup", "user-install.mjs")).href);
// 번들 setup/ 목록은 매니페스트 단일 출처를 따른다 — 사본을 두면 파일이 하나 늘 때 여기만 빠져
//  "설치기가 번들 안에서 import 크래시" 로 죽는다(kit-manifest.SETUP_FILES 주석 참조).
const { SETUP_FILES } = await import(pathToFileURL(join(KIT, "setup", "kit-manifest.mjs")).href);
function makeBundle({ withCli = true, mcpServers = [], autoApprove = ["mcp__lively__whoami", "mcp__lively-local__lively_local_repo_list"] } = {}) {
  rmSync(BUNDLE, { recursive: true, force: true });
  mkdirSync(join(BUNDLE, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(BUNDLE, ".lively"), { recursive: true });
  mkdirSync(join(BUNDLE, "setup"), { recursive: true });
  for (const h of HOOKS) cpSync(join(KIT, "hooks", h), join(BUNDLE, ".claude", "hooks", h));
  for (const f of SETUP_FILES) {
    cpSync(join(KIT, "setup", f), join(BUNDLE, "setup", f));
  }
  if (withCli) { // stdio 프록시 판정에 필요한 둘(+CLI 본체). 없으면 http 폴백 경로가 된다 = 엣지 ②
    mkdirSync(join(BUNDLE, "cli"), { recursive: true });
    for (const f of ["lively.mjs", "lively-mcp-gateway.mjs"]) cpSync(join(KIT, "cli", f), join(BUNDLE, "cli", f));
  }
  writeFileSync(join(BUNDLE, ".lively-org-name"), "테스트조직\n");
  writeFileSync(join(BUNDLE, ".lively", "auto-approve.json"), JSON.stringify({ allow: autoApprove }));
  writeFileSync(join(BUNDLE, ".lively", "mcp-servers.json"), JSON.stringify({ servers: mcpServers }));
}

function freshHome({ userConfig = null, transport = null, auth = { tokens: { account_id: "acct-enrolled-test" } }, agents = null } = {}) {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, ".lively"), { recursive: true });
  writeFileSync(join(HOME, ".lively", "gateway-url"), "http://localhost:8080\n"); // 토큰 없음 = 네트워크 미접촉
  if (transport) writeFileSync(join(HOME, ".lively", "mcp-transport"), transport + "\n");
  if (userConfig !== null) {
    mkdirSync(join(HOME, ".codex"), { recursive: true });
    writeFileSync(CODEX_CFG, userConfig);
  }
  if (auth !== null || agents !== null) mkdirSync(join(HOME, ".codex"), { recursive: true });
  if (auth !== null) writeFileSync(join(HOME, ".codex", "auth.json"), JSON.stringify(auth));
  if (agents !== null) writeFileSync(CODEX_AGENTS, agents);
}
function runInstall() {
  const r = spawnSync(process.execPath, [join(BUNDLE, "setup", "user-install.mjs"), "--harness", "codex", "--clone-root", BUNDLE],
    { env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`설치기 exit=${r.status}\n${r.stderr || r.stdout}`);
  if (!existsSync(CODEX_CFG)) throw new Error("설치기가 샌드박스에 config.toml 을 안 만들었다(샌드박스 계약 파손)");
  return readFileSync(CODEX_CFG, "utf8");
}
const install = (opts) => { freshHome(opts); return runInstall(); };
const writeLegacy = (value) => {
  mkdirSync(dirname(LEGACY_HOOKS), { recursive: true });
  writeFileSync(LEGACY_HOOKS, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
};
const legacyBackups = () => existsSync(LEGACY_BACKUPS)
  ? readdirSync(LEGACY_BACKUPS)
    .filter((name) => /^hooks\.json\.codex\.(?:orig|bak)$/.test(name))
    .map((name) => join(LEGACY_BACKUPS, name))
  : [];

// config.toml 의 훅 핸들러 파싱 — 한 벌은 `[[hooks.<E>]]`(+matcher) + `[[hooks.<E>.hooks]]`(+command) 두 테이블이라
//  **command 를 든 쪽**(`.hooks`)에서 이벤트를 읽는다. 핸들러 없는 헤더 블록은 세지 않는다(엔트리 = 실제 실행 단위).
function hookEntries(toml) {
  const out = [];
  for (const blk of toml.split(/\n(?=\[\[hooks\.)/)) {
    const ev = /^\[\[hooks\.([A-Za-z]+)(?:\.hooks)?\]\]/.exec(blk);
    if (!ev) continue;
    const cm = /\n[ \t]*command[ \t]*=[ \t]*("(?:[^"\\]|\\.)*")/.exec(blk);
    if (!cm) continue;
    let command = ""; try { command = JSON.parse(cm[1]); } catch { command = cm[1]; }
    const tm = /\n[ \t]*timeout[ \t]*=[ \t]*(\d+)/.exec(blk);
    out.push({ event: ev[1], command, timeout: tm ? Number(tm[1]) : null });
  }
  return out;
}
// [mcp_servers.<name>] 블록의 키만 뽑는다(다음 테이블 헤더 전까지).
function serverBlock(toml, name) {
  const re = new RegExp(`\\[mcp_servers\\.${name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`);
  const m = re.exec(toml);
  return m ? m[1] : null;
}
const scriptOf = (cmd) => [...cmd.matchAll(/[/\\]([\w-]+\.mjs)/g)].map((m) => m[1]).find((n) => n !== "codex-account-gate.mjs") || "";
const runnerEventOf = (e) => (e.command.includes("run-custom.mjs") ? (/run-custom\.mjs"?\s+"?([A-Za-z]+)/.exec(e.command) || [])[1] : null);

// ── ① 프록시 있음 → stdio 실행 + 하네스 stamp ───────────────────────────────
//  http 직결이면 codex 의 http_headers 가 정적값이라 세션 식별(#852)·실행모드(#1007)를 영영 못 보낸다.
makeBundle();
let toml = install();
{
  const b = serverBlock(toml, "lively") || "";
  const cmd = /^command = "[^"]*node"$/m.test(b);
  const args = /^args = \[.*codex-account-gate\.mjs.*"--".*lively(?:\.cmd)?.*"mcp"\]$/m.test(b);
  const noUrl = !/^url = /m.test(b);
  // stamp 가 없으면 게이트웨이가 코덱스 세션을 claude 로 집계한다(프록시 UA 기본값이 claude-code).
  const stamp = /\[mcp_servers\.lively\.env\]\s*\nLIVELY_HARNESS = "codex"/.test(toml);
  cmd && args && noUrl && stamp ? ok("① 프록시 있음 → stdio 실행 + LIVELY_HARNESS stamp")
    : bad("① stdio 프록시", `command=${cmd} args=${args} noUrl=${noUrl} stamp=${stamp}`);
}

// 계정 정책은 최초 등록 계정 지문만 0600으로 고정하고 재설치가 현재 계정으로 갈아끼우지 않는다.
{
  const before = readFileSync(CODEX_POLICY, "utf8");
  const mode = statSync(CODEX_POLICY).mode & 0o777;
  writeFileSync(join(HOME, ".codex", "auth.json"), JSON.stringify({ tokens: { account_id: "acct-other-test" } }));
  runInstall();
  const after = readFileSync(CODEX_POLICY, "utf8");
  (process.platform === "win32" || mode === 0o600) && before === after && !before.includes("acct-enrolled-test")
    ? ok("①b 계정 정책 0600 · 원문 미저장 · 재설치 자동 덮어쓰기 없음")
    : bad("①b 계정 정책", `mode=${mode.toString(8)} stable=${before === after} raw=${before.includes("acct-enrolled-test")}`);
}

// 글로벌 정적 주입은 다른 계정으로 전환한 뒤에도 읽히므로 제거하며, 사용자 지침은 보존한다.
{
  const managed = '<!-- >>> lively-managed org-context (auto-generated by workflow-std — do not edit) >>> -->\n제한된 조직 맥락\n<!-- <<< lively-managed <<< -->';
  install({ agents: `내 사용자 규칙\n\n${managed}\n` });
  const got = readFileSync(CODEX_AGENTS, "utf8");
  got.includes("내 사용자 규칙") && !got.includes("제한된 조직 맥락") && !got.includes("lively-managed org-context")
    ? ok("①c AGENTS.md 기존 org-context 제거 · 사용자 지침 보존 · 재주입 없음")
    : bad("①c AGENTS 정리", got);
}

// 관리 블록은 EOF에 append되므로 begin-only면 뒤는 옛 조직 컨텍스트다. 백업 후 fail-closed 제거한다.
{
  const broken = '내 사용자 규칙은 반드시 남아야 한다\n\n<!-- >>> lively-managed org-context (auto-generated by workflow-std — do not edit) >>> -->\n회사 비밀 맥락\n';
  install({ agents: broken });
  const got = readFileSync(CODEX_AGENTS, "utf8");
  const backup = readFileSync(join(HOME, ".lively", "backups", "codex-AGENTS.md.bak"), "utf8");
  got.includes("내 사용자 규칙은 반드시 남아야 한다") && !got.includes("회사 비밀 맥락") && backup === broken
    ? ok("①d AGENTS.md begin-only 손상 → EOF 조직 맥락 제거 · 원본 백업")
    : bad("①d AGENTS 손상 복구", got);
}

// 파괴적 정리 전 백업이 안 되면 원본을 그대로 두고 설치를 실패시킨다.
{
  makeBundle({ withCli: false });
  const broken = '내 사용자 규칙\n\n<!-- >>> lively-managed org-context (auto-generated by workflow-std — do not edit) >>> -->\n회사 비밀 맥락\n';
  freshHome({ agents: broken });
  writeFileSync(join(HOME, ".lively", "backups"), "not-a-directory");
  const r = spawnSync(process.execPath, [join(BUNDLE, "setup", "user-install.mjs"), "--harness", "codex", "--clone-root", BUNDLE],
    { env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME }, encoding: "utf8" });
  const unchanged = readFileSync(CODEX_AGENTS, "utf8") === broken;
  r.status !== 0 && unchanged && /AGENTS\.md 백업 실패/.test(`${r.stdout}${r.stderr}`)
    ? ok("①e AGENTS.md 백업 실패 → 원본 무변경 · 설치 명확히 실패")
    : bad("①e AGENTS 백업 게이트", `exit=${r.status} unchanged=${unchanged} out=${`${r.stdout}${r.stderr}`.slice(0, 160)}`);
}

// 로그인 정보가 없으면 설치 자체는 완료하되 정책을 만들지 않아 wrapper가 fail-closed하며, 그 사실을 명확히 알린다.
{
  makeBundle();
  freshHome({ auth: null });
  const r = spawnSync(process.execPath, [join(BUNDLE, "setup", "user-install.mjs"), "--harness", "codex", "--clone-root", BUNDLE],
    { env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME }, encoding: "utf8" });
  const warned = /fail-closed/.test(`${r.stdout || ""}${r.stderr || ""}`);
  const gated = existsSync(join(HOME, ".lively", "lib", "codex-account-gate.mjs"));
  r.status === 0 && warned && gated && !existsSync(CODEX_POLICY)
    ? ok("①d auth 누락 → 정책 미생성 · 명확한 경고 · wrapper 설치(fail-closed)")
    : bad("①d auth 누락", `exit=${r.status} warned=${warned} gated=${gated} policy=${existsSync(CODEX_POLICY)}`);
}

// 별도 Codex 프로필을 쓰는 머신에서는 그 프로필의 auth/config/AGENTS가 설치와 런타임의 같은 경계다.
{
  makeBundle(); freshHome({ auth: null });
  const profile = join(HOME, "profiles", "enrolled-codex");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "auth.json"), JSON.stringify({ tokens: { account_id: "profile-enrolled" } }));
  const r = spawnSync(process.execPath, [join(BUNDLE, "setup", "user-install.mjs"), "--harness", "codex", "--clone-root", BUNDLE],
    { env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME, CODEX_HOME: profile }, encoding: "utf8" });
  const profileCfg = existsSync(join(profile, "config.toml")) ? readFileSync(join(profile, "config.toml"), "utf8") : "";
  const passesHome = /env_vars = \[[^\n]*"CODEX_HOME"/.test(profileCfg);
  r.status === 0 && existsSync(CODEX_POLICY) && /codex-account-gate\.mjs/.test(profileCfg) && passesHome && !existsSync(CODEX_CFG)
    ? ok("①e CODEX_HOME 프로필에 정책·gated 배선 설치 + MCP 환경 전달")
    : bad("①e CODEX_HOME", `exit=${r.status} policy=${existsSync(CODEX_POLICY)} cfg=${!!profileCfg} env=${passesHome} default=${existsSync(CODEX_CFG)}`);
}

// ── ⑦ 세션 실행단계 보고 5축 ────────────────────────────────────────────────
//  코덱스엔 Notification 이 없어 '확인 필요'는 PermissionRequest 가 대신한다(work-flag.reportedPhase 와 짝).
{
  const evs = new Set(hookEntries(toml).filter((e) => scriptOf(e.command) === "work-flag.mjs").map((e) => e.event));
  const want = ["SessionStart", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "Stop"];
  const missing = want.filter((e) => !evs.has(e));
  missing.length === 0 ? ok(`⑦ 세션 실행단계 보고 5축(${want.join("·")})`) : bad("⑦ work-flag 배선", `누락: ${missing.join(",")}`);
}

// ── ⑧ 하네스 패리티 — claude 러너 이벤트 중 codex 지원분은 **전부** ─────────
{
  const { runnerHooksBlock } = await import("./user-install.mjs");
  // codex 미지원 — Notification 뿐(#1884 실측: SessionEnd 는 0.149.1 부터 발화, 0.142 는 키를 무시). 지원 목록이 바뀌면 여기만 고친다.
  const CODEX_UNSUPPORTED = new Set(["Notification"]);
  const wantEvents = Object.keys(runnerHooksBlock()).filter((e) => !CODEX_UNSUPPORTED.has(e));
  const got = new Set(hookEntries(toml).map(runnerEventOf).filter(Boolean));
  const missing = wantEvents.filter((e) => !got.has(e));
  const hasPreToolUse = got.has("PreToolUse"); // 거버넌스의 핵심 — 이게 빠지면 코덱스는 무규제다
  missing.length === 0 && hasPreToolUse
    ? ok(`⑧ 러너 이벤트 패리티(claude ∩ codex = ${wantEvents.length}개, PreToolUse 포함)`)
    : bad("⑧ 러너 패리티", `codex 에 안 붙은 이벤트: ${missing.join(",") || "(없음)"} preToolUse=${hasPreToolUse}`);
}

// ── ⑰ 기록 fork·기록 넛지 엔트리는 관리블록 **맨 끝** (#4217·#4219) ─────────────────
//  codex 훅 신뢰 키가 `<config.toml>:<event>:<그룹 순번>:<핸들러 순번>` 이라(codex-rs hooks/src/lib.rs hook_key) 새 엔트리를 기존
//  엔트리 사이에 끼우면 뒤 엔트리의 순번이 밀려 멤버가 신뢰해 둔 훅이 전부 조용히 «미신뢰»가 된다. 주석만으론 못 지킨다 — 여기서 못박는다.
{
  const block = toml.slice(toml.indexOf("# >>> lively-managed"), toml.indexOf("# <<< lively-managed"));
  const groups = block.split(/\n(?=\[\[hooks\.[A-Za-z]+\]\])/).slice(1).map((g) => ({
    event: /^\[\[hooks\.([A-Za-z]+)\]\]/.exec(g)[1],
    matcher: (/\nmatcher = ("(?:[^"\\]|\\.)*")/.exec(g) || [])[1] ? JSON.parse(/\nmatcher = ("(?:[^"\\]|\\.)*")/.exec(g)[1]) : null,
    wf: /work-flag\.mjs/.test(g),
  }));
  const tail = groups.slice(-3).map((g) => `${g.event}:${g.matcher ?? "-"}:${g.wf ? "wf" : "x"}`);
  const want = ["PostToolUse:spawn_agent|collaborationspawn_agent:wf", "SubagentStop:-:wf", "SessionStart:compact:wf"];
  const compactOnce = groups.filter((g) => g.event === "SessionStart" && g.matcher === "compact").length === 1;
  JSON.stringify(tail) === JSON.stringify(want) && compactOnce
    ? ok("⑰ #4217·#4219 엔트리가 관리블록 맨 끝(기존 엔트리 신뢰 순번 유지) · SessionStart compact 1개")
    : bad("⑰ 새 엔트리 위치", `끝 3개=${JSON.stringify(tail)} compactOnce=${compactOnce}`);
}

// ── ⑨ codex 가 모르는 이벤트는 배선하지 않는다 ──────────────────────────────
{
  const evs = new Set(hookEntries(toml).map((e) => e.event));
  const strays = ["Notification"].filter((e) => evs.has(e));
  strays.length === 0 ? ok("⑨ codex 미지원 이벤트 미배선(Notification)") : bad("⑨ 미지원 이벤트", `배선됨: ${strays.join(",")}`);
  // #1884 — SessionEnd 는 이제 배선 대상(work-flag 종료 보고 #1059 + 러너). timeout 은 codex 클램프 상한(3s) 이하여야 한다.
  const se = hookEntries(toml).filter((e) => e.event === "SessionEnd");
  const seOk = se.length >= 2 && se.every((e) => Number(e.timeout) <= 3);
  seOk ? ok(`⑨b SessionEnd 배선(work-flag+러너, timeout≤3s) — ${se.length}개`) : bad("⑨b SessionEnd 배선", JSON.stringify(se));
  // #1884 — lively-local(로컬 조작 MCP) 도 codex 에 심는다(stdio 경로일 때 — 이 번들은 CLI 동봉이라 stdio).
  /\[mcp_servers\.lively-local\]\s*\ncommand = "[^"]+"\s*\nargs = \[.*codex-account-gate\.mjs.*"--".*lively(?:\.cmd)?.*"mcp-local"\]/.test(toml)
    ? ok("⑨c lively-local stdio MCP 등록") : bad("⑨c lively-local", "config.toml 에 [mcp_servers.lively-local] 없음");
  // ⑨d (#4135, 2026-09-28) — codex 는 MCP 서버에 제 환경을 물려주지 않는다(실측 0.157.1). 세션이 누구 것인지(LIVELY_SESSION_ID)와
  //  세션을 연 사람의 신원(LIVELY_MCP_TOKEN)이 프록시에 닿으려면 env_vars 로 이름을 넘겨야 한다 — 빠지면 공용 컴퓨터의 codex 세션이
  //  컴퓨터를 등록한 사람 이름으로 기록을 남긴다. 두 서버 모두, 제 테이블 안에(하위 테이블 [..env] 보다 앞에) 있어야 TOML 이 맞다.
  {
    const block = (name) => { const m = new RegExp(`\\[mcp_servers\\.${name}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`).exec(toml); return m ? m[1] : ""; };
    const need = ["LIVELY_SESSION_ID", "LIVELY_MCP_TOKEN"];
    const has = (name) => { const l = /^env_vars = (\[.*\])$/m.exec(block(name)); if (!l) return false; try { const a = JSON.parse(l[1]); return need.every((n) => a.includes(n)) && !a.includes("LIVELY_TOKEN"); } catch { return false; } };
    has("lively") && has("lively-local")
      ? ok("⑨d MCP 서버에 세션 환경을 넘긴다(env_vars: 세션 id · 세션 신원 — 훅 토큰은 제외)")
      : bad("⑨d env_vars", `lively=${has("lively")} lively-local=${has("lively-local")}`);
  }
}

// ── ⑬ auto-approve 목록 반영 ────────────────────────────────────────────────
{
  const core = /\[mcp_servers\.lively\.tools\.whoami\]\s*\napproval_mode = "approve"/.test(toml);
  const local = /\[mcp_servers\.lively-local\.tools\.lively_local_repo_list\]\s*\napproval_mode = "approve"/.test(toml);
  core && local ? ok("⑬ auto-approve → lively·lively-local 툴별 승인 표시") : bad("⑬ auto-approve", `lively=${core} lively-local=${local}`);
}

// ── ② 프록시 없음(구버전 번들) → HTTP로 우회하지 않고 fail-closed ──────────
makeBundle({ withCli: false });
{
  const t = install();
  const b = serverBlock(t, "lively");
  const absent = b === null;
  const noHttp = !/^url = /m.test(t);
  const noOrphanCoreApproval = !/\[mcp_servers\.lively\.tools\./.test(t);
  const noOrphanLocalApproval = !/\[mcp_servers\.lively-local\.tools\./.test(t);
  const gateProbe = spawnSync(process.execPath, [join(HOME, ".lively", "lib", "codex-account-gate.mjs")],
    { env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME }, encoding: "utf8" });
  const gateLoads = gateProbe.status === 0 && !/ERR_MODULE_NOT_FOUND/.test(gateProbe.stderr || "");
  absent && noHttp && noOrphanCoreApproval && noOrphanLocalApproval && gateLoads ? ok("② 프록시 부재 → MCP 미등록 + gate import 가능(fail-closed)")
    : bad("② HTTP 금지", `absent=${absent} noHttp=${noHttp} core고아승인=${!noOrphanCoreApproval} local고아승인=${!noOrphanLocalApproval} gateLoads=${gateLoads}`);
}

// ── ③ 옛 롤백 스위치도 account gate를 우회 못 함 ───────────────────────────
makeBundle();
{
  const t = install({ transport: "http" });
  const b = serverBlock(t, "lively") || "";
  /^command = /m.test(b) && !/^url = /m.test(b) && /codex-account-gate\.mjs/.test(b)
    ? ok("③ mcp-transport=http 무시 → gated stdio 강제") : bad("③ gated stdio 강제", b.slice(0, 160));
}

// ── ④ 추가 stdio MCP(인자 있는 명령) ────────────────────────────────────────
//  ⚠ 회귀 방지: 배열을 command 에 넣으면 codex 가 `invalid type: sequence, expected a string` 로
//   **config.toml 전체**를 못 읽는다 → [mcp_servers.lively]·[hooks.*] 까지 동반 사망.
makeBundle({ mcpServers: [{ name: "acme-local", transport: "stdio", command: "acme mcp-local", enabled: true }] });
{
  const t = install();
  const b = serverBlock(t, "acme-local") || "";
  const shape = /^command = "[^"]*node[^"]*"$/m.test(b)
    && /^args = \["[^"]*codex-account-gate\.mjs",\s*"--",\s*"acme",\s*"mcp-local"\]$/m.test(b)
    && /^env_vars = \[.*"CODEX_HOME".*\]$/m.test(b);
  const noArrayCmd = !/command = \[/.test(t);
  shape && noArrayCmd ? ok("④ 추가 stdio MCP → account gate 뒤 command+args") : bad("④ stdio MCP 형식", `shape=${shape} noArrayCmd=${noArrayCmd} · ${b.slice(0, 200)}`);
}

// ── ④c 추가 stdio MCP도 custom CODEX_HOME의 계정으로 판정 ──────────────────
{
  const target = join(SANDBOX, "org-mcp-target.mjs");
  const marker = join(SANDBOX, "org-mcp-ran");
  writeFileSync(target, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  makeBundle({ mcpServers: [{ name: "org-extra", transport: "stdio", command: `${process.execPath} ${target}`, enabled: true }] });
  const t = install();
  const companyId = "acct-company-test";
  writeFileSync(join(HOME, ".codex", "auth.json"), JSON.stringify({ tokens: { account_id: companyId } }));
  writeFileSync(CODEX_POLICY, JSON.stringify({ version: 1, account_fingerprint: createHash("sha256").update(companyId).digest("hex") }));
  const b = serverBlock(t, "org-extra") || "";
  const command = JSON.parse(/^command = (.+)$/m.exec(b)?.[1] || '""');
  const args = JSON.parse(/^args = (.+)$/m.exec(b)?.[1] || "[]");
  const commonEnv = {
    ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME,
    CODEX_HOME: join(HOME, ".codex"), LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox",
  };
  const company = spawnSync(command, args, { env: commonEnv, encoding: "utf8" });
  const companyRan = company.status === 0 && existsSync(marker);
  rmSync(marker, { force: true });
  const alternate = join(SANDBOX, "personal-codex-home");
  mkdirSync(alternate, { recursive: true });
  writeFileSync(join(alternate, "auth.json"), JSON.stringify({ tokens: { account_id: "acct-personal-test" } }));
  const personal = spawnSync(command, args, { env: { ...commonEnv, CODEX_HOME: alternate }, encoding: "utf8" });
  const profileForwarded = /^env_vars = \[.*"CODEX_HOME".*\]$/m.test(b);
  companyRan && personal.status === 0 && !existsSync(marker) && profileForwarded
    ? ok("④c 추가 stdio MCP → default 회사 허용 · custom CODEX_HOME 개인 차단")
    : bad("④c 추가 MCP 프로필 경계", `company=${company.status}/${companyRan}/${(company.stderr || "").slice(0, 160)} personal=${personal.status}/${existsSync(marker)}/${(personal.stderr || "").slice(0, 160)} env=${profileForwarded} args=${JSON.stringify(args).slice(0, 240)}`);
}

// ── ④b 조직 MCP 에 lively-local 을 수동 등록해 둔 박스(#1884 이전 우회로) → 테이블 중복 0 ───────
//  TOML 은 같은 테이블이 두 번이면 **파일 전체** 로드 실패 = 코덱스 배선 전멸. 네이티브 블록이 정본이고 조직 항목은 건너뛴다.
makeBundle({ mcpServers: [{ name: "lively-local", transport: "stdio", command: "lively mcp-local", enabled: true }, { name: "lively", transport: "http", url: "https://x.example/mcp", enabled: true }] });
{
  const t = install();
  const nLocal = (t.match(/^\[mcp_servers\.lively-local\]$/gm) || []).length;
  const nLively = (t.match(/^\[mcp_servers\.lively\]$/gm) || []).length;
  nLocal === 1 && nLively === 1 ? ok("④b 예약 이름(lively·lively-local) 조직 등록 → 네이티브 블록만(중복 테이블 0)") : bad("④b 예약 이름 중복", `lively-local=${nLocal} lively=${nLively}`);
}

// ── ⑤ 인자 **없는** 명령(경계) → args 항목 없음 ────────────────────────────
makeBundle({ mcpServers: [{ name: "solo", transport: "stdio", command: "solo-server", enabled: true }] });
{
  const b = serverBlock(install(), "solo") || "";
  /^command = "[^"]*node[^"]*"$/m.test(b)
    && /^args = \["[^"]*codex-account-gate\.mjs",\s*"--",\s*"solo-server"\]$/m.test(b)
    ? ok("⑤ 인자 없는 stdio 명령도 account gate 뒤 실행") : bad("⑤ 단일 토큰 command", b.slice(0, 200));
}

// ── ⑥ 추가 http MCP는 로컬 gate 경계가 없어 미등록 ─────────────────────────
makeBundle({ mcpServers: [{ name: "extsrv", transport: "http", url: "https://x.example/mcp", auth_env: "EXT_TOKEN", enabled: true }] });
{
  const b = serverBlock(install(), "extsrv");
  b === null ? ok("⑥ 추가 http MCP → 미등록(fail-closed)") : bad("⑥ http MCP", b.slice(0, 120));
}

// ── ⑭ auto-approve 빈 목록(부재 엣지) → 표시 0개, 설치는 정상 ──────────────
makeBundle({ autoApprove: [] });
{
  const t = install();
  const n = (t.match(/approval_mode = "approve"/g) || []).length;
  const alive = /\[mcp_servers\.lively\]/.test(t) && hookEntries(t).length > 0;
  n === 0 && alive ? ok("⑭ auto-approve 빈 목록 → 승인 표시 0, 배선은 정상") : bad("⑭ 빈 auto-approve", `n=${n} alive=${alive}`);
}

// ── ⑰ retired ~/.codex/hooks.json 정리 ──────────────────────────────────────
// 공개 설치기를 블랙박스로 호출한다. 이전 세대 run-custom 이 남으면 Codex 가 Claude 형식 raw text 를
// hook JSON 으로 해석해 세션을 깨뜨리므로, config.toml 과 같은 설치 트랜잭션에서 정리되어야 한다.
makeBundle();
{
  const original = {
    version: 1,
    hooks: {
      UserPromptSubmit: [
        { matcher: "*", hooks: [
          { type: "command", command: "node ~/.lively/hooks/run-custom.mjs UserPromptSubmit" },
          { type: "command", command: "node \"C:/Profiles/Jane Doe/.lively/hooks/run-custom.mjs\" UserPromptSubmit" },
          { type: "command", command: "node ~/.lively/hooks/not-in-manifest.mjs UserPromptSubmit" },
          { type: "command", command: "node ~/.lively/hooks/self-update.mjs" },
          { type: "command", command: "node ~/.lively/hooks/harness-registry.mjs" },
          { type: "future", command: "node ~/.lively/hooks/work-flag.mjs" },
          { type: "command", command: "echo ~/.lively/hooks/work-flag.mjs" },
          { type: "command", command: "node ~/.lively/hooks/work-flag.mjs && echo member-tail" },
          { type: "command", command: "echo member-handler" },
        ] },
        { matcher: "managed-only", hooks: [{ type: "command", command: "node ~/.lively/hooks/work-flag.mjs" }] },
        { matcher: "empty-user", hooks: [], metadata: { keep: true } },
      ],
      Stop: [{ matcher: "managed-only", hooks: [{ type: "command", command: "node ~/.lively/hooks/run-custom.mjs Stop" }] }],
      FutureEvent: [{ matcher: "*", hooks: [{ type: "command", command: "echo future-user-handler" }] }],
      EmptyEvent: [{ matcher: "empty-user", hooks: [], metadata: { keep: true } }],
      EmptyArrayEvent: [],
    },
  };
  freshHome(); writeLegacy(original);
  const before = readFileSync(LEGACY_HOOKS, "utf8");
  runInstall();
  const after = JSON.parse(readFileSync(LEGACY_HOOKS, "utf8"));
  const shared = after.hooks?.UserPromptSubmit?.find((g) => g.matcher === "*")?.hooks || [];
  const sharedCommands = shared.map((h) => h.command);
  const ownsGone = !sharedCommands.includes("node ~/.lively/hooks/run-custom.mjs UserPromptSubmit")
    && !sharedCommands.includes('node "C:/Profiles/Jane Doe/.lively/hooks/run-custom.mjs" UserPromptSubmit');
  const preserves = after.version === 1
    && sharedCommands.includes("node ~/.lively/hooks/not-in-manifest.mjs UserPromptSubmit")
    && sharedCommands.includes("node ~/.lively/hooks/self-update.mjs")
    && sharedCommands.includes("node ~/.lively/hooks/harness-registry.mjs")
    && shared.some((h) => h.type === "future" && h.command === "node ~/.lively/hooks/work-flag.mjs")
    && sharedCommands.includes("echo ~/.lively/hooks/work-flag.mjs")
    && sharedCommands.includes("node ~/.lively/hooks/work-flag.mjs && echo member-tail")
    && sharedCommands.includes("echo member-handler")
    && after.hooks?.FutureEvent?.[0]?.hooks?.[0]?.command === "echo future-user-handler";
  const emptyUser = after.hooks?.UserPromptSubmit?.find((g) => g.matcher === "empty-user");
  const pruned = after.hooks?.UserPromptSubmit?.length === 2
    && emptyUser?.hooks?.length === 0 && emptyUser?.metadata?.keep === true
    && after.hooks?.EmptyEvent?.[0]?.metadata?.keep === true
    && Array.isArray(after.hooks?.EmptyArrayEvent) && after.hooks.EmptyArrayEvent.length === 0
    && !Object.hasOwn(after.hooks || {}, "Stop");
  const backups = legacyBackups();
  const backedUp = backups.length >= 2 && backups.every((p) => readFileSync(p, "utf8") === before);
  ownsGone && preserves && pruned && backedUp
    ? ok("⑰ legacy 혼합 그룹은 owned만 제거·빈 그룹/이벤트 정리·원본/latest 백업")
    : bad("⑰ legacy hooks 정리", `owned=${ownsGone} preserves=${preserves} pruned=${pruned} userGroups=${after.hooks?.UserPromptSubmit?.length} stop=${Object.hasOwn(after.hooks || {}, "Stop")} backups=${backups.length}`);

  const once = digest(LEGACY_HOOKS);
  runInstall();
  digest(LEGACY_HOOKS) === once
    ? ok("⑰b legacy hooks 재설치 멱등(두 번째 실행은 파일 무변경)")
    : bad("⑰b legacy hooks 멱등", "두 번째 실행이 정리된 hooks.json 을 다시 변경함");
}

// ── ⑱ legacy 파일을 읽을 수 없는 모양이면 건드리지 않고 새 배선은 계속 ────────
makeBundle();
for (const [label, contents] of [
  ["부재", null],
  ["malformed JSON", "{ broken"],
  ["unrelated shape", JSON.stringify({ hooks: "not-an-event-map", version: 7 })],
]) {
  freshHome();
  if (contents !== null) writeLegacy(contents);
  const before = existsSync(LEGACY_HOOKS) ? readFileSync(LEGACY_HOOKS, "utf8") : null;
  let installed = false;
  try { runInstall(); installed = existsSync(CODEX_CFG) && /lively-managed/.test(readFileSync(CODEX_CFG, "utf8")); } catch { /* assertion below */ }
  const unchanged = before === null ? !existsSync(LEGACY_HOOKS) : readFileSync(LEGACY_HOOKS, "utf8") === before;
  installed && unchanged
    ? ok(`⑱ legacy ${label} → 무변경, config.toml 배선 계속`)
    : bad(`⑱ legacy ${label}`, `installed=${installed} unchanged=${unchanged}`);
}

// ── ⑲ 게이트 없는 사용자 config 충돌은 실패로 멈추고, legacy cleanup 도 앞서지 않는다 ──
makeBundle();
{
  const conflictingConfig = '[mcp_servers.lively]\ncommand = "member-lively"\n';
  const legacy = { hooks: { UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: "node ~/.lively/hooks/run-custom.mjs UserPromptSubmit" }] }] } };
  freshHome({ userConfig: conflictingConfig }); writeLegacy(legacy);
  const legacyBefore = readFileSync(LEGACY_HOOKS, "utf8");
  let exited = 0;
  try { runInstall(); } catch { exited = 1; }
  const configUnclaimed = readFileSync(CODEX_CFG, "utf8") === conflictingConfig;
  const legacyUnchanged = readFileSync(LEGACY_HOOKS, "utf8") === legacyBefore;
  exited === 1 && configUnclaimed && legacyUnchanged
    ? ok("⑲ 게이트 없는 config 충돌 → 명확히 실패 + 사용자 설정·legacy hooks 보존")
    : bad("⑲ config 충돌 안전정지", `exit=${exited} configUnclaimed=${configUnclaimed} legacyUnchanged=${legacyUnchanged}`);
}

// ── ⑩⑪ 비파괴 머지 + 재설치 멱등 ──────────────────────────────────────────
makeBundle();
const USER_CFG = 'model = "gpt-5.5"\n\n[tui]\ntheme = "one-half-light"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo mine"\n';
toml = install({ userConfig: USER_CFG });
const once = toml;
toml = runInstall(); toml = runInstall();
{
  const keeps = /^model = "gpt-5\.5"$/m.test(toml) && /theme = "one-half-light"/.test(toml) && /command = "echo mine"/.test(toml);
  keeps ? ok("⑩ 멤버 기존 설정(모델·테마·자기 훅) 보존") : bad("⑩ 비파괴", "사용자 키 유실");
  const sentinels = (toml.match(/^# >>> lively-managed/gm) || []).length;
  const stable = hookEntries(once).length === hookEntries(toml).length;
  sentinels === 1 && stable ? ok("⑪ 재설치 3회 멱등(관리 블록 1, 엔트리 수 불변)") : bad("⑪ 멱등", `sentinels=${sentinels} stable=${stable}`);
}

// ── ⑫ 제거 라운드트립 ──────────────────────────────────────────────────────
{
  const r = spawnSync(process.execPath, [join(BUNDLE, "setup", "user-uninstall.mjs"), "--harness", "codex", "--yes"],
    { env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME }, encoding: "utf8" });
  const after = existsSync(CODEX_CFG) ? readFileSync(CODEX_CFG, "utf8") : "";
  const clean = !/lively-managed/.test(after) && !/mcp_servers\.lively/.test(after);
  const keeps = /model = "gpt-5\.5"/.test(after) && /command = "echo mine"/.test(after);
  r.status === 0 && clean && keeps ? ok("⑫ 제거 → 관리 블록만 제거, 멤버 설정 복구") : bad("⑫ 제거 라운드트립", `exit=${r.status} clean=${clean} keeps=${keeps}`);
}

// ── ⑮ 실제 codex 로 로드 검증(있을 때만 — CI/리눅스 박스엔 없다) ───────────
//  정적 단언은 "그렇게 생겼나"까지만 본다. 돌릴 수 있는 곳에선 파서에게 직접 묻는다
//  (delivery-install-invariants ⑥ 의 검증 규율과 같은 이유 — 이 결함군은 눈으로는 안 보인다).
makeBundle({ mcpServers: [{ name: "lively-local", transport: "stdio", command: "lively mcp-local", enabled: true }] });
install({ userConfig: USER_CFG });
{
  const probe = spawnSync("codex", ["mcp", "list"], { env: { ...process.env, ...offlineLivelyEnv(), CODEX_HOME: join(HOME, ".codex") }, encoding: "utf8" });
  if (probe.error) {
    console.log("skip ⑮ codex 미설치 — 실파싱 검증 생략(정적 단언만)");
  } else {
    const out = `${probe.stdout || ""}${probe.stderr || ""}`;
    const loaded = !/failed to load configuration/i.test(out) && /lively/.test(out);
    loaded ? ok("⑮ 실제 codex 가 config.toml 을 로드하고 lively 서버 인식") : bad("⑮ codex 실파싱", out.split("\n").slice(0, 6).join(" | "));
  }
}

// ── ⑯ 설치기가 옛 버전이 남긴 깨진 윈도우 경로를 **자가치유**한다 ─────────────
//  writable_roots 에 이스케이프 없이 박힌 윈도우 경로 한 줄이 config.toml 전체를 못 읽게 만든다(= codex 미기동).
//  그 줄을 쓰는 쪽(work.mjs·project-provision.ts)만 고치면 **프로젝트를 실행할 때만** 복구돼, 키트를 업데이트해도
//  안 고쳐진다(윈도우 실기기 실측). 설치기는 자동 업데이트가 매번 돌리는 유일한 경로라 여기서 복구해야 한다.
makeBundle();
{
  const BROKEN = 'model = "gpt-5.5"\n\n[sandbox_workspace_write]\n# lively: 프로젝트 59 레포\nwritable_roots = ["C:\\Users\\amorite\\context-ontology"]\n';
  const t = install({ userConfig: BROKEN });
  const fixed = t.includes('"C:\\\\Users\\\\amorite\\\\context-ontology"');
  const noRaw = !t.includes('["C:\\Users\\amorite\\context-ontology"]');
  const keeps = /^model = "gpt-5\.5"$/m.test(t);          // 사용자 다른 줄은 그대로
  fixed && noRaw && keeps
    ? ok("⑯ 설치 시 깨진 writable_roots 자가치유(사용자 다른 줄 보존)")
    : bad("⑯ 자가치유", `fixed=${fixed} noRaw=${noRaw} keeps=${keeps}`);
  // 멱등 — 재설치해도 백슬래시가 더 늘지 않는다.
  const again = runInstall();
  again.includes('"C:\\\\Users\\\\amorite\\\\context-ontology"') && !again.includes("\\\\\\\\Users")
    ? ok("⑯b 재설치 멱등(이중 이스케이프 없음)") : bad("⑯b 멱등", "백슬래시가 늘어난다");
}

// ⓪ 재검 — 실 홈이 그대로인가(테스트가 관측 장치 없이 통과하는 걸 막는 배선 단언).
digest(REAL_CODEX_CFG) === REAL_BEFORE ? ok("⓪ 실 ~/.codex/config.toml 무접촉(지문 동일)") : bad("⓪ 샌드박스 계약", "실 홈이 변경됐다");

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
