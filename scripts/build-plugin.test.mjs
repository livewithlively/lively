// 마켓플레이스 플러그인(plugins/lively)이 키트 정본과 같고, 스스로 로드된다 (#4501).
//
// 실측(2026-09-30): ① 플러그인 훅 5개가 kit/hooks 보다 옛판이었다(재빌드 누락) ② 배선표가 정본(userLevelHooksBlock)
//  과 달랐다 — PostToolUse 편집 매처에 Bash 없음, Agent|Task PostToolUse·SubagentStop work-flag 없음(#4217)
//  ③ 빌드 스크립트가 훅이 import 하는 모듈(harness-registry·host-effects-port·lib/host-effects)을 안 날라, 지금
//  kit 훅으로 재빌드하면 플러그인 훅 5개가 전부 ERR_MODULE_NOT_FOUND 로 죽었다(격리 HOME 스모크 실측)
//  ④ plugin.json 의 version 이 0.1.0 에서 한 번도 안 바뀌어, 공식 문서대로라면 설치자는 그 뒤 어떤 변경도 받지 못했다.
//
// 사양·엣지표: 스크래치패드 spec.md ②. 재빌드: node scripts/build-plugin.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN, HOOK_SCRIPTS, VERSION_LEDGER, pluginFilePlan, pluginHooksJson, formatHooksJson, pluginContentHash } from "./build-plugin.mjs";
import { mergeBlocks, userLevelHooksBlock, runnerHooksBlock } from "../kit/setup/user-install.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REBUILD = "재빌드: node scripts/build-plugin.mjs";
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

const plan = pluginFilePlan();

t("B0 복제 계획이 비지 않았다(배선 단언)", () => {
  assert.ok(plan.length >= HOOK_SCRIPTS.length && HOOK_SCRIPTS.length > 0, `계획 ${plan.length}건 · 훅 ${HOOK_SCRIPTS.length}건`);
});

t("B1 플러그인의 훅·모듈이 kit 원본과 바이트까지 같다(재빌드 누락 없음)", () => {
  const stale = [];
  for (const [src, rel] of plan) {
    const dest = path.join(PLUGIN, rel);
    if (!fs.existsSync(dest)) { stale.push(`${rel}(없음)`); continue; }
    if (!fs.readFileSync(src).equals(fs.readFileSync(dest))) stale.push(rel);
  }
  assert.deepEqual(stale, [], `플러그인 사본이 kit 정본과 다르다: ${stale.join(", ")} — ${REBUILD}`);
});

t("B2 hooks/ 에는 계획한 파일과 hooks.json 만 있다(옛 파일·테스트 파일이 남지 않는다)", () => {
  const want = new Set(plan.map(([, rel]) => rel).filter((r) => r.startsWith("hooks/")).map((r) => r.slice("hooks/".length)));
  want.add("hooks.json");
  const extra = fs.readdirSync(path.join(PLUGIN, "hooks")).filter((f) => !want.has(f));
  assert.deepEqual(extra, [], `계획에 없는 파일: ${extra.join(", ")}`);
});

t("B3 hooks.json 이 정본에서 생성한 것과 같다", () => {
  const onDisk = fs.readFileSync(path.join(PLUGIN, "hooks", "hooks.json"), "utf8");
  assert.equal(onDisk, formatHooksJson(pluginHooksJson()), `배선표가 정본(userLevelHooksBlock+runnerHooksBlock)과 다르다 — ${REBUILD}`);
});

// B4 — 생성기 자체의 정합: 정본의 (이벤트, matcher, 스크립트, 인자, timeout) 집합 = 플러그인 파일의 집합.
//  B3 은 «생성기 출력 = 파일» 만 본다. 생성기가 엔트리를 떨어뜨리면 둘 다 같이 틀려도 B3 는 통과하므로 따로 잰다.
const key = (ev, e, h) => {
  const m = /hooks[\\/]([\w.-]+\.mjs)"(.*)$/.exec(h.command);
  return JSON.stringify([ev, e.matcher ?? null, m?.[1], (m?.[2] ?? "").trim(), h.timeout ?? null]);
};
const keysOf = (hooks) => Object.entries(hooks).flatMap(([ev, es]) => es.flatMap((e) => e.hooks.map((h) => key(ev, e, h)))).sort();
t("B4 플러그인 배선표의 엔트리 집합 = 설치기 정본의 엔트리 집합", () => {
  const canon = keysOf(mergeBlocks(userLevelHooksBlock(), runnerHooksBlock()));
  const plugin = keysOf(JSON.parse(fs.readFileSync(path.join(PLUGIN, "hooks", "hooks.json"), "utf8")).hooks);
  assert.ok(canon.length > 0, "정본 엔트리가 0건(테스트가 대상을 잃음)");
  assert.deepEqual(plugin, canon);
});

