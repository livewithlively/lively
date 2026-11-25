// 서술 형식 결정적 자동 정리 — 규칙별 수정·경계(빈 제목·코드블록·중복 방지)와 재작성 게이트 통과를 잠근다.
// 실행: 빌드 후 node dist/v6/writing-autofix.test.js
import assert from "node:assert/strict";
import { autofixWriting, autofixBlocking, AUTOFIX_RULE_IDS } from "./writing-autofix.js";
import { lintWriting } from "./writing-lint.js";
import { checkRewrite } from "./writing-rewrite-gate.js";
import { resolveWritingFormat } from "../org/policies/writing-format.js";

let pass = 0;
const t = (name: string, fn: () => void) => { fn(); pass++; console.log(`ok  ${name}`); };

const fmt = resolveWritingFormat({ enabled: true });
const fix = (title: string, body_md: string, f = fmt) => autofixWriting({ title, body_md }, f);
const rules = (title: string, body: string) => new Set(lintWriting({ title, body_md: body }, fmt).map((x) => x.rule));
/** 고쳤다고 한 규칙이 lint 에서 사라졌고, 재작성 게이트(자동 정리 판정)도 통과하는지. */
const cleanAndGated = (title: string, body: string) => {
  const r = fix(title, body);
  const after = rules(r.title, r.body_md);
  for (const x of r.fixed) assert.ok(!after.has(x), `${x} 가 남았다: ${r.title}`);
  const v = autofixBlocking(checkRewrite({ title, body_md: body }, r, fmt).violations, r.fixed);
  assert.deepEqual(v, [], JSON.stringify(v));
  return r;
};

// ── 제목 기호 ──
t("맨 앞 이모지를 지우고 뒤 공백을 정리한다", () => {
  const r = cleanAndGated("🧭 구 원장 read 표면 분류법", "분류는 호출부로 한다.");
  assert.equal(r.title, "구 원장 read 표면 분류법");
  assert.deepEqual(r.fixed, ["title_leading_emoji"]);
  assert.equal(r.body_md, "분류는 호출부로 한다.");
});

t("변이 선택자가 붙은 장식 이모지(⚙️)와 연달아 붙은 장식 이모지도 지운다", () => {
  assert.equal(cleanAndGated("⚙️ 고정길이 역직렬화 함정", "함정이다.").title, "고정길이 역직렬화 함정");
  assert.equal(cleanAndGated("🧭🔧 이중 장식 제목", "본문이다.").title, "이중 장식 제목");
  assert.equal(cleanAndGated("🧭 🔧 장식 둘 제목", "본문이다.").title, "장식 둘 제목");
});

// 뜻을 싣는 기호는 지우지 않는다 — 글로 옮기는 건 의미 판정을 거치는 LLM 재작성 몫이다(리뷰 반례: 전부 passed_dry 로 반영됐다).
t("맨 앞의 뜻 기호(⚠️·🔴·🚫)는 지우지 않고 보류한다", () => {
  for (const title of ["⚠️ 고정길이 역직렬화 함정", "🔴⚠️ 이중 경고 제목", "🔴 결제 DB 마이그레이션 롤백 불가"]) {
    const r = fix(title, "본문이다.");
    assert.equal(r.title, title);
    assert.deepEqual(r.fixed, [], title);
    assert.deepEqual(r.held, [{ rule: "title_leading_emoji", reason: "meaningful_symbol" }], title);
  }
});

t("🚫 제목은 문서째 그대로 둔다(금지 표시가 사라지면 «하지 말 것» 이 «할 것» 으로 읽힌다)", () => {
  const body = "운영 DB 는 직접 고치지 않는다.";
  assert.deepEqual(fix("🚫 운영 DB 직접 수정", body), {
    title: "🚫 운영 DB 직접 수정", body_md: body, fixed: [], held: [{ rule: "title_leading_emoji", reason: "meaningful_symbol" }],
  });
});

t("맨 앞 이모지를 지워 드러난 장식 상태 기호(📌)도 함께 지운다(안 지우면 새 위반)", () => {
  const r = cleanAndGated("🧭 배포 📌 완료 정리", "배포했다.");
  assert.equal(r.title, "배포 완료 정리");
  assert.deepEqual(r.fixed, ["title_leading_emoji", "title_status_mark"]);
});

t("맨 앞 장식 뒤에 뜻 기호(✅)가 있으면 맨 앞 장식도 두고 보류한다(장식만 지우면 ✅ 가 새 위반으로 드러난다)", () => {
  const title = "🧭 배포 ✅ 완료 정리";
  const r = fix(title, "배포했다.");
  assert.equal(r.title, title);
  assert.deepEqual(r.fixed, []);
  assert.deepEqual(r.held, [{ rule: "title_leading_emoji", reason: "meaningful_symbol" }]);
});

