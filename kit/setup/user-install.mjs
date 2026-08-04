#!/usr/bin/env node
// 발행물 동봉 user-level 설치기 (self-contained, 제품 kit 미의존 — D2/D3 헤드라인).
// "/install 번들 → setup → 어느 폴더에서든 작동" 경로를 번들 자산만으로 완성한다.
//   ※ kit(workflow-std) 의 adapters/claude/install.mjs 가 하는 일을, 발행물 안의 자산만으로 재현.
//   ※ generator/build-context.mjs publish() 가 이 파일을 setup/ 에 복사해 넣는다(소스는 kit, 발행물은 사본).
//
// 하는 일(전부 idempotent, 절대 LLM/모델 호출 없음):
//  (a) ~/.lively/context.md   ← 발행물 AGENTS.md 의 선두 HEADER 주석 제거본(= buildStaticContext 동일 출력)
//  (b) ~/.lively/org-name     ← 발행물 .lively-org-name (preload 라이브 헤더용)
//  (c) ~/.lively/hooks/*.mjs  ← 발행물 .claude/hooks/*.mjs 복사(chmod 755)
//  (d) ~/.claude/settings.json ← SAFE-MERGE: user-level 절대경로 훅 블록 비파괴 머지(백업 먼저)
//  (e) ~/.lively/work-roots   ← --work-root 시드(없을 때만, 기존 보존)
//  (f) ~/.lively/lib+bin      ← lively CLI + 런처 심 + PATH rc 배선 (#864 — installCli)
//  MCP 등록은 `lively install`(CLI) 또는 박스의 register-clients.sh 가 담당(여기서 호출 안 함).
//
// 사용법(보통은 `lively install` 또는 deploy/install-kit.sh 가 호출): node setup/user-install.mjs [--harness claude|codex|claude,codex] [--work-root <abs>]…
//   --clone-root <dir> 로 발행물 루트 지정(기본: 이 스크립트의 ../). --harness 미지정 시 claude.
//   Codex(--harness codex): 같은 ~/.lively 자산 + ~/.codex/config.toml([hooks]+[mcp_servers.*]) + ~/.codex/AGENTS.md.
//     **codex 배선의 정본은 이 파일 하나다** — adapters/codex/install.mjs 라는 형제 설치기가 있었지만 아무도
//     호출하지 않는 죽은 코드였고, 개선이 거기 들어가 실배포엔 안 나가는 사고를 만들어 #1475 에서 삭제했다.
//     배선 사양은 setup/codex-wiring.test.mjs 가 claude 와의 패리티로 못박는다.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, chmodSync, realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WORK_ROOTS_HEADER } from "./work-roots-header.mjs";

const args = process.argv.slice(2);
const getOpt = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : null; };
// HOME: 기본 OS homedir(), env LIVELY_HOME 로 리다이렉트 가능(샌드박스 격리 — user-uninstall 과 동일 계약).
//  ※ install/uninstall 대칭: 라운드트립 테스트 시 양쪽에 같은 LIVELY_HOME 을 지정해야 한쪽만 라이브에 닿는 footgun 을 막는다.
const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
const CODEX = join(HOME, ".codex");
// settings.json 위치: CLAUDE_CONFIG_DIR 있으면 그 dir(프로필별 계정 격리 — 멀티프로필 #346), 없으면 <HOME>/.claude(기본, 무변경).
//  ~/.lively(컨텍스트·훅·토큰)는 HOME 기준 유지 = 프로필 간 공유(훅 command 는 런타임 $HOME/.lively 참조).
//  계정별로 달라지는 건 settings(훅·권한)·MCP(.claude.json)·자격증명(.credentials.json)뿐 — 전부 CLAUDE_CONFIG_DIR 안.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
// self-update.mjs(#858)는 settings 에 **배선하지 않는다** — 훅이 아니라 session-preload 가 detached 로 띄우는
//  백그라운드 업데이터다(세션 시작마다 프로세스를 하나 더 띄우지 않기 위함). 파일만 ~/.lively/hooks 에 놓는다.
const HOOK_SCRIPTS = ["session-preload.mjs", "work-flag.mjs", "stop-writeback-gate.mjs", "run-custom.mjs", "sync-harness-assets.mjs", "self-update.mjs"];

// 발행물 루트: --clone-root 우선, 없으면 이 스크립트의 ../ (setup/ 의 부모).
const CLONE_ROOT = resolve(getOpt("--clone-root") || join(dirname(fileURLToPath(import.meta.url)), ".."));
const cloneAbs = (p) => join(CLONE_ROOT, p);

// 훅 커맨드 — 플랫폼별로 동작하는 형태를 쓴다(기존 맥 설치와 문자열 동일 유지 = 재설치 idempotency 키 안정,
//  중복 훅 방지). Windows 는 $HOME 셸확장/`env` 프리픽스가 안 먹으므로 forward-slash 절대경로 + argv 하네스.
//  node 는 Windows 에서도 forward-slash 경로를 받는다. 제거 매칭은 '.lively/hooks/' 부분문자열(양쪽 다 포함).
const fwd = (p) => p.replace(/\\/g, "/");
const hookAbs = (script) => fwd(join(LIVELY, "hooks", script));
const WIN = process.platform === "win32";
// #355: 훅은 하네스가 실행하는 셸의 PATH 로 `node` 를 찾는다 → node 를 갓 설치했거나 rc 를 아직 source 안 한
//  셸에서 claude/codex 를 켜면 'node: command not found' 로 훅이 죽는다(페르소나 미주입·Stop 게이트 무작동).
//  부트스트랩한 번들 node(~/.lively/runtime/current/bin/node — 안정 심링크)가 있으면 그 절대경로로 호출해
//  실행 셸 PATH 와 무관하게 만든다. 없으면(시스템 node) 기존대로 PATH 의 `node`. (Windows 는 User PATH 로 처리 — bare 유지.)
const bundledNode = join(LIVELY, "runtime", "current", "bin", "node");
const NODEBIN = (!WIN && existsSync(bundledNode)) ? bundledNode : "node";
const hookCmd = (script) => WIN ? `node "${hookAbs(script)}"` : `"${NODEBIN}" "$HOME/.lively/hooks/${script}"`;
// 커스텀 훅 런너 — 이벤트당 고정 엔트리 1개(커스텀 훅 자체는 런너가 런타임에 fetch). 이벤트는 argv 로 전달.
const hookCmdRunner = (event) => WIN ? `node "${hookAbs("run-custom.mjs")}" ${event}` : `"${NODEBIN}" "$HOME/.lively/hooks/run-custom.mjs" ${event}`;