t("B5 #4217 배선이 플러그인에도 있다 — Bash 편집 매처 · Agent|Task · SubagentStop work-flag", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, "hooks", "hooks.json"), "utf8")).hooks;
  const has = (ev, pred) => (hooks[ev] ?? []).some((e) => pred(e) && e.hooks.some((h) => /work-flag\.mjs"$/.test(h.command)));
  assert.ok(has("PostToolUse", (e) => (e.matcher ?? "").split("|").includes("Bash")), "PostToolUse 편집 매처에 Bash 가 없다");
  assert.ok(has("PostToolUse", (e) => e.matcher === "Agent|Task"), "PostToolUse Agent|Task work-flag 가 없다");
  assert.ok(has("SubagentStop", () => true), "SubagentStop work-flag 가 없다");
});

// B6 — 플러그인 트리 안에서 import 가 전부 풀린다. 정적 상대 import 는 전부, 동적 import(try/catch 폴백 묶음)는
//  파일마다 후보 중 하나 이상이 있어야 한다. 트리 밖(설치 홈·kit)을 가리키면 마켓플레이스 설치본에선 없다.
t("B6 플러그인 훅의 상대 import 가 플러그인 트리 안에서 전부 풀린다", () => {
  const problems = [];
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.m?js$/.test(e.name)) files.push(p);
    }
  })(PLUGIN);
  assert.ok(files.some((f) => f.endsWith(path.join("hooks", "work-flag.mjs"))), "플러그인 훅을 찾지 못했다(테스트가 대상을 잃음)");
  const inside = (p) => p === PLUGIN || p.startsWith(PLUGIN + path.sep);
  for (const f of files) {
    const s = fs.readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const rel = path.relative(PLUGIN, f);
    for (const m of s.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.resolve(path.dirname(f), m[1]);
      if (!inside(target) || !fs.existsSync(target)) problems.push(`${rel} → ${m[1]}(정적)`);
    }
    const dyn = [...s.matchAll(/import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)].map((m) => m[1]);
    if (dyn.length && !dyn.some((d) => { const p = path.resolve(path.dirname(f), d); return inside(p) && fs.existsSync(p); })) {
      problems.push(`${rel} → ${dyn.join(" | ")}(동적 후보 전부 없음)`);
    }
  }
  assert.deepEqual(problems, [], `플러그인 설치본에서 ERR_MODULE_NOT_FOUND 가 날 import — ${REBUILD}`);
});

// B7 — 내용이 바뀌면 버전도 바뀐다. Claude Code 는 version 문자열로 갱신을 판정하므로(문서: «a manifest that pins
//  "version" … keeps every user on the cached copy until its author changes the string»), 내용만 바뀌고 버전이 그대로면
//  설치본은 영영 옛것이다. 빌드 스크립트가 해시가 바뀔 때 패치를 올리고 (version, hash) 를 기록한다 — 그 짝을 본다.
t("B7 플러그인 내용 해시 = 기록된 해시, 그리고 그 기록의 버전 = plugin.json 버전(내용만 바뀌고 버전이 그대로인 상태 없음)", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
  assert.match(String(manifest.version), /^\d+\.\d+\.\d+$/, "plugin.json version 이 semver 가 아니다(validate --strict 가 실패한다)");
  const ledger = JSON.parse(fs.readFileSync(VERSION_LEDGER, "utf8"));
  assert.equal(pluginContentHash(), ledger.hash, `플러그인 내용이 기록된 해시와 다르다 — 버전을 올리지 않은 변경이다. ${REBUILD}`);
  assert.equal(manifest.version, ledger.version, `plugin.json version(${manifest.version})이 기록(${ledger.version})과 다르다 — ${REBUILD}`);
  const market = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const entry = market.plugins.find((p) => p.name === manifest.name);
  assert.ok(entry, "마켓플레이스에 이 플러그인 항목이 없다");
  assert.equal(entry.version, undefined, "marketplace.json 항목에 version 을 두지 않는다 — 둘 다 있으면 plugin.json 이 경고 없이 이긴다(문서)");
});

t("B8 생성은 결정적이다(두 번 만들어도 같다)", () => {
  assert.equal(formatHooksJson(pluginHooksJson()), formatHooksJson(pluginHooksJson()));
});

console.log(`\nbuild-plugin tests: ${pass} passed`);