t("제목 중간의 장식 상태 기호(📌)를 지운다", () => {
  const r = cleanAndGated("옛 경로 잔여 — 📌 라우팅 컷오버 완료", "컷오버했다.");
  assert.equal(r.title, "옛 경로 잔여 — 라우팅 컷오버 완료");
  assert.deepEqual(r.fixed, ["title_status_mark"]);
});

t("제목의 뜻 기호(✅·끝의 ❌)는 지우지 않고 보류한다 — 장식(📌)이 함께 있어도 둔다", () => {
  for (const title of ["옛 경로 잔여 — ✅ 라우팅 컷오버 완료", "PG 18 업그레이드 리허설 ❌", "배포 📌 정리 ✅"]) {
    const r = fix(title, "본문이다.");
    assert.equal(r.title, title);
    assert.deepEqual(r.fixed, [], title);
    assert.deepEqual(r.held, [{ rule: "title_status_mark", reason: "meaningful_symbol" }], title);
  }
});

// ── 제목 날짜·MR → 본문 첫 줄 ──
t("괄호 속 날짜는 괄호째 빼고 첫 줄 끝 마침표 앞에 붙인다 — 나머지 본문은 바이트 동일", () => {
  const rest = "\n\n둘째 문단은 **그대로** 둔다 → 화살표도.\n";
  const r = cleanAndGated("배포 결과 정리 (2026-09-07, MR !4986)", `A 는 B 다.${rest}`);
  assert.equal(r.title, "배포 결과 정리");
  assert.equal(r.body_md, `A 는 B 다 (2026-09-07, MR !4986).${rest}`);
  assert.deepEqual(r.fixed, ["title_date", "title_mr_ref"]);
});

t("괄호 안 말도 함께 옮긴다(날짜만 빼면 «(규명)» 이 남는다)", () => {
  const r = cleanAndGated("파싱 실패의 정체 (2026-09-18 규명)", "꼬리 조각이 휴리스틱을 통과한다");
  assert.equal(r.title, "파싱 실패의 정체");
  assert.equal(r.body_md, "꼬리 조각이 휴리스틱을 통과한다 (2026-09-18 규명)");
});

t("괄호 밖 맨 앞 날짜·요일·시각을 뺀다 — 요일은 옮기지 않는다", () => {
  const r = cleanAndGated("[신청] 2026-09-28(월) 09:56 조회 장애 정리", "장애였다.");
  assert.equal(r.title, "[신청] 조회 장애 정리");
  assert.equal(r.body_md, "장애였다 (2026-09-28 09:56).");
});

t("범위 꼬리(~15)까지 한 조각으로 옮긴다", () => {
  const r = cleanAndGated("원장 교차검증 — 대사 산식 확정 (2026-09-14~15)", "산식을 확정했다.");
  assert.equal(r.title, "원장 교차검증 — 대사 산식 확정");
  assert.equal(r.body_md, "산식을 확정했다 (2026-09-14~15).");
});

t("구분자 사이 날짜를 빼면 겹친 구분자를 하나로, 지운 자리 뒤 마침표는 붙인다", () => {
  assert.equal(cleanAndGated("배포 — 2026-09-07 — 결과 정리", "결과다.").title, "배포 — 결과 정리");
  assert.equal(cleanAndGated("항목별 처리 (2026-09-03 검증). 다음 할 일", "처리했다.").title, "항목별 처리. 다음 할 일");
});

t("첫 줄이 헤딩이면 헤딩 뒤에 조각만 담은 줄을 넣는다", () => {
  const r = cleanAndGated("백업 실패 복구 (2026-09-03)", "## 무슨 일이 있었나\n\n백업이 실패했다.");
  assert.equal(r.body_md, "## 무슨 일이 있었나\n\n(2026-09-03)\n\n백업이 실패했다.");
  const r2 = cleanAndGated("백업 실패 복구 (2026-09-03)", "# 제목\n백업이 실패했다.");
  assert.equal(r2.body_md, "# 제목\n\n(2026-09-03)\n\n백업이 실패했다.");
});

