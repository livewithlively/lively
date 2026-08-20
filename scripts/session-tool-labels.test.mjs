// 세션 대화창의 도구 이름표 — MCP 서버 표기 회귀 가드 (web/session-tool-labels.ts, #1823).
//
// 왜 이 테스트가 있나: 이름표가 **일부만 번역되면** 같은 계열 호출이 서로 다른 것처럼 보인다. 실측에서
//  '라이블리' 옆에 'lively-local' 이 영문으로 앉아, 사람이 그 둘을 같은 라이블리 호출로 읽지 못하고
//  "라이블리를 안 불렀다"고 판단했다. 화면은 멀쩡해 보이므로(둘 다 '그럴듯한 이름'이다) 눈으로는 안 잡힌다.
//  그래서 '무엇을 번역하고 무엇을 그대로 두나'를 계약으로 못박는다.
//
// 엣지 표 10행은 <스크래치패드>/spec-1823.md — 아래 각 test 가 그 행 번호를 단다.
// 이 모듈은 DOM·전역 의존이 없어 산출물을 그대로 부를 수 있다(러너는 web/ 을 수집하지 않는다).
import { strict as assert } from "node:assert";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOD = path.join(ROOT, "public/app/session-tool-labels.js");
const { toolLabel } = await import(pathToFileURL(MOD).href);

const lab = (name, input = {}) => toolLabel(name, input);

test("배선 · 모듈이 실제로 함수를 내보낸다", () => {
  assert.equal(typeof toolLabel, "function");
});

// ── 1·2행 — 같은 계열은 함께 번역한다(이번 변경의 핵심) ──────────────────────────────────────
test("1 · 라이블리 게이트웨이", () => {
  assert.deepEqual(lab("mcp__lively__whoami"), { label: "라이블리", detail: "whoami" });
});

test("2 · ★ 라이블리 로컬도 함께 번역된다 — 한쪽만 번역하면 같은 계열이 달라 보인다", () => {
  assert.deepEqual(lab("mcp__lively-local__lively_local_repo_list"),
    { label: "라이블리 로컬", detail: "lively_local_repo_list" });
});

// ── 3·5행 — 플러그인 이름의 기계적 중복만 걷어낸다 ────────────────────────────────────────────
test("3 · ★ 플러그인과 서버 이름이 같으면 한 번만 말한다", () => {
  assert.deepEqual(lab("mcp__plugin_playwright_playwright__browser_navigate"),
    { label: "playwright", detail: "browser_navigate" });
});

test("5 · 경계 · 플러그인과 서버 이름이 다르면 손대지 않는다(무엇이 무엇인지 모른다)", () => {
  assert.deepEqual(lab("mcp__plugin_foo_bar__x"), { label: "plugin_foo_bar", detail: "x" });
});

test("5b · 경계 · 'plugin_' 로 시작하지만 조각이 하나뿐이면 그대로", () => {
  assert.equal(lab("mcp__plugin_solo__x").label, "plugin_solo");
});

// ── 4행 — 모르는 서버는 영문 그대로 ──────────────────────────────────────────────────────
test("4 · 모르는 서버는 영문 그대로 — 틀린 한국어보다 낯선 영어가 낫다", () => {
  assert.deepEqual(lab("mcp__notion__notion-search"), { label: "notion", detail: "notion-search" });
});

// ── 6행 — 서버 자리가 빈 부재 엣지 ───────────────────────────────────────────────────────
test("6 · 부재 · 서버 자리가 비면 'MCP'", () => {
  assert.equal(lab("mcp__").label, "MCP");
});

// ── 7행 — 이름표를 도입해 새로 생긴 함정: 이름이 곧 키가 된다 ──────────────────────────────────
test("7 · 서버 이름이 'constructor' 여도 프로토타입 값을 집지 않는다(표는 Map)", () => {
  const r = lab("mcp__constructor__x");
  assert.equal(typeof r.label, "string");
  assert.deepEqual(r, { label: "constructor", detail: "x" });
});

test("7b · '__proto__' 도 마찬가지", () => {
  assert.equal(lab("mcp__hasOwnProperty__x").label, "hasOwnProperty");
});

// ── 8행 — 프록시 경유 도구도 서버는 라이블리다 ────────────────────────────────────────────────
test("8 · 외부 서비스 프록시는 라이블리 밑에 붙는다 — 대상에 경로가 남는다", () => {
  assert.deepEqual(lab("mcp__lively__ext__slack__slack_read_channel"),
    { label: "라이블리", detail: "ext__slack__slack_read_channel" });
});

// ── 9행 — 대상 길이 경계 ────────────────────────────────────────────────────────────────
test("9 · 경계 · 대상이 60자를 넘으면 자르고 …", () => {
  const long = "a".repeat(80);
  const r = lab(`mcp__lively__${long}`);
  assert.equal(r.label, "라이블리");
  assert.equal(r.detail.length, 60);
  assert.ok(r.detail.endsWith("…"), `잘림 표시가 없다: ${r.detail.slice(-5)}`);
});

test("9b · 경계 · 60자 이하면 그대로 둔다", () => {
  const exact = "b".repeat(60);
  assert.equal(lab(`mcp__lively__${exact}`).detail, exact);
});

// ── 10행 — 배선 · 이 변경이 MCP 분기 밖으로 새지 않았나 ──────────────────────────────────────
test("10 · 비-MCP 도구 표기는 그대로다", () => {
  assert.deepEqual(lab("Read", { file_path: "/a/b/c/d.ts" }), { label: "읽기", detail: "…/b/c/d.ts" });
  assert.deepEqual(lab("Bash", { description: "npm test" }), { label: "명령", detail: "npm test" });
  assert.equal(lab("SomeUnknownTool", {}).label, "SomeUnknownTool");
});
