// 서술 형식 자동 정리 — 의미 보존 게이트(순수 모듈) 사양 A 절의 행위·경계를 한 줄씩 잠근다.
// 실행: npx tsx src/v6/writing-rewrite-gate.test.ts
import assert from "node:assert/strict";
import {
  AUTO_FIX_RULES, REWRITE_BODY_MAX_CHARS, extractInvariants, checkRewrite, isEligible, isOwnLastEdit, ownEditVersions, proseChars,
} from "./writing-rewrite-gate.js";
import { resolveWritingFormat } from "../org/policies/writing-format.js";

let pass = 0;
const t = (name: string, fn: () => void) => { fn(); pass++; console.log(`ok  ${name}`); };

const fmt = resolveWritingFormat({ enabled: true });
const doc = (title: string, body_md: string) => ({ title, body_md });

// 다중집합 표현(배열·Map·Set·카운트 객체)에 무관하게 정렬된 원소 배열로 편다.
const bag = (x: unknown): string[] => {
  if (Array.isArray(x)) return x.map(String).sort();
  if (x instanceof Set) return [...x].map(String).sort();
  if (x instanceof Map) return [...x].flatMap(([k, v]) => (typeof v === "number" ? Array(v).fill(String(k)) : [String(k)])).sort();
  if (x && typeof x === "object") {
    return Object.entries(x as Record<string, unknown>)
      .flatMap(([k, v]) => (typeof v === "number" ? Array(v).fill(k) : [k])).sort();
  }
  throw new Error(`unknown collection: ${String(x)}`);
};
const inv = (title: string, body: string) => extractInvariants(doc(title, body)) as any;
const kinds = (r: { violations: Array<{ kind: string }> }) => r.violations.map((v) => v.kind);
const detailOf = (r: { violations: Array<{ kind: string; detail: string }> }, kind: string) =>
  r.violations.find((v) => v.kind === kind)?.detail ?? "";
const hasKind = (r: { violations: Array<{ kind: string }> }, kind: string) => kinds(r).includes(kind);
const invariantKinds = (r: { violations: Array<{ kind: string }> }) => kinds(r).filter((k) => k.startsWith("invariant:"));

const CLEAN_TITLE = "결제 재시도 정책";
const LEAD = "결제 재시도는 정해진 횟수까지만 허용한다.";
const FILLER = "실패하면 사용자에게 안내 메시지를 보낸다.\n\n운영자는 재시도 기록을 대시보드에서 확인한다.\n\n재시도 간격은 점점 늘어난다.";

// 모든 불변식 필드를 한 번씩 담은 깨끗한 원문. URL·위키링크 이름엔 숫자를 넣지 않는다(숫자 추출과 섞이지 않게).
const FULL_BODY = [
  LEAD,
  "",
  "기준 수치는 40 이다.",
  "",
  "설정 키는 `retry_max` 로 둔다.",
  "",
  "```",
  "const limit = 3;",
  "```",
  "",
  "문서는 https://example.com/retry/guide 에 있다.",
  "",
  "관련 문서는 [[payment-retry-policy]] 를 본다.",
  "",
  "변경은 MR !123 에서 했다.",
  "",
  "| 항목 | 값 |",
  "|---|---|",
  "| 간격 | 초 |",
  "",
  FILLER,
].join("\n");
const FULL = doc(CLEAN_TITLE, FULL_BODY);
const withBody = (from: string, to: string) => doc(CLEAN_TITLE, FULL_BODY.replace(from, to));

// ───────────────────────── 상수 ─────────────────────────

t("AUTO_FIX_RULES 는 사양의 14개 규칙과 정확히 같다", () =>
  assert.deepEqual([...AUTO_FIX_RULES].sort(), [
    "title_length", "title_leading_emoji", "title_date", "title_mr_ref", "title_status_mark", "title_multi_dash",
    "lead_missing", "bold_overuse", "symbol_overuse", "heading_symbol", "arrow_chain", "nested_paren",
    "register_mix", "forbidden_term",
  ].sort()));
t("AUTO_FIX_RULES 에 사실 판단 규칙 5개는 없다", () => {
  for (const r of ["relative_time", "undated_status", "revision_banner", "local_path", "body_length"]) {
    assert.ok(!(AUTO_FIX_RULES as readonly string[]).includes(r), r);
  }
});
t("REWRITE_BODY_MAX_CHARS 는 15000", () => assert.equal(REWRITE_BODY_MAX_CHARS, 15000));

// ───────────────────────── extractInvariants ─────────────────────────

t("codeBlocks: ``` 펜스 블록을 뽑는다", () =>
  assert.equal(bag(inv(CLEAN_TITLE, "본문이다.\n\n```\nfoo()\n```\n").codeBlocks).length, 1));
t("codeBlocks: ~~~ 펜스 블록도 뽑는다", () =>
  assert.equal(bag(inv(CLEAN_TITLE, "본문이다.\n\n~~~\nfoo()\n~~~\n").codeBlocks).length, 1));