t("첫 줄이 목록·인용·표면 그 항목에 붙이지 않고 맨 앞에 줄을 넣는다", () => {
  assert.equal(cleanAndGated("함정 모음 (2026-09-03 실측)", "- 첫 함정이다.").body_md, "(2026-09-03 실측)\n\n- 첫 함정이다.");
  assert.equal(cleanAndGated("함정 모음 (2026-09-03 실측)", "> 인용이다.").body_md, "(2026-09-03 실측)\n\n> 인용이다.");
});

t("본문이 비면 조각만 담은 줄이 본문이 된다", () => {
  assert.equal(cleanAndGated("빈 문서 정리 (2026-09-03)", "").body_md, "(2026-09-03)");
});

t("첫 줄에 이미 같은 값이 있으면 덧붙이지 않는다", () => {
  const body = "2026-09-07 배포 결과다.\n\n둘째 문단은 배포 뒤에 확인한 지표와 남은 할 일을 적는다.";
  const r = cleanAndGated("배포 결과 (2026-09-07)", body);
  assert.equal(r.title, "배포 결과");
  assert.equal(r.body_md, body);
  const mrBody = "예시 서버 !4986 에서 비영업일 가드를 넣어 공휴일 가짜 실패 알림을 없앴다.";
  const r2 = cleanAndGated("비영업일 가드 (MR !4986)", mrBody);
  assert.equal(r2.body_md, mrBody);
});

t("첫 줄에 같은 날이 한국어 표기(2026년 9월 7일)로 있으면 덧붙이지 않는다 — 다른 날·달만 같은 표기면 덧붙인다", () => {
  const body = "2026년 9월 7일 배포 결과다.\n\n둘째 문단은 배포 뒤에 확인한 지표와 남은 할 일을 적는다.";
  const r = cleanAndGated("배포 결과 (2026-09-07)", body);
  assert.equal(r.title, "배포 결과");
  assert.equal(r.body_md, body);
  assert.equal(cleanAndGated("배포 결과 (2026-09-07)", "2026년 9월 8일 배포 결과다.").body_md, "2026년 9월 8일 배포 결과다 (2026-09-07).");
  assert.equal(cleanAndGated("배포 결과 (2026-09-07)", "2026년 9월 배포 결과다.").body_md, "2026년 9월 배포 결과다 (2026-09-07).");
});

t("값이 겹쳐 보여도 숫자 경계가 다르면(2026-06 ↔ 2026-06-01) 덧붙인다", () => {
  const r = cleanAndGated("파트너사 연동 정리 (2026-06)", "2026-06-01 부터 연동했다.");
  assert.equal(r.body_md, "2026-06-01 부터 연동했다 (2026-06).");
});

t("인라인 코드 속 값은 첫 줄에 있다고 보지 않는다", () => {
  const r = cleanAndGated("MR !6134 리뷰 — 예외 경로 수정", "예시 서버 MR `!6134` 리뷰다.");
  assert.equal(r.title, "리뷰 — 예외 경로 수정");
  assert.equal(r.body_md, "예시 서버 MR `!6134` 리뷰다 (MR !6134).");
});

t("제목의 인라인 코드 괄호는 빈 괄호로 지우지 않는다", () => {
  const r = cleanAndGated("Exposed `text()` 선언 불일치 (2026-09-22 실측)", "선언과 DDL 이 다르다.");
  assert.equal(r.title, "Exposed `text()` 선언 불일치");
});

// ── 고치지 않는 자리 ──
t("빼고 나서 제목이 비거나 3글자 미만이면 문서 전체를 원문 그대로 둔다", () => {
  for (const title of ["🔴 (2026-09-07)", "AB (2026-09-07)", "🔴 2026-09-07"]) {
    const body = "## 🔴 헤딩\n\n본문.";
    const r = fix(title, body);
    assert.deepEqual(r.fixed, [], title);
    assert.equal(r.title, title);
    assert.equal(r.body_md, body);
    assert.ok(r.held.some((h) => h.reason === "title_too_short"), title);
  }
});

t("조사·설명 괄호가 붙은 자리는 날짜·MR 을 빼지 않는다(문장이 깨진다)", () => {
  for (const title of ["연동 첫 달(2025-05)부터 백필한다", "근본수정 — MR !6445(유니크 키) 정리", "기준일 2026-09-07 에 바뀐 규칙"]) {
    const r = fix(title, "본문이다.");
    assert.equal(r.title, title);
    assert.deepEqual(r.fixed, []);
    assert.ok(r.held.length > 0, title);
  }
});

