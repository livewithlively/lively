// 긴 문서 섹션 단위 재작성 — 사양 C 절(splitSections·checkInvariants·sectionFindings·isEligible mode)의 행위를 한 줄씩 잠근다.
// 실행: npx tsx src/v6/writing-rewrite-sections.test.ts
import assert from "node:assert/strict";
import { splitSections, checkInvariants, sectionFindings, isEligible, REWRITE_BODY_MAX_CHARS } from "./writing-rewrite-gate.js";
import { resolveWritingFormat } from "../org/policies/writing-format.js";

let pass = 0;
const t = (name: string, fn: () => void) => { fn(); pass++; console.log(`ok  ${name}`); };

const fmt = resolveWritingFormat({ enabled: true });
const NOW = new Date("2026-09-30T12:00:00.000Z");
const TWO_DAYS_AGO = new Date(NOW.getTime() - 48 * 3600 * 1000).toISOString();
const BIG = 1_000_000;

const split = (body: string, max = BIG) => splitSections(body, max) as Array<{ text: string; heading: string | null; oversized: boolean }>;
const texts = (body: string, max = BIG) => split(body, max).map((s) => s.text);
const joined = (body: string, max = BIG) => texts(body, max).join("");
const cp = (s: string) => [...s].length;

// ───────────────────────── splitSections: 이어 붙이기 ─────────────────────────

t("이어 붙이면 원문과 같다 — 끝 줄바꿈 있음", () => {
  const body = "머리말이다.\n## 가\n가 내용이다.\n## 나\n나 내용이다.\n";
  assert.equal(joined(body), body);
});
t("이어 붙이면 원문과 같다 — 끝 줄바꿈 없음", () => {
  const body = "머리말이다.\n## 가\n가 내용이다.\n## 나\n나 내용이다.";
  assert.equal(joined(body), body);
});
t("이어 붙이면 원문과 같다 — 빈 줄 연속 포함", () => {
  const body = "머리말이다.\n\n\n\n## 가\n\n\n가 내용이다.\n\n\n## 나\n\n\n\n";
  assert.equal(joined(body), body);
});
t("이어 붙이면 원문과 같다 — ### 재분할이 일어나도", () => {
  const body = "## 가\n" + "가".repeat(50) + "\n### 하나\n" + "하".repeat(50) + "\n### 둘\n" + "둘".repeat(50) + "\n";
  assert.equal(joined(body, 80), body);
});

// ───────────────────────── splitSections: 자르는 자리 ─────────────────────────

t("## 헤딩 줄에서 자르고 헤딩 줄이 새 조각의 첫 줄이다", () => {
  assert.deepEqual(texts("머리말이다.\n## 가\n가 내용이다.\n## 나\n나 내용이다.\n"),
    ["머리말이다.\n", "## 가\n가 내용이다.\n", "## 나\n나 내용이다.\n"]);
});
t("# 하나짜리 헤딩은 1차 분할 기준이 아니다", () => {
  assert.deepEqual(texts("# 제목\n첫 문단이다.\n# 또 제목\n둘째 문단이다.\n"), ["# 제목\n첫 문단이다.\n# 또 제목\n둘째 문단이다.\n"]);
});
t("### 헤딩은 1차 분할 기준이 아니다(한도 이내)", () => {
  assert.deepEqual(texts("## 가\n내용이다.\n### 세부\n세부 내용이다.\n"), ["## 가\n내용이다.\n### 세부\n세부 내용이다.\n"]);
});
t("#### 이상 헤딩도 1차 분할 기준이 아니다", () => {
  assert.equal(split("## 가\n내용이다.\n#### 깊은\n깊은 내용이다.\n").length, 1);
});
t("# 와 공백 없이 붙은 ##가 는 헤딩이 아니다", () => {
  assert.equal(split("머리말이다.\n##가 붙어 있다.\n").length, 1);
});
t("``` 펜스 안의 ## 는 무시한다", () => {
  assert.deepEqual(texts("머리말이다.\n```\n## 안\n```\n## 밖\n끝이다.\n"), ["머리말이다.\n```\n## 안\n```\n", "## 밖\n끝이다.\n"]);
});
t("~~~ 펜스 안의 ## 는 무시한다", () => {
  assert.deepEqual(texts("머리말이다.\n~~~\n## 안\n~~~\n## 밖\n끝이다.\n"), ["머리말이다.\n~~~\n## 안\n~~~\n", "## 밖\n끝이다.\n"]);
});
t("네 개 백틱 펜스는 안쪽 세 개 백틱으로 닫히지 않는다", () => {
  const body = "머리말이다.\n````\n```\n## 안\n```\n````\n## 밖\n끝이다.\n";
  assert.deepEqual(texts(body), ["머리말이다.\n````\n```\n## 안\n```\n````\n", "## 밖\n끝이다.\n"]);
});
t("``` 펜스는 ~~~ 로 닫히지 않는다", () => {
  assert.equal(split("머리말이다.\n```\n~~~\n## 안\n```\n").length, 1);
});
t("앞 공백 0~3칸 ## 은 헤딩으로 자른다", () => {
  for (const pad of ["", " ", "  ", "   "]) {
    const body = `머리말이다.\n${pad}## 가\n내용이다.\n`;
    assert.deepEqual(texts(body), ["머리말이다.\n", `${pad}## 가\n내용이다.\n`], JSON.stringify(pad));
  }
});
t("앞 공백 4칸 ## 은 헤딩이 아니다", () => {
  assert.equal(split("머리말이다.\n    ## 가\n내용이다.\n").length, 1);
});
t("헤딩이 전혀 없으면 조각 1개(heading=null)", () => {
  const body = "그냥 문단이다.\n\n또 문단이다.\n";
  assert.deepEqual(split(body), [{ text: body, heading: null, oversized: false }]);
});
t("첫 헤딩 앞 내용은 heading=null 조각이다", () => {
  const s = split("머리말이다.\n## 가\n내용이다.\n");
  assert.equal(s[0].text, "머리말이다.\n");
  assert.equal(s[0].heading, null);
});
t("첫 줄이 헤딩이면 null 조각 없이 그 헤딩이 첫 조각이다", () => {
  const s = split("## 가\n내용이다.\n## 나\n내용이다.\n");
  assert.equal(s.length, 2);
  assert.equal(s[0].heading, "## 가");
});

