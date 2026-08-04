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
import { mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = mkdtempSync(join(tmpdir(), "codex-wiring-test-"));
const BUNDLE = join(SANDBOX, "bundle");
const HOME = join(SANDBOX, "home");
const CODEX_CFG = join(HOME, ".codex", "config.toml");

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
function makeBundle({ withCli = true, mcpServers = [], autoApprove = ["mcp__lively__whoami"] } = {}) {
  rmSync(BUNDLE, { recursive: true, force: true });
  mkdirSync(join(BUNDLE, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(BUNDLE, ".lively"), { recursive: true });
  mkdirSync(join(BUNDLE, "setup"), { recursive: true });
  for (const h of HOOKS) cpSync(join(KIT, "hooks", h), join(BUNDLE, ".claude", "hooks", h));
  for (const f of ["user-install.mjs", "user-uninstall.mjs", "work.mjs", "work-roots-header.mjs"]) {
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

function freshHome({ userConfig = null, transport = null } = {}) {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, ".lively"), { recursive: true });
  writeFileSync(join(HOME, ".lively", "gateway-url"), "http://localhost:8080\n"); // 토큰 없음 = 네트워크 미접촉
  if (transport) writeFileSync(join(HOME, ".lively", "mcp-transport"), transport + "\n");
  if (userConfig !== null) {
    mkdirSync(join(HOME, ".codex"), { recursive: true });
    writeFileSync(CODEX_CFG, userConfig);
  }
}
function runInstall() {
  const r = spawnSync(process.execPath, [join(BUNDLE, "setup", "user-install.mjs"), "--harness", "codex", "--clone-root", BUNDLE],
    { env: { ...process.env, LIVELY_HOME: HOME }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`설치기 exit=${r.status}\n${r.stderr || r.stdout}`);
  if (!existsSync(CODEX_CFG)) throw new Error("설치기가 샌드박스에 config.toml 을 안 만들었다(샌드박스 계약 파손)");
  return readFileSync(CODEX_CFG, "utf8");
}
const install = (opts) => { freshHome(opts); return runInstall(); };

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
    out.push({ event: ev[1], command });
  }
  return out;
}
// [mcp_servers.<name>] 블록의 키만 뽑는다(다음 테이블 헤더 전까지).
function serverBlock(toml, name) {
  const re = new RegExp(`\\[mcp_servers\\.${name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`);
  const m = re.exec(toml);
  return m ? m[1] : null;
}
const scriptOf = (cmd) => (/[/\\]([\w-]+\.mjs)/.exec(cmd) || [])[1] || "";
const runnerEventOf = (e) => (e.command.includes("run-custom.mjs") ? (/run-custom\.mjs"?\s+([A-Za-z]+)/.exec(e.command) || [])[1] : null);

// ── ① 프록시 있음 → stdio 실행 + 하네스 stamp ───────────────────────────────
//  http 직결이면 codex 의 http_headers 가 정적값이라 세션 식별(#852)·실행모드(#1007)를 영영 못 보낸다.
makeBundle();
let toml = install();
{
  const b = serverBlock(toml, "lively") || "";
  const cmd = /^command = "[^"]*lively(\.cmd)?"$/m.test(b);
  const args = /^args = \["mcp"\]$/m.test(b);
  const noUrl = !/^url = /m.test(b);
  // stamp 가 없으면 게이트웨이가 코덱스 세션을 claude 로 집계한다(프록시 UA 기본값이 claude-code).
  const stamp = /\[mcp_servers\.lively\.env\]\s*\nLIVELY_HARNESS = "codex"/.test(toml);
  cmd && args && noUrl && stamp ? ok("① 프록시 있음 → stdio 실행 + LIVELY_HARNESS stamp")
    : bad("① stdio 프록시", `command=${cmd} args=${args} noUrl=${noUrl} stamp=${stamp}`);
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
  // codex 0.142.0 미지원(바이너리 실측: SessionEnd·Notification 문자열 부재). 지원 목록이 바뀌면 여기만 고친다.
  const CODEX_UNSUPPORTED = new Set(["SessionEnd", "Notification"]);
  const wantEvents = Object.keys(runnerHooksBlock()).filter((e) => !CODEX_UNSUPPORTED.has(e));
  const got = new Set(hookEntries(toml).map(runnerEventOf).filter(Boolean));
  const missing = wantEvents.filter((e) => !got.has(e));
  const hasPreToolUse = got.has("PreToolUse"); // 거버넌스의 핵심 — 이게 빠지면 코덱스는 무규제다
  missing.length === 0 && hasPreToolUse
    ? ok(`⑧ 러너 이벤트 패리티(claude ∩ codex = ${wantEvents.length}개, PreToolUse 포함)`)
    : bad("⑧ 러너 패리티", `codex 에 안 붙은 이벤트: ${missing.join(",") || "(없음)"} preToolUse=${hasPreToolUse}`);
}

// ── ⑨ codex 가 모르는 이벤트는 배선하지 않는다 ──────────────────────────────
{
  const evs = new Set(hookEntries(toml).map((e) => e.event));
  const strays = ["SessionEnd", "Notification"].filter((e) => evs.has(e));
  strays.length === 0 ? ok("⑨ codex 미지원 이벤트 미배선(SessionEnd·Notification)") : bad("⑨ 미지원 이벤트", `배선됨: ${strays.join(",")}`);
}

// ── ⑬ auto-approve 목록 반영 ────────────────────────────────────────────────
{
  const has = /\[mcp_servers\.lively\.tools\.whoami\]\s*\napproval_mode = "approve"/.test(toml);
  has ? ok("⑬ auto-approve → 툴별 승인 표시") : bad("⑬ auto-approve", "표시 없음");
}

// ── ② 프록시 없음(구버전 번들) → http 직결 폴백 ────────────────────────────
makeBundle({ withCli: false });
{
  const t = install();
  const b = serverBlock(t, "lively") || "";
  const url = /^url = "http:\/\/localhost:8080\/mcp"$/m.test(b);
  const tok = /^bearer_token_env_var = "LIVELY_TOKEN"$/m.test(b);
  const stamp = /\[mcp_servers\.lively\.http_headers\]\s*\nx-lively-harness = "codex"/.test(t);
  const noCmd = !/^command = /m.test(b);
  url && tok && stamp && noCmd ? ok("② 프록시 부재 → http 직결 + 정적 harness 헤더")
    : bad("② http 폴백", `url=${url} tok=${tok} stamp=${stamp} noCmd=${noCmd}`);
}

// ── ③ 롤백 스위치(mcp-transport=http) — 프록시가 있어도 http ────────────────
makeBundle();
{
  const t = install({ transport: "http" });
  const b = serverBlock(t, "lively") || "";
  /^url = /m.test(b) && !/^command = /m.test(b) ? ok("③ 롤백 스위치 → http 직결") : bad("③ 롤백 스위치", b.slice(0, 120));
}

// ── ④ 추가 stdio MCP(인자 있는 명령) ────────────────────────────────────────
//  ⚠ 회귀 방지: 배열을 command 에 넣으면 codex 가 `invalid type: sequence, expected a string` 로
//   **config.toml 전체**를 못 읽는다 → [mcp_servers.lively]·[hooks.*] 까지 동반 사망.
makeBundle({ mcpServers: [{ name: "lively-local", transport: "stdio", command: "lively mcp-local", enabled: true }] });
{
  const t = install();
  const b = serverBlock(t, "lively-local") || "";
  const shape = /^command = "lively"$/m.test(b) && /^args = \["mcp-local"\]$/m.test(b);
  const noArrayCmd = !/command = \[/.test(t);
  shape && noArrayCmd ? ok("④ 추가 stdio MCP → command=문자열 + args=배열") : bad("④ stdio MCP 형식", `shape=${shape} noArrayCmd=${noArrayCmd} · ${b.slice(0, 120)}`);
}

// ── ⑤ 인자 **없는** 명령(경계) → args 항목 없음 ────────────────────────────
makeBundle({ mcpServers: [{ name: "solo", transport: "stdio", command: "solo-server", enabled: true }] });
{
  const b = serverBlock(install(), "solo") || "";
  /^command = "solo-server"$/m.test(b) && !/^args = /m.test(b)
    ? ok("⑤ 인자 없는 stdio 명령 → args 생략") : bad("⑤ 단일 토큰 command", b.slice(0, 120));
}

// ── ⑥ 추가 http MCP + 인증 env ─────────────────────────────────────────────
makeBundle({ mcpServers: [{ name: "extsrv", transport: "http", url: "https://x.example/mcp", auth_env: "EXT_TOKEN", enabled: true }] });
{
  const b = serverBlock(install(), "extsrv") || "";
  /^url = "https:\/\/x\.example\/mcp"$/m.test(b) && /^bearer_token_env_var = "EXT_TOKEN"$/m.test(b)
    ? ok("⑥ 추가 http MCP → url + 토큰 env 간접참조") : bad("⑥ http MCP", b.slice(0, 120));
}

// ── ⑭ auto-approve 빈 목록(부재 엣지) → 표시 0개, 설치는 정상 ──────────────
makeBundle({ autoApprove: [] });
{
  const t = install();
  const n = (t.match(/approval_mode = "approve"/g) || []).length;
  const alive = /\[mcp_servers\.lively\]/.test(t) && hookEntries(t).length > 0;
  n === 0 && alive ? ok("⑭ auto-approve 빈 목록 → 승인 표시 0, 배선은 정상") : bad("⑭ 빈 auto-approve", `n=${n} alive=${alive}`);
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
    { env: { ...process.env, LIVELY_HOME: HOME }, encoding: "utf8" });
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
  const probe = spawnSync("codex", ["mcp", "list"], { env: { ...process.env, CODEX_HOME: join(HOME, ".codex") }, encoding: "utf8" });
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
