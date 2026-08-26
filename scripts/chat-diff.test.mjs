// 도구 원문의 변경분(diff) 판정·세기 — 회귀 가드 (web/chat-diff.ts, #2055).
//
// 왜 이 테스트가 있나: 이 판정은 **틀려도 화면이 멀쩡해 보인다.** 마크다운 목록('- 항목')이 통째로 빨갛게 칠해져도
//  그럴듯한 화면이라 아무도 신고하지 않고, 반대로 진짜 diff 를 못 알아봐도 그냥 회색 pre 라 '원래 그런 것'으로 읽힌다.
//  +N -N 세기는 더하다 — 파일 이름줄(`--- a/x`·`+++ b/x`)을 세면 모든 diff 가 조용히 +1 -1 씩 부풀지만
//  그 숫자를 검산하는 사람은 없다. 그래서 계약을 표로 못박는다.
//
// 러너는 web/ 을 수집하지 않으므로 컴파일 산출물(public/app)을 import 한다 — 이 모듈이 전역을 안 잡는다는
//  성질도 여기서 강제된다(잡는 순간 이 import 가 터진다).
import { strict as assert } from "node:assert";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { isDiffText, scanDiff } = await import(pathToFileURL(path.join(ROOT, "public/app/chat-diff.js")).href);

const D = (...lines) => lines.join("\n");

test("배선 · 모듈이 실제로 함수를 내보낸다", () => {
  assert.equal(typeof isDiffText, "function");
  assert.equal(typeof scanDiff, "function");
});

// ── 1~4행: 무엇을 diff 로 볼 것인가 ────────────────────────────────────────────────────
test("1 · 빈 문자열·null 은 diff 가 아니다(예외로 터지지 않는다)", () => {
  assert.equal(isDiffText(""), false);
  assert.equal(isDiffText(null), false);
  assert.equal(scanDiff(null).isDiff, false);
});

test("2 · @@ 머리 + 바뀐 줄이 있으면 diff 다", () => {
  assert.equal(isDiffText(D("@@ -1,3 +1,4 @@", " keep", "-old", "+new")), true);
});

test("★ 3 · 마크다운 목록은 diff 가 아니다 — 머리(@@·diff --git)가 없으면 칠하지 않는다", () => {
  assert.equal(isDiffText(D("할 일", "- 하나", "- 둘", "+ 덤")), false);
});

test("★ 4 · 머리만 있고 바뀐 줄이 하나도 없으면 diff 로 보지 않는다(빈 패치 헤더)", () => {
  assert.equal(isDiffText(D("diff --git a/x b/x", "index abc1234..def5678 100644", "--- a/x", "+++ b/x")), false);
});

// ── 5~8행: 세기 ──────────────────────────────────────────────────────────────────────
test("★ 5 · 파일 이름줄(--- / +++)은 세지 않는다 — 세면 모든 diff 가 조용히 +1 -1 부푼다", () => {
  const d = scanDiff(D("diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-옛", "+새"));
  assert.equal(d.add, 1);
  assert.equal(d.del, 1);
});

test("6 · 여러 헝크를 합쳐 센다", () => {
  const d = scanDiff(D("@@ -1 +1 @@", "-a", "+b", "+c", "@@ -9 +9 @@", "-d", "-e", "+f"));
  assert.equal(d.add, 3);
  assert.equal(d.del, 3);
});

test("7 · 문맥 줄(공백으로 시작)은 어느 쪽도 아니다", () => {
  const d = scanDiff(D("@@ -1,2 +1,2 @@", " 그대로", "-옛", "+새"));
  assert.deepEqual(d.lines.map((l) => l.kind), ["hunk", "", "del", "add"]);
});

test("8 · 갈래 이름 계약 — 머리는 meta, 헝크는 hunk(칠하는 쪽이 이 이름으로 클래스를 만든다)", () => {
  const d = scanDiff(D("diff --git a/x b/x", "new file mode 100644", "@@ -0,0 +1 @@", "+첫줄"));
  assert.deepEqual(d.lines.map((l) => l.kind), ["meta", "meta", "hunk", "add"]);
});

// ── 9~11행: 원문 보존 ─────────────────────────────────────────────────────────────────
test("★ 9 · 줄 원문을 바꾸지 않는다 — +/- 부호가 남아야 색 없이도 읽힌다(색각 계약)", () => {
  const src = D("@@ -1 +1 @@", "-옛 줄", "+새 줄");
  const d = scanDiff(src);
  assert.equal(d.lines.map((l) => l.text).join("\n"), src);
});

test("10 · 빈 줄도 줄이다(개수가 맞아야 원문이 복원된다)", () => {
  const d = scanDiff(D("@@ -1 +1 @@", "+a", "", "+b"));
  assert.equal(d.lines.length, 4);
  assert.equal(d.add, 2);
});

test("11 · diff 가 아니면 lines·개수는 비어 있다(호출자가 그리기 전에 isDiff 만 보면 된다)", () => {
  const d = scanDiff("그냥 로그 한 줄");
  assert.deepEqual(d, { isDiff: false, add: 0, del: 0, lines: [] });
});
