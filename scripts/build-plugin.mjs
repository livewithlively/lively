#!/usr/bin/env node
// 플러그인 빌드(#1473) — 유지보수자 전용. 사용자가 돌리는 스크립트가 아니다.
//
// 왜 필요한가: 플러그인(plugins/lively/)이 담는 두 자산의 **진실원천이 딴 데** 있다.
//   ① 훅 스크립트  = kit/hooks/*.mjs        (키트 설치 경로와 같은 파일 — 두 벌이 되면 갈라진다)
//   ② 조직 스킬    = 게이트웨이 org_harness_assets (편집은 중앙에서 — 로컬 사본을 고치면 다음 sync 에 덮인다)
// 이 스크립트가 둘을 플러그인 디렉터리로 **복제**한다. 복제본은 커밋한다(마켓플레이스가 레포를 그대로 배포하므로).
//
// 사용:  node scripts/build-plugin.mjs            (훅만 — 게이트웨이 불요)
//        node scripts/build-plugin.mjs --skills   (스킬까지 — 게이트웨이 토큰 필요)
// 자격:  LIVELY_GATEWAY_URL / LIVELY_TOKEN 환경변수 또는 ~/.lively/{gateway-url,token}
//
// ⚠ 동봉 스킬 목록은 plugins/lively/bundled-skills.json 이 정한다. 그 파일을 고치지 않는 한
//   게이트웨이에 스킬이 늘어도 플러그인에는 안 들어간다(의도 — 노이즈 통제).

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(ROOT, "plugins", "lively");
// 정본 = kit/setup/user-install.mjs 의 HOOK_SCRIPTS. self-update.mjs 만 뺀다 —
//  그건 ~/.lively 키트 자산을 갱신하는 백그라운드 업데이터라, 마켓플레이스가 갱신하는 플러그인엔 할 일이 없다.
const HOOK_SCRIPTS = [
  "session-preload.mjs",      // 조직 맥락 주입
  "sync-harness-assets.mjs",  // 조직 스킬·서브에이전트 materialize ← 이게 빠지면 조직 자산이 안 온다
  "run-custom.mjs",           // 조직 커스텀 훅 러너(거버넌스·쓰기게이트) — 런타임 fetch, kill-switch
  "work-flag.mjs",            // 세션 실행 단계 보고
  "stop-writeback-gate.mjs",  // 기록 게이트
];

const readLocal = (rel) => {
  try { return readFileSync(join(homedir(), ".lively", rel), "utf8").trim() || null; }
  catch { return null; }
};

// ── ① 훅 스크립트 복제 ───────────────────────────────────────────────────────
function syncHooks() {
  const dest = join(PLUGIN, "hooks");
  mkdirSync(dest, { recursive: true });
  for (const f of HOOK_SCRIPTS) {
    copyFileSync(join(ROOT, "kit", "hooks", f), join(dest, f));
  }
  console.log(`✓ 훅 ${HOOK_SCRIPTS.length}개 복제 — kit/hooks → plugins/lively/hooks`);
  // 배선표(hooks.json)는 복제 대상이 아니다 — 경로 표현이 다르다($HOME/.lively vs ${CLAUDE_PLUGIN_ROOT}).
  //  정본은 kit/setup/user-install.mjs 의 userLevelHooksBlock()+runnerHooksBlock() 이고, 그건 코드라 기계 비교가 안 된다.
  //  대신 값싼 불변식만 지킨다 — 배선표가 참조하는 스크립트가 전부 실제로 복제됐는가(빠지면 매 세션 훅 에러).
  const tpl = readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8");
  const referenced = [...tpl.matchAll(/hooks\/([\w.-]+\.mjs)/g)].map((m) => m[1]);
  const missing = [...new Set(referenced)].filter((f) => !HOOK_SCRIPTS.includes(f));
  if (missing.length) {
    console.error(`✗ hooks.json 이 참조하는데 복제되지 않는 스크립트: ${missing.join(", ")}`);
    process.exit(1);
  }
  const unwired = HOOK_SCRIPTS.filter((f) => !referenced.includes(f));
  if (unwired.length) console.warn(`⚠ 복제했지만 배선표에 없는 스크립트: ${unwired.join(", ")}`);
}

// ── ② 조직 스킬 복제 ────────────────────────────────────────────────────────
async function syncSkills() {
  const gw = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "").replace(/\/$/, "");
  const token = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
  if (!gw || !token) {
    console.error("✗ 게이트웨이 주소/토큰이 없다 — LIVELY_GATEWAY_URL·LIVELY_TOKEN 또는 ~/.lively/{gateway-url,token}");
    process.exit(1);
  }
  const allow = JSON.parse(readFileSync(join(PLUGIN, "bundled-skills.json"), "utf8"));
  const wanted = new Set(allow.skills);

  const res = await fetch(`${gw}/api/ui/org/harness-assets`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) { console.error(`✗ 자산 조회 실패 ${res.status} — runtime scope 토큰이 필요하다`); process.exit(1); }
  const { assets } = await res.json();

  const dest = join(PLUGIN, "skills");
  // 이 스크립트가 만든 것만 지운다 — lively-setup 처럼 플러그인이 직접 소유한 스킬은 보존.
  const owned = new Set(allow.skills);
  if (existsSync(dest)) {
    for (const d of readdirSync(dest)) if (owned.has(d)) rmSync(join(dest, d), { recursive: true, force: true });
  }
  mkdirSync(dest, { recursive: true });

  const written = [], missing = [];
  for (const name of allow.skills) {
    const a = assets.find((x) => x.kind === "skill" && x?.frontmatter?.name === name);
    if (!a) { missing.push(name); continue; }
    if (a.enabled === false) { console.warn(`  · ${name} — 게이트웨이에서 비활성 상태(그래도 동봉)`); }
    const fm = ["---", `name: ${name}`, `description: ${String(a.description || "").replace(/\n/g, " ").trim()}`, "---", ""].join("\n");
    mkdirSync(join(dest, name), { recursive: true });
    writeFileSync(join(dest, name, "SKILL.md"), fm + "\n" + String(a.body || "").trimEnd() + "\n");
    written.push(name);
  }
  console.log(`✓ 스킬 ${written.length}개 복제 — 게이트웨이 → plugins/lively/skills`);
  if (missing.length) console.warn(`⚠ 게이트웨이에 없는 스킬 ${missing.length}개: ${missing.join(", ")}`);

  const extra = assets.filter((x) => x.kind === "skill" && x?.frontmatter?.name && !wanted.has(x.frontmatter.name));
  if (extra.length) {
    console.log(`  (동봉 제외 ${extra.length}개: ${extra.map((x) => x.frontmatter.name).join(", ")})`);
  }
}

syncHooks();
if (process.argv.includes("--skills")) await syncSkills();
