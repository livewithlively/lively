// 수집기 산출 규칙(output_config.category_rules) — 사양 기반·구현 블라인드 시험 (사양 §5, src/v6/mirror/output-rules.ts). DB 불요.
// 실행: npm run build && node dist/v6/mirror/output-rules.test.js
//
// 잠그는 행위(§5):
//  1. category_rules 는 위에서부터 «첫 번째로 맞는 규칙»의 category — match 는 §1 glob 문법(문자열 또는 문자열 배열).
//  2. 어느 규칙에도 안 맞거나 itemPath 가 없으면 target_category(앞뒤 공백 제거) — 없거나 비면 null.
//  3. 형식이 틀린 규칙(객체 아님 · category 없음/빈 값/문자열 아님 · match 없음/빈 배열/문자열 아님)은 건너뛰고 나머지는 쓴다.
//     category_rules 가 배열이 아니면 규칙 없음.
//  4. category 값의 앞뒤 공백은 걷는다.
//  5. hasCategoryRules = 유효한 규칙이 하나라도 있나. ruleCategoryOnly = 규칙만 본다(target_category 로 떨어지지 않음).
//  6. outputConfig 가 null/undefined 여도 오류 없이 null/false.
//  7. acceptableNameHint — 64자 이하·소문자 영문/숫자/한글 완성형 덩어리를 하이픈 하나로 이은 문자열만 그대로, 아니면 null.
import assert from "node:assert/strict";
import test from "node:test";
import { collectorCategoryFor, hasCategoryRules, ruleCategoryOnly, acceptableNameHint } from "./output-rules.js";

const CFG: Record<string, unknown> = {
  target_category: "  기본  ",
  category_rules: [
    { match: "Card/", category: "  card-policy " },
    { match: ["Ops/**", "*.runbook.md"], category: "ops" },
    { match: "**/README.md", category: "readme" },
    { match: "/CLAUDE.md", category: "root-claude" },
  ],
};

test("§5.1 위에서부터 첫 번째로 맞는 규칙의 category", () => {
  assert.equal(collectorCategoryFor(CFG, "Card/a.md"), "card-policy", "§5.1 첫 규칙(Card/) — §5.4 공백 제거");
  assert.equal(collectorCategoryFor(CFG, "Card/README.md"), "card-policy", "§5.1 뒤 규칙(**/README.md)에도 맞지만 첫 규칙이 이긴다");
  assert.equal(collectorCategoryFor(CFG, "Ops/x/y.md"), "ops", "§5.1 배열 match 의 첫 원소");
  assert.equal(collectorCategoryFor(CFG, "a/b/deploy.runbook.md"), "ops", "§5.1 배열 match 의 둘째 원소");
  assert.equal(collectorCategoryFor(CFG, "x/README.md"), "readme", "§5.1 셋째 규칙");
  assert.equal(collectorCategoryFor(CFG, "CLAUDE.md"), "root-claude", "§5.1 §1 glob 문법 — 루트 기준 패턴");
});

test("§5.1 match 는 §1 glob 문법으로 판정한다", () => {
  assert.equal(collectorCategoryFor(CFG, "a/CLAUDE.md"), "기본", "§5.1 루트 기준(/CLAUDE.md)은 하위 경로에 안 맞는다 → target_category");
  assert.equal(collectorCategoryFor(CFG, "Cardx/a.md"), "기본", "§5.1 Card/ 는 Cardx/ 에 안 맞는다 → target_category");
  assert.equal(collectorCategoryFor(CFG, "card/a.md"), "기본", "§5.1 대소문자를 가린다 → target_category");
});

test("§5.2 어느 규칙에도 안 맞거나 itemPath 가 없으면 target_category(공백 제거)", () => {
  assert.equal(collectorCategoryFor(CFG, "misc/a.md"), "기본", "§5.2 안 맞으면 target_category");
  assert.equal(collectorCategoryFor(CFG, undefined), "기본", "§5.2 itemPath undefined");
  assert.equal(collectorCategoryFor(CFG, null), "기본", "§5.2 itemPath null");
  assert.equal(collectorCategoryFor(CFG), "기본", "§5.2 itemPath 생략");
  const everything = { target_category: "기본", category_rules: [{ match: "**", category: "전부" }] };
  assert.equal(collectorCategoryFor(everything, "a.md"), "전부", "§5.2 대조: itemPath 가 있으면 규칙");
  assert.equal(collectorCategoryFor(everything, undefined), "기본", "§5.2 itemPath 가 없으면 규칙을 쓰지 않는다");
  assert.equal(collectorCategoryFor({ target_category: " 기본 " }, "anything.md"), "기본", "§5.2 규칙 없이 target_category 만");
});