// ───────────────────────── splitSections: 한도 재분할 ─────────────────────────

t("한도 초과 조각만 ### 에서 재분할한다", () => {
  const big = "## 큰\n" + "큰".repeat(60) + "\n### 하나\n" + "하".repeat(30) + "\n### 둘\n" + "둘".repeat(30) + "\n";
  const small = "## 작은\n작은 내용이다.\n### 세부\n세부다.\n";
  assert.deepEqual(texts(big + small, 80), [
    "## 큰\n" + "큰".repeat(60) + "\n",
    "### 하나\n" + "하".repeat(30) + "\n",
    "### 둘\n" + "둘".repeat(30) + "\n",
    small,
  ]);
});
t("한도 이하 조각은 ### 가 있어도 자르지 않는다", () => {
  const body = "## 가\n가 내용이다.\n### 세부\n세부 내용이다.\n";
  assert.ok(cp(body) <= 40);
  assert.deepEqual(texts(body, 40), [body]);
});
t("재분할은 펜스 안의 ### 에서 자르지 않는다", () => {
  const body = "## 가\n" + "가".repeat(60) + "\n```\n### 안\n```\n";
  const s = split(body, 20);
  assert.equal(s.length, 1);
  assert.equal(s[0].oversized, true);
});
t("재분할 후에도 넘는 조각은 oversized=true, 나머지는 false", () => {
  const body = "## 가\n짧다.\n### 긴\n" + "긴".repeat(100) + "\n### 짧은\n짧다.\n";
  const s = split(body, 30);
  assert.deepEqual(s.map((x) => x.text), ["## 가\n짧다.\n", "### 긴\n" + "긴".repeat(100) + "\n", "### 짧은\n짧다.\n"]);
  assert.deepEqual(s.map((x) => x.oversized), [false, true, false]);
});
t("### 가 없는 한도 초과 조각은 자르지 않고 oversized=true", () => {
  const body = "## 가\n" + "가".repeat(100) + "\n";
  assert.deepEqual(split(body, 30), [{ text: body, heading: "## 가", oversized: true }]);
});
t("한도는 코드포인트로 센다(서로게이트 쌍 문자)", () => {
  const body = "𠀀".repeat(10);
  assert.equal(body.length, 20);
  assert.deepEqual(split(body, 10), [{ text: body, heading: null, oversized: false }]);
});

// ───────────────────────── splitSections: 빈 조각·heading ─────────────────────────

