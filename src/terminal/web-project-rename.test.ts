// 프로젝트 이름 바꾸기가 화면 전체에 닿는가 (#2579) — 웹 모듈 계약 검증.
//
// 증상(장원준 2026-09-03):
//  ① "사이드바랑, 세션탭 상단에 바로바로 반영이 안되는 것 같은 문제가 있음" — 문패는 **영영** 안 바뀌고
//     (탭을 닫았다 열기 전까지), 프로젝트 탭에서 고치면 사이드바가 8초 폴링을 기다렸다.
//  ② "사이드바 줄 더블클릭해서 프로젝트 이름 수정 -> 작동 안함 그냥 폴더 열렸다가 닫힘."
//
// 사양·엣지 표(spec-failfirst):
//  D1 셸 목록이 아는 이름이 있으면 그것이 이긴다 — 판이 든 사본(detail)은 마운트 때 한 번 읽고 안 늙는다
//  D2 목록에 그 프로젝트가 **없으면** 쥐고 있던 이름을 지킨다 — 모르는 것을 자리표시자로 덮으면 퇴보다
//  D3 목록에 있으나 이름이 비었으면(공백뿐) 역시 쥐고 있던 것을 지킨다
//  D4 loose(프로젝트 없는 세션, id 0)·목록 없음은 판단하지 않는다
//  D5 id 는 문자열로 와도 같은 프로젝트다(API 가 문자열 id 를 주는 자리가 있다)
//  C1 판의 문패는 detail 만 보지 않는다 — panes.ts 가 doorProjectName 을 쓴다
//  C2 사이드바의 **살아 있는** 붓(renderTree)에 편집 가드가 있다 — 없으면 라우팅·폴링이 입력칸을 지운다
//  C3 편집 중 표시는 **굳지 않는다** — 스스로 못 푸는 불리언 플래그(let renaming = false)를 두지 않는다
//  C4 프로젝트 탭(앱 프레임)은 이름을 고친 뒤 셸에 알린다 — 안 알리면 8초를 기다린다
//  C5 셸은 그 알림을 받아 **문패까지** 맞춘다(목록만 고치면 문패가 옛 이름으로 남는다)
//
// 웹 모듈은 src 테스트가 import 할 수 없어(별도 tsconfig·번들) 소스를 그 자리에서 transpile 해 data: URL 로 import 한다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const webPath = (rel: string): string => new URL(`../../web/${rel}`, import.meta.url).pathname.replace("/dist/", "/src/").replace("/src/web/", "/web/");
const readWeb = (rel: string): string => readFileSync(webPath(rel), "utf8");

