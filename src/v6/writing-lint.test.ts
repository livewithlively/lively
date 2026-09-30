// 조직 서술 형식(writing_format) 정책 + 서술 형식 검사 — 사양(A 정책·B 검사)의 행위·경계를 한 줄씩 잠근다.
// 실행: npx tsx src/v6/writing-lint.test.ts
import assert from "node:assert/strict";
import {
  DEFAULT_WRITING_FORMAT, resolveWritingFormat, mergeWritingFormatRaw, ruleLevel, WRITING_RULE_IDS,
  type WritingFormat,
} from "../org/policies/writing-format.js";
import { lintWriting } from "./writing-lint.js";

let pass = 0;
const t = (name: string, fn: () => void) => { fn(); pass++; console.log(`ok  ${name}`); };

const on = (extra: Record<string, unknown> = {}): WritingFormat => resolveWritingFormat({ enabled: true, ...extra });
const lint = (title: string | null, body_md: string, fmt: WritingFormat = on()) =>
  lintWriting({ title, body_md } as any, fmt);
const rulesOf = (title: string | null, body: string, fmt?: WritingFormat) => lint(title, body, fmt).map((f) => f.rule);
const has = (rule: string, title: string | null, body: string, fmt?: WritingFormat) =>
  (rulesOf(title, body, fmt) as string[]).includes(rule);

const CLEAN_TITLE = "결제 재시도 정책";
const CLEAN_BODY = "결제 재시도는 최대 3회까지 허용한다.\n\n실패하면 사용자에게 안내 메시지를 보낸다.";
const TITLE_RULES = ["title_length", "title_leading_emoji", "title_date", "title_mr_ref", "title_status_mark", "title_multi_dash"];
const ALL_RULES = [
  ...TITLE_RULES, "lead_missing", "body_length", "bold_overuse", "symbol_overuse", "heading_symbol",
  "relative_time", "local_path", "arrow_chain", "nested_paren", "undated_status", "revision_banner",
  "forbidden_term", "register_mix",
];
const filler = (n: number) => Array.from({ length: n }, (_, i) => `설명 문장 ${i + 1}번이다.`);

// ───────────────────────── A. 정책 ─────────────────────────

// A.1 기본값
t("A1 기본 enabled=false", () => assert.equal(DEFAULT_WRITING_FORMAT.enabled, false));
t("A1 기본 register=plain", () => assert.equal(DEFAULT_WRITING_FORMAT.register, "plain"));
t("A1 기본 limits", () => assert.deepEqual(DEFAULT_WRITING_FORMAT.limits,
  { title_max_chars: 60, activity_title_max_chars: 80, body_max_chars: 8000, bold_max: 10, symbol_max: 3 }));
t("A1 기본 apply_to=세 표면 전부", () => assert.deepEqual(DEFAULT_WRITING_FORMAT.apply_to, ["knowledge", "activity", "project"]));
t("A2 apply_to 는 알려진 표면만 남긴다", () => assert.deepEqual(resolveWritingFormat({ apply_to: ["project", "nope", "knowledge"] }).apply_to, ["knowledge", "project"]));
t("A1 기본 forbid_terms=[]", () => assert.deepEqual(DEFAULT_WRITING_FORMAT.forbid_terms, []));
t("A1 기본 rules={}", () => assert.deepEqual(DEFAULT_WRITING_FORMAT.rules, {}));
t("A1 기본 default_level=warn", () => assert.equal(DEFAULT_WRITING_FORMAT.default_level, "warn"));
t("A1 기본 guide_md 는 비어있지 않은 한국어", () => {
  assert.ok(DEFAULT_WRITING_FORMAT.guide_md.trim().length > 0);
  assert.match(DEFAULT_WRITING_FORMAT.guide_md, /[가-힣]/);
});
t("A 규칙 id 목록은 검사 규칙 전부를 담는다", () => {
  for (const id of ALL_RULES) assert.ok((WRITING_RULE_IDS as readonly string[]).includes(id), id);
});

// A.2 잡값 접기
t("A2 raw=null 은 기본값", () => assert.deepEqual(resolveWritingFormat(null), DEFAULT_WRITING_FORMAT));
t("A2 raw=문자열 은 throw 없이 기본값", () => assert.deepEqual(resolveWritingFormat("garbage"), DEFAULT_WRITING_FORMAT));
t("A2 raw=배열 은 throw 없이 기본값", () => assert.deepEqual(resolveWritingFormat([1, 2]), DEFAULT_WRITING_FORMAT));
t("A2 enabled 비-boolean 은 기본", () => assert.equal(resolveWritingFormat({ enabled: "true" }).enabled, false));
t("A2 enabled=true 는 유지", () => assert.equal(resolveWritingFormat({ enabled: true }).enabled, true));
t("A2 register 잡값은 기본 plain", () => assert.equal(resolveWritingFormat({ register: "casual" }).register, "plain"));
t("A2 register=polite 유지", () => assert.equal(resolveWritingFormat({ register: "polite" }).register, "polite"));
t("A2 register=any 유지", () => assert.equal(resolveWritingFormat({ register: "any" }).register, "any"));
t("A2 limits 칸 숫자 아님은 그 칸만 기본", () => {
  const f = resolveWritingFormat({ limits: { title_max_chars: "30", bold_max: 4 } });
  assert.equal(f.limits.title_max_chars, 60);
  assert.equal(f.limits.bold_max, 4);
});
t("A2 limits 가 객체 아님은 전부 기본", () =>
  assert.deepEqual(resolveWritingFormat({ limits: 5 }).limits, DEFAULT_WRITING_FORMAT.limits));
