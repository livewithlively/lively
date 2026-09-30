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

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { LIB_FILES } from "../kit/setup/kit-manifest.mjs";
import { mergeBlocks, userLevelHooksBlock, runnerHooksBlock } from "../kit/setup/user-install.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN = join(ROOT, "plugins", "lively");
// 정본 = kit/setup/kit-manifest.mjs 의 HOOK_SCRIPTS 중 **Claude Code 가 실행하는 훅**. 나머지는 뺀다 —
//  self-update.mjs 는 ~/.lively 키트 자산을 갱신하는 백그라운드 업데이터라 마켓플레이스가 갱신하는 플러그인엔 할 일이 없고,
//  opencode-plugin.js·antigravity/grok 어댑터·usage-report(statusLine)는 다른 하네스·다른 배선의 것이다.
export const HOOK_SCRIPTS = [
  "session-preload.mjs",      // 조직 맥락 주입
  "sync-harness-assets.mjs",  // 조직 스킬·서브에이전트 materialize ← 이게 빠지면 조직 자산이 안 온다
  "run-custom.mjs",           // 조직 커스텀 훅 러너(거버넌스·쓰기게이트) — 런타임 fetch, kill-switch
  "work-flag.mjs",            // 세션 실행 단계 보고
  "stop-writeback-gate.mjs",  // 기록 게이트
];
// 훅이 import 하는 모듈(실행되는 훅이 아니다) — 훅과 같은 hooks/ 에 평평하게 놓는다. 빠지면 그걸 import 하는 훅이
//  ERR_MODULE_NOT_FOUND 로 매 세션 통째로 죽는다(#4501: harness-registry·host-effects-port 가 빠져 재빌드하면 전멸했다).
//  손 목록이 아니라 **훅의 정적 import 를 따라가** 모은다 — 목록을 두면 새 모듈(예: #4219 record-nudge.mjs)이 생길 때마다
//  또 빠진다. 동적 import(host-effects-port 의 ../setup·../lib 폴백)는 여기서 안 따라가고 LIB_FILES 가 싣는다.
//  남은 누락은 scripts/build-plugin.test.mjs(B6)가 플러그인 트리의 import 를 따라가 잡는다.
export function hookModules() {
  const seen = new Set(HOOK_SCRIPTS);
  const queue = [...HOOK_SCRIPTS];
  while (queue.length) {
    const src = readFileSync(join(ROOT, "kit", "hooks", queue.shift()), "utf8").replace(/^\s*\/\/.*$/gm, "");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']\.\/([\w.-]+\.m?js)["']|(?:^|\n)\s*import\s*["']\.\/([\w.-]+\.m?js)["']/g)) {
      const f = m[1] ?? m[2];
      if (!seen.has(f)) { seen.add(f); queue.push(f); }
    }
  }
  return [...seen].filter((f) => !HOOK_SCRIPTS.includes(f)).sort();
}

// 복제 계획 — [원본 절대경로, 플러그인 기준 상대경로]. 훅 디렉터리 밖 공유 모듈(LIB_FILES)은 설치 트리와 같은
//  lib/ 자리에 둔다 — host-effects-port.mjs 가 `../setup/` 다음 `../lib/host-effects.mjs` 를 찾는다.
export function pluginFilePlan() {
  return [
    ...[...HOOK_SCRIPTS, ...hookModules()].map((f) => [join(ROOT, "kit", "hooks", f), `hooks/${f}`]),
    ...LIB_FILES.map((f) => [join(ROOT, "kit", "setup", f.src), f.dest]),
  ];
}

