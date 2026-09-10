// 프로젝트 고르기 칸의 찾기 규칙(web/lib/proj-match.ts) — #3778, 원준 2026-09-09.
//
// 신고: «최근 프로젝트 고르는데 스크롤이 안 되는 게 맞냐» + «프로젝트 번호로도 검색해서 찾을 수 있게».
//  ⓐ 목록에 다섯 줄만 실어 스크롤할 것이 없었다(높이 규칙은 있었다) → 화면이 넉넉히 싣는다.
//  ⓑ 번호 찾기가 `String(id) === q` 라 **완전일치만** 잡히고 «#3778» 은 아예 안 잡혔다 — 목록이 «#3778» 로
//    적어 놓고 그대로 치면 못 찾았다.
//
// 사양·엣지 표(spec-failfirst):
//  I1 `3778` → 그 번호가 먼저(완전일치)
//  I2 `#3778` — 화면에 적힌 그대로 쳐도 같다
//  I3 `377` 앞자리만 — 번호 부분일치로 잡힌다
//  I4 이름이 먼저, 번호 부분일치가 뒤 — 같은 글에 둘 다 걸리면 이름이 위
//  I5 번호 완전일치는 이름일치보다도 위(가장 좁은 답)
//  N1 이름 부분일치 · 대소문자 무시
//  N2 이름이 없는(null) 행도 죽지 않는다
//  E1 빈 칸은 «찾기»가 아니라 «최근» — 원래 순서 그대로
//  E2 limit 은 자른다 · limit 0/미지정은 전부
//  E3 아무것도 안 걸리면 빈 배열(«없어요» 줄은 화면이 그린다)
//  E4 공백만 친 것은 빈 칸과 같다
//  Q1 projQueryId — `3778`·`#3778` 은 숫자, `37a`·`#`·빈 문자열은 null
//  W1 두 화면이 같은 규칙을 쓴다 — views.ts(홈 컴포저)·main.ts(세션의 프로젝트 바꾸기) 둘 다 projMatches 를 부르고
//     옛 `String(...id) === q` 가 남아 있지 않다
//  W2 홈이 넘기는 후보가 40개로 잘려 있지 않다 — 잘려 있으면 번호 찾기가 그 안에서만 된다
//
// 웹 모듈은 src 테스트가 import 할 수 없어 소스를 transpile 해 data: URL 로 import 한다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const webPath = (rel: string): string => new URL(`../../web/${rel}`, import.meta.url).pathname.replace("/dist/", "/src/").replace("/src/web/", "/web/");
const readWeb = (rel: string): string => readFileSync(webPath(rel), "utf8");
const code = (s: string): string => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