t("codeBlocks: 같은 블록 두 번은 두 원소(다중집합)", () =>
  assert.equal(bag(inv(CLEAN_TITLE, "본문이다.\n\n```\nfoo()\n```\n\n```\nfoo()\n```\n").codeBlocks).length, 2));
t("inlineCode: 인라인 코드 원문을 뽑는다", () => {
  const got = bag(inv(CLEAN_TITLE, "키는 `alpha` 와 `beta` 다.").inlineCode);
  assert.equal(got.length, 2);
  assert.ok(got.some((s) => s.includes("alpha")) && got.some((s) => s.includes("beta")));
});
t("inlineCode: 펜스 안의 백틱은 인라인 코드로 세지 않는다", () =>
  assert.equal(bag(inv(CLEAN_TITLE, "본문이다.\n\n```\nx = `inner`\n```\n").inlineCode).length, 0));

t("numbers: 정수·소수·하이픈 날짜가 각각 한 토큰", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "기준일 2026-09-30 에 3.6 배로 40 건을 처리했다.").numbers),
    ["2026-09-30", "3.6", "40"].sort()));
t("numbers: 천단위 쉼표 뒤가 세 자리면 한 토큰(1,234.5)", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "금액은 1,234.5 이다.").numbers), ["1,234.5"]));
t("numbers: 쉼표 뒤가 세 자리가 아니면 나뉜다(1,2,3)", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "순서는 1,2,3 이다.").numbers), ["1", "2", "3"]));
t("numbers: 뒤에 붙은 % 는 토큰에 포함", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "비율은 40% 이다.").numbers), ["40%"]));
t("numbers: 시각 12:30 은 두 토큰", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "마감은 12:30 이다.").numbers), ["12", "30"]));
t("numbers: 줄 머리 번호 목록 표지(1. / 2) )는 세지 않는다", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "절차는 다음과 같다.\n\n1. 요청을 받는다\n2) 검토한다").numbers), []));
t("numbers: 인라인 코드와 펜스 안 숫자는 세지 않는다", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "상수는 `42` 이다.\n\n```\nlimit = 99\n```\n").numbers), []));
t("numbers: 제목의 숫자도 센다", () =>
  assert.deepEqual(bag(inv("재시도 7 회 정책", "본문이다.").numbers), ["7"]));

t("urls: 코드 밖 http(s) URL 을 뽑는다", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "문서는 https://example.com/a 와 http://example.org/b 에 있다.").urls),
    ["http://example.org/b", "https://example.com/a"]));
t("urls: 코드 안 URL 은 뽑지 않는다", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "주소는 `https://example.com/x` 이다.").urls), []));

t("wikilinks: '|' 앞, '#' 앞까지를 이름으로 뽑는다", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "참고 [[alpha-doc|별칭]] 와 [[beta-doc#절]] 를 본다.").wikilinks),
    ["alpha-doc", "beta-doc"]));
t("wikilinks: 코드 안 위키링크는 뽑지 않는다", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "예시는 `[[gamma-doc]]` 이다.").wikilinks), []));

t("refs: MR 123·MR !123·!123 은 모두 !123", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "MR 123 과 MR !123 과 !123 을 봤다.").refs), ["!123"]));
t("refs: PR 12 는 #12", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "PR 12 를 봤다.").refs), ["#12"]));
t("refs: 단독 #1179 는 #1179", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "이슈 #1179 를 봤다.").refs), ["#1179"]));
t("refs: 단독 #N 은 3자리 미만이면 제외", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "이슈 #12 를 봤다.").refs), []));

t("tableRows: 구분선 제외·셀 트림·볼드 제거, 빈 셀은 자리로 남긴 행 다중집합", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "표는 다음과 같다.\n\n| **항목** | 값 |\n|---|---|\n| 간격 |  |\n| 간격 | 초 |\n").tableRows),
    ["간격 | ", "간격 | 초", "항목 | 값"].sort()));
t("tableRows: 행 순서만 바뀌면 보존이다", () => {
  const a = "표다.\n\n| A | 3 |\n| B | 5 |\n";
  const b = "표다.\n\n| B | 5 |\n| A | 3 |\n";
  assert.ok(!checkRewrite(doc(CLEAN_TITLE, a), doc(CLEAN_TITLE, b), fmt).violations.some((v) => v.kind === "invariant:tableRows"));
});
t("tableRows: 행 사이 값이 바뀌면 탈락이다", () => {
  const a = "표다.\n\n| A | 3 |\n| B | 5 |\n";
  const b = "표다.\n\n| A | 5 |\n| B | 3 |\n";
  assert.ok(checkRewrite(doc(CLEAN_TITLE, a), doc(CLEAN_TITLE, b), fmt).violations.some((v) => v.kind === "invariant:tableRows"));
});
t("numbers: 부호가 사라지면 탈락이다(-5 → 5)", () =>
  assert.ok(checkRewrite(doc(CLEAN_TITLE, "기준은 -5도다."), doc(CLEAN_TITLE, "기준은 5도다."), fmt).violations.some((v) => v.kind === "invariant:numbers")));
