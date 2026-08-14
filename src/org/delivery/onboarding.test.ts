// 온보딩 셋업 판정 — 사양 엣지 표(18행) 잠금. (#1618 후속)
//
//  왜 생겼나: 이 자리에서 **거짓 완료**가 실제로 나갔다. 신규 워크스페이스는 제품이 심은 런북 3건으로
//   시작하는데 '지식' 항목이 그걸 조직 지식으로 세어, 회사가 한 건도 안 쓴 상태에서 통과했다.
//   바로 위 '정체성' 항목은 같은 함정(자동 시드를 완료로 오인)을 이미 막고 있었으니, 빠진 건 아이디어가
//   아니라 **그 규칙을 강제하는 장치**였다. 그래서 판정을 순수 함수로 떼고 표로 잠근다.
//
//  ⚠ 이 표가 덮지 못하는 것(사양에 명시): 2행의 *원인*인 "심어진 문서를 세지 않는다"는 SQL 에 있고,
//   판정 함수는 이미 걸러진 수를 받는다. 여기서 잠기는 것은 **정책**("조직이 쓴 게 0이면 미완")이지
//   **집계 규칙**이 아니다. 집계까지는 DB 통합 테스트가 필요하다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { onboardingItems, summarizeOnboarding, type OnboardingFacts } from "./onboarding.js";

/** 전부 채워진 조직 — 각 케이스는 여기서 한 축만 무너뜨려 그 축이 판정을 바꾸는지 본다. */
const OK: OnboardingFacts = {
  identityEdited: true,
  knowledgeAuthored: 12,
  categories: 8,
  categoriesNoDefinition: 0,
  membersActive: 4,
  membersWithToken: 3,
  dbSources: 1,
  embeddingsOn: true,
  pipelineStuck: [],
  pipelineApplicable: true,
};
function item(f: OnboardingFacts, key: string) {
  const items = onboardingItems(f);
  const it = items.find((i) => i.key === key);
  // [배선] 항목 자체가 사라지면 아래 단언은 통과하면서 아무것도 안 본다.
  assert.ok(it, `항목 '${key}' 가 결과에 없다 — 표가 검사할 대상을 잃었다`);
  return it!;
}

// 1행
test("표1: 모두 충족한 조직은 100% 완료", () => {
  const s = summarizeOnboarding(onboardingItems(OK));
  assert.equal(s.complete, true);
  assert.equal(s.pct, 100);
});

// 2행 — 회귀 잠금
test("표2: 조직이 쓴 지식이 0이면 미완 (심어진 문서만 있는 신규 워크스페이스)", () => {
  const it = item({ ...OK, knowledgeAuthored: 0 }, "knowledge");
  assert.equal(it.done, false);
  assert.equal(it.count, 0);
});

// 3행 — 경계
test("표3: 조직이 쓴 지식 1건(경계)이면 완료", () => {
  assert.equal(item({ ...OK, knowledgeAuthored: 1 }, "knowledge").done, true);
});

// 4행
test("표4: 분류축이 0개면 미완", () => {
  assert.equal(item({ ...OK, categories: 0, categoriesNoDefinition: 0 }, "categories").done, false);
});

// 5행
test("표5: 축은 있어도 정의가 빈 축이 있으면 미완 — 분류할 기준이 없다", () => {
  const it = item({ ...OK, categories: 8, categoriesNoDefinition: 2 }, "categories");
  assert.equal(it.done, false);
  assert.match(it.how, /2개/, "몇 개가 비었는지 사람에게 말해야 한다");
});

// 6행
test("표6: 축 + 정의가 모두 채워지면 완료", () => {
  assert.equal(item({ ...OK, categories: 3, categoriesNoDefinition: 0 }, "categories").done, true);
});

// 7행
test("표7: 멈춘 단계가 있으면 미완·필수이고 어느 단계인지 이름이 나온다", () => {
  const it = item({ ...OK, pipelineStuck: ["증류", "관리"], pipelineApplicable: true }, "pipeline");
  assert.equal(it.done, false);
  assert.notEqual(it.optional, true, "물을 이유가 있으면 선택이 아니다");
  assert.match(it.how, /증류/);
  assert.match(it.how, /관리/);
});