type DoorMod = { doorProjectName: (projects: any, id: number, cached: string) => string };
async function loadDoor(): Promise<DoorMod> {
  const js = ts.transpileModule(readWeb("lib/door-name.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return (await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)) as DoorMod;
}

/** 주석은 계약이 아니다 — 「왜 그렇게 안 하는지」를 적은 줄이 grep 에 걸려 헛통과하는 것을 막는다
 *  (지식 ai-login-inline-asbuilt-2055 §5 에서 하루에 세 번 헛걸린 자리). */
const code = (rel: string): string => readWeb(rel)
  .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("D1 셸 목록이 아는 이름이 이긴다 — 판이 든 사본은 안 늙는다", async () => {
  const { doorProjectName } = await loadDoor();
  const got = doorProjectName([{ id: 2533, name: "매니지드 환경 오류 해결" }], 2533, "노드 재연결 멈춤");
  assert.equal(got, "매니지드 환경 오류 해결", "🔴 문패가 마운트 때 읽은 옛 이름을 계속 든다 — 탭을 닫았다 열기 전까지 안 바뀐다");
});

test("D2 목록이 모르는 프로젝트면 쥐고 있던 이름을 지킨다", async () => {
  const { doorProjectName } = await loadDoor();
  assert.equal(doorProjectName([{ id: 7, name: "남의 것" }], 2533, "매니지드 환경 오류 해결"), "매니지드 환경 오류 해결",
    "🔴 모르는 것을 목록으로 덮으면 이름이 자리표시자로 퇴보한다");
});

test("D3 목록의 이름이 비어 있으면 덮지 않는다", async () => {
  const { doorProjectName } = await loadDoor();
  assert.equal(doorProjectName([{ id: 9, name: "   " }], 9, "쓰던 이름"), "쓰던 이름");
  assert.equal(doorProjectName([{ id: 9, name: null }], 9, "쓰던 이름"), "쓰던 이름");
});

test("D4 loose·목록 없음은 판단하지 않는다", async () => {
  const { doorProjectName } = await loadDoor();
  assert.equal(doorProjectName([{ id: 0, name: "엉뚱" }], 0, "프로젝트 없는 세션"), "프로젝트 없는 세션");
  assert.equal(doorProjectName(null, 3, "그대로"), "그대로");
  assert.equal(doorProjectName(undefined, 3, "그대로"), "그대로");
});

test("D5 문자열 id 도 같은 프로젝트다", async () => {
  const { doorProjectName } = await loadDoor();
  assert.equal(doorProjectName([{ id: "2533", name: "새 이름" }], 2533, "옛 이름"), "새 이름");
});

test("C1 문패는 detail 만 보지 않는다 — panes.ts 가 doorProjectName 을 쓴다", () => {
  const src = code("v2/panes.ts");
  assert.match(src, /doorProjectName\(/, "🔴 판이 자기 detail 사본만 보면 다른 화면에서 바꾼 이름이 영영 안 온다");
});

test("C2 사이드바의 살아 있는 붓에 편집 가드가 있다", () => {
  const src = code("v2/side.ts");
  //  ⚠ 가드는 **render() 자리**여야 한다 — 구역 붓(renderProjects)이 host.replaceChildren 로 판을 통째로
  //   다시 세우므로, 그 아래(renderTree)에 두면 입력칸이 이미 지워진 뒤라 늦는다. 그래서 '어딘가에 있다'가
  //   아니라 '입구에 있다'를 계약으로 잡는다.
  const i = src.indexOf("function render(");
  assert.ok(i >= 0, "render() 를 찾지 못했다 — 붓의 이름이 바뀌었으면 이 계약도 옮겨야 한다");
  const head = src.slice(i, i + 1200);
  assert.match(head, /renamingAlive\(\)/,
    "🔴 사이드바 입구에 가드가 없다 — 첫 클릭의 항해가 부른 재렌더가 방금 연 입력칸을 지운다(가드가 죽은 renderLegacy 에만 남아 있던 것이 이 버그였다)");
  assert.ok(head.indexOf("renamingAlive()") < head.indexOf("renderProjects()"),
    "🔴 가드가 구역 붓보다 뒤에 있으면 판이 이미 갈아엎힌 뒤다");
});

test("C3 편집 중 표시가 굳지 않는다 — 스스로 못 푸는 불리언을 두지 않는다", () => {
  const src = code("v2/side.ts");
  assert.doesNotMatch(src, /let\s+renaming\s*=\s*false/,
    "🔴 불리언은 입력칸이 뜯겨 나가면 true 로 굳고, 그 뒤 rename 이 세션까지 통째로 막힌다");
  assert.match(src, /renamingEl\s*&&\s*renamingEl\.isConnected/,
    "🔴 화면에 붙어 있는지로 물어야 스스로 낫는다");
});

test("C4 프로젝트 탭은 이름을 고친 뒤 셸에 알린다", () => {
  const src = code("projects/detail.ts");
  assert.match(src, /lively:project-renamed/,
    "🔴 앱 프레임이 조용히 고치면 셸은 8초 폴링까지 옛 이름을 든다");
});

test("C5 셸은 그 알림으로 문패까지 맞춘다", () => {
  const src = code("v2/main.ts");
  assert.match(src, /lively:project-renamed/, "🔴 셸이 그 알림을 안 듣는다");
  const fn = src.slice(src.indexOf("function applyProjectName("));
  assert.ok(fn.length > 0, "applyProjectName 을 찾지 못했다");
  assert.match(fn.slice(0, 500), /repaintDoor/,
    "🔴 목록·탭만 고치고 문패를 빠뜨리면 이름이 화면마다 다르게 보인다");
});