t("numbers: 날짜·범위의 하이픈은 부호가 아니다", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "기간은 2026-09-30 이고 범위는 3-5 다.").numbers), ["2026-09-30", "3-5"].sort()));
t("numbers: 전각 숫자는 반각으로 맞춰 센다", () => {
  assert.ok(!checkRewrite(doc(CLEAN_TITLE, "재시도는 ５회다."), doc(CLEAN_TITLE, "재시도는 5회다."), fmt).violations.some((v) => v.kind === "invariant:numbers"));
  assert.ok(checkRewrite(doc(CLEAN_TITLE, "재시도는 ５회다."), doc(CLEAN_TITLE, "재시도는 ３회다."), fmt).violations.some((v) => v.kind === "invariant:numbers"));
});
t("numbers: 줄머리 네 자리 연도는 목록 표지가 아니다", () =>
  assert.deepEqual(bag(inv(CLEAN_TITLE, "결론이다.\n2024. 그 해에 바꿨다.").numbers), ["2024"]));
t("urls: 마크다운 상대 링크 대상이 바뀌면 탈락이다", () =>
  assert.ok(checkRewrite(doc(CLEAN_TITLE, "자세한 건 [문서](docs/a.md) 에 있다."), doc(CLEAN_TITLE, "자세한 건 [문서](docs/b.md) 에 있다."), fmt).violations.some((v) => v.kind === "invariant:urls")));

// ───────────────────────── proseChars ─────────────────────────

t("proseChars: 공백을 빼고 센다", () => assert.equal(proseChars(doc("가 나", "다 라\n마")), 5));
t("proseChars: 펜스·인라인 코드는 빼고 센다", () =>
  assert.equal(proseChars(doc("가", "나 `코드코드`\n\n```\n아주긴코드\n```\n")), 2));
t("proseChars: 코드포인트로 센다(서로게이트 쌍은 1)", () => assert.equal(proseChars(doc("😀", "가")), 2));

// ───────────────────────── checkRewrite: 불변식 ─────────────────────────

t("동일한 깨끗한 문서는 ok·violations 없음", () => {
  const r = checkRewrite(FULL, FULL, fmt);
  assert.deepEqual(r.violations, []);
  assert.equal(r.ok, true);
});

const FIELD_CASES: Array<{ field: string; from: string; drop: string; add: string }> = [
  { field: "codeBlocks", from: "```\nconst limit = 3;\n```", drop: "", add: "```\nconst limit = 3;\n```\n\n```\nconst extra = true;\n```" },
  { field: "inlineCode", from: "`retry_max`", drop: "retry_max", add: "`retry_max` 와 `retry_gap`" },
  { field: "numbers", from: "기준 수치는 40 이다.", drop: "기준 수치는 정해져 있다.", add: "기준 수치는 40 과 55 이다." },
  { field: "urls", from: "https://example.com/retry/guide", drop: "예시 사이트", add: "https://example.com/retry/guide 와 https://example.org/other" },
  { field: "wikilinks", from: "[[payment-retry-policy]]", drop: "결제 정책 문서", add: "[[payment-retry-policy]] 와 [[payment-limit-policy]]" },
  { field: "refs", from: "MR !123", drop: "이전 변경", add: "MR !123 과 MR !456" },
  { field: "tableRows", from: "| 간격 | 초 |", drop: "| 간격 | |", add: "| 간격 | 초 |\n| 한도 | 회 |" },
];
for (const c of FIELD_CASES) {
  t(`invariant:${c.field} 보존되면 해당 violation 없음`, () =>
    assert.ok(!hasKind(checkRewrite(FULL, withBody(c.from, c.from), fmt), `invariant:${c.field}`)));
  t(`invariant:${c.field} 누락이면 violation·detail 에 '-'`, () => {
    const r = checkRewrite(FULL, withBody(c.from, c.drop), fmt);
    assert.ok(hasKind(r, `invariant:${c.field}`), kinds(r).join(","));
    assert.ok(detailOf(r, `invariant:${c.field}`).includes("-"));
    assert.equal(r.ok, false);
  });
  t(`invariant:${c.field} 추가면 violation·detail 에 '+'`, () => {
    const r = checkRewrite(FULL, withBody(c.from, c.add), fmt);
    assert.ok(hasKind(r, `invariant:${c.field}`), kinds(r).join(","));
    assert.ok(detailOf(r, `invariant:${c.field}`).includes("+"));
    assert.equal(r.ok, false);
  });
}

