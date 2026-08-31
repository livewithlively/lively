#!/usr/bin/env node
// 하네스 레지스트리 사양테스트 — 테이블화(#1519)가 지켜야 할 불변식을 고정한다.
//  실행: node kit/hooks/harness-registry.test.mjs   (kit/**/*.test.mjs 라 npm test 체인에 자동 포함)
//  사양·엣지 표(29행): 프로젝트 #1519 · 케이스 이름의 [E#] 가 그 행 번호다.
//
// 왜 이 테스트인가 — 테이블화는 **조용히 깨지는 방식**이 둘이다:
//  ① 훅이 import 하는 모듈이 설치 복사 목록에서 빠지면, 설치된 자리에서 ERR_MODULE_NOT_FOUND 로 훅이 통째로
//     죽는다. 자산 sync 는 실패해도 세션을 안 막는 게 설계라 **아무 신호가 없다** — 사용자는 스킬이 0개인
//     채로 계속 일하고 `lively status` 도 훅 파일 개수만 보므로 초록불이다.
//     ⚠ 목록 비교(A2)만으로는 "복사는 됐지만 실행이 안 되는" 상태를 못 본다 → **D 가 실제로 설치를 돌려 실행한다.**
//  ② 표에 하네스를 한 줄 더할 때 축 하나를 안 채우면 그 하네스에서만 그 기능이 조용히 없다 — #1475 가
//     "한 군데 빠져 조용히 안 감"으로 실제로 겪은 사고다. B 가 축 전수를 강제한다.
//
// 단언은 **문구가 아니라 부작용**으로 한다: 실제 설치 산출물의 존재·설치된 훅의 종료코드·경로 문자열 자체.
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOOK_SCRIPTS, SETUP_FILES } from "../setup/kit-manifest.mjs";
import {
  HARNESS, HARNESS_IDS, resolveHarness, isKnownHarness,
  harness, placementFor, assetDirsFor, assetDirNames, toolMatcher, mcpMatcher, allToolNames, mcpToolName,
  claudeConfigDir, isInsideDir,
} from "./harness-registry.mjs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const KIT = join(HOOKS_DIR, "..");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
// 경로 단언은 **구분자를 정규화해서** 비교한다. 레지스트리는 플랫폼 구분자로 조립하므로(win32 는 `\\`),
//  `/` 로 쓴 기대값을 그대로 맞대면 **Windows 에서만** 전부 깨진다 — 그 플랫폼에서만 나는 실패가 가장 늦게
//  발견된다(#1510 이 정확히 그 부류였다). 검증하려는 건 구분자가 아니라 **경로 구성**이다.
const slash = (v) => JSON.parse(JSON.stringify(v ?? null).replace(/\\\\/g, "/"));
const eqPath = (n, got, want) => eq(n, slash(got), want);

