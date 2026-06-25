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
//  MCP 등록은 setup-mac.sh 의 register-clients.sh 가 별도 담당(여기서 호출 안 함).
//
// 사용법(보통은 setup-mac.sh 가 호출): node setup/user-install.mjs [--harness claude|codex|claude,codex] [--work-root <abs>]…
//   --clone-root <dir> 로 발행물 루트 지정(기본: 이 스크립트의 ../). --harness 미지정 시 claude.
//   Codex(--harness codex): 같은 ~/.lively 자산 + ~/.codex/config.toml([hooks]+[mcp_servers.lively]) + ~/.codex/AGENTS.md.
//     (어댑터 adapters/codex/install.mjs 와 동일 동작을 발행물 자산만으로 자체완결 재현 — generator 미의존.)

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const getOpt = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : null; };
// HOME: 기본 OS homedir(), env LIVELY_HOME 로 리다이렉트 가능(샌드박스 격리 — user-uninstall 과 동일 계약).
//  ※ install/uninstall 대칭: 라운드트립 테스트 시 양쪽에 같은 LIVELY_HOME 을 지정해야 한쪽만 라이브에 닿는 footgun 을 막는다.
const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
const CODEX = join(HOME, ".codex");
const HOOK_SCRIPTS = ["session-preload.mjs", "work-flag.mjs", "stop-writeback-gate.mjs", "run-custom.mjs"];

// 발행물 루트: --clone-root 우선, 없으면 이 스크립트의 ../ (setup/ 의 부모).
const CLONE_ROOT = resolve(getOpt("--clone-root") || join(dirname(fileURLToPath(import.meta.url)), ".."));
const cloneAbs = (p) => join(CLONE_ROOT, p);

// 훅 커맨드 — 플랫폼별로 동작하는 형태를 쓴다(기존 맥 설치와 문자열 동일 유지 = 재설치 idempotency 키 안정,
//  중복 훅 방지). Windows 는 $HOME 셸확장/`env` 프리픽스가 안 먹으므로 forward-slash 절대경로 + argv 하네스.
//  node 는 Windows 에서도 forward-slash 경로를 받는다. 제거 매칭은 '.lively/hooks/' 부분문자열(양쪽 다 포함).
const fwd = (p) => p.replace(/\\/g, "/");
const hookAbs = (script) => fwd(join(LIVELY, "hooks", script));
const WIN = process.platform === "win32";
const hookCmd = (script) => WIN ? `node "${hookAbs(script)}"` : `node "$HOME/.lively/hooks/${script}"`;
// 커스텀 훅 런너 — 이벤트당 고정 엔트리 1개(커스텀 훅 자체는 런너가 런타임에 fetch). 이벤트는 argv 로 전달.
const hookCmdRunner = (event) => WIN ? `node "${hookAbs("run-custom.mjs")}" ${event}` : `node "$HOME/.lively/hooks/run-custom.mjs" ${event}`;

// settings-hooks.json 이 발행물에 없을 수 있으니, user-level 훅 블록을 코드로 구성(어댑터와 동일 형태).
function userLevelHooksBlock() {
  return {
    SessionStart: [
      { matcher: "startup|resume|clear", hooks: [{ type: "command", command: hookCmd("session-preload.mjs") }] },
    ],
    PostToolUse: [
      { matcher: "mcp__lively__.*", hooks: [{ type: "command", command: hookCmd("work-flag.mjs") }] },
      { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: hookCmd("work-flag.mjs") }] },
    ],
    Stop: [
      { hooks: [{ type: "command", command: hookCmd("stop-writeback-gate.mjs") }] },
    ],
  };
}

// 커스텀 훅 런너 — 이벤트당 고정 엔트리(런너가 런타임에 fetch·실행). 커스텀 훅 추가/삭제는 settings 재작성 불요.
function runnerHooksBlock() {
  const entry = (event, matcher) => matcher
    ? { matcher, hooks: [{ type: "command", command: hookCmdRunner(event) }] }
    : { hooks: [{ type: "command", command: hookCmdRunner(event) }] };
  return {
    SessionStart: [entry("SessionStart", "startup|resume|clear")],
    SessionEnd: [entry("SessionEnd")],
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
  const sp = join(HOME, ".claude", "settings.json");
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
  console.log(`  ✓ ~/.claude/settings.json (auto-approve ${want.length}건 반영)`);
}

function safeMergeUserSettings(blockHooks) {
  const settingsPath = join(HOME, ".claude", "settings.json");
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
  for (const [event, entries] of Object.entries(blockHooks)) {
    const arr = Array.isArray(cur.hooks[event]) ? cur.hooks[event] : [];
    for (const entry of entries) {
      const cmds = new Set(entry.hooks.map((h) => h.command));
      const dup = arr.some(
        (e) => (e.hooks ?? []).some((h) => cmds.has(h.command)) && same(e.matcher ?? null, entry.matcher ?? null),
      );
      if (!dup) arr.push(entry);
    }
    cur.hooks[event] = arr;
  }
  writeFileSync(settingsPath, JSON.stringify(cur, null, 2) + "\n");
  console.log("  ✓ ~/.claude/settings.json (user-level hooks 비파괴 머지, 절대경로)");
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
    const header = "# lively work-root 레지스트리 — 줄당 절대경로 prefix. 이 아래에서 켠 세션은 writeback 게이트가 작동.\n# 추가/제거 자유. env LIVELY_WORK_ROOTS 로도 augment 가능.";
    writeFileSync(path, [header, ...existing.filter((l) => l.trim() && !l.startsWith("#"))].join("\n") + "\n");
    chmodSync(path, 0o600);
    console.log(`  ✓ ~/.lively/work-roots (시드 ${added}건 추가)`);
  } else {
    console.log("  · ~/.lively/work-roots (기존 유지)");
  }
}

