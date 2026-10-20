#!/usr/bin/env node
// Cursor(IDE·CLI) 하네스 어댑터 — user-level **제거**(setup/user-install.mjs 의 installCursor 역연산, #4927).
// uninstall = 머신에서 lively 셋업을 **영구 제거**. incognito(LIVELY_OFF, 일시 off)와 다르다.
//
// 하는 일(전부 idempotent · surgical · 백업 먼저 — 전부 **우리 것만**):
//  (1) ~/.cursor/hooks.json   ← command 가 ~/.lively/hooks/cursor-adapter.mjs 를 가리키는 엔트리만 제거. 사용자 훅 보존.
//        (파일은 사용자와 공유다 — grok 처럼 통째로 지울 수 없다.) 남는 게 version 뿐이면 파일을 지운다(백업됨).
//  (2) ~/.cursor/mcp.json     ← 원장(~/.lively/managed-cursor-mcp.json)의 이름만 제거. 설치 전 같은 이름의 사용자 값이
//        있었으면(~/.lively/cursor-mcp-user-backup.json) 그 값으로 되돌린다.
//  (3) cli-config.json        ← 원장(~/.lively/managed-cursor-permission.json)의 승인 규칙만 permissions.allow 에서 제거.
//
// 공유 자산(~/.lively/*)은 여기서 안 지운다 — 공통 정리(setup/uninstall.mjs)가 담당.
// 단일 출처 동기화: setup/user-uninstall.mjs 의 uninstallCursorWiring 과 같은 알고리즘이다(발행 번들엔 adapters/ 가 없어
//  그쪽은 자립 사본을 갖는다).
//
// 사용법: node adapters/cursor/uninstall.mjs [--dry-run]
// 샌드박스/테스트: env LIVELY_HOME=<dir> 로 HOME 리다이렉트(라이브 보호). 미지정 시 os.homedir().

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
// 설치기와 **같은 계산**이어야 역연산이 성립한다(harness-registry cursor 행 · cursorCliConfigDir).
const CURSOR = join(HOME, ".cursor");
const CURSOR_CLI_DIR = process.env.LIVELY_HOME ? CURSOR
  : (String(process.env.CURSOR_CONFIG_DIR || "").trim()
    || (String(process.env.XDG_CONFIG_HOME || "").trim() ? join(String(process.env.XDG_CONFIG_HOME).trim(), "cursor") : CURSOR));
const CURSOR_HOOKS = join(CURSOR, "hooks.json");
const CURSOR_MCP = join(CURSOR, "mcp.json");
const CURSOR_CLI_CONFIG = join(CURSOR_CLI_DIR, "cli-config.json");
const isOurCursorHook = (e) => !!e && typeof e === "object" && !Array.isArray(e)
  && typeof e.command === "string" && /[/\\]\.lively[/\\]hooks[/\\]cursor-adapter\.mjs\b/.test(e.command);

const log = (s) => console.log(s);
const readJsonObj = (p) => { try { const v = JSON.parse(readFileSync(p, "utf8")); return (v && typeof v === "object" && !Array.isArray(v)) ? v : null; } catch { return null; } };
const readList = (p) => { try { const v = JSON.parse(readFileSync(p, "utf8")); return Array.isArray(v) ? v : []; } catch { return []; } };

function backup(path, name) {
  try {
    const dir = join(LIVELY, "backups");
    mkdirSync(dir, { recursive: true });
    if (existsSync(path)) copyFileSync(path, join(dir, name));
  } catch { /* 백업 실패해도 아래 편집은 surgical(비파괴) */ }
}

// 우리 훅 엔트리 감지 — setup/uninstall.mjs 의 detect 가 쓴다.
export function cursorHooksWired() {
  const cur = existsSync(CURSOR_HOOKS) ? readJsonObj(CURSOR_HOOKS) : null;
  const hooks = cur && cur.hooks && typeof cur.hooks === "object" ? cur.hooks : {};
  return Object.values(hooks).some((arr) => Array.isArray(arr) && arr.some(isOurCursorHook));
}

// (1) hooks.json 의 우리 엔트리만 제거.
export function removeHookEntries({ dry = false } = {}) {
  if (!existsSync(CURSOR_HOOKS)) { log("  · ~/.cursor/hooks.json 없음 — 건너뜀"); return 0; }
  const cur = readJsonObj(CURSOR_HOOKS);
  if (!cur) { log("  ⚠️ ~/.cursor/hooks.json 파싱 실패 — 무수정(수동으로 cursor-adapter.mjs 엔트리 제거 필요)"); return 0; }
  const hooks = (cur.hooks && typeof cur.hooks === "object" && !Array.isArray(cur.hooks)) ? { ...cur.hooks } : {};
  let removed = 0;
  for (const [ev, arr] of Object.entries(hooks)) {
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((e) => !isOurCursorHook(e));
    removed += arr.length - kept.length;
    if (kept.length === arr.length) continue;
    if (kept.length) hooks[ev] = kept; else delete hooks[ev];
  }
  if (!removed) { log("  · ~/.cursor/hooks.json — lively 엔트리 없음. 무수정"); return 0; }
  if (dry) { log(`  [dry-run] ~/.cursor/hooks.json — lively 엔트리 ${removed}개 제거 예정(사용자 훅 보존)`); return 1; }
  backup(CURSOR_HOOKS, "cursor-hooks.uninstall.bak");
  const next = { ...cur, hooks };
  const onlyOurs = !Object.keys(hooks).length && Object.keys(next).every((k) => k === "version" || k === "hooks");
  try {
    if (onlyOurs) rmSync(CURSOR_HOOKS, { force: true });   // 우리 엔트리가 전부였다 — 빈 파일을 남기지 않는다(백업됨)
    else writeFileSync(CURSOR_HOOKS, JSON.stringify(next, null, 2) + "\n");
  } catch (e) { log(`  ⚠️ hooks.json 정리 실패: ${e.message}`); return 0; }
  log(`  ✓ ~/.cursor/hooks.json — lively 엔트리 ${removed}개 제거(사용자 훅 보존, 백업됨)`);
  return 1;
}