t("A2 limits 숫자는 반올림", () => {
  const f = resolveWritingFormat({ limits: { title_max_chars: 30.6, bold_max: 4.4 } });
  assert.equal(f.limits.title_max_chars, 31);
  assert.equal(f.limits.bold_max, 4);
});
t("A2 limits 하한 클램프", () => assert.deepEqual(
  resolveWritingFormat({ limits: { title_max_chars: 5, body_max_chars: 100, bold_max: -3, symbol_max: -1 } }).limits,
  { activity_title_max_chars: 80, title_max_chars: 10, body_max_chars: 500, bold_max: 0, symbol_max: 0 }));
t("A2 limits 상한 클램프", () => assert.deepEqual(
  resolveWritingFormat({ limits: { title_max_chars: 999, body_max_chars: 1e7, bold_max: 9999, symbol_max: 9999 } }).limits,
  { activity_title_max_chars: 80, title_max_chars: 200, body_max_chars: 200000, bold_max: 500, symbol_max: 500 }));
t("A2 작업기록 제목 한도는 [20,500] 으로 클램프", () => {
  assert.equal(resolveWritingFormat({ limits: { activity_title_max_chars: 5 } }).limits.activity_title_max_chars, 20);
  assert.equal(resolveWritingFormat({ limits: { activity_title_max_chars: 9999 } }).limits.activity_title_max_chars, 500);
});
t("A2 limits 범위 끝값은 그대로", () => assert.deepEqual(
  resolveWritingFormat({ limits: { title_max_chars: 200, body_max_chars: 500, bold_max: 0, symbol_max: 500 } }).limits,
  { activity_title_max_chars: 80, title_max_chars: 200, body_max_chars: 500, bold_max: 0, symbol_max: 500 }));

// A.3 rules·default_level
t("A3 rules 는 알려진 id + off|warn 만 남긴다", () => assert.deepEqual(
  resolveWritingFormat({ rules: { title_date: "off", bold_overuse: "warn", no_such_rule: "off", title_length: "error" } }).rules,
  { title_date: "off", bold_overuse: "warn" }));
t("A3 default_level=off 유지", () => assert.equal(resolveWritingFormat({ default_level: "off" }).default_level, "off"));
t("A3 default_level 잡값은 기본 warn", () => assert.equal(resolveWritingFormat({ default_level: "error" }).default_level, "warn"));

// A.4 forbid_terms
t("A4 문자열만 남긴다", () =>
  assert.deepEqual(resolveWritingFormat({ forbid_terms: ["a", 1, null, { x: 1 }, "b"] }).forbid_terms, ["a", "b"]));
t("A4 앞뒤 공백 제거", () => assert.deepEqual(resolveWritingFormat({ forbid_terms: ["  슬랙  "] }).forbid_terms, ["슬랙"]));
t("A4 빈 값 제거", () => assert.deepEqual(resolveWritingFormat({ forbid_terms: ["", "   ", "x"] }).forbid_terms, ["x"]));
t("A4 대소문자 무시 중복 제거·처음 것 유지", () =>
  assert.deepEqual(resolveWritingFormat({ forbid_terms: ["Slack", "slack", "SLACK", "b"] }).forbid_terms, ["Slack", "b"]));
t("A4 한 항목 80자 절단", () => {
  const [term] = resolveWritingFormat({ forbid_terms: ["가".repeat(100)] }).forbid_terms;
  assert.equal(term, "가".repeat(80));
});
t("A4 80자 항목은 그대로", () =>
  assert.deepEqual(resolveWritingFormat({ forbid_terms: ["나".repeat(80)] }).forbid_terms, ["나".repeat(80)]));
t("A4 최대 200개", () => {
  const terms = Array.from({ length: 250 }, (_, i) => `term${i}`);
  const got = resolveWritingFormat({ forbid_terms: terms }).forbid_terms;
  assert.equal(got.length, 200);
  assert.equal(got[0], "term0");
  assert.equal(got[199], "term199");
});
t("A4 배열 아님은 []", () => assert.deepEqual(resolveWritingFormat({ forbid_terms: "slack" }).forbid_terms, []));

// A.5 guide_md
t("A5 비어있지 않은 guide_md 사용", () => assert.equal(resolveWritingFormat({ guide_md: "우리 규칙" }).guide_md, "우리 규칙"));
t("A5 guide_md 8000자 절단", () =>
  assert.equal(resolveWritingFormat({ guide_md: "가".repeat(9000) }).guide_md, "가".repeat(8000)));
t("A5 빈 guide_md 는 기본 가이드", () =>
  assert.equal(resolveWritingFormat({ guide_md: "" }).guide_md, DEFAULT_WRITING_FORMAT.guide_md));
t("A5 문자열 아닌 guide_md 는 기본 가이드", () =>
  assert.equal(resolveWritingFormat({ guide_md: 42 }).guide_md, DEFAULT_WRITING_FORMAT.guide_md));

// A.6 merge
t("A6 patch=null 이면 {}", () =>
  assert.deepEqual(mergeWritingFormatRaw({ enabled: true, register: "polite" }, null), {}));
