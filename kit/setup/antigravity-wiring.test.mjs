#!/usr/bin/env node
// antigravity 배선 사양테스트(#1689) — [[delivery-install-invariants]] 의 **비파괴·멱등·라운드트립**을
//  antigravity(plugin-dir 배선)에 적용해 고정한다. codex/opencode 판과 같은 구조: 실제 설치기/제거기를 돌려
//  산출 파일을 본다. 오프라인·fs-only: 샌드박스 HOME(LIVELY_HOME) 안에서만 읽고 쓴다.
//  ⚠ 이 머신엔 **실제 agy 설치(~/.gemini)** 가 있다 — ⓪ 지문 대조가 특히 실질적이다.
//  실행: node kit/setup/antigravity-wiring.test.mjs   (kit/**/*.test.mjs 라 npm test 체인에 자동 포함)
//
//  엣지 표(AW1~AW12)는 <스크래치패드>/spec-agy-wiring.md — 케이스 이름의 [AW#] 가 그 행 번호다.
import { mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = mkdtempSync(join(tmpdir(), "agy-wiring-test-"));
const BUNDLE = join(SANDBOX, "bundle");
const HOME = join(SANDBOX, "home");
const GEM = join(HOME, ".gemini");
const PLUGIN = join(GEM, "config", "plugins", "lively");
const SETTINGS = join(GEM, "antigravity-cli", "settings.json");
const HOOKSJSON = join(GEM, "config", "hooks.json");   // 훅은 글로벌 루트(#1689 — 플러그인 훅은 CLI 가 안 읽는다)

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const digest = (p) => { try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return "(none)"; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
// 플러그인 디렉터리 전체 지문(파일명 + 해시) — 멱등·불가침 단언에 쓴다.
const treeDigest = (dir) => {
  if (!existsSync(dir)) return "(none)";
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); f.isDirectory() ? walk(p) : files.push(p); } };
  walk(dir);
  return files.sort().map((p) => `${p.slice(dir.length)}:${digest(p)}`).join("|");
};

// ⓪ 배선 단언 [AW11] — 실 ~/.gemini 무접촉(이 머신의 실제 agy 설치 지문).
const REAL = join(homedir(), ".gemini");
const realFingerprint = () => (existsSync(REAL) ? String(statSync(REAL).mtimeMs) + ":" + String(statSync(join(REAL, "config")).mtimeMs || "") : "(none)");
const REAL_BEFORE = realFingerprint();

