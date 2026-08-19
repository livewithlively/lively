#!/usr/bin/env node
// safeMergeUserSettings 유닛테스트 — dedup 정체성(스크립트 파일명+인자) · 구표기 회수 · 사용자 훅 보존.
//  오프라인·fs-only: 샌드박스 HOME(LIVELY_HOME)/CLAUDE_CONFIG_DIR 에서만 동작, 실제 ~/.claude 무접촉.
//  실행: node kit/setup/user-install.test.mjs  (npm test 체인에 포함)
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIN } from "../testlib/os-sandbox.mjs";

const SANDBOX = mkdtempSync(join(tmpdir(), "ui-test-"));
process.env.LIVELY_HOME = SANDBOX;                       // HOME 리다이렉트(설치기 샌드박스 계약)
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, ".claude"); // settings.json 위치
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
// env 설정 후 동적 import — 모듈 상수(HOME/CLAUDE_DIR/NODEBIN)가 샌드박스 기준으로 굳는다.
const { safeMergeUserSettings, mergeBlocks, userLevelHooksBlock, runnerHooksBlock } = await import("./user-install.mjs");

const SP = join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
const readS = () => JSON.parse(readFileSync(SP, "utf8"));
const countHooks = (s) => Object.values(s.hooks || {}).reduce((n, arr) => n + arr.reduce((m, e) => m + (e.hooks || []).length, 0), 0);
const FULL = () => mergeBlocks(userLevelHooksBlock(), runnerHooksBlock());
const FULL_N = countHooks({ hooks: FULL() }); // 현행 kit 풀세트 크기(전용 7 = session-preload·sync·work-flag×PostToolUse2·SessionStart·SessionEnd·stop-gate + run-custom 이벤트 러너)

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };
const bad = (name, why) => { fail++; console.error(`FAIL ${name} — ${why}`); };

// ① 신규 설치 — 빈 settings 에 풀세트가 깔린다.
writeFileSync(SP, "{}\n");
safeMergeUserSettings(FULL());
let s = readS();
countHooks(s) === FULL_N ? ok(`① 신규 설치 → ${FULL_N}개 배선`) : bad("① 신규 설치", `count=${countHooks(s)}≠${FULL_N}`);

// ② 같은 세대 재설치 — 멱등(개수 불변).
safeMergeUserSettings(FULL());
s = readS();
countHooks(s) === FULL_N ? ok("② 동세대 재설치 멱등") : bad("② 멱등", `count=${countHooks(s)}`);

