#!/usr/bin/env node
// lively 공통 **제거** 오케스트레이터 — install(setup-mac.sh + adapters/*/install.mjs)의 역연산.
// uninstall = 머신에서 lively 셋업을 **영구 제거**(오프보딩/정리/하드리셋).
//   ≠ incognito(LIVELY_OFF=1): incognito 는 설치는 그대로 두고 훅만 일시 no-op(클린룸). 언제든 되돌아옴.
//   uninstall 은 훅 항목/센티넬 블록/~/.lively 자산을 실제로 떼어낸다(기본은 되돌릴 수 있게 휴지통 이동).
//
// 하는 일:
//  (1) 설치된 하네스 자동 감지(센티넬/훅 존재로 판별) → 있는 것만 어댑터 uninstall 호출(claude/codex). 없는 건 건너뜀.
//  (2) ~/.zshrc(및 형제 rc) 의 lively-managed (codex LIVELY_TOKEN) 센티넬 블록 제거(백업 먼저, 나머지 보존).
//  (3) ~/.lively/ 제거 — **되돌릴 수 있게** 휴지통 이동(~/.lively.removed-<stamp>). --purge 면 하드 삭제.
//
// 플래그:
//   --dry-run            무엇을 지울지 출력만, 변경 없음.
//   --purge              ~/.lively 를 휴지통 이동 대신 하드 삭제(백업 포함 완전 제거).
//   --harness claude|codex|all   대상 하네스 한정(기본 all — 감지된 것 모두).
//
// 샌드박스/테스트: env LIVELY_HOME=<dir> 로 HOME 전체를 리다이렉트(라이브 dogfood 보호). 미지정 시 os.homedir().
//   ※ 스크립트는 런타임 실행이므로 stamp(Date)·env 읽기 허용(워크플로 스크립트와 달리 결정성 제약 없음). LLM/모델 호출 없음.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync, rmSync, cpSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { uninstallClaude } from "../adapters/claude/uninstall.mjs";
import { uninstallCodex } from "../adapters/codex/uninstall.mjs";

// kit 안 오케스트레이터 — 하네스별 어댑터(adapters/claude·codex/uninstall.mjs)를 import 해 dispatch 한다.
//  (install 의 setup-mac.sh → adapters/*/install.mjs 와 같은 미러 관계.)
//  발행물(번들)에는 adapters/ 가 없으므로, 멤버용 self-contained 제거기는 별도(setup/user-uninstall.mjs)다.
//  단일 출처 동기화: 어댑터·user-uninstall.mjs 와 동일 알고리즘을 유지할 것.

const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const PURGE = args.includes("--purge");
const getOpt = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : null; };
const harnessArg = (getOpt("--harness") || "all").toLowerCase();

const log = (s) => console.log(s);

// ~/.zshrc 등 rc 의 LIVELY_TOKEN 센티넬 블록(install.wireCodexTokenEnv 가 심은 것)을 제거.
const RC_BEGIN = "# >>> lively-managed (codex LIVELY_TOKEN) >>>";
const RC_END = "# <<< lively-managed (codex LIVELY_TOKEN) <<<";

export function uninstallRcBlock({ dry = DRY } = {}) {
  // install 은 존재하는 rc 모두(.zshrc/.bashrc/.bash_profile/.profile)에 심을 수 있으므로 동일 후보를 훑는다.
  const candidates = [".zshrc", ".bashrc", ".bash_profile", ".profile"].map((f) => join(HOME, f));
  let total = 0;
  for (const rc of candidates) {
    if (!existsSync(rc)) continue;
    let cur;
    try { cur = readFileSync(rc, "utf8"); } catch { continue; }
    const bi = cur.indexOf(RC_BEGIN);
    if (bi === -1) continue;
    const ei = cur.indexOf(RC_END, bi);
    let next;
    if (ei === -1) {
      // 손상(END 없음) — BEGIN 한 줄만 제거하고 아래 보존(클로버 금지).
      const eol = cur.indexOf("\n", bi);
      const after = eol === -1 ? "" : cur.slice(eol + 1);
      next = (cur.slice(0, bi) + after).replace(/\n{3,}/g, "\n\n");
    } else {
      next = (cur.slice(0, bi) + cur.slice(ei + RC_END.length)).replace(/\n{3,}/g, "\n\n");
    }
    next = next.replace(/\s+$/, "") + "\n";
    const short = rc.replace(HOME, "~");
    if (dry) { log(`  [dry-run] ${short} — LIVELY_TOKEN 센티넬 블록 제거 예정(나머지 보존)`); total++; continue; }
    // 백업 먼저(클로버 금지).
    try {
      mkdirSync(join(LIVELY, "backups"), { recursive: true });
      copyFileSync(rc, join(LIVELY, "backups", "zshrc.uninstall.bak"));
    } catch { try { copyFileSync(rc, rc + ".uninstall.bak"); } catch { /* 백업 실패 시에도 진행 — 블록만 제거 */ } }
    writeFileSync(rc, next);
    log(`  ✓ ${short} — LIVELY_TOKEN 센티넬 블록 제거(나머지 보존)`);
    total++;
  }
  if (total === 0) log("  · ~/.zshrc(및 형제 rc) — lively LIVELY_TOKEN 블록 없음(이미 제거됨/미설치)");
  return total;
}

