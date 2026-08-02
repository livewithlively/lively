// schema-hint 단위 체크(#1259) — '없는 테이블·컬럼'을 권한 문제로 오진하지 않게 하는 안내 회귀.
// 실행: npm run build && node dist/db/schema-hint.test.js
//  A 표의 기대값은 고객사 A 실박스 감사로그(example-ro 실패 177건)에서 실제로 막힌 이름들이고,
//  각 행의 정답은 그때 사람이 손으로 찾아내야 했던 실제 테이블 이름이다.
import assert from "node:assert/strict";
import {
  suggestSimilarNames,
  formatUnknownTable,
  extractUnknownColumn,
  annotateUnknownColumn,
  filterTableNames,
  SIMILAR_NAME_CAVEAT,
} from "./schema-hint.js";

let pass = 0;
const ok = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

// 실 DB(example) 이름 중 '거의 이겼던 경합 후보'를 포함한 대표 집합 — 정답만 있으면 시험이 안 된다.
const NAMES = [
  "d_seq", "d_seq_date_archive", "d_deal_nice_outbox", "d_realization", "d_realization_view",
  "d_charge", "d_charge_view", "d_transaction_additional_charge", "d_transaction", "d_transaction_sale",
  "d_legal_interest_limit_excess", "d_legal_interest_excess_handle_record", "d_legal_max_rate",
  "d_additional_repayment_request", "d_additional_repayment_detail", "b_additional_repayment_request",
  "d_charged_accruing_borrower_fee", "d_charged_borrower_fee", "charged_d_borrower_fee",
  "d_realized_accruing_borrower_fee", "d_received_borrower_fee", "d_voucher", "d_voucher_cash_swap",
  "l_credit_apply", "l_credit_apply_whitelist", "l_recruit_apply", "l_mortgage_apply", "x_loan_agent_apply",
  "l_limit_calculation", "l_limit_pre_calculation", "p_deal", "p_deal_review", "p_deal_cis", "p_deal_nice",
  "tb_lo_bond", "b_bond_event", "tb_cr_nice_0210110_63", "tb_cr_nice_0210110", "b_repayment_deposit",
  "i_repayment_disburse", "u_borrower_detail", "tb_pr_product", "f_product", "p_toss_product",
  "g_seq", "g_charge", "d_nice_overdue",
  // 임계값이 걸러내야 하는 무관한 이름(실 DB 존재 — 임계값을 낮추면 후보로 유입된다)
  "d_acceleration", "d_accessorial_fee", "d_charged_accessorial_fee",
];

// ── A. 실측 실패 이름 → 정답이 1순위 (표 1~14행) ──
const TOP1: Array<[string, string]> = [
  ["d_deal_seq", "d_seq"],
  ["d_deal_realization", "d_realization"],
  ["d_deal_charge", "d_charge"],
  ["d_legal_interest_limit", "d_legal_interest_limit_excess"],
  ["d_deal_additional_repayment_request", "d_additional_repayment_request"],
  ["d_deal_transaction", "d_transaction"],
  ["d_deal_charged_accruing_borrower_fee", "d_charged_accruing_borrower_fee"],
  ["d_deal_voucher", "d_voucher"],
  ["loan_credit_apply", "l_credit_apply"],
  ["loan_limit_calculation", "l_limit_calculation"],
  ["credit_apply", "l_credit_apply"],
  ["deal", "p_deal"],
  ["nice_0210110_63", "tb_cr_nice_0210110_63"],
  ["i_repayment_deposit", "b_repayment_deposit"],
];
for (const [wrong, right] of TOP1) {
  ok(`1순위: ${wrong} → ${right}`, () => {
    const got = suggestSimilarNames(wrong, NAMES);
    assert.equal(got[0], right, `1순위 기대 ${right}, 실제 [${got.join(", ")}]`);
  });
}

// ── A2. 단어 내부 오타 — 토큰 신호로는 교집합이 0 이라 전혀 안 잡히는 별개 유형 ──
//  프리뷰 실환경에서 knowledgee→knowledge 가 후보 0건으로 나와 발견됐다(#1259). 편집거리 신호가 담당.
const TYPO: Array<[string, string]> = [
  ["d_seqq", "d_seq"],                 // 글자 중복
  ["d_chargee", "d_charge"],
  ["d_realizaton", "d_realization"],   // 글자 누락
  ["p_dealx", "p_deal"],               // 글자 추가
  ["d_chargeex", "d_charge"],          // 경계: 편집거리 정확히 2 (허용 상한)
];
for (const [wrong, right] of TYPO) {
  ok(`1순위(내부 오타): ${wrong} → ${right}`, () => {
    const got = suggestSimilarNames(wrong, NAMES);
    assert.equal(got[0], right, `1순위 기대 ${right}, 실제 [${got.join(", ")}]`);
  });
}
// 경계 반대쪽 — 편집거리 3 은 오타로 보지 않는다(그 이상 벌어지면 무관한 이름을 끌어온다).
//  다른 신호로도 임계를 넘지 못하므로 후보가 없다 = 이 안내의 한계로 문서화된 지점.
ok("경계: 편집거리 3(d_chargeexy)은 후보로 내지 않는다", () =>
  assert.deepEqual(suggestSimilarNames("d_chargeexy", NAMES), []));