t("numbers: 본문 중간에서 중복 값을 하나로 합치면 violation(개수를 센다)", () => {
  const before = doc(CLEAN_TITLE, `${LEAD}\n\n상한은 40 이고 하한도 40 이다.\n\n${FILLER}`);
  const merged = doc(CLEAN_TITLE, `${LEAD}\n\n상한과 하한은 모두 40 이다.\n\n${FILLER}`);
  assert.ok(hasKind(checkRewrite(before, merged, fmt), "invariant:numbers"));
});
t("numbers: 새 첫 줄 결론에서 원문 값을 한 번 더 쓰는 것은 허용", () => {
  const before = doc(CLEAN_TITLE, `${LEAD}\n\n상한은 40 이고 하한도 40 이다.\n\n${FILLER}`);
  const repeated = doc(CLEAN_TITLE, `상한은 40 이다.\n\n${LEAD}\n\n상한은 40 이고 하한도 40 이다.\n\n${FILLER}`);
  assert.ok(!hasKind(checkRewrite(before, repeated, fmt), "invariant:numbers"));
});
t("numbers: 제목·H1 에 두 번 있던 날짜를 본문에 한 번만 옮기는 것은 허용", () => {
  const before = doc("로그 조회 접근 (2026-08-07)", `# 로그 조회 접근 (2026-08-07)\n\n${LEAD}\n\n${FILLER}`);
  const after = doc("로그 조회 접근", `2026-08-07 에 확인했다. ${LEAD}\n\n${FILLER}`);
  assert.ok(!hasKind(checkRewrite(before, after, fmt), "invariant:numbers"));
});
t("numbers: 원문에 있는 다른 값으로 바꿔치기하면 violation(반례 A)", () => {
  const before = doc(CLEAN_TITLE, `${LEAD}\n\n타임아웃은 30초다. 재시도는 3회, 대기는 30초다.\n\n${FILLER}`);
  const after = doc(CLEAN_TITLE, `${LEAD}\n\n타임아웃은 30초다. 재시도는 3회, 대기는 3초다.\n\n${FILLER}`);
  assert.ok(hasKind(checkRewrite(before, after, fmt), "invariant:numbers"));
});
t("numbers: 날짜 사이 바꿔치기는 violation(반례 F)", () => {
  const before = doc(CLEAN_TITLE, `${LEAD}\n\n2026-09-17 배포, 2026-09-20 롤백, 2026-09-17 결정.\n\n${FILLER}`);
  const after = doc(CLEAN_TITLE, `${LEAD}\n\n2026-09-17 배포, 2026-09-17 롤백, 2026-09-20 결정.\n\n${FILLER}`);
  // 다중집합이 같아지는 맞교환(after)은 개수로 못 잡는다 — 그건 의미 판정의 몫이다. 이 한계를 못 박아 둔다.
  assert.ok(!hasKind(checkRewrite(before, after, fmt), "invariant:numbers"));
  const after2 = doc(CLEAN_TITLE, `${LEAD}\n\n2026-09-17 배포, 2026-09-17 롤백, 2026-09-17 결정.\n\n${FILLER}`);
  assert.ok(hasKind(checkRewrite(before, after2, fmt), "invariant:numbers"));
});
t("numbers: 새 첫 줄에 원문에 없던 값을 쓰면 여전히 violation", () => {
  const before = doc(CLEAN_TITLE, `${LEAD}\n\n상한은 40 이다.\n\n${FILLER}`);
  const after = doc(CLEAN_TITLE, `상한은 50 이다.\n\n${LEAD}\n\n상한은 40 이다.\n\n${FILLER}`);
  assert.ok(detailOf(checkRewrite(before, after, fmt), "invariant:numbers").includes("50"));
});
t("numbers: 위반에 missing/added 원값을 구조로 싣는다", () => {
  const before = doc(CLEAN_TITLE, `${LEAD}\n\n상한은 1,000 이다.\n\n${FILLER}`);
  const after = doc(CLEAN_TITLE, `${LEAD}\n\n상한은 2,000 이다.\n\n${FILLER}`);
  const v = checkRewrite(before, after, fmt).violations.find((x) => x.kind === "invariant:numbers")!;
  assert.deepEqual(v.missing, ["1,000"]);
  assert.deepEqual(v.added, ["2,000"]);
});
t("inlineCode: 본문 중간의 다른 코드로 바꿔치기하면 violation(반례 B)", () => {
  const before = doc(CLEAN_TITLE, `${LEAD}\n\n기본은 \`retry_max\`, 상한도 \`retry_max\`, 하한은 \`retry_min\` 이다.\n\n${FILLER}`);
  const after = doc(CLEAN_TITLE, `${LEAD}\n\n기본은 \`retry_min\`, 상한도 \`retry_max\`, 하한은 \`retry_min\` 이다.\n\n${FILLER}`);
  assert.ok(hasKind(checkRewrite(before, after, fmt), "invariant:inlineCode"));
});
t("inlineCode: 백틱을 벗기면 violation", () => {
  const before = doc(CLEAN_TITLE, `${LEAD}\n\n키는 \`retry_max\` 이다.\n\n${FILLER}`);
  const after = doc(CLEAN_TITLE, `${LEAD}\n\n키는 retry_max 이다.\n\n${FILLER}`);
  assert.ok(hasKind(checkRewrite(before, after, fmt), "invariant:inlineCode"));
});
t("numbers: 식별자 안의 숫자(EC2)를 결론에 한 번 더 써도 violation 없음", () => {
  const before = doc(CLEAN_TITLE, `${LEAD}\n\nSCF EC2 태그가 뒤바뀐다.\n\n${FILLER}`);
  const after = doc(CLEAN_TITLE, `EC2 태그 drift 는 무시한다.\n\n${LEAD}\n\nSCF EC2 태그가 뒤바뀐다.\n\n${FILLER}`);
  assert.ok(!hasKind(checkRewrite(before, after, fmt), "invariant:numbers"));
});
t("urls 는 집합: 같은 URL 두 번이 한 번으로 줄어도 violation 없음", () => {
  const u = "https://example.com/retry/guide";
  const before = doc(CLEAN_TITLE, `${LEAD}\n\n문서는 ${u} 에 있고 사본도 ${u} 에 있다.\n\n${FILLER}`);
  const after = doc(CLEAN_TITLE, `${LEAD}\n\n문서와 사본은 모두 ${u} 에 있다.\n\n${FILLER}`);
  assert.ok(!hasKind(checkRewrite(before, after, fmt), "invariant:urls"));
});
t("refs 는 정규화 후 집합 비교: MR 123 → !123 으로 바꿔도 violation 없음", () => {
  const before = withBody("MR !123", "MR 123");
  const after = withBody("MR !123", "!123");
  assert.ok(!hasKind(checkRewrite(before, after, fmt), "invariant:refs"));
});
t("detail 은 빠진 것을 최대 5개까지만 적는다", () => {
  const removed = ["111", "222", "333", "444", "555", "666", "777"];
  const before = doc(CLEAN_TITLE, `${LEAD}\n\n값은 ${removed.join(" 그리고 ")} 이다.\n\n${FILLER}`);
  const after = doc(CLEAN_TITLE, `${LEAD}\n\n값은 여러 개다.\n\n${FILLER}`);
  const d = detailOf(checkRewrite(before, after, fmt), "invariant:numbers");
  const shown = removed.filter((n) => d.includes(n)).length;
  assert.ok(shown >= 1 && shown <= 5, `shown=${shown} detail=${d}`);
});
t("제목의 정보가 본문으로 옮겨지면 불변식은 보존으로 인정", () => {
  const before = doc("MR !123 반영 뒤 재시도 40 회 정책", `${LEAD}\n\n${FILLER}`);
  const after = doc("결제 재시도 정책", `MR !123 반영 뒤 재시도는 40 회까지 허용한다.\n\n${FILLER}`);
  assert.deepEqual(invariantKinds(checkRewrite(before, after, fmt)), []);
});