t("A6 기본값을 채워 넣지 않는다", () =>
  assert.deepEqual(mergeWritingFormatRaw({}, { register: "polite" } as any), { register: "polite" }));
t("A6 현재 원본 위에 얹는다", () =>
  assert.deepEqual(mergeWritingFormatRaw({ enabled: true }, { register: "polite" } as any),
    { enabled: true, register: "polite" }));
t("A6 patch 값이 현재 원본 칸을 덮는다", () =>
  assert.deepEqual(mergeWritingFormatRaw({ register: "plain" }, { register: "any" } as any), { register: "any" }));
t("A6 patch 의 무효 칸은 얹지 않는다", () =>
  assert.deepEqual(mergeWritingFormatRaw({ enabled: true }, { register: "casual" } as any), { enabled: true }));
t("A6 limits 칸 단위 병합", () =>
  assert.deepEqual(
    mergeWritingFormatRaw({ limits: { title_max_chars: 40 } }, { limits: { bold_max: 5 } } as any),
    { limits: { title_max_chars: 40, bold_max: 5 } }));
t("A6 rules 는 현재 원본 rules 와 병합", () =>
  assert.deepEqual(
    mergeWritingFormatRaw({ rules: { bold_overuse: "off" } }, { rules: { title_date: "off" } } as any),
    { rules: { bold_overuse: "off", title_date: "off" } }));
t("A6 guide_md 빈 문자열은 키 삭제", () =>
  assert.deepEqual(mergeWritingFormatRaw({ enabled: true, guide_md: "옛 가이드" }, { guide_md: "" } as any),
    { enabled: true }));
t("A6 guide_md 공백은 키 삭제", () =>
  assert.deepEqual(mergeWritingFormatRaw({ guide_md: "옛 가이드" }, { guide_md: "   " } as any), {}));
t("A6 merge 결과를 resolve 하면 기본 가이드로 복귀", () =>
  assert.equal(resolveWritingFormat(mergeWritingFormatRaw({ guide_md: "옛" }, { guide_md: "" } as any)).guide_md,
    DEFAULT_WRITING_FORMAT.guide_md));

// A.7 ruleLevel
t("A7 명시값 우선", () => assert.equal(ruleLevel(on({ rules: { title_date: "off" } }), "title_date" as any), "off"));
t("A7 명시 없으면 default_level=warn", () => assert.equal(ruleLevel(on(), "title_date" as any), "warn"));
t("A7 명시 없으면 default_level=off", () =>
  assert.equal(ruleLevel(on({ default_level: "off" }), "title_date" as any), "off"));
t("A7 default_level=off 여도 명시 warn 우선", () =>
  assert.equal(ruleLevel(on({ default_level: "off", rules: { title_date: "warn" } }), "title_date" as any), "warn"));

// ───────────────────────── B. 검사 공통 ─────────────────────────

const MESSY_TITLE = "🚀 2026-09-30 배포 — 정리 — MR 123 ✅";
const MESSY_BODY = "## 🚀 개요\n오늘 아직 배포하지 않았습니다. a → b → c → d (x (y)) /Users/charles/x **a** ✅✅✅✅";

t("B enabled=false 면 [] (입력 무관)", () => assert.deepEqual(lint(MESSY_TITLE, MESSY_BODY, DEFAULT_WRITING_FORMAT), []));
t("B off 규칙은 결과에 없다", () =>
  assert.ok(!has("title_date", "2026-09-30 정산", CLEAN_BODY, on({ rules: { title_date: "off" } }))));
t("B default_level=off 면 명시 warn 규칙만 나온다", () =>
  assert.deepEqual([...new Set(rulesOf(MESSY_TITLE, MESSY_BODY, on({ default_level: "off", rules: { title_date: "warn" } })))],
    ["title_date"]));
t("B level 은 항상 warn, message 는 비어있지 않은 한국어", () => {
  const fs = lint(MESSY_TITLE, MESSY_BODY);
  assert.ok(fs.length > 0);
  for (const f of fs) {
    assert.equal(f.level, "warn");
    assert.ok(f.message.trim().length > 0);
    assert.match(f.message, /[가-힣]/);
  }
});
t("B 형식 지킨 평범한 문서는 []", () => assert.deepEqual(lint(CLEAN_TITLE, CLEAN_BODY), []));
t("B title=null 이면 제목 규칙 건너뜀", () => assert.deepEqual(lint(null, CLEAN_BODY), []));
t("B title='' 이면 제목 규칙 건너뜀", () => assert.deepEqual(lint("", CLEAN_BODY), []));
t("B body='' 면 본문 규칙 건너뜀", () => assert.deepEqual(lint(CLEAN_TITLE, ""), []));
t("B body='' 여도 제목 규칙은 판정", () => assert.deepEqual(rulesOf("2026-09-30 정산", ""), ["title_date"]));

// ───────────────────────── 제목 규칙 ─────────────────────────

const f20 = () => on({ limits: { title_max_chars: 20 } });
t("title_length 상한과 같으면 통과", () => assert.ok(!has("title_length", "가".repeat(20), CLEAN_BODY, f20())));
t("title_length 상한 초과면 발생", () => assert.ok(has("title_length", "가".repeat(21), CLEAN_BODY, f20())));
t("title_length 는 코드포인트로 센다", () =>
  assert.ok(!has("title_length", "𝐀".repeat(20), CLEAN_BODY, f20())));

