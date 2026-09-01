#!/usr/bin/env node
// 테스트 격리 정적 린트 — 테스트가 **실행한 사람의 실제 설정**에 닿을 수 있는 모양을 커밋 전에 막는다.
//
// 왜 정적 검사인가 — 같은 부류의 사고가 세 번 났고(#1593 · #1786 · 2026-08-20), 세 번 다 앞선 지식이
//  근본 해법을 **"관례를 두는 것"** 이라 적고 관례로 남겼다. 관례는 새 테스트를 쓰는 사람이 안 지킨다
//  (실측: `...process.env` 를 자식에 넘기는 kit 테스트 38개 중 sandboxEnv 사용은 8개였다).
//  런타임 가드(scripts/testguard-real-home.mjs)는 **사고가 난 뒤** 잡아 되돌리는 마지막 겹이고,
//  이 파일은 첫 겹이다 — 위험한 모양이면 그 테스트를 **돌리기도 전에** 빨간불을 낸다.
//
// 구성: ① 규칙 자체를 픽스처로 전수 검증(사양의 엣지 표) ② 실제 kit 트리 스캔(회귀 방지).
//  ①이 있어야 "규칙이 실제로 위반을 잡는다"가 레포 상태와 무관하게 계속 증명된다.
//
// 실행: node kit/testlib/test-isolation-lint.test.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { violatesR1, violatesR2, violatesR3, violatesR4, violatesR5, violatesR6, RULES } from "./test-isolation-rules.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 이 두 파일은 스캔 대상에서 뺀다 — 규칙 문자열(픽스처)이 본문에 있어 자기 자신을 위반으로 읽는다.
const SELF = new Set([
  join("testlib", "test-isolation-lint.test.mjs"),
  join("testlib", "test-isolation-rules.mjs"),
  // fake executor로 capability의 양쪽을 검증하므로 allow 리터럴이 의도적으로 존재한다(실 HKCU 호출 없음).
  join("setup", "host-effects.test.mjs"),
]);

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };
const bad = (name, why) => { fail++; console.error(`FAIL ${name} — ${why}`); };
const eq = (name, got, want) => (got === want ? ok(name) : bad(name, `got=${got} want=${want}`));

// ── ① 규칙 단위 — 사양 엣지 표 전수 ────────────────────────────────────────────
//  단언은 판정 결과(부작용 없는 순수 출력)로만 한다. 구현 문구를 재진술하지 않는다.
const R1_CASES = [
  ["#1 HOME-only(가드·헬퍼 없음)", 'env: { ...process.env, HOME: home }', true],
  ["#2 USERPROFILE 함께", 'env: { ...process.env, HOME: home, USERPROFILE: home }', false],
  ["#3 sandboxEnv 사용", 'env: { ...process.env, ...sandboxEnv({ home }) }', false],
  ["#4 POSIX 전용(win32 skip 가드)", 'if (process.platform === "win32") process.exit(0);\nenv: { HOME: home }', false],
  ["#5 LIVELY_HOME 만(오탐 금지)", 'env: { ...process.env, LIVELY_HOME: home }', false],
  ["#6 XDG_CONFIG_HOME 만(오탐 금지)", 'env: { ...process.env, XDG_CONFIG_HOME: x }', false],
  ["#7 빈 소스", "", false],
];
for (const [name, src, want] of R1_CASES) eq(`R1 ${name}`, violatesR1(src), want);

const R2_CASES = [
  ["#8 claude 호출 · CCD 없음", 'spawnSync("claude", ["mcp", "list"])', true],
  ["#9 claude 호출 · CCD 명시", 'spawnSync("claude", ["mcp"], { env: { CLAUDE_CONFIG_DIR: "" } })', false],
  ["#10 claude 호출 없음", 'spawnSync("git", ["status"])', false],
  ["#11 execFileSync 형태", 'execFileSync("claude", ["--version"])', true],
  ["#12 spawn 형태", 'spawn("claude", args)', true],
  ["#13 다른 명령(오탐 금지)", 'spawnSync("claude-ish", ["x"])', false],
];
for (const [name, src, want] of R2_CASES) eq(`R2 ${name}`, violatesR2(src), want);

const R3_CASES = [
  ["#14 allow 플래그", 'args: ["--allow-host-effects"]', true],
  ["#15 allow env", 'env: { LIVELY_HOST_EFFECTS: "allow" }', true],
  ["#16 deny env", 'env: { LIVELY_HOST_EFFECTS: "deny" }', false],
  ["#17 host-effects 언급만", 'import "./host-effects.mjs"', false],
];
for (const [name, src, want] of R3_CASES) eq(`R3 ${name}`, violatesR3(src), want);

const R5_CASES = [
  ["#18 직접 외부 CLI", 'import { spawnSync } from "node:child_process"; spawnSync("git", [])', true],
  ["#19 HostEffects 외부 CLI", 'import { hostEffects } from "./host-effects-port.mjs"; hostEffects.spawnSync("git", [])', false],
  ["#20 직접 네트워크", 'await fetch("https://example.test")', true],
  ["#21 HostEffects 네트워크", 'const fetch = (...a) => hostEffects.fetch(...a); await fetch(url)', false],
  ["#22 부트스트랩 인라인 경계", 'const HOST_EFFECTS_NATIVE = true; import("node:child_process")', false],
  ["#23 빈 소스", '', false],
];
for (const [name, src, want] of R5_CASES) eq(`R5 ${name}`, violatesR5(src), want);

