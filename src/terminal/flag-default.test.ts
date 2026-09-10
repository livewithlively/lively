// 새 세션 줄의 «기본값» 이 무엇인지 화면이 말하는가 (#3778, 원준 2026-09-09).
//
// 신고: «+ 새 세션 누르면 모델하고 추론이 「기본값」 이라고만 나온다. 헷갈리게 이렇게 적지 말고 기본값이 뭔지
//  파악해서 그걸로 세팅되어 있게 해. 이렇게 하면 기본값이 뭔지 사용자가 알 수가 없잖아.»
//
// 사실관계(실측): 빈 값 = 그 플래그를 **안 넘긴다** → 그 AI 계정에 저장된 설정으로 열린다. 그 설정은 격리 계정 홈에
//  있어 게이트웨이가 못 읽는다. 즉 종전 화면은 **알 수 없는 값**을 「기본값」 이라고 적고 있었다. claude CLI 자신도
//  추론강도 기본을 «auto — 모델에 맞춘 기본»(claude 2.1.266 도움말)이라 부를 뿐 숫자를 주지 않는다.
// ⇒ 서버 카탈로그가 축마다 기본값을 **선언**하고, 화면은 그 값을 골라 두고 그대로 넘긴다.
//
// 사양·엣지 표(spec-failfirst):
//  D1 카탈로그가 선언한 기본값을 돌려준다
//  D2 선언이 없으면 '' — 화면은 그때만 「AI 설정 그대로」로 남는다
//  D3 선언값이 choices 에 없으면(오타·낡음) '' — 고를 수 없는 값을 골라 두지 않는다
//  D4 하네스를 모르면(null) ''
//  D5 그 하네스에 없는 축이면 ''
//  C1 실제 카탈로그: claude·codex·antigravity 의 모델·추론강도에 기본값이 선언돼 있고, 전부 자기 choices 안에 있다
//  C2 화면에 「AI 기본값」 이라는 말이 남아 있지 않다 — 그 말이 이 신고의 대상이었다
//  C3 화면이 flagDefault 를 실제로 골라 둔다(want 계산에 들어간다)
//  C4 그 값을 **기억에 저장하지는 않는다** — 카탈로그가 기본을 올리면 손대지 않은 사람은 따라와야 한다
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { HARNESSES } from "./catalog.js";

const webPath = (rel: string): string => new URL(`../../web/${rel}`, import.meta.url).pathname.replace("/dist/", "/src/").replace("/src/web/", "/web/");
const readWeb = (rel: string): string => readFileSync(webPath(rel), "utf8");
const code = (s: string): string => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

type H = { flags: { name: string; choices?: string[]; default?: string }[] } | null;
type Mod = { flagDefault: (h: H, name: string) => string };
let cached: Promise<Mod> | null = null;
function load(): Promise<Mod> {
  if (!cached) {
    //  run-picker 는 core.js 를 import 하므로 통째로는 못 태운다 — 이 함수만 떼어 낸다(순수 함수라 그대로 성립).
    const src = readWeb("v2/run-picker.ts");
    const m = /export const flagDefault[\s\S]*?\n};/.exec(src);
    if (!m) throw new Error("flagDefault 를 못 찾았다 — 이름이 바뀌었으면 이 테스트부터 고친다");
    const js = ts.transpileModule(m[0], { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    cached = import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`) as Promise<Mod>;
  }
  return cached;
}
const h = (flags: { name: string; choices?: string[]; default?: string }[]): H => ({ flags });

test("D1 선언한 기본값을 돌려준다", async () => {
  const m = await load();
  assert.equal(m.flagDefault(h([{ name: "--model", choices: ["", "a", "b"], default: "b" }]), "--model"), "b");
});
test("D2 선언이 없으면 ''", async () => {
  const m = await load();
  assert.equal(m.flagDefault(h([{ name: "--model", choices: ["", "a"] }]), "--model"), "");
});
test("D3 선언값이 choices 밖이면 '' — 고를 수 없는 값을 골라 두지 않는다", async () => {
  const m = await load();
  assert.equal(m.flagDefault(h([{ name: "--model", choices: ["", "a"], default: "없는모델" }]), "--model"), "");
});
test("D4 하네스를 모르면 ''", async () => {
  const m = await load();
  assert.equal(m.flagDefault(null, "--model"), "");
});
test("D5 그 하네스에 없는 축이면 ''", async () => {
  const m = await load();
  assert.equal(m.flagDefault(h([{ name: "--model", choices: ["", "a"], default: "a" }]), "--effort"), "");
});
test("C1 실제 카탈로그 — 모델·추론강도에 기본값이 선언돼 있고 전부 choices 안이다", () => {
  for (const key of ["claude", "codex", "antigravity"]) {
    const hh = HARNESSES.find((x) => x.key === key);
    assert.ok(hh, key + " 하네스가 없다");
    for (const axis of ["--model", "--effort"]) {
      const f = (hh!.flags || []).find((x) => x.name === axis);
      if (!f) continue;   // 그 하네스에 없는 축은 건너뛴다
      //  claude·codex 는 모델·추론강도 둘 다, antigravity 는 추론강도만 선언한다(모델은 실측 목록이 길어 고정하지 않는다).
      if (!f.default) { assert.ok(key === "antigravity" && axis === "--model", `${key} ${axis} 에 기본값 선언이 없다`); continue; }
      assert.ok((f.choices || []).includes(f.default), `${key} ${axis} 기본값 ${f.default} 이 choices 밖이다`);
    }
  }
});
test("C2 화면에 「AI 기본값」 이라는 말이 남아 있지 않다", () => {
  assert.doesNotMatch(code(readWeb("v2/run-picker.ts")), /AI 기본값/);
});
test("C3 화면이 그 기본값을 골라 둔다", () => {
  assert.match(code(readWeb("v2/run-picker.ts")), /const want = box\.value \|\| String\(savedFlags\[name\] \|\| ''\) \|\| flagDefault\(cur\(\), name\)/);
});
test("C4 고른 적 없는 기본값을 기억에 저장하지 않는다 — 카탈로그가 바뀌면 따라와야 한다", () => {
  const c = code(readWeb("v2/run-picker.ts"));
  //  저장은 changed() 안에서만 일어나고, changed() 는 사람이 컨트롤을 만졌을 때(change 이벤트)만 불린다.
  const m = /const changed = \(\): void => \{[\s\S]*?\n  \};/.exec(c);
  assert.ok(m, "changed() 를 못 찾았다");
  assert.match(m![0], /saveRunPrefs\(/, "changed() 가 저장을 하지 않는다");
  //  저장 호출은 파일 전체에 **한 번**뿐이고 그 한 번이 changed() 안이다 — 그리는 길(paint/paintFlag)에는 없다.
  //   그리는 중에 저장하면 골라 둔 기본값이 기억에 굳어, 카탈로그가 기본을 올려도 그 사람만 옛 값에 남는다.
  assert.equal(c.split("saveRunPrefs(").length - 1, 1, "saveRunPrefs 호출이 한 곳이 아니다");
});