// settings-hooks.json 이 발행물에 없을 수 있으니, user-level 훅 블록을 코드로 구성(어댑터와 동일 형태).
function userLevelHooksBlock() {
  return {
    SessionStart: [
      { matcher: "startup|resume|clear", hooks: [{ type: "command", command: hookCmd("session-preload.mjs") }] },
      { matcher: "startup|resume|clear", hooks: [{ type: "command", command: hookCmd("sync-harness-assets.mjs") }] },
      // #1059 정밀복원 — claude 세션 UUID 를 **세션 시작마다** 게이트웨이에 매핑(box-id↔UUID). PostToolUse(편집·MCP)만으론
      //  편집·MCP 없는 대화가 UUID 를 못 보고해 복원이 picker 로 폴백했다 → 시작 이벤트에서 툴 무관하게 보고(work-flag 의 UUID 블록).
      { matcher: "startup|resume|clear", hooks: [{ type: "command", command: hookCmd("work-flag.mjs") }] },
    ],
    // #1059 — 사용자 정상 종료(/exit·logout)를 게이트웨이에 알려 복원목록에서 '종료됨'으로 구분. ⚠ timeout 명시(5s): SessionEnd 는
    //  종료 경로라 미선언 시 floor 1500ms 로 잘려(#1043 주석 참조) fetch 가 조기 abort 될 수 있다.
    SessionEnd: [
      { hooks: [{ type: "command", command: hookCmd("work-flag.mjs"), timeout: 5 }] },
    ],
    PostToolUse: [
      // 우리 서버 한정 유지(#906) — ext__ 프록시는 mcp__lively__ext__… 라 이 matcher 로 이미 잡힌다.
      //  구성원이 자기 하네스에 직접 단 MCP(mcp__<server>__…)까지 보려면 matcher 를 넓혀야 하는데, 넓히면 **모든** MCP
      //  호출마다 훅이 스폰된다(실측 46ms/회 — playwright 200콜이면 ~9s). 그래서 확대는 보류하고, 넓힐 땐 matcher 를
      //  pull_tools 에서 파생해 '관리자가 적은 서버만' 뜨게 하는 게 맞다(후속 태스크 — 매처 회수 설계 동반 필요).
      { matcher: "mcp__lively__.*", hooks: [{ type: "command", command: hookCmd("work-flag.mjs") }] },
      { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: hookCmd("work-flag.mjs") }] },
    ],
    // #1221 세션 실행 단계 보고 — 턴 시작(UserPromptSubmit)·확인 필요(Notification)·턴 종료(Stop). 이 셋이 붙어야
    //  게이트웨이가 화면 스크래핑(스피너 유니코드·capture-pane 패턴)을 안 하고도 '작업 중/확인 필요/대기 중'을 안다.
    //  ⚠ Notification 에 matcher(타입)를 걸지 않는다 — 타입 matcher 를 모르는 구 빌드에서 엔트리가 통째로 안 걸리면
    //   조용히 죽는다. 어느 알림인지는 훅이 페이로드로 판별한다(구·신 형식 모두).
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: hookCmd("work-flag.mjs") }] },
    ],
    Notification: [
      { hooks: [{ type: "command", command: hookCmd("work-flag.mjs") }] },
    ],
    Stop: [
      { hooks: [{ type: "command", command: hookCmd("stop-writeback-gate.mjs") }] },
      { hooks: [{ type: "command", command: hookCmd("work-flag.mjs") }] },
    ],
  };
}

// 커스텀 훅 런너 — 이벤트당 고정 엔트리(런너가 런타임에 fetch·실행). 커스텀 훅 추가/삭제는 settings 재작성 불요.
function runnerHooksBlock() {
  const entry = (event, matcher, timeout) => {
    const hook = { type: "command", command: hookCmdRunner(event) };
    if (timeout) hook.timeout = timeout;   // 초 단위(하네스 계약). 대부분 이벤트는 미지정=하네스 기본(60s)이면 충분.
    return matcher ? { matcher, hooks: [hook] } : { hooks: [hook] };
  };
  return {
    SessionStart: [entry("SessionStart", "startup|resume|clear")],
    // ⚠ SessionEnd 만 명시 timeout — 종료(shutdown) 경로라 Claude Code 는 `timeout` 미선언 시 **floor 1500ms** 만 준다
    //  (claude 2.1.x getSessionEndHookTimeoutMs: env CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS 없으면 max(1500, 설정훅 timeout)).
    //  run-custom 은 SessionEnd 에서 게이트웨이 fetch(org 훅 조회)를 하는데 **원격 게이트웨이면 그 왕복이 1500ms 를 넘겨**
    //  AbortSignal 로 잘리고 "SessionEnd hook … failed: Hook cancelled" 워닝이 뜬다(#1043). 명시 timeout 을 주면 그 값
    //  (×1000ms, ≤60s ceiling)으로 상향된다. run-custom 은 자체 상한(fetch 3s·훅 SIGKILL·항상 process.exit)이 있어
    //  실제로는 대개 <200ms 에 끝나므로 이 값을 키워도 종료가 느려지지 않는다(hang 방지가 아니라 조기 abort 방지가 목적).
    SessionEnd: [entry("SessionEnd", null, 10)],
    UserPromptSubmit: [entry("UserPromptSubmit")],
    PreToolUse: [entry("PreToolUse", ".*")],
    PostToolUse: [entry("PostToolUse", ".*")],
    Stop: [entry("Stop")],
    SubagentStop: [entry("SubagentStop")],
    Notification: [entry("Notification")],
    PreCompact: [entry("PreCompact")],
    PostCompact: [entry("PostCompact")],
  };
}

// 같은 이벤트 키를 가진 훅 블록들을 합친다(배열 concat). dedup 은 safeMergeUserSettings 가 command+matcher 로 수행.
function mergeBlocks(...blocks) {
  const out = {};
  for (const b of blocks) for (const [ev, entries] of Object.entries(b)) out[ev] = (out[ev] || []).concat(entries);
  return out;
}

// auto-approve — 발행 묶음 .lively/auto-approve.json 의 'mcp__lively__<tool>' 목록을 settings.json
//  permissions.allow 에 반영. 멤버 본인 항목은 보존, 이전에 lively 가 넣은 것 중 빠진 건 회수(reconcile).
function mergeAutoApprove() {
  let want = [];
  try {
    const d = JSON.parse(readFileSync(cloneAbs(join(".lively", "auto-approve.json")), "utf8"));
    want = Array.isArray(d.allow) ? d.allow.filter((s) => typeof s === "string") : [];
  } catch { return; } // 번들에 없으면(구버전) 스킵
  const sp = join(CLAUDE_DIR, "settings.json");
  let cur = {};
  try { if (existsSync(sp)) cur = JSON.parse(readFileSync(sp, "utf8")); } catch { return; }
  if (!cur || typeof cur !== "object" || Array.isArray(cur)) return;
  cur.permissions = (cur.permissions && typeof cur.permissions === "object" && !Array.isArray(cur.permissions)) ? cur.permissions : {};
  const allow = Array.isArray(cur.permissions.allow) ? cur.permissions.allow : [];
  const prevPath = join(LIVELY, "managed-auto-approve.json");
  let prev = []; try { prev = JSON.parse(readFileSync(prevPath, "utf8")); if (!Array.isArray(prev)) prev = []; } catch { /* */ }
  const wantSet = new Set(want); const prevSet = new Set(prev);
  // 이전 lively 항목 중 더는 원치 않는 것 제거(멤버가 직접 넣은 건 prevSet 밖이라 보존).
  let next = allow.filter((e) => !(prevSet.has(e) && !wantSet.has(e)));
  for (const e of want) if (!next.includes(e)) next.push(e);
  cur.permissions.allow = next;
  try {
    writeFileSync(sp, JSON.stringify(cur, null, 2) + "\n");
    writeFileSync(prevPath, JSON.stringify(want, null, 2)); chmodSync(prevPath, 0o600);
  } catch (e) { console.warn(`  ⚠️ auto-approve 반영 실패: ${e.message}`); return; }
  console.log(`  ✓ ${sp} (auto-approve ${want.length}건 반영)`);
}