// ③ 구표기 회수 — 맥미니 실측 레이아웃 재현: 구세대(인터프리터 토큰이 다름, sync 없음 = pre-#636) + 사용자 tmux 훅.
//   재설치 후: 구세대 lively 항목은 전부 최신형으로 교체(중복 0), tmux 는 보존.
//   ⚠ '구표기'를 **플랫폼 고유 문자열**로 정의하면 안 된다(#1510). 종전엔 `"node"`→`node` 치환으로 구세대를
//    만들고 `/^node "/` 로 셌는데, 윈도우의 현행 표기가 이미 `node "…"` 라 ① 치환이 무동작이 되고(구세대가
//    안 만들어짐) ② 판정은 **현행 표기를 구표기로 오인**했다. 그래서 아래처럼 정의한다:
//      · 구세대 만들기 = 정체성(스크립트+인자)은 그대로 두고 **인터프리터 토큰만** 바꾼다 → 두 플랫폼 공통.
//      · 구표기 세기 = "kit 훅인데 현행 command 집합에 없는 것" → 표기 규칙을 아예 안 가정한다.
const LEGACY_NODE = WIN ? '"%LOCALAPPDATA%\\lively\\runtime\\node.exe"' : "node";
const toOldForm = (cmd) => cmd.replace(/^("[^"]*"|\S+)/, LEGACY_NODE);
const oldGen = {};
for (const [ev, entries] of Object.entries(FULL())) {
  oldGen[ev] = entries
    .filter((e) => !JSON.stringify(e).includes("sync-harness-assets")) // 구세대엔 sync 배선 없음
    .map((e) => ({ ...e, hooks: e.hooks.map((h) => ({ ...h, command: toOldForm(h.command) })) }));
}
// 배선 — 픽스처가 실제로 '다른 표기'를 만들었나. 무동작이면 ③ 은 아무것도 검증하지 않는다(종전 윈도우가 그랬다).
{
  const before = FULL().Stop[0].hooks[0].command;
  before !== toOldForm(before)
    ? ok("③ 배선 — 구세대 픽스처가 현행과 다른 표기를 만든다")
    : bad("③ 배선", `구세대 변환이 무동작 — 이 케이스는 공허하다: ${before}`);
}
const FULL_CMDS = new Set(Object.values(FULL()).flatMap((arr) => arr.flatMap((e) => (e.hooks || []).map((h) => h.command))));
const isKitCmd = (c) => /[/\\]\.lively[/\\]hooks[/\\]/.test(c);
oldGen.Stop = [{ hooks: [{ type: "command", command: 'tmux display-message "done" || true' }] }, ...(oldGen.Stop || [])];
writeFileSync(SP, JSON.stringify({ hooks: oldGen }, null, 2) + "\n");
safeMergeUserSettings(FULL());
s = readS();
const cmds = Object.values(s.hooks).flatMap((arr) => arr.flatMap((e) => (e.hooks || []).map((h) => h.command)));
const oldForm = cmds.filter((c) => isKitCmd(c) && !FULL_CMDS.has(c)).length;
const tmuxKept = cmds.some((c) => c.startsWith("tmux "));
if (oldForm === 0 && tmuxKept && countHooks(s) === FULL_N + 1) ok(`③ 구표기 ${FULL_N - 1}개 회수·교체 + 사용자 훅 보존 (${FULL_N}+tmux)`);
else bad("③ 구표기 회수", `oldForm=${oldForm} tmux=${tmuxKept} count=${countHooks(s)}≠${FULL_N + 1}`);

// ④ 이미 중복 누적된 상태(구+신 공존) — 재설치가 구세대만 걷어내고 한 벌로 수렴.
const doubled = {};
for (const [ev, entries] of Object.entries(FULL())) {
  doubled[ev] = [...(oldGen[ev] || []).filter((e) => (e.hooks || []).every((h) => !h.command.startsWith("tmux"))), ...entries];
}
doubled.Stop.unshift({ hooks: [{ type: "command", command: 'tmux display-message "done" || true' }] });
writeFileSync(SP, JSON.stringify({ hooks: doubled }, null, 2) + "\n");
safeMergeUserSettings(FULL());
s = readS();
countHooks(s) === FULL_N + 1 ? ok("④ 기중복 상태 → 한 벌로 수렴(+사용자 훅)") : bad("④ 기중복 수렴", `count=${countHooks(s)}≠${FULL_N + 1}`);

// ④-b **표기까지 똑같은** 중복 (#1510) — ④ 와 다른 사고다. ④ 의 중복은 구세대라 '표기가 달라서' 걸러진다.
//   표기가 같은 중복은 종전 구현에서 **영영 안 줄었다**(동일본을 전부 유지 → 재설치해도 훅이 툴콜마다 2회 실행).
//   POSIX 에선 픽스처가 늘 표기를 바꿔 왔기 때문에 이 구멍이 한 번도 드러나지 않았다.
const dupBlocks = (n, extra = {}) => {
  const h = {};
  for (const [ev, entries] of Object.entries(FULL())) {
    h[ev] = entries.flatMap((e) => Array.from({ length: n }, () => JSON.parse(JSON.stringify(e))));
  }
  for (const [ev, entries] of Object.entries(extra)) h[ev] = [...entries, ...(h[ev] || [])];
  return h;
};
const mergeInto = (blocks) => { writeFileSync(SP, JSON.stringify({ hooks: blocks }, null, 2) + "\n"); safeMergeUserSettings(FULL()); return readS(); };

// F1 동일 2벌 → 1벌
s = mergeInto(dupBlocks(2));
countHooks(s) === FULL_N ? ok("④-b F1 동일 표기 2벌 → 한 벌로 수렴") : bad("④-b F1", `count=${countHooks(s)}≠${FULL_N}`);

// F2 경계 — 2벌만이 아니라 3벌도(=2 이상 전부) 한 벌로
s = mergeInto(dupBlocks(3));
countHooks(s) === FULL_N ? ok("④-b F2 동일 표기 3벌 → 한 벌로 수렴(경계)") : bad("④-b F2", `count=${countHooks(s)}≠${FULL_N}`);

// F4 동일 2벌 + **같은 matcher** 의 사용자 훅(tmux) → kit 은 한 벌, 사용자 훅은 보존
s = mergeInto(dupBlocks(2, { Stop: [{ hooks: [{ type: "command", command: 'tmux display-message "done" || true' }] }] }));
{
  const cmds2 = Object.values(s.hooks).flatMap((arr) => arr.flatMap((e) => (e.hooks || []).map((h) => h.command)));
  countHooks(s) === FULL_N + 1 && cmds2.some((c) => c.startsWith("tmux "))
    ? ok("④-b F4 동일 2벌 + 같은 matcher 사용자 훅 → kit 한 벌 + 사용자 훅 보존")
    : bad("④-b F4", `count=${countHooks(s)}≠${FULL_N + 1} tmux=${cmds2.some((c) => c.startsWith("tmux "))}`);
}

// F5 동일 2벌 + **다른 matcher** 로 사용자가 직접 건 kit-경로 훅 → 그 항목은 불변
s = mergeInto(dupBlocks(2, { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$HOME/.lively/hooks/work-flag.mjs"' }] }] }));
countHooks(s) === FULL_N + 1 && (s.hooks.PostToolUse || []).some((e) => e.matcher === "Bash")
  ? ok("④-b F5 동일 2벌 + 다른 matcher 의 kit-경로 훅 → kit 한 벌 + 그 항목 보존")
  : bad("④-b F5", `count=${countHooks(s)}≠${FULL_N + 1}`);

// F6 경계 — 중복이 아예 없으면 그대로(수렴 로직이 정상 항목을 먹지 않는다)
s = mergeInto(dupBlocks(1));
countHooks(s) === FULL_N ? ok("④-b F6 중복 없음 → 그대로 한 벌(멱등 무회귀)") : bad("④-b F6", `count=${countHooks(s)}≠${FULL_N}`);

// ⑤ 사용자가 같은 스크립트를 다른 matcher 로 직접 배선한 항목 — 정체성이 같아도 matcher 가 다르면 불변.
const custom = { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "$HOME/.lively/hooks/work-flag.mjs"' }] }] };
writeFileSync(SP, JSON.stringify({ hooks: custom }, null, 2) + "\n");
safeMergeUserSettings(FULL());
s = readS();
const bashKept = (s.hooks.PostToolUse || []).some((e) => e.matcher === "Bash");
bashKept ? ok("⑤ 다른 matcher 의 동일 스크립트 항목 보존") : bad("⑤ matcher 격리", "Bash 항목 소실");

// ⑥ 심링크 경로 직접 실행 — macOS /tmp(→/private/tmp) 재현: 설치기 main 이 실제로 돌아야 한다(v0.1.131 회귀 방지).
//   가드가 URL 문자열 비교면 심링크에서 main 이 조용히 스킵돼 설치가 no-op 이 된다.
{
  const { symlinkSync, cpSync, existsSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const HERE = join(fileURLToPath(import.meta.url), "..");
  const box = mkdtempSync(join(tmpdir(), "ui-sym-"));
  const bundle = join(box, "real", "bundle");
  mkdirSync(join(bundle, ".claude", "hooks"), { recursive: true });
  cpSync(join(HERE, "..", "hooks"), join(bundle, ".claude", "hooks"), { recursive: true });
  cpSync(HERE, join(bundle, "setup"), { recursive: true });
  symlinkSync(join(box, "real"), join(box, "link"));
  const home = join(box, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
  execFileSync(process.execPath, [join(box, "link", "bundle", "setup", "user-install.mjs"), "--harness", "claude", "--clone-root", join(box, "link", "bundle")],
    { env: { ...process.env, LIVELY_HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") }, stdio: "ignore" });
  const after = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  const n = countHooks(after);
  const hooksInstalled = existsSync(join(home, ".lively", "hooks", "sync-harness-assets.mjs"));
  n > 0 && hooksInstalled ? ok(`⑥ 심링크 경로 실행에도 main 수행 (${n}개 배선+러너 설치)`) : bad("⑥ 심링크 직접실행", `count=${n} hooks=${hooksInstalled}`);
  rmSync(box, { recursive: true, force: true });
}

// ⑦ CLI 모듈 배선 완결성(#905 회귀 방지) — 프로덕션 cli/*.mjs 는 하나도 빠짐없이
//   발행(build-context publish)·설치(user-install installCli) 두 매니페스트 모두에 있어야 한다.
//   빠지면 그 모듈을 static import 하는 엔트리포인트(예: lively-mcp-local.mjs → project-init-core.mjs)가
//   부팅 즉시 죽어 `lively mcp-local`(lively-local MCP) 이 통째로 못 뜬다.
{
  const { readdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const HERE = join(fileURLToPath(import.meta.url), "..");          // kit/setup
  const KIT = join(HERE, "..");                                     // kit
  const installSrc = readFileSync(join(HERE, "user-install.mjs"), "utf8");
  const buildCtxSrc = readFileSync(join(KIT, "generator", "build-context.mjs"), "utf8");
  const cliMods = readdirSync(join(KIT, "cli")).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
  const missing = [];
  for (const m of cliMods) {
    if (!installSrc.includes(m)) missing.push(`user-install(installCli): ${m}`);
    if (!buildCtxSrc.includes(m)) missing.push(`build-context(publish): ${m}`);
  }
  missing.length === 0
    ? ok(`⑦ CLI 모듈 배선 완결 — ${cliMods.length}개 모두 발행·설치 매니페스트 포함`)
    : bad("⑦ CLI 모듈 배선 누락", missing.join(" · "));
}

// ⑧ #1043 — SessionEnd 러너 엔트리는 **명시 timeout** 을 가져야 한다. Claude Code 는 SessionEnd 훅에 `timeout`
//   미선언 시 floor 1500ms 만 주는데(claude 2.1.x getSessionEndHookTimeoutMs), run-custom 이 SessionEnd 에서
//   게이트웨이 fetch(org 훅 조회)를 하다 그 1500ms 를 넘기면 AbortSignal 로 잘려 "SessionEnd hook … failed:
//   Hook cancelled" 워닝이 뜬다. 명시 timeout(초)이 그 상한을 올린다 — 이 배선이 사라지면 워닝이 재발한다.
{
  const t = runnerHooksBlock().SessionEnd?.[0]?.hooks?.[0]?.timeout;
  (typeof t === "number" && t >= 5)   // 1500ms(=1.5s) floor 를 넉넉히 넘겨야 조기 abort 를 벗어난다
    ? ok(`⑧ SessionEnd 러너 timeout=${t}s (Claude Code floor 1500ms 회피, #1043)`)
    : bad("⑧ SessionEnd timeout 누락", `timeout=${t} — floor 1500ms 로 run-custom 이 조기 abort → "Hook cancelled"(#1043)`);
}

// ⑨ #1043 — 회수(reclaim)는 전문(timeout 포함) 변경도 반영한다: 같은 command 인데 timeout 만 다른 구(舊)엔트리가
//   이미 설치돼 있으면(예: SessionEnd 에 timeout 이 없던 기존 멤버) 재설치가 그것을 **최신형으로 교체**해야 한다.
//   종전 dedup 은 command 문자열만 봐서 timeout 변경이 영영 반영되지 않았다(같은 command → dup 스킵).
{
  const full = FULL();
  const stripped = {};                         // SessionEnd 만 timeout 을 뗀 '구 세대' settings 재현
  for (const [ev, entries] of Object.entries(full)) {
    stripped[ev] = entries.map((e) => ({ ...e, hooks: e.hooks.map((h) => { const { timeout, ...rest } = h; return ev === "SessionEnd" ? rest : h; }) }));
  }
  writeFileSync(SP, JSON.stringify({ hooks: stripped }, null, 2) + "\n");
  safeMergeUserSettings(full);
  s = readS();
  const seHooks = (s.hooks.SessionEnd || []).flatMap((e) => e.hooks || []);
  // #1059: SessionEnd 는 여러 엔트리(run-custom + work-flag)일 수 있다 — 개수 고정이 아니라 '원하는 것 전부가 timeout 까지 일치'로 본다.
  const wantSE = full.SessionEnd.flatMap((e) => e.hooks || []);
  const seOk = seHooks.length === wantSE.length
    && wantSE.every((wh) => seHooks.some((h) => h.command === wh.command && h.timeout === wh.timeout));
  seOk ? ok("⑨ timeout 만 바뀐 구엔트리도 최신형으로 회수·교체(+중복 없음)")
    : bad("⑨ timeout 회수", `SessionEnd hooks=${JSON.stringify(seHooks)} want=${JSON.stringify(wantSE)}`);
}

// ⑩⑪⑫ #1059 — 세션 라이프사이클 배선이 user-level 블록에 있어야 한다(정밀복원 UUID + 정상종료 표시).
{
  const blk = userLevelHooksBlock();
  const wf = (entries) => (entries || []).filter((e) => (e.hooks || []).some((h) => typeof h.command === "string" && h.command.includes("work-flag.mjs")));
  const ssWF = wf(blk.SessionStart);
  const seWF = wf(blk.SessionEnd);
  ssWF.length ? ok("⑩ SessionStart 에 work-flag 배선(편집·MCP 없는 대화도 UUID 매핑 → 정밀복원)")
    : bad("⑩ SessionStart work-flag", "배선 없음 — 대화만 한 세션은 복원이 picker 로 폴백");
  seWF.length ? ok("⑪ SessionEnd 에 work-flag 배선(정상종료 → '종료됨' 구분)")
    : bad("⑪ SessionEnd work-flag", "배선 없음 — /exit 이 재부팅 중단과 구분 안 됨");
  // 종료 경로라 timeout 명시 필수(미지정 시 floor 1500ms 로 잘려 fetch 조기 abort — #1043 주석).
  const seTimeoutOk = seWF.length > 0 && seWF.every((e) => (e.hooks || []).every((h) => !(h.command || "").includes("work-flag.mjs") || (typeof h.timeout === "number" && h.timeout > 0)));
  seTimeoutOk ? ok("⑫ SessionEnd work-flag timeout 명시")
    : bad("⑫ SessionEnd timeout", "미지정 — 종료 경로에서 floor 1500ms 로 fetch 조기 abort");
}

// ⑬ ★ 2026-08-19 실측 — LIVELY_HOME(샌드박스) 밖의 CLAUDE_CONFIG_DIR 는 상속된 **실 프로필**이다. 설치기가 그걸 존중하면
//   실 프로필 settings.json 에 곧 지워질 샌드박스 훅 경로가 써져(harness-registry.test D 가 실제로 냈던 사고) 이후 모든 세션 훅이
//   Cannot find module 로 죽는다. 설치기는 밖의 값을 무시하고 <LIVELY_HOME>/.claude 에 써야 한다(harness-registry.claudeConfigDir 계약).
{
  const { cpSync, existsSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const HERE = join(fileURLToPath(import.meta.url), "..");
  const box = mkdtempSync(join(tmpdir(), "ui-leak-"));
  const bundle = join(box, "bundle");
  mkdirSync(join(bundle, ".claude", "hooks"), { recursive: true });
  cpSync(join(HERE, "..", "hooks"), join(bundle, ".claude", "hooks"), { recursive: true });
  cpSync(HERE, join(bundle, "setup"), { recursive: true });
  const home = join(box, "home");                 // 샌드박스 HOME
  const decoy = join(box, "real-profile");        // 샌드박스 HOME **밖** — 실 프로필 흉내
  mkdirSync(home, { recursive: true }); mkdirSync(decoy, { recursive: true });
  const before = JSON.stringify({ hooks: {}, marker: "untouched" });
  writeFileSync(join(decoy, "settings.json"), before);
  execFileSync(process.execPath, [join(bundle, "setup", "user-install.mjs"), "--harness", "claude", "--clone-root", bundle],
    { env: { ...process.env, LIVELY_HOME: home, CLAUDE_CONFIG_DIR: decoy }, stdio: "ignore" });
  const decoyAfter = readFileSync(join(decoy, "settings.json"), "utf8");
  const sb = join(home, ".claude", "settings.json");
  const sbHooks = existsSync(sb) ? countHooks(JSON.parse(readFileSync(sb, "utf8"))) : 0;
  decoyAfter === before && sbHooks > 0
    ? ok(`⑬ ★ LIVELY_HOME 밖 CLAUDE_CONFIG_DIR(실 프로필) 무접촉 · 샌드박스 .claude 에 ${sbHooks}개 배선`)
    : bad("⑬ ★ 샌드박스 밖 CLAUDE_CONFIG_DIR 누수", `decoyChanged=${decoyAfter !== before} sbHooks=${sbHooks}`);
  rmSync(box, { recursive: true, force: true });
}

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`user-install tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);