// ── B. 1순위는 아니어도 후보엔 들어야 한다 (15~16행) ──
ok("15 한 글자 오타는 후보 포함: d_deal → p_deal", () =>
  assert.ok(suggestSimilarNames("d_deal", NAMES).includes("p_deal")));
ok("16 접두 완전 상이도 후보 포함: p_bond → tb_lo_bond", () =>
  assert.ok(suggestSimilarNames("p_bond", NAMES).includes("tb_lo_bond")));

// ── C. 경계 · 새 파라미터의 부재/영값 (17~25행) ──
// 임계값 자체를 여기서 검증한다 — 임계값이 0 이면 공통 토큰 0점짜리 이름들이 그대로 후보로 쏟아진다.
ok("17 무관한 이름은 후보 없음(임계값이 무관한 나열을 막는다)", () =>
  assert.deepEqual(suggestSimilarNames("zzz_nothing_alike", NAMES), []));
ok("17b 후보는 관련된 것만 — 무관한 이름이 자리를 채우지 않는다", () => {
  // p_bond 는 관련 후보가 2개뿐이다. 임계값이 풀리면 무관한 이름이 limit 까지 채워진다.
  const got = suggestSimilarNames("p_bond", NAMES);
  assert.ok(got.every((n) => n.includes("bond")), `bond 무관 이름 유입: [${got.join(", ")}]`);
});
ok("18 대소문자 무시", () => assert.equal(suggestSimilarNames("D_DEAL_SEQ", NAMES)[0], "d_seq"));
ok("19 limit 준수", () => assert.equal(suggestSimilarNames("d_deal_seq", NAMES, 3).length, 3));
ok("20 자기 자신 제외", () => assert.ok(!suggestSimilarNames("d_seq", NAMES).includes("d_seq")));
ok("21 candidates 빈 배열", () => assert.deepEqual(suggestSimilarNames("d_deal_seq", []), []));
ok("22 토큰 없는 query 는 빈 배열(크래시 없음)", () =>
  assert.deepEqual(suggestSimilarNames("___", NAMES), []));
ok("23 limit=0 은 빈 배열", () => assert.deepEqual(suggestSimilarNames("d_deal_seq", NAMES, 0), []));
ok("24 결정론(같은 입력 → 같은 순서)", () =>
  assert.deepEqual(suggestSimilarNames("d_deal_charge", NAMES), suggestSimilarNames("d_deal_charge", NAMES)));
ok("25 부분문자열 신호 경계 — 공통 토큰 3자는 미달, 4자는 통과", () => {
  // 토큰 신호만으론 둘 다 임계 미달(jaccard 0.25) — 차이는 부분문자열 가점(토큰 길이 >= 4)뿐이다.
  assert.deepEqual(suggestSimilarNames("x_abc", ["zzz_abc_thing"]), [], "3자 토큰은 가점 없음");
  assert.deepEqual(suggestSimilarNames("x_abcd", ["zzz_abcd_thing"]), ["zzz_abcd_thing"], "4자 토큰은 가점");
});

// ── C2. db_schema 이름 필터(#1259) — 1000개대 목록에서 이름을 찾게 하는 핵심 경로 ──
ok("F1 빈 패턴은 필터하지 않는다(후방호환 — 전체 목록)", () => {
  assert.deepEqual(filterTableNames(NAMES, undefined), NAMES);
  assert.deepEqual(filterTableNames(NAMES, ""), NAMES);
  assert.deepEqual(filterTableNames(NAMES, "   "), NAMES);
});
ok("F2 부분일치(대소문자 무시)", () => {
  assert.deepEqual(filterTableNames(NAMES, "ACCRUING"),
    ["d_charged_accruing_borrower_fee", "d_realized_accruing_borrower_fee"]);
});
ok("F3 공백 다중토큰은 AND(순서 무관)", () => {
  assert.deepEqual(filterTableNames(NAMES, "repayment request"), filterTableNames(NAMES, "request repayment"));
  assert.deepEqual(filterTableNames(NAMES, "repayment request"),
    ["d_additional_repayment_request", "b_additional_repayment_request"]);
});
ok("F4 매치 없으면 빈 배열(전체로 폴백하지 않는다)", () =>
  assert.deepEqual(filterTableNames(NAMES, "zzz"), []));