// ───────────────────────── checkRewrite: 분량 ─────────────────────────

const sized = (n: number) => {
  const d = doc("가", "나".repeat(n - 1));
  assert.equal(proseChars(d), n);
  return d;
};
t("분량 정확히 70% 는 shrink 아님", () =>
  assert.ok(!hasKind(checkRewrite(sized(100), sized(70), fmt), "shrink")));
t("분량 70% 미만이면 shrink", () =>
  assert.ok(hasKind(checkRewrite(sized(100), sized(69), fmt), "shrink")));
t("before 서술 분량이 0 이면 shrink 판정 건너뜀", () => {
  const before = doc("", "```\nonly code\n```\n");
  assert.equal(proseChars(before), 0);
  assert.ok(!hasKind(checkRewrite(before, doc("가", "```\nonly code\n```\n"), fmt), "shrink"));
});

// ───────────────────────── checkRewrite: 형식 ─────────────────────────

const LONG_TITLE = "결제 재시도 정책".padEnd(61, "가");
t("after 에 AUTO_FIX 규칙 title_length 가 남으면 lint:title_length", () =>
  assert.ok(hasKind(checkRewrite(doc(LONG_TITLE, FULL_BODY), doc(LONG_TITLE, FULL_BODY), fmt), "lint:title_length")));
t("before 에도 있던 규칙이면 new: 는 내지 않는다", () =>
  assert.ok(!hasKind(checkRewrite(doc(LONG_TITLE, FULL_BODY), doc(LONG_TITLE, FULL_BODY), fmt), "new:title_length")));
