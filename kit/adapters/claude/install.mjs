#!/usr/bin/env node
// Claude 하네스 어댑터 — user-level 설치(D2/D3). 어느 폴더에서 켜든 컨텍스트+리플렉스가 오게 한다.
// 하는 일(전부 idempotent):
//  (a) ~/.lively/context.md  ← 정적 org-context (buildStaticContext, 토큰/시크릿 없음)
//  (b) ~/.lively/hooks/{session-preload,work-flag,stop-writeback-gate}.mjs  ← 훅 스크립트 복사(chmod 755)
//  (c) ~/.claude/settings.json  ← SAFE-MERGE: user-level 절대경로 훅 블록을 비파괴 머지(백업 먼저)
//  (d) ~/.lively/work-roots  ← 자가 게이팅용 work-root 시드(없을 때만, 기존 보존)
//  (e) MCP 등록은 register-clients.sh 에 위임 — 여기서 claude mcp add 호출하지 않음(중복 등록 방지).
//
// 사용법: node adapters/claude/install.mjs --org <org-content-dir> [--work-root <abs-path>]…
//   user-install.mjs 가 토큰/게이트웨이 등록 후 이걸 호출한다.
// 비파괴 핵심: ~/.claude/settings.json 의 hooks 외 다른 키(env/permissions/enabledPlugins/theme/Stop의 tmux 훅 등)는
//   절대 건드리지 않는다. user-level 훅 command 는 반드시 절대경로(\$CLAUDE_PROJECT_DIR 는 user-level 에서 미정의).

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  cpSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStaticContext, deriveOrgName } from "../../generator/build-context.mjs";
import { WORK_ROOTS_HEADER } from "../../setup/work-roots-header.mjs";