t("title_leading_emoji 첫 글자 그림 이모지면 발생", () => assert.ok(has("title_leading_emoji", "🚀 배포 절차", CLEAN_BODY)));
t("title_leading_emoji 이모지가 뒤에 있으면 통과", () => assert.ok(!has("title_leading_emoji", "배포 절차 🚀", CLEAN_BODY)));
t("title_leading_emoji 평범한 제목은 통과", () => assert.ok(!has("title_leading_emoji", CLEAN_TITLE, CLEAN_BODY)));

t("title_date YYYY-MM 발생", () => assert.ok(has("title_date", "2026-09 정산 정리", CLEAN_BODY)));
t("title_date YYYY-MM-DD 발생", () => assert.ok(has("title_date", "정산 정리 2026-09-30", CLEAN_BODY)));
t("title_date 20xx 아닌 연도는 통과", () => assert.ok(!has("title_date", "1999-09 정산 정리", CLEAN_BODY)));
t("title_date 날짜 없으면 통과", () => assert.ok(!has("title_date", CLEAN_TITLE, CLEAN_BODY)));

t("title_mr_ref 'MR 123' 발생", () => assert.ok(has("title_mr_ref", "정산 수정 MR 123", CLEAN_BODY)));
t("title_mr_ref 'MR !123' 발생", () => assert.ok(has("title_mr_ref", "정산 수정 MR !123", CLEAN_BODY)));
t("title_mr_ref 공백 뒤 !숫자 발생", () => assert.ok(has("title_mr_ref", "정산 수정 !45", CLEAN_BODY)));
t("title_mr_ref 괄호 뒤 !숫자 발생", () => assert.ok(has("title_mr_ref", "정산 수정(!45)", CLEAN_BODY)));
t("title_mr_ref 가운뎃점 뒤 !숫자 발생", () => assert.ok(has("title_mr_ref", "정산 수정·!45", CLEAN_BODY)));
t("title_mr_ref 쉼표 뒤 !숫자 발생", () => assert.ok(has("title_mr_ref", "정산 수정,!45", CLEAN_BODY)));
t("title_mr_ref 시작 !숫자 발생", () => assert.ok(has("title_mr_ref", "!45 정산 수정", CLEAN_BODY)));
t("title_mr_ref !숫자 1자리는 통과", () => assert.ok(!has("title_mr_ref", "정산 수정 !7", CLEAN_BODY)));
t("title_mr_ref 글자 뒤 !숫자는 통과", () => assert.ok(!has("title_mr_ref", "정산수정!45", CLEAN_BODY)));
t("title_mr_ref 참조 없으면 통과", () => assert.ok(!has("title_mr_ref", CLEAN_TITLE, CLEAN_BODY)));

for (const mark of ["🔴", "🟠", "🟡", "🟢", "✅", "❌", "⭐", "⚠", "🚨", "🔥", "💡", "📌", "‼", "❗"]) {
  t(`title_status_mark '${mark}' 발생`, () => assert.ok(has("title_status_mark", `정산 정리 ${mark}`, CLEAN_BODY)));
}
t("title_status_mark 첫 글자가 이모지면 판정 안 함", () => assert.ok(!has("title_status_mark", "✅ 정산 정리", CLEAN_BODY)));
t("title_status_mark 기호 없으면 통과", () => assert.ok(!has("title_status_mark", CLEAN_TITLE, CLEAN_BODY)));

t("title_multi_dash em dash 2개 발생", () => assert.ok(has("title_multi_dash", "정산 — 재시도 — 정리", CLEAN_BODY)));
t("title_multi_dash em dash 1개 통과", () => assert.ok(!has("title_multi_dash", "정산 — 재시도 정리", CLEAN_BODY)));

// ───────────────────────── 본문 골격 ─────────────────────────

const LEAD_BAD: Record<string, string> = {
  "헤딩 #": "# 개요는 없다\n\n## 개요\n결론이다.", // H1 건너뛴 다음 줄이 헤딩
  "헤딩 ##": "## 개요\n결론이다.",
  "헤딩 ######": "###### 개요\n결론이다.",
  "인용": "> 인용으로 시작한다.\n결론이다.",
  "표": "| a | b |\n|---|---|\n| 1 | 2 |",
  "코드펜스 ```": "```\ncode\n```\n결론이다.",
  "코드펜스 ~~~": "~~~\ncode\n~~~\n결론이다.",
  "HTML 주석": "<!-- 메모 -->\n결론이다.",
  "수평선": "---\n결론이다.",
};
for (const [kind, body] of Object.entries(LEAD_BAD)) {
  t(`lead_missing 첫 줄 ${kind} 발생`, () => assert.ok(has("lead_missing", CLEAN_TITLE, body)));
}
t("lead_missing H1 다음 줄이 평서문이면 통과", () =>
  assert.ok(!has("lead_missing", CLEAN_TITLE, "# 결제 재시도\n\n재시도는 3회까지 허용한다.")));
t("lead_missing 앞 빈 줄은 건너뛴다", () => assert.ok(!has("lead_missing", CLEAN_TITLE, "\n\n  \n" + CLEAN_BODY)));
t("lead_missing '#' 뒤 공백 없으면 헤딩 아님", () =>
  assert.ok(!has("lead_missing", CLEAN_TITLE, "#해시태그로 시작하는 결론이다.")));