// ── A. 배선 보장(S1) — 엣지 E1·E2 ────────────────────────────────────────────────
// 종전엔 복사 목록이 **두 벌**이었다(발행물 생성 = build-context, 설치 = user-install). 한쪽만 고치면
//  "발행은 됐는데 설치가 안 되는" 또는 그 반대가 됐고, 실제로 셋째 사본(deploy/refresh-member-kits.sh 의
//  `kit/hooks/*.mjs` 글롭)과 드리프트해 2026-08-27 «멤버 훅 전멸» 을 냈다. 그래서 목록은
//  kit/setup/kit-manifest.mjs 단일 출처로 합쳤다 — 이제 A1 이 볼 것은 «두 목록이 같은가» 가 아니라
//  «소비자가 지역 사본을 되살리지 않았는가» 다.
{
  const install = HOOK_SCRIPTS;
  const revived = ["setup/user-install.mjs", "generator/build-context.mjs"]
    .filter((rel) => /const HOOK_SCRIPTS\s*=\s*\[/.test(readFileSync(join(KIT, rel), "utf8")));
  {
    revived.length === 0
      ? ok("A1[E2] 소비자가 목록 사본을 두지 않음(매니페스트 단일 출처)")
      : bad("A1[E2] 소비자가 목록 사본을 두지 않음(매니페스트 단일 출처)",
          `${revived.join(", ")} 가 지역 리터럴을 되살렸다 — 매니페스트와 조용히 어긋난다`);
    // 배포되는 훅들이 import 하는 상대 모듈을 모아, 전부 목록에 있는지 본다(정적 검사).
    const missing = [];
    for (const f of readdirSync(HOOKS_DIR).filter((x) => x.endsWith(".mjs") && !x.endsWith(".test.mjs"))) {
      if (!install.includes(f)) continue;                       // 배포 대상 훅만 검사(examples 등 제외)
      const src = readFileSync(join(HOOKS_DIR, f), "utf8");
      for (const m of src.matchAll(/^\s*import\s[^"']*["']\.\/([^"']+)["']/gm)) {
        if (!install.includes(m[1])) missing.push(`${f} → ${m[1]}`);
      }
    }
    missing.length
      ? bad("A2[E1] 훅이 import 하는 로컬 모듈이 전부 복사 목록에 있음", `누락: ${missing.join(", ")}`)
      : ok("A2[E1] 훅이 import 하는 로컬 모듈이 전부 복사 목록에 있음");
  }
}

// ── B. 표 완전성(S2) — 엣지 E5·E6 ────────────────────────────────────────────────
{
  const REQUIRED = ["id", "label", "bin", "home", "configFile", "configFormat", "wiring", "assets", "tools", "mcp", "autoApprove", "contextEnvelope", "reloadAssets", "events", "install"];
  const KINDS = ["skill", "subagent", "command"];
  const TOOL_GROUPS = ["edit", "shell", "read", "skill", "mcp", "mcpMatcher"];
  const holes = [];
  for (const id of HARNESS_IDS) {
    const h = HARNESS[id];
    if (!h) { holes.push(`${id}: 표에 없음`); continue; }
    for (const k of REQUIRED) if (h[k] === undefined) holes.push(`${id}.${k}`);
    for (const kind of KINDS) {
      const s = h.assets?.[kind];
      if (!s) { holes.push(`${id}.assets.${kind}`); continue; }
      for (const k of ["root", "dir", "ext", "compose"]) if (s[k] === undefined) holes.push(`${id}.assets.${kind}.${k}`);
    }
    for (const g of TOOL_GROUPS) if (h.tools?.[g] === undefined) holes.push(`${id}.tools.${g}`);
    // 설치 축(#2255) — **두 OS 가 다 답해야** 한다. 「윈도우 칸을 안 적었다」가 곧 「윈도우 사람은 손으로 깔아라」였고
    //  그게 이 축을 만든 이유다. 못 하면 못 한다고 적어야(cmd:null) '안 적음'과 구분된다.
    if (h.install === undefined) holes.push(`${id}.install`);
    else {
      if (!h.install.docs) holes.push(`${id}.install.docs`);
      for (const os of ["posix", "win"]) {
        const spec = h.install[os];
        if (spec === undefined) { holes.push(`${id}.install.${os}`); continue; }
        if (spec === null) continue;                        // 명시적 "이 OS 엔 없다"
        if (!spec.cmd) { holes.push(`${id}.install.${os}.cmd`); continue; }
        if (!spec.shell) holes.push(`${id}.install.${os}.shell`);
        if (spec.wiresPath === undefined) holes.push(`${id}.install.${os}.wiresPath`);
        if (spec.integrity === undefined) holes.push(`${id}.install.${os}.integrity`);
        if (spec.binDir === undefined) holes.push(`${id}.install.${os}.binDir`);
      }
    }
    if (h.id !== id) holes.push(`${id}.id 불일치(${h.id})`);
  }
  holes.length ? bad("B1[E5·E6] 모든 하네스가 필수 축을 채움", `빠짐: ${holes.join(", ")}`)
    : ok("B1[E5·E6] 모든 하네스가 필수 축을 채움");
}

// ── C. 동작 무변경(S3) — 엣지 E7~E12 ─────────────────────────────────────────────
// 값을 **하드코딩된 기대 경로**와 맞댄다. 표를 읽어 만든 기대값과 비교하면 표를 표로 검증하는 tautology 가 된다.
{
  const H = "/h";
  const env = {}; // 설정 디렉터리 환경변수 미설정 = 기본 ~/.claude
  eqPath("C1[E7] claude skill", placementFor("claude", "skill", "s1", H, env),
    { file: "/h/.claude/skills/s1/SKILL.md", skillDir: "/h/.claude/skills/s1", root: "/h/.claude/skills" });
  eqPath("C2[E7] claude subagent", placementFor("claude", "subagent", "a1", H, env),
    { file: "/h/.claude/agents/a1.md", root: "/h/.claude/agents" });
  eqPath("C3[E7] claude command", placementFor("claude", "command", "c1", H, env),
    { file: "/h/.claude/commands/c1.md", root: "/h/.claude/commands" });
  eqPath("C4[E8] codex subagent 는 .toml", placementFor("codex", "subagent", "a1", H, env),
    { file: "/h/.codex/agents/a1.toml", root: "/h/.codex/agents" });
  eqPath("C5[E9] codex command 는 prompts/", placementFor("codex", "command", "c1", H, env),
    { file: "/h/.codex/prompts/c1.md", root: "/h/.codex/prompts" });
  eqPath("C6[E10] claude 는 CLAUDE_CONFIG_DIR 를 존중", placementFor("claude", "skill", "s1", H, { CLAUDE_CONFIG_DIR: "/p" }),
    { file: "/p/skills/s1/SKILL.md", skillDir: "/p/skills/s1", root: "/p/skills" });
  // ★ 2026-08-19 실측 — LIVELY_HOME(샌드박스) 밖의 CLAUDE_CONFIG_DIR 는 **상속된 실 프로필**이다. 존중하면 실 프로필
  //  settings.json 에 샌드박스 훅 경로가 써지고(D 블록이 그 사고를 냈다) 이후 모든 세션 훅이 Cannot find module 로 죽는다.
  //  안이면 존중(프로필 격리 #346 은 샌드박스에서도 검증돼야 한다 — self-update·lively.test 가 그렇게 쓴다) · 밖이면 무시.
  eqPath("C6b LIVELY_HOME 없으면 CLAUDE_CONFIG_DIR 그대로", claudeConfigDir(H, { CLAUDE_CONFIG_DIR: "/p" }), "/p");
  eqPath("C6c LIVELY_HOME 안의 CLAUDE_CONFIG_DIR 는 존중", claudeConfigDir(H, { LIVELY_HOME: "/sb/home", CLAUDE_CONFIG_DIR: "/sb/home/.claude" }), "/sb/home/.claude");
  eqPath("C6d LIVELY_HOME 밖의 CLAUDE_CONFIG_DIR 는 무시 → <HOME>/.claude", claudeConfigDir(H, { LIVELY_HOME: "/sb/home", CLAUDE_CONFIG_DIR: "/Users/dev/.lively/profiles/x/claude" }), "/h/.claude");
  eqPath("C6e 접두어만 같은 형제 디렉터리는 '안'이 아니다", claudeConfigDir(H, { LIVELY_HOME: "/sb/home", CLAUDE_CONFIG_DIR: "/sb/home2/.claude" }), "/h/.claude");
  eqPath("C6f 빈 CLAUDE_CONFIG_DIR 는 지목이 아니다", claudeConfigDir(H, { LIVELY_HOME: "/sb/home", CLAUDE_CONFIG_DIR: "  " }), "/h/.claude");
  eqPath("C6g HARNESS.claude.home 도 같은 계산", HARNESS.claude.home(H, { LIVELY_HOME: "/sb/home", CLAUDE_CONFIG_DIR: "/p" }), "/h/.claude");
  // 윈도우: 대소문자·구분자가 섞여 와도 포함 판정이 성립해야 한다(안 그러면 정당한 샌드박스 프로필까지 무시돼 테스트가 엉뚱한 곳을 본다).
  if (process.platform === "win32") {
    eq("C6h[win] 구분자·대소문자 무시 포함 판정", isInsideDir("c:\\SB\\Home\\.claude", "C:/sb/home/"), true);
    eq("C6i[win] 형제 디렉터리는 밖", isInsideDir("C:\\sb\\home2\\.claude", "C:/sb/home"), false);
  } else {
    eq("C6h[posix] 대소문자는 구분한다", isInsideDir("/SB/home/.claude", "/sb/home"), false);
    eq("C6i[posix] 후행 슬래시 무시", isInsideDir("/sb/home/.claude", "/sb/home/"), true);
  }
  eqPath("C7[E11] 모르는 하네스는 claude 배치로 폴백", placementFor("nope", "skill", "s1", H, env),
    { file: "/h/.claude/skills/s1/SKILL.md", skillDir: "/h/.claude/skills/s1", root: "/h/.claude/skills" });
  // '어디에 쓰나'(placement)와 '어디를 훑나'(assetDirs)가 같은 출처여야 한다 —
  //  어긋나면 배포된 자산이 관측·로컬토글에서 통째로 안 보인다(종전엔 두 함수가 따로 하드코딩돼 있었다).
  const dirs = assetDirsFor("codex", H, env);
  // ⚠ 여기만 eq — 양변이 **둘 다 레지스트리 산출**이라(플랫폼 구분자끼리) 한쪽만 정규화하면 오히려 어긋난다.
  //  이 케이스가 보려는 것도 구분자가 아니라 '두 함수가 같은 값을 낸다'이다.
  eq("C8[E12] assetDirs 의 root 가 placement 와 일치", dirs.map((d) => d[1]),
    ["skill", "subagent", "command"].map((k) => placementFor("codex", k, "x", H, env).root));
  eq("C9[E8·E9] codex assetDirs 확장자", dirs.map((d) => d[3]), ["", ".toml", ".md"]);
  // E28/E29 — opencode 는 XDG 규약이고 **플랫폼 무관**이다(번들 소스 실측: XDG_CONFIG_HOME || homedir()/.config).
  //  XDG_CONFIG_HOME 을 무시하면 우리는 ~/.config 에 쓰고 opencode 는 다른 곳을 봐서 **어댑터가 조용히 안 돈다**.
  eqPath("C10[E28] opencode 기본 경로는 ~/.config/opencode", placementFor("opencode", "skill", "s1", H, env),
    { file: "/h/.config/opencode/skill/s1/SKILL.md", skillDir: "/h/.config/opencode/skill/s1", root: "/h/.config/opencode/skill" });
  eqPath("C11[E29] opencode 는 XDG_CONFIG_HOME 을 존중", placementFor("opencode", "skill", "s1", H, { XDG_CONFIG_HOME: "/xdg" }),
    { file: "/xdg/opencode/skill/s1/SKILL.md", skillDir: "/xdg/opencode/skill/s1", root: "/xdg/opencode/skill" });
  eqPath("C12[E28] opencode subagent/command 는 단수 디렉터리", [
    placementFor("opencode", "subagent", "a1", H, env).file,
    placementFor("opencode", "command", "c1", H, env).file,
  ], ["/h/.config/opencode/agent/a1.md", "/h/.config/opencode/command/c1.md"]);
  // E30~E32(#1689) — antigravity 는 ~/.gemini/config 고정(env 오버라이드 없음 — XDG 를 존중하면 오히려 빗나간다).
  eqPath("C13[E30] antigravity skill 은 ~/.gemini/config/skills", placementFor("antigravity", "skill", "s1", H, env),
    { file: "/h/.gemini/config/skills/s1/SKILL.md", skillDir: "/h/.gemini/config/skills/s1", root: "/h/.gemini/config/skills" });
  // ⚠ 디렉터리형인데 엔트리 파일명이 SKILL.md 가 아니라 agent.md 다(dirFile 축) — 하드코딩하면 여기서만 빗나간다.
  eqPath("C14[E31] antigravity subagent 는 agents/<n>/agent.md", placementFor("antigravity", "subagent", "a1", H, env),
    { file: "/h/.gemini/config/agents/a1/agent.md", skillDir: "/h/.gemini/config/agents/a1", root: "/h/.gemini/config/agents" });
  eqPath("C15[E32] antigravity command 는 workflows/<n>.md", placementFor("antigravity", "command", "c1", H, env),
    { file: "/h/.gemini/config/workflows/c1.md", root: "/h/.gemini/config/workflows" });
  // antigravity 는 XDG_CONFIG_HOME 이 있어도 무시해야 한다(agy 가 그 변수를 안 본다 — 존중하면 agy 는 못 보는 자리에 쓴다).
  eqPath("C16[E30] antigravity 는 XDG 를 무시", placementFor("antigravity", "skill", "s1", H, { XDG_CONFIG_HOME: "/xdg" }).file,
    "/h/.gemini/config/skills/s1/SKILL.md");
}

// ── D. 설치 라운드트립(S1) — 엣지 E3·E4 ★이번 변경이 새로 만든 엣지 ───────────────────
//  harness-registry.mjs 라는 **새 모듈을 도입한 것 자체**가 "그 파일이 설치 자리에 없는 경우"라는 엣지를 만들었다.
//  A2 는 목록만 본다 — 여기서는 **실제로 설치기를 돌리고 설치된 훅을 실행**해 import 가 풀리는지 확인한다.
{
  const SB = mkdtempSync(join(tmpdir(), "harness-registry-test-"));
  try {
    const BUNDLE = join(SB, "bundle"), HOME = join(SB, "home");
    // 번들 구성은 발행물 배치를 최소 재현한다(codex-wiring.test.mjs 의 makeBundle 과 같은 형태).
    // 번들 구성 재료는 **설치기의 정본 목록**을 따른다(사본을 두면 훅이 늘 때마다 여기가 스테일해진다).
    const { HOOK_SCRIPTS: scripts } = await import(pathToFileURL(join(KIT, "setup", "user-install.mjs")).href); // ⚠ pathToFileURL 필수(윈도우 드라이브문자)
    mkdirSync(join(BUNDLE, ".claude", "hooks"), { recursive: true });
    mkdirSync(join(BUNDLE, ".lively"), { recursive: true });
    mkdirSync(join(BUNDLE, "setup"), { recursive: true });
    for (const f of scripts) cpSync(join(HOOKS_DIR, f), join(BUNDLE, ".claude", "hooks", f));
    // 번들 setup/ 목록은 매니페스트 단일 출처를 따른다 — 사본을 두면 파일이 하나 늘 때 여기만 빠져
    //  "설치기가 번들 안에서 import 크래시" 로 죽는다(kit-manifest.SETUP_FILES 주석 참조).
    for (const f of SETUP_FILES) cpSync(join(KIT, "setup", f), join(BUNDLE, "setup", f));
    writeFileSync(join(BUNDLE, ".lively-org-name"), "테스트조직\n");
    writeFileSync(join(BUNDLE, ".lively", "auto-approve.json"), JSON.stringify({ allow: [] }));
    writeFileSync(join(BUNDLE, ".lively", "mcp-servers.json"), JSON.stringify({ servers: [] }));
    mkdirSync(join(HOME, ".lively"), { recursive: true });
    writeFileSync(join(HOME, ".lively", "gateway-url"), "http://127.0.0.1:9\n"); // 토큰 없음 = 네트워크 미접촉

    // ★ 미끼 '실 프로필' — 웹터미널 세션·개발자 셸이 상속시키는 CLAUDE_CONFIG_DIR 를 재현한다. **샌드박스 HOME 밖**(SB 형제)이다.
    //  2026-08-19 실측: 이 테스트가 LIVELY_HOME 만 주고 설치기를 돌려, 상속된 CLAUDE_CONFIG_DIR=<실 프로필>/settings.json 에
    //  이 샌드박스(곧 rmSync 됨)의 훅 경로 20개가 써졌다 → 다음 세션부터 모든 훅이 Cannot find module. 여기서 그 사고를 못박는다:
    //  설치기·훅은 LIVELY_HOME 밖의 CLAUDE_CONFIG_DIR 를 **무시**하고 <HOME>/.claude 에 써야 한다(harness-registry.claudeConfigDir).
    const DECOY = join(SB, "real-profile-claude");
    mkdirSync(DECOY, { recursive: true });
    const DECOY_BEFORE = JSON.stringify({ hooks: {}, marker: "untouched" });
    writeFileSync(join(DECOY, "settings.json"), DECOY_BEFORE);

    const r = spawnSync(process.execPath, [join(BUNDLE, "setup", "user-install.mjs"), "--harness", "claude", "--clone-root", BUNDLE],
      { env: { ...process.env, LIVELY_HOME: HOME, CLAUDE_CONFIG_DIR: DECOY }, encoding: "utf8" });
    r.status === 0 ? ok("D1[E4] 설치기 성공") : bad("D1[E4] 설치기 성공", `exit=${r.status} ${r.stderr || r.stdout}`);

    // D4 — 미끼(실 프로필)는 바이트 하나 안 바뀌어야 한다. D5 — 대신 샌드박스 <HOME>/.claude/settings.json 에 배선된다.
    const decoyAfter = readFileSync(join(DECOY, "settings.json"), "utf8");
    decoyAfter === DECOY_BEFORE
      ? ok("D4 ★ LIVELY_HOME 밖의 CLAUDE_CONFIG_DIR(실 프로필)는 무접촉")
      : bad("D4 ★ LIVELY_HOME 밖의 CLAUDE_CONFIG_DIR(실 프로필)는 무접촉", `실 프로필 settings.json 이 바뀜: ${decoyAfter.slice(0, 200)}`);
    const sbSettings = join(HOME, ".claude", "settings.json");
    const sbHooked = existsSync(sbSettings) && readFileSync(sbSettings, "utf8").includes(".lively/hooks/");
    sbHooked ? ok("D5 훅 배선은 샌드박스 <HOME>/.claude/settings.json 으로 감") : bad("D5 훅 배선은 샌드박스 <HOME>/.claude/settings.json 으로 감", `${sbSettings} 없음/미배선`);

    existsSync(join(HOME, ".lively", "hooks", "harness-registry.mjs"))
      ? ok("D2[E3] 레지스트리가 ~/.lively/hooks 에 설치됨")
      : bad("D2[E3] 레지스트리가 ~/.lively/hooks 에 설치됨", "파일 없음 — HOOK_SCRIPTS 등재 누락");

    // ★ 핵심 — 설치된 자리에서 훅을 실제로 실행한다. import 가 안 풀리면 ERR_MODULE_NOT_FOUND 로 죽는다.
    //  토큰이 없으므로 훅은 즉시 exit 0(fail-open) 이어야 한다 — 그게 정상 동작이다.
    const h = spawnSync(process.execPath, [join(HOME, ".lively", "hooks", "sync-harness-assets.mjs")],
      { env: { ...process.env, LIVELY_HOME: HOME, HOME, CLAUDE_CONFIG_DIR: DECOY }, encoding: "utf8", timeout: 20000 });
    if (h.status !== 0) bad("D3[E3·E4] 설치된 훅이 그 자리에서 실행됨", `exit=${h.status} ${String(h.stderr).slice(0, 300)}`);
    else if (/ERR_MODULE_NOT_FOUND|Cannot find module/.test(String(h.stderr))) bad("D3[E3·E4] 설치된 훅이 그 자리에서 실행됨", `모듈 해석 실패: ${String(h.stderr).slice(0, 300)}`);
    else ok("D3[E3·E4] 설치된 훅이 그 자리에서 실행됨");
  } finally { rmSync(SB, { recursive: true, force: true }); }
}

// ── E. 툴 이름(S4) — 엣지 E13~E16 ────────────────────────────────────────────────
//  이 케이스가 없으면 "matcher 를 claude 형태로 박아 두고 다른 하네스에선 한 번도 안 걸리는" 결함이
//  테스트를 통과한다 — codex 때 실제로 겪은 조용한 무력화와 같은 클래스다.
{
  eq("E1[E13] claude MCP matcher", mcpMatcher("claude", "lively"), "mcp__lively__.*");
  eq("E2[E13] codex MCP matcher(claude 와 동일)", mcpMatcher("codex", "lively"), "mcp__lively__.*");
  eq("E3[E14] opencode MCP matcher 는 <server>_", mcpMatcher("opencode", "lively"), "lively_.*");
  eq("E4[E14] opencode MCP 툴 이름", HARNESS.opencode.tools.mcp("lively", "whoami"), "lively_whoami");
  eq("E5[E13] claude MCP 툴 이름", HARNESS.claude.tools.mcp("lively", "whoami"), "mcp__lively__whoami");
  eq("E6[E15] claude 편집 matcher", toolMatcher("claude", "edit"), "Edit|Write|MultiEdit|NotebookEdit");
  eq("E7[E15] codex 편집 matcher", toolMatcher("codex", "edit"), "apply_patch");
  eq("E8[E15] opencode 편집 matcher(소문자)", toolMatcher("opencode", "edit"), "edit|write");
  // 없는 툴은 null — '배선하지 않는다'를 빈 문자열과 구분해야 matcher 가 전체매칭으로 새지 않는다.
  eq("E9[E16] codex 엔 read 툴이 없다(null)", toolMatcher("codex", "read"), null);
  eq("E10[E16] codex 엔 Skill 툴이 없다(null)", toolMatcher("codex", "skill"), null);
  eq("E11[E16] opencode 엔 skill 툴이 있다", toolMatcher("opencode", "skill"), "skill");
  // #1689 — antigravity 의 MCP 는 어댑터 정규화 계약(call_mcp_tool → mcp__<server>__<tool>) 위에서 claude 형이다.
  eq("E12[E33] antigravity MCP matcher(정규화 후 claude 형)", mcpMatcher("antigravity", "lively"), "mcp__lively__.*");
  eq("E13[E33] antigravity 편집 matcher(실측 이름)", toolMatcher("antigravity", "edit"), "write_to_file|replace_file_content");
  eq("E14[E33] antigravity 엔 Skill 툴이 없다(null)", toolMatcher("antigravity", "skill"), null);
}

// ── F. 회수 안전(S5) — 엣지 E17·E18 ──────────────────────────────────────────────
{
  const names = assetDirNames();
  const want = ["skills", "agents", "commands", "prompts", "skill", "agent", "command", "workflows"];
  const miss = want.filter((w) => !names.has(w));
  miss.length ? bad("F1[E17] 회수 화이트리스트가 전 하네스 자산 디렉터리를 덮음", `빠짐: ${miss.join(",")}`)
    : ok("F1[E17] 회수 화이트리스트가 전 하네스 자산 디렉터리를 덮음");
  // 실제 훅이 조립하는 것과 같은 정규식으로 — 자산 경로만 걸리고 남의 경로는 안 걸려야 한다(경로 탈출 방어).
  const re = new RegExp(`[/\\\\](${[...names].join("|")})[/\\\\]`);
  re.test("/h/.claude/skills/x/SKILL.md") ? ok("F2[E18] 자산 경로는 매치") : bad("F2[E18] 자산 경로는 매치", "미매치");
  re.test("/h/.ssh/id_rsa") ? bad("F3[E18] 비자산 경로는 미매치", "매치됨 — 삭제 위험") : ok("F3[E18] 비자산 경로는 미매치");
}

// ── G. 하네스 결정(S6) — 엣지 E19~E23 ────────────────────────────────────────────
{
  eq("G1[E19] argv 우선", resolveHarness(["--harness", "codex"], { LIVELY_HARNESS: "claude" }), "codex");
  eq("G2[E20] env 폴백 + 소문자 정규화", resolveHarness([], { LIVELY_HARNESS: "Codex" }), "codex");
  eq("G3[E21] 둘 다 없으면 claude", resolveHarness([], {}), "claude");
  // ⚠ 모르는 값을 claude 로 **정규화하지 않는다** — 이 값은 매니페스트 키·게이트웨이 질의에 그대로 쓰이므로,
  //  조용히 바꾸면 오타 하나가 '남의 하네스 자산을 내 디스크에 깔았다'가 된다.
  eq("G4[E22] 모르는 값은 그대로 둔다", resolveHarness(["--harness", "opencde"], {}), "opencde");
  eq("G5[E22] isKnownHarness 로 판별", [isKnownHarness("opencode"), isKnownHarness("opencde")], [true, false]);
  eq("G6[E23] 표 조회는 claude 로 폴백", harness("opencde").id, "claude");
}

// ── H. 파생 헬퍼(S4·S6) — 엣지 E24~E27 ───────────────────────────────────────
//  work-flag 가 이 둘로 '작업했나·기록했나'를 판정한다. 틀리면 그 하네스에서만 세션 상태가 **조용히 무음**이
//  되므로(에러도 안 난다) 값 자체를 못박는다.
{
  const edit = allToolNames("edit");
  // E24 합집합 — 어느 하네스에서 온 이름이든 편집으로 인정해야 한다(이름 공간이 겹치지 않아 가산적).
  const wantEdit = ["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch", "edit", "write", "write_to_file", "replace_file_content"];
  const missEdit = wantEdit.filter((t) => !edit.has(t));
  missEdit.length ? bad("H1[E24] 편집 툴 합집합이 전 하네스를 덮음", `빠짐: ${missEdit.join(",")}`)
    : ok("H1[E24] 편집 툴 합집합이 전 하네스를 덮음");
  // 대소문자를 구분해야 한다 — `Write` 와 `write` 는 다른 하네스의 다른 툴이다(둘 다 있어야 한다).
  eq("H2[E24] 대소문자를 구분해 둘 다 보유", [edit.has("Write"), edit.has("write")], [true, true]);

  // E25 MCP 툴 이름 벗기기 — 하네스마다 접두어 형태가 다르다.
  eq("H3[E25] claude 접두어를 벗긴다", mcpToolName("claude", "lively", "mcp__lively__knowledge_save"), "knowledge_save");
  eq("H4[E25] opencode 접두어를 벗긴다", mcpToolName("opencode", "lively", "lively_knowledge_save"), "knowledge_save");
  eq("H5[E25] ext 프록시도 벗긴다(bare 는 __ 형태 유지)", mcpToolName("claude", "lively", "mcp__lively__ext__slack__send"), "ext__slack__send");
  // E26 우리 서버가 아니면 null — '' 를 반환하면 호출부의 `!== null` 판정이 새어 남의 MCP 를 우리 것으로 센다.
  eq("H6[E26] 남의 MCP 는 null", mcpToolName("claude", "lively", "mcp__notion__search"), null);
  eq("H7[E26] 내장 툴은 null", mcpToolName("opencode", "lively", "bash"), null);
  // ⚠ 하네스가 틀리면 접두어가 안 맞아 null 이 된다 — 이게 곧 "matcher 를 잘못 쓰면 무음"의 증거다.
  eq("H8[E26] 하네스가 어긋나면 매칭 안 됨", mcpToolName("opencode", "lively", "mcp__lively__whoami"), null);

  // E27 auto-approve 표면 — 하네스마다 다른 전략 키를 갖는다(같으면 한쪽이 엉뚱한 파일에 쓴다).
  eq("H9[E27] auto-approve kind 가 하네스별로 다름",
    HARNESS_IDS.map((id) => HARNESS[id].autoApprove.kind),
    ["settings-allow", "toml-approval", "config-permission", "agy-settings-allow", "grok-permission-allow"]);
  eq("H10[E27] auto-approve 키 형태", [
    HARNESS.claude.autoApprove.key("lively", "whoami"),
    HARNESS.codex.autoApprove.key("lively", "whoami"),
    HARNESS.opencode.autoApprove.key("lively", "whoami"),
    HARNESS.antigravity.autoApprove.key("lively", "whoami"),
    HARNESS.grok.autoApprove.key("lively", "whoami"),
  ], ["mcp__lively__whoami", "whoami", "lively_whoami", "mcp(lively/whoami)", "MCPTool(lively__whoami)"]);
  // #1689 — 어댑터가 정규화한 이름은 claude 형이므로 mcpToolName 이 그대로 벗겨야 work-flag 기록 인정이 산다.
  eq("H11[E33] antigravity 정규화 이름을 벗긴다", mcpToolName("antigravity", "lively", "mcp__lively__knowledge_save"), "knowledge_save");
}

// ── I. 셸로 오는 편집(#1884) — codex 0.149.1+gpt-5.6 실측: tool_name=Bash · command="apply_patch <<'EOF' …" ──
//  edit 축(툴명)만으론 그 세션의 편집이 전부 셸로 분류된다. editShellRe 축이 있는 하네스에서만 참.
{
  const { isShellEdit, HARNESS } = await import("./harness-registry.mjs");
  const heredoc = "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\nEOF";
  eq("I1 codex Bash apply_patch 히어독 → 편집", isShellEdit("codex", "Bash", { command: heredoc }), true);
  eq("I2 codex Bash 선행 공백 허용", isShellEdit("codex", "Bash", { command: "  apply_patch <<'EOF'\nx\nEOF" }), true);
  eq("I3 codex Bash 인자에만 apply_patch → 아님", isShellEdit("codex", "Bash", { command: "echo apply_patch" }), false);
  eq("I4 codex 배열 command 도 본다", isShellEdit("codex", "Bash", { command: ["apply_patch", "<<'EOF'"] }), true);
  eq("I5 codex apply_patch **툴**은 셸 편집 아님(edit 축 담당)", isShellEdit("codex", "apply_patch", { command: "*** Begin Patch" }), false);
  eq("I6 claude Bash 에 같은 문자열 → 아님(표에 editShellRe 없음)", isShellEdit("claude", "Bash", { command: heredoc }), false);
  eq("I7 입력 없음 → 아님(fail-open)", isShellEdit("codex", "Bash", undefined), false);
  eq("I8 codex 이벤트에 SessionEnd 포함(0.149.1 실측)", HARNESS.codex.events.includes("SessionEnd"), true);
}

console.log(`\n${fail ? "✗" : "✓"} harness-registry: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