// 8행
test("표8: 물을 이유가 없으면(자료도 지식도 없음) 파이프라인은 선택", () => {
  assert.equal(item({ ...OK, pipelineApplicable: false, pipelineStuck: [] }, "pipeline").optional, true);
});

// 9행
test("표9: 파이프라인이 선택이면 진행률을 막지 않는다 — 안 쓰는 조직도 100%가 될 수 있다", () => {
  const s = summarizeOnboarding(onboardingItems({ ...OK, pipelineApplicable: false, pipelineStuck: [] }));
  assert.equal(s.complete, true);
});

// 10행
test("표10: 멈춘 단계가 있으면 전체 완료가 깨진다", () => {
  const s = summarizeOnboarding(onboardingItems({ ...OK, pipelineStuck: ["증류"], pipelineApplicable: true }));
  assert.equal(s.complete, false);
});

// 11행
test("표11: 제품DB·의미검색이 없어도 100%가 된다(둘 다 선택)", () => {
  const f: OnboardingFacts = { ...OK, dbSources: 0, embeddingsOn: false };
  assert.equal(summarizeOnboarding(onboardingItems(f)).complete, true);
  assert.equal(item(f, "dbsource").optional, true);
  assert.equal(item(f, "embeddings").optional, true);
});

// 12행
test("표12: 의미검색이 꺼져 있으면 '단어 일치로만 찾는다'는 사실을 문구로 말한다", () => {
  const it = item({ ...OK, embeddingsOn: false }, "embeddings");
  assert.equal(it.done, false);
  assert.match(it.how, /단어/, "조용한 폴백을 사람이 알 수 있어야 한다");
});

// 13·14행 — 경계
test("표13·14: 구성원 1명이면 미완, 2명이면 완료", () => {
  assert.equal(item({ ...OK, membersActive: 1 }, "members").done, false);
  assert.equal(item({ ...OK, membersActive: 2 }, "members").done, true);
});

// 15행
test("표15: 토큰 보유 수를 문구에 드러내되 게이트로 쓰지 않는다", () => {
  const f: OnboardingFacts = { ...OK, membersActive: 41, membersWithToken: 6 };
  const it = item(f, "members");
  assert.equal(it.done, true, "토큰이 적어도 인원 조건을 만족하면 완료다");
  assert.match(it.how, /41/);
  assert.match(it.how, /6/);
});

// 16행
test("표16: 회사 정체성을 안 채우면 미완", () => {
  assert.equal(item({ ...OK, identityEdited: false }, "identity").done, false);
});

// 17행
const FRESH: OnboardingFacts = {
  identityEdited: false, knowledgeAuthored: 0, categories: 0, categoriesNoDefinition: 0,
  membersActive: 1, membersWithToken: 1, dbSources: 0, embeddingsOn: false,
  pipelineStuck: [], pipelineApplicable: false,
};
test("표17: 갓 만든 워크스페이스는 0%이고 선택 항목이 그 숫자를 부풀리지 않는다", () => {
  const s = summarizeOnboarding(onboardingItems(FRESH));
  assert.equal(s.done, 0);
  assert.equal(s.pct, 0);
  assert.equal(s.complete, false);
  // 필수 = 정체성·분류축·지식·구성원 4개(파이프라인은 물을 이유가 없어 선택으로 빠진다).
  assert.equal(s.total, 4, "선택 항목이 필수 개수에 섞이면 안 된다");
});

// 18행 — 이번 변경이 새로 만든 엣지: 파이프라인이라는 입력을 도입하면서 '그 입력을 못 구한 경우'가 생겼다.
test("표18: 파이프라인 현황을 못 읽었으면 선택으로 두고 '멈췄다'고 단정하지 않는다", () => {
  const it = item({ ...OK, pipelineStuck: [], pipelineApplicable: false }, "pipeline");
  assert.equal(it.optional, true, "못 본 것을 미완으로 몰면 거짓 경고가 된다");
  assert.equal(it.done, true, "멈춘 단계가 없다고 보고돼야 한다(모름 ≠ 고장)");
  assert.doesNotMatch(it.how, /멈춘 단계/, "멈췄다고 쓰면 안 된다");
});