// (2) mcp.json 의 원장 이름만 제거(설치 전 사용자 값 복원).
export function removeMcpServers({ dry = false } = {}) {
  const ledger = readList(join(LIVELY, "managed-cursor-mcp.json"));
  if (!existsSync(CURSOR_MCP) || !ledger.length) { log(`  · ~/.cursor/mcp.json — ${existsSync(CURSOR_MCP) ? "lively 원장 없음" : "없음"}. 무수정`); return 0; }
  const cur = readJsonObj(CURSOR_MCP);
  if (!cur) { log("  ⚠️ ~/.cursor/mcp.json 파싱 실패 — 무수정(수동으로 lively 서버 제거 필요)"); return 0; }
  // mcpServers 가 객체가 아니면 손대지 않는다 — {} 로 갈아끼우면 사용자 값이 사라진다(설치기 mergeCursorMcp 와 같은 규칙).
  if (cur.mcpServers !== undefined && (!cur.mcpServers || typeof cur.mcpServers !== "object" || Array.isArray(cur.mcpServers))) {
    log("  ⚠️ ~/.cursor/mcp.json 의 mcpServers 가 객체가 아님 — 무수정(수동으로 lively 서버 제거 필요)"); return 0;
  }
  let ub = {}; try { ub = JSON.parse(readFileSync(join(LIVELY, "cursor-mcp-user-backup.json"), "utf8")) || {}; } catch { /* */ }
  const ms = { ...(cur.mcpServers || {}) };
  for (const name of ledger) {
    if (ub[name] && typeof ub[name] === "object") ms[name] = ub[name];   // 설치 전 사용자 값 복원
    else delete ms[name];
  }
  if (dry) { log(`  [dry-run] ~/.cursor/mcp.json — ${ledger.join(", ")} 제거 예정(사용자 서버 보존)`); return 1; }
  backup(CURSOR_MCP, "cursor-mcp.uninstall.bak");
  try {
    writeFileSync(CURSOR_MCP, JSON.stringify({ ...cur, mcpServers: ms }, null, 2) + "\n");
    for (const f of ["managed-cursor-mcp.json", "cursor-mcp-user-backup.json"]) { try { rmSync(join(LIVELY, f), { force: true }); } catch { /* */ } }
  } catch (e) { log(`  ⚠️ mcp.json 정리 실패: ${e.message}`); return 0; }
  log(`  ✓ ~/.cursor/mcp.json — ${ledger.join(", ")} 제거(사용자 서버 보존, 백업됨)`);
  return 1;
}

// (3) cli-config.json 의 원장 승인 규칙만 제거.
export function removeCliPermissions({ dry = false } = {}) {
  const managed = readList(join(LIVELY, "managed-cursor-permission.json"));
  if (!existsSync(CURSOR_CLI_CONFIG) || !managed.length) return 0;
  const cur = readJsonObj(CURSOR_CLI_CONFIG);
  if (!cur || !cur.permissions || !Array.isArray(cur.permissions.allow)) { log("  · Cursor cli-config.json — 승인 목록 없음/파싱 실패. 무수정"); return 0; }
  const set = new Set(managed);
  const allow = cur.permissions.allow.filter((e) => !set.has(e));
  if (allow.length === cur.permissions.allow.length) { log("  · Cursor cli-config.json — lively 승인 규칙 없음. 무수정"); return 0; }
  if (dry) { log("  [dry-run] Cursor cli-config.json — lively 승인 규칙 제거 예정(사용자 규칙 보존)"); return 1; }
  backup(CURSOR_CLI_CONFIG, "cursor-cli-config.uninstall.bak");
  try { writeFileSync(CURSOR_CLI_CONFIG, JSON.stringify({ ...cur, permissions: { ...cur.permissions, allow } }, null, 2) + "\n"); }
  catch (e) { log(`  ⚠️ cli-config.json 정리 실패: ${e.message}`); return 0; }
  log("  ✓ Cursor cli-config.json — lively 승인 규칙 제거(사용자 규칙 보존, 백업됨)");
  return 1;
}

export function uninstallCursor({ dry = false } = {}) {
  log("  ── Cursor ──");
  return removeHookEntries({ dry }) + removeMcpServers({ dry }) + removeCliPermissions({ dry });
}

// 직접 실행일 때만 수행 — 판정 불가면 **실행하지 않는다**(제거는 안 도는 편이 안전 — 타 어댑터와 동일 패턴).
const DIRECT_RUN = (() => {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || ""); }
  catch { return false; }
})();
if (DIRECT_RUN) uninstallCursor({ dry: process.argv.includes("--dry-run") });
