#!/usr/bin/env node
// Claude 하네스 어댑터 — user-level **제거**(install.mjs 의 정확한 역연산).
// uninstall = 머신에서 lively 셋업을 **영구 제거**(오프보딩/정리/하드리셋). incognito(LIVELY_OFF, 일시 off)와 다르다.
//
// 하는 일(전부 idempotent · surgical · 백업 먼저):
//  (1) ~/.claude/settings.json  ← lively 훅 항목만 제거(command 에 ".lively/hooks/" 포함하는 엔트리).
//        이벤트 배열이 비면 그 이벤트 키를 드롭. tmux Stop 훅 + hooks 외 모든 키(env/permissions/theme/…)는 보존.
//        편집 전 settings.json.uninstall.bak 백업. lively 마커가 전혀 없으면 무수정(클로버 금지).
//  (2) MCP 등록 해제: `claude mcp remove lively --scope user` (idempotent — "not found" 무시).
//        install 은 register-clients.sh 가 `claude mcp add --scope user lively` 로 등록했다.
//        ※ claude CLI 는 HOME 을 존중(검증: HOME=<dir> claude mcp list → 그 dir 의 ~/.claude.json) — 샌드박스 격리의 핵심.
//          deregister 는 자식 프로세스에 HOME=<targetHome> 을 명시 주입 → 샌드박스면 라이브 ~/.claude.json 무접촉.
//
// 공유 자산(~/.lively/*)은 여기서 지우지 않는다 — codex 어댑터와 공유하므로 공통 정리(setup/uninstall.mjs)가 담당.
//
// 사용법: node adapters/claude/uninstall.mjs [--dry-run]
//   --dry-run: 무엇을 지울지 출력만, 변경 없음.
// 샌드박스/테스트: env LIVELY_HOME=<dir> 로 HOME 을 리다이렉트(라이브 머신 보호). 미지정 시 os.homedir().

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
const LIVELY_HOOK_MARK = ".lively/hooks/"; // lively user-level 훅 command 의 식별 substring

const DRY = process.argv.includes("--dry-run");
const log = (s) => console.log(s);