t("lead_missing 평서문 첫 줄은 통과", () => assert.ok(!has("lead_missing", CLEAN_TITLE, CLEAN_BODY)));

const f500 = () => on({ limits: { body_max_chars: 500 } });
t("body_length 상한과 같으면 통과", () => assert.ok(!has("body_length", CLEAN_TITLE, "가".repeat(499) + "다", f500())));
t("body_length 상한 초과면 발생", () => assert.ok(has("body_length", CLEAN_TITLE, "가".repeat(500) + "다", f500())));

// ───────────────────────── 강조 ─────────────────────────

const fb2 = () => on({ limits: { bold_max: 2 } });
t("bold_overuse 상한과 같으면 통과", () =>
  assert.ok(!has("bold_overuse", CLEAN_TITLE, "**하나**와 **둘**을 정리한다.", fb2())));
t("bold_overuse 상한 초과면 발생", () =>
  assert.ok(has("bold_overuse", CLEAN_TITLE, "**하나**와 **둘**과 **셋**을 정리한다.", fb2())));
t("bold_overuse 인라인 코드 안은 세지 않는다", () =>
  assert.ok(!has("bold_overuse", CLEAN_TITLE, "**하나**와 **둘**과 `**셋**` 을 정리한다.", fb2())));
t("bold_overuse 코드펜스 안은 세지 않는다", () =>
  assert.ok(!has("bold_overuse", CLEAN_TITLE, "**하나**와 **둘**을 정리한다.\n```\n**셋** **넷**\n```", fb2())));

const fs1 = () => on({ limits: { symbol_max: 1 } });
t("symbol_overuse 상한과 같으면 통과", () => assert.ok(!has("symbol_overuse", CLEAN_TITLE, "배포는 끝났다 ✅.", fs1())));
t("symbol_overuse 상한 초과면 발생", () => assert.ok(has("symbol_overuse", CLEAN_TITLE, "배포는 끝났다 ✅ 확인했다 🔴.", fs1())));
t("symbol_overuse 인라인 코드 안은 세지 않는다", () =>
  assert.ok(!has("symbol_overuse", CLEAN_TITLE, "배포는 끝났다 ✅ 표기는 `🔴` 이다.", fs1())));

t("heading_symbol 헤딩에 이모지면 발생", () =>
  assert.ok(has("heading_symbol", CLEAN_TITLE, CLEAN_BODY + "\n\n## 🚀 배포\n배포한다.")));
t("heading_symbol 이모지 없는 헤딩은 통과", () =>
  assert.ok(!has("heading_symbol", CLEAN_TITLE, CLEAN_BODY + "\n\n## 배포\n배포한다.")));
t("heading_symbol 헤딩 아닌 줄의 이모지는 통과", () =>
  assert.ok(!has("heading_symbol", CLEAN_TITLE, CLEAN_BODY + "\n\n배포 준비를 마쳤다 🚀.")));

// ───────────────────────── 작성 맥락 ─────────────────────────

for (const w of ["오늘", "어제", "내일", "그저께", "엊그제", "지난주", "이번주", "다음주", "이번 세션", "지난 세션", "이 세션"]) {
  t(`relative_time '${w}' 발생`, () => assert.ok(has("relative_time", CLEAN_TITLE, `${CLEAN_BODY}\n\n${w} 설정을 바꿨다.`)));
}
t("relative_time 인용 줄 안은 무시", () =>
  assert.ok(!has("relative_time", CLEAN_TITLE, `${CLEAN_BODY}\n\n> 오늘 설정을 바꿨다.`)));
t("relative_time 인라인 코드 안은 무시", () =>
  assert.ok(!has("relative_time", CLEAN_TITLE, `${CLEAN_BODY}\n\n상수 이름은 \`오늘\` 이다.`)));
t("relative_time 없으면 통과", () => assert.ok(!has("relative_time", CLEAN_TITLE, CLEAN_BODY)));
t("relative_time '방금'은 대상 아님", () =>
  assert.ok(!has("relative_time", CLEAN_TITLE, `${CLEAN_BODY}

방금 만든 파일만 지운다.`)));
for (const q of ['"오늘"', "“오늘”", "‘오늘’", "「오늘」", "『오늘』"]) {
  t(`relative_time 따옴표 ${q} 안은 무시`, () =>
    assert.ok(!has("relative_time", CLEAN_TITLE, `${CLEAN_BODY}

${q} 같은 표현을 쓰지 않는다.`)));
}
t("relative_time 영문 아포스트로피 사이는 따옴표로 보지 않는다", () =>
  assert.ok(has("relative_time", CLEAN_TITLE, `${CLEAN_BODY}

don't 오늘 isn't 이다.`)));
t("relative_time 따옴표 밖이면 같은 줄에 인용이 있어도 발생", () =>
  assert.ok(has("relative_time", CLEAN_TITLE, `${CLEAN_BODY}

"확인" 요청을 오늘 받았다.`)));

t("local_path /Users/<이름> 발생", () =>
  assert.ok(has("local_path", CLEAN_TITLE, `${CLEAN_BODY}\n\n설정 파일은 /Users/charles/app.conf 에 둔다.`)));