// P-V3-5 Part A: 정적 폴백 context.md 단일소스 — 게이트웨이가 가용하면 DB-materialize 한 정적 컨텍스트(=AGENTS.md/
//  preview 와 동일 DB Knowledge Index)를 받아 박고, 다운/토큰없음/오프라인이면 파일기반 buildStaticContext 로 폴백.
//  진실원천 이원화 해소: 게이트웨이 가용 시 오프라인 폴백도 DB-인덱스를 보유(stale 파일기반 MEMORY.md 탈피).
//  토큰/주소는 ~/.lively/{token,gateway-url}(부트스트랩·CLI 가 기록) 또는 env(LIVELY_TOKEN/LIVELY_GATEWAY_URL).
async function fetchDbStaticContext(home) {
  const readLively = (rel) => { try { return readFileSync(join(home, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
  const token = (process.env.LIVELY_TOKEN || "").trim() || readLively("token");
  if (!token) return null;
  const gw = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLively("gateway-url") || "http://localhost:8080").replace(/\/$/, "");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const res = await fetch(`${gw}/api/ui/org/preview`, { signal: ctl.signal, headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const j = await res.json();
    const ctx = j && typeof j.context === "string" ? j.context.trim() : "";
    return ctx ? ctx + "\n" : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const kitAbs = (p) => join(KIT_ROOT, p);
// HOME: 기본 OS homedir(), env LIVELY_HOME 로 리다이렉트 가능(샌드박스 격리 — uninstall 과 동일 계약).
//  ※ install/uninstall 대칭: 라운드트립 테스트 시 양쪽에 같은 LIVELY_HOME 을 지정해야 한쪽만 라이브에 닿는 footgun 을 막는다.
const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
const HOOK_SCRIPTS = ["session-preload.mjs", "work-flag.mjs", "stop-writeback-gate.mjs"];

// user-level 훅 command — 플랫폼별 정규형(기존 맥 문자열 동일 유지 = idempotency 키 안정).
//  Windows: $HOME 셸확장 불가 → forward-slash 절대경로. 제거 매칭은 '.lively/hooks/' 부분문자열(양쪽 포함).
const fwd = (p) => p.replace(/\\/g, "/");
const WIN = process.platform === "win32";
// #355: 훅이 부트스트랩한 번들 node(~/.lively/runtime/current/bin/node — 안정 심링크)의 절대경로로 실행돼
//  실행 셸 PATH 와 무관하게 동작하도록. 없으면(시스템 node) 기존대로 PATH 의 `node`. Windows 는 User PATH 로 처리(bare).
const bundledNode = join(LIVELY, "runtime", "current", "bin", "node");
const NODEBIN = (!WIN && existsSync(bundledNode)) ? bundledNode : "node";
const hookCmd = (script) => WIN ? `node "${fwd(join(LIVELY, "hooks", script))}"` : `"${NODEBIN}" "$HOME/.lively/hooks/${script}"`;

// settings-hooks.json 의 matcher/timeout 을 그대로 쓰되 command 만 절대경로로 치환.
function userLevelHooksBlock() {
  const tpl = JSON.parse(readFileSync(kitAbs("hooks/settings-hooks.json"), "utf8"));
  const out = {};
  for (const [event, entries] of Object.entries(tpl.hooks)) {
    out[event] = entries.map((entry) => ({
      ...entry,
      hooks: entry.hooks.map((h) => {
        // command 안의 스크립트 파일명을 추출해 절대경로 command 로 재작성.
        const m = String(h.command || "").match(/([\w-]+\.mjs)/);
        const script = m ? m[1] : null;
        return script && HOOK_SCRIPTS.includes(script) ? { ...h, command: hookCmd(script) } : h;
      }),
    }));
  }
  return out;
}

// emitHooks 와 동일한 비파괴 머지 알고리즘(command+matcher 기준 idempotent).
function safeMergeUserSettings(blockHooks) {
  const settingsPath = join(HOME, ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });

  let cur = {};
  if (existsSync(settingsPath)) {
    // 백업 먼저 — 실패하면 중단(클로버 금지).
    const backupDir = join(LIVELY, "backups");
    mkdirSync(backupDir, { recursive: true });
    try {
      copyFileSync(settingsPath, join(backupDir, "settings.json.bak"));
    } catch (e) {
      console.error(`✗ ~/.claude/settings.json 백업 실패 — 중단: ${e.message}`);
      process.exit(1);
    }
    try {
      cur = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      console.warn("  ⚠️ ~/.claude/settings.json JSON 파싱 실패 — hooks 머지 건너뜀(기존 파일 무수정)");
      return;
    }
  }
  if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
    console.warn("  ⚠️ ~/.claude/settings.json 가 객체가 아님 — hooks 머지 건너뜀");
    return;
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

// work-roots 시드 — 없을 때만 생성/추가. 기존 항목 보존(중복 추가 안 함).
function seedWorkRoots(roots) {
  if (!roots.length) return;
  const path = join(LIVELY, "work-roots");
  let existing = [];
  if (existsSync(path)) {
    existing = readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  const set = new Set(existing.filter((l) => !l.startsWith("#")));
  let added = 0;
  for (const r of roots) {
    const abs = resolve(r);
    if (!set.has(abs)) { existing.push(abs); set.add(abs); added++; }
  }
  if (added || !existsSync(path)) {
    const header = WORK_ROOTS_HEADER;
    const body = [header, ...existing.filter((l) => l.trim() && !l.startsWith("#"))].join("\n") + "\n";
    writeFileSync(path, body);
    chmodSync(path, 0o600);
    console.log(`  ✓ ~/.lively/work-roots (시드 ${added}건 추가)`);
  } else {
    console.log("  · ~/.lively/work-roots (기존 유지)");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const getOpt = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
  const orgArg = getOpt("--org");
  if (!orgArg) {
    console.error("✗ --org <org-content-dir> 가 필요합니다.");
    process.exit(1);
  }
  const orgRoot = resolve(process.cwd(), orgArg);
  const orgNameArg = getOpt("--org-name"); // 표시명 오버라이드(미지정 시 org-defaults.md 에서 도출)
  // 반복 가능한 --work-root
  const workRoots = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--work-root" && args[i + 1]) workRoots.push(args[i + 1]);
  }

  console.log(`▶ Claude 어댑터 user-level 설치 (org=${basename(orgRoot)})`);
  mkdirSync(LIVELY, { recursive: true, mode: 0o700 });

  // (a) 정적 org-context + org 표시명 사이드카(preload 라이브 헤더용)
  //  단일소스 우선순위: 게이트웨이 DB-materialize(preview, DB Knowledge Index) > 파일기반 buildStaticContext(오프라인 폴백).
  //  게이트웨이 가용 시 오프라인 폴백 context.md 도 DB-인덱스를 보유(진실원천 이원화 해소). org 표시명은 항상 파일기반에서 도출(중립).
  const orgName = orgNameArg && String(orgNameArg).trim() ? String(orgNameArg).trim() : deriveOrgName(orgRoot);
  const dbCtx = await fetchDbStaticContext(HOME);
  const ctx = dbCtx ?? buildStaticContext(orgRoot, orgName).context;
  const ctxSource = dbCtx ? "게이트웨이 DB(Knowledge Index)" : "파일기반 폴백(오프라인)";
  writeFileSync(join(LIVELY, "context.md"), ctx);
  chmodSync(join(LIVELY, "context.md"), 0o600);
  writeFileSync(join(LIVELY, "org-name"), orgName + "\n");
  chmodSync(join(LIVELY, "org-name"), 0o600);
  console.log(`  ✓ ~/.lively/context.md (${(Buffer.byteLength(ctx, "utf8") / 1024).toFixed(1)} KiB · ${ctxSource}) · org-name=${orgName}`);

  // (b) 훅 스크립트 복사
  const hooksDir = join(LIVELY, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  for (const f of HOOK_SCRIPTS) {
    cpSync(kitAbs(join("hooks", f)), join(hooksDir, f));
    chmodSync(join(hooksDir, f), 0o755);
  }
  console.log(`  ✓ ~/.lively/hooks/ (${HOOK_SCRIPTS.length}개)`);

  // (c) user-level settings 비파괴 머지(절대경로)
  safeMergeUserSettings(userLevelHooksBlock());

  // (d) work-root 시드
  seedWorkRoots(workRoots);

  // (e) MCP 등록은 register-clients.sh 에 위임 — 여기서 안 함.
  console.log("  · MCP 등록은 setup 의 register-clients.sh 가 담당(어댑터는 호출 안 함)");
  console.log("✓ Claude 어댑터 설치 완료 — 다음 세션부터 적용(현 세션은 안전).");
}

main().catch((e) => { console.error(`✗ 설치 실패: ${e?.message || e}`); process.exit(1); });