// ── 발행물 번들(publish() 배치 최소 재현) ────────────────────────────────────
const { HOOK_SCRIPTS: HOOKS } = await import(pathToFileURL(join(KIT, "setup", "user-install.mjs")).href);
function makeBundle({ autoApprove = ["mcp__lively__whoami", "mcp__lively__knowledge_get"], withAdapter = true } = {}) {
  rmSync(BUNDLE, { recursive: true, force: true });
  mkdirSync(join(BUNDLE, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(BUNDLE, ".lively"), { recursive: true });
  mkdirSync(join(BUNDLE, "setup"), { recursive: true });
  mkdirSync(join(BUNDLE, "cli"), { recursive: true });
  for (const h of HOOKS) {
    if (!withAdapter && h === "antigravity-adapter.mjs") continue;   // [AW10] 구버전 번들 흉내
    cpSync(join(KIT, "hooks", h), join(BUNDLE, ".claude", "hooks", h));
  }
  for (const f of ["user-install.mjs", "user-uninstall.mjs", "host-effects.mjs", "work.mjs", "work-roots-header.mjs"]) cpSync(join(KIT, "setup", f), join(BUNDLE, "setup", f));
  for (const f of ["lively.mjs", "lively-mcp-gateway.mjs"]) cpSync(join(KIT, "cli", f), join(BUNDLE, "cli", f));
  writeFileSync(join(BUNDLE, ".lively-org-name"), "테스트조직\n");
  writeFileSync(join(BUNDLE, ".lively", "auto-approve.json"), JSON.stringify({ allow: autoApprove }));
  writeFileSync(join(BUNDLE, ".lively", "mcp-servers.json"), JSON.stringify({ servers: [] }));
}
function freshHome({ settings = null, userPlugin = null } = {}) {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, ".lively"), { recursive: true });
  writeFileSync(join(HOME, ".lively", "gateway-url"), "http://127.0.0.1:9\n"); // 토큰 없음 = 네트워크 미접촉
  if (settings !== null) { mkdirSync(dirname(SETTINGS), { recursive: true }); writeFileSync(SETTINGS, settings); }
  if (userPlugin !== null) {
    const d = join(GEM, "config", "plugins", userPlugin.name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "plugin.json"), userPlugin.body);
  }
}
function install() {
  const r = spawnSync(process.execPath, [join(BUNDLE, "setup", "user-install.mjs"), "--harness", "antigravity", "--clone-root", BUNDLE],
    { env: { ...process.env, LIVELY_HOME: HOME }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`설치기 exit=${r.status}\n${r.stderr || r.stdout}`);
  return `${r.stdout}${r.stderr}`;
}
function uninstall({ dry = false, member = false } = {}) {
  const args = member
    ? [join(KIT, "setup", "user-uninstall.mjs"), "--harness", "antigravity", "--yes"]
    : [join(KIT, "adapters", "antigravity", "uninstall.mjs")];
  if (dry) args.push("--dry-run");
  const r = spawnSync(process.execPath, args, { env: { ...process.env, LIVELY_HOME: HOME }, encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
}

// ── AW1 기본 설치 ────────────────────────────────────────────────────────────
makeBundle();
freshHome();
install();
{
  const plug = readJson(join(PLUGIN, "plugin.json"));
  const hooks = readJson(HOOKSJSON);
  const mcp = readJson(join(PLUGIN, "mcp_config.json"));
  const st = readJson(SETTINGS);
  const named = hooks?.lively;
  // hooks.json 형태 — 이벤트 4종 · PreToolUse 는 matcher 그룹형 · command 가 어댑터를 가리키고 이벤트 argv 를 싣는다.
  const okHooks = !!named
    && Array.isArray(named.PreInvocation) && typeof named.PreInvocation[0]?.command === "string"
    && named.PreToolUse?.[0]?.matcher === "*" && /antigravity-adapter\.mjs" PreToolUse$/.test(named.PreToolUse[0]?.hooks?.[0]?.command || "")
    && named.PostToolUse?.[0]?.matcher === "*"
    && Array.isArray(named.Stop);
  // mcp_config — command **문자열**(+args 배열) + LIVELY_HARNESS stamp. 배열 command 를 쓰면 agy 스키마 위반이다.
  const lv = mcp?.mcpServers?.lively;
  const okMcp = typeof lv?.command === "string" && Array.isArray(lv?.args) && lv.args[0] === "mcp" && lv?.env?.LIVELY_HARNESS === "antigravity";
  const okPerm = Array.isArray(st?.permissions?.allow) && st.permissions.allow.includes("mcp(lively/whoami)") && st.permissions.allow.includes("mcp(lively/knowledge_get)");
  (plug?.name === "lively" && okHooks && okMcp && okPerm)
    ? ok("AW1 설치 → plugin.json + 글로벌 hooks.json(4이벤트·어댑터 command) + mcp_config(문자열 command·stamp) + allow 규칙")
    : bad("AW1 기본 설치", `plugin=${plug?.name} hooks=${okHooks} mcp=${okMcp} perm=${okPerm}`);
}

// ── AW2 멱등 — 두 번째 설치가 **바이트 동일** ────────────────────────────────
{
  const before = treeDigest(PLUGIN) + "||" + digest(SETTINGS) + "||" + digest(HOOKSJSON);
  install();
  const after = treeDigest(PLUGIN) + "||" + digest(SETTINGS) + "||" + digest(HOOKSJSON);
  const allow = readJson(SETTINGS)?.permissions?.allow ?? [];
  (before === after && allow.length === 2)
    ? ok("AW2 설치 멱등(2회 실행 결과 바이트 동일 · allow 누적 없음)")
    : bad("AW2 멱등", `동일=${before === after} allow=${allow.length}개(기대 2)`);
}

// ── AW3/AW4 사용자 설정·다른 플러그인 보존 ──────────────────────────────────
{
  makeBundle();
  freshHome({
    settings: JSON.stringify({ colorScheme: "dark", toolPermission: "request-review", permissions: { allow: ["command(git)", "mcp(lively/my_manual)"], deny: ["command(rm -rf)"] } }, null, 2),
    userPlugin: { name: "my-plugin", body: JSON.stringify({ name: "mine" }) },
  });
  const userPluginDigest = treeDigest(join(GEM, "config", "plugins", "my-plugin"));
  install();
  const st = readJson(SETTINGS);
  const kept = st?.colorScheme === "dark" && st?.toolPermission === "request-review"
    && st?.permissions?.allow?.includes("command(git)") && st?.permissions?.allow?.includes("mcp(lively/my_manual)")
    && st?.permissions?.deny?.includes("command(rm -rf)");
  const added = st?.permissions?.allow?.includes("mcp(lively/whoami)");
  kept && added ? ok("AW3 사용자 키·allow·deny 보존 + 우리 규칙만 추가")
    : bad("AW3 사용자 설정 보존", `보존=${kept} 추가=${added} ${JSON.stringify(st)?.slice(0, 160)}`);
  treeDigest(join(GEM, "config", "plugins", "my-plugin")) === userPluginDigest
    ? ok("AW4 사용자 플러그인 디렉터리 불가침") : bad("AW4 사용자 플러그인", "변경됨");
}

// ── AW5 제거 — 우리 것만 사라지고 사용자 것은 남는다 ─────────────────────────
{
  const userPluginDigest = treeDigest(join(GEM, "config", "plugins", "my-plugin"));
  uninstall();
  const st = readJson(SETTINGS);
  const hooksGone = !(readJson(HOOKSJSON)?.lively);
  const ourGone = !existsSync(PLUGIN) && hooksGone && !st?.permissions?.allow?.includes("mcp(lively/whoami)");
  const userKept = st?.colorScheme === "dark" && st?.permissions?.allow?.includes("command(git)")
    && st?.permissions?.allow?.includes("mcp(lively/my_manual)") && st?.permissions?.deny?.includes("command(rm -rf)");
  const pluginKept = treeDigest(join(GEM, "config", "plugins", "my-plugin")) === userPluginDigest;
  (ourGone && userKept && pluginKept)
    ? ok("AW5 제거 → 플러그인 디렉터리·우리 규칙만 제거, 사용자 것 보존(수동 mcp(lively/...) 규칙 포함)")
    : bad("AW5 제거 라운드트립", `우리것제거=${ourGone} 사용자보존=${userKept} 플러그인보존=${pluginKept}`);
}

// ── AW6 제거 후 재설치 ───────────────────────────────────────────────────────
{
  install();
  const st = readJson(SETTINGS);
  (!!readJson(HOOKSJSON)?.lively && st?.permissions?.allow?.includes("mcp(lively/whoami)") && st?.colorScheme === "dark")
    ? ok("AW6 제거 후 재설치가 정상 복원(사용자 키도 그대로)")
    : bad("AW6 재설치", JSON.stringify(st)?.slice(0, 120));
}

// ── AW7 회수 — 자동승인 목록이 줄면 우리 것만 걷고 멤버 것은 남긴다 ──────────
{
  makeBundle({ autoApprove: ["mcp__lively__whoami"] });   // knowledge_get 이 목록에서 빠졌다
  install();
  const allow = readJson(SETTINGS)?.permissions?.allow ?? [];
  const pruned = !allow.includes("mcp(lively/knowledge_get)");
  const keptOurs = allow.includes("mcp(lively/whoami)");
  const keptMember = allow.includes("mcp(lively/my_manual)") && allow.includes("command(git)");
  (pruned && keptOurs && keptMember)
    ? ok("AW7 자동승인 회수 — 빠진 규칙만 제거, 멤버 수동 규칙 보존")
    : bad("AW7 회수", `제거=${pruned} 유지=${keptOurs} 멤버보존=${keptMember} allow=${JSON.stringify(allow)}`);
}

// ── AW8 못 읽는 settings.json — 설치·제거 무수정 + 플러그인은 그래도 설치 ────
{
  makeBundle();
  const BROKEN = '{\n  // 주석 — JSON.parse 실패\n  "colorScheme": "dark"\n}\n';
  freshHome({ settings: BROKEN });
  const before = digest(SETTINGS);
  const outI = install();
  const afterInstall = digest(SETTINGS);
  const warnedI = /파싱 실패|건너뜀|건너뜁니다/.test(outI);
  const pluginInstalled = !!readJson(HOOKSJSON)?.lively && existsSync(join(PLUGIN, "mcp_config.json"));
  (before === afterInstall && warnedI)
    ? ok("AW8 깨진 settings.json — 설치가 그 파일 무수정 + 사람에게 안내")
    : bad("AW8 무수정(설치)", `설치후동일=${before === afterInstall} 경고I=${warnedI}`);
  pluginInstalled ? ok("AW8b 승인 머지 실패여도 플러그인(훅·MCP)은 설치된다") : bad("AW8b 플러그인", "미설치 — 승인 실패가 거버넌스까지 막았다");
  // 제거 절반 — **정상 설치로 우리 규칙이 이미 들어간 뒤** 사용자가 settings 를 주석으로 깨뜨린 경우:
  //  제거는 그 파일을 무수정하고(다시 쓰면 주석·의도가 사라진다) 수동 정리를 안내해야 한다.
  freshHome();
  install();                                             // 정상 설치 — 규칙 반영 + 회수 원장 생성
  const brokenNow = "// broken by user\n" + readFileSync(SETTINGS, "utf8");
  writeFileSync(SETTINGS, brokenNow);
  const beforeU = digest(SETTINGS);
  const outU = uninstall();
  const afterUninstall = digest(SETTINGS);
  const warnedU = /파싱 실패|수동으로/.test(outU);
  (beforeU === afterUninstall && warnedU && !existsSync(PLUGIN))
    ? ok("AW8c 규칙 반영 후 깨진 settings — 제거는 무수정+안내, 플러그인은 정리")
    : bad("AW8c 무수정(제거)", `제거후동일=${beforeU === afterUninstall} 경고U=${warnedU} plugin잔존=${existsSync(PLUGIN)}`);
}

// ── AW9 오프라인 — org-context 미생성 + 안내, 제거 시 플러그인째 정리 ────────
{
  makeBundle();
  freshHome();
  const out = install();   // 토큰 없음 → org-context 비어 있음
  const noRules = !existsSync(join(PLUGIN, "rules", "AGENTS.md"));
  (noRules && /시드 보류|오프라인/.test(out))
    ? ok("AW9 오프라인 설치 — rules/AGENTS.md 미생성 + 보류 안내")
    : bad("AW9 오프라인", `rules없음=${noRules}`);
  uninstall();
  !existsSync(PLUGIN) ? ok("AW9b 제거가 플러그인 디렉터리를 통째로 정리") : bad("AW9b 제거", "잔존");
}

// ── AW10 어댑터가 번들에 없으면 — 설치기가 **중단**한다(부분 설치 금지) ───────
{
  makeBundle({ withAdapter: false });
  freshHome();
  const r = spawnSync(process.execPath, [join(BUNDLE, "setup", "user-install.mjs"), "--harness", "antigravity", "--clone-root", BUNDLE],
    { env: { ...process.env, LIVELY_HOME: HOME }, encoding: "utf8" });
  const out = `${r.stdout}${r.stderr}`;
  (r.status !== 0 && /훅 스크립트 .*누락/.test(out) && !existsSync(PLUGIN))
    ? ok("AW10 훅 파일이 빠진 번들은 설치를 중단한다(부분 설치 금지)")
    : bad("AW10 불완전 번들", `exit=${r.status} 경고=${/누락/.test(out)} plugin생성=${existsSync(PLUGIN)}`);
}

// ── AW13 사용자 훅 보존 — 글로벌 hooks.json 은 **공유 파일**이다(top-level 키 단위 머지·제거) ─────────
{
  makeBundle();
  freshHome();
  mkdirSync(dirname(HOOKSJSON), { recursive: true });
  writeFileSync(HOOKSJSON, JSON.stringify({ "my-hook": { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2) + "\n");
  install();
  const hk = readJson(HOOKSJSON);
  (hk?.["my-hook"]?.PreToolUse?.[0]?.hooks?.[0]?.command === "echo mine" && !!hk?.lively)
    ? ok("AW13 설치 — 사용자 이름 훅 보존 + lively 키만 추가")
    : bad("AW13 설치", JSON.stringify(hk)?.slice(0, 160));
  uninstall();
  const hk2 = readJson(HOOKSJSON);
  (hk2?.["my-hook"] && hk2?.lively === undefined)
    ? ok("AW13b 제거 — lively 키만 제거, 사용자 훅 보존(파일 유지)")
    : bad("AW13b 제거", JSON.stringify(hk2)?.slice(0, 160));
}

// ── AW14 깨진 hooks.json — 설치·제거 모두 무수정 + 안내(비파괴 불변식) ─────────
{
  makeBundle();
  freshHome();
  mkdirSync(dirname(HOOKSJSON), { recursive: true });
  writeFileSync(HOOKSJSON, "{ broken json !!!");
  const before = digest(HOOKSJSON);
  const outI = install();
  const warnedI = /파싱 실패|건너뜀/.test(outI);
  const outU = uninstall();
  const warnedU = /못 읽었습니다|수동으로/.test(outU);
  (digest(HOOKSJSON) === before && warnedI && warnedU)
    ? ok("AW14 깨진 hooks.json — 설치·제거 무수정 + 안내(다른 배선·플러그인은 그대로 진행)")
    : bad("AW14 깨진 hooks.json", `무수정=${digest(HOOKSJSON) === before} 경고I=${warnedI} 경고U=${warnedU}`);
}

// ── AW12 member 경로 제거기(user-uninstall) — 어댑터 경로와 같은 결과 ─────────
//  종전 opencode 는 실제 `lively uninstall` 이 타는 이 경로에서 통째로 빠져 있었다(#1689 에서 채움) — 재발 방지.
{
  makeBundle();
  freshHome({ settings: JSON.stringify({ permissions: { allow: ["command(git)"] } }, null, 2) });
  install();
  const stBefore = readJson(SETTINGS);
  stBefore?.permissions?.allow?.includes("mcp(lively/whoami)") || bad("AW12 사전조건", "설치 후 allow 미반영");
  const out = uninstall({ member: true });
  const st = readJson(SETTINGS);
  const ourGone = !existsSync(PLUGIN) && !(readJson(HOOKSJSON)?.lively) && !(st?.permissions?.allow ?? []).includes("mcp(lively/whoami)");
  const userKept = (st?.permissions?.allow ?? []).includes("command(git)");
  (ourGone && userKept && /antigravity/.test(out))
    ? ok("AW12 member 경로 제거기도 같은 결과(플러그인 삭제+규칙 회수+사용자 보존)")
    : bad("AW12 member 제거", `우리것제거=${ourGone} 사용자보존=${userKept}`);
}

// ── ⓪ 재검 [AW11] ───────────────────────────────────────────────────────────
{
  realFingerprint() === REAL_BEFORE
    ? ok("⓪ 실 ~/.gemini 무접촉(이 머신의 실제 agy 설치 보호)")
    : bad("⓪ 실 홈 무접촉", "샌드박스 계약 파손 — 실 ~/.gemini 가 변경됨");
}

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${fail ? "✗" : "✓"} antigravity-wiring: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
