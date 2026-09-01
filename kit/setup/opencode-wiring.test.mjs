#!/usr/bin/env node
// opencode 배선 사양테스트 — [[delivery-install-invariants]] 의 **비파괴·멱등·라운드트립**을 opencode 에
//  적용해 고정한다. codex 판(codex-wiring.test.mjs)과 같은 구조: 실제 설치기/제거기를 돌려 산출 파일을 본다.
//  오프라인·fs-only: 샌드박스 HOME(LIVELY_HOME) 안에서만 읽고 쓴다. 실 홈 무접촉은 ⓪ 이 지문으로 못박는다.
//  실행: node kit/setup/opencode-wiring.test.mjs   (kit/**/*.test.mjs 라 npm test 체인에 자동 포함)
//
//  왜 이 테스트인가 — 지금까지 opencode 는 **설치 방향만** 검증돼 있었다. 되돌리는 쪽(제거)과 반복 실행
//   (멱등)은 사고가 조용히 쌓이는 자리다: 제거가 사용자 키를 함께 지우면 그건 데이터 손실이고, 설치가
//   멱등이 아니면 자동 업데이트가 돌 때마다 항목이 누적된다(claude 에서 실제로 겪은 15→30 사고와 같은 부류).
//
//  엣지 표(W1~W12)는 <스크래치패드>/spec-opencode-wiring.md — 케이스 이름의 [W#] 가 그 행 번호다.
import { mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = mkdtempSync(join(tmpdir(), "opencode-wiring-test-"));
const BUNDLE = join(SANDBOX, "bundle");
const HOME = join(SANDBOX, "home");
const OC = join(HOME, ".config", "opencode");
const CFG = join(OC, "opencode.json");
const PLUGIN = join(OC, "plugin", "lively.js");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const digest = (p) => { try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return "(none)"; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

// ⓪ 배선 단언 [W11] — 실 홈 무접촉. XDG 경로도 함께 본다(그쪽이 이 계열의 사각지대였다).
const REAL = [join(homedir(), ".config", "opencode")];
if (process.env.XDG_CONFIG_HOME) REAL.push(join(process.env.XDG_CONFIG_HOME, "opencode"));
const realFingerprint = () => REAL.map((p) => (existsSync(p) ? String(statSync(p).mtimeMs) : "(none)")).join("|");
const REAL_BEFORE = realFingerprint();

// ── 발행물 번들(publish() 배치 최소 재현) ────────────────────────────────────
//  ⚠ pathToFileURL 필수 — ESM dynamic import 는 인자를 URL 로 해석해서 윈도우 절대경로가 죽는다.
const { HOOK_SCRIPTS: HOOKS } = await import(pathToFileURL(join(KIT, "setup", "user-install.mjs")).href);
// 번들 setup/ 목록은 매니페스트 단일 출처를 따른다 — 사본을 두면 파일이 하나 늘 때 여기만 빠져
//  "설치기가 번들 안에서 import 크래시" 로 죽는다(kit-manifest.SETUP_FILES 주석 참조).
const { SETUP_FILES } = await import(pathToFileURL(join(KIT, "setup", "kit-manifest.mjs")).href);
function makeBundle({ autoApprove = ["mcp__lively__whoami", "mcp__lively__knowledge_get"], withAdapter = true } = {}) {
  rmSync(BUNDLE, { recursive: true, force: true });
  mkdirSync(join(BUNDLE, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(BUNDLE, ".lively"), { recursive: true });
  mkdirSync(join(BUNDLE, "setup"), { recursive: true });
  mkdirSync(join(BUNDLE, "cli"), { recursive: true });
  for (const h of HOOKS) {
    if (!withAdapter && h === "opencode-plugin.js") continue;   // [W10] 구버전 번들 흉내
    cpSync(join(KIT, "hooks", h), join(BUNDLE, ".claude", "hooks", h));
  }
  for (const f of SETUP_FILES) cpSync(join(KIT, "setup", f), join(BUNDLE, "setup", f));
  for (const f of ["lively.mjs", "lively-mcp-gateway.mjs"]) cpSync(join(KIT, "cli", f), join(BUNDLE, "cli", f));
  writeFileSync(join(BUNDLE, ".lively-org-name"), "테스트조직\n");
  writeFileSync(join(BUNDLE, ".lively", "auto-approve.json"), JSON.stringify({ allow: autoApprove }));
  writeFileSync(join(BUNDLE, ".lively", "mcp-servers.json"), JSON.stringify({ servers: [] }));
}
function freshHome({ userConfig = null, userPlugin = null, agents = null } = {}) {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, ".lively"), { recursive: true });
  writeFileSync(join(HOME, ".lively", "gateway-url"), "http://127.0.0.1:9\n"); // 토큰 없음 = 네트워크 미접촉
  if (userConfig !== null) { mkdirSync(OC, { recursive: true }); writeFileSync(join(OC, userConfig.name), userConfig.body); }
  if (userPlugin !== null) { mkdirSync(join(OC, "plugin"), { recursive: true }); writeFileSync(join(OC, "plugin", userPlugin.name), userPlugin.body); }
  if (agents !== null) { mkdirSync(OC, { recursive: true }); writeFileSync(join(OC, "AGENTS.md"), agents); }
}
function install() {
  const r = spawnSync(process.execPath, [join(BUNDLE, "setup", "user-install.mjs"), "--harness", "opencode", "--clone-root", BUNDLE],
    { env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`설치기 exit=${r.status}\n${r.stderr || r.stdout}`);
  return `${r.stdout}${r.stderr}`;
}
function uninstall({ dry = false } = {}) {
  const args = [join(KIT, "adapters", "opencode", "uninstall.mjs")];
  if (dry) args.push("--dry-run");
  const r = spawnSync(process.execPath, args, { env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME }, encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
}

// ── W1 기본 설치 ─────────────────────────────────────────────────────────────
makeBundle();
freshHome();
install();
{
  const cfg = readJson(CFG);
  const okMcp = cfg?.mcp?.lively?.type === "local" && Array.isArray(cfg.mcp.lively.command) && cfg.mcp.lively.environment?.LIVELY_HARNESS === "opencode";
  const okPerm = cfg?.permission?.lively_whoami === "allow" && cfg?.permission?.lively_knowledge_get === "allow";
  existsSync(PLUGIN) && okMcp && okPerm
    ? ok("W1 설치 → 어댑터 + mcp.lively(type/command배열/env) + permission(lively_*)")
    : bad("W1 기본 설치", `plugin=${existsSync(PLUGIN)} mcp=${okMcp} perm=${okPerm}`);
}

// ── W2 멱등 — 두 번째 설치가 첫 번째와 **바이트 동일** ───────────────────────
{
  const before = [digest(CFG), digest(PLUGIN)].join("|");
  install();
  const after = [digest(CFG), digest(PLUGIN)].join("|");
  const cfg = readJson(CFG);
  const permCount = Object.keys(cfg?.permission ?? {}).length;
  before === after && permCount === 2
    ? ok("W2 설치 멱등(2회 실행 결과 바이트 동일 · 항목 누적 없음)")
    : bad("W2 멱등", `동일=${before === after} permission=${permCount}개(기대 2)`);
}

// ── W3/W4 사용자 키·플러그인 보존 ───────────────────────────────────────────
{
  makeBundle();
  freshHome({
    userConfig: { name: "opencode.json", body: JSON.stringify({ model: "anthropic/x", mcp: { mine: { type: "local", command: ["echo"] } }, permission: { bash: "ask" }, theme: "dark" }, null, 2) },
    userPlugin: { name: "my-plugin.js", body: "export const Mine = async () => ({});\n" },
  });
  const userPluginDigest = digest(join(OC, "plugin", "my-plugin.js"));
  install();
  const cfg = readJson(CFG);
  const kept = cfg?.model === "anthropic/x" && cfg?.mcp?.mine?.command?.[0] === "echo" && cfg?.permission?.bash === "ask" && cfg?.theme === "dark";
  const added = !!cfg?.mcp?.lively && cfg?.permission?.lively_whoami === "allow";
  kept && added ? ok("W3 사용자 키(model·다른 mcp·본인 permission·theme) 보존 + 우리 키만 추가")
    : bad("W3 사용자 키 보존", `보존=${kept} 추가=${added}`);
  digest(join(OC, "plugin", "my-plugin.js")) === userPluginDigest
    ? ok("W4 사용자 플러그인 불가침") : bad("W4 사용자 플러그인", "변경됨");
}

// ── W5 제거 — 우리 것만 사라지고 사용자 것은 남는다 ──────────────────────────
{
  const userPluginDigest = digest(join(OC, "plugin", "my-plugin.js"));
  uninstall();
  const cfg = readJson(CFG);
  const ourGone = !cfg?.mcp?.lively && !cfg?.permission?.lively_whoami && !existsSync(PLUGIN);
  const userKept = cfg?.model === "anthropic/x" && cfg?.mcp?.mine && cfg?.permission?.bash === "ask" && cfg?.theme === "dark";
  const pluginKept = digest(join(OC, "plugin", "my-plugin.js")) === userPluginDigest;
  ourGone && userKept && pluginKept
    ? ok("W5 제거 → 우리 키·어댑터만 사라지고 사용자 키·플러그인 보존")
    : bad("W5 제거 라운드트립", `우리것제거=${ourGone} 사용자보존=${userKept} 플러그인보존=${pluginKept}`);
}

// ── W6 제거 후 재설치 ────────────────────────────────────────────────────────
{
  install();
  const cfg = readJson(CFG);
  (!!cfg?.mcp?.lively && existsSync(PLUGIN) && cfg?.model === "anthropic/x")
    ? ok("W6 제거 후 재설치가 정상 복원(사용자 키도 그대로)")
    : bad("W6 재설치", JSON.stringify(cfg)?.slice(0, 120));
}

// ── W7 회수 — 자동승인 목록이 줄면 우리 것만 걷고 멤버 것은 남긴다 ──────────
{
  // 멤버가 손으로 넣은 동종 키(우리 매니페스트 밖) — 회수 대상이 아니어야 한다.
  const cfg0 = readJson(CFG); cfg0.permission.lively_my_own = "allow";
  writeFileSync(CFG, JSON.stringify(cfg0, null, 2) + "\n");
  makeBundle({ autoApprove: ["mcp__lively__whoami"] });   // knowledge_get 이 목록에서 빠졌다
  install();
  const cfg = readJson(CFG);
  const pruned = cfg?.permission?.lively_knowledge_get === undefined;
  const keptOurs = cfg?.permission?.lively_whoami === "allow";
  const keptMember = cfg?.permission?.lively_my_own === "allow";
  pruned && keptOurs && keptMember
    ? ok("W7 자동승인 회수 — 빠진 키만 제거, 멤버가 넣은 동종 키는 보존")
    : bad("W7 회수", `제거=${pruned} 유지=${keptOurs} 멤버보존=${keptMember}`);
}

// ── W8 못 읽는 설정(.jsonc 주석)은 설치·제거 모두 무수정 ────────────────────
{
  makeBundle();
  const JSONC = '{\n  // 사용자 주석 — 우리가 다시 쓰면 사라진다\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  freshHome({ userConfig: { name: "opencode.jsonc", body: JSONC } });
  const before = digest(join(OC, "opencode.jsonc"));
  const outI = install();
  const afterInstall = digest(join(OC, "opencode.jsonc"));
  const warnedI = /JSON 으로 못 읽|머지를 건너뜁니다/.test(outI);
  // ⚠ 어댑터 검사는 **제거 전**에 한다 — 설정을 못 읽는 것과 훅 배선은 별개 경로이고,
  //  설정 파싱 실패가 어댑터 설치까지 막으면 그 멤버는 거버넌스가 통째로 없다.
  const adapterInstalled = existsSync(PLUGIN);
  const outU = uninstall();
  const afterUninstall = digest(join(OC, "opencode.jsonc"));
  const warnedU = /JSON 으로 못 읽|수동으로/.test(outU);
  (before === afterInstall && before === afterUninstall && warnedI && warnedU)
    ? ok("W8 주석 든 .jsonc — 설치·제거 모두 무수정 + 사람에게 안내")
    : bad("W8 .jsonc 무수정", `설치후동일=${before === afterInstall} 제거후동일=${before === afterUninstall} 경고I=${warnedI} 경고U=${warnedU}`);
  adapterInstalled ? ok("W8b .jsonc 여도 어댑터(훅 배선)는 설치된다") : bad("W8b 어댑터", "미설치 — 설정 파싱 실패가 훅까지 막았다");
}

// ── W9 AGENTS.md — 사용자 지침 보존, 우리 블록만 ────────────────────────────
{
  makeBundle();
  const USER_DOC = "# 내 글로벌 지침\n반드시 한국어로 답한다.\n";
  freshHome({ agents: USER_DOC });
  install();   // 토큰이 없어 org-context 는 비어 있다 → 블록을 안 만드는 게 정상
  const a1 = readFileSync(join(OC, "AGENTS.md"), "utf8");
  a1.includes("내 글로벌 지침")
    ? ok("W9 AGENTS.md 사용자 지침 보존(오프라인이라 블록 미생성)")
    : bad("W9 AGENTS.md", a1.slice(0, 80));
  uninstall();
  const a2 = existsSync(join(OC, "AGENTS.md")) ? readFileSync(join(OC, "AGENTS.md"), "utf8") : "";
  a2.includes("내 글로벌 지침")
    ? ok("W9b 제거해도 사용자 지침은 남는다") : bad("W9b AGENTS.md 제거", `남은 내용: ${a2.slice(0, 80)}`);
}

// ── W10 어댑터가 번들에 없으면 — **설치기가 중단한다**(구버전 번들 시나리오는 성립하지 않는다) ──
//  처음엔 "경고하고 MCP·자산만 적용"을 기대했는데, 실제로는 installShared 가 HOOK_SCRIPTS 누락을
//  치명으로 보고 exit 1 한다. 그게 옳다 — 훅 파일이 빠진 번들로 덮으면 그 멤버의 훅이 통째로 죽으므로
//  **부분 설치보다 중단이 안전**하다. installOpencode 안의 '어댑터 미동봉' 경고 분기는 그래서
//  도달 불가한 방어층이다(구조가 바뀌면 살아난다 — 남겨 둔다).
{
  makeBundle({ withAdapter: false });
  freshHome();
  const r = spawnSync(process.execPath, [join(BUNDLE, "setup", "user-install.mjs"), "--harness", "opencode", "--clone-root", BUNDLE],
    { env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME }, encoding: "utf8" });
  const out = `${r.stdout}${r.stderr}`;
  (r.status !== 0 && /훅 스크립트 .*누락/.test(out) && !existsSync(CFG))
    ? ok("W10 훅 파일이 빠진 번들은 설치를 **중단**한다(부분 설치 금지)")
    : bad("W10 불완전 번들", `exit=${r.status} 경고=${/누락/.test(out)} cfg생성=${existsSync(CFG)}`);
}

// ── ⓪ 재검 [W11] ────────────────────────────────────────────────────────────
{
  realFingerprint() === REAL_BEFORE
    ? ok("⓪ 실 설정 디렉터리 무접촉(~/.config + XDG)")
    : bad("⓪ 실 홈 무접촉", `샌드박스 계약 파손: ${REAL.join(", ")}`);
}

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${fail ? "✗" : "✓"} opencode-wiring: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