function safeMergeUserSettings(blockHooks) {
  const settingsPath = join(CLAUDE_DIR, "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  let cur = {};
  if (existsSync(settingsPath)) {
    const backupDir = join(LIVELY, "backups");
    mkdirSync(backupDir, { recursive: true });
    try { copyFileSync(settingsPath, join(backupDir, "settings.json.bak")); }
    catch (e) { console.error(`✗ ~/.claude/settings.json 백업 실패 — 중단: ${e.message}`); process.exit(1); }
    try { cur = JSON.parse(readFileSync(settingsPath, "utf8")); }
    catch { console.warn("  ⚠️ ~/.claude/settings.json JSON 파싱 실패 — hooks 머지 건너뜀(기존 파일 무수정)"); return; }
  }
  if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
    console.warn("  ⚠️ ~/.claude/settings.json 가 객체가 아님 — hooks 머지 건너뜀"); return;
  }
  cur.hooks = cur.hooks && typeof cur.hooks === "object" && !Array.isArray(cur.hooks) ? cur.hooks : {};
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // lively kit 훅의 정체성 = 스크립트 파일명(+인자) — command 전문이 아니다. command 표기는 설치 세대에 따라
  //  흔들린다(`node` vs `"node"` vs 번들 런타임 절대경로, POSIX $HOME vs Windows 절대경로). 전문 일치로만 dedup 하면
  //  세대가 바뀔 때마다 같은 훅이 한 벌씩 누적된다(맥미니 실측 15→30, 전 훅 이벤트당 2회 실행). 그래서 같은
  //  (정체성, matcher)의 구표기 lively 항목은 최신 command 로 교체(회수)한다. 사용자 고유 훅(비 .lively/hooks)은 불변.
  const kitHookId = (cmd) => {
    const m = typeof cmd === "string" ? cmd.match(/[/\\]\.lively[/\\]hooks[/\\]([^"'\s]+)['"]?\s*(.*)$/) : null;
    return m ? `${m[1]}|${m[2].trim()}` : null;
  };
  // ⚠ 아래 회수는 **matcher 가 같을 때만** 구표기를 걷는다. 그래서 kit 이 어떤 훅의 matcher 자체를 바꾸면(예 확대)
  //  구항목이 '다른 matcher'라 살아남아 같은 훅이 두 벌 등록되고 툴마다 2회 실행된다 — 위 15→30 누적과 같은 사고다.
  //  matcher 를 바꾸는 변경은 그 회수 설계(우리가 쓴 엔트리 ↔ 사용자가 쓴 엔트리 구분)를 반드시 동반해야 한다.
  for (const [event, entries] of Object.entries(blockHooks)) {
    let arr = Array.isArray(cur.hooks[event]) ? cur.hooks[event] : [];
    for (const entry of entries) {
      const matcher = entry.matcher ?? null;
      const ids = new Set(entry.hooks.map((h) => kitHookId(h.command)).filter(Boolean));
      // 회수 — 같은 (정체성, matcher)의 lively 항목을 **전문(command·timeout 등)이 최신과 다르면** 걷어내고
      //  아래에서 최신형으로 교체한다. 종전엔 command **문자열**이 다를 때만 회수했는데(구표기 전용), 그러면
      //  command 는 그대로고 timeout 만 바뀐 변경(#1043 — SessionEnd 조기 abort 방지용 timeout 추가)이 이미
      //  설치된 멤버에게 영영 반영되지 않았다(같은 command → dup 로 스킵). 전문 비교로 넓힌다(멱등: 동일하면 유지).
      arr = arr.filter((e) => {
        if (!same(e.matcher ?? null, matcher)) return true;              // matcher 다르면 사용자 항목 — 불변(테스트 ⑤)
        const hs = e.hooks ?? [];
        if (!hs.length) return true;
        const isKitEntry = hs.every((h) => { const id = kitHookId(h.command); return id && ids.has(id); });
        if (!isKitEntry) return true;                                    // 우리 훅 아님(사용자 tmux 등)·정체성 불일치 — 보존
        return same(e, entry);                                           // 우리 훅: 최신과 동일할 때만 유지, 다르면 회수
      });
      if (!arr.some((e) => same(e, entry))) arr.push(entry);             // 동일본 없으면 최신형 배치
    }
    cur.hooks[event] = arr;
  }
  writeFileSync(settingsPath, JSON.stringify(cur, null, 2) + "\n");
  console.log(`  ✓ ${settingsPath} (user-level hooks 비파괴 머지, 절대경로)`);
}

// ── lively CLI (#864) — ~/.lively/lib/lively.mjs + ~/.lively/bin/lively(런처 심) + PATH 배선 ──────
//  CLI 는 번들(cli/lively.mjs)로 온다 → kit_version 지문에 포함 → **자동 업데이트가 CLI 도 함께 갱신**한다.
//  ⚠ 심 내용은 kit/cli/bootstrap.sh 가 만드는 것과 **바이트 동일**해야 한다(부트스트랩이든 재설치든 같은 결과 = 멱등).
//   드리프트는 kit/cli/lively.test.mjs 의 '심 동일성' 케이스가 잡는다.
//  ⚠ LIVELY_HOME 은 **HOME 리다이렉트**다(.lively 디렉터리가 아니라) — user-install/uninstall/self-update 전부 같은 계약.
//   `${LIVELY_HOME:-$HOME/.lively}` 로 쓰면 샌드박스에서 <home>/lib/lively.mjs 를 찾아 죽는다(실측 후 수정).
const CLI_SHIM = [
  "#!/bin/sh",
  "# lively 런처 — lively CLI 를 적절한 Node 로 실행한다. (kit/cli/bootstrap.sh · user-install.mjs 가 생성)",
  "set -e",
  'LV="${LIVELY_HOME:-$HOME}/.lively"',
  'N="$LV/runtime/current/bin/node"',
  '[ -x "$N" ] || N="$(command -v node 2>/dev/null || true)"',
  '[ -n "$N" ] || { echo "lively: Node 를 찾을 수 없습니다. 다시 설치하세요:  curl -fsSL <게이트웨이>/cli | sh" >&2; exit 1; }',
  'exec "$N" "$LV/lib/lively.mjs" "$@"',
  "",
].join("\n");
// Windows 심 — 메시지는 ASCII 로만(콘솔 코드페이지에 따라 한글이 깨진다). bootstrap.ps1 과 동일 내용.
const CLI_SHIM_CMD = [
  "@echo off",
  "setlocal EnableDelayedExpansion",
  'set "LVH=%LIVELY_HOME%"',
  'if "%LVH%"=="" set "LVH=%USERPROFILE%"',
  'set "LV=%LVH%\\.lively"',
  'set "N="',
  'for /f "delims=" %%d in (\'dir /b /ad /o-n "%LV%\\runtime\\node-*" 2^>nul\') do (',
  '  if exist "%LV%\\runtime\\%%d\\node.exe" (',
  '    set "N=%LV%\\runtime\\%%d\\node.exe"',
  "    goto :found",
  "  )",
  ")",
  'where node >nul 2>nul && set "N=node"',
  ":found",
  "if not defined N (",
  "  echo lively: Node not found. Reinstall:  irm ^<gateway^>/cli.ps1 ^| iex 1>&2",
  "  exit /b 1",
  ")",
  '"%N%" "%LV%\\lib\\lively.mjs" %*',
  "exit /b %errorlevel%",
  "",
].join("\r\n");

const CLI_PATH_BEGIN = "# >>> lively-managed (PATH: cli) >>>";
const CLI_PATH_END = "# <<< lively-managed (PATH: cli) <<<";

// 새 터미널에서 `lively` 가 잡히게 rc 에 센티넬 블록을 **비파괴**로 심는다(이미 있으면 무변경).
//  같은 리터럴을 bootstrap.sh 가 쓰고 user-uninstall.mjs 가 제거한다 — 세 곳이 한 센티넬을 공유한다.
function wireCliPath() {
  if (WIN) {
    // Windows 는 rc 가 없다 — User PATH(레지스트리)에 넣는다. 관리자 권한 불필요. 실패해도 설치는 계속(fail-soft).
    const binDir = join(LIVELY, "bin");
    const ps = `$b='${binDir.replace(/'/g, "''")}'; $p=[Environment]::GetEnvironmentVariable('PATH','User'); if(-not $p){$p=''}; if(($p -split ';') -notcontains $b){ [Environment]::SetEnvironmentVariable('PATH', ($b+';'+$p).TrimEnd(';'), 'User') }`;
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore" });
    if (r.status === 0) console.log("  ✓ User PATH 에 ~/.lively/bin 추가(새 창부터 적용)");
    else console.warn("  ⚠️ User PATH 등록 실패 — 새 PowerShell 에서 `lively` 가 안 잡히면 수동으로 추가하세요.");
    return;
  }
  const block = [
    CLI_PATH_BEGIN,
    "# lively CLI 를 PATH 에 추가(제거 시 함께 정리됨).",
    'if [ -d "$HOME/.lively/bin" ]; then case ":$PATH:" in *":$HOME/.lively/bin:"*) ;; *) export PATH="$HOME/.lively/bin:$PATH" ;; esac; fi',
    CLI_PATH_END,
  ].join("\n");
  const candidates = [".zshrc", ".bashrc", ".bash_profile", ".profile"].map((f) => join(HOME, f));
  let targets = candidates.filter((p) => existsSync(p));
  if (!targets.length) targets = [join(HOME, ".zshrc")];
  let wired = 0;
  for (const rc of targets) {
    let cur = "";
    try { cur = existsSync(rc) ? readFileSync(rc, "utf8") : ""; } catch { continue; }
    if (cur.includes(CLI_PATH_BEGIN)) { console.log(`  · ${rc.replace(HOME, "~")} (PATH 블록 기존 유지)`); continue; }
    // 최초(pristine) 스냅샷만 보관 — 덮어쓰지 않는다(kit/cli/bootstrap.sh 의 rc 센티넬과 같은 규약).
    const bakDir = join(LIVELY, "backups");
    mkdirSync(bakDir, { recursive: true });
    const bak = join(bakDir, `${rc.split("/").pop()}.path-cli.bak`);
    try { if (existsSync(rc) && !existsSync(bak)) copyFileSync(rc, bak); } catch { /* 백업 실패해도 머지는 비파괴 */ }
    try {
      writeFileSync(rc, cur.replace(/\s+$/, "") + (cur.trim() ? "\n\n" : "") + block + "\n");
      wired++;
      console.log(`  ✓ ${rc.replace(HOME, "~")} (lively PATH 블록 추가)`);
    } catch (e) { console.warn(`  ⚠️ ${rc.replace(HOME, "~")} 쓰기 실패(${e.message}) — 수동으로 ~/.lively/bin 을 PATH 에 추가하세요.`); }
  }
  if (wired) console.log("    (현재 셸 즉시 반영 안 됨 — 새 터미널 또는 `source ~/.zshrc`)");
}

// CLI 본체 + 심 설치. 번들에 cli/lively.mjs 가 없으면(구버전 번들) 조용히 건너뛴다(하위호환).
function installCli() {
  const src = cloneAbs(join("cli", "lively.mjs"));
  if (!existsSync(src)) { console.log("  · lively CLI 보류(번들에 cli/lively.mjs 없음 — 구버전 번들)"); return; }
  const lib = join(LIVELY, "lib");
  const bin = join(LIVELY, "bin");
  mkdirSync(lib, { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(src, join(lib, "lively.mjs"));
  chmodSync(join(lib, "lively.mjs"), 0o755);
  // 로컬조작 stdio MCP 서버(#899) — `lively mcp-local` 이 import 해 실행. lively.mjs 옆에 둔다.
  //  번들에 없으면(구버전) 조용히 건너뜀 — 그럼 mcp-local 서브커맨드만 미동작(하위호환).
  const mcpLocal = cloneAbs(join("cli", "lively-mcp-local.mjs"));
  if (existsSync(mcpLocal)) { copyFileSync(mcpLocal, join(lib, "lively-mcp-local.mjs")); chmodSync(join(lib, "lively-mcp-local.mjs"), 0o755); }
  // 게이트웨이 stdio 프록시(#1079) — `lively mcp` 가 import 해 실행. lively.mjs 옆에 둔다.
  //  ⚠ 이게 빠지면 `lively mcp` 가 못 떠서 **lively MCP 자체가 안 붙는다**(http 직결과 달리 로컬 파일이 필수).
  //   구버전 번들(파일 없음)이면 조용히 건너뛴다 — 그 경우 등록도 여전히 http 라 짝이 맞는다.
  const mcpGw = cloneAbs(join("cli", "lively-mcp-gateway.mjs"));
  if (existsSync(mcpGw)) { copyFileSync(mcpGw, join(lib, "lively-mcp-gateway.mjs")); chmodSync(join(lib, "lively-mcp-gateway.mjs"), 0o755); }
  // 워크트리 셀프서비스 코어(#900) — lively.mjs·lively-mcp-local.mjs 가 import 한다. 둘 옆(lib/)에 둔다(구버전 번들엔 없으면 스킵).
  const repoCore = cloneAbs(join("cli", "repo-worktree-core.mjs"));
  if (existsSync(repoCore)) { copyFileSync(repoCore, join(lib, "repo-worktree-core.mjs")); chmodSync(join(lib, "repo-worktree-core.mjs"), 0o755); }
  // 프로젝트 init 코어(#905) — lively.mjs(`lively init`)·lively-mcp-local.mjs 가 import 한다. 둘 옆(lib/)에 둔다(구버전 번들엔 없으면 스킵).
  //  ⚠ 이게 빠지면 lively-mcp-local.mjs 의 static import 가 부팅 즉시 죽어 `lively mcp-local` 이 통째로 못 뜬다(#905 회귀).
  const projInitCore = cloneAbs(join("cli", "project-init-core.mjs"));
  if (existsSync(projInitCore)) { copyFileSync(projInitCore, join(lib, "project-init-core.mjs")); chmodSync(join(lib, "project-init-core.mjs"), 0o755); }
  // 서브커맨드 모듈(#1313 R52) — lively.mjs 가 `node`·`delegate`·`resume/backfill/share` 에서 dynamic import 한다.
  //  ⚠ 이게 빠지면 그 서브커맨드만 ERR_MODULE_NOT_FOUND 로 못 뜬다(다른 명령은 정상 — 부트스트랩 경로가
  //   lively.mjs 단독이라 설치 이전 표면은 애초에 이 파일들을 안 쓴다). 구버전 번들엔 없으면 조용히 스킵.
  for (const f of ["cmd-node.mjs", "cmd-delegate.mjs", "cmd-session.mjs"]) {
    const src2 = cloneAbs(join("cli", f));
    if (existsSync(src2)) { copyFileSync(src2, join(lib, f)); chmodSync(join(lib, f), 0o755); }
  }
  // 제거기 로컬 사본 — 로그아웃·오프라인 상태에서도 `lively uninstall` 이 되도록(제거는 언제나 가능해야 한다).
  const un = cloneAbs(join("setup", "user-uninstall.mjs"));
  if (existsSync(un)) { copyFileSync(un, join(lib, "user-uninstall.mjs")); chmodSync(join(lib, "user-uninstall.mjs"), 0o755); }
  if (WIN) {
    writeFileSync(join(bin, "lively.cmd"), CLI_SHIM_CMD);
  } else {
    writeFileSync(join(bin, "lively"), CLI_SHIM);
    chmodSync(join(bin, "lively"), 0o755);
  }
  console.log(`  ✓ ~/.lively/bin/lively${WIN ? ".cmd" : ""} (lively CLI)`);
  wireCliPath();
}

function seedWorkRoots(roots) {
  if (!roots.length) return;
  const path = join(LIVELY, "work-roots");
  let existing = [];
  if (existsSync(path)) existing = readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const set = new Set(existing.filter((l) => !l.startsWith("#")));
  let added = 0;
  for (const r of roots) { const abs = resolve(r); if (!set.has(abs)) { existing.push(abs); set.add(abs); added++; } }
  if (added || !existsSync(path)) {
    const header = WORK_ROOTS_HEADER;
    writeFileSync(path, [header, ...existing.filter((l) => l.trim() && !l.startsWith("#"))].join("\n") + "\n");
    chmodSync(path, 0o600);
    console.log(`  ✓ ~/.lively/work-roots (시드 ${added}건 추가)`);
  } else {
    console.log("  · ~/.lively/work-roots (기존 유지)");
  }
}

// ── Codex user-level 설치(정본 — 배선을 고칠 땐 여기 codexManagedBlock 하나만 고친다) ──
const CDX_BEGIN = "# >>> lively-managed (auto-generated by workflow-std/adapters/codex — do not edit) >>>";
const CDX_END = "# <<< lively-managed <<<";
// R3 리네임 마이그레이션 호환: 옛 제품명(harness-kit) 관리 블록도 인식해 surgical replace(append 중복 방지).
const CDX_LEGACY_BEGINS = [
  "# >>> lively-managed (auto-generated by lively-harness-kit/adapters/codex — do not edit) >>>",
];
// AGENTS.md 센티넬 — org-context 를 관리 블록으로 머지(사용자 기존 글로벌 지침/메모리 보존). config.toml 센티넬과 동형.
const AG_BEGIN = "<!-- >>> lively-managed org-context (auto-generated by workflow-std — do not edit) >>> -->";
const AG_END = "<!-- <<< lively-managed <<< -->";
function agentsMerge(existing, ctx) {
  let user = existing;
  const bi = existing.indexOf(AG_BEGIN);
  if (bi !== -1) {
    const ei = existing.indexOf(AG_END, bi);
    user = existing.slice(0, bi) + (ei === -1 ? "" : existing.slice(ei + AG_END.length));
  }
  user = user.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  const block = AG_BEGIN + "\n" + ctx.replace(/\s+$/, "") + "\n" + AG_END + "\n";
  return (user ? user + "\n\n" : "") + block;
}
// Windows: `env` 프리픽스 불가 → 하네스는 argv 로. Mac/Linux: 기존 env 형 유지(idempotency 키 안정).
const codexHookCmd = (script) => WIN
  ? `node "${hookAbs(script)}" --harness codex`
  : `env LIVELY_HARNESS=codex "${NODEBIN}" "${join(LIVELY, "hooks", script)}"`;   // #355: 번들 node 절대경로(PATH 무관)
// 커스텀 훅 런너(codex) — 이벤트는 argv. 등록 이벤트는 CODEX_RUNNER_EVENTS 참조.
const codexRunnerCmd = (event) => WIN
  ? `node "${hookAbs("run-custom.mjs")}" ${event} --harness codex`
  : `env LIVELY_HARNESS=codex "${NODEBIN}" "${join(LIVELY, "hooks", "run-custom.mjs")}" ${event}`;

// codex 훅 엔트리 한 벌 — `[[hooks.<E>]]`(+matcher) + `[[hooks.<E>.hooks]]` 핸들러. TOML array-of-tables 라
//  같은 이벤트를 여러 벌 써도 유효하다(원소가 덧붙는다 — 사용자 자기 훅과도 비충돌).
//  command 는 TOML basic 문자열(JSON.stringify) — single-quote 리터럴은 escape 불가라 HOME 에 아포스트로피가
//  있으면(/Users/o'brien) config.toml 전체가 깨진다(사용자 codex 설정 동반 손상 방지).
const cdxHook = (event, command, timeout, matcher) => [
  `[[hooks.${event}]]`,
  ...(matcher ? [`matcher = ${JSON.stringify(matcher)}`] : []),
  `[[hooks.${event}.hooks]]`, 'type = "command"',
  `command = ${JSON.stringify(command)}`, `timeout = ${timeout}`, "",
];

// 커스텀 훅 런너를 배선할 codex 이벤트 — **claude 의 runnerHooksBlock 과 같은 자리**(하네스 패리티 불변식 ②).
//  이벤트 집합이 하네스마다 다르다(codex 0.142.0 바이너리 실측):
//   · codex 에 **없는 것**: SessionEnd · Notification → 배선 불가(claude 전용).
//   · codex 에**만** 있는 것: PermissionRequest · SubagentStart → 서버 org_hook 의 event 허용목록(delivery/hooks.ts
//     HOOK_EVENTS)에 아직 없어 조직 훅을 만들 수 없다 → 러너는 배선하지 않는다(등록 불가능한 이벤트에 러너를
//     붙이면 툴콜마다 빈 왕복만 생긴다). PermissionRequest 는 work-flag(세션 상태)로만 쓴다.
//  그래서 여기 8개 = 'codex 가 지원' ∩ '조직 훅으로 등록 가능' 의 전부다. 특히 **PreToolUse 가 핵심** —
//  이게 없던 동안 코덱스엔 조직 거버넌스(쓰기게이트·승인차단)가 통째로 없었다(claude 만 적용, 불변식 ② 위반).
const CODEX_RUNNER_EVENTS = [
  ["SessionStart", "startup|resume|clear", 10],
  ["UserPromptSubmit", null, 15],
  ["PreToolUse", ".*", 15],
  ["PostToolUse", ".*", 15],
  ["Stop", null, 15],
  ["SubagentStop", null, 15],
  ["PreCompact", null, 15],
  ["PostCompact", null, 15],
];

// 추가 MCP 서버(org_mcp_server) TOML 라인 — 발행 묶음 .lively/mcp-servers.json 에서 읽음(lively 제외, enabled 만).
//  센티넬(CDX_BEGIN..CDX_END) 안에 들어가므로 stripManaged 가 통째 교체 → idempotent·안전. 없으면 lively 만.
function codexExtraMcpLines() {
  const out = [];
  const seen = new Set(["lively"]); // lively 는 위에서 생성됨 — 중복 [mcp_servers.X] 는 TOML 무효라 차단.
  try {
    const d = JSON.parse(readFileSync(cloneAbs(join(".lively", "mcp-servers.json")), "utf8"));
    for (const s of (d.servers || [])) {
      if (s.enabled === false || !s.name) continue;
      if (!/^[A-Za-z0-9_-]+$/.test(s.name)) continue; // TOML 키 안전
      if (seen.has(s.name)) continue; // 중복 이름 스킵
      seen.add(s.name);
      out.push(`[mcp_servers.${s.name}]`);
      if (s.transport === "stdio" && s.command) {
        // ⚠ codex 스키마는 **command=문자열 + args=배열**이다(0.142.0 실측: `codex mcp add probe -- lively mcp-local`
        //  → command = "lively" / args = ["mcp-local"]). 종전엔 command 에 배열을 넣어
        //  `invalid type: sequence, expected a string` 로 **config.toml 이 통째로 로드 실패**했다 — 그러면 이 서버
        //  하나가 아니라 [mcp_servers.lively]·[hooks.*] 까지 전부 죽는다(코덱스 배선 전멸). 조직에 stdio MCP 를
        //  하나라도 등록하는 순간 전 멤버에게 터지는 잠복 결함이었다(라이브 mcp-servers.json 이 비어 미발현).
        const parts = String(s.command).trim().split(/\s+/).filter(Boolean);
        out.push(`command = ${JSON.stringify(parts[0])}`);
        if (parts.length > 1) out.push(`args = [${parts.slice(1).map((p) => JSON.stringify(p)).join(", ")}]`);
      } else if (s.url) {
        out.push(`url = ${JSON.stringify(s.url)}`);
        if (s.auth_env) out.push(`bearer_token_env_var = ${JSON.stringify(s.auth_env)}`);
      }
      out.push("");
    }
  } catch { /* 없으면 lively 만 */ }
  return out;
}

// auto-approve(codex) — 발행 묶음 .lively/auto-approve.json 의 'mcp__lively__<tool>' → codex per-tool 승인 오버라이드.
//  [mcp_servers.lively.tools.<바툴명>] approval_mode = "approve"(승인 없이 실행). 센티넬(CDX_BEGIN..END) 안이라
//  재설치마다 통째 재생성 = reconcile(auto_approve 끈 툴은 자동 제거). claude 의 permissions.allow 대응물.
function codexAutoApproveLines() {
  const out = [];
  try {
    const d = JSON.parse(readFileSync(cloneAbs(join(".lively", "auto-approve.json")), "utf8"));
    for (const full of (d.allow || [])) {
      if (typeof full !== "string") continue;
      const m = full.match(/^mcp__lively__(.+)$/); // 바 tool 명 추출(lively 서버 툴 한정)
      if (!m) continue;
      const tool = m[1];
      if (!/^[A-Za-z0-9_-]+$/.test(tool)) continue; // TOML 키 안전
      out.push(`[mcp_servers.lively.tools.${tool}]`, 'approval_mode = "approve"', "");
    }
  } catch { /* 없으면 빈 */ }
  return out;
}

// lively 본체 MCP 등록 — claude 와 **같은 transport 규약**을 쓴다(register-clients.sh · lively.mjs registerLivelyMcp).
//  기본은 로컬 stdio 프록시(`lively mcp`). codex 에서 이게 특히 중요한 이유:
//   ① codex 의 http_headers 는 **정적 문자열**이라 세션 env 를 확장하지 못한다 → http 직결로는
//      x-lively-session(#852 — 작업기록의 세션 축)·x-lively-mode(#1007 — 읽기전용/incognito)를 **영영 못 보낸다**.
//      프록시는 자기가 상속한 env 를 읽어 상류 호출에 붙이므로 두 기능이 codex 에서도 그대로 산다
//      (register-clients.sh 에 남아 있던 "codex 는 per-session 실행 모드 미지원" 한계가 이걸로 풀린다).
//   ② 부팅 시 게이트웨이에 못 닿아도 stdio 는 로컬 프로세스라 항상 connected — 그 세션 내내 failed 로 굳지 않는다(#1079).
//   ③ 토큰을 설정 파일에 안 굽고 프록시가 매 호출 ~/.lively/token 을 읽는다 → 셸 rc 의 LIVELY_TOKEN 이
//      스테일이어도 옛 신원으로 조용히 붙지 않는다(#916 의 codex 판. 둘 다 유효한 토큰이면 401 도 안 나 조용히 파손된다).
//  ⚠ env.LIVELY_HARNESS=codex 가 **필수**다 — 프록시의 x-lively-harness 기본값이 "claude-code" 라(UA 가 프록시
//   것이 되므로 명시 stamp 가 유일한 신호) 이걸 빼면 게이트웨이가 코덱스 세션을 claude 로 집계한다(#182 작업자 축).
//  프록시 파일이 없거나(구버전 번들·CLI 미설치) 롤백 스위치(~/.lively/mcp-transport=http)면 종전 http 직결로 떨어진다.
function codexLivelyServerLines(mcpUrl) {
  const shim = join(LIVELY, "bin", WIN ? "lively.cmd" : "lively");
  const proxy = join(LIVELY, "lib", "lively-mcp-gateway.mjs");
  let transport = "";
  try { transport = readFileSync(join(LIVELY, "mcp-transport"), "utf8").trim(); } catch { /* 기본 = stdio */ }
  if (transport !== "http" && existsSync(shim) && existsSync(proxy)) {
    return [
      "[mcp_servers.lively]",
      `command = ${JSON.stringify(fwd(shim))}`,
      'args = ["mcp"]', "",
      "[mcp_servers.lively.env]",
      'LIVELY_HARNESS = "codex"', "",
    ];
  }
  return [
    "[mcp_servers.lively]",
    `url = "${mcpUrl}"`,
    'bearer_token_env_var = "LIVELY_TOKEN"', "",
    // http 직결 폴백에서도 하네스 stamp 는 정적값이라 보낼 수 있다(세션·모드와 달리 값이 안 변한다).
    "[mcp_servers.lively.http_headers]",
    'x-lively-harness = "codex"', "",
  ];
}

function codexManagedBlock(mcpUrl) {
  const wf = codexHookCmd("work-flag.mjs");
  return [
    CDX_BEGIN, "",
    ...codexLivelyServerLines(mcpUrl),
    ...codexAutoApproveLines(), // [mcp_servers.lively.tools.X] approval_mode="approve" — 자동승인 툴
    ...codexExtraMcpLines(),
    // ── 전용 훅 — claude 의 userLevelHooksBlock 과 같은 자리 ──
    ...cdxHook("SessionStart", codexHookCmd("session-preload.mjs"), 10, "startup|resume|clear"),
    ...cdxHook("SessionStart", codexHookCmd("sync-harness-assets.mjs"), 10, "startup|resume|clear"),
    // #1221 세션 실행단계 보고 — 턴 시작(UserPromptSubmit)·승인 대기(PermissionRequest)·턴 종료(Stop)
    //  + 세션 시작(UUID 매핑). **코덱스에서 특히 크다**: 게이트웨이의 종전 busy 판정은 Claude Code 의 브라유
    //  스피너 글리프라 코덱스 세션은 아무리 돌아도 영영 '작업 중'으로 안 잡혔고, 회수 보호도 lastActive 하나에만
    //  걸렸다. 코덱스엔 Notification 이 없어 승인 대기는 PermissionRequest 로 받는다(work-flag.reportedPhase 가
    //  이미 그렇게 분기해 둔 자리 — 스크립트는 준비돼 있었고 배선만 없었다).
    ...cdxHook("SessionStart", wf, 5, "startup|resume|clear"),
    ...cdxHook("UserPromptSubmit", wf, 5),
    ...cdxHook("PostToolUse", wf, 5, "mcp__lively__.*"),
    ...cdxHook("PostToolUse", wf, 5, "Edit|Write|MultiEdit|NotebookEdit|apply_patch"),
    ...cdxHook("PermissionRequest", wf, 5),
    ...cdxHook("Stop", codexHookCmd("stop-writeback-gate.mjs"), 10),
    ...cdxHook("Stop", wf, 5),
    // ── 커스텀 훅 런너 — 이벤트별 고정 엔트리 1개(훅 본문은 런너가 런타임에 fetch) ──
    ...CODEX_RUNNER_EVENTS.flatMap(([event, matcher, timeout]) =>
      cdxHook(event, codexRunnerCmd(event), timeout, matcher)),
    CDX_END,
  ].join("\n");
}

// 옛 버전이 `[sandbox_workspace_write] writable_roots` 에 **이스케이프 없이** 박은 윈도우 경로 복구.
//  그 한 줄 때문에 codex 가 config.toml 을 통째로 못 읽어(`too few unicode value digits`) **아예 안 뜬다** —
//  그러면 우리 MCP·훅도 같이 죽는다. 우리가 만든 고장이라 우리가 되돌린다.
//  ⚠ **이 복구는 설치기에 있어야 한다.** 처음엔 그 줄을 쓰는 쪽(work.mjs·project-provision.ts)에만 넣었는데,
//   그 둘은 '프로젝트를 실행할 때'만 돌아서 **키트를 업데이트해도 안 고쳐졌다**(윈도우 실기기 실측 — 최신 키트인데
//   codex 는 여전히 못 뜸). 설치기는 자동 업데이트가 매번 돌리는 유일한 경로라 여기 있어야 자가치유가 된다.
//  ⚠ 센티넬 **밖**을 만지는 예외다(그 줄을 우리가 썼기 때문). 대상은 writable_roots 줄 하나뿐이고 나머지는 불가침.
//  ⚠ 유효 이스케이프를 통째로 소비해야 멱등이다 — 하나씩 lookahead 로 보면 이미 올바른 `\\Users` 가 매번 더 늘어난다.
const TOML_ESC = /\\\\|\\["bfnrt]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}|\\/g;
function repairTomlWinPaths(toml) {
  return String(toml).replace(/^([ \t]*writable_roots[ \t]*=[ \t]*)(\[[^\]\n]*\])/gm, (_line, head, arr) =>
    head + arr.replace(/"(?:[^"\\]|\\.)*"/g, (lit) =>
      lit.replace(TOML_ESC, (m) => (m === "\\" ? "\\\\" : m))));
}

function codexStripManaged(text) {
  let bi = text.indexOf(CDX_BEGIN);
  if (bi === -1) {
    for (const lb of CDX_LEGACY_BEGINS) { const li = text.indexOf(lb); if (li !== -1) { bi = li; break; } }
  }
  if (bi === -1) return { user: text, had: false };
  const ei = text.indexOf(CDX_END, bi);
  if (ei === -1) {
    // END 손상 — BEGIN 한 줄만 제거하고 아래 사용자 키 보존(예전엔 BEGIN 이후 전부 잘려 소실 위험).
    const eol = text.indexOf("\n", bi);
    const after = eol === -1 ? "" : text.slice(eol + 1);
    return { user: (text.slice(0, bi) + after).replace(/\n{3,}/g, "\n\n").trim() + "\n", had: true };
  }
  return { user: (text.slice(0, bi) + text.slice(ei + CDX_END.length)).replace(/\n{3,}/g, "\n\n").trim() + "\n", had: true };
}

// LIVELY_TOKEN 셸 env 전달(codex MCP bearer 인증의 전제) — 어댑터와 동일 동작. 토큰 리터럴 없음·idempotent.
const RC_BEGIN = "# >>> lively-managed (codex LIVELY_TOKEN) >>>";
const RC_END = "# <<< lively-managed (codex LIVELY_TOKEN) <<<";
function wireCodexTokenEnv() {
  // Windows: PowerShell $PROFILE 의 "파일→env 수화"는 install 원라이너가 구성한다($PROFILE 경로는 Documents
  //  리다이렉션/PS5·PS7 차이로 PowerShell 만 정확히 해석). 여기서 POSIX rc 를 쓰면 무의미한 ~/.zshrc 가 생기므로 no-op.
  if (WIN) {
    console.log("  · (Windows) LIVELY_TOKEN 수화는 PowerShell $PROFILE 에서 처리 — 새 PowerShell 부터 적용");
    return;
  }
  const block = [
    RC_BEGIN,
    "# codex 의 lively MCP 가 bearer_token_env_var=LIVELY_TOKEN 으로 인증하려면 셸에 토큰이 있어야 함.",
    "# 토큰 리터럴은 적지 않는다 — 런타임에 ~/.lively/token 을 읽는다(없으면 빈 값, 훅은 fail-open).",
    'if [ -r "$HOME/.lively/token" ]; then export LIVELY_TOKEN="$(cat "$HOME/.lively/token")"; fi',
    RC_END,
  ].join("\n");
  const candidates = [".zshrc", ".bashrc", ".bash_profile", ".profile"].map((f) => join(HOME, f));
  let targets = candidates.filter((p) => existsSync(p));
  if (!targets.length) targets = [join(HOME, ".zshrc")];
  let wired = 0;
  for (const rc of targets) {
    let cur = "";
    try { cur = existsSync(rc) ? readFileSync(rc, "utf8") : ""; } catch { continue; }
    const bi = cur.indexOf(RC_BEGIN);
    let next;
    if (bi !== -1) {
      const ei = cur.indexOf(RC_END, bi);
      const before = cur.slice(0, bi);
      const after = ei === -1 ? (cur.indexOf("\n", bi) === -1 ? "" : cur.slice(cur.indexOf("\n", bi) + 1)) : cur.slice(ei + RC_END.length);
      next = (before + after).replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n\n" + block + "\n";
      if (next === cur) { console.log(`  · ${rc.replace(HOME, "~")} (LIVELY_TOKEN export 기존 유지)`); continue; }
    } else {
      next = (cur.replace(/\s+$/, "") + (cur.trim() ? "\n\n" : "")) + block + "\n";
    }
    try { writeFileSync(rc, next); wired++; console.log(`  ✓ ${rc.replace(HOME, "~")} (LIVELY_TOKEN export 추가 — 토큰 리터럴 없음 · 새 셸부터 적용)`); }
    catch (e) { console.warn(`  ⚠️ ${rc.replace(HOME, "~")} 쓰기 실패(${e.message}) — 수동으로 LIVELY_TOKEN export 필요.`); }
  }
  if (wired) console.log("    (현재 셸 즉시 반영 안 됨 — 새 터미널 또는 `source ~/.zshrc` 후 codex)");
}

function installCodex(ctx, mcpUrl) {
  mkdirSync(CODEX, { recursive: true });
  // (c) AGENTS.md — org-context 시드(설치-시 라이브 fetch 결과). 센티넬 블록으로 **비파괴 머지**(기존 지침 보존 + 백업).
  //  ctx 비면(오프라인 설치) 시드 생략 — 대화형 codex 는 세션 훅이 라이브 주입, headless 는 update 로 채움(폴백 없음).
  if (ctx) {
    const apath = join(CODEX, "AGENTS.md");
    let existingAgents = "";
    if (existsSync(apath)) {
      try { existingAgents = readFileSync(apath, "utf8"); } catch { existingAgents = ""; }
      const backupDir = join(LIVELY, "backups"); mkdirSync(backupDir, { recursive: true });
      try {
        const orig = join(backupDir, "codex-AGENTS.md.orig");
        if (!existsSync(orig)) copyFileSync(apath, orig); // 최초 원본 1회 영구 보존
        copyFileSync(apath, join(backupDir, "codex-AGENTS.md.bak"));
      } catch { /* 백업 실패해도 머지는 비파괴라 진행 */ }
    }
    writeFileSync(apath, agentsMerge(existingAgents, ctx));
    const bytes = Buffer.byteLength(ctx, "utf8");
    console.log(`  ✓ ~/.codex/AGENTS.md (org-context ${(bytes / 1024).toFixed(1)} KiB 머지 — 기존 지침 보존)${bytes > 32 * 1024 ? "  ⚠️ 32KiB 초과" : ""}`);
  } else {
    console.log("  · ~/.codex/AGENTS.md 시드 보류(오프라인) — 대화형 세션 훅이 라이브 주입");
  }
  // (d) config.toml 센티넬 surgical merge(백업 먼저)
  const cfgPath = join(CODEX, "config.toml");
  let raw = "";
  if (existsSync(cfgPath)) {
    const backupDir = join(LIVELY, "backups"); mkdirSync(backupDir, { recursive: true });
    try {
      const orig = join(backupDir, "config.toml.codex.orig");
      if (!existsSync(orig)) copyFileSync(cfgPath, orig);
      copyFileSync(cfgPath, join(backupDir, "config.toml.codex.bak"));
    } catch (e) { console.error(`✗ ~/.codex/config.toml 백업 실패 — 중단: ${e.message}`); process.exit(1); }
    raw = readFileSync(cfgPath, "utf8");
    // 자가치유 — 옛 버전이 남긴 깨진 윈도우 경로를 여기서 되돌린다(설치기가 매 업데이트마다 도는 유일한 경로).
    const repaired = repairTomlWinPaths(raw);
    if (repaired !== raw) { raw = repaired; console.log("  ✓ ~/.codex/config.toml 의 writable_roots 윈도우 경로 복구(이스케이프 누락 — codex 가 파일을 못 읽던 원인)"); }
  }
  const { user, had } = codexStripManaged(raw);
  // TOML 은 다중 [[hooks.*]] array-of-table 공존 허용 → 사용자 훅과 우리 센티넬 블록은 비충돌.
  //  실제 충돌은 [mcp_servers.lively] 중복뿐(TOML 키 중복 무효)이므로 그 경우만 머지 건너뜀.
  if (/^\s*\[mcp_servers\.lively\]\s*$/m.test(user)) {
    console.warn("  ⚠️ ~/.codex/config.toml 사용자 영역에 [mcp_servers.lively] 충돌 — 머지 건너뜀(해당 테이블 제거 후 재실행).");
    return;
  }
  const ut = user.replace(/\s+$/, "");
  writeFileSync(cfgPath, (ut ? ut + "\n\n" : "") + codexManagedBlock(mcpUrl) + "\n");
  chmodSync(cfgPath, 0o600);
  console.log(`  ✓ ~/.codex/config.toml (lively-managed 블록 ${had ? "교체" : "추가"} · 사용자 키 보존 · 토큰 리터럴 없음)`);
  // LIVELY_TOKEN 셸 env 전달 — 없으면 새 셸 codex 의 lively MCP 가 401. 토큰 리터럴은 안 굽는다.
  wireCodexTokenEnv();
}

// 설치-시 org-context 시드 — 세션 훅(session-preload)과 동일 라이브 소스(/api/ui/org/preview)를 1회 fetch.
//  토큰·게이트웨이는 setup 이 먼저 ~/.lively 에 기록하므로 거기서 읽는다. fail-soft(오프라인/무토큰/구 node → "").
async function fetchOrgSeed() {
  const readF = (n) => { try { return readFileSync(join(LIVELY, n), "utf8").trim(); } catch { return ""; } };
  const token = (process.env.LIVELY_TOKEN || readF("token") || "").trim();
  const gw = (readF("gateway-url") || "").replace(/\/+$/, "");
  if (!token || !gw || typeof fetch !== "function") return "";
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(`${gw}/api/ui/org/preview`, { signal: ctl.signal, headers: { authorization: `Bearer ${token}` } });
    clearTimeout(t);
    if (!res.ok) return "";
    const j = await res.json();
    return (j && typeof j.context === "string" && j.context.trim()) ? j.context.trim() : "";
  } catch { return ""; }
}