// 리뷰 반례 — 제목 끝(또는 구분자 옆)의 값을 빼면 뒤에 띄어 쓴 조사·관계어가 고아로 남고, 첫 줄엔 값만 옮겨져 «이후» 같은 관계가 사라진다.
const ORPHAN_CASES: Array<[string, "title_date" | "title_mr_ref"]> = [
  ["2026-09 이후 정책", "title_date"],
  ["2026-09-07 이전 데이터 정리", "title_date"],
  ["2026-12-31 까지 유효한 토큰 정책", "title_date"],
  ["!123 에서 도입한 가드", "title_mr_ref"],
  ["환불 규칙 변경 — 2026-09-07 부터", "title_date"],
  ["[2026-09-07] 이후 변경 사항", "title_date"],
  // 관계어 뒤에 조사가 더 붙은 꼴도 같다.
  ["2026-09-07 이후에 바뀐 규칙", "title_date"],
  ["(2026-09) 부터는 새 요금", "title_date"],
  ["2026-09-07 전에 끝낼 일", "title_date"],
];
for (const [title, rule] of ORPHAN_CASES) {
  t(`값 뒤에 띄어 쓴 조사·관계어가 오면 빼지 않는다 — ${title}`, () => {
    const r = fix(title, "본문이다.");
    assert.equal(r.title, title);
    assert.equal(r.body_md, "본문이다.");
    assert.deepEqual(r.fixed, []);
    assert.deepEqual(r.held, [{ rule, reason: "unsafe_fragment" }]);
  });
}

t("괄호 조각 뒤가 조사 아닌 낱말이면 그대로 고친다([2026-09-07] 배포 회고 → 배포 회고)", () => {
  const r = cleanAndGated("[2026-09-07] 배포 회고", "회고다.");
  assert.equal(r.title, "배포 회고");
  assert.equal(r.body_md, "회고다 (2026-09-07).");
  assert.deepEqual(r.fixed, ["title_date"]);
});

t("날짜를 못 빼도 같은 제목의 다른 대상 규칙은 고친다 — 남은 날짜는 막지 않는다(원문부터 있던 위반)", () => {
  const title = "🧭 연동 첫 달(2025-05)부터 백필한다";
  const r = fix(title, "본문이다.");
  assert.equal(r.title, "연동 첫 달(2025-05)부터 백필한다");
  assert.deepEqual(r.fixed, ["title_leading_emoji"]);
  assert.deepEqual(r.held, [{ rule: "title_date", reason: "unsafe_fragment" }]);
  assert.deepEqual(autofixBlocking(checkRewrite({ title, body_md: "본문이다." }, r, fmt).violations, r.fixed), []);
});

t("규칙이 꺼져 있으면 고치지 않는다", () => {
  const off = resolveWritingFormat({ enabled: true, rules: { title_date: "off" } });
  const r = fix("배포 결과 (2026-09-07)", "결과다.", off);
  assert.deepEqual(r.fixed, []);
  assert.equal(r.title, "배포 결과 (2026-09-07)");
});

t("대상 규칙이 없으면 원문 그대로다", () => {
  const r = fix("깨끗한 제목", "**볼드** 가 많고 → 화살표 → 연쇄 → 도 있다.");
  assert.deepEqual(r, { title: "깨끗한 제목", body_md: "**볼드** 가 많고 → 화살표 → 연쇄 → 도 있다.", fixed: [], held: [] });
});

// ── 헤딩 기호 ──
t("헤딩 줄의 장식 기호만 지우고 코드블록 안의 # 줄은 건드리지 않는다", () => {
  const body = [
    "결론이다.", "", "## 🧭 둘러볼 곳", "본문 🧭 은 그대로.", "", "```", "## 🧭 코드 속 헤딩", "```", "", "~~~", "# 🔧 물결 펜스", "~~~", "", "### 🔧 끝 정리 🎉",
  ].join("\n");
  const r = cleanAndGated("깨끗한 제목", body);
  assert.deepEqual(r.fixed, ["heading_symbol"]);
  assert.equal(r.body_md, body.replace("## 🧭 둘러볼 곳", "## 둘러볼 곳").replace("### 🔧 끝 정리 🎉", "### 끝 정리"));
});

t("뜻 기호(🔴·✅)가 든 헤딩은 지우지 않고 보류한다", () => {
  const body = [
    "결론이다.", "", "## 🔴 위험한 곳", "본문 🔴 은 그대로.", "", "```", "## 🔴 코드 속 헤딩", "```", "", "~~~", "# ✅ 물결 펜스", "~~~", "", "### ✅ 끝 정리 🎉",
  ].join("\n");
  const r = fix("깨끗한 제목", body);
  assert.equal(r.body_md, body);
  assert.deepEqual(r.fixed, []);
  assert.deepEqual(r.held, [{ rule: "heading_symbol", reason: "meaningful_symbol" }]);
});