t("after 에 새로 생긴 AUTO_FIX 규칙은 lint: 와 new: 를 둘 다 낸다", () => {
  const r = checkRewrite(FULL, doc(LONG_TITLE, FULL_BODY), fmt);
  assert.ok(hasKind(r, "lint:title_length") && hasKind(r, "new:title_length"), kinds(r).join(","));
});
t("after 에 lead_missing 이 남으면 lint:lead_missing", () => {
  const body = `## 배경\n\n${FULL_BODY}`;
  assert.ok(hasKind(checkRewrite(doc(CLEAN_TITLE, body), doc(CLEAN_TITLE, body), fmt), "lint:lead_missing"));
});
t("after 에 arrow_chain 이 남으면 lint:arrow_chain", () => {
  const body = `${FULL_BODY}\n\n요청 → 검토 → 승인 → 배포 순서다.`;
  assert.ok(hasKind(checkRewrite(doc(CLEAN_TITLE, body), doc(CLEAN_TITLE, body), fmt), "lint:arrow_chain"));
});
t("after 에 bold_overuse 가 남으면 lint:bold_overuse", () => {
  const bolds = Array.from({ length: 11 }, (_, i) => `**항목${"가나다라마바사아자차카"[i]}**`).join(" ");
  const body = `${FULL_BODY}\n\n${bolds} 를 본다.`;
  assert.ok(hasKind(checkRewrite(doc(CLEAN_TITLE, body), doc(CLEAN_TITLE, body), fmt), "lint:bold_overuse"));
});
t("AUTO_FIX 밖 규칙(relative_time)이 새로 생기면 new: 만 내고 lint: 는 내지 않는다", () => {
  const r = checkRewrite(FULL, doc(CLEAN_TITLE, `${FULL_BODY}\n\n오늘 설정을 바꿨다.`), fmt);
  assert.ok(hasKind(r, "new:relative_time"), kinds(r).join(","));
  assert.ok(!hasKind(r, "lint:relative_time"));
});
t("AUTO_FIX 밖 규칙이 before 에도 있으면 violation 없음", () => {
  const body = `${FULL_BODY}\n\n오늘 설정을 바꿨다.`;
  assert.ok(!kinds(checkRewrite(doc(CLEAN_TITLE, body), doc(CLEAN_TITLE, body), fmt)).some((k) => k.endsWith(":relative_time")));
});
t("fmt.enabled=false 여도 형식 판정은 수행한다", () => {
  const off = resolveWritingFormat({ enabled: false });
  assert.ok(hasKind(checkRewrite(doc(LONG_TITLE, FULL_BODY), doc(LONG_TITLE, FULL_BODY), off), "lint:title_length"));
});

// ───────────────────────── checkRewrite: 제목 ─────────────────────────

t("after.title 이 비면 empty-title", () => {
  const r = checkRewrite(FULL, doc("", FULL_BODY), fmt);
  assert.ok(hasKind(r, "empty-title"), kinds(r).join(","));
  assert.equal(r.ok, false);
});

// ───────────────────────── isEligible ─────────────────────────

const NOW = new Date("2026-09-30T12:00:00.000Z");
const H = 3600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const k = (over: Record<string, unknown> = {}) => ({
  provenance: "authored", lifecycle: "active", is_folder: false,
  title: LONG_TITLE, body_md: FULL_BODY, updated_at: ago(25 * H), ...over,
});
const elig = (over: Record<string, unknown> = {}) => isEligible(k(over) as any, fmt, NOW as any) as any;

t("조건을 모두 만족하면 eligible·reason 없음", () => {
  const r = elig();
  assert.equal(r.eligible, true);
  assert.equal(r.reason, undefined);
});
t("targetRules 에 걸린 AUTO_FIX 규칙이 들어간다", () => assert.ok(elig().targetRules.includes("title_length")));
t("findings 는 걸린 AUTO_FIX 규칙의 finding 목록", () => {
  const r = elig();
  assert.ok(Array.isArray(r.findings) && r.findings.length >= 1);
  assert.ok(r.findings.every((f: any) => (AUTO_FIX_RULES as readonly string[]).includes(f.rule)));
});
t("targetRules 에 AUTO_FIX 밖 규칙(relative_time)은 들어가지 않는다", () => {
  const r = elig({ body_md: `${FULL_BODY}\n\n오늘 설정을 바꿨다.` });
  assert.ok(!r.targetRules.includes("relative_time"));
  assert.ok(r.targetRules.every((x: string) => (AUTO_FIX_RULES as readonly string[]).includes(x)));
});
t("provenance 가 authored 아니면 provenance", () => {
  const r = elig({ provenance: "observed" });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "provenance");
});
t("lifecycle 이 active 아니면 lifecycle", () => assert.equal(elig({ lifecycle: "archived" }).reason, "lifecycle"));
t("폴더면 folder", () => assert.equal(elig({ is_folder: true }).reason, "folder"));
t("본문이 REWRITE_BODY_MAX_CHARS 초과면 대상이되 섹션 단위(mode=sections)", () => {
  const r = elig({ body_md: `${LEAD}\n\n${"가".repeat(REWRITE_BODY_MAX_CHARS)}` });
  assert.equal(r.eligible, true);
  assert.equal(r.mode, "sections");
});
t("본문 길이는 코드포인트로 센다(이모지 15000개는 통째 재작성)", () =>
  assert.equal(elig({ body_md: "😀".repeat(REWRITE_BODY_MAX_CHARS), title: "가".repeat(61) }).mode, "whole"));
