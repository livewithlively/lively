// 낱말 규칙(#5201) 유닛 시험 — 색인과 질의가 같은 낱말을 만드는지, 측정한 규칙에서 벗어나지 않았는지 잠근다.
//  기대값은 측정에 쓴 규칙(research_notes 의 evalset_tok.py)이 같은 글에서 낸 결과다. 규칙을 바꾸면 품질을 다시 재야 한다.
import test from "node:test";
import assert from "node:assert/strict";
import { lexTokens, lexTermFreq, lexQueryTerms, lexDocText, hasIdentifier, bm25Sql, LEX_TERM_MAX, LEX_QUERY_TERMS_MAX, LEX_QUERY_CHARS_MAX } from "./knowledge-lex.js";

test("영문 덩어리 — 통째 + 조각(소문자)", () => {
  assert.deepEqual(lexTokens("src/v6/knowledge-store.ts"), ["src/v6/knowledge-store.ts", "src", "v6", "knowledge", "store", "ts"]);
  assert.deepEqual(lexTokens("embedding_vector"), ["embedding_vector", "embedding", "vector"]);
  assert.deepEqual(lexTokens("parseGrep"), ["parsegrep", "parse", "grep"]);
  assert.deepEqual(lexTokens("#1617"), ["1617"]);
});

test("덩어리 끝의 문장부호는 떨어진다", () => {
  assert.deepEqual(lexTokens("knowledge-store.ts:510-517"), ["knowledge-store.ts", "knowledge", "store", "ts", "510-517", "510", "517"]);
  assert.deepEqual(lexTokens("a."), ["a"]);
});

test("한글 어절 — 끝의 조사를 한 번 뗀다 · 두 글자 미만으로 줄이지 않는다", () => {
  assert.deepEqual(lexTokens("임베딩을 다시 돌렸다"), ["임베딩", "다시", "돌렸다"]);
  assert.deepEqual(lexTokens("이가"), ["이가"]);
  assert.deepEqual(lexTokens("검색에서는"), ["검색"]);
});

test("영문과 한글이 붙어 있으면 따로 나뉜다", () => {
  assert.deepEqual(lexTokens("knowledge_lex를 고쳤다"), ["knowledge_lex", "knowledge", "lex", "를", "고쳤다"]);
});

test("그 밖의 글자는 덩어리째 — 가나·한자 · 한글 자모는 뺀다", () => {
  assert.ok(lexTokens("検索 カード").includes("検索"));
  assert.ok(lexTokens("検索 カード").includes("カード"));
  assert.deepEqual(lexTokens("ㅇㅇ ㄱㄱ ㅋㅋ"), []);
});

test("풀어 쓴 한글(NFD)도 같은 낱말이다", () => {
  assert.deepEqual(lexTokens("임베딩".normalize("NFD")), ["임베딩"]);
});

test("낱말 길이 상한 — 긴 덩어리는 통째로는 안 넣고 조각은 넣는다", () => {
  const long = "a".repeat(LEX_TERM_MAX + 1);
  assert.deepEqual(lexTokens(long), []);
  assert.deepEqual(lexTokens(`${long}-tail`), ["tail"]);
  assert.deepEqual(lexTokens("a".repeat(LEX_TERM_MAX)), ["a".repeat(LEX_TERM_MAX)]);
});

test("빈 글 · 문장부호뿐인 글", () => {
  assert.deepEqual(lexTokens(""), []);
  assert.deepEqual(lexTokens("?!(){}"), []);
  assert.deepEqual(lexQueryTerms("?!"), []);
});

test("빈도 · 문서 글", () => {
  assert.deepEqual([...lexTermFreq(["a", "b", "a"])], [["a", 2], ["b", 1]]);
  assert.equal(lexDocText({ name: "n", title: null, body_md: "b" }), "n\n\nb");
});

test("질의 낱말 — 겹침 없음 · 상한", () => {
  assert.deepEqual(lexQueryTerms("검색 검색을 검색"), ["검색"]);
  const many = Array.from({ length: LEX_QUERY_TERMS_MAX + 20 }, (_, i) => `w${i}`).join(" ");
  assert.equal(lexQueryTerms(many).length, LEX_QUERY_TERMS_MAX);
});

test("정규식처럼 친 검색어도 낱말로 나뉜다", () => {
  assert.deepEqual(lexQueryTerms("노드|원격|로컬 PC|node"), ["pc", "node", "노드", "원격", "로컬"]);
});

test("식별자 판정", () => {
  for (const q of ["#2486", "knowledge-store.ts", "src/v6/ 어디", "embedding_vector 칸", "parseGrep 함수", "6a81bf8ee", "HYBRID_CANDIDATES"]) {
    assert.equal(hasIdentifier(q), true, q);
  }
  for (const q of ["임베딩 재색인 방법", "bge-m3 모델 교체", "#1", "how to deploy", "API 키"]) {
    assert.equal(hasIdentifier(q), false, q);
  }
});

test("식별자 판정 — 긴 글에서도 곧바로 끝난다(이벤트 루프를 멈추지 않는다)", () => {
  for (const q of ["a".repeat(1_000_000), `ok ${"a-".repeat(500_000)}`, "/a".repeat(500_000)]) {
    const t0 = performance.now();
    hasIdentifier(q);
    lexQueryTerms(q);
    assert.ok(performance.now() - t0 < 200, `${q.slice(0, 8)} ${performance.now() - t0}ms`);
  }
});

test("식별자 판정 — 뒤돌아보기가 판정을 바꾸지 않는다(파일 이름은 덩어리 머리부터 맞는다)", () => {
  assert.equal(hasIdentifier("knowledge-store.ts"), true);
  assert.equal(hasIdentifier("(a_b-c.mjs 파일)"), true);
  assert.equal(hasIdentifier("낱말knowledge.ts"), true);
});

test("질의로 읽는 글자 상한", () => {
  assert.deepEqual(lexQueryTerms(`${"가나 ".repeat(LEX_QUERY_CHARS_MAX)} 끝낱말`), ["가나"]);
});

test("BM25 SQL — 낱말 배열을 매개변수로 넘기고 값을 글에 넣지 않는다", () => {
  const params: unknown[] = ["x"];
  const sql = bm25Sql(["a'b"], params, "TRUE");
  assert.deepEqual(params, ["x", ["a'b"]]);
  assert.ok(sql.includes("$2::text[]"));
  assert.ok(!sql.includes("a'b"));
});

test("BM25 SQL — 공개범위 술어가 통계의 바탕(lv)에 걸린다", () => {
  const sql = bm25Sql(["a"], [], "k.visibility = 'open'");
  const lv = sql.slice(0, sql.indexOf("lp AS"));
  assert.ok(lv.includes("JOIN knowledge k") && lv.includes("k.visibility = 'open'"), lv);
  assert.ok(/ls AS \(SELECT count\(\*\)::float8 AS n, GREATEST\(avg\(doc_len\), 1\)::float8 AS avgdl FROM lv\)/.test(sql));
  assert.ok(sql.includes("JOIN lv d ON"));
  assert.ok(!bm25Sql(["a"], [], "TRUE").includes("JOIN knowledge k"), "볼 수 있는 것이 전부면 이어 붙이지 않는다");
});