// 배선표(hooks.json) — 설치기 정본(userLevelHooksBlock + runnerHooksBlock)에서 **생성**한다. 종전엔 손으로 따로
//  적어 정본이 바뀔 때마다 갈라졌다(#4217 의 Bash 편집 매처·Agent|Task·SubagentStop work-flag 가 빠져 있었다).
//  경로만 바꾼다: `"<node>" "$HOME/.lively/hooks/<훅>" [이벤트]` → `node "${CLAUDE_PLUGIN_ROOT}/hooks/<훅>" [이벤트]`.
export function pluginHooksJson() {
  const merged = mergeBlocks(userLevelHooksBlock(), runnerHooksBlock());
  const hooks = {};
  for (const [event, entries] of Object.entries(merged)) {
    hooks[event] = entries.map((entry) => ({
      ...entry,
      hooks: entry.hooks.map((h) => {
        const m = /hooks[\\/]([\w.-]+\.mjs)"(.*)$/.exec(h.command);
        if (!m) throw new Error(`훅 명령을 해석하지 못했다(정본 형식이 바뀌었나): ${h.command}`);
        return { ...h, command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${m[1]}"${m[2]}` };
      }),
    }));
  }
  return { hooks };
}

// 한 엔트리 한 줄 — 사람이 diff 로 배선 변화를 읽기 쉽게.
export function formatHooksJson(obj) {
  const events = Object.entries(obj.hooks).map(([ev, entries]) =>
    `    ${JSON.stringify(ev)}: [\n${entries.map((e) => `      ${JSON.stringify(e)}`).join(",\n")}\n    ]`);
  return `{\n  "hooks": {\n${events.join(",\n")}\n  }\n}\n`;
}

// ── 버전 — plugin.json 에 두지 않는다 ─────────────────────────────────────────
//  Claude Code 는 version 문자열로 갱신을 판정한다 — 고정해 두면 설치한 사람은 누가 그 문자열을 바꿀 때까지 캐시된 사본에
//  머문다(공식 문서: «a manifest that pins "version" … keeps every user on the cached copy until its author changes the string»).
//  0.1.0 이 2026-08-04 부터 한 번도 안 바뀌어 그 뒤 변경이 설치본에 하나도 가지 않았다(#4501). version 을 빼면 git 마켓플레이스의
//  상대경로 플러그인은 «설치 디렉터리의 커밋 SHA» 가 버전이 된다(문서 «Omit version: users track your commits instead») —
//  plugins/lively 를 건드린 커밋마다 새 버전이다. 비용은 `claude plugin validate --strict` 의 권고 경고 하나다.
//  ⚠ 버전·내용 해시를 레포 파일에 기록하는 방식은 쓰지 않는다 — 훅을 바꾸는 PR 둘이 동시에 뜨면 같은 줄을 고쳐 반드시
//   충돌한다(#4501 에서 한 번 그렇게 만들었다가 걷었다). 사본 자체는 kit 과 바이트가 같아 kit 변경이 깨끗이 합쳐지면 함께 합쳐진다.

const readLocal = (rel) => {
  try { return readFileSync(join(homedir(), ".lively", rel), "utf8").trim() || null; }
  catch { return null; }
};

// ── ① 훅 스크립트 복제 + 배선표 생성 ──────────────────────────────────────────
function syncHooks() {
  const plan = pluginFilePlan();
  for (const [src, rel] of plan) {
    mkdirSync(dirname(join(PLUGIN, rel)), { recursive: true });
    copyFileSync(src, join(PLUGIN, rel));
  }
  writeFileSync(join(PLUGIN, "hooks", "hooks.json"), formatHooksJson(pluginHooksJson()));
  console.log(`✓ ${plan.length}개 복제(훅 ${HOOK_SCRIPTS.length} · 모듈 ${hookModules().join("·")} · 공유 ${LIB_FILES.length}) + hooks.json 생성 — kit → plugins/lively`);
  // 배선표가 참조하는 스크립트가 전부 복제됐는가(빠지면 매 세션 훅 에러).
  const referenced = new Set(Object.values(pluginHooksJson().hooks).flat().flatMap((e) => e.hooks.map((h) => /hooks\/([\w.-]+\.mjs)/.exec(h.command)[1])));
  const missing = [...referenced].filter((f) => !HOOK_SCRIPTS.includes(f));
  if (missing.length) {
    console.error(`✗ 정본 배선표가 참조하는데 복제 목록(HOOK_SCRIPTS)에 없는 훅: ${missing.join(", ")}`);
    process.exit(1);
  }
  const unwired = HOOK_SCRIPTS.filter((f) => !referenced.has(f));
  if (unwired.length) console.warn(`⚠ 복제했지만 배선표에 없는 훅: ${unwired.join(", ")}`);
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

// 직접 실행일 때만 쓴다 — 테스트는 위 계획·생성 함수만 import 한다(심링크를 풀어 비교).
const DIRECT_RUN = (() => {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || ""); }
  catch { return false; }
})();
if (DIRECT_RUN) {
  syncHooks();
  if (process.argv.includes("--skills")) await syncSkills();
}
