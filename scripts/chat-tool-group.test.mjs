// 접힌 도구 줄의 한 줄 요약 — 회귀 가드 (web/chat-tool-group.ts, #1822).
//
// 왜 이 테스트가 있나: 이 문구는 **틀려도 화면이 멀쩡해 보인다.** "도구 8개 사용함"은 그 자체로 그럴듯해서,
//  이름이 통째로 빠져 있어도 아무도 버그로 신고하지 않는다. 실제로 그랬다 — lively MCP 호출 27건이 전부
//  렌더돼 있었는데 접힌 줄이 개수만 말해 사람이 "호출이 안 뜬다"고 읽었다(#1822 의 계기).
//  그래서 '무엇을 몇 개 썼는지'를 문구 계약으로 못박는다.
//
// 왜 문자열 완전일치인가: 이 함수는 **순수 포매터**라 반환 문자열 자체가 관찰 가능한 효과다(로그 문구 미러링이
//  아니다). 부분일치(includes)로 쓰면 정작 막으려는 회귀 — 개수만 말하던 종전 문구 — 를 못 잡는다.
//
// 러너는 web/ 을 수집하지 않으므로(src/**/*.test.ts 와 kit|scripts|deploy/**/*.test.mjs 만) 컴파일 산출물을
//  import 한다. 이 모듈은 DOM·전역 의존이 없어 그대로 부를 수 있다 — 그 성질도 여기서 강제된다(전역을 잡는
//  순간 이 import 가 터진다. chat-view.js 가 정확히 그래서 테스트가 못 붙었고, 이 모듈을 떼어낸 이유다).
//
// 엣지 표 12행은 <스크래치패드>/spec.md — 아래 각 test 가 그 행 번호를 단다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOD = path.join(ROOT, "public/app/chat-tool-group.js");
const { toolGroupSummary } = await import(pathToFileURL(MOD).href);

/** 카드 한 장. */
const it = (label, detail = "", extra = {}) => ({ label, detail, ...extra });
/** 같은 이름 n장(대상은 서로 다르게 — 대상이 문구에 새면 여기서 드러난다). */
const many = (label, n) => Array.from({ length: n }, (_, i) => it(label, `t${i}`));

// ── 배선 단언 — 관측 장치가 살아 있나(vacuous test 방지) ───────────────────────────────────
test("배선 · 모듈이 실제로 함수를 내보낸다", () => {
  assert.equal(typeof toolGroupSummary, "function");
});

// ── 1행 ────────────────────────────────────────────────────────────────────────────────
test("1 · 빈 묶음은 빈 문구 — 예외로 터지지 않는다", () => {
  assert.equal(toolGroupSummary([]), "");
});

// ── 2·3행 — 도는 중이면 끝난 것보다 '지금 도는 것' ──────────────────────────────────────────
test("2 · 1장이 도는 중이면 대상까지 말한다", () => {
  assert.equal(toolGroupSummary([it("라이블리", "whoami", { running: true })]), "라이블리 whoami 실행 중");
});

test("3 · 여러 장 중 도는 것이 있으면 그 이름과 몇 개째인지 — 대상은 붙이지 않는다", () => {
  const mid = [it("명령", "npm test"), it("라이블리", "whoami", { running: true }), it("읽기", "a.ts")];
  assert.equal(toolGroupSummary(mid), "라이블리 실행 중 · 3개째");
});

test("3b · 도는 것이 여럿이면 **마지막으로 돌기 시작한 것**을 말한다", () => {
  const two = [it("명령", "a", { running: true }), it("라이블리", "b", { running: true })];
  assert.equal(toolGroupSummary(two), "라이블리 실행 중 · 2개째");
});

// ── 4·5행 — 한 장 ───────────────────────────────────────────────────────────────────────
test("4 · 한 장이면 대상까지 붙인다", () => {
  assert.equal(toolGroupSummary([it("라이블리", "whoami")]), "라이블리 whoami 사용함");
});

test("5 · 한 장인데 대상이 없으면 이름만", () => {
  assert.equal(toolGroupSummary([it("명령", "")]), "명령 사용함");
});

// ── 6행 — ★ 이번 변경의 핵심: 개수만 말하던 종전 문구를 막는다 ─────────────────────────────────
test("6 · ★ 여럿이면 '무엇을 몇 개' 썼는지 — 개수 1이면 'N개'를 생략한다", () => {
  const items = [...many("라이블리", 5), ...many("명령", 2), it("읽기", "a.ts")];
  assert.equal(toolGroupSummary(items), "라이블리 5개 · 명령 2개 · 읽기 사용함");
});

// ── 7행 ────────────────────────────────────────────────────────────────────────────────
test("7 · 이름 순서 = 처음 나온 순서(시간 순서가 곧 읽는 순서)", () => {
  const items = [it("명령", "a"), it("라이블리", "b"), it("명령", "c")];
  assert.equal(toolGroupSummary(items), "명령 2개 · 라이블리 사용함");
});

// ── 8·9행 — 실패는 감추지 않는다 ─────────────────────────────────────────────────────────
test("8 · 한 장이 실패하면 꼬리에 센다", () => {
  assert.equal(toolGroupSummary([it("라이블리", "x", { err: true })]), "라이블리 x 사용함 · 실패 1");
});

test("9 · 여러 장이면 실패 건수만 꼬리에(어느 것이 실패했는지는 펼쳐서 본다)", () => {
  const mixed = [it("라이블리", "a", { err: true }), it("라이블리", "b"), it("명령", "c", { err: true })];
  assert.equal(toolGroupSummary(mixed), "라이블리 2개 · 명령 사용함 · 실패 2");
});

// ── 10행 — 이번에 도입한 '이름으로 묶기'가 만든 새 엣지: 이름이 빈 카드 ──────────────────────────
test("10 · 이름이 비면 '도구'로 떨어진다 — 라벨러가 모르는 도구여도 문구가 깨지지 않는다", () => {
  assert.equal(toolGroupSummary([it("", "")]), "도구 사용함");
  assert.equal(toolGroupSummary([it("", "a"), it("", "b")]), "도구 2개 사용함");
});

test("10b · 이름 없는 카드가 도는 중이어도 '도구'로 떨어진다", () => {
  const items = [it("", "a", { running: true }), it("명령", "b")];
  assert.equal(toolGroupSummary(items), "도구 실행 중 · 2개째");
});

// ── 11·12행 — 상한(3종) 경계 ────────────────────────────────────────────────────────────
test("11 · 경계 · 종류가 정확히 3이면 자르지 않는다", () => {
  const items = [it("라이블리", "a"), it("명령", "b"), it("읽기", "c")];
  assert.equal(toolGroupSummary(items), "라이블리 · 명령 · 읽기 사용함");
});

test("12 · 경계 · 종류가 정확히 4면 앞 3종만 두고 '외 1종'", () => {
  const items = [it("라이블리", "a"), it("명령", "b"), it("읽기", "c"), it("찾기", "d")];
  assert.equal(toolGroupSummary(items), "라이블리 · 명령 · 읽기 외 1종 사용함");
});

test("12b · 종류가 더 많아도 잘린 종 수를 정확히 센다 + 실패 꼬리와 함께 온다", () => {
  const items = [it("라이블리", "a"), it("명령", "b"), it("읽기", "c"), it("찾기", "d"), it("쓰기", "e", { err: true })];
  assert.equal(toolGroupSummary(items), "라이블리 · 명령 · 읽기 외 2종 사용함 · 실패 1");
});
