#!/usr/bin/env node
// lively 공통 **제거** 오케스트레이터 — install(user-install.mjs + adapters/*/install.mjs)의 역연산.
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
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync, rmSync, cpSync, realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { uninstallClaude } from "../adapters/claude/uninstall.mjs";
import { uninstallCodex } from "../adapters/codex/uninstall.mjs";

// kit 안 오케스트레이터 — 하네스별 어댑터(adapters/claude·codex/uninstall.mjs)를 import 해 dispatch 한다.
//  (install 의 user-install.mjs → adapters/*/install.mjs 와 같은 미러 관계.)
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
// #355: setup 이 심는 번들 Node PATH 블록(~/.lively/runtime)도 함께 제거 — ~/.lively 삭제와 대칭.
//  local-bin 블록(# >>> lively-managed (PATH: local-bin) >>>)은 claude 소유라 의도적으로 보존한다.
const PATH_NODE_BEGIN = "# >>> lively-managed (PATH: node) >>>";
const PATH_NODE_END = "# <<< lively-managed (PATH: node) <<<";

// text 에서 [begin,end] 센티넬 블록 1개 제거(END 손상 시 begin 한 줄만 제거·아래 보존 — 클로버 금지).
function stripSentinel(text, begin, end) {
  const bi = text.indexOf(begin);
  if (bi === -1) return { text, had: false };
  const ei = text.indexOf(end, bi);
  let next;
  if (ei === -1) { const eol = text.indexOf("\n", bi); const after = eol === -1 ? "" : text.slice(eol + 1); next = (text.slice(0, bi) + after).replace(/\n{3,}/g, "\n\n"); }
  else next = (text.slice(0, bi) + text.slice(ei + end.length)).replace(/\n{3,}/g, "\n\n");
  return { text: next, had: true };
}

export function uninstallRcBlock({ dry = DRY } = {}) {
  // install 은 존재하는 rc 모두(.zshrc/.bashrc/.bash_profile/.profile)에 심을 수 있으므로 동일 후보를 훑는다.
  const candidates = [".zshrc", ".bashrc", ".bash_profile", ".profile"].map((f) => join(HOME, f));
  let total = 0;
  for (const rc of candidates) {
    if (!existsSync(rc)) continue;
    let cur;
    try { cur = readFileSync(rc, "utf8"); } catch { continue; }
    let next = cur; const hits = [];
    for (const [b, e, label] of [[RC_BEGIN, RC_END, "LIVELY_TOKEN"], [PATH_NODE_BEGIN, PATH_NODE_END, "PATH(node)"]]) {
      const r = stripSentinel(next, b, e); if (r.had) { next = r.text; hits.push(label); }
    }
    if (!hits.length) continue;
    const stripped = next.replace(/\s+$/, "");
    const emptyNow = stripped.trim() === ""; // lively 블록만 있던 rc → 파일 삭제(설치전상태=파일없음 복구)
    const short = rc.replace(HOME, "~");
    if (dry) { log(`  [dry-run] ${short} — ${hits.join("+")} 센티넬 블록 제거 예정${emptyNow ? "(내용 없음 → 파일 삭제 예정)" : "(나머지 보존)"}`); total++; continue; }
    // 백업 먼저(클로버 금지).
    try {
      mkdirSync(join(LIVELY, "backups"), { recursive: true });
      copyFileSync(rc, join(LIVELY, "backups", "zshrc.uninstall.bak"));
    } catch { try { copyFileSync(rc, rc + ".uninstall.bak"); } catch { /* 백업 실패 시에도 진행 — 블록만 제거 */ } }
    if (emptyNow) {
      rmSync(rc, { force: true });
      log(`  ✓ ${short} — ${hits.join("+")} 블록 제거 후 내용 없음 → 파일 삭제(lively 전용이었음, 백업됨)`);
    } else {
      writeFileSync(rc, stripped + "\n");
      log(`  ✓ ${short} — ${hits.join("+")} 센티넬 블록 제거(나머지 보존)`);
    }
    total++;
  }
  if (total === 0) log("  · ~/.zshrc(및 형제 rc) — lively 관리 블록 없음(이미 제거됨/미설치)");
  return total;
}

