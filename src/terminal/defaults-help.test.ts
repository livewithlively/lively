// 「새 세션 기본값」 창의 (?) 설명이 **실제 동작과 맞는가** (#3778, 원준 2026-09-10 «제대로 검증해서 다시 달아»).
//
// 1판은 클래식 폼의 문구를 그대로 옮겨 적었고, 기록 범위에서 그 문구가 코드와 달랐다:
//  「프로젝트 — 그 팀만 봅니다」라고 적혀 있었지만 그 값이 하는 일은 «누가 보나» 가 아니라 «어디에 기록할 수 있나» 다.
//
// 코드에서 확인한 사실(이 테스트가 잠그는 것):
//  M1 인코그니토 = 라이블리 도구를 **하나도** 등록하지 않는다(읽기·쓰기 둘 다 불가) — capabilities/index.ts 의 `if (incognito) return;`
//  M2 읽기전용 = 쓰기 도구만 등록에서 빠진다(읽기는 그대로) — isReadOnlyBlocked = capMutates && !READONLY_KEEP
//  A1 자동 승인 = 그 AI 의 승인 건너뛰기 플래그를 argv 에 넣는다 — sessions.ts `if (input.autoApprove && harness.autoApproveFlag)`
//  V1 기록 범위의 **유일한 강제 지점**은 작업 기록을 프로젝트에 붙일 때다 — sessionWriteCap 소비자가 activity.ts 하나뿐
//  V2 그 지점의 판정은 «open 이 아니면 전체 공개 프로젝트에 기록 금지» — 즉 audience 와 private 는 동작이 같다
//  V3 지식 저장은 이 축을 보지 않는다 — knowledge 쪽에 sessionWriteCap 소비가 없다
//
// 화면 문구가 그 사실과 어긋나지 않는지 잠근다(W*). 문구를 통째로 검사하지 않고, **틀리면 곧 거짓말이 되는 문장**만 본다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const srcPath = (rel: string): string => new URL(`../../src/${rel}`, import.meta.url).pathname.replace("/dist/../src/", "/src/").replace("/dist/", "/");
const readSrc = (rel: string): string => readFileSync(srcPath(rel), "utf8");
const webPath = (rel: string): string => new URL(`../../web/${rel}`, import.meta.url).pathname.replace("/dist/", "/src/").replace("/src/web/", "/web/");
const readWeb = (rel: string): string => readFileSync(webPath(rel), "utf8");
const code = (s: string): string => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("M1 인코그니토는 라이블리 도구를 하나도 등록하지 않는다", () => {
  assert.match(code(readSrc("capabilities/index.ts")), /if \(incognito\) return;/);
});
test("M2 읽기전용은 쓰기 도구만 뺀다 — 읽기는 남는다", () => {
  const c = code(readSrc("capabilities/index.ts"));
  assert.match(c, /if \(readOnly && isReadOnlyBlocked\(cap\)\) continue;/);
  assert.match(c, /return capMutates\(cap\) && !READONLY_KEEP\.has\(cap\.name\);/);
});
test("A1 자동 승인은 그 AI 의 승인 건너뛰기 플래그를 넣는다", () => {
  assert.match(code(readSrc("terminal/sessions.ts")), /if \(input\.autoApprove && harness\.autoApproveFlag\) cmd\.push\(harness\.autoApproveFlag\)/);
});
test("V1 기록 범위를 실제로 강제하는 곳은 작업 기록 한 곳뿐이다", () => {
  //  소비자가 늘면(지식·자료 등) 이 테스트가 빨갛게 되고, 그때 (?) 문구의 «작업 기록에만» 도 같이 고쳐야 한다.
  const dir = srcPath("capabilities");
  const users = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .filter((f) => code(readFileSync(`${dir}/${f}`, "utf8")).includes("sessionWriteCap"));
  assert.deepEqual(users, ["activity.ts"], "기록 범위를 보는 곳이 늘었다: " + users.join(","));
});
test("V2 판정은 «open 이 아니면 전체 공개 프로젝트 금지» — audience 와 private 가 같다", () => {
  const c = code(readSrc("capabilities/activity.ts"));
  assert.match(c, /cap !== "open"/, "판정이 open 여부가 아니다");
  assert.doesNotMatch(c, /cap === "private"|cap === "audience"/, "두 값을 갈라 보기 시작했다 — 문구도 같이 고쳐야 한다");
});
test("V3 지식 저장은 이 축을 보지 않는다", () => {
  assert.doesNotMatch(code(readSrc("capabilities/knowledge.ts")), /sessionWriteCap|writeCap/);
});
test("W1 (?) 문구가 기록 범위를 «누가 보나» 로 설명하지 않는다", () => {
  const help = /const HELP = \{[\s\S]*?\n\};/.exec(readWeb("v2/session-defaults.ts"));
  assert.ok(help, "HELP 를 못 찾았다");
  const vis = /vis: \[[\s\S]*?\n  \],/.exec(help![0]);
  assert.ok(vis, "vis 설명을 못 찾았다");
  //  1판의 틀린 문구가 되돌아오면 여기서 잡힌다.
  assert.doesNotMatch(vis![0], /그 팀만 봄니다|그 팀만 봅니다|나만 볼 수 있어요|누가 볼 수 있게/);
  assert.match(vis![0], /작업 기록/, "무엇에 적용되는지(작업 기록)를 말하지 않는다");
  assert.match(vis![0], /지식은 이 설정을 따르지 않습니다/, "지식이 제외된다는 사실을 말하지 않는다");
});
test("W2 선택지 이름이 «보는 사람» 이 아니라 «기록할 수 있는 곳» 을 말한다", () => {
  const opts = /export const WRITE_VIS_OPTS[\s\S]*?\n\];/.exec(readWeb("v2/run-prefs.ts"));
  assert.ok(opts, "WRITE_VIS_OPTS 를 못 찾았다");
  assert.doesNotMatch(opts![0], /그 팀만 봄|나만 봄|누구나 봄/, "보는 사람으로 설명하는 옛 문구가 남아 있다");
  assert.match(opts![0], /기록/, "기록이라는 말이 없다");
});
test("W3 비유를 쓰지 않는다 — 설명은 동작만 적는다", () => {
  const help = /const HELP = \{[\s\S]*?\n\};/.exec(readWeb("v2/session-defaults.ts"))![0];
  //  실제로 이 파일에 들어올 뻔한 비유 어휘만 좁혀서 본다(일반 금칙어 목록이 아니다).
  assert.doesNotMatch(help, /처럼|비유하자면|마치|같은 셈|이라고 보면 돼요/);
});
