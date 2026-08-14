#!/usr/bin/env node
// Antigravity CLI 하네스 어댑터 — user-level **제거**(setup/user-install.mjs 의 installAntigravity 역연산).
// uninstall = 머신에서 lively 셋업을 **영구 제거**. incognito(LIVELY_OFF, 일시 off)와 다르다.
//
// 하는 일(전부 idempotent · surgical · 백업 먼저):
//  (1) ~/.gemini/config/plugins/lively/   ← 플러그인 디렉터리 통째 삭제. **전부 우리 파일**(plugin.json·hooks.json·
//        mcp_config.json·rules/AGENTS.md)이라 surgical 판단이 필요 없다 — plugin-dir 배선의 제거 대칭성 이점.
//        다른 플러그인(사용자 것 포함)은 형제 디렉터리라 불가침.
//  (2) ~/.gemini/antigravity-cli/settings.json ← 우리가 넣은 permissions.allow 규칙만 제거
//        (~/.lively/managed-antigravity-permission.json 이 그 목록의 정본 — 멤버가 손으로 넣은 규칙은 보존).
//        JSON 으로 못 읽는 파일은 건드리지 않는다(비파괴 불변식).
//
// 공유 자산(~/.lively/*)은 여기서 안 지운다 — 공통 정리(setup/uninstall.mjs)가 담당.
// ⚠ agy 의 config.json(플러그인 on/off 기록)은 손대지 않는다 — 존재하지 않는 플러그인의 엔트리는 무해하고,
//   그 파일은 사용자 설정(remoteControlHostname 등)을 함께 담아 우리가 만질 자격이 없다.
//
// 사용법: node adapters/antigravity/uninstall.mjs [--dry-run]
// 샌드박스/테스트: env LIVELY_HOME=<dir> 로 HOME 리다이렉트(라이브 보호). 미지정 시 os.homedir().

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
// 설치기와 **같은 계산**이어야 역연산이 성립한다 — agy 는 경로 env 오버라이드가 없다($HOME 만, #1689 실측).
const GEMINI = join(HOME, ".gemini");
const AGY_PLUGIN = join(GEMINI, "config", "plugins", "lively");
const AGY_SETTINGS = join(GEMINI, "antigravity-cli", "settings.json");
const AGY_HOOKS = join(GEMINI, "config", "hooks.json");   // 훅은 글로벌 루트(#1689 — 플러그인 훅은 CLI 가 안 읽는다)

const log = (s) => console.log(s);

function backup(path, name) {
  try {
    const dir = join(LIVELY, "backups");
    mkdirSync(dir, { recursive: true });
    if (existsSync(path)) copyFileSync(path, join(dir, name));
  } catch { /* 백업 실패해도 아래 편집은 surgical(비파괴) */ }
}

// (1) 플러그인 디렉터리 제거 — 통째로 우리 것.
export function removePluginDir({ dry = false } = {}) {
  if (!existsSync(AGY_PLUGIN)) { log("  · ~/.gemini/config/plugins/lively/ 없음 — 건너뜀"); return 0; }
  if (dry) { log("  [dry-run] ~/.gemini/config/plugins/lively/ 제거 예정(다른 플러그인 불가침)"); return 1; }
  try { rmSync(AGY_PLUGIN, { recursive: true, force: true }); }
  catch (e) { log(`  ⚠️ 플러그인 제거 실패: ${e.message}`); return 0; }
  log("  ✓ ~/.gemini/config/plugins/lively/ 제거(다른 플러그인 불가침)");
  return 1;
}