t("local_path /home/<이름> 발생", () =>
  assert.ok(has("local_path", CLEAN_TITLE, `${CLEAN_BODY}\n\n설정 파일은 /home/bob/app.conf 에 둔다.`)));
t("local_path 공백 뒤 ~/ 발생", () =>
  assert.ok(has("local_path", CLEAN_TITLE, `${CLEAN_BODY}\n\n설정 파일은 ~/work/app.conf 에 둔다.`)));
t("local_path 괄호 뒤 ~/ 발생", () =>
  assert.ok(has("local_path", CLEAN_TITLE, `${CLEAN_BODY}\n\n설정 파일을 둔다(~/work/app.conf).`)));
t("local_path 줄시작 ~/ 발생", () =>
  assert.ok(has("local_path", CLEAN_TITLE, `${CLEAN_BODY}\n~/work/app.conf 에 둔다.`)));
t("local_path C:\\Users\\ 발생", () =>
  assert.ok(has("local_path", CLEAN_TITLE, `${CLEAN_BODY}\n\n설정 파일은 C:\\Users\\bob\\app.conf 에 둔다.`)));
t("local_path 코드 안도 발생", () =>
  assert.ok(has("local_path", CLEAN_TITLE, `${CLEAN_BODY}\n\n\`\`\`\ncat /Users/charles/app.conf\n\`\`\``)));
t("local_path '/Users/' 로 끝나는 언급은 통과", () =>
  assert.ok(!has("local_path", CLEAN_TITLE, `${CLEAN_BODY}

로컬 경로(\`/Users/\`)는 55건이다.`)));
t("local_path 레포 상대 경로는 통과", () =>
  assert.ok(!has("local_path", CLEAN_TITLE, `${CLEAN_BODY}\n\n배포 스크립트는 deploy/x.sh 에 둔다.`)));
t("local_path 글자 뒤 ~/ 는 통과", () =>
  assert.ok(!has("local_path", CLEAN_TITLE, `${CLEAN_BODY}\n\n범위는 3~/5 로 적는다.`)));

// ───────────────────────── 문장 ─────────────────────────

t("arrow_chain → 3개 발생", () => assert.ok(has("arrow_chain", CLEAN_TITLE, `${CLEAN_BODY}\n\n신청 → 심사 → 승인 → 기표 순이다.`)));
t("arrow_chain → 2개 통과", () => assert.ok(!has("arrow_chain", CLEAN_TITLE, `${CLEAN_BODY}\n\n신청 → 심사 → 승인 순이다.`)));
t("arrow_chain 줄마다 따로 센다", () =>
  assert.ok(!has("arrow_chain", CLEAN_TITLE, `${CLEAN_BODY}\n\n신청 → 심사 순이다.\n승인 → 기표 → 상환 순이다.`)));
t("arrow_chain 인라인 코드 안은 무시", () =>
  assert.ok(!has("arrow_chain", CLEAN_TITLE, `${CLEAN_BODY}\n\n흐름은 \`a → b → c → d\` 로 적는다.`)));

t("nested_paren 반각 괄호 속 괄호 발생", () =>
  assert.ok(has("nested_paren", CLEAN_TITLE, `${CLEAN_BODY}\n\n재시도는 3회(단, 정산(월말)은 제외)까지다.`)));
t("nested_paren 전각 괄호 속 괄호 발생", () =>
  assert.ok(has("nested_paren", CLEAN_TITLE, `${CLEAN_BODY}\n\n재시도는 3회（단, 정산（월말）은 제외）까지다.`)));
t("nested_paren 단순 괄호 하나 통과", () =>
  assert.ok(!has("nested_paren", CLEAN_TITLE, `${CLEAN_BODY}\n\n재시도는 3회(월말 제외)까지다.`)));
t("nested_paren 나란한 괄호 둘은 통과", () =>
  assert.ok(!has("nested_paren", CLEAN_TITLE, `${CLEAN_BODY}\n\n재시도(3회)와 대기(5초)를 둔다.`)));
t("nested_paren 인라인 코드 안은 무시", () =>
  assert.ok(!has("nested_paren", CLEAN_TITLE, `${CLEAN_BODY}\n\n호출은 \`f(g(x))\` 로 한다.`)));

for (const w of ["아직", "진행중", "대기중", "배포대기", "머지대기", "미배포", "미머지", "예정이다", "예정입니다", "예정임"]) {
  t(`undated_status '${w}' 날짜 없으면 발생`, () =>
    assert.ok(has("undated_status", CLEAN_TITLE, `${CLEAN_BODY}\n\n이 변경은 ${w} 상태다.`)));
}
t("undated_status 같은 줄에 YYYY-MM-DD 있으면 통과", () =>
  assert.ok(!has("undated_status", CLEAN_TITLE, `${CLEAN_BODY}\n\n2026-09-30 기준 이 변경은 미배포 상태다.`)));
t("undated_status 같은 줄에 YYYY-MM 있으면 통과", () =>
  assert.ok(!has("undated_status", CLEAN_TITLE, `${CLEAN_BODY}\n\n2026-09 기준 이 변경은 미배포 상태다.`)));
t("undated_status 날짜가 다른 줄에만 있으면 발생", () =>
  assert.ok(has("undated_status", CLEAN_TITLE, `${CLEAN_BODY}\n\n2026-09-30 에 정리했다.\n이 변경은 미배포 상태다.`)));