// R6 — 신원 env 상속. #4·#5 가 오탐 경계(spread 가 없거나 정본 헬퍼를 쓴 경우)다.
const R6_CASES = [
  ["#1 spread 만(헬퍼 없음)", 'env: { ...process.env, LIVELY_HOME: h }', true],
  ["#2 offlineLivelyEnv 사용", 'env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: h }', false],
  ["#3 sandboxEnv 사용", 'env: { ...process.env, ...sandboxEnv({ home, tmp }) }', false],
  ["#4 spread 없음(오탐 금지)", 'env: { HOME: h, LIVELY_HOME: h }', false],
  ["#5 상수 객체 형태도 잡는다", 'const ENV = { ...process.env, LIVELY_HOME: h };', true],
  ["#6 주석 안의 spread 는 코드가 아니다", '// env: { ...process.env }\nconst ENV = { HOME: h };', false],
  ["#7 빈 소스", "", false],
];
for (const [name, src, want] of R6_CASES) eq(`R6 ${name}`, violatesR6(src), want);


// ── ② 실제 kit 트리 ────────────────────────────────────────────────────────────
const files = readdirSync(KIT, { recursive: true })
  .filter((p) => /\.test\.mjs$/.test(p) && !SELF.has(p))
  .sort()
  .map((p) => ({ rel: p, src: readFileSync(join(KIT, p), "utf8") }));

// 배선 단언 — 수집이 깨지면 아래 규칙들이 **통과하면서 아무것도 안 본다**(vacuous). 그걸 먼저 막는다.
files.length >= 20
  ? ok(`#14 배선 — kit 테스트 ${files.length}개를 실제로 읽었다`)
  : bad("#14 배선", `스캔 대상 ${files.length}건 — 수집이 깨졌다(경로·글롭 확인)`);

for (const rule of RULES) {
  const bads = files.filter(({ src }) => rule.violates(src));
  bads.length === 0
    ? ok(`#15 ${rule.id} ${rule.title}`)
    : bad(`#15 ${rule.id}`, `${bads.length}건 — ${rule.fix}\n` + bads.map(({ rel }) => `        kit${sep}${rel}`).join("\n"));
}

// E12/R4 — User PATH registry primitive는 단일 adapter 밖에 두지 않는다. 테스트 파일은 픽스처 문자열을
// 가질 수 있어 제외하고, 제품 kit/*.mjs만 스캔한다. adapter 자체가 수집됐는지도 별도로 단언해 vacuous green을 막는다.
const HOST_ADAPTER = join("setup", "host-effects.mjs");
const productMjs = readdirSync(KIT, { recursive: true })
  .filter((p) => p.endsWith(".mjs") && !p.endsWith(".test.mjs") && !p.endsWith(".itest.mjs"))
  .sort()
  .map((p) => ({ rel: p, src: readFileSync(join(KIT, p), "utf8") }));
productMjs.some(({ rel }) => rel === HOST_ADAPTER)
  ? ok("#18 R4 배선 — host-effects adapter를 제품 스캔에서 읽었다")
  : bad("#18 R4 배선", "setup/host-effects.mjs가 수집되지 않았다");
const registryBads = productMjs.filter(({ rel, src }) => rel !== HOST_ADAPTER && violatesR4(src));
registryBads.length === 0
  ? ok("#19 R4 Windows User PATH registry primitive가 adapter 한 곳에만 존재")
  : bad("#19 R4 직접 registry 접근", registryBads.map(({ rel }) => `kit${sep}${rel}`).join("\n"));

// W3/R5 — 실행 엔진이 되는 kit 제품 코드만 본다. hooks/examples는 서버가 내려주는 org-hook 소스 자산이며,
// 실제 실행 envelope인 run-custom.mjs가 HostEffects를 통과하므로 개별 자산의 fetch는 이 스캔에서 제외한다.
const effectProducts = readdirSync(KIT, { recursive: true })
  .filter((p) => /\.(?:mjs|js)$/.test(p)
    && !/\.(?:test|itest|ci)\.(?:mjs|js)$/.test(p)
    && !p.startsWith(`hooks${sep}examples${sep}`))
  .sort()
  .map((p) => ({ rel: p, src: readFileSync(join(KIT, p), "utf8") }));
effectProducts.length >= 25
  ? ok("#24 R5 배선 — kit 제품 효과 표면을 실제로 읽었다")
  : bad("#24 R5 배선", `제품 스캔 대상 ${effectProducts.length}건 — 수집이 깨졌다`);
const effectBads = effectProducts.filter(({ src }) => violatesR5(src));
effectBads.length === 0
  ? ok("#25 R5 외부 CLI·네트워크·스케줄러가 HostEffects 경계를 통과")
  : bad("#25 R5 직접 host effect", effectBads.map(({ rel }) => `kit${sep}${rel}`).join("\n"));

console.log(`test-isolation lint: ${pass} passed${fail ? `, ${fail} FAILED` : ""}  (kit 스캔 ${files.length}개)`);
if (fail) process.exit(1);