t("updated_at 이 정확히 24시간 전이면 eligible", () => assert.equal(elig({ updated_at: ago(24 * H) }).eligible, true));
t("updated_at 이 24시간 미만 전이면 recently_edited", () =>
  assert.equal(elig({ updated_at: ago(24 * H - 1000) }).reason, "recently_edited"));
t("updated_at 을 파싱할 수 없으면 recently_edited", () =>
  assert.equal(elig({ updated_at: "not-a-date" }).reason, "recently_edited"));
t("걸린 AUTO_FIX 규칙이 없으면 nothing_to_fix", () => {
  const r = elig({ title: CLEAN_TITLE });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "nothing_to_fix");
});
t("여러 사유가 겹치면 첫 탈락 사유(provenance)를 낸다", () =>
  assert.equal(elig({ provenance: "observed", lifecycle: "archived", is_folder: true, updated_at: ago(0), title: CLEAN_TITLE }).reason,
    "provenance"));
t("긴 폴더는 folder", () =>
  assert.equal(elig({ is_folder: true, body_md: "가".repeat(REWRITE_BODY_MAX_CHARS + 1) }).reason, "folder"));
t("긴 문서도 최근 수정이면 recently_edited", () =>
  assert.equal(elig({ updated_at: ago(0), body_md: "가".repeat(REWRITE_BODY_MAX_CHARS + 1) }).reason, "recently_edited"));

t("numbers: «2026년 9월 17일» 표기는 «2026-09-17» 과 같은 날로 본다", () => {
  const a = doc("배포 규칙 (2026-09-17)", "결론이다.");
  const b = doc("배포 규칙", "2026년 9월 17일 기준 결론이다.");
  assert.ok(!checkRewrite(a, b, fmt).violations.some((v) => v.kind === "invariant:numbers"));
  assert.ok(checkRewrite(a, doc("배포 규칙", "2026년 9월 18일 기준 결론이다."), fmt).violations.some((v) => v.kind === "invariant:numbers"));
});
// 리뷰 반례 — 허용 범위(첫 줄·제목)를 이용한 바꿔치기가 통과하면 안 된다.
t("허용 범위 악용: 새 첫 줄에 두 값을 적고 본문에서 30→3 치환하면 violation", () => {
  const before = doc(CLEAN_TITLE, `${LEAD}\n\n타임아웃은 30초다. 재시도는 3회, 대기는 30초다.\n\n${FILLER}`);
  const after = doc(CLEAN_TITLE, `30초 타임아웃, 3회 재시도가 기준이다.\n\n${LEAD}\n\n타임아웃은 30초다. 재시도는 3회, 대기는 3초다.\n\n${FILLER}`);
  assert.ok(hasKind(checkRewrite(before, after, fmt), "invariant:numbers"));
});
t("허용 범위 악용: 원문 첫 문단 안의 치환은 첫 줄을 새로 쓰지 않아도 violation", () => {
  const before = doc(CLEAN_TITLE, `재시도는 3회, 대기는 30초, 타임아웃은 30초, 상한은 5회다.\n\n${FILLER}`);
  const after = doc(CLEAN_TITLE, `재시도는 3회, 대기는 3초, 타임아웃은 30초, 상한은 5회다.\n\n${FILLER}`);
  assert.ok(hasKind(checkRewrite(before, after, fmt), "invariant:numbers"));
});
t("허용 범위 악용: 첫 줄에 두 코드를 적고 본문에서 retry_max→retry_min 치환하면 violation", () => {
  const before = doc(CLEAN_TITLE, `${LEAD}\n\n기본은 \`retry_max\`, 상한도 \`retry_max\`, 하한은 \`retry_min\` 이다.\n\n${FILLER}`);
  const after = doc(CLEAN_TITLE, `\`retry_max\`·\`retry_min\` 두 키를 쓴다.\n\n${LEAD}\n\n기본은 \`retry_min\`, 상한도 \`retry_max\`, 하한은 \`retry_min\` 이다.\n\n${FILLER}`);
  assert.ok(hasKind(checkRewrite(before, after, fmt), "invariant:inlineCode"));
});
t("허용 범위 악용: 첫 줄에 날짜 범위를 적고 본문 날짜를 바꾸면 violation", () => {
  const before = doc(CLEAN_TITLE, `${LEAD}\n\n2026-09-17 배포, 2026-09-20 롤백.\n\n${FILLER}`);
  const after = doc(CLEAN_TITLE, `2026-09-17~2026-09-20 사이 일이다.\n\n${LEAD}\n\n2026-09-20 배포, 2026-09-20 롤백.\n\n${FILLER}`);
  assert.ok(hasKind(checkRewrite(before, after, fmt), "invariant:numbers"));
});
t("허용은 개수까지만: 첫 줄에 한 번 되풀이한 값이 본문에서 두 번 늘면 violation", () => {
  const before = doc(CLEAN_TITLE, `${LEAD}\n\n상한은 40 이다.\n\n${FILLER}`);
  const after = doc(CLEAN_TITLE, `상한은 40 이다.\n\n${LEAD}\n\n상한은 40 이고 기본도 40 이다.\n\n${FILLER}`);
  assert.ok(hasKind(checkRewrite(before, after, fmt), "invariant:numbers"));
});
t("양쪽 면제 조합: 제목 날짜를 첫 줄로 옮기며 본문 날짜를 바꾸면 violation(b-date)", () => {
  const before = doc("2026-09-17 배포 회고", "2026-09-20 에 롤백으로 마무리됐다.\n\n배포는 2026-09-17 에 했다.");
  const after = doc("배포 회고", "2026-09-17 배포는 2026-09-20 에 롤백으로 마무리됐다.\n\n배포는 2026-09-20 에 했다.");
  assert.ok(hasKind(checkRewrite(before, after, fmt), "invariant:numbers"));
});
t("양쪽 면제 조합: 제목에 X, 원문 첫 줄에 Y 가 있고 본문 X→Y 면 violation(a')", () => {
  const before = doc("타임아웃 30초 기준", "재시도는 3회다.\n\n대기는 30초다.");
  const after = doc("타임아웃 30초 기준", "재시도는 3회다.\n\n대기는 3초다.");
  assert.ok(hasKind(checkRewrite(before, after, fmt), "invariant:numbers"));
});
t("양쪽 면제 조합: H1 에 X, 다음 줄에 Y 가 있고 본문 X→Y 면 violation(a'')", () => {
  const before = doc(CLEAN_TITLE, "# 타임아웃 30초\n재시도는 3회다.\n\n대기는 30초다.");
  const after = doc(CLEAN_TITLE, "# 타임아웃 30초\n재시도는 3회다.\n\n대기는 3초다.");
  assert.ok(hasKind(checkRewrite(before, after, fmt), "invariant:numbers"));
});
// ───────────────────────── 배치 자신의 반영(own edit) ─────────────────────────