t("undated_status 따옴표 안 상태어는 통과", () =>
  assert.ok(!has("undated_status", CLEAN_TITLE, `${CLEAN_BODY}

"아직", "배포 대기" 같은 표현에 날짜가 없다.`)));
t("undated_status 인용 줄은 통과", () =>
  assert.ok(!has("undated_status", CLEAN_TITLE, `${CLEAN_BODY}\n\n> 이 변경은 미배포 상태다.`)));

const banner = (line: string) => `${CLEAN_BODY}\n${line}\n${filler(3).join("\n")}`;
t("revision_banner > 로 시작하는 UPDATE 발생", () => assert.ok(has("revision_banner", CLEAN_TITLE, banner("> UPDATE: 규칙을 바꿨다."))));
t("revision_banner # 로 시작하는 정정 발생", () => assert.ok(has("revision_banner", CLEAN_TITLE, banner("## 정정 안내"))));
t("revision_banner ** 로 시작하는 정정 발생", () => assert.ok(has("revision_banner", CLEAN_TITLE, banner("**정정**: 규칙을 바꿨다."))));
t("revision_banner 헤딩의 갱신은 대상 아님", () => assert.ok(!has("revision_banner", CLEAN_TITLE, banner("## 토큰 갱신 절차"))));
t("revision_banner ⚠ 로 시작하는 폐기 발생", () => assert.ok(has("revision_banner", CLEAN_TITLE, banner("⚠ 이 규칙은 폐기했다."))));
t("revision_banner 🔴 로 시작하는 방향 전환 발생", () => assert.ok(has("revision_banner", CLEAN_TITLE, banner("🔴 방향 전환을 했다."))));
t("revision_banner 날짜 포함 줄의 '더 이상 유효하지' 발생", () =>
  assert.ok(has("revision_banner", CLEAN_TITLE, banner("2026-09-30 부터 이 규칙은 더 이상 유효하지 않다."))));
t("revision_banner **vN→vM** 발생", () => assert.ok(has("revision_banner", CLEAN_TITLE, banner("**v2→v3** 로 바꿨다."))));
t("revision_banner 표식·날짜 없는 줄의 키워드는 통과", () =>
  assert.ok(!has("revision_banner", CLEAN_TITLE, banner("이 문서는 정산 규칙을 갱신한 결과다."))));
t("revision_banner 키워드 없으면 통과", () => assert.ok(!has("revision_banner", CLEAN_TITLE, banner("> 참고로 적어 둔다."))));
{
  // 20줄 문서: 앞부분 = max(15, 4) = 15줄
  const doc20 = (at: number) => {
    const lines = filler(20);
    lines[at - 1] = "2026-09-01 정정: 값을 바꿨다.";
    return lines.join("\n");
  };
  t("revision_banner 앞부분 마지막 줄(15/20)은 발생", () => assert.ok(has("revision_banner", CLEAN_TITLE, doc20(15))));
  t("revision_banner 앞부분 밖(16/20)은 통과", () => assert.ok(!has("revision_banner", CLEAN_TITLE, doc20(16))));
  // 100줄 문서: 앞부분 = max(15, 20) = 20줄
  const doc100 = (at: number) => {
    const lines = filler(100);
    lines[at - 1] = "2026-09-01 정정: 값을 바꿨다.";
    return lines.join("\n");
  };
  t("revision_banner 20% 경계 안(20/100)은 발생", () => assert.ok(has("revision_banner", CLEAN_TITLE, doc100(20))));
  t("revision_banner 20% 경계 밖(21/100)은 통과", () => assert.ok(!has("revision_banner", CLEAN_TITLE, doc100(21))));
  t("revision_banner 문서 끝 「변경 이력」 속 정정은 통과", () => {
    const lines = [...filler(95), "## 변경 이력", "- 2026-09-01 정정: 값을 바꿨다.", "- 2026-09-10 UPDATE: 표를 갱신했다."];
    assert.ok(!has("revision_banner", CLEAN_TITLE, lines.join("\n")));
  });
}

// ───────────────────────── 금지어 ─────────────────────────

t("forbidden_term 제목에 대소문자 무시로 포함되면 발생·sample 은 등록 표기", () => {
  const hits = lint("slack 공지 정리", CLEAN_BODY, on({ forbid_terms: ["Slack"] })).filter((f) => f.rule === "forbidden_term");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sample, "Slack");
});
t("forbidden_term 본문에 포함되면 발생", () =>
  assert.ok(has("forbidden_term", CLEAN_TITLE, `${CLEAN_BODY}\n\n알림은 SLACK 으로 보낸다.`, on({ forbid_terms: ["slack"] }))));
t("forbidden_term 여러 금지어가 걸려도 1건", () => {
  const hits = lint("Slack 공지", `${CLEAN_BODY}\n\n알림은 메일로 보낸다.`, on({ forbid_terms: ["slack", "메일"] }))
    .filter((f) => f.rule === "forbidden_term");
  assert.equal(hits.length, 1);
});
t("forbidden_term 포함 안 되면 통과", () =>
  assert.ok(!has("forbidden_term", CLEAN_TITLE, CLEAN_BODY, on({ forbid_terms: ["slack"] }))));
t("forbidden_term forbid_terms 비면 통과", () => assert.ok(!has("forbidden_term", "slack 공지", CLEAN_BODY)));

