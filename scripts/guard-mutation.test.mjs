// `guard-mutation.mjs` 가 **정말 무는가**를 픽스처로 실행해 확인하고, 마지막에 **이 레포에** 건다.
//
//  ── 왜 이 파일이 있나 ────────────────────────────────────────────────────────
//  이 게이트의 존재 이유가 「없어서 통과하는 시험을 없애는 것」인데, 그 자신이 그런 시험이면
//  아무것도 나아지지 않는다. 그래서 **가짜 레포(src+dist+테스트)를 만들어 게이트를 실제로 돌리고**,
//  「가드를 죽였는데 초록인 경우」를 진짜로 재현해 게이트가 그걸 잡는지 본다(C 그룹).
//
//  사양·엣지 표: 10행. 행마다 시나리오 하나. (spec-failfirst-test 절차)
//
//  ★ D 그룹이 이 파일의 핵심 계약이다 — **공용 dist 무접촉**(러너가 -j 8 병렬이라 여길 건드리면
//   남의 테스트가 깨진다) 과 **작업 사본을 남기지 않는다**(예외가 나도).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarker, parseCond, collectGuards, findSpecFile, runGuardGate, nodeRunner } from "./guard-mutation.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, want, got) => { fail++; console.log(`  ✗ ${n}\n     기대: ${want}\n     실제: ${got}`); };
const eq = (n, a, b) => (a === b ? ok(n) : bad(n, b, a));
const has = (n, arr, frag) => (arr.some((x) => x.includes(frag)) ? ok(n) : bad(n, `'${frag}' 을 담는다`, JSON.stringify(arr)));

console.log("A. 표식·조건 파싱 (순수)");
eq("A1 표식을 읽는다", parseMarker("  // GUARD: foo.test — 설명")?.spec, "foo.test");
eq("A2 설명이 없어도 된다", parseMarker("// GUARD: foo.test")?.spec, "foo.test");
eq("A3 하이픈 구분자도 받는다", parseMarker("// GUARD: foo.test - 설명")?.spec, "foo.test");
eq("A4 GUARD 가 아니면 null", parseMarker("// 그냥 주석"), null);
//  ★ 새로 도입한 필드가 «비었을 때» — spec 없는 표식은 무엇을 돌릴지 모르므로 표식으로 보지 않는다.
eq("A5 spec 이 비면 표식이 아니다", parseMarker("// GUARD:  — 설명만 있다"), null);
eq("A6 조건을 뽑는다", parseCond("  if (!allowed) return false;"), "!allowed");
eq("A7 블록형도", parseCond("if (a && b) {"), "a && b");
eq("A8 if 가 아니면 null", parseCond("  const x = 1;"), null);

// ── 픽스처 ───────────────────────────────────────────────────────────────────
//  가짜 레포: src/g.ts(표식+가드) · dist/g.js(컴파일 결과) · dist/g.test.js(그 가드를 검사하는 시험)
function fixture({ marker = "// GUARD: g.test — 사람의 것은 건드리지 않는다", guardLine = "if (!allowed) return false;", test = "strict" } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gm-"));
  fs.mkdirSync(path.join(d, "src")); fs.mkdirSync(path.join(d, "dist"));
  fs.writeFileSync(path.join(d, "src/g.ts"), `export function f(allowed) {\n  ${marker}\n  ${guardLine}\n  return true;\n}\n`);
  fs.writeFileSync(path.join(d, "dist/g.js"), `export function f(allowed) {\n  ${guardLine}\n  return true;\n}\n`);
  //  strict = 가드가 살아 있어야만 통과하는 시험(정상) · loose = 가드와 무관하게 늘 통과(가짜 시험)
  const body = test === "strict"
    ? `import { f } from "./g.js";\nif (f(false) !== false) { console.error("guard dead"); process.exit(1); }\n`
    : `import { f } from "./g.js";\nif (typeof f !== "function") process.exit(1);\n`;
  fs.writeFileSync(path.join(d, "dist/g.test.js"), body);
  return d;
}
const gate = (d, runner = nodeRunner) => runGuardGate({
  srcDir: path.join(d, "src"), distDir: path.join(d, "dist"),
  workDir: path.join(d, ".work"), cwd: d, runner,
});

console.log("\nB. 수집");
{
  const d = fixture();
  const g = collectGuards(path.join(d, "src"));
  eq("B1 표식 1개를 찾는다(경계 최소)", g.length, 1);
  eq("B2 조건까지 붙는다", g[0].cond, "!allowed");
  eq("B3 spec 을 읽는다", g[0].spec, "g.test");
  eq("B4 테스트 파일을 특정한다", path.basename(findSpecFile(path.join(d, "dist"), "g.test")), "g.test.js");
  fs.rmSync(d, { recursive: true, force: true });
}