t("빈 조각을 만들지 않는다", () => {
  const bodies = [
    "## 가\n## 나\n## 다\n",
    "## 가\n",
    "\n## 가\n내용이다.",
    "## 가\n" + "가".repeat(60) + "\n### 하나\n### 둘\n",
  ];
  for (const b of bodies) {
    for (const s of split(b, 40)) assert.ok(s.text.length > 0, JSON.stringify(b));
  }
});
t("heading 은 조각 첫 줄 헤딩(줄바꿈 제외), 아니면 null", () => {
  const body = "머리말이다.\n## 가 절\n내용이다.\n## 나 절\n내용이다.";
  assert.deepEqual(split(body).map((s) => s.heading), [null, "## 가 절", "## 나 절"]);
});
t("### 로 재분할된 조각의 heading 은 ### 줄이다", () => {
  const body = "## 큰\n" + "큰".repeat(60) + "\n### 하나\n" + "하".repeat(10) + "\n";
  assert.deepEqual(split(body, 40).map((s) => s.heading), ["## 큰", "### 하나"]);
});
t("첫 줄이 # 하나 헤딩이면 첫 조각 heading 은 그 줄", () => {
  assert.equal(split("# 문서 제목\n내용이다.\n## 가\n내용이다.\n")[0].heading, "# 문서 제목");
});

// ───────────────────────── checkInvariants ─────────────────────────

const BEFORE = {
  title: "결제 재시도 정책",
  body_md: "결제 재시도는 최대 3회까지 허용한다.\n\n실패하면 사용자에게 안내 메시지를 보낸다. 대기 시간은 40초다.",
};
const kindsOf = (v: unknown) => (v as Array<{ kind: string }>).map((x) => x.kind);

t("같은 문서면 violations 는 비어 있다", () => {
  assert.deepEqual(checkInvariants(BEFORE, BEFORE), []);
});
t("requireTitle 기본 true — 빈 제목이면 empty-title", () => {
  assert.ok(kindsOf(checkInvariants(BEFORE, { ...BEFORE, title: "" })).includes("empty-title"));
});
t("requireTitle=false 면 빈 제목이어도 empty-title 없음", () => {
  assert.ok(!kindsOf(checkInvariants(BEFORE, { ...BEFORE, title: "" }, { requireTitle: false })).includes("empty-title"));
});
t("숫자가 사라지면 invariant:numbers", () => {
  const after = { ...BEFORE, body_md: BEFORE.body_md.replace("40초", "사십초") };
  assert.ok(kindsOf(checkInvariants(BEFORE, after)).includes("invariant:numbers"));
});
t("형식 위반(lint:·new:)은 내지 않는다", () => {
  const bolds = Array.from({ length: 11 }, (_, i) => `**강조${String.fromCharCode(0xac00 + i)}**`).join(" ");
  const after = {
    title: "🚀 " + "결제 재시도 정책을 아주 길게 늘여 쓴 제목이다 ".repeat(3),
    body_md: "## 배경\n" + BEFORE.body_md + "\n\n가 → 나 → 다 → 라 로 흐른다.\n\n" + bolds,
  };
  const ks = kindsOf(checkInvariants(BEFORE, after));
  assert.ok(!ks.some((k) => k.startsWith("lint:") || k.startsWith("new:")), ks.join(","));
});

// ───────────────────────── sectionFindings ─────────────────────────

const LONG_TITLE = "결제 재시도 정책과 실패 안내 메시지 발송 규칙 그리고 대기 시간 설정 기준을 한 번에 정리하고 운영 중 확인한 예외 사례까지 함께 묶어 둔 문서";
const rulesOf = (fs: unknown) => (fs as Array<{ rule: string }>).map((f) => f.rule);
const ARROW_SECTION = "## 흐름\n요청이 들어오면 가 → 나 → 다 → 라 순서로 처리한다.\n";
const BOLD_SECTION = "## 강조\n" + Array.from({ length: 11 }, (_, i) => `**항목${i + 1}** 설명이다.`).join("\n") + "\n";
const AUTO_FIX = new Set(["title_length", "title_leading_emoji", "title_date", "title_mr_ref", "title_status_mark", "title_multi_dash",
  "lead_missing", "bold_overuse", "symbol_overuse", "heading_symbol", "arrow_chain", "nested_paren", "register_mix", "forbidden_term"]);