type Row = { proj: { id: number; name?: string | null } };
type Mod = {
  projQueryId: (q: string) => number | null;
  projMatches: (rows: Row[], q: string, limit?: number) => Row[];
};
let cached: Promise<Mod> | null = null;
function load(): Promise<Mod> {
  if (!cached) {
    const js = ts.transpileModule(readWeb("lib/proj-match.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    cached = import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`) as Promise<Mod>;
  }
  return cached;
}
const r = (id: number, name?: string | null): Row => ({ proj: { id, name } });
//  377 을 이름에 든 행 · 3778 을 번호로 든 행 · 이름에 '3778' 이 든 행을 섞는다.
const ROWS: Row[] = [r(4100, "온보딩 완성"), r(3778, "자잘한 UI 수정"), r(377, "옛 프로젝트"), r(3779, "UI 후속"), r(2143, "3778 회귀 확인")];

test("I1 번호 완전일치가 먼저", async () => {
  const m = await load();
  assert.equal(m.projMatches(ROWS, "3778")[0].proj.id, 3778);
});
test("I2 #3778 — 화면에 적힌 그대로 쳐도 같다", async () => {
  const m = await load();
  assert.deepEqual(m.projMatches(ROWS, "#3778").map((x) => x.proj.id), m.projMatches(ROWS, "3778").map((x) => x.proj.id));
});
test("I3 앞자리만 쳐도 번호로 잡힌다", async () => {
  const m = await load();
  const ids = m.projMatches(ROWS, "377").map((x) => x.proj.id);
  assert.equal(ids[0], 377, "완전일치가 먼저");
  assert.ok(ids.includes(3778) && ids.includes(3779), "앞자리 일치도 잡힌다: " + ids.join(","));
});
test("I4 이름일치가 번호 부분일치보다 위", async () => {
  const m = await load();
  const ids = m.projMatches(ROWS, "3778").map((x) => x.proj.id);
  assert.deepEqual(ids, [3778, 2143], "완전일치 → 이름에 3778 이 든 행");
});
test("I5 번호 완전일치는 이름일치보다도 위", async () => {
  const m = await load();
  assert.equal(m.projMatches([r(2143, "3778 회귀 확인"), r(3778, "자잘한 UI 수정")], "3778")[0].proj.id, 3778);
});
test("N1 이름 부분일치 · 대소문자 무시", async () => {
  const m = await load();
  assert.deepEqual(m.projMatches([r(1, "Onboarding"), r(2, "기타")], "onboard").map((x) => x.proj.id), [1]);
});
test("N2 이름이 없는 행도 죽지 않는다", async () => {
  const m = await load();
  assert.deepEqual(m.projMatches([r(9, null), r(10, "있음")], "있").map((x) => x.proj.id), [10]);
  assert.deepEqual(m.projMatches([r(9, null)], "9").map((x) => x.proj.id), [9]);
});
test("E1 빈 칸은 원래 순서 그대로", async () => {
  const m = await load();
  assert.deepEqual(m.projMatches(ROWS, "").map((x) => x.proj.id), ROWS.map((x) => x.proj.id));
});
test("E2 limit 은 자르고, 0·미지정은 전부", async () => {
  const m = await load();
  assert.equal(m.projMatches(ROWS, "", 2).length, 2);
  assert.equal(m.projMatches(ROWS, "").length, ROWS.length);
  assert.equal(m.projMatches(ROWS, "", 0).length, ROWS.length);
});
test("E3 아무것도 안 걸리면 빈 배열", async () => {
  const m = await load();
  assert.deepEqual(m.projMatches(ROWS, "존재하지않는이름"), []);
});
test("E4 공백만 친 것은 빈 칸과 같다", async () => {
  const m = await load();
  assert.deepEqual(m.projMatches(ROWS, "   ").map((x) => x.proj.id), ROWS.map((x) => x.proj.id));
});
test("Q1 projQueryId", async () => {
  const m = await load();
  assert.equal(m.projQueryId("3778"), 3778);
  assert.equal(m.projQueryId("#3778"), 3778);
  assert.equal(m.projQueryId(" #3778 "), 3778);
  assert.equal(m.projQueryId("37a"), null);
  assert.equal(m.projQueryId("#"), null);
  assert.equal(m.projQueryId(""), null);
});
test("W1 두 화면이 같은 규칙을 쓴다 — 옛 완전일치가 남아 있지 않다", () => {
  for (const rel of ["v2/views.ts", "v2/main.ts"]) {
    const c = code(readWeb(rel));
    assert.match(c, /projMatches\(/, rel + ": projMatches 를 쓰지 않는다");
    assert.doesNotMatch(c, /String\(r\.proj\.id\) === q/, rel + ": 옛 번호 완전일치가 남아 있다");
  }
});
//  ⚠ 이 테스트는 «상한을 200 이상으로 두라» 였다. 그건 처방이 아니라 **증상 완화**였고 실제로 샜다 —
//   후보 순서(projectOrder)가 done 을 맨 뒤로 밀므로 **잘리는 것은 언제나 끝난 프로젝트부터**이고,
//   이름으로 찾는 상황이 바로 그때다. 실측(원준님 2026-09-09): 프로젝트 286 = 진행중 175 + done 111 →
//   상한 40 이면 done 이 전부 잘려 「자잘한 UI 수정」이 done 이 되는 순간 이 칸에서 사라졌고, 200 이어도 86개가 잘린다.
//  ⇒ 사양을 바꾼다: **표시 상한과 검색 대상을 한 숫자에 묶지 않는다.** 자르기는 화면이 한다(projMatches 의 limit).
test("W2 후보를 만드는 쪽이 목록을 미리 자르지 않는다 — 자르면 그 밖은 이름을 정확히 쳐도 없는 것이 된다", () => {
  const c = code(readWeb("v2/main.ts"));
  assert.doesNotMatch(c, /projectOrder\(data\)\s*\.slice\(/,
    "homeDests 가 후보를 미리 자른다 — 상한 밖(정렬상 done 부터)은 검색으로도 못 찾는다");
});

//  E2·E3 — 찾을 것이 **맨 끝**에 있어도 찾힌다. projMatches 안에 상한이 생기면(또는 조기 return 이 생기면) 빨간불.
test("W3 목록 꼬리의 항목도 이름·번호로 찾힌다", async () => {
  const m = await load();
  const noise = Array.from({ length: 250 }, (_, i) => ({ proj: { id: 9000 + i, name: "노이즈 " + i } }));
  const rows = [...noise, { proj: { id: 3778, name: "자잘한 UI 수정" } }];
  assert.deepEqual(m.projMatches(rows, "자잘한").map((x: { proj: { id: number } }) => x.proj.id), [3778]);
  assert.deepEqual(m.projMatches(rows, "3778").map((x: { proj: { id: number } }) => x.proj.id), [3778]);
});