test("§5.2 target_category 도 없거나 비면 null", () => {
  const rulesOnly = { category_rules: CFG.category_rules };
  assert.equal(collectorCategoryFor(rulesOnly, "misc/a.md"), null, "§5.2 target_category 없음 → null");
  assert.equal(collectorCategoryFor(rulesOnly, undefined), null, "§5.2 target_category 없음·itemPath 없음 → null");
  assert.equal(collectorCategoryFor({ target_category: "", category_rules: CFG.category_rules }, "misc/a.md"), null,
    "§5.2 target_category 빈 문자열 → null");
  assert.equal(collectorCategoryFor({ target_category: "   " }, "misc/a.md"), null, "§5.2 target_category 공백뿐 → null");
  assert.equal(collectorCategoryFor({}, "a.md"), null, "§5.2 빈 설정 → null");
});

const BAD_RULES: unknown[] = [
  "Card/",
  null,
  42,
  ["Card/"],
  { match: "Card/" },
  { match: "Card/", category: "" },
  { match: "Card/", category: 42 },
  { match: "Card/", category: null },
  { category: "x" },
  { match: [], category: "x" },
  { match: 42, category: "x" },
  { match: null, category: "x" },
  { match: { a: 1 }, category: "x" },
];

test("§5.3 형식이 틀린 규칙은 건너뛴다", () => {
  for (const rule of BAD_RULES) {
    const label = JSON.stringify(rule);
    const cfg = { target_category: "fb", category_rules: [rule] };
    assert.equal(hasCategoryRules(cfg), false, `§5.3 틀린 규칙 ${label} 만 있으면 유효 규칙 없음`);
    assert.equal(collectorCategoryFor(cfg, "Card/a.md"), "fb", `§5.3 틀린 규칙 ${label} 은 건너뛰어 target_category`);
    assert.equal(ruleCategoryOnly(cfg, "Card/a.md"), null, `§5.3 틀린 규칙 ${label} 은 ruleCategoryOnly 에도 안 잡힌다`);
  }
});

test("§5.3 틀린 규칙이 섞여도 나머지 규칙은 그대로 쓴다", () => {
  const mixed = {
    target_category: "fb",
    category_rules: [...BAD_RULES, { match: "Card/", category: "good" }, { match: "**", category: "later" }],
  };
  assert.equal(hasCategoryRules(mixed), true, "§5.3 유효 규칙이 남아 있다");
  assert.equal(collectorCategoryFor(mixed, "Card/a.md"), "good", "§5.3 틀린 규칙을 건너뛴 뒤 첫 유효 규칙");
  assert.equal(ruleCategoryOnly(mixed, "Card/a.md"), "good", "§5.3 ruleCategoryOnly 도 같은 규칙");
  assert.equal(collectorCategoryFor(mixed, "Ops/a.md"), "later", "§5.3 그다음 유효 규칙");
});

test("§5.3 category_rules 가 배열이 아니면 규칙 없음", () => {
  for (const rules of [{ match: "Card/", category: "x" }, "Card/", 42, null]) {
    const label = JSON.stringify(rules);
    const cfg = { target_category: "fb", category_rules: rules };
    assert.equal(hasCategoryRules(cfg), false, `§5.3 category_rules=${label} → 규칙 없음`);
    assert.equal(collectorCategoryFor(cfg, "Card/a.md"), "fb", `§5.3 category_rules=${label} → target_category`);
    assert.equal(ruleCategoryOnly(cfg, "Card/a.md"), null, `§5.3 category_rules=${label} → ruleCategoryOnly null`);
  }
});

