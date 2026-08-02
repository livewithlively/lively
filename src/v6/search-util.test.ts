// search-util 순수 함수 단위 체크(#631 프로젝트 검색) — DB 불요(테스트 러너 없이 node:assert 자급).
//  실행: npm run build && node dist/v6/search-util.test.js
//  잠그는 것: grep 매처(parseGrep)·WHERE 생성(grepWhere)·스니펫(grepSnippet, L<n>:/폴백/오버플로/context)·regex→token 폴백(grepExec).
//  이 유틸은 knowledge(#172)·project(#631) 검색이 공유하므로 회귀 시 양쪽이 깨진다.
import assert from "node:assert/strict";
import { parseGrep, grepWhere, grepSnippet, grepExec, type GrepPlan } from "./search-util.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── parseGrep — 평문=토큰 AND, 정규식 메타=regex(깨지면 토큰 폴백). ──
t("parseGrep: 단일 평문 토큰", () => {
  assert.deepEqual(parseGrep("hello"), { mode: "tokens", tokens: ["hello"] });
});
t("parseGrep: 다중 토큰(공백 분리, 트림)", () => {
  assert.deepEqual(parseGrep("  벡터  검색 "), { mode: "tokens", tokens: ["벡터", "검색"] });
});
t("parseGrep: 정규식 메타 → regex 모드(대소문자 무시)", () => {
  const p = parseGrep("벡터|vector");
  assert.equal(p.mode, "regex");
  if (p.mode === "regex") { assert.equal(p.pattern, "벡터|vector"); assert.ok(p.re.test("VECTOR")); }
});
t("parseGrep: 깨진 정규식('[') → 토큰 폴백", () => {
  assert.deepEqual(parseGrep("["), { mode: "tokens", tokens: ["["] });
});
t("parseGrep: 빈 문자열 → 토큰 ['']", () => {
  assert.deepEqual(parseGrep(""), { mode: "tokens", tokens: [""] });
});

// ── grepWhere — cols 불가지론(project 는 [p.name,p.description]). 토큰마다 (cols OR) 를 AND. ──
t("grepWhere: 토큰 AND — 각 토큰이 (cols OR), params 는 %tok%", () => {
  const params: unknown[] = [];
  const where = grepWhere(["p.name", "p.description"], { mode: "tokens", tokens: ["a", "b"] }, params);
  assert.ok(where.includes("p.name ILIKE $1"));
  assert.ok(where.includes("p.description ILIKE $1"));
  assert.ok(where.includes("$2"));
  assert.ok(where.includes(" AND "));
  assert.deepEqual(params, ["%a%", "%b%"]);
});
t("grepWhere: 정규식 — ~* 로 단일 파라미터", () => {
  const params: unknown[] = [];
  const where = grepWhere(["p.name", "p.description"], { mode: "regex", pattern: "a|b", re: /a|b/i }, params);
  assert.ok(where.includes("p.name ~* $1"));
  assert.ok(where.includes("p.description ~* $1"));
  assert.deepEqual(params, ["a|b"]);
});
t("grepWhere: LIKE 와일드카드(%,_)는 리터럴 이스케이프", () => {
  const params: unknown[] = [];
  grepWhere(["p.name"], { mode: "tokens", tokens: ["a_b%c"] }, params);
  assert.equal(params[0], "%a\\_b\\%c%");  // _ 와 % 앞에 백슬래시
});

// ── grepSnippet — 매치 줄만 L<n>:, 매치 0줄이면 앞부분 미리보기, 오버플로 footer(getHint), context ±N. ──
t("grepSnippet: 매치 줄을 L<n>: 로", () => {
  const s = grepSnippet("line one\nhas foo here\nline three", { mode: "tokens", tokens: ["foo"] }, 0, "project_get_v6");
  assert.ok(s.includes("L2: has foo here"));
});
t("grepSnippet: 본문 매치 0줄(제목만 매치 등) → 앞부분 미리보기 폴백", () => {
  const s = grepSnippet("some body text here", { mode: "tokens", tokens: ["zzz"] }, 0, "project_get_v6");
  assert.equal(s, "some body text here");
});
t("grepSnippet: 매치 4줄 초과 → 잔여 수 + getHint 힌트", () => {
  const body = ["m", "m", "m", "m", "m", "m"].join("\n");  // 6 매치줄(SNIP_MAX_LINES=4)
  const s = grepSnippet(body, { mode: "tokens", tokens: ["m"] }, 0, "project_get_v6");
  assert.ok(s.includes("(+2 matches) → project_get_v6"));
});
t("grepSnippet: context>0 면 매치 줄 ±context 포함", () => {
  const s = grepSnippet("a\nb\nMATCH\nd\ne", { mode: "tokens", tokens: ["match"] }, 1, "project_get_v6");
  assert.ok(s.includes("L2: b") && s.includes("L3: MATCH") && s.includes("L4: d"));
});

// ── grepExec — POSIX 가 정규식을 거부하면(JS 유효·POSIX 무효) 토큰모드로 1회 재시도. ──
const calls: string[] = [];
const { result, plan } = await grepExec("a|b", async (p: GrepPlan) => {
  calls.push(p.mode);
  if (p.mode === "regex") throw new Error("posix reject");  // 첫 시도(regex) 실패 흉내
  return "ok";
});
t("grepExec: regex 실패 → 토큰모드 1회 재시도(에러 누출 안 함)", () => {
  assert.equal(result, "ok");
  assert.equal(plan.mode, "tokens");
  assert.deepEqual(calls, ["regex", "tokens"]);
});

console.log(`\n${pass} passed`);
