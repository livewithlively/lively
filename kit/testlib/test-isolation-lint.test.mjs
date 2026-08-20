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
import { violatesR1, violatesR2, RULES } from "./test-isolation-rules.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 이 두 파일은 스캔 대상에서 뺀다 — 규칙 문자열(픽스처)이 본문에 있어 자기 자신을 위반으로 읽는다.
const SELF = new Set([
  join("testlib", "test-isolation-lint.test.mjs"),
  join("testlib", "test-isolation-rules.mjs"),
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

console.log(`test-isolation lint: ${pass} passed${fail ? `, ${fail} FAILED` : ""}  (kit 스캔 ${files.length}개)`);
if (fail) process.exit(1);