t("✅/❌ 헤딩 쌍과 ⛔ 헤딩은 그대로 둔다(지우면 해도 되는 것과 하지 말 것의 구분이 사라진다)", () => {
  const body = [
    "운영 DB 는 복제본으로만 조회한다.", "", "## ✅ 읽기 전용 복제본 조회", "", "복제본에서 조회한다.", "",
    "## ❌ 운영 DB 직접 수정", "", "운영 DB 는 직접 고치지 않는다.", "", "## ⛔ 금요일 오후 배포", "", "금요일 오후엔 배포하지 않는다.",
  ].join("\n");
  const r = fix("운영 DB 접근 규칙", body);
  assert.equal(r.body_md, body);
  assert.deepEqual(r.fixed, []);
  assert.deepEqual(r.held, [{ rule: "heading_symbol", reason: "meaningful_symbol" }]);
});

t("장식 헤딩만 지우고 뜻 기호 헤딩은 남긴다 — 남겼으니 heading_symbol 은 고쳤다고 하지 않는다", () => {
  const r = cleanAndGated("🧭 운영 규칙", "결론이다.\n\n## ✅ 해도 되는 것\n\n## 🎉 마무리");
  assert.equal(r.title, "운영 규칙");
  assert.equal(r.body_md, "결론이다.\n\n## ✅ 해도 되는 것\n\n## 마무리");
  assert.deepEqual(r.fixed, ["title_leading_emoji"]);
  assert.deepEqual(r.held, [{ rule: "heading_symbol", reason: "meaningful_symbol" }]);
});

t("헤딩의 인라인 코드 속 기호는 둔다 — 코드 속 뜻 기호는 보류 사유가 아니다", () => {
  const r = cleanAndGated("깨끗한 제목", "결론이다.\n\n## `🔴` 표기 규칙 🎉");
  assert.equal(r.body_md, "결론이다.\n\n## `🔴` 표기 규칙");
});

t("관계를 말하는 화살표(8081↔8082)가 든 헤딩은 고치지 않고 보류한다", () => {
  const body = "결론이다.\n\n## flip 8081↔8082 전환";
  const r = fix("깨끗한 제목", body);
  assert.equal(r.body_md, body);
  assert.deepEqual(r.fixed, []);
  assert.deepEqual(r.held, [{ rule: "heading_symbol", reason: "residual" }]);
});

t("일부 헤딩만 고쳐져 규칙이 남으면 고쳤다고 하지 않는다(held)", () => {
  const body = "결론이다.\n\n## 🎉 끝\n\n## flip 8081↔8082 전환";
  const r = fix("🧭 장식 제목", body);
  assert.deepEqual(r.fixed, ["title_leading_emoji"]);
  assert.deepEqual(r.held, [{ rule: "heading_symbol", reason: "residual" }]);
  assert.ok(rules(r.title, r.body_md).has("heading_symbol"));
});

// ── 게이트 판정 ──
t("autofixBlocking — 고쳤다고 한 규칙이 남으면 막고, 다른 규칙의 남은 위반은 막지 않는다", () => {
  const vs = [
    { kind: "lint:title_date", detail: "" }, { kind: "lint:lead_missing", detail: "" },
    { kind: "new:arrow_chain", detail: "" }, { kind: "invariant:numbers", detail: "" },
  ];
  assert.deepEqual(autofixBlocking(vs, ["title_date"]).map((v) => v.kind), ["lint:title_date", "new:arrow_chain", "invariant:numbers"]);
  assert.deepEqual(autofixBlocking(vs, ["heading_symbol"]).map((v) => v.kind), ["new:arrow_chain", "invariant:numbers"]);
});

t("본문으로 옮긴 조각이 새 위반을 만들면 게이트가 막는다(정정 배너)", () => {
  const before = { title: "키 재검토 (2026-09-08, 정정됨)", body_md: "동일인을 식별했다." };
  const r = fix(before.title, before.body_md);
  assert.deepEqual(r.fixed, ["title_date"]);
  const kinds = autofixBlocking(checkRewrite(before, r, fmt).violations, r.fixed).map((v) => v.kind);
  assert.ok(kinds.includes("new:revision_banner"), kinds.join(","));
});

t("다섯 규칙 목록", () => {
  assert.deepEqual([...AUTOFIX_RULE_IDS].sort(), ["heading_symbol", "title_date", "title_leading_emoji", "title_mr_ref", "title_status_mark"]);
});

console.log(`\n${pass} passed`);