test("§5.4 category 값의 앞뒤 공백은 걷는다", () => {
  const cfg = { category_rules: [{ match: ["a/**"], category: "\t 카드 정책 \n" }] };
  assert.equal(collectorCategoryFor(cfg, "a/x.md"), "카드 정책", "§5.4 collectorCategoryFor 공백 제거");
  assert.equal(ruleCategoryOnly(cfg, "a/x.md"), "카드 정책", "§5.4 ruleCategoryOnly 공백 제거");
});

test("§5.5 hasCategoryRules 는 유효한 규칙이 하나라도 있으면 true", () => {
  assert.equal(hasCategoryRules(CFG), true, "§5.5 유효 규칙 있음");
  assert.equal(hasCategoryRules({ category_rules: [{ match: "x/", category: "y" }] }), true, "§5.5 규칙 하나");
  assert.equal(hasCategoryRules({ target_category: "x" }), false, "§5.5 target_category 만 있으면 false");
  assert.equal(hasCategoryRules({ category_rules: [] }), false, "§5.5 빈 배열 false");
  assert.equal(hasCategoryRules({}), false, "§5.5 빈 설정 false");
});

test("§5.5 ruleCategoryOnly 는 규칙만 본다(target_category 로 떨어지지 않음)", () => {
  assert.equal(ruleCategoryOnly(CFG, "Card/a.md"), "card-policy", "§5.5 맞는 규칙의 category(공백 제거)");
  assert.equal(ruleCategoryOnly(CFG, "Card/README.md"), "card-policy", "§5.5 첫 번째로 맞는 규칙");
  assert.equal(ruleCategoryOnly(CFG, "x/README.md"), "readme", "§5.5 셋째 규칙");
  assert.equal(ruleCategoryOnly(CFG, "misc/a.md"), null, "§5.5 안 맞으면 null(target_category 무시)");
  assert.equal(ruleCategoryOnly({ target_category: "기본" }, "a.md"), null, "§5.5 규칙이 없으면 null");
});

test("§5.6 outputConfig 가 null/undefined 여도 오류 없이 null/false", () => {
  assert.equal(collectorCategoryFor(null, "a.md"), null, "§5.6 collectorCategoryFor(null)");
  assert.equal(collectorCategoryFor(undefined, "a.md"), null, "§5.6 collectorCategoryFor(undefined)");
  assert.equal(collectorCategoryFor(null), null, "§5.6 collectorCategoryFor(null) itemPath 생략");
  assert.equal(collectorCategoryFor(undefined, null), null, "§5.6 collectorCategoryFor(undefined, null)");
  assert.equal(hasCategoryRules(null), false, "§5.6 hasCategoryRules(null)");
  assert.equal(hasCategoryRules(undefined), false, "§5.6 hasCategoryRules(undefined)");
  assert.equal(ruleCategoryOnly(null, "a.md"), null, "§5.6 ruleCategoryOnly(null)");
  assert.equal(ruleCategoryOnly(undefined, "a.md"), null, "§5.6 ruleCategoryOnly(undefined)");
});

test("§5.7 acceptableNameHint: 지식 이름 꼴이면 그 문자열", () => {
  const ok = ["abc", "가", "2026", "a-b-c", "wiki-pm-카드사-입회-조건-1a2b3c", "카드-policy-2026", "x".repeat(64), "가".repeat(64)];
  for (const s of ok) assert.equal(acceptableNameHint(s), s, `§5.7 그대로 통과: ${JSON.stringify(s)}`);
});

test("§5.7 acceptableNameHint: 꼴이 아니면 null", () => {
  const bad = [
    "", "x".repeat(65), "가".repeat(65), "Abc", "a_b", "a b", "-a", "a-", "a--b", "-",
    "a.b", "a/b", "카드!", "🚀", " a", "a ", "a\n",
  ];
  for (const s of bad) assert.equal(acceptableNameHint(s), null, `§5.7 거절: ${JSON.stringify(s)}`);
});

test("§5.7 acceptableNameHint: 문자열이 아니면 null", () => {
  for (const v of [123, null, undefined, {}, ["abc"], true]) {
    assert.equal(acceptableNameHint(v), null, `§5.7 문자열이 아니면 null: ${JSON.stringify(v) ?? String(v)}`);
  }
});