// 공통 ~/.lively 자산(context.md/org-name/hooks/work-roots) 설치 — claude/codex 공유. ctx 반환.
async function installShared(workRoots) {
  mkdirSync(LIVELY, { recursive: true, mode: 0o700 });
  // 설치 시 1회 라이브 시드(2026-06-24 동적 전달 컷오버) — 번들엔 org-콘텐츠를 더는 굽지 않는다(베이크 floor 폐지).
  //  이 fetch 가 첫 세션 전 floor(~/.lively/context.md)를 만들고, 이후 session-preload 가 매 세션 write-back 갱신.
  //  실패(오프라인/다운/무토큰)면 시드 생략 — 첫 성공 세션에 훅이 채운다(폴백 없음 = 설계 결정).
  const ctx = await fetchOrgSeed();
  if (ctx) {
    writeFileSync(join(LIVELY, "context.md"), ctx + "\n");
    chmodSync(join(LIVELY, "context.md"), 0o600);
  }
  const nameFile = cloneAbs(".lively-org-name");
  const orgName = existsSync(nameFile) ? readFileSync(nameFile, "utf8").trim() : "조직"; // org-agnostic 중립 폴백(D1) — 발행물엔 항상 .lively-org-name 동봉
  writeFileSync(join(LIVELY, "org-name"), orgName + "\n");
  chmodSync(join(LIVELY, "org-name"), 0o600);
  if (ctx) console.log(`  ✓ ~/.lively/context.md 라이브 시드 (${(Buffer.byteLength(ctx, "utf8") / 1024).toFixed(1)} KiB) · org-name=${orgName}`);
  else console.log(`  · ~/.lively/context.md 시드 보류(오프라인/게이트웨이 미응답) — 첫 세션 훅이 채움 · org-name=${orgName}`);

  const hooksDir = join(LIVELY, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  let missing = 0;
  for (const f of HOOK_SCRIPTS) {
    const src = cloneAbs(join(".claude", "hooks", f));
    if (!existsSync(src)) { missing++; continue; }
    copyFileSync(src, join(hooksDir, f));
    chmodSync(join(hooksDir, f), 0o755);
  }
  if (missing) {
    console.error(`✗ 발행물에 훅 스크립트 ${missing}개 누락(.claude/hooks/) — claude 하네스로 재발행 필요. 중단.`);
    process.exit(1);
  }
  console.log(`  ✓ ~/.lively/hooks/ (${HOOK_SCRIPTS.length}개)`);

  // work.mjs — '내 컴퓨터에서 작업' 부트스트랩(사용자 호출 도구, 훅 아님) → ~/.lively/work.mjs (chmod 755).
  //  이제 `lively run <프로젝트번호>` 가 이걸 부른다(웹이 건네던 `node ~/.lively/work.mjs …` 를 대체).
  {
    const wsrc = cloneAbs(join("setup", "work.mjs"));
    if (existsSync(wsrc)) { copyFileSync(wsrc, join(LIVELY, "work.mjs")); chmodSync(join(LIVELY, "work.mjs"), 0o755); console.log("  ✓ ~/.lively/work.mjs"); }
    else console.log("  · ~/.lively/work.mjs 보류(번들에 setup/work.mjs 없음 — 구버전 번들)");
  }

  // lively CLI(#864) — 이 한 줄이 기존 멤버 전원에게 `lively` 를 배달한다(자동 업데이트가 이 설치기를 돌리므로).
  installCli();

  // 런타임 자산(발행 묶음 .lively/ — 게이트웨이가 org_runtime_config·org_mcp_server 에서 주입) → ~/.lively 복사.
  //  훅(hooks-config.json)·register-clients(mcp-servers.json)가 런타임에 읽음. 없으면 스킵(구버전 번들 호환).
  //  kit-version(#858): 이 번들의 지문. 여기 스탬프가 찍혀야 다음 세션의 session-preload 가 '최신'으로 보고
  //  자동 업데이트를 안 돈다(= 수동 설치·업데이트도 자동 경로와 같은 좌표계에 들어온다).
  for (const f of ["hooks-config.json", "mcp-servers.json", "auto-approve.json", "kit-version"]) {
    const src = cloneAbs(join(".lively", f));
    if (existsSync(src)) {
      copyFileSync(src, join(LIVELY, f));
      chmodSync(join(LIVELY, f), 0o600);
      console.log(`  ✓ ~/.lively/${f}`);
    }
  }

  // work-roots: 발행 묶음의 org 중앙 목록 + --work-root 인자를 머지(seedWorkRoots 가 기존 보존).
  const orgRoots = [];
  try {
    const wr = readFileSync(cloneAbs(join(".lively", "work-roots")), "utf8");
    for (const l of wr.split(/\r?\n/)) { const t = l.trim(); if (t && !t.startsWith("#")) orgRoots.push(t); }
  } catch { /* 없으면 무시 */ }
  seedWorkRoots([...orgRoots, ...workRoots]);
  return ctx;
}

async function main() {
  const workRoots = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--work-root" && args[i + 1]) workRoots.push(args[i + 1]);
  const harnesses = String(getOpt("--harness") || "claude").split(",").map((h) => h.trim()).filter(Boolean);

  console.log(`▶ user-level 설치 (발행물 동봉 설치기 — harness=${harnesses.join(",")})`);
  const ctx = await installShared(workRoots);

  if (harnesses.includes("claude")) {
    console.log("  ── Claude ──");
    // 기본 훅 3종 + 커스텀 훅 런너(이벤트별 고정 엔트리)를 비파괴 머지(절대경로).
    safeMergeUserSettings(mergeBlocks(userLevelHooksBlock(), runnerHooksBlock()));
    mergeAutoApprove(); // auto-approve(permissions.allow) reconcile
  }
  if (harnesses.includes("codex")) {
    console.log("  ── Codex ──");
    // 게이트웨이 URL: ~/.lively/gateway-url(부트스트랩·CLI 가 기록) > 기본. /mcp 정규화.
    let gwBase = "http://localhost:8080";
    try { gwBase = (readFileSync(join(LIVELY, "gateway-url"), "utf8").trim() || gwBase); } catch { /* 기본 */ }
    gwBase = gwBase.replace(/\/+$/, "");
    const mcpUrl = /\/mcp$/.test(gwBase) ? gwBase : gwBase + "/mcp";
    installCodex(ctx, mcpUrl);
  }

  // ⚠ 문구는 **실제 동작과 일치해야 한다**(#1087). 종전엔 "setup 의 register-clients.sh 가 담당" 이라 했는데,
  //  `lively install` 경로에선 바로 다음 단계인 CLI 의 [3/3] 이 등록한다 — 화면상 이 줄 **바로 아래**에서
  //  "✓ MCP 등록: lively" 가 뜨므로 사용자는 서로 모순된 두 문장을 연달아 읽었다. 게다가 윈도우 사용자에겐
  //  실행조차 못 하는 `.sh` 를 가리켰다. 설치 화면의 거짓 안내는 장애 진단을 통째로 헛돌게 만든다.
  console.log("  · Claude MCP 등록은 여기서 하지 않습니다 — 이어지는 `lively install` 단계(또는 박스 프로비저닝)가 처리합니다. Codex MCP 는 위 config.toml 에 포함.");
  console.log("✓ user-level 설치 완료 — 다음 세션부터 적용(현 세션은 안전).");
}

// 직접 실행일 때만 설치 수행 — 테스트가 아래 export 를 import 해도 설치가 돌지 않게 하는 최소 가드.
//  ⚠ 비교는 realpath 로 — macOS 표준 설치 경로 /tmp/* 는 /private/tmp 심링크고 Node ESM 은 엔트리를
//  realpath 로 풀어 import.meta.url 과 argv[1] 의 URL 문자열 비교가 어긋난다(main 조용히 스킵 — v0.1.131 회귀
//  실측). 판정 불가(argv[1] 부재 등)면 fail-open = 실행: 설치기의 종전 기본 동작이 '항상 실행'이었다.
const DIRECT_RUN = (() => {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || ""); }
  catch { return true; }
})();
if (DIRECT_RUN) main().catch((e) => { console.error("✗ user-level 설치 실패:", e?.message || e); process.exit(1); });

export { safeMergeUserSettings, mergeBlocks, userLevelHooksBlock, runnerHooksBlock, CLI_SHIM, CLI_SHIM_CMD, CLI_PATH_BEGIN, CLI_PATH_END };