// ───────────────────────── 문체 ─────────────────────────

const POLITE = (n: number) => Array.from({ length: n }, (_, i) => `항목 ${i + 1}을 확인했습니다.`);
const PLAIN = (n: number) => Array.from({ length: n }, (_, i) => `항목 ${i + 1}을 정리했다.`);
const mix = (...parts: string[][]) => [PLAIN(1)[0], ...parts.flat()].join("\n");

// 아래 mix 는 맨 앞에 평서 1줄을 둔다(lead 용) — 개수 계산에 포함.
t("register_mix plain: 존댓말 3개·20% 초과면 발생", () =>
  assert.ok(has("register_mix", CLEAN_TITLE, mix(POLITE(3), PLAIN(9))))); // 3/13
t("register_mix plain: 존댓말 2개면 비율 높아도 통과", () =>
  assert.ok(!has("register_mix", CLEAN_TITLE, mix(POLITE(2))))); // 2/3
t("register_mix plain: 정확히 20% 면 통과", () =>
  assert.ok(!has("register_mix", CLEAN_TITLE, mix(POLITE(3), PLAIN(11))))); // 3/15
t("register_mix plain: 20% 를 막 넘으면 발생", () =>
  assert.ok(has("register_mix", CLEAN_TITLE, mix(POLITE(3), PLAIN(10))))); // 3/14
t("register_mix plain: 3개여도 20% 이하면 통과", () =>
  assert.ok(!has("register_mix", CLEAN_TITLE, mix(POLITE(3), PLAIN(19))))); // 3/23
t("register_mix 존댓말 종결 변형(~세요/~십시오/~어요/~에요/~해요)도 센다", () =>
  assert.ok(has("register_mix", CLEAN_TITLE,
    mix(["이 값을 확인하세요.", "이 값을 확인하십시오.", "이 값이 좋아요.", "이 값은 기본이에요.", "이 값을 정리해요."], PLAIN(2))))); // 5/8
t("register_mix 한 줄의 여러 문장을 따로 센다", () =>
  assert.ok(has("register_mix", CLEAN_TITLE, mix(["확인했습니다. 배포했습니다. 종료했습니다."], PLAIN(3))))); // 3/7
t("register_mix polite: 평서 3개·20% 초과면 발생", () =>
  assert.ok(has("register_mix", CLEAN_TITLE, [...POLITE(5), ...PLAIN(3)].join("\n"), on({ register: "polite" })))); // 3/8
t("register_mix polite: 존댓말만이면 통과", () =>
  assert.ok(!has("register_mix", CLEAN_TITLE, POLITE(6).join("\n"), on({ register: "polite" }))));
t("register_mix any 면 판정 안 함", () =>
  assert.ok(!has("register_mix", CLEAN_TITLE, mix(POLITE(5), PLAIN(2)), on({ register: "any" }))));
t("register_mix 인용 줄은 제외", () =>
  assert.ok(!has("register_mix", CLEAN_TITLE, mix(POLITE(3).map((l) => `> ${l}`), PLAIN(2)))));
t("register_mix 헤딩 줄은 제외", () =>
  assert.ok(!has("register_mix", CLEAN_TITLE, mix(POLITE(3).map((l) => `## ${l}`), PLAIN(2)))));
t("register_mix 표 줄은 제외", () =>
  assert.ok(!has("register_mix", CLEAN_TITLE, mix(POLITE(3).map((l) => `| ${l} |`), PLAIN(2)))));
t("register_mix plain 문서에 평서만이면 통과", () => assert.ok(!has("register_mix", CLEAN_TITLE, mix(PLAIN(10)))));

t("undated_status 명사 '예정'만으로는 대상 아님", () =>
  assert.ok(!has("undated_status", CLEAN_TITLE, `${CLEAN_BODY}

예정된 작업 목록을 정리한다.`)));
t("relative_time '안내일정'의 내일은 대상 아님", () =>
  assert.ok(!has("relative_time", CLEAN_TITLE, `${CLEAN_BODY}

안내일정을 공지한다.`)));
for (const [label, line] of [["여는 따옴표", "“".repeat(200_000)], ["여는 낫표", "「".repeat(200_000)], ["닫는 괄호 런", ")".repeat(199_999) + "가"], ["강조 런", "*".repeat(199_999) + "가"], ["혼합", "\"'「『“".repeat(40_000)]] as const) {
  t(`성능: 200k 한 줄(${label})도 1초 안에 끝난다`, () => {
    const t0 = Date.now();
    lint(CLEAN_TITLE, `${CLEAN_BODY}

${line}`);
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `${ms}ms`);
  });
}
t("reject 수준 규칙의 finding 은 level=reject, 나머지는 warn", () => {
  const f = lint("🔴 배포 규칙 (2026-09-23)", CLEAN_BODY, on({ rules: { title_date: "reject" } }));
  assert.equal(f.find((x) => x.rule === "title_date")?.level, "reject");
  assert.equal(f.find((x) => x.rule === "title_leading_emoji")?.level, "warn");
});
t("resolve 는 reject 수준을 보존한다(rules·default_level)", () => {
  const f = resolveWritingFormat({ rules: { local_path: "reject" }, default_level: "reject" });
  assert.equal(f.rules.local_path, "reject");
  assert.equal(f.default_level, "reject");
});
console.log(`writing-lint: ${pass} passed`);