// ── Codex user-level 설치(자체완결 — adapters/codex/install.mjs 와 동일 동작) ──
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
  : `env LIVELY_HARNESS=codex node "${join(LIVELY, "hooks", script)}"`;
// 커스텀 훅 런너(codex) — codex 가 지원하는 이벤트(SessionStart/PostToolUse/Stop)만 등록. 이벤트는 argv.
const codexRunnerCmd = (event) => WIN
  ? `node "${hookAbs("run-custom.mjs")}" ${event} --harness codex`
  : `env LIVELY_HARNESS=codex node "${join(LIVELY, "hooks", "run-custom.mjs")}" ${event}`;

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
        const parts = String(s.command).trim().split(/\s+/).filter(Boolean);
        out.push("command = [" + parts.map((p) => JSON.stringify(p)).join(", ") + "]");
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

function codexManagedBlock(mcpUrl) {
  // command 줄은 TOML basic 문자열(double-quote, JSON.stringify) — single-quote 리터럴은 escape 불가라
  //  HOME 경로에 아포스트로피('/Users/o'brien')가 있으면 config.toml 전체가 깨진다(사용자 codex 설정 동반 손상 방지).
  const cmd = (s) => `command = ${JSON.stringify(s)}`;
  return [
    CDX_BEGIN, "",
    "[mcp_servers.lively]",
    `url = "${mcpUrl}"`,
    'bearer_token_env_var = "LIVELY_TOKEN"', "",
    ...codexAutoApproveLines(), // [mcp_servers.lively.tools.X] approval_mode="approve" — 자동승인 툴
    ...codexExtraMcpLines(),
    '[[hooks.SessionStart]]', 'matcher = "startup|resume|clear"',
    '[[hooks.SessionStart.hooks]]', 'type = "command"', cmd(codexHookCmd("session-preload.mjs")), "timeout = 10", "",
    '[[hooks.PostToolUse]]', 'matcher = "mcp__lively__.*"',
    '[[hooks.PostToolUse.hooks]]', 'type = "command"', cmd(codexHookCmd("work-flag.mjs")), "timeout = 5", "",
    '[[hooks.PostToolUse]]', 'matcher = "Edit|Write|MultiEdit|NotebookEdit|apply_patch"',
    '[[hooks.PostToolUse.hooks]]', 'type = "command"', cmd(codexHookCmd("work-flag.mjs")), "timeout = 5", "",
    '[[hooks.Stop]]',
    '[[hooks.Stop.hooks]]', 'type = "command"', cmd(codexHookCmd("stop-writeback-gate.mjs")), "timeout = 10", "",
    // 커스텀 훅 런너(codex 지원 이벤트만) — 이벤트별 고정 엔트리.
    '[[hooks.SessionStart]]', 'matcher = "startup|resume|clear"',
    '[[hooks.SessionStart.hooks]]', 'type = "command"', cmd(codexRunnerCmd("SessionStart")), "timeout = 10", "",
    '[[hooks.PostToolUse]]', 'matcher = ".*"',
    '[[hooks.PostToolUse.hooks]]', 'type = "command"', cmd(codexRunnerCmd("PostToolUse")), "timeout = 15", "",
    '[[hooks.Stop]]',
    '[[hooks.Stop.hooks]]', 'type = "command"', cmd(codexRunnerCmd("Stop")), "timeout = 15", "",
    CDX_END,
  ].join("\n");
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
    'if [ -z "${LIVELY_TOKEN:-}" ] && [ -r "$HOME/.lively/token" ]; then export LIVELY_TOKEN="$(cat "$HOME/.lively/token")"; fi',
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
  {
    const wsrc = cloneAbs(join("setup", "work.mjs"));
    if (existsSync(wsrc)) { copyFileSync(wsrc, join(LIVELY, "work.mjs")); chmodSync(join(LIVELY, "work.mjs"), 0o755); console.log("  ✓ ~/.lively/work.mjs"); }
    else console.log("  · ~/.lively/work.mjs 보류(번들에 setup/work.mjs 없음 — 구버전 번들)");
  }

  // 런타임 자산(발행 묶음 .lively/ — 게이트웨이가 org_runtime_config·org_mcp_server 에서 주입) → ~/.lively 복사.
  //  훅(hooks-config.json)·register-clients(mcp-servers.json)가 런타임에 읽음. 없으면 스킵(구버전 번들 호환).
  for (const f of ["hooks-config.json", "mcp-servers.json", "auto-approve.json"]) {
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
    // 게이트웨이 URL: ~/.lively/gateway-url(setup-mac 이 기록) > 기본. /mcp 정규화.
    let gwBase = "http://localhost:8080";
    try { gwBase = (readFileSync(join(LIVELY, "gateway-url"), "utf8").trim() || gwBase); } catch { /* 기본 */ }
    gwBase = gwBase.replace(/\/+$/, "");
    const mcpUrl = /\/mcp$/.test(gwBase) ? gwBase : gwBase + "/mcp";
    installCodex(ctx, mcpUrl);
  }

  console.log("  · MCP 등록(Claude)은 setup 의 register-clients.sh 가 담당. Codex MCP 는 위 config.toml 에 포함.");
  console.log("✓ user-level 설치 완료 — 다음 세션부터 적용(현 세션은 안전).");
}

main().catch((e) => { console.error("✗ user-level 설치 실패:", e?.message || e); process.exit(1); });