// 설치된 하네스 감지: 센티넬/훅 존재 여부로 판별.
//  claude: ~/.claude/settings.json 에 ".lively/hooks/" 훅. codex: ~/.codex/config.toml 에 lively 센티넬 블록.
function detectInstalledHarnesses() {
  const out = { claude: false, codex: false };
  const sp = join(HOME, ".claude", "settings.json");
  if (existsSync(sp)) {
    try {
      const s = JSON.parse(readFileSync(sp, "utf8"));
      const hooks = s?.hooks || {};
      out.claude = Object.values(hooks).some(
        (entries) => Array.isArray(entries) && entries.some(
          (e) => Array.isArray(e?.hooks) && e.hooks.some((h) => String(h?.command || "").includes(".lively/hooks/")),
        ),
      );
    } catch { /* 파싱 실패 → 미감지 */ }
  }
  const cp = join(HOME, ".codex", "config.toml");
  if (existsSync(cp)) {
    try {
      const t = readFileSync(cp, "utf8");
      out.codex = t.includes("lively-managed") && t.includes("[mcp_servers.lively]");
    } catch { /* */ }
  }
  return out;
}

// ~/.lively 제거 — 기본 휴지통 이동(되돌릴 수 있게), --purge 면 하드 삭제.
export function removeLivelyDir({ dry = DRY, purge = PURGE } = {}) {
  if (!existsSync(LIVELY)) {
    log("  · ~/.lively 없음 — 건너뜀");
    return null;
  }
  if (purge) {
    if (dry) { log("  [dry-run] ~/.lively 하드 삭제 예정(--purge — 백업 포함 완전 제거, 복구 불가)"); return null; }
    rmSync(LIVELY, { recursive: true, force: true });
    log("  ✓ ~/.lively 하드 삭제(--purge — 복구 불가)");
    return null;
  }
  // 기본: 휴지통 이동(~/.lively.removed-<stamp>). stamp 는 런타임 Date(스크립트라 허용).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  const trash = join(HOME, `.lively.removed-${stamp}`);
  if (dry) { log(`  [dry-run] ~/.lively → ${trash.replace(HOME, "~")} 이동 예정(되돌릴 수 있음 · --purge 면 하드삭제)`); return trash; }
  try {
    renameSync(LIVELY, trash);
  } catch {
    // rename 실패(예: 크로스-디바이스) — 복사 후 원본 삭제로 폴백.
    cpSync(LIVELY, trash, { recursive: true });
    rmSync(LIVELY, { recursive: true, force: true });
  }
  log(`  ✓ ~/.lively → ${trash.replace(HOME, "~")} 이동(되돌리려면: mv "${trash}" "${LIVELY}")`);
  return trash;
}