// settings.json 에서 lively 훅 엔트리만 surgical 제거. 반환: 제거된 항목 수.
export function uninstallClaudeSettings({ dry = DRY } = {}) {
  const settingsPath = join(HOME, ".claude", "settings.json");
  if (!existsSync(settingsPath)) {
    log("  · ~/.claude/settings.json 없음 — 건너뜀");
    return 0;
  }
  let cur;
  try {
    cur = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    log("  ⚠️ ~/.claude/settings.json JSON 파싱 실패 — 무수정(수동 확인 필요)");
    return 0;
  }
  if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !cur.hooks || typeof cur.hooks !== "object") {
    log("  · ~/.claude/settings.json 에 hooks 없음 — 제거할 lively 훅 없음");
    return 0;
  }

  // lively 핸들러 판별: command 에 ".lively/hooks/" 포함.
  const isLivelyCmd = (h) => String(h?.command || "").includes(LIVELY_HOOK_MARK);

  let removed = 0;
  const nextHooks = {};
  for (const [event, entries] of Object.entries(cur.hooks)) {
    if (!Array.isArray(entries)) { nextHooks[event] = entries; continue; }
    const kept = [];
    for (const entry of entries) {
      const inner = Array.isArray(entry?.hooks) ? entry.hooks : [];
      // 한 entry 안에 lively+비-lively 핸들러가 섞였을 수 있다(같은 matcher) — lively 핸들러만 떼고 비-lively 는 보존.
      const keptInner = inner.filter((h) => !isLivelyCmd(h));
      const dropped = inner.length - keptInner.length;
      removed += dropped;
      if (inner.length > 0 && keptInner.length === 0) continue; // entry 전부 lively → entry 통째 제거
      kept.push(dropped > 0 ? { ...entry, hooks: keptInner } : entry); // 일부만 lively → 남은 핸들러로 entry 보존
    }
    // 이벤트 배열이 비면 그 키를 드롭(install 이 만든 빈 껍데기 잔류 방지). 원래 다른 훅이 있던 이벤트는 유지.
    if (kept.length) nextHooks[event] = kept;
  }

  if (removed === 0) {
    log("  · ~/.claude/settings.json — lively 훅 없음(이미 제거됨/미설치). 무수정");
    return 0;
  }

  if (dry) {
    log(`  [dry-run] ~/.claude/settings.json — lively 훅 엔트리 ${removed}건 제거 예정(tmux/기타 키 보존)`);
    return removed;
  }

  // 백업 먼저(클로버 금지) — ~/.lively/backups 에. ~/.lively 가 이미 옮겨졌어도 settings 옆엔 안 남기고 backups 우선 시도.
  const backupDir = join(LIVELY, "backups");
  try {
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(settingsPath, join(backupDir, "settings.json.uninstall.bak"));
  } catch (e) {
    // ~/.lively 가 없으면 settings.json 옆에 백업(클로버 절대 금지).
    try { copyFileSync(settingsPath, settingsPath + ".uninstall.bak"); }
    catch (e2) { console.error(`✗ settings.json 백업 실패 — 중단(클로버 금지): ${e.message} / ${e2.message}`); process.exit(1); }
  }

  cur.hooks = nextHooks;
  // hooks 가 완전히 비면 키 자체를 드롭(install 전 상태와 대칭 — 단, 원래 hooks 키가 있었는지 모르므로 빈 객체면 제거).
  if (Object.keys(cur.hooks).length === 0) delete cur.hooks;

  // 의도된 동작: JSON.stringify 로 재직렬화하므로 결과는 의미상 동일하되 byte-identical 은 아님(2-space indent 통일,
  //  키 순서가 바뀔 수 있고, 비워진 이벤트 키가 빠짐). lively 훅 + 빈 이벤트 키만 제거되고 tmux/기타 키는 보존된다.
  writeFileSync(settingsPath, JSON.stringify(cur, null, 2) + "\n");
  log(`  ✓ ~/.claude/settings.json — lively 훅 ${removed}건 제거(tmux/기타 키 보존, 백업: backups/settings.json.uninstall.bak)`);
  return removed;
}

// claude mcp remove lively — install 의 `claude mcp add --scope user lively` 역연산. idempotent.
//  자식 프로세스 HOME 을 모듈 HOME(=LIVELY_HOME or os.homedir())으로 명시 주입 → 샌드박스면 라이브 무접촉.
export function deregisterClaudeMcp({ dry = DRY } = {}) {
  const cmd = ["mcp", "remove", "lively", "--scope", "user"];
  if (dry) {
    log(`  [dry-run] MCP 등록 해제 명령(미실행): HOME=${HOME} claude ${cmd.join(" ")}`);
    return;
  }
  try {
    // execFileSync — 셸 인젝션 없음. stdio 캡처(토큰 등 비노출). HOME=모듈HOME → claude CLI 가 그 HOME 의 ~/.claude.json 조작.
    execFileSync("claude", cmd, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME } });
    log(`  ✓ claude mcp remove lively --scope user (HOME=${HOME})`);
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message || "");
    if (/not found|no.*server|존재하지|찾을 수 없/i.test(msg)) {
      log("  · claude mcp: lively 미등록(이미 해제됨) — 건너뜀");
    } else if (/command not found|ENOENT/i.test(msg)) {
      log("  ⚠️ claude CLI 미발견 — MCP 등록 해제 건너뜀(수동: claude mcp remove lively --scope user)");
    } else {
      log(`  ⚠️ claude mcp remove 경고(무시 가능): ${msg.split("\n")[0]}`);
    }
  }
}

export function uninstallClaude(opts = {}) {
  log("▶ Claude 어댑터 user-level 제거");
  const n = uninstallClaudeSettings(opts);
  deregisterClaudeMcp(opts);
  return n;
}

// 직접 실행 시(오케스트레이터가 import 하면 자동 실행 안 됨).
if (import.meta.url === `file://${process.argv[1]}`) {
  uninstallClaude();
  log("✓ Claude 어댑터 제거 완료." + (DRY ? " (dry-run — 변경 없음)" : ""));
}