// ── 하네스별 제거 표 ─────────────────────────────────────────────────────────
// 감지·제거를 **하네스별 데이터 한 줄**로 모은다. 종전엔 감지 함수·want 목록·제거 if·"남은 하네스" 문구가
//  네 곳에서 각각 claude/codex 를 하드코딩했고, 세 번째 하네스는 그 네 곳을 동시에 고치는 일이 됐다
//  (한 곳만 빠뜨리면 "제거했다는데 남아 있다" 가 된다). 이제 여기 한 줄이 그 넷을 모두 답한다.
const HARNESS_UNINSTALL = {
  claude: {
    label: "Claude",
    // ~/.claude/settings.json 에 .lively/hooks/ 를 가리키는 훅이 있으면 배선된 것.
    detect: () => {
      const sp = join(HOME, ".claude", "settings.json");
      if (!existsSync(sp)) return false;
      try {
        const hooks = JSON.parse(readFileSync(sp, "utf8"))?.hooks || {};
        return Object.values(hooks).some(
          (entries) => Array.isArray(entries) && entries.some(
            (e) => Array.isArray(e?.hooks) && e.hooks.some((h) => String(h?.command || "").includes(".lively/hooks/")),
          ),
        );
      } catch { return false; } // 파싱 실패 → 미감지
    },
    run: uninstallClaude,
  },
  codex: {
    label: "Codex",
    // ~/.codex/config.toml 에 lively 센티넬 + 우리 MCP 테이블이 있으면 배선된 것.
    detect: () => {
      const cp = join(HOME, ".codex", "config.toml");
      if (!existsSync(cp)) return false;
      try {
        const t = readFileSync(cp, "utf8");
        return t.includes("lively-managed") && t.includes("[mcp_servers.lively]");
      } catch { return false; }
    },
    run: uninstallCodex,
  },
};
// 제거 어댑터를 가진 하네스 = 이 파일이 다룰 수 있는 전부(install 측 범위와 같아야 한다).
const UNINSTALLABLE = Object.keys(HARNESS_UNINSTALL);

function detectInstalledHarnesses() {
  const out = {};
  for (const [id, spec] of Object.entries(HARNESS_UNINSTALL)) out[id] = spec.detect();
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
  const want = harnessArg === "all" ? UNINSTALLABLE : [harnessArg];

  // 아무것도 설치 안 됨 + ~/.lively 도 없음 → 클린 no-op.
  const anythingInstalled = UNINSTALLABLE.some((id) => detected[id]) || existsSync(LIVELY) || hasRcBlock();
  if (!anythingInstalled) {
    log("\n✓ lively 가 이 머신에 설치되어 있지 않습니다 — 제거할 것이 없습니다(no-op).");
    return;
  }

  log(`\n[1] 하네스 감지: ${UNINSTALLABLE.map((id) => `${id}=${detected[id] ? "o" : "x"}`).join(" ")} (대상=${want.join(",")})`);
  for (const id of want) {
    const spec = HARNESS_UNINSTALL[id];
    // 모르는 하네스를 조용히 넘기지 않는다 — "제거했다"는 화면과 실제가 어긋나는 게 이 계열의 조용한 실패다.
    if (!spec) { log(`  · ${id} — 제거 어댑터 없음, 건너뜀`); continue; }
    if (detected[id]) spec.run({ dry: DRY });
    else log(`  · ${spec.label} — lively 미설치(감지 안 됨), 건너뜀`);
  }

  // 공유 자산(~/.lively + LIVELY_TOKEN export)은 claude·codex 가 함께 쓴다(codex 블록은 /.lively/hooks/* 를 참조,
  //  bearer 인증은 LIVELY_TOKEN export 에 의존). --harness 로 한쪽만 제거했는데 다른 하네스가 아직 설치돼 있으면
  //  공유 자산을 지우면 남은 하네스가 깨진다 → 그 경우엔 공유 자산을 보존한다(설치된 하네스가 하나도 안 남을 때만 제거).
  const remaining = UNINSTALLABLE.filter((id) => detected[id] && !want.includes(id));
  const othersStillInstalled = remaining.length > 0;

  if (othersStillInstalled) {
    log("\n[2] 셸 rc(LIVELY_TOKEN export) — 보존(다른 하네스가 아직 설치됨 — 공유 자산 유지)");
    log("\n[3] ~/.lively 공유 자산 — 보존(다른 하네스가 아직 lively 를 사용 중 — 그 하네스 보호)");
    log(`  · 남은 하네스(${remaining.join(",")})까지 제거하려면 --harness all 로 다시 실행하세요.`);
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
//  ⚠ realpath 비교 — /tmp·/var(/private/* 심링크)에서 실행 시 import.meta.url≠argv[1] 로 main 이 조용히 스킵되던 버그(install 측 동형).
const DIRECT_RUN = (() => {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || ""); }
  catch { return true; }
})();
if (DIRECT_RUN) {
  main();
}