function main() {
  log(`▶ lively 제거 (HOME=${HOME === homedir() ? "~" : HOME})${DRY ? "  [DRY-RUN — 변경 없음]" : ""}${PURGE ? "  [--purge]" : ""}`);
  log("  (uninstall = 영구 제거. 일시 off 는 incognito: env LIVELY_OFF=1 — 다름.)");

  const detected = detectInstalledHarnesses();
  // 대상 하네스 = install 과 동일 범위(claude·codex만 user-level 어댑터 보유).
  //  TODO(openclaw/pi): install 측이 native 어댑터 없이 register-clients.sh 스니펫만 내므로 제거 어댑터도 미구현(스텁).
  //   openclaw 는 openclaw.json mcpServers 에서 lively 항목 수동 제거, pi 는 pi-mcp-adapter 에서 해제(가이드 안내).
  const want = harnessArg === "all" ? ["claude", "codex"] : [harnessArg];

  // 아무것도 설치 안 됨 + ~/.lively 도 없음 → 클린 no-op.
  const anythingInstalled = detected.claude || detected.codex || existsSync(LIVELY) || hasRcBlock();
  if (!anythingInstalled) {
    log("\n✓ lively 가 이 머신에 설치되어 있지 않습니다 — 제거할 것이 없습니다(no-op).");
    return;
  }

  log(`\n[1] 하네스 감지: claude=${detected.claude ? "o" : "x"} codex=${detected.codex ? "o" : "x"} (대상=${want.join(",")})`);
  if (want.includes("claude")) {
    if (detected.claude) uninstallClaude({ dry: DRY });
    else log("  · Claude — lively 미설치(감지 안 됨), 건너뜀");
  }
  if (want.includes("codex")) {
    if (detected.codex) uninstallCodex({ dry: DRY });
    else log("  · Codex — lively 미설치(감지 안 됨), 건너뜀");
  }

  // 공유 자산(~/.lively + LIVELY_TOKEN export)은 claude·codex 가 함께 쓴다(codex 블록은 /.lively/hooks/* 를 참조,
  //  bearer 인증은 LIVELY_TOKEN export 에 의존). --harness 로 한쪽만 제거했는데 다른 하네스가 아직 설치돼 있으면
  //  공유 자산을 지우면 남은 하네스가 깨진다 → 그 경우엔 공유 자산을 보존한다(설치된 하네스가 하나도 안 남을 때만 제거).
  const othersStillInstalled = (detected.claude && !want.includes("claude")) || (detected.codex && !want.includes("codex"));

  if (othersStillInstalled) {
    log("\n[2] 셸 rc(LIVELY_TOKEN export) — 보존(다른 하네스가 아직 설치됨 — 공유 자산 유지)");
    log("\n[3] ~/.lively 공유 자산 — 보존(다른 하네스가 아직 lively 를 사용 중 — 그 하네스 보호)");
    log(`  · 남은 하네스(${[detected.claude && !want.includes("claude") ? "claude" : null, detected.codex && !want.includes("codex") ? "codex" : null].filter(Boolean).join(",")})까지 제거하려면 --harness all 로 다시 실행하세요.`);
  } else {
    log("\n[2] 셸 rc(LIVELY_TOKEN export) 정리");
    uninstallRcBlock({ dry: DRY });

    log("\n[3] ~/.lively 공유 자산 제거" + (PURGE ? "(--purge: 하드 삭제)" : "(기본: 휴지통 이동, 되돌릴 수 있음)"));
    removeLivelyDir({ dry: DRY, purge: PURGE });
  }

  log("\n✓ lively 제거 완료." + (DRY ? " (dry-run — 아무것도 변경하지 않았습니다.)" : othersStillInstalled ? " (지정 하네스만 제거 — 공유 자산은 남은 하네스를 위해 유지됨.)" : ""));
  if (!DRY && !othersStillInstalled) {
    log("  · 새 터미널을 열면 LIVELY_TOKEN export 가 사라집니다(현 셸엔 남아있을 수 있음 — unset LIVELY_TOKEN).");
    log("  · 다음 claude/codex 세션부터 컨텍스트·훅이 더 이상 주입되지 않습니다.");
    if (!PURGE) log("  · 되돌리려면 ~/.lively.removed-* 를 ~/.lively 로 되돌리고 setup 을 재실행하세요.");
  }
}

function hasRcBlock() {
  for (const f of [".zshrc", ".bashrc", ".bash_profile", ".profile"]) {
    const rc = join(HOME, f);
    if (!existsSync(rc)) continue;
    try { if (readFileSync(rc, "utf8").includes(RC_BEGIN)) return true; } catch { /* */ }
  }
  return false;
}

// 직접 실행할 때만 main() 을 돌린다 — import 만으로 파괴적 동작이 일어나면 안 됨(안전 가드).
//  (uninstallRcBlock/removeLivelyDir 를 export 하므로 import 가능 — 그때 자동 실행 금지.)
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