t("최근 수정이어도 배치 자신의 반영이면(lastEditIsOwn) 대상이다", () => {
  const recent = k({ updated_at: ago(1 * H) });
  assert.equal(isEligible(recent as any, fmt, NOW as any).reason, "recently_edited");
  const r = isEligible(recent as any, fmt, NOW as any, { lastEditIsOwn: true }) as any;
  assert.equal(r.eligible, true);
});
t("lastEditIsOwn 이어도 다른 부적격 사유는 그대로다", () => {
  const r = isEligible(k({ updated_at: ago(1 * H), provenance: "observed" }) as any, fmt, NOW as any, { lastEditIsOwn: true }) as any;
  assert.equal(r.reason, "provenance");
});
t("최신 이력이 리포트 판 위의 그 반영이면 자기 반영이다", () =>
  assert.equal(isOwnLastEdit({ version_before: 7, version_after: 8 }, 7, 8), true));
t("반영 뒤 누가 고쳤으면(최신 이력의 출발 판이 다르면) 자기 반영이 아니다", () =>
  assert.equal(isOwnLastEdit({ version_before: 8, version_after: 9 }, 7, 9), false));
t("최신 이력의 도착 판이 현재 판과 다르면 자기 반영이 아니다", () =>
  assert.equal(isOwnLastEdit({ version_before: 7, version_after: 8 }, 7, 9), false));
t("이력·리포트 판·현재 판 중 하나라도 없으면 자기 반영으로 보지 않는다", () => {
  assert.equal(isOwnLastEdit(undefined, 7, 8), false);
  assert.equal(isOwnLastEdit({ version_before: null, version_after: 8 }, 7, 8), false);
  assert.equal(isOwnLastEdit({ version_before: 7, version_after: 8 }, undefined, 8), false);
  assert.equal(isOwnLastEdit({ version_before: 7, version_after: 8 }, 7, null), false);
});
t("적용 리포트에서 applied 만, 이름별 가장 나중 판을 고른다", () => {
  const m = ownEditVersions([
    JSON.stringify({ name: "a", status: "applied", version: 3 }),
    JSON.stringify({ name: "a", status: "applied", version: 5 }),
    JSON.stringify({ name: "a", status: "applied", version: 4 }),
    JSON.stringify({ name: "b", status: "skipped", version: 2 }),
    JSON.stringify({ name: "c", status: "staged", version: 2 }),
    JSON.stringify({ name: "d", status: "applied" }),
    JSON.stringify({ name: "e", status: "applied", version: 2, section: "rewritten" }),
    "",
    '{"name":"f","status":"appl',
  ]);
  assert.deepEqual([...m.entries()], [["a", 5]]);
});
console.log(`writing-rewrite-gate: ${pass} passed`);