ok("F5 원본 배열을 변형하지 않는다", () => {
  const before = [...NAMES];
  filterTableNames(NAMES, "seq");
  assert.deepEqual(NAMES, before);
});

// ── D. 문구 (26~27행) ──
ok("26 없는 테이블 문구: 권한 문제 아님 명시 + 맹신경고 + '허용 설정 필요' 부재", () => {
  const msg = formatUnknownTable("example-ro", "d_deal_seq", ["d_seq"]);
  assert.match(msg, /Unknown table: d_deal_seq/);
  assert.match(msg, /권한 문제가 아닙니다/);
  assert.match(msg, /d_seq/);
  assert.ok(msg.includes(SIMILAR_NAME_CAVEAT), "유사후보 맹신 경고가 있어야 한다");
  assert.match(msg, /db_schema/);
  assert.doesNotMatch(msg, /허용 설정 필요/); // 권한 확대 요청으로 오도한 그 문구
});
ok("27 후보 없으면 맹신경고도 없다(경고할 대상이 없다)", () => {
  const msg = formatUnknownTable("example-ro", "zzz", []);
  assert.match(msg, /db_schema/);
  assert.ok(!msg.includes(SIMILAR_NAME_CAVEAT));
});

// ── E. 컬럼명 추출 (28~32행) ──
ok("28 mysql Unknown column", () =>
  assert.equal(extractUnknownColumn("Unknown column 'deal_uid' in 'where clause'"), "deal_uid"));
ok("29 pg 인용형", () => assert.equal(extractUnknownColumn('column "title" does not exist'), "title"));
ok("30 pg 수식형은 마지막 조각", () =>
  assert.equal(extractUnknownColumn("column p.title does not exist"), "title"));
ok("31 감사 정규화형('?')은 컬럼명이 아니다", () =>
  assert.equal(extractUnknownColumn("Unknown column '?' in '?'"), null));
ok("32 무관한 에러는 null", () =>
  assert.equal(extractUnknownColumn("Query execution was interrupted"), null));

// ── F. 컬럼 안내 (33~38행) ──
const cols = (n: number, prefix = "col"): string[] => Array.from({ length: n }, (_, i) => `${prefix}_${i}`);

ok("33 컬럼이 적으면 전부 나열(실측: 마이크가 막힌 테이블은 컬럼 2개)", () => {
  const msg = annotateUnknownColumn("Unknown column 'deal_uid' in 'where clause'", "deal_uid",
    new Map([["d_realized_accruing_borrower_fee", ["deal_realization_uid", "amount"]]]));
  assert.match(msg, /deal_realization_uid/);
  assert.match(msg, /amount/);
});
ok("34 그 컬럼을 가진 테이블은 원인에서 제외", () => {
  const msg = annotateUnknownColumn("Unknown column 'deal_uid' in 'where clause'", "deal_uid",
    new Map([["p_deal", ["deal_uid", "amount"]], ["d_realized_accruing_borrower_fee", ["deal_realization_uid"]]]));
  assert.doesNotMatch(msg, /p_deal:/);
  assert.match(msg, /d_realized_accruing_borrower_fee:/);
});
ok("35 경계: 컬럼 정확히 12개면 전부 나열(전체개수 안내 없음)", () => {
  const msg = annotateUnknownColumn("Unknown column 'zz' in 'where clause'", "zz",
    new Map([["t12", cols(12)]]));
  for (const c of cols(12)) assert.match(msg, new RegExp(c));
  assert.doesNotMatch(msg, /전체 12개/);
});
ok("36 경계: 컬럼 13개면 좁히고 전체개수·확인경로 안내", () => {
  const msg = annotateUnknownColumn("Unknown column 'deal_uid' in 'where clause'", "deal_uid",
    new Map([["t13", [...cols(12), "deal_uid_x"]]]));
  assert.match(msg, /deal_uid_x/);
  assert.match(msg, /전체 13개/);
  assert.match(msg, /db_schema/);
});
ok("37 참조 테이블 정보가 없으면 원문 그대로(보강 실패가 원인을 삼키지 않는다)", () => {
  const orig = "Unknown column 'deal_uid' in 'where clause'";
  assert.equal(annotateUnknownColumn(orig, "deal_uid", new Map()), orig);
});
ok("38 컬럼 목록이 빈 테이블만 건너뛴다", () => {
  const msg = annotateUnknownColumn("Unknown column 'deal_uid' in 'where clause'", "deal_uid",
    new Map([["empty_t", []], ["real_t", ["deal_realization_uid"]]]));
  assert.doesNotMatch(msg, /empty_t/);
  assert.match(msg, /real_t: deal_realization_uid/);
});

console.log(`\n${pass} checks passed`);
