// tsc 증분 산출 디렉터리 정합 판정 — 회귀 가드 (scripts/tsc-outdir.mjs, #1830).
//
// 왜 이 테스트가 있나: 이 판정이 틀리면 **조용히 파일을 지우거나(빌드가 깨진다) 유령을 남긴다(서빙된다).**
//  특히 꼬리를 자르는 순서가 어긋나면 `a.d.ts` 가 `a.d` 의 산출물로 읽혀 **소스가 멀쩡한 파일을 고아로 판정**한다 —
//  그런 실수는 화면에 아무 표시가 없고 다음 빌드가 파일을 지운 뒤에야 드러난다.
//  안전 불변식("모르는 모양은 절대 지우지 않는다")도 여기서 못박는다.
//
// 순수 함수라 파일시스템을 건드리지 않는다(실 환경 오염 여지 없음).
import { strict as assert } from "node:assert";
import test from "node:test";
import { isDeclaration, missingOutputs, planOrphans, sourcesForOutput, stripSourceExt } from "./tsc-outdir.mjs";

test("배선 · 모듈이 판정 함수를 내보낸다", () => {
  for (const f of [sourcesForOutput, planOrphans, missingOutputs, stripSourceExt]) assert.equal(typeof f, "function");
});

// ── 1·3·4행 — 산출물 → 소스 후보 ─────────────────────────────────────────────────────────
test("1 · .js 는 같은 이름의 소스 확장자들을 후보로 낸다", () => {
  assert.deepEqual(sourcesForOutput("a.js"), ["a.ts", "a.tsx", "a.mts", "a.cts"]);
});

test("3·4 · 맵 파일도 같은 base 를 가리킨다", () => {
  assert.equal(sourcesForOutput("a.js.map")[0], "a.ts");
  assert.equal(sourcesForOutput("a.d.ts.map")[0], "a.ts");
});

// ── 2행 — ★ 꼬리 자르는 순서(가장 위험한 경계) ────────────────────────────────────────────────
test("2 · ★ .d.ts 를 .ts 로 자르면 안 된다 — 'a.d' 가 아니라 'a' 의 산출물이다", () => {
  assert.equal(sourcesForOutput("a.d.ts")[0], "a.ts", "'.d.ts' 보다 '.ts' 를 먼저 자르면 a.d.ts 로 잘못 나온다");
  assert.equal(sourcesForOutput("a.d.ts.map")[0], "a.ts");
});

test("2b · 이름 안에 점이 있어도 마지막 꼬리만 자른다", () => {
  assert.equal(sourcesForOutput("v2.main.js")[0], "v2.main.ts");
});

// ── 5·6행 — 모르는 모양·길이 경계는 판정하지 않는다(안전 방향) ────────────────────────────────────
test("5 · tsc 산출물 모양이 아니면 null — 손대지 않는다", () => {
  assert.equal(sourcesForOutput("styles.css"), null);
  assert.equal(sourcesForOutput("notes.txt"), null);
  assert.equal(sourcesForOutput("LICENSE"), null);
});

test("6 · 경계 · 이름이 꼬리 그 자체면 null(빈 base 를 만들지 않는다)", () => {
  assert.equal(sourcesForOutput(".js"), null);
  assert.equal(sourcesForOutput(".d.ts"), null);
});

// ── 7~10행 — 고아 판정 ──────────────────────────────────────────────────────────────────
test("7 · 소스가 있는 산출물은 고아가 아니다", () => {
  assert.deepEqual(planOrphans(["a.js", "a.js.map"], ["a.ts"]), []);
});

test("8 · ★ 소스가 사라진 산출물은 고아다(브랜치를 옮겼을 때 남는 것)", () => {
  assert.deepEqual(planOrphans(["a.js", "gone.js"], ["a.ts"]), ["gone.js"]);
});

test("9 · ★ 안전 불변식 · 모르는 모양은 소스가 없어도 절대 고아로 치지 않는다", () => {
  assert.deepEqual(planOrphans(["keep.css", "keep.txt", "gone.js"], []), ["gone.js"]);
});

test("10 · 하위 디렉터리 경로도 그대로 대응된다", () => {
  assert.deepEqual(planOrphans(["v2/side.js", "v2/dead.js"], ["v2/side.ts"]), ["v2/dead.js"]);
});

test("10b · .tsx·.mts 소스의 산출물도 고아가 아니다", () => {
  assert.deepEqual(planOrphans(["a.js", "b.js"], ["a.tsx", "b.mts"]), []);
});

// ── 11~14행 — 증분 기록이 거짓인지(= 산출물이 모자라는지) ────────────────────────────────────
test("11 · 산출물이 다 있으면 빈 목록", () => {
  assert.deepEqual(missingOutputs(["a.ts", "v2/b.ts"], ["a.js", "v2/b.js"]), []);
});

test("12 · ★ 일부만 있으면 없는 것을 짚는다(반쪽 dist 로 하위 단계가 죽던 경우)", () => {
  assert.deepEqual(missingOutputs(["a.ts", "b.ts", "c.ts"], ["a.js"]), ["b.ts", "c.ts"]);
});

test("13 · 선언 파일은 산출물이 없으므로 완전성 판정에서 뺀다(호출자가 isDeclaration 으로 거른다)", () => {
  assert.equal(isDeclaration("types.d.ts"), true);
  assert.equal(isDeclaration("main.ts"), false);
  const srcs = ["a.ts", "types.d.ts"].filter((f) => !isDeclaration(f));
  assert.deepEqual(missingOutputs(srcs, ["a.js"]), []);
});

test("14 · 소스 확장자가 무엇이든 기대 산출물은 .js 다", () => {
  assert.deepEqual(missingOutputs(["a.tsx", "b.mts"], ["a.js", "b.js"]), []);
  assert.deepEqual(missingOutputs(["a.tsx"], []), ["a.tsx"]);
});

test("14b · 소스 확장자가 아닌 것은 판정 대상이 아니다(빈 base 로 오판하지 않는다)", () => {
  assert.equal(stripSourceExt("README.md"), null);
  assert.equal(stripSourceExt(".ts"), null);
  assert.deepEqual(missingOutputs(["README.md"], []), []);
});