// (2) settings.json 에서 우리가 심은 permissions.allow 규칙만 제거. 반환: 제거한 규칙 수.
export function removePermissionRules({ dry = false } = {}) {
  if (!existsSync(AGY_SETTINGS)) { log("  · ~/.gemini/antigravity-cli/settings.json 없음 — 건너뜀"); return 0; }
  let managed = [];
  try { managed = JSON.parse(readFileSync(join(LIVELY, "managed-antigravity-permission.json"), "utf8")); if (!Array.isArray(managed)) managed = []; }
  catch { log("  · managed-antigravity-permission.json 없음 — 승인 규칙은 손대지 않는다"); return 0; }
  if (!managed.length) { log("  · 우리가 심은 antigravity 승인 규칙 없음 — 무수정"); return 0; }
  let cur;
  try { cur = JSON.parse(readFileSync(AGY_SETTINGS, "utf8")); }
  catch { log(`  ⚠️ ${AGY_SETTINGS.replace(HOME, "~")} 를 JSON 으로 못 읽었습니다 — 수동으로 mcp(lively/*) 규칙을 지우세요.`); return 0; }
  if (!cur || typeof cur !== "object" || Array.isArray(cur)) { log("  · settings.json 이 객체가 아님 — 건너뜀"); return 0; }
  const allow = (cur.permissions && Array.isArray(cur.permissions.allow)) ? cur.permissions.allow : null;
  if (!allow) { log("  · settings.json — permissions.allow 없음. 무수정"); return 0; }
  const managedSet = new Set(managed);
  const next = allow.filter((e) => !managedSet.has(e));
  const removed = allow.length - next.length;
  if (!removed) { log("  · settings.json — lively 승인 규칙 없음(이미 제거됨). 무수정"); return 0; }
  if (dry) { log(`  [dry-run] ~/.gemini/antigravity-cli/settings.json — 규칙 ${removed}건 제거 예정(사용자 규칙 보존)`); return removed; }
  backup(AGY_SETTINGS, "antigravity-settings.uninstall.bak");
  cur.permissions.allow = next;
  if (!cur.permissions.allow.length) delete cur.permissions.allow;
  if (cur.permissions && !Object.keys(cur.permissions).length) delete cur.permissions;
  try { writeFileSync(AGY_SETTINGS, JSON.stringify(cur, null, 2) + "\n"); }
  catch (e) { log(`  ⚠️ settings.json 쓰기 실패: ${e.message}`); return 0; }
  log(`  ✓ ~/.gemini/antigravity-cli/settings.json — lively 승인 규칙 ${removed}건 제거(사용자 규칙 보존, 백업됨)`);
  return removed;
}

// (3) 글로벌 hooks.json 에서 우리 이름("lively") 키만 제거. 사용자의 다른 이름 훅은 불변.
export function removeHooksKey({ dry = false } = {}) {
  if (!existsSync(AGY_HOOKS)) { log("  · ~/.gemini/config/hooks.json 없음 — 건너뜀"); return 0; }
  let cur;
  try { cur = JSON.parse(readFileSync(AGY_HOOKS, "utf8")); }
  catch { log(`  ⚠️ ${AGY_HOOKS.replace(HOME, "~")} 를 JSON 으로 못 읽었습니다 — 수동으로 "lively" 키를 지우세요.`); return 0; }
  if (!cur || typeof cur !== "object" || Array.isArray(cur) || cur.lively === undefined) { log("  · hooks.json — lively 키 없음(이미 제거됨/미설치). 무수정"); return 0; }
  if (dry) { log("  [dry-run] ~/.gemini/config/hooks.json — lively 키 제거 예정(사용자 훅 보존)"); return 1; }
  backup(AGY_HOOKS, "antigravity-hooks.uninstall.bak");
  delete cur.lively;
  try {
    if (Object.keys(cur).length) writeFileSync(AGY_HOOKS, JSON.stringify(cur, null, 2) + "\n");
    else rmSync(AGY_HOOKS, { force: true });   // 우리 키가 전부였다 — 빈 파일을 남기지 않는다(백업됨)
  } catch (e) { log(`  ⚠️ hooks.json 정리 실패: ${e.message}`); return 0; }
  log("  ✓ ~/.gemini/config/hooks.json — lively 훅 키 제거(사용자 훅 보존)");
  return 1;
}

export function uninstallAntigravity({ dry = false } = {}) {
  log("  ── Antigravity ──");
  return removePluginDir({ dry }) + removeHooksKey({ dry }) + removePermissionRules({ dry });
}

// 직접 실행일 때만 수행 — 판정 불가면 **실행하지 않는다**(제거는 안 도는 편이 안전 — opencode 어댑터와 동일 패턴).
const DIRECT_RUN = (() => {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || ""); }
  catch { return false; }
})();
if (DIRECT_RUN) uninstallAntigravity({ dry: process.argv.includes("--dry-run") });