t("전제: LONG_TITLE 은 61자 이상", () => assert.ok(cp(LONG_TITLE) >= 61));
t("index 0 은 제목 규칙(title_length)을 포함한다", () => {
  assert.ok(rulesOf(sectionFindings(LONG_TITLE, "## 배경\n재시도는 3회까지 허용한다.\n", 0, fmt)).includes("title_length"));
});
t("index 0 은 제목 앞 이모지(title_leading_emoji)를 포함한다", () => {
  assert.ok(rulesOf(sectionFindings("🚀 결제 재시도 정책", "재시도는 3회까지 허용한다.\n", 0, fmt)).includes("title_leading_emoji"));
});
t("index 0 은 lead_missing 을 포함한다", () => {
  assert.ok(rulesOf(sectionFindings("결제 재시도 정책", "## 배경\n재시도는 3회까지 허용한다.\n", 0, fmt)).includes("lead_missing"));
});
t("index > 0 은 제목 규칙·lead_missing 을 뺀다", () => {
  const rs = rulesOf(sectionFindings("🚀 " + LONG_TITLE, "## 배경\n재시도는 3회까지 허용한다.\n", 1, fmt));
  assert.ok(!rs.some((r) => r.startsWith("title_") || r === "lead_missing"), rs.join(","));
});
t("index > 0 도 본문 규칙 arrow_chain 은 포함한다", () => {
  assert.ok(rulesOf(sectionFindings(LONG_TITLE, ARROW_SECTION, 2, fmt)).includes("arrow_chain"));
});
t("index > 0 도 본문 규칙 bold_overuse 는 포함한다", () => {
  assert.ok(rulesOf(sectionFindings(LONG_TITLE, BOLD_SECTION, 1, fmt)).includes("bold_overuse"));
});
t("AUTO_FIX 밖 규칙(relative_time)은 내지 않는다", () => {
  const rs = rulesOf(sectionFindings("결제 재시도 정책", "## 흐름\n어제 가 → 나 → 다 → 라 순서로 바꿨다.\n", 1, fmt));
  assert.ok(rs.includes("arrow_chain"), rs.join(","));
  assert.ok(!rs.includes("relative_time"), rs.join(","));
  assert.ok(rs.every((r) => AUTO_FIX.has(r)), rs.join(","));
});
t("fmt.enabled=false 여도 켠 것으로 간주한다", () => {
  const off = resolveWritingFormat({});
  assert.equal(off.enabled, false);
  assert.ok(rulesOf(sectionFindings(LONG_TITLE, ARROW_SECTION, 1, off)).includes("arrow_chain"));
});

// ───────────────────────── isEligible mode ─────────────────────────

const ARROW_LINE = "요청은 가 → 나 → 다 → 라 순서로 처리한다.\n";
const padTo = (n: number) => ARROW_LINE + "다".repeat(n - cp(ARROW_LINE));
const k = (body_md: string) => ({
  provenance: "authored", lifecycle: "active", is_folder: false, body_md, title: "결제 재시도 정책", updated_at: TWO_DAYS_AGO,
});
const elig = (body: string) => isEligible(k(body) as any, fmt, NOW as any) as any;

t("짧은 본문은 mode=whole", () => {
  const r = elig(ARROW_LINE);
  assert.equal(r.eligible, true);
  assert.equal(r.mode, "whole");
});
t("긴 본문(한도 초과)은 eligible 이고 mode=sections", () => {
  const r = elig(padTo(REWRITE_BODY_MAX_CHARS + 5000));
  assert.equal(r.eligible, true, String(r.reason));
  assert.equal(r.mode, "sections");
});
t("정확히 한도 길이면 mode=whole", () => {
  const body = padTo(REWRITE_BODY_MAX_CHARS);
  assert.equal(cp(body), REWRITE_BODY_MAX_CHARS);
  assert.equal(elig(body).mode, "whole");
});
t("한도+1 이면 mode=sections", () => {
  assert.equal(elig(padTo(REWRITE_BODY_MAX_CHARS + 1)).mode, "sections");
});
t("mode 는 코드포인트로 판정한다(UTF-16 길이만 한도 초과면 whole)", () => {
  const body = ARROW_LINE + "𠀀".repeat(10000);
  assert.ok(body.length > REWRITE_BODY_MAX_CHARS && cp(body) <= REWRITE_BODY_MAX_CHARS);
  assert.equal(elig(body).mode, "whole");
});
t("긴 본문은 too_long 사유로 빠지지 않는다", () => {
  assert.notEqual(elig(padTo(REWRITE_BODY_MAX_CHARS * 3)).reason, "too_long");
});
t("고칠 것 없는 긴 본문의 사유는 too_long 이 아니라 nothing_to_fix", () => {
  const body = "재시도는 허용한다.\n" + "다".repeat(REWRITE_BODY_MAX_CHARS * 2);
  const r = elig(body);
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "nothing_to_fix");
});

console.log(`writing-rewrite-sections: ${pass} passed`);