console.log("\nC. ★ 게이트가 실제로 무는가 (진짜 node 실행)");
{
  //  ③ 가드를 죽이면 시험이 빨개진다 → 통과
  const d1 = fixture({ test: "strict" });
  const r1 = gate(d1);
  eq("C1 제대로 무는 시험 → findings 0", r1.findings.length, 0);
  eq("C1b 가드를 1건 검사했다", r1.guards, 1);
  fs.rmSync(d1, { recursive: true, force: true });

  //  ④ ★ 가드를 죽여도 시험이 초록 → 게이트가 잡아야 한다 (이 파일의 존재 이유)
  const d2 = fixture({ test: "loose" });
  const r2 = gate(d2);
  has("C2 가짜 시험을 잡는다", r2.findings, "초록이다");
  fs.rmSync(d2, { recursive: true, force: true });
}

console.log("\nD. ★★ 안전 계약 — 공용 dist 무접촉 · 사본 미잔류");
{
  const d = fixture({ test: "strict" });
  const distFile = path.join(d, "dist/g.js");
  const before = fs.readFileSync(distFile, "utf8");
  gate(d);
  eq("D1 공용 dist 를 안 건드린다(원본 그대로)", fs.readFileSync(distFile, "utf8"), before);
  eq("D2 작업 사본을 남기지 않는다", fs.existsSync(path.join(d, ".work")), false);

  //  러너가 던져도(=중간에 죽어도) 사본이 남지 않고 dist 도 그대로여야 한다.
  let threw = false;
  try { gate(d, () => { throw new Error("boom"); }); } catch { threw = true; }
  eq("D3 러너가 던지면 전파한다(삼키지 않는다)", threw, true);
  eq("D4 예외가 나도 사본이 없다", fs.existsSync(path.join(d, ".work")), false);
  eq("D5 예외가 나도 공용 dist 그대로", fs.readFileSync(distFile, "utf8"), before);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log("\nE. 사유를 말한다 (모름을 통과로 접지 않는다)");
{
  //  ① 표식 0개 → vacuous 로 실패
  const d0 = fixture({ marker: "// 표식 없음" });
  has("E1 표식이 0개면 실패한다", gate(d0).findings, "vacuous");
  fs.rmSync(d0, { recursive: true, force: true });

  //  ⑤ 표식 아래가 if 가 아니다
  const d5 = fixture({ guardLine: "const x = 1;" });
  has("E2 아래 줄이 if 가 아니면 사유", gate(d5).findings, "모호");
  fs.rmSync(d5, { recursive: true, force: true });

  //  ⑥ dist 에 그 조건식이 없다(컴파일로 바뀐 경우)
  const d6 = fixture();
  fs.writeFileSync(path.join(d6, "dist/g.js"), "export function f(a) { if (!a2) return false; return true; }\n");
  has("E3 dist 에 조건식이 없으면 사유", gate(d6).findings, "못 찾았다");
  fs.rmSync(d6, { recursive: true, force: true });

  //  ⑦ 테스트 파일을 특정 못 함
  const d7 = fixture({ marker: "// GUARD: nosuch.test — 없는 시험" });
  has("E4 테스트를 못 찾으면 사유", gate(d7).findings, "특정하지 못했다");
  fs.rmSync(d7, { recursive: true, force: true });
}

// ── 본검사: 이 레포 ───────────────────────────────────────────────────────────
console.log("\nF. ★ 이 레포의 GUARD 표식에 실제로 건다");
if (!fs.existsSync(path.join(ROOT, "dist"))) {
  bad("F1 dist 가 없다", "npm test 는 --build 로 돈다", "dist 부재 — 먼저 빌드하라");
} else {
  const r = runGuardGate({
    srcDir: path.join(ROOT, "src"), distDir: path.join(ROOT, "dist"),
    workDir: path.join(ROOT, ".guard-mutation"), cwd: ROOT, runner: nodeRunner,
  });
  console.log(`   표식 ${r.guards}건`);
  if (r.findings.length === 0) ok(`레포의 가드 ${r.guards}건이 전부 «죽이면 빨개진다»`);
  else for (const f of r.findings) bad("F", "가드가 시험에 물린다", f);
}

console.log(`\nguard-mutation: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
